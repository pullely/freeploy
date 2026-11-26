// A service's configuration pages through the handler (DP-66): the frame and General page, a save with an edited
// Compose file — the rows loaded, parsed again and written back row by row, which service-reparse.test.ts holds
// to Coolify's PHP — the network and label switches, what needs a server (501), each application's and
// database's settings, storage, tags, the Danger Zone, the Environment Variables page keyed by 'service', the
// environment's resources list, authorization and routing. The store is in memory over rows shaped as the SQL
// answers them; the SQL itself is tested in tests/db.
import type { Env } from "@deploy-core-worker/env";
import { route } from "@deploy-core-worker/router";
import { handleServiceConfiguration, isServiceConfigurationRoute, type ServiceConfigurationRunner } from "@deploy-core-worker/handlers/service-configuration";
import { handleServices } from "@deploy-core-worker/handlers/services";
import type { EnvironmentVariableRunner } from "@deploy-core-worker/handlers/environment-variables";
import { createServiceFromTemplate, newServiceFromTemplate } from "@deploy-core-worker/services/parser";
import { MemoryServiceStore } from "@deploy-core-worker/services/store";
import { aggregateStatuses, partUrl, redactLockedValues, serviceStatus, type ServiceConfigurationStore } from "@deploy-core-worker/services/configuration";
import { serviceListResources } from "@deploy-core-worker/services/resources";
import { summarize } from "@deploy-core-worker/services/stack-form";
import { validateDockerComposeForInjection } from "@deploy-core-worker/services/compose-validation";
import type { ResourceRowsStore } from "@deploy-core-worker/applications/resources";
import type { KeyCipher } from "@deploy-core-worker/private-keys/service";
import type { ServicePagesStore } from "@deploy-core-worker/services/resource-pages";
import type { ServiceCloneStore } from "@deploy-core-worker/services/clone";
import type { DeployDestinationRow, DeployScheduledTaskRow, DeployServerRow } from "@saas/db/deploy";
import { SERVICE_PART_MORPH_CLASS, type DeployFileVolumeRow, type DeployPersistentVolumeRow, type DeployServiceConfigurationRow, type DeployServicePartFullRow, type DeployServiceVariableRow, type DeployTagRow, type ServicePartKind } from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy`;
const actor = { subjectId: "usr_1", subjectType: "user" };
type Body = Record<string, unknown>;
type Id = string | number;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}
const cipher: KeyCipher = { encrypt: async (p) => `enc:${p}`, decrypt: async (s) => s.replace(/^enc:/, "") };

interface Volume { id: number; name: string; mount_path: string; resource_type: string; resource_id: number; ignores_compose_driver_options: boolean }
interface File { id: number; fs_path: string; mount_path: string | null; content: string | null; resource_type: string; resource_id: number; is_directory: boolean; is_host_file: boolean; variable_fs_path: string | null }

/** One service of the org as the SQL stores it, from umami's template parsed by the port. */
class MemoryDb implements ServiceConfigurationStore {
  service: DeployServiceConfigurationRow;
  applications: DeployServicePartFullRow[] = [];
  databases: DeployServicePartFullRow[] = [];
  vars: DeployServiceVariableRow[] = [];
  volumeRows: Volume[] = [];
  fileRows: File[] = [];
  tagRows: DeployTagRow[] = [{ id: 1, uuid: "tag1", name: "production" }];
  taggables: { tagId: Id; type: string; id: Id }[] = [];
  owners = [{ uuid: "other-app", name: "shop", fqdn: "https://shop.example.com" }];
  deleted = false;
  /** DP-97 */
  tasks: Array<DeployScheduledTaskRow & { service_id: Id }> = [];
  moves: Array<[Id, Id]> = [];
  private next = 1000;

  constructor(template = "umami") {
    const created = newServiceFromTemplate({ type: `one-click-service-${template}`, uuid: "svc1", id: 7 })!;
    const memory = MemoryServiceStore.forService(created.service);
    let n = 0;
    createServiceFromTemplate(memory, created.environment, {
      server: { ip: "203.0.113.10", wildcardDomain: null, proxyType: "TRAEFIK", generateExactLabels: false, traefikCertificateResolver: "letsencrypt", isTrafficAnalyticsEnabled: false, caddySupportsLogAppend: false, logDrainConfiguration: null },
      destinationNetwork: "coolify",
      projectName: "Shop",
      environmentName: "production",
      newUuid: () => `part${++n}`,
      magicValue: (command, key) => (command === "" ? null : `generated-${key}`),
    });
    const rows = memory.rows();
    this.service = {
      id: 7, uuid: "svc1", name: rows.service.name, description: null, docker_compose_raw: rows.service.docker_compose_raw ?? "", docker_compose: rows.service.docker_compose,
      connect_to_docker_network: false, service_type: template, is_container_label_escape_enabled: true, compose_parsing_version: "5", include_coolify_default_variables: true,
      redact_all_env_values_in_logs: true, config_hash: null, environment_id: 10, environment_uuid: "env1", environment_name: "production", project_id: 1, project_uuid: "prj1", project_name: "Shop",
      server_id: 100, server_uuid: "srv1", server_name: "main", server_ip: "203.0.113.10", server_proxy: { type: "TRAEFIK" }, server_is_reachable: false, server_is_usable: false, server_force_disabled: false,
      server_wildcard_domain: null, server_generate_exact_labels: false, server_traefik_certificate_resolver: "letsencrypt", server_is_traffic_analytics_enabled: false,
      server_is_logdrain_newrelic_enabled: false, server_is_logdrain_axiom_enabled: false, server_is_logdrain_custom_enabled: false, server_is_logdrain_cloudwatch_enabled: false,
      destination_id: 200, destination_type: "App\\Models\\StandaloneDocker", destination_uuid: "dst1", destination_name: "default", destination_network: "coolify", created_at: null, updated_at: null,
    };
    const base = { description: null, status: "exited", last_online_at: null, restart_count: 0, max_restart_count: 0, restart_limit_reached: false, public_port: null, public_port_timeout: null, is_public: null };
    this.applications = rows.applications.map((r) => ({ ...base, ...r, id: r.id, noindex_domains: r.noindex_domains, domain_port_overrides: r.domain_port_overrides }));
    this.databases = rows.databases.map((r) => ({ ...base, ...r, id: 100 + r.id, fqdn: null, noindex_domains: null, redirect: null, is_force_https_enabled: null, is_permanent_redirect_enabled: null, domain_port_overrides: null, traefik_certificate_resolver: null, restart_count: null, max_restart_count: null, restart_limit_reached: null, public_port_timeout: 3600, is_public: false }));
    this.vars = rows.environmentVariables.map((r) => ({ ...r, value: r.value === null ? null : `enc:${r.value}`, is_shown_once: false }));
    const partId = (kind: ServicePartKind, id: number) => (kind === "database" ? 100 + id : id);
    this.volumeRows = rows.persistentVolumes.map((r) => ({ id: r.id, name: r.name, mount_path: r.mount_path ?? "", resource_type: SERVICE_PART_MORPH_CLASS[r.resource_type], resource_id: partId(r.resource_type, r.resource_id), ignores_compose_driver_options: r.ignores_compose_driver_options }));
    this.fileRows = rows.fileVolumes.map((r) => ({ id: r.id, fs_path: r.fs_path ?? "", mount_path: r.mount_path, content: r.content, resource_type: SERVICE_PART_MORPH_CLASS[r.resource_type], resource_id: partId(r.resource_type, r.resource_id), is_directory: r.is_directory, is_host_file: r.is_host_file, variable_fs_path: r.variable_fs_path }));
  }

  async find(uuid: string) {
    return uuid === this.service.uuid && !this.deleted ? this.service : null;
  }
  async parts(kind: ServicePartKind) {
    return kind === "application" ? this.applications : this.databases;
  }
  async variables() {
    return this.vars;
  }
  // ServiceRowsStore
  async volumes() {
    return this.volumeRows.map((v) => ({ ...v }));
  }
  async files() {
    return this.fileRows.map((f) => ({ ...f, has_scheduled_backups: false }));
  }
  async update(kind: string, _serviceId: Id, id: Id, changes: Record<string, unknown>) {
    const table = (
      kind === "service" ? [this.service] : kind === "application" ? this.applications : kind === "database" ? this.databases : kind === "variable" ? this.vars : kind === "volume" ? this.volumeRows : this.fileRows) as unknown as Record<string, unknown>[];
    const row = table.find((r) => String(r.id) === String(id));
    if (!row) return false;
    Object.assign(row, changes);
    return true;
  }
  async insertPart(kind: ServicePartKind, _serviceId: Id, uuid: string, row: Record<string, unknown>) {
    const id = ++this.next;
    (kind === "application" ? this.applications : this.databases).push({ status: "exited", description: null, ...row, uuid, id } as DeployServicePartFullRow);
    return id;
  }
  async insertVariable(_serviceId: Id, _uuid: string, row: Record<string, unknown>) {
    const id = ++this.next;
    this.vars.push({ ...row, id, is_shown_once: false } as DeployServiceVariableRow);
    return id;
  }
  async insertStorage(kind: "volume" | "file", owner: { kind: ServicePartKind; id: Id }, _uuid: string, row: Record<string, unknown>) {
    const id = ++this.next;
    const ownerColumns = { resource_type: SERVICE_PART_MORPH_CLASS[owner.kind], resource_id: Number(owner.id) };
    if (kind === "volume") this.volumeRows.push({ ...(row as unknown as Volume), ...ownerColumns, id });
    else this.fileRows.push({ ...(row as unknown as File), ...ownerColumns, id });
    return id;
  }
  async deleteVariables(_serviceId: Id, ids: Id[]) {
    const before = this.vars.length;
    this.vars = this.vars.filter((v) => !ids.map(String).includes(String(v.id)));
    return before - this.vars.length;
  }
  async deleteFiles(_serviceId: Id, ids: Id[]) {
    const before = this.fileRows.length;
    this.fileRows = this.fileRows.filter((f) => !ids.map(String).includes(String(f.id)));
    return before - this.fileRows.length;
  }
  async domainOwners() {
    return [...this.owners, ...this.applications.map((a) => ({ uuid: a.uuid, name: a.name, fqdn: a.fqdn }))];
  }
  async hasRun() {
    return [...this.applications, ...this.databases].some((p) => !p.status.startsWith("exited"));
  }
  async deletePart(kind: ServicePartKind, _serviceId: Id, id: Id) {
    const list = kind === "application" ? this.applications : this.databases;
    const index = list.findIndex((p) => String(p.id) === String(id));
    if (index === -1) return false;
    list.splice(index, 1);
    const morph = SERVICE_PART_MORPH_CLASS[kind];
    this.volumeRows = this.volumeRows.filter((v) => !(v.resource_type === morph && String(v.resource_id) === String(id)));
    this.fileRows = this.fileRows.filter((f) => !(f.resource_type === morph && String(f.resource_id) === String(id)));
    return true;
  }

  /** The shared pages' rows of one morph class (storage and tags). */
  rows(morph: string): ResourceRowsStore {
    const volume = (v: Volume): DeployPersistentVolumeRow => ({ id: v.id, uuid: null, name: v.name, mount_path: v.mount_path, host_path: null, is_preview_suffix_enabled: true, standalone_sqlite_id: null, ignores_compose_driver_options: v.ignores_compose_driver_options, backup_enabled: null, backup_save_s3: null, has_backups: false });
    const file = (f: File): DeployFileVolumeRow =>
      ({ id: f.id, uuid: null, fs_path: f.fs_path, mount_path: f.mount_path, content: f.content === null ? null : `enc:${f.content}`, is_directory: f.is_directory, is_host_file: f.is_host_file, is_based_on_git: false, is_preview_suffix_enabled: true, chown: null, chmod: null, backup_enabled: null, has_backups: false }) as unknown as DeployFileVolumeRow;
    const mine = <T extends { resource_type: string; resource_id: number }>(rows: T[], id: Id) => rows.filter((r) => r.resource_type === morph && String(r.resource_id) === String(id));
    return {
      volumes: async (id) => mine(this.volumeRows, id).map(volume),
      findVolume: async (id, volumeId) => mine(this.volumeRows, id).map(volume).find((v) => String(v.id) === String(volumeId)) ?? null,
      insertVolume: async () => {
        throw new Error("not used");
      },
      updateVolume: async () => true,
      deleteVolume: async () => true,
      files: async (id) => mine(this.fileRows, id).map(file),
      findFile: async (id, fileId) => mine(this.fileRows, id).map(file).find((f) => String(f.id) === String(fileId)) ?? null,
      insertFile: async () => {
        throw new Error("not used");
      },
      updateFile: async (_id, fileId, changes) => {
        const row = this.fileRows.find((f) => String(f.id) === String(fileId));
        if (row && "content" in changes) row.content = changes.content === null || changes.content === undefined ? null : String(changes.content).replace(/^enc:/, "");
        return Boolean(row);
      },
      deleteFile: async (_id, fileId) => {
        this.fileRows = this.fileRows.filter((f) => String(f.id) !== String(fileId));
        return true;
      },
      tags: async () => this.tagRows,
      resourceTags: async (id) => this.tagRows.filter((t) => this.taggables.some((x) => x.tagId === t.id && x.type === morph && String(x.id) === String(id))),
      findTagByName: async (name) => this.tagRows.find((t) => t.name === name) ?? null,
      findTagById: async (id) => this.tagRows.find((t) => String(t.id) === String(id)) ?? null,
      insertTag: async (tag) => {
        const row = { id: ++this.next, ...tag };
        this.tagRows.push(row);
        return row;
      },
      hasTag: async (id, tagId) => this.taggables.some((x) => String(x.tagId) === String(tagId) && x.type === morph && String(x.id) === String(id)),
      attachTag: async (id, tagId) => {
        this.taggables.push({ tagId: Number(tagId), type: morph, id });
      },
      detachTag: async (id, tagId) => {
        const before = this.taggables.length;
        this.taggables = this.taggables.filter((x) => !(String(x.tagId) === String(tagId) && x.type === morph && String(x.id) === String(id)));
        return before !== this.taggables.length;
      },
      operationEnvironments: async () => [],
      operationServers: async () => [],
      operationDestinations: async () => [],
    };
  }
}

/** DP-97: the service's scheduled tasks and moves, in memory (the SQL is tested in tests/db). */
function servicePages(db: MemoryDb): ServicePagesStore {
  return {
    tasks: async (serviceId) => db.tasks.filter((t) => same(t.service_id, serviceId)),
    findTask: async (serviceId, uuid) => {
      const row = db.tasks.find((t) => same(t.service_id, serviceId) && t.uuid === uuid);
      return row ? { ...row } : null;
    },
    insertTask: async (t) => {
      const row = { id: db.tasks.length + 1, uuid: t.uuid, enabled: true, name: t.name, command: t.command, frequency: t.frequency, container: t.container, timeout: t.timeout, use_shell: t.useShell, disabled_reason: null, created_at: null, updated_at: null, latest_status: null, service_id: t.serviceId };
      db.tasks.push(row);
      return row;
    },
    updateTask: async (serviceId, id, changes) => {
      const row = db.tasks.find((t) => same(t.service_id, serviceId) && same(t.id, id));
      if (row) Object.assign(row, changes);
      return Boolean(row);
    },
    deleteTask: async (serviceId, id) => {
      const before = db.tasks.length;
      db.tasks = db.tasks.filter((t) => !(same(t.service_id, serviceId) && same(t.id, id)));
      return before !== db.tasks.length;
    },
    executions: async () => [],
    serverTimezone: async (serverId) => (same(serverId ?? "", 100) ? "Europe/Berlin" : null),
    findEnvironment: async (uuid) => [{ id: 10, uuid: "env1", name: "production", project_uuid: "prj1" }, { id: 11, uuid: "env2", name: "staging", project_uuid: "prj2" }].find((e) => e.uuid === uuid) ?? null,
    move: async (serviceId, environmentId) => {
      db.moves.push([serviceId, environmentId]);
      return true;
    },
  };
}

/** cloneTo()'s lookups; clone_service()'s rows are recorded only (the clone itself is service-clone.test.ts's, on PGlite). */
function serviceCloneStore(replicas: unknown[] = []): ServiceCloneStore {
  const server = (uuid: string, role: string | null) => ({ id: uuid === "srv1" ? 100 : 101, uuid, name: uuid, ip: "203.0.113.10", server_role: role, is_build_server: role === "build" }) as unknown as DeployServerRow;
  const unused = async (): Promise<never> => {
    throw new Error("not reached: the replica is not stored in memory");
  };
  return {
    replicateService: async (sourceId, replica) => {
      replicas.push([sourceId, replica]);
      return null;
    },
    copyTags: unused,
    scheduledTaskIds: unused,
    replicateScheduledTask: unused,
    environmentVariableIds: unused,
    replicateEnvironmentVariable: unused,
    cloneSecretManagerLink: unused,
    backupScheduleIds: unused,
    replicateBackupSchedule: unused,
    findDestination: async (uuid) => (uuid === "dst1" ? ({ id: 200, uuid: "dst1", name: "default", network: "coolify", type: "standalone", server_uuid: "srv1" } as unknown as DeployDestinationRow) : uuid === "dst-build" ? ({ id: 201, uuid: "dst-build", name: "build", network: "coolify", type: "standalone", server_uuid: "srv-build" } as unknown as DeployDestinationRow) : null),
    findServer: async (uuid) => (uuid === "srv1" ? server("srv1", null) : uuid === "srv-build" ? server("srv-build", "build") : null),
  };
}

const same = (a: Id, b: Id) => String(a) === String(b);

function setup(opts: { write?: boolean; read?: boolean; template?: string } = {}) {
  const db = new MemoryDb(opts.template);
  const replicas: unknown[] = [];
  const store = db;
  const env: Env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      const allow = body.action === "deploy.resource.write" ? (opts.write ?? true) : (opts.read ?? true);
      return json({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
  };
  const runner: ServiceConfigurationRunner = async (_env, _orgId, fn) =>
    fn({
      configuration: { store: store as unknown as ServiceConfigurationStore, ciphers: { variables: cipher, content: cipher } },
      rows: (morph) => db.rows(morph),
      content: cipher,
      deleteService: async () => (db.deleted = true),
      pages: servicePages(db),
      clone: serviceCloneStore(replicas),
    });
  const variableTypes: string[] = [];
  const variablesRunner: EnvironmentVariableRunner = async (_env, _orgId, type) => {
    variableTypes.push(type);
    throw new Error("stop");
  };
  let counter = 0;
  const deps = { newUuid: () => `new${++counter}`, parser: { magicValue: (command: string, key: string) => (command === "" ? null : `generated-${key}`) } };
  const call = async (method: string, path: string, body?: unknown) => {
    const segments = path.split("/").filter(Boolean);
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleServiceConfiguration(env, "req_1", actor, ORG_UUID, segments, new Request(`${BASE}/services/${path}`, init), runner, variablesRunner, deps);
    return { status: res.status, body: (await res.json()) as Body };
  };
  return { db, env, call, variableTypes, replicas };
}

const data = <T = Body>(r: { body: Body }) => r.body.data as T;
const error = (r: { body: Body }) => r.body.error as { code: string; message: string; details?: Body };

describe("GET /services/{uuid}/configuration", () => {
  it("answers the frame and the General page: the template's fields, the Compose files for who may update", async () => {
    const { call } = setup();
    const r = await call("GET", "svc1/configuration");
    expect(r.status).toBe(200);
    const page = data<{ service: Body; general: Body; canUpdate: boolean }>(r);
    expect(page.service).toMatchObject({
      uuid: "svc1",
      name: "umami-svc1",
      serviceType: "umami",
      project: { uuid: "prj1", name: "Shop" },
      environment: { uuid: "env1", name: "production" },
      server: { uuid: "srv1", name: "main", isFunctional: false },
      status: "exited",
      isDeployable: true,
      documentation: expect.stringMatching(/^https:\/\//) as string,
      applications: [{ kind: "application", name: "umami", displayName: "Umami", fqdn: "http://umami-svc1.203.0.113.10.sslip.io", status: "exited" }],
      databases: [{ kind: "database", name: "postgresql", displayName: "Postgresql" }],
    });
    expect((page.service.documentation as string).includes("utm_source")).toBe(false);
    expect(page.general).toMatchObject({ name: "umami-svc1", description: null, connectToDockerNetwork: false, isContainerLabelEscapeEnabled: true, isPasswordHiddenForMember: false });
    expect(page.general.dockerComposeRaw).toContain("ghcr.io/umami-software/umami");
    expect((page.general.fields as Body[]).map((f) => [f.serviceName, f.name, f.key, f.isPassword, f.rules])).toEqual([
      ["PostgreSQL", "User", "SERVICE_USER_POSTGRES", false, "required"],
      ["PostgreSQL", "Database Name", "POSTGRES_DB", false, "required"],
      ["PostgreSQL", "Password", "SERVICE_PASSWORD_POSTGRES", true, "required"],
    ]);
    expect(page.canUpdate).toBe(true);
  });

  it("hides the Compose files and every field's value from who may only read", async () => {
    const { call } = setup({ write: false });
    const page = data<{ general: Body }>(await call("GET", "svc1/configuration"));
    expect(page.general.dockerComposeRaw).toBeNull();
    expect(page.general.dockerCompose).toBeNull();
    expect(page.general.isPasswordHiddenForMember).toBe(true);
    expect((page.general.fields as Body[]).every((f) => f.value === null)).toBe(true);
  });
});

describe("PATCH /services/{uuid}/configuration", () => {
  it("saves an edited Compose file: the rows parsed again and written back, not duplicated", async () => {
    const { call, db } = setup();
    const raw = db.service.docker_compose_raw.replace("ghcr.io/umami-software/umami:3.5.0", "nginx:1.27-alpine");
    const counts = { variables: db.vars.length, volumes: db.volumeRows.length, applications: db.applications.length };
    const r = await call("PATCH", "svc1/configuration", { name: "umami-svc1", description: "Analytics", dockerComposeRaw: raw });
    expect(r.status).toBe(200);
    expect(data<Body>(r)).toMatchObject({ message: "Service saved.", unavailable: "Writing the Compose file and its .env file to the server needs the SSH executor, which is not available yet." });
    expect(db.service.docker_compose_raw).toBe(raw);
    expect(db.service.description).toBe("Analytics");
    expect(db.service.docker_compose).toContain("image: 'nginx:1.27-alpine'");
    expect(db.applications.map((a) => [a.name, a.image])).toEqual([["umami", "nginx:1.27-alpine"]]);
    expect({ variables: db.vars.length, volumes: db.volumeRows.length, applications: db.applications.length }).toEqual(counts);
  });

  it("adds what a new Compose service brings, and marks a removed one", async () => {
    const { call, db } = setup();
    const raw = `${db.service.docker_compose_raw}`.replace(
      "services:\n",
      "services:\n  extra:\n    image: 'busybox:1.36'\n    environment:\n      - SERVICE_URL_EXTRA_8080\n      - EXTRA_SECRET=${SERVICE_PASSWORD_EXTRA}\n    volumes:\n      - 'extra-data:/data'\n",
    );
    expect((await call("PATCH", "svc1/configuration", { dockerComposeRaw: raw })).status).toBe(200);
    expect(db.applications.map((a) => a.name)).toEqual(["umami", "extra"]);
    expect(db.applications[1]).toMatchObject({ uuid: "new1", fqdn: "http://extra-svc1.203.0.113.10.sslip.io" });
    expect(db.vars.find((v) => v.key === "SERVICE_URL_EXTRA_8080")?.value).toBe("enc:http://extra-svc1.203.0.113.10.sslip.io:8080");
    expect(db.vars.find((v) => v.key === "SERVICE_PASSWORD_EXTRA")?.value).toBe("enc:generated-SERVICE_PASSWORD_EXTRA");
    expect(db.volumeRows.find((v) => v.name === "svc1_extra-data")).toMatchObject({ resource_type: SERVICE_PART_MORPH_CLASS.application, resource_id: db.applications[1]!.id });
    const without = db.service.docker_compose_raw.replace(/  extra:\n(?: {4}.*\n)+/, "");
    expect((await call("PATCH", "svc1/configuration", { dockerComposeRaw: without })).status).toBe(200);
    expect(db.applications.map((a) => [a.name, a.is_removed_from_compose])).toEqual([
      ["umami", false],
      ["extra", true],
    ]);
  });

  it("refuses what StackForm refuses, with its messages, and stores nothing", async () => {
    const { call, db } = setup();
    const before = JSON.stringify(db.service);
    const empty = await call("PATCH", "svc1/configuration", { name: "", dockerComposeRaw: "", fields: { POSTGRES_DB: "" } });
    expect(empty.status).toBe(422);
    expect(error(empty).message).toBe("The Docker Compose Raw field is required. (and 2 more errors)");
    expect(error(empty).details?.fields).toEqual({ dockerComposeRaw: ["The Docker Compose Raw field is required."], name: ["The Name field is required."], "fields.POSTGRES_DB.value": ["The Database Name field is required."] });
    const injected = await call("PATCH", "svc1/configuration", { dockerComposeRaw: "services:\n  'a;b':\n    image: nginx\n" });
    expect(injected.status).toBe(422);
    expect(error(injected).message).toContain("Invalid Docker Compose service name");
    const noServices = await call("PATCH", "svc1/configuration", { dockerComposeRaw: "volumes: {}\n" });
    expect(error(noServices).message).toBe('Docker Compose file must contain a "services" section');
    expect(JSON.stringify(db.service)).toBe(before);
  });

  it("writes the fields to their variables", async () => {
    const { call, db } = setup();
    expect((await call("PATCH", "svc1/configuration", { fields: { POSTGRES_DB: "analytics" } })).status).toBe(200);
    expect(db.vars.find((v) => v.key === "POSTGRES_DB")?.value).toBe("enc:analytics");
  });
});

describe("the switches and the actions", () => {
  it("saves the network and the label escaping alone", async () => {
    const { call, db } = setup();
    const network = await call("PATCH", "svc1/configuration/network", { connectToDockerNetwork: true });
    expect(data<Body>(network).message).toBe("Service settings saved.");
    expect(db.service.connect_to_docker_network).toBe(true);
    const escape = await call("PATCH", "svc1/configuration/label-escape", { isContainerLabelEscapeEnabled: false });
    expect(data<Body>(escape).message).toBe("Service updated successfully");
    expect(db.service.is_container_label_escape_enabled).toBe(false);
    expect((await call("PATCH", "svc1/configuration/label-escape", {})).status).toBe(422);
  });

  it.each([
    ["start", "Deploying the service needs the SSH executor, which is not available yet."],
    ["force-deploy", "Deploying the service needs the SSH executor, which is not available yet."],
    ["stop", "Stopping the service needs the SSH executor, which is not available yet."],
    ["restart", "Restarting the service needs the SSH executor, which is not available yet."],
    ["pull-restart", "Restarting the service needs the SSH executor, which is not available yet."],
  ])("answers 501 for %s", async (action, message) => {
    const { call } = setup();
    const r = await call("POST", `svc1/actions/${action}`);
    expect(r.status).toBe(501);
    expect(error(r).message).toBe(message);
    expect((await call("POST", "svc1/actions/explode")).status).toBe(404);
  });
});

describe("an application's and a database's settings", () => {
  it("shows a part with its own settings", async () => {
    const { call, db } = setup();
    const app = data<{ part: Body }>(await call("GET", `svc1/parts/${db.applications[0]!.uuid}`));
    expect(app.part).toMatchObject({ kind: "application", name: "umami", isGzipEnabled: true, certificateResolverMode: "server", showCertificateResolver: true, serverCertificateResolver: "letsencrypt" });
    const database = data<{ part: Body }>(await call("GET", `svc1/parts/${db.databases[0]!.uuid}`));
    expect(database.part).toMatchObject({ kind: "database", name: "postgresql", isPublic: false, publicPort: null, publicPortTimeout: 3600 });
    expect((await call("GET", "svc1/parts/unknown")).status).toBe(404);
  });

  it("saves an application's domains with the shared domain rules, and refuses one in use", async () => {
    const { call, db } = setup();
    const uuid = db.applications[0]!.uuid;
    const invalid = await call("PATCH", `svc1/parts/${uuid}`, { action: "submit", fqdn: "ftp://x" });
    expect(invalid.status).toBe(422);
    expect(error(invalid).details?.fields).toEqual({ fqdn: ["Invalid URL: ftp://x"] });
    const conflict = await call("PATCH", `svc1/parts/${uuid}`, { action: "submit", fqdn: "https://shop.example.com" });
    expect(conflict.status).toBe(409);
    expect(error(conflict).details?.conflicts).toEqual([expect.objectContaining({ domain: "https://shop.example.com", resource_name: "shop" })]);
    const saved = await call("PATCH", `svc1/parts/${uuid}`, { action: "submit", fqdn: "HTTPS://Umami.Example.com:3000", humanName: "Analytics" });
    expect(data<Body>(saved).message).toBe("Service saved.");
    expect(db.applications[0]).toMatchObject({ fqdn: "https://umami.example.com", domain_port_overrides: { "https://umami.example.com": 3000 }, human_name: "Analytics" });
    expect(partUrl(db.applications[0]!)).toBe("https://umami.example.com:3000");
    const two = await call("PATCH", `svc1/parts/${uuid}`, { action: "submit", fqdn: "https://a.example.com,https://b.example.com" });
    expect(data<Body>(two)).toMatchObject({ message: null, warning: expect.stringContaining("Some services do not support multiple domains") as string });
  });

  it("checks a database's public access as Coolify does, and the server's log drain", async () => {
    const { call, db } = setup();
    const uuid = db.databases[0]!.uuid;
    expect(error(await call("PATCH", `svc1/parts/${uuid}`, { action: "publicAccess", isPublic: true })).message).toBe("Public port is required.");
    expect(error(await call("PATCH", `svc1/parts/${uuid}`, { action: "publicAccess", isPublic: true, publicPort: 5432 })).message).toBe("Database must be started to be publicly accessible.");
    expect(error(await call("PATCH", `svc1/parts/${uuid}`, { action: "logDrain", isLogDrainEnabled: true })).message).toBe("Log drain is not enabled on the server. Please enable it first.");
    const saved = await call("PATCH", `svc1/parts/${uuid}`, { action: "submit", publicPort: 15432, image: "postgres:17-alpine" });
    expect(data<Body>(saved).message).toBe("Database saved.");
    expect(db.databases[0]).toMatchObject({ public_port: 15432, image: "postgres:17-alpine" });
    expect(error(await call("PATCH", `svc1/parts/${uuid}`, { action: "submit", image: "" })).details?.fields).toEqual({ image: ["The image field is required."] });
    expect((await call("PATCH", `svc1/parts/${uuid}`, { action: "restart" })).status).toBe(501);
  });

  it("deletes a part of a service that never ran, and answers 501 once one ran", async () => {
    const { call, db } = setup();
    const deleted = await call("DELETE", `svc1/parts/${db.databases[0]!.uuid}`);
    expect(data<Body>(deleted).message).toBe("Database deleted.");
    expect(db.databases).toEqual([]);
    expect(db.volumeRows).toEqual([]);
    db.applications[0]!.status = "running:healthy";
    expect((await call("DELETE", `svc1/parts/${db.applications[0]!.uuid}`)).status).toBe(501);
  });
});

describe("storage, tags, the Danger Zone and the Environment Variables page", () => {
  it("lists each part's storage, read-only for its volumes", async () => {
    const { call, db } = setup();
    const page = data<{ sections: { kind: string; title: string; storages: { volumes: Body[]; hostPath: string } }[] }>(await call("GET", "svc1/storages"));
    expect(page.sections.map((s) => [s.kind, s.title, s.storages.volumes.map((v) => [v.name, v.isReadOnly])])).toEqual([
      ["application", "Umami", []],
      ["database", "Postgresql", [["svc1_postgresql-data", true]]],
    ]);
    expect(page.sections[0]!.storages.hostPath).toBe("/data/coolify/services/svc1");
    const volume = db.volumeRows[0]!;
    const refused = await call("PATCH", `svc1/storages/${db.databases[0]!.uuid}/volumes/${volume.id}`, { name: "x", mount_path: "/x" });
    expect(refused.status).toBe(422);
    expect(error(refused).message).toBe("This volume is read-only.");
  });

  it("adds and removes the service's tags", async () => {
    const { call, db } = setup();
    const added = await call("POST", "svc1/tags", { newTags: "production staging" });
    expect(added.status).toBe(200);
    expect(db.taggables.map((t) => t.type)).toEqual(["App\\Models\\Service", "App\\Models\\Service"]);
    const shown = data<{ tags: Body[]; service: Body }>(await call("GET", "svc1/tags"));
    expect(shown.tags.map((t) => t.name)).toEqual(["production", "staging"]);
    expect(shown.service.uuid).toBe("svc1");
    expect((await call("DELETE", "svc1/tags/1")).status).toBe(200);
  });

  it("deletes a service that never ran, and answers 501 for one that did", async () => {
    const ran = setup();
    ran.db.databases[0]!.status = "running:healthy";
    expect(data<Body>(await ran.call("GET", "svc1/danger")).neverDeployed).toBe(false);
    const refused = await ran.call("DELETE", "svc1/danger");
    expect(refused.status).toBe(501);
    expect(error(refused).message).toBe("Stopping the service and removing its containers, volumes, networks and configuration files from the server needs the SSH executor, which is not available yet.");
    const fresh = setup();
    expect(data<Body>(await fresh.call("GET", "svc1/danger"))).toMatchObject({ neverDeployed: true, serverIsFunctional: false });
    expect(data<Body>(await fresh.call("DELETE", "svc1/danger"))).toEqual({ deleted: true, projectUuid: "prj1", environmentUuid: "env1" });
    expect(fresh.db.deleted).toBe(true);
  });

  it("hands the Environment Variables page the type 'service'", async () => {
    const { call, variableTypes } = setup();
    await call("GET", "svc1/environment-variables");
    expect(variableTypes).toEqual(["service"]);
  });
});

describe("authorization and routing", () => {
  it("answers 404 to who may not read, and to a reader who writes", async () => {
    expect((await setup({ read: false, write: false }).call("GET", "svc1/configuration")).status).toBe(404);
    expect((await setup({ write: false }).call("PATCH", "svc1/configuration", {})).status).toBe(404);
    expect((await setup({ write: false }).call("DELETE", "svc1/danger")).status).toBe(404);
    expect((await setup().call("GET", "other/configuration")).status).toBe(404);
  });

  it("answers 405 for a method a page does not have and 404 below it", async () => {
    const { call } = setup();
    expect((await call("DELETE", "svc1/configuration")).status).toBe(405);
    expect((await call("GET", "svc1/configuration/nothing")).status).toBe(404);
    expect((await call("GET", "svc1/storages/x/y")).status).toBe(404);
    expect(isServiceConfigurationRoute(["svc1", "def"])).toBe(false);
    expect(isServiceConfigurationRoute(["svc1", "tags"])).toBe(true);
  });

  it("is reached through handleServices and route(), behind the actor headers", async () => {
    const { env } = setup();
    const viaServices = await handleServices(env, "req_1", actor, ORG_UUID, ["svc1", "danger", "x", "y"], new Request(`${BASE}/services/svc1/danger/x/y`));
    expect(viaServices.status).toBe(404);
    const anonymous = await route(new Request(`${BASE}/services/svc1/configuration`), env);
    expect(anonymous.status).toBe(401);
    const deep = await route(new Request(`${BASE}/services/svc1/storages/part/volumes/1/x`, { headers: { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" } }), env);
    expect(deep.status).toBe(404);
  });
});

describe("the pieces", () => {
  it("aggregates the parts' statuses as Coolify does", () => {
    expect(aggregateStatuses([])).toBe("exited");
    expect(aggregateStatuses(["running:healthy", "exited"])).toBe("degraded:unhealthy");
    expect(aggregateStatuses(["running:healthy", "running:unknown"])).toBe("running:unknown");
    expect(aggregateStatuses(["starting", "running:healthy"])).toBe("starting:unknown");
    const part = (status: string, exclude = false, removed = false) => ({ status, exclude_from_status: exclude, is_removed_from_compose: removed });
    expect(serviceStatus([part("running:healthy"), part("exited", false, true)])).toBe("running:healthy");
    expect(serviceStatus([part("running:healthy", true)])).toBe("running:healthy:excluded");
    expect(serviceStatus([part("exited", false, true)])).toBe("unknown:unknown:excluded");
  });

  it("redacts locked values in the generated file, the longest first", () => {
    expect(redactLockedValues("a: secret$1\nb: secret$$1\nc: abc", ["secret$1", "abc"])).toBe("a: <locked>\nb: <locked>\nc: abc");
    expect(redactLockedValues(null, ["x"])).toBeNull();
  });

  it("summarizes validation errors as Laravel does", () => {
    expect(summarize({ a: ["One."] })).toBe("One.");
    expect(summarize({ a: ["One."], b: ["Two.", "Three."] })).toBe("One. (and 2 more errors)");
    expect(summarize({ a: ["One."], b: ["Two."] })).toBe("One. (and 1 more error)");
  });

  it("refuses unsafe Compose networks and volumes", () => {
    expect(() => validateDockerComposeForInjection("services:\n  a:\n    image: x\n    networks:\n      - 'bad;name'\n")).toThrow('Invalid Docker Compose service network "bad;name" in service a.');
    expect(() => validateDockerComposeForInjection("services:\n  a:\n    image: x\nnetworks:\n  'n;x': {}\n")).toThrow('Invalid Docker Compose network name "n;x".');
    expect(() => validateDockerComposeForInjection("services:\n  a:\n    image: x\n    volumes:\n      - type: bind\n        source: ./x\n        target: '/a;b'\n")).toThrow("Invalid Docker volume definition (array syntax)");
    expect(() => validateDockerComposeForInjection("services:\n  a:\n    image: x\n    networks:\n      - ${NET:-coolify}\n")).not.toThrow();
  });

  it("lists services in the environment's resources", () => {
    const listed = serviceListResources(
      [
        { id: 2, uuid: "s2", name: "zeta", description: null, server_name: "main", server_ip: "203.0.113.10", server_is_reachable: true, server_is_usable: true, server_force_disabled: false, parts: [{ status: "running:healthy", exclude_from_status: false, is_removed_from_compose: false }] },
        { id: 1, uuid: "s1", name: "alpha", description: "d", server_name: null, server_ip: null, server_is_reachable: null, server_is_usable: null, server_force_disabled: null, parts: "[]" },
      ],
      new Map([["s2", [{ id: "1", name: "prod" }]]]),
    );
    expect(listed.map((s) => [s.name, s.type, s.typeLabel, s.status, s.server_status, s.destination.server.name, s.tags.length])).toEqual([
      ["alpha", "service", "Service", "unknown:unknown:excluded", false, "Unknown", 0],
      ["zeta", "service", "Service", "running:healthy", true, "main", 1],
    ]);
  });
});

// ---------------------------------------------------------------- DP-97: Scheduled Tasks, Webhooks, Resource Operations

describe("a service's Scheduled Tasks (ScheduledTask\\All with the service as its resource)", () => {
  it("lists none, with the parts' names as containers, the server's timezone and isRunning", async () => {
    const { call } = setup();
    const r = await call("GET", "svc1/scheduled-tasks");
    expect(r.status).toBe(200);
    expect(data<Body>(r)).toMatchObject({ service: { uuid: "svc1" }, tasks: [], containerNames: ["umami", "postgresql"], serverTimezone: "Europe/Berlin", isRunning: false, canUpdate: true });
  });

  it("adds a task with Add's rules and messages; an empty container reads Add's undeclared $subServiceName", async () => {
    const { call, db } = setup();
    const refused = await call("POST", "svc1/scheduled-tasks", { name: "", command: "", frequency: "", timeout: 30 });
    expect(refused.status).toBe(422);
    expect(error(refused).details?.fields).toEqual({
      name: ["The name field is required."],
      command: ["The command field is required."],
      frequency: ["The frequency field is required."],
      timeout: ["The timeout field must be at least 60."],
    });
    expect((await call("POST", "svc1/scheduled-tasks", { name: "a", command: "b", frequency: "every second", container: "umami" })).body.error).toMatchObject({ message: "Invalid Cron / Human expression." });
    expect(error(await call("POST", "svc1/scheduled-tasks", { name: "a", command: "b", frequency: "daily", container: "" })).message).toBe("Property [$subServiceName] not found on component: [project.shared.scheduled-task.add]");
    expect(db.tasks).toEqual([]);

    const added = await call("POST", "svc1/scheduled-tasks", { name: "Vacuum", command: "vacuumdb -a", frequency: "daily", container: "postgresql", timeout: 300, useShell: true });
    expect(added.status).toBe(201);
    expect(data<Body>(added)).toMatchObject({ message: "Scheduled task added.", tasks: [{ name: "Vacuum", container: "postgresql", frequency: "daily", enabled: true, status: null }], task: { command: "vacuumdb -a" } });
    expect(db.tasks.map((t) => [t.service_id, t.name])).toEqual([[7, "Vacuum"]]);
  });

  it("shows, edits, toggles and deletes a task; Execute now needs the SSH executor", async () => {
    const { call, db } = setup();
    await call("POST", "svc1/scheduled-tasks", { name: "Vacuum", command: "vacuumdb -a", frequency: "daily", container: "postgresql" });
    const task = db.tasks[0]!.uuid;
    const shown = await call("GET", `svc1/scheduled-tasks/${task}`);
    expect(data<Body>(shown)).toMatchObject({ task: { uuid: task, name: "Vacuum", command: "vacuumdb -a", isEnabled: true }, executions: [] });
    expect(data<Body>(await call("PATCH", `svc1/scheduled-tasks/${task}`, { name: " Nightly ", command: "vacuumdb -a", frequency: "0 3 * * *", container: "postgresql", timeout: 600 }))).toMatchObject({ message: "Scheduled task updated.", task: { name: "Nightly", timeout: 600 } });
    expect(data<Body>(await call("POST", `svc1/scheduled-tasks/${task}/toggle`))).toMatchObject({ message: "Scheduled task disabled.", task: { isEnabled: false } });
    const execute = await call("POST", `svc1/scheduled-tasks/${task}/execute`);
    expect([execute.status, error(execute).message]).toEqual([501, "Running the scheduled task now needs the SSH executor, which is not available yet."]);
    expect(data<Body>(await call("DELETE", `svc1/scheduled-tasks/${task}`))).toMatchObject({ message: "Scheduled task deleted.", tasks: [] });
    expect((await call("GET", `svc1/scheduled-tasks/${task}`)).status).toBe(404);
  });

  it("hides a task's command from who may only read, refuses their writes with a 404, and a denial reads nothing", async () => {
    const owner = setup();
    await owner.call("POST", "svc1/scheduled-tasks", { name: "Vacuum", command: "vacuumdb -a", frequency: "daily", container: "postgresql" });
    const task = owner.db.tasks[0]!;
    const reader = setup({ write: false });
    reader.db.tasks.push(task);
    expect(data<Body>(await reader.call("GET", `svc1/scheduled-tasks/${task.uuid}`))).toMatchObject({ task: { command: "Hidden (only admins can view)" }, canUpdate: false });
    expect((await reader.call("POST", "svc1/scheduled-tasks", { name: "x", command: "y", frequency: "daily", container: "umami" })).status).toBe(404);
    expect((await reader.call("DELETE", `svc1/scheduled-tasks/${task.uuid}`)).status).toBe(404);
    expect(reader.db.tasks).toHaveLength(1);
    expect((await setup({ read: false, write: false }).call("GET", "svc1/scheduled-tasks")).status).toBe(404);
    expect((await owner.call("GET", "other/scheduled-tasks")).status).toBe(404);
    expect((await owner.call("PUT", "svc1/scheduled-tasks", {})).status).toBe(405);
  });
});

describe("a service's Webhooks and Resource Operations", () => {
  it("the deploy webhook is the service's", async () => {
    const { call } = setup();
    const r = await call("GET", "svc1/webhooks");
    expect([r.status, data<Body>(r).deployWebhookPath, (data<Body>(r).service as Body).uuid]).toEqual([200, "/api/v1/deploy?uuid=svc1&force=false", "svc1"]);
    expect((await call("POST", "svc1/webhooks", {})).status).toBe(405);
  });

  it("Resource Operations lists where it can go for who may update, and only the frame for who may read", async () => {
    const { call } = setup();
    expect(data<Body>(await call("GET", "svc1/resource-operations"))).toMatchObject({ service: { uuid: "svc1" }, projects: [], servers: [], buildServers: [], canUpdate: true });
    const reader = setup({ write: false });
    expect(data<Body>(await reader.call("GET", "svc1/resource-operations"))).toMatchObject({ projects: [], canUpdate: false });
  });

  it("Move changes the service's environment, with moveTo()'s field error for an unknown one", async () => {
    const { call, db } = setup();
    const refused = await call("POST", "svc1/resource-operations/move", { environment_uuid: "nope" });
    expect([refused.status, error(refused).details?.fields]).toEqual([422, { environment_id: ["Environment not found."] }]);
    const moved = await call("POST", "svc1/resource-operations/move", { environment_uuid: "env2" });
    expect([moved.status, data<Body>(moved)]).toEqual([200, { projectUuid: "prj2", environmentUuid: "env2", serviceUuid: "svc1" }]);
    expect(db.moves).toEqual([[7, 11]]);
    expect((await setup({ write: false }).call("POST", "svc1/resource-operations/move", { environment_uuid: "env2" })).status).toBe(404);
  });

  it("Clone answers cloneTo()'s checks, then replicates the service onto the destination in the chosen environment", async () => {
    const { call, db, replicas } = setup();
    const noEnvironment = await call("POST", "svc1/resource-operations/clone", { environment_uuid: "nope", destination_uuid: "dst1" });
    expect(error(noEnvironment).details?.fields).toEqual({ environment_id: ["Environment not found."] });
    for (const destination of [undefined, "", "nope", "dst-build"]) {
      const r = await call("POST", "svc1/resource-operations/clone", { destination_uuid: destination });
      expect([destination, r.status, error(r).details?.fields]).toEqual([destination, 422, { destination_id: ["Destination not found."] }]);
    }
    expect(replicas).toEqual([]);
    // clone_service() with the environment (DP-108): the replica's uuid, clone_resource_name(), the destination's server.
    // The memory store keeps no replica, so the clone is the service-clone.test.ts's (PGlite) and this answers 404.
    const r = await call("POST", "svc1/resource-operations/clone", { destination_uuid: "dst1", environment_uuid: "env2", cloneVolumeData: false });
    expect(r.status).toBe(404);
    expect(replicas).toEqual([[7, { uuid: "new1", name: expect.stringMatching(/-clone-new1$/), environmentId: 11, destinationId: 200, destinationType: "standalone", serverId: 100 }]]);
    expect(db.moves).toEqual([]);
    expect((await call("POST", "other/resource-operations/clone", { destination_uuid: "dst1" })).status).toBe(404);
  });

  it("these pages are routes of the handler", () => {
    for (const page of ["webhooks", "scheduled-tasks", "resource-operations"]) expect(isServiceConfigurationRoute(["svc1", page])).toBe(true);
    expect(isServiceConfigurationRoute(["svc1", "domains"])).toBe(false);
  });
});
