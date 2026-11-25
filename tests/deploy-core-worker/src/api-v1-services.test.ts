// Coolify's /api/v1 for services and their environment variables, and for deployments (DP-74), replayed against Coolify's real answers:
// fixtures/api/goldens.json, emitted by Coolify's PHP through its HTTP kernel on PostgreSQL (see fixtures/api/README.md).
// The fixture is made in Freeploy's own database (api-v1-database.ts: PGlite with the deploy schema at head, the rows
// made by Freeploy's insert functions — a service per team with its parts and variables), each request goes to
// deploy-core-worker's handler with the headers api-edge sends and runs the services on that database, and status and
// body are compared byte for byte after the masking both sides share; then the rows each write left. Each case is rolled
// back.
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

const query = (db: TransactionalSqlExecutor, sql: string) =>
  withOrg(db, ORG_UUID[T1]!, async (tx) => {
    await tx.execute("SET LOCAL search_path TO deploy");
    return (await tx.execute(sql)).rows;
  });

/** A case's `setup`: the SQL emit.php runs before the request, on Freeploy's tables (the same names in the deploy schema). */
async function setup(db: TransactionalSqlExecutor, c: Case): Promise<void> {
  for (const sql of c.setup ?? []) await query(db, sql);
}

const send = async (c: Case, db: TransactionalSqlExecutor, allow = true) => {
  await setup(db, c);
  const req = forwarded(c);
  const path = new URL(req.url).pathname.replace(`/v1/internal/api-v1/${ORG_PUBLIC}`, "");
  return handleApiV1(req, env, "req_test", { subjectId: userPublic(tokenOf(c.token!).user), subjectType: "user" }, ORG_UUID[T1]!, ORG_PUBLIC, path, runners(db, allow));
};

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
 * Departures: Freeploy's answer differs from Coolify's on purpose. What runs on a server needs the SSH executor (DP-70's
 * convention): Coolify queues StartService and RestartService and answers at once; Freeploy answers 501, and refuses an
 * instant deploy before it stores anything.
 */
const unavailable = (what: string) => ({ status: 501, body: `{"message":"${what} needs the SSH executor, which is not available yet."}` });
const DEPARTURES: Record<string, { status: number; body: string }> = {
  "services: start": unavailable("Deploying the service"),
  "services: restart": unavailable("Restarting the service"),
  "services: create, instant deploy": unavailable("Deploying the service"),
  "services: update, instant deploy": unavailable("Deploying the service"),
  // Cancelling marks the deployment, removes its container and starts the next one; deploying queues or starts.
  "deployments: cancel a running one": { status: 501, body: '{"message":"Cancelling a deployment needs the SSH executor, which is not available yet."}' },
  "deployments: cancel a queued one": { status: 501, body: '{"message":"Cancelling a deployment needs the SSH executor, which is not available yet."}' },
  "deploy: an application": unavailable("Deploying the application"),
  "deploy: an application, in the body": unavailable("Deploying the application"),
  // Coolify answers 500: StartService::run() fails without the server.
  "deploy: a service": unavailable("Deploying the service"),
  "deploy: a database": unavailable("Starting the database"),
  // Another team's deployment is not found (row-level security) where Coolify answers 403, telling the token it exists.
  "deployments: cancel another team's": { status: 404, body: '{"message":"Deployment not found."}' },
};

/**
 * The catalogue: Freeploy's is generated from templates/compose at the pinned commit (DP-59: what Coolify's
 * generate:services writes and its CDN serves); the emitter's Coolify reads the templates/service-templates.json committed
 * at that commit, which lacks the four templates added since it was last generated. Everything else of the answer is
 * Coolify's.
 */
const TEMPLATES_NOT_IN_COOLIFYS_FILE = ["n8n-with-postgres-worker-and-ai-assistant", "netbird", "netbird-proxy", "wordpress-with-openlitespeed"];
describe("the list of service types (DP-74)", () => {
  it("is Coolify's committed list and the templates generated since", async () => {
    const got = JSON.parse((await replay(caseNamed("services: create, unknown type"))).body) as { message: string; valid_service_types: string[] };
    const coolify = JSON.parse(golden("services: create, unknown type").body.json!) as typeof got;
    expect(got.message).toBe(coolify.message);
    expect(got.valid_service_types.filter((k) => !TEMPLATES_NOT_IN_COOLIFYS_FILE.includes(k))).toEqual(coolify.valid_service_types);
    expect(got.valid_service_types.filter((k) => TEMPLATES_NOT_IN_COOLIFYS_FILE.includes(k)).sort()).toEqual([...TEMPLATES_NOT_IN_COOLIFYS_FILE].sort());
  });
});

/** The cases whose answer is the middleware's (tests/api-edge replays them). */
const MIDDLEWARE_ANSWERS = new Set(["services: list, member with read:sensitive", "service envs: list, member with read:sensitive", "services: stop with a write token", "deployments: cancel with a write token", "deploy: with a read token"]);
/** Compared on its own below (the catalogue). */
const LISTED_APART = new Set(["services: create, unknown type"]);
const GROUP = /^(services|service envs|deployments|deploy): /;
const OPERATION_CASES = CASES.cases.filter((c) => GROUP.test(c.name) && c.token && !MIDDLEWARE_ANSWERS.has(c.name) && !LISTED_APART.has(c.name));

describe("the goldens of DP-74", () => {
  it("cover the service, service variable and deployment operations", () => {
    expect(OPERATION_CASES.length).toBeGreaterThanOrEqual(110);
  });
});

describe("Freeploy answers as Coolify does (DP-74)", () => {
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
const AFTER_DEPARTURES = new Set(["services: create, instant deploy", "services: update, instant deploy", "deployments: cancel a running one", "deployments: cancel a queued one", "deploy: an application, in the body"]);
const AFTER_CASES = OPERATION_CASES.filter((c) => c.after && !AFTER_DEPARTURES.has(c.name));

describe("what a write leaves behind (DP-74)", () => {
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

describe("what Freeploy cannot do yet, and authorization (DP-74)", () => {
  it("answers 501 for deleting or stopping a service that runs, and keeps it", async () => {
    const out = await fixture.inCase(async (db) => {
      await withOrg(db, ORG_UUID[T1]!, (tx) => tx.execute("UPDATE deploy.service_applications SET status = 'running:healthy' WHERE uuid = 'g1paritywebapplication01'"));
      const deleted = await send(caseNamed("services: delete"), db);
      const stopped = await send(caseNamed("services: stop"), db);
      const left = await withOrg(db, ORG_UUID[T1]!, (tx) => apiRows(tx, "services", "t.uuid = $1", ["f1parityservice000000001"]));
      return [deleted.status, await deleted.text(), stopped.status, await stopped.text(), left.length];
    });
    expect(out).toEqual([
      501,
      '{"message":"Stopping the service and removing its containers, volumes, networks and configuration files from the server needs the SSH executor, which is not available yet."}',
      501,
      '{"message":"Stopping the service needs the SSH executor, which is not available yet."}',
      1,
    ]);
  });

  it("answers Laravel's 403 when policy-worker denies the token's user, after the 404 of an unknown service", async () => {
    const out = await fixture.inCase(async (db) => {
      const shown = await send(caseNamed("services: show"), db, false);
      const created = await send(caseNamed("services: create from a template"), db, false);
      const unknown = await send(caseNamed("services: update unknown"), db, false);
      const envs = await send(caseNamed("service envs: create"), db, false);
      return [shown.status, await shown.text(), created.status, unknown.status, envs.status];
    });
    expect(out).toEqual([403, '{"message":"This action is unauthorized."}', 403, 404, 403]);
  });

  it("never returns a locked or secret value to a token that may not read secrets", async () => {
    for (const name of ["services: list", "services: show", "service envs: list"]) {
      const got = await replay(caseNamed(name));
      expect(got.body).not.toContain("dbSecretPass1");
      expect(got.body).not.toContain('"value"');
    }
  });
});
