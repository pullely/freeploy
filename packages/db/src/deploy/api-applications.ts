// Derived from coollabsio/coolify@91b7e3e:app/Models/{Application,ApplicationSetting}.php ($fillable, the casts, the
// creating and created hooks) and app/Http/Controllers/Api/ApplicationsController.php (create_application:
// $application->fill($request->only($allowedFields)), $application->settings->…->save()) (Apache-2.0), modified.
//
// deploy.applications and deploy.application_settings writes of Coolify's /api/v1 application create (DP-87): the API
// fills the model with whatever columns the request names, so the rows are written column by column from a fixed list
// of the columns it may set (never a column name the request made up). Every function takes the transaction of
// withOrg(): row-level security confines each query to that org.
import type { SqlExecutor } from "../hyperdrive/executor.js";
import { APPLICATION_MORPH_CLASS, type NewApplicationVariable } from "./application-create.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/**
 * The columns of deploy.applications the API's create writes: Application's $fillable that are columns, and what the
 * controller and the hooks set beside them.
 */
export const API_APPLICATION_COLUMNS = [
  "uuid",
  "name",
  "description",
  "fqdn",
  "noindex_domains",
  "domain_port_overrides",
  "git_repository",
  "git_branch",
  "git_commit_sha",
  "git_https_username",
  "git_https_password",
  "docker_registry_image_name",
  "docker_registry_image_tag",
  "build_pack",
  "static_image",
  "install_command",
  "build_command",
  "start_command",
  "ports_exposes",
  "ports_mappings",
  "base_directory",
  "publish_directory",
  "health_check_enabled",
  "health_check_path",
  "health_check_port",
  "health_check_host",
  "health_check_method",
  "health_check_return_code",
  "health_check_scheme",
  "health_check_response_text",
  "health_check_interval",
  "health_check_timeout",
  "health_check_retries",
  "health_check_start_period",
  "health_check_type",
  "health_check_command",
  "limits_memory",
  "limits_memory_swap",
  "limits_memory_swappiness",
  "limits_memory_reservation",
  "limits_cpus",
  "limits_cpuset",
  "limits_cpu_shares",
  "preview_url_template",
  "dockerfile",
  "dockerfile_location",
  "dockerfile_target_build",
  "custom_labels",
  "custom_docker_run_options",
  "post_deployment_command",
  "post_deployment_command_container",
  "pre_deployment_command",
  "pre_deployment_command_container",
  "manual_webhook_secret_github",
  "manual_webhook_secret_gitlab",
  "manual_webhook_secret_bitbucket",
  "manual_webhook_secret_gitea",
  "docker_compose_location",
  "docker_compose_domains",
  "docker_compose_custom_start_command",
  "docker_compose_custom_build_command",
  "watch_paths",
  "redirect",
  "compose_parsing_version",
  "custom_nginx_configuration",
  "custom_network_aliases",
  "is_http_basic_auth_enabled",
  "http_basic_auth_username",
  "http_basic_auth_password",
  "http_basic_auth_hash_algorithm",
  "http_basic_auth_bcrypt_cost",
  "http_basic_auth_argon2id_memory_cost",
  "http_basic_auth_argon2id_time_cost",
  "max_restart_count",
  "environment_id",
  "destination_id",
  "destination_type",
  "source_id",
  "source_type",
  "repository_project_id",
  "private_key_id",
] as const;
export type ApiApplicationColumn = (typeof API_APPLICATION_COLUMNS)[number];
export type ApiColumnValue = string | number | boolean | null;
/** The JSON columns (the `array` casts): a JSON text or null. */
const JSON_COLUMNS: readonly string[] = ["noindex_domains", "domain_port_overrides"];

/** The columns of deploy.application_settings the API's create writes (APPLICATION_SETTING_FIELDS and the isset() ones). */
export const API_APPLICATION_SETTING_COLUMNS = [
  "is_static",
  "is_spa",
  "is_auto_deploy_enabled",
  "is_force_https_enabled",
  "is_preview_deployments_enabled",
  "connect_to_docker_network",
  "is_build_server_enabled",
  "use_build_secrets",
  "is_container_label_escape_enabled",
  "is_preserve_repository_enabled",
  "is_git_submodules_enabled",
  "is_git_lfs_enabled",
  "is_git_shallow_clone_enabled",
  "is_auto_cancel_queued_deployments_enabled",
  "is_auto_cancel_building_deployments_enabled",
  "disable_build_cache",
  "inject_build_args_to_dockerfile",
  "include_source_commit_in_build",
  "include_network_hosts_in_build",
  "is_env_sorting_enabled",
  "redact_all_env_values_in_logs",
  "include_coolify_default_variables",
  "is_pr_deployments_public_enabled",
  "stop_grace_period",
  "rolling_update_drain_seconds",
  "docker_images_to_keep",
  "is_gzip_enabled",
  "is_stripprefix_enabled",
  "is_permanent_redirect_enabled",
  "traefik_certificate_resolver",
  "is_container_label_readonly_enabled",
  "is_raw_compose_deployment_enabled",
  "is_log_drain_enabled",
  "is_gpu_enabled",
  "gpu_driver",
  "gpu_count",
  "gpu_device_ids",
  "gpu_options",
  "is_consistent_container_name_enabled",
  "custom_internal_name",
  "custom_container_name_prefix",
  "is_image_scan_enabled",
] as const;
export type ApiApplicationSettingColumn = (typeof API_APPLICATION_SETTING_COLUMNS)[number];

const known = (list: readonly string[], values: Record<string, ApiColumnValue>): string[] => Object.keys(values).filter((c) => list.includes(c));
const placeholder = (column: string, i: number): string => `$${i}${JSON_COLUMNS.includes(column) ? "::json" : ""}`;

/**
 * $application->save() of a new application (the columns given, the rest the schema's defaults), then the created
 * hook's settings row and default variables. Answers the new application's id.
 */
export async function insertApiApplication(
  tx: SqlExecutor,
  orgId: string,
  values: Partial<Record<ApiApplicationColumn, ApiColumnValue>>,
  variables: NewApplicationVariable[],
): Promise<string | number> {
  const columns = known(API_APPLICATION_COLUMNS, values as Record<string, ApiColumnValue>);
  const inserted = await tx.execute<{ id: string | number }>(
    `INSERT INTO deploy.applications (${columns.map((c) => `"${c}"`).join(", ")}, org_id, created_at, updated_at)
     VALUES (${columns.map((c, i) => placeholder(c, i + 1)).join(", ")}, $${columns.length + 1}, ${NOW}, ${NOW})
     RETURNING id`,
    [...columns.map((c) => (values as Record<string, ApiColumnValue>)[c]), orgId],
  );
  const id = inserted.rows[0]!.id;
  await tx.execute(`INSERT INTO deploy.application_settings (application_id, org_id, created_at, updated_at) VALUES ($1, $2, ${NOW}, ${NOW})`, [id, orgId]);
  for (const variable of variables) {
    await tx.execute(
      `INSERT INTO deploy.environment_variables
         (uuid, key, value, is_multiline, is_literal, is_buildtime, is_runtime, is_preview, version, resourceable_type, resourceable_id, org_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, ${NOW}, ${NOW})`,
      [variable.uuid, variable.key, variable.value, variable.isMultiline, variable.isLiteral, variable.isBuildtime, variable.isRuntime, variable.isPreview, variable.version, APPLICATION_MORPH_CLASS, id, orgId],
    );
  }
  return id;
}

/** $application->save() of the given columns (the dirty ones), and updated_at. */
export async function updateApiApplication(tx: SqlExecutor, id: string | number, values: Partial<Record<ApiApplicationColumn, ApiColumnValue>>): Promise<void> {
  const columns = known(API_APPLICATION_COLUMNS, values as Record<string, ApiColumnValue>);
  if (columns.length === 0) return;
  await tx.execute(`UPDATE deploy.applications SET ${columns.map((c, i) => `"${c}" = ${placeholder(c, i + 2)}`).join(", ")}, updated_at = ${NOW} WHERE id = $1`, [
    id,
    ...columns.map((c) => (values as Record<string, ApiColumnValue>)[c]),
  ]);
}

/** $application->settings->fill(…)->save(): the given settings columns, and updated_at. */
export async function updateApiApplicationSettings(tx: SqlExecutor, applicationId: string | number, values: Partial<Record<ApiApplicationSettingColumn, ApiColumnValue>>): Promise<void> {
  const columns = known(API_APPLICATION_SETTING_COLUMNS, values as Record<string, ApiColumnValue>);
  if (columns.length === 0) return;
  await tx.execute(`UPDATE deploy.application_settings SET ${columns.map((c, i) => `"${c}" = $${i + 2}`).join(", ")}, updated_at = ${NOW} WHERE application_id = $1`, [
    applicationId,
    ...columns.map((c) => (values as Record<string, ApiColumnValue>)[c]),
  ]);
}

/** The settings row as the label generator and the API's checks read it. */
export async function findApiApplicationSettings(tx: SqlExecutor, applicationId: string | number): Promise<{ is_container_label_readonly_enabled: boolean } | null> {
  const r = await tx.execute<{ is_container_label_readonly_enabled: boolean }>("SELECT is_container_label_readonly_enabled FROM deploy.application_settings WHERE application_id = $1", [applicationId]);
  return r.rows[0] ?? null;
}
