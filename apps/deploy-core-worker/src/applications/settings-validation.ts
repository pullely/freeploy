// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Shared/{HealthChecks,ResourceLimits}.php
// (rules, messages, validationAttributes, submit's defaults), app/Livewire/Project/Application/Advanced.php
// (#[Validate] rules, submit's GPU checks, the save handlers' rules), app/Livewire/Project/Application/Domains.php
// (rules, messages), app/Models/{ApplicationSetting,ServerSetting}.php (GPU_COUNT_PATTERN, parseGpuOptions,
// MAX_CONTAINER_NAME_PREFIX_LENGTH, TRAEFIK_CERTIFICATE_RESOLVER_*), app/Support/ValidationPatterns.php
// (isValidHealthCheckHost) and bootstrap/helpers/constants.php (Apache-2.0), modified.
//
// Laravel's validator for an application's Healthcheck, Resource Limits,
// Advanced and Domains forms, rule by rule. Where a component has no message
// of its own the message is Laravel's default with the Livewire property as
// the attribute (healthCheckPath reads "health check path"). All failing rules
// of a field are reported in rule order (no `bail`); a blank value skips every
// rule but `required`. These forms are PATCHes: a field the body leaves out
// keeps its stored value (Livewire always sends every property).
import { add, blank, length, type FieldErrors } from "../private-keys/validation.js";
import { isIpv6 } from "../servers/ip.js";
import { attribute, LARAVEL } from "../servers/settings-validation.js";
import { integerValue, size } from "../servers/validation.js";
import { validateApplicationDomains } from "./domains.js";
import { CONTAINER_NAME_PATTERN } from "./validation.js";

type Body = Record<string, unknown>;
export type Result<T> = { ok: true; input: T } | { ok: false; errors: FieldErrors };
const done = <T>(errors: FieldErrors, input: T): Result<T> => (Object.keys(errors).length ? { ok: false, errors } : { ok: true, input });

/** Laravel's `boolean`: true, false, 1, 0, "1", "0". Undefined when the body leaves the field out. */
function booleanRule(errors: FieldErrors, body: Body, p: string): boolean | undefined {
  const v = body[p];
  if (v === undefined || v === null) return undefined;
  if (v === true || v === 1 || v === "1") return true;
  if (v === false || v === 0 || v === "0") return false;
  add(errors, p, LARAVEL.boolean(p));
  return undefined;
}

/** A string property: a number is read as its text, as PHP coerces it. */
const text = (v: unknown): unknown => (typeof v === "number" && Number.isFinite(v) ? String(v) : v);

// ---------------------------------------------------------------- Healthcheck

/** HealthChecks::rules(): 'regex:/^[a-zA-Z0-9 \-_.\/:=@,+]+$/' */
export const HEALTH_CHECK_COMMAND_PATTERN = /^[a-zA-Z0-9 \-_./:=@,+]+$/;
/** HealthChecks::rules(): 'regex:#^[a-zA-Z0-9/\-_.~%,;]+$#' */
export const HEALTH_CHECK_PATH_PATTERN = /^[a-zA-Z0-9/\-_.~%,;]+$/;
/** HealthChecks::rules(): 'not_regex:/[\x00-\x1F\x7F]/' */
const CONTROL_CHARACTERS = /[\x00-\x1F\x7F]/;

export const HEALTH_CHECK_MESSAGES = {
  /** HealthChecks::rules(), the healthCheckHost closure. */
  host: "The health check host must be a hostname, an IPv4 address, or an IPv6 address.",
} as const;

/** ValidationPatterns::isValidHealthCheckHost(): a hostname or IPv4 address, or an IPv6 address with or without brackets. */
export function isValidHealthCheckHost(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (/^[a-zA-Z0-9.\-_]+$/.test(value)) return true;
  return /^(?:\[[0-9a-fA-F:.]+\]|[0-9a-fA-F:.]+)$/.test(value) && isIpv6(value.replace(/^\[+|\]+$/g, ""));
}

export interface HealthCheckInput {
  healthCheckEnabled: boolean;
  healthCheckType: string;
  healthCheckCommand: string | null;
  healthCheckMethod: string;
  healthCheckScheme: string;
  healthCheckHost: string;
  healthCheckPort: string | null;
  healthCheckPath: string;
  healthCheckReturnCode: number;
  healthCheckResponseText: string | null;
  healthCheckInterval: number;
  healthCheckTimeout: number;
  healthCheckRetries: number;
  healthCheckStartPeriod: number;
}

/**
 * HealthChecks::rules(), which is what validate() uses (a component's rules()
 * take the place of the same properties' #[Validate] attributes). `stored` is
 * what the application has now, for the fields the body leaves out.
 */
export function validateHealthCheck(body: Body, stored: HealthCheckInput): Result<HealthCheckInput> {
  const errors: FieldErrors = {};
  const value = <K extends keyof HealthCheckInput>(p: K): unknown => (body[p] === undefined ? stored[p] : body[p]);

  /** [required|]string|in */
  const choice = (p: "healthCheckType" | "healthCheckMethod" | "healthCheckScheme", options: string[], required: boolean): string => {
    const v = value(p);
    if (blank(v)) {
      // Not required: Laravel skips the rules; the property is a non-null string, so a blank choice is refused as not in the list.
      add(errors, p, required ? LARAVEL.required(p) : LARAVEL.in(p));
      return stored[p];
    }
    if (typeof v !== "string") add(errors, p, LARAVEL.string(p));
    if (typeof v !== "string" || !options.includes(v)) add(errors, p, LARAVEL.in(p));
    return typeof v === "string" ? v : stored[p];
  };
  /** integer[|min:n][|between:a,b]; the properties are ints, so a blank value is not one. */
  const integer = (p: "healthCheckReturnCode" | "healthCheckInterval" | "healthCheckTimeout" | "healthCheckRetries" | "healthCheckStartPeriod", opts: { min?: number; between?: [number, number] } = {}): number => {
    const v = value(p);
    if (blank(v)) {
      add(errors, p, LARAVEL.integer(p));
      return stored[p];
    }
    const n = integerValue(v);
    if (n === null) add(errors, p, LARAVEL.integer(p));
    if (opts.min !== undefined && size(v) < opts.min) add(errors, p, LARAVEL.minNumeric(p, opts.min));
    if (opts.between && (size(v) < opts.between[0] || size(v) > opts.between[1])) add(errors, p, `The ${attribute(p)} field must be between ${opts.between[0]} and ${opts.between[1]}.`);
    return n ?? stored[p];
  };
  /** nullable|string|max:n and a pattern: null for a blank value. */
  const optional = (p: "healthCheckCommand" | "healthCheckResponseText", max: number, valid: (v: string) => boolean): string | null => {
    const v = value(p);
    if (blank(v)) return null;
    if (typeof v !== "string") {
      add(errors, p, LARAVEL.string(p));
      return null;
    }
    if (length(v) > max) add(errors, p, LARAVEL.maxString(p, max));
    if (!valid(v)) add(errors, p, LARAVEL.regex(p));
    return v;
  };

  const enabled = booleanRule(errors, body, "healthCheckEnabled") ?? stored.healthCheckEnabled;
  const type = choice("healthCheckType", ["http", "cmd"], false);
  const command = optional("healthCheckCommand", 1000, (v) => HEALTH_CHECK_COMMAND_PATTERN.test(v));

  let path = stored.healthCheckPath;
  const rawPath = value("healthCheckPath");
  if (blank(rawPath)) add(errors, "healthCheckPath", LARAVEL.required("healthCheckPath"));
  else if (typeof rawPath !== "string") add(errors, "healthCheckPath", LARAVEL.string("healthCheckPath"));
  else {
    if (!HEALTH_CHECK_PATH_PATTERN.test(rawPath)) add(errors, "healthCheckPath", LARAVEL.regex("healthCheckPath"));
    path = rawPath;
  }

  // nullable|integer|min:1|max:65535; the column is a string.
  let port: string | null = null;
  const rawPort = value("healthCheckPort");
  if (!blank(rawPort)) {
    const n = integerValue(rawPort);
    if (n === null) add(errors, "healthCheckPort", LARAVEL.integer("healthCheckPort"));
    if (size(rawPort) < 1) add(errors, "healthCheckPort", LARAVEL.minNumeric("healthCheckPort", 1));
    if (size(rawPort) > 65535) add(errors, "healthCheckPort", LARAVEL.maxNumeric("healthCheckPort", 65535));
    port = n === null ? null : String(n);
  }

  let host = stored.healthCheckHost;
  const rawHost = value("healthCheckHost");
  if (blank(rawHost)) add(errors, "healthCheckHost", LARAVEL.required("healthCheckHost"));
  else if (typeof rawHost !== "string") add(errors, "healthCheckHost", LARAVEL.string("healthCheckHost"));
  else {
    if (!isValidHealthCheckHost(rawHost)) add(errors, "healthCheckHost", HEALTH_CHECK_MESSAGES.host);
    host = rawHost;
  }

  return done(errors, {
    healthCheckEnabled: enabled,
    healthCheckType: type,
    healthCheckCommand: command,
    healthCheckPath: path,
    healthCheckPort: port,
    healthCheckHost: host,
    healthCheckMethod: choice("healthCheckMethod", ["GET", "HEAD", "POST", "OPTIONS"], true),
    healthCheckReturnCode: integer("healthCheckReturnCode", { between: [100, 599] }),
    healthCheckScheme: choice("healthCheckScheme", ["http", "https"], true),
    healthCheckResponseText: optional("healthCheckResponseText", 255, (v) => !CONTROL_CHARACTERS.test(v)),
    healthCheckInterval: integer("healthCheckInterval", { min: 1 }),
    healthCheckTimeout: integer("healthCheckTimeout", { min: 1 }),
    healthCheckRetries: integer("healthCheckRetries", { min: 1 }),
    healthCheckStartPeriod: integer("healthCheckStartPeriod"),
  });
}

// ---------------------------------------------------------------- Resource Limits

/** ResourceLimits::$rules: 'regex:/^(0|\d+[bBkKmMgG])$/' */
export const MEMORY_LIMIT_PATTERN = /^(0|\d+[bBkKmMgG])$/;
/** ResourceLimits::$rules: 'regex:/^\d*\.?\d+$/' */
export const CPUS_PATTERN = /^\d*\.?\d+$/;
/** ResourceLimits::$rules: 'regex:/^\d+([,-]\d+)*$/' */
export const CPUSET_PATTERN = /^\d+([,-]\d+)*$/;

/** ResourceLimits::$messages */
export const RESOURCE_LIMIT_MESSAGES = {
  limitsMemoryRegex: "Maximum Memory Limit must be a number followed by a unit (b, k, m, g). Example: 256m, 1g. Use 0 for unlimited.",
  limitsMemorySwapRegex: "Maximum Swap Limit must be a number followed by a unit (b, k, m, g). Example: 256m, 1g. Use 0 for unlimited.",
  limitsMemoryReservationRegex: "Soft Memory Limit must be a number followed by a unit (b, k, m, g). Example: 256m, 1g. Use 0 for unlimited.",
  limitsCpusRegex: "Number of CPUs must be a number (integer or decimal). Example: 0.5, 2.",
  limitsCpusetRegex: "CPU sets must be a comma-separated list of CPU numbers or ranges. Example: 0-2 or 0,1,3.",
  limitsMemorySwappinessInteger: "Swappiness must be a whole number between 0 and 100.",
  limitsMemorySwappinessMin: "Swappiness must be between 0 and 100.",
  limitsMemorySwappinessMax: "Swappiness must be between 0 and 100.",
  limitsCpuSharesInteger: "CPU Weight must be a whole number.",
  limitsCpuSharesMin: "CPU Weight must be a positive number.",
} as const;

/** ResourceLimits::$validationAttributes */
const LIMIT_ATTRIBUTES = { limitsMemory: "memory", limitsMemorySwap: "swap", limitsMemoryReservation: "reservation", limitsCpus: "cpus", limitsCpuset: "cpuset" } as const;

export interface ResourceLimitsInput {
  limitsCpus: string;
  limitsCpuset: string | null;
  limitsCpuShares: number;
  limitsMemory: string;
  limitsMemorySwap: string;
  limitsMemorySwappiness: number;
  limitsMemoryReservation: string;
}

/** PHP's "! $value" for a form value: null, "", "0", 0 and false. */
const falsy = (v: unknown): boolean => v === null || v === undefined || v === "" || v === "0" || v === 0 || v === false;

/**
 * ResourceLimits::submit(): the defaults first (an empty memory field is "0",
 * an empty swappiness 60, empty CPU shares 1024, an empty CPU set null), then
 * $rules with $messages and $validationAttributes; the two integers are stored
 * as (int).
 */
export function validateResourceLimits(body: Body, stored: ResourceLimitsInput): Result<ResourceLimitsInput> {
  const errors: FieldErrors = {};
  const value = (p: keyof ResourceLimitsInput): unknown => text(body[p] === undefined ? stored[p] : body[p]);

  /** required|string|regex, after "if (! $this->x) $this->x = '0'". */
  const memory = (p: "limitsMemory" | "limitsMemorySwap" | "limitsMemoryReservation"): string => {
    const v = falsy(value(p)) ? "0" : value(p);
    if (blank(v)) {
      add(errors, p, `The ${LIMIT_ATTRIBUTES[p]} field is required.`);
      return stored[p];
    }
    if (typeof v !== "string") {
      add(errors, p, `The ${LIMIT_ATTRIBUTES[p]} field must be a string.`);
      add(errors, p, RESOURCE_LIMIT_MESSAGES[`${p}Regex`]);
      return stored[p];
    }
    if (!MEMORY_LIMIT_PATTERN.test(v)) add(errors, p, RESOURCE_LIMIT_MESSAGES[`${p}Regex`]);
    return v;
  };

  // limitsCpus: "if (! $this->limitsCpus) $this->limitsCpus = '0'", then nullable|regex.
  let cpus = "0";
  const rawCpus = falsy(value("limitsCpus")) ? "0" : value("limitsCpus");
  if (typeof rawCpus !== "string" || (!blank(rawCpus) && !CPUS_PATTERN.test(rawCpus))) add(errors, "limitsCpus", RESOURCE_LIMIT_MESSAGES.limitsCpusRegex);
  else cpus = blank(rawCpus) ? "0" : rawCpus;

  // limitsCpuset: '' is null, then nullable|regex.
  let cpuset: string | null = null;
  const rawCpuset = value("limitsCpuset");
  if (!blank(rawCpuset)) {
    if (typeof rawCpuset !== "string" || !CPUSET_PATTERN.test(rawCpuset)) add(errors, "limitsCpuset", RESOURCE_LIMIT_MESSAGES.limitsCpusetRegex);
    else cpuset = rawCpuset;
  }

  // limitsCpuShares: '' or null is 1024, then nullable|integer|min:0.
  let shares = 1024;
  const rawShares = body.limitsCpuShares === undefined ? stored.limitsCpuShares : body.limitsCpuShares;
  if (rawShares !== "" && rawShares !== null && !blank(rawShares)) {
    const n = integerValue(rawShares);
    if (n === null) add(errors, "limitsCpuShares", RESOURCE_LIMIT_MESSAGES.limitsCpuSharesInteger);
    if (size(rawShares) < 0) add(errors, "limitsCpuShares", RESOURCE_LIMIT_MESSAGES.limitsCpuSharesMin);
    shares = n ?? 1024;
  }

  // limitsMemorySwappiness: '' or null is 60, then required|integer|min:0|max:100.
  let swappiness = 60;
  const rawSwappiness = body.limitsMemorySwappiness === undefined ? stored.limitsMemorySwappiness : body.limitsMemorySwappiness;
  if (rawSwappiness !== "" && rawSwappiness !== null) {
    if (blank(rawSwappiness)) add(errors, "limitsMemorySwappiness", "The swappiness field is required.");
    else {
      const n = integerValue(rawSwappiness);
      if (n === null) add(errors, "limitsMemorySwappiness", RESOURCE_LIMIT_MESSAGES.limitsMemorySwappinessInteger);
      if (size(rawSwappiness) < 0) add(errors, "limitsMemorySwappiness", RESOURCE_LIMIT_MESSAGES.limitsMemorySwappinessMin);
      if (size(rawSwappiness) > 100) add(errors, "limitsMemorySwappiness", RESOURCE_LIMIT_MESSAGES.limitsMemorySwappinessMax);
      swappiness = n ?? 60;
    }
  }

  return done(errors, {
    limitsCpus: cpus,
    limitsCpuset: cpuset,
    limitsCpuShares: shares,
    limitsMemory: memory("limitsMemory"),
    limitsMemorySwap: memory("limitsMemorySwap"),
    limitsMemorySwappiness: swappiness,
    limitsMemoryReservation: memory("limitsMemoryReservation"),
  });
}

// ---------------------------------------------------------------- Advanced

/** bootstrap/helpers/constants.php */
export const DEFAULT_STOP_GRACE_PERIOD_SECONDS = 30;
export const MIN_STOP_GRACE_PERIOD_SECONDS = 1;
export const MAX_STOP_GRACE_PERIOD_SECONDS = 3600;
export const DEFAULT_ROLLING_UPDATE_DRAIN_SECONDS = 5;
export const MAX_ROLLING_UPDATE_DRAIN_SECONDS = 300;
/** ApplicationSetting::MAX_CONTAINER_NAME_PREFIX_LENGTH */
export const MAX_CONTAINER_NAME_PREFIX_LENGTH = 30;
/** ApplicationSetting::GPU_COUNT_PATTERN */
export const GPU_COUNT_PATTERN = /^(all|\d+)$/;
/** Advanced::CONTAINER_NAME_PREFIX_PATTERN */
export const CONTAINER_NAME_PREFIX_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** ServerSetting::TRAEFIK_CERTIFICATE_RESOLVER_PATTERN and …_NONE */
export const TRAEFIK_CERTIFICATE_RESOLVER_PATTERN = /^[A-Za-z0-9_-]+$/;
export const TRAEFIK_CERTIFICATE_RESOLVER_NONE = "none";

export const ADVANCED_MESSAGES = {
  /** Advanced::submit() */
  gpuCountAndDeviceIds: "You cannot set both GPU count and GPU device IDs.",
  gpuCount: 'GPU count must be a number or "all".',
  gpuOptions: "GPU options must be key=value pairs (one per line) or a YAML mapping.",
  /** Advanced::validateChangedContainerNamePrefix() */
  prefixFormat: "The container name prefix may only contain lowercase letters, numbers, and single hyphens between them.",
  prefixInUse: "This container name prefix is already in use by another application on this Freeploy instance.",
  /** Advanced::saveCustomName() */
  customNameInUse: "This custom container name is already in use by another application on this server.",
  /** Advanced::saveCertificateResolver() */
  resolverNameRegex: "The resolver name may only contain letters, numbers, hyphens, and underscores.",
  resolverNameNotIn: 'Choose "None" instead of a custom resolver named "none".',
} as const;

/** The switches of Advanced that apply to a Docker image application (the view's listboxes). */
export const ADVANCED_BOOLEANS = [
  "disableBuildCache",
  "injectBuildArgsToDockerfile",
  "includeSourceCommitInBuild",
  "includeNetworkHostsInBuild",
  "isConsistentContainerNameEnabled",
  "isLogDrainEnabled",
  "isGpuEnabled",
  "isGzipEnabled",
  "isStripprefixEnabled",
] as const;
export type AdvancedBoolean = (typeof ADVANCED_BOOLEANS)[number];

/** What syncData(true) writes; undefined keeps the stored value. */
export type AdvancedInput = Partial<Record<AdvancedBoolean, boolean>> & {
  gpuDriver?: string;
  gpuCount?: string | null;
  gpuDeviceIds?: string | null;
  gpuOptions?: string | null;
  customInternalName?: string | null;
  customContainerNamePrefix?: string | null;
};

/**
 * Advanced's #[Validate] rules, which syncData(true) checks before every
 * save, for the properties a Docker image application's page has. The
 * properties of the Git and Docker Compose sections are not read.
 */
export function validateAdvanced(body: Body): Result<AdvancedInput> {
  const errors: FieldErrors = {};
  const input: AdvancedInput = {};
  for (const p of ADVANCED_BOOLEANS) {
    const v = booleanRule(errors, body, p);
    if (v !== undefined) input[p] = v;
  }
  /** string|nullable[|max:n][|regex] */
  const optional = (p: "gpuCount" | "gpuDeviceIds" | "gpuOptions" | "customInternalName" | "customContainerNamePrefix", rules: { max?: number; regex?: RegExp } = {}): void => {
    const v = text(body[p]);
    if (v === undefined) return;
    if (blank(v)) {
      input[p] = typeof v === "string" && v !== "" ? v : null;
      return;
    }
    if (typeof v !== "string") return add(errors, p, LARAVEL.string(p));
    if (rules.max !== undefined && length(v) > rules.max) add(errors, p, LARAVEL.maxString(p, rules.max));
    if (rules.regex && !rules.regex.test(v)) add(errors, p, LARAVEL.regex(p));
    input[p] = v;
  };
  if (body.gpuDriver !== undefined) {
    const driver = text(body.gpuDriver) ?? "";
    if (typeof driver !== "string") add(errors, "gpuDriver", LARAVEL.string("gpuDriver"));
    else input.gpuDriver = driver;
  }
  optional("gpuCount");
  optional("gpuDeviceIds");
  optional("gpuOptions");
  optional("customInternalName", { max: 255, regex: CONTAINER_NAME_PATTERN });
  optional("customContainerNamePrefix", { max: MAX_CONTAINER_NAME_PREFIX_LENGTH });
  return done(errors, input);
}

/**
 * ApplicationSetting::parseGpuOptions(): the options as a mapping — a YAML
 * mapping of scalars, or one key=value pair per line — or null when they are
 * neither. Symfony's YAML parser is not available here: a YAML mapping is
 * read as flat "key: value" lines (comments and blank lines aside); a nested
 * or flow value is not a scalar, as in Coolify.
 */
export function parseGpuOptions(options: string | null | undefined): Record<string, string> | null {
  const trimmed = (options ?? "").trim();
  if (trimmed === "") return {};
  const lines = trimmed.split(/\r\n|\r|\n/);

  const yaml: Record<string, string> = {};
  let isMapping = true;
  let scalars = true;
  for (const line of lines) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const m = line.match(/^([^\s:#'"[\]{},&*!|>%@`-][^:]*?)\s*:(?:\s+(.*))?$/);
    if (!m) {
      isMapping = false;
      break;
    }
    let value = (m[2] ?? "").replace(/\s+#.*$/, "").trim();
    // An empty value is null or the start of a nested block; [ and { open a flow collection.
    if (value === "" || /^[[{|>&*!]/.test(value)) scalars = false;
    const quoted = value.match(/^"(.*)"$|^'(.*)'$/);
    if (quoted) value = quoted[1] ?? quoted[2] ?? "";
    yaml[m[1]!.trim()] = value;
  }
  if (isMapping && Object.keys(yaml).length) return scalars ? yaml : null;

  const mapping: Record<string, string> = {};
  for (const line of lines) {
    const pair = line.trim();
    if (pair === "") continue;
    const at = pair.indexOf("=");
    if (at === -1 || pair.slice(0, at).trim() === "") return null;
    mapping[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  return mapping;
}

/**
 * Str::slug(): lower case, separators and spaces as single hyphens, anything
 * else that is not a letter or a digit dropped. Laravel transliterates to
 * ASCII first (voku/portable-ascii); here accents are stripped and what is
 * still not ASCII is dropped.
 */
export function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e\s]/g, "")
    .replace(/_+/g, "-")
    .replace(/@/g, "-at-")
    .toLowerCase()
    .replace(/[^-a-z0-9\s]+/g, "")
    .replace(/[-\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type CertificateResolverMode = "server" | "none" | "custom";

/** Advanced::saveCertificateResolver(): the mode, and the name when the mode is "custom". */
export function validateCertificateResolver(body: Body): Result<{ mode: CertificateResolverMode; name: string | null }> {
  const errors: FieldErrors = {};
  const mode = body.certificateResolverMode;
  if (blank(mode)) add(errors, "certificateResolverMode", LARAVEL.required("certificateResolverMode"));
  else if (typeof mode !== "string" || !["server", "none", "custom"].includes(mode)) add(errors, "certificateResolverMode", LARAVEL.in("certificateResolverMode"));
  let name: string | null = null;
  // exclude_unless:certificateResolverMode,custom
  if (mode === "custom") {
    const v = body.certificateResolverName;
    if (blank(v)) add(errors, "certificateResolverName", "The resolver name field is required.");
    else if (typeof v !== "string") add(errors, "certificateResolverName", "The resolver name field must be a string.");
    else {
      if (length(v) > 255) add(errors, "certificateResolverName", "The resolver name field must not be greater than 255 characters.");
      if (!TRAEFIK_CERTIFICATE_RESOLVER_PATTERN.test(v)) add(errors, "certificateResolverName", ADVANCED_MESSAGES.resolverNameRegex);
      if (v === TRAEFIK_CERTIFICATE_RESOLVER_NONE) add(errors, "certificateResolverName", ADVANCED_MESSAGES.resolverNameNotIn);
      name = v;
    }
  }
  return done(errors, { mode: mode as CertificateResolverMode, name });
}

/** [required|nullable]|integer|min|max with the attribute the component names. */
function boundedInteger(errors: FieldErrors, field: string, value: unknown, name: string, opts: { required: boolean; min: number; max?: number }): number | null {
  if (blank(value)) {
    if (opts.required) add(errors, field, `The ${name} field is required.`);
    return null;
  }
  const n = integerValue(value);
  if (n === null) add(errors, field, `The ${name} field must be an integer.`);
  if (size(value) < opts.min) add(errors, field, `The ${name} field must be at least ${opts.min}.`);
  if (opts.max !== undefined && size(value) > opts.max) add(errors, field, `The ${name} field must not be greater than ${opts.max}.`);
  return n;
}

/** Advanced::saveStopGracePeriod(): nullable|integer|min:1|max:3600 ('' is null). */
export function validateStopGracePeriod(body: Body): Result<number | null> {
  const errors: FieldErrors = {};
  const n = boundedInteger(errors, "stopGracePeriod", body.stopGracePeriod, "stop grace period", { required: false, min: MIN_STOP_GRACE_PERIOD_SECONDS, max: MAX_STOP_GRACE_PERIOD_SECONDS });
  return done(errors, n);
}

/** Advanced::saveRollingUpdateDrainSeconds(): required|integer|min:0|max:300. */
export function validateRollingUpdateDrainSeconds(body: Body): Result<number> {
  const errors: FieldErrors = {};
  const n = boundedInteger(errors, "rollingUpdateDrainSeconds", body.rollingUpdateDrainSeconds, "rolling update drain time", { required: true, min: 0, max: MAX_ROLLING_UPDATE_DRAIN_SECONDS });
  return done(errors, n ?? 0);
}

/** Advanced::saveMaxRestartCount(): integer|min:0 (the property is an int, so a blank value is not one). */
export function validateMaxRestartCount(body: Body): Result<number> {
  const errors: FieldErrors = {};
  if (blank(body.maxRestartCount)) add(errors, "maxRestartCount", LARAVEL.integer("maxRestartCount"));
  const n = blank(body.maxRestartCount) ? null : boundedInteger(errors, "maxRestartCount", body.maxRestartCount, attribute("maxRestartCount"), { required: false, min: 0 });
  return done(errors, n ?? 0);
}

// ---------------------------------------------------------------- Domains

/** Domains::messages() */
export const DOMAIN_MESSAGES = {
  redirectRequired: "The Redirect setting is required.",
  redirectString: "The Redirect setting must be a string.",
  redirectIn: "The Redirect setting must be both, www, or non-www.",
} as const;

export const REDIRECTS = ["both", "www", "non-www"] as const;
export type Redirect = (typeof REDIRECTS)[number];

/** Domains::rules(): 'redirect' => 'string|required|in:both,www,non-www' with messages(). */
export function validateRedirect(errors: FieldErrors, value: unknown): Redirect | null {
  if (blank(value)) add(errors, "redirect", DOMAIN_MESSAGES.redirectRequired);
  else if (typeof value !== "string") {
    add(errors, "redirect", DOMAIN_MESSAGES.redirectString);
    add(errors, "redirect", DOMAIN_MESSAGES.redirectIn);
  } else if (!(REDIRECTS as readonly string[]).includes(value)) add(errors, "redirect", DOMAIN_MESSAGES.redirectIn);
  else return value as Redirect;
  return null;
}

/** 'string|required|in:…' with Laravel's default messages, for editingIndexing and editingRedirect. */
export function validateChoice<T extends string>(errors: FieldErrors, field: string, value: unknown, options: readonly T[]): T | null {
  if (blank(value)) add(errors, field, LARAVEL.required(field));
  else if (typeof value !== "string") {
    add(errors, field, LARAVEL.string(field));
    add(errors, field, LARAVEL.in(field));
  } else if (!(options as readonly string[]).includes(value)) add(errors, field, LARAVEL.in(field));
  else return value as T;
  return null;
}

/** ValidationPatterns::applicationDomainRules() for newDomain / editingDomain: nullable|string|max:2048 and the URL checks. */
export function validateDomainField(errors: FieldErrors, field: "newDomain" | "editingDomain", value: unknown): string | null {
  if (blank(value)) return typeof value === "string" ? value : null;
  if (typeof value !== "string") {
    add(errors, field, LARAVEL.string(field));
    return null;
  }
  if (length(value) > 2048) add(errors, field, LARAVEL.maxString(field, 2048));
  for (const message of validateApplicationDomains(value)) add(errors, field, message);
  return value;
}

/** Laravel's `boolean` for one switch of the Domains page; null when it is missing or not one. */
export function validateSwitch(errors: FieldErrors, body: Body, field: string): boolean | null {
  const v = booleanRule(errors, body, field);
  if (v === undefined && !errors[field]) add(errors, field, LARAVEL.boolean(field));
  return v ?? null;
}
