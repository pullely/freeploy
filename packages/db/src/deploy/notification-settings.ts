// Derived from coollabsio/coolify@91b7e3e:app/Models/{Email,Discord,Telegram,Slack,Pushover,Webhook}NotificationSettings.php,
// app/Models/Team.php::createDefaultNotificationSettings() and app/Traits/TracksDeliveryFailures.php (Apache-2.0), modified.
//
// The six deploy.*_notification_settings tables: one row per org (org_id is unique), Coolify's columns and
// defaults (500_deploy_core, 520, 660). Coolify creates the rows when a team is created; here a row is
// created the first time the org's settings are read (ensureNotificationSettings), with the same defaults.
// Every function takes the transaction of withOrg(): row-level security confines it to that org's row.
// Encrypted columns (encrypted-columns.ts) hold fp1 ciphertexts; these functions never decrypt.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

export const NOTIFICATION_CHANNELS = ["email", "discord", "telegram", "slack", "pushover", "webhook"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** The event toggles every channel has: {event}_{channel}_notifications (TogglesNotificationEvents). */
export const NOTIFICATION_EVENTS = [
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
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

const toggles = (channel: NotificationChannel) => NOTIFICATION_EVENTS.map((e) => `${e}_${channel}_notifications`);

/** The columns a settings page writes ($fillable without team_id; smtp_servers, the saved SMTP servers, is not ported). */
export const NOTIFICATION_SETTINGS_COLUMNS: Readonly<Record<NotificationChannel, readonly string[]>> = {
  email: [
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
    "smtp_server_name",
    "resend_enabled",
    "resend_api_key",
    "resend_from_address",
    "resend_from_name",
    "use_instance_email_settings",
    "deployment_commit_details_email_notifications",
    ...toggles("email"),
  ],
  discord: ["discord_enabled", "discord_webhook_url", "discord_ping_enabled", ...toggles("discord")],
  telegram: ["telegram_enabled", "telegram_token", "telegram_chat_id", ...toggles("telegram"), ...NOTIFICATION_EVENTS.map((e) => `telegram_notifications_${e}_thread_id`)],
  slack: ["slack_enabled", "slack_webhook_url", ...toggles("slack")],
  pushover: ["pushover_enabled", "pushover_user_key", "pushover_api_token", ...toggles("pushover")],
  webhook: ["webhook_enabled", "webhook_url", ...toggles("webhook")],
};

export const notificationSettingsTable = (channel: NotificationChannel): string => `${channel}_notification_settings`;

/** A row as stored: booleans, integers, text (ciphertext for the encrypted columns), failure_count. */
export type DeployNotificationSettingsRow = SqlRow & { id: string | number; org_id: string; failure_count: number } & Record<string, unknown>;

function columns(channel: NotificationChannel): string {
  return ["id", "org_id", "failure_count", ...NOTIFICATION_SETTINGS_COLUMNS[channel]].map((c) => `"${c}"`).join(", ");
}

function checkChannel(channel: string): asserts channel is NotificationChannel {
  if (!(NOTIFICATION_CHANNELS as readonly string[]).includes(channel)) throw new Error(`Unknown notification channel ${channel}`);
}

/** The org's row of a channel, or null before it was created. */
export async function findNotificationSettings(tx: SqlExecutor, channel: NotificationChannel): Promise<DeployNotificationSettingsRow | null> {
  checkChannel(channel);
  const r = await tx.execute<DeployNotificationSettingsRow>(`SELECT ${columns(channel)} FROM deploy.${notificationSettingsTable(channel)} LIMIT 1`);
  return r.rows[0] ?? null;
}

/**
 * The org's row of a channel, created with the column defaults when the org has none yet
 * (createDefaultNotificationSettings(): use_instance_email_settings is isDev(), so false).
 */
export async function ensureNotificationSettings(tx: SqlExecutor, channel: NotificationChannel, orgId: string): Promise<DeployNotificationSettingsRow> {
  checkChannel(channel);
  await tx.execute(`INSERT INTO deploy.${notificationSettingsTable(channel)} (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING`, [orgId]);
  const row = await findNotificationSettings(tx, channel);
  if (!row) throw new Error(`No ${channel} notification settings for the org`);
  return row;
}

/**
 * save() with the changed columns. A change to any column but failure_count sets failure_count back to 0
 * (TracksDeliveryFailures' saving hook). Unknown columns are refused.
 */
export async function updateNotificationSettings(tx: SqlExecutor, channel: NotificationChannel, changes: Record<string, unknown>): Promise<DeployNotificationSettingsRow | null> {
  checkChannel(channel);
  const allowed = NOTIFICATION_SETTINGS_COLUMNS[channel];
  const keys = Object.keys(changes);
  for (const k of keys) if (!allowed.includes(k)) throw new Error(`Not a ${channel} notification setting: ${k}`);
  if (keys.length === 0) return findNotificationSettings(tx, channel);
  const sets = keys.map((k, i) => `"${k}" = $${i + 1}`);
  const r = await tx.execute<DeployNotificationSettingsRow>(
    `UPDATE deploy.${notificationSettingsTable(channel)} SET ${sets.join(", ")}, failure_count = 0 RETURNING ${columns(channel)}`,
    keys.map((k) => changes[k]),
  );
  return r.rows[0] ?? null;
}

const ENABLED: Record<NotificationChannel, string> = {
  // EmailNotificationSettings::isEnabled(): a provider is on, or the instance's settings are used.
  email: "(smtp_enabled OR resend_enabled OR use_instance_email_settings)",
  discord: "discord_enabled",
  telegram: "telegram_enabled",
  slack: "slack_enabled",
  pushover: "pushover_enabled",
  webhook: "webhook_enabled",
};

/** recordDeliveryFailure(): $this->increment('failure_count'). Answers the new count and whether the channel is on. */
export async function recordNotificationDeliveryFailure(tx: SqlExecutor, channel: NotificationChannel): Promise<{ failureCount: number; enabled: boolean } | null> {
  checkChannel(channel);
  const r = await tx.execute<{ failure_count: number; enabled: boolean }>(
    `UPDATE deploy.${notificationSettingsTable(channel)} SET failure_count = failure_count + 1 RETURNING failure_count, ${ENABLED[channel]} AS enabled`,
  );
  const row = r.rows[0];
  return row ? { failureCount: Number(row.failure_count), enabled: Boolean(row.enabled) } : null;
}

/** recordDeliverySuccess(): failure_count back to 0 when it is not. */
export async function recordNotificationDeliverySuccess(tx: SqlExecutor, channel: NotificationChannel): Promise<void> {
  checkChannel(channel);
  await tx.execute(`UPDATE deploy.${notificationSettingsTable(channel)} SET failure_count = 0 WHERE failure_count > 0`);
}

/** disableNotificationChannel() and save(): the channel off (email: both providers), failure_count back to 0. */
export async function disableNotificationChannel(tx: SqlExecutor, channel: NotificationChannel): Promise<void> {
  checkChannel(channel);
  const off = channel === "email" ? "smtp_enabled = false, resend_enabled = false" : `${channel}_enabled = false`;
  await tx.execute(`UPDATE deploy.${notificationSettingsTable(channel)} SET ${off}, failure_count = 0`);
}
