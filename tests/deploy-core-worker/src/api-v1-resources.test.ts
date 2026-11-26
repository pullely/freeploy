// Coolify's /api/v1 for applications and their environment variables (DP-71), replayed against Coolify's real
// answers: fixtures/api/goldens.json, emitted by Coolify's PHP through its HTTP kernel on PostgreSQL (see
// fixtures/api/README.md). Here the same fixture is made in Freeploy's own database (api-v1-database.ts: PGlite
// with the deploy schema at head, the rows made by Freeploy's insert functions), each request goes to
// deploy-core-worker's handler with the headers api-edge sends and runs the services on that database, and status
// and body are compared byte for byte after the masking both sides share. Each case is rolled back.
import { handleApiV1, type ApiV1Runners } from "@deploy-core-worker/api-v1/handler";
import { COOLIFY_COLUMNS } from "@deploy-core-worker/api-v1/columns";
import type { Env } from "@deploy-core-worker/env";
import { apiRows, withOrg } from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { API_V1_HEADERS } from "@saas/contracts/coolify-api";
import { CASES, GOLDENS, golden, maskedJson, type Case, type FixtureToken } from "./api-v1-goldens.js";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";

const ORG_PUBLIC = "org_" + "0".repeat(31) + "a";
const env = { ENVIRONMENT: "test", DEPLOY_ENCRYPTION_KEY: TEST_KEK } as Env;
const T1 = 1;

const tokenOf = (key: string): FixtureToken => CASES.fixture.tokens.find((t) => t.key === key)!;
const roleOf = (userId: number) => CASES.fixture.users.find((u) => u.id === userId)!.teams.find((t) => t.team === T1)?.role ?? null;
const isAdmin = (userId: number) => ["owner", "admin"].includes(roleOf(userId) ?? "");
const userPublic = (id: number) => `usr_${String(id).padStart(32, "0")}`;

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

/** The runners over the case's database, for team 1's org. */
function runners(db: TransactionalSqlExecutor, allow = true): Partial<ApiV1Runners> {
  return {
    sql: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, fn),
    rows: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, (tx) => fn((table, where, params) => apiRows(tx, table, where ?? null, params ?? []))),
    allows: async () => allow,
  };
}

async function replay(c: Case, after?: (db: TransactionalSqlExecutor) => Promise<unknown>): Promise<{ status: number; body: string; after: unknown }> {
  return fixture.inCase(async (db) => {
    // A case's `setup` (DP-74): the SQL emit.php runs before the request, on Freeploy's tables of the same names.
    for (const sql of c.setup ?? []) await withOrg(db, ORG_UUID[T1]!, async (tx) => (await tx.execute("SET LOCAL search_path TO deploy"), await tx.execute(sql)));
    const req = forwarded(c);
    const path = new URL(req.url).pathname.replace(`/v1/internal/api-v1/${ORG_PUBLIC}`, "");
    const res = await handleApiV1(req, env, "req_test", { subjectId: userPublic(tokenOf(c.token!).user), subjectType: "user" }, ORG_UUID[T1]!, ORG_PUBLIC, path, runners(db));
    return { status: res.status, body: await res.text(), after: after ? await after(db) : undefined };
  });
}

/** The cases whose answer is the middleware's (tests/api-edge replays them). */
const MIDDLEWARE_ANSWERS = new Set(["application envs: list, member with read:sensitive"]);
/**
 * Departures: Freeploy's answer differs from Coolify's on purpose. What runs on the server needs the SSH executor
 * (DP-70's convention): Coolify queues the deployment, the restart and the stop (and its logs need a running
 * container, which the fixture's unreachable server has not: its 500 is the SSH error).
 */
const DEPARTURES: Record<string, { status: number; body: string }> = {
  "applications: logs": { status: 501, body: `{"message":"Reading the application's container logs needs the SSH executor, which is not available yet."}` },
  "applications: start": { status: 501, body: '{"message":"Deploying the application needs the SSH executor, which is not available yet."}' },
  "applications: restart": { status: 501, body: '{"message":"Restarting the application needs the SSH executor, which is not available yet."}' },
  "applications: stop": { status: 501, body: '{"message":"Stopping the application needs the SSH executor, which is not available yet."}' },
};

const GROUP = /^(applications|application envs): /;
const OPERATION_CASES = CASES.cases.filter((c) => GROUP.test(c.name) && c.token && !MIDDLEWARE_ANSWERS.has(c.name));

describe("the goldens of DP-71", () => {
  it("cover the application operations", () => {
    expect(OPERATION_CASES.length).toBeGreaterThanOrEqual(50);
  });

  it("give Coolify's column order, which the worker's COOLIFY_COLUMNS holds", () => {
    expect(COOLIFY_COLUMNS).toEqual(GOLDENS.columns);
  });
});

describe("Freeploy answers as Coolify does (DP-71)", () => {
  it.each(OPERATION_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const g = golden(name);
    const got = await replay(c);
    if (DEPARTURES[name]) {
      expect({ status: got.status, body: got.body }).toEqual(DEPARTURES[name]);
      return;
    }
    expect(got.status).toBe(g.status);
    if (g.body.json !== undefined && process.env.API_DIFF) {
      const [a, b] = [maskedJson(got.body), maskedJson(g.body.json)];
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      if (a !== b) console.warn(`${name} @${i}\nfreeploy: ${a.slice(Math.max(0, i - 120), i + 200)}\ncoolify:  ${b.slice(Math.max(0, i - 120), i + 200)}`);
    }
    if (g.body.json !== undefined) expect(maskedJson(got.body)).toBe(maskedJson(g.body.json));
    else expect(got.body).toBe(g.body.text);
  });
});

describe("what Freeploy cannot do yet, and authorization (DP-71)", () => {
  const send = (c: Case, db: TransactionalSqlExecutor, allow = true) => {
    const req = forwarded(c);
    const path = new URL(req.url).pathname.replace(`/v1/internal/api-v1/${ORG_PUBLIC}`, "");
    return handleApiV1(req, env, "r", { subjectId: userPublic(tokenOf(c.token!).user), subjectType: "user" }, ORG_UUID[T1]!, ORG_PUBLIC, path, runners(db, allow));
  };
  const caseNamed = (name: string) => CASES.cases.find((c) => c.name === name)!;

  it("answers 501 for deleting an application that may run on its server (DeleteResourceJob needs the SSH executor), and keeps it", async () => {
    const out = await fixture.inCase(async (db) => {
      await withOrg(db, ORG_UUID[T1]!, (tx) => tx.execute("UPDATE deploy.applications SET status = 'running:healthy' WHERE uuid = 'a1parityimageapp00000001'"));
      const res = await send(caseNamed("applications: delete with options"), db);
      const left = await withOrg(db, ORG_UUID[T1]!, (tx) => apiRows(tx, "applications", "t.uuid = $1", ["a1parityimageapp00000001"]));
      return { status: res.status, body: await res.text(), left: left.length };
    });
    expect(out).toEqual({
      status: 501,
      body: '{"message":"Stopping the application and removing its containers, volumes, networks and configuration files from the server needs the SSH executor, which is not available yet."}',
      left: 1,
    });
  });

  it("answers Laravel's 403 when policy-worker denies the token's user, after the 404 of an unknown application", async () => {
    const out = await fixture.inCase(async (db) => {
      const shown = await send(caseNamed("applications: show"), db, false);
      const created = await send(caseNamed("application envs: create"), db, false);
      const unknown = await send(caseNamed("application envs: create in unknown"), db, false);
      return [shown.status, await shown.text(), created.status, unknown.status];
    });
    expect(out).toEqual([403, '{"message":"This action is unauthorized."}', 403, 404]);
  });

  it("never returns a locked variable's value, even to a root token", async () => {
    const got = await replay(caseNamed("application envs: update a locked variable"));
    expect(got.body).not.toContain("new secret");
    expect(got.body).not.toContain('"value"');
  });
});

/** Coolify soft-deletes the application and queues DeleteResourceJob; Freeploy removes the rows of one nothing was deployed of at once. */
const AFTER_DEPARTURES: Record<string, Record<string, unknown[]>> = {
  "applications: delete": { applications: [{ uuid: "a1parityimageapp00000001", deleted: false }] },
};
/** The rows a write left: the case's `after` queries (what Coolify's rows were: the golden's `after`), run on Freeploy's tables in the same transaction. */
const AFTER_CASES = OPERATION_CASES.filter((c) => c.after && !(c.name in AFTER_DEPARTURES));

describe("what a write leaves behind (DP-71)", () => {
  const query = (db: TransactionalSqlExecutor, sql: string) =>
    withOrg(db, ORG_UUID[T1]!, async (tx) => {
      await tx.execute("SET LOCAL search_path TO deploy");
      return (await tx.execute(sql)).rows;
    });
  const afterRows = (name: string) => async (db: TransactionalSqlExecutor) => {
    const out: Record<string, unknown[]> = {};
    for (const [label, sql] of Object.entries(CASES.cases.find((c) => c.name === name)!.after ?? {})) out[label] = await query(db, sql);
    return out;
  };

  it("has the rows of every write", () => {
    expect(AFTER_CASES.length).toBeGreaterThanOrEqual(8);
  });

  it.each(AFTER_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const got = await replay(c, afterRows(name));
    expect(got.after).toEqual(golden(name).after);
  });

  it.each(Object.entries(AFTER_DEPARTURES))("%s (a departure)", async (name, rows) => {
    const got = await replay(CASES.cases.find((c) => c.name === name)!, afterRows(name));
    expect(got.after).toEqual(rows);
  });
});
