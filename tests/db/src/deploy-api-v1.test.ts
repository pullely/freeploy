// Coolify's /api/v1 reads whole rows (DP-70): apiRows() inside withOrg() against the real deploy schema.
//
// The replay of Coolify's API goldens (tests/deploy-core-worker/src/api-v1-goldens.test.ts) serves rows
// from memory; they must be exactly what Freeploy's database gives for the fixture. This suite makes the
// fixture's rows with Freeploy's own insert functions and holds them to
// tests/deploy-core-worker/fixtures/api/freeploy-rows.json (written when UPDATE_API_ROWS=1, compared
// otherwise), so the memory rows cannot drift from the schema: every column, its type and its default.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { apiRows, insertEnvironment, insertPrivateKey, insertProject, insertServer, withOrg, type ApiRow } from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { REPO_ROOT, deployDatabase, executor } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const FIXTURE = resolve(REPO_ROOT, "tests/deploy-core-worker/fixtures/api/freeploy-rows.json");

let db: PGlite;
let ex: TransactionalSqlExecutor;
beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
}, 120_000);
afterAll(async () => db?.close());

/** Timestamps the database set (now()) are not the fixture's; they are replaced by the fixture's clock. */
const CLOCK = "2026-01-01T00:00:00";
function fixClock(row: ApiRow): ApiRow {
  return row.map(([k, v]): [string, unknown] => [k, typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(v) && (k === "created_at" || k === "updated_at" || k === "sentinel_updated_at") ? CLOCK : v]);
}

describe("apiRows", () => {
  it("gives every column with PostgreSQL's types, without org_id, for the API fixture", async () => {
    const out = await withOrg(ex, A, async (tx) => {
      const alpha = await insertProject(tx, { orgId: A, uuid: "p1alphaprojectuuid000001", name: "Alpha", description: "The first project", productionEnvironmentUuid: "e1alphaproduction0000001" });
      await insertEnvironment(tx, { orgId: A, projectId: alpha.project.id, uuid: "e2alphastaging0000000002", name: "staging" });
      const key = await insertPrivateKey(tx, { orgId: A, uuid: "k1parityprivatekey000001", name: "Parity Key", description: "The fixture's key", privateKey: "fp1:ciphertext", fingerprint: "B1VgaTDKNk9wmidbNlJLi0EDtrs91BCCIjb1KI6bFd4" });
      await insertServer(tx, {
        orgId: A,
        uuid: "s1parityserveruuid000001",
        name: "parity-server",
        description: "The fixture server",
        ip: "203.0.113.10",
        user: "root",
        port: 22,
        privateKeyId: key.id,
        // Coolify's created hook: redirect_enabled (the API fixture's server was made with forceCreate()).
        proxy: { redirect_enabled: true },
        serverRole: "both",
        imageScanEnabled: false,
        defaultDestinationUuid: "d1paritydestination00001",
      });
      return {
        projects: (await apiRows(tx, "projects")).map(fixClock),
        environments: (await apiRows(tx, "environments")).map(fixClock),
        private_keys: (await apiRows(tx, "private_keys")).map(fixClock),
        servers: (await apiRows(tx, "servers")).map(fixClock),
        server_settings: (await apiRows(tx, "server_settings")).map(fixClock),
      };
    });
    for (const rows of Object.values(out)) for (const row of rows) expect(row.map(([k]) => k)).not.toContain("org_id");
    expect(out.projects[0]!.map(([k]) => k)).toEqual(["id", "uuid", "name", "description", "created_at", "updated_at", "icon_path", "icon_storage_type", "icon_s3_storage_id", "canvas_position"]);
    // Booleans are booleans and JSON is JSON (not 0/1 or text).
    const settings = Object.fromEntries(out.server_settings[0]!);
    expect(settings.is_reachable).toBe(false);
    expect(Object.fromEntries(out.servers[0]!).proxy).toEqual({ redirect_enabled: true });
    const json = `${JSON.stringify(out, null, 1)}\n`;
    if (process.env.UPDATE_API_ROWS === "1" || !existsSync(FIXTURE)) writeFileSync(FIXTURE, json);
    expect(readFileSync(FIXTURE, "utf8")).toBe(json);
  });

  it("sees only the org's rows (row-level security)", async () => {
    const rows = await withOrg(ex, B, (tx) => apiRows(tx, "projects"));
    expect(rows).toEqual([]);
  });

  it("refuses a table it does not read", async () => {
    await expect(withOrg(ex, A, (tx) => apiRows(tx, "users" as never))).rejects.toThrow("apiRows: users");
  });
});
