// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/ApplicationsController.php (applications,
// application_by_uuid, logs_by_uuid, delete_by_uuid, envs, create_env, update_env_by_uuid, create_bulk_envs,
// delete_env_by_uuid, action_deploy, action_stop, action_restart, removeSensitiveData), app/Http/Controllers/
// Api/OtherController.php (post_required), app/Models/{Application,EnvironmentVariable}.php ($hidden, $appends,
// serverStatus, the relations the serializer writes) and bootstrap/helpers/api.php (redactLockedApiResourceValues)
// (Apache-2.0), modified.
//
// Coolify's /api/v1 for applications and their environment variables (DP-71), on the services the console's
// routes use: an application is deleted by the Danger Zone's deleteApplicationNow(), a variable is created and
// saved by the Environment Variables page's createVariable() and saveVariable() (the model's hooks: the preview
// copy, the lock, the NUL check). Starting, stopping, restarting and the container logs run on the server:
// they answer 501 in Coolify's envelope until the SSH executor exists (DP-70's convention).
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { APPLICATION_MORPH_CLASS, type ApiRow, type DeployEnvironmentVariableResourceRow, type DeployEnvironmentVariableRow } from "@saas/db/deploy";
import { coolifyJson, obj, put, serializeApiResponse, type CoolifyAnswer, type PhpObject, type PhpValue } from "@saas/contracts/coolify-api";
import { applicationResourcesContext } from "../handlers/application-resources.js";
import { environmentVariableContext } from "../handlers/environment-variables.js";
import { deleteApplicationNow, deleteOptions } from "../applications/danger.js";
import { SettingsError } from "../applications/settings.js";
import { APPLICATION_SERVICE_MESSAGES, networkAliasesForForm } from "../applications/service.js";
import { base64Decode } from "../applications/build.js";
import { needsExecutor } from "../applications/resources.js";
import { createVariable, realValue, saveVariable, storedValue, type VariableChanges } from "../environment-variables/service.js";
import { EnvironmentVariableError } from "../environment-variables/service.js";
import { ENVIRONMENT_VARIABLE_KEY_PATTERN, normalizeEnvironmentVariableKey } from "../environment-variables/validation.js";
import { redactLockedValues } from "../services/configuration.js";
import { isFunctional } from "../servers/service.js";
import { LARAVEL } from "../servers/settings-validation.js";
import { COOLIFY_API } from "@saas/contracts/coolify-api";
import { decryptColumn, message, rowsOf, unavailable, type ApiV1Context, type Rows } from "./context.js";
import { inCoolifyOrder } from "./columns.js";
import {
  APPLICATION,
  APPLICATION_SENSITIVE,
  APPLICATION_SETTING,
  APPLICATION_WEBHOOK_SECRETS,
  DESTINATION,
  ENVIRONMENT_VARIABLE,
  SERVER,
  SERVER_SETTING,
  rowValue,
  toModel,
} from "./models.js";
import { addError, readApiBody, validationFailed, type ApiBody, type Errors } from "./request.js";

export const APPLICATIONS_API_MESSAGES = {
  /** Freeploy's: getContainerLogs() runs docker logs on the server. */
  logsUnavailable: needsExecutor("Reading the application's container logs"),
} as const;

const SWARM_DOCKER = "App\\Models\\SwarmDocker";
const ENV_FIELDS = ["key", "value", "is_preview", "is_literal", "is_multiline", "is_shown_once", "is_runtime", "is_buildtime", "comment"] as const;
const ENV_FLAGS = ["is_literal", "is_multiline", "is_shown_once", "is_runtime", "is_buildtime"] as const;
/** The columns envs() hides beside removeSensitiveData()'s. */
const ENV_LIST_HIDDEN = ["service_id", "standalone_clickhouse_id", "standalone_dragonfly_id", "standalone_keydb_id", "standalone_mariadb_id", "standalone_mongodb_id", "standalone_mysql_id", "standalone_postgresql_id", "standalone_redis_id"];

/** PHP's truthiness of a request value (`$request->is_preview ?? false`, then a boolean cast). */
const phpBool = (v: unknown): boolean => !(v === undefined || v === null || v === false || v === 0 || v === "" || v === "0" || (Array.isArray(v) && v.length === 0));

/**
 * routes/api.php's /applications routes. segments: what follows /applications. Null when the path is not one
 * of them (the caller answers the fallback 404).
 */
export async function applicationsApi(c: ApiV1Context, segments: string[]): Promise<CoolifyAnswer | null> {
  const [uuid, sub, third, fourth] = segments;
  const m = c.method;
  if (fourth !== undefined) return null;
  if (uuid === undefined) return m === "GET" ? listApplications(c) : null;
  if (sub === undefined) {
    if (m === "GET") return showApplication(c, uuid);
    if (m === "DELETE") return deleteApplication(c, uuid);
    return null;
  }
  if (sub === "envs") {
    if (third === undefined) return m === "GET" ? listVariables(c, uuid) : m === "POST" ? createEnv(c, uuid) : m === "PATCH" ? updateEnv(c, uuid) : null;
    if (third === "bulk" && m === "PATCH") return bulkEnvs(c, uuid);
    return m === "DELETE" ? deleteEnv(c, uuid, third) : null;
  }
  if (third !== undefined) return null;
  if (sub === "logs" && m === "GET") return logs(c, uuid);
  if (sub === "start" || sub === "restart" || sub === "stop") {
    // OtherController::post_required()
    if (m === "GET") return message("This endpoint has changed to a POST request.", 405);
    if (m === "POST") return action(c, uuid, sub);
  }
  return null;
}

// ── reading ─────────────────────────────────────────────────────────────────

/** Application::ownedByCurrentTeamAPI(): the org's applications not deleted (row-level security confines them to the org). */
async function applicationRow(rows: Rows, uuid: string): Promise<ApiRow | null> {
  return (await rows("applications", "t.deleted_at IS NULL AND t.uuid = $1", [uuid]))[0] ?? null;
}

const denied = async (c: ApiV1Context, write: boolean): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized());

/** A server row as Eloquent's toArray() writes a loaded relation: Coolify's column order, team_id, is_coolify_host, then its loaded settings. */
export function nestedServer(c: ApiV1Context, server: ApiRow, settings: ApiRow | undefined): PhpObject {
  const visible = c.canReadSensitive ? ["logdrain_axiom_api_key", "logdrain_newrelic_license_key"] : [];
  const model = toModel(inCoolifyOrder([...server, ["team_id", c.orgPublicId]], "servers"), SERVER, { visible, extra: [["is_coolify_host", rowValue(server, "id") === 0]] });
  const settingsVisible = c.canReadSensitive ? ["sentinel_token", "sentinel_custom_url", "logdrain_newrelic_license_key", "logdrain_axiom_api_key", "logdrain_custom_config", "logdrain_custom_config_parser"] : [];
  put(model, "settings", settings ? toModel(inCoolifyOrder(settings, "server_settings"), SERVER_SETTING, { visible: settingsVisible }) : null);
  return model;
}

interface Loaded {
  destination: ApiRow | null;
  server: ApiRow | null;
  serverSettings: ApiRow | undefined;
  additional: Array<{ pivot: ApiRow; server: ApiRow; settings: ApiRow | undefined }>;
}

async function loadRelations(rows: Rows, row: ApiRow): Promise<Loaded> {
  // A Swarm destination (Freeploy creates none: Swarm is deprecated) is not loaded.
  const destination = rowValue(row, "destination_type") === SWARM_DOCKER ? null : ((await rows("standalone_dockers", "t.id = $1", [rowValue(row, "destination_id")]))[0] ?? null);
  const server = destination ? ((await rows("servers", "t.deleted_at IS NULL AND t.id = $1", [rowValue(destination, "server_id")]))[0] ?? null) : null;
  const serverSettings = server ? (await rows("server_settings", "t.server_id = ANY($1)", [[rowValue(server, "id")]]))[0] : undefined;
  const pivots = await rows("additional_destinations", "t.application_id = $1", [rowValue(row, "id")]);
  const additional: Loaded["additional"] = [];
  for (const pivot of pivots) {
    const s = (await rows("servers", "t.deleted_at IS NULL AND t.id = $1", [rowValue(pivot, "server_id")]))[0];
    if (s) additional.push({ pivot, server: s, settings: (await rows("server_settings", "t.server_id = ANY($1)", [[rowValue(s, "id")]]))[0] });
  }
  return { destination, server, serverSettings, additional };
}

export const functional = (server: ApiRow | null, settings: ApiRow | undefined): boolean =>
  server !== null && settings !== undefined && isFunctional({ is_reachable: rowValue(settings, "is_reachable") as boolean, is_usable: rowValue(settings, "is_usable") as boolean, force_disabled: rowValue(settings, "force_disabled") as boolean, ip: rowValue(server, "ip") as string });

/**
 * removeSensitiveData($application): toArray() — the columns but the hidden ones (made visible for a token that
 * may read secrets, the encrypted ones decrypted; private_key_id hidden from the others), the global scope's
 * counts, server_status and the relations it loaded (destination.server.settings, additional_servers), and
 * the settings when the caller loaded them — then serializeApiResponse() and the locked values redacted from
 * the generated Compose file.
 */
async function applicationModel(tx: SqlExecutor, c: ApiV1Context, row: ApiRow, withSettings: boolean): Promise<PhpObject> {
  const rows = rowsOf(tx);
  const sensitive = c.canReadSensitive;
  const l = await loadRelations(rows, row);
  const base = row.filter(([k]) => k !== "id" && !(k === "private_key_id" && !sensitive));
  const decrypted: ApiRow = [];
  if (sensitive) for (const column of [...APPLICATION_WEBHOOK_SECRETS, "http_basic_auth_password"]) decrypted.push([column, await decryptColumn(tx, c, "applications", column, rowValue(row, column))]);
  const visible = sensitive ? APPLICATION_SENSITIVE : [];
  const additionalServers = l.additional.map(({ pivot, server, settings }) => {
    const s = nestedServer(c, server, settings);
    put(s, "pivot", obj({ application_id: rowValue(row, "id") as PhpValue, server_id: rowValue(server, "id") as PhpValue, standalone_docker_id: rowValue(pivot, "standalone_docker_id") as PhpValue, status: rowValue(pivot, "status") as PhpValue }));
    return s;
  });
  const destination = l.destination ? toModel(inCoolifyOrder(l.destination, "standalone_dockers"), DESTINATION, { extra: [["server", l.server ? nestedServer(c, l.server, l.serverSettings) : null]] }) : null;
  const serverStatus = functional(l.server, l.serverSettings) && l.additional.every((a) => functional(a.server, a.settings));
  const extra: Array<[string, PhpValue]> = [
    ...decrypted.map(([k, v]): [string, PhpValue] => [k, v as PhpValue]),
    ["additional_networks_count", l.additional.length],
    ["additional_servers_count", l.additional.length],
    ["server_status", serverStatus],
    ["additional_servers", additionalServers],
    ["destination", destination],
  ];
  if (withSettings) {
    const settings = (await rows("application_settings", "t.application_id = $1", [rowValue(row, "id")]))[0];
    extra.push(["settings", settings ? toModel(inCoolifyOrder(settings, "application_settings"), APPLICATION_SETTING) : null]);
  }
  // The accessors toArray() reads the columns through: status, custom_network_aliases, custom_nginx_configuration.
  extra.push(["status", statusAccessor(rowValue(row, "status") as string | null, l.additional.map((a) => rowValue(a.pivot, "status") as string | null))]);
  extra.push(["custom_network_aliases", networkAliasesForForm(rowValue(row, "custom_network_aliases") as string | null)]);
  if (sensitive) {
    const nginx = rowValue(row, "custom_nginx_configuration");
    extra.push(["custom_nginx_configuration", nginx === null || nginx === undefined ? null : base64Decode(String(nginx))]);
  }
  const out = serializeApiResponse(toModel(base, APPLICATION, { visible, extra }), sensitive);
  // redactLockedApiResourceValues()
  const compose = out.entries.find(([k]) => k === "docker_compose")?.[1];
  if (typeof compose === "string" && compose.trim() !== "") put(out, "docker_compose", redactLockedValues(compose, await lockedValues(tx, c, row)));
  return out;
}

/** "running (healthy)" or "running:healthy" as "running:healthy"; a status without a health is unhealthy. */
function statusParts(value: string | null): [string, string] {
  const v = value ?? "";
  if (v.includes("(")) return [v.slice(0, v.indexOf("(")).trim(), v.slice(v.indexOf("(") + 1).split(")")[0]!.trim()];
  if (v.includes(":")) return [v.slice(0, v.indexOf(":")).trim(), v.slice(v.indexOf(":") + 1).trim()];
  return [v, "unhealthy"];
}

/** The status accessor: with additional servers, "degraded" when a server's status differs, "unhealthy" when its health does. */
function statusAccessor(value: string | null, additional: Array<string | null>): string {
  if (additional.length === 0) {
    const [status, health] = statusParts(value);
    return `${status}:${health}`;
  }
  const v = value ?? "";
  const main = v.includes(":") ? v.slice(0, v.indexOf(":")) : v;
  const mainHealth = v.includes(":") ? v.slice(v.indexOf(":") + 1) : "";
  let status = main;
  let health = mainHealth;
  for (const s of additional) {
    const text = s ?? "";
    const serverStatus = text.includes(":") ? text.slice(0, text.indexOf(":")) : text;
    const serverHealth = text.includes(":") ? text.slice(text.indexOf(":") + 1) : null;
    if (main !== serverStatus) status = "degraded";
    if (serverHealth !== null && mainHealth !== serverHealth) health = "unhealthy";
  }
  return `${status}:${health}`;
}

/** The decrypted values of the application's locked variables (EnvironmentVariable::logRedactionSecretsFor()['locked']). */
async function lockedValues(tx: SqlExecutor, c: ApiV1Context, row: ApiRow): Promise<string[]> {
  const vars = await rowsOf(tx)("environment_variables", "t.resourceable_type = $1 AND t.resourceable_id = $2 AND t.is_shown_once", [APPLICATION_MORPH_CLASS, rowValue(row, "id")]);
  const out: string[] = [];
  for (const v of vars) {
    const value = await decryptColumn(tx, c, "environment_variables", "value", rowValue(v, "value"));
    if (value) out.push(value);
  }
  return out;
}

async function listApplications(c: ApiV1Context): Promise<CoolifyAnswer> {
  const tag = c.url.searchParams.get("tag");
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const where = ["t.deleted_at IS NULL"];
    const params: unknown[] = [];
    // ->when($tagName, whereHas('tags', name = $tagName))
    if (tag) {
      params.push(APPLICATION_MORPH_CLASS, tag);
      where.push("t.id IN (SELECT tg.taggable_id FROM deploy.taggables tg JOIN deploy.tags tag ON tag.id = tg.tag_id WHERE tg.taggable_type = $1 AND tag.name = $2)");
    }
    // ->orderBy('name'), in the database's collation
    const list = await rows("applications", where.join(" AND "), params, "name");
    const out: PhpObject[] = [];
    for (const row of list) out.push(await applicationModel(tx, c, row, false));
    return coolifyJson(out);
  });
}

async function showApplication(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const row = await applicationRow(rowsOf(tx), uuid);
    if (!row) return message("Application not found.", 404);
    const no = await denied(c, false);
    if (no) return no;
    return coolifyJson(await applicationModel(tx, c, row, true));
  });
}

async function logs(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    if (!(await applicationRow(rowsOf(tx), uuid))) return message("Application not found.", 404);
    return (await denied(c, false)) ?? unavailable(APPLICATIONS_API_MESSAGES.logsUnavailable);
  });
}

/** action_deploy, action_restart, action_stop: the deploy ability is policy-worker's write. */
async function action(c: ApiV1Context, uuid: string, which: "start" | "restart" | "stop"): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    if (!(await applicationRow(rowsOf(tx), uuid))) return message("Application not found.", 404);
    const no = await denied(c, true);
    if (no) return no;
    const text = { start: APPLICATION_SERVICE_MESSAGES.deployUnavailable, restart: APPLICATION_SERVICE_MESSAGES.restartUnavailable, stop: APPLICATION_SERVICE_MESSAGES.stopUnavailable }[which];
    return unavailable(text);
  });
}

/**
 * delete_by_uuid: the Danger Zone's delete with Coolify's query fields. Coolify soft-deletes the row and queues
 * DeleteResourceJob; Freeploy removes the rows of an application that has nothing on a server at once and
 * answers 501 for any other (deleteApplicationNow()).
 */
async function deleteApplication(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    if (!(await applicationRow(rowsOf(tx), uuid))) return message("Application not found", 404);
    const no = await denied(c, true);
    if (no) return no;
    try {
      await deleteApplicationNow(applicationResourcesContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY), uuid, deleteOptions(c.url.searchParams));
    } catch (e) {
      if (e instanceof SettingsError) return unavailable(e.message);
      throw e;
    }
    return message("Application deletion request queued.", 200);
  });
}

// ── environment variables ───────────────────────────────────────────────────

type EnvRow = DeployEnvironmentVariableRow;
type EnvResource = DeployEnvironmentVariableResourceRow;

/**
 * The attributes of a variable EnvironmentVariable::create() has just made: what create_bulk_envs gave it, the
 * creating hook's version, the uuid and the timestamps. The model is not read again, so the columns the
 * database defaulted are not among them.
 */
const CREATED_VARIABLE_COLUMNS = ["key", "value", "is_preview", "is_literal", "is_multiline", "is_shown_once", "is_runtime", "is_buildtime", "comment", "version", "uuid", "created_at", "updated_at"];

/**
 * removeSensitiveData($env): the columns and appends, value and real_value only for a token that may read secrets and never for a locked variable.
 * `created`: the attributes of a variable just made (the model is not read again), DP-71's for an application's; a
 * service's (DP-74) are what its controller gave.
 */
export async function variableModel(tx: SqlExecutor, c: ApiV1Context, resource: EnvResource, row: ApiRow, hideListColumns: boolean, justCreated = false, kind: "application" | "service" = "application", created: readonly string[] = CREATED_VARIABLE_COLUMNS): Promise<PhpObject> {
  const ctx = environmentVariableContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, kind);
  const value = await storedValue(ctx, { value: rowValue(row, "value") as string | null });
  const key = String(rowValue(row, "key"));
  const locked = rowValue(row, "is_shown_once") === true;
  const showValues = c.canReadSensitive && !locked;
  const hidden = ["id", "resourceable_id", "resourceable_type", ...(hideListColumns ? ENV_LIST_HIDDEN : [])];
  const base = row.filter(([k]) => !hidden.includes(k) && (!justCreated || created.includes(k)));
  const isRequired = !justCreated && rowValue(row, "is_required") === true;
  const revealed = isRequired ? await realValue(ctx, resource, value, true) : null;
  const extra: Array<[string, PhpValue]> = [
    ["is_shared", isSharedReference(value)],
    ["is_really_required", isRequired && (revealed ?? "") === ""],
    ["is_buildpack_control", key.startsWith("NIXPACKS_") || key.startsWith("RAILPACK_")],
    ["is_coolify", key.startsWith("SERVICE_")],
  ];
  const visible: string[] = [];
  if (showValues) {
    visible.push("value", "real_value");
    extra.unshift(["value", value], ["real_value", await realValue(ctx, resource, value, false)]);
  }
  return serializeApiResponse(toModel(base, ENVIRONMENT_VARIABLE, { visible, extra }), c.canReadSensitive);
}

/** EnvironmentVariable::isSharedReference() */
function isSharedReference(value: string | null): boolean {
  if (value === null || value.trim() === "") return false;
  return /^\{\{\s*(?:team|project|environment|server)\..*\}\}$/s.test(value.trim());
}

async function variableRows(tx: SqlExecutor, applicationId: unknown, isPreview: boolean | null): Promise<ApiRow[]> {
  const preview = isPreview === null ? "" : ` AND t.is_preview = ${isPreview ? "true" : "false"}`;
  return rowsOf(tx)("environment_variables", `t.resourceable_type = $1 AND t.resourceable_id = $2${preview}`, [APPLICATION_MORPH_CLASS, applicationId]);
}

export async function variableResource(tx: SqlExecutor, c: ApiV1Context, uuid: string): Promise<EnvResource | null> {
  return environmentVariableContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, "application").store.findResource(uuid);
}

/** The row as the service's store reads it (the same row, its typed columns). */
const asEnvRow = (row: ApiRow): EnvRow => Object.fromEntries(row) as EnvRow;

async function listVariables(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const row = await applicationRow(rowsOf(tx), uuid);
    const resource = row ? await variableResource(tx, c, uuid) : null;
    if (!row || !resource) return message("Application not found", 404);
    const no = await denied(c, false);
    if (no) return no;
    // environment_variables->sortBy('id')->merge(environment_variables_preview->sortBy('id'))
    const list = [...(await variableRows(tx, rowValue(row, "id"), false)), ...(await variableRows(tx, rowValue(row, "id"), true))];
    const out: PhpObject[] = [];
    for (const v of list) out.push(await variableModel(tx, c, resource, v, true));
    return coolifyJson(out);
  });
}

/** customApiValidator() with the rules of create_env, update_env_by_uuid and each item of create_bulk_envs. */
export function validateVariable(all: Record<string, unknown>, flags: readonly string[] = ["is_preview", ...ENV_FLAGS]): Errors {
  const errors: Errors = [];
  const present = (k: string) => k in all;
  const key = all.key;
  if (key === undefined || key === null || (typeof key === "string" && key.trim() === "")) addError(errors, "key", "This field is required.");
  else {
    if (typeof key !== "string") addError(errors, "key", LARAVEL.string("key"));
    if ([...String(key)].length > 255) addError(errors, "key", LARAVEL.maxString("key", 255));
    if (typeof key !== "string" || !ENVIRONMENT_VARIABLE_KEY_PATTERN.test(key)) addError(errors, "key", LARAVEL.regex("key"));
  }
  if (present("value") && all.value !== null && typeof all.value !== "string") addError(errors, "value", LARAVEL.string("value"));
  for (const flag of flags) {
    if (present(flag) && ![true, false, 0, 1, "0", "1"].includes(all[flag] as never)) addError(errors, flag, `The ${flag.replace(/_/g, " ")} field must be true or false.`);
  }
  const comment = all.comment;
  if (present("comment") && comment !== null) {
    if (typeof comment !== "string") addError(errors, "comment", LARAVEL.string("comment"));
    if ([...(typeof comment === "string" ? comment : String(comment))].length > 256) addError(errors, "comment", LARAVEL.maxString("comment", 256));
  }
  return errors;
}

/** `$request->has('key')`: the key as ValidationPatterns::normalizeEnvironmentVariableKey((string) $key) makes it. */
export function normalizedKey(all: Record<string, unknown>): Record<string, unknown> {
  if (!("key" in all)) return all;
  const key = all.key;
  const text = key === null || key === undefined || key === false ? "" : key === true ? "1" : String(key);
  return { ...all, key: normalizeEnvironmentVariableKey(text) };
}

/** str($key)->trim()->replace(' ', '_') */
export const lookupKey = (key: unknown): string => String(key ?? "").trim().replace(/ /g, "_");

/** $env->fill($request->only([...flags, 'comment'])) and $env->value = … when the request has it. */
function changesOf(all: Record<string, unknown>): VariableChanges {
  const changes: VariableChanges = {};
  if ("value" in all) changes.value = all.value as string | null;
  if ("comment" in all) changes.comment = all.comment as string | null;
  if ("is_literal" in all) changes.isLiteral = phpBool(all.is_literal);
  if ("is_multiline" in all) changes.isMultiline = phpBool(all.is_multiline);
  if ("is_shown_once" in all) changes.isShownOnce = phpBool(all.is_shown_once);
  if ("is_runtime" in all) changes.isRuntime = phpBool(all.is_runtime);
  if ("is_buildtime" in all) changes.isBuildtime = phpBool(all.is_buildtime);
  return changes;
}

/** EnvironmentVariable::create([...]) as create_env and create_bulk_envs call it (no order; the created hook adds the preview copy). */
async function createApiVariable(tx: SqlExecutor, c: ApiV1Context, resource: EnvResource, all: Record<string, unknown>): Promise<EnvRow> {
  const ctx = environmentVariableContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, "application");
  const flag = (k: string, fallback: boolean) => (k in all ? phpBool(all[k]) : fallback);
  return createVariable(ctx, resource, {
    key: String(all.key),
    value: (all.value as string | null | undefined) ?? null,
    comment: (all.comment as string | null | undefined) ?? null,
    order: null,
    isPreview: flag("is_preview", false),
    isLiteral: flag("is_literal", false),
    isMultiline: flag("is_multiline", false),
    isShownOnce: flag("is_shown_once", false),
    isRuntime: flag("is_runtime", true),
    isBuildtime: flag("is_buildtime", true),
    isRequired: false,
  });
}

/** Saves the changes on a variable and reads its row again. */
async function saveApiVariable(tx: SqlExecutor, c: ApiV1Context, row: ApiRow, changes: VariableChanges): Promise<ApiRow> {
  const ctx = environmentVariableContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, "application");
  const env = asEnvRow(row);
  await saveVariable(ctx, env, await storedValue(ctx, env), changes);
  return (await rowsOf(tx)("environment_variables", "t.id = $1", [rowValue(row, "id")]))[0]!;
}

/** The answer of a refused value (the saving hook's NUL check) or a duplicate key. */
function variableError(e: unknown): CoolifyAnswer {
  if (e instanceof EnvironmentVariableError) return e.field ? validationFailed([[e.field, [e.message]]]) : message(e.message, e.status);
  throw e;
}

async function createEnv(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  return c.sql(c.env, c.orgId, async (tx) => {
    const row = await applicationRow(rowsOf(tx), uuid);
    const resource = row ? await variableResource(tx, c, uuid) : null;
    if (!row || !resource) return message("Application not found", 404);
    const no = await denied(c, true);
    if (no) return no;
    const all = normalizedKey(body.all);
    const errors = validateVariable(all);
    for (const k of Object.keys(all)) if (!(ENV_FIELDS as readonly string[]).includes(k)) addError(errors, k, "This field is not allowed.");
    if (errors.length) return validationFailed(errors);
    const isPreview = phpBool(all.is_preview);
    const existing = (await variableRows(tx, rowValue(row, "id"), isPreview)).find((v) => rowValue(v, "key") === lookupKey(all.key));
    if (existing) return message("Environment variable already exists. Use PATCH request to update it.", 409);
    try {
      const created = await createApiVariable(tx, c, resource, all);
      return coolifyJson(obj({ uuid: created.uuid ?? null }), 201);
    } catch (e) {
      return variableError(e);
    }
  });
}

async function updateEnv(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  return c.sql(c.env, c.orgId, async (tx) => {
    const row = await applicationRow(rowsOf(tx), uuid);
    const resource = row ? await variableResource(tx, c, uuid) : null;
    if (!row || !resource) return message("Application not found", 404);
    const no = await denied(c, true);
    if (no) return no;
    const all = normalizedKey(body.all);
    const errors = validateVariable(all);
    for (const k of Object.keys(all)) if (!(ENV_FIELDS as readonly string[]).includes(k)) addError(errors, k, "This field is not allowed.");
    if (errors.length) return validationFailed(errors);
    const found = (await variableRows(tx, rowValue(row, "id"), phpBool(all.is_preview))).find((v) => rowValue(v, "key") === lookupKey(all.key));
    if (!found) return message("Environment variable not found.", 404);
    try {
      const saved = await saveApiVariable(tx, c, found, changesOf(all));
      return coolifyJson(await variableModel(tx, c, resource, saved, false), 201);
    } catch (e) {
      return variableError(e);
    }
  });
}

/** create_bulk_envs: each item validated, then updated (the key exists in its scope) or created, in order; an invalid item stops there. */
async function bulkEnvs(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body: ApiBody = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  return c.sql(c.env, c.orgId, async (tx) => {
    const row = await applicationRow(rowsOf(tx), uuid);
    const resource = row ? await variableResource(tx, c, uuid) : null;
    if (!row || !resource) return message("Application not found", 404);
    const no = await denied(c, true);
    if (no) return no;
    const data = body.all.data;
    if (!phpBool(data)) return message("Bulk data is required.", 400);
    const items = (Array.isArray(data) ? data : typeof data === "object" && data !== null ? Object.values(data) : [data]).map((item) => {
      const fields = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
      return normalizedKey(Object.fromEntries(Object.entries(fields).filter(([k]) => (ENV_FIELDS as readonly string[]).includes(k))));
    });
    const out: PhpObject[] = [];
    for (const all of items) {
      const errors = validateVariable(all);
      if (errors.length) return validationFailed(errors);
      const existing = (await variableRows(tx, rowValue(row, "id"), phpBool(all.is_preview))).find((v) => rowValue(v, "key") === lookupKey(all.key));
      try {
        if (existing) out.push(await variableModel(tx, c, resource, await saveApiVariable(tx, c, existing, changesOf(all)), false));
        else {
          const created = await createApiVariable(tx, c, resource, all);
          out.push(await variableModel(tx, c, resource, (await rowsOf(tx)("environment_variables", "t.id = $1", [created.id]))[0]!, false, true));
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
    const row = await applicationRow(rowsOf(tx), uuid);
    if (!row) return message("Application not found.", 404);
    const no = await denied(c, true);
    if (no) return no;
    const found = (await variableRows(tx, rowValue(row, "id"), null)).find((v) => rowValue(v, "uuid") === envUuid);
    if (!found) return message("Environment variable not found.", 404);
    await environmentVariableContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, "application").store.delete([rowValue(found, "id") as string | number]);
    return message("Environment variable deleted.", 200);
  });
}
