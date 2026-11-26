// Coolify's /api/v1/vulnerabilities and /api/v1/{applications,services,databases}/{uuid}/vulnerabilities (DP-113), replayed
// against Coolify's real answers: fixtures/api/goldens.json, emitted by Coolify's PHP through its HTTP kernel on PostgreSQL
// (see fixtures/api/README.md). The fixture is made in Freeploy's own database (api-v1-database.ts). A case's image scans
// (`imageScans`) are inserted one after the other and each summary is written by the port of
// ResourceScans::refreshSummaries() — as emit.php writes Coolify's through the model — so the stored statuses are compared
// too (`after`), and its service variables (`serviceVariables`) are stored encrypted with the org's key. A scan of the other
// team's server goes into the other team's org. The clock is the fixture's. Each case is rolled back.
import { handleApiV1, type ApiV1Runners } from "@deploy-core-worker/api-v1/handler";
import type { Env } from "@deploy-core-worker/env";
import { columnCipher } from "@deploy-core-worker/handlers/cloud-tokens";
import { refreshScanSummary } from "@deploy-core-worker/image-scan/data";
import { phpArrayJson } from "@deploy-core-worker/image-scan/data";
import { diffForHumans, versionCompare } from "@deploy-core-worker/image-scan/php";
import { apiRows, withOrg } from "@saas/db/deploy";
import type { SqlExecutor, TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { API_V1_HEADERS } from "@saas/contracts/coolify-api";
import { CASES, golden, maskedJson, type Case, type FixtureToken } from "./api-v1-goldens.js";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";

const ORG_PUBLIC = "org_" + "0".repeat(31) + "a";
const env = { ENVIRONMENT: "test", DEPLOY_ENCRYPTION_KEY: TEST_KEK, DEPLOY_CONSOLE_URL: "http://localhost" } as Env;
const T1 = 1;
const NOW = new Date("2026-01-01T00:00:00Z");

interface ScanCase {
  uuid: string;
  server_id: number;
  image_id: string;
  repo_digest: string | null;
  owner: string;
  resource_id: number;
  image_ref: string;
  deployment_queue_id: number | null;
  status: string;
  error_code: string | null;
  error_context: unknown;
  findings: unknown;
  candidates: unknown;
  base_image_ref: string | null;
  builds_image: boolean;
  is_baseline: boolean;
  grype_db_built_at: string | null;
  scanned_at: string | null;
  eol_distro: unknown;
  truncated: boolean;
  stored?: boolean;
  summary?: unknown;
}
interface Dp113Case extends Case {
  imageScans?: ScanCase[];
  serviceVariables?: Array<{ service: number; key: string; value: string }>;
}

const OWNER_MORPH: Record<string, string> = {
  application: "App\\Models\\Application",
  serviceApplication: "App\\Models\\ServiceApplication",
  serviceDatabase: "App\\Models\\ServiceDatabase",
  postgresql: "App\\Models\\StandalonePostgresql",
  redis: "App\\Models\\StandaloneRedis",
  mongodb: "App\\Models\\StandaloneMongodb",
  mysql: "App\\Models\\StandaloneMysql",
  mariadb: "App\\Models\\StandaloneMariadb",
  keydb: "App\\Models\\StandaloneKeydb",
  dragonfly: "App\\Models\\StandaloneDragonfly",
  clickhouse: "App\\Models\\StandaloneClickhouse",
  sqlite: "App\\Models\\StandaloneSqlite",
};

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
  const [path, query] = c.path.slice("/api/v1".length).split("?");
  return new Request(`https://deploy-core.internal/v1/internal/api-v1/${ORG_PUBLIC}${path}${query ? `?${query}` : ""}`, { method: c.method, headers });
}

let fixture: FixtureDatabase;
beforeAll(async () => {
  fixture = await fixtureDatabase();
}, 120_000);
afterAll(async () => fixture?.pg.close());

function runners(db: TransactionalSqlExecutor): Partial<ApiV1Runners> {
  return {
    sql: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, fn),
    rows: (_e, _o, fn) => withOrg(db, ORG_UUID[T1]!, (tx) => fn((table, where, params) => apiRows(tx, table, where ?? null, params ?? []))),
    // policy-worker: Freeploy's member reads (view), as Coolify's default member does.
    allows: async (action) => action === "deploy.resource.read",
    org: async () => ({ id: ORG_PUBLIC, name: "Parity Team", createdAt: "2026-01-01T00:00:00.000Z" }),
    now: () => NOW,
  };
}

const query = (db: TransactionalSqlExecutor, sql: string, org = ORG_UUID[T1]!) =>
  withOrg(db, org, async (tx) => {
    await tx.execute("SET LOCAL search_path TO deploy");
    return (await tx.execute(sql)).rows;
  });

const decrypt = (tx: SqlExecutor, org: string) => {
  const cipher = columnCipher(tx, org, TEST_KEK, "environment_variables.value");
  return (stored: string) => cipher.decrypt(stored);
};

/** emit.php's image scans: inserted one after the other, each summary written as the scanner writes it. */
async function seedScans(db: TransactionalSqlExecutor, scans: readonly ScanCase[]): Promise<void> {
  for (const s of scans) {
    const org = ORG_UUID[s.server_id === 2 ? 2 : T1]!;
    await withOrg(db, org, async (tx) => {
      const summary = s.summary ?? { ignored: 0, eol_distro: s.eol_distro, truncated: s.truncated };
      const r = await tx.execute<{ id: number }>(
        `INSERT INTO deploy.image_scans (uuid, server_id, image_id, repo_digest, resource_type, resource_id, image_ref, deployment_queue_id, status, error_code, error_context, summary, findings, candidates,
           base_image_ref, builds_image, is_baseline, grype_db_built_at, scanned_at, created_at, updated_at, org_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19, '2026-01-01 00:00:00', '2026-01-01 00:00:00', $20) RETURNING id::float8 AS id`,
        [s.uuid, s.server_id, s.image_id, s.repo_digest, OWNER_MORPH[s.owner], s.resource_id, s.image_ref, s.deployment_queue_id, s.status, s.error_code, phpArrayJson(s.error_context), phpArrayJson(summary), phpArrayJson(s.findings), phpArrayJson(s.candidates), s.base_image_ref, s.builds_image, s.is_baseline, s.grype_db_built_at, s.scanned_at, org],
      );
      if (s.stored !== false) await refreshScanSummary(tx, Number(r.rows[0]!.id), NOW, decrypt(tx, org));
    });
  }
}

async function seedVariables(db: TransactionalSqlExecutor, variables: NonNullable<Dp113Case["serviceVariables"]>): Promise<void> {
  for (const [i, v] of variables.entries()) {
    await withOrg(db, ORG_UUID[T1]!, async (tx) => {
      const value = await columnCipher(tx, ORG_UUID[T1]!, TEST_KEK, "environment_variables.value").encrypt(v.value);
      await tx.execute(
        `INSERT INTO deploy.environment_variables (uuid, key, value, is_preview, resourceable_type, resourceable_id, org_id, created_at, updated_at) VALUES ($1, $2, $3, false, 'App\\Models\\Service', $4, $5, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
        [`w9parityscanvariable00${i}0`.slice(0, 24), v.key, value, v.service, ORG_UUID[T1]!],
      );
    });
  }
}

async function replay(c: Dp113Case) {
  return fixture.inCase(async (db) => {
    for (const sql of [...(c.setup ?? []), ...(c.setupFreeploy ?? [])]) await query(db, sql);
    await seedVariables(db, c.serviceVariables ?? []);
    await seedScans(db, c.imageScans ?? []);
    const t = tokenOf(c.token!);
    const req = forwarded(c);
    const path = new URL(req.url).pathname.replace(`/v1/internal/api-v1/${ORG_PUBLIC}`, "");
    const res = await handleApiV1(req, env, "req_test", { subjectId: userPublic(t.user), subjectType: "user" }, ORG_UUID[T1]!, ORG_PUBLIC, path, runners(db));
    const after: Record<string, unknown[]> = {};
    for (const [label, sql] of Object.entries(c.after ?? {})) after[label] = await query(db, sql);
    return { status: res.status, body: await res.text(), after };
  });
}

/** The middleware's answers (an ability api.ability refuses): tests/api-edge replays them. */
const MIDDLEWARE = /^\{"message":"Missing required permissions: [a-z:]+"\}$/;
const DP113_CASES = (CASES.cases as Dp113Case[]).filter((c) => c.name.startsWith("vulnerabilities: ") && !MIDDLEWARE.test(golden(c.name).body.json ?? ""));

/** The stored summary as jsonb gives it: compared parsed (key order and number text are jsonb's on both sides). */
const parsedAfter = (after: Record<string, unknown[]> | undefined) =>
  Object.fromEntries(Object.entries(after ?? {}).map(([k, rows]) => [k, (rows as Array<Record<string, unknown>>).map((r) => ({ ...r, summary: typeof r.summary === "string" ? JSON.parse(r.summary) : r.summary }))]));

describe("the goldens of DP-113's vulnerabilities", () => {
  it("cover every status, check reason and action of the engine", () => {
    expect(DP113_CASES.length).toBe(80);
    const bodies = DP113_CASES.map((c) => golden(c.name).body.json ?? "").join("\n");
    for (const status of ["not_checked", "check_needed", "update_now", "update_available", "no_fix", "ok"]) expect(bodies).toContain(`"status":"${status}"`);
    for (const reason of ["server", "application", "not_scanned", "images_unchecked", "truncated", "stale", "db_outdated", "image_changed", "versions_unchecked"]) expect(bodies).toContain(`"check_reason":"${reason}"`);
    for (const type of ["update_image", "pull_latest", "change_base", "rebuild", "upgrade_in_dockerfile", "upgrade_package", "rebuild_in_ci"]) expect(bodies).toContain(`"type":"${type}"`);
    // The time of a stale check is said against the fixture's clock.
    expect(bodies).toContain("Check again: the last check was 4 days ago.");
  });

  it("port Carbon's diffForHumans() and PHP's version_compare() as Coolify's PHP answers them", () => {
    const ago = (t: string) => diffForHumans(new Date(t), NOW);
    expect(ago("2026-01-01T00:00:00Z")).toBe("0 seconds ago");
    expect(ago("2025-12-31T23:59:59Z")).toBe("1 second ago");
    expect(ago("2025-12-31T00:00:01Z")).toBe("23 hours ago");
    expect(ago("2025-12-29T12:00:00Z")).toBe("2 days ago");
    expect(ago("2025-12-25T00:00:00Z")).toBe("1 week ago");
    expect(ago("2025-12-18T00:00:00Z")).toBe("2 weeks ago");
    expect(ago("2025-12-01T00:00:01Z")).toBe("4 weeks ago");
    expect(ago("2025-12-01T00:00:00Z")).toBe("1 month ago");
    expect(ago("2025-10-15T00:00:00Z")).toBe("2 months ago");
    expect(ago("2024-12-31T00:00:00Z")).toBe("1 year ago");
    expect(ago("2026-01-02T00:00:00Z")).toBe("1 day from now");
    expect(versionCompare("4.17.21", "4.17.20")).toBe(1);
    expect(versionCompare("1.0.0-rc1", "1.0.0")).toBe(-1);
    expect(versionCompare("1.0.0", "1.0.0pl1")).toBe(-1);
    expect(versionCompare("2.36-9+deb12u9", "2.36-9")).toBe(-1);
    expect(versionCompare("1.10", "1.9")).toBe(1);
    expect(versionCompare("1.0", "1.0.0")).toBe(-1);
    expect(versionCompare("1.0a", "1.0")).toBe(-1);
    expect(versionCompare("1.0.x", "1.0.1")).toBe(-1);
    expect(versionCompare("3.0.15-1", "3.0.15")).toBe(1);
  });
});

describe("Freeploy answers the vulnerabilities of the org and of a resource as Coolify does (DP-113)", () => {
  it.each(DP113_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const g = golden(name);
    const got = await replay(c);
    if (process.env.API_DIFF && (got.status !== g.status || maskedJson(got.body) !== maskedJson(g.body.json ?? got.body))) console.warn(`${name} ${got.status}/${g.status}\nfreeploy: ${got.body.slice(0, 3000)}\ncoolify:  ${(g.body.json ?? g.body.text ?? "").slice(0, 3000)}`);
    expect(got.status).toBe(g.status);
    if (g.body.json !== undefined) expect(maskedJson(got.body)).toBe(maskedJson(g.body.json));
    else expect(got.body).toBe(g.body.text);
    if (c.after) {
      if (process.env.API_DIFF && JSON.stringify(parsedAfter(got.after)) !== JSON.stringify(parsedAfter(g.after))) console.warn(`${name}\nfreeploy: ${JSON.stringify(got.after)}\ncoolify:  ${JSON.stringify(g.after)}`);
      expect(parsedAfter(got.after)).toEqual(parsedAfter(g.after));
    }
  });
});
