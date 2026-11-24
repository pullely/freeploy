// deploy.applications and deploy.application_settings (DP-49) against a real
// Postgres: the store functions of @saas/db/deploy inside withOrg() — the row
// a Docker image application starts as (Coolify's hooks and the schema's
// defaults, column by column), General's update, the joins to environment,
// project, destination and server — the "has resources" and "attached" guards
// of DP-46 and DP-44 seeing those rows, and row-level security keeping each
// org's applications to itself.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  insertPrivateKey,
  insertServer,
  insertProject,
  insertDestination,
  findApplicationByUuid,
  listEnvironmentApplications,
  insertDockerImageApplication,
  updateApplicationGeneral,
  listApplicationDomains,
  listResourceServers,
  environmentHasResources,
  projectHasResources,
  listProjectsWithCounts,
  destinationIsAttached,
  listDestinationResources,
  listServerDestinations,
  APPLICATION_WEBHOOK_SECRET_COLUMNS,
  DESTINATION_MORPH_CLASS,
  type DeployDestinationRow,
  type NewDockerImageApplication,
} from "@saas/db/deploy";
import type { SqlExecutor, TransactionalSqlExecutor } from "@saas/db/hyperdrive";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SQL = ["500_deploy_core", "510_deploy_org_keys", "520_deploy_schema_fold_fixes"].map((m) => readFileSync(resolve(root, `packages/db/src/migrations/${m}/up.sql`), "utf8")).join("\n");
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

function executor(db: PGlite): TransactionalSqlExecutor {
  const wrap = (q: { query: PGlite["query"] }): SqlExecutor => ({
    async execute(text, params) {
      const r = await q.query(text, params ?? []);
      return { rows: r.rows as never[], rowCount: r.rows.length };
    },
  });
  return { ...wrap(db), transaction: (fn) => db.transaction((tx) => fn(wrap(tx as never))) };
}

let db: PGlite;
let ex: TransactionalSqlExecutor;

interface Fixture {
  serverId: string | number;
  destination: DeployDestinationRow;
  swarm: DeployDestinationRow;
  projectId: string | number;
  environmentId: string | number;
}
const fx: Record<string, Fixture> = {};

async function fixture(org: string, tag: string): Promise<Fixture> {
  return withOrg(ex, org, async (tx) => {
    const key = await insertPrivateKey(tx, { orgId: org, uuid: `key${tag}`, name: "key", description: null, privateKey: "fp1:fake", fingerprint: null });
    const server = await insertServer(tx, {
      orgId: org, uuid: `srv${tag}`, name: `server-${tag}`, description: null, ip: "203.0.113.10", user: "root", port: 22, privateKeyId: key.id,
      proxy: {}, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: `dst${tag}`,
    });
    const destination = (await listServerDestinations(tx, server.id))[0]!;
    const swarm = await insertDestination(tx, { orgId: org, type: "swarm", uuid: `swm${tag}`, name: "overlay", network: "coolify-overlay", serverId: server.id });
    const { project, environment } = await insertProject(tx, { orgId: org, uuid: `prj${tag}`, name: `project-${tag}`, description: null, productionEnvironmentUuid: `env${tag}` });
    return { serverId: server.id, destination, swarm, projectId: project.id, environmentId: environment.id };
  });
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SQL);
  ex = executor(db);
  fx.a = await fixture(A, "a");
  fx.b = await fixture(B, "b");
}, 120_000);
afterAll(async () => db?.close());

const secrets = (tag: string) => Object.fromEntries(APPLICATION_WEBHOOK_SECRET_COLUMNS.map((c) => [c, `fp1:${tag}:${c}`])) as NewDockerImageApplication["webhookSecrets"];

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
  webhookSecrets: secrets(uuid),
  ...over,
});

const raw = async (table: string, where: string, params: unknown[]) =>
  (await asPlatformAdmin(ex, (tx) => tx.execute<Record<string, unknown>>(`SELECT * FROM deploy.${table} WHERE ${where}`, params))).rows;

describe("deploy.applications", () => {
  it("stores a Docker image application as Coolify's DockerImage::submit and the model's hooks do, column by column", async () => {
    const row = await withOrg(ex, A, (tx) => insertDockerImageApplication(tx, newApp(A, fx.a!, "appaaaaaaaaaaaaaaaaaaaaa")));
    expect(row).toMatchObject({
      uuid: "appaaaaaaaaaaaaaaaaaaaaa",
      name: "docker-image-appaaaaaaaaaaaaaaaaaaaaa",
      description: null,
      fqdn: "http://appaaaaaaaaaaaaaaaaaaaaa.203.0.113.10.sslip.io",
      build_pack: "dockerimage",
      status: "exited",
      docker_registry_image_name: "nginx",
      docker_registry_image_tag: "latest",
      ports_exposes: "80",
      ports_mappings: null,
      health_check_enabled: false,
      environment_uuid: "enva",
      environment_name: "production",
      project_uuid: "prja",
      project_name: "project-a",
      destination_uuid: "dsta",
      destination_network: "coolify",
      server_uuid: "srva",
      server_name: "server-a",
      server_ip: "203.0.113.10",
      // application_settings' defaults.
      is_container_label_readonly_enabled: true,
      is_container_label_escape_enabled: true,
    });

    const [stored] = await raw("applications", "uuid = $1", ["appaaaaaaaaaaaaaaaaaaaaa"]);
    // What DockerImage::submit sets.
    expect(stored).toMatchObject({
      repository_project_id: 0,
      git_repository: "coollabsio/coolify",
      git_branch: "main",
      build_pack: "dockerimage",
      ports_exposes: "80",
      health_check_enabled: false,
      destination_id: fx.a!.destination.id,
      destination_type: "App\\Models\\StandaloneDocker",
      environment_id: fx.a!.environmentId,
      org_id: A,
    });
    // The creating hook: the four webhook secrets (as their ciphertexts) and the parser version.
    for (const column of APPLICATION_WEBHOOK_SECRET_COLUMNS) expect(stored![column]).toBe(`fp1:appaaaaaaaaaaaaaaaaaaaaa:${column}`);
    expect(stored!.compose_parsing_version).toBe("5");
    // Everything else is the schema's default, as in Coolify's migrations.
    expect(stored).toMatchObject({
      git_commit_sha: "HEAD",
      static_image: "nginx:alpine",
      base_directory: "/",
      health_check_path: "/",
      health_check_port: null,
      health_check_host: "localhost",
      health_check_method: "GET",
      health_check_return_code: 200,
      health_check_scheme: "http",
      health_check_interval: 5,
      health_check_timeout: 5,
      health_check_retries: 10,
      health_check_start_period: 5,
      health_check_type: "http",
      limits_memory: "0",
      limits_cpus: "0",
      limits_cpu_shares: 1024,
      status: "exited",
      preview_url_template: "{{pr_id}}.{{domain}}",
      redirect: "both",
      swarm_replicas: 1,
      max_restart_count: 0,
      restart_count: 0,
      custom_labels: null,
      domain_port_overrides: null,
      source_id: null,
      private_key_id: null,
      deleted_at: null,
    });
    expect(stored!.created_at).not.toBeNull();
    expect(stored!.updated_at).toEqual(stored!.created_at);

    // The created hook: ApplicationSetting::create(['application_id' => …]), every other column a default.
    const settings = await raw("application_settings", "application_id = $1", [row.id]);
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({
      org_id: A,
      is_static: false,
      is_auto_deploy_enabled: true,
      is_force_https_enabled: true,
      is_debug_enabled: false,
      is_preview_deployments_enabled: false,
      is_gzip_enabled: true,
      is_stripprefix_enabled: true,
      is_container_label_escape_enabled: true,
      is_container_label_readonly_enabled: true,
      is_consistent_container_name_enabled: false,
      is_image_scan_enabled: true,
      docker_images_to_keep: 2,
      include_coolify_default_variables: true,
    });
  });

  it("stores the port overrides as JSON and a Swarm destination's morph class", async () => {
    const row = await withOrg(ex, A, (tx) =>
      insertDockerImageApplication(
        tx,
        newApp(A, fx.a!, "appswarmaaaaaaaaaaaaaaaa", { fqdn: "https://app.example.com", domainPortOverrides: { "https://app.example.com": 3000 }, destinationId: fx.a!.swarm.id, destinationType: "swarm" }),
      ),
    );
    expect(row).toMatchObject({ destination_uuid: "swma", destination_network: "coolify-overlay", destination_type: DESTINATION_MORPH_CLASS.swarm, server_uuid: "srva" });
    const overrides = typeof row.domain_port_overrides === "string" ? JSON.parse(row.domain_port_overrides) : row.domain_port_overrides;
    expect(overrides).toEqual({ "https://app.example.com": 3000 });
  });

  it("finds and lists an environment's applications, never a soft-deleted one", async () => {
    await withOrg(ex, A, (tx) => insertDockerImageApplication(tx, newApp(A, fx.a!, "appgoneaaaaaaaaaaaaaaaaa")));
    await withOrg(ex, A, (tx) => tx.execute(`UPDATE deploy.applications SET deleted_at = '2026-01-01 00:00:00' WHERE uuid = 'appgoneaaaaaaaaaaaaaaaaa'`));
    expect(await withOrg(ex, A, (tx) => findApplicationByUuid(tx, "appgoneaaaaaaaaaaaaaaaaa"))).toBeNull();
    expect(await withOrg(ex, A, (tx) => findApplicationByUuid(tx, "nosuchapplication"))).toBeNull();
    expect((await withOrg(ex, A, (tx) => listEnvironmentApplications(tx, fx.a!.environmentId))).map((a) => a.uuid)).toEqual(["appaaaaaaaaaaaaaaaaaaaaa", "appswarmaaaaaaaaaaaaaaaa"]);
    expect(await withOrg(ex, A, (tx) => listEnvironmentApplications(tx, 999_999))).toEqual([]);
  });

  it("General's save writes only the given columns", async () => {
    const before = (await withOrg(ex, A, (tx) => findApplicationByUuid(tx, "appaaaaaaaaaaaaaaaaaaaaa")))!;
    const updated = await withOrg(ex, A, (tx) =>
      updateApplicationGeneral(tx, before.id, {
        name: "web",
        description: "the site",
        docker_registry_image_tag: "1.27",
        ports_exposes: "3000,3001",
        ports_mappings: "8080:80",
        custom_docker_run_options: "--cap-add SYS_ADMIN",
        pre_deployment_command: "php artisan migrate",
        domain_port_overrides: JSON.stringify({ "https://web.example.com": 3000 }),
        fqdn: "https://web.example.com",
      }),
    );
    expect(updated).toMatchObject({
      name: "web",
      description: "the site",
      fqdn: "https://web.example.com",
      docker_registry_image_name: "nginx",
      docker_registry_image_tag: "1.27",
      ports_exposes: "3000,3001",
      ports_mappings: "8080:80",
      custom_docker_run_options: "--cap-add SYS_ADMIN",
      pre_deployment_command: "php artisan migrate",
      post_deployment_command: null,
    });
    // A given null clears the column; a column left out keeps its value.
    const cleared = await withOrg(ex, A, (tx) => updateApplicationGeneral(tx, before.id, { description: null, ports_mappings: null, domain_port_overrides: null }));
    expect(cleared).toMatchObject({ name: "web", description: null, ports_mappings: null, domain_port_overrides: null, ports_exposes: "3000,3001" });
    expect(await withOrg(ex, A, (tx) => updateApplicationGeneral(tx, 999_999, { name: "nobody" }))).toBeNull();
  });

  it("lists the org's application domains for the conflict check", async () => {
    expect((await withOrg(ex, A, listApplicationDomains)).map((a) => [a.uuid, a.fqdn, a.environment_uuid, a.project_uuid])).toEqual([
      ["appaaaaaaaaaaaaaaaaaaaaa", "https://web.example.com", "enva", "prja"],
      ["appswarmaaaaaaaaaaaaaaaa", "https://app.example.com", "enva", "prja"],
    ]);
  });

  it("the environment and project guards of DP-46 and the destination guard of DP-44 see the application", async () => {
    // Org B has no application yet.
    expect(await withOrg(ex, B, (tx) => environmentHasResources(tx, fx.b!.environmentId))).toBe(false);
    expect(await withOrg(ex, B, (tx) => projectHasResources(tx, fx.b!.projectId))).toBe(false);
    expect(await withOrg(ex, B, (tx) => destinationIsAttached(tx, "standalone", fx.b!.destination.id))).toBe(false);
    expect((await withOrg(ex, B, listProjectsWithCounts))[0]!.resource_count).toBe(0);

    await withOrg(ex, B, (tx) => insertDockerImageApplication(tx, newApp(B, fx.b!, "appbbbbbbbbbbbbbbbbbbbbb")));
    expect(await withOrg(ex, B, (tx) => environmentHasResources(tx, fx.b!.environmentId))).toBe(true);
    expect(await withOrg(ex, B, (tx) => projectHasResources(tx, fx.b!.projectId))).toBe(true);
    expect((await withOrg(ex, B, listProjectsWithCounts))[0]!.resource_count).toBe(1);
    expect(await withOrg(ex, B, (tx) => destinationIsAttached(tx, "standalone", fx.b!.destination.id))).toBe(true);
    // The Swarm destination with the same numeric id space is not attached: the morph class tells them apart.
    expect(await withOrg(ex, B, (tx) => destinationIsAttached(tx, "swarm", fx.b!.swarm.id))).toBe(false);
    expect(await withOrg(ex, B, (tx) => listDestinationResources(tx, "standalone", fx.b!.destination.id))).toEqual([
      { type: "application", uuid: "appbbbbbbbbbbbbbbbbbbbbb", name: "docker-image-appbbbbbbbbbbbbbbbbbbbbb", environment_uuid: "envb", environment_name: "production", project_uuid: "prjb", project_name: "project-b" },
    ]);

    // A soft-deleted application no longer counts.
    await withOrg(ex, B, (tx) => tx.execute(`UPDATE deploy.applications SET deleted_at = '2026-01-01 00:00:00' WHERE uuid = 'appbbbbbbbbbbbbbbbbbbbbb'`));
    expect(await withOrg(ex, B, (tx) => environmentHasResources(tx, fx.b!.environmentId))).toBe(false);
    expect(await withOrg(ex, B, (tx) => destinationIsAttached(tx, "standalone", fx.b!.destination.id))).toBe(false);
    await withOrg(ex, B, (tx) => tx.execute(`UPDATE deploy.applications SET deleted_at = NULL WHERE uuid = 'appbbbbbbbbbbbbbbbbbbbbb'`));
  });

  it("keeps each org's applications to itself (row-level security)", async () => {
    expect(await withOrg(ex, B, (tx) => findApplicationByUuid(tx, "appaaaaaaaaaaaaaaaaaaaaa"))).toBeNull();
    expect(await withOrg(ex, B, (tx) => listEnvironmentApplications(tx, fx.a!.environmentId))).toEqual([]);
    expect((await withOrg(ex, B, listApplicationDomains)).map((a) => a.uuid)).toEqual(["appbbbbbbbbbbbbbbbbbbbbb"]);
    const a = (await withOrg(ex, A, (tx) => findApplicationByUuid(tx, "appaaaaaaaaaaaaaaaaaaaaa")))!;
    expect(await withOrg(ex, B, (tx) => updateApplicationGeneral(tx, a.id, { name: "taken over" }))).toBeNull();
    expect((await withOrg(ex, A, (tx) => findApplicationByUuid(tx, "appaaaaaaaaaaaaaaaaaaaaa")))!.name).toBe("web");
    // An application cannot be written into another org.
    await expect(withOrg(ex, B, (tx) => insertDockerImageApplication(tx, newApp(A, fx.b!, "appcrossorgaaaaaaaaaaaaa")))).rejects.toThrow();
  });

  it("lists the servers the New Resource page offers: usable deployment servers, and usable build servers apart (Select::loadServers)", async () => {
    const names = async (org: string, kind: "deployment" | "build") => (await withOrg(ex, org, (tx) => listResourceServers(tx, kind))).map((s) => s.name);
    // Not validated yet: neither list has the server.
    expect(await names(A, "deployment")).toEqual([]);
    expect(await names(A, "build")).toEqual([]);
    await withOrg(ex, A, (tx) => tx.execute(`UPDATE deploy.server_settings SET is_reachable = true, is_usable = true WHERE server_id = $1`, [fx.a!.serverId]));
    expect(await withOrg(ex, A, (tx) => listResourceServers(tx, "deployment"))).toEqual([
      { id: fx.a!.serverId, uuid: "srva", name: "server-a", description: null, ip: "203.0.113.10", is_swarm_manager: false, is_swarm_worker: false },
    ]);
    expect(await names(A, "build")).toEqual([]);
    await withOrg(ex, A, (tx) => tx.execute(`UPDATE deploy.server_settings SET server_role = 'build' WHERE server_id = $1`, [fx.a!.serverId]));
    expect(await names(A, "deployment")).toEqual([]);
    expect(await names(A, "build")).toEqual(["server-a"]);
    // A null role falls back to the legacy build flag.
    await withOrg(ex, A, (tx) => tx.execute(`UPDATE deploy.server_settings SET server_role = NULL, is_build_server = true WHERE server_id = $1`, [fx.a!.serverId]));
    expect(await names(A, "build")).toEqual(["server-a"]);
    await withOrg(ex, A, (tx) => tx.execute(`UPDATE deploy.server_settings SET is_build_server = false WHERE server_id = $1`, [fx.a!.serverId]));
    expect(await names(A, "deployment")).toEqual(["server-a"]);
    // A disabled server or a Swarm worker is in neither; another org sees none of it.
    await withOrg(ex, A, (tx) => tx.execute(`UPDATE deploy.server_settings SET force_disabled = true WHERE server_id = $1`, [fx.a!.serverId]));
    expect(await names(A, "deployment")).toEqual([]);
    expect(await names(B, "deployment")).toEqual([]);
  });
});
