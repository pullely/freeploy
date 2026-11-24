// Derived from coollabsio/coolify@91b7e3e:app/Models/SharedEnvironmentVariable.php,
// app/Models/{Team,Project,Environment,Server}.php (environment_variables),
// app/Livewire/SharedVariables/{Project,Environment,Server}/Index.php and
// app/Services/SharedVariableCanvas.php (overview) (Apache-2.0), modified.
//
// deploy.shared_environment_variables queries. Every function takes the
// transaction of withOrg(): row-level security confines each query to that
// org, which is what Coolify's team_id does. A variable belongs to one owner:
// the org itself (type 'team'), a project, an environment or a server. The
// value column holds an fp1 ciphertext (crypto.ts); these functions never
// decrypt. Coolify's unique(key, project_id | environment_id | server_id,
// team_id) indexes are not in the folded schema, so the service asks
// (findSharedVariableByKey) before it writes.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

/** SharedVariableCanvas::SCOPES: the `type` values. */
export const SHARED_VARIABLE_SCOPES = ["team", "project", "environment", "server"] as const;
export type SharedVariableScope = (typeof SHARED_VARIABLE_SCOPES)[number];

/** Whose variables: the org (id null), or the project, environment or server with this id. */
export interface SharedVariableOwner {
  type: SharedVariableScope;
  id: string | number | null;
}

export interface DeploySharedVariableRow extends SqlRow {
  id: string | number;
  key: string;
  type: SharedVariableScope;
  project_id: string | number | null;
  environment_id: string | number | null;
  server_id: string | number | null;
  is_shown_once: boolean;
  is_multiline: boolean;
  is_literal: boolean;
  comment: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

/** A row with its stored (encrypted) value. */
export interface DeploySharedVariableWithSecretRow extends DeploySharedVariableRow {
  value: string;
}

const COLUMNS = "id, key, type, project_id, environment_id, server_id, is_shown_once, is_multiline, is_literal, comment, created_at, updated_at";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

const OWNER_COLUMN = { project: "project_id", environment: "environment_id", server: "server_id" } as const;

/** hasMany(SharedEnvironmentVariable::class)->where('type', …) of the owner; its id is parameter $1 (the org has none). */
function ownedBy(owner: SharedVariableOwner): { sql: string; params: unknown[] } {
  if (owner.type === "team") return { sql: "type = 'team'", params: [] };
  return { sql: `type = '${owner.type}' AND ${OWNER_COLUMN[owner.type]} = $1`, params: [owner.id] };
}

/** $owner->environment_variables: the owner's variables in the order they were created, with their encrypted values. */
export async function listSharedVariables(tx: SqlExecutor, owner: SharedVariableOwner): Promise<DeploySharedVariableWithSecretRow[]> {
  const where = ownedBy(owner);
  const r = await tx.execute<DeploySharedVariableWithSecretRow>(`SELECT ${COLUMNS}, value FROM deploy.shared_environment_variables WHERE ${where.sql} ORDER BY id`, where.params);
  return r.rows;
}

/** One variable of the owner by id, with its encrypted value. */
export async function findSharedVariableById(tx: SqlExecutor, owner: SharedVariableOwner, id: string | number): Promise<DeploySharedVariableWithSecretRow | null> {
  const where = ownedBy(owner);
  const r = await tx.execute<DeploySharedVariableWithSecretRow>(
    `SELECT ${COLUMNS}, value FROM deploy.shared_environment_variables WHERE ${where.sql} AND id = $${where.params.length + 1}`,
    [...where.params, id],
  );
  return r.rows[0] ?? null;
}

/** $owner->environment_variables()->where('key', $key)->first(). */
export async function findSharedVariableByKey(tx: SqlExecutor, owner: SharedVariableOwner, key: string): Promise<DeploySharedVariableWithSecretRow | null> {
  const where = ownedBy(owner);
  const r = await tx.execute<DeploySharedVariableWithSecretRow>(
    `SELECT ${COLUMNS}, value FROM deploy.shared_environment_variables WHERE ${where.sql} AND key = $${where.params.length + 1} ORDER BY id LIMIT 1`,
    [...where.params, key],
  );
  return r.rows[0] ?? null;
}

export interface NewSharedVariable {
  orgId: string;
  owner: SharedVariableOwner;
  key: string;
  /** The fp1 ciphertext of the value. */
  value: string;
  comment?: string | null;
  isMultiline?: boolean;
  isLiteral?: boolean;
}

/** $owner->environment_variables()->create([...]): the type and the owner's column follow the owner. */
export async function insertSharedVariable(tx: SqlExecutor, variable: NewSharedVariable): Promise<DeploySharedVariableRow> {
  const { owner } = variable;
  const ids = {
    project: owner.type === "project" ? owner.id : null,
    environment: owner.type === "environment" ? owner.id : null,
    server: owner.type === "server" ? owner.id : null,
  };
  const r = await tx.execute<DeploySharedVariableRow>(
    `INSERT INTO deploy.shared_environment_variables
       (key, value, type, project_id, environment_id, server_id, comment, is_multiline, is_literal, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${NOW}, ${NOW}) RETURNING ${COLUMNS}`,
    [variable.key, variable.value, owner.type, ids.project, ids.environment, ids.server, variable.comment ?? null, variable.isMultiline ?? false, variable.isLiteral ?? false, variable.orgId],
  );
  return r.rows[0]!;
}

/** What a save may change; a property left out keeps its column. */
export interface SharedVariableChanges {
  key?: string;
  /** The fp1 ciphertext of the new value. */
  value?: string;
  comment?: string | null;
  isMultiline?: boolean;
  isLiteral?: boolean;
  isShownOnce?: boolean;
}

const CHANGE_COLUMNS: Array<[keyof SharedVariableChanges, string]> = [
  ["key", "key"],
  ["value", "value"],
  ["comment", "comment"],
  ["isMultiline", "is_multiline"],
  ["isLiteral", "is_literal"],
  ["isShownOnce", "is_shown_once"],
];

/**
 * $variable->save(). The model's saving hook is part of the statement: a lock
 * is permanent, so is_shown_once never goes back to false.
 */
export async function updateSharedVariable(tx: SqlExecutor, id: string | number, changes: SharedVariableChanges): Promise<DeploySharedVariableRow | null> {
  const params: unknown[] = [id];
  const sets: string[] = [];
  for (const [property, column] of CHANGE_COLUMNS) {
    if (changes[property] === undefined) continue;
    params.push(changes[property]);
    sets.push(column === "is_shown_once" ? `is_shown_once = (is_shown_once OR $${params.length})` : `${column} = $${params.length}`);
  }
  const r = await tx.execute<DeploySharedVariableRow>(`UPDATE deploy.shared_environment_variables SET ${[...sets, `updated_at = ${NOW}`].join(", ")} WHERE id = $1 RETURNING ${COLUMNS}`, params);
  return r.rows[0] ?? null;
}

export async function deleteSharedVariable(tx: SqlExecutor, id: string | number): Promise<boolean> {
  const r = await tx.execute("DELETE FROM deploy.shared_environment_variables WHERE id = $1 RETURNING id", [id]);
  return r.rows.length > 0;
}

/**
 * The developer view's deleteRemovedVariables():
 * $owner->environment_variables()->whereNotIn('key', $keys)->delete(), which
 * for a server also keeps `protectedKeys` (its predefined variables). Returns
 * how many rows went.
 */
export async function deleteSharedVariablesExcept(tx: SqlExecutor, owner: SharedVariableOwner, keys: string[], protectedKeys: string[] = []): Promise<number> {
  const where = ownedBy(owner);
  const keep = [...keys, ...protectedKeys];
  if (keep.length === 0) {
    const all = await tx.execute(`DELETE FROM deploy.shared_environment_variables WHERE ${where.sql} RETURNING id`, where.params);
    return all.rows.length;
  }
  const placeholders = keep.map((_, i) => `$${where.params.length + 1 + i}`).join(", ");
  const r = await tx.execute(`DELETE FROM deploy.shared_environment_variables WHERE ${where.sql} AND key NOT IN (${placeholders}) RETURNING id`, [...where.params, ...keep]);
  return r.rows.length;
}

/** A variable with the names its owner shows in the overview. */
export interface DeploySharedVariableOverviewRow extends SqlRow {
  id: string | number;
  key: string;
  type: SharedVariableScope;
  project_id: string | number | null;
  environment_id: string | number | null;
  server_id: string | number | null;
  updated_at: string | Date | null;
  project_uuid: string | null;
  project_name: string | null;
  environment_uuid: string | null;
  environment_name: string | null;
  environment_project_uuid: string | null;
  environment_project_name: string | null;
  server_uuid: string | null;
  server_name: string | null;
}

/**
 * SharedVariableCanvas::overview(): every shared variable of the org
 * ->with(['project', 'environment.project', 'server']). Keys and owners only;
 * the value is not read.
 */
export async function listSharedVariablesOverview(tx: SqlExecutor): Promise<DeploySharedVariableOverviewRow[]> {
  const r = await tx.execute<DeploySharedVariableOverviewRow>(
    `SELECT v.id, v.key, v.type, v.project_id, v.environment_id, v.server_id, v.updated_at,
            p.uuid AS project_uuid, p.name AS project_name,
            e.uuid AS environment_uuid, e.name AS environment_name,
            ep.uuid AS environment_project_uuid, ep.name AS environment_project_name,
            s.uuid AS server_uuid, s.name AS server_name
       FROM deploy.shared_environment_variables v
       LEFT JOIN deploy.projects p ON v.type = 'project' AND p.id = v.project_id
       LEFT JOIN deploy.environments e ON v.type = 'environment' AND e.id = v.environment_id
       LEFT JOIN deploy.projects ep ON ep.id = e.project_id
       LEFT JOIN deploy.servers s ON v.type = 'server' AND s.id = v.server_id AND s.deleted_at IS NULL
      ORDER BY v.id`,
  );
  return r.rows;
}

/** A project as the project variables index lists it. */
export interface DeploySharedVariableProjectRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  description: string | null;
  /** $project->environment_variables()->count() */
  variable_count: number;
}

/** Project\Index::mount(): Project::ownedByCurrentTeam() (orderByRaw('LOWER(name)')) with each project's variable count. */
export async function listSharedVariableProjects(tx: SqlExecutor): Promise<DeploySharedVariableProjectRow[]> {
  const r = await tx.execute<DeploySharedVariableProjectRow>(
    `SELECT p.id, p.uuid, p.name, p.description,
            (SELECT count(*) FROM deploy.shared_environment_variables v WHERE v.type = 'project' AND v.project_id = p.id)::int AS variable_count
       FROM deploy.projects p ORDER BY LOWER(p.name), p.id`,
  );
  return r.rows;
}

/** An environment with its project, as the environment variables index and page need it. */
export interface DeploySharedVariableEnvironmentRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  description: string | null;
  project_id: string | number;
  project_uuid: string;
  project_name: string;
  project_description: string | null;
}

const ENVIRONMENT_SELECT = `SELECT e.id, e.uuid, e.name, e.description, e.project_id,
            p.uuid AS project_uuid, p.name AS project_name, p.description AS project_description
       FROM deploy.environments e JOIN deploy.projects p ON p.id = e.project_id`;

/** Environment\Index::mount(): the org's projects in their order, each with its environments. */
export async function listSharedVariableEnvironments(tx: SqlExecutor): Promise<DeploySharedVariableEnvironmentRow[]> {
  const r = await tx.execute<DeploySharedVariableEnvironmentRow>(`${ENVIRONMENT_SELECT} ORDER BY LOWER(p.name), p.id, e.id`);
  return r.rows;
}

/** An environment of the org by its uuid, with its project. */
export async function findSharedVariableEnvironment(tx: SqlExecutor, uuid: string): Promise<DeploySharedVariableEnvironmentRow | null> {
  const r = await tx.execute<DeploySharedVariableEnvironmentRow>(`${ENVIRONMENT_SELECT} WHERE e.uuid = $1`, [uuid]);
  return r.rows[0] ?? null;
}

/** A server as the server variables index lists it. */
export interface DeploySharedVariableServerRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  description: string | null;
  ip: string;
  is_reachable: boolean | null;
  is_usable: boolean | null;
  force_disabled: boolean | null;
}

/** Server\Index::mount(): Server::ownedByCurrentTeam() (ordered by name), with what isFunctional() reads. */
export async function listSharedVariableServers(tx: SqlExecutor): Promise<DeploySharedVariableServerRow[]> {
  const r = await tx.execute<DeploySharedVariableServerRow>(
    `SELECT s.id, s.uuid, s.name, s.description, s.ip, ss.is_reachable, ss.is_usable, ss.force_disabled
       FROM deploy.servers s LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id
      WHERE s.deleted_at IS NULL
      ORDER BY s.name, s.id`,
  );
  return r.rows;
}
