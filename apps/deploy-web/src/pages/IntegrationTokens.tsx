// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/security/integration-tokens.blade.php,
// resources/views/livewire/security/integration-token-form.blade.php,
// resources/views/livewire/security/integration-token-editor.blade.php and
// app/Livewire/Security/{IntegrationTokens,IntegrationTokenForm,IntegrationTokenEditor}.php (Apache-2.0), modified.
//
// /security/integration-tokens: the org's Cloudflare, Doppler, Infisical and HashiCorp Vault tokens. Add one (the
// provider is asked whether it works first; a Cloudflare token's zones are read with it) and edit one in Coolify's
// editor dialog: rename, rotate, change the capabilities and settings, refresh a Cloudflare token's zones, delete.
// Livewire's dispatch('success' | 'error', …) are the same toasts here. No token is ever loaded back.
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { ago } from "../lib/ago";
import { Reicon } from "../components/Reicon";
import { Button, Checkbox, Empty, FormInput, Listbox, ModalConfirmation, ModalInput, SettingsSection } from "../components/Coolify";
import { SecurityLayout } from "./SecurityLayout";
import {
  INITIAL_FORM,
  INTEGRATION_PROVIDER_OPTIONS,
  cloudflareTokenTemplateUrl,
  metadataFields,
  newSecretField,
  plural,
  secretLabel,
  settingsOf,
  toggleCapability,
  tokenNamePlaceholder,
  withProvider,
  zoneCount,
  type IntegrationFormState,
  type IntegrationMetadata,
} from "../lib/integration-tokens";

interface IntegrationTokenItem {
  uuid: string;
  name: string;
  provider: string;
  providerName: string;
  capabilities: string[];
  automaticDns: boolean;
  dnsZonesCount: number;
}

interface IntegrationTokenDetail extends IntegrationTokenItem {
  metadata: Record<string, unknown>;
  proxiedDns: boolean;
  zones: Array<{ id: number; name: string; accountName: string | null; managedRecordsCount: number }>;
  zonesSyncedAt: string | null;
  canUpdate: boolean;
}

const BOX = "rounded-lg border border-neutral-200 p-1 dark:border-white/[0.08]";
const NOTE = "rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-[11px] leading-5 text-neutral-600 dark:border-white/[0.08] dark:bg-white/[0.025] dark:text-fg-dim";
const HINT = "px-2.5 pb-2 text-[11px] text-neutral-500 dark:text-fg-dim";
const ROW = "grid min-h-14 w-full grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)_2rem] items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-white/[0.025]";

/** The first message of each field a save refused. */
function firstErrors(fields: Record<string, string[]> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [k, v[0] ?? ""]));
}

function ExternalLink() {
  return (
    <svg className="inline-flex h-3 w-3 text-black dark:text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  );
}

/** The Capabilities fieldset of a Cloudflare token (DNS is disabled while Cloudflare Tunnel is checked). */
function CloudflareCapabilities({ prefix, capabilities, onChange, error, disabled = false }: { prefix: string; capabilities: string[]; onChange: (next: string[]) => void; error?: string | undefined; disabled?: boolean }) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-black dark:text-fg">Capabilities</legend>
      <div className={`mt-3 ${BOX}`}>
        <Checkbox id={`${prefix}dns-capability`} label="DNS" fullWidth disabled={disabled || capabilities.includes("tunnel")} checked={capabilities.includes("dns")} onChange={(c) => onChange(toggleCapability(capabilities, "dns", c))} />
        <p className={HINT}>Manage Cloudflare DNS records.</p>
        <Checkbox id={`${prefix}tunnel-capability`} label="Cloudflare Tunnel" fullWidth disabled={disabled} checked={capabilities.includes("tunnel")} onChange={(c) => onChange(toggleCapability(capabilities, "tunnel", c))} />
        <p className={HINT}>Create and manage tunnels for server SSH. Needs DNS.</p>
      </div>
      {error ? <span className="text-xs text-red-500">{error}</span> : null}
    </fieldset>
  );
}

/** The Automatically configure DNS and Proxy DNS records checkboxes. */
function CloudflareDnsSettings({ prefix, automaticDns, proxiedDns, onAutomatic, onProxied, disabled }: { prefix: string; automaticDns: boolean; proxiedDns: boolean; onAutomatic: (v: boolean) => void; onProxied: (v: boolean) => void; disabled: boolean }) {
  return (
    <>
      <div className={BOX}>
        <Checkbox id={`${prefix}automatic-dns`} label="Automatically configure DNS" fullWidth disabled={disabled} checked={automaticDns} onChange={onAutomatic} />
        <p className={HINT}>Create DNS records automatically when a new domain has one unambiguous matching credential.</p>
      </div>
      <div className={BOX}>
        <Checkbox id={`${prefix}proxied-dns`} label="Proxy DNS records through Cloudflare" fullWidth disabled={disabled} checked={proxiedDns} onChange={onProxied} />
        <p className={HINT}>Create new DNS records with the Cloudflare proxy on (orange cloud), so the server IP is not public. Existing records keep their proxy status.</p>
      </div>
    </>
  );
}

/** The permissions a Cloudflare token needs, and the link that pre-fills them. */
function CloudflarePermissions({ capabilities, editor }: { capabilities: string[]; editor: boolean }) {
  return (
    <div className={NOTE}>
      <div className="font-medium text-black dark:text-fg">Required Cloudflare permissions</div>
      <ul className="list-inside list-disc">
        <li>Zone - DNS - Edit</li>
        <li>Zone - Zone - Read</li>
        {capabilities.includes("tunnel") ? <li>Account - Cloudflare Tunnel - Edit</li> : null}
      </ul>
      {editor ? (
        <a href={cloudflareTokenTemplateUrl(capabilities)} target="_blank" rel="noopener noreferrer" className="font-medium text-coollabs hover:underline dark:text-brand-light">
          Create a replacement token in Cloudflare
        </a>
      ) : (
        <>
          <p>Limit zone resources to the zones Coolify should manage.</p>
          <a href={cloudflareTokenTemplateUrl(capabilities)} target="_blank" rel="noopener noreferrer" className="button mt-2">
            Create token at Cloudflare
            <ExternalLink />
          </a>
        </>
      )}
    </div>
  );
}

function Note({ title, children, href, link }: { title: string; children: ReactNode; href?: string; link?: string }) {
  return (
    <div className={NOTE}>
      <div className="font-medium text-black dark:text-fg">{title}</div>
      <p>{children}</p>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="button mt-2">
          {link}
          <ExternalLink />
        </a>
      ) : null}
    </div>
  );
}

const TIMEOUT_HELPER = "Seconds to wait for each request. Increase it if your instance responds slowly.";

/** integration-token-form.blade.php. onAdded is integrationTokenAdded and close-modal. */
function IntegrationTokenForm({ base, onAdded }: { base: string; onAdded: () => void }) {
  const [state, setState] = useState<IntegrationFormState>(INITIAL_FORM);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const { provider, capabilities, metadata } = state;
  const setMeta = (key: string) => (value: string) => setState((s) => ({ ...s, metadata: { ...s.metadata, [key]: value } }));
  const meta = (key: string) => metadata[key] ?? "";

  async function addToken(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAdding(true);
    const r = await postJson<{ uuid: string; message: string }>(base, { provider, name, token, capabilities, metadata: settingsOf(provider, metadata), automaticDns: state.automaticDns, proxiedDns: state.proxiedDns });
    setAdding(false);
    if (!r.ok) {
      const inline = firstErrors(r.error.fields);
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    setErrors({});
    // $this->reset(['name', 'token'])
    setName("");
    setToken("");
    notify.success(r.data.message);
    onAdded();
  }

  return (
    <div className="w-full">
      <form className="application-settings-form flex w-full flex-col gap-4" onSubmit={(e) => void addToken(e)}>
        <Listbox required id="provider" label="Provider" options={[...INTEGRATION_PROVIDER_OPTIONS]} value={provider} onChange={(p) => setState(withProvider(p))} error={errors.provider} />

        {provider === "infisical" ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <FormInput required id="name" label="Token name" placeholder="Production secrets" value={name} onChange={setName} error={errors.name} />
            <FormInput required id="metadata.client_id" label="Client ID" placeholder="Machine identity client ID" value={meta("client_id")} onChange={setMeta("client_id")} error={errors["metadata.client_id"]} />
            <FormInput required type="password" id="token" label="Client secret" placeholder="Paste the machine identity client secret" value={token} onChange={setToken} error={errors.token} />
            <FormInput required id="metadata.base_url" label="Base URL" placeholder="https://app.infisical.com" helper="Use the URL of your self-hosted Infisical instance, or the Infisical cloud URL." value={meta("base_url")} onChange={setMeta("base_url")} error={errors["metadata.base_url"]} />
            <FormInput type="number" min={1} max={300} id="metadata.timeout" label="Request timeout (optional)" placeholder="10" helper={TIMEOUT_HELPER} value={meta("timeout")} onChange={setMeta("timeout")} error={errors["metadata.timeout"]} />
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <FormInput required id="name" label="Token name" placeholder={tokenNamePlaceholder(provider)} value={name} onChange={setName} error={errors.name} />
            <FormInput required type="password" id="token" label={secretLabel(provider)} placeholder="Paste the provider token" value={token} onChange={setToken} error={errors.token} />
          </div>
        )}

        {provider === "vault" ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <FormInput required id="metadata.base_url" label="Base URL" placeholder="https://vault.example.com:8200" value={meta("base_url")} onChange={setMeta("base_url")} error={errors["metadata.base_url"]} />
            <FormInput id="metadata.namespace" label="Namespace (optional)" placeholder="admin/team-a" helper="Only for Vault Enterprise / HCP Vault." value={meta("namespace")} onChange={setMeta("namespace")} error={errors["metadata.namespace"]} />
            <FormInput type="number" min={1} max={300} id="metadata.timeout" label="Request timeout (optional)" placeholder="10" helper={TIMEOUT_HELPER} value={meta("timeout")} onChange={setMeta("timeout")} error={errors["metadata.timeout"]} />
          </div>
        ) : null}

        {provider === "cloudflare" ? (
          <>
            <CloudflareCapabilities prefix="" capabilities={capabilities} onChange={(next) => setState((s) => ({ ...s, capabilities: next }))} error={errors.capabilities} />
            <CloudflareDnsSettings prefix="" automaticDns={state.automaticDns} proxiedDns={state.proxiedDns} disabled={false} onAutomatic={(v) => setState((s) => ({ ...s, automaticDns: v }))} onProxied={(v) => setState((s) => ({ ...s, proxiedDns: v }))} />
          </>
        ) : (
          <div className={NOTE}>
            <div className="font-medium text-black dark:text-fg">Capability: Secrets (read-only)</div>
            <p>
              Coolify reads secrets from this provider at deployment time and writes them into the generated <code>.env</code> file. Secret values are never stored in the Coolify database.
            </p>
          </div>
        )}

        {provider === "cloudflare" && capabilities.includes("dns") ? <CloudflarePermissions capabilities={capabilities} editor={false} /> : null}
        {provider === "doppler" ? (
          <Note title="Recommended Doppler token" href="https://dashboard.doppler.com?ref=coolify.io" link="Open Doppler dashboard">
            Use a read-only <span className="font-medium">Service Token</span> (dp.st.*). It is pinned to one project and config. Create it in Doppler under Project &gt; Config &gt; Access.
          </Note>
        ) : null}
        {provider === "infisical" ? (
          <Note title="Infisical machine identity" href="https://app.infisical.com?ref=coolify.io" link="Open Infisical Cloud">
            Create a machine identity with Universal Auth and read access to your project. Paste the client ID above and the client secret in the secret field.
          </Note>
        ) : null}
        {provider === "vault" ? (
          <Note title="Vault token" href="https://portal.cloud.hashicorp.com?ref=coolify.io" link="Open HCP Vault">
            Use a token with read access to your KV v2 secrets. Prefer a periodic or long-lived token — deployments fail when the token expires.
          </Note>
        ) : null}

        <div className="flex justify-end border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
          <Button type="submit" highlighted disabled={adding}>
            Validate and add
          </Button>
        </div>
      </form>
    </div>
  );
}

/** integration-token-editor.blade.php: onSaved is integration-token-updated, onDeleted integration-token-deleted and close-modal. */
function IntegrationTokenEditor({ base, uuid, onSaved, onDeleted }: { base: string; uuid: string; onSaved: () => void; onDeleted: () => void }) {
  const [data, setData] = useState<IntegrationTokenDetail | null>(null);
  const [name, setName] = useState("");
  const [newToken, setNewToken] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [metadata, setMetadata] = useState<IntegrationMetadata>({});
  const [automaticDns, setAutomaticDns] = useState(true);
  const [proxiedDns, setProxiedDns] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const url = `${base}/${encodeURIComponent(uuid)}`;

  /** mount(), and what save() and refreshZones() load again. */
  const apply = useCallback((d: IntegrationTokenDetail) => {
    setData(d);
    setName(d.name);
    setCapabilities(d.capabilities);
    setMetadata(metadataFields(d.metadata));
    setAutomaticDns(d.automaticDns);
    setProxiedDns(d.proxiedDns);
  }, []);
  useEffect(() => {
    void getJson<IntegrationTokenDetail>(url).then((r) => {
      if (r.data) apply(r.data);
      else notify.error("Integration token not found.");
    });
  }, [url, apply]);
  if (!data) return null;
  const provider = data.provider;
  const disabled = !data.canUpdate;
  const meta = (key: string) => metadata[key] ?? "";
  const setMeta = (key: string) => (value: string) => setMetadata((m) => ({ ...m, [key]: value }));
  const secret = newSecretField(provider);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const r = await postJson<{ token: IntegrationTokenDetail; message: string }>(url, { name, newToken, capabilities, metadata: settingsOf(provider, metadata), automaticDns, proxiedDns }, "PATCH");
    setBusy(false);
    if (!r.ok) {
      const inline = firstErrors(r.error.fields);
      setErrors(inline);
      if (!Object.keys(r.error.fields ?? {}).length) notify.error(summarize(r.error.messages));
      return;
    }
    setErrors({});
    setNewToken("");
    apply(r.data.token);
    notify.success(r.data.message);
    onSaved();
  }

  async function refreshZones() {
    const r = await postJson<{ token: IntegrationTokenDetail; message: string }>(`${url}/refresh-zones`, {});
    if (!r.ok) return notify.error(summarize(r.error.messages));
    apply(r.data.token);
    notify.success(r.data.message);
  }

  return (
    <div className="w-full">
      <form className="application-settings-form flex w-full flex-col gap-4" onSubmit={(e) => void save(e)}>
        <div className="grid gap-4 lg:grid-cols-2">
          <FormInput required id="name" label="Token name" value={name} onChange={setName} disabled={disabled} error={errors.name} />
          <FormInput readOnly label="Provider" value={data.providerName} />
          <div className="lg:col-span-2">
            <FormInput type="password" id="newToken" label={secret.label} placeholder="Leave blank to keep the current token" helper={secret.helper} value={newToken} onChange={setNewToken} disabled={disabled} error={errors.newToken} />
          </div>
        </div>

        {provider === "infisical" ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <FormInput required id="metadata.base_url" label="Base URL" placeholder="https://app.infisical.com" value={meta("base_url")} onChange={setMeta("base_url")} disabled={disabled} error={errors["metadata.base_url"]} />
            <FormInput required id="metadata.client_id" label="Client ID" value={meta("client_id")} onChange={setMeta("client_id")} disabled={disabled} error={errors["metadata.client_id"]} />
            <FormInput type="number" min={1} max={300} id="metadata.timeout" label="Request timeout (optional)" placeholder="10" helper={TIMEOUT_HELPER} value={meta("timeout")} onChange={setMeta("timeout")} disabled={disabled} error={errors["metadata.timeout"]} />
          </div>
        ) : provider === "vault" ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <FormInput required id="metadata.base_url" label="Base URL" placeholder="https://vault.example.com:8200" value={meta("base_url")} onChange={setMeta("base_url")} disabled={disabled} error={errors["metadata.base_url"]} />
            <FormInput id="metadata.namespace" label="Namespace (optional)" value={meta("namespace")} onChange={setMeta("namespace")} disabled={disabled} error={errors["metadata.namespace"]} />
            <FormInput type="number" min={1} max={300} id="metadata.timeout" label="Request timeout (optional)" placeholder="10" helper={TIMEOUT_HELPER} value={meta("timeout")} onChange={setMeta("timeout")} disabled={disabled} error={errors["metadata.timeout"]} />
          </div>
        ) : null}

        {provider === "cloudflare" ? (
          <>
            <CloudflareCapabilities prefix="edit-" capabilities={capabilities} onChange={setCapabilities} error={errors.capabilities} disabled={disabled} />
            <CloudflareDnsSettings prefix="edit-" automaticDns={automaticDns} proxiedDns={proxiedDns} disabled={disabled} onAutomatic={setAutomaticDns} onProxied={setProxiedDns} />
          </>
        ) : (
          <div className={NOTE}>
            <div className="font-medium text-black dark:text-fg">Capability: Secrets (read-only)</div>
            <p>Coolify reads secrets from this provider at deployment time. Secret values are never stored in the Coolify database.</p>
          </div>
        )}

        {provider === "cloudflare" && capabilities.includes("dns") ? (
          <>
            <CloudflarePermissions capabilities={capabilities} editor />
            <div className="rounded-lg border border-neutral-200 dark:border-white/[0.08]">
              <div className="flex items-center justify-between gap-3 p-3">
                <div className="text-xs text-neutral-600 dark:text-fg-dim">
                  <div className="font-medium text-black dark:text-fg">Domains this token can manage</div>
                  <div>{zoneCount(data.zones.length, true)}</div>
                  {data.zonesSyncedAt ? <div>Last refreshed {ago(data.zonesSyncedAt)}</div> : null}
                </div>
                <Button disabled={disabled} onClick={() => void refreshZones()}>
                  Refresh zones
                </Button>
              </div>
              {data.zones.length ? (
                <div className="max-h-48 overflow-y-auto border-t border-neutral-200 dark:border-white/[0.08]">
                  {data.zones.map((z) => (
                    <div key={z.id} className="flex items-center justify-between gap-3 border-b border-neutral-200 px-3 py-2.5 last:border-b-0 dark:border-white/[0.08]">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-black dark:text-fg">{z.name}</div>
                        {z.accountName ? <div className="truncate text-[11px] text-neutral-500 dark:text-fg-dim">{z.accountName}</div> : null}
                      </div>
                      {z.managedRecordsCount > 0 ? (
                        <div className="shrink-0 text-[11px] text-neutral-500 dark:text-fg-dim">
                          {z.managedRecordsCount} managed {plural("record", z.managedRecordsCount)}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        <div className="flex items-center justify-between gap-2 border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
          {data.canUpdate ? (
            <ModalConfirmation
              title="Delete integration token?"
              buttonTitle="Delete"
              actions={["This integration token will be permanently deleted."]}
              confirmationText={data.name}
              step2ButtonText="Delete token"
              onSubmit={async () => {
                const r = await postJson<{ message: string }>(url, {}, "DELETE");
                if (!r.ok) return notify.error(summarize(r.error.messages));
                notify.success(r.data.message);
                onDeleted();
              }}
            />
          ) : (
            <span />
          )}
          <Button type="submit" highlighted disabled={disabled || busy}>
            Validate and save
          </Button>
        </div>
      </form>
    </div>
  );
}

function IntegrationTokensContent() {
  const { me } = useSignedIn();
  const base = `/v1/organizations/${me.team?.id ?? ""}/deploy/integration-tokens`;
  const [tokens, setTokens] = useState<IntegrationTokenItem[] | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  /** loadTokens(). */
  const reload = useCallback(async () => {
    const r = await getJson<{ tokens: IntegrationTokenItem[]; canWrite: boolean }>(base);
    if (!r.data) {
      if (r.status !== 401) notify.error("Failed to load integration tokens.");
      setTokens([]);
      return;
    }
    setTokens(r.data.tokens);
    setCanWrite(r.data.canWrite);
  }, [base]);
  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div>
      <SecurityLayout>
        <div className="application-settings-form">
          <SettingsSection
            title="Integration tokens"
            helper="Credentials used by third-party integrations such as DNS providers and secret managers."
            flush
            actions={
              canWrite ? (
                <ModalInput
                  title="New Integration Token"
                  open={addOpen}
                  onOpenChange={setAddOpen}
                  trigger={
                    <button type="button" className="button button-highlighted">
                      <Reicon name="plus" className="size-3.5" />
                      New token
                    </button>
                  }
                >
                  <IntegrationTokenForm
                    base={base}
                    onAdded={() => {
                      setAddOpen(false);
                      void reload();
                    }}
                  />
                </ModalInput>
              ) : undefined
            }
          >
            {tokens === null ? null : tokens.length === 0 ? (
              <Empty title="No integration tokens" description="Add a provider token to connect a third-party integration." iconName="keys" size="sm" />
            ) : (
              <div className="divide-y divide-neutral-200 dark:divide-white/[0.07]">
                {tokens.map((t) => (
                  <div key={t.uuid} className="border-b border-neutral-200 last:border-b-0 dark:border-white/[0.07]">
                    <div className={ROW}>
                      <div className="min-w-0">
                        <h3 className="truncate text-[13px]! font-semibold! text-black dark:text-fg">
                          <span>{t.name}</span>
                        </h3>
                      </div>
                      <div className="text-center text-[12px] text-neutral-500 dark:text-fg-dim">{t.providerName}</div>
                      <div className="flex flex-wrap gap-1">
                        {t.capabilities.map((capability) => (
                          <span key={capability} className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium uppercase text-neutral-600 dark:bg-white/[0.06] dark:text-fg-dim">
                            {capability}
                          </span>
                        ))}
                        {t.provider === "cloudflare" ? (
                          <>
                            {t.automaticDns ? <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium uppercase text-green-700 dark:bg-green-500/10 dark:text-green-400">Auto DNS</span> : null}
                            <span className="text-[11px] text-neutral-500 dark:text-fg-dim">{zoneCount(t.dnsZonesCount)}</span>
                          </>
                        ) : null}
                      </div>
                      <div className="flex justify-end">
                        <button type="button" className="icon-button" title="Edit integration token" aria-label={`Edit ${t.name}`} onClick={() => setEditing(t.uuid)}>
                          <Reicon name="settings" className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {/* One dialog for the list: Coolify renders an <x-modal-input> per row around the same editor. */}
            <ModalInput title="Edit Integration Token" open={editing !== null} onOpenChange={(open) => (open ? undefined : setEditing(null))} trigger={<span className="hidden" aria-hidden="true" />}>
              {editing ? (
                <IntegrationTokenEditor
                  key={editing}
                  base={base}
                  uuid={editing}
                  onSaved={() => void reload()}
                  onDeleted={() => {
                    setEditing(null);
                    void reload();
                  }}
                />
              ) : null}
            </ModalInput>
          </SettingsSection>
        </div>
      </SecurityLayout>
    </div>
  );
}

export function IntegrationTokensPage() {
  return (
    <Layout title="Keys & Tokens" href="/security/integration-tokens" documentTitle="Integration Tokens">
      <IntegrationTokensContent />
    </Layout>
  );
}
