// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Shared/ResourceOperations.php (mount, moveTo,
// findResourceTeamEnvironment), bootstrap/helpers/applications.php (clone_application: what it replicates and
// what it fills in), bootstrap/helpers/services.php (clone_service, DP-108), app/Traits/HasSecretManager.php
// (cloneSecretManagerLinkTo), app/Models/Application.php (the creating and saving hooks a replica passes through),
// app/Models/LocalPersistentVolume.php (the replicating hook), app/Models/Standalone*.php (the saving hook),
// app/Traits/HasS3Destinations.php (copyS3StoragesTo) and app/Livewire/Project/Shared/ResourceLimits.php
// (Apache-2.0), modified.
//
// The rows behind an application's Resource Operations page: where it can be
// moved or cloned to, the move (one column), and the clone — Eloquent's
// replicate() of the application and of what belongs to it. A replica is the
// source's row, column for column, except what clone_application() fills in;
// the columns are read from the catalogue, so a column added to the schema is
// copied like the others. Encrypted columns are copied as stored: a value is
// bound to its org and column (crypto.ts), not to its row, so the copy
// decrypts as the source does. Every function takes the transaction of
// withOrg(): row-level security confines each query to that org.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { DESTINATION_MORPH_CLASS, type DestinationType } from "./destinations.js";
import { APPLICATION_MORPH_CLASS } from "./application-create.js";
import { listEnvironmentVariables } from "./environment-variables.js";
import { DATABASE_TABLES, type DatabaseEngine } from "./databases.js";
import { SERVICE_MORPH_CLASS, SERVICE_PART_MORPH_CLASS } from "./services.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** A project with one of its environments (environment_* null for a project without environments). */
export interface DeployOperationEnvironmentRow extends SqlRow {
  project_id: string | number;
  project_uuid: string;
  project_name: string;
  environment_id: string | number | null;
  environment_uuid: string | null;
  environment_name: string | null;
}

/** Project::query()->where('team_id', …)->orderByRaw('LOWER(name)') with $project->environments. */
export async function listOperationEnvironments(tx: SqlExecutor): Promise<DeployOperationEnvironmentRow[]> {
  const r = await tx.execute<DeployOperationEnvironmentRow>(
    `SELECT p.id AS project_id, p.uuid AS project_uuid, p.name AS project_name, e.id AS environment_id, e.uuid AS environment_uuid, e.name AS environment_name
       FROM deploy.projects p LEFT JOIN deploy.environments e ON e.project_id = p.id
      ORDER BY LOWER(p.name), p.id, e.id`,
  );
  return r.rows;
}

/** A server of the org with what decides whether it can take a clone. */
export interface DeployOperationServerRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  ip: string;
  is_reachable: boolean | null;
  is_usable: boolean | null;
  force_disabled: boolean | null;
  is_build_server: boolean | null;
  server_role: string | null;
}

/** Server::query()->where('team_id', …)->get() */
export async function listOperationServers(tx: SqlExecutor): Promise<DeployOperationServerRow[]> {
  const r = await tx.execute<DeployOperationServerRow>(
    `SELECT s.id, s.uuid, s.name, s.ip, ss.is_reachable, ss.is_usable, ss.force_disabled, ss.is_build_server, ss.server_role
       FROM deploy.servers s LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id
      WHERE s.deleted_at IS NULL
      ORDER BY s.id`,
  );
  return r.rows;
}

export interface DeployOperationDestinationRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  server_id: string | number;
  type: DestinationType;
}

/** $server->destinations() of every server: the standalone networks, then the Swarm ones. */
export async function listOperationDestinations(tx: SqlExecutor): Promise<DeployOperationDestinationRow[]> {
  const r = await tx.execute<DeployOperationDestinationRow>(
    `SELECT d.id, d.uuid, d.name, d.server_id, d.type FROM (
       SELECT id, uuid, name, server_id, 'standalone'::text AS type, 0 AS ord FROM deploy.standalone_dockers
       UNION ALL
       SELECT id, uuid, name, server_id, 'swarm'::text AS type, 1 AS ord FROM deploy.swarm_dockers
     ) d ORDER BY d.server_id, d.ord, d.id`,
  );
  return r.rows;
}

export interface DeployOperationEnvironmentTarget extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  project_uuid: string;
}

/** findResourceTeamEnvironment(): an environment of one of the org's projects. */
export async function findOperationEnvironment(tx: SqlExecutor, uuid: string): Promise<DeployOperationEnvironmentTarget | null> {
  const r = await tx.execute<DeployOperationEnvironmentTarget>(
    `SELECT e.id, e.uuid, e.name, p.uuid AS project_uuid FROM deploy.environments e JOIN deploy.projects p ON p.id = e.project_id WHERE e.uuid = $1`,
    [uuid],
  );
  return r.rows[0] ?? null;
}

/** moveTo(): $resource->fill(['environment_id' => …])->save(). False when the application is gone. */
export async function moveApplication(tx: SqlExecutor, id: string | number, environmentId: string | number): Promise<boolean> {
  const r = await tx.execute(`UPDATE deploy.applications SET environment_id = $2, updated_at = ${NOW} WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id, environmentId]);
  return r.rows.length > 0;
}

/** $service->update(['environment_id' => …]) of the API's moveResourceToEnvironment() (DP-86). */
export async function moveService(tx: SqlExecutor, id: string | number, environmentId: string | number): Promise<boolean> {
  const r = await tx.execute(`UPDATE deploy.services SET environment_id = $2, updated_at = ${NOW} WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id, environmentId]);
  return r.rows.length > 0;
}

type Fill = Record<string, string | number | boolean | null>;

/**
 * Model::replicate($except)->fill($fill)->save() for one row of a deploy
 * table: every column but the key, created_at, updated_at and `except` is
 * copied; `fill` and the timestamps are set. `table` is one of this module's
 * constants, never a caller's text. Returns the new row's id, or null when
 * the source row is not there.
 */
async function replicate(tx: SqlExecutor, table: string, sourceId: string | number, fill: Fill, except: readonly string[] = []): Promise<string | number | null> {
  const catalogue = await tx.execute<{ column_name: string; data_type: string }>(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'deploy' AND table_name = $1 ORDER BY ordinal_position",
    [table],
  );
  const types = new Map(catalogue.rows.map((c) => [c.column_name, c.data_type]));
  const filled = Object.keys(fill).filter((c) => types.has(c));
  const skipped = new Set(["id", "created_at", "updated_at", ...except, ...filled]);
  const copied = catalogue.rows.map((c) => c.column_name).filter((c) => !skipped.has(c));
  const quote = (c: string) => `"${c}"`;
  const r = await tx.execute<{ id: string | number }>(
    `INSERT INTO deploy.${table} (${[...copied, ...filled, "created_at", "updated_at"].map(quote).join(", ")})
     SELECT ${[...copied.map(quote), ...filled.map((c, i) => `$${i + 2}::${types.get(c)!}`), NOW, NOW].join(", ")}
       FROM deploy.${table} WHERE id = $1
     RETURNING id`,
    [sourceId, ...filled.map((c) => fill[c] ?? null)],
  );
  return r.rows[0]?.id ?? null;
}

/** What clone_application() gives the replica in place of the source's values. */
export interface ApplicationReplica {
  /** new_public_id() */
  uuid: string;
  name: string;
  /** The source's domains, or generateUrl()'s — as the saving hook stores them (no port). */
  fqdn: string | null;
  /** JSON text (or null) the saving hook derives from that fqdn. */
  domainPortOverrides: string | null;
  /** The noindex flags the saving hook keeps for that fqdn, as JSON text; undefined keeps the source's. */
  noindexDomains?: string | null;
  /** undefined keeps the source's labels; null clears them (they are generated again for the new domain). */
  customLabels?: string | null;
  environmentId: string | number;
  destinationId: string | number;
  destinationType: DestinationType;
}

/**
 * $source->replicate([...])->fill([...])->save(): the application's row with
 * a new uuid, name, domain, environment and destination, status 'exited' (stored by the status mutator as 'exited:unhealthy', DP-86), and
 * — the creating and saving hooks — compose_parsing_version '5' and
 * last_online_at now. The manual webhook secrets are the source's (the
 * creating hook only fills in missing ones). Null when the source is gone.
 */
export async function replicateApplication(tx: SqlExecutor, sourceId: string | number, replica: ApplicationReplica): Promise<string | number | null> {
  const alive = await tx.execute("SELECT 1 FROM deploy.applications WHERE id = $1 AND deleted_at IS NULL", [sourceId]);
  if (!alive.rows.length) return null;
  const fill: Fill = {
    uuid: replica.uuid,
    name: replica.name,
    fqdn: replica.fqdn,
    domain_port_overrides: replica.domainPortOverrides,
    status: "exited:unhealthy",
    environment_id: replica.environmentId,
    destination_id: replica.destinationId,
    destination_type: DESTINATION_MORPH_CLASS[replica.destinationType],
    compose_parsing_version: "5",
  };
  if (replica.noindexDomains !== undefined) fill.noindex_domains = replica.noindexDomains;
  if (replica.customLabels !== undefined) fill.custom_labels = replica.customLabels;
  const id = await replicate(tx, "applications", sourceId, fill, ["last_online_at"]);
  if (id !== null) await tx.execute(`UPDATE deploy.applications SET last_online_at = ${NOW} WHERE id = $1`, [id]);
  return id;
}

/** The settings row: the replica of the source's (the one the created hook made is deleted first). */
export async function replicateApplicationSettings(tx: SqlExecutor, sourceApplicationId: string | number, applicationId: string | number): Promise<boolean> {
  await tx.execute("DELETE FROM deploy.application_settings WHERE application_id = $1", [applicationId]);
  const source = await tx.execute<{ id: string | number }>("SELECT id FROM deploy.application_settings WHERE application_id = $1 ORDER BY id LIMIT 1", [sourceApplicationId]);
  if (!source.rows[0]) return false;
  return (await replicate(tx, "application_settings", source.rows[0].id, { application_id: applicationId })) !== null;
}

/** $source->scheduled_tasks()->get(): the ids of the application's scheduled tasks. */
export async function listApplicationScheduledTaskIds(tx: SqlExecutor, applicationId: string | number): Promise<Array<string | number>> {
  const r = await tx.execute<{ id: string | number }>("SELECT id FROM deploy.scheduled_tasks WHERE application_id = $1 ORDER BY id", [applicationId]);
  return r.rows.map((row) => row.id);
}

/** $task->replicate()->fill(['uuid' => new_public_id(), 'application_id' => …, 'team_id' => …]) */
export async function replicateScheduledTask(tx: SqlExecutor, taskId: string | number, replica: { uuid: string; applicationId: string | number }): Promise<void> {
  await replicate(tx, "scheduled_tasks", taskId, { uuid: replica.uuid, application_id: replica.applicationId });
}

/**
 * $volume->replicate(['id', 'created_at', 'updated_at', 'uuid'])->fill([name,
 * resource_id, standalone_sqlite_id => null]): a new Docker volume, so the
 * replicating hook clears ignores_compose_driver_options and the creating
 * hook gives it its own uuid.
 */
export async function replicatePersistentVolume(tx: SqlExecutor, volumeId: string | number, replica: { uuid: string; name: string; resourceId: string | number }): Promise<void> {
  await replicate(tx, "local_persistent_volumes", volumeId, {
    uuid: replica.uuid,
    name: replica.name,
    resource_id: replica.resourceId,
    standalone_sqlite_id: null,
    ignores_compose_driver_options: false,
  });
}

/**
 * $storage->replicate()->fill(['resource_id' => …]): the mount with its
 * content as stored. Coolify keeps the source's uuid; here the copy gets its
 * own, because deploy.local_file_volumes.uuid is unique.
 */
export async function replicateFileVolume(tx: SqlExecutor, volumeId: string | number, replica: { uuid: string; resourceId: string | number }): Promise<void> {
  await replicate(tx, "local_file_volumes", volumeId, { uuid: replica.uuid, resource_id: replica.resourceId });
}

/** $source->environment_variables() and environment_variables_preview(): the ids of both. */
export async function listApplicationEnvironmentVariableIds(tx: SqlExecutor, applicationId: string | number): Promise<Array<string | number>> {
  const production = await listEnvironmentVariables(tx, "application", applicationId, false);
  const preview = await listEnvironmentVariables(tx, "application", applicationId, true);
  return [...production, ...preview].map((row) => row.id);
}

/**
 * $environmentVariable->replicate()->fill([resourceable_id, resourceable_type,
 * is_preview]) saved without events: the variable with its value as stored
 * and is_preview as it was. The copy gets its own uuid, because
 * deploy.environment_variables.uuid is unique.
 */
export async function replicateEnvironmentVariable(tx: SqlExecutor, variableId: string | number, replica: { uuid: string; applicationId: string | number }): Promise<void> {
  await replicate(tx, "environment_variables", variableId, { uuid: replica.uuid, resourceable_id: replica.applicationId, resourceable_type: APPLICATION_MORPH_CLASS });
}

// ---------------------------------------------------------------- standalone databases
// ResourceOperations::cloneTo()'s database branch and moveTo() for the nine
// standalone database tables: the same replicate() of the database and of
// what belongs to it.

/** moveTo() for a database: $resource->fill(['environment_id' => …])->save(). False when the database is gone. */
export async function moveDatabase(tx: SqlExecutor, engine: DatabaseEngine, id: string | number, environmentId: string | number): Promise<boolean> {
  const r = await tx.execute(`UPDATE deploy.${DATABASE_TABLES[engine].table} SET environment_id = $2, updated_at = ${NOW} WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [
    id,
    environmentId,
  ]);
  return r.rows.length > 0;
}

/** What cloneTo() fills in on the database's replica. */
export interface DatabaseReplica {
  /** new_public_id() */
  uuid: string;
  /** clone_resource_name() */
  name: string;
  environmentId: string | number;
  destinationId: string | number;
  destinationType: DestinationType;
}

/**
 * $this->resource->replicate(['id', 'created_at', 'updated_at'])->fill([uuid,
 * name, status 'exited' (the status mutator stores 'exited:unhealthy', DP-86), started_at null, environment_id, destination_id,
 * destination_type])->save(): the database's row, column for column — its
 * credentials (as stored: a ciphertext is bound to its org and column, not
 * its row), public port, configuration and limits — and, by the saving hook
 * (status is dirty on a new model), last_online_at now. The created hook's
 * volumes are not made: cloneTo() deletes them before it copies the source's.
 * Null when the source is gone.
 */
export async function replicateDatabase(tx: SqlExecutor, engine: DatabaseEngine, sourceId: string | number, replica: DatabaseReplica): Promise<string | number | null> {
  const table = DATABASE_TABLES[engine].table;
  const alive = await tx.execute(`SELECT 1 FROM deploy.${table} WHERE id = $1 AND deleted_at IS NULL`, [sourceId]);
  if (!alive.rows.length) return null;
  const id = await replicate(
    tx,
    table,
    sourceId,
    {
      uuid: replica.uuid,
      name: replica.name,
      status: "exited:unhealthy",
      started_at: null,
      environment_id: replica.environmentId,
      destination_id: replica.destinationId,
      destination_type: DESTINATION_MORPH_CLASS[replica.destinationType],
    },
    ["last_online_at"],
  );
  if (id !== null) await tx.execute(`UPDATE deploy.${table} SET last_online_at = ${NOW} WHERE id = $1`, [id]);
  return id;
}

/** $this->resource->environment_variables()->get(): the ids of a database's variables (a database has no preview ones). */
export async function listDatabaseEnvironmentVariableIds(tx: SqlExecutor, engine: DatabaseEngine, databaseId: string | number): Promise<Array<string | number>> {
  const r = await tx.execute<{ id: string | number }>("SELECT id FROM deploy.environment_variables WHERE resourceable_type = $1 AND resourceable_id = $2 ORDER BY id", [
    DATABASE_TABLES[engine].morphClass,
    databaseId,
  ]);
  return r.rows.map((row) => row.id);
}

/**
 * $environmentVariable->replicate(['id', 'created_at', 'updated_at'])
 * ->fill([resourceable_id, resourceable_type])->save() for a database's
 * variable: saved with its events, so the creating hook stamps the current
 * version. The value is copied as stored. The copy gets its own uuid,
 * because deploy.environment_variables.uuid is unique (Coolify keeps the
 * source's).
 */
export async function replicateDatabaseEnvironmentVariable(
  tx: SqlExecutor,
  variableId: string | number,
  replica: { uuid: string; engine: DatabaseEngine; databaseId: string | number; version: string },
): Promise<void> {
  await replicate(tx, "environment_variables", variableId, {
    uuid: replica.uuid,
    resourceable_id: replica.databaseId,
    resourceable_type: DATABASE_TABLES[replica.engine].morphClass,
    version: replica.version,
  });
}

/** $this->resource->scheduledBackups()->get(): the ids of a database's backup schedules. */
export async function listDatabaseBackupScheduleIds(tx: SqlExecutor, engine: DatabaseEngine, databaseId: string | number): Promise<Array<string | number>> {
  const r = await tx.execute<{ id: string | number }>("SELECT id FROM deploy.scheduled_database_backups WHERE database_type = $1 AND database_id = $2 ORDER BY id", [
    DATABASE_TABLES[engine].morphClass,
    databaseId,
  ]);
  return r.rows.map((row) => row.id);
}

/**
 * $backup->replicate(['id', 'created_at', 'updated_at'])->fill([uuid,
 * database_id, database_type, team_id])->save(), then copyS3StoragesTo():
 * the schedule for the clone with the source schedule's S3 destinations
 * (the org's own: both belong to it). Its executions are not copied.
 */
export async function replicateDatabaseBackupSchedule(
  tx: SqlExecutor,
  scheduleId: string | number,
  replica: { uuid: string; engine: DatabaseEngine; databaseId: string | number },
): Promise<void> {
  const id = await replicate(tx, "scheduled_database_backups", scheduleId, {
    uuid: replica.uuid,
    database_id: replica.databaseId,
    database_type: DATABASE_TABLES[replica.engine].morphClass,
  });
  if (id === null) return;
  await copyBackupS3Storages(tx, scheduleId, id);
}

// ---------------------------------------------------------------- services (DP-108)
// clone_service(): the service's row, its tags, scheduled tasks, variables and secret manager link replicated, and
// its databases' backup schedules copied to the parts Service::parse() made for the clone.

/** What clone_service() fills in on the service's replica. */
export interface ServiceReplica {
  /** $overrides['uuid'] ?? new_public_id() */
  uuid: string;
  /** clone_resource_name(), or the caller's name */
  name: string;
  environmentId: string | number;
  destinationId: string | number;
  destinationType: DestinationType;
  /** $destination->server_id */
  serverId: string | number;
}

/**
 * $source->replicate(['id', 'created_at', 'updated_at'])->fill([...])->save(): the service's row, column for column —
 * its Compose files, settings and config hash — with a new uuid, name, environment, destination and server, and the
 * creating hook's compose_parsing_version (Service::$parserVersion, '5'). Null when the source is gone.
 */
export async function replicateService(tx: SqlExecutor, sourceId: string | number, replica: ServiceReplica): Promise<string | number | null> {
  const alive = await tx.execute("SELECT 1 FROM deploy.services WHERE id = $1 AND deleted_at IS NULL", [sourceId]);
  if (!alive.rows.length) return null;
  return replicate(tx, "services", sourceId, {
    uuid: replica.uuid,
    name: replica.name,
    environment_id: replica.environmentId,
    destination_id: replica.destinationId,
    destination_type: DESTINATION_MORPH_CLASS[replica.destinationType],
    server_id: replica.serverId,
    compose_parsing_version: "5",
  });
}

/** $source->scheduled_tasks()->get(): the ids of the service's scheduled tasks. */
export async function listServiceScheduledTaskIds(tx: SqlExecutor, serviceId: string | number): Promise<Array<string | number>> {
  const r = await tx.execute<{ id: string | number }>("SELECT id FROM deploy.scheduled_tasks WHERE service_id = $1 ORDER BY id", [serviceId]);
  return r.rows.map((row) => row.id);
}

/** $task->replicate()->fill(['uuid' => new_public_id(), 'service_id' => …, 'team_id' => …]) */
export async function replicateServiceScheduledTask(tx: SqlExecutor, taskId: string | number, replica: { uuid: string; serviceId: string | number }): Promise<void> {
  await replicate(tx, "scheduled_tasks", taskId, { uuid: replica.uuid, service_id: replica.serviceId });
}

/** $source->environment_variables()->get(): the ids of the service's variables (no ORDER BY in Coolify; the ids' here). */
export async function listServiceEnvironmentVariableIds(tx: SqlExecutor, serviceId: string | number): Promise<Array<string | number>> {
  const r = await tx.execute<{ id: string | number }>("SELECT id FROM deploy.environment_variables WHERE resourceable_type = $1 AND resourceable_id = $2 ORDER BY id", [SERVICE_MORPH_CLASS, serviceId]);
  return r.rows.map((row) => row.id);
}

/**
 * $environmentVariable->replicate(['id', 'created_at', 'updated_at'])->fill([resourceable_id, resourceable_type])->save()
 * for a service's variable: saved with its events, so the creating hook stamps the current version; the value is copied
 * as stored. The copy gets its own uuid, because deploy.environment_variables.uuid is unique.
 */
export async function replicateServiceEnvironmentVariable(tx: SqlExecutor, variableId: string | number, replica: { uuid: string; serviceId: string | number; version: string }): Promise<void> {
  await replicate(tx, "environment_variables", variableId, { uuid: replica.uuid, resourceable_id: replica.serviceId, resourceable_type: SERVICE_MORPH_CLASS, version: replica.version });
}

/**
 * $source->cloneSecretManagerLinkTo($newService): the source's link (its token and settings) given to the clone. The
 * token is the org's (row-level security), which is Coolify's check that it is the clone's team's.
 */
export async function cloneServiceSecretManagerLink(tx: SqlExecutor, sourceId: string | number, cloneId: string | number, uuid: string): Promise<void> {
  await tx.execute(
    `INSERT INTO deploy.secret_manager_links (uuid, resourceable_type, resourceable_id, integration_token_id, settings, org_id, created_at, updated_at)
     SELECT $3, l.resourceable_type, $2, l.integration_token_id, l.settings, l.org_id, ${NOW}, ${NOW}
       FROM deploy.secret_manager_links l JOIN deploy.integration_tokens t ON t.id = l.integration_token_id
      WHERE l.resourceable_type = $4 AND l.resourceable_id = $1
      ORDER BY l.id LIMIT 1`,
    [sourceId, cloneId, uuid, SERVICE_MORPH_CLASS],
  );
}

/** $sourceDatabase->scheduledBackups()->get(): the ids of a service database's backup schedules. */
export async function listServiceDatabaseBackupScheduleIds(tx: SqlExecutor, databaseId: string | number): Promise<Array<string | number>> {
  const r = await tx.execute<{ id: string | number }>("SELECT id FROM deploy.scheduled_database_backups WHERE database_type = $1 AND database_id = $2 ORDER BY id", [
    SERVICE_PART_MORPH_CLASS.database,
    databaseId,
  ]);
  return r.rows.map((row) => row.id);
}

/** clone_service()'s $backup->replicate()->fill([uuid, database_id, database_type, team_id])->save(), then copyS3StoragesTo(). */
export async function replicateServiceDatabaseBackupSchedule(tx: SqlExecutor, scheduleId: string | number, replica: { uuid: string; databaseId: string | number }): Promise<void> {
  const id = await replicate(tx, "scheduled_database_backups", scheduleId, { uuid: replica.uuid, database_id: replica.databaseId, database_type: SERVICE_PART_MORPH_CLASS.database });
  if (id === null) return;
  await copyBackupS3Storages(tx, scheduleId, id);
}

async function copyBackupS3Storages(tx: SqlExecutor, fromId: string | number, toId: string | number): Promise<void> {
  await tx.execute(
    `INSERT INTO deploy.scheduled_database_backup_s3_storage (scheduled_database_backup_id, s3_storage_id, org_id, created_at, updated_at)
     SELECT $2, l.s3_storage_id, l.org_id, ${NOW}, ${NOW} FROM deploy.scheduled_database_backup_s3_storage l WHERE l.scheduled_database_backup_id = $1 ORDER BY l.id`,
    [fromId, toId],
  );
}

/** The resource limits of a database: the columns of ResourceLimits. */
export interface DeployDatabaseLimitsRow extends SqlRow {
  limits_memory: string;
  limits_memory_swap: string;
  limits_memory_swappiness: number;
  limits_memory_reservation: string;
  limits_cpus: string;
  limits_cpuset: string | null;
  limits_cpu_shares: number;
}

export const DATABASE_LIMIT_COLUMNS = ["limits_memory", "limits_memory_swap", "limits_memory_swappiness", "limits_memory_reservation", "limits_cpus", "limits_cpuset", "limits_cpu_shares"] as const;
export type DatabaseLimitChanges = Partial<Record<(typeof DATABASE_LIMIT_COLUMNS)[number], string | number | null>>;

/** ResourceLimits::syncData(): the database's limits. Null when it is gone. */
export async function findDatabaseLimits(tx: SqlExecutor, engine: DatabaseEngine, id: string | number): Promise<DeployDatabaseLimitsRow | null> {
  const r = await tx.execute<DeployDatabaseLimitsRow>(`SELECT ${DATABASE_LIMIT_COLUMNS.join(", ")} FROM deploy.${DATABASE_TABLES[engine].table} WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return r.rows[0] ?? null;
}

/** ResourceLimits::submit(): $this->resource->save() with the given limits, and updated_at. False when it is gone. */
export async function updateDatabaseLimits(tx: SqlExecutor, engine: DatabaseEngine, id: string | number, changes: DatabaseLimitChanges): Promise<boolean> {
  const columns = DATABASE_LIMIT_COLUMNS.filter((c) => changes[c] !== undefined);
  const sets = columns.map((c, i) => `"${c}" = $${i + 2}`);
  const r = await tx.execute(`UPDATE deploy.${DATABASE_TABLES[engine].table} SET ${[...sets, `updated_at = ${NOW}`].join(", ")} WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [
    id,
    ...columns.map((c) => changes[c] ?? null),
  ]);
  return r.rows.length > 0;
}

/** A standalone database's healthcheck (Database\Health, DP-97). */
export interface DeployDatabaseHealthRow extends SqlRow {
  health_check_enabled: boolean;
  health_check_interval: number;
  health_check_timeout: number;
  health_check_retries: number;
  health_check_start_period: number;
}

export const DATABASE_HEALTH_COLUMNS = ["health_check_enabled", "health_check_interval", "health_check_timeout", "health_check_retries", "health_check_start_period"] as const;
export type DatabaseHealthChanges = Partial<Record<(typeof DATABASE_HEALTH_COLUMNS)[number], number | boolean>>;

/** Health::syncData(): the database's healthcheck columns. Null when it is gone. */
export async function findDatabaseHealth(tx: SqlExecutor, engine: DatabaseEngine, id: string | number): Promise<DeployDatabaseHealthRow | null> {
  const r = await tx.execute<DeployDatabaseHealthRow>(`SELECT ${DATABASE_HEALTH_COLUMNS.join(", ")} FROM deploy.${DATABASE_TABLES[engine].table} WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return r.rows[0] ?? null;
}

/** Health::syncData(true): $this->database->save() with the given columns, and updated_at. False when it is gone. */
export async function updateDatabaseHealth(tx: SqlExecutor, engine: DatabaseEngine, id: string | number, changes: DatabaseHealthChanges): Promise<boolean> {
  const columns = DATABASE_HEALTH_COLUMNS.filter((c) => changes[c] !== undefined);
  const sets = columns.map((c, i) => `"${c}" = $${i + 2}`);
  const r = await tx.execute(`UPDATE deploy.${DATABASE_TABLES[engine].table} SET ${[...sets, `updated_at = ${NOW}`].join(", ")} WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [
    id,
    ...columns.map((c) => changes[c] ?? null),
  ]);
  return r.rows.length > 0;
}
