// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/NotificationsController.php (channelConfig,
// allowedFields, serializeSettings, resolveSettings, showChannel, updateChannel), app/Models/{Email,Discord,Slack,
// Telegram,Pushover,Webhook}NotificationSettings.php ($fillable, $hidden, $casts), app/Traits/{HasSmtpServers,
// TracksDeliveryFailures}.php, app/Rules/{SafeSmtpHost,SafeWebhookUrl,ValidHostname}.php, bootstrap/helpers/api.php
// (exposeSensitiveFields) and Laravel's Eloquent dirty check (originalIsEquivalent) (Apache-2.0 / MIT), modified.
//
// Coolify's /api/v1 for the team's notification channels (DP-85): GET and PATCH /notifications/{channel} for email,
// discord, slack, telegram, pushover and webhook, on DP-67's settings rows (packages/db's deploy/notification-settings.ts:
// one row per org, the `encrypted` casts as fp1 ciphertexts of the org's data key, the console's store). A channel is
// answered as the model serializes: every column, the hidden ones (the secrets) only for a token that may read them,
// decrypted, Coolify's team_id in place of the org, through serializeApiResponse(). An update validates the body with the
// controller's rules (Laravel's messages; SafeWebhookUrl and SafeSmtpHost through the context's resolver, as Coolify
// Cloud checks them: no private network), refuses every field that is not fillable, then writes only what Eloquent finds
// dirty — and so resets failure_count only then (TracksDeliveryFailures' saving hook). Coolify's API has no test send.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { NOTIFICATION_EVENTS, updateNotificationSettings, type ApiRow, type ApiTable, type NotificationChannel } from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, serializeApiResponse, type CoolifyAnswer, type PhpObject } from "@saas/contracts/coolify-api";
import { columnCipher } from "../handlers/cloud-tokens.js";
import { isEmail } from "../notifications/settings.js";
import { classifyIp, parseIpv6, safeUrlError, type HostResolver } from "../s3-storages/safe-url.js";
import { hostnameError } from "../servers/ip.js";
import { decryptColumn, rowsOf, type ApiV1Context } from "./context.js";
import { rowValue, toModel } from "./models.js";
import { addError, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rule, type Rules } from "./rules.js";

export const API_NOTIFICATION_CHANNELS: readonly NotificationChannel[] = ["email", "discord", "slack", "telegram", "pushover", "webhook"];

interface ChannelModel {
  /** $fillable without team_id, which is what the request may send (allowedFields()). */
  fields: readonly string[];
  /** $hidden (HasSmtpServers adds smtp_servers to the email's). */
  hidden: readonly string[];
  /** The `encrypted` casts. */
  encrypted: readonly string[];
  /** The `boolean` and `integer` casts: a value is compared with the stored one cast (Eloquent's dirty check). */
  booleans: readonly string[];
  integers: readonly string[];
}

const events = (channel: NotificationChannel): string[] => NOTIFICATION_EVENTS.map((e) => `${e}_${channel}_notifications`);
/** The casts name docker_cleanup_<channel>_notifications, which is no column: the two Docker cleanup toggles have no cast but on webhook's. */
const castEvents = (channel: NotificationChannel): string[] => events(channel).filter((c) => channel === "webhook" || !c.startsWith("docker_cleanup_"));
const THREADS = NOTIFICATION_EVENTS.map((e) => `telegram_notifications_${e}_thread_id`);

const MODELS: Record<NotificationChannel, ChannelModel> = {
  email: {
    fields: [
      "smtp_enabled",
      "smtp_from_address",
      "smtp_from_name",
      "smtp_recipients",
      "smtp_host",
      "smtp_port",
      "smtp_encryption",
      "smtp_username",
      "smtp_password",
      "smtp_timeout",
      "smtp_ehlo_domain",
      "resend_enabled",
      "resend_api_key",
      "resend_from_address",
      "resend_from_name",
      "use_instance_email_settings",
      "deployment_success_email_notifications",
      "deployment_failure_email_notifications",
      "deployment_commit_details_email_notifications",
      ...events("email").slice(2),
    ],
    hidden: ["smtp_from_address", "smtp_from_name", "smtp_recipients", "smtp_host", "smtp_username", "smtp_password", "resend_api_key", "resend_from_address", "resend_from_name", "smtp_servers"],
    encrypted: ["smtp_from_address", "smtp_from_name", "smtp_recipients", "smtp_host", "smtp_username", "smtp_password", "resend_api_key", "resend_from_address", "resend_from_name"],
    // EmailNotificationSettings casts neither Docker cleanup toggle nor server_reachable / server_unreachable.
    booleans: ["smtp_enabled", "resend_enabled", "use_instance_email_settings", "deployment_commit_details_email_notifications", ...castEvents("email").filter((c) => !c.startsWith("server_reachable") && !c.startsWith("server_unreachable"))],
    integers: ["smtp_port", "smtp_timeout"],
  },
  discord: {
    fields: ["discord_enabled", "discord_webhook_url", ...events("discord"), "discord_ping_enabled"],
    hidden: ["discord_webhook_url"],
    encrypted: ["discord_webhook_url"],
    booleans: ["discord_enabled", "discord_ping_enabled", ...castEvents("discord")],
    integers: [],
  },
  slack: {
    fields: ["slack_enabled", "slack_webhook_url", ...events("slack")],
    hidden: ["slack_webhook_url"],
    encrypted: ["slack_webhook_url"],
    booleans: ["slack_enabled", ...castEvents("slack")],
    integers: [],
  },
  telegram: {
    fields: ["telegram_enabled", "telegram_token", "telegram_chat_id", ...events("telegram"), ...THREADS],
    hidden: ["telegram_token", "telegram_chat_id", ...THREADS],
    encrypted: ["telegram_token", "telegram_chat_id", ...THREADS],
    booleans: ["telegram_enabled", ...castEvents("telegram")],
    integers: [],
  },
  pushover: {
    fields: ["pushover_enabled", "pushover_user_key", "pushover_api_token", ...events("pushover")],
    hidden: ["pushover_user_key", "pushover_api_token"],
    encrypted: ["pushover_user_key", "pushover_api_token"],
    booleans: ["pushover_enabled", ...castEvents("pushover")],
    integers: [],
  },
  webhook: {
    fields: ["webhook_enabled", "webhook_url", ...events("webhook")],
    hidden: ["webhook_url"],
    encrypted: ["webhook_url"],
    booleans: ["webhook_enabled", ...castEvents("webhook")],
    integers: [],
  },
};

const tableOf = (channel: NotificationChannel) => `${channel}_notification_settings` as ApiTable;
const inOrg = <T>(c: ApiV1Context, fn: (tx: SqlExecutor) => Promise<T>): Promise<T> => c.sql(c.env, c.orgId, fn);

/** routes/api.php's /notifications/{channel} routes; null for every other path (the caller answers the fallback 404). */
export async function notificationsApi(c: ApiV1Context, segments: string[]): Promise<CoolifyAnswer | null> {
  const [channel, extra] = segments;
  if (extra !== undefined || !API_NOTIFICATION_CHANNELS.includes(channel as NotificationChannel)) return null;
  if (c.method === "GET") return showChannel(c, channel as NotificationChannel);
  if (c.method === "PATCH") return updateChannel(c, channel as NotificationChannel);
  return null;
}

// ── the settings row ────────────────────────────────────────────────────────

/** resolveSettings(): firstOrCreate(['team_id' => …]) — the console's ensureNotificationSettings(), then the row whole. */
async function settingsRow(tx: SqlExecutor, c: ApiV1Context, channel: NotificationChannel): Promise<ApiRow> {
  await tx.execute(`INSERT INTO deploy.${tableOf(channel)} (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING`, [c.orgId]);
  const row = (await rowsOf(tx)(tableOf(channel)))[0];
  if (!row) throw new Error(`No ${channel} notification settings for the org`);
  return row;
}

/** A column of the `encrypted` (and smtp_servers' `encrypted:array`) cast, decrypted. */
async function plainValue(tx: SqlExecutor, c: ApiV1Context, channel: NotificationChannel, column: string, stored: unknown): Promise<unknown> {
  if (column === "smtp_servers") {
    // Never written by Freeploy (the named SMTP servers are not ported); a saved list would be JSON once decrypted.
    const text = await decryptColumn(tx, c, tableOf(channel), column, stored);
    return text === null ? null : (JSON.parse(text) as unknown);
  }
  return decryptColumn(tx, c, tableOf(channel), column, stored);
}

/** serializeSettings(): exposeSensitiveFields() for a token that may read secrets, the team relation hidden, serializeApiResponse(). */
async function serialize(tx: SqlExecutor, c: ApiV1Context, channel: NotificationChannel, row: ApiRow): Promise<PhpObject> {
  const model = MODELS[channel];
  const shown: ApiRow = [];
  for (const [k, v] of row) {
    if (c.canReadSensitive && (model.encrypted.includes(k) || k === "smtp_servers")) shown.push([k, await plainValue(tx, c, channel, k, v)]);
    else shown.push([k, v]);
  }
  return serializeApiResponse(toModel(shown, { hidden: model.hidden, dates: [] }, { teamId: c.orgPublicId, visible: c.canReadSensitive ? model.hidden : [] }));
}

async function showChannel(c: ApiV1Context, channel: NotificationChannel): Promise<CoolifyAnswer> {
  return inOrg(c, async (tx) => {
    const row = await settingsRow(tx, c, channel);
    if (!(await c.allows(false))) return unauthorized();
    return coolifyJson(await serialize(tx, c, channel, row));
  });
}

const unauthorized = () => COOLIFY_API.unauthorized();

// ── validation ──────────────────────────────────────────────────────────────

/** Laravel's `email` (as far as a setting needs it): a string, local@domain without spaces. */
export const email = (attribute: string): Rule => ({ closure: (v) => (typeof v === "string" && isEmail(v) ? [] : [`The ${attribute.replace(/_/g, " ")} field must be a valid email address.`]) });
/** `in:a,b,c`: the value as a string is one of them (an array never is). */
const inList = (attribute: string, list: readonly string[]): Rule => ({
  closure: (v) => (v !== null && typeof v !== "object" && list.includes(v === true ? "1" : v === false ? "" : String(v)) ? [] : [`The selected ${attribute.replace(/_/g, " ")} is invalid.`]),
});

/** ValidHostname: empty values pass; a string's failure message (:attribute as Laravel shows it). */
export const validHostname = (attribute: string): Rule => ({
  closure: (v) => {
    if (v === null || v === undefined || v === false || v === "" || v === "0" || v === 0) return [];
    if (typeof v !== "string" && typeof v !== "number") return [];
    const error = hostnameError(attribute.replace(/_/g, " "), String(v));
    return error ? [error] : [];
  },
});

/** SafeWebhookUrl, with the message's :attribute as Laravel shows it and the private-target message's raw key. */
const safeWebhookUrl = (attribute: string, resolve: HostResolver): Rule => ({
  closure: async (v) => {
    // The rule's default schemes: http, then https (the S3 endpoint's list is the other way round).
    const error = await safeUrlError(v, attribute.replace(/_/g, " "), attribute, resolve, ["http", "https"]);
    return error ? [error] : [];
  },
});

export const SMTP_HOST_MESSAGES = {
  invalid: "The SMTP host must be a valid hostname or IP address.",
  unresolved: "The SMTP host could not be resolved.",
  linkLocal: "The SMTP host must not point to link-local addresses.",
  /** isInstanceAdmin() is false for every API token's user (Freeploy has no instance admin in an org). */
  blocked: "The SMTP host points to a local or private address that is not allowed. Ask your Coolify administrator to allow this host.",
} as const;

/** PHP's FILTER_VALIDATE_IP: an IPv4 or IPv6 address (no brackets). */
const isIp = (host: string): boolean => classifyIp(host) !== null;

/** inet_ntop(inet_pton()) of an IPv6 address: lower case, the longest run of zero groups (two or more) compressed. */
function canonicalIpv6(ip: string): string {
  const groups = parseIpv6(ip);
  if (!groups) return ip;
  const words: number[] = [];
  for (let i = 0; i < 16; i += 2) words.push((groups[i]! << 8) | groups[i + 1]!);
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (words[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && words[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = words.map((w) => w.toString(16));
  if (best === -1) return hex.join(":");
  return `${hex.slice(0, best).join(":")}::${hex.slice(best + bestLen).join(":")}`;
}

/** SafeSmtpHost::normalizeHost(): an IP address without brackets, or a lower-case name without one trailing dot. */
function normalizeSmtpHost(value: string): string {
  let host = value.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "");
  const bare = host.replace(/^\[+|\]+$/g, "");
  if (parseIpv6(bare) !== null && !/^\d+\.\d+\.\d+\.\d+$/.test(bare)) host = canonicalIpv6(bare);
  if (isIp(host)) return host;
  host = host.toLowerCase();
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

/** SafeSmtpHost::isValidHost(): an IP address, or labels of letters, digits, hyphens and underscores. */
function isValidSmtpHost(host: string): boolean {
  if (isIp(host)) return true;
  if (host === "" || new TextEncoder().encode(host).length > 253) return false;
  return host.split(".").every((label) => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i.test(label));
}

/**
 * SafeSmtpHost: SafeWebhookUrl::forSmtpHost()->checkConnectionHost() as on Coolify Cloud (gitSourcesMayUsePrivateNetworks()
 * is false: Freeploy is a hosted service) — localhost, *.local, *.internal and *.cluster.local blocked, a name resolved,
 * every address public.
 */
export async function smtpHostError(value: unknown, resolve: HostResolver): Promise<string | null> {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0)) return null;
  const host = typeof value === "string" ? normalizeSmtpHost(value) : "";
  if (!isValidSmtpHost(host)) return SMTP_HOST_MESSAGES.invalid;
  const forDns = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (forDns === "localhost" || forDns.endsWith(".local") || forDns.endsWith(".internal") || forDns.endsWith(".cluster.local")) return SMTP_HOST_MESSAGES.blocked;
  const ips = isIp(forDns) ? [forDns] : (await resolve(forDns)).filter(isIp);
  if (ips.length === 0) return SMTP_HOST_MESSAGES.unresolved;
  for (const ip of ips) {
    const kind = classifyIp(ip);
    if (kind !== "public") return kind === "link-local" ? SMTP_HOST_MESSAGES.linkLocal : SMTP_HOST_MESSAGES.blocked;
  }
  return null;
}

/** channelConfig()['rules'], in the controller's order (every rule `sometimes`: an absent field is not validated). */
function channelRules(channel: NotificationChannel, resolve: HostResolver): Rules {
  const bool = (f: string): [string, Rule[]] => [f, ["boolean"]];
  const text = (f: string, max = 255): [string, Rule[]] => [f, ["nullable", "string", `max:${max}`]];
  const webhook = (f: string): [string, Rule[]] => [f, ["nullable", "string", safeWebhookUrl(f, resolve)]];
  switch (channel) {
    case "email":
      return [
        bool("smtp_enabled"),
        ["smtp_from_address", ["nullable", email("smtp_from_address")]],
        text("smtp_from_name"),
        text("smtp_recipients", 1000),
        ["smtp_host", ["nullable", "string", "max:255", { closure: async (v) => [(await smtpHostError(v, resolve)) ?? ""].filter(Boolean) }]],
        ["smtp_port", ["nullable", "integer", "min:1", "max:65535"]],
        ["smtp_encryption", ["nullable", "string", inList("smtp_encryption", ["starttls", "tls", "none"])]],
        text("smtp_username"),
        text("smtp_password"),
        ["smtp_timeout", ["nullable", "integer", "min:0"]],
        ["smtp_ehlo_domain", ["nullable", "string", "max:255", validHostname("smtp_ehlo_domain")]],
        bool("resend_enabled"),
        text("resend_api_key"),
        ["resend_from_address", ["nullable", email("resend_from_address")]],
        text("resend_from_name"),
        bool("use_instance_email_settings"),
        bool("deployment_success_email_notifications"),
        bool("deployment_failure_email_notifications"),
        bool("deployment_commit_details_email_notifications"),
        ...events("email").slice(2).map(bool),
      ];
    case "discord":
      return [bool("discord_enabled"), webhook("discord_webhook_url"), ...events("discord").map(bool), bool("discord_ping_enabled")];
    case "slack":
      return [bool("slack_enabled"), webhook("slack_webhook_url"), ...events("slack").map(bool)];
    case "telegram":
      return [bool("telegram_enabled"), text("telegram_token"), text("telegram_chat_id"), ...events("telegram").map(bool), ...THREADS.map((t) => text(t))];
    case "pushover":
      return [bool("pushover_enabled"), text("pushover_user_key"), text("pushover_api_token"), ...events("pushover").map(bool)];
    case "webhook":
      return [bool("webhook_enabled"), webhook("webhook_url"), ...events("webhook").map(bool)];
  }
}

// ── writing ─────────────────────────────────────────────────────────────────

/** PHP's is_numeric() */
const isNumeric = (v: unknown): boolean => (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(v));
/** (string) of a scalar, as strcmp() reads it */
const phpString = (v: unknown): string => (v === true ? "1" : v === false || v === null || v === undefined ? "" : String(v));
/** (bool) of a request value */
const phpBool = (v: unknown): boolean => !(v === null || v === undefined || v === false || v === 0 || v === "" || v === "0");

/**
 * Eloquent's originalIsEquivalent(): a value given is the same as the stored one — identical, or equal once cast
 * (`boolean`, `integer`, `encrypted`: the stored ciphertext decrypted), or two numerics written alike.
 */
function isEquivalent(model: ChannelModel, column: string, given: unknown, stored: unknown): boolean {
  if (given === stored) return true;
  if (given === null) return false;
  if (model.booleans.includes(column)) return stored !== null && phpBool(given) === phpBool(stored);
  if (model.integers.includes(column)) return stored !== null && Math.trunc(Number(given)) === Number(stored);
  if (model.encrypted.includes(column)) return false;
  return isNumeric(given) && isNumeric(stored) && phpString(given) === phpString(stored);
}

/** A boolean column, cast or not (the toggles, the providers' switches). */
const isBooleanColumn = (column: string): boolean => column.endsWith("_notifications") || column.endsWith("_enabled") || column === "use_instance_email_settings";

/** What PostgreSQL stores for a value given: a boolean column reads "1", 1 and true as true; an integer column the number. */
function storedValue(model: ChannelModel, column: string, given: unknown): unknown {
  if (given === null) return null;
  if (isBooleanColumn(column)) return phpBool(given);
  if (model.integers.includes(column)) return Math.trunc(Number(given));
  return given;
}

async function updateChannel(c: ApiV1Context, channel: NotificationChannel): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  const model = MODELS[channel];
  const errors: Errors = [];
  await validateRules(errors, all, channelRules(channel, c.s3.resolve), { laravelMessages: true });
  for (const k of Object.keys(all)) if (!model.fields.includes(k)) addError(errors, k, "This field is not allowed.");
  if (errors.length) return validationFailed(errors);
  return inOrg(c, async (tx) => {
    const row = await settingsRow(tx, c, channel);
    if (!(await c.allows(true))) return unauthorized();
    // $settings->fill(…)->save(): only the dirty columns are written (and then failure_count is reset by the saving hook).
    const changes: Record<string, unknown> = {};
    const cipher = (column: string) => columnCipher(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, `${tableOf(channel)}.${column}`);
    for (const column of model.fields) {
      if (!(column in all)) continue;
      const given = all[column];
      const stored = rowValue(row, column);
      if (model.encrypted.includes(column)) {
        const plain = await plainValue(tx, c, channel, column, stored);
        if (given === plain) continue;
        changes[column] = given === null ? null : await cipher(column).encrypt(String(given));
        continue;
      }
      if (isEquivalent(model, column, given, stored)) continue;
      changes[column] = storedValue(model, column, given);
    }
    if (Object.keys(changes).length) await updateNotificationSettings(tx, channel, changes);
    // $settings->refresh()
    return coolifyJson(await serialize(tx, c, channel, await settingsRow(tx, c, channel)));
  });
}

