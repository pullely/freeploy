// Derived from coollabsio/coolify@91b7e3e:app/Jobs/ApplicationDeploymentJob.php (what a build reads of an
// application and its settings; check_git_if_build_needed, reuse_commit_message, clone_repository and
// save_git_ssh_known_hosts: what they write) and app/Models/Application.php (parseHealthcheckFromDockerfile:
// the columns it saves) (Apache-2.0), modified.
//
// What a deployment that builds reads and writes beside deployments.ts: the Git and build columns of its
// application, the commit and commit message of its deployment, the health check a Dockerfile declares, and
// the SSH host keys git accepted. Every function takes the transaction of withOrg(), so row-level security
// confines it to that org.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { DEPLOYMENT_STATUS } from "./deployments.js";
import { DESTINATION_MORPH_CLASS } from "./destinations.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** The columns of an application, and of its settings, that only a build reads. */
export interface DeployDeploymentBuildRow extends SqlRow {
  application_id: string | number;
  git_repository: string;
  git_commit_sha: string;
  base_directory: string | null;
  publish_directory: string | null;
  /** The pasted Dockerfile of a "simple Dockerfile" application. */
  dockerfile: string | null;
  dockerfile_location: string | null;
  install_command: string | null;
  build_command: string | null;
  start_command: string | null;
  static_image: string | null;
  custom_nginx_configuration: string | null;
  source_id: string | number | null;
  source_type: string | null;
  private_key_id: string | number | null;
  /** A username for HTTPS is stored: the repository is cloned with credentials. */
  has_git_https_credentials: boolean;
  // application_settings (null when the row is missing)
  is_spa: boolean | null;
  is_git_submodules_enabled: boolean | null;
  is_git_lfs_enabled: boolean | null;
  is_git_shallow_clone_enabled: boolean | null;
  disable_build_cache: boolean | null;
  inject_build_args_to_dockerfile: boolean | null;
  include_source_commit_in_build: boolean | null;
  is_build_server_enabled: boolean | null;
  is_preserve_repository_enabled: boolean | null;
  /**
   * ServerSetting::effectiveServerRole() of the application's server: "deployment", "build" or "both". A
   * server for deployments only builds nothing.
   */
  server_role: string | null;
}

/** What a build reads of the application a deployment is of. Null when it is not the org's. */
export async function findDeploymentBuild(tx: SqlExecutor, applicationId: string | number): Promise<DeployDeploymentBuildRow | null> {
  if (!/^\d+$/.test(String(applicationId))) return null;
  const r = await tx.execute<DeployDeploymentBuildRow>(
    `SELECT a.id AS application_id, a.git_repository, a.git_commit_sha, a.base_directory, a.publish_directory, a.dockerfile, a.dockerfile_location,
            a.install_command, a.build_command, a.start_command, a.static_image, a.custom_nginx_configuration, a.source_id, a.source_type,
            a.private_key_id, (a.git_https_username IS NOT NULL AND a.git_https_username <> '') AS has_git_https_credentials,
            st.is_spa, st.is_git_submodules_enabled, st.is_git_lfs_enabled, st.is_git_shallow_clone_enabled, st.disable_build_cache,
            st.inject_build_args_to_dockerfile, st.include_source_commit_in_build, st.is_build_server_enabled, st.is_preserve_repository_enabled,
            COALESCE(ss.server_role, CASE WHEN ss.is_build_server THEN 'build' ELSE 'both' END) AS server_role
       FROM deploy.applications a
       LEFT JOIN deploy.application_settings st ON st.application_id = a.id
       LEFT JOIN deploy.standalone_dockers sd ON sd.id = a.destination_id AND a.destination_type = $2
       LEFT JOIN deploy.swarm_dockers wd ON wd.id = a.destination_id AND a.destination_type = $3
       LEFT JOIN deploy.server_settings ss ON ss.server_id = COALESCE(sd.server_id, wd.server_id)
      WHERE a.id = $1 AND a.deleted_at IS NULL`,
    [applicationId, DESTINATION_MORPH_CLASS.standalone, DESTINATION_MORPH_CLASS.swarm],
  );
  return r.rows[0] ?? null;
}

/** "$this->application_deployment_queue->commit = $this->commit; ->save()": the commit the branch's head resolved to. */
export async function setDeploymentCommit(tx: SqlExecutor, id: string | number, commit: string): Promise<void> {
  await tx.execute(`UPDATE deploy.application_deployment_queues SET "commit" = $2, updated_at = ${NOW} WHERE id = $1`, [id, commit]);
}

/**
 * clone_repository(): the message of the commit, on every deployment of the application of that commit that was
 * not skipped — this one too.
 */
export async function setDeploymentCommitMessage(tx: SqlExecutor, applicationId: string | number, commit: string, message: string): Promise<void> {
  await tx.execute(`UPDATE deploy.application_deployment_queues SET commit_message = $3, updated_at = ${NOW} WHERE application_id = $1 AND "commit" = $2 AND status <> $4`, [
    String(applicationId),
    commit,
    message,
    DEPLOYMENT_STATUS.skipped,
  ]);
}

/**
 * reuse_commit_message(): a deployment without a message takes the one an earlier deployment of the same commit
 * stored. True when one was found.
 */
export async function reuseDeploymentCommitMessage(tx: SqlExecutor, id: string | number, applicationId: string | number, commit: string): Promise<boolean> {
  const current = await tx.execute<{ commit_message: string | null }>("SELECT commit_message FROM deploy.application_deployment_queues WHERE id = $1", [id]);
  if (current.rows.length === 0 || (current.rows[0]!.commit_message ?? "").trim() !== "") return false;
  const found = await tx.execute<{ commit_message: string }>(
    `SELECT commit_message FROM deploy.application_deployment_queues
      WHERE application_id = $1 AND "commit" = $2 AND status <> $3 AND commit_message IS NOT NULL AND commit_message <> ''
      ORDER BY id DESC LIMIT 1`,
    [String(applicationId), commit, DEPLOYMENT_STATUS.skipped],
  );
  const message = found.rows[0]?.commit_message ?? "";
  if (message.trim() === "") return false;
  await tx.execute(`UPDATE deploy.application_deployment_queues SET commit_message = $2, updated_at = ${NOW} WHERE id = $1`, [id, message]);
  return true;
}

/** What parseHealthcheckFromDockerfile() and the Nixpacks Rust rule save on the application. */
export interface ApplicationHealthcheckChanges {
  health_check_enabled?: boolean;
  health_check_interval?: number;
  health_check_timeout?: number;
  health_check_retries?: number;
  health_check_start_period?: number;
  custom_healthcheck_found?: boolean;
}

const HEALTHCHECK_COLUMNS = ["health_check_enabled", "health_check_interval", "health_check_timeout", "health_check_retries", "health_check_start_period", "custom_healthcheck_found"] as const;

/** $application->save() with only these columns dirty. */
export async function updateApplicationHealthcheck(tx: SqlExecutor, id: string | number, changes: ApplicationHealthcheckChanges): Promise<boolean> {
  const columns = HEALTHCHECK_COLUMNS.filter((c) => changes[c] !== undefined);
  if (columns.length === 0) return true;
  const r = await tx.execute<{ id: string | number }>(
    `UPDATE deploy.applications SET ${[...columns.map((c, i) => `"${c}" = $${i + 2}`), `updated_at = ${NOW}`].join(", ")} WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [id, ...columns.map((c) => changes[c] ?? null)],
  );
  return r.rows.length > 0;
}

/**
 * save_git_ssh_known_hosts(), its transaction: the stored host keys are read under the row's lock and `merge`
 * says what they become; they are written only when that differs. Answers what `merge` answered, or null when
 * the application is gone.
 */
export async function mergeApplicationGitSshKnownHosts<T extends { knownHosts: string; changed: boolean }>(tx: SqlExecutor, id: string | number, merge: (stored: string | null) => T): Promise<T | null> {
  const stored = await tx.execute<{ git_ssh_known_hosts: string | null }>("SELECT git_ssh_known_hosts FROM deploy.applications WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]);
  if (stored.rows.length === 0) return null;
  const result = merge(stored.rows[0]!.git_ssh_known_hosts);
  if (result.changed) await tx.execute(`UPDATE deploy.applications SET git_ssh_known_hosts = $2, updated_at = ${NOW} WHERE id = $1`, [id, result.knownHosts]);
  return result;
}

/**
 * ApplicationDeploymentQueue::whereIn('deployment_uuid', $names)->pluck('deployment_uuid'): which of these
 * container names are deployments of the org — a build helper container is named after its deployment.
 */
export async function findDeploymentUuidsAmong(tx: SqlExecutor, names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const r = await tx.execute<{ deployment_uuid: string }>("SELECT deployment_uuid FROM deploy.application_deployment_queues WHERE deployment_uuid = ANY($1::text[])", [names]);
  return r.rows.map((row) => row.deployment_uuid);
}
