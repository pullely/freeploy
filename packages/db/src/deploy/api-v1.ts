// Rows as Coolify's /api/v1 serializes them (freeploy-coolify-parity DP-70). Coolify's API answers with
// a model's attributes — every column — so these read whole rows: row_to_json() gives every column with
// PostgreSQL's types (booleans, numbers, JSON as JSON, timestamps as ISO text), as Eloquent on PostgreSQL
// hands them to the serializer. org_id (Freeploy's tenancy column) is left out; the caller adds Coolify's
// team_id. Every call runs inside withOrg(), so row-level security confines it to one org.
import type { SqlExecutor } from "../hyperdrive/executor.js";

/** One row: its columns in table order. */
export type ApiRow = Array<[string, unknown]>;

const TABLES = ["projects", "environments", "private_keys", "servers", "server_settings"] as const;
export type ApiTable = (typeof TABLES)[number];

function parse(text: string): ApiRow {
  return Object.entries(JSON.parse(text) as Record<string, unknown>).filter(([k]) => k !== "org_id");
}

/** SELECT * FROM deploy.<table> [WHERE …] ORDER BY id, as rows. */
export async function apiRows(tx: SqlExecutor, table: ApiTable, where: string | null = null, params: unknown[] = []): Promise<ApiRow[]> {
  if (!TABLES.includes(table)) throw new Error(`apiRows: ${table}`);
  const r = await tx.execute<{ j: string }>(`SELECT row_to_json(t)::text AS j FROM deploy.${table} t${where ? ` WHERE ${where}` : ""} ORDER BY t.id`, params);
  return r.rows.map((x) => parse(x.j));
}

export function apiValue(row: ApiRow, column: string): unknown {
  return row.find(([k]) => k === column)?.[1];
}
