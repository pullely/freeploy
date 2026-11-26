// Derived from coollabsio/coolify@91b7e3e:app/Services/EnvironmentCanvas.php (resourceIndex, the links
// payload() reads), app/Http/Controllers/Api/EnvironmentCanvasController.php (updatePositions' locked
// save, storeLink, updateLink, destroyLink), app/Models/ResourceLink.php and
// database/migrations/2026_10_12_19244{4,5}_*.php (Apache-2.0), modified.
//
// The environment canvas's stored layout (DP-92): the card positions in
// deploy.environments.canvas_positions (JSON, uuid → {x, y}) and the
// visual-only links between two resources of one environment in
// deploy.resource_links (Coolify's 11 columns; the source and target are
// morph pairs, unique per direction). Every function takes the transaction of
// withOrg(): row-level security confines each query to that org, which is
// what Coolify's Project::whereTeamId() does for the canvas API.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { APPLICATION_MORPH_CLASS } from "./application-create.js";
import { DATABASE_ENGINES, DATABASE_TABLES } from "./databases.js";
import { SERVICE_MORPH_CLASS } from "./services.js";

type Id = string | number;

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/**
 * The tables EnvironmentCanvas::resourceIndex() reads, in its order: applications, services, then
 * DATABASE_RELATIONS' standalone databases (SQLite's since DP-112).
 */
export const CANVAS_RESOURCE_TABLES: ReadonlyArray<{ table: string; type: string }> = [
  { table: "applications", type: APPLICATION_MORPH_CLASS },
  { table: "services", type: SERVICE_MORPH_CLASS },
  ...DATABASE_ENGINES.map((engine) => ({ table: DATABASE_TABLES[engine].table, type: DATABASE_TABLES[engine].morphClass })),
];

/** One top-level resource of an environment: its uuid, morph type and id. */
export interface CanvasResourceRow extends SqlRow {
  uuid: string;
  type: string;
  id: string | number;
}

/** EnvironmentCanvas::resourceIndex(): every application, service and standalone database of the environment (ids only, soft-deleted ones left out). */
export async function listEnvironmentCanvasResources(tx: SqlExecutor, environmentId: Id): Promise<CanvasResourceRow[]> {
  const parts = CANVAS_RESOURCE_TABLES.map(
    ({ table }, i) => `SELECT uuid, $${i + 2}::text AS type, id, ${i} AS part FROM deploy.${table} WHERE environment_id = $1 AND deleted_at IS NULL`,
  );
  const r = await tx.execute<CanvasResourceRow & { part: number }>(
    `SELECT uuid, type, id FROM (${parts.join(" UNION ALL ")}) u ORDER BY part, id`,
    [environmentId, ...CANVAS_RESOURCE_TABLES.map((t) => t.type)],
  );
  return r.rows.map(({ uuid, type, id }) => ({ uuid, type, id }));
}

/** $environment->canvas_positions: the stored JSON as it is (null when nothing was saved). */
export async function findEnvironmentCanvasPositions(tx: SqlExecutor, environmentId: Id): Promise<unknown> {
  const r = await tx.execute<{ canvas_positions: unknown }>("SELECT canvas_positions FROM deploy.environments WHERE id = $1", [environmentId]);
  return parseJson(r.rows[0]?.canvas_positions ?? null);
}

/** Environment::query()->lockForUpdate()->findOrFail($id)->canvas_positions: the row stays locked until the transaction ends. */
export async function lockEnvironmentCanvasPositions(tx: SqlExecutor, environmentId: Id): Promise<{ found: boolean; positions: unknown }> {
  const r = await tx.execute<{ canvas_positions: unknown }>("SELECT canvas_positions FROM deploy.environments WHERE id = $1 FOR UPDATE", [environmentId]);
  if (!r.rows.length) return { found: false, positions: null };
  return { found: true, positions: parseJson(r.rows[0]!.canvas_positions ?? null) };
}

/** $locked->canvas_positions = $merged; $locked->save(): the column and updated_at. */
export async function saveEnvironmentCanvasPositions(tx: SqlExecutor, environmentId: Id, positions: Record<string, { x: number; y: number }>): Promise<void> {
  await tx.execute(`UPDATE deploy.environments SET canvas_positions = $2::json, updated_at = ${NOW} WHERE id = $1`, [environmentId, JSON.stringify(positions)]);
}

export interface DeployResourceLinkRow extends SqlRow {
  id: string | number;
  uuid: string;
  environment_id: string | number;
  source_type: string;
  source_id: string | number;
  target_type: string;
  target_id: string | number;
  label: string | null;
}

const LINK_COLUMNS = "id, uuid, environment_id, source_type, source_id, target_type, target_id, label";

/** $environment->resourceLinks()->orderBy('id')->get() */
export async function listEnvironmentResourceLinks(tx: SqlExecutor, environmentId: Id): Promise<DeployResourceLinkRow[]> {
  const r = await tx.execute<DeployResourceLinkRow>(`SELECT ${LINK_COLUMNS} FROM deploy.resource_links WHERE environment_id = $1 ORDER BY id`, [environmentId]);
  return r.rows;
}

/** $environment->resourceLinks()->whereUuid($uuid)->first() */
export async function findEnvironmentResourceLink(tx: SqlExecutor, environmentId: Id, uuid: string): Promise<DeployResourceLinkRow | null> {
  const r = await tx.execute<DeployResourceLinkRow>(`SELECT ${LINK_COLUMNS} FROM deploy.resource_links WHERE environment_id = $1 AND uuid = $2`, [environmentId, uuid]);
  return r.rows[0] ?? null;
}

export interface ResourceLinkEnds {
  environmentId: Id;
  sourceType: string;
  sourceId: Id;
  targetType: string;
  targetId: Id;
}

/** ResourceLink::query()->where($attributes)->exists(): this direction is linked already. */
export async function resourceLinkExists(tx: SqlExecutor, ends: ResourceLinkEnds): Promise<boolean> {
  const r = await tx.execute(
    "SELECT 1 FROM deploy.resource_links WHERE environment_id = $1 AND source_type = $2 AND source_id = $3 AND target_type = $4 AND target_id = $5 LIMIT 1",
    [ends.environmentId, ends.sourceType, ends.sourceId, ends.targetType, ends.targetId],
  );
  return r.rows.length > 0;
}

export interface NewResourceLink extends ResourceLinkEnds {
  orgId: string;
  uuid: string;
  label: string | null;
}

/**
 * ResourceLink::create(): the link, or null when resource_links_unique_direction refuses it (Coolify's
 * UniqueConstraintViolationException: two requests at once both found the direction free). ON CONFLICT
 * keeps the transaction usable, which a raised unique violation would abort. created_by stays null:
 * Freeploy's users are identity's, not rows of the deploy schema.
 */
export async function insertResourceLink(tx: SqlExecutor, link: NewResourceLink): Promise<DeployResourceLinkRow | null> {
  const r = await tx.execute<DeployResourceLinkRow>(
    `INSERT INTO deploy.resource_links (uuid, environment_id, source_type, source_id, target_type, target_id, label, created_by, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, ${NOW}, ${NOW})
     ON CONFLICT (environment_id, source_type, source_id, target_type, target_id) DO NOTHING
     RETURNING ${LINK_COLUMNS}`,
    [link.uuid, link.environmentId, link.sourceType, link.sourceId, link.targetType, link.targetId, link.label, link.orgId],
  );
  return r.rows[0] ?? null;
}

/** $link->update(['label' => …]) */
export async function updateResourceLinkLabel(tx: SqlExecutor, id: Id, label: string | null): Promise<DeployResourceLinkRow | null> {
  const r = await tx.execute<DeployResourceLinkRow>(`UPDATE deploy.resource_links SET label = $2, updated_at = ${NOW} WHERE id = $1 RETURNING ${LINK_COLUMNS}`, [id, label]);
  return r.rows[0] ?? null;
}

/** $link->delete() */
export async function deleteResourceLink(tx: SqlExecutor, id: Id): Promise<boolean> {
  const r = await tx.execute("DELETE FROM deploy.resource_links WHERE id = $1 RETURNING id", [id]);
  return r.rows.length > 0;
}

/** A json column as node-postgres or a driver that returns text gives it. */
function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
