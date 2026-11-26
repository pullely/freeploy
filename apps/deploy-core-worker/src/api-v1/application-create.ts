// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/ApplicationsController.php (create_public_application,
// create_private_deploy_key_application, create_dockerfile_application, create_dockerimage_application, create_application,
// applicationSettingsFromRequest, containerNamePrefixValidationResponse, customInternalNameValidationResponse,
// sharedImageNameValidationResponse, applyApplicationSettings, extraApplicationFieldMessage, validateDataApplications,
// normalizeDockerComposeDomainPorts), app/Http/Controllers/Api/Concerns/HandlesTagsApi.php (validateTagsParameter,
// attachTagsToResource), bootstrap/helpers/shared.php (sharedDataApplications, removeUnnecessaryFieldsFromRequest,
// customApiValidator, generate_application_name, generateUrl, isBase64Encoded), bootstrap/helpers/docker.php
// (get_port_from_dockerfile), app/Rules/{ValidGitBranch,ValidGitRepositoryUrl,DockerImageFormat,ManualWebhookSecret}.php,
// app/Support/ValidationPatterns.php and app/Models/{Application,ApplicationSetting}.php ($fillable, the mutators, the
// creating, created and saving hooks, isStatic, otherApplicationBuildingSameImage) (Apache-2.0), modified.
//
// Coolify's /api/v1 application create (DP-87), for four of its types:
//
//   POST /applications/dockerimage           create_application('dockerimage')
//   POST /applications/dockerfile            create_application('dockerfile')
//   POST /applications/public                create_application('public')
//   POST /applications/private-deploy-key    create_application('private-deploy-key')
//
// The checks, their order and their messages are the controller's; the application is stored as `fill()` and the model's
// hooks store it (the mutators, the webhook secrets, the settings row, Nixpacks' NIXPACKS_NODE_VERSION, the domain's port
// overrides), its settings as the controller sets them, then its labels as generateLabelsApplication() makes them.
// Where Coolify then queues work on the server — an instant deploy, LoadComposeFile for a Docker Compose application —
// Freeploy answers 501 in Coolify's envelope after the checks and before anything is stored (DP-73's convention).
// Not ported: private-github-app (it asks GitHub for an installation token and the repository) and private-gitea-app.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  APPLICATION_MORPH_CLASS,
  DESTINATION_MORPH_CLASS,
  findApplicationLabelSource,
  findOtherApplicationBuildingImage,
  insertApiApplication,
  listServerDestinations,
  listServerApplicationContainerNames,
  updateApiApplication,
  updateApiApplicationSettings,
  type ApiApplicationColumn,
  type ApiApplicationSettingColumn,
  type ApiColumnValue,
  type ApiRow,
  type NewApplicationVariable,
} from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, fromJs, obj, phpJsonEncode, serializeApiResponse, type CoolifyAnswer, type PhpValue } from "@saas/contracts/coolify-api";
import { columnCipher } from "../handlers/cloud-tokens.js";
import { ENVIRONMENT_VARIABLE_VERSION } from "../environment-variables/service.js";
import { applicationDomainList, domainWithoutPort, generateUrl, isValidDomainUrl, normalizeApplicationDomains, normalizeDomainPortOverrides, parseUrl, syncNoindexDomains, validateApplicationDomains } from "../applications/domains.js";
import { generateApplicationName, gitBranchError, gitRepositoryUrlError, phpTrim, sshGitUrlToHttps } from "../applications/git.js";
import { fullImageNameWithoutTag, parseDockerImage } from "../applications/docker-image.js";
import { CONTAINER_NAME_PATTERN, DOCKER_IMAGE_NAME_PATTERN, DOCKER_IMAGE_TAG_PATTERN, PORT_MAPPINGS_PATTERN, PORTS_EXPOSES_PATTERN, SHELL_SAFE_COMMAND_PATTERN } from "../applications/validation.js";
import { DIRECTORY_PATH_PATTERN, FILE_PATH_PATTERN } from "../applications/create.js";
import { DOCKER_TARGET_PATTERN, watchPathsForStorage } from "../applications/build.js";
import { getPortFromDockerfile } from "../applications/dockerfile.js";
import {
  GPU_COUNT_PATTERN,
  HEALTH_CHECK_COMMAND_PATTERN,
  HEALTH_CHECK_PATH_PATTERN,
  MAX_CONTAINER_NAME_PREFIX_LENGTH,
  MAX_ROLLING_UPDATE_DRAIN_SECONDS,
  MAX_STOP_GRACE_PERIOD_SECONDS,
  MIN_STOP_GRACE_PERIOD_SECONDS,
  TRAEFIK_CERTIFICATE_RESOLVER_PATTERN,
  isValidHealthCheckHost,
  parseGpuOptions,
  slug,
} from "../applications/settings-validation.js";
import { networkAliasesForStorage } from "../applications/service.js";
import { stripTags } from "../applications/tags.js";
import { labelApplication } from "../applications/labels-service.js";
import { caddySupportsArgon2idBasicAuth, generateLabelsApplication, DEFAULT_LABEL_DEPENDENCIES, type LabelDependencies } from "../labels/labels.js";
import { decodeBase64EncodedLabels, isBase64Encoded } from "../labels/custom-labels.js";
import { validateDockerComposeForInjection } from "../services/compose-validation.js";
import { effectiveServerRole } from "../servers/service.js";
import { needsExecutor } from "../applications/resources.js";
import { newPublicId, randomString } from "../helpers/names.js";
import { attachTagTo, normalizeTags } from "./databases.js";
import { domainConflicts } from "./services.js";
import type { ServiceStore } from "../services/store.js";
import { hasDeployAbility, message, rowsOf, unavailable, type ApiV1Context } from "./context.js";
import { rowValue } from "./models.js";
import { addError, descriptionRules, nameRules, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rule, type Rules } from "./rules.js";

export type CreateType = "public" | "private-deploy-key" | "dockerfile" | "dockerimage";
/** The path segment after /applications of each type this file answers. */
export const CREATE_TYPES: Record<string, CreateType> = { public: "public", "private-deploy-key": "private-deploy-key", dockerfile: "dockerfile", dockerimage: "dockerimage" };

export const APPLICATION_CREATE_MESSAGES = {
  /** Freeploy's: queue_application_deployment() runs the deployment on the server. */
  deployUnavailable: needsExecutor("Deploying the application"),
  /** Freeploy's: LoadComposeFile reads the Docker Compose file from the repository on the server. */
  composeUnavailable: needsExecutor("Loading the Docker Compose file of the application"),
  /** ResourceCreatePolicy::useTeamCredentials()'s denial. */
  teamCredentials: "You need write access on the whole team to use team credentials, such as private keys, git sources, and S3 storages.",
  /** Application::sharedImageNameMessage(), Coolify's words. */
  sharedImageName: (other: string, image: string): string =>
    `The application ${other} also builds the Docker image ${image}. ` +
    "Coolify tags each build with the commit SHA (latest for a Dockerfile set in Coolify, pr-<id>-<commit> for previews) and pushes the Docker image tag only in addition. " +
    "A different Docker image tag does not keep the images apart, so one application can run the image of the other. " +
    `Set a different Docker image name for each application in the General settings, for example ${image}-staging.`,
} as const;

export const ABORT_DEPLOY: CoolifyAnswer = { status: 403, body: '{\n    "message": "Missing required permissions: deploy"\n}', headers: { "content-type": "application/json" } };
const CONFLICT_WARNING = "Using the same domain for multiple resources can cause routing conflicts and unpredictable behavior.";
const COMPOSE_ITEM_MESSAGE = "An item in the docker_compose_domains array has invalid fields. Only name, domain, and redirect fields are supported.";

/** APPLICATION_SETTING_FIELDS */
export const APPLICATION_SETTING_FIELDS = [
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
/** BOOLEAN_APPLICATION_SETTING_FIELDS */
const NOT_BOOLEAN_SETTINGS: readonly string[] = ["stop_grace_period", "rolling_update_drain_seconds", "docker_images_to_keep", "traefik_certificate_resolver", "gpu_driver", "gpu_count", "gpu_device_ids", "gpu_options", "custom_internal_name", "custom_container_name_prefix"];

/** create_application()'s $allowedFields, in its order (Request::only() fills the model in this order). */
const ALLOWED_FIELDS: readonly string[] = [
  "project_uuid", "environment_name", "environment_uuid", "server_uuid", "destination_uuid", "type", "name", "description", "is_static", "is_spa",
  "is_auto_deploy_enabled", "is_force_https_enabled", "is_preview_deployments_enabled", "domains", "noindex_domains", "git_repository", "git_branch",
  "git_commit_sha", "git_https_username", "git_https_password", "private_key_uuid", "docker_registry_image_name", "docker_registry_image_tag",
  "build_pack", "install_command", "build_command", "start_command", "ports_exposes", "ports_mappings", "custom_network_aliases", "base_directory",
  "publish_directory", "health_check_enabled", "health_check_type", "health_check_command", "health_check_path", "health_check_port",
  "health_check_host", "health_check_method", "health_check_return_code", "health_check_scheme", "health_check_response_text",
  "health_check_interval", "health_check_timeout", "health_check_retries", "health_check_start_period", "limits_memory", "limits_memory_swap",
  "limits_memory_swappiness", "limits_memory_reservation", "limits_cpus", "limits_cpuset", "limits_cpu_shares", "custom_labels",
  "custom_docker_run_options", "post_deployment_command", "post_deployment_command_container", "pre_deployment_command",
  "pre_deployment_command_container", "manual_webhook_secret_github", "manual_webhook_secret_gitlab", "manual_webhook_secret_bitbucket",
  "manual_webhook_secret_gitea", "redirect", "github_app_uuid", "gitea_app_uuid", "instant_deploy", "dockerfile", "dockerfile_location",
  "dockerfile_target_build", "docker_compose_location", "docker_compose_raw", "docker_compose_custom_start_command",
  "docker_compose_custom_build_command", "docker_compose_domains", "watch_paths", "use_build_server", "use_build_secrets", "static_image",
  "custom_nginx_configuration", "is_http_basic_auth_enabled", "http_basic_auth_username", "http_basic_auth_password",
  "http_basic_auth_hash_algorithm", "http_basic_auth_bcrypt_cost", "http_basic_auth_argon2id_memory_cost", "http_basic_auth_argon2id_time_cost",
  "connect_to_docker_network", "force_domain_override", "autogenerate_domain", "is_container_label_escape_enabled", "tags",
  "is_preserve_repository_enabled", "preview_url_template", "max_restart_count", ...APPLICATION_SETTING_FIELDS,
];

/** removeUnnecessaryFieldsFromRequest() */
export const REMOVED_FIELDS: readonly string[] = [
  "project_uuid", "environment_name", "environment_uuid", "destination_uuid", "server_uuid", "type", "domains", "instant_deploy", "github_app_uuid",
  "gitea_app_uuid", "private_key_uuid", "use_build_server", "use_build_secrets", "is_static", "is_spa", "is_auto_deploy_enabled",
  "is_force_https_enabled", "is_preview_deployments_enabled", "connect_to_docker_network", "force_domain_override", "autogenerate_domain",
  "is_container_label_escape_enabled", "is_preserve_repository_enabled", "include_source_commit_in_build", "include_network_hosts_in_build",
  "is_git_submodules_enabled", "is_git_lfs_enabled", "is_git_shallow_clone_enabled", "is_auto_cancel_queued_deployments_enabled",
  "is_auto_cancel_building_deployments_enabled", "disable_build_cache", "inject_build_args_to_dockerfile", "is_env_sorting_enabled",
  "redact_all_env_values_in_logs", "include_coolify_default_variables", "is_pr_deployments_public_enabled", "stop_grace_period",
  "rolling_update_drain_seconds", "docker_images_to_keep", "is_gzip_enabled", "is_stripprefix_enabled", "is_permanent_redirect_enabled",
  "traefik_certificate_resolver", "is_container_label_readonly_enabled", "is_raw_compose_deployment_enabled", "is_log_drain_enabled",
  "is_gpu_enabled", "gpu_driver", "gpu_count", "gpu_device_ids", "gpu_options", "is_consistent_container_name_enabled", "is_image_scan_enabled",
  "custom_internal_name", "custom_container_name_prefix", "docker_compose_raw", "tags",
];

/** Application's $fillable that are columns of deploy.applications (fill() drops the rest silently). */
const FILLABLE_COLUMNS: readonly string[] = [
  "name", "description", "fqdn", "noindex_domains", "domain_port_overrides", "git_repository", "git_branch", "git_commit_sha", "git_https_username",
  "git_https_password", "docker_registry_image_name", "docker_registry_image_tag", "build_pack", "static_image", "install_command", "build_command",
  "start_command", "ports_exposes", "ports_mappings", "base_directory", "publish_directory", "health_check_enabled", "health_check_path",
  "health_check_port", "health_check_host", "health_check_method", "health_check_return_code", "health_check_scheme", "health_check_response_text",
  "health_check_interval", "health_check_timeout", "health_check_retries", "health_check_start_period", "health_check_type", "health_check_command",
  "limits_memory", "limits_memory_swap", "limits_memory_swappiness", "limits_memory_reservation", "limits_cpus", "limits_cpuset", "limits_cpu_shares",
  "preview_url_template", "dockerfile", "dockerfile_location", "dockerfile_target_build", "custom_labels", "custom_docker_run_options",
  "post_deployment_command", "post_deployment_command_container", "pre_deployment_command", "pre_deployment_command_container",
  "manual_webhook_secret_github", "manual_webhook_secret_gitlab", "manual_webhook_secret_bitbucket", "manual_webhook_secret_gitea",
  "docker_compose_location", "docker_compose_domains", "docker_compose_custom_start_command", "docker_compose_custom_build_command", "watch_paths",
  "redirect", "custom_nginx_configuration", "custom_network_aliases", "is_http_basic_auth_enabled", "http_basic_auth_username",
  "http_basic_auth_password", "http_basic_auth_hash_algorithm", "http_basic_auth_bcrypt_cost", "http_basic_auth_argon2id_memory_cost",
  "http_basic_auth_argon2id_time_cost", "max_restart_count",
];

/** The `encrypted` casts among them. */
export const ENCRYPTED: readonly string[] = ["http_basic_auth_password", "git_https_password", "manual_webhook_secret_github", "manual_webhook_secret_gitlab", "manual_webhook_secret_bitbucket", "manual_webhook_secret_gitea"];
export const WEBHOOK_SECRETS = ["manual_webhook_secret_github", "manual_webhook_secret_gitlab", "manual_webhook_secret_bitbucket", "manual_webhook_secret_gitea"] as const;
/** The saving hook trims these when they are dirty: str($value)->trim(), null as "". */
const TRIMMED_ON_SAVE: readonly string[] = ["install_command", "build_command", "start_command", "base_directory", "publish_directory", "git_repository", "git_branch", "git_commit_sha"];

// ── PHP's helpers ───────────────────────────────────────────────────────────

/** PHP's truthiness of a request value. */
export const truthy = (v: unknown): boolean => !(v === undefined || v === null || v === false || v === 0 || v === "" || v === "0" || (Array.isArray(v) && v.length === 0));
/** blank() */
export const blank = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
export const has = (all: Record<string, unknown>, key: string): boolean => Object.hasOwn(all, key);
export const isset = (v: unknown): boolean => v !== undefined && v !== null;
/** $request->boolean($key, $default): filter_var(…, FILTER_VALIDATE_BOOLEAN) of the value, the default only when the key is absent. */
export function requestBool(all: Record<string, unknown>, key: string, fallback = false): boolean {
  if (!has(all, key)) return fallback;
  const v = all[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  return typeof v === "string" && ["1", "true", "on", "yes"].includes(v.trim().toLowerCase());
}
/** mb_strlen() */
export const mbLength = (s: string): number => [...s].length;

/** base64_decode($value) of a string isBase64Encoded() accepts, as UTF-8 text; null when it is not UTF-8 (mb_detect_encoding()). */
export function decodeBase64Utf8(value: string): string | null {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}
/** base64_encode() of a text's UTF-8 bytes. */
const base64Utf8 = (text: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
/** isBase64Encoded() of a request value: a string whose strict decoding encodes back to it. */
export const base64Value = (v: unknown): boolean => typeof v === "string" && isBase64Encoded(v);

// ── the rules ───────────────────────────────────────────────────────────────

/** A rule object whose message names the attribute as Laravel displays it. */
const named = (attribute: string): string => attribute.replace(/_/g, " ");
const ruleObject = (attribute: string, check: (value: unknown, display: string) => string | null): Rule => ({
  closure: (value) => {
    const failed = check(value, named(attribute));
    return failed === null ? [] : [failed];
  },
});
/** ValidGitBranch (a value that is not a string is PHP's TypeError; the API answers 500). */
export const validGitBranch = (attribute: string): Rule =>
  ruleObject(attribute, (value, display) => {
    if (value !== null && value !== undefined && typeof value === "object") throw new TypeError("ValidGitBranch: trim() of an array");
    return gitBranchError(display, typeof value === "number" ? String(value) : value);
  });
export const validGitRepositoryUrl = (attribute: string, allowRepositoryPath = false): Rule => ruleObject(attribute, (value, display) => gitRepositoryUrlError(display, value, allowRepositoryPath));
/** DockerImageFormat(allowVariableTag) */
const dockerImageFormat = (attribute: string, allowVariableTag: boolean): Rule =>
  ruleObject(attribute, (value, display) => {
    const invalid = `The ${display} format is invalid. Use image:tag or image@sha256:hash format.`;
    if (typeof value !== "string") return invalid;
    if (/:sha256?:/i.test(value)) return `The ${display} must use @ before sha256 digest (e.g., image@sha256:hash, not image:sha256:hash).`;
    let imageName = value;
    let tag: string | null = null;
    const digest = value.match(/^(.+)@sha256:([a-f0-9]{64})$/i);
    if (digest) imageName = digest[1]!;
    else {
      const lastSlash = value.lastIndexOf("/");
      const tagColon = value.indexOf(":", lastSlash === -1 ? 0 : lastSlash + 1);
      if (tagColon !== -1) {
        imageName = value.slice(0, tagColon);
        tag = value.slice(tagColon + 1);
      }
    }
    const nameOk = blank(imageName) || DOCKER_IMAGE_NAME_PATTERN.test(imageName);
    const tagOk = blank(tag) || (allowVariableTag ? DOCKER_IMAGE_TAG_PATTERN : /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/).test(tag!);
    return nameOk && tagOk ? null : invalid;
  });
/** ManualWebhookSecret: a value that is the current one passes (hash_equals()); none on a create. */
const manualWebhookSecret = (attribute: string, current: string | null): Rule =>
  ruleObject(attribute, (value, display) => {
    if (value === null || value === "") return null;
    if (typeof value !== "string") return `The ${display} must be a string.`;
    if (current !== null && current === value) return null;
    return mbLength(value) < 16 ? `The ${display} must be at least 16 characters.` : null;
  });
export const enumRule = (values: readonly string[]): Rule => ({ in: values });
const shellSafe = (max = 1000): Rule[] => ["nullable", "string", `max:${max}`, { regex: SHELL_SAFE_COMMAND_PATTERN }];
const containerName: Rule[] = ["string", "max:255", { regex: CONTAINER_NAME_PATTERN }];
const filePath: Rule[] = ["nullable", "string", "max:255", { regex: FILE_PATH_PATTERN }];
const directoryPath: Rule[] = ["nullable", "string", "max:255", { regex: DIRECTORY_PATH_PATTERN }];
export const DOMAIN_RULES: Rule[] = ["nullable", "string", "max:2048", { closure: (v) => validateApplicationDomains(v) }];
const BUILD_PACKS = ["nixpacks", "static", "dockerfile", "dockercompose", "railpack"];

/** sharedDataApplications($application): the application's current webhook secrets pass ManualWebhookSecret. */
export function sharedDataApplications(current: Partial<Record<(typeof WEBHOOK_SECRETS)[number], string | null>> = {}): Rules {
  const bool = (field: string): [string, Rule[]] => [field, ["boolean"]];
  return [
    ["git_repository", ["string"]],
    ["git_branch", ["string", validGitBranch("git_branch")]],
    ["git_https_username", ["string", "nullable", "max:255", { regex: /^[^:\r\n]*$/ }]],
    ["git_https_password", ["string", "nullable", "max:2048", { regex: /^[^\r\n]*$/ }]],
    ["build_pack", [enumRule(BUILD_PACKS)]],
    ...[
      "is_static", "is_spa", "is_auto_deploy_enabled", "is_force_https_enabled", "is_preview_deployments_enabled", "use_build_secrets",
      "is_git_submodules_enabled", "is_git_lfs_enabled", "is_git_shallow_clone_enabled", "is_auto_cancel_queued_deployments_enabled",
      "is_auto_cancel_building_deployments_enabled", "disable_build_cache", "inject_build_args_to_dockerfile", "include_source_commit_in_build",
      "include_network_hosts_in_build", "is_env_sorting_enabled", "redact_all_env_values_in_logs", "include_coolify_default_variables",
      "is_pr_deployments_public_enabled", "is_gzip_enabled", "is_stripprefix_enabled", "is_permanent_redirect_enabled",
    ].map(bool),
    ["traefik_certificate_resolver", ["nullable", "string", "max:255", { regex: TRAEFIK_CERTIFICATE_RESOLVER_PATTERN }]],
    ...["is_container_label_readonly_enabled", "is_raw_compose_deployment_enabled", "is_log_drain_enabled", "is_gpu_enabled"].map(bool),
    ["gpu_driver", ["string", "nullable"]],
    ["gpu_count", ["string", "nullable", { regex: GPU_COUNT_PATTERN }]],
    ["gpu_device_ids", ["string", "nullable"]],
    ["gpu_options", ["string", "nullable", { closure: (v) => (parseGpuOptions(typeof v === "string" ? v : String(v)) === null ? ["The gpu_options must be key=value pairs or a YAML mapping."] : []) }]],
    bool("is_consistent_container_name_enabled"),
    bool("is_image_scan_enabled"),
    ["custom_internal_name", ["nullable", ...containerName]],
    ["custom_container_name_prefix", ["string", "nullable", `max:${MAX_CONTAINER_NAME_PREFIX_LENGTH}`]],
    ["preview_url_template", ["string"]],
    ["max_restart_count", ["integer", "min:0"]],
    ["stop_grace_period", ["nullable", "integer", `min:${MIN_STOP_GRACE_PERIOD_SECONDS}`, `max:${MAX_STOP_GRACE_PERIOD_SECONDS}`]],
    ["rolling_update_drain_seconds", ["integer", "min:0", `max:${MAX_ROLLING_UPDATE_DRAIN_SECONDS}`]],
    ["docker_images_to_keep", ["integer", "min:0", "max:100"]],
    ["static_image", [enumRule(["nginx:alpine"])]],
    ["domains", DOMAIN_RULES],
    ["noindex_domains", ["array", "nullable"]],
    ["noindex_domains.*", ["string"]],
    ["redirect", [enumRule(["both", "www", "non-www"])]],
    ["git_commit_sha", ["string", { regex: /^[a-zA-Z0-9][a-zA-Z0-9._\-/]*$/ }]],
    ["docker_registry_image_name", ["nullable", "string", "max:255", { regex: DOCKER_IMAGE_NAME_PATTERN }]],
    ["docker_registry_image_tag", ["nullable", "string", "max:128", { regex: DOCKER_IMAGE_TAG_PATTERN }]],
    ["install_command", shellSafe()],
    ["build_command", shellSafe()],
    ["start_command", shellSafe()],
    ["ports_exposes", ["string", { regex: PORTS_EXPOSES_PATTERN }]],
    ["ports_mappings", ["nullable", "string", { regex: PORT_MAPPINGS_PATTERN }]],
    ["custom_network_aliases", ["string", "nullable"]],
    ["base_directory", directoryPath],
    ["publish_directory", directoryPath],
    bool("health_check_enabled"),
    ["health_check_type", ["string", enumRule(["http", "cmd"])]],
    ["health_check_command", ["nullable", "string", "max:1000", { regex: HEALTH_CHECK_COMMAND_PATTERN }]],
    ["health_check_path", ["string", { regex: HEALTH_CHECK_PATH_PATTERN }]],
    ["health_check_port", ["integer", "nullable", "min:1", "max:65535"]],
    ["health_check_host", ["string", { closure: (v) => (isValidHealthCheckHost(v) ? [] : ["The health check host must be a hostname or an IP address."]) }]],
    ["health_check_method", ["string", enumRule(["GET", "HEAD", "POST", "OPTIONS"])]],
    ["health_check_return_code", ["integer", "between:100,599"]],
    ["health_check_scheme", ["string", enumRule(["http", "https"])]],
    ["health_check_response_text", ["string", "nullable", "max:255", { notRegex: /[\x00-\x1F\x7F]/ }]],
    ["health_check_interval", ["numeric"]],
    ["health_check_timeout", ["numeric"]],
    ["health_check_retries", ["numeric"]],
    ["health_check_start_period", ["numeric"]],
    ["limits_memory", ["string"]],
    ["limits_memory_swap", ["string"]],
    ["limits_memory_swappiness", ["numeric"]],
    ["limits_memory_reservation", ["string"]],
    ["limits_cpus", ["string"]],
    ["limits_cpuset", ["string", "nullable"]],
    ["limits_cpu_shares", ["numeric"]],
    ["custom_labels", ["string", "nullable"]],
    ["custom_docker_run_options", shellSafe(2000)],
    ["post_deployment_command", ["string", "nullable"]],
    ["post_deployment_command_container", containerName],
    ["pre_deployment_command", ["string", "nullable"]],
    ["pre_deployment_command_container", containerName],
    ...WEBHOOK_SECRETS.map((field): [string, Rule[]] => [field, ["nullable", "string", manualWebhookSecret(field, current[field] ?? null)]]),
    ["dockerfile_location", filePath],
    ["dockerfile_target_build", ["nullable", "string", "max:128", { regex: DOCKER_TARGET_PATTERN }]],
    ["docker_compose_location", filePath],
    ["docker_compose", ["string", "nullable"]],
    ["docker_compose_domains", ["array", "nullable"]],
    ["docker_compose_custom_start_command", shellSafe()],
    ["docker_compose_custom_build_command", shellSafe()],
    bool("is_container_label_escape_enabled"),
    bool("is_preserve_repository_enabled"),
    ["http_basic_auth_hash_algorithm", [enumRule(["bcrypt", "argon2id"])]],
    ["http_basic_auth_bcrypt_cost", ["integer", "min:4", "max:14"]],
    ["http_basic_auth_argon2id_memory_cost", ["integer", "min:8192", "max:262144"]],
    ["http_basic_auth_argon2id_time_cost", ["integer", "min:1", "max:12"]],
  ];
}

/** array_merge($shared, $own): a key already there keeps its place, a new one goes last. */
export function mergeRules(shared: Rules, own: Rules): Rules {
  const out: Rules = shared.map(([k, v]) => [k, v]);
  for (const [k, v] of own) {
    const at = out.findIndex(([x]) => x === k);
    if (at === -1) out.push([k, v]);
    else out[at] = [k, v];
  }
  return out;
}

/** The rules of docker_compose_domains the Git types add. */
export const COMPOSE_DOMAIN_RULES: Rules = [
  ["docker_compose_domains", ["array", "nullable"]],
  ["docker_compose_domains.*", [{ arrayKeys: ["name", "domain", "redirect"], message: COMPOSE_ITEM_MESSAGE }]],
  ["docker_compose_domains.*.name", ["string", "required"]],
  ["docker_compose_domains.*.domain", DOMAIN_RULES],
  ["docker_compose_domains.*.redirect", ["nullable", "string", { in: ["www", "non-www", "both"] }]],
];

export const stringError = (field: string, text: string): CoolifyAnswer => coolifyJson(obj({ message: "Validation failed.", errors: obj({ [field]: text }) }), 422);
export const conflictAnswer = (conflicts: PhpValue[]): CoolifyAnswer => coolifyJson(obj({ message: "Domain conflicts detected. Use force_domain_override=true to proceed.", conflicts, warning: CONFLICT_WARNING }), 409);
export const NO_MEMORY = { service: { uuid: "", name: "" }, applications: () => [] } as unknown as ServiceStore;

// ── the request ─────────────────────────────────────────────────────────────

/** applicationSettingsFromRequest() */
export function applicationSettingsFromRequest(all: Record<string, unknown>): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const field of APPLICATION_SETTING_FIELDS) {
    if (!has(all, field)) continue;
    settings[field] = NOT_BOOLEAN_SETTINGS.includes(field) ? all[field] : requestBool(all, field);
  }
  const prefix = settings.custom_container_name_prefix;
  if (has(settings, "custom_container_name_prefix") && (prefix === null || ["string", "number", "boolean"].includes(typeof prefix))) {
    const slugged = slug(prefix === null ? "" : prefix === true ? "1" : prefix === false ? "" : String(prefix));
    settings.custom_container_name_prefix = slugged === "" || slugged === "0" ? null : slugged;
  }
  // A name sent alone turns on consistent container naming.
  if (!blank(settings.custom_internal_name) && !has(settings, "is_consistent_container_name_enabled")) settings.is_consistent_container_name_enabled = true;
  return settings;
}

/** The server as the create reads it: its row, its settings and its proxy. */
export interface ServerRow {
  id: string | number;
  ip: string;
  role: string;
  proxy: Record<string, unknown> | null;
  wildcardDomain: string | null;
}

export function serverOf(server: ApiRow, settings: ApiRow | undefined): ServerRow {
  let proxy = rowValue(server, "proxy") as unknown;
  if (typeof proxy === "string") {
    try {
      proxy = JSON.parse(proxy) as unknown;
    } catch {
      proxy = null;
    }
  }
  return {
    id: rowValue(server, "id") as string | number,
    ip: String(rowValue(server, "ip")),
    role: effectiveServerRole({ server_role: (settings ? rowValue(settings, "server_role") : null) as never, is_build_server: (settings ? rowValue(settings, "is_build_server") : false) as boolean }),
    proxy: proxy !== null && typeof proxy === "object" && !Array.isArray(proxy) ? (proxy as Record<string, unknown>) : null,
    wildcardDomain: settings ? ((rowValue(settings, "wildcard_domain") as string | null) ?? null) : null,
  };
}

/** Server::isProxyShouldRun() */
export const proxyShouldRun = (s: ServerRow): boolean => s.proxy?.type !== "NONE" && s.role !== "build";

/**
 * validateDataApplications(): Argon2id, the host bindings of ports_mappings, custom_labels (stored again as base64 of
 * what it decodes to) and the domains — checked, normalized and held to the org's other resources.
 */
export async function validateDataApplications(tx: SqlExecutor, all: Record<string, unknown>, server: ServerRow, current: string): Promise<CoolifyAnswer | null> {
  if (all.http_basic_auth_hash_algorithm === "argon2id" && !caddySupportsArgon2idBasicAuth({ proxy: server.proxy, caddyProxyImage: null, generateExactLabels: false, traefikCertificateResolver: null, isTrafficAnalyticsEnabled: false })) {
    return stringError("http_basic_auth_hash_algorithm", "Argon2id needs a server that runs the Caddy proxy, version 2.11 or newer.");
  }
  if (typeof all.ports_mappings === "string") {
    const bindings: string[] = [];
    for (const mapping of all.ports_mappings.split(",")) {
      const last = mapping.lastIndexOf(":");
      const binding = mapping.slice(0, last === -1 ? 0 : last).replace(/\/(tcp|udp|sctp)/g, "");
      if (binding === "" || binding.endsWith(":")) continue;
      const protocol = mapping.match(/\/(udp|sctp)/)?.[1] ?? "tcp";
      if (bindings.includes(`${binding}/${protocol}`)) return stringError("ports_mappings", "Each host IP, port, and protocol can only be used once.");
      bindings.push(`${binding}/${protocol}`);
    }
  }
  if (has(all, "custom_labels")) {
    const labels = base64Value(all.custom_labels) ? decodeBase64EncodedLabels(all.custom_labels as string) : null;
    if (labels === null) return stringError("custom_labels", "The custom_labels should be base64 encoded.");
    all.custom_labels = base64Utf8(labels);
  }
  if (has(all, "domains") && proxyShouldRun(server)) {
    const errors = validateApplicationDomains(all.domains);
    if (errors.length) return coolifyJson(obj({ message: "Validation failed.", errors }), 422);
    const normalized = normalizeApplicationDomains(all.domains as string | null);
    all.domains = normalized;
    // checkIfDomainIsAlreadyUsedViaAPI($urls, $teamId, $request->uuid): the body's uuid, else the route's (an update's own application).
    const conflicts = await domainConflicts(tx, NO_MEMORY, applicationDomainList(normalized), current);
    if (conflicts.length && !requestBool(all, "force_domain_override")) return conflictAnswer(conflicts);
  }
  return null;
}

/** The docker_compose_domains of a Git type: the URLs checked and held to the org's resources, then the map stored. */
async function composeDomains(tx: SqlExecutor, all: Record<string, unknown>, force: boolean, trailingSpace: boolean): Promise<CoolifyAnswer | { json: string | null; overrides: Record<string, number> | null }> {
  if (!has(all, "docker_compose_domains")) return { json: null, overrides: null };
  const raw = all.docker_compose_domains;
  const items: unknown[] = Array.isArray(raw) ? raw : raw !== null && typeof raw === "object" ? Object.values(raw) : raw === null || raw === undefined ? [] : [raw];
  const domainOf = (item: unknown): unknown => (item !== null && typeof item === "object" ? (item as Record<string, unknown>).domain : undefined);
  const urls: string[] = [];
  for (const item of items) {
    const value = domainOf(item);
    if (blank(value)) continue;
    let text = phpTrim(String(value));
    if (text.startsWith(",")) text = text.slice(1);
    if (text.endsWith(",")) text = text.slice(0, -1);
    for (const url of phpTrim(text).split(",").map((u) => phpTrim(u))) if (url !== "" && url !== "0") urls.push(url);
  }
  const errors: string[] = [];
  for (const url of urls) {
    if (!isValidDomainUrl(url)) {
      errors.push(`Invalid URL: ${url}`);
      continue;
    }
    const scheme = parseUrl(url)?.scheme ?? "";
    if (!["http", "https"].includes(scheme.toLowerCase())) errors.push(`Invalid URL scheme: ${scheme} for URL: ${url}. Only http and https are supported.`);
  }
  const duplicates = [...new Set(urls.filter((u, i) => urls.indexOf(u) !== i))];
  if (duplicates.length && !force) errors.push(`The current request contains conflicting URLs: ${duplicates.join(", ")} Use force_domain_override=true to proceed.${trailingSpace ? " " : ""}`);
  if (errors.length) return coolifyJson(obj({ message: "Validation failed.", errors: obj({ docker_compose_domains: errors }) }), 422);
  if (urls.length) {
    const conflicts = await domainConflicts(tx, NO_MEMORY, urls, "");
    if (conflicts.length && !force) return conflictAnswer(conflicts);
  }
  // The map by service name, then normalizeDockerComposeDomainPorts().
  const map = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    const record = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const entry: Record<string, unknown> = { domain: record.domain ?? null };
    if (typeof record.redirect === "string" && ["www", "non-www", "both"].includes(record.redirect)) entry.redirect = record.redirect;
    map.set(String(record.name ?? ""), entry);
  }
  if (map.size === 0) return { json: null, overrides: null };
  const all2 = [...map.values()].map((e) => e.domain).filter((d) => truthy(d)).join(",");
  const normalized = normalizeDomainPortOverrides(all2, null);
  for (const entry of map.values()) entry.domain = applicationDomainList(typeof entry.domain === "string" ? entry.domain : null).map(domainWithoutPort).join(",");
  return { json: phpJsonEncode(fromJs(Object.fromEntries(map))), overrides: normalized.overrides };
}

/**
 * The model's attributes as fill($request->only($allowedFields)) sets them: the fillable columns, through their mutators
 * (in the order the fields are listed, as the dockerfile_location mutator reads the build pack set before it).
 */
export function fillAttributes(all: Record<string, unknown>, allowed: readonly string[] = ALLOWED_FIELDS, model: Record<string, unknown> = {}): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const field of allowed) {
    if (!has(all, field) || !FILLABLE_COLUMNS.includes(field)) continue;
    attrs[field] = mutate(field, all[field], { ...model, ...attrs });
  }
  return attrs;
}

/** The set mutators of Application (and HasSafeStringAttribute's). */
function mutate(field: string, value: unknown, attrs: Record<string, unknown>): unknown {
  const str = (v: unknown): string => (v === null || v === undefined || v === false ? "" : v === true ? "1" : String(v));
  switch (field) {
    case "name":
      return stripTags(str(value));
    case "description":
      return value === null ? null : stripTags(str(value));
    case "publish_directory":
      return truthy(value) ? `/${str(value).replace(/^\/+/, "")}` : null;
    case "base_directory":
      return `/${str(value).replace(/^\/+/, "")}`;
    case "dockerfile_location":
      return locationFor(value, attrs.build_pack === "dockerfile" ? "/Dockerfile" : null);
    case "docker_compose_location":
      return locationFor(value, "/docker-compose.yaml");
    case "ports_mappings":
      return value === "" ? null : value;
    case "watch_paths":
      return truthy(value) ? watchPathsForStorage(str(value)) : null;
    case "custom_network_aliases":
      return value === null || value === "" ? null : networkAliasesForStorage(str(value));
    case "custom_nginx_configuration":
      return value === null ? null : base64Utf8(str(value));
    case "noindex_domains":
      return value;
    default:
      return value;
  }
}

/** The dockerfile_location / docker_compose_location mutator: blank is the default, else one leading "/" and no trailing one. */
function locationFor(value: unknown, fallback: string | null): string | null {
  if (value === null || value === undefined || value === "") return fallback;
  const v = String(value);
  if (v === "/") return v;
  const withoutEnd = v.endsWith("/") ? v.slice(0, -1) : v;
  return withoutEnd.startsWith("/") ? withoutEnd : `/${withoutEnd}`;
}

/** The saving hook on the dirty attributes: the domain normalized (its ports to the overrides), the noindex flags kept in step, the trims. */
export function savingHook(attrs: Record<string, unknown>, dirty: readonly string[]): void {
  if (dirty.includes("fqdn")) {
    if (attrs.fqdn === "") attrs.fqdn = null;
    if (attrs.build_pack !== "dockercompose" || truthy(attrs.fqdn)) {
      const overrides = attrs.domain_port_overrides;
      const normalized = normalizeDomainPortOverrides(attrs.fqdn as string | null, overrides !== null && typeof overrides === "object" ? (overrides as Record<string, number>) : null);
      attrs.fqdn = normalized.fqdn;
      attrs.domain_port_overrides = normalized.overrides;
    }
    const kept = syncNoindexDomains(attrs.noindex_domains, attrs.fqdn as string | null);
    if (kept !== undefined) attrs.noindex_domains = kept;
  }
  for (const field of TRIMMED_ON_SAVE) {
    if (!dirty.includes(field)) continue;
    const v = attrs[field];
    attrs[field] = phpTrim(v === null || v === undefined ? "" : String(v));
  }
  if (dirty.includes("custom_nginx_configuration") && attrs.custom_nginx_configuration === "") attrs.custom_nginx_configuration = null;
}

/** A value for its column: the `array` casts as JSON, a boolean as is, anything else that is not a scalar as JSON text. */
export function columnValue(field: string, value: unknown): ApiColumnValue {
  if (value === undefined || value === null) return null;
  if (field === "noindex_domains" || field === "domain_port_overrides") return phpJsonEncode(fromJs(value));
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

// ── the endpoint ────────────────────────────────────────────────────────────

/** POST /applications/{type} */
export async function createApplicationApi(c: ApiV1Context, type: CreateType, labelDeps: LabelDependencies = DEFAULT_LABEL_DEPENDENCIES): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  // $request->all(): the body, then the query string.
  const all: Record<string, unknown> = { ...body.all };
  c.url.searchParams.forEach((v, k) => {
    if (!has(all, k)) all[k] = v === "" ? null : v;
  });
  const forceDomainOverride = requestBool(all, "force_domain_override");
  if (truthy(all.instant_deploy) && !hasDeployAbility(c)) return ABORT_DEPLOY;
  if (body.incomingError) return body.incomingError;

  // customApiValidator() of the target and the names, then the fields not allowed.
  const errors: Errors = [];
  nameRules(errors, all, "name", { required: false, nullable: false });
  descriptionRules(errors, all);
  await validateRules(errors, all, [
    ["project_uuid", ["string", "required"]],
    ["environment_name", ["string", "nullable"]],
    ["environment_uuid", ["string", "nullable"]],
    ["server_uuid", ["string", "required"]],
    ["destination_uuid", ["string"]],
    ["is_http_basic_auth_enabled", ["boolean"]],
    ["http_basic_auth_username", ["string", "nullable"]],
    ["http_basic_auth_password", ["string", "nullable", "max:72"]],
    ["autogenerate_domain", ["boolean"]],
    ["tags", ["array", "nullable"]],
    ["tags.*", ["string", "min:2"]],
  ]);
  // The name and description rules come first in Coolify's array; validateRules appended the rest after them.
  for (const k of Object.keys(all)) if (!ALLOWED_FIELDS.includes(k)) addError(errors, k, k === "fqdn" ? "Use the domains field to set application URLs." : "This field is not allowed.");
  if (errors.length) return validationFailed(errors);

  if (type !== "public" && (has(all, "git_https_username") || has(all, "git_https_password"))) {
    return stringError("git_https_password", "HTTPS credentials can only be used with a public or custom Git host repository (POST /applications/public).");
  }
  if (!blank(all.docker_compose_raw)) {
    try {
      if (typeof all.docker_compose_raw !== "string") throw new Error("The docker_compose_raw field must be a string.");
      validateDockerComposeForInjection(all.docker_compose_raw);
    } catch (e) {
      return stringError("docker_compose_raw", (e as Error).message);
    }
  }
  // validateTagsParameter()
  if (has(all, "tags")) {
    const names = normalizeTags(all.tags ?? []);
    if (names.some((t) => mbLength(t) < 2)) return validationFailed([["tags", ["Each tag name must be at least 2 characters after sanitization."]]]);
    all.tags = names;
  }
  const tagNames = Array.isArray(all.tags) ? (all.tags as string[]) : [];
  if (blank(all.environment_uuid) && blank(all.environment_name)) return message("You need to provide at least one of environment_name or environment_uuid.", 422);

  let fqdn: unknown = all.domains;
  if (has(all, "domains") && typeof all.domains === "string") {
    fqdn = normalizeApplicationDomains(all.domains);
    all.domains = fqdn;
  }
  // A Docker Compose application uses per-service domains; a top-level domain is never routed.
  const autogenerateDomain = requestBool(all, "autogenerate_domain", true) && all.build_pack !== "dockercompose";
  const instantDeploy = all.instant_deploy;
  const isset_ = {
    is_static: all.is_static,
    is_spa: all.is_spa,
    is_auto_deploy_enabled: all.is_auto_deploy_enabled,
    is_force_https_enabled: all.is_force_https_enabled,
    is_preview_deployments_enabled: all.is_preview_deployments_enabled,
    connect_to_docker_network: all.connect_to_docker_network,
    is_build_server_enabled: all.use_build_server,
    use_build_secrets: all.use_build_secrets,
  };
  const isContainerLabelEscapeEnabled = requestBool(all, "is_container_label_escape_enabled", true);
  const isPreserveRepositoryEnabled = requestBool(all, "is_preserve_repository_enabled", false);
  const applicationSettings = applicationSettingsFromRequest(all);

  const requestedBuildPack = type === "public" || type === "private-deploy-key" ? all.build_pack : type;
  if (applicationSettings.is_raw_compose_deployment_enabled === true && requestedBuildPack !== "dockercompose") {
    return stringError("is_raw_compose_deployment_enabled", "Raw compose deployment can only be enabled for Docker Compose applications.");
  }
  if (isset(all.custom_nginx_configuration)) {
    const decoded = base64Value(all.custom_nginx_configuration) ? decodeBase64Utf8(all.custom_nginx_configuration as string) : null;
    if (decoded === null) return stringError("custom_nginx_configuration", "The custom_nginx_configuration should be base64 encoded.");
    all.custom_nginx_configuration = decoded;
  }

  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const project = typeof all.project_uuid === "string" ? (await rows("projects", "t.uuid = $1", [all.project_uuid]))[0] : undefined;
    if (!project) return message("Project not found.", 404);
    const environments = await rows("environments", "t.project_id = $1", [rowValue(project, "id")]);
    const environment = environments.find((e) => all.environment_name !== null && rowValue(e, "name") === all.environment_name) ?? environments.find((e) => all.environment_uuid !== null && rowValue(e, "uuid") === all.environment_uuid);
    if (!environment) return message("Environment not found.", 404);
    // $this->authorize('create', [Application::class, $environment])
    if (!(await c.allows(true))) return COOLIFY_API.unauthorized();
    const serverRow = typeof all.server_uuid === "string" ? (await rows("servers", "t.deleted_at IS NULL AND t.uuid = $1", [all.server_uuid]))[0] : undefined;
    if (!serverRow) return message("Server not found.", 404);
    // $this->authorize('placeResource', $server)
    if (!(await c.allows(true))) return COOLIFY_API.unauthorized();
    const server = serverOf(serverRow, (await rows("server_settings", "t.server_id = $1", [rowValue(serverRow, "id")]))[0]);
    if (server.role === "build") {
      return coolifyJson(obj({ message: "Validation failed.", errors: obj({ server_uuid: ["The specified server is configured as a build server and cannot host resources."] }) }), 422);
    }
    const destinations = await listServerDestinations(tx, server.id);
    if (destinations.length === 0) return message("Server has no destinations.", 400);
    if (destinations.length > 1 && !has(all, "destination_uuid")) return message("Server has multiple destinations and you do not set destination_uuid.", 400);
    let destination = destinations[0]!;
    if (destinations.length > 1) {
      const chosen = destinations.find((d) => d.uuid === all.destination_uuid);
      if (!chosen) return stringError("destination_uuid", "Provided destination_uuid does not belong to the specified server.");
      destination = chosen;
    }
    // containerNamePrefixValidationResponse()
    const prefix = applicationSettings.custom_container_name_prefix;
    if (prefix !== undefined && prefix !== null && typeof prefix !== "string") {
      return validationFailed([["custom_container_name_prefix", ["The custom container name prefix field must be a string."]]]);
    }
    if (typeof prefix === "string" && !blank(prefix)) {
      const others = await listServerApplicationContainerNames(tx, server.id);
      if (others.some((a) => [a.uuid, a.custom_container_name_prefix, a.custom_internal_name].includes(prefix))) {
        return validationFailed([["custom_container_name_prefix", ["This container name prefix is already in use by another application."]]]);
      }
    }
    // customInternalNameValidationResponse()
    if (!blank(applicationSettings.custom_internal_name) && applicationSettings.is_consistent_container_name_enabled === false) {
      return validationFailed([["custom_internal_name", ["Set is_consistent_container_name_enabled to true to use custom_internal_name. Coolify ignores the custom internal name while consistent container naming is turned off."]]]);
    }

    // The type's own rules and defaults.
    const git = type === "public" || type === "private-deploy-key";
    if (git) {
      const own: Rules = [
        ["git_repository", ["string", "required", validGitRepositoryUrl("git_repository")]],
        ["git_branch", ["string", "required", validGitBranch("git_branch")]],
        ["build_pack", ["required", enumRule(BUILD_PACKS)]],
        ["ports_exposes", ["string", { regex: PORTS_EXPOSES_PATTERN }, "nullable"]],
        ...(type === "private-deploy-key"
          ? ([
              ["private_key_uuid", ["string", "required"]],
              ["watch_paths", ["string", "nullable"]],
            ] as Rules)
          : []),
        ...COMPOSE_DOMAIN_RULES,
      ];
      if (all.build_pack === "dockercompose") {
        own[3] = ["ports_exposes", ["string"]];
        all.ports_exposes = "80";
      }
      const typeErrors: Errors = [];
      await validateRules(typeErrors, all, mergeRules(sharedDataApplications(), own), { laravelMessages: true, laravelWildcards: true });
      if (typeErrors.length) return validationFailed(typeErrors);
      if (all.build_pack === "dockercompose" && has(all, "domains")) {
        return stringError("domains", "The domains field cannot be used for dockercompose applications. Use docker_compose_domains instead to set domains for individual services.");
      }
      if (!has(all, "name")) all.name = generateApplicationName(String(all.git_repository), String(all.git_branch));
    } else {
      const own: Rules =
        type === "dockerfile"
          ? [["dockerfile", ["string", "required"]]]
          : [
              ["docker_registry_image_name", ["required", "string", "max:255", dockerImageFormat("docker_registry_image_name", true)]],
              ["docker_registry_image_tag", ["nullable", "string", "max:128", { regex: DOCKER_IMAGE_TAG_PATTERN }]],
              ["ports_exposes", ["string", { regex: PORTS_EXPOSES_PATTERN }, "nullable"]],
            ];
      const typeErrors: Errors = [];
      await validateRules(typeErrors, all, mergeRules(sharedDataApplications(), own));
      if (typeErrors.length) return validationFailed(typeErrors);
      if (!has(all, "name")) all.name = `${type === "dockerfile" ? "dockerfile" : "docker-image"}-${newPublicId()}`;
    }
    // $request->uuid: a create has no {uuid} in its route.
    const invalid = await validateDataApplications(tx, all, server, has(all, "uuid") ? String(all.uuid) : "");
    if (invalid) return invalid;

    let privateKeyId: string | number | null = null;
    let dockerfile: string | null = null;
    if (type === "private-deploy-key") {
      const key = typeof all.private_key_uuid === "string" ? (await rows("private_keys", "t.uuid = $1", [all.private_key_uuid]))[0] : undefined;
      if (!key) return message("Private Key not found.", 404);
      // $this->authorize('useTeamCredentials')
      if (!(await c.allows(true))) return message(APPLICATION_CREATE_MESSAGES.teamCredentials, 403);
      privateKeyId = rowValue(key, "id") as string | number;
    }
    if (type === "dockerfile") {
      dockerfile = base64Value(all.dockerfile) ? decodeBase64Utf8(all.dockerfile as string) : null;
      if (dockerfile === null) return stringError("dockerfile", "The dockerfile should be base64 encoded.");
    }
    if (type === "dockerimage") {
      // DockerImageParser: the name and tag normalized, "@sha256" appended to the name of a digest.
      const name = String(all.docker_registry_image_name);
      const parsed = parseDockerImage(truthy(all.docker_registry_image_tag) ? `${name}:${String(all.docker_registry_image_tag)}` : name);
      let imageName = fullImageNameWithoutTag(parsed);
      if (parsed.isImageHash && !imageName.endsWith("@sha256")) imageName += "@sha256";
      all.docker_registry_image_name = imageName;
      all.docker_registry_image_tag = parsed.tag;
    }
    // get_port_from_dockerfile() of the request's (still encoded) dockerfile; no port, or 0, is 80.
    const portFromRequestDockerfile = type === "dockerfile" ? getPortFromDockerfile(String(all.dockerfile)) || 80 : null;
    for (const field of REMOVED_FIELDS) delete all[field];
    const attrs = fillAttributes(all);

    let composeOverrides: Record<string, number> | null = null;
    if (git) {
      const compose = await composeDomains(tx, all, forceDomainOverride, false);
      if ("status" in compose) return compose;
      if (compose.json !== null) {
        attrs.docker_compose_domains = compose.json;
        composeOverrides = compose.overrides;
        attrs.domain_port_overrides = composeOverrides;
      }
    }
    if (type === "public") {
      let repository = String(attrs.git_repository);
      const https = sshGitUrlToHttps(repository);
      if (https !== null) {
        repository = https;
        attrs.git_repository = https;
      }
      const host = parseUrl(repository)?.host ?? "";
      if (!blank(all.git_https_password)) {
        if (host === "github.com") return stringError("git_https_password", "HTTPS credentials are not used for github.com. Use a GitHub App (POST /applications/private-github-app) for a private GitHub repository.");
        attrs.git_https_password = all.git_https_password;
      } else if (!blank(all.git_https_username)) {
        return stringError("git_https_password", "The git_https_password is required with git_https_username.");
      }
      if (host === "github.com") {
        // GithubApp::find(0): the public GitHub source; the repository as its first two path segments.
        attrs.source_type = "App\\Models\\GithubApp";
        attrs.source_id = 0;
        const parts = (parseUrl(repository)?.path ?? "").split("/").filter((s) => s !== "");
        attrs.git_repository = phpTrim(`${parts[0] ?? ""}/${parts[1] ?? ""}`);
      }
    }
    if (!git) {
      if (type === "dockerfile") {
        attrs.ports_exposes = portFromRequestDockerfile;
        attrs.build_pack = "dockerfile";
        attrs.dockerfile = dockerfile;
      } else attrs.build_pack = "dockerimage";
      attrs.git_repository = "coollabsio/coolify";
      attrs.git_branch = "main";
    }
    attrs.fqdn = fqdn ?? null;
    if (privateKeyId !== null) attrs.private_key_id = privateKeyId;
    attrs.destination_id = destination.id;
    attrs.destination_type = DESTINATION_MORPH_CLASS[destination.type];
    attrs.environment_id = rowValue(environment, "id");
    // sharedImageNameValidationResponse() (not for a Docker image application)
    if (type !== "dockerimage" && !blank(attrs.docker_registry_image_name) && attrs.build_pack !== "dockerimage" && attrs.build_pack !== "dockercompose") {
      const other = await findOtherApplicationBuildingImage(tx, 0, String(attrs.docker_registry_image_name));
      if (other) return validationFailed([["docker_registry_image_name", [APPLICATION_CREATE_MESSAGES.sharedImageName(other.name, String(attrs.docker_registry_image_name))]]]);
    }
    // Freeploy's: what Coolify queues on the server is refused before anything is stored.
    if (truthy(instantDeploy)) return unavailable(APPLICATION_CREATE_MESSAGES.deployUnavailable);
    if (git && attrs.build_pack === "dockercompose") return unavailable(APPLICATION_CREATE_MESSAGES.composeUnavailable);

    // $application->save(): the creating hook (the webhook secrets, compose_parsing_version), the saving hook, the created hook.
    const uuid = newPublicId();
    const dirty = [...Object.keys(attrs)];
    savingHook(attrs, dirty);
    const cipher = (column: string) => columnCipher(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, `applications.${column}`);
    for (const secret of WEBHOOK_SECRETS) if (attrs[secret] === null || attrs[secret] === undefined) attrs[secret] = randomString(40);
    const values: Partial<Record<ApiApplicationColumn, ApiColumnValue>> = { uuid, compose_parsing_version: "5" };
    for (const [field, value] of Object.entries(attrs)) {
      const stored = columnValue(field, value);
      values[field as ApiApplicationColumn] = ENCRYPTED.includes(field) && stored !== null ? await cipher(field).encrypt(String(stored)) : stored;
    }
    const variables: NewApplicationVariable[] = [];
    if (attrs.build_pack === "nixpacks") {
      const valueCipher = columnCipher(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, "environment_variables.value");
      for (const isPreview of [false, true]) {
        variables.push({ uuid: newPublicId(), key: "NIXPACKS_NODE_VERSION", value: await valueCipher.encrypt("22"), isMultiline: false, isLiteral: false, isBuildtime: true, isRuntime: false, isPreview, version: ENVIRONMENT_VARIABLE_VERSION });
      }
    }
    const id = await insertApiApplication(tx, c.orgId, values, variables);

    // applyApplicationSettings(), then the settings the controller sets one by one (only those its type sets).
    const settings: Partial<Record<ApiApplicationSettingColumn, ApiColumnValue>> = {};
    for (const [k, v] of Object.entries(applicationSettings)) settings[k as ApiApplicationSettingColumn] = columnValue(k, v);
    const sets: Array<keyof typeof isset_> = type === "public" ? ["is_static", "is_spa", "is_auto_deploy_enabled", "is_force_https_enabled", "is_preview_deployments_enabled", "connect_to_docker_network", "is_build_server_enabled", "use_build_secrets"] : type === "private-deploy-key" ? ["is_static", "is_spa", "is_auto_deploy_enabled", "is_force_https_enabled", "is_preview_deployments_enabled", "connect_to_docker_network", "is_build_server_enabled", "use_build_secrets"] : ["is_auto_deploy_enabled", "is_force_https_enabled", "is_preview_deployments_enabled", "connect_to_docker_network", "is_build_server_enabled", "use_build_secrets"];
    for (const k of sets) if (isset(isset_[k])) settings[k] = columnValue(k, isset_[k]);
    settings.is_container_label_escape_enabled = isContainerLabelEscapeEnabled;
    if (git) settings.is_preserve_repository_enabled = isPreserveRepositoryEnabled;
    await updateApiApplicationSettings(tx, id, settings);
    // ApplicationSetting::isStatic's mutator: a static application listens on port 80.
    const changes: Partial<Record<ApiApplicationColumn, ApiColumnValue>> = {};
    if (git && truthy(isset_.is_static)) changes.ports_exposes = 80;
    // An application without a domain gets a generated one.
    if (autogenerateDomain && blank(fqdn)) {
      const generated: Record<string, unknown> = { fqdn: generateUrl({ ip: server.ip, wildcardDomain: server.wildcardDomain }, uuid), domain_port_overrides: attrs.domain_port_overrides ?? null, noindex_domains: attrs.noindex_domains ?? null, build_pack: attrs.build_pack };
      savingHook(generated, ["fqdn"]);
      changes.fqdn = columnValue("fqdn", generated.fqdn);
      changes.domain_port_overrides = columnValue("domain_port_overrides", generated.domain_port_overrides);
      if (generated.noindex_domains !== attrs.noindex_domains) changes.noindex_domains = columnValue("noindex_domains", generated.noindex_domains);
    }
    await updateApiApplication(tx, id, changes);
    // The labels, while label management is on (the settings row's default).
    const readonly = applicationSettings.is_container_label_readonly_enabled ?? true;
    if (readonly === true) {
      const source = (await findApplicationLabelSource(tx, uuid))!;
      const password = source.http_basic_auth_password ? await cipher("http_basic_auth_password").decrypt(source.http_basic_auth_password) : null;
      const labels = source.server_uuid === null ? [] : generateLabelsApplication(labelApplication(source, password), null, labelDeps);
      await updateApiApplication(tx, id, { custom_labels: labels.join("\n") });
    }
    for (const name of tagNames) await attachTagTo(tx, c, { type: APPLICATION_MORPH_CLASS, id }, name);
    const domains = (await rows("applications", "t.id = $1", [id]))[0];
    return coolifyJson(serializeApiResponse(obj({ uuid, domains: (domains ? rowValue(domains, "fqdn") : null) as PhpValue })), 201);
  });
}
