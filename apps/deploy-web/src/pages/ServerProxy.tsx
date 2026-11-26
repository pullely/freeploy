// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/proxy/{show,dynamic-configurations,
// certificates-show,certificates,logs}.blade.php, resources/views/livewire/project/shared/get-logs.blade.php and
// app/Livewire/Server/Proxy/{Show,DynamicConfigurations,CertificatesShow,Logs}.php (Apache-2.0), modified.
//
// /server/{uuid}/proxy, /proxy/dynamic, /proxy/certificates and /proxy/logs. Each reads the server's proxy from its
// row (GET …/proxy). What Coolify then reads on the server — the proxy's configuration file, the dynamic
// configurations, Traefik's acme.json and the proxy container's logs — needs the SSH executor: those calls answer
// that it is not available yet. A server that is not validated shows Coolify's "Server validation required" (the
// logs page its empty log viewer, as GetLogs reads nothing from such a server).
import { useCallback, useEffect, useState } from "react";
import { Layout } from "../layout/Layout";
import { Reicon } from "../components/Reicon";
import { Button, Callout, Empty, SettingsSection, StatusBadge } from "../components/Coolify";
import { ServerWorkspace, useServerPage, ValidationRequired, type ServerPageData, type ServerSubMenu } from "./ServerChrome";
import { headline } from "../lib/server-pages";

interface ProxyData extends ServerPageData {
  proxy: { type: string | null; status: string | null };
  proxySet: boolean;
}

export type ProxyPage = "configuration" | "dynamic-confs" | "certificates" | "logs";

const TITLES: Record<ProxyPage, string> = {
  configuration: "Proxy Configuration | Freeploy",
  "dynamic-confs": "Proxy Dynamic Configuration | Freeploy",
  certificates: "TLS Certificates | Freeploy",
  logs: "Proxy Logs | Freeploy",
};

/** Freeploy's: the proxy component (Server\Proxy) loads and saves its configuration file over SSH. */
export const PROXY_CONFIGURATION_UNAVAILABLE = "Reading the proxy configuration on the server needs the SSH executor, which is not available yet.";

/** <x-status-badge> of the proxy's status: str($status)->headline(), success while running. */
function ProxyStatus({ status }: { status: string | null }) {
  const s = status ?? "";
  return <StatusBadge label={headline(s)} type={s.includes("running") ? "success" : "neutral"} />;
}

/**
 * <livewire:project.shared.get-logs> without a container to read: the viewport's "No logs yet". Refresh asks the
 * API, which reads nothing from a server that is not functional and answers that a functional one needs the executor.
 */
export function LogsPanel({ load }: { load: () => Promise<string | null> }) {
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    const text = await load();
    setLoading(false);
    if (text !== null) setLogs(text);
  }, [load]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const lines = logs.split("\n").filter((l) => l !== "");
  return (
    <div className="w-full min-w-0">
      <div className="flex items-center justify-end gap-1 border-b border-neutral-200 px-3 py-2 dark:border-white/[0.08]">
        <button type="button" title="Refresh Logs" className="icon-button" onClick={() => void refresh()} disabled={loading}>
          <Reicon name="refresh" className="size-3.5" />
        </button>
      </div>
      <div className="runtime-log-viewport logs-viewer-viewport relative flex min-w-0 w-full flex-col overflow-x-hidden overflow-y-auto scrollbar max-h-[min(40rem,70dvh)] sm:max-h-[40rem]">
        {lines.length === 0 ? (
          <div className="runtime-log-empty" role="status">
            <div>
              <p>No logs yet</p>
              <span>Logs will appear here when the container produces output.</span>
            </div>
          </div>
        ) : (
          <div id="logs" className="font-logs max-w-full cursor-default text-[11px] leading-relaxed sm:text-xs">
            {lines.map((line, i) => (
              <div key={i} data-log-line className="log-line logs-viewer-line">
                <span data-line-text className="logs-viewer-line-text">
                  {line}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ServerProxyContent({ page }: { page: ProxyPage }) {
  const title = useCallback(() => TITLES[page], [page]);
  const { me, data, act } = useServerPage<ProxyData>("proxy", title);
  const loadLogs = useCallback(async () => (await act<{ logs: string }>("proxy/logs"))?.logs ?? null, [act]);
  // DynamicConfigurations::initLoadDynamicConfigurations and Certificates' x-init: the first load.
  const functional = data?.server.isFunctional ?? false;
  const traefik = data?.proxy.type === "TRAEFIK";
  useEffect(() => {
    if (!functional) return;
    if (page === "dynamic-confs") void act("proxy/dynamic");
    if (page === "certificates" && traefik) void act("proxy/certificates");
  }, [functional, traefik, page, act]);

  if (!data) return null;
  const { server, proxy, canUpdate } = data;
  const sub: ServerSubMenu = page;

  let content;
  if (page === "configuration") {
    content = server.isFunctional ? (
      <div className="application-settings-form flex w-full flex-col gap-6">
        <SettingsSection id="server-proxy-overview-section" title="Proxy configuration" helper="Configure the reverse proxy and request handling for this server." actions={<ProxyStatus status={proxy.status} />}>
          <Callout type="warning" title="Not available yet">
            {PROXY_CONFIGURATION_UNAVAILABLE}
          </Callout>
        </SettingsSection>
      </div>
    ) : (
      <ValidationRequired title="Proxy" helper="Configure the reverse proxy for this server." description="Validate this server before configuring its proxy." iconName="servers" />
    );
  } else if (page === "dynamic-confs") {
    content = (
      <div className="application-settings-form flex w-full flex-col gap-6">
        {server.isFunctional ? (
          <>
            <div className="flex flex-wrap items-center justify-end gap-3 px-1">
              <div className="flex items-center gap-2">
                <Button onClick={() => void act("proxy/dynamic")}>
                  <Reicon name="refresh" className="size-3.5" />
                  Reload
                </Button>
              </div>
            </div>
            <SettingsSection title="Dynamic configurations">
              <Empty size="sm" title="No dynamic configurations" description="Add a configuration file to extend the proxy at runtime." iconName="file-content" />
            </SettingsSection>
          </>
        ) : (
          <SettingsSection title="Dynamic configurations" helper="Manage additional runtime proxy configuration.">
            <Empty size="sm" title="Server validation required" description="Validate this server before loading proxy configuration." iconName="file-content" />
          </SettingsSection>
        )}
      </div>
    );
  } else if (page === "certificates") {
    content =
      server.isFunctional && traefik ? (
        <div className="application-settings-form flex w-full flex-col gap-6">
          <SettingsSection
            id="server-proxy-certificates-section"
            title="TLS certificates"
            helper="Review certificates stored in Traefik's acme.json file. Traefik renews every certificate in this file, also when no route uses its domain any more. Deleting an entry removes it from local ACME storage. It does not revoke the certificate at the certificate authority. If a route still uses the domain, Traefik requests a new certificate after the restart."
            actions={<Button onClick={() => void act("proxy/certificates")}>Refresh</Button>}
          />
        </div>
      ) : (
        <div className="application-settings-form w-full">
          <SettingsSection title="TLS certificates" helper="Review certificates stored by Traefik for this server.">
            <Empty
              size="sm"
              title={server.isFunctional ? "Traefik required" : "Server validation required"}
              description={server.isFunctional ? "TLS certificate management is available for the Traefik proxy." : "Validate this server before viewing its TLS certificates."}
              iconName="servers"
            />
          </SettingsSection>
        </div>
      );
  } else {
    content = (
      <div className="application-settings-form w-full">
        <SettingsSection
          title="Proxy logs"
          helper="Search, filter, follow, copy, or download recent output from the Freeploy proxy container."
          flush
          className="logs-settings-section"
          actions={<ProxyStatus status={proxy.status} />}
        >
          <div className="settings-log-panel">
            <LogsPanel load={loadLogs} />
          </div>
        </SettingsSection>
      </div>
    );
  }

  return (
    <ServerWorkspace server={server} orgId={me.team?.id} active="proxy" activeSub={sub} canUpdate={canUpdate} proxy={{ type: proxy.type, proxySet: data.proxySet }}>
      {content}
    </ServerWorkspace>
  );
}

export function ServerProxyPage({ page }: { page: ProxyPage }) {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle="Proxy">
      <ServerProxyContent page={page} />
    </Layout>
  );
}
