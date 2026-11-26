// Derived from coollabsio/coolify@91b7e3e:app/Actions/Database/Start*.php (what a start reads of a database and
// writes to it), app/Helpers/SslHelper.php (generateSslCertificate: the certificate row and its file mounts),
// app/Services/ResourceStatusRefresher.php (store), app/Models/Standalone*.php (the saving hook's
// last_online_at, runtime_environment_variables()) and app/Models/Server.php (isFunctional, isSwarm,
// dockerVersion) (Apache-2.0), modified.
//
// What starting, restarting and stopping a standalone database reads and writes (DP-62), for the nine engines
// at once. Every function takes the transaction of withOrg(): row-level security confines each query to that
// org. Encrypted columns stay as stored — these functions never decrypt.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { DATABASE_TABLES, type DatabaseEngine } from "./databases.js";
import { DESTINATION_MORPH_CLASS } from "./destinations.js";
import type { StorageOwner } from "./storages.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

const STANDALONE = DESTINATION_MORPH_CLASS.standalone.replace(/\\/g, "\\\\");
const SWARM = DESTINATION_MORPH_CLASS.swarm.replace(/\\/g, "\\\\");

/** A standalone database as a start reads it: every column of its table, and where it runs. */
export interface DeployDatabaseOperationRow extends SqlRow {
  engine: DatabaseEngine;
  id: string | number;
  uuid: string;
  name: string;
  status: string;
  image: string;
  is_public: boolean;
  public_port: number | null;
  public_port_timeout: number | null;
  ports_mappings: string | null;
  limits_memory: string;
  limits_memory_swap: string;
  limits_memory_swappiness: number;
  limits_memory_reservation: string;
  limits_cpus: string;
  limits_cpuset: string | null;
  limits_cpu_shares: number;
  started_at: string | Date | null;
  last_online_at: string | Date | null;
  is_log_drain_enabled: boolean;
  include_coolify_default_variables: boolean;
  custom_docker_run_options: string | null;
  /** HasDatabaseHealthCheck's columns (migration 660). */
  health_check_enabled: boolean;
  health_check_interval: number;
  health_check_timeout: number;
  health_check_retries: number;
  health_check_start_period: number;
  /** The restart counters (migration 660). */
  restart_count: number;
  last_restart_at: string | Date | null;
  last_restart_type: string | null;
  /** Absent where the engine's table has no such column (ClickHouse has no SSL; only Redis, KeyDB and Dragonfly have the quoting flag). */
  enable_ssl?: boolean;
  ssl_mode?: string;
  legacy_password_quoting?: boolean;
  environment_id: string | number;
  environment_name: string;
  project_id: string | number;
  project_name: string;
  destination_network: string | null;
  server_id: string | number | null;
  server_uuid: string | null;
  server_ip: string | null;
  server_user: string | null;
  server_is_reachable: boolean | null;
  server_is_usable: boolean | null;
  server_force_disabled: boolean | null;
  server_is_swarm_manager: boolean | null;
  server_is_swarm_worker: boolean | null;
  server_docker_version: string | null;
  server_is_logdrain_newrelic_enabled: boolean | null;
  server_is_logdrain_axiom_enabled: boolean | null;
  server_is_logdrain_custom_enabled: boolean | null;
  server_is_logdrain_cloudwatch_enabled: boolean | null;
  server_logdrain_cloudwatch_region: string | null;
  server_logdrain_cloudwatch_group: string | null;
  server_logdrain_cloudwatch_stream_prefix: string | null;
  // The engine's own columns (DATABASE_TABLES[engine].columns) are read by name.
}

/** $database with environment.project and destination.server, as the Start actions read them. */
export async function findDatabaseForOperation(tx: SqlExecutor, engine: DatabaseEngine, id: string | number): Promise<DeployDatabaseOperationRow | null> {
  const r = await tx.execute<DeployDatabaseOperationRow>(
    `SELECT '${engine}'::text AS engine, d.*,
            e.name AS environment_name, p.id AS project_id, p.name AS project_name,
            COALESCE(sd.network, wd.network) AS destination_network,
            s.id AS server_id, s.uuid AS server_uuid, s.ip AS server_ip, s."user" AS server_user,
            ss.is_reachable AS server_is_reachable, ss.is_usable AS server_is_usable, ss.force_disabled AS server_force_disabled,
            ss.is_swarm_manager AS server_is_swarm_manager, ss.is_swarm_worker AS server_is_swarm_worker,
            ss.docker_version AS server_docker_version,
            ss.is_logdrain_newrelic_enabled AS server_is_logdrain_newrelic_enabled,
            ss.is_logdrain_axiom_enabled AS server_is_logdrain_axiom_enabled,
            ss.is_logdrain_custom_enabled AS server_is_logdrain_custom_enabled,
            ss.is_logdrain_cloudwatch_enabled AS server_is_logdrain_cloudwatch_enabled,
            ss.logdrain_cloudwatch_region AS server_logdrain_cloudwatch_region,
            ss.logdrain_cloudwatch_group AS server_logdrain_cloudwatch_group,
            ss.logdrain_cloudwatch_stream_prefix AS server_logdrain_cloudwatch_stream_prefix
       FROM deploy.${DATABASE_TABLES[engine].table} d
       JOIN deploy.environments e ON e.id = d.environment_id
       JOIN deploy.projects p ON p.id = e.project_id
       LEFT JOIN deploy.standalone_dockers sd ON sd.id = d.destination_id AND d.destination_type = E'${STANDALONE}'
       LEFT JOIN deploy.swarm_dockers wd ON wd.id = d.destination_id AND d.destination_type = E'${SWARM}'
       LEFT JOIN deploy.servers s ON s.id = COALESCE(sd.server_id, wd.server_id) AND s.deleted_at IS NULL
       LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id
      WHERE d.id = $1 AND d.deleted_at IS NULL`,
    [id],
  );
  return r.rows[0] ?? null;
}

/** A variable of a database, as a start reads it. */
export interface DeployDatabaseStartVariableRow extends SqlRow {
  id: string | number;
  key: string;
  /** The fp1 ciphertext of the value, or null. */
  value: string | null;
  is_literal: boolean;
  is_multiline: boolean;
  uses_legacy_escaping: boolean;
}

/** $database->runtime_environment_variables: every variable of the database, oldest first. */
export async function listDatabaseStartVariables(tx: SqlExecutor, owner: StorageOwner): Promise<DeployDatabaseStartVariableRow[]> {
  const r = await tx.execute<DeployDatabaseStartVariableRow>(
    `SELECT id, "key", "value", is_literal, is_multiline, uses_legacy_escaping FROM deploy.environment_variables
      WHERE resourceable_type = $1 AND resourceable_id = $2 ORDER BY id`,
    [owner.type, owner.id],
  );
  return r.rows;
}

/**
 * Freeploy's: the database has been handed to a server. started_at is set once and kept: a database without it
 * has nothing on any server.
 */
export async function markDatabaseStarted(tx: SqlExecutor, engine: DatabaseEngine, id: string | number): Promise<boolean> {
  const r = await tx.execute(`UPDATE deploy.${DATABASE_TABLES[engine].table} SET started_at = COALESCE(started_at, ${NOW}), updated_at = ${NOW} WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id]);
  return r.rows.length > 0;
}

/** $database->update(['status' => …]), with the saving hook: a changed status sets last_online_at. */
export async function setDatabaseStatus(tx: SqlExecutor, engine: DatabaseEngine, id: string | number, status: string): Promise<boolean> {
  const r = await tx.execute(
    `UPDATE deploy.${DATABASE_TABLES[engine].table}
        SET last_online_at = CASE WHEN status IS DISTINCT FROM $2 THEN ${NOW} ELSE last_online_at END, status = $2, updated_at = ${NOW}
      WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [id, status],
  );
  return r.rows.length > 0;
}

/**
 * $database->update(['restart_count' => 0, 'last_restart_at' => null, 'last_restart_type' => null]), as
 * StartDatabase and StopDatabase reset them. Like Eloquent, it writes (and touches updated_at) only when one of
 * them is not so already. Answers whether the database exists.
 */
export async function resetDatabaseRestartCounters(tx: SqlExecutor, engine: DatabaseEngine, id: string | number): Promise<boolean> {
  const table = `deploy.${DATABASE_TABLES[engine].table}`;
  await tx.execute(
    `UPDATE ${table} SET restart_count = 0, last_restart_at = NULL, last_restart_type = NULL, updated_at = ${NOW}
      WHERE id = $1 AND deleted_at IS NULL AND (restart_count <> 0 OR last_restart_at IS NOT NULL OR last_restart_type IS NOT NULL)`,
    [id],
  );
  const r = await tx.execute(`SELECT id FROM ${table} WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return r.rows.length > 0;
}

/** $database->update(['last_online_at' => now()]) */
export async function touchDatabaseLastOnline(tx: SqlExecutor, engine: DatabaseEngine, id: string | number): Promise<boolean> {
  const r = await tx.execute(`UPDATE deploy.${DATABASE_TABLES[engine].table} SET last_online_at = ${NOW}, updated_at = ${NOW} WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id]);
  return r.rows.length > 0;
}

/** The database's certificate, as the Start actions and regenerateSslCertificate() read it. */
export interface DeployDatabaseCertificateRow extends SqlRow {
  id: string | number;
  server_id: string | number;
  common_name: string;
  /** JSON: Coolify's `array` cast. */
  subject_alternative_names: unknown;
  configuration_dir: string | null;
  mount_path: string | null;
  valid_until: string | Date;
}

/** $database->sslCertificates()->first() */
export async function findDatabaseCertificate(tx: SqlExecutor, owner: StorageOwner): Promise<DeployDatabaseCertificateRow | null> {
  const r = await tx.execute<DeployDatabaseCertificateRow>(
    `SELECT id, server_id, common_name, subject_alternative_names, configuration_dir, mount_path, valid_until
       FROM deploy.ssl_certificates WHERE resource_type = $1 AND resource_id = $2 ORDER BY id LIMIT 1`,
    [owner.type, owner.id],
  );
  return r.rows[0] ?? null;
}

/** $database->sslCertificates()->delete(): on whatever server. Returns how many rows went. */
export async function deleteDatabaseCertificates(tx: SqlExecutor, owner: StorageOwner): Promise<number> {
  const r = await tx.execute("DELETE FROM deploy.ssl_certificates WHERE resource_type = $1 AND resource_id = $2 RETURNING id", [owner.type, owner.id]);
  return r.rows.length;
}

/**
 * $database->fileStorages()->get()->filter(in_array($storage->mount_path, […]))->each->delete(): the file mounts
 * at these mount paths (the certificate files). Returns how many rows went.
 */
export async function deleteFileVolumesByMountPath(tx: SqlExecutor, owner: StorageOwner, mountPaths: string[]): Promise<number> {
  if (mountPaths.length === 0) return 0;
  const r = await tx.execute(
    `DELETE FROM deploy.local_file_volumes WHERE resource_type = $1 AND resource_id = $2 AND mount_path IN (${mountPaths.map((_, i) => `$${i + 3}`).join(", ")}) RETURNING id`,
    [owner.type, owner.id, ...mountPaths],
  );
  return r.rows.length;
}

export interface NewCertificateFileVolume {
  orgId: string;
  owner: StorageOwner;
  /** BaseModel's creating hook: new_public_id(). */
  uuid: string;
  fsPath: string;
  mountPath: string;
  /** The content already encrypted for local_file_volumes.content. */
  content: string;
  /** "644" for a certificate, "600" for a key. */
  chmod: string;
}

/** generateSslCertificate()'s $model->fileStorages()->make([...]) with its chmod; save(). */
export async function insertCertificateFileVolume(tx: SqlExecutor, volume: NewCertificateFileVolume): Promise<string | number> {
  const r = await tx.execute<{ id: string | number }>(
    `INSERT INTO deploy.local_file_volumes (uuid, fs_path, mount_path, content, is_directory, chmod, resource_type, resource_id, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, false, $5, $6, $7, $8, ${NOW}, ${NOW}) RETURNING id`,
    [volume.uuid, volume.fsPath, volume.mountPath, volume.content, volume.chmod, volume.owner.type, volume.owner.id, volume.orgId],
  );
  return r.rows[0]!.id;
}
