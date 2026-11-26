// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/dashboard.blade.php, app/Livewire/Dashboard.php,
// resources/views/livewire/dashboard/active-deployments.blade.php, app/Livewire/Dashboard/ActiveDeployments.php,
// resources/views/components/{section-heading,section-heading-link,canvas-view-toggle,empty}.blade.php and
// resources/views/components/table/sort-header.blade.php (Apache-2.0), modified.
//
// The dashboard at / (route `dashboard`, DP-100): the team's projects and servers, each as a table or a grid of their
// first eight (sorted as setProjectSort() / setServerSort() sort them, "View all" past eight), the empty states that
// start a team off (no projects yet; a private key before the first server; no servers yet), the links to the
// dashboard canvas and to creating a project, a resource or a server, and <livewire:dashboard.active-deployments>
// (polled every 3 s).
//
// Not here: the pending team invitations (no endpoint lists a user's invitations to other teams yet), the security
// update callout (image scanning is not ported), the starred resources (Freeploy has no stars), the traffic analytics
// section and the servers' metrics charts (Sentinel's data needs the SSH executor; the table's Usage column shows "-").
// Coolify remembers the canvas as the dashboard's view and redirects to it (RemembersCanvasView); here the dashboard
// is always the list, and the table / grid choice of each section is remembered in this browser.
import { useEffect, useState, type ReactNode } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson } from "../lib/api";
import { ago } from "../lib/ago";
import { Reicon } from "../components/Reicon";
import { Empty, ModalInput } from "../components/Coolify";
import { SortHeader, type ListState } from "../components/CoolifyList";
import { AddEmpty } from "./Projects";
import { projectsApi } from "./ProjectChrome";
import {
  countWord,
  DASHBOARD_ITEM_LIMIT,
  dashboardProjects,
  dashboardServers,
  deploymentStatusMeta,
  deploymentsTitle,
  isValidSort,
  projectHref,
  PROJECT_SORT_COLUMNS,
  SERVER_SORT_COLUMNS,
  type DashboardDeployment,
  type DashboardProject,
  type DashboardServer,
} from "../lib/dashboard";

type ViewMode = "table" | "grid";

const ICON_BUTTON = "card-icon-button flex size-6.5 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-black";
const TITLE_ICON_BUTTON =
  "flex size-5 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-black dark:text-fg-faint dark:hover:bg-white/[0.06] dark:hover:text-fg";
const TABLE_SHELL = "overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.05]";
const TABLE_HEAD = "border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[11px] font-medium text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-faint";
const TABLE_ROW = "min-h-14 items-center border-b border-neutral-200 px-4 py-2.5 text-[12px] transition-colors last:border-b-0 hover:bg-neutral-50 dark:border-white/[0.07] dark:hover:bg-white/[0.025]";
const GLYPH = "resource-glyph flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500";
const CARD =
  "group relative flex min-h-28 min-w-0 flex-col rounded-xl border border-neutral-200 bg-white p-3 shadow-sm transition-all hover:-translate-y-px hover:border-neutral-300 hover:shadow-md dark:border-white/[0.08] dark:bg-white/[0.05] dark:hover:border-white/[0.14]";
const VIEW_ITEM = "relative flex h-7.5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[12px] font-medium transition-colors";
const VIEW_IDLE = "text-neutral-400 hover:bg-neutral-100 hover:text-black dark:hover:text-white";
const DEPLOYMENT_ROW =
  "dashboard-deployment-table-grid group block border-b border-neutral-200 px-4 py-3 transition-colors last:border-b-0 hover:bg-neutral-50 focus-visible:z-10 focus-visible:bg-coollabs/10 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-coollabs focus-visible:ring-offset-0 @2xl:grid @2xl:items-center @2xl:gap-4 dark:border-white/[0.08] dark:hover:bg-white/[0.025] dark:focus-visible:bg-brand/10 dark:focus-visible:ring-brand-light";
const DEPLOYMENT_HEAD =
  "dashboard-deployment-table-grid hidden items-center gap-4 border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[11px] font-medium text-neutral-500 @2xl:grid dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-faint";
const HIDDEN = { display: "none" } as const;

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the choice lasts this page only */
  }
}

/** RemembersCanvasView::listView($page, 'table'): ?view=table|grid, else the remembered view, else table. */
function initialView(page: string): ViewMode {
  for (const view of [new URLSearchParams(window.location.search).get("view"), stored(`freeploy.view.${page}`)]) if (view === "table" || view === "grid") return view;
  return "table";
}

function useView(page: string): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(() => initialView(page));
  return [
    mode,
    (next) => {
      setMode(next);
      store(`freeploy.view.${page}`, next);
    },
  ];
}

/** <x-table.sort-header> with `action` and `current`: a sort the dashboard keeps (isValidSort()). */
function Sort(props: { sort: string; onSort: (sort: string) => void; columns: readonly string[]; label: string; asc: string; desc: string; first?: "asc" | "desc" }) {
  const list = { sortBy: props.sort, setSortBy: (value: string) => isValidSort(value, props.columns) && props.onSort(value) } as unknown as ListState<unknown>;
  return <SortHeader list={list} label={props.label} asc={props.asc} desc={props.desc} {...(props.first ? { first: props.first } : {})} />;
}

/** <x-canvas-view-toggle>: the table / grid switch (the view that is not current), and the canvas link when given. */
function ViewToggle({ mode, onMode, canvasUrl }: { mode?: ViewMode; onMode?: (mode: ViewMode) => void; canvasUrl?: string }) {
  const views: Array<[ViewMode, string, string]> = [
    ["table", "Table view", "unordered-list"],
    ["grid", "Grid view", "grid"],
  ];
  return (
    <div className="view-toggle">
      {mode && onMode ? (
        <span className="flex w-7.5 shrink-0">
          {views.map(([view, label, icon]) => (
            <button key={view} type="button" onClick={() => onMode(view)} style={mode !== view ? undefined : HIDDEN} className={`${VIEW_ITEM} ${VIEW_IDLE} w-7.5 justify-center px-0!`} title={label} aria-label={label}>
              <Reicon name={icon} className="size-3.5" />
            </button>
          ))}
        </span>
      ) : null}
      {canvasUrl ? (
        <a href={canvasUrl} className={`${VIEW_ITEM} ${VIEW_IDLE}`} title="Canvas view (beta): see everything and how it connects">
          <Reicon name="deploy-canvas" className="size-3.5" />
          Canvas
          <span className="ml-0.5 inline-flex items-center rounded-full bg-coollabs px-1.5 py-px text-[10px] leading-4 font-semibold text-white">Try it</span>
        </a>
      ) : null}
    </div>
  );
}

/** <x-section-heading>: the title, its small action, "View all" and the right-aligned actions. */
function SectionHeading({ title, titleAction, href, actions, className = "" }: { title: string; titleAction?: ReactNode; href?: string | null; actions?: ReactNode; className?: string }) {
  const link = href ? (
    <a href={href} className="group inline-flex shrink-0 items-center gap-0.5 text-[11px] text-neutral-500 hover:text-black hover:underline dark:text-fg-faint dark:hover:text-fg">
      View all
    </a>
  ) : null;
  return (
    <div className={`mb-3 min-w-0 ${className}`.trim()}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <h2 className="min-w-0 truncate text-[14px]! leading-5! font-semibold! text-black dark:text-fg">{title}</h2>
            {titleAction}
          </div>
          {actions ? null : link}
        </div>
        {actions ? (
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {link}
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** <x-status-badge> with `spinning` for a running deployment. */
function DeploymentBadge({ deployment }: { deployment: DashboardDeployment }) {
  const [label, type] = deploymentStatusMeta(deployment);
  const dot = { neutral: "bg-neutral-400 dark:bg-neutral-500", success: "bg-emerald-500", warning: "bg-warning", error: "bg-red-500" }[type];
  return (
    <span className="inline-flex max-w-full items-center whitespace-nowrap text-neutral-700 dark:text-fg gap-1.5 text-[13px]">
      {deployment.status === "in_progress" ? (
        <svg className="loading-indicator size-3 shrink-0 animate-spin text-neutral-500 dark:text-fg-dim" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle className="opacity-20" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
          <path className="opacity-80" d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ) : (
        <span className="relative flex size-1.5 shrink-0">
          <span className={`relative inline-flex size-1.5 rounded-full ${dot}`} />
        </span>
      )}
      <span className="truncate">{label}</span>
    </span>
  );
}

/** Carbon's toDayDateTimeString(): "Thu, Nov 26, 2026 3:04 PM" (UTC, as the server renders it). */
function dayDateTime(iso: string): string {
  const d = new Date(iso);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const h = d.getUTCHours();
  return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function DeploymentRow({ deployment, finished }: { deployment: DashboardDeployment; finished: boolean }) {
  const at = finished ? deployment.finishedAt : deployment.createdAt;
  const path = deployment.environmentPath || "-";
  return (
    <a href={deployment.deploymentUrl ?? ""} className={DEPLOYMENT_ROW}>
      <div className="min-w-0">
        <p className="truncate text-[13px] font-semibold text-black dark:text-fg">{deployment.applicationName}</p>
        {deployment.pullRequestId ? <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-fg-faint">Pull request #{deployment.pullRequestId}</p> : null}
      </div>
      <p className="hidden truncate text-[12px] text-neutral-500 @2xl:block dark:text-fg-dim">{path}</p>
      <p className="hidden truncate text-[12px] text-neutral-500 @2xl:block dark:text-fg-dim">{deployment.serverName || "-"}</p>
      <span className="hidden @2xl:block">
        <DeploymentBadge deployment={deployment} />
      </span>
      <p className="hidden truncate text-[12px] text-neutral-500 @2xl:block dark:text-fg-dim" title={finished && at ? dayDateTime(at) : undefined}>
        {at ? ago(at) : "-"}
      </p>
      <div className="mt-3 flex min-w-0 items-center gap-3 @2xl:hidden">
        <DeploymentBadge deployment={deployment} />
        <p className="min-w-0 truncate text-[11px] text-neutral-500 dark:text-fg-faint">{path}</p>
        {at ? (
          <time dateTime={at} title={dayDateTime(at)} className="ml-auto shrink-0 whitespace-nowrap text-[11px] text-neutral-500 dark:text-fg-faint">
            {ago(at)}
          </time>
        ) : null}
      </div>
    </a>
  );
}

/** <livewire:dashboard.active-deployments>: wire:poll.3000ms. */
function ActiveDeployments({ base }: { base: string }) {
  const [lists, setLists] = useState<{ active: DashboardDeployment[]; recent: DashboardDeployment[] } | null>(null);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      const r = await getJson<{ active: DashboardDeployment[]; recent: DashboardDeployment[] }>(`${base}/deployments`);
      if (!stop && r.data) setLists({ active: r.data.active, recent: r.data.recent });
    };
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [base]);
  const active = lists?.active ?? [];
  const recent = lists?.recent ?? [];
  if (!active.length && !recent.length) return <div className="min-w-0 hidden" />;
  return (
    <div className="min-w-0 mb-0!">
      <section className="@container mb-0! min-w-0">
        <SectionHeading title={deploymentsTitle(recent.length)} className="py-1.5" />
        <div className="flex min-w-0 flex-col gap-4">
          {active.length ? (
            <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.05]">
              <div className="border-b border-neutral-200 px-4 py-2.5 dark:border-white/[0.08]">
                <h3 className="text-[11px]! leading-4! font-medium! text-neutral-500! dark:text-fg-faint!">Active</h3>
                <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-fg-faint">Running or queued right now</p>
              </div>
              <div className={DEPLOYMENT_HEAD}>
                <span>Application</span>
                <span>Environment</span>
                <span>Server</span>
                <span>Status</span>
                <span>Started</span>
              </div>
              {active.map((d) => (
                <DeploymentRow key={d.deploymentUuid} deployment={d} finished={false} />
              ))}
            </div>
          ) : null}
          {recent.length ? (
            <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.05]">
              <div className={DEPLOYMENT_HEAD}>
                <span>Application</span>
                <span>Environment</span>
                <span>Server</span>
                <span>Status</span>
                <span>Finished</span>
              </div>
              {recent.map((d) => (
                <DeploymentRow key={d.deploymentUuid} deployment={d} finished />
              ))}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function ProjectsSection({ base, projects, canCreate, canUpdate }: { base: string; projects: DashboardProject[]; canCreate: boolean; canUpdate: boolean }) {
  const [sort, setSort] = useState("name-asc");
  const [view, setView] = useView("dashboard_projects");
  const [addOpen, setAddOpen] = useState(false);
  const shown = dashboardProjects(projects, sort);
  const addHref = (p: DashboardProject) => (canCreate && p.firstEnvironmentUuid ? `/project/${p.uuid}/environment/${p.firstEnvironmentUuid}/new` : null);
  const settingsHref = (p: DashboardProject) => (canUpdate ? `/project/${p.uuid}/edit` : null);
  const actions = (p: DashboardProject) => (
    <>
      {addHref(p) ? (
        <a href={addHref(p)!} className={ICON_BUTTON} title="Add resource" aria-label={`Add resource to ${p.name}`}>
          <Reicon name="plus" className="size-3" />
        </a>
      ) : null}
      {settingsHref(p) ? (
        <a href={settingsHref(p)!} className={ICON_BUTTON} title="Project settings" aria-label={`Open settings for ${p.name}`}>
          <Reicon name="settings" className="size-3" />
        </a>
      ) : null}
    </>
  );
  const sortProps = { sort, onSort: setSort, columns: PROJECT_SORT_COLUMNS };
  return (
    <section className="@container mb-0! min-w-0">
      <SectionHeading
        title="Projects"
        href={projects.length > DASHBOARD_ITEM_LIMIT ? "/projects" : null}
        titleAction={
          canCreate ? (
            <ModalInput
              title="New Project"
              open={addOpen}
              onOpenChange={setAddOpen}
              trigger={
                <button type="button" className={TITLE_ICON_BUTTON} title="New project" aria-label="New project">
                  <Reicon name="plus" className="size-3" />
                </button>
              }
            >
              <AddEmpty base={base} />
            </ModalInput>
          ) : null
        }
        actions={shown.length ? <ViewToggle mode={view} onMode={setView} canvasUrl="/dashboard/canvas" /> : <ViewToggle canvasUrl="/dashboard/canvas" />}
      />
      {shown.length === 0 ? (
        <Empty title="No projects yet" description="Create your first deployment workspace." iconName="projects" size="sm" />
      ) : (
        <>
          <div style={view === "grid" ? undefined : HIDDEN} className="grid min-w-0 grid-cols-1 gap-3 @lg:grid-cols-2 @4xl:grid-cols-4">
            {shown.map((p) => (
              <article key={p.uuid} className={CARD}>
                <a href={projectHref(p)} className="absolute inset-0 rounded-xl" aria-label={`Open ${p.name}`} />
                <div className="flex min-w-0 items-start gap-3">
                  <div className={GLYPH}>
                    <Reicon name="projects" className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1 self-center">
                    <h3 className="truncate text-[13px]! leading-4! font-semibold! text-black dark:text-fg">{p.name}</h3>
                    {p.description?.trim() ? <p className="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-fg-faint">{p.description}</p> : null}
                  </div>
                </div>
                <div className="mt-auto flex items-center justify-between gap-3 border-t border-neutral-100 pt-2.5 dark:border-white/[0.06]">
                  <p className="project-card-stats relative z-10 min-w-0">
                    <b>{p.environmentCount}</b> {countWord(p.environmentCount, "environment", "environments")}{" "}
                    <span className="project-card-stats-dot" aria-hidden="true">
                      &middot;
                    </span>{" "}
                    <b>{p.resourceCount}</b> {countWord(p.resourceCount, "resource", "resources")}
                  </p>
                  <div className="relative z-10 flex shrink-0 items-center gap-0.5">{actions(p)}</div>
                </div>
              </article>
            ))}
          </div>
          <div style={view === "table" ? undefined : HIDDEN} className={`${TABLE_SHELL} transition-opacity`}>
            <div className={`grid grid-cols-[minmax(0,1fr)_7rem_4.5rem] gap-4 @2xl:min-w-[560px] @2xl:grid-cols-[minmax(0,1.2fr)_7rem_minmax(0,1.5fr)_4.5rem] ${TABLE_HEAD}`}>
              <Sort {...sortProps} label="Project" asc="name-asc" desc="name-desc" />
              <Sort {...sortProps} label="Contents" asc="resources-asc" desc="resources-desc" first="desc" />
              <div className="hidden @2xl:block">
                <Sort {...sortProps} label="Description" asc="description-asc" desc="description-desc" />
              </div>
              <span className="text-right">Actions</span>
            </div>
            {shown.map((p) => (
              <div key={p.uuid} className={`relative grid grid-cols-[minmax(0,1fr)_7rem_4.5rem] gap-4 @2xl:min-w-[560px] @2xl:grid-cols-[minmax(0,1.2fr)_7rem_minmax(0,1.5fr)_4.5rem] ${TABLE_ROW}`}>
                <a href={projectHref(p)} className="absolute inset-0" aria-label={`Open ${p.name}`} />
                <div className="flex min-w-0 items-center gap-3">
                  <div className={GLYPH}>
                    <Reicon name="projects" className="size-4" />
                  </div>
                  <p className="truncate text-[13px] font-semibold text-black dark:text-fg">{p.name}</p>
                </div>
                <div className="relative z-10 flex w-fit items-center gap-3 font-medium text-neutral-600 dark:text-fg-dim">
                  <span className="inline-flex items-center gap-1" data-tooltip="Environments" aria-label="Environments">
                    <Reicon name="layers" className="size-3.5 text-neutral-400 dark:text-fg-faint" />
                    {p.environmentCount}
                  </span>
                  <span className="inline-flex items-center gap-1" data-tooltip="Resources" aria-label="Resources">
                    <Reicon name="grid" className="size-3.5 text-neutral-400 dark:text-fg-faint" />
                    {p.resourceCount}
                  </span>
                </div>
                <p className="hidden truncate text-neutral-500 @2xl:block dark:text-fg-dim">{p.description?.trim() ? p.description : "-"}</p>
                <div className="relative z-10 flex items-center justify-end gap-0.5">{actions(p)}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

const STATUS_DOT = { success: "bg-green-500 dark:bg-green-400", warning: "bg-orange-500 dark:bg-warning", error: "bg-red-500 dark:bg-red-400" } as const;

function ServersSection({ servers, hasPrivateKeys, canCreate }: { servers: DashboardServer[]; hasPrivateKeys: boolean; canCreate: boolean }) {
  const [sort, setSort] = useState("name-asc");
  const [view, setView] = useView("dashboard_servers");
  const shown = dashboardServers(servers, sort);
  const sortProps = { sort, onSort: setSort, columns: SERVER_SORT_COLUMNS };
  // A Usage column (latest CPU and memory) only when a listed server collects metrics.
  const showUsage = shown.some((s) => s.isMetricsEnabled);
  const columns = showUsage
    ? "grid-cols-[minmax(0,1fr)_9.5rem] @xl:grid-cols-[minmax(0,1fr)_9rem_9.5rem] @2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_9rem_9.5rem]"
    : "grid-cols-[minmax(0,1fr)_9.5rem] @2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_9.5rem]";
  return (
    <section className="@container mb-0! min-w-0">
      <SectionHeading
        title="Servers"
        href={servers.length > DASHBOARD_ITEM_LIMIT ? "/servers" : null}
        titleAction={
          canCreate ? (
            <a href="/servers/new" className={TITLE_ICON_BUTTON} title="New server" aria-label="New server">
              <Reicon name="plus" className="size-3" />
            </a>
          ) : null
        }
        {...(shown.length ? { actions: <ViewToggle mode={view} onMode={setView} /> } : {})}
      />
      {shown.length === 0 ? (
        hasPrivateKeys ? (
          <Empty title="No servers yet" description="Connect infrastructure for your deployments." iconName="servers" size="sm">
            {canCreate ? (
              <a href="/servers/new" className="button button-highlighted">
                <Reicon name="plus" className="size-3.5" />
                New server
              </a>
            ) : null}
          </Empty>
        ) : (
          <Empty title="A private key is required" description="Add an SSH private key before connecting your first server." iconName="keys" size="sm">
            {canCreate ? (
              <a href="/security/private-key" className="button button-highlighted">
                <Reicon name="plus" className="size-3.5" />
                Add private key
              </a>
            ) : null}
          </Empty>
        )
      ) : (
        <>
          <div style={view === "grid" ? undefined : HIDDEN} className="grid min-w-0 grid-cols-1 gap-3 @lg:grid-cols-2 @4xl:grid-cols-4">
            {shown.map((s) => (
              <a key={s.uuid} href={`/server/${s.uuid}`} aria-label={`Open ${s.name}`} className={CARD}>
                <div className="relative z-10 flex min-w-0 items-start gap-3">
                  <div className={GLYPH}>
                    <Reicon name="servers" className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1 self-center">
                    <h3 className="truncate text-[13px]! leading-4! font-semibold! text-black dark:text-fg">{s.name}</h3>
                    {s.description?.trim() ? <p className="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-fg-faint">{s.description}</p> : null}
                  </div>
                  {s.statusType !== "success" ? (
                    <span
                      data-tooltip={s.status}
                      aria-label={`Server status: ${s.status}`}
                      className={`flex size-6 shrink-0 items-center justify-center rounded-md ${s.statusType === "warning" ? "text-orange-500 dark:text-warning" : "text-red-500 dark:text-red-400"}`}
                    >
                      <Reicon name="alert-triangle" className="size-4" />
                    </span>
                  ) : null}
                </div>
              </a>
            ))}
          </div>
          <div style={view === "table" ? undefined : HIDDEN} className={`${TABLE_SHELL} transition-opacity`}>
            <div className={`grid ${columns} gap-4 @2xl:min-w-[480px] ${TABLE_HEAD}`}>
              <Sort {...sortProps} label="Server" asc="name-asc" desc="name-desc" />
              <div className="hidden @2xl:block">
                <Sort {...sortProps} label="Description" asc="description-asc" desc="description-desc" />
              </div>
              {showUsage ? <div className="hidden @xl:block">Usage</div> : null}
              <Sort {...sortProps} label="Status" asc="status-asc" desc="status-desc" />
            </div>
            {shown.map((s) => (
              <a key={s.uuid} href={`/server/${s.uuid}`} className={`grid ${columns} gap-x-4 gap-y-2 @2xl:min-w-[480px] hover:no-underline ${TABLE_ROW}`}>
                <div className="flex min-w-0 items-center gap-3">
                  <div className={GLYPH}>
                    <Reicon name="servers" className="size-4" />
                  </div>
                  <p className="truncate text-[13px] font-semibold text-black dark:text-fg">{s.name}</p>
                </div>
                <p className="hidden truncate text-neutral-500 @2xl:block dark:text-fg-dim">{s.description?.trim() ? s.description : "-"}</p>
                {showUsage ? (
                  <div className={`order-last col-span-full @xl:order-none @xl:col-span-1${s.isMetricsEnabled ? "" : " hidden @xl:block"}`}>
                    {s.isMetricsEnabled ? (
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-neutral-500 tabular-nums @xl:grid-cols-1 dark:text-fg-dim">
                        {(
                          [
                            ["CPU", "bg-[rgb(30,144,255)]"],
                            ["Mem", "bg-[rgb(168,85,247)]"],
                          ] as const
                        ).map(([label, color]) => (
                          <div key={label} className="flex items-center gap-2">
                            <span className="w-7 shrink-0">{label}</span>
                            <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-white/[0.08]">
                              <span className={`block h-full rounded-full ${color} transition-[width] duration-500`} style={{ width: "0%" }} />
                            </span>
                            <span className="w-8 shrink-0 text-right">-</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-neutral-500 dark:text-fg-dim">-</span>
                    )}
                  </div>
                ) : null}
                <div className="flex items-center gap-2 text-[11px] font-medium text-neutral-600 dark:text-fg-dim">
                  <span className={`size-2 shrink-0 rounded-full ${STATUS_DOT[s.statusType]}`} />
                  {s.status}
                </div>
              </a>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

interface DashboardData {
  projects: DashboardProject[];
  servers: DashboardServer[];
  hasPrivateKeys: boolean;
  canCreate: boolean;
  canUpdate: boolean;
}

function DashboardContent() {
  const { me } = useSignedIn();
  const org = me.team?.id;
  const base = `/v1/organizations/${org ?? ""}/deploy/dashboard`;
  const [data, setData] = useState<DashboardData | null>(null);
  useEffect(() => {
    void getJson<DashboardData>(base).then((r) => setData(r.data ?? { projects: [], servers: [], hasPrivateKeys: false, canCreate: false, canUpdate: false }));
  }, [base]);
  if (!data) return null;
  return (
    <div className="application-settings-form w-full">
      <div className="flex min-w-0 flex-col gap-8">
        {/* Wide screens: projects and servers fill the left, activity is a fixed-width column on the right. */}
        <div className="grid min-w-0 gap-8 xl:items-start xl:has-[.dashboard-activity_section]:grid-cols-[minmax(0,1fr)_22rem] 2xl:has-[.dashboard-activity_section]:grid-cols-[minmax(0,1fr)_26rem]">
          <div className="dashboard-activity hidden min-w-0 has-[section]:flex flex-col gap-8 xl:order-last">
            <ActiveDeployments base={base} />
          </div>
          <div className="flex min-w-0 flex-col gap-8">
            <ProjectsSection base={projectsApi(org)} projects={data.projects} canCreate={data.canCreate} canUpdate={data.canUpdate} />
            <ServersSection servers={data.servers} hasPrivateKeys={data.hasPrivateKeys} canCreate={data.canCreate} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function DashboardPage() {
  return (
    <Layout title="Dashboard" href="/" navHref="/">
      <DashboardContent />
    </Layout>
  );
}
