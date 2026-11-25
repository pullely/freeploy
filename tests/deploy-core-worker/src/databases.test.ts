// Standalone databases (DP-57): creating one and its General page, for the
// eight engines. What Coolify computes is checked against Coolify's own PHP:
// fixtures/databases/goldens.json is what coollabsio/coolify@91b7e3e returns
// for fixtures/databases/cases.json (emit.php, see the README there) — the
// rows create_standalone_*() stores, the connection URLs, and Laravel's
// validator with each General component's own rules and messages. The rest is
// the service's behaviour (what is stored, what answers "not available yet",
// what a reader sees) and the handler's routing and authorization. The SQL
// behind the store (and its row-level security) is tested in tests/db.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { handleDatabases, type DatabaseRunner } from "@deploy-core-worker/handlers/databases";
import { handleEnvironmentResources, type ApplicationRunner } from "@deploy-core-worker/handlers/applications";
import type { ApplicationStore } from "@deploy-core-worker/applications/service";
import { CREATABLE_TYPE_IDS, DATABASES, DATABASE_TYPE_IDS } from "@deploy-core-worker/applications/catalogue";
import { DATABASE_ENGINE_SPECS, defaultVolumes, isDatabaseEngine, isSupabaseImage } from "@deploy-core-worker/databases/engines";
import { externalDbUrl, formatHostForUrl, internalDbUrl, phpVersionCompare, rawUrlEncode, redisHasUsername, redisUsername, redisVersion, sanitizeString } from "@deploy-core-worker/databases/urls";
import { validateCreateDatabase, validateDatabaseGeneral, validateFilenameSafe } from "@deploy-core-worker/databases/validation";
import { DATABASE_SERVICE_MESSAGES, databaseResources, databaseStatus, initScripts, strPassword, type DatabaseStore } from "@deploy-core-worker/databases/service";
import { DATABASE_ENGINES, DATABASE_TABLES, ENCRYPTED_COLUMNS } from "@saas/db/deploy";
import type { DatabaseColumnValue, DatabaseEngine, DeployDatabaseRow, DeployDatabaseVariableRow, DeployDestinationRow, DeployEnvironmentListRow, DeployProjectRow, DeployServerRow, NewDatabase, NewDatabaseVariable } from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const UNAVAILABLE = (what: string) => `${what} needs the SSH executor, which is not available yet.`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

// ---------------------------------------------------------------- Coolify's goldens
interface Shape {
  length: number;
  alphanumeric: boolean;
  hasLetter: boolean;
  hasDigit: boolean;
}
interface CaseVariable {
  key: string;
  value: string;
  is_shown_once?: boolean;
  is_shared?: boolean;
}
interface ValidationCase {
  type: DatabaseEngine;
  stored?: Record<string, string>;
  environmentVariables?: CaseVariable[];
  input: Record<string, unknown>;
}
interface Cases {
  created: Record<string, { type: DatabaseEngine; database_image?: string }>;
  urls: Record<string, { type: DatabaseEngine; attributes: Record<string, unknown>; serverIp?: string; environmentVariables?: CaseVariable[] }>;
  validationBase: Record<string, { stored: Record<string, string>; environmentVariables: CaseVariable[]; input: Record<string, unknown> }>;
  validation: Record<string, ValidationCase>;
}
interface Goldens {
  types: Record<string, { morphClass: string; type: string; table: string; headline: string; backups: boolean; encrypted: string[] }>;
  created: Record<
    string,
    {
      ok: boolean;
      attributes: Record<string, unknown>;
      volumes: Array<{ name: string; mount_path: string; host_path: string | null; resource_type: string }>;
      environmentVariables: Array<Record<string, unknown>>;
    }
  >;
  urls: Record<string, { ok: boolean; internal: string; external: string | null }>;
  validation: Record<string, { ok: boolean; errors?: Record<string, string[]>; typeErrors?: string[] }>;
  /** Keyed "0", "1", …: one shape per draw. */
  password: Record<string, Shape>;
}

const dir = join(process.cwd(), "fixtures", "databases");
const cases = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")) as Cases;
const goldens = JSON.parse(readFileSync(join(dir, "goldens.json"), "utf8")) as Goldens;

const shape = (value: string): Shape => ({ length: value.length, alphanumeric: /^[A-Za-z0-9]+$/.test(value), hasLetter: /[A-Za-z]/.test(value), hasDigit: /[0-9]/.test(value) });

/** A value sealed for one column: opening it for another column fails, as with the org's cipher. */
const seal = (column: string, plaintext: string) => `fp1:1:${column}:${Buffer.from(plaintext).toString("base64")}`;
function open(column: string, stored: string): string {
  const prefix = `fp1:1:${column}:`;
  if (!stored.startsWith(prefix)) throw new Error(`${stored} is not sealed for ${column}`);
  return Buffer.from(stored.slice(prefix.length), "base64").toString();
}

// ---------------------------------------------------------------- an org's databases, in memory
type Id = string | number;
type Row = Record<string, unknown> & { id: number; uuid: string; engine: DatabaseEngine };
interface Variable {
  id: number;
  databaseId: Id;
  engine: DatabaseEngine;
  uuid: string;
  key: string;
  value: string | null;
  is_shown_once: boolean;
  is_shared: boolean;
  version: string;
}

/** The schema's defaults of the columns the service reads at head (500_deploy_core, 520, 630, and the images Coolify raised on 2026-11-06 with 660). */
const SCHEMA_DEFAULTS: Record<DatabaseEngine, Record<string, unknown>> = {
  postgresql: { image: "postgres:18-alpine", postgres_user: "postgres", postgres_db: "postgres", postgres_initdb_args: null, postgres_host_auth_method: null, postgres_conf: null, init_scripts: null, enable_ssl: false, ssl_mode: "require" },
  redis: { image: "valkey/valkey:9-alpine", redis_conf: null, enable_ssl: false, ssl_mode: null, legacy_password_quoting: false },
  mongodb: { image: "mongo:9", mongo_conf: null, mongo_initdb_root_username: "root", mongo_initdb_database: "default", enable_ssl: false, ssl_mode: "require" },
  mysql: { image: "mysql:9.7", mysql_user: "mysql", mysql_database: "default", mysql_conf: null, enable_ssl: false, ssl_mode: "REQUIRED" },
  mariadb: { image: "mariadb:12.3", mariadb_user: "mariadb", mariadb_database: "default", mariadb_conf: null, enable_ssl: false, ssl_mode: null },
  keydb: { image: "eqalpha/keydb:latest", keydb_conf: null, enable_ssl: false, ssl_mode: null, legacy_password_quoting: false },
  dragonfly: { image: "docker.dragonflydb.io/dragonflydb/dragonfly", enable_ssl: false, ssl_mode: null, legacy_password_quoting: false },
  clickhouse: { image: "clickhouse/clickhouse-server:26.8", clickhouse_admin_user: "default", clickhouse_db: "default", enable_ssl: null, ssl_mode: null },
};

class MemoryStore implements DatabaseStore {
  next = 100;
  rows: Row[] = [];
  variables: Variable[] = [];
  volumes: Array<{ databaseId: Id; engine: DatabaseEngine; uuid: string; name: string; mountPath: string }> = [];
  certificates: Array<{ databaseId: Id; valid_until: string }> = [];
  inserts: Array<{ engine: DatabaseEngine; database: Omit<NewDatabase, "orgId"> }> = [];
  updates: Array<{ engine: DatabaseEngine; id: Id; changes: Record<string, DatabaseColumnValue> }> = [];
  variableWrites: Array<{ kind: "insert" | "update"; key: string; value: string | null; isShared: boolean }> = [];
  deleted: Array<{ engine: DatabaseEngine; id: Id }> = [];
  servers: Array<Record<string, unknown> & { id: number; uuid: string }> = [
    { id: 7, uuid: "srv1", name: "main", ip: "203.0.113.10", server_role: "both", is_build_server: false, is_reachable: false, is_usable: false, force_disabled: false, logdrain: false },
    { id: 9, uuid: "srv3", name: "builder", ip: "203.0.113.30", server_role: "build", is_build_server: true, is_reachable: true, is_usable: true, force_disabled: false, logdrain: false },
  ];
  destinations = [
    { id: 21, uuid: "dst1", name: "freeploy", network: "coolify", type: "standalone" as const, server_id: 7, server_uuid: "srv1" },
    { id: 22, uuid: "swm1", name: "overlay", network: "coolify-overlay", type: "swarm" as const, server_id: 7, server_uuid: "srv1" },
    { id: 24, uuid: "dst3", name: "build-net", network: "build", type: "standalone" as const, server_id: 9, server_uuid: "srv3" },
  ];

  async findProject(uuid: string) {
    return uuid === "prj1" ? ({ id: 1, uuid: "prj1", name: "Shop", description: null } as unknown as DeployProjectRow) : null;
  }
  async findEnvironment(projectId: Id, uuid: string) {
    return projectId === 1 && uuid === "env1" ? ({ id: 11, uuid: "env1", name: "production", project_id: 1 } as unknown as DeployEnvironmentListRow) : null;
  }
  async findDestination(uuid: string) {
    return (this.destinations.find((d) => d.uuid === uuid) as unknown as DeployDestinationRow | undefined) ?? null;
  }
  async findServer(uuid: string) {
    return (this.servers.find((s) => s.uuid === uuid) as unknown as DeployServerRow | undefined) ?? null;
  }
  /** The row as findDatabaseByUuid() joins it. */
  private joined(row: Row): DeployDatabaseRow {
    const destination = this.destinations.find((d) => d.id === row.destination_id);
    const server = this.servers.find((s) => s.id === destination?.server_id);
    return {
      ...row,
      environment_uuid: "env1",
      environment_name: "production",
      project_uuid: "prj1",
      project_name: "Shop",
      destination_uuid: destination?.uuid ?? null,
      destination_name: destination?.name ?? null,
      destination_network: destination?.network ?? null,
      server_id: server?.id ?? null,
      server_uuid: server?.uuid ?? null,
      server_name: server?.name ?? null,
      server_ip: server?.ip ?? null,
      server_is_swarm_manager: false,
      server_is_swarm_worker: false,
      server_is_reachable: server?.is_reachable ?? null,
      server_is_usable: server?.is_usable ?? null,
      server_force_disabled: server?.force_disabled ?? null,
      server_is_logdrain_newrelic_enabled: false,
      server_is_logdrain_axiom_enabled: server?.logdrain ?? false,
      server_is_logdrain_custom_enabled: false,
      server_is_logdrain_cloudwatch_enabled: false,
    } as unknown as DeployDatabaseRow;
  }
  async insert(engine: DatabaseEngine, database: Omit<NewDatabase, "orgId">) {
    this.inserts.push({ engine, database });
    const id = this.next++;
    const row: Row = {
      id,
      engine,
      uuid: database.uuid,
      name: database.name,
      description: null,
      status: "exited",
      is_public: false,
      public_port: null,
      public_port_timeout: 3600,
      ports_mappings: null,
      started_at: null,
      destination_id: database.destinationId,
      destination_type: database.destinationType === "swarm" ? "App\\Models\\SwarmDocker" : "App\\Models\\StandaloneDocker",
      environment_id: database.environmentId,
      is_log_drain_enabled: false,
      config_hash: null,
      custom_docker_run_options: null,
      ...SCHEMA_DEFAULTS[engine],
      ...database.values,
    };
    this.rows.push(row);
    for (const volume of database.volumes) this.volumes.push({ databaseId: id, engine, ...volume });
    return this.joined(row);
  }
  row(uuid: string): Row {
    return this.rows.find((r) => r.uuid === uuid)!;
  }
  async findByUuid(uuid: string) {
    const row = this.rows.find((r) => r.uuid === uuid);
    return row ? this.joined(row) : null;
  }
  async update(engine: DatabaseEngine, id: Id, changes: Record<string, DatabaseColumnValue>) {
    const row = this.rows.find((r) => r.id === id && r.engine === engine);
    if (!row) return null;
    this.updates.push({ engine, id, changes });
    Object.assign(row, changes);
    return this.joined(row);
  }
  async findVariable(engine: DatabaseEngine, id: Id, key: string) {
    return (this.variables.find((v) => v.engine === engine && v.databaseId === id && v.key === key) as unknown as DeployDatabaseVariableRow | undefined) ?? null;
  }
  async insertVariable(engine: DatabaseEngine, id: Id, variable: Omit<NewDatabaseVariable, "orgId">) {
    const row: Variable = { id: this.next++, databaseId: id, engine, uuid: variable.uuid, key: variable.key, value: variable.value, is_shown_once: false, is_shared: variable.isShared, version: variable.version };
    this.variables.push(row);
    this.variableWrites.push({ kind: "insert", key: variable.key, value: variable.value, isShared: variable.isShared });
    return row as unknown as DeployDatabaseVariableRow;
  }
  async updateVariableValue(engine: DatabaseEngine, id: Id, variableId: Id, value: string | null, isShared: boolean) {
    const row = this.variables.find((v) => v.engine === engine && v.databaseId === id && v.id === variableId);
    if (!row) return false;
    Object.assign(row, { value, is_shared: isShared });
    this.variableWrites.push({ kind: "update", key: row.key, value, isShared });
    return true;
  }
  async certificateValidUntil(_engine: DatabaseEngine, id: Id) {
    return this.certificates.find((c) => c.databaseId === id)?.valid_until ?? null;
  }
  async delete(engine: DatabaseEngine, id: Id) {
    this.deleted.push({ engine, id });
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !(r.id === id && r.engine === engine));
    return this.rows.length < before;
  }
}

interface Answer {
  status: number;
  data: Record<string, unknown>;
  error: { code: string; message: string; details: { fields?: Record<string, string[]> } };
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
  /** The random sources, in the order they are drawn: ids "id1", "id2", …; passwords "Password1x…", …. */
  const drawn: string[] = [];
  let ids = 0;
  let passwords = 0;
  const runner: DatabaseRunner = async (_env, orgId, fn) => {
    orgs.push(orgId);
    return fn({
      store,
      cipher: (column) => ({ encrypt: async (plaintext) => seal(column, plaintext), decrypt: async (stored) => open(column, stored) }),
      random: {
        publicId: () => {
          const id = `id${++ids}`;
          drawn.push(id);
          return id;
        },
        password: () => {
          const password = `Password${++passwords}`.padEnd(64, "x");
          drawn.push(`password${passwords}`);
          return password;
        },
      },
    });
  };
  /** path: what follows /databases, with its query. */
  const call = async (method: string, path = "", body?: unknown): Promise<Answer> => {
    const init: RequestInit = { method };
    if (body !== undefined && method !== "GET" && method !== "DELETE") init.body = JSON.stringify(body);
    const segments = path.split("?")[0]!.split("/").filter(Boolean);
    const res = await handleDatabases(env, "req_1", actor, ORG_UUID, segments, new Request(`${BASE}/databases${path ? `/${path}` : ""}`, init), runner);
    const parsed = (await res.json()) as { data?: Record<string, unknown>; error?: Answer["error"] };
    return { status: res.status, data: parsed.data ?? {}, error: parsed.error ?? { code: "", message: "", details: {} } };
  };
  const form = (type: string, over: Record<string, unknown> = {}) => ({ type, project_uuid: "prj1", environment_uuid: "env1", server_id: "srv1", destination: "dst1", ...over });
  /** A database through the API; its uuid. */
  const create = async (type: DatabaseEngine, over: Record<string, unknown> = {}): Promise<string> => {
    const image = type === "postgresql" ? { database_image: "postgres:18-alpine" } : type === "redis" ? { database_image: "valkey/valkey:9-alpine" } : {};
    const r = await call("POST", "", form(type, { ...image, ...over }));
    if (r.status !== 201) throw new Error(`create ${type}: ${r.status} ${r.error.message} ${JSON.stringify(r.error.details)}`);
    return r.data.uuid as string;
  };
  const database = async (uuid: string) => (await call("GET", uuid)).data.database as Record<string, unknown> & { fields: Record<string, string | null> };
  /** A refusal as [status, message or the messages by field]. */
  const refused = (r: Answer) => [r.status, r.error.details.fields ?? r.error.message];
  return { store, asked, orgs, drawn, env, runner, call, form, create, database, refused };
}

// ---------------------------------------------------------------- the engines, against Coolify's models
describe("the eight engines", () => {
  it("are Coolify's models: table, morph class, type(), encrypted casts, backups", () => {
    expect(Object.keys(goldens.types).sort()).toEqual([...DATABASE_ENGINES].sort());
    for (const engine of DATABASE_ENGINES) {
      const golden = goldens.types[engine]!;
      const table = DATABASE_TABLES[engine];
      const spec = DATABASE_ENGINE_SPECS[engine];
      expect([engine, table.table, table.morphClass]).toEqual([engine, golden.table, golden.morphClass]);
      expect([...table.encrypted].sort()).toEqual(golden.encrypted);
      // The same columns the catalogue of `encrypted` casts lists for the table.
      expect([...table.encrypted].sort()).toEqual([...(ENCRYPTED_COLUMNS[table.table] ?? [])].sort());
      expect([engine, spec.databaseType, spec.headline, spec.backups]).toEqual([engine, golden.type, golden.headline, golden.backups]);
      expect(spec.engine).toBe(engine);
      // Every column a field is stored in is one of the table's.
      for (const field of spec.fields) if (field.column !== null) expect(table.columns).toContain(field.column);
      for (const column of spec.generatedPasswords) expect(table.encrypted).toContain(column);
    }
  });

  it("are the database types of the New Resource page, all creatable but SQLite", () => {
    expect(DATABASES.filter((d) => d.creatable).map((d) => d.id).sort()).toEqual([...DATABASE_ENGINES].sort());
    expect(DATABASES.find((d) => d.id === "sqlite")!.creatable).toBe(false);
    for (const engine of DATABASE_ENGINES) {
      expect(CREATABLE_TYPE_IDS).toContain(engine);
      expect(DATABASE_TYPE_IDS).toContain(engine);
      expect(isDatabaseEngine(engine)).toBe(true);
    }
    expect(CREATABLE_TYPE_IDS).not.toContain("sqlite");
    for (const other of ["sqlite", "docker-image", "", "constructor", "toString", null, 5]) expect(isDatabaseEngine(other)).toBe(false);
    // Select::DATABASE_IMAGE_STEPS
    expect(DATABASE_ENGINES.filter((e) => DATABASE_ENGINE_SPECS[e].imageStep)).toEqual(["postgresql", "redis"]);
  });
});

// ---------------------------------------------------------------- create_standalone_*()
describe("create_standalone_*() — the rows a database starts as", () => {
  it.each(Object.keys(cases.created))("%s", async (id) => {
    const input = cases.created[id]!;
    const golden = goldens.created[id]!;
    expect(golden.ok).toBe(true);
    const t = setup();
    const r = await t.call("POST", "", t.form(input.type, input.database_image ? { database_image: input.database_image } : {}));
    expect(r.status).toBe(201);
    expect(r.data).toEqual({ uuid: "id1", projectUuid: "prj1", environmentUuid: "env1" });
    expect(t.store.inserts).toHaveLength(1);
    const { engine, database } = t.store.inserts[0]!;
    const table = DATABASE_TABLES[engine];
    expect(engine).toBe(input.type);

    // What the helper sets, column by column: the same columns as Coolify's INSERT, nothing more.
    const set: Record<string, unknown> = {
      uuid: database.uuid,
      name: database.name,
      environment_id: database.environmentId,
      destination_id: database.destinationId,
      destination_type: t.store.row("id1").destination_type,
      ...database.values,
    };
    expect(Object.keys(set).sort()).toEqual(Object.keys(golden.attributes).sort());
    for (const [column, expected] of Object.entries(golden.attributes)) {
      const value = set[column];
      if (column === "uuid") {
        // new_public_id(): the injected id here; its real shape is checked below.
        expect(value).toBe("id1");
      } else if (column === "name") {
        expect(value).toBe((expected as string).replace("{uuid}", "id1"));
      } else if (table.encrypted.includes(column)) {
        // Str::password(length: 64, symbols: false), stored encrypted for its own column.
        expect((expected as { encrypted: boolean }).encrypted).toBe(true);
        const plaintext = open(`${table.table}.${column}`, value as string);
        expect(plaintext).toMatch(/^Password\d+x+$/);
        expect(plaintext).toHaveLength((expected as Shape).length);
      } else if (column === "environment_id") {
        expect([column, value]).toEqual([column, 11]);
      } else if (column === "destination_id") {
        expect([column, value]).toEqual([column, 21]);
      } else {
        expect([column, value]).toEqual([column, expected]);
      }
    }

    // The created hook's volumes.
    expect(t.store.volumes.map((v) => ({ name: v.name, mount_path: v.mountPath, host_path: null, resource_type: table.morphClass }))).toEqual(
      golden.volumes.map((v) => ({ ...v, name: v.name.replace("{uuid}", "id1") })),
    );
    for (const volume of t.store.volumes) expect(volume.uuid).toMatch(/^id\d+$/);

    // Redis: REDIS_PASSWORD and REDIS_USERNAME, each encrypted as a variable's value.
    expect(t.store.variables.map((v) => v.key)).toEqual(golden.environmentVariables.map((v) => v.key));
    for (const [i, expected] of golden.environmentVariables.entries()) {
      const variable = t.store.variables[i]!;
      const plaintext = open("environment_variables.value", variable.value!);
      expect(expected.valueEncrypted).toBe(true);
      if (expected.key === "REDIS_PASSWORD") expect(plaintext).toHaveLength((expected.value as Shape).length);
      else expect(plaintext).toBe(expected.value);
      expect([variable.is_shared, expected.is_shared]).toEqual([false, "0"]);
      expect(expected.resourceable_type).toBe(table.morphClass);
      // The creating hook's version is Coolify's at the pinned commit.
      expect([variable.version, expected.versionIsCoolifys]).toEqual(["4.7.6", true]);
      expect(variable.uuid).toMatch(/^id\d+$/);
    }
    // Nothing is started.
    expect(t.store.row("id1").status).toBe("exited");
    expect(t.store.row("id1").started_at).toBeNull();
  });

  it("draws the id first, then the passwords in the helper's order, then the hooks' ids", async () => {
    const mysql = setup();
    await mysql.create("mysql");
    expect(mysql.drawn).toEqual(["id1", "password1", "password2", "id2"]);
    // create_standalone_mysql(): mysql_root_password, then mysql_password.
    expect(open("standalone_mysqls.mysql_root_password", mysql.store.row("id1").mysql_root_password as string)).toMatch(/^Password1x/);
    expect(open("standalone_mysqls.mysql_password", mysql.store.row("id1").mysql_password as string)).toMatch(/^Password2x/);
    const redis = setup();
    await redis.create("redis");
    expect(redis.drawn).toEqual(["id1", "password1", "id2", "id3", "id4"]);
    const mongodb = setup();
    await mongodb.create("mongodb");
    expect(mongodb.drawn).toEqual(["id1", "password1", "id2", "id3"]);
  });

  it("Str::password(length: 64, symbols: false) has Coolify's shape", () => {
    expect(Object.keys(goldens.password)).toHaveLength(5);
    for (const golden of Object.values(goldens.password)) expect(shape(strPassword(64))).toEqual(golden);
    expect(new Set(Array.from({ length: 20 }, () => strPassword(64))).size).toBe(20);
    // One letter and one digit first, the rest from both sets, then a shuffle: with a source that always draws 0…
    expect(strPassword(6, () => 0)).toBe("0aaaaa");
    // …and one that always draws the last index (the shuffle then leaves every character in place).
    expect(strPassword(6, (max) => max - 1)).toBe("Z99999");
    expect(strPassword(2, () => 0)).toHaveLength(2);
  });

  it("the created hooks' volumes: PostgreSQL's mount path follows the image's major version", () => {
    expect(defaultVolumes("postgresql", "u", "postgres:18-alpine")).toEqual([{ name: "postgres-data-u", mountPath: "/var/lib/postgresql" }]);
    expect(defaultVolumes("postgresql", "u", "postgres:17.5")).toEqual([{ name: "postgres-data-u", mountPath: "/var/lib/postgresql/data" }]);
    expect(defaultVolumes("postgresql", "u", "pgvector/pgvector:PG19")[0]!.mountPath).toBe("/var/lib/postgresql");
    expect(defaultVolumes("postgresql", "u", "postgres")[0]!.mountPath).toBe("/var/lib/postgresql/data");
    expect(defaultVolumes("postgresql", "u", null)[0]!.mountPath).toBe("/var/lib/postgresql/data");
    // The first ":<digits>" is read, also when it is a registry's port (as Coolify's pattern does).
    expect(defaultVolumes("postgresql", "u", "registry.example.com:5000/postgres:16")[0]!.mountPath).toBe("/var/lib/postgresql");
    expect(defaultVolumes("mongodb", "u", null).map((v) => v.mountPath)).toEqual(["/data/configdb", "/data/db"]);
    expect(isSupabaseImage("supabase/postgres:17")).toBe(true);
    expect(isSupabaseImage("ghcr.io/supabase/postgres@sha256:abc")).toBe(true);
    expect(isSupabaseImage("supabase/postgres")).toBe(true);
    expect(isSupabaseImage("mysupabase/postgres:17")).toBe(false);
    expect(isSupabaseImage("supabase/postgres-meta:1")).toBe(false);
    expect(isSupabaseImage(null)).toBe(false);
  });

  it("refuses what Create::mount() would not create", async () => {
    const t = setup();
    expect(t.refused(await t.call("POST", "", t.form("sqlite")))).toEqual([422, { type: ["The selected type is invalid."] }]);
    expect(t.refused(await t.call("POST", "", {}))).toEqual([
      422,
      { type: ["The selected type is invalid."], project_uuid: ["The project uuid field is required."], environment_uuid: ["The environment uuid field is required."] },
    ]);
    // PostgreSQL and Redis ask for an image first (Select's image step).
    for (const type of ["postgresql", "redis"]) {
      expect(t.refused(await t.call("POST", "", t.form(type)))).toEqual([422, { database_image: ["The database image field is required."] }]);
      expect(t.refused(await t.call("POST", "", t.form(type, { database_image: 5 })))).toEqual([422, { database_image: ["The database image field must be a string."] }]);
    }
    // The other engines take none: a given image is not read.
    const mysql = await t.create("mysql", { database_image: "mysql:5" });
    expect(t.store.row(mysql).image).toBe("mysql:9.7");
    // find_resource_destination_for_current_team(): one of the org's, on a server that hosts resources.
    expect(t.refused(await t.call("POST", "", t.form("mysql", { destination: "nope" })))).toEqual([404, "Destination not found."]);
    expect(t.refused(await t.call("POST", "", t.form("mysql", { destination: undefined })))).toEqual([404, "Destination not found."]);
    expect(t.refused(await t.call("POST", "", t.form("mysql", { destination: "dst3", server_id: "srv3" })))).toEqual([404, "Destination not found."]);
    expect(t.refused(await t.call("POST", "", t.form("mysql", { server_id: "srv3" })))).toEqual([404, "Destination not found."]);
    expect((await t.call("POST", "", t.form("mysql", { project_uuid: "other" }))).status).toBe(404);
    expect((await t.call("POST", "", t.form("mysql", { environment_uuid: "other" }))).status).toBe(404);
    expect(t.store.inserts).toHaveLength(1);
    // The API's own names for the query string's fields work as well.
    expect(validateCreateDatabase({ type: "mysql", project_uuid: "prj1", environment_uuid: "env1", server_uuid: "srv1", destination_uuid: "dst1" })).toEqual({
      ok: true,
      input: { engine: "mysql", projectUuid: "prj1", environmentUuid: "env1", serverUuid: "srv1", destinationUuid: "dst1", databaseImage: null },
    });
  });

  it("stores a Swarm destination's morph class, as $destination->getMorphClass()", async () => {
    const t = setup();
    const uuid = await t.create("keydb", { destination: "swm1" });
    expect(t.store.row(uuid).destination_type).toBe("App\\Models\\SwarmDocker");
    expect((await t.database(uuid)).destination).toEqual({ uuid: "swm1", name: "overlay", network: "coolify-overlay", type: "swarm" });
  });
});

// ---------------------------------------------------------------- the connection URLs
describe("internal_db_url and external_db_url", () => {
  it.each(Object.keys(cases.urls))("%s", (id) => {
    const input = cases.urls[id]!;
    const golden = goldens.urls[id]!;
    expect(golden.ok).toBe(true);
    const a = input.attributes;
    const variable = (key: string) => input.environmentVariables?.find((v) => v.key === key)?.value ?? null;
    const d = {
      engine: input.type,
      uuid: "dbuuid",
      image: (a.image as string | undefined) ?? null,
      isPublic: a.is_public === true,
      publicPort: (a.public_port as number | null | undefined) ?? null,
      enableSsl: a.enable_ssl === true,
      sslMode: (a.ssl_mode as string | undefined) ?? null,
      serverIp: input.serverIp ?? "203.0.113.10",
      values: a as Record<string, string | null>,
      usernameVariable: variable("REDIS_USERNAME"),
      passwordVariable: variable("REDIS_PASSWORD"),
      legacyPasswordQuoting: a.legacy_password_quoting === true,
    };
    expect(internalDbUrl(d)).toBe(golden.internal);
    expect(externalDbUrl(d)).toBe(golden.external);
  });

  it("rawurlencode(), formatHostForUrl() and sanitize_string()", () => {
    expect(rawUrlEncode("a b!*'()~-_.é/")).toBe("a%20b%21%2A%27%28%29~-_.%C3%A9%2F");
    expect(formatHostForUrl("203.0.113.10")).toBe("203.0.113.10");
    expect(formatHostForUrl("2A01:4F8:0:0:0:0:0:1")).toBe("[2a01:4f8::1]");
    expect(formatHostForUrl("example.com")).toBe("example.com");
    expect(sanitizeString(" redis:<b>8</b>\u0001 ")).toBe("redis:8");
    expect(sanitizeString(`a&"'b`)).toBe("a&amp;&quot;&apos;b");
    expect(sanitizeString(null)).toBeNull();
  });

  it("version_compare($redisVersion, '6.0', '>=') — PHP's own results", () => {
    // php -r 'var_export(version_compare($v, "6.0", ">="));' at PHP 8.3.6, for each version.
    const php: Record<string, boolean> = {
      "8": true, "9-alpine": true, "7.2": true, "0.0": false, "5000/redis": true, latest: false, "6": false, "6.0": true, "6.0.1": true,
      "5.9": false, "6.0-alpine": false, "6.0rc1": false, "7-alpine": true, alpine: false, "10": true, "06": false,
    };
    for (const [version, expected] of Object.entries(php)) expect([version, phpVersionCompare(version, "6.0") >= 0]).toEqual([version, expected]);
    expect(phpVersionCompare("1.0", "1.0")).toBe(0);
    expect(phpVersionCompare("1.0.0", "1.0")).toBe(1);
    expect(phpVersionCompare("1.0-dev", "1.0-alpha")).toBe(-1);
    expect(phpVersionCompare("1.0rc1", "1.0b2")).toBe(1);
    expect(phpVersionCompare("1.0pl1", "1.0")).toBe(1);
    expect(phpVersionCompare("", "1")).toBe(-1);
    expect(phpVersionCompare("1", "")).toBe(1);
    expect(phpVersionCompare("", "")).toBe(0);
    // getRedisVersion(): what follows the first colon — a registry's port included — or '0.0'.
    expect(redisVersion("redis:7.2-alpine")).toBe("7.2-alpine");
    expect(redisVersion("redis")).toBe("0.0");
    expect(redisVersion(null)).toBe("0.0");
    expect(redisVersion("registry.example.com:5000/redis:7")).toBe("5000/redis");
    expect(redisHasUsername("valkey/valkey:9-alpine")).toBe(true);
    expect(redisHasUsername("redis:5")).toBe(false);
    expect(redisUsername("  ")).toBe("default");
    expect(redisUsername(null)).toBe("default");
    expect(redisUsername("app")).toBe("app");
  });
});

// ---------------------------------------------------------------- General's rules and messages
describe("General::rules() and messages(), with Laravel's validator", () => {
  it("covers every engine", () => {
    expect(Object.keys(cases.validationBase).sort()).toEqual([...DATABASE_ENGINES].sort());
    expect(Object.keys(cases.validation).length).toBeGreaterThan(800);
    expect(Object.keys(goldens.validation)).toEqual(Object.keys(cases.validation));
  });

  it.each(Object.keys(cases.validation))("%s", (id) => {
    const raw = cases.validation[id]!;
    const golden = goldens.validation[id]!;
    expect(golden.ok).toBe(true);
    const base = cases.validationBase[raw.type]!;
    const spec = DATABASE_ENGINE_SPECS[raw.type];
    const stored = raw.stored ?? base.stored;
    const variables = raw.environmentVariables ?? base.environmentVariables;
    const input = { ...base.input, ...raw.input };
    const variable = (key: string) => variables.find((v) => v.key === key);
    // What each credential holds now: its column, or — for Redis — its variable.
    const credentials: Record<string, string | null> = {};
    for (const field of spec.fields) {
      if (field.kind === "text") continue;
      if (field.variable === "REDIS_USERNAME") credentials[field.property] = redisUsername(variable("REDIS_USERNAME")?.value);
      else if (field.variable === "REDIS_PASSWORD") credentials[field.property] = variable("REDIS_PASSWORD")?.value ?? null;
      else credentials[field.property] = stored[field.column!] ?? null;
    }
    const result = validateDatabaseGeneral(spec, input, { stored: credentials, credentialLocked: variable("REDIS_PASSWORD")?.is_shown_once === true });
    if (golden.typeErrors) {
      // A value the typed Livewire property cannot hold never reaches Coolify's validator: here it is refused on that field.
      expect(result.ok).toBe(false);
      if (!result.ok) for (const field of golden.typeErrors) expect(result.errors[field]?.length ?? 0).toBeGreaterThan(0);
      return;
    }
    expect(result.ok ? {} : result.errors).toEqual(golden.errors);
  });

  it("gives the model what syncData() stores", () => {
    const spec = DATABASE_ENGINE_SPECS.postgresql;
    const ok = (body: Record<string, unknown>) => {
      const r = validateDatabaseGeneral(spec, body, { stored: {} });
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      return r.input;
    };
    // "$this->publicPort ?: null": a blank or zero port is null; an integer in any spelling is the number.
    expect(ok({ publicPort: "5432" }).publicPort).toBe(5432);
    expect(ok({ publicPort: " 5432 " }).publicPort).toBe(5432);
    expect(ok({ publicPort: "" }).publicPort).toBeNull();
    expect(ok({ publicPort: null }).publicPort).toBeNull();
    expect(ok({ publicPort: true }).publicPort).toBe(1);
    expect(ok({ publicPortTimeout: "7200" }).publicPortTimeout).toBe(7200);
    expect(ok({ publicPortTimeout: "" }).publicPortTimeout).toBeNull();
    // A field the body leaves out is not part of the input.
    expect(ok({})).toEqual({ fields: {} });
    // PHP's coercion to a string property.
    expect(ok({ name: 123, postgresPassword: 5 })).toEqual({ name: "123", fields: { postgresPassword: "5" } });
    // PHP's coercion to ?bool.
    expect(ok({ isPublic: "0" }).isPublic).toBe(false);
    expect(ok({ isPublic: "yes" }).isPublic).toBe(true);
    expect(ok({ isPublic: null }).isPublic).toBeNull();
    const refused = validateDatabaseGeneral(spec, { publicPort: {}, isPublic: [] }, { stored: {} });
    expect(refused).toEqual({ ok: false, errors: { publicPort: ["The Public Port must be an integer."], isPublic: ["The is public field must be true or false."] } });
  });

  it("validateFilenameSafe(): a plain file name", () => {
    for (const name of ["init.sql", "01_create-db.sql", "a"]) expect(validateFilenameSafe(name, "init script filename")).toBe(name);
    const refusal = (name: string) => {
      try {
        validateFilenameSafe(name, "init script filename");
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(refusal("a;b.sql")).toBe("Invalid init script filename: contains forbidden character ';' (command separator). Shell metacharacters are not allowed for security reasons.");
    expect(refusal("dir/a.sql")).toBe("Invalid init script filename: directory separators ('/' or '\\') are not allowed. Provide a plain filename without path components.");
    expect(refusal("..sql")).toBe("Invalid init script filename: parent directory sequence ('..') is not allowed.");
    expect(refusal("my script.sql")).toBe("Invalid init script filename: contains forbidden character ' ' (whitespace).");
    expect(refusal("a*.sql")).toBe("Invalid init script filename: contains forbidden character '*' (glob wildcard).");
    expect(refusal("a[1].sql")).toBe("Invalid init script filename: contains forbidden character '[' (glob character class).");
    expect(refusal("~a.sql")).toBe("Invalid init script filename: contains forbidden character '~' (tilde expansion).");
    expect(refusal("a'.sql")).toBe("Invalid init script filename: contains forbidden character ''' (single quote).");
  });
});

// ---------------------------------------------------------------- the General page
describe("GET /databases/{uuid} — Configuration, General and StatusInfo", () => {
  it("a new PostgreSQL database as its General page reads it", async () => {
    const t = setup();
    const uuid = await t.create("postgresql");
    const r = await t.call("GET", uuid);
    expect(r.status).toBe(200);
    expect(r.data).toEqual({
      canUpdate: true,
      canManage: true,
      canDelete: true,
      database: {
        uuid: "id1",
        name: "postgresql-database-id1",
        description: null,
        engine: "postgresql",
        databaseType: "standalone-postgresql",
        // The status accessor.
        status: "exited:unhealthy",
        startedAt: null,
        image: "postgres:18-alpine",
        portsMappings: null,
        isPublic: false,
        publicPort: null,
        publicPortTimeout: 3600,
        isLogDrainEnabled: false,
        customDockerRunOptions: null,
        fields: { postgresUser: "postgres", postgresPassword: `${"Password1".padEnd(64, "x")}`, postgresDb: "postgres", postgresInitdbArgs: null, postgresHostAuthMethod: null, postgresConf: null },
        initScripts: [],
        redis: null,
        isPasswordHiddenForMember: false,
        urlLabel: "Postgres",
        dbUrl: `postgres://postgres:${"Password1".padEnd(64, "x")}@id1:5432/postgres`,
        dbUrlPublic: null,
        isCredentialLocked: false,
        showPublicUrlPlaceholder: false,
        ssl: {
          enabled: false,
          mode: "require",
          modes: [
            { value: "allow", label: "allow (insecure)" },
            { value: "prefer", label: "prefer (secure)" },
            { value: "require", label: "require (secure)" },
            { value: "verify-ca", label: "verify-ca (secure)" },
            { value: "verify-full", label: "verify-full (secure)" },
          ],
          modeHelper: "Choose the SSL verification mode for PostgreSQL connections",
          certificateValidUntil: null,
        },
        backups: true,
        // The server has not been validated: server_status is false.
        serverStatus: false,
        project: { uuid: "prj1", name: "Shop" },
        environment: { uuid: "env1", name: "production" },
        destination: { uuid: "dst1", name: "freeploy", network: "coolify", type: "standalone" },
        server: { uuid: "srv1", name: "main", ip: "203.0.113.10", isSwarm: false },
      },
    });
    expect(t.asked.sort()).toEqual(["deploy.resource.read", "deploy.resource.write", "deploy.resource.write"].sort());
    expect(t.orgs).toEqual([ORG_UUID, ORG_UUID]);
  });

  it("each engine's fields, URL label, SSL modes and backups", async () => {
    const t = setup();
    const seen: Record<string, unknown> = {};
    for (const engine of DATABASE_ENGINES) {
      const d = await t.database(await t.create(engine));
      const ssl = d.ssl as { mode: string | null; modes: Array<{ value: string }> | null } | null;
      seen[engine] = [Object.keys(d.fields), d.urlLabel, ssl ? (ssl.modes?.map((m) => m.value) ?? "no modes") : "no ssl", ssl?.mode ?? null, d.backups, d.showPublicUrlPlaceholder];
      expect([engine, d.databaseType, d.image]).toEqual([engine, `standalone-${engine}`, t.store.row(d.uuid as string).image]);
    }
    expect(seen).toEqual({
      postgresql: [["postgresUser", "postgresPassword", "postgresDb", "postgresInitdbArgs", "postgresHostAuthMethod", "postgresConf"], "Postgres", ["allow", "prefer", "require", "verify-ca", "verify-full"], "require", true, false],
      redis: [["redisConf", "redisUsername", "redisPassword"], "Redis / Valkey", "no modes", null, false, false],
      mongodb: [["mongoConf", "mongoInitdbRootUsername", "mongoInitdbRootPassword", "mongoInitdbDatabase"], "Mongo", ["allow", "prefer", "require", "verify-full"], "require", true, false],
      mysql: [["mysqlRootPassword", "mysqlUser", "mysqlPassword", "mysqlDatabase", "mysqlConf"], "MySQL", ["PREFERRED", "REQUIRED", "VERIFY_CA", "VERIFY_IDENTITY"], "REQUIRED", true, false],
      mariadb: [["mariadbRootPassword", "mariadbUser", "mariadbPassword", "mariadbDatabase", "mariadbConf"], "MariaDB", "no modes", null, true, false],
      keydb: [["keydbConf", "keydbPassword"], "KeyDB", "no modes", null, false, true],
      dragonfly: [["dragonflyPassword"], "Dragonfly", "no modes", null, false, true],
      clickhouse: [["clickhouseAdminUser", "clickhouseAdminPassword"], "Clickhouse", "no ssl", null, true, true],
    });
  });

  it("Redis reads its credentials from its variables", async () => {
    const t = setup();
    const uuid = await t.create("redis");
    const password = "Password1".padEnd(64, "x");
    const d = await t.database(uuid);
    expect(d.fields).toEqual({ redisConf: null, redisUsername: "default", redisPassword: password });
    expect(d.redis).toEqual({ version: "9-alpine", hasUsername: true, isPasswordLocked: false, isUsernameShared: false, isPasswordShared: false });
    expect(d.dbUrl).toBe(`redis://default:${password}@id1:6379/0`);
    // A locked password variable (shown once): neither the password nor a URL that contains it is read again.
    t.store.variables.find((v) => v.key === "REDIS_PASSWORD")!.is_shown_once = true;
    const locked = await t.database(uuid);
    expect([locked.fields.redisPassword, locked.dbUrl, locked.dbUrlPublic, locked.isCredentialLocked, (locked.redis as { isPasswordLocked: boolean }).isPasswordLocked]).toEqual([null, null, null, true, true]);
    // An image before Redis 6 has no users.
    t.store.row(uuid).image = "redis:5";
    expect(((await t.database(uuid)).redis as { hasUsername: boolean }).hasUsername).toBe(false);
  });

  it("who may not update reads no password, configuration, script or URL — as syncData() and StatusInfo leave them", async () => {
    const writer = setup();
    const uuid = await writer.create("postgresql");
    await writer.call("PATCH", uuid, { postgresConf: "max_connections = 50", customDockerRunOptions: "--cap-add SYS_ADMIN", postgresInitdbArgs: "--data-checksums" });
    await writer.call("POST", `${uuid}/init-scripts`, { new_filename: "init.sql", new_content: "CREATE ROLE app PASSWORD 'secret';" });
    const reader = setup({ write: false });
    reader.store.rows = writer.store.rows;
    const r = await reader.call("GET", uuid);
    expect(r.status).toBe(200);
    expect([r.data.canUpdate, r.data.canManage, r.data.canDelete]).toEqual([false, false, false]);
    const d = r.data.database as Record<string, unknown> & { fields: Record<string, string | null> };
    expect(d.fields).toEqual({ postgresUser: "postgres", postgresPassword: "", postgresDb: "postgres", postgresInitdbArgs: "--data-checksums", postgresHostAuthMethod: null, postgresConf: null });
    expect([d.customDockerRunOptions, d.initScripts, d.dbUrl, d.dbUrlPublic, d.isPasswordHiddenForMember, d.isCredentialLocked]).toEqual([null, null, null, null, true, false]);
    expect(JSON.stringify(r.data)).not.toMatch(/Password1|secret|max_connections|SYS_ADMIN/);
    // Every engine: no password, no configuration.
    for (const engine of DATABASE_ENGINES) {
      const w = setup();
      const id = await w.create(engine);
      const rd = setup({ write: false });
      rd.store.rows = w.store.rows;
      rd.store.variables = w.store.variables;
      const answer = await rd.call("GET", id);
      expect([engine, JSON.stringify(answer.data).includes("Password1")]).toEqual([engine, false]);
      const fields = (answer.data.database as { fields: Record<string, string | null> }).fields;
      for (const field of DATABASE_ENGINE_SPECS[engine].fields) {
        if (field.variable === "REDIS_PASSWORD") expect(fields[field.property]).toBeNull();
        else if (field.kind === "password") expect(fields[field.property]).toBe("");
        else if (field.sensitive) expect(fields[field.property]).toBeNull();
      }
    }
  });

  it("the status accessor", () => {
    expect(databaseStatus("exited")).toBe("exited:unhealthy");
    expect(databaseStatus("running (healthy)")).toBe("running:healthy");
    expect(databaseStatus("running:healthy")).toBe("running:healthy");
    expect(databaseStatus("restarting ( starting )")).toBe("restarting:starting");
    expect(databaseStatus("running(unhealthy")).toBe("running:unhealthy");
    expect(databaseStatus(null)).toBe(":unhealthy");
  });
});

describe("PATCH /databases/{uuid} — General::submit()", () => {
  it("stores what changed, through the model's mutators", async () => {
    const t = setup();
    const uuid = await t.create("postgresql");
    const r = await t.call("PATCH", uuid, {
      name: "Main database",
      description: "Orders, invoices",
      image: "postgres:17-alpine",
      portsMappings: " 3000:5432, 8080:80/udp ",
      publicPort: "15432",
      publicPortTimeout: "",
      customDockerRunOptions: "--cap-add SYS_ADMIN",
      postgresUser: "app_user",
      postgresPassword: "N3w-Pass.word!",
      postgresDb: "postgres",
      postgresInitdbArgs: "--data-checksums",
      postgresHostAuthMethod: "scram-sha-256",
      postgresConf: "max_connections = 50",
    });
    expect([r.status, r.data.message]).toEqual([200, "Database updated."]);
    expect(t.store.updates).toHaveLength(1);
    const { changes } = t.store.updates[0]!;
    expect(open("standalone_postgresqls.postgres_password", changes.postgres_password as string)).toBe("N3w-Pass.word!");
    expect({ ...changes, postgres_password: "(sealed)" }).toEqual({
      name: "Main database",
      description: "Orders, invoices",
      image: "postgres:17-alpine",
      // submit(): the spaces go.
      ports_mappings: "3000:5432,8080:80/udp",
      public_port: 15432,
      // "$this->publicPortTimeout ?: null"
      public_port_timeout: null,
      custom_docker_run_options: "--cap-add SYS_ADMIN",
      postgres_user: "app_user",
      postgres_password: "(sealed)",
      postgres_initdb_args: "--data-checksums",
      postgres_host_auth_method: "scram-sha-256",
      postgres_conf: "max_connections = 50",
    });
    const d = r.data.database as Record<string, unknown> & { fields: Record<string, string | null> };
    expect([d.name, d.fields.postgresPassword, d.dbUrl]).toEqual(["Main database", "N3w-Pass.word!", "postgres://app_user:N3w-Pass.word%21@id1:5432/postgres"]);
    // The same values again change nothing; neither do is_public and is_log_drain_enabled, which have their own actions.
    await t.call("PATCH", uuid, { name: "Main database", postgresPassword: "N3w-Pass.word!", isPublic: true, isLogDrainEnabled: true });
    expect(t.store.updates).toHaveLength(1);
    // The portsMappings mutator: '' is null.
    await t.call("PATCH", uuid, { portsMappings: "", description: null });
    expect(t.store.updates[1]!.changes).toEqual({ ports_mappings: null, description: null });
  });

  it("answers Laravel's messages by field and stores nothing", async () => {
    const t = setup();
    const uuid = await t.create("mysql");
    const r = await t.call("PATCH", uuid, { name: "", image: "", mysqlUser: "1bad", mysqlPassword: "bad pass", mysqlRootPassword: "", publicPort: "70000", portsMappings: "abc" });
    expect(t.refused(r)).toEqual([
      422,
      {
        name: ["The Name field is required."],
        image: ["The Docker Image field is required."],
        portsMappings: ["Port mappings must be a comma-separated list of port pairs or ranges with optional IP and protocol (e.g. 3000:3000, 8080:80/udp, 127.0.0.1:8080:80, [::1]::80)."],
        publicPort: ["The Public Port must not exceed 65535."],
        mysqlRootPassword: ["The Root Password field is required."],
        mysqlUser: ["The MySQL User may only contain letters, digits, and underscores, and must start with a letter or underscore."],
        mysqlPassword: ["The MySQL Password may not contain shell-unsafe characters (backtick, $, ;, |, &, <, >, \\, quotes, spaces, or control characters)."],
      },
    ]);
    expect(t.store.updates).toHaveLength(0);
    // A stored value the pattern would refuse stays accepted while it is not changed.
    t.store.row(uuid).mysql_user = "legacy-user";
    expect((await t.call("PATCH", uuid, { mysqlUser: "legacy-user", name: "renamed" })).status).toBe(200);
    expect(t.store.updates[0]!.changes).toEqual({ name: "renamed" });
    expect((await t.call("PATCH", uuid, { action: "nope" })).error.details.fields).toEqual({ action: ["The selected action is invalid."] });
  });

  it("KeyDB, Dragonfly and ClickHouse keep their credentials once started", async () => {
    for (const [engine, body, columns] of [
      ["keydb", { keydbPassword: "Changed1", keydbConf: "maxmemory 1gb" }, ["keydb_password"]],
      ["dragonfly", { dragonflyPassword: "Changed1" }, ["dragonfly_password"]],
      ["clickhouse", { clickhouseAdminUser: "admin", clickhouseAdminPassword: "Changed1" }, ["clickhouse_admin_user", "clickhouse_admin_password"]],
    ] as const) {
      const t = setup();
      const uuid = await t.create(engine);
      t.store.row(uuid).started_at = "2026-11-24 10:00:00";
      expect([engine, (await t.call("PATCH", uuid, body)).status]).toEqual([engine, 200]);
      const written = Object.keys(t.store.updates[0]?.changes ?? {});
      for (const column of columns) expect(written).not.toContain(column);
      // Before the first start they are stored.
      const fresh = setup();
      const other = await fresh.create(engine);
      await fresh.call("PATCH", other, body);
      for (const column of columns) expect(Object.keys(fresh.store.updates[0]!.changes)).toContain(column);
    }
    // PostgreSQL, MySQL, MariaDB and MongoDB store theirs also afterwards ("Keep credentials synchronized").
    const t = setup();
    const uuid = await t.create("mongodb");
    t.store.row(uuid).started_at = "2026-11-24 10:00:00";
    await t.call("PATCH", uuid, { mongoInitdbRootUsername: "admin", mongoConf: "" });
    // Mongodb\General::submit(): an empty configuration is null (it already is).
    expect(t.store.updates[0]!.changes).toEqual({ mongo_initdb_root_username: "admin" });
  });

  it("Redis: the username and the password are variables", async () => {
    const t = setup();
    const uuid = await t.create("redis");
    t.store.variableWrites.length = 0;
    const r = await t.call("PATCH", uuid, { redisUsername: "app", redisPassword: "N3w-Pass", redisConf: "maxmemory 256mb" });
    expect(r.status).toBe(200);
    expect(t.store.updates[0]!.changes).toEqual({ redis_conf: "maxmemory 256mb" });
    expect(t.store.variableWrites.map((w) => [w.kind, w.key, open("environment_variables.value", w.value!), w.isShared])).toEqual([
      ["update", "REDIS_USERNAME", "app", false],
      ["update", "REDIS_PASSWORD", "N3w-Pass", false],
    ]);
    expect(((r.data.database as { fields: Record<string, string> }).fields)).toEqual({ redisConf: "maxmemory 256mb", redisUsername: "app", redisPassword: "N3w-Pass" });
    expect((r.data.database as { dbUrl: string }).dbUrl).toBe("redis://app:N3w-Pass@id1:6379/0");
    // Unchanged values are not written again.
    t.store.variableWrites.length = 0;
    await t.call("PATCH", uuid, { redisUsername: "app", redisPassword: "N3w-Pass" });
    expect(t.store.variableWrites).toEqual([]);
    // updateOrCreate(): a missing variable is created.
    t.store.variables = t.store.variables.filter((v) => v.key !== "REDIS_USERNAME");
    await t.call("PATCH", uuid, { redisUsername: "other" });
    expect(t.store.variableWrites.map((w) => [w.kind, w.key])).toEqual([["insert", "REDIS_USERNAME"]]);
    // Before Redis 6 the server has no users: the username is not written.
    t.store.row(uuid).image = "redis:5";
    t.store.variableWrites.length = 0;
    await t.call("PATCH", uuid, { redisUsername: "third", redisPassword: "An0ther" });
    expect(t.store.variableWrites.map((w) => w.key)).toEqual(["REDIS_PASSWORD"]);
    // A locked password is neither validated nor overwritten.
    t.store.variables.find((v) => v.key === "REDIS_PASSWORD")!.is_shown_once = true;
    t.store.variableWrites.length = 0;
    expect((await t.call("PATCH", uuid, { redisPassword: "" })).status).toBe(200);
    expect(t.store.variableWrites).toEqual([]);
  });
});

describe("the Access listbox — General::instantSave()", () => {
  it("refuses in Coolify's order, and needs the server once the database runs", async () => {
    const t = setup();
    const uuid = await t.create("postgresql");
    const save = (body: Record<string, unknown>) => t.call("PATCH", uuid, { action: "instantSave", ...body });
    expect(t.refused(await save({ isPublic: true }))).toEqual([422, "Public port is required."]);
    expect(t.refused(await save({ isPublic: true, publicPort: "" }))).toEqual([422, "Public port is required."]);
    expect(t.refused(await save({ isPublic: true, publicPort: 15432 }))).toEqual([422, "Database must be started to be publicly accessible."]);
    expect(t.refused(await save({ isPublic: true, publicPort: 70000 }))).toEqual([422, { publicPort: ["The Public Port must not exceed 65535."] }]);
    expect(t.store.updates).toHaveLength(0);
    // "Private" on a database that never started: nothing of it is on a server; the form's ports are stored with it.
    const r = await save({ isPublic: false, publicPort: 15432, publicPortTimeout: 600 });
    expect([r.status, r.data.message]).toEqual([200, "Database is no longer publicly accessible."]);
    expect(t.store.updates[0]!.changes).toEqual({ public_port: 15432, public_port_timeout: 600 });
    // A running database: the TCP proxy container is started, or removed, on the server.
    Object.assign(t.store.row(uuid), { status: "running:healthy", started_at: "2026-11-24 10:00:00" });
    expect(t.refused(await save({ isPublic: true }))).toEqual([501, UNAVAILABLE("Starting the database's TCP proxy on the server")]);
    expect(t.refused(await save({ isPublic: false }))).toEqual([501, UNAVAILABLE("Stopping the database's TCP proxy on the server")]);
    // A public database that is stopped still has its proxy to remove.
    Object.assign(t.store.row(uuid), { status: "exited", started_at: null, is_public: true });
    expect(t.refused(await save({ isPublic: false }))).toEqual([501, UNAVAILABLE("Stopping the database's TCP proxy on the server")]);
    expect(t.store.updates).toHaveLength(1);
    expect(t.store.row(uuid).is_public).toBe(true);
  });
});

describe("the Log drain listbox — General::instantSaveAdvanced()", () => {
  it("needs a log drain on the server", async () => {
    const t = setup();
    const uuid = await t.create("mariadb");
    const save = (isLogDrainEnabled: unknown) => t.call("PATCH", uuid, { action: "instantSaveAdvanced", isLogDrainEnabled });
    expect(t.refused(await save(true))).toEqual([422, "Log drain is not enabled on the server. Please enable it first."]);
    expect(t.store.updates).toHaveLength(0);
    t.store.servers[0]!.logdrain = true;
    const r = await save(true);
    expect([r.status, r.data.message, r.data.messages]).toEqual([200, "Database updated.", ["Database updated.", "You need to restart the service for the changes to take effect."]]);
    expect(t.store.updates[0]!.changes).toEqual({ is_log_drain_enabled: true });
    expect((r.data.database as { isLogDrainEnabled: boolean }).isLogDrainEnabled).toBe(true);
    await save(false);
    expect(t.store.updates[1]!.changes).toEqual({ is_log_drain_enabled: false });
    expect(t.refused(await save([]))).toEqual([422, { isLogDrainEnabled: ["The is log drain enabled field must be true or false."] }]);
  });
});

describe("SSL — HasDatabaseStatusInfo", () => {
  it("instantSaveSSL() stores the switch and the engine's mode", async () => {
    const t = setup();
    const uuid = await t.create("postgresql");
    const save = (id: string, body: Record<string, unknown>) => t.call("PATCH", id, { action: "instantSaveSSL", ...body });
    const r = await save(uuid, { enableSsl: true, sslMode: "verify-full" });
    expect([r.status, r.data.message]).toEqual([200, "SSL configuration updated."]);
    expect(t.store.updates[0]!.changes).toEqual({ enable_ssl: true, ssl_mode: "verify-full" });
    const d = r.data.database as { ssl: { enabled: boolean; mode: string }; dbUrl: string };
    expect([d.ssl.enabled, d.ssl.mode]).toEqual([true, "verify-full"]);
    expect(d.dbUrl).toMatch(/\?sslmode=verify-full&sslrootcert=\/etc\/ssl\/certs\/coolify-ca\.crt$/);
    expect(t.refused(await save(uuid, { sslMode: "VERIFY_CA" }))).toEqual([422, { sslMode: ["The selected ssl mode is invalid."] }]);
    expect(t.refused(await save(uuid, { enableSsl: null }))).toEqual([422, { enableSsl: ["The enable ssl field must be true or false."] }]);
    // MySQL's and MongoDB's own modes.
    const mysql = await t.create("mysql");
    expect((await save(mysql, { enableSsl: true, sslMode: "VERIFY_IDENTITY" })).status).toBe(200);
    expect(t.refused(await save(mysql, { sslMode: "verify-full" }))).toEqual([422, { sslMode: ["The selected ssl mode is invalid."] }]);
    const mongodb = await t.create("mongodb");
    expect(t.refused(await save(mongodb, { sslMode: "verify-ca" }))).toEqual([422, { sslMode: ["The selected ssl mode is invalid."] }]);
    // An engine without modes stores the switch only.
    const keydb = await t.create("keydb");
    t.store.updates.length = 0;
    expect((await save(keydb, { enableSsl: true, sslMode: "verify-ca" })).status).toBe(200);
    expect(t.store.updates[0]!.changes).toEqual({ enable_ssl: true });
    expect(((await t.database(keydb)).dbUrl as string).startsWith("rediss://:")).toBe(true);
    // ClickHouse has no SSL configuration.
    const clickhouse = await t.create("clickhouse");
    expect(t.refused(await save(clickhouse, { enableSsl: true }))).toEqual([422, "This database has no SSL configuration."]);
    expect(t.refused(await t.call("POST", `${clickhouse}/ssl/regenerate`))).toEqual([422, "This database has no SSL configuration."]);
  });

  it("regenerateSslCertificate() has nothing to regenerate before a first start", async () => {
    const t = setup();
    const uuid = await t.create("postgresql");
    expect(t.refused(await t.call("POST", `${uuid}/ssl/regenerate`))).toEqual([422, "No existing SSL certificate found for this database."]);
    t.store.certificates.push({ databaseId: t.store.row(uuid).id, valid_until: "2027-11-24 10:00:00" });
    expect(((await t.database(uuid)).ssl as { certificateValidUntil: string }).certificateValidUntil).toBe("2027-11-24 10:00:00");
    // This harness gives the service no access to certificate rows (ctx.server); with it the certificate is
    // regenerated — database-operations-api.test.ts.
    expect(t.refused(await t.call("POST", `${uuid}/ssl/regenerate`))).toEqual([501, DATABASE_SERVICE_MESSAGES.certificateUnavailable]);
    expect((await t.call("POST", "nope/ssl/regenerate")).status).toBe(404);
    expect((await t.call("GET", `${uuid}/ssl/regenerate`)).status).toBe(405);
  });
});

describe("PostgreSQL's initialization scripts", () => {
  it("adds, edits, and needs the server to rename or delete", async () => {
    const t = setup();
    const uuid = await t.create("postgresql");
    const scripts = () => initScripts(t.store.row(uuid).init_scripts);
    const add = (new_filename: unknown, new_content: unknown) => t.call("POST", `${uuid}/init-scripts`, { new_filename, new_content });
    const first = await add("01_roles.sql", "CREATE ROLE app;");
    expect([first.status, first.data.message]).toEqual([201, "Init script added."]);
    await add("02_schema.sql", "CREATE SCHEMA shop;");
    expect(scripts()).toEqual([
      { index: 0, filename: "01_roles.sql", content: "CREATE ROLE app;" },
      { index: 1, filename: "02_schema.sql", content: "CREATE SCHEMA shop;" },
    ]);
    expect((first.data.database as { initScripts: unknown[] }).initScripts).toEqual([{ index: 0, filename: "01_roles.sql", content: "CREATE ROLE app;" }]);
    expect(t.refused(await add("01_roles.sql", "x"))).toEqual([422, "Filename already exists."]);
    expect(t.refused(await add("", ""))).toEqual([422, { new_filename: ["The new filename field is required."], new_content: ["The new content field is required."] }]);
    expect(t.refused(await add("../x.sql", "x"))).toEqual([422, "Invalid init script filename: directory separators ('/' or '\\') are not allowed. Provide a plain filename without path components."]);
    expect(t.refused(await add("a b.sql", "x"))).toEqual([422, "Invalid init script filename: contains forbidden character ' ' (whitespace)."]);

    const save = (body: Record<string, unknown>) => t.call("PATCH", `${uuid}/init-scripts`, body);
    // The content of an existing script: the index stays.
    const edited = await save({ originalFilename: "02_schema.sql", filename: "02_schema.sql", content: "CREATE SCHEMA store;" });
    expect([edited.status, edited.data.message]).toEqual([200, "Init script saved and updated."]);
    expect(scripts()[1]).toEqual({ index: 1, filename: "02_schema.sql", content: "CREATE SCHEMA store;" });
    // A new name that another script has.
    expect(t.refused(await save({ originalFilename: "02_schema.sql", filename: "01_roles.sql", content: "x" }))).toEqual([422, "A script with this filename already exists."]);
    // A rename removes the old file on the server first.
    expect(t.refused(await save({ originalFilename: "02_schema.sql", filename: "03_schema.sql", content: "x" }))).toEqual([501, UNAVAILABLE("Removing the renamed init script's file from the server")]);
    expect(t.refused(await save({ originalFilename: "02_schema.sql", filename: "bad name.sql", content: "x" }))).toEqual([422, "Invalid init script filename: contains forbidden character ' ' (whitespace)."]);
    expect(scripts().map((s) => s.filename)).toEqual(["01_roles.sql", "02_schema.sql"]);
    // A script that is not in the list is added.
    await save({ originalFilename: "gone.sql", filename: "04_new.sql", content: "SELECT 1;" });
    expect(scripts().map((s) => [s.index, s.filename])).toEqual([[0, "01_roles.sql"], [1, "02_schema.sql"], [2, "04_new.sql"]]);
    expect(t.refused(await save({ filename: 5 }))).toEqual([422, { filename: ["The filename field must be a string."], originalFilename: ["The original filename field is required."] }]);

    // Deleting removes the file on the server before the row changes.
    expect(t.refused(await t.call("DELETE", `${uuid}/init-scripts?filename=01_roles.sql`))).toEqual([501, UNAVAILABLE("Removing the init script's file from the server")]);
    expect((await t.call("DELETE", `${uuid}/init-scripts?filename=unknown.sql`)).status).toBe(404);
    expect(scripts()).toHaveLength(3);
    expect((await t.call("GET", `${uuid}/init-scripts`)).status).toBe(405);
  });

  it("belongs to PostgreSQL only", async () => {
    const t = setup();
    const uuid = await t.create("mysql");
    expect(t.refused(await t.call("POST", `${uuid}/init-scripts`, { new_filename: "a.sql", new_content: "x" }))).toEqual([404, "Only a PostgreSQL database has initialization scripts."]);
    expect((await t.database(uuid)).initScripts).toBeNull();
    expect(initScripts('[{"filename":"a.sql","content":"x"}]')).toEqual([{ index: 0, filename: "a.sql", content: "x" }]);
    expect(initScripts("not json")).toEqual([]);
    expect(initScripts(null)).toEqual([]);
  });
});

describe("Start, Restart, Stop and the Danger Zone", () => {
  it("answer 'not available yet' for what runs on the server", async () => {
    const t = setup();
    const uuid = await t.create("postgresql");
    for (const [action, what] of [["start", "Starting the database"], ["restart", "Restarting the database"], ["stop", "Stopping the database"]] as const) {
      const r = await t.call("POST", `${uuid}/${action}`);
      expect([r.status, r.error.code, r.error.message]).toEqual([501, "unsupported", UNAVAILABLE(what)]);
      expect((await t.call("POST", `nope/${action}`)).status).toBe(404);
      expect((await t.call("GET", `${uuid}/${action}`)).status).toBe(405);
    }
    expect(t.store.row(uuid).status).toBe("exited");
    // ClickHouse's "Keep current data" reads the container on the server.
    const clickhouse = await t.create("clickhouse");
    expect(t.refused(await t.call("POST", `${clickhouse}/keep-current-data-volume`))).toEqual([501, UNAVAILABLE("Reading the database container's data volume on the server")]);
    expect((await t.call("POST", `${uuid}/keep-current-data-volume`)).status).toBe(404);
  });

  it("deletes a database that was never started, with Coolify's query fields", async () => {
    const t = setup();
    const uuid = await t.create("redis");
    const id = t.store.row(uuid).id;
    const r = await t.call("DELETE", `${uuid}?delete_volumes=false&delete_backups=1`);
    expect(r.status).toBe(200);
    expect(r.data).toEqual({
      deleted: true,
      projectUuid: "prj1",
      environmentUuid: "env1",
      options: { delete_volumes: false, delete_connected_networks: true, delete_configurations: true, docker_cleanup: true, delete_backups: true },
    });
    expect(t.store.deleted).toEqual([{ engine: "redis", id }]);
    expect((await t.call("GET", uuid)).status).toBe(404);
    expect((await t.call("DELETE", uuid)).status).toBe(404);
  });

  it("keeps every row of a database that may have something on a server", async () => {
    for (const state of [{ status: "running:healthy" }, { status: "exited", started_at: "2026-11-24 10:00:00" }, { status: "restarting" }]) {
      const t = setup();
      const uuid = await t.create("postgresql");
      Object.assign(t.store.row(uuid), state);
      expect(t.refused(await t.call("DELETE", uuid))).toEqual([501, UNAVAILABLE("Stopping the database and removing its container, volumes and configuration files from the server")]);
      expect(t.store.deleted).toEqual([]);
      expect((await t.call("GET", uuid)).status).toBe(200);
    }
  });
});

describe("routing and authorization", () => {
  it("asks deploy.resource.write for every write, and answers 404 on a denial", async () => {
    const writer = setup();
    const uuid = await writer.create("postgresql");
    const t = setup({ write: false });
    t.store.rows = writer.store.rows;
    for (const [method, path, body] of [
      ["POST", "", t.form("mysql")],
      ["PATCH", uuid, { name: "renamed" }],
      ["PATCH", uuid, { action: "instantSave", isPublic: false }],
      ["DELETE", uuid, undefined],
      ["POST", `${uuid}/start`, {}],
      ["POST", `${uuid}/init-scripts`, { new_filename: "a.sql", new_content: "x" }],
      ["PATCH", `${uuid}/init-scripts`, {}],
      ["DELETE", `${uuid}/init-scripts?filename=a.sql`, undefined],
      ["POST", `${uuid}/ssl/regenerate`, {}],
      ["POST", `${uuid}/keep-current-data-volume`, {}],
    ] as const) {
      expect([method, path, (await t.call(method, path, body)).status]).toEqual([method, path, 404]);
    }
    expect(t.store.updates).toEqual([]);
    expect(t.store.inserts).toEqual([]);
    expect(t.store.deleted).toEqual([]);
    expect(t.orgs).toEqual([]);
    // A reader without deploy.resource.read sees nothing either.
    const stranger = setup({ read: false, write: false });
    stranger.store.rows = writer.store.rows;
    expect((await stranger.call("GET", uuid)).status).toBe(404);
  });

  it("knows its paths and methods", async () => {
    const t = setup();
    const uuid = await t.create("postgresql");
    expect((await t.call("GET", "")).status).toBe(405);
    expect((await t.call("PUT", uuid)).status).toBe(405);
    expect((await t.call("GET", "bad uuid")).status).toBe(404);
    expect((await t.call("GET", `${uuid}/nope`)).status).toBe(404);
    expect((await t.call("POST", `${uuid}/ssl`)).status).toBe(404);
    expect((await t.call("POST", `${uuid}/ssl/regenerate/more`)).status).toBe(404);
    expect((await t.call("GET", "unknown")).status).toBe(404);
  });

  it("is routed below /v1/organizations/{org}/deploy/databases", async () => {
    const env: Env = { ENVIRONMENT: "test" };
    // Without an actor: 401, before anything is read.
    const anonymous = await route(new Request(`${BASE}/databases`, { method: "POST" }), env);
    expect(anonymous.status).toBe(401);
    const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
    // With one, but no database binding in this environment: the handler is reached and says so.
    for (const path of ["databases", "databases/abc", "databases/abc/start", "databases/abc/ssl/regenerate"]) {
      const res = await route(new Request(`${BASE}/${path}`, { method: "POST", headers }), env);
      expect([path, res.status]).toEqual([path, path === "databases/abc" ? 405 : 503]);
    }
    expect((await route(new Request(`${BASE}/databases/abc/ssl/regenerate/x/y`, { method: "POST", headers }), env)).status).toBe(404);
    expect((await route(new Request("https://x/v1/organizations/not-an-org/deploy/databases", { method: "POST", headers }), env)).status).toBe(404);
  });
});

describe("the environment's resources", () => {
  it("lists its databases after its applications, engine by engine, as Resource\\Index does", async () => {
    const t = setup();
    for (const engine of ["mysql", "postgresql", "redis", "postgresql"] as const) await t.create(engine);
    // The ids drawn: mysql id1 (volume id2), postgresql id3 (id4), redis id5 (volume id6, variables id7 and id8), postgresql id9 (id10).
    t.store.row("id3").name = "analytics";
    Object.assign(t.store.row("id9"), { status: "running (healthy)", description: "Orders" });
    Object.assign(t.store.servers[0]!, { is_reachable: true, is_usable: true });
    const rows = await Promise.all(t.store.rows.map((r) => t.store.findByUuid(r.uuid)));
    const resources = databaseResources(rows as DeployDatabaseRow[]);
    expect(resources.map((r) => [r.name, r.databaseType])).toEqual([
      // postgresqls, sortBy('name')
      ["analytics", "standalone-postgresql"],
      ["postgresql-database-id9", "standalone-postgresql"],
      // redis, then mysqls
      ["redis-database-id5", "standalone-redis"],
      ["mysql-database-id1", "standalone-mysql"],
    ]);
    expect(resources[2]).toEqual({
      uuid: "id5",
      name: "redis-database-id5",
      type: "database",
      typeLabel: "Database",
      fqdn: null,
      description: null,
      status: "exited:unhealthy",
      restartLimitReached: false,
      restartCount: 0,
      maxRestartCount: 0,
      server_status: true,
      buildPack: "",
      databaseType: "standalone-redis",
      destination: { server: { name: "main" } },
      tags: [],
    });

    // Through the environment's resources page: the store of the applications handler lists them.
    const applications = {
      findProject: (uuid: string) => t.store.findProject(uuid),
      findEnvironment: (projectId: Id, uuid: string) => t.store.findEnvironment(projectId, uuid),
      listForEnvironment: async () => [],
      listDatabasesForEnvironment: async (environmentId: Id) => (environmentId === 11 ? (rows as DeployDatabaseRow[]) : []),
    } as unknown as ApplicationStore;
    const runner: ApplicationRunner = async (_env, _orgId, fn) => fn({ store: applications, encrypt: async () => "" });
    const res = await handleEnvironmentResources(t.env, "req_1", actor, ORG_UUID, { projectUuid: "prj1", environmentUuid: "env1", page: "resources" }, new Request(`${BASE}/projects/prj1/environments/env1/resources`), runner);
    const body = (await res.json()) as { data: { resources: Array<{ uuid: string; type: string; status: string }>; canCreate: boolean } };
    expect(res.status).toBe(200);
    expect(body.data.resources.map((r) => [r.uuid, r.type, r.status])).toEqual([
      ["id3", "database", "exited:unhealthy"],
      ["id9", "database", "running:healthy"],
      ["id5", "database", "exited:unhealthy"],
      ["id1", "database", "exited:unhealthy"],
    ]);
    expect(body.data.canCreate).toBe(true);
  });
});
