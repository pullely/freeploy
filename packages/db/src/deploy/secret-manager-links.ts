// Derived from coollabsio/coolify@91b7e3e:app/Models/SecretManagerLink.php, app/Traits/HasSecretManager.php
// (secretManagerLink()) and app/Services/SecretManagers/ResourceSecretManager.php (teamTokens(), link(), unlink())
// (Apache-2.0), modified.
//
// deploy.secret_manager_links: the secret manager source of an application, a service or a standalone database — a
// Doppler, Infisical or Vault integration token of the org and the provider's settings (DP-106). A link belongs to its
// resource through Coolify's polymorphic resourceable_type / resourceable_id (one per resource: the unique index of
// 660). Every function takes the transaction of withOrg(): row-level security confines each query to that org, which is
// what Coolify's where('team_id', $resource->team()->id) does. The token column of the joined integration token holds an
// fp1 ciphertext; these functions never decrypt. Only the link's coordinates are stored, never a secret's value.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

/** IntegrationToken::SECRET_MANAGER_PROVIDERS */
export const SECRET_MANAGER_PROVIDERS = ["doppler", "infisical", "vault"] as const;

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** A secret manager token of the org, with its stored (encrypted) token. */
export interface DeploySecretManagerTokenRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  provider: string;
  /** The fp1 ciphertext of the token. */
  token: string;
  /** The JSON text of the capabilities column. */
  capabilities: string;
  /** The JSON text of the metadata column, or null. */
  metadata: string | null;
}

/** A resource's link, with its token. */
export interface DeploySecretManagerLinkRow extends SqlRow {
  id: string | number;
  uuid: string;
  integration_token_id: string | number;
  /** The JSON text of the settings column, or null. */
  settings: string | null;
  token_uuid: string;
  token_name: string;
  token_provider: string;
  token_secret: string;
  token_metadata: string | null;
}

/**
 * teamTokens()->get(): the org's tokens of a secret manager provider. Coolify's query has no ORDER BY (PostgreSQL gives
 * the rows in their stored order, the ids' for rows never updated); the ids' order here.
 */
export async function listSecretManagerTokens(tx: SqlExecutor): Promise<DeploySecretManagerTokenRow[]> {
  const r = await tx.execute<DeploySecretManagerTokenRow>(
    `SELECT id, uuid, name, provider, token, capabilities::text AS capabilities, metadata::text AS metadata
       FROM deploy.integration_tokens WHERE provider = ANY($1::text[]) ORDER BY id`,
    [[...SECRET_MANAGER_PROVIDERS]],
  );
  return r.rows;
}

/** $resource->secretManagerLink()->with('integrationToken')->first() */
export async function findSecretManagerLink(tx: SqlExecutor, resourceableType: string, resourceableId: string | number): Promise<DeploySecretManagerLinkRow | null> {
  const r = await tx.execute<DeploySecretManagerLinkRow>(
    `SELECT l.id, l.uuid, l.integration_token_id, l.settings::text AS settings,
            t.uuid AS token_uuid, t.name AS token_name, t.provider AS token_provider, t.token AS token_secret, t.metadata::text AS token_metadata
       FROM deploy.secret_manager_links l JOIN deploy.integration_tokens t ON t.id = l.integration_token_id
      WHERE l.resourceable_type = $1 AND l.resourceable_id = $2
      ORDER BY l.id LIMIT 1`,
    [resourceableType, resourceableId],
  );
  return r.rows[0] ?? null;
}

export interface SecretManagerLinkInput {
  orgId: string;
  /** BaseModel's creating hook: new_public_id(), used only when the link is created. */
  uuid: string;
  resourceableType: string;
  resourceableId: string | number;
  integrationTokenId: string | number;
  /** JSON text of the settings, or null. */
  settings: string | null;
}

/** The decoded JSON of a column, compared as Eloquent compares a json cast (the decoded values, keys in order). */
const sameJson = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)));

/**
 * $resource->secretManagerLink()->updateOrCreate([], [...]): the existing link's token and settings written when either
 * differs (updated_at untouched otherwise), or a new link.
 */
export async function saveSecretManagerLink(tx: SqlExecutor, link: SecretManagerLinkInput): Promise<{ created: boolean; changed: boolean }> {
  const existing = await tx.execute<{ id: string | number; integration_token_id: string | number; settings: string | null }>(
    "SELECT id, integration_token_id, settings::text AS settings FROM deploy.secret_manager_links WHERE resourceable_type = $1 AND resourceable_id = $2 ORDER BY id LIMIT 1",
    [link.resourceableType, link.resourceableId],
  );
  const row = existing.rows[0];
  if (row) {
    if (String(row.integration_token_id) === String(link.integrationTokenId) && sameJson(row.settings, link.settings)) return { created: false, changed: false };
    await tx.execute(`UPDATE deploy.secret_manager_links SET integration_token_id = $2, settings = $3::json, updated_at = ${NOW} WHERE id = $1`, [row.id, link.integrationTokenId, link.settings]);
    return { created: false, changed: true };
  }
  await tx.execute(
    `INSERT INTO deploy.secret_manager_links (uuid, resourceable_type, resourceable_id, integration_token_id, settings, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::json, $6, ${NOW}, ${NOW})`,
    [link.uuid, link.resourceableType, link.resourceableId, link.integrationTokenId, link.settings, link.orgId],
  );
  return { created: true, changed: true };
}

/** $resource->secretManagerLink()->delete() */
export async function deleteSecretManagerLink(tx: SqlExecutor, resourceableType: string, resourceableId: string | number): Promise<number> {
  const r = await tx.execute("DELETE FROM deploy.secret_manager_links WHERE resourceable_type = $1 AND resourceable_id = $2 RETURNING id", [resourceableType, resourceableId]);
  return r.rows.length;
}
