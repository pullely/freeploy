// Coolify's /api/v1 cloud-init scripts (GET/POST /cloud-init-scripts, GET/PATCH/DELETE /cloud-init-scripts/{uuid}) and the
// cloud servers made through a provider token (POST /servers/hetzner, /servers/vultr, /servers/digitalocean) (DP-110),
// replayed against Coolify's real answers: fixtures/api/goldens.json, emitted by Coolify's PHP through its HTTP kernel on
// PostgreSQL with the providers faked by Http::fake() (see fixtures/api/README.md). The fixture is made in Freeploy's own
// database (api-v1-database.ts), whose private keys are the committed test keys; a case's cloud-init scripts are stored
// encrypted with the org's key (emit.php makes them through the model); each request goes to deploy-core-worker's handler
// with the headers api-edge sends, the handler's fetch serves the same fake answers, and the status, the body (byte for
// byte after the masking both sides share), the Retry-After header, the requests sent to the provider and the rows each
// write left are compared. ValidCloudInitYaml's 422s carry Symfony YAML's parse errors (DP-110's port). Each case is
// rolled back.
import { handleApiV1, type ApiV1Runners } from "@deploy-core-worker/api-v1/handler";
import type { Env } from "@deploy-core-worker/env";
import { columnCipher } from "@deploy-core-worker/handlers/cloud-tokens";
import { CLOUD_SERVER_MESSAGES } from "@deploy-core-worker/api-v1/cloud-servers";
import { apiRows, insertCloudInitScript, withOrg } from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { API_V1_HEADERS } from "@saas/contracts/coolify-api";
import { CASES, golden, maskedJson, type Case, type FixtureToken, type HttpRequestRecord } from "./api-v1-goldens.js";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";

const ORG_PUBLIC = "org_" + "0".repeat(31) + "a";
const env = { ENVIRONMENT: "test", DEPLOY_ENCRYPTION_KEY: TEST_KEK, DEPLOY_CONSOLE_URL: "http://localhost" } as Env;
const T1 = 1;
const COLUMN = "cloud_init_scripts.script";

interface ScriptRow {
  uuid: string;
  team: number;
  name: string;
  script: string;
  created_at: string;
}
interface Dp110Case extends Case {
  cloudInitScripts?: ScriptRow[];
}

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

/** A request's body as emit.php records it: none for an empty body, else the decoded JSON (`[]` included). */
const recordedBody = (text: string): unknown => (text === "" ? undefined : (JSON.parse(text) as unknown));

/** generate_random_name() in what the provider was sent (the server's name, label and hostname): random on both sides. */
const RANDOM_NAME = /\b[a-z]+(?:-[a-z]+)+-[a-z0-9]{24}\b/g;
const maskedRequests = (requests: readonly HttpRequestRecord[]): unknown => JSON.parse(JSON.stringify(requests).replace(RANDOM_NAME, "<random-name>"));

/** The provider as emit.php fakes it: the case's answers (the first whose `match` fits "METHOD URL"), else a 404; every request recorded. */
function fakeFetch(c: Case, requests: HttpRequestRecord[]): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = recordedBody(typeof init?.body === "string" ? init.body : "");
    requests.push({ method, url, ...(headers.get("authorization") !== null && { authorization: headers.get("authorization")! }), ...(body !== undefined && { body }) });
    for (const a of c.http ?? []) {
      if (new RegExp(a.match).test(`${method} ${url}`)) return new Response(a.raw !== undefined ? a.raw : JSON.stringify(a.body ?? []), { status: a.status ?? 200, headers: { "content-type": "application/json", ...a.headers } });
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
  };
}

function runners(db: TransactionalSqlExecutor, fetch: typeof globalThis.fetch, member: boolean): Partial<ApiV1Runners> {
  return {
    sql: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, fn),
    rows: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, (tx) => fn((table, where, params) => apiRows(tx, table, where ?? null, params ?? []))),
    // policy-worker: an owner may write; Freeploy's member reads only.
    allows: async (action) => action === "deploy.resource.read" || !member,
    org: async () => ({ id: ORG_PUBLIC, name: "Parity Team", createdAt: "2026-01-01T00:00:00.000Z" }),
    providers: { fetch, sleep: async () => undefined },
  };
}

const query = (db: TransactionalSqlExecutor, sql: string) =>
  withOrg(db, ORG_UUID[T1]!, async (tx) => {
    await tx.execute("SET LOCAL search_path TO deploy");
    return (await tx.execute(sql)).rows;
  });

/** A case's cloud-init scripts, in their own org, the script encrypted with that org's key, the dates fixed. */
async function seedScripts(db: TransactionalSqlExecutor, rows: ScriptRow[]): Promise<void> {
  for (const s of rows) {
    const orgId = ORG_UUID[s.team]!;
    await withOrg(db, orgId, async (tx) => {
      const row = await insertCloudInitScript(tx, { orgId, uuid: s.uuid, name: s.name, script: await columnCipher(tx, orgId, TEST_KEK, COLUMN).encrypt(s.script) });
      await tx.execute("UPDATE deploy.cloud_init_scripts SET created_at = $2, updated_at = $2 WHERE id = $1", [row.id, s.created_at]);
    });
  }
}

/** The scripts of the org decrypted, by name: what each write stored. */
const storedScripts = (db: TransactionalSqlExecutor) =>
  withOrg(db, ORG_UUID[T1]!, async (tx) => {
    const cipher = columnCipher(tx, ORG_UUID[T1]!, TEST_KEK, COLUMN);
    const out: Record<string, string> = {};
    for (const r of (await tx.execute<{ name: string; script: string }>("SELECT name, script FROM deploy.cloud_init_scripts ORDER BY id")).rows) out[r.name] = await cipher.decrypt(r.script);
    return out;
  });

async function replay(c: Dp110Case) {
  return fixture.inCase(async (db) => {
    await seedScripts(db, c.cloudInitScripts ?? []);
    for (const sql of [...(c.setup ?? []), ...(c.setupFreeploy ?? [])]) await query(db, sql);
    const requests: HttpRequestRecord[] = [];
    const t = tokenOf(c.token!);
    const req = forwarded(c);
    const path = new URL(req.url).pathname.replace(`/v1/internal/api-v1/${ORG_PUBLIC}`, "");
    const res = await handleApiV1(req, env, "req_test", { subjectId: userPublic(t.user), subjectType: "user" }, ORG_UUID[T1]!, ORG_PUBLIC, path, runners(db, fakeFetch(c, requests), roleOf(t.user) === "member"));
    const after: Record<string, unknown[]> = {};
    for (const [label, sql] of Object.entries(c.after ?? {})) after[label] = await query(db, sql);
    return { status: res.status, body: await res.text(), retryAfter: res.headers.get("retry-after"), requests, after, scripts: await storedScripts(db) };
  });
}

const GROUP = /^(cloud-init scripts|server via Hetzner|server via Vultr|server via DigitalOcean): /;
/** The middleware's answers (an ability api.ability refuses, a member's token beyond the member's access, the fallback 404): tests/api-edge replays them. */
const MIDDLEWARE = /^\{"message":"(Missing required permissions: [a-z:]+|This API token has more access than you have in this team\. Revoke it and create a new token\.|Not found\.)"(,"docs":"[^"]+")?\}$/;
const DP110_CASES = CASES.cases.filter((c) => GROUP.test(c.name) && !MIDDLEWARE.test(golden(c.name).body.json ?? "")) as Dp110Case[];

/**
 * Departures: ValidateNewCloudServerJob (over SSH) is queued after the provider made the server and the row was stored —
 * Freeploy answers 501 there, with the same requests and rows.
 */
const VALIDATE = { status: 501, body: JSON.stringify({ message: CLOUD_SERVER_MESSAGES.validateUnavailable }) };
const DEPARTURES: Record<string, { status: number; body: string }> = {
  "server via Hetzner: create and validate": VALIDATE,
  "server via Vultr: create and validate": VALIDATE,
  "server via DigitalOcean: create and validate": VALIDATE,
};

describe("the goldens of DP-110's cloud-init script and cloud server routes", () => {
  it("cover every operation, Symfony's parse errors among the refusals", () => {
    expect(DP110_CASES.length).toBe(129);
    for (const prefix of ["cloud-init scripts: list", "cloud-init scripts: create", "cloud-init scripts: show", "cloud-init scripts: update", "cloud-init scripts: delete", "server via Hetzner: create", "server via Vultr: create", "server via DigitalOcean: create"]) {
      expect(DP110_CASES.some((c) => c.name.startsWith(prefix))).toBe(true);
    }
    const yamlErrors = DP110_CASES.filter((c) => / at line \d+/.test(golden(c.name).body.json ?? ""));
    expect(yamlErrors.length).toBe(35);
    // The key Coolify found at Hetzner is the fixture key's, by its MD5 fingerprint (the second of the account's keys).
    const create = (golden("server via Hetzner: create").requests ?? []) as HttpRequestRecord[];
    expect((create[1]!.body as { ssh_keys: number[] }).ssh_keys).toEqual([12]);
    // An uploaded key is the fixture key's real public key.
    const upload = (golden("server via Vultr: create, the key uploaded").requests ?? [])[1] as HttpRequestRecord;
    expect((upload.body as { ssh_key: string }).ssh_key).toMatch(/^ssh-ed25519 AAAA[A-Za-z0-9+/]+ $/);
  });
});

describe("Freeploy answers, stores and asks the provider as Coolify does (DP-110)", () => {
  it.each(DP110_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const g = golden(name);
    const got = await replay(c);
    if (process.env.API_DIFF && JSON.stringify(maskedRequests(got.requests)) !== JSON.stringify(maskedRequests(g.requests ?? []))) console.warn(`${name}\nfreeploy: ${JSON.stringify(got.requests).slice(0, 1500)}\ncoolify:  ${JSON.stringify(g.requests ?? []).slice(0, 1500)}`);
    if (c.http) expect(maskedRequests(got.requests)).toEqual(maskedRequests(g.requests ?? []));
    else expect(got.requests).toEqual([]);
    if (DEPARTURES[name]) {
      expect({ status: got.status, body: got.body }).toEqual(DEPARTURES[name]);
      expect(got.after).toEqual(g.after);
      return;
    }
    if (process.env.API_DIFF && (got.status !== g.status || maskedJson(got.body) !== maskedJson(g.body.json ?? got.body))) console.warn(`${name} ${got.status}/${g.status}\nfreeploy: ${got.body.slice(0, 600)}\ncoolify:  ${(g.body.json ?? g.body.text ?? "").slice(0, 600)}`);
    expect(got.status).toBe(g.status);
    expect(got.retryAfter).toBe(g.headers["retry-after"] ?? null);
    if (g.body.json !== undefined) expect(maskedJson(got.body)).toBe(maskedJson(g.body.json));
    else expect(got.body).toBe(g.body.text);
    if (c.after) {
      if (process.env.API_DIFF && JSON.stringify(got.after) !== JSON.stringify(g.after)) console.warn(`${name}\nfreeploy: ${JSON.stringify(got.after)}\ncoolify:  ${JSON.stringify(g.after)}`);
      expect(got.after).toEqual(g.after);
    }
    // A script that was written is stored encrypted and decrypts to what was sent (Coolify's ciphertext is its own).
    const sent = (c.body ?? {}) as { name?: unknown; script?: unknown };
    if (name.startsWith("cloud-init scripts: ") && g.status < 300 && typeof sent.script === "string") {
      const stored = Object.entries(got.scripts).find(([n]) => n === (typeof sent.name === "string" ? sent.name.trim() : undefined) || c.method === "PATCH");
      expect(Object.values(got.scripts)).toContain(sent.script.trim());
      expect(stored).toBeDefined();
    }
  });
});
