// DP-116: migration 740 and the SQL of the image scanning settings on the schema at head — the instance-wide policy (the
// nil UUID's row with no scope: created with Coolify's seeded values by the operator, read by every org through 740's
// FOR SELECT policy, written by none), a team's row (scope App\Models\Team, scope_id 0 when new) and its team-wide
// ignores, the orgs that hold scans, a server's host scan; and row-level security keeping every other row to its org.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  insertPrivateKey,
  insertServer,
  insertImageScanIgnore,
  findInstanceImageScanPolicy,
  readInstanceImageScanPolicy,
  saveInstanceImageScanPolicy,
  findTeamImageScanPolicy,
  saveTeamImageScanPolicy,
  findScopedImageScanPolicy,
  saveImageScanPolicy,
  listImageScanPolicies,
  listTeamImageScanIgnores,
  listOrgsWithImageScans,
  findServerHostScan,
  INSTANCE_IMAGE_SCAN_POLICY_ORG_ID,
  PLATFORM_SETTINGS_ORG_ID,
} from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, deployDatabaseAfter, deployMigrationsBefore, executor, migrationSql, sqlState } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const SERVER_MORPH = "App\\Models\\Server";

let db: PGlite;
let ex: TransactionalSqlExecutor;
const ids: Record<string, number> = {};
const admin = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => asPlatformAdmin(ex, async (tx) => (await tx.execute<T>(sql, params)).rows);

async function server(org: string, tag: string, ip: string): Promise<number> {
  return withOrg(ex, org, async (tx) => {
    const key = await insertPrivateKey(tx, { orgId: org, uuid: `key${tag}`, name: "key", description: null, privateKey: "fp1:fake", fingerprint: null });
    const row = await insertServer(tx, {
      orgId: org, uuid: `srv${tag}`, name: `server-${tag}`, description: null, ip, user: "root", port: 22, privateKeyId: key.id,
      proxy: { type: "TRAEFIK", status: "exited" }, serverRole: "both", imageScanEnabled: true, defaultDestinationUuid: `dst${tag}`,
    });
    return Number(row.id);
  });
}

beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
  ids.serverA = await server(A, "a", "203.0.113.10");
  ids.serverB = await server(B, "b", "203.0.113.20");
}, 120_000);

afterAll(async () => db?.close());

describe("migration 740", () => {
  it("adds only a FOR SELECT policy beside the tenant policy; FORCE row-level security stays", async () => {
    const rls = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'deploy.image_scan_policies'::regclass");
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await db.query<{ polname: string; polcmd: string; polpermissive: boolean }>("SELECT polname, polcmd, polpermissive FROM pg_policy WHERE polrelid = 'deploy.image_scan_policies'::regclass ORDER BY polname");
    expect(policies.rows).toEqual([
      { polname: "instance_policy_read", polcmd: "r", polpermissive: true },
      { polname: "tenant_isolation", polcmd: "*", polpermissive: true },
    ]);
    expect(INSTANCE_IMAGE_SCAN_POLICY_ORG_ID).toBe(PLATFORM_SETTINGS_ORG_ID);
  });

  it("can run again, and changes no column or index (the schema report finds no new difference)", async () => {
    const before = await deployDatabaseAfter(deployMigrationsBefore("740_deploy_image_scan_instance_policy"));
    try {
      const catalog = async (d: PGlite) =>
        JSON.stringify([
          (await d.query("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'deploy' AND table_name = 'image_scan_policies' ORDER BY ordinal_position")).rows,
          (await d.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'deploy' AND tablename = 'image_scan_policies' ORDER BY indexname")).rows,
        ]);
      const old = await catalog(before);
      await before.exec(migrationSql("740_deploy_image_scan_instance_policy"));
      await before.exec(migrationSql("740_deploy_image_scan_instance_policy"));
      expect(await catalog(before)).toBe(old);
      expect((await before.query("SELECT count(*)::int AS n FROM pg_policy WHERE polname = 'instance_policy_read'")).rows).toEqual([{ n: 1 }]);
    } finally {
      await before.close();
    }
  });
});

describe("the instance-wide policy", () => {
  it("is none until the operator reads it; then the nil UUID's row with Coolify's seeded values", async () => {
    expect(await withOrg(ex, A, (tx) => findInstanceImageScanPolicy(tx))).toBeNull();
    const row = await asPlatformAdmin(ex, (tx) => readInstanceImageScanPolicy(tx, "instance-policy"));
    expect(row).toMatchObject({ scope_type: null, scope_id: null, gate_mode: "off", on_scan_error: "deploy", count_medium: false });
    await asPlatformAdmin(ex, (tx) => readInstanceImageScanPolicy(tx, "instance-policy-2"));
    expect(await admin("SELECT uuid, org_id::text AS org FROM deploy.image_scan_policies WHERE scope_type IS NULL")).toEqual([{ uuid: "instance-policy", org: PLATFORM_SETTINGS_ORG_ID }]);
  });

  it("is read by every org, written by none but the operator", async () => {
    await asPlatformAdmin(ex, (tx) => saveInstanceImageScanPolicy(tx, "unused", "count_medium", true));
    for (const org of [A, B]) {
      expect(await withOrg(ex, org, (tx) => findInstanceImageScanPolicy(tx))).toMatchObject({ gate_mode: "off", count_medium: true });
      // An org's update or delete reaches no row; an insert for the platform is refused.
      await withOrg(ex, org, (tx) => tx.execute("UPDATE deploy.image_scan_policies SET count_medium = false WHERE scope_type IS NULL"));
      await withOrg(ex, org, (tx) => tx.execute("DELETE FROM deploy.image_scan_policies WHERE scope_type IS NULL"));
      expect(await sqlState(() => withOrg(ex, org, (tx) => tx.execute("INSERT INTO deploy.image_scan_policies (uuid, org_id) VALUES ($1, $2)", [`forged-${org}`, PLATFORM_SETTINGS_ORG_ID])))).toBe("42501");
    }
    expect(await admin("SELECT count_medium FROM deploy.image_scan_policies WHERE scope_type IS NULL")).toEqual([{ count_medium: true }]);
    // The resolver's list of the org's scoped rows does not hold it.
    expect(await withOrg(ex, A, (tx) => listImageScanPolicies(tx))).toEqual([]);
  });

  it("shows no other org's row: an org's own row with no scope is not the instance's", async () => {
    await withOrg(ex, A, (tx) => tx.execute("INSERT INTO deploy.image_scan_policies (uuid, org_id, gate_mode) VALUES ('org-a-unscoped', $1, 'strict')", [A]));
    expect(await withOrg(ex, B, (tx) => tx.execute("SELECT uuid FROM deploy.image_scan_policies"))).toMatchObject({ rows: [{ uuid: "instance-policy" }] });
    expect((await withOrg(ex, A, (tx) => findInstanceImageScanPolicy(tx)))!.gate_mode).toBe("off");
    await admin("DELETE FROM deploy.image_scan_policies WHERE uuid = 'org-a-unscoped'");
  });
});

describe("a team's and a server's rows, the team-wide ignores, the orgs with scans, a host scan", () => {
  it("saves the team row (scope_id 0 when new) and a server row in the org only", async () => {
    expect(await withOrg(ex, A, (tx) => findTeamImageScanPolicy(tx))).toBeNull();
    await withOrg(ex, A, (tx) => saveTeamImageScanPolicy(tx, A, "team-a", "gate_mode", "on"));
    await withOrg(ex, A, (tx) => saveTeamImageScanPolicy(tx, A, "unused", "count_medium", true));
    expect(await withOrg(ex, A, (tx) => findTeamImageScanPolicy(tx))).toMatchObject({ scope_type: "App\\Models\\Team", scope_id: 0, gate_mode: "on", count_medium: true });
    expect(await withOrg(ex, B, (tx) => findTeamImageScanPolicy(tx))).toBeNull();
    // A team row the API fixture made with another scope_id is the team's too.
    await withOrg(ex, B, (tx) => tx.execute("INSERT INTO deploy.image_scan_policies (uuid, scope_type, scope_id, on_scan_error, org_id) VALUES ('team-b', 'App\\Models\\Team', 2, 'block', $1)", [B]));
    await withOrg(ex, B, (tx) => saveTeamImageScanPolicy(tx, B, "unused", "gate_mode", null));
    expect(await withOrg(ex, B, (tx) => findTeamImageScanPolicy(tx))).toMatchObject({ scope_id: 2, gate_mode: null, on_scan_error: "block" });
    await withOrg(ex, A, (tx) => saveImageScanPolicy(tx, A, "server-a", SERVER_MORPH, ids.serverA!, "count_medium", false));
    expect(await withOrg(ex, A, (tx) => findScopedImageScanPolicy(tx, SERVER_MORPH, ids.serverA!))).toMatchObject({ count_medium: false });
    expect(await withOrg(ex, B, (tx) => findScopedImageScanPolicy(tx, SERVER_MORPH, ids.serverA!))).toBeNull();
  });

  it("lists the team-wide ignores only, newest first, each org its own", async () => {
    await withOrg(ex, A, async (tx) => {
      await insertImageScanIgnore(tx, A, { uuid: "t-old", resourceType: null, resourceId: null, vulnerabilityId: "CVE-1", package: null, reason: "old", expiresAt: null });
      await tx.execute("UPDATE deploy.image_scan_ignores SET created_at = '2025-01-01 00:00:00' WHERE uuid = 't-old'");
      await insertImageScanIgnore(tx, A, { uuid: "t-new", resourceType: null, resourceId: null, vulnerabilityId: null, package: "zlib", reason: "new", expiresAt: "2026-02-01 00:00:00" });
      await insertImageScanIgnore(tx, A, { uuid: "r-app", resourceType: "App\\Models\\Application", resourceId: 1, vulnerabilityId: "CVE-2", package: null, reason: "app", expiresAt: null });
    });
    expect((await withOrg(ex, A, (tx) => listTeamImageScanIgnores(tx))).map((i) => [i.uuid, i.expires_at])).toEqual([["t-new", "2026-02-01 00:00:00"], ["t-old", null]]);
    expect(await withOrg(ex, B, (tx) => listTeamImageScanIgnores(tx))).toEqual([]);
  });

  it("names the orgs whose servers hold scans (the operator's), and reads a server's host scan in its org", async () => {
    await admin(`INSERT INTO deploy.image_scans (uuid, server_id, image_id, resource_type, resource_id, image_ref, status, org_id) VALUES ('scan-b', $1, 'sha256:x', 'App\\Models\\Application', 1, 'nginx', 'completed', $2)`, [ids.serverB, B]);
    expect(await asPlatformAdmin(ex, (tx) => listOrgsWithImageScans(tx))).toEqual([B]);
    expect(await withOrg(ex, A, (tx) => listOrgsWithImageScans(tx))).toEqual([]);
    await admin(`INSERT INTO deploy.server_host_scans (server_id, summary, findings, findings_truncated, scanned_at, org_id) VALUES ($1, '{"high":1}', '[{"id":"CVE-9"}]', true, '2025-12-31 12:00:00', $2)`, [ids.serverA, A]);
    const scan = await withOrg(ex, A, (tx) => findServerHostScan(tx, ids.serverA!));
    expect([scan!.server_id, scan!.summary, scan!.findings, scan!.findings_truncated, scan!.scanned_at]).toEqual([ids.serverA, { high: 1 }, [{ id: "CVE-9" }], true, "2025-12-31 12:00:00"]);
    expect(await withOrg(ex, B, (tx) => findServerHostScan(tx, ids.serverA!))).toBeNull();
  });
});
