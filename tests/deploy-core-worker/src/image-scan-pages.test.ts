// The console's Security pages of DP-114 through the handler, over DP-113's image scan cases (fixtures/api/cases.json,
// seeded as api-v1-vulnerabilities.test.ts seeds them: image-scan-seed.ts) in Freeploy's database (PGlite with every
// deploy migration, row-level security on): a resource's Security page — the main card and the findings in the fix states,
// filters, views and pages of Vulnerabilities::render(), the same statuses DP-113's API answers —, its actions (ignore's
// rules, messages and toast, the summaries written again; Scan now, Update and Rebuild answered as needing the SSH
// executor after Coolify's checks, with nothing stored; Use the compose file), its scan settings, its SBOM downloads and
// exports, and the team page at /vulnerabilities; who may see and change them (a denial is a 404 that runs nothing) and
// one org never reaching another's.
// The Worker's own module order (the router first), as its import cycle needs.
import "@deploy-core-worker/router";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { withOrg } from "@saas/db/deploy";
import type { Env } from "@deploy-core-worker/env";
import { handleFleetVulnerabilities, handleImageScanPages, isImageScanPageRoute, type ImageScanPagesRunner, type ImageScanResourceKind } from "@deploy-core-worker/handlers/image-scan-pages";
import { validateIgnore } from "@deploy-core-worker/image-scan/vulnerabilities-page";
import { notScannedSentence } from "@deploy-core-worker/image-scan/fleet-page";
import { csvDocument, markdownLink } from "@deploy-core-worker/image-scan/exports";
import { cvssSeverity, knowsRunningCommit, shortCommit } from "@deploy-core-worker/image-scan/security-card";
import type { ApplicationModel } from "@deploy-core-worker/image-scan/model";
import { CASES, golden } from "./api-v1-goldens.js";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";
import { NOW, query, seedScans, seedVariables, type Dp113Case } from "./image-scan-seed.js";

const ORG1 = ORG_UUID[1]!;
const ORG2 = ORG_UUID[2]!;
const APP = "a1parityimageapp00000001";
const GIT_APP = "a2paritygitapp0000000002";
const OTHER_APP = "a3otherteamapp0000000003";
const SERVICE = "f1parityservice000000001";
const POSTGRES = "b1paritypostgres00000001";
const actor = { subjectId: "usr_1", subjectType: "user" };

let fixture: FixtureDatabase;
beforeAll(async () => {
  fixture = await fixtureDatabase();
}, 120_000);
afterAll(async () => fixture?.pg.close());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the pages' answers are read deep, as the console reads them.
type Body = { data?: Record<string, any>; error?: { code: string; message: string; details?: { fields?: Record<string, string[]> } } };

function client(db: TransactionalSqlExecutor, allow: { read?: boolean; write?: boolean } = {}) {
  let ran = 0;
  const env: Env = {
    ENVIRONMENT: "test",
    DEPLOY_ENCRYPTION_KEY: TEST_KEK,
    DEPLOY_CONSOLE_URL: "https://console.example",
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      const ok = body.action === "deploy.resource.write" ? (allow.write ?? true) : (allow.read ?? true);
      return json({ data: { decision: ok ? "allow" : "deny", allow: ok } });
    }),
  };
  const runner: ImageScanPagesRunner = (_env, orgId, fn) => ((ran += 1), withOrg(db, orgId, fn));
  let n = 0;
  const deps = { runner, now: () => NOW, uuid: () => `w9parityignorenew${String((n += 1)).padStart(6, "0")}` };
  const call = async (kind: ImageScanResourceKind, uuid: string, rest: string[] = [], method = "GET", body?: unknown, search = "", org = ORG1) => {
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleImageScanPages(env, "req_1", actor, org, kind, [uuid, "vulnerabilities", ...rest], new Request(`https://x/${uuid}/vulnerabilities${rest.length ? `/${rest.join("/")}` : ""}${search}`, init), deps);
    return { status: res.status, body: (await res.json()) as Body };
  };
  const fleet = async (rest: string[] = [], search = "", method = "GET", org = ORG1) => {
    const res = await handleFleetVulnerabilities(env, "req_1", actor, org, "org_x", rest, new Request(`https://x/vulnerabilities${search}`, { method }), { ...deps, teamName: async () => "Parity Team" });
    return { status: res.status, body: (await res.json()) as Body };
  };
  return { call, fleet, ran: () => ran };
}

const caseOf = (name: string) => (CASES.cases as Dp113Case[]).find((c) => c.name === name)!;
async function seed(db: TransactionalSqlExecutor, name: string) {
  const c = caseOf(name);
  // The cases insert ignores and policies with their ids; new rows take the identity's next value (set before withOrg's role).
  for (const table of ["image_scan_ignores", "image_scan_policies"]) await db.execute(`SELECT setval(pg_get_serial_sequence('deploy.${table}', 'id'), 1000)`);
  for (const sql of [...(c.setup ?? []), ...(c.setupFreeploy ?? [])]) await query(db, sql);
  await seedVariables(db, c.serviceVariables ?? []);
  await seedScans(db, c.imageScans ?? []);
}
const count = async (db: TransactionalSqlExecutor, table: string, org = ORG1) => Number(((await query(db, `SELECT count(*)::int AS n FROM ${table}`, org))[0] as { n: number }).n);
const summaries = async (db: TransactionalSqlExecutor) => JSON.stringify(await query(db, "SELECT id, summary::text FROM image_scans ORDER BY id"));
const toastsOf = (r: { status: number; body: Body }) => (r.body.data?.toasts ?? [r.status, r.body.error]) as Array<{ type: string; message: string }>;

describe("routing and rules", () => {
  it("serves a resource's …/vulnerabilities, its export and its SBOM downloads", () => {
    expect([isImageScanPageRoute([APP, "vulnerabilities"]), isImageScanPageRoute([APP, "vulnerabilities", "sbom", "s", "spdx"]), isImageScanPageRoute([APP, "maintenance"]), isImageScanPageRoute([APP])]).toEqual([true, true, false, false]);
  });

  it("validates an ignore with ImageScanIgnore's rules and Laravel's messages", () => {
    const base = { kind: "vulnerability", scope: "resource", expires: "90", vulnerability_id: "CVE-2025-1", package: null, reason: "Not used" };
    expect(validateIgnore(base)).toEqual({});
    expect(validateIgnore({ ...base, reason: "" })).toEqual({ reason: ["The reason field is required."] });
    expect(validateIgnore({ ...base, reason: "x".repeat(501) })).toEqual({ reason: ["The reason field must not be greater than 500 characters."] });
    expect(validateIgnore({ ...base, vulnerability_id: "-bad id" })).toEqual({ vulnerability_id: ["The vulnerability id field format is invalid."] });
    expect(validateIgnore({ ...base, vulnerability_id: null })).toEqual({ vulnerability_id: ["The vulnerability id field is required when package is not present."], package: ["The package field is required when vulnerability id is not present."] });
    expect(validateIgnore({ ...base, kind: "x", scope: "everything", expires: "7" })).toEqual({ kind: ["The selected kind is invalid."], scope: ["The selected scope is invalid."], expires: ["The selected expires is invalid."] });
  });

  it("ports the card's and the exports' small rules", () => {
    const git = { buildPack: "nixpacks", dockerfile: null } as ApplicationModel;
    expect([knowsRunningCommit(git, "abc1234"), knowsRunningCommit(git, " head "), knowsRunningCommit(git, null), knowsRunningCommit({ ...git, buildPack: "dockerimage" }, null)]).toEqual([true, false, false, true]);
    expect([shortCommit("0123456789abcdef"), shortCommit(null)]).toEqual(["0123456", "HEAD"]);
    expect([9.8, 7, 4.3, 0.1, 0].map(cvssSeverity)).toEqual(["critical", "high", "medium", "low", "unknown"]);
    expect(markdownLink("CVE-1 [x]", "https://a/b c)")).toBe("[CVE-1 \\[x\\]](https://a/b%20c%29)");
    expect(csvDocument(["a", "b"], [["=SUM(1)", true], ["x y", null]])).toBe('a,b\n\'=SUM(1),yes\n"x y",\n');
    expect([notScannedSentence(1, 1), notScannedSentence(3, 2), notScannedSentence(2, 0)]).toEqual([
      "1 resource on 1 server was not scanned, so Coolify cannot tell.",
      "3 resources on 2 servers were not scanned, so Coolify cannot tell.",
      "2 resources were not scanned, so Coolify cannot tell.",
    ]);
  });
});

describe("a resource's Security page", () => {
  it("shows the off state of a server that does not scan images", async () => {
    await fixture.inCase(async (db) => {
      await seed(db, "vulnerabilities: application, scanning off");
      const r = await client(db).call("application", APP);
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ application: { uuid: APP }, canUpdate: true, vulnerabilities: { offState: "server", serverUrl: expect.stringMatching(/^\/server\/[^/]+\/security\/vulnerabilities$/), canUpdate: true, state: null } });
      // Without the write: Ask a team admin (no link).
      expect((await client(db, { write: false }).call("application", APP)).body.data!.vulnerabilities).toMatchObject({ offState: "server", serverUrl: null, canUpdate: false });
    });
  });

  it("shows the engine's status, card and findings, as DP-113's API answers them", async () => {
    await fixture.inCase(async (db) => {
      await seed(db, "vulnerabilities: application");
      const api = JSON.parse(golden("vulnerabilities: application").body.json!) as { security: { status: string; actions: Array<{ sentence: string }> }; findings: Array<{ id: string; state: string }> };
      const c = client(db);
      const page = (await c.call("application", APP, [], "GET", undefined, "?view=cve")).body.data!.vulnerabilities;
      expect(page.offState).toBeNull();
      expect(page.card).toMatchObject({ status: api.security.status, badge: "Update now", badgeType: "error", single: true, header: null });
      const [row] = page.card.rows;
      expect(row).toMatchObject({ ref: "nginx:alpine", status: "update_now", open: true, primary: { type: "update_image", sentence: api.security.actions[0]!.sentence, button: { label: "Update to 1.27.4-alpine", title: "Update to 1.27.4-alpine?", submit: { action: "updateImage", candidateRef: "nginx:1.27.4-alpine", ownerUuid: "" }, warning: "Coolify redeploys the app with the new image." } } });
      expect(row.primary.button.actions.at(-1)).toBe("Redeploy the app.");
      expect(row.others.map((o: { type: string }) => o.type)).toEqual(["pull_latest"]);
      expect(page.checkedAt).toMatchObject({ iso: "2025-12-31T12:00:00+00:00", ago: "12 hours ago", title: "Wed, Dec 31, 2025 12:00 PM" });
      const of = (state: string) => api.findings.filter((f) => f.state === state).map((f) => f.id);
      expect(page.stateCounts).toEqual({ fixed: of("fixed").length, no_fix: of("no_fix").length });
      expect(page.ignoredCount).toBe(of("ignored").length);
      expect(page.findingCount).toBe(of("fixed").length + of("no_fix").length);
      // By CVE, fixed: worst first, as the API's list (known exploited, severity, risk).
      expect(page.grouped).toBe(false);
      expect(page.items.items.map((f: { id: string }) => f.id)).toEqual(of("fixed"));
      expect(page.items.items[0]).toMatchObject({ id: "CVE-2025-1001", url: "https://nvd.nist.gov/vuln/detail/CVE-2025-1001", kev: true, neverAllowed: false, owner: APP });
      // No fix yet, then the ignored ones with their reasons.
      expect((await c.call("application", APP, [], "GET", undefined, "?view=cve&fixState=no_fix")).body.data!.vulnerabilities.items.items.map((f: { id: string }) => f.id)).toEqual(of("no_fix"));
      const ignored = (await c.call("application", APP, [], "GET", undefined, "?showIgnored=1")).body.data!.vulnerabilities;
      expect(ignored.items.items.map((f: { id: string }) => f.id).sort()).toEqual(of("ignored").sort());
      expect(ignored.items.items.find((f: { id: string }) => f.id === "CVE-2025-1007").ignore).toEqual({ reason: "Only used at build time", until: "Feb 1, 2026" });
      // By package: one group per package version; filters, search and pages.
      const packages = (await c.call("application", APP)).body.data!.vulnerabilities;
      expect(packages.grouped).toBe(true);
      expect(packages.groupedFindingCount).toBe(of("fixed").length);
      expect(packages.items.items[0]).toMatchObject({ package: "openssl", severity: "critical", kev: true, count: 1, neverAllowed: false });
      const critical = (await c.call("application", APP, [], "GET", undefined, "?view=cve&severities=critical,bogus")).body.data!.vulnerabilities;
      expect([critical.items.items.map((f: { id: string }) => f.id), critical.hasFilters, critical.stateCounts]).toEqual([["CVE-2025-1001"], true, { fixed: 1, no_fix: 1 }]);
      expect((await c.call("application", APP, [], "GET", undefined, "?view=cve&search=%20ZLIB%20")).body.data!.vulnerabilities.items.items.map((f: { id: string }) => f.id)).toEqual(["CVE-2025-1003"]);
      const paged = (await c.call("application", APP, [], "GET", undefined, "?view=cve&perPage=3&page=9")).body.data!.vulnerabilities.items;
      expect([paged.currentPage, paged.lastPage, paged.firstItem, paged.lastItem, paged.total]).toEqual([2, 2, 4, 4, 4]);
      // Unknown states and views fall back as render() normalizes them.
      expect((await c.call("application", APP, [], "GET", undefined, "?fixState=open&view=grid")).body.data!.vulnerabilities.state).toMatchObject({ fixState: "fixed", view: "package" });
    });
  });

  it("shows a service's images and a database's, and the settings each lists", async () => {
    await fixture.inCase(async (db) => {
      await seed(db, "vulnerabilities: service, both images updated by one tag");
      const api = JSON.parse(golden("vulnerabilities: service, both images updated by one tag").body.json!) as { security: { status: string } };
      const c = client(db);
      const service = (await c.call("service", SERVICE)).body.data!;
      expect(service).toMatchObject({ service: { uuid: SERVICE }, vulnerabilities: { isService: true, card: { status: api.security.status } }, settings: { scopeType: "service", rules: null } });
      const rows = service.vulnerabilities.card.rows as Array<{ primary: { button: { submit: { action: string } } } | null; mergedWith: string | null }>;
      // One merged update: its button on the first row, the other row says which row updates it.
      expect(rows.filter((r) => r.primary?.button?.submit.action === "updateImages")).toHaveLength(1);
      expect(rows.filter((r) => r.mergedWith !== null)).toHaveLength(rows.length - 1);
    });
    await fixture.inCase(async (db) => {
      await seed(db, "vulnerabilities: database, PostgreSQL");
      const api = JSON.parse(golden("vulnerabilities: database, PostgreSQL").body.json!) as { security: { status: string } };
      const page = (await client(db).call("database", POSTGRES)).body.data!;
      expect(page).toMatchObject({ database: { uuid: POSTGRES }, vulnerabilities: { card: { status: api.security.status } }, settings: { scopeType: "database", rules: null } });
    });
  });

  it("ignores a finding with Coolify's rules, messages and toast, and writes the summaries again", async () => {
    await fixture.inCase(async (db) => {
      await seed(db, "vulnerabilities: application");
      const c = client(db);
      const ignore = (body: Record<string, unknown>) => c.call("application", APP, [], "PATCH", { action: "ignore", kind: "vulnerability", scope: "resource", expires: "30", reason: "Not reachable", ...body });
      const before = await count(db, "image_scan_ignores");
      const missing = await ignore({ target: "CVE-2025-1005", reason: "  " });
      expect([missing.status, missing.body.error!.message, missing.body.error!.details!.fields]).toEqual([422, "The reason field is required.", { reason: ["The reason field is required."] }]);
      expect((await ignore({ target: "CVE-2099-0001" })).body.error!.details!.fields).toEqual({ vulnerability_id: ["This is not in the scan results."] });
      expect((await ignore({ target: "CVE-2025-1001", expires: "never" })).body.error!.details!.fields).toEqual({ expires: ["Attackers are using or are likely to use this problem, so its ignore must expire. Choose 30 or 90 days."] });
      expect(await count(db, "image_scan_ignores")).toBe(before);
      const stored = await summaries(db);
      const ok = await ignore({ target: "cve-2025-1005" });
      expect([ok.status, toastsOf(ok)]).toEqual([200, [{ type: "success", message: "Ignored" }]]);
      const [row] = (await query(db, "SELECT resource_type, resource_id::int AS resource_id, vulnerability_id, package, reason, to_char(expires_at, 'YYYY-MM-DD HH24:MI:SS') AS expires_at FROM image_scan_ignores WHERE uuid = 'w9parityignorenew000001'")) as Array<Record<string, unknown>>;
      expect(row).toEqual({ resource_type: "App\\Models\\Application", resource_id: 1, vulnerability_id: "cve-2025-1005", package: null, reason: "Not reachable", expires_at: "2026-01-31 00:00:00" });
      expect(await summaries(db)).not.toBe(stored);
      expect((await c.call("application", APP)).body.data!.vulnerabilities.ignoredCount).toBe(3);
      // A package team-wide; then the settings list it and remove only the resource's own.
      expect(toastsOf(await ignore({ kind: "package", target: "zlib", scope: "team", expires: "never" }))).toEqual([{ type: "success", message: "Ignored" }]);
      const settings = (await c.call("application", APP)).body.data!.settings;
      expect(settings.ignores.slice(0, 2)).toMatchObject([{ vulnerabilityId: "cve-2025-1005", teamWide: false, expires: "2026-01-31" }, { teamWide: false, package: "perl" }]);
      expect(settings.ignores.find((i: { package: string | null }) => i.package === "zlib")).toMatchObject({ teamWide: true, expires: null });
      const teamWide = settings.ignores.find((i: { package: string | null }) => i.package === "zlib").uuid;
      expect((await c.call("application", APP, [], "PATCH", { action: "removeIgnore", uuid: teamWide })).status).toBe(404);
      expect(toastsOf(await c.call("application", APP, [], "PATCH", { action: "removeIgnore", uuid: "w9parityignorenew000001" }))).toEqual([{ type: "success", message: "Removed." }]);
      expect((await c.call("application", APP)).body.data!.vulnerabilities.ignoredCount).toBe(3);
    });
  });

  it("answers what scans, pulls, updates or rebuilds on a server as needing the SSH executor, after Coolify's checks, storing nothing", async () => {
    await fixture.inCase(async (db) => {
      await seed(db, "vulnerabilities: application");
      const c = client(db);
      const patch = (body: Record<string, unknown>, kind: ImageScanResourceKind = "application", uuid = APP) => c.call(kind, uuid, [], "PATCH", body);
      const stored = await summaries(db);
      const scans = await count(db, "image_scans");
      const scan = await patch({ action: "scanNow" });
      expect([scan.status, scan.body.error]).toEqual([501, expect.objectContaining({ code: "unsupported", message: "Scanning the images needs the SSH executor, which is not available yet." })]);
      const update = await patch({ action: "updateImage", candidateRef: "nginx:1.27.4-alpine" });
      expect([update.status, update.body.error!.message]).toEqual([501, "Updating the image needs the SSH executor, which is not available yet."]);
      expect(toastsOf(await patch({ action: "updateImage", candidateRef: "nginx:9" }))).toEqual([{ type: "error", message: "This update is no longer offered. Reload the page." }]);
      // A service's update names one of its applications or databases.
      expect((await patch({ action: "updateImage", candidateRef: "nginx:9", ownerUuid: "nope" }, "service", SERVICE)).status).toBe(404);
      expect((await patch({ action: "updateImages", actionKey: "0000" })).status).toBe(404);
      expect(toastsOf(await patch({ action: "updateImages", actionKey: "0000" }, "service", SERVICE))).toEqual([{ type: "error", message: "This update is no longer offered. Reload the page." }]);
      // A Docker image app runs its latest finished deployment: no commit needed.
      expect((await patch({ action: "rebuild" })).body.error!.message).toBe("Rebuilding the app needs the SSH executor, which is not available yet.");
      expect((await patch({ action: "rebuild" }, "database", POSTGRES)).status).toBe(404);
      expect([await summaries(db), await count(db, "image_scans")]).toEqual([stored, scans]);
    });
    await fixture.inCase(async (db) => {
      await seed(db, "vulnerabilities: application, its scanning off");
      expect(toastsOf(await client(db).call("application", APP, [], "PATCH", { action: "scanNow" }))).toEqual([{ type: "error", message: "Image scanning is off for this resource." }]);
    });
    await fixture.inCase(async (db) => {
      await seed(db, "vulnerabilities: application, a Dockerfile build");
      const r = await client(db).call("application", GIT_APP, [], "PATCH", { action: "rebuild" });
      expect([r.status, r.body.error!.message]).toEqual([501, "Rebuilding the app needs the SSH executor, which is not available yet."]);
    });
  });

  it("saves the application's scan settings and refuses Block deploys while its scan is off", async () => {
    await fixture.inCase(async (db) => {
      await seed(db, "vulnerabilities: application");
      const c = client(db);
      const patch = (body: Record<string, unknown>) => c.call("application", APP, [], "PATCH", body);
      const rules = (await c.call("application", APP)).body.data!.settings.rules;
      expect(rules).toMatchObject({ gateMode: "", onScanError: "", countMedium: "", appScanEnabled: "1", appScanOn: true, inheritLabels: { gate_mode: "Use Coolify default (Off)", on_scan_error: "Use Coolify default (Deploy anyway)", count_medium: "Use team default (Yes)" } });
      expect((await patch({ action: "saveRule", column: "gate_mode", value: "loud" })).body.error).toMatchObject({ message: "The selected gate mode is invalid.", details: { fields: { gateMode: ["The selected gate mode is invalid."] } } });
      expect(toastsOf(await patch({ action: "saveRule", column: "gate_mode", value: "strict" }))).toEqual([{ type: "success", message: "Saved." }]);
      expect(toastsOf(await patch({ action: "saveRule", column: "count_medium", value: "0" }))).toEqual([{ type: "success", message: "Saved." }]);
      expect(await query(db, "SELECT scope_type, scope_id::int AS scope_id, gate_mode, count_medium FROM image_scan_policies WHERE scope_type = 'App\\Models\\Application'")).toEqual([{ scope_type: "App\\Models\\Application", scope_id: 1, gate_mode: "strict", count_medium: false }]);
      expect((await patch({ action: "appScanEnabled", value: "2" })).body.error!.details!.fields).toEqual({ appScanEnabled: ["The selected app scan enabled is invalid."] });
      expect(toastsOf(await patch({ action: "appScanEnabled", value: "0" }))).toEqual([{ type: "success", message: "Saved." }]);
      expect(toastsOf(await patch({ action: "saveRule", column: "gate_mode", value: "on" }))).toEqual([{ type: "error", message: "Turn on the scan for this app first." }]);
      expect((await c.call("application", APP)).body.data!.vulnerabilities.offState).toBe("application");
      // A database has no rules of its own.
      expect((await c.call("database", POSTGRES, [], "PATCH", { action: "saveRule", column: "gate_mode", value: "on" })).status).toBe(404);
    });
  });

  it("downloads a current scan's stored package list as CycloneDX or SPDX, and exports the shown findings", async () => {
    await fixture.inCase(async (db) => {
      await seed(db, "vulnerabilities: application");
      await query(
        db,
        `INSERT INTO image_sboms (id, server_id, image_id, platform, packages, packages_truncated, last_used_at, org_id) VALUES (77, 1, 'sha256:x', 'linux/amd64', '[{"id":"p1","name":"openssl","version":"3.0.1","type":"apk","licenses":["Apache-2.0"],"purl":"pkg:apk/alpine/openssl@3.0.1"},{"id":"p2","name":"zlib","version":"","type":"apk","licenses":["Zlib License"],"purl":""}]', false, '2026-01-01 00:00:00', deploy.current_org())`,
      );
      await query(db, "UPDATE image_scans SET image_sbom_id = 77 WHERE resource_type = 'App\\Models\\Application' AND resource_id = 1");
      const c = client(db);
      const [scan] = (await query(db, "SELECT uuid FROM image_scans WHERE resource_type = 'App\\Models\\Application' AND resource_id = 1")) as Array<{ uuid: string }>;
      const env = (await query(db, "SELECT e.uuid FROM environments e JOIN applications a ON a.environment_id = e.id WHERE a.uuid = 'a1parityimageapp00000001'"))[0] as { uuid: string };
      const page = (await c.call("application", APP, [], "GET", undefined, "?packagesSearch=OPEN")).body.data!.packages;
      expect(page).toMatchObject({ hasScans: true, total: 2, typeOptions: ["apk"], downloads: [{ image: "nginx:alpine", scanUuid: scan!.uuid }], items: { total: 1, items: [{ name: "openssl", licenses: ["Apache-2.0"] }] } });
      const cdx = await c.call("application", APP, ["sbom", scan!.uuid, "cyclonedx"], "GET", undefined, `?environment=${env.uuid}`);
      expect(cdx.body.data!.filename).toBe("parity-image-nginxalpine-sbom.cdx.json");
      const doc = JSON.parse(cdx.body.data!.content);
      expect(doc).toMatchObject({ bomFormat: "CycloneDX", specVersion: "1.6", metadata: { timestamp: "2026-01-01T00:00:00Z", component: { name: "nginx:alpine" } }, components: [{ type: "library", "bom-ref": "package-p1", name: "openssl", version: "3.0.1", purl: "pkg:apk/alpine/openssl@3.0.1", licenses: [{ license: { name: "Apache-2.0" } }] }, { name: "zlib" }] });
      expect(doc.components[1]).not.toHaveProperty("version");
      expect(cdx.body.data!.content).toContain('\n    "bomFormat": "CycloneDX"');
      const spdx = JSON.parse((await c.call("application", APP, ["sbom", scan!.uuid, "spdx"], "GET", undefined, `?environment=${env.uuid}`)).body.data!.content);
      expect(spdx.packages.map((p: { licenseDeclared: string }) => p.licenseDeclared)).toEqual(["Apache-2.0", "NOASSERTION"]);
      expect(spdx.relationships).toHaveLength(2);
      for (const [rest, search] of [[["sbom", scan!.uuid, "cyclonedx"], "?environment=wrong"], [["sbom", scan!.uuid, "pdf"], `?environment=${env.uuid}`], [["sbom", "nope", "spdx"], `?environment=${env.uuid}`]] as const) {
        expect((await c.call("application", APP, [...rest], "GET", undefined, search)).status).toBe(404);
      }
      const ids = (await c.call("application", APP, ["export"], "GET", undefined, "?format=ids&fixState=no_fix")).body.data!.content;
      expect(ids).toBe("CVE-2025-1006\n");
      const markdown = (await c.call("application", APP, ["export"], "GET", undefined, "?format=markdown&severities=critical")).body.data!.content as string;
      expect(markdown.split("\n").slice(0, 5)).toEqual(["**Vulnerabilities of parity-image (1 finding, Fix available upstream)**", "", "| ID | Severity | Package | Version | Fixed in |", "| --- | --- | --- | --- | --- |", expect.stringMatching(/^\| \[CVE-2025-1001\]\(https:\/\/nvd\.nist\.gov\/vuln\/detail\/CVE-2025-1001\) \| Critical, known exploited \| openssl \|/)]);
      const csv = (await c.call("application", APP, ["export"], "GET", undefined, "?format=csv&showIgnored=1")).body.data!;
      expect([csv.filename, csv.contentType, csv.content.split("\n")[0]]).toEqual(["parity-image-vulnerabilities-2026-01-01.csv", "text/csv; charset=UTF-8", "id,severity,known_exploited,package,version,fixed_in,package_type,image,fix_state,epss,cvss,aliases,ignored_reason,ignored_until,url,summary"]);
      const exported = JSON.parse((await c.call("application", APP, ["export"], "GET", undefined, "?format=json")).body.data!.content);
      expect(exported).toMatchObject({ resource: { type: "application", uuid: APP }, exported_at: "2026-01-01T00:00:00+00:00", count: 4 });
    });
  });
});

describe("the team's Security page", () => {
  it("lists the org's resources by their stored status as DP-113's API does, hides the ones not scanned, and searches", async () => {
    await fixture.inCase(async (db) => {
      await seed(db, "vulnerabilities: list");
      const api = JSON.parse(golden("vulnerabilities: list").body.json!) as { resources: Array<{ uuid: string; security: { status: string } }> };
      const c = client(db);
      const page = (await c.fleet([], "?showNotChecked=1&perPage=100")).body.data!;
      expect(page.items.items.map((e: { status: string }) => e.status)).toEqual(api.resources.map((r) => r.security.status));
      expect(page.items.items[0]).toMatchObject({ link: expect.stringMatching(/^\/project\/[^/]+\/environment\/[^/]+\/(application|service|database)\/[^/]+\/vulnerabilities$/) });
      const hidden = (await c.fleet()).body.data!;
      const notChecked = api.resources.filter((r) => r.security.status === "not_checked").length;
      expect(hidden.items.total).toBe(api.resources.length - notChecked);
      if (notChecked > 0) expect([hidden.notCheckedToggle, hidden.hidesNotChecked]).toEqual(["Show them", true]);
      const ok = (await c.fleet([], "?statuses=update_now")).body.data!;
      expect(ok.items.items.every((e: { status: string }) => e.status === "update_now")).toBe(true);
      expect(ok.statusOptions.update_now).toMatch(/^Update now \(\d+\)$/);
      const search = (await c.fleet([], "?search=CVE-2025-1001")).body.data!;
      expect(search.searching).toBe(true);
      expect(search.items.items[0].match).toMatchObject({ id: "CVE-2025-1001" });
      const markdown = (await c.fleet(["export"], "?format=markdown")).body.data!.content as string;
      expect(markdown.split("\n")[0]).toMatch(/^\*\*Security of Parity Team \(\d+ resources?\)\*\*$/);
      expect(markdown).toContain("](https://console.example/project/");
      expect((await c.fleet(["export"], "?format=pdf")).status).toBe(404);
    });
  });
});

describe("who may see and change the pages", () => {
  it("answers 404 and runs nothing without the read, or for a change without the write", async () => {
    await fixture.inCase(async (db) => {
      await seed(db, "vulnerabilities: application");
      const reader = client(db, { read: false });
      expect((await reader.call("application", APP)).status).toBe(404);
      expect((await reader.fleet()).status).toBe(404);
      expect(reader.ran()).toBe(0);
      const viewer = client(db, { write: false });
      const before = await count(db, "image_scan_ignores");
      for (const body of [{ action: "ignore", kind: "vulnerability", scope: "resource", expires: "30", reason: "x", target: "CVE-2025-1005" }, { action: "scanNow" }, { action: "saveRule", column: "gate_mode", value: "on" }]) {
        expect((await viewer.call("application", APP, [], "PATCH", body)).status).toBe(404);
      }
      expect([viewer.ran(), await count(db, "image_scan_ignores")]).toEqual([0, before]);
      // A viewer sees no buttons.
      const page = (await viewer.call("application", APP)).body.data!.vulnerabilities;
      expect([page.canUpdate, page.card.rows[0].primary.button, page.canIgnoreForTeam]).toEqual([false, null, false]);
      expect((await viewer.call("application", APP, [], "POST", {})).status).toBe(405);
    });
  });

  it("never reaches another org's resources", async () => {
    await fixture.inCase(async (db) => {
      await seed(db, "vulnerabilities: application");
      const c = client(db);
      expect((await c.call("application", OTHER_APP)).status).toBe(404);
      expect((await c.call("application", APP, [], "GET", undefined, "", ORG2)).status).toBe(404);
      expect((await c.call("application", APP, [], "PATCH", { action: "ignore", kind: "vulnerability", scope: "team", expires: "30", reason: "x", target: "CVE-2025-1005" }, "", ORG2)).status).toBe(404);
      expect(await count(db, "image_scan_ignores", ORG2)).toBe(0);
      const other = (await c.fleet([], "?showNotChecked=1", "GET", ORG2)).body.data!;
      expect(other.items.items.map((e: { name: string }) => e.name)).not.toContain("parity-image");
    });
  });
});
