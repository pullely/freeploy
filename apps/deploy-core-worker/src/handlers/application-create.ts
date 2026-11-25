// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/New/{SimpleDockerfile,PublicGitRepository,DockerCompose}.php,
// app/Traits/HasRepositoryDetection.php and app/Http/Controllers/Api/ApplicationsController.php
// (create_public_application, create_dockerfile_application) (Apache-2.0), modified.
//
// The parts of /v1/organizations/{org}/deploy/applications that create an
// application which is built, dispatched from handleApplications (which
// authorizes: deploy.resource.write, a denial 404):
//
//   POST /applications { type: "dockerfile", …, dockerfile }                 SimpleDockerfile::submit
//   POST /applications { type: "public", …, repository_url, git_branch,     PublicGitRepository::submit
//                        build_pack, port, isStatic, publish_directory,
//                        base_directory, docker_compose_location, selectedDockerfile }
//   POST /applications { type: "dockercompose" }                             501: New\DockerCompose creates a Service,
//                                                                            which needs the Compose parser
//   POST /applications/git/check { repository_url, rate_limit_remaining }    PublicGitRepository::loadBranch
//   POST /applications/git/scan  { git_branch, base_directory,               HasRepositoryDetection::detectRepository:
//                                  destination_uuid }                         501 after its checks, needs the SSH executor
//
// Nothing is deployed by any of them.
import type { Env } from "../env.js";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  insertBuiltApplication,
  findApplicationBuild,
  updateApplicationBuild,
  findOtherApplicationBuildingImage,
  deleteApplicationServiceVariables,
  clearApplicationFileStoragesBasedOnGit,
  listResourceServers,
} from "@saas/db/deploy";
import { errorResponse, successResponse, validationError } from "../http.js";
import { columnCipher } from "./cloud-tokens.js";
import {
  ApplicationValidationError,
  checkRepository,
  createDockerfileApplication,
  createPublicApplication,
  scanRepository,
  validateCreateDockerfile,
  validateCreatePublic,
  type ApplicationBuildContext,
  type ApplicationBuildStore,
  type BuildingContext,
} from "../applications/create.js";
import type { GithubDeps } from "../applications/github.js";
import type { ApplicationContext } from "../applications/service.js";

type Runner = <T>(env: Env, orgId: string, fn: (ctx: ApplicationContext) => Promise<T>) => Promise<T>;
type Body = Record<string, unknown>;

/** The `type` values of POST /applications this file answers ("dockerimage" stays with handleApplications). */
const BUILT_TYPES: readonly string[] = ["dockerfile", "public", "dockercompose"];
export const isBuiltApplicationType = (type: unknown): boolean => typeof type === "string" && BUILT_TYPES.includes(type);

/** The actions under /applications/git. */
const GIT_ACTIONS: readonly string[] = ["check", "scan"];
export const isGitAction = (action: string | undefined): boolean => action !== undefined && GIT_ACTIONS.includes(action);

export const CREATE_HANDLER_MESSAGES = {
  /** Freeploy's: New\DockerCompose stores a Service and parses its Compose file into applications and databases. */
  composeUnavailable: "Creating a service from a Docker Compose file needs the Compose parser, which is not available yet.",
} as const;

/** The build store over one org's transaction. */
export function sqlBuildStore(tx: SqlExecutor, orgId: string): ApplicationBuildStore {
  return {
    insert: (application) => insertBuiltApplication(tx, { ...application, orgId }),
    findBuild: (uuid) => findApplicationBuild(tx, uuid),
    updateBuild: (id, changes, settings) => updateApplicationBuild(tx, id, changes, settings),
    otherApplicationBuildingImage: (id, imageName) => findOtherApplicationBuildingImage(tx, id, imageName),
    deleteServiceVariables: (id) => deleteApplicationServiceVariables(tx, id),
    clearFileStoragesBasedOnGit: (id) => clearApplicationFileStoragesBasedOnGit(tx, id),
    // Server::buildServers(): the usable servers whose role is build.
    hasBuildServers: async () => (await listResourceServers(tx, "build")).length > 0,
  };
}

/** The build store and the cipher of environment_variables.value, for runApplicationsInOrg. */
export function sqlBuildContext(tx: SqlExecutor, orgId: string, secret: string | undefined): ApplicationBuildContext {
  const cipher = columnCipher(tx, orgId, secret, "environment_variables.value");
  return { store: sqlBuildStore(tx, orgId), encryptVariable: (plaintext) => cipher.encrypt(plaintext) };
}

const unavailable = (requestId: string) => errorResponse("internal_error", "Service unavailable", 503, requestId);

/** POST /applications for the types that are built. */
export async function createBuiltApplication(env: Env, orgId: string, requestId: string, body: Body, runner: Runner): Promise<Response> {
  if (body.type === "dockercompose") return errorResponse("unsupported", CREATE_HANDLER_MESSAGES.composeUnavailable, 501, requestId);
  const created = await runner(env, orgId, async (c) => {
    if (!c.build) return "unavailable" as const;
    const ctx: BuildingContext = { ...c, build: c.build };
    if (body.type === "dockerfile") {
      const v = validateCreateDockerfile(body);
      return v.ok ? createDockerfileApplication(ctx, v.input) : { errors: v.errors };
    }
    const v = validateCreatePublic(body);
    return v.ok ? createPublicApplication(ctx, v.input) : { errors: v.errors };
  });
  if (created === "unavailable") return unavailable(requestId);
  if (!created) return errorResponse("not_found", "Not found", 404, requestId);
  if ("errors" in created) return validationError(requestId, created.errors);
  return successResponse(created, requestId, 201);
}

/** PHP's (int) of the form's rate_limit_remaining. */
const remaining = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : 0);

/** POST /applications/git/{check,scan}. */
export async function handleGitAction(env: Env, orgId: string, requestId: string, action: string, body: Body, runner: Runner, github: GithubDeps): Promise<Response> {
  if (action === "check") return successResponse(await checkRepository(github, body.repository_url, remaining(body.rate_limit_remaining)), requestId);
  try {
    await runner(env, orgId, (c) => scanRepository(c, body));
  } catch (e) {
    if (e instanceof ApplicationValidationError) return validationError(requestId, e.fields);
    throw e;
  }
  return unavailable(requestId);
}
