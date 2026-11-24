// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/shared/destination.blade.php and
// app/Livewire/Project/Shared/Destination.php (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/application/{app_uuid}/servers
// (project.application.servers): the application's primary server and
// network, the servers it is also deployed to, and the servers it can be
// added to. The status beside a server is <x-status-summary>'s summary as a
// badge (its popover is the heading's).
import { useEffect, useRef, useState } from "react";
import { Layout } from "../layout/Layout";
import { Reicon } from "../components/Reicon";
import { Button, Callout, Empty, ModalConfirmation, SettingsSection, StatusBadge } from "../components/Coolify";
import { applicationsApi, ApplicationWorkspace, statusSummary } from "./ApplicationChrome";
import { useApplicationSection, type ApplicationSectionData } from "./ApplicationSection";
import { sendJson, showError, showSaved } from "./ApplicationResource";

interface ServerCard {
  networkId: string;
  serverId: string;
  serverUuid: string;
  serverName: string;
  network: string;
  status: string;
}

interface Servers {
  primary: ServerCard | null;
  additional: ServerCard[];
  available: Array<{ networkId: string; serverId: string; serverName: string; name: string }>;
  hasPersistentStorage: boolean;
}

type Data = ApplicationSectionData & Servers;
type Saved = Servers & { unavailable?: string };

const CODE = "rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs text-neutral-700 dark:bg-white/[0.05] dark:text-fg-dim";
const ICON = "flex shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500 ring-1 ring-neutral-200 dark:bg-white/[0.05] dark:text-fg-dim dark:ring-white/[0.07]";

function Status({ status }: { status: string }) {
  const summary = statusSummary(status);
  return <StatusBadge label={summary.summaryLabel} type={summary.summaryType} />;
}

interface Action {
  label: string;
  icon: string;
  iconClass: string;
  run: () => void;
}

/** The "Actions" menu of a server (Alpine's open, @click.outside, @keydown.escape.window). */
function ActionsMenu({ actions }: { actions: Action[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={root}>
      <button type="button" className="button gap-1.5" title="Server actions" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu">
        Actions
        <span className={`inline-flex transition-transform${open ? " rotate-180" : ""}`}>
          <Reicon name="chevron-down" className="size-3 opacity-55" />
        </span>
      </button>
      {open ? (
        <div className="listbox-panel top-full! right-0! left-auto! z-[90]! mt-1! w-52! min-w-52!" role="menu">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className="listbox-option justify-start! gap-2.5!"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                action.run();
              }}
            >
              <Reicon name={action.icon} className={`size-3.5 ${action.iconClass}`} />
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ApplicationServersContent() {
  const { me, data, setData } = useApplicationSection<Data>("servers");
  /** The additional server whose "Remove" dialog was asked for from its menu. */
  const [removing, setRemoving] = useState<{ networkId: string; request: number } | null>(null);
  if (!data) return null;
  const { application, canUpdate, canDeploy } = data;
  const base = `${applicationsApi(me.team?.id)}/${encodeURIComponent(application.uuid)}/servers`;
  const compose = application.buildPack === "dockercompose";

  async function send(method: "POST" | "DELETE", path: string, body?: Record<string, unknown>) {
    const r = await sendJson<Saved>(method, base + path, body);
    if (!r.ok) return showError(r.error);
    setData({ ...data!, primary: r.data.primary, additional: r.data.additional, available: r.data.available, hasPersistentStorage: r.data.hasPersistentStorage });
    showSaved(r.data);
  }
  const deploy = (card: ServerCard): Action => ({ label: "Deploy", icon: "refresh", iconClass: "opacity-70", run: () => void send("POST", `/${card.networkId}/redeploy`, { server_id: card.serverId }) });
  const stop = (card: ServerCard): Action => ({ label: "Stop", icon: "stop-circle", iconClass: "text-error", run: () => void send("POST", "/stop", { server_id: card.serverId }) });
  const running = (card: ServerCard) => card.status.startsWith("running");
  const { primary } = data;

  return (
    <ApplicationWorkspace application={application} orgId={me.team?.id} active="Servers" canUpdate={canUpdate} canDeploy={canDeploy}>
      <div className="flex flex-col gap-6">
        <SettingsSection id="primary-server-section" title="Primary server" helper="The default server and network used for this application's deployments.">
          {primary ? (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <div className={`${ICON} size-10`}>
                  <Reicon name="servers" className="size-5" />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="truncate text-sm font-semibold text-black dark:text-fg">{primary.serverName}</h4>
                    <span className="rounded-sm bg-coollabs/10 px-1.5 py-0.5 text-[11px] font-medium text-coollabs dark:bg-brand/15 dark:text-brand-light">Primary</span>
                    <Status status={primary.status} />
                  </div>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px] text-neutral-500 dark:text-fg-dim">
                    <span>Network</span>
                    <code className={CODE}>{primary.network}</code>
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <a href={`/server/${primary.serverUuid}`} className="button">
                  Open server
                </a>
                {data.additional.length > 0 && canDeploy ? <ActionsMenu actions={[deploy(primary), ...(running(primary) ? [stop(primary)] : [])]} /> : null}
              </div>
            </div>
          ) : null}
        </SettingsSection>

        {data.additional.length > 0 && !compose ? (
          <SettingsSection id="additional-servers-section" title="Additional servers" helper="Deploy this application to more servers and choose which destination is primary." flush>
            <div className="divide-y divide-neutral-200 dark:divide-white/[0.07]">
              {data.additional.map((card) => (
                <div key={card.networkId} className="flex flex-col gap-4 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className={`${ICON} size-9`}>
                      <Reicon name="servers" className="size-[18px]" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="truncate text-sm font-semibold text-black dark:text-fg">{card.serverName}</h4>
                        <Status status={card.status} />
                      </div>
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px] text-neutral-500 dark:text-fg-dim">
                        <span>Network</span>
                        <code className={CODE}>{card.network}</code>
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                    <a href={`/server/${card.serverUuid}`} className="button">
                      Open server
                    </a>
                    {canDeploy ? (
                      <ActionsMenu
                        actions={[
                          deploy(card),
                          ...(canUpdate ? [{ label: "Make primary", icon: "shield-star", iconClass: "opacity-70", run: () => void send("POST", `/${card.networkId}/promote`, { server_id: card.serverId }) }] : []),
                          ...(running(card) ? [stop(card)] : []),
                          ...(canUpdate ? [{ label: "Remove", icon: "trash", iconClass: "text-error", run: () => setRemoving({ networkId: card.networkId, request: (removing?.request ?? 0) + 1 }) }] : []),
                        ]}
                      />
                    ) : null}
                    {canUpdate ? (
                      <div className="hidden" aria-hidden="true">
                        <ModalConfirmation
                          title="Remove server from application?"
                          buttonTitle="Remove"
                          actions={["This will stop the application on this server and remove it as a deployment destination."]}
                          confirmationText={card.serverName}
                          confirmationLabel="Enter the server name to confirm removal"
                          shortConfirmationLabel="Server name"
                          onSubmit={() => send("DELETE", `/${card.networkId}?server_id=${encodeURIComponent(card.serverId)}`)}
                          {...(removing?.networkId === card.networkId ? { openRequest: removing.request } : {})}
                        />
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </SettingsSection>
        ) : null}

        {compose ? null : (
          <SettingsSection id="available-servers-section" title="Add another server" helper="Attach another available server and network as a deployment destination." flush={!data.hasPersistentStorage}>
            {data.hasPersistentStorage ? (
              <Callout type="warning" title="Additional servers are unavailable">
                This application has persistent storage volumes. Applications with persistent storage cannot use multiple servers because those volumes are not shared between hosts.
              </Callout>
            ) : data.available.length > 0 ? (
              <div className="divide-y divide-neutral-200 dark:divide-white/[0.07]">
                {data.available.map((network) => (
                  <div key={network.networkId} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className={`${ICON} size-9`}>
                        <Reicon name="plus" className="size-[18px]" />
                      </div>
                      <div className="min-w-0">
                        <h4 className="truncate text-sm font-semibold text-black dark:text-fg">{network.serverName}</h4>
                        <p className="mt-1 text-[13px] text-neutral-500 dark:text-fg-dim">
                          Network
                          <code className={`ml-1 ${CODE}`}>{network.name}</code>
                        </p>
                      </div>
                    </div>
                    <Button disabled={!canUpdate} onClick={() => void send("POST", "", { network_id: network.networkId, server_id: network.serverId })}>
                      Add server
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <Empty size="sm" title="No servers available" description="Every usable server is already attached, or no additional server networks are configured." iconName="servers" />
            )}
          </SettingsSection>
        )}
      </div>
    </ApplicationWorkspace>
  );
}

export function ApplicationServersPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
      <ApplicationServersContent />
    </Layout>
  );
}
