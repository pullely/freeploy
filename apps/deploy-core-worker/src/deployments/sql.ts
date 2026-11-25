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
  findDeploymentForJob,
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
  type DeployDeploymentApplicationRow,
  type SharedVariableRefScope,
} from "@saas/db/deploy";
import { labelApplication } from "../applications/labels-service.js";
import { withoutEdgeLineBreaks } from "../environment-variables/env-format.js";
import { resolveRealValue, SHARED_VARIABLE_TYPES, sharedVariableReferences, type ResolvedSharedVariable, type SharedVariableType } from "../environment-variables/references.js";
import type { ExecutorConn } from "../executor.js";
import { HTTP_BASIC_AUTH_PASSWORD_COLUMN } from "../handlers/application-labels.js";
import { columnCipher } from "../handlers/cloud-tokens.js";
import { generateLabelsApplication } from "../labels/labels.js";
import type { DeploymentContext, DeploymentStore } from "./engine.js";
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
  if (!application) return null;
  const password = application.http_basic_auth_password ? await columnCipher(tx, orgId, secret, HTTP_BASIC_AUTH_PASSWORD_COLUMN).decrypt(application.http_basic_auth_password) : null;
  return {
    orgId,
    deployment,
    application,
    variables: await loadDeploymentVariables(tx, orgId, secret, application),
    persistentStorages: await listApplicationPersistentStorages(tx, application.id),
    fileStorages: await listApplicationFileStorages(tx, application.id),
    generateLabels: () => generateLabelsApplication(labelApplication(application, password), null),
  };
}

/** The deployment's writes, each in a transaction of its own in the org. */
export function sqlDeploymentStore(db: TransactionalSqlExecutor, orgId: string): DeploymentStore {
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
  };
}

/** How the SSH executor reaches a deployment's server: its address, user, decrypted key and pinned host key. */
export async function loadServerConnection(tx: SqlExecutor, orgId: string, secret: string | undefined, serverId: string | number): Promise<{ serverUuid: string; conn: ExecutorConn } | null> {
  const server = await findServerSshConnection(tx, serverId);
  if (!server || !server.private_key) return null;
  const privateKey = await columnCipher(tx, orgId, secret, "private_keys.private_key").decrypt(server.private_key);
  return { serverUuid: server.uuid, conn: { host: server.ip, port: server.port, user: server.user, privateKey, hostKey: server.ssh_host_key ?? "" } };
}
