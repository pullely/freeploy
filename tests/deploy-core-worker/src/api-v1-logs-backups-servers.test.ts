// Coolify's /api/v1 continued (DP-88) — a database's and a service's logs, an application's rollback images and rollback,
// executing a scheduled task, a storage's backup schedule, a server's proxy, Sentinel, log drains, image scanning,
// Cloudflare Tunnel, host key, registries and transfer, database imports and GitHub Apps — replayed against Coolify's real
// answers: fixtures/api/goldens.json, emitted by Coolify's PHP through its HTTP kernel on PostgreSQL (see
// fixtures/api/README.md). The fixture is made in Freeploy's own database (api-v1-database.ts), each request goes to
// deploy-core-worker's handler with the headers api-edge sends, and status and body are compared byte for byte after the
// masking both sides share; then the rows each write left. Each case is rolled back.
import { handleApiV1, type ApiV1Runners } from "@deploy-core-worker/api-v1/handler";
import type { Env } from "@deploy-core-worker/env";
import type { HostResolver } from "@deploy-core-worker/s3-storages/safe-url";
import { RESOURCE_LOGS_API_MESSAGES } from "@deploy-core-worker/api-v1/resource-logs";
import { ROLLBACK_API_MESSAGES } from "@deploy-core-worker/api-v1/rollback";
import { EXECUTE_TASK_UNAVAILABLE } from "@deploy-core-worker/api-v1/scheduled-tasks";
import { VOLUME_BACKUPS_API_MESSAGES } from "@deploy-core-worker/api-v1/volume-backups";
import { SERVER_SETTINGS_API_MESSAGES } from "@deploy-core-worker/api-v1/server-settings";
import { REGISTRIES_TRANSFER_API_MESSAGES } from "@deploy-core-worker/api-v1/server-registries-transfer";
import { DATABASE_IMPORTS_API_MESSAGES } from "@deploy-core-worker/api-v1/database-imports";
import { apiRows, withOrg } from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { API_V1_HEADERS } from "@saas/contracts/coolify-api";
import { CASES, golden, maskedJson, type Case, type FixtureToken } from "./api-v1-goldens.js";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";

const ORG_PUBLIC = "org_" + "0".repeat(31) + "a";
/** Coolify's route() base in the emitter (APP_URL): Freeploy's console URL in the links and messages that name a page. */
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

/** Host names as emit.php's SafeWebhookUrl::resolveHostsUsing() table resolves them (no DNS is asked). */
const resolve: HostResolver = async (host) => (host === "unresolvable.example" ? [] : host === "private.example" ? ["10.0.0.5"] : ["93.184.216.34"]);

/** policy-worker's answers: `write` false is a user who may read but not update (a member, for a server's update policy). */
type Allow = { read: boolean; write: boolean };
const ALL: Allow = { read: true, write: true };

/** The runners over the case's database, for team 1's org. */
function runners(db: TransactionalSqlExecutor, allow: Allow): Partial<ApiV1Runners> {
  return {
    sql: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, fn),
    rows: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, (tx) => fn((table, where, params) => apiRows(tx, table, where ?? null, params ?? []))),
    allows: async (action) => (action === "deploy.resource.write" ? allow.write : allow.read),
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

/** Coolify's update policy of a server is an admin's: the member's case is answered as policy-worker answers a member. */
const allowOf = (c: Case): Allow => (roleOf(tokenOf(c.token!).user) === "member" ? { read: true, write: false } : ALL);

const send = async (c: Case, db: TransactionalSqlExecutor, allow: Allow = allowOf(c)) => {
  for (const sql of [...(c.setup ?? []), ...(c.setupFreeploy ?? [])]) await query(db, sql);
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

const GROUP = /^(database logs|service logs|rollback|execute |volume backups|server (proxy|sentinel|log drains|image scanning|cloudflare tunnel|host key|registries|transfer)|(service )?database imports|github apps)/;
/** The cases whose answer is the middleware's — an ability api.ability refuses, a token with more access than its user (tests/api-edge replays them). */
const MIDDLEWARE_BODY = /^\{"message":"(Missing required permissions: [a-z:]+|This API token has more access than you have in this team\. Revoke it and create a new token\.)"\}$/;
const isMiddleware = (c: Case) => golden(c.name).status === 403 && MIDDLEWARE_BODY.test(golden(c.name).body.json ?? "");

const executor = (text: string) => ({ status: 501, body: JSON.stringify({ message: text }) });
/**
 * Departures: where Coolify runs or queues work on the server (the emitter fakes the queue and has no SSH, so its golden
 * is the queued 200, the 500 of the failed SSH step, or what the error handler made of it), Freeploy answers 501 in
 * Coolify's envelope after Coolify's own checks, before anything is stored.
 */
const DEPARTURES: Record<string, { status: number; body: string }> = {
  "database logs: the server not functional": executor(RESOURCE_LOGS_API_MESSAGES.databaseLogsUnavailable),
  "database logs": executor(RESOURCE_LOGS_API_MESSAGES.databaseLogsUnavailable),
  "service logs: the server not functional": executor(RESOURCE_LOGS_API_MESSAGES.serviceLogsUnavailable),
  "service logs": executor(RESOURCE_LOGS_API_MESSAGES.serviceLogsUnavailable),
  "rollback images: on a functional server": executor(ROLLBACK_API_MESSAGES.imagesUnavailable),
  "rollback: a deployed commit": executor(ROLLBACK_API_MESSAGES.rollbackUnavailable),
  "rollback: the finished HEAD": executor(ROLLBACK_API_MESSAGES.rollbackUnavailable),
  "rollback: a registry build": executor(ROLLBACK_API_MESSAGES.rollbackUnavailable),
  "rollback: an unknown commit on a functional server": executor(ROLLBACK_API_MESSAGES.imagesUnavailable),
  "execute application task": executor(EXECUTE_TASK_UNAVAILABLE),
  "execute application task, root": executor(EXECUTE_TASK_UNAVAILABLE),
  "execute application task: a disabled task": executor(EXECUTE_TASK_UNAVAILABLE),
  "execute service task": executor(EXECUTE_TASK_UNAVAILABLE),
  "execute service task, root": executor(EXECUTE_TASK_UNAVAILABLE),
  "volume backups: run": executor(VOLUME_BACKUPS_API_MESSAGES.runUnavailable),
  "volume backups: run a database's": executor(VOLUME_BACKUPS_API_MESSAGES.runUnavailable),
  "volume backups: run a service's": executor(VOLUME_BACKUPS_API_MESSAGES.runUnavailable),
  "server proxy: update the redirect on a functional server": executor(SERVER_SETTINGS_API_MESSAGES.redirectUnavailable),
  "server proxy: restart": executor(SERVER_SETTINGS_API_MESSAGES.restartProxyUnavailable),
  "server sentinel: update, Sentinel enabled": executor(SERVER_SETTINGS_API_MESSAGES.sentinelRestartUnavailable),
  "server log drains: on a functional server": executor(SERVER_SETTINGS_API_MESSAGES.logDrainUnavailable),
  "server image scanning: turned on": executor(SERVER_SETTINGS_API_MESSAGES.imageScannerUnavailable),
  "server host key: reset": executor(SERVER_SETTINGS_API_MESSAGES.hostKeyCheckUnavailable),
  "server host key: reset to a key": executor(SERVER_SETTINGS_API_MESSAGES.hostKeyCheckUnavailable),
  "server registries: list on a functional server": executor(REGISTRIES_TRANSFER_API_MESSAGES.readUnavailable),
  "server registries: login": executor(REGISTRIES_TRANSFER_API_MESSAGES.loginUnavailable),
  "server registries: check": executor(REGISTRIES_TRANSFER_API_MESSAGES.checkUnavailable),
  "server registries: logout": executor(REGISTRIES_TRANSFER_API_MESSAGES.logoutUnavailable),
  "server transfer: migrate": executor(REGISTRIES_TRANSFER_API_MESSAGES.migrateUnavailable),
  "server transfer: migrate with a blank bearer token": executor(REGISTRIES_TRANSFER_API_MESSAGES.migrateUnavailable),
  "server transfer: migrate after a stale migration": executor(REGISTRIES_TRANSFER_API_MESSAGES.migrateUnavailable),
  "server transfer: import check": executor(REGISTRIES_TRANSFER_API_MESSAGES.importCheckUnavailable),
  ...Object.fromEntries(
    ["database imports", "service database imports"].flatMap((group) => [
      [`${group}: from the server`, executor(DATABASE_IMPORTS_API_MESSAGES.importUnavailable)],
      [`${group}: from S3`, executor(DATABASE_IMPORTS_API_MESSAGES.importUnavailable)],
      // The setting makes the server a Swarm manager, but the database's destination is a StandaloneDocker: Coolify goes on
      // to the server (its golden is the 500 of the failed SSH step).
      [`${group}: on a Swarm server`, executor(DATABASE_IMPORTS_API_MESSAGES.importUnavailable)],
    ]),
  ),
};
const DP88_CASES = CASES.cases.filter((c) => GROUP.test(c.name) && c.token && !isMiddleware(c));

describe("the goldens of DP-88", () => {
  it("cover every group ported", () => {
    expect(CASES.cases.filter((c) => GROUP.test(c.name)).length).toBe(316);
    for (const prefix of ["database logs", "service logs", "rollback images", "rollback:", "execute application task", "execute service task", "volume backups", "server proxy", "server sentinel", "server log drains", "server image scanning", "server cloudflare tunnel", "server host key", "server registries", "server transfer", "database imports", "service database imports", "github apps"]) {
      expect(DP88_CASES.some((c) => c.name.startsWith(prefix))).toBe(true);
    }
    for (const name of Object.keys(DEPARTURES)) expect(DP88_CASES.some((c) => c.name === name)).toBe(true);
  });
});

describe("Freeploy answers as Coolify does (DP-88)", () => {
  it.each(DP88_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
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
      if (a !== b || got.status !== g.status) console.warn(`${name} ${got.status}/${g.status} @${i}\nfreeploy: ${a.slice(Math.max(0, i - 160), i + 240)}\ncoolify:  ${b.slice(Math.max(0, i - 160), i + 240)}`);
    }
    expect(got.status).toBe(g.status);
    if (g.body.json !== undefined) expect(maskedJson(got.body)).toBe(maskedJson(g.body.json));
    else expect(got.body).toBe(g.body.text);
  });
});

const AFTER_CASES = DP88_CASES.filter((c) => c.after && !DEPARTURES[c.name]);

describe("what a write leaves behind (DP-88)", () => {
  it("has the rows of the writes", () => {
    expect(AFTER_CASES.length).toBeGreaterThanOrEqual(45);
  });

  it.each(AFTER_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const got = await replay(c, true);
    if (process.env.API_DIFF && JSON.stringify(got.after) !== JSON.stringify(golden(name).after)) console.warn(`${name}\nfreeploy: ${JSON.stringify(got.after)}\ncoolify:  ${JSON.stringify(golden(name).after)}`);
    expect(got.after).toEqual(golden(name).after);
  });

  it.each(Object.keys(DEPARTURES).filter((name) => caseNamed(name).after))("%s (a departure: nothing is stored)", async (name) => {
    const c = caseNamed(name);
    const [before, after] = await fixture.inCase(async (db) => {
      for (const sql of [...(c.setup ?? []), ...(c.setupFreeploy ?? [])]) await query(db, sql);
      return [await afterRows(db, c), (await send({ ...c, setup: [], setupFreeploy: [] }, db), await afterRows(db, c))];
    });
    expect(after).toEqual(before);
  });
});

describe("authorization and the secrets (DP-88)", () => {
  const DENIED = { read: false, write: false };
  it("answers Laravel's 403 when policy-worker denies the token's user, after the 404 of an unknown resource, and stores nothing", async () => {
    const out = await fixture.inCase(async (db) => {
      const statuses: number[] = [];
      for (const name of ["rollback images: the registry's builds", "rollback: a failed deployment's commit", "volume backups: create", "server proxy: update the redirect", "server sentinel: show", "server log drains: New Relic", "server cloudflare tunnel: enable", "server registries: list", "github apps: create", "database imports: from the server, not running"]) {
        statuses.push((await send({ ...caseNamed(name), setup: [], setupFreeploy: [] }, db, DENIED)).status);
      }
      for (const name of ["rollback images of unknown", "volume backups: unknown application", "server proxy: show unknown", "database imports: into unknown"]) statuses.push((await send(caseNamed(name), db, DENIED)).status);
      return { statuses, rows: [await afterRows(db, caseNamed("volume backups: create")), await afterRows(db, caseNamed("server proxy: update the redirect")), await afterRows(db, caseNamed("github apps: create"))] };
    });
    expect(out.statuses).toEqual([403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 404, 404, 404, 404]);
    expect(out.rows).toEqual(
      await fixture.inCase(async (db) => [await afterRows(db, caseNamed("volume backups: create")), await afterRows(db, caseNamed("server proxy: update the redirect")), await afterRows(db, caseNamed("github apps: create"))]),
    );
  });

  it("stores a GitHub App's secrets and a log drain's keys encrypted", async () => {
    await fixture.inCase(async (db) => {
      expect((await send(caseNamed("github apps: create"), db)).status).toBe(201);
      const [app] = await query(db, "select client_secret, webhook_secret from github_apps order by id desc limit 1");
      expect(app!.client_secret).not.toBe("cs-1");
      expect(String(app!.webhook_secret).length).toBeGreaterThan(20);
      expect((await send(caseNamed("server log drains: New Relic"), db)).status).toBe(200);
      const [settings] = await query(db, "select logdrain_newrelic_license_key from server_settings where server_id = 1");
      expect(settings!.logdrain_newrelic_license_key).not.toBe("nr-key_1.2");
    });
  });
});
