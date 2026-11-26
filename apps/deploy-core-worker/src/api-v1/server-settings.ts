// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/{ServerProxyController,ServerSentinelController,
// ServerLogDrainsController,ServerImageScanningController,ServerCloudflareTunnelController}.php, app/Http/Controllers/Api/
// ServersController.php (reset_host_key), app/Http/Controllers/Api/Concerns/RequiresDeployAbility.php,
// app/Models/{Server,ServerSetting}.php (proxyType, traefikCertificateResolver, isSentinelEnabled, isFunctional, proxySet,
// changeProxy, isLocalhost, canBeValidated, the saving/saved/retrieved and updated hooks, forgetSshHostKey,
// isValidSentinelToken, sshHostKeyFingerprints, the casts), app/Enums/{ProxyTypes,TrafficIpMode}.php,
// app/Services/ImageScan/ScannerCommands.php (memoryOptionsMb, cpuOptions), app/Actions/ImageScan/SetServerImageScanning.php,
// app/Rules/{SafeWebhookUrl,ValidHostname,ValidFluentBitConfig}.php and bootstrap/helpers/proxy.php (proxyPageSizeRule)
// (Apache-2.0), modified.
//
// Coolify's /api/v1 for a server's proxy settings, Sentinel settings, log drains, image scanning, Cloudflare Tunnel
// setting and SSH host key (DP-88), on the server and server_settings rows the console's server pages write. Each is
// rows only until Coolify runs something on the server; there Freeploy answers 501 in Coolify's envelope after Coolify's
// own checks and before anything is stored: a proxy whose type changes on a server that would start it (StartProxy),
// a redirect or certificate resolver change on a functional server (setupDefaultRedirect), restarting the proxy, a
// Sentinel change while Sentinel is on (StartSentinel), a log drain change on a functional server (StartLogDrain /
// StopLogDrain), turning image scanning on (PrepareImageScannerJob) and resetting the host key (ServerConnectionCheckJob).
import type { SqlExecutor } from "@saas/db/hyperdrive";
import type { ApiRow } from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, obj, sqlDate, type CoolifyAnswer, type PhpObject, type PhpValue } from "@saas/contracts/coolify-api";
import { needsExecutor } from "../applications/resources.js";
import { columnCipher } from "../handlers/cloud-tokens.js";
import { isFunctional, isTransferredAway } from "../servers/service.js";
import { fluentBitConfigError } from "../servers/settings-validation.js";
import { hostnameError } from "../servers/ip.js";
import { safeUrlError, type HostResolver } from "../s3-storages/safe-url.js";
import { DEFAULT_CONSOLE_URL } from "../handlers/notifications.js";
import { hasDeployAbility, message, rowsOf, unavailable, type ApiV1Context } from "./context.js";
import { rowValue } from "./models.js";
import { addError, extraFields, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rule, type Rules } from "./rules.js";
import { normalizeSshHostKeys } from "./servers.js";

export const SERVER_SETTINGS_API_MESSAGES = {
  /** Freeploy's: what Coolify then runs on the server. */
  startProxyUnavailable: needsExecutor("Starting the proxy on the server"),
  redirectUnavailable: needsExecutor("Writing the proxy's default redirect on the server"),
  restartProxyUnavailable: needsExecutor("Restarting the proxy"),
  sentinelRestartUnavailable: needsExecutor("Restarting Sentinel"),
  logDrainUnavailable: needsExecutor("Starting or stopping the log drain on the server"),
  imageScannerUnavailable: needsExecutor("Preparing the image scanner on the server"),
  hostKeyCheckUnavailable: needsExecutor("Checking the server's connection with the new host key"),
  proxyTypeNeedsDeploy: "Missing required permissions: deploy. Changing the proxy type starts the new proxy on the server, so it needs a token with the deploy permission.",
  localhostTunnel: "Cloudflare Tunnel cannot be configured on the localhost server.",
  transferred: "This server was transferred to another Coolify instance.",
  managedElsewhere: "This server is managed by another Coolify instance.",
} as const;

/** ProxyTypes */
const PROXY_TYPES = ["NONE", "TRAEFIK", "NGINX", "CADDY"];
/** Server::PROXY_ERROR_PAGE_MAX_BYTES */
const PROXY_ERROR_PAGE_MAX_BYTES = 1048576;
/** ServerSetting::TRAEFIK_CERTIFICATE_RESOLVER_PATTERN, _NONE */
const RESOLVER_PATTERN = /^[A-Za-z0-9_-]+$/;
const RESOLVER_NONE = "none";
/** ServerSetting::IMAGE_SCAN_*_OPTIONS */
const MEMORY_OPTIONS_MB = [1024, 2048, 4096, 8192];
const TIMEOUT_OPTIONS_SECONDS = [300, 600, 1200, 1800, 3600];
const CPU_OPTIONS = [0.5, 1, 2, 4];
const SENTINEL_TOKEN = /^[a-zA-Z0-9._\-+=/]+$/;

const denied = async (c: ApiV1Context, write: boolean): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized());
const filled = (v: unknown): boolean => !(v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0));
const blank = (v: unknown): boolean => !filled(v);
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** FILTER_VALIDATE_BOOLEAN of $request->boolean(). */
const toBool = (v: unknown): boolean => v === true || v === 1 || (typeof v === "string" && ["1", "true", "on", "yes"].includes(v.trim().toLowerCase()));
/** Eloquent's boolean cast of an attribute set from the request. */
const castBool = (v: unknown): boolean => !(v === undefined || v === null || v === false || v === 0 || v === "" || v === "0");
/** PHP's (int) cast. */
const castInt = (v: unknown): number => (typeof v === "number" ? Math.trunc(v) : typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "string" ? Number.parseInt(/^\s*[+-]?\d+/.exec(v)?.[0] ?? "0", 10) : 0);

/** route('settings.advanced'): the console's Advanced settings, where Coolify's message points. */
const consoleUrl = (c: ApiV1Context): string => (c.env.DEPLOY_CONSOLE_URL || DEFAULT_CONSOLE_URL).replace(/\/+$/, "");

/** SafeWebhookUrl (SafeExternalUrl): the first failure's message, a private target's with privateTargetMessage()'s link. */
export async function safeExternalUrlMessage(c: ApiV1Context, value: unknown, attribute: string, resolve: HostResolver): Promise<string | null> {
  const error = await safeUrlError(value, attribute.replace(/_/g, " "), attribute, resolve, ["http", "https"]);
  if (error && error.endsWith("points to a local or private address that is not allowed.")) return `${error} Configure allowed internal targets: ${consoleUrl(c)}/settings/advanced#endpoint-section`;
  return error;
}
const safeExternalUrl = (c: ApiV1Context, attribute: string): Rule => ({
  closure: async (v) => {
    const error = await safeExternalUrlMessage(c, v, attribute, c.s3.resolve);
    return error ? [error] : [];
  },
});

// ── the server ──────────────────────────────────────────────────────────────

export interface Found {
  server: ApiRow;
  settings: ApiRow;
}

/** Server::whereTeamId()->whereUuid()->first() with its settings. */
export async function findServer(tx: SqlExecutor, uuid: string): Promise<Found | null> {
  const rows = rowsOf(tx);
  const server = (await rows("servers", "t.deleted_at IS NULL AND t.uuid = $1", [uuid]))[0];
  if (!server) return null;
  const settings = (await rows("server_settings", "t.server_id = $1", [rowValue(server, "id")]))[0];
  return settings ? { server, settings } : null;
}

/** `$request->uuid`: the input (the body, then the query string) before the route parameter. */
function requestUuid(c: ApiV1Context, all: Record<string, unknown>, route: string): string {
  if ("uuid" in all) return typeof all.uuid === "string" ? all.uuid : String(all.uuid ?? "");
  return c.url.searchParams.get("uuid") ?? route;
}

const setting = (f: Found, k: string): unknown => rowValue(f.settings, k);
export const functional = (f: Found): boolean =>
  isFunctional({ is_reachable: setting(f, "is_reachable") as boolean, is_usable: setting(f, "is_usable") as boolean, force_disabled: setting(f, "force_disabled") as boolean, ip: String(rowValue(f.server, "ip")) });
export const isSwarm = (f: Found): boolean => setting(f, "is_swarm_manager") === true || setting(f, "is_swarm_worker") === true;
const isBuildServer = (f: Found): boolean => {
  const role = setting(f, "server_role");
  return role === "build" || (role !== "deployment" && role !== "both" && setting(f, "is_build_server") === true);
};
const transferredAway = (f: Found): boolean => isTransferredAway({ server_metadata: rowValue(f.server, "server_metadata") });
/** Server::isSentinelEnabled() */
const sentinelEnabled = (f: Found): boolean => !isBuildServer(f) && !isSwarm(f) && setting(f, "force_disabled") !== true && !transferredAway(f);
/** Server::isLocalhost() */
const isLocalhost = (f: Found): boolean => rowValue(f.server, "ip") === "host.docker.internal" || Number(rowValue(f.server, "id")) === 0;

/** $server->proxy as the model reads it: the retrieved hook gives redirect_enabled true when it is missing. */
export function proxyOf(f: Found): Record<string, unknown> {
  const raw = rowValue(f.server, "proxy");
  const proxy: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  if (!("redirect_enabled" in proxy) || proxy.redirect_enabled === null) proxy.redirect_enabled = true;
  return proxy;
}

const cipherOf = (tx: SqlExecutor, c: ApiV1Context, column: string) => columnCipher(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, `server_settings.${column}`);
/** An `encrypted` column (Coolify's casts, and the log drain keys Freeploy encrypts) as plaintext; null when it does not decrypt. */
async function plain(tx: SqlExecutor, c: ApiV1Context, f: Found, column: string): Promise<string | null> {
  const stored = setting(f, column);
  if (stored === null || stored === undefined || stored === "") return null;
  try {
    return await cipherOf(tx, c, column).decrypt(String(stored));
  } catch {
    return null;
  }
}
async function sealed(tx: SqlExecutor, c: ApiV1Context, column: string, value: unknown): Promise<string | null> {
  if (value === null || value === undefined || value === "") return null;
  return cipherOf(tx, c, column).encrypt(String(value));
}

/** $settings->save() of these columns, with updated_at. */
async function saveSettings(tx: SqlExecutor, f: Found, changes: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(changes);
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `"${k}" = $${i + 2}`).join(", ");
  await tx.execute(`UPDATE deploy.server_settings SET ${sets}, updated_at = ${NOW} WHERE id = $1`, [rowValue(f.settings, "id"), ...keys.map((k) => changes[k])]);
}

/** ServerSetting::forgetSshHostKey(): a query update of the four host key columns, when one is set. */
async function forgetSshHostKey(tx: SqlExecutor, f: Found): Promise<void> {
  if (blank(setting(f, "ssh_host_key")) && blank(setting(f, "ssh_host_key_pending"))) return;
  await tx.execute("UPDATE deploy.server_settings SET ssh_host_key = NULL, ssh_host_key_source = NULL, ssh_host_key_trusted_at = NULL, ssh_host_key_pending = NULL WHERE id = $1", [rowValue(f.settings, "id")]);
}

/** $server->save(): the retrieved proxy, and the saving hook's ip_previous when the ip changes (then saved's forgetSshHostKey()). */
export async function saveServer(tx: SqlExecutor, f: Found, changes: { proxy?: Record<string, unknown>; ip?: string; proxy_error_page?: string | null; detected_traefik_version?: null; traefik_outdated_info?: null }): Promise<void> {
  const sets: Record<string, unknown> = { proxy: JSON.stringify(changes.proxy ?? proxyOf(f)) };
  for (const k of ["proxy_error_page", "detected_traefik_version", "traefik_outdated_info"] as const) if (k in changes) sets[k] = changes[k] ?? null;
  const oldIp = String(rowValue(f.server, "ip") ?? "");
  const ipChanged = changes.ip !== undefined && changes.ip.trim() !== oldIp;
  if (ipChanged) {
    sets.ip = changes.ip!.trim();
    if (oldIp) sets.ip_previous = oldIp;
  }
  const keys = Object.keys(sets);
  await tx.execute(`UPDATE deploy.servers SET ${keys.map((k, i) => `"${k}" = $${i + 2}${k === "proxy" || k === "traefik_outdated_info" ? "::json" : ""}`).join(", ")}, updated_at = ${NOW} WHERE id = $1`, [rowValue(f.server, "id"), ...keys.map((k) => sets[k])]);
  if (ipChanged) await forgetSshHostKey(tx, f);
}

/** Reloads a server and its settings ($server->refresh()). */
async function fresh(tx: SqlExecutor, f: Found): Promise<Found> {
  return (await findServer(tx, String(rowValue(f.server, "uuid"))))!;
}

/** The controller's validator: Validator::make() of the rules, then every field not allowed. */
async function validated(all: Record<string, unknown>, rules: Rules, allowed: readonly string[]): Promise<CoolifyAnswer | null> {
  const errors: Errors = [];
  await validateRules(errors, all, rules);
  extraFields(errors, all, allowed);
  return errors.length ? validationFailed(errors) : null;
}

const notFound = () => message("Server not found.", 404);

/** routes/api.php's /servers/{uuid}/{proxy,sentinel,log-drains,image-scanning,cloudflare-tunnel,host-key} routes. */
export async function serverSettingsApi(c: ApiV1Context, uuid: string, sub: string, segments: string[]): Promise<CoolifyAnswer | null> {
  const [next, extra] = segments;
  if (extra !== undefined) return null;
  const m = c.method;
  if (sub === "proxy") {
    if (next === undefined) return m === "GET" ? showProxy(c, uuid) : m === "PATCH" ? updateProxy(c, uuid) : null;
    return next === "restart" && m === "POST" ? restartProxy(c, uuid) : null;
  }
  if (next !== undefined && sub !== "cloudflare-tunnel" && sub !== "host-key") return null;
  if (sub === "sentinel") return m === "GET" ? showSentinel(c, uuid) : m === "PATCH" ? updateSentinel(c, uuid) : null;
  if (sub === "log-drains") return m === "GET" ? showLogDrains(c, uuid) : m === "PATCH" ? updateLogDrains(c, uuid) : null;
  if (sub === "image-scanning") return m === "GET" ? showImageScanning(c, uuid) : m === "PATCH" ? updateImageScanning(c, uuid) : null;
  if (sub === "cloudflare-tunnel") {
    if (next === undefined) return m === "GET" ? showTunnel(c, uuid) : m === "PATCH" ? updateTunnel(c, uuid) : null;
    return (next === "enable" || next === "disable") && m === "POST" ? toggleTunnel(c, uuid, next === "enable") : null;
  }
  if (sub === "host-key") return next === "reset" && m === "POST" ? resetHostKey(c, uuid) : null;
  return null;
}

// ── the proxy ───────────────────────────────────────────────────────────────

/** ServerProxyController::payload() */
function proxyPayload(c: ApiV1Context, f: Found): PhpObject {
  const proxy = proxyOf(f);
  const resolver = setting(f, "traefik_certificate_resolver");
  const out = obj({
    proxy_type: (proxy.type as PhpValue) ?? null,
    status: (proxy.status as PhpValue) ?? null,
    redirect_enabled: castBool(proxy.redirect_enabled),
    redirect_url: (proxy.redirect_url as PhpValue) ?? null,
    proxy_error_page: (rowValue(f.server, "proxy_error_page") as PhpValue) ?? null,
    generate_exact_labels: setting(f, "generate_exact_labels") === true,
    traefik_certificate_resolver: filled(resolver) && resolver !== RESOLVER_NONE ? (resolver as string) : null,
  });
  // The stored configuration only (never read over SSH), for a token that may read secrets.
  if (c.canReadSensitive) out.entries.push(["configuration", filled(proxy.last_saved_proxy_configuration) ? (proxy.last_saved_proxy_configuration as PhpValue) : null]);
  return out;
}

async function showProxy(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const f = await findServer(tx, uuid);
    if (!f) return notFound();
    return (await denied(c, false)) ?? coolifyJson(proxyPayload(c, f));
  });
}

async function updateProxy(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  const allowed = ["redirect_enabled", "redirect_url", "proxy_error_page", "generate_exact_labels", "traefik_certificate_resolver", "proxy_type"];
  const invalid = await validated(
    all,
    [
      ["redirect_enabled", ["boolean"]],
      ["redirect_url", ["nullable", "string", safeExternalUrl(c, "redirect_url")]],
      // proxyPageSizeRule('custom error page'): strlen() of the value, in bytes.
      ["proxy_error_page", ["nullable", "string", { closure: (v) => (new TextEncoder().encode(String(v ?? "")).length > PROXY_ERROR_PAGE_MAX_BYTES ? [`The custom error page must not be larger than ${PROXY_ERROR_PAGE_MAX_BYTES / 1024} KB.`] : []) }]],
      ["generate_exact_labels", ["boolean"]],
      ["traefik_certificate_resolver", ["nullable", "string", "max:255", { regex: RESOLVER_PATTERN }]],
      ["proxy_type", ["string", "nullable"]],
    ],
    allowed,
  );
  if (invalid) return invalid;
  return c.sql(c.env, c.orgId, async (tx) => {
    const f = await findServer(tx, uuid);
    if (!f) return notFound();
    const no = await denied(c, true);
    if (no) return no;
    const proxy = proxyOf(f);
    const requested = filled(all.proxy_type) ? String(all.proxy_type) : null;
    if (requested !== null && !PROXY_TYPES.includes(requested.toUpperCase())) return coolifyJson(obj({ message: "Validation failed.", errors: obj({ proxy_type: ["Invalid proxy type."] }) }), 422);
    const proxyTypeChanged = requested !== null && requested.toLowerCase() !== String(proxy.type ?? "").toLowerCase();
    if (proxyTypeChanged && !hasDeployAbility(c)) return message(SERVER_SETTINGS_API_MESSAGES.proxyTypeNeedsDeploy, 403);
    const redirectChanged = "redirect_enabled" in all || "redirect_url" in all || "proxy_error_page" in all;
    const resolverValue = "traefik_certificate_resolver" in all ? (filled(all.traefik_certificate_resolver) ? String(all.traefik_certificate_resolver) : null) : undefined;
    const resolverChanged = resolverValue !== undefined && resolverValue !== ((setting(f, "traefik_certificate_resolver") as string | null) ?? null);
    // What Coolify runs on the server after saving: refused before anything is stored.
    if (proxyTypeChanged) {
      // changeProxy(): StartProxy when proxySet() (a type, not NONE, on a functional server that is not a Swarm worker and can host resources).
      const startsProxy = requested!.toUpperCase() !== "NONE" && functional(f) && setting(f, "is_swarm_worker") !== true && !isBuildServer(f);
      // …and Sentinel again when traffic analytics reads the proxy's log.
      const restartsSentinel = setting(f, "is_sentinel_enabled") === true && sentinelEnabled(f) && setting(f, "is_traffic_analytics_enabled") === true;
      if (startsProxy) return unavailable(SERVER_SETTINGS_API_MESSAGES.startProxyUnavailable);
      if (restartsSentinel) return unavailable(SERVER_SETTINGS_API_MESSAGES.sentinelRestartUnavailable);
    }
    if ((redirectChanged || resolverChanged) && functional(f)) return unavailable(SERVER_SETTINGS_API_MESSAGES.redirectUnavailable);

    if (redirectChanged) {
      if ("redirect_enabled" in all) proxy.redirect_enabled = toBool(all.redirect_enabled);
      if ("redirect_url" in all) proxy.redirect_url = filled(all.redirect_url) ? all.redirect_url : null;
      const page = "proxy_error_page" in all ? (filled(all.proxy_error_page) ? String(all.proxy_error_page) : null) : ((rowValue(f.server, "proxy_error_page") as string | null) ?? null);
      await saveServer(tx, f, { proxy, proxy_error_page: page });
    }
    const settings: Record<string, unknown> = {};
    if ("generate_exact_labels" in all) settings.generate_exact_labels = toBool(all.generate_exact_labels);
    if (resolverValue !== undefined) settings.traefik_certificate_resolver = resolverValue;
    await saveSettings(tx, f, settings);
    if (proxyTypeChanged) {
      Object.assign(proxy, { type: requested!.toUpperCase(), status: "exited", last_saved_proxy_configuration: null, last_saved_settings: null, last_applied_settings: null, certificates_restart_required: false });
      await saveServer(tx, f, { proxy, detected_traefik_version: null, traefik_outdated_info: null });
    }
    return coolifyJson(proxyPayload(c, await fresh(tx, f)));
  });
}

/** restart(): the manageProxy policy, a functional server, then RestartProxyJob (501). */
async function restartProxy(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const f = await findServer(tx, uuid);
    if (!f) return notFound();
    const no = await denied(c, true);
    if (no) return no;
    if (!functional(f)) return message("Server is not functional.", 400);
    return unavailable(SERVER_SETTINGS_API_MESSAGES.restartProxyUnavailable);
  });
}

// ── Sentinel ────────────────────────────────────────────────────────────────

const SENTINEL_FIELDS = ["is_metrics_enabled", "is_sentinel_debug_enabled", "sentinel_token", "sentinel_metrics_refresh_rate_seconds", "sentinel_metrics_history_days", "sentinel_push_interval_seconds", "sentinel_custom_url", "traffic_topn", "traffic_sample_threshold", "traffic_retention_1h_days", "traffic_retention_1d_days", "is_geoip_enabled", "geoip_refresh_days", "geoip_maxmind_license_key", "traffic_ip_mode"];
const SENTINEL_BOOLEANS = ["is_metrics_enabled", "is_sentinel_debug_enabled", "is_geoip_enabled"];
const SENTINEL_INTEGERS = ["sentinel_metrics_refresh_rate_seconds", "sentinel_metrics_history_days", "sentinel_push_interval_seconds", "traffic_topn", "traffic_sample_threshold", "traffic_retention_1h_days", "traffic_retention_1d_days", "geoip_refresh_days"];
const SENTINEL_ENCRYPTED = ["sentinel_token", "geoip_maxmind_license_key"];

/** ServerSentinelController::transform() */
async function sentinelPayload(tx: SqlExecutor, c: ApiV1Context, f: Found): Promise<PhpObject> {
  const int = (k: string) => castInt(setting(f, k));
  const out = obj({
    is_sentinel_enabled: sentinelEnabled(f),
    is_metrics_enabled: setting(f, "is_metrics_enabled") === true,
    is_sentinel_debug_enabled: setting(f, "is_sentinel_debug_enabled") === true,
    sentinel_metrics_refresh_rate_seconds: int("sentinel_metrics_refresh_rate_seconds"),
    sentinel_metrics_history_days: int("sentinel_metrics_history_days"),
    sentinel_push_interval_seconds: int("sentinel_push_interval_seconds"),
    sentinel_updated_at: sqlDate(rowValue(f.server, "sentinel_updated_at") as string | null),
    traffic_topn: int("traffic_topn"),
    traffic_sample_threshold: int("traffic_sample_threshold"),
    traffic_retention_1h_days: int("traffic_retention_1h_days"),
    traffic_retention_1d_days: int("traffic_retention_1d_days"),
    is_geoip_enabled: setting(f, "is_geoip_enabled") === true,
    geoip_refresh_days: int("geoip_refresh_days"),
    // TrafficIpMode::forServer()
    traffic_ip_mode: (setting(f, "traffic_ip_mode") as string | null) ?? "full",
  });
  if (c.canReadSensitive) {
    out.entries.push(["sentinel_token", await plain(tx, c, f, "sentinel_token")]);
    out.entries.push(["sentinel_custom_url", (setting(f, "sentinel_custom_url") as string | null) ?? null]);
    out.entries.push(["geoip_maxmind_license_key", await plain(tx, c, f, "geoip_maxmind_license_key")]);
  }
  return out;
}

async function showSentinel(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const f = await findServer(tx, requestUuid(c, {}, uuid));
    if (!f) return notFound();
    return (await denied(c, false)) ?? coolifyJson(await sentinelPayload(tx, c, f));
  });
}

async function updateSentinel(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  return c.sql(c.env, c.orgId, async (tx) => {
    const f = await findServer(tx, requestUuid(c, all, uuid));
    if (!f) return notFound();
    const no = await denied(c, true);
    if (no) return no;
    const invalid = await validated(
      all,
      [
        ["is_metrics_enabled", ["boolean"]],
        ["is_sentinel_debug_enabled", ["boolean"]],
        ["sentinel_token", ["string", "max:500", { regex: SENTINEL_TOKEN }]],
        ["sentinel_metrics_refresh_rate_seconds", ["integer", "min:1"]],
        ["sentinel_metrics_history_days", ["integer", "min:1"]],
        ["sentinel_push_interval_seconds", ["integer", "min:10"]],
        ["sentinel_custom_url", ["nullable", "url"]],
        ["traffic_topn", ["integer", "min:1", "max:1000"]],
        ["traffic_sample_threshold", ["integer", "min:0"]],
        ["traffic_retention_1h_days", ["integer", "min:1", "max:365"]],
        ["traffic_retention_1d_days", ["integer", "min:1", "max:3650"]],
        ["is_geoip_enabled", ["boolean"]],
        ["geoip_refresh_days", ["integer", "min:1"]],
        ["geoip_maxmind_license_key", ["nullable", "string", "max:255"]],
        ["traffic_ip_mode", ["string", { in: ["full", "anonymized", "off"] }]],
      ],
      SENTINEL_FIELDS,
    );
    if (invalid) return invalid;
    if ("sentinel_token" in all && !(typeof all.sentinel_token === "string" && SENTINEL_TOKEN.test(all.sentinel_token))) return coolifyJson(obj({ message: "Validation failed.", errors: obj({ sentinel_token: ["Invalid sentinel token characters."] }) }), 422);
    // $settings->{$field} = $request->input($field) for each field the request has, then save(); wasChanged() as the casts compare.
    const changes: Record<string, unknown> = {};
    let changed = false;
    for (const k of SENTINEL_FIELDS) {
      if (!(k in all)) continue;
      const v = all[k];
      if (SENTINEL_ENCRYPTED.includes(k)) {
        const now = (v as string | null) ?? null;
        if (now !== (await plain(tx, c, f, k))) {
          changed = true;
          changes[k] = await sealed(tx, c, k, now);
        }
      } else if (SENTINEL_BOOLEANS.includes(k)) {
        if (castBool(v) !== (setting(f, k) === true)) (changed = true), (changes[k] = castBool(v));
      } else if (SENTINEL_INTEGERS.includes(k)) {
        if (castInt(v) !== castInt(setting(f, k))) (changed = true), (changes[k] = castInt(v));
      } else if ((v ?? null) !== ((setting(f, k) as string | null) ?? null)) {
        changed = true;
        changes[k] = v ?? null;
      }
    }
    // The updated hook: StartSentinel again while Sentinel is on.
    if (changed && setting(f, "is_sentinel_enabled") === true) return unavailable(SERVER_SETTINGS_API_MESSAGES.sentinelRestartUnavailable);
    await saveSettings(tx, f, changes);
    return coolifyJson(await sentinelPayload(tx, c, await fresh(tx, f)));
  });
}

// ── log drains ──────────────────────────────────────────────────────────────

const LOG_DRAIN_FIELDS = ["is_logdrain_newrelic_enabled", "logdrain_newrelic_license_key", "logdrain_newrelic_base_uri", "is_logdrain_axiom_enabled", "logdrain_axiom_dataset_name", "logdrain_axiom_api_key", "logdrain_axiom_domain", "is_logdrain_custom_enabled", "logdrain_custom_config", "logdrain_custom_config_parser", "is_logdrain_cloudwatch_enabled", "logdrain_cloudwatch_region", "logdrain_cloudwatch_group", "logdrain_cloudwatch_stream_prefix"];
const LOG_DRAIN_BOOLEANS = ["is_logdrain_newrelic_enabled", "is_logdrain_axiom_enabled", "is_logdrain_custom_enabled", "is_logdrain_cloudwatch_enabled"];
/** Encrypted: logdrain_custom_config (Coolify's cast) and the two keys (Freeploy's). */
const LOG_DRAIN_ENCRYPTED = ["logdrain_newrelic_license_key", "logdrain_axiom_api_key", "logdrain_custom_config"];
const KEY_PATTERN = /^[a-zA-Z0-9_\-.]+$/;

/** ServerLogDrainsController::transform() of the settings (stored values decrypted). */
function logDrainsPayload(c: ApiV1Context, v: Record<string, unknown>): PhpObject {
  const s = (k: string) => (v[k] as PhpValue) ?? null;
  const out = obj({
    is_logdrain_newrelic_enabled: castBool(v.is_logdrain_newrelic_enabled),
    logdrain_newrelic_base_uri: s("logdrain_newrelic_base_uri"),
    is_logdrain_axiom_enabled: castBool(v.is_logdrain_axiom_enabled),
    logdrain_axiom_dataset_name: s("logdrain_axiom_dataset_name"),
    logdrain_axiom_domain: s("logdrain_axiom_domain"),
    is_logdrain_custom_enabled: castBool(v.is_logdrain_custom_enabled),
    is_logdrain_cloudwatch_enabled: castBool(v.is_logdrain_cloudwatch_enabled),
    logdrain_cloudwatch_region: s("logdrain_cloudwatch_region"),
    logdrain_cloudwatch_group: s("logdrain_cloudwatch_group"),
    logdrain_cloudwatch_stream_prefix: s("logdrain_cloudwatch_stream_prefix"),
  });
  if (c.canReadSensitive) for (const k of ["logdrain_newrelic_license_key", "logdrain_axiom_api_key", "logdrain_custom_config", "logdrain_custom_config_parser"]) out.entries.push([k, s(k)]);
  return out;
}

async function logDrainValues(tx: SqlExecutor, c: ApiV1Context, f: Found): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const k of LOG_DRAIN_FIELDS) out[k] = LOG_DRAIN_ENCRYPTED.includes(k) ? await plain(tx, c, f, k) : setting(f, k);
  return out;
}

async function showLogDrains(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const f = await findServer(tx, requestUuid(c, {}, uuid));
    if (!f) return notFound();
    return (await denied(c, false)) ?? coolifyJson(logDrainsPayload(c, await logDrainValues(tx, c, f)));
  });
}

const fluentBit = (attribute: string, parsersOnly: boolean): Rule => ({
  closure: (v) => {
    const e = fluentBitConfigError(String(v ?? ""), parsersOnly);
    return e === null ? [] : [`The ${attribute} is not allowed: ${e}`];
  },
});

async function updateLogDrains(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  return c.sql(c.env, c.orgId, async (tx) => {
    const f = await findServer(tx, requestUuid(c, all, uuid));
    if (!f) return notFound();
    const no = await denied(c, true);
    if (no) return no;
    const invalid = await validated(
      all,
      [
        ["is_logdrain_newrelic_enabled", ["boolean"]],
        ["logdrain_newrelic_license_key", ["nullable", "string", { regex: KEY_PATTERN }]],
        ["logdrain_newrelic_base_uri", ["nullable", "url"]],
        ["is_logdrain_axiom_enabled", ["boolean"]],
        ["logdrain_axiom_dataset_name", ["nullable", "string", { regex: KEY_PATTERN }]],
        ["logdrain_axiom_api_key", ["nullable", "string", { regex: KEY_PATTERN }]],
        ["logdrain_axiom_domain", ["nullable", "string", { closure: (v) => { const e = hostnameError("logdrain axiom domain", String(v)); return e ? [e] : []; } }]],
        ["is_logdrain_custom_enabled", ["boolean"]],
        ["logdrain_custom_config", ["nullable", "string", fluentBit("logdrain custom config", false)]],
        ["logdrain_custom_config_parser", ["nullable", "string", fluentBit("logdrain custom config parser", true)]],
        ["is_logdrain_cloudwatch_enabled", ["boolean"]],
        ["logdrain_cloudwatch_region", ["nullable", "string", "max:64", { regex: /^[a-z]{2}(-[a-z]+)+-\d+$/ }]],
        ["logdrain_cloudwatch_group", ["nullable", "string", { regex: /^[.\-_/#A-Za-z0-9]{1,512}$/ }]],
        ["logdrain_cloudwatch_stream_prefix", ["nullable", "string", "max:256", { regex: /^[A-Za-z0-9_\-./#]*$/ }]],
      ],
      LOG_DRAIN_FIELDS,
    );
    if (invalid) return invalid;
    const merged = await logDrainValues(tx, c, f);
    for (const k of LOG_DRAIN_FIELDS) if (k in all) merged[k] = LOG_DRAIN_BOOLEANS.includes(k) ? castBool(all[k]) : (all[k] ?? null);
    const fail = (errors: Record<string, string[]>) => coolifyJson(obj({ message: "Validation failed.", errors: obj(errors) }), 422);
    if (merged.is_logdrain_newrelic_enabled) {
      const e: Record<string, string[]> = {};
      if (blank(merged.logdrain_newrelic_license_key)) e.logdrain_newrelic_license_key = ["The New Relic license key is required when New Relic log drain is enabled."];
      if (blank(merged.logdrain_newrelic_base_uri)) e.logdrain_newrelic_base_uri = ["The New Relic base URI is required when New Relic log drain is enabled."];
      if (Object.keys(e).length) return fail(e);
    }
    if (merged.is_logdrain_axiom_enabled) {
      const e: Record<string, string[]> = {};
      if (blank(merged.logdrain_axiom_dataset_name)) e.logdrain_axiom_dataset_name = ["The Axiom dataset name is required when Axiom log drain is enabled."];
      if (blank(merged.logdrain_axiom_api_key)) e.logdrain_axiom_api_key = ["The Axiom API key is required when Axiom log drain is enabled."];
      if (Object.keys(e).length) return fail(e);
    }
    if (merged.is_logdrain_custom_enabled && blank(merged.logdrain_custom_config)) return fail({ logdrain_custom_config: ["The custom log drain config is required when custom log drain is enabled."] });
    if (merged.is_logdrain_cloudwatch_enabled) {
      if (merged.is_logdrain_newrelic_enabled || merged.is_logdrain_axiom_enabled || merged.is_logdrain_custom_enabled) return fail({ is_logdrain_cloudwatch_enabled: ["Amazon CloudWatch Logs cannot be enabled together with another log drain."] });
      const e: Record<string, string[]> = {};
      if (blank(merged.logdrain_cloudwatch_region)) e.logdrain_cloudwatch_region = ["The CloudWatch region is required when Amazon CloudWatch Logs is enabled."];
      if (blank(merged.logdrain_cloudwatch_group)) e.logdrain_cloudwatch_group = ["The CloudWatch log group is required when Amazon CloudWatch Logs is enabled."];
      if (Object.keys(e).length) return fail(e);
    }
    // After the save Coolify starts or stops the log drain on a functional server.
    if (functional(f)) return unavailable(SERVER_SETTINGS_API_MESSAGES.logDrainUnavailable);
    const changes: Record<string, unknown> = {};
    for (const k of LOG_DRAIN_FIELDS) if (k in all) changes[k] = LOG_DRAIN_ENCRYPTED.includes(k) ? await sealed(tx, c, k, merged[k]) : merged[k];
    await saveSettings(tx, f, changes);
    return coolifyJson(logDrainsPayload(c, merged));
  });
}

// ── image scanning ──────────────────────────────────────────────────────────

/** ScannerCommands::optionsUpTo(): the options that fit the server's capacity (all while it is unknown), at least the smallest. */
function optionsUpTo(options: number[], capacity: number): number[] {
  if (capacity <= 0) return options;
  const fitting = options.filter((o) => o <= capacity);
  return fitting.length ? fitting : [Math.min(...options)];
}
function metadataNumber(f: Found, key: string): number {
  const m = rowValue(f.server, "server_metadata");
  const v = m && typeof m === "object" ? (m as Record<string, unknown>)[key] : undefined;
  return castInt(v);
}

/** ServerImageScanningController::transform(): the scanner's cache entries are empty (no scanner was prepared). */
function imageScanningPayload(f: Found): PhpObject {
  return obj({
    is_image_scan_enabled: setting(f, "is_image_scan_enabled") === true,
    image_scan_memory_mb: castInt(setting(f, "image_scan_memory_mb")),
    image_scan_syft_timeout: castInt(setting(f, "image_scan_syft_timeout")),
    image_scan_grype_timeout: castInt(setting(f, "image_scan_grype_timeout")),
    image_scan_cpus: Number(setting(f, "image_scan_cpus")),
    scanner_state: null,
    scanner_failed_step: null,
    scanner_built_at: null,
    scanner_disk_used_bytes: null,
  });
}

async function showImageScanning(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const f = await findServer(tx, uuid);
    if (!f) return notFound();
    // viewSecurity: an admin of the team (policy-worker's write).
    return (await denied(c, true)) ?? coolifyJson(imageScanningPayload(f));
  });
}

async function updateImageScanning(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  const LIMITS = ["image_scan_memory_mb", "image_scan_syft_timeout", "image_scan_grype_timeout", "image_scan_cpus"];
  return c.sql(c.env, c.orgId, async (tx) => {
    const f = await findServer(tx, uuid);
    if (!f) return notFound();
    const no = await denied(c, true);
    if (no) return no;
    const memory = optionsUpTo(MEMORY_OPTIONS_MB, Math.trunc(metadataNumber(f, "memory_bytes") / (1024 * 1024)));
    const cpus = optionsUpTo(CPU_OPTIONS, metadataNumber(f, "cpus"));
    const errors: Errors = [];
    // required_without_all: absent (or empty) while every limit is too.
    const missing = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
    if (missing(all.is_image_scan_enabled) && LIMITS.every((k) => missing(all[k]))) addError(errors, "is_image_scan_enabled", `The is image scan enabled field is required when none of ${LIMITS.map((k) => k.replace(/_/g, " ")).join(" / ")} are present.`);
    const inOptions = (options: number[], text: string | null, attribute: string): Rule => ({ closure: (v) => (v !== null && typeof v !== "object" && options.map(String).includes(String(v)) ? [] : [text ?? `The selected ${attribute} is invalid.`]) });
    await validateRules(errors, all, [
      ["is_image_scan_enabled", missing(all.is_image_scan_enabled) && LIMITS.every((k) => missing(all[k])) ? [] : ["boolean"]],
      ["image_scan_memory_mb", ["integer", inOptions(memory, `This server allows: ${memory.join(", ")}. A higher limit is more than the memory of the server.`, "")]],
      ["image_scan_syft_timeout", ["integer", inOptions(TIMEOUT_OPTIONS_SECONDS, null, "image scan syft timeout")]],
      ["image_scan_grype_timeout", ["integer", inOptions(TIMEOUT_OPTIONS_SECONDS, null, "image scan grype timeout")]],
      ["image_scan_cpus", ["numeric", inOptions(cpus, `This server allows: ${cpus.join(", ")}. A higher limit is more than the CPU count of the server.`, "")]],
    ]);
    extraFields(errors, all, ["is_image_scan_enabled", ...LIMITS]);
    if (errors.length) return validationFailed(errors);
    const limits = Object.fromEntries(LIMITS.filter((k) => k in all).map((k) => [k, k === "image_scan_cpus" ? Number(all[k]) : castInt(all[k])]));
    const enabling = "is_image_scan_enabled" in all && toBool(all.is_image_scan_enabled);
    // SetServerImageScanning::ensureManagedHere()
    if ((Object.keys(limits).length || enabling) && transferredAway(f)) return message(SERVER_SETTINGS_API_MESSAGES.managedElsewhere, 409);
    // Turning it on prepares the scanner on the server (PrepareImageScannerJob).
    if (enabling) return unavailable(SERVER_SETTINGS_API_MESSAGES.imageScannerUnavailable);
    const changes: Record<string, unknown> = { ...limits };
    if ("is_image_scan_enabled" in all) changes.is_image_scan_enabled = false;
    await saveSettings(tx, f, changes);
    return coolifyJson(imageScanningPayload(await fresh(tx, f)));
  });
}

// ── Cloudflare Tunnel ───────────────────────────────────────────────────────

const tunnelPayload = (f: Found): Array<[string, PhpValue]> => [
  ["is_cloudflare_tunnel", setting(f, "is_cloudflare_tunnel") === true],
  ["ip", rowValue(f.server, "ip") as string],
  ["ip_previous", (rowValue(f.server, "ip_previous") as string | null) ?? null],
];

async function showTunnel(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const f = await findServer(tx, requestUuid(c, {}, uuid));
    if (!f) return notFound();
    return (await denied(c, false)) ?? coolifyJson(obj(tunnelPayload(f)));
  });
}

/** $settings->is_cloudflare_tunnel = …; save() (the updated hook forgets the host key when it changed), then the previous IP when turned off. */
async function setTunnel(tx: SqlExecutor, f: Found, enabled: boolean): Promise<Found> {
  if (enabled !== (setting(f, "is_cloudflare_tunnel") === true)) {
    await saveSettings(tx, f, { is_cloudflare_tunnel: enabled });
    await forgetSshHostKey(tx, f);
  } else await saveSettings(tx, f, {});
  const previous = rowValue(f.server, "ip_previous");
  if (!enabled && filled(previous)) await saveServer(tx, await fresh(tx, f), { ip: String(previous) });
  return fresh(tx, f);
}

async function updateTunnel(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  return c.sql(c.env, c.orgId, async (tx) => {
    const f = await findServer(tx, requestUuid(c, all, uuid));
    if (!f) return notFound();
    const no = await denied(c, true);
    if (no) return no;
    if (isLocalhost(f)) return message(SERVER_SETTINGS_API_MESSAGES.localhostTunnel, 422);
    const invalid = await validated(all, [["is_cloudflare_tunnel", ["required", "boolean"]]], ["is_cloudflare_tunnel"]);
    if (invalid) return invalid;
    return coolifyJson(obj(tunnelPayload(await setTunnel(tx, f, toBool(all.is_cloudflare_tunnel)))));
  });
}

async function toggleTunnel(c: ApiV1Context, uuid: string, enable: boolean): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const f = await findServer(tx, requestUuid(c, {}, uuid));
    if (!f) return notFound();
    const no = await denied(c, true);
    if (no) return no;
    if (isLocalhost(f)) return message(SERVER_SETTINGS_API_MESSAGES.localhostTunnel, 422);
    const hadPrevious = filled(rowValue(f.server, "ip_previous"));
    const after = await setTunnel(tx, f, enable);
    const text = enable ? "Cloudflare Tunnel enabled." : `Cloudflare Tunnel disabled.${hadPrevious ? " Server IP restored to its previous IP address." : " Action required: Update the server IP address to its real IP address if needed."}`;
    return coolifyJson(obj([["message", text], ...tunnelPayload(after)]));
  });
}

// ── the SSH host key ────────────────────────────────────────────────────────

/** reset_host_key(): the update policy, a server not transferred away, the key's checks; then the save and ServerConnectionCheckJob (501). */
async function resetHostKey(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  const all = body.all;
  return c.sql(c.env, c.orgId, async (tx) => {
    const f = await findServer(tx, requestUuid(c, all, uuid));
    if (!f) return notFound();
    const no = await denied(c, true);
    if (no) return no;
    if (transferredAway(f)) return message(SERVER_SETTINGS_API_MESSAGES.transferred, 422);
    const errors: Errors = [];
    await validateRules(errors, all, [["ssh_host_key", ["string", "nullable", "max:16384"]]]);
    const raw = all.ssh_host_key;
    const key = typeof raw === "string" ? normalizeSshHostKeys(raw) : null;
    if (errors.length || (filled(raw) && key === null)) {
      if (!errors.some(([k]) => k === "ssh_host_key")) addError(errors, "ssh_host_key", 'The SSH host key must contain public key lines ("type base64") or known_hosts lines.');
      return validationFailed(errors);
    }
    return unavailable(SERVER_SETTINGS_API_MESSAGES.hostKeyCheckUnavailable);
  });
}

