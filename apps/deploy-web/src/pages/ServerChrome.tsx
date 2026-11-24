// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/navbar.blade.php,
// resources/views/components/server/{sidebar,status-summary}.blade.php and
// resources/views/components/beta-badge.blade.php (Apache-2.0), modified.
//
// What every server page shares: the server in the top bar (with the server
// switcher and the status summary), the mobile title, and the server's
// settings menu. Proxy, Sentinel and the other parts that need a validated
// server stay disabled, as Coolify shows them for a server it has not validated.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";

/** GET /servers/{uuid}: Show's data. */
export interface ServerInfo {
  uuid: string;
  name: string;
  description: string | null;
  ip: string;
  user: string;
  port: number;
  connectionTimeout: number;
  serverTimezone: string;
  wildcardDomain: string | null;
  publicIpv4: string | null;
  publicIpv6: string | null;
  serverRole: "deployment" | "build" | "both";
  isSwarmWorker: boolean;
  isSwarmManager: boolean;
  isCloudflareTunnel: boolean;
  /** Team::usesSwarm() */
  usesSwarm: boolean;
  isFunctional: boolean;
  isTransferredAway: boolean;
  isForceDisabled: boolean;
  isLocalhost: boolean;
  isValidating: boolean;
  sshHostKeyPending: boolean;
  validationLogs: string | null;
  hasServerMetadata: boolean;
  hostingerVirtualMachineId: string | null;
  hasCloudProvider: boolean;
  privateKeyUuid: string | null;
}

/** The server role listbox's options (ByIp and Show). */
export const SERVER_ROLE_OPTIONS = [
  { value: "deployment", label: "Deployments only", description: "Runs your resources. Images are built on a build server." },
  { value: "build", label: "Builds only", description: "Builds images for other servers and runs GitHub Actions runners." },
  { value: "both", label: "Deployments and builds", description: "Builds and runs your resources on this server. Can also run GitHub Actions runners." },
];

export type ServerMenu = "general" | "advanced" | "private-key" | "sentinel" | "swarm" | "docker-cleanup" | "log-drains" | "danger";

/** data_get_str(…)->limit($n): the first n characters and "...". */
export function limit(value: string, n: number): string {
  const chars = [...value];
  return chars.length <= n ? value : `${chars.slice(0, n).join("").trimEnd()}...`;
}

/** The server's uuid from /server/{uuid}/…. */
export function serverUuidFromPath(pathname = window.location.pathname): string {
  return decodeURIComponent(pathname.split("/")[2] ?? "");
}

function BetaBadge() {
  return (
    <span className="inline-flex items-center ml-auto shrink-0">
      <span role="img" aria-label="Beta" data-tooltip="Beta" className="inline-flex items-center justify-center p-0.5 rounded-full cursor-help text-coollabs dark:text-brand-light">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="size-4" aria-hidden="true">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23-.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0 1 12 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5"
          />
        </svg>
      </span>
    </span>
  );
}

/** <x-server.status-summary> for a server whose proxy and Sentinel are not set up: Ready or Unavailable. */
function StatusSummary({ server }: { server: ServerInfo }) {
  const ready = server.isFunctional;
  return (
    <div className="relative shrink-0 not-first:ml-1.5">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded="false"
        className="inline-flex max-w-full items-center whitespace-nowrap text-neutral-700 dark:text-fg gap-1.5 text-[13px] relative isolate before:absolute before:-inset-x-1.5 before:-inset-y-1 before:-z-10 before:rounded-md before:transition-colors hover:before:bg-neutral-100 dark:hover:before:bg-white/[0.07] cursor-pointer"
      >
        <span className={`size-1.5 shrink-0 rounded-full ${ready ? "bg-success" : "bg-error"}`} />
        <span className="truncate">{ready ? "Ready" : "Unavailable"}</span>
        <span className="inline-flex transition-transform">
          <Reicon name="chevron-down" className="size-3 opacity-55" />
        </span>
      </button>
      <div className="listbox-panel top-8! right-auto! left-0! z-[90]! w-64! min-w-64!" role="menu" style={{ display: "none" }}>
        <div className="flex items-center gap-1 px-3 py-2 text-[11px] font-medium text-neutral-400 dark:text-fg-faint">
          <span>System status</span>
        </div>
        <div className="listbox-option cursor-default! gap-2.5!">
          <span className={`size-1.5 shrink-0 rounded-full ${ready ? "bg-success" : "bg-error"}`} />
          <span className="flex-1">Server</span>
          <span>{ready ? "Ready" : "Unavailable"}</span>
        </div>
      </div>
    </div>
  );
}

/** The navbar's server switcher options: the org's servers. */
function useServerOptions(orgId: string | undefined): Array<{ uuid: string; name: string; functional: boolean }> {
  const [options, setOptions] = useState<Array<{ uuid: string; name: string; functional: boolean }>>([]);
  useEffect(() => {
    if (!orgId) return;
    void getJson<{ servers: Array<{ uuid: string; name: string; statusType: string }> }>(`/v1/organizations/${orgId}/deploy/servers`).then((r) =>
      setOptions((r.data?.servers ?? []).map((s) => ({ uuid: s.uuid, name: s.name, functional: s.statusType === "success" }))),
    );
  }, [orgId]);
  return options;
}

/** livewire/server/navbar: the server in the top bar, and below xl the title row. */
export function ServerNavbar({ server, orgId }: { server: ServerInfo; orgId: string | undefined }) {
  const options = useServerOptions(orgId);
  const [search, setSearch] = useState("");
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById("server-topbar-context")), []);
  const href = `/server/${server.uuid}`;
  const topbar = (
    <div data-testid="server-topbar-context" className="flex min-w-0 items-center gap-1 text-[13px]">
      <span className="shrink-0 px-0.5 text-neutral-300 dark:text-fg-faint">/</span>
      <span className="relative flex min-w-0 shrink items-center gap-2 px-1">
        <div className="flex h-8 max-w-56 min-w-0 items-center rounded-md transition-colors hover:bg-neutral-100 xl:max-w-72 dark:hover:bg-white/[0.05]">
          <a href={href} title="Go to server" className="flex h-8 min-w-0 items-center pr-1 pl-2">
            <span className="min-w-0 truncate font-semibold text-black dark:text-fg">{server.name}</span>
          </a>
          <button type="button" className="flex h-8 shrink-0 items-center px-0.5" aria-expanded="false" aria-label="Switch server">
            <svg className="size-4 shrink-0 text-neutral-400 dark:text-fg-faint" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M8 9l4-4 4 4M8 15l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="listbox-panel top-9! left-1! z-[90]! w-64! min-w-0!" style={{ display: "none" }}>
            <div className="border-b border-neutral-200 p-1.5 dark:border-white/[0.08]">
              <div className="relative">
                <Reicon name="search" className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
                <input
                  type="search"
                  placeholder="Filter servers…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="input h-7! w-full rounded-md! border-neutral-200! bg-white! py-0! pr-2! pl-7! text-[11px]! text-black! placeholder:text-neutral-400! dark:border-white/[0.1]! dark:bg-coolgray-100! dark:text-white! dark:placeholder:text-fg-faint!"
                />
              </div>
            </div>
            {options
              .filter((o) => o.name.toLowerCase().includes(search.toLowerCase()))
              .map((o) => (
                <a key={o.uuid} href={`/server/${o.uuid}`} className="listbox-option gap-2.5!">
                  <span className={`size-1.5 shrink-0 rounded-full ${o.functional ? "bg-success" : "bg-error"}`} />
                  <span className="min-w-0 flex-1 truncate">{o.name}</span>
                  {o.uuid === server.uuid ? <Reicon name="check" className="size-3.5 shrink-0 text-black dark:text-fg" /> : null}
                </a>
              ))}
          </div>
        </div>
      </span>
      <StatusSummary server={server} />
    </div>
  );
  return (
    <nav className="w-full max-w-none pb-3 lg:pb-0">
      {slot ? createPortal(topbar, slot) : null}
      <div>
        <div className="mb-3 flex w-full min-w-0 items-start gap-3 xl:hidden">
          <div className="min-w-0 flex-1 lg:hidden">
            <div className="flex min-w-0 flex-col gap-2">
              <h1 data-testid="server-subtitle" className="min-w-0 truncate text-[24px]! leading-7! font-semibold! tracking-tight! text-black dark:text-fg">
                {server.name}
              </h1>
              <div className="flex w-full min-w-0 items-center gap-2">
                <StatusSummary server={server} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
}

interface MenuItem {
  label: string;
  path: string;
  icon: string;
  group: string;
  active?: boolean;
  visible?: boolean;
  disabled?: boolean;
  warning?: boolean;
  beta?: boolean;
}

/** <x-server.sidebar>: the server's settings menu, grouped. */
export function ServerSidebar({ server, active, canUpdate }: { server: ServerInfo; active: ServerMenu; canUpdate: boolean }) {
  const off = !server.isFunctional;
  const canHostResources = server.serverRole !== "build";
  const isSwarm = server.isSwarmManager || server.isSwarmWorker;
  const items: MenuItem[] = [
    { label: "General", path: "", icon: "settings", group: "Settings", active: active === "general" },
    { label: "Advanced", path: "/advanced", icon: "grid", group: "Settings", active: active === "advanced", disabled: off },
    { label: "Private Key", path: "/private-key", icon: "keys", group: "Settings", active: active === "private-key" },
    { label: "Cloud Token", path: "/cloud-provider-token", icon: "subscription", group: "Settings", visible: server.hasCloudProvider },
    { label: "CA Certificate", path: "/ca-certificate", icon: "file", group: "Settings", disabled: off },
    { label: "Security", path: "/security", icon: "shield-alert", group: "Security", visible: canUpdate, warning: server.sshHostKeyPending },
    { label: "Cloudflare Tunnel", path: "/cloudflare-tunnel", icon: "cloudflare", group: "Networking", visible: !server.isLocalhost },
    { label: "Proxy", path: "/proxy", icon: "network", group: "Platform", visible: !server.isSwarmWorker && canHostResources, disabled: off },
    { label: "Sentinel", path: "/sentinel", icon: "shield-star", group: "Platform", active: active === "sentinel", visible: !isSwarm && canHostResources && canUpdate, disabled: off },
    { label: "Resources", path: "/resources", icon: "projects", group: "Platform", disabled: off },
    { label: "Terminal", path: "/terminal", icon: "browser-terminal", group: "Operations", visible: canUpdate, disabled: off },
    { label: "Destinations", path: "/destinations", icon: "destinations", group: "Networking", disabled: off },
    { label: "Swarm", path: "/swarm", icon: "layers", group: "Networking", active: active === "swarm", visible: server.usesSwarm && server.serverRole !== "build" && !server.isCloudflareTunnel },
    { label: "Images", path: "/images", icon: "layers", group: "Operations", disabled: off },
    { label: "Docker Cleanup", path: "/docker-cleanup", icon: "broom", group: "Operations", active: active === "docker-cleanup", disabled: off },
    { label: "GitHub Runners", path: "/github-runners", icon: "play-circle", group: "Operations", visible: !server.isLocalhost, beta: true, disabled: off },
    { label: "Registries", path: "/registries", icon: "layers", group: "Operations", visible: canUpdate, disabled: off },
    { label: "Log Drains", path: "/log-drains", icon: "notifications", group: "Operations", active: active === "log-drains", disabled: off },
    { label: "Metrics", path: "/metrics", icon: "graph", group: "Operations", disabled: off },
    { label: "Analytics", path: "/analytics", icon: "analytics", group: "Operations", visible: !isSwarm && server.serverRole !== "build", disabled: off },
    { label: "Transfer", path: "/transfer", icon: "arrow-right", group: "Operations", visible: !server.isLocalhost && canUpdate, beta: true, disabled: off },
    { label: "Danger Zone", path: "/danger", icon: "danger", group: "Danger Zone", active: active === "danger" },
  ];
  // groupBy('group'): groups in the order of their first item.
  const groups = new Map<string, MenuItem[]>();
  for (const item of items.filter((i) => i.visible ?? true)) groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  const base = `/server/${server.uuid}`;
  const entries: ReactNode[] = [];
  let first = true;
  for (const [group, groupItems] of groups) {
    if (!first) entries.push(<div key={`sep-${group}`} className="my-2 border-t border-neutral-200 dark:border-white/[0.06]" aria-hidden="true" />);
    first = false;
    for (const item of groupItems) {
      entries.push(
        item.disabled ? (
          <span key={item.label} className="menu-item cursor-not-allowed opacity-40" aria-disabled="true" title="Validate the server connection first.">
            <Reicon name={item.icon} className="menu-item-icon" />
            <span className="menu-item-label">{item.label}</span>
          </span>
        ) : (
          <a key={item.label} className={item.active ? "menu-item menu-item-active" : "menu-item"} href={base + item.path}>
            <Reicon name={item.icon} className="menu-item-icon" />
            <span className="menu-item-label">{item.label}</span>
            {item.warning ? <Reicon name="alert-triangle" className="ml-auto size-3.5 shrink-0 text-orange-500 dark:text-warning" /> : item.beta ? <BetaBadge /> : null}
          </a>
        ),
      );
    }
  }
  return (
    <aside className="application-settings-navigation min-w-0">
      <nav aria-label="Server configuration sections" className="grid grid-cols-1 gap-0.5">
        {entries}
      </nav>
    </aside>
  );
}

/** The server page frame: navbar, then the settings workspace (menu and content). */
export function ServerWorkspace({ server, orgId, active, canUpdate, children }: { server: ServerInfo; orgId: string | undefined; active: ServerMenu; canUpdate: boolean; children: ReactNode }) {
  return (
    <div>
      <ServerNavbar server={server} orgId={orgId} />
      <div className="server-settings-workspace application-settings-workspace mt-4 grid w-full max-w-none min-w-0 gap-8 lg:mt-0 xl:grid-cols-[210px_minmax(0,1fr)] xl:gap-8">
        <ServerSidebar server={server} active={active} canUpdate={canUpdate} />
        {children}
      </div>
    </div>
  );
}

/** What a settings page's GET answers: the server for the chrome, the section's settings. */
export interface SectionData<T> {
  server: ServerInfo;
  settings: T;
  canUpdate: boolean;
}

/** What a settings save answers: the saved settings, Coolify's message, and the server action that is not available yet. */
interface Saved<T> {
  settings: T;
  message: string | null;
  unavailable: string | null;
}

/**
 * A server settings page (Advanced, Docker Cleanup, Log Drains, Swarm,
 * Sentinel): its data from /servers/{uuid}/{section} and its <x-slot:title>; save and post
 * show the errors under the fields or as a toast, Coolify's message as a
 * success toast, and an action that needs SSH as an error toast.
 */
export function useServerSection<T, Extra extends object = object>(section: string, title: (serverName: string) => string) {
  const { me } = useSignedIn();
  const uuid = serverUuidFromPath();
  const base = `/v1/organizations/${me.team?.id ?? ""}/deploy/servers/${encodeURIComponent(uuid)}/${section}`;
  const [data, setData] = useState<(SectionData<T> & Extra) | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await getJson<SectionData<T> & Extra>(base);
      if (!r.data) {
        // mount(): a server of another team (or none) redirects to the server list.
        if (r.status === 404) window.location.replace("/servers");
        return;
      }
      setData(r.data);
    })();
  }, [base]);
  useEffect(() => {
    if (data) document.title = title(data.server.name);
  }, [data, title]);

  const send = useCallback(
    async (path: string, body: unknown, method: "POST" | "PATCH"): Promise<T | null> => {
      setSaving(true);
      const r = await postJson<Saved<T>>(base + path, body, method);
      setSaving(false);
      if (!r.ok) {
        const inline: Record<string, string> = {};
        for (const [f, m] of Object.entries(r.error.fields ?? {})) if (m[0]) inline[f] = m[0];
        setErrors(inline);
        // A field the page does not show (logDrain) is a toast, as handleError's dispatch('error').
        if (!Object.keys(inline).length || inline.logDrain) notify.error(inline.logDrain ?? summarize(r.error.messages));
        return null;
      }
      setErrors({});
      setData((d) => (d ? { ...d, settings: r.data.settings } : d));
      if (r.data.message) notify.success(r.data.message);
      if (r.data.unavailable) notify.error(r.data.unavailable);
      return r.data.settings;
    },
    [base],
  );
  const save = useCallback((body: Record<string, unknown>, instantSave = false) => send("", { ...body, ...(instantSave ? { instantSave: true } : {}) }, "PATCH"), [send]);
  const post = useCallback((action: string) => send(`/${action}`, {}, "POST"), [send]);
  return { me, uuid, data, errors, saving, save, post };
}

/** A boolean listbox's value. */
export const yesNo = (v: boolean): string => (v ? "true" : "false");
