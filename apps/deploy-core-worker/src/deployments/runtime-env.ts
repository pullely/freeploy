// Derived from coollabsio/coolify@91b7e3e:app/Jobs/ApplicationDeploymentJob.php
// (generate_runtime_environment_variables, runtimeEnvironmentAssignment, generate_coolify_env_variables,
// hostsFromFqdn, validDomainsFromFqdn, validateDeploymentEnvironmentVariableKeys, logLegacyEnvironmentVariableKey,
// logInvalidBuildtimeEnvironmentVariableKey, logSuggestedShellEnvironmentVariableKey), app/Models/Application.php
// (detectPortFromEnvironment, coolifyBranch), app/Models/EnvironmentVariable.php (the build pack control
// variables, logRedactionValues, logRedactionSecretsFor, isLockedForLogs), app/Traits/HasSecretManager.php
// (environmentVariableAllowsInterpolation), app/Support/{RemoteSecretReferences,ValidationPatterns}.php and
// bootstrap/helpers/{shared,docker}.php (coolifyDefaultEnvironmentVariables, escapeComposeEnvFileValue,
// escapeEnvVariables, escapeBashEnvValue) (Apache-2.0), modified.
//
// The lines of the .env file a Docker image deployment writes next to its compose file — the variables that
// tell the container where it runs, then the application's runtime variables — and the values the deployment
// log hides. Pure functions of plain row data; byte-equal to Coolify's PHP for every run of
// tests/deploy-core-worker/fixtures/deployments.
//
// Every Freeploy variable is written with "exact escaping": the escaping Coolify keeps for variables saved
// before it (environment_variables.uses_legacy_escaping) never applies, because the column is false for every
// row Freeploy writes. Remote secret references ({{vault.KEY}}) have no source here: a variable that uses one
// stops the deployment with Coolify's message, unless it is literal (then the text stays as it is).
import { isValidDomainUrl, parseUrl } from "../applications/domains.js";
import { isValidEnvironmentVariableKey } from "../environment-variables/validation.js";
import { mainPort } from "./compose.js";
import { jsonValidate, phpLtrim, phpTrim } from "./php.js";

/** A variable of the application as a deployment reads it. */
export interface RuntimeVariable {
  key: string;
  /** The stored value, decrypted, without its edge line breaks; null when nothing is stored. */
  value: string | null;
  /** The value with its shared variable references filled in — locked ones too (get_real_environment_variables). */
  realValue: string | null;
  is_literal: boolean;
  is_multiline: boolean;
  is_runtime: boolean;
  is_buildtime: boolean;
  /** Locked: the value is never shown again. */
  is_shown_once: boolean;
  /** It references a shared variable that is locked, or whose scope cannot be told (isLockedForLogs). */
  referencesLockedSharedVariable: boolean;
}

export interface RuntimeEnvInput {
  application: { uuid: string; name: string; fqdn: string | null; git_branch: string | null; ports_exposes: string | null; compose_parsing_version: string | null };
  settings: { is_static: boolean | null; include_coolify_default_variables: boolean | null; is_container_label_readonly_enabled: boolean | null };
  /** The deployment's commit. */
  commit: string | null;
  containerName: string;
  projectName: string;
  environmentName: string;
  serverIp: string | null;
  /** The production variables, in the order of the Environment Variables page (or by key, when sorted). */
  variables: RuntimeVariable[];
}

export interface EnvLogEntry {
  message: string;
  type: "stdout" | "stderr" | "info";
}

/** What Coolify reports with a DeploymentException; `alreadyLogged` when the log already explains it. */
export class RuntimeEnvError extends Error {
  constructor(
    message: string,
    readonly alreadyLogged = false,
  ) {
    super(message);
  }
}

/** escapeComposeEnvFileValue(): a double-quoted dotenv value; `$` is escaped unless Compose may interpolate it. */
export function escapeComposeEnvFileValue(value: string | null, allowInterpolation = false): string {
  let escaped = (value ?? "").split("\\").join("\\\\").split('"').join('\\"');
  if (!allowInterpolation) escaped = escaped.split("$").join("\\$");
  return `"${escaped}"`;
}

/** RemoteSecretReferences::PATTERN */
const VAULT_REFERENCE = /{{\s*vault\.([A-Za-z0-9_]+)\s*}}/;
const containsVaultReference = (value: string | null): boolean => value !== null && phpTrim(value) !== "" && VAULT_REFERENCE.test(value);

export const NO_SECRET_MANAGER_MESSAGE = "Environment variables reference remote secrets ({{vault.KEY}}), but no secret manager source is configured for this application.";

/** EnvironmentVariable::RUNTIME_BUILDPACK_CONTROL_VARIABLES: the buildpack control variables a built image reads when it starts. */
const RUNTIME_BUILDPACK_CONTROL_VARIABLES = ["NIXPACKS_PHP_ROOT_DIR", "NIXPACKS_PHP_FALLBACK_PATH", "NIXPACKS_SPA_OUTPUT_DIR", "RAILPACK_SKIP_MIGRATIONS"];
/** scopeWithoutBuildOnlyBuildpackControlVariables(): NIXPACKS_* and RAILPACK_* stay out of the container, but for those four. */
const isRuntimeScoped = (key: string): boolean => RUNTIME_BUILDPACK_CONTROL_VARIABLES.includes(key) || !(key.startsWith("NIXPACKS_") || key.startsWith("RAILPACK_"));

/** validDomainsFromFqdn() */
const validDomains = (fqdn: string | null): string[] => (fqdn ?? "").split(",").map((d) => phpTrim(d)).filter((d) => d !== "" && d !== "0" && isValidDomainUrl(d));

/** hostsFromFqdn(): comma-separated hosts without scheme, port, or path (the COOLIFY_FQDN value). */
export function hostsFromFqdn(fqdn: string | null): string {
  return validDomains(fqdn)
    .map((domain) => parseUrl(domain)?.host ?? "")
    .join(",");
}

const hasKey = (variables: RuntimeVariable[], key: string): boolean => variables.some((v) => v.key === key);

/**
 * generate_coolify_env_variables() for the runtime of a deployment that is no preview, then
 * coolifyDefaultEnvironmentVariables(): each only when the user has no variable of that name.
 */
export function generateCoolifyEnvVariables(input: RuntimeEnvInput): Array<[string, string]> {
  const { application, variables } = input;
  const envs = new Map<string, string | null>();
  if (!hasKey(variables, "SOURCE_COMMIT")) envs.set("SOURCE_COMMIT", input.commit !== null ? input.commit : "unknown");
  const v3 = Math.trunc(Number(application.compose_parsing_version ?? 0)) >= 3;
  if (!hasKey(variables, "COOLIFY_FQDN")) envs.set(v3 ? "COOLIFY_URL" : "COOLIFY_FQDN", application.fqdn);
  if (!hasKey(variables, "COOLIFY_URL")) envs.set(v3 ? "COOLIFY_FQDN" : "COOLIFY_URL", hostsFromFqdn(application.fqdn));
  // Not a Compose application: the branch, the uuid and the container's name.
  if (!hasKey(variables, "COOLIFY_BRANCH")) envs.set("COOLIFY_BRANCH", application.git_branch);
  if (!hasKey(variables, "COOLIFY_RESOURCE_UUID")) envs.set("COOLIFY_RESOURCE_UUID", application.uuid);
  if (!hasKey(variables, "COOLIFY_CONTAINER_NAME")) envs.set("COOLIFY_CONTAINER_NAME", input.containerName);
  // Runtime only, so a project or server change does not break the Docker build cache.
  if (input.settings.include_coolify_default_variables !== false) {
    const defaults: Array<[string, string | null]> = [
      ["COOLIFY_APP_NAME", application.name],
      ["COOLIFY_PROJECT_NAME", input.projectName],
      ["COOLIFY_ENVIRONMENT_NAME", input.environmentName],
      ["COOLIFY_SERVER_IP", input.serverIp],
    ];
    for (const [key, value] of defaults) if (value !== null && !hasKey(variables, key)) envs.set(key, value);
  }
  return [...envs].map(([key, value]) => [key, value ?? ""]);
}

/** HasSecretManager::environmentVariableAllowsInterpolation(): only plain values allow Compose $VAR interpolation. */
function allowsInterpolation(variable: RuntimeVariable, value: string): boolean {
  const first = phpLtrim(value).charAt(0);
  const isJson = jsonValidate(value) && (first === "{" || first === "[");
  return !isJson && !variable.is_literal && !variable.is_multiline;
}

/** runtimeEnvironmentAssignment(): a KEY="value" line for the runtime .env file, which Docker Compose reads. */
export function runtimeEnvironmentAssignment(variable: RuntimeVariable): string {
  const resolved = variable.realValue ?? "";
  if (containsVaultReference(variable.value) || containsVaultReference(resolved)) {
    // resolve_environment_variable_raw(): without a source, a literal keeps "{{vault.KEY}}" as text; other
    // references fail closed.
    if (!variable.is_literal) throw new RuntimeEnvError(NO_SECRET_MANAGER_MESSAGE);
    return `${variable.key}=${escapeComposeEnvFileValue(resolved)}`;
  }
  return `${variable.key}=${escapeComposeEnvFileValue(resolved, allowsInterpolation(variable, resolved))}`;
}

/** Application::detectPortFromEnvironment(): the PORT variable's value when it is a number. */
function detectPort(variables: RuntimeVariable[]): number | null {
  const port = variables.find((v) => v.key === "PORT");
  // "$portVar && $portVar->real_value": PHP's truthiness, so "" and "0" are no port.
  if (!port || port.realValue === null || port.realValue === "" || port.realValue === "0") return null;
  const value = phpTrim(port.realValue);
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ? Math.trunc(Number(value)) : null;
}

export interface RuntimeEnv {
  /** The lines of the .env file; none means an empty file. */
  lines: string[];
  logs: EnvLogEntry[];
}

/**
 * generate_runtime_environment_variables() for a Docker image deployment that is no preview: the generated
 * variables, the runtime variables (those that reference SERVICE_ variables last), then PORT and HOST when
 * the user has none.
 */
export function generateRuntimeEnvironmentVariables(input: RuntimeEnvInput): RuntimeEnv {
  const logs: EnvLogEntry[] = [];
  const lines = generateCoolifyEnvVariables(input).map(([key, value]) => `${key}=${escapeComposeEnvFileValue(value)}`);
  const ports = mainPort(input.application, input.settings);

  const runtime = input.variables.filter((v) => isRuntimeScoped(v.key) && v.is_runtime);
  // sortBy(): stable, so each group keeps the page's order.
  const referencesService = (v: RuntimeVariable): boolean => (v.value ?? "").startsWith("$SERVICE_") || (v.value ?? "").includes("${SERVICE_");
  for (const variable of [...runtime.filter((v) => !referencesService(v)), ...runtime.filter(referencesService)]) lines.push(runtimeEnvironmentAssignment(variable));

  // With readonly labels disabled, custom labels control proxy routing, so the check is skipped.
  if (input.settings.is_container_label_readonly_enabled !== false) {
    const detected = detectPort(input.variables);
    // in_array($detectedPort, $ports): a loose comparison of a number with "80".
    if (detected !== null && detected !== 0 && ports.length > 0 && !ports.some((port) => Number(port) === detected)) {
      logs.push({
        message: `Warning: PORT environment variable (${detected}) does not match configured ports_exposes: ${ports.join(",")}. It could case "bad gateway" or "no server" errors. Check the "General" page to fix it.`,
        type: "stderr",
      });
    }
  }
  // Add PORT if not exists, use the first port as default
  if (!hasKey(input.variables, "PORT") && ports.length > 0) lines.push(`PORT=${ports[0]}`);
  // Add HOST if not exists
  if (!hasKey(input.variables, "HOST")) lines.push("HOST=0.0.0.0");
  return { lines, logs };
}

/** ValidationPatterns::displayShellEnvironmentVariableKey(): a key that is safe to show in a log. */
export function displayEnvironmentVariableKey(value: string, maxLength = 80): string {
  const printable = value
    .split("\0").join("\\0")
    .split("\r").join("\\r")
    .split("\n").join("\\n")
    .split("\t").join("\\t")
    .replace(/[\x00-\x1F\x7F]/g, (c) => "\\x" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
  if (printable === "") return "(empty)";
  // Str::limit(): by display width, which is the length for these characters.
  const chars = [...printable];
  return chars.length <= maxLength ? printable : chars.slice(0, maxLength).join("").replace(/\s+$/u, "") + "...";
}

/**
 * validateDeploymentEnvironmentVariableKeys() for a deployment that builds nothing: a name that would break a
 * line of the .env file stops the deployment; any other name new variables cannot use is logged with a
 * suggestion and stays.
 */
export function validateDeploymentEnvironmentVariableKeys(variables: Array<Pick<RuntimeVariable, "key" | "is_buildtime" | "is_runtime">>): EnvLogEntry[] {
  const logs: EnvLogEntry[] = [];
  for (const variable of variables) {
    const key = variable.key;
    if (isValidEnvironmentVariableKey(key)) continue;
    const display = displayEnvironmentVariableKey(key);
    if (key === "" || /[=\n\r\0]/.test(key)) {
      // logInvalidBuildtimeEnvironmentVariableKey($key, 'the deployment environment')
      logs.push({ message: "----------------------------------------", type: "stderr" });
      logs.push({ message: `⚠️ Invalid environment variable name from the deployment environment: ${display}`, type: "stderr" });
      logs.push({ message: "Build-time variable names must start with a letter or underscore and contain only letters, numbers, underscores, and dots.", type: "stderr" });
      logs.push({ message: "💡 How to fix:", type: "info" });
      logs.push({ message: "   Rename the environment variable to use only letters, numbers, and underscores, then redeploy.", type: "info" });
      const suggestion = key.split(".").join("_");
      if (suggestion !== key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(suggestion)) logs.push({ message: `   Suggested name: ${displayEnvironmentVariableKey(suggestion)}`, type: "info" });
      logs.push({ message: "----------------------------------------", type: "stderr" });
      throw Object.assign(
        new RuntimeEnvError(`Invalid environment variable name from the deployment environment: ${display}. Names must start with a letter or underscore and contain only letters, numbers, underscores, and dots.`, true),
        { logs },
      );
    }
    // logLegacyEnvironmentVariableKey(): a Docker image deployment passes no build-time variables.
    let suggested = key.replace(/[^A-Za-z0-9_]/g, "_");
    if (/^[0-9]/.test(suggested)) suggested = "_" + suggested;
    if (variable.is_buildtime) {
      logs.push({ message: `⚠️ Build-time variable ${display} uses a name that new variables cannot use. This deployment does not build an image, so it is not used as a build-time variable. Rename it before you use it in a build.`, type: "stderr" });
    }
    if (variable.is_runtime) {
      logs.push({ message: `⚠️ Runtime variable ${display} uses a name that new variables cannot use. It is still passed to the container, but shell scripts cannot read it.`, type: "stderr" });
    }
    if (!variable.is_buildtime && !variable.is_runtime) {
      logs.push({ message: `⚠️ Variable ${display} uses a name that new variables cannot use. This deployment does not use it.`, type: "stderr" });
    }
    logs.push({ message: "   Suggested name: " + displayEnvironmentVariableKey(suggested), type: "info" });
  }
  return logs;
}

/** escapeEnvVariables(): the old escaping of a plain value, which build-time paths still write. */
function escapeEnvVariables(value: string): string {
  const pairs: Array<[string, string]> = [["\\", "\\\\"], ["\r", "\\r"], ["\t", "\\t"], ["\0", "\\0"], ['"', '\\"'], ["'", "\\'"]];
  let out = value;
  for (const [search, replace] of pairs) out = out.split(search).join(replace);
  return out;
}

/** escapeBashEnvValue(): single-quoted for a sourced .env file. */
const escapeBashEnvValue = (value: string): string => (value === "" ? "''" : `'${value.split("'").join("'\\''")}'`);

/** EnvironmentVariable::logRedactionValues(): the forms of a variable's value a log could show. */
export function logRedactionValues(variable: RuntimeVariable): string[] {
  const resolved = variable.realValue;
  if (resolved === null || resolved === "") return [];
  // legacyEscapedValue(): build-time paths still write the old escaped form, so both forms are hidden.
  const first = resolved.charAt(0);
  const quoted = variable.is_literal || variable.is_multiline;
  const value = jsonValidate(resolved) && (first === "{" || first === "[") ? resolved : quoted ? `'${resolved}'` : escapeEnvVariables(resolved);
  let values = [value, resolved];
  if (quoted) {
    const unquoted = value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value;
    values = [...values, unquoted, escapeBashEnvValue(unquoted), unquoted.split("'").join("'\\''"), unquoted.replace(/\r\n|\r|\n/g, "\\n")];
    if (variable.is_multiline) values.push(...unquoted.split(/\r\n|\r|\n/));
  }
  return values.filter((v, i) => v !== "" && values.indexOf(v) === i);
}

export interface LogRedactionSecrets {
  /** Values hidden when they are long enough to be safe to match: every unlocked value, unless only locked values are hidden. */
  known: string[];
  /** Values always hidden: locked ones. */
  locked: string[];
}

/** EnvironmentVariable::logRedactionSecretsFor() for an application's production variables. */
export function logRedactionSecretsFor(variables: RuntimeVariable[], redactAllValues: boolean): LogRedactionSecrets {
  const secrets: LogRedactionSecrets = { known: [], locked: [] };
  for (const variable of variables) {
    if (variable.is_shown_once || variable.referencesLockedSharedVariable) secrets.locked.push(...logRedactionValues(variable));
    else if (redactAllValues) secrets.known.push(...logRedactionValues(variable));
  }
  return secrets;
}
