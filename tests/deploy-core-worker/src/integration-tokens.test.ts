// Keys & Tokens → Integration Tokens (DP-104): IntegrationTokens, IntegrationTokenForm and IntegrationTokenEditor's rules
// and messages (Laravel's own, as Livewire's validate() gives them, and the components' messages()), the toasts, what each
// provider is asked (through a fake fetch: no test touches the network), the token stored encrypted and never returned,
// the zones of a Cloudflare token, deletionBlocker(), authorization (a denial is a 404 that runs nothing) and the org's
// isolation. The handler runs on Freeploy's own database (the /api/v1 fixture of api-v1-database.ts, PGlite with every
// deploy migration), each test in a transaction that is rolled back.
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { handleIntegrationTokens, type IntegrationTokenNetwork, type IntegrationTokenRunner } from "@deploy-core-worker/handlers/integration-tokens";
import { columnCipher } from "@deploy-core-worker/handlers/cloud-tokens";
import { INTEGRATION_TOKEN_MESSAGES, phpLooseEqual } from "@deploy-core-worker/integration-tokens/service";
import { INTEGRATION_PROVIDER_MESSAGES, providerName } from "@deploy-core-worker/integration-tokens/providers";
import { withOrg } from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";

const ORG = "org_" + "0".repeat(31) + "a";
const BASE = `https://x/v1/organizations/${ORG}/deploy/integration-tokens`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const CF = "i1paritycloudflaredns001";
const CF_TUNNEL = "i2paritycloudflaretun002";
const DOPPLER = "i3paritydoppler000000003";
const INFISICAL = "i4parityinfisical0000004";
const VAULT = "i5parityvault00000000005";
const OTHER = "i6othercloudflare0000006";
const CLOCK = new Date("2026-03-04T05:06:07Z");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

let fixture: FixtureDatabase;
beforeAll(async () => {
  fixture = await fixtureDatabase();
}, 120_000);
afterAll(async () => fixture?.pg.close());

type Body = { data?: Record<string, unknown> & { tokens?: Array<Record<string, unknown>>; token?: Record<string, unknown> }; error?: { code: string; message: string; details: { fields?: Record<string, string[]> } } };
type Answer = { status: number; body: Body; text: string };
type Reply = { status?: number; body?: unknown; fail?: boolean };

/** One test's handler: policy-worker's answers, the org's transaction on the fixture, and the providers' fake API. */
function setup(db: TransactionalSqlExecutor, opts: { read?: boolean; write?: boolean } = {}) {
  const asked: string[] = [];
  const env: Env = {
    ENVIRONMENT: "test",
    DEPLOY_CONSOLE_URL: "https://console.example",
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      asked.push(body.action);
      const allow = body.action === "deploy.resource.write" ? (opts.write ?? true) : (opts.read ?? true);
      return json({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
  };
  let ran = 0;
  const runner: IntegrationTokenRunner = (_env, orgId, fn) => {
    ran++;
    return withOrg(db, orgId, (tx) => fn({ tx, orgId, cipher: columnCipher(tx, orgId, TEST_KEK, "integration_tokens.token") }));
  };
  const requests: Array<{ method: string; url: string; headers: Record<string, string>; body?: unknown }> = [];
  /** The provider's answers by `METHOD URL` prefix; anything else is a 404. */
  const replies: Array<[string, Reply]> = [];
  const net: IntegrationTokenNetwork = {
    fetch: async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      requests.push({ method, url, headers: Object.fromEntries(new Headers(init?.headers).entries()), ...(typeof init?.body === "string" && { body: JSON.parse(init.body) as unknown }) });
      const reply = replies.find(([key]) => `${method} ${url}`.startsWith(key))?.[1];
      if (reply?.fail) throw new TypeError("fetch failed");
      return reply ? json(reply.body ?? {}, reply.status ?? 200) : json({ message: "Not Found" }, 404);
    },
    sleep: async () => undefined,
    resolve: async (host) => (host === "private.example" ? ["10.0.0.5"] : host === "unresolvable.example" ? [] : ["93.184.216.34"]),
    now: () => CLOCK,
  };
  const call = async (method: string, path = "", body?: unknown): Promise<Answer> => {
    const segments = path.split("/").filter(Boolean);
    const res = await handleIntegrationTokens(env, "req_1", actor, ORG_UUID[1]!, segments, new Request(`${BASE}${path}`, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) }), runner, net);
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) as Body, text };
  };
  const rows = async (sql: string) => withOrg(db, ORG_UUID[1]!, async (tx) => (await tx.execute(sql)).rows);
  return { call, asked, requests, replies, rows, ran: () => ran };
}

const inCase = <T>(fn: (db: TransactionalSqlExecutor) => Promise<T>) => fixture.inCase(fn);
const CLOUDFLARE = "https://api.cloudflare.com/client/v4";
const zone = (id: string, name: string, account: { id: string; name: string | null } | null = { id: "acc-1", name: "Parity Account" }) => ({ id, name, account });
/** Cloudflare accepting a DNS token whose first zone is zone-com, and listing `zones` on one page. */
function cloudflareAccepts(replies: Array<[string, Reply]>, zones = [zone("zone-com", "Example.com"), zone("zone-new", "new.example")]) {
  replies.push(
    [`GET ${CLOUDFLARE}/user/tokens/verify`, { body: { success: true, result: { status: "active" } } }],
    [`GET ${CLOUDFLARE}/zones?per_page=1`, { body: { success: true, result: [zone("zone-com", "example.com")] } }],
    [`GET ${CLOUDFLARE}/zones/zone-com/dns_records?per_page=1`, { body: { success: true, result: [] } }],
    [`GET ${CLOUDFLARE}/accounts/acc-1/cfd_tunnel?per_page=1&is_deleted=false`, { body: { success: true, result: [] } }],
    [`GET ${CLOUDFLARE}/zones?page=1&per_page=50`, { body: { success: true, result: zones, result_info: { total_pages: 1 } } }],
  );
}

describe("IntegrationTokens: the list", () => {
  it("lists the org's tokens latest first with their providers, capabilities, Auto DNS and zone counts, never another org's or a secret", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      const r = await t.call("GET");
      expect(r.status).toBe(200);
      expect(r.body.data!.canWrite).toBe(true);
      expect(r.body.data!.tokens).toEqual([
        { uuid: VAULT, name: "Parity Vault", provider: "vault", providerName: "HashiCorp Vault", capabilities: ["secrets"], automaticDns: false, dnsZonesCount: 0 },
        { uuid: INFISICAL, name: "Parity Infisical", provider: "infisical", providerName: "Infisical", capabilities: ["secrets"], automaticDns: false, dnsZonesCount: 0 },
        { uuid: DOPPLER, name: "Parity Doppler", provider: "doppler", providerName: "Doppler", capabilities: ["secrets"], automaticDns: false, dnsZonesCount: 0 },
        { uuid: CF_TUNNEL, name: "Parity Tunnel", provider: "cloudflare", providerName: "Cloudflare", capabilities: ["dns", "tunnel"], automaticDns: false, dnsZonesCount: 1 },
        { uuid: CF, name: "Parity Cloudflare", provider: "cloudflare", providerName: "Cloudflare", capabilities: ["dns"], automaticDns: true, dnsZonesCount: 2 },
      ]);
      expect(r.text).not.toContain("cf-team1-token");
      expect(r.text).not.toContain(OTHER);
      expect(t.asked).toEqual(["deploy.resource.read", "deploy.resource.write"]);
    });
  });

  it("shows a token's editor: settings, zones by name with their managed records, the last refresh; never the token", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      await t.rows(`INSERT INTO deploy.managed_dns_records (uuid, integration_token_id, dns_provider_zone_id, provider_record_id, type, name, content, owned, org_id) VALUES ('m1', 1, 2, 'r1', 'A', 'a.example.org', '203.0.113.1', true, deploy.current_org()), ('m2', 1, 2, 'r2', 'A', 'b.example.org', '203.0.113.1', true, deploy.current_org())`);
      const r = await t.call("GET", `/${CF}`);
      expect(r.body.data).toMatchObject({
        uuid: CF,
        providerName: "Cloudflare",
        automaticDns: true,
        proxiedDns: false,
        metadata: { zones_synced_at: "2025-12-30T00:00:00+00:00" },
        zonesSyncedAt: "2025-12-30T00:00:00+00:00",
        zones: [
          { id: 1, name: "example.com", accountName: "Parity Account", managedRecordsCount: 0 },
          { id: 2, name: "example.org", accountName: "Parity Account", managedRecordsCount: 2 },
        ],
        canUpdate: true,
      });
      expect(r.text).not.toContain("cf-team1-token");
      expect((await t.call("GET", `/${VAULT}`)).body.data).toMatchObject({ providerName: "HashiCorp Vault", metadata: { base_url: "https://vault.example.com:8200", namespace: "admin/team-a", timeout: 15 }, zones: [] });
      expect((await t.call("GET", `/${OTHER}`)).status).toBe(404);
      expect((await t.call("GET", "/nonexistent")).status).toBe(404);
    });
  });
});

describe("IntegrationTokenForm: rules and messages", () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, string[]>]> = [
    ["nothing", { provider: "cloudflare", name: "", token: "", capabilities: [] }, { name: ["The name field is required."], token: ["The token field is required."], capabilities: [INTEGRATION_TOKEN_MESSAGES.selectCapability] }],
    ["an unknown provider", { provider: "aws", name: "x".repeat(256), token: "t", capabilities: ["secrets"] }, { provider: ["The selected provider is invalid."], name: ["The name field must not be greater than 255 characters."] }],
    ["a tunnel without DNS", { provider: "cloudflare", name: "n", token: "t", capabilities: ["tunnel"] }, { capabilities: [INTEGRATION_TOKEN_MESSAGES.tunnelNeedsDns] }],
    ["the secrets capability on Cloudflare", { provider: "cloudflare", name: "n", token: "t", capabilities: ["dns", "secrets"], automaticDns: "yes" }, { automaticDns: ["The automatic dns field must be true or false."], "capabilities.1": ["The selected capabilities.1 is invalid."] }],
    ["a Doppler personal token", { provider: "doppler", name: "n", token: "dp.pt.x", capabilities: ["secrets"] }, { token: [INTEGRATION_TOKEN_MESSAGES.dopplerToken] }],
    ["Infisical without settings", { provider: "infisical", name: "n", token: "t", capabilities: ["secrets"], metadata: { timeout: "" } }, { "metadata.base_url": ["The metadata.base url field is required."], "metadata.client_id": ["The metadata.client id field is required."] }],
    ["Infisical with invalid settings", { provider: "infisical", name: "n", token: "t", capabilities: ["secrets"], metadata: { base_url: "ftp://x.example", client_id: "c", timeout: "abc" } }, { "metadata.base_url": ["The metadata.base url field must be a valid URL."], "metadata.timeout": ["The metadata.timeout field must be an integer."] }],
    ["Vault with a timeout too long", { provider: "vault", name: "n", token: "t", capabilities: ["secrets"], metadata: { base_url: "https://vault.example.com", timeout: "301" } }, { "metadata.timeout": ["The metadata.timeout field must not be greater than 300."] }],
  ];
  it.each(cases)("%s", async (_name, body, fields) => {
    await inCase(async (db) => {
      const t = setup(db);
      const r = await t.call("POST", "", body);
      expect(r.status).toBe(422);
      expect(r.body.error!.details.fields).toEqual(fields);
      expect(t.requests).toEqual([]);
    });
  });
});

describe("IntegrationTokenForm::addToken", () => {
  it("asks Cloudflare, stores the token encrypted with its zones, and toasts", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      cloudflareAccepts(t.replies);
      const r = await t.call("POST", "", { provider: "cloudflare", name: "Production DNS", token: "cf-new", capabilities: ["dns", "tunnel"], metadata: {}, automaticDns: false, proxiedDns: true });
      expect(r.status).toBe(201);
      expect(r.body.data!.message).toBe("Integration token added successfully.");
      expect(t.requests.map((q) => `${q.method} ${q.url.replace(CLOUDFLARE, "")} ${q.headers.authorization}`)).toEqual([
        "GET /user/tokens/verify Bearer cf-new",
        "GET /zones?per_page=1 Bearer cf-new",
        "GET /zones/zone-com/dns_records?per_page=1 Bearer cf-new",
        "GET /accounts/acc-1/cfd_tunnel?per_page=1&is_deleted=false Bearer cf-new",
        "GET /zones?page=1&per_page=50 Bearer cf-new",
      ]);
      const uuid = r.body.data!.uuid as string;
      const [row] = await t.rows(`SELECT id, token, capabilities::text AS capabilities, metadata::text AS metadata FROM deploy.integration_tokens WHERE uuid = '${uuid}'`);
      expect(row!.token).not.toBe("cf-new");
      expect(await withOrg(db, ORG_UUID[1]!, (tx) => columnCipher(tx, ORG_UUID[1]!, TEST_KEK, "integration_tokens.token").decrypt(String(row!.token)))).toBe("cf-new");
      expect(JSON.parse(String(row!.capabilities))).toEqual(["dns", "tunnel"]);
      expect(JSON.parse(String(row!.metadata))).toEqual({ automatic_dns: false, proxied_dns: true, zones_synced_at: "2026-03-04T05:06:07+00:00" });
      expect((await t.rows(`SELECT name, account_name FROM deploy.dns_provider_zones WHERE integration_token_id = ${row!.id} ORDER BY name`)).map((z) => [z.name, z.account_name])).toEqual([
        ["example.com", "Parity Account"],
        ["new.example", "Parity Account"],
      ]);
      expect(r.text).not.toContain("cf-new\"");
    });
  });

  it("logs in to Infisical with the client ID and secret, keeps the filled settings", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      t.replies.push(["POST https://infisical.example.com/api/v1/auth/universal-auth/login", { body: { accessToken: "at" } }]);
      const r = await t.call("POST", "", { provider: "infisical", name: "Secrets", token: "secret", capabilities: ["secrets"], metadata: { base_url: "https://infisical.example.com/", client_id: "client", timeout: "" } });
      expect(r.status).toBe(201);
      expect(t.requests).toEqual([{ method: "POST", url: "https://infisical.example.com/api/v1/auth/universal-auth/login", headers: { accept: "application/json", "content-type": "application/json" }, body: { clientId: "client", clientSecret: "secret" } }]);
      const [row] = await t.rows(`SELECT metadata::text AS metadata FROM deploy.integration_tokens WHERE uuid = '${r.body.data!.uuid as string}'`);
      expect(JSON.parse(String(row!.metadata))).toEqual({ base_url: "https://infisical.example.com/", client_id: "client" });
    });
  });

  it("sends Vault's token and namespace in their headers", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      t.replies.push(["GET https://vault.example.com/v1/auth/token/lookup-self", { body: { data: {} } }]);
      expect((await t.call("POST", "", { provider: "vault", name: "Vault", token: "hvs.x", capabilities: ["secrets"], metadata: { base_url: "https://vault.example.com", namespace: "admin", timeout: "20" } })).status).toBe(201);
      expect(t.requests[0]!.headers).toMatchObject({ "x-vault-token": "hvs.x", "x-vault-namespace": "admin" });
    });
  });

  it.each([
    ["Cloudflare refuses", { provider: "cloudflare", name: "n", token: "t", capabilities: ["dns"] }, [`GET ${CLOUDFLARE}/user/tokens/verify`, { status: 401, body: { success: false } }], 422, INTEGRATION_PROVIDER_MESSAGES.rejected("cloudflare")],
    ["Cloudflare is unreachable", { provider: "cloudflare", name: "n", token: "t", capabilities: ["dns"] }, [`GET ${CLOUDFLARE}/user/tokens/verify`, { fail: true }], 502, "Could not connect to the Cloudflare API. Check the network connection of Coolify and try again."],
    ["Doppler refuses", { provider: "doppler", name: "n", token: "dp.st.x", capabilities: ["secrets"] }, ["GET https://api.doppler.com/v3/me", { status: 403 }], 422, "The Doppler token could not be verified. Check the token and its access."],
    ["Doppler is unreachable (validate() answers false)", { provider: "doppler", name: "n", token: "dp.st.x", capabilities: ["secrets"] }, ["GET https://api.doppler.com/v3/me", { fail: true }], 422, "The Doppler token could not be verified. Check the token and its access."],
    ["Infisical's base URL is private", { provider: "infisical", name: "n", token: "t", capabilities: ["secrets"], metadata: { base_url: "https://private.example", client_id: "c" } }, null, 422, "The base_url points to a local or private address that is not allowed. Configure allowed internal targets: https://console.example/settings/advanced#endpoint-section"],
    ["Vault's host does not resolve", { provider: "vault", name: "n", token: "t", capabilities: ["secrets"], metadata: { base_url: "https://unresolvable.example" } }, null, 422, "The base url host could not be resolved."],
  ] as const)("toasts when %s, and stores nothing", async (_name, body, reply, status, toast) => {
    await inCase(async (db) => {
      const t = setup(db);
      if (reply) t.replies.push([reply[0], reply[1] as Reply]);
      const r = await t.call("POST", "", body);
      expect([r.status, r.body.error!.message]).toEqual([status, toast]);
      expect(await t.rows("SELECT count(*)::int AS n FROM deploy.integration_tokens")).toEqual([{ n: 5 }]);
    });
  });
});

describe("IntegrationTokenEditor", () => {
  it("renames without asking the provider", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      const r = await t.call("PATCH", `/${DOPPLER}`, { name: "Renamed", newToken: "", capabilities: ["secrets"], metadata: {} });
      expect(r.status).toBe(200);
      expect(r.body.data!.message).toBe("Integration token updated successfully.");
      expect(r.body.data!.token).toMatchObject({ name: "Renamed" });
      expect(t.requests).toEqual([]);
    });
  });

  it("rotates a Cloudflare token: asks again and reads the zones again, keeping a zone with managed records", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      await t.rows(`INSERT INTO deploy.managed_dns_records (uuid, integration_token_id, dns_provider_zone_id, provider_record_id, type, name, content, owned, org_id) VALUES ('m1', 1, 2, 'r1', 'A', 'a.example.org', '203.0.113.1', true, deploy.current_org())`);
      cloudflareAccepts(t.replies, [zone("zone-io", "example.io")]);
      const r = await t.call("PATCH", `/${CF}`, { name: "Parity Cloudflare", newToken: "cf-rotated", capabilities: ["dns"], metadata: {}, automaticDns: true, proxiedDns: false });
      expect(r.status).toBe(200);
      expect((r.body.data!.token!.zones as Array<{ name: string }>).map((z) => z.name)).toEqual(["example.io", "example.org"]);
      expect(r.body.data!.token!.zonesSyncedAt).toBe("2026-03-04T05:06:07+00:00");
      expect(t.requests.every((q) => q.headers.authorization === "Bearer cf-rotated")).toBe(true);
    });
  });

  it("asks for the secret again when Infisical's base URL changes, under the new token's field", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      const r = await t.call("PATCH", `/${INFISICAL}`, { name: "Parity Infisical", newToken: "", capabilities: ["secrets"], metadata: { base_url: "https://other.example", client_id: "client-team1" } });
      expect([r.status, r.body.error!.details.fields]).toEqual([422, { newToken: ["Enter the client secret again when you change the base URL or the client ID."] }]);
      expect(t.requests).toEqual([]);
    });
  });

  it("asks Infisical with the stored secret when only the timeout changes", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      t.replies.push(["POST https://app.infisical.com/api/v1/auth/universal-auth/login", { body: { accessToken: "x" } }]);
      expect((await t.call("PATCH", `/${INFISICAL}`, { name: "Parity Infisical", newToken: "", capabilities: ["secrets"], metadata: { base_url: "https://app.infisical.com", client_id: "client-team1", timeout: "45" } })).status).toBe(200);
      expect(t.requests.map((q) => q.body)).toEqual([{ clientId: "client-team1", clientSecret: "inf-team1-secret" }]);
    });
  });

  it("shows the editor's messages: Laravel's for the new token, the component's for the capabilities", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      const doppler = await t.call("PATCH", `/${DOPPLER}`, { name: " ", newToken: "dp.pt.x", capabilities: ["secrets"], metadata: {} });
      expect(doppler.body.error!.details.fields).toEqual({ name: ["The name field is required."], newToken: ["The new token field format is invalid."] });
      const cf = await t.call("PATCH", `/${CF}`, { name: "n", newToken: "", capabilities: [] });
      expect(cf.body.error!.details.fields).toEqual({ capabilities: [INTEGRATION_TOKEN_MESSAGES.selectCapability] });
    });
  });

  it("puts a private Vault URL's refusal under the new token (first('token') of base_url's errors is empty)", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      const r = await t.call("PATCH", `/${VAULT}`, { name: "Parity Vault", newToken: "hvs.new", capabilities: ["secrets"], metadata: { base_url: "https://private.example", namespace: "admin/team-a" } });
      expect([r.status, r.body.error!.details.fields]).toEqual([422, { newToken: [""] }]);
    });
  });

  it("refuses to delete a token that a resource or a DNS record uses, deletes it with its zones otherwise", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      await t.rows(`INSERT INTO deploy.secret_manager_links (uuid, resourceable_type, resourceable_id, integration_token_id, org_id) VALUES ('l1', 'App\\Models\\Application', 1, 3, deploy.current_org())`);
      await t.rows(`INSERT INTO deploy.managed_dns_records (uuid, integration_token_id, dns_provider_zone_id, provider_record_id, type, name, content, owned, org_id) VALUES ('m1', 2, 3, 'r1', 'A', 'a.example.net', '203.0.113.1', true, deploy.current_org())`);
      expect([(await t.call("DELETE", `/${DOPPLER}`)).body.error!.message, (await t.call("DELETE", `/${CF_TUNNEL}`)).body.error!.message]).toEqual([INTEGRATION_TOKEN_MESSAGES.usedAsSecretManager, INTEGRATION_TOKEN_MESSAGES.managesDnsRecords]);
      const r = await t.call("DELETE", `/${CF}`);
      expect([r.status, r.body.data!.message]).toEqual([200, "Integration token deleted successfully."]);
      expect(await t.rows("SELECT count(*)::int AS n FROM deploy.dns_provider_zones WHERE integration_token_id = 1")).toEqual([{ n: 0 }]);
      expect((await t.call("DELETE", `/${OTHER}`)).status).toBe(404);
    });
  });

  it("refreshes a Cloudflare token's zones and counts them, refuses another provider's, toasts Cloudflare's refusal", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      t.replies.push([`GET ${CLOUDFLARE}/zones?page=1&per_page=50`, { body: { success: true, result: [zone("zone-com", "example.com"), zone("zone-dev", "example.dev", null)], result_info: { total_pages: 1 } } }]);
      const r = await t.call("POST", `/${CF}/refresh-zones`);
      expect([r.status, r.body.data!.message]).toEqual([200, "Cloudflare zones refreshed. 2 accessible zones found."]);
      expect((await t.call("POST", `/${DOPPLER}/refresh-zones`)).body.error!.message).toBe("Only Cloudflare tokens have DNS zones.");
      t.replies.unshift([`GET ${CLOUDFLARE}/zones`, { status: 403, body: {} }]);
      expect((await t.call("POST", `/${CF}/refresh-zones`)).body.error!.message).toBe("The Cloudflare token needs the Zone → Zone → Read permission.");
    });
  });
});

describe("authorization and routing", () => {
  it("answers 404 when policy-worker denies, and runs nothing", async () => {
    await inCase(async (db) => {
      const reader = setup(db, { read: false });
      expect((await reader.call("GET")).status).toBe(404);
      expect((await reader.call("GET", `/${CF}`)).status).toBe(404);
      expect(reader.ran()).toBe(0);
      const viewer = setup(db, { write: false });
      expect((await viewer.call("GET")).body.data!.canWrite).toBe(false);
      for (const [method, path, body] of [["POST", "", { provider: "doppler", name: "n", token: "dp.st.x", capabilities: ["secrets"] }], ["PATCH", `/${DOPPLER}`, { name: "x" }], ["DELETE", `/${DOPPLER}`], ["POST", `/${CF}/refresh-zones`]] as const) {
        expect((await viewer.call(method, path, body)).status).toBe(404);
      }
      expect(viewer.ran()).toBe(1);
      expect(viewer.requests).toEqual([]);
    });
  });

  it("routes /deploy/integration-tokens and refuses other methods and paths", async () => {
    const env: Env = { ENVIRONMENT: "test" };
    const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
    expect((await route(new Request(BASE), env)).status).toBe(401);
    expect((await route(new Request("https://x/v1/organizations/nope/deploy/integration-tokens", { headers }), env)).status).toBe(404);
    expect((await route(new Request(`${BASE}/abc`, { headers }), env)).status).toBe(503);
    expect((await route(new Request(`${BASE}/abc/refresh-zones`, { method: "POST", headers }), env)).status).toBe(503);
    expect((await route(new Request(`${BASE}/abc/refresh-zones`, { headers }), env)).status).toBe(405);
    expect((await route(new Request(`${BASE}/abc/validate`, { method: "POST", headers }), env)).status).toBe(404);
    expect((await route(new Request(`${BASE}`, { method: "PUT", headers }), env)).status).toBe(405);
  });
});

describe("the model's helpers", () => {
  it("names the providers as IntegrationToken::providerName() does", () => {
    expect(["cloudflare", "doppler", "infisical", "vault", "aws"].map(providerName)).toEqual(["Cloudflare", "Doppler", "Infisical", "HashiCorp Vault", "Aws"]);
  });
  it("compares settings as PHP's == does", () => {
    expect(phpLooseEqual({ timeout: 15, base_url: "x" }, { base_url: "x", timeout: "15" })).toBe(true);
    expect(phpLooseEqual({ timeout: 15 }, { timeout: 16 })).toBe(false);
    expect(phpLooseEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});
