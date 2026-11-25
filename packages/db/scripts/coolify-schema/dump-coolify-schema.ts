// Writes coolify-schema.json: the physical schema of a Postgres database in
// which ALL of Coolify's migrations have run (README.md has the exact
// commands). Nothing here is derived by reading migration sources: Laravel's
// own migrator and Postgres did the work, raw statements included.
//
//   node packages/db/scripts/coolify-schema/dump-coolify-schema.ts \
//     --url postgres://coolify@127.0.0.1:54360/coolify --coolify <coolify checkout> [--check]
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { dumpSchema } from "./catalog.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "coolify-schema.json");
const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
};
const url = flag("url");
const coolify = flag("coolify");
if (!url || !coolify) {
  console.error("usage: dump-coolify-schema.ts --url <postgres url> --coolify <coolify checkout> [--check]");
  process.exit(2);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
const query = async (sql: string, params: unknown[]) => (await client.query(sql, params)).rows as Record<string, unknown>[];
const tables = await dumpSchema(query, "public");
const ran = (await query("SELECT migration FROM migrations ORDER BY migration", [])).map((r) => r["migration"] as string);
const version = (await query("SHOW server_version", []))[0]!["server_version"] as string;
await client.end();

// Every migration file of the checkout must have run: a partial run is not Coolify's schema.
const files = readdirSync(join(coolify, "database/migrations")).filter((f) => f.endsWith(".php")).map((f) => f.replace(/\.php$/, "")).sort();
const missing = files.filter((f) => !ran.includes(f));
if (missing.length || ran.length !== files.length) {
  console.error(`the database ran ${ran.length} migrations, the checkout has ${files.length}; not run: ${missing.join(", ") || "none"}`);
  process.exit(1);
}
const ref = execFileSync("git", ["-C", coolify, "rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim();

// `->default(now())` in a migration is the moment that migration ran: the one
// fact here that differs between two runs. It is recorded as what it means.
const MIGRATION_TIME = "'<the time the migration ran>'::timestamp without time zone";
for (const t of Object.values(tables)) {
  for (const c of t.columns) {
    if (c.default && /^'\d{4}-\d\d-\d\d \d\d:\d\d:\d\d'::timestamp without time zone$/.test(c.default)) c.default = MIGRATION_TIME;
  }
}

// Every raw statement of a migration's up(): what a reader of the Blueprint
// calls alone (the schema fold of DP2) does not see. All of them ran here,
// because this database is Postgres; `guard` is the driver test around them.
// Statements of down() are left out; one in a helper method is kept with the
// method's name.
interface RawStatement { migration: string; line: number; method: string; guard: string | null; statement: string }
const rawStatements: RawStatement[] = [];
for (const f of files) {
  const lines = readFileSync(join(coolify, "database/migrations", `${f}.php`), "utf8").split("\n");
  let method = "";
  let guard: string | null = null;
  lines.forEach((l, i) => {
    const fn = l.match(/function\s+(\w+)\s*\(/);
    if (fn) {
      method = fn[1]!;
      guard = null;
    }
    if (/getDriverName\(\)/.test(l)) guard = l.trim();
    if (method !== "down" && /DB::(statement|unprepared)\(/.test(l)) rawStatements.push({ migration: f, line: i + 1, method, guard, statement: l.trim() });
  });
}

const dump = {
  generatedBy: "packages/db/scripts/coolify-schema/dump-coolify-schema.ts",
  coolifyRef: ref,
  // The major version only: the facts below do not depend on the patch release.
  postgres: version.split(".")[0],
  migrationsRun: ran.length,
  rawStatements,
  tables,
};
const text = JSON.stringify(dump, null, 1) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== text) {
    console.error("coolify-schema.json is not what this database gives; re-run without --check");
    process.exit(1);
  }
  console.log(`up to date: ${Object.keys(tables).length} tables from ${ran.length} migrations at ${ref}`);
} else {
  writeFileSync(out, text);
  console.log(`wrote ${Object.keys(tables).length} tables from ${ran.length} migrations at ${ref}`);
}
