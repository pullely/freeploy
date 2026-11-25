// Reads the physical schema of one Postgres schema from the system catalogs:
// every table's columns, primary key, indexes, foreign keys, CHECK constraints
// and storage options. The same queries describe Coolify's own database (after
// all of its migrations have run, dump-coolify-schema.ts) and Freeploy's
// `deploy` schema (after packages/db's migrations, in tests/db), so the two can
// be compared fact by fact (DP-60).

export interface SchemaColumn {
  name: string;
  /** format_type(): "character varying(255)", "timestamp(0) without time zone", "bigint", … */
  type: string;
  nullable: boolean;
  /** pg_get_expr() of the default; null when there is none. A serial's nextval() is reported as autoIncrement instead. */
  default: string | null;
  /** A serial (Laravel's id()) or an identity column. */
  autoIncrement: boolean;
}

export interface SchemaIndex {
  name: string;
  unique: boolean;
  /** btree, gin, … */
  method: string;
  /** Key columns or expressions, in index order, as pg_get_indexdef() prints them (with DESC where given). */
  columns: string[];
  /** The WHERE of a partial index. */
  predicate: string | null;
}

export interface SchemaForeignKey {
  name: string;
  columns: string[];
  references: { table: string; columns: string[] };
  onDelete: string;
  onUpdate: string;
}

export interface SchemaCheck {
  name: string;
  /** pg_get_constraintdef() */
  definition: string;
}

export interface SchemaTable {
  columns: SchemaColumn[];
  primaryKey: string[];
  /** Every index but the primary key's, unique ones included. */
  indexes: SchemaIndex[];
  foreignKeys: SchemaForeignKey[];
  checks: SchemaCheck[];
  /** pg_class.reloptions (fillfactor, autovacuum settings). */
  storage: string[];
}

export type SchemaDump = Record<string, SchemaTable>;

/** Runs one statement with positional parameters and returns its rows. */
export type CatalogQuery = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

const ACTIONS: Record<string, string> = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };

const list = (v: unknown): string[] => (typeof v === "string" ? (JSON.parse(v) as string[] | null) ?? [] : ((v as string[] | null) ?? []));

export async function dumpSchema(query: CatalogQuery, schema: string): Promise<SchemaDump> {
  const out: SchemaDump = {};
  const table = (name: string): SchemaTable => (out[name] ??= { columns: [], primaryKey: [], indexes: [], foreignKeys: [], checks: [], storage: [] });

  const tables = await query(
    `SELECT c.relname AS "table", to_json(coalesce(c.reloptions, '{}'::text[]))::text AS storage
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname`,
    [schema],
  );
  for (const r of tables) table(r["table"] as string).storage = list(r["storage"]).sort();

  const columns = await query(
    `SELECT c.relname AS "table", a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS "default", a.attidentity::text AS identity
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
    [schema],
  );
  for (const r of columns) {
    const def = r["default"] as string | null;
    const serial = def !== null && /^nextval\(/.test(def);
    table(r["table"] as string).columns.push({
      name: r["name"] as string,
      type: r["type"] as string,
      nullable: r["nullable"] as boolean,
      default: serial ? null : def,
      autoIncrement: serial || (r["identity"] as string) !== "",
    });
  }

  const indexes = await query(
    `SELECT t.relname AS "table", i.relname AS name, ix.indisunique AS "unique", ix.indisprimary AS "primary", am.amname AS method,
            pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
            (SELECT to_json(array_agg(pg_get_indexdef(ix.indexrelid, k, true) ORDER BY k))::text
               FROM generate_series(1, ix.indnkeyatts::int) AS k) AS columns,
            (SELECT to_json(array_agg(CASE WHEN (ix.indoption[k - 1]::int & 1) = 1 THEN 'DESC' ELSE '' END ORDER BY k))::text
               FROM generate_series(1, ix.indnkeyatts::int) AS k) AS directions
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_am am ON am.oid = i.relam
      WHERE n.nspname = $1 AND t.relkind = 'r'
      ORDER BY t.relname, i.relname`,
    [schema],
  );
  for (const r of indexes) {
    const directions = list(r["directions"]);
    const cols = list(r["columns"]).map((c, k) => (directions[k] ? `${c} ${directions[k]}` : c));
    if (r["primary"] as boolean) {
      table(r["table"] as string).primaryKey = cols;
      continue;
    }
    table(r["table"] as string).indexes.push({
      name: r["name"] as string,
      unique: r["unique"] as boolean,
      method: r["method"] as string,
      columns: cols,
      predicate: (r["predicate"] as string | null) ?? null,
    });
  }

  const constraints = await query(
    `SELECT t.relname AS "table", con.conname AS name, con.contype::text AS type, pg_get_constraintdef(con.oid) AS definition,
            ft.relname AS ref_table, con.confdeltype::text AS on_delete, con.confupdtype::text AS on_update,
            (SELECT to_json(array_agg(a.attname ORDER BY u.ord))::text
               FROM unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.attnum) AS columns,
            (SELECT to_json(array_agg(a.attname ORDER BY u.ord))::text
               FROM unnest(con.confkey) WITH ORDINALITY AS u(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = u.attnum) AS ref_columns
       FROM pg_constraint con
       JOIN pg_class t ON t.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       LEFT JOIN pg_class ft ON ft.oid = con.confrelid
      WHERE n.nspname = $1 AND con.contype IN ('c', 'f')
      ORDER BY t.relname, con.conname`,
    [schema],
  );
  for (const r of constraints) {
    const t = table(r["table"] as string);
    if (r["type"] === "c") t.checks.push({ name: r["name"] as string, definition: r["definition"] as string });
    else {
      t.foreignKeys.push({
        name: r["name"] as string,
        columns: list(r["columns"]),
        references: { table: r["ref_table"] as string, columns: list(r["ref_columns"]) },
        onDelete: ACTIONS[r["on_delete"] as string] ?? (r["on_delete"] as string),
        onUpdate: ACTIONS[r["on_update"] as string] ?? (r["on_update"] as string),
      });
    }
  }
  return out;
}
