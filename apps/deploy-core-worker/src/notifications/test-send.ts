// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Notifications/*.php::sendTestNotification() and
// Email::sendTestEmail(), app/Notifications/Test.php and app/Notifications/Channels/EmailChannel.php (the
// Resend call and its error messages) (Apache-2.0), modified.
//
// "Send test". Discord, Slack, Pushover and webhook: Coolify queues the Test notification and answers
// "Test notification sent." at once, whatever the channel answers later; here it is sent inside the
// request, once (a queued job would retry 429 and 5xx), and the answer says "Test notification sent." as
// Coolify does, with what the channel answered beside it. Telegram: sent synchronously, as Coolify does,
// so that Telegram's error is shown. A test never counts as a delivery failure.
//
// Email: the team's own Resend settings are sent as EmailChannel sends them (the Resend API over fetch).
// SMTP is not available yet, and neither are the instance's email settings (WAITING W5).
import { e } from "./php.js";
import type { PayloadContext } from "./messages.js";
import { buildNotification, testEmailHtml } from "./payloads.js";
import { deliverToChannel, type DeliveryOutcome, type DeliveryRecorder, type Fetch, type SettingsRow } from "./delivery.js";
import { mailFromFormatted, resendRequest, SenderNotConfigured, telegramButtonFallback, telegramRequest } from "./requests.js";
import { SETTINGS_MESSAGES, SettingsError, validateTestEmailAddress } from "./settings.js";

export const SMTP_NOT_AVAILABLE =
  "SMTP is not available yet: a Cloudflare Worker cannot open an SMTP connection on its own. Sending over SMTP needs Cloudflare's connect() TCP sockets with STARTTLS (or TLS on port 465), or Cloudflare Email Workers. Use Resend to send email for now.";
export const INSTANCE_EMAIL_NOT_AVAILABLE =
  "The hosted email service is not available yet: Freeploy has no sending domain. Use the team email settings with Resend.";

/** A recorder for tests: Coolify passes no settings to a test's job, so nothing is counted. */
const NO_RECORDING: DeliveryRecorder = {
  recordFailure: async () => ({ failureCount: 0, enabled: false }),
  disable: async () => undefined,
  recordSuccess: async () => undefined,
};

async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.clone().json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** sendTestNotification() of a chat channel. Answers the toast and what the channel answered. */
export async function sendTestNotification(
  ctx: PayloadContext,
  fetch: Fetch,
  channel: "discord" | "telegram" | "slack" | "pushover" | "webhook",
  row: SettingsRow,
): Promise<{ message: string; delivery: DeliveryOutcome }> {
  const test = buildNotification(ctx, { class: "Test", input: { ping: false } });
  if (channel === "telegram") {
    // new SendMessageToTelegramJob(text, buttons, token, chatId)->sendMessage(): the settings' token and chat, no thread.
    const data = test.toTelegram();
    const send = { text: data.message, buttons: data.buttons ?? [], token: String(row.telegram_token ?? ""), chatId: String(row.telegram_chat_id ?? ""), threadId: null };
    const first = telegramRequest(ctx, send);
    let response = await fetch(first.url, { method: first.method, headers: first.headers, body: first.body });
    const fallback = telegramButtonFallback(ctx, send, response.status, typeof (await json(response)).description === "string" ? ((await json(response)).description as string) : null);
    if (fallback) response = await fetch(fallback.url, { method: fallback.method, headers: fallback.headers, body: fallback.body });
    if (!response.ok) {
      const description = (await json(response)).description;
      const reason = [401, 404].includes(response.status) ? SETTINGS_MESSAGES.telegramInvalidToken : typeof description === "string" ? description : `HTTP ${response.status}`;
      throw new SettingsError(SETTINGS_MESSAGES.telegramRejected, 422, e(reason));
    }
    return { message: SETTINGS_MESSAGES.testSent, delivery: { channel, status: "delivered", httpStatus: response.status } };
  }
  const delivery = await deliverToChannel({ ctx, fetch, sleep: async () => undefined, recorder: NO_RECORDING, tries: 1 }, channel, test, row);
  return { message: SETTINGS_MESSAGES.testSent, delivery };
}

/** RateLimiter::attempt('test-email:'.$team->id, 0, …, 10): one test email per org every 10 seconds. */
export class TestEmailLimiter {
  private readonly until = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}
  attempt(orgId: string): boolean {
    const t = this.now();
    if ((this.until.get(orgId) ?? 0) > t) return false;
    this.until.set(orgId, t + 10_000);
    return true;
  }
}

/** EmailChannel's messages for a Resend error, by its status code and error name. */
export function resendErrorMessage(status: number, name: string | null, message: string): string {
  if (name === "restricted_api_key" || (status === 401 && name === null)) return "Your Resend API key has restricted permissions. Please use an API key with Full Access permissions.";
  if (status === 401 || (status === 403 && name !== "validation_error")) return "Invalid Resend API key. Please verify your API key in the Resend dashboard and update it in settings.";
  if (status === 400 || status === 422 || name === "validation_error") return "Email validation failed: " + message;
  if (status === 429 && (name === null || name === "rate_limit_exceeded")) return "Resend rate limit exceeded. Please try again in a few minutes.";
  return "Failed to send email via Resend: " + message;
}

/** Email::sendTestEmail(): the Test email to the address, with the team's provider. */
export async function sendTestEmail(ctx: PayloadContext, fetch: Fetch, orgId: string, row: SettingsRow, address: unknown, limiter: TestEmailLimiter): Promise<{ message: string }> {
  const to = validateTestEmailAddress(address);
  if (!limiter.attempt(orgId)) throw new SettingsError(SETTINGS_MESSAGES.tooManyMessages);
  if (row.use_instance_email_settings) throw new SettingsError(INSTANCE_EMAIL_NOT_AVAILABLE, 501);
  if (row.resend_enabled) {
    let from: string;
    try {
      from = mailFromFormatted(ctx, {
        resend_enabled: true,
        resend_from_address: (row.resend_from_address as string | null) ?? null,
        resend_from_name: (row.resend_from_name as string | null) ?? null,
        smtp_from_address: (row.smtp_from_address as string | null) ?? null,
        smtp_from_name: (row.smtp_from_name as string | null) ?? null,
      });
    } catch (err) {
      if (err instanceof SenderNotConfigured) throw new SettingsError(err.message);
      throw err;
    }
    const test = buildNotification(ctx, { class: "Test", input: {} });
    const request = resendRequest(String(row.resend_api_key ?? ""), { from, to: [to], subject: test.toMail!().subject, html: testEmailHtml(ctx) });
    let response: Response;
    try {
      response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
    } catch {
      throw new SettingsError("Unable to connect to Resend API. Please check your internet connection and try again.");
    }
    const body = await json(response);
    if (!response.ok || typeof body.id !== "string" || body.id === "") {
      const status = Number(body.code ?? body.statusCode ?? (response.ok ? 0 : response.status)) || 0;
      const name = typeof body.name === "string" ? body.name : null;
      const message = typeof body.message === "string" ? body.message : "Resend did not accept the email.";
      throw new SettingsError(resendErrorMessage(status, name, message));
    }
    return { message: SETTINGS_MESSAGES.testEmailSent };
  }
  if (row.smtp_enabled) throw new SettingsError(SMTP_NOT_AVAILABLE, 501);
  // No provider: EmailChannel sends nothing, and the page says it was sent.
  return { message: SETTINGS_MESSAGES.testEmailSent };
}
