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
} from "@saas/db/deploy";
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
export const SERVICE_CONFIGURATION_PAGES = ["configuration", "actions", "parts", "environment-variables", "storages", "tags", "danger"] as const;

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

export const runServiceConfigurationInOrg: ServiceConfigurationRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => {
      const ciphers = new Map<string, KeyCipher>();
      const cipher = (column: string): KeyCipher => {
        let found = ciphers.get(column);
        if (!found) ciphers.set(column, (found = columnCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, column)));
        return found;
      };
      return fn({
        configuration: { store: sqlStore(tx, orgId), ciphers: { variables: cipher("environment_variables.value"), content: cipher("local_file_volumes.content") } },
        rows: (morphClass) => resourceRowsSqlStore(tx, orgId, morphClass),
        content: cipher("local_file_volumes.content"),
        deleteService: (serviceId) => deleteService(tx, serviceId),
      });
    });
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
