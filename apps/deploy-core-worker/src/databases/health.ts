// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Database/Health.php and
// resources/views/livewire/project/database/configuration.blade.php (project.database.healthcheck)
// (Apache-2.0), modified.
//
// A standalone database's Healthcheck page (DP-97): the five healthcheck columns of its row, with Health's
// #[Validate] rules and Laravel's messages (the attribute is the property's name in words). Coolify's markers of
// a changed configuration (config_hash / isConfigurationChanged) are not kept, as on the other database pages;
// the toast tells to restart the database, which needs the SSH executor.
import type { DatabaseHealthChanges, DeployDatabaseHealthRow } from "@saas/db/deploy";
import type { FieldErrors } from "../private-keys/validation.js";
import { SettingsFieldErrors } from "../applications/settings.js";
import { booleanValue, integerOf } from "../applications/more.js";
import type { DatabaseShow } from "./service.js";
import { loadDatabase, type DatabaseHealthStore, type DatabaseResourcesContext } from "./resources.js";

type Body = Record<string, unknown>;

export const DATABASE_HEALTH_MESSAGES = {
  updated: "Healthcheck updated. Restart the database to apply the changes.",
  toggled: (enabled: boolean) => `Healthcheck ${enabled ? "enabled" : "disabled"}. Restart the database to apply the changes.`,
  integer: (attribute: string) => `The ${attribute} field must be an integer.`,
  boolean: (attribute: string) => `The ${attribute} field must be true or false.`,
  min: (attribute: string, n: number) => `The ${attribute} field must be at least ${n}.`,
} as const;

/** The page's properties, as Health declares them. */
export interface DatabaseHealth {
  healthCheckEnabled: boolean;
  healthCheckInterval: number;
  healthCheckTimeout: number;
  healthCheckRetries: number;
  healthCheckStartPeriod: number;
}

export interface DatabaseHealthPage {
  database: DatabaseShow;
  health: DatabaseHealth;
}

/** Each property: its column, Laravel's displayable attribute and its `min`; null for the boolean. */
const FIELDS: Array<[keyof DatabaseHealth, keyof DeployDatabaseHealthRow & string, string, number | null]> = [
  ["healthCheckEnabled", "health_check_enabled", "health check enabled", null],
  ["healthCheckInterval", "health_check_interval", "health check interval", 1],
  ["healthCheckTimeout", "health_check_timeout", "health check timeout", 1],
  ["healthCheckRetries", "health_check_retries", "health check retries", 1],
  ["healthCheckStartPeriod", "health_check_start_period", "health check start period", 0],
];

const health = (row: DeployDatabaseHealthRow): DatabaseHealth => ({
  healthCheckEnabled: Boolean(row.health_check_enabled),
  healthCheckInterval: Number(row.health_check_interval),
  healthCheckTimeout: Number(row.health_check_timeout),
  healthCheckRetries: Number(row.health_check_retries),
  healthCheckStartPeriod: Number(row.health_check_start_period),
});

function storeOf(ctx: DatabaseResourcesContext): DatabaseHealthStore {
  if (!ctx.health) throw new Error("The database's health store is missing.");
  return ctx.health;
}

/** Health::mount(): syncData() from the row. Null when the database is not the org's. */
export async function showDatabaseHealth(ctx: DatabaseResourcesContext, uuid: string, canUpdate: boolean): Promise<DatabaseHealthPage | null> {
  const l = await loadDatabase(ctx, uuid, canUpdate);
  const row = l ? await storeOf(ctx).find(l.row.engine, l.row.id) : null;
  return l && row ? { database: l.database, health: health(row) } : null;
}

/** $this->validate() with #[Validate]: the form's values, each property the stored value when the form leaves it out. */
function validate(body: Body, current: DatabaseHealth): DatabaseHealth {
  const errors: FieldErrors = {};
  const out: DatabaseHealth = { ...current };
  for (const [property, , attribute, min] of FIELDS) {
    const raw = body[property];
    if (raw === undefined) continue;
    if (min === null) {
      const value = booleanValue(raw);
      if (value === undefined) errors[property] = [DATABASE_HEALTH_MESSAGES.boolean(attribute)];
      else out.healthCheckEnabled = value;
      continue;
    }
    const value = integerOf(raw);
    if (value === null) errors[property] = [DATABASE_HEALTH_MESSAGES.integer(attribute)];
    else if (value < min) errors[property] = [DATABASE_HEALTH_MESSAGES.min(attribute, min)];
    else (out[property] as number) = value;
  }
  if (Object.keys(errors).length) throw new SettingsFieldErrors(errors);
  return out;
}

const changesOf = (h: DatabaseHealth): DatabaseHealthChanges => Object.fromEntries(FIELDS.map(([property, column]) => [column, h[property]]));

/**
 * Health::submit() (and instantSave()), or toggleHealthcheck() with `toggle`: the switch flipped first, then
 * syncData(true) — every property validated and saved. Null when the database is not the org's.
 */
export async function saveDatabaseHealth(ctx: DatabaseResourcesContext, uuid: string, body: Body, toggle = false): Promise<(DatabaseHealthPage & { message: string }) | null> {
  const l = await loadDatabase(ctx, uuid, true);
  const store = storeOf(ctx);
  const row = l ? await store.find(l.row.engine, l.row.id) : null;
  if (!l || !row) return null;
  const form = { ...health(row), ...Object.fromEntries(FIELDS.map(([p]) => [p, body[p]]).filter(([, v]) => v !== undefined)) } as DatabaseHealth;
  const next = validate(toggle ? { ...body, healthCheckEnabled: !(booleanValue(form.healthCheckEnabled) ?? form.healthCheckEnabled) } : body, health(row));
  await store.update(l.row.engine, l.row.id, changesOf(next));
  const saved = await store.find(l.row.engine, l.row.id);
  return { database: l.database, health: health(saved ?? row), message: toggle ? DATABASE_HEALTH_MESSAGES.toggled(next.healthCheckEnabled) : DATABASE_HEALTH_MESSAGES.updated };
}
