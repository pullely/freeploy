// Derived from coollabsio/coolify@91b7e3e:app/Models/ScheduledVolumeBackup.php (scopeForApplication, scopeForService,
// executions, latestExecution, selectedS3Storages, targetType, targetName), app/Models/ScheduledVolumeBackupExecution.php,
// app/Livewire/Project/Application/Backup/{Index,Create}.php, app/Livewire/Project/Service/VolumeBackup/{Index,Create}.php
// and app/Livewire/Project/Shared/Storages/VolumeBackups.php (the queries) (Apache-2.0), modified.
//
// The console's volume backup pages (DP-99): a resource's storage backup schedules — an application's, or a service's
// parts' — with their targets, latest executions, executions and S3 storages. A schedule belongs to a volume
// (deploy.local_persistent_volumes) or to a directory mount (deploy.local_file_volumes, a directory that is not a host
// file), and through it to its owner (resource_type, resource_id). Every function takes the transaction of withOrg():
// row-level security confines each query to that org.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { FILE_VOLUME_MORPH_CLASS, PERSISTENT_VOLUME_MORPH_CLASS, type StorageOwner } from "./storages.js";

const NOW = "date_trunc('second', timezone('UTC', now()))";

/** The volumes and directory mounts of the owners ($1 the owners' morph classes, $2 their ids; $3 and $4 the volume's and the file's morph classes), as backup targets. */
const TARGETS = `
  SELECT $3::text AS backupable_type, v.id AS backupable_id, v.uuid AS target_uuid, v.name AS target_name, 'Volume'::text AS target_type,
         v.resource_type, v.resource_id
    FROM deploy.local_persistent_volumes v
   WHERE (v.resource_type, v.resource_id) IN (SELECT * FROM unnest($1::text[], $2::bigint[]))
  UNION ALL
  SELECT $4::text, f.id, f.uuid, f.fs_path, 'Directory'::text, f.resource_type, f.resource_id
    FROM deploy.local_file_volumes f
   WHERE (f.resource_type, f.resource_id) IN (SELECT * FROM unnest($1::text[], $2::bigint[])) AND f.is_directory = true AND f.is_host_file = false`;

const ownerParams = (owners: readonly StorageOwner[]): [string[], string[], string, string] => [owners.map((o) => o.type), owners.map((o) => String(o.id)), PERSISTENT_VOLUME_MORPH_CLASS, FILE_VOLUME_MORPH_CLASS];

export interface DeployVolumeBackupStorageRef extends SqlRow {
  id: string | number;
  name: string;
  type: string;
  bucket: string | null;
}

export interface DeployVolumeBackupListRow extends SqlRow {
  id: string | number;
  uuid: string;
  frequency: string;
  enabled: boolean;
  save_s3: boolean;
  backupable_type: string;
  backupable_id: string | number;
  target_uuid: string | null;
  target_name: string;
  /** targetType(): "Volume" or "Directory". */
  target_type: string;
  resource_type: string;
  resource_id: string | number;
  latest_status: string | null;
  latest_finished_at: string | null;
  executions_count: number;
  /** $backup->s3Storages, else [$backup->s3]: the destinations the list shows. */
  storages: DeployVolumeBackupStorageRef[];
}

const STORAGES_OF = `COALESCE(
  (SELECT json_agg(json_build_object('id', s.id, 'name', s.name, 'type', s.type, 'bucket', s.bucket) ORDER BY p.id)
     FROM deploy.scheduled_volume_backup_s3_storage p JOIN deploy.s3_storages s ON s.id = p.s3_storage_id WHERE p.scheduled_volume_backup_id = b.id),
  (SELECT json_agg(json_build_object('id', s.id, 'name', s.name, 'type', s.type, 'bucket', s.bucket)) FROM deploy.s3_storages s WHERE s.id = b.s3_storage_id),
  '[]'::json) AS storages`;

const SELECT_LIST = `
  SELECT b.id, b.uuid, b.frequency, b.enabled, b.save_s3, t.backupable_type, t.backupable_id, t.target_uuid, t.target_name, t.target_type, t.resource_type, t.resource_id,
         le.status AS latest_status, to_char(le.finished_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS latest_finished_at,
         (SELECT count(*)::int FROM deploy.scheduled_volume_backup_executions x WHERE x.scheduled_volume_backup_id = b.id) AS executions_count,
         ${STORAGES_OF}
    FROM deploy.scheduled_volume_backups b
    JOIN (${TARGETS}) t ON t.backupable_type = b.backupable_type AND t.backupable_id = b.backupable_id
    LEFT JOIN LATERAL (SELECT x.status, x.finished_at FROM deploy.scheduled_volume_backup_executions x WHERE x.scheduled_volume_backup_id = b.id ORDER BY x.id DESC LIMIT 1) le ON true`;

const parseStorages = <T extends { storages: unknown }>(row: T): T => ({ ...row, storages: typeof row.storages === "string" ? (JSON.parse(row.storages) as unknown) : row.storages });

/** ScheduledVolumeBackup::forApplication($resource) / forService($service)->latest(): the owners' schedules, newest first. */
export async function listVolumeBackupSchedules(tx: SqlExecutor, owners: readonly StorageOwner[]): Promise<DeployVolumeBackupListRow[]> {
  if (owners.length === 0) return [];
  const r = await tx.execute<DeployVolumeBackupListRow>(`${SELECT_LIST} ORDER BY b.created_at DESC NULLS LAST, b.id DESC`, ownerParams(owners));
  return r.rows.map(parseStorages);
}

export interface DeployVolumeBackupRow extends DeployVolumeBackupListRow {
  disable_local_backup: boolean;
  stop_during_backup: boolean;
  s3_storage_id: string | number | null;
  retention_amount_locally: number;
  retention_days_locally: number;
  retention_max_storage_locally: number;
  retention_amount_s3: number;
  retention_days_s3: number;
  retention_max_storage_s3: number;
  timeout: number;
  missing_backup_notification_days: number;
}

/** One schedule of the owners by its uuid (Show's and openSchedule()'s ->forApplication()/->forService()->firstOrFail()). */
export async function findVolumeBackupSchedule(tx: SqlExecutor, owners: readonly StorageOwner[], uuid: string): Promise<DeployVolumeBackupRow | null> {
  if (owners.length === 0) return null;
  const r = await tx.execute<DeployVolumeBackupRow>(
    `SELECT l.*, b.disable_local_backup, b.stop_during_backup, b.s3_storage_id, b.retention_amount_locally, b.retention_days_locally,
            b.retention_max_storage_locally::float8 AS retention_max_storage_locally, b.retention_amount_s3, b.retention_days_s3,
            b.retention_max_storage_s3::float8 AS retention_max_storage_s3, b.timeout, b.missing_backup_notification_days
       FROM (${SELECT_LIST} WHERE b.uuid = $5) l JOIN deploy.scheduled_volume_backups b ON b.id = l.id LIMIT 1`,
    [...ownerParams(owners), uuid],
  );
  const row = r.rows[0];
  return row ? { ...parseStorages(row), retention_max_storage_locally: Number(row.retention_max_storage_locally), retention_max_storage_s3: Number(row.retention_max_storage_s3) } : null;
}

/** $target->scheduledBackups()->first(): the uuid of a target's schedule, when it has one. */
export async function findTargetVolumeBackupUuid(tx: SqlExecutor, backupableType: string, backupableId: string | number): Promise<string | null> {
  const r = await tx.execute<{ uuid: string }>("SELECT uuid FROM deploy.scheduled_volume_backups WHERE backupable_type = $1 AND backupable_id = $2 ORDER BY id LIMIT 1", [backupableType, backupableId]);
  return r.rows[0]?.uuid ?? null;
}

export interface NewVolumeBackupSchedule {
  orgId: string;
  uuid: string;
  backupableType: string;
  backupableId: string | number;
  frequency: string;
  enabled: boolean;
}

/** Create::submit()'s firstOrNew() and save() of a new schedule: the table's defaults for the rest. */
export async function insertVolumeBackupSchedule(tx: SqlExecutor, s: NewVolumeBackupSchedule): Promise<{ id: string | number; uuid: string }> {
  const r = await tx.execute<{ id: string | number; uuid: string }>(
    `INSERT INTO deploy.scheduled_volume_backups (uuid, backupable_type, backupable_id, frequency, enabled, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, ${NOW}, ${NOW}) RETURNING id, uuid`,
    [s.uuid, s.backupableType, s.backupableId, s.frequency, s.enabled, s.orgId],
  );
  return r.rows[0]!;
}

export const VOLUME_BACKUP_COLUMNS = [
  "frequency", "enabled", "save_s3", "disable_local_backup", "stop_during_backup", "retention_amount_locally", "retention_days_locally",
  "retention_max_storage_locally", "retention_amount_s3", "retention_days_s3", "retention_max_storage_s3", "timeout", "missing_backup_notification_days",
] as const;
export type VolumeBackupChanges = Partial<Record<(typeof VOLUME_BACKUP_COLUMNS)[number], string | number | boolean>>;

/** fill() and save() of a schedule: the columns that change (updated_at only when one does). False when the row is not the org's. */
export async function updateVolumeBackupSchedule(tx: SqlExecutor, id: string | number, changes: VolumeBackupChanges): Promise<boolean> {
  const current = (await tx.execute<Record<string, unknown>>(`SELECT ${VOLUME_BACKUP_COLUMNS.map((c) => `"${c}"::text AS "${c}"`).join(", ")} FROM deploy.scheduled_volume_backups WHERE id = $1`, [id])).rows[0];
  if (!current) return false;
  const text = (v: unknown): string => (typeof v === "boolean" ? (v ? "true" : "false") : String(v));
  // isDirty(): the stored value against the new one (numbers compared as numbers).
  const dirty = (Object.keys(changes) as Array<keyof VolumeBackupChanges>).filter((k) => {
    if (!(VOLUME_BACKUP_COLUMNS as readonly string[]).includes(k)) return false;
    const after = changes[k];
    return typeof after === "number" ? Number(current[k]) !== after : current[k] !== text(after);
  });
  if (dirty.length === 0) return true;
  await tx.execute(`UPDATE deploy.scheduled_volume_backups SET ${dirty.map((k, i) => `"${k}" = $${i + 2}`).join(", ")}, updated_at = ${NOW} WHERE id = $1`, [id, ...dirty.map((k) => changes[k])]);
  return true;
}

/** selectedS3Storages(): the pivot's destinations, else the legacy s3_storage_id — the ids, in the pivot's order. */
export async function volumeBackupSelectedStorageIds(tx: SqlExecutor, id: string | number): Promise<string[]> {
  const pivot = await tx.execute<{ id: string }>("SELECT s3_storage_id::text AS id FROM deploy.scheduled_volume_backup_s3_storage WHERE scheduled_volume_backup_id = $1 ORDER BY id", [id]);
  if (pivot.rows.length) return pivot.rows.map((r) => r.id);
  const legacy = await tx.execute<{ id: string | null }>("SELECT b.s3_storage_id::text AS id FROM deploy.scheduled_volume_backups b JOIN deploy.s3_storages s ON s.id = b.s3_storage_id WHERE b.id = $1", [id]);
  return legacy.rows[0]?.id ? [legacy.rows[0].id] : [];
}

export interface DeployBackupS3OptionRow extends SqlRow {
  id: string;
  uuid: string;
  name: string;
  is_usable: boolean;
}

/** selectableS3Storages(): the org's usable storages, plus the ones already selected; by name. */
export async function selectableVolumeBackupS3Storages(tx: SqlExecutor, selectedIds: readonly string[]): Promise<DeployBackupS3OptionRow[]> {
  const r = await tx.execute<DeployBackupS3OptionRow>("SELECT id::text AS id, uuid, name, is_usable FROM deploy.s3_storages WHERE is_usable = true OR id::text = ANY($1::text[]) ORDER BY name, id", [[...selectedIds]]);
  return r.rows;
}

export interface DeployVolumeBackupExecutionRow extends SqlRow {
  id: string | number;
  uuid: string;
  status: string;
  message: string | null;
  size: string | number;
  filename: string | null;
  created_at: string | null;
  updated_at: string | null;
  finished_at: string | null;
  local_storage_deleted: boolean;
  s3_storage_deleted: boolean;
  s3_uploaded: boolean | null;
  stop_recovery_pending: boolean;
  s3_cleanup_pending: boolean;
  recovery_error: string | null;
  recovery_needs_attention: boolean;
}

const EXECUTION_COLUMNS = `id, uuid, status, message, size, filename,
  to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at, to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at,
  to_char(finished_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS finished_at, local_storage_deleted, s3_storage_deleted, s3_uploaded,
  stop_recovery_pending, s3_cleanup_pending, recovery_error, recovery_needs_attention`;

/** $backup->executions()->paginate($perPage): newest first (latest()), one page and the total. */
export async function listVolumeBackupExecutions(tx: SqlExecutor, backupId: string | number, page: number, perPage: number): Promise<{ total: number; rows: DeployVolumeBackupExecutionRow[] }> {
  const total = await tx.execute<{ n: number }>("SELECT count(*)::int AS n FROM deploy.scheduled_volume_backup_executions WHERE scheduled_volume_backup_id = $1", [backupId]);
  const r = await tx.execute<DeployVolumeBackupExecutionRow>(
    `SELECT ${EXECUTION_COLUMNS} FROM deploy.scheduled_volume_backup_executions WHERE scheduled_volume_backup_id = $1 ORDER BY created_at DESC NULLS LAST, id DESC LIMIT $2 OFFSET $3`,
    [backupId, perPage, (page - 1) * perPage],
  );
  return { total: total.rows[0]?.n ?? 0, rows: r.rows };
}

/** $this->backup->executions()->whereKey($id)->first() */
export async function findVolumeBackupExecution(tx: SqlExecutor, backupId: string | number, id: string | number): Promise<DeployVolumeBackupExecutionRow | null> {
  const r = await tx.execute<DeployVolumeBackupExecutionRow>(`SELECT ${EXECUTION_COLUMNS} FROM deploy.scheduled_volume_backup_executions WHERE scheduled_volume_backup_id = $1 AND id = $2`, [backupId, id]);
  return r.rows[0] ?? null;
}

export async function deleteVolumeBackupExecution(tx: SqlExecutor, backupId: string | number, id: string | number): Promise<boolean> {
  return (await tx.execute("DELETE FROM deploy.scheduled_volume_backup_executions WHERE scheduled_volume_backup_id = $1 AND id = $2 RETURNING id", [backupId, id])).rows.length > 0;
}

/**
 * cleanupFailed(): the failed executions with no recovery pending whose archive is gone or never existed.
 * cleanupDeleted(): those whose local archive is deleted, with no recovery pending and no live S3 copy
 * (withoutLiveS3Copies(): Freeploy keeps no S3 replica rows, so the execution's own S3 flags). The number deleted.
 */
export async function cleanupVolumeBackupExecutions(tx: SqlExecutor, backupId: string | number, kind: "failed" | "deleted"): Promise<number> {
  const where =
    kind === "failed"
      ? "status = 'failed' AND stop_recovery_pending = false AND s3_cleanup_pending = false AND (filename IS NULL OR local_storage_deleted = true)"
      : "local_storage_deleted = true AND stop_recovery_pending = false AND s3_cleanup_pending = false AND (s3_storage_deleted = true OR s3_uploaded IS NULL OR s3_uploaded = false)";
  return (await tx.execute(`DELETE FROM deploy.scheduled_volume_backup_executions WHERE scheduled_volume_backup_id = $1 AND ${where} RETURNING id`, [backupId])).rows.length;
}

/** The archives a schedule's executions hold: local files not yet deleted, and S3 copies that are uploaded and not deleted. */
export async function volumeBackupArchives(tx: SqlExecutor, backupId: string | number): Promise<{ local: number; s3: number }> {
  const r = await tx.execute<{ local: number; s3: number }>(
    `SELECT count(*) FILTER (WHERE local_storage_deleted = false AND filename IS NOT NULL AND filename <> '')::int AS local,
            count(*) FILTER (WHERE s3_uploaded = true AND s3_storage_deleted = false)::int AS s3
       FROM deploy.scheduled_volume_backup_executions WHERE scheduled_volume_backup_id = $1`,
    [backupId],
  );
  return r.rows[0] ?? { local: 0, s3: 0 };
}

/** Whether a backup or a recovery of the schedule is running (DeleteScheduledVolumeBackup's refusal). */
export async function volumeBackupBusy(tx: SqlExecutor, backupId: string | number): Promise<boolean> {
  const r = await tx.execute("SELECT 1 FROM deploy.scheduled_volume_backup_executions WHERE scheduled_volume_backup_id = $1 AND (status = 'running' OR stop_recovery_pending OR s3_cleanup_pending) LIMIT 1", [backupId]);
  return r.rows.length > 0;
}

/** $backup->delete(): the schedule with its executions and S3 storages (the foreign keys' cascade in Coolify's schema). */
export async function deleteVolumeBackupSchedule(tx: SqlExecutor, backupId: string | number): Promise<boolean> {
  await tx.execute("DELETE FROM deploy.scheduled_volume_backup_s3_storage WHERE scheduled_volume_backup_id = $1", [backupId]);
  await tx.execute("DELETE FROM deploy.scheduled_volume_backup_executions WHERE scheduled_volume_backup_id = $1", [backupId]);
  return (await tx.execute("DELETE FROM deploy.scheduled_volume_backups WHERE id = $1 RETURNING id", [backupId])).rows.length > 0;
}

export interface DeployServiceDatabaseBackupTargetRow extends SqlRow {
  id: string | number;
  uuid: string;
  image: string | null;
  custom_type: string | null;
  is_migrated: boolean;
}

/** DatabaseBackups::mount()'s $service->databases()->whereUuid(…)->first(): what isBackupSolutionAvailable() reads. */
export async function findServiceDatabaseBackupTarget(tx: SqlExecutor, serviceId: string | number, uuid: string): Promise<DeployServiceDatabaseBackupTargetRow | null> {
  const r = await tx.execute<DeployServiceDatabaseBackupTargetRow>("SELECT id, uuid, image, custom_type, is_migrated FROM deploy.service_databases WHERE service_id = $1 AND uuid = $2 LIMIT 1", [serviceId, uuid]);
  return r.rows[0] ?? null;
}

export interface DeployServiceDatabaseBackupRow extends SqlRow {
  id: string | number;
  uuid: string;
  frequency: string;
  enabled: boolean;
  save_s3: boolean;
  database_id: string | number;
  database_name: string;
  database_human_name: string | null;
  database_status: string;
  latest_status: string | null;
  latest_finished_at: string | null;
  executions_count: number;
  storages: DeployVolumeBackupStorageRef[];
}

/**
 * VolumeBackup\Index's $databaseBackups: the schedules of the service's databases (ScheduledDatabaseBackup whose
 * database is a ServiceDatabase of the service), newest first, with latest_log and the destinations.
 */
export async function listServiceDatabaseBackups(tx: SqlExecutor, serviceId: string | number, serviceDatabaseMorph: string): Promise<DeployServiceDatabaseBackupRow[]> {
  const r = await tx.execute<DeployServiceDatabaseBackupRow>(
    `SELECT b.id, b.uuid, b.frequency, b.enabled, b.save_s3, d.id AS database_id, d.name AS database_name, d.human_name AS database_human_name, d.status AS database_status,
            le.status AS latest_status, to_char(le.finished_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS latest_finished_at,
            (SELECT count(*)::int FROM deploy.scheduled_database_backup_executions x WHERE x.scheduled_database_backup_id = b.id) AS executions_count,
            COALESCE(
              (SELECT json_agg(json_build_object('id', s.id, 'name', s.name, 'type', s.type, 'bucket', s.bucket) ORDER BY p.id)
                 FROM deploy.scheduled_database_backup_s3_storage p JOIN deploy.s3_storages s ON s.id = p.s3_storage_id WHERE p.scheduled_database_backup_id = b.id),
              (SELECT json_agg(json_build_object('id', s.id, 'name', s.name, 'type', s.type, 'bucket', s.bucket)) FROM deploy.s3_storages s WHERE s.id = b.s3_storage_id),
              '[]'::json) AS storages
       FROM deploy.scheduled_database_backups b
       JOIN deploy.service_databases d ON d.id = b.database_id AND d.service_id = $1
       LEFT JOIN LATERAL (SELECT x.status, x.finished_at FROM deploy.scheduled_database_backup_executions x WHERE x.scheduled_database_backup_id = b.id ORDER BY x.created_at DESC NULLS LAST, x.id DESC LIMIT 1) le ON true
      WHERE b.database_type = $2
      ORDER BY b.created_at DESC NULLS LAST, b.id DESC`,
    [serviceId, serviceDatabaseMorph],
  );
  return r.rows.map(parseStorages);
}
