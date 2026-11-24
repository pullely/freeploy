// Derived from coollabsio/coolify@91b7e3e:app/Models/CloudProviderToken.php,
// app/Livewire/Security/{CloudProviderTokens,CloudProviderTokenForm}.php,
// app/Livewire/Security/CloudProviderToken/Show.php and
// app/Livewire/Server/CloudProviderToken/Show.php (Apache-2.0), modified.
//
// deploy.cloud_provider_tokens queries, and the columns of deploy.servers the
// server's Cloud Token page reads and writes. Every function takes the
// transaction of withOrg(): row-level security confines each query to that
// org, which is what Coolify's ownedByCurrentTeam() / where('team_id', …)
// does. The token column holds an fp1 ciphertext (crypto.ts); these functions
// never decrypt.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

export interface DeployCloudProviderTokenRow extends SqlRow {
  id: string | number;
  uuid: string | null;
  provider: string;
  name: string | null;
  description: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

/** A row with its stored (encrypted) token. */
export interface DeployCloudProviderTokenWithSecretRow extends DeployCloudProviderTokenRow {
  token: string;
}

const COLUMNS = "id, uuid, provider, name, description, created_at, updated_at";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/**
 * CloudProviderToken::ownedByCurrentTeam()->get(), or forProvider($provider)
 * of it (the server page lists the tokens of the server's provider).
 */
export async function listCloudProviderTokens(tx: SqlExecutor, provider?: string): Promise<DeployCloudProviderTokenRow[]> {
  const r =
    provider === undefined
      ? await tx.execute<DeployCloudProviderTokenRow>(`SELECT ${COLUMNS} FROM deploy.cloud_provider_tokens ORDER BY id`)
      : await tx.execute<DeployCloudProviderTokenRow>(`SELECT ${COLUMNS} FROM deploy.cloud_provider_tokens WHERE provider = $1 ORDER BY id`, [provider]);
  return r.rows;
}

/** ownedByCurrentTeam()->whereUuid($uuid)->first(), with the encrypted token. */
export async function findCloudProviderTokenByUuid(tx: SqlExecutor, uuid: string): Promise<DeployCloudProviderTokenWithSecretRow | null> {
  const r = await tx.execute<DeployCloudProviderTokenWithSecretRow>(`SELECT ${COLUMNS}, token FROM deploy.cloud_provider_tokens WHERE uuid = $1`, [uuid]);
  return r.rows[0] ?? null;
}

/** $server->cloudProviderToken: a token by id, with its encrypted value, when it still exists. */
export async function findCloudProviderTokenById(tx: SqlExecutor, id: string | number): Promise<DeployCloudProviderTokenWithSecretRow | null> {
  const r = await tx.execute<DeployCloudProviderTokenWithSecretRow>(`SELECT ${COLUMNS}, token FROM deploy.cloud_provider_tokens WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export interface NewCloudProviderToken {
  orgId: string;
  uuid: string;
  provider: string;
  /** The fp1 ciphertext of the token. */
  token: string;
  name: string;
  description: string | null;
}

export async function insertCloudProviderToken(tx: SqlExecutor, token: NewCloudProviderToken): Promise<DeployCloudProviderTokenRow> {
  const r = await tx.execute<DeployCloudProviderTokenRow>(
    `INSERT INTO deploy.cloud_provider_tokens (uuid, provider, token, name, description, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, ${NOW}, ${NOW}) RETURNING ${COLUMNS}`,
    [token.uuid, token.provider, token.token, token.name, token.description, token.orgId],
  );
  return r.rows[0]!;
}

export interface CloudProviderTokenChanges {
  name: string;
  description: string | null;
}

/** Show::save(): the name and description; the provider and the token never change. */
export async function updateCloudProviderToken(tx: SqlExecutor, id: string | number, changes: CloudProviderTokenChanges): Promise<DeployCloudProviderTokenRow | null> {
  const r = await tx.execute<DeployCloudProviderTokenRow>(
    `UPDATE deploy.cloud_provider_tokens SET name = $2, description = $3, updated_at = ${NOW} WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, changes.name, changes.description],
  );
  return r.rows[0] ?? null;
}

export async function deleteCloudProviderToken(tx: SqlExecutor, id: string | number): Promise<boolean> {
  const r = await tx.execute("DELETE FROM deploy.cloud_provider_tokens WHERE id = $1 RETURNING id", [id]);
  return r.rows.length > 0;
}

/** $token->servers()->count(): the servers that use the token (Server soft-deletes, so trashed ones do not count). */
export async function cloudProviderTokenServerCount(tx: SqlExecutor, id: string | number): Promise<number> {
  const r = await tx.execute<{ n: string | number }>(`SELECT count(*) AS n FROM deploy.servers WHERE cloud_provider_token_id = $1 AND deleted_at IS NULL`, [id]);
  return Number(r.rows[0]?.n ?? 0);
}

/** What the server's Cloud Token page needs of a server. */
export interface DeployServerCloudRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  hetzner_server_id: string | number | null;
  vultr_instance_id: string | null;
  hostinger_virtual_machine_id: string | number | null;
  cloud_provider_token_id: string | number | null;
}

/** Server::ownedByCurrentTeam()->whereUuid($uuid)->first(), with its provider ids and token id. */
export async function findServerCloud(tx: SqlExecutor, uuid: string): Promise<DeployServerCloudRow | null> {
  const r = await tx.execute<DeployServerCloudRow>(
    `SELECT id, uuid, name, hetzner_server_id, vultr_instance_id, hostinger_virtual_machine_id, cloud_provider_token_id
       FROM deploy.servers WHERE uuid = $1 AND deleted_at IS NULL`,
    [uuid],
  );
  return r.rows[0] ?? null;
}

/** $server->cloudProviderToken()->associate($token)->save(). */
export async function setServerCloudProviderToken(tx: SqlExecutor, serverId: string | number, tokenId: string | number): Promise<boolean> {
  const r = await tx.execute(`UPDATE deploy.servers SET cloud_provider_token_id = $2, updated_at = ${NOW} WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [serverId, tokenId]);
  return r.rows.length > 0;
}
