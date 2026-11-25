// Derived from coollabsio/coolify@91b7e3e:app/Models/EnvironmentVariable.php (the relations, scopeForResourceKey,
// sameKeyVariables, performInsert, get_real_environment_variables_internal's lookup), app/Models/Application.php
// (environment_variables, environment_variables_preview, redactsAllEnvValuesInLogs) and
// app/Livewire/Project/Shared/EnvironmentVariable/{All,Add,Show}.php (the queries) (Apache-2.0), modified.
//
// deploy.environment_variables queries, the resource a variable belongs to
// (its settings and its scopes), and the lookups of shared variables that a
// value's {{scope.KEY}} references need. Every function takes the transaction
// of withOrg(): row-level security confines each query to that org. The value
// column holds an fp1 ciphertext (crypto.ts) or NULL; these functions never
// decrypt.
//
// A variable belongs to a resource through Coolify's polymorphic
// resourceable_type / resourceable_id. Applications and the eight standalone
// databases are wired (a database's type is Coolify's type(), e.g.
// 'standalone-postgresql'); a service is one more entry in
// ENVIRONMENT_VARIABLE_RESOURCES.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { DESTINATION_MORPH_CLASS } from "./destinations.js";
import { DATABASE_ENGINES, DATABASE_TABLES, type DatabaseEngine } from "./databases.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

const STANDALONE = DESTINATION_MORPH_CLASS.standalone.replace(/\\/g, "\\\\");
const SWARM = DESTINATION_MORPH_CLASS.swarm.replace(/\\/g, "\\\\");

/** What resourceable_type holds and where the page's switches are stored, for one resource type. */
interface EnvironmentVariableResource {
  /** getMorphClass() (Coolify has no morph map, so resourceable_type holds the class name). */
  morphClass: string;
  /** The query that finds one by uuid with what the Environment Variables page needs of it. */
  select: string;
  /** Where the switches of the page are stored, and which of the four the resource has. */
  settings: { table: string; key: string; columns: readonly EnvironmentVariableSettingColumn[] };
}

export const ENVIRONMENT_VARIABLE_SETTING_COLUMNS = ["is_env_sorting_enabled", "use_build_secrets", "include_coolify_default_variables", "redact_all_env_values_in_logs"] as const;
export type EnvironmentVariableSettingColumn = (typeof ENVIRONMENT_VARIABLE_SETTING_COLUMNS)[number];
export type EnvironmentVariableSettingChanges = Partial<Record<EnvironmentVariableSettingColumn, boolean>>;

/** A standalone database's type(): what its Environment Variables page is keyed by. */
export type DatabaseEnvironmentVariableResourceType = `standalone-${DatabaseEngine}`;
export const databaseEnvironmentVariableResourceType = (engine: DatabaseEngine): DatabaseEnvironmentVariableResourceType => `standalone-${engine}`;

/**
 * A standalone database's row as the page reads it: it has no build pack, Git
 * repository, Dockerfile or Compose file, and no settings row — its two
 * switches (include_coolify_default_variables, redact_all_env_values_in_logs)
 * are columns of its own table; the order and build secrets switches are an
 * application's only.
 */
function databaseSelect(engine: DatabaseEngine): string {
  return `SELECT d.id, d.uuid, d.name, NULL::varchar AS build_pack, NULL::varchar AS git_repository, NULL::text AS dockerfile,
                    NULL::text AS docker_compose,
                    d.environment_id, e.uuid AS environment_uuid, e.project_id, p.uuid AS project_uuid,
                    s.id AS server_id, s.uuid AS server_uuid,
                    NULL::boolean AS is_env_sorting_enabled, NULL::boolean AS use_build_secrets,
                    d.include_coolify_default_variables, d.redact_all_env_values_in_logs
               FROM deploy.${DATABASE_TABLES[engine].table} d
               JOIN deploy.environments e ON e.id = d.environment_id
               JOIN deploy.projects p ON p.id = e.project_id
               LEFT JOIN deploy.standalone_dockers sd ON sd.id = d.destination_id AND d.destination_type = E'${STANDALONE}'
               LEFT JOIN deploy.swarm_dockers wd ON wd.id = d.destination_id AND d.destination_type = E'${SWARM}'
               LEFT JOIN deploy.servers s ON s.id = COALESCE(sd.server_id, wd.server_id) AND s.deleted_at IS NULL
              WHERE d.uuid = $1 AND d.deleted_at IS NULL`;
}

/** The resources that have environment variables. */
const ENVIRONMENT_VARIABLE_RESOURCES: Readonly<Record<"application" | DatabaseEnvironmentVariableResourceType, EnvironmentVariableResource>> = {
  application: {
    morphClass: "App\\Models\\Application",
    select: `SELECT a.id, a.uuid, a.name, a.build_pack, a.git_repository, a.dockerfile,
                    COALESCE(a.docker_compose_raw, a.docker_compose) AS docker_compose,
                    a.environment_id, e.uuid AS environment_uuid, e.project_id, p.uuid AS project_uuid,
                    s.id AS server_id, s.uuid AS server_uuid,
                    st.is_env_sorting_enabled, st.use_build_secrets, st.include_coolify_default_variables, st.redact_all_env_values_in_logs
               FROM deploy.applications a
               JOIN deploy.environments e ON e.id = a.environment_id
               JOIN deploy.projects p ON p.id = e.project_id
               LEFT JOIN deploy.application_settings st ON st.application_id = a.id
               LEFT JOIN deploy.standalone_dockers sd ON sd.id = a.destination_id AND a.destination_type = E'${STANDALONE}'
               LEFT JOIN deploy.swarm_dockers wd ON wd.id = a.destination_id AND a.destination_type = E'${SWARM}'
               LEFT JOIN deploy.servers s ON s.id = COALESCE(sd.server_id, wd.server_id) AND s.deleted_at IS NULL
              WHERE a.uuid = $1 AND a.deleted_at IS NULL`,
    settings: { table: "deploy.application_settings", key: "application_id", columns: ENVIRONMENT_VARIABLE_SETTING_COLUMNS },
  },
  ...databaseResources(),
};

function databaseResources(): Record<DatabaseEnvironmentVariableResourceType, EnvironmentVariableResource> {
  const resources = {} as Record<DatabaseEnvironmentVariableResourceType, EnvironmentVariableResource>;
  for (const engine of DATABASE_ENGINES) {
    resources[databaseEnvironmentVariableResourceType(engine)] = {
      morphClass: DATABASE_TABLES[engine].morphClass,
      select: databaseSelect(engine),
      settings: { table: `deploy.${DATABASE_TABLES[engine].table}`, key: "id", columns: ["include_coolify_default_variables", "redact_all_env_values_in_logs"] },
    };
  }
  return resources;
}

export type EnvironmentVariableResourceType = keyof typeof ENVIRONMENT_VARIABLE_RESOURCES;

/** What resourceable_type holds for each resource type. */
export const ENVIRONMENT_VARIABLE_MORPH_CLASS = Object.fromEntries(
  Object.entries(ENVIRONMENT_VARIABLE_RESOURCES).map(([type, resource]) => [type, resource.morphClass]),
) as Readonly<Record<EnvironmentVariableResourceType, string>>;

/** The switches of the page a resource type stores: all four for an application, two for a database. */
export const environmentVariableSettingColumns = (type: EnvironmentVariableResourceType): readonly EnvironmentVariableSettingColumn[] => ENVIRONMENT_VARIABLE_RESOURCES[type].settings.columns;

/** A resource with its environment variable settings and the ids of its shared variable scopes. */
export interface DeployEnvironmentVariableResourceRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  build_pack: string | null;
  git_repository: string | null;
  dockerfile: string | null;
  /** docker_compose_raw ?? docker_compose */
  docker_compose: string | null;
  environment_id: string | number;
  environment_uuid: string;
  project_id: string | number;
  project_uuid: string;
  /** The resource's server ($resource->destination->server for an application), when it still exists. */
  server_id: string | number | null;
  server_uuid: string | null;
  /** Null without a settings row. */
  is_env_sorting_enabled: boolean | null;
  use_build_secrets: boolean | null;
  include_coolify_default_variables: boolean | null;
  redact_all_env_values_in_logs: boolean | null;
}

/** The resource by uuid within the org (soft-deleted ones are gone). */
export async function findEnvironmentVariableResource(tx: SqlExecutor, type: EnvironmentVariableResourceType, uuid: string): Promise<DeployEnvironmentVariableResourceRow | null> {
  const r = await tx.execute<DeployEnvironmentVariableResourceRow>(ENVIRONMENT_VARIABLE_RESOURCES[type].select, [uuid]);
  return r.rows[0] ?? null;
}

/** $resource->settings->save() (an application) or $resource->save() (a database): only the given switches, and updated_at. False when there is no settings row (or no such database). */
export async function updateEnvironmentVariableSettings(
  tx: SqlExecutor,
  type: EnvironmentVariableResourceType,
  resourceId: string | number,
  changes: EnvironmentVariableSettingChanges,
): Promise<boolean> {
  const { table, key, columns: own } = ENVIRONMENT_VARIABLE_RESOURCES[type].settings;
  const columns = ENVIRONMENT_VARIABLE_SETTING_COLUMNS.filter((c) => changes[c] !== undefined);
  for (const c of columns) if (!own.includes(c)) throw new Error(`a ${type} has no setting "${c}"`);
  const sets = columns.map((c, i) => `"${c}" = $${i + 2}`);
  const r = await tx.execute(`UPDATE ${table} SET ${[...sets, `updated_at = ${NOW}`].join(", ")} WHERE "${key}" = $1 RETURNING id`, [resourceId, ...columns.map((c) => changes[c]!)]);
  return r.rows.length > 0;
}

export interface DeployEnvironmentVariableRow extends SqlRow {
  id: string | number;
  uuid: string | null;
  key: string;
  /** The stored ciphertext, or null. */
  value: string | null;
  comment: string | null;
  order: number | null;
  is_preview: boolean;
  is_multiline: boolean;
  is_literal: boolean;
  is_runtime: boolean;
  is_buildtime: boolean;
  is_required: boolean;
  is_shown_once: boolean;
  /** The stored column: the value is one shared variable reference. */
  is_shared: boolean;
  version: string;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

const COLUMNS =
  'id, uuid, "key", "value", "comment", "order", is_preview, is_multiline, is_literal, is_runtime, is_buildtime, is_required, is_shown_once, is_shared, version, created_at, updated_at';
/** resourceable_type = $1 AND resourceable_id = $2 */
const OF_RESOURCE = "resourceable_type = $1 AND resourceable_id = $2";

/**
 * $resource->environment_variables() or environment_variables_preview(), by
 * `order` then id (creation order: the list's default) or by key (the
 * resource's "Alphabetical" setting).
 */
export async function listEnvironmentVariables(
  tx: SqlExecutor,
  type: EnvironmentVariableResourceType,
  resourceId: string | number,
  isPreview: boolean,
  orderBy: "order" | "key" = "order",
): Promise<DeployEnvironmentVariableRow[]> {
  const r = await tx.execute<DeployEnvironmentVariableRow>(
    `SELECT ${COLUMNS} FROM deploy.environment_variables WHERE ${OF_RESOURCE} AND is_preview = $3 ORDER BY ${orderBy === "key" ? '"key", id' : '"order", id'}`,
    [ENVIRONMENT_VARIABLE_MORPH_CLASS[type], resourceId, isPreview],
  );
  return r.rows;
}

/** One variable of the resource by its uuid. */
export async function findEnvironmentVariableByUuid(tx: SqlExecutor, type: EnvironmentVariableResourceType, resourceId: string | number, uuid: string): Promise<DeployEnvironmentVariableRow | null> {
  const r = await tx.execute<DeployEnvironmentVariableRow>(`SELECT ${COLUMNS} FROM deploy.environment_variables WHERE ${OF_RESOURCE} AND uuid = $3`, [
    ENVIRONMENT_VARIABLE_MORPH_CLASS[type],
    resourceId,
    uuid,
  ]);
  return r.rows[0] ?? null;
}

/** scopeForResourceKey(): the variables of one resource and preview flag that have the key, oldest first (a key can have copies). */
export async function findEnvironmentVariablesByKey(
  tx: SqlExecutor,
  type: EnvironmentVariableResourceType,
  resourceId: string | number,
  isPreview: boolean,
  key: string,
): Promise<DeployEnvironmentVariableRow[]> {
  const r = await tx.execute<DeployEnvironmentVariableRow>(`SELECT ${COLUMNS} FROM deploy.environment_variables WHERE ${OF_RESOURCE} AND is_preview = $3 AND "key" = $4 ORDER BY id`, [
    ENVIRONMENT_VARIABLE_MORPH_CLASS[type],
    resourceId,
    isPreview,
    key,
  ]);
  return r.rows;
}

/** $resource->environment_variables()->max('order') ?? 0: the highest order among the variables that are not preview ones. */
export async function maxEnvironmentVariableOrder(tx: SqlExecutor, type: EnvironmentVariableResourceType, resourceId: string | number): Promise<number> {
  const r = await tx.execute<{ max: number | string | null }>(`SELECT max("order") AS max FROM deploy.environment_variables WHERE ${OF_RESOURCE} AND is_preview = false`, [
    ENVIRONMENT_VARIABLE_MORPH_CLASS[type],
    resourceId,
  ]);
  return Number(r.rows[0]?.max ?? 0);
}

export interface NewEnvironmentVariable {
  orgId: string;
  /** BaseModel's creating hook: new_public_id(). */
  uuid: string;
  key: string;
  /** The fp1 ciphertext of the value, or null. */
  value: string | null;
  comment: string | null;
  order: number | null;
  isPreview: boolean;
  isMultiline: boolean;
  isLiteral: boolean;
  isRuntime: boolean;
  isBuildtime: boolean;
  isRequired: boolean;
  isShownOnce: boolean;
  isShared: boolean;
  /** The creating hook: config('constants.coolify.version'). */
  version: string;
}

/**
 * EnvironmentVariable::performInsert(): the table has no unique index on
 * resource and key, so inserts of one key wait for each other (an advisory
 * lock held until the transaction ends) and a second row of the key is
 * refused: null, where Coolify throws a unique constraint violation.
 */
export async function insertEnvironmentVariable(
  tx: SqlExecutor,
  type: EnvironmentVariableResourceType,
  resourceId: string | number,
  variable: NewEnvironmentVariable,
): Promise<DeployEnvironmentVariableRow | null> {
  const morph = ENVIRONMENT_VARIABLE_MORPH_CLASS[type];
  await tx.execute("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`environment_variables:${morph}:${resourceId}:${variable.isPreview ? 1 : 0}:${variable.key}`]);
  if ((await findEnvironmentVariablesByKey(tx, type, resourceId, variable.isPreview, variable.key)).length > 0) return null;
  const r = await tx.execute<DeployEnvironmentVariableRow>(
    `INSERT INTO deploy.environment_variables
       (uuid, "key", "value", "comment", "order", is_preview, is_multiline, is_literal, is_runtime, is_buildtime, is_required, is_shown_once, is_shared,
        version, resourceable_type, resourceable_id, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, ${NOW}, ${NOW})
     RETURNING ${COLUMNS}`,
    [
      variable.uuid,
      variable.key,
      variable.value,
      variable.comment,
      variable.order,
      variable.isPreview,
      variable.isMultiline,
      variable.isLiteral,
      variable.isRuntime,
      variable.isBuildtime,
      variable.isRequired,
      variable.isShownOnce,
      variable.isShared,
      variable.version,
      morph,
      resourceId,
      variable.orgId,
    ],
  );
  return r.rows[0]!;
}

/** The columns a save writes. `value` is the caller's ciphertext (or null). */
export const ENVIRONMENT_VARIABLE_COLUMNS = ["key", "value", "comment", "order", "is_multiline", "is_literal", "is_runtime", "is_buildtime", "is_required", "is_shown_once", "is_shared"] as const;
export type EnvironmentVariableColumn = (typeof ENVIRONMENT_VARIABLE_COLUMNS)[number];
export interface EnvironmentVariableChanges {
  key?: string;
  value?: string | null;
  comment?: string | null;
  order?: number | null;
  is_multiline?: boolean;
  is_literal?: boolean;
  is_runtime?: boolean;
  is_buildtime?: boolean;
  is_required?: boolean;
  is_shown_once?: boolean;
  is_shared?: boolean;
}

/** $env->save(): only the given columns (the dirty ones), and updated_at. */
export async function updateEnvironmentVariable(tx: SqlExecutor, id: string | number, changes: EnvironmentVariableChanges): Promise<DeployEnvironmentVariableRow | null> {
  const columns = ENVIRONMENT_VARIABLE_COLUMNS.filter((c) => changes[c] !== undefined);
  const sets = columns.map((c, i) => `"${c}" = $${i + 2}`);
  const r = await tx.execute<DeployEnvironmentVariableRow>(`UPDATE deploy.environment_variables SET ${[...sets, `updated_at = ${NOW}`].join(", ")} WHERE id = $1 RETURNING ${COLUMNS}`, [
    id,
    ...columns.map((c) => changes[c]!),
  ]);
  return r.rows[0] ?? null;
}

/** ->whereKey($ids)->delete(): how many rows went. */
export async function deleteEnvironmentVariables(tx: SqlExecutor, ids: Array<string | number>): Promise<number> {
  if (ids.length === 0) return 0;
  const r = await tx.execute(`DELETE FROM deploy.environment_variables WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`, ids);
  return r.rows.length;
}

/**
 * Where a shared variable lives: the org (Coolify's team), or one project,
 * environment or server of it.
 */
export type SharedVariableRefScope = { type: "team" } | { type: "project" | "environment" | "server"; id: string | number };

const sharedScope = (scope: SharedVariableRefScope): { where: string; params: Array<string | number> } =>
  scope.type === "team" ? { where: `"type" = 'team'`, params: [] } : { where: `"type" = '${scope.type}' AND "${scope.type}_id" = $1`, params: [scope.id] };

/** A shared variable as a reference needs it: its stored (encrypted) value and whether it is locked. */
export interface DeploySharedVariableReferenceRow extends SqlRow {
  key: string;
  /** The fp1 ciphertext. */
  value: string;
  is_shown_once: boolean;
}

/**
 * SharedEnvironmentVariable::where('type', $type)->where('key', $key)
 * ->where('team_id', …)->where("{$type}_id", $id)->first(): the shared
 * variable a {{type.KEY}} reference names in one scope.
 */
export async function findSharedVariableForReference(tx: SqlExecutor, scope: SharedVariableRefScope, key: string): Promise<DeploySharedVariableReferenceRow | null> {
  const { where, params } = sharedScope(scope);
  const r = await tx.execute<DeploySharedVariableReferenceRow>(
    `SELECT "key", "value", is_shown_once FROM deploy.shared_environment_variables WHERE ${where} AND "key" = $${params.length + 1} ORDER BY id LIMIT 1`,
    [...params, key],
  );
  return r.rows[0] ?? null;
}

/** $scope->environment_variables()->pluck('key'): the keys of one scope's shared variables, for the value field's suggestions. */
export async function listSharedVariableKeys(tx: SqlExecutor, scope: SharedVariableRefScope): Promise<string[]> {
  const { where, params } = sharedScope(scope);
  const r = await tx.execute<{ key: string }>(`SELECT "key" FROM deploy.shared_environment_variables WHERE ${where} ORDER BY id`, params);
  return r.rows.map((row) => row.key);
}
