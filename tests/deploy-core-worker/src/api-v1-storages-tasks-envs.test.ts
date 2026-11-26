// Coolify's /api/v1 continued (DP-84) — the storages of an application, a database and a service, the scheduled tasks of
// an application and of a service, a database's environment variables and the team's shared variables —
// replayed against Coolify's real answers: fixtures/api/goldens.json, emitted by Coolify's PHP through its HTTP kernel on
// PostgreSQL (see fixtures/api/README.md). The fixture is made in Freeploy's own database (api-v1-database.ts), each
// request goes to deploy-core-worker's handler with the headers api-edge sends, and status and body are compared byte
// for byte after the masking both sides share; then the rows each write left. Each case is rolled back.
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
    org: async () => ({ id: ORG_PUBLIC, name: "Parity Team", createdAt: "2026-01-01T00:00:00.000Z" }),
  };
}

const query = (db: TransactionalSqlExecutor, sql: string) =>
  withOrg(db, ORG_UUID[T1]!, async (tx) => {
    await tx.execute("SET LOCAL search_path TO deploy");
    return (await tx.execute(sql)).rows;
  });

const send = async (c: Case, db: TransactionalSqlExecutor, allow = true) => {
  for (const sql of c.setup ?? []) await query(db, sql);
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
const MIDDLEWARE_ANSWERS = new Set(["application scheduled tasks: create with a delete token"]);
const GROUP = /^(application storages|database storages|service storages|application scheduled tasks|service scheduled tasks|database envs|team envs): /;
const OPERATION_CASES = CASES.cases.filter((c) => GROUP.test(c.name) && c.token && !MIDDLEWARE_ANSWERS.has(c.name));

const executor = (what: string) => ({ status: 501, body: `{"message":"${what} needs the SSH executor, which is not available yet."}` });
/**
 * Departures: Freeploy's answer differs from Coolify's on purpose. Where Coolify writes to the server — a managed file's
 * content (the job it queues: the emitter fakes it, so Coolify's golden is its 201 or 200), the path check of a directory
 * or of a file's source path, deleting a mount inside the resource directory (over SSH: the emitter has none, so Coolify's
 * golden is its own failure, a 422 or a 500) — Freeploy answers 501 in Coolify's envelope, after Coolify's own refusals and
 * before anything is stored.
 */
const DEPARTURES: Record<string, { status: number; body: string }> = {
  ...Object.fromEntries(
    ["application", "database", "service"].flatMap((g) => [
      [`${g} storages: create a directory inside`, executor("Checking the path on the server")],
      [`${g} storages: create a file`, executor("Writing the file to the server")],
      [`${g} storages: delete a file inside`, executor("Deleting the mount from the server")],
    ]),
  ),
  "application storages: create a file with content": executor("Writing the file to the server"),
  "application storages: update a file's content": executor("Writing the file to the server"),
};

describe("the goldens of DP-84", () => {
  it("cover the operations ported", () => {
    expect(OPERATION_CASES.length).toBeGreaterThanOrEqual(150);
  });
});

describe("Freeploy answers as Coolify does (DP-84)", () => {
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

const AFTER_CASES = OPERATION_CASES.filter((c) => c.after && !DEPARTURES[c.name]);

describe("what a write leaves behind (DP-84)", () => {
  it("has the rows of every write", () => {
    expect(AFTER_CASES.length).toBeGreaterThanOrEqual(40);
  });

  it.each(AFTER_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const got = await replay(c, true);
    expect(got.after).toEqual(golden(name).after);
  });

  it.each(Object.keys(DEPARTURES).filter((name) => caseNamed(name).after))("%s (a departure: nothing is stored)", async (name) => {
    const c = caseNamed(name);
    const [before, after] = await fixture.inCase(async (db) => [await afterRows(db, c), (await send(c, db), await afterRows(db, c))]);
    expect(after).toEqual(before);
  });
});

describe("authorization and the other team (DP-84)", () => {
  it("answers the exception handler's 403 (DP-93) when policy-worker denies the token's user, after the 404 of an unknown resource", async () => {
    const out = await fixture.inCase(async (db) => {
      const listed = await send(caseNamed("application storages: list"), db, false);
      const unknown = await send(caseNamed("application storages: list of unknown"), db, false);
      const created = await send(caseNamed("team envs: create"), db, false);
      const tasks = await send(caseNamed("service scheduled tasks: list"), db, false);
      return [listed.status, await listed.text(), unknown.status, created.status, tasks.status];
    });
    expect(out).toEqual([403, '{"message":"You are not authorized to perform this action.","error":"Unauthorized"}', 404, 403, 403]);
  });

  it("never lists, changes or deletes another team's storages, tasks or variables", async () => {
    await fixture.inCase(async (db) => {
      await send(caseNamed("application storages: delete another team's"), db);
      await send(caseNamed("application scheduled tasks: delete another team's"), db);
      await send(caseNamed("team envs: delete another team's"), db);
      const theirs = await withOrg(db, ORG_UUID[2]!, async (tx) => [
        (await tx.execute("SELECT uuid FROM deploy.local_persistent_volumes WHERE resource_type = 'App\\Models\\Application' ORDER BY id")).rows,
        (await tx.execute("SELECT uuid FROM deploy.scheduled_tasks")).rows,
        (await tx.execute("SELECT key FROM deploy.shared_environment_variables WHERE type = 'team'")).rows,
      ]);
      expect(theirs).toEqual([[{ uuid: "l3otherappvolume00000003" }], [{ uuid: "n4otherteamtask000000004" }], [{ key: "OTHER_TEAM" }]]);
    });
    const listed = await replay(caseNamed("team envs: list, read:sensitive"));
    expect(listed.body).not.toContain("OTHER_TEAM");
  });
});
