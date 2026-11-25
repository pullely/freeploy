// A service's configuration pages (DP-66) against a real Postgres with the deploy schema at head: the service with
// its server and destination, the rows the parser works on loaded and written back row by row (each write
// confined to the service's own rows, the columns limited to what may be written), a part deleted with its
// volumes, the service deleted with every row that belongs to it, its Environment Variables page keyed by
// 'service', the environment's resources list, and row-level security keeping each org's rows to itself.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  insertPrivateKey,
  insertServer,
  insertProject,
  listServerDestinations,
  insertParsedService,
  findServiceConfiguration,
  listServiceParts,
  findServicePartByUuid,
  listServiceVariables,
  listServicePartVolumes,
  listServicePartFiles,
  updateServiceRow,
  insertServicePart,
  insertServiceVariable,
  insertServicePartStorage,
  deleteServiceVariables,
  deleteServicePartFiles,
  serviceHasRun,
  deleteServicePart,
  deleteService,
  listDomainOwners,
  listEnvironmentServiceResources,
  findEnvironmentVariableResource,
  updateEnvironmentVariableSettings,
  environmentVariableSettingColumns,
  ENVIRONMENT_VARIABLE_MORPH_CLASS,
  SERVICE_MORPH_CLASS,
  SERVICE_PART_MORPH_CLASS,
  type DeployDestinationRow,
  type NewParsedService,
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

const service = (org: string, f: Fixture, uuid: string): NewParsedService => ({
  orgId: org,
  uuid,
  name: `umami-${uuid}`,
  environmentId: f.environmentId,
  serverId: f.destination.server_id,
  destinationId: f.destination.id,
  destinationType: "standalone",
  dockerComposeRaw: "services:\n  umami:\n    image: umami\n",
  dockerCompose: "services:\n  umami:\n    image: umami\n",
  connectToDockerNetwork: false,
  serviceType: "umami",
  composeParsingVersion: "5",
  isContainerLabelEscapeEnabled: true,
  includeCoolifyDefaultVariables: true,
  applications: [
    {
      ...part(1, `${uuid}-app`, "umami", "ghcr.io/umami-software/umami:3.5.0"),
      fqdn: `http://umami-${uuid}.example.com`,
      noindexDomains: null,
      redirect: "both",
      isForceHttpsEnabled: true,
      isPermanentRedirectEnabled: false,
      domainPortOverrides: { [`http://umami-${uuid}.example.com`]: 3000 },
      traefikCertificateResolver: null,
    },
  ],
  databases: [part(1, `${uuid}-db`, "postgresql", "postgres:16-alpine")],
  variables: [
    { uuid: `${uuid}-v1`, key: "SERVICE_PASSWORD_POSTGRES", value: "fp1:secret", isPreview: false, isRequired: false, isShared: false, isLiteral: false, isMultiline: false, comment: null, version: "4.7.6", preserveComposeNull: false },
    { uuid: `${uuid}-v2`, key: "POSTGRES_DB", value: null, isPreview: false, isRequired: true, isShared: false, isLiteral: false, isMultiline: false, comment: null, version: "4.7.6", preserveComposeNull: false },
  ],
  persistentVolumes: [{ uuid: `${uuid}-pv`, name: `${uuid}_postgresql-data`, mountPath: "/var/lib/postgresql/data", owner: { kind: "database", localId: 1 } }],
  fileVolumes: [{ uuid: `${uuid}-fv`, fsPath: `/data/coolify/services/${uuid}/config.yml`, mountPath: "/config.yml", content: "fp1:content", isDirectory: false, isHostFile: false, variableFsPath: null, owner: { kind: "application", localId: 1 } }],
});

const admin = (sql: string, params: unknown[] = []) => asPlatformAdmin(ex, (tx) => tx.execute<Record<string, unknown>>(sql, params));
const raw = async (table: string, where: string, params: unknown[]) => (await admin(`SELECT * FROM deploy.${table} WHERE ${where} ORDER BY id`, params)).rows;
const create = (org: string, uuid: string) => withOrg(ex, org, (tx) => insertParsedService(tx, service(org, org === A ? fx.a! : fx.b!, uuid)));

describe("a service's rows for its configuration pages", () => {
  it("finds the service with its environment, project, server and destination", async () => {
    await create(A, "cfga");
    const row = await withOrg(ex, A, (tx) => findServiceConfiguration(tx, "cfga"));
    expect(row).toMatchObject({
      uuid: "cfga",
      name: "umami-cfga",
      description: null,
      environment_uuid: "enva",
      project_uuid: "prja",
      server_uuid: "srva",
      server_ip: "203.0.113.10",
      server_is_reachable: false,
      destination_uuid: fx.a!.destination.uuid,
      destination_network: fx.a!.destination.network,
      redact_all_env_values_in_logs: true,
      config_hash: null,
    });
    expect(row?.server_proxy).toMatchObject({ type: "TRAEFIK" });
    expect(await withOrg(ex, B, (tx) => findServiceConfiguration(tx, "cfga"))).toBeNull();
  });

  it("loads every row the parser works on, each part's every column", async () => {
    const id = (await withOrg(ex, A, (tx) => findServiceConfiguration(tx, "cfga")))!.id;
    const loaded = await withOrg(ex, A, async (tx) => ({
      applications: await listServiceParts(tx, "application", id),
      databases: await listServiceParts(tx, "database", id),
      variables: await listServiceVariables(tx, id),
      volumes: await listServicePartVolumes(tx, id),
      files: await listServicePartFiles(tx, id),
      part: await findServicePartByUuid(tx, "cfga-db"),
    }));
    expect(loaded.applications).toHaveLength(1);
    expect(loaded.applications[0]).toMatchObject({ name: "umami", status: "exited", fqdn: "http://umami-cfga.example.com", redirect: "both", max_restart_count: 0, public_port: null });
    expect(loaded.applications[0]!.domain_port_overrides).toEqual({ "http://umami-cfga.example.com": 3000 });
    expect(loaded.databases[0]).toMatchObject({ name: "postgresql", fqdn: null, is_public: false, public_port_timeout: 3600 });
    expect(loaded.variables.map((v) => [v.key, v.value, v.is_required, v.is_shown_once])).toEqual([
      ["SERVICE_PASSWORD_POSTGRES", "fp1:secret", false, false],
      ["POSTGRES_DB", null, true, false],
    ]);
    expect(loaded.volumes).toEqual([expect.objectContaining({ name: "cfga_postgresql-data", resource_type: SERVICE_PART_MORPH_CLASS.database, ignores_compose_driver_options: false })]);
    expect(loaded.files).toEqual([expect.objectContaining({ mount_path: "/config.yml", content: "fp1:content", resource_type: SERVICE_PART_MORPH_CLASS.application, has_scheduled_backups: false })]);
    expect(loaded.part?.kind).toBe("database");
  });

  it("writes rows back by id, only the service's own and only the writable columns", async () => {
    const id = (await withOrg(ex, A, (tx) => findServiceConfiguration(tx, "cfga")))!.id;
    await create(A, "cfgo");
    const other = (await withOrg(ex, A, (tx) => findServiceConfiguration(tx, "cfgo")))!.id;
    await withOrg(ex, A, async (tx) => {
      const [application] = await listServiceParts(tx, "application", id);
      const [variable] = await listServiceVariables(tx, id);
      const [volume] = await listServicePartVolumes(tx, id);
      const [file] = await listServicePartFiles(tx, id);
      expect(await updateServiceRow(tx, "service", id, id, { name: "renamed", description: "a description", docker_compose_raw: "services: {}\n" })).toBe(true);
      expect(await updateServiceRow(tx, "application", id, application!.id, { image: "nginx", noindex_domains: ["http://a.example.com"], domain_port_overrides: null })).toBe(true);
      expect(await updateServiceRow(tx, "variable", id, variable!.id, { value: "fp1:new", is_shared: true })).toBe(true);
      expect(await updateServiceRow(tx, "volume", id, volume!.id, { mount_path: "/data" })).toBe(true);
      expect(await updateServiceRow(tx, "file", id, file!.id, { content: null })).toBe(true);
      // Another service's rows are not this service's.
      expect(await updateServiceRow(tx, "application", other, application!.id, { image: "x" })).toBe(false);
      expect(await updateServiceRow(tx, "variable", other, variable!.id, { value: "x" })).toBe(false);
      expect(await updateServiceRow(tx, "volume", other, volume!.id, { name: "x" })).toBe(false);
      await expect(updateServiceRow(tx, "service", id, id, { org_id: B })).rejects.toThrow('a service has no writable column "org_id"');
    });
    expect((await raw("services", "id = $1", [id]))[0]).toMatchObject({ name: "renamed", description: "a description", docker_compose_raw: "services: {}\n" });
    expect((await raw("service_applications", "service_id = $1", [id]))[0]).toMatchObject({ image: "nginx", noindex_domains: ["http://a.example.com"], domain_port_overrides: null });
    expect((await raw("environment_variables", "resourceable_type = $1 AND resourceable_id = $2", [SERVICE_MORPH_CLASS, id]))[0]).toMatchObject({ value: "fp1:new", is_shared: true });
    expect((await raw("service_applications", "service_id = $1", [other]))[0]).toMatchObject({ image: "ghcr.io/umami-software/umami:3.5.0" });
  });

  it("inserts the parts, variables and mounts a parse adds, and deletes the variables and mounts it removes", async () => {
    const id = (await withOrg(ex, A, (tx) => findServiceConfiguration(tx, "cfga")))!.id;
    await withOrg(ex, A, async (tx) => {
      const partId = await insertServicePart(tx, A, "application", id, "cfga-extra", { name: "extra", image: "busybox", fqdn: "http://extra.example.com", noindex_domains: null, redirect: "both" });
      await insertServicePart(tx, A, "database", id, "cfga-db2", { name: "redis", image: "redis:7" });
      await insertServiceVariable(tx, A, id, "cfga-v3", { key: "EXTRA", value: "fp1:x", is_preview: false, is_required: false, is_shared: false, is_literal: false, is_multiline: false, comment: null, version: "4.7.6", preserve_compose_null: false });
      await insertServicePartStorage(tx, A, "volume", { kind: "application", id: partId }, "cfga-pv2", { name: "cfga_extra-data", mount_path: "/data", ignores_compose_driver_options: false });
      await insertServicePartStorage(tx, A, "file", { kind: "application", id: partId }, "cfga-fv2", { fs_path: "/data/coolify/services/cfga/x.txt", mount_path: "/x.txt", content: null, is_directory: false, is_host_file: false, variable_fs_path: null });
    });
    const parts = await raw("service_applications", "service_id = $1", [id]);
    expect(parts.map((p) => [p.name, p.max_restart_count, p.status, p.org_id])).toEqual([
      ["umami", 0, "exited", A],
      ["extra", 0, "exited", A],
    ]);
    const files = await withOrg(ex, A, (tx) => listServicePartFiles(tx, id));
    const variables = await withOrg(ex, A, (tx) => listServiceVariables(tx, id));
    expect(variables.map((v) => v.key)).toEqual(["SERVICE_PASSWORD_POSTGRES", "POSTGRES_DB", "EXTRA"]);
    await withOrg(ex, A, async (tx) => {
      expect(await deleteServiceVariables(tx, id, [variables[2]!.id])).toBe(1);
      expect(await deleteServicePartFiles(tx, id, [files[1]!.id])).toBe(1);
      expect(await deleteServiceVariables(tx, id, [])).toBe(0);
    });
    expect((await withOrg(ex, A, (tx) => listServiceVariables(tx, id))).map((v) => v.key)).toEqual(["SERVICE_PASSWORD_POSTGRES", "POSTGRES_DB"]);
    expect(await withOrg(ex, A, (tx) => listServicePartFiles(tx, id))).toHaveLength(1);
  });

  it("knows whether a part ran, deletes a part with its storage, and lists the domains of the org", async () => {
    const id = (await withOrg(ex, A, (tx) => findServiceConfiguration(tx, "cfga")))!.id;
    expect(await withOrg(ex, A, (tx) => serviceHasRun(tx, id))).toBe(false);
    await admin("UPDATE deploy.service_databases SET status = 'running:healthy' WHERE uuid = 'cfga-db2'");
    expect(await withOrg(ex, A, (tx) => serviceHasRun(tx, id))).toBe(true);
    await admin("UPDATE deploy.service_databases SET status = 'exited' WHERE uuid = 'cfga-db2'");
    const extra = (await raw("service_applications", "uuid = $1", ["cfga-extra"]))[0]!;
    expect(await withOrg(ex, A, (tx) => deleteServicePart(tx, "application", id, extra.id as string))).toBe(true);
    expect(await raw("service_applications", "uuid = $1", ["cfga-extra"])).toEqual([]);
    expect(await raw("local_persistent_volumes", "resource_type = $1 AND resource_id = $2", [SERVICE_PART_MORPH_CLASS.application, extra.id])).toEqual([]);
    expect(await withOrg(ex, B, (tx) => deleteServicePart(tx, "database", id, 1))).toBe(false);
    const owners = await withOrg(ex, A, (tx) => listDomainOwners(tx));
    expect(owners.map((o) => o.fqdn)).toEqual(expect.arrayContaining(["http://umami-cfgo.example.com"]));
    expect(await withOrg(ex, B, (tx) => listDomainOwners(tx))).toEqual([]);
  });

  it("lists the environment's services with their server and their parts' statuses", async () => {
    const rows = await withOrg(ex, A, (tx) => listEnvironmentServiceResources(tx, fx.a!.environmentId));
    expect(rows.map((r) => [r.uuid, r.server_name])).toEqual([
      ["cfga", "server-a"],
      ["cfgo", "server-a"],
    ]);
    expect(rows[0]!.parts).toEqual([
      { status: "exited", exclude_from_status: false, is_removed_from_compose: false },
      { status: "exited", exclude_from_status: false, is_removed_from_compose: false },
      { status: "exited", exclude_from_status: false, is_removed_from_compose: false },
    ]);
    expect(await withOrg(ex, B, (tx) => listEnvironmentServiceResources(tx, fx.a!.environmentId))).toEqual([]);
  });

  it("keys the Environment Variables page by 'service', with the two switches on the service's own row", async () => {
    expect(ENVIRONMENT_VARIABLE_MORPH_CLASS.service).toBe("App\\Models\\Service");
    expect(environmentVariableSettingColumns("service")).toEqual(["include_coolify_default_variables", "redact_all_env_values_in_logs"]);
    const resource = await withOrg(ex, A, (tx) => findEnvironmentVariableResource(tx, "service", "cfga"));
    expect(resource).toMatchObject({ uuid: "cfga", build_pack: null, docker_compose: "services: {}\n", environment_uuid: "enva", project_uuid: "prja", server_uuid: "srva", is_env_sorting_enabled: null, include_coolify_default_variables: true, redact_all_env_values_in_logs: true });
    expect(await withOrg(ex, A, (tx) => updateEnvironmentVariableSettings(tx, "service", resource!.id, { redact_all_env_values_in_logs: false }))).toBe(true);
    expect((await raw("services", "uuid = $1", ["cfga"]))[0]).toMatchObject({ redact_all_env_values_in_logs: false });
    await expect(withOrg(ex, A, (tx) => updateEnvironmentVariableSettings(tx, "service", resource!.id, { use_build_secrets: true }))).rejects.toThrow('a service has no setting "use_build_secrets"');
    expect(await withOrg(ex, B, (tx) => findEnvironmentVariableResource(tx, "service", "cfga"))).toBeNull();
  });

  it("deletes a service with every row that belongs to it, and nothing of another service", async () => {
    await create(A, "cfgd");
    const id = (await withOrg(ex, A, (tx) => findServiceConfiguration(tx, "cfgd")))!.id;
    const [database] = await raw("service_databases", "service_id = $1", [id]);
    const [volume] = await raw("local_persistent_volumes", "resource_type = $1 AND resource_id = $2", [SERVICE_PART_MORPH_CLASS.database, database!.id]);
    // A tag of the service, a volume backup schedule and a database backup schedule of its parts, a scheduled task.
    const [tag] = (await admin("INSERT INTO deploy.tags (uuid, name, org_id) VALUES ('tagd', 'prod', $1) RETURNING id", [A])).rows;
    await admin("INSERT INTO deploy.taggables (tag_id, taggable_type, taggable_id, org_id) VALUES ($1, $2, $3, $4)", [tag!.id, SERVICE_MORPH_CLASS, id, A]);
    await admin("INSERT INTO deploy.scheduled_volume_backups (uuid, backupable_type, backupable_id, frequency, org_id) VALUES ('svbd', $1, $2, '0 0 * * *', $3)", ["App\\Models\\LocalPersistentVolume", volume!.id, A]);
    await admin("INSERT INTO deploy.scheduled_database_backups (uuid, database_type, database_id, frequency, org_id) VALUES ('sdbd', $1, $2, '0 0 * * *', $3)", [SERVICE_PART_MORPH_CLASS.database, database!.id, A]);
    await admin("INSERT INTO deploy.scheduled_tasks (uuid, name, command, frequency, service_id, org_id) VALUES ('stkd', 'task', 'ls', '* * * * *', $1, $2)", [id, A]);
    const before = (await raw("services", "uuid = $1", ["cfgo"])).length;
    expect(await withOrg(ex, A, (tx) => deleteService(tx, id))).toBe(true);
    expect(await raw("services", "id = $1", [id])).toEqual([]);
    expect(await raw("service_applications", "service_id = $1", [id])).toEqual([]);
    expect(await raw("service_databases", "service_id = $1", [id])).toEqual([]);
    expect(await raw("environment_variables", "resourceable_type = $1 AND resourceable_id = $2", [SERVICE_MORPH_CLASS, id])).toEqual([]);
    expect(await raw("local_persistent_volumes", "id = $1", [volume!.id])).toEqual([]);
    expect((await admin("SELECT tag_id FROM deploy.taggables WHERE taggable_type = $1 AND taggable_id = $2", [SERVICE_MORPH_CLASS, id])).rows).toEqual([]);
    expect(await raw("scheduled_volume_backups", "uuid = $1", ["svbd"])).toEqual([]);
    expect(await raw("scheduled_database_backups", "uuid = $1", ["sdbd"])).toEqual([]);
    expect(await raw("scheduled_tasks", "uuid = $1", ["stkd"])).toEqual([]);
    expect(await raw("services", "uuid = $1", ["cfgo"])).toHaveLength(before);
    expect(await raw("service_applications", "uuid = $1", ["cfgo-app"])).toHaveLength(1);
    expect(await withOrg(ex, A, (tx) => deleteService(tx, id))).toBe(false);
  });

  it("keeps another org's service out of reach of every write", async () => {
    await create(B, "cfgb");
    const id = (await withOrg(ex, B, (tx) => findServiceConfiguration(tx, "cfgb")))!.id;
    await withOrg(ex, A, async (tx) => {
      expect(await updateServiceRow(tx, "service", id, id, { name: "taken" })).toBe(false);
      expect(await listServiceParts(tx, "application", id)).toEqual([]);
      expect(await listServiceVariables(tx, id)).toEqual([]);
      expect(await deleteService(tx, id)).toBe(false);
    });
    expect((await raw("services", "id = $1", [id]))[0]).toMatchObject({ name: "umami-cfgb" });
  });
});
