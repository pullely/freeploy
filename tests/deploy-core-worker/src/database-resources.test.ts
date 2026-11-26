// A standalone database's Environment Variables, Persistent Storage, Tags,
// Resource Operations, Resource Limits, Webhooks and Danger Zone pages
// (DP-64): Coolify's shared components with the database as their resource,
// through handleDatabaseResources (and handleDatabases, which dispatches to
// it). The services are the applications' (DP-51, DP-55, DP-52), whose own
// suites stay as they are; this suite holds what a database does — and does
// differently — end to end for PostgreSQL and Redis, and a table-driven pass
// over all eight engines. The SQL behind the stores is tested in tests/db.
import { route, ORG_DEPLOY_DATABASES_RE } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { handleDatabases } from "@deploy-core-worker/handlers/databases";
import { DATABASE_RESOURCE_PAGES, handleDatabaseResources, isDatabaseResourceRoute, type DatabaseResourcesRunner } from "@deploy-core-worker/handlers/database-resources";
import type { EnvironmentVariableRunner } from "@deploy-core-worker/handlers/environment-variables";
import type { EnvironmentVariableStore } from "@deploy-core-worker/environment-variables/service";
import type { ResourceRowsStore } from "@deploy-core-worker/applications/resources";
import type { DatabaseStore } from "@deploy-core-worker/databases/service";
import { cloneResourceName, clonedDatabaseVolumeName, type DatabaseHealthStore, type DatabaseResourcesStore } from "@deploy-core-worker/databases/resources";
import { DATABASE_ENGINE_SPECS, defaultVolumes } from "@deploy-core-worker/databases/engines";
import { DATABASE_ENGINES, DATABASE_TABLES, ENVIRONMENT_VARIABLE_MORPH_CLASS, databaseEnvironmentVariableResourceType, environmentVariableSettingColumns } from "@saas/db/deploy";
import type {
  DatabaseEngine,
  DatabaseLimitChanges,
  DatabaseReplica,
  DeployDatabaseLimitsRow,
  DeployDatabaseHealthRow,
  DeployDatabaseRow,
  DeployDestinationRow,
  DeployEnvironmentVariableResourceRow,
  DeployEnvironmentVariableRow,
  DeployFileVolumeRow,
  DeployPersistentVolumeRow,
  DeployServerRow,
  EnvironmentVariableChanges,
  EnvironmentVariableSettingChanges,
  FileVolumeChanges,
  NewEnvironmentVariable,
  PersistentVolumeChanges,
} from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const UNAVAILABLE = (what: string) => `${what} needs the SSH executor, which is not available yet.`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

type Id = string | number;
const same = (a: Id, b: Id) => String(a) === String(b);
const seal = (column: string, plaintext: string) => `fp1:1:${column}:${Buffer.from(plaintext).toString("base64")}`;
function open(column: string, stored: string): string {
  const prefix = `fp1:1:${column}:`;
  if (!stored.startsWith(prefix)) throw new Error(`${stored} is not sealed for ${column}`);
  return Buffer.from(stored.slice(prefix.length), "base64").toString();
}
const cipher = (column: string) => ({ encrypt: async (plaintext: string) => seal(column, plaintext), decrypt: async (stored: string) => open(column, stored) });

/** A database as create_standalone_<engine>() and the schema's defaults leave it, with where it lives. */
function databaseRow(engine: DatabaseEngine, id: number, uuid: string, over: Record<string, unknown> = {}): DeployDatabaseRow {
  const t = DATABASE_TABLES[engine];
  const own: Record<string, unknown> = {};
  for (const column of t.columns) own[column] = t.encrypted.includes(column) ? seal(`${t.table}.${column}`, `secret-${column}`) : null;
  return {
    engine, id, uuid, name: `${engine}-database-${uuid}`, description: null, status: "exited", image: engine === "postgresql" ? "postgres:18-alpine" : engine === "redis" ? "redis:7.2" : `${engine}:latest`,
    is_public: false, public_port: null, public_port_timeout: 3600, ports_mappings: null, started_at: null, destination_id: 21, destination_type: "App\\Models\\StandaloneDocker", environment_id: 11,
    is_log_drain_enabled: false, config_hash: null, custom_docker_run_options: null, last_online_at: null, created_at: null, updated_at: null,
    enable_ssl: t.enableSsl ? false : null, ssl_mode: t.sslMode ? "require" : null, legacy_password_quoting: t.legacyPasswordQuoting ? false : null,
    environment_uuid: "env1", environment_name: "production", project_uuid: "prj1", project_name: "Shop",
    destination_uuid: "dst1", destination_name: "freeploy", destination_network: "coolify", server_id: 7, server_uuid: "srv1", server_name: "main", server_ip: "203.0.113.10",
    server_is_swarm_manager: false, server_is_swarm_worker: false, server_is_reachable: true, server_is_usable: true, server_force_disabled: false,
    server_is_logdrain_newrelic_enabled: false, server_is_logdrain_axiom_enabled: false, server_is_logdrain_custom_enabled: false, server_is_logdrain_cloudwatch_enabled: false,
    ...own,
    ...over,
  } as DeployDatabaseRow;
}

type Owner = { type: string; id: Id };
interface Volume { id: number; owner: Owner; uuid: string; name: string; mount_path: string; host_path: string | null; is_preview_suffix_enabled: boolean; standalone_sqlite_id: null; has_backups: boolean }
interface Mount { id: number; owner: Owner; uuid: string; fs_path: string; mount_path: string; content: string | null; is_directory: boolean; is_host_file: boolean; is_based_on_git: boolean; is_preview_suffix_enabled: boolean; has_backups: boolean }
type Variable = DeployEnvironmentVariableRow & { owner: Owner };

/** One org's databases with what belongs to them (volumes, mounts, tags, variables, backups), in memory. */
class World implements DatabaseResourcesStore {
  next = 1000;
  databases: DeployDatabaseRow[] = [];
  limitRows = new Map<string, DeployDatabaseLimitsRow>();
  volumeRows: Volume[] = [];
  mountRows: Mount[] = [];
  tagRows: Array<{ id: number; uuid: string; name: string }> = [{ id: 1, uuid: "tag1", name: "prod" }];
  pivots: Array<{ tagId: Id; owner: Owner }> = [];
  variables: Variable[] = [];
  schedules: Array<{ id: number; uuid: string; databaseId: Id; databaseType: string; frequency: string; s3: Id[] }> = [];
  environmentSettings: EnvironmentVariableSettingChanges[] = [];
  environments = [
    { id: 11, uuid: "env1", name: "production", project_uuid: "prj1" },
    { id: 12, uuid: "env2", name: "staging", project_uuid: "prj1" },
  ];
  servers = [
    { id: 7, uuid: "srv1", name: "main", ip: "203.0.113.10", is_reachable: true, is_usable: true, force_disabled: false, is_build_server: false, server_role: "both" },
    { id: 9, uuid: "srv3", name: "builder", ip: "203.0.113.30", is_reachable: true, is_usable: true, force_disabled: false, is_build_server: true, server_role: "build" },
  ];
  destinations = [
    { id: 21, uuid: "dst1", name: "freeploy", network: "coolify", type: "standalone" as const, server_id: 7, server_uuid: "srv1" },
    { id: 23, uuid: "swm1", name: "overlay", network: "overlay", type: "swarm" as const, server_id: 7, server_uuid: "srv1" },
    { id: 24, uuid: "dst3", name: "build-net", network: "build", type: "standalone" as const, server_id: 9, server_uuid: "srv3" },
  ];
  replicas: Array<{ engine: DatabaseEngine; sourceId: Id; replica: DatabaseReplica }> = [];

  /** A database of the engine with the created hook's volumes, as DP-57 creates it. */
  add(engine: DatabaseEngine, uuid: string, over: Record<string, unknown> = {}): DeployDatabaseRow {
    const row = databaseRow(engine, this.next++, uuid, over);
    this.databases.push(row);
    this.limitRows.set(String(row.id), { limits_memory: "0", limits_memory_swap: "0", limits_memory_swappiness: 60, limits_memory_reservation: "0", limits_cpus: "0", limits_cpuset: null, limits_cpu_shares: 1024 });
    for (const v of defaultVolumes(engine, uuid, row.image)) this.addVolume(this.owner(row), v.name, v.mountPath);
    return row;
  }
  /** DP-97: the Healthcheck page's columns, the schema's defaults until written. */
  healthRows = new Map<string, DeployDatabaseHealthRow>();
  healthStore(): DatabaseHealthStore {
    const key = (engine: DatabaseEngine, id: Id) => `${engine}:${id}`;
    return {
      find: async (engine, id) => {
        if (!this.databases.some((d) => d.engine === engine && same(d.id, id))) return null;
        return { ...(this.healthRows.get(key(engine, id)) ?? { health_check_enabled: true, health_check_interval: 15, health_check_timeout: 5, health_check_retries: 5, health_check_start_period: 5 }) };
      },
      update: async (engine, id, changes) => {
        const current = (await this.healthStore().find(engine, id))!;
        this.healthRows.set(key(engine, id), { ...current, ...changes } as DeployDatabaseHealthRow);
        return true;
      },
    };
  }
  owner(row: DeployDatabaseRow): Owner {
    return { type: DATABASE_TABLES[row.engine].morphClass, id: row.id };
  }
  byUuid(uuid: string): DeployDatabaseRow {
    return this.databases.find((d) => d.uuid === uuid)!;
  }
  addVolume(owner: Owner, name: string, mountPath: string): Volume {
    const v: Volume = { id: this.next++, owner, uuid: `vol${this.next}`, name, mount_path: mountPath, host_path: null, is_preview_suffix_enabled: true, standalone_sqlite_id: null, has_backups: false };
    this.volumeRows.push(v);
    return v;
  }
  volumesOf(uuid: string): Volume[] {
    const owner = this.owner(this.byUuid(uuid));
    return this.volumeRows.filter((v) => v.owner.type === owner.type && same(v.owner.id, owner.id));
  }

  /** DP-57's store, as far as the shared pages read it. */
  databaseStore(): DatabaseStore {
    const unused = async (): Promise<never> => {
      throw new Error("not used by the shared pages");
    };
    return {
      findProject: unused, findEnvironment: unused, findDestination: unused, findServer: unused, insert: unused, update: unused, insertVariable: unused, updateVariableValue: unused, delete: unused,
      findByUuid: async (uuid) => this.databases.find((d) => d.uuid === uuid) ?? null,
      findVariable: async (engine, id, key) => {
        const v = this.variables.find((x) => x.owner.type === DATABASE_TABLES[engine].morphClass && same(x.owner.id, id) && x.key === key);
        return v ? { id: v.id, uuid: v.uuid, key: v.key, value: v.value, is_shown_once: v.is_shown_once, is_shared: v.is_shared } : null;
      },
      certificateValidUntil: async () => null,
    };
  }

  /** The rows of one morph class, as resourceRowsSqlStore() binds them. */
  rows(type: string): ResourceRowsStore {
    const own = (o: Owner, id: Id) => o.type === type && same(o.id, id);
    return {
      volumes: async (id) => this.volumeRows.filter((v) => own(v.owner, id)) as unknown as DeployPersistentVolumeRow[],
      findVolume: async (id, volumeId) => (this.volumeRows.find((v) => own(v.owner, id) && same(v.id, volumeId)) as unknown as DeployPersistentVolumeRow) ?? null,
      insertVolume: async (v) => this.addVolume({ type, id: v.resourceId }, v.name, v.mountPath) as unknown as DeployPersistentVolumeRow,
      updateVolume: async (id, volumeId, changes: PersistentVolumeChanges) => {
        const row = this.volumeRows.find((v) => own(v.owner, id) && same(v.id, volumeId));
        if (row) Object.assign(row, changes);
        return Boolean(row);
      },
      deleteVolume: async (id, volumeId) => {
        const before = this.volumeRows.length;
        this.volumeRows = this.volumeRows.filter((v) => !(own(v.owner, id) && same(v.id, volumeId)));
        return this.volumeRows.length < before;
      },
      files: async (id) => this.mountRows.filter((f) => own(f.owner, id)) as unknown as DeployFileVolumeRow[],
      findFile: async (id, fileId) => (this.mountRows.find((f) => own(f.owner, id) && same(f.id, fileId)) as unknown as DeployFileVolumeRow) ?? null,
      insertFile: async (f) => {
        const row: Mount = { id: this.next++, owner: { type, id: f.resourceId }, uuid: f.uuid, fs_path: f.fsPath, mount_path: f.mountPath, content: f.content, is_directory: f.isDirectory, is_host_file: f.isHostFile, is_based_on_git: false, is_preview_suffix_enabled: true, has_backups: false };
        this.mountRows.push(row);
        return row as unknown as DeployFileVolumeRow;
      },
      updateFile: async (id, fileId, changes: FileVolumeChanges) => {
        const row = this.mountRows.find((f) => own(f.owner, id) && same(f.id, fileId));
        if (row) Object.assign(row, changes);
        return Boolean(row);
      },
      deleteFile: async (id, fileId) => {
        const before = this.mountRows.length;
        this.mountRows = this.mountRows.filter((f) => !(own(f.owner, id) && same(f.id, fileId)));
        return this.mountRows.length < before;
      },
      tags: async () => [...this.tagRows].sort((a, b) => (a.name < b.name ? -1 : 1)),
      resourceTags: async (id) => this.tagRows.filter((t) => this.pivots.some((p) => same(p.tagId, t.id) && own(p.owner, id))),
      findTagByName: async (name) => this.tagRows.find((t) => t.name === name) ?? null,
      findTagById: async (id) => this.tagRows.find((t) => same(t.id, id)) ?? null,
      insertTag: async (tag) => {
        const row = { id: this.next++, ...tag };
        this.tagRows.push(row);
        return row;
      },
      hasTag: async (id, tagId) => this.pivots.some((p) => same(p.tagId, tagId) && own(p.owner, id)),
      attachTag: async (id, tagId) => {
        this.pivots.push({ tagId, owner: { type, id } });
      },
      detachTag: async (id, tagId) => {
        const before = this.pivots.length;
        this.pivots = this.pivots.filter((p) => !(same(p.tagId, tagId) && own(p.owner, id)));
        return this.pivots.length < before;
      },
      operationEnvironments: async () => this.environments.map((e) => ({ project_id: 1, project_uuid: e.project_uuid, project_name: "Shop", environment_id: e.id, environment_uuid: e.uuid, environment_name: e.name })),
      operationServers: async () => this.servers as never,
      operationDestinations: async () => this.destinations as never,
    };
  }

  // DatabaseResourcesStore
  async findEnvironment(uuid: string) {
    return this.environments.find((e) => e.uuid === uuid) ?? null;
  }
  async findDestination(uuid: string) {
    const d = this.destinations.find((x) => x.uuid === uuid);
    return d ? ({ ...d, server_name: "main", server_ip: "203.0.113.10" } as unknown as DeployDestinationRow) : null;
  }
  async findServer(uuid: string) {
    return (this.servers.find((s) => s.uuid === uuid) as unknown as DeployServerRow) ?? null;
  }
  async move(_engine: DatabaseEngine, id: Id, environmentId: Id) {
    const row = this.databases.find((d) => same(d.id, id));
    const environment = this.environments.find((e) => same(e.id, environmentId))!;
    if (!row) return false;
    Object.assign(row, { environment_id: environment.id, environment_uuid: environment.uuid, environment_name: environment.name });
    return true;
  }
  async replicate(engine: DatabaseEngine, sourceId: Id, replica: DatabaseReplica) {
    const source = this.databases.find((d) => same(d.id, sourceId));
    if (!source) return null;
    this.replicas.push({ engine, sourceId, replica });
    const environment = this.environments.find((e) => same(e.id, replica.environmentId))!;
    const id = this.next++;
    this.databases.push({ ...source, id, uuid: replica.uuid, name: replica.name, status: "exited", started_at: null, environment_id: environment.id, environment_uuid: environment.uuid, destination_id: replica.destinationId });
    this.limitRows.set(String(id), { ...this.limitRows.get(String(sourceId))! });
    return id;
  }
  async copyTags(engine: DatabaseEngine, sourceId: Id, cloneId: Id) {
    const type = DATABASE_TABLES[engine].morphClass;
    for (const p of this.pivots.filter((x) => x.owner.type === type && same(x.owner.id, sourceId))) this.pivots.push({ tagId: p.tagId, owner: { type, id: cloneId } });
  }
  async replicateVolume(volumeId: Id, replica: { uuid: string; name: string; resourceId: Id }) {
    const v = this.volumeRows.find((x) => same(x.id, volumeId))!;
    this.volumeRows.push({ ...v, id: this.next++, uuid: replica.uuid, name: replica.name, owner: { type: v.owner.type, id: replica.resourceId } });
  }
  async replicateFile(fileId: Id, replica: { uuid: string; resourceId: Id }) {
    const f = this.mountRows.find((x) => same(x.id, fileId))!;
    this.mountRows.push({ ...f, id: this.next++, uuid: replica.uuid, owner: { type: f.owner.type, id: replica.resourceId } });
  }
  async backupScheduleIds(engine: DatabaseEngine, id: Id) {
    return this.schedules.filter((s) => s.databaseType === DATABASE_TABLES[engine].morphClass && same(s.databaseId, id)).map((s) => s.id);
  }
  async replicateBackupSchedule(scheduleId: Id, replica: { uuid: string; engine: DatabaseEngine; databaseId: Id }) {
    const s = this.schedules.find((x) => same(x.id, scheduleId))!;
    this.schedules.push({ ...s, id: this.next++, uuid: replica.uuid, databaseId: replica.databaseId, databaseType: DATABASE_TABLES[replica.engine].morphClass, s3: [...s.s3] });
  }
  async environmentVariableIds(engine: DatabaseEngine, id: Id) {
    return this.variables.filter((v) => v.owner.type === DATABASE_TABLES[engine].morphClass && same(v.owner.id, id)).map((v) => v.id);
  }
  async replicateEnvironmentVariable(variableId: Id, replica: { uuid: string; engine: DatabaseEngine; databaseId: Id; version: string }) {
    const v = this.variables.find((x) => same(x.id, variableId))!;
    this.variables.push({ ...v, id: this.next++, uuid: replica.uuid, version: replica.version, owner: { type: DATABASE_TABLES[replica.engine].morphClass, id: replica.databaseId } });
  }
  async limits(_engine: DatabaseEngine, id: Id) {
    return this.limitRows.get(String(id)) ?? null;
  }
  async updateLimits(_engine: DatabaseEngine, id: Id, changes: DatabaseLimitChanges) {
    Object.assign(this.limitRows.get(String(id))!, changes);
    return true;
  }

  /** A variable of a database, as an earlier save left it. */
  seedVariable(uuid: string, key: string, value: string | null, over: Partial<Variable> = {}): Variable {
    const id = this.next++;
    const v: Variable = {
      id, uuid: `var${id}`, key, value: value === null ? null : seal("environment_variables.value", value), comment: null, order: null, is_preview: false, is_multiline: false, is_literal: false,
      is_runtime: true, is_buildtime: true, is_required: false, is_shown_once: false, is_shared: false, version: "4.7.5", created_at: null, updated_at: null,
      owner: this.owner(this.byUuid(uuid)), ...over,
    };
    this.variables.push(v);
    return v;
  }

  /** The Environment Variables page's store for one resource type, as handlers/environment-variables.ts binds it. */
  variableStore(type: string): EnvironmentVariableStore {
    const morph = ENVIRONMENT_VARIABLE_MORPH_CLASS[type as keyof typeof ENVIRONMENT_VARIABLE_MORPH_CLASS];
    const of = (resourceId: Id) => this.variables.filter((v) => v.owner.type === morph && same(v.owner.id, resourceId));
    return {
      findResource: async (uuid) => {
        const d = this.databases.find((x) => x.uuid === uuid && DATABASE_TABLES[x.engine].morphClass === morph);
        if (!d) return null;
        const settings = d as unknown as Record<string, unknown>;
        return {
          id: d.id, uuid: d.uuid, name: d.name, build_pack: null, git_repository: null, dockerfile: null, docker_compose: null, environment_id: 11, environment_uuid: "env1", project_id: 1, project_uuid: "prj1",
          server_id: 7, server_uuid: "srv1", is_env_sorting_enabled: null, use_build_secrets: null,
          include_coolify_default_variables: (settings.include_coolify_default_variables as boolean | undefined) ?? true, redact_all_env_values_in_logs: (settings.redact_all_env_values_in_logs as boolean | undefined) ?? true,
        } as DeployEnvironmentVariableResourceRow;
      },
      list: async (resourceId, isPreview) => of(resourceId).filter((v) => v.is_preview === isPreview).sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || Number(a.id) - Number(b.id)),
      findByUuid: async (resourceId, uuid) => of(resourceId).find((v) => v.uuid === uuid) ?? null,
      findByKey: async (resourceId, isPreview, key) => of(resourceId).filter((v) => v.is_preview === isPreview && v.key === key),
      maxOrder: async (resourceId) => Math.max(0, ...of(resourceId).filter((v) => !v.is_preview).map((v) => v.order ?? 0)),
      insert: async (resourceId, v: Omit<NewEnvironmentVariable, "orgId">) => {
        if (of(resourceId).some((x) => x.is_preview === v.isPreview && x.key === v.key)) return null;
        const row: Variable = {
          id: this.next++, uuid: v.uuid, key: v.key, value: v.value, comment: v.comment, order: v.order, is_preview: v.isPreview, is_multiline: v.isMultiline, is_literal: v.isLiteral,
          is_runtime: v.isRuntime, is_buildtime: v.isBuildtime, is_required: v.isRequired, is_shown_once: v.isShownOnce, is_shared: v.isShared, version: v.version, created_at: null, updated_at: null,
          owner: { type: morph, id: resourceId },
        };
        this.variables.push(row);
        return row;
      },
      update: async (id, changes: EnvironmentVariableChanges) => {
        const row = this.variables.find((v) => same(v.id, id));
        if (row) Object.assign(row, changes);
        return row ?? null;
      },
      delete: async (ids) => {
        const before = this.variables.length;
        this.variables = this.variables.filter((v) => !ids.some((id) => same(id, v.id)));
        return before - this.variables.length;
      },
      updateSettings: async (resourceId, changes) => {
        const d = this.databases.find((x) => same(x.id, resourceId));
        if (!d) return false;
        this.environmentSettings.push(changes);
        Object.assign(d, changes);
        return true;
      },
      sharedVariable: async () => null,
      sharedVariableKeys: async () => [],
    };
  }
}

interface Answer {
  status: number;
  data: Record<string, unknown>;
  error: { code: string; message: string; details: { fields?: Record<string, string[]>; description?: string; pendingRename?: Record<string, string> } };
}

function setup(opts: { write?: boolean; read?: boolean } = {}) {
  const world = new World();
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
  const types: string[] = [];
  const runner: DatabaseResourcesRunner = async (_env, orgId, uuid, fn) => {
    orgs.push(orgId);
    const found = world.databases.find((d) => d.uuid === uuid);
    return fn({
      database: { store: world.databaseStore(), cipher },
      rows: world.rows(found ? DATABASE_TABLES[found.engine].morphClass : ""),
      content: cipher("local_file_volumes.content"),
      store: world,
      health: world.healthStore(),
    });
  };
  const variablesRunner: EnvironmentVariableRunner = async (_env, orgId, type, fn) => {
    orgs.push(orgId);
    types.push(type);
    return fn({ resourceType: type, store: world.variableStore(type), cipher: cipher("environment_variables.value"), sharedCipher: cipher("shared_environment_variables.value") });
  };
  /** path: what follows /databases/, with its query. */
  const call = async (method: string, path: string, body?: unknown): Promise<Answer> => {
    const init: RequestInit = { method };
    if (body !== undefined && method !== "GET" && method !== "DELETE") init.body = JSON.stringify(body);
    const segments = path.split("?")[0]!.split("/").filter(Boolean);
    const res = await handleDatabaseResources(env, "req_1", actor, ORG_UUID, segments, new Request(`${BASE}/databases/${path}`, init), runner, variablesRunner);
    const parsed = (await res.json()) as { data?: Record<string, unknown>; error?: Answer["error"] };
    return { status: res.status, data: parsed.data ?? {}, error: parsed.error ?? { code: "", message: "", details: {} } };
  };
  const refused = (r: Answer) => [r.status, r.error.details.fields ?? r.error.message];
  return { world, asked, orgs, types, env, call, refused };
}

const frameOf = (r: Answer) => r.data.database as { uuid: string; engine: string; databaseType: string; project: { uuid: string } };

// ---------------------------------------------------------------- routing and authorization

describe("the routes", () => {
  it("handleDatabaseResources serves the shared pages below a database; the router takes four segments below /databases", () => {
    expect(DATABASE_RESOURCE_PAGES).toEqual(["environment-variables", "storages", "tags", "resource-operations", "resource-limits", "webhooks", "danger", "healthcheck"]);
    for (const page of DATABASE_RESOURCE_PAGES) expect(isDatabaseResourceRoute(["db1", page])).toBe(true);
    for (const segments of [[], ["db1"], ["db1", "start"], ["db1", "init-scripts"], ["db1", "ssl", "regenerate"], ["db1", "backups"], ["db1", "servers"], ["db1", "logs"]]) {
      expect(isDatabaseResourceRoute(segments)).toBe(false);
    }
    expect(`/v1/organizations/${ORG}/deploy/databases/db1/storages/volumes/5`).toMatch(ORG_DEPLOY_DATABASES_RE);
    expect(`/v1/organizations/${ORG}/deploy/databases/db1/environment-variables/var1/lock`).toMatch(ORG_DEPLOY_DATABASES_RE);
    expect(`/v1/organizations/${ORG}/deploy/databases/db1/a/b/c/d`).not.toMatch(ORG_DEPLOY_DATABASES_RE);
  });

  it("answers 404 for a path below a page that does not exist, and 405 for a method a route does not have", async () => {
    const t = setup();
    t.world.add("postgresql", "pg1");
    expect((await t.call("GET", "pg1/storages/volumes")).status).toBe(404);
    expect((await t.call("GET", "pg1/tags/abc")).status).toBe(404);
    expect((await t.call("GET", "pg1/resource-operations/clone")).status).toBe(405);
    expect((await t.call("DELETE", "pg1/tags")).status).toBe(405);
    expect((await t.call("PUT", "pg1/resource-limits", {})).status).toBe(405);
    expect((await t.call("POST", "pg1/webhooks", {})).status).toBe(405);
    expect((await t.call("GET", "pg1/danger/flush")).status).toBe(405);
    expect((await t.call("GET", "bad uuid/tags")).status).toBe(404);
    expect(t.asked).toEqual([]);
  });

  it("reads ask deploy.resource.read and carry the views' abilities; writes ask deploy.resource.write; a denial and another org's database are a 404", async () => {
    const t = setup();
    t.world.add("postgresql", "pg1");
    const r = await t.call("GET", "pg1/tags");
    expect(r.status).toBe(200);
    expect(t.asked).toEqual(["deploy.resource.read", "deploy.resource.write"]);
    expect({ canUpdate: r.data.canUpdate, canManage: r.data.canManage, canDelete: r.data.canDelete }).toEqual({ canUpdate: true, canManage: true, canDelete: true });
    expect((await t.call("GET", "nope/tags")).status).toBe(404);
    expect(t.orgs.every((o) => o === ORG_UUID)).toBe(true);

    const reader = setup({ write: false });
    reader.world.add("postgresql", "pg1");
    const read = await reader.call("GET", "pg1/storages");
    expect(read.status).toBe(200);
    expect(read.data.canUpdate).toBe(false);
    expect((await reader.call("POST", "pg1/tags", { newTags: "prod" })).status).toBe(404);
    expect((await reader.call("POST", "pg1/environment-variables", { key: "A", value: "1" })).status).toBe(404);
    expect(reader.world.pivots).toEqual([]);

    const denied = setup({ read: false, write: false });
    denied.world.add("redis", "rd1");
    for (const page of ["environment-variables", "storages", "tags", "resource-operations", "resource-limits", "webhooks", "danger"]) expect((await denied.call("GET", `rd1/${page}`)).status).toBe(404);
  });

  it("handleDatabases and route() send these routes here, behind the same checks", async () => {
    const t = setup({ read: false, write: false });
    const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
    const routes: Array<[string, string]> = [
      ["GET", "pg1/storages"], ["PATCH", "pg1/storages/volumes/1"], ["DELETE", "pg1/storages/files/1"], ["GET", "pg1/tags"], ["POST", "pg1/tags/1"],
      ["GET", "pg1/resource-operations"], ["POST", "pg1/resource-operations/clone"], ["PATCH", "pg1/resource-limits"], ["GET", "pg1/webhooks"], ["GET", "pg1/danger"], ["POST", "pg1/danger/flush"],
    ];
    for (const [method, path] of routes) {
      const viaHandler = await handleDatabases(t.env, "req_1", actor, ORG_UUID, path.split("/"), new Request(`${BASE}/databases/${path}`, { method }));
      expect([method, path, viaHandler.status]).toEqual([method, path, 404]);
      const viaRoute = await route(new Request(`${BASE}/databases/${path}`, { method, headers }), t.env);
      expect([method, path, viaRoute.status]).toEqual([method, path, 404]);
    }
    // Each was denied by policy-worker, not by the router.
    expect(t.asked.filter((a) => a === "deploy.resource.write").length).toBe(routes.length * 2);
    // Without bindings the handler answers 503: the routes exist, four segments deep too.
    const bare: Env = { ENVIRONMENT: "test" };
    expect((await route(new Request(`${BASE}/databases/pg1/storages/volumes/1`, { method: "PATCH", headers }), bare)).status).toBe(503);
    expect((await route(new Request(`${BASE}/databases/pg1/environment-variables/var1/lock`, { method: "POST", headers }), bare)).status).toBe(503);
    expect((await route(new Request(`${BASE}/databases/pg1/storages/volumes/1/more`, { headers }), bare)).status).toBe(404);
  });
});

// ---------------------------------------------------------------- Environment Variables

describe("Environment Variables of a database", () => {
  it("PostgreSQL: the page is keyed by the database's type, lists no preview variables, and has the two switches of a database", async () => {
    const t = setup();
    t.world.add("postgresql", "pg1");
    t.world.seedVariable("pg1", "LOG_LEVEL", "debug");
    const r = await t.call("GET", "pg1/environment-variables");
    expect(r.status).toBe(200);
    expect(t.types).toEqual(["standalone-postgresql"]);
    expect(r.data.resource).toEqual({ type: "standalone-postgresql", uuid: "pg1", name: "postgresql-database-pg1", buildPack: null });
    expect(r.data.showPreview).toBe(false);
    expect((r.data.variables as Array<{ key: string; scope: string }>).map((v) => [v.key, v.scope])).toEqual([["LOG_LEVEL", "production"]]);
    expect(r.data.settings).toEqual({ isEnvSortingEnabled: false, useBuildSecrets: false, includeCoolifyDefaultVariables: true, redactAllEnvValuesInLogs: true });
    expect(environmentVariableSettingColumns("standalone-postgresql")).toEqual(["include_coolify_default_variables", "redact_all_env_values_in_logs"]);
  });

  it("PostgreSQL: a new variable belongs to the database and gets no preview copy; the developer view has no preview text", async () => {
    const t = setup();
    const pg = t.world.add("postgresql", "pg1");
    const added = await t.call("POST", "pg1/environment-variables", { key: "POSTGRES_EXTRA", value: "on", is_preview: false });
    expect(added.status).toBe(201);
    expect(t.world.variables.map((v) => [v.key, v.is_preview, v.owner.type, v.owner.id])).toEqual([["POSTGRES_EXTRA", false, "App\\Models\\StandalonePostgresql", pg.id]]);
    const dev = await t.call("GET", "pg1/environment-variables/dev");
    expect(dev.status).toBe(200);
    expect(dev.data.showPreview).toBe(false);
    expect(dev.data.variablesPreview).toBeNull();
    const saved = await t.call("PUT", "pg1/environment-variables/dev", { variables: "POSTGRES_EXTRA=off\nNEW_ONE=1" });
    expect(saved.status).toBe(200);
    expect(t.world.variables.map((v) => [v.key, open("environment_variables.value", v.value!)])).toEqual([["POSTGRES_EXTRA", "off"], ["NEW_ONE", "1"]]);
  });

  it("PostgreSQL: the two switches are stored on the database's own row; the order and build secrets switches answer what Coolify shows", async () => {
    const t = setup();
    const pg = t.world.add("postgresql", "pg1");
    const r = await t.call("PATCH", "pg1/environment-variables/settings", { include_coolify_default_variables: false });
    expect(r.status).toBe(200);
    expect(r.data.message).toBe("Environment variable settings updated.");
    expect((pg as unknown as Record<string, unknown>).include_coolify_default_variables).toBe(false);
    const log = await t.call("PATCH", "pg1/environment-variables/settings", { redact_all_env_values_in_logs: false });
    expect(log.data.message).toBe("Log redaction setting updated.");
    for (const field of ["is_env_sorting_enabled", "use_build_secrets"]) {
      expect(t.refused(await t.call("PATCH", "pg1/environment-variables/settings", { [field]: true, include_coolify_default_variables: true }))).toEqual([422, 'Attempt to assign property "is_env_sorting_enabled" on null']);
    }
    expect(t.world.environmentSettings).toEqual([{ include_coolify_default_variables: false }, { redact_all_env_values_in_logs: false }]);
  });

  it("Redis: REDIS_PASSWORD and REDIS_USERNAME are the database's variables on the page, values hidden from the list", async () => {
    const t = setup();
    t.world.add("redis", "rd1");
    const password = t.world.seedVariable("rd1", "REDIS_PASSWORD", "s3cret");
    t.world.seedVariable("rd1", "REDIS_USERNAME", "default");
    const r = await t.call("GET", "rd1/environment-variables");
    expect(r.status).toBe(200);
    expect(t.types).toEqual(["standalone-redis"]);
    expect((r.data.resource as { type: string }).type).toBe("standalone-redis");
    expect((r.data.variables as Array<{ key: string; value?: unknown }>).map((v) => v.key)).toEqual(["REDIS_PASSWORD", "REDIS_USERNAME"]);
    expect(JSON.stringify(r.data.variables)).not.toContain("s3cret");
    const value = await t.call("GET", `rd1/environment-variables/${password.uuid}`);
    expect(value.data.value).toBe("s3cret");
    // Show::submit() refuses nothing for a Redis credential; the dialog disables its name.
    const updated = await t.call("PATCH", `rd1/environment-variables/${password.uuid}`, { value: "n3w" });
    expect(updated.status).toBe(200);
    expect(open("environment_variables.value", t.world.variables.find((v) => v.key === "REDIS_PASSWORD")!.value!)).toBe("n3w");
  });

  it("a database that is not the org's is a 404, and nothing else is asked", async () => {
    const t = setup();
    expect((await t.call("GET", "nope/environment-variables")).status).toBe(404);
    expect(t.types).toEqual([]);
    expect(t.asked).toEqual([]);
  });
});

// ---------------------------------------------------------------- Persistent Storage

describe("Persistent Storage of a database", () => {
  it("PostgreSQL: the database's frame, its directory, no preview controls; its data volume is listed and editable", async () => {
    const t = setup();
    t.world.add("postgresql", "pg1");
    const r = await t.call("GET", "pg1/storages");
    expect(r.status).toBe(200);
    expect(frameOf(r).uuid).toBe("pg1");
    expect(r.data.application).toBeUndefined();
    expect({ isSwarm: r.data.isSwarm, gitBased: r.data.gitBased, hostPath: r.data.hostPath, defaultVolumeName: r.data.defaultVolumeName, volumeUnavailableReason: r.data.volumeUnavailableReason }).toEqual({
      isSwarm: false,
      gitBased: false,
      hostPath: "/data/coolify/databases/pg1",
      defaultVolumeName: "postgresql-database-pg1-data",
      volumeUnavailableReason: null,
    });
    expect((r.data.volumes as Array<{ name: string; mountPath: string; isReadOnly: boolean }>).map((v) => [v.name, v.mountPath, v.isReadOnly])).toEqual([["postgres-data-pg1", "/var/lib/postgresql", false]]);
  });

  it("PostgreSQL: a volume is added under the database's uuid, renamed after confirmation and deleted; a file mount is a row and its write is not available yet", async () => {
    const t = setup();
    t.world.add("postgresql", "pg1");
    const added = await t.call("POST", "pg1/storages", { type: "volume", name: "backup", mount_path: "backup" });
    expect([added.status, added.data.message]).toEqual([201, "Volume added successfully"]);
    const volume = t.world.volumesOf("pg1").find((v) => v.name === "pg1-backup")!;
    expect(volume.mount_path).toBe("/backup");
    const pending = await t.call("PATCH", `pg1/storages/volumes/${volume.id}`, { name: "pg1-archive" });
    expect([pending.status, pending.error.details.pendingRename]).toEqual([409, { storageId: String(volume.id), from: "pg1-backup", to: "pg1-archive" }]);
    expect((await t.call("PATCH", `pg1/storages/volumes/${volume.id}`, { name: "pg1-archive", renameConfirmed: true })).status).toBe(200);
    expect(volume.name).toBe("pg1-archive");
    // The default data volume is a volume like any other: Coolify lets it go.
    const data = t.world.volumesOf("pg1").find((v) => v.name === "postgres-data-pg1")!;
    expect((await t.call("DELETE", `pg1/storages/volumes/${data.id}`)).status).toBe(200);
    expect(t.refused(await t.call("DELETE", `pg1/storages/volumes/${volume.id}?deleteDockerVolume=true`))).toEqual([501, UNAVAILABLE("Deleting the Docker volume on the server")]);

    const file = await t.call("POST", "pg1/storages", { type: "file", file_storage_path: "/etc/postgresql/extra.conf", file_storage_content: "max_connections = 50" });
    expect([file.status, file.data.message, file.data.unavailable]).toEqual([201, "File mount added successfully", UNAVAILABLE("Writing the file to the server")]);
    expect(t.world.mountRows.map((m) => [m.fs_path, m.mount_path, open("local_file_volumes.content", m.content!)])).toEqual([
      ["/data/coolify/databases/pg1/etc/postgresql/extra.conf", "/etc/postgresql/extra.conf", "max_connections = 50"],
    ]);
    // A directory inside the database's directory is checked on the server first.
    expect(t.refused(await t.call("POST", "pg1/storages", { type: "directory", file_storage_directory_source: "./certs", file_storage_directory_destination: "/certs" }))).toEqual([501, UNAVAILABLE("Checking the path on the server")]);
    const elsewhere = await t.call("POST", "pg1/storages", { type: "directory", file_storage_directory_source: "/srv/certs", file_storage_directory_destination: "/certs" });
    expect([elsewhere.status, elsewhere.data.message]).toEqual([201, "Directory mount added successfully"]);
  });

  it("Redis: the same page over its own data volume, and Coolify's rules", async () => {
    const t = setup();
    t.world.add("redis", "rd1");
    const r = await t.call("GET", "rd1/storages");
    expect((r.data.volumes as Array<{ name: string; mountPath: string }>).map((v) => [v.name, v.mountPath])).toEqual([["redis-data-rd1", "/data"]]);
    expect(t.refused(await t.call("POST", "rd1/storages", { type: "volume", name: "-bad", mount_path: "/x" }))).toEqual([
      422,
      { name: ["The volume name must start with an alphanumeric character and contain only alphanumeric characters, dots, hyphens, and underscores."] },
    ]);
    expect((await t.call("POST", "rd1/storages", { type: "volume", name: "extra", mount_path: "/x" })).status).toBe(201);
    expect(t.refused(await t.call("POST", "rd1/storages", { type: "volume", name: "extra", mount_path: "/y" }))).toEqual([422, "Duplicate entry found. Please use a different name."]);
    const reader = setup({ write: false });
    reader.world.add("redis", "rd1");
    expect(((await reader.call("GET", "rd1/storages")).data.volumes as Array<{ isReadOnly: boolean }>)[0]!.isReadOnly).toBe(true);
  });

  it("another database's rows are not this one's", async () => {
    const t = setup();
    t.world.add("postgresql", "pg1");
    const other = t.world.add("redis", "rd1");
    const theirs = t.world.volumesOf("rd1")[0]!;
    expect((await t.call("PATCH", `pg1/storages/volumes/${theirs.id}`, { name: "x" })).status).toBe(404);
    expect((await t.call("DELETE", `pg1/storages/volumes/${theirs.id}`)).status).toBe(404);
    expect(t.world.volumesOf("rd1").map((v) => v.name)).toEqual([`redis-data-${other.uuid}`]);
  });
});

// ---------------------------------------------------------------- Tags

describe("Tags of a database", () => {
  it.each(["postgresql", "redis"] as const)("%s: adds, attaches and removes the org's tags", async (engine) => {
    const t = setup();
    const row = t.world.add(engine, "db1");
    const page = await t.call("GET", "db1/tags");
    expect([frameOf(page).engine, page.data.tags, page.data.availableTags]).toEqual([engine, [], [{ id: "1", name: "prod" }]]);
    const added = await t.call("POST", "db1/tags", { newTags: "Cache x prod" });
    expect(added.data.tags).toEqual([{ id: "1", name: "prod" }, expect.objectContaining({ name: "cache" })]);
    expect(added.data.errors).toEqual([{ title: "Invalid tag.", description: "Tag x is invalid. Min length is 2." }]);
    expect(t.world.pivots.every((p) => p.owner.type === DATABASE_TABLES[engine].morphClass && same(p.owner.id, row.id))).toBe(true);
    expect((await t.call("DELETE", "db1/tags/1")).data.message).toBe("Tag removed.");
    expect(t.refused(await t.call("POST", "db1/tags", { newTags: "" }))).toEqual([422, { newTags: ["The new tags field is required."] }]);
  });
});

// ---------------------------------------------------------------- Resource Operations

describe("Resource Operations of a database", () => {
  it("lists where it can go, for who may update", async () => {
    const t = setup();
    t.world.add("postgresql", "pg1");
    const r = await t.call("GET", "pg1/resource-operations");
    expect(frameOf(r).uuid).toBe("pg1");
    expect((r.data.servers as Array<{ uuid: string; destinations: unknown[] }>).map((s) => [s.uuid, s.destinations.length])).toEqual([["srv1", 2]]);
    expect(r.data.buildServers).toEqual([{ uuid: "srv3", name: "builder" }]);
    const reader = setup({ write: false });
    reader.world.add("postgresql", "pg1");
    expect((await reader.call("GET", "pg1/resource-operations")).data.servers).toEqual([]);
  });

  it("moves it to another environment of the org", async () => {
    const t = setup();
    t.world.add("redis", "rd1");
    const r = await t.call("POST", "rd1/resource-operations/move", { environment_uuid: "env2" });
    expect(r.data).toEqual({ projectUuid: "prj1", environmentUuid: "env2", databaseUuid: "rd1" });
    expect(t.world.byUuid("rd1").environment_uuid).toBe("env2");
    expect(t.refused(await t.call("POST", "rd1/resource-operations/move", { environment_uuid: "nope" }))).toEqual([422, { environment_id: ["Environment not found."] }]);
  });

  it("PostgreSQL: clones the row, its tags, volumes under the clone's names, mounts, backup schedules and variables", async () => {
    const t = setup();
    const pg = t.world.add("postgresql", "pg1", { name: "orders-clone-abcdefg1" });
    const owner = t.world.owner(pg);
    t.world.addVolume(owner, "pg1-extra", "/extra");
    t.world.addVolume(owner, "scratch", "/scratch");
    t.world.pivots.push({ tagId: 1, owner });
    t.world.mountRows.push({ id: 900, owner, uuid: "m1", fs_path: "/data/coolify/databases/pg1/init.sql", mount_path: "/docker-entrypoint-initdb.d/init.sql", content: null, is_directory: false, is_host_file: false, is_based_on_git: false, is_preview_suffix_enabled: true, has_backups: false });
    t.world.schedules.push({ id: 950, uuid: "bk1", databaseId: pg.id, databaseType: owner.type, frequency: "0 0 * * *", s3: [3] });
    t.world.seedVariable("pg1", "EXTRA", "1");
    const r = await t.call("POST", "pg1/resource-operations/clone", { destination_uuid: "dst1", environment_uuid: "env2", cloneVolumeData: true });
    expect(r.status).toBe(201);
    const clone = r.data.databaseUuid as string;
    expect(r.data).toEqual({ projectUuid: "prj1", environmentUuid: "env2", databaseUuid: clone, unavailable: UNAVAILABLE("Copying the volume data to the clone") });
    const row = t.world.byUuid(clone);
    expect([row.name, row.status, row.started_at, row.environment_uuid, row.engine]).toEqual([`orders-clone-${clone}`, "exited", null, "env2", "postgresql"]);
    // The passwords are the source's, as stored: Coolify generates none.
    expect(row.postgres_password).toBe(pg.postgres_password);
    expect(t.world.volumesOf(clone).map((v) => v.name)).toEqual([`postgres-data-${clone}`, `${clone}-extra`, `${clone}-scratch`]);
    expect(t.world.pivots.filter((p) => same(p.owner.id, row.id)).map((p) => p.tagId)).toEqual([1]);
    expect(t.world.mountRows.filter((m) => same(m.owner.id, row.id)).map((m) => [m.fs_path, m.uuid === "m1"])).toEqual([["/data/coolify/databases/pg1/init.sql", false]]);
    expect(t.world.schedules.filter((s) => same(s.databaseId, row.id)).map((s) => [s.frequency, s.databaseType, s.s3, s.uuid === "bk1"])).toEqual([["0 0 * * *", owner.type, [3], false]]);
    expect(t.world.variables.filter((v) => same(v.owner.id, row.id)).map((v) => [v.key, v.version, v.value === t.world.variables[0]!.value])).toEqual([["EXTRA", "4.7.6", true]]);
  });

  it("Redis: its credentials are copied with the clone; a mount inside the clone's directory is not written yet", async () => {
    const t = setup();
    t.world.add("redis", "rd1");
    t.world.seedVariable("rd1", "REDIS_PASSWORD", "pw");
    t.world.seedVariable("rd1", "REDIS_USERNAME", "default");
    const owner = t.world.owner(t.world.byUuid("rd1"));
    t.world.mountRows.push({ id: 901, owner, uuid: "m2", fs_path: "/data/coolify/databases/rd1/redis.conf", mount_path: "/usr/local/etc/redis/redis.conf", content: null, is_directory: false, is_host_file: false, is_based_on_git: false, is_preview_suffix_enabled: true, has_backups: false });
    const r = await t.call("POST", "rd1/resource-operations/clone", { destination_uuid: "swm1" });
    expect(r.status).toBe(201);
    const clone = t.world.byUuid(r.data.databaseUuid as string);
    expect(t.world.variables.filter((v) => same(v.owner.id, clone.id)).map((v) => [v.key, open("environment_variables.value", v.value!)])).toEqual([["REDIS_PASSWORD", "pw"], ["REDIS_USERNAME", "default"]]);
    expect(r.data.unavailable).toBeUndefined();
    expect(t.world.volumesOf(clone.uuid).map((v) => v.name)).toEqual([`redis-data-${clone.uuid}`]);
  });

  it("refuses a destination that is not the org's or on a build server, and an unknown environment", async () => {
    const t = setup();
    t.world.add("postgresql", "pg1");
    for (const destination of ["nope", "dst3", undefined]) {
      expect(t.refused(await t.call("POST", "pg1/resource-operations/clone", { destination_uuid: destination }))).toEqual([422, { destination_id: ["Destination not found."] }]);
    }
    expect(t.refused(await t.call("POST", "pg1/resource-operations/clone", { destination_uuid: "dst1", environment_uuid: "nope" }))).toEqual([422, { environment_id: ["Environment not found."] }]);
    expect(t.world.databases).toHaveLength(1);
  });

  it("clone_resource_name() and the volume names cloneTo() gives", () => {
    expect(cloneResourceName("orders", "abc1234")).toBe("orders-clone-abc1234");
    expect(cloneResourceName("orders-clone-zzz9999-clone-yyy8888", "abc1234")).toBe("orders-clone-abc1234");
    expect(cloneResourceName("orders-clone-short", "abc1234")).toBe("orders-clone-short-clone-abc1234");
    expect(cloneResourceName("x".repeat(300), "abc1234")).toBe(`${"x".repeat(255 - "-clone-abc1234".length)}-clone-abc1234`);
    expect(clonedDatabaseVolumeName("postgres-data-src", "src", "new")).toBe("postgres-data-new");
    expect(clonedDatabaseVolumeName("mongodb-db-src", "src", "new")).toBe("new-mongodb-db-src");
    expect(clonedDatabaseVolumeName("mongodb-configdb-src", "src", "new")).toBe("new-mongodb-configdb-src");
    expect(clonedDatabaseVolumeName("src-cache-src", "src", "new")).toBe("new-cache-new");
    expect(clonedDatabaseVolumeName("cache", "src", "new")).toBe("new-cache");
  });
});

// ---------------------------------------------------------------- Resource Limits, Webhooks, Danger Zone

describe("Resource Limits of a database", () => {
  it("reads and saves the limits on the database's row with ResourceLimits' defaults and messages", async () => {
    const t = setup();
    const pg = t.world.add("postgresql", "pg1");
    const r = await t.call("GET", "pg1/resource-limits");
    expect([frameOf(r).uuid, r.data.settings]).toEqual(["pg1", { limitsCpus: "0", limitsCpuset: null, limitsCpuShares: 1024, limitsMemory: "0", limitsMemorySwap: "0", limitsMemorySwappiness: 60, limitsMemoryReservation: "0" }]);
    const saved = await t.call("PATCH", "pg1/resource-limits", { limitsMemory: "512m", limitsCpus: "", limitsCpuShares: "" });
    expect([saved.status, saved.data.message]).toEqual([200, "Resource limits updated."]);
    expect(t.world.limitRows.get(String(pg.id))).toMatchObject({ limits_memory: "512m", limits_cpus: "0", limits_cpu_shares: 1024 });
    expect(t.refused(await t.call("PATCH", "pg1/resource-limits", { limitsMemory: "lots" }))).toEqual([
      422,
      { limitsMemory: ["Maximum Memory Limit must be a number followed by a unit (b, k, m, g). Example: 256m, 1g. Use 0 for unlimited."] },
    ]);
  });
});

describe("Webhooks and the Danger Zone of a database", () => {
  it("the deploy webhook is the database's", async () => {
    const t = setup();
    t.world.add("redis", "rd1");
    expect((await t.call("GET", "rd1/webhooks")).data.deployWebhookPath).toBe("/api/v1/deploy?uuid=rd1&force=false");
  });

  it("the Danger Zone says whether the delete removes the rows at once (never started), and flush needs the server", async () => {
    const t = setup();
    t.world.add("redis", "rd1");
    t.world.add("postgresql", "pg1", { status: "running:healthy", started_at: "2026-11-01 10:00:00" });
    const redis = await t.call("GET", "rd1/danger");
    expect([frameOf(redis).uuid, redis.data.neverDeployed, redis.data.serverIsFunctional]).toEqual(["rd1", true, true]);
    expect((await t.call("GET", "pg1/danger")).data.neverDeployed).toBe(false);
    expect(t.refused(await t.call("POST", "rd1/danger/flush", {}))).toEqual([501, UNAVAILABLE("Flushing the database's data on the server")]);
    expect((await t.call("POST", "pg1/danger/flush", {})).status).toBe(404);
  });
});

// ---------------------------------------------------------------- Healthcheck (DP-97)

describe("Healthcheck of a database (Database\\Health)", () => {
  it("reads the five columns with the frame; submit saves them with Health's toast", async () => {
    const t = setup();
    t.world.add("postgresql", "pg1");
    const r = await t.call("GET", "pg1/healthcheck");
    expect([r.status, frameOf(r).uuid, r.data.canUpdate]).toEqual([200, "pg1", true]);
    expect(r.data.health).toEqual({ healthCheckEnabled: true, healthCheckInterval: 15, healthCheckTimeout: 5, healthCheckRetries: 5, healthCheckStartPeriod: 5 });
    const saved = await t.call("PATCH", "pg1/healthcheck", { healthCheckInterval: "30", healthCheckTimeout: 10, healthCheckRetries: 3, healthCheckStartPeriod: 0 });
    expect(saved.status).toBe(200);
    expect(saved.data.message).toBe("Healthcheck updated. Restart the database to apply the changes.");
    expect(saved.data.health).toEqual({ healthCheckEnabled: true, healthCheckInterval: 30, healthCheckTimeout: 10, healthCheckRetries: 3, healthCheckStartPeriod: 0 });
  });

  it("refuses what #[Validate] refuses, with Laravel's messages and the property as the attribute, and stores nothing", async () => {
    const t = setup();
    t.world.add("redis", "rd1");
    const r = await t.call("PATCH", "rd1/healthcheck", { healthCheckInterval: 0, healthCheckTimeout: "x", healthCheckRetries: 1.5, healthCheckStartPeriod: -1, healthCheckEnabled: "maybe" });
    expect(r.status).toBe(422);
    expect(r.error.details.fields).toEqual({
      healthCheckEnabled: ["The health check enabled field must be true or false."],
      healthCheckInterval: ["The health check interval field must be at least 1."],
      healthCheckTimeout: ["The health check timeout field must be an integer."],
      healthCheckRetries: ["The health check retries field must be an integer."],
      healthCheckStartPeriod: ["The health check start period field must be at least 0."],
    });
    expect(t.world.healthRows.size).toBe(0);
  });

  it("toggleHealthcheck flips the switch and saves the form's values, with its own toast", async () => {
    const t = setup();
    t.world.add("mysql", "my1");
    const off = await t.call("POST", "my1/healthcheck/toggle", { healthCheckInterval: 20 });
    expect([off.status, off.data.message]).toEqual([200, "Healthcheck disabled. Restart the database to apply the changes."]);
    expect(off.data.health).toMatchObject({ healthCheckEnabled: false, healthCheckInterval: 20 });
    const on = await t.call("POST", "my1/healthcheck/toggle", {});
    expect([on.data.message, (on.data.health as { healthCheckEnabled: boolean }).healthCheckEnabled]).toEqual(["Healthcheck enabled. Restart the database to apply the changes.", true]);
  });

  it("asks deploy.resource.read to read and deploy.resource.write to save; a denial and another org's database are a 404", async () => {
    const reader = setup({ write: false });
    reader.world.add("postgresql", "pg1");
    expect((await reader.call("GET", "pg1/healthcheck")).data.canUpdate).toBe(false);
    expect((await reader.call("PATCH", "pg1/healthcheck", { healthCheckInterval: 30 })).status).toBe(404);
    expect((await reader.call("POST", "pg1/healthcheck/toggle", {})).status).toBe(404);
    expect(reader.world.healthRows.size).toBe(0);
    const denied = setup({ read: false, write: false });
    denied.world.add("postgresql", "pg1");
    expect((await denied.call("GET", "pg1/healthcheck")).status).toBe(404);
    const t = setup();
    expect((await t.call("GET", "other/healthcheck")).status).toBe(404);
    expect((await t.call("PATCH", "other/healthcheck", {})).status).toBe(404);
    expect((await t.call("PUT", "other/healthcheck", {})).status).toBe(405);
    expect((await t.call("GET", "other/healthcheck/toggle")).status).toBe(405);
    expect(t.orgs.every((o) => o === ORG_UUID)).toBe(true);
  });
});

// ---------------------------------------------------------------- every engine

describe.each(DATABASE_ENGINES)("%s", (engine) => {
  it("every shared page answers with the database's frame, and the variables are keyed by its type and morph class", async () => {
    const t = setup();
    const row = t.world.add(engine, "db1");
    for (const page of ["storages", "tags", "resource-operations", "resource-limits", "webhooks", "danger"]) {
      const r = await t.call("GET", `db1/${page}`);
      expect([page, r.status, frameOf(r).engine, frameOf(r).databaseType]).toEqual([page, 200, engine, DATABASE_ENGINE_SPECS[engine].databaseType]);
    }
    expect(databaseEnvironmentVariableResourceType(engine)).toBe(DATABASE_ENGINE_SPECS[engine].databaseType);
    expect(ENVIRONMENT_VARIABLE_MORPH_CLASS[databaseEnvironmentVariableResourceType(engine)]).toBe(DATABASE_TABLES[engine].morphClass);
    const variables = await t.call("GET", "db1/environment-variables");
    expect([variables.status, t.types, variables.data.showPreview]).toEqual([200, [`standalone-${engine}`], false]);
    expect((await t.call("POST", "db1/environment-variables", { key: "SMOKE", value: "1" })).status).toBe(201);
    expect(t.world.variables.map((v) => v.owner)).toEqual([{ type: DATABASE_TABLES[engine].morphClass, id: row.id }]);
    const volumes = ((await t.call("GET", "db1/storages")).data.volumes as Array<{ name: string }>).map((v) => v.name);
    expect(volumes).toEqual(defaultVolumes(engine, "db1", row.image).map((v) => v.name));
    const cloned = await t.call("POST", "db1/resource-operations/clone", { destination_uuid: "dst1" });
    expect(cloned.status).toBe(201);
    const clone = cloned.data.databaseUuid as string;
    expect(t.world.volumesOf(clone).map((v) => v.name)).toEqual(volumes.map((name) => clonedDatabaseVolumeName(name, "db1", clone)));
    expect((await t.call("POST", "db1/danger/flush", {})).status).toBe(["redis", "keydb", "dragonfly"].includes(engine) ? 501 : 404);
  });
});
