// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/settings/updates.blade.php,
// resources/views/livewire/settings-backup.blade.php, resources/views/livewire/settings-email.blade.php,
// resources/views/livewire/partials/{settings-email-send-test,smtp-server-picker}.blade.php,
// resources/views/livewire/settings-oauth.blade.php and app/Livewire/{Settings/Updates,SettingsBackup,SettingsEmail,SettingsOauth}.php
// (Apache-2.0), modified.
//
// The platform's Updates, Backup, Email and Authentication settings (freeploy-coolify-parity DP12, DP-101), the
// platform operator's alone, in the Settings submenu of the sidebar beside DP-79's General and Advanced:
//   /settings/updates                 Updates (Settings\Updates): channel, custom image, check and update frequency,
//                                     automatic updates; "Check now" and "Upgrade now" say they are not available yet
//   /settings/backup                  Instance Backup (SettingsBackup): "Backup is not configured"; Configure backup
//                                     says it needs the SSH executor
//   /settings/email                   Transactional Email (SettingsEmail): None, SMTP or Resend, the notification
//                                     sender, "Send test" (not available yet)
//   /settings/oauth[/{provider}]      Authentication (SettingsOauth): the registration policy and each provider
// Every action is the component's, run by the API (deploy-core-worker handlers/platform-settings-more.ts): the
// page sends its fields and the action's name and shows the answer's toast or the fields' errors. Anyone else gets
// the API's 404 and this page Coolify's 404 page. Not here: the Docker registry (the deployment's configuration),
// the named SMTP servers and their templates, the provider list beside the sidebar entry (IMPLEMENTATION-STATUS.md,
// Notes on DP12).
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Layout } from "../layout/Layout";
import { edgeBase, getJson, postJson, summarize, type ApiError } from "../lib/api";
import { notify, toast } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Button, Callout, Checkbox, DangerCallout, Empty, FormInput, Listbox, ModalInput, SettingsSection, UnsavedBar } from "../components/Coolify";
import { PlatformNotFound } from "./PlatformAdmin";
import { SettingsLayout } from "./PlatformSettings";
import {
  channelCallout,
  defaultRedirectUri,
  EMAIL_PROVIDER_LABELS,
  frequencyFallback,
  INSTANCE_SETTINGS_API,
  isProviderHost,
  missingRequired,
  notActiveYet,
  oauthCheckboxes,
  oauthFields,
  UPDATE_CHANNEL_OPTIONS,
  type EmailProvider,
} from "../lib/instance-settings";

type Props = Record<string, unknown>;
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** The page's data from the API: null while loading, "missing" for the API's 404. */
function usePage<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [missing, setMissing] = useState(false);
  const load = useCallback(async () => {
    const r = await getJson<T>(path);
    if (r.data) setData(r.data);
    else if (r.status === 404) setMissing(true);
    else if (r.status !== 401) notify.error("Failed to load the settings.");
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, setData, missing, reload: load };
}

/** A component action: the answer, or the fields' errors (shown inline) and the toast of the rest. */
async function runAction<T>(path: string, body: Props): Promise<{ ok: true; data: T } | { ok: false; error: ApiError; fields: Record<string, string> }> {
  const r = await postJson<T>(path, body, "PATCH");
  if (r.ok) return r;
  const fields: Record<string, string> = {};
  for (const [f, m] of Object.entries(r.error.fields ?? {})) if (m[0]) fields[f] = m[0];
  toast(summarize(r.error.messages), { type: "danger", ...(r.error.description ? { description: r.error.description } : {}) });
  return { ok: false, error: r.error, fields };
}

// ── /settings/updates ───────────────────────────────────────────────────

interface UpdatesPage {
  settings: {
    auto_update_frequency: string;
    update_check_frequency: string;
    is_auto_update_enabled: boolean;
    update_channel: string;
    update_custom_tag: string | null;
    isUpgradeAvailable: boolean;
    latestVersion: string | null;
  };
  canUpdate: boolean;
}
const UPDATE_TARGETS = ["update_check_frequency", "auto_update_frequency", "update_channel", "update_custom_tag"] as const;

function Updates() {
  const { data, setData, missing } = usePage<UpdatesPage>(INSTANCE_SETTINGS_API.updates);
  const [fields, setFields] = useState<Props>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setFields({ ...data.settings });
  }, [data]);
  const run = useCallback(
    async (action: string, over: Props = {}) => {
      setBusy(true);
      const body: Props = { ...fields, ...over, action };
      const r = await runAction<{ settings: UpdatesPage["settings"]; message: string }>(INSTANCE_SETTINGS_API.updates, body);
      setBusy(false);
      if (!r.ok) {
        setErrors(r.fields);
        setFields({ ...fields, ...over, ...frequencyFallback(summarize(r.error.messages), str(body.auto_update_frequency), str(body.update_check_frequency)) });
        return;
      }
      setErrors({});
      const answer = r.data;
      setData((d) => (d ? { ...d, settings: answer.settings } : d));
      notify.success(answer.message);
    },
    [fields, setData],
  );
  if (missing) return <PlatformNotFound />;
  if (!data) return null;
  const { settings, canUpdate } = data;
  const dirty = canUpdate && UPDATE_TARGETS.some((k) => str(fields[k]) !== str(settings[k]));
  const channel = str(fields.update_channel) || "stable";
  const callout = channelCallout(channel);
  const input = (id: string, label: string, opts: { placeholder?: string; helper?: string; required?: boolean } = {}) => (
    <FormInput id={id} label={label} required={opts.required ?? false} disabled={!canUpdate} value={str(fields[id])} onChange={(v) => setFields({ ...fields, [id]: v })} error={errors[id]} {...(opts.placeholder ? { placeholder: opts.placeholder } : {})} {...(opts.helper ? { helper: opts.helper } : {})} />
  );
  return (
    <SettingsLayout>
      <form
        className="application-settings-form flex min-w-0 flex-col gap-6"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          if (canUpdate) void run("submit");
        }}
      >
        <UnsavedBar dirty={dirty} saving={busy} onSave={() => void run("submit")} />
        <SettingsSection
          title="Updates"
          helper="Install the latest Freeploy version manually when an update is available."
          actions={
            <>
              {settings.isUpgradeAvailable ? (
                <Button highlighted onClick={() => void run("upgrade")} disabled={!canUpdate}>
                  Upgrade now
                </Button>
              ) : null}
              <Button onClick={() => void run("checkManually")} disabled={!canUpdate}>
                <Reicon name="refresh" className="size-3.5" />
                Check now
              </Button>
            </>
          }
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <Listbox id="update_channel" label="Channel" helper="The versions this instance upgrades to." options={UPDATE_CHANNEL_OPTIONS} value={channel} disabled={!canUpdate} onChange={(v) => setFields({ ...fields, update_channel: v })} error={errors.update_channel} />
            {channel === "custom" ? input("update_custom_tag", "Image tag", { required: true, placeholder: "pr-1234", helper: "A tag of ghcr.io/coollabsio/coolify, such as pr-1234 for the build of pull request 1234." }) : <div className="hidden lg:block" />}
            {callout ? (
              <div className="lg:col-span-2">
                {callout.type === "danger" ? (
                  <DangerCallout title={callout.title} className="">
                    {callout.body}
                  </DangerCallout>
                ) : (
                  <Callout type="info" title={callout.title}>
                    {callout.body}
                  </Callout>
                )}
              </div>
            ) : null}
            {input("update_check_frequency", "Check frequency", { required: true, placeholder: "0 * * * *", helper: "A cron expression or preset such as hourly, daily, weekly, monthly, or yearly." })}
            <Listbox
              id="is_auto_update_enabled"
              label="Automatic updates"
              options={[
                { value: "true", label: "Enabled" },
                { value: "false", label: "Disabled" },
              ]}
              value={String(Boolean(fields.is_auto_update_enabled))}
              disabled={!canUpdate}
              onChange={(v) => {
                setFields({ ...fields, is_auto_update_enabled: v === "true" });
                void run("instantSave", { is_auto_update_enabled: v === "true" });
              }}
              error={errors.is_auto_update_enabled}
            />
            {fields.is_auto_update_enabled ? input("auto_update_frequency", "Update frequency", { required: true, placeholder: "0 0 * * *", helper: "Cron expression or preset for installing updates." }) : <FormInput label="Update frequency" disabled placeholder="Disabled" value="" />}
          </div>
        </SettingsSection>
      </form>
    </SettingsLayout>
  );
}

export function SettingsUpdatesPage() {
  return (
    <Layout title="Update Settings" href="/settings/updates">
      <Updates />
    </Layout>
  );
}

// ── /settings/backup ────────────────────────────────────────────────────

function Backup() {
  const { data, missing } = usePage<{ configured: boolean; canUpdate: boolean }>(INSTANCE_SETTINGS_API.backup);
  if (missing) return <PlatformNotFound />;
  if (!data) return null;
  return (
    <SettingsLayout>
      <div className="application-settings-form mx-auto flex w-full max-w-none min-w-0 flex-col gap-6">
        <SettingsSection title="Instance backup">
          <Empty title="Backup is not configured" description="Freeploy needs an internal database resource to create automatic backups." iconName="database" size="sm">
            <Button highlighted disabled={!data.canUpdate} onClick={() => void runAction(INSTANCE_SETTINGS_API.backup, { action: "addCoolifyDatabase" })}>
              Configure backup
            </Button>
          </Empty>
        </SettingsSection>
      </div>
    </SettingsLayout>
  );
}

export function SettingsBackupPage() {
  return (
    <Layout title="Instance Backup" href="/settings/backup">
      <Backup />
    </Layout>
  );
}

// ── /settings/email ─────────────────────────────────────────────────────

interface EmailPage {
  settings: Props & { emailProvider: EmailProvider; activeEmailProvider: EmailProvider; sendTestReason: string | null; testEmailAddress: string | null };
  canUpdate: boolean;
  message?: string | null;
  saved?: boolean;
}
const EMAIL_FIELDS = [
  "smtpFromName",
  "smtpFromAddress",
  "smtpHost",
  "smtpPort",
  "smtpEncryption",
  "smtpUsername",
  "smtpPassword",
  "smtpTimeout",
  "smtpEhloDomain",
  "resendApiKey",
  "resendFromName",
  "resendFromAddress",
  "notificationFromName",
  "notificationFromAddress",
];
const SMTP_GROUP = "flex flex-col gap-3 border-t border-neutral-200 pt-4 lg:col-span-3 dark:border-white/[0.08]";
const SMTP_GROUP_TITLE = "text-sm font-semibold text-black dark:text-fg";
const withDefault = (k: string, v: unknown) => v ?? (k === "smtpEncryption" ? "starttls" : null);

function Email() {
  const { data, setData, missing } = usePage<EmailPage>(INSTANCE_SETTINGS_API.email);
  const [fields, setFields] = useState<Props>({});
  const [provider, setProvider] = useState<EmailProvider>("none");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testAddress, setTestAddress] = useState("");
  const [withSender, setWithSender] = useState(false);
  useEffect(() => {
    if (!data) return;
    setFields(Object.fromEntries(EMAIL_FIELDS.map((k) => [k, withDefault(k, data.settings[k])])));
    setProvider(data.settings.emailProvider);
  }, [data]);
  useEffect(() => {
    if (data?.settings.testEmailAddress) setTestAddress(data.settings.testEmailAddress);
  }, [data?.settings.testEmailAddress]);
  const run = useCallback(
    async (action: string, over: Props = {}): Promise<EmailPage | null> => {
      setBusy(true);
      const r = await runAction<EmailPage>(INSTANCE_SETTINGS_API.email, { action, ...fields, emailProvider: provider, ...over });
      setBusy(false);
      if (!r.ok) {
        setErrors(r.fields);
        return null;
      }
      setErrors({});
      if (r.data.saved) setData(r.data);
      if (r.data.message) notify.success(r.data.message);
      return r.data;
    },
    [fields, provider, setData],
  );
  if (missing) return <PlatformNotFound />;
  if (!data) return null;
  const { settings, canUpdate } = data;
  const active = settings.activeEmailProvider;
  const dirty = canUpdate && EMAIL_FIELDS.some((k) => str(fields[k]) !== str(withDefault(k, settings[k])));
  const notice = notActiveYet(provider, active);
  const input = (prop: string, label: string, opts: { helper?: string; placeholder?: string; type?: "text" | "password" | "number"; required?: boolean } = {}) => (
    <FormInput
      id={prop}
      label={label}
      type={opts.type ?? "text"}
      required={opts.required ?? false}
      disabled={!canUpdate}
      value={str(fields[prop])}
      onChange={(v) => setFields({ ...fields, [prop]: v })}
      error={errors[prop]}
      {...(opts.helper ? { helper: opts.helper } : {})}
      {...(opts.placeholder ? { placeholder: opts.placeholder } : {})}
    />
  );
  const sendTest =
    settings.sendTestReason === null ? (
      <ModalInput
        title="Send Test Email"
        open={testOpen}
        onOpenChange={setTestOpen}
        trigger={
          <button type="button" className="button" onClick={() => setTestOpen(true)}>
            <Reicon name="notifications" className="size-3.5" />
            Send test
          </button>
        }
      >
        <form
          className="application-settings-form flex flex-col gap-4"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            setTestOpen(false);
            void run("sendTestEmail", { testEmailAddress: testAddress, testUsesNotificationSender: withSender });
          }}
        >
          <FormInput id="testEmailAddress" label="Recipient" placeholder="test@example.com" required value={testAddress} onChange={setTestAddress} />
          <Checkbox id="testUsesNotificationSender" label="Send from the notification sender" checked={withSender} onChange={setWithSender} />
          <div className="flex justify-end border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
            <button type="submit" className="button">
              Send email
            </button>
          </div>
        </form>
      </ModalInput>
    ) : (
      // Always shown, so that admins know a test is possible once a provider is saved.
      <button type="button" className="button" disabled title={settings.sendTestReason}>
        <Reicon name="notifications" className="size-3.5" />
        Send test
      </button>
    );

  return (
    <SettingsLayout>
      <div className="application-settings-form mx-auto flex w-full max-w-none min-w-0 flex-col gap-6">
        <UnsavedBar dirty={dirty} saving={busy} onSave={() => void run("submit")} />
        <form
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            if (canUpdate) void run("submit");
          }}
        >
          <SettingsSection
            title="Email delivery"
            helper="Only one provider sends email. Select a provider to see its settings."
            badges={
              <div className="w-40">
                <Listbox
                  id="emailProvider"
                  disabled={!canUpdate}
                  options={(["none", "smtp", "resend"] as const).map((value) => ({ value, label: EMAIL_PROVIDER_LABELS[value] }))}
                  value={provider}
                  onChange={(v) => {
                    const next = v as EmailProvider;
                    setProvider(next);
                    void run("selectEmailProvider", { emailProvider: next });
                  }}
                />
              </div>
            }
            actions={sendTest}
          >
            <div className="grid gap-4 lg:grid-cols-3">
              {provider === "none" ? <p className="text-sm text-neutral-500 lg:col-span-3 dark:text-neutral-400">Freeploy does not send email. Select a provider next to the title to set it up.</p> : null}
              {notice ? (
                <div className="lg:col-span-3">
                  <Callout type="warning" title="Not active yet">
                    {notice}
                  </Callout>
                </div>
              ) : null}
              {provider === "smtp" ? (
                <>
                  <div className={SMTP_GROUP}>
                    <h4 className={SMTP_GROUP_TITLE}>Sender</h4>
                    <div className="grid gap-4 lg:grid-cols-2">
                      {input("smtpFromName", "From name", { required: true, helper: "Name shown in email from this server." })}
                      {input("smtpFromAddress", "From address", { required: true, helper: "Address used in email from this server. It must be on a domain that this server can send from." })}
                    </div>
                  </div>
                  <div className={SMTP_GROUP}>
                    <h4 className={SMTP_GROUP_TITLE}>Connection</h4>
                    <div className="grid gap-4 lg:grid-cols-3">
                      {input("smtpHost", "Host", { required: true, placeholder: "smtp.mailgun.org" })}
                      {input("smtpPort", "Port", { required: true, type: "number", placeholder: "587" })}
                      <Listbox
                        id="smtpEncryption"
                        label="Encryption"
                        required
                        disabled={!canUpdate}
                        options={[
                          { value: "starttls", label: "StartTLS" },
                          { value: "tls", label: "TLS / SSL" },
                          { value: "none", label: "None" },
                        ]}
                        value={str(fields.smtpEncryption) || "starttls"}
                        onChange={(v) => setFields({ ...fields, smtpEncryption: v })}
                        error={errors.smtpEncryption}
                      />
                    </div>
                  </div>
                  <div className={SMTP_GROUP}>
                    <h4 className={SMTP_GROUP_TITLE}>Authentication</h4>
                    <div className="grid gap-4 lg:grid-cols-2">
                      {input("smtpUsername", "Username", {
                        required: isProviderHost(fields.smtpHost),
                        helper: "The SMTP username from your provider. Leave it empty only for a relay that does not need a login, for example a local mail server.",
                      })}
                      {canUpdate ? (
                        input("smtpPassword", "Password", { type: "password", required: isProviderHost(fields.smtpHost) || str(fields.smtpUsername) !== "", helper: "The SMTP password from your provider. It is required when you enter a username." })
                      ) : (
                        <FormInput disabled label="Password" value="Hidden (only admins can view)" />
                      )}
                    </div>
                  </div>
                  <div className={SMTP_GROUP}>
                    <h4 className={SMTP_GROUP_TITLE}>Advanced</h4>
                    <div className="grid gap-4 lg:grid-cols-2">
                      {input("smtpTimeout", "Timeout", { type: "number", helper: "Maximum delivery time in seconds." })}
                      {input("smtpEhloDomain", "EHLO domain", { placeholder: "freeploy.example.com", helper: "Fully qualified domain sent in the SMTP EHLO command. Uses the system default when empty." })}
                    </div>
                  </div>
                </>
              ) : null}
              {provider === "resend" ? (
                <>
                  {canUpdate ? input("resendApiKey", "Resend API key", { required: true, type: "password", placeholder: "API key" }) : <FormInput disabled label="Resend API key" value="Hidden (only admins can view)" />}
                  {input("resendFromName", "From name", { required: true, helper: "Name shown in email from Resend." })}
                  {input("resendFromAddress", "From address", { required: true, helper: "Address used in email from Resend. It must be on a domain verified in Resend." })}
                </>
              ) : null}
              {provider !== "none" ? (
                <>
                  {input("notificationFromName", "Notification from name", {
                    placeholder: "Uses the from name when empty",
                    helper: "Name shown in notification emails (deployments, backups, server alerts) to teams that use the instance email settings.",
                  })}
                  {input("notificationFromAddress", "Notification from address", {
                    placeholder: "Uses the from address when empty",
                    helper:
                      "Address used for notification emails. Password resets and invitations still use the from address. Use a separate subdomain (for example alerts@notifications.example.com) to keep the reputation of the two senders apart. Your SMTP provider or Resend must allow this address.",
                  })}
                </>
              ) : null}
            </div>
          </SettingsSection>
        </form>
      </div>
    </SettingsLayout>
  );
}

export function SettingsEmailPage() {
  return (
    <Layout title="Transactional Email" href="/settings/email">
      <Email />
    </Layout>
  );
}

// ── /settings/oauth[/{provider}] ────────────────────────────────────────

type OauthEntry = Props & { provider: string; label: string; enabled: boolean };
interface OauthPage {
  oauth_settings_map: Record<string, OauthEntry>;
  disable_registration_when_oauth_enabled: boolean;
  selectedProvider: string | null;
  canUpdate: boolean;
  message?: string | null;
  error?: string | null;
}

/** The fields the unsaved bar compares (every field and checkbox of a provider). */
const ENTRY_KEYS = ["client_id", "client_secret", "redirect_uri", "tenant", "base_url", "custom_label", "scopes", "clock_skew_seconds", "allow_registration", "auto_join_root_team", "require_email_verified", "use_pkce"];

function Oauth({ provider }: { provider: string | null }) {
  const path = INSTANCE_SETTINGS_API.oauth(provider);
  const { data, setData, missing, reload } = usePage<OauthPage>(path);
  const [map, setMap] = useState<Record<string, OauthEntry>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setMap(structuredClone(data.oauth_settings_map));
  }, [data]);
  useEffect(() => {
    if (data && provider) document.getElementById(`${provider}-oauth-section`)?.scrollIntoView();
  }, [data, provider]);
  const run = useCallback(
    async (action: string, over: Props = {}) => {
      setBusy(true);
      const r = await runAction<OauthPage>(path, { action, oauth_settings_map: map, disable_registration_when_oauth_enabled: data?.disable_registration_when_oauth_enabled ?? false, ...over });
      setBusy(false);
      if (!r.ok) {
        setErrors(r.fields);
        // handleError() after a failed toggle: the provider as it is stored now.
        if (!Object.keys(r.fields).length) await reload();
        return;
      }
      setErrors({});
      setData(r.data);
      if (r.data.message) notify.success(r.data.message);
      if (r.data.error) notify.error(r.data.error);
    },
    [path, map, data, setData, reload],
  );
  if (missing) return <PlatformNotFound />;
  if (!data) return null;
  const { canUpdate } = data;
  const dirty = canUpdate && Object.entries(map).some(([p, e]) => ENTRY_KEYS.some((k) => str(e[k]) !== str(data.oauth_settings_map[p]?.[k])));
  const set = (p: string, k: string, v: unknown) => setMap({ ...map, [p]: { ...map[p]!, [k]: v } });
  const apiBase = edgeBase();
  return (
    <SettingsLayout>
      <form
        className="application-settings-form flex w-full min-w-0 flex-col gap-6"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          if (canUpdate) void run("submit");
        }}
      >
        <UnsavedBar dirty={dirty} saving={busy} onSave={() => void run("submit")} />
        <SettingsSection title="Registration" helper="Control password registration when an OAuth provider is available.">
          <Checkbox
            id="disable_registration_when_oauth_enabled"
            label="Disable password registration when OAuth is enabled"
            helper="OAuth providers can still create users when registration is enabled for that provider."
            checked={data.disable_registration_when_oauth_enabled}
            disabled={!canUpdate}
            onChange={(checked) => void run("saveRegistrationPolicy", { disable_registration_when_oauth_enabled: checked })}
          />
        </SettingsSection>

        {Object.entries(map).map(([p, entry]) => (
          <SettingsSection
            key={p}
            id={`${p}-oauth-section`}
            className="scroll-mt-28"
            title={entry.label}
            actions={
              <Button
                highlighted={!data.oauth_settings_map[p]?.enabled}
                disabled={!canUpdate}
                onClick={() => {
                  const stored = data.oauth_settings_map[p];
                  if (!stored?.enabled) {
                    const field = missingRequired(p, entry);
                    if (field) {
                      const el = document.getElementById(`oauth_settings_map.${p}.${field}`) as HTMLInputElement | null;
                      el?.reportValidity();
                      return;
                    }
                  }
                  void run("toggleProvider", { provider: p, oauth_settings_map: { ...map, [p]: { ...entry, enabled: Boolean(stored?.enabled) } } });
                }}
              >
                {data.oauth_settings_map[p]?.enabled ? "Disable" : "Enable"}
              </Button>
            }
          >
            <div className="grid gap-4 lg:grid-cols-2">
              {oauthFields(p).map((f) => {
                const id = `oauth_settings_map.${p}.${f.field}`;
                const field = (
                  <FormInput
                    key={id}
                    id={id}
                    label={f.label}
                    type={f.type ?? "text"}
                    required={f.required ?? false}
                    disabled={!canUpdate}
                    value={str(entry[f.field])}
                    onChange={(v) => set(p, f.field, v)}
                    error={errors[id]}
                    {...(f.helper ? { helper: f.helper } : {})}
                    {...(f.field === "redirect_uri" ? { placeholder: defaultRedirectUri(apiBase, p) } : f.placeholder ? { placeholder: f.placeholder } : {})}
                  />
                );
                return f.wide ? (
                  <div key={id} className="lg:col-span-2">
                    {field}
                  </div>
                ) : (
                  field
                );
              })}
            </div>
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              {oauthCheckboxes(p).map((c) => (
                <Checkbox key={c.field} id={`oauth_settings_map.${p}.${c.field}`} label={c.label} {...(c.helper ? { helper: c.helper } : {})} checked={Boolean(entry[c.field])} disabled={!canUpdate} onChange={(checked) => set(p, c.field, checked)} />
              ))}
            </div>
          </SettingsSection>
        ))}
      </form>
    </SettingsLayout>
  );
}

export function SettingsOauthPage({ provider }: { provider: string | null }) {
  return (
    <Layout title="Authentication" href={provider ? `/settings/oauth/${provider}` : "/settings/oauth"}>
      <Oauth provider={provider} />
    </Layout>
  );
}
