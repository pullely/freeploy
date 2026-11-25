// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/application/{configuration,heading}.blade.php,
// resources/views/components/application/configuration-sidebar.blade.php and
// resources/views/components/{status-summary,split-action}.blade.php (Apache-2.0), modified.
//
// What every application page shares: the heading (name, status, Deploy with
// its menu) and the configuration menu. Coolify shows the heading's actions in
// the top bar from xl and the menu inside the main sidebar; here both stay in
// the page, as the server pages do. Deploy, Restart and Stop need the SSH
// executor: the API answers "not available yet" and the toast says so.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { postJson, summarize } from "../lib/api";
import { notify, toast } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Helper, ModalConfirmation } from "../components/Coolify";
import { environmentPath, ProjectBreadcrumb } from "./ProjectChrome";
import { BetaBadge } from "./ServerChrome";

/** GET /applications/{uuid}: the application as the configuration pages read it. */
export interface ApplicationInfo {
  uuid: string;
  name: string;
  description: string | null;
  fqdn: string | null;
  buildPack: string;
  status: string;
  stoppedAfterRestartLimit: boolean;
  containerPresent: boolean | null;
  dockerRegistryImageName: string | null;
  dockerRegistryImageTag: string | null;
  portsExposes: string | null;
  portsMappings: string | null;
  customNetworkAliases: string | null;
  customDockerRunOptions: string | null;
  preDeploymentCommand: string | null;
  preDeploymentCommandContainer: string | null;
  postDeploymentCommand: string | null;
  postDeploymentCommandContainer: string | null;
  isContainerLabelReadonlyEnabled: boolean;
  isContainerLabelEscapeEnabled: boolean;
  // The container labels and HTTP Basic Authentication (ApplicationLabels.tsx); the text and the password are null for a reader.
  customLabels?: string | null;
  isHttpBasicAuthEnabled?: boolean;
  httpBasicAuthUsername?: string | null;
  httpBasicAuthPassword?: string | null;
  httpBasicAuthHashAlgorithm?: "bcrypt" | "argon2id";
  httpBasicAuthBcryptCost?: number;
  httpBasicAuthArgon2idMemoryCost?: number;
  httpBasicAuthArgon2idTimeCost?: number;
  supportsArgon2id?: boolean;
  proxyType?: string | null;
  project: { uuid: string; name: string };
  environment: { uuid: string; name: string };
  destination: { uuid: string; name: string; network: string; type: "standalone" | "swarm" } | null;
  server: { uuid: string; name: string; ip: string; isSwarm: boolean } | null;
}

export interface ApplicationShowData {
  application: ApplicationInfo;
  canUpdate: boolean;
  canDeploy: boolean;
}

export const applicationsApi = (orgId: string | undefined) => `/v1/organizations/${orgId ?? ""}/deploy/applications`;
export const applicationPath = (projectUuid: string, environmentUuid: string, applicationUuid: string) =>
  `${environmentPath(projectUuid, environmentUuid)}/application/${applicationUuid}`;

/** The application's uuid from /project/{uuid}/environment/{env_uuid}/application/{app_uuid}/…. */
export function applicationUuidFromPath(pathname = window.location.pathname): string {
  return decodeURIComponent(pathname.split("/")[6] ?? "");
}

/** Str::headline() for a status word ("exited" reads "Exited"). */
const headline = (value: string) =>
  value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");

type Tone = "success" | "warning" | "error";
const DOT: Record<Tone, string> = { success: "bg-success", warning: "bg-warning", error: "bg-error" };

/** <x-status-summary>'s reading of a status ("running:healthy", "exited", "running (unhealthy)"). */
export function statusSummary(status: string): { containerLabel: string; containerType: Tone; healthLabel: string; healthType: Tone; summaryLabel: string; summaryType: Tone } {
  const raw = status.toLowerCase().trim();
  const parts = raw.split(":");
  let container = parts[0] ?? "unknown";
  let health: string | null = parts[1] ?? null;
  const excluded = parts.includes("excluded");
  const paren = health === null ? raw.match(/^([^()]+)\(([^)]+)\)$/) : null;
  if (paren) {
    container = paren[1]!.trim();
    health = paren[2]!.trim();
  }
  const containerLabel = headline(container || "unknown");
  const healthLabel = excluded ? "Monitoring disabled" : health === "healthy" ? "Healthy" : health === "unhealthy" ? "Unhealthy" : health === "starting" ? "Starting" : "Not configured";
  const containerType: Tone = container.startsWith("running") ? "success" : ["starting", "restarting", "degraded"].some((s) => container.startsWith(s)) ? "warning" : "error";
  const healthType: Tone = excluded ? "warning" : health === "healthy" ? "success" : health === "unhealthy" ? "error" : "warning";
  let summary: [string, Tone];
  if (containerType === "error") summary = [containerLabel, "error"];
  else if (container.startsWith("degraded")) summary = ["Degraded", "warning"];
  else if (healthType === "error") summary = ["Degraded", "error"];
  else if (containerType === "warning") summary = [containerLabel, "warning"];
  else if (excluded) summary = [`${containerLabel} (monitoring disabled)`, "warning"];
  else if (health === "starting") summary = [`${containerLabel} (healthcheck starting)`, "warning"];
  else if (healthType === "warning") summary = [`${containerLabel} (no healthcheck)`, "warning"];
  else summary = [containerLabel, "success"];
  return { containerLabel, containerType, healthLabel, healthType, summaryLabel: summary[0], summaryType: summary[1] };
}

/** Closes on a click outside or Escape (Alpine's @click.outside and @keydown.escape.window). */
function useDismiss(open: boolean, close: () => void) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return root;
}

const HIDDEN = { style: { display: "none" as const } };
const HEALTH_HELPER =
  "No healthcheck is configured, so Freeploy can only report the container state. Traffic can still be routed to the container, but Freeploy cannot verify that the application inside it is ready to receive requests.";

/** <x-status-summary>: the status as a badge that opens the container and healthcheck states; `title` heads the panel. */
export function StatusSummary({ status, healthcheckUrl, title = "Application status" }: { status: string; healthcheckUrl: string; title?: string }) {
  const [open, setOpen] = useState(false);
  const root = useDismiss(open, () => setOpen(false));
  const s = statusSummary(status);
  return (
    <div className="relative shrink-0 not-first:ml-1.5" ref={root}>
      <button
        type="button"
        className="inline-flex max-w-full items-center whitespace-nowrap text-neutral-700 dark:text-fg gap-1.5 text-[13px] cursor-pointer"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className={`size-1.5 shrink-0 rounded-full ${DOT[s.summaryType]}`} />
        <span>{s.summaryLabel}</span>
        <span className={`inline-flex transition-transform${open ? " rotate-180" : ""}`}>
          <Reicon name="chevron-down" className="size-3 opacity-55" />
        </span>
      </button>
      <div className="listbox-panel top-8! z-[90]! w-[min(16rem,calc(100vw-1.5rem))]! min-w-0! sm:w-64! sm:min-w-64! right-auto! left-0!" role="menu" {...(open ? {} : HIDDEN)}>
        <div className="px-3 py-2 text-[11px] font-medium text-neutral-400 dark:text-fg-faint">{title}</div>
        <div className="listbox-option cursor-default! gap-2.5!">
          <span className={`size-1.5 shrink-0 rounded-full ${DOT[s.containerType]}`} />
          <span className="flex-1">Container</span>
          <span>{s.containerLabel}</span>
        </div>
        <div className="listbox-option gap-0! p-0!">
          <a href={healthcheckUrl} role="menuitem" className="flex min-h-8 flex-1 items-center gap-2.5 px-2 py-1.5">
            <span className={`size-1.5 shrink-0 rounded-full ${DOT[s.healthType]}`} />
            <span className="flex-1">Healthcheck</span>
            <span>{s.healthLabel}</span>
          </a>
          {s.healthLabel === "Not configured" ? (
            <span className="inline-flex pr-2">
              <Helper label="About unconfigured healthchecks" helper={HEALTH_HELPER} />
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** <x-split-action>: the main action and a caret that opens the others. */
export function SplitAction({ main, onMain, children, id = "application-mobile-actions" }: { main: ReactNode; onMain: () => void; children: (close: () => void) => ReactNode; id?: string }) {
  const [open, setOpen] = useState(false);
  const root = useDismiss(open, () => setOpen(false));
  return (
    <div className="split-action relative" id={id} ref={root}>
      <button type="button" className="split-action-main" onClick={onMain}>
        {main}
      </button>
      <button type="button" className="split-action-caret" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" aria-label="More actions">
        <span className={`inline-flex transition-transform${open ? " rotate-180" : ""}`}>
          <Reicon name="chevron-down" className="size-3" />
        </span>
      </button>
      <div className="listbox-panel right-0! left-auto! xl:min-w-60! xl:max-w-96!" role="menu" {...(open ? {} : HIDDEN)}>
        {children(() => setOpen(false))}
      </div>
    </div>
  );
}

/**
 * <livewire:project.application.heading>: the name, the status, and — for who
 * may deploy — Deploy with "Deploy (without cache)" and the container's
 * removal, or Redeploy, Restart and Stop once the application runs.
 */
export function ApplicationHeading({ application, orgId, canDeploy }: { application: ApplicationInfo; orgId: string | undefined; canDeploy: boolean }) {
  const base = `${applicationsApi(orgId)}/${encodeURIComponent(application.uuid)}`;
  const here = applicationPath(application.project.uuid, application.environment.uuid, application.uuid);
  const [stopRequest, setStopRequest] = useState(0);
  const [restartRequest, setRestartRequest] = useState(0);
  const exited = application.status.startsWith("exited");
  const swarm = application.server?.isSwarm ?? false;

  /** Heading::deploy(), restart() and stop(): the API's answer as a toast. */
  async function run(action: "deploy" | "restart" | "stop", body: Record<string, unknown> = {}) {
    const r = await postJson<{ status?: string; title?: string; message?: string; redirect?: string }>(`${base}/${action}`, body);
    if (!r.ok) return notify.error(summarize(r.error.messages));
    // A queued deployment opens its page; a skipped one says why ('Deployment skipped').
    if (r.data.status === "skipped") return toast(r.data.title ?? "Deployment skipped", { type: "warning", description: r.data.message ?? "" });
    if (r.data.redirect) return window.location.assign(r.data.redirect);
    if (r.data.message) notify.success(r.data.message);
  }

  const item = (key: string, icon: string, iconClass: string, label: string, onClick: () => void) => (
    <button key={key} type="button" className="listbox-option justify-start! gap-2.5!" onClick={onClick} role="menuitem">
      <Reicon name={icon} className={`size-3.5 ${iconClass}`} />
      {label}
    </button>
  );

  return (
    <nav className="w-full max-w-none">
      <ProjectBreadcrumb orgId={orgId} project={application.project} environment={application.environment} />
      <div>
        <div className="mb-3 flex w-full min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-col items-start gap-2">
              <h1 className="min-w-0 max-w-full truncate text-[24px]! leading-7! font-semibold! tracking-tight! text-black dark:text-fg">{application.name}</h1>
              <div className="relative flex w-full min-w-0 items-center gap-2">
                <StatusSummary status={application.status} healthcheckUrl={`${here}/healthcheck`} />
              </div>
            </div>
          </div>

          <div className="shrink-0">
            {canDeploy ? (
              exited ? (
                <SplitAction
                  onMain={() => void run("deploy")}
                  main={
                    <>
                      <Reicon name="play-circle" className="size-3.5" />
                      {application.stoppedAfterRestartLimit ? "Retry deployment" : "Deploy"}
                    </>
                  }
                >
                  {(close) => [
                    swarm
                      ? null
                      : item("no-cache", "refresh", "opacity-70", application.stoppedAfterRestartLimit ? "Retry deployment (without cache)" : "Deploy (without cache)", () => {
                          close();
                          void run("deploy", { force_rebuild: true });
                        }),
                    application.containerPresent !== false
                      ? item("remove", "stop-circle", "text-error", "Remove container", () => {
                          close();
                          setStopRequest((n) => n + 1);
                        })
                      : null,
                  ]}
                </SplitAction>
              ) : (
                <SplitAction
                  onMain={() => void run("deploy")}
                  main={
                    <>
                      <Reicon name="refresh" className="size-3.5" />
                      {swarm ? "Update Service" : "Redeploy"}
                    </>
                  }
                >
                  {(close) => [
                    swarm
                      ? null
                      : item("no-cache", "refresh", "opacity-70", "Redeploy (without cache)", () => {
                          close();
                          void run("deploy", { force_rebuild: true });
                        }),
                    swarm
                      ? null
                      : item("restart", "restart", "opacity-70", "Restart", () => {
                          close();
                          setRestartRequest((n) => n + 1);
                        }),
                    item("stop", "stop-circle", "text-error", "Stop", () => {
                      close();
                      setStopRequest((n) => n + 1);
                    }),
                  ]}
                </SplitAction>
              )
            ) : null}
            {canDeploy ? (
              <div className="hidden" aria-hidden="true">
                <ModalConfirmation
                  title={exited ? "Confirm Container Removal?" : "Confirm Application Stopping?"}
                  trigger={
                    <button id="application-mobile-stop-trigger" type="button">
                      Stop
                    </button>
                  }
                  actions={
                    exited
                      ? ["The exited application container will be removed.", "Anonymous volumes may become eligible for Docker cleanup."]
                      : ["This application will be stopped.", "All non-persistent data of this application will be deleted."]
                  }
                  confirmationText={null}
                  step2ButtonText="Confirm"
                  onSubmit={() => run("stop")}
                  openRequest={stopRequest}
                />
                <ModalConfirmation
                  title="Confirm Application Restart?"
                  trigger={
                    <button id="application-mobile-restart-trigger" type="button">
                      Restart
                    </button>
                  }
                  actions={["This application will be restarted without rebuilding."]}
                  confirmationText={null}
                  step2ButtonText="Confirm"
                  onSubmit={() => run("restart")}
                  openRequest={restartRequest}
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </nav>
  );
}

interface MenuItem {
  label: string;
  /** The route's path below the application ("" for project.application.configuration). */
  path: string;
  icon: string;
  visible?: boolean;
  beta?: boolean;
}

/** $pageSections for project.application.configuration: the cards of the General page. */
const GENERAL_SECTIONS = [
  { id: "application-details-section", label: "Application details" },
  { id: "access-section", label: "Access" },
  { id: "build-pipeline-section", label: "Build & deploy" },
  { id: "container-section", label: "Container" },
];

/**
 * <x-application.configuration-sidebar>: every entry of Coolify's menu, in
 * its groups. Only General is ported; the others link to their Coolify route
 * and land on the not-ported notice. The Terminal and Files entries
 * (canAccessTerminal) show to who may update; the Servers entry has no status
 * badge and the Security entry no dot.
 */
export function ConfigurationSidebar({ application, active, canUpdate }: { application: ApplicationInfo; active: string; canUpdate: boolean }) {
  const [activeSection, setActiveSection] = useState("");
  const swarm = application.server?.isSwarm ?? false;
  const compose = application.buildPack === "dockercompose";
  // git_based(): not a Docker image application (and not one with its own Dockerfile, which Freeploy cannot create yet).
  const gitBased = application.buildPack !== "dockerimage";
  const groups: Array<[string, MenuItem[]]> = [
    [
      "Settings",
      [
        { label: "General", path: "", icon: "settings" },
        { label: "Domains", path: "/domains", icon: "globe" },
        { label: "Environment Variables", path: "/environment-variables", icon: "variables" },
        { label: "Persistent Storage", path: "/persistent-storage", icon: "storages" },
        { label: "Advanced", path: "/advanced", icon: "grid" },
        { label: "Swarm", path: "/swarm", icon: "destinations", visible: swarm },
        { label: "Healthcheck", path: "/healthcheck", icon: "feedback", visible: !compose },
      ],
    ],
    [
      "Observe & troubleshoot",
      [
        { label: "Runtime Logs", path: "/logs", icon: "unordered-list" },
        { label: "Deployment Logs", path: "/deployment", icon: "time-back" },
        { label: "Terminal", path: "/terminal", icon: "browser-terminal", visible: !swarm && canUpdate },
        { label: "Files", path: "/files", icon: "folder", visible: !swarm && canUpdate, beta: true },
        { label: "Metrics", path: "/metrics", icon: "graph" },
        { label: "Analytics", path: "/analytics", icon: "analytics" },
        { label: "Security", path: "/vulnerabilities", icon: "shield-alert" },
      ],
    ],
    [
      "Deploy",
      [
        { label: "Git Source", path: "/source", icon: "sources", visible: gitBased },
        { label: "Servers", path: "/servers", icon: "servers" },
        { label: "Preview Deployments", path: "/preview-deployments", icon: "eye", visible: gitBased || application.buildPack === "dockerimage" },
      ],
    ],
    [
      "Automation",
      [
        { label: "Scheduled Tasks", path: "/scheduled-tasks", icon: "calendar" },
        { label: "Webhooks", path: "/webhooks", icon: "webhook" },
        { label: "Backups", path: "/backups", icon: "database" },
      ],
    ],
    [
      "Operations",
      [
        { label: "Resource Operations", path: "/resource-operations", icon: "server-update" },
        { label: "Maintenance Mode", path: "/maintenance", icon: "bandage" },
        { label: "Resource Limits", path: "/resource-limits", icon: "cpu", visible: !compose },
        { label: "Rollback", path: "/rollback", icon: "time-back" },
        { label: "Tags", path: "/tags", icon: "tags" },
      ],
    ],
    ["Danger Zone", [{ label: "Danger Zone", path: "/danger", icon: "danger" }]],
  ];
  const base = applicationPath(application.project.uuid, application.environment.uuid, application.uuid);
  const entries: ReactNode[] = [];
  let first = true;
  for (const [group, all] of groups) {
    const items = all.filter((i) => i.visible ?? true);
    if (!items.length) continue;
    if (!first) entries.push(<div key={`sep-${group}`} className="my-2 border-t border-neutral-200 dark:border-white/[0.06]" aria-hidden="true" />);
    first = false;
    for (const menuItem of items) {
      const isActive = menuItem.label === active;
      entries.push(
        <div key={menuItem.label}>
          <a className={isActive ? "menu-item menu-item-active" : "menu-item"} href={base + menuItem.path}>
            <Reicon name={menuItem.icon} className="menu-item-icon" />
            <span className="menu-item-label">{menuItem.label}</span>
            {menuItem.beta ? <BetaBadge /> : null}
          </a>
          {isActive && menuItem.label === "General" ? (
            <div className="nav-children flex flex-col gap-0.5 py-1">
              {GENERAL_SECTIONS.filter((s) => !compose || s.id !== "container-section").map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className={activeSection === section.id ? "menu-subitem menu-subitem-active" : "menu-subitem"}
                  onClick={() => {
                    setActiveSection(section.id);
                    history.replaceState(null, "", `#${section.id}`);
                    document.getElementById(section.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  <span className="menu-item-label text-left">{section.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>,
      );
    }
  }
  return (
    <aside className="application-settings-navigation min-w-0">
      <nav aria-label="Configuration sections" className="grid grid-cols-1 gap-0.5">
        {entries}
      </nav>
    </aside>
  );
}

/** configuration.blade.php: the heading, then the settings workspace (menu and content). */
export function ApplicationWorkspace(props: { application: ApplicationInfo; orgId: string | undefined; active: string; canUpdate: boolean; canDeploy: boolean; children: ReactNode }) {
  return (
    <div>
      <ApplicationHeading application={props.application} orgId={props.orgId} canDeploy={props.canDeploy} />
      <section className="application-settings-workspace mt-4 w-full max-w-none lg:mt-0">
        <div className="grid min-w-0 gap-8 xl:grid-cols-[210px_minmax(0,1fr)] xl:gap-8">
          <ConfigurationSidebar application={props.application} active={props.active} canUpdate={props.canUpdate} />
          <div className="min-w-0">{props.children}</div>
        </div>
      </section>
    </div>
  );
}
