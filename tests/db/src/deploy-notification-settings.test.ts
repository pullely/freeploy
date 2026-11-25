// deploy.*_notification_settings (DP-67) on the head schema: the row created on the first read with
// Coolify's defaults, one row per org, updates and their failure_count reset (TracksDeliveryFailures),
// the delivery failure counter, turning a channel off, the encrypted columns, and row-level security
// keeping each org's row to itself.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  loadKek,
  orgDek,
  encryptField,
  decryptField,
  isEncrypted,
  isEncryptedColumn,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  NOTIFICATION_SETTINGS_COLUMNS,
  findNotificationSettings,
  ensureNotificationSettings,
  updateNotificationSettings,
  recordNotificationDeliveryFailure,
  recordNotificationDeliverySuccess,
  disableNotificationChannel,
} from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, executor, sqlState, TEST_KEK as KEK } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

let db: PGlite;
let ex: TransactionalSqlExecutor;
beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
}, 120_000);
afterAll(async () => db?.close());

describe("deploy.*_notification_settings", () => {
  test("every column the pages write is in the head schema", async () => {
    for (const channel of NOTIFICATION_CHANNELS) {
      const r = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'deploy' AND table_name = $1`,
        [`${channel}_notification_settings`],
      );
      const present = new Set(r.rows.map((c) => c.column_name));
      expect(NOTIFICATION_SETTINGS_COLUMNS[channel].filter((c) => !present.has(c))).toEqual([]);
      expect(present.has("failure_count")).toBe(true);
      expect(present.has("org_id")).toBe(true);
    }
  });

  test("the first read creates the org's row with Coolify's defaults; a second read finds the same row", async () => {
    await withOrg(ex, A, async (tx) => {
      expect(await findNotificationSettings(tx, "discord")).toBeNull();
      const row = await ensureNotificationSettings(tx, "discord", A);
      expect(row.org_id).toBe(A);
      expect(row.discord_enabled).toBe(false);
      expect(row.discord_webhook_url).toBeNull();
      expect(row.discord_ping_enabled).toBe(true);
      expect(row.failure_count).toBe(0);
      // The defaults of the event toggles (Coolify's migrations).
      expect(row.deployment_success_discord_notifications).toBe(false);
      expect(row.deployment_failure_discord_notifications).toBe(true);
      expect(row.image_vulnerabilities_discord_notifications).toBe(false);
      const again = await ensureNotificationSettings(tx, "discord", A);
      expect(String(again.id)).toBe(String(row.id));
    });
    for (const channel of NOTIFICATION_CHANNELS) {
      const row = await withOrg(ex, A, (tx) => ensureNotificationSettings(tx, channel, A));
      expect(row.failure_count).toBe(0);
      for (const e of NOTIFICATION_EVENTS) expect(typeof row[`${e}_${channel}_notifications`]).toBe("boolean");
    }
    const email = await withOrg(ex, A, (tx) => ensureNotificationSettings(tx, "email", A));
    expect(email.use_instance_email_settings).toBe(false);
    expect(email.smtp_enabled).toBe(false);
    expect(email.resend_enabled).toBe(false);
    expect(email.image_vulnerabilities_email_notifications).toBe(true);
    const webhook = await withOrg(ex, A, (tx) => ensureNotificationSettings(tx, "webhook", A));
    expect(webhook.server_patch_webhook_notifications).toBe(false);
  });

  test("one row per org: org_id is unique", async () => {
    const state = await sqlState(() =>
      withOrg(ex, A, (tx) => tx.execute("INSERT INTO deploy.slack_notification_settings (org_id) VALUES ($1)", [A])),
    );
    expect(state).toBe("23505");
  });

  test("an update writes the given columns, resets failure_count, and refuses other columns", async () => {
    await withOrg(ex, A, async (tx) => {
      await tx.execute("UPDATE deploy.telegram_notification_settings SET failure_count = 2");
      const row = await updateNotificationSettings(tx, "telegram", { telegram_enabled: true, deployment_success_telegram_notifications: true, telegram_notifications_backup_failure_thread_id: "x" });
      expect(row!.telegram_enabled).toBe(true);
      expect(row!.deployment_success_telegram_notifications).toBe(true);
      expect(row!.failure_count).toBe(0);
      await expect(updateNotificationSettings(tx, "telegram", { org_id: B })).rejects.toThrow("Not a telegram notification setting: org_id");
      await expect(updateNotificationSettings(tx, "telegram", { failure_count: 9 })).rejects.toThrow();
    });
  });

  test("the delivery failure counter, its reset on a success, and turning a channel off", async () => {
    await withOrg(ex, A, async (tx) => {
      await updateNotificationSettings(tx, "pushover", { pushover_enabled: true });
      expect(await recordNotificationDeliveryFailure(tx, "pushover")).toEqual({ failureCount: 1, enabled: true });
      expect(await recordNotificationDeliveryFailure(tx, "pushover")).toEqual({ failureCount: 2, enabled: true });
      await recordNotificationDeliverySuccess(tx, "pushover");
      expect((await findNotificationSettings(tx, "pushover"))!.failure_count).toBe(0);
      await recordNotificationDeliveryFailure(tx, "pushover");
      await disableNotificationChannel(tx, "pushover");
      const row = await findNotificationSettings(tx, "pushover");
      expect(row!.pushover_enabled).toBe(false);
      expect(row!.failure_count).toBe(0);
      // Email: both providers off; the instance's settings count as on.
      await updateNotificationSettings(tx, "email", { resend_enabled: true });
      expect(await recordNotificationDeliveryFailure(tx, "email")).toEqual({ failureCount: 1, enabled: true });
      await disableNotificationChannel(tx, "email");
      const email = await findNotificationSettings(tx, "email");
      expect([email!.smtp_enabled, email!.resend_enabled]).toEqual([false, false]);
    });
  });

  test("the secrets are stored as ciphertexts of the org's data key", async () => {
    expect(isEncryptedColumn("discord_notification_settings", "discord_webhook_url")).toBe(true);
    expect(isEncryptedColumn("webhook_notification_settings", "webhook_url")).toBe(true);
    expect(isEncryptedColumn("email_notification_settings", "resend_api_key")).toBe(true);
    expect(isEncryptedColumn("telegram_notification_settings", "telegram_notifications_backup_failure_thread_id")).toBe(true);
    const url = "https://discord.com/api/webhooks/1/FAKE";
    await withOrg(ex, A, async (tx) => {
      const dek = await orgDek(tx, A, await loadKek(KEK));
      await updateNotificationSettings(tx, "discord", { discord_webhook_url: await encryptField(dek, "discord_notification_settings.discord_webhook_url", url) });
      const row = await findNotificationSettings(tx, "discord");
      expect(isEncrypted(row!.discord_webhook_url)).toBe(true);
      expect(await decryptField(dek, "discord_notification_settings.discord_webhook_url", row!.discord_webhook_url as string)).toBe(url);
    });
  });

  test("row-level security: another org neither sees nor changes the row", async () => {
    await withOrg(ex, B, async (tx) => {
      expect(await findNotificationSettings(tx, "discord")).toBeNull();
      expect(await recordNotificationDeliveryFailure(tx, "discord")).toBeNull();
      const own = await ensureNotificationSettings(tx, "discord", B);
      expect(own.org_id).toBe(B);
      expect(own.discord_webhook_url).toBeNull();
    });
    const state = await sqlState(() => withOrg(ex, B, (tx) => tx.execute("INSERT INTO deploy.discord_notification_settings (org_id) VALUES ($1)", [A])));
    expect(state).toBe("42501");
  });
});
