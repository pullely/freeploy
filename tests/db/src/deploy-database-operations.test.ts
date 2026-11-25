// What starting, restarting and stopping a standalone database reads and writes (DP-62), against a real
// Postgres: the store functions of packages/db/src/deploy/database-operations.ts inside withOrg(), for the eight
// engines — the row a start reads with its joins, the variables in their order, started_at set once, the status
// with the saving hook's last_online_at, the certificate rows and the certificate's file mounts — and row-level
// security keeping each org's rows to itself. No migration belongs to this task.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  insertPrivateKey,
  insertServer,
  insertProject,
  listServerDestinations,
  listFileVolumes,
  insertFileVolume,
  insertSslCertificate,
  findServerCaCertificate,
  DATABASE_ENGINES,
  DATABASE_TABLES,
  databaseOwner,
  insertDatabase,
  insertDatabaseVariable,
  findDatabaseForOperation,
  listDatabaseStartVariables,
  markDatabaseStarted,
  setDatabaseStatus,
  touchDatabaseLastOnline,
  resetDatabaseRestartCounters,
  findDatabaseCertificate,
  deleteDatabaseCertificates,
  deleteFileVolumesByMountPath,
  insertCertificateFileVolume,
  type DatabaseEngine,
  type DeployDestinationRow,
  type NewDatabase,
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
  environmentId: string | number;
  projectId: string | number;
}
const fx: Record<string, Fixture> = {};
/** The id of each org's database of each engine. */
const ids: Record<string, Record<string, string | number>> = { a: {}, b: {} };

async function fixture(org: string, tag: string): Promise<Fixture> {
  return withOrg(ex, org, async (tx) => {
    const key = await insertPrivateKey(tx, { orgId: org, uuid: `key${tag}`, name: "key", description: null, privateKey: "fp1:fake", fingerprint: null });
    const server = await insertServer(tx, {
      orgId: org, uuid: `srv${tag}`, name: `server-${tag}`, description: null, ip: "203.0.113.10", user: "root", port: 22, privateKeyId: key.id,
      proxy: {}, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: `dst${tag}`,
    });
    const destination = (await listServerDestinations(tx, server.id))[0]!;
    const { project, environment } = await insertProject(tx, { orgId: org, uuid: `prj${tag}`, name: `Project ${tag}`, description: null, productionEnvironmentUuid: `env${tag}` });
    return { serverId: server.id, destination, environmentId: environment.id, projectId: project.id };
  });
}

const admin = (sql: string, params: unknown[] = []) => asPlatformAdmin(ex, (tx) => tx.execute<Record<string, unknown>>(sql, params));

/** What create_standalone_<engine>() must set: the columns without a default. */
const REQUIRED: Record<DatabaseEngine, Record<string, string>> = {
  postgresql: { postgres_password: "fp1:1:pw", image: "postgres:17-alpine" },
  redis: { image: "redis:7.2" },
  mongodb: { mongo_initdb_root_password: "fp1:1:pw" },
  mysql: { mysql_root_password: "fp1:1:root", mysql_password: "fp1:1:pw" },
  mariadb: { mariadb_root_password: "fp1:1:root", mariadb_password: "fp1:1:pw" },
  keydb: { keydb_password: "fp1:1:pw" },
  dragonfly: { dragonfly_password: "fp1:1:pw" },
  clickhouse: { clickhouse_admin_password: "fp1:1:pw" },
};

function newDatabase(org: string, f: Fixture, engine: DatabaseEngine, uuid: string): NewDatabase {
  return { orgId: org, uuid, name: `${engine}-database-${uuid}`, environmentId: f.environmentId, destinationId: f.destination.id, destinationType: "standalone", values: REQUIRED[engine], volumes: [{ uuid: `vol${uuid}`, name: `${engine}-data-${uuid}`, mountPath: "/data" }] };
}

/** A TIMESTAMP column as text, whatever the driver hands back. */
const text = (value: unknown): string | null => (value === null || value === undefined ? null : value instanceof Date ? value.toISOString().slice(0, 19).replace("T", " ") : String(value));
const rawRow = async (engine: DatabaseEngine, id: string | number) => (await admin(`SELECT status, started_at::text AS started_at, last_online_at::text AS last_online_at, updated_at::text AS updated_at FROM deploy.${DATABASE_TABLES[engine].table} WHERE id = $1`, [id])).rows[0]!;

beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
  fx.a = await fixture(A, "a");
  fx.b = await fixture(B, "b");
  for (const [tag, org] of [["a", A], ["b", B]] as const) {
    for (const engine of DATABASE_ENGINES) {
      const row = await withOrg(ex, org, (tx) => insertDatabase(tx, engine, newDatabase(org, fx[tag]!, engine, `${engine}${tag}`)));
      ids[tag]![engine] = row.id;
    }
  }
}, 120_000);
afterAll(async () => db?.close());

describe("findDatabaseForOperation", () => {
  it.each(DATABASE_ENGINES)("%s: every column a start reads, with the environment, the project, the destination's network and the server", async (engine) => {
    const row = (await withOrg(ex, A, (tx) => findDatabaseForOperation(tx, engine, ids.a![engine]!)))!;
    expect(row).toMatchObject({
      engine,
      uuid: `${engine}a`,
      name: `${engine}-database-${engine}a`,
      status: "exited",
      is_public: false,
      public_port: null,
      public_port_timeout: 3600,
      ports_mappings: null,
      // The schema's defaults, which are Coolify's.
      limits_memory: "0",
      limits_memory_swap: "0",
      limits_memory_swappiness: 60,
      limits_memory_reservation: "0",
      limits_cpus: "0",
      limits_cpuset: null,
      limits_cpu_shares: 1024,
      started_at: null,
      is_log_drain_enabled: false,
      include_coolify_default_variables: true,
      custom_docker_run_options: null,
      // Migration 660's columns, with Coolify's defaults.
      health_check_enabled: true,
      health_check_interval: 15,
      health_check_timeout: 5,
      health_check_retries: 5,
      health_check_start_period: 5,
      restart_count: 0,
      last_restart_at: null,
      last_restart_type: null,
      environment_name: "production",
      project_name: "Project a",
      destination_network: "coolify",
      server_uuid: "srva",
      server_ip: "203.0.113.10",
      server_user: "root",
      server_is_swarm_manager: false,
      server_is_swarm_worker: false,
      server_docker_version: null,
      server_is_logdrain_cloudwatch_enabled: false,
      server_logdrain_cloudwatch_region: null,
    });
    expect(String(row.environment_id)).toBe(String(fx.a!.environmentId));
    expect(String(row.project_id)).toBe(String(fx.a!.projectId));
    expect(String(row.server_id)).toBe(String(fx.a!.serverId));
    // The engine's own columns, as stored (ciphertexts stay ciphertexts).
    for (const [column, value] of Object.entries(REQUIRED[engine])) expect(row[column]).toBe(value);
    for (const column of DATABASE_TABLES[engine].columns) expect(Object.keys(row)).toContain(column);
    // The optional columns are there exactly where the table has them.
    const t = DATABASE_TABLES[engine];
    expect([row.enable_ssl !== undefined, row.ssl_mode !== undefined, row.legacy_password_quoting !== undefined]).toEqual([t.enableSsl, t.sslMode, t.legacyPasswordQuoting]);
  });

  it("answers null for another org's database, for an unknown id and for a soft-deleted database", async () => {
    expect(await withOrg(ex, B, (tx) => findDatabaseForOperation(tx, "postgresql", ids.a!.postgresql!))).toBeNull();
    expect(await withOrg(ex, A, (tx) => findDatabaseForOperation(tx, "postgresql", 999999))).toBeNull();
    const gone = await withOrg(ex, A, (tx) => insertDatabase(tx, "keydb", newDatabase(A, fx.a!, "keydb", "keydbgone")));
    await admin("UPDATE deploy.standalone_keydbs SET deleted_at = now() WHERE id = $1", [gone.id]);
    expect(await withOrg(ex, A, (tx) => findDatabaseForOperation(tx, "keydb", gone.id))).toBeNull();
    expect(await withOrg(ex, A, (tx) => markDatabaseStarted(tx, "keydb", gone.id))).toBe(false);
  });

  it("reads the server's settings a start depends on", async () => {
    await admin("UPDATE deploy.server_settings SET is_reachable = true, is_usable = true, docker_version = '29.0.1', is_logdrain_cloudwatch_enabled = true, logdrain_cloudwatch_region = 'eu-central-1', logdrain_cloudwatch_group = 'grp', logdrain_cloudwatch_stream_prefix = 'db-' WHERE server_id = $1", [fx.a!.serverId]);
    const row = (await withOrg(ex, A, (tx) => findDatabaseForOperation(tx, "mysql", ids.a!.mysql!)))!;
    expect(row).toMatchObject({ server_is_reachable: true, server_is_usable: true, server_force_disabled: false, server_docker_version: "29.0.1", server_is_logdrain_cloudwatch_enabled: true, server_logdrain_cloudwatch_region: "eu-central-1", server_logdrain_cloudwatch_group: "grp", server_logdrain_cloudwatch_stream_prefix: "db-" });
  });
});

describe("listDatabaseStartVariables", () => {
  it("lists a database's variables oldest first, with the flags a start formats them by", async () => {
    const owner = databaseOwner("redis", ids.a!.redis!);
    await withOrg(ex, A, async (tx) => {
      for (const key of ["ZED", "REDIS_PASSWORD", "ALPHA"]) await insertDatabaseVariable(tx, owner, { orgId: A, uuid: `var${key.toLowerCase()}`, key, value: `fp1:1:${key}`, isShared: false, version: "4.7.6" });
    });
    await admin(`UPDATE deploy.environment_variables SET is_literal = true, is_multiline = true, uses_legacy_escaping = true WHERE "key" = 'ALPHA'`);
    const variables = await withOrg(ex, A, (tx) => listDatabaseStartVariables(tx, owner));
    expect(variables.map((v) => [v.key, v.value, v.is_literal, v.is_multiline, v.uses_legacy_escaping])).toEqual([
      ["ZED", "fp1:1:ZED", false, false, false],
      ["REDIS_PASSWORD", "fp1:1:REDIS_PASSWORD", false, false, false],
      ["ALPHA", "fp1:1:ALPHA", true, true, true],
    ]);
    // Another database of the same id in another table has none of them; another org sees none.
    expect(await withOrg(ex, A, (tx) => listDatabaseStartVariables(tx, databaseOwner("keydb", ids.a!.redis!)))).toEqual([]);
    expect(await withOrg(ex, B, (tx) => listDatabaseStartVariables(tx, owner))).toEqual([]);
  });
});

describe("the database's row", () => {
  it.each(DATABASE_ENGINES)("%s: started_at is set once and kept", async (engine) => {
    const id = ids.a![engine]!;
    expect((await rawRow(engine, id)).started_at).toBeNull();
    expect(await withOrg(ex, A, (tx) => markDatabaseStarted(tx, engine, id))).toBe(true);
    const first = text((await rawRow(engine, id)).started_at);
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    await admin(`UPDATE deploy.${DATABASE_TABLES[engine].table} SET started_at = '2026-01-02 03:04:05' WHERE id = $1`, [id]);
    expect(await withOrg(ex, A, (tx) => markDatabaseStarted(tx, engine, id))).toBe(true);
    expect(text((await rawRow(engine, id)).started_at)).toBe("2026-01-02 03:04:05");
  });

  it.each(DATABASE_ENGINES)("%s: a changed status sets last_online_at; the same status leaves it", async (engine) => {
    const id = ids.a![engine]!;
    const table = DATABASE_TABLES[engine].table;
    await admin(`UPDATE deploy.${table} SET last_online_at = '2026-01-01 00:00:00' WHERE id = $1`, [id]);
    expect(await withOrg(ex, A, (tx) => setDatabaseStatus(tx, engine, id, "running:healthy"))).toBe(true);
    const changed = await rawRow(engine, id);
    expect(changed.status).toBe("running:healthy");
    expect(text(changed.last_online_at)).not.toBe("2026-01-01 00:00:00");
    await admin(`UPDATE deploy.${table} SET last_online_at = '2026-01-01 00:00:00' WHERE id = $1`, [id]);
    await withOrg(ex, A, (tx) => setDatabaseStatus(tx, engine, id, "running:healthy"));
    expect(text((await rawRow(engine, id)).last_online_at)).toBe("2026-01-01 00:00:00");
    // $database->update(['last_online_at' => now()])
    expect(await withOrg(ex, A, (tx) => touchDatabaseLastOnline(tx, engine, id))).toBe(true);
    expect(text((await rawRow(engine, id)).last_online_at)).not.toBe("2026-01-01 00:00:00");
  });

  it.each(DATABASE_ENGINES)("%s: the restart counters are reset, and a row already reset is not written", async (engine) => {
    const id = ids.a![engine]!;
    const table = DATABASE_TABLES[engine].table;
    const counters = async () => (await admin(`SELECT restart_count, last_restart_at::text AS last_restart_at, last_restart_type, updated_at::text AS updated_at FROM deploy.${table} WHERE id = $1`, [id])).rows[0]!;
    await admin(`UPDATE deploy.${table} SET restart_count = 3, last_restart_at = '2026-11-19 08:00:00', last_restart_type = 'crash', updated_at = '2026-01-01 00:00:00' WHERE id = $1`, [id]);
    // Org B reaches none of it.
    expect(await withOrg(ex, B, (tx) => resetDatabaseRestartCounters(tx, engine, id))).toBe(false);
    expect(await counters()).toMatchObject({ restart_count: 3, last_restart_at: "2026-11-19 08:00:00", last_restart_type: "crash" });
    expect(await withOrg(ex, A, (tx) => resetDatabaseRestartCounters(tx, engine, id))).toBe(true);
    const reset = await counters();
    expect(reset).toMatchObject({ restart_count: 0, last_restart_at: null, last_restart_type: null });
    expect(reset.updated_at).not.toBe("2026-01-01 00:00:00");
    // Already reset: Eloquent writes nothing, so updated_at stays.
    await admin(`UPDATE deploy.${table} SET updated_at = '2026-01-01 00:00:00' WHERE id = $1`, [id]);
    expect(await withOrg(ex, A, (tx) => resetDatabaseRestartCounters(tx, engine, id))).toBe(true);
    expect((await counters()).updated_at).toBe("2026-01-01 00:00:00");
    // Only last_restart_type left over is enough to reset.
    await admin(`UPDATE deploy.${table} SET last_restart_type = 'crash' WHERE id = $1`, [id]);
    await withOrg(ex, A, (tx) => resetDatabaseRestartCounters(tx, engine, id));
    expect((await counters()).last_restart_type).toBeNull();
  });

  it("reads the health check settings a start writes into the compose file", async () => {
    await admin("UPDATE deploy.standalone_redis SET health_check_enabled = false, health_check_interval = 30, health_check_timeout = 10, health_check_retries = 3, health_check_start_period = 60 WHERE id = $1", [ids.a!.redis!]);
    const row = (await withOrg(ex, A, (tx) => findDatabaseForOperation(tx, "redis", ids.a!.redis!)))!;
    expect([row.health_check_enabled, row.health_check_interval, row.health_check_timeout, row.health_check_retries, row.health_check_start_period]).toEqual([false, 30, 10, 3, 60]);
  });

  it("another org's database is out of reach of every write", async () => {
    const id = ids.a!.mongodb!;
    const before = await rawRow("mongodb", id);
    expect(await withOrg(ex, B, (tx) => markDatabaseStarted(tx, "mongodb", id))).toBe(false);
    expect(await withOrg(ex, B, (tx) => setDatabaseStatus(tx, "mongodb", id, "exited:unhealthy"))).toBe(false);
    expect(await withOrg(ex, B, (tx) => touchDatabaseLastOnline(tx, "mongodb", id))).toBe(false);
    expect(await rawRow("mongodb", id)).toEqual(before);
  });
});

describe("a database's certificate and its files", () => {
  const owner = () => databaseOwner("postgresql", ids.a!.postgresql!);
  const certificate = (over: Record<string, unknown> = {}) => ({
    orgId: A,
    serverId: fx.a!.serverId,
    resourceType: owner().type as string | null,
    resourceId: owner().id as string | number | null,
    sslCertificate: "fp1:1:cert",
    sslPrivateKey: "fp1:1:key",
    configurationDir: "/data/coolify/databases/postgresqla" as string | null,
    mountPath: "/var/lib/postgresql/certs" as string | null,
    commonName: "postgresqla",
    subjectAlternativeNames: ["DNS:postgresqla", "IP:203.0.113.10"],
    validUntil: new Date("2027-11-20T10:11:12Z"),
    isCaCertificate: false,
    ...over,
  });

  it("findDatabaseCertificate: the database's first certificate, never the server's CA", async () => {
    expect(await withOrg(ex, A, (tx) => findDatabaseCertificate(tx, owner()))).toBeNull();
    await withOrg(ex, A, async (tx) => {
      await insertSslCertificate(tx, certificate({ resourceType: null, resourceId: null, configurationDir: null, mountPath: null, commonName: "Coolify CA Certificate", subjectAlternativeNames: [], isCaCertificate: true }));
      await insertSslCertificate(tx, certificate());
    });
    const found = (await withOrg(ex, A, (tx) => findDatabaseCertificate(tx, owner())))!;
    expect(found).toMatchObject({ common_name: "postgresqla", configuration_dir: "/data/coolify/databases/postgresqla", mount_path: "/var/lib/postgresql/certs" });
    expect(typeof found.subject_alternative_names === "string" ? JSON.parse(found.subject_alternative_names) : found.subject_alternative_names).toEqual(["DNS:postgresqla", "IP:203.0.113.10"]);
    expect(text(found.valid_until)).toBe("2027-11-20 10:11:12");
    expect(String(found.server_id)).toBe(String(fx.a!.serverId));
    // Org B sees neither.
    expect(await withOrg(ex, B, (tx) => findDatabaseCertificate(tx, owner()))).toBeNull();
  });

  it("deleteDatabaseCertificates: the database's certificates go; the server's CA and another org's rows stay", async () => {
    expect(await withOrg(ex, B, (tx) => deleteDatabaseCertificates(tx, owner()))).toBe(0);
    expect(await withOrg(ex, A, (tx) => deleteDatabaseCertificates(tx, owner()))).toBe(1);
    expect(await withOrg(ex, A, (tx) => findDatabaseCertificate(tx, owner()))).toBeNull();
    expect((await withOrg(ex, A, (tx) => findServerCaCertificate(tx, fx.a!.serverId)))?.common_name).toBe("Coolify CA Certificate");
    expect(await withOrg(ex, A, (tx) => deleteDatabaseCertificates(tx, owner()))).toBe(0);
  });

  it("insertCertificateFileVolume and deleteFileVolumesByMountPath: the certificate's files, by their mount paths", async () => {
    await withOrg(ex, A, async (tx) => {
      await insertFileVolume(tx, { orgId: A, owner: owner(), uuid: "filkeepaaaaaaaaaaaaaaaaaa", fsPath: "/data/coolify/databases/postgresqla/extra.conf", mountPath: "/etc/extra.conf", content: "fp1:1:extra", isDirectory: false, isHostFile: false });
      await insertCertificateFileVolume(tx, { orgId: A, owner: owner(), uuid: "filcrtaaaaaaaaaaaaaaaaaaa", fsPath: "/data/coolify/databases/postgresqla/ssl/server.crt", mountPath: "/var/lib/postgresql/certs/server.crt", content: "fp1:1:crt", chmod: "644" });
      await insertCertificateFileVolume(tx, { orgId: A, owner: owner(), uuid: "filkeyaaaaaaaaaaaaaaaaaaa", fsPath: "/data/coolify/databases/postgresqla/ssl/server.key", mountPath: "/var/lib/postgresql/certs/server.key", content: "fp1:1:key", chmod: "600" });
    });
    const files = await withOrg(ex, A, (tx) => listFileVolumes(tx, owner()));
    expect(files.map((f) => [f.fs_path, f.mount_path, f.content, f.chmod, f.chown, f.is_directory, f.is_host_file, f.is_based_on_git])).toEqual([
      ["/data/coolify/databases/postgresqla/extra.conf", "/etc/extra.conf", "fp1:1:extra", null, null, false, false, false],
      ["/data/coolify/databases/postgresqla/ssl/server.crt", "/var/lib/postgresql/certs/server.crt", "fp1:1:crt", "644", null, false, false, false],
      ["/data/coolify/databases/postgresqla/ssl/server.key", "/var/lib/postgresql/certs/server.key", "fp1:1:key", "600", null, false, false, false],
    ]);
    // Nothing to delete without paths, for another org, or for another database.
    expect(await withOrg(ex, A, (tx) => deleteFileVolumesByMountPath(tx, owner(), []))).toBe(0);
    expect(await withOrg(ex, B, (tx) => deleteFileVolumesByMountPath(tx, owner(), ["/var/lib/postgresql/certs/server.crt"]))).toBe(0);
    expect(await withOrg(ex, A, (tx) => deleteFileVolumesByMountPath(tx, databaseOwner("mysql", ids.a!.postgresql!), ["/var/lib/postgresql/certs/server.crt"]))).toBe(0);
    expect(await withOrg(ex, A, (tx) => deleteFileVolumesByMountPath(tx, owner(), ["/var/lib/postgresql/certs/server.crt", "/var/lib/postgresql/certs/server.key", "/var/lib/postgresql/certs/server.pem"]))).toBe(2);
    expect((await withOrg(ex, A, (tx) => listFileVolumes(tx, owner()))).map((f) => f.mount_path)).toEqual(["/etc/extra.conf"]);
  });

  it("a certificate file cannot be written into another org", async () => {
    await expect(
      withOrg(ex, B, (tx) => insertCertificateFileVolume(tx, { orgId: A, owner: owner(), uuid: "filforeignaaaaaaaaaaaaaaa", fsPath: "/x/server.crt", mountPath: "/certs/server.crt", content: "fp1:1:crt", chmod: "644" })),
    ).rejects.toThrow();
  });
});
