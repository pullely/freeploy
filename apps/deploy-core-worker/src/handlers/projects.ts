// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/{Index,AddEmpty,Show,Edit,
// DeleteProject,DeleteEnvironment,EnvironmentEdit}.php, app/Livewire/Project/Resource/Index.php,
// app/Livewire/Concerns/CreatesEnvironments.php, app/Policies/{ProjectPolicy,EnvironmentPolicy}.php
// and app/Http/Controllers/Api/ProjectController.php (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/projects — Projects and their environments.
//
//   GET    /projects                                   Index: the org's projects with their counts
//   POST   /projects                                   AddEmpty::submit { name, description }
//   GET    /projects/{uuid}                            Show / Edit: the project and its environments
//   PATCH  /projects/{uuid}                            Edit::submit { name, description }
//   DELETE /projects/{uuid}                            DeleteProject::delete (no body: the edge does not forward one)
//   GET    /projects/{uuid}/environments               Show: the environments
//   POST   /projects/{uuid}/environments               CreatesEnvironments::submit { name }
//   GET    /projects/{uuid}/environments/{env_uuid}    Resource\Index / EnvironmentEdit
//   PATCH  /projects/{uuid}/environments/{env_uuid}    EnvironmentEdit::submit { name, description }
//   DELETE /projects/{uuid}/environments/{env_uuid}    DeleteEnvironment::delete
//
// Coolify's policies: view = who can open the project, create = team-wide
// write, update = write, delete = the delete level. Here: deploy.resource.read
// and deploy.resource.write, asked of policy-worker after membership-worker's
// facts; a denial answers 404 (never leaks).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor, type SqlExecutor, type TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  listProjectsWithCounts,
  findProjectByUuid,
  insertProject,
  updateProject as updateProjectRow,
  deleteProject as deleteProjectRow,
  projectHasResources,
  listEnvironments as listEnvironmentRows,
  findEnvironmentByUuid,
  insertEnvironment,
  updateEnvironment as updateEnvironmentRow,
  deleteEnvironment as deleteEnvironmentRow,
  environmentNameExists,
  environmentHasResources,
} from "@saas/db/deploy";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy, type AuthorizeResult } from "../policy-client.js";
import { deniedResponse, errorResponse, methodNotAllowed, successResponse, validationError } from "../http.js";
import { validateNameAndDescription } from "../projects/validation.js";
import {
  createEnvironment,
  createProject,
  deleteEnvironment,
  deleteProject,
  listEnvironments,
  listProjects,
  PROJECT_MESSAGES,
  ProjectError,
  showEnvironment,
  showProject,
  updateEnvironment,
  updateProject,
  type ProjectStore,
} from "../projects/service.js";

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

/** Runs fn with one org's project store, in one transaction confined to that org. */
export type ProjectsRunner = <T>(env: Env, orgId: string, fn: (store: ProjectStore) => Promise<T>) => Promise<T>;

/** The project store over one org's transaction (exported for DP-94's tests, which run /api/v1 over PGlite). */
export function sqlStore(tx: SqlExecutor, orgId: string): ProjectStore {
  return {
    list: () => listProjectsWithCounts(tx),
    findByUuid: (uuid) => findProjectByUuid(tx, uuid),
    insert: (project) => insertProject(tx, { ...project, orgId }),
    update: (id, changes) => updateProjectRow(tx, id, changes),
    delete: (id) => deleteProjectRow(tx, id),
    projectHasResources: (id) => projectHasResources(tx, id),
    environments: (projectId) => listEnvironmentRows(tx, projectId),
    findEnvironment: (projectId, uuid) => findEnvironmentByUuid(tx, projectId, uuid),
    insertEnvironment: (environment) => insertEnvironment(tx, { ...environment, orgId }),
    updateEnvironment: (id, changes) => updateEnvironmentRow(tx, id, changes),
    deleteEnvironment: (id) => deleteEnvironmentRow(tx, id),
    environmentNameExists: (projectId, name, excludeId) => environmentNameExists(tx, projectId, name, excludeId),
    environmentHasResources: (id) => environmentHasResources(tx, id),
  };
}

/** runInOrg() on a given database (DP-93: the /api/v1 replays run on PGlite): withOrg(), the same stores. */
export const runInOrgOn =
  (db: TransactionalSqlExecutor): ProjectsRunner =>
  (_env, orgId, fn) =>
    withOrg(db, orgId, (tx) => fn(sqlStore(tx, orgId)));

export const runInOrg: ProjectsRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => fn(sqlStore(tx, orgId)));
  } finally {
    await db.dispose();
  }
};

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const b: unknown = await request.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function failure(e: unknown, requestId: string): Response {
  if (e instanceof ProjectError) return errorResponse(e.status === 409 ? "conflict" : "validation_failed", e.message, e.status, requestId);
  return errorResponse("internal_error", "Service unavailable", 503, requestId);
}

/**
 * segments: what follows /projects, split on "/" ([] for the collection).
 * `runner` is replaceable for tests.
 */
export async function handleProjects(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segments: string[],
  request: Request,
  runner: ProjectsRunner = runInOrg,
): Promise<Response> {
  const method = request.method;
  const [project, second, environment] = segments;
  type Op = { write: boolean; run: () => Promise<Response> };
  let op: Op | null = null;

  if (segments.length === 0) {
    if (method === "GET") op = { write: false, run: async () => list() };
    else if (method === "POST") op = { write: true, run: async () => create() };
  } else if (segments.length === 1 && UUID_RE.test(project!)) {
    if (method === "GET") op = { write: false, run: async () => show(project!) };
    else if (method === "PATCH") op = { write: true, run: async () => update(project!) };
    else if (method === "DELETE") op = { write: true, run: async () => remove(project!) };
  } else if (segments.length === 2 && UUID_RE.test(project!) && second === "environments") {
    if (method === "GET") op = { write: false, run: async () => environments(project!) };
    else if (method === "POST") op = { write: true, run: async () => createEnv(project!) };
  } else if (segments.length === 3 && UUID_RE.test(project!) && second === "environments" && UUID_RE.test(environment!)) {
    if (method === "GET") op = { write: false, run: async () => showEnv(project!, environment!) };
    else if (method === "PATCH") op = { write: true, run: async () => updateEnv(project!, environment!) };
    else if (method === "DELETE") op = { write: true, run: async () => removeEnv(project!, environment!) };
  } else {
    return errorResponse("not_found", "Not found", 404, requestId);
  }
  if (!op) return methodNotAllowed(requestId);

  if (!env.PLATFORM_DB || !env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  const ctx = await fetchAuthorizationContext(env.MEMBERSHIP_WORKER, actor.subjectId, actor.subjectType, orgId, requestId);
  if (!ctx.ok) return deniedResponse(env.ENVIRONMENT, requestId, ctx.reason);
  const ask = (action: string) =>
    authorizeViaPolicy(env.POLICY_WORKER!, actor.subjectId, actor.subjectType, action, { kind: "organization", orgId: orgId as never }, ctx.memberships, requestId);
  // Reads also say whether the caller may write (Coolify's @can('createAnyResource' | 'update' | 'delete', …) in the views).
  const [read, write] = await Promise.all([op.write ? Promise.resolve<AuthorizeResult>({ allow: true }) : ask("deploy.resource.read"), ask("deploy.resource.write")]);
  if (!read.allow || (op.write && !write.allow)) return deniedResponse(env.ENVIRONMENT, requestId, (read.allow ? write.reason : read.reason) ?? "denied", { memberships: ctx.memberships.length });
  const canWrite = write.allow;

  async function list(): Promise<Response> {
    const projects = await runner(env, orgId, (store) => listProjects(store));
    return successResponse({ projects, canWrite }, requestId);
  }

  async function create(): Promise<Response> {
    const v = validateNameAndDescription(await readJson(request));
    if (!v.ok) return validationError(requestId, v.errors);
    return successResponse(await runner(env, orgId, (store) => createProject(store, v.input)), requestId, 201);
  }

  async function show(uuid: string): Promise<Response> {
    const data = await runner(env, orgId, (store) => showProject(store, uuid));
    if (!data) return errorResponse("not_found", "Not found", 404, requestId);
    return successResponse({ ...data, canUpdate: canWrite, canDelete: canWrite }, requestId);
  }

  async function update(uuid: string): Promise<Response> {
    const v = validateNameAndDescription(await readJson(request));
    if (!v.ok) return validationError(requestId, v.errors);
    const row = await runner(env, orgId, (store) => updateProject(store, uuid, v.input));
    if (!row) return errorResponse("not_found", "Not found", 404, requestId);
    return successResponse({ uuid: row.uuid, name: row.name, description: row.description ?? null, message: PROJECT_MESSAGES.updated }, requestId);
  }

  async function remove(uuid: string): Promise<Response> {
    const deleted = await runner(env, orgId, (store) => deleteProject(store, uuid));
    if (!deleted) return errorResponse("not_found", "Not found", 404, requestId);
    return successResponse({ deleted: true }, requestId);
  }

  async function environments(projectUuid: string): Promise<Response> {
    const rows = await runner(env, orgId, (store) => listEnvironments(store, projectUuid));
    if (!rows) return errorResponse("not_found", "Not found", 404, requestId);
    return successResponse({ environments: rows, canWrite }, requestId);
  }

  async function createEnv(projectUuid: string): Promise<Response> {
    const v = validateNameAndDescription(await readJson(request));
    if (!v.ok) return validationError(requestId, v.errors);
    const created = await runner(env, orgId, (store) => createEnvironment(store, projectUuid, v.input));
    if (!created) return errorResponse("not_found", "Not found", 404, requestId);
    return successResponse(created, requestId, 201);
  }

  async function showEnv(projectUuid: string, environmentUuid: string): Promise<Response> {
    const data = await runner(env, orgId, (store) => showEnvironment(store, projectUuid, environmentUuid));
    if (!data) return errorResponse("not_found", "Not found", 404, requestId);
    return successResponse({ ...data, canUpdate: canWrite, canDelete: canWrite }, requestId);
  }

  async function updateEnv(projectUuid: string, environmentUuid: string): Promise<Response> {
    const v = validateNameAndDescription(await readJson(request));
    if (!v.ok) return validationError(requestId, v.errors);
    const row = await runner(env, orgId, (store) => updateEnvironment(store, projectUuid, environmentUuid, v.input));
    if (!row) return errorResponse("not_found", "Not found", 404, requestId);
    return successResponse({ uuid: row.uuid, name: row.name, description: row.description ?? null }, requestId);
  }

  async function removeEnv(projectUuid: string, environmentUuid: string): Promise<Response> {
    const deleted = await runner(env, orgId, (store) => deleteEnvironment(store, projectUuid, environmentUuid));
    if (!deleted) return errorResponse("not_found", "Not found", 404, requestId);
    return successResponse({ deleted: true }, requestId);
  }

  try {
    return await op.run();
  } catch (e) {
    return failure(e, requestId);
  }
}
