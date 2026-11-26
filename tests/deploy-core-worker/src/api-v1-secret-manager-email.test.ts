// Coolify's /api/v1/{applications,services,databases}/{uuid}/secret-manager[/keys|/references|/import] and
// /api/v1/settings/email (DP-106) replayed against Coolify's real answers: fixtures/api/goldens.json, emitted by Coolify's
// PHP through its HTTP kernel on PostgreSQL with Doppler's, Infisical's and Vault's APIs faked by Http::fake() (see
// fixtures/api/README.md). The fixture is made in Freeploy's own database (api-v1-database.ts), each request goes to
// deploy-core-worker's handler with the headers api-edge sends, the handler's fetch serves the same fake answers, and the
// status, the body (byte for byte after the masking both sides share), the requests sent to the secret manager (the
// decrypted token, Vault's headers) and the rows each write left are compared. The instance's email settings are the
// platform operator's: a case's root-team token (`rootTeamToken`) is the operator's token in Freeploy, any other token's
// user is not the operator; the rows are row 0 of deploy.instance_settings, read as the operator. Each case is rolled back.
import { handleApiV1, type ApiV1Runners } from "@deploy-core-worker/api-v1/handler";
import type { Env } from "@deploy-core-worker/env";
import type { HostResolver } from "@deploy-core-worker/s3-storages/safe-url";
import { columnCipher } from "@deploy-core-worker/handlers/cloud-tokens";
import { sqlPlatformMoreStore } from "@deploy-core-worker/handlers/platform-settings-more";
import { phpSortStrings, referencesToImport } from "@deploy-core-worker/integration-tokens/secret-managers";
import { apiRows, asPlatformAdmin, readPlatformSettings, withOrg } from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { API_V1_HEADERS } from "@saas/contracts/coolify-api";
import { CASES, golden, maskedJson, type Case, type HttpRequestRecord, type Step } from "./api-v1-goldens.js";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";

const ORG_PUBLIC = "org_" + "0".repeat(31) + "a";
const env = { ENVIRONMENT: "test", DEPLOY_ENCRYPTION_KEY: TEST_KEK, DEPLOY_CONSOLE_URL: "http://localhost" } as Env;
const T1 = 1;
const CLOCK = new Date("2026-01-01T00:00:00Z");

/** DP-106's case fields: a root-team token (Coolify's instance admin) and an integration token's replaced secret. */
interface Dp106Case extends Case {
  rootTeamToken?: { key: string; id: number; user: number; abilities: string[]; secret: string };
  tokenSecrets?: Array<{ id: number; token: string }>;
}
interface Caller {
  user: number;
  abilities: string[];
  operator: boolean;
}

const roleOf = (userId: number) => CASES.fixture.users.find((u) => u.id === userId)!.teams.find((t) => t.team === T1)?.role ?? null;
const isAdmin = (userId: number) => ["owner", "admin"].includes(roleOf(userId) ?? "");
const userPublic = (id: number) => `usr_${String(id).padStart(32, "0")}`;
const caseNamed = (name: string) => CASES.cases.find((c) => c.name === name)! as Dp106Case;

/** Who sends a step: a fixture token's user, or a root-team token's — the platform operator's. */
function callerOf(c: Dp106Case, step: Step): Caller {
  if (step.token) {
    const t = CASES.fixture.tokens.find((x) => x.key === step.token)!;
    return { user: t.user, abilities: t.abilities, operator: false };
  }
  const root = c.rootTeamToken!;
  const id = Number(/Bearer (\d+)\|/.exec(step.authorization ?? "")?.[1]);
  const abilities = id === root.id ? root.abilities : ROOT_ABILITIES[id]!;
  return { user: root.user, abilities, operator: true };
}
/** The root-team tokens of the sequence case (cases.mjs's ROOT_TEAM_TOKENS), by id. */
const ROOT_ABILITIES: Record<number, string[]> = { 51: ["root"], 52: ["read"], 53: ["read", "read:sensitive"], 54: ["read", "write"], 55: ["read", "write:sensitive"] };

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

/** The secret managers' APIs as emit.php fakes them: the case's answers (a failed connection throws, as fetch does), else a 404; every request recorded. */
function fakeFetch(c: Case, requests: HttpRequestRecord[]): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const text = typeof init?.body === "string" ? init.body : "";
    const header = (name: string) => (headers.get(name) !== null ? { [name]: headers.get(name)! } : {});
    requests.push({ method, url, ...header("authorization"), ...header("x-vault-token"), ...header("x-vault-namespace"), ...(text !== "" && { body: JSON.parse(text) as unknown }) });
    for (const a of c.http ?? []) {
      if (new RegExp(a.match).test(`${method} ${url}`)) {
        if (a.failedConnection) throw new TypeError("fetch failed");
        return new Response(a.raw !== undefined ? a.raw : JSON.stringify(a.body ?? []), { status: a.status ?? 200, headers: { "content-type": "application/json", ...a.headers } });
      }
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
  };
}

/** Host names as emit.php's SafeWebhookUrl::resolveHostsUsing() table resolves them (no DNS is asked). */
const resolve: HostResolver = async (host) => (host === "unresolvable.example" ? [] : host === "private.example" ? ["10.0.0.5"] : ["93.184.216.34"]);

type Allow = { read: boolean; write: boolean };
/** policy-worker's answers: an owner may write; Freeploy's member reads only (Coolify's default member, team-wide read). */
const allowOf = (caller: Caller): Allow => (roleOf(caller.user) === "member" ? { read: true, write: false } : { read: true, write: true });

interface Seen {
  operatorAsked: string[];
  platformOpened: number;
}

function runners(db: TransactionalSqlExecutor, caller: Caller, fetch: typeof globalThis.fetch, seen: Seen, allow: Allow = allowOf(caller)): Partial<ApiV1Runners> {
  return {
    sql: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, fn),
    rows: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, (tx) => fn((table, where, params) => apiRows(tx, table, where ?? null, params ?? []))),
    allows: async (action) => (action === "deploy.resource.write" ? allow.write : allow.read),
    org: async () => ({ id: ORG_PUBLIC, name: "Parity Team", createdAt: "2026-01-01T00:00:00.000Z" }),
    s3: { resolve, http: async (url) => Promise.reject(new Error(`no S3 request expected: ${url}`)), sleep: async () => undefined },
    providers: { fetch, sleep: async () => undefined, now: () => CLOCK },
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

const query = (db: TransactionalSqlExecutor, sql: string, asOperator = false) => {
  const run = async (tx: Parameters<Parameters<typeof withOrg>[2]>[0]) => {
    await tx.execute("SET LOCAL search_path TO deploy");
    return (await tx.execute(sql)).rows;
  };
  return asOperator ? asPlatformAdmin(db, run) : withOrg(db, ORG_UUID[T1]!, run);
};
const isEmailCase = (c: Case) => c.name.startsWith("settings email: ");

/**
 * setup, setupFreeploy, then each integration token's replaced secret, encrypted with the org's key. An email case starts
 * from the platform's row 0 as emit.php's fixture has it (InstanceSettings 0, made before any case; Freeploy's is made by
 * its first read).
 */
async function prepare(c: Dp106Case, db: TransactionalSqlExecutor): Promise<void> {
  if (isEmailCase(c)) await asPlatformAdmin(db, (tx) => readPlatformSettings(tx));
  for (const sql of [...(c.setup ?? []), ...(c.setupFreeploy ?? [])]) await query(db, sql);
  for (const t of c.tokenSecrets ?? []) {
    await withOrg(db, ORG_UUID[T1]!, async (tx) => {
      const sealed = await columnCipher(tx, ORG_UUID[T1]!, TEST_KEK, "integration_tokens.token").encrypt(t.token);
      await tx.execute("UPDATE deploy.integration_tokens SET token = $1 WHERE id = $2", [sealed, t.id]);
    });
  }
}

async function sendStep(c: Dp106Case, step: Step, db: TransactionalSqlExecutor, seen: Seen, allow?: Allow) {
  const caller = callerOf(c, step);
  const requests: HttpRequestRecord[] = [];
  const req = forwarded(step, caller);
  const path = new URL(req.url).pathname.replace(`/v1/internal/api-v1/${ORG_PUBLIC}`, "");
  const res = await handleApiV1(req, env, "req_test", { subjectId: userPublic(caller.user), subjectType: "user" }, ORG_UUID[T1]!, ORG_PUBLIC, path, runners(db, caller, fakeFetch(c, requests), seen, allow));
  return { status: res.status, body: await res.text(), requests };
}

async function afterRows(db: TransactionalSqlExecutor, c: Case): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const [label, sql] of Object.entries(c.after ?? {})) out[label] = await query(db, sql, isEmailCase(c));
  return out;
}

async function replay(c: Dp106Case, withAfter = false) {
  return fixture.inCase(async (db) => {
    await prepare(c, db);
    const seen: Seen = { operatorAsked: [], platformOpened: 0 };
    const steps = [];
    for (const step of c.sequence ?? [c]) steps.push(await sendStep(c, step, db, seen));
    return { steps, after: withAfter ? await afterRows(db, c) : undefined, seen };
  });
}

/** The cases whose answer is the middleware's (an ability api.ability refuses; tests/api-edge replays them). */
const MIDDLEWARE_BODY = /^\{"message":"Missing required permissions: [a-z:]+"\}$/;
const isMiddleware = (c: Case) => golden(c.name).status === 403 && MIDDLEWARE_BODY.test(golden(c.name).body?.json ?? "");
/** The paths routes/api.php has no route for: the fallback 404 (api-edge answers it; tests/api-edge replays them). */
const isFallback = (c: Case) => golden(c.name).body?.json === '{"message":"Not found.","docs":"https:\\/\\/coolify.io\\/docs"}';
const ALL = CASES.cases.filter((c) => c.name.startsWith("secret manager: ") || isEmailCase(c)) as Dp106Case[];
const DP106_CASES = ALL.filter((c) => !isMiddleware(c) && !isFallback(c));

describe("the goldens of DP-106", () => {
  it("cover every operation", () => {
    expect(ALL.length).toBe(106);
    for (const prefix of ["secret manager: show", "secret manager: set", "secret manager: remove", "secret manager: keys", "secret manager: reference", "secret manager: import", "settings email: show", "settings email: update"]) {
      expect(DP106_CASES.some((c) => c.name.startsWith(prefix))).toBe(true);
    }
    // Each secret manager was asked; each resource type has a source.
    const urls = DP106_CASES.flatMap((c) => (golden(c.name).requests ?? []).map((r) => r.url));
    for (const host of ["api.doppler.com", "app.infisical.com", "vault.example.com"]) expect(urls.some((u) => new URL(u).hostname === host)).toBe(true);
    for (const type of ["applications", "services", "databases"]) expect(DP106_CASES.some((c) => c.path.startsWith(`/api/v1/${type}/`) && golden(c.name).status === 200)).toBe(true);
  });
});

describe("Freeploy answers as Coolify does, and asks the secret manager what Coolify asks (DP-106)", () => {
  it.each(DP106_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const g = golden(name);
    const got = await replay(c);
    const want = g.steps ?? [g];
    expect(got.steps).toHaveLength(want.length);
    for (const [i, step] of got.steps.entries()) {
      const w = want[i]!;
      if (w.body.json !== undefined && process.env.API_DIFF && (maskedJson(step.body) !== maskedJson(w.body.json) || step.status !== w.status)) console.warn(`${name} ${step.status}/${w.status}\nfreeploy: ${maskedJson(step.body)}\ncoolify:  ${maskedJson(w.body.json)}`);
      expect(step.status).toBe(w.status);
      if (w.body.json !== undefined) expect(maskedJson(step.body)).toBe(maskedJson(w.body.json));
      else expect(step.body).toBe(w.body.text);
    }
    if (c.http) expect(got.steps.flatMap((s) => s.requests)).toEqual(g.requests ?? []);
  });
});

const AFTER_CASES = DP106_CASES.filter((c) => c.after);

describe("what a write leaves behind (DP-106)", () => {
  it("has the rows of the writes", () => {
    expect(AFTER_CASES.length).toBeGreaterThanOrEqual(35);
  });

  it.each(AFTER_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const got = await replay(c, true);
    if (process.env.API_DIFF && JSON.stringify(got.after) !== JSON.stringify(golden(name).after)) console.warn(`${name}\nfreeploy: ${JSON.stringify(got.after)}\ncoolify:  ${JSON.stringify(golden(name).after)}`);
    expect(got.after).toEqual(golden(name).after);
  });
});

describe("authorization, isolation and the secrets (DP-106)", () => {
  it("answers 403 when policy-worker denies the token's user, after the resource's 404, and asks no secret manager", async () => {
    const DENIED = { read: false, write: false };
    const seen: Seen = { operatorAsked: [], platformOpened: 0 };
    const results: Array<[number, number, unknown]> = [];
    for (const name of ["secret manager: show, an application's Doppler source", "secret manager: set, a Doppler service token", "secret manager: remove, a service's source", "secret manager: keys, a Vault source", "secret manager: reference, an application's key", "secret manager: import, a database's keys"]) {
      const c = caseNamed(name);
      results.push(
        await fixture.inCase(async (db) => {
          await prepare(c, db);
          const before = await query(db, "select count(*)::int as links, (select count(*)::int from environment_variables) as variables from secret_manager_links");
          const { status, requests } = await sendStep(c, c, db, seen, DENIED);
          const changed = JSON.stringify(await query(db, "select count(*)::int as links, (select count(*)::int from environment_variables) as variables from secret_manager_links")) !== JSON.stringify(before);
          return [status, requests.length, changed] as [number, number, unknown];
        }),
      );
    }
    for (const name of ["secret manager: show, unknown application", "secret manager: keys, unknown application", "secret manager: remove, unknown service"]) {
      results.push(await fixture.inCase(async (db) => [(await sendStep(caseNamed(name), caseNamed(name), db, seen, DENIED)).status, 0, false] as [number, number, unknown]));
    }
    expect(results).toEqual([...Array(6).fill([403, 0, false]), [404, 0, false], [404, 0, false], [404, 0, false]]);
  });

  it("stores the {{vault.KEY}} variables encrypted with the org's key, and never a secret's value", async () => {
    await fixture.inCase(async (db) => {
      const c = caseNamed("secret manager: import, an application's keys");
      await prepare(c, db);
      const seen: Seen = { operatorAsked: [], platformOpened: 0 };
      expect((await sendStep(c, c, db, seen)).status).toBe(200);
      const rows = await query(db, "select key, value from environment_variables where resourceable_type = 'App\\Models\\Application' and resourceable_id = 1 and key in ('API_KEY', 'B_KEY', 'DATABASE_URL') order by id");
      expect(rows).toHaveLength(6);
      for (const row of rows) {
        expect(String(row.value)).not.toContain("vault.");
        const plain = await withOrg(db, ORG_UUID[T1]!, (tx) => columnCipher(tx, ORG_UUID[T1]!, TEST_KEK, "environment_variables.value").decrypt(String(row.value)));
        expect(plain).toBe(`{{vault.${String(row.key)}}}`);
      }
      // The secrets the fake answered (postgres://x among them) are stored nowhere.
      const dump = JSON.stringify(await query(db, "select settings::text from secret_manager_links"));
      expect(dump).not.toContain("postgres://x");
    });
  });

  it("answers a secret manager that cannot be reached with the fetch's error, and creates nothing", async () => {
    await fixture.inCase(async (db) => {
      const c: Dp106Case = { ...caseNamed("secret manager: import, an application's keys"), http: [{ match: "^GET https://api\\.doppler\\.com/", failedConnection: true }] };
      await prepare(c, db);
      const before = await query(db, "select count(*)::int as n from environment_variables");
      const got = await sendStep(c, c, db, { operatorAsked: [], platformOpened: 0 });
      expect(got.status).toBe(400);
      expect(JSON.parse(got.body)).toEqual({ message: "Could not fetch keys: fetch failed" });
      expect(await query(db, "select count(*)::int as n from environment_variables")).toEqual(before);
    });
  });

  it("never links another org's resource or token", async () => {
    await fixture.inCase(async (db) => {
      const seen: Seen = { operatorAsked: [], platformOpened: 0 };
      const c = caseNamed("secret manager: show, an application without a source");
      const shown = JSON.parse((await sendStep(c, c, db, seen)).body) as { available_tokens: Array<{ uuid: string }> };
      expect(shown.available_tokens.map((t) => t.uuid)).toEqual(["i3paritydoppler000000003", "i4parityinfisical0000004", "i5parityvault00000000005"]);
      for (const name of ["secret manager: show, another team's application", "secret manager: set, another team's token", "secret manager: import, another team's service"]) expect((await sendStep(caseNamed(name), caseNamed(name), db, seen)).status).toBe(404);
    });
  });

  it("sorts and splits the key names as PHP does", () => {
    expect(phpSortStrings(["b", "10", "9", "A", "_x", "1e3"])).toEqual(["9", "10", "1e3", "A", "_x", "b"]);
    expect(referencesToImport(["B", "a.b", "1X", "db-password", "FOO"], new Set(["FOO"]))).toEqual({ imported: ["B", "a.b"], skipped: ["1X", "db-password"] });
  });
});

describe("the instance's email settings are the platform operator's (DP-106)", () => {
  it("opens no store for a token whose user is not the operator", async () => {
    for (const name of ["settings email: show, a team token", "settings email: update, a team token"]) {
      const got = await replay(caseNamed(name));
      expect(got.steps[0]!.status).toBe(403);
      expect(got.seen.platformOpened).toBe(0);
      expect(got.seen.operatorAsked).toEqual([caseNamed(name).method === "GET" ? "platform.settings.read" : "platform.settings.update"]);
    }
  });

  it("stores the secrets as ciphertexts under the platform's key, never in plain text", async () => {
    await fixture.inCase(async (db) => {
      const c = caseNamed("settings email: update, every setting");
      const seen: Seen = { operatorAsked: [], platformOpened: 0 };
      expect((await sendStep(c, c, db, seen)).status).toBe(200);
      const [row] = await query(db, "select smtp_password, resend_api_key, smtp_host, smtp_port from instance_settings where id = 0", true);
      expect(String(row!.smtp_password)).not.toContain("smtp-secret");
      expect(String(row!.resend_api_key)).not.toContain("re_parity_key");
      expect(String(row!.smtp_host)).not.toContain("smtp.example.com");
      expect(row!.smtp_port).toBe(587);
    });
  });
});
