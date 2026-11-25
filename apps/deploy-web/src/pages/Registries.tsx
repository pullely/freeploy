// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/docker-registries.blade.php and
// app/Livewire/Server/DockerRegistries.php (Apache-2.0), modified.
//
// /registries: the registry logins of every server of the org, a card per
// server. Coolify loads each card lazily (a skeleton first); here the cards
// come in one answer, and Refresh reads them again. As in Coolify the page is
// for who may update the servers; Coolify answers anyone else with its 403
// page, here the page stays empty with an error toast.
import { useCallback, useEffect, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson } from "../lib/api";
import { notify } from "../lib/toast";
import { Empty, ModalInput } from "../components/Coolify";
import { RegistryLoginForm, ServerRegistriesCard, type RegistriesCard, type RegistryProvider } from "./RegistriesChrome";

interface Overview {
  servers: RegistriesCard[];
  providers: RegistryProvider[];
}

function RegistriesContent() {
  const { me } = useSignedIn();
  const base = `/v1/organizations/${me.team?.id ?? ""}/deploy/registries`;
  const [data, setData] = useState<Overview | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);

  const load = useCallback(async () => {
    const r = await getJson<Overview>(base);
    if (!r.data) {
      // abort_unless(auth()->user()?->isAdmin(), 403): the API answers a denial with 404, shown as a toast.
      if (r.status !== 401) notify.error("Failed to load registries.");
      return;
    }
    setData(r.data);
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return null;
  const { servers, providers } = data;

  return (
    <div className="w-full">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="min-w-0 text-[24px]! leading-7! font-semibold! tracking-tight!">Docker Registries</h1>
          <p className="text-[12px] text-neutral-500 dark:text-fg-dim">
            Registry logins on each server, read from the Docker config that deployments use. Use <b>Multi-server login</b>, or run <code>docker login &lt;registry&gt;</code> on a server.
          </p>
        </div>
        {servers.length > 0 ? (
          <ModalInput
            title="Log in on multiple servers"
            subtitle="Runs docker login on each server that you choose."
            open={loginOpen}
            onOpenChange={setLoginOpen}
            trigger={
              <button type="button" className="button button-highlighted">
                Multi-server login
              </button>
            }
          >
            {/* availableServers(): the functional ones. */}
            <RegistryLoginForm
              server={null}
              servers={servers.filter((s) => s.isFunctional)}
              providers={providers}
              onDone={() => {
                setLoginOpen(false);
                void load();
              }}
            />
          </ModalInput>
        ) : null}
      </div>

      {servers.length === 0 ? (
        <Empty title="No servers yet" description="Add a server to manage its Docker registry logins." iconName="servers" />
      ) : (
        <div className="flex flex-col gap-4">
          {servers.map((server) => (
            <ServerRegistriesCard key={`docker-registries-${server.uuid}`} card={server} providers={providers} onRefresh={load} />
          ))}
        </div>
      )}
    </div>
  );
}

export function RegistriesPage() {
  return (
    <Layout title="Docker Registries" href="/registries" documentTitle="Docker Registries">
      <RegistriesContent />
    </Layout>
  );
}
