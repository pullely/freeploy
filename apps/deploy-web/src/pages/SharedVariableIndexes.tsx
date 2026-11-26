// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/shared-variables/index.blade.php,
// resources/views/livewire/shared-variables/{project,environment,server}/index.blade.php and
// app/Livewire/SharedVariables/{Index,Project/Index,Environment/Index,Server/Index}.php
// (Apache-2.0), modified.
//
// /shared-variables (the overview), /shared-variables/projects,
// /shared-variables/environments and /shared-variables/servers: where the
// scopes' variables are found. The overview's variables link to their scope's
// canvas, as Coolify's do (the canvases are DP-98's). Project icons are not
// ported: every project shows the default glyph.
import { useEffect, useState } from "react";
import { useSignedIn } from "../layout/Layout";
import { getJson } from "../lib/api";
import { agoShort } from "../lib/ago";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Empty, StatusBadge } from "../components/Coolify";
import {
  card,
  environmentVariablesPath,
  GLYPH,
  LIST,
  LIST_ROW,
  plural,
  projectVariablesPath,
  scopeHeadline,
  scopePath,
  SectionHeading,
  serverVariablesPath,
  SharedVariablesLayout,
  sharedVariablesApi,
  useIndexView,
  ViewControls,
  type SharedVariableScope,
} from "./SharedVariablesChrome";

const HIDDEN = { display: "none" as const };
const shown = (visible: boolean) => (visible ? undefined : HIDDEN);

/**
 * GET /shared-variables/{path}, or null while it loads; a failure says so and
 * shows the empty page (`empty`, a constant of the calling page).
 */
function useIndex<T>(path: string, failure: string, empty: T): T | null {
  const { me } = useSignedIn();
  const url = `${sharedVariablesApi(me.team?.id)}${path}`;
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    void (async () => {
      const r = await getJson<T>(url);
      if (!r.data && r.status !== 401) notify.error(failure);
      setData(r.data ?? empty);
    })();
  }, [url, failure, empty]);
  return data;
}

// ---------------------------------------------------------------- /shared-variables

interface OverviewVariable {
  id: string;
  key: string;
  scope: SharedVariableScope;
  owner: string | null;
  ownerUuid: string | null;
  projectUuid: string | null;
  resources: number;
  updatedAt: string | null;
}

interface Overview {
  scopes: Record<SharedVariableScope, { variables: number; owners: number }>;
  recent: OverviewVariable[];
  used: OverviewVariable[];
  unused: OverviewVariable[];
  missing: number;
}

const NO_SCOPE = { variables: 0, owners: 0 };
const EMPTY_OVERVIEW: Overview = { scopes: { team: NO_SCOPE, project: NO_SCOPE, environment: NO_SCOPE, server: NO_SCOPE }, recent: [], used: [], unused: [], missing: 0 };

/** $scopeCards: the label, icon, link, description and what its owners are called. */
const SCOPE_CARDS: Array<[SharedVariableScope, string, string, string, string, string | null]> = [
  ["team", "Team wide", "teams", "/shared-variables/team", "Every resource of this team.", null],
  ["project", "Project wide", "projects", "/shared-variables/projects", "Every environment of a project.", "project"],
  ["environment", "Environment wide", "layers", "/shared-variables/environments", "Resources in one environment.", "environment"],
  ["server", "Server wide", "servers", "/shared-variables/servers", "Resources deployed on one server.", "server"],
];

const PANEL = "rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.05]";
const PANEL_TITLE = "flex items-center justify-between gap-2 border-b border-neutral-200 px-3 py-2.5 text-[12px] font-semibold text-black dark:border-white/[0.06] dark:text-fg";
const ROW = "flex items-center gap-2 border-b border-neutral-100 px-3 py-2 last:border-b-0 hover:bg-neutral-50 hover:no-underline dark:border-white/[0.04] dark:hover:bg-white/[0.03]";
const SCOPE_BADGE = "shrink-0 rounded-full border border-neutral-200 bg-neutral-50 px-1.5 text-[10px] leading-4 font-medium text-neutral-500 dark:border-white/[0.1] dark:bg-white/[0.05] dark:text-fg-dim";
const PANEL_EMPTY = "px-3 py-4 text-[12px] text-neutral-500 dark:text-fg-faint";

/** SharedVariableCanvas::connectLink(): the variable selected on its scope's canvas. */
function connectLink(variable: OverviewVariable): string {
  const page = scopePath(variable.scope, variable.ownerUuid, variable.projectUuid);
  return page ? `${page}/canvas?select=${encodeURIComponent(`variable:${variable.id}`)}` : "";
}

function KeyAndOwner({ variable }: { variable: OverviewVariable }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate font-mono text-[12px] text-black dark:text-fg">{variable.key}</span>
      <span className="block truncate text-[11px] text-neutral-500 dark:text-fg-faint">{variable.owner}</span>
    </span>
  );
}

export function SharedVariablesOverview() {
  const overview = useIndex<Overview>("", "Failed to load shared variables.", EMPTY_OVERVIEW);
  if (!overview) return null;

  return (
    <SharedVariablesLayout>
      <div className="flex w-full flex-col gap-4">
        {/* Scopes, with how many variables each has and on how many owners. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {SCOPE_CARDS.map(([scope, label, icon, href, description, ownerNoun]) => {
            const counts = overview.scopes[scope];
            return (
              <a key={scope} className={card("min-h-32")} href={href}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex size-8 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-fg-dim">
                    <Reicon name={icon} className="size-4" />
                  </div>
                  <span className="text-[22px] leading-7 font-semibold tabular-nums text-black dark:text-fg">{counts.variables}</span>
                </div>
                <div className="mt-auto pt-5">
                  <h2 className="text-[13px]! leading-4! font-semibold! text-black dark:text-fg">{label}</h2>
                  <p className="mt-1 text-[11px] leading-4 text-neutral-500 dark:text-fg-faint">
                    {ownerNoun && counts.variables > 0 ? `${plural("variable", counts.variables)} on ${counts.owners} ${plural(ownerNoun, counts.owners)}.` : description}
                  </p>
                </div>
              </a>
            );
          })}
        </div>

        {overview.missing > 0 ? (
          <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-[12px] text-neutral-700 dark:text-fg-dim" role="note">
            <Reicon name="alert-triangle" className="mt-px size-4 shrink-0 text-warning" />
            <p>
              {overview.missing} {plural("reference", overview.missing)} in resource variables {overview.missing === 1 ? "points" : "point"} to a shared variable that does not exist. Open a scope canvas to find{" "}
              {overview.missing === 1 ? "it" : "them"}.
            </p>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {/* Most used: links open the variable on its scope canvas. */}
          <section className={PANEL}>
            <h2 className={PANEL_TITLE}>Most used</h2>
            {overview.used.length === 0 ? (
              <p className={PANEL_EMPTY}>No resource uses a shared variable yet.</p>
            ) : (
              overview.used.map((variable) => (
                <a key={variable.id} className={ROW} href={connectLink(variable)}>
                  <KeyAndOwner variable={variable} />
                  <span className="shrink-0 text-[11px] text-neutral-500 tabular-nums dark:text-fg-dim">
                    {variable.resources} {plural("resource", variable.resources)}
                  </span>
                </a>
              ))
            )}
          </section>

          <section className={PANEL}>
            <h2 className={PANEL_TITLE}>Recently changed</h2>
            {overview.recent.length === 0 ? (
              <p className={PANEL_EMPTY}>No shared variables yet.</p>
            ) : (
              overview.recent.map((variable) => (
                <a key={variable.id} className={ROW} href={connectLink(variable)}>
                  <KeyAndOwner variable={variable} />
                  <span className="shrink-0 text-[11px] text-neutral-500 dark:text-fg-dim">{variable.updatedAt ? agoShort(variable.updatedAt) : ""}</span>
                </a>
              ))
            )}
          </section>

          {/* Not referenced by any resource: candidates to use or to clean up. */}
          <section className={PANEL}>
            <h2 className={PANEL_TITLE}>
              Not used
              <span className="text-[11px] font-normal text-neutral-400 tabular-nums dark:text-fg-faint">{overview.unused.length}</span>
            </h2>
            <div className="max-h-72 overflow-y-auto">
              {overview.unused.length === 0 ? (
                <p className={PANEL_EMPTY}>Every shared variable is in use.</p>
              ) : (
                overview.unused.map((variable) => (
                  <a key={variable.id} className={ROW} href={connectLink(variable)}>
                    <KeyAndOwner variable={variable} />
                    <span className={SCOPE_BADGE}>{scopeHeadline(variable.scope)}</span>
                  </a>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </SharedVariablesLayout>
  );
}

// ---------------------------------------------------------------- /shared-variables/projects

interface ProjectItem {
  uuid: string;
  name: string;
  description: string | null;
  variableCount: number;
}

const NO_PROJECTS: { projects: ProjectItem[] } = { projects: [] };

export function ProjectVariablesIndex() {
  const data = useIndex("/projects", "Failed to load projects.", NO_PROJECTS);
  const view = useIndexView("shared-variables-projects-view");
  if (!data) return null;
  const { projects } = data;
  const count = (project: ProjectItem) => `${project.variableCount} ${plural("variable", project.variableCount)}`;

  return (
    <SharedVariablesLayout>
      <div className="w-full">
        {projects.length === 0 ? (
          <Empty title="No projects" description="Projects that you can read show here. Create a project to add project-wide variables." iconName="projects" />
        ) : (
          <>
            <ViewControls label="projects" view={view} />

            <div style={shown(view.viewMode === "grid")} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {projects.map((project) => (
                <a key={project.uuid} style={shown(view.matches([project.name, project.description]))} className={card("min-h-28")} href={projectVariablesPath(project.uuid)}>
                  <div className="flex items-start gap-3">
                    <div className={GLYPH}>
                      <Reicon name="projects" className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1 self-center">
                      <h2 className="truncate text-[13px]! leading-4! font-semibold! text-black dark:text-fg">{project.name}</h2>
                      {project.description?.trim() ? <p className="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-fg-faint">{project.description}</p> : null}
                    </div>
                  </div>
                  <div className="mt-auto pt-4 text-[11px] text-neutral-500 dark:text-fg-dim">{count(project)}</div>
                </a>
              ))}
            </div>

            <div style={shown(view.viewMode === "list")} className={LIST}>
              {projects.map((project) => (
                <a key={project.uuid} style={shown(view.matches([project.name, project.description]))} href={projectVariablesPath(project.uuid)} className={LIST_ROW}>
                  <Reicon name="projects" className="size-4 shrink-0 text-neutral-500 dark:text-fg-dim" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{project.name}</div>
                    <div className="truncate text-[11px] text-neutral-500 dark:text-fg-faint">{project.description}</div>
                  </div>
                  <span className="shrink-0 text-[11px] text-neutral-500 dark:text-fg-dim">{count(project)}</span>
                </a>
              ))}
            </div>
          </>
        )}
      </div>
    </SharedVariablesLayout>
  );
}

// ---------------------------------------------------------------- /shared-variables/environments

interface EnvironmentItem {
  uuid: string;
  name: string;
  description: string | null;
}

interface EnvironmentsProject {
  uuid: string;
  name: string;
  description: string | null;
  environments: EnvironmentItem[];
}

const NO_ENVIRONMENTS: { projects: EnvironmentsProject[] } = { projects: [] };

export function EnvironmentVariablesIndex() {
  const data = useIndex("/environments", "Failed to load environments.", NO_ENVIRONMENTS);
  const view = useIndexView("shared-variables-environments-view");
  if (!data) return null;
  const { projects } = data;

  return (
    <SharedVariablesLayout>
      <div className="w-full">
        {projects.length === 0 ? (
          <Empty title="No environments" description="Environments that you can read show here. Create an environment to add environment-wide variables." iconName="layers" />
        ) : (
          <>
            <ViewControls label="environments" view={view} />

            <div style={shown(view.viewMode === "grid")} className="flex flex-col gap-6">
              {projects.map((project) => (
                <section key={project.uuid} style={shown(view.matches([project.name, project.description, ...project.environments.flatMap((e) => [e.name, e.description])]))}>
                  <SectionHeading title={project.name} subtitle={project.description || "Project environments"} />
                  {project.environments.length === 0 ? (
                    <Empty title="No environments in this project." size="sm" />
                  ) : (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      {project.environments.map((environment) => (
                        <a
                          key={environment.uuid}
                          style={shown(view.matches([environment.name, environment.description, project.name]))}
                          className={card("min-h-24")}
                          href={environmentVariablesPath(project.uuid, environment.uuid)}
                        >
                          <div className="flex items-start gap-3">
                            <div className={GLYPH}>
                              <Reicon name="layers" className="size-4" />
                            </div>
                            <div className="min-w-0 flex-1 self-center">
                              <h3 className="truncate text-[13px]! leading-4! font-semibold! text-black dark:text-fg">{environment.name}</h3>
                              {environment.description?.trim() ? <p className="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-fg-faint">{environment.description}</p> : null}
                            </div>
                          </div>
                        </a>
                      ))}
                    </div>
                  )}
                </section>
              ))}
            </div>

            <div style={shown(view.viewMode === "list")} className={LIST}>
              {projects.flatMap((project) =>
                project.environments.map((environment) => (
                  <a
                    key={environment.uuid}
                    style={shown(view.matches([environment.name, environment.description, project.name]))}
                    href={environmentVariablesPath(project.uuid, environment.uuid)}
                    className={LIST_ROW}
                  >
                    <Reicon name="layers" className="size-4 shrink-0 text-neutral-500 dark:text-fg-dim" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{environment.name}</div>
                      <div className="truncate text-[11px] text-neutral-500 dark:text-fg-faint">{environment.description}</div>
                    </div>
                    <span className="shrink-0 text-[11px] text-neutral-500 dark:text-fg-dim">{project.name}</span>
                  </a>
                )),
              )}
            </div>
          </>
        )}
      </div>
    </SharedVariablesLayout>
  );
}

// ---------------------------------------------------------------- /shared-variables/servers

interface ServerItem {
  uuid: string;
  name: string;
  description: string | null;
  ip: string;
  isFunctional: boolean;
}

const NO_SERVERS: { servers: ServerItem[] } = { servers: [] };

/** $server->isFunctional() ? 'Ready' : 'Validation required'. */
function ServerStatus({ server }: { server: ServerItem }) {
  return <StatusBadge label={server.isFunctional ? "Ready" : "Validation required"} type={server.isFunctional ? "success" : "warning"} />;
}

export function ServerVariablesIndex() {
  const data = useIndex("/servers", "Failed to load servers.", NO_SERVERS);
  const view = useIndexView("shared-variables-servers-view");
  if (!data) return null;
  const { servers } = data;

  return (
    <SharedVariablesLayout>
      <div className="w-full">
        {servers.length === 0 ? (
          <Empty title="No servers yet" description="Add a server before creating server-wide variables." iconName="servers" />
        ) : (
          <>
            <ViewControls label="servers" view={view} />

            <div style={shown(view.viewMode === "grid")} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {servers.map((server) => (
                <a key={server.uuid} style={shown(view.matches([server.name, server.description, server.ip]))} className={card("min-h-28")} href={serverVariablesPath(server.uuid)}>
                  <div className="flex items-start gap-3">
                    <div className={GLYPH}>
                      <Reicon name="servers" className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-[13px]! leading-4! font-semibold! text-black dark:text-fg">{server.name}</h2>
                      <p className="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-fg-faint">{server.description || server.ip}</p>
                    </div>
                  </div>
                  <div className="mt-auto pt-4">
                    <ServerStatus server={server} />
                  </div>
                </a>
              ))}
            </div>

            <div style={shown(view.viewMode === "list")} className={LIST}>
              {servers.map((server) => (
                <a key={server.uuid} style={shown(view.matches([server.name, server.description, server.ip]))} href={serverVariablesPath(server.uuid)} className={LIST_ROW}>
                  <Reicon name="servers" className="size-4 shrink-0 text-neutral-500 dark:text-fg-dim" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{server.name}</div>
                    <div className="truncate text-[11px] text-neutral-500 dark:text-fg-faint">{server.description || server.ip}</div>
                  </div>
                  <ServerStatus server={server} />
                </a>
              ))}
            </div>
          </>
        )}
      </div>
    </SharedVariablesLayout>
  );
}
