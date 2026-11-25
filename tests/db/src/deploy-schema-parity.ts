// DP-60: Freeploy's `deploy` schema against Coolify's real one, fact by fact.
//
// Coolify's side is packages/db/scripts/coolify-schema/coolify-schema.json: the
// catalogs of a Postgres in which all of Coolify's migrations ran. Freeploy's
// side is the same catalog queries on a PGlite that ran packages/db's deploy
// migrations. compare() explains every difference by a rule of the design
// (team_id → org_id, org_id everywhere, no foreign-key constraints, …) or
// reports it; deploy-schema-parity.test.ts fails on a reported difference that
// is not listed in LEFT, and holds
// specs/epics/freeploy-coolify-parity/parity/schema-diff.md to renderReport().
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { manifest } from "@saas/db";
import { dumpSchema } from "../../../packages/db/scripts/coolify-schema/catalog.js";
import type { SchemaColumn, SchemaDump, SchemaIndex } from "../../../packages/db/scripts/coolify-schema/catalog.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const COOLIFY_SCHEMA_PATH = resolve(root, "packages/db/scripts/coolify-schema/coolify-schema.json");
export const REPORT_PATH = resolve(root, "specs/epics/freeploy-coolify-parity/parity/schema-diff.md");
/** The catch-up migration of DP-60: the report shows the schema before and after it. */
export const CATCH_UP = "660_deploy_schema_catch_up";

export interface RawStatement { migration: string; line: number; method: string; guard: string | null; statement: string }
export interface CoolifySchemaFile { coolifyRef: string; postgres: string; migrationsRun: number; rawStatements: RawStatement[]; tables: SchemaDump }

export function loadCoolifySchema(): CoolifySchemaFile {
  return JSON.parse(readFileSync(COOLIFY_SCHEMA_PATH, "utf8")) as CoolifySchemaFile;
}

/** The deploy migrations of the manifest, in order. */
export function deployMigrationIds(): string[] {
  return manifest.migrations.filter((m) => m.context === "deploy").map((m) => m.id);
}

export function migrationSql(id: string): string {
  const entry = manifest.migrations.find((m) => m.id === id);
  if (!entry) throw new Error(`no migration ${id} in the manifest`);
  return readFileSync(resolve(root, "packages/db/src/migrations", entry.path), "utf8");
}

/** The `deploy` schema of a fresh database after these migrations. */
export async function deploySchemaAfter(ids: readonly string[]): Promise<SchemaDump> {
  const db = new PGlite();
  try {
    for (const id of ids) await db.exec(migrationSql(id));
    return await dumpSchema(async (sql, params) => (await db.query<Record<string, unknown>>(sql, params)).rows, "deploy");
  } finally {
    await db.close();
  }
}

// ── What is not compared ─────────────────────────────────────────────────────

const LUMEN = "Lumen owns it (risks DP-J): identity, membership, billing and events hold these facts";
/** Coolify tables with no `deploy` counterpart, each with its reason. */
export const TABLES_NOT_PORTED: Readonly<Record<string, string>> = {
  users: LUMEN,
  teams: LUMEN,
  team_user: LUMEN,
  team_invitations: LUMEN,
  sessions: LUMEN,
  password_reset_tokens: LUMEN,
  personal_access_tokens: LUMEN,
  subscriptions: LUMEN,
  audit_events: LUMEN,
  passkeys: LUMEN,
  oauth_identities: LUMEN,
  failed_jobs: "Laravel's queue bookkeeping; Freeploy runs on Cloudflare Queues and Workflows (LUMEN_OWNED in generate-deploy-schema.ts)",
  user_changelog_reads: "per-user state of Coolify's changelog; a table on users, which Lumen owns (LUMEN_OWNED in generate-deploy-schema.ts)",
  migrations: "Laravel's migration bookkeeping; Freeploy's is control.schema_migrations",
};

/** `deploy` tables Coolify does not have. */
export const FREEPLOY_ONLY_TABLES: Readonly<Record<string, string>> = {
  org_keys: "the per-org data key that wraps the encrypted columns (510_deploy_org_keys); Coolify encrypts with one APP_KEY",
};

// ── Unique indexes: how each of Coolify's is scoped in a multi-tenant schema ──

const key = (table: string, columns: readonly string[]): string => `${table} (${columns.join(", ")})`;

/**
 * Coolify unique indexes that are global on a single-team-per-row instance
 * and would let one org block, or learn of, another org's value. Freeploy's
 * index has org_id in front.
 */
export const ORG_SCOPED_UNIQUES: Readonly<Record<string, string>> = {
  [key("application_previews", ["fqdn"])]:
    "a hostname is not a reference to an org's row: global, one org could take or probe another's preview hostname",
  [key("image_scan_policies", ["scope_type", "scope_id"])]:
    "the instance-wide policy has no scope (NULL, NULL) and a team policy would point at a team, which is the org itself here",
  [key("notification_throttles", ["notifiable_type", "notifiable_id", "notification"])]:
    "the notifiable is the team for most notifications, and the team is the org here, not a row with a bigint id",
  [key("scheduled_job_deliveries", ["schedule_key", "scheduled_for"])]:
    "a schedule key is a name, not a reference to an org's row",
};

/**
 * Why each remaining Coolify unique index needs no org_id: what it is made
 * of already belongs to one org. Keyed by Coolify's columns.
 */
export const UNIQUE_SCOPE: Readonly<Record<string, string>> = {
  [key("additional_destinations", ["application_id", "server_id", "standalone_docker_id"])]: "application_id is an org's application",
  [key("application_deployment_queues", ["deployment_uuid"])]: "a generated id, global as every `uuid` is (DP2)",
  [key("dns_provider_zones", ["integration_token_id", "provider_zone_id"])]: "integration_token_id is an org's token",
  [key("environments", ["name", "project_id"])]: "project_id is an org's project",
  [key("github_runner_configs", ["server_id"])]: "server_id is an org's server (DP2)",
  [key("github_runner_executions", ["github_app_id", "trigger_workflow_job_id"])]: "github_app_id is an org's GitHub App",
  [key("image_sboms", ["server_id", "image_id"])]: "server_id is an org's server",
  [key("image_scan_notification_states", ["resource_type", "resource_id"])]: "the resource is an org's application, service or database",
  [key("image_scans", ["resource_type", "resource_id", "image_id"])]: "the resource is an org's application, service or database",
  [key("local_file_volumes", ["mount_path", "resource_id", "resource_type"])]: "the resource is an org's application, service or database",
  [key("local_persistent_volumes", ["name", "resource_id", "resource_type"])]: "the resource is an org's application, service or database",
  [key("managed_dns_record_references", ["managed_dns_record_id", "resource_type", "resource_id"])]: "managed_dns_record_id is an org's record",
  [key("managed_dns_records", ["dns_provider_zone_id", "provider_record_id"])]: "dns_provider_zone_id is an org's zone",
  [key("oauth_settings", ["provider"])]:
    "as designed in DP2: Coolify's sign-in providers are instance-wide and Lumen's identity owns sign-in; to be revisited if an org ever configures its own",
  [key("resource_links", ["environment_id", "source_type", "source_id", "target_type", "target_id"])]: "environment_id is an org's environment",
  [key("scheduled_database_backup_s3_storage", ["scheduled_database_backup_id", "s3_storage_id"])]: "scheduled_database_backup_id is an org's backup",
  [key("scheduled_job_states", ["schedule_key"])]:
    "as designed in DP2: one row per instance-wide schedule of the scheduler; to be revisited with scheduled_job_deliveries when the scheduler is ported",
  [key("scheduled_volume_backup_s3_storage", ["scheduled_volume_backup_id", "s3_storage_id"])]: "scheduled_volume_backup_id is an org's backup",
  [key("scheduled_volume_backups", ["backupable_type", "backupable_id"])]: "the backupable is an org's volume",
  [key("secret_manager_links", ["resourceable_type", "resourceable_id"])]: "the resourceable is an org's application, service or database",
  [key("server_host_scans", ["server_id"])]: "server_id is an org's server (DP2)",
  [key("standalone_dockers", ["server_id", "network"])]: "server_id is an org's server",
  [key("stars", ["user_id", "starrable_type", "starrable_id"])]: "the starrable is an org's project, environment or resource",
  [key("swarm_dockers", ["server_id", "network"])]: "server_id is an org's server",
  [key("taggables", ["tag_id", "taggable_id", "taggable_type"])]: "tag_id is an org's tag",
};

const EMPTY = (feature: string): string => `no row can exist: nothing in Freeploy writes this table yet (${feature})`;
/**
 * Why creating each unique index of 660 cannot fail on the rows stage and
 * prod hold. Keyed by Freeploy's columns.
 */
export const UNIQUE_SAFETY: Readonly<Record<string, string>> = {
  [key("additional_destinations", ["application_id", "server_id", "standalone_docker_id"])]:
    "attachAdditionalDestination() (DP-58) keeps one row per (application, network): it updates that row when there is one and inserts otherwise. Promoting inserts the former main destination, which repeats a row only if that same network had been attached as an additional one before — the page does not offer it",
  [key("application_previews", ["org_id", "fqdn"])]: EMPTY("preview deployments, DP6"),
  [key("discord_notification_settings", ["org_id"])]: EMPTY("notification channels, DP9"),
  [key("dns_provider_zones", ["integration_token_id", "provider_zone_id"])]: EMPTY("managed DNS"),
  [key("email_notification_settings", ["org_id"])]: EMPTY("notification channels, DP9"),
  [key("environments", ["name", "project_id"])]:
    "a project is created with one environment, and creating or renaming an environment asks environmentNameExists() first and answers 409 (DP-46)",
  [key("github_runner_executions", ["github_app_id", "trigger_workflow_job_id"])]: EMPTY("GitHub runners"),
  [key("image_sboms", ["server_id", "image_id"])]: EMPTY("image scanning"),
  [key("image_scan_notification_states", ["resource_type", "resource_id"])]: EMPTY("image scanning"),
  [key("image_scan_policies", ["org_id", "scope_type", "scope_id"])]: EMPTY("image scanning"),
  [key("image_scans", ["resource_type", "resource_id", "image_id"])]: EMPTY("image scanning"),
  [key("local_file_volumes", ["mount_path", "resource_id", "resource_type"])]:
    "every file and directory mount is added through assertMountPathFree() (DP-55), which answers 422 for a path the resource already mounts; a clone copies them to a new resource",
  [key("local_persistent_volumes", ["name", "resource_id", "resource_type"])]:
    "a volume is added or renamed through assertVolumeNameFree(), a clone refuses two volumes that would get one name (both DP-55), and a new database gets the volumes of its created hook once (DP-57)",
  [key("managed_dns_record_references", ["managed_dns_record_id", "resource_type", "resource_id"])]: EMPTY("managed DNS"),
  [key("managed_dns_records", ["dns_provider_zone_id", "provider_record_id"])]: EMPTY("managed DNS"),
  [key("notification_throttles", ["org_id", "notifiable_type", "notifiable_id", "notification"])]: EMPTY("notifications, DP9"),
  [key("pushover_notification_settings", ["org_id"])]: EMPTY("notification channels, DP9"),
  [key("resource_links", ["environment_id", "source_type", "source_id", "target_type", "target_id"])]: EMPTY("resource links"),
  [key("scheduled_database_backup_s3_storage", ["scheduled_database_backup_id", "s3_storage_id"])]: EMPTY("database backups, DP7"),
  [key("scheduled_job_deliveries", ["org_id", "schedule_key", "scheduled_for"])]: EMPTY("the scheduler"),
  [key("scheduled_volume_backup_s3_storage", ["scheduled_volume_backup_id", "s3_storage_id"])]: EMPTY("volume backups"),
  [key("scheduled_volume_backups", ["backupable_type", "backupable_id"])]: EMPTY("volume backups"),
  [key("secret_manager_links", ["resourceable_type", "resourceable_id"])]: EMPTY("secret managers"),
  [key("shared_environment_variables", ["key", "environment_id", "org_id"])]:
    "creating a variable and changing its key look the key up in the scope first and answer 409 (DP-50); a variable of another scope has NULL here and NULLs never collide",
  [key("shared_environment_variables", ["key", "project_id", "org_id"])]: "as for the environment scope (DP-50)",
  [key("shared_environment_variables", ["key", "server_id", "org_id"])]: "as for the environment scope (DP-50; the server scope exists since migration 590)",
  [key("slack_notification_settings", ["org_id"])]: EMPTY("notification channels, DP9"),
  [key("standalone_dockers", ["server_id", "network"])]:
    "a new server gets at most one destination, and createDestination() asks destinationNetworkExists() first (DP-44)",
  [key("stars", ["user_id", "starrable_type", "starrable_id"])]: EMPTY("stars"),
  [key("swarm_dockers", ["server_id", "network"])]: "createDestination() asks destinationNetworkExists() first (DP-44)",
  [key("taggables", ["tag_id", "taggable_id", "taggable_type"])]:
    "a tag is attached after resourceHasTag() said it is not, and a clone copies the tags to a new resource (DP-55)",
  [key("telegram_notification_settings", ["org_id"])]: EMPTY("notification channels, DP9"),
  [key("webhook_notification_settings", ["org_id"])]: EMPTY("notification channels, DP9"),
};

// ── Differences deliberately left ────────────────────────────────────────────

/** Reported differences that stay, by Difference id, each with its reason. */
export const LEFT: Readonly<Record<string, string>> = {
  "table activity_log":
    "spatie/laravel-activitylog's table, where Coolify keeps the output of the commands it runs on a server. The schema fold never saw it (its migration names the table through config()). Where Freeploy keeps command output (this table, or the SshSession Durable Object's stream) belongs to the work that runs commands, once the SSH executor is available (WAITING W3); a table nothing writes is not added here.",
};

// ── Comparison ───────────────────────────────────────────────────────────────

export interface Difference {
  /** `${kind} ${table}[.${subject}]` — what LEFT is keyed by. */
  id: string;
  kind: "table" | "extra-table" | "column" | "extra-column" | "primary-key" | "unique" | "extra-unique" | "index" | "check" | "extra-check" | "storage";
  table: string;
  subject: string;
  coolify: string;
  freeploy: string;
}

export interface UniqueRow {
  table: string;
  coolify: string[];
  /** The columns Freeploy's index must have. */
  freeploy: string[];
  present: boolean;
  scope: string;
}

export interface Comparison {
  compared: string[];
  coolifyColumns: number;
  /** Coolify columns found in `deploy` with the same type, nullability and default. */
  matchedColumns: number;
  teamIdColumns: string[];
  orgIdAdded: string[];
  nowDefaults: string[];
  foreignKeys: { table: string; columns: string[]; references: string; onDelete: string; indexed: boolean }[];
  /** Freeploy-only non-unique indexes: they change no behaviour. */
  extraIndexes: { orgId: number; other: number };
  uuidUniques: string[];
  uniques: UniqueRow[];
  coolifyIndexes: number;
  differences: Difference[];
}

const mapColumn = (c: string): string => (c === "team_id" ? "org_id" : c);

/** A default as it behaves: numeric literals without their cast, NULL as none, now() in either spelling. */
export function normalDefault(d: string | null): string | null {
  if (d === null) return null;
  if (/^NULL::/.test(d)) return null;
  const n = d.match(/^'(-?\d+(?:\.\d+)?)'::(?:smallint|integer|bigint|numeric)$/);
  if (n) return n[1]!;
  if (d === "CURRENT_TIMESTAMP" || /^'<the time the migration ran>'::timestamp/.test(d)) return "now()";
  return d;
}

const describeColumn = (c: SchemaColumn): string =>
  `${c.type}${c.autoIncrement ? " auto-increment" : ""}${c.nullable ? "" : " NOT NULL"}${normalDefault(c.default) === null ? "" : ` DEFAULT ${normalDefault(c.default)}`}`;

const describeIndex = (i: Pick<SchemaIndex, "columns" | "predicate" | "method">): string =>
  `${i.method === "btree" ? "" : `${i.method} `}(${i.columns.join(", ")})${i.predicate ? ` WHERE ${i.predicate}` : ""}`;

const sameColumns = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((c, i) => c === b[i]);
const startsWith = (index: readonly string[], prefix: readonly string[]): boolean => prefix.length <= index.length && prefix.every((c, i) => c === index[i]);
const normalCheck = (definition: string): string => definition.replace(/\s+/g, " ");

export function compare(coolify: SchemaDump, freeploy: SchemaDump): Comparison {
  const out: Comparison = {
    compared: [], coolifyColumns: 0, matchedColumns: 0, teamIdColumns: [], orgIdAdded: [], nowDefaults: [], foreignKeys: [],
    extraIndexes: { orgId: 0, other: 0 }, uuidUniques: [], uniques: [], coolifyIndexes: 0, differences: [],
  };
  const report = (kind: Difference["kind"], table: string, subject: string, c: string, f: string): void => {
    out.differences.push({ id: `${kind} ${table}${subject ? `.${subject}` : ""}`, kind, table, subject, coolify: c, freeploy: f });
  };

  for (const table of Object.keys(coolify).sort()) {
    if (table in TABLES_NOT_PORTED) continue;
    const c = coolify[table]!;
    const f = freeploy[table];
    if (!f) {
      report("table", table, "", `${c.columns.length} columns`, "missing");
      continue;
    }
    out.compared.push(table);

    // Columns
    const mine = new Map(f.columns.map((x) => [x.name, x]));
    const theirs = new Set(c.columns.map((x) => mapColumn(x.name)));
    for (const col of c.columns) {
      out.coolifyColumns += 1;
      if (col.name === "team_id") {
        const org = mine.get("org_id");
        if (org && org.type === "uuid" && !org.nullable) {
          out.teamIdColumns.push(`${table}.team_id`);
          out.matchedColumns += 1;
        } else report("column", table, "team_id", describeColumn(col), org ? describeColumn(org) : "no org_id");
        continue;
      }
      const own = mine.get(col.name);
      if (!own) {
        report("column", table, col.name, describeColumn(col), "missing");
        continue;
      }
      if (own.type !== col.type || own.nullable !== col.nullable || own.autoIncrement !== col.autoIncrement || normalDefault(own.default) !== normalDefault(col.default)) {
        report("column", table, col.name, describeColumn(col), describeColumn(own));
        continue;
      }
      out.matchedColumns += 1;
      if (normalDefault(col.default) === "now()") out.nowDefaults.push(`${table}.${col.name}`);
    }
    for (const own of f.columns) {
      if (theirs.has(own.name)) continue;
      if (own.name === "org_id" && own.type === "uuid" && !own.nullable) out.orgIdAdded.push(table);
      else report("extra-column", table, own.name, "none", describeColumn(own));
    }

    // Primary key
    if (!sameColumns(c.primaryKey, f.primaryKey)) report("primary-key", table, "", `(${c.primaryKey.join(", ")})`, `(${f.primaryKey.join(", ")})`);

    // Indexes
    const explained = new Set<string>();
    for (const index of c.indexes) {
      out.coolifyIndexes += 1;
      const mapped = index.columns.map(mapColumn);
      if (index.unique) {
        const scoped = key(table, index.columns) in ORG_SCOPED_UNIQUES;
        const want = scoped ? ["org_id", ...mapped] : mapped;
        const found = f.indexes.find((x) => x.unique && x.method === index.method && x.predicate === index.predicate && sameColumns(x.columns, want));
        const scope = scoped
          ? `org_id added: ${ORG_SCOPED_UNIQUES[key(table, index.columns)]!}`
          : index.columns.includes("team_id")
            ? "org_id in team_id's place"
            : sameColumns(index.columns, ["uuid"])
              ? "a generated id, global as in Coolify (DP2)"
              : (UNIQUE_SCOPE[key(table, index.columns)] ?? "");
        out.uniques.push({ table, coolify: index.columns, freeploy: want, present: Boolean(found), scope });
        if (found) explained.add(found.name);
        else report("unique", table, describeIndex(index), index.name, `no unique index on ${describeIndex({ ...index, columns: want })}`);
        continue;
      }
      // A non-unique index is there when an index of the same kind starts with its columns.
      const cover = f.indexes.find((x) => x.method === index.method && x.predicate === index.predicate && startsWith(x.columns, mapped));
      if (cover) {
        if (sameColumns(cover.columns, mapped)) explained.add(cover.name);
      } else report("index", table, describeIndex(index), index.name, `no index on ${describeIndex({ ...index, columns: mapped })}`);
    }
    for (const index of f.indexes) {
      if (explained.has(index.name)) continue;
      if (!index.unique) {
        if (sameColumns(index.columns, ["org_id"])) out.extraIndexes.orgId += 1;
        else out.extraIndexes.other += 1;
      } else if (sameColumns(index.columns, ["uuid"])) out.uuidUniques.push(table);
      else report("extra-unique", table, describeIndex(index), "none", index.name);
    }

    // CHECK constraints
    const myChecks = new Set(f.checks.map((x) => normalCheck(x.definition)));
    const theirChecks = new Set(c.checks.map((x) => normalCheck(x.definition)));
    for (const check of c.checks) {
      if (!myChecks.has(normalCheck(check.definition))) report("check", table, check.name, check.definition, f.checks.find((x) => x.name === check.name)?.definition ?? "missing");
    }
    for (const check of f.checks) {
      if (!theirChecks.has(normalCheck(check.definition)) && !c.checks.some((x) => x.name === check.name)) report("extra-check", table, check.name, "none", check.definition);
    }

    // Storage options
    if (c.storage.join(", ") !== f.storage.join(", ")) report("storage", table, "", c.storage.join(", ") || "none", f.storage.join(", ") || "none");

    // Foreign keys: not created (design §1.1); the referencing columns are indexed instead.
    for (const fk of c.foreignKeys) {
      const columns = fk.columns.map(mapColumn);
      out.foreignKeys.push({
        table,
        columns: fk.columns,
        references: `${fk.references.table} (${fk.references.columns.join(", ")})`,
        onDelete: fk.onDelete,
        indexed: f.indexes.some((x) => x.method === "btree" && x.predicate === null && startsWith(x.columns, columns)),
      });
    }
  }

  for (const table of Object.keys(freeploy).sort()) {
    if (!(table in coolify) && !(table in FREEPLOY_ONLY_TABLES)) report("extra-table", table, "", "none", `${freeploy[table]!.columns.length} columns`);
  }
  return out;
}

/** The differences nobody decided to leave. */
export function unexplained(c: Comparison): Difference[] {
  return c.differences.filter((d) => !(d.id in LEFT));
}

// ── Report ───────────────────────────────────────────────────────────────────

const code = (s: string): string => `\`${s.replace(/\|/g, "\\|")}\``;
const cell = (s: string): string => s.replace(/\|/g, "\\|");

const KIND_TITLES: Readonly<Record<Difference["kind"], string>> = {
  table: "Tables missing",
  "extra-table": "Tables Coolify does not have",
  column: "Columns missing or different",
  "extra-column": "Columns Coolify does not have",
  "primary-key": "Primary keys",
  unique: "Unique indexes missing",
  "extra-unique": "Unique indexes Coolify does not have",
  index: "Indexes missing",
  check: "CHECK constraints missing or different",
  "extra-check": "CHECK constraints Coolify does not have",
  storage: "Storage options",
};

function differenceTable(list: readonly Difference[]): string[] {
  const lines = ["| Table | What | Coolify | Freeploy |", "|---|---|---|---|"];
  for (const d of list) lines.push(`| ${code(d.table)} | ${d.subject ? code(d.subject) : "—"} | ${cell(d.coolify)} | ${cell(d.freeploy)} |`);
  return lines;
}

export interface ReportInput {
  coolify: CoolifySchemaFile;
  /** The deploy migrations before the catch-up, and all of them. */
  migrationsBefore: readonly string[];
  migrationsAfter: readonly string[];
  before: Comparison;
  after: Comparison;
}

export function renderReport(r: ReportInput): string {
  const { coolify, before, after } = r;
  const closed = before.differences.filter((d) => !after.differences.some((x) => x.id === d.id));
  const left = after.differences.filter((d) => d.id in LEFT);
  const open = unexplained(after);
  const count = (list: readonly Difference[], kind: Difference["kind"]): number => list.filter((d) => d.kind === kind).length;
  const columnsAdded = closed.filter((d) => d.kind === "column" && d.freeploy === "missing");
  const columnsChanged = closed.filter((d) => d.kind === "column" && d.freeploy !== "missing");
  const notPorted = Object.keys(coolify.tables).filter((t) => t in TABLES_NOT_PORTED).sort();
  const addedUniques = after.uniques.filter((u) => u.present && !before.uniques.find((b) => b.table === u.table && sameColumns(b.coolify, u.coolify))?.present);
  const L: string[] = [];

  L.push("# Schema diff — Freeploy `deploy` ↔ Coolify");
  L.push("");
  L.push(`Generated by \`tests/db/src/deploy-schema-parity.ts\` from coollabsio/coolify@\`${coolify.coolifyRef}\` (Apache-2.0). Do not edit by hand:`);
  L.push("`UPDATE_SCHEMA_DIFF=1 pnpm --filter ./tests/db test -- deploy-schema-parity` rewrites it, and the same test fails when it is stale.");
  L.push("");
  L.push("## Method");
  L.push("");
  L.push(`- **Coolify.** All ${coolify.migrationsRun} migrations of the pinned commit were run by Laravel's own migrator on PostgreSQL ${coolify.postgres}, and the`);
  L.push("  catalogs were dumped to `packages/db/scripts/coolify-schema/coolify-schema.json` (its README has the commands). Nothing is");
  L.push("  derived from reading migration sources: raw statements, loops and `->change()` calls all took effect.");
  L.push(`- **Freeploy.** The same catalog queries on a fresh PGlite after the deploy migrations of the manifest (${r.migrationsAfter.map((m) => m.slice(0, 3)).join(", ")}).`);
  L.push("- **Compared per table:** every column (type, length, nullability, default, auto-increment), the primary key, every unique and");
  L.push("  non-unique index (columns, order, method, predicate), every CHECK constraint, the storage options and the foreign keys.");
  L.push("");
  L.push("## Result");
  L.push("");
  L.push("| | |");
  L.push("|---|---:|");
  L.push(`| Coolify tables | ${Object.keys(coolify.tables).length} |`);
  L.push(`| not ported, by design | ${notPorted.length} |`);
  L.push(`| missing in \`deploy\`, left (below) | ${count(after.differences, "table")} |`);
  L.push(`| **compared** | **${after.compared.length}** |`);
  L.push(`| Coolify columns on the compared tables | ${after.coolifyColumns} |`);
  L.push(`| … the same in \`deploy\` (\`team_id\` as \`org_id\`) | ${after.matchedColumns} |`);
  L.push(`| Coolify indexes on the compared tables (unique: ${after.uniques.length}) | ${after.coolifyIndexes} |`);
  L.push(`| differences before \`${CATCH_UP}\` | ${before.differences.length} |`);
  L.push(`| closed by it | ${closed.length} |`);
  L.push(`| differences deliberately left | ${left.length} |`);
  L.push(`| **differences unexplained** | **${open.length}** |`);
  L.push("");
  L.push(`### What \`${CATCH_UP}\` closed`);
  L.push("");
  L.push("| | |");
  L.push("|---|---:|");
  L.push(`| columns added | ${columnsAdded.length} |`);
  L.push(`| columns changed (type, nullability or default) | ${columnsChanged.length} |`);
  L.push(`| columns dropped that Coolify dropped | ${count(closed, "extra-column")} |`);
  L.push(`| unique indexes added | ${count(closed, "unique")} |`);
  L.push(`| indexes added | ${count(closed, "index")} |`);
  L.push(`| CHECK constraints widened | ${count(closed, "check")} |`);
  L.push(`| tables given Coolify's storage options | ${count(closed, "storage")} |`);
  L.push("");

  L.push("## Differences left");
  L.push("");
  if (!left.length) L.push("None.");
  for (const d of left) {
    L.push(`- **${code(d.id)}** (Coolify: ${d.coolify}; Freeploy: ${d.freeploy}). ${LEFT[d.id]!}`);
  }
  L.push("");
  L.push("## Differences unexplained");
  L.push("");
  if (!open.length) L.push("None. A new one fails `tests/db/src/deploy-schema-parity.test.ts`.");
  else L.push(...differenceTable(open));
  L.push("");

  L.push("## Differences by design, excluded mechanically");
  L.push("");
  L.push(`1. **Tables not ported (${notPorted.length}).**`);
  for (const t of notPorted) L.push(`   - ${code(t)} — ${TABLES_NOT_PORTED[t]!}.`);
  L.push(`2. **Tables Coolify does not have (${Object.keys(FREEPLOY_ONLY_TABLES).length}).** ${Object.entries(FREEPLOY_ONLY_TABLES).map(([t, why]) => `${code(t)} — ${why}`).join("; ")}.`);
  L.push(`3. **\`team_id\` → \`org_id\` (${after.teamIdColumns.length} columns).** Coolify's \`bigint\` team reference is the Lumen organization, \`uuid NOT NULL\`; an index or`);
  L.push("   unique index on `team_id` is compared as one on `org_id`.");
  L.push(`4. **\`org_id\` added (${after.orgIdAdded.length} tables)** where Coolify scopes a row only through its parent (risks DP-I), with an index on it`);
  L.push(`   (${after.extraIndexes.orgId} indexes Coolify has no counterpart for) and forced row-level security on every table.`);
  L.push(`5. **No foreign-key constraints (${after.foreignKeys.length} in Coolify).** The references are plain columns (generate-deploy-schema.ts: some point at tables`);
  L.push(`   Lumen owns; integrity is kept by the ported write paths, which also do what \`ON DELETE CASCADE\` did). ${after.foreignKeys.filter((k) => k.indexed).length} of the ${after.foreignKeys.length}`);
  L.push("   referencing column lists are the leading columns of an index in `deploy`." + (after.foreignKeys.some((k) => !k.indexed) ? ` Not indexed: ${after.foreignKeys.filter((k) => !k.indexed).map((k) => code(`${k.table} (${k.columns.join(", ")})`)).join(", ")}.` : ""));
  L.push(`6. **Indexes Coolify does not have (${after.extraIndexes.other} besides those on \`org_id\`).** The generator's index on each reference column, in place of`);
  L.push("   the constraint. An index changes no behaviour.");
  L.push(`7. **\`uuid\` unique where Coolify's is not (${after.uuidUniques.length}: ${after.uuidUniques.map(code).join(", ")}).** The generator makes every \`uuid\` column unique, because the`);
  L.push("   uuid is the public id on every route (design §1.1).");
  L.push(`8. **\`now()\` defaults (${after.nowDefaults.length} columns).** Coolify's \`->default(now())\` freezes the moment the migration ran; \`deploy\` has`);
  L.push("   `CURRENT_TIMESTAMP`, which is what the code relies on for rows created later.");
  L.push("9. **Auto-increment.** Laravel's `id()` is a `bigserial`; `deploy` uses `GENERATED BY DEFAULT AS IDENTITY`. Both are compared as");
  L.push("   auto-increment. Numeric defaults are compared without their cast (`'10'::smallint` is `10`), `NULL::type` as no default.");
  L.push("");

  L.push("## Unique indexes");
  L.push("");
  L.push(`Every unique index of Coolify on a compared table (${after.uniques.length}), and how it is scoped where one database holds many orgs. A Coolify`);
  L.push("index made of a reference to a row that belongs to one org needs no `org_id`: the reference already carries the org. An index");
  L.push("made of a name alone gets `org_id` in front. `Since` says which migrations created it in `deploy`.");
  L.push("");
  L.push("| Table | Coolify | Freeploy | Since | Scope |");
  L.push("|---|---|---|---|---|");
  for (const u of after.uniques) {
    const was = before.uniques.find((b) => b.table === u.table && sameColumns(b.coolify, u.coolify))?.present;
    const since = !u.present ? "**missing**" : was ? "500–630" : "660";
    L.push(`| ${code(u.table)} | ${code(`(${u.coolify.join(", ")})`)} | ${sameColumns(u.coolify, u.freeploy) ? "same" : code(`(${u.freeploy.join(", ")})`)} | ${since} | ${cell(u.scope)} |`);
  }
  L.push("");
  L.push(`### Why the ${addedUniques.length} unique indexes of \`${CATCH_UP}\` cannot fail on existing rows`);
  L.push("");
  L.push("When the migration was written (2026-11-25) the code on `main`, which stage and prod run, wrote four `deploy` tables: `org_keys`,");
  L.push("`private_keys`, `servers` and `server_settings`. None of them gets a unique index here, so every table below is empty there");
  L.push("until the task named in its row is deployed; from then on the reason given holds.");
  L.push("");
  L.push("| Index | Reason |");
  L.push("|---|---|");
  for (const u of addedUniques) L.push(`| ${code(key(u.table, u.freeploy))} | ${cell(UNIQUE_SAFETY[key(u.table, u.freeploy)] ?? "**not argued**")} |`);
  L.push("");
  L.push("PostgreSQL treats NULLs as distinct in a unique index, as it does for Coolify: an index only binds rows whose columns are all set.");
  L.push("");

  L.push(`## What \`${CATCH_UP}\` closed, in detail`);
  L.push("");
  for (const kind of Object.keys(KIND_TITLES) as Difference["kind"][]) {
    const list = closed.filter((d) => d.kind === kind);
    if (!list.length) continue;
    L.push(`### ${KIND_TITLES[kind]} (${list.length})`);
    L.push("");
    L.push(...differenceTable(list));
    L.push("");
  }

  L.push("## Raw statements in Coolify's migrations");
  L.push("");
  const raw = coolify.rawStatements;
  L.push(`${raw.length} \`DB::statement\` / \`DB::unprepared\` calls in ${new Set(raw.map((s) => s.migration)).size} migrations (outside \`down()\`). A reader of the Blueprint calls`);
  L.push("alone — the schema fold of DP2 — sees none of them; here they all ran, because the reference database is PostgreSQL. `Guard` is the");
  L.push("driver test around a statement: one guarded for `pgsql` does not run on the SQLite the fixtures of other tasks use.");
  L.push("");
  L.push("| Migration | Line | Guard | Statement |");
  L.push("|---|---:|---|---|");
  for (const s of raw) L.push(`| ${code(s.migration)} | ${s.line} | ${s.guard ? code(s.guard.replace(/\s*\{$/, "")) : "—"} | ${code(s.statement)} |`);
  L.push("");
  return L.join("\n");
}
