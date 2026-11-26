// The platform operator's Updates, Backup, Email and Authentication settings (freeploy-coolify-parity DP12, DP-101):
// Coolify's Settings\Updates, SettingsBackup, SettingsEmail and SettingsOauth as /v1/platform/settings/* in
// deploy-core-worker, over Freeploy's database (PGlite with every deploy migration, row-level security on) and the
// real decision (policy-worker's own router with one PLATFORM_OPERATORS). Coolify's rules, messages and toasts;
// what is stored, encrypted; what runs on a server, sends email or upgrades the instance answered with 501 and
// nothing stored; a customer of any role, an API key and no actor reaching nothing; no org seeing the rows.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { route } from "@deploy-core-worker/router";
import { PGlite } from "@electric-sql/pglite";
import { manifest } from "@saas/db";
import type { SqlExecutor, TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { asPlatformAdmin, withOrg, PLATFORM_SETTINGS_ORG_ID } from "@saas/db/deploy";
import type { Env } from "@deploy-core-worker/env";
import { handlePlatform, type PlatformRunner } from "@deploy-core-worker/handlers/platform";
import { sqlPlatformMoreStore, type PlatformMoreRunner } from "@deploy-core-worker/handlers/platform-settings-more";
import { emailSettingsView } from "@deploy-core-worker/platform/email";
import { couldBeEnabled, oauthView, providerLabel, scopeList, type OauthRow } from "@deploy-core-worker/platform/oauth";
import { switchUpdateChannel } from "@deploy-core-worker/platform/updates";
import { route as policyRoute } from "@policy-worker/router";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TEST_KEK = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
const OPERATOR = "usr_" + "a".repeat(32);
const CUSTOMER = "usr_" + "b".repeat(32);
const ORG = "00000000-0000-4000-8000-00000000000a";
const SSH = (what: string) => `${what} needs the SSH executor, which is not available yet.`;
const HOSTED_EMAIL = "The hosted email service is not available yet: Freeploy has no sending domain. Use the team email settings with Resend.";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

const wrap = (pg: PGlite): SqlExecutor => ({
  async execute(text, params) {
    const r = await pg.query(text, params ?? []);
    return { rows: r.rows as never[], rowCount: r.affectedRows ?? r.rows.length };
  },
});
const committing = (pg: PGlite): TransactionalSqlExecutor => ({ ...wrap(pg), transaction: (fn) => pg.transaction((tx) => fn(wrap(tx as never))) });

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  for (const m of manifest.migrations.filter((x) => x.context === "deploy")) await pg.exec(readFileSync(resolve(REPO_ROOT, "packages/db/src/migrations", m.path), "utf8"));
}, 120_000);
afterAll(async () => pg?.close());

/** A clean platform before each test: no row 0, no providers, no platform data key. */
beforeEach(async () => {
  await pg.exec(`DELETE FROM deploy.instance_settings; DELETE FROM deploy.oauth_settings; DELETE FROM deploy.org_keys`);
});

type Body = { data?: Record<string, unknown>; error?: { code: string; message: string; details?: { fields?: Record<string, string[]> } } };

function setup(role = "owner") {
  const opened: string[] = [];
  const env: Env = {
    ENVIRONMENT: "test",
    DEPLOY_ENCRYPTION_KEY: TEST_KEK,
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    POLICY_WORKER: fetcher((req) => policyRoute(req, { ENVIRONMENT: "test", PLATFORM_OPERATORS: OPERATOR })),
    MEMBERSHIP_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { orgId: string };
      return json({ data: { memberships: [{ kind: "role_assignment", role, scope: { kind: "organization", orgId: body.orgId } }] } });
    }),
  };
  const runner: PlatformRunner = async () => {
    opened.push("settings");
    throw new Error("DP-79's store is not used by these pages");
  };
  const moreRunner: PlatformMoreRunner = async (_env, fn) => {
    opened.push("more");
    return asPlatformAdmin(committing(pg), (tx) => fn(sqlPlatformMoreStore(tx, TEST_KEK)));
  };
  const call = async (actor: { subjectId: string; subjectType: string } | null, method: string, path: string, body?: unknown) => {
    const url = `https://deploy-core.internal/v1/platform${path}`;
    const headers: Record<string, string> = { "x-actor-email": "operator@example.com" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const req = new Request(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const res = await handlePlatform(env, "req_1", actor, new URL(url).pathname.slice("/v1/platform".length), req, runner, moreRunner);
    return { status: res.status, body: (await res.json()) as Body };
  };
  return { env, opened, call };
}

const user = (id: string) => ({ subjectId: id, subjectType: "user" });
const op = user(OPERATOR);
const row0 = async () => (await pg.query<Record<string, unknown>>("SELECT * FROM deploy.instance_settings WHERE id = 0")).rows[0];
const oauthRows = async () => (await pg.query<Record<string, unknown>>("SELECT * FROM deploy.oauth_settings ORDER BY provider")).rows;

/** Every DP-101 route, as the pages call them. */
const ROUTES: Array<[string, string, unknown?]> = [
  ["GET", "/settings/updates"],
  ["PATCH", "/settings/updates", { action: "instantSave", is_auto_update_enabled: false }],
  ["PATCH", "/settings/updates", { action: "upgrade" }],
  ["GET", "/settings/backup"],
  ["PATCH", "/settings/backup", { action: "addCoolifyDatabase" }],
  ["GET", "/settings/email"],
  ["PATCH", "/settings/email", { action: "submit", emailProvider: "none" }],
  ["PATCH", "/settings/email", { action: "sendTestEmail", testEmailAddress: "a@example.com" }],
  ["GET", "/settings/oauth"],
  ["GET", "/settings/oauth/github"],
  ["PATCH", "/settings/oauth/github", { action: "toggleProvider", provider: "github" }],
  ["PATCH", "/settings/oauth", { action: "saveRegistrationPolicy", disable_registration_when_oauth_enabled: true }],
];

describe("no customer reaches a DP-101 route", () => {
  const ROLES = ["owner", "admin", "builder", "viewer", "billing_admin"];
  test.each(ROLES.flatMap((role) => ROUTES.map(([m, p, b]) => [role, m, p, b] as const)))("a user who is %s of every org: %s %s → 404", async (role, method, path, body) => {
    const t = setup(role);
    const r = await t.call(user(CUSTOMER), method, path, body);
    expect(r.status).toBe(404);
    expect(r.body.error?.code).toBe("not_found");
    expect(t.opened).toEqual([]);
    expect(await row0()).toBeUndefined();
    expect(await oauthRows()).toEqual([]);
  });

  test.each(ROUTES.map(([m, p, b]) => [m, p, b] as const))("an API key (the operator's id, owner role, Coolify's root): %s %s → 404", async (method, path, body) => {
    const t = setup("owner");
    const r = await t.call({ subjectId: OPERATOR, subjectType: "service_principal" }, method, path, body);
    expect(r.status).toBe(404);
    expect(t.opened).toEqual([]);
  });

  test.each(ROUTES.map(([m, p, b]) => [m, p, b ?? null] as const))("no actor: %s %s → 404", async (method, path, body) => {
    const t = setup();
    expect((await t.call(null, method, path, body ?? undefined)).status).toBe(404);
    expect(t.opened).toEqual([]);
  });

  test("another method is the same 404 for a customer, and 405 only for the operator", async () => {
    const t = setup("owner");
    for (const method of ["POST", "DELETE", "PUT"]) {
      expect((await t.call(user(CUSTOMER), method, "/settings/email")).status).toBe(404);
      expect((await t.call(op, method, "/settings/email")).status).toBe(405);
    }
    expect(t.opened).toEqual([]);
  });

  test("through route(): an org owner's /v1/platform/settings/email is DP-79's 404", async () => {
    const t = setup("owner");
    for (const path of ["/v1/platform/settings/email", "/v1/platform/settings/oauth/github", "/v1/platform/settings/updates"]) {
      const res = await route(new Request(`https://deploy-core.internal${path}`, { headers: { "x-actor-subject-id": CUSTOMER, "x-actor-subject-type": "user" } }), t.env);
      expect([path, res.status]).toEqual([path, 404]);
    }
  });

  test("no org sees or changes the rows the operator saved", async () => {
    const t = setup();
    await t.call(op, "PATCH", "/settings/email", { action: "submit", emailProvider: "resend", resendApiKey: "re_secret", resendFromName: "Freeploy", resendFromAddress: "no-reply@example.com" });
    await t.call(op, "GET", "/settings/oauth");
    const seen = await withOrg(committing(pg), ORG, async (tx) => [(await tx.execute("SELECT * FROM deploy.instance_settings")).rows, (await tx.execute("SELECT * FROM deploy.oauth_settings")).rows]);
    expect(seen).toEqual([[], []]);
    const changed = await withOrg(committing(pg), ORG, (tx) => tx.execute("UPDATE deploy.oauth_settings SET enabled = true"));
    expect(changed.rowCount).toBe(0);
  });
});

describe("Updates (Settings\\Updates)", () => {
  test("the page: Coolify's defaults, no upgrade available, the registry not here", async () => {
    const r = await setup().call(op, "GET", "/settings/updates");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      settings: {
        auto_update_frequency: "0 0 * * *",
        update_check_frequency: "0 * * * *",
        is_auto_update_enabled: true,
        update_channel: "stable",
        update_custom_tag: null,
        docker_registry_url: null,
        isUpgradeAvailable: false,
        latestVersion: null,
      },
      canUpdate: true,
    });
  });

  test("instantSave() stores the toggle and the frequencies with 'Settings updated!'", async () => {
    const t = setup();
    const r = await t.call(op, "PATCH", "/settings/updates", { action: "instantSave", is_auto_update_enabled: false, auto_update_frequency: "0 3 * * *", update_check_frequency: "hourly", update_channel: "stable" });
    expect(r.status).toBe(200);
    expect(r.body.data?.message).toBe("Settings updated!");
    expect(await row0()).toMatchObject({ is_auto_update_enabled: false, auto_update_frequency: "0 3 * * *", update_check_frequency: "hourly" });
  });

  test("instantSave(): with automatic updates saved on, the update frequency is required", async () => {
    const r = await setup().call(op, "PATCH", "/settings/updates", { action: "instantSave", auto_update_frequency: "" });
    expect(r.status).toBe(422);
    expect(r.body.error?.details?.fields).toEqual({ auto_update_frequency: ["The auto update frequency field is required."] });
    expect((await row0())?.auto_update_frequency).toBe("0 0 * * *");
  });

  test("submit(): Coolify's cron validation, its toasts, nothing stored", async () => {
    const t = setup();
    const auto = await t.call(op, "PATCH", "/settings/updates", { action: "submit", is_auto_update_enabled: true, auto_update_frequency: "every day", update_check_frequency: "0 * * * *" });
    expect([auto.status, auto.body.error?.message]).toEqual([422, "Invalid Cron / Human expression for Auto Update Frequency."]);
    const check = await t.call(op, "PATCH", "/settings/updates", { action: "submit", is_auto_update_enabled: true, auto_update_frequency: "weekly", update_check_frequency: "61 * * * *" });
    expect([check.status, check.body.error?.message]).toEqual([422, "Invalid Cron / Human expression for Update Check Frequency."]);
    // Automatic updates off: their frequency is not checked.
    const off = await t.call(op, "PATCH", "/settings/updates", { action: "submit", is_auto_update_enabled: false, auto_update_frequency: "nonsense", update_check_frequency: "0 */6 * * *" });
    expect(off.status).toBe(200);
    expect(off.body.data?.message).toBe("Settings updated!");
    expect(await row0()).toMatchObject({ is_auto_update_enabled: false, auto_update_frequency: "nonsense", update_check_frequency: "0 */6 * * *" });
  });

  test("the rules and Laravel's messages", async () => {
    const t = setup();
    const required = await t.call(op, "PATCH", "/settings/updates", { action: "submit", update_check_frequency: "" });
    expect(required.body.error?.details?.fields).toEqual({ update_check_frequency: ["The update check frequency field is required."] });
    const channel = await t.call(op, "PATCH", "/settings/updates", { action: "instantSave", update_channel: "beta" });
    expect(channel.body.error?.details?.fields).toEqual({ update_channel: ["The selected update channel is invalid."] });
    const tag = await t.call(op, "PATCH", "/settings/updates", { action: "instantSave", update_channel: "custom", update_custom_tag: "" });
    expect(tag.body.error?.details?.fields).toEqual({ update_custom_tag: ["The update custom tag field is required when update channel is custom."] });
    const format = await t.call(op, "PATCH", "/settings/updates", { action: "instantSave", update_channel: "custom", update_custom_tag: "-pr 1" });
    expect(format.body.error?.details?.fields).toEqual({ update_custom_tag: ["The update custom tag field format is invalid."] });
    const long = await t.call(op, "PATCH", "/settings/updates", { action: "instantSave", update_channel: "custom", update_custom_tag: "a".repeat(129) });
    expect(long.body.error?.details?.fields).toEqual({ update_custom_tag: ["The update custom tag field must not be greater than 128 characters."] });
    const flag = await t.call(op, "PATCH", "/settings/updates", { action: "submit", is_auto_update_enabled: "yes" });
    expect(flag.body.error?.details?.fields).toEqual({ is_auto_update_enabled: ["The is auto update enabled field must be true or false."] });
    expect(await row0()).toMatchObject({ update_channel: "stable", update_custom_tag: null, is_auto_update_enabled: true });
  });

  test("a custom image: stored, the upgrade offered; Upgrade now answers 501 and stores nothing", async () => {
    const t = setup();
    const saved = await t.call(op, "PATCH", "/settings/updates", { action: "submit", update_channel: "custom", update_custom_tag: "pr-1234" });
    expect(saved.body.data?.settings).toMatchObject({ update_channel: "custom", update_custom_tag: "pr-1234", isUpgradeAvailable: true, latestVersion: "pr-1234" });
    const before = await row0();
    const up = await t.call(op, "PATCH", "/settings/updates", { action: "upgrade", update_channel: "stable" });
    expect([up.status, up.body.error?.code, up.body.error?.message]).toEqual([501, "not_implemented", SSH("Upgrading the instance")]);
    const check = await t.call(op, "PATCH", "/settings/updates", { action: "checkManually", update_channel: "stable" });
    expect([check.status, check.body.error?.message]).toEqual([501, "Checking for updates is not available yet: Freeploy is not an installed instance, and a merge to main deploys it."]);
    expect(await row0()).toEqual(before);
  });

  test("switchUpdateChannel(): the channel the instance keeps following after a switch to a more stable one", async () => {
    expect(switchUpdateChannel({ update_channel: "nightly", previous_update_channel: null }, "stable")).toEqual({ update_channel: "stable", previous_update_channel: "nightly" });
    expect(switchUpdateChannel({ update_channel: "preview", previous_update_channel: "nightly" }, "stable")).toEqual({ update_channel: "stable", previous_update_channel: "nightly" });
    expect(switchUpdateChannel({ update_channel: "stable", previous_update_channel: "nightly" }, "nightly")).toEqual({ update_channel: "nightly", previous_update_channel: null });
    expect(switchUpdateChannel({ update_channel: "stable", previous_update_channel: null }, "custom")).toEqual({ update_channel: "custom", previous_update_channel: null });
    const t = setup();
    await t.call(op, "PATCH", "/settings/updates", { action: "instantSave", update_channel: "nightly" });
    await t.call(op, "PATCH", "/settings/updates", { action: "instantSave", update_channel: "stable" });
    expect(await row0()).toMatchObject({ update_channel: "stable", previous_update_channel: "nightly" });
  });
});

describe("Backup (SettingsBackup)", () => {
  test("no instance database is configured; Configure backup answers 501 and stores nothing", async () => {
    const t = setup();
    expect((await t.call(op, "GET", "/settings/backup")).body.data).toEqual({ configured: false, canUpdate: true });
    const r = await t.call(op, "PATCH", "/settings/backup", { action: "addCoolifyDatabase" });
    expect([r.status, r.body.error?.message]).toEqual([501, SSH("Configuring the instance backup")]);
    expect(await row0()).toBeUndefined();
    expect((await pg.query("SELECT 1 FROM deploy.standalone_postgresqls")).rows).toEqual([]);
    expect((await pg.query("SELECT 1 FROM deploy.scheduled_database_backups")).rows).toEqual([]);
    expect((await t.call(op, "PATCH", "/settings/backup", { action: "instantSave" })).status).toBe(422);
  });
});

describe("Email (SettingsEmail)", () => {
  const RESEND = { emailProvider: "resend", resendApiKey: "re_live_secret", resendFromName: "Freeploy", resendFromAddress: "no-reply@example.com" };

  test("the page: no provider, the test disabled until one is saved, the signed-in address", async () => {
    const r = await setup().call(op, "GET", "/settings/email");
    expect(r.body.data?.settings).toMatchObject({ emailProvider: "none", activeEmailProvider: "none", smtpEnabled: false, resendEnabled: false, sendTestReason: "Save an email provider first.", testEmailAddress: "operator@example.com" });
  });

  test("submit() with Resend: saved with Coolify's toast, the secrets encrypted at rest, shown to the operator", async () => {
    const t = setup();
    const r = await t.call(op, "PATCH", "/settings/email", { action: "submit", ...RESEND, notificationFromName: "Alerts" });
    expect(r.status).toBe(200);
    expect(r.body.data?.message).toBe("Transactional email settings updated.");
    expect(r.body.data?.settings).toMatchObject({ emailProvider: "resend", resendEnabled: true, smtpEnabled: false, resendApiKey: "re_live_secret", notificationFromName: "Alerts", sendTestReason: null });
    const stored = await row0();
    expect(stored).toMatchObject({ resend_enabled: true, smtp_enabled: false });
    for (const column of ["resend_api_key", "resend_from_name", "resend_from_address", "notification_from_name"]) expect(String(stored?.[column])).toMatch(/^fp1:/);
    expect(JSON.stringify(stored)).not.toContain("re_live_secret");
    expect((await pg.query("SELECT org_id FROM deploy.org_keys")).rows).toEqual([{ org_id: PLATFORM_SETTINGS_ORG_ID }]);
  });

  test("submit() with SMTP: the provider's rules and Coolify's messages; the saved provider stays on", async () => {
    const t = setup();
    await t.call(op, "PATCH", "/settings/email", { action: "submit", ...RESEND });
    const r = await t.call(op, "PATCH", "/settings/email", { action: "submit", emailProvider: "smtp", smtpHost: "smtp.mailgun.org", smtpPort: "x", smtpFromAddress: "nope" });
    expect(r.status).toBe(422);
    expect(r.body.error?.details?.fields).toEqual({
      smtpFromAddress: ["Please enter a valid email address."],
      smtpFromName: ["From Name is required."],
      smtpPort: ["SMTP Port must be a number."],
      smtpUsername: ["This provider needs a username."],
      smtpPassword: ["This provider needs a password."],
    });
    expect(await row0()).toMatchObject({ resend_enabled: true, smtp_enabled: false });
    const ok = await t.call(op, "PATCH", "/settings/email", {
      action: "submit",
      emailProvider: "smtp",
      smtpHost: "mail.example.com",
      smtpPort: "587",
      smtpEncryption: "starttls",
      smtpFromName: "Freeploy",
      smtpFromAddress: "no-reply@example.com",
      smtpUsername: "user",
      smtpPassword: "smtp-pass",
      smtpEhloDomain: "freeploy.example.com",
    });
    expect(ok.status).toBe(200);
    expect(await row0()).toMatchObject({ smtp_enabled: true, resend_enabled: false, smtp_port: 587 });
    expect(String((await row0())?.smtp_password)).toMatch(/^fp1:/);
    const ehlo = await t.call(op, "PATCH", "/settings/email", { action: "submit", emailProvider: "smtp", smtpEhloDomain: "not a host" });
    expect(ehlo.status).toBe(422);
    expect(Object.keys(ehlo.body.error?.details?.fields ?? {})).toEqual(["smtpEhloDomain"]);
  });

  test("selectEmailProvider(): an incomplete provider shows its fields without an error and stores nothing", async () => {
    const t = setup();
    const r = await t.call(op, "PATCH", "/settings/email", { action: "selectEmailProvider", emailProvider: "resend" });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ message: null, saved: false });
    expect(await row0()).toMatchObject({ resend_enabled: false, smtp_enabled: false, resend_api_key: null });
    const done = await t.call(op, "PATCH", "/settings/email", { action: "selectEmailProvider", ...RESEND });
    expect(done.body.data).toMatchObject({ message: "Transactional email settings updated.", saved: true });
  });

  test("sendTestEmail(): Coolify's checks and messages, then 501 — nothing stored, nothing sent", async () => {
    const t = setup();
    await t.call(op, "PATCH", "/settings/email", { action: "submit", ...RESEND });
    const before = await row0();
    const empty = await t.call(op, "PATCH", "/settings/email", { action: "sendTestEmail", testEmailAddress: "" });
    expect(empty.body.error?.details?.fields).toEqual({ testEmailAddress: ["Test email address is required."] });
    const bad = await t.call(op, "PATCH", "/settings/email", { action: "sendTestEmail", testEmailAddress: "nope" });
    expect(bad.body.error?.details?.fields).toEqual({ testEmailAddress: ["Please enter a valid email address."] });
    const sender = await t.call(op, "PATCH", "/settings/email", { action: "sendTestEmail", testEmailAddress: "a@example.com", testUsesNotificationSender: true });
    expect(sender.body.error?.details?.fields).toEqual({ notificationFromAddress: ["Notification from address is required to test the notification sender."] });
    const resend = await t.call(op, "PATCH", "/settings/email", { action: "sendTestEmail", testEmailAddress: "a@example.com", resendFromAddress: "" });
    expect(resend.body.error?.details?.fields).toEqual({ resendFromAddress: ["From Address is required."] });
    const r = await t.call(op, "PATCH", "/settings/email", { action: "sendTestEmail", testEmailAddress: "a@example.com", resendFromName: "Changed" });
    expect([r.status, r.body.error?.code, r.body.error?.message]).toEqual([501, "not_implemented", HOSTED_EMAIL]);
    expect(await row0()).toEqual(before);
  });

  test("the SMTP password and Resend API key are not in the view of who cannot update", () => {
    const row = { smtp_password: "p", resend_api_key: "k", smtp_enabled: true, resend_enabled: false };
    expect(emailSettingsView(row, false, null)).toMatchObject({ smtpPassword: null, resendApiKey: null });
    expect(emailSettingsView(row, true, null)).toMatchObject({ smtpPassword: "p", resendApiKey: "k" });
  });
});

describe("Authentication (SettingsOauth)", () => {
  const map = (over: Record<string, Record<string, unknown>>) => ({ oauth_settings_map: over });

  test("the page: OauthSettingSeeder's providers, OpenID Connect first, Coolify's labels; an unknown provider is a 404", async () => {
    const t = setup();
    const r = await t.call(op, "GET", "/settings/oauth");
    const m = r.body.data?.oauth_settings_map as Record<string, { label: string; scopes: string; enabled: boolean; clock_skew_seconds: number }>;
    expect(Object.keys(m)).toEqual(["oidc", "authentik", "azure", "bitbucket", "clerk", "discord", "github", "gitlab", "google", "infomaniak", "zitadel"]);
    expect([m.oidc!.label, m.gitlab!.label, m.github!.label]).toEqual(["OpenID Connect", "GitLab", "Github"]);
    expect(m.github).toMatchObject({ enabled: false, scopes: "openid email profile", clock_skew_seconds: 60 });
    expect(r.body.data).toMatchObject({ disable_registration_when_oauth_enabled: false, selectedProvider: null });
    expect((await oauthRows()).map((x) => x.org_id)).toEqual(Array(11).fill(PLATFORM_SETTINGS_ORG_ID));
    expect((await t.call(op, "GET", "/settings/oauth/github")).body.data?.selectedProvider).toBe("github");
    expect((await t.call(op, "GET", "/settings/oauth/nope")).status).toBe(404);
    expect((await t.call(op, "PATCH", "/settings/oauth/nope", { action: "submit" })).status).toBe(404);
    // A second read seeds nothing more.
    await t.call(op, "GET", "/settings/oauth");
    expect((await oauthRows()).length).toBe(11);
  });

  test("toggleProvider(): an incomplete provider is refused with Coolify's toast and nothing stored", async () => {
    const t = setup();
    await t.call(op, "GET", "/settings/oauth");
    const r = await t.call(op, "PATCH", "/settings/oauth", { action: "toggleProvider", provider: "github", ...map({ github: { client_id: "id" } }) });
    expect([r.status, r.body.error?.message]).toEqual([422, "OAuth settings are not complete for github.<br/>Please fill in all required fields."]);
    expect((await oauthRows()).find((x) => x.provider === "github")).toMatchObject({ enabled: false, client_id: null });
    const azure = await t.call(op, "PATCH", "/settings/oauth", { action: "toggleProvider", provider: "azure", ...map({ azure: { client_id: "id", client_secret: "s" } }) });
    expect(azure.body.error?.message).toBe("OAuth settings are not complete for azure.<br/>Please fill in all required fields.");
    const oidc = await t.call(op, "PATCH", "/settings/oauth", { action: "toggleProvider", provider: "oidc", ...map({ oidc: { client_id: "id", client_secret: "s", base_url: "https://idp.example.com", scopes: "email profile" } }) });
    expect(oidc.body.error?.message).toBe("OIDC scopes must include 'openid'.");
    expect((await t.call(op, "PATCH", "/settings/oauth", { action: "toggleProvider", provider: "constructor" })).status).toBe(404);
  });

  test("toggleProvider(): a complete provider is enabled with its toast, the client secret encrypted; again, disabled", async () => {
    const t = setup();
    await t.call(op, "GET", "/settings/oauth");
    const r = await t.call(op, "PATCH", "/settings/oauth/github", { action: "toggleProvider", provider: "github", ...map({ github: { client_id: "gh-id", client_secret: "gh-secret", redirect_uri: "https://api.example.com/v1/auth/oauth/github/callback/" } }) });
    expect(r.status).toBe(200);
    expect(r.body.data?.message).toBe("OAuth settings for github updated successfully!");
    expect((r.body.data?.oauth_settings_map as Record<string, Record<string, unknown>>).github).toMatchObject({ enabled: true, client_id: "gh-id", client_secret: "gh-secret" });
    const stored = (await oauthRows()).find((x) => x.provider === "github")!;
    expect(stored).toMatchObject({ enabled: true, client_id: "gh-id", redirect_uri: "https://api.example.com/v1/auth/oauth/github/callback/" });
    expect(String(stored.client_secret)).toMatch(/^fp1:/);
    const off = await t.call(op, "PATCH", "/settings/oauth/github", { action: "toggleProvider", provider: "github" });
    expect((off.body.data?.oauth_settings_map as Record<string, Record<string, unknown>>).github).toMatchObject({ enabled: false, client_secret: "gh-secret" });
  });

  test("the rules and Laravel's messages, the redirect URI's callback path", async () => {
    const t = setup();
    await t.call(op, "GET", "/settings/oauth");
    const r = await t.call(op, "PATCH", "/settings/oauth/github", {
      action: "submit",
      ...map({ github: { redirect_uri: "https://api.example.com/auth/github/callback", clock_skew_seconds: "601", custom_label: "x".repeat(256) }, gitlab: { base_url: "ftp://gitlab.example.com" } }),
    });
    expect(r.status).toBe(422);
    // Only the route's provider is validated.
    expect(r.body.error?.details?.fields).toEqual({
      "oauth_settings_map.github.redirect_uri": ["The redirect URI must end with /v1/auth/oauth/github/callback."],
      "oauth_settings_map.github.custom_label": ["The oauth settings map.github.custom label field must not be greater than 255 characters."],
      "oauth_settings_map.github.clock_skew_seconds": ["The oauth settings map.github.clock skew seconds field must not be greater than 600."],
    });
    const all = await t.call(op, "PATCH", "/settings/oauth", { action: "submit", ...map({ gitlab: { base_url: "ftp://gitlab.example.com" }, azure: { clock_skew_seconds: "1.5" } }) });
    expect(all.body.error?.details?.fields).toEqual({
      "oauth_settings_map.azure.clock_skew_seconds": ["The oauth settings map.azure.clock skew seconds field must be an integer."],
      "oauth_settings_map.gitlab.base_url": ["The oauth settings map.gitlab.base url field must be a valid URL."],
    });
  });

  test("submit() of every provider: saved, an incomplete enabled one disabled with Coolify's error, the registration policy saved", async () => {
    const t = setup();
    await t.call(op, "GET", "/settings/oauth");
    const r = await t.call(op, "PATCH", "/settings/oauth", {
      action: "submit",
      disable_registration_when_oauth_enabled: true,
      ...map({ google: { enabled: true, client_id: "g", client_secret: "gs", tenant: "example.com" }, discord: { enabled: true, client_id: "d" }, oidc: { enabled: true, client_id: "o", client_secret: "os", base_url: "https://idp.example.com", scopes: "email" } }),
    });
    expect(r.status).toBe(200);
    expect(r.body.data?.message).toBe("Instance settings updated successfully!");
    expect(r.body.data?.error).toBe("OIDC scopes must include 'openid'. The provider has been disabled.<br/>OAuth settings are incomplete for 'discord'. Required fields are missing. The provider has been disabled.");
    const rows = await oauthRows();
    expect(rows.find((x) => x.provider === "google")).toMatchObject({ enabled: true, tenant: "example.com" });
    expect(rows.find((x) => x.provider === "discord")).toMatchObject({ enabled: false, client_id: "d" });
    expect(rows.find((x) => x.provider === "oidc")).toMatchObject({ enabled: false, scopes: "email" });
    expect((await row0())?.disable_registration_when_oauth_enabled).toBe(true);
  });

  test("saveRegistrationPolicy(): saved with Coolify's toast", async () => {
    const t = setup();
    const r = await t.call(op, "PATCH", "/settings/oauth", { action: "saveRegistrationPolicy", disable_registration_when_oauth_enabled: true });
    expect(r.body.data).toMatchObject({ message: "Authentication settings updated successfully!", disable_registration_when_oauth_enabled: true });
    const bad = await t.call(op, "PATCH", "/settings/oauth", { action: "saveRegistrationPolicy", disable_registration_when_oauth_enabled: "maybe" });
    expect(bad.body.error?.details?.fields).toEqual({ disable_registration_when_oauth_enabled: ["The disable registration when oauth enabled field must be true or false."] });
  });

  test("the model's helpers, and no client secret in the view of who cannot update", () => {
    expect(couldBeEnabled({ provider: "github", client_id: "a", client_secret: "b", tenant: null, base_url: null })).toBe(true);
    expect(couldBeEnabled({ provider: "clerk", client_id: "a", client_secret: "b", tenant: null, base_url: " " })).toBe(false);
    expect(scopeList("openid, email  openid")).toEqual(["openid", "email"]);
    expect(scopeList(null)).toEqual(["openid", "email", "profile"]);
    expect(providerLabel("infomaniak")).toBe("Infomaniak");
    const row = { id: 1, provider: "github", enabled: true, client_id: "a", client_secret: "b", redirect_uri: null, tenant: null, base_url: null, custom_label: null, scopes: null, allow_registration: true, auto_join_root_team: false, require_email_verified: true, use_pkce: true, clock_skew_seconds: 60 } satisfies OauthRow;
    expect((oauthView([row], false, false).oauth_settings_map as Record<string, { client_secret: unknown }>).github!.client_secret).toBeNull();
  });
});
