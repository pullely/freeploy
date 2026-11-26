// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Storage/{Index,Create,Form,Show,Resources}.php,
// app/Models/S3Storage.php (the trimming mutators and saving hook) and app/Traits/HasS3Destinations.php
// (Apache-2.0), modified.
//
// The storage pages without what only an SFTP, FTPS or WebDAV storage does:
// list, create (validate, test the connection, then store), show, update
// (validate, test, then store), Validate connection, delete (the schedules
// that use the storage let it go first) and the Resources tab (move a
// schedule to another storage, or take this one out of it).
import type { DeployS3StorageRow, DeployS3StorageWithSecretRow, DeployStorageBackupRow, NewS3Storage, S3StorageFields } from "@saas/db/deploy";
import type { KeyCipher } from "../private-keys/service.js";
import { newPublicId } from "../helpers/names.js";
import { S3ConnectionError, testS3Connection, detectPathStyleEndpoint, type ConnectionTestOptions, type S3Connection } from "./connection.js";
import type { HostResolver } from "./safe-url.js";
import type { StorageInput, StorageType } from "./validation.js";

export interface S3StorageStore {
  list(): Promise<DeployS3StorageRow[]>;
  findByUuid(uuid: string): Promise<DeployS3StorageWithSecretRow | null>;
  insert(storage: Omit<NewS3Storage, "orgId">): Promise<DeployS3StorageRow>;
  update(id: string | number, fields: S3StorageFields): Promise<DeployS3StorageRow | null>;
  setUsable(id: string | number, isUsable: boolean, unusableEmailSent: boolean): Promise<boolean>;
  backupCount(id: string | number): Promise<number>;
  delete(id: string | number): Promise<boolean>;
  listBackups(id: string | number): Promise<DeployStorageBackupRow[]>;
  backupStorageIds(backupId: string | number): Promise<string[]>;
  syncBackupStorages(backupId: string | number, storageIds: string[]): Promise<string | number | null>;
  disableBackupS3(backupId: string | number): Promise<void>;
}

export interface S3StorageContext {
  store: S3StorageStore;
  /** One cipher per encrypted column ("s3_storages.key", "s3_storages.secret"). */
  cipher: (column: string) => KeyCipher;
}

/** What the connection test needs from outside: the resolver and the HTTP exchange. */
export interface S3StorageNetwork extends ConnectionTestOptions {
  resolve: HostResolver;
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    /** The toast's title, where Coolify gives one. */
    readonly title: string | null = null,
  ) {
    super(message);
  }
}

export const STORAGE_TOASTS = {
  createFailed: "Failed to create storage.",
  updated: "Storage settings updated and connection verified.",
  works: "Connection is working.",
  testFailed: "Failed to test connection.",
  switched: 'The provider rejects path-style URLs, so "Use path-style URLs" is now off. Save to keep it.',
  testedWith: 'Tested with "ListObjectsV2" action.',
  storageRemoved: "Storage removed.",
  removedFromDestinations: "This storage was removed from the schedule destinations.",
  s3Disabled: "S3 backup has been disabled for this schedule.",
  noChange: "No change.",
  alreadyUsing: "The backup is already using this storage.",
  storageNotFound: "Storage not found.",
  moved: "Backup moved.",
  movedTo: (name: string) => `Moved to ${name}.`,
  /** Freeploy's: only S3-compatible storages are ported. */
  typeUnavailable: (label: string) => `${label} storages are not available yet.`,
} as const;

const TYPE_LABELS: Record<string, string> = { s3: "S3", sftp: "SFTP", ftps: "FTPS", webdav: "WebDAV" };
export const typeLabel = (type: string): string => TYPE_LABELS[type] ?? type;

/** The bucket, region and endpoint mutators: trimmed, null when empty. */
const trimmed = (v: string | null): string | null => (v && v.trim() !== "" ? v.trim() : null);

export interface StorageListItem {
  uuid: string;
  name: string;
  description: string | null;
  type: string;
  typeLabel: string;
  isUsable: boolean;
}

function item(row: DeployS3StorageRow): StorageListItem {
  return { uuid: row.uuid, name: row.name, description: row.description, type: row.type, typeLabel: typeLabel(row.type), isUsable: row.is_usable };
}

/** Index::mount(): the org's storages by name. */
export async function listStorages(c: S3StorageContext): Promise<StorageListItem[]> {
  return (await c.store.list()).map(item);
}

async function testConnection(conn: S3Connection, net: S3StorageNetwork): Promise<{ ok: true; usePathStyleEndpoint: boolean } | { ok: false; message: string }> {
  try {
    const r = await testS3Connection(conn, net.resolve, net);
    return { ok: true, usePathStyleEndpoint: r.usePathStyleEndpoint };
  } catch (e) {
    if (e instanceof S3ConnectionError) return { ok: false, message: e.message };
    throw e;
  }
}

/**
 * Create::submit() after validate(): the connection is tested with the form's
 * values (the key and secret as typed: the model trims them when it saves),
 * and only then is the storage stored, usable, with the URL style that worked.
 * Runs outside any transaction; `store` stores.
 */
export async function createStorage(
  input: StorageInput & { type: StorageType },
  net: S3StorageNetwork,
  store: (fields: Omit<NewS3Storage, "orgId" | "key" | "secret"> & { key: string; secret: string }) => Promise<DeployS3StorageRow>,
): Promise<DeployS3StorageRow> {
  if (input.type !== "s3") throw new StorageError(STORAGE_TOASTS.typeUnavailable(typeLabel(input.type)), 501, STORAGE_TOASTS.createFailed);
  const endpoint = input.endpoint === "" ? `https://s3.${input.region}.amazonaws.com` : input.endpoint;
  const conn: S3Connection = { endpoint: trimmed(endpoint), bucket: trimmed(input.bucket), region: trimmed(input.region), key: input.key, secret: input.secret, usePathStyleEndpoint: input.usePathStyleEndpoint };
  const tested = await testConnection(conn, net);
  if (!tested.ok) throw new StorageError(tested.message, 422, STORAGE_TOASTS.createFailed);
  return store({
    uuid: newPublicId(),
    type: "s3",
    name: input.name,
    description: input.description,
    region: conn.region ?? "",
    key: input.key.trim(),
    secret: input.secret.trim(),
    bucket: conn.bucket ?? "",
    endpoint: conn.endpoint ?? "",
    usePathStyleEndpoint: tested.usePathStyleEndpoint,
    skipTlsVerification: input.skipTlsVerification,
    isUsable: true,
    unusableEmailSent: false,
  });
}

/** Encrypts the key and secret, then inserts: the second half of a create. */
export async function storeStorage(c: S3StorageContext, fields: Omit<NewS3Storage, "orgId">): Promise<DeployS3StorageRow> {
  return c.store.insert({ ...fields, key: await c.cipher("s3_storages.key").encrypt(fields.key), secret: await c.cipher("s3_storages.secret").encrypt(fields.secret) });
}

export interface StorageDetail extends StorageListItem {
  region: string;
  bucket: string | null;
  endpoint: string | null;
  /** The access key, for who may update; '' otherwise. The secret is never returned. */
  key: string;
  hasSavedSecret: boolean;
  usePathStyleEndpoint: boolean;
  /** usePathStyleEndpointChanged: a saved style that detection would not pick is the user's choice. */
  usePathStyleEndpointChosen: boolean;
  skipTlsVerification: boolean;
  isPasswordHiddenForMember: boolean;
  /** Show::mount()'s backupCount. */
  backupCount: number;
}

/** Show::mount() and Form::syncData(): the storage as its pages read it. */
export async function showStorage(c: S3StorageContext, uuid: string, canUpdate: boolean): Promise<StorageDetail | null> {
  const row = await c.store.findByUuid(uuid);
  if (!row) return null;
  const secret = canUpdate ? await c.cipher("s3_storages.secret").decrypt(row.secret) : "";
  return {
    ...item(row),
    region: row.region,
    bucket: row.bucket,
    endpoint: row.endpoint,
    key: canUpdate ? await c.cipher("s3_storages.key").decrypt(row.key) : "",
    hasSavedSecret: canUpdate && secret !== "",
    usePathStyleEndpoint: row.use_path_style_endpoint,
    usePathStyleEndpointChosen: row.use_path_style_endpoint !== detectPathStyleEndpoint(row.endpoint),
    skipTlsVerification: row.skip_tls_verification,
    isPasswordHiddenForMember: !canUpdate,
    backupCount: await c.store.backupCount(row.id),
  };
}

/** A stored storage with its decrypted credentials: what an update or a test starts from. */
export interface StoredStorage {
  row: DeployS3StorageWithSecretRow;
  key: string;
  secret: string;
}

export async function loadStorage(c: S3StorageContext, uuid: string): Promise<StoredStorage | null> {
  const row = await c.store.findByUuid(uuid);
  if (!row) return null;
  return { row, key: await c.cipher("s3_storages.key").decrypt(row.key), secret: await c.cipher("s3_storages.secret").decrypt(row.secret) };
}

/**
 * Form::submit() after validate(): the form's values, the saved secret where
 * the form leaves it empty; the connection must work with them, else nothing
 * is stored (Coolify's transaction rolls back). Stored usable, with the URL
 * style that worked. `write` stores.
 */
export async function updateStorage(
  stored: StoredStorage,
  input: StorageInput,
  net: S3StorageNetwork,
  write: (fields: S3StorageFields) => Promise<DeployS3StorageRow | null>,
): Promise<DeployS3StorageRow | null> {
  const secret = input.secret.trim() !== "" ? input.secret : stored.secret;
  const conn: S3Connection = { endpoint: trimmed(input.endpoint), bucket: trimmed(input.bucket), region: trimmed(input.region), key: input.key, secret, usePathStyleEndpoint: input.usePathStyleEndpoint };
  const tested = await testConnection(conn, net);
  if (!tested.ok) throw new StorageError(tested.message);
  return write({
    name: input.name ?? "",
    description: input.description,
    region: conn.region ?? "",
    key: input.key.trim(),
    secret: secret.trim(),
    bucket: conn.bucket ?? "",
    endpoint: conn.endpoint ?? "",
    usePathStyleEndpoint: tested.usePathStyleEndpoint,
    skipTlsVerification: input.skipTlsVerification,
    isUsable: true,
    unusableEmailSent: false,
  });
}

/** Encrypts and writes: the second half of an update. */
export async function writeStorage(c: S3StorageContext, id: string | number, fields: S3StorageFields): Promise<DeployS3StorageRow | null> {
  return c.store.update(id, { ...fields, key: await c.cipher("s3_storages.key").encrypt(fields.key), secret: await c.cipher("s3_storages.secret").encrypt(fields.secret) });
}

export interface ValidationOutcome {
  valid: boolean;
  title: string;
  message: string;
  /** The URL style the form now shows (not stored: Save keeps it). */
  usePathStyleEndpoint: boolean;
}

/**
 * Form::testConnection(): the form's values as they are (unsaved; the saved
 * secret where the form leaves it empty, the stored value for a field it does
 * not send). Only the storage's status is stored afterwards.
 */
export async function validateStorage(stored: StoredStorage, body: Record<string, unknown>, net: S3StorageNetwork): Promise<ValidationOutcome> {
  const pick = (field: string, fallback: string | null): string | null => (typeof body[field] === "string" ? (body[field] as string) : fallback);
  const formSecret = typeof body.secret === "string" ? body.secret : "";
  const usePathStyle = typeof body.usePathStyleEndpoint === "boolean" ? body.usePathStyleEndpoint : stored.row.use_path_style_endpoint;
  const conn: S3Connection = {
    endpoint: trimmed(pick("endpoint", stored.row.endpoint)),
    bucket: trimmed(pick("bucket", stored.row.bucket)),
    region: trimmed(pick("region", stored.row.region)),
    key: pick("key", stored.key) ?? "",
    secret: formSecret.trim() !== "" ? formSecret : stored.secret,
    usePathStyleEndpoint: usePathStyle,
  };
  const tested = await testConnection(conn, net);
  if (!tested.ok) return { valid: false, title: STORAGE_TOASTS.testFailed, message: tested.message, usePathStyleEndpoint: usePathStyle };
  const switched = usePathStyle && !tested.usePathStyleEndpoint;
  return { valid: true, title: STORAGE_TOASTS.works, message: switched ? STORAGE_TOASTS.switched : STORAGE_TOASTS.testedWith, usePathStyleEndpoint: tested.usePathStyleEndpoint };
}

/** Show::delete(): the deleting hook lets every schedule go first (the store does both). */
export async function deleteStorage(c: S3StorageContext, uuid: string): Promise<boolean> {
  const row = await c.store.findByUuid(uuid);
  return row ? c.store.delete(row.id) : false;
}

export interface StorageResourceRow {
  uuid: string;
  frequency: string;
  enabled: boolean;
  database: { uuid: string; name: string; projectUuid: string | null; environmentUuid: string | null } | null;
}

/** Resources::render(): the database schedules with S3 on that use the storage, and every storage to move them to. */
export async function storageResources(c: S3StorageContext, uuid: string): Promise<{ backups: StorageResourceRow[]; storages: Array<{ uuid: string; name: string; isUsable: boolean }> } | null> {
  const row = await c.store.findByUuid(uuid);
  if (!row) return null;
  const backups = (await c.store.listBackups(row.id)).map((b) => ({
    uuid: b.uuid,
    frequency: b.frequency,
    enabled: b.enabled,
    database: b.database_uuid ? { uuid: b.database_uuid, name: b.database_name ?? "", projectUuid: b.project_uuid, environmentUuid: b.environment_uuid } : null,
  }));
  const storages = (await c.store.list()).map((s) => ({ uuid: s.uuid, name: s.name, isUsable: s.is_usable }));
  return { backups, storages };
}

/** replaceStorage(): this storage swapped for another (or removed); S3 turns off when nothing remains. Returns save_s3 after. */
async function replaceStorage(c: S3StorageContext, storageId: string | number, backup: DeployStorageBackupRow, newId: string | number | null): Promise<boolean> {
  const ids = (await c.store.backupStorageIds(backup.id)).map((id) => (id === String(storageId) ? (newId === null ? null : String(newId)) : id)).filter((id): id is string => id !== null);
  const unique = [...new Set(ids)];
  await c.store.syncBackupStorages(backup.id, unique);
  if (unique.length === 0 && backup.save_s3) {
    await c.store.disableBackupS3(backup.id);
    return false;
  }
  return backup.save_s3;
}

async function backupUsing(c: S3StorageContext, uuid: string, backupUuid: string): Promise<{ storage: DeployS3StorageWithSecretRow; backup: DeployStorageBackupRow } | null> {
  const storage = await c.store.findByUuid(uuid);
  if (!storage) return null;
  const backup = (await c.store.listBackups(storage.id)).find((b) => b.uuid === backupUuid);
  return backup ? { storage, backup } : null;
}

/** Resources::disableS3(). */
export async function removeFromBackup(c: S3StorageContext, uuid: string, backupUuid: string): Promise<{ title: string; message: string } | null> {
  const found = await backupUsing(c, uuid, backupUuid);
  if (!found) return null;
  const saveS3 = await replaceStorage(c, found.storage.id, found.backup, null);
  return { title: STORAGE_TOASTS.storageRemoved, message: saveS3 ? STORAGE_TOASTS.removedFromDestinations : STORAGE_TOASTS.s3Disabled };
}

/** Resources::moveBackup(): to another storage of the org. */
export async function moveBackup(c: S3StorageContext, uuid: string, backupUuid: string, targetUuid: unknown): Promise<{ title: string; message: string } | null> {
  const found = await backupUsing(c, uuid, backupUuid);
  if (!found) return null;
  if (typeof targetUuid !== "string" || targetUuid === "" || targetUuid === found.storage.uuid) throw new StorageError(STORAGE_TOASTS.alreadyUsing, 422, STORAGE_TOASTS.noChange);
  const target = await c.store.findByUuid(targetUuid);
  if (!target) throw new StorageError(STORAGE_TOASTS.storageNotFound, 422, STORAGE_TOASTS.storageNotFound);
  await replaceStorage(c, found.storage.id, found.backup, target.id);
  return { title: STORAGE_TOASTS.moved, message: STORAGE_TOASTS.movedTo(target.name) };
}
