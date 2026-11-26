// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/S3StoragesController.php (removeSensitiveData,
// connectionFields, connectionRules, validateStorageConnection, validateBody, index, show, store, update, destroy,
// validateStorage), app/Models/S3Storage.php (connectionRules, the endpoint, bucket and region mutators, the saving and
// deleting hooks, detectPathStyleEndpoint, testConnection), app/Enums/BackupStorageType.php,
// app/Rules/{SafeWebhookUrl,ValidS3BucketName}.php and app/Support/ValidationPatterns.php (nameRules,
// descriptionRules) (Apache-2.0), modified.
//
// Coolify's /api/v1 for S3 storages (DP-81), on the storage store the Storage pages use (DP-65: packages/db's
// deploy/s3-storages.ts, the deleting hook that lets the backup schedules go) and DP-65's connection test (SafeWebhookUrl,
// the bucket name, ListObjectsV2 signed with SigV4 through the context's resolver and fetch). The key and the secret are
// the `encrypted` casts' columns. Only S3-compatible storages are ported: an SFTP, FTPS or WebDAV storage answers 501 in
// Coolify's envelope before anything is stored (the console's STORAGE_TOASTS.typeUnavailable).
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { deleteS3Storage, insertS3Storage, updateS3StorageColumns, type ApiRow, type S3StorageColumnChanges } from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, obj, serializeApiResponse, type CoolifyAnswer, type PhpObject } from "@saas/contracts/coolify-api";
import { columnCipher } from "../handlers/cloud-tokens.js";
import { newPublicId } from "../helpers/names.js";
import { DESCRIPTION_PATTERN, NAME_PATTERN } from "../private-keys/validation.js";
import { S3ConnectionError, detectPathStyleEndpoint, testS3Connection } from "../s3-storages/connection.js";
import { parseUrl, safeUrlError } from "../s3-storages/safe-url.js";
import { STORAGE_TOASTS, typeLabel } from "../s3-storages/service.js";
import { BUCKET_NAME_MESSAGE, STORAGE_TYPES, validS3BucketName } from "../s3-storages/validation.js";
import { stripTags } from "../applications/tags.js";
import { decryptColumn, message, rowsOf, unavailable, type ApiV1Context, type Rows } from "./context.js";
import { rowValue, toModel, type ModelShape } from "./models.js";
import { addError, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rule, type Rules } from "./rules.js";

/** $hidden (key, secret) with removeSensitiveData()'s makeHidden(['id', 'private_key_id', 'privateKey']). */
const S3_STORAGE: ModelShape = { hidden: ["id", "private_key_id", "key", "secret"], dates: ["created_at", "updated_at"] };
/** connectionFields(S3) */
const S3_FIELDS = ["endpoint", "bucket", "region", "key", "secret", "use_path_style_endpoint", "skip_tls_verification"];

const denied = async (c: ApiV1Context, write: boolean, policyMessage?: string): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized(policyMessage));
const notFound = () => message("S3 storage not found.", 404);
const inOrg = <T>(c: ApiV1Context, fn: (tx: SqlExecutor) => Promise<T>): Promise<T> => c.sql(c.env, c.orgId, fn);
const encrypt = (tx: SqlExecutor, c: ApiV1Context, column: "key" | "secret", value: string): Promise<string> => columnCipher(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, `s3_storages.${column}`).encrypt(value);
const decrypt = (tx: SqlExecutor, c: ApiV1Context, row: ApiRow, column: "key" | "secret"): Promise<string | null> => decryptColumn(tx, c, "s3_storages", column, rowValue(row, column));

/** PHP's trim() */
const phpTrim = (v: string): string => v.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "");
/** The endpoint, bucket and region mutators: trimmed, null when empty. */
const trimmedOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" && v !== "0" ? phpTrim(v) : null);
/** A boolean cast of a request value (Eloquent's `boolean` cast, PHP's truthiness). */
const castBool = (v: unknown): boolean => !(v === undefined || v === null || v === false || v === 0 || v === "" || v === "0");

/** routes/api.php's /s3-storages routes; null for every other path (the caller answers the fallback 404). */
export async function s3StoragesApi(c: ApiV1Context, segments: string[]): Promise<CoolifyAnswer | null> {
  const [uuid, sub, extra] = segments;
  const m = c.method;
  if (extra !== undefined) return null;
  if (uuid === undefined) return m === "GET" ? listStorages(c) : m === "POST" ? createStorage(c) : null;
  if (sub === undefined) return m === "GET" ? showStorage(c, uuid) : m === "PATCH" ? updateStorage(c, uuid) : m === "DELETE" ? deleteStorage(c, uuid) : null;
  return sub === "validate" && m === "POST" ? validateStorage(c, uuid) : null;
}

/** S3Storage::ownedByCurrentTeamAPI()->whereUuid(): the org's storage (row-level security confines it to the org). */
async function storageRow(rows: Rows, uuid: string): Promise<ApiRow | null> {
  return (await rows("s3_storages", "t.uuid = $1", [uuid]))[0] ?? null;
}

/** removeSensitiveData(): the key and secret only for a token that may read secrets, then serializeApiResponse(). */
async function serialize(tx: SqlExecutor, c: ApiV1Context, row: ApiRow): Promise<PhpObject> {
  let shown = row;
  if (c.canReadSensitive) {
    const key = await decrypt(tx, c, row, "key");
    const secret = await decrypt(tx, c, row, "secret");
    shown = row.map(([k, v]): [string, unknown] => [k, k === "key" ? key : k === "secret" ? secret : v]);
  }
  return serializeApiResponse(toModel(shown, S3_STORAGE, { teamId: c.orgPublicId, visible: c.canReadSensitive ? ["key", "secret"] : [] }));
}

async function listStorages(c: ApiV1Context): Promise<CoolifyAnswer> {
  return inOrg(c, async (tx) => {
    const out: PhpObject[] = [];
    // ownedByCurrentTeamAPI() orders by name.
    for (const row of await rowsOf(tx)("s3_storages", undefined, undefined, "name")) out.push(await serialize(tx, c, row));
    return coolifyJson(out);
  });
}

async function showStorage(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return inOrg(c, async (tx) => {
    const row = await storageRow(rowsOf(tx), uuid);
    if (!row) return notFound();
    const no = await denied(c, false);
    return no ?? coolifyJson(await serialize(tx, c, row));
  });
}

// ── validation ──────────────────────────────────────────────────────────────

/** connectionRules(S3)['endpoint']'s closure: no credentials in the URL (unless they are saved already), no control characters in its path. */
function endpointClosure(savedEndpoint: string | null): Rule {
  return {
    closure: (value) => {
      const out: string[] = [];
      const parts = typeof value === "string" ? (parseUrl(phpTrim(value)) ?? {}) : {};
      const asString = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
      if ((parts.user !== undefined || parts.pass !== undefined) && phpTrim(asString) !== phpTrim(savedEndpoint ?? "")) out.push("The endpoint must not contain a username or password. Enter the credentials in their own fields.");
      let path = parts.path ?? "";
      try {
        path = decodeURIComponent(path.replace(/%(?![0-9A-Fa-f]{2})/g, "%25"));
      } catch {
        /* rawurldecode() leaves what it cannot decode */
      }
      if (/[\x00-\x1f\x7f]/.test(path)) out.push("The endpoint path must not contain control characters.");
      return out;
    },
  };
}

/** The store's and update's rules (in the controller's order), connectionRules(S3) in the middle. */
function storageRules(c: ApiV1Context, partial: boolean, savedEndpoint: string | null): Rules {
  const required: Rule[] = partial ? [] : ["required"];
  const name: Rule[] = partial ? ["nullable"] : ["required"];
  return [
    ...(partial ? [] : ([["type", [{ closure: (v: unknown) => (STORAGE_TYPES.includes(v as never) ? [] : ["The selected type is invalid."]) }]]] as Rules)),
    ["name", [...name, "string", "min:3", "max:255", { regex: NAME_PATTERN }]],
    ["description", ["nullable", "string", "max:255", { regex: DESCRIPTION_PATTERN }]],
    ["endpoint", [...required, "string", "max:255", endpointClosure(savedEndpoint), { closure: async (v: unknown) => [(await safeUrlError(v, "endpoint", "endpoint", c.s3.resolve)) ?? ""].filter(Boolean) }]],
    ["bucket", [...required, { closure: (v: unknown) => (validS3BucketName(v) ? [] : [BUCKET_NAME_MESSAGE("bucket")]) }]],
    ["region", [...required, "string", "max:255"]],
    ["key", [...required, "string", "max:255"]],
    ["secret", [...required, "string", "max:255"]],
    ["use_path_style_endpoint", ["boolean"]],
    ["skip_tls_verification", ["boolean"]],
    ["is_usable", ["boolean"]],
  ];
}

/** validateBody(): customApiValidator()'s rules, then every field that is not allowed. */
async function validateBody(all: Record<string, unknown>, allowed: readonly string[], rules: Rules): Promise<CoolifyAnswer | null> {
  const errors: Errors = [];
  await validateRules(errors, all, rules);
  for (const k of Object.keys(all)) if (!allowed.includes(k)) addError(errors, k, "This field is not allowed.");
  return errors.length ? validationFailed(errors) : null;
}

// ── writing ─────────────────────────────────────────────────────────────────

async function createStorage(c: ApiV1Context): Promise<CoolifyAnswer> {
  const no = await denied(c, true);
  if (no) return no;
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  const rawType = all.type ?? "s3";
  // Freeploy's: only S3-compatible storages are ported (SFTP, FTPS and WebDAV storages back up through rclone).
  if (typeof rawType === "string" && rawType !== "s3" && (STORAGE_TYPES as readonly string[]).includes(rawType)) return unavailable(STORAGE_TOASTS.typeUnavailable(typeLabel(rawType)));
  const invalid = await validateBody(all, ["type", "name", "description", "is_usable", ...S3_FIELDS], storageRules(c, false, null));
  if (invalid) return invalid;
  return inOrg(c, async (tx) => {
    const endpoint = trimmedOrNull(all.endpoint);
    const created = await insertS3Storage(tx, {
      orgId: c.orgId,
      uuid: newPublicId(),
      type: "s3",
      // HasSafeStringAttribute: strip_tags() on the name and the description.
      name: stripTags(String(all.name)),
      description: typeof all.description === "string" ? stripTags(all.description) : null,
      endpoint: endpoint as string,
      bucket: trimmedOrNull(all.bucket) as string,
      region: trimmedOrNull(all.region) as string,
      // The saving hook: the key and secret trimmed.
      key: await encrypt(tx, c, "key", phpTrim(String(all.key))),
      secret: await encrypt(tx, c, "secret", phpTrim(typeof all.secret === "string" ? all.secret : "")),
      usePathStyleEndpoint: all.use_path_style_endpoint === undefined || all.use_path_style_endpoint === null ? detectPathStyleEndpoint(endpoint) : castBool(all.use_path_style_endpoint),
      skipTlsVerification: castBool(all.skip_tls_verification),
      isUsable: castBool(all.is_usable),
      unusableEmailSent: false,
    });
    return coolifyJson(obj({ uuid: created.uuid }), 201);
  });
}

async function updateStorage(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  return inOrg(c, async (tx) => {
    const row = await storageRow(rowsOf(tx), uuid);
    if (!row) return notFound();
    const no = await denied(c, true);
    if (no) return no;
    if (rowValue(row, "type") !== "s3") return unavailable(STORAGE_TOASTS.typeUnavailable(typeLabel(String(rowValue(row, "type")))));
    const allowed = ["name", "description", "is_usable", ...S3_FIELDS];
    const invalid = await validateBody(all, allowed, storageRules(c, true, (rowValue(row, "endpoint") as string | null) ?? null));
    if (invalid) return invalid;
    // $storage->update(array_intersect_key($body, $allowedFields)): the mutators, the saving hook, the casts.
    const changes: S3StorageColumnChanges = {};
    if ("name" in all) changes.name = stripTags(all.name === null ? "" : String(all.name));
    if ("description" in all) changes.description = typeof all.description === "string" ? stripTags(all.description) : null;
    for (const column of ["endpoint", "bucket", "region"] as const) if (column in all) changes[column] = trimmedOrNull(all[column]);
    if ("key" in all) changes.key = await encrypt(tx, c, "key", phpTrim(String(all.key)));
    if ("secret" in all) changes.secret = await encrypt(tx, c, "secret", phpTrim(typeof all.secret === "string" ? all.secret : ""));
    for (const column of ["use_path_style_endpoint", "skip_tls_verification", "is_usable"] as const) if (column in all) changes[column] = castBool(all[column]);
    await updateS3StorageColumns(tx, rowValue(row, "id") as string | number, changes);
    return coolifyJson(obj({ uuid }));
  });
}

async function deleteStorage(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return inOrg(c, async (tx) => {
    const row = await storageRow(rowsOf(tx), uuid);
    if (!row) return notFound();
    const no = await denied(c, true);
    if (no) return no;
    // The deleting hook (detachFromBackups()): every schedule lets the storage go first; S3 turns off where none remains.
    await deleteS3Storage(tx, rowValue(row, "id") as string | number, c.orgId);
    return message("S3 storage deleted.", 200);
  });
}

/**
 * validateStorage(): testConnection(shouldSave: true) — the endpoint and the bucket, then ListObjectsV2 (and the
 * virtual-hosted style when the provider rejects a path-style URL) — and the storage's status saved. The listing runs
 * inside the request's transaction, as Coolify's runs inside its request.
 */
async function validateStorage(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return inOrg(c, async (tx) => {
    const row = await storageRow(rowsOf(tx), uuid);
    if (!row) return notFound();
    const no = await denied(c, true);
    if (no) return no;
    if (rowValue(row, "type") !== "s3") return unavailable(STORAGE_TOASTS.typeUnavailable(typeLabel(String(rowValue(row, "type")))));
    const usePathStyle = rowValue(row, "use_path_style_endpoint") === true;
    const conn = {
      endpoint: (rowValue(row, "endpoint") as string | null) ?? null,
      bucket: (rowValue(row, "bucket") as string | null) ?? null,
      region: (rowValue(row, "region") as string | null) ?? null,
      key: (await decrypt(tx, c, row, "key")) ?? "",
      secret: (await decrypt(tx, c, row, "secret")) ?? "",
      usePathStyleEndpoint: usePathStyle,
    };
    const id = rowValue(row, "id") as string | number;
    // $this->save() in testConnection()'s finally: only what changed is written.
    const save = async (changes: S3StorageColumnChanges) => {
      const dirty = Object.fromEntries(Object.entries(changes).filter(([k, v]) => rowValue(row, k) !== v)) as S3StorageColumnChanges;
      await updateS3StorageColumns(tx, id, dirty);
    };
    try {
      const tested = await testS3Connection(conn, c.s3.resolve, c.s3);
      await save({ use_path_style_endpoint: tested.usePathStyleEndpoint, unusable_email_sent: false, is_usable: true });
      return coolifyJson(obj({ valid: true, message: "S3 storage connection is valid." }));
    } catch (e) {
      if (!(e instanceof S3ConnectionError)) throw e;
      // No transactional email is sent (Freeploy's notifications have no storage alert), so unusable_email_sent stays.
      await save({ is_usable: false });
      return coolifyJson(obj({ valid: false, message: e.message }));
    }
  });
}
