// A request Coolify's policy refuses (DP-93), replayed against Coolify's real answers: fixtures/api/goldens.json, emitted by
// Coolify's PHP through its HTTP kernel (see fixtures/api/README.md). Coolify answers a denied $this->authorize() under api/*
// from its exception handler — the policy's own message or "You are not authorized to perform this action.", with "error":
// "Unauthorized" — and Freeploy's handler answers policy-worker's denial the same way. Each `denied: …` case is an earlier
// case sent with a member's token; in Coolify the member holds the levels stored on its membership (setupCoolify), which
// Freeploy has no equivalent of: its member (builder or viewer) holds deploy.resource.read alone, which is what the
// handler is told here. The status, the body (byte for byte after the masking both sides share) and the rows the earlier
// case reads afterwards are compared; each case is rolled back.
import { handleApiV1, type ApiV1Runners } from "@deploy-core-worker/api-v1/handler";
import type { Env } from "@deploy-core-worker/env";
import { runInOrgOn as projectsOn } from "@deploy-core-worker/handlers/projects";
import { runInOrgOn as keysOn } from "@deploy-core-worker/handlers/private-keys";
import { apiRows, withOrg } from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { API_V1_HEADERS, COOLIFY_API, POLICY_DENIALS } from "@saas/contracts/coolify-api";
import { CASES, golden, maskedJson, type Case, type FixtureToken } from "./api-v1-goldens.js";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";

const ORG_PUBLIC = "org_" + "0".repeat(31) + "a";
const env = { ENVIRONMENT: "test", DEPLOY_ENCRYPTION_KEY: TEST_KEK, DEPLOY_CONSOLE_URL: "http://localhost" } as Env;
const T1 = 1;

const tokenOf = (key: string): FixtureToken => CASES.fixture.tokens.find((t) => t.key === key)!;
const roleOf = (userId: number) => CASES.fixture.users.find((u) => u.id === userId)!.teams.find((t) => t.team === T1)?.role ?? null;
const userPublic = (id: number) => `usr_${String(id).padStart(32, "0")}`;

/** The request api-edge forwards for a fixture case (a member never reads secrets). */
function forwarded(c: Case): Request {
  const t = tokenOf(c.token!);
  const headers = new Headers({
    [API_V1_HEADERS.org]: ORG_PUBLIC,
    [API_V1_HEADERS.user]: userPublic(t.user),
    [API_V1_HEADERS.abilities]: t.abilities.join(","),
    [API_V1_HEADERS.canReadSensitive]: "0",
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

/** Nothing leaves the test: a denied request asks no outside API. */
const noNetwork: typeof fetch = async (input) => {
  throw new Error(`a denied request reached ${String(input)}`);
};

/** policy-worker's answer for Freeploy's member (builder, viewer): deploy.resource.read, not deploy.resource.write. */
function runners(db: TransactionalSqlExecutor): Partial<ApiV1Runners> {
  return {
    projects: projectsOn(db),
    keys: keysOn(db),
    sql: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, fn),
    rows: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, (tx) => fn((table, where, params) => apiRows(tx, table, where ?? null, params ?? []))),
    allows: async (action) => action === "deploy.resource.read",
    org: async () => ({ id: ORG_PUBLIC, name: "Parity Team", createdAt: "2026-01-01T00:00:00.000Z" }),
    s3: {
      // emit.php's SafeWebhookUrl::resolveHostsUsing() table (no DNS is asked).
      resolve: async (host) => (host === "unresolvable.example" ? [] : host === "private.example" ? ["10.0.0.5"] : ["93.184.216.34"]),
      http: async (url) => {
        throw new Error(`a denied request reached ${url}`);
      },
    },
    providers: { fetch: noNetwork, sleep: async () => undefined },
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
    const req = forwarded(c);
    const path = new URL(req.url).pathname.replace(`/v1/internal/api-v1/${ORG_PUBLIC}`, "");
    const res = await handleApiV1(req, env, "req_test", { subjectId: userPublic(tokenOf(c.token!).user), subjectType: "user" }, ORG_UUID[T1]!, ORG_PUBLIC, path, runners(db));
    const after: Record<string, unknown[]> = {};
    // A query of Coolify's tenancy column (team_id) is DP-70's, whose replay reads memory stores: not run here.
    for (const [label, sql] of Object.entries(c.after ?? {})) if (!/\bteam_id\b/.test(sql)) after[label] = await query(db, sql);
    return { status: res.status, body: await res.text(), contentType: res.headers.get("content-type"), after };
  });
}

const DENIALS = CASES.cases.filter((c) => c.name.startsWith("denied: "));

describe("the denial goldens (DP-93)", () => {
  it("are Coolify's exception handler answering a policy, for a member, on a route of every group that has one", () => {
    expect(DENIALS.length).toBe(52);
    for (const c of DENIALS) {
      expect(roleOf(tokenOf(c.token!).user)).toBe("member");
      const g = golden(c.name);
      expect(g.status).toBe(403);
      expect(g.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(g.body.json!)).toMatchObject({ error: "Unauthorized" });
    }
    // The policies with their own message (Response::deny()) and those that answer false.
    const messages = new Set(DENIALS.map((c) => (JSON.parse(golden(c.name).body.json!) as { message: string }).message));
    expect([...messages].sort()).toEqual([POLICY_DENIALS.applicationUpdate, POLICY_DENIALS.databaseUpdate, "You are not authorized to perform this action."].sort());
  });
});

describe("Freeploy answers a denied policy as Coolify's exception handler does (DP-93)", () => {
  it.each(DENIALS.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const g = golden(name);
    const got = await replay(c);
    if (process.env.API_DIFF && (got.status !== g.status || maskedJson(got.body) !== maskedJson(g.body.json!))) console.warn(`${name} ${got.status}/${g.status}\nfreeploy: ${got.body}\ncoolify:  ${g.body.json}`);
    expect(got.status).toBe(g.status);
    expect(maskedJson(got.body)).toBe(maskedJson(g.body.json!));
    expect(got.contentType).toBe(g.headers["content-type"]);
    // The rows the earlier case reads afterwards: the refusal wrote nothing.
    if (c.after) for (const label of Object.keys(got.after)) expect(got.after[label]).toEqual(g.after![label]);
  });

  it("is the handler's answer, not Laravel's", () => {
    expect(COOLIFY_API.unauthorized()).toEqual({ status: 403, body: '{"message":"You are not authorized to perform this action.","error":"Unauthorized"}', headers: { "content-type": "application/json" } });
    expect(COOLIFY_API.unauthorized(POLICY_DENIALS.databaseUpdate).body).toBe('{"message":"You need at least admin or owner permissions to update this database.","error":"Unauthorized"}');
    // CloudProviderTokensController::index's own refusal keeps Laravel's words.
    expect(COOLIFY_API.controllerUnauthorized().body).toBe('{"message":"This action is unauthorized."}');
  });
});
