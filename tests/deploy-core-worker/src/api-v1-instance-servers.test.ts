// Coolify's /api/v1/disable, /api/v1/mcp/{enable,disable} and PATCH /api/v1/servers/{uuid} (DP-107) replayed against
// Coolify's real answers: fixtures/api/goldens.json, emitted by Coolify's PHP through its HTTP kernel on PostgreSQL (see
// fixtures/api/README.md). The fixture is made in Freeploy's own database (api-v1-database.ts), each request goes to
// deploy-core-worker's handler with the headers api-edge sends, and the status, the body (byte for byte after the masking
// both sides share) and the rows each write left are compared. The instance's switches are the platform operator's: a
// case's root-team token (`rootTeamToken`) is the operator's token in Freeploy, any other token's user is not the operator;
// their rows are row 0 of deploy.instance_settings, read as the operator. Each case is rolled back.
import { handleApiV1, type ApiV1Runners } from "@deploy-core-worker/api-v1/handler";
import type { Env } from "@deploy-core-worker/env";
import { sqlPlatformMoreStore } from "@deploy-core-worker/handlers/platform-settings-more";
import { INSTANCE_SWITCH_MESSAGES } from "@deploy-core-worker/api-v1/instance-switches";
import { SERVER_UPDATE_MESSAGES } from "@deploy-core-worker/api-v1/servers-update";
import { apiRows, asPlatformAdmin, readPlatformSettings, withOrg } from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { API_V1_HEADERS } from "@saas/contracts/coolify-api";
import { CASES, golden, maskedJson, type Case, type Step } from "./api-v1-goldens.js";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";

const ORG_PUBLIC = "org_" + "0".repeat(31) + "a";
const env = { ENVIRONMENT: "test", DEPLOY_ENCRYPTION_KEY: TEST_KEK, DEPLOY_CONSOLE_URL: "http://localhost" } as Env;
const T1 = 1;

interface Dp107Case extends Case {
  rootTeamToken?: { key: string; id: number; user: number; abilities: string[]; secret: string };
}
interface Caller {
  user: number;
  abilities: string[];
  operator: boolean;
}

const roleOf = (userId: number) => CASES.fixture.users.find((u) => u.id === userId)!.teams.find((t) => t.team === T1)?.role ?? null;
const isAdmin = (userId: number) => ["owner", "admin"].includes(roleOf(userId) ?? "");
const userPublic = (id: number) => `usr_${String(id).padStart(32, "0")}`;
const caseNamed = (name: string) => CASES.cases.find((c) => c.name === name)! as Dp107Case;

/** Who sends a step: a fixture token's user, or a root-team token's — the platform operator's. */
function callerOf(c: Dp107Case, step: Step): Caller {
  if (step.token) {
    const t = CASES.fixture.tokens.find((x) => x.key === step.token)!;
    return { user: t.user, abilities: t.abilities, operator: false };
  }
  const root = c.rootTeamToken!;
  return { user: root.user, abilities: root.abilities, operator: true };
}

/** The request api-edge forwards for a step. */
function forwarded(step: Step, caller: Caller): Request {
  const headers = new Headers({
    [API_V1_HEADERS.org]: ORG_PUBLIC,
    [API_V1_HEADERS.user]: userPublic(caller.user),
    [API_V1_HEADERS.abilities]: caller.abilities.join(","),
    [API_V1_HEADERS.canReadSensitive]: (caller.abilities.includes("root") || caller.abilities.includes("read:sensitive")) && isAdmin(caller.user) ? "1" : "0",
  });
  let body: string | undefined;
  if (step.raw !== undefined) {
    body = step.raw;
    headers.set("content-type", step.contentType ?? "application/json");
  } else if (step.body !== undefined) {
    body = JSON.stringify(step.body);
    headers.set("content-type", "application/json");
  }
  const [path, query] = step.path.slice("/api/v1".length).split("?");
  return new Request(`https://deploy-core.internal/v1/internal/api-v1/${ORG_PUBLIC}${path}${query ? `?${query}` : ""}`, { method: step.method, headers, ...(body !== undefined && { body }) });
}

let fixture: FixtureDatabase;
beforeAll(async () => {
  fixture = await fixtureDatabase();
}, 120_000);
afterAll(async () => fixture?.pg.close());

interface Seen {
  operatorAsked: string[];
  platformOpened: number;
}

/** policy-worker's answers: an owner may write; Freeploy's member reads only (Coolify's default member, team-wide read). */
function runners(db: TransactionalSqlExecutor, caller: Caller, seen: Seen): Partial<ApiV1Runners> {
  const member = roleOf(caller.user) === "member";
  return {
    sql: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, fn),
    rows: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, (tx) => fn((table, where, params) => apiRows(tx, table, where ?? null, params ?? []))),
    allows: async (action) => action === "deploy.resource.read" || !member,
    org: async () => ({ id: ORG_PUBLIC, name: "Parity Team", createdAt: "2026-01-01T00:00:00.000Z" }),
    providers: { fetch: async (input) => Promise.reject(new Error(`no request expected: ${String(input)}`)), sleep: async () => undefined },
    operator: async (action) => {
      seen.operatorAsked.push(action);
      return caller.operator;
    },
    platform: async (_e, fn) => {
      seen.platformOpened++;
      return asPlatformAdmin(db, (tx) => fn(sqlPlatformMoreStore(tx, TEST_KEK)));
    },
  };
}

const isInstanceCase = (c: Case) => c.name.startsWith("instance: ");
const query = (db: TransactionalSqlExecutor, sql: string, asOperator = false) => {
  const run = async (tx: Parameters<Parameters<typeof withOrg>[2]>[0]) => {
    await tx.execute("SET LOCAL search_path TO deploy");
    return (await tx.execute(sql)).rows;
  };
  return asOperator ? asPlatformAdmin(db, run) : withOrg(db, ORG_UUID[T1]!, run);
};

/**
 * setup and setupFreeploy; an instance case starts from the platform's row 0 as emit.php's fixture has it (Freeploy's is
 * made by its first read), with its setupCoolify's statements on instance_settings run as the operator (the root team's
 * rows are Coolify's alone).
 */
async function prepare(c: Dp107Case, db: TransactionalSqlExecutor): Promise<void> {
  if (isInstanceCase(c)) {
    await asPlatformAdmin(db, (tx) => readPlatformSettings(tx));
    // emit.php's per-case instance settings (is_api_enabled: Freeploy's API switch is api-edge's API_ENABLED, never this column).
    const apiEnabled = (c as Dp107Case & { instance?: { is_api_enabled?: boolean } }).instance?.is_api_enabled ?? true;
    await query(db, `update instance_settings set is_api_enabled = ${apiEnabled} where id = 0`, true);
    for (const sql of (c.setupCoolify ?? []).filter((s) => s.includes("instance_settings"))) await query(db, sql, true);
  }
  for (const sql of [...(c.setup ?? []), ...(c.setupFreeploy ?? [])]) await query(db, sql);
}

async function sendStep(c: Dp107Case, step: Step, db: TransactionalSqlExecutor, seen: Seen) {
  const caller = callerOf(c, step);
  const req = forwarded(step, caller);
  const path = new URL(req.url).pathname.replace(`/v1/internal/api-v1/${ORG_PUBLIC}`, "");
  const res = await handleApiV1(req, env, "req_test", { subjectId: userPublic(caller.user), subjectType: "user" }, ORG_UUID[T1]!, ORG_PUBLIC, path, runners(db, caller, seen));
  return { status: res.status, body: await res.text() };
}

async function afterRows(db: TransactionalSqlExecutor, c: Case): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const [label, sql] of Object.entries(c.after ?? {})) out[label] = await query(db, sql, isInstanceCase(c));
  return out;
}

async function replay(c: Dp107Case, withAfter = false) {
  return fixture.inCase(async (db) => {
    await prepare(c, db);
    const seen: Seen = { operatorAsked: [], platformOpened: 0 };
    const got = await sendStep(c, c, db, seen);
    return { ...got, after: withAfter ? await afterRows(db, c) : undefined, seen };
  });
}

/** The cases whose answer is the middleware's (auth:sanctum, an ability api.ability refuses; tests/api-edge replays them). */
const isMiddleware = (c: Case) => {
  const g = golden(c.name);
  return g.status === 401 || (g.status === 403 && /^\{"message":"Missing required permissions: [a-z:]+"\}$/.test(g.body?.json ?? ""));
};
/** The paths routes/api.php has no route for: the fallback 404 (api-edge answers it). */
const isFallback = (c: Case) => golden(c.name).body?.json === '{"message":"Not found.","docs":"https:\\/\\/coolify.io\\/docs"}';
const ALL = CASES.cases.filter((c) => isInstanceCase(c) || c.name.startsWith("servers: update")) as Dp107Case[];

/**
 * The departures: where Coolify runs work Freeploy cannot, Freeploy answers 501 in Coolify's envelope before anything is
 * stored — disabling the API (api-edge's API_ENABLED is the deployment's) and validating a server at once (ValidateServer).
 */
const DEPARTURES: Record<string, { body: string; unchangedLike: string }> = {
  "instance: disable the API, a root-team token": { body: INSTANCE_SWITCH_MESSAGES.disableUnavailable, unchangedLike: "instance: disable the API, a team token" },
  "instance: disable the API, a root-team write token": { body: INSTANCE_SWITCH_MESSAGES.disableUnavailable, unchangedLike: "instance: disable the API, a team token" },
  "servers: update, validating at once": { body: SERVER_UPDATE_MESSAGES.validateUnavailable, unchangedLike: "servers: update, an invalid proxy type" },
};
const DP107_CASES = ALL.filter((c) => !isMiddleware(c) && !isFallback(c) && !(c.name in DEPARTURES));

describe("the goldens of DP-107 (deploy-core-worker's)", () => {
  it("cover every operation", () => {
    expect(ALL.length).toBe(61);
    for (const path of ["/api/v1/disable", "/api/v1/mcp/enable", "/api/v1/mcp/disable", "/api/v1/servers/s1parityserveruuid000001"]) expect(DP107_CASES.some((c) => c.path === path)).toBe(true);
  });
});

describe("Freeploy answers as Coolify does (DP-107)", () => {
  it.each(DP107_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const g = golden(name);
    const got = await replay(c);
    if (process.env.API_DIFF && (maskedJson(got.body) !== maskedJson(g.body.json!) || got.status !== g.status)) console.warn(`${name} ${got.status}/${g.status}\nfreeploy: ${got.body}\ncoolify:  ${g.body.json}`);
    expect(got.status).toBe(g.status);
    expect(maskedJson(got.body)).toBe(maskedJson(g.body.json!));
  });
});

const AFTER_CASES = DP107_CASES.filter((c) => c.after);

describe("what a write leaves behind (DP-107)", () => {
  it("has the rows of the writes", () => {
    expect(AFTER_CASES.length).toBeGreaterThanOrEqual(35);
  });

  it.each(AFTER_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const got = await replay(c, true);
    if (process.env.API_DIFF && JSON.stringify(got.after) !== JSON.stringify(golden(name).after)) console.warn(`${name}\nfreeploy: ${JSON.stringify(got.after)}\ncoolify:  ${JSON.stringify(golden(name).after)}`);
    expect(got.after).toEqual(golden(name).after);
  });
});

describe("the departures store nothing (DP-107)", () => {
  it.each(Object.entries(DEPARTURES))("%s", async (name, d) => {
    const got = await replay(caseNamed(name), true);
    expect(got.status).toBe(501);
    expect(JSON.parse(got.body)).toEqual({ message: d.body });
    expect(got.after).toEqual(golden(d.unchangedLike).after);
  });
});

describe("the instance's switches are the platform operator's (DP-107)", () => {
  it("opens no store for a token whose user is not the operator", async () => {
    for (const name of ["instance: disable the API, a team token", "instance: enable the MCP server, a team token", "instance: disable the MCP server, a team token"]) {
      const got = await replay(caseNamed(name));
      expect(got.status).toBe(403);
      expect(got.seen.platformOpened).toBe(0);
      expect(got.seen.operatorAsked).toEqual(["platform.settings.update"]);
    }
  });

  it("never writes is_api_enabled", async () => {
    const got = await replay(caseNamed("instance: disable the API, a root-team token"), true);
    expect(got.seen.platformOpened).toBe(0);
    expect(got.after).toEqual({ settings: [{ is_api_enabled: true, is_mcp_server_enabled: false }] });
  });
});

describe("a server's update stays in the org (DP-107)", () => {
  it("never changes another org's server, and refuses a member after the server's 404", async () => {
    const other = await replay(caseNamed("servers: update another team's"));
    expect(other.status).toBe(404);
    await fixture.inCase(async (db) => {
      const c = caseNamed("servers: update, the name and description");
      const member: Dp107Case = { ...c, token: "memberWrite" };
      const seen: Seen = { operatorAsked: [], platformOpened: 0 };
      expect((await sendStep(member, member, db, seen)).status).toBe(403);
      expect(await query(db, "select name from servers where id = 1")).toEqual([{ name: "parity-server" }]);
      const unknown: Dp107Case = { ...caseNamed("servers: update, unknown"), token: "memberWrite" };
      expect((await sendStep(unknown, unknown, db, seen)).status).toBe(404);
    });
  });
});
