// DP2: tenancy is the security boundary. For EVERY table in the deploy
// schema, against a real Postgres (PGlite), acting as deploy_app — the role
// deploy-core-worker's transactions run as:
//   1. org A can write a row and read it back;
//   2. org B sees none of org A's rows, and cannot update or delete them;
//   3. org B cannot write a row that claims org A;
//   4. with no org set, nothing is visible and nothing can be written;
//   5. the platform-admin flag (DP12 operator) sees every org.
import { resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { deployDatabase, deployMigrationIds, migrationSql, REPO_ROOT } from "./deploy-schema.js";

const SQL500 = migrationSql("500_deploy_core");
const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";

interface Col { column_name: string; data_type: string; is_nullable: string; column_default: string | null; is_identity: string; character_maximum_length: number | null }

function sample(c: Col, table: string, n: number): string {
  if (c.column_name === "org_id") return "$ORG";
  const t = c.data_type;
  if (t === "boolean") return "false";
  if (/int|numeric|double|real/.test(t)) return String(n);
  if (t === "json" || t === "jsonb") return "'{}'";
  if (t.startsWith("timestamp") || t === "date") return "now()";
  if (t === "uuid") return `'00000000-0000-4000-8000-${String(n).padStart(12, "0")}'`;
  if (t === "inet") return "'127.0.0.1'";
  if (t === "bytea") return "'\\x00'";
  if (t === "time without time zone") return "'00:00'";
  const v = `${n}-${table}-${c.column_name}`.slice(0, c.character_maximum_length ?? 250);
  return `'${v}'`;
}

let db: PGlite;
let tables: string[] = [];
const cols = new Map<string, Col[]>();
/** table → column → an allowed value of its CHECK (Coolify enum columns). */
const allowed = new Map<string, Map<string, string>>();

async function asOrg<T>(org: string | null, fn: () => Promise<T>, admin = false): Promise<T> {
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE deploy_app");
    if (org) await db.query("SELECT set_config('deploy.org_id', $1, true)", [org]);
    if (admin) await db.exec("SELECT set_config('deploy.platform_admin', 'on', true)");
    const r = await fn();
    await db.exec("COMMIT");
    return r;
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
}

function insertSql(table: string, org: string, n: number): string {
  const c = cols.get(table)!.filter((x) => x.is_identity !== "YES" && !(x.is_nullable === "YES" && x.column_name !== "org_id") && x.column_default === null);
  const names = c.map((x) => `"${x.column_name}"`);
  const values = c.map((x) => allowed.get(table)?.get(x.column_name) ?? sample(x, table, n).replace("$ORG", `'${org}'`));
  return `INSERT INTO deploy.${table} (${names.join(", ")}) VALUES (${values.join(", ")})`;
}

beforeAll(async () => {
  // Every deploy migration of the manifest: isolation is proven on the schema stage and prod run.
  db = await deployDatabase();
  const t = await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'deploy' ORDER BY 1");
  tables = t.rows.map((r) => r.table_name);
  for (const name of tables) {
    const c = await db.query<Col>(
      "SELECT column_name, data_type, is_nullable, column_default, is_identity, character_maximum_length FROM information_schema.columns WHERE table_schema = 'deploy' AND table_name = $1 ORDER BY ordinal_position",
      [name],
    );
    cols.set(name, c.rows);
  }
  // Enum CHECKs: use an allowed value instead of a free string.
  const checks = await db.query<{ table_name: string; def: string }>(
    "SELECT rel.relname AS table_name, pg_get_constraintdef(con.oid) AS def FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = rel.relnamespace WHERE ns.nspname = 'deploy' AND con.contype = 'c'",
  );
  for (const ch of checks.rows) {
    const m = ch.def.match(/\(\(?(\w+)\)?::text = ANY \(ARRAY\['([^']*)'/) ?? ch.def.match(/\((\w+)\)::text = '([^']*)'/);
    if (!m) continue;
    if (!allowed.has(ch.table_name)) allowed.set(ch.table_name, new Map());
    allowed.get(ch.table_name)!.set(m[1]!, `'${m[2]}'`);
  }
}, 120_000);

afterAll(async () => db?.close());

describe("deploy schema", () => {
  it("creates the ported tables, each with org_id", () => {
    expect(tables.length).toBeGreaterThanOrEqual(70);
    for (const t of tables) expect(cols.get(t)!.map((c) => c.column_name)).toContain("org_id");
  });

  it("forces row-level security on every table", async () => {
    const r = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'deploy' AND c.relkind = 'r'",
    );
    expect(r.rows.length).toBe(tables.length);
    for (const row of r.rows) {
      expect([row.relname, row.relrowsecurity, row.relforcerowsecurity]).toEqual([row.relname, true, true]);
    }
  });

  it("deploy_app cannot bypass row-level security", async () => {
    const r = await db.query<{ rolbypassrls: boolean; rolsuper: boolean }>("SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'deploy_app'");
    expect(r.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });
});

describe("cross-org isolation, table by table", () => {
  // One test per table so a failure names the table.
  const names = (() => {
    const sql = deployMigrationIds().map(migrationSql).join("\n");
    return [...new Set([...sql.matchAll(/CREATE TABLE IF NOT EXISTS deploy\.(\w+)/g)].map((m) => m[1]!))];
  })();

  it.each(names)("%s", async (table) => {
    const sql = insertSql(table, ORG_A, 1);
    // 1. org A writes and reads its own row
    await asOrg(ORG_A, () => db.exec(sql));
    const own = await asOrg(ORG_A, () => db.query(`SELECT count(*)::int AS n FROM deploy.${table}`));
    expect((own.rows[0] as { n: number }).n).toBe(1);
    // 2. org B sees nothing and cannot change it
    const other = await asOrg(ORG_B, () => db.query(`SELECT count(*)::int AS n FROM deploy.${table}`));
    expect((other.rows[0] as { n: number }).n).toBe(0);
    const upd = await asOrg(ORG_B, () => db.query(`UPDATE deploy.${table} SET org_id = '${ORG_B}'`));
    expect(upd.affectedRows ?? 0).toBe(0);
    // Tables whose rows are never deleted (deploy.org_keys: keys are retired) grant
    // deploy_app no DELETE at all; "not permitted" is as safe as "0 rows".
    const del = await asOrg(ORG_B, () => db.query(`DELETE FROM deploy.${table}`)).catch((e: Error) => {
      if (/permission denied/.test(e.message)) return { affectedRows: 0 };
      throw e;
    });
    expect(del.affectedRows ?? 0).toBe(0);
    // 3. org B cannot write a row that claims org A
    await expect(asOrg(ORG_B, () => db.exec(insertSql(table, ORG_A, 2)))).rejects.toThrow(/row-level security/);
    // 4. no org: nothing visible, nothing writable
    const none = await asOrg(null, () => db.query(`SELECT count(*)::int AS n FROM deploy.${table}`));
    expect((none.rows[0] as { n: number }).n).toBe(0);
    await expect(asOrg(null, () => db.exec(insertSql(table, ORG_A, 3)))).rejects.toThrow(/row-level security/);
    // 5. the operator sees every org
    const admin = await asOrg(null, () => db.query(`SELECT count(*)::int AS n FROM deploy.${table}`), true);
    expect((admin.rows[0] as { n: number }).n).toBe(1);
  });
});

describe("deploy migration registration", () => {
  it("is registered in the manifest with the on-disk checksum, under the deploy context", async () => {
    const { manifest, BOUNDED_CONTEXTS } = await import("@saas/db");
    const { createHash } = await import("node:crypto");
    expect(BOUNDED_CONTEXTS).toContain("deploy");
    const entry = manifest.migrations.find((m) => m.id === "500_deploy_core")!;
    expect(entry.context).toBe("deploy");
    expect(entry.checksum).toBe(createHash("sha256").update(SQL500).digest("hex"));
  });

  it("the committed SQL is exactly what the generator produces", async () => {
    const { execFileSync } = await import("node:child_process");
    expect(() => execFileSync("node", [resolve(REPO_ROOT, "packages/db/scripts/generate-deploy-schema.ts"), "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
