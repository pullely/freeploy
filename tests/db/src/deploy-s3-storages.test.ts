// deploy.s3_storages and the database backup schedules (DP-65) against a real
// Postgres: the store functions of @saas/db/deploy inside withOrg() — a
// storage's key and secret stored as ciphertexts of the org, the list by
// name, the status update, the backup count and the delete with what
// S3Storage::detachFromBackups() does to the schedules and replicas that use
// the storage; a schedule's row as CreateScheduledBackup leaves it, its
// update, its destinations (the pivot and the legacy s3_storage_id), its
// executions (read only), its delete, and the database delete removing
// schedules made here; row-level security keeping each org's rows to itself.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  loadKek,
  orgDek,
  encryptField,
  decryptField,
  isEncrypted,
  isEncryptedColumn,
  insertPrivateKey,
  insertServer,
  insertProject,
  listServerDestinations,
  insertDatabase,
  deleteDatabase,
  DATABASE_TABLES,
  listS3Storages,
  findS3StorageByUuid,
  findS3StorageById,
  insertS3Storage,
  updateS3Storage,
  setS3StorageUsable,
  s3StorageBackupCount,
  syncScheduleS3Storages,
  deleteS3Storage,
  listS3StorageDatabaseBackups,
  databaseBackupStorageIds,
  disableDatabaseBackupS3,
  listDatabaseBackups,
  findDatabaseBackup,
  insertDatabaseBackup,
  updateDatabaseBackup,
  setDatabaseBackupEnabled,
  availableBackupS3Storages,
  databaseBackupStorages,
  listDatabaseBackupExecutions,
  databaseBackupFiles,
  deleteDatabaseBackup,
  serverTimezone,
  type NewS3Storage,
  type DatabaseBackupChanges,
} from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, executor, TEST_KEK as KEK } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const PG = DATABASE_TABLES.postgresql.morphClass;

let db: PGlite;
let ex: TransactionalSqlExecutor;
const admin = (sql: string, params: unknown[] = []) => asPlatformAdmin(ex, (tx) => tx.execute<Record<string, unknown>>(sql, params));
const count = async (table: string, where: string, params: unknown[] = []) => Number((await admin(`SELECT count(*) AS n FROM deploy.${table} WHERE ${where}`, params)).rows[0]!.n);
const row = async (table: string, where: string, params: unknown[] = []) => (await admin(`SELECT * FROM deploy.${table} WHERE ${where}`, params)).rows[0]!;

interface Fixture {
  serverId: string | number;
  databaseId: string | number;
  databaseUuid: string;
  environmentUuid: string;
  projectUuid: string;
}
const fx: Record<string, Fixture> = {};

async function fixture(org: string, tag: string): Promise<Fixture> {
  return withOrg(ex, org, async (tx) => {
    const key = await insertPrivateKey(tx, { orgId: org, uuid: `key${tag}`, name: "key", description: null, privateKey: "fp1:fake", fingerprint: null });
    const server = await insertServer(tx, {
      orgId: org, uuid: `srv${tag}`, name: `server-${tag}`, description: null, ip: "203.0.113.10", user: "root", port: 22, privateKeyId: key.id,
      proxy: {}, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: `dst${tag}`,
    });
    const destination = (await listServerDestinations(tx, server.id))[0]!;
    const { environment } = await insertProject(tx, { orgId: org, uuid: `prj${tag}`, name: `project-${tag}`, description: null, productionEnvironmentUuid: `env${tag}` });
    const database = await insertDatabase(tx, "postgresql", {
      orgId: org, uuid: `pg${tag}`, name: `postgresql-database-${tag}`, environmentId: environment.id, destinationId: destination.id, destinationType: "standalone",
      values: { postgres_password: "fp1:1:x", postgres_db: "postgres", postgres_user: "postgres", image: "postgres:18-alpine" }, volumes: [],
    });
    return { serverId: server.id, databaseId: database.id, databaseUuid: `pg${tag}`, environmentUuid: `env${tag}`, projectUuid: `prj${tag}` };
  });
}

async function addStorage(org: string, uuid: string, name: string, over: Partial<NewS3Storage> = {}) {
  return withOrg(ex, org, async (tx) => {
    const dek = await orgDek(tx, org, await loadKek(KEK));
    return insertS3Storage(tx, {
      orgId: org, uuid, type: "s3", name, description: null, region: "us-east-1",
      key: await encryptField(dek, "s3_storages.key", "AKIDEXAMPLE"), secret: await encryptField(dek, "s3_storages.secret", `secret-${name}`),
      bucket: "backups", endpoint: "https://s3.example.com", usePathStyleEndpoint: true, skipTlsVerification: false, isUsable: true, unusableEmailSent: false,
      ...over,
    });
  });
}

const CHANGES: DatabaseBackupChanges = {
  enabled: true, frequency: "0 3 * * *", databaseBackupRetentionAmountLocally: 7, databaseBackupRetentionDaysLocally: 0, databaseBackupRetentionMaxStorageLocally: 1.5,
  databaseBackupRetentionAmountS3: 30, databaseBackupRetentionDaysS3: 90, databaseBackupRetentionMaxStorageS3: 0, saveS3: true, disableLocalBackup: false,
  databasesToBackup: "app,analytics", dumpAll: false, timeout: 7200, missingBackupNotificationDays: 3,
};

beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
  fx.a = await fixture(A, "a");
  fx.b = await fixture(B, "b");
}, 120_000);
afterAll(async () => db?.close());

describe("deploy.s3_storages", () => {
  it("encrypts the key and the secret, as Coolify's casts do", () => {
    expect(isEncryptedColumn("s3_storages", "key")).toBe(true);
    expect(isEncryptedColumn("s3_storages", "secret")).toBe(true);
  });

  it("stores a storage with the org's ciphertexts and lists the org's storages by name", async () => {
    const zeta = await addStorage(A, "s3zeta", "zeta");
    await addStorage(A, "s3alpha", "Alpha", { isUsable: false });
    await addStorage(B, "s3other", "other");
    expect(zeta).toMatchObject({ uuid: "s3zeta", type: "s3", name: "zeta", region: "us-east-1", bucket: "backups", is_usable: true, unusable_email_sent: false, use_path_style_endpoint: true, skip_tls_verification: false });
    expect(zeta).not.toHaveProperty("key");
    expect(zeta).not.toHaveProperty("secret");
    expect((await withOrg(ex, A, (tx) => listS3Storages(tx))).map((s) => s.name)).toEqual(["Alpha", "zeta"]);
    const found = (await withOrg(ex, A, (tx) => findS3StorageByUuid(tx, "s3zeta")))!;
    expect(isEncrypted(found.key) && isEncrypted(found.secret)).toBe(true);
    expect(await withOrg(ex, A, async (tx) => decryptField(await orgDek(tx, A, await loadKek(KEK)), "s3_storages.secret", found.secret))).toBe("secret-zeta");
    await expect(withOrg(ex, A, async (tx) => decryptField(await orgDek(tx, A, await loadKek(KEK)), "s3_storages.key", found.secret))).rejects.toThrow();
    // Row-level security: B sees none of A's storages.
    expect(await withOrg(ex, B, (tx) => findS3StorageByUuid(tx, "s3zeta"))).toBeNull();
    expect((await withOrg(ex, B, (tx) => listS3Storages(tx))).map((s) => s.uuid)).toEqual(["s3other"]);
  });

  it("updates every field of the form, and the status alone", async () => {
    const s = (await withOrg(ex, A, (tx) => findS3StorageByUuid(tx, "s3alpha")))!;
    const updated = await withOrg(ex, A, (tx) =>
      updateS3Storage(tx, s.id, {
        name: "Alpha 2", description: "eu", region: "eu-central-1", key: s.key, secret: s.secret, bucket: "b2", endpoint: "https://s3.eu.example.com",
        usePathStyleEndpoint: false, skipTlsVerification: true, isUsable: true, unusableEmailSent: false,
      }),
    );
    expect(updated).toMatchObject({ name: "Alpha 2", description: "eu", region: "eu-central-1", bucket: "b2", endpoint: "https://s3.eu.example.com", use_path_style_endpoint: false, skip_tls_verification: true, is_usable: true });
    expect(await withOrg(ex, A, (tx) => setS3StorageUsable(tx, s.id, false, false))).toBe(true);
    expect((await withOrg(ex, A, (tx) => findS3StorageById(tx, s.id)))!.is_usable).toBe(false);
    // Another org's id changes nothing.
    expect(await withOrg(ex, B, (tx) => setS3StorageUsable(tx, s.id, true, false))).toBe(false);
  });
});

describe("deploy.scheduled_database_backups", () => {
  it("creates a schedule as CreateScheduledBackup does, the rest from the schema's defaults", async () => {
    const b = await withOrg(ex, A, (tx) => insertDatabaseBackup(tx, { orgId: A, uuid: "bk1", frequency: "daily", databaseType: PG, databaseId: fx.a!.databaseId, databasesToBackup: "postgres" }));
    expect(b).toMatchObject({
      uuid: "bk1", enabled: true, save_s3: false, frequency: "daily", s3_storage_id: null, databases_to_backup: "postgres", dump_all: false,
      database_backup_retention_amount_locally: 0, database_backup_retention_days_locally: 0, database_backup_retention_amount_s3: 0, database_backup_retention_days_s3: 0,
      timeout: 3600, disable_local_backup: false, missing_backup_notification_days: 0, last_execution_at: null,
    });
    expect(Number(b.database_backup_retention_max_storage_locally)).toBe(0);
    const list = await withOrg(ex, A, (tx) => listDatabaseBackups(tx, PG, fx.a!.databaseId));
    expect(list.map((x) => [x.uuid, Number(x.executions_count), x.latest_status])).toEqual([["bk1", 0, null]]);
    expect(await withOrg(ex, B, (tx) => listDatabaseBackups(tx, PG, fx.a!.databaseId))).toEqual([]);
    expect(await withOrg(ex, B, (tx) => findDatabaseBackup(tx, PG, fx.a!.databaseId, "bk1"))).toBeNull();
  });

  it("updates the schedule's columns and flips enabled", async () => {
    const b = (await withOrg(ex, A, (tx) => findDatabaseBackup(tx, PG, fx.a!.databaseId, "bk1")))!;
    const u = (await withOrg(ex, A, (tx) => updateDatabaseBackup(tx, b.id, CHANGES)))!;
    expect(u).toMatchObject({ frequency: "0 3 * * *", database_backup_retention_amount_locally: 7, database_backup_retention_amount_s3: 30, database_backup_retention_days_s3: 90, save_s3: true, databases_to_backup: "app,analytics", timeout: 7200, missing_backup_notification_days: 3 });
    expect(Number(u.database_backup_retention_max_storage_locally)).toBe(1.5);
    expect(await withOrg(ex, A, (tx) => setDatabaseBackupEnabled(tx, b.id, false))).toBe(true);
    expect((await withOrg(ex, A, (tx) => findDatabaseBackup(tx, PG, fx.a!.databaseId, "bk1")))!.enabled).toBe(false);
  });

  it("syncs the destinations: the pivot holds the selection, the primary stays while selected", async () => {
    const b = (await withOrg(ex, A, (tx) => findDatabaseBackup(tx, PG, fx.a!.databaseId, "bk1")))!;
    const zeta = (await withOrg(ex, A, (tx) => findS3StorageByUuid(tx, "s3zeta")))!;
    const alpha = (await withOrg(ex, A, (tx) => findS3StorageByUuid(tx, "s3alpha")))!;
    expect(String(await withOrg(ex, A, (tx) => syncScheduleS3Storages(tx, "database", b.id, [zeta.id, alpha.id, zeta.id], A)))).toBe(String(zeta.id));
    expect(await count("scheduled_database_backup_s3_storage", "scheduled_database_backup_id = $1", [b.id])).toBe(2);
    // The primary comes first, then by name.
    expect(await withOrg(ex, A, (tx) => databaseBackupStorageIds(tx, b.id))).toEqual([String(zeta.id), String(alpha.id)]);
    expect(String(await withOrg(ex, A, (tx) => syncScheduleS3Storages(tx, "database", b.id, [alpha.id], A)))).toBe(String(alpha.id));
    expect(await withOrg(ex, A, (tx) => databaseBackupStorageIds(tx, b.id))).toEqual([String(alpha.id)]);
    expect(await withOrg(ex, A, (tx) => syncScheduleS3Storages(tx, "database", b.id, [], A))).toBeNull();
    // A legacy schedule (s3_storage_id, no pivot) reads its one storage.
    await admin("UPDATE deploy.scheduled_database_backups SET s3_storage_id = $2 WHERE id = $1", [b.id, zeta.id]);
    expect(await withOrg(ex, A, (tx) => databaseBackupStorageIds(tx, b.id))).toEqual([String(zeta.id)]);
    expect((await withOrg(ex, A, (tx) => databaseBackupStorages(tx, [b.id]))).map((s) => [s.name, s.is_primary, s.legacy])).toEqual([["zeta", true, true]]);
    await withOrg(ex, A, (tx) => syncScheduleS3Storages(tx, "database", b.id, [zeta.id, alpha.id], A));
    expect((await withOrg(ex, A, (tx) => databaseBackupStorages(tx, [b.id]))).map((s) => [s.name, s.is_primary])).toEqual([["Alpha 2", false], ["zeta", true]]);
  });

  it("offers the usable storages and the ones already selected", async () => {
    const zeta = (await withOrg(ex, A, (tx) => findS3StorageByUuid(tx, "s3zeta")))!;
    const alpha = (await withOrg(ex, A, (tx) => findS3StorageByUuid(tx, "s3alpha")))!;
    expect((await withOrg(ex, A, (tx) => availableBackupS3Storages(tx, []))).map((s) => s.name)).toEqual(["zeta"]);
    expect((await withOrg(ex, A, (tx) => availableBackupS3Storages(tx, [alpha.id]))).map((s) => s.name)).toEqual(["Alpha 2", "zeta"]);
    expect(String(zeta.id)).not.toBe(String(alpha.id));
  });

  it("reads executions newest first (nothing writes them yet) and what a delete would remove outside the database", async () => {
    const b = (await withOrg(ex, A, (tx) => findDatabaseBackup(tx, PG, fx.a!.databaseId, "bk1")))!;
    expect(await withOrg(ex, A, (tx) => listDatabaseBackupExecutions(tx, PG, fx.a!.databaseId))).toEqual({ total: 0, rows: [] });
    expect(await withOrg(ex, A, (tx) => databaseBackupFiles(tx, b.id))).toEqual({ localFiles: 0, s3Copies: 0 });
    await admin("INSERT INTO deploy.scheduled_database_backup_executions (uuid, scheduled_database_backup_id, status, filename, created_at, org_id) VALUES ('ex1', $1, 'success', '/data/a.dmp', '2026-11-20 10:00:00', $2), ('ex2', $1, 'failed', NULL, '2026-11-21 10:00:00', $2)", [b.id, A]);
    const ex1 = (await row("scheduled_database_backup_executions", "uuid = 'ex1'")).id;
    await admin("INSERT INTO deploy.database_backup_s3_replicas (execution_id, s3_storage_id, s3_uploaded, org_id) VALUES ($1, 1, true, $2)", [ex1, A]);
    const execs = await withOrg(ex, A, (tx) => listDatabaseBackupExecutions(tx, PG, fx.a!.databaseId));
    expect(execs.total).toBe(2);
    expect(execs.rows.map((x) => [x.uuid, x.backup_uuid, x.status])).toEqual([["ex2", "bk1", "failed"], ["ex1", "bk1", "success"]]);
    expect(await withOrg(ex, A, (tx) => databaseBackupFiles(tx, b.id))).toEqual({ localFiles: 1, s3Copies: 1 });
    const list = await withOrg(ex, A, (tx) => listDatabaseBackups(tx, PG, fx.a!.databaseId));
    expect(list.map((x) => [Number(x.executions_count), x.latest_status])).toEqual([[2, "failed"]]);
    expect(await withOrg(ex, B, (tx) => listDatabaseBackupExecutions(tx, PG, fx.a!.databaseId))).toEqual({ total: 0, rows: [] });
  });

  it("reads the server's timezone", async () => {
    expect(await withOrg(ex, A, (tx) => serverTimezone(tx, fx.a!.serverId))).toBe("UTC");
    expect(await withOrg(ex, A, (tx) => serverTimezone(tx, null))).toBeNull();
  });

  it("deletes a schedule with its executions, their replicas and its destinations", async () => {
    const b = (await withOrg(ex, A, (tx) => findDatabaseBackup(tx, PG, fx.a!.databaseId, "bk1")))!;
    expect(await withOrg(ex, B, (tx) => deleteDatabaseBackup(tx, b.id))).toBe(false);
    expect(await withOrg(ex, A, (tx) => deleteDatabaseBackup(tx, b.id))).toBe(true);
    expect(await count("scheduled_database_backups", "id = $1", [b.id])).toBe(0);
    expect(await count("scheduled_database_backup_executions", "scheduled_database_backup_id = $1", [b.id])).toBe(0);
    expect(await count("database_backup_s3_replicas", "execution_id NOT IN (SELECT id FROM deploy.scheduled_database_backup_executions)")).toBe(0);
    expect(await count("scheduled_database_backup_s3_storage", "scheduled_database_backup_id = $1", [b.id])).toBe(0);
  });
});

describe("deleting a storage (detachFromBackups)", () => {
  it("counts, lists and detaches the schedules that use it, marks its S3 copies deleted, then deletes it", async () => {
    const one = await addStorage(A, "s3one", "one");
    const two = await addStorage(A, "s3two", "two");
    const db1 = fx.a!.databaseId;
    // s1: one and two, one primary. s2: only one (pivot). s3: legacy primary one, no pivot. s4: two only.
    const mk = async (uuid: string) => withOrg(ex, A, (tx) => insertDatabaseBackup(tx, { orgId: A, uuid, frequency: "daily", databaseType: PG, databaseId: db1, databasesToBackup: null }));
    const [s1, s2, s3, s4] = [await mk("s1"), await mk("s2"), await mk("s3"), await mk("s4")];
    await admin("UPDATE deploy.scheduled_database_backups SET save_s3 = true WHERE uuid IN ('s1','s2','s3','s4')");
    await withOrg(ex, A, (tx) => syncScheduleS3Storages(tx, "database", s1.id, [one.id, two.id], A));
    await withOrg(ex, A, (tx) => syncScheduleS3Storages(tx, "database", s2.id, [one.id], A));
    await admin("UPDATE deploy.scheduled_database_backups SET s3_storage_id = $2 WHERE id = $1", [s3.id, one.id]);
    await withOrg(ex, A, (tx) => syncScheduleS3Storages(tx, "database", s4.id, [two.id], A));
    // A volume schedule that uses `one`, and an execution with a copy on each storage.
    await admin("INSERT INTO deploy.scheduled_volume_backups (uuid, backupable_type, backupable_id, frequency, s3_storage_id, save_s3, org_id) VALUES ('v1', 'App\\Models\\LocalPersistentVolume', 1, 'daily', $1, true, $2)", [one.id, A]);
    await admin("INSERT INTO deploy.scheduled_database_backup_executions (uuid, scheduled_database_backup_id, status, s3_uploaded, org_id) VALUES ('sx', $1, 'success', true, $2)", [s1.id, A]);
    const sx = (await row("scheduled_database_backup_executions", "uuid = 'sx'")).id;
    await admin("INSERT INTO deploy.database_backup_s3_replicas (execution_id, s3_storage_id, s3_uploaded, org_id) VALUES ($1, $2, true, $4), ($1, $3, true, $4)", [sx, one.id, two.id, A]);

    expect(await withOrg(ex, A, (tx) => s3StorageBackupCount(tx, one.id))).toBe(4);
    expect(await withOrg(ex, A, (tx) => s3StorageBackupCount(tx, two.id))).toBe(2);
    const using = await withOrg(ex, A, (tx) => listS3StorageDatabaseBackups(tx, one.id));
    expect(using.map((u) => [u.uuid, u.database_uuid, u.environment_uuid, u.project_uuid])).toEqual([
      ["s1", "pga", "enva", "prja"],
      ["s2", "pga", "enva", "prja"],
      ["s3", "pga", "enva", "prja"],
    ]);
    expect(await withOrg(ex, B, (tx) => deleteS3Storage(tx, one.id, B))).toBe(false);

    expect(await withOrg(ex, A, (tx) => deleteS3Storage(tx, one.id, A))).toBe(true);

    expect(await count("s3_storages", "id = $1", [one.id])).toBe(0);
    const s = async (uuid: string) => row("scheduled_database_backups", "uuid = $1", [uuid]);
    // s1 keeps two, which becomes its primary; s2 and s3 have nothing left and stop S3 backups.
    expect([String((await s("s1")).s3_storage_id), (await s("s1")).save_s3]).toEqual([String(two.id), true]);
    expect([(await s("s2")).s3_storage_id, (await s("s2")).save_s3]).toEqual([null, false]);
    expect([(await s("s3")).s3_storage_id, (await s("s3")).save_s3]).toEqual([null, false]);
    expect(await count("scheduled_database_backup_s3_storage", "s3_storage_id = $1", [one.id])).toBe(0);
    expect(await count("scheduled_database_backup_s3_storage", "scheduled_database_backup_id = $1", [s1.id])).toBe(1);
    const v1 = await row("scheduled_volume_backups", "uuid = 'v1'");
    expect([v1.s3_storage_id, v1.save_s3]).toEqual([null, false]);
    // The copy on `one` is marked deleted; the execution still has its copy on `two`.
    expect((await row("database_backup_s3_replicas", "execution_id = $1 AND s3_storage_id = $2", [sx, one.id])).s3_storage_deleted).toBe(true);
    expect((await row("database_backup_s3_replicas", "execution_id = $1 AND s3_storage_id = $2", [sx, two.id])).s3_storage_deleted).toBe(false);
    expect([(await row("scheduled_database_backup_executions", "id = $1", [sx])).s3_uploaded, (await row("scheduled_database_backup_executions", "id = $1", [sx])).s3_storage_deleted]).toEqual([true, false]);
    // Deleting `two` as well: every uploaded copy of the execution is gone.
    expect(await withOrg(ex, A, (tx) => deleteS3Storage(tx, two.id, A))).toBe(true);
    expect((await row("scheduled_database_backup_executions", "id = $1", [sx])).s3_storage_deleted).toBe(true);
    expect([(await s("s1")).s3_storage_id, (await s("s1")).save_s3, (await s("s4")).save_s3]).toEqual([null, false, false]);
  });

  it("leaves no schedule behind when the database goes (DP-57's delete)", async () => {
    await withOrg(ex, A, (tx) => insertDatabaseBackup(tx, { orgId: A, uuid: "gone", frequency: "daily", databaseType: PG, databaseId: fx.a!.databaseId, databasesToBackup: null }));
    const three = await addStorage(A, "s3three", "three");
    const gone = (await withOrg(ex, A, (tx) => findDatabaseBackup(tx, PG, fx.a!.databaseId, "gone")))!;
    await withOrg(ex, A, (tx) => syncScheduleS3Storages(tx, "database", gone.id, [three.id], A));
    await admin("UPDATE deploy.scheduled_database_backups SET save_s3 = true WHERE id = $1", [gone.id]);
    await withOrg(ex, A, (tx) => disableDatabaseBackupS3(tx, gone.id));
    expect((await row("scheduled_database_backups", "id = $1", [gone.id])).save_s3).toBe(false);
    expect(await withOrg(ex, A, (tx) => deleteDatabase(tx, "postgresql", fx.a!.databaseId))).toBe(true);
    expect(await count("scheduled_database_backups", "database_type = $1 AND database_id = $2", [PG, fx.a!.databaseId])).toBe(0);
    expect(await count("scheduled_database_backup_s3_storage", "scheduled_database_backup_id = $1", [gone.id])).toBe(0);
    // The storage stays.
    expect(await count("s3_storages", "id = $1", [three.id])).toBe(1);
  });
});
