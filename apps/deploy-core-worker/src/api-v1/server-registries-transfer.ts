// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/ServerDockerRegistriesController.php (index, login,
// check, logout, runOnRegistry), app/Http/Controllers/Api/ServerTransferController.php (status, migrate, check),
// app/Services/DockerRegistryLogins.php (normalizeRegistry, REGISTRY_PATTERN, rows, usersOf),
// app/Services/ServerTransfer/ServerTransferMigrator.php (validateInstanceUrl, normalizeToken, hasRunningMigration) and
// app/Rules/{SafeWebhookUrl,ValidServerIp}.php (Apache-2.0), modified.
//
// Coolify's /api/v1 for a server's Docker registry logins and its transfer to another Coolify instance (DP-88). A login
// lives only in the Docker config on the server, so the list of a server that is not functional is the registries its
// resources use (the console's registriesCard() rows, with Coolify's absolute links) and Coolify's error line; reading
// the config of a functional server, and docker login, the login check and docker logout, need the SSH executor: 501 in
// Coolify's envelope after Coolify's checks. A transfer's status is the server's metadata. Starting one runs Coolify's
// checks — over SSH and against the target instance — and the import check probes the server's SSH port: both answer
// 501 after Coolify's own validation, and nothing is stored.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { findServerByUuid, listBuildServerApplications, listRegistryServers, listServerImageUsers, type ApiRow } from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, fromJs, obj, type CoolifyAnswer, type PhpValue } from "@saas/contracts/coolify-api";
import { needsExecutor } from "../applications/resources.js";
import { REGISTRY_MESSAGES, registryUsers, type RegistryStore } from "../registries/service.js";
import { normalizeRegistry, REGISTRY_PATTERN, registryRows } from "../registries/logins.js";
import { isFunctional } from "../servers/service.js";
import { serverIpError } from "../servers/ip.js";
import { filterValidateUrl, type HostResolver } from "../s3-storages/safe-url.js";
import { DEFAULT_CONSOLE_URL } from "../handlers/notifications.js";
import { message, rowsOf, unavailable, type ApiV1Context } from "./context.js";
import { rowValue } from "./models.js";
import { cleanInput, extraFields, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules } from "./rules.js";
import { safeExternalUrlMessage } from "./server-settings.js";

export const REGISTRIES_TRANSFER_API_MESSAGES = {
  /** Freeploy's: DockerRegistryLogins reads ~/.docker/config.json and runs docker login/logout over SSH. */
  readUnavailable: needsExecutor("Reading the Docker configuration on the server"),
  loginUnavailable: needsExecutor("Running docker login on the server"),
  checkUnavailable: needsExecutor("Checking the registry login on the server"),
  logoutUnavailable: needsExecutor("Running docker logout on the server"),
  /** Freeploy's: ServerTransferMigrator's checks run over SSH and against the target instance. */
  migrateUnavailable: needsExecutor("Running the transfer checks"),
  /** Freeploy's: the import check probes the server's SSH port. */
  importCheckUnavailable: needsExecutor("Probing the server's SSH port"),
  notReachable: "The server is not reachable. Validate the server first.",
  invalidRegistry: "Enter a registry host, for example ghcr.io or registry.example.com:5000.",
  migrateNeedsSensitive: "Migrating a server requires a token with read:sensitive (or root) ability and the owner team role.",
} as const;

/** ServerTransferMigrator::STALE_MIGRATION_SECONDS */
const STALE_MIGRATION_SECONDS = 1800;

const denied = async (c: ApiV1Context, write: boolean, policyMessage?: string): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized(policyMessage));
const notFound = () => message("Server not found.", 404);
const consoleUrl = (c: ApiV1Context): string => (c.env.DEPLOY_CONSOLE_URL || DEFAULT_CONSOLE_URL).replace(/\/+$/, "");

interface Found {
  server: ApiRow;
  settings: ApiRow | undefined;
}
async function findServer(tx: SqlExecutor, uuid: string): Promise<Found | null> {
  const rows = rowsOf(tx);
  const server = (await rows("servers", "t.deleted_at IS NULL AND t.uuid = $1", [uuid]))[0];
  if (!server) return null;
  return { server, settings: (await rows("server_settings", "t.server_id = $1", [rowValue(server, "id")]))[0] };
}
const functional = (f: Found): boolean =>
  Boolean(f.settings) &&
  isFunctional({ is_reachable: rowValue(f.settings!, "is_reachable") as boolean, is_usable: rowValue(f.settings!, "is_usable") as boolean, force_disabled: rowValue(f.settings!, "force_disabled") as boolean, ip: String(rowValue(f.server, "ip")) });

const sqlStore = (tx: SqlExecutor): RegistryStore => ({
  servers: () => listRegistryServers(tx),
  findServer: (uuid) => findServerByUuid(tx, uuid),
  imageUsers: (serverId) => listServerImageUsers(tx, serverId),
  buildApplications: (serverId) => listBuildServerApplications(tx, serverId),
});

/** routes/api.php's /servers/{uuid}/registries routes. */
export async function serverRegistriesApi(c: ApiV1Context, uuid: string, segments: string[]): Promise<CoolifyAnswer | null> {
  const [registry, sub, extra] = segments;
  if (extra !== undefined) return null;
  const m = c.method;
  if (registry === undefined) return m === "GET" ? listRegistries(c, uuid) : m === "POST" ? login(c, uuid) : null;
  if (sub === undefined) return m === "DELETE" ? onRegistry(c, uuid, registry, REGISTRIES_TRANSFER_API_MESSAGES.logoutUnavailable) : null;
  return sub === "check" && m === "POST" ? onRegistry(c, uuid, registry, REGISTRIES_TRANSFER_API_MESSAGES.checkUnavailable) : null;
}

/** index(): the update policy; the rows of a server that is not functional, with Coolify's error line. */
async function listRegistries(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const f = await findServer(tx, uuid);
    if (!f) return notFound();
    const no = await denied(c, true);
    if (no) return no;
    if (functional(f)) return unavailable(REGISTRIES_TRANSFER_API_MESSAGES.readUnavailable);
    const users = await registryUsers(sqlStore(tx), { id: rowValue(f.server, "id") as number, server_role: (rowValue(f.settings!, "server_role") as never) ?? null, is_build_server: rowValue(f.settings!, "is_build_server") === true });
    // route(): Coolify's links are absolute.
    const base = consoleUrl(c);
    const rows = registryRows({}, users.map((u) => ({ ...u, link: u.link === null ? null : `${base}${u.link}` })));
    return coolifyJson(obj({ registries: rows.map((r) => fromJs(r)), error: REGISTRY_MESSAGES.notReachable }));
  });
}

const invalidRegistry = (): CoolifyAnswer => coolifyJson(obj({ message: "Validation failed.", errors: obj({ registry: [REGISTRIES_TRANSFER_API_MESSAGES.invalidRegistry] }) }), 422);

/** login(): validateIncomingRequest(), the normalized registry's rules, the server, the update policy, a functional server; then docker login (501). */
async function login(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  // $request->only($allowedFields), the registry normalized.
  const input: Record<string, unknown> = {};
  for (const k of ["registry", "username", "password"]) if (k in all) input[k] = all[k];
  if (typeof input.registry === "string") input.registry = normalizeRegistry(input.registry);
  const errors: Errors = [];
  await validateRules(errors, input, [
    ["registry", ["required", "string", "max:255", { closure: (v) => (typeof v === "string" && REGISTRY_PATTERN.test(v) ? [] : [REGISTRIES_TRANSFER_API_MESSAGES.invalidRegistry]) }]],
    ["username", ["required", "string", "max:255", { closure: (v) => (typeof v === "string" && /^[^\s]+$/.test(v) ? [] : ["The username must not contain spaces."]) }]],
    ["password", ["required", "string", "max:20000"]],
  ]);
  extraFields(errors, all, ["registry", "username", "password"]);
  if (errors.length) return validationFailed(errors);
  return c.sql(c.env, c.orgId, async (tx) => {
    const f = await findServer(tx, uuid);
    if (!f) return notFound();
    const no = await denied(c, true);
    if (no) return no;
    if (!functional(f)) return message(REGISTRIES_TRANSFER_API_MESSAGES.notReachable, 400);
    return unavailable(REGISTRIES_TRANSFER_API_MESSAGES.loginUnavailable);
  });
}

/** runOnRegistry() of check and logout: the registry's name, the server, the update policy, a functional server; then the command (501). */
async function onRegistry(c: ApiV1Context, uuid: string, raw: string, what: string): Promise<CoolifyAnswer> {
  const registry = normalizeRegistry(raw);
  if (registry.length > 255 || !REGISTRY_PATTERN.test(registry)) return invalidRegistry();
  return c.sql(c.env, c.orgId, async (tx) => {
    const f = await findServer(tx, uuid);
    if (!f) return notFound();
    const no = await denied(c, true);
    if (no) return no;
    if (!functional(f)) return message(REGISTRIES_TRANSFER_API_MESSAGES.notReachable, 400);
    return unavailable(what);
  });
}

// ── transfer ────────────────────────────────────────────────────────────────

export const metadataOf = (server: ApiRow): Record<string, unknown> => {
  const m = rowValue(server, "server_metadata");
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
};

/** routes/api.php's /servers/{uuid}/transfer and /servers/{uuid}/migrate. */
export async function serverTransferApi(c: ApiV1Context, uuid: string, sub: string, segments: string[]): Promise<CoolifyAnswer | null> {
  if (segments.length) return null;
  if (sub === "transfer") return c.method === "GET" ? transferStatus(c, uuid) : null;
  return c.method === "POST" ? migrate(c, uuid) : null;
}

/** status(): the transfer's listed fields, and the migration — its log and error only for a user who may update the server. */
async function transferStatus(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const f = await findServer(tx, uuid);
    if (!f) return notFound();
    const no = await denied(c, false);
    if (no) return no;
    const metadata = metadataOf(f.server);
    let migration: PhpValue = null;
    const raw = metadata.migration;
    if (raw && typeof raw === "object") {
      const mayUpdate = await c.allows(true);
      const entries = Array.isArray(raw) ? raw.map((v, i): [string, unknown] => [String(i), v]) : Object.entries(raw as Record<string, unknown>);
      const kept = entries.filter(([k]) => mayUpdate || (k !== "log" && k !== "error"));
      migration = Array.isArray(raw) && mayUpdate ? fromJs(raw) : obj(kept.map(([k, v]): [string, PhpValue] => [k, fromJs(v)]));
    } else if (raw !== undefined && raw !== null) migration = fromJs(raw);
    const transferRaw = metadata.transfer;
    const transfer = transferRaw && typeof transferRaw === "object" && !Array.isArray(transferRaw) ? Object.entries(transferRaw as Record<string, unknown>).filter(([k]) => ["status", "export_id", "imported_at", "claimed_at", "transferred_at", "target_instance_url"].includes(k)) : [];
    return coolifyJson(obj({ server_uuid: String(rowValue(f.server, "uuid")), transfer: transfer.length ? obj(transfer.map(([k, v]): [string, PhpValue] => [k, fromJs(v)])) : [], migration }));
  });
}

/** migrate(): read:sensitive, the server, the transfer policy, the request, then the migrator's own checks before its SSH and target checks (501). */
async function migrate(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  if (!c.canReadSensitive) return message(REGISTRIES_TRANSFER_API_MESSAGES.migrateNeedsSensitive, 403);
  return c.sql(c.env, c.orgId, async (tx) => {
    const f = await findServer(tx, uuid);
    if (!f) return notFound();
    // transfer: the owner of the team (policy-worker's write).
    const no = await denied(c, true);
    if (no) return no;
    const body = await readApiBody(c.request);
    if (body.incomingError) return body.incomingError;
    const all = body.all;
    const errors: Errors = [];
    await validateRules(errors, all, [
      ["target_url", ["required", "string", "url"]],
      ["target_token", ["required", "string"]],
    ]);
    extraFields(errors, all, ["target_url", "target_token"]);
    if (errors.length) return validationFailed(errors);
    const refused = await transferStartError(c, all.target_url, all.target_token, f.server, c.s3.resolve);
    if (refused) return message(refused, 422);
    return unavailable(REGISTRIES_TRANSFER_API_MESSAGES.migrateUnavailable);
  });
}

/**
 * ServerTransferMigrator::start()'s own checks, before its SSH and target checks: validateInstanceUrl(), normalizeToken()
 * and hasRunningMigration(). The first refusal's message, or null. The console's Transfer page (DP-96) asks the same.
 */
export async function transferStartError(c: { env: Pick<ApiV1Context["env"], "DEPLOY_CONSOLE_URL"> }, targetUrl: unknown, targetToken: unknown, server: ApiRow, resolve: HostResolver): Promise<string | null> {
  // validateInstanceUrl()
  const url = String(targetUrl ?? "").trim().replace(/\/+$/, "");
  if (url === "" || !filterValidateUrl(url)) return "A valid target instance URL is required (e.g. https://coolify.example.com).";
  if ((/^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1] ?? "").toLowerCase() !== "https") return "The target instance URL must use https, because the transfer sends credentials.";
  const unsafe = await safeExternalUrlMessage(c, url, "target_url", resolve);
  if (unsafe) return unsafe;
  // normalizeToken()
  let token = String(targetToken ?? "").trim();
  if (token.toLowerCase().startsWith("bearer ")) token = token.slice(7).trim();
  if (token === "") return "A target instance API token is required (root or write + deploy).";
  // hasRunningMigration()
  const running = metadataOf(server).migration as Record<string, unknown> | undefined;
  if (running && running.status === "running" && typeof running.started_at === "string" && Date.parse(running.started_at) > Date.now() - STALE_MIGRATION_SECONDS * 1000) return "A transfer of this server is already running.";
  return null;
}

/** $request->query() as PHP parses it (`a[]=x` an array), after TrimStrings and ConvertEmptyStringsToNull. */
function queryInput(url: URL): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  url.searchParams.forEach((value, key) => {
    const m = /^([^[]+)\[\]$/.exec(key);
    if (m) out[m[1]!] = [...((out[m[1]!] as unknown[]) ?? []), value];
    else out[key] = value;
  });
  return cleanInput(out) as Record<string, unknown>;
}

/** GET /servers/import/check: the create policy, the query's rules, then the import checks and the SSH port probe (501). */
export async function importCheck(c: ApiV1Context): Promise<CoolifyAnswer> {
  const no = await denied(c, true);
  if (no) return no;
  const query = queryInput(c.url);
  const errors: Errors = [];
  await validateRules(errors, query, [
    ["server_uuid", ["required", "string"]],
    ["ip", ["required", "string", { closure: (v) => { const e = serverIpError("ip", String(v)); return e ? [e] : []; } }]],
    ["port", ["nullable", "integer", "between:1,65535"]],
    ["schema_version", ["nullable", "integer"]],
    ["system_github_apps", ["nullable", "array", "max:100"]],
    ["system_github_apps.*", ["string", "max:64"]],
    ["system_gitlab_apps", ["nullable", "array", "max:100"]],
    ["system_gitlab_apps.*", ["string", "max:64"]],
  ]);
  if (errors.length) return coolifyJson(obj({ message: "Validation failed.", errors: obj(errors.map(([k, v]): [string, PhpValue] => [k, v])) }), 422);
  return unavailable(REGISTRIES_TRANSFER_API_MESSAGES.importCheckUnavailable);
}

