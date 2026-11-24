// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/registries.blade.php and
// app/Livewire/Server/Registries.php (Apache-2.0), modified.
//
// /server/{uuid}/registries: the server's registries card (see
// RegistriesChrome). Reading the logins and logging in run on the server,
// which needs the SSH executor: the card says so until it is deployed.
import { useCallback, useEffect, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson } from "../lib/api";
import { limit, serverUuidFromPath, ServerWorkspace, type ServerInfo } from "./ServerChrome";
import { ServerRegistriesCard, type RegistriesCard, type RegistryProvider } from "./RegistriesChrome";

interface Page {
  server: ServerInfo;
  card: RegistriesCard;
  providers: RegistryProvider[];
  canUpdate: boolean;
}

function ServerRegistriesContent() {
  const { me } = useSignedIn();
  const uuid = serverUuidFromPath();
  const base = `/v1/organizations/${me.team?.id ?? ""}/deploy/servers/${encodeURIComponent(uuid)}/registries`;
  const [page, setPage] = useState<Page | null>(null);

  /** mount() and loadRegistries(). */
  const load = useCallback(async () => {
    const r = await getJson<Page>(base);
    if (!r.data) {
      // mount(): a server of another team (or none) redirects to the server list; so does a denial.
      if (r.status === 404) window.location.replace("/servers");
      return;
    }
    setPage(r.data);
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (page) document.title = `${limit(page.server.name, 10)} > Registries | Freeploy`;
  }, [page]);

  if (!page) return null;

  return (
    <ServerWorkspace server={page.server} orgId={me.team?.id} active="registries" canUpdate={page.canUpdate}>
      <div className="application-settings-form flex w-full flex-col gap-3">
        <ServerRegistriesCard key={`server-registries-${page.server.uuid}`} card={page.card} providers={page.providers} onRefresh={load} />
        <p className="text-[12px] text-neutral-500 dark:text-fg-dim">
          Registry logins are read from the Docker config that deployments use. Use <b>Log in</b>, or run <code>docker login &lt;registry&gt;</code> on the server.
        </p>
      </div>
    </ServerWorkspace>
  );
}

export function ServerRegistriesPage() {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle="Registries">
      <ServerRegistriesContent />
    </Layout>
  );
}
