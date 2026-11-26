// Derived from coollabsio/coolify@91b7e3e:app/Models/{DnsProviderZone,ManagedDnsRecord,ManagedDnsRecordReference}.php,
// app/Services/Dns/{ResourceDnsRecords,CloudflareDnsProvider,ManagedDnsRecordCleanup}.php (the queries) and
// app/Http/Controllers/Api/DnsController.php (zones()) (Apache-2.0), modified.
//
// The managed DNS records of an org (deploy.managed_dns_records), the resources that reference each one
// (deploy.managed_dns_record_references: an application, a preview or a service application, by Coolify's morph class)
// and what the DNS API reads around them: the Cloudflare zones of the org's integration tokens, an application's or a
// service's domains and the server its records point to. Every function takes the transaction of withOrg(): row-level
// security confines each query to that org, which is what Coolify's where('team_id', …) and whereHas('integrationToken',
// team) do. Coolify's foreign keys cascade a record's deletion to its references; deploy's tables have none, so
// deleteManagedDnsRecord() deletes them itself.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

/** Coolify's morph classes of what references a managed record (ManagedDnsRecord::addReference()). */
export const DNS_RESOURCE_MORPH_CLASS = {
  application: "App\\Models\\Application",
  preview: "App\\Models\\ApplicationPreview",
  serviceApplication: "App\\Models\\ServiceApplication",
} as const;

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

export interface DeployDnsTokenZoneRow extends SqlRow {
  id: string | number;
  name: string;
  provider_zone_id: string;
  account_name: string | null;
  integration_token_id: string | number;
  token_uuid: string;
  token_name: string;
  token_provider: string;
  /** The JSON text of the token's metadata, or null. */
  token_metadata: string | null;
  /** The token's fp1 ciphertext (never decrypted here). */
  token_secret: string;
  /** withCount('managedRecords') */
  managed_records_count: string | number;
}

/**
 * The zones of the org's Cloudflare tokens with their token: zonesForTeam() (in id order, as Coolify's unordered get()
 * gives them) or, with byName, the zones() list's orderBy('name').
 */
export async function listCloudflareZones(tx: SqlExecutor, byName = false): Promise<DeployDnsTokenZoneRow[]> {
  const r = await tx.execute<DeployDnsTokenZoneRow>(
    `SELECT z.id, z.name, z.provider_zone_id, z.account_name, z.integration_token_id, t.uuid AS token_uuid, t.name AS token_name,
            t.provider AS token_provider, t.metadata::text AS token_metadata, t.token AS token_secret,
            (SELECT count(*) FROM deploy.managed_dns_records m WHERE m.dns_provider_zone_id = z.id) AS managed_records_count
       FROM deploy.dns_provider_zones z JOIN deploy.integration_tokens t ON t.id = z.integration_token_id
      WHERE t.provider = 'cloudflare'
      ORDER BY ${byName ? "z.name, z.id" : "z.id"}`,
  );
  return r.rows;
}

/** The server a resource's records point to: its address, its transfer metadata and its public IPs. */
export interface DeployDnsServerRow extends SqlRow {
  id: string | number;
  ip: string;
  server_metadata: unknown;
  public_ipv4: string | null;
  public_ipv6: string | null;
}

/** What holds domains: an application (fqdn, docker_compose_domains), a preview, or a service's application (fqdn). */
export interface DeployDnsDomainRow extends SqlRow {
  id: string | number;
  fqdn: string | null;
  docker_compose_domains: string | null;
}

export interface DeployDnsResource {
  id: string | number;
  /** The models whose domains count: the application itself, or the service's applications in id order. */
  models: Array<DeployDnsDomainRow & { morph: string }>;
  server: DeployDnsServerRow | null;
}

const SERVER_COLUMNS = `s.id, s.ip, s.server_metadata, st.public_ipv4, st.public_ipv6`;
const SERVER_JOIN = `LEFT JOIN deploy.server_settings st ON st.server_id = s.id`;

async function serverById(tx: SqlExecutor, id: string | number | null): Promise<DeployDnsServerRow | null> {
  if (id === null || id === undefined) return null;
  const r = await tx.execute<DeployDnsServerRow>(`SELECT ${SERVER_COLUMNS} FROM deploy.servers s ${SERVER_JOIN} WHERE s.id = $1 AND s.deleted_at IS NULL ORDER BY st.id LIMIT 1`, [id]);
  return r.rows[0] ?? null;
}

/** Application::ownedByCurrentTeamAPI()->where('uuid', …): not soft-deleted; its server through its destination. */
export async function findDnsApplication(tx: SqlExecutor, uuid: string): Promise<DeployDnsResource | null> {
  const r = await tx.execute<DeployDnsDomainRow & { server_id: string | number | null }>(
    `SELECT a.id, a.fqdn, a.docker_compose_domains,
            CASE a.destination_type WHEN 'App\\Models\\StandaloneDocker' THEN (SELECT d.server_id FROM deploy.standalone_dockers d WHERE d.id = a.destination_id)
                                    WHEN 'App\\Models\\SwarmDocker' THEN (SELECT d.server_id FROM deploy.swarm_dockers d WHERE d.id = a.destination_id) END AS server_id
       FROM deploy.applications a WHERE a.uuid = $1 AND a.deleted_at IS NULL ORDER BY a.id LIMIT 1`,
    [uuid],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { id: row.id, models: [{ id: row.id, fqdn: row.fqdn, docker_compose_domains: row.docker_compose_domains, morph: DNS_RESOURCE_MORPH_CLASS.application }], server: await serverById(tx, row.server_id) };
}

/** Service::whereRelation('environment.project.team', …)->where('uuid', …): not soft-deleted; its applications and server. */
export async function findDnsService(tx: SqlExecutor, uuid: string): Promise<DeployDnsResource | null> {
  const r = await tx.execute<{ id: string | number; server_id: string | number | null }>("SELECT id, server_id FROM deploy.services WHERE uuid = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1", [uuid]);
  const row = r.rows[0];
  if (!row) return null;
  const apps = await tx.execute<DeployDnsDomainRow>("SELECT id, fqdn, NULL::text AS docker_compose_domains FROM deploy.service_applications WHERE service_id = $1 AND deleted_at IS NULL ORDER BY id", [row.id]);
  return { id: row.id, models: apps.rows.map((a) => ({ ...a, morph: DNS_RESOURCE_MORPH_CLASS.serviceApplication })), server: await serverById(tx, row.server_id) };
}

export interface DeployManagedDnsRecordRow extends SqlRow {
  id: string | number;
  uuid: string;
  integration_token_id: string | number;
  dns_provider_zone_id: string | number;
  provider_record_id: string;
  type: string;
  name: string;
  content: string;
  owned: boolean;
  /** with('integrationToken'): its uuid (null when the token is gone). */
  token_uuid: string | null;
}

const RECORD_COLUMNS = `r.id, r.uuid, r.integration_token_id, r.dns_provider_zone_id, r.provider_record_id, r.type, r.name, r.content, r.owned,
  (SELECT t.uuid FROM deploy.integration_tokens t WHERE t.id = r.integration_token_id) AS token_uuid`;

/** ManagedDnsRecord::with('integrationToken')->whereIn('name', $hostnames)->get(), in id order. */
export async function listManagedDnsRecords(tx: SqlExecutor, names: readonly string[]): Promise<DeployManagedDnsRecordRow[]> {
  if (names.length === 0) return [];
  const r = await tx.execute<DeployManagedDnsRecordRow>(`SELECT ${RECORD_COLUMNS} FROM deploy.managed_dns_records r WHERE r.name = ANY($1::text[]) ORDER BY r.id`, [[...names]]);
  return r.rows;
}

export async function findManagedDnsRecord(tx: SqlExecutor, id: string | number): Promise<DeployManagedDnsRecordRow | null> {
  const r = await tx.execute<DeployManagedDnsRecordRow>(`SELECT ${RECORD_COLUMNS} FROM deploy.managed_dns_records r WHERE r.id = $1`, [id]);
  return r.rows[0] ?? null;
}

/** firstOrNew(['dns_provider_zone_id' => …, 'provider_record_id' => …]): the tracked row of a provider record. */
export async function findManagedDnsRecordByProviderId(tx: SqlExecutor, zoneId: string | number, providerRecordId: string): Promise<DeployManagedDnsRecordRow | null> {
  const r = await tx.execute<DeployManagedDnsRecordRow>(`SELECT ${RECORD_COLUMNS} FROM deploy.managed_dns_records r WHERE r.dns_provider_zone_id = $1 AND r.provider_record_id = $2`, [zoneId, providerRecordId]);
  return r.rows[0] ?? null;
}

export interface ManagedDnsRecordValues {
  integrationTokenId: string | number;
  zoneId: string | number;
  providerRecordId: string;
  type: string;
  name: string;
  content: string;
  owned: boolean;
}

export async function insertManagedDnsRecord(tx: SqlExecutor, orgId: string, uuid: string, v: ManagedDnsRecordValues): Promise<DeployManagedDnsRecordRow> {
  const r = await tx.execute<{ id: string | number }>(
    `INSERT INTO deploy.managed_dns_records (uuid, integration_token_id, dns_provider_zone_id, provider_record_id, type, name, content, owned, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${NOW}, ${NOW}) RETURNING id`,
    [uuid, v.integrationTokenId, v.zoneId, v.providerRecordId, v.type, v.name, v.content, v.owned, orgId],
  );
  return (await findManagedDnsRecord(tx, r.rows[0]!.id))!;
}

/** $record->fill([…])->save(): the dirty columns only (updated_at untouched when nothing changed). */
export async function updateManagedDnsRecord(tx: SqlExecutor, id: string | number, v: Omit<ManagedDnsRecordValues, "zoneId" | "providerRecordId">): Promise<DeployManagedDnsRecordRow> {
  await tx.execute(
    `UPDATE deploy.managed_dns_records SET integration_token_id = $2, type = $3, name = $4, content = $5, owned = $6, updated_at = ${NOW}
      WHERE id = $1 AND (integration_token_id IS DISTINCT FROM $2 OR type IS DISTINCT FROM $3 OR name IS DISTINCT FROM $4 OR content IS DISTINCT FROM $5 OR owned IS DISTINCT FROM $6)`,
    [id, v.integrationTokenId, v.type, v.name, v.content, v.owned],
  );
  return (await findManagedDnsRecord(tx, id))!;
}

/** $record->delete(), with its references (Coolify's cascade). */
export async function deleteManagedDnsRecord(tx: SqlExecutor, id: string | number): Promise<void> {
  await tx.execute("DELETE FROM deploy.managed_dns_record_references WHERE managed_dns_record_id = $1", [id]);
  await tx.execute("DELETE FROM deploy.managed_dns_records WHERE id = $1", [id]);
}

/** A resource key: its morph class and id. */
export type DnsResourceKey = readonly [type: string, id: string | number];

/** addReference(): references()->firstOrCreate([resource_type, resource_id]). */
export async function addManagedDnsReference(tx: SqlExecutor, orgId: string, recordId: string | number, key: DnsResourceKey): Promise<void> {
  await tx.execute(
    `INSERT INTO deploy.managed_dns_record_references (managed_dns_record_id, resource_type, resource_id, org_id, created_at, updated_at)
     SELECT $1::bigint, $2::varchar, $3::bigint, $4::uuid, ${NOW}, ${NOW}
      WHERE NOT EXISTS (SELECT 1 FROM deploy.managed_dns_record_references WHERE managed_dns_record_id = $1::bigint AND resource_type = $2::varchar AND resource_id = $3::bigint)`,
    [recordId, key[0], key[1], orgId],
  );
}

export interface DeployManagedDnsReferenceRow extends SqlRow {
  id: string | number;
  resource_type: string;
  resource_id: string | number;
}

/** $record->references()->get() */
export async function listManagedDnsReferences(tx: SqlExecutor, recordId: string | number): Promise<DeployManagedDnsReferenceRow[]> {
  const r = await tx.execute<DeployManagedDnsReferenceRow>("SELECT id, resource_type, resource_id FROM deploy.managed_dns_record_references WHERE managed_dns_record_id = $1 ORDER BY id", [recordId]);
  return r.rows;
}

export async function deleteManagedDnsReference(tx: SqlExecutor, id: string | number): Promise<void> {
  await tx.execute("DELETE FROM deploy.managed_dns_record_references WHERE id = $1", [id]);
}

/** deleteReferences(): the record's references of these resources (none when no key is given). */
export async function deleteManagedDnsReferences(tx: SqlExecutor, recordId: string | number, keys: readonly DnsResourceKey[]): Promise<void> {
  for (const [type, id] of keys) {
    await tx.execute("DELETE FROM deploy.managed_dns_record_references WHERE managed_dns_record_id = $1 AND resource_type = $2 AND resource_id = $3", [recordId, type, id]);
  }
}

/** ManagedDnsRecord::where('name', …)->whereHas('references', the resource's key)->get(), in id order. */
export async function managedDnsRecordsReferencing(tx: SqlExecutor, name: string, key: DnsResourceKey): Promise<DeployManagedDnsRecordRow[]> {
  const r = await tx.execute<DeployManagedDnsRecordRow>(
    `SELECT ${RECORD_COLUMNS} FROM deploy.managed_dns_records r
      WHERE r.name = $1 AND EXISTS (SELECT 1 FROM deploy.managed_dns_record_references f WHERE f.managed_dns_record_id = r.id AND f.resource_type = $2 AND f.resource_id = $3)
      ORDER BY r.id`,
    [name, key[0], key[1]],
  );
  return r.rows;
}

/** The zone and token of a record, to ask Cloudflare about it ($record->loadMissing(['zone', 'integrationToken'])). */
export async function managedDnsRecordProvider(tx: SqlExecutor, recordId: string | number): Promise<{ provider_zone_id: string; token_secret: string } | null> {
  const r = await tx.execute<{ provider_zone_id: string; token_secret: string }>(
    `SELECT z.provider_zone_id, t.token AS token_secret FROM deploy.managed_dns_records r
       JOIN deploy.dns_provider_zones z ON z.id = r.dns_provider_zone_id JOIN deploy.integration_tokens t ON t.id = r.integration_token_id
      WHERE r.id = $1`,
    [recordId],
  );
  return r.rows[0] ?? null;
}

const LIVE_TABLE: Record<string, string> = {
  [DNS_RESOURCE_MORPH_CLASS.application]: "deploy.applications",
  [DNS_RESOURCE_MORPH_CLASS.preview]: "deploy.application_previews",
  [DNS_RESOURCE_MORPH_CLASS.serviceApplication]: "deploy.service_applications",
};

/** $reference->resource !== null: the morphed row exists and is not soft-deleted (an unknown class is never live). */
export async function dnsReferenceIsLive(tx: SqlExecutor, key: DnsResourceKey): Promise<boolean> {
  const table = LIVE_TABLE[key[0]];
  if (!table) return false;
  const r = await tx.execute(`SELECT 1 FROM ${table} WHERE id = $1 AND deleted_at IS NULL`, [key[1]]);
  return r.rows.length > 0;
}

/** A candidate of resourcesUsingHostname(): its key, its domains, and the domains' text matched the hostname. */
export interface DeployDnsHostnameUserRow extends DeployDnsDomainRow {
  morph: string;
}

/**
 * resourcesUsingHostname()'s queries: the live applications and previews whose fqdn or docker_compose_domains, and the
 * service applications whose fqdn, contain the hostname (LOWER(…) LIKE '%hostname%'), applications first.
 */
export async function dnsHostnameCandidates(tx: SqlExecutor, hostname: string): Promise<DeployDnsHostnameUserRow[]> {
  const pattern = `%${hostname}%`;
  const out: DeployDnsHostnameUserRow[] = [];
  for (const [morph, table, compose] of [
    [DNS_RESOURCE_MORPH_CLASS.application, "deploy.applications", true],
    [DNS_RESOURCE_MORPH_CLASS.preview, "deploy.application_previews", true],
    [DNS_RESOURCE_MORPH_CLASS.serviceApplication, "deploy.service_applications", false],
  ] as const) {
    const r = await tx.execute<DeployDnsDomainRow>(
      `SELECT id, fqdn, ${compose ? "docker_compose_domains" : "NULL::text AS docker_compose_domains"} FROM ${table}
        WHERE deleted_at IS NULL AND (LOWER(fqdn) LIKE $1${compose ? " OR LOWER(docker_compose_domains) LIKE $1" : ""}) ORDER BY id`,
      [pattern],
    );
    out.push(...r.rows.map((row) => ({ ...row, morph })));
  }
  return out;
}
