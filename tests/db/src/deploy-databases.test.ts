// The eight deploy.standalone_* tables of the standalone databases (DP-57)
// against a real Postgres: the store functions of @saas/db/deploy inside
// withOrg() — the row each engine's database starts as (what
// create_standalone_*() sets and the schema's defaults, column by column, the
// created hook's volumes, Redis's variables), the read with its joins,
// General's update, the delete with everything that goes with a database —
// the "has resources" and "attached" guards of DP-46 and DP-44 seeing those
// rows, migration 630, and row-level security keeping each org's databases to
// itself. What Coolify's code sets is read from the same goldens the worker's
// tests use (tests/deploy-core-worker/fixtures/databases/goldens.json, emitted
// by Coolify's own PHP).
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
  insertEnvironment,
  listServerDestinations,
  listPersistentVolumes,
  insertFileVolume,
  insertSslCertificate,
  environmentHasResources,
  projectHasResources,
  listProjectsWithCounts,
  destinationIsAttached,
  listDestinationResources,
  DATABASE_ENGINES,
  DATABASE_TABLES,
  DATABASE_GENERAL_COLUMNS,
  ENCRYPTED_COLUMNS,
  PERSISTENT_VOLUME_MORPH_CLASS,
  databaseOwner,
  writableDatabaseColumns,
  findDatabaseEngineByUuid,
  findDatabaseByUuid,
  listEnvironmentDatabases,
  insertDatabase,
  updateDatabase,
  findDatabaseVariable,
  insertDatabaseVariable,
  updateDatabaseVariableValue,
  findDatabaseCertificateValidUntil,
  deleteDatabase,
  type DatabaseEngine,
  type DeployDestinationRow,
  type NewDatabase,
} from "@saas/db/deploy";
import type { SqlExecutor, TransactionalSqlExecutor } from "@saas/db/hyperdrive";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migration = (m: string) => readFileSync(resolve(root, `packages/db/src/migrations/${m}/up.sql`), "utf8");
const BEFORE_630 = ["500_deploy_core", "510_deploy_org_keys", "520_deploy_schema_fold_fixes", "590_deploy_shared_variables_server_scope", "610_deploy_tags_org_name_unique"].map(migration).join("\n");
const M630 = migration("630_deploy_database_public_port_timeout");
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

interface Golden {
  types: Record<string, { morphClass: string; table: string; encrypted: string[] }>;
  created: Record<string, { attributes: Record<string, unknown>; volumes: Array<{ name: string; mount_path: string; host_path: string | null; resource_type: string }>; environmentVariables: Array<Record<string, unknown>> }>;
}
const goldens = JSON.parse(readFileSync(resolve(root, "tests/deploy-core-worker/fixtures/databases/goldens.json"), "utf8")) as Golden;

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
  stagingId: string | number;
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
    const staging = await insertEnvironment(tx, { orgId: org, uuid: `stg${tag}`, name: "staging", projectId: project.id });
    return { serverId: server.id, destination, swarm, projectId: project.id, environmentId: environment.id, stagingId: staging.id };
  });
}

const admin = (sql: string, params: unknown[] = []) => asPlatformAdmin(ex, (tx) => tx.execute<Record<string, unknown>>(sql, params));
const raw = async (table: string, where: string, params: unknown[]) => (await admin(`SELECT * FROM deploy.${table} WHERE ${where}`, params)).rows;
const count = async (table: string, where: string, params: unknown[]) => Number((await admin(`SELECT count(*) AS n FROM deploy.${table} WHERE ${where}`, params)).rows[0]!.n);

/** What create_standalone_<engine>() sets beside the uuid, the name and where the database lives: as the goldens say, with ciphertexts in the passwords' place. */
function helperValues(engine: DatabaseEngine, goldenId: string): Record<string, string> {
  const attributes = goldens.created[goldenId]!.attributes;
  const fixed = ["uuid", "name", "environment_id", "destination_id", "destination_type"];
  const values: Record<string, string> = {};
  for (const [column, value] of Object.entries(attributes)) {
    if (fixed.includes(column)) continue;
    values[column] = DATABASE_TABLES[engine].encrypted.includes(column) ? `fp1:1:${column}` : (value as string);
  }
  return values;
}

/** The golden of each engine as the New Resource page creates it. */
const GOLDEN: Record<DatabaseEngine, string> = {
  postgresql: "postgresql postgres:18-alpine",
  redis: "redis valkey/valkey:9-alpine",
  mongodb: "mongodb",
  mysql: "mysql",
  mariadb: "mariadb",
  keydb: "keydb",
  dragonfly: "dragonfly",
  clickhouse: "clickhouse",
};

function newDatabase(org: string, f: Fixture, engine: DatabaseEngine, uuid: string, over: Partial<NewDatabase> = {}): NewDatabase {
  const golden = goldens.created[GOLDEN[engine]]!;
  return {
    orgId: org,
    uuid,
    name: (golden.attributes.name as string).replace("{uuid}", uuid),
    environmentId: f.environmentId,
    destinationId: f.destination.id,
    destinationType: "standalone",
    values: helperValues(engine, GOLDEN[engine]),
    volumes: golden.volumes.map((v, i) => ({ uuid: `vol${i}${uuid}`, name: v.name.replace("{uuid}", uuid), mountPath: v.mount_path })),
    ...over,
  };
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BEFORE_630);
  ex = executor(db);
}, 120_000);
afterAll(async () => db?.close());

describe("630_deploy_database_public_port_timeout", () => {
  const TABLES = [...DATABASE_ENGINES.map((e) => DATABASE_TABLES[e].table), "service_databases"];
  const columns = async () =>
    (await admin("SELECT table_name, column_default, is_nullable, data_type FROM information_schema.columns WHERE table_schema = 'deploy' AND column_name = 'public_port_timeout' ORDER BY table_name")).rows;

  it("adds the column Coolify's 2026_02_27 migration adds, to the same nine tables: integer, nullable, default 3600", async () => {
    expect(await columns()).toEqual([]);
    await db.exec(M630);
    expect(await columns()).toEqual([...TABLES].sort().map((table_name) => ({ table_name, column_default: "3600", is_nullable: "YES", data_type: "integer" })));
    // SQLite has no proxy (Coolify's migration leaves it out).
    expect((await columns()).map((c) => c.table_name)).not.toContain("standalone_sqlites");
  });

  it("can run again", async () => {
    await db.exec(M630);
    expect(await columns()).toHaveLength(9);
    fx.a = await fixture(A, "a");
    fx.b = await fixture(B, "b");
  });
});

describe("the engines' tables", () => {
  it("are Coolify's models: table, morph class and encrypted casts", () => {
    for (const engine of DATABASE_ENGINES) {
      const t = DATABASE_TABLES[engine];
      const golden = goldens.types[engine]!;
      expect([engine, t.table, t.morphClass, [...t.encrypted].sort()]).toEqual([engine, golden.table, golden.morphClass, golden.encrypted]);
      expect([...t.encrypted].sort()).toEqual([...(ENCRYPTED_COLUMNS[t.table] ?? [])].sort());
      expect(databaseOwner(engine, 5)).toEqual({ type: golden.morphClass, id: 5 });
    }
  });

  it("have every column the queries name", async () => {
    for (const engine of DATABASE_ENGINES) {
      const t = DATABASE_TABLES[engine];
      const existing = (await admin("SELECT column_name FROM information_schema.columns WHERE table_schema = 'deploy' AND table_name = $1", [t.table])).rows.map((r) => r.column_name);
      for (const column of writableDatabaseColumns(engine)) expect([engine, column, existing.includes(column)]).toEqual([engine, column, true]);
      expect([engine, existing.includes("enable_ssl"), existing.includes("ssl_mode"), existing.includes("legacy_password_quoting")]).toEqual([engine, t.enableSsl, t.sslMode, t.legacyPasswordQuoting]);
      for (const column of DATABASE_GENERAL_COLUMNS) expect(writableDatabaseColumns(engine)).toContain(column);
    }
  });
});

describe("insertDatabase — create_standalone_*() and the created hook", () => {
  it.each(DATABASE_ENGINES)("%s: what the helper sets, and the schema's defaults for the rest", async (engine) => {
    const uuid = `db${engine}aaaaaaaaaaaa`;
    const t = DATABASE_TABLES[engine];
    const golden = goldens.created[GOLDEN[engine]]!;
    const row = await withOrg(ex, A, (tx) => insertDatabase(tx, engine, newDatabase(A, fx.a!, engine, uuid)));
    expect(row).toMatchObject({
      engine,
      uuid,
      name: `${engine}-database-${uuid}`,
      description: null,
      status: "exited",
      is_public: false,
      public_port: null,
      public_port_timeout: 3600,
      ports_mappings: null,
      started_at: null,
      is_log_drain_enabled: false,
      config_hash: null,
      custom_docker_run_options: null,
      destination_type: "App\\Models\\StandaloneDocker",
      environment_uuid: "enva",
      environment_name: "production",
      project_uuid: "prja",
      project_name: "project-a",
      destination_uuid: "dsta",
      destination_network: "coolify",
      server_uuid: "srva",
      server_name: "server-a",
      server_ip: "203.0.113.10",
      server_is_logdrain_axiom_enabled: false,
    });
    expect(Number(row.destination_id)).toBe(Number(fx.a!.destination.id));
    // The optional columns are null where the table has none.
    expect([row.enable_ssl, row.ssl_mode === null, row.legacy_password_quoting]).toEqual([t.enableSsl ? false : null, !t.sslMode, t.legacyPasswordQuoting ? false : null]);

    const [stored] = await raw(t.table, "uuid = $1", [uuid]);
    // Every column Coolify's INSERT names holds what the helper set (the passwords as their ciphertexts).
    for (const [column, expected] of Object.entries(golden.attributes)) {
      if (column === "uuid") expect(stored![column]).toBe(uuid);
      else if (column === "name") expect(stored![column]).toBe((expected as string).replace("{uuid}", uuid));
      else if (column === "environment_id") expect(Number(stored![column])).toBe(Number(fx.a!.environmentId));
      else if (column === "destination_id") expect(Number(stored![column])).toBe(Number(fx.a!.destination.id));
      else if (t.encrypted.includes(column)) expect(stored![column]).toBe(`fp1:1:${column}`);
      else expect([column, stored![column]]).toEqual([column, expected]);
    }
    expect(stored!.org_id).toBe(A);
    expect(stored!.created_at).not.toBeNull();
    expect(stored!.updated_at).toEqual(stored!.created_at);
    expect(stored!.deleted_at).toBeNull();
    // The resource limits every engine starts with (the schema's defaults, as in Coolify's migrations).
    expect(stored).toMatchObject({ limits_memory: "0", limits_memory_swap: "0", limits_memory_swappiness: 60, limits_memory_reservation: "0", limits_cpus: "0", limits_cpuset: null, limits_cpu_shares: 1024 });

    // The created hook's volumes, in its order, as rows of the database's morph class.
    const volumes = await withOrg(ex, A, (tx) => listPersistentVolumes(tx, databaseOwner(engine, row.id)));
    expect(volumes.map((v) => ({ name: v.name, mount_path: v.mount_path, host_path: v.host_path }))).toEqual(golden.volumes.map((v) => ({ name: v.name.replace("{uuid}", uuid), mount_path: v.mount_path, host_path: v.host_path })));
    const storedVolumes = await raw("local_persistent_volumes", "resource_type = $1 AND resource_id = $2", [t.morphClass, row.id]);
    expect(storedVolumes).toHaveLength(golden.volumes.length);
    for (const volume of storedVolumes) expect([volume.resource_type, volume.org_id, volume.uuid !== null]).toEqual([golden.volumes[0]!.resource_type, A, true]);
  });

  it("the engines' own defaults: users, databases, images", async () => {
    const read = async (engine: DatabaseEngine) => (await raw(DATABASE_TABLES[engine].table, "uuid = $1", [`db${engine}aaaaaaaaaaaa`]))[0]!;
    expect(await read("postgresql")).toMatchObject({ image: "postgres:18-alpine", postgres_user: "postgres", postgres_db: "postgres", postgres_initdb_args: null, postgres_host_auth_method: null, postgres_conf: null, init_scripts: null, enable_ssl: false, ssl_mode: "require" });
    expect(await read("redis")).toMatchObject({ image: "valkey/valkey:9-alpine", redis_conf: null, enable_ssl: false, legacy_password_quoting: false });
    expect(await read("mongodb")).toMatchObject({ image: "mongo:7", mongo_conf: null, mongo_initdb_root_username: "root", mongo_initdb_database: "default", ssl_mode: "require" });
    expect(await read("mysql")).toMatchObject({ image: "mysql:8", mysql_user: "mysql", mysql_database: "default", mysql_conf: null, enable_ssl: false, ssl_mode: "REQUIRED" });
    expect(await read("mariadb")).toMatchObject({ image: "mariadb:11", mariadb_user: "mariadb", mariadb_database: "default", mariadb_conf: null, enable_ssl: false });
    expect(await read("keydb")).toMatchObject({ image: "eqalpha/keydb:latest", keydb_conf: null, enable_ssl: false, legacy_password_quoting: false });
    expect(await read("dragonfly")).toMatchObject({ image: "docker.dragonflydb.io/dragonflydb/dragonfly", enable_ssl: false, legacy_password_quoting: false });
    expect(await read("clickhouse")).toMatchObject({ image: "clickhouse/clickhouse-server:25.11", clickhouse_admin_user: "default", clickhouse_db: "default" });
  });

  it("a Supabase image's user, a Swarm destination, and a column that is not the engine's", async () => {
    const supabase = await withOrg(ex, A, (tx) =>
      insertDatabase(tx, "postgresql", newDatabase(A, fx.a!, "postgresql", "dbsupabaseaaaaaaaaaaaaaa", { values: helperValues("postgresql", "postgresql supabase/postgres:17.11.0.018"), destinationId: fx.a!.swarm.id, destinationType: "swarm", environmentId: fx.a!.stagingId })),
    );
    expect(supabase).toMatchObject({ image: "supabase/postgres:17.11.0.018", postgres_user: "supabase_admin", destination_type: "App\\Models\\SwarmDocker", destination_uuid: "swma", destination_network: "coolify-overlay", environment_uuid: "stga", server_uuid: "srva" });
    await expect(withOrg(ex, A, (tx) => insertDatabase(tx, "redis", newDatabase(A, fx.a!, "redis", "dbbadaaaaaaaaaaaaaaaaaaa", { values: { postgres_user: "x" } })))).rejects.toThrow(
      'deploy.standalone_redis has no writable column "postgres_user"',
    );
    await expect(withOrg(ex, A, (tx) => insertDatabase(tx, "clickhouse", newDatabase(A, fx.a!, "clickhouse", "dbbadaaaaaaaaaaaaaaaaaaa", { values: { enable_ssl: true } })))).rejects.toThrow("no writable column");
    expect(await count("standalone_redis", "uuid = 'dbbadaaaaaaaaaaaaaaaaaaa'", [])).toBe(0);
  });
});

describe("reading databases", () => {
  it("finds a database of any engine by its uuid, and none that is not there", async () => {
    for (const engine of DATABASE_ENGINES) {
      const uuid = `db${engine}aaaaaaaaaaaa`;
      const [found, row] = await withOrg(ex, A, async (tx) => [await findDatabaseEngineByUuid(tx, uuid), await findDatabaseByUuid(tx, uuid)] as const);
      expect([found, row?.engine, row?.uuid]).toEqual([engine, engine, uuid]);
      // The engine's own columns are part of the row.
      for (const column of DATABASE_TABLES[engine].columns) expect([engine, column, column in row!]).toEqual([engine, column, true]);
    }
    expect(await withOrg(ex, A, (tx) => findDatabaseByUuid(tx, "nope"))).toBeNull();
    expect(await withOrg(ex, A, (tx) => findDatabaseEngineByUuid(tx, "nope"))).toBeNull();
  });

  it("lists an environment's databases engine by engine, oldest first", async () => {
    await withOrg(ex, A, (tx) => insertDatabase(tx, "postgresql", newDatabase(A, fx.a!, "postgresql", "dbpostgresqlbbbbbbbbbbbb")));
    const list = await withOrg(ex, A, (tx) => listEnvironmentDatabases(tx, fx.a!.environmentId));
    expect(list.map((d) => [d.engine, d.uuid])).toEqual([
      ["postgresql", "dbpostgresqlaaaaaaaaaaaa"],
      ["postgresql", "dbpostgresqlbbbbbbbbbbbb"],
      ["redis", "dbredisaaaaaaaaaaaa"],
      ["mongodb", "dbmongodbaaaaaaaaaaaa"],
      ["mysql", "dbmysqlaaaaaaaaaaaa"],
      ["mariadb", "dbmariadbaaaaaaaaaaaa"],
      ["keydb", "dbkeydbaaaaaaaaaaaa"],
      ["dragonfly", "dbdragonflyaaaaaaaaaaaa"],
      ["clickhouse", "dbclickhouseaaaaaaaaaaaa"],
    ]);
    // What the list needs of each: its status, its server.
    expect(list[0]).toMatchObject({ status: "exited", name: "postgresql-database-dbpostgresqlaaaaaaaaaaaa", server_name: "server-a", server_is_reachable: false, server_is_usable: false, server_force_disabled: false });
    expect((await withOrg(ex, A, (tx) => listEnvironmentDatabases(tx, fx.a!.stagingId))).map((d) => d.uuid)).toEqual(["dbsupabaseaaaaaaaaaaaaaa"]);
  });
});

describe("updateDatabase — $database->save()", () => {
  it("writes the given columns and updated_at, a JSON column as JSON", async () => {
    const before = (await raw("standalone_postgresqls", "uuid = 'dbpostgresqlbbbbbbbbbbbb'", []))[0]!;
    const scripts = [{ index: 0, filename: "init.sql", content: "CREATE ROLE app;" }];
    const row = await withOrg(ex, A, (tx) =>
      updateDatabase(tx, "postgresql", before.id as number, {
        name: "orders",
        description: "The orders database",
        image: "postgres:17-alpine",
        ports_mappings: "3000:5432",
        public_port: 15432,
        public_port_timeout: null,
        is_log_drain_enabled: true,
        custom_docker_run_options: "--cap-add SYS_ADMIN",
        enable_ssl: true,
        ssl_mode: "verify-full",
        postgres_user: "app",
        postgres_password: "fp1:1:changed",
        postgres_conf: "max_connections = 50",
        init_scripts: JSON.stringify(scripts),
      }),
    );
    expect(row).toMatchObject({
      uuid: "dbpostgresqlbbbbbbbbbbbb", name: "orders", description: "The orders database", image: "postgres:17-alpine", ports_mappings: "3000:5432", public_port: 15432, public_port_timeout: null,
      is_log_drain_enabled: true, custom_docker_run_options: "--cap-add SYS_ADMIN", enable_ssl: true, ssl_mode: "verify-full", postgres_user: "app", postgres_password: "fp1:1:changed", postgres_conf: "max_connections = 50",
    });
    const stored = typeof row!.init_scripts === "string" ? (JSON.parse(row!.init_scripts) as unknown) : row!.init_scripts;
    expect(stored).toEqual(scripts);
    // A column that is not given keeps its value.
    expect(row!.postgres_db).toBe("postgres");
    // The column's check constraint refuses a mode that is not Coolify's.
    await expect(withOrg(ex, A, (tx) => updateDatabase(tx, "postgresql", before.id as number, { ssl_mode: "VERIFY_CA" }))).rejects.toThrow();
    await expect(withOrg(ex, A, (tx) => updateDatabase(tx, "postgresql", before.id as number, { status: "running" }))).rejects.toThrow('no writable column "status"');
    await expect(withOrg(ex, A, (tx) => updateDatabase(tx, "mariadb", 1, { ssl_mode: "require" }))).rejects.toThrow('no writable column "ssl_mode"');
    expect(await withOrg(ex, A, (tx) => updateDatabase(tx, "postgresql", 999999, { name: "x" }))).toBeNull();
    // The other postgresql database is untouched.
    expect((await raw("standalone_postgresqls", "uuid = 'dbpostgresqlaaaaaaaaaaaa'", []))[0]).toMatchObject({ name: "postgresql-database-dbpostgresqlaaaaaaaaaaaa", enable_ssl: false });
  });
});

describe("a database's variables — Redis's credentials", () => {
  it("stores REDIS_PASSWORD and REDIS_USERNAME as EnvironmentVariable::create() does", async () => {
    const redis = (await raw("standalone_redis", "uuid = 'dbredisaaaaaaaaaaaa'", []))[0]!;
    const owner = databaseOwner("redis", redis.id as number);
    const golden = goldens.created[GOLDEN.redis]!.environmentVariables;
    expect(golden.map((v) => v.key)).toEqual(["REDIS_PASSWORD", "REDIS_USERNAME"]);
    await withOrg(ex, A, async (tx) => {
      for (const variable of golden) {
        await insertDatabaseVariable(tx, owner, { orgId: A, uuid: `var${String(variable.key).toLowerCase()}aaaaaa`, key: variable.key as string, value: `fp1:1:${String(variable.key)}`, isShared: false, version: "4.7.6" });
      }
    });
    const stored = await raw("environment_variables", "resourceable_type = $1 AND resourceable_id = $2 ORDER BY id", [owner.type, owner.id]);
    for (const [i, variable] of golden.entries()) {
      // The columns Coolify's INSERT names, with its values (SQLite's "1" and "0" are true and false).
      expect(stored[i]).toMatchObject({
        key: variable.key,
        value: `fp1:1:${String(variable.key)}`,
        is_runtime: variable.is_runtime === "1",
        is_buildtime: variable.is_buildtime === "1",
        is_shared: variable.is_shared === "1",
        resourceable_type: variable.resourceable_type,
        version: "4.7.6",
        org_id: A,
        // The schema's defaults for the rest.
        is_preview: false,
        is_shown_once: false,
        is_multiline: false,
        is_literal: false,
        is_required: false,
      });
      expect(stored[i]!.uuid).not.toBeNull();
    }
    const password = await withOrg(ex, A, (tx) => findDatabaseVariable(tx, owner, "REDIS_PASSWORD"));
    expect(password).toMatchObject({ key: "REDIS_PASSWORD", value: "fp1:1:REDIS_PASSWORD", is_shown_once: false, is_shared: false });
    expect(await withOrg(ex, A, (tx) => findDatabaseVariable(tx, owner, "NOPE"))).toBeNull();
    // Another database's variable of the same key is not found for this one.
    expect(await withOrg(ex, A, (tx) => findDatabaseVariable(tx, databaseOwner("keydb", redis.id as number), "REDIS_PASSWORD"))).toBeNull();

    expect(await withOrg(ex, A, (tx) => updateDatabaseVariableValue(tx, owner, password!.id, "fp1:1:new", true))).toBe(true);
    expect(await withOrg(ex, A, (tx) => findDatabaseVariable(tx, owner, "REDIS_PASSWORD"))).toMatchObject({ value: "fp1:1:new", is_shared: true });
    expect(await withOrg(ex, A, (tx) => updateDatabaseVariableValue(tx, databaseOwner("keydb", 1), password!.id, "x", false))).toBe(false);
    // The first variable of a key is the one read, as ->first() does.
    await withOrg(ex, A, (tx) => insertDatabaseVariable(tx, owner, { orgId: A, uuid: "varduplicateaaaaaaaaaaaa", key: "REDIS_PASSWORD", value: "fp1:1:second", isShared: false, version: "4.7.6" }));
    expect((await withOrg(ex, A, (tx) => findDatabaseVariable(tx, owner, "REDIS_PASSWORD")))!.value).toBe("fp1:1:new");
  });
});

describe("the guards of projects, environments and destinations see databases", () => {
  it.each(DATABASE_ENGINES)("%s", async (engine) => {
    // Org B has one environment and one destination with nothing in them, then one database of this engine.
    const before = await withOrg(ex, B, async (tx) => ({
      environment: await environmentHasResources(tx, fx.b!.environmentId),
      project: await projectHasResources(tx, fx.b!.projectId),
      attached: await destinationIsAttached(tx, "standalone", fx.b!.destination.id),
      resources: await listDestinationResources(tx, "standalone", fx.b!.destination.id),
      projects: await listProjectsWithCounts(tx),
    }));
    expect([before.environment, before.project, before.attached, before.resources, Number(before.projects[0]!.resource_count)]).toEqual([false, false, false, [], 0]);

    const uuid = `guard${engine}bbbbbbbbb`;
    const row = await withOrg(ex, B, (tx) => insertDatabase(tx, engine, newDatabase(B, fx.b!, engine, uuid)));
    const after = await withOrg(ex, B, async (tx) => ({
      environment: await environmentHasResources(tx, fx.b!.environmentId),
      staging: await environmentHasResources(tx, fx.b!.stagingId),
      project: await projectHasResources(tx, fx.b!.projectId),
      attached: await destinationIsAttached(tx, "standalone", fx.b!.destination.id),
      swarm: await destinationIsAttached(tx, "swarm", fx.b!.swarm.id),
      resources: await listDestinationResources(tx, "standalone", fx.b!.destination.id),
      projects: await listProjectsWithCounts(tx),
    }));
    expect([after.environment, after.staging, after.project, after.attached, after.swarm, Number(after.projects[0]!.resource_count)]).toEqual([true, false, true, true, false, 1]);
    expect(after.resources).toHaveLength(1);
    expect(after.resources[0]).toMatchObject({ uuid, name: `${engine}-database-${uuid}`, type: "database", environment_uuid: "envb", project_uuid: "prjb" });

    // A soft-deleted database (Coolify's Danger sets deleted_at before the job runs) is no resource anymore.
    await admin(`UPDATE deploy.${DATABASE_TABLES[engine].table} SET deleted_at = now() WHERE id = $1`, [row.id]);
    expect(await withOrg(ex, B, async (tx) => [await environmentHasResources(tx, fx.b!.environmentId), await destinationIsAttached(tx, "standalone", fx.b!.destination.id), await findDatabaseByUuid(tx, uuid)])).toEqual([false, false, null]);
    expect(await withOrg(ex, B, (tx) => listEnvironmentDatabases(tx, fx.b!.environmentId))).toEqual([]);
    await admin(`UPDATE deploy.${DATABASE_TABLES[engine].table} SET deleted_at = NULL WHERE id = $1`, [row.id]);

    // Deleted for good: the guards are free again.
    expect(await withOrg(ex, B, (tx) => deleteDatabase(tx, engine, row.id))).toBe(true);
    const gone = await withOrg(ex, B, async (tx) => [await environmentHasResources(tx, fx.b!.environmentId), await projectHasResources(tx, fx.b!.projectId), await destinationIsAttached(tx, "standalone", fx.b!.destination.id)]);
    expect(gone).toEqual([false, false, false]);
    expect(await count("local_persistent_volumes", "resource_type = $1 AND resource_id = $2", [DATABASE_TABLES[engine].morphClass, row.id])).toBe(0);
    expect(await withOrg(ex, B, (tx) => deleteDatabase(tx, engine, row.id))).toBe(false);
  });
});

describe("deleteDatabase — deleteLocalResource() and the model's hooks", () => {
  it("removes the database with everything that belongs to it, and nothing else", async () => {
    const engine: DatabaseEngine = "postgresql";
    const morph = DATABASE_TABLES[engine].morphClass;
    const doomed = (await raw("standalone_postgresqls", "uuid = 'dbpostgresqlbbbbbbbbbbbb'", []))[0]!.id as number;
    const kept = (await raw("standalone_postgresqls", "uuid = 'dbpostgresqlaaaaaaaaaaaa'", []))[0]!.id as number;
    // The MySQL database has the same numeric id space of its own: its rows must not be touched by a PostgreSQL delete.
    const mysql = (await raw("standalone_mysqls", "uuid = 'dbmysqlaaaaaaaaaaaa'", []))[0]!.id as number;

    for (const [type, id, tag] of [[morph, doomed, "d"], [morph, kept, "k"], [DATABASE_TABLES.mysql.morphClass, mysql, "m"]] as const) {
      await withOrg(ex, A, async (tx) => {
        const owner = { type, id };
        await insertFileVolume(tx, { orgId: A, owner, uuid: `file${tag}aaaaaaaaaaaaaaaaaaa`, fsPath: `/data/${tag}/init.sql`, mountPath: "/init.sql", content: null, isDirectory: false, isHostFile: false });
        await insertDatabaseVariable(tx, owner, { orgId: A, uuid: `var${tag}aaaaaaaaaaaaaaaaaaaa`, key: "PGDATA", value: "fp1:1:x", isShared: false, version: "4.7.6" });
        await insertSslCertificate(tx, {
          orgId: A, resourceType: type, resourceId: id, serverId: fx.a!.serverId, sslCertificate: "fp1:1:cert", sslPrivateKey: "fp1:1:key", commonName: `db-${tag}`, subjectAlternativeNames: [], validUntil: new Date("2027-11-24T10:00:00Z"),
          isCaCertificate: false, configurationDir: null, mountPath: null,
        });
      });
      await admin("INSERT INTO deploy.tags (uuid, name, org_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", ["tagshared", "prod", A]);
      const tag_id = (await raw("tags", "uuid = 'tagshared'", []))[0]!.id;
      await admin("INSERT INTO deploy.taggables (tag_id, taggable_id, taggable_type, org_id) VALUES ($1, $2, $3, $4)", [tag_id, id, type, A]);
      await admin("INSERT INTO deploy.scheduled_database_backups (uuid, frequency, database_id, database_type, org_id) VALUES ($1, 'daily', $2, $3, $4)", [`dbbak${tag}`, id, type, A]);
      const backup = (await raw("scheduled_database_backups", "uuid = $1", [`dbbak${tag}`]))[0]!.id;
      await admin("INSERT INTO deploy.scheduled_database_backup_executions (uuid, scheduled_database_backup_id, org_id) VALUES ($1, $2, $3)", [`dbexe${tag}`, backup, A]);
      const execution = (await raw("scheduled_database_backup_executions", "uuid = $1", [`dbexe${tag}`]))[0]!.id;
      await admin("INSERT INTO deploy.database_backup_s3_replicas (execution_id, org_id) VALUES ($1, $2)", [execution, A]);
      await admin("INSERT INTO deploy.scheduled_database_backup_s3_storage (scheduled_database_backup_id, s3_storage_id, org_id) VALUES ($1, 1, $2)", [backup, A]);
      const volume = (await raw("local_persistent_volumes", "resource_type = $1 AND resource_id = $2", [type, id]))[0]!.id;
      await admin("INSERT INTO deploy.scheduled_volume_backups (uuid, backupable_type, backupable_id, frequency, org_id) VALUES ($1, $2, $3, 'daily', $4)", [`volbak${tag}`, PERSISTENT_VOLUME_MORPH_CLASS, volume, A]);
      const volumeBackup = (await raw("scheduled_volume_backups", "uuid = $1", [`volbak${tag}`]))[0]!.id;
      await admin("INSERT INTO deploy.scheduled_volume_backup_executions (uuid, scheduled_volume_backup_id, org_id) VALUES ($1, $2, $3)", [`volexe${tag}`, volumeBackup, A]);
      await admin("INSERT INTO deploy.scheduled_volume_backup_s3_storage (scheduled_volume_backup_id, s3_storage_id, org_id) VALUES ($1, 1, $2)", [volumeBackup, A]);
      await admin("INSERT INTO deploy.secret_manager_links (uuid, resourceable_type, resourceable_id, integration_token_id, org_id) VALUES ($1, $2, $3, 1, $4)", [`sml${tag}`, type, id, A]);
      await admin("INSERT INTO deploy.stars (user_id, starrable_id, starrable_type, org_id) VALUES (1, $1, $2, $3)", [id, type, A]);
      await admin("INSERT INTO deploy.image_scans (uuid, server_id, image_id, resource_id, resource_type, image_ref, status, org_id) VALUES ($1, $2, 'sha256:x', $3, $4, 'postgres:18', 'completed', $5)", [`scan${tag}`, fx.a!.serverId, id, type, A]);
      await admin("INSERT INTO deploy.image_scan_policies (uuid, scope_type, scope_id, org_id) VALUES ($1, $2, $3, $4)", [`pol${tag}`, type, id, A]);
      await admin("INSERT INTO deploy.image_scan_ignores (uuid, reason, resource_type, resource_id, org_id) VALUES ($1, 'accepted', $2, $3, $4)", [`ign${tag}`, type, id, A]);
      await admin("INSERT INTO deploy.image_scan_notification_states (resource_type, resource_id, org_id) VALUES ($1, $2, $3)", [type, id, A]);
    }

    const census = async (type: string, id: number) => ({
      volumes: await count("local_persistent_volumes", "resource_type = $1 AND resource_id = $2", [type, id]),
      files: await count("local_file_volumes", "resource_type = $1 AND resource_id = $2", [type, id]),
      variables: await count("environment_variables", "resourceable_type = $1 AND resourceable_id = $2", [type, id]),
      certificates: await count("ssl_certificates", "resource_type = $1 AND resource_id = $2", [type, id]),
      tags: await count("taggables", "taggable_type = $1 AND taggable_id = $2", [type, id]),
      backups: await count("scheduled_database_backups", "database_type = $1 AND database_id = $2", [type, id]),
      links: await count("secret_manager_links", "resourceable_type = $1 AND resourceable_id = $2", [type, id]),
      stars: await count("stars", "starrable_type = $1 AND starrable_id = $2", [type, id]),
      scans: await count("image_scans", "resource_type = $1 AND resource_id = $2", [type, id]),
      policies: await count("image_scan_policies", "scope_type = $1 AND scope_id = $2", [type, id]),
      ignores: await count("image_scan_ignores", "resource_type = $1 AND resource_id = $2", [type, id]),
      states: await count("image_scan_notification_states", "resource_type = $1 AND resource_id = $2", [type, id]),
    });
    const all = { volumes: 1, files: 1, variables: 1, certificates: 1, tags: 1, backups: 1, links: 1, stars: 1, scans: 1, policies: 1, ignores: 1, states: 1 };
    const none = Object.fromEntries(Object.keys(all).map((k) => [k, 0]));
    const byTag = async (tag: string) => [
      await count("scheduled_database_backup_executions", "uuid = $1", [`dbexe${tag}`]),
      await count("database_backup_s3_replicas", "execution_id IN (SELECT id FROM deploy.scheduled_database_backup_executions WHERE uuid = $1)", [`dbexe${tag}`]),
      await count("scheduled_volume_backups", "uuid = $1", [`volbak${tag}`]),
      await count("scheduled_volume_backup_executions", "uuid = $1", [`volexe${tag}`]),
    ];
    expect(await census(morph, doomed)).toEqual(all);
    const replicasBefore = await count("database_backup_s3_replicas", "true", []);
    const linksBefore = [await count("scheduled_database_backup_s3_storage", "true", []), await count("scheduled_volume_backup_s3_storage", "true", [])];

    expect(await withOrg(ex, A, (tx) => deleteDatabase(tx, engine, doomed))).toBe(true);

    expect(await census(morph, doomed)).toEqual(none);
    expect(await byTag("d")).toEqual([0, 0, 0, 0]);
    expect(await count("database_backup_s3_replicas", "true", [])).toBe(replicasBefore - 1);
    expect([await count("scheduled_database_backup_s3_storage", "true", []), await count("scheduled_volume_backup_s3_storage", "true", [])]).toEqual(linksBefore.map((n) => n - 1));
    expect(await count("standalone_postgresqls", "id = $1", [doomed])).toBe(0);
    // The other PostgreSQL database, and a MySQL database, keep everything; so does the tag itself.
    expect(await census(morph, kept)).toEqual(all);
    expect(await census(DATABASE_TABLES.mysql.morphClass, mysql)).toEqual(all);
    expect(await byTag("k")).toEqual([1, 1, 1, 1]);
    expect(await byTag("m")).toEqual([1, 1, 1, 1]);
    expect(await count("tags", "uuid = 'tagshared'", [])).toBe(1);
    expect(await count("standalone_postgresqls", "id = $1", [kept])).toBe(1);
    expect(await withOrg(ex, A, (tx) => findDatabaseByUuid(tx, "dbpostgresqlbbbbbbbbbbbb"))).toBeNull();

    // The certificate of a database is read for the SSL section.
    expect(String(await withOrg(ex, A, (tx) => findDatabaseCertificateValidUntil(tx, databaseOwner(engine, kept))))).toMatch(/2027/);
    expect(await withOrg(ex, A, (tx) => findDatabaseCertificateValidUntil(tx, databaseOwner(engine, doomed)))).toBeNull();
    expect(await withOrg(ex, A, (tx) => findDatabaseCertificateValidUntil(tx, databaseOwner("redis", kept)))).toBeNull();
  });
});

describe("row-level security", () => {
  it("keeps each org's databases to itself", async () => {
    for (const engine of DATABASE_ENGINES) {
      const uuid = `db${engine}aaaaaaaaaaaa`;
      const id = (await raw(DATABASE_TABLES[engine].table, "uuid = $1", [uuid]))[0]!.id as number;
      const seen = await withOrg(ex, B, async (tx) => ({
        engine: await findDatabaseEngineByUuid(tx, uuid),
        row: await findDatabaseByUuid(tx, uuid),
        list: await listEnvironmentDatabases(tx, fx.a!.environmentId),
        updated: await updateDatabase(tx, engine, id, { name: "taken" }),
        deleted: await deleteDatabase(tx, engine, id),
        volumes: await listPersistentVolumes(tx, databaseOwner(engine, id)),
      }));
      expect([engine, seen]).toEqual([engine, { engine: null, row: null, list: [], updated: null, deleted: false, volumes: [] }]);
      // Org A still has it, unchanged, with its volumes.
      expect((await raw(DATABASE_TABLES[engine].table, "id = $1", [id]))[0]).toMatchObject({ uuid, org_id: A });
      expect(await count("local_persistent_volumes", "resource_type = $1 AND resource_id = $2", [DATABASE_TABLES[engine].morphClass, id])).toBeGreaterThan(0);
    }
    const redis = (await raw("standalone_redis", "uuid = 'dbredisaaaaaaaaaaaa'", []))[0]!.id as number;
    expect(await withOrg(ex, B, (tx) => findDatabaseVariable(tx, databaseOwner("redis", redis), "REDIS_PASSWORD"))).toBeNull();
    // A row cannot be written for another org.
    await expect(withOrg(ex, B, (tx) => insertDatabase(tx, "keydb", newDatabase(A, fx.b!, "keydb", "dbforeignaaaaaaaaaaaaaaa")))).rejects.toThrow();
    expect(await count("standalone_keydbs", "uuid = 'dbforeignaaaaaaaaaaaaaaa'", [])).toBe(0);
  });
});
