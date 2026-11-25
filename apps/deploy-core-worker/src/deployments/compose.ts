// Derived from coollabsio/coolify@91b7e3e:app/Jobs/ApplicationDeploymentJob.php (generate_compose_file,
// generate_healthcheck_commands, expectedHealthCheckResponseText, expectedHealthCheckErrorCode,
// sanitizeHealthCheckValue, generate_local_persistent_volumes, generate_local_persistent_volumes_only_volume_names,
// useDestinationNetworkInCaddyLabels, generate_image_names, resolveDockerImageTag), app/Models/{Application,
// ApplicationSetting}.php (main_port, ports_mappings_array, custom_network_aliases_array, isHealthcheckDisabled,
// stopGracePeriodSeconds, gpuDeviceReservation) and bootstrap/helpers/{shared,docker}.php
// (generate_log_drain_configuration, generate_fluentd_configuration, formatHostForUrl, generateApplicationContainerName)
// (Apache-2.0), modified.
//
// The docker-compose file of one container of a Docker image application — not a preview, not on Swarm —
// as a pure function of plain row data. Byte-equal to what Coolify's own PHP wrote for every run of
// tests/deploy-core-worker/fixtures/deployments (Symfony's Yaml::dump($compose, 10), ported in yaml.ts).
//
// Not here, because a Docker image deployment never reaches it: the Dockerfile HEALTHCHECK lookup
// (parseHealthcheckFromDockerfile), the Swarm `deploy` block, preview deployments (labels, volume suffixes).
import { isValidHealthCheckHost, parseGpuOptions, DEFAULT_STOP_GRACE_PERIOD_SECONDS, MAX_STOP_GRACE_PERIOD_SECONDS, MIN_STOP_GRACE_PERIOD_SECONDS } from "../applications/settings-validation.js";
import { parseContainerLabels, encodeLabels } from "../labels/custom-labels.js";
import { defaultLabels, escapeDollarSign, traefikHostRulesWithoutIpv6Brackets } from "../labels/labels.js";
import { isIpv6, normalizeIpAddress } from "../servers/ip.js";
import { convertDockerRunToCompose, unsupportedDockerRunOptions } from "./docker-run-options.js";
import { byteLength, escapeshellarg, floatval, intval, phpTrim } from "./php.js";
import { PhpFloat, yamlDump, type YamlValue } from "./yaml.js";

/** bootstrap/helpers/constants.php */
export const RESTART_MODE = "unless-stopped";

/** The columns of deploy.applications the compose file is made of. */
export interface ComposeApplication {
  /** Only read for the static build pack, whose web server listens on 80. */
  build_pack?: string;
  uuid: string;
  name: string;
  ports_exposes: string | null;
  ports_mappings: string | null;
  /** The stored value: a JSON list, or null. */
  custom_network_aliases: string | null;
  /** base64 of the labels text; older rows may hold the text itself. */
  custom_labels: string | null;
  custom_docker_run_options: string | null;
  health_check_enabled: boolean;
  health_check_type: string | null;
  health_check_command: string | null;
  health_check_method: string;
  health_check_scheme: string;
  health_check_host: string;
  health_check_port: string | null;
  health_check_path: string | null;
  health_check_return_code: number | string | null;
  health_check_response_text: string | null;
  health_check_interval: number;
  health_check_timeout: number;
  health_check_retries: number;
  health_check_start_period: number;
  limits_cpus: string;
  limits_cpuset: string | null;
  limits_cpu_shares: number;
  limits_memory: string;
  limits_memory_swap: string;
  limits_memory_swappiness: number;
  limits_memory_reservation: string;
}

/** The columns of deploy.application_settings the compose file is made of (null: the column's default). */
export interface ComposeSettings {
  is_static: boolean | null;
  is_consistent_container_name_enabled: boolean | null;
  stop_grace_period: number | null;
  is_log_drain_enabled: boolean | null;
  is_gpu_enabled: boolean | null;
  gpu_driver: string | null;
  gpu_count: string | null;
  gpu_device_ids: string | null;
  gpu_options: string | null;
  is_container_label_readonly_enabled: boolean | null;
  is_container_label_escape_enabled: boolean | null;
}

/** The log drain columns of deploy.server_settings. */
export interface ComposeLogDrain {
  is_logdrain_newrelic_enabled: boolean | null;
  is_logdrain_axiom_enabled: boolean | null;
  is_logdrain_custom_enabled: boolean | null;
  is_logdrain_cloudwatch_enabled: boolean | null;
  logdrain_cloudwatch_region: string | null;
  logdrain_cloudwatch_group: string | null;
  logdrain_cloudwatch_stream_prefix: string | null;
}

export interface ComposePersistentStorage {
  name: string;
  mount_path: string;
  host_path: string | null;
}

export interface ComposeFileStorage {
  fs_path: string;
  mount_path: string | null;
}

export interface ComposeInput {
  application: ComposeApplication;
  settings: ComposeSettings;
  /** generateApplicationContainerName() */
  containerName: string;
  /** generate_image_names() */
  productionImageName: string;
  /** The network of the destination the deployment runs on. */
  network: string;
  /** The network of the application's own destination: the same, unless the deployment is on an additional server. */
  primaryNetwork: string;
  projectName: string;
  environmentName: string;
  logDrain: ComposeLogDrain;
  persistentStorages: ComposePersistentStorage[];
  fileStorages: ComposeFileStorage[];
  /** generateLabelsApplication($application, null): asked only when there are no stored labels to use. */
  generateLabels: () => string[];
}

export interface ComposeLogEntry {
  message: string;
  type: "stdout" | "stderr";
}

export interface ComposeResult {
  /** Yaml::dump($docker_compose, 10) */
  yaml: string;
  compose: Map<string, YamlValue>;
  /** What generate_compose_file() adds to the deployment log, in its order. */
  logs: ComposeLogEntry[];
  /** $this->full_healthcheck_url: what health_check() shows; null when there is no Freeploy healthcheck. */
  fullHealthcheckUrl: string | null;
  /** The value generate_compose_file() saves to applications.custom_labels; undefined when it saves nothing. */
  customLabels: string | undefined;
}

/** A failure Coolify does not survive: the deployment stops. */
export class ComposeError extends Error {}

/** PHP's truthiness of a string column. */
const truthy = (value: string | null | undefined): value is string => value !== null && value !== undefined && value !== "" && value !== "0";

/** Application::ports_exposes_array / ports_mappings_array: explode(',', …), [] for null. */
export const explodeList = (value: string | null): string[] => (value === null ? [] : value.split(","));

/** Application::main_port() */
export function mainPort(application: Pick<ComposeApplication, "ports_exposes">, settings: Pick<ComposeSettings, "is_static">): Array<string | number> {
  return settings.is_static ? [80] : explodeList(application.ports_exposes);
}

/** ApplicationSetting::stopGracePeriodSeconds() */
export function stopGracePeriodSeconds(stopGracePeriod: number | null): number {
  if (stopGracePeriod !== null && stopGracePeriod >= MIN_STOP_GRACE_PERIOD_SECONDS && stopGracePeriod <= MAX_STOP_GRACE_PERIOD_SECONDS) return stopGracePeriod;
  return DEFAULT_STOP_GRACE_PERIOD_SECONDS;
}

/**
 * generateApplicationContainerName() for a deployment that is no preview: the application's uuid (or its
 * custom internal name) when container names are consistent, else "<prefix or uuid>-<Ymd\THis of now, UTC>".
 */
export function generateApplicationContainerName(
  application: { uuid: string },
  settings: { is_consistent_container_name_enabled: boolean | null; custom_internal_name: string | null; custom_container_name_prefix: string | null },
  now: Date,
): string {
  if (settings.is_consistent_container_name_enabled) return truthy(settings.custom_internal_name) ? settings.custom_internal_name : application.uuid;
  const p = (n: number, width = 2): string => String(n).padStart(width, "0");
  const stamp = `${p(now.getUTCFullYear(), 4)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `${truthy(settings.custom_container_name_prefix) ? settings.custom_container_name_prefix : application.uuid}-${stamp}`;
}

/** resolveDockerImageTag() for a deployment that is no preview. */
export function resolveDockerImageTag(application: { docker_registry_image_tag: string | null }, deployment: { rollback: boolean; commit: string | null }): string {
  if (deployment.rollback && deployment.commit !== null && deployment.commit !== "") return deployment.commit;
  if (application.docker_registry_image_tag !== null && application.docker_registry_image_tag !== "") return application.docker_registry_image_tag;
  return "latest";
}

/** generate_image_names() for the dockerimage build pack: "name:tag", or "name@sha256:hash" for a "sha256-" tag. */
export function productionImageName(image: string | null, tag: string): string {
  return tag.startsWith("sha256-") ? `${image ?? ""}@sha256:${tag.slice("sha256-".length)}` : `${image ?? ""}:${tag}`;
}

/** What deploy_dockerimage_buildpack() calls the image in its first log line. */
export function imageDisplayName(image: string | null, tag: string): string {
  return productionImageName(image, tag);
}

/** formatHostForUrl(): an IPv6 address gets brackets; other hosts stay as they are. */
function formatHostForUrl(host: string): string {
  const normalized = normalizeIpAddress(host);
  return isIpv6(normalized) ? `[${normalized}]` : normalized;
}

const sanitized = (value: string, pattern: RegExp, fallback: string): string => (pattern.test(value) ? value : fallback);

/** The healthcheck `test` command, and what the deployment log shows for it. */
export interface HealthcheckCommand {
  command: string | null;
  fullHealthcheckUrl: string | null;
  logs: ComposeLogEntry[];
}

/**
 * generate_healthcheck_commands(): the command of the CMD healthcheck, or the curl/wget check of the HTTP
 * one. Null when there is no port to check.
 */
export function generateHealthcheckCommands(application: ComposeApplication, settings: Pick<ComposeSettings, "is_static">): HealthcheckCommand {
  const logs: ComposeLogEntry[] = [];
  // Handle CMD type healthcheck
  if (application.health_check_type === "cmd" && truthy(application.health_check_command)) {
    const command = application.health_check_command.replace(/\r\n|\r|\n/g, " ");
    // Defense in depth: validate command at runtime (matches input validation regex)
    if (!/^[a-zA-Z0-9 \-_./:=@,+]+$/.test(command) || byteLength(command) > 1000) {
      logs.push({ message: "Warning: Health check command contains invalid characters or exceeds max length. Falling back to HTTP healthcheck.", type: "stdout" });
    } else {
      return { command, fullHealthcheckUrl: command, logs };
    }
  }

  // HTTP type healthcheck (default)
  let port: number;
  if (!truthy(application.health_check_port)) {
    const exposed = explodeList(application.ports_exposes);
    if (exposed.length === 0) return { command: null, fullHealthcheckUrl: null, logs };
    port = intval(exposed[0]!);
  } else {
    port = intval(application.health_check_port);
  }
  if (settings.is_static || application.build_pack === "static") port = 80;

  const method = sanitized(application.health_check_method, /^[A-Z]+$/, "GET");
  const scheme = sanitized(application.health_check_scheme, /^https?$/, "http");
  const host = isValidHealthCheckHost(application.health_check_host) ? formatHostForUrl(application.health_check_host) : "localhost";
  const path = truthy(application.health_check_path) ? sanitized(application.health_check_path, /^[a-zA-Z0-9/\-_.~%,;]+$/, "/") : null;

  const url = escapeshellarg(`${scheme}://${host}:${port}${path ?? "/"}`);
  // curl -X HEAD waits for a response body that never comes, so HEAD needs -I.
  let curlOptions = method === "HEAD" ? " -I" : " -X " + escapeshellarg(method);
  // The wget fallback always sends GET.
  let wgetOptions = "";
  // The check runs inside the container, where apps often serve HTTPS with a self-signed certificate.
  if (scheme === "https") {
    curlOptions += " -k";
    wgetOptions += " --no-check-certificate";
  }

  let full = `${method}: ${scheme}://${host}:${port}${path ?? "/"}`;
  let statusCheck = `curl -s${curlOptions} -f ${url} > /dev/null || wget -q${wgetOptions} -O- ${url} > /dev/null`;

  // expectedHealthCheckErrorCode(): an expected code of 400-599 also passes.
  const rawCode = application.health_check_return_code;
  const numericCode = typeof rawCode === "number" || (typeof rawCode === "string" && /^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\v\f]*$/.test(rawCode)) ? intval(rawCode) : null;
  const expectedErrorCode = numericCode !== null && numericCode >= 400 && numericCode <= 599 ? numericCode : null;
  if (expectedErrorCode !== null) {
    full += ` (or HTTP ${expectedErrorCode})`;
    // curl does not follow redirects, so its code is the final one. wget follows redirects,
    // so the code must be in the last response: a 3xx response is never the last one.
    statusCheck =
      `curl -s -o /dev/null -w '%{http_code}'${curlOptions} ${url} | grep -qxE '[23][0-9][0-9]|${expectedErrorCode}'` +
      ` || wget -S${wgetOptions} -O /dev/null ${url} 2>&1 | grep -qE 'HTTP/[0-9.]+ (2[0-9][0-9]|${expectedErrorCode})'`;
  }

  // expectedHealthCheckResponseText(): a HEAD response has no body, so the text is not checked for HEAD.
  let expectedText: string | null = null;
  const text = application.health_check_response_text;
  if (typeof text === "string" && text !== "") {
    if (method === "HEAD") {
      logs.push({ message: "Warning: A HEAD response has no body, so the healthcheck does not check the expected response text.", type: "stdout" });
    } else if (/[\x00-\x1F\x7F]/.test(text) || byteLength(text) > 255) {
      logs.push({ message: "Warning: The expected response text of the healthcheck contains control characters or is longer than 255 characters, so the healthcheck does not check it.", type: "stdout" });
    } else {
      expectedText = text;
    }
  }
  if (expectedText === null) return { command: `${statusCheck} || exit 1`, fullHealthcheckUrl: full, logs };

  // The text can contain credentials, so the deployment log does not show it.
  full += ", and the response must contain the expected text";
  // Docker Compose interpolates $ in the healthcheck, so $$ keeps a literal $.
  const grepText = escapeshellarg(expectedText).split("$").join("$$");
  let textCheck = `curl -s${curlOptions} ${url} | grep -qF -- ${grepText}` + ` || wget -q${wgetOptions} -O- ${url} 2>/dev/null | grep -qF -- ${grepText}`;
  if (expectedErrorCode !== null) {
    // wget writes the body of a 4xx or 5xx response only with --content-on-error. BusyBox wget
    // rejects that option, so it is a separate fallback after the plain wget.
    textCheck += ` || wget -q${wgetOptions} --content-on-error -O- ${url} 2>/dev/null | grep -qF -- ${grepText}`;
  }
  return { command: `{ ${statusCheck}; } && { ${textCheck}; } || exit 1`, fullHealthcheckUrl: full, logs };
}

/** ApplicationSetting::gpuDeviceReservation(): a count wins over device ids; options that cannot be parsed are left out. */
function gpuDeviceReservation(settings: ComposeSettings): Map<string, YamlValue> {
  const device = new Map<string, YamlValue>([["capabilities", ["gpu"]]]);
  const driver = phpTrim(settings.gpu_driver ?? "");
  if (driver !== "") device.set("driver", driver);
  const count = phpTrim(settings.gpu_count ?? "");
  const deviceIds = (settings.gpu_device_ids ?? "").split(",").map((id) => phpTrim(id)).filter((id) => id !== "");
  if (count !== "") device.set("count", count === "all" ? "all" : intval(count));
  else if (deviceIds.length > 0) device.set("device_ids", deviceIds);
  const options = parseGpuOptions(settings.gpu_options);
  if (options && Object.keys(options).length > 0) device.set("options", new Map<string, YamlValue>(Object.entries(options)));
  return device;
}

/** generate_log_drain_configuration(): Fluent Bit's fluentd driver, or CloudWatch's awslogs. */
function logDrainConfiguration(drain: ComposeLogDrain): Map<string, YamlValue> {
  if (drain.is_logdrain_newrelic_enabled || drain.is_logdrain_axiom_enabled || drain.is_logdrain_custom_enabled) {
    return new Map<string, YamlValue>([
      ["driver", "fluentd"],
      [
        "options",
        new Map<string, YamlValue>([
          ["fluentd-address", "tcp://127.0.0.1:24224"],
          ["fluentd-async", "true"],
          ["fluentd-sub-second-precision", "true"],
          // The env vars exist only when the resource includes the default variables.
          ["env", "COOLIFY_APP_NAME,COOLIFY_PROJECT_NAME,COOLIFY_SERVER_IP,COOLIFY_ENVIRONMENT_NAME"],
          // Every container has these labels. Docker skips a label that a container does not have.
          ["labels", "coolify.projectName,coolify.environmentName,coolify.resourceName,coolify.serviceName"],
        ]),
      ],
    ]);
  }
  const options: Array<[string, string | null]> = [
    ["awslogs-region", drain.logdrain_cloudwatch_region],
    ["awslogs-group", drain.logdrain_cloudwatch_group],
    ["awslogs-create-group", "true"],
    // Like fluentd-async: a CloudWatch outage or missing credentials must not block or fail the container.
    ["mode", "non-blocking"],
    // The stream is named after the container; awslogs-stream is never set because it would override this tag.
    ["tag", (drain.logdrain_cloudwatch_stream_prefix ?? "") + "{{.Name}}"],
  ];
  // reject(fn ($value) => blank($value))
  return new Map<string, YamlValue>([
    ["driver", "awslogs"],
    ["options", new Map<string, YamlValue>(options.filter((o): o is [string, string] => o[1] !== null && phpTrim(o[1]) !== ""))],
  ]);
}

/** Server::isLogDrainEnabled() */
export const serverDrainsLogs = (drain: ComposeLogDrain): boolean =>
  Boolean(drain.is_logdrain_newrelic_enabled || drain.is_logdrain_axiom_enabled || drain.is_logdrain_custom_enabled || drain.is_logdrain_cloudwatch_enabled);

/** Application::custom_network_aliases_array: the stored JSON list; anything else is no alias. */
function networkAliases(stored: string | null): string[] {
  if (stored === null) return [];
  try {
    const decoded: unknown = JSON.parse(stored);
    return Array.isArray(decoded) ? decoded.map((alias) => String(alias)) : [];
  } catch {
    return [];
  }
}

const isMap = (value: YamlValue | undefined): value is Map<string, YamlValue> => value instanceof Map;
const isIntKey = (key: string): boolean => /^(?:0|-?[1-9]\d*)$/.test(key);

/** A PHP array as a Map: a list gets the keys 0, 1, 2, …. */
const asMap = (value: YamlValue[] | Map<string, YamlValue>): Map<string, YamlValue> => (Array.isArray(value) ? new Map(value.map((v, i) => [String(i), v])) : value);

/** A Map whose keys are 0, 1, 2, … back as a list, so the dumper and later merges see a PHP list. */
function normalized(map: Map<string, YamlValue>): YamlValue[] | Map<string, YamlValue> {
  let expected = 0;
  for (const key of map.keys()) if (key !== String(expected++)) return map;
  return [...map.values()];
}

/**
 * array_merge_recursive(): values under a string key that both sides have are merged — two arrays key by key,
 * anything else into a list of both — and values under integer keys are appended.
 */
export function arrayMergeRecursive(base: YamlValue[] | Map<string, YamlValue>, over: YamlValue[] | Map<string, YamlValue>): YamlValue[] | Map<string, YamlValue> {
  const out = new Map<string, YamlValue>();
  let next = 0;
  const append = (value: YamlValue): void => {
    out.set(String(next++), value);
  };
  for (const [key, value] of asMap(base)) {
    if (isIntKey(key)) append(value);
    else out.set(key, value);
  }
  for (const [key, value] of asMap(over)) {
    if (isIntKey(key)) {
      append(value);
      continue;
    }
    const current = out.get(key);
    if (current === undefined && !out.has(key)) {
      out.set(key, value);
      continue;
    }
    const left = Array.isArray(current) || isMap(current) ? current : [current as YamlValue];
    const right = Array.isArray(value) || isMap(value) ? value : [value];
    out.set(key, arrayMergeRecursive(left, right));
  }
  return normalized(out);
}

/** data_get($compose, 'ip.0') and friends: the first value of a list option. */
const firstOf = (value: YamlValue | undefined): string | null => (Array.isArray(value) && typeof value[0] === "string" && truthy(value[0]) ? value[0] : null);

/**
 * generate_compose_file(): the compose file of the container, what it logs on the way, and the labels it
 * saves back to the application.
 */
export function generateComposeFile(input: ComposeInput): ComposeResult {
  const { application, settings, containerName, network } = input;
  const logs: ComposeLogEntry[] = [];
  const ports = mainPort(application, settings);

  // The labels: the stored ones without their coolify.* lines (saved back that way), or the generated ones.
  let customLabels: string | undefined;
  let labels: string[];
  if (truthy(application.custom_labels)) {
    const parsed = parseContainerLabels(application.custom_labels, input.generateLabels);
    labels = (parsed.labels ?? "").split(/\r\n|\n|\r/).filter((label) => !label.startsWith("coolify."));
    customLabels = encodeLabels(labels.join("\n"));
  } else if (settings.is_container_label_readonly_enabled !== false) {
    labels = input.generateLabels();
  } else {
    // Coolify passes an undefined $labels on and stops with a PHP TypeError here.
    throw new ComposeError("The application has no container labels, and its labels are not generated. Reset the labels on the General page, then deploy again.");
  }
  // useDestinationNetworkInCaddyLabels(): on a destination whose network has another name, Caddy joins that one.
  if (network !== input.primaryNetwork) labels = labels.map((label) => (label === `caddy_ingress_network=${input.primaryNetwork}` ? `caddy_ingress_network=${network}` : label));
  labels = traefikHostRulesWithoutIpv6Brackets(labels);
  if (settings.is_container_label_escape_enabled !== false) labels = labels.map(escapeDollarSign);
  labels = [...labels, ...defaultLabels({ uuid: application.uuid, name: application.uuid, projectName: input.projectName, resourceName: application.name, environment: input.environmentName, pullRequestId: 0 })];

  const service = new Map<string, YamlValue>([
    ["image", input.productionImageName],
    ["container_name", containerName],
    ["restart", RESTART_MODE],
  ]);
  if (ports.length > 0) service.set("expose", ports);
  service.set("networks", new Map<string, YamlValue>([[network, new Map<string, YamlValue>([["aliases", [containerName, ...networkAliases(application.custom_network_aliases)]]])]]));
  service.set("mem_limit", application.limits_memory);
  service.set("memswap_limit", application.limits_memory_swap);
  service.set("mem_swappiness", application.limits_memory_swappiness);
  service.set("mem_reservation", application.limits_memory_reservation);
  service.set("cpus", new PhpFloat(floatval(application.limits_cpus)));
  service.set("cpu_shares", application.limits_cpu_shares);
  // Always use .env file
  service.set("env_file", [".env"]);
  if (settings.stop_grace_period !== null) service.set("stop_grace_period", `${stopGracePeriodSeconds(settings.stop_grace_period)}s`);

  // An enabled healthcheck replaces any HEALTHCHECK of the image. When it is disabled, the container keeps
  // the HEALTHCHECK of the image (if any).
  let fullHealthcheckUrl: string | null = null;
  if (application.health_check_enabled) {
    const healthcheck = generateHealthcheckCommands(application, settings);
    logs.push(...healthcheck.logs);
    fullHealthcheckUrl = healthcheck.fullHealthcheckUrl;
    if (healthcheck.command !== null) {
      service.set(
        "healthcheck",
        new Map<string, YamlValue>([
          ["test", ["CMD-SHELL", healthcheck.command]],
          ["interval", `${application.health_check_interval}s`],
          ["timeout", `${application.health_check_timeout}s`],
          ["retries", application.health_check_retries],
          ["start_period", `${application.health_check_start_period}s`],
        ]),
      );
    }
  }
  if (application.limits_cpuset !== null) service.set("cpuset", application.limits_cpuset);
  service.set("labels", labels);
  if (serverDrainsLogs(input.logDrain) && settings.is_log_drain_enabled) service.set("logging", logDrainConfiguration(input.logDrain));
  if (settings.is_gpu_enabled) {
    service.set("deploy", new Map<string, YamlValue>([["resources", new Map<string, YamlValue>([["reservations", new Map<string, YamlValue>([["devices", [gpuDeviceReservation(settings)]]])]])]]));
    if (parseGpuOptions(settings.gpu_options) === null) logs.push({ message: "GPU options are not a valid key=value list or YAML mapping. They are ignored.", type: "stdout" });
  }
  const portMappings = explodeList(application.ports_mappings);
  if (portMappings.length > 0) service.set("ports", portMappings);

  // generate_local_persistent_volumes(): "<host path or volume name>:<mount path>", then the file storages.
  const volumes: string[] = input.persistentStorages.map((storage) => `${storage.host_path !== "" && storage.host_path !== null ? storage.host_path : storage.name}:${storage.mount_path}`);
  volumes.push(...input.fileStorages.map((storage) => `${storage.fs_path}:${storage.mount_path ?? ""}`));
  if (volumes.length > 0) service.set("volumes", volumes);

  const compose = new Map<string, YamlValue>();
  const services = new Map<string, YamlValue>();
  compose.set("services", services);
  compose.set("networks", new Map<string, YamlValue>([[network, new Map<string, YamlValue>([["external", true], ["name", network], ["attachable", true]])]]));
  // generate_local_persistent_volumes_only_volume_names(): the named volumes, not the host paths.
  const named = input.persistentStorages.filter((storage) => !truthy(storage.host_path));
  if (named.length > 0) compose.set("volumes", new Map<string, YamlValue>(named.map((storage) => [storage.name, new Map<string, YamlValue>([["name", storage.name], ["external", false]])])));

  let custom = convertDockerRunToCompose(application.custom_docker_run_options);
  if (settings.is_gpu_enabled) {
    const reservations = ((custom.get("deploy") as Map<string, YamlValue> | undefined)?.get("resources") as Map<string, YamlValue> | undefined)?.get("reservations") as Map<string, YamlValue> | undefined;
    const devices = reservations?.get("devices");
    if (Array.isArray(devices) && devices.length > 0) {
      reservations!.delete("devices");
      logs.push({ message: "GPU access is enabled in the GPU settings, so --gpus in Custom Docker Options is ignored.", type: "stdout" });
    }
  }
  const unsupported = unsupportedDockerRunOptions(application.custom_docker_run_options);
  if (unsupported.length > 0) {
    logs.push({
      message: `Warning: These custom Docker options are not supported and were not applied: ${unsupported.join(", ")}. See https://coolify.io/docs/applications/builds/custom-docker-options for the supported options.`,
      type: "stderr",
    });
  }

  const consistent = Boolean(settings.is_consistent_container_name_enabled);
  // With a consistent container name the service is named after the application.
  const serviceName = consistent ? application.uuid : containerName;
  let merged: YamlValue[] | Map<string, YamlValue> = service;
  if (custom.size > 0) {
    const ipv4 = firstOf(custom.get("ip"));
    const ipv6 = firstOf(custom.get("ip6"));
    custom = new Map(custom);
    custom.delete("ip");
    custom.delete("ip6");
    // Without a consistent name the networks entry is dropped and written again with the addresses only.
    if (!consistent && (ipv4 !== null || ipv6 !== null)) service.delete("networks");
    if (ipv4 !== null || ipv6 !== null) {
      const networks = (service.get("networks") as Map<string, YamlValue> | undefined) ?? new Map<string, YamlValue>();
      const entry = (networks.get(network) as Map<string, YamlValue> | undefined) ?? new Map<string, YamlValue>();
      if (ipv4 !== null) entry.set("ipv4_address", ipv4);
      if (ipv6 !== null) entry.set("ipv6_address", ipv6);
      networks.set(network, entry);
      service.set("networks", networks);
    }
    merged = arrayMergeRecursive(service, custom);
  }
  services.set(serviceName, merged);

  return { yaml: yamlDump(compose, 10), compose, logs, fullHealthcheckUrl, customLabels };
}
