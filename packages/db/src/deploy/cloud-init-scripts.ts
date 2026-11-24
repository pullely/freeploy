// Derived from coollabsio/coolify@91b7e3e:app/Models/CloudInitScript.php,
// app/Livewire/Security/{CloudInitScripts,CloudInitScriptForm}.php and
// app/Livewire/Security/CloudInitScript/Show.php (Apache-2.0), modified.
//
// deploy.cloud_init_scripts queries. Every function takes the transaction of
// withOrg(): row-level security confines each query to that org, which is what
// Coolify's ownedByCurrentTeam() does. The script column holds an fp1
// ciphertext (crypto.ts); these functions never decrypt.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

export interface DeployCloudInitScriptRow extends SqlRow {
  id: string | number;
  uuid: string | null;
  name: string;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

/** A row with its stored (encrypted) script. */
export interface DeployCloudInitScriptWithSecretRow extends DeployCloudInitScriptRow {
  script: string;
}

const COLUMNS = "id, uuid, name, created_at, updated_at";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** CloudInitScripts::loadScripts(): ownedByCurrentTeam()->orderBy('created_at', 'desc'); the newer id first within a second. */
export async function listCloudInitScripts(tx: SqlExecutor): Promise<DeployCloudInitScriptRow[]> {
  const r = await tx.execute<DeployCloudInitScriptRow>(`SELECT ${COLUMNS} FROM deploy.cloud_init_scripts ORDER BY created_at DESC NULLS LAST, id DESC`);
  return r.rows;
}

/** ownedByCurrentTeam()->whereUuid($uuid)->first(), with the encrypted script. */
export async function findCloudInitScriptByUuid(tx: SqlExecutor, uuid: string): Promise<DeployCloudInitScriptWithSecretRow | null> {
  const r = await tx.execute<DeployCloudInitScriptWithSecretRow>(`SELECT ${COLUMNS}, script FROM deploy.cloud_init_scripts WHERE uuid = $1`, [uuid]);
  return r.rows[0] ?? null;
}

export interface NewCloudInitScript {
  orgId: string;
  uuid: string;
  name: string;
  /** The fp1 ciphertext of the script. */
  script: string;
}

export async function insertCloudInitScript(tx: SqlExecutor, script: NewCloudInitScript): Promise<DeployCloudInitScriptRow> {
  const r = await tx.execute<DeployCloudInitScriptRow>(
    `INSERT INTO deploy.cloud_init_scripts (uuid, name, script, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, ${NOW}, ${NOW}) RETURNING ${COLUMNS}`,
    [script.uuid, script.name, script.script, script.orgId],
  );
  return r.rows[0]!;
}

export interface CloudInitScriptChanges {
  name: string;
  /** The fp1 ciphertext of the script. */
  script: string;
}

export async function updateCloudInitScript(tx: SqlExecutor, id: string | number, changes: CloudInitScriptChanges): Promise<DeployCloudInitScriptRow | null> {
  const r = await tx.execute<DeployCloudInitScriptRow>(
    `UPDATE deploy.cloud_init_scripts SET name = $2, script = $3, updated_at = ${NOW} WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, changes.name, changes.script],
  );
  return r.rows[0] ?? null;
}

export async function deleteCloudInitScript(tx: SqlExecutor, id: string | number): Promise<boolean> {
  const r = await tx.execute("DELETE FROM deploy.cloud_init_scripts WHERE id = $1 RETURNING id", [id]);
  return r.rows.length > 0;
}
