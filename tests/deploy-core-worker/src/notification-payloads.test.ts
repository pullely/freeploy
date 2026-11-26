// Notification payloads (DP-67). fixtures/notifications/goldens.json is what coollabsio/coolify@91b7e3e's own
// notification classes, channels and jobs answer for fixtures/notifications/cases.json (emit.php, see the
// README there). Every case must come out of the TypeScript port byte for byte, for every channel:
//   - the email's subject and view (and the test email's rendered body),
//   - Discord's embed, Telegram's text and buttons, Slack's message, Pushover's fields, the webhook's JSON,
//     each as json_encode() writes it;
//   - the HTTP request each job sends (URL, method, headers, body), Telegram's thread and its second request
//     without buttons, and the Resend request of the test email.
// The context is Coolify's (brand "Coolify", the version in Discord's footer); Freeploy passes its own.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildNotification, NOTIFICATION_CLASSES, testEmailHtml, type NotificationInput } from "@deploy-core-worker/notifications/payloads";
import type { PayloadContext } from "@deploy-core-worker/notifications/messages";
import { phpJsonEncode, type PhpValue } from "@deploy-core-worker/notifications/php";
import { channelRequest, type SettingsRow } from "@deploy-core-worker/notifications/delivery";
import { mailFromFormatted, resendRequest, telegramButtonFallback, type ChannelRequest } from "@deploy-core-worker/notifications/requests";

const dir = join(process.cwd(), "fixtures", "notifications");
interface Case {
  id: string;
  class: string;
  input: Record<string, unknown>;
}
interface Sent {
  thread?: string | null;
  requests: ChannelRequest[];
}
interface Golden {
  mail?: { subject: string; view: string; html?: string };
  discord: string;
  telegram: string;
  slack: string;
  pushover: string;
  webhook: string;
  send: Record<string, Sent>;
}
const cases = (JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")) as { cases: Case[] }).cases;
const goldens = JSON.parse(readFileSync(join(dir, "goldens.json"), "utf8")) as Record<string, { ok: boolean; value: Golden; error?: string }>;

const ctx: PayloadContext = {
  baseUrl: "https://coolify.example.com",
  appUrl: "https://app.example.com",
  brand: "Coolify",
  appName: "Coolify",
  discordFooter: "Coolify v4.7.6",
  subscriptionUrl: "https://app.coolify.io/subscription",
  now: () => 1767225600,
};

// emit.php's team: every channel on, a thread id for every Telegram event.
const EVENTS = [
  "deployment_success",
  "deployment_failure",
  "status_change",
  "restart_limit_reached",
  "backup_success",
  "backup_failure",
  "scheduled_task_success",
  "scheduled_task_failure",
  "docker_cleanup_success",
  "docker_cleanup_failure",
  "server_disk_usage",
  "server_reachable",
  "server_unreachable",
  "server_patch",
  "traefik_outdated",
  "image_vulnerabilities",
];
const settings: Record<string, SettingsRow> = {
  discord: { discord_enabled: true, discord_webhook_url: "https://discord.com/api/webhooks/123456789/FAKE-DISCORD-TOKEN", discord_ping_enabled: true },
  slack: { slack_enabled: true, slack_webhook_url: "https://hooks.slack.com/services/T00000000/B00000000/FAKE-SLACK-TOKEN" },
  mattermost: { slack_enabled: true, slack_webhook_url: "https://mattermost.example.com/hooks/FAKE-MATTERMOST-KEY" },
  telegram: {
    telegram_enabled: true,
    telegram_token: "123456:FAKE-TELEGRAM-TOKEN",
    telegram_chat_id: "-1001234567890",
    ...Object.fromEntries(EVENTS.map((e) => [`telegram_notifications_${e}_thread_id`, `thread-${e}`])),
  },
  pushover: { pushover_enabled: true, pushover_user_key: "FAKE-PUSHOVER-USER-KEY", pushover_api_token: "FAKE-PUSHOVER-API-TOKEN" },
  webhook: { webhook_enabled: true, webhook_url: "https://hooks.example.com/coolify?token=FAKE-WEBHOOK-TOKEN" },
};

function sendFor(n: ReturnType<typeof buildNotification>, channel: string): Sent {
  const c = channel === "mattermost" ? "slack" : channel;
  const built = channelRequest(ctx, c as "discord", n, settings[channel]!);
  if ("skip" in built) return { requests: [] };
  return { ...(c === "telegram" ? { thread: built.telegram!.threadId } : {}), requests: [built.request] };
}

const mismatches: string[] = [];
function expectSame(where: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) mismatches.push(`${where}\n  port:   ${a.slice(0, 2000)}\n  coolify: ${b.slice(0, 2000)}`);
}

describe("notification payloads against Coolify's PHP", () => {
  test("every golden was emitted without an error", () => {
    expect(Object.entries(goldens).filter(([, g]) => !g.ok)).toEqual([]);
    expect(Object.keys(goldens).length).toBe(cases.length + 1);
  });

  test("every class of app/Notifications has at least one case", () => {
    const covered = new Set(cases.map((c) => c.class));
    expect(NOTIFICATION_CLASSES.filter((c) => !covered.has(c))).toEqual([]);
  });

  test.each(cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const golden = goldens[c.id]!.value;
    const n = buildNotification(ctx, { class: c.class, input: c.input } as NotificationInput);
    const before = mismatches.length;
    if (golden.mail) {
      expect(n.toMail).not.toBeNull();
      const mail = n.toMail!();
      expectSame(`${c.id} mail`, { subject: mail.subject, view: mail.view }, { subject: golden.mail.subject, view: golden.mail.view });
      if (golden.mail.html !== undefined) expectSame(`${c.id} mail html`, testEmailHtml(ctx), golden.mail.html);
    } else {
      expect(n.toMail).toBeNull();
    }
    expectSame(`${c.id} discord`, phpJsonEncode(n.toDiscord().toPayload(ctx)), golden.discord);
    expectSame(`${c.id} telegram`, phpJsonEncode(n.toTelegram() as unknown as PhpValue), golden.telegram);
    const slack = n.toSlack();
    expectSame(`${c.id} slack`, phpJsonEncode({ title: slack.title, description: slack.description, color: slack.color }), golden.slack);
    expectSame(`${c.id} pushover`, phpJsonEncode(n.toPushover().toPayload(ctx, "FAKE-PUSHOVER-API-TOKEN", "FAKE-PUSHOVER-USER-KEY")), golden.pushover);
    expectSame(`${c.id} webhook`, phpJsonEncode(n.toWebhook() as PhpValue), golden.webhook);
    for (const channel of ["discord", "telegram", "slack", "mattermost", "pushover", "webhook"]) {
      expectSame(`${c.id} request ${channel}`, sendFor(n, channel), golden.send[channel]);
    }
    if (golden.send.telegram_button_fallback) {
      const built = channelRequest(ctx, "telegram", n, settings.telegram!);
      if ("skip" in built) throw new Error("telegram skipped");
      const fallback = telegramButtonFallback(ctx, built.telegram!, 400, "Bad Request: BUTTON_URL_INVALID button url is invalid");
      expectSame(`${c.id} telegram fallback`, { thread: built.telegram!.threadId, requests: [built.request, fallback] }, golden.send.telegram_button_fallback);
    }
    expect(mismatches.slice(before)).toEqual([]);
  });

  test("the test email through Resend: the sender and the request", () => {
    const resend = goldens["@resend"]!.value as unknown as Record<string, { from: string; method: string; path: string; headers: Record<string, string>; body: string }>;
    const senders: Record<string, Record<string, string | null>> = {
      named: { resend_from_name: "Fixture Team", resend_from_address: "alerts@example.com" },
      quoted: { resend_from_name: 'Fixture, "Ops" Team', resend_from_address: "alerts@example.com" },
      unicode: { resend_from_name: "Équipe 🚀", resend_from_address: "alerts@example.com" },
      "smtp-fallback": { resend_from_name: "", resend_from_address: null, smtp_from_name: "SMTP Sender", smtp_from_address: "smtp@example.com" },
      "no-name": { resend_from_name: null, resend_from_address: "alerts@example.com" },
    };
    expect(Object.keys(resend).sort()).toEqual(Object.keys(senders).sort());
    for (const [id, s] of Object.entries(senders)) {
      const from = mailFromFormatted(ctx, {
        resend_enabled: true,
        resend_from_address: s.resend_from_address ?? null,
        resend_from_name: s.resend_from_name ?? null,
        smtp_from_address: s.smtp_from_address ?? null,
        smtp_from_name: s.smtp_from_name ?? null,
      });
      const r = resendRequest("re_FAKE_RESEND_KEY", { from, to: ["someone@example.com"], subject: "Coolify: Test Email", html: testEmailHtml(ctx) });
      const g = resend[id]!;
      expect(from).toBe(g.from);
      expect(r.method).toBe(g.method);
      expect(new URL(r.url).pathname).toBe(g.path);
      expect(r.headers).toEqual(g.headers);
      expect(r.body).toBe(g.body);
    }
  });

  afterAll(() => {
    // The list of every mismatch with the channel and both values (empty when the port is byte-equal).
    if (mismatches.length) console.error(mismatches.join("\n\n"));
  });
});
