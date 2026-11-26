// Derived from coollabsio/coolify@91b7e3e:app/Services/ServerTransfer/ServerTransferClaimer.php (markTransferred,
// releaseGithubRunners, dnsResources), app/Services/Dns/ManagedDnsRecordCleanup.php (parkResources, resourceKeys,
// whereResourceKeys, deleteReferences), app/Services/ServerTransfer/ServerTransferImporter.php (replaceableArchive,
// importChecks) and app/Models/Server.php (primaryApplications, forceDisableServer) (Apache-2.0), modified.
//
// The rows a server's transfer reads and writes (DP-111): a server found with the deleted ones (the import's checks), and
// what marking a server transferred changes — its settings, its metadata, its GitHub runners and the managed DNS records
// of the server and of what runs on it, which this instance stops owning. Every function takes the transaction of
// withOrg(): row-level security confines each query to that org, where Coolify looks across every team.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

const NOW = "date_trunc('second', timezone('UTC', now()))";

const MORPH = {
  server: "App\\Models\\Server",
  application: "App\\Models\\Application",
  preview: "App\\Models\\ApplicationPreview",
  serviceApplication: "App\\Models\\ServiceApplication",
  standaloneDocker: "App\\Models\\StandaloneDocker",
  swarmDocker: "App\\Models\\SwarmDocker",
} as const;

export interface DeployTransferServerRow extends SqlRow {
  id: string | number;
  uuid: string;
  deleted_at: string | null;
  server_metadata: unknown;
}

const parseJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

/** Server::withTrashed()->where('uuid', $uuid)->first() (or without the deleted ones), its metadata parsed. */
export async function findTransferServer(tx: SqlExecutor, uuid: string, withTrashed: boolean): Promise<DeployTransferServerRow | null> {
  const r = await tx.execute<DeployTransferServerRow>(
    `SELECT id, uuid, deleted_at::text AS deleted_at, server_metadata FROM deploy.servers WHERE uuid = $1${withTrashed ? "" : " AND deleted_at IS NULL"} ORDER BY id LIMIT 1`,
    [uuid],
  );
  const row = r.rows[0];
  return row ? { ...row, server_metadata: parseJson(row.server_metadata) } : null;
}

/** The server row locked for the transfer (lockForUpdate()->findOrFail()). */
export async function lockTransferServer(tx: SqlExecutor, serverId: string | number): Promise<DeployTransferServerRow | null> {
  const r = await tx.execute<DeployTransferServerRow>(`SELECT id, uuid, deleted_at::text AS deleted_at, server_metadata FROM deploy.servers WHERE id = $1 FOR UPDATE`, [serverId]);
  const row = r.rows[0];
  return row ? { ...row, server_metadata: parseJson(row.server_metadata) } : null;
}

/** markTransferred() and forceDisableServer(): the server's settings stop its automations here. */
export async function disableTransferredServerSettings(tx: SqlExecutor, serverId: string | number): Promise<void> {
  await tx.execute(`UPDATE deploy.server_settings SET force_disabled = true, is_sentinel_enabled = false, updated_at = ${NOW} WHERE server_id = $1`, [serverId]);
}

/** $server->server_metadata = $metadata; $server->save(). */
export async function saveServerMetadata(tx: SqlExecutor, serverId: string | number, metadata: unknown): Promise<void> {
  await tx.execute(`UPDATE deploy.servers SET server_metadata = $2::json, updated_at = ${NOW} WHERE id = $1`, [serverId, JSON.stringify(metadata)]);
}

/** GithubRunnerStatus::active() */
const ACTIVE_RUNNER_STATUSES = ["queued", "provisioning", "idle", "running"];

/**
 * releaseGithubRunners(): the server's runner config disabled, and its active runners finished as cancelled with the
 * message (GithubRunnerExecution::finish(): a completion time already set is kept).
 */
export async function releaseServerGithubRunners(tx: SqlExecutor, serverId: string | number, message: string): Promise<void> {
  await tx.execute(`UPDATE deploy.github_runner_configs SET is_enabled = false, updated_at = ${NOW} WHERE server_id = $1`, [serverId]);
  await tx.execute(
    `UPDATE deploy.github_runner_executions SET status = 'cancelled', error_message = $2, completed_at = COALESCE(completed_at, ${NOW}), updated_at = ${NOW}
      WHERE server_id = $1 AND status = ANY($3::text[])`,
    [serverId, message, ACTIVE_RUNNER_STATUSES],
  );
}

/**
 * dnsResources() through resourceKeys(): the server, its primary applications (on a standalone or swarm destination of
 * the server) with their previews (the deleted ones too), and the applications of its services.
 */
async function transferResourceKeys(tx: SqlExecutor, serverId: string | number): Promise<Array<[string, string]>> {
  const keys: Array<[string, string]> = [[MORPH.server, String(serverId)]];
  const apps = await tx.execute<{ id: string | number }>(
    `SELECT a.id FROM deploy.applications a
      WHERE a.deleted_at IS NULL AND (
        (a.destination_type = $2 AND a.destination_id IN (SELECT d.id FROM deploy.standalone_dockers d WHERE d.server_id = $1))
        OR (a.destination_type = $3 AND a.destination_id IN (SELECT d.id FROM deploy.swarm_dockers d WHERE d.server_id = $1)))
      ORDER BY a.id`,
    [serverId, MORPH.standaloneDocker, MORPH.swarmDocker],
  );
  const serviceApps = await tx.execute<{ id: string | number }>(
    `SELECT sa.id FROM deploy.service_applications sa JOIN deploy.services s ON s.id = sa.service_id
      WHERE s.server_id = $1 AND s.deleted_at IS NULL AND sa.deleted_at IS NULL ORDER BY s.id, sa.id`,
    [serverId],
  );
  for (const app of apps.rows) {
    keys.push([MORPH.application, String(app.id)]);
    const previews = await tx.execute<{ id: string | number }>(`SELECT id FROM deploy.application_previews WHERE application_id = $1 ORDER BY id`, [app.id]);
    for (const p of previews.rows) keys.push([MORPH.preview, String(p.id)]);
  }
  for (const sa of serviceApps.rows) keys.push([MORPH.serviceApplication, String(sa.id)]);
  return keys;
}

/**
 * parkResources(): a record that only these resources reference is no longer owned (the provider keeps it, for a take
 * back) and its id is returned; a record that other resources reference too loses only these resources' references.
 */
export async function parkServerDnsRecords(tx: SqlExecutor, serverId: string | number): Promise<number[]> {
  const keys = await transferResourceKeys(tx, serverId);
  const types = keys.map(([t]) => t);
  const ids = keys.map(([, id]) => id);
  const matches = `(f.resource_type, f.resource_id::text) IN (SELECT * FROM unnest($1::text[], $2::text[]))`;
  const records = await tx.execute<{ id: string | number; owned: boolean }>(
    `SELECT r.id, r.owned FROM deploy.managed_dns_records r
      WHERE EXISTS (SELECT 1 FROM deploy.managed_dns_record_references f WHERE f.managed_dns_record_id = r.id AND ${matches})
      ORDER BY r.id`,
    [types, ids],
  );
  const parked: number[] = [];
  for (const record of records.rows) {
    const shared = await tx.execute(`SELECT 1 FROM deploy.managed_dns_record_references f WHERE f.managed_dns_record_id = $3 AND NOT ${matches} LIMIT 1`, [types, ids, record.id]);
    if (shared.rows.length) {
      await tx.execute(`DELETE FROM deploy.managed_dns_record_references f WHERE f.managed_dns_record_id = $3 AND ${matches}`, [types, ids, record.id]);
      continue;
    }
    if (record.owned) {
      await tx.execute(`UPDATE deploy.managed_dns_records SET owned = false, updated_at = ${NOW} WHERE id = $1`, [record.id]);
      parked.push(Number(record.id));
    }
  }
  return parked;
}
