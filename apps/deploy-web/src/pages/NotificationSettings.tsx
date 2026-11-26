// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/notifications/{email,discord,telegram,slack,pushover,webhook}.blade.php,
// resources/views/components/notification/{settings-layout,channel-actions,event-grid,event-multiselect}.blade.php
// and app/Livewire/Notifications/*.php (Apache-2.0), modified.
//
// /notifications/{email,discord,telegram,slack,pushover,webhook}: a channel's settings, its Enable/Disable
// and "Send test" buttons, and the event grid. Every action is the component's, run by the API
// (deploy-core-worker's notifications handler): the page sends its fields and the action's name and shows
// the answer's toast or the fields' errors. The pages are in the Notifications submenu of the sidebar.
//
// Email: the provider list (None, SMTP, Resend), Resend's fields, and the SMTP server in use (its sender,
// connection and authentication). Coolify's named SMTP servers (switch, rename, delete, add from a
// template) are not ported; neither is sending over SMTP (the API says why when a test is sent).
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify, toast } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Callout, Checkbox, FormInput, Listbox, ModalInput, SettingsSection, UnsavedBar } from "../components/Coolify";

export type NotificationChannelKey = "email" | "discord" | "telegram" | "slack" | "pushover" | "webhook";
type Props = Record<string, unknown>;

interface ChannelPage {
  channel: NotificationChannelKey;
  settings: Props;
  canUpdate: boolean;
  failureCount: number;
  activeEmailProvider?: "none" | "smtp" | "resend";
  sendTestReason?: string | null;
  testEmailAddress?: string | null;
  message?: string | null;
}

// resources/views/components/notification/event-grid.blade.php
const EVENT_GROUPS: Array<[string, Array<{ key: string; label: string }>]> = [
  [
    "Deployments",
    [
      { key: "deploymentSuccess", label: "Deployment success" },
      { key: "deploymentFailure", label: "Deployment failure" },
    ],
  ],
  [
    "Resources",
    [
      { key: "statusChange", label: "Resource status changes" },
      { key: "restartLimitReached", label: "Restart limit reached" },
      { key: "imageVulnerabilities", label: "Image vulnerabilities" },
    ],
  ],
  [
    "Backups",
    [
      { key: "backupSuccess", label: "Backup success" },
      { key: "backupFailure", label: "Backup failure" },
    ],
  ],
  [
    "Scheduled tasks",
    [
      { key: "scheduledTaskSuccess", label: "Scheduled task success" },
      { key: "scheduledTaskFailure", label: "Scheduled task failure" },
    ],
  ],
  [
    "Servers",
    [
      { key: "dockerCleanupSuccess", label: "Docker cleanup success" },
      { key: "dockerCleanupFailure", label: "Docker cleanup failure" },
      { key: "serverDiskUsage", label: "Disk usage warning" },
      { key: "serverReachable", label: "Server reachable" },
      { key: "serverUnreachable", label: "Server unreachable" },
      { key: "serverPatch", label: "Server patching" },
      { key: "traefikOutdated", label: "Traefik proxy outdated" },
    ],
  ],
];

// The email page names its groups and two events its own way (email.blade.php).
const EMAIL_EVENT_GROUPS: Array<[string, string, Array<{ key: string; label: string }>]> = [
  ["deployment-email-events", "Deployments", EVENT_GROUPS[0]![1]],
  ["resource-email-events", "Resources", EVENT_GROUPS[1]![1]],
  ["backup-email-events", "Backups", EVENT_GROUPS[2]![1]],
  ["scheduled-task-email-events", "Scheduled tasks", EVENT_GROUPS[3]![1]],
  [
    "server-email-events",
    "Server",
    EVENT_GROUPS[4]![1].map((e) => (e.key === "serverDiskUsage" ? { ...e, label: "Server disk usage" } : e)),
  ],
];

const studly = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** The page's data and its actions against the API. */
function useChannel(channel: NotificationChannelKey) {
  const { me } = useSignedIn();
  const base = `/v1/organizations/${me.team?.id ?? ""}/deploy/notifications/${channel}`;
  const [data, setData] = useState<ChannelPage | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void (async () => {
      const r = await getJson<ChannelPage>(base);
      if (r.data) setData(r.data);
      else if (r.status !== 401) notify.error("Failed to load the notification settings.");
    })();
  }, [base]);
  /** A component action with the page's fields; answers the new page, or null when it failed. */
  const run = useCallback(
    async (action: string, fields: Props): Promise<ChannelPage | null> => {
      setBusy(true);
      const r = await postJson<ChannelPage & { saved?: boolean }>(base, { action, ...fields }, "PATCH");
      setBusy(false);
      if (!r.ok) {
        const inline: Record<string, string> = {};
        for (const [f, m] of Object.entries(r.error.fields ?? {})) if (m[0]) inline[f] = m[0];
        setErrors(inline);
        if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
        return null;
      }
      setErrors({});
      setData(r.data);
      if (r.data.message) notify.success(r.data.message);
      return r.data;
    },
    [base],
  );
  const test = useCallback(
    async (body: Props = {}) => {
      setBusy(true);
      const r = await postJson<{ message: string }>(`${base}/test`, body, "POST");
      setBusy(false);
      if (!r.ok) {
        const field = Object.values(r.error.fields ?? {})[0]?.[0];
        const description = r.error.description;
        toast(field ?? summarize(r.error.messages), { type: "danger", ...(description ? { description } : {}) });
        return;
      }
      notify.success(r.data.message);
    },
    [base],
  );
  return { data, setData, errors, busy, run, test };
}

/** x-notification.settings-layout: the mobile header around the page. */
function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <section className="w-full max-w-none">
      <header className="settings-mobile-header xl:hidden">
        <h1 className="settings-mobile-title">Notifications</h1>
        <p className="settings-mobile-description">Configure how your team receives deployment and system alerts.</p>
      </header>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

/** x-notification.event-multiselect: a group's events, each option toggles one (toggleEvent). */
function EventMultiselect(props: { id: string; label: string; events: Array<{ property: string; label: string; enabled: boolean }>; disabled: boolean; onToggle: (property: string) => void }) {
  const [open, setOpen] = useState(false);
  const selected = props.events.filter((e) => e.enabled);
  const labels = selected.map((e) => e.label).join(", ");
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as HTMLElement).closest?.(`[data-multiselect="${props.id}"]`)) setOpen(false);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
    };
  }, [open, props.id]);
  return (
    <div className="w-full min-w-0" data-multiselect={props.id}>
      <label htmlFor={`${props.id}-trigger`} className="mb-1.5 block text-[12px] font-medium text-black dark:text-fg">
        {props.label}
      </label>
      <div className="relative min-w-0">
        <button id={`${props.id}-trigger`} type="button" className="listbox-trigger" onClick={() => setOpen(!open)} disabled={props.disabled} aria-haspopup="listbox" aria-expanded={open} {...(selected.length > 0 ? { title: labels } : {})}>
          <span className="listbox-trigger-label">{selected.length === 0 ? "No events selected" : labels}</span>
          <span className="shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500 dark:bg-white/[0.07] dark:text-fg-dim">
            {selected.length}/{props.events.length}
          </span>
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" className="size-3.5 shrink-0 opacity-60">
            <path strokeLinecap="round" strokeLinejoin="round" d="m8 9 4-4 4 4m0 6-4 4-4-4" />
          </svg>
        </button>
        {open ? (
          <div className="listbox-panel" role="listbox" aria-multiselectable="true">
            {props.events.map((event) => (
              <button key={event.property} type="button" className="listbox-option" role="option" aria-selected={event.enabled} onClick={() => props.onToggle(event.property)} disabled={props.disabled}>
                <span className="truncate">{event.label}</span>
                <span
                  className={`flex size-4 shrink-0 items-center justify-center rounded-[5px] border ${
                    event.enabled ? "border-coollabs bg-coollabs text-white dark:border-brand dark:bg-brand dark:text-white" : "border-neutral-300 bg-white dark:border-white/[0.14] dark:bg-white/[0.045]"
                  }`}
                >
                  {event.enabled ? (
                    <svg className="size-3" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="m2.25 6.15 2.35 2.3 5.15-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** x-notification.channel-actions: Enable/Disable (instantSave{Channel}Enabled) and Send test. */
function ChannelActions(props: { enabled: boolean; canUpdate: boolean; onToggle: () => void; onTest: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <button type="button" className={`button${props.enabled ? "" : " button-highlighted"}`} disabled={!props.canUpdate} onClick={props.onToggle}>
        <span>{props.enabled ? "Disable" : "Enable"}</span>
      </button>
      <button type="button" className="button" disabled={!props.enabled || !props.canUpdate} onClick={props.onTest}>
        <Reicon name="notifications" className="size-3.5" />
        Send test
      </button>
    </div>
  );
}

/** x-notification.event-grid, with the Telegram forum topics when `threaded`. */
function EventGrid(props: {
  channel: NotificationChannelKey;
  settings: Props;
  canUpdate: boolean;
  onToggle: (property: string) => void;
  threaded?: boolean;
  threadValues?: Props;
  onThread?: (prop: string, value: string) => void;
  errors?: Record<string, string>;
}) {
  const property = (key: string) => `${key}${studly(props.channel)}Notifications`;
  const enabledThreads = EVENT_GROUPS.flatMap(([group, events]) =>
    events.filter((e) => Boolean(props.settings[property(e.key)])).map((e) => ({ group, ...e, threadModel: `${props.channel}Notifications${studly(e.key)}ThreadId` })),
  );
  const byGroup = [...new Set(enabledThreads.map((e) => e.group))].map((g) => [g, enabledThreads.filter((e) => e.group === g)] as const);
  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title="Notification events" helper="Choose which events send a notification on this channel.">
        <div className="grid gap-4 lg:grid-cols-2">
          {EVENT_GROUPS.map(([group, events]) => (
            <div key={group} className="min-w-0">
              <EventMultiselect
                id={slug(`${props.channel}-${group}-events`)}
                label={group}
                disabled={!props.canUpdate}
                onToggle={props.onToggle}
                events={events.map((e) => ({ property: property(e.key), label: e.label, enabled: Boolean(props.settings[property(e.key)]) }))}
              />
            </div>
          ))}
        </div>
      </SettingsSection>
      {props.threaded ? (
        <SettingsSection title="Forum topics" helper="Optional. Route enabled events to a Telegram forum topic using its message thread ID. Leave blank to post in the main chat.">
          {enabledThreads.length === 0 ? (
            <p className="text-[13px] leading-relaxed text-neutral-500 dark:text-fg-dim">Enable one or more events above to assign forum topic IDs.</p>
          ) : (
            <div className="flex flex-col gap-5">
              {byGroup.map(([group, events]) => (
                <div key={group} className="min-w-0">
                  <div className="mb-2 text-[11px] font-medium tracking-wide text-neutral-500 uppercase dark:text-fg-dim">{group}</div>
                  <div className="divide-y divide-neutral-200 overflow-hidden rounded-xl border border-neutral-200 dark:divide-white/[0.06] dark:border-white/[0.08]">
                    {events.map((event) => (
                      <div key={event.key} className="grid gap-2 px-3.5 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,14rem)] sm:items-center sm:gap-4">
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-black dark:text-fg">{event.label}</div>
                          <div className="text-[11px] text-neutral-500 dark:text-fg-dim">Topic ID</div>
                        </div>
                        <FormInput
                          id={event.threadModel}
                          type="password"
                          placeholder="Optional"
                          disabled={!props.canUpdate}
                          value={str(props.threadValues?.[event.threadModel])}
                          onChange={(v) => props.onThread?.(event.threadModel, v)}
                          error={props.errors?.[event.threadModel]}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SettingsSection>
      ) : null}
    </div>
  );
}

interface FieldSpec {
  prop: string;
  label: string;
  helper: string;
  /** autocomplete="new-password" in the view (Telegram). */
  newPassword?: boolean;
}

interface ChatSpec {
  title: string;
  description: string;
  enabled: string;
  fields: FieldSpec[];
}

const CHAT_SPECS: Record<Exclude<NotificationChannelKey, "email">, ChatSpec> = {
  discord: {
    title: "Discord",
    description: "Send team notifications to a Discord channel through an incoming webhook.",
    enabled: "discordEnabled",
    fields: [{ prop: "discordWebhookUrl", label: "Webhook URL", helper: "Create an incoming webhook in your Discord server settings." }],
  },
  telegram: {
    title: "Telegram",
    description: "Deliver team notifications through a Telegram bot and chat.",
    enabled: "telegramEnabled",
    fields: [
      { prop: "telegramToken", label: "Bot API token", helper: "Create a bot with BotFather to obtain this token.", newPassword: true },
      { prop: "telegramChatId", label: "Chat ID", helper: "Add the bot to your chat, then enter that chat ID.", newPassword: true },
    ],
  },
  slack: {
    title: "Slack",
    description: "Send team notifications to Slack through an incoming webhook.",
    enabled: "slackEnabled",
    fields: [{ prop: "slackWebhookUrl", label: "Webhook URL", helper: "Create an incoming webhook in your Slack app settings." }],
  },
  pushover: {
    title: "Pushover",
    description: "Deliver team alerts through your Pushover application.",
    enabled: "pushoverEnabled",
    fields: [
      { prop: "pushoverUserKey", label: "User key", helper: "Find this in the Pushover dashboard." },
      { prop: "pushoverApiToken", label: "API token", helper: "Create an application in Pushover to generate this token." },
    ],
  },
  webhook: {
    title: "Webhook",
    description: "Send JSON event payloads to your own HTTP endpoint.",
    enabled: "webhookEnabled",
    fields: [{ prop: "webhookUrl", label: "Webhook URL", helper: "Freeploy sends POST requests to this HTTP or HTTPS endpoint." }],
  },
};

const THREAD_RE = /^telegramNotifications.+ThreadId$/;

function ChatChannelContent({ channel }: { channel: Exclude<NotificationChannelKey, "email"> }) {
  const spec = CHAT_SPECS[channel];
  const { data, errors, busy, run, test } = useChannel(channel);
  const [fields, setFields] = useState<Props>({});
  useEffect(() => {
    if (!data) return;
    const editable: Props = {};
    for (const [k, v] of Object.entries(data.settings)) if (spec.fields.some((f) => f.prop === k) || THREAD_RE.test(k)) editable[k] = v;
    setFields(editable);
  }, [data, spec]);
  if (!data) return null;
  const { settings, canUpdate } = data;
  const enabled = Boolean(settings[spec.enabled]);
  const dirty = Object.entries(fields).some(([k, v]) => str(v) !== str(settings[k]));
  const body = (extra: Props = {}) => ({ ...fields, ...extra });
  const submit = () => void run("submit", body());

  return (
    <SettingsLayout>
      <div className="application-settings-form flex flex-col gap-6">
        <form
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            submit();
          }}
        >
          <UnsavedBar dirty={dirty} saving={busy} onSave={submit} />
          <SettingsSection
            title={spec.title}
            helper={spec.description}
            actions={<ChannelActions enabled={enabled} canUpdate={canUpdate} onToggle={() => void run("instantSaveEnabled", body({ [spec.enabled]: !enabled }))} onTest={() => void test()} />}
          >
            <div className="grid gap-4 lg:grid-cols-2">
              {channel === "discord" ? (
                <Listbox
                  id="discordPingEnabled"
                  label="Critical event mention"
                  helper="Mention @here when a critical event occurs."
                  disabled={!canUpdate}
                  options={[
                    { value: "true", label: "Mention @here" },
                    { value: "false", label: "Do not mention" },
                  ]}
                  value={settings.discordPingEnabled ? "true" : "false"}
                  onChange={(v) => void run("instantSavePingEnabled", body({ discordPingEnabled: v === "true" }))}
                />
              ) : null}
              {spec.fields.map((f) => (
                <div key={f.prop} className={spec.fields.length === 1 ? "lg:col-span-2" : undefined}>
                  {canUpdate ? (
                    <FormInput id={f.prop} type="password" required={enabled} label={f.label} helper={f.helper} value={str(fields[f.prop])} onChange={(v) => setFields({ ...fields, [f.prop]: v })} error={errors[f.prop]} />
                  ) : (
                    <FormInput disabled label={f.label} value="Hidden (only admins can view)" />
                  )}
                </div>
              ))}
            </div>
          </SettingsSection>
        </form>
        <EventGrid
          channel={channel}
          settings={settings}
          canUpdate={canUpdate}
          onToggle={(property) => void run("toggleEvent", body({ property }))}
          threaded={channel === "telegram"}
          threadValues={fields}
          onThread={(prop, value) => setFields({ ...fields, [prop]: value })}
          errors={errors}
        />
      </div>
    </SettingsLayout>
  );
}

const EMAIL_PROVIDER_LABELS: Record<"none" | "smtp" | "resend", string> = { none: "None", smtp: "SMTP", resend: "Resend" };
const EMAIL_FIELDS = ["smtpFromName", "smtpFromAddress", "smtpHost", "smtpPort", "smtpEncryption", "smtpUsername", "smtpPassword", "smtpTimeout", "smtpEhloDomain", "resendApiKey", "resendFromName", "resendFromAddress"];
const SMTP_GROUP = "flex flex-col gap-3 border-t border-neutral-200 pt-4 lg:col-span-3 dark:border-white/[0.08]";
const SMTP_GROUP_TITLE = "text-sm font-semibold text-black dark:text-fg";

function EmailContent() {
  const { data, errors, busy, run, test } = useChannel("email");
  const [fields, setFields] = useState<Props>({});
  const [provider, setProvider] = useState<"none" | "smtp" | "resend">("none");
  const [testOpen, setTestOpen] = useState(false);
  const [testAddress, setTestAddress] = useState("");
  useEffect(() => {
    if (!data) return;
    setFields(Object.fromEntries(EMAIL_FIELDS.map((k) => [k, data.settings[k] ?? (k === "smtpEncryption" ? "starttls" : null)])));
    setProvider((data.settings.emailProvider as "none" | "smtp" | "resend") ?? "none");
  }, [data]);
  useEffect(() => {
    if (data?.testEmailAddress) setTestAddress(data.testEmailAddress);
  }, [data?.testEmailAddress]);
  if (!data) return null;
  const { settings, canUpdate } = data;
  const active = data.activeEmailProvider ?? "none";
  const useInstance = Boolean(settings.useInstanceEmailSettings);
  const dirty = EMAIL_FIELDS.some((k) => str(fields[k]) !== str(settings[k] ?? (k === "smtpEncryption" ? "starttls" : null)));
  const body = (extra: Props = {}) => ({ ...fields, emailProvider: provider, useInstanceEmailSettings: useInstance, ...extra });
  const submit = () => void run("submit", body());
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

  return (
    <SettingsLayout>
      <div className="flex flex-col gap-6">
        <form
          className="application-settings-form"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            submit();
          }}
        >
          <UnsavedBar dirty={dirty} saving={busy} onSave={submit} />
          <SettingsSection
            title="Email delivery"
            actions={
              data.sendTestReason === null ? (
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
                    className="flex w-full flex-col gap-4"
                    onSubmit={(e: FormEvent<HTMLFormElement>) => {
                      e.preventDefault();
                      setTestOpen(false);
                      void test({ testEmailAddress: testAddress });
                    }}
                  >
                    <FormInput id="testEmailAddress" label="Recipient" placeholder="test@example.com" required value={testAddress} onChange={setTestAddress} />
                    <div className="flex justify-end border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
                      <button type="submit" className="button button-highlighted">
                        Send email
                      </button>
                    </div>
                  </form>
                </ModalInput>
              ) : (
                <button type="button" className="button" disabled title={data.sendTestReason ?? undefined}>
                  <Reicon name="notifications" className="size-3.5" />
                  Send test
                </button>
              )
            }
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="lg:col-span-2">
                <div className="w-full sm:w-72">
                  {/* isCloud(): Freeploy is hosted, so the instance's settings are its hosted email service. */}
                  <Listbox
                    id="useInstanceEmailSettings"
                    label="Email service"
                    disabled={!canUpdate}
                    options={[
                      { value: "true", label: "Use hosted email service" },
                      { value: "false", label: "Use team email settings" },
                    ]}
                    value={useInstance ? "true" : "false"}
                    onChange={(v) => void run("instantSave", body({ useInstanceEmailSettings: v === "true" }))}
                  />
                </div>
              </div>
            </div>
          </SettingsSection>
        </form>

        {!useInstance ? (
          <div className="application-settings-form">
            <SettingsSection
              title="Email provider"
              helper="Only one provider sends email. Select a provider to see its settings."
              badges={
                <div className="w-40">
                  <Listbox
                    id="emailProvider"
                    disabled={!canUpdate}
                    options={(["none", "smtp", "resend"] as const).map((value) => ({ value, label: EMAIL_PROVIDER_LABELS[value] }))}
                    value={provider}
                    onChange={(v) => {
                      const next = v as "none" | "smtp" | "resend";
                      setProvider(next);
                      void run("selectEmailProvider", body({ emailProvider: next })).then((page) => {
                        if (page && page.message === null) setProvider(next);
                      });
                    }}
                  />
                </div>
              }
            >
              <div className="grid gap-4 lg:grid-cols-3">
                {provider === "none" ? (
                  <p className="text-sm text-neutral-500 lg:col-span-3 dark:text-neutral-400">The team does not get email notifications. Select a provider next to the title to set it up.</p>
                ) : null}
                {provider !== active ? (
                  <div className="lg:col-span-3">
                    <Callout type="warning" title="Not active yet">
                      Enter the {EMAIL_PROVIDER_LABELS[provider]} settings and save.{" "}
                      {active === "none" ? "Until then, the team does not get email notifications." : `Until then, Freeploy sends email with ${EMAIL_PROVIDER_LABELS[active]}.`}
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
                          helper: "The SMTP username from your provider. Leave it empty only for a relay that does not need a login, for example a local mail server.",
                        })}
                        {canUpdate ? input("smtpPassword", "Password", { type: "password", helper: "The SMTP password from your provider. It is required when you enter a username." }) : <FormInput disabled label="Password" value="Hidden (only admins can view)" />}
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
                    <div>
                      {canUpdate ? input("resendApiKey", "Resend API key", { required: true, type: "password", placeholder: "API key" }) : <FormInput disabled label="Resend API key" value="Hidden (only admins can view)" />}
                    </div>
                    {input("resendFromName", "From name", { required: true, helper: "Name shown in email from Resend." })}
                    {input("resendFromAddress", "From address", { required: true, helper: "Address used in email from Resend. It must be on a domain verified in Resend." })}
                  </>
                ) : null}
              </div>
            </SettingsSection>
          </div>
        ) : null}

        <div className="application-settings-form">
          <SettingsSection title="Notification events">
            <div className="grid gap-4 lg:grid-cols-2">
              {EMAIL_EVENT_GROUPS.map(([id, label, events]) => (
                <EventMultiselect
                  key={id}
                  id={id}
                  label={label}
                  disabled={!canUpdate}
                  onToggle={(property) => void run("toggleEvent", body({ property }))}
                  events={events.map((e) => ({ property: `${e.key}EmailNotifications`, label: e.label, enabled: Boolean(settings[`${e.key}EmailNotifications`]) }))}
                />
              ))}
            </div>
            <div className="mt-4">
              <Checkbox
                id="deploymentCommitDetailsEmailNotifications"
                label="Include commit details in deployment emails"
                helper="Adds the commit SHA, branch, and commit message to deployment success and failure emails."
                checked={Boolean(settings.deploymentCommitDetailsEmailNotifications)}
                disabled={!canUpdate}
                onChange={(checked) => void run("instantSaveDeploymentCommitDetails", body({ deploymentCommitDetailsEmailNotifications: checked }))}
              />
            </div>
          </SettingsSection>
        </div>
      </div>
    </SettingsLayout>
  );
}

const DOCUMENT_TITLES: Record<NotificationChannelKey, string> = {
  email: "Notifications",
  discord: "Discord Notifications",
  telegram: "Telegram Notifications",
  slack: "Slack Notifications",
  pushover: "Pushover Notifications",
  webhook: "Webhook Notifications",
};

export function NotificationSettingsPage({ channel }: { channel: NotificationChannelKey }) {
  return (
    <Layout title="Notifications" href={`/notifications/${channel}`} documentTitle={DOCUMENT_TITLES[channel]}>
      {channel === "email" ? <EmailContent /> : <ChatChannelContent channel={channel} />}
    </Layout>
  );
}
