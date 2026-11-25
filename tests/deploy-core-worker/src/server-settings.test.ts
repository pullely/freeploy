// Server settings pages (DP-42): Advanced, Docker Cleanup, Log Drains, Swarm
// and Sentinel — Coolify's rules and messages, what each save stores (the
// secrets encrypted), what needs SSH answering "not available yet", and the
// routing and authorization through handleServers. The SQL behind the store
// is tested in tests/db.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { handleServers, type ServerRunner } from "@deploy-core-worker/handlers/servers";
import type { ServerSettingsRunner } from "@deploy-core-worker/handlers/server-settings";
import type { FieldCipher, ServerSettingsStore } from "@deploy-core-worker/servers/settings";
import { sentinelStatus } from "@deploy-core-worker/servers/settings";
import {
  attribute,
  fluentBitConfigError,
  validateAdvanced,
  validateCronExpression,
  validateDockerCleanup,
  validateLogDrains,
  validateSentinel,
} from "@deploy-core-worker/servers/settings-validation";
import type { DeployServerRow, DeployServerSettingsRow, ServerSettingsPageChanges } from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy/servers`;
const UUID = "srvaaaaaaaaaaaaaaaaaaaaa";
const actor = { subjectId: "usr_1", subjectType: "user" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

function serverRow(over: Partial<DeployServerRow> = {}): DeployServerRow {
  return {
    id: 1, uuid: UUID, name: "prod-1", description: null, ip: "203.0.113.10", port: 22, user: "root", private_key_id: 100, private_key_uuid: null,
    proxy: {}, validation_logs: null, server_metadata: null, is_validating: false, hetzner_server_id: null, vultr_instance_id: null,
    hostinger_virtual_machine_id: null, created_at: null, updated_at: null, settings_id: 1, is_reachable: true, is_usable: true, force_disabled: false,
    is_swarm_manager: false, is_swarm_worker: false, is_build_server: false, server_role: "both", connection_timeout: 10, wildcard_domain: null,
    public_ipv4: null, public_ipv6: null, server_timezone: "UTC", is_metrics_enabled: false, is_sentinel_enabled: true, is_image_scan_enabled: false,
    ssh_host_key_pending: null, is_cloudflare_tunnel: false, org_uses_swarm: false,
    ...over,
  };
}

/** deploy.server_settings' column defaults (500_deploy_core). */
function settingsRow(): DeployServerSettingsRow {
  return {
    concurrent_builds: 2, dynamic_timeout: 3600, deployment_queue_limit: 25, backup_compression_cpu_percentage: 25, server_disk_usage_notification_threshold: 80,
    server_disk_usage_check_frequency: "0 23 * * *", server_disk_usage_notification_interval_hours: 24, force_docker_cleanup: true, docker_cleanup_frequency: "0 0 * * *",
    docker_cleanup_threshold: 80, delete_unused_volumes: false, delete_unused_networks: false, disable_application_image_retention: false,
    is_logdrain_newrelic_enabled: false, logdrain_newrelic_license_key: null, logdrain_newrelic_base_uri: null, is_logdrain_axiom_enabled: false,
    logdrain_axiom_dataset_name: null, logdrain_axiom_api_key: null, logdrain_axiom_domain: "us-east-1.aws.edge.axiom.co", is_logdrain_custom_enabled: false,
    logdrain_custom_config: null, logdrain_custom_config_parser: null, is_logdrain_cloudwatch_enabled: false, logdrain_cloudwatch_region: null,
    logdrain_cloudwatch_group: null, logdrain_cloudwatch_stream_prefix: null, is_swarm_manager: false, is_swarm_worker: false, is_metrics_enabled: false,
    sentinel_token: null, sentinel_custom_url: null, is_sentinel_debug_enabled: false, sentinel_metrics_refresh_rate_seconds: 10, sentinel_metrics_history_days: 7,
    sentinel_push_interval_seconds: 60, sentinel_updated_at: "2026-01-01 00:00:00", sentinel_waiting_since: null,
  };
}

class MemoryStore implements ServerSettingsStore {
  server = serverRow();
  row = settingsRow();
  swarm = false;
  async findServer(uuid: string) {
    return uuid === this.server.uuid ? this.server : null;
  }
  async settings(id: string | number) {
    return id === this.server.id ? { ...this.row } : null;
  }
  async update(id: string | number, changes: ServerSettingsPageChanges) {
    if (id !== this.server.id) return false;
    for (const [k, v] of Object.entries(changes)) if (v !== undefined) (this.row as Record<string, unknown>)[k] = v;
    return true;
  }
  async usesSwarm() {
    return this.swarm || this.row.is_swarm_manager || this.row.is_swarm_worker;
  }
}

/** Binds each value to its column, as the GCM additional data does. */
const cipher: FieldCipher = {
  encrypt: async (column, p) => `enc:${column}:${p}`,
  decrypt: async (column, s) => {
    if (!s.startsWith(`enc:${column}:`)) throw new Error("wrong column");
    return s.slice(`enc:${column}:`.length);
  },
};

type Body = { data?: Record<string, unknown> & { settings?: Record<string, unknown> }; error?: { code: string; message: string; details: { fields?: Record<string, string[]> } } };

function setup(opts: { write?: boolean; read?: boolean } = {}) {
  const store = new MemoryStore();
  const asked: string[] = [];
  const env: Env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      asked.push(body.action);
      const allow = body.action === "deploy.resource.write" ? (opts.write ?? true) : (opts.read ?? true);
      return json({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
  };
  const orgs: string[] = [];
  const runner: ServerRunner = async () => {
    throw new Error("the servers runner is not used by the settings routes");
  };
  const settingsRunner: ServerSettingsRunner = async (_env, orgId, fn) => {
    orgs.push(orgId);
    return fn({ store, cipher });
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleServers(env, "req_1", actor, ORG_UUID, path.split("/").filter(Boolean), new Request(`${BASE}/${path}`, init), runner, settingsRunner);
    return { status: res.status, body: (await res.json()) as Body };
  };
  return { store, asked, orgs, call };
}

const advanced = (over: Record<string, unknown> = {}) => ({
  serverDiskUsageCheckFrequency: "0 23 * * *",
  serverDiskUsageNotificationThreshold: "50",
  serverDiskUsageNotificationIntervalHours: "24",
  concurrentBuilds: "4",
  dynamicTimeout: "1800",
  deploymentQueueLimit: "10",
  backupCompressionCpuPercentage: 50,
  ...over,
});

const drains = (over: Record<string, unknown> = {}) => ({
  isLogDrainNewRelicEnabled: false,
  isLogDrainAxiomEnabled: false,
  isLogDrainCustomEnabled: false,
  isLogDrainCloudwatchEnabled: false,
  logDrainNewRelicLicenseKey: "",
  logDrainNewRelicBaseUri: "",
  logDrainAxiomDatasetName: "",
  logDrainAxiomApiKey: "",
  logDrainAxiomDomain: "us-east-1.aws.edge.axiom.co",
  logDrainCustomConfig: "",
  logDrainCustomConfigParser: "",
  logDrainCloudwatchRegion: "",
  logDrainCloudwatchGroup: "",
  logDrainCloudwatchStreamPrefix: "",
  ...over,
});
const FLAGS = { isLogDrainNewRelicEnabled: false, isLogDrainAxiomEnabled: false, isLogDrainCustomEnabled: false, isLogDrainCloudwatchEnabled: false };
const errorsOf = (r: { ok: boolean } & ({ ok: true } | { ok: false; errors: Record<string, string[]> })) => (r.ok ? {} : r.errors);

describe("rules and messages (Laravel's defaults with the Livewire property as attribute)", () => {
  it("names attributes as Laravel does", () => {
    expect(attribute("logDrainNewRelicBaseUri")).toBe("log drain new relic base uri");
    expect(attribute("serverDiskUsageNotificationIntervalHours")).toBe("server disk usage notification interval hours");
  });

  it("Advanced: required, integer, min, max, in", () => {
    expect(errorsOf(validateAdvanced(advanced({ concurrentBuilds: "", serverDiskUsageNotificationThreshold: "100", serverDiskUsageNotificationIntervalHours: "0", dynamicTimeout: "1.5", backupCompressionCpuPercentage: 30 })))).toEqual({
      concurrentBuilds: ["The concurrent builds field is required."],
      serverDiskUsageNotificationThreshold: ["The server disk usage notification threshold field must not be greater than 99."],
      serverDiskUsageNotificationIntervalHours: ["The server disk usage notification interval hours field must be at least 1."],
      dynamicTimeout: ["The dynamic timeout field must be an integer."],
      backupCompressionCpuPercentage: ["The selected backup compression cpu percentage is invalid."],
    });
    expect(validateAdvanced(advanced()).ok).toBe(true);
  });

  it("Docker Cleanup: the frequency is required; the threshold 1 to 99; booleans", () => {
    expect(errorsOf(validateDockerCleanup({ dockerCleanupFrequency: "", dockerCleanupThreshold: 0, deleteUnusedVolumes: "yes" }))).toEqual({
      dockerCleanupFrequency: ["The docker cleanup frequency field is required."],
      dockerCleanupThreshold: ["The docker cleanup threshold field must be at least 1."],
      deleteUnusedVolumes: ["The delete unused volumes field must be true or false."],
    });
  });

  it("validate_cron_expression: Coolify's verdict for every golden expression (fixtures/s3, emitted by its real PHP)", () => {
    const { cron } = JSON.parse(readFileSync(join(process.cwd(), "fixtures", "s3", "goldens.json"), "utf8")) as { cron: Array<{ value: string; valid: boolean }> };
    expect(cron.length).toBeGreaterThan(40);
    for (const { value, valid } of cron) expect([value, validateCronExpression(value)]).toEqual([value, valid]);
  });

  it("validate_cron_expression: what the server settings pages accept, and what Coolify refuses that an earlier port accepted", () => {
    for (const ok of ["daily", "@hourly", "every_minute", "*/10 * * * *", "0 23 * * *", "*/15 9-17 * * 1-5", "0 0 1 JAN *"]) expect([ok, validateCronExpression(ok)]).toEqual([ok, true]);
    // Refused by Coolify's validate_cron_expression() at 91b7e3e (checked against its real PHP): weekday names in a range,
    // L, the @midnight macro, and the usual malformed inputs.
    for (const bad of ["0 0 1 JAN MON-FRI", "15,45 1-5/2 L * 5L", "@midnight", "", "nope", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "*/0 * * * *", "* * * * * *", "0"]) {
      expect([bad, validateCronExpression(bad)]).toEqual([bad, false]);
    }
    expect(validateCronExpression(undefined)).toBe(false);
    expect(validateCronExpression(5)).toBe(false);
  });

  it("Log Drains: one at a time, the enabled drain's fields, the field formats", () => {
    expect(errorsOf(validateLogDrains(drains({ isLogDrainAxiomEnabled: true, isLogDrainCustomEnabled: true }), FLAGS))).toEqual({
      logDrain: ["Only one log drain can be enabled at a time. Disable the current log drain first."],
    });
    expect(errorsOf(validateLogDrains(drains({ isLogDrainNewRelicEnabled: true }), FLAGS))).toEqual({
      logDrainNewRelicLicenseKey: ["The log drain new relic license key field is required."],
      logDrainNewRelicBaseUri: ["The log drain new relic base uri field is required."],
    });
    expect(errorsOf(validateLogDrains(drains({ logDrainNewRelicBaseUri: "not a url", logDrainAxiomApiKey: "key with spaces", logDrainAxiomDomain: "bad_host", logDrainCloudwatchRegion: "US-EAST" }), FLAGS))).toEqual({
      logDrainNewRelicBaseUri: ["The log drain new relic base uri field must be a valid URL."],
      logDrainAxiomApiKey: ["The log drain axiom api key field format is invalid."],
      logDrainAxiomDomain: ["The log drain axiom domain contains invalid characters. Only letters (a-z, A-Z), numbers (0-9), hyphens (-), and dots (.) are allowed."],
      logDrainCloudwatchRegion: ["The log drain cloudwatch region field format is invalid."],
    });
    expect(errorsOf(validateLogDrains(drains({ logDrainAxiomApiKey: "k".repeat(151) }), FLAGS))).toEqual({
      logDrainAxiomApiKey: ["The log drain axiom api key field must not be greater than 150 characters."],
    });
    // A flag the body leaves out is the stored one.
    expect(errorsOf(validateLogDrains({ logDrainCloudwatchGroup: "/freeploy/prod" }, { ...FLAGS, isLogDrainCloudwatchEnabled: true }))).toEqual({
      logDrainCloudwatchRegion: ["The log drain cloudwatch region field is required."],
    });
  });

  it("ValidFluentBitConfig: the supported subset, a forward input", () => {
    expect(fluentBitConfigError("[INPUT]\n    Name forward\n\n[OUTPUT]\n    Name  stdout\n    Match *")).toBeNull();
    expect(fluentBitConfigError("[OUTPUT]\n  Name stdout")).toBe('it has no [INPUT] section with "Name forward". Containers send their logs to this input on port 24224.');
    expect(fluentBitConfigError("[INPUT]\n  Name exec")).toBe("line 2 uses the exec plugin.");
    expect(fluentBitConfigError("@include other.conf\n[INPUT]\n  Name forward")).toBe("line 1 uses the @include directive.");
    expect(fluentBitConfigError("[INPUT]\n  Name forward", true)).toBe("line 1 uses the [INPUT] section. Allowed sections: PARSER, MULTILINE_PARSER.");
    expect(errorsOf(validateLogDrains(drains({ isLogDrainCustomEnabled: true, logDrainCustomConfig: "[INPUT]\n  Name forward\n  plugins_file /x" }), FLAGS))).toEqual({
      logDrainCustomConfig: ["The log drain custom config is not allowed: line 3 uses the plugins_file key."],
    });
  });

  it("Sentinel: the token's pattern and length, the URL", () => {
    expect(errorsOf(validateSentinel({ sentinelToken: "", sentinelCustomUrl: "nope" }))).toEqual({
      sentinelToken: ["The sentinel token field is required."],
      sentinelCustomUrl: ["The sentinel custom url field must be a valid URL."],
    });
    expect(errorsOf(validateSentinel({ sentinelToken: `${"a".repeat(501)};` }))).toEqual({
      sentinelToken: ["The sentinel token field must not be greater than 500 characters.", "The sentinel token field format is invalid."],
    });
  });

  it("Server::sentinelStatus(): waiting, then out of sync; in sync while reports arrive", () => {
    const now = Date.parse("2026-11-25T12:00:00Z");
    const s = { sentinel_push_interval_seconds: 60, sentinel_updated_at: "2026-11-25 11:59:00", sentinel_waiting_since: null };
    expect(sentinelStatus(s, now)).toBe("in_sync");
    expect(sentinelStatus({ ...s, sentinel_updated_at: "2026-11-25 11:50:00" }, now)).toBe("out_of_sync");
    expect(sentinelStatus({ ...s, sentinel_waiting_since: "2026-11-25 11:59:30" }, now)).toBe("waiting");
    expect(sentinelStatus({ ...s, sentinel_waiting_since: "2026-11-25 11:55:00" }, now)).toBe("out_of_sync");
  });
});

describe("Advanced and Docker Cleanup", () => {
  it("shows Advanced with the chrome's server, and saves it: 'Server updated.'", async () => {
    const t = setup();
    const r = await t.call("GET", `${UUID}/advanced`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ server: { uuid: UUID, name: "prod-1" }, canUpdate: true, settings: { concurrentBuilds: 2, dynamicTimeout: 3600, backupCompressionCpuPercentage: 25, serverDiskUsageCheckFrequency: "0 23 * * *" } });
    const s = await t.call("PATCH", `${UUID}/advanced`, advanced());
    expect(s.body.data).toMatchObject({ message: "Server updated.", unavailable: null, settings: { concurrentBuilds: 4, deploymentQueueLimit: 10 } });
    expect(t.store.row).toMatchObject({ concurrent_builds: 4, dynamic_timeout: 1800, deployment_queue_limit: 10, backup_compression_cpu_percentage: 50, server_disk_usage_notification_threshold: 50 });
    expect(t.orgs).toEqual([ORG_UUID, ORG_UUID]);
  });

  it("submit checks the cron first; instantSave does not", async () => {
    const t = setup();
    const bad = await t.call("PATCH", `${UUID}/advanced`, advanced({ serverDiskUsageCheckFrequency: "whenever" }));
    expect(bad.status).toBe(422);
    expect(bad.body.error?.message).toBe("Invalid Cron / Human expression for Disk Usage Check Frequency.");
    expect(t.store.row.concurrent_builds).toBe(2);
    // Coolify refuses these too (DP-68): a weekday range by name, and the @midnight macro.
    for (const frequency of ["0 23 * * MON-FRI", "@midnight"]) {
      expect((await t.call("PATCH", `${UUID}/advanced`, advanced({ serverDiskUsageCheckFrequency: frequency }))).body.error?.message).toBe("Invalid Cron / Human expression for Disk Usage Check Frequency.");
    }
    expect(t.store.row.concurrent_builds).toBe(2);
    expect((await t.call("PATCH", `${UUID}/advanced`, advanced({ serverDiskUsageCheckFrequency: "whenever", instantSave: true }))).status).toBe(200);
    expect((await t.call("PATCH", `${UUID}/advanced`, advanced({ concurrentBuilds: "0" }))).body.error?.details.fields).toEqual({ concurrentBuilds: ["The concurrent builds field must be at least 1."] });
  });

  it("Docker Cleanup stores a preset as its expression; Run cleanup needs SSH", async () => {
    const t = setup();
    const r = await t.call("PATCH", `${UUID}/docker-cleanup`, { dockerCleanupFrequency: "daily", dockerCleanupThreshold: 70, forceDockerCleanup: false, deleteUnusedVolumes: true });
    expect(r.body.data).toMatchObject({ message: "Server updated.", settings: { dockerCleanupFrequency: "0 0 * * *", dockerCleanupThreshold: 70, forceDockerCleanup: false, deleteUnusedVolumes: true, deleteUnusedNetworks: false } });
    expect(t.store.row).toMatchObject({ docker_cleanup_frequency: "0 0 * * *", force_docker_cleanup: false, delete_unused_volumes: true });
    const bad = await t.call("PATCH", `${UUID}/docker-cleanup`, { dockerCleanupFrequency: "sometimes", dockerCleanupThreshold: 70 });
    expect(bad.body.error?.message).toBe("Invalid Cron / Human expression for Docker Cleanup Frequency.");
    for (const frequency of ["0 0 * * MON-FRI", "@midnight", "0 0 L * *"]) {
      expect((await t.call("PATCH", `${UUID}/docker-cleanup`, { dockerCleanupFrequency: frequency, dockerCleanupThreshold: 70 })).body.error?.message).toBe("Invalid Cron / Human expression for Docker Cleanup Frequency.");
    }
    expect(t.store.row.docker_cleanup_frequency).toBe("0 0 * * *");
    const run = await t.call("POST", `${UUID}/docker-cleanup/run`, {});
    expect(run.status).toBe(501);
    expect(run.body.error).toMatchObject({ code: "unsupported", message: "Running Docker cleanup needs the SSH executor, which is not available yet." });
  });
});

describe("Log Drains", () => {
  it("stores the keys and the Fluent Bit config encrypted; shows them to writers only", async () => {
    const t = setup();
    const r = await t.call("PATCH", `${UUID}/log-drains`, drains({ logDrainAxiomApiKey: "xaat-fake-0001", logDrainAxiomDatasetName: "logs", logDrainNewRelicLicenseKey: "nr-fake-0001", logDrainCustomConfig: "[INPUT]\n  Name forward" }));
    expect(r.body.data).toMatchObject({ message: "Settings saved.", unavailable: null, settings: { logDrainAxiomApiKey: "xaat-fake-0001", logDrainNewRelicLicenseKey: "nr-fake-0001", isLogDrainEnabled: false } });
    expect(t.store.row.logdrain_axiom_api_key).toBe("enc:server_settings.logdrain_axiom_api_key:xaat-fake-0001");
    expect(t.store.row.logdrain_newrelic_license_key).toBe("enc:server_settings.logdrain_newrelic_license_key:nr-fake-0001");
    expect(t.store.row.logdrain_custom_config).toBe("enc:server_settings.logdrain_custom_config:[INPUT]\n  Name forward");
    expect(t.store.row.logdrain_axiom_dataset_name).toBe("logs");

    const reader = setup({ write: false });
    reader.store.row = t.store.row;
    const shown = await reader.call("GET", `${UUID}/log-drains`);
    expect(shown.status).toBe(200);
    expect(shown.body.data).toMatchObject({ canUpdate: false, settings: { logDrainAxiomApiKey: null, logDrainNewRelicLicenseKey: null, logDrainCustomConfig: null, logDrainCustomConfigParser: null, logDrainAxiomDatasetName: "logs" } });
    expect(JSON.stringify(shown.body)).not.toContain("fake-0001");
  });

  it("instantSave: starting or stopping the drain needs SSH, so the flags roll back (as toggleLogDrain on failure) and the answer is 501", async () => {
    const t = setup();
    const on = await t.call("PATCH", `${UUID}/log-drains`, drains({ instantSave: true, isLogDrainAxiomEnabled: true, logDrainAxiomApiKey: "xaat-fake-0001", logDrainAxiomDatasetName: "logs" }));
    expect(on.status).toBe(501);
    expect(on.body.error).toMatchObject({ code: "unsupported", message: "Starting the log drain needs the SSH executor, which is not available yet." });
    // Never Enabled while nothing runs; the typed fields are kept.
    expect(t.store.row.is_logdrain_axiom_enabled).toBe(false);
    expect(t.store.row.logdrain_axiom_api_key).toBe("enc:server_settings.logdrain_axiom_api_key:xaat-fake-0001");
    expect((await t.call("GET", `${UUID}/log-drains`)).body.data?.settings).toMatchObject({ isLogDrainAxiomEnabled: false, isLogDrainEnabled: false, logDrainAxiomDatasetName: "logs" });
    const second = await t.call("PATCH", `${UUID}/log-drains`, drains({ instantSave: true, isLogDrainAxiomEnabled: true, isLogDrainCloudwatchEnabled: true }));
    expect(second.body.error?.details.fields).toEqual({ logDrain: ["Only one log drain can be enabled at a time. Disable the current log drain first."] });
    // A drain stored as enabled stays enabled when stopping it cannot run.
    t.store.row.is_logdrain_cloudwatch_enabled = true;
    const off = await t.call("PATCH", `${UUID}/log-drains`, drains({ instantSave: true }));
    expect(off.status).toBe(501);
    expect(off.body.error?.message).toBe("Stopping the log drain needs the SSH executor, which is not available yet.");
    expect(t.store.row.is_logdrain_cloudwatch_enabled).toBe(true);
  });

  it("an empty Axiom domain reads as the US default", async () => {
    const t = setup();
    t.store.row.logdrain_axiom_domain = null;
    expect((await t.call("GET", `${UUID}/log-drains`)).body.data?.settings?.logDrainAxiomDomain).toBe("us-east-1.aws.edge.axiom.co");
  });
});

describe("Swarm", () => {
  it("only an org that already uses Swarm may change the roles", async () => {
    const t = setup();
    expect((await t.call("GET", `${UUID}/swarm`)).body.data?.settings).toEqual({ isSwarmManager: false, isSwarmWorker: false, canUseSwarm: false });
    const refused = await t.call("PATCH", `${UUID}/swarm`, { isSwarmManager: true, isSwarmWorker: false });
    expect(refused.body.error?.message).toBe("Docker Swarm is deprecated and cannot be enabled for new teams.");
    expect(t.store.row.is_swarm_manager).toBe(false);
    t.store.swarm = true;
    const saved = await t.call("PATCH", `${UUID}/swarm`, { isSwarmManager: true, isSwarmWorker: false });
    expect(saved.body.data).toMatchObject({ message: "Swarm settings updated.", settings: { isSwarmManager: true, canUseSwarm: true } });
  });
});

describe("Sentinel", () => {
  it("is for writers only (viewSentinel): a reader gets 404", async () => {
    const t = setup({ write: false });
    expect((await t.call("GET", `${UUID}/sentinel`)).status).toBe(404);
  });

  it("asks for validation first: no form for a server that is not functional", async () => {
    const t = setup();
    t.store.server = serverRow({ is_reachable: false });
    const r = await t.call("GET", `${UUID}/sentinel`);
    expect(r.body.data).toMatchObject({ settings: null, isSentinelEnabled: true, server: { isFunctional: false } });
    expect(t.store.row.sentinel_token).toBeNull();
  });

  it("creates a missing token (ensureValidSentinelToken), encrypted", async () => {
    const t = setup();
    const r = await t.call("GET", `${UUID}/sentinel`);
    const token = r.body.data?.settings?.sentinelToken as string;
    expect(token).toMatch(/^[A-Za-z0-9+/=]{44}$/);
    expect(t.store.row.sentinel_token).toBe(`enc:server_settings.sentinel_token:${token}`);
    expect(r.body.data?.settings).toMatchObject({ sentinelStatus: "out_of_sync", isMetricsEnabled: false, sentinelCustomUrl: null });
    // The same token on the next visit.
    expect((await t.call("GET", `${UUID}/sentinel`)).body.data?.settings?.sentinelToken).toBe(token);
  });

  it("saves the settings and says the restart needs SSH", async () => {
    const t = setup();
    const r = await t.call("PATCH", `${UUID}/sentinel`, { sentinelToken: "fake-token-0001", sentinelCustomUrl: "https://freeploy.example.com" });
    expect(r.body.data).toMatchObject({ message: "Sentinel settings updated.", unavailable: "Restarting Sentinel needs the SSH executor, which is not available yet.", settings: { sentinelToken: "fake-token-0001", sentinelCustomUrl: "https://freeploy.example.com" } });
    expect(t.store.row.sentinel_token).toBe("enc:server_settings.sentinel_token:fake-token-0001");
    const same = await t.call("PATCH", `${UUID}/sentinel`, { sentinelToken: "fake-token-0001", sentinelCustomUrl: "https://freeploy.example.com", instantSave: true });
    expect(same.body.data).toMatchObject({ message: null, unavailable: null });
    const debug = await t.call("PATCH", `${UUID}/sentinel`, { sentinelToken: "fake-token-0001", sentinelCustomUrl: "https://freeploy.example.com", isSentinelDebugEnabled: true, instantSave: true });
    expect(debug.body.data).toMatchObject({ unavailable: "Restarting Sentinel needs the SSH executor, which is not available yet.", settings: { isSentinelDebugEnabled: true } });
    expect((await t.call("PATCH", `${UUID}/sentinel`, { sentinelToken: "bad token" })).body.error?.details.fields).toEqual({ sentinelToken: ["The sentinel token field format is invalid."] });
  });

  it("regenerates the token, restores the defaults, and the restart button needs SSH", async () => {
    const t = setup();
    await t.call("PATCH", `${UUID}/sentinel`, { sentinelToken: "fake-token-0001", sentinelCustomUrl: "https://freeploy.example.com", isSentinelDebugEnabled: true, isMetricsEnabled: true });
    t.store.row.sentinel_push_interval_seconds = 300;
    const regen = await t.call("POST", `${UUID}/sentinel/regenerate-token`, {});
    expect(regen.body.data).toMatchObject({ message: "Token regenerated.", unavailable: "Restarting Sentinel needs the SSH executor, which is not available yet." });
    expect(regen.body.data?.settings?.sentinelToken).not.toBe("fake-token-0001");
    const restored = await t.call("POST", `${UUID}/sentinel/restore-defaults`, {});
    expect(restored.body.data).toMatchObject({ message: "Default Sentinel configuration restored.", settings: { isSentinelDebugEnabled: false, isMetricsEnabled: true, sentinelCustomUrl: null } });
    expect(t.store.row).toMatchObject({ sentinel_push_interval_seconds: 60, sentinel_metrics_refresh_rate_seconds: 10, sentinel_metrics_history_days: 7 });
    const restart = await t.call("POST", `${UUID}/sentinel/restart`, {});
    expect(restart.status).toBe(501);
    expect(restart.body.error?.message).toBe("Restarting Sentinel needs the SSH executor, which is not available yet.");
  });
});

describe("routing and authorization", () => {
  it("reads ask deploy.resource.read and report canUpdate; saves need deploy.resource.write", async () => {
    const reader = setup({ write: false });
    const r = await reader.call("GET", `${UUID}/advanced`);
    expect(r.status).toBe(200);
    expect(r.body.data?.canUpdate).toBe(false);
    expect((await reader.call("PATCH", `${UUID}/advanced`, advanced())).status).toBe(404);
    expect((await reader.call("POST", `${UUID}/docker-cleanup/run`, {})).status).toBe(404);
    expect(reader.store.row.concurrent_builds).toBe(2);
    expect((await setup({ read: false }).call("GET", `${UUID}/swarm`)).status).toBe(404);
  });

  it("404s an unknown server, section or action; 405s a method a path does not take", async () => {
    const t = setup();
    expect((await t.call("GET", "nosuchserver/advanced")).status).toBe(404);
    expect((await t.call("GET", `${UUID}/metrics`)).status).toBe(404);
    expect((await t.call("POST", `${UUID}/advanced/run`)).status).toBe(404);
    expect((await t.call("POST", `${UUID}/advanced`)).status).toBe(405);
    expect((await t.call("GET", `${UUID}/sentinel/restart`)).status).toBe(405);
  });

  it("the router passes three segments below /servers, not four", async () => {
    const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
    const env: Env = { ENVIRONMENT: "test" };
    expect((await route(new Request(`${BASE}/${UUID}/sentinel/restart`, { method: "POST", headers }), env)).status).toBe(503);
    expect((await route(new Request(`${BASE}/${UUID}/sentinel/restart/now`, { method: "POST", headers }), env)).status).toBe(404);
  });
});
