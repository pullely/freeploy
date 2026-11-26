// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/transfer.blade.php and
// app/Livewire/Server/Transfer.php (Apache-2.0), modified.
//
// /server/{uuid}/transfer (writers): moving the server's configuration to another Coolify instance. Transfer server
// runs ServerTransferMigrator's own checks — the target URL, the token, a transfer already running — with Coolify's
// messages; its checks over SSH and against the target need the SSH executor, which the answer says, and nothing is
// stored. The transfer's state is the server's metadata, shown as Coolify shows it. A server is never transferred
// away from Freeploy (completing a transfer is not ported), so Transfer back is not ported either.
import { useCallback, useState } from "react";
import { Layout } from "../layout/Layout";
import { Callout, DangerCallout, FormInput, ModalConfirmation, SettingsSection, StatusBadge } from "../components/Coolify";
import { limit, ServerWorkspace, useServerPage, type ServerPageData } from "./ServerChrome";

interface Migration {
  status: string | null;
  phase: string | null;
  error: string | null;
  targetUrl: string | null;
  log: Array<{ at: string; level: string; message: string }>;
  checklist: string[];
  warnings: string[];
}

interface TransferData extends ServerPageData {
  transfer: {
    isCoolifyHost: boolean;
    exportId: string | null;
    transferredAway: boolean;
    markerConflict: { instanceUrl: string | null } | null;
    migration: Migration | null;
    thisInstanceUrl: string;
  };
}

const HELPER = "Move this server’s control-plane config to another Freeploy instance (same physical host).";

/** Carbon::parse($at)->format('H:i:s'). */
function time(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toISOString().slice(11, 19);
}

const LOG_LEVEL: Record<string, string> = { success: "text-success", error: "text-error", warning: "text-warning", info: "text-neutral-600 dark:text-fg-dim" };

function MigrationState({ migration, serverUuid }: { migration: Migration; serverUuid: string }) {
  return (
    <>
      {migration.status === "running" ? (
        <Callout type="info" title="Transfer in progress">
          The server is being transferred to {migration.targetUrl}. You can leave this page; the transfer continues in the background.
        </Callout>
      ) : migration.status === "failed" ? (
        <DangerCallout title={migration.phase === "checks" ? "A check failed. The transfer did not start." : "Transfer failed"} className="">
          {migration.log.length > 0 ? "See the transfer log below for details." : migration.error}
        </DangerCallout>
      ) : migration.status === "unknown" ? (
        <Callout type="warning" title="Transfer result unknown">
          The transfer stopped before this instance could confirm the result. Check whether {migration.targetUrl} manages this server. If it does, call <code>POST /api/v1/servers/{serverUuid}/transfer/complete</code> on this instance. If it does not, transfer
          again.
        </Callout>
      ) : migration.status === "succeeded" ? (
        <>
          <Callout type="info" title="Transfer finished">
            {migration.targetUrl} now manages this server. Automations are disabled on this instance.
          </Callout>
          {migration.checklist.length > 0 ? (
            <div data-testid="post-transfer-checklist">
              <h3 className="text-sm font-semibold text-neutral-950 dark:text-fg">Finish the transfer on the target</h3>
              <p className="mt-1 text-xs leading-5 text-neutral-500 dark:text-fg-dim">The target shows these steps on the server page, checks them where it can, and keeps their state.</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-neutral-600 dark:text-fg-dim">
                {migration.checklist.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
      {migration.log.length > 0 ? (
        <div>
          <h3 className="text-sm font-semibold text-neutral-950 dark:text-fg">Transfer log</h3>
          <ol className="mt-2 flex flex-col gap-1 rounded-lg border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs dark:border-coolgray-300 dark:bg-coolgray-100" data-testid="transfer-log">
            {migration.log.map((entry, i) => (
              <li key={`${i}-${entry.at}`} className={`flex gap-3 ${LOG_LEVEL[entry.level] ?? ""}`}>
                <span className="shrink-0 text-neutral-400">{time(entry.at)}</span>
                <span className="break-words">{entry.message}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </>
  );
}

function ServerTransferContent() {
  const title = useCallback((name: string) => `${limit(name, 10)} > Transfer | Freeploy`, []);
  const { me, data, act } = useServerPage<TransferData>("transfer", title);
  const [targetUrl, setTargetUrl] = useState("");
  const [targetToken, setTargetToken] = useState("");
  if (!data) return null;
  const { server, transfer: t, canUpdate } = data;
  const running = t.migration?.status === "running";
  const badge = running ? <StatusBadge label="Transferring" type="warning" title={t.exportId ? `Export ID: ${t.exportId}` : null} /> : t.transferredAway ? <StatusBadge label="Transferred away" type="warning" title={t.exportId ? `Export ID: ${t.exportId}` : null} /> : <StatusBadge label="Managed here" type="success" title={t.exportId ? `Export ID: ${t.exportId}` : null} />;

  async function migrate() {
    await act("transfer/migrate", { targetUrl, targetToken });
    // Public properties are sent to the browser with every response: the token is cleared.
    setTargetToken("");
  }

  return (
    <ServerWorkspace server={server} orgId={me.team?.id} active="transfer" canUpdate={canUpdate}>
      <div className="application-settings-form flex w-full flex-col gap-6">
        {t.isCoolifyHost ? (
          <SettingsSection id="server-transfer-section" title="Transfer server" helper={HELPER}>
            <Callout type="warning" title="Localhost cannot be transferred">
              The Freeploy host (localhost) cannot be transferred between instances.
            </Callout>
          </SettingsSection>
        ) : (
          <SettingsSection id="server-transfer-section" title="Transfer server" helper={HELPER} actions={badge}>
            <div className="flex flex-col gap-4">
              {!t.transferredAway && t.markerConflict ? (
                <Callout type="warning" title="Another instance may claim this server">
                  The owner file on the server names a claim of {t.markerConflict.instanceUrl || "an unknown instance"}, but it is older than the claim of this instance or its URL is not valid, so this instance keeps managing the server. If you did
                  not transfer the server, check who can write files on it.
                </Callout>
              ) : null}
              {t.transferredAway ? (
                <div>
                  <h3 className="text-sm font-semibold text-neutral-950 dark:text-fg">Transfer back</h3>
                  <p className="mt-1 text-xs leading-5 text-neutral-500 dark:text-fg-dim">
                    Undo the transfer. The instance that manages the server now transfers it back here, with all changes made there. This archive is replaced only when the import here succeeds. If the other instance is lost, use Enable
                    management on the server page.
                  </p>
                </div>
              ) : (
                <>
                  <div>
                    <h3 className="text-sm font-semibold text-neutral-950 dark:text-fg">Transfer to another instance</h3>
                    <p className="mt-1 text-xs leading-5 text-neutral-500 dark:text-fg-dim">
                      Enter the target Coolify URL and an API token from that instance (root recommended). This exports the server and imports it on the target, which then manages it. Management is then disabled here.
                    </p>
                  </div>
                  <div className="flex flex-col gap-3 md:max-w-xl">
                    <FormInput id="targetUrl" label="Target instance URL" required placeholder="https://coolify.example.com" helper="Base URL of the other Coolify instance (no trailing path). It must use https." value={targetUrl} onChange={setTargetUrl} />
                    <FormInput
                      id="targetToken"
                      type="password"
                      label="Target API token"
                      required
                      placeholder="Paste token from target instance"
                      helper="Create a token on the target with root (or write + deploy). It is only used for this request."
                      value={targetToken}
                      onChange={setTargetToken}
                    />
                  </div>
                  <div>
                    {/* canGate="transfer": a disabled button for who may not transfer the server. */}
                    {!canUpdate ? (
                      <button type="button" className="button" disabled>
                        Transfer server
                      </button>
                    ) : (
                    <ModalConfirmation
                      title="Transfer this server?"
                      trigger={
                        <button type="button" className="button">
                          Transfer server
                        </button>
                      }
                      actions={[
                        "Freeploy first checks this server, the target instance, and the token. If a check fails, nothing is changed.",
                        "The server will be transferred to the target instance.",
                        "Automations for this server will be disabled on this instance.",
                      ]}
                      confirmationText={null}
                      warningMessage="All secrets of this server and its resources are sent to the target instance: private keys, credentials, and every environment variable value, also locked ones. Continue only if you trust that instance."
                      step2ButtonText="Transfer server"
                      onSubmit={migrate}
                    />
                    )}
                  </div>
                </>
              )}
              {t.migration ? <MigrationState migration={t.migration} serverUuid={server.uuid} /> : null}
              {t.migration && t.migration.warnings.length > 0 ? (
                <Callout type="warning" title="Warnings">
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                    {t.migration.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </Callout>
              ) : null}
            </div>
          </SettingsSection>
        )}
      </div>
    </ServerWorkspace>
  );
}

export function ServerTransferPage() {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle="Transfer">
      <ServerTransferContent />
    </Layout>
  );
}
