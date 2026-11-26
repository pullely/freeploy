// The SQL of DP-114's Security pages on the schema at head: an ignore added, listed (the team-wide ones and a resource's,
// the resource's first, newest first) and removed; a scan's stored package list; an application's image overrides and
// scan settings; an application's policy row saved (firstOrNew by scope); the environments the team page names; the
// servers that do not scan images; and row-level security keeping each org's rows to itself.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  insertPrivateKey,
  insertServer,
  insertProject,
  listServerDestinations,
  insertDockerImageApplication,
  insertImageScanIgnore,
  listImageScanIgnoresFor,
  deleteImageScanIgnore,
  listImageSboms,
  listImageScanSbomIds,
  updateApplicationImageOverrides,
  findApplicationScanSettings,
  updateApplicationScanSetting,
  saveImageScanPolicy,
  listImageScanEnvironments,
  countServersNotScanning,
  APPLICATION_WEBHOOK_SECRET_COLUMNS,
  type NewDockerImageApplication,
} from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, executor } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const APP_MORPH = "App\\Models\\Application";

let db: PGlite;
let ex: TransactionalSqlExecutor;
const ids: Record<string, number> = {};
const admin = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => asPlatformAdmin(ex, async (tx) => (await tx.execute<T>(sql, params)).rows);

async function serverAndApp(org: string, tag: string, ip: string) {
  return withOrg(ex, org, async (tx) => {
    const key = await insertPrivateKey(tx, { orgId: org, uuid: `key${tag}`, name: "key", description: null, privateKey: "fp1:fake", fingerprint: null });
    const row = await insertServer(tx, {
      orgId: org, uuid: `srv${tag}`, name: `server-${tag}`, description: null, ip, user: "root", port: 22, privateKeyId: key.id,
      proxy: { type: "TRAEFIK", status: "exited" }, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: `dst${tag}`,
    });
    const destination = (await listServerDestinations(tx, row.id))[0]!;
    const { environment } = await insertProject(tx, { orgId: org, uuid: `prj${tag}`, name: `Project-${tag}`, description: null, productionEnvironmentUuid: `env${tag}` });
    const uuid = `app${tag}`.padEnd(24, tag);
    const app: NewDockerImageApplication = {
      orgId: org, uuid, name: `app-${tag}`, fqdn: null, domainPortOverrides: null, dockerRegistryImageName: "nginx", dockerRegistryImageTag: "latest",
      environmentId: environment.id, destinationId: destination.id, destinationType: "standalone",
      webhookSecrets: Object.fromEntries(APPLICATION_WEBHOOK_SECRET_COLUMNS.map((c) => [c, `fp1:${uuid}:${c}`])) as NewDockerImageApplication["webhookSecrets"],
    };
    return { server: Number(row.id), app: Number((await insertDockerImageApplication(tx, app)).id) };
  });
}

beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
  const a = await serverAndApp(A, "a", "203.0.113.10");
  const b = await serverAndApp(B, "b", "203.0.113.20");
  ids.serverA = a.server;
  ids.appA = a.app;
  ids.serverB = b.server;
  ids.appB = b.app;
  for (const [org, server, app, tag] of [[A, a.server, a.app, "a"], [B, b.server, b.app, "b"]] as const) {
    const sbom = await admin<{ id: number }>(`INSERT INTO deploy.image_sboms (server_id, image_id, platform, packages, last_used_at, org_id) VALUES ($1, 'sha256:x', 'linux/amd64', '[{"name":"zlib"}]', '2026-01-01 00:00:00', $2) RETURNING id::float8 AS id`, [server, org]);
    const scan = await admin<{ id: number }>(
      `INSERT INTO deploy.image_scans (uuid, server_id, image_sbom_id, image_id, resource_type, resource_id, image_ref, status, org_id) VALUES ($1, $2, $3, 'sha256:x', $4, $5, 'nginx:latest', 'completed', $6) RETURNING id::float8 AS id`,
      [`scan${tag}`, server, sbom[0]!.id, APP_MORPH, app, org],
    );
    ids[`sbom${tag}`] = Number(sbom[0]!.id);
    ids[`scan${tag}`] = Number(scan[0]!.id);
  }
}, 120_000);

afterAll(async () => db?.close());

describe("ignores", () => {
  it("adds, lists (the resource's first, newest first) and removes an org's ignores", async () => {
    await withOrg(ex, A, async (tx) => {
      await insertImageScanIgnore(tx, A, { uuid: "ign-team", resourceType: null, resourceId: null, vulnerabilityId: null, package: "zlib", reason: "team", expiresAt: null });
      await insertImageScanIgnore(tx, A, { uuid: "ign-app", resourceType: APP_MORPH, resourceId: ids.appA!, vulnerabilityId: "CVE-1", package: null, reason: "app", expiresAt: "2026-02-01 00:00:00" });
      await insertImageScanIgnore(tx, A, { uuid: "ign-other", resourceType: APP_MORPH, resourceId: 999, vulnerabilityId: "CVE-2", package: null, reason: "other", expiresAt: null });
    });
    const listed = await withOrg(ex, A, (tx) => listImageScanIgnoresFor(tx, { [APP_MORPH]: [ids.appA!] }));
    expect(listed.map((i) => [i.uuid, i.resource_id, i.expires_at])).toEqual([["ign-app", ids.appA, "2026-02-01 00:00:00"], ["ign-team", null, null]]);
    expect((await withOrg(ex, A, (tx) => listImageScanIgnoresFor(tx, {}))).map((i) => i.uuid)).toEqual(["ign-team"]);
    // Another org sees none of them.
    expect(await withOrg(ex, B, (tx) => listImageScanIgnoresFor(tx, { [APP_MORPH]: [ids.appA!] }))).toEqual([]);
    await withOrg(ex, B, (tx) => deleteImageScanIgnore(tx, listed[0]!.id));
    expect(await admin("SELECT 1 FROM deploy.image_scan_ignores WHERE uuid = 'ign-app'")).toHaveLength(1);
    await withOrg(ex, A, (tx) => deleteImageScanIgnore(tx, listed[0]!.id));
    expect(await admin("SELECT 1 FROM deploy.image_scan_ignores WHERE uuid = 'ign-app'")).toHaveLength(0);
    // An ignore is stored in its own org only.
    await expect(withOrg(ex, B, (tx) => insertImageScanIgnore(tx, A, { uuid: "ign-cross", resourceType: null, resourceId: null, vulnerabilityId: "CVE-3", package: null, reason: "x", expiresAt: null }))).rejects.toThrow();
  });
});

describe("stored package lists", () => {
  it("reads a scan's image_sbom_id and its package list, each org its own", async () => {
    expect([...(await withOrg(ex, A, (tx) => listImageScanSbomIds(tx, [ids.scana!, ids.scanb!])))]).toEqual([[ids.scana, ids.sboma]]);
    const [sbom] = await withOrg(ex, A, (tx) => listImageSboms(tx, [ids.sboma!, ids.sbomb!]));
    expect([sbom!.id, sbom!.server_id, JSON.parse(sbom!.packages), sbom!.packages_truncated]).toEqual([ids.sboma, ids.serverA, [{ name: "zlib" }], false]);
    expect(await withOrg(ex, B, (tx) => listImageSboms(tx, [ids.sboma!]))).toEqual([]);
  });
});

describe("an application's overrides, scan settings and policy row", () => {
  it("writes them in the org only", async () => {
    await withOrg(ex, A, (tx) => updateApplicationImageOverrides(tx, ids.appA!, JSON.stringify({ web: { from: "a", to: "b" } })));
    expect((await admin<{ o: string }>("SELECT docker_compose_image_overrides::text AS o FROM deploy.applications WHERE id = $1", [ids.appA]))[0]!.o).toBe('{"web":{"from":"a","to":"b"}}');
    await withOrg(ex, A, (tx) => updateApplicationImageOverrides(tx, ids.appA!, null));
    expect((await admin<{ o: string | null }>("SELECT docker_compose_image_overrides::text AS o FROM deploy.applications WHERE id = $1", [ids.appA]))[0]!.o).toBeNull();

    expect(await withOrg(ex, A, (tx) => findApplicationScanSettings(tx, ids.appA!))).toEqual({ is_image_scan_enabled: true, image_builds_by_team: null });
    await withOrg(ex, A, (tx) => updateApplicationScanSetting(tx, ids.appA!, "image_builds_by_team", false));
    await withOrg(ex, A, (tx) => updateApplicationScanSetting(tx, ids.appA!, "is_image_scan_enabled", false));
    expect(await withOrg(ex, A, (tx) => findApplicationScanSettings(tx, ids.appA!))).toEqual({ is_image_scan_enabled: false, image_builds_by_team: false });
    // Another org's write reaches nothing.
    await withOrg(ex, B, (tx) => updateApplicationScanSetting(tx, ids.appA!, "is_image_scan_enabled", true));
    expect(await withOrg(ex, B, (tx) => findApplicationScanSettings(tx, ids.appA!))).toBeNull();
    expect((await withOrg(ex, A, (tx) => findApplicationScanSettings(tx, ids.appA!)))!.is_image_scan_enabled).toBe(false);

    await withOrg(ex, A, (tx) => saveImageScanPolicy(tx, A, "pol-a", APP_MORPH, ids.appA!, "gate_mode", "strict"));
    await withOrg(ex, A, (tx) => saveImageScanPolicy(tx, A, "pol-unused", APP_MORPH, ids.appA!, "count_medium", true));
    expect(await admin("SELECT uuid, gate_mode, on_scan_error, count_medium, org_id::text AS org FROM deploy.image_scan_policies WHERE scope_id = $1", [ids.appA])).toEqual([{ uuid: "pol-a", gate_mode: "strict", on_scan_error: null, count_medium: true, org: A }]);
    // Org B's row of the same scope is its own.
    await withOrg(ex, B, (tx) => saveImageScanPolicy(tx, B, "pol-b", APP_MORPH, ids.appA!, "gate_mode", "on"));
    expect(await admin("SELECT uuid, gate_mode FROM deploy.image_scan_policies WHERE scope_id = $1 ORDER BY id", [ids.appA])).toEqual([{ uuid: "pol-a", gate_mode: "strict" }, { uuid: "pol-b", gate_mode: "on" }]);
  });
});

describe("the team page's rows", () => {
  it("names the org's environments and counts its servers that do not scan images", async () => {
    expect(await withOrg(ex, A, (tx) => listImageScanEnvironments(tx))).toEqual([{ uuid: "enva", name: "production", project_uuid: "prja", project_name: "Project-a" }]);
    expect(await withOrg(ex, A, (tx) => countServersNotScanning(tx))).toBe(1);
    await admin("UPDATE deploy.server_settings SET is_image_scan_enabled = true WHERE server_id = $1", [ids.serverA]);
    expect(await withOrg(ex, A, (tx) => countServersNotScanning(tx))).toBe(0);
    await admin(`UPDATE deploy.servers SET server_metadata = '{"transfer":{"status":"transferred"}}' WHERE id = $1`, [ids.serverB]);
    expect(await withOrg(ex, B, (tx) => countServersNotScanning(tx))).toBe(0);
  });
});
