// The deploy bounded context's data access (DP2). Every query runs inside
// withOrg(): one transaction, as role deploy_app (which cannot bypass RLS),
// with deploy.org_id set for that transaction only. Row-level security on
// every deploy table (500_deploy_core) then confines the transaction to that
// org: a query that forgets an org filter still sees only its org's rows.
import type { SqlExecutor, TransactionalSqlExecutor } from "../hyperdrive/executor.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenancyError extends Error {}

/** Run fn in a transaction confined to one org by row-level security. */
export async function withOrg<T>(db: TransactionalSqlExecutor, orgId: string, fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(orgId)) throw new TenancyError("withOrg needs an org uuid");
  return db.transaction(async (tx) => {
    await tx.execute("SET LOCAL ROLE deploy_app");
    await tx.execute("SELECT set_config('deploy.org_id', $1, true)", [orgId]);
    return fn(tx);
  });
}

/**
 * Run fn as the platform operator (DP12): sees every org. Only reachable from
 * routes that policy-worker has authorised as platform-admin.
 */
export async function asPlatformAdmin<T>(db: TransactionalSqlExecutor, fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute("SET LOCAL ROLE deploy_app");
    await tx.execute("SELECT set_config('deploy.platform_admin', 'on', true)");
    return fn(tx);
  });
}

export {
  listProjects,
  listProjectsWithCounts,
  findProjectByUuid,
  insertProject,
  updateProject,
  deleteProject,
  projectHasResources,
  type DeployProjectRow,
  type DeployProjectListRow,
  type NewProject,
  type ProjectChanges,
} from "./projects.js";
export {
  listEnvironments,
  findEnvironmentByUuid,
  insertEnvironment,
  updateEnvironment,
  deleteEnvironment,
  environmentNameExists,
  environmentHasResources,
  ENVIRONMENT_RESOURCE_TABLES,
  type DeployEnvironmentRow,
  type DeployEnvironmentListRow,
  type NewEnvironment,
  type EnvironmentChanges,
} from "./environments.js";

export { loadKek, orgDek, encryptField, decryptField, isEncrypted, CryptoError, type OrgDek } from "./crypto.js";
export { ENCRYPTED_COLUMNS, isEncryptedColumn } from "./encrypted-columns.js";
export {
  listPrivateKeys,
  findPrivateKeyByUuid,
  insertPrivateKey,
  updatePrivateKey,
  deletePrivateKey,
  privateKeyFingerprintExists,
  privateKeyIsInUse,
  privateKeyUsages,
  PRIVATE_KEY_USAGE_TYPES,
  type DeployPrivateKeyRow,
  type DeployPrivateKeyWithSecretRow,
  type DeployPrivateKeyListRow,
  type NewPrivateKey,
  type PrivateKeyChanges,
  type PrivateKeyUsageType,
  type PrivateKeyUsageRow,
  type PrivateKeyUsages,
} from "./private-keys.js";
export {
  listServers,
  findServerByUuid,
  insertServer,
  updateServer,
  updateServerRole,
  forgetSshHostKey,
  setServerPrivateKey,
  deleteServer,
  serverSshEndpointInUse,
  otherBuildServerExists,
  listServerPrivateKeys,
  type DeployServerListRow,
  type DeployServerRow,
  type DeployServerPrivateKeyRow,
  type NewServer,
  type ServerChanges,
  type ServerSettingsChanges,
} from "./servers.js";
export {
  findServerSettings,
  updateServerSettings,
  orgUsesSwarm,
  SERVER_SETTINGS_PAGE_COLUMNS,
  type DeployServerSettingsRow,
  type ServerSettingsPageColumn,
  type ServerSettingsPageChanges,
} from "./server-settings.js";
export {
  listUsableServers,
  listUsableServerDestinations,
  listServerDestinations,
  findDestinationByUuid,
  destinationNetworkExists,
  insertDestination,
  updateDestinationName,
  deleteDestination,
  deleteServerDestinations,
  destinationIsAttached,
  listDestinationResources,
  DESTINATION_TYPES,
  DESTINATION_MORPH_CLASS,
  DEFAULT_STANDALONE_DESTINATION,
  type DestinationType,
  type DeployDestinationRow,
  type DeployUsableServerRow,
  type DeployDestinationResourceRow,
  type NewDestination,
} from "./destinations.js";
export {
  listCloudProviderTokens,
  findCloudProviderTokenByUuid,
  findCloudProviderTokenById,
  insertCloudProviderToken,
  updateCloudProviderToken,
  deleteCloudProviderToken,
  cloudProviderTokenServerCount,
  findServerCloud,
  setServerCloudProviderToken,
  type DeployCloudProviderTokenRow,
  type DeployCloudProviderTokenWithSecretRow,
  type NewCloudProviderToken,
  type CloudProviderTokenChanges,
  type DeployServerCloudRow,
} from "./cloud-tokens.js";
export {
  listCloudInitScripts,
  findCloudInitScriptByUuid,
  insertCloudInitScript,
  updateCloudInitScript,
  deleteCloudInitScript,
  type DeployCloudInitScriptRow,
  type DeployCloudInitScriptWithSecretRow,
  type NewCloudInitScript,
  type CloudInitScriptChanges,
} from "./cloud-init-scripts.js";
export {
  listRegistryServers,
  listServerImageUsers,
  listBuildServerApplications,
  type DeployRegistryServerRow,
  type DeployRegistryUserRow,
} from "./registries.js";
export {
  findServerCaCertificate,
  deleteSslCertificates,
  insertSslCertificate,
  updateSslCertificateContent,
  type DeploySslCertificateRow,
  type DeploySslCertificateWithSecretRow,
  type NewSslCertificate,
  type SslCertificateOwner,
} from "./ssl-certificates.js";
export {
  findApplicationByUuid,
  listEnvironmentApplications,
  insertDockerImageApplication,
  updateApplicationGeneral,
  listApplicationDomains,
  listResourceServers,
  APPLICATION_WEBHOOK_SECRET_COLUMNS,
  APPLICATION_GENERAL_COLUMNS,
  type DeployApplicationRow,
  type DeployApplicationDomainsRow,
  type DeployResourceServerRow,
  type NewDockerImageApplication,
  type ApplicationWebhookSecretColumn,
  type ApplicationGeneralColumn,
  type ApplicationGeneralChanges,
} from "./applications.js";
export {
  listSharedVariables,
  findSharedVariableById,
  findSharedVariableByKey,
  insertSharedVariable,
  updateSharedVariable,
  deleteSharedVariable,
  deleteSharedVariablesExcept,
  listSharedVariablesOverview,
  listSharedVariableProjects,
  listSharedVariableEnvironments,
  findSharedVariableEnvironment,
  listSharedVariableServers,
  SHARED_VARIABLE_SCOPES,
  type SharedVariableScope,
  type SharedVariableOwner,
  type DeploySharedVariableRow,
  type DeploySharedVariableWithSecretRow,
  type NewSharedVariable,
  type SharedVariableChanges,
  type DeploySharedVariableOverviewRow,
  type DeploySharedVariableProjectRow,
  type DeploySharedVariableEnvironmentRow,
  type DeploySharedVariableServerRow,
} from "./shared-variables.js";
export {
  findApplicationConfiguration,
  updateApplicationConfiguration,
  updateApplicationSettings,
  listServerApplicationContainerNames,
  APPLICATION_CONFIGURATION_COLUMNS,
  APPLICATION_SETTINGS_PAGE_COLUMNS,
  type DeployApplicationConfigurationRow,
  type DeployApplicationContainerNamesRow,
  type ApplicationConfigurationColumn,
  type ApplicationConfigurationChanges,
  type ApplicationSettingsPageColumn,
  type ApplicationSettingsChanges,
} from "./application-settings.js";
