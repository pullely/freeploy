// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/Configuration.php,
// app/Livewire/Project/Service/{Storage,FileStorage}.php, app/Livewire/Project/Shared/Storages/All.php,
// app/Livewire/Project/Shared/{Tags,ResourceOperations,Danger}.php and app/Policies/ApplicationPolicy.php
// (view, update, delete) (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/applications/{uuid}… — an application's
// Persistent Storage, Tags, Resource Operations and Danger Zone pages.
// Dispatched by handleApplications (applications.ts):
//
//   GET    /storages                       Storage: the volume, file and directory mounts
//   POST   /storages                       one of the "Add mount" forms, named by `type`:
//                                            volume     submitPersistentVolume { name, mount_path }
//                                            file       submitFileStorage { file_storage_path, file_storage_source, file_storage_content }
//                                            host-file  submitHostFileStorage { host_file_storage_source, host_file_storage_destination }
//                                            directory  submitFileStorageDirectory { file_storage_directory_source, file_storage_directory_destination }
//   PATCH  /storages/volumes/{id}          All::submit { name, mountPath, isPreviewSuffixEnabled, renameConfirmed }
//   DELETE /storages/volumes/{id}          All::delete (?deleteDockerVolume=true needs SSH: 501)
//   PATCH  /storages/files/{id}            FileStorage, by `action`: save, instantSave { content, isBasedOnGit,
//                                          isPreviewSuffixEnabled }, convertToDirectory, convertToFile, loadFromServer
//   DELETE /storages/files/{id}            FileStorage::delete (?permanently_delete=true needs SSH: 501)
//   GET    /tags                           Tags: the application's tags and the org's other tags
//   POST   /tags                           Tags::submit { newTags }
//   POST   /tags/{id}                      Tags::addTag
//   DELETE /tags/{id}                      Tags::deleteTag
//   GET    /resource-operations            ResourceOperations: where it can be cloned and moved to
//   POST   /resource-operations/clone      cloneTo { destination_uuid, environment_uuid, cloneVolumeData }
//   POST   /resource-operations/move       moveTo { environment_uuid }
//   GET    /danger                         Danger
//   DELETE (the application itself)        Danger::delete, with Coolify's query fields: delete_volumes,
//                                          delete_connected_networks, delete_configurations, docker_cleanup, delete_backups
//
// Coolify's policy: view to read, update to write, delete to delete. Here:
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
  moveApplication,
  replicateApplication,
  replicateApplicationSettings,
  listApplicationScheduledTaskIds,
  replicateScheduledTask,
  replicatePersistentVolume,
  replicateFileVolume,
  listApplicationEnvironmentVariableIds,
  replicateEnvironmentVariable,
  applicationHasDeployments,
  deleteApplication,
  APPLICATION_MORPH_CLASS,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse, validationError } from "../http.js";
import { authorizeDeploy, columnCipher, readJson } from "./cloud-tokens.js";
import { labelSqlContext } from "./application-labels.js";
import { resetDefaultLabels } from "../applications/labels-service.js";
import { SettingsError, SettingsFieldErrors } from "../applications/settings.js";
import { applicationResources, rowId, type ApplicationResourcesContext, type ApplicationResourcesStore, type ResourcesContext } from "../applications/resources.js";
import { addStorage, deleteFile, deleteVolume, showStorages, updateFile, updateVolume } from "../applications/storages.js";
import { addTag, addTags, removeTag, showTags } from "../applications/tags.js";
import { cloneApplicationTo, moveApplicationTo, showResourceOperations } from "../applications/resource-operations.js";
import { deleteApplicationNow, deleteOptions, showDanger } from "../applications/danger.js";

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

export const APPLICATION_RESOURCE_PAGES = ["storages", "tags", "resource-operations", "danger"] as const;
export type ApplicationResourcePage = (typeof APPLICATION_RESOURCE_PAGES)[number];

/**
 * Whether handleApplicationResources serves the route: one of the four pages
 * of an application (with what is below it), or the application's DELETE.
 * segments: what follows /applications, split on "/".
 */
export function isApplicationResourceRoute(segments: string[], method: string): boolean {
  if (segments.length === 1) return method === "DELETE";
  return segments.length >= 2 && (APPLICATION_RESOURCE_PAGES as readonly string[]).includes(segments[1]!);
}

/** Runs fn with one org's store and the file content's cipher, in one transaction confined to that org. */
export type ApplicationResourcesRunner = <T>(env: Env, orgId: string, fn: (ctx: ApplicationResourcesContext) => Promise<T>) => Promise<T>;

function sqlStore(tx: SqlExecutor, orgId: string): ApplicationResourcesStore {
  const app = (id: string | number) => ({ type: APPLICATION_MORPH_CLASS, id });
  return {
    findByUuid: (uuid) => findApplicationByUuid(tx, uuid),
    configuration: (uuid) => findApplicationConfiguration(tx, uuid),
    volumes: (applicationId) => listPersistentVolumes(tx, app(applicationId)),
    findVolume: (applicationId, id) => findPersistentVolume(tx, app(applicationId), id),
    insertVolume: (v) => insertPersistentVolume(tx, { orgId, owner: app(v.applicationId), uuid: v.uuid, name: v.name, mountPath: v.mountPath, hostPath: null }),
    updateVolume: (applicationId, id, changes) => updatePersistentVolume(tx, app(applicationId), id, changes),
    deleteVolume: (applicationId, id) => deletePersistentVolume(tx, app(applicationId), id),
    files: (applicationId) => listFileVolumes(tx, app(applicationId)),
    findFile: (applicationId, id) => findFileVolume(tx, app(applicationId), id),
    insertFile: (f) => insertFileVolume(tx, { orgId, owner: app(f.applicationId), uuid: f.uuid, fsPath: f.fsPath, mountPath: f.mountPath, content: f.content, isDirectory: f.isDirectory, isHostFile: f.isHostFile }),
    updateFile: (applicationId, id, changes) => updateFileVolume(tx, app(applicationId), id, changes),
    deleteFile: (applicationId, id) => deleteFileVolume(tx, app(applicationId), id),
    tags: () => listTags(tx),
    applicationTags: (applicationId) => listResourceTags(tx, app(applicationId)),
    findTagByName: (name) => findTagByName(tx, name),
    findTagById: (id) => findTagById(tx, id),
    insertTag: (tag) => insertTag(tx, { orgId, ...tag }),
    hasTag: (applicationId, tagId) => resourceHasTag(tx, app(applicationId), tagId),
    attachTag: (applicationId, tagId) => attachTag(tx, orgId, app(applicationId), tagId),
    detachTag: (applicationId, tagId) => detachTag(tx, app(applicationId), tagId),
    operationEnvironments: () => listOperationEnvironments(tx),
    operationServers: () => listOperationServers(tx),
    operationDestinations: () => listOperationDestinations(tx),
    findEnvironment: (uuid) => findOperationEnvironment(tx, uuid),
    findDestination: (uuid) => findDestinationByUuid(tx, uuid),
    findServer: (uuid) => findServerByUuid(tx, uuid),
    move: (applicationId, environmentId) => moveApplication(tx, applicationId, environmentId),
    replicateApplication: (sourceId, replica) => replicateApplication(tx, sourceId, replica),
    replicateSettings: (sourceId, applicationId) => replicateApplicationSettings(tx, sourceId, applicationId),
    copyTags: (sourceId, applicationId) => copyResourceTags(tx, app(sourceId), app(applicationId)),
    scheduledTaskIds: (applicationId) => listApplicationScheduledTaskIds(tx, applicationId),
    replicateScheduledTask: (taskId, replica) => replicateScheduledTask(tx, taskId, replica),
    replicateVolume: (volumeId, replica) => replicatePersistentVolume(tx, volumeId, replica),
    replicateFile: (fileId, replica) => replicateFileVolume(tx, fileId, replica),
    environmentVariableIds: (applicationId) => listApplicationEnvironmentVariableIds(tx, applicationId),
    replicateEnvironmentVariable: (variableId, replica) => replicateEnvironmentVariable(tx, variableId, replica),
    hasDeployments: (applicationId) => applicationHasDeployments(tx, applicationId),
    deleteApplication: (applicationId) => deleteApplication(tx, applicationId),
  };
}

export const runApplicationResourcesInOrg: ApplicationResourcesRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    // The value is bound to "local_file_volumes.content".
    return await withOrg(db, orgId, (tx) =>
      fn({
        store: sqlStore(tx, orgId),
        content: columnCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, "local_file_volumes.content"),
        generateLabels: async (uuid) => {
          await resetDefaultLabels(labelSqlContext(tx, orgId, env.DEPLOY_ENCRYPTION_KEY), uuid);
        },
      }),
    );
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

const flag = (query: URLSearchParams, name: string): boolean => ["1", "true", "on", "yes"].includes((query.get(name) ?? "").trim().toLowerCase());

type Body = Record<string, unknown>;
/** What a route does once authorized: the answer's data, or null when the resource is not the org's. */
export interface ResourcePageOp {
  write: boolean;
  status?: number;
  run: (canWrite: boolean, body: Body) => Promise<object | null>;
}

/**
 * The routes of the pages Coolify shares between an application and a
 * standalone database (the same Livewire components with `:resource`):
 * Persistent Storage, Tags, Resource Operations' read and the Danger Zone's
 * read. segments: [uuid, page, …]. `run` runs a service with the resource's
 * context. The operation; null for a method the route does not have;
 * undefined for a path that is not one of them.
 */
export function sharedResourcePageOp(
  segments: string[],
  method: string,
  query: URLSearchParams,
  run: <T>(fn: (ctx: ResourcesContext) => Promise<T>) => Promise<T>,
): ResourcePageOp | null | undefined {
  const [uuid, section, third, fourth] = segments;
  const depth = segments.length;
  const id = depth === 4 ? rowId(fourth) : depth === 3 ? rowId(third) : null;
  const read = (show: (ctx: ResourcesContext, canWrite: boolean) => Promise<object | null>): ResourcePageOp | null =>
    method === "GET" ? { write: false, run: (w) => run((c) => show(c, w)) } : null;
  const write = (on: string, save: (ctx: ResourcesContext, body: Body) => Promise<object | null>, status = 200): ResourcePageOp | null =>
    method === on ? { write: true, status, run: (_w, body) => run((c) => save(c, body)) } : null;
  if (!uuid) return undefined;
  if (section === "storages") {
    if (depth === 2) return read((c, w) => showStorages(c, uuid, w)) ?? write("POST", (c, body) => addStorage(c, uuid, body), 201);
    if (depth === 4 && id !== null && third === "volumes") {
      return write("PATCH", (c, body) => updateVolume(c, uuid, id, body)) ?? write("DELETE", (c) => deleteVolume(c, uuid, id, flag(query, "deleteDockerVolume")));
    }
    if (depth === 4 && id !== null && third === "files") {
      return write("PATCH", (c, body) => updateFile(c, uuid, id, body)) ?? write("DELETE", (c) => deleteFile(c, uuid, id, flag(query, "permanently_delete")));
    }
  } else if (section === "tags") {
    if (depth === 2) return read((c, w) => showTags(c, uuid, w)) ?? write("POST", (c, body) => addTags(c, uuid, body));
    if (depth === 3 && id !== null) return write("POST", (c) => addTag(c, uuid, id)) ?? write("DELETE", (c) => removeTag(c, uuid, id));
  } else if (section === "resource-operations") {
    if (depth === 2) return read((c, w) => showResourceOperations(c, uuid, w));
  } else if (section === "danger") {
    if (depth === 2) return read((c, w) => showDanger(c, uuid, w));
  }
  return undefined;
}

/**
 * segments: what follows /applications, split on "/" — [uuid] for the DELETE,
 * else [uuid, page, …]. `runner` is replaceable for tests.
 */
export async function handleApplicationResources(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segments: string[],
  request: Request,
  runner: ApplicationResourcesRunner = runApplicationResourcesInOrg,
): Promise<Response> {
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  const [uuid, section, third] = segments;
  const method = request.method;
  if (!uuid || !UUID_RE.test(uuid) || !isApplicationResourceRoute(segments, method) || segments.length > 4) return notFound();
  const query = new URL(request.url).searchParams;
  type Run = <T>(fn: (ctx: ApplicationResourcesContext) => Promise<T>) => Promise<T>;
  const run: Run = (fn) => runner(env, orgId, fn);

  /** What the route does once authorized, or null for a method it does not have; undefined for a path that does not exist. */
  let op: ResourcePageOp | null | undefined;
  const depth = segments.length;
  const write = (on: string, save: (ctx: ApplicationResourcesContext, body: Body) => Promise<object | null>, status = 200): ResourcePageOp | null =>
    method === on ? { write: true, status, run: (_w, body) => run((c) => save(c, body)) } : null;

  if (depth === 1) {
    // Danger::delete()
    op = write("DELETE", (c) => deleteApplicationNow(c, uuid, deleteOptions(query)));
  } else if (section === "resource-operations" && depth === 3 && third === "clone") {
    op = write("POST", (c, body) => cloneApplicationTo(c, uuid, body), 201);
  } else if (section === "resource-operations" && depth === 3 && third === "move") {
    op = write("POST", (c, body) => moveApplicationTo(c, uuid, body));
  } else {
    op = sharedResourcePageOp(segments, method, query, (fn) => run((c) => fn(applicationResources(c))));
  }
  if (op === undefined) return notFound();
  if (op === null) return methodNotAllowed(requestId);

  // $this->authorize('view' | 'update' | 'delete', $application)
  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;
  try {
    const data = await op.run(auth.canWrite, method === "POST" || method === "PATCH" ? await readJson(request) : {});
    if (!data) return notFound();
    // The views' @can('update' | 'deploy' | 'delete', $application).
    return successResponse(op.write ? data : { ...data, canUpdate: auth.canWrite, canDeploy: auth.canWrite, canDelete: auth.canWrite }, requestId, op.status ?? 200);
  } catch (e) {
    return failure(e, requestId);
  }
}
