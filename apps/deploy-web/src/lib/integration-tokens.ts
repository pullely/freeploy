// Derived from coollabsio/coolify@91b7e3e:app/Models/IntegrationToken.php (PROVIDER_NAMES, cloudflareTokenTemplateUrl()),
// app/Livewire/Security/{IntegrationTokenForm,IntegrationTokenEditor}.php (updatedProvider(), updatedCapabilities()) and
// resources/views/livewire/security/{integration-tokens,integration-token-form,integration-token-editor}.blade.php
// (Apache-2.0), modified.
//
// What the Integration Tokens page computes in the browser: the form's state when the provider changes, the capability
// checkboxes (Cloudflare Tunnel also selects DNS), the link that pre-fills a Cloudflare token's permissions, the editor's
// labels and helper texts, and the list's zone count.

export const INTEGRATION_PROVIDER_OPTIONS = [
  { value: "cloudflare", label: "Cloudflare" },
  { value: "doppler", label: "Doppler" },
  { value: "infisical", label: "Infisical" },
  { value: "vault", label: "HashiCorp Vault" },
] as const;

export type IntegrationMetadata = Record<string, string>;

/** The form's provider-dependent state. */
export interface IntegrationFormState {
  provider: string;
  capabilities: string[];
  metadata: IntegrationMetadata;
  automaticDns: boolean;
  proxiedDns: boolean;
}

/** IntegrationTokenForm's defaults: a Cloudflare DNS token. */
export const INITIAL_FORM: IntegrationFormState = { provider: "cloudflare", capabilities: ["dns"], metadata: {}, automaticDns: true, proxiedDns: false };

/** updatedProvider(): Cloudflare starts with DNS; a secret manager with Secrets (Infisical with its cloud URL). */
export function withProvider(provider: string): IntegrationFormState {
  if (provider === "cloudflare") return { provider, capabilities: ["dns"], metadata: {}, automaticDns: true, proxiedDns: false };
  return { provider, capabilities: ["secrets"], metadata: provider === "infisical" ? { base_url: "https://app.infisical.com" } : {}, automaticDns: true, proxiedDns: false };
}

/**
 * wire:model.live="capabilities" on a checkbox, then updatedCapabilities(): Cloudflare Tunnel setup also writes DNS
 * records, so selecting `tunnel` also selects `dns` (whose checkbox is disabled while tunnel is checked).
 */
export function toggleCapability(capabilities: readonly string[], capability: string, checked: boolean): string[] {
  const next = checked ? (capabilities.includes(capability) ? [...capabilities] : [...capabilities, capability]) : capabilities.filter((c) => c !== capability);
  if (next.includes("tunnel") && !next.includes("dns")) next.push("dns");
  return next;
}

/** PHP's http_build_query(…, PHP_QUERY_RFC3986) of string values. */
const rfc3986 = (pairs: Array<[string, string]>): string => pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`).join("&");

/**
 * IntegrationToken::cloudflareTokenTemplateUrl(): Cloudflare's dashboard link that pre-fills a user API token with the
 * permissions the capabilities need (`argotunnel` is Cloudflare's key for the Cloudflare Tunnel permission group).
 */
export function cloudflareTokenTemplateUrl(capabilities: readonly string[]): string {
  const tunnel = capabilities.includes("tunnel");
  const permissions = [
    { key: "dns", type: "edit" },
    { key: "zone", type: "read" },
    ...(tunnel ? [{ key: "argotunnel", type: "edit" }] : []),
  ];
  return `https://dash.cloudflare.com/profile/api-tokens?${rfc3986([
    ["permissionGroupKeys", JSON.stringify(permissions)],
    ["accountId", "*"],
    ["zoneId", "all"],
    ["name", tunnel ? "Coolify DNS and Tunnel Management" : "Coolify DNS Management"],
    ["ref", "coolify.io"],
  ])}`;
}

/** The token name's placeholder: {{ $provider === 'cloudflare' ? 'Production DNS' : 'Production secrets' }}. */
export const tokenNamePlaceholder = (provider: string): string => (provider === "cloudflare" ? "Production DNS" : "Production secrets");

/** The secret's label in the form: Infisical's client secret, Vault's token, else an API token. */
export const secretLabel = (provider: string): string => (provider === "infisical" ? "Client secret" : provider === "vault" ? "Vault token" : "API token");

/** The editor's new secret field: its label and its helper. */
export function newSecretField(provider: string): { label: string; helper: string } {
  const label = provider === "infisical" ? "New client secret" : "New API token";
  if (provider === "infisical") return { label, helper: "Paste a replacement client secret to rotate this credential. Required when you change the base URL or the client ID." };
  if (provider === "vault") return { label, helper: "Paste a replacement token to rotate this credential. Required when you change the base URL or the namespace." };
  return { label, helper: "Paste a replacement token to rotate this credential." };
}

/** Str::plural($word, $count) for the list's and the editor's counts. */
export const plural = (word: string, count: number): string => (count === 1 ? word : `${word}s`);

/** "{n} zone(s)" on a Cloudflare token's row, "{n} accessible zone(s)" in its editor. */
export const zoneCount = (count: number, accessible = false): string => `${count} ${accessible ? "accessible " : ""}${plural("zone", count)}`;

/** The settings a provider's form sends (the rest of `metadata` is the form's leftovers). */
export function settingsOf(provider: string, metadata: IntegrationMetadata): IntegrationMetadata {
  const keys = provider === "infisical" ? ["base_url", "client_id", "timeout"] : provider === "vault" ? ["base_url", "namespace", "timeout"] : [];
  return Object.fromEntries(keys.filter((k) => k in metadata).map((k) => [k, metadata[k]!]));
}

/** The editor's metadata as the form's text fields (a stored timeout is a number). */
export function metadataFields(metadata: Record<string, unknown>): IntegrationMetadata {
  return Object.fromEntries(Object.entries(metadata).filter(([, v]) => typeof v === "string" || typeof v === "number").map(([k, v]) => [k, String(v)]));
}
