// Notifications (DP-67): the six settings pages' actions with Coolify's rules and messages, "Send test" for
// every channel against a fake fetch (the exact request each one makes), the delivery service notify()
// (enabled channels and toggles, the jobs' retries, failure_count and turning a channel off), and the
// handler's routing and authorization. The payloads themselves are held to Coolify in
// notification-payloads.test.ts; the SQL behind the store in tests/db.
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { freeployContext, handleNotifications, notifyOrg, type NotificationContext, type NotificationRunner } from "@deploy-core-worker/handlers/notifications";
import type { Fetch, DeliveryRecorder } from "@deploy-core-worker/notifications/delivery";
import { enabledChannels, BACKOFF_MS } from "@deploy-core-worker/notifications/delivery";
import { buildNotification } from "@deploy-core-worker/notifications/payloads";
import { discordRequest, resendRequest, mailFromFormatted } from "@deploy-core-worker/notifications/requests";
import { testEmailHtml } from "@deploy-core-worker/notifications/payloads";
import { safeWebhookUrlMessage } from "@deploy-core-worker/notifications/safe-webhook-url";
import { SMTP_NOT_AVAILABLE, INSTANCE_EMAIL_NOT_AVAILABLE, TestEmailLimiter, resendErrorMessage } from "@deploy-core-worker/notifications/test-send";
import type { NotificationChannel, SettingsRow } from "@deploy-core-worker/notifications/settings";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy/notifications`;
const actor = { subjectId: "usr_1", subjectType: "user" };
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
// Coolify's column defaults (true for the failure events, as the migrations have them).
const ON_BY_DEFAULT = ["deployment_failure", "backup_failure", "scheduled_task_failure", "docker_cleanup_failure", "server_disk_usage", "server_unreachable", "server_patch", "traefik_outdated", "restart_limit_reached"];

function defaults(channel: NotificationChannel): SettingsRow {
  const row: SettingsRow = { id: 1, org_id: ORG_UUID, failure_count: 0 };
  for (const e of EVENTS) row[`${e}_${channel}_notifications`] = ON_BY_DEFAULT.includes(e) && !(channel === "webhook" && e === "server_patch");
  if (channel === "email") Object.assign(row, { smtp_enabled: false, resend_enabled: false, use_instance_email_settings: false, deployment_commit_details_email_notifications: false, image_vulnerabilities_email_notifications: true });
  else row[`${channel}_enabled`] = false;
  if (channel === "discord") row.discord_ping_enabled = true;
  return row;
}

/** The org's six rows in memory; save() resets failure_count as TracksDeliveryFailures does. */
class Memory implements NotificationContext {
  rows = Object.fromEntries((["email", "discord", "telegram", "slack", "pushover", "webhook"] as NotificationChannel[]).map((c) => [c, defaults(c)])) as Record<NotificationChannel, SettingsRow>;
  saves: Array<{ channel: string; changes: SettingsRow }> = [];
  store = {
    load: async (c: NotificationChannel) => ({ ...this.rows[c] }),
    save: async (c: NotificationChannel, changes: SettingsRow) => {
      this.saves.push({ channel: c, changes });
      Object.assign(this.rows[c], changes, { failure_count: 0 });
      return { ...this.rows[c] };
    },
  };
  recorder: DeliveryRecorder = {
    recordFailure: async (c) => {
      const row = this.rows[c];
      row.failure_count = Number(row.failure_count) + 1;
      return { failureCount: Number(row.failure_count), enabled: Boolean(c === "email" ? row.smtp_enabled || row.resend_enabled : row[`${c}_enabled`]) };
    },
    disable: async (c) => {
      if (c === "email") Object.assign(this.rows.email, { smtp_enabled: false, resend_enabled: false });
      else this.rows[c][`${c}_enabled`] = false;
      this.rows[c].failure_count = 0;
    },
    recordSuccess: async (c) => {
      this.rows[c].failure_count = 0;
    },
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

/** A channel's HTTP answers, in order (the last one repeats), and every request made. */
class FakeFetch {
  requests: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
  answers: Array<Response | Error> = [json({ ok: true, id: "msg_1" })];
  fetch: Fetch = async (url, init) => {
    this.requests.push({ url, ...init });
    const next = this.answers.length > 1 ? this.answers.shift()! : this.answers[0]!;
    if (next instanceof Error) throw next;
    return next.clone();
  };
}

function setup(opts: { read?: boolean; write?: boolean } = {}) {
  const env: Env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      const allow = body.action === "deploy.resource.write" ? (opts.write ?? true) : (opts.read ?? true);
      return json({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
  };
  const mem = new Memory();
  const runner: NotificationRunner = async (_env, orgId, fn) => {
    expect(orgId).toBe(ORG_UUID);
    return fn(mem);
  };
  const net = new FakeFetch();
  const limiter = new TestEmailLimiter(() => 0);
  const ctx = freeployContext(env, () => 1767225600);
  const call = async (method: string, path = "", body?: unknown, headers: Record<string, string> = {}) => {
    const segments = path.split("/").filter(Boolean);
    const init: RequestInit = { method, headers: { "content-type": "application/json", ...headers } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleNotifications(env, "req_1", actor, ORG_UUID, segments, new Request(BASE + path, init), runner, net.fetch, () => ctx, limiter);
    return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown> & { settings?: Record<string, unknown> }; error?: { message: string; details: { fields?: Record<string, string[]>; description?: string } } } };
  };
  return { env, mem, net, call, ctx, runner, limiter };
}

describe("settings: the chat channels", () => {
  it("creates nothing it does not need, and the summary says which channels are on (the layout's reminder)", async () => {
    const { call, mem } = setup();
    let r = await call("GET");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ channels: { email: false, discord: false, telegram: false, slack: false, pushover: false, webhook: false }, anyEnabled: false, canUpdate: true });
    mem.rows.webhook.webhook_enabled = true;
    r = await call("GET");
    expect(r.body.data!.anyEnabled).toBe(true);
    // The instance's email settings count as on (EmailNotificationSettings::isEnabled()).
    mem.rows.webhook.webhook_enabled = false;
    mem.rows.email.use_instance_email_settings = true;
    expect((await call("GET")).body.data!.channels).toMatchObject({ email: true });
  });

  it("shows the secrets only to who can update the settings (Hidden (only admins can view))", async () => {
    const admin = setup();
    admin.mem.rows.discord.discord_webhook_url = "https://discord.com/api/webhooks/1/FAKE";
    expect((await admin.call("GET", "/discord")).body.data!.settings!.discordWebhookUrl).toBe("https://discord.com/api/webhooks/1/FAKE");
    const member = setup({ write: false });
    member.mem.rows.discord.discord_webhook_url = "https://discord.com/api/webhooks/1/FAKE";
    member.mem.rows.telegram.telegram_token = "1:FAKE";
    member.mem.rows.telegram.telegram_notifications_backup_failure_thread_id = "9";
    const r = await member.call("GET", "/discord");
    expect(r.body.data!.canUpdate).toBe(false);
    expect(r.body.data!.settings!.discordWebhookUrl).toBeNull();
    expect(r.body.data!.settings!.deploymentFailureDiscordNotifications).toBe(true);
    const t = await member.call("GET", "/telegram");
    expect(t.body.data!.settings!.telegramToken).toBeNull();
    expect(t.body.data!.settings!.telegramNotificationsBackupFailureThreadId).toBeNull();
    // Every write is an admin's: a member's PATCH and test send answer 404.
    expect((await member.call("PATCH", "/discord", { action: "submit" })).status).toBe(404);
    expect((await member.call("POST", "/discord/test", {})).status).toBe(404);
  });

  it("instantSave{Channel}Enabled: the required field first, with Coolify's message; nothing is saved", async () => {
    const { call, mem } = setup();
    const r = await call("PATCH", "/discord", { action: "instantSaveEnabled", discordEnabled: true });
    expect(r.status).toBe(422);
    expect(r.body.error!.details.fields).toEqual({ discordWebhookUrl: ["Discord Webhook URL is required."] });
    expect(mem.rows.discord.discord_enabled).toBe(false);
    for (const [channel, body, fields] of [
      ["slack", { slackEnabled: true }, { slackWebhookUrl: ["Slack Webhook URL is required."] }],
      ["webhook", { webhookEnabled: true }, { webhookUrl: ["Webhook URL is required."] }],
      ["telegram", { telegramEnabled: true }, { telegramToken: ["Telegram Token is required."], telegramChatId: ["Telegram Chat ID is required."] }],
      ["pushover", { pushoverEnabled: true }, { pushoverUserKey: ["Pushover User Key is required."], pushoverApiToken: ["Pushover API Token is required."] }],
    ] as const) {
      const res = await call("PATCH", `/${channel}`, { action: "instantSaveEnabled", ...body });
      expect(res.body.error!.details.fields).toEqual(fields);
    }
    expect(mem.saves).toEqual([]);
  });

  it("enables a channel with its fields filled: Settings saved.", async () => {
    const { call, mem } = setup();
    const r = await call("PATCH", "/discord", { action: "instantSaveEnabled", discordEnabled: true, discordWebhookUrl: "https://discord.com/api/webhooks/1/FAKE" });
    expect(r.status).toBe(200);
    expect(r.body.data!.message).toBe("Settings saved.");
    expect(mem.rows.discord).toMatchObject({ discord_enabled: true, discord_webhook_url: "https://discord.com/api/webhooks/1/FAKE" });
    // Only the changed columns are written.
    expect(mem.saves[0]!.changes).toEqual({ discord_enabled: true, discord_webhook_url: "https://discord.com/api/webhooks/1/FAKE" });
    // toggle{Channel}Enabled turns it off again without asking for anything.
    const off = await call("PATCH", "/discord", { action: "toggleEnabled" });
    expect(off.body.data!.message).toBe("Settings saved.");
    expect(mem.rows.discord.discord_enabled).toBe(false);
  });

  it("the webhook URL rule (SafeWebhookUrl) and required_if, word for word", async () => {
    const { call } = setup();
    const fields = async (url: string, enabled = true) => (await call("PATCH", "/discord", { action: "submit", discordEnabled: enabled, discordWebhookUrl: url })).body.error?.details.fields;
    expect(await fields("")).toEqual({ discordWebhookUrl: ["The discord webhook url field is required when discord enabled is true."] });
    expect(await fields("not a url")).toEqual({ discordWebhookUrl: ["The discord webhook url must be a valid URL."] });
    expect(await fields("ftp://example.com/x")).toEqual({ discordWebhookUrl: ["The discord webhook url must use the http or https scheme."] });
    expect(await fields("http://169.254.169.254/latest")).toEqual({ discordWebhookUrl: ["The discord webhook url must not point to link-local addresses."] });
    expect(await fields("http://127.0.0.1:8080/x")).toEqual({
      discordWebhookUrl: ["The discord webhook url points to a local or private address that is not allowed. Configure allowed internal targets: https://app.freeploy.io/settings/advanced#endpoint-section"],
    });
    expect((await call("PATCH", "/webhook", { action: "submit", webhookUrl: "https://example.com./x" })).body.error!.details.fields).toEqual({ webhookUrl: ["The webhook url host must not end with a trailing dot."] });
    expect((await call("PATCH", "/slack", { action: "instantSave", slackUrl: "x", slackWebhookUrl: "http://db.internal/x" })).body.error!.details.fields!.slackWebhookUrl![0]).toMatch(/^The slack webhook url points to a local/);
    // A disabled channel may keep an empty URL.
    expect(await fields("", false)).toBeUndefined();
    expect((await call("PATCH", "/discord", { action: "submit", discordEnabled: "maybe" })).body.error!.details.fields).toEqual({ discordEnabled: ["The discord enabled field must be true or false."] });
  });

  it("toggleEvent: an event of the channel flips and saves; any other property is a 404", async () => {
    const { call, mem } = setup();
    expect((await call("PATCH", "/slack", { action: "toggleEvent", property: "deploymentSuccessSlackNotifications" })).body.data!.message).toBe("Settings saved.");
    expect(mem.rows.slack.deployment_success_slack_notifications).toBe(true);
    await call("PATCH", "/slack", { action: "toggleEvent", property: "deploymentSuccessSlackNotifications" });
    expect(mem.rows.slack.deployment_success_slack_notifications).toBe(false);
    expect((await call("PATCH", "/slack", { action: "toggleEvent", property: "slackWebhookUrl" })).status).toBe(404);
    expect((await call("PATCH", "/slack", { action: "toggleEvent", property: "deploymentSuccessDiscordNotifications" })).status).toBe(404);
    expect((await call("PATCH", "/slack", { action: "nope" })).body.error!.details.fields).toEqual({ action: ["The selected action is invalid."] });
  });

  it("Telegram's topic ids and Discord's mention", async () => {
    const { call, mem } = setup();
    const long = "x".repeat(256);
    const r = await call("PATCH", "/telegram", { action: "instantSave", telegramNotificationsRestartLimitReachedThreadId: long, telegramNotificationsBackupFailureThreadId: long });
    expect(r.body.error!.details.fields).toEqual({ telegramNotificationsRestartLimitReachedThreadId: ["The telegram notifications restart limit reached thread id field must not be greater than 255 characters."] });
    const ok = await call("PATCH", "/telegram", { action: "instantSave", telegramNotificationsBackupFailureThreadId: "42" });
    expect(ok.body.data!.message).toBeNull();
    expect(mem.rows.telegram.telegram_notifications_backup_failure_thread_id).toBe("42");
    await call("PATCH", "/discord", { action: "instantSavePingEnabled", discordPingEnabled: false });
    expect(mem.rows.discord.discord_ping_enabled).toBe(false);
    expect((await call("PATCH", "/slack", { action: "instantSavePingEnabled" })).status).toBe(404);
  });
});

describe("settings: email", () => {
  const resend = { resendApiKey: "re_FAKE", resendFromAddress: "alerts@example.com", resendFromName: "Alerts" };

  it("selecting a provider that is not complete saves nothing and shows no error (Not active yet)", async () => {
    const { call, mem } = setup();
    const r = await call("PATCH", "/email", { action: "selectEmailProvider", emailProvider: "resend" });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ saved: false, message: null, activeEmailProvider: "none" });
    expect(mem.saves).toEqual([]);
    const done = await call("PATCH", "/email", { action: "selectEmailProvider", emailProvider: "resend", ...resend });
    expect(done.body.data).toMatchObject({ saved: true, message: "Email notifications settings updated.", activeEmailProvider: "resend" });
    expect(mem.rows.email).toMatchObject({ resend_enabled: true, smtp_enabled: false, resend_api_key: "re_FAKE" });
  });

  it("submit with Resend or SMTP: their rules and messages", async () => {
    const { call } = setup();
    expect((await call("PATCH", "/email", { action: "submit", emailProvider: "resend" })).body.error!.details.fields).toEqual({
      resendApiKey: ["Resend API Key is required."],
      resendFromAddress: ["From Address is required."],
      resendFromName: ["From Name is required."],
    });
    expect((await call("PATCH", "/email", { action: "submit", emailProvider: "resend", ...resend, resendFromAddress: "nope" })).body.error!.details.fields).toEqual({
      resendFromAddress: ["Please enter a valid email address."],
    });
    expect((await call("PATCH", "/email", { action: "submit", emailProvider: "smtp" })).body.error!.details.fields).toEqual({
      smtpFromAddress: ["From Address is required."],
      smtpFromName: ["From Name is required."],
      smtpHost: ["SMTP Host is required."],
      smtpPort: ["SMTP Port is required."],
      smtpEncryption: ["Encryption type is required."],
    });
    const smtp = { smtpFromAddress: "a@example.com", smtpFromName: "A", smtpHost: "smtp.gmail.com", smtpPort: "587", smtpEncryption: "starttls" };
    expect((await call("PATCH", "/email", { action: "submit", emailProvider: "smtp", ...smtp })).body.error!.details.fields).toEqual({
      smtpUsername: ["This provider needs a username."],
      smtpPassword: ["This provider needs a password."],
    });
    expect((await call("PATCH", "/email", { action: "submit", emailProvider: "smtp", ...smtp, smtpHost: "mail.example.com", smtpUsername: "u" })).body.error!.details.fields).toEqual({
      smtpPassword: ["Enter the password for this username."],
    });
    expect((await call("PATCH", "/email", { action: "submit", emailProvider: "smtp", ...smtp, smtpHost: "mail.example.com", smtpPort: "x" })).body.error!.details.fields).toEqual({
      smtpPort: ["SMTP Port must be a number."],
    });
    expect((await call("PATCH", "/email", { action: "submit", emailProvider: "smtp", ...smtp, smtpHost: "mail.example.com", smtpEhloDomain: "bad host" })).body.error!.details.fields).toEqual({
      smtpEhloDomain: ["The smtp ehlo domain contains invalid characters. Only letters (a-z, A-Z), numbers (0-9), hyphens (-), and dots (.) are allowed."],
    });
  });

  it("SMTP settings are stored (the port as a number); instantSave without a provider turns both off", async () => {
    const { call, mem } = setup();
    const smtp = { smtpFromAddress: "a@example.com", smtpFromName: "A", smtpHost: "mail.example.com", smtpPort: "2525", smtpEncryption: "tls" };
    const r = await call("PATCH", "/email", { action: "submit", emailProvider: "smtp", ...smtp });
    expect(r.body.data).toMatchObject({ message: "Email notifications settings updated.", activeEmailProvider: "smtp" });
    expect(mem.rows.email).toMatchObject({ smtp_enabled: true, smtp_port: 2525, smtp_host: "mail.example.com" });
    expect((r.body.data!.settings as Record<string, unknown>).smtpPort).toBe("2525");
    await call("PATCH", "/email", { action: "instantSave", useInstanceEmailSettings: true });
    expect(mem.rows.email).toMatchObject({ smtp_enabled: false, resend_enabled: false, use_instance_email_settings: true });
    const commit = await call("PATCH", "/email", { action: "instantSaveDeploymentCommitDetails", deploymentCommitDetailsEmailNotifications: true });
    expect(commit.body.data!.message).toBe("Email notifications settings updated.");
    expect((await call("PATCH", "/email", { action: "toggleEvent", property: "serverPatchEmailNotifications" })).status).toBe(200);
    expect(mem.rows.email.server_patch_email_notifications).toBe(false);
  });

  it("the page: the provider in use, the test button's reason, the secrets for admins only", async () => {
    const { call, mem } = setup();
    let r = await call("GET", "/email", undefined, { "x-actor-email": "me@example.com" });
    expect(r.body.data).toMatchObject({ activeEmailProvider: "none", sendTestReason: "Save an email provider first.", testEmailAddress: "me@example.com" });
    Object.assign(mem.rows.email, { resend_enabled: true, resend_api_key: "re_FAKE", smtp_password: "pw" });
    r = await call("GET", "/email");
    expect(r.body.data).toMatchObject({ activeEmailProvider: "resend", sendTestReason: null });
    const member = setup({ write: false });
    Object.assign(member.mem.rows.email, { resend_enabled: true, resend_api_key: "re_FAKE", smtp_password: "pw" });
    const m = await member.call("GET", "/email");
    expect(m.body.data).toMatchObject({ sendTestReason: "Only admins can send a test email." });
    expect(m.body.data!.settings).toMatchObject({ resendApiKey: null, smtpPassword: null });
  });
});

describe("Send test", () => {
  it("Discord: the Test notification's request to the webhook, and Coolify's answer", async () => {
    const { call, mem, net, ctx } = setup();
    Object.assign(mem.rows.discord, { discord_enabled: true, discord_webhook_url: "https://discord.com/api/webhooks/1/FAKE" });
    const r = await call("POST", "/discord/test", {});
    expect(r.body.data).toEqual({ message: "Test notification sent.", delivery: { channel: "discord", status: "delivered", httpStatus: 200 } });
    const expected = discordRequest(ctx, buildNotification(ctx, { class: "Test", input: { ping: false } }).toDiscord(), "https://discord.com/api/webhooks/1/FAKE");
    expect(net.requests).toEqual([expected]);
    expect(JSON.parse(net.requests[0]!.body).embeds[0].footer).toEqual({ text: "Freeploy" });
    expect(net.requests[0]!.body).toContain("This is a test Discord notification from Freeploy.");
    // A rejected test still says it was sent (Coolify queues it), and is never counted.
    net.answers = [json({ message: "Unknown Webhook" }, 404)];
    const rejected = await call("POST", "/discord/test", {});
    expect(rejected.body.data).toEqual({
      message: "Test notification sent.",
      delivery: { channel: "discord", status: "rejected", reason: "Discord returned HTTP 404 (Not Found).", httpStatus: 404, counted: false, turnedOff: false },
    });
    expect(mem.rows.discord.failure_count).toBe(0);
  });

  it("Slack, Mattermost, Pushover and webhook: their requests", async () => {
    const { call, mem, net } = setup();
    Object.assign(mem.rows.slack, { slack_enabled: true, slack_webhook_url: "https://hooks.slack.com/services/T/B/FAKE" });
    await call("POST", "/slack/test", {});
    expect(JSON.parse(net.requests[0]!.body)).toEqual({
      text: "Test Slack Notification",
      blocks: [{ type: "section", text: { type: "plain_text", text: "Freeploy Notification" } }],
      attachments: [{ color: "#0099ff", blocks: [{ type: "header", text: { type: "plain_text", text: "Test Slack Notification" } }, { type: "section", text: { type: "mrkdwn", text: "This is a test Slack notification from Freeploy." } }] }],
    });
    mem.rows.slack.slack_webhook_url = "https://chat.example.com/hooks/FAKE";
    await call("POST", "/slack/test", {});
    expect(JSON.parse(net.requests[1]!.body)).toEqual({ username: "Freeploy", attachments: [{ title: "Test Slack Notification", color: "#0099ff", text: "This is a test Slack notification from Freeploy.", footer: "Freeploy" }] });
    Object.assign(mem.rows.pushover, { pushover_enabled: true, pushover_user_key: "FAKE-USER", pushover_api_token: "FAKE-TOKEN" });
    await call("POST", "/pushover/test", {});
    expect(net.requests[2]).toMatchObject({ url: "https://api.pushover.net/1/messages.json", method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "GuzzleHttp/7" } });
    expect(net.requests[2]!.body).toBe(
      '{"token":"FAKE-TOKEN","user":"FAKE-USER","title":"\\u2139\\ufe0f Test Pushover Notification","message":"This is a test Pushover notification from Freeploy.&nbsp;<a href=\'https:\\/\\/app.freeploy.io\'>Go to your dashboard<\\/a>","html":1}',
    );
    Object.assign(mem.rows.webhook, { webhook_enabled: true, webhook_url: "https://hooks.example.com/x?token=FAKE" });
    await call("POST", "/webhook/test", {});
    expect(net.requests[3]!.body).toBe('{"success":true,"message":"This is a test webhook notification from Freeploy.","event":"test","url":"https:\\/\\/app.freeploy.io"}');
    // A channel that is off sends nothing (the channel class returns), and a private URL is blocked by the job.
    mem.rows.webhook.webhook_enabled = false;
    expect((await call("POST", "/webhook/test", {})).body.data!.delivery).toEqual({ channel: "webhook", status: "skipped", reason: "Webhook is not enabled or has no URL." });
    Object.assign(mem.rows.webhook, { webhook_enabled: true, webhook_url: "http://10.0.0.5/hook" });
    expect(((await call("POST", "/webhook/test", {})).body.data!.delivery as { status: string }).status).toBe("skipped");
    expect(net.requests).toHaveLength(4);
  });

  it("Telegram: sent at once, Telegram's error shown, the links in the text when a button URL is refused", async () => {
    const { call, mem, net } = setup();
    Object.assign(mem.rows.telegram, { telegram_token: " 1:FAKE ", telegram_chat_id: "-100", telegram_notifications_deployment_success_thread_id: "7" });
    let r = await call("POST", "/telegram/test", {});
    expect(r.body.data!.message).toBe("Test notification sent.");
    expect(net.requests[0]!.url).toBe("https://api.telegram.org/bot1:FAKE/sendMessage");
    expect(net.requests[0]!.body).toBe(
      '{"chat_id":"-100","text":"Freeploy: This is a test Telegram notification from Freeploy.","reply_markup":"{\\"inline_keyboard\\":[[{\\"text\\":\\"Go to your dashboard\\",\\"url\\":\\"https:\\\\\\/\\\\\\/app.freeploy.io\\"}]]}"}',
    );
    net.answers = [json({ ok: false, description: "Unauthorized" }, 401)];
    r = await call("POST", "/telegram/test", {});
    expect(r.status).toBe(422);
    expect(r.body.error!.message).toBe("Telegram rejected the test notification.");
    expect(r.body.error!.details.description).toBe("The Bot API token is not valid. Copy it again from @BotFather.");
    net.answers = [json({ ok: false, description: "Bad Request: chat not found" }, 400)];
    expect((await call("POST", "/telegram/test", {})).body.error!.details.description).toBe("Bad Request: chat not found");
    net.requests = [];
    net.answers = [json({ ok: false, description: "Bad Request: BUTTON_URL_INVALID" }, 400), json({ ok: true })];
    expect((await call("POST", "/telegram/test", {})).body.data!.message).toBe("Test notification sent.");
    expect(net.requests).toHaveLength(2);
    expect(JSON.parse(net.requests[1]!.body)).toEqual({ chat_id: "-100", text: "Freeploy: This is a test Telegram notification from Freeploy.\n\nGo to your dashboard: https://app.freeploy.io" });
  });

  it("email: Resend over fetch exactly as Coolify's Resend transport, its error messages, the rate limit", async () => {
    const { call, mem, net, ctx, limiter } = setup();
    Object.assign(mem.rows.email, { resend_enabled: true, resend_api_key: "re_FAKE", resend_from_address: "alerts@example.com", resend_from_name: "Fixture Team" });
    net.answers = [json({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" })];
    expect((await call("POST", "/email/test", {})).body.error!.details.fields).toEqual({ testEmailAddress: ["Test email address is required."] });
    expect((await call("POST", "/email/test", { testEmailAddress: "nope" })).body.error!.details.fields).toEqual({ testEmailAddress: ["Please enter a valid email address."] });
    const r = await call("POST", "/email/test", { testEmailAddress: "me@example.com" });
    expect(r.body.data).toEqual({ message: "Test Email sent." });
    const from = mailFromFormatted(ctx, { resend_enabled: true, resend_from_address: "alerts@example.com", resend_from_name: "Fixture Team", smtp_from_address: null, smtp_from_name: null });
    expect(from).toBe('"Fixture Team" <alerts@example.com>');
    expect(net.requests).toEqual([resendRequest("re_FAKE", { from, to: ["me@example.com"], subject: "Freeploy: Test Email", html: testEmailHtml(ctx) })]);
    expect(net.requests[0]).toMatchObject({ url: "https://api.resend.com/emails", headers: { Authorization: "Bearer re_FAKE", "User-Agent": "resend-php/1.18.0", "Content-Type": "application/json" } });
    // One test email per 10 seconds.
    expect((await call("POST", "/email/test", { testEmailAddress: "me@example.com" })).body.error!.message).toBe("Too many messages sent!");
    // Resend's errors (EmailChannel's mapping); a fresh limiter each time.
    const send = async (answer: Response) => {
      (limiter as unknown as { until: Map<string, number> }).until.clear();
      net.answers = [answer];
      return (await call("POST", "/email/test", { testEmailAddress: "me@example.com" })).body.error!.message;
    };
    expect(await send(json({ statusCode: 401, name: "validation_error", message: "API key is invalid" }, 401))).toBe("Invalid Resend API key. Please verify your API key in the Resend dashboard and update it in settings.");
    expect(await send(json({ statusCode: 403, name: "validation_error", message: "The example.com domain is not verified." }, 403))).toBe("Email validation failed: The example.com domain is not verified.");
    expect(await send(json({ statusCode: 401, name: "restricted_api_key", message: "x" }, 401))).toBe("Your Resend API key has restricted permissions. Please use an API key with Full Access permissions.");
    expect(await send(json({ statusCode: 429, name: "rate_limit_exceeded", message: "x" }, 429))).toBe("Resend rate limit exceeded. Please try again in a few minutes.");
    expect(await send(json({ statusCode: 500, name: "application_error", message: "Internal" }, 500))).toBe("Failed to send email via Resend: Internal");
    (limiter as unknown as { until: Map<string, number> }).until.clear();
    net.answers = [new Error("connect ECONNREFUSED")];
    expect((await call("POST", "/email/test", { testEmailAddress: "me@example.com" })).body.error!.message).toBe("Unable to connect to Resend API. Please check your internet connection and try again.");
  });

  it("email: SMTP and the hosted email service answer that they are not available yet, and why", async () => {
    const { call, mem, limiter } = setup();
    Object.assign(mem.rows.email, { smtp_enabled: true, smtp_host: "mail.example.com" });
    let r = await call("POST", "/email/test", { testEmailAddress: "me@example.com" });
    expect(r.status).toBe(501);
    expect(r.body.error!.message).toBe(SMTP_NOT_AVAILABLE);
    expect(SMTP_NOT_AVAILABLE).toContain("connect() TCP sockets with STARTTLS");
    expect(SMTP_NOT_AVAILABLE).toContain("Email Workers");
    (limiter as unknown as { until: Map<string, number> }).until.clear();
    Object.assign(mem.rows.email, { smtp_enabled: false, use_instance_email_settings: true });
    r = await call("POST", "/email/test", { testEmailAddress: "me@example.com" });
    expect(r.status).toBe(501);
    expect(r.body.error!.message).toBe(INSTANCE_EMAIL_NOT_AVAILABLE);
    expect(resendErrorMessage(422, null, "Invalid `to` field.")).toBe("Email validation failed: Invalid `to` field.");
  });
});

describe("notify(): the org's channels, the jobs' retries and failure counting", () => {
  function on(mem: Memory) {
    Object.assign(mem.rows.discord, { discord_enabled: true, discord_webhook_url: "https://discord.com/api/webhooks/1/FAKE" });
    Object.assign(mem.rows.slack, { slack_enabled: true, slack_webhook_url: "https://hooks.slack.com/services/T/B/FAKE" });
    Object.assign(mem.rows.pushover, { pushover_enabled: true, pushover_user_key: "U", pushover_api_token: "T" });
    Object.assign(mem.rows.email, { resend_enabled: true });
  }
  const failed = (ctx: ReturnType<typeof setup>["ctx"]) =>
    buildNotification(ctx, { class: "DockerCleanupFailed", input: { server: { uuid: "srv1", name: "s" }, message: "boom" } });

  it("sends to the channels whose event toggle is on; general never goes by email; some events always go", async () => {
    const mem = new Memory();
    on(mem);
    mem.rows.slack.docker_cleanup_failure_slack_notifications = false;
    expect(enabledChannels(mem.rows, "docker_cleanup_failure")).toEqual(["email", "discord", "pushover"]);
    expect(enabledChannels(mem.rows, "deployment_success")).toEqual([]);
    expect(enabledChannels(mem.rows, "general")).toEqual(["discord", "slack", "pushover"]);
    expect(enabledChannels(mem.rows, "api_token_expiring")).toEqual(["email", "discord", "slack", "pushover"]);
  });

  it("retries 429 and 5xx (10 s apart, 5 tries), resets failure_count on a success, skips email", async () => {
    const { env, mem, net, runner } = setup();
    on(mem);
    mem.rows.discord.failure_count = 2;
    const sleeps: number[] = [];
    net.answers = [json({}, 503), json({}, 429), json({ ok: true })];
    const outcomes = await notifyOrg(env, ORG_UUID, failed(freeployContext(env)), runner, net.fetch, async (ms) => {
      sleeps.push(ms);
    });
    expect(outcomes.map((o) => [o.channel, o.status])).toEqual([
      ["email", "skipped"],
      ["discord", "delivered"],
      ["slack", "delivered"],
      ["pushover", "delivered"],
    ]);
    expect(sleeps).toEqual([BACKOFF_MS, BACKOFF_MS]);
    expect(mem.rows.discord.failure_count).toBe(0);
    net.answers = [new Error("network down")];
    const down = await notifyOrg(env, ORG_UUID, failed(freeployContext(env)), runner, net.fetch, async () => undefined);
    expect(down[1]).toEqual({ channel: "discord", status: "failed", reason: "Discord notification request to https://discord.com failed (ConnectionException)." });
  });

  it("a configuration error counts; after 3 in a row the channel is turned off and the other channels are told", async () => {
    const { env, mem, net, runner } = setup();
    on(mem);
    // Discord answers 404 (a deleted webhook), the others accept.
    const fetch: Fetch = async (url, init) => {
      net.requests.push({ url, ...init });
      return url.startsWith("https://discord.com") ? json({ message: "Unknown Webhook" }, 404) : json({ ok: true });
    };
    for (let i = 1; i <= 2; i++) {
      const o = await notifyOrg(env, ORG_UUID, failed(freeployContext(env)), runner, fetch, async () => undefined);
      expect(o[1]).toMatchObject({ channel: "discord", status: "rejected", counted: true, turnedOff: false });
      expect(mem.rows.discord.failure_count).toBe(i);
    }
    net.requests = [];
    const third = await notifyOrg(env, ORG_UUID, failed(freeployContext(env)), runner, fetch, async () => undefined);
    expect(third[1]).toMatchObject({ status: "rejected", reason: "Discord returned HTTP 404 (Not Found).", turnedOff: true });
    expect(mem.rows.discord.discord_enabled).toBe(false);
    // The GeneralNotification to Slack and Pushover (not email, not Discord).
    const told = net.requests.slice(-2);
    expect(told.map((r) => r.url)).toEqual(["https://hooks.slack.com/services/T/B/FAKE", "https://api.pushover.net/1/messages.json"]);
    expect(JSON.parse(told[0]!.body).text).toBe("Freeploy: Action required");
    expect(JSON.parse(told[0]!.body).attachments[0].blocks[1].text.text).toBe(
      "Discord notifications were disabled after 3 failed deliveries in a row.\nReason: Discord returned HTTP 404 (Not Found).\nPlease fix the settings and enable Discord notifications again: https://app.freeploy.io/notifications/discord",
    );
  });

  it("Pushover's invalid token counts; another 4xx is only logged", async () => {
    const { env, mem, runner } = setup();
    Object.assign(mem.rows.pushover, { pushover_enabled: true, pushover_user_key: "U", pushover_api_token: "T" });
    const answer = (body: unknown, status: number): Fetch => async () => json(body, status);
    let o = await notifyOrg(env, ORG_UUID, failed(freeployContext(env)), runner, answer({ token: "invalid", errors: ["application token is invalid"] }, 400), async () => undefined);
    expect(o[0]).toMatchObject({ channel: "pushover", status: "rejected", reason: "Pushover returned HTTP 400 (Bad Request).", counted: true });
    o = await notifyOrg(env, ORG_UUID, failed(freeployContext(env)), runner, answer({ message: "too long" }, 400), async () => undefined);
    expect(o[0]).toMatchObject({ counted: false });
    expect(mem.rows.pushover.failure_count).toBe(1);
  });
});

describe("SafeWebhookUrl without DNS", () => {
  const msg = (u: string) => safeWebhookUrlMessage("webhook url", u, "https://app.freeploy.io/settings/advanced#endpoint-section");
  it("accepts public hosts and addresses, refuses the private, reserved and link-local ones", () => {
    for (const ok of ["https://discord.com/api/webhooks/1/x", "http://93.184.216.34/x", "https://[2606:4700::1111]/x", "https://example.com:8443/x?y=1"]) expect(msg(ok)).toBeNull();
    for (const bad of ["http://10.1.2.3/", "http://192.168.1.1/", "http://172.16.0.1/", "http://100.64.0.1/", "http://[::1]/", "http://[fd00::1]/", "http://[::ffff:127.0.0.1]/", "http://localhost/", "http://x.local/", "http://k8s.cluster.local/"]) {
      expect(msg(bad)).toMatch(/points to a local or private address/);
    }
    expect(msg("http://[fe80::1]/")).toBe("The webhook url must not point to link-local addresses.");
    expect(msg("https://exa mple.com/")).toBe("The webhook url must be a valid URL.");
  });
});

describe("routing", () => {
  const env: Env = { ENVIRONMENT: "test" };
  const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
  it("401s without an actor, 404s an unknown channel or page, 405s other methods", async () => {
    expect((await route(new Request(BASE), env)).status).toBe(401);
    expect((await route(new Request(`${BASE}/discord`, { headers }), env)).status).toBe(503);
    expect((await route(new Request(`${BASE}/teams`, { headers }), env)).status).toBe(404);
    expect((await route(new Request(`${BASE}/discord/nope`, { method: "POST", headers }), env)).status).toBe(404);
    expect((await route(new Request(`${BASE}/discord/test/x`, { headers }), env)).status).toBe(404);
    expect((await route(new Request(BASE, { method: "POST", headers }), env)).status).toBe(405);
    expect((await route(new Request(`${BASE}/discord`, { method: "DELETE", headers }), env)).status).toBe(405);
    expect((await route(new Request(`${BASE}/discord/test`, { headers }), env)).status).toBe(405);
  });
});
