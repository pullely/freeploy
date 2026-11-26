// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/VolumeBackupsController.php (upsert,
// validateUpsertRequest, persistSchedule, destroy, run, findResource, findStorage, responseData),
// app/Http/Controllers/Api/Concerns/RequiresDeployAbility.php, app/Models/ScheduledVolumeBackup.php ($casts),
// app/Traits/HasS3Destinations.php (newS3StorageIds, syncS3Storages), app/Actions/Shared/DeleteScheduledVolumeBackup.php
// and bootstrap/helpers/shared.php (validate_cron_expression) (Apache-2.0), modified.
//
// Coolify's /api/v1 for the backup schedule of a storage — an application's, a standalone database's or a service's
// volume or directory mount (DP-88). A schedule is a row with its S3 storages (the pivot): PUT …/backups creates or
// updates it (updateOrCreate() on the storage's morph), DELETE …/backups deletes it with DeleteScheduledVolumeBackup —
// rows only while no execution holds an archive; one that does would be deleted on the server (rm) or in S3, which answers
// 501 in Coolify's envelope. POST …/backups/run queues VolumeBackupJob (docker run on the server): 501 after Coolify's
// checks, and nothing is stored.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { FILE_VOLUME_MORPH_CLASS, PERSISTENT_VOLUME_MORPH_CLASS, type ApiRow } from "@saas/db/deploy";
import { COOLIFY_API, POLICY_DENIALS, coolifyJson, obj, type CoolifyAnswer, type PhpValue } from "@saas/contracts/coolify-api";
import { needsExecutor } from "../applications/resources.js";
import { validateCronExpression } from "../servers/settings-validation.js";
import { newPublicId } from "../helpers/names.js";
import { hasDeployAbility, message, rowsOf, unavailable, UPDATE_DENIED, type ApiV1Context, type Rows } from "./context.js";
import { rowValue } from "./models.js";
import { addError, extraFields, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rules } from "./rules.js";
import { findTarget, type StorageKind, type Target } from "./storages.js";

export const VOLUME_BACKUPS_API_MESSAGES = {
  /** Freeploy's: VolumeBackupJob archives the volume with docker on the server. */
  runUnavailable: needsExecutor("Running the storage backup"),
  /** Freeploy's: deleteBackupsLocally() runs rm on the server, deleteS3Copies() deletes the archives in S3. */
  deleteArchivesUnavailable: needsExecutor("Deleting the storage backup archives"),
  stopNeedsDeploy: "Missing required permissions: deploy. A backup that stops the containers needs a token with the deploy permission.",
  runningBackup: "Wait for the running storage backup and recovery operations to finish before deleting this schedule.",
} as const;

const NOT_FOUND: Record<StorageKind, string> = { application: "Application not found.", database: "Database not found.", service: "Service not found." };

const ALLOWED = ["frequency", "enabled", "save_s3", "disable_local_backup", "stop_during_backup", "s3_storage_uuid", "s3_storage_uuids", "retention_amount_locally", "retention_days_locally", "retention_max_storage_locally", "retention_amount_s3", "retention_days_s3", "retention_max_storage_s3", "timeout", "missing_backup_notification_days"];
const RULES: Rules = [
  ["frequency", ["required", "string", "max:255"]],
  ["enabled", ["boolean"]],
  ["save_s3", ["boolean"]],
  ["disable_local_backup", ["boolean"]],
  ["stop_during_backup", ["boolean"]],
  ["s3_storage_uuid", ["nullable", "string"]],
  ["s3_storage_uuids", ["array"]],
  ["s3_storage_uuids.*", ["string", "distinct"]],
  ["retention_amount_locally", ["integer", "min:0", "max:10000"]],
  ["retention_days_locally", ["integer", "min:0", "max:2147483647"]],
  ["retention_max_storage_locally", ["numeric", "min:0", "max:9999999999"]],
  ["retention_amount_s3", ["integer", "min:0", "max:10000"]],
  ["retention_days_s3", ["integer", "min:0", "max:2147483647"]],
  ["retention_max_storage_s3", ["numeric", "min:0", "max:9999999999"]],
  ["timeout", ["integer", "min:60", "max:36000"]],
  ["missing_backup_notification_days", ["integer", "min:0", "max:365"]],
];

const denied = async (c: ApiV1Context, write: boolean, policyMessage?: string): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized(policyMessage));

/** FILTER_VALIDATE_BOOLEAN of $request->boolean($key, $default): the default only when the key is absent. */
function requestBool(all: Record<string, unknown>, key: string, fallback = false): boolean {
  if (!(key in all)) return fallback;
  const v = all[key];
  if (v === true) return true;
  if (typeof v === "number") return v === 1;
  return typeof v === "string" && ["1", "true", "on", "yes"].includes(v.trim().toLowerCase());
}
/** PHP's intval() of $request->integer($key, $default). */
function requestInt(all: Record<string, unknown>, key: string, fallback = 0): number {
  if (!(key in all)) return fallback;
  const v = all[key];
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const m = /^\s*[+-]?\d+/.exec(v);
    return m ? Number.parseInt(m[0], 10) : 0;
  }
  return 0;
}
/** PHP's floatval() of $request->float($key). */
function requestFloat(all: Record<string, unknown>, key: string): number {
  if (!(key in all)) return 0;
  const v = all[key];
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const m = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(v);
    return m ? Number.parseFloat(m[0]) : 0;
  }
  return 0;
}
const filled = (v: unknown): boolean => !(v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0));

interface FoundStorage {
  row: ApiRow;
  /** The backupable morph: a volume or a file mount. */
  type: string;
  directory: boolean;
}

/**
 * findStorage(): the resource's persistent storage, else its file storage, of that uuid — for a service, of each of its
 * applications, then its databases.
 */
async function findStorage(rows: Rows, target: Target, uuid: string): Promise<FoundStorage | null> {
  for (const owner of target.owners) {
    const volume = (await rows("local_persistent_volumes", "t.resource_type = $1 AND t.resource_id = $2 AND t.uuid = $3", [owner.type, owner.id, uuid]))[0];
    if (volume) return { row: volume, type: PERSISTENT_VOLUME_MORPH_CLASS, directory: false };
    const file = (await rows("local_file_volumes", "t.resource_type = $1 AND t.resource_id = $2 AND t.uuid = $3", [owner.type, owner.id, uuid]))[0];
    if (file) return { row: file, type: FILE_VOLUME_MORPH_CLASS, directory: rowValue(file, "is_directory") === true && rowValue(file, "is_host_file") !== true };
  }
  return null;
}

type ScheduleRow = {
  id: string;
  uuid: string;
  frequency: string;
  enabled: boolean;
  save_s3: boolean;
  disable_local_backup: boolean;
  stop_during_backup: boolean;
  s3_storage_id: string | null;
  retention_amount_locally: number;
  retention_days_locally: number;
  retention_max_storage_locally: number;
  retention_amount_s3: number;
  retention_days_s3: number;
  retention_max_storage_s3: number;
  timeout: number;
  missing_backup_notification_days: number;
};

/** $storage->scheduledBackups()->first(), with the model's casts. */
async function scheduleOf(tx: SqlExecutor, storage: FoundStorage): Promise<ScheduleRow | null> {
  const r = await tx.execute<ScheduleRow>(
    `SELECT id::text AS id, uuid, frequency, enabled, save_s3, disable_local_backup, stop_during_backup, s3_storage_id::text AS s3_storage_id,
            retention_amount_locally, retention_days_locally, retention_max_storage_locally::float8 AS retention_max_storage_locally,
            retention_amount_s3, retention_days_s3, retention_max_storage_s3::float8 AS retention_max_storage_s3, timeout, missing_backup_notification_days
       FROM deploy.scheduled_volume_backups WHERE backupable_type = $1 AND backupable_id = $2 ORDER BY id LIMIT 1`,
    [storage.type, rowValue(storage.row, "id")],
  );
  const row = r.rows[0];
  return row ? { ...row, retention_max_storage_locally: Number(row.retention_max_storage_locally), retention_max_storage_s3: Number(row.retention_max_storage_s3) } : null;
}

/** findResource() and findStorage() with the controller's 404s and the policy in between. */
async function resolve(c: ApiV1Context, tx: SqlExecutor, kind: StorageKind, uuid: string, storageUuid: string, notFound: string, write: boolean, beforeStorage?: () => CoolifyAnswer | null, policyMessage?: string): Promise<{ target: Target; storage: FoundStorage } | CoolifyAnswer> {
  const rows = rowsOf(tx);
  const target = await findTarget(tx, rows, kind, uuid);
  if (!target) return message(notFound, 404);
  const no = await denied(c, write, policyMessage);
  if (no) return no;
  const early = beforeStorage?.();
  if (early) return early;
  const storage = await findStorage(rows, target, storageUuid);
  if (!storage) return message("Storage not found.", 404);
  return { target, storage };
}
const isAnswer = (v: unknown): v is CoolifyAnswer => typeof v === "object" && v !== null && "status" in v && "body" in v;

/** routes/api.php's …/storages/{storage_uuid}/backups[/run] routes. segments: what follows /backups. */
export async function volumeBackupsApi(c: ApiV1Context, kind: StorageKind, uuid: string, storageUuid: string, segments: string[]): Promise<CoolifyAnswer | null> {
  const [sub, extra] = segments;
  if (extra !== undefined) return null;
  const m = c.method;
  if (sub === undefined) return m === "PUT" ? upsert(c, kind, uuid, storageUuid) : m === "DELETE" ? destroy(c, kind, uuid, storageUuid) : null;
  return sub === "run" && m === "POST" ? run(c, kind, uuid, storageUuid) : null;
}

/** S3Storage of the team, usable, with these uuids; the primary first (sortBy() keeps the rest in the query's order). */
async function usableStorages(tx: SqlExecutor, uuids: string[], primary: unknown): Promise<Array<{ id: string; uuid: string }>> {
  if (uuids.length === 0) return [];
  const r = await tx.execute<{ id: string; uuid: string }>("SELECT id::text AS id, uuid FROM deploy.s3_storages WHERE is_usable = true AND uuid = ANY($1) ORDER BY id", [uuids]);
  return [...r.rows].sort((a, b) => (a.uuid === primary ? 0 : 1) - (b.uuid === primary ? 0 : 1));
}

async function upsert(c: ApiV1Context, kind: StorageKind, uuid: string, storageUuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  return c.sql(c.env, c.orgId, async (tx) => {
    const found = await resolve(c, tx, kind, uuid, storageUuid, NOT_FOUND[kind], true, () => (requestBool(all, "stop_during_backup") && !hasDeployAbility(c) ? message(VOLUME_BACKUPS_API_MESSAGES.stopNeedsDeploy, 403) : null), UPDATE_DENIED[kind]);
    if (isAnswer(found)) return found;
    const { storage } = found;

    // validateUpsertRequest()
    const errors: Errors = [];
    await validateRules(errors, all, RULES);
    extraFields(errors, all, ALLOWED);
    const has = (k: string) => errors.some(([f]) => f === k);
    if (!has("frequency") && !validateCronExpression(String(all.frequency ?? ""))) addError(errors, "frequency", "The frequency must be a valid cron or human expression.");
    const saveToS3 = requestBool(all, "save_s3");
    if (requestBool(all, "disable_local_backup") && !saveToS3) addError(errors, "disable_local_backup", "Local backups can only be disabled when S3 backups are enabled.");
    let s3Storages: Array<{ id: string; uuid: string }> = [];
    if (saveToS3 && !errors.some(([f]) => f === "s3_storage_uuid" || f === "s3_storage_uuids" || f.startsWith("s3_storage_uuids."))) {
      const hasList = "s3_storage_uuids" in all;
      const listed = hasList ? (Array.isArray(all.s3_storage_uuids) ? (all.s3_storage_uuids as unknown[]) : Object.values((all.s3_storage_uuids ?? {}) as Record<string, unknown>)) : [all.s3_storage_uuid];
      const uuids = [...new Set(listed.filter((u) => filled(u) && u !== false && u !== 0 && u !== "0").map(String))];
      const primary = all.s3_storage_uuid ?? uuids[0];
      s3Storages = await usableStorages(tx, uuids, primary);
      if (hasList && filled(primary) && !uuids.includes(String(primary))) addError(errors, "s3_storage_uuid", "The s3_storage_uuid must be one of the s3_storage_uuids.");
      else if (uuids.length === 0 || s3Storages.length !== uuids.length) addError(errors, hasList ? "s3_storage_uuids" : "s3_storage_uuid", "Select a usable S3 storage owned by your team.");
    }
    if (storage.type === FILE_VOLUME_MORPH_CLASS && !storage.directory) addError(errors, "storage_uuid", "Only directory file storages can be backed up.");
    if (errors.length) return validationFailed(errors);

    // persistSchedule()
    const existing = await scheduleOf(tx, storage);
    const ids = s3Storages.map((s) => s.id);
    let currentIds: string[] = [];
    if (existing) {
      const r = await tx.execute<{ id: string }>("SELECT s3_storage_id::text AS id FROM deploy.scheduled_volume_backup_s3_storage WHERE scheduled_volume_backup_id = $1", [existing.id]);
      currentIds = [...r.rows.map((x) => x.id), ...(existing.s3_storage_id ? [existing.s3_storage_id] : [])];
    }
    // $this->authorize('useTeamCredentials', $resource) for an S3 storage the schedule does not use yet.
    if (ids.some((id) => !currentIds.includes(id))) {
      const no = await denied(c, true, POLICY_DENIALS.useTeamCredentials);
      if (no) return no;
    }
    const attributes = {
      frequency: String(all.frequency),
      enabled: requestBool(all, "enabled", true),
      save_s3: saveToS3,
      disable_local_backup: saveToS3 && requestBool(all, "disable_local_backup"),
      stop_during_backup: requestBool(all, "stop_during_backup"),
      s3_storage_id: s3Storages[0]?.id ?? null,
      retention_amount_locally: requestInt(all, "retention_amount_locally", 7),
      retention_days_locally: requestInt(all, "retention_days_locally"),
      retention_max_storage_locally: requestFloat(all, "retention_max_storage_locally"),
      retention_amount_s3: requestInt(all, "retention_amount_s3", 7),
      retention_days_s3: requestInt(all, "retention_days_s3"),
      retention_max_storage_s3: requestFloat(all, "retention_max_storage_s3"),
      ...("timeout" in all ? { timeout: requestInt(all, "timeout") } : {}),
      ...("missing_backup_notification_days" in all ? { missing_backup_notification_days: requestInt(all, "missing_backup_notification_days") } : {}),
    };
    const columns = Object.keys(attributes);
    const values = Object.values(attributes);
    let id: string;
    let backupUuid: string;
    if (existing) {
      // updateOrCreate(): fill() and save() of the dirty attributes (updated_at only when one changed).
      const dirty = columns.filter((k) => {
        const before = (existing as unknown as Record<string, unknown>)[k];
        const after = (attributes as Record<string, unknown>)[k];
        return before === null || after === null ? before !== after : String(before) !== String(after);
      });
      if (dirty.length) {
        const sets = dirty.map((k, i) => `"${k}" = $${i + 2}`).join(", ");
        await tx.execute(`UPDATE deploy.scheduled_volume_backups SET ${sets}, updated_at = date_trunc('second', timezone('UTC', now())) WHERE id = $1`, [existing.id, ...dirty.map((k) => (attributes as Record<string, unknown>)[k])]);
      }
      id = existing.id;
      backupUuid = existing.uuid;
    } else {
      backupUuid = newPublicId();
      const placeholders = values.map((_, i) => `$${i + 4}`).join(", ");
      const r = await tx.execute<{ id: string }>(
        `INSERT INTO deploy.scheduled_volume_backups (uuid, backupable_type, backupable_id, ${columns.map((k) => `"${k}"`).join(", ")}, org_id, created_at, updated_at)
         VALUES ($1, $2, $3, ${placeholders}, deploy.current_org(), date_trunc('second', timezone('UTC', now())), date_trunc('second', timezone('UTC', now()))) RETURNING id::text AS id`,
        [backupUuid, storage.type, rowValue(storage.row, "id"), ...values],
      );
      id = r.rows[0]!.id;
    }
    // syncS3Storages(): the pivot holds exactly these, and s3_storage_id stays one of them (else the first).
    await tx.execute("DELETE FROM deploy.scheduled_volume_backup_s3_storage WHERE scheduled_volume_backup_id = $1 AND NOT (s3_storage_id::text = ANY($2))", [id, ids]);
    for (const s3 of ids) {
      await tx.execute(
        "INSERT INTO deploy.scheduled_volume_backup_s3_storage (scheduled_volume_backup_id, s3_storage_id, org_id) SELECT $1, $2, deploy.current_org() WHERE NOT EXISTS (SELECT 1 FROM deploy.scheduled_volume_backup_s3_storage WHERE scheduled_volume_backup_id = $1 AND s3_storage_id = $2)",
        [id, s3],
      );
    }
    const primaryId = attributes.s3_storage_id;
    const kept = primaryId !== null && ids.includes(primaryId) ? primaryId : (ids[0] ?? null);
    if (kept !== primaryId) await tx.execute("UPDATE deploy.scheduled_volume_backups SET s3_storage_id = $2 WHERE id = $1", [id, kept]);

    // responseData(): the model's attributes as they are after the save (a new row has no timeout unless the request set it).
    const timeout: PhpValue = "timeout" in attributes ? attributes.timeout! : existing ? existing.timeout : null;
    const missingDays: number = "missing_backup_notification_days" in attributes ? attributes.missing_backup_notification_days! : existing ? existing.missing_backup_notification_days : 0;
    return coolifyJson(
      obj({
        uuid: backupUuid,
        message: existing ? "Storage backup schedule updated." : "Storage backup schedule created.",
        storage_uuid: String(rowValue(storage.row, "uuid")),
        storage_type: storage.type === FILE_VOLUME_MORPH_CLASS ? "directory" : "persistent",
        frequency: attributes.frequency,
        enabled: attributes.enabled,
        save_s3: attributes.save_s3,
        disable_local_backup: attributes.disable_local_backup,
        stop_during_backup: attributes.stop_during_backup,
        s3_storage_uuid: s3Storages[0]?.uuid ?? null,
        s3_storage_uuids: s3Storages.map((s) => s.uuid),
        retention_amount_locally: attributes.retention_amount_locally,
        retention_days_locally: attributes.retention_days_locally,
        retention_max_storage_locally: attributes.retention_max_storage_locally,
        retention_amount_s3: attributes.retention_amount_s3,
        retention_days_s3: attributes.retention_days_s3,
        retention_max_storage_s3: attributes.retention_max_storage_s3,
        timeout,
        missing_backup_notification_days: missingDays,
      }),
      existing ? 200 : 201,
    );
  });
}

async function destroy(c: ApiV1Context, kind: StorageKind, uuid: string, storageUuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const found = await resolve(c, tx, kind, uuid, storageUuid, "Resource not found.", true);
    if (isAnswer(found)) return found;
    const backup = await scheduleOf(tx, found.storage);
    if (!backup) return message("Storage backup schedule not found.", 404);
    // DeleteScheduledVolumeBackup
    const busy = await tx.execute("SELECT 1 FROM deploy.scheduled_volume_backup_executions WHERE scheduled_volume_backup_id = $1 AND (status = 'running' OR stop_recovery_pending OR s3_cleanup_pending) LIMIT 1", [backup.id]);
    if (busy.rows.length) return message(VOLUME_BACKUPS_API_MESSAGES.runningBackup, 409);
    const archives = await tx.execute(
      "SELECT 1 FROM deploy.scheduled_volume_backup_executions WHERE scheduled_volume_backup_id = $1 AND ((local_storage_deleted = false AND filename IS NOT NULL AND filename <> '') OR (s3_uploaded = true AND s3_storage_deleted = false)) LIMIT 1",
      [backup.id],
    );
    if (archives.rows.length) return unavailable(VOLUME_BACKUPS_API_MESSAGES.deleteArchivesUnavailable);
    // $backup->delete(): its executions and S3 storages go with it (the foreign keys' cascade in Coolify's schema).
    await tx.execute("DELETE FROM deploy.scheduled_volume_backup_s3_storage WHERE scheduled_volume_backup_id = $1", [backup.id]);
    await tx.execute("DELETE FROM deploy.scheduled_volume_backup_executions WHERE scheduled_volume_backup_id = $1", [backup.id]);
    await tx.execute("DELETE FROM deploy.scheduled_volume_backups WHERE id = $1", [backup.id]);
    return message("Storage backup schedule and archives deleted.", 200);
  });
}

async function run(c: ApiV1Context, kind: StorageKind, uuid: string, storageUuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const found = await resolve(c, tx, kind, uuid, storageUuid, NOT_FOUND[kind], true, undefined, UPDATE_DENIED[kind]);
    if (isAnswer(found)) return found;
    if (!(await scheduleOf(tx, found.storage))) return message("Storage backup schedule not found.", 404);
    return unavailable(VOLUME_BACKUPS_API_MESSAGES.runUnavailable);
  });
}
