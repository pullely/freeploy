// The SQL of DP-102's configuration sub-pages on the schema at head: an application's Swarm and Maintenance Mode
// rows (its settings' node placement), the servers that run an application (its destination's, then its additional
// ones, each once) or a service, the swarm and maintenance writes, a service's applications' DNS statuses, and
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
  findApplicationSubpage,
  listApplicationMaintenanceServers,
  findServiceSubpage,
  listServiceMaintenanceServers,
  updateApplicationSwarm,
  updateResourceMaintenance,
  listServiceApplicationDnsStatuses,
  updateServiceApplicationDnsStatuses,
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

async function server(org: string, tag: string, ip: string) {
  return withOrg(ex, org, async (tx) => {
    const key = await insertPrivateKey(tx, { orgId: org, uuid: `key${tag}`, name: "key", description: null, privateKey: "fp1:fake", fingerprint: null });
    const row = await insertServer(tx, {
      orgId: org, uuid: `srv${tag}`, name: `server-${tag}`, description: null, ip, user: "root", port: 22, privateKeyId: key.id,
      proxy: { type: "TRAEFIK", status: "exited" }, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: `dst${tag}`,
    });
    return { id: row.id, destination: (await listServerDestinations(tx, row.id))[0]! };
  });
}

async function application(org: string, tag: string, destinationId: string | number) {
  return withOrg(ex, org, async (tx) => {
    const { environment } = await insertProject(tx, { orgId: org, uuid: `prj${tag}`, name: `Project-${tag}`, description: null, productionEnvironmentUuid: `env${tag}` });
    const uuid = `app${tag}`.padEnd(24, tag);
    const app: NewDockerImageApplication = {
      orgId: org, uuid, name: `app-${tag}`, fqdn: null, domainPortOverrides: null, dockerRegistryImageName: "nginx", dockerRegistryImageTag: "latest",
      environmentId: environment.id, destinationId, destinationType: "standalone",
      webhookSecrets: Object.fromEntries(APPLICATION_WEBHOOK_SECRET_COLUMNS.map((c) => [c, `fp1:${uuid}:${c}`])) as NewDockerImageApplication["webhookSecrets"],
    };
    return { id: (await insertDockerImageApplication(tx, app)).id, uuid, environment: environment.id };
  });
}

beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
  const main = await server(A, "a", "203.0.113.10");
  const extra = await server(A, "x", "203.0.113.11");
  const other = await server(B, "b", "203.0.113.20");
  ids.main = main.id;
  ids.extra = extra.id;
  const a = await application(A, "a", main.destination.id);
  const b = await application(B, "b", other.destination.id);
  ids.app = a.id;
  ids.appUuid = a.uuid;
  ids.appb = b.id;
  ids.appbUuid = b.uuid;
  // An additional destination on the extra server, then one on the destination's own server (listed once).
  for (const [serverId, destinationId] of [[extra.id, extra.destination.id], [main.id, main.destination.id]] as const) {
    await admin("INSERT INTO deploy.additional_destinations (application_id, server_id, standalone_docker_id, org_id) VALUES ($1, $2, $3, $4)", [a.id, serverId, destinationId, A]);
  }
  await admin("UPDATE deploy.server_settings SET is_swarm_worker = true, public_ipv4 = '198.51.100.7' WHERE server_id = $1", [extra.id]);
  const svc = await admin<{ id: string | number }>("INSERT INTO deploy.services (uuid, name, environment_id, server_id, docker_compose_raw, org_id) VALUES ('svca', 'svc', $1, $2, 'services: {}', $3) RETURNING id", [a.environment, main.id, A]);
  ids.service = svc[0]!.id;
  const svcb = await admin<{ id: string | number }>("INSERT INTO deploy.services (uuid, name, environment_id, docker_compose_raw, org_id) VALUES ('svcb', 'svc', $1, 'services: {}', $2) RETURNING id", [b.environment, B]);
  ids.serviceb = svcb[0]!.id;
  for (const name of ["web", "api"]) {
    const part = await admin<{ id: string | number }>("INSERT INTO deploy.service_applications (uuid, name, service_id, org_id) VALUES ($1, $2, $3, $4) RETURNING id", [`part-${name}`, name, ids.service, A]);
    ids[name] = part[0]!.id;
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("an application's Swarm and Maintenance Mode rows", () => {
  it("reads the application with its node placement, the schema's defaults", async () => {
    const row = await withOrg(ex, A, (tx) => findApplicationSubpage(tx, String(ids.appUuid)));
    expect(row).toMatchObject({ uuid: ids.appUuid, swarm_replicas: 1, swarm_placement_constraints: null, is_swarm_only_worker_nodes: true, is_maintenance_enabled: false, maintenance_page: null });
    expect(await withOrg(ex, B, (tx) => findApplicationSubpage(tx, String(ids.appUuid)))).toBeNull();
  });

  it("lists its servers: the destination's, then the additional ones, each once, with their settings", async () => {
    const servers = await withOrg(ex, A, (tx) => listApplicationMaintenanceServers(tx, ids.app!));
    expect(servers.map((s) => [String(s.id), s.ip, s.is_swarm_worker, s.public_ipv4])).toEqual([
      [String(ids.main), "203.0.113.10", false, null],
      [String(ids.extra), "203.0.113.11", true, "198.51.100.7"],
    ]);
    expect(typeof servers[0]!.proxy === "string" ? JSON.parse(servers[0]!.proxy) : servers[0]!.proxy).toMatchObject({ type: "TRAEFIK" });
    expect(servers[0]).toMatchObject({ is_reachable: false, is_usable: false, force_disabled: false });
    expect(await withOrg(ex, B, (tx) => listApplicationMaintenanceServers(tx, ids.app!))).toEqual([]);
    // A soft-deleted server runs nothing.
    await admin("UPDATE deploy.servers SET deleted_at = now() WHERE id = $1", [ids.extra]);
    expect((await withOrg(ex, A, (tx) => listApplicationMaintenanceServers(tx, ids.app!))).map((s) => String(s.id))).toEqual([String(ids.main)]);
    await admin("UPDATE deploy.servers SET deleted_at = NULL WHERE id = $1", [ids.extra]);
  });

  it("writes the swarm settings on the application and its settings, and the maintenance columns", async () => {
    await withOrg(ex, A, async (tx) => {
      expect(await updateApplicationSwarm(tx, ids.app!, { swarmReplicas: 3, swarmPlacementConstraints: "cGxhY2VtZW50Og==", isSwarmOnlyWorkerNodes: false })).toBe(true);
      expect(await updateResourceMaintenance(tx, "application", ids.app!, { is_maintenance_enabled: true })).toBe(true);
      expect(await updateResourceMaintenance(tx, "application", ids.app!, { maintenance_page: "<p>soon</p>" })).toBe(true);
      expect(await updateResourceMaintenance(tx, "application", ids.app!, {})).toBe(true);
      expect(await findApplicationSubpage(tx, String(ids.appUuid))).toMatchObject({ swarm_replicas: 3, swarm_placement_constraints: "cGxhY2VtZW50Og==", is_swarm_only_worker_nodes: false, is_maintenance_enabled: true, maintenance_page: "<p>soon</p>" });
    });
    // Another org's row is not there to write.
    await withOrg(ex, B, async (tx) => {
      expect(await updateApplicationSwarm(tx, ids.app!, { swarmReplicas: 9, swarmPlacementConstraints: null, isSwarmOnlyWorkerNodes: true })).toBe(false);
      expect(await updateResourceMaintenance(tx, "application", ids.app!, { maintenance_page: null })).toBe(false);
    });
    expect((await withOrg(ex, A, (tx) => findApplicationSubpage(tx, String(ids.appUuid))))).toMatchObject({ swarm_replicas: 3, maintenance_page: "<p>soon</p>" });
  });
});

describe("a service's Maintenance Mode and Domains rows", () => {
  it("reads the service and its server", async () => {
    await withOrg(ex, A, async (tx) => {
      expect(await findServiceSubpage(tx, "svca")).toMatchObject({ uuid: "svca", is_maintenance_enabled: false, maintenance_page: null });
      expect((await listServiceMaintenanceServers(tx, ids.service!)).map((s) => s.ip)).toEqual(["203.0.113.10"]);
      expect(await findServiceSubpage(tx, "svcb")).toBeNull();
      expect(await updateResourceMaintenance(tx, "service", ids.service!, { is_maintenance_enabled: true, maintenance_page: "<p>x</p>" })).toBe(true);
      expect(await findServiceSubpage(tx, "svca")).toMatchObject({ is_maintenance_enabled: true, maintenance_page: "<p>x</p>" });
    });
    await withOrg(ex, B, async (tx) => {
      expect(await findServiceSubpage(tx, "svca")).toBeNull();
      // A service without a server has none.
      expect(await listServiceMaintenanceServers(tx, ids.serviceb!)).toEqual([]);
      expect(await listServiceMaintenanceServers(tx, ids.service!)).toEqual([]);
    });
  });

  it("reads and writes the applications' DNS statuses, only the service's own", async () => {
    await withOrg(ex, A, async (tx) => {
      expect((await listServiceApplicationDnsStatuses(tx, ids.service!)).map((r) => [String(r.id), r.domain_dns_statuses])).toEqual([
        [String(ids.web), null],
        [String(ids.api), null],
      ]);
      const statuses = { "https://web.example.com": { status: "skipped", message: "DNS check could not be started." } };
      expect(await updateServiceApplicationDnsStatuses(tx, ids.service!, ids.web!, statuses)).toBe(true);
      const read = (await listServiceApplicationDnsStatuses(tx, ids.service!))[0]!.domain_dns_statuses;
      expect(typeof read === "string" ? JSON.parse(read) : read).toEqual(statuses);
      // An application of another service is not this one's.
      expect(await updateServiceApplicationDnsStatuses(tx, ids.serviceb!, ids.web!, null)).toBe(false);
      expect(await updateServiceApplicationDnsStatuses(tx, ids.service!, ids.web!, null)).toBe(true);
      expect((await listServiceApplicationDnsStatuses(tx, ids.service!))[0]!.domain_dns_statuses).toBeNull();
    });
    await withOrg(ex, B, async (tx) => {
      expect(await listServiceApplicationDnsStatuses(tx, ids.service!)).toEqual([]);
      expect(await updateServiceApplicationDnsStatuses(tx, ids.service!, ids.web!, {})).toBe(false);
    });
  });
});
