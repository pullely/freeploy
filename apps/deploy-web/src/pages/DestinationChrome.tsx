// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/destination/{sidebar,show,resources}.blade.php,
// resources/views/livewire/destination/new/docker.blade.php, resources/views/components/main-nav-menu.blade.php,
// app/Livewire/Destination/New/Docker.php and config/deprecations.php (swarm) (Apache-2.0), modified.
//
// What the destination pages share: the destination's data, its title row,
// its menu (General, Resources, Danger Zone) and the workspace frame; and the
// New Destination form of the destinations list and a server's destinations.
// As the server menu does, the destination menu shows in the page rather than
// inside the main sidebar.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { flashNotice } from "../lib/flash";
import { kebab } from "../lib/kebab";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Callout, DangerCallout, DashboardTitle, FormInput, Listbox } from "../components/Coolify";

/** A destination as the API lists it. */
export interface DestinationInfo {
  uuid: string;
  name: string;
  network: string;
  type: "standalone" | "swarm";
  typeLabel: "Standalone Docker" | "Docker Swarm";
  server: { uuid: string; name: string; ip: string };
}

/** config('deprecations.swarm'), without Coolify's v5 plans (as /server/{uuid}/swarm words it). */
export const SWARM_DEPRECATION =
  "Docker Swarm is deprecated and will be removed. Existing Swarm deployments will continue to work as-is. We do not recommend setting up new Swarm deployments for the time being.";

/** The destination's uuid from /destination/{uuid}/…. */
export function destinationUuidFromPath(pathname = window.location.pathname): string {
  return decodeURIComponent(pathname.split("/")[2] ?? "");
}

/**
 * A destination page's data from /destinations/{uuid}{path}. mount(): a
 * destination of another team (or none) redirects to the destinations list.
 */
export function useDestination<T extends { destination: DestinationInfo; canUpdate: boolean }>(path = "") {
  const { me } = useSignedIn();
  const uuid = destinationUuidFromPath();
  const base = `/v1/organizations/${me.team?.id ?? ""}/deploy/destinations/${encodeURIComponent(uuid)}`;
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    void (async () => {
      const r = await getJson<T>(base + path);
      if (!r.data) {
        if (r.status === 404) window.location.replace("/destinations");
        return;
      }
      setData(r.data);
    })();
  }, [base, path]);
  return { base, data, setData };
}

export type DestinationMenu = "general" | "resources" | "danger";

/** livewire/destination/sidebar: General, Resources (a standalone destination only), Danger Zone. */
export function DestinationSidebar({ destination, active }: { destination: DestinationInfo; active: DestinationMenu }) {
  const base = `/destination/${destination.uuid}`;
  const items: Array<{ label: string; path: string; icon: string; key: DestinationMenu }> = [
    { label: "General", path: "", icon: "settings", key: "general" },
    ...(destination.type === "standalone" ? [{ label: "Resources", path: "/resources", icon: "grid", key: "resources" as const }] : []),
    { label: "Danger Zone", path: "/danger", icon: "danger", key: "danger" },
  ];
  const entries: ReactNode[] = [];
  for (const item of items) {
    if (item.label === "Danger Zone") entries.push(<div key="sep" className="col-span-full my-2 border-t border-neutral-200 dark:border-white/[0.06]" aria-hidden="true" />);
    entries.push(
      <a key={item.label} className={item.key === active ? "menu-item menu-item-active" : "menu-item"} href={base + item.path}>
        <Reicon name={item.icon} className="menu-item-icon" />
        <span className="menu-item-label">{item.label}</span>
      </a>,
    );
  }
  return (
    <aside className="application-settings-navigation min-w-0">
      <nav aria-label="Destination settings" className="grid grid-cols-1 gap-0.5">
        {entries}
      </nav>
    </aside>
  );
}

/** The destination page frame: the title row, then the settings workspace (menu and content). */
export function DestinationWorkspace({ destination, title, subtitle, active, children }: { destination: DestinationInfo; title: string; subtitle: string; active: DestinationMenu; children: ReactNode }) {
  return (
    <div>
      <DashboardTitle title={title} subtitle={subtitle} />
      <section className="application-settings-workspace mt-4 w-full max-w-none lg:mt-0">
        <div className="grid min-w-0 gap-8 xl:grid-cols-[210px_minmax(0,1fr)] xl:gap-8">
          <DestinationSidebar destination={destination} active={active} />
          <div className="min-w-0">{children}</div>
        </div>
      </section>
    </div>
  );
}

/** <x-callout type="warning" title="Docker Swarm support is deprecated">. */
export function SwarmDeprecated({ className = "" }: { className?: string }) {
  return (
    <Callout title="Docker Swarm support is deprecated" className={className}>
      {SWARM_DEPRECATION}
    </Callout>
  );
}

export interface NewDestinationServer {
  uuid: string;
  name: string;
}

/**
 * livewire/destination/new/docker: name, network and server. Choosing another
 * server names the destination again (updatedServerId → generateName). On
 * success Coolify opens the new destination; what the server step could not
 * do yet (creating the network needs SSH) is shown there.
 */
export function NewDestinationForm(props: { servers: NewDestinationServer[]; initial: { serverUuid: string; name: string; network: string }; canCreate: boolean }) {
  const { me } = useSignedIn();
  const [name, setName] = useState(props.initial.name);
  const [network, setNetwork] = useState(props.initial.network);
  const [serverUuid, setServerUuid] = useState(props.initial.serverUuid);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  if (!props.canCreate) {
    return <DangerCallout title="Insufficient Permissions">You don&apos;t have permission to create new destinations. Please contact your team administrator for access.</DangerCallout>;
  }

  function changeServer(uuid: string) {
    setServerUuid(uuid);
    const server = props.servers.find((s) => s.uuid === uuid);
    if (server) setName(kebab(`${server.name}-${network}`));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    const r = await postJson<{ uuid: string; unavailable: string | null }>(
      `/v1/organizations/${me.team?.id ?? ""}/deploy/servers/${encodeURIComponent(serverUuid)}/destinations`,
      { name, network },
    );
    setSaving(false);
    if (!r.ok) {
      const inline: Record<string, string> = {};
      for (const [f, m] of Object.entries(r.error.fields ?? {})) if (m[0]) inline[f] = m[0];
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    if (r.data.unavailable) flashNotice(r.data.unavailable);
    window.location.assign(`/destination/${r.data.uuid}`);
  }

  return (
    <div className="w-full">
      <form className="flex w-full flex-col gap-4" onSubmit={(e) => void submit(e)}>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormInput id="name" label="Name" required value={name} onChange={setName} error={errors.name} />
          <FormInput id="network" label="Network" required value={network} onChange={setNetwork} error={errors.network} />
        </div>
        <Listbox id="serverId" label="Server" required options={props.servers.map((s) => ({ value: s.uuid, label: s.name }))} value={serverUuid} onChange={changeServer} />
        <div className="flex justify-end border-t border-neutral-200 pt-4 dark:border-white/[0.07]">
          <button type="submit" className="button button-highlighted" disabled={saving}>
            Create destination
          </button>
        </div>
      </form>
    </div>
  );
}
