// Derived from coollabsio/coolify@91b7e3e:app/Services/Dns/ResourceDnsRecords.php (hostnameUsers, status, create,
// replace, release, recordData, prepare, normalizeHostname), app/Services/Dns/CloudflareDnsProvider.php (findZones,
// createRecord, replaceRecord, trackExistingRecord, assertResourcesManagedHere), app/Services/Dns/ManagedDnsRecordCleanup.php
// (hostnamesOf, releaseHostname, release, releaseLocked, resourcesUsingHostname, worseResult) and
// app/Enums/ManagedDnsDeletionResult.php (Apache-2.0), modified.
//
// The managed DNS records of an application's or a service's saved domains (the DNS API, DP-105). A service's domain
// belongs to one of its applications, which references the record. Only the org's Cloudflare zones are used, and a
// record only points to a public address of the resource's server. What Coolify does under its per-hostname cache lock
// is done here in three steps: what the database says is read (and, for a release, the references that need no provider
// are settled) in one transaction, Cloudflare is asked outside any transaction, and what it answered is written in
// another. Freeploy holds no lock across them, so it never answers 423.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  addManagedDnsReference,
  deleteManagedDnsRecord,
  deleteManagedDnsReference,
  deleteManagedDnsReferences,
  dnsHostnameCandidates,
  dnsReferenceIsLive,
  findManagedDnsRecordByProviderId,
  insertManagedDnsRecord,
  listCloudflareZones,
  listManagedDnsRecords,
  listManagedDnsReferences,
  managedDnsRecordProvider,
  managedDnsRecordsReferencing,
  updateManagedDnsRecord,
  type DeployDnsResource,
  type DeployDnsTokenZoneRow,
  type DeployManagedDnsRecordRow,
  type DnsResourceKey,
} from "@saas/db/deploy";
import { obj, type PhpObject } from "@saas/contracts/coolify-api";
import { isTransferredAway } from "../servers/service.js";
import { automaticDnsEnabled, metadataOf, proxiedDnsEnabled } from "../integration-tokens/service.js";
import { ProviderRejectedError } from "../integration-tokens/providers.js";
import type { ProviderNetwork } from "../api-v1/cloud-providers.js";
import { NO_PUBLIC_ADDRESS_MESSAGE, phpTrim, publicAddresses, recordContent, recordType, sameAddress, serverDnsAddresses, type DnsResolver } from "./addresses.js";
import { CLOUDFLARE_DNS_MESSAGES, asciiLower, conflictingRecords, createRemoteRecord, deleteRemoteRecord, DnsRecordConflictError, ownershipCommentFor, patchRemoteRecord, type DeletionResult, type RemoteRecord } from "./cloudflare.js";

export { DnsRecordConflictError };

/** Server::assertNotTransferredAway() */
export const TRANSFERRED_AWAY = "This server is managed by another Coolify instance.";

/** A ValidationException of ResourceDnsRecords: the field's messages. */
export class DnsValidationError extends Error {
  constructor(readonly errors: Record<string, string[]>) {
    super(Object.values(errors)[0]?.[0] ?? "");
  }
}

/** A ModelNotFoundException of release(): no managed record of the resource for the hostname. */
export class DnsRecordNotFoundError extends Error {}

/** What the DNS operations reach out with. */
export interface DnsDeps {
  /** One transaction confined to the org. */
  run<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  orgId: string;
  net: ProviderNetwork;
  resolve: DnsResolver;
  /** The token column's plain text. */
  decrypt(tx: SqlExecutor, stored: string): Promise<string>;
  /** The instance in the ownership comment (Coolify's app.id). */
  instance: string | undefined;
  newUuid(): string;
}

// ── hostnames ───────────────────────────────────────────────────────────────

/** normalizeHostname() of ResourceDnsRecords: trimmed, lower case, without the trailing dots. */
export const normalizeHostname = (hostname: string): string => asciiLower(phpTrim(hostname).replace(/\.+$/, ""));

/** parse_url($url, PHP_URL_HOST): the authority's host (an IPv6 literal with its brackets), or null where PHP gives false. */
export function urlHost(url: string): string | null {
  const at = url.indexOf("://");
  if (at < 0) return null;
  const rest = url.slice(at + 3);
  const authority = rest.slice(0, rest.search(/[/?#]|$/));
  if (authority === "" && rest.startsWith("/")) return null;
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  let host = hostPort;
  let port = "";
  if (hostPort.startsWith("[")) {
    const end = hostPort.indexOf("]");
    if (end < 0) return null;
    host = hostPort.slice(0, end + 1);
    port = hostPort.slice(end + 1).replace(/^:/, "");
  } else if (hostPort.includes(":")) {
    host = hostPort.slice(0, hostPort.indexOf(":"));
    port = hostPort.slice(hostPort.indexOf(":") + 1);
  }
  if (port !== "" && !/^\d+$/.test(port)) return null;
  return host === "" ? null : host;
}

const splitUrls = (value: string | null | undefined): string[] =>
  value === null || value === undefined || phpTrim(value) === "" ? [] : value.split(",").map((u) => phpTrim(u)).filter((u) => u !== "" && u !== "0");

/** hostnamesOf(): the hosts of the fqdn's URLs and of the Compose domains, normalized, once each. */
export function hostnamesOf(model: { fqdn: string | null; docker_compose_domains: string | null }): string[] {
  const values = splitUrls(model.fqdn);
  let compose: unknown = null;
  try {
    compose = model.docker_compose_domains ? JSON.parse(model.docker_compose_domains) : null;
  } catch {
    compose = null;
  }
  if (compose !== null && typeof compose === "object") {
    for (const service of Array.isArray(compose) ? compose : Object.values(compose)) {
      const domain = service !== null && typeof service === "object" ? (service as Record<string, unknown>).domain : null;
      values.push(...splitUrls(typeof domain === "string" ? domain : null));
    }
  }
  const out: string[] = [];
  for (const url of values) {
    const host = urlHost(url.includes("://") ? url : `http://${url}`);
    if (host === null) continue;
    const name = asciiLower(host).replace(/\.+$/, "");
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** hostnameUsers(): each hostname with the models that use it, sorted by hostname (ksort). */
export function hostnameUsers(resource: DeployDnsResource): Map<string, DnsResourceKey[]> {
  const users = new Map<string, DnsResourceKey[]>();
  for (const model of resource.models) {
    for (const hostname of hostnamesOf(model)) users.set(hostname, [...(users.get(hostname) ?? []), [model.morph, model.id]]);
  }
  return new Map([...users.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** findZones(): the zones that manage the hostname, the longest name only (several tokens can share it). */
export function findZones(zones: readonly DeployDnsTokenZoneRow[], hostname: string): DeployDnsTokenZoneRow[] {
  const name = asciiLower(hostname.replace(/\.+$/, ""));
  const matches = zones.filter((z) => name === z.name || name.endsWith(`.${z.name}`));
  const longest = Math.max(...matches.map((z) => z.name.length));
  return matches.filter((z) => z.name.length === longest);
}

// ── answers ─────────────────────────────────────────────────────────────────

/** recordData() */
export function recordData(record: Pick<DeployManagedDnsRecordRow, "uuid" | "name" | "type" | "content" | "owned" | "token_uuid">): PhpObject {
  return obj({ uuid: record.uuid, hostname: record.name, type: record.type, address: record.content, owned: Boolean(record.owned), integration_token_uuid: record.token_uuid ?? null });
}

/** status(): the providers and the managed records of every hostname of the resource. Reads only the database (and the server's name). */
export async function dnsStatus(tx: SqlExecutor, resource: DeployDnsResource, resolve: DnsResolver): Promise<PhpObject> {
  const hostnames = [...hostnameUsers(resource).keys()];
  const records = await listManagedDnsRecords(tx, hostnames);
  const addresses = await serverDnsAddresses(resource.server, resolve);
  const zones = await listCloudflareZones(tx);
  return obj({
    default_address: recordContent(addresses),
    public_addresses: publicAddresses(addresses),
    hostnames: hostnames.map((hostname) =>
      obj({
        hostname,
        providers: findZones(zones, hostname).map((z) => {
          const metadata = metadataOf(z.token_metadata);
          return obj({ integration_token_uuid: z.token_uuid, integration_token_name: z.token_name, zone: z.name, automatic_dns: automaticDnsEnabled(z.token_provider, metadata), proxied_dns: proxiedDnsEnabled(z.token_provider, metadata) });
        }),
        records: records.filter((r) => r.name === hostname).map(recordData),
      }),
    ),
  });
}

// ── create and replace ──────────────────────────────────────────────────────

interface Prepared {
  hostname: string;
  users: DnsResourceKey[];
  zone: DeployDnsTokenZoneRow;
  token: string;
  content: string;
}

/** prepare(): the hostname is the resource's, the server has the address, exactly one zone of the org manages it. */
async function prepare(deps: DnsDeps, tx: SqlExecutor, resource: DeployDnsResource, raw: string, tokenUuid: string | null, requested: string | null): Promise<Prepared> {
  const hostname = normalizeHostname(raw);
  const users = hostnameUsers(resource).get(hostname);
  if (!users) throw new DnsValidationError({ hostname: [`${hostname} is not a domain of this resource.`] });
  const addresses = await serverDnsAddresses(resource.server, deps.resolve);
  const publicList = publicAddresses(addresses);
  if (publicList.length === 0) throw new DnsValidationError({ address: [NO_PUBLIC_ADDRESS_MESSAGE] });
  const content = recordContent(addresses, requested);
  if (content === null) throw new DnsValidationError({ address: [`The address must be a public address of the server: ${publicList.join(", ")}.`] });
  let zones = findZones(await listCloudflareZones(tx), hostname);
  if (tokenUuid !== null) zones = zones.filter((z) => z.token_uuid === tokenUuid);
  if (zones.length === 0) throw new DnsValidationError({ integration_token_uuid: [`No connected DNS provider of the team manages ${hostname}.`] });
  if (zones.length > 1) throw new DnsValidationError({ integration_token_uuid: [`Several DNS providers manage ${hostname}. Set integration_token_uuid to one of: ${zones.map((z) => z.token_uuid).join(", ")}.`] });
  const zone = zones[0]!;
  return { hostname, users, zone, token: await deps.decrypt(tx, zone.token_secret), content };
}

/** assertResourcesManagedHere(): the users are the resource's models, all on its server. */
function assertManagedHere(resource: DeployDnsResource): void {
  if (resource.server && isTransferredAway(resource.server)) throw new ProviderRejectedError(TRANSFERRED_AWAY);
}

/** trackExistingRecord(): a new row is never owned; an owned row whose comment no longer matches loses its ownership. */
async function trackExistingRecord(deps: DnsDeps, tx: SqlExecutor, p: Prepared, remote: RemoteRecord, type: string): Promise<DeployManagedDnsRecordRow> {
  const existing = await findManagedDnsRecordByProviderId(tx, p.zone.id, remote.id);
  const values = { integrationTokenId: p.zone.integration_token_id, type, name: p.hostname, content: p.content };
  if (!existing) return insertManagedDnsRecord(tx, deps.orgId, deps.newUuid(), { ...values, zoneId: p.zone.id, providerRecordId: remote.id, owned: false });
  const owned = Boolean(existing.owned) && remote.comment === ownershipCommentFor(deps.instance, existing.uuid);
  return updateManagedDnsRecord(tx, existing.id, { ...values, owned });
}

async function addReferences(deps: DnsDeps, tx: SqlExecutor, record: DeployManagedDnsRecordRow, users: readonly DnsResourceKey[]): Promise<void> {
  for (const key of users) await addManagedDnsReference(tx, deps.orgId, record.id, key);
}

const prepareInOrg = (deps: DnsDeps, resource: DeployDnsResource, hostname: string, tokenUuid: string | null, content: string | null) => deps.run((tx) => prepare(deps, tx, resource, hostname, tokenUuid, content));

/**
 * create(): an existing record with the content is adopted (never owned when Coolify did not create it); another record
 * is a conflict (DnsRecordConflictError) or, several, a refusal; else the record is created with the ownership comment.
 */
export async function createDnsRecord(deps: DnsDeps, resource: DeployDnsResource, hostname: string, tokenUuid: string | null, requested: string | null): Promise<DeployManagedDnsRecordRow> {
  const p = await prepareInOrg(deps, resource, hostname, tokenUuid, requested);
  assertManagedHere(resource);
  const type = recordType(p.content);
  const remotes = await conflictingRecords(deps.net, p.token, p.zone.provider_zone_id, p.hostname, type);
  const matching = remotes.find((r) => r.type === type && sameAddress(r.content, p.content));
  if (matching) {
    if (matching.id === "") throw new ProviderRejectedError(CLOUDFLARE_DNS_MESSAGES.notChecked);
    return deps.run(async (tx) => {
      const record = await trackExistingRecord(deps, tx, p, matching, type);
      await addReferences(deps, tx, record, p.users);
      return record;
    });
  }
  if (remotes.length > 1) throw new ProviderRejectedError(CLOUDFLARE_DNS_MESSAGES.several(p.hostname));
  if (remotes.length === 1) throw new DnsRecordConflictError(remotes[0]!.id, remotes[0]!.content, p.content);
  const uuid = deps.newUuid();
  const providerRecordId = await createRemoteRecord(deps.net, p.token, p.zone.provider_zone_id, {
    type,
    name: p.hostname,
    content: p.content,
    proxied: proxiedDnsEnabled(p.zone.token_provider, metadataOf(p.zone.token_metadata)),
    comment: ownershipCommentFor(deps.instance, uuid),
  });
  return deps.run(async (tx) => {
    const record = await insertManagedDnsRecord(tx, deps.orgId, uuid, { integrationTokenId: p.zone.integration_token_id, zoneId: p.zone.id, providerRecordId, type, name: p.hostname, content: p.content, owned: true });
    await addReferences(deps, tx, record, p.users);
    return record;
  });
}

/** replace(): the conflicting record, still with the id and the content the conflict reported, points to the server. */
export async function replaceDnsRecord(deps: DnsDeps, resource: DeployDnsResource, hostname: string, tokenUuid: string | null, recordId: string, current: string, requested: string | null): Promise<DeployManagedDnsRecordRow> {
  const p = await prepareInOrg(deps, resource, hostname, tokenUuid, requested);
  assertManagedHere(resource);
  const type = recordType(p.content);
  const remotes = await conflictingRecords(deps.net, p.token, p.zone.provider_zone_id, p.hostname, type);
  if (remotes.length > 1) throw new ProviderRejectedError(CLOUDFLARE_DNS_MESSAGES.several(p.hostname));
  const remote = remotes[0];
  if (!remote || remote.id === "" || remote.id !== recordId || !sameAddress(remote.content, current) || remote.name !== p.hostname) {
    throw new ProviderRejectedError(CLOUDFLARE_DNS_MESSAGES.conflictGone);
  }
  const changes: Record<string, string | boolean> = { content: p.content };
  if (remote.type !== type) changes.type = type;
  await patchRemoteRecord(deps.net, p.token, p.zone.provider_zone_id, remote.id, changes);
  return deps.run(async (tx) => {
    const record = await trackExistingRecord(deps, tx, p, remote, type);
    await addReferences(deps, tx, record, p.users);
    return record;
  });
}

// ── release ─────────────────────────────────────────────────────────────────

/** ManagedDnsDeletionResult::shouldRetry() */
const shouldRetry = (r: DeletionResult | null): boolean => r === "failed" || r === "busy";

/** worseResult() */
function worse(current: DeletionResult | null, next: DeletionResult | null): DeletionResult | null {
  const rank = (r: DeletionResult | null): number => (r === "failed" ? 4 : r === "busy" ? 3 : r === "changed_externally" ? 2 : r === null ? 0 : 1);
  return rank(next) > rank(current) ? next : current;
}

const sameKey = (a: DnsResourceKey, b: DnsResourceKey): boolean => a[0] === b[0] && String(a[1]) === String(b[1]);

/** A record whose provider record is to be deleted, with what deleteRecord() compares. */
interface PendingDeletion {
  record: DeployManagedDnsRecordRow;
  zoneId: string;
  token: string;
}

/**
 * releaseLocked() up to the provider: dead references dropped; a record another live resource references, or that a
 * resource of the org still uses by its hostname, keeps it (the releasing references go, the users' are added); a record
 * not owned, or kept on request, is forgotten. What is left is a pending deletion at the provider.
 */
async function releaseRecord(deps: DnsDeps, tx: SqlExecutor, record: DeployManagedDnsRecordRow, releasing: DnsResourceKey[], deleteRecord: boolean): Promise<DeletionResult | null | PendingDeletion> {
  const others = (await listManagedDnsReferences(tx, record.id)).filter((f) => !releasing.some((k) => sameKey(k, [f.resource_type, f.resource_id])));
  let live = false;
  for (const reference of others) {
    if (await dnsReferenceIsLive(tx, [reference.resource_type, reference.resource_id])) live = true;
    else await deleteManagedDnsReference(tx, reference.id);
  }
  if (live) {
    await deleteManagedDnsReferences(tx, record.id, releasing);
    return null;
  }
  // resourcesUsingHostname(): the org's live applications, previews and service applications (row-level security hides
  // every other org's, so a record is never forgotten because another org uses the hostname).
  const users = (await dnsHostnameCandidates(tx, record.name)).filter((u) => !releasing.some((k) => sameKey(k, [u.morph, u.id])) && hostnamesOf(u).includes(record.name));
  if (users.length > 0) {
    for (const user of users) await addManagedDnsReference(tx, deps.orgId, record.id, [user.morph, user.id]);
    await deleteManagedDnsReferences(tx, record.id, releasing);
    return null;
  }
  if (!record.owned || !deleteRecord) {
    await deleteManagedDnsRecord(tx, record.id);
    return record.owned ? null : "not_owned";
  }
  const provider = await managedDnsRecordProvider(tx, record.id);
  if (!provider) return "failed";
  return { record, zoneId: provider.provider_zone_id, token: await deps.decrypt(tx, provider.token_secret) };
}

/**
 * release(): the resource's references to the managed record of a hostname it no longer uses. The provider record is
 * deleted only when deleteRecord is set, Freeploy created it, it did not change and nothing else uses the hostname.
 * Null: released, the provider record kept.
 */
export async function releaseDnsRecord(deps: DnsDeps, resource: DeployDnsResource, raw: string, deleteRecord: boolean): Promise<DeletionResult | null> {
  const hostname = normalizeHostname(raw);
  const planned = await deps.run(async (tx) => {
    if (hostnameUsers(resource).has(hostname)) throw new DnsValidationError({ hostname: [`The resource still uses ${hostname}. Remove the domain first; its DNS record is then released.`] });
    const perModel: Array<{ records: DeployManagedDnsRecordRow[]; key: DnsResourceKey }> = [];
    for (const model of resource.models) {
      const key: DnsResourceKey = [model.morph, model.id];
      const records = await managedDnsRecordsReferencing(tx, hostname, key);
      if (records.length > 0) perModel.push({ records, key });
    }
    if (perModel.length === 0) throw new DnsRecordNotFoundError();
    const outcomes: Array<Array<DeletionResult | null | PendingDeletion>> = [];
    for (const { records, key } of perModel) {
      const results: Array<DeletionResult | null | PendingDeletion> = [];
      for (const listed of records) {
        // $record->fresh(): an earlier model's release may have settled it.
        const fresh = (await listManagedDnsRecords(tx, [hostname])).find((r) => String(r.id) === String(listed.id));
        results.push(fresh ? await releaseRecord(deps, tx, fresh, [key], deleteRecord) : null);
      }
      outcomes.push(results);
    }
    return outcomes;
  });
  // deleteRecord(): asked of Cloudflare outside the transaction, then the row forgotten unless the provider failed.
  const settled: Array<Array<DeletionResult | null>> = [];
  const forget: Array<string | number> = [];
  for (const results of planned) {
    const out: Array<DeletionResult | null> = [];
    for (const r of results) {
      if (r === null || typeof r === "string") {
        out.push(r);
        continue;
      }
      const result = await deleteRemoteRecord(deps.net, r.token, r.zoneId, { ...r.record, comment: ownershipCommentFor(deps.instance, r.record.uuid) });
      if (result !== "failed") forget.push(r.record.id);
      out.push(result);
    }
    settled.push(out);
  }
  if (forget.length > 0) await deps.run(async (tx) => {
    for (const id of forget) await deleteManagedDnsRecord(tx, id);
  });
  const results = settled.map((rs) => rs.reduce<DeletionResult | null>((w, r) => worse(w, r), null)).filter((r): r is DeletionResult => r !== null);
  return results.find(shouldRetry) ?? results.find((r) => r === "changed_externally") ?? results[0] ?? null;
}
