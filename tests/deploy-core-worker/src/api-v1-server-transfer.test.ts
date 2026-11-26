// Coolify's /api/v1 for a server transfer bundle (POST /servers/import) and a transfer another instance finished
// (POST /servers/{uuid}/transfer/complete) (DP-111), replayed against Coolify's real answers: fixtures/api/goldens.json,
// emitted by Coolify's PHP through its HTTP kernel on PostgreSQL (see fixtures/api/README.md). The fixture is made in
// Freeploy's own database (api-v1-database.ts); a case's GitHub runners and managed DNS records are rows of its
// `setupCoolify` and `setupFreeploy`. Each request goes to deploy-core-worker's handler with the headers api-edge sends,
// and the status, the body (byte for byte after the masking both sides share) and the rows each write left are compared:
// ServerTransferBundle::validate()'s refusals, the server payload's, the import checks', the PHP errors Coolify's dry run
// meets, a dry run's answer, and what marking a transfer complete changes. Each case is rolled back.
import { handleApiV1, type ApiV1Runners } from "@deploy-core-worker/api-v1/handler";
import type { Env } from "@deploy-core-worker/env";
import { SERVER_TRANSFER_API_MESSAGES } from "@deploy-core-worker/api-v1/server-transfer";
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

const noNetwork: typeof fetch = async (input) => {
  throw new Error(`no request leaves the import or the transfer: ${String(input)}`);
};

function runners(db: TransactionalSqlExecutor, member: boolean): Partial<ApiV1Runners> {
  return {
    sql: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, fn),
    rows: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, (tx) => fn((table, where, params) => apiRows(tx, table, where ?? null, params ?? []))),
    // policy-worker: an owner may write; Freeploy's member reads only.
    allows: async (action) => action === "deploy.resource.read" || !member,
    org: async () => ({ id: ORG_PUBLIC, name: "Parity Team", createdAt: "2026-01-01T00:00:00.000Z" }),
    s3: {
      // emit.php's SafeWebhookUrl::resolveHostsUsing() table (no DNS is asked).
      resolve: async (host) => (host === "unresolvable.example" ? [] : host === "private.example" ? ["10.0.0.5"] : ["93.184.216.34"]),
      http: async (url) => {
        throw new Error(`no request leaves the transfer: ${url}`);
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
    const t = tokenOf(c.token!);
    const req = forwarded(c);
    const path = new URL(req.url).pathname.replace(`/v1/internal/api-v1/${ORG_PUBLIC}`, "");
    const res = await handleApiV1(req, env, "req_test", { subjectId: userPublic(t.user), subjectType: "user" }, ORG_UUID[T1]!, ORG_PUBLIC, path, runners(db, roleOf(t.user) === "member"));
    const after: Record<string, unknown[]> = {};
    for (const [label, sql] of Object.entries(c.after ?? {})) after[label] = await query(db, sql);
    return { status: res.status, body: await res.text(), after };
  });
}

const GROUP = /^(server import|transfer complete): /;
/** The middleware's answers (an ability api.ability refuses): tests/api-edge replays them. */
const MIDDLEWARE = /^\{"message":"Missing required permissions: [a-z:]+"\}$/;
const DP111_CASES = CASES.cases.filter((c) => GROUP.test(c.name) && !MIDDLEWARE.test(golden(c.name).body.json ?? ""));

/**
 * Departures: a real import (not a dry run) writes every row of the bundle — its private key checked by the importer
 * first, which refuses the fixture's placeholder — and then claims the server over SSH. Freeploy's importer is not
 * ported: once the import checks pass it answers 501 and stores nothing, as Coolify's failed import leaves the rows.
 */
const IMPORT = { status: 501, body: JSON.stringify({ message: SERVER_TRANSFER_API_MESSAGES.importUnavailable }) };
const DEPARTURES: Record<string, { status: number; body: string }> = {
  "server import: import": IMPORT,
  "server import: import over the archive of a transferred server": IMPORT,
};

describe("the goldens of DP-111's server import and transfer completion", () => {
  it("cover both operations, Coolify's own refusals and PHP's among them", () => {
    expect(DP111_CASES.length).toBe(46);
    expect(DP111_CASES.filter((c) => c.name.startsWith("server import: ")).length).toBe(34);
    // The departures reach the importer: Coolify refuses the placeholder key inside the transaction that writes the bundle.
    for (const name of Object.keys(DEPARTURES)) expect(JSON.parse(golden(name).body.json!).message).toMatch(/^The private key is invalid\./);
    // PHP's errors in the dry run: a TypeError or a warning Laravel turns into an ErrorException.
    const php = DP111_CASES.filter((c) => /^\{"message":"((count|trim|foreach)\(\)|Array to string conversion)/.test(golden(c.name).body.json ?? ""));
    expect(php.length).toBe(6);
    // Marking a transfer complete parks the records only the server's resources use, and cancels its active runners.
    const parked = golden("transfer complete: with runners and DNS records").after!.server as Array<{ parked: string }>;
    expect(JSON.parse(parked[0]!.parked)).toEqual(["m5paritytransfersrv00005", "m6paritytransferapp00006", "m7paritytransferpr000007", "m8paritytransfersvc00008"]);
  });
});

describe("Freeploy checks an import and marks a transfer complete as Coolify does (DP-111)", () => {
  it.each(DP111_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const g = golden(name);
    const got = await replay(c);
    if (DEPARTURES[name]) {
      expect({ status: got.status, body: got.body }).toEqual(DEPARTURES[name]);
      expect(got.after).toEqual(g.after);
      return;
    }
    if (process.env.API_DIFF && (got.status !== g.status || maskedJson(got.body) !== maskedJson(g.body.json ?? got.body))) console.warn(`${name} ${got.status}/${g.status}\nfreeploy: ${got.body.slice(0, 1500)}\ncoolify:  ${(g.body.json ?? g.body.text ?? "").slice(0, 1500)}`);
    expect(got.status).toBe(g.status);
    if (g.body.json !== undefined) expect(maskedJson(got.body)).toBe(maskedJson(g.body.json));
    else expect(got.body).toBe(g.body.text);
    if (c.after) {
      if (process.env.API_DIFF && JSON.stringify(got.after) !== JSON.stringify(g.after)) console.warn(`${name}\nfreeploy: ${JSON.stringify(got.after)}\ncoolify:  ${JSON.stringify(g.after)}`);
      expect(got.after).toEqual(g.after);
    }
  });
});
