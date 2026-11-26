// Coolify's managed DNS API (DP-105) — GET /dns/zones, an application's and a service's DNS status, a record created,
// a conflicting record replaced, a record released — replayed against Coolify's real answers: fixtures/api/goldens.json,
// emitted by Coolify's PHP through its HTTP kernel on PostgreSQL with Cloudflare faked by Http::fake() (see
// fixtures/api/README.md). The fixture is made in Freeploy's own database (api-v1-database.ts), each request goes to
// deploy-core-worker's handler with the headers api-edge sends, the handler's fetch serves the same fake answers (a fake
// record's `{{ownership:<uuid>}}` comment is Freeploy's ownership comment for that record, as emit.php writes Coolify's),
// and the status, the body (byte for byte after the masking both sides share), the requests sent to Cloudflare (the
// decrypted token, the ownership comment masked) and the rows each write left are compared. Each case is rolled back.
import { handleApiV1, type ApiV1Runners } from "@deploy-core-worker/api-v1/handler";
import type { Env } from "@deploy-core-worker/env";
import type { HostResolver } from "@deploy-core-worker/s3-storages/safe-url";
import { ownershipCommentFor } from "@deploy-core-worker/managed-dns/cloudflare";
import { hostnamesOf, urlHost } from "@deploy-core-worker/managed-dns/service";
import { isPublicAddress, sameAddress } from "@deploy-core-worker/managed-dns/addresses";
import { apiRows, withOrg } from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { API_V1_HEADERS } from "@saas/contracts/coolify-api";
import { CASES, golden, maskRequests, maskedJson, type Case, type FixtureToken, type HttpRequestRecord } from "./api-v1-goldens.js";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";

const ORG_PUBLIC = "org_" + "0".repeat(31) + "a";
const env = { ENVIRONMENT: "test", DEPLOY_ENCRYPTION_KEY: TEST_KEK, DEPLOY_CONSOLE_URL: "http://localhost" } as Env;
const T1 = 1;
const CLOCK = new Date("2026-01-01T00:00:00Z");

const tokenOf = (key: string): FixtureToken => CASES.fixture.tokens.find((t) => t.key === key)!;
const roleOf = (userId: number) => CASES.fixture.users.find((u) => u.id === userId)!.teams.find((t) => t.team === T1)?.role ?? null;
const isAdmin = (userId: number) => ["owner", "admin"].includes(roleOf(userId) ?? "");
const userPublic = (id: number) => `usr_${String(id).padStart(32, "0")}`;
const caseNamed = (name: string) => CASES.cases.find((c) => c.name === name)!;

/** The request api-edge forwards for a fixture case. */
function forwarded(c: Case): Request {
  const t = tokenOf(c.token!);
  const headers = new Headers({
    [API_V1_HEADERS.org]: ORG_PUBLIC,
    [API_V1_HEADERS.user]: userPublic(t.user),
    [API_V1_HEADERS.abilities]: t.abilities.join(","),
    [API_V1_HEADERS.canReadSensitive]: (t.abilities.includes("root") || t.abilities.includes("read:sensitive")) && isAdmin(t.user) ? "1" : "0",
  });
  let body: string | undefined;
  if (c.raw !== undefined) {
    body = c.raw;
    headers.set("content-type", c.contentType ?? "application/json");
  } else if (c.body !== undefined) {
    body = JSON.stringify(c.body);
    headers.set("content-type", "application/json");
  }
  const [path, query] = c.path.slice("/api/v1".length).split("?");
  return new Request(`https://deploy-core.internal/v1/internal/api-v1/${ORG_PUBLIC}${path}${query ? `?${query}` : ""}`, { method: c.method, headers, ...(body !== undefined && { body }) });
}

let fixture: FixtureDatabase;
beforeAll(async () => {
  fixture = await fixtureDatabase();
}, 120_000);
afterAll(async () => fixture?.pg.close());

/** A fake answer's "{{ownership:<uuid>}}" strings as the ownership comment Freeploy writes for that record. */
function withOwnership(v: unknown): unknown {
  if (typeof v === "string") {
    const m = /^\{\{ownership:([a-z0-9]+)\}\}$/.exec(v);
    return m ? ownershipCommentFor(env.ENVIRONMENT, m[1]!) : v;
  }
  if (Array.isArray(v)) return v.map(withOwnership);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withOwnership(x)]));
  return v;
}

/** Cloudflare as emit.php fakes it: the case's answers (a failed connection throws, as fetch does), else a 404; every request recorded. */
function fakeFetch(c: Case, requests: HttpRequestRecord[]): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const text = typeof init?.body === "string" ? init.body : "";
    requests.push({ method, url, ...(headers.get("authorization") !== null && { authorization: headers.get("authorization")! }), ...(text !== "" && { body: JSON.parse(text) as unknown }) });
    for (const a of c.http ?? []) {
      if (new RegExp(a.match).test(`${method} ${url}`)) {
        if (a.failedConnection) throw new TypeError("fetch failed");
        return new Response(a.raw !== undefined ? a.raw : JSON.stringify(withOwnership(a.body ?? [])), { status: a.status ?? 200, headers: { "content-type": "application/json", ...a.headers } });
      }
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
  };
}

/** Host names as emit.php's SafeWebhookUrl::resolveHostsUsing() table resolves them (no DNS is asked). */
const resolve: HostResolver = async (host) => (host === "unresolvable.example" ? [] : host === "private.example" ? ["10.0.0.5"] : ["93.184.216.34"]);

type Allow = { read: boolean; write: boolean };
/** The zones are a team admin's; a resource's change its update: a member is answered as policy-worker answers a member's write. */
const allowOf = (c: Case): Allow => (roleOf(tokenOf(c.token!).user) === "member" ? { read: true, write: false } : { read: true, write: true });

function runners(db: TransactionalSqlExecutor, allow: Allow, fetch: typeof globalThis.fetch): Partial<ApiV1Runners> {
  return {
    sql: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, fn),
    rows: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, (tx) => fn((table, where, params) => apiRows(tx, table, where ?? null, params ?? []))),
    allows: async (action) => (action === "deploy.resource.write" ? allow.write : allow.read),
    org: async () => ({ id: ORG_PUBLIC, name: "Parity Team", createdAt: "2026-01-01T00:00:00.000Z" }),
    s3: { resolve, http: async (url) => Promise.reject(new Error(`no S3 request expected: ${url}`)), sleep: async () => undefined },
    providers: { fetch, sleep: async () => undefined, now: () => CLOCK },
  };
}

const query = (db: TransactionalSqlExecutor, sql: string) =>
  withOrg(db, ORG_UUID[T1]!, async (tx) => {
    await tx.execute("SET LOCAL search_path TO deploy");
    return (await tx.execute(sql)).rows;
  });

async function send(c: Case, db: TransactionalSqlExecutor, allow: Allow = allowOf(c)) {
  for (const sql of [...(c.setup ?? []), ...(c.setupFreeploy ?? [])]) await query(db, sql);
  const requests: HttpRequestRecord[] = [];
  const req = forwarded(c);
  const path = new URL(req.url).pathname.replace(`/v1/internal/api-v1/${ORG_PUBLIC}`, "");
  const res = await handleApiV1(req, env, "req_test", { subjectId: userPublic(tokenOf(c.token!).user), subjectType: "user" }, ORG_UUID[T1]!, ORG_PUBLIC, path, runners(db, allow, fakeFetch(c, requests)));
  return { res, requests };
}

async function afterRows(db: TransactionalSqlExecutor, c: Case): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const [label, sql] of Object.entries(c.after ?? {})) out[label] = await query(db, sql);
  return out;
}

async function replay(c: Case, withAfter = false) {
  return fixture.inCase(async (db) => {
    const { res, requests } = await send(c, db);
    return { status: res.status, body: await res.text(), requests, after: withAfter ? await afterRows(db, c) : undefined };
  });
}

/** The cases whose answer is the middleware's (an ability api.ability refuses; tests/api-edge replays them). */
const MIDDLEWARE_BODY = /^\{"message":"Missing required permissions: [a-z:]+"\}$/;
const isMiddleware = (c: Case) => golden(c.name).status === 403 && MIDDLEWARE_BODY.test(golden(c.name).body.json ?? "");
const isDns = (c: Case) => /^dns (zones|application|service): /.test(c.name);
const DP105_CASES = CASES.cases.filter((c) => isDns(c) && c.token && !isMiddleware(c));

describe("the goldens of DP-105", () => {
  it("cover every operation", () => {
    expect(CASES.cases.filter(isDns).length).toBe(91);
    for (const prefix of ["dns zones: list", "dns application: status", "dns service: status", "dns application: create", "dns service: create", "dns application: replace", "dns service: replace", "dns application: release", "dns service: release"]) {
      expect(DP105_CASES.some((c) => c.name.startsWith(prefix))).toBe(true);
    }
    // Every request Cloudflare is sent: the records read, a record created, replaced, read again and deleted, a failed connection.
    const methods = new Set(DP105_CASES.flatMap((c) => (golden(c.name).requests ?? []).map((r) => r.method)));
    expect([...methods].sort()).toEqual(["DELETE", "GET", "PATCH", "POST"]);
    expect(DP105_CASES.some((c) => (c.http ?? []).some((a) => a.failedConnection))).toBe(true);
  });
});

describe("Freeploy answers as Coolify does, and asks Cloudflare what Coolify asks (DP-105)", () => {
  it.each(DP105_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const g = golden(name);
    const got = await replay(c);
    if (g.body.json !== undefined && process.env.API_DIFF && (maskedJson(got.body) !== maskedJson(g.body.json) || got.status !== g.status)) console.warn(`${name} ${got.status}/${g.status}\nfreeploy: ${maskedJson(got.body)}\ncoolify:  ${maskedJson(g.body.json)}`);
    expect(got.status).toBe(g.status);
    if (g.body.json !== undefined) expect(maskedJson(got.body)).toBe(maskedJson(g.body.json));
    else expect(got.body).toBe(g.body.text);
    expect(maskRequests(got.requests)).toEqual(maskRequests(g.requests ?? []));
  });
});

const AFTER_CASES = DP105_CASES.filter((c) => c.after);

describe("what a write leaves behind (DP-105)", () => {
  it("has the rows of the writes", () => {
    expect(AFTER_CASES.length).toBeGreaterThanOrEqual(35);
  });

  it.each(AFTER_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const got = await replay(c, true);
    if (process.env.API_DIFF && JSON.stringify(got.after) !== JSON.stringify(golden(name).after)) console.warn(`${name}\nfreeploy: ${JSON.stringify(got.after)}\ncoolify:  ${JSON.stringify(golden(name).after)}`);
    expect(got.after).toEqual(golden(name).after);
  });
});

describe("authorization, isolation and the ownership comment (DP-105)", () => {
  it("answers 403 when policy-worker denies the token's user, after the 404 of an unknown resource, and asks Cloudflare nothing", async () => {
    const DENIED = { read: false, write: false };
    const out = await fixture.inCase(async (db) => {
      const results: Array<[number, number]> = [];
      for (const name of ["dns zones: list", "dns application: status", "dns service: status", "dns application: create a record", "dns application: replace a record", "dns application: release, deleted", "dns service: create a record"]) {
        const { res, requests } = await send(caseNamed(name), db, DENIED);
        results.push([res.status, requests.length]);
      }
      for (const name of ["dns application: status, unknown", "dns application: create, unknown", "dns service: status, unknown", "dns application: release, unknown"]) results.push([(await send(caseNamed(name), db, DENIED)).res.status, 0]);
      return { results, rows: await afterRows(db, caseNamed("dns application: create a record")) };
    });
    expect(out.results).toEqual([...Array(7).fill([403, 0]), [404, 0], [404, 0], [404, 0], [404, 0]]);
    expect(out.rows).toEqual({ records: [{ fixture_uuid: "m3paritydnsold0000000003", token: "i1paritycloudflaredns001", zone: "zone-com", provider_record_id: "rec-old", type: "A", name: "old.example.com", content: "203.0.113.10", owned: true }], references: [{ name: "old.example.com", resource_type: "App\\Models\\Application", resource_id: 1 }] });
  });

  it("never sees another team's zones, nor its application or service", async () => {
    await fixture.inCase(async (db) => {
      const { res } = await send(caseNamed("dns zones: list"), db);
      expect((JSON.parse(await res.text()) as Array<{ zone: string }>).map((z) => z.zone)).toEqual(["example.com", "example.net", "example.org"]);
      expect((await send(caseNamed("dns application: status, another team's"), db)).res.status).toBe(404);
      expect((await send(caseNamed("dns service: status, another team's"), db)).res.status).toBe(404);
    });
  });

  it("writes Freeploy's ownership comment with the new record's uuid", async () => {
    await fixture.inCase(async (db) => {
      const { res, requests } = await send(caseNamed("dns application: create a record"), db);
      const uuid = (JSON.parse(await res.text()) as { record: { uuid: string } }).record.uuid;
      expect((requests[1]!.body as { comment: string }).comment).toBe(`managed-by: freeploy test/${uuid}`);
      expect((await query(db, `select owned from managed_dns_records where uuid = '${uuid}'`))[0]).toEqual({ owned: true });
    });
  });
});

describe("the address and hostname rules (DP-105)", () => {
  it("are PHP 8.3's filter and parse_url", () => {
    // DnsRecordHints::isPublicAddress() as Coolify's PHP answered it (emitted once with PHP 8.3.6).
    const PUBLIC = ["203.0.113.10", "93.184.216.34", "172.32.0.1", "100.128.0.1", "192.0.2.1", "198.51.100.1", "2606:4700::1", "fec0::1", "::ffff:8.8.8.8", "64:ff9b::1", "2001::1", "5f00::1", "100::1", "::1.2.3.4", "2001:20::1", "fe7f::1", "fe00::1"];
    const NOT = ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "0.1.2.3", "169.254.1.1", "240.0.0.1", "255.255.255.255", "224.0.0.1", "239.1.1.1", "100.64.0.1", "100.127.255.255", "01.2.3.4", "::1", "::", "2001:db8::1", "fc00::1", "fd12::1", "fe80::1", "febf::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:100.64.0.1", "2001:10::1", "3ff3::1", "abc", "", " 8.8.8.8", "[::1]"];
    expect(PUBLIC.filter((a) => !isPublicAddress(a))).toEqual([]);
    expect(NOT.filter((a) => isPublicAddress(a))).toEqual([]);
    expect(sameAddress("2001:db8::1", "2001:0DB8:0:0::1")).toBe(true);
    expect(sameAddress(" 8.8.8.8", "8.8.8.8")).toBe(true);
    expect(sameAddress("a", "a")).toBe(true);
    // parse_url($url, PHP_URL_HOST)
    expect(["http://image.example.com:8443/path", "http://user:pw@Host.example.com:1/x", "http://[::1]:80/", "http://", "http:///x", "http://host:abc", "http://host?x=1", "http://:80", "http://host.com.:80"].map(urlHost)).toEqual(["image.example.com", "Host.example.com", "[::1]", null, null, null, "host", null, "host.com."]);
    expect(hostnamesOf({ fqdn: "https://A.example.com/x, b.example.com.,https://a.example.com:8080", docker_compose_domains: '{"web":{"domain":"https://c.example.com"},"db":"x","api":{"domain":""}}' })).toEqual(["a.example.com", "b.example.com", "c.example.com"]);
  });
});
