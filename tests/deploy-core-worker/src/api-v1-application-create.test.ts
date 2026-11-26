// Coolify's /api/v1 continued (DP-87) — creating an application from a Docker image, a Dockerfile, a public repository and
// a repository with a deploy key — replayed against Coolify's real answers:
// fixtures/api/goldens.json, emitted by Coolify's PHP through its HTTP kernel on PostgreSQL (see fixtures/api/README.md).
// The fixture is made in Freeploy's own database (api-v1-database.ts), each request goes to deploy-core-worker's handler
// with the headers api-edge sends, and status and body are compared byte for byte after the masking both sides share;
// then the rows each write left. Each case is rolled back.
import { handleApiV1, type ApiV1Runners } from "@deploy-core-worker/api-v1/handler";
import type { Env } from "@deploy-core-worker/env";
import type { HostResolver } from "@deploy-core-worker/s3-storages/safe-url";
import { apiRows, withOrg } from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { API_V1_HEADERS } from "@saas/contracts/coolify-api";
import { CASES, golden, maskedJson, type Case, type FixtureToken } from "./api-v1-goldens.js";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";

const ORG_PUBLIC = "org_" + "0".repeat(31) + "a";
const env = { ENVIRONMENT: "test", DEPLOY_ENCRYPTION_KEY: TEST_KEK } as Env;
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

/** Host names as emit.php's SafeWebhookUrl::resolveHostsUsing() table resolves them (no DNS is asked). */
const resolve: HostResolver = async (host) => (host === "unresolvable.example" ? [] : host === "private.example" ? ["10.0.0.5"] : ["93.184.216.34"]);

/** The runners over the case's database, for team 1's org. */
function runners(db: TransactionalSqlExecutor, allow = true): Partial<ApiV1Runners> {
  return {
    sql: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, fn),
    rows: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, (tx) => fn((table, where, params) => apiRows(tx, table, where ?? null, params ?? []))),
    allows: async () => allow,
    org: async () => ({ id: ORG_PUBLIC, name: "Parity Team", createdAt: "2026-01-01T00:00:00.000Z" }),
    s3: {
      resolve,
      http: async (url) => {
        throw new Error(`no request expected: ${url}`);
      },
      sleep: async () => undefined,
    },
  };
}

const query = (db: TransactionalSqlExecutor, sql: string) =>
  withOrg(db, ORG_UUID[T1]!, async (tx) => {
    await tx.execute("SET LOCAL search_path TO deploy");
    return (await tx.execute(sql)).rows;
  });

const send = async (c: Case, db: TransactionalSqlExecutor, allow = true) => {
  for (const sql of [...(c.setup ?? []), ...(c.setupFreeploy ?? [])]) await query(db, sql);
  const req = forwarded(c);
  const path = new URL(req.url).pathname.replace(`/v1/internal/api-v1/${ORG_PUBLIC}`, "");
  return handleApiV1(req, env, "req_test", { subjectId: userPublic(tokenOf(c.token!).user), subjectType: "user" }, ORG_UUID[T1]!, ORG_PUBLIC, path, runners(db, allow));
};

async function afterRows(db: TransactionalSqlExecutor, c: Case): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const [label, sql] of Object.entries(c.after ?? {})) out[label] = await query(db, sql);
  return out;
}

async function replay(c: Case, withAfter = false): Promise<{ status: number; body: string; after: unknown }> {
  return fixture.inCase(async (db) => {
    const res = await send(c, db);
    return { status: res.status, body: await res.text(), after: withAfter ? await afterRows(db, c) : undefined };
  });
}

/** The cases whose answer is the middleware's (tests/api-edge replays them). */
const MIDDLEWARE_ANSWERS = new Set(["app create: a read token", "app create: a member", "app create: a deploy key, a member", "app update: a read token"]);
const GROUP = /^app (create|update): /;

const executor = (what: string) => ({ status: 501, body: `{"message":"${what} needs the SSH executor, which is not available yet."}` });
/**
 * Departures: where Coolify queues work on the server — the instant deploy (queue_application_deployment(); the emitter
 * fakes the queue, so Coolify's golden is its 201) and LoadComposeFile of a Docker Compose application (its golden is the
 * 201 before the job runs) — Freeploy answers 501 in Coolify's envelope, after Coolify's own checks and before anything is
 * stored.
 */
const DEPARTURES: Record<string, { status: number; body: string }> = {
  "app create: instant deploy": executor("Deploying the application"),
  "app create: a deploy key, instant deploy": executor("Deploying the application"),
  "app create: a public repository, Docker Compose": executor("Loading the Docker Compose file of the application"),
  // Coolify saves the changes, then finds a deployment already queued (its golden is that 200).
  "app update: instant deploy": executor("Deploying the application"),
};
const CREATE_CASES = CASES.cases.filter((c) => GROUP.test(c.name) && c.token && !MIDDLEWARE_ANSWERS.has(c.name));

describe("the goldens of DP-87", () => {
  it("cover the create types and the update ported", () => {
    expect(CREATE_CASES.length).toBeGreaterThanOrEqual(90);
    for (const type of ["dockerimage", "dockerfile", "public", "private-deploy-key"]) expect(CREATE_CASES.some((c) => c.path === `/api/v1/applications/${type}`)).toBe(true);
    expect(CREATE_CASES.filter((c) => c.method === "PATCH").length).toBeGreaterThanOrEqual(60);
  });
});

describe("Freeploy answers as Coolify does (DP-87)", () => {
  it.each(CREATE_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const g = golden(name);
    const got = await replay(c);
    if (DEPARTURES[name]) {
      expect({ status: got.status, body: got.body }).toEqual(DEPARTURES[name]);
      return;
    }
    if (g.body.json !== undefined && process.env.API_DIFF) {
      const [a, b] = [maskedJson(got.body), maskedJson(g.body.json)];
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      if (a !== b) console.warn(`${name} @${i}\nfreeploy: ${a.slice(Math.max(0, i - 160), i + 240)}\ncoolify:  ${b.slice(Math.max(0, i - 160), i + 240)}`);
    }
    expect(got.status).toBe(g.status);
    if (g.body.json !== undefined) expect(maskedJson(got.body)).toBe(maskedJson(g.body.json));
    else expect(got.body).toBe(g.body.text);
  });
});

const AFTER_CASES = CREATE_CASES.filter((c) => c.after && !DEPARTURES[c.name]);

describe("what a create or an update leaves behind (DP-87)", () => {
  it("has the rows of every create", () => {
    expect(AFTER_CASES.length).toBeGreaterThanOrEqual(30);
  });

  it.each(AFTER_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const got = await replay(c, true);
    if (process.env.API_DIFF && JSON.stringify(got.after) !== JSON.stringify(golden(name).after)) console.warn(`${name}\nfreeploy: ${JSON.stringify(got.after)}\ncoolify:  ${JSON.stringify(golden(name).after)}`);
    expect(got.after).toEqual(golden(name).after);
  });

  it.each(Object.keys(DEPARTURES).filter((name) => caseNamed(name).after))("%s (a departure: nothing is stored)", async (name) => {
    const c = caseNamed(name);
    const [before, after] = await fixture.inCase(async (db) => {
      for (const sql of [...(c.setup ?? []), ...(c.setupFreeploy ?? [])]) await query(db, sql);
      return [await afterRows(db, c), (await send(c, db), await afterRows(db, c))];
    });
    expect(after).toEqual(before);
  });
});

describe("authorization and the secrets (DP-87)", () => {
  it("answers Laravel's 403 when policy-worker denies the token's user, after the 404s of the project and environment, and creates nothing", async () => {
    const out = await fixture.inCase(async (db) => {
      const created = await send(caseNamed("app create: a Docker image"), db, false);
      const project = await send(caseNamed("app create: unknown project"), db, false);
      const environment = await send(caseNamed("app create: unknown environment"), db, false);
      const key = await send(caseNamed("app create: a deploy key"), db, false);
      const updated = await send(caseNamed("app update: name and description"), db, false);
      const unknown = await send(caseNamed("app update: unknown application"), db, false);
      return [created.status, await created.text(), project.status, environment.status, key.status, updated.status, unknown.status, await afterRows(db, caseNamed("app create: instant deploy")), await afterRows(db, caseNamed("app update: name and description"))];
    });
    expect(out.slice(0, 7)).toEqual([403, '{"message":"This action is unauthorized."}', 404, 404, 403, 403, 404]);
    expect(out[7]).toEqual({ applications: [{ created: 0 }] });
    expect(out[8]).toEqual(await fixture.inCase((db) => afterRows(db, caseNamed("app update: name and description"))));
  });

  it("stores the request's HTTPS password encrypted, and never finds another team's key", async () => {
    await fixture.inCase(async (db) => {
      const res = await send(caseNamed("app create: a public repository, HTTPS credentials"), db);
      expect(res.status).toBe(201);
      const uuid = (JSON.parse(await res.text()) as { uuid: string }).uuid;
      const [row] = await query(db, `select git_https_password from applications where uuid = '${uuid}'`);
      expect(row!.git_https_password).not.toBe("token-123");
      expect(String(row!.git_https_password).length).toBeGreaterThan(20);
      expect((await send(caseNamed("app create: a deploy key of another team"), db)).status).toBe(404);
    });
  });
});
