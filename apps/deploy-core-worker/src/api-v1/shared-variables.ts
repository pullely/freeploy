// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/SharedEnvironmentVariablesController.php
// (removeSensitiveData, validateEnvPayload, findEnvInScope, keyExistsInScope, listEnvs, createEnv, updateEnv, deleteEnv,
// resolveProject, resolveEnvironment, project_envs, project_create_env, project_update_env, project_delete_env,
// environment_envs, environment_create_env, environment_update_env, environment_delete_env),
// app/Models/SharedEnvironmentVariable.php ($hidden, $casts, the saving hook, the key's mutator) and
// app/Support/ValidationPatterns.php (normalizeEnvironmentVariableKey, environmentVariableKeyRules,
// rejectNulByteInEnvironmentVariableValue) (Apache-2.0), modified.
//
// Coolify's /api/v1 for the shared variables of a project and of an environment (DP-81) and of the team (DP-84: team_envs,
// team_create_env, team_update_env, team_delete_env), on the shared variable store the console's Shared Variables pages
// use (packages/db's deploy/shared-variables.ts); the value is the `encrypted` cast's column
// ("shared_environment_variables.value"). A server's shared variables (/servers/{uuid}/envs) are other routes, not
// ported here.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  deleteSharedVariable,
  insertSharedVariable,
  updateSharedVariable,
  type ApiRow,
  type SharedVariableChanges,
  type SharedVariableOwner,
} from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, obj, serializeApiResponse, type CoolifyAnswer, type PhpObject } from "@saas/contracts/coolify-api";
import { columnCipher } from "../handlers/cloud-tokens.js";
import { ENVIRONMENT_VARIABLE_KEY_PATTERN, normalizeEnvironmentVariableKey } from "../environment-variables/validation.js";
import { decryptColumn, message, rowsOf, type ApiV1Context, type Rows } from "./context.js";
import { rowValue, toModel, type ModelShape } from "./models.js";
import { addError, readApiBody, requestBoolean, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rules } from "./rules.js";

const ALLOWED_FIELDS = ["key", "value", "is_literal", "is_multiline", "is_shown_once", "comment"];
const VALUE_COLUMN = "shared_environment_variables.value";
/** $hidden (value) with removeSensitiveData()'s makeHidden(); the team is Freeploy's org_id, which a row never carries. */
const SHARED_VARIABLE: ModelShape = { hidden: ["value", "team_id", "project_id", "environment_id", "server_id", "version"], dates: ["created_at", "updated_at"] };

type Scope = { type: "team" } | { type: "project" | "environment"; id: unknown };
const ownerOf = (scope: Scope): SharedVariableOwner => (scope.type === "team" ? { type: "team", id: null } : { type: scope.type, id: scope.id as string | number });
/**
 * findEnvInScope() and listEnvs(): the scope's column ($n, appended to params); the team's variables have none.
 * keyExistsInScope() (`forKey`): the scope's column, and every other one null.
 */
function inScope(scope: Scope, params: unknown[], forKey = false): string {
  if (scope.type === "team") return forKey ? "t.project_id IS NULL AND t.environment_id IS NULL AND t.server_id IS NULL" : "TRUE";
  params.push(scope.id);
  return `t.${scope.type === "project" ? "project_id" : "environment_id"} = $${params.length}`;
}

const denied = async (c: ApiV1Context, write: boolean): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized());
/** PHP's (string) cast of a request value. */
const phpString = (v: unknown): string => (v === true ? "1" : v === false || v === null || v === undefined ? "" : typeof v === "number" ? String(v) : typeof v === "string" ? v : "Array");

/**
 * The /projects/{uuid}/envs and /projects/{uuid}/environments/{environment_name_or_uuid}/envs routes. `environment` is
 * the environment's name or uuid, or undefined for the project's own variables; `rest` follows /envs.
 */
export async function sharedVariablesApi(c: ApiV1Context, projectUuid: string, environment: string | undefined, rest: string[]): Promise<CoolifyAnswer | null> {
  const [envId, extra] = rest;
  if (extra !== undefined) return null;
  const m = c.method;
  if (envId === undefined && m !== "GET" && m !== "POST") return null;
  if (envId !== undefined && m !== "PATCH" && m !== "DELETE") return null;
  const body = m === "POST" || m === "PATCH" ? await readApiBody(c.request) : null;
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    // resolveProject(): Project::whereTeamId()->whereUuid()->first()
    const project = (await rows("projects", "t.uuid = $1", [projectUuid]))[0];
    if (!project) return message("Project not found.", 404);
    let scope: Scope = { type: "project", id: rowValue(project, "id") };
    if (environment !== undefined) {
      // resolveEnvironment(): the project's environment by name, then by uuid.
      const env =
        (await rows("environments", "t.project_id = $1 AND t.name = $2", [rowValue(project, "id"), environment]))[0] ??
        (await rows("environments", "t.project_id = $1 AND t.uuid = $2", [rowValue(project, "id"), environment]))[0];
      if (!env) return message("Environment not found.", 404);
      scope = { type: "environment", id: rowValue(env, "id") };
    }
    if (envId === undefined && m === "GET") {
      // viewSharedVariables
      const no = await denied(c, false);
      return no ?? listEnvs(tx, c, rows, scope);
    }
    if (envId === undefined) {
      // authorize('update', $project | $environment)
      const no = await denied(c, true);
      return no ?? createEnv(tx, c, rows, scope, body!.incomingError, body!.all);
    }
    // authorize('view', $project | $environment)
    const no = await denied(c, false);
    if (no) return no;
    const row = await findEnvInScope(rows, scope, envId);
    if (!row) return message("Environment variable not found.", 404);
    // authorize('update' | 'delete', $env)
    const no2 = await denied(c, true);
    if (no2) return no2;
    if (m === "DELETE") {
      await deleteSharedVariable(tx, rowValue(row, "id") as string | number);
      return message("Environment variable deleted.", 200);
    }
    return updateEnv(tx, c, rows, scope, row, body!.incomingError, body!.all);
  });
}

/**
 * The /team/envs routes (DP-84): team_envs (viewSharedVariables of the team), team_create_env (the payload validated,
 * then authorize('create', SharedEnvironmentVariable::class)), team_update_env and team_delete_env (the variable found,
 * then the policy). `rest` follows /envs.
 */
export async function teamSharedVariablesApi(c: ApiV1Context, rest: string[]): Promise<CoolifyAnswer | null> {
  const [envId, extra] = rest;
  if (extra !== undefined) return null;
  const m = c.method;
  if (envId === undefined && m !== "GET" && m !== "POST") return null;
  if (envId !== undefined && m !== "PATCH" && m !== "DELETE") return null;
  const body = m === "POST" || m === "PATCH" ? await readApiBody(c.request) : null;
  const scope: Scope = { type: "team" };
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    if (envId === undefined && m === "GET") return (await denied(c, false)) ?? listEnvs(tx, c, rows, scope);
    if (envId === undefined) return createEnv(tx, c, rows, scope, body!.incomingError, body!.all, () => denied(c, true));
    const row = await findEnvInScope(rows, scope, envId);
    if (!row) return message("Environment variable not found.", 404);
    const no = await denied(c, true);
    if (no) return no;
    if (m === "DELETE") {
      await deleteSharedVariable(tx, rowValue(row, "id") as string | number);
      return message("Environment variable deleted.", 200);
    }
    return updateEnv(tx, c, rows, scope, row, body!.incomingError, body!.all);
  });
}

/** findEnvInScope(): the variable of this type and scope with the id. */
async function findEnvInScope(rows: Rows, scope: Scope, envId: string): Promise<ApiRow | undefined> {
  const params: unknown[] = [scope.type, envId];
  return (await rows("shared_environment_variables", `t.type = $1 AND t.id = $2 AND ${inScope(scope, params)}`, params))[0];
}

/** removeSensitiveData(): the value for a token that may read secrets, never for a locked variable; then serializeApiResponse(). */
async function serialize(tx: SqlExecutor, c: ApiV1Context, row: ApiRow): Promise<PhpObject> {
  const showValue = c.canReadSensitive && rowValue(row, "is_shown_once") !== true;
  const decrypted: ApiRow = showValue ? row.map(([k, v]) => [k, v] as [string, unknown]) : row;
  if (showValue) {
    const at = decrypted.findIndex(([k]) => k === "value");
    decrypted[at] = ["value", await decryptColumn(tx, c, "shared_environment_variables", "value", rowValue(row, "value"))];
  }
  return serializeApiResponse(toModel(decrypted, SHARED_VARIABLE, { visible: showValue ? ["value"] : [] }));
}

async function listEnvs(tx: SqlExecutor, c: ApiV1Context, rows: Rows, scope: Scope): Promise<CoolifyAnswer> {
  const params: unknown[] = [scope.type];
  const list = await rows("shared_environment_variables", `t.type = $1 AND ${inScope(scope, params)}`, params);
  const out: PhpObject[] = [];
  for (const row of list) out.push(await serialize(tx, c, row));
  return coolifyJson(out);
}

const rules = (requireKey: boolean): Rules => [
  ["key", [requireKey ? "required" : "nullable", "string", "max:255", { regex: ENVIRONMENT_VARIABLE_KEY_PATTERN }]],
  ["value", ["string", "nullable"]],
  ["is_literal", ["boolean"]],
  ["is_multiline", ["boolean"]],
  ["is_shown_once", ["boolean"]],
  ["comment", ["string", "nullable", "max:256"]],
];

/** validateEnvPayload(): validateIncomingRequest(), the key normalized, customApiValidator()'s rules, only the allowed fields. */
async function validateEnvPayload(incomingError: CoolifyAnswer | null, input: Record<string, unknown>, requireKey: boolean): Promise<{ all: Record<string, unknown> } | CoolifyAnswer> {
  if (incomingError) return incomingError;
  const all = "key" in input ? { ...input, key: normalizeEnvironmentVariableKey(phpString(input.key)) } : input;
  const errors: Errors = [];
  await validateRules(errors, all, rules(requireKey));
  for (const k of Object.keys(all)) if (!ALLOWED_FIELDS.includes(k)) addError(errors, k, "This field is not allowed.");
  if (errors.length) return validationFailed(errors);
  if (!requireKey && Object.keys(all).length === 0) return message("At least one field must be provided.", 422);
  return { all };
}

/** keyExistsInScope(): the key among the scope's variables (another one's when updating). */
async function keyExists(rows: Rows, scope: Scope, key: string, exceptId: unknown = null): Promise<boolean> {
  const params: unknown[] = [scope.type, key];
  const found = await rows("shared_environment_variables", `t.type = $1 AND t.key = $2 AND ${inScope(scope, params, true)}`, params);
  return found.some((r) => exceptId === null || String(rowValue(r, "id")) !== String(exceptId));
}

/** The NUL check of the model's saving hook (ValidationPatterns::rejectNulByteInEnvironmentVariableValue). */
const nulRejected = (): CoolifyAnswer => coolifyJson(obj({ message: "The value cannot contain a NUL character.", errors: obj({ value: ["The value cannot contain a NUL character."] }) }), 422);

const encrypt = (tx: SqlExecutor, c: ApiV1Context, value: unknown): Promise<string> => columnCipher(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, VALUE_COLUMN).encrypt(value as string);

/** `authorize`: the team's and a server's policy, which createEnv() asks after the payload is validated. */
async function createEnv(tx: SqlExecutor, c: ApiV1Context, rows: Rows, scope: Scope, incomingError: CoolifyAnswer | null, input: Record<string, unknown>, authorize?: () => Promise<CoolifyAnswer | null>): Promise<CoolifyAnswer> {
  const validated = await validateEnvPayload(incomingError, input, true);
  if (!("all" in validated)) return validated;
  const no = authorize ? await authorize() : null;
  if (no) return no;
  const all = validated.all;
  const key = all.key as string;
  if (await keyExists(rows, scope, key)) return message("Environment variable already exists. Use PATCH request to update it.", 409);
  if (typeof all.value === "string" && all.value.includes("\0")) return nulRejected();
  const created = await insertSharedVariable(tx, {
    orgId: c.orgId,
    owner: ownerOf(scope),
    key,
    // A null value is the column's NOT NULL refusal, Coolify's 500, as it is there.
    value: all.value === null || all.value === undefined ? (null as unknown as string) : await encrypt(tx, c, all.value),
    comment: (all.comment as string | null | undefined) ?? null,
    isLiteral: requestBoolean(all, "is_literal"),
    isMultiline: requestBoolean(all, "is_multiline"),
    isShownOnce: requestBoolean(all, "is_shown_once"),
  });
  return coolifyJson(obj({ id: Number(created.id) }), 201);
}

async function updateEnv(tx: SqlExecutor, c: ApiV1Context, rows: Rows, scope: Scope, row: ApiRow, incomingError: CoolifyAnswer | null, input: Record<string, unknown>): Promise<CoolifyAnswer> {
  const validated = await validateEnvPayload(incomingError, input, false);
  if (!("all" in validated)) return validated;
  const all = validated.all;
  const id = rowValue(row, "id") as string | number;
  const changes: SharedVariableChanges = {};
  if ("key" in all && all.key !== rowValue(row, "key")) {
    if (await keyExists(rows, scope, all.key as string, id)) return message("Environment variable already exists with this key.", 409);
    changes.key = all.key as string;
  }
  if ("value" in all) {
    if (typeof all.value === "string" && all.value.includes("\0")) return nulRejected();
    const current = await decryptColumn(tx, c, "shared_environment_variables", "value", rowValue(row, "value"));
    // The encrypted cast compares the decrypted values: the same value is not a change.
    if (all.value !== current) changes.value = all.value === null ? (null as unknown as string) : await encrypt(tx, c, all.value);
  }
  const flag = (field: "is_literal" | "is_multiline" | "is_shown_once", property: "isLiteral" | "isMultiline" | "isShownOnce") => {
    if (field in all && requestBoolean(all, field) !== rowValue(row, field)) changes[property] = requestBoolean(all, field);
  };
  flag("is_literal", "isLiteral");
  flag("is_multiline", "isMultiline");
  flag("is_shown_once", "isShownOnce");
  if ("comment" in all && all.comment !== rowValue(row, "comment")) changes.comment = all.comment as string | null;
  // $env->save(): nothing is written (updated_at neither) when nothing changed; a lock stays (the saving hook).
  if (Object.keys(changes).length) await updateSharedVariable(tx, id, changes);
  const fresh = (await rows("shared_environment_variables", "t.id = $1", [id]))[0]!;
  return coolifyJson(await serialize(tx, c, fresh));
}
