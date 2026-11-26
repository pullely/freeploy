// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Database/{ScheduledBackups,CreateScheduledBackup,BackupEdit}.php,
// app/Livewire/Project/Database/Backup/{Index,ExecutionHistory}.php and app/Policies/DatabasePolicy.php (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/databases/{uuid}/backups — a standalone database's backup schedules,
// dispatched here by handleDatabases (databases.ts):
//
//   GET    /databases/{uuid}/backups              Backup\Index + ScheduledBackups + ExecutionHistory: the schedules, the
//                                                 counts and the executions (read only: nothing runs a schedule yet)
//   POST   /databases/{uuid}/backups              CreateScheduledBackup::submit { frequency }
//   GET    /databases/{uuid}/backups/{backup}     BackupEdit: the schedule's settings and the storages it may use
//   PATCH  /databases/{uuid}/backups/{backup}     BackupEdit::submit (or instantSave), or — named by `action` —
//                                                 "toggleEnabled", "toggleS3"; storages as s3StorageUuids
//   POST   /databases/{uuid}/backups/{backup}     backupNow: 501 (the backup job needs the SSH executor)
//   DELETE /databases/{uuid}/backups/{backup}?delete_associated_backups_locally=…&delete_associated_backups_s3=…
//                                                 BackupEdit::delete (DeleteScheduledDatabaseBackup)
//
// Coolify's policy: view, manageBackups (write), delete (write). Here:
// deploy.resource.read and deploy.resource.write; a denial answers 404.
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  findDatabaseByUuid,
  listDatabaseBackups,
  findDatabaseBackup,
  insertDatabaseBackup,
  updateDatabaseBackup,
  setDatabaseBackupEnabled,
  availableBackupS3Storages,
  databaseBackupStorages,
  databaseBackupStorageIds,
  syncScheduleS3Storages,
  listDatabaseBackupExecutions,
  databaseBackupFiles,
  deleteDatabaseBackup,
  serverTimezone,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse } from "../http.js";
import { authorizeDeploy, readJson } from "./cloud-tokens.js";
import { BackupError, backupNow, createBackup, deleteBackup, listBackups, saveBackup, showBackup, toggleBackup, type DatabaseBackupStore } from "../databases/backups.js";

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

export type DatabaseBackupRunner = <T>(env: Env, orgId: string, fn: (store: DatabaseBackupStore) => Promise<T>) => Promise<T>;

function sqlStore(tx: SqlExecutor, orgId: string): DatabaseBackupStore {
  return {
    findDatabase: (uuid) => findDatabaseByUuid(tx, uuid),
    list: (type, id) => listDatabaseBackups(tx, type, id),
    find: (type, id, uuid) => findDatabaseBackup(tx, type, id, uuid),
    insert: (b) => insertDatabaseBackup(tx, { ...b, orgId }),
    update: (id, changes) => updateDatabaseBackup(tx, id, changes),
    setEnabled: (id, enabled) => setDatabaseBackupEnabled(tx, id, enabled),
    availableStorages: (ids) => availableBackupS3Storages(tx, ids),
    storagesOf: (ids) => databaseBackupStorages(tx, ids),
    storageIds: (id) => databaseBackupStorageIds(tx, id),
    syncStorages: (id, ids) => syncScheduleS3Storages(tx, "database", id, ids, orgId),
    executions: (type, id, limit) => listDatabaseBackupExecutions(tx, type, id, limit),
    files: (id) => databaseBackupFiles(tx, id),
    delete: (id) => deleteDatabaseBackup(tx, id),
    timezone: (serverId) => serverTimezone(tx, serverId),
  };
}

export const runDatabaseBackupsInOrg: DatabaseBackupRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => fn(sqlStore(tx, orgId)));
  } finally {
    await db.dispose();
  }
};

interface Op {
  write: boolean;
  status?: number;
  run: (store: DatabaseBackupStore, canWrite: boolean, body: Record<string, unknown>) => Promise<object | null>;
}

const flag = (v: string | null): boolean => v === "1" || v === "true";

/** segments: what follows /databases, from the database's uuid on ([uuid, "backups", …]). */
export async function handleDatabaseBackups(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segments: string[],
  request: Request,
  runner: DatabaseBackupRunner = runDatabaseBackupsInOrg,
): Promise<Response> {
  const [uuid, , backup] = segments;
  const method = request.method;
  const query = new URL(request.url).searchParams;
  const on = (methods: Record<string, Op>): Op | null => methods[method] ?? null;
  let op: Op | null | undefined;
  if (!uuid || !UUID_RE.test(uuid)) op = undefined;
  else if (segments.length === 2) {
    op = on({
      GET: { write: false, run: async (s, canWrite) => ((r) => r && { ...r, canUpdate: canWrite, canManageBackups: canWrite, canDelete: canWrite })(await listBackups(s, uuid)) },
      POST: { write: true, status: 201, run: (s, _w, body) => createBackup(s, uuid, body) },
    });
  } else if (segments.length === 3 && UUID_RE.test(backup!)) {
    op = on({
      GET: { write: false, run: async (s, canWrite) => ((b) => b && { backup: b, canManageBackups: canWrite, canDelete: canWrite })(await showBackup(s, uuid, backup!)) },
      PATCH: {
        write: true,
        run: (s, _w, body) => {
          const { action, ...fields } = body;
          if (action === "toggleEnabled") return toggleBackup(s, uuid, backup!);
          if (action === "toggleS3") return saveBackup(s, uuid, backup!, fields, true);
          if (action === undefined || action === null || action === "submit" || action === "instantSave") return saveBackup(s, uuid, backup!, fields);
          throw new BackupError("The selected action is invalid.", 422, { action: ["The selected action is invalid."] });
        },
      },
      POST: { write: true, run: (s) => backupNow(s, uuid, backup!) },
      DELETE: { write: true, run: (s) => deleteBackup(s, uuid, backup!, { local: flag(query.get("delete_associated_backups_locally")), s3: flag(query.get("delete_associated_backups_s3")) }) },
    });
  }
  if (op === undefined) return errorResponse("not_found", "Not found", 404, requestId);
  if (op === null) return methodNotAllowed(requestId);

  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;
  const run = op.run;
  try {
    const body = method === "POST" || method === "PATCH" ? await readJson(request) : {};
    const data = await runner(env, orgId, (s) => run(s, auth.canWrite, body));
    return data ? successResponse(data, requestId, op.status ?? 200) : errorResponse("not_found", "Not found", 404, requestId);
  } catch (e) {
    if (e instanceof BackupError) {
      return errorResponse(e.status === 501 ? "unsupported" : "validation_failed", e.message, e.status, requestId, e.fields ? { fields: e.fields } : undefined);
    }
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}
