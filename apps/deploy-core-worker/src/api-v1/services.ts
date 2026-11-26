// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/ServicesController.php (services, service_by_uuid,
// create_service, update_by_uuid, delete_by_uuid, envs, create_env, update_env_by_uuid, create_bulk_envs,
// delete_env_by_uuid, action_deploy, action_stop, action_restart, removeSensitiveData, exposeNestedServerSecrets,
// applyNewServiceUrls, applyServiceUrls), app/Http/Controllers/Api/Concerns/{HandlesTagsApi,RequiresDeployAbility}.php,
// app/Http/Controllers/Api/OtherController.php (post_required), app/Models/{Service,ServiceApplication,ServiceDatabase}.php
// ($hidden, $casts, $appends, the status and server_status accessors, HasSafeStringAttribute), bootstrap/helpers/domains.php
// (checkIfDomainIsAlreadyUsedViaAPI, applicationDomainEntries, domainConflictKey) and bootstrap/helpers/api.php
// (redactLockedApiResourceValues) (Apache-2.0), modified.
//
// Coolify's /api/v1 for services (DP-74), on the services and stores the console uses: a service is created from a
// one-click template or from a Compose file the request gives by the same rows and parser as the New Resource page
// (newServiceFromTemplate(), createServiceFromTemplate(), parseService() — the API's path is the same parse), its urls are
// applied as the controller applies them (the domains checked against the org's, updateCompose()), it is changed by
// loading its rows, parsing again and writing back what changed (rows.ts, as StackForm::submit()), deleted by the Danger
// Zone's deleteServiceNow() (the never-started rule), and its variables are the Environment Variables page's
// (createVariable(), saveVariable()). What runs on the server — start, restart, stop of a running service, an instant
// deploy — answers 501 in Coolify's envelope (DP-70's convention).
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { SERVICE_MORPH_CLASS, listServerDestinations, type ApiRow, type DeployEnvironmentVariableResourceRow } from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, obj, put, serializeApiResponse, type CoolifyAnswer, type PhpObject, type PhpValue } from "@saas/contracts/coolify-api";
import { serviceContext } from "../handlers/services.js";
import { serviceResourcesContext } from "../handlers/service-configuration.js";
import { environmentVariableContext } from "../handlers/environment-variables.js";
import { applicationDomainList, domainConflictKey, normalizeApplicationDomains, validateApplicationDomains } from "../applications/domains.js";
import { stripTags } from "../applications/tags.js";
import { createVariable, saveVariable, storedValue, EnvironmentVariableError, type VariableChanges } from "../environment-variables/service.js";
import { effectiveServerRole } from "../servers/service.js";
import { parseDockerComposeYaml } from "../compose/yaml.js";
import { NEEDS_TO_CONNECT_TO_PREDEFINED_NETWORK, resolveServiceTemplateKey, serviceTemplates } from "../services/catalogue.js";
import { ComposeError } from "../services/compose-helpers.js";
import { validateDockerComposeForInjection } from "../services/compose-validation.js";
import { SERVICE_CONFIGURATION_MESSAGES, ServiceConfigurationError, partUrl, serviceParserContext, serviceStatus, redactLockedValues } from "../services/configuration.js";
import { createServiceFromTemplate, newServiceFromTemplate, parseService, setServiceApplicationFqdn, updateServiceCompose, SERVICE_PARSER_VERSION, type ServiceParserContext } from "../services/parser.js";
import { deleteServiceNow } from "../services/resources.js";
import { loadServiceRows, writeServiceRows } from "../services/rows.js";
import { insertParsedRows, newServiceParserContext } from "../services/service.js";
import { MemoryServiceStore, type ServiceStore } from "../services/store.js";
import { newPublicId } from "../helpers/names.js";
import { functional, lookupKey, nestedServer, normalizedKey, validateVariable, variableModel } from "./applications.js";
import { columnCipher } from "../handlers/cloud-tokens.js";
import { inCoolifyOrder } from "./columns.js";
import { hasDeployAbility, message, queryBoolean, rowsOf, unavailable, type ApiV1Context, type Rows } from "./context.js";
import { attachTagTo, decodeBase64Text, normalizeTags } from "./databases.js";
import { DESTINATION, SERVICE, SERVICE_APPLICATION, SERVICE_DATABASE, rowValue, toModel } from "./models.js";
import { descriptionRules, extraFields, nameRules, readApiBody, requestBoolean, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rule, type Rules } from "./rules.js";

/** Laravel's abort(403, …) rendered by Coolify's exception handler: pretty-printed. */
const ABORT_DEPLOY: CoolifyAnswer = { status: 403, body: '{\n    "message": "Missing required permissions: deploy"\n}', headers: { "content-type": "application/json" } };
const SWARM_DOCKER = "App\\Models\\SwarmDocker";
const NOT_FOUND = "Service not found.";
const URLS_ARRAY_MESSAGE = "An item in the urls array has invalid fields. Only name and url fields are supported.";
const COMPOSE_NOT_BASE64 = "The docker_compose_raw should be base64 encoded.";

/** A refused write inside the transaction: thrown so that the transaction rolls back, answered as it is. */
class Rollback extends Error {
  constructor(readonly answer: CoolifyAnswer) {
    super("rolled back");
  }
}

/** c.sql(), with a Rollback answered after its transaction rolled back. */
async function inTransaction(c: ApiV1Context, fn: (tx: SqlExecutor) => Promise<CoolifyAnswer>): Promise<CoolifyAnswer> {
  try {
    return await c.sql(c.env, c.orgId, fn);
  } catch (e) {
    if (e instanceof Rollback) return e.answer;
    throw e;
  }
}

/** PHP's truthiness of a request value. */
const phpTruthy = (v: unknown): boolean => !(v === undefined || v === null || v === false || v === 0 || v === "" || v === "0" || (Array.isArray(v) && v.length === 0));
/** filled() */
const filled = (v: unknown): boolean => !(v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0));
const denied = async (c: ApiV1Context, write: boolean): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized());

/** `$request->uuid`: Laravel reads the input (the body, then the query string) before the route parameter. */
function param(c: ApiV1Context, all: Record<string, unknown>, route: string): unknown {
  if ("uuid" in all) return all.uuid;
  const q = c.url.searchParams.get("uuid");
  return q !== null ? q : route;
}

/**
 * routes/api.php's /services routes. segments: what follows /services. Null when the path is not one of them (the
 * caller answers the fallback 404).
 */
export async function servicesApi(c: ApiV1Context, segments: string[]): Promise<CoolifyAnswer | null> {
  const [uuid, sub, third, fourth] = segments;
  const m = c.method;
  if (fourth !== undefined) return null;
  if (uuid === undefined) return m === "GET" ? listServices(c) : m === "POST" ? createService(c) : null;
  if (sub === undefined) {
    if (m === "GET") return showService(c, uuid);
    if (m === "PATCH") return updateService(c, uuid);
    if (m === "DELETE") return deleteService(c, uuid);
    return null;
  }
  if (sub === "envs") {
    if (third === undefined) return m === "GET" ? listEnvs(c, uuid) : m === "POST" ? createEnv(c, uuid) : m === "PATCH" ? updateEnv(c, uuid) : null;
    if (third === "bulk" && m === "PATCH") return bulkEnvs(c, uuid);
    return m === "DELETE" ? deleteEnv(c, uuid, third) : null;
  }
  if (third !== undefined) return null;
  if (sub === "start" || sub === "restart" || sub === "stop") {
    // OtherController::post_required()
    if (m === "GET") return message("This endpoint has changed to a POST request.", 405);
    if (m === "POST") return action(c, uuid, sub);
  }
  return null;
}

// ── reading ─────────────────────────────────────────────────────────────────

/** Service::whereRelation('environment.project.team', …)->whereUuid(): the org's services not deleted. */
async function serviceRow(rows: Rows, uuid: unknown): Promise<ApiRow | null> {
  if (typeof uuid !== "string" && typeof uuid !== "number") return null;
  return (await rows("services", "t.deleted_at IS NULL AND t.uuid = $1", [String(uuid)]))[0] ?? null;
}

const partsOf = async (rows: Rows, serviceId: unknown) => ({
  applications: await rows("service_applications", "t.deleted_at IS NULL AND t.service_id = $1", [serviceId]),
  databases: await rows("service_databases", "t.deleted_at IS NULL AND t.service_id = $1", [serviceId]),
});

/** The Service::status accessor: containerStatus() of its applications and databases (no start is ever running here). */
const statusOf = (parts: { applications: ApiRow[]; databases: ApiRow[] }): string =>
  serviceStatus(
    [...parts.applications, ...parts.databases].map((row) => ({
      status: String(rowValue(row, "status") ?? ""),
      exclude_from_status: rowValue(row, "exclude_from_status") === true,
      is_removed_from_compose: rowValue(row, "is_removed_from_compose") === true,
    })),
  );

/** The Service::status accessor of a service by its id (a server's resources, DP-78). */
export const serviceStatusOf = async (rows: Rows, serviceId: unknown): Promise<string> => statusOf(await partsOf(rows, serviceId));

/** The decrypted values of the service's locked variables (EnvironmentVariable::logRedactionSecretsFor()['locked']). */
async function lockedValues(tx: SqlExecutor, c: ApiV1Context, serviceId: unknown): Promise<string[]> {
  const vars = await rowsOf(tx)("environment_variables", "t.resourceable_type = $1 AND t.resourceable_id = $2 AND t.is_shown_once", [SERVICE_MORPH_CLASS, serviceId]);
  const cipher = columnCipher(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, "environment_variables.value");
  const out: string[] = [];
  for (const v of vars) {
    const stored = rowValue(v, "value");
    const value = stored === null || stored === undefined || stored === "" ? null : await cipher.decrypt(String(stored));
    if (value) out.push(value);
  }
  return out;
}

/**
 * removeSensitiveData($service): toArray() — the columns without `id` (the Compose files only for a token that may read
 * secrets), the status accessor (which loads the applications and the databases), server_status (which loads the server
 * and its settings), the destination with its server and settings when the caller loaded it (a token that may read the
 * server's secrets), the through key of the list's hasManyThrough — then serializeApiResponse() and the locked values
 * redacted from the generated Compose file.
 */
async function serviceModel(tx: SqlExecutor, c: ApiV1Context, row: ApiRow, throughKey?: unknown): Promise<PhpObject> {
  return serviceSerialization(tx, c, row, throughKey, false);
}

/**
 * A service through serializeApiResource() (GET /resources and an environment's resources, DP-78): toArray() unsorted —
 * the columns in Coolify's order (id included; the Compose files for a token that may read secrets, exposeSensitiveFields()),
 * the through key, server_status and status, then the relations in the order they loaded them (the server, the
 * applications, the databases) — and the locked values redacted from the generated Compose file.
 */
export function serviceResource(tx: SqlExecutor, c: ApiV1Context, row: ApiRow, throughKey?: unknown): Promise<PhpObject> {
  return serviceSerialization(tx, c, row, throughKey, true);
}

async function serviceSerialization(tx: SqlExecutor, c: ApiV1Context, row: ApiRow, throughKey: unknown, resource: boolean): Promise<PhpObject> {
  const rows = rowsOf(tx);
  const sensitive = c.canReadSensitive;
  const id = rowValue(row, "id");
  const parts = await partsOf(rows, id);
  const serverOf = async (serverId: unknown) => {
    const server = serverId === null || serverId === undefined ? null : ((await rows("servers", "t.deleted_at IS NULL AND t.id = $1", [serverId]))[0] ?? null);
    const settings = server ? (await rows("server_settings", "t.server_id = ANY($1)", [[rowValue(server, "id")]]))[0] : undefined;
    return { server, settings };
  };
  const own = await serverOf(rowValue(row, "server_id"));
  const extra: Array<[string, PhpValue]> = [];
  if (throughKey !== undefined) extra.push(["laravel_through_key", throughKey as PhpValue]);
  extra.push(["server_status", functional(own.server, own.settings)]);
  extra.push(["status", statusOf(parts)]);
  if (resource) extra.push(["server", own.server ? nestedServer({ ...c, canReadSensitive: false }, own.server, own.settings) : null]);
  extra.push(["applications", parts.applications.map((a) => toModel(inCoolifyOrder(a, "service_applications"), SERVICE_APPLICATION, { extra: [["url", partUrl({ fqdn: rowValue(a, "fqdn") as string | null, domain_port_overrides: rowValue(a, "domain_port_overrides") as never })]] }))]);
  extra.push(["databases", parts.databases.map((d) => toModel(inCoolifyOrder(d, "service_databases"), SERVICE_DATABASE))]);
  // The server server_status loaded: another instance than the destination's, whose secrets exposeNestedServerSecrets() made visible.
  if (!resource) extra.push(["server", own.server ? nestedServer({ ...c, canReadSensitive: false }, own.server, own.settings) : null]);
  if (sensitive && !resource) {
    // 'destination.server.settings', loaded for a token that may read the server's secrets (Swarm is not loaded: Freeploy makes none).
    const destination = rowValue(row, "destination_type") === SWARM_DOCKER ? null : ((await rows("standalone_dockers", "t.id = $1", [rowValue(row, "destination_id")]))[0] ?? null);
    const its = destination ? await serverOf(rowValue(destination, "server_id")) : { server: null, settings: undefined };
    extra.push(["destination", destination ? toModel(inCoolifyOrder(destination, "standalone_dockers"), DESTINATION, { extra: [["server", its.server ? nestedServer(c, its.server, its.settings) : null]] }) : null]);
  }
  const base = inCoolifyOrder(row, "services").filter(([k]) => resource || k !== "id");
  const model = toModel(base, SERVICE, { visible: sensitive ? ["docker_compose_raw", "docker_compose"] : [], extra });
  const out = resource ? model : serializeApiResponse(model, sensitive);
  // redactLockedApiResourceValues()
  const compose = out.entries.find(([k]) => k === "docker_compose")?.[1];
  if (typeof compose === "string" && compose.trim() !== "") put(out, "docker_compose", redactLockedValues(compose, await lockedValues(tx, c, id)));
  return out;
}

/** services(): every project of the team, each project's services (hasManyThrough its environments). */
async function listServices(c: ApiV1Context): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const out: PhpObject[] = [];
    for (const project of await rows("projects")) {
      const list = await rows("services", "t.deleted_at IS NULL AND t.environment_id IN (SELECT e.id FROM deploy.environments e WHERE e.project_id = $1)", [rowValue(project, "id")]);
      for (const row of list) out.push(await serviceModel(tx, c, row, rowValue(project, "id")));
    }
    return coolifyJson(out);
  });
}

async function showService(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const row = await serviceRow(rowsOf(tx), param(c, {}, uuid));
    if (!row) return message(NOT_FOUND, 404);
    return (await denied(c, false)) ?? coolifyJson(await serviceModel(tx, c, row));
  });
}

// ── creating and changing ───────────────────────────────────────────────────

const URL_RULES: Rules = [
  ["urls", ["array", "nullable"]],
  ["urls.*", [{ arrayKeys: ["name", "url"], message: URLS_ARRAY_MESSAGE }]],
  ["urls.*.name", ["string", "required"]],
  // ValidationPatterns::applicationDomainRules()
  ["urls.*.url", ["nullable", "string", "max:2048", { closure: (value) => validateApplicationDomains(value) }]],
];
const FLAG = (field: string): [string, readonly Rule[]] => [field, ["boolean"]];

/** The validator of create_service (both of its passes) and update_by_uuid: the rules in Coolify's order, Laravel's messages. */
async function validateService(all: Record<string, unknown>, head: Rules, tail: Rules, allowed: readonly string[]): Promise<Errors> {
  const errors: Errors = [];
  await validateRules(errors, all, head, { laravelMessages: true });
  nameRules(errors, all, "name", { required: false, nullable: false });
  descriptionRules(errors, all);
  await validateRules(errors, all, tail, { laravelMessages: true });
  extraFields(errors, all, allowed);
  return errors;
}

const CREATE_ALLOWED = ["type", "name", "description", "project_uuid", "environment_name", "environment_uuid", "server_uuid", "destination_uuid", "instant_deploy", "docker_compose_raw", "connect_to_docker_network", "urls", "force_domain_override", "is_container_label_escape_enabled", "redact_all_env_values_in_logs", "tags"];
const CREATE_TAIL: Rules = [FLAG("instant_deploy"), FLAG("connect_to_docker_network"), ...URL_RULES, FLAG("force_domain_override"), FLAG("is_container_label_escape_enabled"), FLAG("redact_all_env_values_in_logs"), ["tags", ["array", "nullable"]], ["tags.*", ["string", "min:2"]]];

/** Where the request places the service: create_service's checks, in its order. */
async function placement(tx: SqlExecutor, c: ApiV1Context, all: Record<string, unknown>) {
  const ctx = serviceContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY);
  const project = typeof all.project_uuid === "string" ? await ctx.store.findProject(all.project_uuid) : null;
  if (!project) throw new Rollback(message("Project not found.", 404));
  const environments = await rowsOf(tx)("environments", "t.project_id = $1", [project.id]);
  const env = environments.find((e) => rowValue(e, "name") === all.environment_name) ?? environments.find((e) => rowValue(e, "uuid") === all.environment_uuid);
  if (!env) throw new Rollback(message("Environment not found.", 404));
  const no = await denied(c, true);
  if (no) throw new Rollback(no);
  const server = typeof all.server_uuid === "string" ? await ctx.store.findServer(all.server_uuid) : null;
  if (!server) throw new Rollback(message("Server not found.", 404));
  if (effectiveServerRole(server) === "build") {
    throw new Rollback(coolifyJson(obj({ message: "Validation failed.", errors: obj({ server_uuid: ["The specified server is configured as a build server and cannot host resources."] }) }), 422));
  }
  const destinations = await listServerDestinations(tx, server.id);
  if (destinations.length === 0) throw new Rollback(message("Server has no destinations.", 400));
  if (destinations.length > 1 && !("destination_uuid" in all)) throw new Rollback(message("Server has multiple destinations and you do not set destination_uuid.", 400));
  let destination = destinations[0]!;
  if (destinations.length > 1) {
    const chosen = destinations.find((d) => d.uuid === all.destination_uuid);
    if (!chosen) throw new Rollback(coolifyJson(obj({ message: "Validation failed.", errors: obj({ destination_uuid: "Provided destination_uuid does not belong to the specified server." }) }), 422));
    destination = chosen;
  }
  const settings = await ctx.store.serviceServer(server.id);
  if (!settings) throw new Rollback(message("Server not found.", 404));
  const environment = { id: rowValue(env, "id") as string | number, name: String(rowValue(env, "name")) };
  return { ctx, project, environment, server, destination, settings };
}

/** A Compose file the request gives: base64 of UTF-8 text, YAML (parseDockerComposeYaml() throws: Coolify's 500), no command injection. */
function composeOf(value: unknown): string {
  const text = decodeBase64Text(value);
  if (text === null) throw new Rollback(coolifyJson(obj({ message: "Validation failed.", errors: obj({ docker_compose_raw: COMPOSE_NOT_BASE64 }) }), 422));
  parseDockerComposeYaml(text);
  injectionChecked(text);
  return text;
}

function injectionChecked(text: string): void {
  try {
    validateDockerComposeForInjection(text);
  } catch (e) {
    if (e instanceof ComposeError) throw new Rollback(coolifyJson(obj({ message: "Validation failed.", errors: obj({ docker_compose_raw: e.message }) }), 422));
    throw e;
  }
}


/** str()->random(10) */
function random10(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

/** create_service: a one-click template, or a Compose file the request gives. */
async function createService(c: ApiV1Context): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (requestBoolean(body.all, "instant_deploy") && !hasDeployAbility(c)) return ABORT_DEPLOY;
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  const head: Rules = [
    ["type", ["string", { requiredWithout: "docker_compose_raw" }]],
    ["docker_compose_raw", ["string", { requiredWithout: "type" }]],
    ["project_uuid", ["string", "required"]],
    ["environment_name", ["string", "nullable"]],
    ["environment_uuid", ["string", "nullable"]],
    ["server_uuid", ["string", "required"]],
    ["destination_uuid", ["string", "nullable"]],
  ];
  const errors = await validateService(all, head, CREATE_TAIL, CREATE_ALLOWED);
  if (errors.length) return validationFailed(errors);
  // validateTagsParameter()
  const tags = "tags" in all ? normalizeTags(all.tags) : [];
  if (tags.some((t) => [...t].length < 2)) return validationFailed([["tags", ["Each tag name must be at least 2 characters after sanitization."]]]);
  if (filled(all.type) && filled(all.docker_compose_raw)) return message("You cannot provide both service type and docker_compose_raw. Use one or the other.", 422);
  if (!filled(all.environment_uuid) && !filled(all.environment_name)) return message("You need to provide at least one of environment_name or environment_uuid.", 422);

  return inTransaction(c, async (tx) => {
    const p = await placement(tx, c, all);
    const templates = serviceTemplates();
    const type = filled(all.type) ? resolveServiceTemplateKey(String(all.type), templates) : (all.type as string | null | undefined);
    const keys = Object.keys(templates);
    let memory: MemoryServiceStore;
    let context: ServiceParserContext;
    const newUuid = () => newPublicId();
    if (typeof type === "string" && Object.hasOwn(templates, type)) {
      if (!templates[type]!.compose) return coolifyJson(obj({ message: NOT_FOUND, valid_service_types: keys }), 404);
      const created = newServiceFromTemplate({ type: `one-click-service-${type}`, uuid: newUuid() })!;
      injectionChecked(created.service.docker_compose_raw ?? "");
      if (NEEDS_TO_CONNECT_TO_PREDEFINED_NETWORK.includes(type) || requestBoolean(all, "connect_to_docker_network")) created.service.connect_to_docker_network = true;
      if (all.name !== undefined && all.name !== null) created.service.name = stripTags(String(all.name));
      if ("is_container_label_escape_enabled" in all) created.service.is_container_label_escape_enabled = requestBoolean(all, "is_container_label_escape_enabled");
      memory = MemoryServiceStore.forService(created.service);
      context = newServiceParserContext(p, newUuid);
      createServiceFromTemplate(memory, created.environment, context);
    } else if (filled(all.docker_compose_raw)) {
      // The second validation, of a Compose file.
      const second = await validateService(
        all,
        [
          ["project_uuid", ["string", "required"]],
          ["environment_name", ["string", "nullable"]],
          ["environment_uuid", ["string", "nullable"]],
          ["server_uuid", ["string", "required"]],
          ["destination_uuid", ["string"]],
        ],
        [FLAG("instant_deploy"), FLAG("connect_to_docker_network"), ["docker_compose_raw", ["string", "required"]], ...URL_RULES, FLAG("force_domain_override"), FLAG("is_container_label_escape_enabled"), FLAG("redact_all_env_values_in_logs"), ["tags", ["array", "nullable"]], ["tags.*", ["string", "min:2"]]],
        CREATE_ALLOWED.filter((k) => k !== "type"),
      );
      if (second.length) throw new Rollback(validationFailed(second));
      const raw = composeOf(all.docker_compose_raw);
      memory = MemoryServiceStore.forService({
        id: 1,
        uuid: newUuid(),
        name: all.name !== undefined && all.name !== null ? stripTags(String(all.name)) : `service-${random10()}`,
        docker_compose_raw: raw,
        docker_compose: null,
        connect_to_docker_network: phpTruthy(all.connect_to_docker_network),
        service_type: null,
        is_container_label_escape_enabled: "is_container_label_escape_enabled" in all ? requestBoolean(all, "is_container_label_escape_enabled") : true,
        compose_parsing_version: SERVICE_PARSER_VERSION,
        include_coolify_default_variables: true,
      });
      context = newServiceParserContext(p, newUuid);
      parseService(memory, context);
    } else {
      return coolifyJson(obj({ message: "Invalid service type.", valid_service_types: keys }), 404);
    }
    // An instant deploy queues StartService, which needs the SSH executor: refused before anything is stored.
    if (requestBoolean(all, "instant_deploy")) throw new Rollback(unavailable(SERVICE_CONFIGURATION_MESSAGES.start));
    // applyNewServiceUrls(): a refused url rolls the whole creation back.
    if (Array.isArray(all.urls) || (all.urls !== null && typeof all.urls === "object")) {
      const result = await applyServiceUrls(tx, memory, context, Object.values(all.urls as object), requestBoolean(all, "force_domain_override"));
      if (result) throw new Rollback(result);
    }
    const id = await insertParsedRows(p.ctx, memory, p, newUuid);
    const rest: Record<string, unknown> = {};
    if ("description" in all) rest.description = all.description === null ? null : stripTags(String(all.description));
    if ("redact_all_env_values_in_logs" in all) rest.redact_all_env_values_in_logs = requestBoolean(all, "redact_all_env_values_in_logs");
    if (Object.keys(rest).length) await serviceResourcesContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY).configuration.store.update("service", id, id, rest as never);
    for (const name of tags) await attachTagTo(tx, c, { type: SERVICE_MORPH_CLASS, id }, name);
    return coolifyJson(obj({ uuid: memory.service.uuid, domains: await domainsOf(tx, id) }), 201);
  });
}

/** $service->applications()->pluck('fqdn')->filter()->sort()->values() */
async function domainsOf(tx: SqlExecutor, serviceId: unknown): Promise<string[]> {
  const apps = await rowsOf(tx)("service_applications", "t.deleted_at IS NULL AND t.service_id = $1", [serviceId]);
  return apps
    .map((a) => rowValue(a, "fqdn"))
    .filter((f): f is string => phpTruthy(f))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** applicationDomainEntries($application): its domains, and a Compose application's per service. */
function applicationEntries(row: ApiRow): Array<{ domain: string; serviceName: string | null }> {
  const finish = (d: string) => {
    const withSlash = d.endsWith("/") ? d : `${d}/`;
    return withSlash.slice(0, withSlash.lastIndexOf("/"));
  };
  const entries = String(rowValue(row, "fqdn") ?? "")
    .split(",")
    .filter((d) => d !== "")
    .map((d) => ({ domain: finish(d), serviceName: null as string | null }));
  const composeDomains = rowValue(row, "docker_compose_domains");
  if (rowValue(row, "build_pack") !== "dockercompose" || !phpTruthy(composeDomains)) return entries;
  let parsed: unknown;
  try {
    parsed = typeof composeDomains === "string" ? JSON.parse(composeDomains) : composeDomains;
  } catch {
    return entries;
  }
  if (parsed === null || typeof parsed !== "object") return entries;
  for (const [serviceName, config] of Object.entries(parsed as Record<string, unknown>)) {
    const domain = config !== null && typeof config === "object" ? (config as Record<string, unknown>).domain : undefined;
    for (const d of String(domain ?? "").split(",")) if (d !== "") entries.push({ domain: finish(d), serviceName });
  }
  return entries;
}

/**
 * checkIfDomainIsAlreadyUsedViaAPI($domains, $teamId, $uuid): the org's applications (by name) and service applications
 * (by name) that use one of the domains, the one being changed left out. The service being created or changed is read
 * as it now stands in memory (Coolify has saved it by then).
 */
export async function domainConflicts(tx: SqlExecutor, memory: ServiceStore, wanted: string[], current: string): Promise<PhpObject[]> {
  const keys = wanted.map((d) => domainConflictKey(d.endsWith("/") ? d.slice(0, d.lastIndexOf("/")) : d));
  const rows = rowsOf(tx);
  const conflicts: PhpObject[] = [];
  const applications = (await rows("applications", "t.deleted_at IS NULL", [], "name")).filter((a) => rowValue(a, "uuid") !== current);
  for (const app of applications) {
    for (const { domain, serviceName } of applicationEntries(app)) {
      if (!keys.includes(domainConflictKey(domain))) continue;
      const name = String(rowValue(app, "name"));
      conflicts.push(
        obj({
          domain,
          resource_name: name,
          resource_uuid: rowValue(app, "uuid") as PhpValue,
          resource_type: "application",
          message: `Domain ${domain} is already in use by application '${name}'${serviceName ? ` (service: ${serviceName})` : ""}`,
          ...(serviceName ? { service_name: serviceName } : {}),
        }),
      );
    }
  }
  // The other services' applications from the database, this service's from memory; ->orderBy('name').
  const services = await rows("services", "t.deleted_at IS NULL AND t.uuid <> $1", [memory.service.uuid]);
  const serviceNames = new Map(services.map((s) => [rowValue(s, "id"), String(rowValue(s, "name"))]));
  const stored = (await rows("service_applications", "t.deleted_at IS NULL", [], "name")).filter((a) => serviceNames.has(rowValue(a, "service_id")));
  const owners = [
    ...stored.map((a) => ({ name: String(rowValue(a, "name")), uuid: String(rowValue(a, "uuid")), fqdn: rowValue(a, "fqdn") as string | null, service: serviceNames.get(rowValue(a, "service_id"))! })),
    ...memory.applications().map((a) => ({ name: a.name, uuid: a.uuid, fqdn: a.fqdn, service: memory.service.name })),
  ]
    .filter((a) => a.uuid !== current)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const app of owners) {
    if (!phpTruthy(app.fqdn)) continue;
    for (let domain of String(app.fqdn).split(",").filter((d) => d !== "")) {
      if (domain.endsWith("/")) domain = domain.slice(0, domain.lastIndexOf("/"));
      if (!keys.includes(domainConflictKey(domain))) continue;
      conflicts.push(obj({ domain, resource_name: app.service, resource_uuid: app.uuid, resource_type: "service", message: `Domain ${domain} is already in use by service '${app.service}'` }));
    }
  }
  return conflicts;
}

/**
 * applyServiceUrls(): every url checked first (applicationDomainRules, duplicates across the containers), then each
 * container's in turn — its domains checked against the org's, set (the saving hook normalizes them) and written into
 * its variables (updateCompose()). Null when every url was applied; else the 422 or 409 answer, the containers before
 * the failing one changed.
 */
async function applyServiceUrls(tx: SqlExecutor, memory: ServiceStore, context: ServiceParserContext, items: unknown[], force: boolean): Promise<CoolifyAnswer | null> {
  const get = (item: unknown, key: string): unknown => (item !== null && typeof item === "object" ? (item as Record<string, unknown>)[key] : undefined);
  const urls: string[] = [];
  for (const item of items) {
    const value = get(item, "url");
    if (!filled(value)) continue;
    let text = String(value);
    if (text.startsWith(",")) text = text.slice(1);
    if (text.endsWith(",")) text = text.slice(0, -1);
    for (const url of text.trim().split(",").map((u) => u.trim())) if (url !== "") urls.push(url);
  }
  const errors: string[] = [...validateApplicationDomains(urls.join(","))];
  const list = applicationDomainList(normalizeApplicationDomains(urls.join(",")));
  const duplicates = [...new Set(list.filter((u, i) => list.indexOf(u) !== i))];
  if (duplicates.length && !force) errors.push(`The current request contains conflicting URLs across containers: ${duplicates.join(", ")}. Use force_domain_override=true to proceed.`);
  if (errors.length) return coolifyJson(obj({ message: "Validation failed.", errors }), 422);
  const conflicts: PhpObject[] = [];
  for (const item of items) {
    const name = get(item, "name");
    const containerUrls = get(item, "url");
    if (!filled(name)) {
      errors.push("Service container name is required to apply URLs.");
      continue;
    }
    const application = memory.applications().find((a) => a.name === name);
    if (!application) {
      errors.push(`Service container with '${String(name)}' not found.`);
      continue;
    }
    let fqdn: string | null = null;
    if (filled(containerUrls)) {
      fqdn = normalizeApplicationDomains(String(containerUrls));
      const found = await domainConflicts(tx, memory, applicationDomainList(fqdn), application.uuid);
      if (found.length && !force) {
        conflicts.push(...found);
        continue;
      }
    }
    setServiceApplicationFqdn(application, fqdn);
    updateServiceCompose(memory, context, { kind: "application", row: application });
  }
  if (errors.length) return coolifyJson(obj({ message: "Validation failed.", errors }), 422);
  if (conflicts.length) {
    return coolifyJson(obj({ message: "Domain conflicts detected. Use force_domain_override=true to proceed.", conflicts, warning: "Using the same domain for multiple resources can cause routing conflicts and unpredictable behavior." }), 409);
  }
  return null;
}

const UPDATE_ALLOWED = ["name", "description", "instant_deploy", "docker_compose_raw", "connect_to_docker_network", "urls", "force_domain_override", "is_container_label_escape_enabled", "redact_all_env_values_in_logs", "include_coolify_default_variables"];

/** update_by_uuid: the columns the request names, the service parsed again, then its urls. */
async function updateService(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  return inTransaction(c, async (tx) => {
    const row = await serviceRow(rowsOf(tx), param(c, all, uuid));
    if (!row) return message(NOT_FOUND, 404);
    const no = await denied(c, true);
    if (no) return no;
    if (requestBoolean(all, "instant_deploy") && !hasDeployAbility(c)) return ABORT_DEPLOY;
    const errors = await validateService(
      all,
      [],
      [FLAG("instant_deploy"), FLAG("connect_to_docker_network"), ["docker_compose_raw", ["string", "nullable"]], ...URL_RULES, FLAG("force_domain_override"), FLAG("is_container_label_escape_enabled"), FLAG("redact_all_env_values_in_logs"), FLAG("include_coolify_default_variables")],
      UPDATE_ALLOWED,
    );
    if (errors.length) return validationFailed(errors);
    const raw = "docker_compose_raw" in all ? composeOf(all.docker_compose_raw) : null;
    // An instant deploy queues StartService, which needs the SSH executor: refused before anything is stored.
    if (phpTruthy(all.instant_deploy)) return unavailable(SERVICE_CONFIGURATION_MESSAGES.start);

    const resources = serviceResourcesContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY);
    const store = resources.configuration.store;
    const configured = (await store.find(String(rowValue(row, "uuid"))))!;
    const loaded = await loadServiceRows(store, configured, resources.configuration.ciphers);
    const memory = loaded.store;
    if (raw !== null) memory.service.docker_compose_raw = raw;
    if ("name" in all) memory.service.name = stripTags(String(all.name));
    if ("connect_to_docker_network" in all) memory.service.connect_to_docker_network = phpTruthy(all.connect_to_docker_network);
    if ("is_container_label_escape_enabled" in all) memory.service.is_container_label_escape_enabled = requestBoolean(all, "is_container_label_escape_enabled");
    if ("include_coolify_default_variables" in all) memory.service.include_coolify_default_variables = requestBoolean(all, "include_coolify_default_variables");
    const context = serviceParserContext(configured);
    parseService(memory, context);
    let answer: CoolifyAnswer | null = null;
    if (Array.isArray(all.urls) || (all.urls !== null && typeof all.urls === "object")) answer = await applyServiceUrls(tx, memory, context, Object.values(all.urls as object), requestBoolean(all, "force_domain_override"));
    await writeServiceRows(store, loaded, resources.configuration.ciphers);
    const id = rowValue(row, "id") as string | number;
    const rest: Record<string, unknown> = {};
    if ("description" in all) rest.description = all.description === null ? null : stripTags(String(all.description));
    if ("redact_all_env_values_in_logs" in all) rest.redact_all_env_values_in_logs = requestBoolean(all, "redact_all_env_values_in_logs");
    if ("include_coolify_default_variables" in all) rest.include_coolify_default_variables = memory.service.include_coolify_default_variables;
    if (Object.keys(rest).length) await store.update("service", id, id, rest as never);
    return answer ?? coolifyJson(obj({ uuid: rowValue(row, "uuid") as PhpValue, domains: await domainsOf(tx, id) }), 200);
  });
}

/**
 * delete_by_uuid: Coolify soft-deletes the service and queues DeleteResourceJob; Freeploy removes the rows of a service
 * none of whose parts ever ran at once (deleteServiceNow()) and answers 501 for any other.
 */
async function deleteService(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const row = await serviceRow(rowsOf(tx), param(c, {}, uuid));
    if (!row) return message(NOT_FOUND, 404);
    const no = await denied(c, true);
    if (no) return no;
    if (queryBoolean(c.url, "delete_from_coolify_only", false)) {
      return message("The delete_from_coolify_only parameter is no longer supported. Nothing was deleted. Send the request without it: Coolify removes the service also when the server is not reachable.", 422);
    }
    try {
      await deleteServiceNow(serviceResourcesContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY), String(rowValue(row, "uuid")));
    } catch (e) {
      if (e instanceof ServiceConfigurationError) return unavailable(e.message);
      throw e;
    }
    return message("Service deletion request queued.", 200);
  });
}

/** action_deploy, action_stop, action_restart: what Coolify queues runs on the server (501), after its own checks of the status. */
async function action(c: ApiV1Context, uuid: string, which: "start" | "restart" | "stop"): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const row = await serviceRow(rows, param(c, {}, uuid));
    if (!row) return message(NOT_FOUND, 404);
    const no = await denied(c, true);
    if (no) return no;
    const status = statusOf(await partsOf(rows, rowValue(row, "id")));
    if (which === "start") return status.includes("running") ? message("Service is already running.", 400) : unavailable(SERVICE_CONFIGURATION_MESSAGES.start);
    if (which === "stop") return status.includes("stopped") || status.includes("exited") ? message("Service is already stopped.", 400) : unavailable(SERVICE_CONFIGURATION_MESSAGES.stop);
    return unavailable(SERVICE_CONFIGURATION_MESSAGES.restart);
  });
}

// ── environment variables ───────────────────────────────────────────────────

type EnvResource = DeployEnvironmentVariableResourceRow;
const SERVICE_ENV_FIELDS = ["key", "value", "is_literal", "is_multiline", "is_shown_once", "comment"] as const;
const SERVICE_ENV_FLAGS = ["is_literal", "is_multiline", "is_shown_once"];
/** What EnvironmentVariable::create() has just set besides the request's fields: the creating hook's version, the defaults, the uuid and the timestamps. */
const CREATED_DEFAULTS = ["version", "is_runtime", "is_buildtime", "uuid", "created_at", "updated_at"];

async function serviceVariables(tx: SqlExecutor, serviceId: unknown): Promise<ApiRow[]> {
  return rowsOf(tx)("environment_variables", "t.resourceable_type = $1 AND t.resourceable_id = $2", [SERVICE_MORPH_CLASS, serviceId]);
}

/** The service and the variables' resource, for the routes that read the uuid from the route. */
async function envTarget(tx: SqlExecutor, c: ApiV1Context, uuid: string): Promise<{ row: ApiRow; resource: EnvResource } | null> {
  const row = await serviceRow(rowsOf(tx), uuid);
  if (!row) return null;
  const resource = await environmentVariableContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, "service").store.findResource(String(rowValue(row, "uuid")));
  return resource ? { row, resource } : null;
}

const envModel = (tx: SqlExecutor, c: ApiV1Context, resource: EnvResource, row: ApiRow, list = false, created?: readonly string[]) =>
  variableModel(tx, c, resource, row, list, created !== undefined, "service", created ?? []);

async function listEnvs(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const target = await envTarget(tx, c, String(param(c, {}, uuid)));
    if (!target) return message(NOT_FOUND, 404);
    const no = await denied(c, true);
    if (no) return no;
    const out: PhpObject[] = [];
    for (const v of await serviceVariables(tx, rowValue(target.row, "id"))) out.push(await envModel(tx, c, target.resource, v, true));
    return coolifyJson(out);
  });
}

/** EnvironmentVariable::create() of a service's variable: the fields the controller gives, the model's defaults for the rest. */
async function createServiceVariable(tx: SqlExecutor, c: ApiV1Context, resource: EnvResource, key: string, fields: Record<string, unknown>): Promise<ApiRow> {
  const ctx = environmentVariableContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, "service");
  const flag = (k: string) => (k in fields ? phpTruthy(fields[k]) : false);
  const created = await createVariable(ctx, resource, {
    key,
    value: (fields.value as string | null | undefined) ?? null,
    comment: (fields.comment as string | null | undefined) ?? null,
    order: null,
    isPreview: false,
    isLiteral: flag("is_literal"),
    isMultiline: flag("is_multiline"),
    isShownOnce: flag("is_shown_once"),
    isRuntime: true,
    isBuildtime: true,
    isRequired: false,
  });
  return (await rowsOf(tx)("environment_variables", "t.id = $1", [created.id]))[0]!;
}

/** $env->value = …, is_literal, is_multiline, is_shown_once, comment as the request has them; saved, and read again. */
async function saveServiceVariable(tx: SqlExecutor, c: ApiV1Context, row: ApiRow, fields: Record<string, unknown>): Promise<ApiRow> {
  const ctx = environmentVariableContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, "service");
  const changes: VariableChanges = {};
  if ("value" in fields) changes.value = fields.value as string | null;
  if ("is_literal" in fields) changes.isLiteral = phpTruthy(fields.is_literal);
  if ("is_multiline" in fields) changes.isMultiline = phpTruthy(fields.is_multiline);
  if ("is_shown_once" in fields) changes.isShownOnce = phpTruthy(fields.is_shown_once);
  if ("comment" in fields) changes.comment = fields.comment as string | null;
  const env = Object.fromEntries(row) as never;
  await saveVariable(ctx, env, await storedValue(ctx, env), changes);
  return (await rowsOf(tx)("environment_variables", "t.id = $1", [rowValue(row, "id")]))[0]!;
}

function variableError(e: unknown): CoolifyAnswer {
  if (e instanceof EnvironmentVariableError) return e.field ? validationFailed([[e.field, [e.message]]]) : message(e.message, e.status);
  throw e;
}

async function createEnv(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  return c.sql(c.env, c.orgId, async (tx) => {
    const target = await envTarget(tx, c, uuid);
    if (!target) return message(NOT_FOUND, 404);
    const no = await denied(c, true);
    if (no) return no;
    const all = normalizedKey(body.all);
    const errors = validateVariable(all, SERVICE_ENV_FLAGS);
    if (errors.length) return validationFailed(errors);
    const key = lookupKey(all.key);
    if ((await serviceVariables(tx, rowValue(target.row, "id"))).some((v) => rowValue(v, "key") === key)) return message("Environment variable already exists. Use PATCH request to update it.", 409);
    try {
      const fields = { value: all.value ?? null, is_literal: all.is_literal ?? false, is_multiline: all.is_multiline ?? false, is_shown_once: all.is_shown_once ?? false, comment: all.comment ?? null };
      const created = await createServiceVariable(tx, c, target.resource, key, fields);
      return coolifyJson(await envModel(tx, c, target.resource, created, false, ["key", ...Object.keys(fields), ...CREATED_DEFAULTS]), 201);
    } catch (e) {
      return variableError(e);
    }
  });
}

async function updateEnv(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  return c.sql(c.env, c.orgId, async (tx) => {
    const target = await envTarget(tx, c, uuid);
    if (!target) return message(NOT_FOUND, 404);
    const no = await denied(c, true);
    if (no) return no;
    const all = normalizedKey(body.all);
    const errors = validateVariable(all, SERVICE_ENV_FLAGS);
    if (errors.length) return validationFailed(errors);
    const found = (await serviceVariables(tx, rowValue(target.row, "id"))).find((v) => rowValue(v, "key") === lookupKey(all.key));
    if (!found) return message("Environment variable not found.", 404);
    try {
      return coolifyJson(await envModel(tx, c, target.resource, await saveServiceVariable(tx, c, found, all)), 201);
    } catch (e) {
      return variableError(e);
    }
  });
}

/** create_bulk_envs: each item's fields validated, then updated (the key exists) or created, in order; an invalid item stops there. */
async function bulkEnvs(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  return c.sql(c.env, c.orgId, async (tx) => {
    const target = await envTarget(tx, c, uuid);
    if (!target) return message(NOT_FOUND, 404);
    const no = await denied(c, true);
    if (no) return no;
    const data = body.all.data;
    if (!phpTruthy(data)) return message("Bulk data is required.", 400);
    const items = (Array.isArray(data) ? data : typeof data === "object" && data !== null ? Object.values(data) : [data]).map((item) => {
      const fields = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
      return normalizedKey(Object.fromEntries(Object.entries(fields).filter(([k]) => (SERVICE_ENV_FIELDS as readonly string[]).includes(k))));
    });
    const out: PhpObject[] = [];
    for (const item of items) {
      const errors = validateVariable(item, SERVICE_ENV_FLAGS);
      if (errors.length) return validationFailed(errors);
      const key = lookupKey(item.key);
      const existing = (await serviceVariables(tx, rowValue(target.row, "id"))).find((v) => rowValue(v, "key") === key);
      try {
        if (existing) out.push(await envModel(tx, c, target.resource, await saveServiceVariable(tx, c, existing, item)));
        else {
          const fields = Object.fromEntries(Object.entries(item).filter(([k]) => k !== "key"));
          out.push(await envModel(tx, c, target.resource, await createServiceVariable(tx, c, target.resource, key, fields), false, ["key", ...Object.keys(fields), ...CREATED_DEFAULTS]));
        }
      } catch (e) {
        return variableError(e);
      }
    }
    return coolifyJson(out, 201);
  });
}

async function deleteEnv(c: ApiV1Context, uuid: string, envUuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const target = await envTarget(tx, c, uuid);
    if (!target) return message(NOT_FOUND, 404);
    const no = await denied(c, true);
    if (no) return no;
    const found = (await serviceVariables(tx, rowValue(target.row, "id"))).find((v) => rowValue(v, "uuid") === envUuid);
    if (!found) return message("Environment variable not found.", 404);
    await environmentVariableContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, "service").store.delete([rowValue(found, "id") as string | number]);
    return message("Environment variable deleted.", 200);
  });
}
