// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/New/{SimpleDockerfile,PublicGitRepository}.php,
// app/Traits/HasRepositoryDetection.php (detectRepository's checks, selectedDockerfileLocation),
// app/Models/{Application,EnvironmentVariable}.php (the creating and created hooks, the base_directory,
// publish_directory, dockerfile_location and docker_compose_location mutators, parseHealthcheckFromDockerfile),
// app/Support/ValidationPatterns.php (directoryPathRules, filePathRules, normalizeDirectoryPath) and
// database/seeders/ProductionSeeder.php (the public GitHub source) (Apache-2.0), modified.
//
// Two more ways to create an application: from a Dockerfile typed into the
// form, and from a public Git repository. As with a Docker image, creating
// stores the rows and deploys nothing. The Public Git Repository form's
// "Check repository" asks GitHub whether the branch exists (through a fetch
// the caller hands in); its Smart Scan clones the repository on the server,
// which needs the SSH executor.
import type { ApplicationWebhookSecretColumn, DeployApplicationBuildRow, NewApplicationVariable, NewBuiltApplication, ApplicationBuildChanges, ApplicationBuildSettingChanges } from "@saas/db/deploy";
import { APPLICATION_WEBHOOK_SECRET_COLUMNS, PUBLIC_GITHUB_SOURCE } from "@saas/db/deploy";
import { generateRandomName, newPublicId, randomString } from "../helpers/names.js";
import { ENVIRONMENT_VARIABLE_VERSION } from "../environment-variables/service.js";
import { add, blank, length, type FieldErrors } from "../private-keys/validation.js";
import { effectiveServerRole } from "../servers/service.js";
import { LARAVEL } from "../servers/settings-validation.js";
import { dockerfileHealthcheckInstruction, dockerfileHealthcheckOptions, getPortFromDockerfile } from "./dockerfile.js";
import { generateUrl, normalizeDomainPortOverrides } from "./domains.js";
import { generateApplicationName, gitBranchError, gitRepositoryUrlError, gitSourceOfUrl, normalizeRepositoryUrl, phpTrim } from "./git.js";
import { GithubApiError, lookupGithubBranch, type GithubDeps } from "./github.js";
import { APPLICATION_SERVICE_MESSAGES, ApplicationError, type ApplicationContext } from "./service.js";

/** The queries of the applications that are built, beside ApplicationStore's. */
export interface ApplicationBuildStore {
  insert(application: Omit<NewBuiltApplication, "orgId">): Promise<string | number>;
  findBuild(uuid: string): Promise<DeployApplicationBuildRow | null>;
  updateBuild(id: string | number, changes: ApplicationBuildChanges, settings: ApplicationBuildSettingChanges): Promise<void>;
  /** Application::otherApplicationBuildingSameImage() */
  otherApplicationBuildingImage(id: string | number, imageName: string): Promise<{ uuid: string; name: string } | null>;
  /** The saving hook: the SERVICE_FQDN_* and SERVICE_URL_* variables go when the build pack leaves Docker Compose. */
  deleteServiceVariables(id: string | number): Promise<number>;
  clearFileStoragesBasedOnGit(id: string | number): Promise<void>;
  /** Server::buildServers($teamId)->exists() */
  hasBuildServers(): Promise<boolean>;
  /** DP-72: one of the org's registered private GitHub Apps, by uuid (GithubPrivateRepository's source). */
  findGithubApp?(uuid: string): Promise<{ id: string | number; uuid: string } | null>;
  /** DP-72: one of the org's private keys, by uuid (GithubPrivateRepositoryDeployKey::setPrivateKey). */
  findPrivateKey?(uuid: string): Promise<{ id: string | number } | null>;
}

export interface ApplicationBuildContext {
  store: ApplicationBuildStore;
  /** Encrypts an environment variable's value (environment_variables.value) under the org's key. */
  encryptVariable(plaintext: string): Promise<string>;
}

/** An ApplicationContext whose runner also carries the build store. */
export type BuildingContext = ApplicationContext & { build: ApplicationBuildContext };

export const CREATE_MESSAGES = {
  /** Freeploy's: Smart Scan clones the repository on the server. */
  scanUnavailable: "Scanning the repository needs the SSH executor, which is not available yet.",
  /** ValidationPatterns::filePathMessages('selectedDockerfile', 'Dockerfile') */
  dockerfileLocationRegex: "The Dockerfile location must be a valid path starting with / and containing only alphanumeric characters, dots, hyphens, underscores, slashes, @, ~, and +.",
} as const;

/** ValidationPatterns::FILE_PATH_PATTERN */
export const FILE_PATH_PATTERN = /^\/[a-zA-Z0-9._\-/~@+]+$/;
/** ValidationPatterns::DIRECTORY_PATH_PATTERN: like FILE_PATH_PATTERN, and a bare "/". */
export const DIRECTORY_PATH_PATTERN = /^\/([a-zA-Z0-9._\-/~@+]*)?$/;

/** ValidationPatterns::normalizeDirectoryPath(): "apps/web/" is "/apps/web", an empty value "/". */
export const normalizeDirectoryPath = (path: string | null | undefined): string => `/${phpTrim(path ?? "").replace(/^\/+|\/+$/g, "")}`;

/** The base_directory mutator: '/'.ltrim($value, '/'). */
export const baseDirectoryForStorage = (value: string): string => `/${value.replace(/^\/+/, "")}`;
/** The publish_directory mutator: $value ? '/'.ltrim($value, '/') : null. */
export const publishDirectoryForStorage = (value: string | null): string | null => (value === null || value === "" || value === "0" ? null : `/${value.replace(/^\/+/, "")}`);

/** Str::start(Str::replaceEnd('/', '', $value), '/') unless the value is "/". */
const locationPath = (value: string): string => {
  const path = value !== "/" && value.endsWith("/") ? value.slice(0, -1) : value;
  return `/${path.replace(/^\/+/, "")}`;
};
/** The dockerfile_location mutator: an empty value is '/Dockerfile' for the Dockerfile build pack, else null. */
export const dockerfileLocationForStorage = (value: string | null, buildPack: string): string | null =>
  value === null || value === "" ? (buildPack === "dockerfile" ? "/Dockerfile" : null) : locationPath(value);
/** The docker_compose_location mutator: an empty value is '/docker-compose.yaml'. */
export const dockerComposeLocationForStorage = (value: string | null): string => (value === null || value === "" ? "/docker-compose.yaml" : locationPath(value));

/** A ValidationException: Laravel's messages by field. */
export class ApplicationValidationError extends Error {
  constructor(readonly fields: FieldErrors) {
    super("Validation failed");
  }
}

type Result<T> = { ok: true; input: T } | { ok: false; errors: FieldErrors };
type Body = Record<string, unknown>;

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

export interface CreationTarget {
  projectUuid: string;
  environmentUuid: string;
  /** Optional: when given, the destination must be one of this server's. */
  serverUuid: string | null;
  destinationUuid: string | null;
}

/** The route parameters and the query string of Coolify's page: the body's project_uuid, environment_uuid, server_uuid and destination_uuid. */
function creationTarget(errors: FieldErrors, body: Body): CreationTarget {
  for (const field of ["project_uuid", "environment_uuid"] as const) {
    if (blank(body[field])) add(errors, field, `The ${field.replace("_", " ")} field is required.`);
    else if (typeof body[field] !== "string" || !UUID_RE.test(body[field])) add(errors, field, `The selected ${field.replace("_", " ")} is invalid.`);
  }
  const uuid = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  return { projectUuid: body.project_uuid as string, environmentUuid: body.environment_uuid as string, serverUuid: uuid(body.server_uuid), destinationUuid: uuid(body.destination_uuid) };
}

export interface CreateDockerfileInput extends CreationTarget {
  dockerfile: string;
}

/** SimpleDockerfile::submit(): 'dockerfile' => 'required', with Laravel's default message. */
export function validateCreateDockerfile(body: Body): Result<CreateDockerfileInput> {
  const errors: FieldErrors = {};
  const target = creationTarget(errors, body);
  if (blank(body.dockerfile)) add(errors, "dockerfile", LARAVEL.required("dockerfile"));
  else if (typeof body.dockerfile !== "string") add(errors, "dockerfile", LARAVEL.string("dockerfile"));
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, input: { ...target, dockerfile: body.dockerfile as string } };
}

/** The build packs the Public Git Repository form's listbox offers. */
export const GIT_BUILD_PACKS = ["railpack", "nixpacks", "static", "dockerfile", "dockercompose"] as const;

export interface CreatePublicInput extends CreationTarget {
  repositoryUrl: string;
  gitBranch: string;
  buildPack: string;
  port: number;
  isStatic: boolean;
  publishDirectory: string | null;
  baseDirectory: string;
  dockerComposeLocation: string | null;
  /** HasRepositoryDetection's $selectedDockerfile: a path typed or picked for the Dockerfile build pack. */
  selectedDockerfile: string | null;
}

/** nullable|string|max:255|regex with Laravel's default messages for `attribute`. */
function pathRule(errors: FieldErrors, field: string, value: unknown, attribute: string, pattern: RegExp, regexMessage?: string): string | null {
  if (blank(value)) return typeof value === "string" ? value : null;
  if (typeof value !== "string") {
    add(errors, field, `The ${attribute} field must be a string.`);
    return null;
  }
  if (length(value) > 255) add(errors, field, `The ${attribute} field must not be greater than 255 characters.`);
  if (!pattern.test(value)) add(errors, field, regexMessage ?? `The ${attribute} field format is invalid.`);
  return value;
}

/** Laravel's `boolean` rule: true, false, 1, 0, "1" and "0". */
const asBoolean = (value: unknown): boolean | null => (value === true || value === 1 || value === "1" ? true : value === false || value === 0 || value === "0" ? false : null);

/** Laravel's `numeric` rule (is_numeric) for what JSON can carry. */
const isNumeric = (value: unknown): boolean => (typeof value === "number" ? Number.isFinite(value) : typeof value === "string" && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value));

/**
 * PublicGitRepository::submit(): the base directory is normalized first
 * (normalizeDirectoryPath), then rules() with $validationAttributes and
 * Laravel's default messages ("The repository field is required."). The
 * build pack must be one the form's listbox offers.
 */
export function validateCreatePublic(body: Body): Result<CreatePublicInput> {
  const errors: FieldErrors = {};
  const target = creationTarget(errors, body);

  if (blank(body.repository_url)) add(errors, "repository_url", "The repository field is required.");
  else if (typeof body.repository_url !== "string") add(errors, "repository_url", "The repository field must be a string.");
  else {
    const message = gitRepositoryUrlError("repository", body.repository_url);
    if (message) add(errors, "repository_url", message);
  }

  if (blank(body.port)) add(errors, "port", "The port field is required.");
  else if (!isNumeric(body.port)) add(errors, "port", "The port field must be a number.");

  const isStatic = body.isStatic === undefined || body.isStatic === null || body.isStatic === "" ? null : asBoolean(body.isStatic);
  if (body.isStatic === undefined || body.isStatic === null || body.isStatic === "") add(errors, "isStatic", "The static field is required.");
  else if (isStatic === null) add(errors, "isStatic", "The static field must be true or false.");

  if (!blank(body.publish_directory) && typeof body.publish_directory !== "string") add(errors, "publish_directory", "The publish directory field must be a string.");

  if (blank(body.build_pack)) add(errors, "build_pack", "The build pack field is required.");
  else if (typeof body.build_pack !== "string") add(errors, "build_pack", "The build pack field must be a string.");
  else if (!(GIT_BUILD_PACKS as readonly string[]).includes(body.build_pack)) add(errors, "build_pack", "The selected build pack is invalid.");

  const baseDirectory = normalizeDirectoryPath(typeof body.base_directory === "string" ? body.base_directory : null);
  pathRule(errors, "base_directory", baseDirectory, "base directory", DIRECTORY_PATH_PATTERN);
  const dockerComposeLocation = pathRule(errors, "docker_compose_location", body.docker_compose_location, "docker compose location", FILE_PATH_PATTERN);

  if (blank(body.git_branch)) add(errors, "git_branch", "The git branch field is required.");
  else if (typeof body.git_branch !== "string") add(errors, "git_branch", "The git branch field must be a string.");
  else {
    const message = gitBranchError("git branch", body.git_branch);
    if (message) add(errors, "git_branch", message);
  }

  // selectedDockerfileLocation(): "/<path>" through filePathRules(), for the Dockerfile build pack.
  let selectedDockerfile: string | null = null;
  if (body.build_pack === "dockerfile" && typeof body.selectedDockerfile === "string") {
    const path = phpTrim(body.selectedDockerfile).replace(/^\/+/, "");
    if (path !== "") selectedDockerfile = pathRule(errors, "selectedDockerfile", `/${path}`, "selected dockerfile", FILE_PATH_PATTERN, CREATE_MESSAGES.dockerfileLocationRegex);
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  const buildPack = body.build_pack as string;
  return {
    ok: true,
    input: {
      ...target,
      repositoryUrl: body.repository_url as string,
      gitBranch: body.git_branch as string,
      buildPack,
      port: Math.trunc(Number(body.port)),
      // updatedBuildPack(): only Nixpacks and Railpack have the "Static site" output type.
      isStatic: buildPack === "nixpacks" || buildPack === "railpack" ? isStatic === true : false,
      publishDirectory: typeof body.publish_directory === "string" ? body.publish_directory : null,
      baseDirectory,
      dockerComposeLocation,
      selectedDockerfile,
    },
  };
}

interface Created {
  uuid: string;
  projectUuid: string;
  environmentUuid: string;
}

/**
 * What every creation form does before it builds the application:
 * find_resource_destination_for_current_team() — one of the org's
 * destinations, on a server whose role can host resources — then the project
 * and its environment. Null when the project or the environment is not the
 * org's.
 */
export async function resolveTarget(ctx: ApplicationContext, target: CreationTarget) {
  const destination = target.destinationUuid ? await ctx.store.findDestination(target.destinationUuid) : null;
  const server = destination ? await ctx.store.findServer(destination.server_uuid) : null;
  if (!destination || !server || effectiveServerRole(server) === "build" || (target.serverUuid !== null && target.serverUuid !== server.uuid)) {
    throw new ApplicationError(APPLICATION_SERVICE_MESSAGES.destinationNotFound, 404);
  }
  const project = await ctx.store.findProject(target.projectUuid);
  if (!project) return null;
  const environment = await ctx.store.findEnvironment(project.id, target.environmentUuid);
  if (!environment) return null;
  return { destination, server, project, environment };
}

/** The creating hook: Str::random(40) for each manual webhook secret, encrypted for its column. */
export async function webhookSecrets(ctx: ApplicationContext): Promise<Record<ApplicationWebhookSecretColumn, string>> {
  const secrets = {} as Record<ApplicationWebhookSecretColumn, string>;
  for (const column of APPLICATION_WEBHOOK_SECRET_COLUMNS) secrets[column] = await ctx.encrypt(column, randomString(40));
  return secrets;
}

/**
 * SimpleDockerfile::submit(), after its validation: an application with the
 * Dockerfile's text, the port of its first EXPOSE (else 80), Coolify's
 * placeholder repository and the public GitHub source (source_id 0), named
 * "dockerfile-<uuid>" with generateUrl()'s domain; then
 * parseHealthcheckFromDockerfile(isInit: true) — a HEALTHCHECK in the file
 * sets the health check's timing and custom_healthcheck_found. Nothing is
 * deployed.
 */
export async function createDockerfileApplication(ctx: BuildingContext, input: CreateDockerfileInput): Promise<Created | null> {
  const target = await resolveTarget(ctx, input);
  if (!target) return null;
  const uuid = newPublicId();
  const domain = normalizeDomainPortOverrides(generateUrl({ ip: target.server.ip, wildcardDomain: target.server.wildcard_domain }, uuid), null);
  const healthcheck = dockerfileHealthcheckInstruction(input.dockerfile);
  await ctx.build.store.insert({
    uuid,
    name: `dockerfile-${uuid}`,
    fqdn: domain.fqdn,
    domainPortOverrides: domain.overrides,
    repositoryProjectId: 0,
    gitRepository: "coollabsio/coolify",
    gitBranch: "main",
    buildPack: "dockerfile",
    // "$port = get_port_from_dockerfile(…); if (! $port) { $port = 80; }"
    portsExposes: String(getPortFromDockerfile(input.dockerfile) || 80),
    baseDirectory: "/",
    publishDirectory: null,
    dockerfile: input.dockerfile,
    dockerfileLocation: null,
    dockerComposeLocation: null,
    healthCheckEnabled: false,
    dockerfileHealthcheck: healthcheck === null ? null : dockerfileHealthcheckOptions(healthcheck),
    sourceId: PUBLIC_GITHUB_SOURCE.id,
    sourceType: PUBLIC_GITHUB_SOURCE.type,
    isStatic: false,
    environmentId: target.environment.id,
    destinationId: target.destination.id,
    destinationType: target.destination.type,
    webhookSecrets: await webhookSecrets(ctx),
    variables: [],
  });
  return { uuid, projectUuid: target.project.uuid, environmentUuid: target.environment.uuid };
}

/**
 * The created hook for a Nixpacks application: NIXPACKS_NODE_VERSION = 22, a
 * build-time variable — and, through EnvironmentVariable's own created hook,
 * its preview copy.
 */
export async function nixpacksVariables(ctx: BuildingContext): Promise<NewApplicationVariable[]> {
  const variable = async (isPreview: boolean): Promise<NewApplicationVariable> => ({
    uuid: newPublicId(),
    key: "NIXPACKS_NODE_VERSION",
    value: await ctx.build.encryptVariable("22"),
    isMultiline: false,
    isLiteral: false,
    isBuildtime: true,
    isRuntime: false,
    isPreview,
    // EnvironmentVariable's creating hook: config('constants.coolify.version').
    version: ENVIRONMENT_VARIABLE_VERSION,
  });
  return [await variable(false), await variable(true)];
}

/**
 * PublicGitRepository::submit(), after rules(): the repository is read from
 * its URL again (getGitSource() — the component keeps it from "Check
 * repository"; this API keeps no state) and, for a host that is not
 * github.com, checked once more, as is the branch ("Invalid repository URL: …",
 * "Invalid branch: …"). A github.com repository is stored as `owner/name`
 * with the public GitHub source and named after the repository and branch;
 * any other one as its whole URL without a source, with a random name. The
 * settings row gets is_static, the application generateUrl()'s domain.
 * Nothing is deployed.
 */
export async function createPublicApplication(ctx: BuildingContext, input: CreatePublicInput): Promise<Created | null> {
  const source = gitSourceOfUrl(normalizeRepositoryUrl(input.repositoryUrl));
  if (source.gitSource === "other") {
    const message = gitRepositoryUrlError("git repository", source.gitRepository);
    if (message) throw new ApplicationError(`Invalid repository URL: ${message}`);
  }
  const branchMessage = gitBranchError("git branch", input.gitBranch);
  if (branchMessage) throw new ApplicationError(`Invalid branch: ${branchMessage}`);

  const target = await resolveTarget(ctx, input);
  if (!target) return null;
  const uuid = newPublicId();
  const domain = normalizeDomainPortOverrides(generateUrl({ ip: target.server.ip, wildcardDomain: target.server.wildcard_domain }, uuid), null);
  const { buildPack } = input;
  const publishDirectory = publishDirectoryForStorage(input.publishDirectory);
  await ctx.build.store.insert({
    uuid,
    name: source.gitSource === "other" ? generateRandomName() : generateApplicationName(source.gitRepository, input.gitBranch),
    fqdn: domain.fqdn,
    domainPortOverrides: domain.overrides,
    repositoryProjectId: null,
    // The saving hook trims the repository, the branch and both directories.
    gitRepository: phpTrim(source.gitRepository),
    gitBranch: phpTrim(input.gitBranch),
    buildPack,
    portsExposes: String(input.port),
    baseDirectory: phpTrim(baseDirectoryForStorage(input.baseDirectory)),
    publishDirectory: publishDirectory === null ? null : phpTrim(publishDirectory),
    dockerfile: null,
    dockerfileLocation: buildPack === "dockerfile" && input.selectedDockerfile !== null ? dockerfileLocationForStorage(input.selectedDockerfile, buildPack) : null,
    dockerComposeLocation: buildPack === "dockercompose" ? dockerComposeLocationForStorage(input.dockerComposeLocation) : null,
    healthCheckEnabled: buildPack === "dockerfile" ? false : null,
    dockerfileHealthcheck: null,
    sourceId: source.gitSource === "github" ? PUBLIC_GITHUB_SOURCE.id : null,
    sourceType: source.gitSource === "github" ? PUBLIC_GITHUB_SOURCE.type : null,
    isStatic: input.isStatic,
    environmentId: target.environment.id,
    destinationId: target.destination.id,
    destinationType: target.destination.type,
    webhookSecrets: await webhookSecrets(ctx),
    variables: buildPack === "nixpacks" ? await nixpacksVariables(ctx) : [],
  });
  return { uuid, projectUuid: target.project.uuid, environmentUuid: target.environment.uuid };
}

export interface RepositoryCheck {
  /** The URL as loadBranch() rewrites it. */
  repositoryUrl: string;
  gitHost: string;
  gitRepository: string;
  gitSource: "github" | "other";
  gitBranch: string;
  selectedBranch: string;
  baseDirectory: string;
  branchFound: true;
  rateLimitRemaining: number;
  /** 'Y-M-d H:i:s' in UTC, or 0 when GitHub was not asked or did not answer. */
  rateLimitReset: string | 0;
  /** Smart Scan runs right after the branch is found; it needs the server. */
  scan: { unavailable: string };
}

/**
 * PublicGitRepository::loadBranch(): the URL is validated ("Invalid
 * repository URL: …") and rewritten, the host, repository and branch read
 * from it (getGitSource), and for github.com the branch asked of GitHub
 * (getBranch). When GitHub refuses: with no requests left as far as the form
 * knows (`rateLimitRemaining` 0 — also the state of a first check) the branch
 * is taken as found; otherwise "main" is tried as "master"; any other failure
 * is the error. A repository on another host is not asked about: its branch
 * is taken as found. `rateLimitRemaining` is the form's value from its last
 * check (Livewire keeps it in the component).
 */
export async function checkRepository(deps: GithubDeps, repositoryUrl: unknown, knownRateLimitRemaining: number): Promise<RepositoryCheck> {
  const invalid = blank(repositoryUrl)
    ? "The repository url field is required."
    : typeof repositoryUrl !== "string"
      ? "The repository url field must be a string."
      : gitRepositoryUrlError("repository url", repositoryUrl);
  if (invalid) throw new ApplicationError(`Invalid repository URL: ${invalid}`);
  const url = normalizeRepositoryUrl(repositoryUrl as string);
  // getGitSource() validates the rewritten URL again.
  const rewritten = gitRepositoryUrlError("repository url", url);
  if (rewritten) throw new ApplicationError(`Invalid repository URL: ${rewritten}`);

  const source = gitSourceOfUrl(url);
  let gitBranch = source.gitBranch;
  let baseDirectory = "/";
  let rateLimitRemaining = knownRateLimitRemaining;
  let rateLimitReset: string | 0 = 0;
  const failure = (e: unknown): ApplicationError => new ApplicationError(e instanceof GithubApiError ? e.message : "GitHub API call failed");

  let refused = false;
  if (source.gitSource === "github") {
    const ask = async (branch: string): Promise<void> => {
      const found = await lookupGithubBranch(deps, PUBLIC_GITHUB_SOURCE.apiUrl, source.gitRepository, branch);
      ({ gitBranch, baseDirectory, rateLimitRemaining, rateLimitReset } = found);
    };
    try {
      await ask(gitBranch);
    } catch (e) {
      refused = true;
      if (rateLimitRemaining === 0) {
        // "$this->branchFound = true": the form goes on with the branch the URL named.
      } else if (gitBranch === "main") {
        try {
          await ask("master");
        } catch (second) {
          throw failure(second);
        }
      } else {
        throw failure(e);
      }
    }
  }
  // Inside loadBranch()'s try, after getBranch(): a tangled repository's branch is master — skipped when GitHub refused.
  if (!refused && url.includes("tangled")) gitBranch = "master";

  return {
    repositoryUrl: url,
    gitHost: source.gitHost,
    gitRepository: source.gitRepository,
    gitSource: source.gitSource,
    gitBranch,
    selectedBranch: gitBranch,
    baseDirectory,
    branchFound: true,
    rateLimitRemaining,
    rateLimitReset,
    scan: { unavailable: CREATE_MESSAGES.scanUnavailable },
  };
}

/**
 * HasRepositoryDetection::detectRepository() up to the scan: the branch and
 * the base directory are validated (Laravel's default messages), the
 * destination must be the org's — then RepositoryDetector clones the
 * repository on the server, which needs the SSH executor: 501.
 */
export async function scanRepository(ctx: ApplicationContext, body: Body): Promise<never> {
  const errors: FieldErrors = {};
  if (blank(body.git_branch)) add(errors, "branch", "The branch field is required.");
  else {
    const message = gitBranchError("branch", body.git_branch);
    if (message) add(errors, "branch", message);
  }
  const baseDirectory = body.base_directory ?? "/";
  if (blank(baseDirectory)) add(errors, "base_directory", "The base directory field is required.");
  else if (typeof baseDirectory !== "string") add(errors, "base_directory", "The base directory field must be a string.");
  else {
    // 'regex:~^/?(?:[a-zA-Z0-9_.-]+/)*[a-zA-Z0-9_.-]*$~' and 'not_regex:~(^|/)\.\.?(/|$)~' share Laravel's message.
    if (!/^\/?(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]*$/.test(baseDirectory)) add(errors, "base_directory", "The base directory field format is invalid.");
    if (/(^|\/)\.\.?(\/|$)/.test(baseDirectory)) add(errors, "base_directory", "The base directory field format is invalid.");
  }
  if (Object.keys(errors).length) throw new ApplicationValidationError(errors);

  const destinationUuid = typeof body.destination_uuid === "string" && body.destination_uuid !== "" ? body.destination_uuid : null;
  const destination = destinationUuid ? await ctx.store.findDestination(destinationUuid) : null;
  const server = destination ? await ctx.store.findServer(destination.server_uuid) : null;
  if (!destination || !server || effectiveServerRole(server) === "build") throw new ApplicationError(APPLICATION_SERVICE_MESSAGES.destinationNotFound, 404);
  throw new ApplicationError(CREATE_MESSAGES.scanUnavailable, 501);
}
