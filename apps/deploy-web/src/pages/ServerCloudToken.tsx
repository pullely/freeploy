// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/cloud-provider-token/show.blade.php and
// app/Livewire/Server/CloudProviderToken/Show.php (Apache-2.0), modified.
//
// /server/{uuid}/cloud-provider-token: which of the org's cloud provider
// tokens manages this server. A newly chosen token is checked with the
// provider (it must work, and reach this very server) before it is stored.
import { useCallback, useEffect, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { ago } from "../lib/ago";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Button, Empty, ModalInput, SettingsSection, StatusBadge } from "../components/Coolify";
import { CloudTokenForm } from "./CloudTokenEditor";
import { limit, serverUuidFromPath, ServerWorkspace, type ServerInfo } from "./ServerChrome";

interface TokenItem {
  uuid: string;
  name: string;
  description: string | null;
  createdAt: string | null;
  active: boolean;
}

interface Page {
  server: ServerInfo;
  provider: string;
  providerName: string;
  hasCloudProvider: boolean;
  tokens: TokenItem[];
  canUpdate: boolean;
  canCreateToken: boolean;
}

function ServerCloudTokenContent() {
  const { me } = useSignedIn();
  const uuid = serverUuidFromPath();
  const orgBase = `/v1/organizations/${me.team?.id ?? ""}/deploy`;
  const base = `${orgBase}/servers/${encodeURIComponent(uuid)}/cloud-provider-token`;
  const [page, setPage] = useState<Page | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  /** mount() + loadTokens(). */
  const load = useCallback(async () => {
    const r = await getJson<Page>(base);
    if (!r.data) {
      if (r.status === 404) window.location.replace("/servers");
      return;
    }
    setPage(r.data);
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (page) document.title = `${limit(page.server.name, 10)} > Cloud Token | Freeploy`;
  }, [page]);

  async function setCloudProviderToken(tokenUuid: string) {
    const r = await postJson<{ message: string }>(base, { cloud_provider_token_uuid: tokenUuid }, "PATCH");
    if (!r.ok) return notify.error(summarize(r.error.messages));
    notify.success(r.data.message);
    await load();
  }

  async function validateToken() {
    const r = await postJson<{ valid: boolean; message: string }>(`${base}/validate`, {});
    if (!r.ok) return notify.error(summarize(r.error.messages));
    if (r.data.valid) notify.success(r.data.message);
    else notify.error(r.data.message);
  }

  if (!page) return null;
  const { server, providerName, canUpdate } = page;
  return (
    <ServerWorkspace server={server} orgId={me.team?.id} active="cloud-provider-token" canUpdate={canUpdate}>
      <div className="application-settings-form w-full">
        {page.hasCloudProvider ? (
          <SettingsSection
            id="server-cloud-token-section"
            title={`${providerName} token`}
            helper="Choose the cloud credential used to manage this server."
            flush
            actions={
              <div className="flex items-center gap-2">
                <Button disabled={!canUpdate} onClick={() => void validateToken()}>
                  <Reicon name="refresh" className="size-3.5" />
                  Validate token
                </Button>
                {page.canCreateToken ? (
                  <ModalInput
                    title={`Add ${providerName} Token`}
                    open={addOpen}
                    onOpenChange={setAddOpen}
                    trigger={
                      <button className="button" type="button">
                        + Add
                      </button>
                    }
                  >
                    <CloudTokenForm
                      base={`${orgBase}/cloud-tokens`}
                      provider={page.provider}
                      onAdded={() => {
                        // tokenAdded.{provider} → handleTokenAdded() → loadTokens(), and close-modal.
                        setAddOpen(false);
                        void load();
                      }}
                    />
                  </ModalInput>
                ) : null}
              </div>
            }
          >
            {page.tokens.length === 0 ? (
              <Empty size="sm" title={`No ${providerName} tokens`} description={`Add a token to manage this server through ${providerName}.`} iconName="keys" />
            ) : (
              page.tokens.map((token) => (
                <div key={token.uuid} className="flex items-center gap-4 border-b border-neutral-200 px-4 py-3 last:border-b-0 dark:border-white/[0.08]">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500 dark:bg-white/[0.06] dark:text-fg-dim">
                    <Reicon name="keys" className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium text-neutral-950 dark:text-fg">{token.name}</p>
                      {token.active ? <StatusBadge label="Active" type="success" /> : null}
                    </div>
                    <p className="mt-0.5 text-xs text-neutral-500 dark:text-fg-dim">{token.description || (token.createdAt ? `Created ${ago(token.createdAt)}` : "Created")}</p>
                  </div>
                  {!token.active ? (
                    <Button disabled={!canUpdate} onClick={() => void setCloudProviderToken(token.uuid)}>
                      Use this token
                    </Button>
                  ) : null}
                </div>
              ))
            )}
          </SettingsSection>
        ) : (
          <SettingsSection title="Cloud token" helper="Cloud credentials are available for servers created through a supported provider.">
            <Empty
              size="sm"
              title="No cloud provider integration"
              description="This server was not created through a supported cloud provider, so it does not require a managed cloud token."
              iconName="keys"
            />
          </SettingsSection>
        )}
      </div>
    </ServerWorkspace>
  );
}

export function ServerCloudTokenPage() {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle="Cloud Token">
      <ServerCloudTokenContent />
    </Layout>
  );
}
