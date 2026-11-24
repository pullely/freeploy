// Derived from coollabsio/coolify@91b7e3e:resources/views/components/top-breadcrumb.blade.php
// (the project and environment switchers) (Apache-2.0), modified.
//
// What every project and environment page shares: the uuids in the path, the
// API's shapes, and the project (and environment) in the top bar with their
// switchers. Coolify shows the switchers in place of the "Projects" link; the
// generated layout keeps that link, so they follow it.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getJson } from "../lib/api";

/** GET /projects: Index's projectsJs. */
export interface ProjectListItem {
  uuid: string;
  name: string;
  description: string | null;
  environmentCount: number;
  resourceCount: number;
  createdAt: string;
  onlyEnvironmentUuid: string | null;
  firstEnvironmentUuid: string | null;
}

/** An environment as Show's environmentsJs lists it. */
export interface EnvironmentItem {
  uuid: string;
  name: string;
  description: string | null;
  resourceCount: number;
}

/** GET /projects/{uuid}. */
export interface ProjectShowData {
  project: { uuid: string; name: string; description: string | null; isEmpty: boolean };
  environments: EnvironmentItem[];
  canUpdate: boolean;
  canDelete: boolean;
}

/** GET /projects/{uuid}/environments/{env_uuid}. */
export interface EnvironmentShowData {
  project: { uuid: string; name: string };
  environment: EnvironmentItem & { isEmpty: boolean };
  canUpdate: boolean;
  canDelete: boolean;
}

/** data_get_str(…)->limit($n) in the page titles: the first n characters and "...". */
export function limit(value: string, n: number): string {
  const chars = [...value];
  return chars.length <= n ? value : `${chars.slice(0, n).join("").trimEnd()}...`;
}

/** The project's uuid from /project/{uuid}/…. */
export function projectUuidFromPath(pathname = window.location.pathname): string {
  return decodeURIComponent(pathname.split("/")[2] ?? "");
}

/** The environment's uuid from /project/{uuid}/environment/{env_uuid}/…. */
export function environmentUuidFromPath(pathname = window.location.pathname): string {
  return decodeURIComponent(pathname.split("/")[4] ?? "");
}

export const projectsApi = (orgId: string | undefined) => `/v1/organizations/${orgId ?? ""}/deploy/projects`;
export const projectPath = (projectUuid: string) => `/project/${projectUuid}`;
export const environmentPath = (projectUuid: string, environmentUuid: string) => `/project/${projectUuid}/environment/${environmentUuid}`;

const SWITCHER = "flex h-8 min-w-0 items-center rounded-md opacity-70 transition-[background-color,opacity] hover:bg-neutral-100 hover:opacity-100 dark:hover:bg-white/[0.05]";
const CURRENT = "bg-neutral-100 font-medium text-black dark:bg-white/[0.07] dark:text-fg";

function Chevrons() {
  return (
    <svg className="size-4 shrink-0 text-neutral-400 dark:text-fg-faint" viewBox="0 0 24 24" fill="none">
      <path d="M8 9l4-4 4 4M8 15l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** One switcher: the current item as a link, and a button that opens the list of the others (Alpine's `open`, closed by a click outside or Escape). */
function Switcher(props: { href: string; label: string; linkTitle: string; buttonTitle: string; heading: string; panelClass: string; items: Array<{ uuid: string; name: string; href: string }>; current: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <>
      <span className="shrink-0 text-neutral-300 dark:text-fg-faint px-0.5">/</span>
      <div className="relative min-w-0 shrink" ref={root}>
        <div className={SWITCHER}>
          <a href={props.href} title={props.linkTitle} className="flex h-8 min-w-0 items-center pr-1 pl-2">
            <span className="min-w-0 truncate font-semibold text-black dark:text-fg">{props.label}</span>
          </a>
          <button type="button" onClick={() => setOpen(!open)} title={props.buttonTitle} className="flex h-8 shrink-0 items-center px-0.5">
            <Chevrons />
          </button>
        </div>
        <div className={`listbox-panel scrollbar left-0! z-[90]! max-h-80! ${props.panelClass} max-w-72`} {...(open ? {} : { style: { display: "none" as const } })}>
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-fg-faint">{props.heading}</div>
          {props.items.map((item) => (
            <a key={item.uuid} href={item.href} onClick={() => setOpen(false)} className={`listbox-option ${item.uuid === props.current ? CURRENT : ""}`.trimEnd()}>
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
            </a>
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * The project switcher and, on an environment's pages, the environment
 * switcher, in the top bar. The lists are the org's projects and the
 * project's environments.
 */
export function ProjectBreadcrumb({ orgId, project, environment }: { orgId: string | undefined; project: { uuid: string; name: string }; environment?: { uuid: string; name: string } }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [projects, setProjects] = useState<Array<{ uuid: string; name: string }>>([]);
  const [environments, setEnvironments] = useState<Array<{ uuid: string; name: string }>>([]);
  const withEnvironments = environment !== undefined;
  useEffect(() => setSlot(document.getElementById("server-topbar-context")), []);
  useEffect(() => {
    if (!orgId) return;
    void getJson<{ projects: ProjectListItem[] }>(projectsApi(orgId)).then((r) => setProjects(r.data?.projects ?? []));
  }, [orgId]);
  useEffect(() => {
    if (!orgId || !withEnvironments) return;
    void getJson<{ environments: EnvironmentItem[] }>(`${projectsApi(orgId)}/${encodeURIComponent(project.uuid)}/environments`).then((r) => setEnvironments(r.data?.environments ?? []));
  }, [orgId, project.uuid, withEnvironments]);
  if (!slot) return null;
  // The current names win over the fetched lists (a rename shows at once, as Coolify's name-changed event does).
  const projectItems = (projects.length ? projects : [project]).map((p) => ({ uuid: p.uuid, name: p.uuid === project.uuid ? project.name : p.name, href: projectPath(p.uuid) }));
  return createPortal(
    <div data-testid="project-topbar-context" className="flex min-w-0 items-center gap-0.5 text-[13px]">
      <Switcher href={projectPath(project.uuid)} label={project.name} linkTitle="Go to project" buttonTitle="Switch project" heading="Projects" panelClass="min-w-56" items={projectItems} current={project.uuid} />
      {environment ? (
        <Switcher
          href={environmentPath(project.uuid, environment.uuid)}
          label={environment.name}
          linkTitle="Go to environment"
          buttonTitle="Switch environment"
          heading="Environments"
          panelClass="min-w-52"
          items={(environments.length ? environments : [environment]).map((e) => ({ uuid: e.uuid, name: e.uuid === environment.uuid ? environment.name : e.name, href: environmentPath(project.uuid, e.uuid) }))}
          current={environment.uuid}
        />
      ) : null}
    </div>,
    slot,
  );
}
