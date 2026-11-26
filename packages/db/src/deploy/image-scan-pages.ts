// Derived from coollabsio/coolify@91b7e3e:app/Livewire/ImageScan/{Vulnerabilities,Packages,ScanSettings,FleetVulnerabilities}.php,
// app/Http/Controllers/ImageScanSbomController.php, app/Services/ImageScan/{ImageScanPolicyResolver,TeamVulnerabilities}.php
// and app/Models/{ImageScanIgnore,ImageScanPolicy,ImageSbom}.php (Apache-2.0), modified.
//
// The rows of the console's Security pages (DP-114), beside what the security status engine reads (image-scans.ts): an
// ignore added or removed, the stored package lists (image_sboms) of the current scans, an application's image overrides
// and its scan settings, a policy row of an application written, the environments and projects the team page names, and
// the servers that do not scan images. Every function takes the transaction of withOrg(): row-level security confines
// each query to that org, which is what Coolify's team checks do. Nothing here starts a scan.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

const NOW = "date_trunc('second', timezone('UTC', now()))";

export interface ImageScanIgnoreInsert {
  uuid: string;
  resourceType: string | null;
  resourceId: number | null;
  vulnerabilityId: string | null;
  package: string | null;
  reason: string;
  /** 'YYYY-MM-DD HH:MM:SS' (UTC), or null for never. */
  expiresAt: string | null;
}

/** ImageScanIgnore::query()->create([...]) (created_by: Freeploy's users are not deploy rows, so none). */
export async function insertImageScanIgnore(tx: SqlExecutor, orgId: string, row: ImageScanIgnoreInsert): Promise<void> {
  await tx.execute(
    `INSERT INTO deploy.image_scan_ignores (uuid, resource_type, resource_id, vulnerability_id, package, reason, expires_at, created_by, created_at, updated_at, org_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, ${NOW}, ${NOW}, $8)`,
    [row.uuid, row.resourceType, row.resourceId, row.vulnerabilityId, row.package, row.reason, row.expiresAt, orgId],
  );
}

export interface ImageScanIgnoreListRow extends SqlRow {
  id: number;
  uuid: string;
  resource_type: string | null;
  resource_id: number | null;
  vulnerability_id: string | null;
  package: string | null;
  reason: string;
  expires_at: string | null;
  created_at: string | null;
}

/** The org's ignores, newest first (->latest()): the team-wide ones and those of these owners ({morph class: ids}). */
export async function listImageScanIgnoresFor(tx: SqlExecutor, owners: Record<string, number[]>): Promise<ImageScanIgnoreListRow[]> {
  const params: unknown[] = [];
  const parts = Object.entries(owners)
    .filter(([, ids]) => ids.length > 0)
    .map(([type, ids]) => {
      params.push(type, ids);
      return `(resource_type = $${params.length - 1} AND resource_id = ANY($${params.length}::bigint[]))`;
    });
  const r = await tx.execute<ImageScanIgnoreListRow>(
    `SELECT id::float8 AS id, uuid, resource_type, resource_id::float8 AS resource_id, vulnerability_id, package, reason,
            to_char(expires_at, 'YYYY-MM-DD HH24:MI:SS') AS expires_at, to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
       FROM deploy.image_scan_ignores
      WHERE resource_id IS NULL${parts.length > 0 ? ` OR ${parts.join(" OR ")}` : ""}
      ORDER BY (resource_id IS NULL), created_at DESC NULLS LAST, id DESC`,
    params,
  );
  return r.rows.map((x) => ({ ...x, id: Number(x.id), resource_id: x.resource_id === null ? null : Number(x.resource_id) }));
}

/** $ignore->delete(). */
export async function deleteImageScanIgnore(tx: SqlExecutor, id: number): Promise<void> {
  await tx.execute(`DELETE FROM deploy.image_scan_ignores WHERE id = $1`, [id]);
}

export interface ImageSbomRow extends SqlRow {
  id: number;
  server_id: number;
  packages: string;
  packages_truncated: boolean;
}

/** ImageSbom::query()->whereIn('id', …): the stored package lists. */
export async function listImageSboms(tx: SqlExecutor, ids: number[]): Promise<ImageSbomRow[]> {
  if (ids.length === 0) return [];
  const r = await tx.execute<ImageSbomRow>(`SELECT id::float8 AS id, server_id::float8 AS server_id, packages::text AS packages, packages_truncated FROM deploy.image_sboms WHERE id = ANY($1::bigint[]) ORDER BY id`, [ids]);
  return r.rows.map((x) => ({ ...x, id: Number(x.id), server_id: Number(x.server_id) }));
}

/** The image_sbom_id of these scans, by scan id. */
export async function listImageScanSbomIds(tx: SqlExecutor, scanIds: number[]): Promise<Map<number, number | null>> {
  if (scanIds.length === 0) return new Map();
  const r = await tx.execute<{ id: number; image_sbom_id: number | null }>(`SELECT id::float8 AS id, image_sbom_id::float8 AS image_sbom_id FROM deploy.image_scans WHERE id = ANY($1::bigint[])`, [scanIds]);
  return new Map(r.rows.map((x) => [Number(x.id), x.image_sbom_id === null ? null : Number(x.image_sbom_id)]));
}

/** $resource->docker_compose_image_overrides = …; $resource->save(). */
export async function updateApplicationImageOverrides(tx: SqlExecutor, applicationId: number, overridesJson: string | null): Promise<void> {
  await tx.execute(`UPDATE deploy.applications SET docker_compose_image_overrides = $2::json, updated_at = ${NOW} WHERE id = $1`, [applicationId, overridesJson]);
}

export interface ApplicationScanSettingsRow extends SqlRow {
  is_image_scan_enabled: boolean | null;
  image_builds_by_team: boolean | null;
}

/** $application->settings: the scan settings (null when the application has no settings row). */
export async function findApplicationScanSettings(tx: SqlExecutor, applicationId: number): Promise<ApplicationScanSettingsRow | null> {
  const r = await tx.execute<ApplicationScanSettingsRow>(`SELECT is_image_scan_enabled, image_builds_by_team FROM deploy.application_settings WHERE application_id = $1 ORDER BY id LIMIT 1`, [applicationId]);
  return r.rows[0] ?? null;
}

/** $application->settings->{is_image_scan_enabled | image_builds_by_team} = …; ->save(). */
export async function updateApplicationScanSetting(tx: SqlExecutor, applicationId: number, column: "is_image_scan_enabled" | "image_builds_by_team", value: boolean | null): Promise<void> {
  await tx.execute(`UPDATE deploy.application_settings SET ${column} = $2, updated_at = ${NOW} WHERE id = (SELECT id FROM deploy.application_settings WHERE application_id = $1 ORDER BY id LIMIT 1)`, [applicationId, value]);
}

/** ImageScanPolicyResolver::forScope($scope)->{column} = …; ->save(): firstOrNew by scope, then saved. */
export async function saveImageScanPolicy(tx: SqlExecutor, orgId: string, uuid: string, scopeType: string, scopeId: number, column: "gate_mode" | "on_scan_error" | "count_medium", value: string | boolean | null): Promise<void> {
  const existing = await tx.execute<{ id: number }>(`SELECT id::float8 AS id FROM deploy.image_scan_policies WHERE scope_type = $1 AND scope_id = $2 ORDER BY id LIMIT 1`, [scopeType, scopeId]);
  if (existing.rows[0]) {
    await tx.execute(`UPDATE deploy.image_scan_policies SET ${column} = $2, updated_at = ${NOW} WHERE id = $1`, [Number(existing.rows[0].id), value]);
    return;
  }
  await tx.execute(`INSERT INTO deploy.image_scan_policies (uuid, scope_type, scope_id, ${column}, created_at, updated_at, org_id) VALUES ($1, $2, $3, $4, ${NOW}, ${NOW}, $5)`, [uuid, scopeType, scopeId, value, orgId]);
}

export interface ImageScanEnvironmentRow extends SqlRow {
  uuid: string;
  name: string;
  project_uuid: string;
  project_name: string;
}

/** The org's environments with their projects: $resource->environment and ->project of the team page. */
export async function listImageScanEnvironments(tx: SqlExecutor): Promise<ImageScanEnvironmentRow[]> {
  const r = await tx.execute<ImageScanEnvironmentRow>(`SELECT en.uuid, en.name, pr.uuid AS project_uuid, pr.name AS project_name FROM deploy.environments en JOIN deploy.projects pr ON pr.id = en.project_id ORDER BY en.id`);
  return r.rows;
}

/** TeamVulnerabilities::serversNotScanning(): the org's servers not transferred away whose settings do not scan images. */
export async function countServersNotScanning(tx: SqlExecutor): Promise<number> {
  const r = await tx.execute<{ n: number }>(
    `SELECT count(*)::float8 AS n FROM deploy.servers s
      WHERE s.deleted_at IS NULL
        AND COALESCE(s.server_metadata::jsonb #>> '{transfer,status}', '') <> 'transferred'
        AND COALESCE((SELECT ss.is_image_scan_enabled FROM deploy.server_settings ss WHERE ss.server_id = s.id ORDER BY ss.id LIMIT 1), false) IS NOT TRUE`,
  );
  return Number(r.rows[0]?.n ?? 0);
}
