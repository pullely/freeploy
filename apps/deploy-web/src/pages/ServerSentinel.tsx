// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/sentinel/show.blade.php,
// resources/views/livewire/server/sentinel.blade.php, app/Livewire/Server/Sentinel/Show.php and
// app/Livewire/Server/Sentinel.php (Apache-2.0), modified.
//
// /server/{uuid}/sentinel: Sentinel's connection settings (the URL it reports
// to and its token). Saving, regenerating the token and restoring the defaults
// work; restarting Sentinel needs the SSH executor, so every action that
// restarts it says that is not available yet. The development overrides
// (debug logging, a custom image) are not shown, the status is not polled,
// and the restored defaults clear the URL: Freeploy has no Sentinel endpoint yet.
import { useEffect, useState, type FormEvent } from "react";
import { Layout } from "../layout/Layout";
import { Reicon } from "../components/Reicon";
import { Button, Callout, Empty, FormInput, ModalConfirmation, SettingsSection, StatusBadge, UnsavedBar } from "../components/Coolify";
import { ServerWorkspace, useServerSection } from "./ServerChrome";

interface Sentinel {
  isMetricsEnabled: boolean;
  sentinelToken: string;
  sentinelCustomUrl: string | null;
  isSentinelDebugEnabled: boolean;
  sentinelUpdatedAt: string | null;
  sentinelStatus: "restarting" | "waiting" | "in_sync" | "out_of_sync";
}

const STATUS_LABEL = { restarting: "Restarting", waiting: "Waiting for first report", in_sync: "In sync", out_of_sync: "Out of sync" } as const;
const STATUS_TYPE = { in_sync: "success", out_of_sync: "warning", restarting: "neutral", waiting: "neutral" } as const;

const title = () => "Sentinel Configuration | Freeploy";

/** Sentinel::isPushUrlInsecure(): a plain-HTTP URL other than the local server's internal one. */
function isPushUrlInsecure(url: string, isLocalhost: boolean): boolean {
  if ((isLocalhost && url === "http://coolify:8080") || !url.toLowerCase().startsWith("http://")) return false;
  return true;
}

/** escapeshellarg() */
const shellArg = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

function ServerSentinelContent() {
  const { me, data, errors, saving, save, post } = useServerSection<Sentinel | null, { isSentinelEnabled: boolean }>("sentinel", title);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  useEffect(() => {
    if (!data?.settings) return;
    setUrl(data.settings.sentinelCustomUrl ?? "");
    setToken(data.settings.sentinelToken);
  }, [data]);
  if (!data) return null;
  const { server, settings, canUpdate } = data;

  return (
    <ServerWorkspace server={server} orgId={me.team?.id} active="sentinel" activeSub="configuration" canUpdate={canUpdate}>
      {server.isFunctional && settings ? (
        <div className="w-full">
          <SentinelForm
            serverUuid={server.uuid}
            isLocalhost={server.isLocalhost}
            isSentinelEnabled={data.isSentinelEnabled}
            settings={settings}
            canUpdate={canUpdate}
            url={url}
            token={token}
            setUrl={setUrl}
            setToken={setToken}
            errors={errors}
            saving={saving}
            onSubmit={() => void save({ sentinelCustomUrl: url, sentinelToken: token })}
            onAction={(action) => post(action)}
          />
        </div>
      ) : (
        <div className="application-settings-form w-full">
          <SettingsSection title="Sentinel" helper="Monitor server and container health while collecting metrics.">
            <Empty title="Server validation required" description="Validate this server before enabling Sentinel." iconName="dashboard" />
          </SettingsSection>
        </div>
      )}
    </ServerWorkspace>
  );
}

function SentinelForm(props: {
  serverUuid: string;
  isLocalhost: boolean;
  isSentinelEnabled: boolean;
  settings: Sentinel;
  canUpdate: boolean;
  url: string;
  token: string;
  setUrl: (v: string) => void;
  setToken: (v: string) => void;
  errors: Record<string, string>;
  saving: boolean;
  onSubmit: () => void;
  onAction: (action: "restart" | "regenerate-token" | "restore-defaults") => Promise<unknown>;
}) {
  const { settings, canUpdate } = props;
  const status = settings.sentinelStatus;
  const dirty = props.url !== (settings.sentinelCustomUrl ?? "") || props.token !== settings.sentinelToken;
  return (
    <div className="application-settings-form flex w-full flex-col gap-6">
      <form
        className="contents"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          props.onSubmit();
        }}
      >
        <UnsavedBar dirty={dirty} saving={props.saving} onSave={props.onSubmit} />

        <SettingsSection
          id="server-sentinel-overview-section"
          title="Sentinel"
          helper="Monitor server and container health while collecting historical metrics."
          actions={
            <div className="flex items-center gap-2">
              <StatusBadge label={STATUS_LABEL[status]} type={STATUS_TYPE[status]} />
              <Button disabled={!canUpdate} onClick={() => void props.onAction("restart")}>
                <Reicon name="refresh" className="size-3.5" />
                {status === "in_sync" ? "Restart" : "Sync"}
              </Button>
            </div>
          }
        >
          {status === "out_of_sync" ? (
            <Callout title="Sentinel is out of sync">
              <div className="space-y-3">
                <p>Sentinel has not reported within the expected interval. Check these items before syncing again:</p>
                <ul className="list-disc space-y-1 pl-4">
                  <li>
                    Confirm that the <code>freeploy-sentinel</code> container is running.
                  </li>
                  <li>
                    <a className="font-medium underline underline-offset-2" href={`/server/${props.serverUuid}/sentinel/logs`}>
                      Open Sentinel logs
                    </a>{" "}
                    and review recent connection or push errors.
                  </li>
                  <li>Confirm that the Freeploy URL and Sentinel token match this configuration.</li>
                </ul>
                {props.isLocalhost ? (
                  <p>Sync Sentinel to recreate it on the Freeploy Docker network.</p>
                ) : (
                  <div className="space-y-2">
                    <p>The remote server needs outbound access to this Freeploy URL. Sentinel reporting does not require an inbound listening port.</p>
                    {settings.sentinelCustomUrl ? (
                      <p>
                        From the remote server, test <code className="break-all">curl -fsS {shellArg(`${settings.sentinelCustomUrl.replace(/\/+$/, "")}/api/health`)}</code>.
                      </p>
                    ) : (
                      <p>Set a reachable Freeploy URL before syncing Sentinel.</p>
                    )}
                    <p>Check DNS, TLS certificates, outbound firewall rules, and proxy settings.</p>
                  </div>
                )}
              </div>
            </Callout>
          ) : status === "in_sync" ? (
            <p className="text-sm text-neutral-500 dark:text-fg-dim">Sentinel is connected and reporting server health to this Freeploy instance.</p>
          ) : status === "restarting" ? (
            <p className="text-sm text-neutral-500 dark:text-fg-dim">Sentinel is restarting.</p>
          ) : (
            <p className="text-sm text-neutral-500 dark:text-fg-dim">Sentinel started and is waiting for its first authenticated report.</p>
          )}
        </SettingsSection>

        {props.isSentinelEnabled ? (
          <SettingsSection
            id="server-sentinel-connection-section"
            title="Connection"
            helper="Configure how Sentinel authenticates with and reports to Freeploy."
            actions={
              <div className="flex items-center gap-2">
                {canUpdate ? (
                  <ModalConfirmation
                    title="Restore default Sentinel configuration?"
                    trigger={
                      <button type="button" className="button">
                        Restore defaults
                      </button>
                    }
                    actions={[
                      "Clear the Freeploy URL and restore the default collection settings.",
                      "Clear debug logging and the development image override.",
                      "The Sentinel token and metrics setting will be preserved.",
                      "Restart Sentinel to apply the restored configuration.",
                    ]}
                    warningMessage="Your custom Sentinel configuration will be replaced with Freeploy defaults."
                    confirmationText={null}
                    step2ButtonText="Restore defaults"
                    onSubmit={async () => {
                      await props.onAction("restore-defaults");
                    }}
                  />
                ) : null}
                <Button disabled={!canUpdate} onClick={() => void props.onAction("regenerate-token")}>
                  Regenerate token
                </Button>
              </div>
            }
          >
            <div className="flex flex-col gap-4">
              {isPushUrlInsecure(props.url, props.isLocalhost) ? (
                <Callout title="Sentinel reports over plain HTTP">
                  Sentinel sends its token with every report. Over HTTP, the token and the server data are not encrypted on the network. Set an HTTPS Freeploy URL.
                </Callout>
              ) : null}
              <div className="grid gap-4 lg:grid-cols-2">
                <FormInput
                  id="sentinelCustomUrl"
                  label="Freeploy URL"
                  required
                  helper="Public URL used by Sentinel to reach this Freeploy instance."
                  disabled={!canUpdate}
                  value={props.url}
                  onChange={props.setUrl}
                  error={props.errors.sentinelCustomUrl}
                />
                <FormInput
                  id="sentinelToken"
                  type="password"
                  label="Sentinel token"
                  required
                  helper="Authentication token used by Sentinel."
                  disabled={!canUpdate}
                  value={props.token}
                  onChange={props.setToken}
                  error={props.errors.sentinelToken}
                />
              </div>
            </div>
          </SettingsSection>
        ) : null}
      </form>
    </div>
  );
}

export function ServerSentinelPage() {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle="Sentinel">
      <ServerSentinelContent />
    </Layout>
  );
}
