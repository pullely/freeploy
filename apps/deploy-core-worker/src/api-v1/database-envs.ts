// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/DatabasesController.php (removeSensitiveEnvData,
// envs, create_env, update_env_by_uuid, create_bulk_envs, delete_env_by_uuid) and app/Models/EnvironmentVariable.php
// (Apache-2.0), modified.
//
// Coolify's /api/v1 for the environment variables of a standalone database (DP-84), on DP-64's resource-generic
// environment variable code (environment-variables/service.ts, the `standalone-<engine>` resource types) and DP-74's
// serialization of a variable (applications.ts's variableModel()), as a service's variables are answered: the
// controller is the same but for the database lookup, the policy of the list (view, where a service's asks
// manageEnvironment) and the columns the list hides (none beside removeSensitiveEnvData()'s).
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { DATABASE_TABLES, databaseEnvironmentVariableResourceType, findDatabaseByUuid, type ApiRow, type DeployEnvironmentVariableResourceRow, type EnvironmentVariableResourceType } from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, type CoolifyAnswer, type PhpObject } from "@saas/contracts/coolify-api";
import { environmentVariableContext } from "../handlers/environment-variables.js";
import { createVariable, saveVariable, storedValue, EnvironmentVariableError, type VariableChanges } from "../environment-variables/service.js";
import { lookupKey, normalizedKey, validateVariable, variableModel } from "./applications.js";
import { message, rowsOf, type ApiV1Context } from "./context.js";
import { rowValue } from "./models.js";
import { readApiBody, validationFailed } from "./request.js";

const NOT_FOUND = "Database not found.";
const ENV_FIELDS = ["key", "value", "is_literal", "is_multiline", "is_shown_once", "comment"] as const;
const ENV_FLAGS = ["is_literal", "is_multiline", "is_shown_once"];
/** What EnvironmentVariable::create() has just set besides the request's fields: the creating hook's version, the defaults, the uuid and the timestamps. */
const CREATED_DEFAULTS = ["version", "is_runtime", "is_buildtime", "uuid", "created_at", "updated_at"];

const denied = async (c: ApiV1Context, write: boolean, policyMessage?: string): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized(policyMessage));
/** PHP's truthiness of a request value. */
const phpTruthy = (v: unknown): boolean => !(v === undefined || v === null || v === false || v === 0 || v === "" || v === "0" || (Array.isArray(v) && v.length === 0));

interface Target {
  type: EnvironmentVariableResourceType;
  morphClass: string;
  id: unknown;
  resource: DeployEnvironmentVariableResourceRow;
}

/** `$request->uuid` (the list): the input before the route parameter. */
function param(c: ApiV1Context, route: string): unknown {
  const q = c.url.searchParams.get("uuid");
  return q !== null ? q : route;
}

/** queryDatabaseByUuidWithinTeam(), and the database as the variables' resource. */
async function target(tx: SqlExecutor, c: ApiV1Context, uuid: unknown): Promise<Target | null> {
  if (typeof uuid !== "string" && typeof uuid !== "number") return null;
  const db = await findDatabaseByUuid(tx, String(uuid));
  if (!db) return null;
  const type = databaseEnvironmentVariableResourceType(db.engine);
  const resource = await environmentVariableContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, type).store.findResource(db.uuid);
  return resource ? { type, morphClass: DATABASE_TABLES[db.engine].morphClass, id: db.id, resource } : null;
}

/** $database->environment_variables (no ORDER BY: the rows in id order, as they are stored). */
const variables = (tx: SqlExecutor, t: Target): Promise<ApiRow[]> => rowsOf(tx)("environment_variables", "t.resourceable_type = $1 AND t.resourceable_id = $2", [t.morphClass, t.id]);
const model = (tx: SqlExecutor, c: ApiV1Context, t: Target, row: ApiRow, created?: readonly string[]): Promise<PhpObject> => variableModel(tx, c, t.resource, row, false, created !== undefined, t.type, created ?? []);

/** routes/api.php's /databases/{uuid}/envs routes; null for any other path (the fallback 404). */
export async function databaseEnvsApi(c: ApiV1Context, uuid: string, segments: string[]): Promise<CoolifyAnswer | null> {
  const [third, extra] = segments;
  if (extra !== undefined) return null;
  const m = c.method;
  if (third === undefined) return m === "GET" ? listEnvs(c, uuid) : m === "POST" ? createEnv(c, uuid) : m === "PATCH" ? updateEnv(c, uuid) : null;
  if (third === "bulk" && m === "PATCH") return bulkEnvs(c, uuid);
  return m === "DELETE" ? deleteEnv(c, uuid, third) : null;
}

async function listEnvs(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const t = await target(tx, c, param(c, uuid));
    if (!t) return message(NOT_FOUND, 404);
    // authorize('view', $database)
    const no = await denied(c, false);
    if (no) return no;
    const out: PhpObject[] = [];
    for (const v of await variables(tx, t)) out.push(await model(tx, c, t, v));
    return coolifyJson(out);
  });
}

/** $database->environment_variables()->create([...]) with the fields the controller gives, the model's defaults for the rest. */
async function createDatabaseVariable(tx: SqlExecutor, c: ApiV1Context, t: Target, key: string, fields: Record<string, unknown>): Promise<ApiRow> {
  const ctx = environmentVariableContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, t.type);
  const flag = (k: string) => (k in fields ? phpTruthy(fields[k]) : false);
  const created = await createVariable(ctx, t.resource, {
    key,
    value: (fields.value as string | null | undefined) ?? null,
    comment: (fields.comment as string | null | undefined) ?? null,
    order: null,
    isPreview: false,
    isLiteral: flag("is_literal"),
    isMultiline: flag("is_multiline"),
    isShownOnce: flag("is_shown_once"),
    isRuntime: true,
    isBuildtime: true,
    isRequired: false,
  });
  return (await rowsOf(tx)("environment_variables", "t.id = $1", [created.id]))[0]!;
}

/** $env->value = …, is_literal, is_multiline, is_shown_once, comment as the request has them; saved, and read again. */
async function saveDatabaseVariable(tx: SqlExecutor, c: ApiV1Context, t: Target, row: ApiRow, fields: Record<string, unknown>): Promise<ApiRow> {
  const ctx = environmentVariableContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, t.type);
  const changes: VariableChanges = {};
  if ("value" in fields) changes.value = fields.value as string | null;
  if ("is_literal" in fields) changes.isLiteral = phpTruthy(fields.is_literal);
  if ("is_multiline" in fields) changes.isMultiline = phpTruthy(fields.is_multiline);
  if ("is_shown_once" in fields) changes.isShownOnce = phpTruthy(fields.is_shown_once);
  if ("comment" in fields) changes.comment = fields.comment as string | null;
  const env = Object.fromEntries(row) as never;
  await saveVariable(ctx, env, await storedValue(ctx, env), changes);
  return (await rowsOf(tx)("environment_variables", "t.id = $1", [rowValue(row, "id")]))[0]!;
}

function variableError(e: unknown): CoolifyAnswer {
  if (e instanceof EnvironmentVariableError) return e.field ? validationFailed([[e.field, [e.message]]]) : message(e.message, e.status);
  throw e;
}

async function createEnv(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  return c.sql(c.env, c.orgId, async (tx) => {
    const t = await target(tx, c, uuid);
    if (!t) return message(NOT_FOUND, 404);
    // authorize('manageEnvironment', $database)
    const no = await denied(c, true);
    if (no) return no;
    const all = normalizedKey(body.all);
    const errors = validateVariable(all, ENV_FLAGS);
    if (errors.length) return validationFailed(errors);
    const key = lookupKey(all.key);
    if ((await variables(tx, t)).some((v) => rowValue(v, "key") === key)) return message("Environment variable already exists. Use PATCH request to update it.", 409);
    try {
      const fields = { value: all.value ?? null, is_literal: all.is_literal ?? false, is_multiline: all.is_multiline ?? false, is_shown_once: all.is_shown_once ?? false, comment: all.comment ?? null };
      const created = await createDatabaseVariable(tx, c, t, key, fields);
      return coolifyJson(await model(tx, c, t, created, ["key", ...Object.keys(fields), ...CREATED_DEFAULTS]), 201);
    } catch (e) {
      return variableError(e);
    }
  });
}

async function updateEnv(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  return c.sql(c.env, c.orgId, async (tx) => {
    const t = await target(tx, c, uuid);
    if (!t) return message(NOT_FOUND, 404);
    const no = await denied(c, true);
    if (no) return no;
    const all = normalizedKey(body.all);
    const errors = validateVariable(all, ENV_FLAGS);
    if (errors.length) return validationFailed(errors);
    const found = (await variables(tx, t)).find((v) => rowValue(v, "key") === lookupKey(all.key));
    if (!found) return message("Environment variable not found.", 404);
    try {
      return coolifyJson(await model(tx, c, t, await saveDatabaseVariable(tx, c, t, found, all)), 201);
    } catch (e) {
      return variableError(e);
    }
  });
}

/** create_bulk_envs: each item's fields validated, then updated (the key exists) or created, in order; an invalid item stops there. */
async function bulkEnvs(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  return c.sql(c.env, c.orgId, async (tx) => {
    const t = await target(tx, c, uuid);
    if (!t) return message(NOT_FOUND, 404);
    const no = await denied(c, true);
    if (no) return no;
    const data = body.all.data;
    if (!phpTruthy(data)) return message("Bulk data is required.", 400);
    const items = (Array.isArray(data) ? data : typeof data === "object" && data !== null ? Object.values(data) : [data]).map((item) => {
      const fields = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
      return normalizedKey(Object.fromEntries(Object.entries(fields).filter(([k]) => (ENV_FIELDS as readonly string[]).includes(k))));
    });
    const out: PhpObject[] = [];
    for (const item of items) {
      const errors = validateVariable(item, ENV_FLAGS);
      if (errors.length) return validationFailed(errors);
      const key = lookupKey(item.key);
      const existing = (await variables(tx, t)).find((v) => rowValue(v, "key") === key);
      try {
        if (existing) out.push(await model(tx, c, t, await saveDatabaseVariable(tx, c, t, existing, item)));
        else {
          const fields = Object.fromEntries(Object.entries(item).filter(([k]) => k !== "key"));
          out.push(await model(tx, c, t, await createDatabaseVariable(tx, c, t, key, fields), ["key", ...Object.keys(fields), ...CREATED_DEFAULTS]));
        }
      } catch (e) {
        return variableError(e);
      }
    }
    return coolifyJson(out, 201);
  });
}

async function deleteEnv(c: ApiV1Context, uuid: string, envUuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const t = await target(tx, c, uuid);
    if (!t) return message(NOT_FOUND, 404);
    const no = await denied(c, true);
    if (no) return no;
    const found = (await variables(tx, t)).find((v) => rowValue(v, "uuid") === envUuid);
    if (!found) return message("Environment variable not found.", 404);
    // $env->forceDelete()
    await environmentVariableContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, t.type).store.delete([rowValue(found, "id") as string | number]);
    return message("Environment variable deleted.", 200);
  });
}
