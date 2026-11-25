// DP-63: the unique indexes of 660_deploy_schema_catch_up on the tables
// deploy-core-worker writes, against a real Postgres (PGlite) at head.
//
// For each index:
//   1. the question the service asks before it writes (the store function its
//      pre-check calls) finds the row — so the service answers its Coolify
//      message and never reaches the index;
//   2. the write it would make had the question said no — two requests at the
//      same moment — is refused with SQLSTATE 23505 naming that index, which
//      is what refusingDuplicates() turns into the same answer
//      (tests/deploy-core-worker holds the HTTP answers);
//   3. the refused write leaves nothing behind.
//
// And the one sequence the DP-60 report named: the application's own main
// network as an additional destination, then a promotion.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  insertPrivateKey,
  insertServer,
  insertProject,
  insertEnvironment,
  updateEnvironment,
  environmentNameExists,
  listServerDestinations,
  insertDestination,
  destinationNetworkExists,
  insertDockerImageApplication,
  insertPersistentVolume,
  updatePersistentVolume,
  listPersistentVolumes,
  insertFileVolume,
  listFileVolumes,
  insertTag,
  attachTag,
  resourceHasTag,
  insertSharedVariable,
  updateSharedVariable,
  findSharedVariableByKey,
  attachAdditionalDestination,
  additionalDestinationExists,
  promoteAdditionalDestination,
  listAdditionalDestinations,
  refusingDuplicates,
  violatedUniqueIndex,
  DEPLOY_UNIQUE_INDEXES,
  SHARED_VARIABLE_UNIQUE_INDEXES,
  APPLICATION_MORPH_CLASS,
  APPLICATION_WEBHOOK_SECRET_COLUMNS,
  type DeployDestinationRow,
  type DeployUniqueIndex,
  type NewDockerImageApplication,
  type SharedVariableOwner,
  type StorageOwner,
} from "@saas/db/deploy";
import type { SqlExecutor, TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, executor, migrationSql } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
/** The tables of the 33 new unique indexes that the service layer writes. */
const WRITTEN_TABLES = ["environments", "local_persistent_volumes", "local_file_volumes", "standalone_dockers", "swarm_dockers", "taggables", "additional_destinations", "shared_environment_variables"];

let db: PGlite;
let ex: TransactionalSqlExecutor;

interface Fixture {
  serverId: string | number;
  destination: DeployDestinationRow;
  otherServerId: string | number;
  otherDestination: DeployDestinationRow;
  projectId: string | number;
  environmentId: string | number;
  stagingId: string | number;
  applicationId: string | number;
  tagId: string | number;
}
const fx: Record<string, Fixture> = {};

async function fixture(org: string, tag: string): Promise<Fixture> {
  return withOrg(ex, org, async (tx) => {
    const key = await insertPrivateKey(tx, { orgId: org, uuid: `key${tag}`, name: `key-${tag}`, description: null, privateKey: "fp1:fake", fingerprint: null });
    const server = (name: string, uuid: string, dst: string) =>
      insertServer(tx, {
        orgId: org, uuid, name, description: null, ip: "203.0.113.10", user: "root", port: 22, privateKeyId: key.id,
        proxy: { type: "TRAEFIK", status: "exited" }, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: dst,
      });
    const main = await server(`main-${tag}`, `srv${tag}`, `dst${tag}`);
    const other = await server(`edge-${tag}`, `srv2${tag}`, `dst2${tag}`);
    const { project, environment } = await insertProject(tx, { orgId: org, uuid: `prj${tag}`, name: `Project-${tag}`, description: null, productionEnvironmentUuid: `env${tag}` });
    const staging = await insertEnvironment(tx, { orgId: org, uuid: `stg${tag}`, name: "staging", projectId: project.id });
    const destination = (await listServerDestinations(tx, main.id))[0]!;
    const app: NewDockerImageApplication = {
      orgId: org, uuid: `app${tag}`, name: `docker-image-app${tag}`, fqdn: null, domainPortOverrides: null, dockerRegistryImageName: "nginx", dockerRegistryImageTag: "latest",
      environmentId: environment.id, destinationId: destination.id, destinationType: "standalone",
      webhookSecrets: Object.fromEntries(APPLICATION_WEBHOOK_SECRET_COLUMNS.map((c) => [c, `fp1:${tag}:${c}`])) as NewDockerImageApplication["webhookSecrets"],
    };
    const application = await insertDockerImageApplication(tx, app);
    const tagRow = await insertTag(tx, { orgId: org, uuid: `tag${tag}`, name: "api" });
    return {
      serverId: main.id, destination, otherServerId: other.id, otherDestination: (await listServerDestinations(tx, other.id))[0]!,
      projectId: project.id, environmentId: environment.id, stagingId: staging.id, applicationId: application.id, tagId: tagRow.id,
    };
  });
}

const count = async (table: string, where = "true", params: unknown[] = []): Promise<number> =>
  asPlatformAdmin(ex, async (tx) => Number((await tx.execute<{ n: number }>(`SELECT count(*)::int AS n FROM deploy.${table} WHERE ${where}`, params)).rows[0]!.n));

/** The error of a write inside the org's transaction, which the refusal rolls back. */
async function refusal(org: string, write: (tx: SqlExecutor) => Promise<unknown>): Promise<unknown> {
  try {
    await withOrg(ex, org, write);
    return null;
  } catch (error) {
    return error;
  }
}

class Duplicate extends Error {}

beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
  fx.a = await fixture(A, "a");
  fx.b = await fixture(B, "b");
}, 120_000);
afterAll(async () => db?.close());

describe("the indexes the worker's answers are keyed on", () => {
  it("are 660's unique indexes on the tables the service layer writes — all of them, by name", () => {
    const created = [...migrationSql("660_deploy_schema_catch_up").matchAll(/CREATE UNIQUE INDEX IF NOT EXISTS (\w+) ON deploy\.(\w+) /g)].map((m) => ({ name: m[1]!, table: m[2]! }));
    expect(created).toHaveLength(33);
    expect(created.filter((i) => WRITTEN_TABLES.includes(i.table)).map((i) => i.name).sort()).toEqual(Object.values(DEPLOY_UNIQUE_INDEXES).sort());
    expect([...SHARED_VARIABLE_UNIQUE_INDEXES].sort()).toEqual(Object.values(DEPLOY_UNIQUE_INDEXES).filter((i) => i.startsWith("shared_environment_variables_")).sort());
  });

  it("exist at head, unique, on Coolify's columns (team_id as org_id)", async () => {
    const rows = await db.query<{ indexname: string; tablename: string; indexdef: string }>("SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname = 'deploy' AND indexname = ANY($1) ORDER BY indexname", [Object.values(DEPLOY_UNIQUE_INDEXES)]);
    const columns = (def: string) => /\((.*)\)$/.exec(def)![1]!.replace(/"/g, "");
    expect(rows.rows.every((r) => r.indexdef.startsWith("CREATE UNIQUE INDEX"))).toBe(true);
    expect(Object.fromEntries(rows.rows.map((r) => [r.indexname, `${r.tablename} (${columns(r.indexdef)})`]))).toEqual({
      [DEPLOY_UNIQUE_INDEXES.additionalDestination]: "additional_destinations (application_id, server_id, standalone_docker_id)",
      [DEPLOY_UNIQUE_INDEXES.environmentName]: "environments (name, project_id)",
      [DEPLOY_UNIQUE_INDEXES.fileVolumeMountPath]: "local_file_volumes (mount_path, resource_id, resource_type)",
      [DEPLOY_UNIQUE_INDEXES.persistentVolumeName]: "local_persistent_volumes (name, resource_id, resource_type)",
      [DEPLOY_UNIQUE_INDEXES.sharedVariableEnvironment]: "shared_environment_variables (key, environment_id, org_id)",
      [DEPLOY_UNIQUE_INDEXES.sharedVariableProject]: "shared_environment_variables (key, project_id, org_id)",
      [DEPLOY_UNIQUE_INDEXES.sharedVariableServer]: "shared_environment_variables (key, server_id, org_id)",
      [DEPLOY_UNIQUE_INDEXES.standaloneNetwork]: "standalone_dockers (server_id, network)",
      [DEPLOY_UNIQUE_INDEXES.swarmNetwork]: "swarm_dockers (server_id, network)",
      [DEPLOY_UNIQUE_INDEXES.taggable]: "taggables (tag_id, taggable_id, taggable_type)",
    });
  });
});

describe("a duplicate: the service's question finds it, and the index refuses the write that did not ask", () => {
  interface Case {
    index: DeployUniqueIndex;
    /** The table, and the rows a refused write must not add to. */
    table: string;
    /** Stores the first row. */
    first: (tx: SqlExecutor, f: Fixture) => Promise<unknown>;
    /** The store function the service's pre-check calls, for the second request. */
    asked: (tx: SqlExecutor, f: Fixture) => Promise<boolean>;
    /** The second request's write. */
    second: (tx: SqlExecutor, f: Fixture) => Promise<unknown>;
  }
  const application = (f: Fixture): StorageOwner => ({ type: APPLICATION_MORPH_CLASS, id: f.applicationId });
  const variable = (owner: SharedVariableOwner, key: string) => (tx: SqlExecutor) => insertSharedVariable(tx, { orgId: A, owner, key, value: "fp1:x" });
  const sharedCase = (index: DeployUniqueIndex, owner: (f: Fixture) => SharedVariableOwner): Case => ({
    index,
    table: "shared_environment_variables",
    first: (tx, f) => variable(owner(f), "API_URL")(tx),
    asked: async (tx, f) => (await findSharedVariableByKey(tx, owner(f), "API_URL")) !== null,
    second: (tx, f) => variable(owner(f), "API_URL")(tx),
  });
  const CASES: Case[] = [
    {
      index: DEPLOY_UNIQUE_INDEXES.environmentName,
      table: "environments",
      first: async () => undefined, // "staging" is the fixture's
      asked: (tx, f) => environmentNameExists(tx, f.projectId, "staging"),
      second: (tx, f) => insertEnvironment(tx, { orgId: A, uuid: "stg-again", name: "staging", projectId: f.projectId }),
    },
    {
      index: DEPLOY_UNIQUE_INDEXES.persistentVolumeName,
      table: "local_persistent_volumes",
      first: (tx, f) => insertPersistentVolume(tx, { orgId: A, owner: application(f), uuid: "vol1", name: "appa-data", mountPath: "/data", hostPath: null }),
      asked: async (tx, f) => (await listPersistentVolumes(tx, application(f))).some((v) => v.name === "appa-data"),
      second: (tx, f) => insertPersistentVolume(tx, { orgId: A, owner: application(f), uuid: "vol2", name: "appa-data", mountPath: "/other", hostPath: null }),
    },
    {
      index: DEPLOY_UNIQUE_INDEXES.fileVolumeMountPath,
      table: "local_file_volumes",
      first: (tx, f) => insertFileVolume(tx, { orgId: A, owner: application(f), uuid: "file1", fsPath: "/data/appa/app.conf", mountPath: "/etc/app.conf", content: null, isDirectory: false, isHostFile: false }),
      asked: async (tx, f) => (await listFileVolumes(tx, application(f))).some((v) => v.mount_path === "/etc/app.conf"),
      second: (tx, f) => insertFileVolume(tx, { orgId: A, owner: application(f), uuid: "file2", fsPath: "/data/appa/etc", mountPath: "/etc/app.conf", content: null, isDirectory: true, isHostFile: false }),
    },
    {
      index: DEPLOY_UNIQUE_INDEXES.standaloneNetwork,
      table: "standalone_dockers",
      first: (tx, f) => insertDestination(tx, { orgId: A, type: "standalone", uuid: "net1", name: "one", network: "shared-net", serverId: f.serverId }),
      asked: (tx, f) => destinationNetworkExists(tx, "standalone", f.serverId, "shared-net"),
      second: (tx, f) => insertDestination(tx, { orgId: A, type: "standalone", uuid: "net2", name: "two", network: "shared-net", serverId: f.serverId }),
    },
    {
      index: DEPLOY_UNIQUE_INDEXES.swarmNetwork,
      table: "swarm_dockers",
      first: (tx, f) => insertDestination(tx, { orgId: A, type: "swarm", uuid: "swm1", name: "one", network: "overlay-net", serverId: f.serverId }),
      asked: (tx, f) => destinationNetworkExists(tx, "swarm", f.serverId, "overlay-net"),
      second: (tx, f) => insertDestination(tx, { orgId: A, type: "swarm", uuid: "swm2", name: "two", network: "overlay-net", serverId: f.serverId }),
    },
    {
      index: DEPLOY_UNIQUE_INDEXES.taggable,
      table: "taggables",
      first: (tx, f) => attachTag(tx, A, application(f), f.tagId),
      asked: (tx, f) => resourceHasTag(tx, application(f), f.tagId),
      second: (tx, f) => attachTag(tx, A, application(f), f.tagId),
    },
    sharedCase(DEPLOY_UNIQUE_INDEXES.sharedVariableProject, (f) => ({ type: "project", id: f.projectId })),
    sharedCase(DEPLOY_UNIQUE_INDEXES.sharedVariableEnvironment, (f) => ({ type: "environment", id: f.environmentId })),
    sharedCase(DEPLOY_UNIQUE_INDEXES.sharedVariableServer, (f) => ({ type: "server", id: f.serverId })),
  ];

  it.each(CASES.map((c) => [c.index, c] as const))("%s", async (index, c) => {
    const f = fx.a!;
    await withOrg(ex, A, (tx) => c.first(tx, f));
    const before = await count(c.table);
    // 1. the question
    expect(await withOrg(ex, A, (tx) => c.asked(tx, f))).toBe(true);
    // 2. the write that did not ask
    const error = await refusal(A, (tx) => c.second(tx, f));
    expect([(error as { code?: string } | null)?.code, violatedUniqueIndex(error)]).toEqual(["23505", index]);
    expect(await refusal(A, (tx) => refusingDuplicates([index], () => c.second(tx, f), () => new Duplicate()))).toBeInstanceOf(Duplicate);
    // Only its own index is translated.
    const other = Object.values(DEPLOY_UNIQUE_INDEXES).filter((i) => i !== index);
    expect(violatedUniqueIndex(await refusal(A, (tx) => refusingDuplicates(other, () => c.second(tx, f), () => new Duplicate())))).toBe(index);
    // 3. nothing was added, and the org's next transaction works
    expect(await count(c.table)).toBe(before);
    expect(await withOrg(ex, A, (tx) => c.asked(tx, f))).toBe(true);
  });

  it("a rename onto a taken name is refused the same way: environments, volumes, shared variables", async () => {
    const f = fx.a!;
    const production = await withOrg(ex, A, async (tx) => (await tx.execute<{ id: number }>("SELECT id FROM deploy.environments WHERE project_id = $1 AND name = 'production'", [f.projectId])).rows[0]!.id);
    expect(await withOrg(ex, A, (tx) => environmentNameExists(tx, f.projectId, "staging", production))).toBe(true);
    expect(await withOrg(ex, A, (tx) => environmentNameExists(tx, f.projectId, "production", production))).toBe(false);
    expect(violatedUniqueIndex(await refusal(A, (tx) => updateEnvironment(tx, production, { name: "staging", description: null })))).toBe(DEPLOY_UNIQUE_INDEXES.environmentName);

    const owner: StorageOwner = { type: APPLICATION_MORPH_CLASS, id: f.applicationId };
    const cache = await withOrg(ex, A, (tx) => insertPersistentVolume(tx, { orgId: A, owner, uuid: "vol3", name: "appa-cache", mountPath: "/cache", hostPath: null }));
    expect(violatedUniqueIndex(await refusal(A, (tx) => updatePersistentVolume(tx, owner, cache.id, { name: "appa-data" })))).toBe(DEPLOY_UNIQUE_INDEXES.persistentVolumeName);

    const project: SharedVariableOwner = { type: "project", id: f.projectId };
    const other = await withOrg(ex, A, (tx) => insertSharedVariable(tx, { orgId: A, owner: project, key: "OTHER", value: "fp1:x" }));
    expect(violatedUniqueIndex(await refusal(A, (tx) => updateSharedVariable(tx, other.id, { key: "API_URL" })))).toBe(DEPLOY_UNIQUE_INDEXES.sharedVariableProject);
    expect((await withOrg(ex, A, (tx) => findSharedVariableByKey(tx, project, "OTHER")))!.id).toEqual(other.id);
  });

  it("is each org's own: org B stores the same names, mounts, networks, keys and tag", async () => {
    const f = fx.b!;
    const owner: StorageOwner = { type: APPLICATION_MORPH_CLASS, id: f.applicationId };
    await withOrg(ex, B, async (tx) => {
      await insertPersistentVolume(tx, { orgId: B, owner, uuid: "vol1b", name: "appa-data", mountPath: "/data", hostPath: null });
      await insertFileVolume(tx, { orgId: B, owner, uuid: "file1b", fsPath: "/data/appb/app.conf", mountPath: "/etc/app.conf", content: null, isDirectory: false, isHostFile: false });
      await insertDestination(tx, { orgId: B, type: "standalone", uuid: "net1b", name: "one", network: "shared-net", serverId: f.serverId });
      await insertDestination(tx, { orgId: B, type: "swarm", uuid: "swm1b", name: "one", network: "overlay-net", serverId: f.serverId });
      await attachTag(tx, B, owner, f.tagId);
      for (const o of [{ type: "project", id: f.projectId }, { type: "environment", id: f.environmentId }, { type: "server", id: f.serverId }] as SharedVariableOwner[]) {
        await insertSharedVariable(tx, { orgId: B, owner: o, key: "API_URL", value: "fp1:x" });
      }
    });
    // And org B's question does not see org A's rows: another server's network of that name is free.
    expect(await withOrg(ex, B, (tx) => destinationNetworkExists(tx, "standalone", f.otherServerId, "shared-net"))).toBe(false);
    expect(await withOrg(ex, B, (tx) => environmentNameExists(tx, fx.a!.projectId, "staging"))).toBe(false);
  });

  it("the org scope of shared variables has no index, as in Coolify: its three owner columns are NULL, so the look-up is its only guard", async () => {
    const team: SharedVariableOwner = { type: "team", id: null };
    await withOrg(ex, A, (tx) => insertSharedVariable(tx, { orgId: A, owner: team, key: "TEAM_KEY", value: "fp1:x" }));
    expect(await withOrg(ex, A, async (tx) => (await findSharedVariableByKey(tx, team, "TEAM_KEY")) !== null)).toBe(true);
    // A write that did not ask is stored: what is left to a later task (see IMPLEMENTATION-STATUS, DP-63).
    expect(await refusal(A, (tx) => insertSharedVariable(tx, { orgId: A, owner: team, key: "TEAM_KEY", value: "fp1:y" }))).toBeNull();
    expect(await count("shared_environment_variables", "key = 'TEAM_KEY' AND org_id = $1", [A])).toBe(2);
    await asPlatformAdmin(ex, (tx) => tx.execute("DELETE FROM deploy.shared_environment_variables WHERE key = 'TEAM_KEY'"));
  });
});

describe("additional destinations (deploy.additional_destinations)", () => {
  const pivots = (f: Fixture) => withOrg(ex, A, async (tx) => (await listAdditionalDestinations(tx, f.applicationId)).map((d) => [Number(d.server_id), Number(d.id)]));
  const destinationOf = async (f: Fixture) =>
    withOrg(ex, A, async (tx) => Number((await tx.execute<{ destination_id: number }>("SELECT destination_id FROM deploy.applications WHERE id = $1", [f.applicationId])).rows[0]!.destination_id));

  it("a network is attached once, also when two requests attach it at the same moment", async () => {
    const f = fx.a!;
    expect(await withOrg(ex, A, (tx) => attachAdditionalDestination(tx, A, f.applicationId, f.otherServerId, f.otherDestination.id))).toBe(true);
    expect(await withOrg(ex, A, (tx) => attachAdditionalDestination(tx, A, f.applicationId, f.otherServerId, f.otherDestination.id))).toBe(false);
    // The second of two simultaneous requests: its look-up (the UPDATE) saw no row, its INSERT meets the first one's.
    const racing = (tx: SqlExecutor): SqlExecutor => ({
      execute: (text, params) => (text.startsWith("UPDATE deploy.additional_destinations") ? Promise.resolve({ rows: [], rowCount: 0 }) : tx.execute(text, params)),
    });
    expect(await withOrg(ex, A, (tx) => attachAdditionalDestination(racing(tx), A, f.applicationId, f.otherServerId, f.otherDestination.id))).toBe(false);
    expect(await pivots(f)).toEqual([[Number(f.otherServerId), Number(f.otherDestination.id)]]);
  });

  it("the main network attached as an additional one: the promotion's attach is what the index refuses, and the transaction keeps the main destination", async () => {
    const f = fx.a!;
    // Destination::addServer() takes it (syncWithoutDetaching), in Coolify and here.
    expect(await withOrg(ex, A, (tx) => attachAdditionalDestination(tx, A, f.applicationId, f.serverId, f.destination.id))).toBe(true);
    const before = await pivots(f);
    expect(before).toHaveLength(2);
    // The question promoteServer() asks first.
    expect(await withOrg(ex, A, (tx) => additionalDestinationExists(tx, f.applicationId, f.serverId, f.destination.id))).toBe(true);
    // Not asked: Coolify's sequence — update, detach, attach — ends on the index, and all of it is rolled back.
    const promote = (tx: SqlExecutor) => promoteAdditionalDestination(tx, A, f.applicationId, { serverId: f.otherServerId, networkId: f.otherDestination.id }, { serverId: f.serverId, networkId: f.destination.id });
    const error = await refusal(A, promote);
    expect(violatedUniqueIndex(error)).toBe(DEPLOY_UNIQUE_INDEXES.additionalDestination);
    expect(await refusal(A, (tx) => refusingDuplicates([DEPLOY_UNIQUE_INDEXES.additionalDestination], () => promote(tx), () => new Duplicate()))).toBeInstanceOf(Duplicate);
    expect([await destinationOf(f), await pivots(f)]).toEqual([Number(f.destination.id), before]);

    // Without that row the same promotion goes through: the two destinations change places.
    await asPlatformAdmin(ex, (tx) => tx.execute("DELETE FROM deploy.additional_destinations WHERE application_id = $1 AND standalone_docker_id = $2", [f.applicationId, f.destination.id]));
    expect(await withOrg(ex, A, promote)).toBe(true);
    expect([await destinationOf(f), await pivots(f)]).toEqual([Number(f.otherDestination.id), [[Number(f.serverId), Number(f.destination.id)]]]);
  });
});
