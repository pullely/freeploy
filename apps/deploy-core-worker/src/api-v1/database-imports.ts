// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/Concerns/HandlesDatabaseImportsApi.php
// (uploadDatabaseImport, startDatabaseImport, showDatabaseImport), app/Http/Controllers/Api/DatabasesController.php
// (upload_import, create_import, show_import), app/Http/Controllers/Api/ServiceDatabasesController.php (upload_import,
// create_import, show_import, withImportDatabase, resolveService, resolveServiceDatabase),
// app/Actions/Database/StartDatabaseImport.php (handle, startImport, allowsSourcePath, assertServerPath, assertS3Path),
// app/Support/DatabaseImport/DatabaseImportCommandBuilder.php (supports, databaseType), app/Models/ServiceDatabase.php
// (databaseType) and app/Support/DatabaseBackupFileValidator.php (hasAllowedExtension, extensionFor) (Apache-2.0), modified.
//
// Coolify's /api/v1 for importing a backup into a standalone database or a service's database (DP-88). Every check
// Coolify makes before the backup reaches the server is ported: the policies, the validators with Laravel's messages,
// the deploy permission, StartDatabaseImport's refusals (an unsupported engine, a database that is not running, a Swarm
// destination, the server, the upload Coolify staged — Freeploy stages none, so none is found —, the server path and the
// S3 storage, path and key, the team's own backup folders). Then Coolify copies the file to the server and restores it
// there (instant_scp(), stat over SSH, the S3 helper container): 501 in Coolify's envelope. An upload is received by
// Coolify's own instance and then sent to the server: 501 after its checks. No import ever starts, so no import's
// activity exists: an import's status is Coolify's 404.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import type { ApiRow } from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, obj, type CoolifyAnswer, type PhpValue } from "@saas/contracts/coolify-api";
import { needsExecutor } from "../applications/resources.js";
import { validS3BucketName } from "../s3-storages/validation.js";
import { findApiDatabase } from "./databases.js";
import { hasDeployAbility, message, rowsOf, unavailable, type ApiV1Context } from "./context.js";
import { rowValue } from "./models.js";
import { addError, cleanInput, readApiBody, type Errors } from "./request.js";

export const DATABASE_IMPORTS_API_MESSAGES = {
  /** Freeploy's: the upload is sent to the server (instant_scp()) when the import starts. */
  uploadUnavailable: needsExecutor("Sending the backup to the server"),
  /** Freeploy's: startImport() copies the backup into the container and restores it there. */
  importUnavailable: needsExecutor("Importing the backup on the server"),
  deployNeeded: "Missing required permissions: deploy. An import runs the dump in the database container, so it needs a token with the deploy permission.",
  ownBackupsOnly: "You can import only backups of this database. Importing other files needs write access on the whole team.",
} as const;

/** StartDatabaseImport::MAX_BYTES: 10 GiB. */
const MAX_BYTES = 10 * 1024 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ["sql", "sql.gz", "gz", "zip", "tar", "tar.gz", "tgz", "dump", "bak", "bson", "bson.gz", "archive", "archive.gz", "bz2", "xz", "dmp", "db", "db.gz", "sqlite", "sqlite.gz", "sqlite3", "sqlite3.gz"];
const DANGEROUS_EXTENSIONS = ["asp", "aspx", "bat", "bash", "cgi", "cmd", "com", "exe", "htm", "html", "jar", "js", "jsp", "php", "php3", "php4", "php5", "phtml", "pl", "ps1", "py", "rb", "sh"];
const UUID = /^[\da-fA-F]{8}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{12}$/;
const SWARM_DOCKER = "App\\Models\\SwarmDocker";
/** backup_dir() */
const BACKUP_DIR = "/data/coolify/backups";

const denied = async (c: ApiV1Context, write: boolean): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized());
const filled = (v: unknown): boolean => !(v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0));
const quote = (s: string): string => s.replace(/[.*+?^${}()|[\]\\#]/g, "\\$&");

/** DatabaseBackupFileValidator::extensionFor() !== null */
export function hasAllowedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  const suffixes = ALLOWED_EXTENSIONS.map((e) => `.${e}`).sort((a, b) => b.length - a.length);
  for (const suffix of suffixes) {
    if (!lower.endsWith(suffix)) continue;
    const stem = lower.slice(0, -suffix.length);
    if (stem === "" || stem.endsWith(".")) return false;
    return !stem.split(".").filter(Boolean).some((p) => DANGEROUS_EXTENSIONS.includes(p));
  }
  return false;
}

/** The database an import goes into, with what StartDatabaseImport reads of it. */
interface ImportTarget {
  kind: "standalone" | "service";
  row: ApiRow;
  /** DatabaseImportCommandBuilder::databaseType() */
  type: string;
  status: string;
  swarmDestination: boolean;
  serverId: unknown;
  /** The folder suffix of its backups (allowsSourcePath()). */
  directorySuffix: string;
}

function databaseTypeOf(text: string): string {
  const t = text.toLowerCase();
  if (t.includes("postgres")) return "postgresql";
  if (t.includes("mariadb")) return "mariadb";
  if (t.includes("mysql")) return "mysql";
  if (t.includes("mongo")) return "mongodb";
  if (t.includes("sqlite")) return "sqlite";
  return "unsupported";
}

/** ServiceDatabase::databaseType(): the custom type, else the image's name (Supabase, Timescale and pgvector as PostgreSQL). */
function serviceDatabaseType(row: ApiRow): string {
  const custom = rowValue(row, "custom_type");
  if (filled(custom)) return `standalone-${String(custom)}`;
  const image = String(rowValue(row, "image") ?? "").split(":")[0]!;
  const name = image.includes("supabase/postgres") ? "supabase/postgres" : image.includes("timescale") || image.includes("pgvector") || image.includes("postgres") || image.includes("postgis") ? "postgresql" : image;
  return `standalone-${name}`;
}

/** queryDatabaseByUuidWithinTeam(), or the service's database (withImportDatabase()). Null for Coolify's 404. */
async function findTarget(tx: SqlExecutor, kind: "standalone" | "service", uuid: string, databaseUuid: string | undefined): Promise<ImportTarget | null> {
  const rows = rowsOf(tx);
  if (kind === "standalone") {
    const found = await findApiDatabase(tx, uuid);
    if (!found) return null;
    const swarm = rowValue(found.row, "destination_type") === SWARM_DOCKER;
    const destination = (await rows(swarm ? "swarm_dockers" : "standalone_dockers", "t.id = $1", [rowValue(found.row, "destination_id")]))[0];
    return { kind, row: found.row, type: databaseTypeOf(found.engine === "postgresql" ? "standalonepostgresql" : `standalone${found.engine}`), status: String(rowValue(found.row, "status") ?? ""), swarmDestination: swarm, serverId: destination ? rowValue(destination, "server_id") : null, directorySuffix: String(rowValue(found.row, "uuid")) };
  }
  const service = (await rows("services", "t.deleted_at IS NULL AND t.uuid = $1", [uuid]))[0];
  if (!service) return null;
  const database = (await rows("service_databases", "t.deleted_at IS NULL AND t.service_id = $1 AND t.uuid = $2", [rowValue(service, "id"), databaseUuid ?? ""]))[0];
  if (!database) return null;
  return {
    kind,
    row: database,
    type: databaseTypeOf(serviceDatabaseType(database)),
    status: String(rowValue(database, "status") ?? ""),
    swarmDestination: rowValue(service, "destination_type") === SWARM_DOCKER,
    serverId: rowValue(service, "server_id"),
    directorySuffix: `${String(rowValue(database, "name"))}-${String(rowValue(service, "uuid"))}`,
  };
}

const notFoundOf = (kind: "standalone" | "service") => message(kind === "standalone" ? "Database not found." : "Service database not found.", 404);

/**
 * routes/api.php's /databases/{uuid}/imports… and /services/{uuid}/databases/{database_uuid}/imports… routes.
 * segments: what follows /imports.
 */
export async function databaseImportsApi(c: ApiV1Context, kind: "standalone" | "service", uuid: string, databaseUuid: string | undefined, segments: string[]): Promise<CoolifyAnswer | null> {
  const [sub, extra] = segments;
  if (extra !== undefined) return null;
  const m = c.method;
  if (sub === undefined) return m === "POST" ? startImport(c, kind, uuid, databaseUuid) : null;
  if (sub === "uploads") return m === "POST" ? upload(c, kind, uuid, databaseUuid) : null;
  // ->whereNumber('activity_id')
  return m === "GET" && /^\d+$/.test(sub) ? showImport(c, kind, uuid, databaseUuid) : null;
}

/** $request->all() of a JSON, form or multipart body (a file stays a File). */
async function requestAll(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  if (/^multipart\/form-data/i.test(type)) {
    const out: Record<string, unknown> = {};
    (await request.formData()).forEach((v, k) => (out[k] = typeof v === "string" ? cleanInput(v, k) : v));
    return out;
  }
  return (await readApiBody(request)).all;
}

const isFile = (v: unknown): v is File => typeof File !== "undefined" && v instanceof File;
const laravelFailed = (errors: Errors): CoolifyAnswer => coolifyJson(obj({ message: "Validation failed.", errors: obj(errors.map(([k, v]): [string, PhpValue] => [k, v])) }), 422);
const fileError = (text: string): CoolifyAnswer => coolifyJson(obj({ message: "Validation failed.", errors: obj({ file: [text] }) }), 422);

/** uploadDatabaseImport(): the uploadBackup policy, the upload's rules, its name and size; then it would be staged and sent to the server (501). */
async function upload(c: ApiV1Context, kind: "standalone" | "service", uuid: string, databaseUuid: string | undefined): Promise<CoolifyAnswer> {
  const all = await requestAll(c.request);
  return c.sql(c.env, c.orgId, async (tx) => {
    const target = await findTarget(tx, kind, uuid, databaseUuid);
    if (!target) return notFoundOf(kind);
    const no = await denied(c, true);
    if (no) return no;
    const errors: Errors = [];
    const id = all.upload_id;
    if (!filled(id)) addError(errors, "upload_id", "The upload id field is required.");
    else if (!(typeof id === "string" && UUID.test(id))) addError(errors, "upload_id", "The upload id field must be a valid UUID.");
    if (!filled(all.file) && !isFile(all.file)) addError(errors, "file", "The file field is required.");
    else if (!isFile(all.file)) addError(errors, "file", "The file field must be a file.");
    if (errors.length) return laravelFailed(errors);
    const file = all.file as File;
    if (!file.name || !hasAllowedExtension(file.name)) return fileError("Unsupported backup file extension.");
    if (Number.parseInt(String(all.dzTotalFilesize ?? "0"), 10) > MAX_BYTES) return fileError("The backup exceeds the 10 GiB limit.");
    return unavailable(DATABASE_IMPORTS_API_MESSAGES.uploadUnavailable);
  });
}

/** Laravel's validator of startDatabaseImport()'s rules, with Laravel's own messages (Validator::make()). */
function validateImport(payload: Record<string, unknown>): Errors {
  const errors: Errors = [];
  const source = payload.source;
  const sourceIs = (...values: string[]) => source !== null && source !== undefined && typeof source !== "object" && values.includes(String(source));
  const has = (k: string) => k in payload;
  const isString = (v: unknown) => typeof v === "string";
  // source: required, Rule::in
  if (!filled(source)) addError(errors, "source", "The source field is required.");
  else if (!sourceIs("upload", "s3", "server")) addError(errors, "source", "The selected source is invalid.");
  // upload_id: required_if:source,upload, prohibited_unless:source,upload, uuid
  if (sourceIs("upload") && !filled(payload.upload_id)) addError(errors, "upload_id", "The upload id field is required when source is upload.");
  else {
    if (!sourceIs("upload") && filled(payload.upload_id)) addError(errors, "upload_id", "The upload id field is prohibited unless source is in upload.");
    if (has("upload_id") && filled(payload.upload_id) && !(isString(payload.upload_id) && UUID.test(payload.upload_id as string))) addError(errors, "upload_id", "The upload id field must be a valid UUID.");
  }
  // s3_storage_uuid: required_if:source,s3, prohibited_unless:source,s3, string
  if (sourceIs("s3") && !filled(payload.s3_storage_uuid)) addError(errors, "s3_storage_uuid", "The s3 storage uuid field is required when source is s3.");
  else {
    if (!sourceIs("s3") && filled(payload.s3_storage_uuid)) addError(errors, "s3_storage_uuid", "The s3 storage uuid field is prohibited unless source is in s3.");
    if (filled(payload.s3_storage_uuid) && !isString(payload.s3_storage_uuid)) addError(errors, "s3_storage_uuid", "The s3 storage uuid field must be a string.");
  }
  // path: required_if:source,s3,server, prohibited_if:source,upload, string, max:4096
  if (sourceIs("s3", "server") && !filled(payload.path)) addError(errors, "path", `The path field is required when source is ${String(source)}.`);
  else {
    if (sourceIs("upload") && filled(payload.path)) addError(errors, "path", "The path field is prohibited when source is upload.");
    if (filled(payload.path) && !isString(payload.path)) addError(errors, "path", "The path field must be a string.");
    else if (isString(payload.path) && [...(payload.path as string)].length > 4096) addError(errors, "path", "The path field must not be greater than 4096 characters.");
  }
  // sometimes|boolean
  for (const k of ["dump_all", "replace_existing", "keep_owners", "restore_mysql_users"]) {
    if (has(k) && payload[k] !== null && ![true, false, 0, 1, "0", "1"].includes(payload[k] as never)) addError(errors, k, `The ${k.replace(/_/g, " ")} field must be true or false.`);
  }
  // sqlite_database: sometimes|string|max:255
  if (has("sqlite_database") && payload.sqlite_database !== null) {
    if (!isString(payload.sqlite_database)) addError(errors, "sqlite_database", "The sqlite database field must be a string.");
    else if ([...(payload.sqlite_database as string)].length > 255) addError(errors, "sqlite_database", "The sqlite database field must not be greater than 255 characters.");
  }
  const allowed = ["source", "upload_id", "s3_storage_uuid", "path", "dump_all", "replace_existing", "keep_owners", "restore_mysql_users", "sqlite_database"];
  for (const k of Object.keys(payload)) if (!allowed.includes(k)) addError(errors, k, "This field is not allowed.");
  return errors;
}

/** startDatabaseImport() and StartDatabaseImport's checks before the backup reaches the server. */
async function startImport(c: ApiV1Context, kind: "standalone" | "service", uuid: string, databaseUuid: string | undefined): Promise<CoolifyAnswer> {
  // $request->json()->all() ?: $request->request->all(): the JSON body, else the form body.
  const payload = await requestAll(c.request);
  return c.sql(c.env, c.orgId, async (tx) => {
    const target = await findTarget(tx, kind, uuid, databaseUuid);
    if (!target) return notFoundOf(kind);
    const no = await denied(c, true);
    if (no) return no;
    const errors = validateImport(payload);
    if (errors.length) return laravelFailed(errors);
    if (!hasDeployAbility(c)) return message(DATABASE_IMPORTS_API_MESSAGES.deployNeeded, 403);
    const refuse = (text: string, status = 422) => message(text, status);
    if (!["postgresql", "mysql", "mariadb", "mongodb", "sqlite"].includes(target.type)) return refuse("Database imports are not supported for this database type.");
    if (!target.status.startsWith("running")) return refuse("The database must be running before an import can start.");
    if (target.swarmDestination) return refuse("Database imports are not supported for Swarm servers yet.", 501);
    if (target.serverId === null || target.serverId === undefined) return refuse("The database server or container is invalid.", 400);
    const source = String(payload.source);
    const path = payload.path === undefined || payload.path === null ? null : String(payload.path);
    /** allowsSourcePath(): useTeamCredentials, else one of this database's own backup folders. */
    const allowsSourcePath = async (p: string): Promise<boolean> => {
      if (await c.allows(true)) return true;
      const pattern = new RegExp(`^${quote(`${BACKUP_DIR}/databases/`)}[^/]*-${quote(c.orgPublicId)}/[^/]*-${quote(target.directorySuffix)}/[^/]+$`);
      return pattern.test(`/${p.replace(/^\/+/, "")}`);
    };
    if (source === "upload") return refuse("The completed upload was not found.");
    if (source === "server") {
      if (!path || !path.startsWith("/") || /\.\.|[$()`|;&><\r\n\0'"\\]/.test(path)) return refuse("The server path is invalid.");
      if (!(await allowsSourcePath(path))) return refuse(DATABASE_IMPORTS_API_MESSAGES.ownBackupsOnly, 403);
      return unavailable(DATABASE_IMPORTS_API_MESSAGES.importUnavailable);
    }
    // S3Storage::ownedByCurrentTeamAPI(): by uuid, or by id when the value is digits; usable; an S3 bucket name that is valid.
    const wanted = String(payload.s3_storage_uuid);
    const r = await tx.execute<{ bucket: string; type: string | null }>(
      "SELECT bucket, type FROM deploy.s3_storages WHERE is_usable = true AND (uuid = $1 OR id = $2) ORDER BY id LIMIT 1",
      [wanted, /^\d+$/.test(wanted) ? Number(wanted) : -1],
    );
    const storage = r.rows[0];
    if (!storage || ((storage.type ?? "s3") === "s3" && !validS3BucketName(storage.bucket))) return refuse("S3 storage was not found or has an invalid bucket.");
    const key = (path ?? "").replace(/^\/+/, "");
    if (key === "" || /\.\.|[$()`|;&><\r\n\0'"\\]/.test(key) || !hasAllowedExtension(key.split("/").pop()!)) return refuse("The S3 path is invalid.");
    if (!(await allowsSourcePath(key))) return refuse(DATABASE_IMPORTS_API_MESSAGES.ownBackupsOnly, 403);
    return unavailable(DATABASE_IMPORTS_API_MESSAGES.importUnavailable);
  });
}

/** showDatabaseImport(): the view policy, then the import's activity — none exists, as no import starts. */
async function showImport(c: ApiV1Context, kind: "standalone" | "service", uuid: string, databaseUuid: string | undefined): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const target = await findTarget(tx, kind, uuid, databaseUuid);
    if (!target) return notFoundOf(kind);
    const no = await denied(c, false);
    if (no) return no;
    return message("Database import not found.", 404);
  });
}
