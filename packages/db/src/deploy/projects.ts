// Derived from coollabsio/coolify@91b7e3e:app/Models/{Project,ProjectSetting}.php (the created
// and deleting hooks, isEmpty), app/Livewire/Project/Index.php (the projects query) and
// app/Http/Controllers/Api/ProjectController.php (projects) (Apache-2.0), modified.
//
// deploy.projects and deploy.project_settings queries. Every function takes
// the transaction of withOrg(): row-level security confines each query to that
// org, which is what Coolify's ownedByCurrentTeam() / whereTeamId() does.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { hasResourcesSql, resourceCountSql, type DeployEnvironmentRow } from "./environments.js";

export interface DeployProjectRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  description: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

export interface DeployProjectListRow extends DeployProjectRow {
  /** $project->environments->count() */
  environment_count: number;
  /** $project->environments->first()->uuid (the oldest), or null. */
  first_environment_uuid: string | null;
  /** withCount() of the eleven hasManyThrough resource relations, summed. */
  resource_count: number;
}

const COLUMNS = "id, uuid, name, description, created_at, updated_at";
const P_COLUMNS = COLUMNS.split(", ")
  .map((c) => `p.${c}`)
  .join(", ");

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** The resources of project `p`: those of its environments (`r` is the resource alias). */
const IN_PROJECT = "r.environment_id IN (SELECT e.id FROM deploy.environments e WHERE e.project_id = p.id)";

/** Coolify's ProjectController@projects: the team's projects (here, the org's). */
export async function listProjects(tx: SqlExecutor): Promise<DeployProjectRow[]> {
  const r = await tx.execute<DeployProjectRow>(`SELECT ${COLUMNS} FROM deploy.projects ORDER BY id`);
  return r.rows;
}

/** Index::mount(): ownedByCurrentTeam() (orderByRaw('LOWER(name)')) with the environments and the resource counts. */
export async function listProjectsWithCounts(tx: SqlExecutor): Promise<DeployProjectListRow[]> {
  const r = await tx.execute<DeployProjectListRow>(
    `SELECT ${P_COLUMNS},
            (SELECT count(*) FROM deploy.environments e WHERE e.project_id = p.id)::int AS environment_count,
            (SELECT e.uuid FROM deploy.environments e WHERE e.project_id = p.id ORDER BY e.id LIMIT 1) AS first_environment_uuid,
            (${resourceCountSql(IN_PROJECT)})::int AS resource_count
       FROM deploy.projects p ORDER BY LOWER(p.name), p.id`,
  );
  return r.rows;
}

/** Project::where('team_id', …)->where('uuid', $uuid)->first(). */
export async function findProjectByUuid(tx: SqlExecutor, uuid: string): Promise<DeployProjectRow | null> {
  const r = await tx.execute<DeployProjectRow>(`SELECT ${COLUMNS} FROM deploy.projects WHERE uuid = $1`, [uuid]);
  return r.rows[0] ?? null;
}

export interface NewProject {
  orgId: string;
  uuid: string;
  name: string;
  description: string | null;
  /** The uuid of the "production" environment the created hook adds. */
  productionEnvironmentUuid: string;
}

/**
 * Project::create() with its created hook: the project, its settings row
 * (ProjectSetting::create(['project_id' => …])) and an environment named
 * "production". Every row carries the org.
 */
export async function insertProject(tx: SqlExecutor, project: NewProject): Promise<{ project: DeployProjectRow; environment: DeployEnvironmentRow }> {
  const p = await tx.execute<DeployProjectRow>(
    `INSERT INTO deploy.projects (uuid, name, description, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, ${NOW}, ${NOW}) RETURNING ${COLUMNS}`,
    [project.uuid, project.name, project.description, project.orgId],
  );
  const row = p.rows[0]!;
  await tx.execute(`INSERT INTO deploy.project_settings (project_id, org_id, created_at, updated_at) VALUES ($1, $2, ${NOW}, ${NOW})`, [row.id, project.orgId]);
  const e = await tx.execute<DeployEnvironmentRow>(
    `INSERT INTO deploy.environments (uuid, name, project_id, org_id, created_at, updated_at)
     VALUES ($1, 'production', $2, $3, ${NOW}, ${NOW}) RETURNING id, uuid, name, description, project_id, created_at, updated_at`,
    [project.productionEnvironmentUuid, row.id, project.orgId],
  );
  return { project: row, environment: e.rows[0]! };
}

export interface ProjectChanges {
  name: string;
  description: string | null;
}

export async function updateProject(tx: SqlExecutor, id: string | number, changes: ProjectChanges): Promise<DeployProjectRow | null> {
  const r = await tx.execute<DeployProjectRow>(`UPDATE deploy.projects SET name = $2, description = $3, updated_at = ${NOW} WHERE id = $1 RETURNING ${COLUMNS}`, [
    id,
    changes.name,
    changes.description,
  ]);
  return r.rows[0] ?? null;
}

/** !Project::isEmpty(): an application, service or standalone database belongs to one of the project's environments. */
export async function projectHasResources(tx: SqlExecutor, id: string | number): Promise<boolean> {
  const r = await tx.execute<{ has: boolean }>(
    `SELECT (${hasResourcesSql("r.environment_id IN (SELECT e.id FROM deploy.environments e WHERE e.project_id = $1)")}) AS has`,
    [id],
  );
  return Boolean(r.rows[0]?.has);
}

/**
 * Project::delete() with its deleting hook: every environment (with its own
 * hook: its shared variables), the settings row and the project's shared
 * variables go with the project.
 */
export async function deleteProject(tx: SqlExecutor, id: string | number): Promise<boolean> {
  await tx.execute(
    "DELETE FROM deploy.shared_environment_variables WHERE type = 'environment' AND environment_id IN (SELECT id FROM deploy.environments WHERE project_id = $1)",
    [id],
  );
  await tx.execute("DELETE FROM deploy.environments WHERE project_id = $1", [id]);
  await tx.execute("DELETE FROM deploy.project_settings WHERE project_id = $1", [id]);
  await tx.execute("DELETE FROM deploy.shared_environment_variables WHERE type = 'project' AND project_id = $1", [id]);
  const r = await tx.execute("DELETE FROM deploy.projects WHERE id = $1 RETURNING id", [id]);
  return r.rows.length > 0;
}
