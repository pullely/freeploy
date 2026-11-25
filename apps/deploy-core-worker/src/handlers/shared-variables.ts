// Derived from coollabsio/coolify@91b7e3e:app/Livewire/SharedVariables/Index.php,
// app/Livewire/SharedVariables/Team/Index.php,
// app/Livewire/SharedVariables/{Project,Environment,Server}/{Index,Show}.php,
// app/Livewire/Project/Shared/EnvironmentVariable/{Add,Show}.php,
// app/Policies/SharedEnvironmentVariablePolicy.php and routes/web.php (shared-variables.*)
// (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/shared-variables — Shared Variables.
//
//   GET    /shared-variables                 Index: the counts per scope, recently changed, not used
//   GET    /shared-variables/projects        Project\Index: the projects with their variable counts
//   GET    /shared-variables/environments    Environment\Index: the projects with their environments
//   GET    /shared-variables/servers         Server\Index: the servers
//
// and, for a scope — `team`, `project/{uuid}`, `environment/{uuid}` or `server/{uuid}`:
//
//   GET    /{scope}                the editor: the variables (no values) and the developer view's text
//   POST   /{scope}                saveKey { key, value, comment, is_multiline, is_literal }
//   POST   /{scope}/bulk           the developer view's submit { variables }
//   GET    /{scope}/{id}           Show::loadValues: one variable with its value
//   PATCH  /{scope}/{id}           Show::submit { key, value, comment, is_multiline, is_literal, is_shown_once, newLockedValue }
//   POST   /{scope}/{id}/lock      Show::lock
//   DELETE /{scope}/{id}           Show::delete (no body: the edge does not forward one)
//
// A variable has no uuid in Coolify; {id} is its row id, looked up within the
// scope (and the org, by row-level security).
//
// Coolify's policy: keys are for who can read the scope (team-wide read for
// team and server variables, read access for a project's or environment's);
// values (viewSensitive) and every change are for team admins, or for who can
// write the project or environment. Here: deploy.resource.read for the pages,
// keys, comments and flags, and deploy.resource.write for values and changes,
// asked of policy-worker after membership-worker's facts; a denial answers 404
// (never leaks). A locked variable's value is in no answer.
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  findProjectByUuid,
  findServerByUuid,
  listSharedVariables,
  findSharedVariableById,
  findSharedVariableByKey,
  insertSharedVariable,
  updateSharedVariable as updateSharedVariableRow,
  deleteSharedVariable as deleteSharedVariableRow,
  deleteSharedVariablesExcept,
  listSharedVariablesOverview,
  listSharedVariableProjects,
  listSharedVariableEnvironments,
  findSharedVariableEnvironment,
  listSharedVariableServers,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse, validationError } from "../http.js";
import { authorizeDeploy, columnCipher, readJson } from "./cloud-tokens.js";
import { validateAddVariable, validateUpdateVariable } from "../shared-variables/validation.js";
import {
  addSharedVariable,
  deleteSharedVariable,
  lockSharedVariable,
  saveSharedVariablesDevView,
  SHARED_VARIABLE_MESSAGES,
  SharedVariableError,
  sharedVariableEnvironments,
  sharedVariableProjects,
  sharedVariableServers,
  sharedVariablesOverview,
  sharedVariablesPage,
  showSharedVariable,
  updateSharedVariable,
  type ScopeRef,
  type SharedVariableContext,
  type SharedVariableStore,
} from "../shared-variables/service.js";

const COLUMN = "shared_environment_variables.value";
const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;
/** A variable's row id (a bigint). */
const ID_RE = /^[1-9]\d{0,17}$/;

/** Runs fn with one org's shared variable store and cipher, in one transaction confined to that org. */
export type SharedVariableRunner = <T>(env: Env, orgId: string, fn: (ctx: SharedVariableContext) => Promise<T>) => Promise<T>;

function sqlStore(tx: SqlExecutor, orgId: string): SharedVariableStore {
  return {
    findProject: (uuid) => findProjectByUuid(tx, uuid),
    findEnvironment: (uuid) => findSharedVariableEnvironment(tx, uuid),
    findServer: (uuid) => findServerByUuid(tx, uuid),
    projects: () => listSharedVariableProjects(tx),
    environments: () => listSharedVariableEnvironments(tx),
    servers: () => listSharedVariableServers(tx),
    overview: () => listSharedVariablesOverview(tx),
    list: (owner) => listSharedVariables(tx, owner),
    findById: (owner, id) => findSharedVariableById(tx, owner, id),
    findByKey: (owner, key) => findSharedVariableByKey(tx, owner, key),
    insert: (variable) => insertSharedVariable(tx, { ...variable, orgId }),
    update: (id, changes) => updateSharedVariableRow(tx, id, changes),
    delete: (id) => deleteSharedVariableRow(tx, id),
    deleteExcept: (owner, keys, protectedKeys) => deleteSharedVariablesExcept(tx, owner, keys, protectedKeys),
  };
}

export const runSharedVariablesInOrg: SharedVariableRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => fn({ store: sqlStore(tx, orgId), cipher: columnCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, COLUMN) }));
  } finally {
    await db.dispose();
  }
};

function failure(e: unknown, requestId: string): Response {
  if (e instanceof SharedVariableError) {
    if (e.field) return validationError(requestId, { [e.field]: [e.message] });
    return errorResponse(e.status === 409 ? "conflict" : "validation_failed", e.message, e.status, requestId);
  }
  return errorResponse("internal_error", "Service unavailable", 503, requestId);
}

type Op = { write: boolean; run: (canWrite: boolean) => Promise<Response> };

/** The scope the path names (`team`, or a kind and its uuid) and what follows it; null when it names none. */
function scopeOf(segments: string[]): { ref: ScopeRef; rest: string[] } | null {
  const [first, second] = segments;
  if (first === "team") return { ref: { type: "team" }, rest: segments.slice(1) };
  if ((first === "project" || first === "environment" || first === "server") && second !== undefined && UUID_RE.test(second)) {
    return { ref: { type: first, uuid: second }, rest: segments.slice(2) };
  }
  return null;
}

/**
 * segments: what follows /shared-variables, split on "/" ([] for the
 * overview). `runner` is replaceable for tests.
 */
export async function handleSharedVariables(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segments: string[],
  request: Request,
  runner: SharedVariableRunner = runSharedVariablesInOrg,
): Promise<Response> {
  const method = request.method;
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  const scope = scopeOf(segments);
  let op: Op | null = null;

  if (segments.length === 0) {
    if (method === "GET") op = { write: false, run: overview };
  } else if (segments.length === 1 && (segments[0] === "projects" || segments[0] === "environments" || segments[0] === "servers")) {
    const index = segments[0];
    if (method === "GET") op = { write: false, run: () => list(index) };
  } else if (scope && scope.rest.length === 0) {
    if (method === "GET") op = { write: false, run: (canWrite) => page(scope.ref, canWrite) };
    else if (method === "POST") op = { write: true, run: () => add(scope.ref) };
  } else if (scope && scope.rest.length === 1 && scope.rest[0] === "bulk") {
    if (method === "POST") op = { write: true, run: () => bulk(scope.ref) };
  } else if (scope && scope.rest.length === 1 && ID_RE.test(scope.rest[0]!)) {
    const id = scope.rest[0]!;
    if (method === "GET") op = { write: false, run: (canWrite) => show(scope.ref, id, canWrite) };
    else if (method === "PATCH") op = { write: true, run: () => update(scope.ref, id) };
    else if (method === "DELETE") op = { write: true, run: () => remove(scope.ref, id) };
  } else if (scope && scope.rest.length === 2 && ID_RE.test(scope.rest[0]!) && scope.rest[1] === "lock") {
    const id = scope.rest[0]!;
    if (method === "POST") op = { write: true, run: () => lock(scope.ref, id) };
  } else {
    return notFound();
  }
  if (!op) return methodNotAllowed(requestId);

  async function overview(): Promise<Response> {
    return successResponse(await runner(env, orgId, (c) => sharedVariablesOverview(c)), requestId);
  }

  async function list(index: "projects" | "environments" | "servers"): Promise<Response> {
    if (index === "projects") return successResponse({ projects: await runner(env, orgId, (c) => sharedVariableProjects(c)) }, requestId);
    if (index === "environments") return successResponse({ projects: await runner(env, orgId, (c) => sharedVariableEnvironments(c)) }, requestId);
    return successResponse({ servers: await runner(env, orgId, (c) => sharedVariableServers(c)) }, requestId);
  }

  /** The editor; who may write also reads values (viewSensitive) and gets @can('update', $resource). */
  async function page(ref: ScopeRef, canWrite: boolean): Promise<Response> {
    const data = await runner(env, orgId, (c) => sharedVariablesPage(c, ref, canWrite));
    if (!data) return notFound();
    return successResponse({ ...data, canUpdate: canWrite, canViewValues: canWrite }, requestId);
  }

  async function add(ref: ScopeRef): Promise<Response> {
    const v = validateAddVariable(await readJson(request));
    if (!v.ok) return validationError(requestId, v.errors);
    const variable = await runner(env, orgId, (c) => addSharedVariable(c, ref, v.input));
    if (!variable) return notFound();
    return successResponse(variable, requestId, 201);
  }

  async function bulk(ref: ScopeRef): Promise<Response> {
    const body = await readJson(request);
    const text = typeof body.variables === "string" ? body.variables : "";
    const saved = await runner(env, orgId, async (c) => {
      const result = await saveSharedVariablesDevView(c, ref, text);
      const fresh = result ? await sharedVariablesPage(c, ref, true) : null;
      return result && fresh ? { ...fresh, changed: result.changed } : null;
    });
    if (!saved) return notFound();
    return successResponse({ ...saved, canUpdate: true, canViewValues: true, message: saved.changed ? SHARED_VARIABLE_MESSAGES.bulkUpdated : null }, requestId);
  }

  async function show(ref: ScopeRef, id: string, canWrite: boolean): Promise<Response> {
    const variable = await runner(env, orgId, (c) => showSharedVariable(c, ref, id, canWrite));
    if (!variable) return notFound();
    return successResponse(variable, requestId);
  }

  async function update(ref: ScopeRef, id: string): Promise<Response> {
    const v = validateUpdateVariable(await readJson(request));
    if (!v.ok) return validationError(requestId, v.errors);
    const variable = await runner(env, orgId, (c) => updateSharedVariable(c, ref, id, v.input));
    if (!variable) return notFound();
    return successResponse({ ...variable, message: SHARED_VARIABLE_MESSAGES.updated }, requestId);
  }

  async function lock(ref: ScopeRef, id: string): Promise<Response> {
    const variable = await runner(env, orgId, (c) => lockSharedVariable(c, ref, id));
    if (!variable) return notFound();
    return successResponse(variable, requestId);
  }

  async function remove(ref: ScopeRef, id: string): Promise<Response> {
    const deleted = await runner(env, orgId, (c) => deleteSharedVariable(c, ref, id));
    if (!deleted) return notFound();
    return successResponse({ deleted: true, message: SHARED_VARIABLE_MESSAGES.deleted }, requestId);
  }

  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;
  try {
    return await op.run(auth.canWrite);
  } catch (e) {
    return failure(e, requestId);
  }
}
