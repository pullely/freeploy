// Derived from coollabsio/coolify@91b7e3e:app/Jobs/ApplicationDeploymentJob.php (set_coolify_variables,
// generate_coolify_env_variables for a build, generate_env_variables, generate_buildtime_environment_variables,
// the launcher of save_buildtime_environment_variables, generate_nixpacks_env_variables, nixpacks_build_cmd, the
// plan rules of generate_nixpacks_confs, generate_build_secrets, generate_secrets_hash, dockerfileInstructions,
// the ARG lines of add_build_env_variables_to_dockerfile, modify_dockerfile_for_secrets, the static Dockerfiles
// of build_static_image and build_image, wrap_build_command_with_env_export, addHostFlags, validatePathField),
// app/Models/Application.php (generateGitImportCommands and setGitImportSettings for a public repository),
// app/Models/EnvironmentVariable.php (getResolvedValueWithServer, scopeWithoutBuildpackControlVariables),
// app/Traits/EnvironmentVariableAnalyzer.php and bootstrap/helpers/{docker,applications}.php (escapeBashEnvValue,
// escapeBashDoubleQuoted, gitSshCommand) (Apache-2.0), modified.
//
// What a deployment that builds an image computes before it runs a command: every function here is pure, so
// the engine (engine.ts) only orders them and runs what they give. Previews, build servers, private sources
// and Docker Compose are not here.
import { FILE_PATH_PATTERN } from "../applications/create.js";
import { parseUrl } from "../applications/domains.js";
import { isValidEnvironmentVariableKey } from "../environment-variables/validation.js";
import { escapeShellValue } from "../helpers/docker.js";
import { gitSshConfigFile } from "./git-ssh.js";
import { escapeshellarg, jsonValidate, phpFloatToString, phpTrim } from "./php.js";
import { containsVaultReference, displayEnvironmentVariableKey, escapeBashEnvValue, escapeEnvVariables, hostsFromFqdn, validDomains, type EnvLogEntry, type RuntimeVariable } from "./runtime-env.js";

// ── Paths in the helper container ───────────────────────────────────────────────────────────────────────

export const BUILD_TIME_ENV_PATH = "/artifacts/build-time.env";
export const BUILD_TIME_SHELL_ENV_PATH = "/artifacts/build-time-shell.env";
export const BUILD_TIME_ENV_LAUNCHER_PATH = "/artifacts/run-with-build-time-env";
export const BUILD_SCRIPT_PATH = "/artifacts/build.sh";
export const NIXPACKS_PLAN_PATH = "/artifacts/thegameplan.json";
/** The Docker config of the helper image: a build-time DOCKER_CONFIG must not move the Docker CLI away from its plugins. */
export const HELPER_DOCKER_CONFIG = "/root/.docker";

/** What stops a build with a DeploymentException; `alreadyLogged` when `logs` already explain it. */
export class BuildError extends Error {
  constructor(
    message: string,
    readonly logs: EnvLogEntry[] = [],
    readonly alreadyLogged = false,
    /** The PHP class of the exception: a RuntimeException for a refused path. */
    readonly phpClass: "DeploymentException" | "RuntimeException" = "DeploymentException",
  ) {
    super(message);
  }
}

/** validatePathField(): a path that is safe inside a shell command. */
export function validatePathField(value: string, fieldName: string): string {
  // PHP's "$" also matches before a final line break.
  if (!FILE_PATH_PATTERN.test(value.endsWith("\n") ? value.slice(0, -1) : value)) throw new BuildError(`Invalid ${fieldName}: contains forbidden characters.`, [], false, "RuntimeException");
  if (value.includes("..")) throw new BuildError(`Invalid ${fieldName}: path traversal detected.`, [], false, "RuntimeException");
  return value;
}

// ── Values ──────────────────────────────────────────────────────────────────────────────────────────────

/** A string, as PHP converts a scalar to one. */
type Scalar = string | number | boolean | null;

/** escapeBashDoubleQuoted(): double-quoted for a sourced .env file, so $VAR still expands. */
export function escapeBashDoubleQuoted(value: string | null): string {
  if (value === null || value === "") return '""';
  let escaped = value.split("\\").join("\\\\").split('"').join('\\"').split("`").join("\\`");
  // A "$" that starts no variable reference is escaped.
  escaped = escaped.replace(/\$(?![a-zA-Z_0-9{])/g, "\\$");
  // preg_replace('/\\\\(?=\$)/', '\\\\', …): a no-op in PHP too — a backslash becomes a backslash.
  return `"${escaped}"`;
}

/** EnvironmentVariable::getResolvedValueWithServer(): the old escaped form of a value, which build paths read. */
export function resolvedValue(variable: Pick<RuntimeVariable, "realValue" | "is_literal" | "is_multiline">): string {
  const real = variable.realValue;
  if (real !== null && jsonValidate(real) && (real.startsWith("{") || real.startsWith("["))) return real;
  if (variable.is_literal || variable.is_multiline) return `'${real ?? ""}'`;
  return escapeEnvVariables(real ?? "");
}

/** uses_remote_secret_references(): Freeploy has no secret manager, so a literal keeps "{{vault.KEY}}" as text. */
export const usesRemoteSecretReferences = (variable: Pick<RuntimeVariable, "value" | "is_literal">): boolean => containsVaultReference(variable.value) && !variable.is_literal;

/** scopeWithoutBuildpackControlVariables(): `key NOT LIKE 'NIXPACKS_%'`, where "_" stands for any one character. */
export const isBuildpackControlVariable = (key: string): boolean => /^(?:NIXPACKS|RAILPACK)[\s\S]/.test(key);

/** The variables in the order they were created: what a query without an ORDER BY gives Coolify. */
export const byCreation = (variables: RuntimeVariable[]): RuntimeVariable[] => [...variables].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

/**
 * The build-time variables a build is given: no buildpack control variables, and only names new variables can
 * use. In the order of the Environment Variables page, or — `created` — in the order they were created.
 */
export function buildtimeVariables(variables: RuntimeVariable[], created = false): RuntimeVariable[] {
  return (created ? byCreation(variables) : variables).filter((v) => v.is_buildtime && !isBuildpackControlVariable(v.key) && isValidEnvironmentVariableKey(v.key));
}

const hasKey = (variables: RuntimeVariable[], key: string): boolean => variables.some((v) => v.key === key);

export interface BuildInput {
  application: { uuid: string; fqdn: string | null; git_branch: string | null; compose_parsing_version: string | null };
  /** application_settings.include_source_commit_in_build */
  includeSourceCommit: boolean;
  /** $this->commit, as it is when the function runs. */
  commit: string;
  /** The production variables, in the order of the Environment Variables page (or by key, when sorted). */
  variables: RuntimeVariable[];
}

const isV3 = (application: BuildInput["application"]): boolean => Math.trunc(Number(application.compose_parsing_version ?? 0)) >= 3;

/** generate_coolify_env_variables(forBuildTime: true) for a deployment that is no preview and no Compose application. */
export function generateCoolifyBuildVariables(input: BuildInput): Array<[string, string | null]> {
  const { application, variables } = input;
  const envs = new Map<string, string | null>();
  // SOURCE_COMMIT changes with each commit and breaks the Docker cache, so a build gets it only when asked.
  if (input.includeSourceCommit && !hasKey(variables, "SOURCE_COMMIT")) envs.set("SOURCE_COMMIT", input.commit);
  const v3 = isV3(application);
  if (!hasKey(variables, "COOLIFY_FQDN")) envs.set(v3 ? "COOLIFY_URL" : "COOLIFY_FQDN", application.fqdn);
  if (!hasKey(variables, "COOLIFY_URL")) envs.set(v3 ? "COOLIFY_FQDN" : "COOLIFY_URL", hostsFromFqdn(application.fqdn));
  if (!hasKey(variables, "COOLIFY_BRANCH")) envs.set("COOLIFY_BRANCH", application.git_branch);
  if (!hasKey(variables, "COOLIFY_RESOURCE_UUID")) envs.set("COOLIFY_RESOURCE_UUID", application.uuid);
  return [...envs];
}

/** Url::fromString($domain)->withPort(null)->__toString() */
function urlWithoutPort(domain: string): string {
  const url = parseUrl(domain);
  if (!url || url.host === undefined) return domain;
  const userinfo = url.user !== undefined ? `${url.user}${url.pass !== undefined ? `:${url.pass}` : ""}@` : "";
  const path = url.path ?? "/";
  return `${(url.scheme ?? "").toLowerCase()}://${userinfo}${url.host}${path !== "/" ? path : ""}${url.query ? `?${url.query}` : ""}${url.fragment ? `#${url.fragment}` : ""}`;
}

/** set_coolify_variables(): the assignments that stand before `docker compose` and become the Dockerfile's ARGs. */
export function coolifyVariables(input: BuildInput): string {
  const { application } = input;
  let out = "";
  if (input.includeSourceCommit) out += `SOURCE_COMMIT=${escapeShellValue(input.commit)} `;
  if (application.fqdn !== null) {
    const domains = validDomains(application.fqdn);
    if (domains.length > 0) {
      const url = domains.map(urlWithoutPort).join(",");
      const hosts = hostsFromFqdn(application.fqdn);
      out += isV3(application) ? `COOLIFY_URL=${escapeShellValue(url)} COOLIFY_FQDN=${escapeShellValue(hosts)} ` : `COOLIFY_URL=${escapeShellValue(hosts)} COOLIFY_FQDN=${escapeShellValue(url)} `;
    }
  }
  if (application.git_branch !== null) out += `COOLIFY_BRANCH=${escapeShellValue(application.git_branch)} `;
  return `${out}COOLIFY_RESOURCE_UUID=${escapeShellValue(application.uuid)} `;
}

export const NO_SECRET_MANAGER = "Environment variables reference remote secrets ({{vault.KEY}}), but no secret manager source is configured for this application.";

/** resolve_environment_variable_raw(): the value with its shared variables filled in; a secret reference has no source to come from. */
export function rawValue(variable: RuntimeVariable): string {
  if (usesRemoteSecretReferences(variable) || (!variable.is_literal && containsVaultReference(variable.realValue))) throw new BuildError(NO_SECRET_MANAGER);
  return variable.realValue ?? "";
}

/** generate_env_variables(): $this->env_args — the build arguments, by name. */
export function generateEnvVariables(input: BuildInput): Map<string, string> {
  const args = new Map<string, string>();
  if (input.includeSourceCommit) args.set("SOURCE_COMMIT", input.commit);
  for (const [key, value] of generateCoolifyBuildVariables(input)) if (value !== null && value !== "") args.set(key, value);
  for (const variable of buildtimeVariables(input.variables, true)) args.set(variable.key, usesRemoteSecretReferences(variable) ? rawValue(variable) : resolvedValue(variable));
  return args;
}

/** logSuggestedShellEnvironmentVariableKey() */
function suggestedShellKey(key: string): EnvLogEntry[] {
  const suggested = key.split(".").join("_");
  if (suggested === key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(suggested)) return [];
  return [{ message: `   Suggested name: ${displayEnvironmentVariableKey(suggested)}`, type: "info" }];
}

/** validatedBuildtimeEnvironmentVariableKey(): the key, or a failure the log already explains. */
export function validatedBuildtimeKey(key: string, origin: string): string {
  if (isValidEnvironmentVariableKey(key)) return key;
  const display = displayEnvironmentVariableKey(key);
  const logs: EnvLogEntry[] = [
    { message: "----------------------------------------", type: "stderr" },
    { message: `⚠️ Invalid environment variable name from ${origin}: ${display}`, type: "stderr" },
    { message: "Build-time variable names must start with a letter or underscore and contain only letters, numbers, underscores, and dots.", type: "stderr" },
    { message: "💡 How to fix:", type: "info" },
  ];
  if (origin === "the Nixpacks plan") {
    logs.push({ message: "   1. Open nixpacks.toml and check the [variables] section. Quoted keys can contain characters that are not valid environment variable names.", type: "info" });
    logs.push({ message: "   2. Rename the key to a plain name like MY_VARIABLE (no spaces, shell syntax, or command substitutions).", type: "info" });
    logs.push(...suggestedShellKey(key));
    logs.push({ message: "   3. Commit, push, and redeploy.", type: "info" });
    logs.push({ message: "Docs: https://nixpacks.com/docs/configuration/file", type: "info" });
  } else {
    logs.push({ message: "   Rename the environment variable to use only letters, numbers, and underscores, then redeploy.", type: "info" });
    logs.push(...suggestedShellKey(key));
  }
  logs.push({ message: "----------------------------------------", type: "stderr" });
  throw new BuildError(`Invalid environment variable name from ${origin}: ${display}. Names must start with a letter or underscore and contain only letters, numbers, underscores, and dots.`, logs, true);
}

/**
 * validateDeploymentEnvironmentVariableKeys() for a deployment that can build (every build pack but Docker
 * image): a name that would break a line of the .env file stops it, and so does a build-time name the build
 * cannot be given once the build is certain (`buildsImage`). Any other name new variables cannot use is logged
 * with a suggestion.
 */
export function validateBuildEnvironmentVariableKeys(variables: Array<Pick<RuntimeVariable, "key" | "is_buildtime" | "is_runtime">>, buildsImage: boolean): EnvLogEntry[] {
  const logs: EnvLogEntry[] = [];
  for (const variable of variables) {
    const key = variable.key;
    if (isValidEnvironmentVariableKey(key)) continue;
    const isEnvFileSafe = key !== "" && !/[=\n\r\0]/.test(key);
    const isLegacyBuildtimeKey = /^[A-Za-z0-9_.-]+$/.test(key);
    if (!isEnvFileSafe || (variable.is_buildtime && buildsImage && !isLegacyBuildtimeKey)) {
      try {
        validatedBuildtimeKey(key, "the deployment environment");
      } catch (e) {
        if (e instanceof BuildError) throw new BuildError(e.message, [...logs, ...e.logs], true);
        throw e;
      }
    }
    // logLegacyEnvironmentVariableKey()
    let suggested = key.replace(/[^A-Za-z0-9_]/g, "_");
    if (/^[0-9]/.test(suggested)) suggested = "_" + suggested;
    const display = displayEnvironmentVariableKey(key);
    if (variable.is_buildtime) {
      logs.push({ message: `⚠️ Build-time variable ${display} uses a name that new variables cannot use. It is skipped during the build${variable.is_runtime ? ", but is still passed to the container." : "."}`, type: "stderr" });
    } else {
      if (variable.is_runtime) logs.push({ message: `⚠️ Runtime variable ${display} uses a name that new variables cannot use. It is still passed to the container, but shell scripts cannot read it.`, type: "stderr" });
      else logs.push({ message: `⚠️ Variable ${display} uses a name that new variables cannot use. This deployment does not use it.`, type: "stderr" });
    }
    logs.push({ message: "   Suggested name: " + displayEnvironmentVariableKey(suggested), type: "info" });
  }
  return logs;
}

/** (string) $value */
export function phpString(value: unknown): string {
  if (value === null || value === undefined || value === false) return "";
  if (value === true) return "1";
  if (typeof value === "string") return value;
  if (value instanceof PhpNumber) return value.toPhpString();
  return String(value);
}

/**
 * generate_buildtime_environment_variables(): the KEY=value lines of /artifacts/build-time.env, which the build
 * script sources — the Nixpacks plan's variables first, then Coolify's, then the user's, a later one replacing
 * an earlier one of its name where that stood.
 */
export function generateBuildtimeEnvironmentVariables(input: BuildInput, planVariables: Array<[string, unknown]> | null): string[] {
  const dict = new Map<string, string>();
  for (const [key, value] of planVariables ?? []) {
    // COOLIFY_* and SERVICE_* are added below, with a higher priority.
    if (key.startsWith("COOLIFY_") || key.startsWith("SERVICE_")) continue;
    dict.set(validatedBuildtimeKey(key, "the Nixpacks plan"), escapeBashEnvValue(phpString(value)));
  }
  for (const [key, value] of generateCoolifyBuildVariables(input)) dict.set(key, escapeBashEnvValue(value ?? ""));
  for (const variable of buildtimeVariables(input.variables)) {
    if (usesRemoteSecretReferences(variable)) {
      dict.set(variable.key, escapeBashEnvValue(rawValue(variable)));
      continue;
    }
    const resolved = resolvedValue(variable);
    // A literal's resolved value stands in quotes; a plain one is double-quoted so that $VAR expands.
    dict.set(variable.key, variable.is_literal || variable.is_multiline ? escapeBashEnvValue(phpTrim(resolved, "'")) : escapeBashDoubleQuoted(resolved));
  }
  return [...dict].map(([key, value]) => `${validatedBuildtimeKey(key, "the build-time environment")}=${value}`);
}

/** The files of save_buildtime_environment_variables() when a name has a dot: bash cannot source such a name, so a launcher passes it with env. */
export function buildtimeEnvironmentFiles(lines: string[]): { launcher: boolean; files: Array<[string, string]> } {
  const isShellKey = (line: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(line.split("=", 1)[0] ?? "");
  const dotted = lines.filter((line) => !isShellKey(line));
  if (dotted.length === 0) return { launcher: false, files: lines.length > 0 ? [[BUILD_TIME_ENV_PATH, lines.join("\n")]] : [] };
  const launcher = ["#!/bin/bash", "set -a", `source ${BUILD_TIME_SHELL_ENV_PATH}`, "set +a", "exec env \\", ...dotted.map((line) => `    ${line} \\`), '    "$@"'];
  return {
    launcher: true,
    files: [
      [BUILD_TIME_ENV_PATH, lines.join("\n")],
      [BUILD_TIME_SHELL_ENV_PATH, lines.filter(isShellKey).join("\n")],
      [BUILD_TIME_ENV_LAUNCHER_PATH, launcher.join("\n") + "\n"],
    ],
  };
}

/** wrap_build_command_with_env_export(): the build command with the build-time .env file in its environment. */
export function wrapBuildCommand(buildCommand: string, workdir: string, useLauncher: boolean): string {
  const command = `export DOCKER_CONFIG=${HELPER_DOCKER_CONFIG} && ${buildCommand}`;
  if (!useLauncher) return `cd ${workdir} && set -a && source ${BUILD_TIME_ENV_PATH} && set +a && ${command}`;
  return `cd ${workdir} && bash ${BUILD_TIME_ENV_LAUNCHER_PATH} /bin/bash -c ${escapeBashEnvValue(command)}`;
}

// ── Warnings about build-time variables ─────────────────────────────────────────────────────────────────

/** EnvironmentVariableAnalyzer::getProblematicBuildVariables(): what each name affects, the issue, the recommendation. */
const PROBLEMATIC_BUILD_VARIABLES: Readonly<Record<string, readonly [string, string, string]>> = {
  NODE_ENV: ["Node.js/npm/yarn/bun/pnpm", "Skips devDependencies installation which are often required for building (webpack, typescript, etc.)", 'Uncheck "Available at Buildtime" or use "development" during build'],
  NPM_CONFIG_PRODUCTION: ["npm/pnpm", "Forces npm to skip devDependencies", "Remove from build-time variables or set to false"],
  YARN_PRODUCTION: ["Yarn/pnpm", "Forces yarn to skip devDependencies", "Remove from build-time variables or set to false"],
  COMPOSER_NO_DEV: ["PHP/Composer", "Skips require-dev packages which may include build tools", 'Set as "Runtime only" or remove from build-time variables'],
  MIX_ENV: ["Elixir/Phoenix", "Production mode may skip development dependencies needed for compilation", 'Use "dev" for build or set as "Runtime only"'],
  RAILS_ENV: ["Ruby on Rails", "May affect asset precompilation and dependency handling", 'Consider using "development" for build phase'],
  RACK_ENV: ["Ruby/Rack", "May affect dependency handling and build behavior", 'Consider using "development" for build phase'],
  BUNDLE_WITHOUT: ["Ruby/Bundler", "Excludes gem groups that may contain build dependencies", "Remove from build-time variables or adjust groups"],
  FLASK_ENV: ["Python/Flask", "May affect debug mode and development tools availability", 'Usually safe, but consider "development" for complex builds'],
  DJANGO_SETTINGS_MODULE: ["Python/Django", "Production settings may disable debug tools needed during build", "Use development settings for build phase"],
  APP_ENV: ["Laravel/Symfony", "May affect dependency installation and build optimizations", 'Consider using "local" or "development" for build'],
  ASPNETCORE_ENVIRONMENT: [".NET/ASP.NET Core", "May affect build-time configurations and optimizations", "Usually safe, but verify build requirements"],
  CI: ["Various tools", "Changes behavior in many tools (disables interactivity, changes caching)", "Usually beneficial for builds, but be aware of behavior changes"],
};

/** analyzeBuildTimeVariables(): what the log says about the user's build-time variables that often break a build. */
export function analyzeBuildTimeVariables(variables: Array<[string, unknown]>, userVariables: RuntimeVariable[]): EnvLogEntry[] {
  const userKeys = userVariables.filter((v) => v.is_buildtime).map((v) => v.key);
  const warned = variables.filter(([key]) => userKeys.includes(key) && Object.hasOwn(PROBLEMATIC_BUILD_VARIABLES, key));
  if (warned.length === 0) return [];
  const logs: EnvLogEntry[] = [{ message: "----------------------------------------", type: "stdout" }];
  for (const [key, value] of warned) {
    const [affects, issue, recommendation] = PROBLEMATIC_BUILD_VARIABLES[key]!;
    logs.push({ message: `⚠️ Build-time environment variable warning: ${key}=${phpString(value)}`, type: "warning" });
    logs.push({ message: `   Affects: ${affects}`, type: "warning" });
    logs.push({ message: `   Issue: ${issue}`, type: "warning" });
    logs.push({ message: `   Recommendation: ${recommendation}`, type: "warning" });
    logs.push({ message: "", type: "stdout" });
  }
  logs.push({ message: "💡 Tips to resolve build issues:", type: "info" });
  logs.push({ message: '   1. Set these variables as "Runtime only" in the environment variables settings', type: "info" });
  logs.push({ message: "   2. Use different values for build-time (e.g., NODE_ENV=development for build)", type: "info" });
  logs.push({ message: "   3. Consider using multi-stage Docker builds to separate build and runtime environments", type: "info" });
  return logs;
}

// ── The secrets hash ────────────────────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

/** hash_hmac('sha256', $text, $key) */
export async function hmacSha256Hex(key: string, text: string): Promise<string> {
  // HMAC pads a short key with zero bytes, so an empty key (which Web Crypto refuses) is one zero byte.
  const cryptoKey = await crypto.subtle.importKey("raw", key === "" ? new Uint8Array(1) : encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(text)));
  return [...signature].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The key of an org's build secrets hash, where Coolify uses its APP_KEY: derived from the deployment
 * encryption key, so it is stable (the Docker build cache survives) and says nothing about that key.
 */
export async function buildSecretsHashKey(secret: string | undefined, orgId: string): Promise<string> {
  return secret ? hmacSha256Hex(secret, `deploy.build-secrets-hash:${orgId}`) : "";
}

/** sortKeys(): PHP's sort of array keys — numeric strings as numbers, the others by byte. */
function phpKeyCompare(a: string, b: string): number {
  const numeric = /^(?:0|-?[1-9][0-9]*)$/;
  if (numeric.test(a) && numeric.test(b)) return Number(a) - Number(b);
  const [x, y] = [encoder.encode(a), encoder.encode(b)];
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/**
 * generate_secrets_hash(): Docker ignores secret values for the build cache, so their hash goes in as a build
 * argument — keyed, and the same for the same values, so the cache survives a deployment that changed none.
 */
export function secretsHash(key: string, variables: Array<[string, unknown]>): Promise<string> {
  const text = [...variables]
    .sort(([a], [b]) => phpKeyCompare(a, b))
    .map(([name, value]) => `${name}=${phpString(value)}`)
    .join("|");
  return hmacSha256Hex(key, text);
}

/** generate_build_secrets(): the --secret flags, without the hash. */
export function buildSecretFlags(variables: Array<[string, unknown]>): string {
  return variables.map(([key]) => `--secret ${escapeshellarg(`id=${validatedBuildtimeKey(key, "the build secret environment")},env=${key}`)}`).join(" ");
}

// ── Dockerfiles ─────────────────────────────────────────────────────────────────────────────────────────

export interface DockerfileInstruction {
  keyword: string;
  start: number;
  end: number;
}

/**
 * dockerfileInstructions(): a Dockerfile's instructions with their first and last line. Comments, continuation
 * lines and heredoc bodies belong to an instruction, so "from app import x" in a heredoc is no instruction.
 */
export function dockerfileInstructions(lines: string[]): DockerfileInstruction[] {
  let escape = "\\";
  const instructions: DockerfileInstruction[] = [];
  let continues = false;
  let heredocTerminators: string[] = [];
  lines.forEach((line, index) => {
    const trimmed = phpTrim(line);
    const last = instructions[instructions.length - 1];
    if (heredocTerminators.length > 0) {
      last!.end = index;
      if (trimmed === heredocTerminators[0]) heredocTerminators.shift();
      return;
    }
    if (trimmed === "" || trimmed.startsWith("#")) {
      const directive = instructions.length === 0 ? /^#\s*escape\s*=\s*([\\`])\s*$/i.exec(trimmed) : null;
      if (directive) escape = directive[1]!;
      return;
    }
    if (continues && last) last.end = index;
    else instructions.push({ keyword: (trimmed.split(/[ \t]/).find((part) => part !== "") ?? "").toUpperCase(), start: index, end: index });
    continues = trimmed.endsWith(escape);
    const keyword = instructions[instructions.length - 1]!.keyword;
    if (["RUN", "COPY", "ADD"].includes(keyword)) {
      const found = [...line.matchAll(/(?<!<)<<-?(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/g)].map((m) => m[2]!);
      if (found.length > 0) heredocTerminators = found;
    }
  });
  return instructions;
}

/** The lines of a file the job read with `cat`: str($output)->trim()->explode("\n"). */
export const savedLines = (saved: string | undefined): string[] => phpTrim(saved ?? "").split("\n");

/** shellAssignmentForDockerfileArg(): KEY='value' as KEY=value. */
function dockerfileArgOf(assignment: string): string {
  const at = assignment.indexOf("=");
  if (at === -1) return assignment;
  let value = assignment.slice(at + 1);
  if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).split("'\\''").join("'");
  return `${assignment.slice(0, at)}=${value}`;
}

/**
 * add_build_env_variables_to_dockerfile(): the Dockerfile with an ARG for every build-time variable, Coolify's
 * variables and the secrets hash after each FROM. Null when the file has no FROM: it is left as it is.
 */
export async function dockerfileWithBuildArgs(saved: string | undefined, variables: RuntimeVariable[], coolifyVars: string | null, hashKey: string): Promise<string | null> {
  const dockerfile = savedLines(saved);
  const fromLines = dockerfileInstructions(dockerfile)
    .filter((i) => i.keyword === "FROM")
    .map((i) => i.end);
  if (fromLines.length === 0) return null;
  const envs = buildtimeVariables(variables, true);
  const args = envs.map((env) => `ARG ${validatedBuildtimeKey(env.key, "the generated Dockerfile")}`);
  // explode(' ', trim(…)): a value with a space is cut there, as Coolify cuts it.
  if (coolifyVars !== null && coolifyVars !== "" && coolifyVars !== "0") {
    args.push(
      ...phpTrim(coolifyVars)
        .split(" ")
        .filter((part) => part !== "" && part !== "0")
        .map((part) => `ARG ${dockerfileArgOf(part)}`),
    );
  }
  if (args.length > 0) {
    // mapWithKeys: a later variable of a name replaces the earlier one.
    const values = new Map<string, string>();
    for (const env of envs) values.set(env.key, escapeBashEnvValue(rawValue(env)));
    args.push(`ARG COOLIFY_BUILD_SECRETS_HASH=${await secretsHash(hashKey, [...values])}`);
    for (const line of [...fromLines].reverse()) dockerfile.splice(line + 1, 0, ...args);
  }
  return dockerfile.join("\n");
}

/**
 * modify_dockerfile_for_secrets(): every RUN gets the secret mounts, and every stage an ARG for the secrets
 * hash, so a changed secret rebuilds it. Null when nothing changed.
 */
export function dockerfileWithSecretMounts(saved: string | undefined, variables: Array<[string, unknown]>): string | null {
  let dockerfile = savedLines(saved);
  if (!(dockerfile[0] ?? "").startsWith("# syntax=")) dockerfile = ["# syntax=docker/dockerfile:1", ...dockerfile];
  if (variables.length === 0) return null;
  const mounts = variables.map(([key]) => `--mount=type=secret,id=${validatedBuildtimeKey(key, "the generated Dockerfile")},env=${key}`).join(" ");
  const instructions = dockerfileInstructions(dockerfile);
  const runLines = instructions.filter((i) => i.keyword === "RUN").map((i) => i.start);
  const fromEndLines = instructions.filter((i) => i.keyword === "FROM").map((i) => i.end);
  let modified = false;
  const out: string[] = [];
  dockerfile.forEach((original, index) => {
    let line = original;
    if (runLines.includes(index) && !line.includes("--mount=type=secret")) {
      line = `RUN ${mounts} ${phpTrim(phpLtrimmed(line).slice(3))}`;
      modified = true;
    }
    out.push(line);
    // A RUN step reads every ARG of its stage, so a changed hash rebuilds it.
    if (fromEndLines.includes(index)) {
      modified = true;
      out.push("ARG COOLIFY_BUILD_SECRETS_HASH");
    }
  });
  return modified ? out.join("\n") : null;
}

const phpLtrimmed = (text: string): string => text.replace(/^[ \t\n\r\0\x0B]+/, "");

/** The Dockerfile of a static site (build_static_image): the repository's files in the web server's folder. */
export function staticDockerfile(image: string, deploymentUuid: string): string {
  return `FROM ${image}
        WORKDIR /usr/share/nginx/html/
        LABEL coolify.deploymentId=${deploymentUuid}
        COPY . .
        RUN rm -f /usr/share/nginx/html/nginx.conf
        RUN rm -f /usr/share/nginx/html/Dockerfile
        RUN rm -f /usr/share/nginx/html/docker-compose.yaml
        RUN rm -f /usr/share/nginx/html/.env
        COPY ./nginx.conf /etc/nginx/conf.d/default.conf`;
}

/** The Dockerfile of an application that is built and then served as a static site (build_image, is_static). */
export function staticSiteDockerfile(image: string, deploymentUuid: string, buildImageName: string, publishDirectory: string | null): string {
  const trimmed = phpTrim(publishDirectory ?? "", "/");
  const publishDir = trimmed !== "" && trimmed !== "0" ? `/${trimmed}` : "";
  return `FROM ${image}\nWORKDIR /usr/share/nginx/html/\nLABEL coolify.deploymentId=${deploymentUuid}\nCOPY --from=${buildImageName} /app${publishDir} .\nCOPY ./nginx.conf /etc/nginx/conf.d/default.conf`;
}

// ── The build's --add-host flags ────────────────────────────────────────────────────────────────────────

/** isGeneratedContainerName(): a rolling update's container. */
const isGeneratedContainerName = (name: string): boolean => /-\d{8}T\d{6}$/.test(name) || /-\d{12}$/.test(name);

/**
 * addHostFlags(): the containers on the destination network as --add-host flags, without the short-lived ones
 * (BuildKit keys every RUN layer on the host names, so a container that comes and goes forces a full rebuild):
 * build helpers, rolling update containers, previews, the backup helpers, the proxy and Sentinel.
 */
export function addHostFlags(containers: unknown, isBuildHelper: (name: string) => boolean): string {
  if (containers === null || typeof containers !== "object") return "";
  const list = Object.values(containers as Record<string, unknown>).filter((c): c is Record<string, unknown> => c !== null && typeof c === "object");
  // $containers->sort(): by the containers' fields in their order, which is by name for what Docker prints.
  list.sort((a, b) => {
    for (const key of Object.keys(a)) {
      const [x, y] = [phpString(a[key] as Scalar), phpString(b[key] as Scalar)];
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  });
  const ips = new Map<string, string>();
  for (const container of list) {
    const name = typeof container.Name === "string" ? container.Name : "";
    if (["coolify-proxy", "coolify-sentinel", "coolify-proxy-error-page"].includes(name)) continue;
    if (isGeneratedContainerName(name) || /-pr-\d+$/.test(name) || isBuildHelper(name)) continue;
    if (name.startsWith("backup-of-") || name.startsWith("s3-restore-")) continue;
    const ip = typeof container.IPv4Address === "string" ? container.IPv4Address : "";
    if (name !== "" && name !== "0" && ip !== "" && ip !== "0") ips.set(name, ip.split("/")[0]!);
  }
  return [...ips].map(([name, ip]) => `--add-host ${name}:${ip}`).join(" ");
}

// ── Git ─────────────────────────────────────────────────────────────────────────────────────────────────

/** gitSshCommand(): the ssh git runs — the helper's SSH config with the pinned host keys, and keep-alives. */
export function gitSshCommand(uuid: string, port: string | number | null = null, identityFile: string | null = null, identitiesOnly = true): string {
  let command = `ssh -F ${gitSshConfigFile(uuid)} -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4`;
  if (port !== null) command += ` -p ${port} -o Port=${port}`;
  command += " -o LogLevel=ERROR";
  if (identityFile !== null) command += ` -i ${identityFile}${identitiesOnly ? " -o IdentitiesOnly=yes" : ""}`;
  return command;
}

export interface GitImportInput {
  deploymentUuid: string;
  /** The repository git clones: "<the public source's URL>/<owner/repo>", or the URL of a repository without a source. */
  fullRepoUrl: string;
  branch: string;
  commit: string;
  isShallowCloneEnabled: boolean;
  isSubmodulesEnabled: boolean;
  isLfsEnabled: boolean;
}

/**
 * generateGitImportCommands() with setGitImportSettings(public: true): the one command that clones a public
 * repository into the helper container — the branch, then the commit when one is pinned, the submodules (their
 * SSH URLs rewritten to HTTPS) and the LFS objects.
 */
export function gitImportCommand(input: GitImportInput): string {
  const baseDir = escapeshellarg(`/artifacts/${input.deploymentUuid}`);
  const ssh = `GIT_SSH_COMMAND="${gitSshCommand(input.deploymentUuid)}"`;
  const depth = input.isShallowCloneEnabled ? " --depth=1" : "";
  const submodules = input.isSubmodulesEnabled ? ` --recurse-submodules${input.isShallowCloneEnabled ? " --shallow-submodules" : ""}` : "";
  // `--` ends the options, so a repository value that starts with `-` is not read as a git option.
  let command = `${input.isLfsEnabled ? "" : "export GIT_LFS_SKIP_SMUDGE=1 && "}git clone${depth}${submodules} -b ${escapeshellarg(input.branch)} -- ${escapeshellarg(input.fullRepoUrl)} ${baseDir}`;
  if (input.commit !== "HEAD") {
    const commit = escapeshellarg(input.commit);
    if (input.isShallowCloneEnabled) {
      const checkout = `git -c advice.detachedHead=false checkout ${commit} >/dev/null 2>&1`;
      if (/^[0-9a-fA-F]{7,39}$/.test(input.commit)) {
        // A remote cannot fetch a short SHA: fetch the tip of each branch, and the full history when the commit is no tip.
        const refspec = escapeshellarg("+refs/heads/*:refs/remotes/origin/*");
        command += ` && cd ${baseDir} && echo 'Fetching the commit.' && ${ssh} git fetch --depth=1 origin ${refspec} && (${checkout} || (echo 'The commit is not a branch tip. Fetching the full history.' && ${ssh} git fetch --unshallow origin ${refspec} && ${checkout}))`;
      } else {
        command += ` && cd ${baseDir} && echo 'Fetching the commit.' && ${ssh} git fetch --depth=1 origin ${commit} && ${checkout}`;
      }
    } else {
      command += ` && cd ${baseDir} && ${ssh} git -c advice.detachedHead=false checkout ${commit} >/dev/null 2>&1`;
    }
  }
  if (input.isSubmodulesEnabled) {
    command += ` && cd ${baseDir} && if [ -f .gitmodules ]; then sed -i "s#[A-Za-z0-9._-]*@\\(.*\\):#https://\\1/#g" ${baseDir}/.gitmodules || true && echo 'Updating submodules.' && git submodule sync && ${ssh} git submodule update --init --recursive ${input.isShallowCloneEnabled ? "--depth=1" : ""}; fi`;
  }
  // `git lfs pull` opens an SSH session even without LFS files; `git lfs ls-files` is offline.
  if (input.isLfsEnabled) command += ` && cd ${baseDir} && if git lfs ls-files -n | grep -q .; then echo 'Downloading Git LFS objects.' && ${ssh} git lfs pull; fi`;
  return `docker exec ${input.deploymentUuid} bash -c '${command.split("'").join("'\\''")}'`;
}

/** gitLsRemoteCommand(): the head of the branch, by its exact ref. */
export function gitLsRemoteCommand(deploymentUuid: string, port: string | number, fullRepoUrl: string, ref: string): string {
  return `GIT_SSH_COMMAND="${gitSshCommand(deploymentUuid, port)}" git ls-remote -- ${escapeshellarg(fullRepoUrl)} ${escapeshellarg(ref)}`;
}

/** The commit of `git ls-remote`'s answer: the 40 hex characters before the tab, whatever warnings stand around them. */
export function commitFromLsRemote(output: string): string | null {
  if (!output.includes("\t")) return null;
  return /\b([0-9a-fA-F]{40})(?=\s*\t)/.exec(output)?.[1] ?? null;
}

// ── Nixpacks ────────────────────────────────────────────────────────────────────────────────────────────

/** A JSON number as PHP holds it: an int, or a float. */
export class PhpNumber {
  constructor(
    readonly isFloat: boolean,
    readonly lexeme: string,
  ) {}
  toPhpString(): string {
    // (string) of a float reads the `precision` setting, json_encode() the shortest digits.
    return this.isFloat ? phpFloatToString(Number(this.lexeme)) : this.lexeme;
  }
  toJson(): string {
    return this.isFloat ? phpJsonFloat(Number(this.lexeme)) : this.lexeme;
  }
}

/** json_encode() of a float (serialize_precision -1): the shortest digits that read back the same; a whole number has no fraction. */
function phpJsonFloat(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const [mantissa = "0", exp = "0"] = Math.abs(value).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const exponent = Number(exp);
  const sign = value < 0 ? "-" : "";
  if (exponent < -4 || exponent >= 15) return `${sign}${digits.charAt(0)}.${digits.length > 1 ? digits.slice(1) : "0"}e${exponent < 0 ? "-" : "+"}${Math.abs(exponent)}`;
  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  if (digits.length <= exponent + 1) return `${sign}${digits}${"0".repeat(exponent + 1 - digits.length)}`;
  return `${sign}${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
}

/** A value of json_decode($json, true): a PHP array is a Map in insertion order, with its keys as strings. */
export type PhpJson = null | boolean | string | PhpNumber | Map<string, PhpJson>;

/** json_decode($text, true); undefined where PHP answers null for text that is no JSON. */
export function phpJsonDecode(text: string): PhpJson | undefined {
  try {
    // The syntax is JSON.parse's to check; the values are read again below, in the order and the types PHP gives them.
    JSON.parse(text);
  } catch {
    return undefined;
  }
  let at = 0;
  const space = (): void => {
    while (at < text.length && " \t\n\r".includes(text[at]!)) at++;
  };
  const string = (): string => {
    const from = at;
    at++;
    while (text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
    at++;
    return JSON.parse(text.slice(from, at)) as string;
  };
  const value = (): PhpJson => {
    space();
    const c = text[at]!;
    if (c === '"') return string();
    if (c === "{" || c === "[") {
      const map = new Map<string, PhpJson>();
      at++;
      space();
      while (text[at] !== "}" && text[at] !== "]") {
        let key = String(map.size);
        if (c === "{") {
          key = string();
          space();
          at++;
        }
        map.set(key, value());
        space();
        if (text[at] === ",") at++;
        space();
      }
      at++;
      return map;
    }
    for (const [word, constant] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, at)) {
        at += word.length;
        return constant;
      }
    }
    const lexeme = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at))![0];
    at += lexeme.length;
    const isInt = /^-?\d+$/.test(lexeme) && lexeme !== "-0" && BigInt(lexeme) >= -(2n ** 63n) && BigInt(lexeme) < 2n ** 63n;
    return new PhpNumber(!isInt, isInt ? BigInt(lexeme).toString() : lexeme);
  };
  return value();
}

/** array_is_list(): the keys are 0, 1, 2, … in that order. */
const isList = (map: Map<string, PhpJson>): boolean => [...map.keys()].every((key, index) => key === String(index));

/** A string as json_encode() writes it by default: "/" and every non-ASCII character escaped. */
function phpJsonEncodeString(value: string): string {
  return JSON.stringify(value)
    .replace(/\//g, "\\/")
    .replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** json_encode($value, JSON_PRETTY_PRINT): four spaces a level, and an array that is a list as a JSON array. */
export function phpJsonEncodePretty(value: PhpJson, depth = 0): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return phpJsonEncodeString(value);
  if (value instanceof PhpNumber) return value.toJson();
  if (value.size === 0) return "[]";
  const pad = "    ".repeat(depth + 1);
  const end = "    ".repeat(depth);
  if (isList(value)) return `[\n${[...value.values()].map((item) => pad + phpJsonEncodePretty(item, depth + 1)).join(",\n")}\n${end}]`;
  return `{\n${[...value].map(([key, item]) => `${pad}${phpJsonEncodeString(key)}: ${phpJsonEncodePretty(item, depth + 1)}`).join(",\n")}\n${end}}`;
}

const asMap = (value: PhpJson | undefined): Map<string, PhpJson> | null => (value instanceof Map ? value : null);

/** data_set($array, 'a.b.c', $value): the maps on the way are made where they are missing. */
function dataSet(root: Map<string, PhpJson>, path: string[], value: PhpJson): void {
  let at = root;
  for (const key of path.slice(0, -1)) {
    let next = asMap(at.get(key));
    if (!next) {
      next = new Map();
      at.set(key, next);
    }
    at = next;
  }
  at.set(path[path.length - 1]!, value);
}

/** The --env flags of `nixpacks plan`: the user's NIXPACKS_* variables, then Coolify's build variables. */
export function nixpacksEnvArgs(input: BuildInput): string {
  const args: string[] = [];
  // nixpacks_environment_variables: `key LIKE 'NIXPACKS_%'`, in the table's order.
  for (const variable of byCreation(input.variables).filter((v) => /^NIXPACKS[\s\S]/.test(v.key))) {
    const resolved = resolvedValue(variable);
    if (resolved === "") continue;
    args.push(`--env ${escapeShellValue(`${variable.key}=${variable.is_literal || variable.is_multiline ? phpTrim(resolved, "'") : resolved}`)}`);
  }
  for (const [key, value] of generateCoolifyBuildVariables(input)) if (value !== null && value !== "") args.push(`--env ${escapeShellValue(`${key}=${value}`)}`);
  return args.join(" ");
}

/** nixpacks_build_cmd(): `nixpacks plan` with the application's own build, start and install commands. */
export function nixpacksPlanCommand(input: BuildInput, commands: { build: string | null; start: string | null; install: string | null }, workdir: string): string {
  const set = (value: string | null): value is string => value !== null && value !== "" && value !== "0";
  let command = `nixpacks plan -f json ${nixpacksEnvArgs(input)}`;
  if (set(commands.build)) command += ` --build-cmd ${escapeShellValue(commands.build)}`;
  if (set(commands.start)) command += ` --start-cmd ${escapeShellValue(commands.start)}`;
  if (set(commands.install)) command += ` --install-cmd ${escapeShellValue(commands.install)}`;
  return `${command} ${workdir}`;
}

export interface NixpacksPlan {
  /** The plan the build is given: json_encode($parsed, JSON_PRETTY_PRINT). */
  plan: string;
  /** The plan the log shows: without its variables. */
  planForLog: string;
  /** $this->nixpacks_plan_json->get('variables') */
  variables: Array<[string, PhpJson]>;
  logs: EnvLogEntry[];
  /** data_get($parsed, 'variables.IS_LARAVEL'): Laravel's two variables are created when they are missing. */
  isLaravel: boolean;
}

/** Laravel's fine tunes: the two variables Nixpacks' PHP provider reads, with the values a Laravel application needs. */
export const LARAVEL_NIXPACKS_VARIABLES: ReadonlyArray<readonly [string, string]> = [
  ["NIXPACKS_PHP_FALLBACK_PATH", "/index.php"],
  ["NIXPACKS_PHP_ROOT_DIR", "/app/public"],
];

/**
 * generate_nixpacks_confs(), what it does with the plan `nixpacks plan` printed: the build arguments join the
 * plan's variables (a dotted name cannot be passed), curl and wget join the setup phase's apt packages (the
 * health check needs one of them), and a Laravel application gets its two variables.
 */
export function nixpacksPlan(planOutput: string, input: BuildInput, nixpacksType: string | null, laravel: (key: string) => string | null): NixpacksPlan {
  const logs: EnvLogEntry[] = [];
  const decoded = phpJsonDecode(planOutput);
  // json_decode() of text that is no JSON object is null (or a scalar): data_set() makes an array of it.
  const parsed: Map<string, PhpJson> = asMap(decoded) ?? new Map();
  // collect(variables)->merge($this->env_args)
  const merged = new Map<string, PhpJson>(asMap(parsed.get("variables")) ?? []);
  for (const [key, value] of generateEnvVariables(input)) merged.set(key, value);
  const dotted = [...merged.keys()].filter((key) => key.includes("."));
  for (const key of dotted) {
    logs.push({ message: `⚠️ Build-time variable ${displayEnvironmentVariableKey(key)} has a dot in its name, which Nixpacks cannot pass to the build. It is skipped during the build, but is still passed to the container.`, type: "stderr" });
    logs.push(...suggestedShellKey(key));
  }
  if (dotted.length > 0) {
    logs.push({ message: '   If the build needs the value, rename the variable. Otherwise, disable "Available at Buildtime" for it.', type: "info" });
    for (const key of dotted) merged.delete(key);
  }
  const setup = asMap(asMap(parsed.get("phases"))?.get("setup"));
  const aptPkgs = [...(asMap(setup?.get("aptPkgs")) ?? new Map<string, PhpJson>()).values()];
  if (aptPkgs.length === 0) aptPkgs.push("curl", "wget");
  else for (const pkg of ["curl", "wget"]) if (!aptPkgs.some((existing) => phpString(existing) === pkg)) aptPkgs.push(pkg);
  dataSet(parsed, ["phases", "setup", "aptPkgs"], new Map(aptPkgs.map((pkg, index) => [String(index), pkg])));
  parsed.set("variables", merged);
  const truthy = (value: PhpJson | undefined): boolean => !(value === undefined || value === null || value === false || value === "" || value === "0" || (value instanceof PhpNumber && Number(value.lexeme) === 0) || (value instanceof Map && value.size === 0));
  const isLaravel = truthy(merged.get("IS_LARAVEL"));
  if (isLaravel) for (const [key] of LARAVEL_NIXPACKS_VARIABLES) merged.set(key, laravel(key));
  if (nixpacksType === "elixir") {
    // elixir_finetunes(): what a Phoenix release needs at build time.
    for (const key of ["MIX_ENV", "SECRET_KEY_BASE", "DATABASE_URL"]) {
      if (input.variables.some((v) => v.key === key)) continue;
      logs.push({ message: `${key} environment variable not found.`, type: "stderr" });
      logs.push({ message: `Please add ${key} environment variable and set it to be build time variable if you facing any issues with the deployment.`, type: "stderr" });
    }
  }
  if (nixpacksType === "node" && (merged.get("NIXPACKS_NODE_VERSION") ?? null) === null) {
    logs.push({ message: "----------------------------------------", type: "stdout" });
    logs.push({ message: "⚠️ NIXPACKS_NODE_VERSION not set. Nixpacks will use Node.js 18 by default, which is EOL.", type: "stdout" });
    logs.push({ message: "You can override this by setting NIXPACKS_NODE_VERSION=22 in your environment variables.", type: "stdout" });
  }
  const forLog = new Map(parsed);
  forLog.delete("variables");
  return { plan: phpJsonEncodePretty(parsed), planForLog: phpJsonEncodePretty(forLog), variables: [...merged], logs, isLaravel };
}

/** The variables of a plan the engine kept as text between two steps. */
export function nixpacksPlanVariables(plan: string | null): Array<[string, PhpJson]> {
  const variables = plan === null ? null : asMap(asMap(phpJsonDecode(plan))?.get("variables"));
  return variables ? [...variables] : [];
}
