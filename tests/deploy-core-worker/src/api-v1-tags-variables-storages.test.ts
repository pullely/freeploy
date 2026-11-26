// Coolify's /api/v1 continued (DP-81) — the team's tags and the tags of an application, a database and a service, the
// shared variables of a project and of an environment, and S3 storages —
// replayed against Coolify's real answers: fixtures/api/goldens.json, emitted by Coolify's PHP through its HTTP kernel on
// PostgreSQL (see fixtures/api/README.md). The fixture is made in Freeploy's own database (api-v1-database.ts), each
// request goes to deploy-core-worker's handler with the headers api-edge sends, and status and body are compared byte
// for byte after the masking both sides share; then the rows each write left. Each case is rolled back.
import { handleApiV1, type ApiV1Runners } from "@deploy-core-worker/api-v1/handler";
import type { Env } from "@deploy-core-worker/env";
import { apiRows, withOrg } from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { API_V1_HEADERS } from "@saas/contracts/coolify-api";
import type { S3Http } from "@deploy-core-worker/s3-storages/connection";
import type { HostResolver } from "@deploy-core-worker/s3-storages/safe-url";
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
/** No case of the goldens reaches an S3 endpoint; the one test that does gives its own exchange. */
let s3Http: S3Http = async (url) => {
  throw new Error(`no S3 request expected: ${url}`);
};

/** The runners over the case's database, for team 1's org. */
function runners(db: TransactionalSqlExecutor, allow = true): Partial<ApiV1Runners> {
  return {
    sql: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, fn),
    rows: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, (tx) => fn((table, where, params) => apiRows(tx, table, where ?? null, params ?? []))),
    allows: async () => allow,
    org: async () => ({ id: ORG_PUBLIC, name: "Parity Team", createdAt: "2026-01-01T00:00:00.000Z" }),
    s3: { resolve, http: (url, init) => s3Http(url, init), sleep: async () => undefined },
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
const MIDDLEWARE_ANSWERS = new Set(["tags: delete with a write token", "environment envs: list with a write-only token"]);
const GROUP = /^(tags|application tags|database tags|service tags|project envs|environment envs|s3 storages): /;
const OPERATION_CASES = CASES.cases.filter((c) => GROUP.test(c.name) && c.token && !MIDDLEWARE_ANSWERS.has(c.name));

/**
 * Departures: Freeploy's answer differs from Coolify's on purpose. Only S3-compatible storages are ported: an SFTP, FTPS or
 * WebDAV storage answers 501 in Coolify's envelope and nothing is stored, where Coolify stores it.
 */
const DEPARTURES: Record<string, { status: number; body: string }> = {
  "s3 storages: create an SFTP storage": { status: 501, body: '{"message":"SFTP storages are not available yet."}' },
};

describe("the goldens of DP-81", () => {
  it("cover the operations ported", () => {
    expect(OPERATION_CASES.length).toBeGreaterThanOrEqual(60);
  });
});

describe("Freeploy answers as Coolify does (DP-81)", () => {
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

describe("what a write leaves behind (DP-81)", () => {
  it("has the rows of every write", () => {
    expect(AFTER_CASES.length).toBeGreaterThanOrEqual(20);
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

describe("an S3 storage's connection test (DP-81)", () => {
  afterEach(() => {
    s3Http = async (url) => {
      throw new Error(`no S3 request expected: ${url}`);
    };
  });

  it("lists the bucket with the stored credentials, then saves the storage usable", async () => {
    const seen: string[] = [];
    s3Http = async (url, init) => {
      seen.push(`${init.method} ${url} ${init.headers.authorization?.split(",")[0] ?? ""}`);
      return { status: 200, headers: new Headers({ "content-type": "application/xml" }), body: '<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>parity-backups</Name><KeyCount>0</KeyCount></ListBucketResult>' };
    };
    const c = caseNamed("s3 storages: validate, an invalid bucket");
    const out = await fixture.inCase(async (db) => {
      const res = await send({ ...c, setup: ["update s3_storages set is_usable = false, unusable_email_sent = true where uuid = 's3paritystorage000000001'"] }, db);
      return [res.status, await res.text(), await query(db, "select is_usable, unusable_email_sent, use_path_style_endpoint from s3_storages where uuid = 's3paritystorage000000001'")];
    });
    expect(out).toEqual([200, '{"valid":true,"message":"S3 storage connection is valid."}', [{ is_usable: true, unusable_email_sent: false, use_path_style_endpoint: true }]]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^GET https:\/\/s3\.example\.com\/parity-backups\/\?.*list-type=2.* AWS4-HMAC-SHA256 Credential=AKIAPARITYKEY\/\d{8}\/us-east-1\/s3\/aws4_request$/);
  });
});

describe("authorization and the other team (DP-81)", () => {
  it("answers Laravel's 403 when policy-worker denies the token's user, after the 404 of an unknown resource", async () => {
    const out = await fixture.inCase(async (db) => {
      const created = await send(caseNamed("tags: create"), db, false);
      const listed = await send(caseNamed("application tags: list"), db, false);
      const unknown = await send(caseNamed("application tags: list of unknown"), db, false);
      return [created.status, await created.text(), listed.status, unknown.status];
    });
    expect(out).toEqual([403, '{"message":"This action is unauthorized."}', 403, 404]);
  });

  it("never lists, renames or deletes another team's tag", async () => {
    const listed = await replay(caseNamed("tags: list"));
    expect(listed.body).not.toContain("t4otherteamtag0000000004");
    await fixture.inCase(async (db) => {
      await send(caseNamed("tags: update another team's"), db);
      await send(caseNamed("tags: delete another team's"), db);
      const theirs = await withOrg(db, ORG_UUID[2]!, async (tx) => (await tx.execute("SELECT name FROM deploy.tags")).rows);
      const pivot = await withOrg(db, ORG_UUID[2]!, async (tx) => (await tx.execute("SELECT tag_id FROM deploy.taggables")).rows);
      expect([theirs, pivot.length]).toEqual([[{ name: "theirs" }], 1]);
    });
  });
});
