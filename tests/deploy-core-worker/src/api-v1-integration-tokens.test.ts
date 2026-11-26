// Coolify's /api/v1/security/integration-tokens (DP-104) — list, show, create, update, delete and sync-zones — replayed
// against Coolify's real answers: fixtures/api/goldens.json, emitted by Coolify's PHP through its HTTP kernel on PostgreSQL
// with Cloudflare's, Doppler's, Infisical's and Vault's APIs faked by Http::fake() (see fixtures/api/README.md). The
// fixture is made in Freeploy's own database (api-v1-database.ts), each request goes to deploy-core-worker's handler
// with the headers api-edge sends, the handler's fetch serves the same fake answers (a failed connection included), and
// the status, the body (byte for byte after the masking both sides share), the requests sent to the provider (the
// decrypted token, a Vault token's headers) and the rows each write left are compared. Each case is rolled back.
import { handleApiV1, type ApiV1Runners } from "@deploy-core-worker/api-v1/handler";
import type { Env } from "@deploy-core-worker/env";
import type { HostResolver } from "@deploy-core-worker/s3-storages/safe-url";
import { columnCipher } from "@deploy-core-worker/handlers/cloud-tokens";
import { apiRows, withOrg } from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { API_V1_HEADERS } from "@saas/contracts/coolify-api";
import { CASES, golden, maskedJson, type Case, type FixtureToken, type HttpRequestRecord } from "./api-v1-goldens.js";
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

/** The providers' APIs as emit.php fakes them: the case's answers (a failed connection throws, as fetch does), else a 404; every request recorded. */
function fakeFetch(c: Case, requests: HttpRequestRecord[]): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const text = typeof init?.body === "string" ? init.body : "";
    const header = (name: string) => (headers.get(name) !== null ? { [name]: headers.get(name)! } : {});
    requests.push({ method, url, ...header("authorization"), ...header("x-vault-token"), ...header("x-vault-namespace"), ...(text !== "" && { body: JSON.parse(text) as unknown }) });
    for (const a of c.http ?? []) {
      if (new RegExp(a.match).test(`${method} ${url}`)) {
        if (a.failedConnection) throw new TypeError("fetch failed");
        return new Response(a.raw !== undefined ? a.raw : JSON.stringify(a.body ?? []), { status: a.status ?? 200, headers: { "content-type": "application/json", ...a.headers } });
      }
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
  };
}

/** Host names as emit.php's SafeWebhookUrl::resolveHostsUsing() table resolves them (no DNS is asked). */
const resolve: HostResolver = async (host) => (host === "unresolvable.example" ? [] : host === "private.example" ? ["10.0.0.5"] : ["93.184.216.34"]);

type Allow = { read: boolean; write: boolean };
/** Every ability of IntegrationTokenPolicy is a team admin's: a member is answered as policy-worker answers a member's write. */
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
/** The paths routes/api.php has no route for: the fallback 404 (api-edge answers it; tests/api-edge replays them). */
const isFallback = (c: Case) => golden(c.name).body.json === '{"message":"Not found.","docs":"https:\\/\\/coolify.io\\/docs"}';
const DP104_CASES = CASES.cases.filter((c) => c.name.startsWith("integration tokens: ") && c.token && !isMiddleware(c));

describe("the goldens of DP-104", () => {
  it("cover every operation", () => {
    expect(CASES.cases.filter((c) => c.name.startsWith("integration tokens: ")).length).toBe(98);
    for (const prefix of ["integration tokens: list", "integration tokens: show", "integration tokens: create a cloudflare", "integration tokens: create a doppler", "integration tokens: create an infisical", "integration tokens: create a vault", "integration tokens: update", "integration tokens: delete", "integration tokens: sync zones"]) {
      expect(DP104_CASES.some((c) => c.name.startsWith(prefix))).toBe(true);
    }
    // Each provider's API was asked, a failed connection included.
    const urls = DP104_CASES.flatMap((c) => (golden(c.name).requests ?? []).map((r) => r.url));
    for (const host of ["api.cloudflare.com", "api.doppler.com", "app.infisical.com", "vault.example.com"]) expect(urls.some((u) => new URL(u).hostname === host)).toBe(true);
    expect(DP104_CASES.some((c) => (c.http ?? []).some((a) => a.failedConnection))).toBe(true);
  });
});

describe("Freeploy answers as Coolify does, and asks the provider what Coolify asks (DP-104)", () => {
  it.each(DP104_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const g = golden(name);
    const got = await replay(c);
    if (g.body.json !== undefined && process.env.API_DIFF && (maskedJson(got.body) !== maskedJson(g.body.json) || got.status !== g.status)) console.warn(`${name} ${got.status}/${g.status}\nfreeploy: ${maskedJson(got.body)}\ncoolify:  ${maskedJson(g.body.json)}`);
    expect(got.status).toBe(g.status);
    if (g.body.json !== undefined) expect(maskedJson(got.body)).toBe(maskedJson(g.body.json));
    else expect(got.body).toBe(g.body.text);
    if (!isFallback(c)) expect(got.requests).toEqual(g.requests ?? []);
  });
});

const AFTER_CASES = DP104_CASES.filter((c) => c.after);

describe("what a write leaves behind (DP-104)", () => {
  it("has the rows of the writes", () => {
    expect(AFTER_CASES.length).toBeGreaterThanOrEqual(40);
  });

  it.each(AFTER_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const got = await replay(c, true);
    if (process.env.API_DIFF && JSON.stringify(got.after) !== JSON.stringify(golden(name).after)) console.warn(`${name}\nfreeploy: ${JSON.stringify(got.after)}\ncoolify:  ${JSON.stringify(golden(name).after)}`);
    expect(got.after).toEqual(golden(name).after);
  });
});

describe("authorization, isolation and the secrets (DP-104)", () => {
  it("answers 403 when policy-worker denies the token's user, after the 404 of an unknown token, and asks no provider", async () => {
    const DENIED = { read: false, write: false };
    const out = await fixture.inCase(async (db) => {
      const results: Array<[number, number]> = [];
      for (const name of ["integration tokens: list", "integration tokens: show a cloudflare token", "integration tokens: create a cloudflare token", "integration tokens: update, a new cloudflare token", "integration tokens: delete a doppler token", "integration tokens: sync zones"]) {
        const { res, requests } = await send(caseNamed(name), db, DENIED);
        results.push([res.status, requests.length]);
      }
      for (const name of ["integration tokens: show unknown", "integration tokens: update unknown", "integration tokens: delete unknown", "integration tokens: sync zones, unknown"]) results.push([(await send(caseNamed(name), db, DENIED)).res.status, 0]);
      return { results, rows: await afterRows(db, caseNamed("integration tokens: sync zones")) };
    });
    expect(out.results).toEqual([...Array(6).fill([403, 0]), [404, 0], [404, 0], [404, 0], [404, 0]]);
    expect(out.rows).toEqual(await fixture.inCase((db) => afterRows(db, { ...caseNamed("integration tokens: sync zones"), setup: [] })));
  });

  it("never sees another team's token, nor its zones", async () => {
    await fixture.inCase(async (db) => {
      const { res } = await send(caseNamed("integration tokens: list"), db);
      const list = JSON.parse(await res.text()) as Array<{ uuid: string }>;
      expect(list.map((t) => t.uuid)).not.toContain("i6othercloudflare0000006");
      expect(list).toHaveLength(5);
      const zones = await query(db, "select name from dns_provider_zones order by id");
      expect(zones.map((z) => z.name)).toEqual(["example.com", "example.org", "example.net"]);
    });
  });

  it("stores a new token encrypted with the org's key, and never answers it", async () => {
    await fixture.inCase(async (db) => {
      const { res } = await send(caseNamed("integration tokens: create a doppler token"), db);
      expect(res.status).toBe(201);
      const uuid = (JSON.parse(await res.text()) as { uuid: string }).uuid;
      const [row] = await query(db, `select token from integration_tokens where uuid = '${uuid}'`);
      expect(row!.token).not.toBe("dp.sa.newtoken");
      const plain = await withOrg(db, ORG_UUID[T1]!, (tx) => columnCipher(tx, ORG_UUID[T1]!, TEST_KEK, "integration_tokens.token").decrypt(String(row!.token)));
      expect(plain).toBe("dp.sa.newtoken");
      for (const reader of ["read", "sensitive"]) {
        const shown = await send({ ...caseNamed("integration tokens: show a doppler token"), token: reader, path: `/api/v1/security/integration-tokens/${uuid}` }, db);
        const text = await shown.res.text();
        expect(text).not.toContain("dp.sa.newtoken");
        expect(text).not.toContain("metadata");
      }
    });
  });
});
