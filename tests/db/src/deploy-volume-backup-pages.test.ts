// The SQL of the console's storage backup pages (DP-99) on the schema at head: a resource's volume and directory
// schedules with their targets, latest executions and S3 storages, one schedule by uuid, the dirty-only update, the
// selected storages (the pivot, else the legacy column), the executions' page, cleanups and deletes, a service's
// databases' schedules, and row-level security keeping each org's rows to itself.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  insertPrivateKey,
  insertServer,
  insertProject,
  listServerDestinations,
  insertDockerImageApplication,
  insertPersistentVolume,
  insertFileVolume,
  insertS3Storage,
  syncScheduleS3Storages,
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
  listPreviewPageRows,
  updatePreviewDeploymentSettings,
  updateApplicationPreviewUrlTemplate,
  updatePreviewDnsStatuses,
  APPLICATION_MORPH_CLASS,
  SERVICE_PART_MORPH_CLASS,
  PERSISTENT_VOLUME_MORPH_CLASS,
  FILE_VOLUME_MORPH_CLASS,
  APPLICATION_WEBHOOK_SECRET_COLUMNS,
  type NewDockerImageApplication,
} from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, executor } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

let db: PGlite;
let ex: TransactionalSqlExecutor;
const ids: Record<string, string | number> = {};
const admin = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => asPlatformAdmin(ex, async (tx) => (await tx.execute<T>(sql, params)).rows);

async function application(org: string, tag: string): Promise<{ app: string | number; environment: string | number }> {
  return withOrg(ex, org, async (tx) => {
    const key = await insertPrivateKey(tx, { orgId: org, uuid: `key${tag}`, name: "key", description: null, privateKey: "fp1:fake", fingerprint: null });
    const server = await insertServer(tx, {
      orgId: org, uuid: `srv${tag}`, name: `server-${tag}`, description: null, ip: "203.0.113.10", user: "root", port: 22, privateKeyId: key.id,
      proxy: { type: "TRAEFIK", status: "exited" }, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: `dst${tag}`,
    });
    const destination = (await listServerDestinations(tx, server.id))[0]!;
    const { environment } = await insertProject(tx, { orgId: org, uuid: `prj${tag}`, name: `Project-${tag}`, description: null, productionEnvironmentUuid: `env${tag}` });
    const uuid = `app${tag}`.padEnd(24, tag);
    const app: NewDockerImageApplication = {
      orgId: org, uuid, name: `app-${tag}`, fqdn: null, domainPortOverrides: null, dockerRegistryImageName: "nginx", dockerRegistryImageTag: "latest",
      environmentId: environment.id, destinationId: destination.id, destinationType: "standalone",
      webhookSecrets: Object.fromEntries(APPLICATION_WEBHOOK_SECRET_COLUMNS.map((c) => [c, `fp1:${uuid}:${c}`])) as NewDockerImageApplication["webhookSecrets"],
    };
    return { app: (await insertDockerImageApplication(tx, app)).id, environment: environment.id };
  });
}

beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
  const a = await application(A, "a");
  const b = await application(B, "b");
  ids.app = a.app;
  ids.appb = b.app;
  await withOrg(ex, A, async (tx) => {
    const owner = { type: APPLICATION_MORPH_CLASS, id: a.app };
    ids.volume = (await insertPersistentVolume(tx, { orgId: A, owner, uuid: "vola", name: "app-a-data", mountPath: "/data", hostPath: null })).id;
    ids.directory = (await insertFileVolume(tx, { orgId: A, owner, uuid: "dira", fsPath: "/srv/shared", mountPath: "/shared", content: null, isDirectory: true, isHostFile: false })).id;
    ids.hostDirectory = (await insertFileVolume(tx, { orgId: A, owner, uuid: "hosta", fsPath: "/etc", mountPath: "/etc", content: null, isDirectory: true, isHostFile: true })).id;
    const s3 = { type: "s3", description: null, region: "us-east-1", key: "fp1:k", secret: "fp1:s", bucket: "backups", endpoint: "https://s3.example.com", usePathStyleEndpoint: true, skipTlsVerification: false, unusableEmailSent: false };
    ids.s3 = (await insertS3Storage(tx, { orgId: A, uuid: "s3a", name: "Zeta", isUsable: true, ...s3 })).id;
    ids.s3off = (await insertS3Storage(tx, { orgId: A, uuid: "s3off", name: "Alpha", isUsable: false, ...s3 })).id;
  });
  await withOrg(ex, B, async (tx) => {
    ids.volumeb = (await insertPersistentVolume(tx, { orgId: B, owner: { type: APPLICATION_MORPH_CLASS, id: b.app }, uuid: "volb", name: "app-b-data", mountPath: "/data", hostPath: null })).id;
  });
  // A service of org A with one database that has a backup schedule.
  const svc = await admin<{ id: string | number }>("INSERT INTO deploy.services (uuid, name, environment_id, docker_compose_raw, org_id) VALUES ('svca', 'svc', $1, 'services: {}', $2) RETURNING id", [a.environment, A]);
  ids.service = svc[0]!.id;
  const part = await admin<{ id: string | number }>("INSERT INTO deploy.service_databases (uuid, name, image, status, service_id, org_id) VALUES ('dba', 'db', 'postgres:16', 'running:healthy', $1, $2) RETURNING id", [ids.service, A]);
  ids.serviceDb = part[0]!.id;
  await admin("INSERT INTO deploy.scheduled_database_backups (uuid, frequency, database_type, database_id, org_id, created_at, updated_at) VALUES ('dbbackupa', 'daily', $1, $2, $3, '2026-01-01 00:00:00', '2026-01-01 00:00:00')", [SERVICE_PART_MORPH_CLASS.database, ids.serviceDb, A]);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

const owners = () => [{ type: APPLICATION_MORPH_CLASS, id: ids.app! }];

describe("the storage backup pages' queries", () => {
  it("creates, lists and finds a resource's schedules with their targets; host directories and other orgs' storages are not targets", async () => {
    await withOrg(ex, A, async (tx) => {
      const vol = await insertVolumeBackupSchedule(tx, { orgId: A, uuid: "bvol", backupableType: PERSISTENT_VOLUME_MORPH_CLASS, backupableId: ids.volume!, frequency: "daily", enabled: true });
      await insertVolumeBackupSchedule(tx, { orgId: A, uuid: "bdir", backupableType: FILE_VOLUME_MORPH_CLASS, backupableId: ids.directory!, frequency: "hourly", enabled: false });
      await insertVolumeBackupSchedule(tx, { orgId: A, uuid: "bhost", backupableType: FILE_VOLUME_MORPH_CLASS, backupableId: ids.hostDirectory!, frequency: "hourly", enabled: true });
      ids.bvol = vol.id;
      await tx.execute("UPDATE deploy.scheduled_volume_backups SET created_at = '2026-01-01 00:00:00' WHERE uuid = 'bvol'");
      await tx.execute("UPDATE deploy.scheduled_volume_backups SET created_at = '2026-01-02 00:00:00' WHERE uuid IN ('bdir', 'bhost')");
      const list = await listVolumeBackupSchedules(tx, owners());
      expect(list.map((b) => [b.uuid, b.target_type, b.target_name, b.frequency, b.enabled, b.executions_count, b.latest_status])).toEqual([
        ["bdir", "Directory", "/srv/shared", "hourly", false, 0, null],
        ["bvol", "Volume", "app-a-data", "daily", true, 0, null],
      ]);
      expect(await findTargetVolumeBackupUuid(tx, PERSISTENT_VOLUME_MORPH_CLASS, ids.volume!)).toBe("bvol");
      const found = await findVolumeBackupSchedule(tx, owners(), "bvol");
      expect(found).toMatchObject({ uuid: "bvol", timeout: 36000, retention_amount_locally: 7, retention_max_storage_s3: 0, disable_local_backup: false });
      expect(await findVolumeBackupSchedule(tx, owners(), "bhost")).toBeNull();
      expect(await listVolumeBackupSchedules(tx, [])).toEqual([]);
    });
    await withOrg(ex, B, async (tx) => {
      expect(await listVolumeBackupSchedules(tx, owners())).toEqual([]);
      expect(await findVolumeBackupSchedule(tx, owners(), "bvol")).toBeNull();
    });
  });

  it("updates only what changes, and selects the pivot's storages, else the legacy one", async () => {
    await withOrg(ex, A, async (tx) => {
      await tx.execute("UPDATE deploy.scheduled_volume_backups SET updated_at = '2020-01-01 00:00:00' WHERE id = $1", [ids.bvol]);
      expect(await updateVolumeBackupSchedule(tx, ids.bvol!, { frequency: "daily", enabled: true, timeout: 36000, retention_max_storage_s3: 0 })).toBe(true);
      expect((await tx.execute<{ u: string }>("SELECT updated_at::text AS u FROM deploy.scheduled_volume_backups WHERE id = $1", [ids.bvol])).rows[0]!.u).toBe("2020-01-01 00:00:00");
      await updateVolumeBackupSchedule(tx, ids.bvol!, { frequency: "weekly", retention_max_storage_s3: 1.5 });
      expect((await findVolumeBackupSchedule(tx, owners(), "bvol"))).toMatchObject({ frequency: "weekly", retention_max_storage_s3: 1.5 });
      expect(await volumeBackupSelectedStorageIds(tx, ids.bvol!)).toEqual([]);
      await tx.execute("UPDATE deploy.scheduled_volume_backups SET s3_storage_id = $2, save_s3 = true WHERE id = $1", [ids.bvol, ids.s3off]);
      expect(await volumeBackupSelectedStorageIds(tx, ids.bvol!)).toEqual([String(ids.s3off)]);
      // The unusable storage stays selectable while it is selected; the list shows the legacy storage.
      expect((await selectableVolumeBackupS3Storages(tx, [String(ids.s3off)])).map((s) => s.name)).toEqual(["Alpha", "Zeta"]);
      expect((await selectableVolumeBackupS3Storages(tx, [])).map((s) => s.name)).toEqual(["Zeta"]);
      expect((await listVolumeBackupSchedules(tx, owners())).find((b) => b.uuid === "bvol")!.storages.map((s) => s.name)).toEqual(["Alpha"]);
      await syncScheduleS3Storages(tx, "volume", ids.bvol!, [ids.s3!], A);
      expect(await volumeBackupSelectedStorageIds(tx, ids.bvol!)).toEqual([String(ids.s3)]);
    });
    expect(await withOrg(ex, B, (tx) => updateVolumeBackupSchedule(tx, ids.bvol!, { frequency: "hourly" }))).toBe(false);
  });

  it("pages the executions newest first, cleans them up, deletes one, and knows a busy schedule and its archives", async () => {
    await withOrg(ex, A, async (tx) => {
      const add = (uuid: string, status: string, at: string, extra = "") =>
        tx.execute(`INSERT INTO deploy.scheduled_volume_backup_executions (uuid, scheduled_volume_backup_id, status, created_at, finished_at, org_id${extra ? ", filename, local_storage_deleted" : ""}) VALUES ($1, $2, $3, $4, $4, $5${extra})`, [uuid, ids.bvol, status, at, A]);
      await add("x1", "failed", "2026-01-01 00:00:00");
      await add("x2", "success", "2026-01-02 00:00:00", ", '/a.tar.gz', false");
      await add("x3", "running", "2026-01-03 00:00:00");
      const page = await listVolumeBackupExecutions(tx, ids.bvol!, 1, 2);
      expect([page.total, page.rows.map((r) => r.uuid)]).toEqual([3, ["x3", "x2"]]);
      expect((await listVolumeBackupExecutions(tx, ids.bvol!, 2, 2)).rows.map((r) => r.uuid)).toEqual(["x1"]);
      expect((await listVolumeBackupSchedules(tx, owners())).find((b) => b.uuid === "bvol")).toMatchObject({ latest_status: "running", executions_count: 3 });
      expect([await volumeBackupBusy(tx, ids.bvol!), await volumeBackupArchives(tx, ids.bvol!)]).toEqual([true, { local: 1, s3: 0 }]);
      expect(await cleanupVolumeBackupExecutions(tx, ids.bvol!, "failed")).toBe(1);
      expect(await cleanupVolumeBackupExecutions(tx, ids.bvol!, "deleted")).toBe(0);
      const running = page.rows[0]!;
      expect((await findVolumeBackupExecution(tx, ids.bvol!, running.id))?.status).toBe("running");
      expect(await deleteVolumeBackupExecution(tx, ids.bvol!, running.id)).toBe(true);
      expect(await volumeBackupBusy(tx, ids.bvol!)).toBe(false);
    });
    expect(await withOrg(ex, B, (tx) => listVolumeBackupExecutions(tx, ids.bvol!, 1, 10))).toEqual({ total: 0, rows: [] });
    expect(await withOrg(ex, B, (tx) => deleteVolumeBackupSchedule(tx, ids.bvol!))).toBe(false);
    await withOrg(ex, A, async (tx) => {
      expect(await deleteVolumeBackupSchedule(tx, ids.bvol!)).toBe(true);
      expect((await tx.execute("SELECT 1 FROM deploy.scheduled_volume_backup_executions WHERE scheduled_volume_backup_id = $1", [ids.bvol])).rows).toEqual([]);
      expect((await tx.execute("SELECT 1 FROM deploy.scheduled_volume_backup_s3_storage WHERE scheduled_volume_backup_id = $1", [ids.bvol])).rows).toEqual([]);
    });
  });

  it("lists an application's previews for the Preview Deployments page and saves its settings, template and DNS statuses (DP-99)", async () => {
    await withOrg(ex, A, async (tx) => {
      for (const [uuid, pr, deleted] of [["pv1", 3, false], ["pv2", 12, false], ["pv3", 7, true]] as const) {
        await tx.execute(
          "INSERT INTO deploy.application_previews (uuid, application_id, pull_request_id, pull_request_html_url, docker_registry_image_tag, deleted_at, org_id) VALUES ($1, $2, $3, '', 'pr', $4, $5)",
          [uuid, ids.app, pr, deleted ? "2026-01-01 00:00:00" : null, A],
        );
      }
      const rows = await listPreviewPageRows(tx, ids.app!);
      expect(rows.map((r) => [r.pull_request_id, r.docker_registry_image_tag, r.status])).toEqual([[12, "pr", "exited"], [3, "pr", "exited"]]);
      expect(await updatePreviewDeploymentSettings(tx, ids.app!, { isPreviewDeploymentsEnabled: true, isPrDeploymentsPublicEnabled: true })).toBe(true);
      expect((await tx.execute<{ a: boolean; b: boolean }>("SELECT is_preview_deployments_enabled AS a, is_pr_deployments_public_enabled AS b FROM deploy.application_settings WHERE application_id = $1", [ids.app])).rows[0]).toEqual({ a: true, b: true });
      expect(await updateApplicationPreviewUrlTemplate(tx, ids.app!, "pr-{{pr_id}}.{{domain}}")).toBe(true);
      expect((await tx.execute<{ t: string }>("SELECT preview_url_template AS t FROM deploy.applications WHERE id = $1", [ids.app])).rows[0]!.t).toBe("pr-{{pr_id}}.{{domain}}");
      await updatePreviewDnsStatuses(tx, rows[0]!.id, { k: { status: "pending" } });
      expect((await listPreviewPageRows(tx, ids.app!))[0]!.domain_dns_statuses).toEqual({ k: { status: "pending" } });
      await updatePreviewDnsStatuses(tx, rows[0]!.id, null);
      expect((await listPreviewPageRows(tx, ids.app!))[0]!.domain_dns_statuses).toBeNull();
    });
    await withOrg(ex, B, async (tx) => {
      expect(await listPreviewPageRows(tx, ids.app!)).toEqual([]);
      expect(await updatePreviewDeploymentSettings(tx, ids.app!, { isPreviewDeploymentsEnabled: false, isPrDeploymentsPublicEnabled: false })).toBe(false);
      expect(await updateApplicationPreviewUrlTemplate(tx, ids.app!, "x")).toBe(false);
    });
  });

  it("lists a service's databases' schedules and finds its database for the backups redirect; another org sees neither", async () => {
    const rows = await withOrg(ex, A, (tx) => listServiceDatabaseBackups(tx, ids.service!, SERVICE_PART_MORPH_CLASS.database));
    expect(rows.map((r) => [r.uuid, r.database_name, r.database_status, r.executions_count, r.storages])).toEqual([["dbbackupa", "db", "running:healthy", 0, []]]);
    expect(await withOrg(ex, A, (tx) => findServiceDatabaseBackupTarget(tx, ids.service!, "dba"))).toMatchObject({ uuid: "dba", image: "postgres:16", custom_type: null, is_migrated: false });
    expect(await withOrg(ex, A, (tx) => findServiceDatabaseBackupTarget(tx, ids.service!, "nope"))).toBeNull();
    expect(await withOrg(ex, B, (tx) => listServiceDatabaseBackups(tx, ids.service!, SERVICE_PART_MORPH_CLASS.database))).toEqual([]);
    expect(await withOrg(ex, B, (tx) => findServiceDatabaseBackupTarget(tx, ids.service!, "dba"))).toBeNull();
  });
});
