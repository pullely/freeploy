// Derived from coollabsio/coolify@91b7e3e:app/Models/{LocalPersistentVolume,LocalFileVolume}.php (the
// columns, casts and relations: persistentStorages, fileStorages, scheduledBackups) and
// app/Livewire/Project/Service/{Storage,FileStorage}.php, app/Livewire/Project/Shared/Storages/All.php
// (the queries) (Apache-2.0), modified.
//
// deploy.local_persistent_volumes and deploy.local_file_volumes: a resource's
// volume, file and directory mounts. Both are morphs (resource_type,
// resource_id), so every function takes the owner's morph class and id and
// other resource kinds reuse them. Every function takes the transaction of
// withOrg(): row-level security confines each query to that org.
// local_file_volumes.content is an `encrypted` cast: the caller hands in and
// gets back the ciphertext.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { APPLICATION_MORPH_CLASS } from "./application-create.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** getMorphClass() of the models a storage or a tag belongs to (Coolify has no morph map). */
export { APPLICATION_MORPH_CLASS };
export const PERSISTENT_VOLUME_MORPH_CLASS = "App\\Models\\LocalPersistentVolume";
export const FILE_VOLUME_MORPH_CLASS = "App\\Models\\LocalFileVolume";

/** The owner of a storage: its morph class and id. */
export interface StorageOwner {
  type: string;
  id: string | number;
}

export interface DeployPersistentVolumeRow extends SqlRow {
  id: string | number;
  uuid: string | null;
  name: string;
  mount_path: string;
  host_path: string | null;
  is_preview_suffix_enabled: boolean;
  standalone_sqlite_id: string | number | null;
  ignores_compose_driver_options: boolean;
  /** scheduledBackups(): the volume's backup schedule, when it has one. */
  backup_enabled: boolean | null;
  backup_save_s3: boolean | null;
  has_backups: boolean;
}

/** scheduledBackups() of the row `alias`: its first schedule's flags, and whether it has any. The morph class is a bound parameter ($4 below). */
const BACKUP = (alias: string, param: string) => {
  const of = `FROM deploy.scheduled_volume_backups b WHERE b.backupable_type = ${param} AND b.backupable_id = ${alias}.id`;
  return `
       (SELECT b.enabled ${of} ORDER BY b.id LIMIT 1) AS backup_enabled,
       (SELECT b.save_s3 ${of} ORDER BY b.id LIMIT 1) AS backup_save_s3,
       EXISTS (SELECT 1 ${of}) AS has_backups`;
};

const SELECT_VOLUME = `SELECT v.id, v.uuid, v.name, v.mount_path, v.host_path, v.is_preview_suffix_enabled, v.standalone_sqlite_id, v.ignores_compose_driver_options,${BACKUP("v", "$3")}
  FROM deploy.local_persistent_volumes v`;

/** $resource->persistentStorages()->orderBy('id') */
export async function listPersistentVolumes(tx: SqlExecutor, owner: StorageOwner): Promise<DeployPersistentVolumeRow[]> {
  const r = await tx.execute<DeployPersistentVolumeRow>(`${SELECT_VOLUME} WHERE v.resource_type = $1 AND v.resource_id = $2 ORDER BY v.id`, [owner.type, owner.id, PERSISTENT_VOLUME_MORPH_CLASS]);
  return r.rows;
}

/** All::findStorageOrFail(): the volume, only when it is this resource's. */
export async function findPersistentVolume(tx: SqlExecutor, owner: StorageOwner, id: string | number): Promise<DeployPersistentVolumeRow | null> {
  const r = await tx.execute<DeployPersistentVolumeRow>(`${SELECT_VOLUME} WHERE v.resource_type = $1 AND v.resource_id = $2 AND v.id = $4`, [owner.type, owner.id, PERSISTENT_VOLUME_MORPH_CLASS, id]);
  return r.rows[0] ?? null;
}

export interface NewPersistentVolume {
  orgId: string;
  owner: StorageOwner;
  /** BaseModel's creating hook: new_public_id(). */
  uuid: string;
  name: string;
  /** As the mountPath mutator stores it. */
  mountPath: string;
  hostPath: string | null;
}

/** LocalPersistentVolume::create([...]) */
export async function insertPersistentVolume(tx: SqlExecutor, volume: NewPersistentVolume): Promise<DeployPersistentVolumeRow> {
  const r = await tx.execute<{ id: string | number }>(
    `INSERT INTO deploy.local_persistent_volumes (uuid, name, mount_path, host_path, resource_type, resource_id, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, ${NOW}, ${NOW}) RETURNING id`,
    [volume.uuid, volume.name, volume.mountPath, volume.hostPath, volume.owner.type, volume.owner.id, volume.orgId],
  );
  return (await findPersistentVolume(tx, volume.owner, r.rows[0]!.id))!;
}

export const PERSISTENT_VOLUME_COLUMNS = ["name", "mount_path", "is_preview_suffix_enabled"] as const;
export type PersistentVolumeChanges = Partial<Record<(typeof PERSISTENT_VOLUME_COLUMNS)[number], string | boolean>>;

/** $storage->save(): only the given columns, and updated_at. False when the volume is not this resource's. */
export async function updatePersistentVolume(tx: SqlExecutor, owner: StorageOwner, id: string | number, changes: PersistentVolumeChanges): Promise<boolean> {
  const columns = PERSISTENT_VOLUME_COLUMNS.filter((c) => changes[c] !== undefined);
  const sets = columns.map((c, i) => `"${c}" = $${i + 4}`);
  const r = await tx.execute(
    `UPDATE deploy.local_persistent_volumes SET ${[...sets, `updated_at = ${NOW}`].join(", ")} WHERE resource_type = $1 AND resource_id = $2 AND id = $3 RETURNING id`,
    [owner.type, owner.id, id, ...columns.map((c) => changes[c])],
  );
  return r.rows.length > 0;
}

/** $storage->delete() */
export async function deletePersistentVolume(tx: SqlExecutor, owner: StorageOwner, id: string | number): Promise<boolean> {
  const r = await tx.execute("DELETE FROM deploy.local_persistent_volumes WHERE resource_type = $1 AND resource_id = $2 AND id = $3 RETURNING id", [owner.type, owner.id, id]);
  return r.rows.length > 0;
}

export interface DeployFileVolumeRow extends SqlRow {
  id: string | number;
  uuid: string;
  fs_path: string;
  mount_path: string | null;
  /** The fp1 ciphertext of the content, or null. */
  content: string | null;
  is_directory: boolean;
  is_host_file: boolean;
  is_based_on_git: boolean;
  is_preview_suffix_enabled: boolean;
  variable_fs_path: string | null;
  chown: string | null;
  chmod: string | null;
  backup_enabled: boolean | null;
  backup_save_s3: boolean | null;
  has_backups: boolean;
}

const SELECT_FILE = `SELECT f.id, f.uuid, f.fs_path, f.mount_path, f.content, f.is_directory, f.is_host_file, f.is_based_on_git, f.is_preview_suffix_enabled, f.variable_fs_path, f.chown, f.chmod,${BACKUP("f", "$3")}
  FROM deploy.local_file_volumes f`;

/** $resource->fileStorages()->get(): files and directories, oldest first. */
export async function listFileVolumes(tx: SqlExecutor, owner: StorageOwner): Promise<DeployFileVolumeRow[]> {
  const r = await tx.execute<DeployFileVolumeRow>(`${SELECT_FILE} WHERE f.resource_type = $1 AND f.resource_id = $2 ORDER BY f.id`, [owner.type, owner.id, FILE_VOLUME_MORPH_CLASS]);
  return r.rows;
}

/** The file or directory mount, only when it is this resource's. */
export async function findFileVolume(tx: SqlExecutor, owner: StorageOwner, id: string | number): Promise<DeployFileVolumeRow | null> {
  const r = await tx.execute<DeployFileVolumeRow>(`${SELECT_FILE} WHERE f.resource_type = $1 AND f.resource_id = $2 AND f.id = $4`, [owner.type, owner.id, FILE_VOLUME_MORPH_CLASS, id]);
  return r.rows[0] ?? null;
}

export interface NewFileVolume {
  orgId: string;
  owner: StorageOwner;
  /** BaseModel's creating hook: new_public_id(). */
  uuid: string;
  fsPath: string;
  mountPath: string;
  /** The content already encrypted for local_file_volumes.content, or null. */
  content: string | null;
  isDirectory: boolean;
  isHostFile: boolean;
}

/** LocalFileVolume::create([...]); writing the file on the server is the created hook's job, not this one's. */
export async function insertFileVolume(tx: SqlExecutor, volume: NewFileVolume): Promise<DeployFileVolumeRow> {
  const r = await tx.execute<{ id: string | number }>(
    `INSERT INTO deploy.local_file_volumes (uuid, fs_path, mount_path, content, is_directory, is_host_file, resource_type, resource_id, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${NOW}, ${NOW}) RETURNING id`,
    [volume.uuid, volume.fsPath, volume.mountPath, volume.content, volume.isDirectory, volume.isHostFile, volume.owner.type, volume.owner.id, volume.orgId],
  );
  return (await findFileVolume(tx, volume.owner, r.rows[0]!.id))!;
}

export const FILE_VOLUME_COLUMNS = ["content", "is_based_on_git", "is_preview_suffix_enabled"] as const;
export type FileVolumeChanges = Partial<Record<(typeof FILE_VOLUME_COLUMNS)[number], string | boolean | null>>;

/** $fileStorage->save(): only the given columns, and updated_at. False when the mount is not this resource's. */
export async function updateFileVolume(tx: SqlExecutor, owner: StorageOwner, id: string | number, changes: FileVolumeChanges): Promise<boolean> {
  const columns = FILE_VOLUME_COLUMNS.filter((c) => changes[c] !== undefined);
  const sets = columns.map((c, i) => `"${c}" = $${i + 4}`);
  const r = await tx.execute(
    `UPDATE deploy.local_file_volumes SET ${[...sets, `updated_at = ${NOW}`].join(", ")} WHERE resource_type = $1 AND resource_id = $2 AND id = $3 RETURNING id`,
    [owner.type, owner.id, id, ...columns.map((c) => changes[c] ?? null)],
  );
  return r.rows.length > 0;
}

/** $fileStorage->delete() */
export async function deleteFileVolume(tx: SqlExecutor, owner: StorageOwner, id: string | number): Promise<boolean> {
  const r = await tx.execute("DELETE FROM deploy.local_file_volumes WHERE resource_type = $1 AND resource_id = $2 AND id = $3 RETURNING id", [owner.type, owner.id, id]);
  return r.rows.length > 0;
}
