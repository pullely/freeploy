// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Notifications/{Email,Discord,Telegram,Slack,Pushover,Webhook}.php,
// app/Livewire/Notifications/Concerns/TogglesNotificationEvents.php, app/Support/SmtpPresets.php,
// app/Rules/ValidHostname.php and Laravel's validation messages (lang/en/validation.php) (Apache-2.0 / MIT), modified.
//
// What the six notification settings components do, as plain operations on one org's settings row. The
// state is the component's: Livewire's properties (camelCase of the columns), loaded from the row and
// overridden by what the page sends. Every rule and message is Coolify's, word for word; Laravel's
// :attribute of a property is its snake case with spaces ("discord webhook url").
//
// Coolify has no "at least one channel" rule and no "send a test before enabling" rule: a channel is
// enabled when its required fields are filled (instantSave{Channel}Enabled), and a test can be sent once
// it is enabled. Those are the rules here too.
//
// Not ported: the named SMTP servers of the email page (ManagesSmtpServers: add, switch, rename, delete,
// templates) — the server in use is the smtp_* columns, which are ported; SafeSmtpHost's DNS check of a
// changed SMTP host (no DNS in a Worker; SMTP is not sent anyway); toggleSmtp()/toggleResend(), which the
// page at 91b7e3e does not call.
import { hostnameError } from "../servers/ip.js";
import { safeWebhookUrlMessage } from "./safe-webhook-url.js";

export type NotificationChannel = "email" | "discord" | "telegram" | "slack" | "pushover" | "webhook";
export const NOTIFICATION_CHANNEL_LIST: readonly NotificationChannel[] = ["email", "discord", "telegram", "slack", "pushover", "webhook"];

/** A settings row, its encrypted columns decrypted (snake_case columns). */
export type SettingsRow = Record<string, unknown>;
/** The component's properties (camelCase). */
export type Props = Record<string, unknown>;

/** TogglesNotificationEvents::NOTIFICATION_EVENT_KEYS. */
export const EVENT_KEYS = [
  "deploymentSuccess",
  "deploymentFailure",
  "statusChange",
  "restartLimitReached",
  "backupSuccess",
  "backupFailure",
  "scheduledTaskSuccess",
  "scheduledTaskFailure",
  "dockerCleanupSuccess",
  "dockerCleanupFailure",
  "serverDiskUsage",
  "serverReachable",
  "serverUnreachable",
  "serverPatch",
  "traefikOutdated",
  "imageVulnerabilities",
] as const;

export const SETTINGS_MESSAGES = {
  saved: "Settings saved.",
  emailSaved: "Email notifications settings updated.",
  smtpSaved: "SMTP settings updated.",
  resendSaved: "Resend settings updated.",
  testSent: "Test notification sent.",
  testEmailSent: "Test Email sent.",
  tooManyMessages: "Too many messages sent!",
  telegramRejected: "Telegram rejected the test notification.",
  telegramInvalidToken: "The Bot API token is not valid. Copy it again from @BotFather.",
  onlyAdminsTest: "Only admins can send a test email.",
  saveProviderFirst: "Save an email provider first.",
};

export const studly = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const camel = (snake: string): string => snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
/** Str::snake(): before each capital letter an underscore. */
export const snake = (camelCase: string): string => camelCase.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
/** Laravel's displayable attribute of a property. */
const attr = (prop: string): string => snake(prop).replace(/_/g, " ");

export function propsFromRow(row: SettingsRow): Props {
  const props: Props = {};
  for (const [k, v] of Object.entries(row)) props[camel(k)] = v;
  return props;
}

export class ValidationFailed extends Error {
  constructor(public readonly fields: Record<string, string[]>) {
    super(Object.values(fields)[0]?.[0] ?? "The given data was invalid.");
  }
}

/** handleError(): an error toast with the exception's message. */
export class SettingsError extends Error {
  constructor(
    message: string,
    public readonly status = 422,
    public readonly description?: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------------
// A small Laravel validator: the rules these components use, with Laravel's messages.

type Rule = { implicit?: boolean; boolean?: true; check: (value: unknown, state: Props, prop: string) => string | null };

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
const isBooleanLike = (v: unknown) => v === true || v === false || v === 0 || v === 1 || v === "0" || v === "1";
const isNumeric = (v: unknown) => (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v));

const R = {
  boolean: (): Rule => ({ boolean: true, check: (v, _s, p) => (isBooleanLike(v) ? null : `The ${attr(p)} field must be true or false.`) }),
  string: (): Rule => ({ check: (v, _s, p) => (typeof v === "string" ? null : `The ${attr(p)} field must be a string.`) }),
  maxString: (n: number): Rule => ({ check: (v, _s, p) => (typeof v === "string" && Array.from(v).length > n ? `The ${attr(p)} field must not be greater than ${n} characters.` : null) }),
  email: (): Rule => ({ check: (v, _s, p) => (typeof v === "string" && isEmail(v) ? null : `The ${attr(p)} field must be a valid email address.`) }),
  numeric: (): Rule => ({ check: (v, _s, p) => (isNumeric(v) ? null : `The ${attr(p)} field must be a number.`) }),
  minNumeric: (n: number): Rule => ({ check: (v, _s, p) => (isNumeric(v) && Number(v) < n ? `The ${attr(p)} field must be at least ${n}.` : null) }),
  maxNumeric: (n: number): Rule => ({ check: (v, _s, p) => (isNumeric(v) && Number(v) > n ? `The ${attr(p)} field must not be greater than ${n}.` : null) }),
  in: (list: string[]): Rule => ({ check: (v, _s, p) => (typeof v === "string" && list.includes(v) ? null : `The selected ${attr(p)} is invalid.`) }),
  required: (): Rule => ({ implicit: true, check: (v, _s, p) => (isBlank(v) ? `The ${attr(p)} field is required.` : null) }),
  requiredIfTrue: (other: string): Rule => ({
    implicit: true,
    check: (v, s, p) => (isTrue(s[other]) && isBlank(v) ? `The ${attr(p)} field is required when ${attr(other)} is true.` : null),
  }),
  requiredWhen: (when: boolean): Rule => ({ implicit: true, check: (v, _s, p) => (when && isBlank(v) ? `The ${attr(p)} field is required.` : null) }),
  requiredWith: (other: string): Rule => ({ implicit: true, check: (v, s, p) => (!isBlank(s[other]) && isBlank(v) ? `The ${attr(p)} field is required when ${attr(other)} is present.` : null) }),
  safeWebhookUrl: (settingsUrl: string): Rule => ({ check: (v, _s, p) => (typeof v === "string" ? safeWebhookUrlMessage(attr(p), v, settingsUrl) : `The ${attr(p)} must be a valid URL.`) }),
  validHostname: (): Rule => ({ check: (v, _s, p) => (typeof v === "string" ? hostnameError(attr(p), v) : null) }),
};
const NULLABLE = "nullable" as const;
type RuleList = Array<Rule | typeof NULLABLE>;

function isTrue(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

/** Laravel's `email` rule (RFC validation), as far as a setting needs it: local@domain without spaces. */
export function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(v) && !/\.\./.test(v.split("@")[1] ?? "") && !(v.split("@")[1] ?? "").startsWith(".");
}

/**
 * Validator::make($state, $rules, $messages)->validate(). A null value skips the rules of a nullable field;
 * a blank one skips every rule that is not implicit (required*). $messages: "{prop}.{rule}" => message, with
 * rule one of required, required_if, required_with, email, numeric.
 */
export function validate(state: Props, rules: Record<string, RuleList>, messages: Record<string, string> = {}, ruleNames?: Map<Rule, string>): void {
  const fields: Record<string, string[]> = {};
  for (const [prop, list] of Object.entries(rules)) {
    const value = state[prop];
    const nullable = list.includes(NULLABLE);
    for (const rule of list) {
      if (rule === NULLABLE) continue;
      if (nullable && (value === null || value === undefined) && !rule.implicit) continue;
      if (!rule.implicit && (value === null || value === undefined || (typeof value === "string" && value.trim() === ""))) continue;
      const error = rule.check(value, state, prop);
      if (error) {
        const name = ruleNames?.get(rule);
        (fields[prop] ??= []).push((name && messages[`${prop}.${name}`]) || error);
      }
    }
  }
  if (Object.keys(fields).length) throw new ValidationFailed(fields);
}

/** validate(['prop' => 'required', …], ['prop.required' => message, …]). */
function validateRequired(state: Props, props: Record<string, string>): void {
  const fields: Record<string, string[]> = {};
  for (const [prop, message] of Object.entries(props)) if (isBlank(state[prop])) fields[prop] = [message];
  if (Object.keys(fields).length) throw new ValidationFailed(fields);
}

// ---------------------------------------------------------------------------------------------------
// The five chat and webhook channels.

interface ChannelSpec {
  channel: Exclude<NotificationChannel, "email">;
  enabled: string;
  /** The fields, their #[Validate] rules. */
  fields: (settingsUrl: string) => Record<string, RuleList>;
  /** instantSave{Channel}Enabled / toggle{Channel}Enabled: validate([prop => 'required'], [message]). */
  requiredToEnable: Record<string, string>;
  /** Shown only to who can update the settings (the rest is null, "Hidden (only admins can view)"). */
  secrets: string[];
}

const toggleRules = (channel: string): Record<string, RuleList> =>
  Object.fromEntries(EVENT_KEYS.map((e) => [`${e}${studly(channel)}Notifications`, [R.boolean()]]));

const THREAD_PROPS = EVENT_KEYS.map((e) => `telegramNotifications${studly(e)}ThreadId`);

export const CHANNEL_SPECS: Record<Exclude<NotificationChannel, "email">, ChannelSpec> = {
  discord: {
    channel: "discord",
    enabled: "discordEnabled",
    fields: (u) => ({
      discordEnabled: [R.boolean()],
      discordWebhookUrl: [R.requiredIfTrue("discordEnabled"), NULLABLE, R.safeWebhookUrl(u)],
      ...toggleRules("discord"),
      discordPingEnabled: [R.boolean()],
    }),
    requiredToEnable: { discordWebhookUrl: "Discord Webhook URL is required." },
    secrets: ["discordWebhookUrl"],
  },
  telegram: {
    channel: "telegram",
    enabled: "telegramEnabled",
    fields: () => ({
      telegramEnabled: [R.boolean()],
      telegramToken: [R.requiredIfTrue("telegramEnabled"), NULLABLE, R.string()],
      telegramChatId: [R.requiredIfTrue("telegramEnabled"), NULLABLE, R.string()],
      ...toggleRules("telegram"),
      ...Object.fromEntries(
        THREAD_PROPS.map((p) => [p, p === "telegramNotificationsRestartLimitReachedThreadId" || p === "telegramNotificationsImageVulnerabilitiesThreadId" ? [NULLABLE, R.string(), R.maxString(255)] : [NULLABLE, R.string()]]),
      ),
    }),
    requiredToEnable: { telegramToken: "Telegram Token is required.", telegramChatId: "Telegram Chat ID is required." },
    secrets: ["telegramToken", "telegramChatId", ...THREAD_PROPS],
  },
  slack: {
    channel: "slack",
    enabled: "slackEnabled",
    fields: (u) => ({ slackEnabled: [R.boolean()], slackWebhookUrl: [R.requiredIfTrue("slackEnabled"), NULLABLE, R.safeWebhookUrl(u)], ...toggleRules("slack") }),
    requiredToEnable: { slackWebhookUrl: "Slack Webhook URL is required." },
    secrets: ["slackWebhookUrl"],
  },
  pushover: {
    channel: "pushover",
    enabled: "pushoverEnabled",
    fields: () => ({
      pushoverEnabled: [R.boolean()],
      pushoverUserKey: [R.requiredIfTrue("pushoverEnabled"), NULLABLE, R.string()],
      pushoverApiToken: [R.requiredIfTrue("pushoverEnabled"), NULLABLE, R.string()],
      ...toggleRules("pushover"),
    }),
    requiredToEnable: { pushoverUserKey: "Pushover User Key is required.", pushoverApiToken: "Pushover API Token is required." },
    secrets: ["pushoverUserKey", "pushoverApiToken"],
  },
  webhook: {
    channel: "webhook",
    enabled: "webhookEnabled",
    fields: (u) => ({ webhookEnabled: [R.boolean()], webhookUrl: [R.requiredIfTrue("webhookEnabled"), NULLABLE, R.safeWebhookUrl(u)], ...toggleRules("webhook") }),
    requiredToEnable: { webhookUrl: "Webhook URL is required." },
    secrets: ["webhookUrl"],
  },
};

export interface SettingsStore {
  /** The org's row (created on the first read), decrypted. */
  load(channel: NotificationChannel): Promise<SettingsRow>;
  /** save(): the changed columns (plaintext; the store encrypts). Answers the saved row, decrypted. */
  save(channel: NotificationChannel, changes: SettingsRow): Promise<SettingsRow>;
}

/** The result of an action: the saved row, the toast, or a validation failure. */
export interface ActionResult {
  row: SettingsRow;
  message: string | null;
}

/** syncData(true): validate every field, then the changed columns to the model, then save(). */
async function syncToModel(store: SettingsStore, channel: NotificationChannel, row: SettingsRow, state: Props, rules: Record<string, RuleList>): Promise<SettingsRow> {
  validate(state, rules);
  const changes: SettingsRow = {};
  for (const prop of Object.keys(rules)) {
    const column = snake(prop);
    let value = state[prop];
    if (rules[prop]!.some((r) => r !== NULLABLE && r.boolean)) value = isTrue(value);
    if (!Object.is(row[column], value)) changes[column] = value ?? null;
  }
  return Object.keys(changes).length ? store.save(channel, changes) : row;
}

const ACTION_NAMES = ["submit", "instantSave", "instantSaveEnabled", "toggleEnabled", "instantSavePingEnabled", "toggleEvent"] as const;
export type ChannelAction = (typeof ACTION_NAMES)[number];
export const isChannelAction = (a: unknown): a is ChannelAction => typeof a === "string" && (ACTION_NAMES as readonly string[]).includes(a);

/**
 * One of a chat channel's actions with the page's state (`body`, camelCase properties). Answers the saved row
 * and the toast; throws ValidationFailed (the fields' messages) or SettingsError (a 404 for an unknown event).
 */
export async function runChannelAction(
  store: SettingsStore,
  channel: Exclude<NotificationChannel, "email">,
  action: ChannelAction,
  body: Props,
  settingsUrl: string,
): Promise<ActionResult> {
  const spec = CHANNEL_SPECS[channel];
  const rules = spec.fields(settingsUrl);
  const row = await store.load(channel);
  const state: Props = { ...propsFromRow(row) };
  for (const prop of Object.keys(rules)) if (prop in body) state[prop] = body[prop];
  const saveModel = async () => ({ row: await syncToModel(store, channel, row, state, rules), message: SETTINGS_MESSAGES.saved });

  switch (action) {
    case "submit":
      await syncToModel(store, channel, row, state, rules);
      return saveModel();
    case "instantSave":
      return { row: await syncToModel(store, channel, row, state, rules), message: null };
    case "instantSaveEnabled":
      // The Enable/Disable button sets the property, then calls instantSave{Channel}Enabled.
      validateRequired(state, spec.requiredToEnable);
      return saveModel();
    case "toggleEnabled":
      if (isTrue(state[spec.enabled])) state[spec.enabled] = false;
      else {
        validateRequired(state, spec.requiredToEnable);
        state[spec.enabled] = true;
      }
      return saveModel();
    case "instantSavePingEnabled":
      if (channel !== "discord") throw new SettingsError("Not found", 404);
      validateRequired(state, { discordPingEnabled: "The discord ping enabled field is required." });
      return saveModel();
    case "toggleEvent": {
      const property = typeof body.property === "string" ? body.property : "";
      const allowed = EVENT_KEYS.map((e) => `${e}${studly(channel)}Notifications`);
      // abort_unless(in_array(...), 404)
      if (!allowed.includes(property)) throw new SettingsError("Not found", 404);
      state[property] = !isTrue(propsFromRow(row)[property]);
      return saveModel();
    }
  }
}

/** The page's view of a chat channel: the properties, the secrets only for who can update. */
export function channelView(channel: Exclude<NotificationChannel, "email">, row: SettingsRow, canUpdate: boolean): Props {
  const spec = CHANNEL_SPECS[channel];
  const props: Props = {};
  for (const prop of Object.keys(spec.fields(""))) props[prop] = row[snake(prop)] ?? null;
  if (!canUpdate) for (const s of spec.secrets) props[s] = null;
  return props;
}

// ---------------------------------------------------------------------------------------------------
// The email channel.

/** SmtpPresets::PRESETS' hosts; requiresLogin(). */
export const SMTP_PRESET_HOSTS = [
  "smtp.postshiba.com",
  "email-smtp.us-east-1.amazonaws.com",
  "smtp-relay.brevo.com",
  "smtp.gmail.com",
  "smtp.mailgun.org",
  "in-v3.mailjet.com",
  "smtp.office365.com",
  "smtp.postmarkapp.com",
  "smtp.protonmail.ch",
  "smtp.resend.com",
  "smtp.sendgrid.net",
  "smtp.zoho.com",
];
export function smtpRequiresLogin(host: unknown): boolean {
  const h = String(host ?? "").trim().toLowerCase();
  return h !== "" && SMTP_PRESET_HOSTS.includes(h);
}

function emailRules(): Record<string, RuleList> {
  return {
    smtpEnabled: [R.boolean()],
    smtpFromAddress: [NULLABLE, R.email()],
    smtpFromName: [NULLABLE, R.string()],
    smtpRecipients: [NULLABLE, R.string()],
    smtpHost: [NULLABLE, R.string()],
    smtpPort: [NULLABLE, R.numeric(), R.minNumeric(1), R.maxNumeric(65535)],
    smtpEncryption: [NULLABLE, R.string(), R.in(["starttls", "tls", "none"])],
    smtpUsername: [NULLABLE, R.string()],
    smtpPassword: [NULLABLE, R.string()],
    smtpTimeout: [NULLABLE, R.numeric()],
    smtpEhloDomain: [NULLABLE, R.string()],
    resendEnabled: [R.boolean()],
    resendApiKey: [NULLABLE, R.string()],
    resendFromAddress: [NULLABLE, R.email()],
    resendFromName: [NULLABLE, R.string()],
    emailProvider: [R.required(), R.in(["none", "smtp", "resend"])],
    useInstanceEmailSettings: [R.boolean()],
    deploymentCommitDetailsEmailNotifications: [R.boolean()],
    ...toggleRules("email"),
    testEmailAddress: [NULLABLE, R.email()],
  };
}

/** The columns syncData(true) writes: every rule's property but emailProvider and testEmailAddress, plus smtp_server_name. */
const EMAIL_MODEL_PROPS = Object.keys(emailRules()).filter((p) => p !== "emailProvider" && p !== "testEmailAddress");

/** enabled_email_provider(): Resend before SMTP. */
export function activeEmailProvider(row: SettingsRow): "resend" | "smtp" | "none" {
  if (row.resend_enabled) return "resend";
  if (row.smtp_enabled) return "smtp";
  return "none";
}

function withMessages(rules: Record<string, Array<[Rule | typeof NULLABLE, string?]>>): { rules: Record<string, RuleList>; names: Map<Rule, string> } {
  const names = new Map<Rule, string>();
  const out: Record<string, RuleList> = {};
  for (const [prop, list] of Object.entries(rules)) {
    out[prop] = list.map(([rule, name]) => {
      if (rule !== NULLABLE && name) names.set(rule, name);
      return rule;
    });
  }
  return { rules: out, names };
}

/** Email::validateSmtpSettings(). */
function validateSmtpSettings(state: Props): void {
  const login = smtpRequiresLogin(state.smtpHost);
  const { rules, names } = withMessages({
    smtpEnabled: [[R.boolean()]],
    smtpServerName: [[NULLABLE], [R.string()], [R.maxString(255)]],
    smtpFromAddress: [[R.required(), "required"], [R.email(), "email"]],
    smtpFromName: [[R.required(), "required"], [R.string()]],
    // A stored host is checked again at send time (SafeSmtpHost: not ported, see the header).
    smtpHost: [[R.required(), "required"], [R.string()]],
    smtpPort: [[R.required(), "required"], [R.numeric(), "numeric"]],
    smtpEncryption: [[R.required(), "required"], [R.string()], [R.in(["starttls", "tls", "none"])]],
    smtpUsername: [[R.requiredWhen(login), "required"], [NULLABLE], [R.string()]],
    smtpPassword: [[R.requiredWhen(login), "required"], [NULLABLE], [R.requiredWith("smtpUsername"), "required_with"], [R.string()]],
    smtpTimeout: [[NULLABLE], [R.numeric()]],
    smtpEhloDomain: [[NULLABLE], [R.string()], [R.validHostname()]],
  });
  validate(state, rules, {
    "smtpFromAddress.required": "From Address is required.",
    "smtpFromAddress.email": "Please enter a valid email address.",
    "smtpFromName.required": "From Name is required.",
    "smtpHost.required": "SMTP Host is required.",
    "smtpPort.required": "SMTP Port is required.",
    "smtpPort.numeric": "SMTP Port must be a number.",
    "smtpUsername.required": "This provider needs a username.",
    "smtpPassword.required": "This provider needs a password.",
    "smtpPassword.required_with": "Enter the password for this username.",
    "smtpEncryption.required": "Encryption type is required.",
  }, names);
}

/** Email::validateResendSettings(). */
function validateResendSettings(state: Props): void {
  const on = isTrue(state.resendEnabled);
  const { rules, names } = withMessages({
    resendEnabled: [[R.boolean()]],
    resendApiKey: on ? [[R.required(), "required"], [R.string()]] : [[NULLABLE], [R.string()]],
    resendFromAddress: on ? [[R.required(), "required"], [R.email(), "email"]] : [[NULLABLE], [R.email(), "email"]],
    resendFromName: on ? [[R.required(), "required"], [R.string()]] : [[NULLABLE], [R.string()]],
  });
  validate(state, rules, {
    "resendApiKey.required": "Resend API Key is required.",
    "resendFromAddress.required": "From Address is required.",
    "resendFromAddress.email": "Please enter a valid email address.",
    "resendFromName.required": "From Name is required.",
  }, names);
}

const EMAIL_ACTIONS = ["submit", "selectEmailProvider", "instantSave", "instantSaveDeploymentCommitDetails", "toggleEvent"] as const;
export type EmailAction = (typeof EMAIL_ACTIONS)[number];
export const isEmailAction = (a: unknown): a is EmailAction => typeof a === "string" && (EMAIL_ACTIONS as readonly string[]).includes(a);

/** The email page's actions. `body.type` is instantSave's argument ("SMTP", "Resend" or none). */
export async function runEmailAction(store: SettingsStore, action: EmailAction, body: Props): Promise<ActionResult & { saved: boolean }> {
  const row = await store.load("email");
  const rules = emailRules();
  const state: Props = { ...propsFromRow(row), emailProvider: activeEmailProvider(row), testEmailAddress: null };
  for (const prop of [...Object.keys(rules), "smtpServerName"]) if (prop in body) state[prop] = body[prop];

  /**
   * syncData(true) + saveEmailSettings(): every rule, then every column. With `only`, submitSmtp() and
   * submitResend(): their own validation ran, only their columns are written.
   */
  const sync = async (only?: string[]): Promise<SettingsRow> => {
    if (!only) {
      validate(state, rules);
      const ehlo = state.smtpEhloDomain;
      if (typeof ehlo === "string" && ehlo !== "") {
        const e = hostnameError(attr("smtpEhloDomain"), ehlo);
        if (e) throw new ValidationFailed({ smtpEhloDomain: [e] });
      }
    }
    const changes: SettingsRow = {};
    for (const prop of only ?? [...EMAIL_MODEL_PROPS, "smtpServerName"]) {
      const column = snake(prop);
      let value = state[prop];
      if (rules[prop]?.some((r) => r !== NULLABLE && r.boolean)) value = isTrue(value);
      if (column === "smtp_port" || column === "smtp_timeout") value = isBlank(value) ? null : Math.trunc(Number(value));
      if (!Object.is(row[column], value)) changes[column] = value ?? null;
    }
    return Object.keys(changes).length ? store.save("email", changes) : row;
  };
  const saveModel = async () => ({ row: await sync(), message: SETTINGS_MESSAGES.emailSaved, saved: true });
  /** enableSelectedEmailProvider(): the provider of the list on, then its rules; the saved provider stays on when they fail. */
  const enableSelected = () => {
    state.smtpEnabled = state.emailProvider === "smtp";
    state.resendEnabled = state.emailProvider === "resend";
    if (isTrue(state.smtpEnabled)) validateSmtpSettings(state);
    else if (isTrue(state.resendEnabled)) validateResendSettings(state);
  };

  switch (action) {
    case "submit":
      if (!isTrue(state.useInstanceEmailSettings)) enableSelected();
      return saveModel();
    case "selectEmailProvider":
      try {
        enableSelected();
      } catch (e) {
        // Not complete yet: the page shows the provider's fields and "Not active yet", without an error.
        if (e instanceof ValidationFailed) return { row, message: null, saved: false };
        throw e;
      }
      return saveModel();
    case "instantSave": {
      if (body.type === "SMTP") {
        validateSmtpSettings(state);
        // disableEmailProvidersExcept('smtp'), then smtp_enabled and fillSmtpServerSettings().
        if (isTrue(state.smtpEnabled)) state.resendEnabled = false;
        const saved = await sync(["smtpEnabled", "resendEnabled", "smtpServerName", "smtpFromAddress", "smtpFromName", "smtpHost", "smtpPort", "smtpEncryption", "smtpUsername", "smtpPassword", "smtpTimeout", "smtpEhloDomain"]);
        return { row: saved, message: SETTINGS_MESSAGES.smtpSaved, saved: true };
      }
      if (body.type === "Resend") {
        validateResendSettings(state);
        if (isTrue(state.resendEnabled)) state.smtpEnabled = false;
        const saved = await sync(["smtpEnabled", "resendEnabled", "resendApiKey", "resendFromAddress", "resendFromName"]);
        return { row: saved, message: SETTINGS_MESSAGES.resendSaved, saved: true };
      }
      state.smtpEnabled = false;
      state.resendEnabled = false;
      return saveModel();
    }
    case "instantSaveDeploymentCommitDetails":
      return saveModel();
    case "toggleEvent": {
      const property = typeof body.property === "string" ? body.property : "";
      if (!EVENT_KEYS.map((e) => `${e}EmailNotifications`).includes(property)) throw new SettingsError("Not found", 404);
      state[property] = !isTrue(propsFromRow(row)[property]);
      return saveModel();
    }
  }
}

/** The email page's view: the secrets (SMTP password, Resend API key) only for who can update. */
export function emailView(row: SettingsRow, canUpdate: boolean): Props {
  const props: Props = {};
  for (const prop of [...EMAIL_MODEL_PROPS, "smtpServerName"]) props[prop] = row[snake(prop)] ?? null;
  props.smtpPort = row.smtp_port === null || row.smtp_port === undefined ? null : String(row.smtp_port);
  props.smtpTimeout = row.smtp_timeout === null || row.smtp_timeout === undefined ? null : String(row.smtp_timeout);
  if (!canUpdate) {
    props.smtpPassword = null;
    props.resendApiKey = null;
  }
  props.emailProvider = activeEmailProvider(row);
  return props;
}

/** Email::sendTestEmail()'s validation. */
export function validateTestEmailAddress(address: unknown): string {
  const { rules, names } = withMessages({ testEmailAddress: [[R.required(), "required"], [R.email(), "email"]] });
  validate({ testEmailAddress: address }, rules, { "testEmailAddress.required": "Test email address is required.", "testEmailAddress.email": "Please enter a valid email address." }, names);
  return String(address);
}

