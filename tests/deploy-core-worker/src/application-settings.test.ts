// An application's Domains, Advanced, Healthcheck and Resource Limits pages
// (DP-52): Coolify's rules and messages word for word, what each save stores
// (column by column against the components), the www/non-www pairs and the
// per-domain ports of the Domains page, what cannot run yet (DNS checks,
// refreshing GPUs), and the handler's routing and authorization. The SQL
// behind the store (and its row-level security) is tested in tests/db.
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { handleApplications } from "@deploy-core-worker/handlers/applications";
import { handleApplicationSettings, type ApplicationSettingsRunner, type ApplicationSettingsSection } from "@deploy-core-worker/handlers/application-settings";
import type { ApplicationSettingsStore } from "@deploy-core-worker/applications/settings";
import {
  isValidHealthCheckHost,
  parseGpuOptions,
  slug,
  validateHealthCheck,
  validateResourceLimits,
  type HealthCheckInput,
  type ResourceLimitsInput,
} from "@deploy-core-worker/applications/settings-validation";
import { availableInternalPorts, dnsMismatchGuidanceMessage, dnsTargetLabel, serverDnsAddresses, splitDomains, wwwCounterpartUrl } from "@deploy-core-worker/applications/domains-page";
import type { ApplicationConfigurationChanges, ApplicationSettingsChanges, DeployApplicationConfigurationRow, DeployApplicationRow } from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const NOW = "2026-11-24T10:00:00+00:00";
const SSLIP = "http://app1.203.0.113.10.sslip.io";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

type Row = Record<string, unknown> & { id: number; uuid: string };

/** A Docker image application as DockerImage::submit() and the schema's defaults leave it, with its server. */
function application(id: number, uuid: string, over: Record<string, unknown> = {}): Row {
  return {
    id,
    uuid,
    name: `docker-image-${uuid}`,
    description: null,
    build_pack: "dockerimage",
    status: "exited",
    ports_exposes: "80",
    has_dockerfile: false,
    fqdn: `http://${uuid}.203.0.113.10.sslip.io`,
    redirect: "both",
    domain_port_overrides: null,
    noindex_domains: null,
    domain_dns_statuses: null,
    health_check_enabled: false,
    health_check_type: "http",
    health_check_command: null,
    health_check_method: "GET",
    health_check_scheme: "http",
    health_check_host: "localhost",
    health_check_port: null,
    health_check_path: "/",
    health_check_return_code: 200,
    health_check_response_text: null,
    health_check_interval: 5,
    health_check_timeout: 5,
    health_check_retries: 10,
    health_check_start_period: 5,
    custom_healthcheck_found: false,
    limits_cpus: "0",
    limits_cpuset: null,
    limits_cpu_shares: 1024,
    limits_memory: "0",
    limits_memory_swap: "0",
    limits_memory_swappiness: 60,
    limits_memory_reservation: "0",
    max_restart_count: 0,
    restart_count: 0,
    restart_limit_reached: false,
    container_present: null,
    // application_settings
    is_static: false,
    is_container_label_readonly_enabled: true,
    is_container_label_escape_enabled: true,
    is_force_https_enabled: true,
    is_permanent_redirect_enabled: false,
    disable_build_cache: false,
    inject_build_args_to_dockerfile: true,
    include_source_commit_in_build: false,
    include_network_hosts_in_build: true,
    is_consistent_container_name_enabled: false,
    custom_internal_name: null,
    custom_container_name_prefix: null,
    stop_grace_period: null,
    rolling_update_drain_seconds: 5,
    is_log_drain_enabled: false,
    is_gpu_enabled: false,
    gpu_driver: "nvidia",
    gpu_count: null,
    gpu_device_ids: null,
    gpu_options: null,
    is_gzip_enabled: true,
    is_stripprefix_enabled: true,
    traefik_certificate_resolver: null,
    // where it lives
    environment_uuid: "env1",
    environment_name: "production",
    project_uuid: "prj1",
    project_name: "Shop",
    destination_uuid: "dst1",
    destination_name: "freeploy",
    destination_network: "coolify",
    destination_type: "App\\Models\\StandaloneDocker",
    server_id: 7,
    server_uuid: "srv1",
    server_name: "main",
    server_ip: "203.0.113.10",
    server_proxy: { type: "TRAEFIK", status: "exited" },
    server_metadata: null,
    server_wildcard_domain: null,
    server_public_ipv4: null,
    server_public_ipv6: null,
    server_traefik_certificate_resolver: "letsencrypt",
    server_is_reachable: false,
    server_is_usable: false,
    server_force_disabled: false,
    server_is_swarm_manager: false,
    server_is_swarm_worker: false,
    server_is_logdrain_newrelic_enabled: false,
    server_is_logdrain_axiom_enabled: false,
    server_is_logdrain_custom_enabled: false,
    server_is_logdrain_cloudwatch_enabled: false,
    additional_servers: 0,
    ...over,
  };
}

/** One org's applications with their settings, in memory; every write is recorded. */
class MemoryStore implements ApplicationSettingsStore {
  rows: Row[] = [application(1, "app1")];
  applicationWrites: ApplicationConfigurationChanges[] = [];
  settingsWrites: ApplicationSettingsChanges[] = [];

  get app(): Row {
    return this.rows[0]!;
  }
  async findByUuid(uuid: string) {
    return (this.rows.find((r) => r.uuid === uuid) as unknown as DeployApplicationRow | undefined) ?? null;
  }
  async configuration(uuid: string) {
    const row = this.rows.find((r) => r.uuid === uuid);
    return row ? ({ ...row } as unknown as DeployApplicationConfigurationRow) : null;
  }
  async update(id: string | number, changes: ApplicationConfigurationChanges) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return false;
    this.applicationWrites.push(changes);
    Object.assign(row, changes);
    return true;
  }
  async updateSettings(applicationId: string | number, changes: ApplicationSettingsChanges) {
    const row = this.rows.find((r) => r.id === applicationId);
    if (!row) return false;
    this.settingsWrites.push(changes);
    Object.assign(row, changes);
    return true;
  }
  async containerNames(serverId: string | number) {
    return this.rows
      .filter((r) => r.server_id === serverId)
      .map((r) => ({ id: r.id, uuid: r.uuid, custom_internal_name: r.custom_internal_name as string | null, custom_container_name_prefix: r.custom_container_name_prefix as string | null }));
  }
  async domains() {
    return this.rows.filter((r) => typeof r.fqdn === "string" && r.fqdn !== "").map((r) => ({ uuid: r.uuid, name: r.name as string, fqdn: r.fqdn as string, environment_uuid: "env1", project_uuid: "prj1" }));
  }
  /** A JSON column as stored. */
  stored(column: string): unknown {
    const value = this.app[column];
    return typeof value === "string" ? JSON.parse(value) : value;
  }
}

interface Answer {
  status: number;
  data: Record<string, unknown>;
  error: { code: string; message: string; details: { fields?: Record<string, string[]>; conflicts?: Array<Record<string, unknown>>; unrecognizedPort?: number } };
}

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
  const runner: ApplicationSettingsRunner = async (_env, orgId, fn) => {
    orgs.push(orgId);
    return fn({ store, now: () => new Date("2026-11-24T10:00:00.123Z") });
  };
  const call = async (method: string, section: ApplicationSettingsSection, body?: unknown, uuid = "app1"): Promise<Answer> => {
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleApplicationSettings(env, "req_1", actor, ORG_UUID, uuid, section, new Request(`${BASE}/applications/${uuid}/${section}`, init), runner);
    const parsed = (await res.json()) as { data?: Record<string, unknown>; error?: Answer["error"] };
    return { status: res.status, data: parsed.data ?? {}, error: parsed.error ?? { code: "", message: "", details: {} } };
  };
  const get = (section: ApplicationSettingsSection, uuid?: string) => call("GET", section, undefined, uuid);
  const patch = (section: ApplicationSettingsSection, body: unknown, uuid?: string) => call("PATCH", section, body, uuid);
  const fields = async (section: ApplicationSettingsSection, body: unknown) => {
    const r = await patch(section, body);
    return r.status === 422 ? (r.error.details.fields ?? r.error.message) : `status ${r.status}`;
  };
  return { store, asked, orgs, env, call, get, patch, fields };
}

// ---------------------------------------------------------------- Healthcheck

const HEALTH: HealthCheckInput = {
  healthCheckEnabled: false,
  healthCheckType: "http",
  healthCheckCommand: null,
  healthCheckMethod: "GET",
  healthCheckScheme: "http",
  healthCheckHost: "localhost",
  healthCheckPort: null,
  healthCheckPath: "/",
  healthCheckReturnCode: 200,
  healthCheckResponseText: null,
  healthCheckInterval: 5,
  healthCheckTimeout: 5,
  healthCheckRetries: 10,
  healthCheckStartPeriod: 5,
};

describe("the Healthcheck form's rules and messages (HealthChecks::rules)", () => {
  const errors = (body: Record<string, unknown>) => {
    const r = validateHealthCheck(body, HEALTH);
    return r.ok ? {} : r.errors;
  };

  it("accepts the stored values, and a body's fields in their place", () => {
    expect(validateHealthCheck({}, HEALTH)).toEqual({ ok: true, input: HEALTH });
    const r = validateHealthCheck({ healthCheckEnabled: "1", healthCheckType: "cmd", healthCheckCommand: "pg_isready -U postgres", healthCheckPort: "8080", healthCheckReturnCode: "204", healthCheckInterval: 30 }, HEALTH);
    expect(r.ok && r.input).toMatchObject({ healthCheckEnabled: true, healthCheckType: "cmd", healthCheckCommand: "pg_isready -U postgres", healthCheckPort: "8080", healthCheckReturnCode: 204, healthCheckInterval: 30 });
    // Blank optional fields are null.
    const blank = validateHealthCheck({ healthCheckCommand: "", healthCheckPort: "", healthCheckResponseText: "  " }, { ...HEALTH, healthCheckCommand: "true", healthCheckPort: "80" });
    expect(blank.ok && blank.input).toMatchObject({ healthCheckCommand: null, healthCheckPort: null, healthCheckResponseText: null });
  });

  it("the choices: type, method and scheme", () => {
    expect(errors({ healthCheckType: "tcp" })).toEqual({ healthCheckType: ["The selected health check type is invalid."] });
    expect(errors({ healthCheckMethod: "DELETE" })).toEqual({ healthCheckMethod: ["The selected health check method is invalid."] });
    expect(errors({ healthCheckMethod: "" })).toEqual({ healthCheckMethod: ["The health check method field is required."] });
    expect(errors({ healthCheckScheme: "ftp" })).toEqual({ healthCheckScheme: ["The selected health check scheme is invalid."] });
    expect(errors({ healthCheckScheme: 5 })).toEqual({ healthCheckScheme: ["The health check scheme field must be a string.", "The selected health check scheme is invalid."] });
    expect(errors({ healthCheckEnabled: "yes" })).toEqual({ healthCheckEnabled: ["The health check enabled field must be true or false."] });
  });

  it("the command: at most 1000 characters, no shell operators", () => {
    for (const good of ["pg_isready -U postgres", "curl -f http://localhost:3000/health", "/bin/check --mode=fast,deep a@b +x"]) expect([good, errors({ healthCheckCommand: good })]).toEqual([good, {}]);
    for (const bad of ["true; rm -rf /", "a | b", "a && b", "echo $HOME", "a > b", "a < b", "`id`", "a\nb"]) {
      expect([bad, errors({ healthCheckCommand: bad })]).toEqual([bad, { healthCheckCommand: ["The health check command field format is invalid."] }]);
    }
    expect(errors({ healthCheckCommand: "a".repeat(1001) })).toEqual({ healthCheckCommand: ["The health check command field must not be greater than 1000 characters."] });
    expect(errors({ healthCheckCommand: 5 })).toEqual({ healthCheckCommand: ["The health check command field must be a string."] });
  });

  it("the path, the host and the port", () => {
    expect(errors({ healthCheckPath: "" })).toEqual({ healthCheckPath: ["The health check path field is required."] });
    expect(errors({ healthCheckPath: "/health?x=1" })).toEqual({ healthCheckPath: ["The health check path field format is invalid."] });
    expect(errors({ healthCheckPath: "/api/v1/health_check-1.0~a%20b,c;d" })).toEqual({});
    expect(errors({ healthCheckHost: "" })).toEqual({ healthCheckHost: ["The health check host field is required."] });
    expect(errors({ healthCheckHost: "local host" })).toEqual({ healthCheckHost: ["The health check host must be a hostname, an IPv4 address, or an IPv6 address."] });
    expect(errors({ healthCheckPort: "0" })).toEqual({ healthCheckPort: ["The health check port field must be at least 1."] });
    expect(errors({ healthCheckPort: 65536 })).toEqual({ healthCheckPort: ["The health check port field must not be greater than 65535."] });
    expect(errors({ healthCheckPort: "http" })).toEqual({ healthCheckPort: ["The health check port field must be an integer."] });
  });

  it("isValidHealthCheckHost: a hostname, an IPv4 address, an IPv6 address with or without brackets", () => {
    for (const good of ["localhost", "127.0.0.1", "app.internal", "my_service-1", "::1", "[::1]", "[2001:db8::1]", "2001:db8::1"]) expect([good, isValidHealthCheckHost(good)]).toEqual([good, true]);
    for (const bad of ["", "a b", "host;id", "[::1", "[zz::1]", "$(id)", "http://x", null, 5]) expect([bad, isValidHealthCheckHost(bad)]).toEqual([bad, false]);
  });

  it("the numbers: the expected code between 100 and 599, interval, timeout and retries at least 1", () => {
    expect(errors({ healthCheckReturnCode: 99 })).toEqual({ healthCheckReturnCode: ["The health check return code field must be between 100 and 599."] });
    expect(errors({ healthCheckReturnCode: "600" })).toEqual({ healthCheckReturnCode: ["The health check return code field must be between 100 and 599."] });
    expect(errors({ healthCheckReturnCode: "" })).toEqual({ healthCheckReturnCode: ["The health check return code field must be an integer."] });
    expect(errors({ healthCheckInterval: 0, healthCheckTimeout: "0", healthCheckRetries: -1 })).toEqual({
      healthCheckInterval: ["The health check interval field must be at least 1."],
      healthCheckTimeout: ["The health check timeout field must be at least 1."],
      healthCheckRetries: ["The health check retries field must be at least 1."],
    });
    expect(errors({ healthCheckInterval: "1.5" })).toEqual({ healthCheckInterval: ["The health check interval field must be an integer."] });
    // The start period is only an integer.
    expect(errors({ healthCheckStartPeriod: 0 })).toEqual({});
    expect(errors({ healthCheckStartPeriod: "soon" })).toEqual({ healthCheckStartPeriod: ["The health check start period field must be an integer."] });
  });

  it("the expected response text: at most 255 characters, no control characters", () => {
    expect(errors({ healthCheckResponseText: "OK — ready" })).toEqual({});
    expect(errors({ healthCheckResponseText: "a".repeat(256) })).toEqual({ healthCheckResponseText: ["The health check response text field must not be greater than 255 characters."] });
    expect(errors({ healthCheckResponseText: "a\tb" })).toEqual({ healthCheckResponseText: ["The health check response text field format is invalid."] });
  });
});

describe("the Healthcheck page (HealthChecks)", () => {
  it("shows the stored healthcheck inside the application's frame", async () => {
    const t = setup();
    const r = await t.get("healthcheck");
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({
      canUpdate: true,
      canDeploy: true,
      application: { uuid: "app1", name: "docker-image-app1", buildPack: "dockerimage", status: "exited", project: { uuid: "prj1", name: "Shop" }, environment: { uuid: "env1", name: "production" } },
      settings: { ...HEALTH, customHealthcheckFound: false },
    });
    expect(t.orgs).toEqual([ORG_UUID]);
    // A read asks for read, then for write to know what the page may offer.
    expect(t.asked).toEqual(["deploy.resource.read", "deploy.resource.write"]);
  });

  it("hides the command and the response text from a member who cannot update (syncData)", async () => {
    const t = setup({ write: false });
    Object.assign(t.store.app, { health_check_type: "cmd", health_check_command: "check --token=s3cret", health_check_response_text: "s3cret" });
    const r = await t.get("healthcheck");
    expect(r.data).toMatchObject({ canUpdate: false, settings: { healthCheckType: "cmd", healthCheckCommand: null, healthCheckResponseText: null } });
    const writer = setup();
    Object.assign(writer.store.app, { health_check_command: "check --token=s3cret" });
    expect((await writer.get("healthcheck")).data).toMatchObject({ settings: { healthCheckCommand: "check --token=s3cret" } });
  });

  it("submit stores what changed and answers 'Healthcheck updated.'", async () => {
    const t = setup();
    const r = await t.patch("healthcheck", { healthCheckPath: "/health", healthCheckPort: "3000", healthCheckReturnCode: "204", healthCheckInterval: "30", healthCheckResponseText: "OK", healthCheckHost: "localhost" });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ message: "Healthcheck updated.", settings: { healthCheckPath: "/health", healthCheckPort: "3000", healthCheckReturnCode: 204, healthCheckInterval: 30, healthCheckResponseText: "OK", healthCheckEnabled: false } });
    expect(t.store.applicationWrites).toEqual([{ health_check_path: "/health", health_check_port: "3000", health_check_return_code: 204, health_check_interval: 30, health_check_response_text: "OK" }]);
    // instantSave() is the same save.
    expect((await t.patch("healthcheck", { instantSave: true, healthCheckMethod: "HEAD" })).data).toMatchObject({ message: "Healthcheck updated.", settings: { healthCheckMethod: "HEAD" } });
    expect(t.asked).toEqual(["deploy.resource.write", "deploy.resource.write"]);
  });

  it("answers the field errors and stores nothing", async () => {
    const t = setup();
    expect(await t.fields("healthcheck", { healthCheckPath: "", healthCheckHost: "a b", healthCheckRetries: 0 })).toEqual({
      healthCheckPath: ["The health check path field is required."],
      healthCheckHost: ["The health check host must be a hostname, an IPv4 address, or an IPv6 address."],
      healthCheckRetries: ["The health check retries field must be at least 1."],
    });
    expect(t.store.applicationWrites).toEqual([]);
  });

  it("the toggle flips the flag; enabling on a running application asks for a restart (toggleHealthcheck)", async () => {
    const t = setup();
    expect((await t.patch("healthcheck", { toggle: true })).data).toMatchObject({ message: "Healthcheck enabled.", settings: { healthCheckEnabled: true } });
    expect((await t.patch("healthcheck", { toggle: true })).data).toMatchObject({ message: "Healthcheck disabled.", settings: { healthCheckEnabled: false } });
    expect(t.store.applicationWrites).toEqual([{ health_check_enabled: true }, { health_check_enabled: false }]);
    t.store.app.status = "running:healthy";
    const running = await t.patch("healthcheck", { toggle: true });
    expect(running.data).toMatchObject({ message: "Healthcheck has been enabled. A restart is required to apply the new settings.", info: true });
    expect((await t.patch("healthcheck", { toggle: true })).data).toMatchObject({ message: "Healthcheck disabled." });
  });

  it("is not a page of a Docker Compose application", async () => {
    const t = setup();
    t.store.app.build_pack = "dockercompose";
    expect((await t.get("healthcheck")).status).toBe(404);
  });
});

// ---------------------------------------------------------------- Resource Limits

const LIMITS: ResourceLimitsInput = { limitsCpus: "0", limitsCpuset: null, limitsCpuShares: 1024, limitsMemory: "0", limitsMemorySwap: "0", limitsMemorySwappiness: 60, limitsMemoryReservation: "0" };

describe("the Resource Limits form's rules and messages (ResourceLimits::submit)", () => {
  const errors = (body: Record<string, unknown>) => {
    const r = validateResourceLimits(body, LIMITS);
    return r.ok ? {} : r.errors;
  };

  it("applies submit()'s defaults to empty fields", () => {
    const r = validateResourceLimits({ limitsCpus: "", limitsCpuset: "", limitsCpuShares: "", limitsMemory: "", limitsMemorySwap: null, limitsMemorySwappiness: "", limitsMemoryReservation: "" }, { ...LIMITS, limitsCpus: "2", limitsMemory: "1g", limitsCpuShares: 512, limitsMemorySwappiness: 10 });
    expect(r).toEqual({ ok: true, input: LIMITS });
  });

  it("accepts Docker's formats and stores the integers as integers", () => {
    const r = validateResourceLimits({ limitsCpus: "1.5", limitsCpuset: "0-2,4", limitsCpuShares: "512", limitsMemory: "512m", limitsMemorySwap: "1G", limitsMemorySwappiness: "0", limitsMemoryReservation: "256M" }, LIMITS);
    expect(r).toEqual({ ok: true, input: { limitsCpus: "1.5", limitsCpuset: "0-2,4", limitsCpuShares: 512, limitsMemory: "512m", limitsMemorySwap: "1G", limitsMemorySwappiness: 0, limitsMemoryReservation: "256M" } });
    for (const good of [".5", "2", "0.25"]) expect([good, errors({ limitsCpus: good })]).toEqual([good, {}]);
    for (const good of ["0", "1024b", "64k", "2g"]) expect([good, errors({ limitsMemory: good })]).toEqual([good, {}]);
    // A number is read as its text.
    expect(validateResourceLimits({ limitsCpus: 2 }, LIMITS)).toMatchObject({ ok: true, input: { limitsCpus: "2" } });
  });

  it("answers ResourceLimits' own messages, word for word", () => {
    expect(errors({ limitsMemory: "512" })).toEqual({ limitsMemory: ["Maximum Memory Limit must be a number followed by a unit (b, k, m, g). Example: 256m, 1g. Use 0 for unlimited."] });
    expect(errors({ limitsMemorySwap: "1gb" })).toEqual({ limitsMemorySwap: ["Maximum Swap Limit must be a number followed by a unit (b, k, m, g). Example: 256m, 1g. Use 0 for unlimited."] });
    expect(errors({ limitsMemoryReservation: "-1m" })).toEqual({ limitsMemoryReservation: ["Soft Memory Limit must be a number followed by a unit (b, k, m, g). Example: 256m, 1g. Use 0 for unlimited."] });
    expect(errors({ limitsCpus: "two" })).toEqual({ limitsCpus: ["Number of CPUs must be a number (integer or decimal). Example: 0.5, 2."] });
    expect(errors({ limitsCpus: "1." })).toEqual({ limitsCpus: ["Number of CPUs must be a number (integer or decimal). Example: 0.5, 2."] });
    expect(errors({ limitsCpuset: "0-" })).toEqual({ limitsCpuset: ["CPU sets must be a comma-separated list of CPU numbers or ranges. Example: 0-2 or 0,1,3."] });
    expect(errors({ limitsMemorySwappiness: "half" })).toEqual({ limitsMemorySwappiness: ["Swappiness must be a whole number between 0 and 100."] });
    expect(errors({ limitsMemorySwappiness: 101 })).toEqual({ limitsMemorySwappiness: ["Swappiness must be between 0 and 100."] });
    expect(errors({ limitsMemorySwappiness: -1 })).toEqual({ limitsMemorySwappiness: ["Swappiness must be between 0 and 100."] });
    expect(errors({ limitsCpuShares: "1.5" })).toEqual({ limitsCpuShares: ["CPU Weight must be a whole number."] });
    expect(errors({ limitsCpuShares: -5 })).toEqual({ limitsCpuShares: ["CPU Weight must be a positive number."] });
  });
});

describe("the Resource Limits page (ResourceLimits)", () => {
  it("shows the limits and saves what changed with 'Resource limits updated.'", async () => {
    const t = setup();
    expect((await t.get("resource-limits")).data).toMatchObject({ canUpdate: true, application: { uuid: "app1" }, settings: LIMITS });
    const r = await t.patch("resource-limits", { limitsCpus: "1.5", limitsCpuset: "0-1", limitsCpuShares: "", limitsMemory: "512m", limitsMemorySwap: "", limitsMemorySwappiness: "10", limitsMemoryReservation: "0" });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ message: "Resource limits updated.", settings: { limitsCpus: "1.5", limitsCpuset: "0-1", limitsCpuShares: 1024, limitsMemory: "512m", limitsMemorySwap: "0", limitsMemorySwappiness: 10, limitsMemoryReservation: "0" } });
    expect(t.store.applicationWrites).toEqual([{ limits_cpus: "1.5", limits_cpuset: "0-1", limits_memory: "512m", limits_memory_swappiness: 10 }]);
    // Emptying a field stores its default.
    await t.patch("resource-limits", { limitsCpus: "", limitsCpuset: "", limitsMemory: "" });
    expect(t.store.applicationWrites[1]).toEqual({ limits_cpus: "0", limits_cpuset: null, limits_memory: "0" });
  });

  it("answers the messages and stores nothing", async () => {
    const t = setup();
    expect(await t.fields("resource-limits", { limitsMemory: "lots", limitsCpuShares: "many" })).toEqual({
      limitsMemory: ["Maximum Memory Limit must be a number followed by a unit (b, k, m, g). Example: 256m, 1g. Use 0 for unlimited."],
      limitsCpuShares: ["CPU Weight must be a whole number."],
    });
    expect(t.store.applicationWrites).toEqual([]);
  });
});

// ---------------------------------------------------------------- Advanced

describe("Advanced's helpers", () => {
  it("parseGpuOptions: key=value lines or a flat YAML mapping of scalars", () => {
    expect(parseGpuOptions("")).toEqual({});
    expect(parseGpuOptions(null)).toEqual({});
    expect(parseGpuOptions("capabilities=gpu\n\n mode = shared ")).toEqual({ capabilities: "gpu", mode: "shared" });
    expect(parseGpuOptions("a=b=c")).toEqual({ a: "b=c" });
    expect(parseGpuOptions("mode: shared\ncount: 2\nname: \"my gpu\"")).toEqual({ mode: "shared", count: "2", name: "my gpu" });
    // Neither: a line without "=", an empty key, a nested or flow YAML value.
    expect(parseGpuOptions("capabilities")).toBeNull();
    expect(parseGpuOptions("=gpu")).toBeNull();
    expect(parseGpuOptions("a=b\nc")).toBeNull();
    expect(parseGpuOptions("capabilities: [gpu]")).toBeNull();
    expect(parseGpuOptions("device:\n  id: 0")).toBeNull();
  });

  it("slug: Str::slug for a container name", () => {
    expect(slug("Shop API")).toBe("shop-api");
    expect(slug("  my_app--v2  ")).toBe("my-app-v2");
    expect(slug("Café Münster")).toBe("cafe-munster");
    expect(slug("user@host")).toBe("user-at-host");
    expect(slug("a.b/c!")).toBe("abc");
    expect(slug("!!!")).toBe("");
  });
});

describe("the Advanced page (Advanced)", () => {
  it("shows the settings of a Docker image application with what the view needs", async () => {
    const t = setup();
    const r = await t.get("advanced");
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({
      canUpdate: true,
      application: { uuid: "app1" },
      gitBased: false,
      labelsManaged: true,
      isTraefikProxy: true,
      serverCertificateResolver: "letsencrypt",
      gpuServers: [{ uuid: "srv1", name: "main", functional: false, collectedAt: null, gpus: null, nvidiaContainerToolkit: false }],
      settings: {
        disableBuildCache: false,
        injectBuildArgsToDockerfile: true,
        includeSourceCommitInBuild: false,
        includeNetworkHostsInBuild: true,
        isConsistentContainerNameEnabled: false,
        customInternalName: null,
        customContainerNamePrefix: null,
        stopGracePeriod: null,
        rollingUpdateDrainSeconds: 5,
        maxRestartCount: 0,
        isLogDrainEnabled: false,
        isGpuEnabled: false,
        gpuDriver: "nvidia",
        gpuCount: null,
        gpuDeviceIds: null,
        gpuOptions: null,
        isGzipEnabled: true,
        isStripprefixEnabled: true,
        certificateResolverMode: "server",
        certificateResolverName: null,
      },
    });
  });

  it("reads the server's detected GPUs, its resolver and the application's own resolver", async () => {
    const t = setup();
    Object.assign(t.store.app, {
      server_metadata: JSON.stringify({ collected_at: "2026-11-20T08:00:00+00:00", nvidia_container_toolkit: true, gpus: [{ index: 0, name: "NVIDIA RTX 4090", memory_mb: 24564, uuid: "GPU-1" }] }),
      server_is_reachable: true,
      server_is_usable: true,
      server_traefik_certificate_resolver: "none",
      server_proxy: JSON.stringify({ type: "CADDY" }),
      traefik_certificate_resolver: "cloudflare",
      is_container_label_readonly_enabled: false,
      rolling_update_drain_seconds: 900,
    });
    expect((await t.get("advanced")).data).toMatchObject({
      labelsManaged: false,
      isTraefikProxy: false,
      serverCertificateResolver: "none",
      gpuServers: [{ functional: true, collectedAt: "2026-11-20T08:00:00+00:00", nvidiaContainerToolkit: true, gpus: [{ index: "0", name: "NVIDIA RTX 4090", memoryMb: 24564, uuid: "GPU-1" }] }],
      settings: { certificateResolverMode: "custom", certificateResolverName: "cloudflare", rollingUpdateDrainSeconds: 300 },
    });
    t.store.app.traefik_certificate_resolver = "none";
    expect((await t.get("advanced")).data).toMatchObject({ settings: { certificateResolverMode: "none", certificateResolverName: null } });
  });

  it("instantSave stores the changed switches and answers 'Settings saved.'", async () => {
    const t = setup();
    const r = await t.patch("advanced", { instantSave: true, disableBuildCache: true, isConsistentContainerNameEnabled: "1", isGzipEnabled: false, isStripprefixEnabled: true, isGpuEnabled: true });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ message: "Settings saved.", settings: { disableBuildCache: true, isConsistentContainerNameEnabled: true, isGzipEnabled: false, isGpuEnabled: true } });
    expect(t.store.settingsWrites).toEqual([{ disable_build_cache: true, is_consistent_container_name_enabled: true, is_gzip_enabled: false, is_gpu_enabled: true }]);
    // The Git and Docker Compose sections are not a Docker image application's: their properties are not read.
    await t.patch("advanced", { instantSave: true, isAutoDeployEnabled: false, isGitLfsEnabled: false, isRawComposeDeploymentEnabled: true, isForceHttpsEnabled: false });
    expect(t.store.settingsWrites).toEqual([{ disable_build_cache: true, is_consistent_container_name_enabled: true, is_gzip_enabled: false, is_gpu_enabled: true }, {}]);
    expect(await t.fields("advanced", { instantSave: true, isGzipEnabled: "maybe" })).toEqual({ isGzipEnabled: ["The is gzip enabled field must be true or false."] });
  });

  it("a log drain needs one on the server: the switch is saved off with the rest, and Coolify's error is the answer", async () => {
    const t = setup();
    const r = await t.patch("advanced", { instantSave: true, isLogDrainEnabled: true, disableBuildCache: true });
    expect(r.status).toBe(422);
    expect(r.error.details.fields).toEqual({ isLogDrainEnabled: ["Log drain is not enabled on this server."] });
    expect(t.store.settingsWrites).toEqual([{ disable_build_cache: true }]);
    expect(t.store.app.is_log_drain_enabled).toBe(false);
    t.store.app.server_is_logdrain_axiom_enabled = true;
    expect((await t.patch("advanced", { instantSave: true, isLogDrainEnabled: true })).data).toMatchObject({ message: "Settings saved.", settings: { isLogDrainEnabled: true } });
  });

  it("submit checks the changed GPU values first, then saves the GPU form", async () => {
    const t = setup();
    expect(await t.fields("advanced", { gpuCount: "2", gpuDeviceIds: "0,1" })).toEqual({ gpuCount: ["You cannot set both GPU count and GPU device IDs."] });
    expect(await t.fields("advanced", { gpuCount: "two" })).toEqual({ gpuCount: ['GPU count must be a number or "all".'] });
    expect(await t.fields("advanced", { gpuOptions: "capabilities" })).toEqual({ gpuOptions: ["GPU options must be key=value pairs (one per line) or a YAML mapping."] });
    expect(await t.fields("advanced", { gpuCount: { n: 1 } })).toEqual({ gpuCount: ["The gpu count field must be a string."] });
    expect(t.store.settingsWrites).toEqual([]);
    const r = await t.patch("advanced", { gpuDriver: "nvidia", gpuCount: " all ", gpuDeviceIds: "", gpuOptions: "capabilities=gpu" });
    expect(r.data).toMatchObject({ message: "Settings saved.", settings: { gpuDriver: "nvidia", gpuCount: " all ", gpuDeviceIds: null, gpuOptions: "capabilities=gpu" } });
    expect(t.store.settingsWrites).toEqual([{ gpu_count: " all ", gpu_options: "capabilities=gpu" }]);
    // Stored legacy values that are not touched do not block other settings.
    Object.assign(t.store.app, { gpu_count: "many", gpu_device_ids: "0", gpu_options: "nonsense" });
    expect((await t.patch("advanced", { gpuDriver: "amd" })).status).toBe(200);
  });

  it("the custom container name is saved as a slug, unique on the server (saveCustomName)", async () => {
    const t = setup();
    t.store.rows.push(application(2, "app2", { custom_internal_name: "taken", custom_container_name_prefix: "busy" }));
    const r = await t.patch("advanced", { save: "customName", customInternalName: "Shop API" });
    expect(r.data).toMatchObject({ message: "Custom name saved.", settings: { customInternalName: "shop-api" } });
    expect(t.store.settingsWrites).toEqual([{ custom_internal_name: "shop-api" }]);
    expect(await t.fields("advanced", { save: "customName", customInternalName: "Taken" })).toEqual({ customInternalName: ["This custom container name is already in use by another application on this server."] });
    // Another server's application does not count.
    t.store.rows[1]!.server_id = 8;
    expect((await t.patch("advanced", { save: "customName", customInternalName: "Taken" })).status).toBe(200);
    expect((await t.patch("advanced", { save: "customName", customInternalName: "" })).data).toMatchObject({ message: "Custom name saved.", settings: { customInternalName: null } });
  });

  it("the container name prefix is saved as a slug, at most 30 characters, not another application's uuid, prefix or name (saveCustomNamePrefix)", async () => {
    const t = setup();
    t.store.rows.push(application(2, "app2", { custom_internal_name: "taken", custom_container_name_prefix: "busy" }));
    expect((await t.patch("advanced", { save: "customNamePrefix", customContainerNamePrefix: "My API" })).data).toMatchObject({ message: "Container name prefix saved.", settings: { customContainerNamePrefix: "my-api" } });
    const inUse = { customContainerNamePrefix: ["This container name prefix is already in use by another application on this Freeploy instance."] };
    for (const prefix of ["busy", "Taken", "app2"]) expect([prefix, await t.fields("advanced", { save: "customNamePrefix", customContainerNamePrefix: prefix })]).toEqual([prefix, inUse]);
    // Its own uuid is not "another application".
    expect((await t.patch("advanced", { save: "customNamePrefix", customContainerNamePrefix: "app1" })).status).toBe(200);
    expect(await t.fields("advanced", { save: "customNamePrefix", customContainerNamePrefix: "a".repeat(31) })).toEqual({ customContainerNamePrefix: ["The custom container name prefix field must not be greater than 30 characters."] });
    expect((await t.patch("advanced", { save: "customNamePrefix", customContainerNamePrefix: "" })).data).toMatchObject({ settings: { customContainerNamePrefix: null } });
    // Sent with the other settings, a changed prefix must already be a slug (validateChangedContainerNamePrefix).
    expect(await t.fields("advanced", { instantSave: true, customContainerNamePrefix: "My API" })).toEqual({
      customContainerNamePrefix: ["The container name prefix may only contain lowercase letters, numbers, and single hyphens between them."],
    });
    expect(await t.fields("advanced", { instantSave: true, customContainerNamePrefix: "busy" })).toEqual(inUse);
  });

  it("the certificate resolver: the server's, none, or a custom name (saveCertificateResolver)", async () => {
    const t = setup();
    expect((await t.patch("advanced", { save: "certificateResolver", certificateResolverMode: "none" })).data).toMatchObject({ message: "Certificate resolver saved.", settings: { certificateResolverMode: "none" } });
    expect((await t.patch("advanced", { save: "certificateResolver", certificateResolverMode: "custom", certificateResolverName: "cloudflare" })).data).toMatchObject({ settings: { certificateResolverMode: "custom", certificateResolverName: "cloudflare" } });
    // The name is only read for "custom".
    expect((await t.patch("advanced", { save: "certificateResolver", certificateResolverMode: "server", certificateResolverName: "not read!" })).data).toMatchObject({ settings: { certificateResolverMode: "server", certificateResolverName: null } });
    expect(t.store.settingsWrites).toEqual([{ traefik_certificate_resolver: "none" }, { traefik_certificate_resolver: "cloudflare" }, { traefik_certificate_resolver: null }]);
    const custom = (certificateResolverName: unknown) => t.fields("advanced", { save: "certificateResolver", certificateResolverMode: "custom", certificateResolverName });
    expect(await custom("")).toEqual({ certificateResolverName: ["The resolver name field is required."] });
    expect(await custom("my resolver")).toEqual({ certificateResolverName: ["The resolver name may only contain letters, numbers, hyphens, and underscores."] });
    expect(await custom("none")).toEqual({ certificateResolverName: ['Choose "None" instead of a custom resolver named "none".'] });
    expect(await custom("a".repeat(256))).toEqual({ certificateResolverName: ["The resolver name field must not be greater than 255 characters."] });
    expect(await t.fields("advanced", { save: "certificateResolver", certificateResolverMode: "auto" })).toEqual({ certificateResolverMode: ["The selected certificate resolver mode is invalid."] });
    expect(await t.fields("advanced", { save: "certificateResolver" })).toEqual({ certificateResolverMode: ["The certificate resolver mode field is required."] });
  });

  it("the fields that save themselves: stop grace period, rolling update drain time, max restart count", async () => {
    const t = setup();
    expect((await t.patch("advanced", { save: "stopGracePeriod", stopGracePeriod: "60" })).data).toMatchObject({ message: "Stop grace period updated.", settings: { stopGracePeriod: 60 } });
    expect((await t.patch("advanced", { save: "stopGracePeriod", stopGracePeriod: "" })).data).toMatchObject({ settings: { stopGracePeriod: null } });
    expect(await t.fields("advanced", { save: "stopGracePeriod", stopGracePeriod: 0 })).toEqual({ stopGracePeriod: ["The stop grace period field must be at least 1."] });
    expect(await t.fields("advanced", { save: "stopGracePeriod", stopGracePeriod: 3601 })).toEqual({ stopGracePeriod: ["The stop grace period field must not be greater than 3600."] });
    expect(await t.fields("advanced", { save: "stopGracePeriod", stopGracePeriod: "soon" })).toEqual({ stopGracePeriod: ["The stop grace period field must be an integer."] });

    expect((await t.patch("advanced", { save: "rollingUpdateDrainSeconds", rollingUpdateDrainSeconds: 0 })).data).toMatchObject({ message: "Rolling update drain time updated.", settings: { rollingUpdateDrainSeconds: 0 } });
    expect(await t.fields("advanced", { save: "rollingUpdateDrainSeconds", rollingUpdateDrainSeconds: "" })).toEqual({ rollingUpdateDrainSeconds: ["The rolling update drain time field is required."] });
    expect(await t.fields("advanced", { save: "rollingUpdateDrainSeconds", rollingUpdateDrainSeconds: 301 })).toEqual({ rollingUpdateDrainSeconds: ["The rolling update drain time field must not be greater than 300."] });
    expect(await t.fields("advanced", { save: "rollingUpdateDrainSeconds", rollingUpdateDrainSeconds: -1 })).toEqual({ rollingUpdateDrainSeconds: ["The rolling update drain time field must be at least 0."] });

    expect((await t.patch("advanced", { save: "maxRestartCount", maxRestartCount: "3" })).data).toMatchObject({ message: "Max restart count saved.", settings: { maxRestartCount: 3 } });
    expect(await t.fields("advanced", { save: "maxRestartCount", maxRestartCount: -1 })).toEqual({ maxRestartCount: ["The max restart count field must be at least 0."] });
    expect(await t.fields("advanced", { save: "maxRestartCount", maxRestartCount: "" })).toEqual({ maxRestartCount: ["The max restart count field must be an integer."] });

    expect(t.store.settingsWrites).toEqual([{ stop_grace_period: 60 }, { stop_grace_period: null }, { rolling_update_drain_seconds: 0 }]);
    // The restart limit is kept on the application itself.
    expect(t.store.applicationWrites).toEqual([{ max_restart_count: 3 }]);
    expect(await t.fields("advanced", { save: "everything" })).toEqual({ save: ["The selected save is invalid."] });
  });

  it("refreshing the GPUs needs a functional server, then the SSH executor (501)", async () => {
    const t = setup();
    const unvalidated = await t.patch("advanced", { save: "refreshGpus" });
    expect([unvalidated.status, unvalidated.error.message]).toEqual([422, "Validate the server connection before you refresh GPUs."]);
    Object.assign(t.store.app, { server_is_reachable: true, server_is_usable: true });
    const r = await t.patch("advanced", { save: "refreshGpus" });
    expect([r.status, r.error.code, r.error.message]).toEqual([501, "unsupported", "Refreshing GPUs needs the SSH executor, which is not available yet."]);
    expect(t.store.settingsWrites).toEqual([]);
    expect((await t.patch("advanced", { save: "refreshGpus" }, "nope")).status).toBe(404);
  });
});

// ---------------------------------------------------------------- Domains

describe("the Domains page's helpers", () => {
  it("wwwCounterpartUrl: the other of www and non-www; never for an IP or localhost, for sslip only when a redirect needs it", () => {
    expect(wwwCounterpartUrl("https://example.com")).toBe("https://www.example.com");
    expect(wwwCounterpartUrl("https://www.example.com")).toBe("https://example.com");
    expect(wwwCounterpartUrl("http://WWW.Example.com:8080/app?x=1#top")).toBe("http://Example.com:8080/app?x=1#top");
    expect(wwwCounterpartUrl("https://api.example.com/v1")).toBe("https://www.api.example.com/v1");
    for (const none of ["http://203.0.113.10", "http://[2001:db8::1]:3000", "http://localhost:3000", "not a url", SSLIP, "http://app.10.0.0.1.nip.io"]) expect([none, wwwCounterpartUrl(none)]).toEqual([none, null]);
    expect(wwwCounterpartUrl(SSLIP, true)).toBe("http://www.app1.203.0.113.10.sslip.io");
    expect(wwwCounterpartUrl("http://203.0.113.10", true)).toBeNull();
  });

  it("splitDomains, and the ports a domain may use without a confirmation (availableInternalPorts)", () => {
    expect(splitDomains(" https://a.example.com , ,https://b.example.com")).toEqual(["https://a.example.com", "https://b.example.com"]);
    expect(splitDomains(null)).toEqual([]);
    expect(availableInternalPorts({ is_static: false, ports_exposes: "3000, 3001,x,0", fqdn: "https://a.example.com:8080,https://b.example.com" }, { "https://b.example.com": 9000 })).toEqual([3000, 3001, 8080, 9000]);
    expect(availableInternalPorts({ is_static: true, ports_exposes: "3000", fqdn: null }, null)).toEqual([80]);
    expect(availableInternalPorts({ is_static: false, ports_exposes: null, fqdn: null }, null)).toEqual([]);
  });

  it("the DNS target: the public IP before the server's address, a hostname as configured", () => {
    const server = { server_id: 7, server_ip: "203.0.113.10", server_public_ipv4: null, server_public_ipv6: null };
    expect(serverDnsAddresses(server)).toEqual({ address: "203.0.113.10", configured: "203.0.113.10" });
    expect(serverDnsAddresses({ ...server, server_public_ipv4: "198.51.100.7", server_public_ipv6: "2001:db8::7" })).toEqual({ address: "198.51.100.7", configured: "198.51.100.7" });
    expect(serverDnsAddresses({ ...server, server_ip: "10.0.0.5", server_public_ipv6: "[2001:db8::7]" })).toEqual({ address: "2001:db8::7", configured: "[2001:db8::7]" });
    // No resolver: a hostname stays as configured.
    expect(serverDnsAddresses({ ...server, server_ip: "host.example.com" })).toEqual({ address: "host.example.com", configured: "host.example.com" });
    expect(serverDnsAddresses({ ...server, server_id: null })).toEqual({ address: null, configured: null });
    expect(dnsTargetLabel({ address: "203.0.113.10", configured: "203.0.113.10" })).toBe("203.0.113.10");
    expect(dnsTargetLabel({ address: "203.0.113.10", configured: "host.example.com" })).toBe("203.0.113.10 (host.example.com)");
    expect(dnsTargetLabel({ address: null, configured: null })).toBeNull();
  });

  it("dnsMismatchGuidanceMessage: the record type by address family", () => {
    expect(dnsMismatchGuidanceMessage("203.0.113.10", "203.0.113.10")).toBe("Required DNS record type A pointing to 203.0.113.10");
    expect(dnsMismatchGuidanceMessage("[2001:db8::1] (host.example.com)")).toBe("Required DNS record type AAAA pointing to 2001:db8::1");
    expect(dnsMismatchGuidanceMessage(null, null)).toBe("DNS validation failed. Check your DNS records.");
  });
});

type DomainRows = Array<Record<string, unknown>>;
const rows = (r: Answer) => (r.data.domains as { rows: DomainRows }).rows;
const urls = (r: Answer) => rows(r).map((row) => row.url);
const UNAVAILABLE = "Checking DNS is not available yet.";
const skipped = (ip: string | null = "203.0.113.10") => ({ status: "skipped", message: "DNS check could not be started.", expected_ip: ip, checked_at: NOW, check_id: expect.stringMatching(/^[a-z0-9]{24}$/) });

describe("the Domains page (Domains)", () => {
  it("shows the domains as rows with their port, indexing and DNS status, and the redirect settings", async () => {
    const t = setup();
    const r = await t.get("domains");
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ canUpdate: true, canDeploy: true, application: { uuid: "app1", fqdn: SSLIP } });
    expect(r.data.domains).toEqual({
      rows: [
        {
          url: SSLIP,
          publicUrl: SSLIP,
          internalPort: 80,
          hasPortOverride: false,
          inheritedPort: 80,
          dnsStatus: "pending",
          dnsMessage: "Not checked yet.",
          expectedIp: "203.0.113.10",
          checkedAt: null,
          isNoindexed: false,
          parts: { scheme: "http", host: "app1.203.0.113.10.sslip.io", port: "", path: "" },
        },
      ],
      redirect: "both",
      isForceHttpsEnabled: true,
      isPermanentRedirectEnabled: false,
      labelsAreWritable: false,
      isCompose: false,
      dnsValidationEnabled: true,
      serverIp: "203.0.113.10",
      dnsTargetLabel: "203.0.113.10",
    });
  });

  it("reads port overrides, noindex flags and stored DNS results; a failed check sorts first", async () => {
    const t = setup();
    Object.assign(t.store.app, {
      fqdn: "https://example.com,https://www.example.com/shop,https://api.example.com",
      ports_exposes: null,
      domain_port_overrides: JSON.stringify({ "https://www.example.com/shop": 3000 }),
      noindex_domains: ["https://www.example.com/shop"],
      domain_dns_statuses: { "https://api.example.com": { status: "failed", message: "Required DNS record type A pointing to 203.0.113.10", expected_ip: "198.51.100.7", checked_at: "2026-11-01T00:00:00+00:00" } },
    });
    const r = await t.get("domains");
    expect(rows(r)).toEqual([
      expect.objectContaining({ url: "https://api.example.com", dnsStatus: "failed", dnsMessage: "Required DNS record type A pointing to 203.0.113.10", expectedIp: "198.51.100.7", checkedAt: "2026-11-01T00:00:00+00:00", internalPort: null, inheritedPort: null }),
      expect.objectContaining({ url: "https://example.com", dnsStatus: "pending", internalPort: null, hasPortOverride: false, isNoindexed: false }),
      expect.objectContaining({ url: "https://www.example.com/shop", internalPort: 3000, hasPortOverride: true, isNoindexed: true, parts: { scheme: "https", host: "www.example.com", port: "3000", path: "/shop" } }),
    ]);
  });

  it("adds a domain with its www counterpart, lower-cased, and stores the DNS checks as not started (addDomain)", async () => {
    const t = setup();
    const r = await t.patch("domains", { action: "add", newDomainParts: { scheme: "https", host: "Example.com", port: "", path: "" } });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ message: "Domain added.", warning: null, notices: [], unavailable: UNAVAILABLE, application: { fqdn: `${SSLIP},https://example.com,https://www.example.com` } });
    expect(urls(r)).toEqual([SSLIP, "https://example.com", "https://www.example.com"]);
    expect(rows(r)[1]).toMatchObject({ dnsStatus: "skipped", dnsMessage: "DNS check could not be started.", checkedAt: NOW, internalPort: 80 });
    expect(t.store.applicationWrites).toEqual([{ fqdn: `${SSLIP},https://example.com,https://www.example.com`, domain_dns_statuses: expect.any(String) }]);
    expect(t.store.stored("domain_dns_statuses")).toEqual({ "https://example.com": skipped(), "https://www.example.com": skipped() });

    // A list in one field, without parts; a www domain gets its bare counterpart.
    const list = await t.patch("domains", { action: "add", newDomain: "https://www.shop.example.org, http://203.0.113.20" });
    expect(urls(list).slice(3)).toEqual(["https://www.shop.example.org", "http://203.0.113.20", "https://shop.example.org"]);
  });

  it("a port goes to domain_port_overrides, for the domain and its counterpart; an unknown port needs a confirmation", async () => {
    const t = setup();
    const body = { action: "add", newDomainParts: { scheme: "https", host: "api.example.com", port: "3000", path: "v1" } };
    const warned = await t.patch("domains", body);
    expect([warned.status, warned.error.code, warned.error.details.unrecognizedPort]).toEqual([409, "conflict", 3000]);
    expect(warned.error.message).toBe("Port 3000 is not listed in Ports Exposes and is not used by any application domain. The proxy will still route to it, but the container may not be listening there.");
    expect(t.store.applicationWrites).toEqual([]);

    const r = await t.patch("domains", { ...body, forceUseUnknownPort: true });
    expect(r.status).toBe(200);
    expect(t.store.app.fqdn).toBe(`${SSLIP},https://api.example.com/v1,https://www.api.example.com/v1`);
    expect(t.store.stored("domain_port_overrides")).toEqual({ "https://api.example.com/v1": 3000, "https://www.api.example.com/v1": 3000 });
    expect(rows(r)[1]).toMatchObject({ url: "https://api.example.com/v1", publicUrl: "https://api.example.com/v1", internalPort: 3000, hasPortOverride: true, inheritedPort: 80, parts: { scheme: "https", host: "api.example.com", port: "3000", path: "/v1" } });
    // As in Coolify, a domain entered with a port has no row under that URL to mark as checking.
    expect(t.store.app.domain_dns_statuses).toBeNull();
    expect(r.data.unavailable).toBeNull();

    // A port the application exposes, or one a domain already uses, needs no confirmation.
    expect((await t.patch("domains", { action: "add", newDomainParts: { scheme: "https", host: "a.example.com", port: "80", path: "" } })).status).toBe(200);
    expect((await t.patch("domains", { action: "add", newDomainParts: { scheme: "https", host: "b.example.com", port: 3000, path: "" } })).status).toBe(200);
  });

  it("answers addDomain's errors and stores nothing", async () => {
    const t = setup();
    await t.patch("domains", { action: "add", newDomain: "https://example.com" });
    const writes = t.store.applicationWrites.length;
    expect(await t.fields("domains", { action: "add", newDomain: "https://EXAMPLE.com" })).toEqual({ newDomain: ["Domain https://example.com is already configured."] });
    expect(await t.fields("domains", { action: "add", newDomain: "https://example.com:8443" })).toEqual({ newDomain: ["Domain https://example.com:8443 is already configured."] });
    expect(await t.fields("domains", { action: "add", newDomain: "" })).toEqual({ newDomain: ["Please enter a valid domain URL."] });
    expect(await t.fields("domains", { action: "add" })).toEqual({ newDomain: ["Please enter a valid domain URL."] });
    expect(await t.fields("domains", { action: "add", newDomainParts: { scheme: "https", host: "", port: "", path: "" } })).toEqual({ newDomain: ["Invalid URL: https://"] });
    expect(await t.fields("domains", { action: "add", newDomainParts: { scheme: "https", host: "bad host", port: "", path: "" } })).toEqual({ newDomain: ["Invalid URL: https://bad host"] });
    expect(await t.fields("domains", { action: "add", newDomain: "https://intranet" })).toEqual({ newDomain: ["Invalid URL: https://intranet. The hostname must be a fully qualified domain name."] });
    expect(await t.fields("domains", { action: "add", newDomain: "https://a.example.com;id" })).toEqual({ newDomain: ["Invalid URL: https://a.example.com;id"] });
    expect(await t.fields("domains", { action: "add", newDomain: 5 })).toEqual({ newDomain: ["The new domain field must be a string."] });
    expect(await t.fields("domains", { action: "add", newDomain: `https://${"a".repeat(2040)}.example.com` })).toEqual(expect.objectContaining({ newDomain: expect.arrayContaining(["The new domain field must not be greater than 2048 characters."]) }));
    expect(await t.fields("domains", { action: "dance" })).toEqual({ action: ["The selected action is invalid."] });
    expect(t.store.applicationWrites.length).toBe(writes);
  });

  it("refuses a domain another application of the org uses, unless the save is forced (checkDomainUsage)", async () => {
    const t = setup();
    t.store.rows.push(application(2, "app2", { name: "billing", fqdn: "https://taken.example.com" }));
    const body = { action: "add", newDomain: "https://taken.example.com/" };
    const r = await t.patch("domains", body);
    expect([r.status, r.error.code, r.error.message]).toEqual([409, "conflict", "Domains are already in use by other resources."]);
    expect(r.error.details.conflicts).toEqual([
      { domain: "https://taken.example.com", resource_name: "billing", resource_uuid: "app2", resource_type: "application", message: "Domain https://taken.example.com is already in use by application 'billing'" },
    ]);
    expect(t.store.applicationWrites).toEqual([]);
    const forced = await t.patch("domains", { ...body, forceSaveDomains: true });
    expect(forced.status).toBe(200);
    expect(urls(forced)).toEqual([SSLIP, "https://taken.example.com/", "https://www.taken.example.com/"]);
  });

  it("domains are not edited here while the container labels are writable", async () => {
    const t = setup();
    t.store.app.is_container_label_readonly_enabled = false;
    expect((await t.get("domains")).data.domains).toMatchObject({ labelsAreWritable: true });
    const add = await t.patch("domains", { action: "add", newDomain: "https://example.com" });
    expect([add.status, add.error.message]).toEqual([422, "Domains cannot be edited while container labels are writable. Set domains in the Labels section on General."]);
    for (const body of [{ action: "update", url: SSLIP, editingDomain: "https://example.com" }, { action: "remove", url: SSLIP }, { action: "generate" }, { action: "regenerateHostname" }]) {
      const r = await t.patch("domains", body);
      expect([body.action, r.status, r.error.message]).toEqual([body.action, 422, "Domains cannot be edited while container labels are writable."]);
    }
    expect(t.store.applicationWrites).toEqual([]);
  });

  it("edits a domain: its address, its port, its search indexing (updateDomain)", async () => {
    const t = setup();
    Object.assign(t.store.app, { fqdn: "https://example.com,https://www.example.com", domain_dns_statuses: { "https://example.com": { status: "ok", message: "DNS looks correct.", expected_ip: "203.0.113.10", checked_at: "2026-11-01T00:00:00+00:00" } } });
    // A port of its own, and noindex. The www counterpart without a port takes the same one (DomainPortOverrides).
    const port = await t.patch("domains", { action: "update", url: "https://example.com", editingDomainParts: { scheme: "https", host: "example.com", port: "8080", path: "" }, editingIndexing: "noindex", forceUseUnknownPort: true });
    expect(port.data).toMatchObject({ message: "Domain updated.", unavailable: null });
    expect(t.store.applicationWrites).toEqual([{ domain_port_overrides: JSON.stringify({ "https://example.com": 8080, "https://www.example.com": 8080 }), noindex_domains: JSON.stringify(["https://example.com"]) }]);
    expect(rows(port)[0]).toMatchObject({ url: "https://example.com", internalPort: 8080, hasPortOverride: true, isNoindexed: true, dnsStatus: "ok" });

    // The same port again needs no confirmation; an empty port removes the domain's override.
    expect((await t.patch("domains", { action: "update", url: "https://example.com", editingDomainParts: { scheme: "https", host: "example.com", port: "8080", path: "" } })).status).toBe(200);
    const cleared = await t.patch("domains", { action: "update", url: "https://example.com", editingDomainParts: { scheme: "https", host: "example.com", port: "", path: "" }, editingIndexing: "index" });
    expect(t.store.stored("domain_port_overrides")).toEqual({ "https://www.example.com": 8080 });
    expect(t.store.stored("noindex_domains")).toEqual([]);
    expect(rows(cleared)[0]).toMatchObject({ internalPort: 80, hasPortOverride: false, isNoindexed: false });

    // A new host: the old DNS result goes, the new host is checked.
    const moved = await t.patch("domains", { action: "update", url: "https://example.com", editingDomain: "https://Shop.Example.com/store" });
    expect(urls(moved)).toEqual(["https://shop.example.com/store", "https://www.example.com"]);
    expect(moved.data).toMatchObject({ unavailable: UNAVAILABLE });
    expect(t.store.stored("domain_dns_statuses")).toEqual({ "https://shop.example.com/store": skipped() });
  });

  it("answers updateDomain's errors", async () => {
    const t = setup();
    t.store.app.fqdn = "https://example.com,https://www.example.com";
    const edit = (over: Record<string, unknown>) => t.fields("domains", { action: "update", url: "https://example.com", editingDomain: "https://example.com", ...over });
    expect(await edit({ editingDomain: "https://a.example.com,https://b.example.com" })).toEqual({ editingDomain: ["Please enter a single valid domain URL."] });
    expect(await edit({ editingDomain: "" })).toEqual({ editingDomain: ["Please enter a single valid domain URL."] });
    expect(await edit({ editingDomain: "ftp://example.com" })).toEqual({ editingDomain: ["Invalid URL: ftp://example.com"] });
    expect(await edit({ editingDomain: "https://www.example.com" })).toEqual({ editingDomain: ["Domain https://www.example.com is already configured."] });
    expect(await edit({ editingIndexing: "maybe", editingRedirect: "sideways" })).toEqual({ editingIndexing: ["The selected editing indexing is invalid."], editingRedirect: ["The selected editing redirect is invalid."] });
    expect(await edit({ editingIndexing: "" })).toEqual({ editingIndexing: ["The editing indexing field is required."] });
    const missing = await t.patch("domains", { action: "update", url: "https://nope.example.com", editingDomain: "https://example.com" });
    expect([missing.status, missing.error.code]).toEqual([404, "not_found"]);
    const warned = await t.patch("domains", { action: "update", url: "https://example.com", editingDomainParts: { scheme: "https", host: "example.com", port: "9000", path: "" } });
    expect([warned.status, warned.error.details.unrecognizedPort]).toEqual([409, 9000]);
    expect(t.store.applicationWrites).toEqual([]);
  });

  it("a www redirect set in the dialog adds the missing counterparts, sslip hosts included", async () => {
    const t = setup();
    t.store.app.fqdn = `${SSLIP},https://example.com`;
    const r = await t.patch("domains", { action: "update", url: "https://example.com", editingDomain: "https://example.com", editingRedirect: "www" });
    expect(r.status).toBe(200);
    expect(r.data.domains).toMatchObject({ redirect: "www" });
    expect(urls(r)).toEqual([SSLIP, "https://example.com", "http://www.app1.203.0.113.10.sslip.io", "https://www.example.com"]);
    expect(t.store.applicationWrites[0]).toMatchObject({ redirect: "www", fqdn: `${SSLIP},https://example.com,http://www.app1.203.0.113.10.sslip.io,https://www.example.com` });
    // The added hosts are checked: sslip.io is accepted without asking DNS, the other needs the check job.
    expect(t.store.stored("domain_dns_statuses")).toEqual({
      "http://www.app1.203.0.113.10.sslip.io": { status: "ok", message: "DNS looks correct.", expected_ip: "203.0.113.10", checked_at: NOW },
      "https://www.example.com": skipped(),
    });
    expect(r.data.unavailable).toBe(UNAVAILABLE);
  });

  it("after 'Regenerate hostname' the redirect's counterpart moves to the new hostname too", async () => {
    const t = setup();
    Object.assign(t.store.app, { fqdn: "https://example.com/app,https://www.example.com/app", redirect: "non-www", domain_port_overrides: { "https://www.example.com/app": 80 } });
    const host = (await t.patch("domains", { action: "regenerateHostname" })).data.host as string;
    expect(host).toMatch(/^[a-z0-9]{24}\.203\.0\.113\.10\.sslip\.io$/);
    expect(t.store.applicationWrites).toEqual([]);
    const r = await t.patch("domains", { action: "update", url: "https://example.com/app", editingDomainParts: { scheme: "https", host, port: "", path: "/app" }, generatedHost: host });
    expect(urls(r)).toEqual([`https://${host}/app`, `https://www.${host}/app`]);
    expect(t.store.stored("domain_port_overrides")).toEqual({ [`https://${host}/app`]: 80, [`https://www.${host}/app`]: 80 });
    // https on sslip.io: Coolify's warning comes with the save.
    expect(r.data.warning).toBe(
      "Your configuration is saved, but sslip domain with https is NOT recommended, because Let's Encrypt servers with this public domain are rate limited (SSL certificate validation will fail). Use your own domain instead.",
    );
  });

  it("removes a domain with its port override, noindex flag and DNS status (removeDomain)", async () => {
    const t = setup();
    Object.assign(t.store.app, {
      fqdn: `${SSLIP},https://example.com,https://www.example.com`,
      domain_port_overrides: { "https://example.com": 3000 },
      noindex_domains: ["https://example.com", "https://www.example.com"],
      domain_dns_statuses: { "https://example.com": { status: "ok", message: "x", expected_ip: null, checked_at: null }, "https://www.example.com": { status: "failed", message: "y", expected_ip: null, checked_at: null } },
    });
    const r = await t.patch("domains", { action: "remove", url: "https://example.com" });
    expect(r.data).toMatchObject({ message: "Domain removed.", unavailable: null });
    expect(urls(r)).toEqual(["https://www.example.com", SSLIP]);
    expect(t.store.app.fqdn).toBe(`${SSLIP},https://www.example.com`);
    expect(t.store.app.domain_port_overrides).toBeNull();
    expect(t.store.stored("noindex_domains")).toEqual(["https://www.example.com"]);
    expect(t.store.stored("domain_dns_statuses")).toEqual({ "https://www.example.com": { status: "failed", message: "y", expected_ip: null, checked_at: null } });
    // The last domains: fqdn is null.
    await t.patch("domains", { action: "remove", url: "https://www.example.com" });
    const last = await t.patch("domains", { action: "remove", url: SSLIP });
    expect(t.store.app.fqdn).toBeNull();
    expect(t.store.app.domain_dns_statuses).toBeNull();
    expect(rows(last)).toEqual([]);
    expect((await t.patch("domains", { action: "remove", url: SSLIP })).status).toBe(404);
  });

  it("generates the application's domain from the server's wildcard domain, else sslip.io (generateDomain)", async () => {
    const t = setup();
    t.store.app.fqdn = null;
    const r = await t.patch("domains", { action: "generate" });
    expect(r.data).toMatchObject({ message: "Domain generated.", unavailable: null, warning: null });
    expect(urls(r)).toEqual([SSLIP]);
    // CheckDomainDns accepts an sslip.io host without asking DNS.
    expect(t.store.stored("domain_dns_statuses")).toEqual({ [SSLIP]: { status: "ok", message: "DNS looks correct.", expected_ip: "203.0.113.10", checked_at: NOW } });
    expect(rows(r)[0]).toMatchObject({ dnsStatus: "ok", dnsMessage: "DNS looks correct.", checkedAt: NOW });
    // The same URL every time: nothing more to add.
    await t.patch("domains", { action: "generate" });
    expect(t.store.app.fqdn).toBe(SSLIP);

    const wildcard = setup();
    Object.assign(wildcard.store.app, { fqdn: null, server_wildcard_domain: "https://apps.example.com", redirect: "www" });
    const w = await wildcard.patch("domains", { action: "generate" });
    // A www redirect gets its counterpart at once (syncRedirectDomainPairs).
    expect(urls(w)).toEqual(["https://app1.apps.example.com", "https://www.app1.apps.example.com"]);
    expect(w.data.unavailable).toBe(UNAVAILABLE);

    const homeless = setup();
    homeless.store.app.server_id = null;
    const none = await homeless.patch("domains", { action: "generate" });
    expect([none.status, none.error.message]).toEqual([422, "No server found for this application."]);
  });

  it("sets the www redirect, adding the counterparts it needs (setRedirect)", async () => {
    const t = setup();
    t.store.app.fqdn = "https://example.com";
    const r = await t.patch("domains", { action: "redirect", redirect: "non-www" });
    expect(r.data).toMatchObject({ message: "Redirect updated.", unavailable: UNAVAILABLE });
    expect(r.data.domains).toMatchObject({ redirect: "non-www" });
    expect(urls(r)).toEqual(["https://example.com", "https://www.example.com"]);
    expect(t.store.applicationWrites).toEqual([{ fqdn: "https://example.com,https://www.example.com", redirect: "non-www", domain_dns_statuses: expect.any(String) }]);
    expect((await t.patch("domains", { action: "redirect", redirect: "both" })).data.domains).toMatchObject({ redirect: "both" });
    expect(urls(await t.get("domains"))).toEqual(["https://example.com", "https://www.example.com"]);

    expect(await t.fields("domains", { action: "redirect", redirect: "sideways" })).toEqual({ redirect: ["The Redirect setting must be both, www, or non-www."] });
    expect(await t.fields("domains", { action: "redirect" })).toEqual({ redirect: ["The Redirect setting is required."] });
    expect(await t.fields("domains", { action: "redirect", redirect: 5 })).toEqual({ redirect: ["The Redirect setting must be a string.", "The Redirect setting must be both, www, or non-www."] });
  });

  it("a redirect needs a www and a non-www host: an IP address has no counterpart", async () => {
    const t = setup();
    t.store.app.fqdn = "http://203.0.113.10";
    const r = await t.patch("domains", { action: "redirect", redirect: "www" });
    expect(r.status).toBe(422);
    expect(r.error.message).toBe(
      "Redirect requires both www and non-www domains, but the www host could not be added automatically (e.g. only IP/sslip hosts).\n\nPlease add the www domain manually (Required DNS record type A pointing to 203.0.113.10).",
    );
    expect(t.store.applicationWrites).toEqual([]);
    // A counterpart another application uses is a conflict, as for any added domain.
    t.store.app.fqdn = "https://example.com";
    t.store.rows.push(application(2, "app2", { name: "billing", fqdn: "https://www.example.com" }));
    expect((await t.patch("domains", { action: "redirect", redirect: "www" })).status).toBe(409);
    expect((await t.patch("domains", { action: "redirect", redirect: "www", forceSaveDomains: true })).status).toBe(200);
  });

  it("saves the two switches of the Redirects section", async () => {
    const t = setup();
    expect((await t.patch("domains", { action: "forceHttps", isForceHttpsEnabled: false })).data).toMatchObject({ message: "HTTP to HTTPS redirect updated.", domains: { isForceHttpsEnabled: false } });
    expect((await t.patch("domains", { action: "permanentRedirect", isPermanentRedirectEnabled: true })).data).toMatchObject({ message: "Redirect type updated.", domains: { isPermanentRedirectEnabled: true } });
    expect(t.store.settingsWrites).toEqual([{ is_force_https_enabled: false }, { is_permanent_redirect_enabled: true }]);
    expect(await t.fields("domains", { action: "forceHttps", isForceHttpsEnabled: "maybe" })).toEqual({ isForceHttpsEnabled: ["The is force https enabled field must be true or false."] });
    expect(await t.fields("domains", { action: "permanentRedirect" })).toEqual({ isPermanentRedirectEnabled: ["The is permanent redirect enabled field must be true or false."] });
  });

  it("checking DNS: an sslip.io host is accepted, any other host is stored as not started and reported as not available", async () => {
    const t = setup();
    t.store.app.fqdn = `${SSLIP},https://example.com`;
    const one = await t.patch("domains", { action: "checkDns", url: SSLIP });
    expect(one.data).toMatchObject({ message: null, notices: ["DNS is configured correctly for app1.203.0.113.10.sslip.io."], unavailable: null });
    const all = await t.patch("domains", { action: "checkDns" });
    expect(all.data).toMatchObject({ notices: ["DNS is configured correctly for app1.203.0.113.10.sslip.io."], unavailable: UNAVAILABLE });
    expect(t.store.stored("domain_dns_statuses")).toEqual({ [SSLIP]: { status: "ok", message: "DNS looks correct.", expected_ip: "203.0.113.10", checked_at: NOW }, "https://example.com": skipped() });
    expect(rows(all).map((row) => [row.url, row.dnsStatus])).toEqual([
      [SSLIP, "ok"],
      ["https://example.com", "skipped"],
    ]);
    expect((await t.patch("domains", { action: "checkDns", url: "https://nope.example.com" })).status).toBe(404);

    const homeless = setup();
    homeless.store.app.server_id = null;
    await homeless.patch("domains", { action: "checkDns" });
    expect(homeless.store.stored("domain_dns_statuses")).toEqual({ "http://app1.203.0.113.10.sslip.io": { status: "skipped", message: "No server available for DNS validation.", expected_ip: null, checked_at: NOW } });
  });
});

// ---------------------------------------------------------------- routing

describe("routing and authorization", () => {
  const SECTIONS: ApplicationSettingsSection[] = ["domains", "advanced", "healthcheck", "resource-limits"];

  it("each page is GET and PATCH; an application that is not the org's is 404", async () => {
    const t = setup();
    for (const section of SECTIONS) {
      expect([section, (await t.get(section)).status]).toEqual([section, 200]);
      expect([section, (await t.get(section, "nope")).status]).toEqual([section, 404]);
      expect([section, (await t.patch(section, { action: "generate", toggle: true }, "nope")).status]).toEqual([section, 404]);
      for (const method of ["POST", "PUT", "DELETE"]) expect([section, method, (await t.call(method, section, {})).status]).toEqual([section, method, 405]);
    }
    expect((await t.get("domains", "bad uuid")).status).toBe(404);
  });

  it("a member without deploy.resource.write reads with canUpdate false and gets 404 on every save", async () => {
    const t = setup({ write: false });
    for (const section of SECTIONS) {
      const r = await t.get(section);
      expect([section, r.status, r.data.canUpdate, r.data.canDeploy]).toEqual([section, 200, false, false]);
      expect([section, (await t.patch(section, { action: "generate", toggle: true, limitsCpus: "1" })).status]).toEqual([section, 404]);
    }
    expect(t.store.applicationWrites).toEqual([]);
    expect(t.store.settingsWrites).toEqual([]);
  });

  it("a member without deploy.resource.read gets 404 on every read", async () => {
    const t = setup({ read: false, write: false });
    for (const section of SECTIONS) expect([section, (await t.get(section)).status]).toEqual([section, 404]);
  });

  it("handleApplications and route() send the four pages here, behind the same checks", async () => {
    const t = setup({ read: false, write: false });
    for (const section of SECTIONS) {
      const viaHandler = await handleApplications(t.env, "req_1", actor, ORG_UUID, ["app1", section], new Request(`${BASE}/applications/app1/${section}`));
      expect([section, viaHandler.status]).toEqual([section, 404]);
      const viaRoute = await route(new Request(`${BASE}/applications/app1/${section}`, { headers: { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" } }), t.env);
      expect([section, viaRoute.status]).toEqual([section, 404]);
    }
    expect(t.asked.filter((a) => a === "deploy.resource.read").length).toBe(8);
    // Any other name below an application is still not a route.
    const other = await handleApplications(t.env, "req_1", actor, ORG_UUID, ["app1", "environment-variables-x"], new Request(`${BASE}/applications/app1/environment-variables-x`));
    expect(other.status).toBe(404);
  });
});
