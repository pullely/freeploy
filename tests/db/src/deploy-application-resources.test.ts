// An application's storages, tags, move, clone and deletion (DP-55) against a
// real Postgres: the store functions of @saas/db/deploy inside withOrg() —
// volume, file and directory mounts as morph rows, tags and the taggables
// pivot (610 makes a tag name unique per org, not across orgs), what a clone
// replicates column for column, what a deletion removes row for row — and
// row-level security keeping each org's rows to itself.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  insertPrivateKey,
  insertServer,
  insertProject,
  insertDestination,
  insertEnvironment,
  insertDockerImageApplication,
  listServerDestinations,
  findApplicationByUuid,
  findApplicationConfiguration,
  updateApplicationConfiguration,
  updateApplicationSettings,
  listEnvironmentApplications,
  environmentHasResources,
  projectHasResources,
  destinationIsAttached,
  listDestinationResources,
  listPersistentVolumes,
  findPersistentVolume,
  insertPersistentVolume,
  updatePersistentVolume,
  deletePersistentVolume,
  listFileVolumes,
  findFileVolume,
  insertFileVolume,
  updateFileVolume,
  deleteFileVolume,
  listTags,
  listResourceTags,
  findTagByName,
  findTagById,
  insertTag,
  resourceHasTag,
  attachTag,
  detachTag,
  detachAllTags,
  copyResourceTags,
  listOperationEnvironments,
  listOperationServers,
  listOperationDestinations,
  findOperationEnvironment,
  moveApplication,
  replicateApplication,
  replicateApplicationSettings,
  listApplicationScheduledTaskIds,
  replicateScheduledTask,
  replicatePersistentVolume,
  replicateFileVolume,
  listApplicationEnvironmentVariableIds,
  replicateEnvironmentVariable,
  applicationHasDeployments,
  deleteApplication,
  APPLICATION_MORPH_CLASS,
  PERSISTENT_VOLUME_MORPH_CLASS,
  FILE_VOLUME_MORPH_CLASS,
  APPLICATION_WEBHOOK_SECRET_COLUMNS,
  type DeployDestinationRow,
  type NewDockerImageApplication,
  type StorageOwner,
} from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, deployDatabaseAfter, executor, migrationSql, sqlState } from "./deploy-schema.js";

// The step this suite tests by itself: what came before 610, then 610. Everything else runs on the schema at head.
const BEFORE_610 = ["500_deploy_core", "510_deploy_org_keys", "520_deploy_schema_fold_fixes"];
const TAGS_PER_ORG = migrationSql("610_deploy_tags_org_name_unique");
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const APP1 = "app1aaaaaaaaaaaaaaaaaaaa";
const APP2 = "app2aaaaaaaaaaaaaaaaaaaa";
const APPB = "app1bbbbbbbbbbbbbbbbbbbb";

let db: PGlite;
let ex: TransactionalSqlExecutor;

interface Fixture {
  serverId: string | number;
  destination: DeployDestinationRow;
  swarm: DeployDestinationRow;
  projectId: string | number;
  environmentId: string | number;
  stagingId: string | number;
}
const fx: Record<string, Fixture> = {};
const ids: Record<string, string | number> = {};

async function fixture(org: string, tag: string): Promise<Fixture> {
  return withOrg(ex, org, async (tx) => {
    const key = await insertPrivateKey(tx, { orgId: org, uuid: `key${tag}`, name: "key", description: null, privateKey: "fp1:fake", fingerprint: null });
    const server = await insertServer(tx, {
      orgId: org, uuid: `srv${tag}`, name: `server-${tag}`, description: null, ip: "203.0.113.10", user: "root", port: 22, privateKeyId: key.id,
      proxy: { type: "TRAEFIK", status: "exited" }, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: `dst${tag}`,
    });
    const destination = (await listServerDestinations(tx, server.id))[0]!;
    const swarm = await insertDestination(tx, { orgId: org, type: "swarm", uuid: `swm${tag}`, name: "overlay", network: "coolify-overlay", serverId: server.id });
    const { project, environment } = await insertProject(tx, { orgId: org, uuid: `prj${tag}`, name: `Project-${tag}`, description: null, productionEnvironmentUuid: `env${tag}` });
    const staging = await insertEnvironment(tx, { orgId: org, uuid: `stg${tag}`, name: "staging", projectId: project.id });
    return { serverId: server.id, destination, swarm, projectId: project.id, environmentId: environment.id, stagingId: staging.id };
  });
}

const newApp = (org: string, f: Fixture, uuid: string, over: Partial<NewDockerImageApplication> = {}): NewDockerImageApplication => ({
  orgId: org,
  uuid,
  name: `docker-image-${uuid}`,
  fqdn: `http://${uuid}.203.0.113.10.sslip.io`,
  domainPortOverrides: null,
  dockerRegistryImageName: "nginx",
  dockerRegistryImageTag: "latest",
  environmentId: f.environmentId,
  destinationId: f.destination.id,
  destinationType: "standalone",
  webhookSecrets: Object.fromEntries(APPLICATION_WEBHOOK_SECRET_COLUMNS.map((c) => [c, `fp1:${uuid}:${c}`])) as NewDockerImageApplication["webhookSecrets"],
  ...over,
});

const admin = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => asPlatformAdmin(ex, async (tx) => (await tx.execute<T>(sql, params)).rows);
const raw = (table: string, where: string, params: unknown[]) => admin<Record<string, unknown>>(`SELECT * FROM deploy.${table} WHERE ${where} ORDER BY 1`, params);
const count = async (table: string, where: string, params: unknown[]) => Number((await admin<{ n: number }>(`SELECT count(*)::int AS n FROM deploy.${table} WHERE ${where}`, params))[0]!.n);
const owner = (key: string): StorageOwner => ({ type: APPLICATION_MORPH_CLASS, id: ids[key]! });
/** A JSON column, whichever way the driver hands it back. */
const parsed = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);

beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
  fx.a = await fixture(A, "a");
  fx.b = await fixture(B, "b");
  ids.app1 = (await withOrg(ex, A, (tx) => insertDockerImageApplication(tx, newApp(A, fx.a!, APP1)))).id;
  ids.app2 = (await withOrg(ex, A, (tx) => insertDockerImageApplication(tx, newApp(A, fx.a!, APP2, { fqdn: null })))).id;
  ids.appb = (await withOrg(ex, B, (tx) => insertDockerImageApplication(tx, newApp(B, fx.b!, APPB)))).id;
}, 120_000);
afterAll(async () => db?.close());

describe("tag names are unique per org (610_deploy_tags_org_name_unique)", () => {
  it("500–520 refuse a name another org uses; 610 lets each org have it once", async () => {
    const step = await deployDatabaseAfter(BEFORE_610);
    try {
      const old = executor(step);
      // Before 610: a tag name one org uses is refused to every other org.
      await withOrg(old, A, (tx) => insertTag(tx, { orgId: A, uuid: "tag-early-a", name: "early" }));
      let sameNameBefore610 = true;
      try {
        await withOrg(old, B, (tx) => insertTag(tx, { orgId: B, uuid: "tag-early-b", name: "early" }));
      } catch {
        sameNameBefore610 = false;
      }
      expect(sameNameBefore610).toBe(false);
      await step.exec(TAGS_PER_ORG);
      const b = await withOrg(old, B, (tx) => insertTag(tx, { orgId: B, uuid: "tag-early-b", name: "early" }));
      expect(b.name).toBe("early");
      await expect(withOrg(old, A, (tx) => insertTag(tx, { orgId: A, uuid: "tag-early-a2", name: "early" }))).rejects.toThrow();
      // Applying it again changes nothing.
      await step.exec(TAGS_PER_ORG);
      expect((await step.query<{ n: number }>("SELECT count(*)::int AS n FROM deploy.tags WHERE name = 'early'")).rows[0]!.n).toBe(2);
    } finally {
      await step.close();
    }
  }, 120_000);

  it("holds on the schema at head", async () => {
    await withOrg(ex, A, (tx) => insertTag(tx, { orgId: A, uuid: "tag-early-a", name: "early" }));
    const b = await withOrg(ex, B, (tx) => insertTag(tx, { orgId: B, uuid: "tag-early-b", name: "early" }));
    expect(b.name).toBe("early");
    expect(await sqlState(() => withOrg(ex, A, (tx) => insertTag(tx, { orgId: A, uuid: "tag-early-a2", name: "early" })))).toBe("23505");
    expect(await count("tags", "name = 'early'", [])).toBe(2);
  });
});

describe("persistent volumes (deploy.local_persistent_volumes)", () => {
  it("adds, lists, updates and deletes a resource's volumes", async () => {
    const created = await withOrg(ex, A, (tx) => insertPersistentVolume(tx, { orgId: A, owner: owner("app1"), uuid: "vol1", name: `${APP1}-data`, mountPath: "/data", hostPath: null }));
    expect(created).toMatchObject({
      uuid: "vol1", name: `${APP1}-data`, mount_path: "/data", host_path: null, is_preview_suffix_enabled: true, standalone_sqlite_id: null,
      ignores_compose_driver_options: false, backup_enabled: null, backup_save_s3: null, has_backups: false,
    });
    const second = await withOrg(ex, A, (tx) => insertPersistentVolume(tx, { orgId: A, owner: owner("app1"), uuid: "vol2", name: `${APP1}-cache`, mountPath: "/cache", hostPath: "/srv/cache" }));
    expect((await withOrg(ex, A, (tx) => listPersistentVolumes(tx, owner("app1")))).map((v) => [v.name, v.mount_path, v.host_path])).toEqual([
      [`${APP1}-data`, "/data", null],
      [`${APP1}-cache`, "/cache", "/srv/cache"],
    ]);
    expect(await withOrg(ex, A, (tx) => listPersistentVolumes(tx, owner("app2")))).toEqual([]);
    const row = (await raw("local_persistent_volumes", "id = $1", [created.id]))[0]!;
    expect(row).toMatchObject({ resource_type: "App\\Models\\Application", resource_id: ids.app1, org_id: A, container_id: null });
    expect(row.created_at).not.toBeNull();

    // Only the given columns.
    expect(await withOrg(ex, A, (tx) => updatePersistentVolume(tx, owner("app1"), created.id, { mount_path: "/var/data" }))).toBe(true);
    expect(await withOrg(ex, A, (tx) => findPersistentVolume(tx, owner("app1"), created.id))).toMatchObject({ name: `${APP1}-data`, mount_path: "/var/data", is_preview_suffix_enabled: true });
    expect(await withOrg(ex, A, (tx) => updatePersistentVolume(tx, owner("app1"), created.id, { name: `${APP1}-renamed`, is_preview_suffix_enabled: false }))).toBe(true);
    expect(await withOrg(ex, A, (tx) => findPersistentVolume(tx, owner("app1"), created.id))).toMatchObject({ name: `${APP1}-renamed`, mount_path: "/var/data", is_preview_suffix_enabled: false });
    // Another resource's volume is not found, updated or deleted through this one.
    expect(await withOrg(ex, A, (tx) => findPersistentVolume(tx, owner("app2"), created.id))).toBeNull();
    expect(await withOrg(ex, A, (tx) => updatePersistentVolume(tx, owner("app2"), created.id, { mount_path: "/x" }))).toBe(false);
    expect(await withOrg(ex, A, (tx) => deletePersistentVolume(tx, owner("app2"), created.id))).toBe(false);

    expect(await withOrg(ex, A, (tx) => deletePersistentVolume(tx, owner("app1"), second.id))).toBe(true);
    expect(await withOrg(ex, A, (tx) => deletePersistentVolume(tx, owner("app1"), second.id))).toBe(false);
    expect((await withOrg(ex, A, (tx) => listPersistentVolumes(tx, owner("app1")))).map((v) => v.uuid)).toEqual(["vol1"]);
  });

  it("reads a volume's backup schedule (scheduledBackups)", async () => {
    const volume = (await withOrg(ex, A, (tx) => listPersistentVolumes(tx, owner("app1"))))[0]!;
    await admin("INSERT INTO deploy.scheduled_volume_backups (uuid, backupable_type, backupable_id, frequency, enabled, save_s3, org_id) VALUES ('bak1', $1, $2, 'daily', true, true, $3)", [
      PERSISTENT_VOLUME_MORPH_CLASS, volume.id, A,
    ]);
    expect(await withOrg(ex, A, (tx) => findPersistentVolume(tx, owner("app1"), volume.id))).toMatchObject({ backup_enabled: true, backup_save_s3: true, has_backups: true });
    // A directory's schedule with the same id is another morph.
    await admin("UPDATE deploy.scheduled_volume_backups SET backupable_type = $1 WHERE uuid = 'bak1'", [FILE_VOLUME_MORPH_CLASS]);
    expect(await withOrg(ex, A, (tx) => findPersistentVolume(tx, owner("app1"), volume.id))).toMatchObject({ backup_enabled: null, has_backups: false });
    await admin("DELETE FROM deploy.scheduled_volume_backups WHERE uuid = 'bak1'");
  });

  it("keeps each org's volumes to itself (row-level security)", async () => {
    const volume = (await withOrg(ex, A, (tx) => listPersistentVolumes(tx, owner("app1"))))[0]!;
    expect(await withOrg(ex, B, (tx) => listPersistentVolumes(tx, owner("app1")))).toEqual([]);
    expect(await withOrg(ex, B, (tx) => findPersistentVolume(tx, owner("app1"), volume.id))).toBeNull();
    expect(await withOrg(ex, B, (tx) => updatePersistentVolume(tx, owner("app1"), volume.id, { mount_path: "/stolen" }))).toBe(false);
    expect(await withOrg(ex, B, (tx) => deletePersistentVolume(tx, owner("app1"), volume.id))).toBe(false);
    await expect(withOrg(ex, B, (tx) => insertPersistentVolume(tx, { orgId: A, owner: owner("app1"), uuid: "volx", name: "x", mountPath: "/x", hostPath: null }))).rejects.toThrow();
    expect((await raw("local_persistent_volumes", "id = $1", [volume.id]))[0]!.mount_path).toBe("/var/data");
  });
});

describe("file and directory mounts (deploy.local_file_volumes)", () => {
  it("adds a file, a host file and a directory; saves a file's content and flags; deletes a mount", async () => {
    const file = await withOrg(ex, A, (tx) =>
      insertFileVolume(tx, { orgId: A, owner: owner("app1"), uuid: "fil1", fsPath: `/data/coolify/applications/${APP1}/etc/app.conf`, mountPath: "/etc/app.conf", content: "fp1:1:iv:ct", isDirectory: false, isHostFile: false }),
    );
    expect(file).toMatchObject({
      uuid: "fil1", fs_path: `/data/coolify/applications/${APP1}/etc/app.conf`, mount_path: "/etc/app.conf", content: "fp1:1:iv:ct", is_directory: false, is_host_file: false,
      is_based_on_git: false, is_preview_suffix_enabled: true, variable_fs_path: null, chown: null, chmod: null, has_backups: false,
    });
    const host = await withOrg(ex, A, (tx) => insertFileVolume(tx, { orgId: A, owner: owner("app1"), uuid: "fil2", fsPath: "/etc/hosts", mountPath: "/etc/hosts", content: null, isDirectory: false, isHostFile: true }));
    const directory = await withOrg(ex, A, (tx) => insertFileVolume(tx, { orgId: A, owner: owner("app1"), uuid: "dir1", fsPath: "/srv/uploads", mountPath: "/uploads", content: null, isDirectory: true, isHostFile: false }));
    expect((await withOrg(ex, A, (tx) => listFileVolumes(tx, owner("app1")))).map((f) => [f.uuid, f.is_directory, f.is_host_file, f.content])).toEqual([
      ["fil1", false, false, "fp1:1:iv:ct"],
      ["fil2", false, true, null],
      ["dir1", true, false, null],
    ]);
    expect((await raw("local_file_volumes", "id = $1", [file.id]))[0]).toMatchObject({ resource_type: "App\\Models\\Application", resource_id: ids.app1, org_id: A });

    expect(await withOrg(ex, A, (tx) => updateFileVolume(tx, owner("app1"), file.id, { content: "fp1:1:iv2:ct2" }))).toBe(true);
    expect(await withOrg(ex, A, (tx) => findFileVolume(tx, owner("app1"), file.id))).toMatchObject({ content: "fp1:1:iv2:ct2", is_based_on_git: false, is_preview_suffix_enabled: true });
    expect(await withOrg(ex, A, (tx) => updateFileVolume(tx, owner("app1"), file.id, { content: null, is_based_on_git: true, is_preview_suffix_enabled: false }))).toBe(true);
    expect(await withOrg(ex, A, (tx) => findFileVolume(tx, owner("app1"), file.id))).toMatchObject({ content: null, is_based_on_git: true, is_preview_suffix_enabled: false });
    expect(await withOrg(ex, A, (tx) => updateFileVolume(tx, owner("app2"), file.id, { content: "x" }))).toBe(false);
    expect(await withOrg(ex, A, (tx) => findFileVolume(tx, owner("app2"), file.id))).toBeNull();

    expect(await withOrg(ex, A, (tx) => deleteFileVolume(tx, owner("app2"), host.id))).toBe(false);
    expect(await withOrg(ex, A, (tx) => deleteFileVolume(tx, owner("app1"), host.id))).toBe(true);
    expect((await withOrg(ex, A, (tx) => listFileVolumes(tx, owner("app1")))).map((f) => f.uuid)).toEqual(["fil1", "dir1"]);

    // Row-level security.
    expect(await withOrg(ex, B, (tx) => listFileVolumes(tx, owner("app1")))).toEqual([]);
    expect(await withOrg(ex, B, (tx) => findFileVolume(tx, owner("app1"), directory.id))).toBeNull();
    expect(await withOrg(ex, B, (tx) => updateFileVolume(tx, owner("app1"), file.id, { content: "stolen" }))).toBe(false);
    expect(await withOrg(ex, B, (tx) => deleteFileVolume(tx, owner("app1"), directory.id))).toBe(false);
  });
});

describe("tags and the taggables pivot (deploy.tags, deploy.taggables)", () => {
  const app = (key: string) => ({ type: APPLICATION_MORPH_CLASS, id: ids[key]! });

  it("creates tags for the org, attaches and detaches them; the tag outlives its last resource", async () => {
    const production = await withOrg(ex, A, (tx) => insertTag(tx, { orgId: A, uuid: "tag-prod", name: "production" }));
    const api = await withOrg(ex, A, (tx) => insertTag(tx, { orgId: A, uuid: "tag-api", name: "api" }));
    expect((await raw("tags", "id = $1", [production.id]))[0]).toMatchObject({ uuid: "tag-prod", name: "production", org_id: A });
    // By name.
    expect((await withOrg(ex, A, (tx) => listTags(tx))).map((t) => t.name)).toEqual(["api", "early", "production"]);
    expect(await withOrg(ex, A, (tx) => findTagByName(tx, "production"))).toMatchObject({ id: production.id });
    expect(await withOrg(ex, A, (tx) => findTagByName(tx, "Production"))).toBeNull();
    expect(await withOrg(ex, A, (tx) => findTagById(tx, api.id))).toMatchObject({ name: "api" });
    expect(await withOrg(ex, A, (tx) => findTagById(tx, 999_999))).toBeNull();

    await withOrg(ex, A, (tx) => attachTag(tx, A, app("app1"), production.id));
    await withOrg(ex, A, (tx) => attachTag(tx, A, app("app1"), api.id));
    await withOrg(ex, A, (tx) => attachTag(tx, A, app("app2"), api.id));
    expect((await withOrg(ex, A, (tx) => listResourceTags(tx, app("app1")))).map((t) => t.name)).toEqual(["production", "api"]);
    expect((await withOrg(ex, A, (tx) => listResourceTags(tx, app("app2")))).map((t) => t.name)).toEqual(["api"]);
    expect(await withOrg(ex, A, (tx) => resourceHasTag(tx, app("app1"), production.id))).toBe(true);
    expect(await withOrg(ex, A, (tx) => resourceHasTag(tx, app("app2"), production.id))).toBe(false);
    // The same id under another resource type is another resource.
    expect(await withOrg(ex, A, (tx) => listResourceTags(tx, { type: "App\\Models\\Service", id: ids.app1! }))).toEqual([]);
    expect((await raw("taggables", "taggable_id = $1", [ids.app2]))[0]).toMatchObject({ taggable_type: "App\\Models\\Application", tag_id: api.id, org_id: A });

    expect(await withOrg(ex, A, (tx) => detachTag(tx, app("app2"), api.id))).toBe(true);
    expect(await withOrg(ex, A, (tx) => detachTag(tx, app("app2"), api.id))).toBe(false);
    expect(await withOrg(ex, A, (tx) => listResourceTags(tx, app("app2")))).toEqual([]);
    expect(await withOrg(ex, A, (tx) => findTagById(tx, api.id))).not.toBeNull();
  });

  it("copies a resource's tags to another, and detaches all of a resource's", async () => {
    await withOrg(ex, A, (tx) => copyResourceTags(tx, app("app1"), app("app2")));
    expect((await withOrg(ex, A, (tx) => listResourceTags(tx, app("app2")))).map((t) => t.name)).toEqual(["production", "api"]);
    expect((await raw("taggables", "taggable_id = $1", [ids.app2])).every((p) => p.org_id === A && p.taggable_type === "App\\Models\\Application")).toBe(true);
    await withOrg(ex, A, (tx) => detachAllTags(tx, app("app2")));
    expect(await withOrg(ex, A, (tx) => listResourceTags(tx, app("app2")))).toEqual([]);
    expect((await withOrg(ex, A, (tx) => listResourceTags(tx, app("app1")))).length).toBe(2);
  });

  it("keeps each org's tags to itself (row-level security)", async () => {
    const production = (await withOrg(ex, A, (tx) => findTagByName(tx, "production")))!;
    expect((await withOrg(ex, B, (tx) => listTags(tx))).map((t) => t.name)).toEqual(["early"]);
    expect(await withOrg(ex, B, (tx) => findTagByName(tx, "production"))).toBeNull();
    expect(await withOrg(ex, B, (tx) => findTagById(tx, production.id))).toBeNull();
    expect(await withOrg(ex, B, (tx) => listResourceTags(tx, app("app1")))).toEqual([]);
    expect(await withOrg(ex, B, (tx) => detachTag(tx, app("app1"), production.id))).toBe(false);
    await expect(withOrg(ex, B, (tx) => attachTag(tx, A, app("app1"), production.id))).rejects.toThrow();
    // Org B's own "production" is another tag.
    const own = await withOrg(ex, B, (tx) => insertTag(tx, { orgId: B, uuid: "tag-prod-b", name: "production" }));
    expect(own.id).not.toBe(production.id);
    expect((await withOrg(ex, A, (tx) => listResourceTags(tx, app("app1")))).length).toBe(2);
  });
});

describe("where an application can be moved or cloned to, and the move", () => {
  it("lists the org's projects by name with their environments, its servers and their destinations", async () => {
    await withOrg(ex, A, (tx) => insertProject(tx, { orgId: A, uuid: "prjz", name: "alpha", description: null, productionEnvironmentUuid: "envz" }));
    const environments = await withOrg(ex, A, (tx) => listOperationEnvironments(tx));
    // LOWER(name): "alpha" before "Project-a".
    expect(environments.map((e) => [e.project_uuid, e.project_name, e.environment_uuid, e.environment_name])).toEqual([
      ["prjz", "alpha", "envz", "production"],
      ["prja", "Project-a", "enva", "production"],
      ["prja", "Project-a", "stga", "staging"],
    ]);
    const servers = await withOrg(ex, A, (tx) => listOperationServers(tx));
    expect(servers).toMatchObject([{ uuid: "srva", name: "server-a", ip: "203.0.113.10", server_role: "both", force_disabled: false }]);
    const destinations = await withOrg(ex, A, (tx) => listOperationDestinations(tx));
    expect(destinations.map((d) => [d.uuid, d.type, d.server_id])).toEqual([
      ["dsta", "standalone", fx.a!.serverId],
      ["swma", "swarm", fx.a!.serverId],
    ]);
    expect(await withOrg(ex, A, (tx) => findOperationEnvironment(tx, "stga"))).toMatchObject({ id: fx.a!.stagingId, uuid: "stga", name: "staging", project_uuid: "prja" });
    // Another org's environment is not a target.
    expect(await withOrg(ex, A, (tx) => findOperationEnvironment(tx, "envb"))).toBeNull();
    expect((await withOrg(ex, B, (tx) => listOperationEnvironments(tx))).map((e) => e.project_uuid)).toEqual(["prjb", "prjb"]);
    expect((await withOrg(ex, B, (tx) => listOperationServers(tx))).map((s) => s.uuid)).toEqual(["srvb"]);
    expect((await withOrg(ex, B, (tx) => listOperationDestinations(tx))).map((d) => d.uuid)).toEqual(["dstb", "swmb"]);
  });

  it("moves an application to another environment: one column", async () => {
    const before = (await raw("applications", "id = $1", [ids.app2]))[0]!;
    expect(await withOrg(ex, A, (tx) => moveApplication(tx, ids.app2!, fx.a!.stagingId))).toBe(true);
    const after = (await raw("applications", "id = $1", [ids.app2]))[0]!;
    expect(after.environment_id).toBe(fx.a!.stagingId);
    expect({ ...after, environment_id: null, updated_at: null }).toEqual({ ...before, environment_id: null, updated_at: null });
    expect((await withOrg(ex, A, (tx) => listEnvironmentApplications(tx, fx.a!.stagingId))).map((a) => a.uuid)).toEqual([APP2]);
    expect(await withOrg(ex, A, (tx) => findApplicationByUuid(tx, APP2))).toMatchObject({ environment_uuid: "stga", project_uuid: "prja" });
    // Another org cannot move it.
    expect(await withOrg(ex, B, (tx) => moveApplication(tx, ids.app2!, fx.b!.environmentId))).toBe(false);
    expect(await withOrg(ex, A, (tx) => moveApplication(tx, 999_999, fx.a!.stagingId))).toBe(false);
    await withOrg(ex, A, (tx) => moveApplication(tx, ids.app2!, fx.a!.environmentId));
  });
});

describe("cloning an application (clone_application's replicas)", () => {
  const CLONE = "clone1aaaaaaaaaaaaaaaaaa";
  /** What the source application carries besides the mounts and tags of the tests above. */
  beforeAll(async () => {
    await withOrg(ex, A, async (tx) => {
      await updateApplicationConfiguration(tx, ids.app1!, { health_check_enabled: true, health_check_path: "/healthz", limits_memory: "512m", redirect: "www", domain_dns_statuses: JSON.stringify({ x: 1 }) });
      await updateApplicationSettings(tx, ids.app1!, { is_gzip_enabled: false, custom_internal_name: "shop", stop_grace_period: 45 });
    });
    await admin("UPDATE deploy.applications SET status = 'running:healthy', custom_labels = 'bGFiZWxz', description = 'the shop' WHERE id = $1", [ids.app1]);
    await admin(
      `INSERT INTO deploy.environment_variables (uuid, key, value, is_preview, is_multiline, comment, resourceable_type, resourceable_id, org_id)
       VALUES ('ev1', 'API_KEY', 'fp1:1:iv:secret', false, false, 'the key', $1, $2, $3), ('ev2', 'API_KEY', 'fp1:1:iv:preview', true, true, null, $1, $2, $3)`,
      [APPLICATION_MORPH_CLASS, ids.app1, A],
    );
    await admin("INSERT INTO deploy.scheduled_tasks (uuid, name, command, frequency, application_id, org_id) VALUES ('task1', 'prune', 'php artisan prune', '@daily', $1, $2)", [ids.app1, A]);
  });

  it("replicates the application's row column for column, with what clone_application fills in", async () => {
    const source = (await raw("applications", "id = $1", [ids.app1]))[0]!;
    const id = await withOrg(ex, A, (tx) =>
      replicateApplication(tx, ids.app1!, {
        uuid: CLONE,
        name: `clone-of-docker-image-app1aaaaa...-${CLONE}`,
        fqdn: `http://${CLONE}.203.0.113.10.sslip.io`,
        domainPortOverrides: null,
        customLabels: null,
        environmentId: fx.a!.stagingId,
        destinationId: fx.a!.swarm.id,
        destinationType: "swarm",
      }),
    );
    ids.clone = id!;
    expect(id).not.toBe(ids.app1);
    const clone = (await raw("applications", "id = $1", [id]))[0]!;
    const filled = {
      id: null, uuid: null, name: null, fqdn: null, status: null, environment_id: null, destination_id: null, destination_type: null, custom_labels: null,
      compose_parsing_version: null, last_online_at: null, created_at: null, updated_at: null,
    };
    // Every other column is the source's: the image, the health check, the limits, the webhook secrets as stored…
    expect({ ...clone, ...filled }).toEqual({ ...source, ...filled });
    expect(clone).toMatchObject({
      uuid: CLONE,
      name: `clone-of-docker-image-app1aaaaa...-${CLONE}`,
      fqdn: `http://${CLONE}.203.0.113.10.sslip.io`,
      status: "exited:unhealthy", // the status mutator adds the health (DP-86)
      environment_id: fx.a!.stagingId,
      destination_id: fx.a!.swarm.id,
      destination_type: "App\\Models\\SwarmDocker",
      custom_labels: null,
      compose_parsing_version: "5",
      description: "the shop",
      health_check_path: "/healthz",
      limits_memory: "512m",
      redirect: "www",
      manual_webhook_secret_github: `fp1:${APP1}:manual_webhook_secret_github`,
      org_id: A,
      deleted_at: null,
    });
    expect(clone.last_online_at).not.toBeNull();
    expect(source.status).toBe("running:healthy");

    // customLabels undefined keeps the source's labels; a source that is gone is null.
    const kept = await withOrg(ex, A, (tx) =>
      replicateApplication(tx, ids.app1!, {
        uuid: "clone2aaaaaaaaaaaaaaaaaa", name: "kept", fqdn: source.fqdn as string, domainPortOverrides: JSON.stringify({ [source.fqdn as string]: 3000 }), noindexDomains: "[]",
        environmentId: fx.a!.environmentId, destinationId: fx.a!.destination.id, destinationType: "standalone",
      }),
    );
    const keptRow = (await raw("applications", "id = $1", [kept]))[0]!;
    expect(keptRow).toMatchObject({ custom_labels: "bGFiZWxz", destination_type: "App\\Models\\StandaloneDocker", fqdn: source.fqdn });
    // The JSON columns take their text.
    expect(parsed(keptRow.domain_port_overrides)).toEqual({ [source.fqdn as string]: 3000 });
    expect(parsed(keptRow.noindex_domains)).toEqual([]);
    // Left out, the noindex flags are the source's.
    expect(clone.noindex_domains).toEqual(source.noindex_domains);
    await admin("DELETE FROM deploy.applications WHERE id = $1", [kept]);
    expect(await withOrg(ex, A, (tx) => replicateApplication(tx, 999_999, { uuid: "x", name: "x", fqdn: null, domainPortOverrides: null, noindexDomains: null, environmentId: 1, destinationId: 1, destinationType: "standalone" }))).toBeNull();
  });

  it("replicates the settings row in place of the one the created hook would make", async () => {
    await admin("INSERT INTO deploy.application_settings (application_id, org_id) VALUES ($1, $2)", [ids.clone, A]);
    expect(await withOrg(ex, A, (tx) => replicateApplicationSettings(tx, ids.app1!, ids.clone!))).toBe(true);
    const [source] = await raw("application_settings", "application_id = $1", [ids.app1]);
    const settings = await raw("application_settings", "application_id = $1", [ids.clone]);
    expect(settings).toHaveLength(1);
    const own = { id: null, application_id: null, created_at: null, updated_at: null };
    expect({ ...settings[0]!, ...own }).toEqual({ ...source!, ...own });
    expect(settings[0]).toMatchObject({ is_gzip_enabled: false, custom_internal_name: "shop", stop_grace_period: 45, application_id: ids.clone });
    expect(await withOrg(ex, A, (tx) => findApplicationConfiguration(tx, CLONE))).toMatchObject({ custom_internal_name: "shop", server_uuid: "srva" });
  });

  it("replicates volumes, mounts, environment variables and scheduled tasks; each copy has its own uuid", async () => {
    const volume = (await withOrg(ex, A, (tx) => listPersistentVolumes(tx, owner("app1"))))[0]!;
    await admin("UPDATE deploy.local_persistent_volumes SET ignores_compose_driver_options = true, standalone_sqlite_id = 7 WHERE id = $1", [volume.id]);
    await withOrg(ex, A, (tx) => replicatePersistentVolume(tx, volume.id, { uuid: "vol1-clone", name: `${CLONE}-renamed`, resourceId: ids.clone! }));
    expect(await withOrg(ex, A, (tx) => listPersistentVolumes(tx, owner("clone")))).toMatchObject([
      // The replicating hook: a new Docker volume; no SQLite link.
      { uuid: "vol1-clone", name: `${CLONE}-renamed`, mount_path: "/var/data", host_path: null, is_preview_suffix_enabled: false, ignores_compose_driver_options: false, standalone_sqlite_id: null },
    ]);
    await admin("UPDATE deploy.local_persistent_volumes SET ignores_compose_driver_options = false, standalone_sqlite_id = null WHERE id = $1", [volume.id]);

    for (const [i, f] of (await withOrg(ex, A, (tx) => listFileVolumes(tx, owner("app1")))).entries()) {
      await withOrg(ex, A, (tx) => replicateFileVolume(tx, f.id, { uuid: `mount-clone-${i}`, resourceId: ids.clone! }));
    }
    expect((await withOrg(ex, A, (tx) => listFileVolumes(tx, owner("clone")))).map((f) => [f.uuid, f.fs_path, f.mount_path, f.is_directory, f.is_based_on_git, f.content])).toEqual([
      // The source's host path stays as stored, as in Coolify.
      ["mount-clone-0", `/data/coolify/applications/${APP1}/etc/app.conf`, "/etc/app.conf", false, true, null],
      ["mount-clone-1", "/srv/uploads", "/uploads", true, false, null],
    ]);

    const variables = await withOrg(ex, A, (tx) => listApplicationEnvironmentVariableIds(tx, ids.app1!));
    expect(variables).toHaveLength(2);
    for (const [i, variable] of variables.entries()) await withOrg(ex, A, (tx) => replicateEnvironmentVariable(tx, variable, { uuid: `ev-clone-${i}`, applicationId: ids.clone! }));
    const copies = await raw("environment_variables", "resourceable_id = $1", [ids.clone]);
    expect(copies.map((v) => [v.uuid, v.key, v.value, v.is_preview, v.is_multiline, v.comment, v.resourceable_type, v.org_id])).toEqual([
      // The ciphertext as stored: it is bound to the org and the column, not to the row.
      ["ev-clone-0", "API_KEY", "fp1:1:iv:secret", false, false, "the key", "App\\Models\\Application", A],
      ["ev-clone-1", "API_KEY", "fp1:1:iv:preview", true, true, null, "App\\Models\\Application", A],
    ]);
    expect(await count("environment_variables", "resourceable_id = $1", [ids.app1])).toBe(2);

    const tasks = await withOrg(ex, A, (tx) => listApplicationScheduledTaskIds(tx, ids.app1!));
    expect(tasks).toHaveLength(1);
    await withOrg(ex, A, (tx) => replicateScheduledTask(tx, tasks[0]!, { uuid: "task1-clone", applicationId: ids.clone! }));
    expect(await raw("scheduled_tasks", "application_id = $1", [ids.clone])).toMatchObject([{ uuid: "task1-clone", name: "prune", command: "php artisan prune", frequency: "@daily", enabled: true, org_id: A }]);

    await withOrg(ex, A, (tx) => copyResourceTags(tx, owner("app1"), owner("clone")));
    expect((await withOrg(ex, A, (tx) => listResourceTags(tx, owner("clone")))).map((t) => t.name)).toEqual(["production", "api"]);
  });

  it("another org cannot replicate it (row-level security)", async () => {
    expect(
      await withOrg(ex, B, (tx) =>
        replicateApplication(tx, ids.app1!, { uuid: "stolen", name: "stolen", fqdn: null, domainPortOverrides: null, noindexDomains: null, environmentId: fx.b!.environmentId, destinationId: fx.b!.destination.id, destinationType: "standalone" }),
      ),
    ).toBeNull();
    expect(await withOrg(ex, B, (tx) => replicateApplicationSettings(tx, ids.app1!, ids.appb!))).toBe(false);
    expect(await withOrg(ex, B, (tx) => listApplicationEnvironmentVariableIds(tx, ids.app1!))).toEqual([]);
    expect(await count("applications", "uuid = 'stolen'", [])).toBe(0);
    // replicateApplicationSettings deletes the target's row first: put org B's back.
    await admin("INSERT INTO deploy.application_settings (application_id, org_id) VALUES ($1, $2)", [ids.appb, B]);
  });
});

describe("deleting an application (DeleteResourceJob::deleteLocalResource and the forceDeleting hook)", () => {
  it("knows whether a deployment was ever queued for it", async () => {
    expect(await withOrg(ex, A, (tx) => applicationHasDeployments(tx, ids.clone!))).toBe(false);
    await admin("INSERT INTO deploy.application_deployment_queues (application_id, deployment_uuid, org_id) VALUES ($1, 'dep1', $2)", [String(ids.clone), A]);
    expect(await withOrg(ex, A, (tx) => applicationHasDeployments(tx, ids.clone!))).toBe(true);
    expect(await withOrg(ex, A, (tx) => applicationHasDeployments(tx, ids.app2!))).toBe(false);
    expect(await withOrg(ex, B, (tx) => applicationHasDeployments(tx, ids.clone!))).toBe(false);
  });

  it("removes the application with everything that belongs to it, and nothing else", async () => {
    const clone = ids.clone!;
    const volume = (await withOrg(ex, A, (tx) => listPersistentVolumes(tx, owner("clone"))))[0]!;
    const directory = (await withOrg(ex, A, (tx) => listFileVolumes(tx, owner("clone")))).find((f) => f.is_directory)!;
    const task = (await raw("scheduled_tasks", "application_id = $1", [clone]))[0]!;
    await admin(
      `INSERT INTO deploy.scheduled_volume_backups (uuid, backupable_type, backupable_id, frequency, org_id) VALUES ('bak-v', $1, $2, 'daily', $5), ('bak-d', $3, $4, 'daily', $5)`,
      [PERSISTENT_VOLUME_MORPH_CLASS, volume.id, FILE_VOLUME_MORPH_CLASS, directory.id, A],
    );
    const [schedule] = await raw("scheduled_volume_backups", "uuid = 'bak-v'", []);
    await admin("INSERT INTO deploy.scheduled_volume_backup_executions (uuid, scheduled_volume_backup_id, org_id) VALUES ('exe1', $1, $2)", [schedule!.id, A]);
    await admin("INSERT INTO deploy.scheduled_volume_backup_s3_storage (scheduled_volume_backup_id, s3_storage_id, org_id) VALUES ($1, 1, $2)", [schedule!.id, A]);
    await admin("INSERT INTO deploy.scheduled_task_executions (uuid, scheduled_task_id, org_id) VALUES ('texe1', $1, $2)", [task.id, A]);
    await admin("INSERT INTO deploy.secret_manager_links (uuid, resourceable_type, resourceable_id, integration_token_id, org_id) VALUES ('sml1', $1, $2, 1, $3)", [APPLICATION_MORPH_CLASS, clone, A]);
    await admin("INSERT INTO deploy.application_previews (uuid, pull_request_id, pull_request_html_url, application_id, org_id) VALUES ('prev1', 3, 'https://example.com/pr/3', $1, $2)", [clone, A]);

    const left = async () => ({
      applications: await count("applications", "id = $1", [clone]),
      settings: await count("application_settings", "application_id = $1", [clone]),
      volumes: await count("local_persistent_volumes", "resource_type = $2 AND resource_id = $1", [clone, APPLICATION_MORPH_CLASS]),
      mounts: await count("local_file_volumes", "resource_type = $2 AND resource_id = $1", [clone, APPLICATION_MORPH_CLASS]),
      variables: await count("environment_variables", "resourceable_type = $2 AND resourceable_id = $1", [clone, APPLICATION_MORPH_CLASS]),
      tags: await count("taggables", "taggable_type = $2 AND taggable_id = $1", [clone, APPLICATION_MORPH_CLASS]),
      tasks: await count("scheduled_tasks", "application_id = $1", [clone]),
      taskExecutions: await count("scheduled_task_executions", "uuid = 'texe1'", []),
      schedules: await count("scheduled_volume_backups", "uuid IN ('bak-v', 'bak-d')", []),
      scheduleExecutions: await count("scheduled_volume_backup_executions", "uuid = 'exe1'", []),
      scheduleStorages: await count("scheduled_volume_backup_s3_storage", "scheduled_volume_backup_id = $1", [schedule!.id]),
      links: await count("secret_manager_links", "uuid = 'sml1'", []),
      previews: await count("application_previews", "application_id = $1", [clone]),
      deployments: await count("application_deployment_queues", "application_id = $1", [String(clone)]),
    });
    expect(await left()).toEqual({
      applications: 1, settings: 1, volumes: 1, mounts: 2, variables: 2, tags: 2, tasks: 1, taskExecutions: 1, schedules: 2, scheduleExecutions: 1, scheduleStorages: 1, links: 1, previews: 1, deployments: 1,
    });
    const others = async () => ({
      applications: await count("applications", "true", []),
      settings: await count("application_settings", "true", []),
      volumes: await count("local_persistent_volumes", "true", []),
      mounts: await count("local_file_volumes", "true", []),
      variables: await count("environment_variables", "true", []),
      pivots: await count("taggables", "true", []),
      tags: await count("tags", "true", []),
      tasks: await count("scheduled_tasks", "true", []),
    });
    const before = await others();

    // Another org deletes nothing.
    expect(await withOrg(ex, B, (tx) => deleteApplication(tx, clone))).toBe(false);
    expect((await left()).applications).toBe(1);
    expect(await others()).toEqual(before);

    // The guards see the application while it is there.
    expect(await withOrg(ex, A, (tx) => environmentHasResources(tx, fx.a!.stagingId))).toBe(true);
    expect(await withOrg(ex, A, (tx) => destinationIsAttached(tx, "swarm", fx.a!.swarm.id))).toBe(true);
    expect((await withOrg(ex, A, (tx) => listDestinationResources(tx, "swarm", fx.a!.swarm.id))).map((r) => r.uuid)).toEqual(["clone1aaaaaaaaaaaaaaaaaa"]);

    expect(await withOrg(ex, A, (tx) => deleteApplication(tx, clone))).toBe(true);
    expect(await left()).toEqual({
      applications: 0, settings: 0, volumes: 0, mounts: 0, variables: 0, tags: 0, tasks: 0, taskExecutions: 0, schedules: 0, scheduleExecutions: 0, scheduleStorages: 0, links: 0, previews: 0, deployments: 0,
    });
    // The rest of the org is as it was: the source application, its rows, and the tags themselves.
    expect(await others()).toEqual({
      applications: before.applications - 1, settings: before.settings - 1, volumes: before.volumes - 1, mounts: before.mounts - 2, variables: before.variables - 2,
      pivots: before.pivots - 2, tags: before.tags, tasks: before.tasks - 1,
    });
    expect(await withOrg(ex, A, (tx) => findApplicationByUuid(tx, "clone1aaaaaaaaaaaaaaaaaa"))).toBeNull();
    expect(await withOrg(ex, A, (tx) => deleteApplication(tx, clone))).toBe(false);
  });

  it("after a delete, the environment, the project and the destination no longer count the application", async () => {
    // The clone was the staging environment's and the Swarm destination's only resource.
    expect(await withOrg(ex, A, (tx) => environmentHasResources(tx, fx.a!.stagingId))).toBe(false);
    expect(await withOrg(ex, A, (tx) => listEnvironmentApplications(tx, fx.a!.stagingId))).toEqual([]);
    expect(await withOrg(ex, A, (tx) => destinationIsAttached(tx, "swarm", fx.a!.swarm.id))).toBe(false);
    expect(await withOrg(ex, A, (tx) => listDestinationResources(tx, "swarm", fx.a!.swarm.id))).toEqual([]);
    // The production environment still has two applications.
    expect(await withOrg(ex, A, (tx) => environmentHasResources(tx, fx.a!.environmentId))).toBe(true);
    expect(await withOrg(ex, A, (tx) => projectHasResources(tx, fx.a!.projectId))).toBe(true);
    expect(await withOrg(ex, A, (tx) => destinationIsAttached(tx, "standalone", fx.a!.destination.id))).toBe(true);

    expect(await withOrg(ex, A, (tx) => deleteApplication(tx, ids.app1!))).toBe(true);
    expect(await withOrg(ex, A, (tx) => environmentHasResources(tx, fx.a!.environmentId))).toBe(true);
    expect(await withOrg(ex, A, (tx) => deleteApplication(tx, ids.app2!))).toBe(true);
    expect(await withOrg(ex, A, (tx) => environmentHasResources(tx, fx.a!.environmentId))).toBe(false);
    expect(await withOrg(ex, A, (tx) => projectHasResources(tx, fx.a!.projectId))).toBe(false);
    expect(await withOrg(ex, A, (tx) => destinationIsAttached(tx, "standalone", fx.a!.destination.id))).toBe(false);
    expect(await withOrg(ex, A, (tx) => listDestinationResources(tx, "standalone", fx.a!.destination.id))).toEqual([]);
    // Org B's application is untouched.
    expect(await withOrg(ex, B, (tx) => findApplicationByUuid(tx, APPB))).not.toBeNull();
    expect(await withOrg(ex, B, (tx) => environmentHasResources(tx, fx.b!.environmentId))).toBe(true);
    expect(await count("application_settings", "application_id = $1", [ids.appb])).toBe(1);
  });
});
