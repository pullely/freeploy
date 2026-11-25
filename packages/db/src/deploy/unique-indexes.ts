// The unique indexes of 660_deploy_schema_catch_up on the tables deploy-core-worker
// writes (DP-63). Coolify has the same indexes and leaves a duplicate to them:
// Laravel's UniqueConstraintViolationException becomes handleError()'s
// "Duplicate entry found. Please use a different name.". Freeploy's services ask
// before they write, so that the answer names the thing; two requests at the same
// moment both pass that question, and the second one's write is refused by the
// index with SQLSTATE 23505. refusingDuplicates() gives that write the answer of
// the question it passed.
//
// The names are the indexes' names in the migration; tests/db holds them to the
// schema at head.

export const DEPLOY_UNIQUE_INDEXES = {
  /** (name, project_id) */
  environmentName: "environments_name_project_id_unique",
  /** (name, resource_id, resource_type) */
  persistentVolumeName: "local_persistent_volumes_name_resource_id_resource_type_unique",
  /** (mount_path, resource_id, resource_type) */
  fileVolumeMountPath: "local_file_volumes_mount_path_resource_id_resource_type_unique",
  /** (server_id, network) */
  standaloneNetwork: "standalone_dockers_server_id_network_unique",
  /** (server_id, network) */
  swarmNetwork: "swarm_dockers_server_id_network_unique",
  /** (tag_id, taggable_id, taggable_type) */
  taggable: "taggable_unique",
  /** (application_id, server_id, standalone_docker_id) */
  additionalDestination: "additional_destinations_application_server_docker_unique",
  /** (key, project_id, org_id) */
  sharedVariableProject: "shared_environment_variables_key_project_id_org_id_unique",
  /** (key, environment_id, org_id) */
  sharedVariableEnvironment: "shared_environment_variables_key_environment_id_org_id_unique",
  /** (key, server_id, org_id) */
  sharedVariableServer: "shared_environment_variables_key_server_id_org_id_unique",
} as const;

export type DeployUniqueIndex = (typeof DEPLOY_UNIQUE_INDEXES)[keyof typeof DEPLOY_UNIQUE_INDEXES];

/** The three indexes of deploy.shared_environment_variables: one per scope that has an owner row. */
export const SHARED_VARIABLE_UNIQUE_INDEXES: readonly DeployUniqueIndex[] = [
  DEPLOY_UNIQUE_INDEXES.sharedVariableProject,
  DEPLOY_UNIQUE_INDEXES.sharedVariableEnvironment,
  DEPLOY_UNIQUE_INDEXES.sharedVariableServer,
];

/**
 * The index a statement violated, when the error is Postgres's unique_violation
 * (SQLSTATE 23505); null for any other error. postgres.js names it
 * `constraint_name`, PGlite and node-postgres `constraint`.
 */
export function violatedUniqueIndex(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const e = error as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
  if (e.code !== "23505") return null;
  const name = e.constraint_name ?? e.constraint;
  return typeof name === "string" ? name : "";
}

/**
 * Runs a write; when one of `indexes` refuses it, throws `refusal()` in the
 * error's place. Any other error — another index's violation too — passes
 * through. The transaction is aborted by then: the refusal must leave it,
 * which is what throwing does inside withOrg().
 */
export async function refusingDuplicates<T>(indexes: readonly DeployUniqueIndex[], write: () => Promise<T>, refusal: () => Error): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const index = violatedUniqueIndex(error);
    if (index !== null && (indexes as readonly string[]).includes(index)) throw refusal();
    throw error;
  }
}
