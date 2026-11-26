// The SQL of the dashboard at / and of an environment's Clone page (DP-100) on the schema at head: the org's servers by
// name with what serverStatus() reads, whether it has a private key, its applications' queued and running deployments
// and the latest others (a deleted application's kept, without its environment), the clone's project name check, and
// row-level security keeping each org's rows to itself.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  insertPrivateKey,
  insertServer,
  insertProject,
  listServerDestinations,
  insertDockerImageApplication,
  listDashboardServers,
  orgHasPrivateKeys,
  listDashboardDeployments,
  projectNameExists,
  APPLICATION_WEBHOOK_SECRET_COLUMNS,
  type DeployDestinationRow,
  type NewDockerImageApplication,
} from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, executor } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

let db: PGlite;
let ex: TransactionalSqlExecutor;

interface Fixture {
  destination: DeployDestinationRow;
  environmentId: string | number;
}
const fx: Record<string, Fixture> = {};
const ids: Record<string, string | number> = {};

async function fixture(org: string, tag: string, serverNames: string[]): Promise<Fixture> {
  return withOrg(ex, org, async (tx) => {
    const key = await insertPrivateKey(tx, { orgId: org, uuid: `key${tag}`, name: "key", description: null, privateKey: "fp1:fake", fingerprint: null });
    let destination: DeployDestinationRow | undefined;
    for (const [i, name] of serverNames.entries()) {
      const server = await insertServer(tx, {
        orgId: org, uuid: `srv${tag}${i}`, name, description: i === 0 ? "first" : null, ip: `203.0.113.${10 + i}`, user: "root", port: 22, privateKeyId: key.id,
        proxy: { type: "TRAEFIK", status: "exited" }, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: `dst${tag}${i}`,
      });
      destination ??= (await listServerDestinations(tx, server.id))[0]!;
    }
    const { environment } = await insertProject(tx, { orgId: org, uuid: `prj${tag}`, name: `Project-${tag}`, description: null, productionEnvironmentUuid: `env${tag}` });
    return { destination: destination!, environmentId: environment.id };
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

beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
  fx.a = await fixture(A, "a", ["zeta", "alpha"]);
  fx.b = await fixture(B, "b", ["theirs"]);
  ids.app1 = (await withOrg(ex, A, (tx) => insertDockerImageApplication(tx, newApp(A, fx.a!, "app1aaaaaaaaaaaaaaaaaaaa")))).id;
  ids.app2 = (await withOrg(ex, A, (tx) => insertDockerImageApplication(tx, newApp(A, fx.a!, "app2aaaaaaaaaaaaaaaaaaaa")))).id;
  ids.appb = (await withOrg(ex, B, (tx) => insertDockerImageApplication(tx, newApp(B, fx.b!, "app1bbbbbbbbbbbbbbbbbbbb")))).id;
  await admin("UPDATE deploy.applications SET deleted_at = '2026-01-01 00:00:00' WHERE id = $1", [ids.app2]);
  const rows: Array<[string | number, string, string, string]> = [
    [ids.app1!, "queued", "d1", A],
    [ids.app1!, "in_progress", "d2", A],
    [ids.app1!, "finished", "d3", A],
    [ids.app2!, "failed", "d4", A],
    [ids.appb!, "queued", "d5", B],
    [ids.appb!, "finished", "d6", B],
  ];
  for (const [app, status, uuid, org] of rows) {
    await admin(
      `INSERT INTO deploy.application_deployment_queues (application_id, deployment_uuid, status, application_name, server_name, scan_gate_result, created_at, finished_at, org_id)
       VALUES ($1, $2, $3, 'app', 'server', $4, '2026-11-01 10:00:00', $5, $6)`,
      [String(app), uuid, status, uuid === "d3" ? '{"blocked": true}' : null, status === "queued" || status === "in_progress" ? null : "2026-11-01 10:05:00", org],
    );
  }
  // Six finished deployments more: only the five newest are listed.
  for (let i = 0; i < 6; i++) {
    await admin("INSERT INTO deploy.application_deployment_queues (application_id, deployment_uuid, status, org_id) VALUES ($1, $2, 'finished', $3)", [String(ids.app1), `old${i}`, A]);
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("the dashboard's queries", () => {
  it("lists the org's servers by name with their settings, without a deleted one; another org's are not seen", async () => {
    const a = await withOrg(ex, A, (tx) => listDashboardServers(tx));
    expect(a.map((s) => [s.name, s.description, s.is_reachable, s.is_usable, s.force_disabled, s.server_role, s.sentinel_push_interval_seconds])).toEqual([
      ["alpha", null, false, false, false, "both", 60],
      ["zeta", "first", false, false, false, "both", 60],
    ]);
    expect(a[0]!.proxy).toMatchObject({ type: "TRAEFIK", status: "exited" });
    expect(a[0]!.sentinel_updated_at).not.toBeNull();
    await admin("UPDATE deploy.servers SET deleted_at = '2026-01-01 00:00:00' WHERE uuid = 'srva1'");
    expect((await withOrg(ex, A, (tx) => listDashboardServers(tx))).map((s) => s.name)).toEqual(["zeta"]);
    await admin("UPDATE deploy.servers SET deleted_at = NULL WHERE uuid = 'srva1'");
    expect((await withOrg(ex, B, (tx) => listDashboardServers(tx))).map((s) => s.name)).toEqual(["theirs"]);
  });

  it("says whether the org has a private key", async () => {
    expect(await withOrg(ex, A, (tx) => orgHasPrivateKeys(tx))).toBe(true);
    expect(await withOrg(ex, C, (tx) => orgHasPrivateKeys(tx))).toBe(false);
  });

  it("lists the active deployments by status then id, and the five newest others, with the project and environment of an application that is not deleted", async () => {
    const active = await withOrg(ex, A, (tx) => listDashboardDeployments(tx, true));
    expect(active.map((d) => [d.deployment_uuid, d.status, d.project_name, d.environment_name])).toEqual([
      ["d2", "in_progress", "Project-a", "production"],
      ["d1", "queued", "Project-a", "production"],
    ]);
    const recent = await withOrg(ex, A, (tx) => listDashboardDeployments(tx, false));
    expect(recent.map((d) => d.deployment_uuid)).toEqual(["old5", "old4", "old3", "old2", "old1"]);
    // Without the newer ones, the deleted application's failure (no environment) and the blocked one show.
    await admin("DELETE FROM deploy.application_deployment_queues WHERE deployment_uuid LIKE 'old%'");
    const left = await withOrg(ex, A, (tx) => listDashboardDeployments(tx, false));
    expect(left.map((d) => [d.deployment_uuid, d.project_name, d.environment_name, d.scan_gate_result, d.created_at, d.finished_at])).toEqual([
      ["d4", null, null, null, "2026-11-01T10:00:00+00:00", "2026-11-01T10:05:00+00:00"],
      ["d3", "Project-a", "production", { blocked: true }, "2026-11-01T10:00:00+00:00", "2026-11-01T10:05:00+00:00"],
    ]);
    expect((await withOrg(ex, B, (tx) => listDashboardDeployments(tx, true))).map((d) => d.deployment_uuid)).toEqual(["d5"]);
    expect((await withOrg(ex, B, (tx) => listDashboardDeployments(tx, false))).map((d) => d.deployment_uuid)).toEqual(["d6"]);
  });

  it("finds a project by its exact name, in the org only (the clone's check)", async () => {
    expect(await withOrg(ex, A, (tx) => projectNameExists(tx, "Project-a"))).toBe(true);
    expect(await withOrg(ex, A, (tx) => projectNameExists(tx, "project-a"))).toBe(false);
    expect(await withOrg(ex, A, (tx) => projectNameExists(tx, "Project-b"))).toBe(false);
    expect(await withOrg(ex, B, (tx) => projectNameExists(tx, "Project-b"))).toBe(true);
  });
});
