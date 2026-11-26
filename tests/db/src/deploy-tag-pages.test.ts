// The SQL of the team's Tags page (DP-97) on the schema at head: the org's tags with how many applications and
// services carry each (soft-deleted ones left out), a tag's applications and services with where they live, the
// queued and running deployments of those applications, and row-level security keeping each org's rows to itself.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  insertPrivateKey,
  insertServer,
  insertProject,
  listServerDestinations,
  insertDockerImageApplication,
  insertTag,
  attachTag,
  listTagsWithCounts,
  listTagApplications,
  listTagServices,
  listActiveDeployments,
  APPLICATION_MORPH_CLASS,
  SERVICE_MORPH_CLASS,
  APPLICATION_WEBHOOK_SECRET_COLUMNS,
  type DeployDestinationRow,
  type NewDockerImageApplication,
} from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, executor } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

let db: PGlite;
let ex: TransactionalSqlExecutor;

interface Fixture {
  destination: DeployDestinationRow;
  environmentId: string | number;
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
    const { environment } = await insertProject(tx, { orgId: org, uuid: `prj${tag}`, name: `Project-${tag}`, description: null, productionEnvironmentUuid: `env${tag}` });
    return { destination, environmentId: environment.id };
  });
}

const newApp = (org: string, f: Fixture, uuid: string): NewDockerImageApplication => ({
  orgId: org,
  uuid,
  name: `app-${uuid}`,
  fqdn: null,
  domainPortOverrides: null,
  dockerRegistryImageName: "nginx",
  dockerRegistryImageTag: "latest",
  environmentId: f.environmentId,
  destinationId: f.destination.id,
  destinationType: "standalone",
  webhookSecrets: Object.fromEntries(APPLICATION_WEBHOOK_SECRET_COLUMNS.map((c) => [c, `fp1:${uuid}:${c}`])) as NewDockerImageApplication["webhookSecrets"],
});

const admin = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => asPlatformAdmin(ex, async (tx) => (await tx.execute<T>(sql, params)).rows);

async function service(org: string, f: Fixture, uuid: string, deleted = false): Promise<string | number> {
  const rows = await admin<{ id: string | number }>(
    `INSERT INTO deploy.services (uuid, name, description, environment_id, docker_compose_raw, deleted_at, org_id) VALUES ($1, $2, 'Analytics', $3, 'services: {}', $4, $5) RETURNING id`,
    [uuid, `svc-${uuid}`, f.environmentId, deleted ? "2026-01-01 00:00:00" : null, org],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
  fx.a = await fixture(A, "a");
  fx.b = await fixture(B, "b");
  ids.app1 = (await withOrg(ex, A, (tx) => insertDockerImageApplication(tx, newApp(A, fx.a!, "app1aaaaaaaaaaaaaaaaaaaa")))).id;
  ids.app2 = (await withOrg(ex, A, (tx) => insertDockerImageApplication(tx, newApp(A, fx.a!, "app2aaaaaaaaaaaaaaaaaaaa")))).id;
  ids.appb = (await withOrg(ex, B, (tx) => insertDockerImageApplication(tx, newApp(B, fx.b!, "app1bbbbbbbbbbbbbbbbbbbb")))).id;
  ids.svc = await service(A, fx.a!, "svc1aaaaaaaaaaaaaaaaaaaa");
  ids.gone = await service(A, fx.a!, "svc2aaaaaaaaaaaaaaaaaaaa", true);
  await admin("UPDATE deploy.applications SET deleted_at = '2026-01-01 00:00:00' WHERE id = $1", [ids.app2]);
  await withOrg(ex, A, async (tx) => {
    const web = await insertTag(tx, { orgId: A, uuid: "tagwebaaaaaaaaaaaaaaaaaa", name: "web" });
    const empty = await insertTag(tx, { orgId: A, uuid: "tagnilaaaaaaaaaaaaaaaaaa", name: "empty" });
    ids.web = web.id;
    ids.empty = empty.id;
    for (const app of [ids.app1!, ids.app2!]) await attachTag(tx, A, { type: APPLICATION_MORPH_CLASS, id: app }, web.id);
    for (const svc of [ids.svc!, ids.gone!]) await attachTag(tx, A, { type: SERVICE_MORPH_CLASS, id: svc }, web.id);
  });
  await withOrg(ex, B, async (tx) => {
    const web = await insertTag(tx, { orgId: B, uuid: "tagwebbbbbbbbbbbbbbbbbbb", name: "web" });
    ids.webb = web.id;
    await attachTag(tx, B, { type: APPLICATION_MORPH_CLASS, id: ids.appb! }, web.id);
  });
  for (const [app, status, uuid] of [[ids.app1, "queued", "d1"], [ids.app1, "in_progress", "d2"], [ids.app1, "finished", "d3"], [ids.appb, "queued", "d4"]] as const) {
    await admin("INSERT INTO deploy.application_deployment_queues (application_id, deployment_uuid, status, application_name, server_name, org_id) VALUES ($1, $2, $3, 'app', 'server', $4)", [
      String(app), uuid, status, app === ids.appb ? B : A,
    ]);
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("the Tags page's queries", () => {
  it("counts each tag's applications and services, without the soft-deleted ones; each org sees its own tags", async () => {
    const a = await withOrg(ex, A, (tx) => listTagsWithCounts(tx));
    expect(a.map((t) => [t.name, t.applications_count, t.services_count])).toEqual([["web", 1, 1], ["empty", 0, 0]]);
    const b = await withOrg(ex, B, (tx) => listTagsWithCounts(tx));
    expect(b.map((t) => [t.name, t.applications_count, t.services_count])).toEqual([["web", 1, 0]]);
  });

  it("lists a tag's applications and services with their project and environment, and none of another org's", async () => {
    const apps = await withOrg(ex, A, (tx) => listTagApplications(tx, ids.web!));
    expect(apps.map((r) => [r.uuid, r.project_uuid, r.project_name, r.environment_uuid, r.environment_name])).toEqual([["app1aaaaaaaaaaaaaaaaaaaa", "prja", "Project-a", "enva", "production"]]);
    const services = await withOrg(ex, A, (tx) => listTagServices(tx, ids.web!));
    expect(services.map((r) => [r.uuid, r.description])).toEqual([["svc1aaaaaaaaaaaaaaaaaaaa", "Analytics"]]);
    expect(await withOrg(ex, A, (tx) => listTagApplications(tx, ids.empty!))).toEqual([]);
    expect(await withOrg(ex, A, (tx) => listTagApplications(tx, ids.webb!))).toEqual([]);
    expect(await withOrg(ex, B, (tx) => listTagServices(tx, ids.web!))).toEqual([]);
  });

  it("lists the queued and running deployments of the given applications, in id order; another org's are not seen", async () => {
    const rows = await withOrg(ex, A, (tx) => listActiveDeployments(tx, [ids.app1!, ids.appb!]));
    expect(rows.map((r) => [r.status, r.application_name, r.server_name])).toEqual([["queued", "app", "server"], ["in_progress", "app", "server"]]);
    expect(Number(rows[0]!.id) < Number(rows[1]!.id)).toBe(true);
    expect(await withOrg(ex, A, (tx) => listActiveDeployments(tx, []))).toEqual([]);
    expect((await withOrg(ex, B, (tx) => listActiveDeployments(tx, [ids.app1!, ids.appb!]))).map((r) => r.status)).toEqual(["queued"]);
  });
});
