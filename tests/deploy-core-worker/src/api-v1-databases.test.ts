// Coolify's /api/v1 for the standalone databases and their backup schedules (DP-73), replayed against Coolify's real
// answers: fixtures/api/goldens.json, emitted by Coolify's PHP through its HTTP kernel on PostgreSQL (see
// fixtures/api/README.md). The fixture is made in Freeploy's own database (api-v1-database.ts: PGlite with the deploy
// schema at head, the rows made by Freeploy's insert functions — the eight engines, their volumes and Redis's
// variables, an S3 storage per team, four backup schedules and two executions), each request goes to
// deploy-core-worker's handler with the headers api-edge sends and runs the services on that database, and status
// and body are compared byte for byte after the masking both sides share; then the rows each write left. Each case is
// rolled back.
import { handleApiV1, type ApiV1Runners } from "@deploy-core-worker/api-v1/handler";
import type { Env } from "@deploy-core-worker/env";
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

/** The runners over the case's database, for team 1's org. */
function runners(db: TransactionalSqlExecutor, allow = true): Partial<ApiV1Runners> {
  return {
    sql: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, fn),
    rows: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, (tx) => fn((table, where, params) => apiRows(tx, table, where ?? null, params ?? []))),
    allows: async () => allow,
  };
}

const send = (c: Case, db: TransactionalSqlExecutor, allow = true) => {
  const req = forwarded(c);
  const path = new URL(req.url).pathname.replace(`/v1/internal/api-v1/${ORG_PUBLIC}`, "");
  return handleApiV1(req, env, "req_test", { subjectId: userPublic(tokenOf(c.token!).user), subjectType: "user" }, ORG_UUID[T1]!, ORG_PUBLIC, path, runners(db, allow));
};

const query = (db: TransactionalSqlExecutor, sql: string) =>
  withOrg(db, ORG_UUID[T1]!, async (tx) => {
    await tx.execute("SET LOCAL search_path TO deploy");
    return (await tx.execute(sql)).rows;
  });

/** The rows a write left: the case's `after` queries (what Coolify's rows were: the golden's `after`), on Freeploy's tables in the same transaction. */
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

/**
 * Departures: Freeploy's answer differs from Coolify's on purpose. What runs on a server needs the SSH executor
 * (DP-70's convention): Coolify queues the start, the restart, the proxy and the backup job and answers at once;
 * Freeploy refuses before it stores anything. And `exists:s3_storages,uuid` looks in every team in Coolify — it tells
 * a token that another team's storage exists — where Freeploy sees the org's storages only.
 */
const unavailable = (what: string) => ({ status: 501, body: `{"message":"${what} needs the SSH executor, which is not available yet."}` });
const DEPARTURES: Record<string, { status: number; body: string }> = {
  "databases: create, instant deploy": unavailable("Starting the database"),
  "databases: update, instant deploy": unavailable("Restarting the database"),
  "databases: update, public port taken": unavailable("Starting the database's TCP proxy on the server"),
  "databases: start": unavailable("Starting the database"),
  "databases: restart": unavailable("Restarting the database"),
  "backups: create, back up now": unavailable("Backing up the database"),
  "backups: update, back up now": unavailable("Backing up the database"),
  "backups: create, another team's storage": { status: 422, body: '{"message":"Validation failed.","errors":{"s3_storage_uuid":["The selected s3 storage uuid is invalid."]}}' },
};

/** The cases whose answer is the middleware's (tests/api-edge replays them). */
const MIDDLEWARE_ANSWERS = new Set(["databases: list, member with read:sensitive"]);
const GROUP = /^(databases|backups): /;
const OPERATION_CASES = CASES.cases.filter((c) => GROUP.test(c.name) && c.token && !MIDDLEWARE_ANSWERS.has(c.name));

describe("the goldens of DP-73", () => {
  it("cover the database and backup schedule operations", () => {
    expect(OPERATION_CASES.length).toBeGreaterThanOrEqual(140);
  });
});

describe("Freeploy answers as Coolify does (DP-73)", () => {
  it.each(OPERATION_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
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
    if (g.body.json !== undefined && !g.body.json.startsWith("{\n")) expect(maskedJson(got.body)).toBe(maskedJson(g.body.json));
    else expect(got.body).toBe(g.body.json ?? g.body.text);
  });
});

/** A departure's rows: Coolify stored, then queued what runs on the server; Freeploy refused before storing. */
const AFTER_DEPARTURES = new Set(["databases: update, instant deploy", "backups: create, back up now", "backups: update, back up now"]);
const AFTER_CASES = OPERATION_CASES.filter((c) => c.after && !AFTER_DEPARTURES.has(c.name));

describe("what a write leaves behind (DP-73)", () => {
  it("has the rows of every write", () => {
    expect(AFTER_CASES.length).toBeGreaterThanOrEqual(30);
  });

  it.each(AFTER_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const got = await replay(c, true);
    expect(got.after).toEqual(golden(name).after);
  });

  it.each([...AFTER_DEPARTURES])("%s (a departure: nothing is stored)", async (name) => {
    const c = caseNamed(name);
    const [before, after] = await fixture.inCase(async (db) => [await afterRows(db, c), (await send(c, db), await afterRows(db, c))]);
    expect(after).toEqual(before);
  });
});

describe("what Freeploy cannot do yet, and authorization (DP-73)", () => {
  it("answers 501 for deleting a database that may run on its server, and keeps it", async () => {
    const out = await fixture.inCase(async (db) => {
      await withOrg(db, ORG_UUID[T1]!, (tx) => tx.execute("UPDATE deploy.standalone_mysqls SET status = 'running:healthy', started_at = now() WHERE uuid = 'b4paritymysql00000000004'"));
      const res = await send({ ...caseNamed("databases: delete"), path: "/api/v1/databases/b4paritymysql00000000004" }, db);
      const left = await withOrg(db, ORG_UUID[T1]!, (tx) => apiRows(tx, "standalone_mysqls", "t.uuid = $1", ["b4paritymysql00000000004"]));
      return { status: res.status, body: await res.text(), left: left.length };
    });
    expect(out).toEqual({ status: 501, body: '{"message":"Stopping the database and removing its container, volumes and configuration files from the server needs the SSH executor, which is not available yet."}', left: 1 });
  });

  it("stops a running database only on the server, and makes a started one private only there", async () => {
    const out = await fixture.inCase(async (db) => {
      await withOrg(db, ORG_UUID[T1]!, (tx) => tx.execute("UPDATE deploy.standalone_postgresqls SET status = 'running:healthy', started_at = now() WHERE uuid = 'b1paritypostgres00000001'"));
      const stop = await send(caseNamed("databases: stop"), db);
      const start = await send(caseNamed("databases: start"), db);
      const priv = await send(caseNamed("databases: update, made private"), db);
      return [stop.status, await stop.text(), start.status, await start.text(), priv.status, await priv.text()];
    });
    expect(out).toEqual([
      501,
      '{"message":"Stopping the database needs the SSH executor, which is not available yet."}',
      400,
      '{"message":"Database is already running."}',
      501,
      `{"message":"Stopping the database's TCP proxy on the server needs the SSH executor, which is not available yet."}`,
    ]);
  });

  it("answers Laravel's 403 when policy-worker denies the token's user, after the 404 of an unknown database", async () => {
    const out = await fixture.inCase(async (db) => {
      const shown = await send(caseNamed("databases: show postgresql"), db, false);
      const created = await send(caseNamed("databases: create postgresql"), db, false);
      const unknown = await send(caseNamed("databases: update unknown"), db, false);
      const backups = await send(caseNamed("backups: create"), db, false);
      return [shown.status, await shown.text(), created.status, unknown.status, backups.status];
    });
    expect(out).toEqual([403, '{"message":"This action is unauthorized."}', 403, 404, 403]);
  });

  it("never returns a password to a token that may not read secrets", async () => {
    const got = await replay(caseNamed("databases: list"));
    for (const secret of ["pgSecretPass1", "redisSecretPass1", "mysqlRootPass1", "mongoSecretPass1", "clickhouseSecretPass1"]) expect(got.body).not.toContain(secret);
  });
});
