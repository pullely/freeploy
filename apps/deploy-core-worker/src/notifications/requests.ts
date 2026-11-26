// Derived from coollabsio/coolify@91b7e3e:app/Jobs/{SendMessageToDiscordJob,SendMessageToSlackJob,
// SendMessageToTelegramJob,SendMessageToPushoverJob,SendWebhookJob}.php, app/Notifications/Channels/EmailChannel.php
// (the Resend call), bootstrap/helpers/notifications.php (mail_from_identity) and resend/resend-php 1.18.0's
// HTTP transporter (Apache-2.0 / MIT), modified.
//
// The HTTP requests Coolify's jobs send, exactly: URL, method, the headers Laravel's client (Guzzle) or the
// Resend SDK sets, and the body as json_encode() writes it. fixtures/notifications/goldens.json holds the
// requests Coolify's own jobs made for every case.
import type { DiscordMessage, PayloadContext, PushoverMessage, SlackMessage } from "./messages.js";
import { buttonText, buttonUrl, phpJsonEncode, phpTrim, type Button, type PhpValue } from "./php.js";

export interface ChannelRequest {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Laravel's HTTP client: Guzzle's User-Agent and the `json` body option. */
const LARAVEL_JSON_HEADERS = { "Content-Type": "application/json", "User-Agent": "GuzzleHttp/7" };

function laravelPost(url: string, data: PhpValue): ChannelRequest {
  return { method: "POST", url, headers: { ...LARAVEL_JSON_HEADERS }, body: phpJsonEncode(data) };
}

/** SendMessageToDiscordJob: the message's payload to the webhook. */
export function discordRequest(ctx: PayloadContext, message: DiscordMessage, webhookUrl: string): ChannelRequest {
  return laravelPost(webhookUrl, message.toPayload(ctx));
}

/** SendMessageToSlackJob::isSlackWebhook(): only https://hooks.slack.com gets Slack's blocks; any other URL is Mattermost. */
export function isSlackWebhook(webhookUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.hostname === "hooks.slack.com";
}

export function slackRequest(ctx: PayloadContext, message: SlackMessage, webhookUrl: string): ChannelRequest {
  if (isSlackWebhook(webhookUrl)) {
    return laravelPost(webhookUrl, {
      text: message.title,
      blocks: [{ type: "section", text: { type: "plain_text", text: `${ctx.brand} Notification` } }],
      attachments: [
        {
          color: message.color,
          blocks: [
            { type: "header", text: { type: "plain_text", text: message.title } },
            { type: "section", text: { type: "mrkdwn", text: message.description } },
          ],
        },
      ],
    });
  }
  return laravelPost(webhookUrl, {
    username: ctx.appName,
    attachments: [{ title: message.title, color: message.color, text: message.description, footer: ctx.appName }],
  });
}

export interface TelegramSend {
  text: string;
  buttons: Button[];
  token: string;
  chatId: string;
  threadId: string | null;
}

function telegramInlineButtons(ctx: PayloadContext, buttons: Button[]): Array<{ text: string; url: string | null }> {
  return buttons.map((button) => {
    let url = buttonUrl(button);
    if (url && url.includes("http://localhost")) url = url.split("http://localhost").join(ctx.appUrl);
    return { text: buttonText(button), url };
  });
}

/** SendMessageToTelegramJob::sendMessage(): the first request, with the buttons as an inline keyboard. */
export function telegramRequest(ctx: PayloadContext, send: TelegramSend): ChannelRequest {
  const url = "https://api.telegram.org/bot" + phpTrim(send.token) + "/sendMessage";
  const inline = telegramInlineButtons(ctx, send.buttons);
  return laravelPost(url, { ...telegramPayload(send), reply_markup: phpJsonEncode({ inline_keyboard: [inline] }) });
}

function telegramPayload(send: TelegramSend): { [key: string]: PhpValue } {
  const payload: { [key: string]: PhpValue } = { chat_id: phpTrim(send.chatId), text: send.text };
  if (send.threadId) payload.message_thread_id = send.threadId;
  return payload;
}

/**
 * The second request, when Telegram rejects the whole message because it cannot open a button URL (400 with
 * "button url" or "button_url" in its description): the text again with the links in it, without buttons.
 */
export function telegramButtonFallback(ctx: PayloadContext, send: TelegramSend, status: number, description: string | null): ChannelRequest | null {
  const inline = telegramInlineButtons(ctx, send.buttons);
  const d = (description ?? "").toLowerCase();
  if (inline.length === 0 || status !== 400 || !(d.includes("button url") || d.includes("button_url"))) return null;
  const links = inline.map((b) => `${b.text}: ${b.url ?? ""}`).join("\n");
  const url = "https://api.telegram.org/bot" + phpTrim(send.token) + "/sendMessage";
  return laravelPost(url, { ...telegramPayload(send), text: `${send.text}\n\n${links}` });
}

export const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";

export function pushoverRequest(ctx: PayloadContext, message: PushoverMessage, token: string, user: string): ChannelRequest {
  return laravelPost(PUSHOVER_URL, message.toPayload(ctx, token, user));
}

export function webhookRequest(payload: PhpValue, webhookUrl: string): ChannelRequest {
  return laravelPost(webhookUrl, payload);
}

export interface EmailSender {
  resend_enabled: boolean;
  resend_from_address: string | null;
  resend_from_name: string | null;
  smtp_from_address: string | null;
  smtp_from_name: string | null;
}

export class SenderNotConfigured extends Error {
  constructor() {
    super("Transactional email sender address is not configured.");
  }
}

/**
 * mail_from_identity($settings) for a team's own settings: each provider has its own sender, and Resend uses
 * the SMTP sender when it has none. Then Symfony's Address::toString(): the name always in double quotes.
 */
export function mailFromFormatted(ctx: PayloadContext, s: EmailSender): string {
  const providerSender = (field: "from_address" | "from_name"): string => {
    const value = phpTrim(s.resend_enabled ? (s[`resend_${field}`] ?? "") : "");
    return value !== "" ? value : phpTrim(s[`smtp_${field}`] ?? "");
  };
  const address = providerSender("from_address");
  if (address === "") throw new SenderNotConfigured();
  const name = providerSender("from_name") || ctx.brand;
  return `"${name.replace(/"/g, '\\"')}" <${address}>`;
}

export const RESEND_URL = "https://api.resend.com/emails";

/** EmailChannel with Resend: Resend::client($key)->emails->send(['from', 'to', 'subject', 'html']). */
export function resendRequest(apiKey: string, email: { from: string; to: string[]; subject: string; html: string }): ChannelRequest {
  return {
    method: "POST",
    url: RESEND_URL,
    headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "resend-php/1.18.0", "Content-Type": "application/json" },
    body: phpJsonEncode({ from: email.from, to: email.to, subject: email.subject, html: email.html }),
  };
}

/** SafeWebhookUrl::redactedUrlForLog(): only the scheme, host and port. */
export function redactedUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol.slice(0, -1).toLowerCase()}://${u.hostname.toLowerCase()}${u.port ? ":" + u.port : ""}`;
  } catch {
    return "[invalid-url]";
  }
}

