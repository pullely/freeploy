// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/sentinel/logs.blade.php and
// app/Livewire/Server/Sentinel/Logs.php (Apache-2.0), modified.
//
// /server/{uuid}/sentinel/logs: the Sentinel container's logs (viewSentinel: writers). A server that is not
// validated has no logs to read, as GetLogs reads nothing from it; reading them from a validated one needs the SSH
// executor, which the log viewer's error toast says.
import { useCallback } from "react";
import { Layout } from "../layout/Layout";
import { Empty, SettingsSection, StatusBadge } from "../components/Coolify";
import { limit, ServerWorkspace, useServerPage, type ServerPageData } from "./ServerChrome";
import { LogsPanel } from "./ServerProxy";
import { sentinelBadge, type SentinelStatus } from "../lib/server-pages";

interface SentinelLogsData extends ServerPageData {
  sentinel: { enabled: boolean; status: SentinelStatus };
}

function ServerSentinelLogsContent() {
  const title = useCallback((name: string) => `${limit(name, 10)} > Sentinel Logs | Freeploy`, []);
  const { me, data, act } = useServerPage<SentinelLogsData>("sentinel/logs", title);
  const load = useCallback(async () => (await act<{ logs: string }>("sentinel/logs"))?.logs ?? null, [act]);
  if (!data) return null;
  const { server, sentinel, canUpdate } = data;
  const badge = sentinelBadge(sentinel.status);
  return (
    <ServerWorkspace server={server} orgId={me.team?.id} active="sentinel" activeSub="logs" canUpdate={canUpdate}>
      <div className="application-settings-form w-full">
        <SettingsSection
          title="Sentinel logs"
          helper="Search, filter, follow, copy, or download recent output from the Sentinel container."
          flush
          className="logs-settings-section"
          {...(sentinel.enabled ? { actions: <StatusBadge label={badge.label} type={badge.type} /> } : {})}
        >
          {sentinel.enabled ? (
            <div className="settings-log-panel">
              <LogsPanel load={load} />
            </div>
          ) : (
            <Empty size="sm" title="Sentinel is unavailable" description="Sentinel does not run on build or Swarm servers." iconName="dashboard" />
          )}
        </SettingsSection>
      </div>
    </ServerWorkspace>
  );
}

export function ServerSentinelLogsPage() {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle="Sentinel Logs">
      <ServerSentinelLogsContent />
    </Layout>
  );
}
