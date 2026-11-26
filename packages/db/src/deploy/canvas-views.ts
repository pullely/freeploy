// Derived from coollabsio/coolify@91b7e3e:app/Services/{ProjectCanvas,ServerCanvas,SharedVariableCanvas,TagCanvas}.php
// and app/Http/Controllers/Api/{ProjectCanvas,ServerCanvas}Controller.php (updatePositions) (Apache-2.0), modified.
//
// What the projects, project, servers, server, dashboard, shared variable and tag canvases read beside the
// resources (DP-98): the org's environments with their saved card positions, its projects and servers with the
// place their zone was moved to (projects.canvas_position, servers.canvas_position), the visual-only links of
// every environment, the tags' pivot, the saved variables of some resources (their {{scope.KEY}} references),
// and the dashboard's deployments. Every function takes the transaction of withOrg(): row-level security
// confines each query to that org, which is what Coolify's where('team_id', …) does for the canvas API.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import type { Taggable } from "./tags.js";
import type { DeployResourceLinkRow } from "./canvas.js";

type Id = string | number;

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** A JSON column as the driver hands it back: the parsed value or its text. */
function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** One environment of the org with its project and the positions saved on its canvas. */
export interface DeployCanvasEnvironmentRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  project_id: string | number;
  project_uuid: string;
  project_name: string;
  /** environments.canvas_positions, parsed (null when nothing was saved). */
  canvas_positions: unknown;
}

/** Environment::query()->whereHas('project', team)->with('project'): every environment of the org, by id. */
export async function listCanvasEnvironments(tx: SqlExecutor): Promise<DeployCanvasEnvironmentRow[]> {
  const r = await tx.execute<DeployCanvasEnvironmentRow>(
    `SELECT e.id, e.uuid, e.name, e.project_id, p.uuid AS project_uuid, p.name AS project_name, e.canvas_positions
       FROM deploy.environments e JOIN deploy.projects p ON p.id = e.project_id
      ORDER BY e.id`,
  );
  return r.rows.map((row) => ({ ...row, canvas_positions: parseJson(row.canvas_positions) }));
}

/** A project with the place its zone was moved to on the projects canvas. */
export interface DeployCanvasProjectRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  /** projects.canvas_position, parsed (null: placed automatically). */
  canvas_position: unknown;
}

/** Project::query()->where('team_id', …)->orderBy('name') */
export async function listCanvasProjects(tx: SqlExecutor): Promise<DeployCanvasProjectRow[]> {
  const r = await tx.execute<DeployCanvasProjectRow>("SELECT id, uuid, name, canvas_position FROM deploy.projects ORDER BY name, id");
  return r.rows.map((row) => ({ ...row, canvas_position: parseJson(row.canvas_position) }));
}

/** A server with what its zone header shows and the place its zone was moved to. */
export interface DeployCanvasServerRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  ip: string | null;
  /** servers.proxy and servers.server_metadata, parsed. */
  proxy: unknown;
  server_metadata: unknown;
  canvas_position: unknown;
  is_reachable: boolean | null;
  is_usable: boolean | null;
  force_disabled: boolean | null;
  is_metrics_enabled: boolean | null;
}

/** Server::query()->whereTeamId(…)->with('settings')->orderBy('name') */
export async function listCanvasServers(tx: SqlExecutor): Promise<DeployCanvasServerRow[]> {
  const r = await tx.execute<DeployCanvasServerRow>(
    `SELECT s.id, s.uuid, s.name, s.ip, s.proxy, s.server_metadata, s.canvas_position,
            ss.is_reachable, ss.is_usable, ss.force_disabled, ss.is_metrics_enabled
       FROM deploy.servers s LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id
      WHERE s.deleted_at IS NULL
      ORDER BY s.name, s.id`,
  );
  return r.rows.map((row) => ({ ...row, proxy: parseJson(row.proxy), server_metadata: parseJson(row.server_metadata), canvas_position: parseJson(row.canvas_position) }));
}

/** $project->canvas_position = {x, y}; $project->save() (with updated_at). False when the project is not the org's. */
export async function saveProjectCanvasPosition(tx: SqlExecutor, id: Id, position: { x: number; y: number }): Promise<boolean> {
  const r = await tx.execute(`UPDATE deploy.projects SET canvas_position = $2::json, updated_at = ${NOW} WHERE id = $1 RETURNING id`, [id, JSON.stringify(position)]);
  return r.rows.length > 0;
}

/** $server->canvas_position = {x, y}; $server->save() (with updated_at). False when the server is not the org's. */
export async function saveServerCanvasPosition(tx: SqlExecutor, id: Id, position: { x: number; y: number }): Promise<boolean> {
  const r = await tx.execute(`UPDATE deploy.servers SET canvas_position = $2::json, updated_at = ${NOW} WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id, JSON.stringify(position)]);
  return r.rows.length > 0;
}

/** ResourceLink::query()->whereIn('environment_id', …)->orderBy('id'): every visual-only link of the org. */
export async function listOrgResourceLinks(tx: SqlExecutor): Promise<DeployResourceLinkRow[]> {
  const r = await tx.execute<DeployResourceLinkRow>("SELECT id, uuid, environment_id, source_type, source_id, target_type, target_id, label FROM deploy.resource_links ORDER BY id");
  return r.rows;
}

/** One row of the tags' pivot. */
export interface DeployTaggableRow extends SqlRow {
  tag_id: string | number;
  taggable_type: string;
  taggable_id: string | number;
}

/** load('tags') over every resource: the pivot rows of the org, in the order they were attached (as the morphToMany scans them). */
export async function listOrgTaggables(tx: SqlExecutor): Promise<DeployTaggableRow[]> {
  const r = await tx.execute<DeployTaggableRow>("SELECT tag_id, taggable_type, taggable_id FROM deploy.taggables ORDER BY ctid");
  return r.rows;
}

/** A saved variable of a resource, as the shared variables canvas reads it (the value is the stored ciphertext). */
export interface DeployCanvasVariableRow extends SqlRow {
  id: string | number;
  key: string;
  value: string | null;
  is_preview: boolean;
  resourceable_type: string;
  resourceable_id: string | number;
}

/**
 * EnvironmentVariable::query()->where(resourceable is one of the resources): the saved variables (without the
 * preview copies unless `withPreview`), by key.
 */
export async function listCanvasEnvironmentVariables(tx: SqlExecutor, resources: readonly Taggable[], withPreview = false): Promise<DeployCanvasVariableRow[]> {
  if (!resources.length) return [];
  const r = await tx.execute<DeployCanvasVariableRow>(
    `SELECT v.id, v."key", v."value", v.is_preview, v.resourceable_type, v.resourceable_id
       FROM deploy.environment_variables v
       JOIN unnest($1::text[], $2::bigint[]) AS r(type, id) ON r.type = v.resourceable_type AND r.id = v.resourceable_id
      WHERE $3::boolean OR v.is_preview = false
      ORDER BY v."key", v.id`,
    [resources.map((x) => x.type), resources.map((x) => String(x.id)), withPreview],
  );
  return r.rows;
}

/** A deployment of the dashboard canvas (ServerCanvas::dashboardPayload()'s columns, and its application's uuid). */
export interface DeployCanvasDeploymentRow extends SqlRow {
  deployment_uuid: string;
  application_id: string | null;
  application_uuid: string | null;
  application_name: string | null;
  status: string;
  deployment_url: string | null;
  pull_request_id: number;
  server_name: string | null;
  /** ISO 8601 in UTC (toIso8601String()), or null. */
  created_at: string | null;
  finished_at: string | null;
}

/**
 * ApplicationDeploymentQueue::whereIn('server_id', …): `active` the in-progress and queued ones by status then id
 * (the oldest first, as the queue runs them), otherwise the 8 latest others.
 */
export async function listCanvasDeployments(tx: SqlExecutor, serverIds: readonly Id[], active: boolean): Promise<DeployCanvasDeploymentRow[]> {
  if (!serverIds.length) return [];
  const iso = (column: string) => `CASE WHEN q.${column} IS NULL THEN NULL ELSE to_char(q.${column}, 'YYYY-MM-DD"T"HH24:MI:SS"+00:00"') END`;
  const r = await tx.execute<DeployCanvasDeploymentRow>(
    `SELECT q.deployment_uuid, q.application_id, a.uuid AS application_uuid, q.application_name, q.status, q.deployment_url, q.pull_request_id,
            q.server_name, ${iso("created_at")} AS created_at, ${iso("finished_at")} AS finished_at
       FROM deploy.application_deployment_queues q
       LEFT JOIN deploy.applications a ON a.id::text = q.application_id AND a.deleted_at IS NULL
      WHERE q.server_id::text = ANY($1::text[])
        AND ${active ? "q.status IN ('in_progress', 'queued')" : "q.status NOT IN ('in_progress', 'queued')"}
      ORDER BY ${active ? "q.status, q.id" : "q.id DESC LIMIT 8"}`,
    [serverIds.map(String)],
  );
  return r.rows;
}
