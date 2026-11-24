// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/{Configuration,Source,Rollback}.php,
// app/Livewire/Project/Shared/{Destination,Webhooks}.php,
// app/Livewire/Project/Shared/ScheduledTask/{All,Add,Show,Executions}.php and app/Policies/ApplicationPolicy.php
// (view, update, deploy, delete) (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/applications/{uuid}… — an application's Git
// Source, Servers, Webhooks, Scheduled Tasks and Rollback pages. Dispatched by
// handleApplications (applications.ts):
//
//   GET    /source                          Source: repository, host keys, credentials, deploy key, Git source
//   PATCH  /source                          Source::submit { gitRepository, gitBranch, gitCommitSha, gitSshKnownHosts,
//                                           loadedGitSshKnownHosts, gitHttpsUsername, gitHttpsPassword }
//   POST   /source/private-key              setPrivateKey { privateKeyId }
//   POST   /source/change                   changeSource { sourceId, sourceType }
//   DELETE /source/https-credentials        removeGitHttpsCredential
//   POST   /source/host-keys/fetch          fetchHostKeys (needs SSH: 501)
//   DELETE /source/host-keys/{id}           removeHostKey
//   GET    /servers                         Destination: the primary, the additional and the available servers
//   POST   /servers                         addServer { network_id, server_id }
//   POST   /servers/stop                    stop { server_id } (needs SSH: 501)
//   POST   /servers/{network_id}/promote    promote { server_id }
//   POST   /servers/{network_id}/redeploy   redeploy { server_id } (needs SSH: 501)
//   DELETE /servers/{network_id}?server_id= removeServer
//   GET    /webhooks                        Webhooks: the URLs' paths and, for who may update, the secrets
//   PATCH  /webhooks                        Webhooks::submit { githubManualWebhookSecret, … }
//   POST   /webhooks/{provider}/generate    generateSecret
//   GET    /scheduled-tasks                 ScheduledTask\All
//   POST   /scheduled-tasks                 Add::submit { name, command, frequency, container, timeout, useShell }
//   GET    /scheduled-tasks/{task_uuid}     Show + Executions
//   PATCH  /scheduled-tasks/{task_uuid}     Show::submit { isEnabled, name, command, frequency, container, timeout, useShell }
//   DELETE /scheduled-tasks/{task_uuid}     Show::delete
//   POST   /scheduled-tasks/{task_uuid}/toggle   toggleEnabled
//   POST   /scheduled-tasks/{task_uuid}/execute  executeNow (needs SSH: 501)
//   GET    /rollback                        Rollback: the setting; the images are not available
//   PATCH  /rollback                        saveSettings { dockerImagesToKeep }
//   POST   /rollback/images                 loadImages (needs SSH: 501)
//   POST   /rollback/rollback               rollbackImage { commit } (needs SSH: 501)
//
// Coolify's policy: view to read; update, deploy and delete to write. Here:
// deploy.resource.read and deploy.resource.write; a denial answers 404 (never
// leaks).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  findApplicationByUuid,
  findApplicationConfiguration,
  findApplicationSource,
  updateApplicationSource,
  listDeployKeys,
  findDeployKey,
  listGitSources,
  findGitSource,
  listAdditionalDestinations,
  listServerNetworks,
  findDestinationServer,
  findServerNetwork,
  additionalDestinationExists,
  attachAdditionalDestination,
  detachAdditionalDestination,
  promoteAdditionalDestination,
  listPersistentVolumes,
  applicationHasDeployments,
  listScheduledTasks,
  findScheduledTask,
  insertScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  listScheduledTaskExecutions,
  findApplicationRollback,
  updateApplicationImagesToKeep,
  APPLICATION_MORPH_CLASS,
  type ScheduledTaskOwner,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse, validationError } from "../http.js";
import type { KeyCipher } from "../private-keys/service.js";
import { authorizeDeploy, columnCipher, readJson } from "./cloud-tokens.js";
import { SettingsError, SettingsFieldErrors } from "../applications/settings.js";
import { rowId } from "../applications/resources.js";
import { MORE_SECRET_COLUMNS, type ApplicationMoreContext, type ApplicationMoreStore, type MoreSecretColumn } from "../applications/more.js";
import { changeSource, fetchHostKeys, removeHostKey, removeHttpsCredentials, saveSource, setPrivateKey, showSource } from "../applications/source.js";
import { addServer, promoteServer, redeployOnServer, removeServer, showServers, stopOnServer } from "../applications/additional-servers.js";
import { generateWebhookSecret, saveWebhookSecrets, showWebhooks } from "../applications/webhooks.js";
import {
  addScheduledTask,
  deleteScheduledTask as removeScheduledTask,
  executeScheduledTask,
  showScheduledTask,
  showScheduledTasks,
  toggleScheduledTask,
  updateScheduledTask as saveScheduledTask,
} from "../applications/scheduled-tasks.js";
import { loadRollbackImages, rollbackToImage, saveRollback, showRollback } from "../applications/rollback.js";

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

export const APPLICATION_MORE_PAGES = ["source", "servers", "webhooks", "scheduled-tasks", "rollback"] as const;
export type ApplicationMorePage = (typeof APPLICATION_MORE_PAGES)[number];

/** Whether handleApplicationMore serves the route: one of the five pages of an application, with what is below it. segments: what follows /applications. */
export function isApplicationMoreRoute(segments: string[]): boolean {
  return segments.length >= 2 && (APPLICATION_MORE_PAGES as readonly string[]).includes(segments[1]!);
}

/** Runs fn with one org's store and the ciphers of the encrypted columns, in one transaction confined to that org. */
export type ApplicationMoreRunner = <T>(env: Env, orgId: string, fn: (ctx: ApplicationMoreContext) => Promise<T>) => Promise<T>;

function sqlStore(tx: SqlExecutor, orgId: string): ApplicationMoreStore {
  const owner = (id: string | number): ScheduledTaskOwner => ({ kind: "application", id });
  return {
    findByUuid: (uuid) => findApplicationByUuid(tx, uuid),
    configuration: (uuid) => findApplicationConfiguration(tx, uuid),
    source: (uuid) => findApplicationSource(tx, uuid),
    updateSource: (applicationId, changes) => updateApplicationSource(tx, applicationId, changes),
    deployKeys: () => listDeployKeys(tx),
    findDeployKey: (id) => findDeployKey(tx, id),
    gitSources: () => listGitSources(tx),
    findGitSource: (kind, id) => findGitSource(tx, kind, id),
    additionalDestinations: (applicationId) => listAdditionalDestinations(tx, applicationId),
    serverNetworks: () => listServerNetworks(tx),
    findServer: (serverId) => findDestinationServer(tx, serverId),
    findNetwork: (serverId, networkId) => findServerNetwork(tx, serverId, networkId),
    hasAdditionalDestination: (applicationId, serverId, networkId) => additionalDestinationExists(tx, applicationId, serverId, networkId),
    attachDestination: (applicationId, serverId, networkId) => attachAdditionalDestination(tx, orgId, applicationId, serverId, networkId),
    detachDestination: (applicationId, serverId, networkId) => detachAdditionalDestination(tx, applicationId, serverId, networkId),
    promoteDestination: (applicationId, promoted, main) => promoteAdditionalDestination(tx, orgId, applicationId, promoted, main),
    volumeCount: async (applicationId) => (await listPersistentVolumes(tx, { type: APPLICATION_MORPH_CLASS, id: applicationId })).length,
    hasDeployments: (applicationId) => applicationHasDeployments(tx, applicationId),
    tasks: (applicationId) => listScheduledTasks(tx, owner(applicationId)),
    findTask: (applicationId, uuid) => findScheduledTask(tx, owner(applicationId), uuid),
    insertTask: (t) => insertScheduledTask(tx, { orgId, owner: owner(t.applicationId), uuid: t.uuid, name: t.name, command: t.command, frequency: t.frequency, container: t.container, timeout: t.timeout, useShell: t.useShell }),
    updateTask: (applicationId, id, changes) => updateScheduledTask(tx, owner(applicationId), id, changes),
    deleteTask: (applicationId, id) => deleteScheduledTask(tx, owner(applicationId), id),
    executions: (taskId) => listScheduledTaskExecutions(tx, taskId),
    rollback: (uuid) => findApplicationRollback(tx, uuid),
    updateImagesToKeep: (applicationId, n) => updateApplicationImagesToKeep(tx, applicationId, n),
  };
}

export const runApplicationMoreInOrg: ApplicationMoreRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => {
      // One cipher per encrypted column: the value is bound to "applications.<column>".
      const ciphers = Object.fromEntries(MORE_SECRET_COLUMNS.map((c) => [c, columnCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, `applications.${c}`)])) as Record<MoreSecretColumn, KeyCipher>;
      return fn({ store: sqlStore(tx, orgId), secret: (column) => ciphers[column] });
    });
  } finally {
    await db.dispose();
  }
};

function failure(e: unknown, requestId: string): Response {
  if (e instanceof SettingsFieldErrors) return validationError(requestId, e.fields);
  if (e instanceof SettingsError) {
    const code = e.status === 501 ? "unsupported" : e.status === 409 ? "conflict" : e.status === 404 ? "not_found" : "validation_failed";
    return errorResponse(code, e.message, e.status, requestId, e.details ?? undefined);
  }
  return errorResponse("internal_error", "Service unavailable", 503, requestId);
}

/** segments: what follows /applications, split on "/": [uuid, page, …]. `runner` is replaceable for tests. */
export async function handleApplicationMore(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segments: string[],
  request: Request,
  runner: ApplicationMoreRunner = runApplicationMoreInOrg,
): Promise<Response> {
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  const [uuid, section, third, fourth] = segments;
  const method = request.method;
  if (!uuid || !UUID_RE.test(uuid) || !isApplicationMoreRoute(segments) || segments.length > 4) return notFound();
  const query = new URL(request.url).searchParams;
  type Run = <T>(fn: (ctx: ApplicationMoreContext) => Promise<T>) => Promise<T>;
  const run: Run = (fn) => runner(env, orgId, fn);

  type Body = Record<string, unknown>;
  /** What the route does once authorized, or null for a method it does not have; undefined for a path that does not exist. */
  let op: { write: boolean; status?: number; run: (canWrite: boolean, body: Body) => Promise<object | null> } | null | undefined;
  const depth = segments.length;
  const read = (show: (ctx: ApplicationMoreContext, canWrite: boolean) => Promise<object | null>): typeof op => (method === "GET" ? { write: false, run: (w) => run((c) => show(c, w)) } : null);
  const write = (on: string, save: (ctx: ApplicationMoreContext, body: Body) => Promise<object | null>, status = 200): typeof op =>
    method === on ? { write: true, status, run: (_w, body) => run((c) => save(c, body)) } : null;

  if (section === "source") {
    if (depth === 2) op = read((c, w) => showSource(c, uuid, w)) ?? write("PATCH", (c, body) => saveSource(c, uuid, body));
    else if (depth === 3 && third === "private-key") op = write("POST", (c, body) => setPrivateKey(c, uuid, body));
    else if (depth === 3 && third === "change") op = write("POST", (c, body) => changeSource(c, uuid, body));
    else if (depth === 3 && third === "https-credentials") op = write("DELETE", (c) => removeHttpsCredentials(c, uuid));
    else if (depth === 4 && third === "host-keys" && fourth === "fetch") op = write("POST", (c) => fetchHostKeys(c, uuid));
    // A saved host key is named by the sha1 of its line.
    else if (depth === 4 && third === "host-keys" && /^[0-9a-f]{40}$/.test(fourth!)) op = write("DELETE", (c) => removeHostKey(c, uuid, fourth!));
  } else if (section === "servers") {
    const networkId = rowId(third);
    if (depth === 2) op = read((c, w) => showServers(c, uuid, w)) ?? write("POST", (c, body) => addServer(c, uuid, body));
    // @can('deploy', $resource)
    else if (depth === 3 && third === "stop") op = write("POST", (c, body) => stopOnServer(c, uuid, body));
    else if (depth === 3 && networkId !== null) op = write("DELETE", (c) => removeServer(c, uuid, networkId, query.get("server_id")));
    else if (depth === 4 && networkId !== null && fourth === "promote") op = write("POST", (c, body) => promoteServer(c, uuid, networkId, body));
    else if (depth === 4 && networkId !== null && fourth === "redeploy") op = write("POST", (c, body) => redeployOnServer(c, uuid, networkId, body));
  } else if (section === "webhooks") {
    if (depth === 2) op = read((c, w) => showWebhooks(c, uuid, w)) ?? write("PATCH", (c, body) => saveWebhookSecrets(c, uuid, body));
    else if (depth === 4 && fourth === "generate") op = write("POST", (c) => generateWebhookSecret(c, uuid, third!));
  } else if (section === "scheduled-tasks") {
    const task = third !== undefined && UUID_RE.test(third) ? third : null;
    if (depth === 2) op = read((c, w) => showScheduledTasks(c, uuid, w)) ?? write("POST", (c, body) => addScheduledTask(c, uuid, body), 201);
    else if (depth === 3 && task) {
      op = read((c, w) => showScheduledTask(c, uuid, task, w)) ?? write("PATCH", (c, body) => saveScheduledTask(c, uuid, task, body)) ?? write("DELETE", (c) => removeScheduledTask(c, uuid, task));
    } else if (depth === 4 && task && fourth === "toggle") op = write("POST", (c) => toggleScheduledTask(c, uuid, task));
    else if (depth === 4 && task && fourth === "execute") op = write("POST", (c) => executeScheduledTask(c, uuid, task));
  } else if (section === "rollback") {
    if (depth === 2) op = read((c, w) => showRollback(c, uuid, w)) ?? write("PATCH", (c, body) => saveRollback(c, uuid, body));
    // loadImages() asks only for 'view'.
    else if (depth === 3 && third === "images") op = method === "POST" ? { write: false, run: () => run((c) => loadRollbackImages(c, uuid)) } : null;
    else if (depth === 3 && third === "rollback") op = write("POST", (c) => rollbackToImage(c, uuid));
  }
  if (op === undefined) return notFound();
  if (op === null) return methodNotAllowed(requestId);

  // $this->authorize('view' | 'update' | 'deploy' | 'delete', $application)
  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;
  try {
    const data = await op.run(auth.canWrite, method === "POST" || method === "PATCH" ? await readJson(request) : {});
    if (!data) return notFound();
    // The views' @can('update' | 'deploy', $application).
    return successResponse(op.write ? data : { ...data, canUpdate: auth.canWrite, canDeploy: auth.canWrite }, requestId, op.status ?? 200);
  } catch (e) {
    return failure(e, requestId);
  }
}
