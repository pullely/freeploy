// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/New/Select.php (loadServices),
// app/Livewire/Project/Resource/Create.php (createResource) and app/Policies/ServicePolicy.php
// (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/services — one-click services.
//
//   GET    /services/templates   Select::loadServices: the catalogue for the New Resource page (no Compose
//                                files) and its categories
//   POST   /services             Create::createResource { type: "one-click-service-<name>", project_uuid,
//                                environment_uuid, destination_uuid, server_uuid? }: the service and the rows
//                                its Compose file is parsed into; nothing is deployed
//   GET    /services/{uuid}      the service with its applications and databases
//
// Coolify's policy: view = who can open the service, create = who can create in the environment
// (createAnyResource). Here: deploy.resource.read and deploy.resource.write, asked of policy-worker
// after membership-worker's facts; a denial answers 404 (never leaks).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  findProjectByUuid,
  findEnvironmentByUuid,
  findDestinationByUuid,
  findServerByUuid,
  findServiceServer,
  insertParsedService,
  findServiceByUuid,
  listServiceApplications,
  listServiceDatabases,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse, validationError } from "../http.js";
import { authorizeDeploy, columnCipher, readJson } from "./cloud-tokens.js";
import { handleServiceConfiguration, isServiceConfigurationRoute } from "./service-configuration.js";
import { ServiceError, createOneClickService, listServiceTemplates, showService, validateCreateService, type ServiceContext, type ServiceCreateDependencies, type ServiceStore } from "../services/service.js";

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

/** Runs fn with one org's service store and ciphers, in one transaction confined to that org. */
export type ServiceRunner = <T>(env: Env, orgId: string, fn: (ctx: ServiceContext) => Promise<T>) => Promise<T>;

function sqlStore(tx: SqlExecutor, orgId: string): ServiceStore {
  return {
    findProject: (uuid) => findProjectByUuid(tx, uuid),
    findEnvironment: (projectId, uuid) => findEnvironmentByUuid(tx, projectId, uuid),
    findDestination: (uuid) => findDestinationByUuid(tx, uuid),
    findServer: (uuid) => findServerByUuid(tx, uuid),
    serviceServer: (serverId) => findServiceServer(tx, serverId),
    insert: (service) => insertParsedService(tx, { ...service, orgId }),
    findByUuid: (uuid) => findServiceByUuid(tx, uuid),
    applications: (serviceId) => listServiceApplications(tx, serviceId),
    databases: (serviceId) => listServiceDatabases(tx, serviceId),
  };
}

/** One org's service store and ciphers over a transaction (also /api/v1's, DP-74). */
export function serviceContext(tx: SqlExecutor, orgId: string, secret: string | undefined): ServiceContext {
  // One cipher per encrypted column: the value is bound to "<table>.<column>".
  const variables = columnCipher(tx, orgId, secret, "environment_variables.value");
  const files = columnCipher(tx, orgId, secret, "local_file_volumes.content");
  return { store: sqlStore(tx, orgId), encryptVariable: (plaintext) => variables.encrypt(plaintext), encryptFileContent: (plaintext) => files.encrypt(plaintext) };
}

export const runServicesInOrg: ServiceRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => fn(serviceContext(tx, orgId, env.DEPLOY_ENCRYPTION_KEY)));
  } finally {
    await db.dispose();
  }
};

/**
 * segments: what follows /services, split on "/" ([] for the collection). `runner` and `deps` (the uuids
 * and the parser's randomness) are replaceable for tests.
 */
export async function handleServices(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segments: string[],
  request: Request,
  runner: ServiceRunner = runServicesInOrg,
  deps: ServiceCreateDependencies = {},
): Promise<Response> {
  // The configuration pages of a service (DP-66).
  if (isServiceConfigurationRoute(segments)) return handleServiceConfiguration(env, requestId, actor, orgId, segments, request, undefined, undefined, deps);
  const method = request.method;
  const [first] = segments;
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  let write: boolean;
  let run: (canWrite: boolean) => Promise<Response>;

  if (segments.length === 0) {
    if (method !== "POST") return methodNotAllowed(requestId);
    write = true;
    run = async () => {
      const validated = validateCreateService(await readJson(request));
      if (!validated.ok) return validationError(requestId, validated.errors);
      const created = await runner(env, orgId, (ctx) => createOneClickService(ctx, validated.input, deps));
      return created ? successResponse(created, requestId, 201) : notFound();
    };
  } else if (segments.length === 1 && first === "templates") {
    if (method !== "GET") return methodNotAllowed(requestId);
    write = false;
    // The catalogue is the same for every org; only who may read it is asked.
    run = () => Promise.resolve(successResponse(listServiceTemplates(), requestId));
  } else if (segments.length === 1 && UUID_RE.test(first!)) {
    if (method !== "GET") return methodNotAllowed(requestId);
    write = false;
    run = async (canWrite) => {
      const service = await runner(env, orgId, (ctx) => showService(ctx, first!, canWrite));
      return service ? successResponse({ service }, requestId) : notFound();
    };
  } else {
    return notFound();
  }

  const auth = await authorizeDeploy(env, requestId, actor, orgId, write);
  if (!auth.ok) return auth.response;
  try {
    return await run(auth.canWrite);
  } catch (error) {
    if (error instanceof ServiceError) {
      return errorResponse(error.status === 404 ? "not_found" : "validation_failed", error.message, error.status, requestId);
    }
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}
