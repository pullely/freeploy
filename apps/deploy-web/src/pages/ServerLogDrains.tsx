// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/log-drains.blade.php and
// app/Livewire/Server/LogDrains.php (Apache-2.0), modified.
//
// /server/{uuid}/log-drains: one external log destination (New Relic, Axiom,
// CloudWatch or a custom Fluent Bit configuration). Saving works; a Status
// change also starts or stops the log drain over SSH, which is not available
// yet: the API keeps the drain as it was and the page shows the error. Coolify's helper texts carry HTML (line breaks,
// code); here they are plain text.
import { useEffect, useState, type FormEvent } from "react";
import { Layout } from "../layout/Layout";
import { Empty, FormInput, FormTextarea, Listbox, SettingsSection, StatusBadge, UnsavedBar } from "../components/Coolify";
import { limit, ServerWorkspace, useServerSection, yesNo } from "./ServerChrome";

interface LogDrains {
  isLogDrainNewRelicEnabled: boolean;
  isLogDrainAxiomEnabled: boolean;
  isLogDrainCustomEnabled: boolean;
  isLogDrainCloudwatchEnabled: boolean;
  logDrainNewRelicLicenseKey: string | null;
  logDrainNewRelicBaseUri: string | null;
  logDrainAxiomDatasetName: string | null;
  logDrainAxiomApiKey: string | null;
  logDrainAxiomDomain: string | null;
  logDrainCustomConfig: string | null;
  logDrainCustomConfigParser: string | null;
  logDrainCloudwatchRegion: string | null;
  logDrainCloudwatchGroup: string | null;
  logDrainCloudwatchStreamPrefix: string | null;
  isLogDrainEnabled: boolean;
}

type Flag = "isLogDrainNewRelicEnabled" | "isLogDrainAxiomEnabled" | "isLogDrainCustomEnabled" | "isLogDrainCloudwatchEnabled";
type Field = Exclude<keyof LogDrains, Flag | "isLogDrainEnabled">;
const FLAGS: Flag[] = ["isLogDrainNewRelicEnabled", "isLogDrainAxiomEnabled", "isLogDrainCustomEnabled", "isLogDrainCloudwatchEnabled"];
const FIELDS: Field[] = [
  "logDrainNewRelicLicenseKey",
  "logDrainNewRelicBaseUri",
  "logDrainAxiomDatasetName",
  "logDrainAxiomApiKey",
  "logDrainAxiomDomain",
  "logDrainCustomConfig",
  "logDrainCustomConfigParser",
  "logDrainCloudwatchRegion",
  "logDrainCloudwatchGroup",
  "logDrainCloudwatchStreamPrefix",
];

const fieldsOf = (s: LogDrains) => Object.fromEntries(FIELDS.map((f) => [f, s[f] ?? ""])) as Record<Field, string>;
const flagsOf = (s: LogDrains) => Object.fromEntries(FLAGS.map((f) => [f, s[f]])) as Record<Flag, boolean>;

const STATUS_OPTIONS = [
  { value: "false", label: "Disabled" },
  { value: "true", label: "Enabled" },
];

const CLOUDWATCH_HELPER =
  "Send container logs directly to CloudWatch Logs using the Docker awslogs logging driver. AWS credentials are read by the Docker daemon on this server, not by Freeploy. Attach an IAM instance role, or configure AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for the Docker service or in /root/.aws/credentials. The credentials need logs:CreateLogStream and logs:PutLogEvents, plus logs:CreateLogGroup if the log group does not exist yet. Delivery errors do not stop containers; they appear in the Docker daemon logs (journalctl -u docker). Redeploy or restart resources to apply the logging driver.";
const CUSTOM_HELPER =
  "Provide the full Fluent Bit configuration and an optional parser configuration. The configuration must have an [INPUT] section with Name forward: containers send their logs to this input on port 24224. To use credential or certificate files, copy them to /data/freeploy/log-drains/files on the server. Fluent Bit reads them at /files, for example: google_service_credentials /files/gcp.json";

const title = (name: string) => `${limit(name, 10)} > Log Drains | Freeploy`;

function ServerLogDrainsContent() {
  const { me, data, errors, saving, save } = useServerSection<LogDrains>("log-drains", title);
  const [fields, setFields] = useState<Record<Field, string> | null>(null);
  const [flags, setFlags] = useState<Record<Flag, boolean> | null>(null);
  useEffect(() => {
    if (!data) return;
    setFields(fieldsOf(data.settings));
    setFlags(flagsOf(data.settings));
  }, [data]);
  if (!data || !fields || !flags) return null;
  const { server, settings, canUpdate } = data;
  const saved = fieldsOf(settings);
  const dirty = FIELDS.some((f) => fields[f] !== saved[f]);
  const set = (f: Field) => (v: string) => setFields({ ...fields, [f]: v });
  const submit = () => void save({ ...fields, ...flags });
  /** The Status listboxes: instantSave(); a refused save leaves the drain as it was. */
  const status = (flag: Flag) => async (v: string) => {
    const next = { ...flags, [flag]: v === "true" };
    setFlags(next);
    if (!(await save({ ...fields, ...next }, true))) setFlags(flagsOf(settings));
  };
  const others = (flag: Flag) => FLAGS.some((f) => f !== flag && flags[f]);
  const locked = settings.isLogDrainEnabled || !canUpdate;

  return (
    <ServerWorkspace server={server} orgId={me.team?.id} active="log-drains" canUpdate={canUpdate}>
      <div className="application-settings-form flex w-full flex-col gap-6">
        {server.isFunctional ? (
          <>
            <SettingsSection
              id="server-log-drains-overview-section"
              title="Log drains"
              helper="Forward container logs from this server to one external destination."
              actions={<StatusBadge label={settings.isLogDrainEnabled ? "Active" : "Not configured"} type={settings.isLogDrainEnabled ? "success" : "neutral"} />}
            >
              <p className="text-sm leading-6 text-neutral-600 dark:text-fg-dim">Only one log drain can be active at a time. Disable the current destination before enabling another provider.</p>
            </SettingsSection>

            <form
              className="contents"
              onSubmit={(e: FormEvent<HTMLFormElement>) => {
                e.preventDefault();
                submit();
              }}
            >
              <UnsavedBar dirty={dirty} saving={saving} onSave={submit} />

              <SettingsSection id="server-new-relic-drain-section" title="New Relic" helper="Send logs through the New Relic Log API.">
                <div className="grid gap-4 lg:grid-cols-3">
                  <Listbox id="isLogDrainNewRelicEnabled" label="Status" options={STATUS_OPTIONS} value={yesNo(flags.isLogDrainNewRelicEnabled)} onChange={(v) => void status("isLogDrainNewRelicEnabled")(v)} disabled={others("isLogDrainNewRelicEnabled") || !canUpdate} />
                  <FormInput id="logDrainNewRelicLicenseKey" type="password" label="License key" required={flags.isLogDrainNewRelicEnabled} disabled={locked} value={fields.logDrainNewRelicLicenseKey} onChange={set("logDrainNewRelicLicenseKey")} error={errors.logDrainNewRelicLicenseKey} />
                  <FormInput
                    id="logDrainNewRelicBaseUri"
                    label="Endpoint"
                    placeholder="https://log-api.eu.newrelic.com/log/v1"
                    helper="Use the EU or US New Relic Log API endpoint."
                    required={flags.isLogDrainNewRelicEnabled}
                    disabled={locked}
                    value={fields.logDrainNewRelicBaseUri}
                    onChange={set("logDrainNewRelicBaseUri")}
                    error={errors.logDrainNewRelicBaseUri}
                  />
                </div>
              </SettingsSection>

              <SettingsSection id="server-axiom-drain-section" title="Axiom" helper="Send logs to an Axiom dataset using its ingest API.">
                <div className="mb-4 max-w-sm">
                  <Listbox id="isLogDrainAxiomEnabled" label="Status" options={STATUS_OPTIONS} value={yesNo(flags.isLogDrainAxiomEnabled)} onChange={(v) => void status("isLogDrainAxiomEnabled")(v)} disabled={others("isLogDrainAxiomEnabled") || !canUpdate} />
                </div>
                <div className="grid gap-4 lg:grid-cols-3">
                  <FormInput id="logDrainAxiomApiKey" type="password" label="API key" required={flags.isLogDrainAxiomEnabled} disabled={locked} value={fields.logDrainAxiomApiKey} onChange={set("logDrainAxiomApiKey")} error={errors.logDrainAxiomApiKey} />
                  <FormInput id="logDrainAxiomDatasetName" label="Dataset name" required={flags.isLogDrainAxiomEnabled} disabled={locked} value={fields.logDrainAxiomDatasetName} onChange={set("logDrainAxiomDatasetName")} error={errors.logDrainAxiomDatasetName} />
                  <FormInput
                    id="logDrainAxiomDomain"
                    label="Edge domain"
                    placeholder="us-east-1.aws.edge.axiom.co"
                    helper="Base domain of the edge deployment of your Axiom organization. US: us-east-1.aws.edge.axiom.co EU: eu-central-1.aws.edge.axiom.co"
                    required={flags.isLogDrainAxiomEnabled}
                    disabled={locked}
                    value={fields.logDrainAxiomDomain}
                    onChange={set("logDrainAxiomDomain")}
                    error={errors.logDrainAxiomDomain}
                  />
                </div>
              </SettingsSection>

              <SettingsSection id="server-cloudwatch-drain-section" title="Amazon CloudWatch Logs" helper={CLOUDWATCH_HELPER}>
                <div className="mb-4 max-w-sm">
                  <Listbox id="isLogDrainCloudwatchEnabled" label="Status" options={STATUS_OPTIONS} value={yesNo(flags.isLogDrainCloudwatchEnabled)} onChange={(v) => void status("isLogDrainCloudwatchEnabled")(v)} disabled={others("isLogDrainCloudwatchEnabled") || !canUpdate} />
                </div>
                <div className="grid gap-4 lg:grid-cols-3">
                  <FormInput id="logDrainCloudwatchGroup" label="Log group" placeholder="/freeploy/production" required={flags.isLogDrainCloudwatchEnabled} disabled={locked} value={fields.logDrainCloudwatchGroup} onChange={set("logDrainCloudwatchGroup")} error={errors.logDrainCloudwatchGroup} />
                  <FormInput
                    id="logDrainCloudwatchStreamPrefix"
                    label="Log stream prefix"
                    placeholder="docker/"
                    helper="Optional. Log streams are named after the container, prefixed with this value (e.g. docker/<container name>)."
                    disabled={locked}
                    value={fields.logDrainCloudwatchStreamPrefix}
                    onChange={set("logDrainCloudwatchStreamPrefix")}
                    error={errors.logDrainCloudwatchStreamPrefix}
                  />
                  <FormInput id="logDrainCloudwatchRegion" label="Region" placeholder="us-east-1" required={flags.isLogDrainCloudwatchEnabled} disabled={locked} value={fields.logDrainCloudwatchRegion} onChange={set("logDrainCloudwatchRegion")} error={errors.logDrainCloudwatchRegion} />
                </div>
              </SettingsSection>

              <SettingsSection id="server-custom-drain-section" title="Custom Fluent Bit" helper={CUSTOM_HELPER}>
                <div className="mb-4 max-w-sm">
                  <Listbox id="isLogDrainCustomEnabled" label="Status" options={STATUS_OPTIONS} value={yesNo(flags.isLogDrainCustomEnabled)} onChange={(v) => void status("isLogDrainCustomEnabled")(v)} disabled={others("isLogDrainCustomEnabled") || !canUpdate} />
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                  <FormTextarea
                    id="logDrainCustomConfig"
                    label="Fluent Bit configuration"
                    rows={8}
                    placeholder={["[INPUT]", "    Name forward", "", "[OUTPUT]", "    Name  stdout", "    Match *"].join("\n")}
                    required={flags.isLogDrainCustomEnabled}
                    disabled={locked}
                    value={fields.logDrainCustomConfig}
                    onChange={set("logDrainCustomConfig")}
                    error={errors.logDrainCustomConfig}
                  />
                  <FormTextarea id="logDrainCustomConfigParser" label="Parser configuration" rows={8} disabled={locked} value={fields.logDrainCustomConfigParser} onChange={set("logDrainCustomConfigParser")} error={errors.logDrainCustomConfigParser} />
                </div>
              </SettingsSection>
            </form>
          </>
        ) : (
          <SettingsSection title="Log drains" helper="Forward container logs from this server to an external destination.">
            <Empty title="Server validation required" description="Validate this server before configuring log drains." iconName="notifications" />
          </SettingsSection>
        )}
      </div>
    </ServerWorkspace>
  );
}

export function ServerLogDrainsPage() {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle="Log Drains">
      <ServerLogDrainsContent />
    </Layout>
  );
}
