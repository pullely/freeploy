// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/{ServiceApplicationsController,ServiceDatabasesController}.php
// (removeSensitiveData, resolveService, resolveServiceApplicationForService, resolveServiceDatabase, index, show, update,
// logs_by_uuid, logs, action_start, action_restart, action_stop, start, restart, stop, resolveDatabaseRequest),
// app/Http/Controllers/Api/OtherController.php (post_required), app/Http/Controllers/Api/Concerns/RequiresDeployAbility.php,
// app/Actions/Service/UpdateServiceApplicationFromApi.php, app/Support/{ServiceComposeUrl,DomainPortOverrides}.php,
// app/Traits/HasNoindexDomains.php, app/Models/{ServiceApplication,ServiceDatabase}.php ($casts, $appends, the saving hook)
// and bootstrap/helpers/{services.php (updateCompose),databases.php (isPublicPortAlreadyUsed)} (Apache-2.0), modified.
//
// Coolify's /api/v1 for a service's applications and databases (DP-85), on DP-66's service rows and DP-74's helpers: a
// part is listed and shown as the model serializes (the hidden columns, the `url` a service application appends), and
// updated as the controller and UpdateServiceApplicationFromApi update it — the url checked (ServiceComposeUrl, the org's
// domains), set as setEditableUrls() sets it, the noindex flags, the redirect, the switches — then saved (the saving hook's
// port overrides and flags) and written into the Compose file and the part's variables (updateCompose(), DP-74's port).
// What runs on the server answers 501 in Coolify's envelope after Coolify's own refusals and before anything is stored:
// starting, restarting and stopping a part of a functional server, its container logs, and the TCP proxy a database's
// is_public starts or stops. A service database's imports are database-imports.ts' (DP-88).
import type { SqlExecutor } from "@saas/db/hyperdrive";
import type { ApiRow } from "@saas/db/deploy";
import { databasePublicPortTaken } from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, obj, serializeApiResponse, type CoolifyAnswer, type PhpObject } from "@saas/contracts/coolify-api";
import { serviceResourcesContext } from "../handlers/service-configuration.js";
import { applicationDomainList, normalizeDomainPortOverrides, syncNoindexDomains, validateApplicationDomains } from "../applications/domains.js";
import { needsExecutor } from "../applications/resources.js";
import { partUrl, serviceParserContext } from "../services/configuration.js";
import { updateServiceCompose } from "../services/parser.js";
import { loadServiceRows, writeServiceRows } from "../services/rows.js";
import type { ServiceApplicationRow, ServiceDatabaseRow } from "../services/store.js";
import { functional } from "./applications.js";
import { inCoolifyOrder } from "./columns.js";
import { hasDeployAbility, message, rowsOf, unavailable, type ApiV1Context, type Rows } from "./context.js";
import { SERVICE_APPLICATION, SERVICE_DATABASE, rowValue, toModel } from "./models.js";
import { addError, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rule, type Rules } from "./rules.js";
import { domainConflicts } from "./services.js";

export type ServicePartKind = "application" | "database";

export const SERVICE_PARTS_API_MESSAGES = {
  serviceNotFound: "Service not found.",
  applicationNotFound: "Service application not found.",
  databaseNotFound: "Service database not found.",
  notFunctional: "Server is not functional.",
  swarm: "This operation is not supported for Swarm servers yet.",
  logDrain: "Log drain is not enabled on the server for this service.",
  redirect: "The www and non-www redirects need both a www and a non-www domain in url.",
  publicPortRequired: "A public port is required when the database is public.",
  publicPortUsed: "Public port already used by another database.",
  deployForPublic: "Missing required permissions: deploy. Making a database public or private starts or stops its proxy on the server, so it needs a token with the deploy permission.",
  /** Freeploy's: what Coolify queues or runs runs on the server. */
  application: { start: needsExecutor("Deploying the service application"), restart: needsExecutor("Restarting the service application"), stop: needsExecutor("Stopping the service application"), logs: needsExecutor("Reading the service application's container logs") },
  database: { start: needsExecutor("Deploying the service database"), restart: needsExecutor("Restarting the service database"), stop: needsExecutor("Stopping the service database"), logs: needsExecutor("Reading the service database's container logs") },
  proxyStart: needsExecutor("Starting the database's public proxy"),
  proxyStop: needsExecutor("Stopping the database's public proxy"),
} as const;

const SWARM_DOCKER = "App\\Models\\SwarmDocker";
const ACTIONS = ["start", "restart", "stop"] as const;

/** routes/api.php's /services/{uuid}/applications and /services/{uuid}/databases routes; null for any other path. */
export async function servicePartsApi(c: ApiV1Context, kind: ServicePartKind, serviceUuid: string, segments: string[]): Promise<CoolifyAnswer | null> {
  const [partUuid, sub, extra] = segments;
  const m = c.method;
  if (extra !== undefined) return null;
  if (partUuid === undefined) return m === "GET" ? listParts(c, kind, serviceUuid) : null;
  if (sub === undefined) return m === "GET" ? showPart(c, kind, serviceUuid, partUuid) : m === "PATCH" ? (kind === "application" ? updateApplication(c, serviceUuid, partUuid) : updateDatabase(c, serviceUuid, partUuid)) : null;
  if (sub === "logs") return m === "GET" || (m === "POST" && kind === "application") ? partRequest(c, kind, serviceUuid, partUuid, "logs") : null;
  if ((ACTIONS as readonly string[]).includes(sub)) {
    // OtherController::post_required(): only a service application's actions have the GET route.
    if (m === "GET" && kind === "application") return message("This endpoint has changed to a POST request.", 405);
    if (m === "POST") return partRequest(c, kind, serviceUuid, partUuid, sub as (typeof ACTIONS)[number]);
  }
  return null;
}

// ── reading ─────────────────────────────────────────────────────────────────

/** Service::whereRelation('environment.project.team', 'id', $teamId)->whereUuid(): the org's service, not deleted. */
async function serviceRow(rows: Rows, uuid: string): Promise<ApiRow | null> {
  return (await rows("services", "t.deleted_at IS NULL AND t.uuid = $1", [uuid]))[0] ?? null;
}

const partTable = (kind: ServicePartKind) => (kind === "application" ? "service_applications" : "service_databases");

/** $service->applications() / databases(), not deleted, in id order (or the one with the uuid). */
async function partRows(rows: Rows, kind: ServicePartKind, serviceId: unknown, uuid?: string): Promise<ApiRow[]> {
  return rows(partTable(kind), `t.deleted_at IS NULL AND t.service_id = $1${uuid === undefined ? "" : " AND t.uuid = $2"}`, uuid === undefined ? [serviceId] : [serviceId, uuid]);
}

/** removeSensitiveData(): id and the relations hidden (a database's service_id too), the application's `url`, serializeApiResponse(). */
function serialize(kind: ServicePartKind, row: ApiRow): PhpObject {
  if (kind === "application") {
    const url = partUrl({ fqdn: rowValue(row, "fqdn") as string | null, domain_port_overrides: rowValue(row, "domain_port_overrides") as never });
    return serializeApiResponse(toModel(inCoolifyOrder(row, "service_applications").filter(([k]) => k !== "id"), SERVICE_APPLICATION, { extra: [["url", url]] }));
  }
  return serializeApiResponse(toModel(inCoolifyOrder(row, "service_databases").filter(([k]) => k !== "id" && k !== "service_id"), SERVICE_DATABASE));
}

const notFoundOf = (kind: ServicePartKind) => message(kind === "application" ? SERVICE_PARTS_API_MESSAGES.applicationNotFound : SERVICE_PARTS_API_MESSAGES.databaseNotFound, 404);
const denied = async (c: ApiV1Context, write: boolean): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized());

async function listParts(c: ApiV1Context, kind: ServicePartKind, serviceUuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const service = await serviceRow(rows, serviceUuid);
    if (!service) return message(SERVICE_PARTS_API_MESSAGES.serviceNotFound, 404);
    const no = await denied(c, false);
    if (no) return no;
    return coolifyJson((await partRows(rows, kind, rowValue(service, "id"))).map((row) => serialize(kind, row)));
  });
}

/** resolveService(), then the part of that service: the answers of either missing. */
async function lookup(tx: SqlExecutor, kind: ServicePartKind, serviceUuid: string, partUuid: string): Promise<{ service: ApiRow; part: ApiRow } | CoolifyAnswer> {
  const rows = rowsOf(tx);
  const service = await serviceRow(rows, serviceUuid);
  if (!service) return message(SERVICE_PARTS_API_MESSAGES.serviceNotFound, 404);
  const part = (await partRows(rows, kind, rowValue(service, "id"), partUuid))[0];
  return part ? { service, part } : notFoundOf(kind);
}
const isAnswer = (v: unknown): v is CoolifyAnswer => typeof v === "object" && v !== null && "status" in v && "body" in v;

async function showPart(c: ApiV1Context, kind: ServicePartKind, serviceUuid: string, partUuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const found = await lookup(tx, kind, serviceUuid, partUuid);
    if (isAnswer(found)) return found;
    return (await denied(c, false)) ?? coolifyJson(serialize(kind, found.part));
  });
}

/** $serviceApplication->service->destination->server and its settings. */
async function serverOf(rows: Rows, service: ApiRow): Promise<{ server: ApiRow | null; settings: ApiRow | undefined; swarmDestination: boolean }> {
  const swarmDestination = rowValue(service, "destination_type") === SWARM_DOCKER;
  const destination = (await rows(swarmDestination ? "swarm_dockers" : "standalone_dockers", "t.id = $1", [rowValue(service, "destination_id")]))[0];
  const serverId = destination ? rowValue(destination, "server_id") : null;
  const server = serverId === null || serverId === undefined ? null : ((await rows("servers", "t.id = $1", [serverId]))[0] ?? null);
  const settings = server ? (await rows("server_settings", "t.server_id = $1", [rowValue(server, "id")]))[0] : undefined;
  return { server, settings, swarmDestination };
}

/**
 * logs_by_uuid / logs, action_start, action_restart, action_stop / start, restart, stop: the part, the policy, a Swarm
 * server's 501, a server that is not functional; then what Coolify runs on the server (Freeploy's 501).
 */
async function partRequest(c: ApiV1Context, kind: ServicePartKind, serviceUuid: string, partUuid: string, what: "logs" | (typeof ACTIONS)[number]): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const found = await lookup(tx, kind, serviceUuid, partUuid);
    if (isAnswer(found)) return found;
    const no = await denied(c, what !== "logs");
    if (no) return no;
    const { server, settings } = await serverOf(rowsOf(tx), found.service);
    if (settings && (rowValue(settings, "is_swarm_manager") === true || rowValue(settings, "is_swarm_worker") === true)) return message(SERVICE_PARTS_API_MESSAGES.swarm, 501);
    if (!functional(server, settings)) return message(SERVICE_PARTS_API_MESSAGES.notFunctional, 400);
    return unavailable(SERVICE_PARTS_API_MESSAGES[kind][what]);
  });
}

// ── updating ────────────────────────────────────────────────────────────────

/** FILTER_VALIDATE_BOOLEAN */
const filterBool = (v: unknown): boolean => v === true || v === 1 || (typeof v === "string" && ["1", "true", "on", "yes"].includes(v.trim().toLowerCase()));
/** filled() */
const filled = (v: unknown): boolean => !(v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0));
/** Rule::enum(RedirectTypes::class) */
const redirectRule: Rule = { closure: (v) => (typeof v === "string" && ["both", "www", "non-www"].includes(v) ? [] : ["The selected redirect is invalid."]) };

/** ValidationPatterns::applicationDomainRules(): nullable|string|max:2048 and validateApplicationDomains(). */
const URL_RULES: Rule[] = ["nullable", "string", "max:2048", { closure: (v) => validateApplicationDomains(v) }];

const APPLICATION_FIELDS = ["url", "noindex_domains", "human_name", "description", "image", "exclude_from_status", "is_log_drain_enabled", "is_gzip_enabled", "traefik_certificate_resolver", "is_stripprefix_enabled", "is_force_https_enabled", "is_permanent_redirect_enabled", "redirect", "max_restart_count"];
const APPLICATION_RULES: Rules = [
  ["url", URL_RULES],
  ["noindex_domains", ["array", "nullable"]],
  ["noindex_domains.*", ["string"]],
  ["human_name", ["nullable", "string", "max:255"]],
  ["description", ["nullable", "string"]],
  ["image", ["nullable", "string"]],
  ["exclude_from_status", ["boolean"]],
  ["is_log_drain_enabled", ["boolean"]],
  ["is_gzip_enabled", ["boolean"]],
  ["traefik_certificate_resolver", ["nullable", "string", "max:255", { regex: /^[A-Za-z0-9_-]+$/ }]],
  ["is_stripprefix_enabled", ["boolean"]],
  ["is_force_https_enabled", ["boolean"]],
  ["is_permanent_redirect_enabled", ["boolean"]],
  ["redirect", [redirectRule]],
  ["max_restart_count", ["integer", "min:0"]],
];

const DATABASE_FIELDS = ["human_name", "description", "image", "exclude_from_status", "is_log_drain_enabled", "is_public", "public_port", "public_port_timeout"];
const DATABASE_RULES: Rules = [
  ["human_name", ["nullable", "string", "max:255"]],
  ["description", ["nullable", "string"]],
  ["image", ["string"]],
  ["exclude_from_status", ["boolean"]],
  ["is_log_drain_enabled", ["boolean"]],
  ["is_public", ["boolean"]],
  ["public_port", ["nullable", "integer", "min:1", "max:65535"]],
  ["public_port_timeout", ["nullable", "integer", "min:1"]],
];

/** Validator::make($payload, …) with Laravel's messages, then every field that is not allowed. */
async function validatePayload(all: Record<string, unknown>, rules: Rules, allowed: readonly string[]): Promise<CoolifyAnswer | null> {
  const errors: Errors = [];
  await validateRules(errors, all, rules, { laravelMessages: true });
  for (const k of Object.keys(all)) if (!allowed.includes(k)) addError(errors, k, "This field is not allowed.");
  return errors.length ? validationFailed(errors) : null;
}

/** One transaction; every refusal is answered before anything is written. */
const inTransaction = (c: ApiV1Context, fn: (tx: SqlExecutor) => Promise<CoolifyAnswer>): Promise<CoolifyAnswer> => c.sql(c.env, c.orgId, fn);

/** The service's rows in memory (DP-66's loader), the part's row among them, and how to write them back. */
async function loadParts(tx: SqlExecutor, c: ApiV1Context, service: ApiRow) {
  const resources = serviceResourcesContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY);
  const store = resources.configuration.store;
  const configured = (await store.find(String(rowValue(service, "uuid"))))!;
  const loaded = await loadServiceRows(store, configured, resources.configuration.ciphers);
  return { store, loaded, context: serviceParserContext(configured), write: () => writeServiceRows(store, loaded, resources.configuration.ciphers) };
}

/** UpdateServiceApplicationFromApi::hasWwwAndNonWwwDomains() */
function hasWwwAndNonWww(fqdn: string | null): boolean {
  const hosts = (fqdn ?? "")
    .split(",")
    .map((u) => {
      const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/.exec(u.trim());
      return (m?.[1] ?? "").toLowerCase();
    })
    .filter((h) => h !== "");
  return hosts.some((h) => h.startsWith("www.")) && hosts.some((h) => !h.startsWith("www."));
}

/** ServiceComposeUrl::validateUrlString(): the urls' errors (validateApplicationDomains(), duplicates), or the normalized list. */
function validateUrlString(value: string | null, force: boolean): { errors: string[]; normalized: string | null } {
  if (value === null || value === "") return { errors: [], normalized: null };
  let v = value;
  if (v.startsWith(",")) v = v.slice(1);
  if (v.endsWith(",")) v = v.slice(0, -1);
  const urls = v
    .trim()
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u !== "" && u !== "0");
  const errors = validateApplicationDomains(urls.join(","));
  const duplicates = [...new Set(urls.filter((u, i) => urls.indexOf(u) !== i))];
  if (duplicates.length && !force) errors.push(`The current request contains duplicate URLs: ${duplicates.join(", ")}. Use force_domain_override=true to proceed.`);
  if (errors.length) return { errors, normalized: null };
  const normalized = [...new Set(urls.map((u) => u.toLowerCase()))].filter(filled).join(",");
  return { errors: [], normalized: normalized !== "" ? normalized : null };
}

/** HasNoindexDomains::setNoindexDomains(): the flags of the part's own domains, normalized, once each. */
const noindexFlags = (domains: unknown, fqdn: string | null): string[] => syncNoindexDomains(Array.isArray(domains) ? domains : [], fqdn) ?? [];

/** update (ServiceApplicationsController) and UpdateServiceApplicationFromApi::execute(). */
async function updateApplication(c: ApiV1Context, serviceUuid: string, partUuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const payload = body.all;
  return inTransaction(c, async (tx) => {
    const found = await lookup(tx, "application", serviceUuid, partUuid);
    if (isAnswer(found)) return found;
    const no = await denied(c, true);
    if (no) return no;
    const invalid = await validatePayload(payload, APPLICATION_RULES, APPLICATION_FIELDS);
    if (invalid) return invalid;

    // $request->boolean('force_domain_override'): the query string (the body may not carry it).
    const forceQuery = c.url.searchParams.get("force_domain_override");
    const force = forceQuery !== null && filterBool(forceQuery);
    const parts = await loadParts(tx, c, found.service);
    const memory = parts.loaded.store;
    const app = memory.applications().find((a) => a.uuid === partUuid) as ServiceApplicationRow;
    const fqdnBefore = app.fqdn;
    const extra: Record<string, unknown> = {};

    if ("url" in payload) {
      const parsed = validateUrlString(typeof payload.url === "string" ? payload.url : null, force);
      if (parsed.errors.length) return coolifyJson(obj({ message: "Validation failed.", errors: parsed.errors }), 422);
      if (parsed.normalized !== null) {
        const conflicts = await domainConflicts(tx, memory, applicationDomainList(parsed.normalized), app.uuid);
        if (conflicts.length && !force) {
          return coolifyJson(obj({ message: "Domain conflicts detected. Use force_domain_override=true to proceed.", conflicts, warning: "Using the same domain for multiple resources can cause routing conflicts and unpredictable behavior." }), 409);
        }
      }
      // setEditableUrls(): DomainPortOverrides::normalize($urls, null).
      const normalized = normalizeDomainPortOverrides(parsed.normalized, null);
      app.fqdn = normalized.fqdn;
      app.domain_port_overrides = normalized.overrides;
    }
    if ("noindex_domains" in payload) app.noindex_domains = noindexFlags(payload.noindex_domains, app.fqdn);
    if ("redirect" in payload) {
      if ((payload.redirect === "www" || payload.redirect === "non-www") && !hasWwwAndNonWww(app.fqdn)) {
        return coolifyJson(obj({ message: "Validation failed.", errors: obj({ redirect: [SERVICE_PARTS_API_MESSAGES.redirect] }) }), 422);
      }
      app.redirect = String(payload.redirect);
    }
    if ("human_name" in payload) app.human_name = payload.human_name as string | null;
    if ("description" in payload) extra.description = payload.description;
    if ("image" in payload) app.image = payload.image as string | null;
    if ("exclude_from_status" in payload) app.exclude_from_status = filterBool(payload.exclude_from_status);
    if ("is_gzip_enabled" in payload) app.is_gzip_enabled = filterBool(payload.is_gzip_enabled);
    if ("traefik_certificate_resolver" in payload) app.traefik_certificate_resolver = filled(payload.traefik_certificate_resolver) ? String(payload.traefik_certificate_resolver) : null;
    if ("is_stripprefix_enabled" in payload) app.is_stripprefix_enabled = filterBool(payload.is_stripprefix_enabled);
    if ("is_force_https_enabled" in payload) app.is_force_https_enabled = filterBool(payload.is_force_https_enabled);
    if ("is_permanent_redirect_enabled" in payload) app.is_permanent_redirect_enabled = filterBool(payload.is_permanent_redirect_enabled);
    if ("max_restart_count" in payload) {
      extra.max_restart_count = payload.max_restart_count === null ? null : Number(payload.max_restart_count);
      extra.restart_limit_reached = false;
    }
    if ("is_log_drain_enabled" in payload) {
      const enabled = filterBool(payload.is_log_drain_enabled);
      const { settings } = await serverOf(rowsOf(tx), found.service);
      if (enabled && !serverLogDrainEnabled(settings)) return coolifyJson(obj({ message: "Validation failed.", errors: obj({ is_log_drain_enabled: [SERVICE_PARTS_API_MESSAGES.logDrain] }) }), 422);
      app.is_log_drain_enabled = enabled;
    }
    // save(): the saving hook — a changed fqdn normalizes its port overrides and keeps only its own noindex flags.
    if (app.fqdn !== fqdnBefore) {
      const normalized = normalizeDomainPortOverrides(app.fqdn, app.domain_port_overrides);
      app.fqdn = normalized.fqdn;
      app.domain_port_overrides = normalized.overrides;
      const flags = syncNoindexDomains(app.noindex_domains, app.fqdn);
      if (flags !== undefined) app.noindex_domains = flags;
    }
    // updateCompose($serviceApplication): the image into the Compose file, the part's SERVICE_URL_* / SERVICE_FQDN_* variables.
    updateServiceCompose(memory, parts.context, { kind: "application", row: app });
    await parts.write();
    const id = rowValue(found.part, "id") as string | number;
    const changed = Object.fromEntries(Object.entries(extra).filter(([k, v]) => rowValue(found.part, k) !== v));
    if (Object.keys(changed).length) await parts.store.update("application", rowValue(found.service, "id") as string | number, id, changed);
    const refreshed = (await partRows(rowsOf(tx), "application", rowValue(found.service, "id"), partUuid))[0]!;
    return coolifyJson(serialize("application", refreshed));
  });
}

/** Server::isLogDrainEnabled(): a Fluent Bit drain or CloudWatch. */
function serverLogDrainEnabled(settings: ApiRow | undefined): boolean {
  if (!settings) return false;
  return ["is_logdrain_newrelic_enabled", "is_logdrain_highlight_enabled", "is_logdrain_axiom_enabled", "is_logdrain_custom_enabled", "is_logdrain_cloudwatch_enabled"].some((k) => rowValue(settings, k) === true);
}

/** (bool) of a request value */
const phpBool = (v: unknown): boolean => !(v === undefined || v === null || v === false || v === 0 || v === "" || v === "0");

/** update (ServiceDatabasesController) */
async function updateDatabase(c: ApiV1Context, serviceUuid: string, partUuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const payload = body.all;
  return inTransaction(c, async (tx) => {
    const found = await lookup(tx, "database", serviceUuid, partUuid);
    if (isAnswer(found)) return found;
    const no = await denied(c, true);
    if (no) return no;
    const invalid = await validatePayload(payload, DATABASE_RULES, DATABASE_FIELDS);
    if (invalid) return invalid;
    const wasPublic = rowValue(found.part, "is_public") === true;
    if ("is_public" in payload && phpBool(payload.is_public) !== wasPublic && !hasDeployAbility(c)) return message(SERVICE_PARTS_API_MESSAGES.deployForPublic, 403);
    const { server, settings } = await serverOf(rowsOf(tx), found.service);
    if (phpBool(payload.is_log_drain_enabled) && !serverLogDrainEnabled(settings)) return coolifyJson(obj({ message: "Validation failed.", errors: obj({ is_log_drain_enabled: [SERVICE_PARTS_API_MESSAGES.logDrain] }) }), 422);
    const isPublic = payload.is_public ?? rowValue(found.part, "is_public");
    const publicPort = payload.public_port ?? rowValue(found.part, "public_port");
    if (phpBool(isPublic) && !phpBool(publicPort)) return coolifyJson(obj({ message: "Validation failed.", errors: obj({ public_port: [SERVICE_PARTS_API_MESSAGES.publicPortRequired] }) }), 422);
    if (phpBool(isPublic) && server && (await databasePublicPortTaken(tx, rowValue(server, "id") as string | number, Number(publicPort), rowValue(found.part, "id") as string | number))) {
      return message(SERVICE_PARTS_API_MESSAGES.publicPortUsed, 400);
    }
    // StartDatabaseProxy / StopDatabaseProxy run on the server: Freeploy refuses before anything is stored.
    if (payload.is_public === true && !wasPublic) return unavailable(SERVICE_PARTS_API_MESSAGES.proxyStart);
    if (payload.is_public === false && wasPublic) return unavailable(SERVICE_PARTS_API_MESSAGES.proxyStop);

    // fill($payload)->save(), then updateCompose($serviceDatabase).
    const parts = await loadParts(tx, c, found.service);
    const memory = parts.loaded.store;
    const db = memory.databases().find((d) => d.uuid === partUuid) as ServiceDatabaseRow;
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (k === "human_name") db.human_name = v as string | null;
      else if (k === "image") db.image = v as string | null;
      else if (k === "exclude_from_status") db.exclude_from_status = phpBool(v);
      else if (k === "is_log_drain_enabled") db.is_log_drain_enabled = phpBool(v);
      else if (k === "is_public") extra.is_public = phpBool(v);
      else if (k === "public_port" || k === "public_port_timeout") extra[k] = v === null ? null : Number(v);
      else extra[k] = v;
    }
    updateServiceCompose(memory, parts.context, { kind: "database", row: db });
    await parts.write();
    const changed = Object.fromEntries(Object.entries(extra).filter(([k, v]) => rowValue(found.part, k) !== v));
    if (Object.keys(changed).length) await parts.store.update("database", rowValue(found.service, "id") as string | number, rowValue(found.part, "id") as string | number, changed);
    const refreshed = (await partRows(rowsOf(tx), "database", rowValue(found.service, "id"), partUuid))[0]!;
    return coolifyJson(serialize("database", refreshed));
  });
}
