// deploy.server_settings for the server settings pages (DP-42) against a real
// Postgres: the store functions of @saas/db/deploy inside withOrg(), the
// column whitelist, Team::usesSwarm(), and row-level security keeping each
// org's settings to itself.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { withOrg, insertPrivateKey, insertServer, findServerByUuid, findServerSettings, updateServerSettings, orgUsesSwarm, type ServerSettingsPageChanges } from "@saas/db/deploy";
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
beforeAll(async () => {
  db = new PGlite();
  await db.exec(SQL);
  ex = executor(db);
  for (const [org, uuid, ip] of [
    [A, "srvaaaaaaaaaaaaaaaaaaaaa", "203.0.113.10"],
    [A, "srvbbbbbbbbbbbbbbbbbbbbb", "203.0.113.11"],
    [B, "srvccccccccccccccccccccc", "203.0.113.12"],
  ] as const) {
    const key = await withOrg(ex, org, (tx) => insertPrivateKey(tx, { orgId: org, uuid: `key${uuid.slice(3)}`, name: "key", description: null, privateKey: "fp1:fake", fingerprint: null }));
    const row = await withOrg(ex, org, (tx) =>
      insertServer(tx, { orgId: org, uuid, name: uuid.slice(0, 6), description: null, ip, user: "root", port: 22, privateKeyId: key.id, proxy: {}, serverRole: "both", imageScanEnabled: false }),
    );
    ids[uuid] = row.id;
  }
}, 120_000);
afterAll(async () => db?.close());

describe("deploy.server_settings (settings pages)", () => {
  it("reads the page columns with the schema's defaults and the server's Sentinel timestamps", async () => {
    const s = (await withOrg(ex, A, (tx) => findServerSettings(tx, ids.srvaaaaaaaaaaaaaaaaaaaaa!)))!;
    expect(s).toMatchObject({
      concurrent_builds: 2,
      dynamic_timeout: 3600,
      deployment_queue_limit: 25,
      backup_compression_cpu_percentage: 25,
      server_disk_usage_check_frequency: "0 23 * * *",
      force_docker_cleanup: true,
      docker_cleanup_frequency: "0 0 * * *",
      docker_cleanup_threshold: 80,
      logdrain_axiom_domain: "us-east-1.aws.edge.axiom.co",
      is_logdrain_newrelic_enabled: false,
      is_swarm_manager: false,
      sentinel_token: null,
      sentinel_push_interval_seconds: 60,
      sentinel_waiting_since: null,
    });
    expect(s.sentinel_updated_at).not.toBeNull();
    expect(s).not.toHaveProperty("is_reachable");
  });

  it("writes only the page columns, leaves undefined ones, and stamps updated_at", async () => {
    const id = ids.srvaaaaaaaaaaaaaaaaaaaaa!;
    const changes = { concurrent_builds: 4, docker_cleanup_frequency: "*/10 * * * *", delete_unused_volumes: true, logdrain_axiom_api_key: "fp1:1:fake:fake", dynamic_timeout: undefined, is_reachable: true } as ServerSettingsPageChanges;
    expect(await withOrg(ex, A, (tx) => updateServerSettings(tx, id, changes))).toBe(true);
    const s = (await withOrg(ex, A, (tx) => findServerSettings(tx, id)))!;
    expect(s).toMatchObject({ concurrent_builds: 4, docker_cleanup_frequency: "*/10 * * * *", delete_unused_volumes: true, logdrain_axiom_api_key: "fp1:1:fake:fake", dynamic_timeout: 3600 });
    const raw = await withOrg(ex, A, (tx) => tx.execute<{ is_reachable: boolean; updated_at: unknown }>(`SELECT is_reachable, updated_at FROM deploy.server_settings WHERE server_id = $1`, [id]));
    expect(raw.rows[0]!.is_reachable).toBe(false);
    expect(raw.rows[0]!.updated_at).not.toBeNull();
    // Nothing to write still says whether the row exists.
    expect(await withOrg(ex, A, (tx) => updateServerSettings(tx, id, {}))).toBe(true);
    expect(await withOrg(ex, A, (tx) => updateServerSettings(tx, 999_999, {}))).toBe(false);
  });

  it("keeps each org's settings to itself (row-level security)", async () => {
    const a = ids.srvaaaaaaaaaaaaaaaaaaaaa!;
    expect(await withOrg(ex, B, (tx) => findServerSettings(tx, a))).toBeNull();
    expect(await withOrg(ex, B, (tx) => updateServerSettings(tx, a, { concurrent_builds: 9 }))).toBe(false);
    expect((await withOrg(ex, A, (tx) => findServerSettings(tx, a)))!.concurrent_builds).toBe(4);
  });

  it("Team::usesSwarm(): a Swarm server or a Swarm destination of the org", async () => {
    expect(await withOrg(ex, A, orgUsesSwarm)).toBe(false);
    expect((await withOrg(ex, A, (tx) => findServerByUuid(tx, "srvaaaaaaaaaaaaaaaaaaaaa")))!.org_uses_swarm).toBe(false);
    await withOrg(ex, A, (tx) => updateServerSettings(tx, ids.srvbbbbbbbbbbbbbbbbbbbbb!, { is_swarm_worker: true }));
    expect(await withOrg(ex, A, orgUsesSwarm)).toBe(true);
    // The other server of the org sees it too (the sidebar's Swarm item); org B does not.
    expect((await withOrg(ex, A, (tx) => findServerByUuid(tx, "srvaaaaaaaaaaaaaaaaaaaaa")))!).toMatchObject({ org_uses_swarm: true, is_cloudflare_tunnel: false });
    expect(await withOrg(ex, B, orgUsesSwarm)).toBe(false);
    await withOrg(ex, B, (tx) =>
      tx.execute(`INSERT INTO deploy.swarm_dockers (name, uuid, server_id, network, org_id) VALUES ('swarm', 'swarmcccccccccccccccccccc', $1, 'freeploy-overlay', $2)`, [ids.srvccccccccccccccccccccc!, B]),
    );
    expect(await withOrg(ex, B, orgUsesSwarm)).toBe(true);
  });
});
