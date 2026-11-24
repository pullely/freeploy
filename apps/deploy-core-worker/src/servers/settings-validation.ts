// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Server/{Advanced,DockerCleanup,LogDrains,Swarm,Sentinel}.php
// (#[Validate] rules, customValidation, the cron checks), app/Rules/{ValidHostname,ValidFluentBitConfig}.php,
// app/Models/ServerSetting.php (isValidSentinelToken) and bootstrap/helpers/{shared,constants}.php
// (validate_cron_expression, translate_cron_expression, VALID_CRON_STRINGS) (Apache-2.0), modified.
//
// Laravel's validator for the server settings forms, rule by rule. The
// components have no messages() of their own, so every message is Laravel's
// default with the Livewire property as the attribute (Str::snake, then
// spaces: logDrainAxiomApiKey reads "log drain axiom api key").
import { add, blank, length, type FieldErrors } from "../private-keys/validation.js";
import { hostnameError } from "./ip.js";
import { integerValue, isUrl, size } from "./validation.js";

/** Laravel's displayable attribute for a Livewire property. */
export const attribute = (property: string): string => property.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();

/** Laravel's lang/en/validation.php defaults. */
export const LARAVEL = {
  required: (p: string) => `The ${attribute(p)} field is required.`,
  string: (p: string) => `The ${attribute(p)} field must be a string.`,
  integer: (p: string) => `The ${attribute(p)} field must be an integer.`,
  boolean: (p: string) => `The ${attribute(p)} field must be true or false.`,
  minNumeric: (p: string, n: number) => `The ${attribute(p)} field must be at least ${n}.`,
  maxNumeric: (p: string, n: number) => `The ${attribute(p)} field must not be greater than ${n}.`,
  maxString: (p: string, n: number) => `The ${attribute(p)} field must not be greater than ${n} characters.`,
  in: (p: string) => `The selected ${attribute(p)} is invalid.`,
  regex: (p: string) => `The ${attribute(p)} field format is invalid.`,
  url: (p: string) => `The ${attribute(p)} field must be a valid URL.`,
} as const;

/** Copy the components raise themselves, word for word. */
export const SETTINGS_MESSAGES = {
  /** Advanced::submit() */
  invalidDiskUsageCron: "Invalid Cron / Human expression for Disk Usage Check Frequency.",
  /** DockerCleanup::submit() */
  invalidDockerCleanupCron: "Invalid Cron / Human expression for Docker Cleanup Frequency.",
  /** LogDrains::customValidation() */
  oneLogDrain: "Only one log drain can be enabled at a time. Disable the current log drain first.",
  /** Swarm::syncData(true) */
  swarmDeprecated: "Docker Swarm is deprecated and cannot be enabled for new teams.",
} as const;

// ---------------------------------------------------------------- cron

/** VALID_CRON_STRINGS */
export const VALID_CRON_STRINGS: Readonly<Record<string, string>> = {
  every_minute: "* * * * *",
  hourly: "0 * * * *",
  daily: "0 0 * * *",
  weekly: "0 0 * * 0",
  monthly: "0 0 1 * *",
  yearly: "0 0 1 1 *",
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
};

/** dragonmantank/cron-expression's CronExpression::MAPPINGS. */
const CRON_MAPPINGS: Readonly<Record<string, string>> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** One cron field: lists of *, n, a-b, each optionally /step; names for months and weekdays. */
function validCronField(part: string, min: number, max: number, names: string[] = [], special?: RegExp): boolean {
  const value = (v: string) => {
    if (/^\d+$/.test(v)) return Number(v) >= min && Number(v) <= max;
    return names.includes(v.toUpperCase());
  };
  return part.split(",").every((item) => {
    if (item === "") return false;
    if (special?.test(item)) return true;
    const pieces = item.split("/");
    if (pieces.length > 2) return false;
    const [range, step] = pieces as [string, string | undefined];
    if (step !== undefined && !/^[1-9]\d*$/.test(step)) return false;
    if (range === "*") return true;
    const bounds = range.split("-");
    if (bounds.length === 1) return value(bounds[0]!);
    return bounds.length === 2 && value(bounds[0]!) && value(bounds[1]!);
  });
}

/** CronExpression's field validation for a five-field expression (or one of its macros). */
export function isValidCronExpression(expression: string): boolean {
  const mapped = CRON_MAPPINGS[expression.toLowerCase()] ?? expression;
  const parts = mapped.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) return false;
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  return (
    validCronField(minute, 0, 59) &&
    validCronField(hour, 0, 23) &&
    validCronField(dom, 1, 31, [], /^(\?|L|LW|\d{1,2}W)$/) &&
    validCronField(month, 1, 12, MONTHS) &&
    validCronField(dow, 0, 7, DAYS, /^(\?|[0-7]L|[0-7]#[1-5])$/)
  );
}

/** validate_cron_expression(): a preset of VALID_CRON_STRINGS or a valid expression. */
export function validateCronExpression(expression: unknown): boolean {
  if (typeof expression !== "string" || expression === "" || expression === "0") return false;
  return expression in VALID_CRON_STRINGS || isValidCronExpression(expression);
}

/** translate_cron_expression(): a preset becomes its expression. */
export function translateCronExpression(expression: string): string {
  return VALID_CRON_STRINGS[expression] ?? expression;
}

// ---------------------------------------------------------------- rules

type Body = Record<string, unknown>;
type Result<T> = { ok: true; input: T } | { ok: false; errors: FieldErrors };

/** Laravel's `boolean`: true, false, 1, 0, "1", "0". Undefined keeps the stored value. */
function booleanRule(errors: FieldErrors, body: Body, p: string): boolean | undefined {
  const v = body[p];
  if (v === undefined || v === null) return undefined;
  if (v === true || v === 1 || v === "1") return true;
  if (v === false || v === 0 || v === "0") return false;
  add(errors, p, LARAVEL.boolean(p));
  return undefined;
}

/** required|integer|min|max (Laravel's numeric size for an integer field). */
function integerRule(errors: FieldErrors, body: Body, p: string, opts: { required: boolean; min?: number; max?: number; in?: number[] }): number | null {
  const v = body[p];
  if (blank(v)) {
    // Not required: Laravel skips the rules; the column cannot hold null, so it is refused as not an integer.
    add(errors, p, opts.required ? LARAVEL.required(p) : LARAVEL.integer(p));
    return null;
  }
  const n = integerValue(v);
  if (n === null) add(errors, p, LARAVEL.integer(p));
  if (opts.min !== undefined && size(v) < opts.min) add(errors, p, LARAVEL.minNumeric(p, opts.min));
  if (opts.max !== undefined && size(v) > opts.max) add(errors, p, LARAVEL.maxNumeric(p, opts.max));
  if (opts.in && (n === null || !opts.in.includes(n))) add(errors, p, LARAVEL.in(p));
  return n;
}

/** string|nullable with further checks: null for a blank value. */
function nullableString(errors: FieldErrors, body: Body, p: string, checks: Array<(v: string) => string | null> = []): string | null {
  const v = body[p];
  if (blank(v)) return null;
  if (typeof v !== "string") {
    add(errors, p, LARAVEL.string(p));
    return null;
  }
  for (const check of checks) {
    const e = check(v);
    if (e) add(errors, p, e);
  }
  return v;
}

const regexCheck = (p: string, re: RegExp) => (v: string) => (re.test(v) ? null : LARAVEL.regex(p));
const maxCheck = (p: string, n: number) => (v: string) => (length(v) > n ? LARAVEL.maxString(p, n) : null);
const urlCheck = (p: string) => (v: string) => (isUrl(v) ? null : LARAVEL.url(p));
const hostnameCheck = (p: string) => (v: string) => hostnameError(attribute(p), v);
const fluentBitCheck = (p: string, parsersOnly: boolean) => (v: string) => {
  const e = fluentBitConfigError(v, parsersOnly);
  return e === null ? null : `The ${attribute(p)} is not allowed: ${e}`;
};

const done = <T>(errors: FieldErrors, input: T): Result<T> => (Object.keys(errors).length ? { ok: false, errors } : { ok: true, input });

// ---------------------------------------------------------------- Advanced

export interface AdvancedInput {
  serverDiskUsageCheckFrequency: string;
  serverDiskUsageNotificationThreshold: number;
  serverDiskUsageNotificationIntervalHours: number;
  concurrentBuilds: number;
  dynamicTimeout: number;
  deploymentQueueLimit: number;
  backupCompressionCpuPercentage: number;
}

/** Advanced's #[Validate] rules. */
export function validateAdvanced(body: Body): Result<AdvancedInput> {
  const errors: FieldErrors = {};
  const frequency = body.serverDiskUsageCheckFrequency;
  if (frequency !== undefined && frequency !== null && typeof frequency !== "string") add(errors, "serverDiskUsageCheckFrequency", LARAVEL.string("serverDiskUsageCheckFrequency"));
  const input = {
    serverDiskUsageCheckFrequency: typeof frequency === "string" ? frequency : "",
    serverDiskUsageNotificationThreshold: integerRule(errors, body, "serverDiskUsageNotificationThreshold", { required: true, min: 1, max: 99 })!,
    serverDiskUsageNotificationIntervalHours: integerRule(errors, body, "serverDiskUsageNotificationIntervalHours", { required: true, min: 1, max: 720 })!,
    concurrentBuilds: integerRule(errors, body, "concurrentBuilds", { required: true, min: 1 })!,
    dynamicTimeout: integerRule(errors, body, "dynamicTimeout", { required: true, min: 1 })!,
    deploymentQueueLimit: integerRule(errors, body, "deploymentQueueLimit", { required: true, min: 1 })!,
    backupCompressionCpuPercentage: integerRule(errors, body, "backupCompressionCpuPercentage", { required: true, in: [25, 50, 75, 100] })!,
  };
  return done(errors, input);
}

// ---------------------------------------------------------------- Docker Cleanup

export interface DockerCleanupInput {
  dockerCleanupFrequency: string;
  dockerCleanupThreshold: number;
  forceDockerCleanup?: boolean | undefined;
  deleteUnusedVolumes?: boolean | undefined;
  deleteUnusedNetworks?: boolean | undefined;
  disableApplicationImageRetention?: boolean | undefined;
}

/** DockerCleanup's #[Validate] rules. */
export function validateDockerCleanup(body: Body): Result<DockerCleanupInput> {
  const errors: FieldErrors = {};
  const frequency = body.dockerCleanupFrequency;
  if (typeof frequency !== "string" && !blank(frequency)) add(errors, "dockerCleanupFrequency", LARAVEL.string("dockerCleanupFrequency"));
  else if (blank(frequency)) add(errors, "dockerCleanupFrequency", LARAVEL.required("dockerCleanupFrequency"));
  const input: DockerCleanupInput = {
    dockerCleanupFrequency: typeof frequency === "string" ? frequency : "",
    dockerCleanupThreshold: integerRule(errors, body, "dockerCleanupThreshold", { required: false, min: 1, max: 99 })!,
    forceDockerCleanup: booleanRule(errors, body, "forceDockerCleanup"),
    deleteUnusedVolumes: booleanRule(errors, body, "deleteUnusedVolumes"),
    deleteUnusedNetworks: booleanRule(errors, body, "deleteUnusedNetworks"),
    disableApplicationImageRetention: booleanRule(errors, body, "disableApplicationImageRetention"),
  };
  return done(errors, input);
}

// ---------------------------------------------------------------- Log Drains

export const LOG_DRAIN_TYPES = ["newrelic", "axiom", "custom", "cloudwatch"] as const;
export type LogDrainType = (typeof LOG_DRAIN_TYPES)[number];

export interface LogDrainsInput {
  isLogDrainNewRelicEnabled: boolean;
  isLogDrainAxiomEnabled: boolean;
  isLogDrainCustomEnabled: boolean;
  isLogDrainCloudwatchEnabled: boolean;
  logDrainNewRelicLicenseKey: string | null;
  logDrainNewRelicBaseUri: string | null;
  logDrainAxiomDatasetName: string | null;
  logDrainAxiomApiKey: string | null;
  logDrainAxiomDomain: string | null;
  logDrainCustomConfig: string | null;
  logDrainCustomConfigParser: string | null;
  logDrainCloudwatchRegion: string | null;
  logDrainCloudwatchGroup: string | null;
  logDrainCloudwatchStreamPrefix: string | null;
}

const KEY_RE = /^[a-zA-Z0-9_\-.]+$/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const GROUP_RE = /^[.\-_/#A-Za-z0-9]{1,512}$/;
const PREFIX_RE = /^[A-Za-z0-9_\-./#]*$/;
/**
 * Freeploy's: the New Relic license key and the Axiom API key are stored
 * encrypted in VARCHAR(255) columns, which holds a ciphertext of at most this many characters.
 */
export const LOG_DRAIN_KEY_MAX = 150;

/**
 * LogDrains' #[Validate] rules, then customValidation(): one drain at a time,
 * and the enabled drain's required fields (the drain's own rules).
 * `current` holds the stored enabled flags, for the booleans the body leaves out.
 */
export function validateLogDrains(body: Body, current: Record<"isLogDrainNewRelicEnabled" | "isLogDrainAxiomEnabled" | "isLogDrainCustomEnabled" | "isLogDrainCloudwatchEnabled", boolean>): Result<LogDrainsInput> {
  const errors: FieldErrors = {};
  const flag = (p: keyof typeof current) => booleanRule(errors, body, p) ?? current[p];
  const input: LogDrainsInput = {
    isLogDrainNewRelicEnabled: flag("isLogDrainNewRelicEnabled"),
    isLogDrainCustomEnabled: flag("isLogDrainCustomEnabled"),
    isLogDrainAxiomEnabled: flag("isLogDrainAxiomEnabled"),
    isLogDrainCloudwatchEnabled: flag("isLogDrainCloudwatchEnabled"),
    logDrainNewRelicLicenseKey: nullableString(errors, body, "logDrainNewRelicLicenseKey", [regexCheck("logDrainNewRelicLicenseKey", KEY_RE), maxCheck("logDrainNewRelicLicenseKey", LOG_DRAIN_KEY_MAX)]),
    logDrainNewRelicBaseUri: nullableString(errors, body, "logDrainNewRelicBaseUri", [urlCheck("logDrainNewRelicBaseUri")]),
    logDrainAxiomDatasetName: nullableString(errors, body, "logDrainAxiomDatasetName", [regexCheck("logDrainAxiomDatasetName", KEY_RE)]),
    logDrainAxiomApiKey: nullableString(errors, body, "logDrainAxiomApiKey", [regexCheck("logDrainAxiomApiKey", KEY_RE), maxCheck("logDrainAxiomApiKey", LOG_DRAIN_KEY_MAX)]),
    logDrainAxiomDomain: nullableString(errors, body, "logDrainAxiomDomain", [hostnameCheck("logDrainAxiomDomain")]),
    logDrainCustomConfig: nullableString(errors, body, "logDrainCustomConfig"),
    logDrainCustomConfigParser: nullableString(errors, body, "logDrainCustomConfigParser"),
    logDrainCloudwatchRegion: nullableString(errors, body, "logDrainCloudwatchRegion", [maxCheck("logDrainCloudwatchRegion", 64), regexCheck("logDrainCloudwatchRegion", REGION_RE)]),
    logDrainCloudwatchGroup: nullableString(errors, body, "logDrainCloudwatchGroup", [regexCheck("logDrainCloudwatchGroup", GROUP_RE)]),
    logDrainCloudwatchStreamPrefix: nullableString(errors, body, "logDrainCloudwatchStreamPrefix", [maxCheck("logDrainCloudwatchStreamPrefix", 256), regexCheck("logDrainCloudwatchStreamPrefix", PREFIX_RE)]),
  };
  if (Object.keys(errors).length) return { ok: false, errors };

  const enabled = [input.isLogDrainNewRelicEnabled, input.isLogDrainAxiomEnabled, input.isLogDrainCustomEnabled, input.isLogDrainCloudwatchEnabled].filter(Boolean).length;
  if (enabled > 1) return { ok: false, errors: { logDrain: [SETTINGS_MESSAGES.oneLogDrain] } };
  const required = (p: keyof LogDrainsInput) => {
    if (blank(input[p])) add(errors, p, LARAVEL.required(p));
  };
  if (input.isLogDrainNewRelicEnabled) {
    required("logDrainNewRelicLicenseKey");
    required("logDrainNewRelicBaseUri");
  } else if (input.isLogDrainAxiomEnabled) {
    required("logDrainAxiomDatasetName");
    required("logDrainAxiomApiKey");
    required("logDrainAxiomDomain");
  } else if (input.isLogDrainCustomEnabled) {
    required("logDrainCustomConfig");
    for (const [p, parsersOnly] of [["logDrainCustomConfig", false], ["logDrainCustomConfigParser", true]] as const) {
      const v = input[p];
      const e = v === null ? null : fluentBitCheck(p, parsersOnly)(v);
      if (e) add(errors, p, e);
    }
  } else if (input.isLogDrainCloudwatchEnabled) {
    required("logDrainCloudwatchRegion");
    required("logDrainCloudwatchGroup");
  }
  return done(errors, input);
}

/** ValidFluentBitConfig::check(): why the value is not allowed, or null. */
export function fluentBitConfigError(value: string, parsersOnly = false): string | null {
  if (value.trim() === "") return null;
  const CONFIG_SECTIONS = ["SERVICE", "INPUT", "FILTER", "OUTPUT", "PARSER", "MULTILINE_PARSER"];
  const PARSER_SECTIONS = ["PARSER", "MULTILINE_PARSER"];
  const PLUGIN_SECTIONS = ["INPUT", "FILTER", "OUTPUT"];
  const DENIED_PLUGINS = ["lua", "wasm", "exec", "exec_wasi", "file"];
  const DENIED_KEYS = ["plugins_file"];
  const allowed = parsersOnly ? PARSER_SECTIONS : CONFIG_SECTIONS;
  let section: string | null = null;
  let hasForwardInput = false;
  const lines = value.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const n = i + 1;
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("@")) {
      const directive = line.split(/\s+/)[0]!.toLowerCase();
      if (parsersOnly || directive !== "@set") return `line ${n} uses the ${directive} directive.`;
      continue;
    }
    if (line.startsWith("[")) {
      const m = /^\[\s*([A-Za-z_]+)\s*\]$/.exec(line);
      if (!m) return `line ${n} is not a valid section header.`;
      section = m[1]!.toUpperCase();
      if (!allowed.includes(section)) return `line ${n} uses the [${section}] section. Allowed sections: ${allowed.join(", ")}.`;
      continue;
    }
    if (section === null) return `line ${n} is outside a section.`;
    const space = line.search(/\s/);
    const key = (space === -1 ? line : line.slice(0, space)).toLowerCase();
    const rest = space === -1 ? "" : line.slice(space).replace(/^\s+/, "");
    if (!/^[a-z_][a-z0-9_.-]*$/.test(key)) return `line ${n} has an invalid key.`;
    if (DENIED_KEYS.includes(key)) return `line ${n} uses the ${key} key.`;
    if (key === "name" && PLUGIN_SECTIONS.includes(section)) {
      const plugin = rest.trim().split("://")[0]!.toLowerCase();
      if (!/^[a-z0-9_]+$/.test(plugin)) return `line ${n} must name a plugin literally.`;
      if (DENIED_PLUGINS.includes(plugin)) return `line ${n} uses the ${plugin} plugin.`;
      hasForwardInput = hasForwardInput || (section === "INPUT" && plugin === "forward");
    }
  }
  if (!parsersOnly && !hasForwardInput) return 'it has no [INPUT] section with "Name forward". Containers send their logs to this input on port 24224.';
  return null;
}

// ---------------------------------------------------------------- Swarm

export interface SwarmInput {
  isSwarmManager?: boolean | undefined;
  isSwarmWorker?: boolean | undefined;
}

export function validateSwarm(body: Body): Result<SwarmInput> {
  const errors: FieldErrors = {};
  return done(errors, { isSwarmManager: booleanRule(errors, body, "isSwarmManager"), isSwarmWorker: booleanRule(errors, body, "isSwarmWorker") });
}

// ---------------------------------------------------------------- Sentinel

/** ServerSetting::isValidSentinelToken()'s pattern. */
export const SENTINEL_TOKEN_RE = /^[a-zA-Z0-9._\-+=/]+$/;

export interface SentinelInput {
  sentinelToken: string;
  sentinelCustomUrl: string | null;
  isMetricsEnabled?: boolean | undefined;
  isSentinelDebugEnabled?: boolean | undefined;
}

/** Sentinel's #[Validate] rules. */
export function validateSentinel(body: Body): Result<SentinelInput> {
  const errors: FieldErrors = {};
  const token = body.sentinelToken;
  if (blank(token)) add(errors, "sentinelToken", LARAVEL.required("sentinelToken"));
  else if (typeof token !== "string") add(errors, "sentinelToken", LARAVEL.string("sentinelToken"));
  else {
    if (length(token) > 500) add(errors, "sentinelToken", LARAVEL.maxString("sentinelToken", 500));
    if (!SENTINEL_TOKEN_RE.test(token)) add(errors, "sentinelToken", LARAVEL.regex("sentinelToken"));
  }
  const url = body.sentinelCustomUrl;
  if (!blank(url) && !(typeof url === "string" && isUrl(url))) add(errors, "sentinelCustomUrl", LARAVEL.url("sentinelCustomUrl"));
  return done(errors, {
    sentinelToken: typeof token === "string" ? token : "",
    sentinelCustomUrl: typeof url === "string" && !blank(url) ? url : null,
    isMetricsEnabled: booleanRule(errors, body, "isMetricsEnabled"),
    isSentinelDebugEnabled: booleanRule(errors, body, "isSentinelDebugEnabled"),
  });
}
