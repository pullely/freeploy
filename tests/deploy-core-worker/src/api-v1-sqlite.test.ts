// Coolify's /api/v1 for SQLite, the ninth standalone database engine (DP-112) — POST /databases/sqlite and SQLite in the
// database operations Coolify extends to it — replayed against Coolify's real answers: fixtures/api/goldens.json, emitted
// by Coolify's PHP through its HTTP kernel on PostgreSQL (see fixtures/api/README.md). The fixture is made in Freeploy's
// own database (api-v1-database.ts); a case's SQLite database, with its data volume, is a row of its `setupCoolify` and
// `setupFreeploy`. Each request goes to deploy-core-worker's handler with the headers api-edge sends, and the status, the
// body (byte for byte after the masking both sides share) and the rows each write left are compared. Each case is rolled
// back.
import { handleApiV1, type ApiV1Runners } from "@deploy-core-worker/api-v1/handler";
import type { Env } from "@deploy-core-worker/env";
import { DATABASE_SERVICE_MESSAGES } from "@deploy-core-worker/databases/service";
import { runInOrgOn as projectsOn } from "@deploy-core-worker/handlers/projects";
import { apiRows, withOrg } from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { API_V1_HEADERS } from "@saas/contracts/coolify-api";
import { CASES, golden, maskedJson, type Case, type FixtureToken } from "./api-v1-goldens.js";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";

const ORG_PUBLIC = "org_" + "0".repeat(31) + "a";
const env = { ENVIRONMENT: "test", DEPLOY_ENCRYPTION_KEY: TEST_KEK, DEPLOY_CONSOLE_URL: "http://localhost" } as Env;
const T1 = 1;

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

function runners(db: TransactionalSqlExecutor): Partial<ApiV1Runners> {
  return {
    projects: projectsOn(db),
    sql: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, fn),
    rows: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, (tx) => fn((table, where, params) => apiRows(tx, table, where ?? null, params ?? []))),
    allows: async () => true,
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
    const t = tokenOf(c.token!);
    const req = forwarded(c);
    const path = new URL(req.url).pathname.replace(`/v1/internal/api-v1/${ORG_PUBLIC}`, "");
    const res = await handleApiV1(req, env, "req_test", { subjectId: userPublic(t.user), subjectType: "user" }, ORG_UUID[T1]!, ORG_PUBLIC, path, runners(db));
    const after: Record<string, unknown[]> = {};
    for (const [label, sql] of Object.entries(c.after ?? {})) after[label] = await query(db, sql);
    return { status: res.status, body: await res.text(), after };
  });
}

const GROUP = /^sqlite: /;
/** The middleware's answers (an ability api.ability refuses): tests/api-edge replays them. */
const MIDDLEWARE = /^\{\s*"message":\s*"Missing required permissions: [a-z:]+"\s*\}$/;
const DP112_CASES = CASES.cases.filter((c) => GROUP.test(c.name) && !MIDDLEWARE.test(golden(c.name).body.json ?? ""));

/**
 * Departures: what runs on a server needs the SSH executor (DP-70's convention). Coolify queues the start, the restart and
 * the stop and answers at once; Freeploy refuses before it stores anything.
 */
const unavailable = (message: string) => ({ status: 501, body: JSON.stringify({ message }) });
const DEPARTURES: Record<string, { status: number; body: string }> = {
  "sqlite: create, instant deploy": unavailable(DATABASE_SERVICE_MESSAGES.startUnavailable),
  "sqlite: update, instant deploy": unavailable(DATABASE_SERVICE_MESSAGES.restartUnavailable),
  "sqlite: start": unavailable(DATABASE_SERVICE_MESSAGES.startUnavailable),
  "sqlite: restart": unavailable(DATABASE_SERVICE_MESSAGES.restartUnavailable),
  "sqlite: stop a running one": unavailable(DATABASE_SERVICE_MESSAGES.stopUnavailable),
};

describe("the goldens of DP-112's SQLite", () => {
  it("cover creating one and the database operations Coolify extends to it", () => {
    expect(DP112_CASES.length).toBe(46);
    // GET /databases and GET /resources list it after the other engines, as Project::databases() and DATABASE_TYPES do.
    const listed = JSON.parse(golden("sqlite: list").body.json!) as Array<{ database_type: string }>;
    expect(listed.at(-1)!.database_type).toBe("standalone-sqlite");
    const resources = JSON.parse(golden("sqlite: resources").body.json!) as Array<{ type: string }>;
    expect(resources.at(-1)!.type).toBe("standalone-sqlite");
  });
});

describe("Freeploy answers as Coolify does for SQLite (DP-112)", () => {
  it.each(DP112_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const g = golden(name);
    const got = await replay(c);
    if (DEPARTURES[name]) {
      expect({ status: got.status, body: got.body }).toEqual(DEPARTURES[name]);
      return;
    }
    if (process.env.API_DIFF && (got.status !== g.status || maskedJson(got.body) !== maskedJson(g.body.json ?? got.body))) {
      const [a, b] = [maskedJson(got.body), maskedJson(g.body.json ?? "")];
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      console.warn(`${name} ${got.status}/${g.status} @${i}\nfreeploy: ${a.slice(Math.max(0, i - 200), i + 300)}\ncoolify:  ${b.slice(Math.max(0, i - 200), i + 300)}`);
    }
    expect(got.status).toBe(g.status);
    if (g.body.json !== undefined && !g.body.json.startsWith("{\n")) expect(maskedJson(got.body)).toBe(maskedJson(g.body.json));
    else expect(got.body).toBe(g.body.json ?? g.body.text);
    if (c.after) {
      if (process.env.API_DIFF && JSON.stringify(got.after) !== JSON.stringify(g.after)) console.warn(`${name}\nfreeploy: ${JSON.stringify(got.after)}\ncoolify:  ${JSON.stringify(g.after)}`);
      expect(got.after).toEqual(g.after);
    }
  });

  it("stores nothing for the departures", async () => {
    const c = CASES.cases.find((x) => x.name === "sqlite: create, instant deploy")!;
    const got = await replay({ ...c, after: { database: "select count(*)::int as n from standalone_sqlites" } });
    expect(got.after).toEqual({ database: [{ n: 0 }] });
  });
});
