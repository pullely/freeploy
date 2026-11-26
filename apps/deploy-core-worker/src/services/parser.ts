// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/parsers.php (serviceParser,
// resolveServicePart, markServicePartsRemovedFromCompose, ensureComposeNetworkNameVariables,
// keepSavedComposeBindSource, composeVolumeSourceVariables, resolveComposeLongBindSource,
// forgetComposeBindStorage, useComposeExternalVolumeAsWritten, composeRenamedVolumeDeclarationFor),
// bootstrap/helpers/shared.php (coolifyDefaultEnvironmentVariables, preserveLegacyDockerComposeNullAssignments,
// fillDockerComposeDefaultsForBareReferences, syncDockerComposeEnvironmentVariableRequiredState,
// convertToArray), bootstrap/helpers/docker.php (generateServiceSpecificFqdns), bootstrap/helpers/domains.php
// (findServiceApplicationForEnvName, isCopiedServiceUrlDeclaration), bootstrap/helpers/services.php
// (applyServiceApplicationPrerequisites), bootstrap/helpers/constants.php (NEEDS_TO_DISABLE_GZIP,
// NEEDS_TO_DISABLE_STRIPPREFIX), app/Livewire/Project/Resource/Create.php (createResource, the one-click
// service part), app/Models/Service.php (parse, getRequiredPort, the creating hook),
// app/Models/ServiceApplication.php (getRequiredPort, serviceType, fqdns, the saving hook),
// app/Models/EnvironmentVariable.php (the value and key mutators, the saving hook) and Laravel's
// firstOrCreate / updateOrCreate as these functions use them (Apache-2.0), modified.
//
// Coolify's Compose parser for services. `parseService` is `Service::parse()` for parser version 3 and
// later (`serviceParser`): it reads the service's Compose file, creates the service's applications and
// databases, its environment variables (the magic SERVICE_FQDN_*, SERVICE_URL_*, SERVICE_PASSWORD_* … ones
// with generated values), its volumes, and writes `docker_compose`, the file that is deployed: with
// container names, Coolify's labels and the proxy's, the service network, renamed volumes and `.env`.
//
// The function is synchronous over a `ServiceStore` (store.ts). Everything else it needs is in
// `ServiceParserContext`: the server and names the labels and domains are made of, and the sources of
// randomness (generated values, uuids) and time. The order of every read and write follows the PHP,
// because the ids of the rows, the order of the variables and the bytes of the file depend on it.
//
// Verified against Coolify's own PHP for every template of the catalogue:
// tests/deploy-core-worker/fixtures/services (see its README).
import { PhpArray, PhpFloat, deepClone, phpString, phpTruthy, type PhpKey, type PhpValue } from "../compose/php.js";
import { after, afterLast, before, beforeLast, blank, collect, dataGet, looseEquals, merge } from "../compose/support.js";
import { dumpYaml, parseDockerComposeYaml } from "../compose/yaml.js";
import { normalizeDomainPortOverrides, normalizeApplicationDomainUrl, domainWithoutPort, syncNoindexDomains } from "../applications/domains.js";
import { ENVIRONMENT_VARIABLE_VERSION } from "../environment-variables/service.js";
import { validatedEnvironmentVariableKey } from "../environment-variables/validation.js";
import { defaultLabels, escapeDollarSign, fqdnLabelsForCaddy, fqdnLabelsForTraefik, slug, type LabelDependencies, DEFAULT_LABEL_DEPENDENCIES } from "../labels/labels.js";
import { newPublicId } from "../helpers/names.js";
import {
  ComposeError,
  RESTART_MODE,
  SPECIFIC_SERVICES,
  addTraefikDockerNetworkLabel,
  composeBindKeepsMissingHostPath,
  composeEnvFilesWithCoolifyEnv,
  composeExternalVolumeDeclaration,
  composeLegacyExternalVolumeWarning,
  composeLongBindVolume,
  composeNetworkNameVariable,
  composeRenamedVolumeDeclaration,
  composeValueReferencesCoolifyProvidedVariable,
  convertToKeyValueCollection,
  dockerComposeBareReferenceDefault,
  dockerComposeEnvironmentVariableIsRequired,
  extractBalancedBraceContent,
  extractDockerComposeEnvironmentVariableReferences,
  extractDockerComposePassthroughKeys,
  extractYamlEnvironmentComments,
  findComposeServiceName,
  firstDockerComposeServicePort,
  firstDomainFromList,
  generateDockerComposeServiceName,
  generateServiceFqdn,
  generateServiceUrl,
  getFqdnWithoutPort,
  getHostWithoutPort,
  isAssociativeArray,
  isCoolifyProvidedComposeVariable,
  isDatabaseImage,
  isValidDockerNetwork,
  parseCommandFromMagicEnvVariable,
  parseDockerVolumeString,
  parseServiceEnvironmentVariable,
  phpIdentical,
  removeComposeVolumeFieldsPreservingComments,
  replaceVariables,
  resolveComposeBindSource,
  resolveComposeVolumeSourceVariables,
  sourceIsLocal,
  splitOnOperatorOutsideNested,
  validateComposeArrayVolumeSource,
  validateComposeContentVolumeSource,
  validateComposeServiceName,
  validateComposeServiceScale,
  validateShellSafePath,
} from "./compose-helpers.js";
import { NEEDS_TO_CONNECT_TO_PREDEFINED_NETWORK, decodeBase64Text, serviceTemplateForType, serviceTemplates, resolveServiceTemplateKey } from "./catalogue.js";
import { DEFAULT_MAGIC_VALUE_SOURCE, generateEnvValue } from "./magic-values.js";
import type { ServiceApplicationRow, ServiceEnvironmentVariableRow, ServiceFileVolumeRow, ServicePart, ServicePersistentVolumeRow, ServiceRow, ServiceStore } from "./store.js";

/** Coolify's base_configuration_dir(): where a server keeps the files of its resources. */
export const BASE_CONFIGURATION_DIR = "/data/coolify";

/** The parser version a new service gets (Service::$parserVersion). */
export const SERVICE_PARSER_VERSION = "5";

const NEEDS_TO_DISABLE_GZIP: Readonly<Record<string, readonly string[]>> = { beszel: ["beszel"] };
const NEEDS_TO_DISABLE_STRIPPREFIX: Readonly<Record<string, readonly string[]>> = {
  appwrite: ["appwrite", "appwrite-console", "appwrite-realtime"],
  rybbit: ["rybbit_backend"],
};

/** The server a service runs on, as the parser reads it. */
export interface ServiceParserServer {
  ip: string;
  /** server_settings.wildcard_domain */
  wildcardDomain: string | null;
  /** Server::proxyType(): "TRAEFIK", "CADDY", "NONE" or null. */
  proxyType: string | null;
  /** server_settings.generate_exact_labels: only the labels of the server's proxy. */
  generateExactLabels: boolean;
  /** Server::traefikCertificateResolver() without a resource: the server's resolver. */
  traefikCertificateResolver: string | null;
  isTrafficAnalyticsEnabled: boolean;
  /** Server::caddySupportsLogAppend() */
  caddySupportsLogAppend: boolean;
  /**
   * The `logging:` section of generate_log_drain_configuration() when the server drains logs, else null.
   * Built by the caller; it is given to every application of the service that has log draining on.
   */
  logDrainConfiguration: PhpArray | null;
}

export interface ServiceParserContext {
  server: ServiceParserServer;
  /** The Docker network of the service's destination (for Caddy's labels). */
  destinationNetwork: string;
  projectName: string;
  environmentName: string;
  /** The value of a magic variable's command: generateEnvValue(). `signingKey` is SERVICE_PASSWORD_JWT. */
  magicValue?: (command: string, key: string, signingKey: string | null) => string | null;
  /** new_public_id() for a new application or database. */
  newUuid?: () => string;
  /** resolveSharedEnvironmentVariables(): `{{team.KEY}}` … in a value replaced by the shared variables found. */
  resolveSharedVariables?: (value: string) => string;
  /** The `port` of the service's template (Service::getRequiredPort); the catalogue's by default. */
  templatePort?: (serviceType: string) => number | null;
  labels?: LabelDependencies;
}

/** Warnings the parser leaves for the user (Service::composeVolumeWarnings()). */
export interface ServiceParseResult {
  /** The parsed file as a PHP array: services, volumes, networks, configs, secrets. Empty when nothing was parsed. */
  compose: PhpArray;
  warnings: string[];
}

function defaultTemplatePort(serviceType: string): number | null {
  const templates = serviceTemplates();
  const name = resolveServiceTemplateKey(serviceType, templates);
  const port = Object.hasOwn(templates, name) ? templates[name]?.port : undefined;
  return port !== undefined && port !== "" && port !== "0" ? Math.trunc(Number(port)) || 0 : null;
}

/** dataGet + str(): the string a Compose value is read as (`data_get_str`). */
function dataGetString(target: PhpValue, key: string, fallback: string | null = null): string {
  return phpString(dataGet(target, key, fallback) ?? fallback);
}

/** EnvironmentVariable's value mutator: a single-line value loses the line breaks at its edges. */
function withoutEdgeLineBreaks(value: string): string {
  const trimmed = value.replace(/^[\r\n]+|[\r\n]+$/g, "");
  return trimmed.includes("\n") ? value : trimmed;
}

/** EnvironmentVariable::isSharedReference(). */
function isSharedReference(value: string | null): boolean {
  if (blank(value)) return false;
  return /^\{\{\s*(?:team|project|environment|server)\.[\s\S]*\}\}$/.test((value ?? "").replace(/^[ \t\n\r\0\v]+|[ \t\n\r\0\v]+$/g, ""));
}

interface EnvironmentValues {
  value?: string | null;
  is_required?: boolean;
  comment?: string | null;
}

/** The parser's working state: the store, the context with its defaults filled in, and what PHP keeps on the model. */
class Parser {
  readonly warnings: string[] = [];
  /** `$resource->environment_variables`: the relation, loaded on first use and then kept (stale) until the end. */
  private loadedEnvironmentKeys: string[] | null = null;
  private readonly composeCache = new Map<string, PhpValue>();

  constructor(
    readonly store: ServiceStore,
    readonly context: ServiceParserContext,
  ) {}

  get service(): ServiceRow {
    return this.store.service;
  }

  get parserVersion(): number {
    return Math.trunc(Number(this.service.compose_parsing_version)) || 0;
  }

  addWarning(warning: string): void {
    if (!this.warnings.includes(warning)) this.warnings.push(warning);
  }

  // ---- environment variables ----

  findEnvironmentVariable(key: string): ServiceEnvironmentVariableRow | undefined {
    return this.store.environmentVariables().find((row) => row.key === key);
  }

  private setValue(row: Pick<ServiceEnvironmentVariableRow, "value" | "is_shared" | "preserve_compose_null">, value: string | null): void {
    if (value !== null && value.includes("\0")) throw new ComposeError("An environment variable value cannot contain a NUL byte.");
    const next = value === null ? null : withoutEdgeLineBreaks(value);
    if (row.preserve_compose_null && next !== row.value && next !== null) row.preserve_compose_null = false;
    row.value = next;
    row.is_shared = isSharedReference(next);
  }

  private createEnvironmentVariable(key: string, values: EnvironmentValues): ServiceEnvironmentVariableRow {
    const row: Omit<ServiceEnvironmentVariableRow, "id"> = {
      key: validatedEnvironmentVariableKey(key),
      value: null,
      is_preview: false,
      is_required: values.is_required ?? false,
      is_shared: false,
      is_literal: false,
      is_multiline: false,
      comment: values.comment ?? null,
      version: ENVIRONMENT_VARIABLE_VERSION,
      preserve_compose_null: false,
    };
    this.setValue(row, values.value ?? null);
    return this.store.createEnvironmentVariable(row);
  }

  /** `environment_variables()->firstOrCreate(['key' => …], $values)`. */
  firstOrCreate(key: string, values: EnvironmentValues = {}): ServiceEnvironmentVariableRow {
    return this.findEnvironmentVariable(key) ?? this.createEnvironmentVariable(key, values);
  }

  /** `environment_variables()->updateOrCreate(['key' => …], $values)`. */
  updateOrCreate(key: string, values: EnvironmentValues): ServiceEnvironmentVariableRow {
    const found = this.findEnvironmentVariable(key);
    if (!found) return this.createEnvironmentVariable(key, values);
    if (values.value !== undefined) this.setValue(found, values.value);
    found.is_preview = false;
    if (values.comment !== undefined) found.comment = values.comment;
    return found;
  }

  updateValue(row: ServiceEnvironmentVariableRow, value: string | null): void {
    this.setValue(row, value);
  }

  /** The keys of `$resource->environment_variables`, as they were when first asked for in this parse. */
  loadedKeys(): string[] {
    this.loadedEnvironmentKeys ??= this.store.environmentVariables().map((row) => row.key);
    return this.loadedEnvironmentKeys;
  }

  // ---- parts ----

  /** resolveServicePart(): the application or database of a Compose service, created on first sight. */
  resolvePart(serviceName: string, isDatabase: boolean): ServicePart {
    const application = (): ServicePart | undefined => {
      const row = this.store.applications().find((candidate) => candidate.name === serviceName);
      return row ? { kind: "application", row } : undefined;
    };
    const database = (): ServicePart | undefined => {
      const row = this.store.databases().find((candidate) => candidate.name === serviceName);
      return row ? { kind: "database", row } : undefined;
    };
    const migratedApplication = this.store.applications().find((candidate) => candidate.name === serviceName && candidate.is_migrated);
    if (migratedApplication) return { kind: "application", row: migratedApplication };
    const migratedDatabase = this.store.databases().find((candidate) => candidate.name === serviceName && candidate.is_migrated);
    if (migratedDatabase) return { kind: "database", row: migratedDatabase };
    const newUuid = this.context.newUuid ?? (() => newPublicId());
    if (isDatabase) return database() ?? application() ?? { kind: "database", row: this.store.createDatabase(serviceName, newUuid()) };
    return application() ?? database() ?? { kind: "application", row: this.store.createApplication(serviceName, newUuid()) };
  }

  /** ServiceApplication's saving hook for a changed fqdn. */
  setFqdn(application: ServiceApplicationRow, fqdn: string | null): void {
    setServiceApplicationFqdn(application, fqdn);
  }

  /** findServiceApplicationForEnvName(): the application a SERVICE_URL_<NAME> variable means. */
  findApplicationForEnvName(envServiceName: string): ServiceApplicationRow | null {
    const names = this.store.applications().map((row) => row.name);
    const resolved = findComposeServiceName(envServiceName, names) ?? findComposeServiceName(envServiceName.replaceAll("_", "-"), names);
    if (resolved === null) return null;
    return this.store.applications().find((row) => row.name === resolved) ?? null;
  }

  // ---- ports ----

  private parsedCompose(raw: string): PhpValue {
    if (!this.composeCache.has(raw)) this.composeCache.set(raw, parseDockerComposeYaml(raw));
    return this.composeCache.get(raw) ?? null;
  }

  /** Service::getRequiredPort(): the `# port:` of the template. */
  serviceRequiredPort(): number | null {
    if (blank(this.service.service_type)) return null;
    return (this.context.templatePort ?? defaultTemplatePort)(this.service.service_type ?? "");
  }

  /** ServiceApplication::getRequiredPort(): the port its own SERVICE_URL_X_<port> declares, else its first port. */
  applicationRequiredPort(application: ServiceApplicationRow): number | null {
    try {
      const raw = this.service.docker_compose_raw;
      if (!phpTruthy(raw)) return this.serviceRequiredPort();
      const serviceConfig = dataGet(this.parsedCompose(raw ?? ""), ["services", application.name]);
      if (!phpTruthy(serviceConfig)) return this.serviceRequiredPort();
      const environment = dataGet(serviceConfig, "environment", new PhpArray());
      let declaresHttpUrl = false;
      for (const [key, value] of environment instanceof PhpArray ? environment : new PhpArray()) {
        let name: string | null = null;
        if (typeof key === "number" && typeof value === "string") name = before(value, "=").replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, "");
        else if (typeof key === "string") name = key;
        if (name === null || !(name.startsWith("SERVICE_FQDN_") || name.startsWith("SERVICE_URL_"))) continue;
        declaresHttpUrl = true;
        const parsed = parseServiceEnvironmentVariable(name);
        if (parsed.has_port && phpTruthy(parsed.port)) return Math.trunc(Number(parsed.port));
      }
      const composePort = firstDockerComposeServicePort(serviceConfig);
      if (composePort !== null) return composePort;
      if (declaresHttpUrl) {
        if (blank(this.service.service_type)) {
          const saved = this.savedLegacyRoutingPort(application, serviceConfig);
          if (saved !== null) return saved;
        }
        return this.serviceRequiredPort();
      }
      return null;
    } catch {
      return null;
    }
  }

  /** ServiceApplication::getSavedLegacyRoutingPort(): the one port the deployed file's proxy labels route to. */
  private savedLegacyRoutingPort(application: ServiceApplicationRow, serviceConfig: PhpValue): number | null {
    const saved = dataGet(parseDockerComposeYaml(this.service.docker_compose ?? ""), ["services", application.name]);
    const image = dataGet(serviceConfig, "image");
    if (typeof image !== "string" || image === "" || dataGet(saved, "image") !== image) return null;
    const labels = dataGet(saved, "labels", new PhpArray());
    if (!(labels instanceof PhpArray)) return null;
    const ports: number[] = [];
    for (const [labelKey, labelValue] of labels) {
      let key: PhpKey = labelKey;
      let value: PhpValue = labelValue;
      if (typeof key === "number") {
        if (typeof value !== "string") return null;
        const index = value.indexOf("=");
        key = index === -1 ? value : value.slice(0, index);
        value = index === -1 ? null : value.slice(index + 1);
      }
      let port: PhpValue;
      if (/^traefik\.http\.services\.[^.]+\.loadbalancer\.server\.port$/.test(String(key))) {
        port = value;
      } else if (/^caddy(?:_\d+)?\..*reverse_proxy$/.test(String(key))) {
        const upstream = typeof value === "string" ? /^\{\{upstreams ([0-9]+)\}\}$/.exec(value) : null;
        if (!upstream) return null;
        port = upstream[1] ?? "";
      } else {
        continue;
      }
      if ((typeof port !== "string" && typeof port !== "number") || !/^[0-9]+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) return null;
      if (!ports.includes(Number(port))) ports.push(Number(port));
    }
    return ports.length === 1 ? (ports[0] ?? null) : null;
  }

  // ---- volumes ----

  fileVolume(part: ServicePart, mountPath: string): ServiceFileVolumeRow | undefined {
    return this.store.fileVolumes().find((row) => row.resource_type === part.kind && row.resource_id === part.row.id && row.mount_path === mountPath);
  }

  /** composeVolumeSourceVariables(): the service's variables with a plain value, for `${VAR}` in a host path. */
  volumeSourceVariables(): Map<string, string> {
    const variables = new Map<string, string>();
    for (const row of this.store.environmentVariables()) {
      const value = this.realValue(row);
      if (value === "" || value.includes("$") || /\{\{\s*secret\./.test(value)) variables.delete(row.key);
      else variables.set(row.key, value);
    }
    return variables;
  }

  /** EnvironmentVariable::real_value for a service: the value with its shared variable references resolved. */
  realValue(row: ServiceEnvironmentVariableRow): string {
    if (row.value === null || row.value === "") return row.value ?? "";
    const value = withoutEdgeLineBreaks(row.value);
    return this.context.resolveSharedVariables ? this.context.resolveSharedVariables(value) : value;
  }

  /** resolveComposeLongBindSource(): `${VAR:-default}` as the whole source of a long bind takes the variable's value. */
  resolveLongBindSource(source: string): string {
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*):-[^}]*\}$/.exec(source);
    if (!match) return resolveComposeVolumeSourceVariables(source);
    const row = this.findEnvironmentVariable(match[1] ?? "");
    const value = row ? this.realValue(row) : "";
    if (blank(value)) return resolveComposeVolumeSourceVariables(source);
    if (value.includes("$") || /\{\{\s*secret\./.test(value)) return source;
    try {
      validateShellSafePath(value, "volume source");
    } catch (error) {
      throw new ComposeError(`Invalid Docker volume definition (array syntax): the value of ${match[1] ?? ""} is not a safe path. ${(error as Error).message}`);
    }
    return value;
  }
}

/** `convertToArray`: a deep copy, so that what is dumped shares nothing with the parsed file. */
function toArray(value: PhpValue): PhpValue {
  return deepClone(value);
}

/** `data_forget($volume, 'content')` and its siblings. */
function forgetVolumeFields(volume: PhpValue): PhpValue {
  if (!(volume instanceof PhpArray)) return volume;
  const copy = volume.clone();
  for (const field of ["content", "is_directory", "isDirectory"]) copy.delete(field);
  return copy;
}

/** Service::parse(): the service's Compose file read into rows and into the file that is deployed. */
export function parseService(store: ServiceStore, context: ServiceParserContext): ServiceParseResult {
  const parser = new Parser(store, context);
  const resource = store.service;
  const empty = (): ServiceParseResult => ({ compose: new PhpArray(), warnings: parser.warnings });
  if (parser.parserVersion < 3) throw new ComposeError("Services of parser version 2 and earlier are not supported.");

  const uuid = resource.uuid;
  const compose = resource.docker_compose_raw;
  const originalCompose = compose;
  if (!phpTruthy(compose) || compose === null) return empty();
  const envComments = extractYamlEnvironmentComments(compose);
  const server = context.server;

  let yaml: PhpValue;
  try {
    yaml = parseDockerComposeYaml(compose);
  } catch {
    return empty();
  }
  const servicesValue = dataGet(yaml, "services", new PhpArray());
  if (!(servicesValue instanceof PhpArray)) return empty();
  const services = servicesValue;

  // Variables left by older parser bugs: a name cannot start with "$" or end with "}".
  for (const row of [...store.environmentVariables()]) {
    if (row.key.startsWith("$") || row.key.endsWith("}")) store.deleteEnvironmentVariable(row);
  }
  const existingEnvironmentVariableKeys = store.environmentVariables().map((row) => row.key);

  let topLevelVolumes = collect(dataGet(yaml, "volumes", new PhpArray()));
  const topLevelNetworks = collect(dataGet(yaml, "networks", new PhpArray()));
  const topLevelConfigs = collect(dataGet(yaml, "configs", new PhpArray()));
  const topLevelSecrets = collect(dataGet(yaml, "secrets", new PhpArray()));

  // ensureComposeNetworkNameVariables(): a network named by one variable gets that variable.
  for (const network of topLevelNetworks.values()) {
    const name = dataGet(network, "name");
    const variable = typeof name === "string" ? composeNetworkNameVariable(name) : null;
    if (variable === null || isCoolifyProvidedComposeVariable(variable.variable)) continue;
    if (variable.default !== null && !isValidDockerNetwork(variable.default)) continue;
    parser.firstOrCreate(variable.variable, { value: variable.default ?? "" });
  }
  if (topLevelVolumes.size > 0) {
    const declared = new PhpArray();
    for (const [volumeName, volume] of topLevelVolumes) if (volume !== null) declared.set(volumeName, volume);
    topLevelVolumes = declared;
  }
  const baseNetwork = uuid;
  const legacyNullKeys = store.environmentVariables().filter((row) => row.preserve_compose_null && row.value === null).map((row) => row.key);
  const parsedServices = new PhpArray();
  const serviceNameEnvironments = generateDockerComposeServiceName(services);
  let allMagicEnvironments = new PhpArray();

  const environmentOf = (service: PhpValue): PhpArray =>
    convertToKeyValueCollection(merge(collect(dataGet(service, "environment", new PhpArray())), collect(dataGet(service, "build.args", new PhpArray()))));
  const partOf = (serviceName: string, service: PhpValue): ServicePart => {
    const image = dataGet(service, "image");
    return parser.resolvePart(serviceName, isDatabaseImage(image === null ? null : phpString(image), service));
  };

  // Presave the parts.
  const usedParts: ServicePart[] = [];
  for (const [nameKey, service] of services) {
    const serviceName = String(nameKey);
    try {
      validateShellSafePath(serviceName, "service name");
    } catch (error) {
      throw new ComposeError(`Invalid Docker Compose service name: ${(error as Error).message} Service names must not contain shell metacharacters.`);
    }
    validateComposeServiceName(serviceName);
    validateComposeServiceScale(serviceName, service);
    const part = partOf(serviceName, service);
    part.row.image = dataGetString(service, "image");
    usedParts.push(part);
  }
  // markServicePartsRemovedFromCompose()
  if (usedParts.length > 0) {
    for (const row of store.applications()) row.is_removed_from_compose = !usedParts.some((part) => part.kind === "application" && part.row.id === row.id);
    for (const row of store.databases()) row.is_removed_from_compose = !usedParts.some((part) => part.kind === "database" && part.row.id === row.id);
  }

  // The magic variables of each service.
  for (const [nameKey, service] of services) {
    const serviceName = String(nameKey);
    const magicEnvironments = new PhpArray();
    const savedService = partOf(serviceName, service);
    savedService.row.image = dataGetString(service, "image");
    // Pocketbase does not need gzip for SSE.
    if ((savedService.row.image ?? "").includes("pocketbase") && savedService.row.is_gzip_enabled) savedService.row.is_gzip_enabled = false;

    for (const [envKey, envValue] of environmentOf(service)) {
      const key = String(envKey);
      const value = phpString(envValue);
      for (const match of value.matchAll(/\$(\{?([a-zA-Z_\u0080-\uffff][a-zA-Z0-9_\u0080-\uffff]*)\}?)/g)) {
        const name = match[2] ?? "";
        if (name.startsWith("SERVICE_") && !magicEnvironments.has(name)) magicEnvironments.set(name, "");
      }
      if (!(key.startsWith("SERVICE_FQDN_") || key.startsWith("SERVICE_URL_"))) continue;
      // SERVICE_FQDN_APP, SERVICE_FQDN_APP_3000, SERVICE_URL_APP or SERVICE_URL_APP_3000, declared by the service:
      // both the URL and the FQDN variable are created, whichever the file names.
      const parsed = parseServiceEnvironmentVariable(key);
      const prefix = key.startsWith("SERVICE_URL_") ? "SERVICE_URL_" : "SERVICE_FQDN_";
      const declaredName = parsed.has_port ? beforeLast(after(key, prefix), "_") : after(key, prefix);
      const port = parsed.port;
      const fqdnFor = parsed.service_name;
      if (isCopiedServiceUrlDeclaration(parser, services, savedService, key)) continue;

      let fqdn: string;
      let url: string;
      if (savedService.kind === "application" && !blank(savedService.row.fqdn)) {
        // The domains may be a comma-separated list; the first one counts.
        fqdn = getFqdnWithoutPort(firstDomainFromList(savedService.row.fqdn));
        url = fqdn;
      } else {
        fqdn = generateServiceFqdn(server, `${fqdnFor}-${uuid}`, parser.parserVersion);
        url = generateServiceUrl(server, `${fqdnFor}-${uuid}`);
      }
      // SERVICE_FQDN_* holds the host without the scheme.
      let fqdnValueForEnv = after(fqdn, "://");
      if (value.startsWith("/") && value !== "/") {
        // A path is added once: later parses find it there already.
        if (!fqdn.endsWith(value)) fqdn = `${fqdn}${value}`;
        if (!url.endsWith(value)) url = `${url}${value}`;
        if (!fqdnValueForEnv.endsWith(value)) fqdnValueForEnv = `${fqdnValueForEnv}${value}`;
      }
      const fqdnValueForEnvWithPort = phpTruthy(fqdn) && phpTruthy(port) ? `${fqdnValueForEnv}:${port ?? ""}` : fqdnValueForEnv;
      const urlWithPort = phpTruthy(url) && phpTruthy(port) ? `${url}:${port ?? ""}` : url;
      if (savedService.kind === "application" && savedService.row.fqdn === null) parser.setFqdn(savedService.row, url);

      const fqdnKey = `SERVICE_FQDN_${declaredName}`;
      parser.updateOrCreate(fqdnKey, { value: fqdnValueForEnv, comment: envComments.get(fqdnKey) ?? null });
      const urlKey = `SERVICE_URL_${declaredName}`;
      parser.updateOrCreate(urlKey, { value: url, comment: envComments.get(urlKey) ?? null });
      if (parsed.has_port && phpTruthy(port)) {
        const fqdnPortKey = `SERVICE_FQDN_${declaredName}_${port ?? ""}`;
        parser.updateOrCreate(fqdnPortKey, { value: fqdnValueForEnvWithPort, comment: envComments.get(fqdnPortKey) ?? null });
        const urlPortKey = `SERVICE_URL_${declaredName}_${port ?? ""}`;
        parser.updateOrCreate(urlPortKey, { value: urlWithPort, comment: envComments.get(urlPortKey) ?? null });
      }
    }

    allMagicEnvironments = merge(allMagicEnvironments, magicEnvironments);
    for (const magicKey of magicEnvironments.keys()) {
      const key = String(magicKey);
      const command = parseCommandFromMagicEnvVariable(key);
      if (command === "FQDN" || command === "URL") {
        // A magic variable that is only referenced ("$SERVICE_URL_APP" in a value).
        const prefix = command === "FQDN" ? "SERVICE_FQDN_" : "SERVICE_URL_";
        const domainFor = after(key, prefix).toLowerCase();
        const random = `${domainFor.replaceAll("_", "-")}-${uuid}`;
        const fqdn = generateServiceFqdn(server, random, parser.parserVersion);
        const url = generateServiceUrl(server, random);
        const envExists = parser.findEnvironmentVariable(key) !== undefined;
        // SERVICE_FQDN_UMAMI_3000 next to SERVICE_FQDN_UMAMI: the port is set by the declaration.
        const portSuffixed = new RegExp(`^${key.replace(/[.\\+*?[^\]$(){}=!<>|:\-#/]/g, "\\$&")}_[0-9]+$`);
        const portSuffixedExists = store.environmentVariables().some((row) => portSuffixed.test(row.key));
        const serviceExists = parser.findApplicationForEnvName(domainFor);
        const existingFqdn = serviceExists?.fqdn ?? "";
        const fqdnHasPort = serviceExists !== null && existingFqdn.includes(":") && /^\d+$/.test(afterLast(existingFqdn, ":"));
        // Only the service being read gets a domain from its own variable.
        const isCurrentService = serviceExists !== null && savedService.kind === "application" && serviceExists.id === savedService.row.id;
        if (!envExists && !portSuffixedExists && !fqdnHasPort && isCurrentService && serviceExists) parser.setFqdn(serviceExists, url);
        // firstOrCreate: a value set by a declaration or by the user stays.
        const pairedKey = (command === "FQDN" ? "SERVICE_URL_" : "SERVICE_FQDN_") + domainFor.toUpperCase();
        parser.firstOrCreate(key, { value: command === "FQDN" ? fqdn : url, comment: envComments.get(key) ?? null });
        parser.firstOrCreate(pairedKey, { value: command === "FQDN" ? url : fqdn, comment: envComments.get(pairedKey) ?? null });
      } else {
        const signingKey = parser.findEnvironmentVariable("SERVICE_PASSWORD_JWT")?.value ?? null;
        const exists = parser.findEnvironmentVariable(key) !== undefined;
        // PHP generates the value before it looks for the variable; nothing but randomness is spent on it.
        const generated = (context.magicValue ?? ((magicCommand, _key, jwtKey) => generateEnvValue(magicCommand, DEFAULT_MAGIC_VALUE_SOURCE, jwtKey)))(command, key, signingKey);
        if (!exists) parser.firstOrCreate(key, { value: generated, comment: envComments.get(key) ?? null });
      }
    }
  }

  const logDrainApplications = new Set(store.applications().filter((row) => row.is_log_drain_enabled).map((row) => row.name));

  // The rest of each service.
  for (const [nameKey, originalService] of services) {
    const serviceName = String(nameKey);
    let service: PhpValue = originalService;
    const image = dataGetString(service, "image");
    const restart = dataGetString(service, "restart", RESTART_MODE);
    let logging = dataGet(service, "logging");
    if (server.logDrainConfiguration !== null && logDrainApplications.has(serviceName)) logging = server.logDrainConfiguration;
    const volumes = collect(dataGet(service, "volumes", new PhpArray()));
    const networks = collect(dataGet(service, "networks", new PhpArray()));
    const useNetworkMode = dataGet(service, "network_mode") !== null;
    const dependsOn = collect(dataGet(service, "depends_on", new PhpArray()));
    let labels = collect(dataGet(service, "labels", new PhpArray()));
    if (isAssociativeArray(labels)) labels = PhpArray.list(labels.entries().map(([key, value]) => `${String(key)}=${phpString(value)}`));
    const ports = collect(dataGet(service, "ports", new PhpArray()));
    let environment = environmentOf(service);
    const coolifyEnvironments = new PhpArray();

    const savedService = partOf(serviceName, service);
    // A part that the user converted keeps its kind, whatever the image says.
    const isDatabase = savedService.row.is_migrated ? savedService.kind === "database" : isDatabaseImage(dataGet(service, "image") === null ? null : image, service);
    const containerName = `${serviceName}-${resource.uuid}`;
    savedService.row.image = image;

    const volumesParsed = new PhpArray();
    let volumeSourceVariables: Map<string, string> | null = null;
    for (const [index, originalVolume] of volumes) {
      let volume: PhpValue = originalVolume;
      let type = "";
      let source: string | null = null;
      let target: string | null = null;
      let mode: string | null = null;
      let content: PhpValue = null;
      let isDirectory: PhpValue = false;
      let foundConfig: ServiceFileVolumeRow | undefined;
      if (typeof volume === "string") {
        if (volume.includes("${")) volumeSourceVariables ??= parser.volumeSourceVariables();
        const parsed = parseDockerVolumeString(volume, volume.includes("${") ? volumeSourceVariables : null);
        source = parsed.source;
        target = parsed.target;
        mode = parsed.mode;
        foundConfig = parser.fileVolume(savedService, target ?? "");
        if (sourceIsLocal(source ?? "")) {
          type = "bind";
          if (foundConfig) {
            content = foundConfig.content;
            isDirectory = foundConfig.is_directory;
          } else {
            // Whether a bind is a directory cannot be seen from here; it is taken as one.
            isDirectory = true;
          }
        } else {
          type = "volume";
        }
      } else if (volume instanceof PhpArray) {
        type = dataGetString(volume, "type");
        source = dataGetString(volume, "source");
        target = dataGetString(volume, "target");
        content = dataGet(volume, "content");
        isDirectory = dataGet(volume, "is_directory") ?? dataGet(volume, "isDirectory");
        if (phpTruthy(source)) {
          validateComposeArrayVolumeSource(source);
          // A named volume keeps its source as written, so its name does not change.
          if (type === "bind") source = parser.resolveLongBindSource(source);
        }
        validateComposeContentVolumeSource(volume);
        if (phpTruthy(target)) {
          try {
            validateShellSafePath(target, "volume target");
          } catch (error) {
            throw new ComposeError(`Invalid Docker volume definition (array syntax): ${(error as Error).message} Please use safe path names without shell metacharacters.`);
          }
        }
        foundConfig = parser.fileVolume(savedService, target);
        if (foundConfig) {
          content = foundConfig.content;
          isDirectory = foundConfig.is_directory;
        } else {
          // Without is_directory a bind without content is a directory; an explicit `is_directory: false` stays a file.
          isDirectory = isDirectory === null ? content === null : phpTruthy(isDirectory);
        }
      } else {
        // PHP calls ->value() on null here.
        throw new ComposeError(`Invalid Docker volume definition of service ${serviceName}.`);
      }

      if (type === "bind") {
        const sourceText = source ?? "";
        if (["/var/run/docker.sock", "/tmp", "/tmp/"].includes(sourceText)) {
          volume = typeof volume === "string" ? `${sourceText}:${target ?? ""}${phpTruthy(mode) ? `:${mode ?? ""}` : ""}` : composeLongBindVolume(volume, sourceText);
        } else {
          const mainDirectory = `${BASE_CONFIGURATION_DIR}/${parser.parserVersion >= 4 ? "services" : "applications"}/${uuid}`;
          let fsPath = resolveComposeBindSource(sourceText, mainDirectory, foundConfig?.fs_path ?? null);
          let variableSource: string | null = null;
          // keepSavedComposeBindSource(): a storage saved with the default of `${VAR:-default}` keeps that path.
          if (typeof volume === "string" && foundConfig && volume.includes("${")) {
            let defaultSource: string | null = null;
            try {
              defaultSource = parseDockerVolumeString(volume).source;
            } catch {
              defaultSource = null;
            }
            if (defaultSource !== null && sourceIsLocal(defaultSource)) {
              const defaultPath = resolveComposeBindSource(defaultSource, mainDirectory, foundConfig.fs_path);
              if (defaultPath !== fsPath && foundConfig.fs_path === defaultPath) {
                parser.addWarning(`The storage ${foundConfig.mount_path ?? ""} keeps its saved host path ${defaultPath}. Its variable gives ${fsPath}. To use that path, open the storage and click Use the variable path.`);
                variableSource = fsPath;
                fsPath = defaultPath;
              }
            }
          }
          // With `bind.create_host_path: false` the host path must exist already: Coolify does not create or manage it.
          if (!composeBindKeepsMissingHostPath(volume)) {
            const values = { fs_path: fsPath, variable_fs_path: variableSource, mount_path: target, content: content === null ? null : phpString(content), is_directory: phpTruthy(isDirectory) };
            const existing = parser.fileVolume(savedService, target ?? "");
            if (existing) Object.assign(existing, values);
            else store.createFileVolume({ ...values, resource_type: savedService.kind, resource_id: savedService.row.id, is_host_file: false });
          } else {
            // forgetComposeBindStorage()
            for (const row of [...store.fileVolumes()]) {
              if (row.resource_type === savedService.kind && row.resource_id === savedService.row.id && row.mount_path === target && !row.is_host_file && !row.has_scheduled_backups) store.deleteFileVolume(row);
            }
          }
          volume = typeof volume === "string" ? `${fsPath}:${target ?? ""}${phpTruthy(mode) ? `:${mode ?? ""}` : ""}` : composeLongBindVolume(volume, fsPath);
        }
      } else if (type === "volume") {
        const sourceText = source ?? "";
        const slugWithoutUuid = slug(sourceText);
        const name = `${uuid}_${slugWithoutUuid}`;
        // useComposeExternalVolumeAsWritten(): an external volume gets no row, so Coolify never removes it.
        const externalDeclaration = composeExternalVolumeDeclaration(topLevelVolumes, sourceText);
        if (externalDeclaration !== null) {
          const hasLegacyStorage = name !== sourceText && store.persistentVolumes().some((row) => row.resource_type === savedService.kind && row.resource_id === savedService.row.id && row.name === name);
          if (!hasLegacyStorage) {
            volumesParsed.set(index, volume);
            continue;
          }
          parser.addWarning(composeLegacyExternalVolumeWarning(sourceText, externalDeclaration, name));
        }
        const declaration = topLevelVolumes.get(sourceText) ?? null;
        const driverType = dataGet(declaration, "driver_opts.type");
        if (driverType === "cifs" || driverType === "nfs") {
          // Network volumes are used as written.
          volumesParsed.set(index, volume);
          continue;
        }
        if (typeof volume === "string") {
          const parsed = parseDockerVolumeString(volume);
          target = parsed.target;
          volume = `${name}:${target ?? ""}${phpTruthy(parsed.mode) ? `:${parsed.mode ?? ""}` : ""}`;
        } else {
          volume = volume.clone().set("source", name);
        }
        let persistentVolume: ServicePersistentVolumeRow | undefined = store.persistentVolumes().find((row) => row.resource_type === savedService.kind && row.resource_id === savedService.row.id && row.name === name);
        if (persistentVolume) persistentVolume.mount_path = target;
        else persistentVolume = store.createPersistentVolume({ name, mount_path: target, resource_type: savedService.kind, resource_id: savedService.row.id, ignores_compose_driver_options: false });
        // composeRenamedVolumeDeclarationFor()
        topLevelVolumes.set(name, persistentVolume.ignores_compose_driver_options ? PhpArray.from([["name", name]]) : composeRenamedVolumeDeclaration(declaration, name));
      }
      volumesParsed.set(index, volume);
    }

    if (!useNetworkMode) {
      for (const [networkName, network] of topLevelNetworks) {
        if (networkName === "default") continue;
        // ignore aliases
        if (phpTruthy(network instanceof PhpArray ? (network.get("aliases") ?? null) : null)) continue;
        const exists = networks.entries().some(([key, value]) => looseEquals(value, networkName) || looseEquals(key, networkName));
        if (!exists) networks.set(networkName, null);
      }
      // PHP compares each value with the collection of base networks, which never matches: the service
      // network is declared for every service that has no network_mode.
      topLevelNetworks.set(baseNetwork, PhpArray.from([["name", baseNetwork], ["external", true]] as [string, PhpValue][]));
    }

    // The published ports, for the part's row.
    const collectedPorts: string[] = [];
    for (const port of ports.values()) {
      if (port instanceof PhpArray) collectedPorts.push(`${phpString(dataGet(port, "target"))}:${phpString(dataGet(port, "published"))}/${phpString(dataGet(port, "protocol"))}`);
      else if (typeof port === "string" || typeof port === "number" || typeof port === "bigint" || port instanceof PhpFloat) collectedPorts.push(phpString(port));
    }
    savedService.row.ports = collectedPorts.join(",");

    const networksTemp = new PhpArray();
    if (!useNetworkMode) {
      for (const [key, network] of networks) {
        if (typeof network === "string") networksTemp.set(network, null);
        else if (network instanceof PhpArray) networksTemp.set(key, network);
      }
      networksTemp.set(baseNetwork, null);
    }

    const passthroughKeys = extractDockerComposePassthroughKeys(dataGet(service, "environment", new PhpArray()));
    for (const [envKey, envValue] of environment.entries()) {
      if (allMagicEnvironments.has(envKey)) continue;
      const originalKey = String(envKey);
      const value = phpString(envValue);
      if (value.startsWith("SERVICE_")) continue;
      const comment = envComments.get(originalKey) ?? null;
      const parsedValue = replaceVariables(value);
      if (value === "" && passthroughKeys.includes(originalKey) && !isCoolifyProvidedComposeVariable(originalKey)) {
        parser.firstOrCreate(originalKey, { comment });
        continue;
      }
      const referenceContent = extractBalancedBraceContent(value);
      const primaryReference = referenceContent === null ? null : splitOnOperatorOutsideNested(referenceContent.content);
      for (const reference of extractDockerComposeEnvironmentVariableReferences(value)) {
        // PHP evaluates `$primaryReference['operator']` even without a primary reference: null there.
        if (value.startsWith("$") && reference === (primaryReference?.variable ?? null) && (primaryReference?.operator ?? "").includes("?")) continue;
        if (reference.startsWith("SERVICE_") || isCoolifyProvidedComposeVariable(reference)) continue;
        const variable = parser.firstOrCreate(reference);
        const required = dockerComposeEnvironmentVariableIsRequired(resource.docker_compose_raw ?? resource.docker_compose, reference);
        if (variable.is_required !== required) variable.is_required = required;
      }
      if (parsedValue.startsWith("SERVICE_")) {
        parser.updateOrCreate(originalKey, { value, comment });
        continue;
      }
      if (!value.startsWith("$") || composeValueReferencesCoolifyProvidedVariable(value)) continue;
      if (originalKey === parsedValue) {
        // KEY: ${KEY} — the variable exists for the .env file and the UI; the reference stays in the file,
        // so that a later change of the variable is not overridden by a stale value.
        parser.firstOrCreate(originalKey, { comment });
        continue;
      }
      const result = extractBalancedBraceContent(value, 0);
      if (result !== null) {
        const split = splitOnOperatorOutsideNested(result.content);
        if (split === null) {
          // A reference without a default: the user's saved value stays.
          parser.firstOrCreate(result.content, { is_required: false, comment });
          continue;
        }
        // VAR with a default (:-, -) or a required VAR (:?, ?): created once, never overwritten.
        const required = split.operator.includes("?");
        parser.firstOrCreate(split.variable, { value: required ? split.default : null, is_required: required, comment });
        if (!split.default.includes("${")) continue;
        // The variables nested in the default.
        let searchPosition = 0;
        let nested = extractBalancedBraceContent(split.default, searchPosition);
        while (nested !== null) {
          const nestedSplit = splitOnOperatorOutsideNested(nested.content);
          const nestedName = nestedSplit !== null ? nestedSplit.variable : nested.content;
          // SERVICE_URL_* and SERVICE_FQDN_* are the magic variables' business.
          if (!(nestedName.startsWith("SERVICE_URL_") || nestedName.startsWith("SERVICE_FQDN_"))) {
            if (nestedSplit !== null) parser.firstOrCreate(nestedSplit.variable, { value: nestedSplit.default });
            else parser.firstOrCreate(nested.content);
          }
          searchPosition = nested.end + 1;
          if (searchPosition >= split.default.length) break;
          nested = extractBalancedBraceContent(split.default, searchPosition);
        }
        continue;
      }
      // "$VAR" without braces (and malformed input): the behaviour of older parser versions.
      let fallbackKey = originalKey;
      let fallbackValue = value;
      let required = false;
      if (value.includes(":-")) {
        fallbackValue = replaceVariables(value);
        fallbackKey = before(fallbackValue, ":");
        fallbackValue = after(fallbackValue, ":-");
      } else if (value.includes("-")) {
        fallbackValue = replaceVariables(value);
        fallbackKey = before(fallbackValue, "-");
        fallbackValue = after(fallbackValue, "-");
      } else if (value.includes(":?")) {
        fallbackValue = replaceVariables(value);
        fallbackKey = before(fallbackValue, ":");
        fallbackValue = after(fallbackValue, ":?");
        required = true;
      } else if (value.includes("?")) {
        fallbackValue = replaceVariables(value);
        fallbackKey = before(fallbackValue, "?");
        fallbackValue = after(fallbackValue, "?");
        required = true;
      }
      if (value === fallbackValue) {
        // No default: the variable is created empty and the service gets its saved value.
        const parsedKeyValue = replaceVariables(fallbackValue);
        const variable = parser.firstOrCreate(parsedKeyValue, { is_required: required, comment });
        environment.set(parsedKeyValue, variable.value);
        continue;
      }
      parser.firstOrCreate(fallbackKey, { value: fallbackValue, is_required: required, comment });
    }

    const loadedKeys = parser.loadedKeys();
    if (!loadedKeys.includes("COOLIFY_RESOURCE_UUID")) coolifyEnvironments.set("COOLIFY_RESOURCE_UUID", resource.uuid);
    if (!loadedKeys.includes("COOLIFY_CONTAINER_NAME")) coolifyEnvironments.set("COOLIFY_CONTAINER_NAME", containerName);

    const serviceType = savedService.kind === "application" ? (SPECIFIC_SERVICES.find((candidate) => before(savedService.row.image ?? "", ":") === candidate) ?? null) : null;
    let fqdns: string[];
    if (savedService.kind === "application" && phpTruthy(serviceType)) fqdns = serviceSpecificFqdns(parser, savedService.row, serviceType ?? "");
    else fqdns = savedService.kind === "application" && savedService.row.fqdn !== null ? savedService.row.fqdn.split(",").filter((fqdn) => phpTruthy(fqdn)) : [];
    // Flags live on the application; a database has no domains.
    const noindexDomains = savedService.kind === "application" ? noindexDomainsOf(savedService.row.noindex_domains) : [];

    const defaults = defaultLabels({
      uuid: resource.uuid,
      name: containerName,
      projectName: context.projectName,
      resourceName: resource.name,
      type: "service",
      subType: savedService.kind,
      subUuid: savedService.row.uuid,
      subName: savedService.row.human_name ?? savedService.row.name,
      environment: context.environmentName,
    });

    const hasDomains = !isDatabase && fqdns.length > 0;
    if (hasDomains) {
      coolifyEnvironments.set("COOLIFY_FQDN", fqdns.map(getHostWithoutPort).join(","));
      coolifyEnvironments.set("COOLIFY_URL", fqdns.map(getFqdnWithoutPort).join(","));
    }
    // coolifyDefaultEnvironmentVariables(), without the keys the user defines.
    if (resource.include_coolify_default_variables) {
      const userDefinedKeys = new Set<string>([...loadedKeys, ...environment.keys().map(String)]);
      const defaultVariables: [string, string][] = [["COOLIFY_APP_NAME", resource.name], ["COOLIFY_PROJECT_NAME", context.projectName], ["COOLIFY_ENVIRONMENT_NAME", context.environmentName], ["COOLIFY_SERVER_IP", server.ip]];
      for (const [key, value] of defaultVariables) if (!userDefinedKeys.has(key)) coolifyEnvironments.set(key, escapeDollarSign(value));
    }
    if (environment.size > 0) {
      const filtered = new PhpArray();
      for (const [key, original] of environment) {
        if (String(key).startsWith("SERVICE_FQDN_")) continue;
        let value = original;
        if (value === "") {
          // An empty value takes the saved one, when there is one. Null stays null: the variable is unset.
          const saved = parser.findEnvironmentVariable(String(key));
          if (saved && saved.value !== null && saved.value !== "") value = saved.value;
        }
        // {{team.VAR}} and the like: the literal text in `environment:` would win over the resolved value of the .env file.
        if (typeof value === "string" && value.includes("{{")) {
          const trimmed = value.replace(/^[ \t\n\r\0\v]+|[ \t\n\r\0\v]+$/g, "");
          value = context.resolveSharedVariables ? context.resolveSharedVariables(trimmed) : trimmed;
        }
        filtered.set(key, value);
      }
      environment = filtered;
    }

    let serviceLabels = merge(labels, PhpArray.list(defaults));
    if (serviceLabels.size > 0 && resource.is_container_label_escape_enabled) {
      serviceLabels = PhpArray.from(serviceLabels.entries().map(([key, value]) => [key, escapeDollarSign(phpString(value))] as const));
    }
    if (hasDomains && savedService.kind === "application") {
      const application = savedService.row;
      const exact = server.generateExactLabels;
      const redirectDirection = ["www", "non-www", "both"].includes(application.redirect) ? application.redirect : "both";
      const onlyPort = parser.applicationRequiredPort(application);
      if (!useNetworkMode && (!exact || server.proxyType === "TRAEFIK")) serviceLabels = addTraefikDockerNetworkLabel(serviceLabels, baseNetwork);
      const plainLabels = (): PhpValue[] => serviceLabels.values().map((label) => (label instanceof PhpArray ? (Object.fromEntries(label.entries().map(([key, value]) => [String(key), phpString(value)])) as unknown as PhpValue) : label));
      const common = {
        uuid,
        domains: fqdns,
        isForceHttpsEnabled: application.is_force_https_enabled,
        isPermanentRedirectEnabled: application.is_permanent_redirect_enabled,
        isGzipEnabled: application.is_gzip_enabled,
        isStripprefixEnabled: application.is_stripprefix_enabled,
        serviceName,
        onlyPort,
        domainPortOverrides: application.domain_port_overrides ?? {},
        noindexDomains,
        redirectDirection,
      };
      const labelDependencies = context.labels ?? DEFAULT_LABEL_DEPENDENCIES;
      const traefik = (): string[] => {
        const resolver = phpTruthy(application.traefik_certificate_resolver) && !blank(application.traefik_certificate_resolver) ? application.traefik_certificate_resolver : server.traefikCertificateResolver;
        return fqdnLabelsForTraefik({ ...common, serviceLabels: plainLabels(), image, certificateResolver: !blank(resolver) && resolver !== "none" ? resolver : null }, labelDependencies);
      };
      const caddy = (): string[] =>
        fqdnLabelsForCaddy(
          { ...common, network: context.destinationNetwork, serviceLabels: plainLabels(), predefinedPort: onlyPort === null ? null : String(onlyPort), isTrafficAnalyticsEnabled: server.isTrafficAnalyticsEnabled, supportsLogAppend: server.caddySupportsLogAppend },
          labelDependencies,
        );
      if (exact) {
        if (server.proxyType === "TRAEFIK") serviceLabels = merge(serviceLabels, PhpArray.list(traefik()));
        else if (server.proxyType === "CADDY") serviceLabels = merge(serviceLabels, PhpArray.list(caddy()));
      } else {
        serviceLabels = merge(serviceLabels, PhpArray.list(traefik()));
        serviceLabels = merge(serviceLabels, PhpArray.list(caddy()));
      }
    }

    if (dataGet(service, "restart") === "no" || phpTruthy(dataGet(service, "exclude_from_hc"))) savedService.row.exclude_from_status = true;

    // data_forget($service, 'volumes.*.content') …, 'exclude_from_hc'
    if (service instanceof PhpArray) {
      const cleaned = service.clone();
      const serviceVolumes = cleaned.get("volumes");
      if (serviceVolumes instanceof PhpArray) cleaned.set("volumes", PhpArray.from(serviceVolumes.entries().map(([key, volume]) => [key, forgetVolumeFields(volume)] as const)));
      cleaned.delete("exclude_from_hc");
      service = cleaned;
    }

    const payload = collect(service);
    payload.set("container_name", containerName);
    payload.set("restart", restart);
    payload.set("labels", serviceLabels);
    if (!useNetworkMode) payload.set("networks", networksTemp);
    if (ports.size > 0) payload.set("ports", ports);
    if (volumesParsed.size > 0) payload.set("volumes", PhpArray.from(volumesParsed.entries().map(([key, volume]) => [key, forgetVolumeFields(volume)] as const)));
    if (environment.size > 0 || coolifyEnvironments.size > 0) {
      // preserveLegacyDockerComposeNullAssignments(): variables that were saved as "KEY=" before null was kept.
      for (const key of legacyNullKeys) {
        const row = parser.findEnvironmentVariable(key);
        if (!row || !row.preserve_compose_null || row.value !== null || !environment.has(key)) continue;
        const value = environment.get(key) ?? null;
        if (value === null || value === `$${key}`) {
          environment.set(key, "");
          continue;
        }
        if (typeof value !== "string" || !value.startsWith("${")) continue;
        const reference = extractBalancedBraceContent(value);
        if (reference === null || reference.end !== value.length - 1) continue;
        if ((splitOnOperatorOutsideNested(reference.content)?.variable ?? reference.content) === key) environment.set(key, "");
      }
      payload.set("environment", merge(environment, coolifyEnvironments, serviceNameEnvironments));
    }
    if (phpTruthy(logging)) payload.set("logging", logging);
    if (dependsOn.size > 0) payload.set("depends_on", dependsOn);
    // Coolify's .env file, so that the service's variables reach its containers.
    payload.set("env_file", composeEnvFilesWithCoolifyEnv(dataGet(service, "env_file")));
    parsedServices.set(serviceName, payload);
  }

  // services, volumes, networks, configs, secrets — the empty sections left out.
  const topLevel = new PhpArray();
  topLevel.set("services", parsedServices);
  const sections: [string, PhpArray][] = [["volumes", topLevelVolumes], ["networks", topLevelNetworks], ["configs", topLevelConfigs], ["secrets", topLevelSecrets]];
  for (const [name, section] of sections) if (section.size > 0) topLevel.set(name, section);

  resource.docker_compose = dumpYaml(toArray(topLevel), 10, 2);

  // docker_compose_raw loses `content:` (and is_directory) of its volumes, so that the content is applied once.
  try {
    const originalYaml = parseDockerComposeYaml(originalCompose ?? "");
    const cleanedYaml = deepClone(originalYaml);
    const cleanedServices = dataGet(cleanedYaml, "services");
    if (cleanedServices instanceof PhpArray) {
      for (const service of cleanedServices.values()) {
        const serviceVolumes = service instanceof PhpArray ? service.get("volumes") : undefined;
        if (!(serviceVolumes instanceof PhpArray)) continue;
        for (const volume of serviceVolumes.values()) {
          if (!(volume instanceof PhpArray)) continue;
          volume.delete("content");
          volume.delete("isDirectory");
          volume.delete("is_directory");
        }
      }
    }
    if (!phpIdentical(originalYaml, cleanedYaml)) {
      resource.docker_compose_raw = removeComposeVolumeFieldsPreservingComments(originalCompose ?? "", cleanedYaml, ["content", "isDirectory", "is_directory"]);
    }
  } catch {
    // The raw file stays as it is.
  }

  // fillDockerComposeDefaultsForBareReferences(): a variable this parse created empty takes the one default the file gives it elsewhere.
  const raw = resource.docker_compose_raw;
  if (!blank(raw) && raw !== null) {
    for (const row of store.environmentVariables()) {
      if (row.value !== null || existingEnvironmentVariableKeys.includes(row.key)) continue;
      const fallback = dockerComposeBareReferenceDefault(raw, row.key);
      if (fallback !== null && !blank(fallback) && !fallback.includes("$")) parser.updateValue(row, fallback);
    }
  }
  // syncDockerComposeEnvironmentVariableRequiredState()
  const requiredSource = resource.docker_compose_raw ?? resource.docker_compose;
  for (const row of store.environmentVariables()) {
    const required = !(row.preserve_compose_null && row.value === null) && dockerComposeEnvironmentVariableIsRequired(requiredSource, row.key);
    if (row.is_required !== required) row.is_required = required;
  }

  return { compose: topLevel, warnings: parser.warnings };
}

/** HasNoindexDomains::noindexDomains(). */
function noindexDomainsOf(stored: string[] | null): string[] {
  const domains: string[] = [];
  for (const domain of stored ?? []) {
    if (typeof domain !== "string" || blank(domain)) continue;
    const key = domainWithoutPort(normalizeApplicationDomainUrl(domain));
    if (!domains.includes(key)) domains.push(key);
  }
  return domains;
}

/** isCopiedServiceUrlDeclaration(): the service repeats another service's SERVICE_URL_ declaration, value and all. */
function isCopiedServiceUrlDeclaration(parser: Parser, services: PhpArray, current: ServicePart, key: string): boolean {
  const owner = parser.findApplicationForEnvName(parseServiceEnvironmentVariable(key).service_name);
  if (!owner || owner.name === current.row.name) return false;
  const declarationsOf = (serviceName: string): PhpArray =>
    convertToKeyValueCollection(merge(collect(dataGet(services, [serviceName, "environment"], new PhpArray())), collect(dataGet(services, [serviceName, "build", "args"], new PhpArray()))));
  const ownerDeclarations = declarationsOf(owner.name);
  const currentDeclarations = declarationsOf(current.row.name);
  if (!currentDeclarations.has(key)) return false;
  const twinKey = key.startsWith("SERVICE_URL_") ? `SERVICE_FQDN_${key.slice("SERVICE_URL_".length)}` : `SERVICE_URL_${key.slice("SERVICE_FQDN_".length)}`;
  const value = phpString(currentDeclarations.get(key));
  return [key, twinKey].some((ownerKey) => ownerDeclarations.has(ownerKey) && phpString(ownerDeclarations.get(ownerKey)) === value);
}

/** ServiceApplication::getRequiredPort() of one of the store's applications (the service Domains page, DP-102). */
export function serviceApplicationRequiredPort(store: ServiceStore, context: ServiceParserContext, application: ServiceApplicationRow): number | null {
  return new Parser(store, context).applicationRequiredPort(application);
}

/** `$application->fqdn = …; $application->save()`: ServiceApplication's saving hook for a changed fqdn (the ports into domain_port_overrides, the noindex flags). */
export function setServiceApplicationFqdn(application: ServiceApplicationRow, fqdn: string | null): void {
  if (application.fqdn === fqdn) return;
  const normalized = normalizeDomainPortOverrides(fqdn, application.domain_port_overrides);
  application.fqdn = normalized.fqdn;
  application.domain_port_overrides = normalized.overrides;
  const noindex = syncNoindexDomains(application.noindex_domains, application.fqdn);
  if (noindex !== undefined) application.noindex_domains = noindex;
}

/**
 * updateCompose($resource) (bootstrap/helpers/services.php, DP-74): after a part's domains or image changed, the image
 * written back into the Compose file, and the SERVICE_URL_* / SERVICE_FQDN_* pairs the part declares itself (not those
 * copied from another part) deleted and made again from its first domain — the base pair and one per port. Coolify
 * swallows any error (handleError()); so does this.
 */
export function updateServiceCompose(store: ServiceStore, context: ServiceParserContext, part: ServicePart): void {
  const parser = new Parser(store, context);
  const service = store.service;
  try {
    const name = part.row.name;
    let raw = service.docker_compose_raw;
    if (!phpTruthy(raw) || raw === null) throw new ComposeError("No compose file found or not a valid YAML file.");
    const compose = parseDockerComposeYaml(raw);
    // Switch Image
    const updatedImage = part.row.image ?? "";
    const currentImage = phpString(dataGet(compose, ["services", name, "image"]) ?? "");
    if (updatedImage !== "" && currentImage !== updatedImage) {
      const services = dataGet(compose, "services");
      const config = services instanceof PhpArray ? services.get(name) : undefined;
      if (config instanceof PhpArray) config.set("image", updatedImage);
      raw = dumpYaml(compose, 10, 2);
      service.docker_compose_raw = raw;
    }
    const services = dataGet(compose, "services");
    const environment = dataGet(compose, ["services", name, "environment"]);
    const names: string[] = [];
    for (const [key, value] of environment instanceof PhpArray ? environment : new PhpArray()) {
      let variable: string | null = null;
      if (typeof key === "number" && typeof value === "string") variable = before(value, "=").trim();
      else if (typeof key === "string") variable = key;
      if (variable !== null && (variable.startsWith("SERVICE_FQDN_") || variable.startsWith("SERVICE_URL_")) && !names.includes(variable)) names.push(variable);
    }
    const declared = names.filter((key) => !isCopiedServiceUrlDeclaration(parser, services instanceof PhpArray ? services : new PhpArray(), part, key));
    const toProcess = new Map<string, { base: string; ports: string[] }>();
    for (const key of declared) {
      const parsed = parseServiceEnvironmentVariable(key);
      const prefix = key.startsWith("SERVICE_URL_") ? "SERVICE_URL_" : "SERVICE_FQDN_";
      const rest = key.slice(prefix.length);
      const serviceName = parsed.has_port ? beforeLast(rest, "_") : rest;
      const entry = toProcess.get(serviceName.toLowerCase()) ?? { base: serviceName, ports: [] };
      toProcess.set(serviceName.toLowerCase(), entry);
      if (parsed.has_port && parsed.port) entry.ports.push(parsed.port);
    }
    const remove = (key: string) => {
      for (const row of store.environmentVariables().filter((variable) => variable.key === key)) store.deleteEnvironmentVariable(row);
    };
    for (const { base, ports } of toProcess.values()) {
      remove(`SERVICE_URL_${base}`);
      remove(`SERVICE_FQDN_${base}`);
      for (const port of ports) {
        remove(`SERVICE_URL_${base}_${port}`);
        remove(`SERVICE_FQDN_${base}_${port}`);
      }
    }
    if (part.kind !== "application" || !phpTruthy(part.row.fqdn)) return;
    const firstFqdn = firstDomainFromList(part.row.fqdn);
    const port = parseUrlPort(firstFqdn);
    const urlValue = getFqdnWithoutPort(firstFqdn);
    const fqdnValue = getHostWithoutPort(firstFqdn);
    for (const { base, ports } of toProcess.values()) {
      parser.updateOrCreate(`SERVICE_URL_${base}`, { value: urlValue });
      parser.updateOrCreate(`SERVICE_FQDN_${base}`, { value: fqdnValue });
      const allPorts = [...new Set(ports)];
      if (port !== null && !allPorts.includes(port)) allPorts.push(port);
      for (const portNumber of allPorts) {
        parser.updateOrCreate(`SERVICE_URL_${base}_${portNumber}`, { value: `${urlValue}:${portNumber}` });
        parser.updateOrCreate(`SERVICE_FQDN_${base}_${portNumber}`, { value: `${fqdnValue}:${portNumber}` });
      }
    }
  } catch {
    // handleError($e): reported, not thrown.
  }
}

/** Url::fromString($url)->getPort(): the explicit port of an http(s) URL, as text, or null. */
function parseUrlPort(url: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)(?::(\d+))?/i.exec(url);
  return match?.[2] ? String(Number(match[2])) : null;
}

/** generateServiceSpecificFqdns(): MinIO, Logto and Garage take their domains from their own URL variables. */
function serviceSpecificFqdns(parser: Parser, application: ServiceApplicationRow, type: string): string[] {
  const server = parser.context.server;
  const uuid = application.uuid;
  const variables = (keys: readonly string[]): ServiceEnvironmentVariableRow[] | null => {
    const rows = keys.map((key) => parser.findEnvironmentVariable(key));
    return rows.every((row) => row !== undefined) ? (rows as ServiceEnvironmentVariableRow[]) : null;
  };
  const fill = (row: ServiceEnvironmentVariableRow, random: string, forceHttps: boolean): void => {
    if ((row.value ?? "") === "") parser.updateValue(row, generateServiceUrl(server, `${random}-${uuid}`, forceHttps));
  };
  if (type.includes("minio") || type.includes("pgsty/silo")) {
    const rows = variables(["MINIO_BROWSER_REDIRECT_URL", "MINIO_SERVER_URL"]);
    if (!rows) return [];
    const [browser, api] = rows as [ServiceEnvironmentVariableRow, ServiceEnvironmentVariableRow];
    fill(browser, "console", true);
    fill(api, "minio", true);
    return [`${browser.value ?? ""}:9001`, `${api.value ?? ""}:9000`];
  }
  if (type.includes("logto")) {
    const rows = variables(["LOGTO_ENDPOINT", "LOGTO_ADMIN_ENDPOINT"]);
    if (!rows) return [];
    const [endpoint, admin] = rows as [ServiceEnvironmentVariableRow, ServiceEnvironmentVariableRow];
    fill(endpoint, "logto", false);
    fill(admin, "logto-admin", false);
    return [`${endpoint.value ?? ""}:3001`, `${admin.value ?? ""}:3002`];
  }
  if (type.includes("garage")) {
    const rows = variables(["GARAGE_S3_API_URL", "GARAGE_WEB_URL", "GARAGE_ADMIN_URL"]);
    if (!rows) return [];
    const [s3, web, admin] = rows as [ServiceEnvironmentVariableRow, ServiceEnvironmentVariableRow, ServiceEnvironmentVariableRow];
    fill(s3, "s3", true);
    fill(web, "web", true);
    fill(admin, "admin", true);
    return [`${s3.value ?? ""}:3900`, `${web.value ?? ""}:3902`, `${admin.value ?? ""}:3903`];
  }
  return [];
}

/** applyServiceApplicationPrerequisites(): templates whose applications need gzip or the path prefix left alone. */
export function applyServiceApplicationPrerequisites(store: ServiceStore): void {
  const serviceName = beforeLast(store.service.name, "-");
  for (const applicationName of NEEDS_TO_DISABLE_GZIP[serviceName] ?? []) {
    const application = store.applications().find((row) => row.name === applicationName);
    if (application) application.is_gzip_enabled = false;
  }
  for (const applicationName of NEEDS_TO_DISABLE_STRIPPREFIX[serviceName] ?? []) {
    const application = store.applications().find((row) => row.name === applicationName);
    if (application) application.is_stripprefix_enabled = false;
  }
}

export interface NewServiceInput {
  /** "one-click-service-<name>" */
  type: string;
  /** new_public_id() of the service. */
  uuid: string;
  /** The service's id; 1 by default, as a row in an empty table gets. */
  id?: number;
}

/**
 * Create.php::createResource for a one-click service, up to `$service->parse(isNew: true)`: the service
 * row as Coolify creates it and its template's `envs`. Null when the catalogue has no such template.
 */
export function newServiceFromTemplate(input: NewServiceInput): { service: ServiceRow; environment: [string, string][] } | null {
  const template = serviceTemplateForType(input.type);
  if (!template) return null;
  const service: ServiceRow = {
    id: input.id ?? 1,
    uuid: input.uuid,
    name: `${template.name}-${input.uuid}`,
    docker_compose_raw: decodeBase64Text(template.entry.compose),
    docker_compose: null,
    connect_to_docker_network: NEEDS_TO_CONNECT_TO_PREDEFINED_NETWORK.includes(template.name),
    service_type: template.name,
    is_container_label_escape_enabled: true,
    compose_parsing_version: SERVICE_PARSER_VERSION,
    include_coolify_default_variables: true,
  };
  const environment: [string, string][] = [];
  if (template.entry.envs) {
    for (const line of decodeBase64Text(template.entry.envs).split(/\r\n|\r|\n/)) {
      if (!phpTruthy(line)) continue;
      // Str::before / Str::after: a line without "=" is its own key and value.
      environment.push([before(line, "="), after(line, "=")]);
    }
  }
  return { service, environment };
}

/** Create.php::createResource: the template's variables, the first parse and the template's prerequisites. */
export function createServiceFromTemplate(store: ServiceStore, environment: readonly (readonly [string, string])[], context: ServiceParserContext): ServiceParseResult {
  for (const [key, value] of environment) {
    const found = store.environmentVariables().find((row) => row.key === key);
    const cleaned = withoutEdgeLineBreaks(value);
    if (found) {
      found.value = cleaned;
      found.is_preview = false;
      found.is_shared = isSharedReference(cleaned);
    } else {
      store.createEnvironmentVariable({
        key: validatedEnvironmentVariableKey(key),
        value: cleaned,
        is_preview: false,
        is_required: false,
        is_shared: isSharedReference(cleaned),
        is_literal: false,
        is_multiline: false,
        comment: null,
        version: ENVIRONMENT_VARIABLE_VERSION,
        preserve_compose_null: false,
      });
    }
  }
  const result = parseService(store, context);
  applyServiceApplicationPrerequisites(store);
  return result;
}
