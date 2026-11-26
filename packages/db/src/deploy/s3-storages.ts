// Derived from coollabsio/coolify@91b7e3e:app/Models/S3Storage.php (the columns, the trimming
// mutators and saving hook, ownedByCurrentTeam, detachFromBackups), app/Traits/HasS3Destinations.php
// (usingS3Storage, selectedS3Storages, syncS3Storages), app/Traits/HasS3Replicas.php (refreshS3Summary),
// app/Livewire/Storage/{Show,Resources}.php (the backup count, replaceStorage) (Apache-2.0), modified.
//
// deploy.s3_storages and what refers to a storage: the s3_storage_id of the
// database and volume backup schedules, their pivots
// (scheduled_database_backup_s3_storage, scheduled_volume_backup_s3_storage)
// and the S3 replicas of their executions. Every function takes the
// transaction of withOrg(): row-level security confines each query to that
// org, which is what Coolify's where('team_id', …) does. `key` and `secret`
// hold fp1 ciphertexts (crypto.ts); these functions never decrypt.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { DATABASE_TABLES, DATABASE_ENGINES } from "./databases.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

export interface DeployS3StorageRow extends SqlRow {
  id: string | number;
  uuid: string;
  type: string;
  name: string;
  description: string | null;
  region: string;
  bucket: string | null;
  endpoint: string | null;
  is_usable: boolean;
  unusable_email_sent: boolean;
  use_path_style_endpoint: boolean;
  skip_tls_verification: boolean;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

/** A storage with its stored (encrypted) key and secret. */
export interface DeployS3StorageWithSecretRow extends DeployS3StorageRow {
  key: string;
  secret: string;
}

const COLUMNS = "id, uuid, type, name, description, region, bucket, endpoint, is_usable, unusable_email_sent, use_path_style_endpoint, skip_tls_verification, created_at, updated_at";

/** S3Storage::ownedByCurrentTeam()->get(): by name. */
export async function listS3Storages(tx: SqlExecutor): Promise<DeployS3StorageRow[]> {
  return (await tx.execute<DeployS3StorageRow>(`SELECT ${COLUMNS} FROM deploy.s3_storages ORDER BY name, id`)).rows;
}

/** ownedByCurrentTeam()->whereUuid($uuid)->first(), with the encrypted key and secret. */
export async function findS3StorageByUuid(tx: SqlExecutor, uuid: string): Promise<DeployS3StorageWithSecretRow | null> {
  return (await tx.execute<DeployS3StorageWithSecretRow>(`SELECT ${COLUMNS}, key, secret FROM deploy.s3_storages WHERE uuid = $1`, [uuid])).rows[0] ?? null;
}

export async function findS3StorageById(tx: SqlExecutor, id: string | number): Promise<DeployS3StorageRow | null> {
  return (await tx.execute<DeployS3StorageRow>(`SELECT ${COLUMNS} FROM deploy.s3_storages WHERE id = $1`, [id])).rows[0] ?? null;
}

export interface S3StorageFields {
  name: string | null;
  description: string | null;
  region: string;
  /** fp1 ciphertexts */
  key: string;
  secret: string;
  bucket: string;
  endpoint: string;
  usePathStyleEndpoint: boolean;
  skipTlsVerification: boolean;
  isUsable: boolean;
  unusableEmailSent: boolean;
}

export interface NewS3Storage extends S3StorageFields {
  orgId: string;
  uuid: string;
  type: string;
}

export async function insertS3Storage(tx: SqlExecutor, s: NewS3Storage): Promise<DeployS3StorageRow> {
  const r = await tx.execute<DeployS3StorageRow>(
    `INSERT INTO deploy.s3_storages (uuid, type, name, description, region, key, secret, bucket, endpoint, use_path_style_endpoint, skip_tls_verification, is_usable, unusable_email_sent, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, ${NOW}, ${NOW}) RETURNING ${COLUMNS}`,
    [s.uuid, s.type, s.name, s.description, s.region, s.key, s.secret, s.bucket, s.endpoint, s.usePathStyleEndpoint, s.skipTlsVerification, s.isUsable, s.unusableEmailSent, s.orgId],
  );
  return r.rows[0]!;
}

/** Form::submit(): every field of the form. */
export async function updateS3Storage(tx: SqlExecutor, id: string | number, s: S3StorageFields): Promise<DeployS3StorageRow | null> {
  const r = await tx.execute<DeployS3StorageRow>(
    `UPDATE deploy.s3_storages SET name = $2, description = $3, region = $4, key = $5, secret = $6, bucket = $7, endpoint = $8,
       use_path_style_endpoint = $9, skip_tls_verification = $10, is_usable = $11, unusable_email_sent = $12, updated_at = ${NOW}
     WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, s.name, s.description, s.region, s.key, s.secret, s.bucket, s.endpoint, s.usePathStyleEndpoint, s.skipTlsVerification, s.isUsable, s.unusableEmailSent],
  );
  return r.rows[0] ?? null;
}

/** The columns Coolify's API writes of a storage (DP-81: S3StoragesController::update() and validateStorage()). */
export interface S3StorageColumnChanges {
  name?: string;
  description?: string | null;
  region?: string | null;
  /** fp1 ciphertexts */
  key?: string;
  secret?: string;
  bucket?: string | null;
  endpoint?: string | null;
  use_path_style_endpoint?: boolean;
  skip_tls_verification?: boolean;
  is_usable?: boolean;
  unusable_email_sent?: boolean;
}

const CHANGEABLE: ReadonlyArray<keyof S3StorageColumnChanges> = ["name", "description", "region", "key", "secret", "bucket", "endpoint", "use_path_style_endpoint", "skip_tls_verification", "is_usable", "unusable_email_sent"];

/** $storage->update([...]) / $storage->save(): only the columns given, and updated_at; nothing when none is given. */
export async function updateS3StorageColumns(tx: SqlExecutor, id: string | number, changes: S3StorageColumnChanges): Promise<void> {
  const params: unknown[] = [id];
  const sets: string[] = [];
  for (const column of CHANGEABLE) {
    if (!(column in changes)) continue;
    params.push(changes[column]);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return;
  await tx.execute(`UPDATE deploy.s3_storages SET ${sets.join(", ")}, updated_at = ${NOW} WHERE id = $1`, params);
}

/** Form::testConnection(): only the status of the stored storage changes. */
export async function setS3StorageUsable(tx: SqlExecutor, id: string | number, isUsable: boolean, unusableEmailSent: boolean): Promise<boolean> {
  const r = await tx.execute(`UPDATE deploy.s3_storages SET is_usable = $2, unusable_email_sent = $3, updated_at = ${NOW} WHERE id = $1 RETURNING id`, [id, isUsable, unusableEmailSent]);
  return r.rows.length > 0;
}

/** The two kinds of backup schedule that send to S3 storages: their table and pivot. */
const SCHEDULES = [
  { table: "scheduled_database_backups", pivot: "scheduled_database_backup_s3_storage", fk: "scheduled_database_backup_id" },
  { table: "scheduled_volume_backups", pivot: "scheduled_volume_backup_s3_storage", fk: "scheduled_volume_backup_id" },
] as const;

/** scopeUsingS3Storage(): the schedule's primary destination, or one of its pivot rows. */
const usingStorage = (s: (typeof SCHEDULES)[number], param: string) =>
  `(b.s3_storage_id = ${param} OR EXISTS (SELECT 1 FROM deploy.${s.pivot} p WHERE p.${s.fk} = b.id AND p.s3_storage_id = ${param}))`;

/** Show::mount(): the database and volume backup schedules that use the storage. */
export async function s3StorageBackupCount(tx: SqlExecutor, id: string | number): Promise<number> {
  let n = 0;
  for (const s of SCHEDULES) {
    const r = await tx.execute<{ n: string | number }>(`SELECT count(*) AS n FROM deploy.${s.table} b WHERE ${usingStorage(s, "$1")}`, [id]);
    n += Number(r.rows[0]?.n ?? 0);
  }
  return n;
}

/**
 * syncS3Storages(): the pivot holds exactly `storageIds`; the primary
 * destination stays when it is still selected, else becomes the first one
 * (or none). Returns the new s3_storage_id.
 */
export async function syncScheduleS3Storages(
  tx: SqlExecutor,
  kind: "database" | "volume",
  backupId: string | number,
  storageIds: Array<string | number>,
  orgId: string,
): Promise<string | number | null> {
  const s = SCHEDULES[kind === "database" ? 0 : 1];
  const ids = [...new Set(storageIds.map((id) => String(id)))];
  await tx.execute(`DELETE FROM deploy.${s.pivot} WHERE ${s.fk} = $1 AND NOT (s3_storage_id::text = ANY($2::text[]))`, [backupId, ids]);
  for (const id of ids) {
    await tx.execute(
      `INSERT INTO deploy.${s.pivot} (${s.fk}, s3_storage_id, org_id, created_at, updated_at)
       SELECT $1, $2, $3, ${NOW}, ${NOW} WHERE NOT EXISTS (SELECT 1 FROM deploy.${s.pivot} WHERE ${s.fk} = $1 AND s3_storage_id = $2)`,
      [backupId, id, orgId],
    );
  }
  const r = await tx.execute<{ s3_storage_id: string | number | null }>(
    `UPDATE deploy.${s.table} SET s3_storage_id = CASE WHEN s3_storage_id::text = ANY($2::text[]) THEN s3_storage_id ELSE $3::bigint END, updated_at = ${NOW}
     WHERE id = $1 RETURNING s3_storage_id`,
    [backupId, ids, ids[0] ?? null],
  );
  return r.rows[0]?.s3_storage_id ?? null;
}

/** A schedule's destinations as the pivot holds them, in the order they were added. */
async function pivotStorageIds(tx: SqlExecutor, s: (typeof SCHEDULES)[number], backupId: string | number): Promise<string[]> {
  return (await tx.execute<{ id: string | number }>(`SELECT s3_storage_id AS id FROM deploy.${s.pivot} WHERE ${s.fk} = $1 ORDER BY id`, [backupId])).rows.map((r) => String(r.id));
}

/**
 * S3Storage::delete() with its deleting hook, detachFromBackups(): each
 * schedule that uses the storage keeps its other destinations (its primary
 * moves to one of them) or stops S3 backups when none remains; the storage's
 * S3 copies are marked deleted and their executions' summaries refreshed;
 * a volume execution waiting for an S3 cleanup that has nothing left to clean
 * stops waiting. Then the row.
 */
export async function deleteS3Storage(tx: SqlExecutor, id: string | number, orgId: string): Promise<boolean> {
  for (const [i, s] of SCHEDULES.entries()) {
    const using = await tx.execute<{ id: string | number }>(`SELECT b.id FROM deploy.${s.table} b WHERE ${usingStorage(s, "$1")} ORDER BY b.id`, [id]);
    for (const { id: backupId } of using.rows) {
      const remaining = (await pivotStorageIds(tx, s, backupId)).filter((x) => x !== String(id));
      const primary = await syncScheduleS3Storages(tx, i === 0 ? "database" : "volume", backupId, remaining, orgId);
      if (primary === null) await tx.execute(`UPDATE deploy.${s.table} SET save_s3 = false, updated_at = ${NOW} WHERE id = $1 AND save_s3`, [backupId]);
    }
  }
  for (const [replicas, executions] of [
    ["database_backup_s3_replicas", "scheduled_database_backup_executions"],
    ["volume_backup_s3_replicas", "scheduled_volume_backup_executions"],
  ] as const) {
    const touched = await tx.execute<{ execution_id: string | number }>(
      `UPDATE deploy.${replicas} SET s3_storage_deleted = true, updated_at = ${NOW} WHERE s3_storage_id = $1 AND NOT s3_storage_deleted RETURNING execution_id`,
      [id],
    );
    // refreshS3Summary(): uploaded when every replica is; deleted when every uploaded one is.
    for (const executionId of new Set(touched.rows.map((r) => String(r.execution_id)))) {
      await tx.execute(
        `UPDATE deploy.${executions} x SET
           s3_uploaded = (SELECT bool_and(COALESCE(r.s3_uploaded, false)) FROM deploy.${replicas} r WHERE r.execution_id = x.id),
           s3_storage_deleted = COALESCE((SELECT bool_and(r.s3_storage_deleted) FROM deploy.${replicas} r WHERE r.execution_id = x.id AND r.s3_uploaded), false),
           updated_at = ${NOW}
         WHERE x.id = $1`,
        [executionId],
      );
    }
  }
  await tx.execute(
    `UPDATE deploy.scheduled_volume_backup_executions x SET s3_cleanup_pending = false
     WHERE x.s3_cleanup_pending
       AND EXISTS (SELECT 1 FROM deploy.volume_backup_s3_replicas r WHERE r.execution_id = x.id AND r.s3_storage_id = $1)
       AND NOT EXISTS (SELECT 1 FROM deploy.volume_backup_s3_replicas r WHERE r.execution_id = x.id AND NOT r.s3_storage_deleted AND (r.s3_uploaded IS NULL OR r.s3_uploaded = false))`,
    [id],
  );
  const r = await tx.execute("DELETE FROM deploy.s3_storages WHERE id = $1 RETURNING id", [id]);
  return r.rows.length > 0;
}

/** A database backup schedule that sends to a storage, with its database (Resources). */
export interface DeployStorageBackupRow extends SqlRow {
  id: string | number;
  uuid: string;
  frequency: string;
  enabled: boolean;
  save_s3: boolean;
  s3_storage_id: string | number | null;
  database_type: string;
  database_id: string | number;
  database_uuid: string | null;
  database_name: string | null;
  environment_uuid: string | null;
  project_uuid: string | null;
}

/** The nine standalone tables as one relation: what a backup schedule's morphTo() reaches. */
export const STANDALONE_DATABASES_SQL = DATABASE_ENGINES.map(
  (e) => `SELECT E'${DATABASE_TABLES[e].morphClass.replace(/\\/g, "\\\\")}'::text AS morph, id, uuid, name, environment_id FROM deploy.${DATABASE_TABLES[e].table} WHERE deleted_at IS NULL`,
).join(" UNION ALL ");

/** Resources::render(): the database schedules with save_s3 that use the storage, with their database. */
export async function listS3StorageDatabaseBackups(tx: SqlExecutor, id: string | number): Promise<DeployStorageBackupRow[]> {
  const r = await tx.execute<DeployStorageBackupRow>(
    `SELECT b.id, b.uuid, b.frequency, b.enabled, b.save_s3, b.s3_storage_id, b.database_type, b.database_id,
            d.uuid AS database_uuid, d.name AS database_name, e.uuid AS environment_uuid, p.uuid AS project_uuid
       FROM deploy.scheduled_database_backups b
       LEFT JOIN (${STANDALONE_DATABASES_SQL}) d ON d.morph = b.database_type AND d.id = b.database_id
       LEFT JOIN deploy.environments e ON e.id = d.environment_id
       LEFT JOIN deploy.projects p ON p.id = e.project_id
      WHERE b.save_s3 AND ${usingStorage(SCHEDULES[0], "$1")}
      ORDER BY b.database_type, b.database_id, b.id`,
    [id],
  );
  return r.rows;
}

/** selectedS3Storages() of a database schedule: the pivot's storages (the primary first), else its legacy s3_storage_id. */
export async function databaseBackupStorageIds(tx: SqlExecutor, backupId: string | number): Promise<string[]> {
  const r = await tx.execute<{ id: string | number; s3_storage_id: string | number | null }>(
    `SELECT s.id, b.s3_storage_id FROM deploy.scheduled_database_backups b
       JOIN deploy.scheduled_database_backup_s3_storage p ON p.scheduled_database_backup_id = b.id
       JOIN deploy.s3_storages s ON s.id = p.s3_storage_id
      WHERE b.id = $1 ORDER BY (s.id = b.s3_storage_id) DESC, s.name, s.id`,
    [backupId],
  );
  if (r.rows.length) return r.rows.map((x) => String(x.id));
  const legacy = await tx.execute<{ id: string | number }>(
    "SELECT s.id FROM deploy.scheduled_database_backups b JOIN deploy.s3_storages s ON s.id = b.s3_storage_id WHERE b.id = $1",
    [backupId],
  );
  return legacy.rows.map((x) => String(x.id));
}

/** $backup->update(['save_s3' => false]) */
export async function disableDatabaseBackupS3(tx: SqlExecutor, backupId: string | number): Promise<void> {
  await tx.execute(`UPDATE deploy.scheduled_database_backups SET save_s3 = false, updated_at = ${NOW} WHERE id = $1`, [backupId]);
}
