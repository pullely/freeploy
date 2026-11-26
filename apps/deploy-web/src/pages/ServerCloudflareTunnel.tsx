// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/cloudflare-tunnel.blade.php and
// app/Livewire/Server/CloudflareTunnel.php (Apache-2.0), modified.
//
// /server/{uuid}/cloudflare-tunnel. Marking a manual configuration as complete and disabling the tunnel change the
// server's rows, as Coolify's do; disabling also removes cloudflared from the server, which needs the SSH executor
// (the rows are changed and the page says so). Updating cloudflared needs the executor too. The automated setups —
// through a Cloudflare integration token (Integration tokens are not ported) or with a tunnel token
// (ConfigureCloudflared, over SSH) — are not ported: on a validated server the page says so. The localhost server
// has no such page (Coolify redirects to the server's General page).
import { useCallback, useEffect } from "react";
import { Layout } from "../layout/Layout";
import { Callout, ModalConfirmation, SettingsSection, StatusBadge, Button } from "../components/Coolify";
import { limit, ServerWorkspace, useServerPage, type ServerPageData } from "./ServerChrome";

interface TunnelData extends ServerPageData {
  tunnel: { enabled: boolean; managedTunnelName: string | null; ipPrevious: string | null };
}

/** Freeploy's: ConfigureCloudflared and the Cloudflare API setup run on the server. */
export const AUTOMATED_TUNNEL_UNAVAILABLE = "Configuring cloudflared on the server needs the SSH executor, which is not available yet. Configure the tunnel yourself, then mark the manual configuration as complete.";

function ServerCloudflareTunnelContent() {
  const title = useCallback((name: string) => `${limit(name, 10)} > Cloudflare Tunnel | Freeploy`, []);
  const { me, data, setData, act } = useServerPage<TunnelData>("cloudflare-tunnel", title);
  useEffect(() => {
    // mount(): the localhost server redirects to its General page.
    if (data?.server.isLocalhost) window.location.replace(`/server/${data.server.uuid}`);
  }, [data]);
  if (!data || data.server.isLocalhost) return null;
  const { server, tunnel, canUpdate } = data;
  const enabled = tunnel.enabled;
  const setEnabled = (on: boolean) => setData((d) => (d ? { ...d, tunnel: { ...d.tunnel, enabled: on } } : d));

  async function manual() {
    const r = await act<{ enabled: boolean }>("cloudflare-tunnel/manual");
    if (r) setEnabled(r.enabled);
  }
  async function disable() {
    const r = await act<{ enabled: boolean }>("cloudflare-tunnel/disable");
    if (r) setEnabled(r.enabled);
  }

  const disableActions = [
    "Cloudflare Tunnel will be disabled for this server.",
    ...(tunnel.managedTunnelName ? ["The Cloudflare tunnel and the DNS record that Freeploy created will be deleted."] : []),
    ...(tunnel.ipPrevious ? ["The server IP address will be restored to its previous value."] : ["You must manually restore the direct server IP address.", "The server may become inaccessible until the IP is corrected."]),
  ];

  return (
    <ServerWorkspace server={server} orgId={me.team?.id} active="cloudflare-tunnel" canUpdate={canUpdate}>
      <div className="application-settings-form flex w-full flex-col gap-6">
        <SettingsSection
          id="server-cloudflare-overview-section"
          title="Cloudflare Tunnel"
          helper="Proxy SSH traffic through Cloudflare so the server SSH port can remain closed."
          actions={
            <>
              {enabled && canUpdate ? <Button onClick={() => void act("cloudflare-tunnel/update")}>Update Cloudflare Tunnel</Button> : null}
              {!enabled ? (
                <a className="button" href="https://coolify.io/docs/knowledge-base/cloudflare/tunnels/server-ssh" target="_blank" rel="noreferrer">
                  Documentation
                </a>
              ) : null}
              {!enabled && server.isFunctional && canUpdate ? (
                <ModalConfirmation
                  title="Confirm manual Cloudflare Tunnel configuration"
                  buttonTitle="I configured the tunnel manually"
                  actions={["Cloudflare and cloudflared have already been configured.", "An incomplete setup can make the server unreachable."]}
                  confirmationText="I manually configured Cloudflare Tunnel"
                  confirmationLabel="Type the confirmation text to continue."
                  shortConfirmationLabel="Confirmation text"
                  onSubmit={manual}
                />
              ) : null}
              {enabled ? <StatusBadge label="Enabled" type="success" /> : null}
            </>
          }
        >
          {enabled ? (
            <>
              {tunnel.managedTunnelName ? (
                <p className="mb-4 text-sm leading-6 text-neutral-600 dark:text-fg-dim">
                  Freeploy manages this tunnel through the Cloudflare API (tunnel <code>{tunnel.managedTunnelName}</code>).
                </p>
              ) : null}
              <Callout type="warning" title="Disabling the tunnel can interrupt server access">
                The server IP must be restored to its direct address after disabling the tunnel.
              </Callout>
              {canUpdate ? (
                <div className="mt-4">
                  <ModalConfirmation
                    title="Disable Cloudflare Tunnel?"
                    buttonTitle="Disable Cloudflare Tunnel"
                    actions={disableActions}
                    confirmationText="DISABLE CLOUDFLARE TUNNEL"
                    confirmationLabel="Type the confirmation text to disable Cloudflare Tunnel."
                    shortConfirmationLabel="Confirmation text"
                    onSubmit={disable}
                  />
                </div>
              ) : null}
            </>
          ) : !server.isFunctional ? (
            <Callout type="info" title="Validate the server for automated setup">
              Automated configuration requires a validated server, a Cloudflare token, and an SSH domain. You can also{" "}
              <button type="button" onClick={() => void manual()} className="font-medium underline">
                mark a manual configuration as complete
              </button>
              .
            </Callout>
          ) : !canUpdate ? (
            <Callout type="warning" title="Insufficient permissions">
              You do not have permission to configure Cloudflare Tunnel for this server.
            </Callout>
          ) : (
            <Callout type="info" title="Automated setup is not available yet">
              {AUTOMATED_TUNNEL_UNAVAILABLE}
            </Callout>
          )}
        </SettingsSection>
      </div>
    </ServerWorkspace>
  );
}

export function ServerCloudflareTunnelPage() {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle="Cloudflare Tunnel">
      <ServerCloudflareTunnelContent />
    </Layout>
  );
}
