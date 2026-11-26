// Coolify's /api/v1 continued (DP-85) — the team's notification channels, a service's applications and databases,
// destinations, a server's shared variables and its Docker cleanup — replayed against Coolify's real answers:
// fixtures/api/goldens.json, emitted by Coolify's PHP through its HTTP kernel on PostgreSQL (see fixtures/api/README.md).
// The fixture is made in Freeploy's own database (api-v1-database.ts), each request goes to deploy-core-worker's handler
// with the headers api-edge sends, and status and body are compared byte for byte after the masking both sides share;
// then the rows each write left. Each case is rolled back.
import { handleApiV1, type ApiV1Runners } from "@deploy-core-worker/api-v1/handler";
import type { Env } from "@deploy-core-worker/env";
import type { HostResolver } from "@deploy-core-worker/s3-storages/safe-url";
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

/** Host names as emit.php's SafeWebhookUrl::resolveHostsUsing() table resolves them (no DNS is asked). */
const resolve: HostResolver = async (host) => (host === "unresolvable.example" ? [] : host === "private.example" ? ["10.0.0.5"] : ["93.184.216.34"]);

/** The runners over the case's database, for team 1's org. */
function runners(db: TransactionalSqlExecutor, allow = true): Partial<ApiV1Runners> {
  return {
    sql: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, fn),
    rows: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, (tx) => fn((table, where, params) => apiRows(tx, table, where ?? null, params ?? []))),
    allows: async () => allow,
    org: async () => ({ id: ORG_PUBLIC, name: "Parity Team", createdAt: "2026-01-01T00:00:00.000Z" }),
    s3: {
      resolve,
      http: async (url) => {
        throw new Error(`no request expected: ${url}`);
      },
      sleep: async () => undefined,
    },
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
const MIDDLEWARE_ANSWERS = new Set(["notifications: update with a read token", "notifications email: show, a member with read:sensitive", "service applications: start with a write token", "service applications: logs with a read token", "docker cleanup: run with a write token"]);
const GROUP = /^(notifications( \w+)?|service applications|service databases|server envs|destinations|docker cleanup): /;

const executor = (what: string) => ({ status: 501, body: `{"message":"${what} needs the SSH executor, which is not available yet."}` });
/**
 * Departures: Freeploy's answer differs from Coolify's on purpose. Where Coolify queues or runs work on a functional
 * server — a part's start, restart and stop (the emitter fakes the queue: Coolify's golden is its 200), its container logs
 * (the emitter has no SSH: Coolify's golden is its 400 from the failed status check), the TCP proxy a database's is_public
 * starts or stops (queued: Coolify's 200) — Freeploy answers 501 in Coolify's envelope, after Coolify's own refusals and
 * before anything is stored.
 */
const DEPARTURES: Record<string, { status: number; body: string }> = {
  ...Object.fromEntries(
    ["start", "restart", "stop"].flatMap((action) => {
      const verb = action === "start" ? "Deploying" : action === "restart" ? "Restarting" : "Stopping";
      return [
        [`service applications: ${action}`, executor(`${verb} the service application`)],
        [`service databases: ${action}`, executor(`${verb} the service database`)],
      ];
    }),
  ),
  "service applications: logs": executor("Reading the service application's container logs"),
  "service databases: logs": executor("Reading the service database's container logs"),
  "service databases: make public, a port another database of the same id has": executor("Starting the database's public proxy"),
  "service databases: make private": executor("Stopping the database's public proxy"),
  // Coolify lists the server's Docker networks over SSH first (the emitter has none: Coolify's golden is its 422).
  "destinations: create": executor("Creating the Docker network on the server"),
  // DockerCleanupJob (queued: the emitter fakes it, so Coolify's golden is its 200).
  "docker cleanup: run": executor("Running the Docker cleanup on the server"),
};
const OPERATION_CASES = CASES.cases.filter((c) => GROUP.test(c.name) && c.token && !MIDDLEWARE_ANSWERS.has(c.name));

describe("the goldens of DP-85", () => {
  it("cover the operations ported", () => {
    expect(OPERATION_CASES.length).toBeGreaterThanOrEqual(230);
  });
});

describe("Freeploy answers as Coolify does (DP-85)", () => {
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
    if (g.body.json !== undefined) expect(maskedJson(got.body)).toBe(maskedJson(g.body.json));
    else expect(got.body).toBe(g.body.text);
  });
});

const AFTER_CASES = OPERATION_CASES.filter((c) => c.after && !DEPARTURES[c.name]);

describe("what a write leaves behind (DP-85)", () => {
  it("has the rows of every write", () => {
    expect(AFTER_CASES.length).toBeGreaterThanOrEqual(80);
  });

  it.each(AFTER_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const got = await replay(c, true);
    expect(got.after).toEqual(golden(name).after);
  });

  it.each(Object.keys(DEPARTURES).filter((name) => caseNamed(name).after))("%s (a departure: nothing is stored)", async (name) => {
    const c = caseNamed(name);
    const [before, after] = await fixture.inCase(async (db) => {
      for (const sql of c.setup ?? []) await query(db, sql);
      return [await afterRows(db, c), (await send(c, db), await afterRows(db, c))];
    });
    expect(after).toEqual(before);
  });
});

describe("authorization and the other team (DP-85)", () => {
  it("answers Laravel's 403 when policy-worker denies the token's user, after the 404 of an unknown resource, and writes nothing", async () => {
    const out = await fixture.inCase(async (db) => {
      const shown = await send(caseNamed("notifications email: show"), db, false);
      const c = caseNamed("notifications discord: update");
      const updated = await send(c, db, false);
      const parts = await send(caseNamed("service applications: list"), db, false);
      const unknown = await send(caseNamed("service applications: list of unknown"), db, false);
      const cleanup = await send(caseNamed("docker cleanup: show"), db, false);
      const envs = await send(caseNamed("server envs: create"), db, false);
      return [shown.status, await shown.text(), updated.status, parts.status, unknown.status, cleanup.status, envs.status, await afterRows(db, c)];
    });
    expect(out.slice(0, 7)).toEqual([403, '{"message":"This action is unauthorized."}', 403, 403, 404, 403, 403]);
    expect(out[7]).toEqual(await fixture.inCase((db) => afterRows(db, caseNamed("notifications discord: update"))));
  });

  it("never reads or changes another team's settings", async () => {
    await fixture.inCase(async (db) => {
      await send(caseNamed("notifications webhook: update"), db);
      const theirs = await withOrg(db, ORG_UUID[2]!, async (tx) => (await tx.execute("SELECT id, webhook_enabled, webhook_url FROM deploy.webhook_notification_settings")).rows);
      expect(theirs).toEqual([{ id: 2, webhook_enabled: false, webhook_url: null }]);
    });
  });

  it("stores the secrets encrypted", async () => {
    await fixture.inCase(async (db) => {
      await send(caseNamed("notifications telegram: update"), db);
      const [row] = await query(db, "select telegram_token from telegram_notification_settings where id = 1");
      expect(String((row as { telegram_token: string }).telegram_token)).not.toContain("parity-token");
    });
  });
});
