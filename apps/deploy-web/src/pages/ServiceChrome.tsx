// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/service/{configuration,heading}.blade.php,
// resources/views/components/service/configuration-sidebar.blade.php and
// resources/views/components/{status-summary,split-action}.blade.php (Apache-2.0), modified.
//
// What every page of a service shares: the heading (name, status, Deploy — or Restart and Stop once it runs)
// and the configuration menu with every entry of Coolify's sidebar. General, Environment Variables,
// Persistent Storage, Tags and the Danger Zone are ported; the other entries link to their Coolify route and
// land on the not-ported notice. Every action of the heading runs on the server: the API answers "not
// available yet" and the toast says so.
import { useState, type ReactNode } from "react";
import { postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { ModalConfirmation } from "../components/Coolify";
import { ProjectBreadcrumb } from "./ProjectChrome";
import { SplitAction, StatusSummary } from "./ApplicationChrome";
import { BetaBadge } from "./ServerChrome";
import { servicePath, servicesApi } from "../lib/service-templates";

/** One application or database of the service, as the frame lists it. */
export interface ServicePartSummary {
  kind: "application" | "database";
  uuid: string;
  name: string;
  /** Str::headline(human_name ?? name) */
  displayName: string;
  humanName: string | null;
  description: string | null;
  image: string | null;
  status: string;
  fqdn: string | null;
  excludeFromStatus: boolean;
  isRemovedFromCompose: boolean;
  isMigrated: boolean;
}

/** The service as every page of it reads it (GET …/services/{uuid}/configuration, and each page's `service`). */
export interface ServiceInfo {
  uuid: string;
  name: string;
  description: string | null;
  serviceType: string | null;
  project: { uuid: string; name: string };
  environment: { uuid: string; name: string };
  server: { uuid: string; name: string; isFunctional: boolean } | null;
  destination: { uuid: string; name: string; network: string } | null;
  status: string;
  isDeployable: boolean;
  documentation: string | null;
  composeParsingVersion: string;
  applications: ServicePartSummary[];
  databases: ServicePartSummary[];
}

export const serviceApi = (orgId: string | undefined, uuid: string) => `${servicesApi(orgId)}/${encodeURIComponent(uuid)}`;

/** __('resource.docker_cleanup') */
const DOCKER_CLEANUP = "Run Docker Cleanup (remove unused images and builder cache).";

/** <livewire:project.service.heading>: the name, the status and, for who may deploy, the service's actions. */
export function ServiceHeading({ service, orgId, canDeploy }: { service: ServiceInfo; orgId: string | undefined; canDeploy: boolean }) {
  const base = serviceApi(orgId, service.uuid);
  const here = servicePath(service.project.uuid, service.environment.uuid, service.uuid);
  const [busy, setBusy] = useState(false);
  const [restartRequest, setRestartRequest] = useState(0);
  const [stopRequest, setStopRequest] = useState(0);
  const running = service.status.includes("running") || service.status.includes("degraded");

  /** Heading::start(), forceDeploy(), restart(), pullAndRestartEvent() and stop(): the API's answer as a toast. */
  async function run(action: "start" | "force-deploy" | "restart" | "pull-restart" | "stop") {
    setBusy(true);
    const r = await postJson<{ message?: string }>(`${base}/actions/${action}`, {});
    setBusy(false);
    if (!r.ok) return notify.error(summarize(r.error.messages));
    if (r.data.message) notify.success(r.data.message);
  }

  const item = (label: string, icon: string, onClick: () => void, close: () => void, danger = false) => (
    <button
      type="button"
      className="listbox-option justify-start! gap-2.5!"
      role="menuitem"
      onClick={() => {
        close();
        onClick();
      }}
    >
      <Reicon name={icon} className={danger ? "size-3.5 text-error" : "size-3.5 opacity-70"} />
      {label}
    </button>
  );

  return (
    <nav className="w-full max-w-none">
      <ProjectBreadcrumb orgId={orgId} project={service.project} environment={service.environment} />
      <div className="mb-3 flex w-full min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-col items-start gap-2">
            <h1 className="min-w-0 max-w-full truncate text-[24px]! leading-7! font-semibold! tracking-tight! text-black dark:text-fg">{service.name}</h1>
            <div className="relative flex w-full min-w-0 items-center gap-2">
              <StatusSummary status={service.status} title="Service status" healthcheckUrl={here} />
            </div>
          </div>
        </div>
        <div className="shrink-0">
          {canDeploy ? (
            service.isDeployable ? (
              running ? (
                <SplitAction
                  id="service-mobile-actions"
                  onMain={() => (busy ? undefined : setRestartRequest((n) => n + 1))}
                  main={
                    <>
                      <Reicon name="restart" className="size-3.5" />
                      <span>{busy ? "Restarting…" : "Restart"}</span>
                    </>
                  }
                >
                  {(close) => (
                    <>
                      {service.status.includes("running") ? item("Restart (pull latest)", "refresh", () => void run("pull-restart"), close) : null}
                      {service.status.includes("degraded") ? item("Force Restart", "refresh", () => void run("force-deploy"), close) : null}
                      {item("Stop", "stop-circle", () => setStopRequest((n) => n + 1), close, true)}
                    </>
                  )}
                </SplitAction>
              ) : (
                <SplitAction
                  id="service-mobile-actions"
                  onMain={() => (busy ? undefined : void run("start"))}
                  main={
                    <>
                      <Reicon name="play-circle" className="size-3.5" />
                      <span>{busy ? "Deploying…" : "Deploy"}</span>
                    </>
                  }
                >
                  {(close) => (
                    <>
                      {item("Force Deploy", "refresh", () => void run("force-deploy"), close)}
                      {item("Force Cleanup Containers", "trash", () => void run("stop"), close)}
                    </>
                  )}
                </SplitAction>
              )
            ) : (
              <a className="button gap-1.5" href={`${here}/environment-variables`}>
                <Reicon name="play-circle" className="size-3.5 opacity-70" />
                <span>Deploy (missing required env vars)</span>
              </a>
            )
          ) : null}
          {canDeploy && service.isDeployable ? (
            <div className="hidden" aria-hidden="true">
              <ModalConfirmation
                title="Confirm Service Restart?"
                buttonTitle="Restart"
                trigger={
                  <button id="service-restart-trigger" type="button">
                    Restart
                  </button>
                }
                actions={["This service will be restarted."]}
                confirmationText={null}
                step2ButtonText="Confirm"
                onSubmit={() => run("restart")}
                openRequest={restartRequest}
              />
              <ModalConfirmation
                title="Confirm Service Stopping?"
                buttonTitle="Stop"
                trigger={
                  <button id="service-stop-trigger" type="button">
                    Stop
                  </button>
                }
                checkboxes={[{ id: "docker_cleanup", label: DOCKER_CLEANUP, checked: true }]}
                actions={["This service will be stopped.", "All non-persistent data will be deleted."]}
                confirmationText={null}
                step2ButtonText="Confirm"
                onSubmit={() => run("stop")}
                openRequest={stopRequest}
              />
            </div>
          ) : null}
        </div>
      </div>
    </nav>
  );
}

interface MenuItem {
  label: string;
  /** The route's path below the service ("" for project.service.configuration). */
  path: string;
  icon: string;
  visible?: boolean;
  beta?: boolean;
  warning?: boolean;
}

/**
 * <x-service.configuration-sidebar>: every entry of Coolify's menu, in its groups. Terminal and Files
 * (canAccessTerminal) show to who may update; the Security entry has no dot. On Persistent Storage, each
 * application and database is a sub-entry that scrolls to its section.
 */
export function ServiceConfigurationSidebar({ service, active, canUpdate }: { service: ServiceInfo; active: string; canUpdate: boolean }) {
  const [activeSection, setActiveSection] = useState("");
  const groups: Array<[string, MenuItem[]]> = [
    [
      "Settings",
      [
        { label: "General", path: "", icon: "settings" },
        { label: "Domains", path: "/domains", icon: "globe" },
        { label: "Environment Variables", path: "/environment-variables", icon: "variables", warning: !service.isDeployable },
        { label: "Persistent Storage", path: "/storages", icon: "storages" },
      ],
    ],
    [
      "Observe & troubleshoot",
      [
        { label: "Runtime Logs", path: "/logs", icon: "unordered-list" },
        { label: "Terminal", path: "/terminal", icon: "browser-terminal", visible: canUpdate },
        { label: "Files", path: "/files", icon: "folder", visible: canUpdate, beta: true },
        { label: "Analytics", path: "/analytics", icon: "analytics" },
        { label: "Security", path: "/vulnerabilities", icon: "shield-alert" },
      ],
    ],
    [
      "Automation",
      [
        { label: "Scheduled Tasks", path: "/scheduled-tasks", icon: "calendar" },
        { label: "Webhooks", path: "/webhooks", icon: "webhook" },
        { label: "Backups", path: "/storage-backups", icon: "database" },
      ],
    ],
    [
      "Operations",
      [
        { label: "Resource Operations", path: "/resource-operations", icon: "server-update" },
        { label: "Maintenance Mode", path: "/maintenance", icon: "bandage" },
        { label: "Tags", path: "/tags", icon: "tags" },
      ],
    ],
    ["Danger Zone", [{ label: "Danger Zone", path: "/danger", icon: "danger" }]],
  ];
  const storageSections = [...service.applications, ...service.databases].map((part) => ({ id: `storage-service-${part.uuid}`, label: part.displayName }));
  const base = servicePath(service.project.uuid, service.environment.uuid, service.uuid);
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
            {menuItem.warning ? <span className="ml-auto size-2 shrink-0 rounded-full bg-error" title="Required environment variables missing" /> : null}
          </a>
          {isActive && menuItem.label === "Persistent Storage" && storageSections.length ? (
            <div className="nav-children flex flex-col gap-0.5 py-1">
              {storageSections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className={activeSection === section.id ? "menu-subitem menu-subitem-active" : "menu-subitem"}
                  onClick={() => {
                    setActiveSection(section.id);
                    document.getElementById(section.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  <span className="menu-item-label truncate text-left" title={section.label}>
                    {section.label}
                  </span>
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
      <nav aria-label="Service settings" className="grid grid-cols-1 gap-0.5">
        {entries}
      </nav>
    </aside>
  );
}

/** configuration.blade.php: the heading, then the settings workspace (menu and content). */
export function ServiceWorkspace(props: { service: ServiceInfo; orgId: string | undefined; active: string; canUpdate: boolean; children: ReactNode }) {
  return (
    <div>
      <ServiceHeading service={props.service} orgId={props.orgId} canDeploy={props.canUpdate} />
      <section className="application-settings-workspace mt-4 w-full max-w-none lg:mt-0">
        <div className="grid min-w-0 gap-8 xl:grid-cols-[210px_minmax(0,1fr)] xl:gap-8">
          <ServiceConfigurationSidebar service={props.service} active={props.active} canUpdate={props.canUpdate} />
          <div className="min-w-0">{props.children}</div>
        </div>
      </section>
    </div>
  );
}
