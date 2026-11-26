// Derived from coollabsio/coolify@91b7e3e:app/Models/Standalone{Postgresql,Redis,Mysql,Mariadb,Mongodb,Keydb,Dragonfly,Clickhouse}.php
// (the fillable columns, the `encrypted` casts, the created and forceDeleting hooks, the relations),
// bootstrap/helpers/databases.php (create_standalone_*: the row a database starts as), app/Models/Environment.php
// (databases()), app/Jobs/DeleteResourceJob.php (deleteLocalResource) and app/Traits/{HasSecretManager,HasStars,
// HasImageScans}.php (what goes with a deleted model) (Apache-2.0), modified.
//
// The eight deploy.standalone_* tables of the standalone databases, as one
// implementation with the engine as a parameter: the tables share their
// columns but for each engine's credentials and configuration, which are
// listed per engine below. Every function takes the transaction of withOrg():
// row-level security confines each query to that org, which is what Coolify's
// ownedByCurrentTeam() does. A soft-deleted database (deleted_at) is never
// returned, as with Eloquent's SoftDeletes scope.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { DESTINATION_MORPH_CLASS, type DestinationType } from "./destinations.js";
import { FILE_VOLUME_MORPH_CLASS, PERSISTENT_VOLUME_MORPH_CLASS, insertPersistentVolume, type StorageOwner } from "./storages.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** The standalone database engines, in Create::createResource()'s order (SQLite is not ported). */
export const DATABASE_ENGINES = ["postgresql", "redis", "mongodb", "mysql", "mariadb", "keydb", "dragonfly", "clickhouse"] as const;
export type DatabaseEngine = (typeof DATABASE_ENGINES)[number];

export interface DatabaseTable {
  /** The table in the deploy schema. */
  table: string;
  /** getMorphClass(): what resource_type, resourceable_type, taggable_type and database_type hold (Coolify has no morph map). */
  morphClass: string;
  /** The engine's own columns: credentials, configuration. */
  columns: readonly string[];
  /** The `encrypted` casts among them: the stored value is the caller's ciphertext, bound to "<table>.<column>". */
  encrypted: readonly string[];
  /** JSON columns among them. */
  json: readonly string[];
  /** The table has enable_ssl, ssl_mode, legacy_password_quoting. */
  enableSsl: boolean;
  sslMode: boolean;
  legacyPasswordQuoting: boolean;
}

export const DATABASE_TABLES: Readonly<Record<DatabaseEngine, DatabaseTable>> = {
  postgresql: {
    table: "standalone_postgresqls",
    morphClass: "App\\Models\\StandalonePostgresql",
    columns: ["postgres_user", "postgres_password", "postgres_db", "postgres_initdb_args", "postgres_host_auth_method", "postgres_conf", "init_scripts"],
    encrypted: ["postgres_password"],
    json: ["init_scripts"],
    enableSsl: true,
    sslMode: true,
    legacyPasswordQuoting: false,
  },
  redis: {
    table: "standalone_redis",
    morphClass: "App\\Models\\StandaloneRedis",
    columns: ["redis_conf"],
    encrypted: [],
    json: [],
    enableSsl: true,
    sslMode: false,
    legacyPasswordQuoting: true,
  },
  mongodb: {
    table: "standalone_mongodbs",
    morphClass: "App\\Models\\StandaloneMongodb",
    columns: ["mongo_conf", "mongo_initdb_root_username", "mongo_initdb_root_password", "mongo_initdb_database"],
    encrypted: ["mongo_initdb_root_password"],
    json: [],
    enableSsl: true,
    sslMode: true,
    legacyPasswordQuoting: false,
  },
  mysql: {
    table: "standalone_mysqls",
    morphClass: "App\\Models\\StandaloneMysql",
    columns: ["mysql_root_password", "mysql_user", "mysql_password", "mysql_database", "mysql_conf"],
    encrypted: ["mysql_password", "mysql_root_password"],
    json: [],
    enableSsl: true,
    sslMode: true,
    legacyPasswordQuoting: false,
  },
  mariadb: {
    table: "standalone_mariadbs",
    morphClass: "App\\Models\\StandaloneMariadb",
    columns: ["mariadb_root_password", "mariadb_user", "mariadb_password", "mariadb_database", "mariadb_conf"],
    encrypted: ["mariadb_password", "mariadb_root_password"],
    json: [],
    enableSsl: true,
    sslMode: false,
    legacyPasswordQuoting: false,
  },
  keydb: {
    table: "standalone_keydbs",
    morphClass: "App\\Models\\StandaloneKeydb",
    columns: ["keydb_password", "keydb_conf"],
    encrypted: ["keydb_password"],
    json: [],
    enableSsl: true,
    sslMode: false,
    legacyPasswordQuoting: true,
  },
  dragonfly: {
    table: "standalone_dragonflies",
    morphClass: "App\\Models\\StandaloneDragonfly",
    columns: ["dragonfly_password"],
    encrypted: ["dragonfly_password"],
    json: [],
    enableSsl: true,
    sslMode: false,
    legacyPasswordQuoting: true,
  },
  clickhouse: {
    table: "standalone_clickhouses",
    morphClass: "App\\Models\\StandaloneClickhouse",
    columns: ["clickhouse_admin_user", "clickhouse_admin_password", "clickhouse_db"],
    encrypted: ["clickhouse_admin_password"],
    json: [],
    enableSsl: false,
    sslMode: false,
    legacyPasswordQuoting: false,
  },
};

/** The owner of a database's volumes, variables, tags and certificates: its morph class and id. */
export const databaseOwner = (engine: DatabaseEngine, id: string | number): StorageOwner => ({ type: DATABASE_TABLES[engine].morphClass, id });

/** The columns every engine's table has. */
const COMMON_COLUMNS = [
  "id", "uuid", "name", "description", "status", "image", "is_public", "public_port", "public_port_timeout", "ports_mappings",
  "started_at", "destination_id", "destination_type", "environment_id", "is_log_drain_enabled", "config_hash",
  "custom_docker_run_options", "last_online_at", "created_at", "updated_at",
] as const;

/** A standalone database with where it lives: environment, project, destination, server. */
export interface DeployDatabaseRow extends SqlRow {
  engine: DatabaseEngine;
  id: string | number;
  uuid: string;
  name: string;
  description: string | null;
  status: string;
  image: string;
  is_public: boolean;
  public_port: number | null;
  public_port_timeout: number | null;
  ports_mappings: string | null;
  started_at: string | Date | null;
  destination_id: string | number;
  destination_type: string;
  environment_id: string | number | null;
  is_log_drain_enabled: boolean;
  config_hash: string | null;
  custom_docker_run_options: string | null;
  last_online_at: string | Date | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
  /** null where the engine's table has no such column. */
  enable_ssl: boolean | null;
  ssl_mode: string | null;
  legacy_password_quoting: boolean | null;
  // environment and project
  environment_uuid: string;
  environment_name: string;
  project_uuid: string;
  project_name: string;
  // destination (standalone or Swarm, by destination_type) and its server
  destination_uuid: string | null;
  destination_name: string | null;
  destination_network: string | null;
  server_id: string | number | null;
  server_uuid: string | null;
  server_name: string | null;
  server_ip: string | null;
  server_is_swarm_manager: boolean | null;
  server_is_swarm_worker: boolean | null;
  server_is_reachable: boolean | null;
  server_is_usable: boolean | null;
  server_force_disabled: boolean | null;
  server_is_logdrain_newrelic_enabled: boolean | null;
  server_is_logdrain_axiom_enabled: boolean | null;
  server_is_logdrain_custom_enabled: boolean | null;
  server_is_logdrain_cloudwatch_enabled: boolean | null;
  // The engine's own columns (DATABASE_TABLES[engine].columns) are read by name.
}

const STANDALONE = DESTINATION_MORPH_CLASS.standalone.replace(/\\/g, "\\\\");
const SWARM = DESTINATION_MORPH_CLASS.swarm.replace(/\\/g, "\\\\");

/** What one engine's SELECT reads of its own table: the common columns, the optional ones (null where absent), and — unless `common` — its own. */
function tableColumns(engine: DatabaseEngine, common: boolean): string {
  const t = DATABASE_TABLES[engine];
  return [
    `'${engine}'::text AS engine`,
    ...COMMON_COLUMNS.map((c) => `d."${c}"`),
    t.enableSsl ? "d.enable_ssl" : "NULL::boolean AS enable_ssl",
    t.sslMode ? "d.ssl_mode" : "NULL::varchar AS ssl_mode",
    t.legacyPasswordQuoting ? "d.legacy_password_quoting" : "NULL::boolean AS legacy_password_quoting",
    ...(common ? [] : t.columns.map((c) => `d."${c}"`)),
  ].join(", ");
}

/** $database with environment.project and destination.server (the morphTo by destination_type). */
function selectDatabase(engine: DatabaseEngine, common = false): string {
  return `SELECT ${tableColumns(engine, common)},
       e.uuid AS environment_uuid, e.name AS environment_name, p.uuid AS project_uuid, p.name AS project_name,
       COALESCE(sd.uuid, wd.uuid) AS destination_uuid, COALESCE(sd.name, wd.name) AS destination_name,
       COALESCE(sd.network, wd.network) AS destination_network,
       s.id AS server_id, s.uuid AS server_uuid, s.name AS server_name, s.ip AS server_ip,
       ss.is_swarm_manager AS server_is_swarm_manager, ss.is_swarm_worker AS server_is_swarm_worker,
       ss.is_reachable AS server_is_reachable, ss.is_usable AS server_is_usable, ss.force_disabled AS server_force_disabled,
       ss.is_logdrain_newrelic_enabled AS server_is_logdrain_newrelic_enabled,
       ss.is_logdrain_axiom_enabled AS server_is_logdrain_axiom_enabled,
       ss.is_logdrain_custom_enabled AS server_is_logdrain_custom_enabled,
       ss.is_logdrain_cloudwatch_enabled AS server_is_logdrain_cloudwatch_enabled
  FROM deploy.${DATABASE_TABLES[engine].table} d
  JOIN deploy.environments e ON e.id = d.environment_id
  JOIN deploy.projects p ON p.id = e.project_id
  LEFT JOIN deploy.standalone_dockers sd ON sd.id = d.destination_id AND d.destination_type = E'${STANDALONE}'
  LEFT JOIN deploy.swarm_dockers wd ON wd.id = d.destination_id AND d.destination_type = E'${SWARM}'
  LEFT JOIN deploy.servers s ON s.id = COALESCE(sd.server_id, wd.server_id) AND s.deleted_at IS NULL
  LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id`;
}

/** Which engine's table holds the database with this uuid ($environment->databases() looks in every one). */
export async function findDatabaseEngineByUuid(tx: SqlExecutor, uuid: string): Promise<DatabaseEngine | null> {
  const r = await tx.execute<{ engine: DatabaseEngine }>(
    DATABASE_ENGINES.map((engine) => `SELECT '${engine}'::text AS engine FROM deploy.${DATABASE_TABLES[engine].table} WHERE uuid = $1 AND deleted_at IS NULL`).join(" UNION ALL "),
    [uuid],
  );
  return r.rows[0]?.engine ?? null;
}

/** The database with this uuid, whatever its engine; null when it is not the org's. */
export async function findDatabaseByUuid(tx: SqlExecutor, uuid: string): Promise<DeployDatabaseRow | null> {
  const engine = await findDatabaseEngineByUuid(tx, uuid);
  if (!engine) return null;
  const r = await tx.execute<DeployDatabaseRow>(`${selectDatabase(engine)} WHERE d.uuid = $1 AND d.deleted_at IS NULL`, [uuid]);
  return r.rows[0] ?? null;
}

/**
 * $environment->databases() (Resource\Index): the environment's databases of
 * every engine, in the engines' order and oldest first within one — with the
 * columns the engines share only.
 */
export async function listEnvironmentDatabases(tx: SqlExecutor, environmentId: string | number): Promise<DeployDatabaseRow[]> {
  const parts = DATABASE_ENGINES.map((engine, i) => `SELECT ${i} AS engine_order, q.* FROM (${selectDatabase(engine, true)} WHERE d.environment_id = $1 AND d.deleted_at IS NULL) q`);
  const r = await tx.execute<DeployDatabaseRow>(`SELECT * FROM (${parts.join(" UNION ALL ")}) u ORDER BY u.engine_order, u.id`, [environmentId]);
  return r.rows;
}

/**
 * ServerCanvas::loadResources()'s standalone databases (DP-98): every database of the org (row-level security), in the
 * engines' order and oldest first within one, with the columns the engines share only.
 */
export async function listOrgDatabases(tx: SqlExecutor): Promise<DeployDatabaseRow[]> {
  const parts = DATABASE_ENGINES.map((engine, i) => `SELECT ${i} AS engine_order, q.* FROM (${selectDatabase(engine, true)} WHERE d.deleted_at IS NULL) q`);
  const r = await tx.execute<DeployDatabaseRow>(`SELECT * FROM (${parts.join(" UNION ALL ")}) u ORDER BY u.engine_order, u.id`);
  return r.rows;
}

/** A value of a database column as it is bound: text, number, boolean or null (a JSON column takes its text). */
export type DatabaseColumnValue = string | number | boolean | null;

/** The common columns create_standalone_*() and General may write, beside each engine's own. */
export const DATABASE_GENERAL_COLUMNS = [
  "name", "description", "image", "ports_mappings", "is_public", "public_port", "public_port_timeout", "is_log_drain_enabled", "custom_docker_run_options",
] as const;

/**
 * The common columns Coolify's /api/v1 also writes (DP-73): create_standalone_*()'s and update_by_uuid's resource
 * limits, health check and log settings, which the console writes through their own pages.
 */
export const DATABASE_API_COLUMNS = [
  "limits_memory", "limits_memory_swap", "limits_memory_swappiness", "limits_memory_reservation", "limits_cpus", "limits_cpuset", "limits_cpu_shares",
  "health_check_enabled", "health_check_interval", "health_check_timeout", "health_check_retries", "health_check_start_period",
  "redact_all_env_values_in_logs", "include_coolify_default_variables",
] as const;

/** The columns of an engine a caller may write: General's, the API's, the SSL ones the table has, and the engine's own. */
export function writableDatabaseColumns(engine: DatabaseEngine): string[] {
  const t = DATABASE_TABLES[engine];
  return [...DATABASE_GENERAL_COLUMNS, ...DATABASE_API_COLUMNS, ...(t.enableSsl ? ["enable_ssl"] : []), ...(t.sslMode ? ["ssl_mode"] : []), ...t.columns];
}

export interface NewDatabaseVolume {
  /** BaseModel's creating hook: new_public_id(). */
  uuid: string;
  name: string;
  mountPath: string;
}

/** What create_standalone_*() stores, after the model's hooks. */
export interface NewDatabase {
  orgId: string;
  /** new_public_id() */
  uuid: string;
  name: string;
  environmentId: string | number;
  destinationId: string | number;
  destinationType: DestinationType;
  /**
   * What the helper sets beside the uuid, the name and where the database
   * lives: the image when one was chosen, the generated passwords (already
   * encrypted for their columns), a Supabase image's user. Every other column
   * keeps the schema's default.
   */
  values: Readonly<Record<string, DatabaseColumnValue>>;
  /** The created hook's LocalPersistentVolume rows, in its order. */
  volumes: readonly NewDatabaseVolume[];
}

function assertWritable(engine: DatabaseEngine, columns: readonly string[]): void {
  const writable = writableDatabaseColumns(engine);
  for (const column of columns) if (!writable.includes(column)) throw new Error(`deploy.${DATABASE_TABLES[engine].table} has no writable column "${column}"`);
}

/**
 * $database->save() in create_standalone_*(), with the created hook: the
 * database's row, then its data volumes (LocalPersistentVolume::create()),
 * each with the org.
 */
export async function insertDatabase(tx: SqlExecutor, engine: DatabaseEngine, database: NewDatabase): Promise<DeployDatabaseRow> {
  const t = DATABASE_TABLES[engine];
  const columns = Object.keys(database.values);
  assertWritable(engine, columns);
  const fixed = ["uuid", "name", "environment_id", "destination_id", "destination_type", "org_id"];
  const params: DatabaseColumnValue[] = [database.uuid, database.name, database.environmentId, database.destinationId, DESTINATION_MORPH_CLASS[database.destinationType], database.orgId];
  const placeholders = [...fixed, ...columns].map((c, i) => `$${i + 1}${t.json.includes(c) ? "::json" : ""}`);
  const inserted = await tx.execute<{ id: string | number }>(
    `INSERT INTO deploy.${t.table} (${[...fixed, ...columns].map((c) => `"${c}"`).join(", ")}, created_at, updated_at)
     VALUES (${placeholders.join(", ")}, ${NOW}, ${NOW}) RETURNING id`,
    [...params, ...columns.map((c) => database.values[c] ?? null)],
  );
  const owner = databaseOwner(engine, inserted.rows[0]!.id);
  for (const volume of database.volumes) {
    await insertPersistentVolume(tx, { orgId: database.orgId, owner, uuid: volume.uuid, name: volume.name, mountPath: volume.mountPath, hostPath: null });
  }
  return (await findDatabaseByUuid(tx, database.uuid))!;
}

/** $database->save(): only the given columns (the dirty ones), and updated_at. Null when the database is not there. */
export async function updateDatabase(tx: SqlExecutor, engine: DatabaseEngine, id: string | number, changes: Readonly<Record<string, DatabaseColumnValue>>): Promise<DeployDatabaseRow | null> {
  const t = DATABASE_TABLES[engine];
  const columns = Object.keys(changes);
  assertWritable(engine, columns);
  const sets = columns.map((c, i) => `"${c}" = $${i + 2}${t.json.includes(c) ? "::json" : ""}`);
  const r = await tx.execute<{ uuid: string }>(
    `UPDATE deploy.${t.table} SET ${[...sets, `updated_at = ${NOW}`].join(", ")} WHERE id = $1 AND deleted_at IS NULL RETURNING uuid`,
    [id, ...columns.map((c) => changes[c] ?? null)],
  );
  return r.rows[0] ? findDatabaseByUuid(tx, r.rows[0].uuid) : null;
}

/** A variable of a database, as runtime_environment_variables() reads it. */
export interface DeployDatabaseVariableRow extends SqlRow {
  id: string | number;
  uuid: string | null;
  key: string;
  /** The fp1 ciphertext of the value, or null. */
  value: string | null;
  is_shown_once: boolean;
  is_shared: boolean;
}

/** $database->runtime_environment_variables()->where('key', $key)->first(): the oldest variable with this key. */
export async function findDatabaseVariable(tx: SqlExecutor, owner: StorageOwner, key: string): Promise<DeployDatabaseVariableRow | null> {
  const r = await tx.execute<DeployDatabaseVariableRow>(
    `SELECT id, uuid, "key", "value", is_shown_once, is_shared FROM deploy.environment_variables
      WHERE resourceable_type = $1 AND resourceable_id = $2 AND "key" = $3 ORDER BY id LIMIT 1`,
    [owner.type, owner.id, key],
  );
  return r.rows[0] ?? null;
}

export interface NewDatabaseVariable {
  orgId: string;
  /** BaseModel's creating hook: new_public_id(). */
  uuid: string;
  key: string;
  /** The value already encrypted for environment_variables.value, or null. */
  value: string | null;
  /** The saving hook's updateIsShared(): the value references a shared variable. */
  isShared: boolean;
  /** The creating hook: config('constants.coolify.version'). */
  version: string;
}

/**
 * EnvironmentVariable::create() for a database's variable: the key, the value
 * and is_shared, with the model's defaults (is_runtime and is_buildtime true)
 * and the creating hook's version. A database has no preview variables.
 */
export async function insertDatabaseVariable(tx: SqlExecutor, owner: StorageOwner, variable: NewDatabaseVariable): Promise<DeployDatabaseVariableRow> {
  const r = await tx.execute<DeployDatabaseVariableRow>(
    `INSERT INTO deploy.environment_variables ("key", "value", is_shared, is_runtime, is_buildtime, uuid, version, resourceable_type, resourceable_id, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, true, true, $4, $5, $6, $7, $8, ${NOW}, ${NOW})
     RETURNING id, uuid, "key", "value", is_shown_once, is_shared`,
    [variable.key, variable.value, variable.isShared, variable.uuid, variable.version, owner.type, owner.id, variable.orgId],
  );
  return r.rows[0]!;
}

/** updateOrCreate()'s update: the variable's value and is_shared, and updated_at. */
export async function updateDatabaseVariableValue(tx: SqlExecutor, owner: StorageOwner, id: string | number, value: string | null, isShared: boolean): Promise<boolean> {
  const r = await tx.execute(
    `UPDATE deploy.environment_variables SET "value" = $4, is_shared = $5, updated_at = ${NOW} WHERE resourceable_type = $1 AND resourceable_id = $2 AND id = $3 RETURNING id`,
    [owner.type, owner.id, id, value, isShared],
  );
  return r.rows.length > 0;
}

/** $database->sslCertificates()->first()?->valid_until: when the database's certificate ends, or null without one. */
export async function findDatabaseCertificateValidUntil(tx: SqlExecutor, owner: StorageOwner): Promise<string | Date | null> {
  const r = await tx.execute<{ valid_until: string | Date }>(
    "SELECT valid_until FROM deploy.ssl_certificates WHERE resource_type = $1 AND resource_id = $2 ORDER BY id LIMIT 1",
    [owner.type, owner.id],
  );
  return r.rows[0]?.valid_until ?? null;
}

/**
 * deleteLocalResource() and forceDelete() for a database, in Coolify's order:
 *
 *   the backup schedules of its volumes and file mounts (with their
 *   executions and S3 links), its volumes (the forceDeleting hook deletes
 *   them whatever `delete_volumes` says), its file mounts, its certificates,
 *   its database backup schedules (with their executions, those executions'
 *   S3 replicas, and the schedules' S3 links), its tags (the pivot rows: the
 *   tags stay), its variables, then what the model's traits remove with it —
 *   its image scans with their policy, ignores and notification states
 *   (HasImageScans), its secret manager link (HasSecretManager), its stars
 *   (HasStars) — and the database.
 *
 * False when the database is not there.
 */
export async function deleteDatabase(tx: SqlExecutor, engine: DatabaseEngine, id: string | number): Promise<boolean> {
  const t = DATABASE_TABLES[engine];
  const own = [t.morphClass, id];
  const volumeSchedules = `SELECT b.id FROM deploy.scheduled_volume_backups b
    WHERE (b.backupable_type = $3 AND b.backupable_id IN (SELECT v.id FROM deploy.local_persistent_volumes v WHERE v.resource_type = $1 AND v.resource_id = $2))
       OR (b.backupable_type = $4 AND b.backupable_id IN (SELECT f.id FROM deploy.local_file_volumes f WHERE f.resource_type = $1 AND f.resource_id = $2))`;
  const morphs = [...own, PERSISTENT_VOLUME_MORPH_CLASS, FILE_VOLUME_MORPH_CLASS];
  await tx.execute(`DELETE FROM deploy.scheduled_volume_backup_executions WHERE scheduled_volume_backup_id IN (${volumeSchedules})`, morphs);
  await tx.execute(`DELETE FROM deploy.scheduled_volume_backup_s3_storage WHERE scheduled_volume_backup_id IN (${volumeSchedules})`, morphs);
  await tx.execute(`DELETE FROM deploy.scheduled_volume_backups WHERE id IN (${volumeSchedules})`, morphs);
  await tx.execute("DELETE FROM deploy.local_persistent_volumes WHERE resource_type = $1 AND resource_id = $2", own);
  await tx.execute("DELETE FROM deploy.local_file_volumes WHERE resource_type = $1 AND resource_id = $2", own);
  await tx.execute("DELETE FROM deploy.ssl_certificates WHERE resource_type = $1 AND resource_id = $2", own);
  const backups = "SELECT b.id FROM deploy.scheduled_database_backups b WHERE b.database_type = $1 AND b.database_id = $2";
  await tx.execute(
    `DELETE FROM deploy.database_backup_s3_replicas WHERE execution_id IN (SELECT x.id FROM deploy.scheduled_database_backup_executions x WHERE x.scheduled_database_backup_id IN (${backups}))`,
    own,
  );
  await tx.execute(`DELETE FROM deploy.scheduled_database_backup_executions WHERE scheduled_database_backup_id IN (${backups})`, own);
  await tx.execute(`DELETE FROM deploy.scheduled_database_backup_s3_storage WHERE scheduled_database_backup_id IN (${backups})`, own);
  await tx.execute("DELETE FROM deploy.scheduled_database_backups WHERE database_type = $1 AND database_id = $2", own);
  await tx.execute("DELETE FROM deploy.taggables WHERE taggable_type = $1 AND taggable_id = $2", own);
  await tx.execute("DELETE FROM deploy.environment_variables WHERE resourceable_type = $1 AND resourceable_id = $2", own);
  await tx.execute("DELETE FROM deploy.image_scans WHERE resource_type = $1 AND resource_id = $2", own);
  await tx.execute("DELETE FROM deploy.image_scan_policies WHERE scope_type = $1 AND scope_id = $2", own);
  await tx.execute("DELETE FROM deploy.image_scan_ignores WHERE resource_type = $1 AND resource_id = $2", own);
  await tx.execute("DELETE FROM deploy.image_scan_notification_states WHERE resource_type = $1 AND resource_id = $2", own);
  await tx.execute("DELETE FROM deploy.secret_manager_links WHERE resourceable_type = $1 AND resourceable_id = $2", own);
  await tx.execute("DELETE FROM deploy.stars WHERE starrable_type = $1 AND starrable_id = $2", own);
  const r = await tx.execute(`DELETE FROM deploy.${t.table} WHERE id = $1 RETURNING id`, [id]);
  return r.rows.length > 0;
}
