// Derived from coollabsio/coolify@91b7e3e:routes/web.php (project.clone-me, its can.create.resources middleware),
// app/Http/Middleware/CanCreateResources.php and app/Livewire/Project/CloneMe.php (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/projects/{uuid}/environments/{env_uuid}/clone — an environment's Clone page (DP-100):
//
//   GET    …/clone   CloneMe::mount(): the environment, its resources, the destinations, the default name
//   POST   …/clone   CloneMe::clone($type) { type: "environment" | "project", newName, selectedDestination, cloneVolumeData }
//
// Coolify's route needs createAnyResource (can.create.resources: 403), and clone() authorizes update on the project,
// placeResource on the server and, with cloneVolumeData, deploy / manage / stop on each source. Here every one of
// them is deploy.resource.write, asked before anything runs; a denial answers 404 (never leaks). Everything runs in one
// transaction confined to the org (withOrg): an answer that is not a success leaves nothing stored.
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  findProjectByUuid,
  findEnvironmentByUuid,
  listEnvironmentApplications,
  listEnvironmentDatabases,
  listEnvironmentServices,
  listOperationServers,
  listOperationDestinations,
  findDestinationByUuid,
  findServerByUuid,
  projectNameExists,
  environmentNameExists,
  insertProject,
  insertEnvironment,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse, validationError } from "../http.js";
import { authorizeDeploy, readJson } from "./cloud-tokens.js";
import { applicationResourcesContext } from "./application-resources.js";
import { databaseResourcesContext } from "./database-resources.js";
import { SettingsFieldErrors } from "../applications/settings.js";
import { CloneMeError, cloneEnvironment, showCloneMe, type CloneMeContext, type CloneMeStore } from "../projects/clone-me.js";

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

export type EnvironmentCloneRunner = <T>(env: Env, orgId: string, fn: (ctx: CloneMeContext) => Promise<T>) => Promise<T>;

export function cloneMeSqlStore(tx: SqlExecutor, orgId: string): CloneMeStore {
  return {
    findProject: (uuid) => findProjectByUuid(tx, uuid),
    findEnvironment: (projectId, uuid) => findEnvironmentByUuid(tx, projectId, uuid),
    applications: (environmentId) => listEnvironmentApplications(tx, environmentId),
    databases: (environmentId) => listEnvironmentDatabases(tx, environmentId),
    services: (environmentId) => listEnvironmentServices(tx, environmentId),
    servers: () => listOperationServers(tx),
    destinations: () => listOperationDestinations(tx),
    findDestination: (uuid) => findDestinationByUuid(tx, uuid),
    findServer: (uuid) => findServerByUuid(tx, uuid),
    projectNameExists: (name) => projectNameExists(tx, name),
    environmentNameExists: (projectId, name) => environmentNameExists(tx, projectId, name),
    insertProject: (project) => insertProject(tx, { orgId, ...project }),
    insertEnvironment: (environment) => insertEnvironment(tx, { orgId, ...environment }),
  };
}

/** One org's clone context over a transaction confined to that org. */
export function cloneMeContext(tx: SqlExecutor, orgId: string, secret: string | undefined): CloneMeContext {
  return {
    store: cloneMeSqlStore(tx, orgId),
    application: applicationResourcesContext(tx, orgId, secret),
    database: (uuid) => databaseResourcesContext(tx, orgId, secret, uuid),
  };
}

export const runEnvironmentCloneInOrg: EnvironmentCloneRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => fn(cloneMeContext(tx, orgId, env.DEPLOY_ENCRYPTION_KEY)));
  } finally {
    await db.dispose();
  }
};

/** `runner` is replaceable for tests. */
export async function handleEnvironmentClone(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  target: { projectUuid: string; environmentUuid: string },
  request: Request,
  runner: EnvironmentCloneRunner = runEnvironmentCloneInOrg,
): Promise<Response> {
  const { projectUuid, environmentUuid } = target;
  if (!UUID_RE.test(projectUuid) || !UUID_RE.test(environmentUuid)) return errorResponse("not_found", "Not found", 404, requestId);
  if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed(requestId);

  // can.create.resources, update on the project, placeResource, the sources' abilities: the org-wide write.
  const auth = await authorizeDeploy(env, requestId, actor, orgId, true);
  if (!auth.ok) return auth.response;
  try {
    if (request.method === "GET") {
      const page = await runner(env, orgId, (ctx) => showCloneMe(ctx, projectUuid, environmentUuid));
      if (!page) return errorResponse("not_found", "Not found", 404, requestId);
      return successResponse(page, requestId);
    }
    const body = await readJson(request);
    // clone(string $type): anything but "project" clones into a new environment.
    const type = body.type === "project" ? "project" : "environment";
    const result = await runner(env, orgId, (ctx) => cloneEnvironment(ctx, projectUuid, environmentUuid, type, body));
    if (!result) return errorResponse("not_found", "Not found", 404, requestId);
    return successResponse(result, requestId, 201);
  } catch (e) {
    if (e instanceof SettingsFieldErrors) return validationError(requestId, e.fields);
    if (e instanceof CloneMeError) return errorResponse(e.status === 501 ? "unsupported" : "validation_failed", e.message, e.status, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}
