// Derived from coollabsio/coolify@91b7e3e:app/Services/ImageScan/ImageScanPolicyResolver.php (forScope, instanceRow),
// app/Livewire/ImageScan/{ScanSettings,ServerImageScanning}.php, app/Livewire/Server/Security/HostVulnerabilities.php,
// app/Models/{ImageScanPolicy,ImageScanIgnore,ServerHostScan}.php and
// database/migrations/2026_10_29_100000_create_image_scanning_tables.php (the seeded instance row) (Apache-2.0), modified.
//
// The rows of DP-116's image scanning settings, beside DP-114's (image-scan-pages.ts):
//
// - The instance-wide policy: Coolify's row with no scope. Freeploy stores it as the platform's rows are stored (DP-79,
//   DP-101: owned by the nil UUID, which no org has). Migration 740 lets every org read that one row, so the resolver
//   reads it inside the org's transaction (findInstanceImageScanPolicy()); it is written only in asPlatformAdmin()
//   (readInstanceImageScanPolicy(), saveInstanceImageScanPolicy()), created on the operator's first read with the values
//   Coolify's migration seeds.
// - A team's row: Freeploy's team is the org, so the team level is the org's row of scope App\Models\Team, whatever its
//   scope_id (DP-113); a new one takes scope_id 0.
// - The team-wide ignores (ScanSettings::ignores() of the team scope), the orgs that hold scans (refreshStatuses() of the
//   instance), and a server's host scan (server_host_scans).
//
// Every other function takes the transaction of withOrg(): row-level security confines it to that org.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { PLATFORM_SETTINGS_ORG_ID } from "./platform-settings.js";
import type { ImageScanPolicyRow } from "./image-scans.js";
import type { ImageScanIgnoreListRow } from "./image-scan-pages.js";

const NOW = "date_trunc('second', timezone('UTC', now()))";

/** The org_id of the instance-wide policy: no organization's (the platform's rows' owner). */
export const INSTANCE_IMAGE_SCAN_POLICY_ORG_ID = PLATFORM_SETTINGS_ORG_ID;

/** The morph class of Coolify's team scope. */
export const TEAM_POLICY_SCOPE = "App\\Models\\Team";

const POLICY_COLUMNS = "id::float8 AS id, scope_type, scope_id::float8 AS scope_id, gate_mode, on_scan_error, count_medium";

export type ImageScanPolicyColumn = "gate_mode" | "on_scan_error" | "count_medium";

/**
 * ImageScanPolicyResolver::instanceRow(): `whereNull('scope_type')->orderBy('id')->first()` — the platform's row, readable
 * in any org's transaction (740's policy). Null until the operator's page first read it.
 */
export async function findInstanceImageScanPolicy(tx: SqlExecutor): Promise<ImageScanPolicyRow | null> {
  const r = await tx.execute<ImageScanPolicyRow>(
    `SELECT ${POLICY_COLUMNS} FROM deploy.image_scan_policies WHERE org_id = $1 AND scope_type IS NULL AND scope_id IS NULL ORDER BY id LIMIT 1`,
    [INSTANCE_IMAGE_SCAN_POLICY_ORG_ID],
  );
  return r.rows[0] ?? null;
}

/**
 * ImageScanPolicyResolver::forScope(null) for the operator: the instance row, created when missing with the values
 * Coolify's migration seeds (gate off, deploy anyway, mediums not counted). In asPlatformAdmin()'s transaction.
 */
export async function readInstanceImageScanPolicy(tx: SqlExecutor, uuid: string): Promise<ImageScanPolicyRow> {
  const found = await findInstanceImageScanPolicy(tx);
  if (found) return found;
  await tx.execute(
    `INSERT INTO deploy.image_scan_policies (uuid, scope_type, scope_id, gate_mode, on_scan_error, count_medium, created_at, updated_at, org_id)
     VALUES ($1, NULL, NULL, 'off', 'deploy', false, ${NOW}, ${NOW}, $2)`,
    [uuid, INSTANCE_IMAGE_SCAN_POLICY_ORG_ID],
  );
  const row = await findInstanceImageScanPolicy(tx);
  if (!row) throw new Error("instance image scan policy is missing");
  return row;
}

/** $policy->{column} = …; $policy->save() of the instance row. In asPlatformAdmin()'s transaction. */
export async function saveInstanceImageScanPolicy(tx: SqlExecutor, uuid: string, column: ImageScanPolicyColumn, value: string | boolean): Promise<ImageScanPolicyRow> {
  const row = await readInstanceImageScanPolicy(tx, uuid);
  await tx.execute(`UPDATE deploy.image_scan_policies SET ${column} = $2, updated_at = ${NOW} WHERE id = $1`, [Number(row.id), value]);
  return (await findInstanceImageScanPolicy(tx))!;
}

/** The org's team-level row (scope App\Models\Team, whatever its scope_id), or null. */
export async function findTeamImageScanPolicy(tx: SqlExecutor): Promise<ImageScanPolicyRow | null> {
  const r = await tx.execute<ImageScanPolicyRow>(`SELECT ${POLICY_COLUMNS} FROM deploy.image_scan_policies WHERE scope_type = $1 ORDER BY id LIMIT 1`, [TEAM_POLICY_SCOPE]);
  return r.rows[0] ?? null;
}

/** ImageScanPolicyResolver::forScope($team)->{column} = …; ->save(): the org's team row, created (scope_id 0) when missing. */
export async function saveTeamImageScanPolicy(tx: SqlExecutor, orgId: string, uuid: string, column: ImageScanPolicyColumn, value: string | boolean | null): Promise<void> {
  const existing = await findTeamImageScanPolicy(tx);
  if (existing) {
    await tx.execute(`UPDATE deploy.image_scan_policies SET ${column} = $2, updated_at = ${NOW} WHERE id = $1`, [Number(existing.id), value]);
    return;
  }
  await tx.execute(`INSERT INTO deploy.image_scan_policies (uuid, scope_type, scope_id, ${column}, created_at, updated_at, org_id) VALUES ($1, $2, 0, $3, ${NOW}, ${NOW}, $4)`, [uuid, TEAM_POLICY_SCOPE, value, orgId]);
}

/** A server's or an application's row (forScope() reads it, firstOrNew), or null. */
export async function findScopedImageScanPolicy(tx: SqlExecutor, scopeType: string, scopeId: number): Promise<ImageScanPolicyRow | null> {
  const r = await tx.execute<ImageScanPolicyRow>(`SELECT ${POLICY_COLUMNS} FROM deploy.image_scan_policies WHERE scope_type = $1 AND scope_id = $2 ORDER BY id LIMIT 1`, [scopeType, scopeId]);
  return r.rows[0] ?? null;
}

/** ScanSettings::ignores() of the team scope: the team-wide ignores, newest first (->latest()). */
export async function listTeamImageScanIgnores(tx: SqlExecutor): Promise<ImageScanIgnoreListRow[]> {
  const r = await tx.execute<ImageScanIgnoreListRow>(
    `SELECT id::float8 AS id, uuid, resource_type, resource_id::float8 AS resource_id, vulnerability_id, package, reason,
            to_char(expires_at, 'YYYY-MM-DD HH24:MI:SS') AS expires_at, to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
       FROM deploy.image_scan_ignores
      WHERE resource_id IS NULL
      ORDER BY created_at DESC NULLS LAST, id DESC`,
  );
  return r.rows;
}

/**
 * refreshStatuses() of the instance: `Server::whereIn('id', ImageScan::select('server_id'))->distinct()->pluck('team_id')`
 * — the orgs whose servers hold scans. In asPlatformAdmin()'s transaction (it reads every org's rows).
 */
export async function listOrgsWithImageScans(tx: SqlExecutor): Promise<string[]> {
  const r = await tx.execute<{ org_id: string }>(
    `SELECT DISTINCT s.org_id::text AS org_id FROM deploy.servers s WHERE s.id IN (SELECT server_id FROM deploy.image_scans) ORDER BY 1`,
  );
  return r.rows.map((row) => row.org_id);
}

export interface ServerHostScanRow extends SqlRow {
  id: number;
  server_id: number;
  error_code: string | null;
  error_context: unknown;
  eol: unknown;
  summary: unknown;
  findings: unknown;
  findings_truncated: boolean;
  grype_db_built_at: string | null;
  scanned_at: string | null;
}

/** $server->hostScan()->first(): the last scan of the server's OS packages, or null. */
export async function findServerHostScan(tx: SqlExecutor, serverId: number): Promise<ServerHostScanRow | null> {
  const r = await tx.execute<ServerHostScanRow>(
    `SELECT id::float8 AS id, server_id::float8 AS server_id, error_code, error_context, eol, summary, findings, findings_truncated,
            to_char(grype_db_built_at, 'YYYY-MM-DD HH24:MI:SS') AS grype_db_built_at, to_char(scanned_at, 'YYYY-MM-DD HH24:MI:SS') AS scanned_at
       FROM deploy.server_host_scans WHERE server_id = $1 ORDER BY id LIMIT 1`,
    [serverId],
  );
  return r.rows[0] ?? null;
}
