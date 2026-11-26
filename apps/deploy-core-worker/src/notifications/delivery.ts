// Derived from coollabsio/coolify@91b7e3e:app/Notifications/Channels/{DiscordChannel,SlackChannel,TelegramChannel,
// PushoverChannel,WebhookChannel}.php, app/Jobs/{SendMessageToDiscordJob,SendMessageToSlackJob,SendMessageToTelegramJob,
// SendMessageToPushoverJob,SendWebhookJob}.php, app/Traits/{HandlesNotificationResponse,TracksDeliveryFailures,
// HasNotificationSettings}.php and app/Models/Team.php::notify() (Apache-2.0), modified.
//
// Sending one notification to an org's channels, as Coolify's channel classes and jobs do:
//   - which channels: getEnabledChannels($event) — the channel is on and the event's toggle is on (a few
//     events are always sent; "general" never goes by email);
//   - each channel's own skip rules (no URL, no token, the Discord mention turned off);
//   - the request (requests.ts) through an injectable fetch;
//   - the answer: 2xx resets failure_count; 429 and 5xx are retried (5 tries, 10 s apart, as the jobs'
//     $tries and $backoff); a configuration error (an invalid token, a deleted webhook) counts a delivery
//     failure and is not retried; other 4xx are only logged. After 3 failures in a row the channel is turned
//     off and the org's other channels get a GeneralNotification. A test notification never counts.
// Not ported: the throttles of ThrottledNotification and the email rate limit of Reachable/Unreachable
// (NotificationThrottle, isEmailRateLimited) — nothing sends those notifications yet; the email to the
// team admins and the root team's internal notification when a channel is turned off (no instance email,
// WAITING W5; no root team); the audit log line.
import type { PayloadContext } from "./messages.js";
import { buildNotification } from "./payloads.js";
import type { Channel, Notification } from "./notification.js";
import { filled, type PhpValue } from "./php.js";
import {
  discordRequest,
  pushoverRequest,
  redactedUrlForLog,
  slackRequest,
  telegramButtonFallback,
  telegramRequest,
  webhookRequest,
  type ChannelRequest,
  type TelegramSend,
} from "./requests.js";
import { safeWebhookUrlMessage } from "./safe-webhook-url.js";

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

/** One channel's settings row, its encrypted columns decrypted. */
export type SettingsRow = Record<string, unknown>;
export type OrgChannelSettings = { [C in Channel]: SettingsRow };

export const CHANNELS: readonly Channel[] = ["email", "discord", "telegram", "slack", "pushover", "webhook"];
export const CHANNEL_NAMES: Record<Channel, string> = { email: "Email", discord: "Discord", telegram: "Telegram", slack: "Slack", pushover: "Pushover", webhook: "Webhook" };

/** TracksDeliveryFailures::DELIVERY_FAILURE_THRESHOLD. */
export const DELIVERY_FAILURE_THRESHOLD = 3;
/** The jobs' $tries and $backoff (seconds). */
export const TRIES = 5;
export const BACKOFF_MS = 10_000;

/** HasNotificationSettings::$alwaysSendEvents. */
export const ALWAYS_SEND_EVENTS = ["server_force_enabled", "server_force_disabled", "general", "test", "ssl_certificate_renewal", "hetzner_deletion_failure", "api_token_expiring", "api_token_failing"];

/** enabled_email_provider(): Resend before SMTP. */
export function enabledEmailProvider(s: SettingsRow | null | undefined): "resend" | "smtp" | null {
  if (s?.resend_enabled) return "resend";
  if (s?.smtp_enabled) return "smtp";
  return null;
}

/** The settings model's isEnabled(). */
export function isChannelEnabled(channel: Channel, s: SettingsRow | null | undefined): boolean {
  if (!s) return false;
  if (channel === "email") return filled(enabledEmailProvider(s)) || Boolean(s.use_instance_email_settings);
  return Boolean(s[`${channel}_enabled`]);
}

/** getEnabledChannels($event). */
export function enabledChannels(settings: Partial<OrgChannelSettings>, event: string): Channel[] {
  return CHANNELS.filter((channel) => {
    if (event === "general" && channel === "email") return false;
    const s = settings[channel];
    if (!isChannelEnabled(channel, s)) return false;
    if (ALWAYS_SEND_EVENTS.includes(event)) return true;
    return Boolean(s![`${event}_${channel}_notifications`]);
  });
}

/** What became of one channel's notification. */
export type DeliveryOutcome =
  | { channel: Channel; status: "delivered"; httpStatus: number }
  | { channel: Channel; status: "skipped"; reason: string }
  | { channel: Channel; status: "rejected"; reason: string; httpStatus: number; counted: boolean; turnedOff: boolean }
  | { channel: Channel; status: "failed"; reason: string };

/** The request a channel class would hand its job, or why it sends nothing. */
export function channelRequest(
  ctx: PayloadContext,
  channel: Exclude<Channel, "email">,
  n: Notification,
  s: SettingsRow,
): { request: ChannelRequest; telegram?: TelegramSend } | { skip: string } {
  const text = (k: string) => (typeof s[k] === "string" ? (s[k] as string) : "");
  switch (channel) {
    case "discord": {
      const url = text("discord_webhook_url");
      if (!s.discord_enabled || !url) return { skip: "Discord is not enabled or has no webhook URL." };
      const message = n.toDiscord();
      if (!s.discord_ping_enabled) message.isCritical = false;
      return { request: discordRequest(ctx, message, url) };
    }
    case "slack": {
      const url = text("slack_webhook_url");
      if (!s.slack_enabled || !url) return { skip: "Slack is not enabled or has no webhook URL." };
      return { request: slackRequest(ctx, n.toSlack(), url) };
    }
    case "telegram": {
      const data = n.toTelegram();
      const token = text("telegram_token");
      const chatId = text("telegram_chat_id");
      const threadId = n.telegramThread ? text(`telegram_notifications_${n.telegramThread}_thread_id`) || null : null;
      if (!token || !chatId || !data.message) return { skip: "Telegram has no token or chat ID." };
      const send: TelegramSend = { text: data.message, buttons: (data.buttons ?? []) as PhpValue[], token, chatId, threadId };
      return { request: telegramRequest(ctx, send), telegram: send };
    }
    case "pushover": {
      const user = text("pushover_user_key");
      const token = text("pushover_api_token");
      if (!s.pushover_enabled || !user || !token) return { skip: "Pushover is not enabled or has no user key and API token." };
      return { request: pushoverRequest(ctx, n.toPushover(), token, user) };
    }
    case "webhook": {
      const url = text("webhook_url");
      if (!s.webhook_enabled || !url) return { skip: "Webhook is not enabled or has no URL." };
      return { request: webhookRequest(n.toWebhook() as PhpValue, url) };
    }
  }
}

/** The job's configuration errors: these count as a delivery failure and are not retried. */
async function isConfigurationError(channel: Channel, response: Response): Promise<boolean> {
  const status = response.status;
  switch (channel) {
    case "discord":
      return [401, 403, 404].includes(status);
    case "slack":
      return [403, 404, 410].includes(status);
    case "webhook":
      return [401, 403, 404, 410].includes(status);
    case "telegram": {
      if ([401, 403, 404].includes(status)) return true;
      return status === 400 && (await jsonField(response, "description")).toLowerCase().includes("chat not found");
    }
    case "pushover":
      return status >= 400 && status < 500 && ((await jsonField(response, "token")) === "invalid" || (await jsonField(response, "user")) === "invalid");
    case "email":
      return false;
  }
}

async function jsonField(response: Response, key: string): Promise<string> {
  try {
    const body = (await response.clone().json()) as Record<string, unknown>;
    const v = body?.[key];
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

const STATUS_TEXTS: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Content Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a teapot",
  421: "Misdirected Request",
  422: "Unprocessable Content",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
};

/** HandlesNotificationResponse: the reason never has the response body (it can echo tokens). */
export function rejectionReason(channel: Channel, status: number): string {
  return `${CHANNEL_NAMES[channel]} returned HTTP ${status} (${STATUS_TEXTS[status] ?? "Client Error"}).`;
}

/** Records delivery failures and successes on the settings row (TracksDeliveryFailures). */
export interface DeliveryRecorder {
  /** failure_count + 1; answers the new count and whether the channel is still on. */
  recordFailure(channel: Channel, reason: string): Promise<{ failureCount: number; enabled: boolean }>;
  /** Turns the channel off (disableNotificationChannel() and save(), which resets failure_count). */
  disable(channel: Channel): Promise<void>;
  /** failure_count back to 0 when it is not. */
  recordSuccess(channel: Channel): Promise<void>;
}

export interface DeliveryDeps {
  ctx: PayloadContext;
  fetch: Fetch;
  sleep: Sleep;
  recorder: DeliveryRecorder;
  /** 1 for a send inside a request (the test send); TRIES for a queued send. */
  tries?: number;
}

function send(fetch: Fetch, r: ChannelRequest): Promise<Response> {
  return fetch(r.url, { method: r.method, headers: r.headers, body: r.body });
}

/**
 * One channel, as its job runs: the URL check, the request (and Telegram's second request without buttons),
 * then the answer. Retries on 429, 5xx and network errors, up to `tries`.
 */
export async function deliverToChannel(deps: DeliveryDeps, channel: Exclude<Channel, "email">, n: Notification, s: SettingsRow): Promise<DeliveryOutcome> {
  const built = channelRequest(deps.ctx, channel, n, s);
  if ("skip" in built) return { channel, status: "skipped", reason: built.skip };
  if (channel === "discord" || channel === "slack" || channel === "webhook") {
    const problem = safeWebhookUrlMessage("webhook url", built.request.url, `${deps.ctx.baseUrl}/settings/advanced#endpoint-section`);
    // The job logs "blocked unsafe webhook URL" and sends nothing.
    if (problem) return { channel, status: "skipped", reason: problem };
  }
  const tries = Math.max(1, deps.tries ?? TRIES);
  let lastError = "";
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (attempt > 1) await deps.sleep(BACKOFF_MS);
    let response: Response;
    try {
      response = await send(deps.fetch, built.request);
      if (channel === "telegram" && built.telegram) {
        const fallback = telegramButtonFallback(deps.ctx, built.telegram, response.status, await jsonField(response, "description"));
        if (fallback) response = await send(deps.fetch, fallback);
      }
    } catch (e) {
      // sendNotificationRequest(): the message names only the scheme and host, never the token in the URL.
      void e;
      lastError = `${CHANNEL_NAMES[channel]} notification request to ${redactedUrlForLog(built.request.url)} failed (ConnectionException).`;
      continue;
    }
    if (response.ok) {
      if (!n.isTest) await deps.recorder.recordSuccess(channel);
      return { channel, status: "delivered", httpStatus: response.status };
    }
    if (response.status === 429 || response.status >= 500) {
      lastError = `${CHANNEL_NAMES[channel]} notification failed with ${response.status} status code.`;
      continue;
    }
    const reason = rejectionReason(channel, response.status);
    const configurationError = await isConfigurationError(channel, response);
    const counted = configurationError && !n.isTest;
    const turnedOff = counted ? await recordFailure(deps, channel, reason) : false;
    return { channel, status: "rejected", reason, httpStatus: response.status, counted, turnedOff };
  }
  return { channel, status: "failed", reason: lastError };
}

/** TracksDeliveryFailures::recordDeliveryFailure(): true when this failure turned the channel off. */
async function recordFailure(deps: DeliveryDeps, channel: Channel, reason: string): Promise<boolean> {
  const { failureCount, enabled } = await deps.recorder.recordFailure(channel, reason);
  if (failureCount < DELIVERY_FAILURE_THRESHOLD || !enabled) return false;
  await deps.recorder.disable(channel);
  return true;
}

/** notifyOtherChannels(): the GeneralNotification that a channel was turned off. */
export function channelDisabledNotification(ctx: PayloadContext, channel: Channel, reason: string): Notification {
  const name = CHANNEL_NAMES[channel];
  return buildNotification(ctx, {
    class: "GeneralNotification",
    input: {
      message: `${name} notifications were disabled after ${DELIVERY_FAILURE_THRESHOLD} failed deliveries in a row.\nReason: ${reason}\nPlease fix the settings and enable ${name} notifications again: ${ctx.baseUrl}/notifications/${channel}`,
      success: false,
    },
  });
}

export interface NotifyDeps extends DeliveryDeps {
  /** The org's six settings rows, decrypted (read again after a channel is turned off). */
  loadSettings(): Promise<OrgChannelSettings>;
}

/**
 * Team::notify(): the notification to every enabled channel of the org. Email is skipped: its body is not
 * ported (only the test email is sent, by the email page). Wired to nothing that fires yet — deployments,
 * backups and server checks call it once the executor runs them.
 */
export async function notify(deps: NotifyDeps, n: Notification): Promise<DeliveryOutcome[]> {
  const settings = await deps.loadSettings();
  const outcomes: DeliveryOutcome[] = [];
  for (const channel of enabledChannels(settings, n.event)) {
    if (channel === "email") {
      outcomes.push({ channel, status: "skipped", reason: "Email notifications are not available yet: the email body is not ported." });
      continue;
    }
    outcomes.push(await deliverToChannel(deps, channel, n, settings[channel]));
  }
  // The other channels learn that one was turned off; the turned-off one is not enabled anymore.
  const notices = outcomes.flatMap((o) => (o.status === "rejected" && o.turnedOff ? [{ channel: o.channel, reason: o.reason }] : []));
  if (notices.length > 0) {
    const fresh = await deps.loadSettings();
    for (const { channel, reason } of notices) {
      const general = channelDisabledNotification(deps.ctx, channel, reason);
      for (const other of enabledChannels(fresh, "general")) {
        if (other !== "email" && other !== channel) await deliverToChannel(deps, other, general, fresh[other]);
      }
    }
  }
  return outcomes;
}

