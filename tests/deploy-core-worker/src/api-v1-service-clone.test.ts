// Coolify's POST /api/v1/services/{uuid}/clone (DP-108: clone_service()) replayed against Coolify's real answers:
// fixtures/api/goldens.json, emitted by Coolify's PHP through its HTTP kernel on PostgreSQL (see fixtures/api/README.md).
// The fixture is made in Freeploy's own database (api-v1-database.ts), each request goes to deploy-core-worker's handler
// with the headers api-edge sends, and the status, the body (byte for byte after the masking both sides share) and the
// rows the clone left — the service, its parts as Service::parse() made them, its generated Compose file, tags,
// scheduled task, variables, volumes, file mounts, backup schedule and secret manager link — are compared. Each case is
// rolled back.
import { handleApiV1, type ApiV1Runners } from "@deploy-core-worker/api-v1/handler";
import type { Env } from "@deploy-core-worker/env";
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

async function replay(c: Case, { withAfter = false, allow = true } = {}) {
  return fixture.inCase(async (db) => {
    for (const sql of [...(c.setup ?? []), ...(c.setupFreeploy ?? [])]) await query(db, sql);
    const req = forwarded(c);
    const path = new URL(req.url).pathname.replace(`/v1/internal/api-v1/${ORG_PUBLIC}`, "");
    const res = await handleApiV1(req, env, "req_test", { subjectId: userPublic(tokenOf(c.token!).user), subjectType: "user" }, ORG_UUID[T1]!, ORG_PUBLIC, path, runners(db, allow));
    const after: Record<string, unknown[]> = {};
    if (withAfter) for (const [label, sql] of Object.entries(c.after ?? {})) after[label] = await query(db, sql);
    return { status: res.status, body: await res.text(), after };
  });
}

/** The cases whose answer is the middleware's (an ability api.ability refuses; tests/api-edge replays them). */
const MIDDLEWARE_BODY = /^\{"message":"Missing required permissions: [a-z:]+"\}$/;
const isMiddleware = (c: Case) => golden(c.name).status === 403 && MIDDLEWARE_BODY.test(golden(c.name).body.json ?? "");
const DP108_CASES = CASES.cases.filter((c) => /^service clone: /.test(c.name) && c.token && !isMiddleware(c));

const executor = (what: string) => ({ status: 501, body: `{"message":"${what} needs the SSH executor, which is not available yet."}` });
/**
 * Departures: where Coolify queues work on the server after the commit — ServerStorageSaveJob for a file mount the parser
 * made inside the clone's directory, VolumeCloneJob for the volume data (the emitter fakes the queue, so Coolify's golden
 * is its 201) — Freeploy answers 501 in Coolify's envelope, after Coolify's own refusals, with the transaction rolled back.
 */
const DEPARTURES: Record<string, { status: number; body: string }> = {
  "service clone: a file mount": executor("Writing the clone's file mounts to the server"),
  "service clone: named volumes, the volumes": executor("Copying the volume data to the clone"),
};

describe("the goldens of DP-108", () => {
  it("cover clone_service() and the controller's refusals", () => {
    expect(CASES.cases.filter((c) => /^service clone: /.test(c.name)).length).toBe(27);
    expect(DP108_CASES.filter((c) => golden(c.name).status === 201).length).toBeGreaterThanOrEqual(14);
    for (const name of Object.keys(DEPARTURES)) expect(golden(name).status).toBe(201);
  });
});

describe("Freeploy answers as Coolify does (DP-108)", () => {
  it.each(DP108_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const g = golden(name);
    const got = await replay(c);
    if (DEPARTURES[name]) {
      expect({ status: got.status, body: got.body }).toEqual(DEPARTURES[name]);
      return;
    }
    if (g.body.json !== undefined && process.env.API_DIFF && maskedJson(got.body) !== maskedJson(g.body.json)) console.warn(`${name}\nfreeploy: ${maskedJson(got.body)}\ncoolify:  ${maskedJson(g.body.json)}`);
    expect(got.status).toBe(g.status);
    if (g.body.json !== undefined) expect(maskedJson(got.body)).toBe(maskedJson(g.body.json));
    else expect(got.body).toBe(g.body.text);
  });
});

const AFTER_CASES = DP108_CASES.filter((c) => c.after && !DEPARTURES[c.name]);

describe("what the clone leaves behind (DP-108)", () => {
  it("has the rows of the clones", () => {
    expect(AFTER_CASES.length).toBeGreaterThanOrEqual(13);
  });

  it.each(AFTER_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const got = await replay(c, { withAfter: true });
    if (process.env.API_DIFF && JSON.stringify(got.after) !== JSON.stringify(golden(name).after)) console.warn(`${name}\nfreeploy: ${JSON.stringify(got.after)}\ncoolify:  ${JSON.stringify(golden(name).after)}`);
    expect(got.after).toEqual(golden(name).after);
  });

  it.each(Object.keys(DEPARTURES))("%s: nothing is stored", async (name) => {
    const got = await replay(caseNamed(name), { withAfter: true });
    expect(got.after.count).toEqual(golden("service clone: the volumes without deploy").after!.count);
    expect(got.after.service).toEqual([]);
  });
});

describe("authorization (DP-108)", () => {
  it("answers Coolify's policy denial when policy-worker refuses the update, after the 404 of an unknown service", async () => {
    const denied = await replay(caseNamed("service clone: clone"), { allow: false, withAfter: true });
    expect([denied.status, denied.body]).toEqual([403, '{"message":"You are not authorized to perform this action.","error":"Unauthorized"}']);
    expect(denied.after.service).toEqual([]);
    const unknown = await replay(caseNamed("service clone: unknown service"), { allow: false });
    expect([unknown.status, unknown.body]).toEqual([404, '{"message":"Service not found."}']);
  });
});
