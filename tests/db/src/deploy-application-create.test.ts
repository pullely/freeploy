// Applications that are built (DP-54) against a real Postgres: the store
// functions of @saas/db/deploy inside withOrg() — the rows an application
// from a Dockerfile or from a public Git repository starts as (Coolify's
// hooks and the schema's defaults, column by column), the created hook's
// environment variables, the build columns General reads and writes, the
// "same image" check, the build pack cleanup — and row-level security keeping
// each org's rows to itself.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  insertPrivateKey,
  insertServer,
  insertProject,
  listServerDestinations,
  findApplicationByUuid,
  listEnvironmentApplications,
  environmentHasResources,
  insertBuiltApplication,
  findApplicationBuild,
  updateApplicationBuild,
  findOtherApplicationBuildingImage,
  deleteApplicationServiceVariables,
  clearApplicationFileStoragesBasedOnGit,
  APPLICATION_MORPH_CLASS,
  APPLICATION_WEBHOOK_SECRET_COLUMNS,
  PUBLIC_GITHUB_SOURCE,
  type DeployDestinationRow,
  type NewBuiltApplication,
} from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, executor } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

let db: PGlite;
let ex: TransactionalSqlExecutor;

interface Fixture {
  destination: DeployDestinationRow;
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
    const { environment } = await insertProject(tx, { orgId: org, uuid: `prj${tag}`, name: `project-${tag}`, description: null, productionEnvironmentUuid: `env${tag}` });
    return { destination, environmentId: environment.id };
  });
}

beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
  fx.a = await fixture(A, "a");
  fx.b = await fixture(B, "b");
}, 120_000);
afterAll(async () => db?.close());

const secrets = (tag: string) => Object.fromEntries(APPLICATION_WEBHOOK_SECRET_COLUMNS.map((c) => [c, `fp1:${tag}:${c}`])) as NewBuiltApplication["webhookSecrets"];

/** What createDockerfileApplication() hands the store. */
const dockerfileApp = (org: string, f: Fixture, uuid: string, over: Partial<NewBuiltApplication> = {}): NewBuiltApplication => ({
  orgId: org,
  uuid,
  name: `dockerfile-${uuid}`,
  fqdn: `http://${uuid}.203.0.113.10.sslip.io`,
  domainPortOverrides: null,
  repositoryProjectId: 0,
  gitRepository: "coollabsio/coolify",
  gitBranch: "main",
  buildPack: "dockerfile",
  portsExposes: "80",
  baseDirectory: "/",
  publishDirectory: null,
  dockerfile: "FROM nginx\nEXPOSE 80\n",
  dockerfileLocation: null,
  dockerComposeLocation: null,
  healthCheckEnabled: false,
  dockerfileHealthcheck: null,
  sourceId: PUBLIC_GITHUB_SOURCE.id,
  sourceType: PUBLIC_GITHUB_SOURCE.type,
  isStatic: false,
  environmentId: f.environmentId,
  destinationId: f.destination.id,
  destinationType: "standalone",
  webhookSecrets: secrets(uuid),
  variables: [],
  ...over,
});

/** What createPublicApplication() hands the store for a github.com repository. */
const gitApp = (org: string, f: Fixture, uuid: string, over: Partial<NewBuiltApplication> = {}): NewBuiltApplication =>
  dockerfileApp(org, f, uuid, {
    name: `coolify-examples:main-${uuid}`,
    repositoryProjectId: null,
    gitRepository: "coollabsio/coolify-examples",
    buildPack: "railpack",
    portsExposes: "3000",
    dockerfile: null,
    healthCheckEnabled: null,
    ...over,
  });

const raw = async (table: string, where: string, params: unknown[]) =>
  (await asPlatformAdmin(ex, (tx) => tx.execute<Record<string, unknown>>(`SELECT * FROM deploy.${table} WHERE ${where} ORDER BY id`, params))).rows;

describe("deploy.applications for the applications that are built", () => {
  it("stores an application from a Dockerfile as SimpleDockerfile::submit and the model's hooks do, column by column", async () => {
    const uuid = "dfaaaaaaaaaaaaaaaaaaaaaa";
    const id = await withOrg(ex, A, (tx) => insertBuiltApplication(tx, dockerfileApp(A, fx.a!, uuid)));
    const [stored] = await raw("applications", "uuid = $1", [uuid]);
    expect(stored!.id).toEqual(id);
    // What the component sets.
    expect(stored).toMatchObject({
      name: `dockerfile-${uuid}`,
      fqdn: `http://${uuid}.203.0.113.10.sslip.io`,
      repository_project_id: 0,
      git_repository: "coollabsio/coolify",
      git_branch: "main",
      build_pack: "dockerfile",
      dockerfile: "FROM nginx\nEXPOSE 80\n",
      ports_exposes: "80",
      environment_id: fx.a!.environmentId,
      destination_id: fx.a!.destination.id,
      destination_type: "App\\Models\\StandaloneDocker",
      health_check_enabled: false,
      // The public GitHub source: Coolify's GithubApp with id 0, which has no row here.
      source_id: 0,
      source_type: "App\\Models\\GithubApp",
      org_id: A,
    });
    for (const column of APPLICATION_WEBHOOK_SECRET_COLUMNS) expect(stored![column]).toBe(`fp1:${uuid}:${column}`);
    expect(stored!.compose_parsing_version).toBe("5");
    // Everything else is the schema's default.
    expect(stored).toMatchObject({
      git_commit_sha: "HEAD",
      static_image: "nginx:alpine",
      base_directory: "/",
      publish_directory: null,
      dockerfile_location: null,
      dockerfile_target_build: null,
      docker_compose_location: "/docker-compose.yaml",
      docker_compose_raw: null,
      install_command: null,
      build_command: null,
      start_command: null,
      watch_paths: null,
      custom_nginx_configuration: null,
      health_check_interval: 5,
      health_check_timeout: 5,
      health_check_retries: 10,
      health_check_start_period: 5,
      custom_healthcheck_found: false,
      status: "exited",
      redirect: "both",
      private_key_id: null,
      deleted_at: null,
    });
    expect(stored!.created_at).not.toBeNull();
    expect(await raw("github_apps", "id = 0", [])).toEqual([]);

    const settings = await raw("application_settings", "application_id = $1", [id]);
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({ org_id: A, is_static: false, is_spa: false, is_build_server_enabled: false, is_preserve_repository_enabled: false });
    expect(await raw("environment_variables", "resourceable_id = $1", [id])).toEqual([]);

    // The pages of DP-49 read it like any application.
    const shown = await withOrg(ex, A, (tx) => findApplicationByUuid(tx, uuid));
    expect(shown).toMatchObject({ uuid, build_pack: "dockerfile", status: "exited", environment_uuid: "enva", destination_uuid: "dsta", server_uuid: "srva" });
    expect((await withOrg(ex, A, (tx) => listEnvironmentApplications(tx, fx.a!.environmentId))).map((a) => a.uuid)).toContain(uuid);
    expect(await withOrg(ex, A, (tx) => environmentHasResources(tx, fx.a!.environmentId))).toBe(true);
  });

  it("stores the Dockerfile's HEALTHCHECK timing, a missing option keeping its default (parseHealthcheckFromDockerfile)", async () => {
    const uuid = "dfhcaaaaaaaaaaaaaaaaaaaa";
    await withOrg(ex, A, (tx) => insertBuiltApplication(tx, dockerfileApp(A, fx.a!, uuid, { dockerfileHealthcheck: { interval: 30, timeout: null, startPeriod: 1, retries: 4 } })));
    expect((await raw("applications", "uuid = $1", [uuid]))[0]).toMatchObject({
      health_check_interval: 30, health_check_timeout: 5, health_check_start_period: 1, health_check_retries: 4, custom_healthcheck_found: true, health_check_enabled: false,
    });
  });

  it("stores an application from a public Git repository as PublicGitRepository::submit does", async () => {
    const uuid = "gitaaaaaaaaaaaaaaaaaaaaa";
    const id = await withOrg(ex, A, (tx) =>
      insertBuiltApplication(tx, gitApp(A, fx.a!, uuid, { baseDirectory: "/apps/web", publishDirectory: "/dist", isStatic: true, portsExposes: "80", domainPortOverrides: { [`http://${uuid}.example.com`]: 8080 } })),
    );
    const [stored] = await raw("applications", "uuid = $1", [uuid]);
    expect(stored).toMatchObject({
      git_repository: "coollabsio/coolify-examples",
      git_branch: "main",
      build_pack: "railpack",
      ports_exposes: "80",
      base_directory: "/apps/web",
      publish_directory: "/dist",
      source_id: 0,
      source_type: "App\\Models\\GithubApp",
      // Not set by the component.
      repository_project_id: null,
      dockerfile: null,
      dockerfile_location: null,
      docker_compose_location: "/docker-compose.yaml",
      health_check_enabled: false,
      custom_healthcheck_found: false,
    });
    const overrides = typeof stored!.domain_port_overrides === "string" ? JSON.parse(stored!.domain_port_overrides) : stored!.domain_port_overrides;
    expect(overrides).toEqual({ [`http://${uuid}.example.com`]: 8080 });
    expect((await raw("application_settings", "application_id = $1", [id]))[0]).toMatchObject({ is_static: true });

    // Another host: the whole URL and no source. The Dockerfile and Compose build packs carry their file's location.
    await withOrg(ex, A, (tx) =>
      insertBuiltApplication(tx, gitApp(A, fx.a!, "gitotheraaaaaaaaaaaaaaaa", { gitRepository: "https://gitlab.com/a/b.git", sourceId: null, sourceType: null, buildPack: "dockerfile", dockerfileLocation: "/docker/Dockerfile", healthCheckEnabled: false })),
    );
    expect((await raw("applications", "uuid = $1", ["gitotheraaaaaaaaaaaaaaaa"]))[0]).toMatchObject({
      git_repository: "https://gitlab.com/a/b.git", source_id: null, source_type: null, build_pack: "dockerfile", dockerfile_location: "/docker/Dockerfile",
    });
    await withOrg(ex, A, (tx) => insertBuiltApplication(tx, gitApp(A, fx.a!, "gitcomposeaaaaaaaaaaaaaa", { buildPack: "dockercompose", dockerComposeLocation: "/deploy/compose.yaml" })));
    expect((await raw("applications", "uuid = $1", ["gitcomposeaaaaaaaaaaaaaa"]))[0]).toMatchObject({ build_pack: "dockercompose", docker_compose_location: "/deploy/compose.yaml" });
  });

  it("stores the created hook's variables for Nixpacks: NIXPACKS_NODE_VERSION and its preview copy", async () => {
    const uuid = "gitnixaaaaaaaaaaaaaaaaaa";
    const variable = (tag: string, isPreview: boolean) => ({
      uuid: `var${tag}aaaaaaaaaaaaaaaaaaaa`, key: "NIXPACKS_NODE_VERSION", value: "fp1:22", isMultiline: false, isLiteral: false, isBuildtime: true, isRuntime: false, isPreview, version: "4.7.6",
    });
    const id = await withOrg(ex, A, (tx) => insertBuiltApplication(tx, gitApp(A, fx.a!, uuid, { buildPack: "nixpacks", variables: [variable("1", false), variable("2", true)] })));
    const variables = await raw("environment_variables", "resourceable_id = $1", [id]);
    expect(variables).toHaveLength(2);
    for (const [i, isPreview] of [false, true].entries()) {
      expect(variables[i]).toMatchObject({
        key: "NIXPACKS_NODE_VERSION",
        // The value column holds the ciphertext, never the plain "22".
        value: "fp1:22",
        is_multiline: false,
        is_literal: false,
        is_buildtime: true,
        is_runtime: false,
        is_preview: isPreview,
        version: "4.7.6",
        resourceable_type: APPLICATION_MORPH_CLASS,
        org_id: A,
        // The schema's defaults.
        is_shown_once: false,
        is_required: false,
        is_shared: false,
        comment: null,
      });
    }
    expect(variables.map((v) => v.uuid)).toEqual(["var1aaaaaaaaaaaaaaaaaaaa", "var2aaaaaaaaaaaaaaaaaaaa"]);
  });

  it("reads the build columns with the settings, and writes only the given ones", async () => {
    const uuid = "gitaaaaaaaaaaaaaaaaaaaaa";
    const before = await withOrg(ex, A, (tx) => findApplicationBuild(tx, uuid));
    expect(before).toMatchObject({
      uuid, name: `coolify-examples:main-${uuid}`, build_pack: "railpack", git_repository: "coollabsio/coolify-examples", git_branch: "main", git_commit_sha: "HEAD",
      static_image: "nginx:alpine", base_directory: "/apps/web", publish_directory: "/dist", ports_exposes: "80", docker_compose_location: "/docker-compose.yaml",
      compose_parsing_version: "5", health_check_enabled: false, custom_healthcheck_found: false, is_static: true, is_spa: false, is_build_server_enabled: false,
      is_preserve_repository_enabled: false, is_raw_compose_deployment_enabled: false,
    });
    expect(Number(before!.source_id)).toBe(0);

    await asPlatformAdmin(ex, (tx) => tx.execute("UPDATE deploy.applications SET updated_at = '2020-01-01 00:00:00' WHERE uuid = $1", [uuid]));
    await withOrg(ex, A, (tx) =>
      updateApplicationBuild(tx, before!.id, { build_pack: "static", install_command: "npm ci", custom_nginx_configuration: "c2VydmVyIHt9", health_check_interval: 20, custom_healthcheck_found: true, publish_directory: null }, { is_static: false, is_spa: true }),
    );
    const after = await withOrg(ex, A, (tx) => findApplicationBuild(tx, uuid));
    expect(after).toMatchObject({
      build_pack: "static", install_command: "npm ci", custom_nginx_configuration: "c2VydmVyIHt9", health_check_interval: 20, custom_healthcheck_found: true, publish_directory: null,
      // Untouched.
      base_directory: "/apps/web", git_branch: "main", is_static: false, is_spa: true, is_build_server_enabled: false,
    });
    const [stored] = await raw("applications", "uuid = $1", [uuid]);
    expect(String(stored!.updated_at)).not.toContain("2020");

    // Nothing given: nothing written.
    await asPlatformAdmin(ex, (tx) => tx.execute("UPDATE deploy.applications SET updated_at = '2020-01-01 00:00:00' WHERE uuid = $1", [uuid]));
    await withOrg(ex, A, (tx) => updateApplicationBuild(tx, before!.id, {}, {}));
    expect(String((await raw("applications", "uuid = $1", [uuid]))[0]!.updated_at)).toContain("2020");
    expect(await withOrg(ex, A, (tx) => findApplicationBuild(tx, "nope"))).toBeNull();
  });

  it("finds another application of the org that builds the same image (otherApplicationBuildingSameImage)", async () => {
    const first = (await withOrg(ex, A, (tx) => findApplicationBuild(tx, "gitaaaaaaaaaaaaaaaaaaaaa")))!;
    const second = (await withOrg(ex, A, (tx) => findApplicationBuild(tx, "gitotheraaaaaaaaaaaaaaaa")))!;
    const compose = (await withOrg(ex, A, (tx) => findApplicationBuild(tx, "gitcomposeaaaaaaaaaaaaaa")))!;
    await asPlatformAdmin(ex, (tx) => tx.execute("UPDATE deploy.applications SET docker_registry_image_name = 'ghcr.io/acme/app' WHERE id = ANY($1)", [[first.id, compose.id]]));
    expect(await withOrg(ex, A, (tx) => findOtherApplicationBuildingImage(tx, second.id, "ghcr.io/acme/app"))).toEqual({ uuid: first.uuid, name: first.name });
    // Not itself; a Docker Compose application pushes no image; a soft-deleted one does not count.
    expect(await withOrg(ex, A, (tx) => findOtherApplicationBuildingImage(tx, first.id, "ghcr.io/acme/app"))).toBeNull();
    expect(await withOrg(ex, A, (tx) => findOtherApplicationBuildingImage(tx, second.id, "ghcr.io/acme/other"))).toBeNull();
    await asPlatformAdmin(ex, (tx) => tx.execute("UPDATE deploy.applications SET deleted_at = now() WHERE id = $1", [first.id]));
    expect(await withOrg(ex, A, (tx) => findOtherApplicationBuildingImage(tx, second.id, "ghcr.io/acme/app"))).toBeNull();
    await asPlatformAdmin(ex, (tx) => tx.execute("UPDATE deploy.applications SET deleted_at = NULL WHERE id = $1", [first.id]));
    // Another org's application is not seen.
    await withOrg(ex, B, (tx) => insertBuiltApplication(tx, gitApp(B, fx.b!, "gitbbbbbbbbbbbbbbbbbbbbb")));
    const other = (await withOrg(ex, B, (tx) => findApplicationBuild(tx, "gitbbbbbbbbbbbbbbbbbbbbb")))!;
    expect(await withOrg(ex, B, (tx) => findOtherApplicationBuildingImage(tx, other.id, "ghcr.io/acme/app"))).toBeNull();
  });

  it("deletes the SERVICE_FQDN_* and SERVICE_URL_* variables of an application that leaves Docker Compose, preview ones too", async () => {
    const app = (await withOrg(ex, A, (tx) => findApplicationBuild(tx, "gitcomposeaaaaaaaaaaaaaa")))!;
    const other = (await withOrg(ex, A, (tx) => findApplicationBuild(tx, "gitaaaaaaaaaaaaaaaaaaaaa")))!;
    const add = (id: string | number, key: string, preview = false) =>
      asPlatformAdmin(ex, (tx) =>
        tx.execute("INSERT INTO deploy.environment_variables (uuid, key, value, is_preview, resourceable_type, resourceable_id, org_id) VALUES ($6, $1, 'fp1:x', $2, $3, $4, $5)", [key, preview, APPLICATION_MORPH_CLASS, id, A, `var-${String(id)}-${key}-${String(preview)}`]),
      );
    await add(app.id, "SERVICE_FQDN_APP");
    await add(app.id, "SERVICE_FQDN_APP", true);
    await add(app.id, "SERVICE_URL_API_3000");
    await add(app.id, "SERVICE_PASSWORD_DB");
    await add(app.id, "PLAIN");
    await add(other.id, "SERVICE_FQDN_APP");
    expect(await withOrg(ex, A, (tx) => deleteApplicationServiceVariables(tx, app.id))).toBe(3);
    expect((await raw("environment_variables", "resourceable_id = $1", [app.id])).map((v) => v.key)).toEqual(["SERVICE_PASSWORD_DB", "PLAIN"]);
    expect(await raw("environment_variables", "resourceable_id = $1 AND key = 'SERVICE_FQDN_APP'", [other.id])).toHaveLength(1);
  });

  it("ends 'based on Git' for the application's file storages when the repository is no longer preserved", async () => {
    const app = (await withOrg(ex, A, (tx) => findApplicationBuild(tx, "gitaaaaaaaaaaaaaaaaaaaaa")))!;
    const add = (resourceId: string | number, path: string) =>
      asPlatformAdmin(ex, (tx) =>
        tx.execute("INSERT INTO deploy.local_file_volumes (uuid, fs_path, mount_path, resource_id, resource_type, is_based_on_git, org_id) VALUES ($1::varchar, $1::text, $1::text, $2, $3, true, $4)", [path, resourceId, APPLICATION_MORPH_CLASS, A]),
      );
    await add(app.id, "/data/a");
    await add(Number(app.id) + 100000, "/data/other");
    await withOrg(ex, A, (tx) => clearApplicationFileStoragesBasedOnGit(tx, app.id));
    expect((await raw("local_file_volumes", "fs_path LIKE '/data/%'", [])).map((v) => [v.fs_path, v.is_based_on_git])).toEqual([["/data/a", false], ["/data/other", true]]);
  });

  it("keeps each org's applications, settings and variables to itself (row-level security)", async () => {
    expect(await withOrg(ex, B, (tx) => findApplicationBuild(tx, "gitaaaaaaaaaaaaaaaaaaaaa"))).toBeNull();
    expect(await withOrg(ex, A, (tx) => findApplicationBuild(tx, "gitbbbbbbbbbbbbbbbbbbbbb"))).toBeNull();
    const mine = (await withOrg(ex, A, (tx) => findApplicationBuild(tx, "gitaaaaaaaaaaaaaaaaaaaaa")))!;
    // Another org's writes change nothing.
    await withOrg(ex, B, (tx) => updateApplicationBuild(tx, mine.id, { build_pack: "nixpacks" }, { is_spa: false }));
    expect(await withOrg(ex, A, (tx) => findApplicationBuild(tx, "gitaaaaaaaaaaaaaaaaaaaaa"))).toMatchObject({ build_pack: "static", is_spa: true });
    expect(await withOrg(ex, B, (tx) => deleteApplicationServiceVariables(tx, mine.id))).toBe(0);
    // An application cannot be stored for another org.
    await expect(withOrg(ex, B, (tx) => insertBuiltApplication(tx, gitApp(A, fx.b!, "gitcrossaaaaaaaaaaaaaaaa")))).rejects.toThrow();
    const counts = await withOrg(ex, B, async (tx) => (await tx.execute<{ n: string | number }>("SELECT count(*) AS n FROM deploy.environment_variables")).rows[0]!.n);
    expect(Number(counts)).toBe(0);
  });
});
