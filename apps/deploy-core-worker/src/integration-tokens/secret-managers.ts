// Derived from coollabsio/coolify@91b7e3e:app/Services/{DopplerService,InfisicalService,VaultService}.php (fetchSecrets(),
// keyValues(), login(), client()), app/Models/SecretManagerLink.php (fetchSecrets(), importMissingReferences()),
// app/Models/IntegrationToken.php (dopplerTokenType(), requestTimeout()) and app/Support/ValidationPatterns.php
// (isValidEnvironmentVariableKey()) (Apache-2.0), modified.
//
// What a resource's secret manager source (DP-106) asks its provider: the secrets of the link's settings, through the
// injectable ProviderNetwork as Laravel's HTTP client sends them — Doppler's /v3/configs/config/secrets/download (withToken,
// a service account's project and config in the query), Infisical's universal-auth login and /api/v4/secrets (/api/v3/
// secrets/raw on an older instance that answers 404; the imports merged before the folder's own secrets, as `infisical
// export` does), Vault's KV v2 read with X-Vault-Token and X-Vault-Namespace. Infisical's and Vault's base URL goes through
// SafeExternalUrl first (the caller's check), as their constructors validate it.
//
// Only the key names leave this module: a secret's value is read into memory by the JSON decoder and dropped here — Coolify
// keeps the values in memory too and discards them (keyNames(), importMissingReferences()); nothing stores or answers one.
import { blank, dataGet, isPhpArray, phpCastString, phpValues, providerSend, type ProviderNetwork, type ProviderResponse } from "../api-v1/cloud-providers.js";
import { isObj, type PhpValue } from "@saas/contracts/coolify-api";
import { phpIsNumeric } from "../api-v1/rules.js";
import { ProviderConnectionError, filled, requestTimeout, type BaseUrlCheck } from "./providers.js";

/** A RuntimeException of a provider service (or the SafeExternalUrl ValidationException of its constructor): its message. */
export class SecretFetchError extends Error {}

/** IntegrationToken::dopplerTokenType(): a service token (dp.st.) is pinned to one config, a service account (dp.sa.) is not. */
export function dopplerTokenType(provider: string, token: string): "service" | "service_account" | null {
  if (provider !== "doppler") return null;
  return token.startsWith("dp.st.") ? "service" : token.startsWith("dp.sa.") ? "service_account" : null;
}

/** ValidationPatterns::ENVIRONMENT_VARIABLE_KEY_PATTERN */
export const isValidEnvironmentVariableKey = (key: string): boolean => /^[A-Za-z_][A-Za-z0-9_.]*$/u.test(key);

/** PHP 8's sort() of strings (SORT_REGULAR): two numeric strings numerically, anything else byte by byte. */
export function phpSortStrings(keys: string[]): string[] {
  const bytes = (s: string) => new TextEncoder().encode(s);
  const strcmp = (a: string, b: string) => {
    const x = bytes(a);
    const y = bytes(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
    return x.length - y.length;
  };
  return [...keys].sort((a, b) => (phpIsNumeric(a) && phpIsNumeric(b) ? Number(a) - Number(b) : strcmp(a, b)));
}

/** The keys of a decoded PHP array, as strings (array_keys() and strval()). */
const keysOf = (v: PhpValue | undefined): string[] => (Array.isArray(v) ? v.map((_, i) => String(i)) : isObj(v) ? v.entries.map(([k]) => k) : []);

/** rtrim($url, '/') */
const rtrimSlash = (s: string): string => s.replace(/\/+$/, "");
/** trim($s, '/') */
const trimSlash = (s: string): string => s.replace(/^\/+|\/+$/g, "");
/** PHP's (string) cast of a setting (an array is "Array", with a warning). */
const str = (v: unknown): string => (v === undefined ? "" : (phpCastString(v as PhpValue) ?? "Array"));

async function send(net: ProviderNetwork, r: Parameters<typeof providerSend>[1]): Promise<ProviderResponse> {
  try {
    return await providerSend(net, r);
  } catch (e) {
    throw new ProviderConnectionError(e);
  }
}

/** $response->json($path) ?? 'HTTP '.$status, as the services word a failure. */
const reason = (r: ProviderResponse, path: string): string => {
  const v = dataGet(r.json, path);
  return v === undefined || v === null ? `HTTP ${r.status}` : str(v);
};

const LARAVEL_TIMEOUT_MS = 30_000;

/** DopplerService::fetchSecrets(): a service token's own config, or a service account's project and config. */
async function dopplerKeys(net: ProviderNetwork, token: string, settings: Record<string, unknown>): Promise<string[]> {
  const query: Array<[string, string]> = [["format", "json"]];
  if (filled(settings.project)) query.push(["project", str(settings.project)]);
  if (filled(settings.config)) query.push(["config", str(settings.config)]);
  const response = await send(net, { method: "get", url: "https://api.doppler.com/v3/configs/config/secrets/download", query, headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, timeoutMs: LARAVEL_TIMEOUT_MS });
  if (!response.successful) throw new SecretFetchError(`Doppler API error: ${reason(response, "messages.0")}`);
  return keysOf(response.json);
}

/** InfisicalService::fetchSecrets(): login, the v4 secrets (v3 on a 404), the imports then the folder's own secrets. */
async function infisicalKeys(net: ProviderNetwork, baseUrl: string, clientId: string, clientSecret: string, timeoutMs: number, projectId: string, environment: string, path: string): Promise<string[]> {
  const login = await send(net, { method: "post", url: `${baseUrl}/api/v1/auth/universal-auth/login`, json: { clientId, clientSecret }, headers: { Accept: "application/json" }, timeoutMs });
  const accessToken = dataGet(login.json, "accessToken");
  if (!login.successful || blank(accessToken)) throw new SecretFetchError(`Infisical login failed: ${reason(login, "message")}`);
  const headers = { Accept: "application/json", Authorization: `Bearer ${str(accessToken)}` };
  const secretPath = path === "" ? "/" : path;
  const values: Array<[string, string]> = [["expandSecretReferences", "true"], ["viewSecretValue", "true"]];
  let response = await send(net, { method: "get", url: `${baseUrl}/api/v4/secrets`, query: [["projectId", projectId], ["environment", environment], ["secretPath", secretPath], ["includeImports", "true"], ...values], headers, timeoutMs });
  if (response.status === 404) {
    response = await send(net, { method: "get", url: `${baseUrl}/api/v3/secrets/raw`, query: [["workspaceId", projectId], ["environment", environment], ["secretPath", secretPath], ["include_imports", "true"], ...values], headers, timeoutMs });
  }
  if (!response.successful) throw new SecretFetchError(`Infisical API error: ${reason(response, "message")}`);
  // array_replace() of each import's secrets, then the folder's own: a key keeps the place it first had.
  const merged = new Set<string>();
  const imports = dataGet(response.json, "imports");
  const lists = [...phpValues(isPhpArray(imports) ? imports : []).map((i) => dataGet(i, "secrets")), dataGet(response.json, "secrets") ?? []];
  for (const list of lists) for (const secret of phpValues(list ?? [])) merged.add(str(dataGet(secret, "secretKey") ?? null));
  return [...merged];
}

/** VaultService::fetchSecrets(): a KV v2 secret (data.data). */
async function vaultKeys(net: ProviderNetwork, baseUrl: string, token: string, namespace: unknown, timeoutMs: number, mount: string, path: string): Promise<string[]> {
  const headers: Record<string, string> = { "X-Vault-Token": token, Accept: "application/json" };
  if (filled(namespace)) headers["X-Vault-Namespace"] = str(namespace);
  const response = await send(net, { method: "get", url: `${baseUrl}/v1/${trimSlash(mount)}/data/${trimSlash(path)}`, headers, timeoutMs });
  if (!response.successful) throw new SecretFetchError(`Vault API error: ${reason(response, "errors.0")}`);
  return keysOf(dataGet(response.json, "data.data"));
}

export interface SecretSource {
  provider: string;
  /** The decrypted token (Infisical: the client secret). */
  token: string;
  metadata: Record<string, unknown>;
  settings: Record<string, unknown>;
}

/**
 * SecretManagerLink::fetchSecrets()'s key names, in the provider's order (array_keys(), strval()). Throws SecretFetchError
 * with the message the controller puts after "Could not fetch keys: ", or ProviderConnectionError when a provider cannot be
 * reached.
 */
export async function fetchSecretKeys(net: ProviderNetwork, checkUrl: BaseUrlCheck, source: SecretSource): Promise<string[]> {
  const { provider, token, metadata, settings } = source;
  if (provider === "doppler") return dopplerKeys(net, token, settings);
  if (provider === "infisical" || provider === "vault") {
    const baseUrl = rtrimSlash(provider === "infisical" ? str(metadata.base_url === undefined ? "https://app.infisical.com" : metadata.base_url) : str(metadata.base_url ?? ""));
    // The constructor's Validator::make(['base_url' => …], [new SafeExternalUrl])->validate(): its ValidationException.
    const error = await checkUrl(baseUrl);
    if (error !== null) throw new SecretFetchError(error);
    const timeoutMs = (requestTimeout(metadata) ?? 10) * 1000;
    if (provider === "infisical") {
      const secretPath = settings.secret_path === undefined ? "/" : str(settings.secret_path);
      return infisicalKeys(net, baseUrl, str(metadata.client_id ?? ""), token, timeoutMs, str(settings.project_id ?? ""), str(settings.environment ?? ""), secretPath);
    }
    return vaultKeys(net, baseUrl, token, metadata.namespace, timeoutMs, settings.mount === undefined ? "secret" : str(settings.mount), str(settings.path ?? ""));
  }
  throw new SecretFetchError(`Unsupported secret manager provider [${provider}].`);
}

/** importMissingReferences()'s split of the sorted keys: what gets a variable, what is skipped (never renamed). */
export function referencesToImport(keys: string[], existing: ReadonlySet<string>): { imported: string[]; skipped: string[] } {
  const imported: string[] = [];
  const skipped: string[] = [];
  for (const key of phpSortStrings(keys)) {
    if (!isValidEnvironmentVariableKey(key)) skipped.push(key);
    else if (!existing.has(key)) imported.push(key);
  }
  return { imported, skipped };
}
