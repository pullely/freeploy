// The console's storage backup pages of an application and a service (DP-99): Coolify's Backup\Index, Create and Show,
// VolumeBackup\Index and Create, DatabaseBackups and the shared VolumeBackups component as console routes over the
// API fixture's rows in Freeploy's database (PGlite with every deploy migration, row-level security on) — Coolify's
// rules and messages, what is stored, what runs on the server answered as not available yet with nothing stored, who
// may open and change each page, and one org never reaching another's storages.
// The Worker's own module order (the router first), as its import cycle needs.
import "@deploy-core-worker/router";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { withOrg } from "@saas/db/deploy";
import type { Env } from "@deploy-core-worker/env";
import { handleVolumeBackupPages, isVolumeBackupRoute, serviceDatabaseBackupAvailable, VOLUME_BACKUP_PAGE_MESSAGES, type VolumeBackupPagesRunner } from "@deploy-core-worker/handlers/volume-backup-pages";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";

const ORG1 = ORG_UUID[1]!;
const ORG2 = ORG_UUID[2]!;
const APP = "a1parityimageapp00000001";
const SERVICE = "f1parityservice000000001";
const actor = { subjectId: "usr_1", subjectType: "user" };
const UNAVAILABLE = (what: string) => `${what} needs the SSH executor, which is not available yet.`;

let fixture: FixtureDatabase;
beforeAll(async () => {
  fixture = await fixtureDatabase();
}, 120_000);
afterAll(async () => fixture?.pg.close());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

type Body = { data?: Record<string, unknown> & { [k: string]: unknown }; error?: { code: string; message: string; details?: { fields?: Record<string, string[]> } } };

function client(db: TransactionalSqlExecutor, allow: { read?: boolean; write?: boolean } = {}) {
  const asked: string[] = [];
  const env: Env = {
    ENVIRONMENT: "test",
    DEPLOY_ENCRYPTION_KEY: TEST_KEK,
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      asked.push(body.action);
      const ok = body.action === "deploy.resource.write" ? (allow.write ?? true) : (allow.read ?? true);
      return json({ data: { decision: ok ? "allow" : "deny", allow: ok } });
    }),
  };
  const runner: VolumeBackupPagesRunner = (_env, orgId, fn) => withOrg(db, orgId, fn);
  const call = async (method: string, kind: "application" | "service", path: string, body?: unknown, org = ORG1) => {
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleVolumeBackupPages(env, "req_1", actor, org, kind, path.split("?")[0]!.split("/"), new Request(`https://x/${path}`, init), runner);
    return { status: res.status, body: (await res.json()) as Body };
  };
  return { asked, call, app: (method: string, path: string, body?: unknown, org?: string) => call(method, "application", `${APP}/${path}`, body, org), service: (method: string, path: string, body?: unknown, org?: string) => call(method, "service", `${SERVICE}/${path}`, body, org) };
}

const schedules = (db: TransactionalSqlExecutor, org = ORG1) => withOrg(db, org, async (tx) => (await tx.execute<{ uuid: string; frequency: string; enabled: boolean; save_s3: boolean; backupable_id: string; timeout: number; s3_storage_id: string | null }>("SELECT uuid, frequency, enabled, save_s3, backupable_id::text AS backupable_id, timeout, s3_storage_id::text AS s3_storage_id FROM deploy.scheduled_volume_backups ORDER BY id")).rows);
const pivot = (db: TransactionalSqlExecutor) => withOrg(db, ORG1, async (tx) => (await tx.execute<{ s3: string }>("SELECT s3_storage_id::text AS s3 FROM deploy.scheduled_volume_backup_s3_storage ORDER BY id")).rows.map((r) => r.s3));
const execution = (db: TransactionalSqlExecutor, backupUuid: string, columns: { status: string; filename?: string | null; local_storage_deleted?: boolean; stop_recovery_pending?: boolean }) =>
  withOrg(db, ORG1, async (tx) =>
    (
      await tx.execute<{ id: string }>(
        `INSERT INTO deploy.scheduled_volume_backup_executions (uuid, scheduled_volume_backup_id, status, filename, local_storage_deleted, stop_recovery_pending, created_at, updated_at, finished_at, org_id)
         SELECT md5(random()::text), b.id, $2, $3, $4, $5, '2026-01-02 00:00:00', '2026-01-02 00:00:00', '2026-01-02 00:05:00', $6 FROM deploy.scheduled_volume_backups b WHERE b.uuid = $1 RETURNING id::text AS id`,
        [backupUuid, columns.status, columns.filename ?? null, columns.local_storage_deleted ?? false, columns.stop_recovery_pending ?? false, ORG1],
      )
    ).rows[0]!.id,
  );
const executionCount = (db: TransactionalSqlExecutor) => withOrg(db, ORG1, async (tx) => (await tx.execute<{ n: number }>("SELECT count(*)::int AS n FROM deploy.scheduled_volume_backup_executions")).rows[0]!.n);

async function createVolumeSchedule(c: ReturnType<typeof client>): Promise<string> {
  const r = await c.app("POST", "backups", { targetKey: "volume:12", frequency: "daily" });
  expect(r.status).toBe(201);
  return String(r.body.data!.backupUuid);
}

describe("routing", () => {
  it("takes …/backups of an application and …/storage-backups and …/database-backups of a service", () => {
    expect(isVolumeBackupRoute("application", [APP, "backups"])).toBe(true);
    expect(isVolumeBackupRoute("application", [APP, "storage-backups"])).toBe(false);
    expect(isVolumeBackupRoute("service", [SERVICE, "storage-backups", "x"])).toBe(true);
    expect(isVolumeBackupRoute("service", [SERVICE, "database-backups", "x"])).toBe(true);
    expect(isVolumeBackupRoute("service", [SERVICE, "backups"])).toBe(false);
  });

  it("answers 404 for an unknown path and 405 for a method a route does not take, before asking the policy", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      expect((await c.app("GET", "backups/x/nope")).status).toBe(404);
      expect((await c.app("PUT", "backups")).status).toBe(405);
      expect((await c.app("GET", "backups/x/run")).status).toBe(405);
      expect(c.asked).toEqual([]);
    });
  });
});

describe("an application's storage backups (Backup\\Index and Create)", () => {
  it("lists none, with Create's targets: the volumes, then the directories that are not host files", async () => {
    await fixture.inCase(async (db) => {
      const r = await client(db).app("GET", "backups");
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ application: { uuid: APP }, backups: [], canUpdate: true });
      expect(r.body.data!.targets).toEqual([
        { key: "volume:12", type: "Volume", name: "a1parityimageapp00000001-data", existing: null },
        { key: "directory:3", type: "Directory", name: "/srv/shared", existing: null },
      ]);
    });
  });

  it("holds Create to its rules and messages, and stores nothing on a refusal", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      const fields = async (body: unknown) => (await c.app("POST", "backups", body)).body.error?.details?.fields;
      expect(await fields({ targetKey: "", frequency: "" })).toEqual({ targetKey: ["The target key field is required."], frequency: ["The frequency field is required."] });
      expect(await fields({ targetKey: "volume:0", frequency: "daily" })).toEqual({ targetKey: ["The target key field format is invalid."] });
      // The host file (2), a file (1), and the other team's volume (14) are not this application's targets.
      for (const key of ["directory:2", "directory:1", "volume:14"]) expect(await fields({ targetKey: key, frequency: "daily" })).toEqual({ targetKey: ["Select a volume or directory owned by this application."] });
      expect(await fields({ targetKey: "volume:12", frequency: "every second" })).toEqual({ frequency: ["The frequency must be a valid cron or human expression."] });
      expect(await schedules(db)).toEqual([]);
    });
  });

  it("creates the target's schedule enabled with the table's defaults, then updates it", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      const created = await c.app("POST", "backups", { targetKey: "directory:3", frequency: "0 3 * * *" });
      expect([created.status, created.body.data!.message, created.body.data!.created]).toEqual([201, "Scheduled storage backup created.", true]);
      const uuid = String(created.body.data!.backupUuid);
      expect(await schedules(db)).toEqual([{ uuid, frequency: "0 3 * * *", enabled: true, save_s3: false, backupable_id: "3", timeout: 36000, s3_storage_id: null }]);
      await withOrg(db, ORG1, (tx) => tx.execute("UPDATE deploy.scheduled_volume_backups SET enabled = false"));
      const again = await c.app("POST", "backups", { targetKey: "directory:3", frequency: "hourly" });
      expect([again.status, again.body.data!.message, again.body.data!.backupUuid]).toEqual([200, "Scheduled storage backup updated.", uuid]);
      expect((await schedules(db)).map((s) => [s.frequency, s.enabled])).toEqual([["hourly", true]]);
      const list = await c.app("GET", "backups");
      expect(list.body.data!.backups).toEqual([{ uuid, targetName: "/srv/shared", targetType: "Directory", frequency: "hourly", enabled: true, saveS3: false, storages: [], latestStatus: null, latestFinishedAt: null, executionsCount: 0 }]);
      expect((list.body.data!.targets as Array<{ existing: unknown }>)[1]!.existing).toEqual({ uuid, frequency: "hourly" });
    });
  });
});

describe("one schedule (VolumeBackups)", () => {
  it("shows its settings, the first usable S3 storage preselected, the server's timezone and no executions", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      const uuid = await createVolumeSchedule(c);
      const r = await c.app("GET", `backups/${uuid}`);
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({
        backup: { uuid, targetType: "Volume", targetName: "a1parityimageapp00000001-data", frequency: "daily", enabled: true, saveToS3: false, s3StorageIds: ["s3paritystorage000000001"], retentionAmountLocally: 7, timeout: 36000, missingBackupNotificationDays: 0 },
        availableS3Storages: [{ uuid: "s3paritystorage000000001", name: "Parity S3", isUsable: true }],
        executions: { total: 0, page: 1, perPage: 10, rows: [] },
      });
      expect(typeof r.body.data!.timezone).toBe("string");
      expect((await c.app("GET", "backups/nope")).status).toBe(404);
    });
  });

  it("saves with Livewire's rules and messages; S3 needs a storage; toggles S3 and the schedule", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      const uuid = await createVolumeSchedule(c);
      const refused = await c.app("PATCH", `backups/${uuid}`, { action: "save", timeout: 59, retentionAmountLocally: 10001, retentionMaxStorageS3: "x", frequency: "" });
      expect([refused.status, refused.body.error!.details!.fields]).toEqual([
        422,
        { frequency: ["The frequency field is required."], retentionAmountLocally: ["The retention amount locally field must not be greater than 10000."], retentionMaxStorageS3: ["The retention max storage s3 field must be a number."], timeout: ["The timeout field must be at least 60."] },
      ]);
      expect((await c.app("PATCH", `backups/${uuid}`, { action: "save", frequency: "nope" })).body.error!.details!.fields).toEqual({ frequency: ["The frequency must be a valid cron or human expression."] });
      expect((await c.app("PATCH", `backups/${uuid}`, { action: "save", saveToS3: true, s3StorageIds: [] })).body.error!.details!.fields).toEqual({ s3StorageIds: ["Select at least one usable S3 storage owned by your team."] });
      expect((await c.app("PATCH", `backups/${uuid}`, { action: "toggleS3", s3StorageIds: ["s4otherstorage0000000002"] })).body.error!.message).toBe("Select a usable S3 storage before enabling S3 backups.");
      expect((await schedules(db))[0]).toMatchObject({ frequency: "daily", save_s3: false, timeout: 36000 });

      const saved = await c.app("PATCH", `backups/${uuid}`, { action: "save", frequency: "weekly", timeout: 600, disableLocalBackup: true });
      expect([saved.body.data!.message, (saved.body.data!.backup as Record<string, unknown>).disableLocalBackup]).toEqual(["Storage backup schedule saved.", false]);
      const s3 = await c.app("PATCH", `backups/${uuid}`, { action: "toggleS3", s3StorageIds: ["s3paritystorage000000001"] });
      expect([s3.body.data!.message, (s3.body.data!.backup as Record<string, unknown>).saveToS3]).toEqual(["S3 backups enabled.", true]);
      expect(await pivot(db)).toEqual(["1"]);
      expect((await schedules(db))[0]).toMatchObject({ frequency: "weekly", timeout: 600, save_s3: true, s3_storage_id: "1" });
      expect((await c.app("PATCH", `backups/${uuid}`, { action: "toggleEnabled" })).body.data!.message).toBe("Storage backups disabled.");
      expect((await c.app("PATCH", `backups/${uuid}`, { action: "toggleEnabled" })).body.data!.message).toBe("Storage backups enabled.");
      expect((await c.app("PATCH", `backups/${uuid}`, { action: "toggleS3" })).body.data!.message).toBe("S3 backups disabled.");
      expect((await c.app("PATCH", `backups/${uuid}`, { action: "s3StorageIds", s3StorageIds: [] })).body.data!.message).toBe("S3 storages updated.");
      expect(await pivot(db)).toEqual([]);
    });
  });

  it("answers Back up now, a recovery and a download as needing the SSH executor, storing nothing", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      const uuid = await createVolumeSchedule(c);
      const before = await schedules(db);
      const run = await c.app("POST", `backups/${uuid}/run`);
      expect([run.status, run.body.error!.message]).toEqual([501, UNAVAILABLE("Running the storage backup")]);
      const id = await execution(db, uuid, { status: "failed", stop_recovery_pending: true });
      const retry = await c.app("POST", `backups/${uuid}/executions/${id}/retry`);
      expect([retry.status, retry.body.error!.message]).toEqual([501, UNAVAILABLE("Recovering the storage backup")]);
      const download = await c.app("POST", `backups/${uuid}/executions/${id}/download`);
      expect([download.status, download.body.error!.message]).toEqual([501, UNAVAILABLE("Downloading the backup archive")]);
      expect((await c.app("POST", `backups/${uuid}/executions/999/retry`)).body.error!.message).toBe("No pending recovery found for this backup execution.");
      expect((await c.app("POST", `backups/${uuid}/executions/999/download`)).body.error!.message).toBe("Backup execution not found.");
      expect(await schedules(db)).toEqual(before);
      expect(await executionCount(db)).toBe(1);
    });
  });

  it("deletes an execution's row, refusing a running one and answering a local archive as needing the SSH executor", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      const uuid = await createVolumeSchedule(c);
      const running = await execution(db, uuid, { status: "running" });
      const archived = await execution(db, uuid, { status: "success", filename: "/data/coolify/backups/a.tar.gz" });
      const gone = await execution(db, uuid, { status: "failed", filename: "/data/coolify/backups/b.tar.gz", local_storage_deleted: true });
      expect((await c.app("DELETE", `backups/${uuid}/executions/${running}`)).body.error!.message).toBe("Wait for the backup and recovery operations to finish before deleting it.");
      const local = await c.app("DELETE", `backups/${uuid}/executions/${archived}`);
      expect([local.status, local.body.error!.message]).toEqual([501, UNAVAILABLE("Deleting the local backup archives")]);
      expect(await executionCount(db)).toBe(3);
      expect((await c.app("DELETE", `backups/${uuid}/executions/${gone}`)).body.data!.message).toBe("Backup deleted.");
      expect(await executionCount(db)).toBe(2);
      const shown = await c.app("GET", `backups/${uuid}?perPage=1`);
      expect(shown.body.data!.executions).toMatchObject({ total: 2, perPage: 1, rows: [{ status: "success" }] });
    });
  });

  it("cleans up the failed and the deleted entries with Coolify's toasts", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      const uuid = await createVolumeSchedule(c);
      expect((await c.app("POST", `backups/${uuid}/executions/cleanup-failed`)).body.data).toEqual({ message: "No safely removable failed backup entries found.", level: "info", deletedCount: 0 });
      await execution(db, uuid, { status: "failed" });
      await execution(db, uuid, { status: "success", filename: "/x.tar.gz", local_storage_deleted: true });
      expect((await c.app("POST", `backups/${uuid}/executions/cleanup-failed`)).body.data).toEqual({ message: "Failed backup entries cleaned up.", level: "success", deletedCount: 1 });
      expect((await c.app("POST", `backups/${uuid}/executions/cleanup-deleted`)).body.data).toEqual({ message: "Cleaned up 1 deleted backup entries.", level: "success", deletedCount: 1 });
      expect((await c.app("POST", `backups/${uuid}/executions/cleanup-deleted`)).body.data!.message).toBe("No deleted backup entries found.");
    });
  });

  it("deletes the schedule with its executions; a running backup refuses it, and deleting local archives needs the SSH executor", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      const uuid = await createVolumeSchedule(c);
      const running = await execution(db, uuid, { status: "running" });
      const busy = await c.app("DELETE", `backups/${uuid}`);
      expect([busy.status, busy.body.error!.message]).toEqual([409, "Could not delete the backup schedule: Wait for the running storage backup and recovery operations to finish before deleting this schedule."]);
      await withOrg(db, ORG1, (tx) => tx.execute("UPDATE deploy.scheduled_volume_backup_executions SET status = 'success', filename = '/a.tar.gz' WHERE id = $1", [running]));
      const local = await c.app("DELETE", `backups/${uuid}?delete_associated_backups_locally=1`);
      expect([local.status, local.body.error!.message]).toEqual([501, UNAVAILABLE("Deleting the local backup archives")]);
      expect((await schedules(db)).length).toBe(1);
      // Keeping the archives deletes the rows only.
      expect((await c.app("DELETE", `backups/${uuid}`)).body.data).toEqual({ message: "Storage backup schedule deleted.", deleted: true });
      expect([await schedules(db), await executionCount(db)]).toEqual([[], 0]);
    });
  });
});

describe("authorization and org isolation", () => {
  it("gives a member the lists and a schedule to read, and refuses every change as a 404 that stores nothing", async () => {
    await fixture.inCase(async (db) => {
      const uuid = await createVolumeSchedule(client(db));
      const member = client(db, { write: false });
      expect([(await member.app("GET", "backups")).body.data!.canUpdate, (await member.app("GET", `backups/${uuid}`)).body.data!.canUpdate]).toEqual([false, false]);
      expect((await member.service("GET", "storage-backups")).status).toBe(200);
      for (const [method, path, body] of [
        ["POST", "backups", { targetKey: "directory:3", frequency: "daily" }],
        ["PATCH", `backups/${uuid}`, { action: "toggleEnabled" }],
        ["POST", `backups/${uuid}/run`, undefined],
        ["DELETE", `backups/${uuid}`, undefined],
        ["POST", `backups/${uuid}/executions/cleanup-failed`, undefined],
      ] as const) {
        expect([method, path, (await member.app(method, path, body)).status]).toEqual([method, path, 404]);
      }
      // A service's schedule opens in Index's modal, which openSchedule() gives to who may update.
      expect((await member.service("GET", `storage-backups/${uuid}`)).status).toBe(404);
      expect((await schedules(db)).map((s) => s.enabled)).toEqual([true]);
      const none = client(db, { read: false, write: false });
      expect((await none.app("GET", "backups")).status).toBe(404);
    });
  });

  it("never reaches another org's application, service or schedule", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      const uuid = await createVolumeSchedule(c);
      expect((await c.app("GET", "backups", undefined, ORG2)).status).toBe(404);
      expect((await c.service("GET", "storage-backups", undefined, ORG2)).status).toBe(404);
      expect((await c.call("GET", "application", `a3otherteamapp0000000003/backups/${uuid}`, undefined, ORG2)).status).toBe(404);
      const other = await c.call("POST", "application", "a3otherteamapp0000000003/backups", { targetKey: "volume:12", frequency: "daily" }, ORG2);
      expect(other.body.error!.details!.fields).toEqual({ targetKey: ["Select a volume or directory owned by this application."] });
      expect(await schedules(db, ORG2)).toEqual([]);
    });
  });
});

describe("a service's storage backups (VolumeBackup\\Index and Create, DatabaseBackups)", () => {
  it("lists each part's volumes and directories as targets, named as Create names them", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      const r = await c.service("GET", "storage-backups");
      expect(r.body.data).toMatchObject({ service: { uuid: SERVICE }, backups: [], databaseBackups: [] });
      expect(r.body.data!.targets).toEqual([{ key: "volume:13", type: "Web", name: "web-html", existing: null }]);
      const created = await c.service("POST", "storage-backups", { targetKey: "volume:13", frequency: "daily" });
      expect(created.body.data!.message).toBe("Scheduled storage backup created.");
      expect((await c.service("POST", "storage-backups", { targetKey: "volume:12", frequency: "daily" })).body.error!.details!.fields).toEqual({ targetKey: ["Select a volume or directory owned by this service."] });
      const uuid = String(created.body.data!.backupUuid);
      expect(((await c.service("GET", "storage-backups")).body.data!.backups as unknown[]).length).toBe(1);
      expect((await c.service("GET", `storage-backups/${uuid}`)).body.data).toMatchObject({ backup: { uuid, targetName: "f1parityservice000000001_web-html" } });
      // The application's schedule is not the service's.
      expect((await c.service("GET", `storage-backups/${await createVolumeSchedule(c)}`)).status).toBe(404);
      const now = await c.service("POST", `storage-backups/now/storage/${uuid}`);
      expect([now.status, now.body.error!.message]).toEqual([501, UNAVAILABLE("Running the storage backup")]);
      expect((await c.service("POST", `storage-backups/now/database/${uuid}`)).status).toBe(404);
      expect((await c.service("POST", `storage-backups/now/other/${uuid}`)).status).toBe(404);
    });
  });

  it("redirects a database's …/backups as DatabaseBackups::mount() does", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      expect((await c.service("GET", "database-backups/h1paritydatabase00000001")).body.data).toMatchObject({ redirect: "storage-backups" });
      expect((await c.service("GET", "database-backups/g1paritywebapplication01")).body.data).toMatchObject({ redirect: "configuration" });
      await withOrg(db, ORG1, (tx) => tx.execute("UPDATE deploy.service_databases SET image = 'redis:7' WHERE uuid = 'h1paritydatabase00000001'"));
      expect((await c.service("GET", "database-backups/h1paritydatabase00000001")).body.data).toMatchObject({ redirect: "part" });
    });
  });

  it("knows which service databases Coolify backs up (isBackupSolutionAvailable)", () => {
    expect(["postgres:16-alpine", "timescale/timescaledb:latest", "mysql:8", "mariadb:11", "mongo:7", "postgis/postgis"].map((i) => serviceDatabaseBackupAvailable(i, null))).toEqual([true, true, true, true, true, true]);
    expect([serviceDatabaseBackupAvailable("redis:7", null), serviceDatabaseBackupAvailable("redis:7", "custom"), serviceDatabaseBackupAvailable(null, null)]).toEqual([false, true, false]);
    expect(VOLUME_BACKUP_PAGE_MESSAGES.targetNotOwned("service")).toBe("Select a volume or directory owned by this service.");
  });
});
