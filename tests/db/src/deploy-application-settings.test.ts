// deploy.applications and deploy.application_settings for the Domains,
// Advanced, Healthcheck and Resource Limits pages (DP-52) against a real
// Postgres: the store functions of @saas/db/deploy inside withOrg() — what a
// new Docker image application reads as (the schema's defaults, column by
// column), the two updates writing only the given columns, the container names
// of a server's applications — and row-level security keeping each org's
// applications to itself.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  insertPrivateKey,
  insertServer,
  insertProject,
  insertDestination,
  insertDockerImageApplication,
  listServerDestinations,
  findApplicationConfiguration,
  updateApplicationConfiguration,
  updateApplicationSettings,
  listServerApplicationContainerNames,
  APPLICATION_WEBHOOK_SECRET_COLUMNS,
  type DeployDestinationRow,
  type NewDockerImageApplication,
} from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, executor } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

let db: PGlite;
let ex: TransactionalSqlExecutor;

interface Fixture {
  serverId: string | number;
  destination: DeployDestinationRow;
  swarm: DeployDestinationRow;
  environmentId: string | number;
}
const fx: Record<string, Fixture> = {};

async function fixture(org: string, tag: string): Promise<Fixture> {
  return withOrg(ex, org, async (tx) => {
    const key = await insertPrivateKey(tx, { orgId: org, uuid: `key${tag}`, name: "key", description: null, privateKey: "fp1:fake", fingerprint: null });
    const server = await insertServer(tx, {
      orgId: org, uuid: `srv${tag}`, name: `server-${tag}`, description: null, ip: "203.0.113.10", user: "root", port: 22, privateKeyId: key.id,
      proxy: { type: "TRAEFIK", status: "exited" }, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: `dst${tag}`,
    });
    const destination = (await listServerDestinations(tx, server.id))[0]!;
    const swarm = await insertDestination(tx, { orgId: org, type: "swarm", uuid: `swm${tag}`, name: "overlay", network: "coolify-overlay", serverId: server.id });
    const { environment } = await insertProject(tx, { orgId: org, uuid: `prj${tag}`, name: `project-${tag}`, description: null, productionEnvironmentUuid: `env${tag}` });
    return { serverId: server.id, destination, swarm, environmentId: environment.id };
  });
}

const newApp = (org: string, f: Fixture, uuid: string, over: Partial<NewDockerImageApplication> = {}): NewDockerImageApplication => ({
  orgId: org,
  uuid,
  name: `docker-image-${uuid}`,
  fqdn: `http://${uuid}.203.0.113.10.sslip.io`,
  domainPortOverrides: null,
  dockerRegistryImageName: "nginx",
  dockerRegistryImageTag: "latest",
  environmentId: f.environmentId,
  destinationId: f.destination.id,
  destinationType: "standalone",
  webhookSecrets: Object.fromEntries(APPLICATION_WEBHOOK_SECRET_COLUMNS.map((c) => [c, `fp1:${uuid}:${c}`])) as NewDockerImageApplication["webhookSecrets"],
  ...over,
});

const raw = async (table: string, where: string, params: unknown[]) =>
  (await asPlatformAdmin(ex, (tx) => tx.execute<Record<string, unknown>>(`SELECT * FROM deploy.${table} WHERE ${where}`, params))).rows;

/** A JSON column, whichever way the driver hands it back. */
const parsed = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);

beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
  fx.a = await fixture(A, "a");
  fx.b = await fixture(B, "b");
  await withOrg(ex, A, async (tx) => {
    await insertDockerImageApplication(tx, newApp(A, fx.a!, "app1aaaaaaaaaaaaaaaaaaaa"));
    await insertDockerImageApplication(tx, newApp(A, fx.a!, "app2aaaaaaaaaaaaaaaaaaaa", { fqdn: null, destinationId: fx.a!.swarm.id, destinationType: "swarm" }));
  });
  await withOrg(ex, B, (tx) => insertDockerImageApplication(tx, newApp(B, fx.b!, "app1bbbbbbbbbbbbbbbbbbbb")));
}, 120_000);
afterAll(async () => db?.close());

describe("an application's configuration pages (deploy.applications, deploy.application_settings)", () => {
  it("reads a new Docker image application with the defaults the pages start from, its settings and its server", async () => {
    const row = await withOrg(ex, A, (tx) => findApplicationConfiguration(tx, "app1aaaaaaaaaaaaaaaaaaaa"));
    expect(row).toMatchObject({
      uuid: "app1aaaaaaaaaaaaaaaaaaaa",
      build_pack: "dockerimage",
      status: "exited",
      ports_exposes: "80",
      has_dockerfile: false,
      // Domains
      fqdn: "http://app1aaaaaaaaaaaaaaaaaaaa.203.0.113.10.sslip.io",
      redirect: "both",
      domain_port_overrides: null,
      noindex_domains: null,
      domain_dns_statuses: null,
      is_force_https_enabled: true,
      is_permanent_redirect_enabled: false,
      is_container_label_readonly_enabled: true,
      // Healthcheck: DockerImage::submit() turns it off; the rest is the schema's.
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
      // Resource Limits
      limits_cpus: "0",
      limits_cpuset: null,
      limits_cpu_shares: 1024,
      limits_memory: "0",
      limits_memory_swap: "0",
      limits_memory_swappiness: 60,
      limits_memory_reservation: "0",
      // Advanced
      max_restart_count: 0,
      is_static: false,
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
      // destination.server and its settings
      server_uuid: "srva",
      server_name: "server-a",
      server_ip: "203.0.113.10",
      server_wildcard_domain: null,
      server_public_ipv4: null,
      server_public_ipv6: null,
      server_traefik_certificate_resolver: "letsencrypt",
      server_is_reachable: false,
      server_is_usable: false,
      server_force_disabled: false,
      server_is_logdrain_newrelic_enabled: false,
      server_is_logdrain_axiom_enabled: false,
      server_is_logdrain_custom_enabled: false,
      server_is_logdrain_cloudwatch_enabled: false,
    });
    expect(String(row!.server_id)).toBe(String(fx.a!.serverId));
    expect(parsed(row!.server_proxy)).toMatchObject({ type: "TRAEFIK" });
    expect(Number(row!.additional_servers)).toBe(0);

    // A Swarm destination resolves to the same server.
    const swarm = await withOrg(ex, A, (tx) => findApplicationConfiguration(tx, "app2aaaaaaaaaaaaaaaaaaaa"));
    expect(swarm).toMatchObject({ fqdn: null, server_uuid: "srva" });
    expect(await withOrg(ex, A, (tx) => findApplicationConfiguration(tx, "missing"))).toBeNull();
  });

  it("the application update writes only the given columns, JSON columns as JSON", async () => {
    const before = (await raw("applications", "uuid = $1", ["app1aaaaaaaaaaaaaaaaaaaa"]))[0]!;
    const statuses = { "https://example.com": { status: "skipped", message: "DNS check could not be started.", expected_ip: "203.0.113.10", checked_at: "2026-11-24T10:00:00+00:00", check_id: "abc" } };
    const ok = await withOrg(ex, A, (tx) =>
      updateApplicationConfiguration(tx, before.id as number, {
        fqdn: "https://example.com,https://www.example.com",
        redirect: "www",
        domain_port_overrides: JSON.stringify({ "https://example.com": 3000 }),
        noindex_domains: JSON.stringify(["https://example.com"]),
        domain_dns_statuses: JSON.stringify(statuses),
        health_check_enabled: true,
        health_check_type: "cmd",
        health_check_command: "pg_isready -U postgres",
        health_check_port: "8080",
        health_check_return_code: 204,
        limits_cpus: "1.5",
        limits_cpuset: "0-2",
        limits_cpu_shares: 512,
        limits_memory: "512m",
        limits_memory_swappiness: 10,
        max_restart_count: 3,
      }),
    );
    expect(ok).toBe(true);
    const row = (await withOrg(ex, A, (tx) => findApplicationConfiguration(tx, "app1aaaaaaaaaaaaaaaaaaaa")))!;
    expect(row).toMatchObject({
      fqdn: "https://example.com,https://www.example.com",
      redirect: "www",
      health_check_enabled: true,
      health_check_type: "cmd",
      health_check_command: "pg_isready -U postgres",
      health_check_port: "8080",
      health_check_return_code: 204,
      limits_cpus: "1.5",
      limits_cpuset: "0-2",
      limits_cpu_shares: 512,
      limits_memory: "512m",
      limits_memory_swappiness: 10,
      max_restart_count: 3,
      // Not given: unchanged.
      health_check_method: "GET",
      health_check_path: "/",
      limits_memory_swap: "0",
      limits_memory_reservation: "0",
    });
    expect(parsed(row.domain_port_overrides)).toEqual({ "https://example.com": 3000 });
    expect(parsed(row.noindex_domains)).toEqual(["https://example.com"]);
    expect(parsed(row.domain_dns_statuses)).toEqual(statuses);
    const after = (await raw("applications", "uuid = $1", ["app1aaaaaaaaaaaaaaaaaaaa"]))[0]!;
    expect(after.name).toBe(before.name);
    expect(after.docker_registry_image_name).toBe("nginx");

    // A JSON column cleared, a nullable one emptied; no column at all is a no-op.
    await withOrg(ex, A, (tx) => updateApplicationConfiguration(tx, before.id as number, { domain_dns_statuses: null, domain_port_overrides: null, limits_cpuset: null, health_check_command: null }));
    expect(await withOrg(ex, A, (tx) => findApplicationConfiguration(tx, "app1aaaaaaaaaaaaaaaaaaaa"))).toMatchObject({ domain_dns_statuses: null, domain_port_overrides: null, limits_cpuset: null, health_check_command: null });
    expect(await withOrg(ex, A, (tx) => updateApplicationConfiguration(tx, before.id as number, {}))).toBe(true);
    // The redirect is one of Coolify's three values (the schema's check).
    await expect(withOrg(ex, A, (tx) => updateApplicationConfiguration(tx, before.id as number, { redirect: "sideways" }))).rejects.toThrow();
    expect(await withOrg(ex, A, (tx) => updateApplicationConfiguration(tx, 999_999, { redirect: "both" }))).toBe(false);
  });

  it("the settings update writes only the given columns", async () => {
    const id = (await raw("applications", "uuid = $1", ["app1aaaaaaaaaaaaaaaaaaaa"]))[0]!.id as number;
    const ok = await withOrg(ex, A, (tx) =>
      updateApplicationSettings(tx, id, {
        is_force_https_enabled: false,
        is_permanent_redirect_enabled: true,
        disable_build_cache: true,
        is_consistent_container_name_enabled: true,
        custom_internal_name: "shop-api",
        custom_container_name_prefix: "shop",
        stop_grace_period: 60,
        rolling_update_drain_seconds: 0,
        is_gpu_enabled: true,
        gpu_driver: "nvidia",
        gpu_count: "all",
        gpu_options: "capabilities=gpu",
        is_gzip_enabled: false,
        traefik_certificate_resolver: "cloudflare",
      }),
    );
    expect(ok).toBe(true);
    expect(await withOrg(ex, A, (tx) => findApplicationConfiguration(tx, "app1aaaaaaaaaaaaaaaaaaaa"))).toMatchObject({
      is_force_https_enabled: false,
      is_permanent_redirect_enabled: true,
      disable_build_cache: true,
      is_consistent_container_name_enabled: true,
      custom_internal_name: "shop-api",
      custom_container_name_prefix: "shop",
      stop_grace_period: 60,
      rolling_update_drain_seconds: 0,
      is_gpu_enabled: true,
      gpu_count: "all",
      gpu_options: "capabilities=gpu",
      is_gzip_enabled: false,
      traefik_certificate_resolver: "cloudflare",
      // Not given: unchanged.
      is_stripprefix_enabled: true,
      is_log_drain_enabled: false,
      inject_build_args_to_dockerfile: true,
      is_container_label_readonly_enabled: true,
    });
    await withOrg(ex, A, (tx) => updateApplicationSettings(tx, id, { stop_grace_period: null, traefik_certificate_resolver: null }));
    expect(await withOrg(ex, A, (tx) => findApplicationConfiguration(tx, "app1aaaaaaaaaaaaaaaaaaaa"))).toMatchObject({ stop_grace_period: null, traefik_certificate_resolver: null });
    expect(await withOrg(ex, A, (tx) => updateApplicationSettings(tx, 999_999, { is_gzip_enabled: true }))).toBe(false);
  });

  it("lists the container names of a server's applications, standalone and Swarm (Server::applications)", async () => {
    const names = await withOrg(ex, A, (tx) => listServerApplicationContainerNames(tx, fx.a!.serverId));
    expect(names.map((n) => [n.uuid, n.custom_internal_name, n.custom_container_name_prefix])).toEqual([
      ["app1aaaaaaaaaaaaaaaaaaaa", "shop-api", "shop"],
      ["app2aaaaaaaaaaaaaaaaaaaa", null, null],
    ]);
    expect(await withOrg(ex, A, (tx) => listServerApplicationContainerNames(tx, 999_999))).toEqual([]);
  });

  it("keeps each org's applications to itself (row-level security)", async () => {
    expect(await withOrg(ex, B, (tx) => findApplicationConfiguration(tx, "app1aaaaaaaaaaaaaaaaaaaa"))).toBeNull();
    const id = (await raw("applications", "uuid = $1", ["app1aaaaaaaaaaaaaaaaaaaa"]))[0]!.id as number;
    expect(await withOrg(ex, B, (tx) => updateApplicationConfiguration(tx, id, { redirect: "non-www" }))).toBe(false);
    expect(await withOrg(ex, B, (tx) => updateApplicationSettings(tx, id, { is_gzip_enabled: true }))).toBe(false);
    expect(await withOrg(ex, B, (tx) => listServerApplicationContainerNames(tx, fx.a!.serverId))).toEqual([]);
    const row = (await raw("applications", "id = $1", [id]))[0]!;
    expect(row.redirect).toBe("www");
    expect((await raw("application_settings", "application_id = $1", [id]))[0]!.is_gzip_enabled).toBe(false);
    // Org B reads its own.
    expect(await withOrg(ex, B, (tx) => findApplicationConfiguration(tx, "app1bbbbbbbbbbbbbbbbbbbb"))).toMatchObject({ server_uuid: "srvb", redirect: "both" });
  });
});
