// Derived from coollabsio/coolify@91b7e3e:app/Models/{Application,ApplicationSetting,Server}.php (the
// columns, Server::applications) and app/Livewire/Project/Application/{Domains,Advanced}.php,
// app/Livewire/Project/Shared/{HealthChecks,ResourceLimits}.php (syncData) (Apache-2.0), modified.
//
// deploy.applications and deploy.application_settings for an application's
// Domains, Advanced, Healthcheck and Resource Limits pages. Every function
// takes the transaction of withOrg(): row-level security confines each query
// to that org. A soft-deleted application is never returned.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { DESTINATION_MORPH_CLASS } from "./destinations.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** The columns of deploy.applications these pages write. */
export const APPLICATION_CONFIGURATION_COLUMNS = [
  // Domains
  "fqdn",
  "redirect",
  "domain_port_overrides",
  "noindex_domains",
  "domain_dns_statuses",
  // Healthcheck
  "health_check_enabled",
  "health_check_type",
  "health_check_command",
  "health_check_method",
  "health_check_scheme",
  "health_check_host",
  "health_check_port",
  "health_check_path",
  "health_check_return_code",
  "health_check_response_text",
  "health_check_interval",
  "health_check_timeout",
  "health_check_retries",
  "health_check_start_period",
  // Resource Limits
  "limits_cpus",
  "limits_cpuset",
  "limits_cpu_shares",
  "limits_memory",
  "limits_memory_swap",
  "limits_memory_swappiness",
  "limits_memory_reservation",
  // Advanced
  "max_restart_count",
] as const;
export type ApplicationConfigurationColumn = (typeof APPLICATION_CONFIGURATION_COLUMNS)[number];
/** The JSON columns among them take a JSON text or null. */
export type ApplicationConfigurationChanges = Partial<Record<ApplicationConfigurationColumn, string | number | boolean | null>>;

const JSON_COLUMNS: readonly string[] = ["domain_port_overrides", "noindex_domains", "domain_dns_statuses"];

/** The columns of deploy.application_settings these pages read and write. */
export const APPLICATION_SETTINGS_PAGE_COLUMNS = [
  // Domains
  "is_force_https_enabled",
  "is_permanent_redirect_enabled",
  // Advanced
  "disable_build_cache",
  "inject_build_args_to_dockerfile",
  "include_source_commit_in_build",
  "include_network_hosts_in_build",
  "is_consistent_container_name_enabled",
  "custom_internal_name",
  "custom_container_name_prefix",
  "stop_grace_period",
  "rolling_update_drain_seconds",
  "is_log_drain_enabled",
  "is_gpu_enabled",
  "gpu_driver",
  "gpu_count",
  "gpu_device_ids",
  "gpu_options",
  "is_gzip_enabled",
  "is_stripprefix_enabled",
  "traefik_certificate_resolver",
] as const;
export type ApplicationSettingsPageColumn = (typeof APPLICATION_SETTINGS_PAGE_COLUMNS)[number];
export type ApplicationSettingsChanges = Partial<Record<ApplicationSettingsPageColumn, string | number | boolean | null>>;

/** An application as its configuration pages read it: its own columns, its settings, and its destination's server. */
export interface DeployApplicationConfigurationRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  build_pack: string;
  status: string;
  ports_exposes: string | null;
  /** $application->dockerfile is set (git_based() is then false). */
  has_dockerfile: boolean;
  fqdn: string | null;
  redirect: string;
  /** JSON columns: the driver may hand back the parsed value or its text. */
  domain_port_overrides: unknown;
  noindex_domains: unknown;
  domain_dns_statuses: unknown;
  health_check_enabled: boolean;
  health_check_type: string | null;
  health_check_command: string | null;
  health_check_method: string;
  health_check_scheme: string;
  health_check_host: string;
  health_check_port: string | null;
  health_check_path: string;
  health_check_return_code: number;
  health_check_response_text: string | null;
  health_check_interval: number;
  health_check_timeout: number;
  health_check_retries: number;
  health_check_start_period: number;
  custom_healthcheck_found: boolean;
  limits_cpus: string;
  limits_cpuset: string | null;
  limits_cpu_shares: number;
  limits_memory: string;
  limits_memory_swap: string;
  limits_memory_swappiness: number;
  limits_memory_reservation: string;
  max_restart_count: number;
  // application_settings (null when the row is missing)
  is_static: boolean | null;
  is_container_label_readonly_enabled: boolean | null;
  is_force_https_enabled: boolean | null;
  is_permanent_redirect_enabled: boolean | null;
  disable_build_cache: boolean | null;
  inject_build_args_to_dockerfile: boolean | null;
  include_source_commit_in_build: boolean | null;
  include_network_hosts_in_build: boolean | null;
  is_consistent_container_name_enabled: boolean | null;
  custom_internal_name: string | null;
  custom_container_name_prefix: string | null;
  stop_grace_period: number | null;
  rolling_update_drain_seconds: number | null;
  is_log_drain_enabled: boolean | null;
  is_gpu_enabled: boolean | null;
  gpu_driver: string | null;
  gpu_count: string | null;
  gpu_device_ids: string | null;
  gpu_options: string | null;
  is_gzip_enabled: boolean | null;
  is_stripprefix_enabled: boolean | null;
  traefik_certificate_resolver: string | null;
  // destination.server and its settings (null when the destination or the server is gone)
  server_id: string | number | null;
  server_uuid: string | null;
  server_name: string | null;
  server_ip: string | null;
  server_proxy: unknown;
  server_metadata: unknown;
  server_wildcard_domain: string | null;
  server_public_ipv4: string | null;
  server_public_ipv6: string | null;
  server_traefik_certificate_resolver: string | null;
  server_is_reachable: boolean | null;
  server_is_usable: boolean | null;
  server_force_disabled: boolean | null;
  server_is_logdrain_newrelic_enabled: boolean | null;
  server_is_logdrain_axiom_enabled: boolean | null;
  server_is_logdrain_custom_enabled: boolean | null;
  server_is_logdrain_cloudwatch_enabled: boolean | null;
  /** $application->additional_servers->count() */
  additional_servers: string | number;
}

const STANDALONE = DESTINATION_MORPH_CLASS.standalone.replace(/\\/g, "\\\\");
const SWARM = DESTINATION_MORPH_CLASS.swarm.replace(/\\/g, "\\\\");

const APPLICATION_READ_COLUMNS = [
  "id", "uuid", "name", "build_pack", "status", "ports_exposes", "custom_healthcheck_found",
  ...APPLICATION_CONFIGURATION_COLUMNS,
].map((c) => `a."${c}"`);

const SETTINGS_READ_COLUMNS = ["is_static", "is_container_label_readonly_enabled", ...APPLICATION_SETTINGS_PAGE_COLUMNS].map((c) => `st."${c}"`);

const DESTINATION_JOINS = `
  LEFT JOIN deploy.standalone_dockers sd ON sd.id = a.destination_id AND a.destination_type = E'${STANDALONE}'
  LEFT JOIN deploy.swarm_dockers wd ON wd.id = a.destination_id AND a.destination_type = E'${SWARM}'`;

/** $application with settings and destination.server.settings (loadMissing in Domains::loadDomainState). */
export async function findApplicationConfiguration(tx: SqlExecutor, uuid: string): Promise<DeployApplicationConfigurationRow | null> {
  const r = await tx.execute<DeployApplicationConfigurationRow>(
    `SELECT ${APPLICATION_READ_COLUMNS.join(", ")},
            (a.dockerfile IS NOT NULL AND a.dockerfile <> '') AS has_dockerfile,
            ${SETTINGS_READ_COLUMNS.join(", ")},
            s.id AS server_id, s.uuid AS server_uuid, s.name AS server_name, s.ip AS server_ip, s.proxy AS server_proxy,
            s.server_metadata AS server_metadata, ss.wildcard_domain AS server_wildcard_domain,
            ss.public_ipv4 AS server_public_ipv4, ss.public_ipv6 AS server_public_ipv6,
            ss.traefik_certificate_resolver AS server_traefik_certificate_resolver,
            ss.is_reachable AS server_is_reachable, ss.is_usable AS server_is_usable, ss.force_disabled AS server_force_disabled,
            ss.is_logdrain_newrelic_enabled AS server_is_logdrain_newrelic_enabled,
            ss.is_logdrain_axiom_enabled AS server_is_logdrain_axiom_enabled,
            ss.is_logdrain_custom_enabled AS server_is_logdrain_custom_enabled,
            ss.is_logdrain_cloudwatch_enabled AS server_is_logdrain_cloudwatch_enabled,
            (SELECT count(*) FROM deploy.additional_destinations ad WHERE ad.application_id = a.id) AS additional_servers
       FROM deploy.applications a
       LEFT JOIN deploy.application_settings st ON st.application_id = a.id${DESTINATION_JOINS}
       LEFT JOIN deploy.servers s ON s.id = COALESCE(sd.server_id, wd.server_id) AND s.deleted_at IS NULL
       LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id
      WHERE a.uuid = $1 AND a.deleted_at IS NULL`,
    [uuid],
  );
  return r.rows[0] ?? null;
}

/** $application->save(): only the given columns (the dirty ones), and updated_at. False when the application is gone. */
export async function updateApplicationConfiguration(tx: SqlExecutor, id: string | number, changes: ApplicationConfigurationChanges): Promise<boolean> {
  const columns = APPLICATION_CONFIGURATION_COLUMNS.filter((c) => changes[c] !== undefined);
  if (!columns.length) return true;
  const sets = columns.map((c, i) => `"${c}" = $${i + 2}${JSON_COLUMNS.includes(c) ? "::json" : ""}`);
  const r = await tx.execute<{ id: string | number }>(
    `UPDATE deploy.applications SET ${[...sets, `updated_at = ${NOW}`].join(", ")} WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [id, ...columns.map((c) => changes[c] ?? null)],
  );
  return r.rows.length > 0;
}

/** $application->settings->save(): only the given columns, and updated_at. False when the settings row is missing. */
export async function updateApplicationSettings(tx: SqlExecutor, applicationId: string | number, changes: ApplicationSettingsChanges): Promise<boolean> {
  const columns = APPLICATION_SETTINGS_PAGE_COLUMNS.filter((c) => changes[c] !== undefined);
  if (!columns.length) return true;
  const sets = columns.map((c, i) => `"${c}" = $${i + 2}`);
  const r = await tx.execute<{ id: string | number }>(
    `UPDATE deploy.application_settings SET ${[...sets, `updated_at = ${NOW}`].join(", ")} WHERE application_id = $1 RETURNING id`,
    [applicationId, ...columns.map((c) => changes[c] ?? null)],
  );
  return r.rows.length > 0;
}

/** The names by which an application's containers are found on a server. */
export interface DeployApplicationContainerNamesRow extends SqlRow {
  id: string | number;
  uuid: string;
  custom_internal_name: string | null;
  custom_container_name_prefix: string | null;
}

/**
 * $server->applications() with their settings' container names: the
 * applications whose destination is on the server, and those that have it as
 * an additional server.
 */
export async function listServerApplicationContainerNames(tx: SqlExecutor, serverId: string | number): Promise<DeployApplicationContainerNamesRow[]> {
  const r = await tx.execute<DeployApplicationContainerNamesRow>(
    `SELECT a.id, a.uuid, st.custom_internal_name, st.custom_container_name_prefix
       FROM deploy.applications a
       LEFT JOIN deploy.application_settings st ON st.application_id = a.id${DESTINATION_JOINS}
      WHERE a.deleted_at IS NULL
        AND (COALESCE(sd.server_id, wd.server_id) = $1
             OR a.id IN (SELECT ad.application_id FROM deploy.additional_destinations ad WHERE ad.server_id = $1))
      ORDER BY a.id`,
    [serverId],
  );
  return r.rows;
}
