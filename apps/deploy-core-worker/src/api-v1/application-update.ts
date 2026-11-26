// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/ApplicationsController.php (update_by_uuid,
// applyApplicationSettings, validateDataApplications, normalizeDockerComposeDomainPorts, teamSourceByUuid),
// app/Models/Application.php (the saving hook with its build pack cleanup, deploymentType, parseHealthcheckFromDockerfile,
// otherApplicationBuildingSameImage), app/Models/ApplicationSetting.php (isStatic), app/Models/GithubApp.php (isConnected)
// and app/Traits/HasNoindexDomains.php (setNoindexDomains) (Apache-2.0), modified.
//
// PATCH /applications/{uuid} of Coolify's /api/v1 (DP-87): the checks in the controller's order (several run before the
// validator's errors are reported), then the settings, the columns through fill() and the model's hooks, and the labels
// wherever the controller makes them again. An instant deploy answers 501 in Coolify's envelope after the checks and
// before anything is stored (queue_application_deployment() runs on the server). A Gitea App is never found (Freeploy
// has no Gitea sources); a GitHub App is the org's own.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  deleteApplicationServiceVariables,
  findApplicationLabelSource,
  findGithubAppByUuid,
  findOtherApplicationBuildingImage,
  listServerApplicationContainerNames,
  updateApiApplication,
  updateApiApplicationSettings,
  type ApiApplicationColumn,
  type ApiApplicationSettingColumn,
  type ApiColumnValue,
  type ApiRow,
  type DeployApplicationLabelRow,
} from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, fromJs, obj, phpJsonEncode, type CoolifyAnswer } from "@saas/contracts/coolify-api";
import { columnCipher } from "../handlers/cloud-tokens.js";
import { applicationDomainList, domainWithoutPort, isValidDomainUrl, normalizeApplicationDomains, normalizeApplicationDomainUrl, normalizeDomainPortOverrides, parseUrl, validateApplicationDomains } from "../applications/domains.js";
import { phpTrim } from "../applications/git.js";
import { dockerfileHealthcheckInstruction, dockerfileHealthcheckOptions } from "../applications/dockerfile.js";
import { labelApplication } from "../applications/labels-service.js";
import { DEFAULT_LABEL_DEPENDENCIES, generateLabelsApplication, type LabelDependencies } from "../labels/labels.js";
import { parseDockerComposeYaml } from "../compose/yaml.js";
import { isPhpArray } from "../compose/php.js";
import { descriptionRules, nameRules, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rule, type Rules } from "./rules.js";
import { domainConflicts } from "./services.js";
import { decryptColumn, hasDeployAbility, message, rowsOf, unavailable, type ApiV1Context } from "./context.js";
import { rowValue } from "./models.js";
import {
  ABORT_DEPLOY,
  APPLICATION_CREATE_MESSAGES,
  APPLICATION_SETTING_FIELDS,
  COMPOSE_DOMAIN_RULES,
  ENCRYPTED,
  NO_MEMORY,
  REMOVED_FIELDS,
  WEBHOOK_SECRETS,
  applicationSettingsFromRequest,
  base64Value,
  blank,
  columnValue,
  conflictAnswer,
  decodeBase64Utf8,
  fillAttributes,
  has,
  isset,
  mergeRules,
  proxyShouldRun,
  requestBool,
  savingHook,
  serverOf,
  sharedDataApplications,
  stringError,
  truthy,
  validGitRepositoryUrl,
  validateDataApplications,
} from "./application-create.js";

/** update_by_uuid()'s $allowedFields, in its order (Request::only() fills the model in this order). */
const UPDATE_ALLOWED_FIELDS: readonly string[] = [
  "name", "description", "is_static", "is_spa", "is_auto_deploy_enabled", "is_force_https_enabled", "is_preview_deployments_enabled", "domains",
  "noindex_domains", "git_repository", "git_branch", "git_commit_sha", "git_https_username", "git_https_password", "docker_registry_image_name",
  "docker_registry_image_tag", "build_pack", "static_image", "install_command", "build_command", "start_command", "ports_exposes", "ports_mappings",
  "custom_network_aliases", "base_directory", "publish_directory", "health_check_enabled", "health_check_type", "health_check_command",
  "health_check_path", "health_check_port", "health_check_host", "health_check_method", "health_check_return_code", "health_check_scheme",
  "health_check_response_text", "health_check_interval", "health_check_timeout", "health_check_retries", "health_check_start_period",
  "limits_memory", "limits_memory_swap", "limits_memory_swappiness", "limits_memory_reservation", "limits_cpus", "limits_cpuset",
  "limits_cpu_shares", "custom_labels", "custom_docker_run_options", "post_deployment_command", "post_deployment_command_container",
  "pre_deployment_command", "pre_deployment_command_container", "watch_paths", "manual_webhook_secret_github", "manual_webhook_secret_gitlab",
  "manual_webhook_secret_bitbucket", "manual_webhook_secret_gitea", "dockerfile_location", "dockerfile_target_build", "docker_compose_location",
  "docker_compose_custom_start_command", "docker_compose_custom_build_command", "docker_compose_domains", "redirect", "instant_deploy",
  "use_build_server", "use_build_secrets", "custom_nginx_configuration", "is_http_basic_auth_enabled", "http_basic_auth_username",
  "http_basic_auth_password", "http_basic_auth_hash_algorithm", "http_basic_auth_bcrypt_cost", "http_basic_auth_argon2id_memory_cost",
  "http_basic_auth_argon2id_time_cost", "connect_to_docker_network", "force_domain_override", "is_container_label_escape_enabled",
  "is_preserve_repository_enabled", "preview_url_template", "max_restart_count", "github_app_uuid", "gitea_app_uuid", "dockerfile",
  ...APPLICATION_SETTING_FIELDS,
];

/** The columns the label generator reads from the model (the rest come from its settings and server). */
const LABEL_COLUMNS = ["fqdn", "ports_exposes", "redirect", "is_http_basic_auth_enabled", "http_basic_auth_username", "http_basic_auth_hash_algorithm", "http_basic_auth_bcrypt_cost", "http_basic_auth_argon2id_memory_cost", "http_basic_auth_argon2id_time_cost", "noindex_domains", "domain_port_overrides"] as const;
const GITHUB_APP = "App\\Models\\GithubApp";
const JSON_COLUMNS = ["noindex_domains", "domain_port_overrides"];

const isNumericString = (v: unknown): boolean => (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(v));
/** A stored JSON column as the model's `array` cast reads it. */
function decoded(v: unknown): unknown {
  if (typeof v !== "string") return v ?? null;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return null;
  }
}
/** HasAttributes::originalIsEquivalent() for the columns the API writes. */
function equivalent(field: string, current: unknown, original: unknown): boolean {
  if (JSON_COLUMNS.includes(field)) return JSON.stringify(decoded(current)) === JSON.stringify(decoded(original));
  if (current === original) return true;
  if (current === null || current === undefined || original === null || original === undefined) return false;
  if (typeof original === "boolean" || typeof current === "boolean") return truthy(current) === truthy(original);
  if (isNumericString(current) && isNumericString(original)) return Number(current) === Number(original);
  return String(current) === String(original);
}

/** Application::deploymentType(): a deploy key, a Git source (that exists), or neither. */
async function deploymentType(tx: SqlExecutor, app: ApiRow): Promise<"deploy_key" | "source" | "other"> {
  const keyId = rowValue(app, "private_key_id");
  if (keyId !== null && keyId !== undefined && Number(keyId) > 0) return "deploy_key";
  if (await sourceExists(tx, app)) return "source";
  if (keyId !== null && keyId !== undefined && Number(keyId) === 0) return "deploy_key";
  return "other";
}

/** The source relation: the public GitHub source (id 0) or one of the org's GitHub Apps; Freeploy stores no other kind. */
async function sourceExists(tx: SqlExecutor, app: ApiRow): Promise<boolean> {
  const type = rowValue(app, "source_type");
  const id = rowValue(app, "source_id");
  if (type !== GITHUB_APP || id === null || id === undefined) return false;
  if (Number(id) === 0) return true;
  return (await tx.execute("SELECT 1 FROM deploy.github_apps WHERE id = $1", [id])).rows.length > 0;
}

/** The labels generateLabelsApplication() makes of the model as it stands in memory (its settings and server as stored). */
async function labelsOf(tx: SqlExecutor, uuid: string, model: Record<string, unknown>, password: string | null, deps: LabelDependencies): Promise<string> {
  const source = (await findApplicationLabelSource(tx, uuid))!;
  const row = { ...source } as Record<string, unknown>;
  for (const column of LABEL_COLUMNS) row[column] = model[column] ?? null;
  if (source.server_uuid === null) return "";
  return generateLabelsApplication(labelApplication(row as DeployApplicationLabelRow, password), null, deps).join("\n");
}

/** PATCH /applications/{uuid} */
export async function updateApplicationApi(c: ApiV1Context, uuid: string, labelDeps: LabelDependencies = DEFAULT_LABEL_DEPENDENCIES): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all: Record<string, unknown> = { ...body.all };
  c.url.searchParams.forEach((v, k) => {
    if (!has(all, k)) all[k] = v === "" ? null : v;
  });

  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const app = (await rows("applications", "t.deleted_at IS NULL AND t.uuid = $1", [uuid]))[0];
    if (!app) return message("Application not found", 404);
    const original = Object.fromEntries(app) as Record<string, unknown>;
    const id = original.id as string | number;
    // $this->authorize('update', $application)
    if (!(await c.allows(true))) return COOLIFY_API.unauthorized();
    const settingsRow = Object.fromEntries((await rows("application_settings", "t.application_id = $1", [id]))[0] ?? []) as Record<string, unknown>;
    // manageEnvironment and deploy: write access, as update.
    if ((has(all, "redact_all_env_values_in_logs") || has(all, "include_coolify_default_variables")) && !(await c.allows(true))) return COOLIFY_API.unauthorized();
    if (truthy(all.instant_deploy)) {
      if (!hasDeployAbility(c)) return ABORT_DEPLOY;
      if (!(await c.allows(true))) return COOLIFY_API.unauthorized();
    }
    const destination = (await rows("standalone_dockers", "t.id = $1", [original.destination_id]))[0];
    const serverRow = destination ? (await rows("servers", "t.deleted_at IS NULL AND t.id = $1", [rowValue(destination, "server_id")]))[0] : undefined;
    // $application->destination->server: an application without one is PHP's error on null.
    if (!serverRow) throw new Error("update_by_uuid(): the application has no server");
    const server = serverOf(serverRow, (await rows("server_settings", "t.server_id = $1", [rowValue(serverRow, "id")]))[0]);

    // The validator: sharedDataApplications($application) and the update's own rules, its errors reported only later.
    const secrets: Partial<Record<(typeof WEBHOOK_SECRETS)[number], string | null>> = {};
    for (const column of WEBHOOK_SECRETS) secrets[column] = await decryptColumn(tx, c, "applications", column, original[column]);
    const nameRule: Rule = { closure: (v) => ruleMessages((e) => nameRules(e, { name: v }, "name", { required: false, nullable: false })) };
    const descriptionRule: Rule = { closure: (v) => ruleMessages((e) => descriptionRules(e, { description: v })) };
    const own: Rules = [
      ["name", [nameRule]],
      ["github_app_uuid", ["string"]],
      ["gitea_app_uuid", ["string"]],
      ["dockerfile", ["string"]],
      ["description", [descriptionRule]],
      ["watch_paths", ["string", "nullable"]],
      ...COMPOSE_DOMAIN_RULES,
      ["custom_nginx_configuration", ["string", "nullable"]],
      ["is_http_basic_auth_enabled", ["boolean", "nullable"]],
      ["is_preview_deployments_enabled", ["boolean", "nullable"]],
      ["http_basic_auth_username", ["string"]],
      ["http_basic_auth_password", ["string", "max:72"]],
      ["include_source_commit_in_build", ["boolean"]],
      ["ports_exposes", ["nullable", "string", { regex: /^(\d+)(,\d+)*$/ }]],
    ];
    let rules = mergeRules(sharedDataApplications(secrets), own);
    // A change of repository is checked as a URL or an owner/name path (a Gitea source checks it below).
    if (all.git_repository !== original.git_repository && !has(all, "gitea_app_uuid")) rules = mergeRules(rules, [["git_repository", ["string", validGitRepositoryUrl("git_repository", true)]]]);
    const snapshot = structuredClone(all);
    const validate = async (): Promise<Errors> => {
      const errors: Errors = [];
      await validateRules(errors, snapshot, rules, { laravelMessages: true, laravelWildcards: true });
      return errors;
    };

    if (!blank(all.ports_exposes)) {
      for (const port of String(all.ports_exposes).split(",")) {
        if (!isNumericString(port) || Math.trunc(Number(port)) < 1 || Math.trunc(Number(port)) > 65535) return stringError("ports_exposes", "The ports_exposes should be a comma separated list of numbers.");
      }
    }
    if (has(all, "custom_nginx_configuration") && all.custom_nginx_configuration !== null) {
      const text = base64Value(all.custom_nginx_configuration) ? decodeBase64Utf8(all.custom_nginx_configuration as string) : null;
      if (text === null) return stringError("custom_nginx_configuration", "The custom_nginx_configuration should be base64 encoded.");
      all.custom_nginx_configuration = text;
    }
    if (has(all, "dockerfile")) {
      if (blank(original.dockerfile)) return stringError("dockerfile", "The dockerfile can only be updated for applications created from a Dockerfile.");
      const text = base64Value(all.dockerfile) ? decodeBase64Utf8(all.dockerfile as string) : null;
      if (text === null || blank(text)) return stringError("dockerfile", "The dockerfile should be base64 encoded.");
      all.dockerfile = text;
    }
    const invalid = await validateDataApplications(tx, all, server, has(all, "uuid") ? String(all.uuid) : uuid);
    if (invalid) return invalid;
    const errors = await validate();
    for (const k of Object.keys(all)) if (!UPDATE_ALLOWED_FIELDS.includes(k)) addError(errors, k, k === "fqdn" ? "Use the domains field to set application URLs." : "This field is not allowed.");
    if (errors.length) return validationFailed(errors);

    // A new Git source.
    if (has(all, "github_app_uuid") && has(all, "gitea_app_uuid")) return stringError("gitea_app_uuid", "Send only one of github_app_uuid or gitea_app_uuid.");
    let newSource: { id: string | number } | null = null;
    for (const field of ["github_app_uuid", "gitea_app_uuid"] as const) {
      if (!has(all, field)) continue;
      if (original.build_pack === "dockerimage" || !blank(original.dockerfile) || (await deploymentType(tx, app)) === "deploy_key") {
        return stringError(field, `The ${field} can only be changed for applications deployed from a Git source or public repository.`);
      }
      // GithubApp: the org's (Freeploy has no system-wide App), connected; no Gitea App exists in Freeploy.
      const found = field === "github_app_uuid" && typeof all[field] === "string" ? await findGithubAppByUuid(tx, all[field] as string) : null;
      const connected = found !== null && (found.is_public === true || (!blank(found.app_id) && !blank(found.installation_id)));
      if (!found || !connected) return message(field === "github_app_uuid" ? "Github App not found." : "Gitea App not found.", 404);
      newSource = { id: found.id };
      // $this->authorize('useTeamCredentials', $application) for a source the application does not have yet.
      const same = original.source_type === GITHUB_APP && String(original.source_id) === String(found.id);
      if (!same && !(await c.allows(true))) return message(APPLICATION_CREATE_MESSAGES.teamCredentials, 403);
    }
    if (has(all, "git_https_username") || has(all, "git_https_password")) {
      if ((await deploymentType(tx, app)) !== "other") return stringError("git_https_password", "HTTPS credentials can only be used by applications that clone a repository without a Git source or deploy key.");
      if (!blank(all.git_https_username) && blank(all.git_https_password) && blank(original.git_https_password)) return stringError("git_https_password", "The git_https_password is required with git_https_username.");
    }

    const applicationSettings = applicationSettingsFromRequest(all);
    const prefix = applicationSettings.custom_container_name_prefix;
    if (prefix !== undefined && prefix !== null && typeof prefix !== "string") return validationFailed([["custom_container_name_prefix", ["The custom container name prefix field must be a string."]]]);
    if (typeof prefix === "string" && !blank(prefix)) {
      const others = (await listServerApplicationContainerNames(tx, server.id)).filter((a) => String(a.id) !== String(id));
      if (others.some((a) => [a.uuid, a.custom_container_name_prefix, a.custom_internal_name].includes(prefix))) return validationFailed([["custom_container_name_prefix", ["This container name prefix is already in use by another application."]]]);
    }
    // sharedImageNameValidationResponse() of the requested image and build pack, when either changes.
    const requested = { docker_registry_image_name: has(all, "docker_registry_image_name") ? all.docker_registry_image_name : original.docker_registry_image_name, build_pack: has(all, "build_pack") ? all.build_pack : original.build_pack };
    const imageChanged = !equivalent("docker_registry_image_name", requested.docker_registry_image_name, original.docker_registry_image_name) || !equivalent("build_pack", requested.build_pack, original.build_pack);
    if (imageChanged && !blank(requested.docker_registry_image_name) && requested.build_pack !== "dockerimage" && requested.build_pack !== "dockercompose") {
      const other = await findOtherApplicationBuildingImage(tx, id, String(requested.docker_registry_image_name));
      if (other) return validationFailed([["docker_registry_image_name", [APPLICATION_CREATE_MESSAGES.sharedImageName(other.name, String(requested.docker_registry_image_name))]]]);
    }
    if (!blank(applicationSettings.custom_internal_name) && applicationSettings.is_consistent_container_name_enabled === false) {
      return validationFailed([["custom_internal_name", ["Set is_consistent_container_name_enabled to true to use custom_internal_name. Coolify ignores the custom internal name while consistent container naming is turned off."]]]);
    }
    const requestedBuildPack = has(all, "build_pack") ? all.build_pack : original.build_pack;
    if (applicationSettings.is_raw_compose_deployment_enabled === true && requestedBuildPack !== "dockercompose") {
      return stringError("is_raw_compose_deployment_enabled", "Raw compose deployment can only be enabled for Docker Compose applications.");
    }
    const basicAuthFields = ["is_http_basic_auth_enabled", "http_basic_auth_username", "http_basic_auth_password", "http_basic_auth_hash_algorithm", "http_basic_auth_bcrypt_cost", "http_basic_auth_argon2id_memory_cost", "http_basic_auth_argon2id_time_cost"];
    const requestHasHttpBasicAuth = basicAuthFields.some((f) => has(all, f));
    if (all.is_http_basic_auth_enabled === true && (blank(original.http_basic_auth_username) || blank(original.http_basic_auth_password))) {
      const missing: Array<[string, string]> = [];
      if (blank(all.http_basic_auth_username)) missing.push(["http_basic_auth_username", "The http_basic_auth_username is required."]);
      if (blank(all.http_basic_auth_password)) missing.push(["http_basic_auth_password", "The http_basic_auth_password is required."]);
      if (missing.length) return coolifyJson(obj({ message: "Validation failed.", errors: obj(Object.fromEntries(missing)) }), 422);
    }
    if (original.build_pack === "dockercompose" && has(all, "domains")) {
      return stringError("domains", "The domains field cannot be used for dockercompose applications. Use docker_compose_domains instead to set domains for individual services.");
    }
    const requestHasDomains = has(all, "domains");
    const current = has(all, "uuid") ? String(all.uuid) : uuid;
    let domains: unknown = all.domains;
    if (requestHasDomains && proxyShouldRun(server)) {
      const domainErrors = validateApplicationDomains(all.domains);
      if (domainErrors.length) return coolifyJson(obj({ message: "Validation failed.", errors: domainErrors }), 422);
      domains = normalizeApplicationDomains(all.domains as string | null);
      all.domains = domains;
      const conflicts = await domainConflicts(tx, NO_MEMORY, applicationDomainList(domains as string | null), current);
      if (conflicts.length && !requestBool(all, "force_domain_override")) return conflictAnswer(conflicts);
    }
    let composeJson: Record<string, Record<string, unknown>> | null = null;
    if (has(all, "docker_compose_domains")) {
      const answer = await composeDomainsOfUpdate(tx, all, original, current);
      if ("status" in answer) return answer;
      composeJson = answer.map;
      delete all.docker_compose_domains;
    }
    // Freeploy's: queue_application_deployment() runs on the server; refused before anything is stored.
    if (truthy(all.instant_deploy)) return unavailable(APPLICATION_CREATE_MESSAGES.deployUnavailable);

    // The settings the controller sets one by one, then applyApplicationSettings().
    const settings: Partial<Record<ApiApplicationSettingColumn, ApiColumnValue>> = {};
    const raw: Array<[ApiApplicationSettingColumn, unknown]> = [
      ["is_build_server_enabled", all.use_build_server],
      ["use_build_secrets", all.use_build_secrets],
      ["is_static", all.is_static],
      ["is_spa", all.is_spa],
      ["is_auto_deploy_enabled", all.is_auto_deploy_enabled],
      ["is_force_https_enabled", all.is_force_https_enabled],
      ["is_preview_deployments_enabled", all.is_preview_deployments_enabled],
      ["connect_to_docker_network", all.connect_to_docker_network],
    ];
    for (const [k, v] of raw) if (isset(v)) settings[k] = columnValue(k, v);
    for (const k of ["is_container_label_escape_enabled", "is_preserve_repository_enabled", "include_source_commit_in_build"] as const) if (has(all, k)) settings[k] = requestBool(all, k);
    // ApplicationSetting::isStatic's mutator saves port 80 on another instance of the application (the controller's stays as it was).
    if (truthy(all.is_static)) await updateApiApplication(tx, id, { ports_exposes: 80 });
    const wasLabelManagementEnabled = settingsRow.is_container_label_readonly_enabled === true;
    for (const [k, v] of Object.entries(applicationSettings)) settings[k as ApiApplicationSettingColumn] = columnValue(k, v);
    await updateApiApplicationSettings(tx, id, settings);
    const readonly = (has(applicationSettings, "is_container_label_readonly_enabled") ? applicationSettings.is_container_label_readonly_enabled : settingsRow.is_container_label_readonly_enabled) === true;
    const cipher = (column: string) => columnCipher(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, `applications.${column}`);
    const storedPassword = await decryptColumn(tx, c, "applications", "http_basic_auth_password", original.http_basic_auth_password);
    if (Object.keys(applicationSettings).length) {
      const labelKeys = ["is_gzip_enabled", "is_stripprefix_enabled", "is_permanent_redirect_enabled", "traefik_certificate_resolver"];
      if (readonly && (!wasLabelManagementEnabled || labelKeys.some((k) => has(applicationSettings, k)))) {
        await updateApiApplication(tx, id, { custom_labels: await labelsOf(tx, uuid, original, storedPassword, labelDeps) });
      }
    }

    // fill($request->only($allowedFields)) after removeUnnecessaryFieldsFromRequest(), with the domains and the Compose map.
    for (const field of REMOVED_FIELDS) delete all[field];
    const data: Record<string, unknown> = {};
    for (const field of UPDATE_ALLOWED_FIELDS) if (has(all, field)) data[field] = all[field];
    if (requestHasDomains && proxyShouldRun(server)) data.fqdn = domains;
    if (composeJson !== null && Object.keys(composeJson).length) {
      const existing = decoded(original.domain_port_overrides);
      const normalized = normalizeDomainPortOverrides(
        Object.values(composeJson)
          .map((e) => e.domain)
          .filter((d) => truthy(d))
          .join(","),
        existing !== null && typeof existing === "object" ? (existing as Record<string, number>) : null,
      );
      for (const entry of Object.values(composeJson)) entry.domain = applicationDomainList(typeof entry.domain === "string" ? entry.domain : null).map(domainWithoutPort).join(",");
      data.docker_compose_domains = phpJsonEncode(fromJs(composeJson));
      data.domain_port_overrides = normalized.overrides;
    }
    const requestHasNoindexDomains = has(all, "noindex_domains");
    const noindexInput = all.noindex_domains;
    delete data.noindex_domains;
    const attrs: Record<string, unknown> = fillAttributes(data, UPDATE_ALLOWED_FIELDS, original);
    // fqdn, docker_compose_domains and domain_port_overrides are filled as they are (no mutator).
    for (const k of ["fqdn", "docker_compose_domains", "domain_port_overrides"]) if (has(data, k)) attrs[k] = data[k];
    let password: string | null = storedPassword;
    if (has(attrs, "http_basic_auth_password")) password = attrs.http_basic_auth_password === null ? null : String(attrs.http_basic_auth_password);
    if (has(all, "git_https_password")) {
      attrs.git_https_password = blank(all.git_https_password) ? null : all.git_https_password;
      if (blank(attrs.git_https_password)) attrs.git_https_username = null;
    }
    if (newSource && (String(original.source_id) !== String(newSource.id) || original.source_type !== GITHUB_APP)) {
      attrs.source_id = newSource.id;
      attrs.source_type = GITHUB_APP;
      attrs.repository_project_id = null;
    }
    const model = (): Record<string, unknown> => ({ ...original, ...attrs });
    if (requestHasNoindexDomains) attrs.noindex_domains = noindexDomains(noindexInput ?? [], model());
    const dirty = (): string[] => Object.keys(attrs).filter((k) => !equivalent(k, attrs[k], original[k]));
    if (readonly && (requestHasDomains || requestHasNoindexDomains || requestHasHttpBasicAuth || dirty().includes("ports_exposes")) && proxyShouldRun(server)) {
      attrs.custom_labels = await labelsOf(tx, uuid, model(), password, labelDeps);
    }

    // $application->save(): the dirty columns, through the saving hook.
    const changed = dirty();
    const saved: Record<string, unknown> = model();
    savingHook(saved, changed);
    if (changed.includes("build_pack")) {
      if (original.build_pack === "dockercompose") {
        saved.docker_compose_domains = null;
        saved.docker_compose_raw = null;
        changed.push("docker_compose_domains", "docker_compose_raw");
        await deleteApplicationServiceVariables(tx, id);
      }
      if (original.build_pack === "dockerfile") {
        saved.dockerfile = null;
        saved.dockerfile_location = null;
        saved.dockerfile_target_build = null;
        saved.custom_healthcheck_found = false;
        changed.push("dockerfile", "dockerfile_location", "dockerfile_target_build", "custom_healthcheck_found");
      }
    }
    const write = new Set([...changed, ...(changed.includes("fqdn") ? ["fqdn", "domain_port_overrides", "noindex_domains"] : [])]);
    const values: Partial<Record<ApiApplicationColumn, ApiColumnValue>> = {};
    let clearsComposeRaw = false;
    for (const field of write) {
      if (field === "docker_compose_raw") {
        clearsComposeRaw = true;
        continue;
      }
      if (field === "custom_healthcheck_found") continue;
      const stored = columnValue(field, saved[field]);
      values[field as ApiApplicationColumn] = ENCRYPTED.includes(field) && stored !== null ? await cipher(field).encrypt(String(stored)) : stored;
    }
    await updateApiApplication(tx, id, values);
    if (clearsComposeRaw) await tx.execute("UPDATE deploy.applications SET docker_compose_raw = NULL WHERE id = $1", [id]);
    if (write.has("custom_healthcheck_found")) await tx.execute("UPDATE deploy.applications SET custom_healthcheck_found = false WHERE id = $1", [id]);
    // $application->wasChanged('dockerfile'): parseHealthcheckFromDockerfile().
    if (changed.includes("dockerfile") && saved.dockerfile !== null) await parseHealthcheckFromDockerfile(tx, id);
    return coolifyJson(obj({ uuid }));
  });
}

/** The messages of a rule helper that writes into an error list. */
function ruleMessages(fill: (errors: Errors) => void): string[] {
  const errors: Errors = [];
  fill(errors);
  return errors.flatMap(([, list]) => list);
}

function addError(errors: Errors, field: string, text: string): void {
  const at = errors.find(([k]) => k === field);
  if (at) at[1].push(text);
  else errors.push([field, [text]]);
}

/** HasNoindexDomains::setNoindexDomains(): the flags normalized, kept for the domains the application has, once each. */
function noindexDomains(input: unknown, model: Record<string, unknown>): string[] {
  const key = (d: string) => domainWithoutPort(normalizeApplicationDomainUrl(d));
  const current = applicationDomainList(model.fqdn as string | null).map(key);
  const compose = decoded(model.docker_compose_domains);
  if (compose !== null && typeof compose === "object") {
    for (const entry of Object.values(compose as Record<string, unknown>)) {
      const domain = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>).domain : entry;
      current.push(...applicationDomainList(typeof domain === "string" ? domain : null).map(key));
    }
  }
  const list = Array.isArray(input) ? input : input !== null && typeof input === "object" ? Object.values(input) : [input];
  const out: string[] = [];
  for (const d of list) {
    if (typeof d !== "string" || blank(d)) continue;
    const k = key(d);
    if (current.includes(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

/** The docker_compose_domains of an update: the URLs checked, then the entries of services the Compose file has. */
async function composeDomainsOfUpdate(tx: SqlExecutor, all: Record<string, unknown>, original: Record<string, unknown>, current: string): Promise<CoolifyAnswer | { map: Record<string, Record<string, unknown>> }> {
  if (blank(original.docker_compose_raw) || original.docker_compose_raw === "0") {
    return stringError("docker_compose_domains", "Cannot set docker_compose_domains without docker_compose_raw. Reload the compose file from the git repository first.");
  }
  const raw = all.docker_compose_domains;
  const items: unknown[] = Array.isArray(raw) ? raw : raw !== null && typeof raw === "object" ? Object.values(raw) : raw === null || raw === undefined ? [] : [raw];
  const urls: string[] = [];
  for (const item of items) {
    const value = item !== null && typeof item === "object" ? (item as Record<string, unknown>).domain : undefined;
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
  const force = requestBool(all, "force_domain_override");
  const duplicates = [...new Set(urls.filter((u, i) => urls.indexOf(u) !== i))];
  if (duplicates.length && !force) errors.push(`The current request contains conflicting URLs: ${duplicates.join(", ")} Use force_domain_override=true to proceed.`);
  if (errors.length) return coolifyJson(obj({ message: "Validation failed.", errors: obj({ docker_compose_domains: errors }) }), 422);
  if (urls.length) {
    const conflicts = await domainConflicts(tx, NO_MEMORY, urls, current);
    if (conflicts.length && !force) return conflictAnswer(conflicts);
  }
  // parseDockerComposeYaml() of the stored file (a file it cannot read is PHP's exception, the API's 500).
  const yaml = parseDockerComposeYaml(String(original.docker_compose_raw));
  const services = isPhpArray(yaml) ? yaml.get("services") : undefined;
  const existing = decoded(original.docker_compose_domains);
  const existingMap = existing !== null && typeof existing === "object" ? (existing as Record<string, Record<string, unknown>>) : {};
  const map: Record<string, Record<string, unknown>> = {};
  for (const item of items) {
    const record = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const name = record.name;
    if (!truthy(name) || !isPhpArray(services) || !services.has(String(name)) || services.get(String(name)) === null) continue;
    const entry: Record<string, unknown> = { domain: record.domain ?? null };
    const redirect = has(record, "redirect") ? record.redirect : existingMap[String(name)]?.redirect;
    if (typeof redirect === "string" && ["www", "non-www", "both"].includes(redirect)) entry.redirect = redirect;
    map[String(name)] = entry;
  }
  return { map };
}

/** Application::parseHealthcheckFromDockerfile() of the saved Dockerfile. */
async function parseHealthcheckFromDockerfile(tx: SqlExecutor, id: string | number): Promise<void> {
  const r = await tx.execute<{ dockerfile: string | null; dockerfile_target_build: string | null; custom_healthcheck_found: boolean; health_check_enabled: boolean; health_check_interval: number; health_check_timeout: number; health_check_start_period: number; health_check_retries: number }>(
    "SELECT dockerfile, dockerfile_target_build, custom_healthcheck_found, health_check_enabled, health_check_interval, health_check_timeout, health_check_start_period, health_check_retries FROM deploy.applications WHERE id = $1",
    [id],
  );
  const app = r.rows[0]!;
  const instruction = dockerfileHealthcheckInstruction(app.dockerfile, app.dockerfile_target_build);
  if (instruction === null) {
    if (!app.custom_healthcheck_found) return;
    await tx.execute("UPDATE deploy.applications SET custom_healthcheck_found = false, health_check_interval = 5, health_check_timeout = 5, health_check_retries = 10, health_check_start_period = 5 WHERE id = $1", [id]);
    return;
  }
  // isHealthcheckDisabled(): the application's own health check is off.
  if (app.health_check_enabled !== false) return;
  const options = dockerfileHealthcheckOptions(instruction);
  await tx.execute("UPDATE deploy.applications SET health_check_interval = $2, health_check_timeout = $3, health_check_start_period = $4, health_check_retries = $5, custom_healthcheck_found = true WHERE id = $1", [
    id,
    options.interval ?? app.health_check_interval,
    options.timeout ?? app.health_check_timeout,
    options.startPeriod ?? app.health_check_start_period,
    options.retries ?? app.health_check_retries,
  ]);
}
