// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/parsers.php (composeEnvFileEntries,
// composeEnvFileEntryPath, isCoolifyComposeEnvFile, composeEnvFilesWithCoolifyEnv, composeLongBindVolume,
// composeBindKeepsMissingHostPath, validateComposeServiceName, validateComposeServiceScale,
// validateComposeContentVolumeSource, resolveComposeVolumeSourceVariables, validateComposeArrayVolumeSource,
// composeNetworkNameVariable, isCoolifyProvidedComposeVariable, composeValueReferencesCoolifyProvidedVariable,
// isComposeExternalVolume, composeExternalVolumeDeclaration, composeRenamedVolumeDeclaration,
// validateComposeExternalVolume, isComposeVolumeNameWithVariables, rejectComposeVolumeTargetVariable,
// parseDockerVolumeString, addTraefikDockerNetworkLabel, removeComposeVolumeFieldsPreservingComments),
// bootstrap/helpers/services.php (extractBalancedBraceContent, splitOnOperatorOutsideNested,
// replaceVariables, parseServiceEnvironmentVariable), bootstrap/helpers/shared.php (validateShellSafePath,
// extractYamlEnvironmentComments, extractEnvVarCommentFromYamlLine, extractCommentAfterValue,
// extractCommentFromRemainder, sourceIsLocal, replaceLocalSource, legacyReplaceLocalSource,
// resolveComposeBindSource, parseCommandFromMagicEnvVariable, isAssociativeArray,
// convertToKeyValueCollection, generateDockerComposeServiceName, extractDockerComposePassthroughKeys,
// extractDockerComposeEnvironmentVariableReferences, dockerComposeBareReferenceDefault,
// dockerComposeEnvironmentVariableIsRequired, firstDomainFromList, getFqdnWithoutPort, getHostWithoutPort,
// parseDomainUrlParts, generateFqdn), bootstrap/helpers/docker.php (isDatabaseImage,
// isDatabaseImageWithContext, firstDockerComposeServicePort), bootstrap/helpers/domains.php
// (normalizeComposeServiceName, findComposeServiceName), bootstrap/helpers/constants.php
// (DATABASE_DOCKER_IMAGES, SPECIFIC_SERVICES, RESTART_MODE) and app/Support/ValidationPatterns.php
// (VOLUME_NAME_PATTERN, DOCKER_NETWORK_PATTERN) (Apache-2.0), modified.
//
// The pure helpers Coolify's service parser calls: no row is read or written here. Each keeps Coolify's
// name in camelCase and Coolify's behaviour, including where it is surprising (PHP's loose truthiness,
// `explode` limits, what a missing `=` means); the messages of the exceptions are Coolify's.
import { PhpArray, isNumeric, phpString, phpTruthy, type PhpValue } from "../compose/php.js";
import { after, afterLast, before, beforeLast, collect, dataGet, filterBoolean, ltrim, merge, replaceFirst, replaceLast, trim } from "../compose/support.js";
import { dumpYaml, parseDockerComposeYaml } from "../compose/yaml.js";
import { parseUrl, sslipHostLabel } from "../applications/domains.js";

/** What Coolify throws as a plain `Exception` while parsing a Compose file. */
export class ComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeError";
  }
}

export const RESTART_MODE = "unless-stopped";

export const DATABASE_DOCKER_IMAGES: readonly string[] = [
  "bitnami/mariadb", "bitnami/mongodb", "bitnami/redis", "bitnamilegacy/mariadb", "bitnamilegacy/mongodb", "bitnamilegacy/redis",
  "bitnamisecure/mariadb", "bitnamisecure/mongodb", "bitnamisecure/redis", "mysql", "bitnami/mysql", "bitnamilegacy/mysql",
  "bitnamisecure/mysql", "mysql/mysql-server", "mariadb", "postgis/postgis", "postgres", "bitnami/postgresql",
  "bitnamilegacy/postgresql", "bitnamisecure/postgresql", "supabase/postgres", "elestio/postgres", "mongo", "redis", "memcached",
  "couchdb", "neo4j", "influxdb", "clickhouse/clickhouse-server", "timescaledb/timescaledb", "timescaledb", "timescaledb-ha",
  "pgvector/pgvector",
];

export const SPECIFIC_SERVICES: readonly string[] = [
  "quay.io/minio/minio", "minio/minio", "ghcr.io/coollabsio/minio", "coollabsio/minio", "pgsty/silo", "docker.io/pgsty/silo", "svhd/logto", "dxflrs/garage",
];

const VOLUME_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const DOCKER_NETWORK_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export const isValidDockerNetwork = (name: string): boolean => DOCKER_NETWORK_PATTERN.test(name);

// ---- validation ----

const DANGEROUS_CHARACTERS: readonly (readonly [string, string])[] = [
  ["`", "backtick (command substitution)"],
  ["$(", "command substitution"],
  ["${", "variable substitution with potential command injection"],
  ["|", "pipe operator"],
  ["&", "background/AND operator"],
  [";", "command separator"],
  ["\n", "newline (command separator)"],
  ["\r", "carriage return"],
  ["\t", "tab (token separator)"],
  [">", "output redirection"],
  ["<", "input redirection"],
];

/** validateShellSafePath(). */
export function validateShellSafePath(input: string, context = "path"): string {
  for (const [character, description] of DANGEROUS_CHARACTERS) {
    if (input.includes(character)) {
      throw new ComposeError(`Invalid ${context}: contains forbidden character '${character}' (${description}). Shell metacharacters are not allowed for security reasons.`);
    }
  }
  return input;
}

/** validateComposeServiceName(). */
export function validateComposeServiceName(serviceName: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(serviceName) || serviceName.endsWith("\n")) {
    throw new ComposeError(
      `Service name "${serviceName}" must start with a letter or a digit and contain only letters, digits, ".", "-", and "_". ` +
        "Docker uses the same rule for container names, and Coolify uses the service name at the start of the container name.",
    );
  }
}

/** validateComposeServiceScale(). */
export function validateComposeServiceScale(serviceName: string, service: PhpValue): void {
  for (const key of ["scale", "deploy.replicas"]) {
    const value = dataGet(service, key);
    if (isNumeric(value) && Math.trunc(Number(phpString(value))) > 1) {
      throw new ComposeError(
        `Service "${serviceName}" sets ${key} to ${phpString(value)}. Coolify sets a container_name for each service, ` +
          "and Docker Compose cannot run more than one container with the same container_name. " +
          `Remove ${key}, or define each instance as a separate service.`,
      );
    }
  }
}

// ---- variables ----

export interface BalancedBraces {
  content: string;
  start: number;
  end: number;
}

/** extractBalancedBraceContent(): the text between the first "{" at or after `startPos` and its "}". */
export function extractBalancedBraceContent(text: string, startPos = 0): BalancedBraces | null {
  if (startPos >= text.length) return null;
  const open = text.indexOf("{", startPos);
  if (open === -1) return null;
  let depth = 1;
  let position = open + 1;
  while (position < text.length && depth > 0) {
    if (text[position] === "{") depth += 1;
    else if (text[position] === "}") depth -= 1;
    position += 1;
  }
  if (depth !== 0) return null;
  return { content: text.slice(open + 1, position - 1), start: open, end: position - 1 };
}

export interface OperatorSplit {
  variable: string;
  operator: string;
  default: string;
}

/** splitOnOperatorOutsideNested(): "VAR:-default" at the first of `:-`, `-`, `:?`, `?` outside nested braces. */
export function splitOnOperatorOutsideNested(content: string): OperatorSplit | null {
  const operators = [":-", "-", ":?", "?"];
  let depth = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "{") depth += 1;
    else if (content[index] === "}") depth -= 1;
    else if (depth === 0) {
      for (const operator of operators) {
        if (content.startsWith(operator, index)) {
          return { variable: content.slice(0, index), operator, default: content.slice(index + operator.length) };
        }
      }
    }
  }
  return null;
}

/** replaceVariables(): "${VAR…}", "{VAR}" or "$VAR" without its sigils. */
export function replaceVariables(variable: string): string {
  if (variable.startsWith("${")) {
    const result = extractBalancedBraceContent(variable, 0);
    if (result !== null) return result.content;
    return replaceFirst("{", "", replaceFirst("$", "", before(variable, "}")));
  }
  if (variable.startsWith("{") && variable.endsWith("}")) return variable.slice(1, -1);
  if (variable.startsWith("{")) {
    const result = extractBalancedBraceContent(`$${variable}`, 0);
    if (result !== null) return result.content;
    return before(replaceFirst("{", "", variable), "}");
  }
  if (variable.startsWith("$")) return replaceFirst("$", "", variable);
  return variable;
}

/** parseServiceEnvironmentVariable(): the service name (lower case) and port of a SERVICE_URL_/SERVICE_FQDN_ key. */
export function parseServiceEnvironmentVariable(key: string): { service_name: string; port: string | null; has_port: boolean } {
  const lastSegment = afterLast(key, "_");
  const hasPort = /^[0-9]+$/.test(lastSegment);
  let serviceName = "";
  if (key.startsWith("SERVICE_URL_")) serviceName = after(key, "SERVICE_URL_");
  else if (key.startsWith("SERVICE_FQDN_")) serviceName = after(key, "SERVICE_FQDN_");
  else return { service_name: "", port: hasPort ? lastSegment : null, has_port: hasPort };
  if (hasPort) serviceName = beforeLast(serviceName, "_");
  return { service_name: serviceName.toLowerCase(), port: hasPort ? lastSegment : null, has_port: hasPort };
}

/** parseCommandFromMagicEnvVariable(): "PASSWORD_64" of SERVICE_PASSWORD_64_X, "FQDN" of SERVICE_FQDN_X_3000, "" otherwise. */
export function parseCommandFromMagicEnvVariable(key: string): string {
  const count = key.split("_").length - 1;
  const isDomain = key.startsWith("SERVICE_FQDN") || key.startsWith("SERVICE_URL");
  if (count === 2) return beforeLast(after(key, "SERVICE_"), "_");
  if (count === 3) return isDomain ? before(after(key, "SERVICE_"), "_") : beforeLast(after(key, "SERVICE_"), "_");
  return "";
}

/** isCoolifyProvidedComposeVariable(). */
export function isCoolifyProvidedComposeVariable(key: string): boolean {
  return ["COOLIFY_RESOURCE_UUID", "COOLIFY_CONTAINER_NAME", "COOLIFY_BRANCH", "COOLIFY_URL", "COOLIFY_FQDN", "COOLIFY_APP_NAME", "COOLIFY_PROJECT_NAME", "COOLIFY_ENVIRONMENT_NAME", "COOLIFY_SERVER_IP"].includes(key);
}

/** composeValueReferencesCoolifyProvidedVariable(). */
export function composeValueReferencesCoolifyProvidedVariable(value: string): boolean {
  const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)/.exec(value);
  return match !== null && isCoolifyProvidedComposeVariable(match[1] ?? "");
}

/** composeNetworkNameVariable(): a network name that is one variable, with its `-` default. */
export function composeNetworkNameVariable(name: string): { variable: string; default: string | null } | null {
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?([-?+])([^}]*))?\}$/.exec(name);
  if (!match || name.endsWith("\n")) return null;
  return { variable: match[1] ?? "", default: (match[2] ?? "") === "-" ? (match[3] ?? "") : null };
}

/** extractDockerComposeEnvironmentVariableReferences(): the variables a value refers to, braced ones first. */
export function extractDockerComposeEnvironmentVariableReferences(value: PhpValue): string[] {
  if (typeof value !== "string" || !value.includes("$")) return [];
  const braced = [...value.matchAll(/(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1] ?? "");
  const bare = [...value.matchAll(/(?<!\$)\$(?!\{)([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1] ?? "");
  return [...new Set([...braced, ...bare])];
}

function quote(text: string): string {
  return text.replace(/[.\\+*?[^\]$(){}=!<>|:\-#/]/g, "\\$&");
}

/** dockerComposeEnvironmentVariableIsRequired(): the Compose file has `${KEY:?…}` or `${KEY?…}`. */
export function dockerComposeEnvironmentVariableIsRequired(dockerCompose: string | null, key: string): boolean {
  if (dockerCompose === null || trim(dockerCompose) === "") return false;
  return new RegExp(`(?<!\\$)\\$\\{${quote(key)}(?::\\?|\\?)`).test(dockerCompose);
}

/** dockerComposeBareReferenceDefault(): the one default a variable has elsewhere in the file, for its bare references. */
export function dockerComposeBareReferenceDefault(dockerCompose: string, key: string): string | null {
  const quoted = quote(key);
  if (!new RegExp(`(?<!\\$)\\$(?:${quoted}(?![A-Za-z0-9_])|\\{${quoted}\\})`).test(dockerCompose)) return null;
  const defaults = new Set<string>();
  let offset = 0;
  for (;;) {
    const start = dockerCompose.indexOf(`\${${key}`, offset);
    if (start === -1) break;
    offset = start + 2;
    if (start > 0 && dockerCompose[start - 1] === "$") continue;
    const reference = extractBalancedBraceContent(dockerCompose.slice(start));
    const split = reference === null ? null : splitOnOperatorOutsideNested(reference.content);
    if (split === null || split.variable !== key) continue;
    if (split.operator.includes("?")) return null;
    defaults.add(split.default);
  }
  return defaults.size === 1 ? ([...defaults][0] ?? null) : null;
}

// ---- environment ----

/** isAssociativeArray(): an array that is not a list; an empty one is not associative. */
export function isAssociativeArray(array: PhpArray): boolean {
  return array.size > 0 && !array.isList();
}

/** convertToKeyValueCollection(): `- KEY=value` lists and `KEY: value` maps as one map. */
export function convertToKeyValueCollection(environment: PhpArray): PhpArray {
  const converted = new PhpArray();
  if (isAssociativeArray(environment)) {
    for (const [key, value] of environment) {
      if (typeof key === "number") {
        const text = phpString(value);
        const index = text.indexOf("=");
        if (index !== -1) converted.set(text.slice(0, index), text.slice(index + 1));
        else if (typeof value === "string" && value !== "") converted.set(value, converted.get(value) ?? null);
      } else {
        converted.set(key, value);
      }
    }
    return converted;
  }
  for (const value of environment.values()) {
    if (typeof value !== "string") continue;
    const index = value.indexOf("=");
    const key = index === -1 ? value : value.slice(0, index);
    if (phpTruthy(key)) converted.set(key, index === -1 ? "" : value.slice(index + 1));
  }
  return converted;
}

/** extractDockerComposePassthroughKeys(): `- KEY` and `KEY:` (null), which take their value from the host. */
export function extractDockerComposePassthroughKeys(environment: PhpValue): string[] {
  const keys: string[] = [];
  for (const [key, value] of collect(environment)) {
    let found: string | null;
    if (typeof key === "number") found = typeof value === "string" && !value.includes("=") ? value : null;
    else found = value === null ? key : null;
    if (found !== null && phpTruthy(found) && !keys.includes(found)) keys.push(found);
  }
  return keys;
}

/** generateDockerComposeServiceName(): SERVICE_NAME_<NAME> for every service of the file. */
export function generateDockerComposeServiceName(services: PhpArray): PhpArray {
  const names = new PhpArray();
  for (const key of services.keys()) {
    const name = String(key);
    names.set(`SERVICE_NAME_${name.replaceAll("-", "_").replaceAll(".", "_").toUpperCase()}`, name);
  }
  return names;
}

function extractCommentFromRemainder(remainder: string): string | null {
  const hash = remainder.indexOf("#");
  if (hash === -1) return null;
  const comment = trim(remainder.slice(hash + 1));
  return comment !== "" ? comment : null;
}

function extractCommentAfterValue(input: string): string | null {
  const text = ltrim(input);
  if (text === "") return null;
  const first = text[0];
  if (first === "#") {
    const comment = trim(text.slice(1));
    return comment !== "" ? comment : null;
  }
  if (first === '"') {
    let position = 1;
    while (position < text.length) {
      if (text[position] === "\\" && position + 1 < text.length) {
        position += 2;
        continue;
      }
      if (text[position] === '"') return extractCommentFromRemainder(text.slice(position + 1));
      position += 1;
    }
    return null;
  }
  if (first === "'") {
    const closing = text.indexOf("'", 1);
    return closing === -1 ? null : extractCommentFromRemainder(text.slice(closing + 1));
  }
  const match = /\s+#\s*(.*)$/.exec(text);
  if (match) {
    const comment = trim(match[1] ?? "");
    return comment !== "" ? comment : null;
  }
  return null;
}

/** extractYamlEnvironmentComments(): the `# comment` after each variable of the `environment:` blocks. */
export function extractYamlEnvironmentComments(rawYaml: string): Map<string, string> {
  const comments = new Map<string, string>();
  let inBlock = false;
  let blockIndent = 0;
  for (const line of rawYaml.split("\n")) {
    if (trim(line) === "") continue;
    const indent = line.length - ltrim(line).length;
    const start = /^(\s*)environment\s*:\s*$/.exec(line);
    if (start) {
      inBlock = true;
      blockIndent = (start[1] ?? "").length;
      continue;
    }
    if (/^(\s*)environment\s*:\s*\{/.test(line)) continue;
    if (!inBlock) continue;
    const trimmed = ltrim(line);
    if (indent <= blockIndent && !trimmed.startsWith("-") && !trimmed.startsWith("#") && /^[a-zA-Z_][a-zA-Z0-9_]*\s*:/.test(trimmed)) {
      inBlock = false;
      continue;
    }
    if (trimmed.startsWith("#")) continue;
    let key: string | null = null;
    let comment: string | null = null;
    if (trimmed.startsWith("-")) {
      const content = ltrim(trimmed.slice(1));
      const match = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(content);
      if (match) {
        key = match[1] ?? null;
        comment = extractCommentAfterValue(content);
      }
    } else {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(trimmed);
      if (match) {
        key = match[1] ?? null;
        comment = extractCommentAfterValue(trimmed.slice(match[0].length));
      }
    }
    if (key !== null && comment !== null) comments.set(key, comment);
  }
  return comments;
}

// ---- images and ports ----

const containsAny = (text: string, needles: readonly string[]): boolean => needles.some((needle) => needle !== "" && text.includes(needle));

function isDatabaseImageWithContext(imageName: string, serviceConfig: PhpArray): boolean {
  const knownApplications = [
    "supertokens/supertokens-mysql", "supertokens/supertokens-postgresql", "supertokens/supertokens-mongodb",
    "registry.supertokens.io/supertokens/supertokens-mysql", "registry.supertokens.io/supertokens/supertokens-postgresql",
    "registry.supertokens.io/supertokens/supertokens-mongodb", "registry.supertokens.io/supertokens", "metabase/metabase",
    "amancevice/superset", "nocodb/nocodb", "ghcr.io/umami-software/umami", "infisical/infisical", "postgrest/postgrest",
    "supabase/postgres-meta", "bluewaveuptime/uptime_redis",
  ];
  if (containsAny(imageName, knownApplications)) return false;

  const databasePorts = ["3306", "5432", "27017", "6379", "8086", "9200", "7687", "8123"];
  const ports = dataGet(serviceConfig, "ports", new PhpArray());
  let hasStandardDbPort = false;
  if (ports instanceof PhpArray) hasStandardDbPort = ports.values().some((port) => containsAny(phpString(port), databasePorts));

  const environment = dataGet(serviceConfig, "environment", new PhpArray());
  let hasDbEnvVars = false;
  let hasAppEnvVars = false;
  if (environment instanceof PhpArray) {
    for (const env of environment.values()) {
      const upper = phpString(env).toUpperCase();
      if (containsAny(upper, ["MYSQL_ROOT_PASSWORD", "POSTGRES_PASSWORD", "MONGO_INITDB_ROOT_PASSWORD", "REDIS_PASSWORD"])) hasDbEnvVars = true;
      if (containsAny(upper, ["SERVICE_FQDN", "API_KEYS", "APP_", "APPLICATION_"])) hasAppEnvVars = true;
    }
  }

  const healthcheck = dataGet(serviceConfig, "healthcheck.test", new PhpArray());
  const healthcheckText = healthcheck instanceof PhpArray ? healthcheck.values().map(phpString).join(" ") : typeof healthcheck === "string" ? healthcheck : "";
  let hasDbHealthcheck = false;
  let hasAppHealthcheck = false;
  if (phpTruthy(healthcheckText)) {
    const upper = healthcheckText.toUpperCase();
    hasDbHealthcheck = containsAny(upper, ["PG_ISREADY", "MYSQLADMIN PING", "MONGO", "REDIS-CLI PING"]);
    hasAppHealthcheck = containsAny(upper, ["CURL", "WGET", "HTTP://", "HTTPS://", "/HEALTH", "/API/", "/HELLO"]);
  }

  const dependsOn = dataGet(serviceConfig, "depends_on", new PhpArray());
  let dependsOnDatabases = false;
  if (dependsOn instanceof PhpArray) dependsOnDatabases = dependsOn.keys().some((name) => containsAny(String(name), ["mysql", "postgres", "mongo", "redis", "mariadb"]));

  if (hasAppEnvVars && dependsOnDatabases) return false;
  if (hasAppHealthcheck) return false;
  if (hasStandardDbPort && hasDbHealthcheck) return true;
  if (hasDbEnvVars) return true;
  if (dependsOnDatabases) return false;
  return true;
}

/** isDatabaseImage(): a known database image that, by the rest of its service, is used as a database. */
export function isDatabaseImage(image: string | null, serviceConfig: PhpValue = null): boolean {
  if (image === null) return false;
  const tagged = image.includes(":") ? image : `${image}:latest`;
  const imageName = before(tagged, ":");
  const baseImageName = imageName.includes("/") ? afterLast(imageName, "/") : imageName;
  const known = DATABASE_DOCKER_IMAGES.some((candidate) => baseImageName === (candidate.includes("/") ? afterLast(candidate, "/") : candidate));
  if (!known) return false;
  if (serviceConfig instanceof PhpArray) return isDatabaseImageWithContext(imageName, serviceConfig);
  return true;
}

/** firstDockerComposeServicePort(): the first TCP port of `expose` and `ports`. */
export function firstDockerComposeServicePort(service: PhpValue): number | null {
  const definitions = merge(collect(dataGet(service, "expose", new PhpArray())), collect(dataGet(service, "ports", new PhpArray())));
  for (const definition of definitions.values()) {
    const text = phpString(definition);
    const protocol = definition instanceof PhpArray ? phpString(dataGet(definition, "protocol", "tcp")) : text.includes("/") ? afterLast(text, "/") : "tcp";
    if (protocol !== "tcp") continue;
    const port = definition instanceof PhpArray ? dataGet(definition, "target") : afterLast(before(text, "/"), ":");
    if (isNumeric(port)) {
      const number = Math.trunc(Number(phpString(port)));
      if (number >= 1 && number <= 65535) return number;
    }
  }
  return null;
}

// ---- domains ----

export const normalizeComposeServiceName = (serviceName: string): string => serviceName.replaceAll("-", "_").replaceAll(".", "_");

/** findComposeServiceName(): the service a name from a variable means, when exactly one fits. */
export function findComposeServiceName(candidate: string, serviceNames: readonly string[]): string | null {
  if (serviceNames.includes(candidate)) return candidate;
  const normalized = normalizeComposeServiceName(candidate);
  const matches = serviceNames.filter((name) => normalizeComposeServiceName(name) === normalized);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** firstDomainFromList(). */
export function firstDomainFromList(fqdns: string | null): string {
  return trim((fqdns ?? "").split(",")[0] ?? "");
}

function parseDomainUrlParts(fqdn: string): { scheme: string; host: string; path: string } | null {
  // spatie/url reads parse_url(): a string without a scheme has no host.
  const parts = parseUrl(fqdn);
  const host = parts?.host ?? "";
  if (host === "") return null;
  const path = parts?.path === undefined || parts.path === "/" ? "" : parts.path;
  return { scheme: (parts?.scheme ?? "").toLowerCase(), host, path };
}

/** getFqdnWithoutPort(). */
export function getFqdnWithoutPort(fqdn: string): string {
  const parts = parseDomainUrlParts(fqdn);
  if (parts === null || parts.scheme === "") return fqdn;
  return `${parts.scheme}://${parts.host}${parts.path}`;
}

/** getHostWithoutPort(). */
export function getHostWithoutPort(fqdn: string): string {
  const parts = parseDomainUrlParts(fqdn);
  return parts === null ? fqdn : `${parts.host}${parts.path}`;
}

export interface DomainServer {
  ip: string;
  wildcardDomain: string | null;
}

function wildcardParts(server: DomainServer): { scheme: string; host: string; path: string } {
  let parts = server.wildcardDomain === null || server.wildcardDomain === "" ? null : parseUrl(server.wildcardDomain);
  if (!parts?.scheme || !parts.host) parts = parseUrl(`http://${sslipHostLabel(server.ip)}.sslip.io`);
  const path = parts?.path === undefined || parts.path === "/" ? "" : parts.path;
  return { scheme: (parts?.scheme ?? "http").toLowerCase(), host: parts?.host ?? "", path };
}

/** generateUrl(): "<scheme>://<random>.<host><path>" below the server's wildcard domain (or sslip.io). */
export function generateServiceUrl(server: DomainServer, random: string, forceHttps = false): string {
  const { scheme, host, path } = wildcardParts(server);
  return `${forceHttps ? "https" : scheme}://${random}.${host}${path}`;
}

/** generateFqdn(): the same without the scheme from parser version 5 on (Coolify 4.0.0-beta.420.7 and later). */
export function generateServiceFqdn(server: DomainServer, random: string, parserVersion: number): string {
  const { scheme, host, path } = wildcardParts(server);
  if (parserVersion >= 5) return `${random}.${host}${path}`;
  return `${scheme}://${random}.${host}${path}`;
}

// ---- volumes ----

/** sourceIsLocal(): a host path rather than a volume name. */
export function sourceIsLocal(source: string): boolean {
  return source.startsWith("./") || source.startsWith("/") || source.startsWith("~") || source.startsWith("..");
}

/** legacyReplaceLocalSource(). */
export function legacyReplaceLocalSource(input: string, replacedWith: string): string {
  let source = input;
  if (source.startsWith(".")) source = replaceFirst(".", replacedWith, source);
  if (source.startsWith("~")) source = replaceFirst("~", replacedWith, source);
  if (source.startsWith("..")) source = replaceFirst("..", replacedWith, source);
  if (source.endsWith("/") && source !== "/") source = replaceLast("/", "", source);
  return source;
}

/** replaceLocalSource(): a path with ".." is resolved against the directory. */
export function replaceLocalSource(source: string, replacedWith: string): string {
  let path = source;
  if (!path.split("/").includes("..")) return legacyReplaceLocalSource(source, replacedWith);
  if (path.startsWith("~")) path = replacedWith + path.slice(1);
  else if (!path.startsWith("/")) path = `${replacedWith}/${path}`;
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) throw new ComposeError(`Volume source ${source} resolves to a path above /. Remove some ../ segments.`);
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const resolved = `/${segments.join("/")}`;
  validateShellSafePath(resolved, "volume source");
  return resolved;
}

/** resolveComposeBindSource(): the saved storage keeps the path older versions gave it. */
export function resolveComposeBindSource(source: string, directory: string, existingFsPath: string | null = null): string {
  const legacy = legacyReplaceLocalSource(source, directory);
  if (existingFsPath !== null && new RegExp(`^${quote(legacy)}(-pr-\\d+)?$`).test(existingFsPath) && !existingFsPath.endsWith("\n")) return legacy;
  return replaceLocalSource(source, directory);
}

/** resolveComposeVolumeSourceVariables(): `${VAR:-default}` in a volume source becomes its value or default. */
export function resolveComposeVolumeSourceVariables(source: string, variables: ReadonlyMap<string, string> | null = null): string {
  const resolve = (values: ReadonlyMap<string, string>): string =>
    source.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}/g, (_match, name: string, fallback: string | undefined) => {
      const value = values.get(name) ?? "";
      if (value !== "") return value;
      return (fallback ?? "") !== "" ? (fallback ?? "") : `\${${name}}`;
    });
  const withoutValues = resolve(new Map());
  if (variables === null) return withoutValues;
  const withValues = resolve(variables);
  return sourceIsLocal(withValues) ? withValues : withoutValues;
}

function rejectComposeVolumeTargetVariable(target: string, prefix: string): void {
  if (target.includes("${")) {
    throw new ComposeError(`${prefix}: the container path ${target} contains a variable. Coolify does not support variables in the container path of a volume. Write the path without variables, for example /app/data.`);
  }
}

const VALID_MODES = ["ro", "rw", "z", "Z", "rslave", "rprivate", "rshared", "slave", "private", "shared", "cached", "delegated", "consistent"];

export interface ParsedVolume {
  source: string | null;
  target: string | null;
  mode: string | null;
}

/** parseDockerVolumeString(): "source:target:mode" with Windows drives, `${VAR:-default}` sources and the injection checks. */
export function parseDockerVolumeString(input: string, variables: ReadonlyMap<string, string> | null = null): ParsedVolume {
  const variableTexts: string[] = [];
  const volume = trim(input).replace(/\$\{[^}]*\}/g, (match) => {
    variableTexts.push(match);
    return `\0${variableTexts.length - 1}\0`;
  });
   
  const restore = (part: string | null): string | null => (part === null ? null : part.replace(/\0(\d+)\0/g, (match, index: string) => variableTexts[Number(index)] ?? match));

  let source: string | null = null;
  let target: string | null = null;
  let mode: string | null = null;
  const colons = volume.split(":").length - 1;
  const windowsDrive = /^[A-Za-z]:/.test(volume);
  const splitTargetAndMode = (remaining: string): void => {
    const lastColon = remaining.lastIndexOf(":");
    if (lastColon !== -1 && VALID_MODES.includes(remaining.slice(lastColon + 1))) {
      mode = remaining.slice(lastColon + 1);
      target = remaining.slice(0, lastColon);
    } else {
      target = remaining;
    }
  };
  if (colons === 0) {
    source = volume;
    target = volume;
  } else if (colons === 1) {
    const parts = volume.split(":");
    source = parts[0] ?? "";
    target = parts[1] ?? "";
  } else if (colons === 2 && windowsDrive) {
    const second = volume.indexOf(":", 2);
    source = volume.slice(0, second);
    target = volume.slice(second + 1);
  } else if (colons === 2) {
    const lastColon = volume.lastIndexOf(":");
    const possibleMode = volume.slice(lastColon + 1);
    if (VALID_MODES.includes(possibleMode)) {
      mode = possibleMode;
      const withoutMode = volume.slice(0, lastColon);
      const colon = withoutMode.indexOf(":");
      source = colon === -1 ? withoutMode : withoutMode.slice(0, colon);
      target = colon === -1 ? withoutMode : withoutMode.slice(colon + 1);
    } else {
      const first = volume.indexOf(":");
      source = volume.slice(0, first);
      target = volume.slice(first + 1);
    }
  } else if (windowsDrive) {
    const second = volume.indexOf(":", 2);
    source = volume.slice(0, second);
    splitTargetAndMode(volume.slice(second + 1));
  } else {
    const first = volume.indexOf(":");
    source = volume.slice(0, first);
    splitTargetAndMode(volume.slice(first + 1));
  }

  source = restore(source);
  target = restore(target);
  mode = restore(mode);
  if (source !== null && phpTruthy(source)) source = resolveComposeVolumeSourceVariables(source, variables);
  if (source !== null) {
    try {
      validateShellSafePath(source.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, ""), "volume source");
    } catch (error) {
      throw new ComposeError(`Invalid Docker volume definition: ${(error as Error).message} Please use safe path names without shell metacharacters.`);
    }
    const unset = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(source);
    if (variables !== null && sourceIsLocal(source) && unset) {
      const name = unset[1] ?? "";
      throw new ComposeError(
        `Invalid Docker volume definition: the host path ${source} uses the variable ${name}, which has no value. ` +
          `Set ${name} in the environment variables of the resource, or add a default, for example \${${name}:-/data}.`,
      );
    }
  }
  if (target !== null) {
    rejectComposeVolumeTargetVariable(target, "Invalid Docker volume definition");
    try {
      validateShellSafePath(target, "volume target");
    } catch (error) {
      throw new ComposeError(`Invalid Docker volume definition: ${(error as Error).message} Please use safe path names without shell metacharacters.`);
    }
  }
  return { source, target, mode };
}

/** validateComposeArrayVolumeSource(). */
export function validateComposeArrayVolumeSource(source: string): void {
  try {
     
    if (/[\x00-\x1F\x7F]/.test(source)) throw new ComposeError("Invalid volume source: contains a control character.");
    if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}[/\w.-]*$/.test(source)) return;
    const withDefault = /^\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]*)\}$/.exec(source);
    if (withDefault) {
      validateShellSafePath(withDefault[1] ?? "", "volume source");
      return;
    }
    validateShellSafePath(source, "volume source");
  } catch (error) {
    throw new ComposeError(`Invalid Docker volume definition (array syntax): ${(error as Error).message} Please use safe path names without shell metacharacters.`);
  }
}

/** validateComposeContentVolumeSource(). */
export function validateComposeContentVolumeSource(volume: PhpArray): void {
  if (!volume.has("content") || volume.get("type") !== "bind") return;
  const source = volume.get("source");
  if (typeof source !== "string" || trim(source) === "") {
    throw new ComposeError("Invalid Docker volume definition (array syntax): A bind volume with content needs a source path.");
  }
  validateComposeArrayVolumeSource(source);
}

/** composeLongBindVolume(): the long form of a bind mount with the keys Docker Compose knows. */
export function composeLongBindVolume(input: PhpArray, source: string): PhpArray {
  const volume = new PhpArray();
  for (const [key, value] of input) {
    if (["type", "source", "target", "read_only", "consistency", "bind"].includes(String(key)) || String(key).startsWith("x-")) volume.set(key, value);
  }
  const target = /^(.+):(ro|rw)$/.exec(phpString(volume.get("target") ?? ""));
  if (target) {
    volume.set("target", target[1] ?? "");
    if ((volume.get("read_only") ?? null) === null) volume.set("read_only", target[2] === "ro");
  }
  volume.set("source", source);
  const bind = volume.get("bind");
  const bindOptions = bind instanceof PhpArray ? bind.clone() : new PhpArray();
  if ((bindOptions.get("create_host_path") ?? null) === null) bindOptions.set("create_host_path", true);
  volume.set("bind", bindOptions);
  return volume;
}

/** composeBindKeepsMissingHostPath(): `bind.create_host_path: false` without content. */
export function composeBindKeepsMissingHostPath(volume: PhpValue): boolean {
  return volume instanceof PhpArray && dataGet(volume, "bind.create_host_path") === false && !volume.has("content");
}

/** isComposeExternalVolume(). */
export function isComposeExternalVolume(declaration: PhpValue | undefined): boolean {
  if (!(declaration instanceof PhpArray) || !declaration.has("external")) return false;
  const external = declaration.get("external") ?? null;
  return external instanceof PhpArray ? true : filterBoolean(external);
}

function isComposeVolumeNameWithVariables(name: string): boolean {
  return name.includes("$") && /^(?:[A-Za-z0-9._-]|\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*(?::?-[A-Za-z0-9._-]*)?\})+$/.test(name);
}

function validateComposeExternalVolume(key: string, declaration: PhpArray): void {
  if (!VOLUME_NAME_PATTERN.test(key)) {
    throw new ComposeError("Invalid external Docker Compose volume. Volume names must start with an alphanumeric character and contain only alphanumeric characters, dots, hyphens, and underscores.");
  }
  const names: PhpValue[] = [];
  if (declaration.has("name")) names.push(declaration.get("name") ?? null);
  const external = declaration.get("external");
  if (external instanceof PhpArray && external.has("name")) names.push(external.get("name") ?? null);
  for (const name of names) {
    if (typeof name !== "string" || (!VOLUME_NAME_PATTERN.test(name) && !isComposeVolumeNameWithVariables(name))) {
      throw new ComposeError(`Invalid external Docker Compose volume ${key}. The name must be a Docker volume name (alphanumeric characters, dots, hyphens, and underscores) and can contain variables such as \${NAME} or \${NAME:-default}.`);
    }
  }
}

/** composeExternalVolumeDeclaration(): the declaration of an `external: true` volume, validated; null otherwise. */
export function composeExternalVolumeDeclaration(topLevelVolumes: PhpArray, source: string): PhpArray | null {
  const declaration = topLevelVolumes.get(source);
  if (!isComposeExternalVolume(declaration)) return null;
  validateComposeExternalVolume(source, declaration as PhpArray);
  return declaration as PhpArray;
}

/** composeLegacyExternalVolumeWarning(). */
export function composeLegacyExternalVolumeWarning(source: string, declaration: PhpArray, legacyName: string): string {
  const dockerVolume = composeExternalVolumeDockerName(source, declaration);
  const external = dockerVolume === source ? "external" : `external (Docker volume '${dockerVolume}')`;
  return `Volume '${source}' is declared as ${external}, but Coolify still uses '${legacyName}' because this resource used it before. To use the external volume, copy your data into it and delete the storage entry '${legacyName}', then redeploy.`;
}

/** composeExternalVolumeDockerName(). */
export function composeExternalVolumeDockerName(key: string, declaration: PhpArray): string {
  return phpString(dataGet(declaration, "name") ?? dataGet(declaration, "external.name") ?? key);
}

/** composeRenamedVolumeDeclaration(): the declaration under Coolify's name, no longer external. */
export function composeRenamedVolumeDeclaration(declaration: PhpValue | undefined, name: string): PhpArray {
  const renamed = declaration instanceof PhpArray ? declaration.clone() : new PhpArray();
  renamed.delete("external");
  renamed.delete("name");
  renamed.set("name", name);
  return renamed;
}

// ---- env_file, labels ----

/** composeEnvFilesWithCoolifyEnv(): the service's env files with Coolify's `.env` last, once. */
export function composeEnvFilesWithCoolifyEnv(envFile: PhpValue): PhpArray {
  const entries = envFile === null ? [] : envFile instanceof PhpArray ? envFile.values() : [envFile];
  const path = (entry: PhpValue): string => (entry instanceof PhpArray ? phpString(entry.get("path") ?? "") : phpString(entry));
  const kept: PhpValue[] = [];
  for (const entry of [...entries.filter((item) => ![".env", "./.env"].includes(path(item))), ".env"]) {
    // Collection::unique compares loosely; two arrays are equal when their pairs are.
    const same = (other: PhpValue): boolean => (entry instanceof PhpArray || other instanceof PhpArray ? dumpYaml(entry, 0) === dumpYaml(other, 0) : phpString(entry) === phpString(other));
    if (!kept.some(same)) kept.push(entry);
  }
  return PhpArray.list(kept);
}

/** addTraefikDockerNetworkLabel(): unless the service names its own network for Traefik. */
export function addTraefikDockerNetworkLabel(labels: PhpArray, network: string): PhpArray {
  const defined = labels.values().some((label) => typeof label === "string" && before(label, "=") === "traefik.docker.network");
  if (!defined) labels.push(`traefik.docker.network=${network}`);
  return labels;
}

/** Strict `===` between two PHP values: same keys in the same order, same types. */
export function phpIdentical(a: PhpValue, b: PhpValue): boolean {
  return typeof a === typeof b && dumpTyped(a) === dumpTyped(b);
}

function dumpTyped(value: PhpValue): string {
  if (value instanceof PhpArray) return `[${value.entries().map(([key, item]) => `${typeof key}:${String(key)}=>${dumpTyped(item)}`).join(",")}]`;
  if (value === null) return "null";
  if (typeof value === "object") return `float:${String(value.value)}`;
  return `${typeof value}:${JSON.stringify(typeof value === "bigint" ? String(value) : value)}`;
}

/** removeComposeVolumeFieldsPreservingComments(): the raw file without `content:`, `is_directory:` … under a service volume. */
export function removeComposeVolumeFieldsPreservingComments(source: string, cleanedYaml: PhpValue, fields: readonly string[]): string {
  const context: { indent: number; key: string }[] = [];
  let removeIndent: number | null = null;
  let blockIndent: number | null = null;
  const result: string[] = [];
  for (const line of source.split(/(?<=\n)/)) {
    const text = line.replace(/[\r\n]+$/, "");
    const indent = text.length - text.replace(/^ +/, "").length;
    if (removeIndent !== null) {
      if (trim(text) === "" || indent > removeIndent) continue;
      removeIndent = null;
    }
    if (blockIndent !== null) {
      if (trim(text) === "" || indent > blockIndent) {
        result.push(line);
        continue;
      }
      blockIndent = null;
    }
    if (trim(text) === "" || ltrim(text).startsWith("#")) {
      result.push(line);
      continue;
    }
    while (context.length > 0 && (context[context.length - 1]?.indent ?? -1) >= indent) context.pop();
    let body = text.slice(indent);
    const isListItem = /^-\s+/.test(body);
    if (isListItem) {
      context.push({ indent, key: "[]" });
      body = body.replace(/^-\s+/, "");
    }
    const match = /^([\w.-]+|"[^"]+"|'[^']+')\s*:(.*)$/.exec(body);
    if (match) {
      const key = (match[1] ?? "").replace(/^["']+|["']+$/g, "");
      const path = context.map((entry) => entry.key);
      if (!isListItem && path.length === 4 && path[0] === "services" && path[2] === "volumes" && path[3] === "[]" && fields.includes(key)) {
        removeIndent = indent;
        continue;
      }
      const value = trim(match[2] ?? "");
      if (value === "" || value.startsWith("#")) context.push({ indent, key });
      else if (/^[|>][+-]?(?:\s+#.*)?$/.test(value)) blockIndent = indent;
    }
    result.push(line);
  }
  const candidate = result.join("");
  try {
    if (phpIdentical(parseDockerComposeYaml(candidate), cleanedYaml)) return candidate;
  } catch {
    // Not readable any more: write the cleaned file instead.
  }
  return dumpYaml(cleanedYaml);
}
