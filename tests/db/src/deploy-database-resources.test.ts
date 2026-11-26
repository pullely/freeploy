// The SQL behind a standalone database's shared configuration pages (DP-64),
// on the schema at head: the Environment Variables page keyed by the
// database's type (its row, its two switches on its own table, its variables
// under its morph class), and the Resource Operations and Resource Limits
// rows of a database — the move, cloneTo()'s replicas of the database, its
// variables and its backup schedules with their S3 destinations, the limits —
// for every engine, and row-level security keeping each org's rows to itself.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  insertPrivateKey,
  insertServer,
  insertProject,
  insertEnvironment,
  listServerDestinations,
  insertDatabase,
  findDatabaseByUuid,
  listPersistentVolumes,
  databaseOwner,
  DATABASE_ENGINES,
  DATABASE_TABLES,
  ENVIRONMENT_VARIABLE_MORPH_CLASS,
  databaseEnvironmentVariableResourceType,
  environmentVariableSettingColumns,
  findEnvironmentVariableResource,
  insertEnvironmentVariable,
  listEnvironmentVariables,
  updateEnvironmentVariableSettings,
  moveDatabase,
  replicateDatabase,
  listDatabaseEnvironmentVariableIds,
  replicateDatabaseEnvironmentVariable,
  listDatabaseBackupScheduleIds,
  replicateDatabaseBackupSchedule,
  findDatabaseLimits,
  updateDatabaseLimits,
  DATABASE_LIMIT_COLUMNS,
  type DatabaseEngine,
  type DeployDestinationRow,
  type NewEnvironmentVariable,
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
  stagingId: string | number;
  serverId: string | number;
  projectId: string | number;
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
    const { project, environment } = await insertProject(tx, { orgId: org, uuid: `prj${tag}`, name: `project-${tag}`, description: null, productionEnvironmentUuid: `env${tag}` });
    const staging = await insertEnvironment(tx, { orgId: org, uuid: `stg${tag}`, name: "staging", projectId: project.id });
    return { destination, environmentId: environment.id, stagingId: staging.id, serverId: server.id, projectId: project.id };
  });
}

const admin = (sql: string, params: unknown[] = []) => asPlatformAdmin(ex, (tx) => tx.execute<Record<string, unknown>>(sql, params));
const raw = async (table: string, where: string, params: unknown[]) => (await admin(`SELECT * FROM deploy.${table} WHERE ${where} ORDER BY id`, params)).rows;

/** A database of the engine as create_standalone_*() leaves it (a ciphertext in each password column), with one data volume. */
async function newDatabase(org: string, engine: DatabaseEngine, uuid: string): Promise<string | number> {
  const t = DATABASE_TABLES[engine];
  const values = Object.fromEntries(t.encrypted.map((c) => [c, `fp1:1:${c}`]));
  const row = await withOrg(ex, org, (tx) =>
    insertDatabase(tx, engine, {
      orgId: org, uuid, name: `${engine}-database-${uuid}`, environmentId: fx[org === A ? "a" : "b"]!.environmentId, destinationId: fx[org === A ? "a" : "b"]!.destination.id,
      destinationType: "standalone", values, volumes: [{ uuid: `vol${uuid}`, name: `${engine}-data-${uuid}`, mountPath: "/data" }],
    }),
  );
  return row.id;
}

function variable(key: string, over: Partial<NewEnvironmentVariable> = {}): NewEnvironmentVariable {
  return {
    orgId: A, uuid: `ev-${key}-${Math.random().toString(36).slice(2, 10)}`, key, value: `fp1:1:${key}`, comment: null, order: 1, isPreview: false, isMultiline: false, isLiteral: false,
    isRuntime: true, isBuildtime: true, isRequired: false, isShownOnce: false, isShared: false, version: "4.7.5", ...over,
  };
}

beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
  fx.a = await fixture(A, "a");
  fx.b = await fixture(B, "b");
}, 120_000);
afterAll(async () => db?.close());

describe("the Environment Variables page of a database", () => {
  it("has a resource type per engine: Coolify's type() and the model's morph class", () => {
    for (const engine of DATABASE_ENGINES) {
      expect(databaseEnvironmentVariableResourceType(engine)).toBe(`standalone-${engine}`);
      expect(ENVIRONMENT_VARIABLE_MORPH_CLASS[`standalone-${engine}`]).toBe(DATABASE_TABLES[engine].morphClass);
      expect(environmentVariableSettingColumns(`standalone-${engine}`)).toEqual(["include_coolify_default_variables", "redact_all_env_values_in_logs"]);
    }
    expect(ENVIRONMENT_VARIABLE_MORPH_CLASS.application).toBe("App\\Models\\Application");
    expect(environmentVariableSettingColumns("application")).toEqual(["is_env_sorting_enabled", "use_build_secrets", "include_coolify_default_variables", "redact_all_env_values_in_logs"]);
  });

  it.each(DATABASE_ENGINES)("%s: finds the database with its scopes and switches, stores its variables and its two switches", async (engine) => {
    const uuid = `ev${engine}aaaaaaaaaaaaaaa`;
    const id = await newDatabase(A, engine, uuid);
    const type = databaseEnvironmentVariableResourceType(engine);
    const other = engine === "redis" ? "standalone-postgresql" : "standalone-redis";
    const seen = await withOrg(ex, A, async (tx) => ({
      resource: await findEnvironmentVariableResource(tx, type, uuid),
      wrongType: await findEnvironmentVariableResource(tx, other, uuid),
      inserted: await insertEnvironmentVariable(tx, type, id, variable("DB_EXTRA")),
      twice: await insertEnvironmentVariable(tx, type, id, variable("DB_EXTRA")),
      listed: (await listEnvironmentVariables(tx, type, id, false)).map((v) => v.key),
      previews: await listEnvironmentVariables(tx, type, id, true),
      saved: await updateEnvironmentVariableSettings(tx, type, id, { include_coolify_default_variables: false, redact_all_env_values_in_logs: false }),
    }));
    expect(seen.resource).toMatchObject({
      uuid, name: `${engine}-database-${uuid}`, build_pack: null, git_repository: null, dockerfile: null, docker_compose: null,
      environment_uuid: "enva", project_uuid: "prja", server_uuid: "srva", is_env_sorting_enabled: null, use_build_secrets: null,
      include_coolify_default_variables: true, redact_all_env_values_in_logs: true,
    });
    expect(String(seen.resource!.id)).toBe(String(id));
    expect(String(seen.resource!.server_id)).toBe(String(fx.a!.serverId));
    expect(String(seen.resource!.project_id)).toBe(String(fx.a!.projectId));
    expect(seen.wrongType).toBeNull();
    expect(seen.inserted).not.toBeNull();
    expect(seen.twice).toBeNull();
    expect([seen.listed, seen.previews, seen.saved]).toEqual([["DB_EXTRA"], [], true]);
    expect((await raw("environment_variables", "uuid = $1", [seen.inserted!.uuid]))[0]).toMatchObject({ resourceable_type: DATABASE_TABLES[engine].morphClass, org_id: A });
    expect((await raw(DATABASE_TABLES[engine].table, "id = $1", [id]))[0]).toMatchObject({ include_coolify_default_variables: false, redact_all_env_values_in_logs: false });
    // The order and build secrets switches are an application's settings row's only.
    await expect(withOrg(ex, A, (tx) => updateEnvironmentVariableSettings(tx, type, id, { is_env_sorting_enabled: true }))).rejects.toThrow('has no setting "is_env_sorting_enabled"');
  });
});

describe("a database's Resource Operations", () => {
  it.each(DATABASE_ENGINES)("%s: moves the database, and replicates its row with what cloneTo() fills in", async (engine) => {
    const uuid = `ro${engine}aaaaaaaaaaaaaaa`;
    const id = await newDatabase(A, engine, uuid);
    const t = DATABASE_TABLES[engine];
    await admin(`UPDATE deploy.${t.table} SET status = 'running:healthy', started_at = '2026-11-01 10:00:00', is_public = true, public_port = 54321, limits_memory = '256m' WHERE id = $1`, [id]);
    expect(await withOrg(ex, A, (tx) => moveDatabase(tx, engine, id, fx.a!.stagingId))).toBe(true);
    const source = (await raw(t.table, "id = $1", [id]))[0]!;
    expect(String(source.environment_id)).toBe(String(fx.a!.stagingId));

    const clone = `cl${engine}aaaaaaaaaaaaaaa`;
    const cloneId = await withOrg(ex, A, (tx) =>
      replicateDatabase(tx, engine, id, { uuid: clone, name: `name-clone-${clone}`, environmentId: fx.a!.environmentId, destinationId: fx.a!.destination.id, destinationType: "standalone" }),
    );
    expect(cloneId).not.toBeNull();
    const replica = (await raw(t.table, "id = $1", [cloneId]))[0]!;
    const differs = ["id", "uuid", "name", "status", "started_at", "environment_id", "created_at", "updated_at", "last_online_at"];
    for (const [column, value] of Object.entries(source)) if (!differs.includes(column)) expect([column, replica[column]]).toEqual([column, value]);
    expect(replica).toMatchObject({ uuid: clone, name: `name-clone-${clone}`, status: "exited:unhealthy", started_at: null, is_public: true, public_port: 54321, limits_memory: "256m", org_id: A });
    expect(String(replica.environment_id)).toBe(String(fx.a!.environmentId));
    expect(replica.last_online_at).not.toBeNull();
    expect(replica.created_at).not.toBeNull();
    for (const column of t.encrypted) expect(replica[column]).toBe(`fp1:1:${column}`);
    // The replica is a database like any other, and the created hook's volumes are not made: cloneTo() copies the source's.
    const found = await withOrg(ex, A, (tx) => findDatabaseByUuid(tx, clone));
    expect([found?.engine, found?.uuid]).toEqual([engine, clone]);
    expect(await withOrg(ex, A, (tx) => listPersistentVolumes(tx, databaseOwner(engine, cloneId!)))).toEqual([]);
    expect(await withOrg(ex, A, (tx) => replicateDatabase(tx, engine, 999999, { uuid: "gone", name: "gone", environmentId: fx.a!.environmentId, destinationId: fx.a!.destination.id, destinationType: "standalone" }))).toBeNull();
  });

  it("replicates a database's variables with the creating hook's version, and its backup schedules with their S3 destinations", async () => {
    const id = await newDatabase(A, "postgresql", "rvpostgresaaaaaaaaaaaa");
    const cloneId = await withOrg(ex, A, (tx) =>
      replicateDatabase(tx, "postgresql", id, { uuid: "rvclonepostgresaaaaaaa", name: "c", environmentId: fx.a!.environmentId, destinationId: fx.a!.destination.id, destinationType: "standalone" }),
    );
    const type = databaseEnvironmentVariableResourceType("postgresql");
    await withOrg(ex, A, async (tx) => {
      await insertEnvironmentVariable(tx, type, id, variable("ONE", { isShownOnce: true, comment: "kept" }));
      await insertEnvironmentVariable(tx, type, id, variable("TWO"));
    });
    const ids = await withOrg(ex, A, (tx) => listDatabaseEnvironmentVariableIds(tx, "postgresql", id));
    expect(ids).toHaveLength(2);
    for (const [i, variableId] of ids.entries()) await withOrg(ex, A, (tx) => replicateDatabaseEnvironmentVariable(tx, variableId, { uuid: `rv-clone-${i}`, engine: "postgresql", databaseId: cloneId!, version: "4.7.6" }));
    const copies = await raw("environment_variables", "resourceable_type = $1 AND resourceable_id = $2", [DATABASE_TABLES.postgresql.morphClass, cloneId]);
    expect(copies.map((v) => [v.key, v.value, v.version, v.uuid, v.is_shown_once, v.comment, v.org_id])).toEqual([
      ["ONE", "fp1:1:ONE", "4.7.6", "rv-clone-0", true, "kept", A],
      ["TWO", "fp1:1:TWO", "4.7.6", "rv-clone-1", false, null, A],
    ]);

    const morph = DATABASE_TABLES.postgresql.morphClass;
    const s3 = (await admin(`INSERT INTO deploy.s3_storages (uuid, name, "key", secret, org_id) VALUES ('s3rv', 'bucket', 'k', 's', $1) RETURNING id`, [A])).rows[0]!.id;
    const schedule = (
      await admin(`INSERT INTO deploy.scheduled_database_backups (uuid, frequency, database_id, database_type, s3_storage_id, org_id) VALUES ('bkrv', '0 0 * * *', $1, $2, $3, $4) RETURNING id`, [id, morph, s3, A])
    ).rows[0]!.id as number;
    await admin(`INSERT INTO deploy.scheduled_database_backup_s3_storage (scheduled_database_backup_id, s3_storage_id, org_id) VALUES ($1, $2, $3)`, [schedule, s3, A]);
    expect(await withOrg(ex, A, (tx) => listDatabaseBackupScheduleIds(tx, "postgresql", id))).toEqual([schedule]);
    await withOrg(ex, A, (tx) => replicateDatabaseBackupSchedule(tx, schedule, { uuid: "bkrvclone", engine: "postgresql", databaseId: cloneId! }));
    const copied = await raw("scheduled_database_backups", "database_type = $1 AND database_id = $2", [morph, cloneId]);
    expect(copied.map((b) => [b.uuid, b.frequency, String(b.s3_storage_id), b.org_id])).toEqual([["bkrvclone", "0 0 * * *", String(s3), A]]);
    const links = await raw("scheduled_database_backup_s3_storage", "scheduled_database_backup_id = $1", [copied[0]!.id]);
    expect(links.map((l) => [String(l.s3_storage_id), l.org_id])).toEqual([[String(s3), A]]);
    expect(await raw("scheduled_database_backup_executions", "scheduled_database_backup_id = $1", [copied[0]!.id])).toEqual([]);
  });
});

describe("a database's Resource Limits", () => {
  it.each(DATABASE_ENGINES)("%s: reads the schema's defaults and writes the given limits", async (engine) => {
    const id = await newDatabase(A, engine, `rl${engine}aaaaaaaaaaaaaaa`);
    expect(await withOrg(ex, A, (tx) => findDatabaseLimits(tx, engine, id))).toEqual({
      limits_memory: "0", limits_memory_swap: "0", limits_memory_swappiness: 60, limits_memory_reservation: "0", limits_cpus: "0", limits_cpuset: null, limits_cpu_shares: 1024,
    });
    expect(await withOrg(ex, A, (tx) => updateDatabaseLimits(tx, engine, id, { limits_memory: "1g", limits_cpuset: "0-1", limits_cpu_shares: 512 }))).toBe(true);
    expect(await withOrg(ex, A, (tx) => findDatabaseLimits(tx, engine, id))).toMatchObject({ limits_memory: "1g", limits_cpuset: "0-1", limits_cpu_shares: 512, limits_cpus: "0" });
    expect(DATABASE_LIMIT_COLUMNS).toHaveLength(7);
    expect(await withOrg(ex, A, (tx) => findDatabaseLimits(tx, engine, 999999))).toBeNull();
  });
});

describe("row-level security", () => {
  it("keeps each org's database rows to itself", async () => {
    const id = await newDatabase(A, "redis", "rlsredisaaaaaaaaaaaaaaa");
    const type = databaseEnvironmentVariableResourceType("redis");
    await withOrg(ex, A, (tx) => insertEnvironmentVariable(tx, type, id, variable("REDIS_PASSWORD")));
    const seen = await withOrg(ex, B, async (tx) => ({
      resource: await findEnvironmentVariableResource(tx, type, "rlsredisaaaaaaaaaaaaaaa"),
      variables: await listEnvironmentVariables(tx, type, id, false),
      settings: await updateEnvironmentVariableSettings(tx, type, id, { include_coolify_default_variables: false }),
      moved: await moveDatabase(tx, "redis", id, fx.b!.environmentId),
      replica: await replicateDatabase(tx, "redis", id, { uuid: "rlsclone", name: "x", environmentId: fx.b!.environmentId, destinationId: fx.b!.destination.id, destinationType: "standalone" }),
      variableIds: await listDatabaseEnvironmentVariableIds(tx, "redis", id),
      limits: await findDatabaseLimits(tx, "redis", id),
      limited: await updateDatabaseLimits(tx, "redis", id, { limits_memory: "1m" }),
    }));
    expect(seen).toEqual({ resource: null, variables: [], settings: false, moved: false, replica: null, variableIds: [], limits: null, limited: false });
    expect((await raw("standalone_redis", "id = $1", [id]))[0]).toMatchObject({ include_coolify_default_variables: true, limits_memory: "0", org_id: A });
    expect(String((await raw("standalone_redis", "id = $1", [id]))[0]!.environment_id)).toBe(String(fx.a!.environmentId));
  });
});
