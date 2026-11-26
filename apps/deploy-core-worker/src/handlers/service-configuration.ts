// Derived from coollabsio/coolify@91b7e3e:routes/web.php (project.service.configuration, .environment-variables,
// .storages, .tags, .danger, .index), app/Livewire/Project/Service/{Configuration,Heading,StackForm,EditCompose,
// Index,ResourceCard,Storage,FileStorage}.php, app/Livewire/Project/Shared/{EnvironmentVariable/All,Tags,Danger}.php
// and app/Policies/ServicePolicy.php (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/services/{uuid}/… — a service's configuration pages. Dispatched by
// handleServices (services.ts):
//
//   GET    /configuration                 Configuration + StackForm: the frame and the General page
//   PATCH  /configuration                 StackForm::submit { name, description, fields, dockerComposeRaw? }
//                                         ("Save", and "Save changes" of the Edit Compose file dialog)
//   PATCH  /configuration/network         StackForm::instantSave { connectToDockerNetwork }
//   PATCH  /configuration/label-escape    EditCompose::instantSave { isContainerLabelEscapeEnabled }
//   POST   /actions/{start|force-deploy|stop|restart|pull-restart}   Heading: needs SSH, 501
//   GET    /parts/{part_uuid}             Index: one application's or database's settings
//   PATCH  /parts/{part_uuid}             Index's saves, by `action`
//   DELETE /parts/{part_uuid}             Index::deleteApplication / deleteDatabase
//   …/environment-variables[/…]           handleEnvironmentVariables with the type 'service'
//   GET    /storages                      each part's Storage
//   PATCH  /storages/{part_uuid}/volumes/{id}, …/files/{id}    as an application's (volumes are read-only)
//   DELETE /storages/{part_uuid}/volumes/{id}, …/files/{id}
//   GET    /tags, POST /tags, POST|DELETE /tags/{id}           Tags
//   GET    /danger                        Danger
//   DELETE /danger                        Danger::delete (a service that never ran; else 501)
//   GET    /webhooks                      Webhooks: the deploy webhook (DP-97)
//   GET    /scheduled-tasks               ScheduledTask\All with the service as its resource (DP-97)
//   POST   /scheduled-tasks               Add::submit { name, command, frequency, container, timeout, useShell }
//   GET    /scheduled-tasks/{task_uuid}   Show + Executions
//   PATCH  /scheduled-tasks/{task_uuid}   Show::submit
//   DELETE /scheduled-tasks/{task_uuid}   Show::delete
//   POST   /scheduled-tasks/{task_uuid}/toggle    toggleEnabled
//   POST   /scheduled-tasks/{task_uuid}/execute   executeNow (needs SSH: 501)
//   GET    /resource-operations           ResourceOperations (DP-97)
//   POST   /resource-operations/move      moveTo { environment_uuid }
//   POST   /resource-operations/clone     cloneTo { destination_uuid, environment_uuid, cloneVolumeData }: Coolify's
//                                         checks, then 501 (clone_service() is not ported, services/clone.ts)
//
// Coolify's policy: view to read; update, manageEnvironment and delete to write. Here: deploy.resource.read
// and deploy.resource.write; a denial answers 404 (never leaks).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  findServiceConfiguration,
  listServiceParts,
  listServiceVariables,
  listServicePartVolumes,
  listServicePartFiles,
  updateServiceRow,
  insertServicePart,
  insertServiceVariable,
  insertServicePartStorage,
  deleteServiceVariables,
  deleteServicePartFiles,
  serviceHasRun,
  deleteService,
  deleteServicePart,
  listDomainOwners,
  listScheduledTasks,
  findScheduledTask,
  insertScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  listScheduledTaskExecutions,
  serverTimezone,
  findOperationEnvironment,
  moveService,
  findDestinationByUuid,
  findServerByUuid,
  type ScheduledTaskOwner,
} from "@saas/db/deploy";
import { addHostTask, deleteHostTask, executeHostTask, showHostTask, showHostTasks, toggleHostTask, updateHostTask, type TaskHost } from "../applications/scheduled-tasks.js";
import { showResourceOperations } from "../applications/resource-operations.js";
import { moveServiceTo, serviceTaskHost, showServiceWebhooks, type ServicePagesStore } from "../services/resource-pages.js";
import { cloneServiceTo } from "../services/clone.js";
import { errorResponse, methodNotAllowed, successResponse } from "../http.js";
import type { KeyCipher } from "../private-keys/service.js";
import { authorizeDeploy, columnCipher, readJson } from "./cloud-tokens.js";
import { resourceRowsSqlStore } from "./database-resources.js";
import { handleEnvironmentVariables, type EnvironmentVariableRunner } from "./environment-variables.js";
import { rowId } from "../applications/resources.js";
import { SettingsError, SettingsFieldErrors } from "../applications/settings.js";
import { deleteFile, deleteVolume, updateFile, updateVolume } from "../applications/storages.js";
import { addTag, addTags, removeTag, showTags } from "../applications/tags.js";
import { showDanger } from "../applications/danger.js";
import {
  deleteServicePart as deletePart,
  runServiceAction,
  saveServiceGeneral,
  saveServiceLabelEscape,
  saveServiceNetwork,
  saveServicePart,
  SERVICE_ACTIONS,
  ServiceConfigurationError,
  showServiceGeneral,
  showServicePart,
  type ServiceAction,
  type ServiceConfigurationStore,
} from "../services/configuration.js";
import { deleteServiceNow, onServicePart, serviceResources, showServiceStorages, type ServiceResourcesContext } from "../services/resources.js";
import type { ServiceCreateDependencies } from "../services/service.js";

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

/** The pages below a service that this handler serves (the first segment after its uuid). */
export const SERVICE_CONFIGURATION_PAGES = ["configuration", "actions", "parts", "environment-variables", "storages", "tags", "danger", "webhooks", "scheduled-tasks", "resource-operations"] as const;

/** Whether handleServiceConfiguration serves the route. segments: what follows /services. */
export const isServiceConfigurationRoute = (segments: string[]): boolean => segments.length >= 2 && (SERVICE_CONFIGURATION_PAGES as readonly string[]).includes(segments[1]!);

export type ServiceConfigurationRunner = <T>(env: Env, orgId: string, fn: (ctx: ServiceResourcesContext) => Promise<T>) => Promise<T>;

function sqlStore(tx: SqlExecutor, orgId: string): ServiceConfigurationStore {
  return {
    find: (uuid) => findServiceConfiguration(tx, uuid),
    parts: (kind, serviceId) => listServiceParts(tx, kind, serviceId),
    variables: (serviceId) => listServiceVariables(tx, serviceId),
    volumes: (serviceId) => listServicePartVolumes(tx, serviceId),
    files: (serviceId) => listServicePartFiles(tx, serviceId),
    update: (kind, serviceId, id, changes) => updateServiceRow(tx, kind, serviceId, id, changes),
    insertPart: (kind, serviceId, uuid, row) => insertServicePart(tx, orgId, kind, serviceId, uuid, row),
    insertVariable: (serviceId, uuid, row) => insertServiceVariable(tx, orgId, serviceId, uuid, row),
    insertStorage: (kind, owner, uuid, row) => insertServicePartStorage(tx, orgId, kind, owner, uuid, row),
    deleteVariables: (serviceId, ids) => deleteServiceVariables(tx, serviceId, ids),
    deleteFiles: (serviceId, ids) => deleteServicePartFiles(tx, serviceId, ids),
    domainOwners: () => listDomainOwners(tx),
    hasRun: (serviceId) => serviceHasRun(tx, serviceId),
    deletePart: (kind, serviceId, id) => deleteServicePart(tx, kind, serviceId, id),
  };
}

/** A service's configuration stores and ciphers over one org's transaction (also /api/v1's, DP-74). */
export function serviceResourcesContext(tx: SqlExecutor, orgId: string, secret: string | undefined): ServiceResourcesContext {
  const ciphers = new Map<string, KeyCipher>();
  const cipher = (column: string): KeyCipher => {
    let found = ciphers.get(column);
    if (!found) ciphers.set(column, (found = columnCipher(tx, orgId, secret, column)));
    return found;
  };
  return {
    configuration: { store: sqlStore(tx, orgId), ciphers: { variables: cipher("environment_variables.value"), content: cipher("local_file_volumes.content") } },
    rows: (morphClass) => resourceRowsSqlStore(tx, orgId, morphClass),
    content: cipher("local_file_volumes.content"),
    deleteService: (serviceId) => deleteService(tx, serviceId),
    pages: servicePagesSqlStore(tx, orgId),
    clone: { findDestination: (uuid) => findDestinationByUuid(tx, uuid), findServer: (uuid) => findServerByUuid(tx, uuid) },
  };
}

/** The service's task rows, its server's timezone and Move (DP-97). */
function servicePagesSqlStore(tx: SqlExecutor, orgId: string): ServicePagesStore {
  const owner = (id: string | number): ScheduledTaskOwner => ({ kind: "service", id });
  return {
    tasks: (serviceId) => listScheduledTasks(tx, owner(serviceId)),
    findTask: (serviceId, uuid) => findScheduledTask(tx, owner(serviceId), uuid),
    insertTask: (t) => insertScheduledTask(tx, { orgId, owner: owner(t.serviceId), uuid: t.uuid, name: t.name, command: t.command, frequency: t.frequency, container: t.container, timeout: t.timeout, useShell: t.useShell }),
    updateTask: (serviceId, id, changes) => updateScheduledTask(tx, owner(serviceId), id, changes),
    deleteTask: (serviceId, id) => deleteScheduledTask(tx, owner(serviceId), id),
    executions: (taskId) => listScheduledTaskExecutions(tx, taskId),
    serverTimezone: (serverId) => serverTimezone(tx, serverId),
    findEnvironment: (uuid) => findOperationEnvironment(tx, uuid),
    move: (serviceId, environmentId) => moveService(tx, serviceId, environmentId),
  };
}

export const runServiceConfigurationInOrg: ServiceConfigurationRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => fn(serviceResourcesContext(tx, orgId, env.DEPLOY_ENCRYPTION_KEY)));
  } finally {
    await db.dispose();
  }
};

function failure(e: unknown, requestId: string): Response {
  if (e instanceof SettingsFieldErrors) return errorResponse("validation_failed", Object.values(e.fields).flat()[0] ?? "Validation failed", 422, requestId, { fields: e.fields });
  if (e instanceof ServiceConfigurationError || e instanceof SettingsError) {
    const code = e.status === 501 ? "unsupported" : e.status === 409 ? "conflict" : e.status === 404 ? "not_found" : "validation_failed";
    const details = e instanceof ServiceConfigurationError ? { ...(e.fields ? { fields: e.fields } : {}), ...(e.details ?? {}) } : (e.details ?? undefined);
    return errorResponse(code, e.message, e.status, requestId, details && Object.keys(details).length ? details : undefined);
  }
  return errorResponse("internal_error", "Service unavailable", 503, requestId);
}

interface Op {
  write: boolean;
  status?: number;
  run: (canWrite: boolean, body: Record<string, unknown>) => Promise<object | null>;
}

/** segments: what follows /services — [uuid, page, …]. `runner`, `variablesRunner` and `deps` are replaceable for tests. */
export async function handleServiceConfiguration(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segments: string[],
  request: Request,
  runner: ServiceConfigurationRunner = runServiceConfigurationInOrg,
  variablesRunner?: EnvironmentVariableRunner,
  deps: ServiceCreateDependencies = {},
): Promise<Response> {
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  const [uuid, section, third, fourth, fifth] = segments;
  const method = request.method;
  if (!uuid || !UUID_RE.test(uuid) || !isServiceConfigurationRoute(segments)) return notFound();

  if (section === "environment-variables") {
    return handleEnvironmentVariables(env, requestId, actor, orgId, { type: "service", uuid }, segments.slice(2), request, variablesRunner);
  }

  type Body = Record<string, unknown>;
  const query = new URL(request.url).searchParams;
  const run = <T>(fn: (ctx: ServiceResourcesContext) => Promise<T>): Promise<T> => runner(env, orgId, fn);
  const read = (show: (ctx: ServiceResourcesContext, canWrite: boolean) => Promise<object | null>): Op | null => (method === "GET" ? { write: false, run: (w) => run((c) => show(c, w)) } : null);
  const write = (on: string, save: (ctx: ServiceResourcesContext, body: Body) => Promise<object | null>, status = 200): Op | null =>
    method === on ? { write: true, status, run: (_w, body) => run((c) => save(c, body)) } : null;
  const depth = segments.length;
  const flag = (name: string) => ["1", "true", "on", "yes"].includes((query.get(name) ?? "").trim().toLowerCase());

  let op: Op | null | undefined;
  if (section === "configuration" && depth === 2) {
    op = read((c, w) => showServiceGeneral(c.configuration, uuid, w)) ?? write("PATCH", (c, body) => saveServiceGeneral(c.configuration, uuid, body, deps));
  } else if (section === "configuration" && depth === 3 && third === "network") {
    op = write("PATCH", (c, body) => saveServiceNetwork(c.configuration, uuid, body));
  } else if (section === "configuration" && depth === 3 && third === "label-escape") {
    op = write("PATCH", (c, body) => saveServiceLabelEscape(c.configuration, uuid, body));
  } else if (section === "actions" && depth === 3 && (SERVICE_ACTIONS as readonly string[]).includes(third!)) {
    op = write("POST", (c) => runServiceAction(c.configuration, uuid, third as ServiceAction));
  } else if (section === "parts" && depth === 3 && UUID_RE.test(third!)) {
    op =
      read((c) => showServicePart(c.configuration, uuid, third!)) ??
      write("PATCH", (c, body) => saveServicePart(c.configuration, uuid, third!, body)) ??
      write("DELETE", (c) => deletePart(c.configuration, uuid, third!));
  } else if (section === "storages" && depth === 2) {
    op = read((c, w) => showServiceStorages(c, uuid, w));
  } else if (section === "storages" && depth === 5 && UUID_RE.test(third!) && (fourth === "volumes" || fourth === "files") && rowId(fifth) !== null) {
    const id = rowId(fifth)!;
    const part = third!;
    op =
      fourth === "volumes"
        ? (write("PATCH", (c, body) => onServicePart(c, uuid, part, (r) => updateVolume(r, part, id, body))) ?? write("DELETE", (c) => onServicePart(c, uuid, part, (r) => deleteVolume(r, part, id, flag("deleteDockerVolume")))))
        : (write("PATCH", (c, body) => onServicePart(c, uuid, part, (r) => updateFile(r, part, id, body))) ?? write("DELETE", (c) => onServicePart(c, uuid, part, (r) => deleteFile(r, part, id, flag("permanently_delete")))));
  } else if (section === "tags" && depth === 2) {
    op = read((c, w) => showTags(serviceResources(c), uuid, w)) ?? write("POST", (c, body) => addTags(serviceResources(c), uuid, body));
  } else if (section === "tags" && depth === 3 && rowId(third) !== null) {
    op = write("POST", (c) => addTag(serviceResources(c), uuid, rowId(third)!)) ?? write("DELETE", (c) => removeTag(serviceResources(c), uuid, rowId(third)!));
  } else if (section === "danger" && depth === 2) {
    op = read((c, w) => showDanger(serviceResources(c), uuid, w)) ?? write("DELETE", (c) => deleteServiceNow(c, uuid));
  } else if (section === "webhooks" && depth === 2) {
    op = read((c) => showServiceWebhooks(c, uuid));
  } else if (section === "scheduled-tasks" && depth >= 2 && depth <= 4) {
    // ScheduledTask\All, Add and Show with the service as their resource.
    const onHost = <T>(c: ServiceResourcesContext, fn: (host: TaskHost) => Promise<T | null>): Promise<T | null> => serviceTaskHost(c, uuid).then((host) => (host ? fn(host) : null));
    const task = third !== undefined && UUID_RE.test(third) ? third : null;
    if (depth === 2) op = read((c) => onHost(c, showHostTasks)) ?? write("POST", (c, body) => onHost(c, (h) => addHostTask(h, body)), 201);
    else if (depth === 3 && task) {
      op =
        read((c, w) => onHost(c, (h) => showHostTask(h, task, w))) ??
        write("PATCH", (c, body) => onHost(c, (h) => updateHostTask(h, task, body))) ??
        write("DELETE", (c) => onHost(c, (h) => deleteHostTask(h, task)));
    } else if (depth === 4 && task && fourth === "toggle") op = write("POST", (c) => onHost(c, (h) => toggleHostTask(h, task)));
    else if (depth === 4 && task && fourth === "execute") op = write("POST", (c) => onHost(c, (h) => executeHostTask(h, task)));
  } else if (section === "resource-operations" && depth === 2) {
    op = read((c, w) => showResourceOperations(serviceResources(c), uuid, w));
  } else if (section === "resource-operations" && depth === 3 && third === "move") {
    op = write("POST", (c, body) => moveServiceTo(c, uuid, body));
  } else if (section === "resource-operations" && depth === 3 && third === "clone") {
    op = write("POST", (c, body) => cloneServiceTo(c, uuid, body, deps), 201);
  }
  if (op === undefined) return notFound();
  if (op === null) return methodNotAllowed(requestId);

  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;
  try {
    const data = await op.run(auth.canWrite, method === "POST" || method === "PATCH" ? await readJson(request) : {});
    if (!data) return notFound();
    // The views' @can('update' | 'manageEnvironment' | 'delete', $service).
    return successResponse(op.write ? data : { ...data, canUpdate: auth.canWrite, canManage: auth.canWrite, canDelete: auth.canWrite }, requestId, op.status ?? 200);
  } catch (e) {
    return failure(e, requestId);
  }
}
