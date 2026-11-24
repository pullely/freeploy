// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/New/{Select,DockerImage}.php,
// app/Livewire/Project/Resource/{Index,Create}.php, app/Livewire/Project/Application/{Configuration,General,Heading}.php,
// app/Policies/ApplicationPolicy.php and app/Http/Controllers/Api/ApplicationsController.php
// (create_dockerimage_application) (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/applications — applications (a Docker image
// application for now), and under a project's environment the New Resource
// page's data and the environment's resources.
//
//   POST   /applications                    DockerImage::submit { type: "dockerimage", project_uuid, environment_uuid,
//                                           server_uuid, destination_uuid, imageName, imageTag, imageSha256 }: the
//                                           application and its settings row; nothing is deployed
//   GET    /applications/{uuid}             Configuration + General: the application with its project, environment,
//                                           destination and server
//   PATCH  /applications/{uuid}             General::submit, the fields of a Docker image application
//   POST   /applications/{uuid}/deploy      Heading::deploy    501: needs the SSH executor
//   POST   /applications/{uuid}/restart     Heading::restart   501
//   POST   /applications/{uuid}/stop        Heading::stop      501
//   GET, PATCH /applications/{uuid}/{domains,advanced,healthcheck,resource-limits}   application-settings.ts
//
// and, routed here by route() (router.ts):
//
//   GET    /projects/{uuid}/environments/{env_uuid}/new         Select: servers, destinations, resource types
//   GET    /projects/{uuid}/environments/{env_uuid}/resources   Resource\Index: the environment's applications
//
// There is no DELETE: Coolify's delete runs commands on the server.
//
// Coolify's policy: view = who can open the application, create = who can
// create in the environment (createAnyResource), update = write, deploy = the
// deploy level. Here: deploy.resource.read and deploy.resource.write, asked of
// policy-worker after membership-worker's facts; a denial answers 404 (never
// leaks).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  findProjectByUuid,
  findEnvironmentByUuid,
  listEnvironments,
  listUsableServerDestinations,
  findDestinationByUuid,
  findServerByUuid,
  findApplicationByUuid,
  listEnvironmentApplications,
  insertDockerImageApplication,
  updateApplicationGeneral,
  listApplicationDomains,
  listResourceServers,
  APPLICATION_WEBHOOK_SECRET_COLUMNS,
  type ApplicationWebhookSecretColumn,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse, validationError } from "../http.js";
import type { KeyCipher } from "../private-keys/service.js";
import { authorizeDeploy, columnCipher, readJson } from "./cloud-tokens.js";
import { validateCreateDockerImage, validateGeneral } from "../applications/validation.js";
import { handleApplicationSettings, isApplicationSettingsSection } from "./application-settings.js";
import {
  ApplicationError,
  createDockerImageApplication,
  environmentResources,
  newResourcePage,
  showApplication,
  unavailableAction,
  updateGeneral,
  type ApplicationAction,
  type ApplicationContext,
  type ApplicationStore,
} from "../applications/service.js";

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;
const ACTIONS: readonly string[] = ["deploy", "restart", "stop"];

/** The pages of a project's environment that this handler serves. */
export const ENVIRONMENT_RESOURCE_PAGES: readonly string[] = ["new", "resources"];

/** Runs fn with one org's application store and cipher, in one transaction confined to that org. */
export type ApplicationRunner = <T>(env: Env, orgId: string, fn: (ctx: ApplicationContext) => Promise<T>) => Promise<T>;

function sqlStore(tx: SqlExecutor, orgId: string): ApplicationStore {
  return {
    findProject: (uuid) => findProjectByUuid(tx, uuid),
    findEnvironment: (projectId, uuid) => findEnvironmentByUuid(tx, projectId, uuid),
    environments: (projectId) => listEnvironments(tx, projectId),
    resourceServers: (kind) => listResourceServers(tx, kind),
    usableDestinations: () => listUsableServerDestinations(tx),
    findDestination: (uuid) => findDestinationByUuid(tx, uuid),
    findServer: (uuid) => findServerByUuid(tx, uuid),
    insertDockerImage: (application) => insertDockerImageApplication(tx, { ...application, orgId }),
    findByUuid: (uuid) => findApplicationByUuid(tx, uuid),
    listForEnvironment: (environmentId) => listEnvironmentApplications(tx, environmentId),
    updateGeneral: (id, changes) => updateApplicationGeneral(tx, id, changes),
    domains: () => listApplicationDomains(tx),
  };
}

export const runApplicationsInOrg: ApplicationRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => {
      // One cipher per encrypted column: the value is bound to "applications.<column>".
      const ciphers = Object.fromEntries(
        APPLICATION_WEBHOOK_SECRET_COLUMNS.map((c) => [c, columnCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, `applications.${c}`)]),
      ) as Record<ApplicationWebhookSecretColumn, KeyCipher>;
      return fn({ store: sqlStore(tx, orgId), encrypt: (column, plaintext) => ciphers[column].encrypt(plaintext) });
    });
  } finally {
    await db.dispose();
  }
};

function failure(e: unknown, requestId: string): Response {
  if (e instanceof ApplicationError) {
    const code = e.status === 501 ? "unsupported" : e.status === 409 ? "conflict" : e.status === 404 ? "not_found" : "validation_failed";
    return errorResponse(code, e.message, e.status, requestId, e.conflicts ? { conflicts: e.conflicts } : undefined);
  }
  return errorResponse("internal_error", "Service unavailable", 503, requestId);
}

type Op = { write: boolean; run: (canWrite: boolean) => Promise<Response> };

async function authorized(env: Env, requestId: string, actor: ActorContext, orgId: string, op: Op): Promise<Response> {
  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;
  try {
    return await op.run(auth.canWrite);
  } catch (e) {
    return failure(e, requestId);
  }
}

/**
 * segments: what follows /applications, split on "/" ([] for the collection).
 * `runner` is replaceable for tests.
 */
export async function handleApplications(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segments: string[],
  request: Request,
  runner: ApplicationRunner = runApplicationsInOrg,
): Promise<Response> {
  const method = request.method;
  const [first, second] = segments;
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  // The Domains, Advanced, Healthcheck and Resource Limits pages (application-settings.ts).
  if (segments.length === 2 && isApplicationSettingsSection(second)) return handleApplicationSettings(env, requestId, actor, orgId, first!, second, request);
  let op: Op | null = null;

  if (segments.length === 0) {
    if (method === "POST") op = { write: true, run: create };
  } else if (segments.length === 1 && UUID_RE.test(first!)) {
    if (method === "GET") op = { write: false, run: (canWrite) => show(first!, canWrite) };
    else if (method === "PATCH") op = { write: true, run: () => update(first!) };
  } else if (segments.length === 2 && UUID_RE.test(first!) && ACTIONS.includes(second!)) {
    // @can('deploy', $application)
    if (method === "POST") op = { write: true, run: () => action(first!, second as ApplicationAction) };
  } else {
    return notFound();
  }
  if (!op) return methodNotAllowed(requestId);

  async function create(): Promise<Response> {
    const v = validateCreateDockerImage(await readJson(request));
    if (!v.ok) return validationError(requestId, v.errors);
    const created = await runner(env, orgId, (c) => createDockerImageApplication(c, v.input));
    if (!created) return notFound();
    return successResponse(created, requestId, 201);
  }

  async function show(uuid: string, canWrite: boolean): Promise<Response> {
    const application = await runner(env, orgId, (c) => showApplication(c, uuid, canWrite));
    if (!application) return notFound();
    // The views' @can('update' | 'deploy', $application).
    return successResponse({ application, canUpdate: canWrite, canDeploy: canWrite }, requestId);
  }

  async function update(uuid: string): Promise<Response> {
    const body = await readJson(request);
    const saved = await runner(env, orgId, async (c) => {
      const current = await c.store.findByUuid(uuid);
      if (!current) return null;
      const v = validateGeneral(body, { fqdn: current.fqdn ?? null });
      if (!v.ok) return { errors: v.errors };
      return updateGeneral(c, uuid, v.input);
    });
    if (!saved) return notFound();
    if ("errors" in saved) return validationError(requestId, saved.errors);
    return successResponse(saved, requestId);
  }

  async function action(uuid: string, name: ApplicationAction): Promise<Response> {
    await runner(env, orgId, (c) => unavailableAction(c, uuid, name));
    return notFound();
  }

  return authorized(env, requestId, actor, orgId, op);
}

/**
 * The New Resource page's data and the environment's resources:
 * /projects/{projectUuid}/environments/{environmentUuid}/{page}.
 */
export async function handleEnvironmentResources(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  path: { projectUuid: string; environmentUuid: string; page: string },
  request: Request,
  runner: ApplicationRunner = runApplicationsInOrg,
): Promise<Response> {
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  if (!UUID_RE.test(path.projectUuid) || !UUID_RE.test(path.environmentUuid) || !ENVIRONMENT_RESOURCE_PAGES.includes(path.page)) return notFound();
  if (request.method !== "GET") return methodNotAllowed(requestId);

  const op: Op =
    path.page === "new"
      ? {
          // Create::mount(): $this->authorize('createAnyResource', [$environment]).
          write: true,
          run: async () => {
            const page = await runner(env, orgId, (c) => newResourcePage(c, path.projectUuid, path.environmentUuid));
            return page ? successResponse(page, requestId) : notFound();
          },
        }
      : {
          write: false,
          run: async (canWrite) => {
            const data = await runner(env, orgId, (c) => environmentResources(c, path.projectUuid, path.environmentUuid));
            // @can('createAnyResource') for "New" / "Add resource".
            return data ? successResponse({ ...data, canCreate: canWrite }, requestId) : notFound();
          },
        };
  return authorized(env, requestId, actor, orgId, op);
}
