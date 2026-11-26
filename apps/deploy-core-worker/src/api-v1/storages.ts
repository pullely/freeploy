// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/{Applications,Databases,Services}Controller.php
// (storages, create_storage, update_storage, delete_storage, exposeFileStorageContentIfAllowed),
// app/Http/Controllers/Api/Concerns/{RequiresDeployForOutsideHostPaths,RequiresDeployAbility}.php,
// app/Models/{LocalPersistentVolume,LocalFileVolume}.php ($hidden, $casts, $appends, the mutators, shouldBeReadOnlyInUI,
// isReadOnlyVolume, isServiceResource, isSharedWithAnotherResource, abortIfScheduledBackupsExist, isOutsideResourceDirectory)
// and app/Models/Application.php (persistentStorageUnavailableReason) (Apache-2.0), modified.
//
// Coolify's /api/v1 for the storages of an application, a standalone database and a service (DP-84): a resource's volume
// mounts (LocalPersistentVolume) and file, host file and directory mounts (LocalFileVolume), on the storage rows the
// console's Persistent Storage pages use (packages/db's deploy/storages.ts). Volumes are rows only. Where Coolify then writes
// to the server — a managed file's content (the created hook's and update's ServerStorageSaveJob), the path check of a
// directory or a file with a source path (assertHostPathOnServer), deleting a mount inside the resource directory
// (deleteStorageOnServer) — Freeploy answers 501 in Coolify's envelope after Coolify's own refusals, before anything is
// stored. Host file mounts, and directories outside the resource directory, are rows only there too.
//
// The answers are response()->json() of the models (no serializeApiResponse()): toArray() unsorted, the columns in
// Coolify's order, with the relations the controller happened to load — `resource` (canReadResourceSecretsFromApi() reads
// it) and, for a file, `service` (isReadOnlyVolume() reads it first): the application as DP-78's applicationRelation()
// serializes it, the database as databaseResource() does for a token that may not read secrets, a service's part with
// its loaded service.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { APPLICATION_MORPH_CLASS, DATABASE_TABLES, FILE_VOLUME_MORPH_CLASS, PERSISTENT_VOLUME_MORPH_CLASS, SERVICE_PART_MORPH_CLASS, deleteFileVolume, deletePersistentVolume, findDatabaseByUuid, insertFileVolume, insertPersistentVolume, updateFileVolume, updatePersistentVolume, type ApiRow, type ApiTable, type DatabaseEngine, type FileVolumeChanges, type PersistentVolumeChanges } from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, laravelDate, obj, type CoolifyAnswer, type PhpObject, type PhpValue } from "@saas/contracts/coolify-api";
import { columnCipher } from "../handlers/cloud-tokens.js";
import { STORAGE_MESSAGES } from "../applications/storages.js";
import { MULTIPLE_SERVERS_VOLUME_REASON } from "../applications/resources.js";
import { StoragePathError, applicationWorkdir, confineFileMountPath, databaseWorkdir, isOutsideResourceDirectory, phpTrim, resolveHostPath, validateFileMountPath, validateHostFileMountPath } from "../applications/storage-paths.js";
import { partUrl } from "../services/configuration.js";
import { serviceWorkdir } from "../services/resources.js";
import { parseDockerComposeYaml } from "../compose/yaml.js";
import { dataGet } from "../compose/support.js";
import { isPhpArray } from "../compose/php.js";
import { newPublicId } from "../helpers/names.js";
import { applicationRelation } from "./applications.js";
import { databaseResource } from "./databases.js";
import { serviceResource } from "./services.js";
import { inCoolifyOrder } from "./columns.js";
import { hasDeployAbility, message, rowsOf, unavailable, UPDATE_DENIED, type ApiV1Context, type Rows } from "./context.js";
import { SERVICE_APPLICATION, SERVICE_DATABASE, rowValue, toModel, type ModelShape } from "./models.js";
import { extraFields, readApiBody, requestBoolean, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rule, type Rules } from "./rules.js";

export type StorageKind = "application" | "database" | "service";

const PERSISTENT_VOLUME: ModelShape = { hidden: [], dates: ["created_at", "updated_at"] };
/** LocalFileVolume: content hidden ($hidden), an `encrypted` cast; RecordsWorkerHost is the executions', not this one's. */
const FILE_VOLUME: ModelShape = { hidden: ["content"], dates: ["created_at", "updated_at"] };
const CONTENT_COLUMN = "local_file_volumes.content";

/** Laravel's error page of an exception the handler renders as JSON (JSON_PRETTY_PRINT). */
const SERVER_ERROR: CoolifyAnswer = { status: 500, body: '{\n    "message": "Server Error"\n}', headers: { "content-type": "application/json" } };
/** abort(422, …) rendered the same way. */
const aborted = (text: string): CoolifyAnswer => ({ status: 422, body: `{\n    "message": ${JSON.stringify(text).replace(/\//g, "\\/")}\n}`, headers: { "content-type": "application/json" } });

const NOT_FOUND = {
  application: { list: "Application not found", create: "Application not found.", update: "Application not found", delete: "Application not found." },
  database: { list: "Database not found.", create: "Database not found.", update: "Database not found.", delete: "Database not found." },
  service: { list: "Service not found.", create: "Service not found.", update: "Service not found.", delete: "Service not found." },
} as const;

const denied = async (c: ApiV1Context, write: boolean, policyMessage?: string): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized(policyMessage));
const deployForbidden = (c: ApiV1Context, reason: string): CoolifyAnswer | null => (hasDeployAbility(c) ? null : message(`Missing required permissions: deploy. ${reason}`, 403));
const OUTSIDE_REASON = "A mount outside the resource directory needs a token with the deploy permission.";
const CONTENT_REASON = "Coolify writes the file content on the server immediately, so it needs a token with the deploy permission.";

/** PHP's falsiness (`! $request->name`). */
const phpFalsy = (v: unknown): boolean => v === undefined || v === null || v === false || v === 0 || v === "" || v === "0" || (Array.isArray(v) && v.length === 0);
/** $request->filled() */
const filled = (v: unknown): boolean => !(v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0));
/** PHP's (string) cast. */
const phpString = (v: unknown): string => (v === true ? "1" : v === false || v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "number" ? String(v) : "Array");
/** LocalPersistentVolume's mountPath mutator: str()->trim()->start('/'). */
const storedMountPath = (value: string): string => `/${phpTrim(value).replace(/^\/+/, "")}`;

/** `$request->uuid`: the input (the body, then the query string) before the route parameter. */
function param(c: ApiV1Context, all: Record<string, unknown>, route: string): unknown {
  if ("uuid" in all) return all.uuid;
  const q = c.url.searchParams.get("uuid");
  return q !== null ? q : route;
}

// ── the resource and its owners ─────────────────────────────────────────────

/** What a storage belongs to: the resource itself, or one of a service's applications and databases. */
export interface Owner {
  type: string;
  id: string | number;
  uuid: string;
  row: ApiRow;
  /** A service's part: which one (the list's resource_type). */
  part?: "application" | "database";
}

export interface Target {
  kind: StorageKind;
  row: ApiRow;
  /** The resource directory on the server (Storage::fileStorageHostPath(), workdir()). */
  workdir: string;
  owners: Owner[];
  engine?: DatabaseEngine;
}

const queryUuid = (v: unknown): string | null => (typeof v === "string" || typeof v === "number" ? String(v) : null);

export async function findTarget(tx: SqlExecutor, rows: Rows, kind: StorageKind, uuid: unknown): Promise<Target | null> {
  const key = queryUuid(uuid);
  if (key === null) return null;
  if (kind === "application") {
    // Application::ownedByCurrentTeamAPI()
    const row = (await rows("applications", "t.deleted_at IS NULL AND t.uuid = $1", [key]))[0];
    if (!row) return null;
    return { kind, row, workdir: applicationWorkdir(String(rowValue(row, "uuid"))), owners: [{ type: APPLICATION_MORPH_CLASS, id: rowValue(row, "id") as number, uuid: String(rowValue(row, "uuid")), row }] };
  }
  if (kind === "database") {
    // queryDatabaseByUuidWithinTeam()
    const db = await findDatabaseByUuid(tx, key);
    if (!db) return null;
    const table = DATABASE_TABLES[db.engine];
    const row = (await rows(table.table as ApiTable, "t.deleted_at IS NULL AND t.uuid = $1", [db.uuid]))[0];
    if (!row) return null;
    return { kind, row, engine: db.engine, workdir: databaseWorkdir(db.uuid), owners: [{ type: table.morphClass, id: rowValue(row, "id") as number, uuid: db.uuid, row }] };
  }
  // Service::whereRelation('environment.project.team', …)->whereUuid(): its applications, then its databases.
  const row = (await rows("services", "t.deleted_at IS NULL AND t.uuid = $1", [key]))[0];
  if (!row) return null;
  const id = rowValue(row, "id");
  const owners: Owner[] = [];
  for (const a of await rows("service_applications", "t.deleted_at IS NULL AND t.service_id = $1", [id])) owners.push({ type: SERVICE_PART_MORPH_CLASS.application, id: rowValue(a, "id") as number, uuid: String(rowValue(a, "uuid")), row: a, part: "application" });
  for (const d of await rows("service_databases", "t.deleted_at IS NULL AND t.service_id = $1", [id])) owners.push({ type: SERVICE_PART_MORPH_CLASS.database, id: rowValue(d, "id") as number, uuid: String(rowValue(d, "uuid")), row: d, part: "database" });
  return { kind, row, workdir: serviceWorkdir(String(rowValue(row, "uuid"))), owners };
}
const OWNED_BY = "t.resource_type = $1 AND t.resource_id = $2";
const volumesOf = (rows: Rows, o: Owner) => rows("local_persistent_volumes", OWNED_BY, [o.type, o.id]);
const filesOf = (rows: Rows, o: Owner) => rows("local_file_volumes", OWNED_BY, [o.type, o.id]);

/** The loaded `resource` relation: the model a storage's morphTo gives, as toArray() writes a nested relation. */
async function resourceModel(tx: SqlExecutor, c: ApiV1Context, t: Target, o: Owner, withService = false): Promise<PhpObject> {
  if (t.kind === "application") return applicationRelation(tx, c, o.row);
  if (t.kind === "database") return (await databaseResource(tx, { ...c, canReadSensitive: false }, t.engine!, o.row))!;
  const extra: Array<[string, PhpValue]> = [];
  if (o.part === "application") extra.push(["url", partUrl({ fqdn: rowValue(o.row, "fqdn") as string | null, domain_port_overrides: rowValue(o.row, "domain_port_overrides") as never })]);
  // isReadOnlyVolume() reads the part's service.
  if (withService) extra.push(["service", await serviceResource(tx, { ...c, canReadSensitive: false }, t.row)]);
  return o.part === "application" ? toModel(inCoolifyOrder(o.row, "service_applications"), SERVICE_APPLICATION, { extra }) : toModel(inCoolifyOrder(o.row, "service_databases"), SERVICE_DATABASE, { extra });
}

/** The stored content, decrypted (an `encrypted` cast). */
async function plainContent(tx: SqlExecutor, c: ApiV1Context, stored: unknown): Promise<string | null> {
  return stored === null || stored === undefined ? null : columnCipher(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, CONTENT_COLUMN).decrypt(String(stored));
}

/** A volume row: every column in Coolify's order, and what the caller set or loaded. */
const volumeModel = (row: ApiRow, extra: Array<[string, PhpValue]> = []): PhpObject => toModel(inCoolifyOrder(row, "local_persistent_volumes"), PERSISTENT_VOLUME, { extra });

/** A file row: the content made visible for a token that may read secrets (exposeFileStorageContentIfAllowed()), the appends, then the loaded relations. */
async function fileModel(tx: SqlExecutor, c: ApiV1Context, row: ApiRow, relations: Array<[string, PhpValue]>): Promise<PhpObject> {
  const content = await plainContent(tx, c, rowValue(row, "content"));
  const extra: Array<[string, PhpValue]> = [];
  if (c.canReadSensitive) extra.push(["content", content]);
  extra.push(["is_binary", content === STORAGE_BINARY], ["is_too_large", content === STORAGE_TOO_LARGE], ...relations);
  return toModel(inCoolifyOrder(row, "local_file_volumes"), FILE_VOLUME, { visible: c.canReadSensitive ? ["content"] : [], extra });
}
const STORAGE_BINARY = "[binary file]";
const STORAGE_TOO_LARGE = "[file too large to display]";

/** LocalFileVolume::isReadOnlyVolume(): a service part's file mounted `:ro` (or read_only) by the service's Compose file. */
function fileIsReadOnly(t: Target, o: Owner, mountPath: unknown): boolean {
  if (t.kind !== "service") return false;
  try {
    const raw = rowValue(t.row, "docker_compose_raw");
    if (typeof raw !== "string" || raw === "") return false;
    const compose = parseDockerComposeYaml(raw);
    const volumes = dataGet(compose, ["services", String(rowValue(o.row, "name")), "volumes"]);
    if (!isPhpArray(volumes)) return false;
    const mount = phpString(mountPath);
    const clean = (p: string) => p.replace(/^\/+/, "");
    for (const volume of volumes.values()) {
      if (typeof volume === "string") {
        const parts = volume.split(":");
        if (parts.length >= 2 && (clean(mount) === clean(parts[1]!) || mount === parts[1])) return parts[2] === "ro";
      } else if (isPhpArray(volume)) {
        const target = phpString(dataGet(volume, "target"));
        if (clean(mount) === clean(target) || mount === target) return dataGet(volume, "read_only", false) === true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** shouldBeReadOnlyInUI(): every volume of a service's part; a file the Compose file mounts read-only. */
const readOnly = (t: Target, o: Owner, file: ApiRow | null): boolean => (file ? fileIsReadOnly(t, o, rowValue(file, "mount_path")) : t.kind === "service");

// ── routes ──────────────────────────────────────────────────────────────────

/** routes/api.php's /{applications,databases,services}/{uuid}/storages routes; null for any other path (the fallback 404). */
export async function storagesApi(c: ApiV1Context, kind: StorageKind, uuid: string, segments: string[]): Promise<CoolifyAnswer | null> {
  const [storageUuid, extra] = segments;
  if (extra !== undefined) return null;
  const m = c.method;
  if (storageUuid === undefined) return m === "GET" ? listStorages(c, kind, uuid) : m === "POST" ? createStorage(c, kind, uuid) : m === "PATCH" ? updateStorage(c, kind, uuid) : null;
  return m === "DELETE" ? deleteStorage(c, kind, uuid, storageUuid) : null;
}

async function listStorages(c: ApiV1Context, kind: StorageKind, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const t = await findTarget(tx, rows, kind, param(c, {}, uuid));
    if (!t) return message(NOT_FOUND[kind].list, 404);
    const no = await denied(c, false);
    if (no) return no;
    const volumes: Array<{ id: number; model: PhpObject }> = [];
    const files: Array<{ id: number; model: PhpObject }> = [];
    for (const o of t.owners) {
      for (const v of await volumesOf(rows, o)) volumes.push({ id: Number(rowValue(v, "id")), model: volumeModel(v, o.part ? [["resource_type", o.part], ["resource_uuid", o.uuid]] : []) });
      const own = await filesOf(rows, o);
      // A service: setAttribute('resource_type', 'application'), then $storage->resource, a morphTo to no class — Coolify's own failure.
      if (t.kind === "service" && own.length) return SERVER_ERROR;
      if (own.length) {
        const resource = await resourceModel(tx, c, t, o);
        for (const f of own) files.push({ id: Number(rowValue(f, "id")), model: await fileModel(tx, c, f, [["resource", resource]]) });
      }
    }
    // ->sortBy('id')->values()
    const sorted = (list: typeof volumes) => [...list].sort((a, b) => a.id - b.id).map((x) => x.model);
    return coolifyJson(obj({ persistent_storages: sorted(volumes), file_storages: sorted(files) }));
  });
}

const TYPE_RULE: Rule = { closure: (v) => (["persistent", "file"].includes(phpString(v)) && (typeof v === "string" || typeof v === "number") ? [] : ["The selected type is invalid."]) };
const VOLUME_NAME_RULE: Rule = { regex: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ };

const createRules = (kind: StorageKind): Rules => [
  ["type", ["required", "string", TYPE_RULE]],
  ...(kind === "service" ? ([["resource_uuid", ["required", "string"]]] as Rules) : []),
  ["name", ["string", VOLUME_NAME_RULE]],
  ["mount_path", ["required", "string"]],
  ["content", ["string", "nullable"]],
  ["is_directory", ["boolean"]],
  ["is_host_file", ["boolean"]],
  ["fs_path", ["string"]],
];
const CREATE_FIELDS = ["type", "name", "mount_path", "content", "is_directory", "is_host_file", "fs_path"];

/** mapWithKeys(): each field the type does not take, with its message. */
const fieldsNotValid = (fields: string[], type: string): CoolifyAnswer =>
  coolifyJson(obj({ message: "Validation failed.", errors: obj(fields.map((f): [string, PhpValue] => [f, `Field '${f}' is not valid for type '${type}'.`])) }), 422);
const failedOn = (field: string, text: string): CoolifyAnswer => coolifyJson(obj({ message: "Validation failed.", errors: obj({ [field]: text }) }), 422);

/** A path rule's exception, as the controller's catch writes it under `field`. */
function pathOr(field: string, fn: () => string): string | CoolifyAnswer {
  try {
    return fn();
  } catch (e) {
    if (e instanceof StoragePathError) return failedOn(field, e.message);
    throw e;
  }
}

async function createStorage(c: ApiV1Context, kind: StorageKind, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const t = await findTarget(tx, rows, kind, param(c, all, uuid));
    if (!t) return message(NOT_FOUND[kind].create, 404);
    const no = await denied(c, true, UPDATE_DENIED[kind]);
    if (no) return no;
    const errors: Errors = [];
    await validateRules(errors, all, createRules(kind));
    extraFields(errors, all, kind === "service" ? [...CREATE_FIELDS.slice(0, 1), "resource_uuid", ...CREATE_FIELDS.slice(1)] : CREATE_FIELDS);
    if (errors.length) return validationFailed(errors);
    // A service: the storage belongs to one of its applications, else of its databases.
    const owner = kind === "service" ? (t.owners.find((o) => o.part === "application" && o.uuid === all.resource_uuid) ?? t.owners.find((o) => o.part === "database" && o.uuid === all.resource_uuid)) : t.owners[0];
    if (!owner) return message("Service resource not found.", 404);
    const keys = Object.keys(all);
    if (all.type === "persistent") {
      if (phpFalsy(all.name)) return failedOn("name", "The name field is required for persistent storages.");
      const invalid = ["content", "is_directory", "is_host_file", "fs_path"].filter((f) => keys.includes(f));
      if (invalid.length) return fieldsNotValid(invalid, "persistent");
      if (kind === "application" && (await rows("additional_destinations", "t.application_id = $1", [owner.id])).length) return message(MULTIPLE_SERVERS_VOLUME_REASON, 422);
      const name = `${owner.uuid}-${phpString(all.name)}`;
      // The unique index (name, resource_id, resource_type): Coolify's UniqueConstraintViolationException, its error page.
      if ((await volumesOf(rows, owner)).some((v) => rowValue(v, "name") === name)) return SERVER_ERROR;
      const mountPath = storedMountPath(phpString(all.mount_path));
      const created = await insertPersistentVolume(tx, { orgId: c.orgId, owner: { type: owner.type, id: owner.id }, uuid: newPublicId(), name, mountPath, hostPath: null });
      // LocalPersistentVolume::create(): the attributes it was given, the creating hook's uuid, the timestamps, the id.
      const now = laravelDate(new Date());
      return coolifyJson(obj({ name, mount_path: mountPath, resource_id: Number(owner.id), resource_type: owner.type, uuid: created.uuid, updated_at: now, created_at: now, id: Number(created.id) }), 201);
    }
    const invalid = ["name", "host_path"].filter((f) => keys.includes(f));
    if (invalid.length) return fieldsNotValid(invalid, "file");
    const isDirectory = requestBoolean(all, "is_directory");
    const isHostFile = requestBoolean(all, "is_host_file");
    if (isDirectory && isHostFile) return failedOn("is_host_file", "Host file mounts cannot also be directory mounts.");
    if (isDirectory) {
      if (phpFalsy(all.fs_path)) return failedOn("fs_path", "The fs_path field is required for directory mounts.");
      const fsPath = pathOr("fs_path", () => resolveHostPath(t.workdir, phpString(all.fs_path), "storage source path"));
      if (typeof fsPath !== "string") return fsPath;
      const mountPath = pathOr("fs_path", () => validateFileMountPath(phpString(all.mount_path), "storage destination path"));
      if (typeof mountPath !== "string") return mountPath;
      if (isOutsideResourceDirectory(fsPath, t.workdir)) {
        const forbidden = deployForbidden(c, OUTSIDE_REASON);
        if (forbidden) return forbidden;
      }
      // LocalFileVolume::assertHostPathOnServer(): a check on the server.
      return unavailable(STORAGE_MESSAGES.checkPathUnavailable);
    }
    if (isHostFile) {
      if (phpFalsy(all.fs_path)) return failedOn("fs_path", "The fs_path field is required for host file mounts.");
      if (filled(all.content)) return failedOn("content", "Content is not valid for host file mounts.");
      const fsPath = pathOr("mount_path", () => validateHostFileMountPath(phpString(all.fs_path), "host file source path"));
      if (typeof fsPath !== "string") return fsPath;
      const mountPath = pathOr("mount_path", () => validateFileMountPath(phpString(all.mount_path), "host file destination path"));
      if (typeof mountPath !== "string") return mountPath;
      // The unique index (mount_path, resource_id, resource_type).
      if ((await filesOf(rows, owner)).some((f) => rowValue(f, "mount_path") === mountPath)) return SERVER_ERROR;
      const created = await insertFileVolume(tx, { orgId: c.orgId, owner: { type: owner.type, id: owner.id }, uuid: newPublicId(), fsPath, mountPath, content: null, isDirectory: false, isHostFile: true });
      // LocalFileVolume::create(): its attributes (the content null), the uuid, the timestamps, the id, the appends, then the resource exposeFileStorageContentIfAllowed() loaded.
      const now = laravelDate(new Date());
      const entries: Array<[string, PhpValue]> = [["fs_path", fsPath], ["mount_path", mountPath]];
      if (c.canReadSensitive) entries.push(["content", null]);
      entries.push(["is_directory", false], ["is_host_file", true], ["resource_id", Number(owner.id)], ["resource_type", owner.type], ["uuid", created.uuid], ["updated_at", now], ["created_at", now], ["id", Number(created.id)], ["is_binary", false], ["is_too_large", false], ["resource", await resourceModel(tx, c, t, owner)]);
      return coolifyJson(obj(entries), 201);
    }
    // A managed file: Coolify writes it on the server (the created hook's job, or the path check of a source path first).
    const mountPath = pathOr("mount_path", () => validateFileMountPath(phpString(all.mount_path), "file storage path"));
    if (typeof mountPath !== "string") return mountPath;
    if (filled(all.fs_path)) {
      const fsPath = pathOr("fs_path", () => resolveHostPath(t.workdir, phpString(all.fs_path), "file storage source path"));
      if (typeof fsPath !== "string") return fsPath;
      if (isOutsideResourceDirectory(fsPath, t.workdir)) {
        const forbidden = deployForbidden(c, OUTSIDE_REASON);
        if (forbidden) return forbidden;
      }
      return unavailable(STORAGE_MESSAGES.checkPathUnavailable);
    }
    const confined = pathOr("mount_path", () => confineFileMountPath(t.workdir, mountPath, "file storage path"));
    if (typeof confined !== "string") return confined;
    if (filled(all.content)) {
      const forbidden = deployForbidden(c, CONTENT_REASON);
      if (forbidden) return forbidden;
    }
    return unavailable(STORAGE_MESSAGES.writeFileUnavailable);
  });
}

const UPDATE_RULES: Rules = [
  ["uuid", ["string"]],
  ["id", ["integer"]],
  ["type", ["required", "string", TYPE_RULE]],
  ["is_preview_suffix_enabled", ["boolean"]],
  ["name", ["string", VOLUME_NAME_RULE]],
  ["mount_path", ["string"]],
  ["content", ["string", "nullable"]],
];
const UPDATE_FIELDS = ["uuid", "id", "type", "is_preview_suffix_enabled", "name", "mount_path", "content"];

/** Laravel's boolean cast of what the request set. */
const castBoolean = (v: unknown): boolean => !phpFalsy(v);

async function updateStorage(c: ApiV1Context, kind: StorageKind, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    // $request->route('uuid'): the body's uuid is the storage's.
    const t = await findTarget(tx, rows, kind, uuid);
    if (!t) return message(NOT_FOUND[kind].update, 404);
    const no = await denied(c, true, UPDATE_DENIED[kind]);
    if (no) return no;
    const errors: Errors = [];
    await validateRules(errors, all, UPDATE_RULES);
    extraFields(errors, all, UPDATE_FIELDS);
    if (errors.length) return validationFailed(errors);
    const storageUuid = all.uuid;
    const storageId = all.id;
    if (phpFalsy(storageUuid) && phpFalsy(storageId)) return failedOn("uuid", "Either uuid or id is required.");
    const field = phpFalsy(storageUuid) ? "id" : "uuid";
    const value = phpString(storageUuid ?? storageId);
    const persistent = all.type === "persistent";
    // ->persistentStorages / ->fileStorages ->where($field, $value)->first(), part by part for a service.
    let found: { owner: Owner; row: ApiRow } | null = null;
    for (const o of t.owners) {
      const row = (persistent ? await volumesOf(rows, o) : await filesOf(rows, o)).find((r) => phpString(rowValue(r, field)) === value);
      if (row) {
        found = { owner: o, row };
        break;
      }
    }
    if (!found) return message("Storage not found.", 404);
    const { owner, row } = found;
    const keys = Object.keys(all);
    const isReadOnly = readOnly(t, owner, persistent ? null : row);
    const editable = ["name", "mount_path", "content"].filter((f) => keys.includes(f));
    if (isReadOnly && editable.length) return coolifyJson(obj({ message: "This storage is read-only (managed by docker-compose or service definition). Only is_preview_suffix_enabled can be updated.", read_only_fields: editable }), 422);
    if (!isReadOnly) {
      const invalid = (persistent ? ["content"] : ["name", "host_path"]).filter((f) => keys.includes(f));
      if (invalid.length) return fieldsNotValid(invalid, phpString(all.type));
    }
    const id = rowValue(row, "id") as number;
    const storageOwner = { type: owner.type, id: owner.id };
    if (persistent) {
      const changes: PersistentVolumeChanges = {};
      if ("is_preview_suffix_enabled" in all) changes.is_preview_suffix_enabled = castBoolean(all.is_preview_suffix_enabled);
      if (!isReadOnly) {
        if ("name" in all) changes.name = phpString(all.name);
        if ("mount_path" in all) changes.mount_path = storedMountPath(phpString(all.mount_path));
      }
      if (changed(row, changes)) await updatePersistentVolume(tx, storageOwner, id, changes);
      const fresh = (await rows("local_persistent_volumes", "t.id = $1", [id]))[0]!;
      return coolifyJson(volumeModel(fresh, [["resource", await resourceModel(tx, c, t, owner)]]));
    }
    // contentChangeForbiddenResponse(): a file's content that changes is written on the server at once.
    const current = await plainContent(tx, c, rowValue(row, "content"));
    const contentChanges = !isReadOnly && rowValue(row, "is_directory") !== true && rowValue(row, "is_host_file") !== true && "content" in all && phpString(all.content) !== phpString(current);
    if (contentChanges) {
      const forbidden = deployForbidden(c, CONTENT_REASON);
      if (forbidden) return forbidden;
    }
    const changes: FileVolumeChanges = {};
    if ("is_preview_suffix_enabled" in all) changes.is_preview_suffix_enabled = castBoolean(all.is_preview_suffix_enabled);
    if (!isReadOnly && "mount_path" in all) changes.mount_path = all.mount_path === null ? null : phpString(all.mount_path);
    // $storage->content = …: the encrypted cast compares the decrypted values. A new content is ServerStorageSaveJob's to
    // write on the server, which saveStorageOnServer() skips for a host file only.
    if (!isReadOnly && "content" in all && (all.content ?? null) !== current) {
      if (rowValue(row, "is_host_file") !== true) return unavailable(STORAGE_MESSAGES.writeFileUnavailable);
      changes.content = all.content === null ? null : await columnCipher(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, CONTENT_COLUMN).encrypt(phpString(all.content));
    }
    if (changed(row, changes)) await updateFileVolume(tx, storageOwner, id, changes);
    const fresh = (await rows("local_file_volumes", "t.id = $1", [id]))[0]!;
    // isReadOnlyVolume() loaded `service` (the same model; a service's part with its service), exposeFileStorageContentIfAllowed() `resource`.
    return coolifyJson(await fileModel(tx, c, fresh, [["service", await resourceModel(tx, c, t, owner, t.kind === "service")], ["resource", await resourceModel(tx, c, t, owner)]]));
  });
}

/** isDirty(): whether a change differs from the row (Eloquent saves nothing clean, so updated_at stays). */
function changed(row: ApiRow, changes: Record<string, unknown>): boolean {
  return Object.entries(changes).some(([k, v]) => v !== undefined && rowValue(row, k) !== v);
}

async function deleteStorage(c: ApiV1Context, kind: StorageKind, uuid: string, storageUuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const t = await findTarget(tx, rows, kind, param(c, {}, uuid));
    if (!t) return message(NOT_FOUND[kind].delete, 404);
    const no = await denied(c, true);
    if (no) return no;
    // The volumes (part by part), then the files.
    let found: { owner: Owner; row: ApiRow; file: boolean } | null = null;
    for (const file of [false, true]) {
      for (const o of t.owners) {
        const row = (file ? await filesOf(rows, o) : await volumesOf(rows, o)).find((r) => rowValue(r, "uuid") === storageUuid);
        if (row) {
          found = { owner: o, row, file };
          break;
        }
      }
      if (found) break;
    }
    if (!found) return message("Storage not found.", 404);
    const { owner, row, file } = found;
    if (readOnly(t, owner, file ? row : null)) return message("This storage is read-only (managed by docker-compose or service definition) and cannot be deleted.", 422);
    if (kind === "database" && !file && rowValue(row, "standalone_sqlite_id") !== null) return message("This volume is mounted by an application. Unlink it on the SQLite database page first.", 422);
    const id = rowValue(row, "id") as number;
    const backups = await tx.execute("SELECT 1 FROM deploy.scheduled_volume_backups WHERE backupable_type = $1 AND backupable_id = $2 LIMIT 1", [file ? FILE_VOLUME_MORPH_CLASS : PERSISTENT_VOLUME_MORPH_CLASS, id]);
    if (backups.rows.length) return aborted(file ? "Delete this directory backup schedule and its archives before deleting the directory." : "Delete this volume backup schedule and its archives before deleting the volume.");
    const storageOwner = { type: owner.type, id: owner.id };
    if (file) {
      // deleteStorageOnServer(): a host file and a path outside the resource directory are never deleted on the server.
      if (rowValue(row, "is_host_file") !== true && !isOutsideResourceDirectory(String(rowValue(row, "fs_path")), t.workdir)) return unavailable(STORAGE_MESSAGES.deleteFromServerUnavailable);
      await deleteFileVolume(tx, storageOwner, id);
    } else {
      await deletePersistentVolume(tx, storageOwner, id);
    }
    return message("Storage deleted.", 200);
  });
}

