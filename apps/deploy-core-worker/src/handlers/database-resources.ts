// Derived from coollabsio/coolify@91b7e3e:routes/web.php (project.database.environment-variables,
// persistent-storage, webhooks, resource-limits, resource-operations, tags, danger),
// app/Livewire/Project/Database/Configuration.php and its view, app/Livewire/Project/Shared/
// {EnvironmentVariable/All,Tags,ResourceOperations,ResourceLimits,Webhooks,Danger}.php,
// app/Livewire/Project/Service/{Storage,FileStorage}.php, app/Livewire/Project/Shared/Storages/All.php and
// app/Policies/DatabasePolicy.php (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/databases/{uuid}/… — the pages of a
// standalone database that are Coolify's shared components with the database
// as their resource. Dispatched by handleDatabases (databases.ts):
//
//   …/environment-variables[/…]            the Environment Variables page: handleEnvironmentVariables with the
//                                          database's type ('standalone-postgresql', …), every route of it
//   GET    /storages                       Storage: the volume, file and directory mounts
//   POST   /storages                       one of the "Add mount" forms, named by `type`
//   PATCH  /storages/volumes/{id}          All::submit
//   DELETE /storages/volumes/{id}          All::delete (?deleteDockerVolume=true needs SSH: 501)
//   PATCH  /storages/files/{id}            FileStorage, by `action`
//   DELETE /storages/files/{id}            FileStorage::delete (?permanently_delete=true needs SSH: 501)
//   GET    /tags                           Tags
//   POST   /tags                           Tags::submit { newTags }
//   POST   /tags/{id}                      Tags::addTag
//   DELETE /tags/{id}                      Tags::deleteTag
//   GET    /resource-operations            ResourceOperations: where it can be cloned and moved to
//   POST   /resource-operations/clone      cloneTo { destination_uuid, environment_uuid, cloneVolumeData }
//   POST   /resource-operations/move       moveTo { environment_uuid }
//   GET    /resource-limits                ResourceLimits
//   PATCH  /resource-limits                ResourceLimits::submit
//   GET    /webhooks                       Webhooks: the deploy webhook
//   GET    /danger                         Danger (the delete is DELETE /databases/{uuid}, databases.ts)
//   POST   /danger/flush                   Danger::flush (Redis, KeyDB, Dragonfly): needs SSH, 501
//   GET    /healthcheck                    Database\Health (DP-97)
//   PATCH  /healthcheck                    Health::submit { healthCheckEnabled, healthCheckInterval, healthCheckTimeout,
//                                          healthCheckRetries, healthCheckStartPeriod }
//   POST   /healthcheck/toggle             Health::toggleHealthcheck (the form's values, the switch flipped)
//
// Coolify's policy: view to read, update (and manage, manageEnvironment) to
// write. Here: deploy.resource.read and deploy.resource.write; a denial
// answers 404 (never leaks).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  findDatabaseEngineByUuid,
  DATABASE_TABLES,
  databaseOwner,
  databaseEnvironmentVariableResourceType,
  listPersistentVolumes,
  findPersistentVolume,
  insertPersistentVolume,
  updatePersistentVolume,
  deletePersistentVolume,
  listFileVolumes,
  findFileVolume,
  insertFileVolume,
  updateFileVolume,
  deleteFileVolume,
  listTags,
  listResourceTags,
  findTagByName,
  findTagById,
  insertTag,
  resourceHasTag,
  attachTag,
  detachTag,
  copyResourceTags,
  listOperationEnvironments,
  listOperationServers,
  listOperationDestinations,
  findOperationEnvironment,
  findDestinationByUuid,
  findServerByUuid,
  moveDatabase,
  replicateDatabase,
  replicatePersistentVolume,
  replicateFileVolume,
  listDatabaseBackupScheduleIds,
  replicateDatabaseBackupSchedule,
  listDatabaseEnvironmentVariableIds,
  replicateDatabaseEnvironmentVariable,
  findDatabaseLimits,
  updateDatabaseLimits,
  findDatabaseHealth,
  updateDatabaseHealth,
  type StorageOwner,
} from "@saas/db/deploy";
import { saveDatabaseHealth, showDatabaseHealth } from "../databases/health.js";
import { errorResponse, methodNotAllowed, successResponse, validationError } from "../http.js";
import type { KeyCipher } from "../private-keys/service.js";
import { authorizeDeploy, columnCipher, readJson } from "./cloud-tokens.js";
import { sqlStore as databaseSqlStore } from "./databases.js";
import { handleEnvironmentVariables, type EnvironmentVariableRunner } from "./environment-variables.js";
import { sharedResourcePageOp, type ResourcePageOp } from "./application-resources.js";
import type { ResourceRowsStore } from "../applications/resources.js";
import { SettingsError, SettingsFieldErrors } from "../applications/settings.js";
import { DatabaseError, DatabaseFieldErrors } from "../databases/service.js";
import {
  cloneDatabaseTo,
  databaseResources,
  flushDatabase,
  moveDatabaseTo,
  saveDatabaseLimits,
  showDatabaseLimits,
  showDatabaseWebhooks,
  type DatabaseResourcesContext,
  type DatabaseResourcesStore,
} from "../databases/resources.js";

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

/** The pages below a database that this handler serves (the first segment after its uuid). */
export const DATABASE_RESOURCE_PAGES = ["environment-variables", "storages", "tags", "resource-operations", "resource-limits", "webhooks", "danger", "healthcheck"] as const;

/** Whether handleDatabaseResources serves the route. segments: what follows /databases, split on "/". */
export const isDatabaseResourceRoute = (segments: string[]): boolean => segments.length >= 2 && (DATABASE_RESOURCE_PAGES as readonly string[]).includes(segments[1]!);

/**
 * Runs fn with one org's database (found by uuid: its engine binds the rows to
 * its morph class), in one transaction confined to that org.
 */
export type DatabaseResourcesRunner = <T>(env: Env, orgId: string, uuid: string, fn: (ctx: DatabaseResourcesContext) => Promise<T>) => Promise<T>;

/** One resource's volumes, mounts and tags in SQL: every row is the owner's (its morph class and id). */
export function resourceRowsSqlStore(tx: SqlExecutor, orgId: string, type: string): ResourceRowsStore {
  const owner = (id: string | number): StorageOwner => ({ type, id });
  return {
    volumes: (id) => listPersistentVolumes(tx, owner(id)),
    findVolume: (id, volumeId) => findPersistentVolume(tx, owner(id), volumeId),
    insertVolume: (v) => insertPersistentVolume(tx, { orgId, owner: owner(v.resourceId), uuid: v.uuid, name: v.name, mountPath: v.mountPath, hostPath: null }),
    updateVolume: (id, volumeId, changes) => updatePersistentVolume(tx, owner(id), volumeId, changes),
    deleteVolume: (id, volumeId) => deletePersistentVolume(tx, owner(id), volumeId),
    files: (id) => listFileVolumes(tx, owner(id)),
    findFile: (id, fileId) => findFileVolume(tx, owner(id), fileId),
    insertFile: (f) => insertFileVolume(tx, { orgId, owner: owner(f.resourceId), uuid: f.uuid, fsPath: f.fsPath, mountPath: f.mountPath, content: f.content, isDirectory: f.isDirectory, isHostFile: f.isHostFile }),
    updateFile: (id, fileId, changes) => updateFileVolume(tx, owner(id), fileId, changes),
    deleteFile: (id, fileId) => deleteFileVolume(tx, owner(id), fileId),
    tags: () => listTags(tx),
    resourceTags: (id) => listResourceTags(tx, owner(id)),
    findTagByName: (name) => findTagByName(tx, name),
    findTagById: (id) => findTagById(tx, id),
    insertTag: (tag) => insertTag(tx, { orgId, ...tag }),
    hasTag: (id, tagId) => resourceHasTag(tx, owner(id), tagId),
    attachTag: (id, tagId) => attachTag(tx, orgId, owner(id), tagId),
    detachTag: (id, tagId) => detachTag(tx, owner(id), tagId),
    operationEnvironments: () => listOperationEnvironments(tx),
    operationServers: () => listOperationServers(tx),
    operationDestinations: () => listOperationDestinations(tx),
  };
}

function sqlStore(tx: SqlExecutor): DatabaseResourcesStore {
  return {
    findEnvironment: (uuid) => findOperationEnvironment(tx, uuid),
    findDestination: (uuid) => findDestinationByUuid(tx, uuid),
    findServer: (uuid) => findServerByUuid(tx, uuid),
    move: (engine, id, environmentId) => moveDatabase(tx, engine, id, environmentId),
    replicate: (engine, sourceId, replica) => replicateDatabase(tx, engine, sourceId, replica),
    copyTags: (engine, sourceId, cloneId) => copyResourceTags(tx, databaseOwner(engine, sourceId), databaseOwner(engine, cloneId)),
    replicateVolume: (volumeId, replica) => replicatePersistentVolume(tx, volumeId, replica),
    replicateFile: (fileId, replica) => replicateFileVolume(tx, fileId, replica),
    backupScheduleIds: (engine, id) => listDatabaseBackupScheduleIds(tx, engine, id),
    replicateBackupSchedule: (scheduleId, replica) => replicateDatabaseBackupSchedule(tx, scheduleId, replica),
    environmentVariableIds: (engine, id) => listDatabaseEnvironmentVariableIds(tx, engine, id),
    replicateEnvironmentVariable: (variableId, replica) => replicateDatabaseEnvironmentVariable(tx, variableId, replica),
    limits: (engine, id) => findDatabaseLimits(tx, engine, id),
    updateLimits: (engine, id, changes) => updateDatabaseLimits(tx, engine, id, changes),
  };
}

export const runDatabaseResourcesInOrg: DatabaseResourcesRunner = async (env, orgId, uuid, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, async (tx) => fn(await databaseResourcesContext(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, uuid)));
  } finally {
    await db.dispose();
  }
};

/** The context of one org's database inside the caller's org transaction (the API's clone, DP-86). */
export async function databaseResourcesContext(tx: SqlExecutor, orgId: string, secret: string | undefined, uuid: string): Promise<DatabaseResourcesContext> {
  const ciphers = new Map<string, KeyCipher>();
  const cipher = (column: string): KeyCipher => {
    let found = ciphers.get(column);
    if (!found) ciphers.set(column, (found = columnCipher(tx, orgId, secret, column)));
    return found;
  };
  // The rows are bound to the engine's morph class; a database that is not the org's has none (the loader answers null).
  const engine = await findDatabaseEngineByUuid(tx, uuid);
  return {
    database: { store: databaseSqlStore(tx, orgId), cipher },
    rows: resourceRowsSqlStore(tx, orgId, engine ? DATABASE_TABLES[engine].morphClass : ""),
    content: cipher("local_file_volumes.content"),
    store: sqlStore(tx),
    health: { find: (engine, id) => findDatabaseHealth(tx, engine, id), update: (engine, id, changes) => updateDatabaseHealth(tx, engine, id, changes) },
  };
}

function failure(e: unknown, requestId: string): Response {
  if (e instanceof SettingsFieldErrors) return validationError(requestId, e.fields);
  if (e instanceof DatabaseFieldErrors) return validationError(requestId, e.fields);
  if (e instanceof SettingsError || e instanceof DatabaseError) {
    const code = e.status === 501 ? "unsupported" : e.status === 409 ? "conflict" : e.status === 404 ? "not_found" : "validation_failed";
    return errorResponse(code, e.message, e.status, requestId, e instanceof SettingsError ? (e.details ?? undefined) : undefined);
  }
  return errorResponse("internal_error", "Service unavailable", 503, requestId);
}

/**
 * segments: what follows /databases, split on "/" — [uuid, page, …].
 * `runner` and `variablesRunner` are replaceable for tests.
 */
export async function handleDatabaseResources(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segments: string[],
  request: Request,
  runner: DatabaseResourcesRunner = runDatabaseResourcesInOrg,
  variablesRunner?: EnvironmentVariableRunner,
): Promise<Response> {
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  const [uuid, section, third] = segments;
  const method = request.method;
  if (!uuid || !UUID_RE.test(uuid) || !isDatabaseResourceRoute(segments) || segments.length > 4) return notFound();

  if (section === "environment-variables") {
    // The page is the application's, with the database's type: its engine decides its morph class.
    const engine = await runner(env, orgId, uuid, async (c) => (await c.database.store.findByUuid(uuid))?.engine ?? null).catch(() => undefined);
    if (engine === undefined) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    if (engine === null) return notFound();
    return handleEnvironmentVariables(env, requestId, actor, orgId, { type: databaseEnvironmentVariableResourceType(engine), uuid }, segments.slice(2), request, variablesRunner);
  }

  const query = new URL(request.url).searchParams;
  type Body = Record<string, unknown>;
  const run = <T>(fn: (ctx: DatabaseResourcesContext) => Promise<T>): Promise<T> => runner(env, orgId, uuid, fn);
  const read = (show: (ctx: DatabaseResourcesContext, canWrite: boolean) => Promise<object | null>): ResourcePageOp | null =>
    method === "GET" ? { write: false, run: (w) => run((c) => show(c, w)) } : null;
  const write = (on: string, save: (ctx: DatabaseResourcesContext, body: Body) => Promise<object | null>, status = 200): ResourcePageOp | null =>
    method === on ? { write: true, status, run: (_w, body) => run((c) => save(c, body)) } : null;
  const depth = segments.length;

  let op: ResourcePageOp | null | undefined;
  if (section === "resource-operations" && depth === 3 && third === "clone") op = write("POST", (c, body) => cloneDatabaseTo(c, uuid, body), 201);
  else if (section === "resource-operations" && depth === 3 && third === "move") op = write("POST", (c, body) => moveDatabaseTo(c, uuid, body));
  else if (section === "resource-limits" && depth === 2) op = read((c, w) => showDatabaseLimits(c, uuid, w)) ?? write("PATCH", (c, body) => saveDatabaseLimits(c, uuid, body));
  else if (section === "webhooks" && depth === 2) op = read((c, w) => showDatabaseWebhooks(c, uuid, w));
  // Database\Health (DP-97): submit / instantSave, and toggleHealthcheck.
  else if (section === "healthcheck" && depth === 2) op = read((c, w) => showDatabaseHealth(c, uuid, w)) ?? write("PATCH", (c, body) => saveDatabaseHealth(c, uuid, body));
  else if (section === "healthcheck" && depth === 3 && third === "toggle") op = write("POST", (c, body) => saveDatabaseHealth(c, uuid, body, true));
  // @can('manage', $resource)
  else if (section === "danger" && depth === 3 && third === "flush") op = write("POST", (c) => flushDatabase(c, uuid));
  else op = sharedResourcePageOp(segments, method, query, (fn) => run((c) => fn(databaseResources(c))));
  if (op === undefined) return notFound();
  if (op === null) return methodNotAllowed(requestId);

  // $this->authorize('view' | 'update' | 'manage', $database)
  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;
  try {
    const data = await op.run(auth.canWrite, method === "POST" || method === "PATCH" ? await readJson(request) : {});
    if (!data) return notFound();
    // The views' @can('update' | 'manage' | 'delete', $database).
    return successResponse(op.write ? data : { ...data, canUpdate: auth.canWrite, canManage: auth.canWrite, canDelete: auth.canWrite }, requestId, op.status ?? 200);
  } catch (e) {
    return failure(e, requestId);
  }
}
