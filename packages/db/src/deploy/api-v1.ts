// Rows as Coolify's /api/v1 serializes them (freeploy-coolify-parity DP-70). Coolify's API answers with
// a model's attributes — every column — so these read whole rows: row_to_json() gives every column with
// PostgreSQL's types (booleans, numbers, JSON as JSON, timestamps as ISO text), as Eloquent on PostgreSQL
// hands them to the serializer. org_id (Freeploy's tenancy column) is left out; the caller adds Coolify's
// team_id. Every call runs inside withOrg(), so row-level security confines it to one org.
import type { SqlExecutor } from "../hyperdrive/executor.js";
import { DATABASE_ENGINES, DATABASE_TABLES } from "./databases.js";
import { DESTINATION_MORPH_CLASS } from "./destinations.js";

/** One row: its columns in table order. */
export type ApiRow = Array<[string, unknown]>;

const TABLES = [
  "projects",
  "environments",
  "private_keys",
  "servers",
  "server_settings",
  // DP-71
  "applications",
  "application_settings",
  "environment_variables",
  "standalone_dockers",
  "additional_destinations",
  "application_deployment_queues",
  // DP-73: the standalone databases, their backup schedules, executions and S3 destinations
  "standalone_postgresqls",
  "standalone_redis",
  "standalone_mongodbs",
  "standalone_mysqls",
  "standalone_mariadbs",
  "standalone_keydbs",
  "standalone_dragonflies",
  "standalone_clickhouses",
  "scheduled_database_backups",
  "scheduled_database_backup_executions",
  "scheduled_database_backup_s3_storage",
  "s3_storages",
  // DP-74: services and their applications and databases
  "services",
  "service_applications",
  "service_databases",
  // DP-81: the shared variables of projects and environments
  "shared_environment_variables",
  // DP-84: a resource's storages, and scheduled tasks with their executions
  "local_persistent_volumes",
  "local_file_volumes",
  "scheduled_tasks",
  "scheduled_task_executions",
  // DP-85: a Swarm destination (a service part's server), the six notification channels' settings
  "swarm_dockers",
  "email_notification_settings",
  "discord_notification_settings",
  "slack_notification_settings",
  "telegram_notification_settings",
  "pushover_notification_settings",
  "webhook_notification_settings",
  // DP-86: an application's previews
  "application_previews",
] as const;
export type ApiTable = (typeof TABLES)[number];

function parse(text: string): ApiRow {
  return Object.entries(JSON.parse(text) as Record<string, unknown>).filter(([k]) => k !== "org_id");
}

/** SELECT * FROM deploy.<table> [WHERE …] ORDER BY id (or by name, then id: Eloquent's ->orderBy('name')), as rows. */
export async function apiRows(tx: SqlExecutor, table: ApiTable, where: string | null = null, params: unknown[] = [], order: "id" | "name" = "id"): Promise<ApiRow[]> {
  if (!TABLES.includes(table)) throw new Error(`apiRows: ${table}`);
  const orderBy = order === "name" ? "t.name, t.id" : "t.id";
  const r = await tx.execute<{ j: string }>(`SELECT row_to_json(t)::text AS j FROM deploy.${table} t${where ? ` WHERE ${where}` : ""} ORDER BY ${orderBy}`, params);
  return r.rows.map((x) => parse(x.j));
}

export function apiValue(row: ApiRow, column: string): unknown {
  return row.find(([k]) => k === column)?.[1];
}

/**
 * isPublicPortAlreadyUsed($server, $port, $id) (DP-73): a public database of the server's destinations, of any engine,
 * listens on the port. Coolify leaves out every database whose id is $id — of any engine, not only the one being
 * changed — and so does this.
 */
export async function databasePublicPortTaken(tx: SqlExecutor, serverId: string | number, port: number, excludeId: string | number | null = null): Promise<boolean> {
  const parts = DATABASE_ENGINES.map(
    (engine) => `SELECT d.id FROM deploy.${DATABASE_TABLES[engine].table} d
      LEFT JOIN deploy.standalone_dockers sd ON sd.id = d.destination_id AND d.destination_type = $3
      LEFT JOIN deploy.swarm_dockers wd ON wd.id = d.destination_id AND d.destination_type = $4
     WHERE d.deleted_at IS NULL AND d.is_public AND d.public_port = $2 AND COALESCE(sd.server_id, wd.server_id) = $1`,
  );
  const r = await tx.execute<{ id: string | number }>(`SELECT id FROM (${parts.join(" UNION ALL ")}) u`, [serverId, port, DESTINATION_MORPH_CLASS.standalone, DESTINATION_MORPH_CLASS.swarm]);
  return r.rows.some((row) => excludeId === null || String(row.id) !== String(excludeId));
}
