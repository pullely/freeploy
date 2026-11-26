// Derived from coollabsio/coolify@91b7e3e:app/Models/InstanceSettings.php, app/Models/OauthSetting.php and
// database/seeders/OauthSettingSeeder.php (Apache-2.0), modified.
//
// The platform's Updates, Email and Authentication settings (freeploy-coolify-parity DP12, DP-101): more
// columns of DP-79's row 0 of deploy.instance_settings (platform-settings.ts: owned by the nil UUID, which
// no org has), and Coolify's deploy.oauth_settings, one row per provider, owned by the same nil UUID.
// Row-level security shows them to no org (`org_id = deploy.current_org()`), only to the platform operator
// (`deploy.is_platform_admin()`); every function takes the transaction of asPlatformAdmin().
//
// The encrypted columns (encrypted-columns.ts' instance_settings entries, and oauth_settings.client_secret,
// which OauthSetting encrypts in an accessor the generator does not see) hold fp1 ciphertexts; these
// functions never decrypt. No migration: every column is Coolify's, created by 500_deploy_core and 520.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { PLATFORM_SETTINGS_ORG_ID, readPlatformSettings } from "./platform-settings.js";

/** The columns of row 0 each DP-101 page reads and writes. */
export const PLATFORM_SETTINGS_MORE_COLUMNS = {
  /** Settings\Updates (docker_registry_url is the deployment's configuration, DP-79). */
  updates: ["is_auto_update_enabled", "auto_update_frequency", "update_check_frequency", "update_channel", "update_custom_tag", "previous_update_channel", "new_version_available"],
  /** SettingsEmail (the named SMTP servers, smtp_servers, are not ported). */
  email: [
    "smtp_enabled",
    "smtp_server_name",
    "smtp_from_address",
    "smtp_from_name",
    "smtp_host",
    "smtp_port",
    "smtp_encryption",
    "smtp_username",
    "smtp_password",
    "smtp_timeout",
    "smtp_ehlo_domain",
    "notification_from_address",
    "notification_from_name",
    "resend_enabled",
    "resend_api_key",
    "resend_from_address",
    "resend_from_name",
  ],
  /** SettingsOauth's Registration. */
  oauth: ["disable_registration_when_oauth_enabled"],
  /** DP-107: POST /api/v1/mcp/enable and /mcp/disable (OtherController): the instance's MCP server switch, stored only (Freeploy has no /mcp). */
  mcp: ["is_mcp_server_enabled"],
} as const;
export type PlatformSettingsMoreSection = keyof typeof PLATFORM_SETTINGS_MORE_COLUMNS;

const quoted = (columns: readonly string[]) => columns.map((c) => `"${c}"`).join(", ");

function checkColumns(section: PlatformSettingsMoreSection, keys: string[]): void {
  const allowed: readonly string[] = PLATFORM_SETTINGS_MORE_COLUMNS[section];
  for (const k of keys) if (!allowed.includes(k)) throw new Error(`Not a ${section} platform setting: ${k}`);
}

/** instanceSettings() for one page: row 0 (created with the table's defaults when missing), the page's columns. */
export async function readPlatformSettingsMore(tx: SqlExecutor, section: PlatformSettingsMoreSection): Promise<SqlRow> {
  await readPlatformSettings(tx);
  const r = await tx.execute(`SELECT ${quoted(PLATFORM_SETTINGS_MORE_COLUMNS[section])} FROM deploy.instance_settings WHERE id = 0 AND org_id = $1`, [PLATFORM_SETTINGS_ORG_ID]);
  const row = r.rows[0];
  if (!row) throw new Error("platform settings row is missing");
  return row;
}

/** $settings->save() of a page's columns (ciphertext for the encrypted ones); answers the page's row as saved. Unknown columns are refused. */
export async function updatePlatformSettingsMore(tx: SqlExecutor, section: PlatformSettingsMoreSection, changes: Record<string, unknown>): Promise<SqlRow> {
  const keys = Object.keys(changes);
  checkColumns(section, keys);
  await readPlatformSettings(tx);
  if (keys.length) {
    const sets = keys.map((k, i) => `"${k}" = $${i + 2}`);
    await tx.execute(`UPDATE deploy.instance_settings SET ${sets.join(", ")}, updated_at = now() WHERE id = 0 AND org_id = $1`, [PLATFORM_SETTINGS_ORG_ID, ...keys.map((k) => changes[k])]);
  }
  return readPlatformSettingsMore(tx, section);
}

/** OauthSettingSeeder's providers. */
export const PLATFORM_OAUTH_PROVIDERS = ["azure", "bitbucket", "clerk", "discord", "github", "gitlab", "google", "oidc", "authentik", "infomaniak", "zitadel"] as const;

/** An oauth_settings row as stored (client_secret: ciphertext or null). */
export interface PlatformOauthSettingRow extends SqlRow {
  id: string | number;
  provider: string;
  enabled: boolean;
  client_id: string | null;
  client_secret: string | null;
  redirect_uri: string | null;
  tenant: string | null;
  base_url: string | null;
  custom_label: string | null;
  scopes: string | null;
  allow_registration: boolean;
  require_email_verified: boolean;
  use_pkce: boolean;
  clock_skew_seconds: number;
  auto_join_root_team: boolean;
}

/** OauthSetting's $fillable, without provider. */
export const PLATFORM_OAUTH_COLUMNS = [
  "enabled",
  "client_id",
  "client_secret",
  "redirect_uri",
  "tenant",
  "base_url",
  "custom_label",
  "scopes",
  "allow_registration",
  "require_email_verified",
  "use_pkce",
  "clock_skew_seconds",
  "auto_join_root_team",
] as const;
export type PlatformOauthChanges = Partial<Pick<PlatformOauthSettingRow, (typeof PLATFORM_OAUTH_COLUMNS)[number]>>;

const OAUTH_SELECT = `id, provider, ${quoted(PLATFORM_OAUTH_COLUMNS)}`;

/** OauthSetting::all(): the platform's providers, seeded with the columns' defaults on first read (OauthSettingSeeder). */
export async function listPlatformOauthSettings(tx: SqlExecutor): Promise<PlatformOauthSettingRow[]> {
  const select = () => tx.execute<PlatformOauthSettingRow>(`SELECT ${OAUTH_SELECT} FROM deploy.oauth_settings WHERE org_id = $1 ORDER BY id`, [PLATFORM_SETTINGS_ORG_ID]);
  const found = await select();
  const missing = PLATFORM_OAUTH_PROVIDERS.filter((p) => !found.rows.some((r) => r.provider === p));
  if (missing.length === 0) return found.rows;
  const values = missing.map((_, i) => `($${i + 2}, $1, now(), now())`).join(", ");
  await tx.execute(`INSERT INTO deploy.oauth_settings (provider, org_id, created_at, updated_at) VALUES ${values} ON CONFLICT DO NOTHING`, [PLATFORM_SETTINGS_ORG_ID, ...missing]);
  return (await select()).rows;
}

/** $oauth->save() of one provider's columns; answers the row as saved, or null when there is no such provider. Unknown columns are refused. */
export async function updatePlatformOauthSetting(tx: SqlExecutor, provider: string, changes: PlatformOauthChanges): Promise<PlatformOauthSettingRow | null> {
  const keys = Object.keys(changes);
  for (const k of keys) if (!(PLATFORM_OAUTH_COLUMNS as readonly string[]).includes(k)) throw new Error(`Not an OAuth setting: ${k}`);
  const values = keys.map((k) => (changes as Record<string, unknown>)[k]);
  const sets = keys.map((k, i) => `"${k}" = $${i + 3}`);
  const r = await tx.execute<PlatformOauthSettingRow>(
    `UPDATE deploy.oauth_settings SET ${[...sets, "updated_at = now()"].join(", ")} WHERE org_id = $1 AND provider = $2 RETURNING ${OAUTH_SELECT}`,
    [PLATFORM_SETTINGS_ORG_ID, provider, ...values],
  );
  return r.rows[0] ?? null;
}
