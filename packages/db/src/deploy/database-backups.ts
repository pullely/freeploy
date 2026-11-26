// Derived from coollabsio/coolify@91b7e3e:app/Models/{ScheduledDatabaseBackup,ScheduledDatabaseBackupExecution}.php,
// app/Livewire/Project/Database/{ScheduledBackups,CreateScheduledBackup,BackupEdit}.php,
// app/Livewire/Project/Database/Backup/{Index,ExecutionHistory}.php and
// app/Actions/Database/DeleteScheduledDatabaseBackup.php (Apache-2.0), modified.
//
// deploy.scheduled_database_backups of a standalone database (the morph pair
// database_type / database_id), the S3 destinations of a schedule (the pivot
// and its legacy s3_storage_id) and its executions, which are read only:
// nothing writes an execution before the backup job exists. Every function
// takes the transaction of withOrg().
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

const NOW = "date_trunc('second', timezone('UTC', now()))";

export interface DeployDatabaseBackupRow extends SqlRow {
  id: string | number;
  uuid: string;
  description: string | null;
  enabled: boolean;
  save_s3: boolean;
  frequency: string;
  database_id: string | number;
  database_type: string;
  s3_storage_id: string | number | null;
  databases_to_backup: string | null;
  dump_all: boolean;
  database_backup_retention_amount_locally: number;
  database_backup_retention_days_locally: number;
  database_backup_retention_max_storage_locally: string | number;
  database_backup_retention_amount_s3: number;
  database_backup_retention_days_s3: number;
  database_backup_retention_max_storage_s3: string | number;
  timeout: number;
  disable_local_backup: boolean;
  missing_backup_notification_days: number;
  last_execution_at: string | Date | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

/** A schedule as the list shows it: with withCount('executions') and latest_log. */
export interface DeployDatabaseBackupListRow extends DeployDatabaseBackupRow {
  executions_count: string | number;
  latest_status: string | null;
  latest_finished_at: string | Date | null;
}

const COLUMNS = `b.id, b.uuid, b.description, b.enabled, b.save_s3, b.frequency, b.database_id, b.database_type, b.s3_storage_id,
  b.databases_to_backup, b.dump_all, b.database_backup_retention_amount_locally, b.database_backup_retention_days_locally,
  b.database_backup_retention_max_storage_locally, b.database_backup_retention_amount_s3, b.database_backup_retention_days_s3,
  b.database_backup_retention_max_storage_s3, b.timeout, b.disable_local_backup, b.missing_backup_notification_days,
  b.last_execution_at, b.created_at, b.updated_at`;

/** $database->scheduledBackups (morphMany, by id) withCount('executions') with latest_log. */
export async function listDatabaseBackups(tx: SqlExecutor, databaseType: string, databaseId: string | number): Promise<DeployDatabaseBackupListRow[]> {
  const r = await tx.execute<DeployDatabaseBackupListRow>(
    `SELECT ${COLUMNS},
            (SELECT count(*) FROM deploy.scheduled_database_backup_executions x WHERE x.scheduled_database_backup_id = b.id) AS executions_count,
            l.status AS latest_status, l.finished_at AS latest_finished_at
       FROM deploy.scheduled_database_backups b
       LEFT JOIN LATERAL (SELECT x.status, x.finished_at FROM deploy.scheduled_database_backup_executions x
                           WHERE x.scheduled_database_backup_id = b.id ORDER BY x.created_at DESC, x.id DESC LIMIT 1) l ON true
      WHERE b.database_type = $1 AND b.database_id = $2
      ORDER BY b.id`,
    [databaseType, databaseId],
  );
  return r.rows;
}

/** $database->scheduledBackups()->where('uuid', $uuid)->first() */
export async function findDatabaseBackup(tx: SqlExecutor, databaseType: string, databaseId: string | number, uuid: string): Promise<DeployDatabaseBackupRow | null> {
  const r = await tx.execute<DeployDatabaseBackupRow>(`SELECT ${COLUMNS} FROM deploy.scheduled_database_backups b WHERE b.database_type = $1 AND b.database_id = $2 AND b.uuid = $3`, [
    databaseType,
    databaseId,
    uuid,
  ]);
  return r.rows[0] ?? null;
}

export interface NewDatabaseBackup {
  orgId: string;
  uuid: string;
  frequency: string;
  databaseType: string;
  databaseId: string | number;
  databasesToBackup: string | null;
}

/** CreateScheduledBackup::submit(): enabled, save_s3 off, no storage; every other column keeps the schema's default. */
export async function insertDatabaseBackup(tx: SqlExecutor, b: NewDatabaseBackup): Promise<DeployDatabaseBackupRow> {
  const r = await tx.execute<DeployDatabaseBackupRow>(
    `INSERT INTO deploy.scheduled_database_backups AS b (uuid, enabled, frequency, save_s3, s3_storage_id, database_id, database_type, databases_to_backup, org_id, created_at, updated_at)
     VALUES ($1, true, $2, false, NULL, $3, $4, $5, $6, ${NOW}, ${NOW}) RETURNING ${COLUMNS}`,
    [b.uuid, b.frequency, b.databaseId, b.databaseType, b.databasesToBackup, b.orgId],
  );
  return r.rows[0]!;
}

export interface DatabaseBackupChanges {
  enabled: boolean;
  frequency: string;
  databaseBackupRetentionAmountLocally: number;
  databaseBackupRetentionDaysLocally: number;
  databaseBackupRetentionMaxStorageLocally: number;
  databaseBackupRetentionAmountS3: number;
  databaseBackupRetentionDaysS3: number;
  databaseBackupRetentionMaxStorageS3: number;
  saveS3: boolean;
  disableLocalBackup: boolean;
  databasesToBackup: string | null;
  dumpAll: boolean;
  timeout: number;
  missingBackupNotificationDays: number;
}

/** BackupEdit::syncData(true): the schedule's own columns (its destinations are synced apart). */
export async function updateDatabaseBackup(tx: SqlExecutor, id: string | number, c: DatabaseBackupChanges): Promise<DeployDatabaseBackupRow | null> {
  const r = await tx.execute<DeployDatabaseBackupRow>(
    `UPDATE deploy.scheduled_database_backups AS b SET enabled = $2, frequency = $3,
       database_backup_retention_amount_locally = $4, database_backup_retention_days_locally = $5, database_backup_retention_max_storage_locally = $6,
       database_backup_retention_amount_s3 = $7, database_backup_retention_days_s3 = $8, database_backup_retention_max_storage_s3 = $9,
       save_s3 = $10, disable_local_backup = $11, databases_to_backup = $12, dump_all = $13, timeout = $14, missing_backup_notification_days = $15,
       updated_at = ${NOW}
     WHERE id = $1 RETURNING ${COLUMNS}`,
    [
      id,
      c.enabled,
      c.frequency,
      c.databaseBackupRetentionAmountLocally,
      c.databaseBackupRetentionDaysLocally,
      c.databaseBackupRetentionMaxStorageLocally,
      c.databaseBackupRetentionAmountS3,
      c.databaseBackupRetentionDaysS3,
      c.databaseBackupRetentionMaxStorageS3,
      c.saveS3,
      c.disableLocalBackup,
      c.databasesToBackup,
      c.dumpAll,
      c.timeout,
      c.missingBackupNotificationDays,
    ],
  );
  return r.rows[0] ?? null;
}

/** toggleDatabaseBackup(): enabled flips. */
export async function setDatabaseBackupEnabled(tx: SqlExecutor, id: string | number, enabled: boolean): Promise<boolean> {
  const r = await tx.execute(`UPDATE deploy.scheduled_database_backups SET enabled = $2, updated_at = ${NOW} WHERE id = $1 RETURNING id`, [id, enabled]);
  return r.rows.length > 0;
}

/** The S3 storages a schedule may send to: the usable ones, and those it already has (availableS3StorageIds()), by name. */
export async function availableBackupS3Storages(tx: SqlExecutor, selectedIds: Array<string | number>): Promise<Array<{ id: string | number; uuid: string; name: string; is_usable: boolean; type: string; bucket: string | null }>> {
  const r = await tx.execute<{ id: string | number; uuid: string; name: string; is_usable: boolean; type: string; bucket: string | null }>(
    "SELECT id, uuid, name, is_usable, type, bucket FROM deploy.s3_storages WHERE is_usable OR id::text = ANY($1::text[]) ORDER BY name, id",
    [selectedIds.map(String)],
  );
  return r.rows;
}

/** The storages of a set of schedules (the pivot, else the legacy column), for the list. */
export async function databaseBackupStorages(
  tx: SqlExecutor,
  backupIds: Array<string | number>,
): Promise<Array<{ backup_id: string | number; id: string | number; uuid: string; name: string; type: string; bucket: string | null; is_primary: boolean; legacy: boolean }>> {
  const r = await tx.execute<{ backup_id: string | number; id: string | number; uuid: string; name: string; type: string; bucket: string | null; is_primary: boolean; legacy: boolean }>(
    `SELECT p.scheduled_database_backup_id AS backup_id, s.id, s.uuid, s.name, s.type, s.bucket, (s.id = b.s3_storage_id) AS is_primary, false AS legacy
       FROM deploy.scheduled_database_backup_s3_storage p
       JOIN deploy.s3_storages s ON s.id = p.s3_storage_id
       JOIN deploy.scheduled_database_backups b ON b.id = p.scheduled_database_backup_id
      WHERE p.scheduled_database_backup_id::text = ANY($1::text[])
     UNION ALL
     SELECT b.id AS backup_id, s.id, s.uuid, s.name, s.type, s.bucket, true AS is_primary, true AS legacy
       FROM deploy.scheduled_database_backups b JOIN deploy.s3_storages s ON s.id = b.s3_storage_id
      WHERE b.id::text = ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM deploy.scheduled_database_backup_s3_storage p WHERE p.scheduled_database_backup_id = b.id)
     ORDER BY name, id`,
    [backupIds.map(String)],
  );
  return r.rows;
}

export interface DeployDatabaseBackupExecutionRow extends SqlRow {
  uuid: string;
  backup_uuid: string;
  frequency: string;
  status: string;
  message: string | null;
  size: string | null;
  filename: string | null;
  database_name: string | null;
  created_at: string | Date | null;
  finished_at: string | Date | null;
  local_storage_deleted: boolean;
  s3_storage_deleted: boolean;
  s3_uploaded: boolean | null;
}

/** ExecutionHistory: the executions of every schedule of the database, newest first (read only). */
export async function listDatabaseBackupExecutions(tx: SqlExecutor, databaseType: string, databaseId: string | number, limit = 10): Promise<{ total: number; rows: DeployDatabaseBackupExecutionRow[] }> {
  const where = "FROM deploy.scheduled_database_backup_executions x JOIN deploy.scheduled_database_backups b ON b.id = x.scheduled_database_backup_id WHERE b.database_type = $1 AND b.database_id = $2";
  const total = await tx.execute<{ n: string | number }>(`SELECT count(*) AS n ${where}`, [databaseType, databaseId]);
  const rows = await tx.execute<DeployDatabaseBackupExecutionRow>(
    `SELECT x.uuid, b.uuid AS backup_uuid, b.frequency, x.status, x.message, x.size, x.filename, x.database_name, x.created_at, x.finished_at,
            x.local_storage_deleted, x.s3_storage_deleted, x.s3_uploaded
     ${where} ORDER BY x.created_at DESC, x.id DESC LIMIT $3`,
    [databaseType, databaseId, limit],
  );
  return { total: Number(total.rows[0]?.n ?? 0), rows: rows.rows };
}

/** What DeleteScheduledDatabaseBackup would delete outside the database: local files, and copies on S3. */
export async function databaseBackupFiles(tx: SqlExecutor, id: string | number): Promise<{ localFiles: number; s3Copies: number }> {
  const local = await tx.execute<{ n: string | number }>(
    "SELECT count(*) AS n FROM deploy.scheduled_database_backup_executions WHERE scheduled_database_backup_id = $1 AND NOT local_storage_deleted AND filename IS NOT NULL AND filename <> ''",
    [id],
  );
  const s3 = await tx.execute<{ n: string | number }>(
    `SELECT count(DISTINCT x.id) AS n FROM deploy.scheduled_database_backup_executions x
       JOIN deploy.database_backup_s3_replicas r ON r.execution_id = x.id
      WHERE x.scheduled_database_backup_id = $1 AND r.s3_uploaded AND NOT r.s3_storage_deleted`,
    [id],
  );
  return { localFiles: Number(local.rows[0]?.n ?? 0), s3Copies: Number(s3.rows[0]?.n ?? 0) };
}

/** $backup->delete(): the schedule with its executions, their S3 replicas and its destinations. */
export async function deleteDatabaseBackup(tx: SqlExecutor, id: string | number): Promise<boolean> {
  await tx.execute("DELETE FROM deploy.database_backup_s3_replicas WHERE execution_id IN (SELECT id FROM deploy.scheduled_database_backup_executions WHERE scheduled_database_backup_id = $1)", [id]);
  await tx.execute("DELETE FROM deploy.scheduled_database_backup_executions WHERE scheduled_database_backup_id = $1", [id]);
  await tx.execute("DELETE FROM deploy.scheduled_database_backup_s3_storage WHERE scheduled_database_backup_id = $1", [id]);
  const r = await tx.execute("DELETE FROM deploy.scheduled_database_backups WHERE id = $1 RETURNING id", [id]);
  return r.rows.length > 0;
}

/** data_get($backup->server(), 'settings.server_timezone'): the timezone the schedule runs in. */
export async function serverTimezone(tx: SqlExecutor, serverId: string | number | null): Promise<string | null> {
  if (serverId === null) return null;
  const r = await tx.execute<{ server_timezone: string | null }>("SELECT server_timezone FROM deploy.server_settings WHERE server_id = $1", [serverId]);
  return r.rows[0]?.server_timezone ?? null;
}
