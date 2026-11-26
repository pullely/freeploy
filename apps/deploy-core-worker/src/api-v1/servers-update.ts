// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/ServersController.php (update_server,
// transferredServerConnectionChanges, legacyBuildServerRoleConflict), app/Http/Controllers/Api/Concerns/RequiresDeployAbility.php,
// app/Models/Server.php (the saving and saved hooks, normalizeIp, sshEndpointInUse, isEmpty, hasEnabledGithubRunners,
// buildServers, changeProxy, isLocalhost), app/Models/ServerSetting.php (forgetSshHostKey), app/Support/ValidationPatterns.php
// and bootstrap/helpers/shared.php (validate_timezone, validate_cron_expression) (Apache-2.0), modified.
//
// Coolify's PATCH /api/v1/servers/{uuid} (DP-107), on DP-78's and DP-88's server helpers: validateIncomingRequest(), the
// controller's customApiValidator() with its messages and the fields not allowed, the org's server, the update policy, a
// transferred server's connection fields, the SSH endpoint in use (within the org: row-level security, where Coolify looks
// across every team, as DP-78's create does), the proxy type, the org's private key, the disk usage frequency, the legacy
// build flag against the role, the role's refusals, the deploy permission for a proxy type that changes; then the server's
// columns (the saving hook's trimmed ip and user, ip_previous, and the saved hook's forgotten host key when the address
// changes), the role, the terminal, the advanced settings, the wildcard domain, the public addresses (not of localhost) and
// changeProxy()'s columns.
//
// Where Coolify then runs work on the server Freeploy answers 501 in Coolify's envelope after Coolify's checks and before
// anything is stored: instant_validate (ValidateServer, queued; Coolify saves and answers 201), and a proxy type change that
// starts the new proxy (proxySet(): a functional server) or restarts Sentinel for traffic analytics.
//
// Not ported: Server::throttleValidation() (Coolify Cloud's limit on validations; no validation runs here), the audit log
// line (`api.server.updated`).
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { COOLIFY_API, coolifyJson, obj, type CoolifyAnswer } from "@saas/contracts/coolify-api";
import { needsExecutor } from "../applications/resources.js";
import { normalizeServerIp, serverIpError, isIpv4, isIpv6 } from "../servers/ip.js";
import { SERVER_USERNAME_PATTERN, timezones } from "../servers/validation.js";
import { validateCronExpressionStrict } from "../helpers/cron.js";
import { hasDeployAbility, message, rowsOf, unavailable, type ApiV1Context } from "./context.js";
import { rowValue } from "./models.js";
import { addError, descriptionRules, extraFields, nameRules, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules } from "./rules.js";
import { legacyRoleConflict, notRegex, primaryResources, PROXY_TYPES, SERVER_NAME_CONTROL_CHARACTERS, SERVER_ROLES } from "./servers.js";
import { findServer, forgetSshHostKey, functional, isBuildServer, isLocalhost, proxyOf, saveSettings, sentinelEnabled, transferredAway, type Found } from "./server-settings.js";

export const SERVER_UPDATE_MESSAGES = {
  notFound: "Server not found.",
  endpointInUse: "A server with this IP/Domain and SSH port is already in use.",
  invalidProxyType: "Invalid proxy type.",
  privateKeyNotFound: "Private key not found.",
  invalidFrequency: "Invalid Cron / Human expression for Disk Usage Check Frequency.",
  transferredField: "This field cannot be changed on a transferred server.",
  buildOnlyWithResources: "A server with existing resources cannot be configured as build only.",
  disableRunnersFirst: "Disable the GitHub runners before you set this server to deployments only.",
  addBuildServerFirst: "Add a usable build server before you set this server to deployments only.",
  proxyTypeNeedsDeploy: "Missing required permissions: deploy. Changing the proxy type starts the new proxy on the server, so it needs a token with the deploy permission.",
  invalidTimezone: "The server_timezone must be a valid timezone.",
  /** Freeploy's: ValidateServer runs over SSH. */
  validateUnavailable: needsExecutor("Validating the server"),
  /** Freeploy's: changeProxy() starts the new proxy on a server proxySet() accepts. */
  startProxyUnavailable: needsExecutor("Starting the proxy on the server"),
  /** Freeploy's: changeProxy() recreates Sentinel when traffic analytics reads the proxy's log. */
  sentinelRestartUnavailable: needsExecutor("Restarting Sentinel"),
} as const;

const ALLOWED = [
  "name",
  "description",
  "ip",
  "port",
  "user",
  "private_key_uuid",
  "server_role",
  "is_build_server",
  "instant_validate",
  "proxy_type",
  "concurrent_builds",
  "dynamic_timeout",
  "deployment_queue_limit",
  "server_disk_usage_notification_threshold",
  "server_disk_usage_check_frequency",
  "server_disk_usage_notification_interval_hours",
  "connection_timeout",
  "is_terminal_enabled",
  "wildcard_domain",
  "public_ipv4",
  "public_ipv6",
  "server_timezone",
  "backup_compression_cpu_percentage",
];
/** $request->only([...]) of the advanced settings, in the controller's order; the integer ones cast as the columns store them. */
const ADVANCED = ["concurrent_builds", "dynamic_timeout", "deployment_queue_limit", "server_disk_usage_notification_threshold", "server_disk_usage_check_frequency", "server_disk_usage_notification_interval_hours", "connection_timeout", "server_timezone", "backup_compression_cpu_percentage"];
const TEXT_SETTINGS = ["server_disk_usage_check_frequency", "server_timezone"];

/** $request->filled(): present and not blank. */
const filled = (v: unknown): boolean => !(v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0));
/** PHP truthiness of $request->x */
const truthy = (v: unknown): boolean => !(v === undefined || v === null || v === false || v === 0 || v === "" || v === "0" || (Array.isArray(v) && v.length === 0));
/** $request->boolean() */
const requestBool = (v: unknown): boolean => v === true || v === 1 || (typeof v === "string" && ["1", "true", "on", "yes"].includes(v.trim().toLowerCase()));

/** update_server()'s customApiValidator() rules with its messages, in the controller's order, then the fields not allowed. */
async function validateUpdate(all: Record<string, unknown>): Promise<Errors> {
  const errors: Errors = [];
  if ("name" in all && !notRegex(all.name, SERVER_NAME_CONTROL_CHARACTERS)) addError(errors, "name", "The name must not contain control characters such as new lines.");
  nameRules(errors, all, "name", { required: false, nullable: false });
  descriptionRules(errors, all);
  // ['string', 'nullable', new ValidServerIp]
  if ("ip" in all && all.ip !== null) {
    if (typeof all.ip !== "string") addError(errors, "ip", "The ip field must be a string.");
    if (typeof all.ip === "string" || typeof all.ip === "number") {
      const e = serverIpError("ip", String(all.ip));
      if (e) addError(errors, "ip", e);
    }
  }
  await validateRules(errors, all, [
    ["port", ["integer", "nullable", "between:1,65535"]],
    ["private_key_uuid", ["string", "nullable"]],
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
  const ip = (version: 4 | 6) => ({ closure: (v: unknown) => (typeof v === "string" && (version === 4 ? isIpv4(v) : isIpv6(v)) ? [] : [`The public ipv${version} field must be a valid IPv${version} address.`]) });
  await validateRules(errors, all, [
    ["is_build_server", ["boolean", "nullable"]],
    ["instant_validate", ["boolean", "nullable"]],
    ["proxy_type", ["string", "nullable"]],
    ["concurrent_builds", ["integer", "min:1"]],
    ["dynamic_timeout", ["integer", "min:1"]],
    ["deployment_queue_limit", ["integer", "min:1"]],
    ["server_disk_usage_notification_threshold", ["integer", "min:1", "max:100"]],
    ["server_disk_usage_check_frequency", ["string"]],
    ["server_disk_usage_notification_interval_hours", ["integer", "min:1", "max:720"]],
    ["connection_timeout", ["integer", "min:1", "max:300"]],
    ["is_terminal_enabled", ["boolean", "nullable"]],
    ["wildcard_domain", ["nullable", "url"]],
    ["public_ipv4", ["nullable", ip(4)]],
    ["public_ipv6", ["nullable", ip(6)]],
  ]);
  // ['bail', 'filled', 'string', fn: validate_timezone()]
  if ("server_timezone" in all) {
    const v = all.server_timezone;
    if (!filled(v)) addError(errors, "server_timezone", "The server timezone field must have a value.");
    else if (typeof v !== "string") addError(errors, "server_timezone", "The server timezone field must be a string.");
    else if (!timezones().includes(v)) addError(errors, "server_timezone", SERVER_UPDATE_MESSAGES.invalidTimezone);
  }
  await validateRules(errors, all, [["backup_compression_cpu_percentage", ["integer", { in: ["25", "50", "75", "100"] }]]]);
  extraFields(errors, all, ALLOWED);
  return errors;
}

/** Server::normalizeIp(): the address compared as the endpoint check compares it. */
const sameIp = (a: unknown, b: unknown): boolean => normalizeServerIp(String(a ?? "")).toLowerCase() === normalizeServerIp(String(b ?? "")).toLowerCase();

/** transferredServerConnectionChanges(): the connection fields that would change on a transferred server. */
async function transferredChanges(tx: SqlExecutor, f: Found, all: Record<string, unknown>): Promise<Errors> {
  const server = f.server;
  const keyId = rowValue(server, "private_key_id");
  const keyUuid = keyId === null || keyId === undefined ? null : ((await tx.execute<{ uuid: string }>("SELECT uuid FROM deploy.private_keys WHERE id = $1", [keyId])).rows[0]?.uuid ?? null);
  const changed: Array<[string, boolean]> = [
    ["ip", filled(all.ip) && !sameIp(all.ip, rowValue(server, "ip"))],
    ["user", filled(all.user) && String(all.user) !== String(rowValue(server, "user"))],
    ["port", filled(all.port) && Math.trunc(Number(all.port)) !== Number(rowValue(server, "port"))],
    ["private_key_uuid", filled(all.private_key_uuid) && all.private_key_uuid !== keyUuid],
  ];
  return changed.filter(([, c]) => c).map(([k]): [string, string[]] => [k, [SERVER_UPDATE_MESSAGES.transferredField]]);
}

/** Server::hasEnabledGithubRunners() */
async function hasEnabledGithubRunners(tx: SqlExecutor, serverId: unknown): Promise<boolean> {
  return (await tx.execute("SELECT 1 FROM deploy.github_runner_configs WHERE server_id = $1 AND is_enabled LIMIT 1", [serverId])).rows.length > 0;
}

/** Server::buildServers($teamId)->whereKeyNot($id)->exists(): reachable, usable, not a Swarm worker, enabled, no dedicated runner, build only. */
async function otherBuildServer(tx: SqlExecutor, serverId: unknown): Promise<boolean> {
  const r = await tx.execute(
    `SELECT 1 FROM deploy.servers s JOIN deploy.server_settings ss ON ss.server_id = s.id
      WHERE s.id <> $1 AND s.deleted_at IS NULL
        AND ss.is_reachable AND ss.is_usable AND NOT ss.is_swarm_worker AND NOT ss.force_disabled
        AND NOT EXISTS (SELECT 1 FROM deploy.github_runner_configs g WHERE g.server_id = s.id AND g.is_enabled AND g.is_dedicated)
        AND (ss.server_role = 'build' OR (ss.server_role IS NULL AND ss.is_build_server))
      LIMIT 1`,
    [serverId],
  );
  return r.rows.length > 0;
}

const NOW = "date_trunc('second', timezone('UTC', now()))";

/** PATCH /servers/{uuid} */
export async function updateServerApi(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  const errors = await validateUpdate(all);
  if (errors.length) return validationFailed(errors);
  return c.sql(c.env, c.orgId, async (tx) => {
    const f = await findServer(tx, uuid);
    if (!f) return message(SERVER_UPDATE_MESSAGES.notFound, 404);
    if (!(await c.allows(true))) return COOLIFY_API.unauthorized();
    const server = f.server;
    const serverId = rowValue(server, "id");
    if (transferredAway(f)) {
      const connection = await transferredChanges(tx, f, all);
      if (connection.length) return validationFailed(connection);
    }
    const rawIp = String(rowValue(server, "ip") ?? "");
    const newIp = filled(all.ip) ? String(all.ip) : rawIp;
    const newPort = filled(all.port) ? Math.trunc(Number(all.port)) : Number(rowValue(server, "port"));
    const endpointChanged = !sameIp(newIp, rawIp) || newPort !== Number(rowValue(server, "port"));
    if (endpointChanged) {
      const inUse = await tx.execute("SELECT 1 FROM deploy.servers WHERE lower(ip) = lower($1) AND port = $2 AND id <> $3 AND deleted_at IS NULL LIMIT 1", [normalizeServerIp(newIp), newPort, serverId]);
      if (inUse.rows.length) return message(SERVER_UPDATE_MESSAGES.endpointInUse, 400);
    }
    const proxy = proxyOf(f);
    const requestedProxy = truthy(all.proxy_type) ? String(all.proxy_type) : null;
    if (requestedProxy !== null && !PROXY_TYPES.some((t) => t.toLowerCase() === requestedProxy.toLowerCase())) return message(SERVER_UPDATE_MESSAGES.invalidProxyType, 422);
    const serverChanges: Record<string, unknown> = {};
    for (const k of ["name", "description", "ip", "port", "user"]) if (k in all) serverChanges[k] = all[k];
    if (filled(all.private_key_uuid)) {
      const key = (await rowsOf(tx)("private_keys", "t.uuid = $1", [String(all.private_key_uuid)]))[0];
      if (!key) return message(SERVER_UPDATE_MESSAGES.privateKeyNotFound, 404);
      serverChanges.private_key_id = rowValue(key, "id");
    }
    if ("server_disk_usage_check_frequency" in all && !validateCronExpressionStrict(all.server_disk_usage_check_frequency)) {
      return validationFailed([["server_disk_usage_check_frequency", [SERVER_UPDATE_MESSAGES.invalidFrequency]]]);
    }
    const conflict = legacyRoleConflict(all);
    if (conflict) return conflict;
    let role: "deployment" | "build" | "both" | null = null;
    if (filled(all.server_role)) role = String(all.server_role) as "deployment" | "build" | "both";
    else if (filled(all.is_build_server)) {
      // Legacy flag: true makes the server build only, false turns a build only server back into a regular one.
      if (requestBool(all.is_build_server)) role = "build";
      else if (isBuildServer(f)) role = "both";
    }
    if (role === "build" && !isBuildServer(f) && (await primaryResources(rowsOf(tx), server)).length > 0) return validationFailed([["server_role", [SERVER_UPDATE_MESSAGES.buildOnlyWithResources]]]);
    if (role === "deployment" && (await hasEnabledGithubRunners(tx, serverId))) return validationFailed([["server_role", [SERVER_UPDATE_MESSAGES.disableRunnersFirst]]]);
    if (role === "deployment" && !(await otherBuildServer(tx, serverId))) return validationFailed([["server_role", [SERVER_UPDATE_MESSAGES.addBuildServerFirst]]]);
    const proxyTypeChanged = requestedProxy !== null && requestedProxy.toLowerCase() !== String(proxy.type ?? "").toLowerCase();
    if (proxyTypeChanged && !hasDeployAbility(c)) return message(SERVER_UPDATE_MESSAGES.proxyTypeNeedsDeploy, 403);

    // What Coolify runs on the server after saving: refused before anything is stored.
    if (truthy(all.instant_validate)) return unavailable(SERVER_UPDATE_MESSAGES.validateUnavailable);
    if (proxyTypeChanged) {
      const buildAfter = role === null ? isBuildServer(f) : role === "build";
      // proxySet(): a type that is not NONE, on a functional server that is not a Swarm worker or a build server.
      if (requestedProxy!.toUpperCase() !== "NONE" && functional(f) && rowValue(f.settings, "is_swarm_worker") !== true && !buildAfter) return unavailable(SERVER_UPDATE_MESSAGES.startProxyUnavailable);
      if (rowValue(f.settings, "is_sentinel_enabled") === true && sentinelEnabled(f) && rowValue(f.settings, "is_traffic_analytics_enabled") === true) return unavailable(SERVER_UPDATE_MESSAGES.sentinelRestartUnavailable);
    }

    // $server->update($updateFields): the saving hook trims ip and user and keeps the previous ip; the saved hook forgets
    // the host key when the address changes.
    const sets: Record<string, unknown> = {};
    if ("name" in serverChanges) sets.name = serverChanges.name;
    if ("description" in serverChanges) sets.description = serverChanges.description;
    if ("ip" in serverChanges && serverChanges.ip !== null) sets.ip = String(serverChanges.ip).trim();
    if ("port" in serverChanges && serverChanges.port !== null) sets.port = Math.trunc(Number(serverChanges.port));
    if ("user" in serverChanges && serverChanges.user !== null) sets.user = String(serverChanges.user).trim();
    if ("private_key_id" in serverChanges) sets.private_key_id = serverChanges.private_key_id;
    const ipChanged = "ip" in sets && sets.ip !== rawIp;
    const portChanged = "port" in sets && sets.port !== Number(rowValue(server, "port"));
    if (ipChanged && rawIp) sets.ip_previous = rawIp;
    const dirty = Object.keys(sets).filter((k) => k === "ip_previous" || sets[k] !== rowValue(server, k));
    if (dirty.length) {
      await tx.execute(`UPDATE deploy.servers SET ${dirty.map((k, i) => `"${k}" = $${i + 2}`).join(", ")}, updated_at = ${NOW} WHERE id = $1`, [serverId, ...dirty.map((k) => sets[k])]);
      if (ipChanged || portChanged) await forgetSshHostKey(tx, f);
    }
    if (role !== null) await saveSettings(tx, f, { server_role: role, is_build_server: role === "build" });
    if ("is_terminal_enabled" in all) await saveSettings(tx, f, { is_terminal_enabled: requestBool(all.is_terminal_enabled) });
    const advanced: Record<string, unknown> = {};
    for (const k of ADVANCED) if (k in all && all[k] !== null && all[k] !== undefined) advanced[k] = TEXT_SETTINGS.includes(k) ? String(all[k]) : Math.trunc(Number(all[k]));
    await saveSettings(tx, f, advanced);
    if ("wildcard_domain" in all) await saveSettings(tx, f, { wildcard_domain: all.wildcard_domain ?? null });
    const publicIps: Record<string, unknown> = {};
    for (const k of ["public_ipv4", "public_ipv6"]) if (k in all) publicIps[k] = all[k] ?? null;
    if (Object.keys(publicIps).length && !isLocalhost(f)) await saveSettings(tx, f, publicIps);
    if (proxyTypeChanged) {
      // changeProxy(): the type upper-cased, status exited, the saved configuration and settings forgotten.
      Object.assign(proxy, { type: requestedProxy!.toUpperCase(), status: "exited", last_saved_proxy_configuration: null, last_saved_settings: null, last_applied_settings: null, certificates_restart_required: false });
      await tx.execute(`UPDATE deploy.servers SET proxy = $2::json, detected_traefik_version = NULL, traefik_outdated_info = NULL, updated_at = ${NOW} WHERE id = $1`, [serverId, JSON.stringify(proxy)]);
    }
    return coolifyJson(obj({ uuid: String(rowValue(server, "uuid")) }), 201);
  });
}
