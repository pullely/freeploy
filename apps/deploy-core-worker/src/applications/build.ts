// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/General.php (rules, messages,
// validationAttributes, syncData, instantSave, updatedBuildPack, generateNginxConfiguration, submit, the
// Compose command previews), app/Models/Application.php (the saving hook's build pack cleanup, the
// base_directory, publish_directory, dockerfile_location, docker_compose_location, watch_paths and
// custom_nginx_configuration mutators, parseHealthcheckFromDockerfile, otherApplicationBuildingSameImage,
// sharedImageNameMessage, could_set_build_commands, git_based, supportsWatchPaths), app/Support/ValidationPatterns.php
// (the path, target and shell-safe command rules), app/Enums/StaticImageTypes.php and bootstrap/helpers
// (defaultNginxConfiguration, injectDockerComposeFlags) (Apache-2.0), modified.
//
// General's fields of the build packs — Railpack, Nixpacks, Static,
// Dockerfile and Docker Compose — beside the fields validation.ts and
// service.ts already handle for every application. Everything here is stored
// and takes effect at the next deployment. Loading a Compose file from the
// repository runs on the server and needs the SSH executor.
import type { ApplicationBuildChanges, ApplicationBuildSettingChanges, DeployApplicationBuildRow } from "@saas/db/deploy";
import { PUBLIC_GITHUB_SOURCE } from "@saas/db/deploy";
import { add, blank, length, type FieldErrors } from "../private-keys/validation.js";
import {
  baseDirectoryForStorage,
  DIRECTORY_PATH_PATTERN,
  dockerComposeLocationForStorage,
  dockerfileLocationForStorage,
  FILE_PATH_PATTERN,
  GIT_BUILD_PACKS,
  publishDirectoryForStorage,
  type ApplicationBuildStore,
} from "./create.js";
import { dockerfileHealthcheckInstruction, dockerfileHealthcheckOptions, getPortFromDockerfile } from "./dockerfile.js";
import { phpTrim } from "./git.js";
import { ApplicationError } from "./service.js";
import { SHELL_SAFE_COMMAND_PATTERN, type GeneralInput } from "./validation.js";

const SHELL_SAFE_TAIL =
  "Allowed: alphanumerics, && / || chaining, balanced quotes, globs (*, ?), !, and safe path/arg chars. Blocked: bare &, bare |, ;, $, backtick, (, ), <, >, \\, newlines.";

export const BUILD_MESSAGES = {
  /** General::messages() */
  buildPackRequired: "The Build Pack field is required.",
  staticImageRequired: "The Static Image field is required.",
  baseDirectoryRequired: "The Base Directory field is required.",
  baseDirectoryRegex: "The base directory must be a valid path starting with / and containing only safe characters.",
  publishDirectoryRegex: "The publish directory must be a valid path starting with / and containing only safe characters.",
  dockerfileLocationRegex: "The Dockerfile location must be a valid path starting with / and containing only alphanumeric characters, dots, hyphens, underscores, slashes, @, ~, and +.",
  dockerComposeLocationRegex: "The Docker Compose location must be a valid path starting with / and containing only alphanumeric characters, dots, hyphens, underscores, slashes, @, ~, and +.",
  dockerfileTargetBuildRegex: "The Dockerfile target build must contain only alphanumeric characters, dots, hyphens, and underscores.",
  dockerComposeCustomStartCommandRegex: `The Docker Compose start command contains invalid characters. ${SHELL_SAFE_TAIL}`,
  dockerComposeCustomBuildCommandRegex: `The Docker Compose build command contains invalid characters. ${SHELL_SAFE_TAIL}`,
  installCommandRegex: `The install command contains invalid characters. ${SHELL_SAFE_TAIL}`,
  buildCommandRegex: `The build command contains invalid characters. ${SHELL_SAFE_TAIL}`,
  startCommandRegex: `The start command contains invalid characters. ${SHELL_SAFE_TAIL}`,
  isStaticRequired: "The Static setting is required.",
  isStaticBoolean: "The Static setting must be true or false.",
  isSpaRequired: "The SPA setting is required.",
  isSpaBoolean: "The SPA setting must be true or false.",
  isBuildServerEnabledRequired: "The Build Server setting is required.",
  isBuildServerEnabledBoolean: "The Build Server setting must be true or false.",
  isPreserveRepositoryEnabledRequired: "The Preserve Repository setting is required.",
  isPreserveRepositoryEnabledBoolean: "The Preserve Repository setting must be true or false.",
  /** General::instantSave() and generateNginxConfiguration() */
  settingsSaved: "Settings saved.",
  nginxGenerated: "Nginx configuration generated.",
  /** Freeploy's: Application::loadComposeFile() clones the repository on the server. */
  composeLoadUnavailable: "Loading the Compose file from the repository needs the SSH executor, which is not available yet.",
} as const;

/** General's $validationAttributes for these fields. */
export const BUILD_ATTRIBUTES = {
  buildPack: "Build pack",
  staticImage: "Static image",
  baseDirectory: "Base directory",
  publishDirectory: "Publish directory",
  installCommand: "Install command",
  buildCommand: "Build command",
  startCommand: "Start command",
  dockerfile: "Dockerfile",
  dockerfileLocation: "Dockerfile location",
  dockerfileTargetBuild: "Dockerfile target build",
  dockerComposeLocation: "Docker compose location",
  dockerComposeCustomStartCommand: "Docker compose custom start command",
  dockerComposeCustomBuildCommand: "Docker compose custom build command",
  customNginxConfiguration: "Custom Nginx configuration",
  watchPaths: "Watch paths",
} as const;

/** ValidationPatterns::DOCKER_TARGET_PATTERN */
export const DOCKER_TARGET_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** StaticImageTypes */
export const STATIC_IMAGES: readonly string[] = ["nginx:alpine"];

/** The values of the Site type listbox (General::$siteType). */
export const SITE_TYPES = ["dynamic", "static", "spa"] as const;
export type SiteType = (typeof SITE_TYPES)[number];

/** defaultNginxConfiguration() */
export function defaultNginxConfiguration(type: "static" | "spa" = "static"): string {
  const location =
    type === "spa"
      ? `        index index.html;
        try_files $uri $uri/ /index.html;`
      : `        index index.html index.htm;
        try_files $uri $uri.html $uri/index.html $uri/index.htm $uri/ =404;`;
  return `server {
    location / {
        root /usr/share/nginx/html;
${location}
    }

    # Handle 404 errors
    error_page 404 /404.html;
    location = /404.html {
        root /usr/share/nginx/html;
        internal;
    }

    # Handle server errors (50x)
    error_page 500 502 503 504 /50x.html;
    location = /50x.html {
        root /usr/share/nginx/html;
        internal;
    }
}`;
}

/** base64_encode() / base64_decode() of a UTF-8 text (the custom_nginx_configuration mutator and accessor). */
export function base64Encode(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function base64Decode(stored: string): string {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(stored), (c) => c.charCodeAt(0)));
  } catch {
    return "";
  }
}

/**
 * The watch_paths mutator (parseWatchPaths): one pattern per line, trimmed,
 * without a leading "/" (after a "!" too), empty lines left out; null for an
 * empty value.
 */
export function watchPathsForStorage(value: string | null): string | null {
  if (value === null || value === "" || value === "0") return null;
  const paths = value
    .split("\n")
    .map((line) => {
      const path = phpTrim(line);
      if (path.startsWith("!")) return `!${phpTrim(path.slice(1)).replace(/^\/+/, "")}`;
      return path.replace(/^\/+/, "");
    })
    .filter((path) => path.length > 0);
  return phpTrim(paths.join("\n"));
}

/** injectDockerComposeFlags(): -f and --env-file after the first "docker compose", unless the command has its own. */
export function injectDockerComposeFlags(command: string, composeFilePath: string, envFilePath: string): string {
  let replacement = "docker compose";
  if (!/(?:^|\s)(?:-f(?:[=\s]|[./~]|$)|--file(?:=|\s))/.test(command)) replacement += ` -f ${composeFilePath}`;
  if (!/(?:^|\s)--env-file(?:=|\s)/.test(command)) replacement += ` --env-file ${envFilePath}`;
  return command.replace(/docker\s+compose/, () => replacement);
}

/** ApplicationDeploymentJob::BUILD_TIME_ENV_PATH */
const BUILD_TIME_ENV_PATH = "/artifacts/build-time.env";

type Body = Record<string, unknown>;

/** The build fields a PATCH carries. A field the body leaves out is undefined: it keeps its stored value. */
export interface BuildInput {
  buildPack?: string;
  staticImage?: string;
  baseDirectory?: string;
  publishDirectory?: string | null;
  installCommand?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
  dockerfile?: string | null;
  dockerfileLocation?: string | null;
  dockerfileTargetBuild?: string | null;
  dockerComposeLocation?: string | null;
  dockerComposeCustomStartCommand?: string | null;
  dockerComposeCustomBuildCommand?: string | null;
  customNginxConfiguration?: string | null;
  watchPaths?: string | null;
  isStatic?: boolean;
  isSpa?: boolean;
  isBuildServerEnabled?: boolean;
  isPreserveRepositoryEnabled?: boolean;
  /** generateNginxConfiguration($type) */
  generateNginxConfiguration?: "static" | "spa";
  /** instantSave(): the listboxes and the checkbox that save themselves. */
  instantSave: boolean;
}

type Result = { ok: true; input: BuildInput } | { ok: false; errors: FieldErrors };

const string = (attribute: string) => `The ${attribute} field must be a string.`;
const max = (attribute: string, n: number) => `The ${attribute} field must not be greater than ${n} characters.`;

/** nullable|string|max:n|regex: the string, or null for a blank value. */
function nullableString(errors: FieldErrors, field: string, value: unknown, attribute: string, rules: { max?: number; regex?: RegExp; regexMessage?: string } = {}): string | null {
  if (blank(value)) return typeof value === "string" ? value : null;
  if (typeof value !== "string") {
    add(errors, field, string(attribute));
    return null;
  }
  if (rules.max !== undefined && length(value) > rules.max) add(errors, field, max(attribute, rules.max));
  if (rules.regex && !rules.regex.test(value)) add(errors, field, rules.regexMessage ?? `The ${attribute} field format is invalid.`);
  return value;
}

/**
 * General::validate() with rules() and messages() for the build fields.
 * `stored` is the application now: an install, build or start command that
 * did not change is only 'nullable' (changedCommandRules); a build pack other
 * than the stored one must be one the listbox offers.
 */
export function validateBuild(body: Body, stored: Pick<DeployApplicationBuildRow, "build_pack" | "install_command" | "build_command" | "start_command">): Result {
  const errors: FieldErrors = {};
  const input: BuildInput = { instantSave: body.instantSave === true };
  const has = (field: string): boolean => body[field] !== undefined;
  const A = BUILD_ATTRIBUTES;
  const M = BUILD_MESSAGES;

  if (has("buildPack")) {
    if (blank(body.buildPack)) add(errors, "buildPack", M.buildPackRequired);
    else if (typeof body.buildPack !== "string") add(errors, "buildPack", string(A.buildPack));
    else if (body.buildPack !== stored.build_pack && !(GIT_BUILD_PACKS as readonly string[]).includes(body.buildPack)) add(errors, "buildPack", `The selected ${A.buildPack} is invalid.`);
    else input.buildPack = body.buildPack;
  }
  if (has("staticImage")) {
    if (blank(body.staticImage)) add(errors, "staticImage", M.staticImageRequired);
    else if (typeof body.staticImage !== "string" || !STATIC_IMAGES.includes(body.staticImage)) add(errors, "staticImage", `The selected ${A.staticImage} is invalid.`);
    else input.staticImage = body.staticImage;
  }
  if (has("baseDirectory")) {
    // array_merge(['required'], array_slice(directoryPathRules(), 1))
    if (blank(body.baseDirectory)) add(errors, "baseDirectory", M.baseDirectoryRequired);
    else input.baseDirectory = nullableString(errors, "baseDirectory", body.baseDirectory, A.baseDirectory, { max: 255, regex: DIRECTORY_PATH_PATTERN, regexMessage: M.baseDirectoryRegex }) ?? "/";
  }
  if (has("publishDirectory")) {
    input.publishDirectory = nullableString(errors, "publishDirectory", body.publishDirectory, A.publishDirectory, { max: 255, regex: DIRECTORY_PATH_PATTERN, regexMessage: M.publishDirectoryRegex });
  }
  for (const [field, column, regexMessage] of [
    ["installCommand", "install_command", M.installCommandRegex],
    ["buildCommand", "build_command", M.buildCommandRegex],
    ["startCommand", "start_command", M.startCommandRegex],
  ] as const) {
    if (!has(field)) continue;
    const value = body[field];
    // changedCommandRules(): "(string) $this->{$property} === (string) $this->application->getOriginal($column)"
    const unchanged = (value === null || typeof value === "string") && (value ?? "") === (stored[column] ?? "");
    input[field] = unchanged ? (value as string | null) : nullableString(errors, field, value, A[field], { max: 1000, regex: SHELL_SAFE_COMMAND_PATTERN, regexMessage });
  }
  // 'dockerfile', 'customNginxConfiguration' and 'watchPaths' are only 'nullable'; the properties are ?string.
  for (const field of ["dockerfile", "customNginxConfiguration", "watchPaths"] as const) {
    if (has(field)) input[field] = nullableString(errors, field, body[field], A[field]);
  }
  if (has("dockerfileLocation")) {
    input.dockerfileLocation = nullableString(errors, "dockerfileLocation", body.dockerfileLocation, A.dockerfileLocation, { max: 255, regex: FILE_PATH_PATTERN, regexMessage: M.dockerfileLocationRegex });
  }
  if (has("dockerComposeLocation")) {
    input.dockerComposeLocation = nullableString(errors, "dockerComposeLocation", body.dockerComposeLocation, A.dockerComposeLocation, {
      max: 255,
      regex: FILE_PATH_PATTERN,
      regexMessage: M.dockerComposeLocationRegex,
    });
  }
  if (has("dockerfileTargetBuild")) {
    input.dockerfileTargetBuild = nullableString(errors, "dockerfileTargetBuild", body.dockerfileTargetBuild, A.dockerfileTargetBuild, { max: 128, regex: DOCKER_TARGET_PATTERN, regexMessage: M.dockerfileTargetBuildRegex });
  }
  for (const [field, regexMessage] of [
    ["dockerComposeCustomStartCommand", M.dockerComposeCustomStartCommandRegex],
    ["dockerComposeCustomBuildCommand", M.dockerComposeCustomBuildCommandRegex],
  ] as const) {
    if (has(field)) input[field] = nullableString(errors, field, body[field], A[field], { max: 1000, regex: SHELL_SAFE_COMMAND_PATTERN, regexMessage });
  }
  for (const [field, required, boolean] of [
    ["isStatic", M.isStaticRequired, M.isStaticBoolean],
    ["isSpa", M.isSpaRequired, M.isSpaBoolean],
    ["isBuildServerEnabled", M.isBuildServerEnabledRequired, M.isBuildServerEnabledBoolean],
    ["isPreserveRepositoryEnabled", M.isPreserveRepositoryEnabledRequired, M.isPreserveRepositoryEnabledBoolean],
  ] as const) {
    if (!has(field)) continue;
    const value = body[field];
    if (value === null || value === "") add(errors, field, required);
    else if (value === true || value === 1 || value === "1") input[field] = true;
    else if (value === false || value === 0 || value === "0") input[field] = false;
    else add(errors, field, boolean);
  }
  // setSiteType(): the listbox's value is the two settings.
  if (has("siteType")) {
    if (typeof body.siteType !== "string" || !(SITE_TYPES as readonly string[]).includes(body.siteType)) add(errors, "siteType", "The selected site type is invalid.");
    else {
      input.isStatic = body.siteType !== "dynamic";
      input.isSpa = body.siteType === "spa";
    }
  }
  if (has("generateNginxConfiguration")) {
    if (body.generateNginxConfiguration === "static" || body.generateNginxConfiguration === "spa") input.generateNginxConfiguration = body.generateNginxConfiguration;
    else add(errors, "generateNginxConfiguration", "The selected generate nginx configuration is invalid.");
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, input };
}

export interface PreparedBuild {
  row: DeployApplicationBuildRow;
  /** The build pack the application will have. */
  buildPack: string;
  /** The body for validateGeneral(): the request's, with the General fields the build fields decide. */
  body: Body;
  input: BuildInput | null;
  errors: FieldErrors;
}

/**
 * Before General's own validation: the build fields are validated, and the
 * ports the build fields decide are put into the body — updatedBuildPack()
 * sets '80' for the Static build pack, and submit() the Dockerfile's EXPOSE
 * port when no port is given. Null when the application is not the org's.
 */
export async function prepareBuild(store: ApplicationBuildStore, uuid: string, body: Body): Promise<PreparedBuild | null> {
  const row = await store.findBuild(uuid);
  if (!row) return null;
  const v = validateBuild(body, row);
  if (!v.ok) return { row, buildPack: row.build_pack, body, input: null, errors: v.errors };
  const input = v.input;
  const buildPack = input.buildPack ?? row.build_pack;
  const general: Body = { ...body };
  if (buildPack !== row.build_pack && buildPack === "static") general.portsExposes = "80";
  const dockerfile = input.dockerfile !== undefined ? input.dockerfile : row.dockerfile;
  const ports = general.portsExposes !== undefined ? general.portsExposes : row.ports_exposes;
  if (dockerfile && (ports === null || ports === "" || ports === "0")) {
    const port = getPortFromDockerfile(dockerfile);
    if (port) general.portsExposes = String(port);
  }
  return { row, buildPack, body: general, input, errors: {} };
}

/** PHP's rtrim($value, '/'). */
const withoutTrailingSlashes = (value: string): string => value.replace(/\/+$/, "");

/** Application::sharedImageNameMessage() ("Coolify" reads "Freeploy"). */
export const sharedImageNameMessage = (otherName: string, imageName: string): string =>
  `The application ${otherName} also builds the Docker image ${imageName}. ` +
  "Freeploy tags each build with the commit SHA (latest for a Dockerfile set in Freeploy, pr-<id>-<commit> for previews) and pushes the Docker image tag only in addition. " +
  "A different Docker image tag does not keep the images apart, so one application can run the image of the other. " +
  `Set a different Docker image name for each application in the General settings, for example ${imageName}-staging.`;

/**
 * General::submit() / instantSave() / updatedBuildPack() /
 * generateNginxConfiguration() for the build fields, after validation and
 * before the rest of General is saved. Answers field errors when another
 * application of the org builds the same image; throws 501 when the save
 * would load the Compose file from the repository. Only what changes is
 * written.
 */
export async function saveBuild(store: ApplicationBuildStore, prepared: PreparedBuild, general: GeneralInput): Promise<FieldErrors | null> {
  const { row, buildPack } = prepared;
  const input = prepared.input ?? { instantSave: false };
  const changes: ApplicationBuildChanges = {};
  const settings: ApplicationBuildSettingChanges = {};
  const packChanged = buildPack !== row.build_pack;
  const set = (column: keyof ApplicationBuildChanges, value: string | number | boolean | null, current: string | number | boolean | null): void => {
    if (value !== current) changes[column] = value;
    else delete changes[column];
  };

  // "$otherApplication = $this->application->isDirty(['docker_registry_image_name', 'build_pack']) ? … : null"
  const imageName = general.dockerRegistryImageName !== undefined ? general.dockerRegistryImageName : row.docker_registry_image_name;
  if ((packChanged || imageName !== row.docker_registry_image_name) && !blank(imageName) && !["dockerimage", "dockercompose"].includes(buildPack)) {
    const other = await store.otherApplicationBuildingImage(row.id, imageName!);
    if (other) return { dockerRegistryImageName: [sharedImageNameMessage(other.name, imageName!)] };
  }

  let baseDirectory = row.base_directory;
  if (input.baseDirectory !== undefined) {
    // submit(): the trailing slash goes; then the mutator and the saving hook's trim.
    const typed = input.baseDirectory !== "/" ? withoutTrailingSlashes(input.baseDirectory) : input.baseDirectory;
    baseDirectory = phpTrim(baseDirectoryForStorage(typed));
    set("base_directory", baseDirectory, row.base_directory);
  }
  // "$oldDockerComposeLocation !== $this->dockerComposeLocation || $oldBaseDirectory !== $this->baseDirectory": loadComposeFile().
  if (buildPack === "dockercompose" && ((input.dockerComposeLocation !== undefined && input.dockerComposeLocation !== row.docker_compose_location) || baseDirectory !== row.base_directory)) {
    throw new ApplicationError(BUILD_MESSAGES.composeLoadUnavailable, 501);
  }

  if (input.buildPack !== undefined) set("build_pack", buildPack, row.build_pack);
  if (input.staticImage !== undefined) set("static_image", input.staticImage, row.static_image);
  if (input.publishDirectory !== undefined) {
    const typed = input.publishDirectory && input.publishDirectory !== "/" ? withoutTrailingSlashes(input.publishDirectory) : input.publishDirectory;
    const stored = publishDirectoryForStorage(typed);
    set("publish_directory", stored === null ? null : phpTrim(stored), row.publish_directory);
  }
  for (const [field, column] of [
    ["installCommand", "install_command"],
    ["buildCommand", "build_command"],
    ["startCommand", "start_command"],
  ] as const) {
    const value = input[field];
    // The saving hook trims a command that changed.
    if (value !== undefined && (value ?? "") !== (row[column] ?? "")) changes[column] = phpTrim(value ?? "");
  }
  const blankIsNull = (value: string | null): string | null => (value === "" ? null : value);
  if (input.dockerfileTargetBuild !== undefined) set("dockerfile_target_build", blankIsNull(input.dockerfileTargetBuild), row.dockerfile_target_build);
  if (input.dockerComposeCustomStartCommand !== undefined) set("docker_compose_custom_start_command", blankIsNull(input.dockerComposeCustomStartCommand), row.docker_compose_custom_start_command);
  if (input.dockerComposeCustomBuildCommand !== undefined) set("docker_compose_custom_build_command", blankIsNull(input.dockerComposeCustomBuildCommand), row.docker_compose_custom_build_command);
  if (input.watchPaths !== undefined) set("watch_paths", watchPathsForStorage(input.watchPaths), row.watch_paths);
  if (input.customNginxConfiguration !== undefined) {
    // The mutator stores base64; the saving hook turns an empty configuration into null.
    const configuration = input.customNginxConfiguration;
    set("custom_nginx_configuration", configuration === null || configuration === "" ? null : base64Encode(configuration), row.custom_nginx_configuration);
  }
  // The mutator reads the build pack the application is getting; a Dockerfile application without a location gets '/Dockerfile'.
  if (input.dockerfileLocation !== undefined || (packChanged && buildPack === "dockerfile")) {
    set("dockerfile_location", dockerfileLocationForStorage(input.dockerfileLocation !== undefined ? input.dockerfileLocation : row.dockerfile_location, buildPack), row.dockerfile_location);
  }
  if (input.dockerComposeLocation !== undefined) set("docker_compose_location", dockerComposeLocationForStorage(input.dockerComposeLocation), row.docker_compose_location);

  if (input.dockerfile !== undefined && input.dockerfile !== row.dockerfile) {
    changes.dockerfile = input.dockerfile;
    // parseHealthcheckFromDockerfile($this->application->dockerfile)
    const target = input.dockerfileTargetBuild !== undefined ? input.dockerfileTargetBuild : row.dockerfile_target_build;
    const instruction = dockerfileHealthcheckInstruction(input.dockerfile, target);
    if (instruction === null && row.custom_healthcheck_found) {
      set("custom_healthcheck_found", false, row.custom_healthcheck_found);
      set("health_check_interval", 5, row.health_check_interval);
      set("health_check_timeout", 5, row.health_check_timeout);
      set("health_check_retries", 10, row.health_check_retries);
      set("health_check_start_period", 5, row.health_check_start_period);
    } else if (instruction !== null && row.health_check_enabled === false) {
      const options = dockerfileHealthcheckOptions(instruction);
      set("health_check_interval", options.interval ?? row.health_check_interval, row.health_check_interval);
      set("health_check_timeout", options.timeout ?? row.health_check_timeout, row.health_check_timeout);
      set("health_check_start_period", options.startPeriod ?? row.health_check_start_period, row.health_check_start_period);
      set("health_check_retries", options.retries ?? row.health_check_retries, row.health_check_retries);
      set("custom_healthcheck_found", true, row.custom_healthcheck_found);
    }
  }

  const wasStatic = row.is_static === true;
  const wasSpa = row.is_spa === true;
  const setting = (column: keyof ApplicationBuildSettingChanges, value: boolean | undefined, current: boolean): void => {
    if (value !== undefined && value !== current) settings[column] = value;
  };
  setting("is_static", input.isStatic, wasStatic);
  setting("is_spa", input.isSpa, wasSpa);
  setting("is_build_server_enabled", input.isBuildServerEnabled, row.is_build_server_enabled === true);
  setting("is_preserve_repository_enabled", input.isPreserveRepositoryEnabled, row.is_preserve_repository_enabled === true);
  if (input.instantSave) {
    // "if ($oldIsSpa !== $this->isSpa) { $this->generateNginxConfiguration($this->isSpa ? 'spa' : 'static'); }"
    if (input.isSpa !== undefined && input.isSpa !== wasSpa) set("custom_nginx_configuration", base64Encode(defaultNginxConfiguration(input.isSpa ? "spa" : "static")), row.custom_nginx_configuration);
    if (input.isPreserveRepositoryEnabled === false && row.is_preserve_repository_enabled === true) await store.clearFileStoragesBasedOnGit(row.id);
  }
  if (input.generateNginxConfiguration !== undefined) set("custom_nginx_configuration", base64Encode(defaultNginxConfiguration(input.generateNginxConfiguration)), row.custom_nginx_configuration);

  if (packChanged) {
    // updatedBuildPack()
    if (buildPack !== "nixpacks" && buildPack !== "railpack") {
      if (wasStatic) settings.is_static = false;
      else delete settings.is_static;
    }
    if (buildPack === "static") set("custom_nginx_configuration", base64Encode(defaultNginxConfiguration("static")), row.custom_nginx_configuration);
    // The saving hook's "Buildpack switching cleanup logic".
    if (row.build_pack === "dockercompose") {
      set("docker_compose_domains", null, row.docker_compose_domains);
      set("docker_compose_raw", null, row.docker_compose_raw);
      await store.deleteServiceVariables(row.id);
    }
    if (row.build_pack === "dockerfile") {
      set("dockerfile", null, row.dockerfile);
      set("dockerfile_location", null, row.dockerfile_location);
      set("dockerfile_target_build", null, row.dockerfile_target_build);
      set("custom_healthcheck_found", false, row.custom_healthcheck_found);
    }
  }

  if (Object.keys(changes).length || Object.keys(settings).length) await store.updateBuild(row.id, changes, settings);
  return null;
}

export interface ApplicationBuildShow {
  gitRepository: string;
  gitBranch: string;
  gitCommitSha: string;
  /** Application::git_based(): no Dockerfile of its own, and not a Docker image. */
  gitBased: boolean;
  /** "$application->dockerfile": created from a Dockerfile. */
  hasDockerfile: boolean;
  /** Application::is_public_repository(): the public GitHub source. */
  publicRepository: boolean;
  supportsWatchPaths: boolean;
  couldSetBuildCommands: boolean;
  staticImage: string;
  baseDirectory: string;
  publishDirectory: string | null;
  /** Commands and file contents can embed credentials: null unless the caller may update (General::syncData). */
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  dockerfile: string | null;
  dockerfileLocation: string | null;
  dockerfileTargetBuild: string | null;
  dockerComposeLocation: string | null;
  dockerComposeRaw: string | null;
  dockerComposeCustomStartCommand: string | null;
  dockerComposeCustomBuildCommand: string | null;
  /** getDockerComposeBuildCommandPreviewProperty() / …StartCommandPreviewProperty(): '' without a custom command. */
  dockerComposeBuildCommandPreview: string;
  dockerComposeStartCommandPreview: string;
  customNginxConfiguration: string | null;
  watchPaths: string | null;
  isStatic: boolean;
  isSpa: boolean;
  siteType: SiteType;
  isBuildServerEnabled: boolean;
  isPreserveRepositoryEnabled: boolean;
  isRawComposeDeploymentEnabled: boolean;
  composeParsingVersion: number;
  hasBuildServers: boolean;
  /** A Docker Compose application whose file was never loaded: loading it needs the server. */
  composeLoadUnavailable: string | null;
}

/** General::syncData() and what general.blade.php asks of the model, for the build fields. */
export function applicationBuildShow(row: DeployApplicationBuildRow, canUpdate: boolean, hasBuildServers: boolean): ApplicationBuildShow {
  const secret = (value: string | null): string | null => (canUpdate ? (value ?? null) : null);
  const hasDockerfile = Boolean(row.dockerfile) && row.dockerfile !== "0";
  const gitBased = !hasDockerfile && row.build_pack !== "dockerimage";
  const publicRepository = row.source_type === PUBLIC_GITHUB_SOURCE.type && Number(row.source_id) === PUBLIC_GITHUB_SOURCE.id;
  const isStatic = row.is_static === true;
  const isSpa = row.is_spa === true;
  const base = row.base_directory === "/" ? "" : withoutTrailingSlashes(row.base_directory);
  const composeFile = `.${base}${row.docker_compose_location ?? ""}`;
  const customBuild = secret(row.docker_compose_custom_build_command);
  const customStart = secret(row.docker_compose_custom_start_command);
  return {
    gitRepository: row.git_repository,
    gitBranch: row.git_branch,
    gitCommitSha: row.git_commit_sha,
    gitBased,
    hasDockerfile,
    publicRepository,
    supportsWatchPaths: gitBased && !publicRepository,
    couldSetBuildCommands: row.build_pack === "nixpacks" || row.build_pack === "railpack",
    staticImage: row.static_image,
    baseDirectory: row.base_directory,
    publishDirectory: row.publish_directory ?? null,
    installCommand: secret(row.install_command),
    buildCommand: secret(row.build_command),
    startCommand: secret(row.start_command),
    dockerfile: secret(row.dockerfile),
    dockerfileLocation: row.dockerfile_location ?? (row.build_pack === "dockerfile" ? "/Dockerfile" : null),
    dockerfileTargetBuild: row.dockerfile_target_build ?? null,
    dockerComposeLocation: row.docker_compose_location ?? null,
    dockerComposeRaw: secret(row.docker_compose_raw),
    dockerComposeCustomStartCommand: customStart,
    dockerComposeCustomBuildCommand: customBuild,
    dockerComposeBuildCommandPreview: customBuild ? injectDockerComposeFlags(customBuild, composeFile, BUILD_TIME_ENV_PATH) : "",
    dockerComposeStartCommandPreview: customStart ? injectDockerComposeFlags(customStart, composeFile, "{workdir}/.env") : "",
    customNginxConfiguration: canUpdate && row.custom_nginx_configuration !== null ? base64Decode(row.custom_nginx_configuration) : null,
    watchPaths: row.watch_paths ?? null,
    isStatic,
    isSpa,
    siteType: isStatic ? (isSpa ? "spa" : "static") : "dynamic",
    isBuildServerEnabled: row.is_build_server_enabled === true,
    isPreserveRepositoryEnabled: row.is_preserve_repository_enabled === true,
    isRawComposeDeploymentEnabled: row.is_raw_compose_deployment_enabled === true,
    composeParsingVersion: Number(row.compose_parsing_version) || 0,
    hasBuildServers,
    composeLoadUnavailable: row.build_pack === "dockercompose" && !row.docker_compose_raw ? BUILD_MESSAGES.composeLoadUnavailable : null,
  };
}

export async function showBuild(store: ApplicationBuildStore, uuid: string, canUpdate: boolean): Promise<ApplicationBuildShow | null> {
  const row = await store.findBuild(uuid);
  return row ? applicationBuildShow(row, canUpdate, await store.hasBuildServers()) : null;
}

/** What a save answers beside General's: the build fields as stored now, and the toast of the action that ran. */
export async function builtAnswer(store: ApplicationBuildStore, uuid: string, prepared: PreparedBuild): Promise<{ build: ApplicationBuildShow | null; message?: string; warning?: boolean }> {
  const build = await showBuild(store, uuid, true);
  if (prepared.input?.generateNginxConfiguration !== undefined) return { build, message: BUILD_MESSAGES.nginxGenerated, warning: false };
  if (prepared.input?.instantSave) return { build, message: BUILD_MESSAGES.settingsSaved, warning: false };
  return { build };
}
