// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Service/{Storage,FileStorage}.php,
// app/Livewire/Project/Shared/Storages/All.php, app/Models/{LocalPersistentVolume,LocalFileVolume}.php (the
// mutators, the created hook, shouldBeReadOnlyInUI, is_binary, is_too_large), app/Models/Application.php
// (persistentStorageUnavailableReason, git_based) and app/Support/ValidationPatterns.php (volumeNameRules,
// DIRECTORY_PATH_PATTERN) (Apache-2.0), modified.
//
// A resource's Persistent Storage page — an application's or a standalone
// database's (the same Storage component, `:resource`): volume mounts (rows
// only — they take effect at the next deployment or start), and file, host
// file and directory mounts. What differs between the two is the resource
// (resources.ts: its directory on the server, whether its volumes are a
// Compose file's, the preview suffix controls, the multiple servers rule). Where Coolify also acts on the server, its own order of row and
// command decides: what it stores first is stored and the answer says what
// did not run; what it runs first answers 501 and stores nothing.
//
// Coolify's tables refuse a second volume of the same name and a second file
// or directory mount at the same destination path of a resource (their unique
// indexes), and handleError() answers "Duplicate entry found. Please use a
// different name."; the checks are made here, before the row is written.
import { DEPLOY_UNIQUE_INDEXES, refusingDuplicates, type DeployFileVolumeRow, type DeployPersistentVolumeRow } from "@saas/db/deploy";
import { add, blank, length, type FieldErrors } from "../private-keys/validation.js";
import { newPublicId } from "../helpers/names.js";
import { SettingsError, SettingsFieldErrors } from "./settings.js";
import { slug } from "./settings-validation.js";
import { MULTIPLE_SERVERS_VOLUME_REASON, needsExecutor, text, type LoadedResource, type ResourceFrame, type ResourcesContext } from "./resources.js";
import {
  StoragePathError,
  confineFileMountPath,
  isInsideResourceDirectory,
  isOutsideResourceDirectory,
  phpTrim,
  resolveHostPath,
  validateFileMountPath,
  validateHostFileMountPath,
} from "./storage-paths.js";

type Body = Record<string, unknown>;

/** ValidationPatterns::VOLUME_NAME_PATTERN and DIRECTORY_PATH_PATTERN */
export const VOLUME_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export const DIRECTORY_PATH_PATTERN = /^\/([a-zA-Z0-9._\-/~@+]*)?$/;

/** LocalFileVolume::MAX_CONTENT_SIZE and its placeholders */
export const MAX_CONTENT_SIZE = 5_242_880;
export const BINARY_PLACEHOLDER = "[binary file]";
export const TOO_LARGE_PLACEHOLDER = "[file too large to display]";

export const STORAGE_MESSAGES = {
  /** ValidationPatterns::volumeNameMessages() and All::validateStorage() */
  volumeNameRegex: "The volume name must start with an alphanumeric character and contain only alphanumeric characters, dots, hyphens, and underscores.",
  mountPathRegex: "Mount path must start with / and only contain safe path characters.",
  /** Application::persistentStorageUnavailableReason() and Storage::submitPersistentVolume() */
  volumeUnavailable: MULTIPLE_SERVERS_VOLUME_REASON,
  failedToAddVolume: "Failed to add volume.",
  volumeAdded: "Volume added successfully",
  fileAdded: "File mount added successfully",
  hostFileAdded: "Host file mount added successfully",
  directoryAdded: "Directory mount added successfully",
  /** handleError() for a UniqueConstraintViolationException */
  duplicate: "Duplicate entry found. Please use a different name.",
  /** All::submit() and delete() */
  volumeReadOnly: "This volume is read-only.",
  storageUpdated: "Storage updated successfully",
  volumeShared: "This volume is connected to a SQLite database. Unlink it on the SQLite database page.",
  volumeManagedByCompose: "This volume is managed by the current Docker Compose file.",
  volumeHasBackups: "Delete this volume backup schedule and its archives before deleting the volume.",
  /** FileStorage */
  hostFileNotEditable: "Host file mounts are bind-only and cannot be edited from the UI.",
  hostFileNotConvertible: "Host file mounts are bind-only and cannot be converted.",
  hostFileNotLoadable: "Host file mounts are bind-only and cannot be loaded from the server.",
  fileTooLarge: "File on server is too large to edit from the UI.",
  fileUpdated: "File updated.",
  directoryHasBackupsConvert: "Delete this directory backup schedule and its archives before converting it to a file.",
  directoryHasBackupsDelete: "Delete this directory backup schedule and its archives before deleting the directory.",
  fileDeleted: "File deleted.",
  directoryDeleted: "Directory deleted.",
  hostFileRemoved: "Host file mount removed.",
  /** Freeploy's: the SSH executor is not deployed yet. */
  checkPathUnavailable: needsExecutor("Checking the path on the server"),
  writeFileUnavailable: needsExecutor("Writing the file to the server"),
  convertUnavailable: needsExecutor("Converting the mount on the server"),
  loadUnavailable: needsExecutor("Loading the file from the server"),
  deleteFromServerUnavailable: needsExecutor("Deleting the mount from the server"),
  deleteDockerVolumeUnavailable: needsExecutor("Deleting the Docker volume on the server"),
} as const;

const LARAVEL = {
  required: (attribute: string) => `The ${attribute} field is required.`,
  string: (attribute: string) => `The ${attribute} field must be a string.`,
  max: (attribute: string, max: number) => `The ${attribute} field must not be greater than ${max} characters.`,
  boolean: (attribute: string) => `The ${attribute} field must be true or false.`,
};

export interface VolumeItem {
  id: string;
  name: string;
  mountPath: string;
  hostPath: string | null;
  isPreviewSuffixEnabled: boolean;
  /** LocalPersistentVolume::shouldBeReadOnlyInUI(), or the reader may not update. */
  isReadOnly: boolean;
  /** Connected to a SQLite database: its name cannot change and it cannot be deleted here. */
  isShared: boolean;
  backup: { enabled: boolean; s3: boolean };
}

export interface FileItem {
  id: string;
  fsPath: string;
  mountPath: string;
  isDirectory: boolean;
  isHostFile: boolean;
  isBasedOnGit: boolean;
  isPreviewSuffixEnabled: boolean;
  /** Null for a directory, a host file, and for who may not update (the content can hold secrets). */
  content: string | null;
  isBinary: boolean;
  isTooLarge: boolean;
  /** Only a mount inside the resource directory is ever deleted on the server. */
  canDeleteFromServer: boolean;
  hasEnabledBackup: boolean;
}

export type StoragesPage = ResourceFrame & {
  isSwarm: boolean;
  /** Application::git_based(): the views' preview deployment (PR suffix) controls. */
  gitBased: boolean;
  /** Storage::fileStorageHostPath(): the resource's directory on the server. */
  hostPath: string;
  /** Storage::generateDefaultVolumeName() */
  defaultVolumeName: string;
  volumeUnavailableReason: string | null;
  volumes: VolumeItem[];
  files: FileItem[];
  directories: FileItem[];
};

export type StoragesSaved = StoragesPage & {
  /** The success toast (null when Coolify shows none). */
  message: string | null;
  /** What Coolify would now do on the server and cannot be done yet. */
  unavailable?: string;
};

function volumeItem(v: DeployPersistentVolumeRow, l: LoadedResource, canUpdate: boolean): VolumeItem {
  return {
    id: String(v.id),
    name: v.name,
    mountPath: v.mount_path,
    hostPath: blank(v.host_path) ? null : v.host_path,
    isPreviewSuffixEnabled: v.is_preview_suffix_enabled !== false,
    isReadOnly: l.isCompose || !canUpdate,
    isShared: v.standalone_sqlite_id !== null,
    backup: { enabled: v.backup_enabled === true, s3: v.backup_enabled === true && v.backup_save_s3 === true },
  };
}

/** The stored content, decrypted; null stays null. */
async function plainContent(ctx: ResourcesContext, f: DeployFileVolumeRow): Promise<string | null> {
  return f.content === null ? null : ctx.content.decrypt(f.content);
}

async function fileItem(ctx: ResourcesContext, f: DeployFileVolumeRow, workdir: string, canUpdate: boolean): Promise<FileItem> {
  let content = f.is_directory ? null : await plainContent(ctx, f);
  // Storage::loadFileStorageForActiveTab(): a content over the limit is not sent.
  if (content !== null && new TextEncoder().encode(content).length > MAX_CONTENT_SIZE) content = TOO_LARGE_PLACEHOLDER;
  return {
    id: String(f.id),
    fsPath: f.fs_path,
    mountPath: f.mount_path ?? "",
    isDirectory: f.is_directory,
    isHostFile: f.is_host_file,
    isBasedOnGit: f.is_based_on_git,
    isPreviewSuffixEnabled: f.is_preview_suffix_enabled !== false,
    // FileStorage::syncData(): only who may update gets the content.
    content: canUpdate ? content : null,
    isBinary: content === BINARY_PLACEHOLDER,
    isTooLarge: content === TOO_LARGE_PLACEHOLDER,
    canDeleteFromServer: !f.is_host_file && !isOutsideResourceDirectory(f.fs_path, workdir),
    hasEnabledBackup: f.is_directory && f.backup_enabled === true,
  };
}

async function page(ctx: ResourcesContext, l: LoadedResource, canUpdate: boolean): Promise<StoragesPage> {
  const mounts = await Promise.all((await ctx.rows.files(l.id)).map((f) => fileItem(ctx, f, l.workdir, canUpdate)));
  return {
    ...l.frame,
    isSwarm: l.isSwarm,
    gitBased: l.gitBased,
    hostPath: l.workdir,
    defaultVolumeName: `${slug(l.name) || "volume"}-data`,
    volumeUnavailableReason: l.volumeUnavailableReason,
    volumes: (await ctx.rows.volumes(l.id)).map((v) => volumeItem(v, l, canUpdate)),
    files: mounts.filter((f) => !f.isDirectory),
    directories: mounts.filter((f) => f.isDirectory),
  };
}

/** Storage::mount() with its child lists. */
export async function showStorages(ctx: ResourcesContext, uuid: string, canUpdate: boolean): Promise<StoragesPage | null> {
  const l = await ctx.load(uuid, canUpdate);
  return l ? page(ctx, l, canUpdate) : null;
}

async function saved(ctx: ResourcesContext, l: LoadedResource, message: string | null, unavailable?: string): Promise<StoragesSaved> {
  return { ...(await page(ctx, l, true)), message, ...(unavailable ? { unavailable } : {}) };
}

/** A path rule's exception is what handleError() shows: a 422 with its message. */
function pathRule<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof StoragePathError) throw new SettingsError(e.message, 422);
    throw e;
  }
}

function fail(errors: FieldErrors): void {
  if (Object.keys(errors).length) throw new SettingsFieldErrors(errors);
}

/** 'required|string' with Laravel's messages; the string, or null after an error. */
function requiredString(errors: FieldErrors, field: string, attribute: string, value: unknown): string | null {
  const v = text(value);
  if (blank(v)) add(errors, field, LARAVEL.required(attribute));
  else if (typeof v !== "string") add(errors, field, LARAVEL.string(attribute));
  else return v;
  return null;
}

/** ValidationPatterns::volumeNameRules(): required|string|max:255|regex. */
function volumeNameRules(errors: FieldErrors, field: string, value: unknown): string | null {
  const v = requiredString(errors, field, "name", value);
  if (v === null) return null;
  if (length(v) > 255) add(errors, field, LARAVEL.max("name", 255));
  if (!VOLUME_NAME_PATTERN.test(v)) add(errors, field, STORAGE_MESSAGES.volumeNameRegex);
  return v;
}

/** Laravel's `boolean`; `fallback` when the body leaves the field out. */
function booleanRule(errors: FieldErrors, field: string, attribute: string, value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  add(errors, field, LARAVEL.boolean(attribute));
  return fallback;
}

/** unique(name, resource_id, resource_type): the resource has another volume of that name. */
async function assertVolumeNameFree(ctx: ResourcesContext, resourceId: string | number, name: string, except: string | number | null = null): Promise<void> {
  const taken = (await ctx.rows.volumes(resourceId)).some((v) => v.name === name && (except === null || String(v.id) !== String(except)));
  if (taken) throw new SettingsError(STORAGE_MESSAGES.duplicate, 422);
}

/** unique(mount_path, resource_id, resource_type): the resource has another file or directory mount at that path. */
async function assertMountPathFree(ctx: ResourcesContext, resourceId: string | number, mountPath: string): Promise<void> {
  if ((await ctx.rows.files(resourceId)).some((f) => f.mount_path === mountPath)) throw new SettingsError(STORAGE_MESSAGES.duplicate, 422);
}

/** The two indexes themselves: what another request stored since assertVolumeNameFree() or assertMountPathFree() looked. */
const refusingDuplicateStorage = <T>(write: () => Promise<T>): Promise<T> =>
  refusingDuplicates([DEPLOY_UNIQUE_INDEXES.persistentVolumeName, DEPLOY_UNIQUE_INDEXES.fileVolumeMountPath], write, () => new SettingsError(STORAGE_MESSAGES.duplicate, 422));

/** The mountPath mutator: trimmed, with one leading slash. */
const storedMountPath = (value: string): string => `/${phpTrim(value).replace(/^\/+/, "")}`;

/**
 * Storage::submitPersistentVolume(): the name gets the resource's uuid as
 * its prefix, so that the Docker volume is unique on the server.
 */
async function addVolume(ctx: ResourcesContext, l: LoadedResource, body: Body): Promise<StoragesSaved> {
  const errors: FieldErrors = {};
  const name = volumeNameRules(errors, "name", body.name);
  const mountPath = requiredString(errors, "mount_path", "mount path", body.mount_path);
  fail(errors);
  const reason = l.volumeUnavailableReason;
  if (reason) throw new SettingsError(STORAGE_MESSAGES.failedToAddVolume, 422, { description: reason });
  await assertVolumeNameFree(ctx, l.id, `${l.uuid}-${name!}`);
  await refusingDuplicateStorage(() => ctx.rows.insertVolume({ resourceId: l.id, uuid: newPublicId(), name: `${l.uuid}-${name!}`, mountPath: storedMountPath(mountPath!) }));
  return saved(ctx, l, STORAGE_MESSAGES.volumeAdded);
}

/**
 * Storage::submitFileStorage(): a managed file. Without a source path it
 * lives in the resource's directory: the row is stored, and the created
 * hook's job writes the file — not available yet. With a source path Coolify
 * first checks the path on the server, so nothing is stored.
 */
async function addFile(ctx: ResourcesContext, l: LoadedResource, body: Body): Promise<StoragesSaved> {
  const errors: FieldErrors = {};
  const path = requiredString(errors, "file_storage_path", "file storage path", body.file_storage_path);
  const source = text(body.file_storage_source);
  if (!blank(source) && typeof source !== "string") add(errors, "file_storage_source", LARAVEL.string("file storage source"));
  const content = body.file_storage_content;
  if (!blank(content) && typeof content !== "string") add(errors, "file_storage_content", LARAVEL.string("file storage content"));
  fail(errors);
  const workdir = l.workdir;
  const mountPath = pathRule(() => validateFileMountPath(path!, "file storage path"));
  if (!blank(source)) {
    pathRule(() => resolveHostPath(workdir, source as string, "file storage source path"));
    // LocalFileVolume::assertHostPathOnServer(): a confinement or a symlink check, either way on the server.
    throw new SettingsError(STORAGE_MESSAGES.checkPathUnavailable, 501);
  }
  const fsPath = pathRule(() => confineFileMountPath(workdir, mountPath, "file storage path"));
  await assertMountPathFree(ctx, l.id, mountPath);
  const stored = blank(content) ? null : await ctx.content.encrypt(content as string);
  await refusingDuplicateStorage(() => ctx.rows.insertFile({ resourceId: l.id, uuid: newPublicId(), fsPath, mountPath, content: stored, isDirectory: false, isHostFile: false }));
  return saved(ctx, l, STORAGE_MESSAGES.fileAdded, STORAGE_MESSAGES.writeFileUnavailable);
}

/** Storage::submitHostFileStorage(): an existing file of the host, bound as it is. Coolify never writes it. */
async function addHostFile(ctx: ResourcesContext, l: LoadedResource, body: Body): Promise<StoragesSaved> {
  const errors: FieldErrors = {};
  const source = requiredString(errors, "host_file_storage_source", "host file storage source", body.host_file_storage_source);
  const destination = requiredString(errors, "host_file_storage_destination", "host file storage destination", body.host_file_storage_destination);
  fail(errors);
  const fsPath = pathRule(() => validateHostFileMountPath(source!, "host file source path"));
  const mountPath = pathRule(() => validateFileMountPath(destination!, "host file destination path"));
  await assertMountPathFree(ctx, l.id, mountPath);
  await refusingDuplicateStorage(() => ctx.rows.insertFile({ resourceId: l.id, uuid: newPublicId(), fsPath, mountPath, content: null, isDirectory: false, isHostFile: true }));
  return saved(ctx, l, STORAGE_MESSAGES.hostFileAdded);
}

/**
 * Storage::submitFileStorageDirectory(): a directory of the host. Inside the
 * resource's directory Coolify first checks the path on the server, so
 * nothing is stored; a directory elsewhere on the host is only a row (the
 * created hook writes nothing outside the resource directory).
 */
async function addDirectory(ctx: ResourcesContext, l: LoadedResource, body: Body): Promise<StoragesSaved> {
  const errors: FieldErrors = {};
  const source = requiredString(errors, "file_storage_directory_source", "file storage directory source", body.file_storage_directory_source);
  const destination = requiredString(errors, "file_storage_directory_destination", "file storage directory destination", body.file_storage_directory_destination);
  fail(errors);
  const workdir = l.workdir;
  const fsPath = pathRule(() => resolveHostPath(workdir, source!, "storage source path"));
  const mountPath = pathRule(() => validateFileMountPath(destination!, "storage destination path"));
  if (isInsideResourceDirectory(fsPath, workdir)) throw new SettingsError(STORAGE_MESSAGES.checkPathUnavailable, 501);
  await assertMountPathFree(ctx, l.id, mountPath);
  await refusingDuplicateStorage(() => ctx.rows.insertFile({ resourceId: l.id, uuid: newPublicId(), fsPath, mountPath, content: null, isDirectory: true, isHostFile: false }));
  return saved(ctx, l, STORAGE_MESSAGES.directoryAdded);
}

export const STORAGE_TYPES = ["volume", "file", "host-file", "directory"] as const;

/** POST /storages: one of the four "Add mount" forms, named by `type`. Null when the resource is not the org's. */
export async function addStorage(ctx: ResourcesContext, uuid: string, body: Body): Promise<StoragesSaved | null> {
  const l = await ctx.load(uuid, true);
  if (!l) return null;
  switch (body.type) {
    case "volume":
      return addVolume(ctx, l, body);
    case "file":
      return addFile(ctx, l, body);
    case "host-file":
      return addHostFile(ctx, l, body);
    case "directory":
      return addDirectory(ctx, l, body);
    default:
      throw new SettingsFieldErrors({ type: ["The selected type is invalid."] });
  }
}

/**
 * All::submit(): the volume's name, mount path and PR suffix. A new name
 * mounts another Docker volume and the data stays in the old one, so a
 * rename waits for `renameConfirmed` (409 with the two names).
 */
export async function updateVolume(ctx: ResourcesContext, uuid: string, id: string, body: Body): Promise<StoragesSaved | null> {
  const l = await ctx.load(uuid, true);
  const volume = l ? await ctx.rows.findVolume(l.id, id) : null;
  if (!l || !volume) return null;
  const errors: FieldErrors = {};
  const name = volumeNameRules(errors, "name", body.name === undefined ? volume.name : body.name);
  const mountPath = requiredString(errors, "mountPath", "mount", body.mountPath === undefined ? volume.mount_path : body.mountPath);
  if (mountPath !== null && !DIRECTORY_PATH_PATTERN.test(mountPath)) add(errors, "mountPath", STORAGE_MESSAGES.mountPathRegex);
  const suffix = booleanRule(errors, "isPreviewSuffixEnabled", `forms.${id}.is preview suffix enabled`, body.isPreviewSuffixEnabled, volume.is_preview_suffix_enabled !== false);
  fail(errors);
  if (l.isCompose) throw new SettingsError(STORAGE_MESSAGES.volumeReadOnly, 422);
  const rename = volume.standalone_sqlite_id === null && name !== volume.name;
  if (rename && body.renameConfirmed !== true) {
    throw new SettingsError("Change the volume name?", 409, { pendingRename: { storageId: String(volume.id), from: volume.name, to: name } });
  }
  if (rename) await assertVolumeNameFree(ctx, l.id, name!, volume.id);
  await refusingDuplicateStorage(() => ctx.rows.updateVolume(l.id, id, { ...(rename ? { name: name! } : {}), mount_path: storedMountPath(mountPath!), is_preview_suffix_enabled: suffix }));
  return saved(ctx, l, STORAGE_MESSAGES.storageUpdated);
}

/**
 * All::delete(): the row goes. Deleting the Docker volume with it
 * (`deleteDockerVolume`) is a command Coolify runs before it deletes the
 * row: 501, and the row stays.
 */
export async function deleteVolume(ctx: ResourcesContext, uuid: string, id: string, deleteDockerVolume: boolean): Promise<StoragesSaved | null> {
  const l = await ctx.load(uuid, true);
  const volume = l ? await ctx.rows.findVolume(l.id, id) : null;
  if (!l || !volume) return null;
  if (volume.standalone_sqlite_id !== null) throw new SettingsError(STORAGE_MESSAGES.volumeShared, 422);
  // isDeclaredInCompose() reads the Compose file; an unreadable one counts as declaring the volume.
  if (l.isCompose) throw new SettingsError(STORAGE_MESSAGES.volumeManagedByCompose, 422);
  if (volume.has_backups) throw new SettingsError(STORAGE_MESSAGES.volumeHasBackups, 422);
  if (deleteDockerVolume) throw new SettingsError(STORAGE_MESSAGES.deleteDockerVolumeUnavailable, 501);
  await ctx.rows.deleteVolume(l.id, id);
  return saved(ctx, l, null);
}

export const FILE_ACTIONS = ["save", "instantSave", "convertToDirectory", "convertToFile", "loadFromServer"] as const;

/**
 * PATCH /storages/files/{id}: one of FileStorage's actions, named by
 * `action`.
 *
 *   save                submit(): the row, then the file on the server; a failed write puts the row back — 501, nothing stored
 *   instantSave         the content and the two switches, the row only
 *   convertToDirectory  deletes and creates on the server first — 501
 *   convertToFile       likewise — 501
 *   loadFromServer      reads the file on the server — 501
 */
export async function updateFile(ctx: ResourcesContext, uuid: string, id: string, body: Body): Promise<StoragesSaved | null> {
  const l = await ctx.load(uuid, true);
  const file = l ? await ctx.rows.findFile(l.id, id) : null;
  if (!l || !file) return null;
  const tooLarge = !file.is_directory && (await plainContent(ctx, file)) === TOO_LARGE_PLACEHOLDER;
  switch (body.action) {
    case "save":
    case "instantSave": {
      if (file.is_host_file) throw new SettingsError(STORAGE_MESSAGES.hostFileNotEditable, 422);
      if (tooLarge) throw new SettingsError(STORAGE_MESSAGES.fileTooLarge, 422);
      const errors: FieldErrors = {};
      const basedOnGit = booleanRule(errors, "isBasedOnGit", "is based on git", body.isBasedOnGit, file.is_based_on_git);
      const suffix = booleanRule(errors, "isPreviewSuffixEnabled", "is preview suffix enabled", body.isPreviewSuffixEnabled, file.is_preview_suffix_enabled !== false);
      fail(errors);
      if (body.action === "save") throw new SettingsError(STORAGE_MESSAGES.writeFileUnavailable, 501);
      const content = text(body.content);
      const changes: Parameters<typeof ctx.rows.updateFile>[2] = { is_based_on_git: basedOnGit, is_preview_suffix_enabled: suffix };
      // A directory has no content; a file keeps its own when the body leaves it out.
      if (!file.is_directory && body.content !== undefined) changes.content = blank(content) ? null : await ctx.content.encrypt(String(content));
      await ctx.rows.updateFile(l.id, id, changes);
      return saved(ctx, l, STORAGE_MESSAGES.fileUpdated);
    }
    case "convertToDirectory":
      if (file.is_host_file) throw new SettingsError(STORAGE_MESSAGES.hostFileNotConvertible, 422);
      throw new SettingsError(STORAGE_MESSAGES.convertUnavailable, 501);
    case "convertToFile":
      if (file.has_backups) throw new SettingsError(STORAGE_MESSAGES.directoryHasBackupsConvert, 422);
      if (file.is_host_file) throw new SettingsError(STORAGE_MESSAGES.hostFileNotConvertible, 422);
      throw new SettingsError(STORAGE_MESSAGES.convertUnavailable, 501);
    case "loadFromServer":
      if (file.is_host_file) throw new SettingsError(STORAGE_MESSAGES.hostFileNotLoadable, 422);
      throw new SettingsError(STORAGE_MESSAGES.loadUnavailable, 501);
    default:
      throw new SettingsFieldErrors({ action: ["The selected action is invalid."] });
  }
}

/**
 * FileStorage::delete(): the mount's row goes. With `permanently_delete` on a
 * mount inside the resource's directory Coolify first deletes it on the
 * server: 501, and the row stays.
 */
export async function deleteFile(ctx: ResourcesContext, uuid: string, id: string, permanentlyDelete: boolean): Promise<StoragesSaved | null> {
  const l = await ctx.load(uuid, true);
  const file = l ? await ctx.rows.findFile(l.id, id) : null;
  if (!l || !file) return null;
  if (file.has_backups) throw new SettingsError(STORAGE_MESSAGES.directoryHasBackupsDelete, 422);
  const canDeleteFromServer = !file.is_host_file && !isOutsideResourceDirectory(file.fs_path, l.workdir);
  if (canDeleteFromServer && permanentlyDelete) throw new SettingsError(STORAGE_MESSAGES.deleteFromServerUnavailable, 501);
  await ctx.rows.deleteFile(l.id, id);
  return saved(ctx, l, file.is_directory ? STORAGE_MESSAGES.directoryDeleted : file.is_host_file ? STORAGE_MESSAGES.hostFileRemoved : STORAGE_MESSAGES.fileDeleted);
}
