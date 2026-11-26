// Coolify's /api/v1 continued (DP-78) — every resource of the team (GET /resources) and an environment's resources
// (GET /projects/{uuid}/{environment_name_or_uuid}) — replayed against Coolify's real answers: fixtures/api/goldens.json,
// emitted by Coolify's PHP through its HTTP kernel on PostgreSQL (see fixtures/api/README.md). The fixture is made in
// Freeploy's own database (api-v1-database.ts), each request goes to deploy-core-worker's handler with the headers
// api-edge sends, and status and body are compared byte for byte after the masking both sides share; then the rows each
// write left. Each case is rolled back. (The deployments in progress and one deployment are replayed with DP-74's
// deployments, api-v1-services.test.ts.)
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

/** The runners over the case's database, for team 1's org (membership-worker's answer: the fixture's team). */
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

/**
 * Departures: Freeploy's answer differs from Coolify's on purpose. What runs on a server needs the SSH executor (DP-70's
 * convention): Freeploy answers 501 before it stores anything, where Coolify queues DeleteServer (which deletes the
 * resources on the server) or ValidateServer, or runs AuthorizedKeys::remove() over SSH (the emitter has no ssh, so
 * Coolify's answer there is its own failure).
 */
const unavailable = (what: string) => ({ status: 501, body: `{"message":"${what} needs the SSH executor, which is not available yet."}` });
const DEPARTURES: Record<string, { status: number; body: string }> = {
  "servers: delete one with resources, forced": unavailable("Deleting the resources on the server"),
  "servers: delete, removing the ssh key": unavailable("Removing the SSH key from the server"),
  "servers: create, validating at once": unavailable("Validating the server"),
};

/** The cases whose answer is the middleware's (tests/api-edge replays them). */
const MIDDLEWARE_ANSWERS = new Set(["resources: list with a write-only token", "servers: delete with a read token", "servers: create with a read token"]);
const GROUP = /^(resources|environment details|server resources|server domains): |^servers: (create|delete|show with resources|resources$|domains$)/;
const OPERATION_CASES = CASES.cases.filter((c) => GROUP.test(c.name) && c.token && !MIDDLEWARE_ANSWERS.has(c.name));

describe("the goldens of DP-78", () => {
  it("cover the operations ported", () => {
    expect(OPERATION_CASES.length).toBeGreaterThanOrEqual(10);
  });
});

describe("Freeploy answers as Coolify does (DP-78)", () => {
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
const AFTER_DEPARTURES = new Set(["servers: delete one with resources, forced", "servers: create, validating at once"]);
const AFTER_CASES = OPERATION_CASES.filter((c) => c.after && !AFTER_DEPARTURES.has(c.name));

describe("what a write leaves behind (DP-78)", () => {
  it("has the rows of every write", () => {
    expect(AFTER_CASES.length).toBeGreaterThanOrEqual(13);
  });

  it.each(AFTER_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const got = await replay(c, true);
    expect(got.after).toEqual(golden(name).after);
  });

  it.each([...AFTER_DEPARTURES])("%s (a departure: nothing is stored)", async (name) => {
    const c = caseNamed(name);
    const [before, after] = await fixture.inCase(async (db) => {
      for (const sql of c.setup ?? []) await query(db, sql);
      return [await afterRows(db, c), (await send({ ...c, setup: [] }, db), await afterRows(db, c))];
    });
    expect(after).toEqual(before);
  });
});

describe("authorization and secrets (DP-78)", () => {
  it("answers the exception handler's 403 (DP-93) when policy-worker denies the token's user, after the 404 of an unknown project", async () => {
    const out = await fixture.inCase(async (db) => {
      const shown = await send(caseNamed("environment details: by name"), db, false);
      const unknown = await send(caseNamed("environment details: unknown project"), db, false);
      return [shown.status, await shown.text(), unknown.status];
    });
    expect(out).toEqual([403, '{"message":"You are not authorized to perform this action.","error":"Unauthorized"}', 404]);
  });

  it("never returns a secret to a token that may not read secrets", async () => {
    for (const name of ["resources: list", "resources: list, member", "environment details: by name"]) {
      const got = await replay(caseNamed(name));
      for (const secret of ["pgSecretPass1", "redisSecretPass1", "dbSecretPass1", "_password\"", "internal_db_url"]) expect(got.body).not.toContain(secret);
    }
  });

  it("finds no rows of another team", async () => {
    const got = await replay(caseNamed("resources: list, read:sensitive"));
    for (const theirs of ["a3otherteamapp0000000003", "b9otherpostgres000000009", "f2otherservice0000000002"]) expect(got.body).not.toContain(theirs);
    await fixture.inCase(async (db) => {
      expect((await withOrg(db, ORG_UUID[T1]!, (tx) => apiRows(tx, "applications", "t.uuid = $1", ["a3otherteamapp0000000003"]))).length).toBe(0);
    });
  });
});
