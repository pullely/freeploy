// Derived from coollabsio/coolify@91b7e3e:app/Services/Dns/CloudflareDnsProvider.php (findRecords, conflictingRecords,
// createRecordLocked's and replaceRecordLocked's requests, deleteRecord, normalizeRemoteRecord, client),
// app/Models/ManagedDnsRecord.php (ownershipCommentFor) and app/Exceptions/DnsRecordConflictException.php
// (Apache-2.0), modified.
//
// What Coolify asks Cloudflare about a managed record, through the injectable fetch (api-v1/cloud-providers.ts), sent
// as Laravel's HTTP client sends it: withToken() (Bearer), acceptJson(), a GET's query in its order, a JSON body, the
// 30 seconds of Laravel's timeout. A transfer that fails is Laravel's ConnectionException (ProviderConnectionError):
// findRecords() and the create and replace requests let it through; deleteRecord() answers Failed.
import { dataGet, providerSend, type ProviderNetwork, type ProviderRequest, type ProviderResponse } from "../api-v1/cloud-providers.js";
import { isObj, type PhpValue } from "@saas/contracts/coolify-api";
import { ProviderConnectionError, ProviderRejectedError } from "../integration-tokens/providers.js";
import { sameAddress } from "./addresses.js";

const CLOUDFLARE = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 30_000;

/** ManagedDnsRecord::OWNERSHIP_COMMENT_PREFIX, the brand swapped: the comment that proves Freeploy created a record. */
export const OWNERSHIP_COMMENT_PREFIX = "managed-by: freeploy";

/** ownershipCommentFor(): the prefix, the instance (Coolify's app.id, Freeploy's environment; "default") and the record's uuid. */
export function ownershipCommentFor(instance: string | undefined, uuid: string): string {
  return `${OWNERSHIP_COMMENT_PREFIX} ${(instance || "default").slice(0, 40)}/${uuid}`;
}

export const CLOUDFLARE_DNS_MESSAGES = {
  /** missingPermissionMessage('Zone → DNS → Edit') */
  dnsEdit: "The Cloudflare token needs the Zone → DNS → Edit permission.",
  notChecked: "Cloudflare DNS records could not be checked.",
  several: (hostname: string) => `Several DNS records already exist for ${hostname}. Update them in Cloudflare.`,
  notCreated: "Cloudflare could not create the DNS record.",
  conflictGone: "The DNS conflict is no longer available. Check the record again.",
  notReplaced: "Cloudflare could not replace the conflicting DNS record.",
  /** DnsRecordConflictException */
  conflict: (current: string) => `DNS record already points to ${current}.`,
} as const;

/** DnsRecordConflictException: another record uses the hostname. */
export class DnsRecordConflictError extends Error {
  constructor(
    readonly providerRecordId: string,
    readonly currentValue: string,
    readonly proposedValue: string,
  ) {
    super(CLOUDFLARE_DNS_MESSAGES.conflict(currentValue));
  }
}

/** A record as normalizeRemoteRecord() reads it. */
export interface RemoteRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  comment: string | null;
}

const headersOf = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}`, Accept: "application/json" });

async function send(net: ProviderNetwork, r: Omit<ProviderRequest, "headers" | "timeoutMs"> & { token: string }): Promise<ProviderResponse> {
  const { token, ...rest } = r;
  try {
    return await providerSend(net, { ...rest, headers: headersOf(token), timeoutMs: TIMEOUT_MS });
  } catch (e) {
    throw new ProviderConnectionError(e);
  }
}

/** PHP's (string) cast of a scalar. */
function phpString(v: PhpValue | undefined): string {
  if (v === undefined || v === null || v === false) return "";
  if (v === true) return "1";
  if (typeof v === "number") return String(v);
  return typeof v === "string" ? v : "";
}
/** strtolower(): ASCII only. */
export const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

function normalizeRemote(remote: PhpValue, hostname: string, type: string): RemoteRecord {
  const get = (k: string) => dataGet(remote, k);
  const comment = get("comment");
  return {
    id: get("id") === undefined || get("id") === null ? "" : phpString(get("id")),
    type: get("type") === undefined || get("type") === null ? type : phpString(get("type")),
    name: asciiLower(get("name") === undefined || get("name") === null ? hostname : phpString(get("name"))),
    content: get("content") === undefined || get("content") === null ? "" : phpString(get("content")),
    comment: typeof comment === "string" ? comment : null,
  };
}

/** A PHP array (a list or an object). */
const isArray = (v: PhpValue | undefined): boolean => Array.isArray(v) || isObj(v);
const valuesOf = (v: PhpValue | undefined): PhpValue[] => (Array.isArray(v) ? v : isObj(v) ? v.entries.map(([, x]) => x) : []);

/** findRecords(): the hostname's records of the type (every type when null). A 403 is the missing DNS Edit permission. */
export async function findRecords(net: ProviderNetwork, token: string, zoneId: string, hostname: string, type: string | null): Promise<RemoteRecord[]> {
  const name = asciiLower(hostname.replace(/\.+$/, ""));
  const query: Array<[string, string | number]> = [...(type ? [["type", type] as [string, string]] : []), ["name", name], ["per_page", 100]];
  const response = await send(net, { method: "get", url: `${CLOUDFLARE}/zones/${zoneId}/dns_records`, query, token });
  if (response.status === 403) throw new ProviderRejectedError(CLOUDFLARE_DNS_MESSAGES.dnsEdit);
  if (!response.successful) throw new ProviderRejectedError(CLOUDFLARE_DNS_MESSAGES.notChecked);
  const result = dataGet(response.json, "result");
  return valuesOf(result === undefined || result === null ? [] : result)
    .filter(isArray)
    .map((remote) => normalizeRemote(remote, name, type ?? ""));
}

/** conflictingRecords(): a CNAME cannot share its name with A, AAAA or other CNAME records. */
export async function conflictingRecords(net: ProviderNetwork, token: string, zoneId: string, hostname: string, type: string): Promise<RemoteRecord[]> {
  if (type !== "CNAME") return findRecords(net, token, zoneId, hostname, type);
  return (await findRecords(net, token, zoneId, hostname, null)).filter((r) => ["A", "AAAA", "CNAME"].includes(r.type));
}

/** createRecordLocked()'s POST: the new record's provider id. */
export async function createRemoteRecord(net: ProviderNetwork, token: string, zoneId: string, body: { type: string; name: string; content: string; proxied: boolean; comment: string }): Promise<string> {
  const response = await send(net, { method: "post", url: `${CLOUDFLARE}/zones/${zoneId}/dns_records`, json: { type: body.type, name: body.name, content: body.content, ttl: 1, proxied: body.proxied, comment: body.comment }, token });
  if (response.status === 403) throw new ProviderRejectedError(CLOUDFLARE_DNS_MESSAGES.dnsEdit);
  const id = dataGet(response.json, "result.id");
  if (!response.successful || typeof id !== "string") throw new ProviderRejectedError(CLOUDFLARE_DNS_MESSAGES.notCreated);
  return id;
}

/** replaceRecordLocked()'s PATCH: only the content (and the type when it differs) changes. */
export async function patchRemoteRecord(net: ProviderNetwork, token: string, zoneId: string, recordId: string, changes: Record<string, string | boolean>): Promise<void> {
  const response = await send(net, { method: "patch", url: `${CLOUDFLARE}/zones/${zoneId}/dns_records/${recordId}`, json: changes, token });
  if (response.status === 403) throw new ProviderRejectedError(CLOUDFLARE_DNS_MESSAGES.dnsEdit);
  if (!response.successful) throw new ProviderRejectedError(CLOUDFLARE_DNS_MESSAGES.notReplaced);
}

/** ManagedDnsDeletionResult's values. */
export type DeletionResult = "deleted" | "already_gone" | "not_owned" | "changed_externally" | "failed" | "busy";

/**
 * deleteRecord() for an owned record: the record is read again and deleted only while it still has its type, name,
 * content and ownership comment. Any failure (a transfer included) is "failed".
 */
export async function deleteRemoteRecord(net: ProviderNetwork, token: string, zoneId: string, record: { provider_record_id: string; type: string; name: string; content: string; comment: string }): Promise<DeletionResult> {
  const url = `${CLOUDFLARE}/zones/${zoneId}/dns_records/${record.provider_record_id}`;
  try {
    const response = await send(net, { method: "get", url, token });
    if (response.status === 404) return "already_gone";
    const remote = dataGet(response.json, "result");
    if (!response.successful || !isArray(remote)) return "failed";
    const field = (k: string) => dataGet(remote, k);
    const content = field("content");
    if (
      (field("type") ?? null) !== record.type ||
      asciiLower(phpString(field("name") ?? "")) !== record.name ||
      !sameAddress(typeof content === "string" ? content : null, record.content) ||
      (field("comment") ?? null) !== record.comment
    ) {
      return "changed_externally";
    }
    const deleted = await send(net, { method: "delete", url, token });
    if (deleted.status === 404) return "already_gone";
    if (!deleted.successful) return "failed";
  } catch {
    return "failed";
  }
  return "deleted";
}
