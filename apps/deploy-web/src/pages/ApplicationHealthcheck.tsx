// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/shared/health-checks.blade.php
// and app/Livewire/Project/Shared/HealthChecks.php (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/application/{app_uuid}/healthcheck
// (project.application.healthcheck): how the container is checked — an HTTP
// request or a command — and how often. Stored, and applied at the next
// deployment.
import { useEffect, useState, type FormEvent } from "react";
import { Layout } from "../layout/Layout";
import { notify, toast } from "../lib/toast";
import { Button, Callout, FormInput, Listbox, ModalConfirmation, SettingsSection, SettingsSubsection, UnsavedBar } from "../components/Coolify";
import { ApplicationWorkspace } from "./ApplicationChrome";
import { inlineErrors, useApplicationSection, type ApplicationSectionData } from "./ApplicationSection";

interface HealthCheck {
  healthCheckEnabled: boolean;
  healthCheckType: string;
  healthCheckCommand: string | null;
  healthCheckMethod: string;
  healthCheckScheme: string;
  healthCheckHost: string;
  healthCheckPort: string | null;
  healthCheckPath: string;
  healthCheckReturnCode: number;
  healthCheckResponseText: string | null;
  healthCheckInterval: number;
  healthCheckTimeout: number;
  healthCheckRetries: number;
  healthCheckStartPeriod: number;
  customHealthcheckFound: boolean;
}

interface Data extends ApplicationSectionData {
  settings: HealthCheck;
}

interface Saved {
  settings: HealthCheck;
  message: string | null;
  info?: boolean;
}

/** The form's fields (wire:model), as typed. */
const FIELDS = [
  "healthCheckType",
  "healthCheckCommand",
  "healthCheckMethod",
  "healthCheckScheme",
  "healthCheckHost",
  "healthCheckPort",
  "healthCheckPath",
  "healthCheckReturnCode",
  "healthCheckResponseText",
  "healthCheckInterval",
  "healthCheckTimeout",
  "healthCheckRetries",
  "healthCheckStartPeriod",
] as const;
type Field = (typeof FIELDS)[number];
type Form = Record<Field, string>;
const formOf = (h: HealthCheck): Form => Object.fromEntries(FIELDS.map((f) => [f, h[f] === null ? "" : String(h[f])])) as Form;

const TYPE_OPTIONS = [
  { value: "http", label: "HTTP request" },
  { value: "cmd", label: "Container command" },
];
const METHOD_OPTIONS = ["GET", "HEAD", "POST", "OPTIONS"].map((m) => ({ value: m, label: m }));
const SCHEME_OPTIONS = [
  { value: "http", label: "HTTP" },
  { value: "https", label: "HTTPS" },
];

function ApplicationHealthcheckContent() {
  const { me, data, setData, saving, patch } = useApplicationSection<Data>("healthcheck");
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (data) setForm(formOf(data.settings));
  }, [data]);
  if (!data || !form) return null;
  const { application, canUpdate, settings } = data;
  const saved = formOf(settings);
  const dirty = FIELDS.some((f) => form[f] !== saved[f]);
  const set = (name: Field) => (v: string) => setForm({ ...form, [name]: v });
  const field = (name: Field) => ({ id: name, value: form[name], onChange: set(name), error: errors[name], disabled: !canUpdate });

  /** The answer of submit() or toggleHealthcheck(): the saved healthcheck and Coolify's toast. */
  const done = (r: Awaited<ReturnType<typeof patch<Saved>>>) => {
    if (!r.ok) {
      const inline = inlineErrors(r.error);
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(r.error.message);
      return;
    }
    setErrors({});
    setData({ ...data, settings: r.data.settings });
    if (r.data.message) (r.data.info ? toast(r.data.message, { type: "info" }) : notify.success(r.data.message));
  };
  const submit = async () => done(await patch<Saved>(form));
  const toggle = async () => done(await patch<Saved>({ toggle: true }));

  return (
    <ApplicationWorkspace application={application} orgId={me.team?.id} active="Healthcheck" canUpdate={canUpdate} canDeploy={data.canDeploy}>
      <form
        className="application-settings-form flex flex-col gap-6"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          void submit();
        }}
      >
        <UnsavedBar dirty={dirty} saving={saving} onSave={() => void submit()} />

        <SettingsSection
          id="healthcheck-configuration-section"
          title="Healthcheck"
          helper="Define how Freeploy determines whether this application is ready to receive traffic."
          actions={
            !settings.healthCheckEnabled ? (
              canUpdate ? (
                <ModalConfirmation
                  title="Enable healthcheck?"
                  trigger={
                    <button className="button button-highlighted" type="button">
                      Enable
                    </button>
                  }
                  actions={["Enable healthcheck for this resource."]}
                  warningMessage="If the healthcheck fails, your application will become inaccessible. Review the Healthchecks guide before continuing."
                  confirmationText={null}
                  step2ButtonText="Enable healthcheck"
                  onSubmit={toggle}
                />
              ) : (
                <button className="button button-highlighted" type="button" disabled>
                  Enable
                </button>
              )
            ) : (
              <Button disabled={!canUpdate} onClick={() => void toggle()}>
                Disable
              </Button>
            )
          }
        >
          {settings.customHealthcheckFound ? (
            <div className="mb-4">
              {settings.healthCheckEnabled ? (
                <Callout type="warning" title="Dockerfile HEALTHCHECK replaced">
                  This healthcheck replaces the HEALTHCHECK from the Dockerfile. Disable it to use the Dockerfile HEALTHCHECK again.
                </Callout>
              ) : (
                <Callout type="info" title="Dockerfile HEALTHCHECK in use">
                  The application uses the HEALTHCHECK from its Dockerfile. Enabling this healthcheck replaces it.
                </Callout>
              )}
            </div>
          ) : null}

          <div className="max-w-xs">
            <Listbox id="healthCheckType" label="Check type" required options={TYPE_OPTIONS} value={form.healthCheckType} onChange={set("healthCheckType")} disabled={!canUpdate} error={errors.healthCheckType} />
          </div>
          {form.healthCheckType === "http" ? (
            <div>
              <SettingsSubsection id="healthcheck-request-section" title="HTTP request" helper="Freeploy sends this request from inside the container and evaluates the response.">
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                  <Listbox id="healthCheckMethod" label="Method" required options={METHOD_OPTIONS} value={form.healthCheckMethod} onChange={set("healthCheckMethod")} disabled={!canUpdate} error={errors.healthCheckMethod} />
                  <Listbox id="healthCheckScheme" label="Scheme" required options={SCHEME_OPTIONS} value={form.healthCheckScheme} onChange={set("healthCheckScheme")} disabled={!canUpdate} error={errors.healthCheckScheme} />
                  <FormInput {...field("healthCheckHost")} placeholder="localhost" label="Host" required />
                  <FormInput {...field("healthCheckPort")} type="number" helper="Uses the first exposed port when empty." placeholder="80" label="Port" />
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_10rem]">
                  <FormInput {...field("healthCheckPath")} placeholder="/health" label="Path" required />
                  <FormInput
                    {...field("healthCheckReturnCode")}
                    type="number"
                    placeholder="200"
                    helper="Any 2xx or 3xx response always passes. Set a 4xx or 5xx code (for example 401) to also pass that response."
                    label="Expected code"
                    required
                  />
                </div>
                <div className="mt-4">
                  <FormInput
                    {...field("healthCheckResponseText")}
                    placeholder="OK"
                    label="Expected response text"
                    helper="The response body must contain this text. Leave empty to check only the response code. A HEAD response has no body, so HEAD does not check the text."
                  />
                </div>
              </SettingsSubsection>
            </div>
          ) : (
            <div>
              <SettingsSubsection id="healthcheck-command-section" title="Container command" helper="The command must exit with code 0 for the container to be considered healthy.">
                <Callout type="warning" title="Shell operators are not supported">
                  The command runs directly inside the container. Operators such as ;, |, &amp;, $, &gt;, and &lt; are blocked.
                </Callout>
                <div className="mt-4">
                  <FormInput {...field("healthCheckCommand")} label="Command" placeholder="pg_isready -U postgres" helper="Use a single executable command without shell expansion." required />
                </div>
              </SettingsSubsection>
            </div>
          )}

          <SettingsSubsection id="healthcheck-timing-section" title="Timing and retries" helper="Control how quickly healthchecks start, repeat, and fail.">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <FormInput {...field("healthCheckInterval")} min={1} type="number" placeholder="30" label="Interval (seconds)" required />
              <FormInput {...field("healthCheckTimeout")} min={1} type="number" placeholder="30" label="Timeout (seconds)" required />
              <FormInput {...field("healthCheckRetries")} min={1} type="number" placeholder="3" label="Retries" required />
              <FormInput {...field("healthCheckStartPeriod")} min={1} type="number" placeholder="30" label="Start period (seconds)" required />
            </div>
          </SettingsSubsection>
        </SettingsSection>
      </form>
    </ApplicationWorkspace>
  );
}

export function ApplicationHealthcheckPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
      <ApplicationHealthcheckContent />
    </Layout>
  );
}
