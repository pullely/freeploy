// Derived from coollabsio/coolify@91b7e3e:app/Models/InstanceSettings.php and
// database/seeders/InstanceSettingsSeeder.php (Apache-2.0), modified.
//
// The platform's settings (freeploy-coolify-parity DP12): Coolify's instance settings, the one row
// `InstanceSettings::findOrFail(0)`. They are kept in Coolify's own table, deploy.instance_settings,
// as its row 0, owned by no customer org: its org_id is the nil UUID, which no organization has, so
// row-level security shows it to none of them (`org_id = deploy.current_org()`), only to the platform
// operator (`deploy.is_platform_admin()`). Every function takes the transaction of asPlatformAdmin(),
// which only routes policy-worker has authorized for the operator reach.
//
// Only the settings that mean something for a hosted, multi-tenant Freeploy are read and written here
// (IMPLEMENTATION-STATUS.md, Notes on DP12). Coolify's row is created by its seeder with the columns'
// defaults; Freeploy creates it on first read, the same way, except the sponsorship reminder, which
// defaults to off (Departures from the design: "No sponsorship popup").
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

/** The org_id of the platform's row: no organization's. */
export const PLATFORM_SETTINGS_ORG_ID = "00000000-0000-0000-0000-000000000000";

/** The settings Freeploy ports, as deploy.instance_settings stores them. */
export interface PlatformSettingsRow extends SqlRow {
  /** Settings\Index: Name ("Custom name for this … instance"). */
  instance_name: string | null;
  /** Settings\Advanced: Registration. */
  is_registration_enabled: boolean;
  /** Settings\Advanced: Destructive action confirmation (true = skip). */
  disable_two_step_confirmation: boolean;
  /** Settings\Advanced: Passkeys. */
  is_passkey_enabled: boolean;
  /** Settings\Advanced: DNS validation. */
  is_dns_validation_enabled: boolean;
  /** Settings\Advanced: Sponsorship reminders. */
  is_sponsorship_popup_enabled: boolean;
  updated_at: string | Date | null;
}

export type PlatformSettingsChanges = Partial<Omit<PlatformSettingsRow, "updated_at">>;

const COLUMNS = [
  "instance_name",
  "is_registration_enabled",
  "disable_two_step_confirmation",
  "is_passkey_enabled",
  "is_dns_validation_enabled",
  "is_sponsorship_popup_enabled",
] as const;

/** The column names of the ported settings, in the order the pages show them. */
export const PLATFORM_SETTINGS_COLUMNS: readonly (keyof PlatformSettingsChanges)[] = COLUMNS;

/** InstanceSettings::get(): row 0, created with the table's defaults (sponsorship off) when it is missing. */
export async function readPlatformSettings(tx: SqlExecutor): Promise<PlatformSettingsRow> {
  await tx.execute(
    `INSERT INTO deploy.instance_settings (id, org_id, is_sponsorship_popup_enabled, created_at, updated_at)
     VALUES (0, $1, false, now(), now()) ON CONFLICT (id) DO NOTHING`,
    [PLATFORM_SETTINGS_ORG_ID],
  );
  const r = await tx.execute<PlatformSettingsRow>(
    `SELECT ${COLUMNS.join(", ")}, updated_at FROM deploy.instance_settings WHERE id = 0 AND org_id = $1`,
    [PLATFORM_SETTINGS_ORG_ID],
  );
  const row = r.rows[0];
  if (!row) throw new Error("platform settings row is missing");
  return row;
}

/** $settings->save() of the ported columns; answers the row as saved. Unknown keys are ignored. */
export async function updatePlatformSettings(tx: SqlExecutor, changes: PlatformSettingsChanges): Promise<PlatformSettingsRow> {
  await readPlatformSettings(tx);
  const keys = COLUMNS.filter((c) => changes[c] !== undefined);
  if (keys.length) {
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    await tx.execute(`UPDATE deploy.instance_settings SET ${sets.join(", ")}, updated_at = now() WHERE id = 0 AND org_id = $1`, [
      PLATFORM_SETTINGS_ORG_ID,
      ...keys.map((k) => changes[k]),
    ]);
  }
  return readPlatformSettings(tx);
}
