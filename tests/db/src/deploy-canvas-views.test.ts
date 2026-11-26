// What the projects, servers, dashboard, shared variable and tag canvases read and write (DP-98), against a real
// Postgres with the deploy schema at head: every environment of the org with its saved card positions, the projects
// and servers with the place their zone was moved to (and saving it), every application, service and standalone
// database of the org as the canvas draws it, every visual-only link, the tags' pivot, the saved variables of some
// resources, and the dashboard's deployments — and row-level security keeping each org's rows to itself.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  insertPrivateKey,
  insertServer,
  insertProject,
  insertEnvironment,
  listServerDestinations,
  insertDockerImageApplication,
  insertDatabase,
  insertResourceLink,
  insertTag,
  attachTag,
  insertEnvironmentVariable,
  saveEnvironmentCanvasPositions,
  APPLICATION_WEBHOOK_SECRET_COLUMNS,
  DESTINATION_MORPH_CLASS,
  listCanvasEnvironments,
  listCanvasProjects,
  listCanvasServers,
  saveProjectCanvasPosition,
  saveServerCanvasPosition,
  listOrgApplications,
  listOrgDatabases,
  listOrgServiceCanvasRows,
  listOrgResourceLinks,
  listOrgTaggables,
  listCanvasEnvironmentVariables,
  listCanvasDeployments,
  type DeployDestinationRow,
  type NewDockerImageApplication,
  type NewEnvironmentVariable,
} from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, executor } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const APP = "App\\Models\\Application";
const PG = "App\\Models\\StandalonePostgresql";
const SERVICE = "App\\Models\\Service";

let db: PGlite;
let ex: TransactionalSqlExecutor;

interface Fixture {
  destination: DeployDestinationRow;
  serverId: string | number;
  projectId: string | number;
  environmentId: string | number;
}
const fx: Record<string, Fixture> = {};
const ids: Record<string, string | number> = {};

async function fixture(org: string, tag: string): Promise<Fixture> {
  return withOrg(ex, org, async (tx) => {
    const key = await insertPrivateKey(tx, { orgId: org, uuid: `cwkey${tag}`, name: "key", description: null, privateKey: "fp1:fake", fingerprint: null });
    const server = await insertServer(tx, {
      orgId: org, uuid: `cwsrv${tag}`, name: `server-${tag}`, description: null, ip: "203.0.113.20", user: "root", port: 22, privateKeyId: key.id,
      proxy: { type: "TRAEFIK" }, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: `cwdst${tag}`,
    });
    const destination = (await listServerDestinations(tx, server.id))[0]!;
    const { project, environment } = await insertProject(tx, { orgId: org, uuid: `cwprj${tag}`, name: `project-${tag}`, description: null, productionEnvironmentUuid: `cwenv${tag}` });
    return { destination, serverId: server.id, projectId: project.id, environmentId: environment.id };
  });
}

const newApp = (org: string, f: Fixture, uuid: string, environmentId = f.environmentId): NewDockerImageApplication => ({
  orgId: org,
  uuid,
  name: `app-${uuid}`,
  fqdn: null,
  domainPortOverrides: null,
  dockerRegistryImageName: "nginx",
  dockerRegistryImageTag: "latest",
  environmentId,
  destinationId: f.destination.id,
  destinationType: "standalone",
  webhookSecrets: Object.fromEntries(APPLICATION_WEBHOOK_SECRET_COLUMNS.map((c) => [c, `fp1:${uuid}:${c}`])) as NewDockerImageApplication["webhookSecrets"],
});
const variable = (org: string, key: string, value: string, isPreview = false): NewEnvironmentVariable => ({
  orgId: org, uuid: `var-${key}-${isPreview ? "p" : "n"}`, key, value, comment: null, order: null, isPreview, isMultiline: false, isLiteral: false,
  isRuntime: true, isBuildtime: true, isRequired: false, isShownOnce: false, isShared: false, version: "4.7.6",
});
const admin = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => asPlatformAdmin(ex, async (tx) => (await tx.execute<T>(sql, params)).rows);

beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
  fx.a = await fixture(A, "a");
  fx.b = await fixture(B, "b");
  await withOrg(ex, A, async (tx) => {
    ids.staging = (await insertEnvironment(tx, { orgId: A, uuid: "cwenvstaging", name: "staging", projectId: fx.a!.projectId })).id;
    ids.app1 = (await insertDockerImageApplication(tx, newApp(A, fx.a!, "cwapp1"))).id;
    ids.app2 = (await insertDockerImageApplication(tx, newApp(A, fx.a!, "cwapp2", ids.staging))).id;
    ids.pg = (await insertDatabase(tx, "postgresql", { orgId: A, uuid: "cwpg", name: "cwpg", environmentId: fx.a!.environmentId, destinationId: fx.a!.destination.id, destinationType: "standalone", values: { postgres_password: "fp1:secret" }, volumes: [] })).id;
    const s = await tx.execute<{ id: number }>(
      `INSERT INTO deploy.services (uuid, name, environment_id, docker_compose_raw, destination_id, destination_type, server_id, org_id) VALUES ('cwsvc', 'plausible', $1, 'services: {}', $2, $3, $4, $5) RETURNING id`,
      [fx.a!.environmentId, fx.a!.destination.id, DESTINATION_MORPH_CLASS.standalone, fx.a!.serverId, A],
    );
    ids.svc = s.rows[0]!.id;
    await tx.execute(`INSERT INTO deploy.service_applications (uuid, name, service_id, fqdn, org_id) VALUES ('cwsvcapp', 'plausible', $1, 'https://stats.example.com', $2)`, [ids.svc, A]);
    await saveEnvironmentCanvasPositions(tx, fx.a!.environmentId, { cwapp1: { x: 10, y: 20 } });
    await insertResourceLink(tx, { orgId: A, uuid: "cwlink1", environmentId: fx.a!.environmentId, sourceType: APP, sourceId: ids.app1!, targetType: PG, targetId: ids.pg!, label: "reads" });
    const later = await insertTag(tx, { orgId: A, uuid: "cwtag2", name: "zeta" });
    const first = await insertTag(tx, { orgId: A, uuid: "cwtag1", name: "alpha" });
    ids.tagZeta = later.id;
    ids.tagAlpha = first.id;
    await attachTag(tx, A, { type: APP, id: ids.app1! }, later.id);
    await attachTag(tx, A, { type: APP, id: ids.app1! }, first.id);
    await insertEnvironmentVariable(tx, "application", ids.app1!, variable(A, "B_KEY", "fp1:b"));
    await insertEnvironmentVariable(tx, "application", ids.app1!, variable(A, "A_KEY", "fp1:a"));
    await insertEnvironmentVariable(tx, "application", ids.app1!, variable(A, "A_KEY", "fp1:ap", true));
    await insertEnvironmentVariable(tx, "service", ids.svc!, variable(A, "S_KEY", "fp1:s"));
  });
  await withOrg(ex, B, async (tx) => {
    ids.appb = (await insertDockerImageApplication(tx, newApp(B, fx.b!, "cwappb"))).id;
    await attachTag(tx, B, { type: APP, id: ids.appb! }, (await insertTag(tx, { orgId: B, uuid: "cwtagb", name: "beta" })).id);
  });
  // Deployments of org A's server: two active (queued after in progress), and nine finished.
  const deploy = (uuid: string, status: string, application: string | number, server: string | number, org: string, minute: number) =>
    admin(
      `INSERT INTO deploy.application_deployment_queues (application_id, deployment_uuid, status, server_id, application_name, server_name, deployment_url, pull_request_id, created_at, finished_at, org_id)
       VALUES ($1, $2, $3, $4, 'web', 'server-a', $5, $6, TIMESTAMP '2026-11-20 10:00:00' + $7 * INTERVAL '1 minute', NULL, $8)`,
      [String(application), uuid, status, server, `/deployment/${uuid}`, uuid === "q1" ? 7 : 0, minute, org],
    );
  await deploy("q1", "queued", ids.app1!, fx.a!.serverId, A, 1);
  await deploy("p1", "in_progress", ids.app1!, fx.a!.serverId, A, 2);
  for (let i = 0; i < 9; i++) await deploy(`f${i}`, i % 2 ? "failed" : "finished", ids.app2!, fx.a!.serverId, A, 10 + i);
  await deploy("qb", "queued", ids.appb!, fx.b!.serverId, B, 1);
}, 120_000);
afterAll(async () => db?.close());

describe("environments, projects and servers", () => {
  it("lists every environment of the org with its project and its saved positions, by id", async () => {
    const rows = await withOrg(ex, A, (tx) => listCanvasEnvironments(tx));
    expect(rows.map((r) => [r.uuid, r.name, r.project_uuid, r.project_name])).toEqual([
      ["cwenva", "production", "cwprja", "project-a"],
      ["cwenvstaging", "staging", "cwprja", "project-a"],
    ]);
    expect(rows[0]!.canvas_positions).toEqual({ cwapp1: { x: 10, y: 20 } });
    expect(rows[1]!.canvas_positions).toBeNull();
  });

  it("saves a project's and a server's zone place, and reads it back", async () => {
    await withOrg(ex, A, async (tx) => {
      expect(await saveProjectCanvasPosition(tx, fx.a!.projectId, { x: 100, y: -40 })).toBe(true);
      expect(await saveServerCanvasPosition(tx, fx.a!.serverId, { x: -5, y: 7 })).toBe(true);
    });
    const projects = await withOrg(ex, A, (tx) => listCanvasProjects(tx));
    expect(projects.map((p) => [p.uuid, p.canvas_position])).toEqual([["cwprja", { x: 100, y: -40 }]]);
    const servers = await withOrg(ex, A, (tx) => listCanvasServers(tx));
    expect(servers.map((s) => [s.uuid, s.name, s.canvas_position, s.is_reachable, s.is_metrics_enabled])).toEqual([["cwsrva", "server-a", { x: -5, y: 7 }, false, false]]);
    expect(servers[0]!.proxy).toMatchObject({ type: "TRAEFIK" });
  });

  it("does not save another org's project or server", async () => {
    await withOrg(ex, B, async (tx) => {
      expect(await saveProjectCanvasPosition(tx, fx.a!.projectId, { x: 1, y: 1 })).toBe(false);
      expect(await saveServerCanvasPosition(tx, fx.a!.serverId, { x: 1, y: 1 })).toBe(false);
    });
    const [project] = await admin<{ canvas_position: unknown }>("SELECT canvas_position FROM deploy.projects WHERE id = $1", [fx.a!.projectId]);
    expect(typeof project!.canvas_position === "string" ? JSON.parse(project!.canvas_position) : project!.canvas_position).toEqual({ x: 100, y: -40 });
    expect((await withOrg(ex, B, (tx) => listCanvasProjects(tx))).map((p) => p.uuid)).toEqual(["cwprjb"]);
    expect((await withOrg(ex, B, (tx) => listCanvasEnvironments(tx))).map((e) => e.uuid)).toEqual(["cwenvb"]);
  });
});

describe("the org's resources", () => {
  it("lists every application, service and standalone database of the org with its environment and server", async () => {
    const apps = await withOrg(ex, A, (tx) => listOrgApplications(tx));
    expect(apps.map((a) => [a.uuid, String(a.environment_id), a.server_uuid])).toEqual([
      ["cwapp1", String(fx.a!.environmentId), "cwsrva"],
      ["cwapp2", String(ids.staging), "cwsrva"],
    ]);
    const services = await withOrg(ex, A, (tx) => listOrgServiceCanvasRows(tx));
    expect(services.map((s) => [s.uuid, String(s.id), String(s.environment_id), String(s.server_id), s.server_uuid])).toEqual([["cwsvc", String(ids.svc), String(fx.a!.environmentId), String(fx.a!.serverId), "cwsrva"]]);
    const parts = (typeof services[0]!.parts === "string" ? JSON.parse(services[0]!.parts) : services[0]!.parts) as Array<{ name: string; fqdn: string }>;
    expect(parts.map((p) => [p.name, p.fqdn])).toEqual([["plausible", "https://stats.example.com"]]);
    const databases = await withOrg(ex, A, (tx) => listOrgDatabases(tx));
    expect(databases.map((d) => [d.uuid, d.engine, String(d.server_id)])).toEqual([["cwpg", "postgresql", String(fx.a!.serverId)]]);
  });

  it("keeps another org's resources out", async () => {
    expect((await withOrg(ex, B, (tx) => listOrgApplications(tx))).map((a) => a.uuid)).toEqual(["cwappb"]);
    expect(await withOrg(ex, B, (tx) => listOrgServiceCanvasRows(tx))).toEqual([]);
    expect(await withOrg(ex, B, (tx) => listOrgDatabases(tx))).toEqual([]);
  });
});

describe("links, tags and variables", () => {
  it("lists every visual-only link of the org by id", async () => {
    const links = await withOrg(ex, A, (tx) => listOrgResourceLinks(tx));
    expect(links.map((l) => [l.uuid, l.source_type, String(l.source_id), l.target_type, String(l.target_id), l.label])).toEqual([["cwlink1", APP, String(ids.app1), PG, String(ids.pg), "reads"]]);
    expect(await withOrg(ex, B, (tx) => listOrgResourceLinks(tx))).toEqual([]);
  });

  it("lists the tags' pivot in the order the tags were attached, the org's only", async () => {
    const pivot = await withOrg(ex, A, (tx) => listOrgTaggables(tx));
    expect(pivot.map((p) => [String(p.tag_id), p.taggable_type, String(p.taggable_id)])).toEqual([
      [String(ids.tagZeta), APP, String(ids.app1)],
      [String(ids.tagAlpha), APP, String(ids.app1)],
    ]);
    expect((await withOrg(ex, B, (tx) => listOrgTaggables(tx))).map((p) => String(p.taggable_id))).toEqual([String(ids.appb)]);
  });

  it("lists the saved variables of the resources by key, the preview copies only when asked, with their stored values", async () => {
    const resources = [
      { type: APP, id: ids.app1! },
      { type: SERVICE, id: ids.svc! },
    ];
    const saved = await withOrg(ex, A, (tx) => listCanvasEnvironmentVariables(tx, resources));
    expect(saved.map((v) => [v.key, v.value, v.is_preview, v.resourceable_type])).toEqual([
      ["A_KEY", "fp1:a", false, APP],
      ["B_KEY", "fp1:b", false, APP],
      ["S_KEY", "fp1:s", false, SERVICE],
    ]);
    const withPreview = await withOrg(ex, A, (tx) => listCanvasEnvironmentVariables(tx, [{ type: APP, id: ids.app1! }], true));
    expect(withPreview.map((v) => [v.key, v.is_preview])).toEqual([
      ["A_KEY", false],
      ["A_KEY", true],
      ["B_KEY", false],
    ]);
    expect(await withOrg(ex, A, (tx) => listCanvasEnvironmentVariables(tx, []))).toEqual([]);
    // Another org asking for org A's resource sees none of its variables.
    expect(await withOrg(ex, B, (tx) => listCanvasEnvironmentVariables(tx, resources, true))).toEqual([]);
  });
});

describe("the dashboard's deployments", () => {
  it("lists the active ones by status then id, then the 8 latest others, with the application's uuid", async () => {
    const active = await withOrg(ex, A, (tx) => listCanvasDeployments(tx, [fx.a!.serverId], true));
    expect(active.map((d) => [d.deployment_uuid, d.status, d.application_uuid, d.pull_request_id])).toEqual([
      ["p1", "in_progress", "cwapp1", 0],
      ["q1", "queued", "cwapp1", 7],
    ]);
    expect(active[1]!.created_at).toBe("2026-11-20T10:01:00+00:00");
    expect(active[1]!.finished_at).toBeNull();
    expect(active[1]!.deployment_url).toBe("/deployment/q1");
    const recent = await withOrg(ex, A, (tx) => listCanvasDeployments(tx, [fx.a!.serverId], false));
    expect(recent.map((d) => d.deployment_uuid)).toEqual(["f8", "f7", "f6", "f5", "f4", "f3", "f2", "f1"]);
    expect(recent.map((d) => d.application_uuid)).toEqual(Array(8).fill("cwapp2"));
    expect(await withOrg(ex, A, (tx) => listCanvasDeployments(tx, [], true))).toEqual([]);
  });

  it("keeps another org's deployments out, also when it names org A's server", async () => {
    expect(await withOrg(ex, B, (tx) => listCanvasDeployments(tx, [fx.a!.serverId], true))).toEqual([]);
    expect((await withOrg(ex, B, (tx) => listCanvasDeployments(tx, [fx.b!.serverId], true))).map((d) => [d.deployment_uuid, d.application_uuid])).toEqual([["qb", "cwappb"]]);
  });
});
