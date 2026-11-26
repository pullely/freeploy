// Services (DP-59) against a real Postgres with the deploy schema at head: the store functions of @saas/db/deploy inside withOrg() —
// the rows a parsed one-click service is stored as (Coolify's hooks and the schema's defaults, column by
// column), its applications, databases, variables and volumes with the ids they refer to each other by,
// what a service's page reads back, clone_service()'s replicas (DP-108), and row-level security keeping each org's rows to
// itself.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  insertPrivateKey,
  insertServer,
  insertProject,
  listServerDestinations,
  environmentHasResources,
  insertParsedService,
  findServiceByUuid,
  listEnvironmentServices,
  listServiceApplications,
  listServiceDatabases,
  findServiceServer,
  SERVICE_MORPH_CLASS,
  SERVICE_PART_MORPH_CLASS,
  replicateService,
  listServiceScheduledTaskIds,
  replicateServiceScheduledTask,
  listServiceEnvironmentVariableIds,
  replicateServiceEnvironmentVariable,
  cloneServiceSecretManagerLink,
  listServiceDatabaseBackupScheduleIds,
  replicateServiceDatabaseBackupSchedule,
  type DeployDestinationRow,
  type NewParsedService,
} from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, executor, sqlState } from "./deploy-schema.js";

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
      proxy: { type: "TRAEFIK" }, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: `dst${tag}`,
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

const part = (localId: number, uuid: string, name: string, image: string) => ({
  localId, uuid, name, humanName: null, ports: "", image, excludeFromStatus: false, isLogDrainEnabled: false, isGzipEnabled: true, isStripprefixEnabled: true, isMigrated: false, isRemovedFromCompose: false,
});

/** What createOneClickService() hands the store for a service with one application and one database. */
const service = (org: string, f: Fixture, uuid: string): NewParsedService => ({
  orgId: org,
  uuid,
  name: `umami-${uuid}`,
  environmentId: f.environmentId,
  serverId: f.destination.server_id,
  destinationId: f.destination.id,
  destinationType: "standalone",
  dockerComposeRaw: "services:\n  umami:\n    image: umami\n",
  dockerCompose: "services:\n  umami:\n    image: umami\n    container_name: umami-x\n",
  connectToDockerNetwork: false,
  serviceType: "umami",
  composeParsingVersion: "5",
  isContainerLabelEscapeEnabled: true,
  includeCoolifyDefaultVariables: true,
  applications: [
    {
      ...part(1, `${uuid}-app`, "umami", "ghcr.io/umami-software/umami:3.5.0"),
      fqdn: `http://umami-${uuid}.203.0.113.10.sslip.io`,
      noindexDomains: null,
      redirect: "both",
      isForceHttpsEnabled: true,
      isPermanentRedirectEnabled: false,
      domainPortOverrides: { "http://umami.example.com": 3000 },
      traefikCertificateResolver: null,
    },
  ],
  databases: [part(1, `${uuid}-db`, "postgresql", "postgres:16-alpine")],
  variables: [
    { uuid: `${uuid}-v1`, key: "SERVICE_PASSWORD_POSTGRES", value: "fp1:secret", isPreview: false, isRequired: false, isShared: false, isLiteral: false, isMultiline: false, comment: null, version: "4.7.6", preserveComposeNull: false },
    { uuid: `${uuid}-v2`, key: "POSTGRES_DB", value: null, isPreview: false, isRequired: true, isShared: false, isLiteral: false, isMultiline: false, comment: "the database", version: "4.7.6", preserveComposeNull: false },
  ],
  persistentVolumes: [{ uuid: `${uuid}-pv`, name: `${uuid}_postgresql-data`, mountPath: "/var/lib/postgresql/data", owner: { kind: "database", localId: 1 } }],
  fileVolumes: [{ uuid: `${uuid}-fv`, fsPath: `/data/coolify/services/${uuid}/config.yml`, mountPath: "/config.yml", content: "fp1:content", isDirectory: false, isHostFile: false, variableFsPath: null, owner: { kind: "application", localId: 1 } }],
});

const raw = async (table: string, where: string, params: unknown[]) =>
  (await asPlatformAdmin(ex, (tx) => tx.execute<Record<string, unknown>>(`SELECT * FROM deploy.${table} WHERE ${where} ORDER BY id`, params))).rows;

describe("deploy.services and the rows a service is parsed into", () => {
  it("stores the service with Coolify's values and the schema's defaults", async () => {
    const id = await withOrg(ex, A, (tx) => insertParsedService(tx, service(A, fx.a!, "svca")));
    const [row] = await raw("services", "id = $1", [id]);
    expect(row).toMatchObject({
      uuid: "svca",
      name: "umami-svca",
      org_id: A,
      service_type: "umami",
      compose_parsing_version: "5",
      connect_to_docker_network: false,
      is_container_label_escape_enabled: true,
      include_coolify_default_variables: true,
      redact_all_env_values_in_logs: true,
      destination_type: "App\\Models\\StandaloneDocker",
      description: null,
      config_hash: null,
      deleted_at: null,
    });
    expect(String(row?.environment_id)).toBe(String(fx.a!.environmentId));
    expect(String(row?.destination_id)).toBe(String(fx.a!.destination.id));
    expect(row?.created_at).not.toBeNull();
  });

  it("stores its applications and databases, with the model's max_restart_count", async () => {
    const serviceRow = await withOrg(ex, A, (tx) => findServiceByUuid(tx, "svca"));
    const [application] = await raw("service_applications", "service_id = $1", [serviceRow!.id]);
    expect(application).toMatchObject({
      uuid: "svca-app",
      name: "umami",
      org_id: A,
      fqdn: "http://umami-svca.203.0.113.10.sslip.io",
      ports: "",
      image: "ghcr.io/umami-software/umami:3.5.0",
      status: "exited",
      redirect: "both",
      is_force_https_enabled: true,
      is_gzip_enabled: true,
      is_stripprefix_enabled: true,
      max_restart_count: 0,
      restart_count: 0,
      domain_port_overrides: { "http://umami.example.com": 3000 },
      noindex_domains: null,
      is_removed_from_compose: false,
    });
    const [database] = await raw("service_databases", "service_id = $1", [serviceRow!.id]);
    expect(database).toMatchObject({ uuid: "svca-db", name: "postgresql", org_id: A, image: "postgres:16-alpine", status: "exited", is_public: false, public_port: null });
  });

  it("stores its variables on the service and its volumes on the parts they belong to", async () => {
    const serviceRow = await withOrg(ex, A, (tx) => findServiceByUuid(tx, "svca"));
    const variables = await raw("environment_variables", "resourceable_type = $1 AND resourceable_id = $2", [SERVICE_MORPH_CLASS, serviceRow!.id]);
    expect(variables.map((v) => [v.key, v.value, v.is_required, v.comment, v.version, v.is_runtime, v.is_buildtime, v.is_preview])).toEqual([
      ["SERVICE_PASSWORD_POSTGRES", "fp1:secret", false, null, "4.7.6", true, true, false],
      ["POSTGRES_DB", null, true, "the database", "4.7.6", true, true, false],
    ]);
    const [application] = await raw("service_applications", "service_id = $1", [serviceRow!.id]);
    const [database] = await raw("service_databases", "service_id = $1", [serviceRow!.id]);
    const [persistent] = await raw("local_persistent_volumes", "uuid = $1", ["svca-pv"]);
    expect(persistent).toMatchObject({ name: "svca_postgresql-data", mount_path: "/var/lib/postgresql/data", resource_type: SERVICE_PART_MORPH_CLASS.database, org_id: A, is_preview_suffix_enabled: true });
    expect(String(persistent?.resource_id)).toBe(String(database?.id));
    const [file] = await raw("local_file_volumes", "uuid = $1", ["svca-fv"]);
    expect(file).toMatchObject({ fs_path: "/data/coolify/services/svca/config.yml", mount_path: "/config.yml", content: "fp1:content", is_directory: false, is_host_file: false, resource_type: SERVICE_PART_MORPH_CLASS.application, org_id: A });
    expect(String(file?.resource_id)).toBe(String(application?.id));
  });

  it("refuses a volume whose part is not the service's, and stores nothing of that service", async () => {
    const broken = service(A, fx.a!, "svcbroken");
    broken.persistentVolumes[0]!.owner = { kind: "database", localId: 9 };
    await expect(withOrg(ex, A, (tx) => insertParsedService(tx, broken))).rejects.toThrow("is not a part of the service");
    expect(await raw("services", "uuid = $1", ["svcbroken"])).toEqual([]);
    expect(await raw("service_applications", "uuid = $1", ["svcbroken-app"])).toEqual([]);
  });

  it("reads a service back with its project and environment, and its parts", async () => {
    const found = await withOrg(ex, A, async (tx) => {
      const row = await findServiceByUuid(tx, "svca");
      return { row, applications: await listServiceApplications(tx, row!.id), databases: await listServiceDatabases(tx, row!.id), listed: await listEnvironmentServices(tx, fx.a!.environmentId) };
    });
    expect(found.row).toMatchObject({ uuid: "svca", name: "umami-svca", service_type: "umami", project_uuid: "prja", environment_uuid: "enva", environment_name: "production", project_name: "project-a" });
    expect(found.applications.map((a) => [a.name, a.fqdn, a.image, a.status])).toEqual([["umami", "http://umami-svca.203.0.113.10.sslip.io", "ghcr.io/umami-software/umami:3.5.0", "exited"]]);
    expect(found.databases.map((d) => [d.name, d.fqdn, d.image])).toEqual([["postgresql", null, "postgres:16-alpine"]]);
    expect(found.listed.map((s) => s.uuid)).toEqual(["svca"]);
    expect(await withOrg(ex, A, (tx) => environmentHasResources(tx, fx.a!.environmentId))).toBe(true);
  });

  it("reads what the parser needs of the server", async () => {
    const server = await withOrg(ex, A, (tx) => findServiceServer(tx, fx.a!.destination.server_id));
    expect(server).toMatchObject({ uuid: "srva", ip: "203.0.113.10", wildcard_domain: null, generate_exact_labels: false, is_traffic_analytics_enabled: false });
    expect(typeof server?.proxy === "string" ? JSON.parse(server.proxy) : server?.proxy).toMatchObject({ type: "TRAEFIK" });
  });

  it("meets the head schema's rules: every row has a uuid, and a part has one volume per name and one file per mount path", async () => {
    const rows = await raw("environment_variables", "resourceable_type = $1", [SERVICE_MORPH_CLASS]);
    expect(rows.every((row) => typeof row.uuid === "string" && row.uuid !== "")).toBe(true);
    expect("is_build_time" in (rows[0] ?? {})).toBe(false);
    const [stored] = await raw("services", "uuid = $1", ["svca"]);
    expect(stored).toMatchObject({ is_maintenance_enabled: false, maintenance_page: null });
    // The parser names a volume once per part (updateOrCreate); a second row of that name is refused, and with it the whole service.
    const twice = service(A, fx.a!, "svctwice");
    twice.persistentVolumes.push({ ...twice.persistentVolumes[0]!, uuid: "svctwice-pv2" });
    expect(await sqlState(() => withOrg(ex, A, (tx) => insertParsedService(tx, twice)))).toBe("23505");
    const sameMount = service(A, fx.a!, "svcmount");
    sameMount.fileVolumes.push({ ...sameMount.fileVolumes[0]!, uuid: "svcmount-fv2" });
    expect(await sqlState(() => withOrg(ex, A, (tx) => insertParsedService(tx, sameMount)))).toBe("23505");
    expect(await raw("services", "uuid IN ('svctwice', 'svcmount')", [])).toEqual([]);
  });

  it("keeps each org's services to itself", async () => {
    await withOrg(ex, B, (tx) => insertParsedService(tx, service(B, fx.b!, "svcb")));
    const seenByA = await withOrg(ex, A, async (tx) => ({ other: await findServiceByUuid(tx, "svcb"), server: await findServiceServer(tx, fx.b!.destination.server_id) }));
    expect(seenByA).toEqual({ other: null, server: null });
    const bRow = await withOrg(ex, B, (tx) => findServiceByUuid(tx, "svcb"));
    expect(await withOrg(ex, A, (tx) => listServiceApplications(tx, bRow!.id))).toEqual([]);
    expect(await withOrg(ex, A, (tx) => listServiceDatabases(tx, bRow!.id))).toEqual([]);
    // A row written for another org is refused by the policy's WITH CHECK.
    await expect(withOrg(ex, A, (tx) => insertParsedService(tx, service(B, fx.a!, "svcx")))).rejects.toThrow();
  });
});

describe("clone_service()'s rows (DP-108)", () => {
  it("replicates the service with the clone's uuid and name, and copies its tasks, variables, secret manager link and backups", async () => {
    const source = await withOrg(ex, A, (tx) => insertParsedService(tx, service(A, fx.a!, "svcsource")));
    const [db1] = await raw("service_databases", "service_id = $1", [source]);
    await withOrg(ex, A, async (tx) => {
      await tx.execute("INSERT INTO deploy.scheduled_tasks (uuid, name, command, frequency, service_id, org_id) VALUES ('tasksrc', 'vacuum', 'vacuumdb', '@daily', $1, $2)", [source, A]);
      const token = await tx.execute<{ id: string }>("INSERT INTO deploy.integration_tokens (uuid, provider, name, token, capabilities, org_id) VALUES ('tokclone', 'doppler', 'd', 'fp1:x', '[]', $1) RETURNING id", [A]);
      await tx.execute(`INSERT INTO deploy.secret_manager_links (uuid, resourceable_type, resourceable_id, integration_token_id, settings, org_id) VALUES ('linksrc', $1, $2, $3, '{"project":"p"}', $4)`, [SERVICE_MORPH_CLASS, source, token.rows[0]!.id, A]);
      await tx.execute("INSERT INTO deploy.scheduled_database_backups (uuid, frequency, database_type, database_id, org_id) VALUES ('bksrc', '@daily', $1, $2, $3)", [SERVICE_PART_MORPH_CLASS.database, db1!.id, A]);
    });
    const replica = { uuid: "svcclone", name: "svc-clone", environmentId: fx.a!.environmentId, destinationId: fx.a!.destination.id, destinationType: "standalone" as const, serverId: fx.a!.destination.server_id };
    const clone = await withOrg(ex, A, async (tx) => {
      const id = (await replicateService(tx, source, replica))!;
      for (const task of await listServiceScheduledTaskIds(tx, source)) await replicateServiceScheduledTask(tx, task, { uuid: "taskclone", serviceId: id });
      for (const v of await listServiceEnvironmentVariableIds(tx, source)) await replicateServiceEnvironmentVariable(tx, v, { uuid: `varclone${v}`, serviceId: id, version: "4.7.6" });
      await cloneServiceSecretManagerLink(tx, source, id, "linkclone");
      for (const b of await listServiceDatabaseBackupScheduleIds(tx, db1!.id as string)) await replicateServiceDatabaseBackupSchedule(tx, b, { uuid: "bkclone", databaseId: db1!.id as string });
      return id;
    });
    const [row] = await raw("services", "id = $1", [clone]);
    const [src] = await raw("services", "id = $1", [source]);
    expect(row).toMatchObject({ uuid: "svcclone", name: "svc-clone", docker_compose_raw: src!.docker_compose_raw, docker_compose: src!.docker_compose, service_type: "umami", compose_parsing_version: "5", org_id: A });
    expect((await raw("scheduled_tasks", "service_id = $1", [clone])).map((t) => [t.uuid, t.name, t.command])).toEqual([["taskclone", "vacuum", "vacuumdb"]]);
    expect((await raw("environment_variables", "resourceable_type = $1 AND resourceable_id = $2", [SERVICE_MORPH_CLASS, clone])).map((v) => [v.key, v.value, v.version])).toEqual([
      ["SERVICE_PASSWORD_POSTGRES", "fp1:secret", "4.7.6"],
      ["POSTGRES_DB", null, "4.7.6"],
    ]);
    const [link] = await raw("secret_manager_links", "resourceable_id = $1 AND resourceable_type = $2", [clone, SERVICE_MORPH_CLASS]);
    expect([link!.uuid, typeof link!.settings === "string" ? JSON.parse(link!.settings) : link!.settings]).toEqual(["linkclone", { project: "p" }]);
    expect((await raw("scheduled_database_backups", "uuid = 'bkclone'", [])).map((b) => [b.frequency, b.database_type])).toEqual([["@daily", SERVICE_PART_MORPH_CLASS.database]]);
    // Another org replicates nothing of it.
    expect(await withOrg(ex, B, (tx) => replicateService(tx, source, { ...replica, uuid: "svcclone-b", environmentId: fx.b!.environmentId, destinationId: fx.b!.destination.id, serverId: fx.b!.destination.server_id }))).toBeNull();
  });
});
