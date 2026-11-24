// Docker registries (DP-47) against a real Postgres. Registries have no table
// (Coolify keeps a login only on the server); what the database knows is which
// resources of a server pull or push a named image. The store functions of
// @saas/db/deploy inside withOrg(): Coolify's usersOf() order over the real
// resource tables, the applications a build server builds, and row-level
// security keeping each org's resources to itself.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  insertPrivateKey,
  insertServer,
  insertDestination,
  findDestinationByUuid,
  listRegistryServers,
  listServerImageUsers,
  listBuildServerApplications,
  DESTINATION_MORPH_CLASS,
} from "@saas/db/deploy";
import type { SqlExecutor, TransactionalSqlExecutor } from "@saas/db/hyperdrive";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SQL = ["500_deploy_core", "510_deploy_org_keys", "520_deploy_schema_fold_fixes"].map((m) => readFileSync(resolve(root, `packages/db/src/migrations/${m}/up.sql`), "utf8")).join("\n");
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const STANDALONE = DESTINATION_MORPH_CLASS.standalone;
const SWARM = DESTINATION_MORPH_CLASS.swarm;

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
/** Server and destination ids by uuid. */
const ids: Record<string, string | number> = {};
let env: number;

async function application(tx: SqlExecutor, org: string, o: { uuid: string; name: string; image: string | null; destination: string; type?: string; buildPack?: string; deleted?: boolean; environment?: number }): Promise<number> {
  const r = await tx.execute<{ id: number }>(
    `INSERT INTO deploy.applications (uuid, name, git_repository, git_branch, build_pack, docker_registry_image_name, environment_id, destination_id, destination_type, deleted_at, org_id)
     VALUES ($1, $2, 'acme/web', 'main', $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [o.uuid, o.name, o.buildPack ?? "nixpacks", o.image, o.environment ?? env, ids[o.destination]!, o.type ?? STANDALONE, o.deleted ? "2026-01-01 00:00:00" : null, org],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SQL);
  ex = executor(db);
  for (const [org, uuid, name, role] of [
    [A, "srvaaaaaaaaaaaaaaaaaaaaa", "zeta", "both"],
    [A, "srvbbbbbbbbbbbbbbbbbbbbb", "alpha", "build"],
    [A, "srvddddddddddddddddddddd", "delta", "deployment"],
    [B, "srvccccccccccccccccccccc", "beta", "both"],
  ] as const) {
    const key = await withOrg(ex, org, (tx) => insertPrivateKey(tx, { orgId: org, uuid: `key${uuid.slice(3)}`, name: "key", description: null, privateKey: "fp1:fake", fingerprint: null }));
    const row = await withOrg(ex, org, (tx) =>
      insertServer(tx, { orgId: org, uuid, name, description: null, ip: "203.0.113.10", user: "root", port: 22, privateKeyId: key.id, proxy: {}, serverRole: role, imageScanEnabled: false, defaultDestinationUuid: `dst${uuid.slice(3)}` }),
    );
    ids[uuid] = row.id;
    ids[`dst${uuid.slice(3)}`] = (await withOrg(ex, org, (tx) => findDestinationByUuid(tx, `dst${uuid.slice(3)}`)))!.id;
  }
  env = await withOrg(ex, A, async (tx) => {
    const p = await tx.execute<{ id: number }>(`INSERT INTO deploy.projects (uuid, name, org_id) VALUES ('prjaaaaaaaaaaaaaaaaaaaaa', 'Shop', $1) RETURNING id`, [A]);
    const e = await tx.execute<{ id: number }>(`INSERT INTO deploy.environments (uuid, name, project_id, org_id) VALUES ('envaaaaaaaaaaaaaaaaaaaaa', 'production', $1, $2) RETURNING id`, [p.rows[0]!.id, A]);
    return e.rows[0]!.id;
  });
}, 120_000);
afterAll(async () => db?.close());

describe("docker registries: what the database knows", () => {
  it("lists the org's servers by name, with what isFunctional() and isBuildServer() read", async () => {
    const rows = await withOrg(ex, A, listRegistryServers);
    expect(rows.map((s) => [s.name, s.server_role])).toEqual([
      ["alpha", "build"],
      ["delta", "deployment"],
      ["zeta", "both"],
    ]);
    expect(rows[2]).toMatchObject({ uuid: "srvaaaaaaaaaaaaaaaaaaaaa", ip: "203.0.113.10", is_reachable: false, is_usable: false, force_disabled: false, is_build_server: false });
    expect((await withOrg(ex, B, listRegistryServers)).map((s) => s.name)).toEqual(["beta"]);
  });

  it("a server without resources has no image users", async () => {
    expect(await withOrg(ex, A, (tx) => listServerImageUsers(tx, ids.srvaaaaaaaaaaaaaaaaaaaaa!))).toEqual([]);
    expect(await withOrg(ex, A, (tx) => listBuildServerApplications(tx, ids.srvbbbbbbbbbbbbbbbbbbbbb!))).toEqual([]);
  });

  it("usersOf(): applications, additional applications, databases kind by kind, then each service's containers", async () => {
    const zeta = ids.srvaaaaaaaaaaaaaaaaaaaaa!;
    await withOrg(ex, A, async (tx) => {
      const swarm = await insertDestination(tx, { orgId: A, type: "swarm", uuid: "dstsssssssssssssssssssss", name: "overlay", network: "coolify-overlay", serverId: zeta });
      ids.dstsssssssssssssssssssss = swarm.id;
      // Applications on zeta: with and without a registry image, on a Swarm destination, and a soft-deleted one.
      await application(tx, A, { uuid: "appaaaaaaaaaaaaaaaaaaaaa", name: "web", image: "ghcr.io/acme/web", destination: "dstaaaaaaaaaaaaaaaaaaaaa" });
      await application(tx, A, { uuid: "appbbbbbbbbbbbbbbbbbbbbb", name: "plain", image: null, destination: "dstaaaaaaaaaaaaaaaaaaaaa" });
      await application(tx, A, { uuid: "appccccccccccccccccccccc", name: "swarmed", image: "acme/swarmed", destination: "dstsssssssssssssssssssss", type: SWARM });
      await application(tx, A, { uuid: "appddddddddddddddddddddd", name: "gone", image: "ghcr.io/acme/gone", destination: "dstaaaaaaaaaaaaaaaaaaaaa", deleted: true });
      // An application of another server (delta).
      await application(tx, A, { uuid: "appeeeeeeeeeeeeeeeeeeeee", name: "elsewhere", image: "ghcr.io/acme/elsewhere", destination: "dstddddddddddddddddddddd" });
      // An application of delta that uses zeta as an additional server.
      const extra = await application(tx, A, { uuid: "appfffffffffffffffffffff", name: "extra", image: "registry.example.com:5000/extra", destination: "dstddddddddddddddddddddd" });
      await tx.execute(`INSERT INTO deploy.additional_destinations (application_id, server_id, standalone_docker_id, org_id) VALUES ($1, $2, $3, $4)`, [extra, zeta, ids.dstaaaaaaaaaaaaaaaaaaaaa!, A]);
      // Databases: Redis is listed after PostgreSQL whatever the insert order; one without an environment; a soft-deleted one.
      await tx.execute(`INSERT INTO deploy.standalone_redis (uuid, name, image, destination_id, destination_type, org_id) VALUES ('rdsaaaaaaaaaaaaaaaaaaaaa', 'cache', 'redis:7', $1, $2, $3)`, [ids.dstaaaaaaaaaaaaaaaaaaaaa!, STANDALONE, A]);
      await tx.execute(
        `INSERT INTO deploy.standalone_postgresqls (uuid, name, postgres_password, image, environment_id, destination_id, destination_type, org_id) VALUES ('pgsaaaaaaaaaaaaaaaaaaaaa', 'db', 'x', 'postgres:16-alpine', $1, $2, $3, $4)`,
        [env, ids.dstaaaaaaaaaaaaaaaaaaaaa!, STANDALONE, A],
      );
      await tx.execute(
        `INSERT INTO deploy.standalone_postgresqls (uuid, name, postgres_password, destination_id, destination_type, deleted_at, org_id) VALUES ('pgsbbbbbbbbbbbbbbbbbbbbb', 'old', 'x', $1, $2, '2026-01-01 00:00:00', $3)`,
        [ids.dstaaaaaaaaaaaaaaaaaaaaa!, STANDALONE, A],
      );
      // A service on zeta: its applications before its databases; a soft-deleted container and a service elsewhere are left out.
      const service = async (uuid: string, name: string, serverId: string | number, deleted = false) =>
        (
          await tx.execute<{ id: number }>(
            `INSERT INTO deploy.services (uuid, name, environment_id, docker_compose_raw, server_id, deleted_at, org_id) VALUES ($1, $2, $3, 'services: {}', $4, $5, $6) RETURNING id`,
            [uuid, name, env, serverId, deleted ? "2026-01-01 00:00:00" : null, A],
          )
        ).rows[0]!.id;
      const plausible = await service("svcaaaaaaaaaaaaaaaaaaaaa", "plausible", zeta);
      await tx.execute(`INSERT INTO deploy.service_databases (uuid, name, service_id, image, org_id) VALUES ('sdbaaaaaaaaaaaaaaaaaaaaa', 'events', $1, 'clickhouse/clickhouse-server:24', $2)`, [plausible, A]);
      await tx.execute(`INSERT INTO deploy.service_applications (uuid, name, service_id, image, org_id) VALUES ('sapaaaaaaaaaaaaaaaaaaaaa', 'plausible', $1, 'ghcr.io/plausible/community-edition:v2', $2)`, [plausible, A]);
      await tx.execute(`INSERT INTO deploy.service_applications (uuid, name, service_id, image, deleted_at, org_id) VALUES ('sapbbbbbbbbbbbbbbbbbbbbb', 'removed', $1, 'quay.io/removed', '2026-01-01 00:00:00', $2)`, [plausible, A]);
      const other = await service("svcbbbbbbbbbbbbbbbbbbbbb", "elsewhere", ids.srvddddddddddddddddddddd!);
      await tx.execute(`INSERT INTO deploy.service_applications (uuid, name, service_id, image, org_id) VALUES ('sapccccccccccccccccccccc', 'n8n', $1, 'n8nio/n8n', $2)`, [other, A]);
      const gone = await service("svcccccccccccccccccccccc", "deleted", zeta, true);
      await tx.execute(`INSERT INTO deploy.service_applications (uuid, name, service_id, image, org_id) VALUES ('sapddddddddddddddddddddd', 'ghost', $1, 'ghost:5', $2)`, [gone, A]);
    });

    const rows = await withOrg(ex, A, (tx) => listServerImageUsers(tx, zeta));
    const shop = { environment_uuid: "envaaaaaaaaaaaaaaaaaaaaa", project_uuid: "prjaaaaaaaaaaaaaaaaaaaaa" };
    expect(rows).toEqual([
      { type: "Application", kind: "application", image: "ghcr.io/acme/web", uuid: "appaaaaaaaaaaaaaaaaaaaaa", name: "web", ...shop },
      { type: "Application", kind: "application", image: null, uuid: "appbbbbbbbbbbbbbbbbbbbbb", name: "plain", ...shop },
      { type: "Application", kind: "application", image: "acme/swarmed", uuid: "appccccccccccccccccccccc", name: "swarmed", ...shop },
      { type: "Application", kind: "application", image: "registry.example.com:5000/extra", uuid: "appfffffffffffffffffffff", name: "extra", ...shop },
      { type: "Database", kind: "database", image: "postgres:16-alpine", uuid: "pgsaaaaaaaaaaaaaaaaaaaaa", name: "db", ...shop },
      { type: "Database", kind: "database", image: "redis:7", uuid: "rdsaaaaaaaaaaaaaaaaaaaaa", name: "cache", environment_uuid: null, project_uuid: null },
      { type: "Service", kind: "service", image: "ghcr.io/plausible/community-edition:v2", uuid: "svcaaaaaaaaaaaaaaaaaaaaa", name: "plausible", ...shop },
      { type: "Service", kind: "service", image: "clickhouse/clickhouse-server:24", uuid: "svcaaaaaaaaaaaaaaaaaaaaa", name: "plausible", ...shop },
    ]);
    // delta: its own two applications, and the service deployed to it.
    expect((await withOrg(ex, A, (tx) => listServerImageUsers(tx, ids.srvddddddddddddddddddddd!))).map((r) => [r.type, r.name])).toEqual([
      ["Application", "elsewhere"],
      ["Application", "extra"],
      ["Service", "elsewhere"],
    ]);
  });

  it("applicationsBuiltOnBuildServers(): by name, deployed elsewhere, built on a build server", async () => {
    await withOrg(ex, A, async (tx) => {
      // zeta builds its own applications; "pushed" asks for a build server, "compose" cannot use one.
      const pushed = await application(tx, A, { uuid: "appggggggggggggggggggggg", name: "pushed", image: "ghcr.io/acme/pushed", destination: "dstaaaaaaaaaaaaaaaaaaaaa" });
      await tx.execute(`INSERT INTO deploy.application_settings (application_id, is_build_server_enabled, org_id) VALUES ($1, true, $2)`, [pushed, A]);
      const compose = await application(tx, A, { uuid: "apphhhhhhhhhhhhhhhhhhhhh", name: "compose", image: "ghcr.io/acme/compose", destination: "dstaaaaaaaaaaaaaaaaaaaaa", buildPack: "dockercompose" });
      await tx.execute(`INSERT INTO deploy.application_settings (application_id, is_build_server_enabled, org_id) VALUES ($1, true, $2)`, [compose, A]);
      // An application deployed to the build server itself, and a Docker image application on delta.
      await application(tx, A, { uuid: "appiiiiiiiiiiiiiiiiiiiii", name: "onbuild", image: "ghcr.io/acme/onbuild", destination: "dstbbbbbbbbbbbbbbbbbbbbb" });
      await application(tx, A, { uuid: "appjjjjjjjjjjjjjjjjjjjjj", name: "image", image: "ghcr.io/acme/image", destination: "dstddddddddddddddddddddd", buildPack: "dockerimage" });
      await application(tx, A, { uuid: "appkkkkkkkkkkkkkkkkkkkkk", name: "blank", image: "", destination: "dstddddddddddddddddddddd" });
    });
    const rows = await withOrg(ex, A, (tx) => listBuildServerApplications(tx, ids.srvbbbbbbbbbbbbbbbbbbbbb!));
    // delta cannot build (deployments only): its applications with a registry image are built elsewhere. zeta's
    // are not, unless the application's build server setting is on.
    expect(rows.map((r) => [r.type, r.name, r.image])).toEqual([
      ["Build", "elsewhere", "ghcr.io/acme/elsewhere"],
      ["Build", "extra", "registry.example.com:5000/extra"],
      ["Build", "pushed", "ghcr.io/acme/pushed"],
    ]);
    expect(rows[0]).toMatchObject({ kind: "application", uuid: "appeeeeeeeeeeeeeeeeeeeee", environment_uuid: "envaaaaaaaaaaaaaaaaaaaaa", project_uuid: "prjaaaaaaaaaaaaaaaaaaaaa" });
    // Seen from zeta as the build server, its own applications are not builds for another server.
    expect((await withOrg(ex, A, (tx) => listBuildServerApplications(tx, ids.srvaaaaaaaaaaaaaaaaaaaaa!))).map((r) => r.name)).toEqual(["elsewhere", "extra"]);
  });

  it("keeps each org's resources to itself (row-level security)", async () => {
    expect(await withOrg(ex, B, (tx) => listServerImageUsers(tx, ids.srvaaaaaaaaaaaaaaaaaaaaa!))).toEqual([]);
    expect(await withOrg(ex, B, (tx) => listBuildServerApplications(tx, ids.srvbbbbbbbbbbbbbbbbbbbbb!))).toEqual([]);
    expect(await withOrg(ex, B, (tx) => listServerImageUsers(tx, ids.srvccccccccccccccccccccc!))).toEqual([]);
  });
});
