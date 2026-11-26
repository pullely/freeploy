// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/Backup/{Index,Create,Show}.php,
// app/Livewire/Project/Service/VolumeBackup/{Index,Create,Show}.php, app/Livewire/Project/Service/DatabaseBackups.php,
// app/Livewire/Project/Shared/Storages/VolumeBackups.php, app/Actions/Shared/DeleteScheduledVolumeBackup.php,
// app/Models/ServiceDatabase.php (isBackupSolutionAvailable, databaseType), app/Models/ScheduledVolumeBackup.php
// (targetType, targetName, DEFAULT_TIMEOUT) and routes/web.php (project.application.backup.*,
// project.service.volume-backups.*, project.service.database.backup*) (Apache-2.0), modified.
//
// The console's storage backup pages (DP-99), Coolify's Livewire components as routes below an application and a
// service. Dispatched by handleApplications and handleServices:
//
//   GET    /applications/{uuid}/backups                        Backup\Index (+ Create's targets)
//   POST   /applications/{uuid}/backups                        Backup\Create::submit { targetKey, frequency }
//   GET    /applications/{uuid}/backups/{backup}               Backup\Show + VolumeBackups::mount() (?page=&perPage= for its executions)
//   PATCH  /applications/{uuid}/backups/{backup}               VolumeBackups: save / instantSave / updatedS3StorageIds / toggleS3 /
//                                                              toggleEnabled, named by `action`
//   POST   /applications/{uuid}/backups/{backup}/run           backupNow: VolumeBackupJob runs on the server — 501
//   DELETE /applications/{uuid}/backups/{backup}?delete_associated_backups_locally=&delete_associated_backups_s3=
//                                                              delete (DeleteScheduledVolumeBackup)
//   POST   …/{backup}/executions/cleanup-failed | cleanup-deleted       cleanupFailed / cleanupDeleted
//   POST   …/{backup}/executions/{id}/retry | download         retryRecovery / downloadBackup — 501 after their checks
//   DELETE …/{backup}/executions/{id}?delete_backup_s3=        deleteBackup
//   GET    /services/{uuid}/storage-backups                    VolumeBackup\Index (+ Create's targets, the databases' schedules)
//   POST   /services/{uuid}/storage-backups                    VolumeBackup\Create::submit
//   GET|PATCH|DELETE /services/{uuid}/storage-backups/{backup}[/…]   as an application's (openSchedule() takes update)
//   POST   /services/{uuid}/storage-backups/now/{type}/{backup}       Index::backupNow('database' | 'storage', …) — 501
//   GET    /services/{uuid}/database-backups/{stack_service_uuid}    DatabaseBackups::mount(): where Coolify redirects
//
// Coolify's policies: view to read; update for the schedule's changes; delete for deleting a schedule or an execution;
// manageBackups for a database's Back up now. Here: deploy.resource.read and deploy.resource.write, inside withOrg; a
// denial answers 404. Nothing runs a volume backup yet, so what Coolify runs on the server (the backup, its recovery,
// downloading or deleting an archive) answers 501 before anything is stored.
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  findApplicationByUuid,
  findApplicationConfiguration,
  listPersistentVolumes,
  listFileVolumes,
  listVolumeBackupSchedules,
  findVolumeBackupSchedule,
  findTargetVolumeBackupUuid,
  insertVolumeBackupSchedule,
  updateVolumeBackupSchedule,
  volumeBackupSelectedStorageIds,
  selectableVolumeBackupS3Storages,
  listVolumeBackupExecutions,
  findVolumeBackupExecution,
  deleteVolumeBackupExecution,
  cleanupVolumeBackupExecutions,
  volumeBackupArchives,
  volumeBackupBusy,
  deleteVolumeBackupSchedule,
  listServiceDatabaseBackups,
  findServiceDatabaseBackupTarget,
  syncScheduleS3Storages,
  serverTimezone,
  APPLICATION_MORPH_CLASS,
  SERVICE_PART_MORPH_CLASS,
  PERSISTENT_VOLUME_MORPH_CLASS,
  FILE_VOLUME_MORPH_CLASS,
  type StorageOwner,
  type DeployVolumeBackupListRow,
  type DeployVolumeBackupRow,
  type DeployVolumeBackupStorageRef,
  type DeployVolumeBackupExecutionRow,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse } from "../http.js";
import { authorizeDeploy, readJson } from "./cloud-tokens.js";
import { applicationShow } from "../applications/service.js";
import { loadServiceInfo } from "../services/configuration.js";
import { headline } from "../services/catalogue-build.js";
import { newPublicId } from "../helpers/names.js";
import { validateCronExpression } from "../servers/settings-validation.js";
import { validateBackupFields, type BackupFieldRules } from "../databases/backups.js";
import { serviceResourcesContext } from "./service-configuration.js";

/**
 * Freeploy's convention (needsExecutor() of applications/resources.ts), written out: this module loads inside the
 * router's import cycle, so its constants use no imported value. The backup's text is /api/v1's (DP-88).
 */
const needsExecutor = (what: string): string => `${what} needs the SSH executor, which is not available yet.`;

export const VOLUME_BACKUP_PAGE_MESSAGES = {
  runUnavailable: needsExecutor("Running the storage backup"),
  databaseRunUnavailable: needsExecutor("Running the database backup"),
  recoveryUnavailable: needsExecutor("Recovering the storage backup"),
  downloadUnavailable: needsExecutor("Downloading the backup archive"),
  deleteLocalUnavailable: needsExecutor("Deleting the local backup archives"),
  deleteS3Unavailable: needsExecutor("Deleting the S3 backup archives"),
  /** Create::submit() */
  targetNotOwned: (owner: "application" | "service") => `Select a volume or directory owned by this ${owner}.`,
  invalidFrequency: "The frequency must be a valid cron or human expression.",
  created: "Scheduled storage backup created.",
  updated: "Scheduled storage backup updated.",
  /** VolumeBackups */
  saved: "Storage backup schedule saved.",
  storagesUpdated: "S3 storages updated.",
  selectStorageFirst: "Select a usable S3 storage before enabling S3 backups.",
  selectStorage: "Select at least one usable S3 storage owned by your team.",
  s3: (on: boolean) => (on ? "S3 backups enabled." : "S3 backups disabled."),
  enabled: (on: boolean) => (on ? "Storage backups enabled." : "Storage backups disabled."),
  deleted: "Storage backup schedule deleted.",
  deleteFailed: (reason: string) => `Could not delete the backup schedule: ${reason}`,
  busy: "Wait for the running storage backup and recovery operations to finish before deleting this schedule.",
  failedCleaned: "Failed backup entries cleaned up.",
  noFailed: "No safely removable failed backup entries found.",
  deletedCleaned: (n: number) => `Cleaned up ${n} deleted backup entries.`,
  noDeleted: "No deleted backup entries found.",
  noRecovery: "No pending recovery found for this backup execution.",
  executionNotFound: "Backup execution not found.",
  executionBusy: "Wait for the backup and recovery operations to finish before deleting it.",
  backupDeleted: "Backup deleted.",
  /** VolumeBackup\Index::backupNow() for a database schedule */
  databaseMustRun: "The database must be running to start a backup.",
};

/** ScheduledVolumeBackup::DEFAULT_TIMEOUT */
const DEFAULT_TIMEOUT = 36000;

export type VolumeBackupPagesRunner = <T>(env: Env, orgId: string, fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;

export const runVolumeBackupPagesInOrg: VolumeBackupPagesRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, fn);
  } finally {
    await db.dispose();
  }
};

export type BackupResourceKind = "application" | "service";

/** Whether handleApplications (…/backups) or handleServices (…/storage-backups, …/database-backups) routes here. segments: what follows the collection. */
export function isVolumeBackupRoute(kind: BackupResourceKind, segments: readonly string[]): boolean {
  if (segments.length < 2) return false;
  return kind === "application" ? segments[1] === "backups" : segments[1] === "storage-backups" || segments[1] === "database-backups";
}

type Body = Record<string, unknown>;
type Id = string | number;

/** An answer the page shows: a field's inline error, or a toast (dispatch('error' | 'info', …)). */
class PageError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    readonly fields?: Record<string, string[]>,
  ) {
    super(message);
  }
}
const fieldError = (field: string, message: string) => new PageError(message, 422, { [field]: [message] });

/** The resource the page is about: its frame for the console, its storages' owners, its server. */
interface Resource {
  kind: BackupResourceKind;
  id: Id;
  uuid: string;
  frame: Record<string, unknown>;
  owners: Array<StorageOwner & { name: string }>;
  serverId: Id | null;
}

async function loadResource(tx: SqlExecutor, env: Env, orgId: string, kind: BackupResourceKind, uuid: string, canWrite: boolean): Promise<Resource | null> {
  if (kind === "application") {
    const row = await findApplicationConfiguration(tx, uuid);
    const frame = row ? await findApplicationByUuid(tx, uuid) : null;
    if (!row || !frame) return null;
    return { kind, id: row.id, uuid: row.uuid, frame: { application: applicationShow(frame, canWrite), canDeploy: canWrite }, owners: [{ type: APPLICATION_MORPH_CLASS, id: row.id, name: row.name }], serverId: row.server_id ?? null };
  }
  const loaded = await loadServiceInfo(serviceResourcesContext(tx, orgId, env.DEPLOY_ENCRYPTION_KEY).configuration, uuid);
  if (!loaded) return null;
  // $service->applications()->get()->concat($service->databases()->get())
  const owners = loaded.parts.map((p) => ({ type: SERVICE_PART_MORPH_CLASS[p.kind], id: p.row.id, name: p.row.name }));
  return { kind, id: loaded.row.id, uuid: loaded.row.uuid, frame: { service: loaded.info }, owners, serverId: loaded.row.server_id ?? null };
}

// ---------------------------------------------------------------- the list and Create

interface StorageRef {
  name: string;
  /** The service list's tooltip: name (bucket: …) or the storage type's label. */
  label: string;
}
const storageRef = (s: DeployVolumeBackupStorageRef): StorageRef => ({ name: s.name, label: `${s.name} (${s.type === "s3" || !s.type ? `bucket: ${s.bucket ?? ""}` : s.type})` });

export interface BackupListItem {
  uuid: string;
  targetName: string;
  targetType: string;
  frequency: string;
  enabled: boolean;
  saveS3: boolean;
  storages: StorageRef[];
  latestStatus: string | null;
  latestFinishedAt: string | null;
  executionsCount: number;
}
const listItem = (b: DeployVolumeBackupListRow): BackupListItem => ({
  uuid: b.uuid,
  targetName: b.target_name,
  targetType: b.target_type,
  frequency: b.frequency,
  enabled: b.enabled,
  saveS3: b.save_s3,
  storages: (b.storages ?? []).map(storageRef),
  latestStatus: b.latest_status,
  latestFinishedAt: b.latest_finished_at,
  executionsCount: Number(b.executions_count),
});

export interface BackupTarget {
  key: string;
  type: string;
  name: string;
  /** loadSelectedBackup(): the target's schedule, whose frequency the form takes and whose page the callout links. */
  existing: { uuid: string; frequency: string } | null;
}

/** Create::mount()'s targets: an application's volumes (by name) then directories (by path); a service's per part. */
async function targets(tx: SqlExecutor, r: Resource): Promise<BackupTarget[]> {
  const out: BackupTarget[] = [];
  const existing = async (type: string, id: Id) => {
    const uuid = await findTargetVolumeBackupUuid(tx, type, id);
    if (!uuid) return null;
    const row = await tx.execute<{ frequency: string }>("SELECT frequency FROM deploy.scheduled_volume_backups WHERE uuid = $1", [uuid]);
    return { uuid, frequency: row.rows[0]?.frequency ?? "daily" };
  };
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  if (r.kind === "application") {
    const owner = r.owners[0]!;
    const volumes = [...(await listPersistentVolumes(tx, owner))].sort((a, b) => byName(a.name, b.name));
    const directories = (await listFileVolumes(tx, owner)).filter((f) => f.is_directory && !f.is_host_file).sort((a, b) => byName(a.fs_path, b.fs_path));
    for (const v of volumes) out.push({ key: `volume:${v.id}`, type: "Volume", name: v.name, existing: await existing(PERSISTENT_VOLUME_MORPH_CLASS, v.id) });
    for (const d of directories) out.push({ key: `directory:${d.id}`, type: "Directory", name: d.fs_path, existing: await existing(FILE_VOLUME_MORPH_CLASS, d.id) });
    return out;
  }
  for (const owner of r.owners) {
    const label = headline(owner.name);
    for (const v of [...(await listPersistentVolumes(tx, owner))].sort((a, b) => byName(a.name, b.name))) {
      // str($volume->name)->after($service->uuid.'_')
      const prefix = `${r.uuid}_`;
      const at = v.name.indexOf(prefix);
      out.push({ key: `volume:${v.id}`, type: label, name: at === -1 ? v.name : v.name.slice(at + prefix.length), existing: await existing(PERSISTENT_VOLUME_MORPH_CLASS, v.id) });
    }
    for (const d of (await listFileVolumes(tx, owner)).filter((f) => f.is_directory && !f.is_host_file).sort((a, b) => byName(a.fs_path, b.fs_path))) {
      out.push({ key: `directory:${d.id}`, type: label, name: `${d.fs_path} (directory)`, existing: await existing(FILE_VOLUME_MORPH_CLASS, d.id) });
    }
  }
  return out;
}

/** Index::render(): the schedules and Create's targets; a service's also lists its databases' schedules. */
async function showIndex(tx: SqlExecutor, r: Resource) {
  const backups = (await listVolumeBackupSchedules(tx, r.owners)).map(listItem);
  const page: Record<string, unknown> = { ...r.frame, backups, targets: await targets(tx, r) };
  if (r.kind === "service") {
    page.databaseBackups = (await listServiceDatabaseBackups(tx, r.id, SERVICE_PART_MORPH_CLASS.database)).map((b) => ({
      uuid: b.uuid,
      targetName: b.database_human_name || b.database_name,
      targetType: "Database",
      frequency: b.frequency,
      enabled: b.enabled,
      saveS3: b.save_s3,
      storages: (b.storages ?? []).map(storageRef),
      latestStatus: b.latest_status,
      latestFinishedAt: b.latest_finished_at,
      executionsCount: Number(b.executions_count),
      databaseRunning: b.database_status.startsWith("running"),
    }));
  }
  return page;
}

const CREATE_RULES: BackupFieldRules = { targetKey: ["required", "string"], frequency: ["required", "string"] };

/** Create::submit(): the target's schedule created, or its frequency updated (enabled again). */
async function create(tx: SqlExecutor, orgId: string, r: Resource, body: Body) {
  const errors = validateBackupFields(body, CREATE_RULES);
  // 'regex:/^(volume|directory):[1-9][0-9]*$/'
  if (!errors.targetKey && !/^(volume|directory):[1-9][0-9]*$/.test(String(body.targetKey))) errors.targetKey = ["The target key field format is invalid."];
  if (Object.keys(errors).length) throw new PageError(Object.values(errors).flat()[0]!, 422, errors);
  const [type, id] = String(body.targetKey).split(":") as ["volume" | "directory", string];
  const target = (await targets(tx, r)).find((t) => t.key === `${type}:${id}`);
  if (!target) throw fieldError("targetKey", VOLUME_BACKUP_PAGE_MESSAGES.targetNotOwned(r.kind));
  const frequency = String(body.frequency);
  if (!validateCronExpression(frequency)) throw fieldError("frequency", VOLUME_BACKUP_PAGE_MESSAGES.invalidFrequency);
  const morph = type === "volume" ? PERSISTENT_VOLUME_MORPH_CLASS : FILE_VOLUME_MORPH_CLASS;
  // firstOrNew()->fill(['team_id', 'frequency', 'enabled' => true])->save()
  const existing = await findTargetVolumeBackupUuid(tx, morph, id);
  if (existing) {
    const row = (await tx.execute<{ id: string }>("SELECT id::text AS id FROM deploy.scheduled_volume_backups WHERE uuid = $1", [existing])).rows[0]!;
    await updateVolumeBackupSchedule(tx, row.id, { frequency, enabled: true });
    return { message: VOLUME_BACKUP_PAGE_MESSAGES.updated, backupUuid: existing, created: false };
  }
  const created = await insertVolumeBackupSchedule(tx, { orgId, uuid: newPublicId(), backupableType: morph, backupableId: id, frequency, enabled: true });
  return { message: VOLUME_BACKUP_PAGE_MESSAGES.created, backupUuid: created.uuid, created: true };
}

// ---------------------------------------------------------------- one schedule (VolumeBackups)

const SETTINGS_RULES: BackupFieldRules = {
  frequency: ["required", "string"],
  enabled: ["required", "boolean"],
  saveToS3: ["required", "boolean"],
  disableLocalBackup: ["required", "boolean"],
  stopDuringBackup: ["required", "boolean"],
  s3StorageIds: ["array"],
  retentionAmountLocally: ["required", "integer", ["min", 0], ["max", 10000]],
  retentionDaysLocally: ["required", "integer", ["min", 0]],
  retentionMaxStorageLocally: ["required", "numeric", ["min", 0]],
  retentionAmountS3: ["required", "integer", ["min", 0], ["max", 10000]],
  retentionDaysS3: ["required", "integer", ["min", 0]],
  retentionMaxStorageS3: ["required", "numeric", ["min", 0]],
  timeout: ["required", "integer", ["min", 60], ["max", 36000]],
  missingBackupNotificationDays: ["required", "integer", ["min", 0], ["max", 365]],
};

export interface BackupSettings {
  frequency: string;
  enabled: boolean;
  saveToS3: boolean;
  disableLocalBackup: boolean;
  stopDuringBackup: boolean;
  /** The S3 storages' uuids (Coolify's ids). */
  s3StorageIds: string[];
  retentionAmountLocally: number;
  retentionDaysLocally: number;
  retentionMaxStorageLocally: number;
  retentionAmountS3: number;
  retentionDaysS3: number;
  retentionMaxStorageS3: number;
  timeout: number;
  missingBackupNotificationDays: number;
}

interface LoadedSchedule {
  backup: DeployVolumeBackupRow;
  /** selectableS3Storages()->orderBy('name') */
  options: Array<{ id: string; uuid: string; name: string; isUsable: boolean }>;
  selectedIds: string[];
}

async function loadSchedule(tx: SqlExecutor, r: Resource, backupUuid: string): Promise<LoadedSchedule | null> {
  const backup = await findVolumeBackupSchedule(tx, r.owners, backupUuid);
  if (!backup) return null;
  const selectedIds = await volumeBackupSelectedStorageIds(tx, backup.id);
  const options = (await selectableVolumeBackupS3Storages(tx, selectedIds)).map((s) => ({ id: s.id, uuid: s.uuid, name: s.name, isUsable: s.is_usable }));
  return { backup, options, selectedIds };
}

/** VolumeBackups::mount()'s properties: the schedule's values, the selected storages or else the first one offered. */
function settingsOf(l: LoadedSchedule): BackupSettings {
  const b = l.backup;
  const selected = l.selectedIds.length ? l.selectedIds : l.options.slice(0, 1).map((o) => o.id);
  return {
    frequency: b.frequency,
    enabled: b.enabled,
    saveToS3: b.save_s3,
    disableLocalBackup: b.disable_local_backup,
    stopDuringBackup: b.stop_during_backup,
    s3StorageIds: selected.map((id) => l.options.find((o) => o.id === id)?.uuid).filter((u): u is string => Boolean(u)),
    retentionAmountLocally: b.retention_amount_locally,
    retentionDaysLocally: b.retention_days_locally,
    retentionMaxStorageLocally: b.retention_max_storage_locally,
    retentionAmountS3: b.retention_amount_s3,
    retentionDaysS3: b.retention_days_s3,
    retentionMaxStorageS3: b.retention_max_storage_s3,
    timeout: b.timeout ?? DEFAULT_TIMEOUT,
    missingBackupNotificationDays: b.missing_backup_notification_days,
  };
}

const stamp = (v: string | null): string | null => v;

function executionOf(e: DeployVolumeBackupExecutionRow) {
  return {
    id: String(e.id),
    uuid: e.uuid,
    status: e.status,
    message: e.message,
    size: Number(e.size),
    filename: e.filename,
    createdAt: stamp(e.created_at),
    updatedAt: stamp(e.updated_at),
    finishedAt: stamp(e.finished_at),
    localStorageDeleted: e.local_storage_deleted,
    s3StorageDeleted: e.s3_storage_deleted,
    s3Uploaded: e.s3_uploaded,
    /** hasPendingRecovery() */
    recoveryPending: e.stop_recovery_pending || e.s3_cleanup_pending,
    recoveryError: e.recovery_error,
    recoveryNeedsAttention: e.recovery_needs_attention,
    /** isDownloadable(): a local archive that is still there, or an S3 copy. Freeploy has no S3 replicas. */
    isDownloadable: (!e.local_storage_deleted && Boolean(e.filename)) || (e.s3_uploaded === true && !e.s3_storage_deleted),
  };
}

async function showSchedule(tx: SqlExecutor, r: Resource, backupUuid: string, query: URLSearchParams) {
  const l = await loadSchedule(tx, r, backupUuid);
  if (!l) return null;
  // $perPage: max(1, min(100, …)); WithPagination's ?page=
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get("perPage") ?? "10", 10) || 10));
  const page = Math.max(1, Number.parseInt(query.get("page") ?? "1", 10) || 1);
  const executions = await listVolumeBackupExecutions(tx, l.backup.id, page, perPage);
  // data_get($server, 'settings.server_timezone', 'Instance timezone')
  const timezone = (await serverTimezone(tx, r.serverId)) || "Instance timezone";
  return {
    ...r.frame,
    backup: { uuid: l.backup.uuid, targetType: l.backup.target_type, targetName: l.backup.target_name, ...settingsOf(l) },
    availableS3Storages: l.options.map((o) => ({ uuid: o.uuid, name: o.name, isUsable: o.isUsable })),
    timezone,
    executions: { total: executions.total, page, perPage, rows: executions.rows.map(executionOf) },
    deleteScheduleCheckboxes: [
      { id: "delete_associated_backups_locally", label: "Delete all local archives created by this schedule." },
      { id: "delete_associated_backups_s3", label: "Delete all S3 archives created by this schedule." },
    ],
  };
}

/** The form's values: what the body sets over what the schedule holds. */
function formOf(l: LoadedSchedule, body: Body): Record<string, unknown> {
  const current = settingsOf(l) as unknown as Record<string, unknown>;
  const form: Record<string, unknown> = {};
  for (const key of Object.keys(SETTINGS_RULES)) form[key] = key in body ? body[key] : current[key];
  return form;
}

/** selectedS3StorageIds(): the submitted storages that are selectable, in the submitted order. */
function selectedIds(l: LoadedSchedule, submitted: unknown): string[] {
  const uuids = Array.isArray(submitted) ? submitted.map(String) : [];
  const ids: string[] = [];
  for (const uuid of uuids) {
    const found = l.options.find((o) => o.uuid === uuid);
    if (found && !ids.includes(found.id)) ids.push(found.id);
  }
  return ids;
}

/** validateSettings(): the rules, the cron, a storage for S3; disableLocalBackup only with S3. */
function validateSettings(l: LoadedSchedule, form: Record<string, unknown>): void {
  const errors = validateBackupFields(form, SETTINGS_RULES);
  if (Object.keys(errors).length) throw new PageError(Object.values(errors).flat()[0]!, 422, errors);
  if (!validateCronExpression(String(form.frequency))) throw fieldError("frequency", VOLUME_BACKUP_PAGE_MESSAGES.invalidFrequency);
  const on = (v: unknown) => v === true || v === 1 || v === "1";
  if (on(form.saveToS3) && selectedIds(l, form.s3StorageIds).length === 0) throw fieldError("s3StorageIds", VOLUME_BACKUP_PAGE_MESSAGES.selectStorage);
  form.disableLocalBackup = on(form.saveToS3) && on(form.disableLocalBackup);
}

/** persistBackup($enabled): every setting saved, then syncS3Storages(). */
async function persist(tx: SqlExecutor, orgId: string, l: LoadedSchedule, form: Record<string, unknown>, enabled: boolean): Promise<void> {
  const on = (v: unknown) => v === true || v === 1 || v === "1";
  await updateVolumeBackupSchedule(tx, l.backup.id, {
    frequency: String(form.frequency),
    enabled,
    save_s3: on(form.saveToS3),
    disable_local_backup: on(form.disableLocalBackup),
    stop_during_backup: on(form.stopDuringBackup),
    retention_amount_locally: Math.trunc(Number(form.retentionAmountLocally)),
    retention_days_locally: Math.trunc(Number(form.retentionDaysLocally)),
    retention_max_storage_locally: Number(form.retentionMaxStorageLocally),
    retention_amount_s3: Math.trunc(Number(form.retentionAmountS3)),
    retention_days_s3: Math.trunc(Number(form.retentionDaysS3)),
    retention_max_storage_s3: Number(form.retentionMaxStorageS3),
    timeout: Math.trunc(Number(form.timeout)),
    missing_backup_notification_days: Math.trunc(Number(form.missingBackupNotificationDays)),
  });
  await syncScheduleS3Storages(tx, "volume", l.backup.id, selectedIds(l, form.s3StorageIds), orgId);
}

async function saveSchedule(tx: SqlExecutor, orgId: string, r: Resource, backupUuid: string, body: Body, query: URLSearchParams) {
  const l = await loadSchedule(tx, r, backupUuid);
  if (!l) return null;
  const action = typeof body.action === "string" ? body.action : "save";
  const form = formOf(l, body);
  const on = (v: unknown) => v === true || v === 1 || v === "1";
  let message: string;
  if (action === "toggleEnabled") {
    // The schedule exists (Show finds it by its uuid): only `enabled` changes.
    const enabled = !l.backup.enabled;
    await updateVolumeBackupSchedule(tx, l.backup.id, { enabled });
    message = VOLUME_BACKUP_PAGE_MESSAGES.enabled(enabled);
  } else if (action === "toggleS3") {
    if (!on(form.saveToS3) && selectedIds(l, form.s3StorageIds).length === 0) throw new PageError(VOLUME_BACKUP_PAGE_MESSAGES.selectStorageFirst);
    form.saveToS3 = !on(form.saveToS3);
    form.disableLocalBackup = on(form.saveToS3) && on(form.disableLocalBackup);
    validateSettings(l, form);
    await persist(tx, orgId, l, form, on(form.enabled));
    message = VOLUME_BACKUP_PAGE_MESSAGES.s3(on(form.saveToS3));
  } else if (action === "s3StorageIds") {
    validateSettings(l, form);
    await persist(tx, orgId, l, form, on(form.enabled));
    message = VOLUME_BACKUP_PAGE_MESSAGES.storagesUpdated;
  } else if (action === "save" || action === "instantSave") {
    validateSettings(l, form);
    await persist(tx, orgId, l, form, on(form.enabled));
    message = VOLUME_BACKUP_PAGE_MESSAGES.saved;
  } else {
    throw new PageError("Unknown action.", 400);
  }
  const shown = await showSchedule(tx, r, backupUuid, query);
  return shown ? { ...shown, message } : null;
}

/** backupNow(): the schedule exists, then VolumeBackupJob would run on the server. */
async function backupNow(tx: SqlExecutor, r: Resource, backupUuid: string): Promise<null> {
  if (!(await findVolumeBackupSchedule(tx, r.owners, backupUuid))) return null;
  throw new PageError(VOLUME_BACKUP_PAGE_MESSAGES.runUnavailable, 501);
}

/** delete(): DeleteScheduledVolumeBackup with the archives the dialog's checkboxes chose. */
async function deleteSchedule(tx: SqlExecutor, r: Resource, backupUuid: string, query: URLSearchParams) {
  const backup = await findVolumeBackupSchedule(tx, r.owners, backupUuid);
  if (!backup) return null;
  const flag = (name: string) => ["1", "true", "on", "yes"].includes((query.get(name) ?? "").trim().toLowerCase());
  if (await volumeBackupBusy(tx, backup.id)) throw new PageError(VOLUME_BACKUP_PAGE_MESSAGES.deleteFailed(VOLUME_BACKUP_PAGE_MESSAGES.busy), 409);
  const archives = await volumeBackupArchives(tx, backup.id);
  // deleteBackupsLocally() runs rm on the server.
  if (flag("delete_associated_backups_locally") && archives.local > 0) throw new PageError(VOLUME_BACKUP_PAGE_MESSAGES.deleteLocalUnavailable, 501);
  // deleteS3Copies() of the executions whose S3 replicas are uploaded: Freeploy keeps no replica rows, so there are none.
  await deleteVolumeBackupSchedule(tx, backup.id);
  return { message: VOLUME_BACKUP_PAGE_MESSAGES.deleted, deleted: true };
}

async function cleanup(tx: SqlExecutor, r: Resource, backupUuid: string, kind: "failed" | "deleted") {
  const backup = await findVolumeBackupSchedule(tx, r.owners, backupUuid);
  if (!backup) return null;
  const n = await cleanupVolumeBackupExecutions(tx, backup.id, kind);
  const message = kind === "failed" ? (n > 0 ? VOLUME_BACKUP_PAGE_MESSAGES.failedCleaned : VOLUME_BACKUP_PAGE_MESSAGES.noFailed) : n > 0 ? VOLUME_BACKUP_PAGE_MESSAGES.deletedCleaned(n) : VOLUME_BACKUP_PAGE_MESSAGES.noDeleted;
  return { message, level: n > 0 ? "success" : "info", deletedCount: n };
}

async function onExecution(tx: SqlExecutor, r: Resource, backupUuid: string, id: string, action: "retry" | "download" | "delete", query: URLSearchParams) {
  const backup = await findVolumeBackupSchedule(tx, r.owners, backupUuid);
  if (!backup) return null;
  const execution = await findVolumeBackupExecution(tx, backup.id, id);
  if (action === "retry") {
    if (!execution || !(execution.stop_recovery_pending || execution.s3_cleanup_pending)) throw new PageError(VOLUME_BACKUP_PAGE_MESSAGES.noRecovery);
    // recovery_needs_attention cleared, then VolumeBackupRecoveryJob on the server.
    throw new PageError(VOLUME_BACKUP_PAGE_MESSAGES.recoveryUnavailable, 501);
  }
  if (!execution) throw new PageError(VOLUME_BACKUP_PAGE_MESSAGES.executionNotFound);
  // prepareBackupDownload(): the archive is read from the server or from S3.
  if (action === "download") throw new PageError(VOLUME_BACKUP_PAGE_MESSAGES.downloadUnavailable, 501);
  if (execution.status === "running" || execution.stop_recovery_pending || execution.s3_cleanup_pending) throw new PageError(VOLUME_BACKUP_PAGE_MESSAGES.executionBusy);
  if (!execution.local_storage_deleted && execution.filename) throw new PageError(VOLUME_BACKUP_PAGE_MESSAGES.deleteLocalUnavailable, 501);
  const deleteS3 = ["1", "true", "on", "yes"].includes((query.get("delete_backup_s3") ?? "").trim().toLowerCase());
  if (deleteS3 && execution.s3_uploaded === true && !execution.s3_storage_deleted) throw new PageError(VOLUME_BACKUP_PAGE_MESSAGES.deleteS3Unavailable, 501);
  await deleteVolumeBackupExecution(tx, backup.id, execution.id);
  return { message: VOLUME_BACKUP_PAGE_MESSAGES.backupDeleted, deleted: true };
}

/** VolumeBackup\Index::backupNow($type, $uuid) of a service. */
async function serviceBackupNow(tx: SqlExecutor, r: Resource, type: string, backupUuid: string): Promise<null> {
  if (type === "database") {
    const found = (await listServiceDatabaseBackups(tx, r.id, SERVICE_PART_MORPH_CLASS.database)).find((b) => b.uuid === backupUuid);
    if (!found) return null;
    if (!found.database_status.startsWith("running")) throw new PageError(VOLUME_BACKUP_PAGE_MESSAGES.databaseMustRun);
    throw new PageError(VOLUME_BACKUP_PAGE_MESSAGES.databaseRunUnavailable, 501);
  }
  if (type !== "storage") return null;
  return backupNow(tx, r, backupUuid);
}

/** ServiceDatabase::isBackupSolutionAvailable() over databaseType(). */
export function serviceDatabaseBackupAvailable(image: string | null, customType: string | null): boolean {
  const filled = (v: string | null) => v !== null && v.trim() !== "";
  let type: string;
  if (filled(customType)) type = `standalone-${customType}`;
  else {
    const name = (image ?? "").split(":")[0]!;
    type = `standalone-${name.includes("supabase/postgres") ? "supabase/postgres" : name.includes("timescale") || name.includes("pgvector") || name.includes("postgres") || name.includes("postgis") ? "postgresql" : name}`;
  }
  return ["mysql", "postgres", "postgis", "mariadb", "mongo"].some((t) => type.includes(t)) || filled(customType);
}

/** DatabaseBackups::mount(): where routes/web.php's …/{stack_service_uuid}/backups[…] ends up. */
async function databaseBackupsRedirect(tx: SqlExecutor, r: Resource, stackUuid: string) {
  const database = await findServiceDatabaseBackupTarget(tx, r.id, stackUuid);
  if (!database) return { redirect: "configuration" };
  if (!serviceDatabaseBackupAvailable(database.image, database.custom_type) && !database.is_migrated) return { redirect: "part" };
  return { redirect: "storage-backups" };
}

// ---------------------------------------------------------------- the routes

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

/** segments: what follows /applications or /services — [uuid, "backups" | "storage-backups" | "database-backups", …]. `runner` is replaceable for tests. */
export async function handleVolumeBackupPages(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  kind: BackupResourceKind,
  segments: string[],
  request: Request,
  runner: VolumeBackupPagesRunner = runVolumeBackupPagesInOrg,
): Promise<Response> {
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  const [uuid, section, third, fourth, fifth, sixth] = segments;
  if (!uuid || !UUID_RE.test(uuid) || !isVolumeBackupRoute(kind, segments)) return notFound();
  const method = request.method;
  const query = new URL(request.url).searchParams;
  const depth = segments.length;
  type Op = { write: boolean; status?: number; run: (tx: SqlExecutor, r: Resource, body: Body) => Promise<object | null> };
  let op: Op | null | undefined;
  const on = (m: string, write: boolean, run: Op["run"], status?: number): Op | null => (method === m ? { write, run, ...(status ? { status } : {}) } : null);
  const backup = third !== undefined && UUID_RE.test(third) && third !== "now" ? third : null;

  if (section === "database-backups") {
    if (kind === "service" && depth === 3 && third && UUID_RE.test(third)) op = on("GET", false, (tx, r) => databaseBackupsRedirect(tx, r, third));
  } else if (depth === 2) {
    op = on("GET", false, (tx, r) => showIndex(tx, r)) ?? on("POST", true, (tx, r, body) => create(tx, orgId, r, body), 201);
  } else if (kind === "service" && depth === 5 && third === "now" && fourth && fifth && UUID_RE.test(fifth)) {
    op = on("POST", true, (tx, r) => serviceBackupNow(tx, r, fourth, fifth));
  } else if (backup && depth === 3) {
    // A service's schedule opens in Index's modal: openSchedule() authorizes update.
    op = on("GET", kind === "service", (tx, r) => showSchedule(tx, r, backup, query)) ?? on("PATCH", true, (tx, r, body) => saveSchedule(tx, orgId, r, backup, body, query)) ?? on("DELETE", true, (tx, r) => deleteSchedule(tx, r, backup, query));
  } else if (backup && depth === 4 && fourth === "run") {
    op = on("POST", true, (tx, r) => backupNow(tx, r, backup));
  } else if (backup && depth === 5 && fourth === "executions" && (fifth === "cleanup-failed" || fifth === "cleanup-deleted")) {
    op = on("POST", true, (tx, r) => cleanup(tx, r, backup, fifth === "cleanup-failed" ? "failed" : "deleted"));
  } else if (backup && depth === 5 && fourth === "executions" && fifth && /^[1-9]\d{0,17}$/.test(fifth)) {
    op = on("DELETE", true, (tx, r) => onExecution(tx, r, backup, fifth, "delete", query));
  } else if (backup && depth === 6 && fourth === "executions" && fifth && /^[1-9]\d{0,17}$/.test(fifth) && (sixth === "retry" || sixth === "download")) {
    op = on("POST", true, (tx, r) => onExecution(tx, r, backup, fifth, sixth, query));
  }
  if (op === undefined) return notFound();
  if (op === null) return methodNotAllowed(requestId);

  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;
  const body = method === "POST" || method === "PATCH" ? await readJson(request) : {};
  try {
    const data = await runner(env, orgId, async (tx) => {
      const r = await loadResource(tx, env, orgId, kind, uuid, auth.canWrite);
      return r ? op.run(tx, r, body) : null;
    });
    if (!data) return notFound();
    // Create::submit() of a target that already has a schedule updates it.
    const status = (data as { created?: unknown }).created === false ? 200 : (op.status ?? 200);
    return successResponse(op.write ? data : { ...data, canUpdate: auth.canWrite, canDelete: auth.canWrite }, requestId, status);
  } catch (e) {
    if (e instanceof PageError) {
      const code = e.status === 501 ? "unsupported" : e.status === 409 ? "conflict" : e.status === 400 ? "bad_request" : "validation_failed";
      return errorResponse(code, e.message, e.status, requestId, e.fields ? { fields: e.fields } : undefined);
    }
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}
