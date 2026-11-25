// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/storage/{index,create,show,form,resources}.blade.php,
// resources/views/components/forms/domain-input.blade.php, resources/views/livewire/shared/list-search-*.blade.php
// and app/Livewire/Storage/{Index,Create,Form,Show,Resources}.php (Apache-2.0), modified.
//
// Integrations → Storage: /storages (the list, and New storage in a dialog as
// Coolify has it — there is no /storages/new) and /storages/{uuid} with its
// tabs General, Resources (/resources) and Danger Zone (/danger). Only S3
// storages are ported: the Type listbox offers Coolify's four types, and the
// other three say they are not available yet.
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { composeUrl, detectPathStyleEndpoint, EMPTY_PARTS, splitUrl, type DomainUrlParts } from "../lib/domain-url";
import { notify, toast } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Button, Callout, Checkbox, DangerCallout, DangerZone, DashboardTitle, Empty, FormInput, ListSearchControls, ListSearchEmpty, Listbox, ModalConfirmation, ModalInput, SettingsSection, StatusBadge, UnsavedBar, type ListViewMode } from "../components/Coolify";

interface StorageItem {
  uuid: string;
  name: string;
  description: string | null;
  type: string;
  typeLabel: string;
  isUsable: boolean;
}

interface StorageDetail extends StorageItem {
  region: string;
  bucket: string | null;
  endpoint: string | null;
  key: string;
  hasSavedSecret: boolean;
  usePathStyleEndpoint: boolean;
  usePathStyleEndpointChosen: boolean;
  skipTlsVerification: boolean;
  isPasswordHiddenForMember: boolean;
  backupCount: number;
}

const storagesApi = (orgId: string | undefined) => `/v1/organizations/${orgId ?? ""}/deploy/storages`;
const TYPES = [
  { value: "s3", label: "S3" },
  { value: "sftp", label: "SFTP" },
  { value: "ftps", label: "FTPS" },
  { value: "webdav", label: "WebDAV" },
];
const PATH_STYLE_HELPER =
  "Turn this off for providers that only accept virtual-hosted-style URLs (bucket.endpoint). Freeploy turns it off for Alibaba Cloud OSS, Tencent Cloud COS, and Volcengine TOS, and when the provider rejects path-style URLs.";
const SKIP_TLS_HELPER =
  "Turn this on only for an endpoint with a self-signed or private CA certificate. Freeploy and the backup helper then accept any certificate, so an attacker on the network path can read or change your backups. Browsers that download files from this storage must still trust the certificate.";
const description = (s: StorageItem) => s.description || (s.type === "s3" ? "S3-compatible storage" : `${s.typeLabel} storage`);

/** The field errors of an answer, first message each; a toast when there are none. */
function fieldErrors(error: { fields?: Record<string, string[]>; messages: string[] }, title?: string): Record<string, string> {
  const inline: Record<string, string> = {};
  for (const [f, m] of Object.entries(error.fields ?? {})) if (m[0]) inline[f] = m[0];
  if (!Object.keys(inline).length) {
    if (title) toast(title, { type: "danger", description: summarize(error.messages) });
    else notify.error(summarize(error.messages));
  }
  return inline;
}

/** <x-forms.domain-input>: Protocol, Host, Port and Path. */
function DomainInput(props: { id: string; parts: DomainUrlParts; onChange: (parts: DomainUrlParts) => void; error?: string | undefined; disabled?: boolean }) {
  const { id, parts } = props;
  const set = (patch: Partial<DomainUrlParts>) => props.onChange({ ...parts, ...patch });
  return (
    <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)_8rem]">
      <div className="min-w-0">
        <Listbox id={`${id}-protocol`} label="Protocol" options={[{ value: "https", label: "https" }, { value: "http", label: "http" }]} value={parts.scheme} onChange={(scheme) => set({ scheme })} disabled={props.disabled ?? false} />
      </div>
      <div className="min-w-0">
        <div className="mb-1.5 flex h-4 w-full items-center gap-1.5">
          <label htmlFor={`${id}-host`} className="mb-0! flex items-center gap-1.5 leading-4">
            Host <span className="text-helper">*</span>
          </label>
        </div>
        <input id={`${id}-host`} type="text" className="input" value={parts.host} onChange={(e) => set({ host: e.target.value })} placeholder="minio.internal or 192.168.1.50" autoComplete="off" required disabled={props.disabled ?? false} />
        {props.error ? <p className="mt-1 text-[12px] text-red-500">{props.error}</p> : null}
      </div>
      <div className="min-w-0">
        <div className="mb-1.5 flex h-4 w-full items-center gap-1.5">
          <label htmlFor={`${id}-port`} className="mb-0! flex items-center gap-1.5 leading-4">
            Port
          </label>
        </div>
        <input id={`${id}-port`} type="number" className="input" value={parts.port} onChange={(e) => set({ port: e.target.value })} placeholder="3000" min={1} max={65535} inputMode="numeric" disabled={props.disabled} />
      </div>
      <div className="min-w-0 sm:col-span-3">
        <div className="mb-1.5 flex h-4 w-full items-center gap-1.5">
          <label htmlFor={`${id}-path`} className="mb-0! flex items-center gap-1.5 leading-4">
            Path
          </label>
        </div>
        <input id={`${id}-path`} type="text" className="input" value={parts.path} onChange={(e) => set({ path: e.target.value })} placeholder="/api/v3" autoComplete="off" disabled={props.disabled} />
        <p className="mt-1 text-[12px] text-neutral-500 dark:text-fg-dim">Optional path, query, or fragment appended after the domain and port.</p>
      </div>
    </div>
  );
}

/** livewire/storage/create: the New Storage dialog's form. */
function NewStorageForm({ canCreate }: { canCreate: boolean }) {
  const { me } = useSignedIn();
  const [type, setType] = useState("s3");
  const [f, setF] = useState({ name: "", description: "", bucket: "", region: "us-east-1", key: "", secret: "" });
  const [parts, setParts] = useState<DomainUrlParts>({ ...EMPTY_PARTS });
  const [partsChanged, setPartsChanged] = useState(false);
  const [usePathStyle, setUsePathStyle] = useState(true);
  const [pathStyleChosen, setPathStyleChosen] = useState(false);
  const [skipTls, setSkipTls] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  if (!canCreate) {
    return <DangerCallout title="Insufficient Permissions">You don&apos;t have permission to create new storage configurations. Please contact your team administrator for access.</DangerCallout>;
  }
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  /** updatedEndpointParts(): the URL style follows the provider until the user picks one. */
  function changeParts(next: DomainUrlParts) {
    setParts(next);
    setPartsChanged(true);
    if (!pathStyleChosen) setUsePathStyle(detectPathStyleEndpoint(composeUrl(next)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    const r = await postJson<{ uuid: string }>(storagesApi(me.team?.id), {
      type,
      ...f,
      endpoint: partsChanged ? composeUrl(parts) : "",
      usePathStyleEndpoint: usePathStyle,
      skipTlsVerification: skipTls,
    });
    setSaving(false);
    if (!r.ok) return setErrors(fieldErrors(r.error, "Failed to create storage."));
    window.location.assign(`/storages/${r.data.uuid}`);
  }

  return (
    <div className="w-full">
      <div className="mb-4">
        For more details, please visit the{" "}
        <a className="underline dark:text-brand-light" href="https://coolify.io/docs/knowledge-base/s3/introduction" target="_blank" rel="noreferrer">
          Coolify Docs
        </a>
        .
      </div>
      <form className="flex flex-col gap-2" onSubmit={(e) => void submit(e)}>
        <div className="w-64">
          <Listbox id="type" label="Type" required options={TYPES} value={type} onChange={(v) => (setType(v), setErrors({}))} error={errors.type} />
        </div>
        <div className="flex gap-2">
          <FormInput id="name" label="Name" required value={f.name} onChange={set("name")} error={errors.name} />
          <FormInput id="description" label="Description" value={f.description} onChange={set("description")} error={errors.description} />
        </div>
        {type === "s3" ? (
          <>
            <DomainInput id="endpointParts" parts={parts} onChange={changeParts} error={errors.endpoint} />
            <div className="flex gap-2">
              <FormInput id="bucket" label="Bucket" required value={f.bucket} onChange={set("bucket")} error={errors.bucket} />
              <FormInput id="region" label="Region" required helper="Region only required for AWS. Leave it as-is for other providers." value={f.region} onChange={set("region")} error={errors.region} />
            </div>
            <div className="flex gap-2">
              <FormInput id="key" label="Access Key" required type="password" value={f.key} onChange={set("key")} error={errors.key} />
              <FormInput id="secret" label="Secret Key" required type="password" value={f.secret} onChange={set("secret")} error={errors.secret} />
            </div>
            <div className="w-64">
              <Checkbox id="usePathStyleEndpoint" label="Use path-style URLs" helper={PATH_STYLE_HELPER} checked={usePathStyle} onChange={(v) => (setUsePathStyle(v), setPathStyleChosen(true))} />
              <Checkbox id="skipTlsVerification" label="Skip TLS certificate verification" helper={SKIP_TLS_HELPER} checked={skipTls} onChange={setSkipTls} />
            </div>
          </>
        ) : (
          <Callout type="warning" title="Not available yet">
            {TYPES.find((t) => t.value === type)?.label} storages are not available yet.
          </Callout>
        )}
        <button className="button mt-4" type="submit" disabled={saving}>
          Validate Connection &amp; Continue
        </button>
      </form>
    </div>
  );
}

const VIEW_KEY = "coolify-s3-storages-view";
function storedView(): ListViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "table";
  } catch {
    return "table";
  }
}
const COLUMNS = "grid-cols-[minmax(0,1fr)_minmax(10rem,.8fr)_9rem]";

function StoragesContent() {
  const { me } = useSignedIn();
  const [data, setData] = useState<{ storages: StorageItem[]; canCreate: boolean } | null>(null);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ListViewMode>(storedView);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await getJson<{ storages: StorageItem[]; canCreate: boolean }>(storagesApi(me.team?.id));
      if (!r.data && r.status !== 401) notify.error("Failed to load storages.");
      setData(r.data ?? { storages: [], canCreate: false });
    })();
  }, [me.team?.id]);

  function changeView(mode: ListViewMode) {
    setViewMode(mode);
    try {
      localStorage.setItem(VIEW_KEY, mode);
    } catch {
      /* storage blocked: the view lasts this page only */
    }
  }

  if (!data) return null;
  const { storages } = data;
  const q = search.trim().toLowerCase();
  const filtered = storages.filter((s) => !q || [s.name, description(s), s.isUsable ? "Connected" : "Not usable"].some((v) => v.toLowerCase().includes(q)));
  const status = (s: StorageItem) => <StatusBadge label={s.isUsable ? "Connected" : "Not usable"} type={s.isUsable ? "success" : "error"} />;

  return (
    <div className="application-settings-form w-full">
      <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-[24px]! leading-7! font-semibold! tracking-tight!">Storage</h1>
          <p className="mt-1 text-[13px] text-neutral-500 dark:text-fg-dim">
            {storages.length} {storages.length === 1 ? "storage destination" : "storage destinations"} for backups
          </p>
        </div>
        {data.canCreate ? (
          <div className="w-fit shrink-0">
            <ModalInput
              title="New Storage"
              open={open}
              onOpenChange={setOpen}
              closeOutside={false}
              trigger={
                <button type="button" className="button button-highlighted">
                  <Reicon name="plus" className="size-3.5" />
                  New storage
                </button>
              }
            >
              <NewStorageForm canCreate={data.canCreate} />
            </ModalInput>
          </div>
        ) : null}
      </header>

      {storages.length === 0 ? (
        <Empty title="No storage yet" description="Add an S3-compatible, SFTP, FTPS, or WebDAV destination to store backups outside your servers." iconName="storages" />
      ) : (
        <div>
          <ListSearchControls placeholder="Search storages" search={search} onSearch={setSearch} viewMode={viewMode} onViewMode={changeView} />
          {viewMode === "grid" ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {filtered.map((s) => (
                <a
                  key={s.uuid}
                  href={`/storages/${s.uuid}`}
                  className="group flex min-h-28 flex-col rounded-xl border border-neutral-200 bg-white p-3 shadow-sm transition-all hover:-translate-y-px hover:border-neutral-300 hover:no-underline hover:shadow-md dark:border-white/[0.08] dark:bg-white/[0.05] dark:hover:border-white/[0.14]"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-fg-dim">
                      <Reicon name="storages" className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-[13px]! leading-4! font-semibold! text-black dark:text-fg">{s.name}</h2>
                      <p className="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-fg-faint">{description(s)}</p>
                    </div>
                  </div>
                  <div className="mt-auto pt-4">{status(s)}</div>
                </a>
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.05]">
              <div className={`grid min-w-[620px] ${COLUMNS} border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[11px] font-medium text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-faint`}>
                <div>Storage</div>
                <div>Description</div>
                <div>Status</div>
              </div>
              {filtered.map((s) => (
                <a
                  key={s.uuid}
                  href={`/storages/${s.uuid}`}
                  className={`grid min-h-14 min-w-[620px] ${COLUMNS} items-center border-b border-neutral-200 px-4 py-2.5 text-[12px] transition-colors last:border-b-0 hover:bg-neutral-50 hover:no-underline dark:border-white/[0.07] dark:hover:bg-white/[0.025]`}
                >
                  <div className="truncate font-semibold text-black dark:text-fg">{s.name}</div>
                  <div className="truncate text-neutral-500 dark:text-fg-dim">{description(s)}</div>
                  <div>{status(s)}</div>
                </a>
              ))}
            </div>
          )}
          {filtered.length === 0 ? <ListSearchEmpty label="S3 storages" /> : null}
        </div>
      )}
    </div>
  );
}

export function StoragesPage() {
  return (
    <Layout title="Storage" href="/storages" navHref="/storages" documentTitle="Storages">
      <StoragesContent />
    </Layout>
  );
}

// ------------------------------------------------------------ /storages/{uuid}

export type StorageTab = "general" | "resources" | "danger";

/** The storage's uuid from /storages/{uuid}/…. */
export const storageUuidFromPath = (pathname = window.location.pathname): string => decodeURIComponent(pathname.split("/")[2] ?? "");

function StorageWorkspace({ storage, tab, children }: { storage: StorageDetail; tab: StorageTab; children: ReactNode }) {
  const base = `/storages/${storage.uuid}`;
  const items: Array<{ label: string; path: string; icon: string; key: StorageTab }> = [
    { label: "General", path: "", icon: "settings", key: "general" },
    { label: "Resources", path: "/resources", icon: "grid", key: "resources" },
    { label: "Danger Zone", path: "/danger", icon: "danger", key: "danger" },
  ];
  return (
    <div>
      <DashboardTitle title={storage.name} subtitle={storage.description || "S3-compatible backup destination"} />
      <section className="application-settings-workspace mt-4 w-full max-w-none lg:mt-0">
        <div className="grid min-w-0 gap-8 xl:grid-cols-[210px_minmax(0,1fr)] xl:gap-8">
          <aside className="application-settings-navigation min-w-0">
            <nav aria-label="S3 storage settings" className="grid grid-cols-1 gap-0.5">
              {items.map((item) => (
                <div key={item.key} className="contents">
                  {item.key === "danger" ? <div className="col-span-full my-2 border-t border-neutral-200 dark:border-white/[0.06]" aria-hidden="true" /> : null}
                  <a className={item.key === tab ? "menu-item menu-item-active" : "menu-item"} href={base + item.path}>
                    <Reicon name={item.icon} className="menu-item-icon" />
                    <span className="menu-item-label">{item.label}</span>
                  </a>
                </div>
              ))}
            </nav>
          </aside>
          <div className="min-w-0">{children}</div>
        </div>
      </section>
    </div>
  );
}

interface ShowData {
  storage: StorageDetail;
  canUpdate: boolean;
  canDelete: boolean;
  canValidate: boolean;
}

interface FormState {
  name: string;
  description: string;
  parts: DomainUrlParts;
  bucket: string;
  region: string;
  key: string;
  secret: string;
  usePathStyleEndpoint: boolean;
  skipTlsVerification: boolean;
}

const formOf = (s: StorageDetail): FormState => ({
  name: s.name,
  description: s.description ?? "",
  parts: splitUrl(s.endpoint),
  bucket: s.bucket ?? "",
  region: s.region,
  key: s.key,
  secret: "",
  usePathStyleEndpoint: s.usePathStyleEndpoint,
  skipTlsVerification: s.skipTlsVerification,
});

/** livewire/storage/form: General. */
function StorageGeneral({ data, base, onSaved }: { data: ShowData; base: string; onSaved: (s: StorageDetail) => void }) {
  const { storage, canUpdate } = data;
  const [form, setForm] = useState<FormState>(() => formOf(storage));
  const [partsChanged, setPartsChanged] = useState(false);
  const [chosen, setChosen] = useState(storage.usePathStyleEndpointChosen);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const saved = formOf(storage);
  const dirty = canUpdate && JSON.stringify({ ...form, parts: composeUrl(form.parts) }) !== JSON.stringify({ ...saved, parts: composeUrl(saved.parts) });
  const endpoint = partsChanged ? composeUrl(form.parts) : (storage.endpoint ?? "");
  const set = <K extends keyof FormState>(k: K) => (v: FormState[K]) => setForm((x) => ({ ...x, [k]: v }));
  const body = () => ({ name: form.name, description: form.description, endpoint, bucket: form.bucket, region: form.region, key: form.key, secret: form.secret, usePathStyleEndpoint: form.usePathStyleEndpoint, skipTlsVerification: form.skipTlsVerification, isUsable: storage.isUsable });

  async function submit() {
    setSaving(true);
    const r = await postJson<{ storage: StorageDetail; message: string }>(base, body(), "PATCH");
    setSaving(false);
    if (!r.ok) {
      setErrors(fieldErrors(r.error));
      return;
    }
    setErrors({});
    onSaved(r.data.storage);
    setForm(formOf(r.data.storage));
    setPartsChanged(false);
    notify.success(r.data.message);
  }

  /** Form::testConnection(): the form's values as they are; Freeploy shows Coolify's toasts. */
  async function testConnection() {
    const r = await postJson<{ valid: boolean; title: string; message: string; usePathStyleEndpoint: boolean; isUsable: boolean }>(`${base}/validate`, body());
    if (!r.ok) return notify.error(summarize(r.error.messages));
    toast(r.data.title, { type: r.data.valid ? "success" : "danger", description: r.data.message });
    setForm((x) => ({ ...x, usePathStyleEndpoint: r.data.usePathStyleEndpoint }));
    onSaved({ ...storage, isUsable: r.data.isUsable });
  }

  return (
    <form
      className="application-settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <UnsavedBar dirty={dirty} saving={saving} onSave={() => void submit()} />
      <SettingsSection
        title="General"
        helper={`${storage.type === "s3" ? "S3-compatible destination" : `${storage.typeLabel} destination`} used by database and volume backups.`}
        actions={
          data.canValidate ? (
            <Button onClick={() => void testConnection()}>
              <Reicon name="check-circle" className="size-3.5" />
              Validate connection
            </Button>
          ) : undefined
        }
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <FormInput id="name" label="Name" value={form.name} onChange={set("name")} disabled={!canUpdate} error={errors.name} />
          <FormInput id="description" label="Description" value={form.description} onChange={set("description")} disabled={!canUpdate} error={errors.description} />
          <FormInput label="Type" value={storage.typeLabel} disabled helper="The type cannot change after creation. Create a new storage for another type." />
          <div />
          <div className="lg:col-span-2">
            {canUpdate ? (
              <DomainInput
                id="endpointParts"
                parts={form.parts}
                error={errors.endpoint}
                onChange={(parts) => {
                  setForm((x) => ({ ...x, parts, usePathStyleEndpoint: chosen ? x.usePathStyleEndpoint : detectPathStyleEndpoint(composeUrl(parts)) }));
                  setPartsChanged(true);
                }}
              />
            ) : (
              <FormInput label="Endpoint" value={storage.endpoint ?? ""} disabled />
            )}
          </div>
          <FormInput id="bucket" label="Bucket" required value={form.bucket} onChange={set("bucket")} disabled={!canUpdate} error={errors.bucket} />
          <FormInput id="region" label="Region" required value={form.region} onChange={set("region")} disabled={!canUpdate} error={errors.region} />
          {storage.isPasswordHiddenForMember ? (
            <>
              <FormInput label="Access key" disabled value="Hidden (only admins can view)" />
              <FormInput label="Secret key" disabled value="Hidden (only admins can view)" />
            </>
          ) : (
            <>
              <FormInput id="key" label="Access key" required type="password" value={form.key} onChange={set("key")} disabled={!canUpdate} error={errors.key} />
              <FormInput
                id="secret"
                label="Secret key"
                type="password"
                required={!storage.hasSavedSecret}
                placeholder={storage.hasSavedSecret ? "Saved. Leave empty to keep it." : ""}
                value={form.secret}
                onChange={set("secret")}
                disabled={!canUpdate}
                error={errors.secret}
              />
            </>
          )}
          <Checkbox
            id="usePathStyleEndpoint"
            label="Use path-style URLs"
            helper={PATH_STYLE_HELPER}
            checked={form.usePathStyleEndpoint}
            onChange={(v) => (set("usePathStyleEndpoint")(v), setChosen(true))}
            disabled={!canUpdate}
          />
          <Checkbox id="skipTlsVerification" label="Skip TLS certificate verification" helper={SKIP_TLS_HELPER} checked={form.skipTlsVerification} onChange={set("skipTlsVerification")} disabled={!canUpdate} />
        </div>
      </SettingsSection>
    </form>
  );
}

interface ResourcesData {
  backups: Array<{ uuid: string; frequency: string; enabled: boolean; database: { uuid: string; name: string; projectUuid: string | null; environmentUuid: string | null } | null }>;
  storages: Array<{ uuid: string; name: string; isUsable: boolean }>;
  canUpdate: boolean;
}

/** livewire/storage/resources: the schedules that send to this storage; move one, or take this storage out of it. */
function StorageResources({ storage, base }: { storage: StorageDetail; base: string }) {
  const [data, setData] = useState<ResourcesData | null>(null);
  const [search, setSearch] = useState("");
  const [targets, setTargets] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    const r = await getJson<ResourcesData>(`${base}/resources`);
    if (r.data) setData(r.data);
  }, [base]);
  useEffect(() => void load(), [load]);
  if (!data) return null;

  async function act(path: string, method: "POST" | "DELETE", body: unknown = {}) {
    const r = await postJson<{ title: string; message: string }>(`${base}/resources/${path}`, body, method);
    if (!r.ok) {
      const res = refusalTitle(r.error.messages);
      return toast(res.title, { type: "danger", description: res.description });
    }
    toast(r.data.title, { type: "success", description: r.data.message });
    await load();
  }
  const q = search.toLowerCase();
  const rows = data.backups.filter((b) => !q || (b.database?.name ?? "Deleted database").toLowerCase().includes(q) || b.frequency.toLowerCase().includes(q));
  const grid = "grid min-w-[780px] grid-cols-[minmax(12rem,1fr)_9rem_7rem_minmax(12rem,1.2fr)_4.5rem]";

  return (
    <div className="application-settings-form">
      <SettingsSection title="Backup schedules" helper="Schedules currently writing backup data to this storage." flush>
        {data.backups.length === 0 ? (
          <Empty title="No backup schedules use this storage" description="Select this storage from a database or volume backup schedule to see it here." iconName="storages" size="sm" />
        ) : (
          <>
            <div className="border-b border-neutral-200 p-3 dark:border-white/[0.08]">
              <div className="relative w-full max-w-sm">
                <Reicon name="search" className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  type="search"
                  placeholder="Search backup schedules"
                  className="h-8! w-full rounded-lg! border-neutral-200! bg-white! py-0! pr-3! pl-8! text-[12px]! shadow-none! placeholder:text-neutral-400 focus:border-accent! focus:ring-0! dark:border-white/[0.08]! dark:bg-white/[0.035]! dark:text-fg! dark:placeholder:text-fg-faint"
                />
              </div>
            </div>
            <div className="overflow-x-auto">
              <div className={`${grid} border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[11px] font-medium text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-faint`}>
                <div>Backup target</div>
                <div>Frequency</div>
                <div>Status</div>
                <div>Storage</div>
                <div className="text-right">Actions</div>
              </div>
              {rows.map((b) => {
                const link = b.database?.projectUuid && b.database.environmentUuid ? `/project/${b.database.projectUuid}/environment/${b.database.environmentUuid}/database/${b.database.uuid}/backups` : null;
                return (
                  <div key={b.uuid} className={`${grid} min-h-14 items-center border-b border-neutral-200 px-4 py-2.5 text-[12px] last:border-b-0 dark:border-white/[0.07]`}>
                    <div className="min-w-0">
                      {link ? (
                        <a className="truncate font-medium text-black hover:underline dark:text-fg" href={link}>
                          {b.database!.name}
                        </a>
                      ) : (
                        <span className="truncate font-medium text-black dark:text-fg">{b.database?.name ?? "Deleted database"}</span>
                      )}
                    </div>
                    <div>
                      {link ? (
                        <a className="text-neutral-500 hover:underline dark:text-fg-dim" href={`${link}?schedule=${b.uuid}`}>
                          {b.frequency}
                        </a>
                      ) : (
                        <span className="text-neutral-500 dark:text-fg-dim">{b.frequency}</span>
                      )}
                    </div>
                    <div className="flex items-center">
                      <StatusBadge label={b.enabled ? "Enabled" : "Disabled"} type={b.enabled ? "success" : "warning"} />
                    </div>
                    <div className="flex items-end gap-2">
                      <Listbox
                        id={`selectedStorages.${b.uuid}`}
                        options={data.storages.map((s) => ({ value: s.uuid, label: s.name + (s.isUsable ? "" : " (unusable)"), disabled: !s.isUsable }))}
                        value={targets[b.uuid] ?? storage.uuid}
                        onChange={(v) => setTargets((t) => ({ ...t, [b.uuid]: v }))}
                        disabled={!data.canUpdate}
                      />
                      <button type="button" className="button shrink-0" disabled={!data.canUpdate} onClick={() => void act(`${b.uuid}/move`, "POST", { storage_uuid: targets[b.uuid] ?? storage.uuid })}>
                        Move
                      </button>
                    </div>
                    <div className="flex justify-end">
                      <ModalConfirmation
                        title="Remove this storage from the backup schedule?"
                        disabled={!data.canUpdate}
                        trigger={
                          <button type="button" className="icon-button shrink-0 text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300" title="Disable storage" aria-label="Remove this storage from the backup schedule">
                            <Reicon name="trash" className="size-3.5" />
                          </button>
                        }
                        actions={["Backups from this schedule will no longer be uploaded to this storage. S3 backup turns off when no other storage remains."]}
                        confirmationText={null}
                        step2ButtonText="Remove storage"
                        onSubmit={() => act(b.uuid, "DELETE")}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </SettingsSection>
    </div>
  );
}

/** Resources' refusals as Coolify's toasts: "No change." titles the one with a description; the others are their own title. */
function refusalTitle(messages: string[]): { title: string; description: string } {
  const message = summarize(messages);
  if (message === "The backup is already using this storage.") return { title: "No change.", description: message };
  return { title: message, description: "" };
}

function StorageShowContent({ tab }: { tab: StorageTab }) {
  const { me } = useSignedIn();
  const uuid = storageUuidFromPath();
  const base = `${storagesApi(me.team?.id)}/${encodeURIComponent(uuid)}`;
  const [data, setData] = useState<ShowData | null>(null);
  useEffect(() => {
    void (async () => {
      const r = await getJson<ShowData>(base);
      // Show::mount(): abort(404) where Coolify; here back to the list (as the other show pages do).
      if (!r.data) {
        if (r.status === 404) window.location.replace("/storages");
        return;
      }
      setData(r.data);
      document.title = `${r.data.storage.name.slice(0, 20)} | Storage | Freeploy`;
    })();
  }, [base]);
  if (!data) return null;
  const { storage } = data;

  async function remove() {
    const r = await postJson<{ deleted: boolean }>(base, {}, "DELETE");
    if (!r.ok) return notify.error(summarize(r.error.messages));
    window.location.assign("/storages");
  }

  return (
    <StorageWorkspace storage={storage} tab={tab}>
      {tab === "general" ? <StorageGeneral data={data} base={base} onSaved={(s) => setData((d) => (d ? { ...d, storage: s } : d))} /> : null}
      {tab === "resources" ? <StorageResources storage={storage} base={base} /> : null}
      {tab === "danger" ? (
        <div className="application-settings-form">
          <SettingsSection id="storage-danger-section" title="Danger zone" helper="Destructive actions for this S3 storage destination cannot be undone.">
            <DangerZone
              title="Delete storage"
              action={
                data.canDelete ? (
                  <ModalConfirmation
                    title="Confirm Storage Deletion?"
                    buttonTitle="Delete"
                    actions={[
                      "The selected storage location will be permanently deleted from Freeploy.",
                      ...(storage.backupCount > 0 ? [`${storage.backupCount} backup schedule(s) will stop saving to S3. Existing objects in this storage will not be deleted.`] : []),
                    ]}
                    confirmationText={storage.name}
                    confirmationLabel="Please confirm the execution of the actions by entering the Storage Name below"
                    shortConfirmationLabel="Storage Name"
                    step2ButtonText="Permanently Delete"
                    onSubmit={remove}
                  />
                ) : (
                  <Button error disabled tooltip="You do not have permission to delete this storage.">
                    Delete
                  </Button>
                )
              }
            >
              <p>
                Permanently delete <strong className="font-semibold text-black dark:text-fg">{storage.name}</strong> from Freeploy. Existing objects in the bucket are not deleted.
              </p>
              <ul className="space-y-1 text-xs">
                <li>• Backup schedules pointing at this storage will stop writing to S3.</li>
                {storage.backupCount > 0 ? <li>• {storage.backupCount} backup schedule(s) currently use this destination.</li> : null}
                <li>• Bucket contents on the provider are left untouched.</li>
                <li>• This storage destination cannot be restored from Freeploy after deletion.</li>
              </ul>
            </DangerZone>
            {data.canDelete ? null : (
              <div className="mt-4">
                <DangerCallout title="Insufficient permissions">Contact a team administrator if this storage must be deleted.</DangerCallout>
              </div>
            )}
          </SettingsSection>
        </div>
      ) : null}
    </StorageWorkspace>
  );
}

export function StorageShowPage({ tab }: { tab: StorageTab }) {
  return (
    <Layout title="Storage" href="/storages" navHref="/storages" documentTitle="Storage">
      <StorageShowContent tab={tab} />
    </Layout>
  );
}
