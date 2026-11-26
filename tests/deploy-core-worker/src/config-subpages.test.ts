// The configuration sub-pages of DP-102 through the handler, over the API fixture's application and service in
// Freeploy's database (PGlite with every deploy migration, row-level security on): an application's and a service's
// Maintenance Mode (Maintenance's rules, messages and toasts, the proxy support check, what writes the proxy's files
// on a functional server answered as not available yet with nothing stored), an application's Swarm page (Swarm's
// rules and message, the base64 constraints, the page only for a Swarm server), a service's Domains page (Domains'
// rules, messages and toasts, the conflict and port dialogs, the www redirect pairs, the DNS checks, the Compose file
// parsed again), who may change them (a denial is a 404 that runs nothing) and one org never reaching another's.
// The Worker's own module order (the router first), as its import cycle needs.
import "@deploy-core-worker/router";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { withOrg } from "@saas/db/deploy";
import type { Env } from "@deploy-core-worker/env";
import { handleConfigSubpages, isConfigSubpageRoute, type ConfigSubpageKind, type ConfigSubpagesRunner } from "@deploy-core-worker/handlers/config-subpages";
import { base64Decode, base64Encode, maintenanceSupported, validateMaintenancePage, validateSwarm } from "@deploy-core-worker/applications/config-subpages";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";

const ORG1 = ORG_UUID[1]!;
const ORG2 = ORG_UUID[2]!;
const APP = "a1parityimageapp00000001";
const OTHER_APP = "a3otherteamapp0000000003";
const SERVICE = "f1parityservice000000001";
const OTHER_SERVICE = "f2otherservice0000000002";
const WEB = "g1paritywebapplication01";
const SERVER = "s1parityserveruuid000001";
const actor = { subjectId: "usr_1", subjectType: "user" };
const UNAVAILABLE = "Applying the maintenance page on the server needs the SSH executor, which is not available yet.";

let fixture: FixtureDatabase;
beforeAll(async () => {
  fixture = await fixtureDatabase();
}, 120_000);
afterAll(async () => fixture?.pg.close());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

type Body = { data?: Record<string, unknown>; error?: { code: string; message: string; details?: { fields?: Record<string, string[]>; conflicts?: unknown[]; requiredPort?: number; requestedPort?: number } } };

function client(db: TransactionalSqlExecutor, allow: { read?: boolean; write?: boolean } = {}) {
  let ran = 0;
  const env: Env = {
    ENVIRONMENT: "test",
    DEPLOY_ENCRYPTION_KEY: TEST_KEK,
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      const ok = body.action === "deploy.resource.write" ? (allow.write ?? true) : (allow.read ?? true);
      return json({ data: { decision: ok ? "allow" : "deny", allow: ok } });
    }),
  };
  const runner: ConfigSubpagesRunner = (_env, orgId, fn) => ((ran += 1), withOrg(db, orgId, fn));
  const call = async (kind: ConfigSubpageKind, uuid: string, page: string, method = "GET", body?: unknown, org = ORG1) => {
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleConfigSubpages(env, "req_1", actor, org, kind, [uuid, page], new Request(`https://x/${uuid}/${page}`, init), runner);
    return { status: res.status, body: (await res.json()) as Body };
  };
  return { call, ran: () => ran };
}

const sql = <T extends Record<string, unknown>>(db: TransactionalSqlExecutor, text: string, params: unknown[] = [], org = ORG1) => withOrg(db, org, async (tx) => (await tx.execute<T>(text, params)).rows);
const appRow = (db: TransactionalSqlExecutor) =>
  sql<{ is_maintenance_enabled: boolean; maintenance_page: string | null; swarm_replicas: number; swarm_placement_constraints: string | null; is_swarm_only_worker_nodes: boolean }>(
    db,
    "SELECT a.is_maintenance_enabled, a.maintenance_page, a.swarm_replicas, a.swarm_placement_constraints, st.is_swarm_only_worker_nodes FROM deploy.applications a JOIN deploy.application_settings st ON st.application_id = a.id WHERE a.uuid = $1",
    [APP],
  ).then((r) => r[0]!);
const serviceRow = (db: TransactionalSqlExecutor) => sql<{ is_maintenance_enabled: boolean; maintenance_page: string | null }>(db, "SELECT is_maintenance_enabled, maintenance_page FROM deploy.services WHERE uuid = $1", [SERVICE]).then((r) => r[0]!);
const webRow = (db: TransactionalSqlExecutor) =>
  sql<{ fqdn: string | null; redirect: string; noindex_domains: unknown; domain_port_overrides: unknown; domain_dns_statuses: unknown; is_force_https_enabled: boolean; is_permanent_redirect_enabled: boolean }>(
    db,
    "SELECT fqdn, redirect, noindex_domains, domain_port_overrides, domain_dns_statuses, is_force_https_enabled, is_permanent_redirect_enabled FROM deploy.service_applications WHERE uuid = $1",
    [WEB],
  ).then((r) => r[0]!);
const setProxy = (db: TransactionalSqlExecutor, type: string) => sql(db, "UPDATE deploy.servers SET proxy = $2::json WHERE uuid = $1", [SERVER, JSON.stringify({ type, redirect_enabled: true })]);
const makeFunctional = (db: TransactionalSqlExecutor) => sql(db, "UPDATE deploy.server_settings SET is_reachable = true, is_usable = true, force_disabled = false WHERE server_id = (SELECT id FROM deploy.servers WHERE uuid = $1)", [SERVER]);
const makeSwarm = (db: TransactionalSqlExecutor) => sql(db, "UPDATE deploy.server_settings SET is_swarm_manager = true WHERE server_id = (SELECT id FROM deploy.servers WHERE uuid = $1)", [SERVER]);
const toastsOf = (r: { body: Body }) => r.body.data!.toasts as Array<{ type: string; message: string }>;

describe("routing", () => {
  it("serves an application's maintenance and swarm and a service's maintenance and domains, nothing else", () => {
    expect([isConfigSubpageRoute("application", [APP, "maintenance"]), isConfigSubpageRoute("application", [APP, "swarm"]), isConfigSubpageRoute("application", [APP, "domains"])]).toEqual([true, true, false]);
    expect([isConfigSubpageRoute("service", [SERVICE, "maintenance"]), isConfigSubpageRoute("service", [SERVICE, "domains"]), isConfigSubpageRoute("service", [SERVICE, "swarm"]), isConfigSubpageRoute("service", [SERVICE, "domains", "x"])]).toEqual([true, true, false, false]);
  });

  it("answers another method with 405 and an unknown action with Laravel's message", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      expect((await c.call("application", APP, "maintenance", "POST", {})).status).toBe(405);
      const r = await c.call("service", SERVICE, "domains", "PATCH", { action: "nope" });
      expect([r.status, r.body.error!.details!.fields]).toEqual([422, { action: ["The selected action is invalid."] }]);
    });
  });
});

describe("Maintenance mode", () => {
  it("is supported only with a Traefik or Caddy proxy on a server that is not a Swarm one", async () => {
    const server = { id: 1, ip: "203.0.113.10", is_swarm_manager: false, is_swarm_worker: false, is_reachable: false, is_usable: false, force_disabled: false, public_ipv4: null, public_ipv6: null };
    expect([maintenanceSupported([{ ...server, proxy: { type: "TRAEFIK" } }]), maintenanceSupported([{ ...server, proxy: '{"type":"CADDY"}' }]), maintenanceSupported([{ ...server, proxy: { type: "NONE" } }])]).toEqual([true, true, false]);
    expect(maintenanceSupported([{ ...server, proxy: { type: "TRAEFIK" }, is_swarm_worker: true }])).toBe(false);
    await fixture.inCase(async (db) => {
      const c = client(db);
      const before = await c.call("application", APP, "maintenance");
      expect(before.body.data).toMatchObject({ application: { uuid: APP }, canUpdate: true, maintenance: { isMaintenanceEnabled: false, maintenancePage: null, isSupported: false, maxKilobytes: 1024 } });
      await setProxy(db, "TRAEFIK");
      expect((await c.call("application", APP, "maintenance")).body.data!.maintenance).toMatchObject({ isSupported: true });
      expect((await c.call("service", SERVICE, "maintenance")).body.data).toMatchObject({ service: { uuid: SERVICE }, canUpdate: true, maintenance: { isSupported: true } });
      await makeSwarm(db);
      expect((await c.call("application", APP, "maintenance")).body.data!.maintenance).toMatchObject({ isSupported: false });
    });
  });

  it("toggles, saves and resets the page with Coolify's messages while no functional server would be written", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      for (const [kind, uuid, row] of [["application", APP, appRow], ["service", SERVICE, serviceRow]] as const) {
        const on = await c.call(kind, uuid, "maintenance", "PATCH", { action: "toggle" });
        expect(on.body.data).toMatchObject({ message: "Maintenance mode enabled.", maintenance: { isMaintenanceEnabled: true } });
        expect((await c.call(kind, uuid, "maintenance", "PATCH", { action: "save", maintenancePage: "<h1>Back soon</h1>" })).body.data!.message).toBe("Maintenance page saved.");
        expect(await row(db)).toMatchObject({ is_maintenance_enabled: true, maintenance_page: "<h1>Back soon</h1>" });
        expect((await c.call(kind, uuid, "maintenance", "PATCH", { action: "reset" })).body.data!.message).toBe("Default maintenance page restored.");
        expect((await row(db)).maintenance_page).toBeNull();
        // filled(): a blank page is no custom page.
        await c.call(kind, uuid, "maintenance", "PATCH", { action: "save", maintenancePage: "   " });
        expect((await row(db)).maintenance_page).toBeNull();
        expect((await c.call(kind, uuid, "maintenance", "PATCH", { action: "toggle" })).body.data!.message).toBe("Maintenance mode disabled.");
        expect((await row(db)).is_maintenance_enabled).toBe(false);
      }
    });
  });

  it("holds the page to its rules", async () => {
    expect(validateMaintenancePage(null)).toEqual({ ok: true, page: null });
    expect(validateMaintenancePage(5)).toEqual({ ok: false, errors: { maintenancePage: ["The maintenance page field must be a string."] } });
    // strlen(): bytes, not characters.
    expect(validateMaintenancePage("é".repeat(524289))).toEqual({ ok: false, errors: { maintenancePage: ["The maintenance page must not be larger than 1024 KB."] } });
    expect(validateMaintenancePage("x".repeat(1048576))).toMatchObject({ ok: true });
    await fixture.inCase(async (db) => {
      const r = await client(db).call("application", APP, "maintenance", "PATCH", { action: "save", maintenancePage: ["<p>"] });
      expect([r.status, r.body.error!.details!.fields]).toEqual([422, { maintenancePage: ["The maintenance page field must be a string."] }]);
      expect((await appRow(db)).maintenance_page).toBeNull();
    });
  });

  it("answers 501 and stores nothing where Coolify would write the proxy's files on a functional server", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      await makeFunctional(db);
      for (const [kind, uuid, row] of [["application", APP, appRow], ["service", SERVICE, serviceRow]] as const) {
        const toggled = await c.call(kind, uuid, "maintenance", "PATCH", { action: "toggle" });
        expect([toggled.status, toggled.body.error!.code, toggled.body.error!.message]).toEqual([501, "unsupported", UNAVAILABLE]);
        expect((await row(db)).is_maintenance_enabled).toBe(false);
        // Off, saving the page writes nothing on the server: it is stored.
        expect((await c.call(kind, uuid, "maintenance", "PATCH", { action: "save", maintenancePage: "<p>Off</p>" })).body.data!.message).toBe("Maintenance page saved.");
        await sql(db, `UPDATE deploy.${kind === "application" ? "applications" : "services"} SET is_maintenance_enabled = true WHERE uuid = $1`, [uuid]);
        // The rules come first, then the server.
        expect((await c.call(kind, uuid, "maintenance", "PATCH", { action: "save", maintenancePage: 1 })).status).toBe(422);
        for (const body of [{ action: "save", maintenancePage: "<p>On</p>" }, { action: "reset" }]) {
          const r = await c.call(kind, uuid, "maintenance", "PATCH", body);
          expect([r.status, r.body.error!.message]).toEqual([501, UNAVAILABLE]);
        }
        expect((await row(db)).maintenance_page).toBe("<p>Off</p>");
      }
    });
  });
});

describe("Swarm", () => {
  it("is the page of an application on a Swarm server only", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      expect((await c.call("application", APP, "swarm")).body.data).toMatchObject({ application: { uuid: APP }, isSwarm: false, swarm: null });
      const r = await c.call("application", APP, "swarm", "PATCH", { swarmReplicas: 3, isSwarmOnlyWorkerNodes: false });
      expect(r.status).toBe(404);
      expect((await appRow(db)).swarm_replicas).toBe(1);
      await makeSwarm(db);
      expect((await c.call("application", APP, "swarm")).body.data).toMatchObject({ isSwarm: true, swarm: { swarmReplicas: 1, swarmPlacementConstraints: null, isSwarmOnlyWorkerNodes: true } });
    });
  });

  it("holds the form to Swarm's rules and stores the constraints base64-encoded", async () => {
    expect(validateSwarm({})).toEqual({ ok: false, errors: { swarmReplicas: ["The swarm replicas field is required."], isSwarmOnlyWorkerNodes: ["The is swarm only worker nodes field is required."] } });
    expect(validateSwarm({ swarmReplicas: "two", swarmPlacementConstraints: 5, isSwarmOnlyWorkerNodes: "maybe" })).toEqual({
      ok: false,
      errors: { swarmReplicas: ["The swarm replicas field must be an integer."], swarmPlacementConstraints: ["The swarm placement constraints field must be a string."], isSwarmOnlyWorkerNodes: ["The is swarm only worker nodes field must be true or false."] },
    });
    // PHP's truthiness: "" and "0" store null.
    expect(validateSwarm({ swarmReplicas: "4", swarmPlacementConstraints: "0", isSwarmOnlyWorkerNodes: "false" })).toEqual({ ok: true, swarmReplicas: 4, swarmPlacementConstraints: null, isSwarmOnlyWorkerNodes: false });
    expect(base64Decode(base64Encode("node.labels.région == eu"))).toBe("node.labels.région == eu");
    expect(base64Encode("placement:")).toBe("cGxhY2VtZW50Og==");
    await fixture.inCase(async (db) => {
      const c = client(db);
      await makeSwarm(db);
      const bad = await c.call("application", APP, "swarm", "PATCH", { swarmReplicas: "", isSwarmOnlyWorkerNodes: true });
      expect([bad.status, bad.body.error!.details!.fields]).toEqual([422, { swarmReplicas: ["The swarm replicas field is required."] }]);
      const constraints = "placement:\n    constraints:\n        - 'node.role == worker'";
      const ok = await c.call("application", APP, "swarm", "PATCH", { swarmReplicas: 3, swarmPlacementConstraints: constraints, isSwarmOnlyWorkerNodes: false });
      expect(ok.body.data).toEqual({ message: "Swarm settings updated.", swarm: { swarmReplicas: 3, swarmPlacementConstraints: constraints, isSwarmOnlyWorkerNodes: false } });
      expect(await appRow(db)).toMatchObject({ swarm_replicas: 3, swarm_placement_constraints: base64Encode(constraints), is_swarm_only_worker_nodes: false });
      await c.call("application", APP, "swarm", "PATCH", { swarmReplicas: 3, swarmPlacementConstraints: "", isSwarmOnlyWorkerNodes: true });
      expect(await appRow(db)).toMatchObject({ swarm_placement_constraints: null, is_swarm_only_worker_nodes: true });
    });
  });
});

describe("a service's Domains", () => {
  it("lists every application's domains with its group, redirects and DNS status", async () => {
    await fixture.inCase(async (db) => {
      const r = await client(db).call("service", SERVICE, "domains");
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ service: { uuid: SERVICE }, canUpdate: true });
      const domains = r.body.data!.domains as Record<string, unknown>;
      expect(domains.apps).toEqual([{ uuid: WEB, name: "web", heading: "Web", image: "nginx:alpine", requiredPort: null, redirect: "both", isForceHttpsEnabled: true, isPermanentRedirectEnabled: false }]);
      expect(domains.rows).toEqual([
        {
          serviceApplicationUuid: WEB, serviceName: "web", url: "https://web.example.com", publicUrl: "https://web.example.com", internalPort: null, hasPortOverride: false,
          dnsStatus: "pending", dnsMessage: "Not checked yet.", expectedIp: "203.0.113.10", checkedAt: null, isNoindexed: false, parts: { scheme: "https", host: "web.example.com", port: "", path: "" },
        },
      ]);
      expect(domains).toMatchObject({ dnsValidationEnabled: true, serverIp: "203.0.113.10", dnsTargetLabel: "203.0.113.10" });
    });
  });

  it("adds a domain with Coolify's rules and toasts, stores its DNS check as not started and parses the Compose file again", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      const add = (body: Record<string, unknown>) => c.call("service", SERVICE, "domains", "PATCH", { action: "add", serviceApplicationUuid: WEB, ...body });
      expect((await add({ newDomainParts: { scheme: "https", host: "bad host", port: "", path: "" } })).body.error!.details!.fields!.newDomain).toBeDefined();
      expect((await add({ serviceApplicationUuid: "nope", newDomain: "https://shop.example.com" })).body.error!.message).toBe("Select a service application.");
      expect((await add({ newDomain: "https://web.example.com:8080" })).body.error!.details!.fields).toEqual({ newDomain: ["Domain https://web.example.com:8080 is already configured for this service."] });
      const before = (await sql<{ docker_compose: string }>(db, "SELECT docker_compose FROM deploy.services WHERE uuid = $1", [SERVICE]))[0]!.docker_compose;
      const r = await add({ newDomainParts: { scheme: "https", host: "shop.example.com", port: "", path: "" } });
      expect(toastsOf(r)).toEqual([
        { type: "warning", message: "Some services do not support multiple domains, which can lead to problems and is NOT RECOMMENDED.<br><br>Only use multiple domains if you know what you are doing." },
        { type: "error", message: "Some DNS checks could not be started. Try again from the Domains page." },
        { type: "success", message: "Domain added." },
      ]);
      const row = await webRow(db);
      expect(row.fqdn).toBe("https://web.example.com,https://shop.example.com");
      expect(row.domain_dns_statuses).toMatchObject({ "https://shop.example.com": { status: "skipped", message: "DNS check could not be started.", expected_ip: "203.0.113.10" } });
      const rows = (r.body.data!.domains as { rows: Array<{ url: string; dnsStatus: string }> }).rows;
      expect(rows.map((x) => [x.url, x.dnsStatus])).toEqual([["https://web.example.com", "pending"], ["https://shop.example.com", "skipped"]]);
      // Service::parse(): the generated Compose file now routes the new domain.
      const after = (await sql<{ docker_compose: string }>(db, "SELECT docker_compose FROM deploy.services WHERE uuid = $1", [SERVICE]))[0]!.docker_compose;
      expect(after).not.toBe(before);
      expect(after).toContain("shop.example.com");
    });
  });

  it("asks before using a domain another resource uses, and stores it when told to", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      const body = { action: "add", serviceApplicationUuid: WEB, newDomain: "https://image.example.com" };
      const r = await c.call("service", SERVICE, "domains", "PATCH", body);
      expect([r.status, r.body.error!.message]).toEqual([409, "Domains are already in use by other resources."]);
      expect(r.body.error!.details!.conflicts).toEqual([expect.objectContaining({ domain: "https://image.example.com", resource_name: "parity-image" })]);
      expect((await webRow(db)).fqdn).toBe("https://web.example.com");
      expect(toastsOf(await c.call("service", SERVICE, "domains", "PATCH", { ...body, forceSaveDomains: true })).at(-1)).toEqual({ type: "success", message: "Domain added." });
      expect((await webRow(db)).fqdn).toBe("https://web.example.com,https://image.example.com");
    });
  });

  it("asks before a port the service does not require, and keeps it as the domain's override", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      // A Compose service that declares SERVICE_URL_WEB_80: its required port is 80.
      const raw = "services:\n  web:\n    image: 'nginx:alpine'\n    environment:\n      - SERVICE_URL_WEB_80\n";
      await sql(db, "UPDATE deploy.services SET docker_compose_raw = $2 WHERE uuid = $1", [SERVICE, raw]);
      expect(((await c.call("service", SERVICE, "domains")).body.data!.domains as { apps: Array<{ requiredPort: number }> }).apps[0]!.requiredPort).toBe(80);
      const body = { action: "add", serviceApplicationUuid: WEB, newDomainParts: { scheme: "https", host: "shop.example.com", port: "3000", path: "" } };
      const r = await c.call("service", SERVICE, "domains", "PATCH", body);
      expect([r.status, r.body.error!.details!.requiredPort, r.body.error!.details!.requestedPort]).toEqual([409, 80, 3000]);
      expect((await webRow(db)).fqdn).toBe("https://web.example.com");
      await c.call("service", SERVICE, "domains", "PATCH", { ...body, forceRemovePort: true });
      const row = await webRow(db);
      expect(row.fqdn).toContain("https://shop.example.com");
      expect(row.domain_port_overrides).toMatchObject({ "https://shop.example.com": 3000 });
    });
  });

  it("edits a domain's address and indexing, removes one, and keeps the DNS statuses to the domains it has", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      const patch = (body: Record<string, unknown>) => c.call("service", SERVICE, "domains", "PATCH", { serviceApplicationUuid: WEB, ...body });
      await patch({ action: "add", newDomain: "https://shop.example.com" });
      expect((await patch({ action: "update", url: "https://nope.example.com", editingDomain: "https://x.example.com" })).status).toBe(404);
      expect((await patch({ action: "update", url: "https://shop.example.com", editingDomain: "https://web.example.com" })).body.error!.details!.fields).toEqual({ editingDomain: ["Domain https://web.example.com is already configured for this service."] });
      expect((await patch({ action: "update", url: "https://shop.example.com", editingDomain: "https://a.example.com,https://b.example.com" })).body.error!.details!.fields).toEqual({ editingDomain: ["Please enter a single valid domain URL."] });
      expect((await patch({ action: "update", url: "https://shop.example.com", editingDomain: "https://store.example.com", editingIndexing: "maybe" })).body.error!.details!.fields).toEqual({ editingIndexing: ["The selected editing indexing is invalid."] });
      const r = await patch({ action: "update", url: "https://shop.example.com", editingDomainParts: { scheme: "https", host: "store.example.com", port: "", path: "" }, editingIndexing: "noindex", editingRedirect: "both" });
      expect(toastsOf(r)).toContainEqual({ type: "success", message: "Domain updated." });
      expect(toastsOf(r)).toContainEqual({ type: "error", message: "The DNS check could not be started. Try again from the Domains page." });
      let row = await webRow(db);
      expect([row.fqdn, row.noindex_domains]).toEqual(["https://web.example.com,https://store.example.com", ["https://store.example.com"]]);
      expect(Object.keys(row.domain_dns_statuses as object)).toEqual(["https://store.example.com"]);
      const removed = await patch({ action: "remove", url: "https://store.example.com" });
      expect(toastsOf(removed)).toEqual([{ type: "success", message: "Domain removed." }]);
      row = await webRow(db);
      expect([row.fqdn, row.noindex_domains, row.domain_dns_statuses]).toEqual(["https://web.example.com", [], null]);
    });
  });

  it("sets the www redirect with its pair, and the two switches, with Coolify's messages", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      const patch = (body: Record<string, unknown>) => c.call("service", SERVICE, "domains", "PATCH", { serviceApplicationUuid: WEB, ...body });
      expect((await patch({ action: "redirect", redirect: "sideways" })).body.error!.details!.fields).toEqual({ "serviceRedirects.1": ["The selected service redirects.1 is invalid."] });
      expect((await patch({ action: "redirect", redirect: "www", serviceApplicationUuid: "nope" })).body.error!.message).toBe("Service application not found.");
      const r = await patch({ action: "redirect", redirect: "www" });
      expect(toastsOf(r).map((t) => t.message)).toContain("Redirect updated.");
      let row = await webRow(db);
      expect([row.fqdn, row.redirect]).toEqual(["https://web.example.com,https://www.web.example.com", "www"]);
      // A redirect needs both hosts: an IP has no www counterpart.
      await sql(db, "UPDATE deploy.service_applications SET fqdn = 'http://203.0.113.10', redirect = 'both' WHERE uuid = $1", [WEB]);
      const refused = await patch({ action: "redirect", redirect: "non-www" });
      expect(refused.body.error!.message).toBe("Redirect requires both www and non-www domains, but the www host could not be added automatically (e.g. only IP/sslip hosts).\n\nPlease add the www domain manually (Required DNS record type A pointing to 203.0.113.10).");
      expect((await webRow(db)).redirect).toBe("both");
      expect(toastsOf(await patch({ action: "forceHttps", enabled: false }))).toEqual([{ type: "success", message: "HTTP to HTTPS redirect updated." }]);
      expect(toastsOf(await patch({ action: "permanentRedirect", enabled: true }))).toEqual([{ type: "success", message: "Redirect type updated." }]);
      expect((await patch({ action: "forceHttps", enabled: "no" })).body.error!.details!.fields).toEqual({ "forceHttpsRedirects.1": ["The force https redirects.1 field must be true or false."] });
      row = await webRow(db);
      expect([row.is_force_https_enabled, row.is_permanent_redirect_enabled]).toEqual([false, true]);
    });
  });

  it("generates a domain and a hostname without storing them, and checks DNS as a check that could not be started", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      const generated = await c.call("service", SERVICE, "domains", "PATCH", { action: "generate", serviceApplicationUuid: WEB });
      expect(generated.body.data!.domain).toMatch(/^http:\/\/[a-z0-9]{24}\.203\.0\.113\.10\.sslip\.io$/);
      expect(generated.body.data!.parts).toMatchObject({ scheme: "http", port: "", path: "" });
      expect((await c.call("service", SERVICE, "domains", "PATCH", { action: "generate", serviceApplicationUuid: "nope" })).body.error!.message).toBe("Service application or server not found.");
      expect((await c.call("service", SERVICE, "domains", "PATCH", { action: "regenerateHostname" })).body.data!.host).toMatch(/\.sslip\.io$/);
      expect((await webRow(db)).fqdn).toBe("https://web.example.com");
      const checked = await c.call("service", SERVICE, "domains", "PATCH", { action: "checkDns", serviceApplicationUuid: WEB, url: "https://web.example.com" });
      expect(toastsOf(checked)).toEqual([{ type: "error", message: "The DNS check could not be started. Try again from the Domains page." }]);
      expect((await webRow(db)).domain_dns_statuses).toMatchObject({ "https://web.example.com": { status: "skipped", message: "DNS check could not be started." } });
      expect((await c.call("service", SERVICE, "domains", "PATCH", { action: "checkDns" })).status).toBe(200);
    });
  });
});

describe("authorization and org isolation", () => {
  it("answers a denied read or write with 404 and runs nothing", async () => {
    await fixture.inCase(async (db) => {
      const reader = client(db, { read: false, write: false });
      for (const [kind, uuid, page] of [["application", APP, "maintenance"], ["application", APP, "swarm"], ["service", SERVICE, "maintenance"], ["service", SERVICE, "domains"]] as const) {
        expect((await reader.call(kind, uuid, page)).status).toBe(404);
      }
      const member = client(db, { write: false });
      expect((await member.call("application", APP, "maintenance")).body.data).toMatchObject({ canUpdate: false });
      for (const [kind, uuid, page, body] of [
        ["application", APP, "maintenance", { action: "toggle" }],
        ["application", APP, "swarm", { swarmReplicas: 2, isSwarmOnlyWorkerNodes: true }],
        ["service", SERVICE, "maintenance", { action: "toggle" }],
        ["service", SERVICE, "domains", { action: "remove", serviceApplicationUuid: WEB, url: "https://web.example.com" }],
      ] as const) {
        expect((await member.call(kind, uuid, page, "PATCH", body)).status).toBe(404);
      }
      expect(reader.ran() + member.ran()).toBe(1);
      expect((await appRow(db)).is_maintenance_enabled).toBe(false);
      expect((await serviceRow(db)).is_maintenance_enabled).toBe(false);
      expect((await webRow(db)).fqdn).toBe("https://web.example.com");
    });
  });

  it("never reaches another org's application or service", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      for (const [kind, uuid, page] of [["application", APP, "maintenance"], ["application", APP, "swarm"], ["service", SERVICE, "maintenance"], ["service", SERVICE, "domains"]] as const) {
        expect((await c.call(kind, uuid, page, "GET", undefined, ORG2)).status).toBe(404);
      }
      expect((await c.call("application", APP, "maintenance", "PATCH", { action: "toggle" }, ORG2)).status).toBe(404);
      expect((await c.call("service", SERVICE, "domains", "PATCH", { action: "remove", serviceApplicationUuid: WEB, url: "https://web.example.com" }, ORG2)).status).toBe(404);
      expect((await appRow(db)).is_maintenance_enabled).toBe(false);
      expect((await webRow(db)).fqdn).toBe("https://web.example.com");
      // Org 2's own resources are its own.
      expect((await c.call("application", OTHER_APP, "maintenance", "GET", undefined, ORG2)).status).toBe(200);
      expect((await c.call("service", OTHER_SERVICE, "domains", "GET", undefined, ORG2)).body.data).toMatchObject({ domains: { rows: [] } });
      expect((await c.call("application", OTHER_APP, "maintenance")).status).toBe(404);
    });
  });
});
