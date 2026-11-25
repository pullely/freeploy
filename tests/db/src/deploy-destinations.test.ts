// deploy.standalone_dockers and deploy.swarm_dockers (DP-44) against a real
// Postgres: the store functions of @saas/db/deploy inside withOrg() — a new
// server's default destination, Coolify's list orders, attachedTo() and the
// resources list over the real resource tables — and row-level security
// keeping each org's destinations to itself.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  insertPrivateKey,
  insertServer,
  deleteServer,
  listUsableServers,
  listUsableServerDestinations,
  listServerDestinations,
  findDestinationByUuid,
  destinationNetworkExists,
  insertDestination,
  updateDestinationName,
  deleteDestination,
  destinationIsAttached,
  listDestinationResources,
  DEFAULT_STANDALONE_DESTINATION,
  DESTINATION_MORPH_CLASS,
} from "@saas/db/deploy";
import type { SqlExecutor, TransactionalSqlExecutor } from "@saas/db/hyperdrive";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SQL = ["500_deploy_core", "510_deploy_org_keys", "520_deploy_schema_fold_fixes"].map((m) => readFileSync(resolve(root, `packages/db/src/migrations/${m}/up.sql`), "utf8")).join("\n");
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

function executor(db: PGlite): TransactionalSqlExecutor {
  const wrap = (q: { query: PGlite["query"] }): SqlExecutor => ({
    async execute(text, params) {
      const r = await q.query(text, params ?? []);
      return { rows: r.rows as never[], rowCount: r.rows.length };
    },
  });
  return { ...wrap(db), transaction: (fn) => db.transaction((tx) => fn(wrap(tx as never))) };
}

let db: PGlite;
let ex: TransactionalSqlExecutor;
const ids: Record<string, string | number> = {};
/** Marks a server validated, as the SSH validation will: reachable and usable. */
const validate = (org: string, uuid: string) =>
  withOrg(ex, org, (tx) => tx.execute(`UPDATE deploy.server_settings SET is_reachable = true, is_usable = true WHERE server_id = $1`, [ids[uuid]!]));

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SQL);
  ex = executor(db);
  // Names chosen so that the list order (by server name) differs from the insert order.
  for (const [org, uuid, name, ip] of [
    [A, "srvaaaaaaaaaaaaaaaaaaaaa", "zeta", "203.0.113.10"],
    [A, "srvbbbbbbbbbbbbbbbbbbbbb", "alpha", "203.0.113.11"],
    [B, "srvccccccccccccccccccccc", "beta", "203.0.113.12"],
  ] as const) {
    const key = await withOrg(ex, org, (tx) => insertPrivateKey(tx, { orgId: org, uuid: `key${uuid.slice(3)}`, name: "key", description: null, privateKey: "fp1:fake", fingerprint: null }));
    const row = await withOrg(ex, org, (tx) =>
      insertServer(tx, { orgId: org, uuid, name, description: null, ip, user: "root", port: 22, privateKeyId: key.id, proxy: {}, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: `dst${uuid.slice(3)}` }),
    );
    ids[uuid] = row.id;
  }
}, 120_000);
afterAll(async () => db?.close());

describe("deploy.standalone_dockers and deploy.swarm_dockers", () => {
  it("a new server gets Coolify's default destination: a standalone one on network coolify", async () => {
    expect(DEFAULT_STANDALONE_DESTINATION).toEqual({ name: "freeploy", network: "coolify" });
    const rows = await withOrg(ex, A, (tx) => listServerDestinations(tx, ids.srvaaaaaaaaaaaaaaaaaaaaa!));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ uuid: "dstaaaaaaaaaaaaaaaaaaaaa", name: "freeploy", network: "coolify", type: "standalone", server_uuid: "srvaaaaaaaaaaaaaaaaaaaaa", server_name: "zeta", server_ip: "203.0.113.10" });
    expect(rows[0]!.created_at).not.toBeNull();
    const swarm = await withOrg(ex, A, (tx) => tx.execute(`SELECT 1 FROM deploy.swarm_dockers`));
    expect(swarm.rows).toHaveLength(0);
  });

  it("adds, finds and renames destinations of both kinds; a network is per server and kind", async () => {
    const zeta = ids.srvaaaaaaaaaaaaaaaaaaaaa!;
    const added = await withOrg(ex, A, (tx) => insertDestination(tx, { orgId: A, type: "standalone", uuid: "dstzzzzzzzzzzzzzzzzzzzzz", name: "zeta-apps", network: "apps", serverId: zeta }));
    expect(added).toMatchObject({ uuid: "dstzzzzzzzzzzzzzzzzzzzzz", name: "zeta-apps", network: "apps", type: "standalone", server_name: "zeta" });
    await withOrg(ex, A, (tx) => insertDestination(tx, { orgId: A, type: "swarm", uuid: "dstsssssssssssssssssssss", name: "zeta-overlay", network: "coolify-overlay", serverId: zeta }));
    expect(await withOrg(ex, A, (tx) => destinationNetworkExists(tx, "standalone", zeta, "apps"))).toBe(true);
    expect(await withOrg(ex, A, (tx) => destinationNetworkExists(tx, "swarm", zeta, "apps"))).toBe(false);
    expect(await withOrg(ex, A, (tx) => destinationNetworkExists(tx, "standalone", ids.srvbbbbbbbbbbbbbbbbbbbbb!, "apps"))).toBe(false);
    // The server's list: standalone destinations, then the Swarm ones.
    expect((await withOrg(ex, A, (tx) => listServerDestinations(tx, zeta))).map((d) => [d.network, d.type])).toEqual([
      ["coolify", "standalone"],
      ["apps", "standalone"],
      ["coolify-overlay", "swarm"],
    ]);
    expect((await withOrg(ex, A, (tx) => findDestinationByUuid(tx, "dstsssssssssssssssssssss")))!).toMatchObject({ type: "swarm", network: "coolify-overlay", server_ip: "203.0.113.10" });
    expect(await withOrg(ex, A, (tx) => findDestinationByUuid(tx, "nosuchdestination"))).toBeNull();
    expect(await withOrg(ex, A, (tx) => updateDestinationName(tx, "standalone", added.id, "renamed"))).toBe(true);
    const renamed = (await withOrg(ex, A, (tx) => findDestinationByUuid(tx, "dstzzzzzzzzzzzzzzzzzzzzz")))!;
    expect(renamed).toMatchObject({ name: "renamed", network: "apps" });
    expect(await withOrg(ex, A, (tx) => updateDestinationName(tx, "swarm", 999_999, "x"))).toBe(false);
  });

  it("Index lists only the destinations of usable servers, by server name (Server::isUsable)", async () => {
    // No server is validated yet: nothing is listed.
    expect(await withOrg(ex, A, listUsableServers)).toEqual([]);
    expect(await withOrg(ex, A, listUsableServerDestinations)).toEqual([]);
    await validate(A, "srvaaaaaaaaaaaaaaaaaaaaa");
    await validate(A, "srvbbbbbbbbbbbbbbbbbbbbb");
    expect((await withOrg(ex, A, listUsableServers)).map((s) => s.name)).toEqual(["alpha", "zeta"]);
    expect((await withOrg(ex, A, listUsableServerDestinations)).map((d) => [d.server_name, d.network, d.type])).toEqual([
      ["alpha", "coolify", "standalone"],
      ["zeta", "coolify", "standalone"],
      ["zeta", "apps", "standalone"],
      ["zeta", "coolify-overlay", "swarm"],
    ]);
    // A build server, a Swarm worker and a disabled server are not usable.
    const alpha = ids.srvbbbbbbbbbbbbbbbbbbbbb!;
    const set = (sql: string) => withOrg(ex, A, (tx) => tx.execute(`UPDATE deploy.server_settings SET ${sql} WHERE server_id = $1`, [alpha]));
    for (const [off, on] of [
      ["server_role = 'build'", "server_role = 'both'"],
      ["is_swarm_worker = true", "is_swarm_worker = false"],
    ] as const) {
      await set(off);
      expect((await withOrg(ex, A, listUsableServers)).map((s) => s.name)).toEqual(["zeta"]);
      await set(on);
    }
    await set("force_disabled = true");
    expect((await withOrg(ex, A, listUsableServerDestinations)).map((d) => d.server_name)).toEqual(["zeta", "zeta", "zeta"]);
    // A legacy row without a role follows the build flag.
    await set("force_disabled = false, server_role = NULL, is_build_server = false");
    expect((await withOrg(ex, A, listUsableServers)).map((s) => s.name)).toEqual(["alpha", "zeta"]);
  });

  it("attachedTo() and the resources list read the resource tables, without soft-deleted rows", async () => {
    const d = (await withOrg(ex, A, (tx) => findDestinationByUuid(tx, "dstzzzzzzzzzzzzzzzzzzzzz")))!;
    expect(await withOrg(ex, A, (tx) => destinationIsAttached(tx, "standalone", d.id))).toBe(false);
    expect(await withOrg(ex, A, (tx) => listDestinationResources(tx, "standalone", d.id))).toEqual([]);
    const standalone = DESTINATION_MORPH_CLASS.standalone;
    expect(standalone).toBe("App\\Models\\StandaloneDocker");
    await withOrg(ex, A, async (tx) => {
      const p = await tx.execute<{ id: number }>(`INSERT INTO deploy.projects (uuid, name, org_id) VALUES ('prjaaaaaaaaaaaaaaaaaaaaa', 'Shop', $1) RETURNING id`, [A]);
      const e = await tx.execute<{ id: number }>(`INSERT INTO deploy.environments (uuid, name, project_id, org_id) VALUES ('envaaaaaaaaaaaaaaaaaaaaa', 'production', $1, $2) RETURNING id`, [p.rows[0]!.id, A]);
      const env = e.rows[0]!.id;
      // A database without an environment, a service, an application, and a soft-deleted application.
      await tx.execute(`INSERT INTO deploy.standalone_redis (uuid, name, destination_id, destination_type, org_id) VALUES ('rdsaaaaaaaaaaaaaaaaaaaaa', 'cache', $1, $2, $3)`, [d.id, standalone, A]);
      await tx.execute(
        `INSERT INTO deploy.services (uuid, name, environment_id, docker_compose_raw, destination_id, destination_type, org_id) VALUES ('svcaaaaaaaaaaaaaaaaaaaaa', 'plausible', $1, 'services: {}', $2, $3, $4)`,
        [env, d.id, standalone, A],
      );
      for (const [uuid, name, deleted] of [
        ["appaaaaaaaaaaaaaaaaaaaaa", "web", null],
        ["appbbbbbbbbbbbbbbbbbbbbb", "gone", "2026-01-01 00:00:00"],
      ] as const) {
        await tx.execute(
          `INSERT INTO deploy.applications (uuid, name, git_repository, git_branch, build_pack, environment_id, destination_id, destination_type, deleted_at, org_id)
           VALUES ($1, $2, 'acme/web', 'main', 'nixpacks', $3, $4, $5, $6, $7)`,
          [uuid, name, env, d.id, standalone, deleted, A],
        );
      }
      // The same id as a Swarm destination's is another destination.
      await tx.execute(`INSERT INTO deploy.standalone_redis (uuid, name, destination_id, destination_type, org_id) VALUES ('rdsbbbbbbbbbbbbbbbbbbbbb', 'other', $1, $2, $3)`, [d.id, DESTINATION_MORPH_CLASS.swarm, A]);
    });
    expect(await withOrg(ex, A, (tx) => destinationIsAttached(tx, "standalone", d.id))).toBe(true);
    const rows = await withOrg(ex, A, (tx) => listDestinationResources(tx, "standalone", d.id));
    // Resources::loadResources(): applications, services, then the databases.
    expect(rows).toEqual([
      { type: "application", uuid: "appaaaaaaaaaaaaaaaaaaaaa", name: "web", environment_uuid: "envaaaaaaaaaaaaaaaaaaaaa", environment_name: "production", project_uuid: "prjaaaaaaaaaaaaaaaaaaaaa", project_name: "Shop" },
      { type: "service", uuid: "svcaaaaaaaaaaaaaaaaaaaaa", name: "plausible", environment_uuid: "envaaaaaaaaaaaaaaaaaaaaa", environment_name: "production", project_uuid: "prjaaaaaaaaaaaaaaaaaaaaa", project_name: "Shop" },
      { type: "database", uuid: "rdsaaaaaaaaaaaaaaaaaaaaa", name: "cache", environment_uuid: null, environment_name: null, project_uuid: null, project_name: null },
    ]);
    expect((await withOrg(ex, A, (tx) => listDestinationResources(tx, "swarm", d.id))).map((r) => r.name)).toEqual(["other"]);
    // The default destination of the same server has none.
    const def = (await withOrg(ex, A, (tx) => findDestinationByUuid(tx, "dstaaaaaaaaaaaaaaaaaaaaa")))!;
    expect(await withOrg(ex, A, (tx) => destinationIsAttached(tx, "standalone", def.id))).toBe(false);
  });

  it("keeps each org's destinations to itself (row-level security)", async () => {
    const d = (await withOrg(ex, A, (tx) => findDestinationByUuid(tx, "dstzzzzzzzzzzzzzzzzzzzzz")))!;
    expect(await withOrg(ex, B, (tx) => findDestinationByUuid(tx, "dstzzzzzzzzzzzzzzzzzzzzz"))).toBeNull();
    expect(await withOrg(ex, B, (tx) => listServerDestinations(tx, ids.srvaaaaaaaaaaaaaaaaaaaaa!))).toEqual([]);
    expect(await withOrg(ex, B, (tx) => updateDestinationName(tx, "standalone", d.id, "stolen"))).toBe(false);
    expect(await withOrg(ex, B, (tx) => deleteDestination(tx, "standalone", d.id))).toBe(false);
    expect(await withOrg(ex, B, (tx) => destinationIsAttached(tx, "standalone", d.id))).toBe(false);
    expect(await withOrg(ex, B, (tx) => destinationNetworkExists(tx, "standalone", ids.srvaaaaaaaaaaaaaaaaaaaaa!, "apps"))).toBe(false);
    await expect(
      withOrg(ex, B, (tx) => insertDestination(tx, { orgId: A, type: "standalone", uuid: "dstxxxxxxxxxxxxxxxxxxxxx", name: "x", network: "x", serverId: ids.srvaaaaaaaaaaaaaaaaaaaaa! })),
    ).rejects.toThrow(/row-level security/);
    await validate(B, "srvccccccccccccccccccccc");
    expect((await withOrg(ex, B, listUsableServerDestinations)).map((x) => x.uuid)).toEqual(["dstccccccccccccccccccccc"]);
    expect((await withOrg(ex, A, (tx) => findDestinationByUuid(tx, "dstzzzzzzzzzzzzzzzzzzzzz")))!.name).toBe("renamed");
  });

  it("deletes a destination, and a deleted server takes its destinations with it", async () => {
    const swarm = (await withOrg(ex, A, (tx) => findDestinationByUuid(tx, "dstsssssssssssssssssssss")))!;
    expect(await withOrg(ex, A, (tx) => deleteDestination(tx, "swarm", swarm.id))).toBe(true);
    expect(await withOrg(ex, A, (tx) => findDestinationByUuid(tx, "dstsssssssssssssssssssss"))).toBeNull();
    expect(await withOrg(ex, A, (tx) => deleteDestination(tx, "swarm", swarm.id))).toBe(false);
    // Another org cannot delete the server, nor its destinations with it.
    expect(await withOrg(ex, B, (tx) => deleteServer(tx, ids.srvaaaaaaaaaaaaaaaaaaaaa!))).toBe(false);
    expect(await withOrg(ex, A, (tx) => listServerDestinations(tx, ids.srvaaaaaaaaaaaaaaaaaaaaa!))).toHaveLength(2);
    expect(await withOrg(ex, A, (tx) => deleteServer(tx, ids.srvaaaaaaaaaaaaaaaaaaaaa!))).toBe(true);
    const left = await withOrg(ex, A, (tx) => tx.execute<{ uuid: string }>(`SELECT uuid FROM deploy.standalone_dockers ORDER BY id`));
    expect(left.rows.map((r) => r.uuid)).toEqual(["dstbbbbbbbbbbbbbbbbbbbbb"]);
  });
});
