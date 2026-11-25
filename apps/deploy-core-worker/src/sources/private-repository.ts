// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/New/{GithubPrivateRepository,
// GithubPrivateRepositoryDeployKey}.php, app/Traits/HasRepositoryDetection.php (selectedDockerfileLocation),
// app/Support/ValidationPatterns.php and the Application model's creating, created and saving hooks
// (Apache-2.0), modified.
//
// New Resource's two private repositories (DP-72): "Git Repository (with GitHub App)" — a repository of the
// installation, picked from the App's repositories and branches — and "Private Git Repository (with Deploy
// Key)" — any repository by its URL, cloned over SSH with one of the org's private keys. Creating stores the
// application as Coolify stores it and deploys nothing.
import { GITHUB_APP_MORPH_CLASS, PUBLIC_GITHUB_SOURCE } from "@saas/db/deploy";
import { generateRandomName, newPublicId } from "../helpers/names.js";
import { add, blank, length, type FieldErrors } from "../private-keys/validation.js";
import { generateUrl, normalizeDomainPortOverrides } from "../applications/domains.js";
import { generateApplicationName, gitBranchError, gitRepositoryUrlError, parseScpStyleGitUrl, phpTrim } from "../applications/git.js";
import {
  baseDirectoryForStorage,
  CREATE_MESSAGES,
  DIRECTORY_PATH_PATTERN,
  dockerComposeLocationForStorage,
  dockerfileLocationForStorage,
  FILE_PATH_PATTERN,
  GIT_BUILD_PACKS,
  normalizeDirectoryPath,
  nixpacksVariables,
  publishDirectoryForStorage,
  resolveTarget,
  webhookSecrets,
  type BuildingContext,
  type CreationTarget,
} from "../applications/create.js";
import { ApplicationError } from "../applications/service.js";
import { parseUrl } from "../s3-storages/safe-url.js";

type Body = Record<string, unknown>;
const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

export const PRIVATE_REPOSITORY_TYPES = ["private-gh-app", "private-deploy-key"] as const;

/** The route parameters and the query string of the page, as DP-54's forms take them. */
function target(errors: FieldErrors, body: Body): CreationTarget {
  for (const field of ["project_uuid", "environment_uuid"] as const) {
    if (blank(body[field])) add(errors, field, `The ${field.replace("_", " ")} field is required.`);
    else if (typeof body[field] !== "string" || !UUID_RE.test(body[field])) add(errors, field, `The selected ${field.replace("_", " ")} is invalid.`);
  }
  const uuid = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  return { projectUuid: body.project_uuid as string, environmentUuid: body.environment_uuid as string, serverUuid: uuid(body.server_uuid), destinationUuid: uuid(body.destination_uuid) };
}

/** directoryPathRules() / filePathRules(): nullable|string|max:255|regex, Laravel's messages for `attribute`. */
function pathRule(errors: FieldErrors, field: string, value: unknown, attribute: string, pattern: RegExp): void {
  if (blank(value)) return;
  if (typeof value !== "string") return add(errors, field, `The ${attribute} field must be a string.`);
  if (length(value) > 255) add(errors, field, `The ${attribute} field must not be greater than 255 characters.`);
  if (!pattern.test(value)) add(errors, field, `The ${attribute} field format is invalid.`);
}

const asBool = (value: unknown): boolean | null => (value === true || value === 1 || value === "1" ? true : value === false || value === 0 || value === "0" ? false : null);
const isNumeric = (value: unknown): boolean => (typeof value === "number" ? Number.isFinite(value) : typeof value === "string" && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value));

/** The build pack must be one the form's listbox offers (DP-54's rule; Coolify's component takes any string). */
function buildPackRule(errors: FieldErrors, value: unknown, attribute: string): void {
  if (blank(value)) add(errors, "build_pack", `The ${attribute} field is required.`);
  else if (typeof value !== "string") add(errors, "build_pack", `The ${attribute} field must be a string.`);
  else if (!(GIT_BUILD_PACKS as readonly string[]).includes(value)) add(errors, "build_pack", `The selected ${attribute} is invalid.`);
}

/** selectedDockerfileLocation(): "/<path>" for the Dockerfile build pack, through filePathRules(). */
function selectedDockerfile(errors: FieldErrors, body: Body): string | null {
  if (body.build_pack !== "dockerfile" || typeof body.selectedDockerfile !== "string") return null;
  const path = phpTrim(body.selectedDockerfile).replace(/^\/+/, "");
  if (path === "") return null;
  const value = `/${path}`;
  if (length(value) > 255 || !FILE_PATH_PATTERN.test(value)) add(errors, "selectedDockerfile", CREATE_MESSAGES.dockerfileLocationRegex);
  return value;
}

interface Created {
  uuid: string;
  projectUuid: string;
  environmentUuid: string;
}

/** The columns both forms set the same way, after the model's mutators and saving hook. */
function commonColumns(input: { buildPack: string; port: number; publishDirectory: string | null; baseDirectory: string; dockerComposeLocation: string | null; dockerfile: string | null }) {
  const publish = publishDirectoryForStorage(input.publishDirectory);
  return {
    buildPack: input.buildPack,
    portsExposes: String(input.port),
    baseDirectory: phpTrim(baseDirectoryForStorage(input.baseDirectory)),
    publishDirectory: publish === null ? null : phpTrim(publish),
    dockerfile: null,
    dockerfileLocation: input.buildPack === "dockerfile" && input.dockerfile !== null ? dockerfileLocationForStorage(input.dockerfile, input.buildPack) : null,
    dockerComposeLocation: input.buildPack === "dockercompose" ? dockerComposeLocationForStorage(input.dockerComposeLocation) : null,
    // 'health_check_enabled' => false for the Dockerfile (and Docker image) build pack.
    healthCheckEnabled: input.buildPack === "dockerfile" ? false : null,
    dockerfileHealthcheck: null,
  };
}

// ── With a GitHub App ───────────────────────────────────────────────────────────────────────────────────

/**
 * GithubPrivateRepository::submit(): the base directory normalized, the repository's parts and branch
 * validated ('Invalid repository data: <the first error>'), then the application with the App as its source and
 * the repository's id at GitHub (which the App's webhooks find it by), named after the repository and branch.
 */
export async function createGithubAppApplication(ctx: BuildingContext, body: Body): Promise<Created | { errors: FieldErrors } | null> {
  const errors: FieldErrors = {};
  const where = target(errors, body);
  const baseDirectory = normalizeDirectoryPath(typeof body.base_directory === "string" ? body.base_directory : null);
  buildPackRule(errors, body.build_pack, "build pack");
  if (blank(body.port)) add(errors, "port", "The port field is required.");
  else if (!isNumeric(body.port)) add(errors, "port", "The port field must be a number.");
  if (body.repository_id === undefined || !(typeof body.repository_id === "number" && Number.isInteger(body.repository_id))) add(errors, "repository_id", "The repository field is required.");
  if (typeof body.github_app_uuid !== "string" || !UUID_RE.test(body.github_app_uuid)) add(errors, "github_app_uuid", "The github app field is required.");
  const dockerfile = selectedDockerfile(errors, body);
  if (Object.keys(errors).length) return { errors };

  // The validator of submit(): its first message, as the RuntimeException's.
  const repo: FieldErrors = {};
  const owner = body.repository_owner;
  const name = body.repository_repo;
  const branch = body.git_branch;
  if (blank(owner)) add(repo, "o", "The selected repository owner field is required.");
  else if (typeof owner !== "string") add(repo, "o", "The selected repository owner field must be a string.");
  else if (!/^[a-zA-Z0-9\-_]+$/.test(owner)) add(repo, "o", "The selected repository owner field format is invalid.");
  if (blank(name)) add(repo, "r", "The selected repository repo field is required.");
  else if (typeof name !== "string") add(repo, "r", "The selected repository repo field must be a string.");
  else if (!/^[a-zA-Z0-9\-_.]+$/.test(name)) add(repo, "r", "The selected repository repo field format is invalid.");
  if (blank(branch)) add(repo, "b", "The selected branch name field is required.");
  else if (typeof branch !== "string") add(repo, "b", "The selected branch name field must be a string.");
  else {
    const message = gitBranchError("selected branch name", branch);
    if (message) add(repo, "b", message);
  }
  pathRule(repo, "c", body.docker_compose_location, "docker compose location", FILE_PATH_PATTERN);
  pathRule(repo, "d", baseDirectory, "base directory", DIRECTORY_PATH_PATTERN);
  const first = Object.values(repo)[0]?.[0];
  if (first) throw new ApplicationError(`Invalid repository data: ${first}`);

  const where2 = await resolveTarget(ctx, where);
  if (!where2) return null;
  const app = await ctx.build.store.findGithubApp?.(body.github_app_uuid as string);
  if (!app) return null;
  const gitRepository = `${phpTrim(owner as string)}/${phpTrim(name as string)}`;
  const uuid = newPublicId();
  const domain = normalizeDomainPortOverrides(generateUrl({ ip: where2.server.ip, wildcardDomain: where2.server.wildcard_domain }, uuid), null);
  const buildPack = body.build_pack as string;
  // updatedBuildPack(): only Nixpacks and Railpack keep "Static site".
  const isStatic = (buildPack === "nixpacks" || buildPack === "railpack") && asBool(body.is_static) === true;
  await ctx.build.store.insert({
    uuid,
    // generate_application_name($owner.'/'.$repo, $branch, $application->uuid), once the uuid is known.
    name: generateApplicationName(gitRepository, branch as string, uuid),
    fqdn: domain.fqdn,
    domainPortOverrides: domain.overrides,
    repositoryProjectId: body.repository_id as number,
    gitRepository,
    gitBranch: phpTrim(branch as string),
    ...commonColumns({ buildPack, port: Math.trunc(Number(body.port)), publishDirectory: typeof body.publish_directory === "string" ? body.publish_directory : null, baseDirectory, dockerComposeLocation: typeof body.docker_compose_location === "string" ? body.docker_compose_location : null, dockerfile }),
    sourceId: Number(app.id),
    sourceType: GITHUB_APP_MORPH_CLASS,
    isStatic,
    environmentId: where2.environment.id,
    destinationId: where2.destination.id,
    destinationType: where2.destination.type,
    webhookSecrets: await webhookSecrets(ctx),
    variables: buildPack === "nixpacks" ? await nixpacksVariables(ctx) : [],
  });
  return { uuid, projectUuid: where2.project.uuid, environmentUuid: where2.environment.uuid };
}

// ── With a deploy key ───────────────────────────────────────────────────────────────────────────────────

/**
 * get_git_source(): an scp-style or ssh:// URL is kept as it is; a github.com URL becomes `owner/repo` with the
 * public GitHub source; any other http(s) URL `git@host:owner/repo.git`.
 */
export function deployKeyGitSource(repositoryUrl: string): { gitRepository: string; publicGithub: boolean } {
  if (parseScpStyleGitUrl(repositoryUrl) !== null || repositoryUrl.startsWith("ssh://")) return { gitRepository: repositoryUrl, publicGithub: false };
  const parsed = parseUrl(repositoryUrl) ?? {};
  const host = parsed.host ?? "";
  // Url::getSegment(1), getSegment(2): the path's first two segments.
  const parts = (parsed.path ?? "").split("/").filter((p) => p !== "");
  const ownerRepo = `${parts[0] ?? ""}/${parts[1] ?? ""}`;
  if (host === "github.com") return { gitRepository: ownerRepo, publicGithub: true };
  if (repositoryUrl.startsWith("http")) {
    const ssh = `git@${host}:${ownerRepo}`;
    return { gitRepository: ssh.endsWith(".git") ? ssh : `${ssh}.git`, publicGithub: false };
  }
  return { gitRepository: repositoryUrl, publicGithub: false };
}

/**
 * GithubPrivateRepositoryDeployKey::submit(): the key (one of the org's), then rules() with its attribute
 * names ("The Repository field is required."), then get_git_source() and the application with the key — a
 * random name, no repository id.
 */
export async function createDeployKeyApplication(ctx: BuildingContext, body: Body): Promise<Created | { errors: FieldErrors } | null> {
  const key = typeof body.private_key_uuid === "string" && UUID_RE.test(body.private_key_uuid) ? await ctx.build.store.findPrivateKey?.(body.private_key_uuid) : null;
  // PrivateKey::ownedByCurrentTeam()->findOrFail(): another org's key is not found.
  if (!key) return null;
  const errors: FieldErrors = {};
  const where = target(errors, body);
  const baseDirectory = normalizeDirectoryPath(typeof body.base_directory === "string" ? body.base_directory : null);
  if (blank(body.repository_url)) add(errors, "repository_url", "The Repository field is required.");
  else if (typeof body.repository_url !== "string") add(errors, "repository_url", "The Repository field must be a string.");
  else {
    const message = gitRepositoryUrlError("Repository", body.repository_url);
    if (message) add(errors, "repository_url", message);
  }
  if (blank(body.git_branch)) add(errors, "git_branch", "The Branch field is required.");
  else if (typeof body.git_branch !== "string") add(errors, "git_branch", "The Branch field must be a string.");
  else {
    const message = gitBranchError("Branch", body.git_branch);
    if (message) add(errors, "git_branch", message);
  }
  if (blank(body.port)) add(errors, "port", "The Port field is required.");
  else if (!isNumeric(body.port)) add(errors, "port", "The Port field must be a number.");
  if (body.is_static === undefined || body.is_static === null || body.is_static === "") add(errors, "is_static", "The Is static field is required.");
  else if (asBool(body.is_static) === null) add(errors, "is_static", "The Is static field must be true or false.");
  if (!blank(body.publish_directory) && typeof body.publish_directory !== "string") add(errors, "publish_directory", "The Publish directory field must be a string.");
  buildPackRule(errors, body.build_pack, "Build pack");
  pathRule(errors, "base_directory", baseDirectory, "Base directory", DIRECTORY_PATH_PATTERN);
  pathRule(errors, "docker_compose_location", body.docker_compose_location, "docker compose location", FILE_PATH_PATTERN);
  const dockerfile = selectedDockerfile(errors, body);
  if (Object.keys(errors).length) return { errors };

  const where2 = await resolveTarget(ctx, where);
  if (!where2) return null;
  const url = body.repository_url as string;
  const again = gitRepositoryUrlError("repository url", url);
  if (again) throw new ApplicationError(`Invalid repository URL: ${again}`);
  const source = deployKeyGitSource(url);
  const uuid = newPublicId();
  const domain = normalizeDomainPortOverrides(generateUrl({ ip: where2.server.ip, wildcardDomain: where2.server.wildcard_domain }, uuid), null);
  const buildPack = body.build_pack as string;
  const isStatic = (buildPack === "nixpacks" || buildPack === "railpack") && asBool(body.is_static) === true;
  await ctx.build.store.insert({
    uuid,
    // generate_random_name($application->uuid)
    name: generateRandomName(uuid),
    fqdn: domain.fqdn,
    domainPortOverrides: domain.overrides,
    repositoryProjectId: null,
    gitRepository: phpTrim(source.gitRepository),
    gitBranch: phpTrim(body.git_branch as string),
    ...commonColumns({ buildPack, port: Math.trunc(Number(body.port)), publishDirectory: typeof body.publish_directory === "string" ? body.publish_directory : null, baseDirectory, dockerComposeLocation: typeof body.docker_compose_location === "string" ? body.docker_compose_location : null, dockerfile }),
    sourceId: source.publicGithub ? PUBLIC_GITHUB_SOURCE.id : null,
    sourceType: source.publicGithub ? PUBLIC_GITHUB_SOURCE.type : null,
    isStatic,
    environmentId: where2.environment.id,
    destinationId: where2.destination.id,
    destinationType: where2.destination.type,
    webhookSecrets: await webhookSecrets(ctx),
    variables: buildPack === "nixpacks" ? await nixpacksVariables(ctx) : [],
    privateKeyId: key.id,
  });
  return { uuid, projectUuid: where2.project.uuid, environmentUuid: where2.environment.uuid };
}
