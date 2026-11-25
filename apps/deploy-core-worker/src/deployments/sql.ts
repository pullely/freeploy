// Derived from coollabsio/coolify@91b7e3e:app/Jobs/ApplicationDeploymentJob.php (__construct: what the job
// loads) and app/Models/EnvironmentVariable.php (the value accessor, get_real_environment_variables_internal,
// isLockedForLogs) (Apache-2.0), modified.
//
// The deployment engine's world, from Postgres: what a deployment reads (loadDeploymentContext, in one
// transaction of its org) and what it writes (sqlDeploymentStore: each write its own transaction, as each of
// Coolify's queries is). Encrypted columns are read with the org's key; nothing decrypted is stored anywhere.
import type { SqlExecutor, TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  appendDeploymentLog,
  deploymentStatus,
  findDeploymentApplicationById,
  findDeploymentBuild,
  findDeploymentForJob,
  findDeploymentUuidsAmong,
  insertEnvironmentVariable,
  findEnvironmentVariablesByKey,
  mergeApplicationGitSshKnownHosts,
  reuseDeploymentCommitMessage,
  setDeploymentCommit,
  setDeploymentCommitMessage,
  updateApplicationHealthcheck,
  findServerSshConnection,
  findSharedVariableForReference,
  listApplicationFileStorages,
  listApplicationPersistentStorages,
  listEnvironmentVariables,
  markDeployStarted,
  markDeploymentInProgress,
  rememberServerDockerVersion,
  setDeploymentFinishedAt,
  startNextQueuedDeployments,
  updateApplicationDeploymentState,
  updateApplicationLabels,
  updateDeploymentStatus,
  findGithubAppById,
  findGithubAppPrivateKey,
  setApplicationRepositoryProjectId,
  GITHUB_APP_MORPH_CLASS,
  PUBLIC_GITHUB_SOURCE,
  type DeployDeploymentApplicationRow,
  type DeployDeploymentBuildRow,
  type SharedVariableRefScope,
} from "@saas/db/deploy";
import { labelApplication } from "../applications/labels-service.js";
import { withoutEdgeLineBreaks } from "../environment-variables/env-format.js";
import { resolveRealValue, SHARED_VARIABLE_TYPES, sharedVariableReferences, type ResolvedSharedVariable, type SharedVariableType } from "../environment-variables/references.js";
import type { ExecutorConn } from "../executor.js";
import { HTTP_BASIC_AUTH_PASSWORD_COLUMN } from "../handlers/application-labels.js";
import { columnCipher } from "../handlers/cloud-tokens.js";
import { generateLabelsApplication } from "../labels/labels.js";
import { ENVIRONMENT_VARIABLE_VERSION } from "../environment-variables/service.js";
import { newPublicId } from "../helpers/names.js";
import { LEGACY_CONFIGURATION_DIFF, type DeploymentContext, type DeploymentStore } from "./engine.js";
import type { RuntimeVariable } from "./runtime-env.js";

/**
 * The application's production variables as a deployment reads them: decrypted, with their shared variable
 * references filled in — locked ones too, as only a deployment may — in the order of the Environment
 * Variables page (by key when the application sorts them).
 */
export async function loadDeploymentVariables(tx: SqlExecutor, orgId: string, secret: string | undefined, application: DeployDeploymentApplicationRow): Promise<RuntimeVariable[]> {
  const cipher = columnCipher(tx, orgId, secret, "environment_variables.value");
  const sharedCipher = columnCipher(tx, orgId, secret, "shared_environment_variables.value");
  const scopes: Record<SharedVariableType, SharedVariableRefScope | null> = {
    team: { type: "team" },
    project: { type: "project", id: application.project_id },
    environment: { type: "environment", id: application.environment_id },
    server: application.server_id === null ? null : { type: "server", id: application.server_id },
  };
  const found = new Map<string, ResolvedSharedVariable | null>();
  const shared = async (type: string, key: string): Promise<ResolvedSharedVariable | null> => {
    const name = `${type}.${key}`;
    if (!found.has(name)) {
      const scope = (SHARED_VARIABLE_TYPES as readonly string[]).includes(type) ? scopes[type as SharedVariableType] : null;
      const row = scope ? await findSharedVariableForReference(tx, scope, key) : null;
      found.set(name, row ? { value: await sharedCipher.decrypt(row.value), isShownOnce: row.is_shown_once } : null);
    }
    return found.get(name) ?? null;
  };
  const rows = await listEnvironmentVariables(tx, "application", application.id, false, application.is_env_sorting_enabled ? "key" : "order");
  const variables: RuntimeVariable[] = [];
  for (const row of rows) {
    // The value accessor: null for a stored null or '', else the decrypted value without its edge line breaks.
    const value = row.value ? withoutEdgeLineBreaks(await cipher.decrypt(row.value)) : null;
    let referencesLocked = false;
    for (const reference of sharedVariableReferences(value)) {
      if ((await shared(reference.type, reference.key))?.isShownOnce) referencesLocked = true;
    }
    variables.push({
      id: Number(row.id),
      key: row.key,
      value,
      realValue: resolveRealValue(value, { find: (type, key) => found.get(`${type}.${key}`) ?? null }),
      is_literal: row.is_literal,
      is_multiline: row.is_multiline,
      is_runtime: row.is_runtime,
      is_buildtime: row.is_buildtime,
      is_shown_once: row.is_shown_once,
      referencesLockedSharedVariable: referencesLocked,
    });
  }
  return variables;
}

/** Everything the deployment of one queued row reads. Null when the row or its application is gone. */
export async function loadDeploymentContext(tx: SqlExecutor, orgId: string, secret: string | undefined, deploymentUuid: string): Promise<DeploymentContext | null> {
  const deployment = await findDeploymentForJob(tx, deploymentUuid);
  if (!deployment) return null;
  const application = await findDeploymentApplicationById(tx, deployment.application_id);
  const build = application ? await findDeploymentBuild(tx, application.id) : null;
  if (!application || !build) return null;
  const password = application.http_basic_auth_password ? await columnCipher(tx, orgId, secret, HTTP_BASIC_AUTH_PASSWORD_COLUMN).decrypt(application.http_basic_auth_password) : null;
  return {
    orgId,
    deployment,
    application,
    variables: await loadDeploymentVariables(tx, orgId, secret, application),
    persistentStorages: await listApplicationPersistentStorages(tx, application.id),
    fileStorages: await listApplicationFileStorages(tx, application.id),
    generateLabels: () => generateLabelsApplication(labelApplication(application, password), null),
    build,
    // No deployment stores a configuration snapshot yet: Coolify's answer after such a deployment.
    configurationDiff: LEGACY_CONFIGURATION_DIFF,
    ...(await loadPrivateGitSource(tx, orgId, secret, build)),
  };
}

/**
 * DP-72: what a private repository is cloned with — the application's GitHub App (its row and its private key,
 * decrypted; the installation token is asked of GitHub at deploy time), and its deploy key (decrypted).
 */
async function loadPrivateGitSource(tx: SqlExecutor, orgId: string, secret: string | undefined, build: DeployDeploymentBuildRow): Promise<Pick<DeploymentContext, "githubApp" | "deployKey" | "repositoryProjectId">> {
  const keyCipher = columnCipher(tx, orgId, secret, "private_keys.private_key");
  let githubApp: DeploymentContext["githubApp"] = null;
  if (build.source_type === GITHUB_APP_MORPH_CLASS && build.source_id !== null && String(build.source_id) !== String(PUBLIC_GITHUB_SOURCE.id)) {
    const row = await findGithubAppById(tx, build.source_id);
    if (row && !row.is_public) {
      const key = await findGithubAppPrivateKey(tx, row.private_key_id);
      githubApp = {
        source: { kind: "github", id: String(row.id), name: row.name, htmlUrl: row.html_url, isPublic: false, account: row.installation_account ?? row.organization, customUser: row.custom_user, customPort: Number(row.custom_port) },
        credentials: {
          name: row.name,
          organization: row.organization,
          api_url: row.api_url,
          html_url: row.html_url,
          app_id: row.app_id,
          installation_id: row.installation_id,
          is_public: false,
          privateKey: key ? await keyCipher.decrypt(key.private_key) : null,
        },
      };
    }
  }
  const deployKeyRow = build.private_key_id === null ? null : await findGithubAppPrivateKey(tx, build.private_key_id);
  const projectId = await tx.execute<{ repository_project_id: number | null }>("SELECT repository_project_id FROM deploy.applications WHERE id = $1", [build.application_id]);
  return {
    githubApp,
    deployKey: deployKeyRow ? await keyCipher.decrypt(deployKeyRow.private_key) : null,
    repositoryProjectId: projectId.rows[0]?.repository_project_id ?? null,
  };
}

/** The deployment's writes, each in a transaction of its own in the org. */
export function sqlDeploymentStore(db: TransactionalSqlExecutor, orgId: string, secret?: string): DeploymentStore {
  const run = <T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> => withOrg(db, orgId, fn);
  return {
    status: (id) => run((tx) => deploymentStatus(tx, id)),
    appendLog: async (id, entry, hint) => {
      await run((tx) => appendDeploymentLog(tx, id, entry, hint));
    },
    markInProgress: (id, worker) => run((tx) => markDeploymentInProgress(tx, id, worker)),
    markDeployStarted: (id) => run((tx) => markDeployStarted(tx, id)),
    setStatus: async (id, status) => {
      await run((tx) => updateDeploymentStatus(tx, id, status));
    },
    setFinishedAt: (id) => run((tx) => setDeploymentFinishedAt(tx, id)),
    updateApplication: async (applicationId, changes) => {
      const { custom_labels: customLabels, ...state } = changes;
      await run(async (tx) => {
        if (customLabels !== undefined) await updateApplicationLabels(tx, applicationId, { custom_labels: customLabels });
        await updateApplicationDeploymentState(tx, applicationId, state);
      });
    },
    rememberDockerVersion: (serverId, version) => run((tx) => rememberServerDockerVersion(tx, serverId, version)),
    startNextQueued: async (applicationId, serverId) => (await run((tx) => startNextQueuedDeployments(tx, applicationId, serverId))).map((d) => d.deployment_uuid),
    setCommit: (id, commit) => run((tx) => setDeploymentCommit(tx, id, commit)),
    setCommitMessage: (applicationId, commit, message) => run((tx) => setDeploymentCommitMessage(tx, applicationId, commit, message)),
    reuseCommitMessage: async (id, applicationId, commit) => {
      await run((tx) => reuseDeploymentCommitMessage(tx, id, applicationId, commit));
    },
    updateHealthcheck: async (applicationId, changes) => {
      await run((tx) => updateApplicationHealthcheck(tx, applicationId, changes));
    },
    mergeGitSshKnownHosts: (applicationId, merge) => run((tx) => mergeApplicationGitSshKnownHosts(tx, applicationId, merge)),
    deploymentUuidsAmong: (names) => run((tx) => findDeploymentUuidsAmong(tx, names)),
    // "new EnvironmentVariable; ->save()": the model's defaults — at build time and at runtime, without an order
    // (so after the ordered ones) — and, as its created hook does, the preview copy when the key has none.
    createVariable: async (applicationId, key, value) => {
      await run(async (tx) => {
        const encrypted = await columnCipher(tx, orgId, secret, "environment_variables.value").encrypt(value);
        for (const isPreview of [false, true]) {
          if (isPreview && (await findEnvironmentVariablesByKey(tx, "application", applicationId, true, key)).length > 0) continue;
          await insertEnvironmentVariable(tx, "application", applicationId, {
            orgId,
            uuid: newPublicId(),
            key,
            value: encrypted,
            comment: null,
            order: null,
            isPreview,
            isMultiline: false,
            isLiteral: false,
            isRuntime: true,
            isBuildtime: true,
            isRequired: false,
            isShownOnce: false,
            isShared: false,
            version: ENVIRONMENT_VARIABLE_VERSION,
          });
        }
      });
    },
    setRepositoryProjectId: async (applicationId, repositoryProjectId) => {
      await run((tx) => setApplicationRepositoryProjectId(tx, applicationId, repositoryProjectId));
    },
  };
}

/** How the SSH executor reaches a deployment's server: its address, user, decrypted key and pinned host key. */
export async function loadServerConnection(tx: SqlExecutor, orgId: string, secret: string | undefined, serverId: string | number): Promise<{ serverUuid: string; conn: ExecutorConn } | null> {
  const server = await findServerSshConnection(tx, serverId);
  if (!server || !server.private_key) return null;
  const privateKey = await columnCipher(tx, orgId, secret, "private_keys.private_key").decrypt(server.private_key);
  return { serverUuid: server.uuid, conn: { host: server.ip, port: server.port, user: server.user, privateKey, hostKey: server.ssh_host_key ?? "" } };
}
