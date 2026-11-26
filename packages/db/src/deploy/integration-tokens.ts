// Derived from coollabsio/coolify@91b7e3e:app/Models/IntegrationToken.php (dnsZones(), secretManagerLinks(),
// managedDnsRecords(), deletionBlocker()), app/Models/DnsProviderZone.php, app/Services/Dns/CloudflareDnsProvider.php
// (syncZones()), app/Livewire/Security/{IntegrationTokens,IntegrationTokenEditor}.php and
// app/Http/Controllers/Api/IntegrationTokensController.php (Apache-2.0), modified.
//
// deploy.integration_tokens queries, and the DNS zones of a Cloudflare token (deploy.dns_provider_zones). Every function
// takes the transaction of withOrg(): row-level security confines each query to that org, which is what Coolify's
// ownedByCurrentTeam() / where('team_id', …) does. The token column holds an fp1 ciphertext (crypto.ts); these functions
// never decrypt. The JSON columns (capabilities, metadata) are read as their text, so a caller decodes them as PHP's
// array cast does, keys in their stored order.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

export interface DeployIntegrationTokenRow extends SqlRow {
  id: string | number;
  uuid: string;
  provider: string;
  name: string;
  /** The JSON text of the capabilities column. */
  capabilities: string;
  /** The JSON text of the metadata column, or null. */
  metadata: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
  /** withCount('dnsZones') */
  dns_zones_count: string | number;
}

/** A row with its stored (encrypted) token. */
export interface DeployIntegrationTokenWithSecretRow extends DeployIntegrationTokenRow {
  token: string;
}

const COLUMNS = `t.id, t.uuid, t.provider, t.name, t.capabilities::text AS capabilities, t.metadata::text AS metadata, t.created_at, t.updated_at,
  (SELECT count(*) FROM deploy.dns_provider_zones z WHERE z.integration_token_id = t.id) AS dns_zones_count`;

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** IntegrationToken::ownedByCurrentTeam()->withCount('dnsZones')->latest()->get(). */
export async function listIntegrationTokens(tx: SqlExecutor): Promise<DeployIntegrationTokenRow[]> {
  const r = await tx.execute<DeployIntegrationTokenRow>(`SELECT ${COLUMNS} FROM deploy.integration_tokens t ORDER BY t.created_at DESC, t.id DESC`);
  return r.rows;
}

/** ownedByCurrentTeam()->whereUuid($uuid)->first(), with the encrypted token and the zone count. */
export async function findIntegrationTokenByUuid(tx: SqlExecutor, uuid: string): Promise<DeployIntegrationTokenWithSecretRow | null> {
  const r = await tx.execute<DeployIntegrationTokenWithSecretRow>(`SELECT ${COLUMNS}, t.token FROM deploy.integration_tokens t WHERE t.uuid = $1`, [uuid]);
  return r.rows[0] ?? null;
}

export interface NewIntegrationToken {
  orgId: string;
  uuid: string;
  provider: string;
  name: string;
  /** The fp1 ciphertext of the token. */
  token: string;
  /** JSON text. */
  capabilities: string;
  /** JSON text, or null. */
  metadata: string | null;
}

export async function insertIntegrationToken(tx: SqlExecutor, token: NewIntegrationToken): Promise<DeployIntegrationTokenRow> {
  await tx.execute(
    `INSERT INTO deploy.integration_tokens (uuid, provider, name, token, capabilities, metadata, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::json, $6::json, $7, ${NOW}, ${NOW})`,
    [token.uuid, token.provider, token.name, token.token, token.capabilities, token.metadata, token.orgId],
  );
  const r = await tx.execute<DeployIntegrationTokenRow>(`SELECT ${COLUMNS} FROM deploy.integration_tokens t WHERE t.uuid = $1`, [token.uuid]);
  return r.rows[0]!;
}

/** The columns an update may change; only those given are written (Eloquent saves the dirty attributes only). */
export interface IntegrationTokenChanges {
  name?: string;
  /** The fp1 ciphertext of a new token. */
  token?: string;
  /** JSON text. */
  capabilities?: string;
  /** JSON text, or null. */
  metadata?: string | null;
}

/** $integrationToken->update($changes): nothing (updated_at untouched) when nothing is given. */
export async function updateIntegrationToken(tx: SqlExecutor, id: string | number, changes: IntegrationTokenChanges): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (column: string, value: unknown, cast = "") => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };
  if (changes.name !== undefined) set("name", changes.name);
  if (changes.token !== undefined) set("token", changes.token);
  if (changes.capabilities !== undefined) set("capabilities", changes.capabilities, "::json");
  if (changes.metadata !== undefined) set("metadata", changes.metadata, "::json");
  if (sets.length === 0) return true;
  const r = await tx.execute(`UPDATE deploy.integration_tokens SET ${sets.join(", ")}, updated_at = ${NOW} WHERE id = $1 RETURNING id`, params);
  return r.rows.length > 0;
}

/** $token->delete(): the token's zones go with it (Coolify's foreign key cascades; deploy's tables have none). */
export async function deleteIntegrationToken(tx: SqlExecutor, id: string | number): Promise<boolean> {
  await tx.execute("DELETE FROM deploy.dns_provider_zones WHERE integration_token_id = $1", [id]);
  const r = await tx.execute("DELETE FROM deploy.integration_tokens WHERE id = $1 RETURNING id", [id]);
  return r.rows.length > 0;
}

/** secretManagerLinks()->exists() and managedDnsRecords()->exists(): what deletionBlocker() asks. */
export async function integrationTokenUsage(tx: SqlExecutor, id: string | number): Promise<{ secretManagerLinks: boolean; managedDnsRecords: boolean }> {
  const r = await tx.execute<{ links: boolean; records: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM deploy.secret_manager_links WHERE integration_token_id = $1) AS links,
            EXISTS (SELECT 1 FROM deploy.managed_dns_records WHERE integration_token_id = $1) AS records`,
    [id],
  );
  return { secretManagerLinks: Boolean(r.rows[0]?.links), managedDnsRecords: Boolean(r.rows[0]?.records) };
}

export interface DeployDnsZoneRow extends SqlRow {
  id: string | number;
  name: string;
  account_name: string | null;
  managed_records_count: string | number;
}

/** IntegrationTokenEditor::loadZones(): dnsZones()->withCount('managedRecords')->orderBy('name'). */
export async function listIntegrationTokenZones(tx: SqlExecutor, tokenId: string | number): Promise<DeployDnsZoneRow[]> {
  const r = await tx.execute<DeployDnsZoneRow>(
    `SELECT z.id, z.name, z.account_name, (SELECT count(*) FROM deploy.managed_dns_records m WHERE m.dns_provider_zone_id = z.id) AS managed_records_count
       FROM deploy.dns_provider_zones z WHERE z.integration_token_id = $1 ORDER BY z.name, z.id`,
    [tokenId],
  );
  return r.rows;
}

/** A zone as Cloudflare's /zones lists it, its name lowercased. */
export interface SyncedZone {
  providerZoneId: string;
  name: string;
  accountId: string | null;
  accountName: string | null;
}

/**
 * syncZones()'s transaction: each zone updated (when a column differs) or created by its provider id, the token's other
 * zones deleted unless a managed record uses them, and the token's metadata (with zones_synced_at) written.
 */
export async function syncIntegrationTokenZones(tx: SqlExecutor, orgId: string, tokenId: string | number, zones: readonly SyncedZone[], newUuid: () => string, metadata: string): Promise<void> {
  for (const zone of zones) {
    const existing = await tx.execute<{ id: string | number }>("SELECT id FROM deploy.dns_provider_zones WHERE integration_token_id = $1 AND provider_zone_id = $2", [tokenId, zone.providerZoneId]);
    const id = existing.rows[0]?.id;
    if (id !== undefined) {
      await tx.execute(
        `UPDATE deploy.dns_provider_zones SET name = $2, account_id = $3, account_name = $4, updated_at = ${NOW}
          WHERE id = $1 AND (name IS DISTINCT FROM $2 OR account_id IS DISTINCT FROM $3 OR account_name IS DISTINCT FROM $4)`,
        [id, zone.name, zone.accountId, zone.accountName],
      );
    } else {
      await tx.execute(
        `INSERT INTO deploy.dns_provider_zones (uuid, integration_token_id, provider_zone_id, name, account_id, account_name, org_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, ${NOW}, ${NOW})`,
        [newUuid(), tokenId, zone.providerZoneId, zone.name, zone.accountId, zone.accountName, orgId],
      );
    }
  }
  await tx.execute(
    `DELETE FROM deploy.dns_provider_zones z WHERE z.integration_token_id = $1 AND NOT (z.provider_zone_id = ANY($2::text[]))
        AND NOT EXISTS (SELECT 1 FROM deploy.managed_dns_records m WHERE m.dns_provider_zone_id = z.id)`,
    [tokenId, zones.map((z) => z.providerZoneId)],
  );
  await tx.execute(`UPDATE deploy.integration_tokens SET metadata = $2::json, updated_at = ${NOW} WHERE id = $1 AND metadata::text IS DISTINCT FROM $2`, [tokenId, metadata]);
}
