// Derived from coollabsio/coolify@91b7e3e:app/Actions/IntegrationToken/{CreateIntegrationToken,UpdateIntegrationToken}.php,
// app/Models/IntegrationToken.php (deletionBlocker(), automaticDnsEnabled(), proxiedDnsEnabled()),
// app/Services/Dns/CloudflareDnsProvider.php (syncZones()) and app/Livewire/Security/{IntegrationTokens,IntegrationTokenForm,
// IntegrationTokenEditor}.php (messages(), the toasts) (Apache-2.0), modified.
//
// What Coolify's two actions do with an integration token, shared by the console (Keys & Tokens → Integration Tokens) and
// /api/v1: the rules, the provider's check, the metadata each provider keeps, which changes ask the provider again, which
// re-read a Cloudflare token's zones, and what stops a delete. The provider is asked (providers.ts) before anything is
// written; Coolify asks it inside its transaction and rolls back, which leaves the same rows. The writes are the caller's,
// in one transaction of the org (packages/db's deploy/integration-tokens.ts).
import type { Rule, Rules } from "../api-v1/rules.js";
import { allowedCapabilities, fetchCloudflareZones, filled, INTEGRATION_PROVIDERS, PROVIDER_NAMES, ProviderRejectedError, TokenValidationException, validateIntegrationToken, INTEGRATION_PROVIDER_MESSAGES, type BaseUrlCheck, type CloudflareZone } from "./providers.js";
import type { ProviderNetwork } from "../api-v1/cloud-providers.js";

/** Copy shown to the user: Coolify's, word for word. */
export const INTEGRATION_TOKEN_MESSAGES = {
  /** the capabilities closure of CreateIntegrationToken::rules() */
  tunnelNeedsDns: "Cloudflare Tunnel also needs the DNS capability.",
  /** IntegrationTokenForm::messages() and IntegrationTokenEditor::messages() */
  selectCapability: "Select at least one capability.",
  dopplerToken: "Use a Doppler service token (dp.st.*) or service account token (dp.sa.*).",
  /** IntegrationToken::deletionBlocker() */
  usedAsSecretManager: "This token is used by one or more resources as a secret manager source. Remove those links first.",
  managesDnsRecords: "This token manages DNS records. Remove those domains or records first.",
  /** UpdateIntegrationToken::reenterSecretMessage() */
  reenterSecret(provider: string): string {
    if (provider === "infisical") return "Enter the client secret again when you change the base URL or the client ID.";
    if (provider === "vault") return "Enter the token again when you change the base URL or the namespace.";
    return "Enter the token again when you change the connection settings.";
  },
  /** the Livewire components' toasts */
  added: "Integration token added successfully.",
  updated: "Integration token updated successfully.",
  deleted: "Integration token deleted successfully.",
  zonesRefreshed: (count: number) => `Cloudflare zones refreshed. ${count} accessible zones found.`,
  /** IntegrationTokensController */
  apiNotFound: "Integration token not found.",
  apiDeleted: "Integration token deleted.",
  notCloudflare: "Only Cloudflare tokens have DNS zones.",
} as const;

// ── the rules ───────────────────────────────────────────────────────────────

/** The capabilities closure: `tunnel` without `dns`. */
const tunnelNeedsDns: Rule = {
  closure: (value) => {
    if (value === null || typeof value !== "object") return [];
    const items = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    return items.includes("tunnel") && !items.includes("dns") ? [INTEGRATION_TOKEN_MESSAGES.tunnelNeedsDns] : [];
  },
};

/**
 * CreateIntegrationToken::rules($provider), or UpdateIntegrationToken::rules() (no provider, the token nullable). `wildcard`
 * is `capabilities.*`: Laravel's ValidationRuleParser appends a wildcard's items after every other rule, so a caller puts
 * it last.
 */
export function tokenRules(provider: string, update = false): { head: Rules; wildcard: Rules } {
  const token: Rule[] = [update ? "nullable" : "required", "string"];
  if (provider === "doppler") token.push({ regex: /^dp\.(st|sa)\./ });
  const head: Rules = [
    ...(update ? [] : ([["provider", ["required", { in: INTEGRATION_PROVIDERS }]]] as Rules)),
    ["name", ["required", "string", "max:255"]],
    ["token", token],
    ["capabilities", ["required", "array", "min:1", tunnelNeedsDns]],
  ];
  if (provider === "infisical") {
    head.push(["metadata.base_url", ["required", { url: ["http", "https"] }]], ["metadata.client_id", ["required", "string"]], ["metadata.timeout", ["nullable", "integer", "min:1", "max:300"]]);
  } else if (provider === "vault") {
    head.push(["metadata.base_url", ["required", { url: ["http", "https"] }]], ["metadata.namespace", ["nullable", "string"]], ["metadata.timeout", ["nullable", "integer", "min:1", "max:300"]]);
  }
  return { head, wildcard: [["capabilities.*", ["required", { in: allowedCapabilities(provider) }]]] };
}

/** IntegrationTokenForm::messages() (with the Doppler token's) or IntegrationTokenEditor::messages(), by `attribute.rule`. */
export function componentMessages(editor: boolean): Record<string, string> {
  const messages: Record<string, string> = { "capabilities.required": INTEGRATION_TOKEN_MESSAGES.selectCapability, "capabilities.min": INTEGRATION_TOKEN_MESSAGES.selectCapability };
  if (!editor) messages["token.regex"] = INTEGRATION_TOKEN_MESSAGES.dopplerToken;
  return messages;
}

// ── the model ───────────────────────────────────────────────────────────────

export type Metadata = Record<string, unknown>;

/** The `array` cast of a JSON column: the decoded value, or null. */
export function decodeJson(text: string | null | undefined): unknown {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** A decoded metadata column as the PHP array it is ([] for null or a list). */
export function metadataOf(text: string | null | undefined): Metadata {
  const v = decodeJson(text);
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Metadata) : {};
}

/** A decoded capabilities column ($token->capabilities ?? []). */
export function capabilitiesOf(text: string | null | undefined): unknown[] {
  const v = decodeJson(text);
  return Array.isArray(v) ? v : v !== null && typeof v === "object" ? Object.values(v) : [];
}

/** automaticDnsEnabled(): a Cloudflare token whose metadata does not turn it off. */
export const automaticDnsEnabled = (provider: string, metadata: Metadata): boolean => provider === "cloudflare" && (metadata.automatic_dns === undefined ? true : metadata.automatic_dns) !== false;
/** proxiedDnsEnabled() */
export const proxiedDnsEnabled = (provider: string, metadata: Metadata): boolean => provider === "cloudflare" && metadata.proxied_dns === true;

/** deletionBlocker(): why the token cannot be deleted yet, or null. */
export function deletionBlocker(usage: { secretManagerLinks: boolean; managedDnsRecords: boolean }): string | null {
  if (usage.secretManagerLinks) return INTEGRATION_TOKEN_MESSAGES.usedAsSecretManager;
  if (usage.managedDnsRecords) return INTEGRATION_TOKEN_MESSAGES.managesDnsRecords;
  return null;
}

/** array_filter($metadata, fn ($value) => filled($value)) */
export const filledOnly = (metadata: Metadata): Metadata => Object.fromEntries(Object.entries(metadata).filter(([, v]) => filled(v)));

/** Carbon's now()->toIso8601String(): 2026-01-01T00:00:00+00:00. */
export const iso8601 = (d: Date): string => `${d.toISOString().slice(0, 19)}+00:00`;

/** syncZones()'s metadata: the token's, with zones_synced_at (in its place when it was there). */
export function syncedMetadata(metadata: Metadata | null, now: Date): Metadata {
  return { ...(metadata ?? {}), zones_synced_at: iso8601(now) };
}

// ── PHP's loose comparison, for UpdateIntegrationToken's `$metadata != $storedMetadata` ──

const isArrayLike = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";
const numeric = (v: unknown): boolean => typeof v === "number" || (typeof v === "string" && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(v));
const toBool = (v: unknown): boolean => !(v === null || v === undefined || v === false || v === 0 || v === "" || v === "0" || (isArrayLike(v) && Object.keys(v).length === 0));

/** PHP 8's ==. */
export function phpLooseEqual(a: unknown, b: unknown): boolean {
  if (isArrayLike(a) && isArrayLike(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && phpLooseEqual(a[k], b[k]));
  }
  if (a === null || a === undefined || b === null || b === undefined || typeof a === "boolean" || typeof b === "boolean") return toBool(a) === toBool(b);
  if (isArrayLike(a) || isArrayLike(b)) return false;
  if (numeric(a) && numeric(b)) return Number(a) === Number(b);
  return String(a) === String(b);
}

// ── CreateIntegrationToken ──────────────────────────────────────────────────

export interface CreateTokenInput {
  provider: string;
  name: string;
  token: string;
  capabilities: string[];
  metadata: Metadata;
  automaticDns: boolean;
  proxiedDns: boolean;
}

/** What to store once the provider has accepted a new token: its metadata, and a Cloudflare token's zones. */
export interface PreparedCreate {
  metadata: Metadata | null;
  zones: CloudflareZone[] | null;
}

/**
 * CreateIntegrationToken::handle() up to the writes: the metadata (empty values dropped, Cloudflare's two settings), the
 * provider's check (ProviderRejectedError with errorMessage()), and a Cloudflare token's zones (syncZones()'s requests).
 */
export async function prepareCreate(net: ProviderNetwork, checkUrl: BaseUrlCheck, input: CreateTokenInput): Promise<PreparedCreate> {
  const metadata = filledOnly(input.metadata);
  if (input.provider === "cloudflare" && !input.automaticDns) metadata.automatic_dns = false;
  if (input.provider === "cloudflare" && input.proxiedDns) metadata.proxied_dns = true;
  if (!(await validateIntegrationToken(net, checkUrl, input.provider, input.token, input.capabilities, metadata))) throw new ProviderRejectedError(INTEGRATION_PROVIDER_MESSAGES.rejected(input.provider));
  const zones = input.provider === "cloudflare" ? await fetchCloudflareZones(net, input.token) : null;
  return { metadata: Object.keys(metadata).length ? metadata : null, zones };
}

// ── UpdateIntegrationToken ──────────────────────────────────────────────────

/** A stored token, its JSON columns decoded and its token decrypted. */
export interface StoredToken {
  provider: string;
  name: string;
  capabilities: unknown[];
  /** The decoded metadata column (null when the column is null). */
  metadata: Metadata | null;
  token: string;
}

export interface UpdateTokenInput {
  name: string;
  newToken: string | null;
  capabilities: string[];
  metadata: Metadata;
  automaticDns: boolean;
  proxiedDns: boolean;
}

export interface PreparedUpdate {
  /** The dirty attributes $integrationToken->update() saves (the new token in the clear). */
  changes: { name?: string; token?: string; capabilities?: string[]; metadata?: Metadata | null };
  /** The metadata the token has after the update. */
  metadata: Metadata | null;
  /** A Cloudflare token's zones when its secret or capabilities changed; null when they are not read again. */
  zones: CloudflareZone[] | null;
}

/** connectionFields(): the metadata keys that decide where or how the secret is sent. */
const CONNECTION_FIELDS: Readonly<Record<string, readonly string[]>> = { vault: ["base_url", "namespace"], infisical: ["base_url", "client_id"] };
const phpStr = (v: unknown): string => (v === undefined || v === null || v === false ? "" : v === true ? "1" : String(v));
const sorted = (list: readonly unknown[]): string => JSON.stringify([...list].map((v) => phpStr(v)).sort());

/**
 * UpdateIntegrationToken::handle() up to the writes: the metadata (Cloudflare's from the stored one and its two settings),
 * a changed connection setting without a new secret (TokenValidationException on `token`), the provider asked again when
 * the secret, the capabilities or the settings change, the dirty attributes, and a Cloudflare token's zones when its
 * secret or capabilities changed.
 */
export async function prepareUpdate(net: ProviderNetwork, checkUrl: BaseUrlCheck, stored: StoredToken, input: UpdateTokenInput): Promise<PreparedUpdate> {
  const provider = stored.provider;
  const newToken = filled(input.newToken) ? input.newToken : null;
  let metadata = filledOnly(input.metadata);
  if (provider === "cloudflare") {
    // Cloudflare has no user settings in metadata; keep system keys such as zones_synced_at.
    metadata = { ...(stored.metadata ?? {}) };
    delete metadata.automatic_dns;
    delete metadata.proxied_dns;
    if (!input.automaticDns) metadata.automatic_dns = false;
    if (input.proxiedDns) metadata.proxied_dns = true;
  }
  const storedMetadata = stored.metadata ?? {};
  const changed = (CONNECTION_FIELDS[provider] ?? []).filter((field) => phpStr(storedMetadata[field]) !== phpStr(metadata[field]));
  if (changed.length > 0 && newToken === null) throw new TokenValidationException({ token: [INTEGRATION_TOKEN_MESSAGES.reenterSecret(provider)] });
  const capabilitiesChanged = sorted(input.capabilities) !== sorted(stored.capabilities);
  if ((newToken !== null || capabilitiesChanged || !phpLooseEqual(metadata, storedMetadata)) && !(await validateIntegrationToken(net, checkUrl, provider, newToken ?? stored.token, input.capabilities, metadata))) {
    throw new ProviderRejectedError(INTEGRATION_PROVIDER_MESSAGES.rejected(provider));
  }
  const nextMetadata = Object.keys(metadata).length ? metadata : null;
  const changes: PreparedUpdate["changes"] = {};
  if (input.name !== stored.name) changes.name = input.name;
  if (JSON.stringify(input.capabilities) !== JSON.stringify(stored.capabilities)) changes.capabilities = input.capabilities;
  if (JSON.stringify(nextMetadata) !== JSON.stringify(stored.metadata)) changes.metadata = nextMetadata;
  if (newToken !== null && newToken !== stored.token) changes.token = newToken;
  const zones = provider === "cloudflare" && (newToken !== null || capabilitiesChanged) ? await fetchCloudflareZones(net, newToken ?? stored.token) : null;
  return { changes, metadata: nextMetadata, zones };
}

/** The providers a console list badge names (IntegrationToken::PROVIDER_NAMES). */
export { PROVIDER_NAMES };
