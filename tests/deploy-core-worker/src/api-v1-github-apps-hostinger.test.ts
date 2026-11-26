// Coolify's /api/v1 through a GitHub App and a Hostinger token (DP-93) — the installation's repositories, a repository's
// branches, an application from a private repository (POST /applications/private-github-app) and a Hostinger VPS bought and
// stored as a server (POST /servers/hostinger) — replayed against Coolify's real answers: fixtures/api/goldens.json, emitted
// by Coolify's PHP through its HTTP kernel on PostgreSQL with GitHub and Hostinger faked by Http::fake() (see
// fixtures/api/README.md). The fixture is made in Freeploy's own database (api-v1-database.ts), whose
// private keys are the committed test keys (the App signs with DP-72's RSA key), each request goes to deploy-core-worker's
// handler with the headers api-edge sends, the handler's fetch serves the same fake answers at emit.php's clock, and the
// status, the body (byte for byte after the masking both sides share), the requests sent to GitHub — the JWT of the
// token request among them — and the rows each write left are compared. Each case is rolled back.
import { handleApiV1, type ApiV1Runners } from "@deploy-core-worker/api-v1/handler";
import type { Env } from "@deploy-core-worker/env";
import type { HostResolver } from "@deploy-core-worker/s3-storages/safe-url";
import { APPLICATION_CREATE_MESSAGES } from "@deploy-core-worker/api-v1/application-create";
import { HOSTINGER_SERVER_MESSAGES } from "@deploy-core-worker/api-v1/hostinger-servers";
import { apiRows, withOrg } from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { API_V1_HEADERS } from "@saas/contracts/coolify-api";
import { CASES, golden, maskedJson, type Case, type FixtureToken, type HttpRequestRecord } from "./api-v1-goldens.js";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";

const ORG_PUBLIC = "org_" + "0".repeat(31) + "a";
const env = { ENVIRONMENT: "test", DEPLOY_ENCRYPTION_KEY: TEST_KEK, DEPLOY_CONSOLE_URL: "http://localhost" } as Env;
const T1 = 1;
/** emit.php's clock: the instant the App's JWT is issued at. */
const CLOCK = new Date("2026-01-01T00:00:00Z");

const tokenOf = (key: string): FixtureToken => CASES.fixture.tokens.find((t) => t.key === key)!;
const roleOf = (userId: number) => CASES.fixture.users.find((u) => u.id === userId)!.teams.find((t) => t.team === T1)?.role ?? null;
const isAdmin = (userId: number) => ["owner", "admin"].includes(roleOf(userId) ?? "");
const userPublic = (id: number) => `usr_${String(id).padStart(32, "0")}`;

function forwarded(c: Case): Request {
  const t = tokenOf(c.token!);
  const headers = new Headers({
    [API_V1_HEADERS.org]: ORG_PUBLIC,
    [API_V1_HEADERS.user]: userPublic(t.user),
    [API_V1_HEADERS.abilities]: t.abilities.join(","),
    [API_V1_HEADERS.canReadSensitive]: (t.abilities.includes("root") || t.abilities.includes("read:sensitive")) && isAdmin(t.user) ? "1" : "0",
  });
  let body: string | undefined;
  if (c.body !== undefined) {
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

/** GitHub as emit.php fakes it: the case's answers (the first whose `match` fits "METHOD URL"), else a 404; every request recorded. */
function fakeFetch(c: Case, requests: HttpRequestRecord[]): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const text = typeof init?.body === "string" ? init.body : "";
    requests.push({ method, url, ...(headers.get("authorization") !== null && { authorization: headers.get("authorization")! }), ...(text !== "" && { body: JSON.parse(text) as unknown }) });
    for (const a of c.http ?? []) {
      if (new RegExp(a.match).test(`${method} ${url}`)) return new Response(a.raw !== undefined ? a.raw : JSON.stringify(a.body ?? []), { status: a.status ?? 200, headers: { "content-type": "application/json", ...a.headers } });
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
  };
}

/** Host names as emit.php's SafeWebhookUrl::resolveHostsUsing() table resolves them (no DNS is asked). */
const resolve: HostResolver = async (host) => (host === "unresolvable.example" ? [] : host === "private.example" ? ["10.0.0.5"] : ["93.184.216.34"]);

function runners(db: TransactionalSqlExecutor, fetch: typeof globalThis.fetch): Partial<ApiV1Runners> {
  return {
    sql: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, fn),
    rows: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, (tx) => fn((table, where, params) => apiRows(tx, table, where ?? null, params ?? []))),
    allows: async () => true,
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

async function replay(c: Case) {
  return fixture.inCase(async (db) => {
    for (const sql of [...(c.setup ?? []), ...(c.setupFreeploy ?? [])]) await query(db, sql);
    const requests: HttpRequestRecord[] = [];
    const req = forwarded(c);
    const path = new URL(req.url).pathname.replace(`/v1/internal/api-v1/${ORG_PUBLIC}`, "");
    const res = await handleApiV1(req, env, "req_test", { subjectId: userPublic(tokenOf(c.token!).user), subjectType: "user" }, ORG_UUID[T1]!, ORG_PUBLIC, path, runners(db, fakeFetch(c, requests)));
    const after: Record<string, unknown[]> = {};
    for (const [label, sql] of Object.entries(c.after ?? {})) after[label] = await query(db, sql);
    return { status: res.status, body: await res.text(), retryAfter: res.headers.get("retry-after"), requests, after };
  });
}

const GROUP = /^(github repositories|github branches|github app create|server via Hostinger): /;
/** The middleware's answers (an ability api.ability refuses, a member's token beyond the member's access): tests/api-edge replays them. */
const MIDDLEWARE = /^\{"message":"(Missing required permissions: [a-z:]+|This API token has more access than you have in this team\. Revoke it and create a new token\.)"\}$/;
const DP93_CASES = CASES.cases.filter((c) => GROUP.test(c.name) && !MIDDLEWARE.test(golden(c.name).body.json ?? ""));

const executor = (what: string) => ({ status: 501, body: JSON.stringify({ message: what }) });
/**
 * Departures (DP-87's): where Coolify queues work on the server after the checks — the instant deploy and LoadComposeFile of a
 * Docker Compose application — Freeploy answers 501 in Coolify's envelope before anything is stored; GitHub was asked the same.
 */
const DEPARTURES: Record<string, { status: number; body: string }> = {
  "github app create: a GitHub App, instant deploy": executor(APPLICATION_CREATE_MESSAGES.deployUnavailable),
  "github app create: a GitHub App, Docker Compose": executor(APPLICATION_CREATE_MESSAGES.composeUnavailable),
  // ValidateNewCloudServerJob (over SSH), queued after the VPS is bought and the server stored: the rows are compared all the same.
  "server via Hostinger: create and validate": executor(HOSTINGER_SERVER_MESSAGES.validateUnavailable),
};

describe("the goldens of DP-93's GitHub App and Hostinger routes", () => {
  it("cover the repositories, the branches, the create and the Hostinger server, with the fixture's real keys", () => {
    expect(DP93_CASES.length).toBe(55);
    for (const prefix of ["github repositories: list", "github branches: list", "github app create: a GitHub App", "server via Hostinger: create"]) expect(DP93_CASES.some((c) => c.name.startsWith(prefix))).toBe(true);
    // The purchase's setup carries the public key of the fixture's ed25519 key, as Coolify derives it.
    const buy = (golden("server via Hostinger: create").requests ?? [])[1] as HttpRequestRecord;
    expect((buy.body as { setup: { public_key: { key: string } } }).setup.public_key.key).toMatch(/^ssh-ed25519 AAAA[A-Za-z0-9+/]+ $/);
    // The JWT Coolify signed with DP-72's RSA key is in the token request: an RS256 token of App 1003.
    const [first] = golden("github repositories: list").requests ?? [];
    const jwt = (first as HttpRequestRecord).authorization!.replace(/^Bearer /, "");
    expect(JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8"))).toEqual({ iss: "1003", iat: 1767225540, exp: 1767226080 });
  });
});

describe("Freeploy answers and asks GitHub as Coolify does (DP-93)", () => {
  it.each(DP93_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const g = golden(name);
    const got = await replay(c);
    expect(got.requests).toEqual(g.requests ?? []);
    if (DEPARTURES[name]) {
      expect({ status: got.status, body: got.body }).toEqual(DEPARTURES[name]);
      if (name.startsWith("server via Hostinger")) expect(got.after).toEqual(g.after);
      return;
    }
    if (process.env.API_DIFF && (got.status !== g.status || maskedJson(got.body) !== maskedJson(g.body.json ?? got.body))) console.warn(`${name} ${got.status}/${g.status}\nfreeploy: ${got.body.slice(0, 600)}\ncoolify:  ${(g.body.json ?? g.body.text ?? "").slice(0, 600)}`);
    expect(got.status).toBe(g.status);
    expect(got.retryAfter).toBe(g.headers["retry-after"] ?? null);
    if (g.body.json !== undefined) expect(maskedJson(got.body)).toBe(maskedJson(g.body.json));
    else expect(got.body).toBe(g.body.text);
    if (c.after) {
      if (process.env.API_DIFF && JSON.stringify(got.after) !== JSON.stringify(g.after)) console.warn(`${name}\nfreeploy: ${JSON.stringify(got.after)}\ncoolify:  ${JSON.stringify(g.after)}`);
      expect(got.after).toEqual(g.after);
    }
  });
});
