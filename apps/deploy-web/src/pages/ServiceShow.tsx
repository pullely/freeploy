// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/service/{configuration,stack-form,
// edit-compose,resource-card}.blade.php and bootstrap/helpers/shared.php (formatContainerStatus) (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/service/{service_uuid} (project.service.configuration): the service's
// General page — StackForm (name, description, the network, the template's fields, and the "Edit Compose file"
// dialog with EditCompose) and the Compose resources list, inside the configuration frame. Each resource card
// opens the part's own settings (project.service.index, ServicePart.tsx), which Coolify opens in a dialog.
import { useCallback, useEffect, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson } from "../lib/api";
import { toast } from "../lib/toast";
import { Callout, Checkbox, Empty, FormInput, FormTextarea, Helper, Listbox, ModalInput, SettingsSection, SettingsSubsection, StatusBadge, UnsavedBar, Button } from "../components/Coolify";
import { Reicon } from "../components/Reicon";
import { environmentPath, environmentUuidFromPath, limit, projectUuidFromPath } from "./ProjectChrome";
import { servicePath, serviceUuidFromPath } from "../lib/service-templates";
import { sendJson, showSaved } from "./ApplicationResource";
import { serviceApi, ServiceWorkspace, type ServiceInfo, type ServicePartSummary } from "./ServiceChrome";

interface Field {
  serviceName: string;
  key: string;
  name: string;
  value: string | null;
  isPassword: boolean;
  rules: string;
  customHelper: string | null;
  isLocked: boolean;
}

interface General {
  name: string;
  description: string | null;
  connectToDockerNetwork: boolean;
  isContainerLabelEscapeEnabled: boolean;
  dockerComposeRaw: string | null;
  dockerCompose: string | null;
  fields: Field[];
  isPasswordHiddenForMember: boolean;
}

interface Page {
  service: ServiceInfo;
  general: General;
  canUpdate: boolean;
}

type Saved = Omit<Page, "canUpdate"> & { message?: string; unavailable?: string; warnings?: string[] };

/** str($s)->headline() for a status word. */
const headlineWord = (word: string) => word.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** formatContainerStatus() */
export function formatContainerStatus(status: string): string {
  if (status.startsWith("Proxy")) return headlineWord(status);
  const parts = status.split(":");
  if (status.endsWith(":excluded")) return parts.length === 3 ? `${headlineWord(parts[0] ?? "")} (${parts[1]}, excluded)` : `${headlineWord(parts[0] ?? "")} (excluded)`;
  if (parts.length >= 2) return `${headlineWord(parts[0] ?? "")} (${parts[1]})`;
  return headlineWord(status);
}

/** resource-card.blade.php's status badge. */
function statusBadge(status: string): { type: "success" | "warning" | "error"; label: string } {
  if (status.includes("running") && !status.includes("starting")) return { type: "success", label: formatContainerStatus(status) };
  if (["starting", "restarting", "degraded"].some((s) => status.includes(s))) return { type: "warning", label: formatContainerStatus(status) };
  return { type: "error", label: formatContainerStatus(status) };
}

/** <livewire:project.service.resource-card>, the table row: the part, its image, its status, its settings. */
function ResourceCard({ part, href }: { part: ServicePartSummary; href: string }) {
  const badge = statusBadge(part.status);
  return (
    <a
      href={href}
      aria-label={`Open ${part.displayName} settings`}
      className="grid min-h-14 min-w-[48rem] cursor-pointer grid-cols-[minmax(14rem,1fr)_minmax(12rem,1fr)_12rem_5rem] items-center gap-3 border-b border-neutral-200 px-4 py-2.5 last:border-b-0 hover:bg-neutral-50 dark:border-white/[0.07] dark:hover:bg-white/[0.025]"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500 dark:bg-white/[0.06] dark:text-fg-dim">
          <Reicon name={part.kind === "database" ? "database" : "grid"} className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-black dark:text-fg">{part.displayName}</div>
        </div>
      </div>
      <div className="truncate font-mono text-xs text-neutral-500 dark:text-fg-faint">{part.image}</div>
      <div className="flex flex-wrap items-center gap-1" title={part.isRemovedFromCompose ? "Not in the Docker Compose file. Add it back to use it again, or delete it in its settings." : undefined}>
        {part.isRemovedFromCompose ? (
          <span className="inline-flex h-6 max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border border-red-200 bg-red-50 px-2 text-xs font-medium leading-none text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300">
            <span className="size-1.5 shrink-0 rounded-full bg-red-500" />
            <span className="truncate">Not in Compose file</span>
          </span>
        ) : (
          <StatusBadge label={badge.label} type={badge.type} />
        )}
      </div>
      <div className="flex items-center justify-end">
        <span className="icon-button" title="Resource settings">
          <Reicon name="settings" className="size-4" />
        </span>
      </div>
    </a>
  );
}

/** <livewire:project.service.edit-compose> in StackForm's "Edit Compose file" dialog. */
function EditCompose({ general, api, onSaved, close }: { general: General; api: string; onSaved: (saved: Saved) => void; close: () => void }) {
  const [raw, setRaw] = useState(general.dockerComposeRaw ?? "");
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [escape, setEscape] = useState(general.isContainerLabelEscapeEnabled);

  /** EditCompose::saveEditedCompose(): StackForm::saveCompose($raw) with the form as it is. */
  async function save() {
    setSaving(true);
    const r = await sendJson<Saved>("PATCH", api, { name: general.name, description: general.description, dockerComposeRaw: raw, fields: Object.fromEntries(general.fields.filter((f) => !f.isLocked).map((f) => [f.key, f.value])) });
    setSaving(false);
    // handleError(): the exception's message (for a validation error, its summary) as one toast.
    if (!r.ok) return toast(r.error.message, { type: "danger" });
    onSaved(r.data);
    showSaved(r.data);
    close();
  }

  /** EditCompose::instantSave() */
  async function saveEscape(checked: boolean) {
    setEscape(checked);
    const r = await sendJson<Saved>("PATCH", `${api}/label-escape`, { isContainerLabelEscapeEnabled: checked });
    if (!r.ok) return toast(r.error.message, { type: "danger" });
    onSaved(r.data);
    showSaved(r.data);
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <Callout type="info" title="Volume names">
        Volume names are prefixed with the service UUID when you save to prevent collisions.
      </Callout>
      <div className="compose-editor-container min-h-[24rem] overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-white/[0.10] dark:bg-[#0b0b0c]">
        {preview ? (
          <FormTextarea id="dockerCompose" rows={24} value={general.dockerCompose ?? ""} onChange={() => undefined} disabled />
        ) : (
          <FormTextarea id="dockerComposeRaw" rows={24} value={raw} onChange={setRaw} />
        )}
      </div>
      <div className="flex flex-col items-stretch gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-1 sm:flex-row sm:flex-wrap sm:items-center dark:border-white/[0.08] dark:bg-white/[0.05]">
        <Checkbox
          id="isContainerLabelEscapeEnabled"
          label="Escape special characters in labels"
          helper="By default, $ (and other characters) is escaped. A $ in a label is saved as $$. Turn this off to use environment variables inside labels."
          checked={escape}
          onChange={(checked) => void saveEscape(checked)}
        />
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button onClick={() => setPreview(!preview)}>
          <Reicon name="eye" className="size-3.5" />
          <span>{preview ? "Back to source Compose" : "Preview generated Compose"}</span>
        </Button>
        <Button highlighted disabled={saving} onClick={() => void save()}>
          Save changes
        </Button>
      </div>
    </div>
  );
}

function ServiceGeneralContent() {
  const { me } = useSignedIn();
  const projectUuid = projectUuidFromPath();
  const environmentUuid = environmentUuidFromPath();
  const uuid = serviceUuidFromPath();
  const api = `${serviceApi(me.team?.id, uuid)}/configuration`;
  const [page, setPage] = useState<Page | null>(null);
  const [form, setForm] = useState<{ name: string; description: string; fields: Record<string, string> } | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const show = useCallback((data: Omit<Page, "canUpdate">, canUpdate: boolean) => {
    setPage({ ...data, canUpdate });
    setForm({ name: data.general.name, description: data.general.description ?? "", fields: Object.fromEntries(data.general.fields.map((f) => [f.key, f.value ?? ""])) });
  }, []);

  useEffect(() => {
    void (async () => {
      const r = await getJson<Page>(api);
      // Configuration::mount(): the service through its project and environment, or back to the environment.
      if (!r.data) {
        if (r.status === 404) window.location.replace(environmentPath(projectUuid, environmentUuid));
        return;
      }
      if (r.data.service.project.uuid !== projectUuid || r.data.service.environment.uuid !== environmentUuid) return window.location.replace("/projects");
      show(r.data, r.data.canUpdate);
    })();
  }, [api, projectUuid, environmentUuid, show]);
  useEffect(() => {
    if (page) document.title = `${limit(page.service.name, 10)} > Configuration | Freeploy`;
  }, [page]);

  if (!page || !form) return null;
  const { service, general, canUpdate } = page;
  const dirty = form.name !== general.name || form.description !== (general.description ?? "") || general.fields.some((f) => !f.isLocked && (form.fields[f.key] ?? "") !== (f.value ?? ""));
  const here = servicePath(service.project.uuid, service.environment.uuid, service.uuid);
  const parts = [...service.applications, ...service.databases];

  /** StackForm::submit() */
  async function submit() {
    setSaving(true);
    const fields = Object.fromEntries(general.fields.filter((f) => !f.isLocked).map((f) => [f.key, form!.fields[f.key] ?? ""]));
    const r = await sendJson<Saved>("PATCH", api, { name: form!.name, description: form!.description, fields });
    setSaving(false);
    if (!r.ok) return toast(r.error.message, { type: "danger" });
    show(r.data, canUpdate);
    showSaved(r.data);
  }

  /** StackForm::instantSave(): the network attachment alone. */
  async function saveNetwork(value: string) {
    const r = await sendJson<Saved>("PATCH", `${api}/network`, { connectToDockerNetwork: value === "true" });
    if (!r.ok) return toast(r.error.message, { type: "danger" });
    show(r.data, canUpdate);
    showSaved(r.data);
  }

  return (
    <ServiceWorkspace service={service} orgId={me.team?.id} active="General" canUpdate={canUpdate}>
      <form
        className="application-settings-form flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {canUpdate ? <UnsavedBar dirty={dirty} saving={saving} onSave={() => void submit()} /> : null}
        <SettingsSection
          title="Service details"
          helper="Manage the identity, Compose configuration, and network of this service."
          actions={
            canUpdate ? (
              <ModalInput title="Docker Compose" trigger={<Button onClick={() => setComposeOpen(true)}>Edit Compose file</Button>} open={composeOpen} onOpenChange={setComposeOpen} closeOutside={false}>
                <EditCompose general={general} api={api} onSaved={(saved) => show(saved, canUpdate)} close={() => setComposeOpen(false)} />
              </ModalInput>
            ) : null
          }
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <FormInput id="name" required label="Service name" placeholder="My WordPress site" value={form.name} disabled={!canUpdate} onChange={(name) => setForm({ ...form, name })} />
            <FormInput id="description" label="Description" value={form.description} disabled={!canUpdate} onChange={(description) => setForm({ ...form, description })} />
          </div>
          <SettingsSubsection id="service-network-section" title="Network" helper="Control whether this Compose stack joins Freeploy's predefined network.">
            <Listbox
              id="connectToDockerNetwork"
              label="Network attachment"
              disabled={!canUpdate}
              value={general.connectToDockerNetwork ? "true" : "false"}
              onChange={(value) => void saveNetwork(value)}
              options={[
                { value: "false", label: "Use the stack network only" },
                { value: "true", label: "Connect to the predefined Freeploy network" },
              ]}
            />
          </SettingsSubsection>
        </SettingsSection>

        {general.fields.length > 0 ? (
          <SettingsSection title="Service configuration" helper="Template-specific values exposed by this service.">
            <div className="grid gap-4 lg:grid-cols-2">
              {general.fields.map((field) => (
                <div key={field.key}>
                  <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium">
                    <span>
                      {field.serviceName ? `${field.serviceName} · ` : ""}
                      {field.name}
                    </span>
                    <Helper helper={field.customHelper ?? `Variable name: ${field.key}`} />
                  </div>
                  {field.isLocked ? (
                    <FormInput disabled value="Locked (shown once)" />
                  ) : general.isPasswordHiddenForMember ? (
                    <FormInput disabled value="Hidden (only admins can view)" />
                  ) : (
                    <FormInput
                      id={`fields.${field.key}.value`}
                      type={field.isPassword ? "password" : "text"}
                      required={field.rules.includes("required")}
                      disabled={!canUpdate}
                      value={form.fields[field.key] ?? ""}
                      onChange={(value) => setForm({ ...form, fields: { ...form.fields, [field.key]: value } })}
                    />
                  )}
                </div>
              ))}
            </div>
          </SettingsSection>
        ) : null}
      </form>

      <div className="mt-8">
        <SettingsSection
          id="compose-resources-section"
          title="Compose resources"
          helper="Applications and databases defined in this service."
          flush
          actions={
            service.documentation ? (
              <a className="button" target="_blank" rel="noreferrer" href={service.documentation}>
                Documentation
                <Reicon name="external-link" className="size-4" />
              </a>
            ) : null
          }
        >
          <div className="overflow-x-auto rounded-lg">
            {parts.length ? (
              <div className="grid min-w-[48rem] grid-cols-[minmax(14rem,1fr)_minmax(12rem,1fr)_12rem_5rem] gap-3 border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[11px] font-medium text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-faint">
                <div>Resource</div>
                <div>Image</div>
                <div className="justify-self-start">Status</div>
                <span className="text-right">Actions</span>
              </div>
            ) : (
              <div className="p-4">
                <Empty title="No compose resources" description="No applications or databases are defined in this Docker Compose file." iconName="grid" />
              </div>
            )}
            {parts.map((part) => (
              <ResourceCard key={part.uuid} part={part} href={`${here}/${part.uuid}`} />
            ))}
          </div>
        </SettingsSection>
      </div>
    </ServiceWorkspace>
  );
}

export function ServiceShowPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
      <ServiceGeneralContent />
    </Layout>
  );
}
