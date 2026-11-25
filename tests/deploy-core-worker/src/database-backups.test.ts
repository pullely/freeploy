// A standalone database's backup schedules (DP-65), configuration only:
// BackupEdit's rules with Laravel's messages, validateDatabasesBackupInput()
// and validate_cron_expression() against what Coolify's PHP answers
// (fixtures/s3/goldens.json, emitted by fixtures/s3/emit.php), and the
// handler — routing through handleDatabases, authorization, create, edit,
// the S3 destinations, enable / disable, Back up now, delete — on a memory
// store. The SQL is tested in tests/db.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "@deploy-core-worker/env";
import { handleDatabases } from "@deploy-core-worker/handlers/databases";
import type { DatabaseBackupRunner } from "@deploy-core-worker/handlers/database-backups";
import { handleDatabaseBackups } from "@deploy-core-worker/handlers/database-backups";
import { attributeName, backupSolutionAvailable, validateBackupFields, validateDatabasesBackupInput, validationSummary, type BackupStorageOption, type DatabaseBackupStore } from "@deploy-core-worker/databases/backups";
import { validateCronExpressionStrict as validateCronExpression } from "@deploy-core-worker/helpers/cron";
import { DATABASE_TABLES, type DatabaseBackupChanges, type DatabaseEngine, type DeployDatabaseBackupRow, type DeployDatabaseRow } from "@saas/db/deploy";

interface Goldens {
  backupRules: Array<Record<string, string[]>>;
  backupValidation: Array<{ input: Record<string, unknown>; errors: Record<string, string[]> | []; exception: string | null }>;
  databasesToBackup: Array<{ value: string; error: string | null }>;
  cron: Array<{ value: string; valid: boolean }>;
}
const dir = join(process.cwd(), "fixtures", "s3");
const goldens = JSON.parse(readFileSync(join(dir, "goldens.json"), "utf8")) as Goldens;
const cases = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")) as { backupValidationBase: Record<string, unknown> };

describe("BackupEdit's rules, as Laravel applies them", () => {
  it("are the component's #[Validate] rules", () => {
    expect(Object.keys(goldens.backupRules[0]!)).toEqual(expect.arrayContaining(["frequency", "timeout", "missingBackupNotificationDays", "databaseBackupRetentionMaxStorageS3"]));
    expect(goldens.backupRules[0]!.timeout).toEqual(["required", "int", "min:60", "max:36000"]);
  });
  it.each(goldens.backupValidation.map((g, i) => [i, JSON.stringify(g.input)] as const))("#%i %s", (i) => {
    const g = goldens.backupValidation[i]!;
    expect(g.exception).toBeNull();
    expect(validateBackupFields({ ...cases.backupValidationBase, ...g.input })).toEqual(Array.isArray(g.errors) ? {} : g.errors);
  });
  it("names attributes as Str::snake does, and sums up as ValidationException does", () => {
    expect(["databaseBackupRetentionMaxStorageS3", "s3StorageIds", "timeout"].map(attributeName)).toEqual(["database backup retention max storage s3", "s3 storage ids", "timeout"]);
    expect(validationSummary({ a: ["x", "y"], b: ["z"] })).toBe("x (and 2 more errors)");
    expect(validationSummary({ a: ["x", "y"] })).toBe("x (and 1 more error)");
  });
});

describe("validateDatabasesBackupInput() and validate_cron_expression()", () => {
  it.each(goldens.databasesToBackup.map((g) => g.value))("%j", (value) => {
    const g = goldens.databasesToBackup.find((x) => x.value === value)!;
    let error: string | null = null;
    try {
      validateDatabasesBackupInput(value);
    } catch (e) {
      error = (e as Error).message;
    }
    expect(error).toBe(g.error);
  });
  it.each(goldens.cron.map((g) => g.value))("%j", (value) => {
    expect(validateCronExpression(value)).toBe(goldens.cron.find((x) => x.value === value)!.valid);
  });
});

// ------------------------------------------------------------ the handler

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy/databases`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

function database(engine: DatabaseEngine, uuid: string, id: number, over: Record<string, unknown> = {}): DeployDatabaseRow {
  return {
    engine, id, uuid, name: `${engine}-database-${uuid}`, description: null, status: "exited", image: "x", is_public: false, public_port: null, public_port_timeout: 3600,
    ports_mappings: null, started_at: null, destination_id: 1, destination_type: "x", environment_id: 1, is_log_drain_enabled: false, config_hash: null,
    custom_docker_run_options: null, last_online_at: null, created_at: null, updated_at: null, enable_ssl: null, ssl_mode: null, legacy_password_quoting: null,
    environment_uuid: "env1", environment_name: "production", project_uuid: "prj1", project_name: "p", destination_uuid: "dst1", destination_name: "d", destination_network: "coolify",
    server_id: 7, server_uuid: "srv1", server_name: "s", server_ip: "203.0.113.1", server_is_swarm_manager: false, server_is_swarm_worker: false, server_is_reachable: true,
    server_is_usable: true, server_force_disabled: false, server_is_logdrain_newrelic_enabled: false, server_is_logdrain_axiom_enabled: false, server_is_logdrain_custom_enabled: false,
    server_is_logdrain_cloudwatch_enabled: false, postgres_db: "postgres", mysql_database: "default", ...over,
  } as DeployDatabaseRow;
}

class MemoryStore implements DatabaseBackupStore {
  databases = [database("postgresql", "pg1", 1), database("redis", "rd1", 2), database("mongodb", "mg1", 3), database("mysql", "my1", 4, { status: "running:healthy" })];
  backups: Array<DeployDatabaseBackupRow & { storageIds: string[] }> = [];
  storages: BackupStorageOption[] = [
    { id: 1, uuid: "st-a", name: "Alpha", is_usable: true, type: "s3", bucket: "a" },
    { id: 2, uuid: "st-b", name: "Beta", is_usable: false, type: "s3", bucket: "b" },
  ];
  stored = { localFiles: 0, s3Copies: 0 };
  private next = 1;
  async findDatabase(uuid: string) {
    return this.databases.find((d) => d.uuid === uuid) ?? null;
  }
  async list(type: string, id: string | number) {
    return this.backups.filter((b) => b.database_type === type && b.database_id === id).map((b) => ({ ...b, executions_count: 0, latest_status: null, latest_finished_at: null }));
  }
  async find(type: string, id: string | number, uuid: string) {
    return this.backups.find((b) => b.database_type === type && b.database_id === id && b.uuid === uuid) ?? null;
  }
  async insert(b: { uuid: string; frequency: string; databaseType: string; databaseId: string | number; databasesToBackup: string | null }) {
    const row = {
      id: this.next++, uuid: b.uuid, description: null, enabled: true, save_s3: false, frequency: b.frequency, database_id: b.databaseId, database_type: b.databaseType, s3_storage_id: null,
      databases_to_backup: b.databasesToBackup, dump_all: false, database_backup_retention_amount_locally: 0, database_backup_retention_days_locally: 0,
      database_backup_retention_max_storage_locally: "0", database_backup_retention_amount_s3: 0, database_backup_retention_days_s3: 0, database_backup_retention_max_storage_s3: "0",
      timeout: 3600, disable_local_backup: false, missing_backup_notification_days: 0, last_execution_at: null, created_at: null, updated_at: null, storageIds: [] as string[],
    };
    this.backups.push(row);
    return row;
  }
  async update(id: string | number, c: DatabaseBackupChanges) {
    const b = this.backups.find((x) => x.id === id)!;
    Object.assign(b, {
      enabled: c.enabled, frequency: c.frequency, database_backup_retention_amount_locally: c.databaseBackupRetentionAmountLocally, database_backup_retention_days_locally: c.databaseBackupRetentionDaysLocally,
      database_backup_retention_max_storage_locally: String(c.databaseBackupRetentionMaxStorageLocally), database_backup_retention_amount_s3: c.databaseBackupRetentionAmountS3,
      database_backup_retention_days_s3: c.databaseBackupRetentionDaysS3, database_backup_retention_max_storage_s3: String(c.databaseBackupRetentionMaxStorageS3), save_s3: c.saveS3,
      disable_local_backup: c.disableLocalBackup, databases_to_backup: c.databasesToBackup, dump_all: c.dumpAll, timeout: c.timeout, missing_backup_notification_days: c.missingBackupNotificationDays,
    });
    return b;
  }
  async setEnabled(id: string | number, enabled: boolean) {
    this.backups.find((x) => x.id === id)!.enabled = enabled;
    return true;
  }
  async availableStorages(selected: Array<string | number>) {
    return this.storages.filter((s) => s.is_usable || selected.map(String).includes(String(s.id)));
  }
  async storagesOf(ids: Array<string | number>) {
    return this.backups
      .filter((b) => ids.includes(b.id))
      .flatMap((b) => b.storageIds.map((sid) => ({ ...this.storages.find((s) => String(s.id) === sid)!, backup_id: b.id, is_primary: sid === b.storageIds[0], legacy: false })));
  }
  async storageIds(id: string | number) {
    return this.backups.find((x) => x.id === id)!.storageIds;
  }
  async syncStorages(id: string | number, ids: string[]) {
    this.backups.find((x) => x.id === id)!.storageIds = ids;
    return ids[0] ?? null;
  }
  async executions() {
    return { total: 0, rows: [] };
  }
  async files() {
    return this.stored;
  }
  async delete(id: string | number) {
    this.backups = this.backups.filter((b) => b.id !== id);
    return true;
  }
  async timezone(serverId: string | number | null) {
    return serverId === 7 ? "Europe/Berlin" : null;
  }
}

type Body = { data?: Record<string, unknown>; error?: { code: string; message: string; details: { fields?: Record<string, string[]> } } };

function setup(opts: { write?: boolean; read?: boolean } = {}) {
  const store = new MemoryStore();
  const env: Env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      const allow = body.action === "deploy.resource.write" ? (opts.write ?? true) : (opts.read ?? true);
      return json({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
  };
  const runner: DatabaseBackupRunner = async (_env, _org, fn) => fn(store);
  const call = async (method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const url = `${BASE}/${path}`;
    const res = await handleDatabaseBackups(env, "req_1", actor, ORG_UUID, new URL(url).pathname.split("/").slice(6).filter(Boolean), new Request(url, init), runner);
    return { status: res.status, body: (await res.json()) as Body };
  };
  return { store, env, call };
}

const PG = DATABASE_TABLES.postgresql.morphClass;

describe("GET and POST /databases/{uuid}/backups", () => {
  it("creates a schedule as CreateScheduledBackup does: enabled, no S3, the database the container creates", async () => {
    const t = setup();
    const r = await t.call("POST", "pg1/backups", { frequency: "daily" });
    expect(r.status).toBe(201);
    const b = t.store.backups[0]!;
    expect(r.body.data).toEqual({ uuid: b.uuid });
    expect(b).toMatchObject({ frequency: "daily", enabled: true, save_s3: false, database_type: PG, database_id: 1, databases_to_backup: "postgres" });
    const list = await t.call("GET", "pg1/backups");
    expect(list.body.data).toMatchObject({
      available: true, scheduleCount: 1, enabledScheduleCount: 1, executionCount: 0, executions: { total: 0, rows: [] }, canManageBackups: true,
      backups: [{ uuid: b.uuid, frequency: "daily", enabled: true, saveS3: false, storages: [], latestStatus: null, executionsCount: 0 }],
      database: { uuid: "pg1", projectUuid: "prj1", environmentUuid: "env1", engine: "postgresql" },
    });
    // MongoDB: nothing to name. MySQL: its database.
    await t.call("POST", "mg1/backups", { frequency: "0 3 * * *" });
    await t.call("POST", "my1/backups", { frequency: "@weekly" });
    expect(t.store.backups.map((x) => x.databases_to_backup)).toEqual(["postgres", null, "default"]);
  });
  it("refuses what Coolify refuses", async () => {
    const t = setup();
    expect((await t.call("POST", "pg1/backups", { frequency: "" })).body.error).toMatchObject({ message: "The frequency field is required.", details: { fields: { frequency: ["The frequency field is required."] } } });
    expect((await t.call("POST", "pg1/backups", { frequency: "every 5 minutes" })).body.error!.message).toBe("Invalid Cron / Human expression.");
    expect((await t.call("POST", "rd1/backups", { frequency: "daily" })).body.error!.message).toBe("Scheduled backups are not supported for this database type.");
    expect((await t.call("GET", "rd1/backups")).body.data).toMatchObject({ available: false, backups: [] });
    expect((await t.call("POST", "nope/backups", { frequency: "daily" })).status).toBe(404);
    expect(t.store.backups).toEqual([]);
    expect(backupSolutionAvailable("keydb") || backupSolutionAvailable("dragonfly")).toBe(false);
  });
  it("needs deploy.resource.write to create, read to list; a denial answers 404", async () => {
    expect((await setup({ write: false }).call("POST", "pg1/backups", { frequency: "daily" })).status).toBe(404);
    expect((await setup({ read: false }).call("GET", "pg1/backups")).status).toBe(404);
    const reader = await setup({ write: false }).call("GET", "pg1/backups");
    expect(reader.body.data).toMatchObject({ canManageBackups: false, canUpdate: false });
  });
});

async function withBackup() {
  const t = setup();
  const uuid = ((await t.call("POST", "pg1/backups", { frequency: "daily" })).body.data as { uuid: string }).uuid;
  return { ...t, uuid };
}

describe("GET and PATCH /databases/{uuid}/backups/{backup}", () => {
  it("reads the schedule as BackupEdit::syncData() does: the first usable storage offered, the server's timezone", async () => {
    const t = await withBackup();
    const r = await t.call("GET", `pg1/backups/${t.uuid}`);
    expect(r.body.data!.backup).toMatchObject({
      frequency: "daily", backupEnabled: true, timezone: "Europe/Berlin", saveS3: false, s3StorageUuids: ["st-a"], availableS3Storages: [{ uuid: "st-a", name: "Alpha", isUsable: true }],
      databasesToBackup: "postgres", dumpAll: false, timeout: 3600, selection: "dump-all", status: "exited",
    });
  });
  it("saves the form, checks the databases first, then the destinations, the cron expression, the rules", async () => {
    const t = await withBackup();
    const path = `pg1/backups/${t.uuid}`;
    expect((await t.call("PATCH", path, { databasesToBackup: "app;drop" })).body.error!.message).toBe(
      "Invalid database name: contains forbidden character ';' (command separator). Shell metacharacters are not allowed for security reasons.",
    );
    expect((await t.call("PATCH", path, { saveS3: true, s3StorageUuids: [] })).body.error).toMatchObject({ message: "Select at least one usable S3 storage.", details: { fields: { s3StorageIds: ["Select at least one usable S3 storage."] } } });
    expect((await t.call("PATCH", path, { frequency: "61 * * * *" })).body.error!.message).toBe("Invalid Cron / Human expression");
    const bad = await t.call("PATCH", path, { timeout: 30, missingBackupNotificationDays: 400 });
    expect(bad.body.error).toMatchObject({ message: "The timeout field must be at least 60. (and 1 more error)", details: { fields: { timeout: ["The timeout field must be at least 60."], missingBackupNotificationDays: ["The missing backup notification days field must not be greater than 365."] } } });
    expect(t.store.backups[0]).toMatchObject({ timeout: 3600, save_s3: false });
    const ok = await t.call("PATCH", path, { frequency: "0 2 * * *", timeout: "7200", databaseBackupRetentionAmountS3: 5, databaseBackupRetentionMaxStorageLocally: 2.5, saveS3: true, s3StorageUuids: ["st-a", "st-zzz"], disableLocalBackup: true, dumpAll: true });
    expect(ok.body.data!.message).toBe("Backup updated successfully.");
    expect(t.store.backups[0]).toMatchObject({ frequency: "0 2 * * *", timeout: 7200, database_backup_retention_amount_s3: 5, database_backup_retention_max_storage_locally: "2.5", save_s3: true, disable_local_backup: true, dump_all: true, storageIds: ["1"] });
    // The local copy can only go when S3 keeps one.
    await t.call("PATCH", path, { saveS3: false, disableLocalBackup: true, s3StorageUuids: ["st-a"] });
    expect(t.store.backups[0]).toMatchObject({ save_s3: false, disable_local_backup: false });
  });
  it("toggles S3 and the schedule", async () => {
    const t = await withBackup();
    const path = `pg1/backups/${t.uuid}`;
    expect((await t.call("PATCH", path, { action: "toggleS3", s3StorageUuids: [] })).body.error!.message).toBe("Select a usable S3 storage before enabling S3 backups.");
    expect((await t.call("PATCH", path, { action: "toggleS3", s3StorageUuids: ["st-a"] })).status).toBe(200);
    expect(t.store.backups[0]).toMatchObject({ save_s3: true, storageIds: ["1"] });
    expect((await t.call("PATCH", path, { action: "toggleEnabled" })).body.data).toEqual({ enabled: false, message: "Backup disabled." });
    expect((await t.call("PATCH", path, { action: "toggleEnabled" })).body.data).toEqual({ enabled: true, message: "Backup enabled." });
    expect((await t.call("PATCH", path, { action: "nope" })).status).toBe(422);
    // An unusable storage the schedule already has stays selectable.
    t.store.storages[0]!.is_usable = false;
    expect(((await t.call("GET", path)).body.data!.backup as { availableS3Storages: unknown[] }).availableS3Storages).toEqual([{ uuid: "st-a", name: "Alpha", isUsable: false }]);
  });
  it("Back up now: the database must run; then the job needs the SSH executor", async () => {
    const t = await withBackup();
    expect((await t.call("POST", `pg1/backups/${t.uuid}`)).body.error!.message).toBe("The database must be running to start a backup.");
    const my = ((await t.call("POST", "my1/backups", { frequency: "daily" })).body.data as { uuid: string }).uuid;
    const r = await t.call("POST", `my1/backups/${my}`);
    expect([r.status, r.body.error!.message]).toEqual([501, "Backing up the database needs the SSH executor, which is not available yet."]);
  });
});

describe("DELETE /databases/{uuid}/backups/{backup}", () => {
  it("deletes the schedule; deleting files that exist is not available yet", async () => {
    const t = await withBackup();
    t.store.stored = { localFiles: 1, s3Copies: 1 };
    const local = await t.call("DELETE", `pg1/backups/${t.uuid}?delete_associated_backups_locally=1`);
    expect([local.status, local.body.error!.message]).toEqual([501, "Deleting the local backup files needs the SSH executor, which is not available yet."]);
    expect((await t.call("DELETE", `pg1/backups/${t.uuid}?delete_associated_backups_s3=true`)).body.error!.message).toBe("Deleting the backup files from S3 is not available yet.");
    expect(t.store.backups.length).toBe(1);
    expect((await t.call("DELETE", `pg1/backups/${t.uuid}`)).body.data).toEqual({ deleted: true, message: "Scheduled backup deleted." });
    expect(t.store.backups).toEqual([]);
    expect((await t.call("DELETE", `pg1/backups/${t.uuid}`)).status).toBe(404);
  });
});

describe("routing", () => {
  it("handleDatabases sends …/backups here; the database's own routes stay its", async () => {
    const t = setup({ read: false });
    const r = await handleDatabases(t.env, "req_1", actor, ORG_UUID, ["pg1", "backups"], new Request(`${BASE}/pg1/backups`));
    expect(r.status).toBe(404);
    expect((await handleDatabases(t.env, "req_1", actor, ORG_UUID, ["pg1", "backups", "b1"], new Request(`${BASE}/pg1/backups/b1`, { method: "PUT" }))).status).toBe(405);
    expect((await t.call("GET", "pg1/backups/b1/x")).status).toBe(404);
  });
});
