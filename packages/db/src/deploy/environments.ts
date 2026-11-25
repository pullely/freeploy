// Derived from coollabsio/coolify@91b7e3e:app/Models/Environment.php (isEmpty, the
// deleting hook) and app/Livewire/Project/Show.php (the environments query) (Apache-2.0), modified.
//
// deploy.environments queries. Every function takes the transaction of
// withOrg(): row-level security confines each query to that org, which is what
// Coolify's ownedByCurrentTeam() (whereRelation('project.team', …)) does.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

/**
 * The resource tables Project::isEmpty() and Environment::isEmpty() count:
 * applications, services and the standalone databases. Each has an
 * environment_id and soft deletes (a soft-deleted resource does not count).
 */
export const ENVIRONMENT_RESOURCE_TABLES = [
  "applications",
  "services",
  "standalone_postgresqls",
  "standalone_redis",
  "standalone_keydbs",
  "standalone_dragonflies",
  "standalone_clickhouses",
  "standalone_mongodbs",
  "standalone_mysqls",
  "standalone_mariadbs",
  "standalone_sqlites",
] as const;

/** The number of resources of the environment(s) matching `where` (`r` is the resource alias). */
export function resourceCountSql(where: string): string {
  return ENVIRONMENT_RESOURCE_TABLES.map((t) => `(SELECT count(*) FROM deploy.${t} r WHERE ${where} AND r.deleted_at IS NULL)`).join(" + ");
}

/** Whether any resource table has a row for the environment(s) matching `where`. */
export function hasResourcesSql(where: string): string {
  return ENVIRONMENT_RESOURCE_TABLES.map((t) => `EXISTS (SELECT 1 FROM deploy.${t} r WHERE ${where} AND r.deleted_at IS NULL)`).join(" OR ");
}

export interface DeployEnvironmentRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  description: string | null;
  project_id: string | number;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

export interface DeployEnvironmentListRow extends DeployEnvironmentRow {
  /** withCount() of the eleven resource relations, summed. */
  resource_count: number;
}

const COLUMNS = "id, uuid, name, description, project_id, created_at, updated_at";
const E_COLUMNS = COLUMNS.split(", ")
  .map((c) => `e.${c}`)
  .join(", ");

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** Show::mount(): the project's environments with their resource counts, orderBy('created_at'). */
export async function listEnvironments(tx: SqlExecutor, projectId: string | number): Promise<DeployEnvironmentListRow[]> {
  const r = await tx.execute<DeployEnvironmentListRow>(
    `SELECT ${E_COLUMNS}, (${resourceCountSql("r.environment_id = e.id")})::int AS resource_count
       FROM deploy.environments e WHERE e.project_id = $1 ORDER BY e.created_at, e.id`,
    [projectId],
  );
  return r.rows;
}

/** $project->environments()->where('uuid', $uuid)->first(), with its resource count. */
export async function findEnvironmentByUuid(tx: SqlExecutor, projectId: string | number, uuid: string): Promise<DeployEnvironmentListRow | null> {
  const r = await tx.execute<DeployEnvironmentListRow>(
    `SELECT ${E_COLUMNS}, (${resourceCountSql("r.environment_id = e.id")})::int AS resource_count
       FROM deploy.environments e WHERE e.project_id = $1 AND e.uuid = $2`,
    [projectId, uuid],
  );
  return r.rows[0] ?? null;
}

export interface NewEnvironment {
  orgId: string;
  projectId: string | number;
  uuid: string;
  name: string;
  description?: string | null;
}

export async function insertEnvironment(tx: SqlExecutor, environment: NewEnvironment): Promise<DeployEnvironmentRow> {
  const r = await tx.execute<DeployEnvironmentRow>(
    `INSERT INTO deploy.environments (uuid, name, description, project_id, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, ${NOW}, ${NOW}) RETURNING ${COLUMNS}`,
    [environment.uuid, environment.name, environment.description ?? null, environment.projectId, environment.orgId],
  );
  return r.rows[0]!;
}

export interface EnvironmentChanges {
  name: string;
  description: string | null;
}

export async function updateEnvironment(tx: SqlExecutor, id: string | number, changes: EnvironmentChanges): Promise<DeployEnvironmentRow | null> {
  const r = await tx.execute<DeployEnvironmentRow>(
    `UPDATE deploy.environments SET name = $2, description = $3, updated_at = ${NOW} WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, changes.name, changes.description],
  );
  return r.rows[0] ?? null;
}

/**
 * Coolify's unique(name, project_id) on environments: another environment of
 * the project has this name. The folded schema has no such index, so the
 * service asks before it writes.
 */
export async function environmentNameExists(tx: SqlExecutor, projectId: string | number, name: string, excludeId?: string | number | null): Promise<boolean> {
  const r =
    excludeId === undefined || excludeId === null
      ? await tx.execute("SELECT 1 FROM deploy.environments WHERE project_id = $1 AND name = $2 LIMIT 1", [projectId, name])
      : await tx.execute("SELECT 1 FROM deploy.environments WHERE project_id = $1 AND name = $2 AND id <> $3 LIMIT 1", [projectId, name, excludeId]);
  return r.rows.length > 0;
}

/** !Environment::isEmpty(): an application, service or standalone database belongs to the environment. */
export async function environmentHasResources(tx: SqlExecutor, id: string | number): Promise<boolean> {
  const r = await tx.execute<{ has: boolean }>(`SELECT (${hasResourcesSql("r.environment_id = $1")}) AS has`, [id]);
  return Boolean(r.rows[0]?.has);
}

/** Environment::delete() with its deleting hook: the environment's shared variables go with it. */
export async function deleteEnvironment(tx: SqlExecutor, id: string | number): Promise<boolean> {
  await tx.execute("DELETE FROM deploy.shared_environment_variables WHERE type = 'environment' AND environment_id = $1", [id]);
  const r = await tx.execute("DELETE FROM deploy.environments WHERE id = $1 RETURNING id", [id]);
  return r.rows.length > 0;
}
