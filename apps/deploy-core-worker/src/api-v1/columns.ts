// Derived from coollabsio/coolify@91b7e3e:database/migrations (Apache-2.0), modified.
//
// The column order of Coolify's tables (PostgreSQL, migrate:fresh) for the rows its API writes as Eloquent's
// toArray() gives them without serializeApiResponse()'s sorting — a loaded relation, such as an application's
// destination, its server and their settings. Freeploy's tables have the same columns in another order.
// tests/deploy-core-worker/src/api-v1-resources.test.ts holds this list to the goldens' `columns`, which
// fixtures/api/emit.php reads from Coolify's schema.
import type { ApiRow } from "@saas/db/deploy";

export const COOLIFY_COLUMNS = {
  // DP-78: an application's environment, its project (a deployment's application loads them)
  projects: ["id", "uuid", "name", "description", "team_id", "created_at", "updated_at", "icon_path", "icon_storage_type", "icon_s3_storage_id", "canvas_position"],
  environments: ["id", "name", "project_id", "created_at", "updated_at", "description", "uuid", "canvas_positions"],
  // DP-78: the standalone databases, serialized unsorted by GET /resources and GET /projects/{uuid}/{environment}
  standalone_postgresqls: ["id", "uuid", "name", "description", "postgres_user", "postgres_password", "postgres_db", "postgres_initdb_args", "postgres_host_auth_method", "init_scripts", "status", "image", "is_public", "public_port", "ports_mappings", "limits_memory", "limits_memory_swap", "limits_memory_swappiness", "limits_memory_reservation", "limits_cpus", "limits_cpuset", "limits_cpu_shares", "started_at", "destination_type", "destination_id", "environment_id", "created_at", "updated_at", "postgres_conf", "is_log_drain_enabled", "is_include_timestamps", "deleted_at", "config_hash", "custom_docker_run_options", "last_online_at", "enable_ssl", "ssl_mode", "restart_count", "last_restart_at", "last_restart_type", "public_port_timeout", "health_check_enabled", "health_check_interval", "health_check_timeout", "health_check_retries", "health_check_start_period", "redact_all_env_values_in_logs", "include_coolify_default_variables"],
  standalone_redis: ["id", "uuid", "name", "description", "redis_conf", "status", "image", "is_public", "public_port", "ports_mappings", "limits_memory", "limits_memory_swap", "limits_memory_swappiness", "limits_memory_reservation", "limits_cpus", "limits_cpuset", "limits_cpu_shares", "started_at", "destination_type", "destination_id", "environment_id", "created_at", "updated_at", "is_log_drain_enabled", "is_include_timestamps", "deleted_at", "config_hash", "custom_docker_run_options", "last_online_at", "enable_ssl", "restart_count", "last_restart_at", "last_restart_type", "public_port_timeout", "health_check_enabled", "health_check_interval", "health_check_timeout", "health_check_retries", "health_check_start_period", "legacy_password_quoting", "redact_all_env_values_in_logs", "include_coolify_default_variables"],
  standalone_mongodbs: ["id", "uuid", "name", "description", "mongo_conf", "mongo_initdb_root_username", "mongo_initdb_root_password", "mongo_initdb_database", "status", "image", "is_public", "public_port", "ports_mappings", "limits_memory", "limits_memory_swap", "limits_memory_swappiness", "limits_memory_reservation", "limits_cpus", "limits_cpuset", "limits_cpu_shares", "started_at", "destination_type", "destination_id", "environment_id", "created_at", "updated_at", "is_log_drain_enabled", "is_include_timestamps", "deleted_at", "config_hash", "custom_docker_run_options", "last_online_at", "enable_ssl", "ssl_mode", "restart_count", "last_restart_at", "last_restart_type", "public_port_timeout", "health_check_enabled", "health_check_interval", "health_check_timeout", "health_check_retries", "health_check_start_period", "redact_all_env_values_in_logs", "include_coolify_default_variables"],
  standalone_mysqls: ["id", "uuid", "name", "description", "mysql_root_password", "mysql_user", "mysql_password", "mysql_database", "mysql_conf", "status", "image", "is_public", "public_port", "ports_mappings", "limits_memory", "limits_memory_swap", "limits_memory_swappiness", "limits_memory_reservation", "limits_cpus", "limits_cpuset", "limits_cpu_shares", "started_at", "destination_type", "destination_id", "environment_id", "created_at", "updated_at", "is_log_drain_enabled", "is_include_timestamps", "deleted_at", "config_hash", "custom_docker_run_options", "last_online_at", "enable_ssl", "ssl_mode", "restart_count", "last_restart_at", "last_restart_type", "public_port_timeout", "health_check_enabled", "health_check_interval", "health_check_timeout", "health_check_retries", "health_check_start_period", "redact_all_env_values_in_logs", "include_coolify_default_variables"],
  standalone_mariadbs: ["id", "uuid", "name", "description", "mariadb_root_password", "mariadb_user", "mariadb_password", "mariadb_database", "mariadb_conf", "status", "image", "is_public", "public_port", "ports_mappings", "limits_memory", "limits_memory_swap", "limits_memory_swappiness", "limits_memory_reservation", "limits_cpus", "limits_cpuset", "limits_cpu_shares", "started_at", "destination_type", "destination_id", "environment_id", "created_at", "updated_at", "is_log_drain_enabled", "deleted_at", "config_hash", "custom_docker_run_options", "last_online_at", "enable_ssl", "restart_count", "last_restart_at", "last_restart_type", "public_port_timeout", "health_check_enabled", "health_check_interval", "health_check_timeout", "health_check_retries", "health_check_start_period", "redact_all_env_values_in_logs", "include_coolify_default_variables"],
  standalone_keydbs: ["id", "uuid", "name", "description", "keydb_password", "keydb_conf", "is_log_drain_enabled", "is_include_timestamps", "deleted_at", "status", "image", "is_public", "public_port", "ports_mappings", "limits_memory", "limits_memory_swap", "limits_memory_swappiness", "limits_memory_reservation", "limits_cpus", "limits_cpuset", "limits_cpu_shares", "started_at", "destination_type", "destination_id", "environment_id", "created_at", "updated_at", "config_hash", "custom_docker_run_options", "last_online_at", "enable_ssl", "restart_count", "last_restart_at", "last_restart_type", "public_port_timeout", "health_check_enabled", "health_check_interval", "health_check_timeout", "health_check_retries", "health_check_start_period", "legacy_password_quoting", "redact_all_env_values_in_logs", "include_coolify_default_variables"],
  standalone_dragonflies: ["id", "uuid", "name", "description", "dragonfly_password", "is_log_drain_enabled", "is_include_timestamps", "deleted_at", "status", "image", "is_public", "public_port", "ports_mappings", "limits_memory", "limits_memory_swap", "limits_memory_swappiness", "limits_memory_reservation", "limits_cpus", "limits_cpuset", "limits_cpu_shares", "started_at", "destination_type", "destination_id", "environment_id", "created_at", "updated_at", "config_hash", "custom_docker_run_options", "last_online_at", "enable_ssl", "restart_count", "last_restart_at", "last_restart_type", "public_port_timeout", "health_check_enabled", "health_check_interval", "health_check_timeout", "health_check_retries", "health_check_start_period", "legacy_password_quoting", "redact_all_env_values_in_logs", "include_coolify_default_variables"],
  standalone_clickhouses: ["id", "uuid", "name", "description", "clickhouse_admin_user", "clickhouse_admin_password", "is_log_drain_enabled", "is_include_timestamps", "deleted_at", "status", "image", "is_public", "public_port", "ports_mappings", "limits_memory", "limits_memory_swap", "limits_memory_swappiness", "limits_memory_reservation", "limits_cpus", "limits_cpuset", "limits_cpu_shares", "started_at", "destination_type", "destination_id", "environment_id", "created_at", "updated_at", "config_hash", "custom_docker_run_options", "last_online_at", "clickhouse_db", "restart_count", "last_restart_at", "last_restart_type", "public_port_timeout", "health_check_enabled", "health_check_interval", "health_check_timeout", "health_check_retries", "health_check_start_period", "redact_all_env_values_in_logs", "include_coolify_default_variables"],
  servers: [
    "id", "uuid", "name", "description", "ip", "port", "user", "team_id", "private_key_id", "proxy", "created_at",
    "updated_at", "unreachable_count", "high_disk_usage_notification_sent", "log_drain_notification_sent",
    "swarm_cluster", "validation_logs", "sentinel_updated_at", "deleted_at", "ip_previous", "hetzner_server_id",
    "cloud_provider_token_id", "hetzner_server_status", "is_validating", "detected_traefik_version",
    "traefik_outdated_info", "server_metadata", "vultr_instance_id", "vultr_instance_status", "digitalocean_droplet_id",
    "digitalocean_droplet_status", "hostinger_virtual_machine_id", "hostinger_virtual_machine_status",
    "sentinel_waiting_since", "proxy_error_page", "canvas_position",
  ],
  server_settings: [
    "id", "is_swarm_manager", "is_jump_server", "is_build_server", "is_reachable", "is_usable", "server_id",
    "created_at", "updated_at", "wildcard_domain", "is_cloudflare_tunnel", "is_logdrain_newrelic_enabled",
    "logdrain_newrelic_license_key", "logdrain_newrelic_base_uri", "is_logdrain_axiom_enabled",
    "logdrain_axiom_dataset_name", "logdrain_axiom_api_key", "is_swarm_worker", "is_logdrain_custom_enabled",
    "logdrain_custom_config", "logdrain_custom_config_parser", "concurrent_builds", "dynamic_timeout", "force_disabled",
    "is_metrics_enabled", "generate_exact_labels", "force_docker_cleanup", "docker_cleanup_frequency",
    "docker_cleanup_threshold", "server_timezone", "delete_unused_volumes", "delete_unused_networks",
    "is_sentinel_enabled", "sentinel_token", "sentinel_metrics_refresh_rate_seconds", "sentinel_metrics_history_days",
    "sentinel_push_interval_seconds", "sentinel_custom_url", "server_disk_usage_notification_threshold",
    "is_sentinel_debug_enabled", "server_disk_usage_check_frequency", "is_terminal_enabled", "deployment_queue_limit",
    "disable_application_image_retention", "connection_timeout", "is_traffic_analytics_enabled",
    "geoip_maxmind_license_key", "traffic_topn", "traffic_sample_threshold", "traffic_retention_1h_days",
    "traffic_retention_1d_days", "is_geoip_enabled", "geoip_refresh_days", "docker_version",
    "docker_version_checked_at", "compose_version", "compose_version_checked_at", "backup_compression_cpu_percentage",
    "server_role", "is_logdrain_cloudwatch_enabled", "logdrain_cloudwatch_region", "logdrain_cloudwatch_group",
    "logdrain_cloudwatch_stream_prefix", "server_disk_usage_notification_interval_hours", "traffic_ip_mode",
    "cloudflare_tunnel_id", "cloudflare_tunnel_account_id", "cloudflare_tunnel_integration_token_id",
    "traefik_certificate_resolver", "patch_check_frequency", "patch_check_result", "patch_check_error",
    "patch_checked_at", "is_auto_security_updates_enabled", "auto_security_updates_time", "logdrain_axiom_domain",
    "is_image_scan_enabled", "image_candidate_scans_today", "image_candidate_scans_date", "ssh_host_key",
    "ssh_host_key_source", "ssh_host_key_trusted_at", "ssh_host_key_pending", "is_ssh_host_key_check_disabled",
    "is_ssh_host_key_check_enforced", "image_scan_memory_mb", "image_scan_syft_timeout", "image_scan_grype_timeout",
    "image_scan_cpus", "public_ipv4", "public_ipv6",
  ],
  standalone_dockers: [
    "id", "name", "uuid", "network", "server_id", "created_at", "updated_at",
  ],
  application_settings: [
    "id", "is_static", "is_git_submodules_enabled", "is_git_lfs_enabled", "is_auto_deploy_enabled",
    "is_force_https_enabled", "is_debug_enabled", "is_preview_deployments_enabled", "application_id", "created_at",
    "updated_at", "is_log_drain_enabled", "is_gpu_enabled", "gpu_driver", "gpu_count", "gpu_device_ids", "gpu_options",
    "is_include_timestamps", "is_swarm_only_worker_nodes", "is_raw_compose_deployment_enabled",
    "is_build_server_enabled", "is_consistent_container_name_enabled", "is_gzip_enabled", "is_stripprefix_enabled",
    "connect_to_docker_network", "custom_internal_name", "is_container_label_escape_enabled", "is_env_sorting_enabled",
    "is_container_label_readonly_enabled", "is_preserve_repository_enabled", "disable_build_cache", "is_spa",
    "is_git_shallow_clone_enabled", "is_pr_deployments_public_enabled", "use_build_secrets", "stop_grace_period",
    "inject_build_args_to_dockerfile", "include_source_commit_in_build", "docker_images_to_keep",
    "custom_container_name_prefix", "redact_all_env_values_in_logs", "traefik_certificate_resolver",
    "include_coolify_default_variables", "is_permanent_redirect_enabled", "rolling_update_drain_seconds",
    "is_image_scan_enabled", "image_builds_by_team", "is_auto_cancel_queued_deployments_enabled",
    "is_auto_cancel_building_deployments_enabled", "include_network_hosts_in_build",
  ],
  applications: [
    "id", "repository_project_id", "uuid", "name", "fqdn", "config_hash", "git_repository", "git_branch",
    "git_commit_sha", "git_full_url", "docker_registry_image_name", "docker_registry_image_tag", "build_pack",
    "static_image", "install_command", "build_command", "start_command", "ports_exposes", "ports_mappings",
    "base_directory", "publish_directory", "health_check_path", "health_check_port", "health_check_host",
    "health_check_method", "health_check_return_code", "health_check_scheme", "health_check_response_text",
    "health_check_interval", "health_check_timeout", "health_check_retries", "health_check_start_period",
    "limits_memory", "limits_memory_swap", "limits_memory_swappiness", "limits_memory_reservation", "limits_cpus",
    "limits_cpuset", "limits_cpu_shares", "status", "preview_url_template", "destination_type", "destination_id",
    "source_type", "source_id", "private_key_id", "environment_id", "created_at", "updated_at", "description",
    "dockerfile", "health_check_enabled", "dockerfile_location", "custom_labels", "dockerfile_target_build",
    "manual_webhook_secret_github", "manual_webhook_secret_gitlab", "docker_compose_location", "docker_compose",
    "docker_compose_raw", "docker_compose_domains", "deleted_at", "docker_compose_custom_start_command",
    "docker_compose_custom_build_command", "swarm_replicas", "swarm_placement_constraints",
    "manual_webhook_secret_bitbucket", "custom_docker_run_options", "post_deployment_command",
    "post_deployment_command_container", "pre_deployment_command", "pre_deployment_command_container", "watch_paths",
    "custom_healthcheck_found", "manual_webhook_secret_gitea", "redirect", "compose_parsing_version", "last_online_at",
    "custom_nginx_configuration", "custom_network_aliases", "is_http_basic_auth_enabled", "http_basic_auth_username",
    "http_basic_auth_password", "restart_count", "last_restart_at", "last_restart_type", "health_check_type",
    "health_check_command", "max_restart_count", "noindex_domains", "domain_dns_statuses", "container_present",
    "restart_limit_reached", "domain_port_overrides", "is_maintenance_enabled", "maintenance_page",
    "http_basic_auth_hash_algorithm", "http_basic_auth_bcrypt_cost", "http_basic_auth_argon2id_memory_cost",
    "http_basic_auth_argon2id_time_cost", "git_https_username", "git_https_password", "docker_compose_image_overrides",
    "git_ssh_known_hosts",
  ],
  environment_variables: [
    "id", "key", "value", "is_preview", "created_at", "updated_at", "is_shown_once", "is_multiline", "version",
    "is_literal", "uuid", "order", "is_required", "is_shared", "resourceable_type", "resourceable_id", "is_runtime",
    "is_buildtime", "comment", "uses_legacy_escaping", "preserve_compose_null",
  ],
  application_deployment_queues: [
    "id", "application_id", "deployment_uuid", "pull_request_id", "force_rebuild", "commit", "status", "is_webhook",
    "created_at", "updated_at", "logs", "current_process_id", "restart_only", "git_type", "server_id",
    "application_name", "server_name", "deployment_url", "destination_id", "only_this_server", "rollback",
    "commit_message", "is_api", "build_server_id", "horizon_job_id", "horizon_job_worker", "finished_at",
    "docker_registry_image_tag", "configuration_hash", "configuration_snapshot", "configuration_diff",
    "parent_deployment_uuid", "scan_gate_result", "scan_gate_bypassed_by", "deploy_started_at", "is_mcp",
    "github_deployment_id", "github_deployment_state",
  ],
  // DP-73: a database's backup schedules (backup_configs) and their executions (latest_log, executions).
  scheduled_database_backups: [
    "id", "description", "uuid", "enabled", "save_s3", "frequency", "database_backup_retention_amount_locally",
    "database_type", "database_id", "s3_storage_id", "team_id", "created_at", "updated_at", "databases_to_backup",
    "dump_all", "database_backup_retention_days_locally", "database_backup_retention_max_storage_locally",
    "database_backup_retention_amount_s3", "database_backup_retention_days_s3", "database_backup_retention_max_storage_s3",
    "timeout", "disable_local_backup", "missing_backup_notification_days", "last_execution_at",
  ],
  scheduled_database_backup_executions: [
    "id", "uuid", "status", "message", "size", "filename", "scheduled_database_backup_id", "created_at", "updated_at",
    "database_name", "finished_at", "local_storage_deleted", "s3_storage_deleted", "s3_uploaded", "worker_host",
  ],
  // DP-74: a service's applications and databases (loaded relations), and the service's own columns.
  services: [
    "id", "uuid", "name", "environment_id", "created_at", "updated_at", "server_id", "description", "docker_compose_raw",
    "docker_compose", "destination_type", "destination_id", "deleted_at", "connect_to_docker_network", "config_hash",
    "service_type", "is_container_label_escape_enabled", "compose_parsing_version", "redact_all_env_values_in_logs",
    "is_maintenance_enabled", "maintenance_page", "include_coolify_default_variables",
  ],
  service_applications: [
    "id", "uuid", "name", "human_name", "description", "fqdn", "ports", "exposes", "status", "service_id", "created_at",
    "updated_at", "exclude_from_status", "required_fqdn", "image", "is_log_drain_enabled", "is_include_timestamps",
    "deleted_at", "is_gzip_enabled", "is_stripprefix_enabled", "last_online_at", "is_migrated", "noindex_domains",
    "domain_dns_statuses", "redirect", "is_force_https_enabled", "restart_count", "max_restart_count",
    "restart_limit_reached", "last_restart_at", "last_restart_type", "domain_port_overrides",
    "traefik_certificate_resolver", "is_permanent_redirect_enabled", "is_removed_from_compose",
  ],
  service_databases: [
    "id", "uuid", "name", "human_name", "description", "ports", "exposes", "status", "service_id", "created_at",
    "updated_at", "exclude_from_status", "image", "public_port", "is_public", "is_log_drain_enabled",
    "is_include_timestamps", "deleted_at", "is_gzip_enabled", "is_stripprefix_enabled", "last_online_at", "is_migrated",
    "custom_type", "public_port_timeout", "is_removed_from_compose",
  ],
  // DP-84: a resource's storages, which the API writes with response()->json() (unsorted)
  local_persistent_volumes: [
    "id", "name", "mount_path", "host_path", "container_id", "resource_type", "resource_id", "created_at", "updated_at",
    "is_preview_suffix_enabled", "uuid", "standalone_sqlite_id", "ignores_compose_driver_options",
  ],
  local_file_volumes: [
    "id", "uuid", "fs_path", "mount_path", "content", "resource_type", "resource_id", "created_at", "updated_at",
    "is_directory", "chown", "chmod", "is_based_on_git", "is_preview_suffix_enabled", "is_host_file", "variable_fs_path",
  ],
  // DP-88: an updated GitHub App (the loaded model, answered unsorted)
  github_apps: [
    "id", "uuid", "name", "organization", "api_url", "html_url", "custom_user", "custom_port", "app_id", "installation_id",
    "client_id", "client_secret", "webhook_secret", "is_system_wide", "is_public", "private_key_id", "team_id", "created_at",
    "updated_at", "contents", "metadata", "pull_requests", "administration", "organization_self_hosted_runners", "actions",
    "webhook_events", "runner_group_id", "deployments", "installation_account",
  ],
} as const satisfies Record<string, readonly string[]>;

export type CoolifyTable = keyof typeof COOLIFY_COLUMNS;

/** A Freeploy row in Coolify's column order; a column Coolify does not have (org_id is never read) is left out. */
export function inCoolifyOrder(row: ApiRow, table: CoolifyTable): ApiRow {
  const out: ApiRow = [];
  for (const column of COOLIFY_COLUMNS[table]) {
    const cell = row.find(([k]) => k === column);
    if (cell) out.push([column, cell[1]]);
  }
  return out;
}
