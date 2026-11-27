// DP-116: the image scanning settings through their handlers, over DP-113's image scan cases (image-scan-seed.ts) in
// Freeploy's database (PGlite with every deploy migration, row-level security on): the instance's rules behind DP-79's
// gate (the platform's row of migration 740, created with Coolify's seeded values), the team's (its row, Scan images on
// new servers through membership-worker's team settings route, its team-wide ignores) and a server's Vulnerabilities
// page (ServerImageScanning's rules, limits and toasts, HostVulnerabilities over a stored host scan); the resolver reading
// the stored instance, team and server rows; the 501s that store nothing; a denial's 404 that runs nothing; one org never
// reaching another's rows.
// The Worker's own module order (the router first), as its import cycle needs.
import "@deploy-core-worker/router";
import type { SqlExecutor, TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { asPlatformAdmin, findInstanceImageScanPolicy, withOrg } from "@saas/db/deploy";
import type { Env } from "@deploy-core-worker/env";
import {
  handleInstanceImageScanning,
  handleServerImageScanning,
  handleTeamImageScanning,
  isServerImageScanRoute,
  membershipTeamSettings,
  type ImageScanSettingsDeps,
  type TeamSettingsClient,
} from "@deploy-core-worker/handlers/image-scan-settings";
import { handleFleetVulnerabilities, handleImageScanPages } from "@deploy-core-worker/handlers/image-scan-pages";
import { validateLevelRule, validateScanNewServers } from "@deploy-core-worker/image-scan/scan-settings";
import { countMediumFor, policyFor } from "@deploy-core-worker/image-scan/policy";
import { findResource, loadScanData } from "@deploy-core-worker/image-scan/data";
import {
  bootKernel,
  cpuOptions,
  errorCodeMessage,
  fixingUpdates,
  formatBytes,
  isOtherKernelPackage,
  kernelStatus,
  memoryOptionsMb,
  riskFor,
  scannerCpus,
  validateScannerLimit,
} from "@deploy-core-worker/image-scan/server-scanning";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";
import { CASES } from "./api-v1-goldens.js";
import { decrypt, NOW, query, seedScans, seedVariables, type Dp113Case } from "./image-scan-seed.js";

const ORG1 = ORG_UUID[1]!;
const ORG2 = ORG_UUID[2]!;
const SERVER = "s1parityserveruuid000001";
const OTHER_SERVER = "s2otherteamserver0000002";
const APP = "a1parityimageapp00000001";
const DRAGONFLY = "b7paritydragonfly0000007";
const actor = { subjectId: "usr_1", subjectType: "user" };
const NIL = "00000000-0000-0000-0000-000000000000";

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
type Answer = { status: number; body: Body };
const answer = async (res: Response): Promise<Answer> => ({ status: res.status, body: (await res.json()) as Body });
const toastsOf = (r: Answer) => (r.body.data?.toasts ?? [r.status, r.body.error?.message]) as Array<{ type: string; message: string }>;

function client(db: TransactionalSqlExecutor, allow: { read?: boolean; write?: boolean; operator?: boolean } = {}) {
  let ran = 0;
  const membership: Array<{ method: string; path: string; body: unknown }> = [];
  let scanNewServers = false;
  const env: Env = {
    ENVIRONMENT: "test",
    DEPLOY_ENCRYPTION_KEY: TEST_KEK,
    DEPLOY_CONSOLE_URL: "https://console.example",
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    // membership-worker: the authorization context, the org (its switch), the team page (canUpdate) and its settings route.
    MEMBERSHIP_WORKER: fetcher(async (req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/authorization-context")) return json({ data: { memberships: [] } });
      const body = req.method === "PATCH" ? ((await req.json()) as Record<string, unknown>) : undefined;
      membership.push({ method: req.method, path, body });
      if (path.endsWith("/team/settings")) {
        if (allow.write === false) return json({ error: { code: "not_found" } }, 404);
        scanNewServers = body?.scanImagesOnNewServers === true;
        return json({ data: { organization: { scanImagesOnNewServers: scanNewServers } } });
      }
      if (path.endsWith("/team")) return json({ data: { team: { name: "Parity Team" }, canUpdate: allow.write ?? true } });
      return json({ data: { organization: { id: "org_x", name: "Parity Team", createdAt: "2025-01-01T00:00:00Z", scanImagesOnNewServers: scanNewServers } } });
    }),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      const ok = body.action === "deploy.resource.write" ? (allow.write ?? true) : (allow.read ?? true);
      return json({ data: { decision: ok ? "allow" : "deny", allow: ok } });
    }),
  };
  let n = 0;
  const deps: ImageScanSettingsDeps = {
    runner: (_env, orgId, fn) => ((ran += 1), withOrg(db, orgId, fn)),
    platformRunner: (_env, fn) => ((ran += 1), asOperator(db, fn)),
    now: () => NOW,
    uuid: () => `w9paritypolicynew${String((n += 1)).padStart(6, "0")}`,
  };
  const req = (method: string, body?: unknown, search = "") => new Request(`https://x/settings${search}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const allowed = async () => (allow.operator === false ? json({ error: { code: "not_found", message: "Not found" } }, 404) : null);
  return {
    env,
    membership,
    ran: () => ran,
    instance: async (method = "GET", body?: unknown) => answer(await handleInstanceImageScanning(env, "req_1", req(method, body), allowed, deps)),
    team: async (method = "GET", body?: unknown, org = ORG1, team?: TeamSettingsClient) => answer(await handleTeamImageScanning(env, "req_1", actor, org, "org_x", req(method, body), { ...deps, ...(team ? { team } : {}) })),
    server: async (method = "GET", body?: unknown, search = "", uuid = SERVER, rest: string[] = [], org = ORG1) =>
      answer(await handleServerImageScanning(env, "req_1", actor, org, uuid, ["security", "vulnerabilities", ...rest], req(method, body, search), deps)),
    page: async (kind: "application" | "database", uuid: string) =>
      answer(await handleImageScanPages(env, "req_1", actor, ORG1, kind, [uuid, "vulnerabilities"], new Request(`https://x/${uuid}/vulnerabilities`), { runner: (_e, o, fn) => withOrg(db, o, fn), now: () => NOW })),
    fleet: async () => answer(await handleFleetVulnerabilities(env, "req_1", actor, ORG1, "org_x", [], new Request("https://x/vulnerabilities"), { runner: (_e, o, fn) => withOrg(db, o, fn), now: () => NOW, teamName: async () => "Parity Team" })),
  };
}

const caseOf = (name: string) => (CASES.cases as Dp113Case[]).find((c) => c.name === name)!;
async function seed(db: TransactionalSqlExecutor, name: string) {
  const c = caseOf(name);
  for (const table of ["image_scan_ignores", "image_scan_policies"]) await db.execute(`SELECT setval(pg_get_serial_sequence('deploy.${table}', 'id'), 1000)`);
  for (const sql of [...(c.setup ?? []), ...(c.setupFreeploy ?? [])]) await query(db, sql);
  await seedVariables(db, c.serviceVariables ?? []);
  await seedScans(db, c.imageScans ?? []);
}
/**
 * asPlatformAdmin() in a case: the case's transactions are savepoints of one transaction, where SET LOCAL stays after
 * the savepoint, so the operator's flag is cleared again before the next org's transaction (as a new transaction is).
 */
const asOperator = <T>(db: TransactionalSqlExecutor, fn: (tx: SqlExecutor) => Promise<T>): Promise<T> =>
  asPlatformAdmin(db, async (tx) => {
    try {
      return await fn(tx);
    } finally {
      await tx.execute("SELECT set_config('deploy.platform_admin', '', true)");
    }
  });
const admin = (db: TransactionalSqlExecutor, sql: string, params: unknown[] = []) => asOperator(db, async (tx) => (await tx.execute(sql, params)).rows);
const policies = (db: TransactionalSqlExecutor, org = ORG1) => query(db, "SELECT scope_type, scope_id::int AS scope_id, gate_mode, on_scan_error, count_medium FROM image_scan_policies ORDER BY id", org);

describe("rules and messages", () => {
  it("validates the rules as saveRule() and updatedScanNewServers() do, with Laravel's messages", () => {
    expect([validateLevelRule("instance", "gate_mode", ""), validateLevelRule("instance", "on_scan_error", null), validateLevelRule("instance", "count_medium", undefined)]).toEqual([
      "The gate mode field is required.",
      "The on scan error field is required.",
      "The count medium field is required.",
    ]);
    // A team or a server may inherit (nullable).
    expect([validateLevelRule("team", "gate_mode", ""), validateLevelRule("server", "count_medium", null)]).toEqual([null, null]);
    expect([validateLevelRule("team", "gate_mode", "loud"), validateLevelRule("instance", "on_scan_error", "retry"), validateLevelRule("server", "count_medium", "maybe")]).toEqual([
      "The selected gate mode is invalid.",
      "The selected on scan error is invalid.",
      "The count medium field must be true or false.",
    ]);
    expect([validateScanNewServers(""), validateScanNewServers("yes"), validateScanNewServers("1"), validateScanNewServers(0)]).toEqual([
      { ok: false, message: "The scan new servers field is required." },
      { ok: false, message: "The selected scan new servers is invalid." },
      { ok: true, value: true },
      { ok: true, value: false },
    ]);
  });

  it("ports ServerImageScanning's limits: the options that fit the server, formatBytes() and the CPU limit", () => {
    const server = (metadata: unknown, cpus: unknown = "1.00") => ({ name: "s", serverMetadata: metadata, settings: { image_scan_cpus: cpus } });
    expect(memoryOptionsMb(server(null))).toEqual([1024, 2048, 4096, 8192]);
    expect(memoryOptionsMb(server({ memory_bytes: 3 * 1024 ** 3 }))).toEqual([1024, 2048]);
    expect(memoryOptionsMb(server({ memory_bytes: 512 * 1024 ** 2 }))).toEqual([1024]);
    expect(cpuOptions(server({ cpus: 2 }))).toEqual([0.5, 1, 2]);
    expect([scannerCpus(server({ cpus: 2 }, "4.00")), scannerCpus(server(null, "0.50")), scannerCpus(server(null, null))]).toEqual(["2", "0.5", "1"]);
    expect([formatBytes(1024 * 1024 ** 2, 0), formatBytes(8192 * 1024 ** 2, 0), formatBytes(0), formatBytes(1536, 1)]).toEqual(["1 GB", "8 GB", "0 B", "1.5 KB"]);
    const s = server({ memory_bytes: 2 * 1024 ** 3, cpus: 1 });
    expect([validateScannerLimit(s, "scannerMemoryMb", "2048"), validateScannerLimit(s, "scannerMemoryMb", "4096"), validateScannerLimit(s, "scannerCpus", "1.0"), validateScannerLimit(s, "scannerSyftTimeout", "")]).toEqual([
      null,
      "Choose one of the listed values. Values that are more than this server has are not allowed.",
      "Choose one of the listed values. Values that are more than this server has are not allowed.",
      "The scanner syft timeout field is required.",
    ]);
  });

  it("ports CheckUpdates' kernel and update rules and ImageScanErrorCode's messages", () => {
    const result = {
      package_manager: "apt",
      updates: [
        { package: "openssl", new_version: "3.0.13", risk: null },
        { package: "linux-image-6.8.0-140-generic", new_version: "6.8.0-140.140", risk: "kernel" },
        { package: "linux-image-aws", new_version: "6.8.0-1020.22", risk: "kernel" },
      ],
      kernels: {
        running: "6.8.0-139-generic",
        boot: "6.8.0-140-generic",
        installed: [
          { package: "linux-image-6.8.0-139-generic", version: "6.8.0-139.139", release: "6.8.0-139-generic" },
          { package: "linux-image-6.8.0-140-generic", version: "6.8.0-140.140", release: "6.8.0-140-generic" },
        ],
      },
    };
    expect([riskFor("apt", "linux-modules-6.8.0-139-generic"), riskFor("apt", "libc6"), riskFor("dnf", "kernel-core"), riskFor("apk", "openssl")]).toEqual(["kernel", "system", "kernel", null]);
    expect(fixingUpdates("openssl", result).map((u) => u.package)).toEqual(["openssl"]);
    // A versioned kernel package: the kernel updates of its flavor (generic), not the aws one.
    expect(fixingUpdates("linux-modules-6.8.0-139-generic", result).map((u) => u.package)).toEqual(["linux-image-6.8.0-140-generic"]);
    expect(fixingUpdates("openssl", { ...result, package_manager: "pacman" })).toEqual([]);
    expect(bootKernel(result)?.release).toBe("6.8.0-140-generic");
    expect(kernelStatus("linux-modules-6.8.0-139-generic", "6.8.0-139.139", "6.8.0-140.140", result)).toBe("fixed_after_reboot");
    expect(kernelStatus("linux-modules-6.8.0-140-generic", "6.8.0-140.140", null, result)).toBe("runs_after_reboot");
    expect([isOtherKernelPackage("linux-headers-6.8.0-100", "x", "6.8.0-139-generic"), isOtherKernelPackage("linux-headers-6.8.0-139", "x", "6.8.0-139-generic"), isOtherKernelPackage("kernel-core", "5.14.0-427.el9", "5.14.0-427.el9.x86_64"), isOtherKernelPackage("kernel-core", "5.14.0-300.el9", "5.14.0-427.el9.x86_64")]).toEqual([true, false, false, true]);
    expect(errorCodeMessage("db_too_old", { n: 9, server: "web" })).toBe("The vulnerability database is 9 days old. web cannot reach grype.anchore.io.");
    expect(errorCodeMessage("timeout", { step: "grype", server: "web" })).toBe("Grype took too long and was stopped. Raise the Grype time limit on the Vulnerabilities page of web.");
    expect([errorCodeMessage(null, {}), errorCodeMessage("not_a_code", {})]).toEqual([null, null]);
  });

  it("routes …/security/vulnerabilities and its export only", () => {
    expect([isServerImageScanRoute(["security", "vulnerabilities"]), isServerImageScanRoute(["security", "vulnerabilities", "export"]), isServerImageScanRoute(["security", "patches"]), isServerImageScanRoute(["security", "vulnerabilities", "x"])]).toEqual([true, true, false, false]);
  });
});

describe("/settings/image-scanning: the instance's rules", () => {
  it("creates the platform's row with Coolify's seeded values on the operator's first read; no org owns it", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      expect(await query(db, "SELECT count(*)::int AS n FROM image_scan_policies WHERE scope_type IS NULL")).toEqual([{ n: 0 }]);
      const r = await c.instance();
      expect(r.status).toBe(200);
      expect(r.body.data!.settings).toMatchObject({
        scopeType: "instance",
        canEdit: true,
        showsIgnores: false,
        rules: { gateMode: "off", onScanError: "deploy", countMedium: "0", inheritLabels: null, gateModeOptions: [{ value: "off" }, { value: "on" }, { value: "strict" }] },
      });
      expect(await admin(db, "SELECT org_id::text, scope_type, scope_id, gate_mode, on_scan_error, count_medium FROM deploy.image_scan_policies WHERE scope_type IS NULL")).toEqual([
        { org_id: NIL, scope_type: null, scope_id: null, gate_mode: "off", on_scan_error: "deploy", count_medium: false },
      ]);
      // A second read keeps the one row.
      await c.instance();
      expect(await admin(db, "SELECT count(*)::int AS n FROM deploy.image_scan_policies WHERE scope_type IS NULL")).toEqual([{ n: 1 }]);
    });
  });

  it("saves a rule with `required`, Laravel's messages and the toast", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      const empty = await c.instance("PATCH", { action: "saveRule", column: "gate_mode", value: "" });
      expect([empty.status, empty.body.error!.message, empty.body.error!.details!.fields]).toEqual([422, "The gate mode field is required.", { gateMode: ["The gate mode field is required."] }]);
      const bad = await c.instance("PATCH", { action: "saveRule", column: "on_scan_error", value: "retry" });
      expect([bad.status, bad.body.error!.message]).toEqual([422, "The selected on scan error is invalid."]);
      expect(toastsOf(await c.instance("PATCH", { action: "saveRule", column: "gate_mode", value: "strict" }))).toEqual([{ type: "success", message: "Saved." }]);
      expect(toastsOf(await c.instance("PATCH", { action: "saveRule", column: "on_scan_error", value: "block" }))).toEqual([{ type: "success", message: "Saved." }]);
      expect((await c.instance()).body.data!.settings.rules).toMatchObject({ gateMode: "strict", onScanError: "block", countMedium: "0" });
      expect((await c.instance("PATCH", { action: "nope" })).status).toBe(422);
    });
  });

  it("is the platform operator's: a customer's read and change are DP-79's 404, and nothing runs", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db, { operator: false });
      expect((await c.instance()).status).toBe(404);
      expect((await c.instance("PATCH", { action: "saveRule", column: "gate_mode", value: "on" })).status).toBe(404);
      expect(c.ran()).toBe(0);
      expect(await admin(db, "SELECT count(*)::int AS n FROM deploy.image_scan_policies WHERE scope_type IS NULL")).toEqual([{ n: 0 }]);
    });
  });

  it("every org reads the row (migration 740) but none can change it", async () => {
    await fixture.inCase(async (db) => {
      expect(toastsOf(await client(db).instance("PATCH", { action: "saveRule", column: "gate_mode", value: "on" }))).toEqual([{ type: "success", message: "Saved." }]);
      for (const org of [ORG1, ORG2]) {
        expect(await withOrg(db, org, async (tx) => (await findInstanceImageScanPolicy(tx))?.gate_mode)).toBe("on");
        await withOrg(db, org, (tx) => tx.execute("UPDATE deploy.image_scan_policies SET gate_mode = 'off' WHERE scope_type IS NULL"));
        await withOrg(db, org, (tx) => tx.execute("DELETE FROM deploy.image_scan_policies WHERE scope_type IS NULL"));
      }
      expect(await admin(db, "SELECT gate_mode FROM deploy.image_scan_policies WHERE scope_type IS NULL")).toEqual([{ gate_mode: "on" }]);
      // An org cannot insert a row for the platform.
      await expect(withOrg(db, ORG1, (tx) => tx.execute(`INSERT INTO deploy.image_scan_policies (uuid, org_id) VALUES ('x', '${NIL}')`))).rejects.toThrow();
    });
  });
});

describe("the resolver reads the stored instance, team and server rows", () => {
  it("resolves each rule from the lowest level that sets it", async () => {
    await fixture.inCase(async (db) => {
      await seed(db, "vulnerabilities: application");
      const c = client(db);
      const resolve = () =>
        withOrg(db, ORG1, async (tx) => {
          const app = (await findResource(tx, "application", APP, decrypt(tx, ORG1)))!;
          const data = await loadScanData(tx, [app], NOW, false);
          const p = policyFor(app, data);
          return { gate: p.gateMode, onError: p.onScanError, sources: p.sources, countMedium: countMediumFor(app, data) };
        });
      // The case's team row counts mediums; nothing else is set: Coolify's seeded defaults.
      expect(await resolve()).toEqual({ gate: "off", onError: "deploy", sources: { gate_mode: "instance", on_scan_error: "instance", count_medium: "team" }, countMedium: true });
      await c.instance("PATCH", { action: "saveRule", column: "gate_mode", value: "strict" });
      await c.instance("PATCH", { action: "saveRule", column: "on_scan_error", value: "block" });
      expect(await resolve()).toMatchObject({ gate: "strict", onError: "block", sources: { gate_mode: "instance", on_scan_error: "instance" } });
      await c.team("PATCH", { action: "saveRule", column: "gate_mode", value: "on" });
      expect(await resolve()).toMatchObject({ gate: "on", sources: { gate_mode: "team" } });
      await c.server("PATCH", { action: "saveRule", column: "on_scan_error", value: "deploy" });
      await c.server("PATCH", { action: "saveRule", column: "count_medium", value: "0" });
      expect(await resolve()).toEqual({ gate: "on", onError: "deploy", sources: { gate_mode: "team", on_scan_error: "server", count_medium: "server" }, countMedium: false });
      // The app's own inherit labels read the instance level now.
      const app = (await c.page("application", APP)).body.data!.settings.rules;
      expect(app.inheritLabels).toEqual({ gate_mode: "Use team default (On)", on_scan_error: "Use server default (Deploy anyway)", count_medium: "Use server default (No)" });
    });
  });

  it("counts mediums from the instance and writes every org's stored statuses again", async () => {
    await fixture.inCase(async (db) => {
      await seed(db, "vulnerabilities: database, Dragonfly without the team's policy");
      const c = client(db);
      const status = async () => [(await c.page("database", DRAGONFLY)).body.data!.vulnerabilities.card.status, (await c.fleet()).body.data!.items.items.find((i: { name: string }) => i.name.includes("dragonfly"))?.status];
      expect(await status()).toEqual(["ok", "ok"]);
      expect(toastsOf(await c.instance("PATCH", { action: "saveRule", column: "count_medium", value: "1" }))).toEqual([{ type: "success", message: "Saved." }]);
      // DP-113's "Dragonfly" golden (the team's policy counts mediums): update_available, now from the instance.
      expect(await status()).toEqual(["update_available", "update_available"]);
      await c.server("PATCH", { action: "saveRule", column: "count_medium", value: "0" });
      expect(await status()).toEqual(["ok", "ok"]);
    });
  });
});

describe("/team/image-scanning: the team's rules", () => {
  it("shows the team row, the inherited instance values, the switch from membership-worker and the team-wide ignores", async () => {
    await fixture.inCase(async (db) => {
      await seed(db, "vulnerabilities: database, Dragonfly");
      const c = client(db);
      const r = await c.team();
      expect(r.status).toBe(200);
      const s = r.body.data!.settings;
      expect(s).toMatchObject({ scopeType: "team", canEdit: true, showsIgnores: true, rules: { gateMode: "", onScanError: "", countMedium: "1", scanNewServers: "0", canEditScanNewServers: true, inheritLabels: { gate_mode: "Use Coolify default (Off)", on_scan_error: "Use Coolify default (Deploy anyway)", count_medium: "Use Coolify default (No)" } } });
      // Team-wide only, newest first.
      expect(s.ignores.map((i: { uuid: string }) => i.uuid)).toEqual(["n1parityignorehigh000001", "n3parityignoreexpired003", "n2parityignorekevold0002"]);
      expect(s.ignores[1]).toMatchObject({ vulnerabilityId: "CVE-2025-1003", expires: "2025-12-15", teamWide: true });
      expect(c.membership.map((m) => `${m.method} ${m.path}`)).toEqual(["GET /v1/organizations/org_x", "GET /v1/organizations/org_x/team"]);
    });
  });

  it("saves a rule (a new row of scope Team), the switch through membership-worker, and removes a team-wide ignore", async () => {
    await fixture.inCase(async (db) => {
      await seed(db, "vulnerabilities: application");
      await query(db, "DELETE FROM image_scan_policies");
      const c = client(db);
      expect(toastsOf(await c.team("PATCH", { action: "saveRule", column: "on_scan_error", value: "block" }))).toEqual([{ type: "success", message: "Saved." }]);
      expect(toastsOf(await c.team("PATCH", { action: "saveRule", column: "on_scan_error", value: "" }))).toEqual([{ type: "success", message: "Saved." }]);
      expect(await policies(db)).toEqual([{ scope_type: "App\\Models\\Team", scope_id: 0, gate_mode: null, on_scan_error: null, count_medium: null }]);
      const bad = await c.team("PATCH", { action: "scanNewServers", value: "2" });
      expect([bad.status, bad.body.error!.message, bad.body.error!.details!.fields]).toEqual([422, "The selected scan new servers is invalid.", { scanNewServers: ["The selected scan new servers is invalid."] }]);
      expect(toastsOf(await c.team("PATCH", { action: "scanNewServers", value: "1" }))).toEqual([{ type: "success", message: "Saved." }]);
      expect(c.membership.filter((m) => m.method === "PATCH")).toEqual([{ method: "PATCH", path: "/v1/organizations/org_x/team/settings", body: { scanImagesOnNewServers: true } }]);
      expect((await c.team()).body.data!.settings.rules.scanNewServers).toBe("1");
      await query(db, "INSERT INTO image_scan_ignores (uuid, org_id, vulnerability_id, reason, created_at, updated_at) VALUES ('teamwideignore000000001', deploy.current_org(), 'CVE-2025-1001', 'x', now(), now())");
      expect((await c.team("PATCH", { action: "removeIgnore", uuid: "nope" })).status).toBe(404);
      expect(toastsOf(await c.team("PATCH", { action: "removeIgnore", uuid: "teamwideignore000000001" }))).toEqual([{ type: "success", message: "Removed." }]);
      expect(await query(db, "SELECT count(*)::int AS n FROM image_scan_ignores WHERE uuid = 'teamwideignore000000001'")).toEqual([{ n: 0 }]);
    });
  });

  it("a member without team-wide write sees the values and changes nothing: a 404 that runs nothing", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db, { write: false });
      const r = await c.team();
      expect(r.body.data!.settings).toMatchObject({ canEdit: false, rules: { canEditScanNewServers: false } });
      const ran = c.ran();
      for (const body of [{ action: "saveRule", column: "gate_mode", value: "on" }, { action: "scanNewServers", value: "1" }, { action: "removeIgnore", uuid: "x" }]) expect((await c.team("PATCH", body)).status).toBe(404);
      expect(c.ran()).toBe(ran);
      expect(c.membership.filter((m) => m.method === "PATCH")).toEqual([]);
      expect(await policies(db)).toEqual([]);
      expect((await client(db, { read: false }).team()).status).toBe(404);
    });
  });

  it("keeps each org's team row to itself", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      await c.team("PATCH", { action: "saveRule", column: "gate_mode", value: "strict" }, ORG1);
      expect((await c.team("GET", undefined, ORG2)).body.data!.settings.rules.gateMode).toBe("");
      expect(await policies(db, ORG2)).toEqual([]);
    });
  });

  it("uses membership-worker's team settings route over the existing binding", async () => {
    const calls: string[] = [];
    const env = { MEMBERSHIP_WORKER: fetcher((req) => (calls.push(`${req.method} ${new URL(req.url).pathname} ${req.headers.get("x-actor-subject-id")}`), json({ data: {} }))) } as unknown as Env;
    expect(await membershipTeamSettings(env, "org_x", actor, "req_1").save(false)).toBe(true);
    expect(calls).toEqual(["PATCH /v1/organizations/org_x/team/settings usr_1"]);
  });
});

describe("/server/{uuid}/security/vulnerabilities", () => {
  const HOST_FINDINGS = [
    { id: "CVE-2025-2001", aliases: [], severity: "critical", package: "openssl", version: "3.0.2", fixedIn: "3.0.13", kev: true, epss: 0.9, title: "OpenSSL overflow", summary: "A buffer overflow." },
    { id: "CVE-2025-2002", aliases: ["GHSA-aaaa-bbbb-cccc"], severity: "high", package: "linux-modules-6.8.0-139-generic", version: "6.8.0-139.139", fixedIn: "6.8.0-140.140", kev: false, epss: 0.01, title: "Kernel bug", summary: "" },
    { id: "CVE-2025-2003", aliases: [], severity: "high", package: "linux-headers-6.8.0-100", version: "6.8.0-100.100", fixedIn: null, kev: false, epss: null, title: "Old kernel bug", summary: "" },
    { id: "CVE-2025-2004", aliases: [], severity: "medium", package: "zlib1g", version: "1.2.11", fixedIn: null, kev: false, epss: null, title: "zlib", summary: "" },
  ];
  const PATCH_RESULT = {
    package_manager: "apt",
    osId: "ubuntu",
    reboot_required: true,
    updates: [{ package: "openssl", new_version: "3.0.13", risk: null }, { package: "linux-image-6.8.0-140-generic", new_version: "6.8.0-140.140", risk: "kernel" }],
    kernels: {
      running: "6.8.0-139-generic",
      boot: "6.8.0-140-generic",
      installed: [
        { package: "linux-image-6.8.0-100-generic", version: "6.8.0-100.100", release: "6.8.0-100-generic" },
        { package: "linux-image-6.8.0-139-generic", version: "6.8.0-139.139", release: "6.8.0-139-generic" },
        { package: "linux-image-6.8.0-140-generic", version: "6.8.0-140.140", release: "6.8.0-140-generic" },
      ],
    },
  };
  async function hostScan(db: TransactionalSqlExecutor, opts: { enabled?: boolean; functional?: boolean } = {}) {
    await query(db, `UPDATE server_settings SET is_image_scan_enabled = ${opts.enabled ?? true}, is_reachable = ${opts.functional ?? true}, is_usable = ${opts.functional ?? true}, patch_check_result = '${JSON.stringify(PATCH_RESULT)}' WHERE server_id = 1`);
    await query(
      db,
      `INSERT INTO server_host_scans (server_id, summary, findings, findings_truncated, scanned_at, created_at, updated_at, org_id)
       VALUES (1, '{"critical":1,"high":2,"medium":1,"low":0,"unknown":0,"fixable":2,"exploited":1,"likely":0,"total":4,"running_kernel":"6.8.0-139-generic"}', '${JSON.stringify(HOST_FINDINGS)}', false, '2025-12-31 12:00:00', now(), now(), deploy.current_org())`,
    );
  }

  it("shows the scanner's state, the limits that fit the server, the server's rules and an empty host scan", async () => {
    await fixture.inCase(async (db) => {
      const r = await client(db).server();
      expect(r.status).toBe(200);
      const d = r.body.data!;
      expect(d.server).toMatchObject({ uuid: SERVER, name: "parity-server" });
      expect(d.scanning).toMatchObject({
        enabled: false,
        limits: { scannerMemoryMb: "1024", scannerSyftTimeout: "600", scannerGrypeTimeout: "600" },
        memoryLimit: "1 GB",
        timeoutOptions: [{ value: "300", label: "5 minutes" }, { value: "600", label: "10 minutes" }, { value: "1200", label: "20 minutes" }, { value: "1800", label: "30 minutes" }, { value: "3600", label: "60 minutes" }],
        cpuOptions: [{ value: "0.5", label: "0.5 CPU" }, { value: "1", label: "1 CPU" }, { value: "2", label: "2 CPUs" }, { value: "4", label: "4 CPUs" }],
        prepareState: null,
        registries: "docker.io",
        hasScannerData: true,
        toolVersions: "Syft 1.55.0, Grype 0.121.0, regctl 0.11.7",
        cpuLimit: "1",
      });
      expect(Number(d.scanning.limits.scannerCpus)).toBe(1);
      expect(d.settings).toMatchObject({ scopeType: "server", canEdit: true, showsIgnores: false, rules: { gateMode: "", inheritLabels: { gate_mode: "Use Coolify default (Off)" } } });
      expect(d.host).toMatchObject({ hostScan: null, hostScanAvailable: false, hostFindingsCount: 0, items: { items: [] } });
    });
  });

  it("marks a saved limit that no longer fits the server", async () => {
    await fixture.inCase(async (db) => {
      await query(db, `UPDATE servers SET server_metadata = '{"memory_bytes": ${2 * 1024 ** 3}, "cpus": 1}' WHERE id = 1`);
      await query(db, "UPDATE server_settings SET image_scan_memory_mb = 8192 WHERE server_id = 1");
      const s = (await client(db).server()).body.data!.scanning;
      expect(s.memoryOptions).toEqual([{ value: "1024", label: "1 GB" }, { value: "2048", label: "2 GB" }, { value: "8192", label: "8 GB (more than this server has)" }]);
      expect(s.cpuOptions.map((o: { value: string }) => o.value)).toEqual(["0.5", "1"]);
    });
  });

  it("saves a limit, turns scanning off, and answers 501 storing nothing for what runs on the server", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      const settings = () => query(db, "SELECT is_image_scan_enabled, image_scan_memory_mb, image_scan_syft_timeout, image_scan_cpus::text AS cpus FROM server_settings WHERE server_id = 1");
      const bad = await c.server("PATCH", { action: "limit", property: "scannerSyftTimeout", value: "700" });
      expect([bad.status, bad.body.error!.message, bad.body.error!.details!.fields]).toEqual([422, "Choose one of the listed values. Values that are more than this server has are not allowed.", { scannerSyftTimeout: ["Choose one of the listed values. Values that are more than this server has are not allowed."] }]);
      expect(toastsOf(await c.server("PATCH", { action: "limit", property: "scannerSyftTimeout", value: "1200" }))).toEqual([{ type: "success", message: "Syft time limit saved. It applies to the next scan." }]);
      expect(toastsOf(await c.server("PATCH", { action: "limit", property: "scannerCpus", value: "0.5" }))).toEqual([{ type: "success", message: "Scanner CPU limit saved. It applies to the next scan." }]);
      expect(await settings()).toEqual([{ is_image_scan_enabled: false, image_scan_memory_mb: 1024, image_scan_syft_timeout: 1200, cpus: "0.50" }]);
      const before = JSON.stringify(await settings());
      // Turning it on gets the scanner (PrepareImageScannerJob over SSH): 501, the switch not stored.
      const enable = await c.server("PATCH", { action: "enable" });
      expect([enable.status, enable.body.error!.message]).toEqual([501, "Preparing the image scanner on the server needs the SSH executor, which is not available yet."]);
      expect(toastsOf(await c.server("PATCH", { action: "prepareScanner" }))).toEqual([{ type: "error", message: "Turn on image scanning first." }]);
      const remove = await c.server("PATCH", { action: "deleteScannerData" });
      expect([remove.status, remove.body.error!.message]).toEqual([501, "Deleting the scanner data on the server needs the SSH executor, which is not available yet."]);
      expect(JSON.stringify(await settings())).toBe(before);
      await query(db, "UPDATE server_settings SET is_image_scan_enabled = true WHERE server_id = 1");
      expect((await c.server("PATCH", { action: "prepareScanner" })).status).toBe(501);
      expect(toastsOf(await c.server("PATCH", { action: "disable" }))).toEqual([{ type: "success", message: "Image scanning turned off." }]);
      expect((await settings())[0]).toMatchObject({ is_image_scan_enabled: false });
      expect((await c.server("PATCH", { action: "limit", property: "nope", value: "1" })).status).toBe(404);
    });
  });

  it("refuses what changes a server another instance manages, with Coolify's messages", async () => {
    await fixture.inCase(async (db) => {
      await query(db, `UPDATE servers SET server_metadata = '{"transfer": {"status": "transferred"}}' WHERE id = 1`);
      const c = client(db);
      expect(toastsOf(await c.server("PATCH", { action: "enable" }))).toEqual([{ type: "error", message: "This server is managed by another Coolify instance." }]);
      expect(toastsOf(await c.server("PATCH", { action: "deleteScannerData" }))).toEqual([{ type: "error", message: "Could not delete the scanner data. This server is managed by another Coolify instance." }]);
      expect(toastsOf(await c.server("PATCH", { action: "limit", property: "scannerGrypeTimeout", value: "300" }))).toEqual([{ type: "error", message: "This server is managed by another Coolify instance." }]);
      expect(toastsOf(await c.server("PATCH", { action: "scanHostPackages" }))).toEqual([{ type: "error", message: "This server is managed by another Coolify instance." }]);
      expect(await query(db, "SELECT image_scan_grype_timeout FROM server_settings WHERE server_id = 1")).toEqual([{ image_scan_grype_timeout: 600 }]);
    });
  });

  it("shows the stored host scan: the running kernel's findings, the other kernels, the notes, search, sort and pages", async () => {
    await fixture.inCase(async (db) => {
      await hostScan(db);
      const c = client(db);
      const h = (await c.server()).body.data!.host;
      expect(h).toMatchObject({
        hostScanAvailable: true,
        hasResult: true,
        rebootRequired: true,
        packageManager: "apt",
        runningKernel: "6.8.0-139-generic",
        bootKernel: "6.8.0-140-generic",
        kernelStatusCounts: { fixed_after_reboot: 1 },
        otherKernelCount: 1,
        hasOldKernels: true,
        hostFindingsCount: 3,
        shownCount: 3,
        hostScan: { findingsTruncated: false, scannedAt: { ago: "12 hours ago", title: "2025-12-31 12:00:00" }, error: null, eol: null },
      });
      const [openssl, kernel] = h.items.items;
      expect(openssl).toMatchObject({ displayId: "CVE-2025-2001", signal: "exploited", updates: [{ package: "openssl", newVersion: "3.0.13" }], isOwnUpdate: true, riskLabels: [], kev: true, advisoryUrl: "https://nvd.nist.gov/vuln/detail/CVE-2025-2001", summary: "A buffer overflow." });
      expect(kernel).toMatchObject({ kernelStatus: "fixed_after_reboot", isOtherKernel: false, updates: [{ package: "linux-image-6.8.0-140-generic" }], isOwnUpdate: false, riskLabels: ["Needs a reboot to apply"], aliases: ["GHSA-aaaa-bbbb-cccc"], likelihood: "low" });
      const other = (await c.server("GET", undefined, "?showOtherKernels=1")).body.data!.host;
      expect(other.items.items.map((f: { displayId: string }) => f.displayId)).toEqual(["CVE-2025-2001", "CVE-2025-2002", "CVE-2025-2004", "CVE-2025-2003"]);
      expect(other.items.items[3]).toMatchObject({ isOtherKernel: true, isOldKernel: true, updates: [] });
      const sorted = (await c.server("GET", undefined, "?sortBy=fixed_desc")).body.data!.host.items.items.map((f: { displayId: string }) => f.displayId);
      expect(sorted).toEqual(["CVE-2025-2002", "CVE-2025-2001", "CVE-2025-2004"]);
      expect((await c.server("GET", undefined, "?search=%20GHSA-AAAA")).body.data!.host.items.items.map((f: { displayId: string }) => f.displayId)).toEqual(["CVE-2025-2002"]);
      const paged = (await c.server("GET", undefined, "?perPage=2&page=7")).body.data!.host.items;
      expect([paged.currentPage, paged.lastPage, paged.firstItem, paged.total]).toEqual([2, 2, 3, 3]);
    });
  });

  it("exports the shown host findings with the ID the page shows", async () => {
    await fixture.inCase(async (db) => {
      await hostScan(db);
      const c = client(db);
      const ids = await c.server("GET", undefined, "?format=ids", SERVER, ["export"]);
      expect(ids.body.data!.content).toBe("CVE-2025-2001\nCVE-2025-2002\nCVE-2025-2004\n");
      const md = await c.server("GET", undefined, "?format=markdown&search=openssl", SERVER, ["export"]);
      expect(md.body.data!.content.split("\n")[0]).toBe("**Vulnerabilities of the server parity-server (1 finding)**");
      const csv = await c.server("GET", undefined, "?format=csv", SERVER, ["export"]);
      expect([csv.body.data!.filename, csv.body.data!.contentType]).toEqual(["parity-server-host-vulnerabilities-2026-01-01.csv", "text/csv; charset=UTF-8"]);
      const doc = JSON.parse((await c.server("GET", undefined, "?format=json", SERVER, ["export"])).body.data!.content) as { resource: unknown; count: number };
      expect([doc.resource, doc.count]).toEqual([{ type: "server", name: "parity-server", uuid: SERVER }, 3]);
      expect((await c.server("GET", undefined, "?format=xml", SERVER, ["export"])).status).toBe(404);
    });
  });

  it("runs Coolify's checks before a host scan, a package update and a reboot, then 501, storing nothing", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      expect(toastsOf(await c.server("PATCH", { action: "scanHostPackages" }))).toEqual([{ type: "error", message: "Turn on image scanning for this server first." }]);
      await hostScan(db);
      const scan = await c.server("PATCH", { action: "scanHostPackages" });
      expect([scan.status, scan.body.error!.message]).toEqual([501, "Scanning the packages of the server needs the SSH executor, which is not available yet."]);
      expect(toastsOf(await c.server("PATCH", { action: "updateVulnerablePackage", package: "zlib1g" }))).toEqual([{ type: "error", message: 'This package has no update in the last check. Run "Check for updates" on the Patching page.' }]);
      expect(toastsOf(await c.server("PATCH", { action: "updateVulnerablePackage", package: "curl" }))).toEqual([{ type: "error", message: 'This package has no update in the last check. Run "Check for updates" on the Patching page.' }]);
      const update = await c.server("PATCH", { action: "updateVulnerablePackage", package: "openssl" });
      expect([update.status, update.body.error!.message]).toEqual([501, "Updating the packages of the server needs the SSH executor, which is not available yet."]);
      const reboot = await c.server("PATCH", { action: "rebootServer" });
      expect([reboot.status, reboot.body.error!.message]).toEqual([501, "Rebooting the server needs the SSH executor, which is not available yet."]);
      expect((await c.server("PATCH", { action: "removeUnusedPackages" })).status).toBe(501);
      expect(await query(db, "SELECT count(*)::int AS n FROM server_host_scans")).toEqual([{ n: 1 }]);
    });
  });

  it("is viewSecurity's: without write a 404 that runs nothing; another org's server is not found", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db, { write: false });
      for (const r of [await c.server(), await c.server("PATCH", { action: "disable" }), await c.server("GET", undefined, "?format=ids", SERVER, ["export"])]) expect(r.status).toBe(404);
      expect(c.ran()).toBe(0);
      const other = client(db);
      expect((await other.server("GET", undefined, "", OTHER_SERVER)).status).toBe(404);
      expect((await other.server("PATCH", { action: "disable" }, "", OTHER_SERVER)).status).toBe(404);
      await other.server("PATCH", { action: "saveRule", column: "gate_mode", value: "strict" });
      expect(await policies(db, ORG2)).toEqual([]);
    });
  });
});
