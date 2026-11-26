// The environment canvas's stored layout (DP-92) against a real Postgres with the deploy schema at head:
// EnvironmentCanvas::resourceIndex() (applications, services, then the standalone databases engine by engine,
// soft-deleted ones left out), canvas_positions read, locked and saved, the visual-only links listed, found by
// uuid, refused twice in one direction, relabelled and deleted, the links going with their environment and
// their project, and row-level security keeping each org's positions and links to itself.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  insertPrivateKey,
  insertServer,
  insertProject,
  insertEnvironment,
  deleteEnvironment,
  deleteProject,
  listServerDestinations,
  insertDockerImageApplication,
  insertDatabase,
  APPLICATION_WEBHOOK_SECRET_COLUMNS,
  CANVAS_RESOURCE_TABLES,
  listEnvironmentCanvasResources,
  findEnvironmentCanvasPositions,
  lockEnvironmentCanvasPositions,
  saveEnvironmentCanvasPositions,
  listEnvironmentResourceLinks,
  findEnvironmentResourceLink,
  resourceLinkExists,
  insertResourceLink,
  updateResourceLinkLabel,
  deleteResourceLink,
  type DeployDestinationRow,
  type NewDockerImageApplication,
  type ResourceLinkEnds,
} from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, executor } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const APP = "App\\Models\\Application";
const PG = "App\\Models\\StandalonePostgresql";
const REDIS = "App\\Models\\StandaloneRedis";

let db: PGlite;
let ex: TransactionalSqlExecutor;

interface Fixture {
  destination: DeployDestinationRow;
  projectId: string | number;
  environmentId: string | number;
}
const fx: Record<string, Fixture> = {};
const ids: Record<string, string | number> = {};

async function fixture(org: string, tag: string): Promise<Fixture> {
  return withOrg(ex, org, async (tx) => {
    const key = await insertPrivateKey(tx, { orgId: org, uuid: `cvkey${tag}`, name: "key", description: null, privateKey: "fp1:fake", fingerprint: null });
    const server = await insertServer(tx, {
      orgId: org, uuid: `cvsrv${tag}`, name: `server-${tag}`, description: null, ip: "203.0.113.10", user: "root", port: 22, privateKeyId: key.id,
      proxy: { type: "TRAEFIK" }, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: `cvdst${tag}`,
    });
    const destination = (await listServerDestinations(tx, server.id))[0]!;
    const { project, environment } = await insertProject(tx, { orgId: org, uuid: `cvprj${tag}`, name: `project-${tag}`, description: null, productionEnvironmentUuid: `cvenv${tag}` });
    return { destination, projectId: project.id, environmentId: environment.id };
  });
}

const newApp = (org: string, f: Fixture, uuid: string): NewDockerImageApplication => ({
  orgId: org,
  uuid,
  name: `docker-image-${uuid}`,
  fqdn: null,
  domainPortOverrides: null,
  dockerRegistryImageName: "nginx",
  dockerRegistryImageTag: "latest",
  environmentId: f.environmentId,
  destinationId: f.destination.id,
  destinationType: "standalone",
  webhookSecrets: Object.fromEntries(APPLICATION_WEBHOOK_SECRET_COLUMNS.map((c) => [c, `fp1:${uuid}:${c}`])) as NewDockerImageApplication["webhookSecrets"],
});
const newDatabase = (org: string, f: Fixture, uuid: string, values: Record<string, string> = {}) => ({ orgId: org, uuid, name: uuid, environmentId: f.environmentId, destinationId: f.destination.id, destinationType: "standalone" as const, values, volumes: [] });

const admin = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => asPlatformAdmin(ex, async (tx) => (await tx.execute<T>(sql, params)).rows);
const ends = (source: string | number, target: string | number, environmentId = fx.a!.environmentId, targetType = PG): ResourceLinkEnds => ({ environmentId, sourceType: APP, sourceId: source, targetType, targetId: target });

beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
  fx.a = await fixture(A, "a");
  fx.b = await fixture(B, "b");
  await withOrg(ex, A, async (tx) => {
    // Inserted out of resourceIndex()'s order: redis first, then the applications, then postgres.
    ids.redis = (await insertDatabase(tx, "redis", newDatabase(A, fx.a!, "cvredis"))).id;
    ids.app1 = (await insertDockerImageApplication(tx, newApp(A, fx.a!, "cvapp1"))).id;
    ids.app2 = (await insertDockerImageApplication(tx, newApp(A, fx.a!, "cvapp2"))).id;
    ids.pg = (await insertDatabase(tx, "postgresql", newDatabase(A, fx.a!, "cvpg", { postgres_password: "fp1:secret" }))).id;
  });
  ids.appb = (await withOrg(ex, B, (tx) => insertDockerImageApplication(tx, newApp(B, fx.b!, "cvappb")))).id;
}, 120_000);
afterAll(async () => db?.close());

describe("EnvironmentCanvas::resourceIndex()", () => {
  it("lists applications, services, then the standalone databases in DATABASE_RELATIONS' order, with their morph types", async () => {
    expect(CANVAS_RESOURCE_TABLES.map((t) => t.table)).toEqual([
      "applications",
      "services",
      "standalone_postgresqls",
      "standalone_redis",
      "standalone_mongodbs",
      "standalone_mysqls",
      "standalone_mariadbs",
      "standalone_keydbs",
      "standalone_dragonflies",
      "standalone_clickhouses",
    ]);
    const rows = await withOrg(ex, A, (tx) => listEnvironmentCanvasResources(tx, fx.a!.environmentId));
    expect(rows.map((r) => [r.uuid, r.type, String(r.id)])).toEqual([
      ["cvapp1", APP, String(ids.app1)],
      ["cvapp2", APP, String(ids.app2)],
      ["cvpg", PG, String(ids.pg)],
      ["cvredis", REDIS, String(ids.redis)],
    ]);
  });

  it("leaves out soft-deleted resources, and another org's environment reads as empty", async () => {
    await admin("UPDATE deploy.applications SET deleted_at = now() WHERE id = $1", [ids.app2]);
    try {
      const rows = await withOrg(ex, A, (tx) => listEnvironmentCanvasResources(tx, fx.a!.environmentId));
      expect(rows.map((r) => r.uuid)).not.toContain("cvapp2");
    } finally {
      await admin("UPDATE deploy.applications SET deleted_at = NULL WHERE id = $1", [ids.app2]);
    }
    expect(await withOrg(ex, B, (tx) => listEnvironmentCanvasResources(tx, fx.a!.environmentId))).toEqual([]);
  });
});

describe("canvas_positions", () => {
  it("is null until saved, then reads back as saved (and updated_at moves)", async () => {
    expect(await withOrg(ex, A, (tx) => findEnvironmentCanvasPositions(tx, fx.a!.environmentId))).toBeNull();
    await admin("UPDATE deploy.environments SET updated_at = '2000-01-01' WHERE id = $1", [fx.a!.environmentId]);
    await withOrg(ex, A, (tx) => saveEnvironmentCanvasPositions(tx, fx.a!.environmentId, { cvapp1: { x: 10, y: -20 } }));
    expect(await withOrg(ex, A, (tx) => findEnvironmentCanvasPositions(tx, fx.a!.environmentId))).toEqual({ cvapp1: { x: 10, y: -20 } });
    const [row] = await admin<{ updated_at: unknown }>("SELECT updated_at FROM deploy.environments WHERE id = $1", [fx.a!.environmentId]);
    expect(String(row!.updated_at)).not.toContain("2000");
  });

  it("locks the environment's row for the save, and finds nothing of another org", async () => {
    const locked = await withOrg(ex, A, (tx) => lockEnvironmentCanvasPositions(tx, fx.a!.environmentId));
    expect(locked).toEqual({ found: true, positions: { cvapp1: { x: 10, y: -20 } } });
    expect(await withOrg(ex, B, (tx) => lockEnvironmentCanvasPositions(tx, fx.a!.environmentId))).toEqual({ found: false, positions: null });
    expect(await withOrg(ex, B, (tx) => findEnvironmentCanvasPositions(tx, fx.a!.environmentId))).toBeNull();
    // Org B's save reaches no row of org A.
    await withOrg(ex, B, (tx) => saveEnvironmentCanvasPositions(tx, fx.a!.environmentId, { cvapp1: { x: 999, y: 999 } }));
    expect(await withOrg(ex, A, (tx) => findEnvironmentCanvasPositions(tx, fx.a!.environmentId))).toEqual({ cvapp1: { x: 10, y: -20 } });
  });
});

describe("resource_links", () => {
  it("inserts a link with the org and no creator, lists the environment's links by id and finds one by uuid", async () => {
    const first = await withOrg(ex, A, (tx) => insertResourceLink(tx, { ...ends(ids.app1!, ids.pg!), orgId: A, uuid: "cvlink1", label: "reads from" }));
    expect(first).toMatchObject({ uuid: "cvlink1", source_type: APP, target_type: PG, label: "reads from" });
    const second = await withOrg(ex, A, (tx) => insertResourceLink(tx, { ...ends(ids.app2!, ids.redis!, fx.a!.environmentId, REDIS), orgId: A, uuid: "cvlink2", label: null }));
    expect(second?.label).toBeNull();
    const [stored] = await admin<{ org_id: string; created_by: unknown; created_at: unknown }>("SELECT org_id, created_by, created_at FROM deploy.resource_links WHERE uuid = 'cvlink1'");
    expect(stored).toMatchObject({ org_id: A, created_by: null });
    expect(stored!.created_at).not.toBeNull();
    const links = await withOrg(ex, A, (tx) => listEnvironmentResourceLinks(tx, fx.a!.environmentId));
    expect(links.map((l) => l.uuid)).toEqual(["cvlink1", "cvlink2"]);
    expect(await withOrg(ex, A, (tx) => findEnvironmentResourceLink(tx, fx.a!.environmentId, "cvlink2"))).toMatchObject({ uuid: "cvlink2" });
    // Another environment's lookup does not find it.
    expect(await withOrg(ex, A, (tx) => findEnvironmentResourceLink(tx, fx.b!.environmentId, "cvlink2"))).toBeNull();
  });

  it("tells a linked direction, and resource_links_unique_direction refuses it again without aborting the transaction", async () => {
    expect(await withOrg(ex, A, (tx) => resourceLinkExists(tx, ends(ids.app1!, ids.pg!)))).toBe(true);
    // The other direction is not the same link.
    expect(await withOrg(ex, A, (tx) => resourceLinkExists(tx, { environmentId: fx.a!.environmentId, sourceType: PG, sourceId: ids.pg!, targetType: APP, targetId: ids.app1! }))).toBe(false);
    const again = await withOrg(ex, A, async (tx) => {
      const refused = await insertResourceLink(tx, { ...ends(ids.app1!, ids.pg!), orgId: A, uuid: "cvlink-dup", label: null });
      // The transaction still answers.
      const after = await listEnvironmentResourceLinks(tx, fx.a!.environmentId);
      return { refused, count: after.length };
    });
    expect(again).toEqual({ refused: null, count: 2 });
  });

  it("relabels and deletes a link", async () => {
    const link = (await withOrg(ex, A, (tx) => findEnvironmentResourceLink(tx, fx.a!.environmentId, "cvlink2")))!;
    expect(await withOrg(ex, A, (tx) => updateResourceLinkLabel(tx, link.id, "caches"))).toMatchObject({ uuid: "cvlink2", label: "caches" });
    expect(await withOrg(ex, A, (tx) => updateResourceLinkLabel(tx, link.id, null))).toMatchObject({ label: null });
    expect(await withOrg(ex, A, (tx) => deleteResourceLink(tx, link.id))).toBe(true);
    expect((await withOrg(ex, A, (tx) => listEnvironmentResourceLinks(tx, fx.a!.environmentId))).map((l) => l.uuid)).toEqual(["cvlink1"]);
  });

  it("row-level security: another org neither lists, finds, relabels, deletes nor adds to org A's links", async () => {
    const link = (await withOrg(ex, A, (tx) => findEnvironmentResourceLink(tx, fx.a!.environmentId, "cvlink1")))!;
    expect(await withOrg(ex, B, (tx) => listEnvironmentResourceLinks(tx, fx.a!.environmentId))).toEqual([]);
    expect(await withOrg(ex, B, (tx) => findEnvironmentResourceLink(tx, fx.a!.environmentId, "cvlink1"))).toBeNull();
    expect(await withOrg(ex, B, (tx) => resourceLinkExists(tx, ends(ids.app1!, ids.pg!)))).toBe(false);
    expect(await withOrg(ex, B, (tx) => updateResourceLinkLabel(tx, link.id, "taken"))).toBeNull();
    expect(await withOrg(ex, B, (tx) => deleteResourceLink(tx, link.id))).toBe(false);
    // A row claiming org A from org B's transaction is refused by the policy's WITH CHECK.
    await expect(withOrg(ex, B, (tx) => insertResourceLink(tx, { ...ends(ids.appb!, ids.appb!, fx.b!.environmentId, APP), orgId: A, uuid: "cvlink-b", label: null }))).rejects.toThrow();
    expect(await withOrg(ex, A, (tx) => findEnvironmentResourceLink(tx, fx.a!.environmentId, "cvlink1"))).toMatchObject({ label: "reads from" });
  });

  it("go with their environment (Coolify: cascadeOnDelete) and with their project", async () => {
    const other = await withOrg(ex, A, async (tx) => {
      const environment = await insertEnvironment(tx, { orgId: A, projectId: fx.a!.projectId, uuid: "cvenv-other", name: "staging" });
      await insertResourceLink(tx, { ...ends(ids.app1!, ids.pg!, environment.id), orgId: A, uuid: "cvlink-staging", label: null });
      return environment;
    });
    await withOrg(ex, A, (tx) => deleteEnvironment(tx, other.id));
    expect(await admin("SELECT 1 FROM deploy.resource_links WHERE uuid = 'cvlink-staging'")).toEqual([]);
    expect(await admin("SELECT 1 FROM deploy.resource_links WHERE uuid = 'cvlink1'")).toHaveLength(1);
    await admin("DELETE FROM deploy.applications WHERE environment_id = $1", [fx.a!.environmentId]);
    await admin("DELETE FROM deploy.standalone_postgresqls WHERE environment_id = $1", [fx.a!.environmentId]);
    await admin("DELETE FROM deploy.standalone_redis WHERE environment_id = $1", [fx.a!.environmentId]);
    await withOrg(ex, A, (tx) => deleteProject(tx, fx.a!.projectId));
    expect(await admin("SELECT 1 FROM deploy.resource_links WHERE uuid = 'cvlink1'")).toEqual([]);
  });
});
