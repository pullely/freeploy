// Derived from coollabsio/coolify@91b7e3e:app/Models/ServerSetting.php,
// app/Models/Team.php (usesSwarm) and app/Livewire/Server/{Advanced,DockerCleanup,LogDrains,Swarm,Sentinel}.php
// (syncData) (Apache-2.0), modified.
//
// deploy.server_settings for the server settings pages (Advanced, Docker
// Cleanup, Log Drains, Swarm, Sentinel). Every function takes the transaction
// of withOrg(): row-level security confines each query to that org. The
// encrypted columns (sentinel_token, logdrain_custom_config and the log drain
// keys) hold fp1 ciphertexts; these functions never decrypt.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** The columns the settings pages read and write, as Coolify names them. */
export const SERVER_SETTINGS_PAGE_COLUMNS = [
  // Advanced
  "concurrent_builds",
  "dynamic_timeout",
  "deployment_queue_limit",
  "backup_compression_cpu_percentage",
  "server_disk_usage_notification_threshold",
  "server_disk_usage_check_frequency",
  "server_disk_usage_notification_interval_hours",
  // Docker Cleanup
  "force_docker_cleanup",
  "docker_cleanup_frequency",
  "docker_cleanup_threshold",
  "delete_unused_volumes",
  "delete_unused_networks",
  "disable_application_image_retention",
  // Log Drains
  "is_logdrain_newrelic_enabled",
  "logdrain_newrelic_license_key",
  "logdrain_newrelic_base_uri",
  "is_logdrain_axiom_enabled",
  "logdrain_axiom_dataset_name",
  "logdrain_axiom_api_key",
  "logdrain_axiom_domain",
  "is_logdrain_custom_enabled",
  "logdrain_custom_config",
  "logdrain_custom_config_parser",
  "is_logdrain_cloudwatch_enabled",
  "logdrain_cloudwatch_region",
  "logdrain_cloudwatch_group",
  "logdrain_cloudwatch_stream_prefix",
  // Swarm
  "is_swarm_manager",
  "is_swarm_worker",
  // Sentinel
  "is_metrics_enabled",
  "sentinel_token",
  "sentinel_custom_url",
  "is_sentinel_debug_enabled",
  "sentinel_metrics_refresh_rate_seconds",
  "sentinel_metrics_history_days",
  "sentinel_push_interval_seconds",
] as const;

export type ServerSettingsPageColumn = (typeof SERVER_SETTINGS_PAGE_COLUMNS)[number];

/** What a save writes: any of the page columns (undefined leaves one as it is). */
export type ServerSettingsPageChanges = Partial<Record<ServerSettingsPageColumn, string | number | boolean | null | undefined>>;

export interface DeployServerSettingsRow extends SqlRow {
  concurrent_builds: number;
  dynamic_timeout: number;
  deployment_queue_limit: number;
  backup_compression_cpu_percentage: number;
  server_disk_usage_notification_threshold: number;
  server_disk_usage_check_frequency: string;
  server_disk_usage_notification_interval_hours: number;
  force_docker_cleanup: boolean;
  docker_cleanup_frequency: string;
  docker_cleanup_threshold: number;
  delete_unused_volumes: boolean;
  delete_unused_networks: boolean;
  disable_application_image_retention: boolean;
  is_logdrain_newrelic_enabled: boolean;
  logdrain_newrelic_license_key: string | null;
  logdrain_newrelic_base_uri: string | null;
  is_logdrain_axiom_enabled: boolean;
  logdrain_axiom_dataset_name: string | null;
  logdrain_axiom_api_key: string | null;
  logdrain_axiom_domain: string | null;
  is_logdrain_custom_enabled: boolean;
  logdrain_custom_config: string | null;
  logdrain_custom_config_parser: string | null;
  is_logdrain_cloudwatch_enabled: boolean;
  logdrain_cloudwatch_region: string | null;
  logdrain_cloudwatch_group: string | null;
  logdrain_cloudwatch_stream_prefix: string | null;
  is_swarm_manager: boolean;
  is_swarm_worker: boolean;
  is_metrics_enabled: boolean;
  sentinel_token: string | null;
  sentinel_custom_url: string | null;
  is_sentinel_debug_enabled: boolean;
  sentinel_metrics_refresh_rate_seconds: number;
  sentinel_metrics_history_days: number;
  sentinel_push_interval_seconds: number;
  // deploy.servers: what Server::sentinelStatus() reads.
  sentinel_updated_at: string | Date | null;
  sentinel_waiting_since: string | Date | null;
}

/** $server->settings, with the server's Sentinel timestamps. */
export async function findServerSettings(tx: SqlExecutor, serverId: string | number): Promise<DeployServerSettingsRow | null> {
  const columns = SERVER_SETTINGS_PAGE_COLUMNS.map((c) => `ss."${c}"`).join(", ");
  const r = await tx.execute<DeployServerSettingsRow>(
    `SELECT ${columns}, s.sentinel_updated_at, s.sentinel_waiting_since
       FROM deploy.server_settings ss JOIN deploy.servers s ON s.id = ss.server_id
      WHERE ss.server_id = $1`,
    [serverId],
  );
  return r.rows[0] ?? null;
}

/**
 * $server->settings->…; $server->settings->save(): the given page columns
 * (only those), and updated_at. False when the server has no settings row.
 */
export async function updateServerSettings(tx: SqlExecutor, serverId: string | number, changes: ServerSettingsPageChanges): Promise<boolean> {
  const entries = Object.entries(changes).filter(([c, v]) => v !== undefined && (SERVER_SETTINGS_PAGE_COLUMNS as readonly string[]).includes(c));
  if (!entries.length) {
    const r = await tx.execute(`SELECT 1 FROM deploy.server_settings WHERE server_id = $1`, [serverId]);
    return r.rows.length > 0;
  }
  const sets = entries.map(([c], i) => `"${c}" = $${i + 2}`).join(", ");
  const r = await tx.execute(`UPDATE deploy.server_settings SET ${sets}, updated_at = ${NOW} WHERE server_id = $1 RETURNING id`, [serverId, ...entries.map(([, v]) => v)]);
  return r.rows.length > 0;
}

/**
 * Team::usesSwarm(): a server of the org is a Swarm manager or worker, or has
 * a Swarm destination.
 */
export async function orgUsesSwarm(tx: SqlExecutor): Promise<boolean> {
  const r = await tx.execute(
    `SELECT 1 WHERE EXISTS (
       SELECT 1 FROM deploy.servers s JOIN deploy.server_settings ss ON ss.server_id = s.id
        WHERE s.deleted_at IS NULL AND (ss.is_swarm_manager OR ss.is_swarm_worker)
     ) OR EXISTS (
       SELECT 1 FROM deploy.swarm_dockers d JOIN deploy.servers s ON s.id = d.server_id WHERE s.deleted_at IS NULL
     )`,
  );
  return r.rows.length > 0;
}
