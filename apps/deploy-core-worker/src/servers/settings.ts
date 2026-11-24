// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Server/{Advanced,DockerCleanup,LogDrains,Swarm,Sentinel}.php,
// app/Livewire/Server/Sentinel/Show.php, app/Models/ServerSetting.php (generateSentinelToken,
// restoreDefaultSentinelConfiguration, DEFAULT_*) and app/Models/Server.php (sentinelStatus,
// waitBeforeDoingSshCheck, firstSentinelReportTimeoutSeconds, isLogDrainEnabled) (Apache-2.0), modified.
//
// The server settings pages that only read and write deploy.server_settings.
// Saving works as in Coolify; what Coolify then does on the server (start or
// stop the log drain, restart Sentinel, run a cleanup) needs the SSH executor:
// the save is kept and the answer says that action is not available yet,
// except a log drain's enabled flags, which roll back as Coolify's do on failure.
import type { DeployServerRow, DeployServerSettingsRow, ServerSettingsPageChanges } from "@saas/db/deploy";
import { isFunctional, isSentinelEnabled, ServerError, serverShow, type ServerShow } from "./service.js";
import {
  SETTINGS_MESSAGES,
  SENTINEL_TOKEN_RE,
  translateCronExpression,
  validateCronExpression,
  type AdvancedInput,
  type DockerCleanupInput,
  type LogDrainsInput,
  type SentinelInput,
  type SwarmInput,
} from "./settings-validation.js";

/** Encrypts and decrypts one column's values with the org's data key ("server_settings.<column>"). */
export interface FieldCipher {
  encrypt(column: string, plaintext: string): Promise<string>;
  decrypt(column: string, stored: string): Promise<string>;
}

export interface ServerSettingsStore {
  findServer(uuid: string): Promise<DeployServerRow | null>;
  settings(serverId: string | number): Promise<DeployServerSettingsRow | null>;
  update(serverId: string | number, changes: ServerSettingsPageChanges): Promise<boolean>;
  usesSwarm(): Promise<boolean>;
}

export interface ServerSettingsContext {
  store: ServerSettingsStore;
  cipher: FieldCipher;
}

/** The encrypted columns: Coolify's `encrypted` casts, and the log drain keys (Freeploy's). */
export const ENCRYPTED_SETTINGS = ["sentinel_token", "logdrain_custom_config", "logdrain_newrelic_license_key", "logdrain_axiom_api_key"] as const;

/** Copy shown to the user: Coolify's, word for word, then Freeploy's for what needs SSH. */
export const SETTINGS_SERVICE_MESSAGES = {
  serverUpdated: "Server updated.",
  settingsSaved: "Settings saved.",
  swarmUpdated: "Swarm settings updated.",
  sentinelUpdated: "Sentinel settings updated.",
  tokenRegenerated: "Token regenerated.",
  defaultsRestored: "Default Sentinel configuration restored.",
  /** Freeploy's: the SSH executor is not deployed yet. */
  cleanupUnavailable: "Running Docker cleanup needs the SSH executor, which is not available yet.",
  logDrainStartUnavailable: "Starting the log drain needs the SSH executor, which is not available yet.",
  logDrainStopUnavailable: "Stopping the log drain needs the SSH executor, which is not available yet.",
  sentinelRestartUnavailable: "Restarting Sentinel needs the SSH executor, which is not available yet.",
} as const;

/** ServerSetting::DEFAULT_* */
export const SENTINEL_DEFAULTS = { refreshRateSeconds: 10, historyDays: 7, pushIntervalSeconds: 60 } as const;
export const DEFAULT_AXIOM_DOMAIN = "us-east-1.aws.edge.axiom.co";

/** A saved section: the page's data, and the server action Coolify would run next, when there is one. */
export interface Saved<T> {
  settings: T;
  message: string | null;
  /** Why the action that follows the save in Coolify did not run. */
  unavailable: string | null;
  /** The action failed as Coolify's would: answered as an error (501), the save rolled back as Coolify rolls it back. */
  failed?: boolean;
}

interface Loaded {
  server: DeployServerRow;
  settings: DeployServerSettingsRow;
}

async function load(ctx: ServerSettingsContext, uuid: string): Promise<Loaded | null> {
  const server = await ctx.store.findServer(uuid);
  if (!server) return null;
  const settings = await ctx.store.settings(server.id);
  return settings ? { server, settings } : null;
}

/** A stored ciphertext as plaintext; null when empty or it does not decrypt. */
async function reveal(ctx: ServerSettingsContext, column: string, stored: string | null): Promise<string | null> {
  if (stored === null || stored === "") return null;
  try {
    return await ctx.cipher.decrypt(`server_settings.${column}`, stored);
  } catch {
    return null;
  }
}

async function seal(ctx: ServerSettingsContext, column: string, value: string | null): Promise<string | null> {
  return value === null || value === "" ? null : ctx.cipher.encrypt(`server_settings.${column}`, value);
}

const num = (v: number | string) => Number(v);

// ---------------------------------------------------------------- Advanced

export type AdvancedSettings = AdvancedInput;

function advanced(s: DeployServerSettingsRow): AdvancedSettings {
  return {
    concurrentBuilds: num(s.concurrent_builds),
    dynamicTimeout: num(s.dynamic_timeout),
    deploymentQueueLimit: num(s.deployment_queue_limit),
    backupCompressionCpuPercentage: num(s.backup_compression_cpu_percentage),
    serverDiskUsageNotificationThreshold: num(s.server_disk_usage_notification_threshold),
    serverDiskUsageCheckFrequency: s.server_disk_usage_check_frequency,
    serverDiskUsageNotificationIntervalHours: num(s.server_disk_usage_notification_interval_hours),
  };
}

export async function showAdvanced(ctx: ServerSettingsContext, uuid: string): Promise<{ server: ServerShow; settings: AdvancedSettings } | null> {
  const l = await load(ctx, uuid);
  return l ? { server: serverShow(l.server), settings: advanced(l.settings) } : null;
}

/** Advanced::submit() (the cron check first) and instantSave() (without it). */
export async function saveAdvanced(ctx: ServerSettingsContext, uuid: string, input: AdvancedInput, instant: boolean): Promise<Saved<AdvancedSettings> | null> {
  const l = await load(ctx, uuid);
  if (!l) return null;
  if (!instant && !validateCronExpression(input.serverDiskUsageCheckFrequency)) throw new ServerError(SETTINGS_MESSAGES.invalidDiskUsageCron);
  await ctx.store.update(l.server.id, {
    concurrent_builds: input.concurrentBuilds,
    dynamic_timeout: input.dynamicTimeout,
    deployment_queue_limit: input.deploymentQueueLimit,
    backup_compression_cpu_percentage: input.backupCompressionCpuPercentage,
    server_disk_usage_notification_threshold: input.serverDiskUsageNotificationThreshold,
    server_disk_usage_check_frequency: input.serverDiskUsageCheckFrequency,
    server_disk_usage_notification_interval_hours: input.serverDiskUsageNotificationIntervalHours,
  });
  const after = (await ctx.store.settings(l.server.id))!;
  return { settings: advanced(after), message: SETTINGS_SERVICE_MESSAGES.serverUpdated, unavailable: null };
}

// ---------------------------------------------------------------- Docker Cleanup

export interface DockerCleanupSettings {
  dockerCleanupFrequency: string;
  dockerCleanupThreshold: number;
  forceDockerCleanup: boolean;
  deleteUnusedVolumes: boolean;
  deleteUnusedNetworks: boolean;
  disableApplicationImageRetention: boolean;
  /** isCleanupStale / lastExecutionTime: no cleanup has run, so there is no execution yet. */
  isCleanupStale: boolean;
  lastExecutionTime: string | null;
}

function dockerCleanup(s: DeployServerSettingsRow): DockerCleanupSettings {
  return {
    // The docker_cleanup_frequency accessor translates a preset.
    dockerCleanupFrequency: translateCronExpression(s.docker_cleanup_frequency),
    dockerCleanupThreshold: num(s.docker_cleanup_threshold),
    forceDockerCleanup: Boolean(s.force_docker_cleanup),
    deleteUnusedVolumes: Boolean(s.delete_unused_volumes),
    deleteUnusedNetworks: Boolean(s.delete_unused_networks),
    disableApplicationImageRetention: Boolean(s.disable_application_image_retention),
    isCleanupStale: false,
    lastExecutionTime: null,
  };
}

export async function showDockerCleanup(ctx: ServerSettingsContext, uuid: string): Promise<{ server: ServerShow; settings: DockerCleanupSettings } | null> {
  const l = await load(ctx, uuid);
  return l ? { server: serverShow(l.server), settings: dockerCleanup(l.settings) } : null;
}

/** DockerCleanup::submit() (the cron check first) and instantSave() (without it). */
export async function saveDockerCleanup(ctx: ServerSettingsContext, uuid: string, input: DockerCleanupInput, instant: boolean): Promise<Saved<DockerCleanupSettings> | null> {
  const l = await load(ctx, uuid);
  if (!l) return null;
  if (!instant && !validateCronExpression(input.dockerCleanupFrequency)) throw new ServerError(SETTINGS_MESSAGES.invalidDockerCleanupCron);
  await ctx.store.update(l.server.id, {
    force_docker_cleanup: input.forceDockerCleanup,
    // The docker_cleanup_frequency mutator translates a preset.
    docker_cleanup_frequency: translateCronExpression(input.dockerCleanupFrequency),
    docker_cleanup_threshold: input.dockerCleanupThreshold,
    delete_unused_volumes: input.deleteUnusedVolumes,
    delete_unused_networks: input.deleteUnusedNetworks,
    disable_application_image_retention: input.disableApplicationImageRetention,
  });
  const after = (await ctx.store.settings(l.server.id))!;
  return { settings: dockerCleanup(after), message: SETTINGS_SERVICE_MESSAGES.serverUpdated, unavailable: null };
}

/** DockerCleanup::manualCleanup(): dispatches DockerCleanupJob, which runs over SSH. */
export async function runDockerCleanup(ctx: ServerSettingsContext, uuid: string): Promise<boolean> {
  const server = await ctx.store.findServer(uuid);
  if (!server) return false;
  throw new ServerError(SETTINGS_SERVICE_MESSAGES.cleanupUnavailable, null, 501);
}

// ---------------------------------------------------------------- Log Drains

export interface LogDrainSettings extends LogDrainsInput {
  /** Server::isLogDrainEnabled() */
  isLogDrainEnabled: boolean;
}

const isLogDrainEnabled = (s: Pick<DeployServerSettingsRow, "is_logdrain_newrelic_enabled" | "is_logdrain_axiom_enabled" | "is_logdrain_custom_enabled" | "is_logdrain_cloudwatch_enabled">) =>
  Boolean(s.is_logdrain_newrelic_enabled || s.is_logdrain_axiom_enabled || s.is_logdrain_custom_enabled || s.is_logdrain_cloudwatch_enabled);

/**
 * LogDrains::syncData(false): the license key, API key and Fluent Bit
 * configuration only for who may update the server (auth()->user()->can('update')).
 */
async function logDrains(ctx: ServerSettingsContext, s: DeployServerSettingsRow, canUpdate: boolean): Promise<LogDrainSettings> {
  const secret = async (column: "logdrain_newrelic_license_key" | "logdrain_axiom_api_key" | "logdrain_custom_config") => (canUpdate ? reveal(ctx, column, s[column]) : null);
  return {
    isLogDrainNewRelicEnabled: Boolean(s.is_logdrain_newrelic_enabled),
    logDrainNewRelicLicenseKey: await secret("logdrain_newrelic_license_key"),
    logDrainNewRelicBaseUri: s.logdrain_newrelic_base_uri,
    isLogDrainAxiomEnabled: Boolean(s.is_logdrain_axiom_enabled),
    logDrainAxiomDatasetName: s.logdrain_axiom_dataset_name,
    logDrainAxiomDomain: s.logdrain_axiom_domain || DEFAULT_AXIOM_DOMAIN,
    logDrainAxiomApiKey: await secret("logdrain_axiom_api_key"),
    isLogDrainCustomEnabled: Boolean(s.is_logdrain_custom_enabled),
    logDrainCustomConfig: await secret("logdrain_custom_config"),
    logDrainCustomConfigParser: canUpdate ? s.logdrain_custom_config_parser : null,
    isLogDrainCloudwatchEnabled: Boolean(s.is_logdrain_cloudwatch_enabled),
    logDrainCloudwatchRegion: s.logdrain_cloudwatch_region,
    logDrainCloudwatchGroup: s.logdrain_cloudwatch_group,
    logDrainCloudwatchStreamPrefix: s.logdrain_cloudwatch_stream_prefix,
    isLogDrainEnabled: isLogDrainEnabled(s),
  };
}

/** The stored enabled flags, for the flags a save leaves out. */
export async function logDrainFlags(ctx: ServerSettingsContext, uuid: string): Promise<Record<"isLogDrainNewRelicEnabled" | "isLogDrainAxiomEnabled" | "isLogDrainCustomEnabled" | "isLogDrainCloudwatchEnabled", boolean> | null> {
  const l = await load(ctx, uuid);
  if (!l) return null;
  const s = l.settings;
  return {
    isLogDrainNewRelicEnabled: Boolean(s.is_logdrain_newrelic_enabled),
    isLogDrainAxiomEnabled: Boolean(s.is_logdrain_axiom_enabled),
    isLogDrainCustomEnabled: Boolean(s.is_logdrain_custom_enabled),
    isLogDrainCloudwatchEnabled: Boolean(s.is_logdrain_cloudwatch_enabled),
  };
}

export async function showLogDrains(ctx: ServerSettingsContext, uuid: string, canUpdate: boolean): Promise<{ server: ServerShow; settings: LogDrainSettings } | null> {
  const l = await load(ctx, uuid);
  return l ? { server: serverShow(l.server), settings: await logDrains(ctx, l.settings, canUpdate) } : null;
}

/**
 * LogDrains::submit() ('Settings saved.') and instantSave() (the Status
 * listboxes): every drain's fields saved, after customValidation(). instantSave
 * then starts or stops the log drain on the server, which needs SSH: as
 * toggleLogDrain() does when that action fails, the enabled flags stay as they
 * were stored (the other fields are kept) and the answer is the failure, so a
 * drain never reads Enabled while nothing runs.
 */
export async function saveLogDrains(ctx: ServerSettingsContext, uuid: string, input: LogDrainsInput, instant: boolean): Promise<Saved<LogDrainSettings> | null> {
  const l = await load(ctx, uuid);
  if (!l) return null;
  const flags = instant
    ? {}
    : {
        is_logdrain_newrelic_enabled: input.isLogDrainNewRelicEnabled,
        is_logdrain_axiom_enabled: input.isLogDrainAxiomEnabled,
        is_logdrain_custom_enabled: input.isLogDrainCustomEnabled,
        is_logdrain_cloudwatch_enabled: input.isLogDrainCloudwatchEnabled,
      };
  await ctx.store.update(l.server.id, {
    ...flags,
    logdrain_newrelic_license_key: await seal(ctx, "logdrain_newrelic_license_key", input.logDrainNewRelicLicenseKey),
    logdrain_newrelic_base_uri: input.logDrainNewRelicBaseUri,
    logdrain_axiom_dataset_name: input.logDrainAxiomDatasetName,
    logdrain_axiom_api_key: await seal(ctx, "logdrain_axiom_api_key", input.logDrainAxiomApiKey),
    logdrain_axiom_domain: input.logDrainAxiomDomain,
    logdrain_custom_config: await seal(ctx, "logdrain_custom_config", input.logDrainCustomConfig),
    logdrain_custom_config_parser: input.logDrainCustomConfigParser,
    logdrain_cloudwatch_region: input.logDrainCloudwatchRegion,
    logdrain_cloudwatch_group: input.logDrainCloudwatchGroup,
    logdrain_cloudwatch_stream_prefix: input.logDrainCloudwatchStreamPrefix,
  });
  const after = (await ctx.store.settings(l.server.id))!;
  const settings = await logDrains(ctx, after, true);
  if (!instant) return { settings, message: SETTINGS_SERVICE_MESSAGES.settingsSaved, unavailable: null };
  const enabling = input.isLogDrainNewRelicEnabled || input.isLogDrainAxiomEnabled || input.isLogDrainCustomEnabled || input.isLogDrainCloudwatchEnabled;
  return { settings, message: null, unavailable: enabling ? SETTINGS_SERVICE_MESSAGES.logDrainStartUnavailable : SETTINGS_SERVICE_MESSAGES.logDrainStopUnavailable, failed: true };
}

// ---------------------------------------------------------------- Swarm

export interface SwarmSettings {
  isSwarmManager: boolean;
  isSwarmWorker: boolean;
  /** Team::usesSwarm() */
  canUseSwarm: boolean;
}

export async function showSwarm(ctx: ServerSettingsContext, uuid: string): Promise<{ server: ServerShow; settings: SwarmSettings } | null> {
  const l = await load(ctx, uuid);
  if (!l) return null;
  return { server: serverShow(l.server), settings: { isSwarmManager: Boolean(l.settings.is_swarm_manager), isSwarmWorker: Boolean(l.settings.is_swarm_worker), canUseSwarm: await ctx.store.usesSwarm() } };
}

/** Swarm::instantSave(): only an org that already uses Swarm may change the roles. */
export async function saveSwarm(ctx: ServerSettingsContext, uuid: string, input: SwarmInput): Promise<Saved<SwarmSettings> | null> {
  const l = await load(ctx, uuid);
  if (!l) return null;
  if (!(await ctx.store.usesSwarm())) throw new ServerError(SETTINGS_MESSAGES.swarmDeprecated);
  await ctx.store.update(l.server.id, { is_swarm_manager: input.isSwarmManager, is_swarm_worker: input.isSwarmWorker });
  const after = (await ctx.store.settings(l.server.id))!;
  return {
    settings: { isSwarmManager: Boolean(after.is_swarm_manager), isSwarmWorker: Boolean(after.is_swarm_worker), canUseSwarm: await ctx.store.usesSwarm() },
    message: SETTINGS_SERVICE_MESSAGES.swarmUpdated,
    unavailable: null,
  };
}

// ---------------------------------------------------------------- Sentinel

export type SentinelStatus = "restarting" | "waiting" | "in_sync" | "out_of_sync";

export interface SentinelSettings {
  isMetricsEnabled: boolean;
  sentinelToken: string;
  sentinelCustomUrl: string | null;
  isSentinelDebugEnabled: boolean;
  sentinelUpdatedAt: string | null;
  sentinelStatus: SentinelStatus;
}

/** A TIMESTAMP WITHOUT TIME ZONE (UTC wall clock) in epoch milliseconds. */
function epoch(v: string | Date | null): number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(" ", "T")}Z`);
  return Number.isNaN(t) ? null : t;
}

/** Server::sentinelStatus(). */
export function sentinelStatus(s: Pick<DeployServerSettingsRow, "sentinel_waiting_since" | "sentinel_updated_at" | "sentinel_push_interval_seconds">, now = Date.now()): SentinelStatus {
  const push = num(s.sentinel_push_interval_seconds);
  const waiting = epoch(s.sentinel_waiting_since);
  if (waiting !== null) return waiting > now - Math.max(30, push + 30) * 1000 ? "waiting" : "out_of_sync";
  const updated = epoch(s.sentinel_updated_at);
  return updated !== null && updated > now - Math.max(120, push * 3) * 1000 ? "in_sync" : "out_of_sync";
}

/** ServerSetting::generateSentinelToken(): Freeploy's is 32 random bytes, base64 (the token pattern's alphabet). */
export function generateSentinelToken(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

/**
 * ServerSetting::ensureValidSentinelToken(): the stored token, or a new one
 * saved when it is missing, does not decrypt or is not a valid token.
 */
async function ensureSentinelToken(ctx: ServerSettingsContext, l: Loaded): Promise<string> {
  const token = await reveal(ctx, "sentinel_token", l.settings.sentinel_token);
  if (token !== null && SENTINEL_TOKEN_RE.test(token)) return token;
  const fresh = generateSentinelToken();
  await ctx.store.update(l.server.id, { sentinel_token: await seal(ctx, "sentinel_token", fresh) });
  return fresh;
}

async function sentinel(ctx: ServerSettingsContext, l: Loaded): Promise<SentinelSettings> {
  const s = l.settings;
  const updated = epoch(s.sentinel_updated_at);
  return {
    isMetricsEnabled: Boolean(s.is_metrics_enabled),
    sentinelToken: await ensureSentinelToken(ctx, l),
    sentinelCustomUrl: s.sentinel_custom_url,
    isSentinelDebugEnabled: Boolean(s.is_sentinel_debug_enabled),
    sentinelUpdatedAt: updated === null ? null : new Date(updated).toISOString(),
    sentinelStatus: sentinelStatus(s),
  };
}

export interface SentinelPage {
  server: ServerShow;
  settings: SentinelSettings | null;
  /** Server::isSentinelEnabled(): the Connection section. */
  isSentinelEnabled: boolean;
}

/** Sentinel/Show and Sentinel::mount(): the Sentinel form only for a functional server. */
export async function showSentinel(ctx: ServerSettingsContext, uuid: string): Promise<SentinelPage | null> {
  const l = await load(ctx, uuid);
  if (!l) return null;
  return { server: serverShow(l.server), settings: isFunctional(l.server) ? await sentinel(ctx, l) : null, isSentinelEnabled: isSentinelEnabled(l.server) };
}

async function reload(ctx: ServerSettingsContext, l: Loaded): Promise<SentinelSettings> {
  return sentinel(ctx, { server: l.server, settings: (await ctx.store.settings(l.server.id))! });
}

/**
 * Sentinel::submit() ('Sentinel settings updated. Restarting Sentinel.') and
 * instantSave() ('Restarting Sentinel.' when a setting changed). Saving
 * restarts Sentinel in Coolify (ServerSetting::booted()); that needs SSH.
 */
export async function saveSentinel(ctx: ServerSettingsContext, uuid: string, input: SentinelInput, instant: boolean): Promise<Saved<SentinelSettings> | null> {
  const l = await load(ctx, uuid);
  if (!l) return null;
  const before = await sentinel(ctx, l);
  const metrics = input.isMetricsEnabled ?? before.isMetricsEnabled;
  const debug = input.isSentinelDebugEnabled ?? before.isSentinelDebugEnabled;
  const changed = metrics !== before.isMetricsEnabled || debug !== before.isSentinelDebugEnabled || input.sentinelToken !== before.sentinelToken || input.sentinelCustomUrl !== before.sentinelCustomUrl;
  await ctx.store.update(l.server.id, {
    is_metrics_enabled: metrics,
    sentinel_token: await seal(ctx, "sentinel_token", input.sentinelToken),
    sentinel_custom_url: input.sentinelCustomUrl,
    is_sentinel_debug_enabled: debug,
  });
  const settings = await reload(ctx, l);
  if (instant) return { settings, message: null, unavailable: changed ? SETTINGS_SERVICE_MESSAGES.sentinelRestartUnavailable : null };
  return { settings, message: SETTINGS_SERVICE_MESSAGES.sentinelUpdated, unavailable: SETTINGS_SERVICE_MESSAGES.sentinelRestartUnavailable };
}

/** Sentinel::regenerateSentinelToken(): a new token saved; restarting Sentinel needs SSH. */
export async function regenerateSentinelToken(ctx: ServerSettingsContext, uuid: string): Promise<Saved<SentinelSettings> | null> {
  const l = await load(ctx, uuid);
  if (!l) return null;
  await ctx.store.update(l.server.id, { sentinel_token: await seal(ctx, "sentinel_token", generateSentinelToken()) });
  return { settings: await reload(ctx, l), message: SETTINGS_SERVICE_MESSAGES.tokenRegenerated, unavailable: SETTINGS_SERVICE_MESSAGES.sentinelRestartUnavailable };
}

/**
 * Sentinel::restoreDefaultConfiguration() → restoreDefaultSentinelConfiguration():
 * the collection defaults and debug off; the token and the metrics setting
 * stay. Coolify regenerates the URL from the instance's; Freeploy has no
 * Sentinel endpoint yet, so the URL is cleared. Restarting Sentinel needs SSH.
 */
export async function restoreSentinelDefaults(ctx: ServerSettingsContext, uuid: string): Promise<Saved<SentinelSettings> | null> {
  const l = await load(ctx, uuid);
  if (!l) return null;
  await ctx.store.update(l.server.id, {
    sentinel_custom_url: null,
    sentinel_metrics_refresh_rate_seconds: SENTINEL_DEFAULTS.refreshRateSeconds,
    sentinel_metrics_history_days: SENTINEL_DEFAULTS.historyDays,
    sentinel_push_interval_seconds: SENTINEL_DEFAULTS.pushIntervalSeconds,
    is_sentinel_debug_enabled: false,
  });
  return { settings: await reload(ctx, l), message: SETTINGS_SERVICE_MESSAGES.defaultsRestored, unavailable: SETTINGS_SERVICE_MESSAGES.sentinelRestartUnavailable };
}

/** Sentinel::restartSentinel() (the Restart / Sync button): needs SSH. */
export async function restartSentinel(ctx: ServerSettingsContext, uuid: string): Promise<boolean> {
  const server = await ctx.store.findServer(uuid);
  if (!server) return false;
  throw new ServerError(SETTINGS_SERVICE_MESSAGES.sentinelRestartUnavailable, null, 501);
}
