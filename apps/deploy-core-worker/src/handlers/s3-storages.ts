// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Storage/{Index,Create,Form,Show,Resources}.php
// and app/Policies/S3StoragePolicy.php (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/storages — Integrations → Storage (S3).
//
//   GET    /storages                                   Index: the org's storages by name
//   POST   /storages                                   Create::submit { type, name, description, endpoint, bucket, region,
//                                                      key, secret, usePathStyleEndpoint, skipTlsVerification }: validated,
//                                                      the connection tested, then stored
//   GET    /storages/{uuid}                            Show + Form: the storage (the key for who may update; never the secret)
//   PATCH  /storages/{uuid}                            Form::submit: validated, tested, then stored
//   DELETE /storages/{uuid}                            Show::delete: its schedules let it go, then it is deleted
//   POST   /storages/{uuid}/validate                   Form::testConnection with the form's values → { valid, title, message }
//   GET    /storages/{uuid}/resources                  Resources: the database schedules that send to it
//   POST   /storages/{uuid}/resources/{backup}/move    Resources::moveBackup { storage_uuid }
//   DELETE /storages/{uuid}/resources/{backup}         Resources::disableS3
//
// Coolify's policy: view = a team member, create / update / delete /
// validateConnection = a team admin. Here: deploy.resource.read and
// deploy.resource.write, asked of policy-worker after membership-worker's
// facts; a denial answers 404 (never leaks). The connection is tested outside
// the database transaction (a read, the test, then the write).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  listS3Storages,
  findS3StorageByUuid,
  insertS3Storage,
  updateS3Storage,
  setS3StorageUsable,
  s3StorageBackupCount,
  deleteS3Storage,
  listS3StorageDatabaseBackups,
  databaseBackupStorageIds,
  syncScheduleS3Storages,
  disableDatabaseBackupS3,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse, validationError } from "../http.js";
import type { KeyCipher } from "../private-keys/service.js";
import { authorizeDeploy, columnCipher, readJson } from "./cloud-tokens.js";
import { s3Fetch, type S3Http } from "../s3-storages/connection.js";
import { dohResolver, type HostResolver } from "../s3-storages/safe-url.js";
import { validateCreateStorage, validateUpdateStorage } from "../s3-storages/validation.js";
import {
  StorageError,
  STORAGE_TOASTS,
  createStorage,
  deleteStorage,
  listStorages,
  loadStorage,
  moveBackup,
  removeFromBackup,
  showStorage,
  storageResources,
  storeStorage,
  updateStorage,
  validateStorage,
  writeStorage,
  type S3StorageContext,
  type S3StorageNetwork,
  type S3StorageStore,
} from "../s3-storages/service.js";

/** Storages: the collection and up to four segments below it (a storage, its action, a schedule of its Resources tab, its move). */
export const ORG_DEPLOY_STORAGES_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/storages((?:\/[^/]+){0,4})\/?$/;

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

export type S3StorageRunner = <T>(env: Env, orgId: string, fn: (ctx: S3StorageContext) => Promise<T>) => Promise<T>;

function sqlStore(tx: SqlExecutor, orgId: string): S3StorageStore {
  return {
    list: () => listS3Storages(tx),
    findByUuid: (uuid) => findS3StorageByUuid(tx, uuid),
    insert: (s) => insertS3Storage(tx, { ...s, orgId }),
    update: (id, fields) => updateS3Storage(tx, id, fields),
    setUsable: (id, isUsable, sent) => setS3StorageUsable(tx, id, isUsable, sent),
    backupCount: (id) => s3StorageBackupCount(tx, id),
    delete: (id) => deleteS3Storage(tx, id, orgId),
    listBackups: (id) => listS3StorageDatabaseBackups(tx, id),
    backupStorageIds: (id) => databaseBackupStorageIds(tx, id),
    syncBackupStorages: (id, ids) => syncScheduleS3Storages(tx, "database", id, ids, orgId),
    disableBackupS3: (id) => disableDatabaseBackupS3(tx, id),
  };
}

export const runS3StoragesInOrg: S3StorageRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => {
      const ciphers = new Map<string, KeyCipher>();
      const cipher = (column: string): KeyCipher => {
        let found = ciphers.get(column);
        if (!found) ciphers.set(column, (found = columnCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, column)));
        return found;
      };
      return fn({ store: sqlStore(tx, orgId), cipher });
    });
  } finally {
    await db.dispose();
  }
};

function failure(e: unknown, requestId: string): Response {
  if (e instanceof StorageError) {
    const code = e.status === 501 ? "unsupported" : "validation_failed";
    return errorResponse(code, e.message, e.status, requestId, e.title ? { title: e.title } : undefined);
  }
  return errorResponse("internal_error", "Service unavailable", 503, requestId);
}

class FieldErrors extends Error {
  constructor(readonly fields: Record<string, string[]>) {
    super("Validation failed");
  }
}

interface Op {
  write: boolean;
  status?: number;
  run: (canWrite: boolean, body: Record<string, unknown>) => Promise<object | null>;
}

/**
 * segments: what follows /storages, split on "/". `runner`, `http` and
 * `resolve` are replaceable for tests (no test touches the network).
 */
export async function handleS3Storages(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segments: string[],
  request: Request,
  runner: S3StorageRunner = runS3StoragesInOrg,
  http: S3Http = s3Fetch,
  resolve: HostResolver = dohResolver,
): Promise<Response> {
  const method = request.method;
  const [uuid, second, backup, fourth] = segments;
  const net: S3StorageNetwork = { http, resolve };
  const on = (methods: Record<string, Op>): Op | null => methods[method] ?? null;
  let op: Op | null | undefined;

  if (segments.length === 0) {
    op = on({
      GET: { write: false, run: async (canWrite) => ({ storages: await runner(env, orgId, (c) => listStorages(c)), canCreate: canWrite }) },
      POST: {
        write: true,
        status: 201,
        run: async (_w, body) => {
          const v = await validateCreateStorage(body, resolve);
          if (!v.ok) throw new FieldErrors(v.errors);
          const row = await createStorage(v.input, net, (fields) => runner(env, orgId, (c) => storeStorage(c, fields)));
          return { uuid: row.uuid };
        },
      },
    });
  } else if (!uuid || !UUID_RE.test(uuid)) {
    op = undefined;
  } else if (segments.length === 1) {
    op = on({
      GET: { write: false, run: async (canWrite) => ((storage) => storage && { storage, canUpdate: canWrite, canDelete: canWrite, canValidate: canWrite })(await runner(env, orgId, (c) => showStorage(c, uuid, canWrite))) },
      PATCH: {
        write: true,
        run: async (_w, body) => {
          const stored = await runner(env, orgId, (c) => loadStorage(c, uuid));
          if (!stored) return null;
          const v = await validateUpdateStorage(body, { endpoint: stored.row.endpoint, hasSavedSecret: stored.secret.trim() !== "" }, resolve);
          if (!v.ok) throw new FieldErrors(v.errors);
          const row = await updateStorage(stored, v.input, net, (fields) => runner(env, orgId, (c) => writeStorage(c, stored.row.id, fields)));
          if (!row) return null;
          return { storage: await runner(env, orgId, (c) => showStorage(c, uuid, true)), message: STORAGE_TOASTS.updated };
        },
      },
      DELETE: { write: true, run: async () => ((await runner(env, orgId, (c) => deleteStorage(c, uuid))) ? { deleted: true } : null) },
    });
  } else if (segments.length === 2 && second === "validate") {
    op = on({
      POST: {
        write: true,
        run: async (_w, body) => {
          const stored = await runner(env, orgId, (c) => loadStorage(c, uuid));
          if (!stored) return null;
          const outcome = await validateStorage(stored, body, net);
          // Only the stored storage's status changes; the email Coolify sends on a failure is not sent.
          await runner(env, orgId, (c) => c.store.setUsable(stored.row.id, outcome.valid, outcome.valid ? false : stored.row.unusable_email_sent));
          return { ...outcome, isUsable: outcome.valid };
        },
      },
    });
  } else if (segments.length === 2 && second === "resources") {
    op = on({ GET: { write: false, run: async (canWrite) => ((r) => r && { ...r, canUpdate: canWrite })(await runner(env, orgId, (c) => storageResources(c, uuid))) } });
  } else if (segments.length === 3 && second === "resources" && UUID_RE.test(backup!)) {
    op = on({ DELETE: { write: true, run: () => runner(env, orgId, (c) => removeFromBackup(c, uuid, backup!)) } });
  } else if (segments.length === 4 && second === "resources" && UUID_RE.test(backup!) && fourth === "move") {
    op = on({ POST: { write: true, run: (_w, body) => runner(env, orgId, (c) => moveBackup(c, uuid, backup!, body.storage_uuid)) } });
  }
  if (op === undefined) return errorResponse("not_found", "Not found", 404, requestId);
  if (op === null) return methodNotAllowed(requestId);

  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;
  try {
    const body = method === "POST" || method === "PATCH" ? await readJson(request) : {};
    const data = await op.run(auth.canWrite, body);
    return data ? successResponse(data, requestId, op.status ?? 200) : errorResponse("not_found", "Not found", 404, requestId);
  } catch (e) {
    if (e instanceof FieldErrors) return validationError(requestId, e.fields);
    return failure(e, requestId);
  }
}
