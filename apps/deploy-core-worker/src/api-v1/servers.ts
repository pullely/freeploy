// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/ServersController.php (create_server,
// delete_server, resources_by_server, domains_by_server, server_by_uuid's ?resources, legacyBuildServerRoleConflict,
// domainHostWithoutPort), app/Http/Controllers/Api/Concerns/RequiresDeployAbility.php, app/Models/Server.php
// (definedResources, primaryResources, applications, databases, services, sshEndpointInUse, buildServers),
// app/Models/ServerSetting.php (normalizeSshHostKeys) and app/Support/ValidationPatterns.php (Apache-2.0), modified.
//
// Coolify's /api/v1 for creating and deleting a server and for a server's resources and domains (DP-78), on the
// console's server service (createServer(), deleteServer()) and stores. Validating a server, removing the SSH key from
// it, deleting the resources on it or the server at its cloud provider run on the server or the provider: they answer
// 501 in Coolify's envelope before anything is stored (DP-70's convention).
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { DATABASE_ENGINES, DATABASE_TABLES, otherBuildServerExists, trustServerSshHostKey, type ApiRow, type ApiTable } from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, obj, type CoolifyAnswer, type PhpObject, type PhpValue } from "@saas/contracts/coolify-api";
import { serverContext } from "../handlers/servers.js";
import { createServer, deleteServer, isTransferredAway, ServerError } from "../servers/service.js";
import { normalizeServerIp, serverIpError } from "../servers/ip.js";
import { SERVER_USERNAME_PATTERN } from "../servers/validation.js";
import { DATABASE_ENGINE_SPECS } from "../databases/engines.js";
import { databaseStatus } from "../databases/service.js";
import { generateRandomName } from "../helpers/names.js";
import { applicationStatus } from "./applications.js";
import { serviceStatusOf } from "./services.js";
import { hasDeployAbility, message, rowsOf, unavailable, type ApiV1Context, type Rows } from "./context.js";
import { rowValue, toModel } from "./models.js";
import { addError, descriptionRules, nameRules, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules } from "./rules.js";

export const SERVERS_API_MESSAGES = {
  /** Freeploy's: AuthorizedKeys::remove() edits ~/.ssh/authorized_keys on the server. */
  removeSshKeyUnavailable: "Removing the SSH key from the server needs the SSH executor, which is not available yet.",
  /** Freeploy's: the DeleteServer job stops and removes the resources on the server. */
  deleteResourcesUnavailable: "Deleting the resources on the server needs the SSH executor, which is not available yet.",
  /** Freeploy's: StopApplicationOneServer stops the containers of the applications that use the server as an additional destination. */
  stopAdditionalUnavailable: "Stopping the containers of the applications on the server needs the SSH executor, which is not available yet.",
  /** Freeploy's: the DeleteServer job deletes the server at Hetzner, Vultr or DigitalOcean. */
  deleteFromProviderUnavailable: "Deleting the server from its cloud provider is not available yet.",
  /** Freeploy's: ValidateServer runs over SSH. */
  validateUnavailable: "Validating the server needs the SSH executor, which is not available yet.",
} as const;

const SERVER_NAME_CONTROL_CHARACTERS = /[\x00-\x1F\x7F]/;
const PROXY_TYPES = ["NONE", "TRAEFIK", "NGINX", "CADDY"];
const SERVER_ROLES = ["deployment", "build", "both"];
const STANDALONE_DOCKER = "App\\Models\\StandaloneDocker";
const DATE_SHAPE = { hidden: [], dates: ["created_at", "updated_at"] };

const denied = async (c: ApiV1Context, write: boolean, policyMessage?: string): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized(policyMessage));
const filled = (v: unknown): boolean => !(v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0));
const phpTruthy = (v: unknown): boolean => !(v === undefined || v === null || v === false || v === 0 || v === "" || v === "0" || (Array.isArray(v) && v.length === 0));
/** $request->boolean(): filter_var(FILTER_VALIDATE_BOOLEAN). */
const requestBool = (v: unknown): boolean => v === true || v === 1 || (typeof v === "string" && ["1", "true", "on", "yes"].includes(v.trim().toLowerCase()));

/** filter_var($value, FILTER_VALIDATE_BOOLEAN[, FILTER_NULL_ON_FAILURE]) of a query parameter, with its default. */
function queryFlag(url: URL, name: string, fallback: boolean, nullOnFailure: boolean): boolean | null {
  const v = url.searchParams.get(name);
  if (v === null) return fallback;
  const t = v.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(t)) return true;
  if (["0", "false", "off", "no", ""].includes(t)) return false;
  return nullOnFailure ? null : false;
}

/** ModelsServer::whereTeamId($teamId)->whereUuid(): the org's server, not deleted. */
async function serverRow(rows: Rows, uuid: string): Promise<ApiRow | null> {
  return (await rows("servers", "t.deleted_at IS NULL AND t.uuid = $1", [uuid]))[0] ?? null;
}

// ── a server's resources ────────────────────────────────────────────────────

export type Resource = { kind: "application" | "service" | "database"; type: string; row: ApiRow };

/** The server's standalone destinations (Freeploy makes no Swarm one). */
const destinationIds = async (rows: Rows, server: ApiRow): Promise<unknown[]> => (await rows("standalone_dockers", "t.server_id = $1", [rowValue(server, "id")])).map((d) => rowValue(d, "id"));

/** primaryApplications(): the applications whose destination is one of the server's. */
async function primaryApplications(rows: Rows, ids: unknown[]): Promise<ApiRow[]> {
  return ids.length ? rows("applications", "t.deleted_at IS NULL AND t.destination_type = $1 AND t.destination_id = ANY($2)", [STANDALONE_DOCKER, ids]) : [];
}

/** databases(): engine by engine, those whose destination is one of the server's. */
async function serverDatabases(rows: Rows, ids: unknown[]): Promise<Resource[]> {
  const out: Resource[] = [];
  if (!ids.length) return out;
  for (const engine of DATABASE_ENGINES) {
    for (const row of await rows(DATABASE_TABLES[engine].table as ApiTable, "t.deleted_at IS NULL AND t.destination_type = $1 AND t.destination_id = ANY($2)", [STANDALONE_DOCKER, ids])) {
      out.push({ kind: "database", type: DATABASE_ENGINE_SPECS[engine].databaseType, row });
    }
  }
  return out;
}

const serverServices = async (rows: Rows, server: ApiRow): Promise<Resource[]> =>
  (await rows("services", "t.deleted_at IS NULL AND t.server_id = $1", [rowValue(server, "id")])).map((row) => ({ kind: "service" as const, type: "service", row }));

/** primaryResources(): the primary applications, the databases, the services. */
async function primaryResources(rows: Rows, server: ApiRow): Promise<Resource[]> {
  const ids = await destinationIds(rows, server);
  return [...(await primaryApplications(rows, ids)).map((row) => ({ kind: "application" as const, type: "application", row })), ...(await serverDatabases(rows, ids)), ...(await serverServices(rows, server))];
}

/** The applications that use the server as an additional destination. */
async function additionalApplications(rows: Rows, server: ApiRow): Promise<ApiRow[]> {
  const pivots = await rows("additional_destinations", "t.server_id = $1", [rowValue(server, "id")]);
  const ids = pivots.map((p) => rowValue(p, "application_id"));
  return ids.length ? rows("applications", "t.deleted_at IS NULL AND t.id = ANY($1)", [ids]) : [];
}

/** definedResources(): applications() (the primary ones, then the additional ones), databases(), services(). */
export async function definedResources(rows: Rows, server: ApiRow): Promise<Resource[]> {
  const ids = await destinationIds(rows, server);
  const applications = [...(await primaryApplications(rows, ids)), ...(await additionalApplications(rows, server))];
  return [...applications.map((row) => ({ kind: "application" as const, type: "application", row })), ...(await serverDatabases(rows, ids)), ...(await serverServices(rows, server))];
}

/** The resource's status accessor: an application's (its additional servers too), a service's parts', a database's column. */
export async function resourceStatus(rows: Rows, r: Resource): Promise<string> {
  return r.kind === "application" ? applicationStatus(rows, r.row) : r.kind === "service" ? serviceStatusOf(rows, rowValue(r.row, "id")) : databaseStatus(rowValue(r.row, "status") as string | null);
}

/** The payload resources_by_server() and server_by_uuid()'s ?resources make of each: id, uuid, name, type, the dates, the status accessor. */
export async function serverResourcesPayload(tx: SqlExecutor, server: ApiRow): Promise<PhpObject[]> {
  const rows = rowsOf(tx);
  const out: PhpObject[] = [];
  for (const r of await definedResources(rows, server)) {
    const dates = toModel(r.row.filter(([k]) => k === "created_at" || k === "updated_at"), DATE_SHAPE);
    const status = await resourceStatus(rows, r);
    out.push(
      obj([
        ["id", rowValue(r.row, "id") as PhpValue],
        ["uuid", rowValue(r.row, "uuid") as PhpValue],
        ["name", rowValue(r.row, "name") as PhpValue],
        ["type", r.type],
        ...dates.entries,
        ["status", status],
      ]),
    );
  }
  return out;
}

async function resourcesByServer(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const server = await serverRow(rowsOf(tx), uuid);
    if (!server) return message("Server not found.", 404);
    return coolifyJson(await serverResourcesPayload(tx, server));
  });
}

// ── a server's domains ──────────────────────────────────────────────────────

/** domainHostWithoutPort(): the host of a URL, without its port (an IPv6 literal keeps its brackets). */
function domainHostWithoutPort(fqdn: string): string {
  const authority = fqdn.replaceAll("http://", "").replaceAll("https://", "").split("/")[0]!;
  if (authority.startsWith("[") && authority.includes("]")) return authority.slice(0, authority.indexOf("]") + 1);
  return authority.split(":")[0]!;
}

const hostsOf = (fqdn: unknown): string[] => String(fqdn ?? "").split(",").map(domainHostWithoutPort).filter((h) => h !== "");

/**
 * domains_by_server(): with ?uuid the application's fqdns; else the domains of the org's applications on the server and
 * of its services' applications, grouped by the server's address (Freeploy has no instance public IPs: an address of
 * host.docker.internal is given as it is, as Coolify gives it without them).
 */
async function domainsByServer(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const server = await serverRow(rows, uuid);
    if (!server) return message("Server not found.", 404);
    const wanted = c.url.searchParams.get("uuid");
    if (phpTruthy(wanted)) {
      const application = (await rows("applications", "t.deleted_at IS NULL AND t.uuid = $1", [wanted]))[0];
      if (!application) return message("Application not found.", 404);
      const fqdn = rowValue(application, "fqdn");
      return coolifyJson(fqdn === null || fqdn === undefined ? [] : String(fqdn).split(","));
    }
    const ip = String(rowValue(server, "ip") ?? "");
    const pushed: Array<{ ip: string; domains: string[] }> = [];
    const ids = await destinationIds(rows, server);
    for (const project of await rows("projects")) {
      for (const application of await rows("applications", "t.deleted_at IS NULL AND t.environment_id IN (SELECT e.id FROM deploy.environments e WHERE e.project_id = $1)", [rowValue(project, "id")])) {
        if (rowValue(application, "destination_type") === STANDALONE_DOCKER && ids.includes(rowValue(application, "destination_id"))) pushed.push({ ip, domains: hostsOf(rowValue(application, "fqdn")) });
      }
    }
    for (const project of await rows("projects")) {
      for (const service of await rows("services", "t.deleted_at IS NULL AND t.server_id = $1 AND t.environment_id IN (SELECT e.id FROM deploy.environments e WHERE e.project_id = $2)", [rowValue(server, "id"), rowValue(project, "id")])) {
        for (const app of await rows("service_applications", "t.deleted_at IS NULL AND t.service_id = $1", [rowValue(service, "id")])) pushed.push({ ip, domains: hostsOf(rowValue(app, "fqdn")) });
      }
    }
    // groupBy('ip') in the order the addresses appear, each group's domains flattened.
    const groups: Array<[string, string[]]> = [];
    for (const p of pushed) {
      const g = groups.find(([k]) => k === p.ip);
      if (g) g[1].push(...p.domains);
      else groups.push([p.ip, [...p.domains]]);
    }
    return coolifyJson(groups.map(([k, domains]) => obj({ ip: k, domains })));
  });
}

// ── deleting a server ───────────────────────────────────────────────────────

/** delete_server(): its checks in Coolify's order; the rows of a server without resources are deleted, anything that runs on a server or a provider answers 501. */
async function deleteServerApi(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const server = await serverRow(rows, uuid);
    if (!server) return message("Server not found.", 404);
    const no = await denied(c, true);
    if (no) return no;
    const force = queryFlag(c.url, "force", false, false)!;
    const fromProvider = queryFlag(c.url, "delete_from_provider", false, true);
    if (fromProvider === null) return message("delete_from_provider must be a boolean.", 422);
    const removeSshKey = queryFlag(c.url, "remove_ssh_key", false, true);
    if (removeSshKey === null) return message("remove_ssh_key must be a boolean.", 422);
    const removeResources = queryFlag(c.url, "remove_resources_from_server", true, true);
    if (removeResources === null) return message("remove_resources_from_server must be a boolean.", 422);
    const resources = await primaryResources(rows, server);
    const additional = await additionalApplications(rows, server);
    const ctx = serverContext(tx, c.orgId, c.env);
    // A transferred server: only this instance's records are deleted (ServerTransferClaimer::deleteArchive()).
    if (isTransferredAway({ server_metadata: rowValue(server, "server_metadata") })) {
      if (fromProvider || removeSshKey) return message("This server is managed by another Coolify instance. Delete its cloud server or SSH key from that instance.", 422);
      if (resources.length) return unavailable(SERVERS_API_MESSAGES.deleteResourcesUnavailable);
      await tx.execute("DELETE FROM deploy.additional_destinations WHERE server_id = $1", [rowValue(server, "id")]);
      await deleteServer(ctx, uuid);
      return message("Server deleted.", 200);
    }
    if (resources.length && !force) return message("Server has resources. Use ?force=true to delete all resources and the server, or delete resources manually first.", 400);
    if (rowValue(server, "id") === 0) return message("Local server cannot be deleted.", 400);
    if (fromProvider) {
      const linked = (["hetzner", "vultr", "digitalocean"] as const).filter((p) => phpTruthy(rowValue(server, { hetzner: "hetzner_server_id", vultr: "vultr_instance_id", digitalocean: "digitalocean_droplet_id" }[p])));
      if (!linked.length) return message("Server is not linked to a cloud provider.", 422);
      for (const provider of linked) {
        if (!(await tx.execute("SELECT 1 FROM deploy.cloud_provider_tokens WHERE provider = $1 LIMIT 1", [provider])).rows.length) return message(`No ${provider} token found for this team. Add one before deleting the server from the cloud provider.`, 422);
      }
    }
    if ((force || fromProvider) && !hasDeployAbility(c)) return message("Missing required permissions: deploy. Deleting the resources or the cloud server needs a token with the deploy permission.", 403);
    if (removeSshKey && !fromProvider) {
      if ((await definedResources(rows, server)).length > 0) return message("Delete the resources of the server first, then delete the server with remove_ssh_key.", 422);
      return unavailable(SERVERS_API_MESSAGES.removeSshKeyUnavailable);
    }
    if (additional.length && removeResources) return unavailable(SERVERS_API_MESSAGES.stopAdditionalUnavailable);
    if (resources.length) return unavailable(SERVERS_API_MESSAGES.deleteResourcesUnavailable);
    if (fromProvider) return unavailable(SERVERS_API_MESSAGES.deleteFromProviderUnavailable);
    // detachAdditionalApplications(), then the server and the DeleteServer job's rows (Delete::delete()'s).
    await tx.execute("DELETE FROM deploy.additional_destinations WHERE server_id = $1", [rowValue(server, "id")]);
    await deleteServer(ctx, uuid);
    return message("Server deleted.", 200);
  });
}

// ── creating a server ───────────────────────────────────────────────────────

const SSH_HOST_KEY_TYPE = /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)$/;

/** The key type encoded in the first field of an SSH public key blob (base64_decode($blob, true)). */
function sshKeyBlobType(blob: string): string | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(blob)) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(blob), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length < 4) return null;
  const length = ((bytes[0]! << 24) >>> 0) + (bytes[1]! << 16) + (bytes[2]! << 8) + bytes[3]!;
  return bytes.length >= 4 + length ? String.fromCharCode(...bytes.slice(4, 4 + length)) : null;
}

/** ServerSetting::normalizeSshHostKeys(): the "type base64" lines of public keys or known_hosts lines, unique; null when there is none. */
export function normalizeSshHostKeys(input: string | null): string | null {
  const keys: string[] = [];
  for (const line of String(input ?? "").split(/\r\n|\n|\r|\x0B|\f|\u0085|\u2028|\u2029/)) {
    const fields = line.trim().split(/\s+/).filter(Boolean);
    if (fields.length === 0 || fields[0]!.startsWith("#") || fields[0]!.startsWith("@")) continue;
    if (!SSH_HOST_KEY_TYPE.test(fields[0]!)) fields.shift();
    const [type, blob] = [fields[0] ?? "", fields[1] ?? ""];
    if (SSH_HOST_KEY_TYPE.test(type) && sshKeyBlobType(blob) === type) keys.push(`${type} ${blob}`);
  }
  return keys.length === 0 ? null : [...new Set(keys)].join("\n");
}

/** Laravel's not_regex: a value that is neither a string nor a number fails it. */
function notRegex(value: unknown, pattern: RegExp): boolean {
  if (typeof value !== "string" && typeof value !== "number") return false;
  return !pattern.test(String(value));
}

/** create_server()'s customApiValidator() rules with its messages, then the extra fields and the SSH host key. */
async function validateCreate(all: Record<string, unknown>): Promise<Errors> {
  const errors: Errors = [];
  if ("name" in all && !notRegex(all.name, SERVER_NAME_CONTROL_CHARACTERS)) addError(errors, "name", "The name must not contain control characters such as new lines.");
  nameRules(errors, all, "name", { required: false, nullable: false });
  descriptionRules(errors, all);
  // ['string', 'required', new ValidServerIp]
  if ("ip" in all && typeof all.ip !== "string") addError(errors, "ip", "The ip field must be a string.");
  if (!filled(all.ip)) addError(errors, "ip", "This field is required.");
  else if (typeof all.ip === "string" || typeof all.ip === "number") {
    const e = serverIpError("ip", String(all.ip));
    if (e) addError(errors, "ip", e);
  }
  await validateRules(errors, all, [
    ["port", ["integer", "nullable", "between:1,65535"]],
    ["private_key_uuid", ["string", "required"]],
  ]);
  // ValidationPatterns::serverUsernameRules(required: false) with serverUsernameMessages()
  if ("user" in all && all.user !== null) {
    if (typeof all.user !== "string") addError(errors, "user", "The user field must be a string.");
    if ((typeof all.user !== "string" && typeof all.user !== "number") || !SERVER_USERNAME_PATTERN.test(String(all.user))) addError(errors, "user", "The User may only contain letters, numbers, dots, hyphens, and underscores.");
  }
  if ("server_role" in all && all.server_role !== null) {
    if (typeof all.server_role !== "string") addError(errors, "server_role", "The server role field must be a string.");
    if (!SERVER_ROLES.includes(String(all.server_role))) addError(errors, "server_role", "The selected server role is invalid.");
  }
  await validateRules(errors, all, [
    ["is_build_server", ["boolean", "nullable"]],
    ["instant_validate", ["boolean", "nullable"]],
    ["proxy_type", ["string", "nullable"]],
    ["ssh_host_key", ["string", "nullable", "max:16384"]],
  ]);
  const rawHostKey = all.ssh_host_key;
  const hostKey = typeof rawHostKey === "string" ? normalizeSshHostKeys(rawHostKey) : null;
  if (filled(rawHostKey) && hostKey === null && !errors.some(([k]) => k === "ssh_host_key")) {
    addError(errors, "ssh_host_key", 'The SSH host key must contain public key lines ("type base64") or known_hosts lines.');
  }
  const allowed = ["name", "description", "ip", "port", "user", "private_key_uuid", "server_role", "is_build_server", "instant_validate", "proxy_type", "ssh_host_key"];
  for (const k of Object.keys(all)) if (!allowed.includes(k)) addError(errors, k, "This field is not allowed.");
  return errors;
}

/** legacyBuildServerRoleConflict(): is_build_server and server_role saying different things. */
function legacyRoleConflict(all: Record<string, unknown>): CoolifyAnswer | null {
  if (!filled(all.is_build_server) || !filled(all.server_role)) return null;
  if (requestBool(all.is_build_server) === (String(all.server_role) === "build")) return null;
  return validationFailed([["is_build_server", ["is_build_server is deprecated and conflicts with server_role. Send only server_role."]]]);
}

async function createServerApi(c: ApiV1Context): Promise<CoolifyAnswer> {
  const no = await denied(c, true);
  if (no) return no;
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  const errors = await validateCreate(all);
  if (errors.length) return validationFailed(errors);
  const name = phpTruthy(all.name) ? String(all.name) : generateRandomName();
  const user = phpTruthy(all.user) ? String(all.user) : "root";
  const port = all.port === null || all.port === undefined ? 22 : Number(String(all.port).trim());
  const conflict = legacyRoleConflict(all);
  if (conflict) return conflict;
  const role = (filled(all.server_role) ? String(all.server_role) : filled(all.is_build_server) && requestBool(all.is_build_server) ? "build" : "both") as "deployment" | "build" | "both";
  return c.sql(c.env, c.orgId, async (tx) => {
    if (role === "deployment" && !(await otherBuildServerExists(tx, -1))) return validationFailed([["server_role", ["Add a usable build server before you set this server to deployments only."]]]);
    const proxy = phpTruthy(all.proxy_type) ? String(all.proxy_type) : null;
    if (proxy !== null && !PROXY_TYPES.map((t) => t.toLowerCase()).includes(proxy.toLowerCase())) return message("Invalid proxy type.", 422);
    const key = (await rowsOf(tx)("private_keys", "t.uuid = $1", [String(all.private_key_uuid)]))[0];
    if (!key) return message("Private key not found.", 404);
    const ctx = serverContext(tx, c.orgId, c.env);
    // Server::sshEndpointInUse(): within the org here (row-level security), where Coolify looks across every team.
    if (await ctx.store.sshEndpointInUse(normalizeServerIp(String(all.ip)), port)) return message("A server with this IP/Domain and SSH port is already in use.", 400);
    // ValidateServer::dispatch() runs over SSH: refused before anything is stored.
    if (phpTruthy(all.instant_validate) && requestBool(all.instant_validate)) return unavailable(SERVERS_API_MESSAGES.validateUnavailable);
    try {
      const server = await createServer(ctx, {
        privateKeyUuid: String(all.private_key_uuid),
        name,
        description: typeof all.description === "string" ? all.description : null,
        ip: String(all.ip),
        user,
        port,
        serverRole: role,
        scanImages: false,
        proxyType: proxy === null ? "TRAEFIK" : proxy.toUpperCase(),
      });
      const hostKey = typeof all.ssh_host_key === "string" ? normalizeSshHostKeys(all.ssh_host_key) : null;
      if (hostKey !== null) await trustServerSshHostKey(tx, server.id, hostKey);
      return coolifyJson(obj({ uuid: server.uuid }), 201);
    } catch (e) {
      if (e instanceof ServerError) return message(e.message, 422);
      throw e;
    }
  });
}

/** The /servers routes DP-78 adds: POST /servers, DELETE /servers/{uuid}, GET /servers/{uuid}/resources and /domains. Null for any other. */
export async function serversApi(c: ApiV1Context, uuid: string | undefined, sub: string | undefined): Promise<CoolifyAnswer | null> {
  if (uuid === undefined) return c.method === "POST" ? createServerApi(c) : null;
  if (sub === undefined) return c.method === "DELETE" ? deleteServerApi(c, uuid) : null;
  if (c.method !== "GET") return null;
  if (sub === "resources") return resourcesByServer(c, uuid);
  if (sub === "domains") return domainsByServer(c, uuid);
  return null;
}
