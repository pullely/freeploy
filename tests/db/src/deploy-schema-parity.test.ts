// DP-60: the `deploy` schema is Coolify's real schema, and stays so.
//
// Coolify's side is the committed dump of a PostgreSQL in which all of its
// migrations ran (packages/db/scripts/coolify-schema/coolify-schema.json).
// A column, index, unique index or CHECK value Coolify has and `deploy` does
// not fails here — not in a later task that needed it — unless the
// difference is one of the design's rules or is listed, with its reason, in
// LEFT (deploy-schema-parity.ts).
//
// `UPDATE_SCHEMA_DIFF=1 pnpm --filter ./tests/db test -- deploy-schema-parity`
// rewrites specs/epics/freeploy-coolify-parity/parity/schema-diff.md.
import { readFileSync, writeFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { dumpSchema } from "../../../packages/db/scripts/coolify-schema/catalog.js";
import type { SchemaDump } from "../../../packages/db/scripts/coolify-schema/catalog.js";
import {
  CATCH_UP,
  LEFT,
  REPORT_PATH,
  TABLES_NOT_PORTED,
  UNIQUE_SAFETY,
  compare,
  deployMigrationIds,
  deploySchemaAfter,
  loadCoolifySchema,
  migrationSql,
  renderReport,
  unexplained,
} from "./deploy-schema-parity.js";
import type { Comparison } from "./deploy-schema-parity.js";

const coolify = loadCoolifySchema();
const all = deployMigrationIds();
const earlier = all.slice(0, all.indexOf(CATCH_UP));
const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";

let db: PGlite;
let schema: SchemaDump;
let before: Comparison;
let after: Comparison;

const dump = (): Promise<SchemaDump> => dumpSchema(async (sql, params) => (await db.query<Record<string, unknown>>(sql, params)).rows, "deploy");

/** Runs statements as deploy_app for one org, as deploy-core-worker's transactions do, and rolls back. */
async function asOrg(org: string, statements: string[]): Promise<void> {
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE deploy_app");
    await db.query("SELECT set_config('deploy.org_id', $1, true)", [org]);
    for (const s of statements) await db.exec(s);
  } finally {
    await db.exec("ROLLBACK");
  }
}

beforeAll(async () => {
  db = new PGlite();
  for (const id of all) await db.exec(migrationSql(id));
  schema = await dump();
  before = compare(coolify.tables, await deploySchemaAfter(earlier));
  after = compare(coolify.tables, schema);
}, 180_000);

afterAll(async () => db?.close());

describe("Coolify's schema dump", () => {
  it("is the pinned commit with every migration run on PostgreSQL", () => {
    expect(coolify.coolifyRef).toBe("91b7e3e");
    expect(coolify.migrationsRun).toBe(531);
    expect(Object.keys(coolify.tables)).toHaveLength(90);
  });

  it("names only real tables as not ported", () => {
    for (const table of Object.keys(TABLES_NOT_PORTED)) expect(Object.keys(coolify.tables)).toContain(table);
  });
});

describe(`${CATCH_UP}`, () => {
  it("is the last deploy migration that changes the catalog (740, DP-116, adds a row-level security policy only) and follows 630", () => {
    expect(all.slice(all.indexOf(CATCH_UP) + 1)).toEqual(["740_deploy_image_scan_instance_policy"]);
    expect(earlier[earlier.length - 1]).toBe("630_deploy_database_public_port_timeout");
  });

  it("applies a second time and changes nothing", async () => {
    await db.exec(migrationSql(CATCH_UP));
    expect(await dump()).toEqual(schema);
  });

  it("applies to a schema that holds rows", async () => {
    const live = new PGlite();
    try {
      for (const id of earlier) await live.exec(migrationSql(id));
      // What stage and prod hold today: rows of the tables the deployed code writes.
      await live.exec(`
        INSERT INTO deploy.private_keys (uuid, name, private_key, org_id) VALUES ('key1', 'key', 'fp1:x', '${ORG_A}');
        INSERT INTO deploy.servers (uuid, name, ip, private_key_id, proxy, org_id) VALUES ('srv1', 'server', '203.0.113.10', 1, '{}', '${ORG_A}');
        INSERT INTO deploy.server_settings (server_id, org_id) VALUES (1, '${ORG_A}');
      `);
      await live.exec(migrationSql(CATCH_UP));
      const r = await live.query<{ digitalocean_droplet_id: string | null; proxy: unknown }>("SELECT digitalocean_droplet_id, proxy FROM deploy.servers");
      expect(r.rows).toEqual([{ digitalocean_droplet_id: null, proxy: {} }]);
    } finally {
      await live.close();
    }
  });

  it("closes differences and opens none", () => {
    expect(before.differences.length).toBeGreaterThan(after.differences.length);
    const known = new Set(before.differences.map((d) => d.id));
    expect(after.differences.filter((d) => !known.has(d.id))).toEqual([]);
  });
});

describe("deploy against Coolify's schema", () => {
  it("compares every Coolify table that is ported", () => {
    expect(after.compared).toHaveLength(Object.keys(coolify.tables).length - Object.keys(TABLES_NOT_PORTED).length - after.differences.filter((d) => d.kind === "table").length);
    expect(after.compared.length).toBeGreaterThanOrEqual(75);
  });

  // One test per table, so that a failure names it. A Coolify column must be
  // in `deploy` under its name with the same type (length included),
  // nullability, default and auto-increment; team_id is org_id.
  it.each(Object.keys(coolify.tables).filter((t) => !(t in TABLES_NOT_PORTED) && !(`table ${t}` in LEFT)))("%s has every Coolify column, with its type", (table) => {
    const columns = after.differences.filter((d) => d.table === table && (d.kind === "table" || d.kind === "column") && !(d.id in LEFT));
    expect(columns.map((d) => `${d.id}: Coolify ${d.coolify}; deploy ${d.freeploy}`)).toEqual([]);
  });

  it("has no difference that is neither a rule of the design nor listed in LEFT", () => {
    expect(unexplained(after).map((d) => `${d.id}: Coolify ${d.coolify}; deploy ${d.freeploy}`)).toEqual([]);
  });

  it("lists in LEFT only differences that exist", () => {
    const ids = new Set(after.differences.map((d) => d.id));
    for (const id of Object.keys(LEFT)) expect(ids).toContain(id);
  });

  it("has every unique index of Coolify, each with its scope argued", () => {
    for (const u of after.uniques) {
      expect([u.table, u.coolify, u.present]).toEqual([u.table, u.coolify, true]);
      expect([u.table, u.coolify, u.scope !== ""]).toEqual([u.table, u.coolify, true]);
    }
  });

  it("argues, for every unique index the catch-up adds, why existing rows cannot violate it", () => {
    const added = after.uniques.filter((u) => !before.uniques.find((b) => b.table === u.table && b.coolify.join() === u.coolify.join())?.present);
    expect(added.length).toBeGreaterThan(0);
    const keys = added.map((u) => `${u.table} (${u.freeploy.join(", ")})`);
    expect(Object.keys(UNIQUE_SAFETY).sort()).toEqual([...keys].sort());
  });

  it("indexes the columns of every foreign key Coolify declares", () => {
    expect(after.foreignKeys.filter((k) => !k.indexed)).toEqual([]);
  });
});

describe("the unique indexes of the catch-up, as an org meets them", () => {
  it("refuses a second environment of a name in a project, and lets another project have it", async () => {
    const env = (uuid: string, project: number) => `INSERT INTO deploy.environments (uuid, name, project_id, org_id) VALUES ('${uuid}', 'production', ${project}, '${ORG_A}')`;
    await expect(asOrg(ORG_A, [env("e1", 1), env("e2", 1)])).rejects.toThrow(/environments_name_project_id_unique/);
    await expect(asOrg(ORG_A, [env("e1", 1), env("e2", 2)])).resolves.toBeUndefined();
  });

  it("binds a shared variable's key in its project, environment or server, and not across the org", async () => {
    const shared = (column: string | null, id: number | null, type: string) =>
      `INSERT INTO deploy.shared_environment_variables (key, value, type, ${column ? `${column}, ` : ""}org_id) VALUES ('TOKEN', 'fp1:x', '${type}', ${column ? `${id}, ` : ""}'${ORG_A}')`;
    for (const [column, type] of [["project_id", "project"], ["environment_id", "environment"], ["server_id", "server"]] as const) {
      await expect(asOrg(ORG_A, [shared(column, 1, type), shared(column, 1, type)])).rejects.toThrow(new RegExp(`shared_environment_variables_key_${column}_org_id_unique`));
      await expect(asOrg(ORG_A, [shared(column, 1, type), shared(column, 2, type)])).resolves.toBeUndefined();
    }
    // The team scope has no index in Coolify either: its three columns are NULL.
    await expect(asOrg(ORG_A, [shared(null, null, "team"), shared(null, null, "team")])).resolves.toBeUndefined();
  });

  it("scopes a name-only index by org: two orgs may use one preview hostname, one org may not use it twice", async () => {
    const preview = (uuid: string, org: string) =>
      `INSERT INTO deploy.application_previews (uuid, pull_request_id, pull_request_html_url, fqdn, application_id, org_id) VALUES ('${uuid}', 1, 'https://example.com/pr/1', 'https://pr-1.example.com', 1, '${org}')`;
    await expect(asOrg(ORG_A, [preview("p1", ORG_A), preview("p2", ORG_A)])).rejects.toThrow(/application_previews_org_id_fqdn_unique/);
    await db.exec(preview("p1", ORG_A));
    try {
      await expect(asOrg(ORG_B, [preview("p2", ORG_B)])).resolves.toBeUndefined();
    } finally {
      await db.exec("DELETE FROM deploy.application_previews");
    }
  });

  it("keeps one notification-settings row per org", async () => {
    const settings = `INSERT INTO deploy.discord_notification_settings (org_id) VALUES ('${ORG_A}')`;
    await expect(asOrg(ORG_A, [settings, settings])).rejects.toThrow(/discord_notification_settings_org_id_unique/);
  });

  it("accepts a skipped scheduled-task execution, and no status Coolify does not have", async () => {
    const execution = (uuid: string, status: string) => `INSERT INTO deploy.scheduled_task_executions (uuid, status, scheduled_task_id, org_id) VALUES ('${uuid}', '${status}', 1, '${ORG_A}')`;
    await expect(asOrg(ORG_A, [execution("x1", "skipped")])).resolves.toBeUndefined();
    await expect(asOrg(ORG_A, [execution("x2", "paused")])).rejects.toThrow(/scheduled_task_executions_status_check/);
  });
});

describe("schema-diff.md", () => {
  it("is what the comparison renders", () => {
    const report = renderReport({ coolify, migrationsBefore: earlier, migrationsAfter: all, before, after });
    if (process.env["UPDATE_SCHEMA_DIFF"] === "1") writeFileSync(REPORT_PATH, report);
    expect(readFileSync(REPORT_PATH, "utf8")).toBe(report);
  });
});
