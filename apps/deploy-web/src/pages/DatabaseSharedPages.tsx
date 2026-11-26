// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/database/configuration.blade.php,
// resources/views/livewire/project/shared/webhooks.blade.php (the branch for what is not an application),
// resources/views/livewire/project/database/health.blade.php,
// resources/views/livewire/project/shared/destination.blade.php (the branch for what is not an application)
// and routes/web.php (project.database.*) (Apache-2.0), modified.
//
// The pages of a standalone database that are Coolify's shared components
// with the database as their resource — configuration.blade.php renders
// <livewire:project.shared.environment-variable.all :resource="$database" />,
// <livewire:project.service.storage :resource="$database" />, and the shared
// tags, resource operations, resource limits, webhooks and danger
// components the same way. Each page here is the application's page with
// kind "database", inside the database's configuration frame:
//
//   /project/{uuid}/environment/{env_uuid}/database/{db_uuid}/environment-variables  project.database.environment-variables
//   …/persistent-storage   project.database.persistent-storage
//   …/tags                 project.database.tags
//   …/resource-operations  project.database.resource-operations
//   …/resource-limits      project.database.resource-limits
//   …/webhooks             project.database.webhooks
//   …/danger               project.database.danger
//   …/healthcheck          project.database.healthcheck (DP-97: Database\Health)
//   …/servers              project.database.servers (DP-97: the shared destination component)
import { useState, type ReactNode } from "react";
import { Layout } from "../layout/Layout";
import { edgeBase, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { primaryStatus } from "../lib/primary-status";
import { Reicon } from "../components/Reicon";
import { Button, Callout, FormInput, ModalConfirmation, SettingsSection, StatusBadge, UnsavedBar } from "../components/Coolify";
import { inlineErrors, resourceApi, useResourceSection, type DatabaseSectionData, type PatchError } from "./ApplicationSection";
import { sendJson, showError, showSaved } from "./ApplicationResource";
import { ResourceWorkspace } from "./ResourceWorkspace";
import { EnvironmentVariablesContent } from "./ApplicationEnvironmentVariables";
import { StoragesContent } from "./ApplicationStorages";
import { TagsContent } from "./ApplicationTags";
import { ResourceOperationsContent } from "./ApplicationResourceOperations";
import { ResourceLimitsContent } from "./ApplicationResourceLimits";
import { DangerContent } from "./ApplicationDanger";
import { CopyInput } from "./ApplicationWebhooks";

/** Configuration's layout and title, as for every page of a database. */
const page = (content: ReactNode) => (
  <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
    {content}
  </Layout>
);

export const DatabaseEnvironmentVariablesPage = () => page(<EnvironmentVariablesContent kind="database" />);
export const DatabaseStoragesPage = () => page(<StoragesContent kind="database" />);
export const DatabaseTagsPage = () => page(<TagsContent kind="database" />);
export const DatabaseResourceOperationsPage = () => page(<ResourceOperationsContent kind="database" />);
export const DatabaseResourceLimitsPage = () => page(<ResourceLimitsContent kind="database" />);
export const DatabaseDangerPage = () => page(<DangerContent kind="database" />);

/**
 * webhooks.blade.php for what is not an application: the deploy webhook only.
 * Its URL is Coolify's path on this environment's API origin. As on the
 * application's page, the Documentation link and the API-disabled callout are
 * not rendered.
 */
function DatabaseWebhooksContent() {
  const { me, data } = useResourceSection<DatabaseSectionData & { deployWebhookPath: string }>("database", "webhooks");
  if (!data) return null;
  return (
    <ResourceWorkspace data={data} orgId={me.team?.id} active="Webhooks">
      <div className="application-settings-form">
        <SettingsSection title="Deploy webhook" helper="Trigger an external deployment with a valid Freeploy API authorization token.">
          <CopyInput label="Deploy webhook URL" text={edgeBase() + data.deployWebhookPath} />
        </SettingsSection>
      </div>
    </ResourceWorkspace>
  );
}

export const DatabaseWebhooksPage = () => page(<DatabaseWebhooksContent />);

interface Health {
  healthCheckEnabled: boolean;
  healthCheckInterval: number;
  healthCheckTimeout: number;
  healthCheckRetries: number;
  healthCheckStartPeriod: number;
}
type HealthForm = Record<"healthCheckInterval" | "healthCheckTimeout" | "healthCheckRetries" | "healthCheckStartPeriod", string>;
const healthForm = (h: Health): HealthForm => ({
  healthCheckInterval: String(h.healthCheckInterval),
  healthCheckTimeout: String(h.healthCheckTimeout),
  healthCheckRetries: String(h.healthCheckRetries),
  healthCheckStartPeriod: String(h.healthCheckStartPeriod),
});

/**
 * …/healthcheck (project.database.healthcheck, DP-97): <livewire:project.database.health>, health.blade.php —
 * the probe's interval, timeout, retries and start period, and the switch. Restarting the database to apply
 * them needs the SSH executor; the toast says to restart, as Coolify's.
 */
function DatabaseHealthcheckContent() {
  const { me, data, setData, saving, patch } = useResourceSection<DatabaseSectionData & { health: Health }>("database", "healthcheck");
  const [form, setForm] = useState<HealthForm | null>(null);
  const [synced, setSynced] = useState<Health | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (data && synced !== data.health) {
    setSynced(data.health);
    setForm(healthForm(data.health));
  }
  if (!data || !form) return null;
  const { canUpdate } = data;
  const enabled = data.health.healthCheckEnabled;
  const dirty = canUpdate && (Object.keys(form) as Array<keyof HealthForm>).some((k) => form[k] !== healthForm(data.health)[k]);
  const apply = (saved: { health: Health; message: string }) => {
    setData({ ...data, health: saved.health });
    setErrors({});
    showSaved(saved);
  };
  const failed = (error: PatchError) => {
    setErrors(inlineErrors(error));
    // handleError() catches the ValidationException: its message (the first error and how many more) is the toast.
    if (error.messages.length) notify.error(summarize(error.messages));
    else showError(error);
  };

  /** Health::submit() */
  async function submit() {
    const r = await patch<{ health: Health; message: string }>({ ...form });
    if (!r.ok) return failed(r.error);
    apply(r.data);
  }
  /** Health::toggleHealthcheck(): the form's values too. */
  async function toggle() {
    const r = await sendJson<{ health: Health; message: string }>("POST", `${resourceApi("database", me.team?.id, data!.database.uuid)}/healthcheck/toggle`, { ...form });
    if (!r.ok) return failed(r.error);
    apply(r.data);
  }
  const input = (id: keyof HealthForm, label: string, placeholder: string, min: number) => (
    <FormInput disabled={!canUpdate} min={min} type="number" id={id} placeholder={placeholder} label={label} required value={form[id]} onChange={(value) => setForm({ ...form, [id]: value })} error={errors[id]} />
  );

  return (
    <ResourceWorkspace data={data} orgId={me.team?.id} active="Healthcheck">
      <form
        className="application-settings-form flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <UnsavedBar dirty={dirty} saving={saving} onSave={() => void submit()} />
        <SettingsSection
          title="Healthcheck"
          helper="Define how Docker checks this database and reports its health."
          actions={
            !enabled ? (
              canUpdate ? (
                <ModalConfirmation
                  title="Enable healthcheck?"
                  buttonTitle="Enable healthcheck"
                  trigger={
                    <button type="button" className="button button-highlighted">
                      Enable healthcheck
                    </button>
                  }
                  actions={["Enable healthcheck for this database."]}
                  warningMessage="A failing probe marks the database unhealthy. Review the healthcheck guide before enabling it."
                  step2ButtonText="Enable healthcheck"
                  confirmationText={null}
                  onSubmit={toggle}
                />
              ) : null
            ) : (
              <Button disabled={!canUpdate} onClick={() => void toggle()}>
                Disable healthcheck
              </Button>
            )
          }
        >
          {!enabled ? (
            <Callout type="warning" title="Healthcheck disabled">
              Docker is not running a healthcheck probe, so Freeploy cannot report a healthy or unhealthy state.
            </Callout>
          ) : null}
          <div className={`${!enabled ? "mt-4 " : ""}grid gap-4 sm:grid-cols-2 xl:grid-cols-4`}>
            {input("healthCheckInterval", "Interval (seconds)", "15", 1)}
            {input("healthCheckTimeout", "Timeout (seconds)", "5", 1)}
            {input("healthCheckRetries", "Retries", "5", 1)}
            {input("healthCheckStartPeriod", "Start period (seconds)", "5", 0)}
          </div>
        </SettingsSection>
      </form>
    </ResourceWorkspace>
  );
}

export const DatabaseHealthcheckPage = () => page(<DatabaseHealthcheckContent />);


/**
 * …/servers (project.database.servers, DP-97): <livewire:project.shared.destination :resource="$database" />
 * for what is not an application — the primary server card only ("Databases and services are single-server
 * only"), read from the database's own GET.
 */
function DatabaseServersContent() {
  const { me, data } = useResourceSection<DatabaseSectionData>("database", "");
  if (!data) return null;
  const { database } = data;
  const status = primaryStatus(database.status);
  return (
    <ResourceWorkspace data={data} orgId={me.team?.id} active="Servers">
      <div className="flex flex-col gap-6">
        <SettingsSection id="primary-server-section" title="Primary server" helper="The server and network used by this resource.">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500 ring-1 ring-neutral-200 dark:bg-white/[0.05] dark:text-fg-dim dark:ring-white/[0.07]">
                <Reicon name="servers" className="size-5" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="truncate text-sm font-semibold text-black dark:text-fg">{database.server?.name ?? ""}</h4>
                  <span className="rounded-sm bg-coollabs/10 px-1.5 py-0.5 text-[11px] font-medium text-coollabs dark:bg-brand/15 dark:text-brand-light">Primary</span>
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px] text-neutral-500 dark:text-fg-dim">
                  <span>Network</span>
                  <code className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs text-neutral-700 dark:bg-white/[0.05] dark:text-fg-dim">{database.destination?.network ?? ""}</code>
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              <a href={`/server/${encodeURIComponent(database.server?.uuid ?? "")}`} className="button">
                Open server
              </a>
              <StatusBadge label={status.label} type={status.type} />
            </div>
          </div>
        </SettingsSection>
      </div>
    </ResourceWorkspace>
  );
}

export const DatabaseServersPage = () => page(<DatabaseServersContent />);
