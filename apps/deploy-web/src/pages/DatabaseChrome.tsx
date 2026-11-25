// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/database/{configuration,heading}.blade.php,
// resources/views/components/database/configuration-sidebar.blade.php and
// resources/views/components/{status-summary,split-action}.blade.php (Apache-2.0), modified.
//
// What every page of a standalone database shares: the heading (name, status,
// Start — or Restart with Stop once it runs) and the configuration menu.
// Coolify shows the heading's actions in the top bar from xl and the menu
// inside the main sidebar; here both stay in the page, as the application
// pages do. Start, Restart and Stop need the SSH executor: the API answers
// "not available yet" and the toast says so.
import { useState, type ReactNode } from "react";
import { postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { ModalConfirmation, StatusBadge } from "../components/Coolify";
import { environmentPath, ProjectBreadcrumb } from "./ProjectChrome";
import { SplitAction, StatusSummary } from "./ApplicationChrome";
import { BetaBadge } from "./ServerChrome";

export type DatabaseEngine = "postgresql" | "redis" | "mongodb" | "mysql" | "mariadb" | "keydb" | "dragonfly" | "clickhouse";

export interface InitScript {
  index: number;
  filename: string;
  content: string;
}

export interface DatabaseSsl {
  enabled: boolean;
  mode: string | null;
  modes: Array<{ value: string; label: string }> | null;
  modeHelper: string | null;
  certificateValidUntil: string | null;
}

/** GET /databases/{uuid}: the database as its configuration pages read it. */
export interface DatabaseInfo {
  uuid: string;
  name: string;
  description: string | null;
  engine: DatabaseEngine;
  databaseType: string;
  status: string;
  startedAt: string | null;
  image: string;
  portsMappings: string | null;
  isPublic: boolean;
  publicPort: number | null;
  publicPortTimeout: number | null;
  isLogDrainEnabled: boolean;
  customDockerRunOptions: string | null;
  /** The engine's own properties: credentials and configuration. */
  fields: Record<string, string | null>;
  initScripts: InitScript[] | null;
  redis: { version: string; hasUsername: boolean; isPasswordLocked: boolean; isUsernameShared: boolean; isPasswordShared: boolean } | null;
  isPasswordHiddenForMember: boolean;
  urlLabel: string;
  dbUrl: string | null;
  dbUrlPublic: string | null;
  isCredentialLocked: boolean;
  showPublicUrlPlaceholder: boolean;
  ssl: DatabaseSsl | null;
  backups: boolean;
  serverStatus: boolean;
  project: { uuid: string; name: string };
  environment: { uuid: string; name: string };
  destination: { uuid: string; name: string; network: string; type: "standalone" | "swarm" } | null;
  server: { uuid: string; name: string; ip: string; isSwarm: boolean } | null;
}

export interface DatabaseShowData {
  database: DatabaseInfo;
  canUpdate: boolean;
  canManage: boolean;
  canDelete: boolean;
}

export const databasesApi = (orgId: string | undefined) => `/v1/organizations/${orgId ?? ""}/deploy/databases`;
export const databasePath = (projectUuid: string, environmentUuid: string, databaseUuid: string) => `${environmentPath(projectUuid, environmentUuid)}/database/${databaseUuid}`;

/** The database's uuid from /project/{uuid}/environment/{env_uuid}/database/{db_uuid}/…. */
export function databaseUuidFromPath(pathname = window.location.pathname): string {
  return decodeURIComponent(pathname.split("/")[6] ?? "");
}

/** __('resource.docker_cleanup') */
const DOCKER_CLEANUP = "Run Docker Cleanup (remove unused images and builder cache).";

/**
 * <livewire:project.database.heading>: the name, the status, and — for who
 * may manage the database, while its server is functional — Start, or
 * Restart with Stop once the database is not exited.
 */
export function DatabaseHeading({ database, orgId, canManage }: { database: DatabaseInfo; orgId: string | undefined; canManage: boolean }) {
  const base = `${databasesApi(orgId)}/${encodeURIComponent(database.uuid)}`;
  const here = databasePath(database.project.uuid, database.environment.uuid, database.uuid);
  const [busy, setBusy] = useState<"start" | "restart" | null>(null);
  const [stopRequest, setStopRequest] = useState(0);
  const [restartRequest, setRestartRequest] = useState(0);
  const exited = database.status.startsWith("exited");

  /** Heading::start(), restart() and stop(): the API's answer as a toast. */
  async function run(action: "start" | "restart" | "stop", body: Record<string, unknown> = {}) {
    if (action !== "stop") setBusy(action);
    const r = await postJson<{ message?: string }>(`${base}/${action}`, body);
    setBusy(null);
    if (!r.ok) return notify.error(summarize(r.error.messages));
    if (r.data.message) notify.success(r.data.message);
  }

  return (
    <nav className="w-full max-w-none">
      <ProjectBreadcrumb orgId={orgId} project={database.project} environment={database.environment} />
      <div>
        <div className="mb-3 flex w-full min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-col items-start gap-2">
              <h1 className="min-w-0 max-w-full truncate text-[24px]! leading-7! font-semibold! tracking-tight! text-black dark:text-fg">{database.name}</h1>
              <div className="relative flex w-full min-w-0 items-center gap-2">
                <StatusSummary status={database.status} title="Database status" healthcheckUrl={`${here}/healthcheck`} />
              </div>
            </div>
          </div>

          <div className="shrink-0">
            {database.serverStatus ? (
              canManage ? (
                exited ? (
                  // <x-split-action> without a menu: the main action alone, no caret.
                  <div className="split-action relative" id="database-mobile-actions">
                    <button type="button" className="split-action-main" disabled={busy !== null} onClick={() => void run("start")}>
                      <Reicon name="play-circle" className="size-3.5" />
                      <span>{busy === "start" ? "Starting…" : "Start"}</span>
                    </button>
                  </div>
                ) : (
                  <SplitAction
                    id="database-mobile-actions"
                    onMain={() => (busy ? undefined : setRestartRequest((n) => n + 1))}
                    main={
                      <>
                        <Reicon name="restart" className="size-3.5" />
                        <span>{busy === "restart" ? "Restarting…" : "Restart"}</span>
                      </>
                    }
                  >
                    {(close) => (
                      <button
                        type="button"
                        className="listbox-option justify-start! gap-2.5!"
                        onClick={() => {
                          close();
                          setStopRequest((n) => n + 1);
                        }}
                        role="menuitem"
                      >
                        <Reicon name="stop-circle" className="size-3.5 text-error" />
                        Stop
                      </button>
                    )}
                  </SplitAction>
                )
              ) : null
            ) : (
              <StatusBadge label="Server unavailable" type="error" />
            )}
            {database.serverStatus && canManage ? (
              <div className="hidden" aria-hidden="true">
                <ModalConfirmation
                  title="Confirm Database Restart?"
                  trigger={
                    <button id="database-restart-trigger" type="button">
                      Restart
                    </button>
                  }
                  actions={["This database will be unavailable during the restart.", "If the database is currently in use, data could be lost."]}
                  confirmationText={null}
                  step2ButtonText="Restart Database"
                  onSubmit={() => run("restart")}
                  openRequest={restartRequest}
                />
                <ModalConfirmation
                  title="Confirm Database Stopping?"
                  trigger={
                    <button id="database-stop-trigger" type="button">
                      Stop
                    </button>
                  }
                  checkboxes={[{ id: "docker_cleanup", label: DOCKER_CLEANUP, checked: true }]}
                  actions={["This database will be stopped.", "If the database is currently in use, data could be lost.", "Non-persistent containers, networks, and unused images will be removed."]}
                  confirmationText={null}
                  step2ButtonText="Confirm"
                  onSubmit={(selected) => run("stop", { docker_cleanup: selected.includes("docker_cleanup") })}
                  openRequest={stopRequest}
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
  /** The route's path below the database ("" for project.database.configuration). */
  path: string;
  icon: string;
  visible?: boolean;
  beta?: boolean;
}

/** $pageSections for project.database.configuration: the cards of the General page. */
export function generalSections(database: DatabaseInfo): Array<{ id: string; label: string }> {
  return [
    { id: "database-details-section", label: "Database details" },
    { id: "access-section", label: "Access" },
    { id: "container-section", label: "Container" },
    ...(database.databaseType === "standalone-postgresql" ? [{ id: "initialization-scripts-section", label: "Initialization scripts" }] : []),
  ];
}

/**
 * <x-database.configuration-sidebar>: every entry of Coolify's menu, in its
 * groups. General and the pages that are Coolify's shared components
 * (DatabaseSharedPages.tsx) are ported; the others link to their Coolify
 * route and land on the not-ported notice. Backups shows where the engine has a backup
 * solution; the Terminal and Files entries (canAccessTerminal) show to who
 * may update; the Security entry has no dot.
 */
export function DatabaseConfigurationSidebar({ database, active, canUpdate }: { database: DatabaseInfo; active: string; canUpdate: boolean }) {
  const [activeSection, setActiveSection] = useState("");
  const groups: Array<[string, MenuItem[]]> = [
    [
      "Settings",
      [
        { label: "General", path: "", icon: "settings" },
        { label: "Environment Variables", path: "/environment-variables", icon: "variables" },
        { label: "Persistent Storage", path: "/persistent-storage", icon: "storages" },
        { label: "Healthcheck", path: "/healthcheck", icon: "feedback" },
      ],
    ],
    [
      "Observe & troubleshoot",
      [
        { label: "Runtime Logs", path: "/logs", icon: "unordered-list" },
        { label: "Terminal", path: "/terminal", icon: "browser-terminal", visible: canUpdate },
        { label: "Files", path: "/files", icon: "folder", visible: canUpdate, beta: true },
        { label: "Metrics", path: "/metrics", icon: "graph" },
        { label: "Security", path: "/vulnerabilities", icon: "shield-alert" },
      ],
    ],
    ["Deploy", [{ label: "Servers", path: "/servers", icon: "servers" }]],
    [
      "Automation",
      [
        { label: "Webhooks", path: "/webhooks", icon: "webhook" },
        { label: "Backups", path: "/backups", icon: "database", visible: database.backups },
      ],
    ],
    [
      "Operations",
      [
        { label: "Resource Operations", path: "/resource-operations", icon: "server-update" },
        { label: "Resource Limits", path: "/resource-limits", icon: "cpu" },
        { label: "Tags", path: "/tags", icon: "tags" },
      ],
    ],
    ["Danger Zone", [{ label: "Danger Zone", path: "/danger", icon: "danger" }]],
  ];
  const base = databasePath(database.project.uuid, database.environment.uuid, database.uuid);
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
              {generalSections(database).map((section) => (
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
      <nav aria-label="Database settings" className="grid grid-cols-1 gap-0.5">
        {entries}
      </nav>
    </aside>
  );
}

/** configuration.blade.php: the heading, then the settings workspace (menu and content). */
export function DatabaseWorkspace(props: { database: DatabaseInfo; orgId: string | undefined; active: string; canUpdate: boolean; canManage: boolean; children: ReactNode }) {
  return (
    <div>
      <DatabaseHeading database={props.database} orgId={props.orgId} canManage={props.canManage} />
      <section className="application-settings-workspace mt-4 w-full max-w-none lg:mt-0">
        <div className="grid min-w-0 gap-8 xl:grid-cols-[210px_minmax(0,1fr)] xl:gap-8">
          <DatabaseConfigurationSidebar database={props.database} active={props.active} canUpdate={props.canUpdate} />
          <div className="min-w-0">{props.children}</div>
        </div>
      </section>
    </div>
  );
}
