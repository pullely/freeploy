// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Database/{ScheduledBackups,CreateScheduledBackup,BackupEdit}.php,
// app/Livewire/Project/Database/Backup/{Index,ExecutionHistory}.php, app/Livewire/Concerns/ManagesDatabaseBackup.php,
// app/Actions/Database/DeleteScheduledDatabaseBackup.php, app/Models/Standalone*.php (isBackupSolutionAvailable),
// app/Policies/DatabasePolicy.php (manageBackups) and bootstrap/helpers/shared.php (validateDatabasesBackupInput,
// validate_cron_expression) (Apache-2.0), modified.
//
// A standalone database's backup schedules — configuration only. Nothing
// runs a schedule (the scheduler and DatabaseBackupJob are not ported), so
// "Back up now" needs the SSH executor, and the executions are read as they
// are, which is none. Deleting a schedule removes its rows; deleting its
// backup files on the server or on S3 is refused while files exist (none can
// before a backup runs).
import type { DatabaseBackupChanges, DeployDatabaseBackupExecutionRow, DeployDatabaseBackupListRow, DeployDatabaseBackupRow, DeployDatabaseRow, NewDatabaseBackup } from "@saas/db/deploy";
import { DATABASE_TABLES, type DatabaseEngine } from "@saas/db/deploy";
import { newPublicId } from "../helpers/names.js";
import { validateCronExpressionStrict as validateCronExpression } from "../helpers/cron.js";
import { validateShellSafePath, ComposeError } from "../services/compose-helpers.js";
import { needsExecutor } from "../applications/resources.js";

export interface BackupStorageOption {
  id: string | number;
  uuid: string;
  name: string;
  is_usable: boolean;
  type: string;
  bucket: string | null;
}

export interface DatabaseBackupStore {
  findDatabase(uuid: string): Promise<DeployDatabaseRow | null>;
  list(databaseType: string, databaseId: string | number): Promise<DeployDatabaseBackupListRow[]>;
  find(databaseType: string, databaseId: string | number, uuid: string): Promise<DeployDatabaseBackupRow | null>;
  insert(backup: Omit<NewDatabaseBackup, "orgId">): Promise<DeployDatabaseBackupRow>;
  update(id: string | number, changes: DatabaseBackupChanges): Promise<DeployDatabaseBackupRow | null>;
  setEnabled(id: string | number, enabled: boolean): Promise<boolean>;
  availableStorages(selectedIds: Array<string | number>): Promise<BackupStorageOption[]>;
  storagesOf(backupIds: Array<string | number>): Promise<Array<{ backup_id: string | number; id: string | number; uuid: string; name: string; type: string; bucket: string | null; is_primary: boolean; legacy: boolean }>>;
  storageIds(backupId: string | number): Promise<string[]>;
  syncStorages(backupId: string | number, storageIds: string[]): Promise<string | number | null>;
  executions(databaseType: string, databaseId: string | number, limit: number): Promise<{ total: number; rows: DeployDatabaseBackupExecutionRow[] }>;
  files(backupId: string | number): Promise<{ localFiles: number; s3Copies: number }>;
  delete(backupId: string | number): Promise<boolean>;
  timezone(serverId: string | number | null): Promise<string | null>;
}

export const BACKUP_MESSAGES = {
  /** CreateScheduledBackup::submit() */
  unsupported: "Scheduled backups are not supported for this database type.",
  invalidCronCreate: "Invalid Cron / Human expression.",
  /** BackupEdit::customValidate() */
  invalidCron: "Invalid Cron / Human expression",
  selectStorage: "Select at least one usable S3 storage.",
  /** BackupEdit::toggleS3() */
  selectStorageFirst: "Select a usable S3 storage before enabling S3 backups.",
  updated: "Backup updated successfully.",
  enabled: "Backup enabled.",
  disabled: "Backup disabled.",
  deleted: "Scheduled backup deleted.",
  /** queueDatabaseBackup() */
  mustBeRunning: "The database must be running to start a backup.",
  backupNow: needsExecutor("Backing up the database"),
  /** DeleteScheduledDatabaseBackup: deleteBackupsLocally() runs on the server; deleting the S3 copies is not ported. */
  deleteLocal: needsExecutor("Deleting the local backup files"),
  deleteS3: "Deleting the backup files from S3 is not available yet.",
  /** BackupEdit's timezone when the server has none. */
  instanceTimezone: "Instance timezone",
} as const;

export class BackupError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    readonly fields: Record<string, string[]> | null = null,
  ) {
    super(message);
  }
}

/** isBackupSolutionAvailable(): false for Redis, KeyDB and Dragonfly. */
export function backupSolutionAvailable(engine: DatabaseEngine): boolean {
  return ["postgresql", "mongodb", "mysql", "mariadb", "clickhouse"].includes(engine);
}

/** What the General section offers for "what to back up", by engine (backup-edit/general.blade.php). */
export function databaseSelection(engine: DatabaseEngine): "dump-all" | "mongodb" | "clickhouse" | null {
  if (engine === "postgresql" || engine === "mysql" || engine === "mariadb") return "dump-all";
  if (engine === "mongodb") return "mongodb";
  if (engine === "clickhouse") return "clickhouse";
  return null;
}

/** CreateScheduledBackup's databases_to_backup: the database the container creates. */
function defaultDatabases(row: DeployDatabaseRow): string | null {
  const column = { postgresql: "postgres_db", mysql: "mysql_database", mariadb: "mariadb_database", clickhouse: "clickhouse_db" }[row.engine as string];
  const value = column ? (row as Record<string, unknown>)[column] : null;
  return typeof value === "string" ? value : null;
}

/** validateDatabasesBackupInput(): every name shell-safe; MongoDB's "db:col1,col2|db2". Throws the helper's message. */
export function validateDatabasesBackupInput(input: string): string {
  try {
    for (const raw of input.split("|")) {
      const entry = raw.trim();
      if (entry === "" || entry === "all" || entry === "*") continue;
      if (entry.includes(":")) {
        validateShellSafePath(entry.slice(0, entry.indexOf(":")), "database name");
        for (const collection of entry.slice(entry.indexOf(":") + 1).split(",")) {
          if (collection.trim() !== "") validateShellSafePath(collection.trim(), "collection name");
        }
      } else {
        for (const db of entry.split(",")) {
          const name = db.trim();
          if (name !== "" && name !== "all" && name !== "*") validateShellSafePath(name, "database name");
        }
      }
    }
  } catch (e) {
    throw new BackupError(e instanceof ComposeError ? e.message : String(e));
  }
  return input;
}

// ------------------------------------------------------------ BackupEdit's #[Validate] rules

type Rule = "required" | "nullable" | "boolean" | "string" | "integer" | "numeric" | "array" | ["min" | "max", number];
/** A Livewire component's rules by property (also the volume backup pages', DP-99). */
export type BackupFieldRules = Record<string, Rule[]>;

/** The rules of BackupEdit's properties, as Coolify declares them ('int' is Laravel's integer). */
const RULES: Record<string, Rule[]> = {
  backupEnabled: ["required", "boolean"],
  frequency: ["required", "string"],
  timezone: ["string"],
  databaseBackupRetentionAmountLocally: ["required", "integer"],
  databaseBackupRetentionDaysLocally: ["required", "integer"],
  databaseBackupRetentionMaxStorageLocally: ["required", "numeric", ["min", 0]],
  databaseBackupRetentionAmountS3: ["required", "integer"],
  databaseBackupRetentionDaysS3: ["required", "integer"],
  databaseBackupRetentionMaxStorageS3: ["required", "numeric", ["min", 0]],
  saveS3: ["required", "boolean"],
  disableLocalBackup: ["required", "boolean"],
  s3StorageIds: ["array"],
  databasesToBackup: ["nullable", "string"],
  dumpAll: ["required", "boolean"],
  timeout: ["required", "integer", ["min", 60], ["max", 36000]],
  missingBackupNotificationDays: ["required", "integer", ["min", 0], ["max", 365]],
};

/** Laravel's attribute name for a property: Str::snake, underscores as spaces. */
export const attributeName = (property: string): string => property.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/_/g, " ");

const isNumeric = (v: unknown): boolean => (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v));
const isInteger = (v: unknown): boolean => (typeof v === "number" && Number.isInteger(v)) || (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v));
const isBlank = (v: unknown): boolean => v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

/** Laravel's validator with these rules and its default messages; all failures of a field, in rule order. */
export function validateBackupFields(data: Record<string, unknown>, ruleSet: BackupFieldRules = RULES): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  for (const [field, rules] of Object.entries(ruleSet)) {
    const v = data[field];
    const a = attributeName(field);
    const add = (m: string) => (errors[field] ??= []).push(m);
    if (rules.includes("required") && isBlank(v)) {
      add(`The ${a} field is required.`);
      continue;
    }
    if (v === undefined || (rules.includes("nullable") && v === null)) continue;
    const numericRule = rules.includes("integer") || rules.includes("numeric");
    for (const rule of rules) {
      if (rule === "boolean" && ![true, false, 0, 1, "0", "1"].includes(v as never)) add(`The ${a} field must be true or false.`);
      if (rule === "string" && typeof v !== "string") add(`The ${a} field must be a string.`);
      if (rule === "integer" && !isInteger(v)) add(`The ${a} field must be an integer.`);
      if (rule === "numeric" && !isNumeric(v)) add(`The ${a} field must be a number.`);
      if (rule === "array" && !Array.isArray(v)) add(`The ${a} field must be an array.`);
      if (Array.isArray(rule)) {
        // getSize(): the number for a numeric value under a numeric rule, else the string's length.
        const size = numericRule && isNumeric(v) ? Number(v) : typeof v === "string" ? [...v].length : Array.isArray(v) ? v.length : Number(v);
        if (rule[0] === "min" && size < rule[1]) add(`The ${a} field must be at least ${rule[1]}.`);
        if (rule[0] === "max" && size > rule[1]) add(`The ${a} field must not be greater than ${rule[1]}.`);
      }
    }
  }
  return errors;
}

/** Laravel's ValidationException message: the first error, and how many more. */
export function validationSummary(errors: Record<string, string[]>): string {
  const all = Object.values(errors).flat();
  const more = all.length - 1;
  return more > 0 ? `${all[0]} (and ${more} more ${more === 1 ? "error" : "errors"})` : (all[0] ?? "");
}

// ------------------------------------------------------------ the pages' data

export interface BackupListItem {
  uuid: string;
  frequency: string;
  enabled: boolean;
  saveS3: boolean;
  /** The schedule's storages (the pivot's, else its legacy s3_storage_id). */
  storages: Array<{ uuid: string; name: string; label: string }>;
  latestStatus: string | null;
  latestFinishedAt: string | null;
  executionsCount: number;
}

export interface BackupExecution {
  uuid: string;
  backupUuid: string;
  schedule: string;
  status: string;
  databaseName: string | null;
  size: number | null;
  filename: string | null;
  message: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  s3Uploaded: boolean | null;
}

const iso = (v: string | Date | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : `${v.replace(" ", "T")}Z`);

async function loadDatabase(store: DatabaseBackupStore, uuid: string): Promise<{ row: DeployDatabaseRow; type: string } | null> {
  const row = await store.findDatabase(uuid);
  return row ? { row, type: DATABASE_TABLES[row.engine].morphClass } : null;
}

/** Backup/Index + ScheduledBackups + ExecutionHistory. */
export async function listBackups(store: DatabaseBackupStore, uuid: string) {
  const db = await loadDatabase(store, uuid);
  if (!db) return null;
  const { row } = db;
  const database = { uuid: row.uuid, name: row.name, status: row.status, engine: row.engine, projectUuid: row.project_uuid, environmentUuid: row.environment_uuid };
  if (!backupSolutionAvailable(row.engine)) return { available: false, database, backups: [], scheduleCount: 0, enabledScheduleCount: 0, executionCount: 0, executions: { total: 0, rows: [] } };
  const rows = await store.list(db.type, row.id);
  const storages = rows.length ? await store.storagesOf(rows.map((b) => b.id)) : [];
  const backups: BackupListItem[] = rows.map((b) => ({
    uuid: b.uuid,
    frequency: b.frequency,
    enabled: b.enabled,
    saveS3: b.save_s3,
    storages: storages
      .filter((s) => String(s.backup_id) === String(b.id))
      .map((s) => ({ uuid: s.uuid, name: s.name, label: `${s.name} (${s.type === "s3" ? `bucket: ${s.bucket ?? ""}` : s.type})` })),
    latestStatus: b.latest_status,
    latestFinishedAt: iso(b.latest_finished_at),
    executionsCount: Number(b.executions_count),
  }));
  const executions = await store.executions(db.type, row.id, 10);
  return {
    available: true,
    database,
    backups,
    scheduleCount: backups.length,
    enabledScheduleCount: backups.filter((b) => b.enabled).length,
    executionCount: backups.reduce((n, b) => n + b.executionsCount, 0),
    executions: {
      total: executions.total,
      rows: executions.rows.map(
        (x): BackupExecution => ({
          uuid: x.uuid,
          backupUuid: x.backup_uuid,
          schedule: x.frequency,
          status: x.status,
          databaseName: x.database_name,
          size: x.size === null ? null : Number(x.size),
          filename: x.filename,
          message: x.message,
          startedAt: iso(x.created_at),
          finishedAt: iso(x.finished_at),
          s3Uploaded: x.s3_uploaded,
        }),
      ),
    },
  };
}

/** CreateScheduledBackup::submit() for a standalone database. */
export async function createBackup(store: DatabaseBackupStore, uuid: string, body: Record<string, unknown>): Promise<{ uuid: string } | null> {
  const db = await loadDatabase(store, uuid);
  if (!db) return null;
  if (!backupSolutionAvailable(db.row.engine)) throw new BackupError(BACKUP_MESSAGES.unsupported);
  const frequency = body.frequency;
  if (isBlank(frequency)) throw new BackupError("The frequency field is required.", 422, { frequency: ["The frequency field is required."] });
  if (typeof frequency !== "string") throw new BackupError("The frequency field must be a string.", 422, { frequency: ["The frequency field must be a string."] });
  if (!validateCronExpression(frequency)) throw new BackupError(BACKUP_MESSAGES.invalidCronCreate);
  const created = await store.insert({ uuid: newPublicId(), frequency, databaseType: db.type, databaseId: db.row.id, databasesToBackup: defaultDatabases(db.row) });
  return { uuid: created.uuid };
}

async function loadBackup(store: DatabaseBackupStore, uuid: string, backupUuid: string) {
  const db = await loadDatabase(store, uuid);
  if (!db || !backupSolutionAvailable(db.row.engine)) return null;
  const backup = await store.find(db.type, db.row.id, backupUuid);
  return backup ? { ...db, backup } : null;
}

/** BackupEdit::availableS3StorageIds(): the usable storages and the schedule's own. */
async function available(store: DatabaseBackupStore, backup: DeployDatabaseBackupRow) {
  const selected = await store.storageIds(backup.id);
  return { selected, options: await store.availableStorages(selected) };
}

export interface BackupDetail {
  uuid: string;
  frequency: string;
  backupEnabled: boolean;
  timezone: string;
  databaseBackupRetentionAmountLocally: number;
  databaseBackupRetentionDaysLocally: number;
  databaseBackupRetentionMaxStorageLocally: number;
  databaseBackupRetentionAmountS3: number;
  databaseBackupRetentionDaysS3: number;
  databaseBackupRetentionMaxStorageS3: number;
  saveS3: boolean;
  disableLocalBackup: boolean;
  /** Selected destinations; with none, the first available one (syncData()). */
  s3StorageUuids: string[];
  databasesToBackup: string | null;
  dumpAll: boolean;
  timeout: number;
  missingBackupNotificationDays: number;
  availableS3Storages: Array<{ uuid: string; name: string; isUsable: boolean }>;
  /** The database's status (Back up now needs it running). */
  status: string;
  databaseName: string;
  selection: ReturnType<typeof databaseSelection>;
}

/** BackupEdit::mount() / syncData(). */
export async function showBackup(store: DatabaseBackupStore, uuid: string, backupUuid: string): Promise<BackupDetail | null> {
  const found = await loadBackup(store, uuid, backupUuid);
  if (!found) return null;
  const { backup: b, row } = found;
  const { selected, options } = await available(store, b);
  const byId = new Map(options.map((o) => [String(o.id), o.uuid]));
  const chosen = selected.length ? selected : options.slice(0, 1).map((o) => String(o.id));
  return {
    uuid: b.uuid,
    frequency: b.frequency,
    backupEnabled: b.enabled,
    timezone: (await store.timezone(row.server_id)) ?? BACKUP_MESSAGES.instanceTimezone,
    databaseBackupRetentionAmountLocally: b.database_backup_retention_amount_locally,
    databaseBackupRetentionDaysLocally: b.database_backup_retention_days_locally,
    databaseBackupRetentionMaxStorageLocally: Number(b.database_backup_retention_max_storage_locally),
    databaseBackupRetentionAmountS3: b.database_backup_retention_amount_s3,
    databaseBackupRetentionDaysS3: b.database_backup_retention_days_s3,
    databaseBackupRetentionMaxStorageS3: Number(b.database_backup_retention_max_storage_s3),
    saveS3: b.save_s3,
    disableLocalBackup: b.disable_local_backup,
    s3StorageUuids: chosen.map((id) => byId.get(id)).filter((u): u is string => u !== undefined),
    databasesToBackup: b.databases_to_backup,
    dumpAll: b.dump_all,
    timeout: b.timeout,
    missingBackupNotificationDays: b.missing_backup_notification_days,
    availableS3Storages: options.map((o) => ({ uuid: o.uuid, name: o.name, isUsable: o.is_usable })),
    status: row.status,
    databaseName: row.name,
    selection: databaseSelection(row.engine),
  };
}

const toInt = (v: unknown): number => Math.trunc(Number(v));
const toBool = (v: unknown): boolean => v === true || v === 1 || v === "1";

/**
 * BackupEdit::submit() / instantSave(), and toggleS3() with `toggleS3`: the
 * form's properties (missing ones keep the stored value), the databases
 * checked first, then customValidate() — the destinations, the local copy,
 * the cron expression, the rules — then the row and its destinations.
 */
export async function saveBackup(store: DatabaseBackupStore, uuid: string, backupUuid: string, body: Record<string, unknown>, toggleS3 = false): Promise<{ backup: BackupDetail; message: string } | null> {
  const current = await showBackup(store, uuid, backupUuid);
  const found = await loadBackup(store, uuid, backupUuid);
  if (!current || !found) return null;
  const form: Record<string, unknown> = { ...current, ...body };
  const { options } = await available(store, found.backup);
  const uuidsToIds = new Map(options.map((o) => [o.uuid, String(o.id)]));
  const requested = Array.isArray(form.s3StorageUuids) ? (form.s3StorageUuids as unknown[]) : [];
  const storageIds = [...new Set(requested.map((u) => uuidsToIds.get(String(u))).filter((id): id is string => id !== undefined))];

  if (toggleS3) {
    if (!toBool(form.saveS3) && storageIds.length === 0) throw new BackupError(BACKUP_MESSAGES.selectStorageFirst);
    form.saveS3 = !toBool(form.saveS3);
    form.disableLocalBackup = toBool(form.saveS3) && toBool(form.disableLocalBackup);
  }
  // syncData(true): databases_to_backup is checked before anything else.
  if (typeof form.databasesToBackup === "string" && form.databasesToBackup.trim() !== "") validateDatabasesBackupInput(form.databasesToBackup);
  // customValidate()
  let saveS3 = toBool(form.saveS3);
  if (options.length === 0) saveS3 = false;
  else if (saveS3 && storageIds.length === 0) throw new BackupError(BACKUP_MESSAGES.selectStorage, 422, { s3StorageIds: [BACKUP_MESSAGES.selectStorage] });
  let disableLocal = toBool(form.disableLocalBackup);
  if (disableLocal && !saveS3) disableLocal = false;
  if (typeof form.frequency !== "string" || !validateCronExpression(form.frequency)) throw new BackupError(BACKUP_MESSAGES.invalidCron);
  const errors = validateBackupFields({ ...form, saveS3, disableLocalBackup: disableLocal, s3StorageIds: form.s3StorageUuids ?? [] });
  if (Object.keys(errors).length) throw new BackupError(validationSummary(errors), 422, errors);

  await store.update(found.backup.id, {
    enabled: toBool(form.backupEnabled),
    frequency: form.frequency,
    databaseBackupRetentionAmountLocally: toInt(form.databaseBackupRetentionAmountLocally),
    databaseBackupRetentionDaysLocally: toInt(form.databaseBackupRetentionDaysLocally),
    databaseBackupRetentionMaxStorageLocally: Number(form.databaseBackupRetentionMaxStorageLocally),
    databaseBackupRetentionAmountS3: toInt(form.databaseBackupRetentionAmountS3),
    databaseBackupRetentionDaysS3: toInt(form.databaseBackupRetentionDaysS3),
    databaseBackupRetentionMaxStorageS3: Number(form.databaseBackupRetentionMaxStorageS3),
    saveS3,
    disableLocalBackup: disableLocal,
    databasesToBackup: typeof form.databasesToBackup === "string" ? form.databasesToBackup : null,
    dumpAll: toBool(form.dumpAll),
    timeout: toInt(form.timeout),
    missingBackupNotificationDays: toInt(form.missingBackupNotificationDays),
  });
  await store.syncStorages(found.backup.id, storageIds);
  return { backup: (await showBackup(store, uuid, backupUuid))!, message: BACKUP_MESSAGES.updated };
}

/** toggleDatabaseBackup(). */
export async function toggleBackup(store: DatabaseBackupStore, uuid: string, backupUuid: string): Promise<{ enabled: boolean; message: string } | null> {
  const found = await loadBackup(store, uuid, backupUuid);
  if (!found) return null;
  const enabled = !found.backup.enabled;
  await store.setEnabled(found.backup.id, enabled);
  return { enabled, message: enabled ? BACKUP_MESSAGES.enabled : BACKUP_MESSAGES.disabled };
}

/** backupNow() / queueDatabaseBackup(): the database must run; the job needs the SSH executor. */
export async function backupNow(store: DatabaseBackupStore, uuid: string, backupUuid: string): Promise<null> {
  const found = await loadBackup(store, uuid, backupUuid);
  if (!found) return null;
  if (!found.row.status.startsWith("running")) throw new BackupError(BACKUP_MESSAGES.mustBeRunning);
  throw new BackupError(BACKUP_MESSAGES.backupNow, 501);
}

/** BackupEdit::delete() → DeleteScheduledDatabaseBackup: the files first when asked (local, then S3), then the rows. */
export async function deleteBackup(store: DatabaseBackupStore, uuid: string, backupUuid: string, options: { local: boolean; s3: boolean }): Promise<{ deleted: true; message: string } | null> {
  const found = await loadBackup(store, uuid, backupUuid);
  if (!found) return null;
  const files = await store.files(found.backup.id);
  if (options.local && files.localFiles > 0) throw new BackupError(BACKUP_MESSAGES.deleteLocal, 501);
  if (options.s3 && files.s3Copies > 0) throw new BackupError(BACKUP_MESSAGES.deleteS3, 501);
  await store.delete(found.backup.id);
  return { deleted: true, message: BACKUP_MESSAGES.deleted };
}
