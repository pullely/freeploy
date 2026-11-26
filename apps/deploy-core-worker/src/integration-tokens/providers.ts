// Derived from coollabsio/coolify@91b7e3e:app/Services/IntegrationTokenValidator.php, app/Services/CloudflareTokenValidator.php,
// app/Services/{DopplerService,InfisicalService,VaultService}.php (validate(), login(), client()),
// app/Services/Dns/CloudflareDnsProvider.php (syncZones()'s requests, missingPermissionMessage()) and
// app/Models/IntegrationToken.php (PROVIDER_NAMES, allowedCapabilities(), requestTimeout()) (Apache-2.0), modified.
//
// How Coolify asks an integration token's provider whether it works before the token is stored, and how it reads a
// Cloudflare token's zones. Every request goes through a ProviderNetwork (api-v1/cloud-providers.ts: the injectable fetch
// the tests answer as emit.php's Http::fake() does), sent as Laravel's HTTP client sends it: withToken() (Bearer),
// acceptJson(), a GET's query in its order, an Infisical login's JSON body, Vault's X-Vault-Token and X-Vault-Namespace,
// and the timeout (Laravel's 30 seconds, or a secret manager's `timeout` setting, 10 seconds by default). A transfer that
// fails is Laravel's ConnectionException: Cloudflare's validator lets it through (the caller answers "Could not connect
// to the Cloudflare API…"), the secret managers' validate() catch it and answer false. Infisical's and Vault's base URL
// is checked by SafeExternalUrl before anything is sent (the caller's checkUrl: a private address is refused).
import { dataGet, providerSend, type ProviderNetwork, type ProviderRequest, type ProviderResponse } from "../api-v1/cloud-providers.js";
import type { PhpValue } from "@saas/contracts/coolify-api";

export const INTEGRATION_PROVIDERS = ["cloudflare", "doppler", "infisical", "vault"] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

/** IntegrationToken::PROVIDER_NAMES */
export const PROVIDER_NAMES: Readonly<Record<string, string>> = { cloudflare: "Cloudflare", doppler: "Doppler", infisical: "Infisical", vault: "HashiCorp Vault" };

/** providerName(): PROVIDER_NAMES, else ucfirst($provider). */
export function providerName(provider: string): string {
  return Object.hasOwn(PROVIDER_NAMES, provider) ? PROVIDER_NAMES[provider]! : provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** allowedCapabilities(): Cloudflare Tunnel setup also writes DNS records, so `tunnel` needs `dns`. */
export function allowedCapabilities(provider: string): string[] {
  return provider === "cloudflare" ? ["dns", "tunnel"] : ["secrets"];
}

/** Copy shown to the user: Coolify's, word for word. */
export const INTEGRATION_PROVIDER_MESSAGES = {
  /** IntegrationTokenValidator::errorMessage() */
  rejected(provider: string): string {
    switch (provider) {
      case "cloudflare":
        return "The token could not access the selected Cloudflare capabilities. Check its permissions and zone resources.";
      case "doppler":
        return "The Doppler token could not be verified. Check the token and its access.";
      case "infisical":
        return "Infisical login failed. Check the base URL, the client ID, and the client secret.";
      case "vault":
        return "The Vault token could not be verified. Check the base URL, the namespace, and the token.";
      default:
        return "The token could not be verified.";
    }
  },
  /** IntegrationTokenValidator::connectionErrorMessage() */
  connection: (provider: string): string => `Could not connect to the ${providerName(provider)} API. Check the network connection of Coolify and try again.`,
  /** CloudflareDnsProvider::missingPermissionMessage('Zone → Zone → Read') */
  zonesForbidden: "The Cloudflare token needs the Zone → Zone → Read permission.",
  zonesFailed: "Cloudflare zones could not be synchronized.",
} as const;

/** Laravel's ConnectionException: the provider could not be reached. */
export class ProviderConnectionError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/** A RuntimeException the actions throw: the provider refused the token, or the zones could not be read. */
export class ProviderRejectedError extends Error {}

/** A ValidationException: SafeExternalUrl's in InfisicalService's and VaultService's constructor (base_url), or UpdateIntegrationToken's (token). */
export class TokenValidationException extends Error {
  constructor(readonly errors: Record<string, string[]>) {
    super(Object.values(errors)[0]?.[0] ?? "");
  }
}

/** SafeExternalUrl on `base_url`: the first failure's message, or null when the URL may be asked. */
export type BaseUrlCheck = (baseUrl: string) => Promise<string | null>;

/** filled() */
export const filled = (v: unknown): boolean => !(v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0));

/** PHP's (string) cast of a scalar. */
const phpString = (v: unknown): string => (v === true ? "1" : v === false || v === null || v === undefined ? "" : String(v));
/** PHP's (int) cast. */
const phpInt = (v: unknown): number => (typeof v === "number" ? Math.trunc(v) : typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "string" ? Number.parseInt(/^\s*[+-]?\d+/.exec(v)?.[0] ?? "0", 10) : 0);

/** IntegrationToken::requestTimeout(): a self-hosted secret manager's timeout in seconds, or null. */
export function requestTimeout(metadata: Record<string, unknown>): number | null {
  return filled(metadata.timeout) ? phpInt(metadata.timeout) : null;
}

/** rtrim($url, '/') */
const rtrimSlash = (s: string): string => s.replace(/\/+$/, "");

async function send(net: ProviderNetwork, r: Omit<ProviderRequest, "method"> & { method?: ProviderRequest["method"] }): Promise<ProviderResponse> {
  try {
    return await providerSend(net, { method: "get", ...r });
  } catch (e) {
    throw new ProviderConnectionError(e);
  }
}

const LARAVEL_TIMEOUT_MS = 30_000;
const CLOUDFLARE = "https://api.cloudflare.com/client/v4";
const bearerJson = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}`, Accept: "application/json" });
const json = (r: ProviderResponse, path: string): PhpValue | undefined => dataGet(r.json, path);

/** CloudflareTokenValidator::validate(): the token is active, and reaches a zone's records (dns) and the account's tunnels (tunnel). */
async function validateCloudflare(net: ProviderNetwork, token: string, capabilities: readonly string[]): Promise<boolean> {
  const headers = bearerJson(token);
  const verification = await send(net, { url: `${CLOUDFLARE}/user/tokens/verify`, headers, timeoutMs: LARAVEL_TIMEOUT_MS });
  if (!verification.successful || json(verification, "result.status") !== "active") return false;
  if (!capabilities.includes("dns")) return true;
  const zones = await send(net, { url: `${CLOUDFLARE}/zones`, query: [["per_page", 1]], headers, timeoutMs: LARAVEL_TIMEOUT_MS });
  const zoneId = json(zones, "result.0.id");
  if (!zones.successful || typeof zoneId !== "string") return false;
  const records = await send(net, { url: `${CLOUDFLARE}/zones/${zoneId}/dns_records`, query: [["per_page", 1]], headers, timeoutMs: LARAVEL_TIMEOUT_MS });
  if (!records.successful) return false;
  if (capabilities.includes("tunnel")) {
    const accountId = json(zones, "result.0.account.id");
    if (typeof accountId !== "string") return false;
    const tunnels = await send(net, { url: `${CLOUDFLARE}/accounts/${accountId}/cfd_tunnel`, query: [["per_page", 1], ["is_deleted", "false"]], headers, timeoutMs: LARAVEL_TIMEOUT_MS });
    return tunnels.successful;
  }
  return true;
}

/** A secret manager's validate(): any failure, a transfer error included, is false. */
async function quietly(fn: () => Promise<boolean>): Promise<boolean> {
  try {
    return await fn();
  } catch {
    return false;
  }
}

/**
 * IntegrationTokenValidator::validate(): whether the provider accepts the token. Throws ProviderConnectionError when
 * Cloudflare cannot be reached, and TokenValidationException when an Infisical or Vault base URL may not be asked.
 */
export async function validateIntegrationToken(net: ProviderNetwork, checkUrl: BaseUrlCheck, provider: string, token: string, capabilities: readonly string[], metadata: Record<string, unknown>): Promise<boolean> {
  if (provider === "cloudflare") return validateCloudflare(net, token, capabilities);
  if (provider === "doppler") return quietly(async () => (await send(net, { url: "https://api.doppler.com/v3/me", headers: bearerJson(token), timeoutMs: LARAVEL_TIMEOUT_MS })).successful);
  if (provider === "infisical" || provider === "vault") {
    const fallback = provider === "infisical" ? "https://app.infisical.com" : "";
    const baseUrl = rtrimSlash(phpString(metadata.base_url === undefined ? fallback : metadata.base_url));
    const error = await checkUrl(baseUrl);
    if (error !== null) throw new TokenValidationException({ base_url: [error] });
    const timeoutMs = (requestTimeout(metadata) ?? 10) * 1000;
    if (provider === "infisical") {
      return quietly(async () => {
        const response = await send(net, { method: "post", url: `${baseUrl}/api/v1/auth/universal-auth/login`, json: { clientId: phpString(metadata.client_id), clientSecret: token }, headers: { Accept: "application/json" }, timeoutMs });
        const accessToken = json(response, "accessToken");
        return response.successful && filled(accessToken);
      });
    }
    const headers: Record<string, string> = { "X-Vault-Token": token, Accept: "application/json" };
    if (filled(metadata.namespace)) headers["X-Vault-Namespace"] = phpString(metadata.namespace);
    return quietly(async () => (await send(net, { url: `${baseUrl}/v1/auth/token/lookup-self`, headers, timeoutMs })).successful);
  }
  return false;
}

/** A zone as syncZones() stores it. */
export interface CloudflareZone {
  providerZoneId: string;
  name: string;
  accountId: string | null;
  accountName: string | null;
}

/** strtolower(): ASCII only (PHP 8). */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const nullableString = (v: PhpValue | undefined): string | null => (v === undefined || v === null ? null : typeof v === "string" ? v : phpString(v));

/**
 * syncZones()'s requests: /zones page by page (50 a page) until result_info.total_pages. A 403 is the missing Zone Read
 * permission; any other failure (or `success` not true) is "Cloudflare zones could not be synchronized.".
 */
export async function fetchCloudflareZones(net: ProviderNetwork, token: string): Promise<CloudflareZone[]> {
  const zones: CloudflareZone[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const response = await send(net, { url: `${CLOUDFLARE}/zones`, query: [["page", page], ["per_page", 50]], headers: bearerJson(token), timeoutMs: LARAVEL_TIMEOUT_MS });
    if (response.status === 403) throw new ProviderRejectedError(INTEGRATION_PROVIDER_MESSAGES.zonesForbidden);
    if (!response.successful || json(response, "success") !== true) throw new ProviderRejectedError(INTEGRATION_PROVIDER_MESSAGES.zonesFailed);
    const result = json(response, "result");
    const items = Array.isArray(result) ? result : [];
    for (const zone of items) {
      zones.push({
        providerZoneId: phpString(dataGet(zone, "id")),
        name: asciiLower(phpString(dataGet(zone, "name"))),
        accountId: nullableString(dataGet(zone, "account.id")),
        accountName: nullableString(dataGet(zone, "account.name")),
      });
    }
    const total = json(response, "result_info.total_pages");
    totalPages = Math.max(1, total === undefined || total === null ? 1 : phpInt(total));
    page++;
  } while (page <= totalPages);
  return zones;
}
