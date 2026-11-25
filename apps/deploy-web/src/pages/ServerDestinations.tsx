// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/destinations.blade.php and
// app/Livewire/Server/Destinations.php (Apache-2.0), modified.
//
// /server/{uuid}/destinations: the server's Docker networks, and adding one.
// Scan networks runs `docker network ls` on the server, which needs the SSH
// executor: the API answers that it is not available yet, so the Discovered
// networks card (and its Add destination buttons) never shows. As in Coolify,
// the page asks for validation first when the server is not functional.
import { useEffect, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Button, Empty, ModalInput, SettingsSection } from "../components/Coolify";
import { limit, serverUuidFromPath, ServerWorkspace, type ServerInfo } from "./ServerChrome";
import { NewDestinationForm, SwarmDeprecated, type DestinationInfo } from "./DestinationChrome";

interface ServerDestinations {
  server: ServerInfo;
  destinations: DestinationInfo[];
  newDestination: { name: string; network: string };
  canUpdate: boolean;
}

const HELPER = "Docker networks used to isolate and connect resources on this server.";

function ServerDestinationsContent() {
  const { me } = useSignedIn();
  const uuid = serverUuidFromPath();
  const base = `/v1/organizations/${me.team?.id ?? ""}/deploy/servers/${encodeURIComponent(uuid)}/destinations`;
  const [data, setData] = useState<ServerDestinations | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await getJson<ServerDestinations>(base);
      if (!r.data) {
        // mount(): a server of another team (or none) redirects to the server list.
        if (r.status === 404) window.location.replace("/servers");
        return;
      }
      setData(r.data);
    })();
  }, [base]);
  useEffect(() => {
    if (data) document.title = `${limit(data.server.name, 10)} > Destinations | Freeploy`;
  }, [data]);

  /** Destinations::scan(): not available yet (the error toast says why). */
  async function scan() {
    const r = await postJson<object>(`${base}/scan`, {});
    if (!r.ok) notify.error(summarize(r.error.messages));
  }

  if (!data) return null;
  const { server, destinations, canUpdate } = data;
  const isSwarm = server.isSwarmManager || server.isSwarmWorker;

  return (
    <ServerWorkspace server={server} orgId={me.team?.id} active="destinations" canUpdate={canUpdate}>
      <div className="application-settings-form flex w-full flex-col gap-6">
        {isSwarm ? <SwarmDeprecated /> : null}

        {server.isFunctional ? (
          <SettingsSection
            id="server-destinations-section"
            title="Destinations"
            helper={HELPER}
            flush
            actions={
              <div className="flex items-center gap-2">
                <Button onClick={() => void scan()} disabled={!canUpdate}>
                  <Reicon name="refresh" className="size-3.5" />
                  Scan networks
                </Button>
                {canUpdate ? (
                  <ModalInput
                    title="New Destination"
                    open={newOpen}
                    onOpenChange={setNewOpen}
                    trigger={
                      <button type="button" className="button">
                        + Add
                      </button>
                    }
                  >
                    <NewDestinationForm servers={[{ uuid: server.uuid, name: server.name }]} initial={{ serverUuid: server.uuid, ...data.newDestination }} canCreate={canUpdate} />
                  </ModalInput>
                ) : null}
              </div>
            }
          >
            {destinations.length === 0 ? (
              <Empty size="sm" title="No destinations" description="Add a destination or scan the server for existing Docker networks." iconName="destinations" />
            ) : (
              destinations.map((destination) => (
                <a
                  key={destination.uuid}
                  href={`/destination/${destination.uuid}`}
                  className="flex items-center gap-4 border-b border-neutral-200 px-4 py-3 transition-colors last:border-b-0 hover:bg-neutral-50 dark:border-white/[0.08] dark:hover:bg-white/[0.03]"
                >
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500 dark:bg-white/[0.06] dark:text-fg-dim">
                    <Reicon name="destinations" className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-neutral-950 dark:text-fg">{destination.network}</p>
                    <p className="mt-0.5 text-xs text-neutral-500 dark:text-fg-dim">{destination.typeLabel}</p>
                  </div>
                </a>
              ))
            )}
          </SettingsSection>
        ) : (
          <SettingsSection title="Destinations" helper={HELPER}>
            <Empty size="sm" title="Server validation required" description="Validate this server before managing its destinations." iconName="destinations" />
          </SettingsSection>
        )}
      </div>
    </ServerWorkspace>
  );
}

export function ServerDestinationsPage() {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle="Destinations">
      <ServerDestinationsContent />
    </Layout>
  );
}
