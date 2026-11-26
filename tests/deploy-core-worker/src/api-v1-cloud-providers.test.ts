// Coolify's /api/v1 for what calls an outside HTTP API (DP-90) — the org's cloud provider tokens and what each cloud
// provider offers through one — replayed against Coolify's real answers: fixtures/api/goldens.json, emitted by Coolify's
// PHP through its HTTP kernel on PostgreSQL with the provider's API faked by Http::fake() (see fixtures/api/README.md).
// The fixture is made in Freeploy's own database (api-v1-database.ts), each request goes to deploy-core-worker's handler
// with the headers api-edge sends, the handler's fetch serves the same fake answers, and the status, the body (byte for
// byte after the masking both sides share), the Retry-After header, the requests sent to the provider and the rows each
// write left are compared. Each case is rolled back. No request leaves the test.
import { handleApiV1, type ApiV1Runners } from "@deploy-core-worker/api-v1/handler";
import type { Env } from "@deploy-core-worker/env";
import { columnCipher } from "@deploy-core-worker/handlers/cloud-tokens";
import { PROXY_CONFIGURATION_API_MESSAGES } from "@deploy-core-worker/api-v1/proxy-configuration";
import { apiRows, withOrg } from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { API_V1_HEADERS } from "@saas/contracts/coolify-api";
import { CASES, golden, maskedJson, type Case, type FixtureToken, type HttpRequestRecord } from "./api-v1-goldens.js";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";

const ORG_PUBLIC = "org_" + "0".repeat(31) + "a";
const env = { ENVIRONMENT: "test", DEPLOY_ENCRYPTION_KEY: TEST_KEK, DEPLOY_CONSOLE_URL: "http://localhost" } as Env;
const T1 = 1;

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

/** The outside API as emit.php fakes it: the case's answers (the first whose `match` fits "METHOD URL"), else a 404; every request recorded. */
function fakeFetch(c: Case, requests: HttpRequestRecord[]): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const text = typeof init?.body === "string" ? init.body : "";
    requests.push({ method, url, ...(headers.get("authorization") !== null && { authorization: headers.get("authorization")! }), ...(text !== "" && { body: JSON.parse(text) as unknown }) });
    for (const a of c.http ?? []) {
      if (new RegExp(a.match).test(`${method} ${url}`)) {
        const body = a.raw !== undefined ? a.raw : JSON.stringify(a.body ?? []);
        return new Response(body, { status: a.status ?? 200, headers: { "content-type": a.raw !== undefined ? "text/html" : "application/json", ...a.headers } });
      }
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
  };
}

type Allow = { read: boolean; write: boolean };
const ALL: Allow = { read: true, write: true };
/** Every ability of the cloud token policy is a team admin's: a member is answered as policy-worker answers a member's write. */
const allowOf = (c: Case): Allow => (roleOf(tokenOf(c.token!).user) === "member" ? { read: true, write: false } : ALL);

function runners(db: TransactionalSqlExecutor, allow: Allow, fetch: typeof globalThis.fetch): Partial<ApiV1Runners> {
  return {
    sql: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, fn),
    rows: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, (tx) => fn((table, where, params) => apiRows(tx, table, where ?? null, params ?? []))),
    allows: async (action) => (action === "deploy.resource.write" ? allow.write : allow.read),
    org: async () => ({ id: ORG_PUBLIC, name: "Parity Team", createdAt: "2026-01-01T00:00:00.000Z" }),
    providers: { fetch, sleep: async () => undefined },
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
    return { status: res.status, body: await res.text(), retryAfter: res.headers.get("retry-after"), requests, after: withAfter ? await afterRows(db, c) : undefined };
  });
}

const GROUP = /^(cloud tokens|hetzner|digitalocean|vultr|hostinger|proxy configuration)/;
/** The cases whose answer is the middleware's (an ability api.ability refuses; tests/api-edge replays them). */
const MIDDLEWARE_BODY = /^\{"message":"Missing required permissions: [a-z:]+"\}$/;
const isMiddleware = (c: Case) => golden(c.name).status === 403 && MIDDLEWARE_BODY.test(golden(c.name).body.json ?? "");
/** The paths routes/api.php has no route for: the fallback 404 (api-edge answers it; tests/api-edge replays them). */
const isFallback = (c: Case) => golden(c.name).body.json === '{"message":"Not found.","docs":"https:\\/\\/coolify.io\\/docs"}';
const DP90_CASES = CASES.cases.filter((c) => GROUP.test(c.name) && c.token && !isMiddleware(c));
/**
 * Departures: a proxy configuration that passes Coolify's checks is saved into the server's proxy, then written on the
 * server over SSH (instant_remote_process(); the emitter has no SSH, so its golden is the 500 of the failed command).
 * Freeploy answers 501 in Coolify's envelope there, after the same save: the rows are compared all the same.
 */
const isDeparture = (c: Case) => c.name.startsWith("proxy configuration") && golden(c.name).status === 500;
const DEPARTURE = { status: 501, body: JSON.stringify({ message: PROXY_CONFIGURATION_API_MESSAGES.writeUnavailable }) };

describe("the goldens of DP-90", () => {
  it("cover every group ported", () => {
    expect(CASES.cases.filter((c) => GROUP.test(c.name)).length).toBe(171);
    expect(DP90_CASES.filter(isDeparture).length).toBe(18);
    for (const prefix of ["cloud tokens: list", "cloud tokens: show", "cloud tokens: create", "cloud tokens: update", "cloud tokens: delete", "cloud tokens: validate", "hetzner locations", "hetzner server types", "hetzner images", "hetzner ssh keys", "hetzner firewalls", "hetzner networks", "digitalocean regions", "digitalocean sizes", "digitalocean images", "digitalocean ssh keys", "vultr regions", "vultr plans", "vultr operating systems", "vultr ssh keys", "hostinger data centers", "hostinger catalog", "hostinger templates", "hostinger ssh keys", "hostinger post-install scripts", "proxy configuration: save", "proxy configuration: ports"]) {
      expect(DP90_CASES.some((c) => c.name.startsWith(prefix))).toBe(true);
    }
  });
});

describe("Freeploy answers as Coolify does, and asks the provider what Coolify asks (DP-90)", () => {
  it.each(DP90_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const g = golden(name);
    const got = await replay(c);
    if (isDeparture(c)) {
      expect({ status: got.status, body: got.body }).toEqual(DEPARTURE);
      return;
    }
    if (g.body.json !== undefined && process.env.API_DIFF) {
      const [a, b] = [maskedJson(got.body), maskedJson(g.body.json)];
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      if (a !== b || got.status !== g.status) console.warn(`${name} ${got.status}/${g.status} @${i}\nfreeploy: ${a.slice(Math.max(0, i - 160), i + 240)}\ncoolify:  ${b.slice(Math.max(0, i - 160), i + 240)}`);
    }
    expect(got.status).toBe(g.status);
    if (g.body.json !== undefined) expect(maskedJson(got.body)).toBe(maskedJson(g.body.json));
    else expect(got.body).toBe(g.body.text);
    expect(got.retryAfter).toBe(g.headers["retry-after"] ?? null);
    // The fallback 404 is api-edge's, which never reaches the handler; Freeploy's handler answers it the same way.
    if (!isFallback(c)) expect(got.requests).toEqual(g.requests ?? []);
  });
});

const AFTER_CASES = DP90_CASES.filter((c) => c.after);

describe("what a write leaves behind (DP-90)", () => {
  it("has the rows of the writes", () => {
    expect(AFTER_CASES.length).toBeGreaterThanOrEqual(10);
  });

  it.each(AFTER_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const got = await replay(c, true);
    if (process.env.API_DIFF && JSON.stringify(got.after) !== JSON.stringify(golden(name).after)) console.warn(`${name}\nfreeploy: ${JSON.stringify(got.after)}\ncoolify:  ${JSON.stringify(golden(name).after)}`);
    expect(got.after).toEqual(golden(name).after);
  });
});

describe("authorization and the secrets (DP-90)", () => {
  it("answers 403 when policy-worker denies the token's user, after the 404 of an unknown token, and asks no provider", async () => {
    const DENIED = { read: false, write: false };
    const out = await fixture.inCase(async (db) => {
      const results: Array<[number, number]> = [];
      for (const name of ["cloud tokens: list", "cloud tokens: show", "cloud tokens: create a hetzner token", "cloud tokens: update", "cloud tokens: delete", "cloud tokens: validate a hetzner token", "hetzner locations", "digitalocean regions", "vultr regions", "hostinger data centers"]) {
        const { res, requests } = await send(caseNamed(name), db, DENIED);
        results.push([res.status, requests.length]);
      }
      for (const name of ["cloud tokens: show unknown", "cloud tokens: update unknown", "hetzner locations: unknown token"]) results.push([(await send(caseNamed(name), db, DENIED)).res.status, 0]);
      return { results, rows: await afterRows(db, caseNamed("cloud tokens: update")) };
    });
    expect(out.results).toEqual([...Array(10).fill([403, 0]), [404, 0], [404, 0], [404, 0]]);
    expect(out.rows).toEqual(await fixture.inCase((db) => afterRows(db, { ...caseNamed("cloud tokens: update"), setup: [] })));
  });

  it("stores a new token encrypted with the org's key, and decrypts it for the provider", async () => {
    await fixture.inCase(async (db) => {
      const { res } = await send(caseNamed("cloud tokens: create a hetzner token"), db);
      expect(res.status).toBe(201);
      const uuid = (JSON.parse(await res.text()) as { uuid: string }).uuid;
      const [row] = await query(db, `select token from cloud_provider_tokens where uuid = '${uuid}'`);
      expect(row!.token).not.toBe("hetzner-new-token");
      const plain = await withOrg(db, ORG_UUID[T1]!, (tx) => columnCipher(tx, ORG_UUID[T1]!, TEST_KEK, "cloud_provider_tokens.token").decrypt(String(row!.token)));
      expect(plain).toBe("hetzner-new-token");
      // Without read:sensitive the token is never answered.
      const shown = await send({ ...caseNamed("cloud tokens: show"), path: `/api/v1/cloud-tokens/${uuid}` }, db);
      expect(await shown.res.text()).not.toContain("hetzner-new-token");
    });
  });
});
