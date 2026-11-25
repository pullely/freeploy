// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Shared/{HealthChecks,ResourceLimits}.php,
// app/Livewire/Project/Application/Advanced.php, app/Models/{Application,ApplicationSetting,Server}.php
// (isForceHttpsEnabled and its siblings, rollingUpdateDrainSeconds, isContainerNamePrefixInUse,
// isLogDrainEnabled, proxyType, traefikCertificateResolver, detectedGpus, maintenanceServers) and
// resources/views/components/server/gpu-list.blade.php (Apache-2.0), modified.
//
// What an application's Healthcheck, Resource Limits and Advanced components
// do, as plain operations on one org's application. They only read and write
// deploy.applications and deploy.application_settings: every setting here
// takes effect at the next deployment, so it is simply stored. Refreshing the
// detected GPUs runs on the server and needs the SSH executor.
import type {
  ApplicationConfigurationChanges,
  ApplicationSettingsChanges,
  DeployApplicationConfigurationRow,
  DeployApplicationContainerNamesRow,
  DeployApplicationDomainsRow,
  DeployApplicationRow,
} from "@saas/db/deploy";
import { blank, type FieldErrors } from "../private-keys/validation.js";
import { applicationShow, type ApplicationShow } from "./service.js";
import {
  ADVANCED_BOOLEANS,
  ADVANCED_MESSAGES,
  CONTAINER_NAME_PREFIX_PATTERN,
  DEFAULT_ROLLING_UPDATE_DRAIN_SECONDS,
  GPU_COUNT_PATTERN,
  MAX_ROLLING_UPDATE_DRAIN_SECONDS,
  TRAEFIK_CERTIFICATE_RESOLVER_NONE,
  parseGpuOptions,
  slug,
  validateAdvanced,
  validateCertificateResolver,
  validateHealthCheck,
  validateMaxRestartCount,
  validateResourceLimits,
  validateRollingUpdateDrainSeconds,
  validateStopGracePeriod,
  type AdvancedBoolean,
  type AdvancedInput,
  type CertificateResolverMode,
  type HealthCheckInput,
  type ResourceLimitsInput,
  type Result,
} from "./settings-validation.js";

export interface ApplicationSettingsStore {
  /** The application as the configuration frame reads it (heading, menu). */
  findByUuid(uuid: string): Promise<DeployApplicationRow | null>;
  /** The application with its settings and its destination's server. */
  configuration(uuid: string): Promise<DeployApplicationConfigurationRow | null>;
  /** $application->save() */
  update(id: string | number, changes: ApplicationConfigurationChanges): Promise<boolean>;
  /** $application->settings->save() */
  updateSettings(applicationId: string | number, changes: ApplicationSettingsChanges): Promise<boolean>;
  /** $server->applications() with their container names. */
  containerNames(serverId: string | number): Promise<DeployApplicationContainerNamesRow[]>;
  /** Every application of the org that has domains (checkDomainUsage). */
  domains(): Promise<DeployApplicationDomainsRow[]>;
}

export interface ApplicationSettingsContext {
  store: ApplicationSettingsStore;
  /** The clock, for the DNS statuses' checked_at. */
  now?: () => Date;
}

export const APPLICATION_SETTINGS_MESSAGES = {
  /** HealthChecks::submit() / instantSave() / toggleHealthcheck() */
  healthcheckUpdated: "Healthcheck updated.",
  healthcheckEnabled: "Healthcheck enabled.",
  healthcheckDisabled: "Healthcheck disabled.",
  healthcheckEnabledRestart: "Healthcheck has been enabled. A restart is required to apply the new settings.",
  /** ResourceLimits::submit() */
  limitsUpdated: "Resource limits updated.",
  /** Advanced */
  settingsSaved: "Settings saved.",
  logDrainNotEnabled: "Log drain is not enabled on this server.",
  customNameSaved: "Custom name saved.",
  prefixSaved: "Container name prefix saved.",
  resolverSaved: "Certificate resolver saved.",
  stopGracePeriodUpdated: "Stop grace period updated.",
  drainUpdated: "Rolling update drain time updated.",
  maxRestartCountSaved: "Max restart count saved.",
  validateServerFirst: "Validate the server connection before you refresh GPUs.",
  /** Freeploy's: the SSH executor is not deployed yet. */
  refreshGpusUnavailable: "Refreshing GPUs needs the SSH executor, which is not available yet.",
} as const;

/** A failure Coolify reports through dispatch('error') or an exception; `details` go to the answer as they are. */
export class SettingsError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

/** A ValidationException: Laravel's errors by field. */
export class SettingsFieldErrors extends Error {
  constructor(readonly fields: FieldErrors) {
    super("Validation failed");
  }
}

/** The validated input, or the ValidationException Laravel throws. */
export function valid<T>(result: Result<T>): T {
  if (!result.ok) throw new SettingsFieldErrors(result.errors);
  return result.input;
}

type Body = Record<string, unknown>;

/** A JSON column: the driver may hand back the parsed value or its text. */
export function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** Server::PLACEHOLDER_IPS */
const PLACEHOLDER_IPS = ["1.2.3.4", "0.0.0.0", "::"];

/** Server::isFunctional() for the application's server. */
export function serverIsFunctional(row: DeployApplicationConfigurationRow): boolean {
  return row.server_id !== null && Boolean(row.server_is_reachable) && Boolean(row.server_is_usable) && row.server_force_disabled === false && !PLACEHOLDER_IPS.includes(row.server_ip ?? "");
}

interface Loaded {
  row: DeployApplicationConfigurationRow;
  application: ApplicationShow;
}

/** The application for the frame and for the page, or null when it is not the org's. */
export async function loadConfiguration(ctx: ApplicationSettingsContext, uuid: string, canUpdate: boolean): Promise<Loaded | null> {
  const row = await ctx.store.configuration(uuid);
  const frame = row ? await ctx.store.findByUuid(uuid) : null;
  return row && frame ? { row, application: applicationShow(frame, canUpdate) } : null;
}

async function reload(ctx: ApplicationSettingsContext, uuid: string): Promise<DeployApplicationConfigurationRow> {
  return (await ctx.store.configuration(uuid))!;
}

// ---------------------------------------------------------------- Healthcheck

export interface HealthCheckSettings extends HealthCheckInput {
  /** custom_healthcheck_found: the image or the Dockerfile has its own HEALTHCHECK. */
  customHealthcheckFound: boolean;
}

/** HealthChecks::syncData(): the command and the response text can embed credentials, so only who can update gets them. */
export function healthCheck(row: DeployApplicationConfigurationRow, canViewSecrets: boolean): HealthCheckSettings {
  return {
    healthCheckEnabled: row.health_check_enabled === true,
    healthCheckType: row.health_check_type ?? "http",
    healthCheckCommand: canViewSecrets ? (row.health_check_command ?? null) : null,
    healthCheckMethod: row.health_check_method,
    healthCheckScheme: row.health_check_scheme,
    healthCheckHost: row.health_check_host,
    healthCheckPort: row.health_check_port ?? null,
    healthCheckPath: row.health_check_path,
    healthCheckReturnCode: Number(row.health_check_return_code),
    healthCheckResponseText: canViewSecrets ? (row.health_check_response_text ?? null) : null,
    healthCheckInterval: Number(row.health_check_interval),
    healthCheckTimeout: Number(row.health_check_timeout),
    healthCheckRetries: Number(row.health_check_retries),
    healthCheckStartPeriod: Number(row.health_check_start_period),
    customHealthcheckFound: row.custom_healthcheck_found === true,
  };
}

export interface Saved<T> {
  application: ApplicationShow;
  settings: T;
  /** The success toast (null when Coolify shows none). */
  message: string | null;
  /** Coolify's dispatch('info', …) in place of the success toast. */
  info?: boolean;
}

export async function showHealthCheck(ctx: ApplicationSettingsContext, uuid: string, canUpdate: boolean): Promise<{ application: ApplicationShow; settings: HealthCheckSettings } | null> {
  const l = await loadConfiguration(ctx, uuid, canUpdate);
  // configuration.blade.php: the page is not rendered for a Docker Compose application.
  return l && l.row.build_pack !== "dockercompose" ? { application: l.application, settings: healthCheck(l.row, canUpdate) } : null;
}

/** Only the columns whose value changes. */
function dirty<T extends Record<string, string | number | boolean | null>>(changes: T, row: Record<string, unknown>): Partial<T> {
  const out: Partial<T> = {};
  for (const [column, value] of Object.entries(changes)) if (row[column] !== value) (out as Record<string, unknown>)[column] = value;
  return out;
}

/** HealthChecks::submit() and instantSave(): validate(), then every property to the model. */
export async function saveHealthCheck(ctx: ApplicationSettingsContext, uuid: string, body: Body): Promise<Saved<HealthCheckSettings> | null> {
  const l = await loadConfiguration(ctx, uuid, true);
  if (!l) return null;
  const input = valid(validateHealthCheck(body, healthCheck(l.row, true)));
  await ctx.store.update(
    l.row.id,
    dirty(
      {
        health_check_enabled: input.healthCheckEnabled,
        health_check_type: input.healthCheckType,
        health_check_command: input.healthCheckCommand,
        health_check_method: input.healthCheckMethod,
        health_check_scheme: input.healthCheckScheme,
        health_check_host: input.healthCheckHost,
        health_check_port: input.healthCheckPort,
        health_check_path: input.healthCheckPath,
        health_check_return_code: input.healthCheckReturnCode,
        health_check_response_text: input.healthCheckResponseText,
        health_check_interval: input.healthCheckInterval,
        health_check_timeout: input.healthCheckTimeout,
        health_check_retries: input.healthCheckRetries,
        health_check_start_period: input.healthCheckStartPeriod,
      },
      l.row,
    ),
  );
  return { application: l.application, settings: healthCheck(await reload(ctx, uuid), true), message: APPLICATION_SETTINGS_MESSAGES.healthcheckUpdated };
}

/**
 * HealthChecks::toggleHealthcheck(): the flag flips and is saved without
 * validation. Enabling it on a running application answers Coolify's "restart
 * required" notice in place of the success toast.
 */
export async function toggleHealthCheck(ctx: ApplicationSettingsContext, uuid: string): Promise<Saved<HealthCheckSettings> | null> {
  const l = await loadConfiguration(ctx, uuid, true);
  if (!l) return null;
  const enabled = l.row.health_check_enabled !== true;
  await ctx.store.update(l.row.id, { health_check_enabled: enabled });
  const settings = healthCheck(await reload(ctx, uuid), true);
  if (enabled && l.row.status.startsWith("running")) return { application: l.application, settings, message: APPLICATION_SETTINGS_MESSAGES.healthcheckEnabledRestart, info: true };
  return { application: l.application, settings, message: enabled ? APPLICATION_SETTINGS_MESSAGES.healthcheckEnabled : APPLICATION_SETTINGS_MESSAGES.healthcheckDisabled };
}

// ---------------------------------------------------------------- Resource Limits

export type ResourceLimits = ResourceLimitsInput;

/** The limits_* columns of any resource's row (an application's or a standalone database's). */
export interface ResourceLimitColumns {
  limits_cpus: string;
  limits_cpuset: string | null;
  limits_cpu_shares: number | string;
  limits_memory: string;
  limits_memory_swap: string;
  limits_memory_swappiness: number | string;
  limits_memory_reservation: string;
}

/** ResourceLimits::syncData(false): the form's values from the resource's row. */
export function resourceLimits(row: ResourceLimitColumns): ResourceLimits {
  return {
    limitsCpus: row.limits_cpus,
    limitsCpuset: row.limits_cpuset ?? null,
    limitsCpuShares: Number(row.limits_cpu_shares),
    limitsMemory: row.limits_memory,
    limitsMemorySwap: row.limits_memory_swap,
    limitsMemorySwappiness: Number(row.limits_memory_swappiness),
    limitsMemoryReservation: row.limits_memory_reservation,
  };
}

/**
 * ResourceLimits::submit() for any resource: the defaults, validate() and
 * syncData(true) — the columns whose value changes, for $resource->save().
 */
export function resourceLimitChanges(body: Body, row: ResourceLimitColumns): Partial<Record<keyof ResourceLimitColumns, string | number | null>> {
  const input = valid(validateResourceLimits(body, resourceLimits(row)));
  return dirty(
    {
      limits_cpus: input.limitsCpus,
      limits_cpuset: input.limitsCpuset,
      limits_cpu_shares: input.limitsCpuShares,
      limits_memory: input.limitsMemory,
      limits_memory_swap: input.limitsMemorySwap,
      limits_memory_swappiness: input.limitsMemorySwappiness,
      limits_memory_reservation: input.limitsMemoryReservation,
    },
    row as unknown as Record<string, unknown>,
  );
}

export async function showResourceLimits(ctx: ApplicationSettingsContext, uuid: string, canUpdate: boolean): Promise<{ application: ApplicationShow; settings: ResourceLimits } | null> {
  const l = await loadConfiguration(ctx, uuid, canUpdate);
  return l ? { application: l.application, settings: resourceLimits(l.row) } : null;
}

/** ResourceLimits::submit(): the defaults, validate(), syncData(true), save. */
export async function saveResourceLimits(ctx: ApplicationSettingsContext, uuid: string, body: Body): Promise<Saved<ResourceLimits> | null> {
  const l = await loadConfiguration(ctx, uuid, true);
  if (!l) return null;
  await ctx.store.update(l.row.id, resourceLimitChanges(body, l.row));
  return { application: l.application, settings: resourceLimits(await reload(ctx, uuid)), message: APPLICATION_SETTINGS_MESSAGES.limitsUpdated };
}

// ---------------------------------------------------------------- Advanced

export interface AdvancedSettings extends Record<AdvancedBoolean, boolean> {
  gpuDriver: string;
  gpuCount: string | null;
  gpuDeviceIds: string | null;
  gpuOptions: string | null;
  customInternalName: string | null;
  customContainerNamePrefix: string | null;
  /** '' when no period is set (the default applies). */
  stopGracePeriod: number | null;
  rollingUpdateDrainSeconds: number;
  maxRestartCount: number;
  certificateResolverMode: CertificateResolverMode;
  certificateResolverName: string | null;
}

/** One of $application->maintenanceServers() with what <x-server.gpu-list> shows. */
export interface GpuServer {
  uuid: string;
  name: string;
  functional: boolean;
  /** server_metadata.collected_at */
  collectedAt: string | null;
  /** Server::detectedGpus(): null until the server's metadata was collected. */
  gpus: Array<{ index: string; name: string; memoryMb: number; uuid: string }> | null;
  nvidiaContainerToolkit: boolean;
}

export interface AdvancedPage {
  application: ApplicationShow;
  settings: AdvancedSettings;
  /** $application->git_based() */
  gitBased: boolean;
  /** $application->settings->is_container_label_readonly_enabled */
  labelsManaged: boolean;
  /** The server's proxy is Traefik. */
  isTraefikProxy: boolean;
  /** $server->traefikCertificateResolver() ?? 'none' */
  serverCertificateResolver: string;
  gpuServers: GpuServer[];
}

/** Advanced::COLUMN of each switch. */
const ADVANCED_COLUMNS: Record<AdvancedBoolean, keyof ApplicationSettingsChanges> = {
  disableBuildCache: "disable_build_cache",
  injectBuildArgsToDockerfile: "inject_build_args_to_dockerfile",
  includeSourceCommitInBuild: "include_source_commit_in_build",
  includeNetworkHostsInBuild: "include_network_hosts_in_build",
  isConsistentContainerNameEnabled: "is_consistent_container_name_enabled",
  isLogDrainEnabled: "is_log_drain_enabled",
  isGpuEnabled: "is_gpu_enabled",
  isGzipEnabled: "is_gzip_enabled",
  isStripprefixEnabled: "is_stripprefix_enabled",
};

/** The defaults Advanced::syncData() and the Application accessors fall back on. */
const ADVANCED_DEFAULTS: Record<AdvancedBoolean, boolean> = {
  disableBuildCache: false,
  injectBuildArgsToDockerfile: true,
  includeSourceCommitInBuild: false,
  includeNetworkHostsInBuild: true,
  isConsistentContainerNameEnabled: false,
  isLogDrainEnabled: false,
  isGpuEnabled: false,
  isGzipEnabled: true,
  isStripprefixEnabled: true,
};

/** Advanced::syncData() and syncCertificateResolverFromModel(). */
export function advancedSettings(row: DeployApplicationConfigurationRow): AdvancedSettings {
  const resolver = row.traefik_certificate_resolver;
  const mode: CertificateResolverMode = blank(resolver) ? "server" : resolver === TRAEFIK_CERTIFICATE_RESOLVER_NONE ? "none" : "custom";
  const switches = Object.fromEntries(ADVANCED_BOOLEANS.map((p) => [p, (row[ADVANCED_COLUMNS[p]] as boolean | null) ?? ADVANCED_DEFAULTS[p]])) as Record<AdvancedBoolean, boolean>;
  return {
    ...switches,
    gpuDriver: row.gpu_driver ?? "",
    gpuCount: row.gpu_count ?? null,
    gpuDeviceIds: row.gpu_device_ids ?? null,
    gpuOptions: row.gpu_options ?? null,
    customInternalName: row.custom_internal_name ?? null,
    customContainerNamePrefix: row.custom_container_name_prefix ?? null,
    stopGracePeriod: row.stop_grace_period === null || row.stop_grace_period === undefined ? null : Number(row.stop_grace_period),
    // ApplicationSetting::rollingUpdateDrainSeconds(): clamped to 0…300.
    rollingUpdateDrainSeconds: Math.min(Math.max(Number(row.rolling_update_drain_seconds ?? DEFAULT_ROLLING_UPDATE_DRAIN_SECONDS), 0), MAX_ROLLING_UPDATE_DRAIN_SECONDS),
    maxRestartCount: Number(row.max_restart_count ?? 0),
    certificateResolverMode: mode,
    certificateResolverName: mode === "custom" ? resolver : null,
  };
}

const record = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** The application's server as the GPU subsection lists it (additional servers are not ported). */
function gpuServers(row: DeployApplicationConfigurationRow): GpuServer[] {
  if (row.server_uuid === null) return [];
  const metadata = record(jsonValue(row.server_metadata));
  const detected = metadata?.gpus;
  return [
    {
      uuid: row.server_uuid,
      name: row.server_name ?? "",
      functional: serverIsFunctional(row),
      collectedAt: typeof metadata?.collected_at === "string" ? metadata.collected_at : null,
      gpus: Array.isArray(detected)
        ? detected.map((gpu) => {
            const g = record(gpu) ?? {};
            return { index: String(g.index ?? ""), name: String(g.name ?? ""), memoryMb: Number(g.memory_mb ?? 0), uuid: String(g.uuid ?? "") };
          })
        : null,
      nvidiaContainerToolkit: Boolean(metadata?.nvidia_container_toolkit),
    },
  ];
}

function advancedPage(l: Loaded): AdvancedPage {
  const { row } = l;
  const serverResolver = row.server_traefik_certificate_resolver;
  return {
    application: l.application,
    settings: advancedSettings(row),
    gitBased: !row.has_dockerfile && row.build_pack !== "dockerimage",
    labelsManaged: row.is_container_label_readonly_enabled !== false,
    isTraefikProxy: record(jsonValue(row.server_proxy))?.type === "TRAEFIK",
    serverCertificateResolver: !blank(serverResolver) && serverResolver !== TRAEFIK_CERTIFICATE_RESOLVER_NONE ? serverResolver! : TRAEFIK_CERTIFICATE_RESOLVER_NONE,
    gpuServers: gpuServers(row),
  };
}

export async function showAdvanced(ctx: ApplicationSettingsContext, uuid: string, canUpdate: boolean): Promise<AdvancedPage | null> {
  const l = await loadConfiguration(ctx, uuid, canUpdate);
  return l ? advancedPage(l) : null;
}

export interface AdvancedSaved extends AdvancedPage {
  message: string | null;
}

async function advancedSaved(ctx: ApplicationSettingsContext, l: Loaded, message: string | null): Promise<AdvancedSaved> {
  return { ...advancedPage({ application: l.application, row: await reload(ctx, l.row.uuid) }), message };
}

/** ApplicationSetting::isContainerNamePrefixInUse(): another application of the server is found by that name. */
async function prefixInUse(ctx: ApplicationSettingsContext, row: DeployApplicationConfigurationRow, prefix: string): Promise<boolean> {
  if (row.server_id === null) return false;
  const others = await ctx.store.containerNames(row.server_id);
  return others.some((a) => String(a.id) !== String(row.id) && [a.uuid, a.custom_container_name_prefix, a.custom_internal_name].includes(prefix));
}

/**
 * Advanced::syncData(true) after validate(): a changed container name prefix
 * must be a slug no other application of the server uses
 * (validateChangedContainerNamePrefix), then every given property goes to the
 * settings.
 */
async function syncAdvanced(ctx: ApplicationSettingsContext, row: DeployApplicationConfigurationRow, input: AdvancedInput): Promise<void> {
  const prefix = input.customContainerNamePrefix;
  if (prefix !== undefined && !blank(prefix) && prefix !== row.custom_container_name_prefix) {
    if (!CONTAINER_NAME_PREFIX_PATTERN.test(prefix!)) throw new SettingsFieldErrors({ customContainerNamePrefix: [ADVANCED_MESSAGES.prefixFormat] });
    if (await prefixInUse(ctx, row, prefix!)) throw new SettingsFieldErrors({ customContainerNamePrefix: [ADVANCED_MESSAGES.prefixInUse] });
  }
  const changes: ApplicationSettingsChanges = {};
  for (const p of ADVANCED_BOOLEANS) if (input[p] !== undefined) changes[ADVANCED_COLUMNS[p]] = input[p]!;
  if (input.gpuDriver !== undefined) changes.gpu_driver = input.gpuDriver;
  if (input.gpuCount !== undefined) changes.gpu_count = input.gpuCount;
  if (input.gpuDeviceIds !== undefined) changes.gpu_device_ids = input.gpuDeviceIds;
  if (input.gpuOptions !== undefined) changes.gpu_options = input.gpuOptions;
  if (input.customInternalName !== undefined) changes.custom_internal_name = input.customInternalName;
  if (input.customContainerNamePrefix !== undefined) changes.custom_container_name_prefix = input.customContainerNamePrefix;
  await ctx.store.updateSettings(row.id, dirty(changes as Record<string, string | number | boolean | null>, row));
}

/** Server::isLogDrainEnabled() for the application's server. */
const serverLogDrainEnabled = (row: DeployApplicationConfigurationRow): boolean =>
  Boolean(row.server_is_logdrain_newrelic_enabled) || Boolean(row.server_is_logdrain_axiom_enabled) || Boolean(row.server_is_logdrain_custom_enabled) || Boolean(row.server_is_logdrain_cloudwatch_enabled);

/**
 * Advanced::instantSave() — a listbox changed — or submit() — the GPU form.
 *
 * instantSave: a log drain needs one on the server; without it the switch is
 * saved off with everything else and the answer is Coolify's error. submit:
 * the changed GPU values are checked first (a count or device ids, not both;
 * a count that is a number or "all"; options that parse).
 */
export async function saveAdvanced(ctx: ApplicationSettingsContext, uuid: string, body: Body, instant: boolean): Promise<(AdvancedSaved & { rejected?: string }) | null> {
  const l = await loadConfiguration(ctx, uuid, true);
  if (!l) return null;
  const { row } = l;
  const input = valid(validateAdvanced(body));
  if (instant) {
    const wanted = input.isLogDrainEnabled ?? row.is_log_drain_enabled === true;
    if (wanted && !serverLogDrainEnabled(row)) {
      await syncAdvanced(ctx, row, { ...input, isLogDrainEnabled: false });
      return { ...(await advancedSaved(ctx, l, null)), rejected: APPLICATION_SETTINGS_MESSAGES.logDrainNotEnabled };
    }
  } else {
    const count = input.gpuCount === undefined ? row.gpu_count : input.gpuCount;
    const deviceIds = input.gpuDeviceIds === undefined ? row.gpu_device_ids : input.gpuDeviceIds;
    const options = input.gpuOptions === undefined ? row.gpu_options : input.gpuOptions;
    const selectionChanged = count !== row.gpu_count || deviceIds !== row.gpu_device_ids;
    if (selectionChanged && !blank(count) && !blank(deviceIds)) throw new SettingsFieldErrors({ gpuCount: [ADVANCED_MESSAGES.gpuCountAndDeviceIds] });
    if (count !== row.gpu_count && !blank(count) && !GPU_COUNT_PATTERN.test(count!.trim())) throw new SettingsFieldErrors({ gpuCount: [ADVANCED_MESSAGES.gpuCount] });
    if (options !== row.gpu_options && parseGpuOptions(options) === null) throw new SettingsFieldErrors({ gpuOptions: [ADVANCED_MESSAGES.gpuOptions] });
  }
  await syncAdvanced(ctx, row, input);
  return advancedSaved(ctx, l, APPLICATION_SETTINGS_MESSAGES.settingsSaved);
}

/**
 * Advanced::saveCustomName(): the name as a slug (null when empty), refused
 * when another application of the server has it.
 */
export async function saveCustomName(ctx: ApplicationSettingsContext, uuid: string, body: Body): Promise<AdvancedSaved | null> {
  const l = await loadConfiguration(ctx, uuid, true);
  if (!l) return null;
  const given = body.customInternalName;
  if (given !== undefined && given !== null && typeof given !== "string") throw new SettingsFieldErrors({ customInternalName: ["The custom internal name field must be a string."] });
  const name = typeof given === "string" && given !== "" ? slug(given) || null : null;
  if (name !== null && l.row.server_id !== null) {
    const others = await ctx.store.containerNames(l.row.server_id);
    if (others.some((a) => String(a.id) !== String(l.row.id) && a.custom_internal_name === name)) throw new SettingsFieldErrors({ customInternalName: [ADVANCED_MESSAGES.customNameInUse] });
  }
  await syncAdvanced(ctx, l.row, valid(validateAdvanced({ customInternalName: name })));
  return advancedSaved(ctx, l, APPLICATION_SETTINGS_MESSAGES.customNameSaved);
}

/** Advanced::saveCustomNamePrefix(): the prefix as a slug (null when empty), unique on the server, at most 30 characters. */
export async function saveCustomNamePrefix(ctx: ApplicationSettingsContext, uuid: string, body: Body): Promise<AdvancedSaved | null> {
  const l = await loadConfiguration(ctx, uuid, true);
  if (!l) return null;
  const given = body.customContainerNamePrefix;
  if (given !== undefined && given !== null && typeof given !== "string") throw new SettingsFieldErrors({ customContainerNamePrefix: ["The custom container name prefix field must be a string."] });
  const prefix = typeof given === "string" ? slug(given) || null : null;
  if (prefix !== null && (await prefixInUse(ctx, l.row, prefix))) throw new SettingsFieldErrors({ customContainerNamePrefix: [ADVANCED_MESSAGES.prefixInUse] });
  await syncAdvanced(ctx, l.row, valid(validateAdvanced({ customContainerNamePrefix: prefix })));
  return advancedSaved(ctx, l, APPLICATION_SETTINGS_MESSAGES.prefixSaved);
}

/** Advanced::saveCertificateResolver(): null for the server's resolver, "none", or the custom resolver's name. */
export async function saveCertificateResolver(ctx: ApplicationSettingsContext, uuid: string, body: Body): Promise<AdvancedSaved | null> {
  const l = await loadConfiguration(ctx, uuid, true);
  if (!l) return null;
  const { mode, name } = valid(validateCertificateResolver(body));
  const resolver = mode === "none" ? TRAEFIK_CERTIFICATE_RESOLVER_NONE : mode === "custom" ? name : null;
  await ctx.store.updateSettings(l.row.id, dirty({ traefik_certificate_resolver: resolver }, l.row));
  return advancedSaved(ctx, l, APPLICATION_SETTINGS_MESSAGES.resolverSaved);
}

/** Advanced::saveStopGracePeriod() */
export async function saveStopGracePeriod(ctx: ApplicationSettingsContext, uuid: string, body: Body): Promise<AdvancedSaved | null> {
  const l = await loadConfiguration(ctx, uuid, true);
  if (!l) return null;
  await ctx.store.updateSettings(l.row.id, dirty({ stop_grace_period: valid(validateStopGracePeriod(body)) }, l.row));
  return advancedSaved(ctx, l, APPLICATION_SETTINGS_MESSAGES.stopGracePeriodUpdated);
}

/** Advanced::saveRollingUpdateDrainSeconds() */
export async function saveRollingUpdateDrainSeconds(ctx: ApplicationSettingsContext, uuid: string, body: Body): Promise<AdvancedSaved | null> {
  const l = await loadConfiguration(ctx, uuid, true);
  if (!l) return null;
  await ctx.store.updateSettings(l.row.id, dirty({ rolling_update_drain_seconds: valid(validateRollingUpdateDrainSeconds(body)) }, l.row));
  return advancedSaved(ctx, l, APPLICATION_SETTINGS_MESSAGES.drainUpdated);
}

/** Advanced::saveMaxRestartCount(): the one setting of this page kept on the application itself. */
export async function saveMaxRestartCount(ctx: ApplicationSettingsContext, uuid: string, body: Body): Promise<AdvancedSaved | null> {
  const l = await loadConfiguration(ctx, uuid, true);
  if (!l) return null;
  await ctx.store.update(l.row.id, dirty({ max_restart_count: valid(validateMaxRestartCount(body)) }, l.row));
  return advancedSaved(ctx, l, APPLICATION_SETTINGS_MESSAGES.maxRestartCountSaved);
}

/**
 * Advanced::refreshGpus(): needs a functional server, then collects the
 * server's metadata over SSH — not available yet (501). Null when the
 * application is not the org's.
 */
export async function refreshGpus(ctx: ApplicationSettingsContext, uuid: string): Promise<null> {
  const row = await ctx.store.configuration(uuid);
  if (!row) return null;
  if (!serverIsFunctional(row)) throw new SettingsError(APPLICATION_SETTINGS_MESSAGES.validateServerFirst, 422);
  throw new SettingsError(APPLICATION_SETTINGS_MESSAGES.refreshGpusUnavailable, 501);
}
