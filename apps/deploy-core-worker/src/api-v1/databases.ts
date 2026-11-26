// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/DatabasesController.php (databases,
// database_by_uuid, create_database and its eight create_database_<engine> routes, update_by_uuid, delete_by_uuid,
// action_deploy, action_restart, action_stop, database_backup_details_uuid, create_backup, update_backup,
// delete_backup_by_uuid, list_backup_executions, delete_execution_by_uuid, removeSensitiveData,
// hideNestedServerSecrets, exposeNestedServerSecrets, createdDatabasePayload, normalizeNumericLimits,
// requestedBackupS3Storages, withBackupS3StorageUuids, redactBackupExecutionMessage), app/Http/Controllers/Api/
// Concerns/{HandlesTagsApi,RequiresDeployAbility}.php, app/Http/Controllers/Api/OtherController.php (post_required),
// app/Models/{Standalone*,ScheduledDatabaseBackup,ScheduledDatabaseBackupExecution}.php ($hidden, $casts, $appends),
// app/Traits/HasS3Destinations.php, bootstrap/helpers/{api,databases,shared}.php (removeUnnecessaryFieldsFromRequest,
// redactLockedApiResourceValues, isPublicPortAlreadyUsed, queryDatabaseByUuidWithinTeam, isBase64Encoded) and
// app/Models/EnvironmentVariable.php (logRedactionSecretsFor) (Apache-2.0), modified.
//
// Coolify's /api/v1 for the standalone databases (DP-73) — the eight engines Freeploy creates — and their backup
// schedules, on the services and stores the console uses: a database is created by createDatabase() (DP-57, with the
// API's fields as create_standalone_*()'s $otherData), its connection URLs are showDatabase()'s, it is deleted by
// deleteDatabaseNow() (the never-started rule), its columns are written through the console's store, and a schedule
// through the backup schedule stores (DP-65) with the backup helpers' checks (validateDatabasesBackupInput, the
// cron expression, isBackupSolutionAvailable). What runs on a server — start, restart, the TCP proxy, a backup that
// runs now, the files of a backup — answers 501 in Coolify's envelope (DP-70's convention).
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  DATABASE_ENGINES,
  DATABASE_TABLES,
  attachTag,
  databaseBackupExecutionLiveS3Copies,
  databasePublicPortTaken,
  deleteDatabaseBackup,
  deleteDatabaseBackupExecution,
  findDatabaseBackup,
  findDatabaseByUuid,
  findTagByName,
  insertDatabaseBackup,
  insertTag,
  listServerDestinations,
  resourceHasTag,
  setDatabaseBackupPrimaryStorage,
  syncScheduleS3Storages,
  updateDatabaseBackup,
  type ApiRow,
  type ApiTable,
  type DatabaseBackupChanges,
  type DatabaseColumnValue,
  type DatabaseEngine,
  type DeployDatabaseRow,
} from "@saas/db/deploy";
import { coolifyJson, obj, serializeApiResponse, COOLIFY_API, POLICY_DENIALS, type CoolifyAnswer, type PhpObject, type PhpValue } from "@saas/contracts/coolify-api";
import { columnCipher } from "../handlers/cloud-tokens.js";
import { sqlStore } from "../handlers/databases.js";
import type { KeyCipher } from "../private-keys/service.js";
import { DATABASE_ENGINE_SPECS, isDatabaseEngine } from "../databases/engines.js";
import { DATABASE_SERVICE_MESSAGES, DatabaseError, createDatabase, databaseStatus, deleteDatabaseNow, saveRedisPasswordVariable, showDatabase, type DatabaseContext } from "../databases/service.js";
import { DB_IDENTIFIER_PATTERN, DB_PASSWORD_PATTERN } from "../databases/validation.js";
import { BACKUP_MESSAGES, BackupError, backupSolutionAvailable, validateDatabasesBackupInput } from "../databases/backups.js";
import { validateCronExpressionStrict } from "../helpers/cron.js";
import { redactSensitiveText } from "../helpers/remote-process.js";
import { effectiveServerRole } from "../servers/service.js";
import { stripTags, tagName } from "../applications/tags.js";
import { deleteOptions } from "../applications/danger.js";
import { newPublicId } from "../helpers/names.js";
import { nestedServer } from "./applications.js";
import { inCoolifyOrder, type CoolifyTable } from "./columns.js";
import { decryptColumn, hasDeployAbility, message, rowsOf, unavailable, type ApiV1Context, type Rows } from "./context.js";
import { DESTINATION, rowValue, toModel, type ModelShape } from "./models.js";
import { addError, descriptionRules, nameRules, readApiBody, requestBoolean, validationFailed, type ApiBody, type Errors } from "./request.js";
import { phpIsNumeric, validateRules, type Rule, type Rules } from "./rules.js";

export const DATABASES_API_MESSAGES = {
  /** Freeploy's: Coolify queues a backup job, which runs the dump on the server. */
  backupNowUnavailable: BACKUP_MESSAGES.backupNow,
  /** Freeploy's: deleteBackupsLocally() runs `rm` on the server. */
  deleteLocalUnavailable: BACKUP_MESSAGES.deleteLocal,
  deleteS3Unavailable: BACKUP_MESSAGES.deleteS3,
} as const;

/** Laravel's abort(403, …) rendered by Coolify's exception handler: pretty-printed. */
const ABORT_DEPLOY: CoolifyAnswer = { status: 403, body: '{\n    "message": "Missing required permissions: deploy"\n}', headers: { "content-type": "application/json" } };

const SWARM_DOCKER = "App\\Models\\SwarmDocker";
const ID_RULES: readonly Rule[] = ["nullable", "string", "min:1", "max:63", { regex: DB_IDENTIFIER_PATTERN }];
const PASSWORD_RULES: readonly Rule[] = ["nullable", "string", "min:1", "max:128", { regex: DB_PASSWORD_PATTERN }];

/** Each engine's own fields of create_database and update_by_uuid, its validator's rules (in Coolify's order) and its base64 configuration. */
const ENGINE_API: Record<DatabaseEngine, { fields: string[]; rules: Rules; conf: string | null }> = {
  postgresql: {
    fields: ["postgres_user", "postgres_password", "postgres_db", "postgres_initdb_args", "postgres_host_auth_method", "postgres_conf"],
    rules: [["postgres_user", ID_RULES], ["postgres_password", PASSWORD_RULES], ["postgres_db", ID_RULES], ["postgres_initdb_args", ["string"]], ["postgres_host_auth_method", ["string"]], ["postgres_conf", ["string"]]],
    conf: "postgres_conf",
  },
  clickhouse: { fields: ["clickhouse_admin_user", "clickhouse_admin_password"], rules: [["clickhouse_admin_user", ID_RULES], ["clickhouse_admin_password", PASSWORD_RULES]], conf: null },
  dragonfly: { fields: ["dragonfly_password"], rules: [["dragonfly_password", PASSWORD_RULES]], conf: null },
  redis: { fields: ["redis_password", "redis_conf"], rules: [["redis_password", PASSWORD_RULES], ["redis_conf", ["string"]]], conf: "redis_conf" },
  keydb: { fields: ["keydb_password", "keydb_conf"], rules: [["keydb_password", PASSWORD_RULES], ["keydb_conf", ["string"]]], conf: "keydb_conf" },
  mariadb: {
    fields: ["mariadb_conf", "mariadb_root_password", "mariadb_user", "mariadb_password", "mariadb_database"],
    rules: [["mariadb_conf", ["string"]], ["mariadb_root_password", PASSWORD_RULES], ["mariadb_user", ID_RULES], ["mariadb_password", PASSWORD_RULES], ["mariadb_database", ID_RULES]],
    conf: "mariadb_conf",
  },
  mongodb: {
    fields: ["mongo_conf", "mongo_initdb_root_username", "mongo_initdb_root_password", "mongo_initdb_database"],
    rules: [["mongo_conf", ["string"]], ["mongo_initdb_root_username", ID_RULES], ["mongo_initdb_root_password", PASSWORD_RULES], ["mongo_initdb_database", ID_RULES]],
    conf: "mongo_conf",
  },
  mysql: {
    fields: ["mysql_root_password", "mysql_password", "mysql_user", "mysql_database", "mysql_conf"],
    rules: [["mysql_root_password", PASSWORD_RULES], ["mysql_password", PASSWORD_RULES], ["mysql_user", ID_RULES], ["mysql_database", ID_RULES], ["mysql_conf", ["string"]]],
    conf: "mysql_conf",
  },
};

const LIMITS = ["limits_memory", "limits_memory_swap", "limits_memory_swappiness", "limits_memory_reservation", "limits_cpus", "limits_cpuset", "limits_cpu_shares"];
const HEALTH_CHECKS = ["health_check_enabled", "health_check_interval", "health_check_timeout", "health_check_retries", "health_check_start_period"];
const CREATE_COMMON = ["name", "description", "image", "public_port", "public_port_timeout", "is_public", "project_uuid", "environment_name", "environment_uuid", "server_uuid", "destination_uuid", "instant_deploy", ...LIMITS];
const UPDATE_COMMON = ["name", "description", "image", "public_port", "public_port_timeout", "is_public", "instant_deploy", ...LIMITS];
/** create_database's first $allowedFields: every engine's fields (SQLite's too), before the engine is known. */
const CREATE_ANY = [...CREATE_COMMON, ...Object.values(ENGINE_API).flatMap((e) => e.fields), "sqlite_databases", "tags"];
/** The columns whose value Eloquent casts to a boolean on the way in (PostgreSQL takes no 0 or "1"). */
const BOOLEAN_COLUMNS = ["is_public", "health_check_enabled"];
/** removeUnnecessaryFieldsFromRequest(): what the database endpoints send that it removes. */
const UNNECESSARY = ["project_uuid", "environment_name", "environment_uuid", "destination_uuid", "server_uuid", "type", "domains", "instant_deploy", "github_app_uuid", "gitea_app_uuid", "private_key_uuid", "use_build_server", "use_build_secrets", "is_static", "is_spa", "is_auto_deploy_enabled", "is_force_https_enabled", "is_preview_deployments_enabled", "connect_to_docker_network", "force_domain_override", "autogenerate_domain", "is_container_label_escape_enabled", "is_preserve_repository_enabled", "include_source_commit_in_build", "include_network_hosts_in_build", "is_git_submodules_enabled", "is_git_lfs_enabled", "is_git_shallow_clone_enabled", "is_auto_cancel_queued_deployments_enabled", "is_auto_cancel_building_deployments_enabled", "disable_build_cache", "inject_build_args_to_dockerfile", "is_env_sorting_enabled", "redact_all_env_values_in_logs", "include_coolify_default_variables", "is_pr_deployments_public_enabled", "stop_grace_period", "rolling_update_drain_seconds", "docker_images_to_keep", "is_gzip_enabled", "is_stripprefix_enabled", "is_permanent_redirect_enabled", "traefik_certificate_resolver", "is_container_label_readonly_enabled", "is_raw_compose_deployment_enabled", "is_log_drain_enabled", "is_gpu_enabled", "gpu_driver", "gpu_count", "gpu_device_ids", "gpu_options", "is_consistent_container_name_enabled", "is_image_scan_enabled", "custom_internal_name", "custom_container_name_prefix", "docker_compose_raw", "tags"];
const removeUnnecessary = (all: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(all).filter(([k]) => !UNNECESSARY.includes(k)));

/** PHP's truthiness of a request value. */
const phpTruthy = (v: unknown): boolean => !(v === undefined || v === null || v === false || v === 0 || v === "" || v === "0" || (Array.isArray(v) && v.length === 0));
const phpBool = (v: unknown): boolean => phpTruthy(v);
/** filled() */
const filled = (v: unknown): boolean => !(v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0));

/**
 * `$request->uuid`: Laravel reads the input (the body, then the query string) before the route parameter, so a
 * body's "uuid" names another database — as it does in Coolify.
 */
function param(c: ApiV1Context, all: Record<string, unknown>, name: string, route: string): unknown {
  if (name in all) return all[name];
  const q = c.url.searchParams.get(name);
  return q !== null ? q : route;
}

/** isBase64Encoded() and mb_detect_encoding(…, 'UTF-8', true): the decoded text, or null when either fails. */
export function decodeBase64Text(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return null;
  }
  if (btoa(binary) !== value) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
  } catch {
    return null;
  }
}

const notBase64 = (field: string): CoolifyAnswer => coolifyJson(obj({ message: "Validation failed.", errors: obj({ [field]: `The ${field} should be base64 encoded.` }) }), 422);
const denied = async (c: ApiV1Context, write: boolean, policyMessage?: string): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized(policyMessage));

/** The console's database context over the request's transaction (its store and the `encrypted` casts' ciphers). */
function databaseContext(tx: SqlExecutor, c: ApiV1Context): DatabaseContext {
  const ciphers = new Map<string, KeyCipher>();
  const cipher = (column: string): KeyCipher => {
    let found = ciphers.get(column);
    if (!found) ciphers.set(column, (found = columnCipher(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, column)));
    return found;
  };
  return { store: sqlStore(tx, c.orgId), cipher };
}

// ── routes ──────────────────────────────────────────────────────────────────

/** routes/api.php's /databases routes this port has; null for every other path (the caller answers the fallback 404). */
export async function databasesApi(c: ApiV1Context, segments: string[]): Promise<CoolifyAnswer | null> {
  const [uuid, sub, backup, executions, execution, extra] = segments;
  const m = c.method;
  if (extra !== undefined) return null;
  if (uuid === undefined) return m === "GET" ? listDatabases(c) : null;
  if (sub === undefined) {
    if (m === "GET") return showDatabaseApi(c, uuid);
    if (m === "PATCH") return updateDatabase(c, uuid);
    if (m === "DELETE") return deleteDatabase(c, uuid);
    if (m === "POST" && isDatabaseEngine(uuid)) return createDatabaseApi(c, uuid);
    return null;
  }
  if (sub === "backups") {
    if (backup === undefined) return m === "GET" ? listBackups(c, uuid) : m === "POST" ? createBackup(c, uuid) : null;
    if (executions === undefined) return m === "PATCH" ? updateBackup(c, uuid, backup) : m === "DELETE" ? deleteBackup(c, uuid, backup) : null;
    if (executions !== "executions") return null;
    if (execution === undefined) return m === "GET" ? listExecutions(c, uuid, backup) : null;
    return m === "DELETE" ? deleteExecution(c, uuid, backup, execution) : null;
  }
  if (backup !== undefined) return null;
  if (sub === "start" || sub === "restart" || sub === "stop") {
    // OtherController::post_required()
    if (m === "GET") return message("This endpoint has changed to a POST request.", 405);
    if (m === "POST") return action(c, uuid, sub);
  }
  return null;
}

// ── reading ─────────────────────────────────────────────────────────────────

export interface FoundDatabase {
  engine: DatabaseEngine;
  /** The whole row (apiRows). */
  row: ApiRow;
  /** The console's row, with where it lives. */
  db: DeployDatabaseRow;
}

/** queryDatabaseByUuidWithinTeam(): the org's database of any engine, not deleted (row-level security confines it to the org). */
export async function findApiDatabase(tx: SqlExecutor, uuid: unknown): Promise<FoundDatabase | null> {
  return findDatabase(tx, uuid);
}

async function findDatabase(tx: SqlExecutor, uuid: unknown): Promise<FoundDatabase | null> {
  if (typeof uuid !== "string" && typeof uuid !== "number") return null;
  const db = await findDatabaseByUuid(tx, String(uuid));
  if (!db) return null;
  const row = (await rowsOf(tx)(DATABASE_TABLES[db.engine].table as ApiTable, "t.uuid = $1 AND t.deleted_at IS NULL", [db.uuid]))[0];
  return row ? { engine: db.engine, row, db } : null;
}

const DATABASE_DATES = ["created_at", "updated_at", "deleted_at", "last_restart_at"];
/** A model's CONFIGURATION_ATTRIBUTES beside custom_docker_run_options. */
const CONFIGURATION: Record<DatabaseEngine, string[]> = {
  postgresql: ["postgres_conf"],
  redis: ["redis_conf"],
  mongodb: ["mongo_conf"],
  mysql: ["mysql_conf"],
  mariadb: ["mariadb_conf"],
  keydb: ["keydb_conf"],
  dragonfly: [],
  clickhouse: [],
};

/** The model's $hidden; legacy_password_quoting is the start command's, never the API's. */
function databaseShape(engine: DatabaseEngine): ModelShape {
  const sensitive = [...DATABASE_TABLES[engine].encrypted, ...(engine === "postgresql" ? ["init_scripts"] : []), ...CONFIGURATION[engine], "custom_docker_run_options"];
  return { hidden: [...sensitive, "legacy_password_quoting"], dates: DATABASE_DATES };
}

/** The loaded destination relation: the StandaloneDocker with its server and the server's settings (Coolify's column order). */
async function destinationModel(rows: Rows, c: ApiV1Context, row: ApiRow): Promise<PhpValue> {
  if (rowValue(row, "destination_type") === SWARM_DOCKER) return null;
  const destination = (await rows("standalone_dockers", "t.id = $1", [rowValue(row, "destination_id")]))[0];
  if (!destination) return null;
  const server = (await rows("servers", "t.deleted_at IS NULL AND t.id = $1", [rowValue(destination, "server_id")]))[0];
  const settings = server ? (await rows("server_settings", "t.server_id = ANY($1)", [[rowValue(server, "id")]]))[0] : undefined;
  return toModel(inCoolifyOrder(destination, "standalone_dockers"), DESTINATION, { extra: [["server", server ? nestedServer(c, server, settings) : null]] });
}

/**
 * removeSensitiveData($database): toArray() — the columns but the hidden ones (the passwords decrypted, the init
 * scripts, the configuration and the connection URLs for a token that may read secrets), the status accessor, the
 * appended database_type and server_status, the loaded destination with its server and settings, and what the
 * caller set (backup_configs) — then serializeApiResponse() and the connection URLs of a locked password redacted.
 */
async function databaseModel(tx: SqlExecutor, c: ApiV1Context, found: FoundDatabase, extra: Array<[string, PhpValue]> = []): Promise<PhpObject> {
  return databaseSerialization(tx, c, found, extra, null);
}

/**
 * A standalone database through serializeApiResource() (GET /resources and an environment's resources, DP-78): toArray()
 * unsorted — every column in Coolify's order (id included), every $hidden attribute made visible for a token that may
 * read secrets (exposeSensitiveFields(): the passwords decrypted, the configuration, legacy_password_quoting and the
 * connection URLs), the status accessor, the through key, the appended attributes and the loaded destination — and the
 * connection URLs of a locked password redacted.
 */
export async function databaseResource(tx: SqlExecutor, c: ApiV1Context, engine: DatabaseEngine, row: ApiRow, throughKey?: unknown): Promise<PhpObject | null> {
  const db = await findDatabaseByUuid(tx, String(rowValue(row, "uuid")));
  if (!db) return null;
  return databaseSerialization(tx, c, { engine, row, db }, [], { throughKey });
}

async function databaseSerialization(tx: SqlExecutor, c: ApiV1Context, found: FoundDatabase, extra: Array<[string, PhpValue]>, resource: { throughKey?: unknown } | null): Promise<PhpObject> {
  const { engine, row } = found;
  const table = DATABASE_TABLES[engine];
  const sensitive = c.canReadSensitive;
  const shape = databaseShape(engine);
  const shown = (await showDatabase(databaseContext(tx, c), found.db.uuid, true))!;
  const extras: Array<[string, PhpValue]> = [];
  if (sensitive) for (const column of table.encrypted) extras.push([column, await decryptColumn(tx, c, table.table, column, rowValue(row, column))]);
  extras.push(["status", databaseStatus(rowValue(row, "status") as string | null)]);
  if (resource && resource.throughKey !== undefined) extras.push(["laravel_through_key", resource.throughKey as PhpValue]);
  if (sensitive) extras.push(["internal_db_url", shown.dbUrl], ["external_db_url", shown.dbUrlPublic]);
  extras.push(["database_type", DATABASE_ENGINE_SPECS[engine].databaseType], ["server_status", shown.serverStatus]);
  extras.push(...extra);
  if (resource) {
    // The destination server_status loaded: its server's hidden attributes stay hidden (only the resource is exposed).
    extras.push(["destination", await destinationModel(rowsOf(tx), { ...c, canReadSensitive: false }, row)]);
    return toModel(inCoolifyOrder(row, table.table as CoolifyTable), { ...shape, hidden: [...shape.hidden, "internal_db_url", "external_db_url"] }, { visible: sensitive ? shape.hidden : [], extra: extras });
  }
  extras.push(["destination", await destinationModel(rowsOf(tx), c, row)]);
  const visible = sensitive ? shape.hidden.filter((k) => k !== "legacy_password_quoting") : [];
  return serializeApiResponse(toModel(row.filter(([k]) => k !== "id"), shape, { visible, extra: extras }), sensitive);
}

/** Project::whereTeamId()->get() and $project->databases(): per project, engine by engine. */
async function listDatabases(c: ApiV1Context): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const found: FoundDatabase[] = [];
    for (const project of await rows("projects")) {
      for (const engine of DATABASE_ENGINES) {
        const list = await rows(DATABASE_TABLES[engine].table as ApiTable, "t.deleted_at IS NULL AND t.environment_id IN (SELECT e.id FROM deploy.environments e WHERE e.project_id = $1)", [rowValue(project, "id")]);
        for (const row of list) {
          const db = await findDatabaseByUuid(tx, String(rowValue(row, "uuid")));
          if (db) found.push({ engine, row, db });
        }
      }
    }
    const secrets = new Map<string, LogSecrets | null>();
    const out: PhpObject[] = [];
    for (const f of found) {
      const configs: PhpObject[] = [];
      for (const b of await backupRows(tx, f)) configs.push(await backupModel(tx, c, f, b, "latest_log", secrets));
      out.push(await databaseModel(tx, c, f, [["backup_configs", configs]]));
    }
    return coolifyJson(out);
  });
}

async function showDatabaseApi(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const found = await findDatabase(tx, param(c, {}, "uuid", uuid));
    if (!found) return message("Database not found.", 404);
    return (await denied(c, false)) ?? coolifyJson(await databaseModel(tx, c, found));
  });
}

// ── creating ────────────────────────────────────────────────────────────────

/** create_database() for one of the eight engines Freeploy has (SQLite is not one of them). */
async function createDatabaseApi(c: ApiV1Context, engine: DatabaseEngine): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (requestBoolean(body.all, "instant_deploy") && !hasDeployAbility(c)) return ABORT_DEPLOY;
  if (body.incomingError) return body.incomingError;
  const all: Record<string, unknown> = { ...body.all };
  const unknown = Object.keys(all).filter((k) => !CREATE_ANY.includes(k));
  // $errors = collect([]); $errors->add($field, …): a Collection's add() takes one item, so the errors are the names.
  if (unknown.length) return coolifyJson(obj({ message: "Validation failed.", errors: unknown }), 422);
  if (!filled(all.environment_uuid) && !filled(all.environment_name)) return message("You need to provide at least one of environment_name or environment_uuid.", 422);
  if (phpTruthy(all.is_public) && !phpTruthy(all.public_port)) all.is_public = false;

  return c.sql(c.env, c.orgId, async (tx) => {
    const ctx = databaseContext(tx, c);
    const project = typeof all.project_uuid === "string" ? await ctx.store.findProject(all.project_uuid) : null;
    if (!project) return message("Project not found.", 404);
    const environments = await rowsOf(tx)("environments", "t.project_id = $1", [project.id]);
    const environment = environments.find((e) => rowValue(e, "name") === all.environment_name) ?? environments.find((e) => rowValue(e, "uuid") === all.environment_uuid);
    if (!environment) return message("You need to provide a valid environment_name or environment_uuid.", 422);
    const no = await denied(c, true);
    if (no) return no;
    const server = typeof all.server_uuid === "string" ? await ctx.store.findServer(all.server_uuid) : null;
    if (!server) return message("Server not found.", 404);
    if (effectiveServerRole(server) === "build") {
      return coolifyJson(obj({ message: "Validation failed.", errors: obj({ server_uuid: ["The specified server is configured as a build server and cannot host resources."] }) }), 422);
    }
    const destinations = await listServerDestinations(tx, server.id);
    if (destinations.length === 0) return message("Server has no destinations.", 400);
    if (destinations.length > 1 && !("destination_uuid" in all)) return message("Server has multiple destinations and you do not set destination_uuid.", 400);
    let destination = destinations[0]!;
    if (destinations.length > 1) {
      const chosen = destinations.find((d) => d.uuid === all.destination_uuid);
      if (!chosen) return coolifyJson(obj({ message: "Validation failed.", errors: obj({ destination_uuid: "Provided destination_uuid does not belong to the specified server." }) }), 422);
      destination = chosen;
    }
    if ("public_port" in all && phpTruthy(all.is_public) && (await portTaken(tx, server.id, all.public_port, null))) return message("Public port already used by another database.", 400);
    // normalizeNumericLimits()
    for (const field of ["limits_memory", "limits_memory_swap", "limits_memory_reservation", "limits_cpus", "limits_cpuset"]) {
      if (typeof all[field] === "number") all[field] = String(all[field]);
    }
    const errors: Errors = [];
    nameRules(errors, all, "name", { required: false, nullable: false });
    descriptionRules(errors, all);
    await validateRules(errors, all, [
      ["image", ["string"]],
      ["project_uuid", ["string", "required"]],
      ["environment_name", ["string", "nullable"]],
      ["environment_uuid", ["string", "nullable"]],
      ["server_uuid", ["string", "required"]],
      ["destination_uuid", ["string"]],
      ["is_public", ["boolean"]],
      ["public_port", ["numeric", "nullable"]],
      ["public_port_timeout", ["integer", "nullable", "min:1"]],
      ["limits_memory", ["string"]],
      ["limits_memory_swap", ["string"]],
      ["limits_memory_swappiness", ["numeric"]],
      ["limits_memory_reservation", ["string"]],
      ["limits_cpus", ["string"]],
      ["limits_cpuset", ["string", "nullable"]],
      ["limits_cpu_shares", ["numeric"]],
      ["instant_deploy", ["boolean"]],
      ["tags", ["array", "nullable"]],
      ["tags.*", ["string", "min:2"]],
    ]);
    if (errors.length) return validationFailed(errors);
    // validateTagsParameter()
    const tags = "tags" in all ? normalizeTags(all.tags) : [];
    if (tags.some((t) => [...t].length < 2)) return validationFailed([["tags", ["Each tag name must be at least 2 characters after sanitization."]]]);
    if (phpTruthy(all.public_port) && (Number(all.public_port) < 1024 || Number(all.public_port) > 65535)) {
      return coolifyJson(obj({ message: "Validation failed.", errors: obj({ public_port: "The public port should be between 1024 and 65535." }) }), 422);
    }
    const spec = ENGINE_API[engine];
    const allowed = [...CREATE_COMMON, ...spec.fields, "tags"];
    const engineErrors: Errors = [];
    await validateRules(engineErrors, all, spec.rules);
    for (const k of Object.keys(all)) if (!allowed.includes(k)) addError(engineErrors, k, "This field is not allowed.");
    if (engineErrors.length) return validationFailed(engineErrors);
    const data = removeUnnecessary(all);
    if (spec.conf && spec.conf in data) {
      const decoded = decodeBase64Text(data[spec.conf]);
      if (decoded === null) return notBase64(spec.conf);
      data[spec.conf] = decoded;
    }
    // StartDatabase::dispatch(): the start runs on the server (Freeploy's convention: refused before anything is stored).
    if (requestBoolean(all, "instant_deploy")) return unavailable(DATABASE_SERVICE_MESSAGES.startUnavailable);

    // create_standalone_<engine>($environment->id, $destination, $request->only($allowedFields))
    const values: Record<string, DatabaseColumnValue> = {};
    let redisPassword: string | null = null;
    for (const [k, v] of Object.entries(data)) {
      if (!allowed.includes(k) || k === "tags") continue;
      if (k === "redis_password") {
        redisPassword = typeof v === "string" ? v : null;
        continue;
      }
      values[k] = columnValue(k, v);
    }
    const created = await createDatabase(
      ctx,
      { engine, projectUuid: project.uuid, environmentUuid: String(rowValue(environment, "uuid")), serverUuid: server.uuid, destinationUuid: destination.uuid, databaseImage: engine === "postgresql" ? "postgres:18-alpine" : null },
      { values, redisPassword },
    );
    const db = (await findDatabaseByUuid(tx, created!.uuid))!;
    for (const name of tags) await attachTagTo(tx, c, { type: DATABASE_TABLES[engine].morphClass, id: db.id }, name);
    // createdDatabasePayload(): the connection URLs need sensitive read access; Dragonfly answers the uuid only.
    const payload: Array<[string, PhpValue]> = [["uuid", db.uuid]];
    if (c.canReadSensitive && engine !== "dragonfly") {
      const shown = (await showDatabase(ctx, db.uuid, true))!;
      payload.push(["internal_db_url", shown.dbUrl]);
      if (db.is_public && db.public_port) payload.push(["external_db_url", shown.dbUrlPublic]);
    }
    return coolifyJson(serializeApiResponse(obj(payload)), 201);
  });
}

/** A request value as the model stores it: the name and description through strip_tags(), the booleans cast. */
function columnValue(column: string, v: unknown): DatabaseColumnValue {
  if (v === null || v === undefined) return null;
  if ((column === "name" || column === "description") && typeof v === "string") return stripTags(v);
  if (BOOLEAN_COLUMNS.includes(column)) return phpBool(v);
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return JSON.stringify(v);
}

/** normalizeTagNames(): strtolower(trim(strip_tags((string) $name))), unique. */
export function normalizeTags(tags: unknown): string[] {
  const list = Array.isArray(tags) ? tags : tags !== null && typeof tags === "object" ? Object.values(tags) : [];
  const names = list.map((t) => stripTags(t === null || t === undefined ? "" : String(t)).trim().replace(/[A-Z]/g, (ch) => ch.toLowerCase()));
  return [...new Set(names)];
}

/** attachTagsToResource(): Tag::createOrFirst(team, name), then syncWithoutDetaching(). */
export async function attachTagTo(tx: SqlExecutor, c: ApiV1Context, resource: { type: string; id: string | number }, name: string): Promise<void> {
  const stored = tagName(name);
  const tag = (await findTagByName(tx, stored)) ?? (await insertTag(tx, { orgId: c.orgId, uuid: newPublicId(), name: stored }));
  if (!(await resourceHasTag(tx, resource, tag.id))) await attachTag(tx, c.orgId, resource, tag.id);
}

/** isPublicPortAlreadyUsed(Server $server, int $port, $id): the port as PHP's int parameter takes it. */
async function portTaken(tx: SqlExecutor, serverId: string | number, port: unknown, excludeId: string | number | null): Promise<boolean> {
  if (!phpIsNumeric(port) && typeof port !== "boolean") throw new TypeError("isPublicPortAlreadyUsed(): the port is not an int");
  return databasePublicPortTaken(tx, serverId, Math.trunc(Number(port)), excludeId);
}

// ── updating ────────────────────────────────────────────────────────────────

const serverLogDrainEnabled = (db: DeployDatabaseRow): boolean =>
  Boolean(db.server_is_logdrain_newrelic_enabled) || Boolean(db.server_is_logdrain_axiom_enabled) || Boolean(db.server_is_logdrain_custom_enabled) || Boolean(db.server_is_logdrain_cloudwatch_enabled);

/** Nothing of the database can be on a server: it never left 'exited' and was never started (DP-57's rule). */
const neverStarted = (db: DeployDatabaseRow): boolean => db.status.startsWith("exited") && db.started_at === null;

/** update_by_uuid() */
async function updateDatabase(c: ApiV1Context, routeUuid: string): Promise<CoolifyAnswer> {
  const body: ApiBody = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all: Record<string, unknown> = { ...body.all };
  const errors: Errors = [];
  nameRules(errors, all, "name", { required: false, nullable: false });
  descriptionRules(errors, all);
  await validateRules(errors, all, [
    ["image", ["string"]],
    ["is_public", ["boolean"]],
    ["public_port", ["numeric", "nullable", "between:1024,65535"]],
    ["public_port_timeout", ["integer", "nullable", "min:1"]],
    ["limits_memory", ["string"]],
    ["limits_memory_swap", ["string"]],
    ["limits_memory_swappiness", ["numeric"]],
    ["limits_memory_reservation", ["string"]],
    ["limits_cpus", ["string"]],
    ["limits_cpuset", ["string", "nullable"]],
    ["limits_cpu_shares", ["numeric"]],
    ["instant_deploy", ["boolean"]],
    ["redact_all_env_values_in_logs", ["boolean"]],
    ["include_coolify_default_variables", ["boolean"]],
    ["is_log_drain_enabled", ["boolean"]],
  ]);
  if (errors.length) return validationFailed(errors);
  const uuid = param(c, all, "uuid", routeUuid);
  const instantDeploy = requestBoolean(all, "instant_deploy");
  const redactAll = "redact_all_env_values_in_logs" in all ? requestBoolean(all, "redact_all_env_values_in_logs") : null;
  const logDrain = "is_log_drain_enabled" in all ? requestBoolean(all, "is_log_drain_enabled") : null;
  const includeDefaults = "include_coolify_default_variables" in all ? requestBoolean(all, "include_coolify_default_variables") : null;
  const data = removeUnnecessary(all);

  return c.sql(c.env, c.orgId, async (tx) => {
    const found = await findDatabase(tx, uuid);
    if (!found) return message("Database not found.", 404);
    const { engine, db } = found;
    if (await denied(c, true)) return COOLIFY_API.unauthorized(POLICY_DENIALS.databaseUpdate);
    if (instantDeploy && !hasDeployAbility(c)) return ABORT_DEPLOY;
    if (logDrain && !serverLogDrainEnabled(db)) {
      return validationFailed([["is_log_drain_enabled", ["Log drain is not enabled on the server. Enable it on the server first."]]]);
    }
    const isPublic = db.is_public === true;
    if ("is_public" in data && phpBool(data.is_public) !== isPublic && !hasDeployAbility(c)) {
      return message("Missing required permissions: deploy. Making a database public or private starts or stops its proxy on the server, so it needs a token with the deploy permission.", 403);
    }
    if (phpTruthy(data.is_public) && phpTruthy(data.public_port) && db.server_id !== null && (await portTaken(tx, db.server_id, data.public_port, db.id))) {
      return message("Public port already used by another database.", 400);
    }
    const spec = ENGINE_API[engine];
    const allowed = [...UPDATE_COMMON, ...spec.fields, ...HEALTH_CHECKS];
    if (spec.conf && spec.conf in data) {
      const decoded = decodeBase64Text(data[spec.conf]);
      if (decoded === null) return notBase64(spec.conf);
      data[spec.conf] = decoded;
    }
    const fieldErrors: Errors = [];
    await validateRules(fieldErrors, data, spec.rules);
    await validateRules(fieldErrors, data, [
      ["health_check_enabled", ["boolean"]],
      ["health_check_interval", ["integer", "min:1"]],
      ["health_check_timeout", ["integer", "min:1"]],
      ["health_check_retries", ["integer", "min:1"]],
      ["health_check_start_period", ["integer", "min:0"]],
    ]);
    for (const k of Object.keys(data)) if (!allowed.includes(k)) addError(fieldErrors, k, "This field is not allowed.");
    if (fieldErrors.length) return validationFailed(fieldErrors);
    // RestartDatabase after the save: it runs on the server (Freeploy's convention: refused before anything is stored).
    if (instantDeploy) return unavailable(DATABASE_SERVICE_MESSAGES.restartUnavailable);
    // StartDatabaseProxy / StopDatabaseProxy: a database that never started has no proxy to stop; any other change runs on the server.
    if (data.is_public === true && phpTruthy(data.public_port) && !isPublic) return unavailable(DATABASE_SERVICE_MESSAGES.proxyStartUnavailable);
    if (data.is_public === false && isPublic && !neverStarted(db)) return unavailable(DATABASE_SERVICE_MESSAGES.proxyStopUnavailable);

    const changes: Record<string, DatabaseColumnValue> = {};
    if (redactAll !== null) changes.redact_all_env_values_in_logs = redactAll;
    if (logDrain !== null) changes.is_log_drain_enabled = logDrain;
    if (includeDefaults !== null) changes.include_coolify_default_variables = includeDefaults;
    const table = DATABASE_TABLES[engine];
    const ctx = databaseContext(tx, c);
    for (const [k, v] of Object.entries(data)) {
      // $database->update($request->only($allowedFields)): the fillable ones (instant_deploy is not a column; Redis's password is a variable).
      if (!allowed.includes(k) || k === "instant_deploy" || k === "redis_password") continue;
      const value = columnValue(k, v);
      changes[k] = table.encrypted.includes(k) && typeof value === "string" ? await ctx.cipher(`${table.table}.${k}`).encrypt(value) : value;
    }
    if (Object.keys(changes).length) await ctx.store.update(engine, db.id, changes);
    // The Redis password is stored in the REDIS_PASSWORD variable, not in a column.
    if (engine === "redis" && filled(data.redis_password)) await saveRedisPasswordVariable(ctx, db.uuid, String(data.redis_password));
    return message("Database updated.", 200);
  });
}

// ── deleting, starting, stopping ────────────────────────────────────────────

/**
 * delete_by_uuid(): Coolify soft-deletes the database and queues DeleteResourceJob; Freeploy removes the rows of a
 * database that never started at once (deleteDatabaseNow(), the console's rule) and answers 501 for any other.
 */
async function deleteDatabase(c: ApiV1Context, routeUuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const found = await findDatabase(tx, param(c, {}, "uuid", routeUuid));
    if (!found) return message("Database not found.", 404);
    const no = await denied(c, true);
    if (no) return no;
    try {
      await deleteDatabaseNow(databaseContext(tx, c), found.db.uuid, deleteOptions(c.url.searchParams));
    } catch (e) {
      if (e instanceof DatabaseError) return unavailable(e.message);
      throw e;
    }
    return message("Database deletion request queued.", 200);
  });
}

/** action_deploy, action_restart, action_stop: Coolify's own refusals, then the server's part (501). */
async function action(c: ApiV1Context, routeUuid: string, which: "start" | "restart" | "stop"): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const found = await findDatabase(tx, param(c, {}, "uuid", routeUuid));
    if (!found) return message("Database not found.", 404);
    const no = await denied(c, true);
    if (no) return no;
    const status = found.db.status;
    if (which === "start" && status.includes("running")) return message("Database is already running.", 400);
    if (which === "stop" && (status.includes("stopped") || status.includes("exited"))) return message("Database is already stopped.", 400);
    return unavailable({ start: DATABASE_SERVICE_MESSAGES.startUnavailable, restart: DATABASE_SERVICE_MESSAGES.restartUnavailable, stop: DATABASE_SERVICE_MESSAGES.stopUnavailable }[which]);
  });
}

// ── backup schedules ────────────────────────────────────────────────────────

const BACKUP_SHAPE: ModelShape = { hidden: [], dates: ["created_at", "updated_at", "last_execution_at"] };
const EXECUTION_SHAPE: ModelShape = { hidden: ["worker_host"], dates: ["created_at", "updated_at", "finished_at"] };
const BACKUP_FIELDS = ["save_s3", "enabled", "dump_all", "frequency", "databases_to_backup", "database_backup_retention_amount_locally", "database_backup_retention_days_locally", "database_backup_retention_max_storage_locally", "database_backup_retention_amount_s3", "database_backup_retention_days_s3", "database_backup_retention_max_storage_s3", "s3_storage_uuid", "s3_storage_uuids", "timeout", "missing_backup_notification_days", "disable_local_backup"];

const morphOf = (f: FoundDatabase): string => DATABASE_TABLES[f.engine].morphClass;

/** ScheduledDatabaseBackup::ownedByCurrentTeamAPI($team)->where(database)->orderBy('created_at', 'desc') */
async function backupRows(tx: SqlExecutor, f: FoundDatabase, uuid?: string): Promise<ApiRow[]> {
  const rows = await rowsOf(tx)("scheduled_database_backups", `t.database_id = $1 AND t.database_type = $2${uuid === undefined ? "" : " AND t.uuid = $3"}`, [rowValue(f.row, "id"), morphOf(f), ...(uuid === undefined ? [] : [uuid])]);
  return rows.sort((a, b) => String(rowValue(b, "created_at")).localeCompare(String(rowValue(a, "created_at"))));
}

async function executionRows(tx: SqlExecutor, backupId: unknown): Promise<ApiRow[]> {
  const rows = await rowsOf(tx)("scheduled_database_backup_executions", "t.scheduled_database_backup_id = $1", [backupId]);
  return rows.sort((a, b) => String(rowValue(b, "created_at")).localeCompare(String(rowValue(a, "created_at"))));
}

interface LogSecrets {
  known: string[];
  locked: string[];
}

/**
 * EnvironmentVariable::logRedactionSecretsFor($database): its password attributes and its locked variables are
 * locked secrets; every variable's value is a known one when the database redacts all values in its logs.
 */
async function logSecrets(tx: SqlExecutor, c: ApiV1Context, f: FoundDatabase): Promise<LogSecrets> {
  const table = DATABASE_TABLES[f.engine];
  const locked: string[] = [];
  for (const [column, stored] of f.row) {
    if (!column.includes("password") || typeof stored !== "string" || stored === "") continue;
    const value = table.encrypted.includes(column) ? await decryptColumn(tx, c, table.table, column, stored) : stored;
    if (value) locked.push(value);
  }
  const known: string[] = [];
  const variables = await rowsOf(tx)("environment_variables", "t.resourceable_type = $1 AND t.resourceable_id = $2", [table.morphClass, rowValue(f.row, "id")]);
  for (const v of variables) {
    const value = await decryptColumn(tx, c, "environment_variables", "value", rowValue(v, "value"));
    if (value === null) continue;
    if (rowValue(v, "is_shown_once") === true) locked.push(value);
    else if (rowValue(f.row, "redact_all_env_values_in_logs") !== false) known.push(value);
  }
  return { known, locked };
}

/** redactBackupExecutionMessage(): the message only for a token that may read secrets, with the database's secrets redacted. */
async function executionMessage(tx: SqlExecutor, c: ApiV1Context, f: FoundDatabase, text: unknown, secrets: Map<string, LogSecrets | null>): Promise<string | null> {
  if (typeof text !== "string" || !c.canReadSensitive) return null;
  const key = `${morphOf(f)}:${String(rowValue(f.row, "id"))}`;
  if (!secrets.has(key)) secrets.set(key, await logSecrets(tx, c, f));
  const s = secrets.get(key)!;
  return s === null ? null : redactSensitiveText(text, s.known, s.locked);
}

/** An execution as toArray() gives it: Coolify's column order, the size as an integer, the message redacted. */
async function executionModel(tx: SqlExecutor, c: ApiV1Context, f: FoundDatabase, x: ApiRow, secrets: Map<string, LogSecrets | null>): Promise<PhpObject> {
  const size = rowValue(x, "size");
  return toModel(inCoolifyOrder(x, "scheduled_database_backup_executions"), EXECUTION_SHAPE, {
    extra: [
      ["message", await executionMessage(tx, c, f, rowValue(x, "message"), secrets)],
      ["size", size === null || size === undefined ? null : Number.parseInt(String(size), 10) || 0],
    ],
  });
}

/** A schedule's S3 destinations (the pivot, oldest first) with the primary first; without any, its legacy storage. */
async function backupStorageUuids(tx: SqlExecutor, b: ApiRow): Promise<{ primary: string | null; all: string[] }> {
  const rows = rowsOf(tx);
  const primaryId = rowValue(b, "s3_storage_id");
  const primary = primaryId === null || primaryId === undefined ? null : ((await rows("s3_storages", "t.id = $1", [primaryId]))[0] ?? null);
  const pivots = await rows("scheduled_database_backup_s3_storage", "t.scheduled_database_backup_id = $1", [rowValue(b, "id")]);
  const storages = pivots.length ? await rows("s3_storages", "t.id = ANY($1)", [pivots.map((p) => rowValue(p, "s3_storage_id"))]) : [];
  const ordered = pivots.map((p) => storages.find((s) => rowValue(s, "id") === rowValue(p, "s3_storage_id"))).filter((s): s is ApiRow => s !== undefined);
  const sorted = [...ordered.filter((s) => rowValue(s, "id") === primaryId), ...ordered.filter((s) => rowValue(s, "id") !== primaryId)];
  const list = sorted.length ? sorted : primary ? [primary] : [];
  return { primary: primary ? String(rowValue(primary, "uuid")) : null, all: list.map((s) => String(rowValue(s, "uuid"))) };
}

/** withBackupS3StorageUuids($backup) with its executions or its latest_log: toArray() in Coolify's column order. */
async function backupModel(tx: SqlExecutor, c: ApiV1Context, f: FoundDatabase, b: ApiRow, relation: "latest_log" | "executions", secrets: Map<string, LogSecrets | null>): Promise<PhpObject> {
  const storages = await backupStorageUuids(tx, b);
  const executions = await executionRows(tx, rowValue(b, "id"));
  const extra: Array<[string, PhpValue]> = [
    ["s3_storage_uuid", storages.primary],
    ["s3_storage_uuids", storages.all],
  ];
  if (relation === "latest_log") extra.push(["latest_log", executions[0] ? await executionModel(tx, c, f, executions[0], secrets) : null]);
  else {
    const list: PhpObject[] = [];
    for (const x of executions) list.push(await executionModel(tx, c, f, x, secrets));
    extra.push(["executions", list]);
  }
  return toModel(inCoolifyOrder([...b, ["team_id", c.orgPublicId]], "scheduled_database_backups"), BACKUP_SHAPE, { extra });
}

/** database_backup_details_uuid() */
async function listBackups(c: ApiV1Context, routeUuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const f = await findDatabase(tx, param(c, {}, "uuid", routeUuid));
    if (!f) return message("Database not found.", 404);
    const no = await denied(c, false);
    if (no) return no;
    const secrets = new Map<string, LogSecrets | null>();
    const out: PhpObject[] = [];
    for (const b of await backupRows(tx, f)) out.push(await backupModel(tx, c, f, b, "executions", secrets));
    return coolifyJson(out);
  });
}

/** create_backup's and update_backup's rules, in Coolify's order (frequency is required on create). */
function backupRules(create: boolean, storageExists: (uuid: unknown) => Promise<boolean>): Rules {
  const s3: Rules = [
    ["s3_storage_uuid", ["string", { exists: storageExists }, "nullable"]],
    ["s3_storage_uuids", ["array"]],
    ["s3_storage_uuids.*", ["string", "distinct"]],
  ];
  const retention: Rules = [
    ["database_backup_retention_amount_locally", ["integer", "min:0"]],
    ["database_backup_retention_days_locally", ["integer", "min:0"]],
    ["database_backup_retention_max_storage_locally", ["numeric", "min:0"]],
    ["database_backup_retention_amount_s3", ["integer", "min:0"]],
    ["database_backup_retention_days_s3", ["integer", "min:0"]],
    ["database_backup_retention_max_storage_s3", ["numeric", "min:0"]],
    ["timeout", ["integer", "min:60", "max:36000"]],
    ["missing_backup_notification_days", ["integer", "min:0", "max:365"]],
  ];
  if (create) {
    return [
      ["frequency", ["required", "string"]],
      ["enabled", ["boolean"]],
      ["save_s3", ["boolean"]],
      ["disable_local_backup", ["boolean"]],
      ["dump_all", ["boolean"]],
      ["backup_now", ["boolean", "nullable"]],
      ...s3,
      ["databases_to_backup", ["string", "nullable"]],
      ...retention,
    ];
  }
  return [
    ["save_s3", ["boolean"]],
    ["disable_local_backup", ["boolean"]],
    ["backup_now", ["boolean", "nullable"]],
    ["enabled", ["boolean"]],
    ["dump_all", ["boolean"]],
    ...s3,
    ["databases_to_backup", ["string", "nullable"]],
    ["frequency", ["string"]],
    ...retention,
  ];
}

const validationError = (field: string, text: string): CoolifyAnswer => validationFailed([[field, [text]]]);
const s3Required = (): CoolifyAnswer => validationError("s3_storage_uuid", "The s3_storage_uuid or s3_storage_uuids field is required when save_s3 is true.");
const localWithoutS3 = (): CoolifyAnswer => validationError("disable_local_backup", "Local backups can only be disabled when save_s3 is true.");
const backupNowForbidden = (): CoolifyAnswer =>
  message("Missing required permissions: deploy. A backup that runs now copies the database on the server, so it needs a token with the deploy permission.", 403);

/** `exists:s3_storages,uuid`: Coolify looks in every team; Freeploy in the org's storages only (row-level security). */
const storageExists = (tx: SqlExecutor) => async (uuid: unknown) => (await rowsOf(tx)("s3_storages", "t.uuid = $1", [String(uuid)])).length > 0;

/**
 * requestedBackupS3Storages(): the destinations a request selects, primary first; an answer when they are not the
 * org's; null when the request selects none.
 */
async function requestedStorages(tx: SqlExecutor, all: Record<string, unknown>): Promise<ApiRow[] | CoolifyAnswer | null> {
  const hasList = "s3_storage_uuids" in all;
  if (!hasList && !filled(all.s3_storage_uuid)) return null;
  const listed = hasList ? (Array.isArray(all.s3_storage_uuids) ? all.s3_storage_uuids : Object.values((all.s3_storage_uuids ?? {}) as object)) : [all.s3_storage_uuid];
  const uuids = [...new Set(listed.map((u) => String(u)))];
  const primary = all.s3_storage_uuid ?? uuids[0];
  const errorField = hasList ? "s3_storage_uuids" : "s3_storage_uuid";
  if (filled(primary) && !uuids.includes(String(primary))) return validationError("s3_storage_uuid", "The s3_storage_uuid must be one of the s3_storage_uuids.");
  const storages = uuids.length ? await rowsOf(tx)("s3_storages", "t.uuid = ANY($1)", [uuids]) : [];
  if (storages.length !== uuids.length) return validationError(errorField, "The selected S3 storage is invalid for this team.");
  return [...storages.filter((s) => rowValue(s, "uuid") === primary), ...storages.filter((s) => rowValue(s, "uuid") !== primary)];
}

/** validateDatabasesBackupInput()'s refusal, as Coolify's catch writes it. */
function databasesToBackupError(value: unknown): CoolifyAnswer | null {
  if (!phpTruthy(value)) return null;
  try {
    validateDatabasesBackupInput(String(value));
    return null;
  } catch (e) {
    return validationError("databases_to_backup", e instanceof BackupError ? e.message : String(e));
  }
}

/** The schedule's columns as the request changes them: what it gives over what is stored. */
function backupChanges(current: Record<string, unknown>, data: Record<string, unknown>): DatabaseBackupChanges {
  const pick = (k: string) => (k in data ? data[k] : current[k]);
  const int = (k: string) => Math.trunc(Number(pick(k) ?? 0));
  return {
    enabled: phpBool(pick("enabled")),
    frequency: String(pick("frequency")),
    databaseBackupRetentionAmountLocally: int("database_backup_retention_amount_locally"),
    databaseBackupRetentionDaysLocally: int("database_backup_retention_days_locally"),
    databaseBackupRetentionMaxStorageLocally: Number(pick("database_backup_retention_max_storage_locally") ?? 0),
    databaseBackupRetentionAmountS3: int("database_backup_retention_amount_s3"),
    databaseBackupRetentionDaysS3: int("database_backup_retention_days_s3"),
    databaseBackupRetentionMaxStorageS3: Number(pick("database_backup_retention_max_storage_s3") ?? 0),
    saveS3: phpBool(pick("save_s3")),
    disableLocalBackup: phpBool(pick("disable_local_backup")),
    databasesToBackup: (pick("databases_to_backup") as string | null | undefined) ?? null,
    dumpAll: phpBool(pick("dump_all")),
    timeout: int("timeout"),
    missingBackupNotificationDays: int("missing_backup_notification_days"),
  };
}

const rowObject = (row: ApiRow): Record<string, unknown> => Object.fromEntries(row);

/** create_backup() */
async function createBackup(c: ApiV1Context, routeUuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  return c.sql(c.env, c.orgId, async (tx) => {
    const errors: Errors = [];
    await validateRules(errors, all, backupRules(true, storageExists(tx)));
    if (errors.length) return validationFailed(errors);
    const uuid = param(c, all, "uuid", routeUuid);
    if (!phpTruthy(uuid)) return message("UUID is required.", 404);
    const f = await findDatabase(tx, uuid);
    if (!f) return message("Database not found.", 404);
    const no = await denied(c, true);
    if (no) return no;
    if (phpTruthy(all.backup_now) && !hasDeployAbility(c)) return backupNowForbidden();
    if (!backupSolutionAvailable(f.engine)) return message("Scheduled backups are not supported for this database type.", 422);
    if (!validateCronExpressionStrict(all.frequency)) return validationError("frequency", "Invalid cron expression or frequency format.");
    const storages = await requestedStorages(tx, all);
    if (storages !== null && !Array.isArray(storages)) return storages;
    if (requestBoolean(all, "save_s3") && (storages === null || storages.length === 0)) return s3Required();
    if (requestBoolean(all, "disable_local_backup") && !requestBoolean(all, "save_s3")) return localWithoutS3();
    const extra = Object.keys(all).filter((k) => !BACKUP_FIELDS.includes(k) && k !== "backup_now");
    if (extra.length) {
      const list: Errors = [];
      for (const k of extra) addError(list, k, "This field is not allowed.");
      return validationFailed(list);
    }
    const data: Record<string, unknown> = Object.fromEntries(Object.entries(all).filter(([k]) => BACKUP_FIELDS.includes(k) && k !== "s3_storage_uuid" && k !== "s3_storage_uuids"));
    // The database the container creates, when the request names none.
    if (!phpTruthy(data.databases_to_backup)) {
      const column = { postgresql: "postgres_db", mysql: "mysql_database", mariadb: "mariadb_database", clickhouse: "clickhouse_db" }[f.engine as string];
      if (column) data.databases_to_backup = rowValue(f.row, column) ?? null;
    }
    const refused = databasesToBackupError(data.databases_to_backup);
    if (refused) return refused;
    if (!("enabled" in data)) data.enabled = true;
    data.save_s3 ??= false;
    // DatabaseBackupJob: the dump runs on the server (Freeploy's convention: refused before anything is stored).
    if (phpTruthy(all.backup_now)) return unavailable(DATABASES_API_MESSAGES.backupNowUnavailable);

    const created = await insertDatabaseBackup(tx, { orgId: c.orgId, uuid: newPublicId(), frequency: String(data.frequency), databaseType: morphOf(f), databaseId: rowValue(f.row, "id") as string | number, databasesToBackup: (data.databases_to_backup as string | null | undefined) ?? null });
    await updateDatabaseBackup(tx, created.id, backupChanges(created, data));
    if (storages !== null) {
      await setDatabaseBackupPrimaryStorage(tx, created.id, storages[0] ? (rowValue(storages[0], "id") as string | number) : null);
      await syncScheduleS3Storages(tx, "database", created.id, storages.map((s) => rowValue(s, "id") as string | number), c.orgId);
    }
    return coolifyJson(obj({ uuid: created.uuid, message: "Backup configuration created successfully." }), 201);
  });
}

/** update_backup() */
async function updateBackup(c: ApiV1Context, routeUuid: string, routeBackup: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  return c.sql(c.env, c.orgId, async (tx) => {
    const errors: Errors = [];
    await validateRules(errors, all, backupRules(false, storageExists(tx)));
    if (errors.length) return validationFailed(errors);
    const uuid = param(c, all, "uuid", routeUuid);
    if (!phpTruthy(uuid)) return message("UUID is required.", 404);
    const backupUuid = param(c, all, "scheduled_backup_uuid", routeBackup);
    if (!phpTruthy(backupUuid)) return message("Scheduled backup UUID is required.", 400);
    const data = removeUnnecessary(all);
    const f = await findDatabase(tx, uuid);
    if (!f) return message("Database not found.", 404);
    const no = await denied(c, true, POLICY_DENIALS.databaseUpdate);
    if (no) return no;
    if (phpTruthy(data.backup_now) && !hasDeployAbility(c)) return backupNowForbidden();
    if (filled(data.frequency) && !validateCronExpressionStrict(data.frequency)) return validationError("frequency", "Invalid cron expression or frequency format.");
    const storages = await requestedStorages(tx, data);
    if (storages !== null && !Array.isArray(storages)) return storages;
    const b = (await backupRows(tx, f, String(backupUuid)))[0];
    if (!b) return message("Backup config not found.", 404);
    const current = rowObject(b);
    const saveToS3 = "save_s3" in data ? requestBoolean(data, "save_s3") : Boolean(current.save_s3);
    if ((requestBoolean(data, "save_s3") && storages === null) || (saveToS3 && storages !== null && storages.length === 0)) return s3Required();
    const extra = Object.keys(data).filter((k) => !BACKUP_FIELDS.includes(k) && k !== "backup_now");
    if (extra.length) {
      const list: Errors = [];
      for (const k of extra) addError(list, k, "This field is not allowed.");
      return validationFailed(list);
    }
    if (requestBoolean(data, "disable_local_backup") && !saveToS3) return localWithoutS3();
    const changes: Record<string, unknown> = Object.fromEntries(Object.entries(data).filter(([k]) => BACKUP_FIELDS.includes(k) && k !== "s3_storage_uuid" && k !== "s3_storage_uuids"));
    // Without S3 the backup must stay on the server, as in the UI.
    if (!saveToS3) changes.disable_local_backup = false;
    const refused = databasesToBackupError(changes.databases_to_backup);
    if (refused) return refused;
    // An older client sends only s3_storage_uuid: when it is already a destination, the other destinations stay.
    let storageIds = storages === null ? null : storages.map((s) => rowValue(s, "id") as string | number);
    if (storageIds !== null && !("s3_storage_uuids" in data)) {
      const pivots = await rowsOf(tx)("scheduled_database_backup_s3_storage", "t.scheduled_database_backup_id = $1", [current.id]);
      const currentIds = pivots.map((p) => rowValue(p, "s3_storage_id") as string | number);
      if (currentIds.some((id) => String(id) === String(storageIds![0]))) storageIds = currentIds;
    }
    if (phpTruthy(data.backup_now)) return unavailable(DATABASES_API_MESSAGES.backupNowUnavailable);

    const found = (await findDatabaseBackup(tx, morphOf(f), rowValue(f.row, "id") as string | number, String(current.uuid)))!;
    await updateDatabaseBackup(tx, found.id, backupChanges(found, changes));
    if (storages !== null) await setDatabaseBackupPrimaryStorage(tx, found.id, storages[0] ? (rowValue(storages[0], "id") as string | number) : null);
    if (storageIds !== null) await syncScheduleS3Storages(tx, "database", found.id, storageIds, c.orgId);
    return message("Database backup configuration updated", 200);
  });
}

/** Server::isFunctional() of the database's server: only then are a backup's local files deleted. */
const serverFunctional = async (tx: SqlExecutor, c: ApiV1Context, f: FoundDatabase): Promise<boolean> => (await showDatabase(databaseContext(tx, c), f.db.uuid, true))!.serverStatus;

/** delete_backup_by_uuid() */
async function deleteBackup(c: ApiV1Context, routeUuid: string, routeBackup: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const backupUuid = param(c, {}, "scheduled_backup_uuid", routeBackup);
    if (!phpTruthy(backupUuid)) return message("Scheduled backup UUID is required.", 400);
    const f = await findDatabase(tx, param(c, {}, "uuid", routeUuid));
    if (!f) return message("Database not found.", 404);
    const no = await denied(c, true);
    if (no) return no;
    const b = (await backupRows(tx, f, String(backupUuid)))[0];
    if (!b) return message("Backup configuration not found.", 404);
    const deleteS3 = queryBool(c, "delete_s3");
    const executions = await executionRows(tx, rowValue(b, "id"));
    const functional = await serverFunctional(tx, c, f);
    for (const x of executions) {
      if (functional && phpTruthy(rowValue(x, "filename")) && rowValue(x, "local_storage_deleted") !== true) return unavailable(DATABASES_API_MESSAGES.deleteLocalUnavailable);
      if (deleteS3 && (await databaseBackupExecutionLiveS3Copies(tx, rowValue(x, "id") as string | number)) > 0) return unavailable(DATABASES_API_MESSAGES.deleteS3Unavailable);
    }
    await deleteDatabaseBackup(tx, rowValue(b, "id") as string | number);
    return message("Backup configuration and all executions deleted.", 200);
  });
}

/** $request->boolean($key, false) of the query string. */
function queryBool(c: ApiV1Context, name: string): boolean {
  const v = c.url.searchParams.get(name);
  return v !== null && ["1", "true", "on", "yes"].includes(v.toLowerCase());
}

/** list_backup_executions() */
async function listExecutions(c: ApiV1Context, routeUuid: string, routeBackup: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const backupUuid = param(c, {}, "scheduled_backup_uuid", routeBackup);
    if (!phpTruthy(backupUuid)) return message("Scheduled backup UUID is required.", 400);
    const f = await findDatabase(tx, param(c, {}, "uuid", routeUuid));
    if (!f) return message("Database not found.", 404);
    const b = (await backupRows(tx, f, String(backupUuid)))[0];
    if (!b) return message("Backup configuration not found.", 404);
    const secrets = new Map<string, LogSecrets | null>();
    const out: PhpObject[] = [];
    for (const x of await executionRows(tx, rowValue(b, "id"))) {
      const size = rowValue(x, "size");
      out.push(
        obj([
          ["uuid", rowValue(x, "uuid") as PhpValue],
          ["filename", (rowValue(x, "filename") ?? null) as PhpValue],
          ["size", size === null || size === undefined ? null : Number.parseInt(String(size), 10) || 0],
          ["created_at", iso8601(rowValue(x, "created_at"))],
          ["message", await executionMessage(tx, c, f, rowValue(x, "message"), secrets)],
          ["status", (rowValue(x, "status") ?? null) as PhpValue],
        ]),
      );
    }
    return coolifyJson(obj({ executions: out }));
  });
}

/** Carbon's toIso8601String() of a UTC timestamp: 2026-01-01T00:00:00+00:00. */
function iso8601(value: unknown): PhpValue {
  if (value === null || value === undefined) return null;
  const text = String(value);
  const d = new Date(/[+-]\d\d:\d\d$|Z$/.test(text) ? text : `${text}Z`);
  return `${d.toISOString().slice(0, 19)}+00:00`;
}

/** delete_execution_by_uuid() */
async function deleteExecution(c: ApiV1Context, routeUuid: string, routeBackup: string, routeExecution: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const backupUuid = param(c, {}, "scheduled_backup_uuid", routeBackup);
    if (!phpTruthy(backupUuid)) return message("Scheduled backup UUID is required.", 400);
    const executionUuid = param(c, {}, "execution_uuid", routeExecution);
    if (!phpTruthy(executionUuid)) return message("Execution UUID is required.", 400);
    const f = await findDatabase(tx, param(c, {}, "uuid", routeUuid));
    if (!f) return message("Database not found.", 404);
    const no = await denied(c, true);
    if (no) return no;
    const b = (await backupRows(tx, f, String(backupUuid)))[0];
    if (!b) return message("Backup configuration not found.", 404);
    const x = (await executionRows(tx, rowValue(b, "id"))).find((e) => rowValue(e, "uuid") === String(executionUuid));
    if (!x) return message("Backup execution not found.", 404);
    // An unreachable server keeps the local file, as when the UI skips the local delete.
    if (phpTruthy(rowValue(x, "filename")) && rowValue(x, "local_storage_deleted") !== true && (await serverFunctional(tx, c, f))) return unavailable(DATABASES_API_MESSAGES.deleteLocalUnavailable);
    if (queryBool(c, "delete_s3") && (await databaseBackupExecutionLiveS3Copies(tx, rowValue(x, "id") as string | number)) > 0) return unavailable(DATABASES_API_MESSAGES.deleteS3Unavailable);
    await deleteDatabaseBackupExecution(tx, rowValue(x, "id") as string | number);
    return message("Backup execution deleted.", 200);
  });
}

