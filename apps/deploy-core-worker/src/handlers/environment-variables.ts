// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Shared/EnvironmentVariable/{All,Add,Show}.php,
// app/Policies/{EnvironmentVariablePolicy,ApplicationPolicy}.php (view, viewSensitive, manageEnvironment)
// and routes/web.php (project.application.environment-variables) (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/applications/{uuid}/environment-variables —
// an application's Environment Variables page; routed here by
// handleApplications (applications.ts).
//
//   GET    /environment-variables                    All: the settings and the production and preview variables (no values)
//   POST   /environment-variables                    Add::submit → All::handleSingleSubmit { key, value, comment, is_multiline,
//                                                    is_literal, is_runtime, is_buildtime, is_preview }
//   GET    /environment-variables/dev                All::getDevView: the variables as text
//   PUT    /environment-variables/dev                All::submit (bulk) { variables, variablesPreview }
//   PATCH  /environment-variables/settings           All::instantSave, saveCoolifyDefaultVariables, saveLogRedactionSetting
//   GET    /environment-variables/{env_uuid}         Show::loadValues, copyValue: the value, unless locked or hidden
//   PATCH  /environment-variables/{env_uuid}         Show::submit
//   DELETE /environment-variables/{env_uuid}         Show::delete (no body: the edge does not forward one)
//   POST   /environment-variables/{env_uuid}/lock    Show::lock
//
// Coolify's policy: listing needs `view` on the resource, reading a value
// `viewSensitive`, every change `manageEnvironment` (write access). Here:
// deploy.resource.read lists and reads the developer view with its values
// hidden; deploy.resource.write reads values and changes; asked of
// policy-worker after membership-worker's facts; a denial answers 404 (never
// leaks).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  findEnvironmentVariableResource,
  listEnvironmentVariables,
  findEnvironmentVariableByUuid,
  findEnvironmentVariablesByKey,
  maxEnvironmentVariableOrder,
  insertEnvironmentVariable,
  updateEnvironmentVariable as updateEnvironmentVariableRow,
  deleteEnvironmentVariables,
  updateEnvironmentVariableSettings as updateEnvironmentVariableSettingsRow,
  findSharedVariableForReference,
  listSharedVariableKeys,
  type EnvironmentVariableResourceType,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse, validationError } from "../http.js";
import { authorizeDeploy, columnCipher, readJson } from "./cloud-tokens.js";
import { validateAdd, validateBulk, validateSettings } from "../environment-variables/validation.js";
import {
  addEnvironmentVariable,
  deleteEnvironmentVariable,
  developerView,
  EnvironmentVariableError,
  environmentVariablesPage,
  lockEnvironmentVariable,
  saveDeveloperView,
  showEnvironmentVariable,
  updateEnvironmentVariable,
  updateEnvironmentVariableSettings,
  type EnvironmentVariableAccess,
  type EnvironmentVariableContext,
  type EnvironmentVariableStore,
} from "../environment-variables/service.js";

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;
/** The segments after /environment-variables that are not a variable's uuid. */
const RESERVED: readonly string[] = ["dev", "settings"];

/** Runs fn with one org's variables of one resource type and the ciphers, in one transaction confined to that org. */
export type EnvironmentVariableRunner = <T>(env: Env, orgId: string, type: EnvironmentVariableResourceType, fn: (ctx: EnvironmentVariableContext) => Promise<T>) => Promise<T>;

function sqlStore(tx: SqlExecutor, orgId: string, type: EnvironmentVariableResourceType): EnvironmentVariableStore {
  return {
    findResource: (uuid) => findEnvironmentVariableResource(tx, type, uuid),
    list: (resourceId, isPreview, orderBy) => listEnvironmentVariables(tx, type, resourceId, isPreview, orderBy),
    findByUuid: (resourceId, uuid) => findEnvironmentVariableByUuid(tx, type, resourceId, uuid),
    findByKey: (resourceId, isPreview, key) => findEnvironmentVariablesByKey(tx, type, resourceId, isPreview, key),
    maxOrder: (resourceId) => maxEnvironmentVariableOrder(tx, type, resourceId),
    insert: (resourceId, variable) => insertEnvironmentVariable(tx, type, resourceId, { ...variable, orgId }),
    update: (id, changes) => updateEnvironmentVariableRow(tx, id, changes),
    delete: (ids) => deleteEnvironmentVariables(tx, ids),
    updateSettings: (resourceId, changes) => updateEnvironmentVariableSettingsRow(tx, type, resourceId, changes),
    sharedVariable: (scope, key) => findSharedVariableForReference(tx, scope, key),
    sharedVariableKeys: (scope) => listSharedVariableKeys(tx, scope),
  };
}

export const runEnvironmentVariablesInOrg: EnvironmentVariableRunner = async (env, orgId, type, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) =>
      fn({
        resourceType: type,
        store: sqlStore(tx, orgId, type),
        // One cipher per encrypted column: a value is bound to "<table>.value".
        cipher: columnCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, "environment_variables.value"),
        sharedCipher: columnCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, "shared_environment_variables.value"),
      }),
    );
  } finally {
    await db.dispose();
  }
};

function failure(e: unknown, requestId: string): Response {
  if (e instanceof EnvironmentVariableError) {
    // A ValidationException names its field.
    if (e.field) return validationError(requestId, { [e.field]: [e.message] });
    return errorResponse(e.status === 409 ? "conflict" : "validation_failed", e.message, e.status, requestId);
  }
  return errorResponse("internal_error", "Service unavailable", 503, requestId);
}

type Op = { write: boolean; run: (access: EnvironmentVariableAccess) => Promise<Response> };

/**
 * segments: what follows /environment-variables, split on "/" ([] for the
 * collection). `runner` is replaceable for tests.
 */
export async function handleEnvironmentVariables(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  resource: { type: EnvironmentVariableResourceType; uuid: string },
  segments: string[],
  request: Request,
  runner: EnvironmentVariableRunner = runEnvironmentVariablesInOrg,
): Promise<Response> {
  const method = request.method;
  const { type, uuid } = resource;
  const [first, second] = segments;
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  const run = <T>(fn: (ctx: EnvironmentVariableContext) => Promise<T>) => runner(env, orgId, type, fn);
  if (!UUID_RE.test(uuid)) return notFound();
  let op: Op | null = null;

  if (segments.length === 0) {
    if (method === "GET") op = { write: false, run: list };
    else if (method === "POST") op = { write: true, run: add };
  } else if (segments.length === 1 && first === "dev") {
    if (method === "GET") op = { write: false, run: dev };
    else if (method === "PUT") op = { write: true, run: bulk };
  } else if (segments.length === 1 && first === "settings") {
    if (method === "PATCH") op = { write: true, run: settings };
  } else if (segments.length === 1 && UUID_RE.test(first!)) {
    if (method === "GET") op = { write: false, run: (access) => show(first!, access) };
    else if (method === "PATCH") op = { write: true, run: () => update(first!) };
    else if (method === "DELETE") op = { write: true, run: () => remove(first!) };
  } else if (segments.length === 2 && UUID_RE.test(first!) && !RESERVED.includes(first!) && second === "lock") {
    if (method === "POST") op = { write: true, run: () => lock(first!) };
  } else {
    return notFound();
  }
  if (!op) return methodNotAllowed(requestId);

  async function list(access: EnvironmentVariableAccess): Promise<Response> {
    const page = await run((c) => environmentVariablesPage(c, uuid));
    if (!page) return notFound();
    // @can('manageEnvironment', $resource) and the rows' isValueHidden (viewSensitive).
    return successResponse({ ...page, canManage: access.canManage, canViewValues: access.canViewValues }, requestId);
  }

  async function add(): Promise<Response> {
    const v = validateAdd(await readJson(request));
    if (!v.ok) return validationError(requestId, v.errors);
    const created = await run((c) => addEnvironmentVariable(c, uuid, v.input));
    if (!created) return notFound();
    return successResponse(created, requestId, 201);
  }

  async function dev(access: EnvironmentVariableAccess): Promise<Response> {
    const view = await run((c) => developerView(c, uuid, access));
    if (!view) return notFound();
    return successResponse({ ...view, canManage: access.canManage }, requestId);
  }

  async function bulk(): Promise<Response> {
    const v = validateBulk(await readJson(request));
    if (!v.ok) return validationError(requestId, v.errors);
    const saved = await run((c) => saveDeveloperView(c, uuid, v.input));
    if (!saved) return notFound();
    return successResponse(saved, requestId);
  }

  async function settings(): Promise<Response> {
    const v = validateSettings(await readJson(request));
    if (!v.ok) return validationError(requestId, v.errors);
    const saved = await run((c) => updateEnvironmentVariableSettings(c, uuid, v.input));
    if (!saved) return notFound();
    return successResponse(saved, requestId);
  }

  async function show(envUuid: string, access: EnvironmentVariableAccess): Promise<Response> {
    const values = await run((c) => showEnvironmentVariable(c, uuid, envUuid, access));
    if (!values) return notFound();
    return successResponse(values, requestId);
  }

  async function update(envUuid: string): Promise<Response> {
    const body = await readJson(request);
    const saved = await run((c) => updateEnvironmentVariable(c, uuid, envUuid, body));
    if (!saved) return notFound();
    if ("errors" in saved) return validationError(requestId, saved.errors);
    return successResponse(saved, requestId);
  }

  async function remove(envUuid: string): Promise<Response> {
    const deleted = await run((c) => deleteEnvironmentVariable(c, uuid, envUuid));
    if (!deleted) return notFound();
    return successResponse({ deleted: true, message: deleted.message }, requestId);
  }

  async function lock(envUuid: string): Promise<Response> {
    if (!(await run((c) => lockEnvironmentVariable(c, uuid, envUuid)))) return notFound();
    return successResponse({ locked: true }, requestId);
  }

  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;
  try {
    // Coolify's viewSensitive level sits between read and write; Freeploy has the two, so a value needs write.
    return await op.run({ canManage: auth.canWrite, canViewValues: auth.canWrite });
  } catch (e) {
    return failure(e, requestId);
  }
}
