// An application's Persistent Storage, Tags, Resource Operations and Danger
// Zone pages (DP-55): Coolify's rules and messages word for word, what each
// action stores (and in which order with what it would run on the server),
// what a clone copies and under which names, when an application can be
// deleted, and the handler's routing and authorization. The SQL behind the
// store (and its row-level security) is tested in tests/db.
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { handleApplications } from "@deploy-core-worker/handlers/applications";
import { handleApplicationResources, isApplicationResourceRoute, type ApplicationResourcesRunner } from "@deploy-core-worker/handlers/application-resources";
import type { ApplicationResourcesStore } from "@deploy-core-worker/applications/resources";
import {
  StoragePathError,
  confineFileMountPath,
  isOutsideResourceDirectory,
  normalizeUnixPath,
  resolveHostPath,
  resolvedFsPath,
  validateFileMountPath,
  validateHostFileMountPath,
  validateShellSafePath,
} from "@deploy-core-worker/applications/storage-paths";
import { BINARY_PLACEHOLDER, TOO_LARGE_PLACEHOLDER } from "@deploy-core-worker/applications/storages";
import { stripTags, tagName } from "@deploy-core-worker/applications/tags";
import { clonedVolumeName, strLimit } from "@deploy-core-worker/applications/resource-operations";
import { deleteOptions } from "@deploy-core-worker/applications/danger";
import type {
  ApplicationReplica,
  DeployApplicationConfigurationRow,
  DeployApplicationRow,
  DeployDestinationRow,
  DeployFileVolumeRow,
  DeployPersistentVolumeRow,
  DeployServerRow,
  FileVolumeChanges,
  PersistentVolumeChanges,
} from "@saas/db/deploy";
import { DEPLOY_UNIQUE_INDEXES } from "@saas/db/deploy";
import { DUPLICATE_ENTRY, refusedBy } from "./unique-violation.js";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const WORKDIR = "/data/coolify/applications/app1";
const UNAVAILABLE = (what: string) => `${what} needs the SSH executor, which is not available yet.`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

type Id = string | number;
type Row = Record<string, unknown> & { id: number; uuid: string };

/** A Docker image application as DockerImage::submit() and the schema's defaults leave it, with where it lives. */
function application(id: number, uuid: string, over: Record<string, unknown> = {}): Row {
  return {
    id,
    uuid,
    name: `docker-image-${uuid}`,
    description: null,
    build_pack: "dockerimage",
    status: "exited",
    has_dockerfile: false,
    fqdn: `http://${uuid}.203.0.113.10.sslip.io`,
    domain_port_overrides: null,
    noindex_domains: null,
    custom_labels: null,
    restart_limit_reached: false,
    container_present: null,
    is_container_label_readonly_enabled: true,
    is_container_label_escape_enabled: true,
    environment_id: 11,
    environment_uuid: "env1",
    environment_name: "production",
    project_uuid: "prj1",
    project_name: "Shop",
    destination_id: 21,
    destination_uuid: "dst1",
    destination_name: "freeploy",
    destination_network: "coolify",
    destination_type: "App\\Models\\StandaloneDocker",
    server_id: 7,
    server_uuid: "srv1",
    server_name: "main",
    server_ip: "203.0.113.10",
    server_proxy: { type: "TRAEFIK", status: "exited" },
    server_is_reachable: false,
    server_is_usable: false,
    server_force_disabled: false,
    server_is_swarm_manager: false,
    server_is_swarm_worker: false,
    additional_servers: 0,
    ...over,
  };
}

interface Volume extends Record<string, unknown> {
  id: number;
  applicationId: Id;
  uuid: string;
  name: string;
  mount_path: string;
  host_path: string | null;
  is_preview_suffix_enabled: boolean;
  standalone_sqlite_id: number | null;
  ignores_compose_driver_options: boolean;
  backup_enabled: boolean | null;
  backup_save_s3: boolean | null;
  has_backups: boolean;
}

interface Mount extends Record<string, unknown> {
  id: number;
  applicationId: Id;
  uuid: string;
  fs_path: string;
  mount_path: string;
  content: string | null;
  is_directory: boolean;
  is_host_file: boolean;
  is_based_on_git: boolean;
  is_preview_suffix_enabled: boolean;
  variable_fs_path: string | null;
  chown: string | null;
  chmod: string | null;
  backup_enabled: boolean | null;
  backup_save_s3: boolean | null;
  has_backups: boolean;
}

const same = (a: Id, b: Id) => String(a) === String(b);

/** One org's applications with what belongs to them, in memory. */
class MemoryStore implements ApplicationResourcesStore {
  next = 100;
  rows: Row[] = [application(1, "app1")];
  volumeRows: Volume[] = [];
  mountRows: Mount[] = [];
  tagRows: Array<{ id: number; uuid: string; name: string }> = [];
  pivots: Array<{ tagId: Id; applicationId: Id }> = [];
  tasks: Array<{ id: number; uuid: string; applicationId: Id; name: string }> = [];
  variables: Array<{ id: number; uuid: string; applicationId: Id; key: string; value: string; is_preview: boolean }> = [];
  deployments: Id[] = [];
  environments = [
    { id: 11, uuid: "env1", name: "production", project_id: 1, project_uuid: "prj1", project_name: "Shop" },
    { id: 12, uuid: "env2", name: "staging", project_id: 1, project_uuid: "prj1", project_name: "Shop" },
    { id: 13, uuid: "env3", name: "production", project_id: 2, project_uuid: "prj2", project_name: "archive" },
  ];
  emptyProjects = [{ project_id: 3, project_uuid: "prj3", project_name: "Blank" }];
  servers: Array<Record<string, unknown> & { id: number; uuid: string }> = [
    { id: 7, uuid: "srv1", name: "main", ip: "203.0.113.10", proxy: { type: "TRAEFIK" }, wildcard_domain: null, is_reachable: false, is_usable: false, force_disabled: false, is_build_server: false, server_role: "both" },
    { id: 8, uuid: "srv2", name: "edge", ip: "203.0.113.20", proxy: { type: "TRAEFIK" }, wildcard_domain: "https://apps.example.com", is_reachable: true, is_usable: true, force_disabled: false, is_build_server: false, server_role: "deployment" },
    { id: 9, uuid: "srv3", name: "builder", ip: "203.0.113.30", proxy: { type: "NONE" }, wildcard_domain: null, is_reachable: true, is_usable: true, force_disabled: false, is_build_server: true, server_role: "build" },
  ];
  destinations = [
    { id: 21, uuid: "dst1", name: "freeploy", network: "coolify", type: "standalone" as const, server_id: 7 },
    { id: 22, uuid: "dst2", name: "edge-net", network: "edge", type: "standalone" as const, server_id: 8 },
    { id: 23, uuid: "swm2", name: "overlay", network: "overlay", type: "swarm" as const, server_id: 8 },
    { id: 24, uuid: "dst3", name: "build-net", network: "build", type: "standalone" as const, server_id: 9 },
  ];
  replicas: ApplicationReplica[] = [];
  deleted: Id[] = [];

  get app(): Row {
    return this.rows[0]!;
  }
  byUuid(uuid: string): Row {
    return this.rows.find((r) => r.uuid === uuid)!;
  }
  async findByUuid(uuid: string) {
    return (this.rows.find((r) => r.uuid === uuid) as unknown as DeployApplicationRow | undefined) ?? null;
  }
  async configuration(uuid: string) {
    const row = this.rows.find((r) => r.uuid === uuid);
    return row ? ({ ...row } as unknown as DeployApplicationConfigurationRow) : null;
  }

  async volumes(applicationId: Id) {
    return this.volumeRows.filter((v) => same(v.applicationId, applicationId)) as unknown as DeployPersistentVolumeRow[];
  }
  async findVolume(applicationId: Id, id: Id) {
    return (this.volumeRows.find((v) => same(v.applicationId, applicationId) && same(v.id, id)) as unknown as DeployPersistentVolumeRow | undefined) ?? null;
  }
  async insertVolume(v: { applicationId: Id; uuid: string; name: string; mountPath: string }) {
    const row: Volume = {
      id: this.next++, applicationId: v.applicationId, uuid: v.uuid, name: v.name, mount_path: v.mountPath, host_path: null, is_preview_suffix_enabled: true,
      standalone_sqlite_id: null, ignores_compose_driver_options: false, backup_enabled: null, backup_save_s3: null, has_backups: false,
    };
    this.volumeRows.push(row);
    return row as unknown as DeployPersistentVolumeRow;
  }
  async updateVolume(applicationId: Id, id: Id, changes: PersistentVolumeChanges) {
    const row = this.volumeRows.find((v) => same(v.applicationId, applicationId) && same(v.id, id));
    if (row) Object.assign(row, changes);
    return Boolean(row);
  }
  async deleteVolume(applicationId: Id, id: Id) {
    const before = this.volumeRows.length;
    this.volumeRows = this.volumeRows.filter((v) => !(same(v.applicationId, applicationId) && same(v.id, id)));
    return this.volumeRows.length < before;
  }
  async files(applicationId: Id) {
    return this.mountRows.filter((f) => same(f.applicationId, applicationId)) as unknown as DeployFileVolumeRow[];
  }
  async findFile(applicationId: Id, id: Id) {
    return (this.mountRows.find((f) => same(f.applicationId, applicationId) && same(f.id, id)) as unknown as DeployFileVolumeRow | undefined) ?? null;
  }
  async insertFile(f: { applicationId: Id; uuid: string; fsPath: string; mountPath: string; content: string | null; isDirectory: boolean; isHostFile: boolean }) {
    const row: Mount = {
      id: this.next++, applicationId: f.applicationId, uuid: f.uuid, fs_path: f.fsPath, mount_path: f.mountPath, content: f.content, is_directory: f.isDirectory, is_host_file: f.isHostFile,
      is_based_on_git: false, is_preview_suffix_enabled: true, variable_fs_path: null, chown: null, chmod: null, backup_enabled: null, backup_save_s3: null, has_backups: false,
    };
    this.mountRows.push(row);
    return row as unknown as DeployFileVolumeRow;
  }
  async updateFile(applicationId: Id, id: Id, changes: FileVolumeChanges) {
    const row = this.mountRows.find((f) => same(f.applicationId, applicationId) && same(f.id, id));
    if (row) Object.assign(row, changes);
    return Boolean(row);
  }
  async deleteFile(applicationId: Id, id: Id) {
    const before = this.mountRows.length;
    this.mountRows = this.mountRows.filter((f) => !(same(f.applicationId, applicationId) && same(f.id, id)));
    return this.mountRows.length < before;
  }

  async tags() {
    return [...this.tagRows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  async applicationTags(applicationId: Id) {
    return this.tagRows.filter((t) => this.pivots.some((p) => same(p.tagId, t.id) && same(p.applicationId, applicationId)));
  }
  async findTagByName(name: string) {
    return this.tagRows.find((t) => t.name === name) ?? null;
  }
  async findTagById(id: Id) {
    return this.tagRows.find((t) => same(t.id, id)) ?? null;
  }
  async insertTag(tag: { uuid: string; name: string }) {
    if (this.tagRows.some((t) => t.name === tag.name)) throw new Error("duplicate key value violates unique constraint tags_org_id_name_unique");
    const row = { id: this.next++, ...tag };
    this.tagRows.push(row);
    return row;
  }
  async hasTag(applicationId: Id, tagId: Id) {
    return this.pivots.some((p) => same(p.tagId, tagId) && same(p.applicationId, applicationId));
  }
  async attachTag(applicationId: Id, tagId: Id) {
    this.pivots.push({ tagId, applicationId });
  }
  async detachTag(applicationId: Id, tagId: Id) {
    const before = this.pivots.length;
    this.pivots = this.pivots.filter((p) => !(same(p.tagId, tagId) && same(p.applicationId, applicationId)));
    return this.pivots.length < before;
  }

  async operationEnvironments() {
    const rows = [
      ...this.environments.map((e) => ({ project_id: e.project_id, project_uuid: e.project_uuid, project_name: e.project_name, environment_id: e.id as Id | null, environment_uuid: e.uuid as string | null, environment_name: e.name as string | null })),
      ...this.emptyProjects.map((p) => ({ ...p, environment_id: null, environment_uuid: null, environment_name: null })),
    ];
    // ORDER BY LOWER(p.name), p.id, e.id
    return rows.sort((a, b) => a.project_name.toLowerCase().localeCompare(b.project_name.toLowerCase()) || a.project_id - b.project_id || Number(a.environment_id) - Number(b.environment_id));
  }
  async operationServers() {
    return this.servers as never;
  }
  async operationDestinations() {
    return this.destinations as never;
  }
  async findEnvironment(uuid: string) {
    return this.environments.find((e) => e.uuid === uuid) ?? null;
  }
  async findDestination(uuid: string) {
    const d = this.destinations.find((x) => x.uuid === uuid);
    if (!d) return null;
    const s = this.servers.find((x) => x.id === d.server_id)!;
    return { ...d, server_uuid: s.uuid, server_name: s.name, server_ip: s.ip } as unknown as DeployDestinationRow;
  }
  async findServer(uuid: string) {
    return (this.servers.find((s) => s.uuid === uuid) as unknown as DeployServerRow | undefined) ?? null;
  }
  async move(applicationId: Id, environmentId: Id) {
    const row = this.rows.find((r) => same(r.id, applicationId));
    const environment = this.environments.find((e) => same(e.id, environmentId));
    if (!row || !environment) return false;
    Object.assign(row, { environment_id: environment.id, environment_uuid: environment.uuid, environment_name: environment.name, project_uuid: environment.project_uuid, project_name: environment.project_name });
    return true;
  }
  async replicateApplication(sourceId: Id, replica: ApplicationReplica) {
    const source = this.rows.find((r) => same(r.id, sourceId));
    if (!source) return null;
    this.replicas.push(replica);
    const environment = this.environments.find((e) => same(e.id, replica.environmentId))!;
    const destination = this.destinations.find((d) => same(d.id, replica.destinationId))!;
    const server = this.servers.find((s) => s.id === destination.server_id)!;
    const id = this.next++;
    this.rows.push({
      ...source,
      id,
      uuid: replica.uuid,
      name: replica.name,
      fqdn: replica.fqdn,
      domain_port_overrides: replica.domainPortOverrides,
      ...(replica.noindexDomains !== undefined ? { noindex_domains: replica.noindexDomains } : {}),
      ...(replica.customLabels !== undefined ? { custom_labels: replica.customLabels } : {}),
      status: "exited",
      environment_id: environment.id,
      environment_uuid: environment.uuid,
      environment_name: environment.name,
      project_uuid: environment.project_uuid,
      project_name: environment.project_name,
      destination_id: destination.id,
      destination_uuid: destination.uuid,
      destination_name: destination.name,
      destination_type: replica.destinationType === "swarm" ? "App\\Models\\SwarmDocker" : "App\\Models\\StandaloneDocker",
      server_id: server.id,
      server_uuid: server.uuid,
      server_name: server.name,
      server_ip: server.ip,
      settings_of: undefined,
    });
    return id;
  }
  async replicateSettings(sourceId: Id, applicationId: Id) {
    this.rows.find((r) => same(r.id, applicationId))!.settings_of = sourceId;
    return true;
  }
  async copyTags(sourceId: Id, applicationId: Id) {
    for (const p of this.pivots.filter((x) => same(x.applicationId, sourceId))) this.pivots.push({ tagId: p.tagId, applicationId });
  }
  async scheduledTaskIds(applicationId: Id) {
    return this.tasks.filter((t) => same(t.applicationId, applicationId)).map((t) => t.id);
  }
  async replicateScheduledTask(taskId: Id, replica: { uuid: string; applicationId: Id }) {
    this.tasks.push({ ...this.tasks.find((t) => same(t.id, taskId))!, id: this.next++, ...replica });
  }
  async replicateVolume(volumeId: Id, replica: { uuid: string; name: string; resourceId: Id }) {
    this.volumeRows.push({ ...this.volumeRows.find((v) => same(v.id, volumeId))!, id: this.next++, uuid: replica.uuid, name: replica.name, applicationId: replica.resourceId, standalone_sqlite_id: null, ignores_compose_driver_options: false });
  }
  async replicateFile(fileId: Id, replica: { uuid: string; resourceId: Id }) {
    this.mountRows.push({ ...this.mountRows.find((f) => same(f.id, fileId))!, id: this.next++, uuid: replica.uuid, applicationId: replica.resourceId });
  }
  async environmentVariableIds(applicationId: Id) {
    return this.variables.filter((v) => same(v.applicationId, applicationId)).map((v) => v.id);
  }
  async replicateEnvironmentVariable(variableId: Id, replica: { uuid: string; applicationId: Id }) {
    this.variables.push({ ...this.variables.find((v) => same(v.id, variableId))!, id: this.next++, ...replica });
  }
  async hasDeployments(applicationId: Id) {
    return this.deployments.some((d) => same(d, applicationId));
  }
  async deleteApplication(applicationId: Id) {
    this.deleted.push(applicationId);
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !same(r.id, applicationId));
    this.volumeRows = this.volumeRows.filter((v) => !same(v.applicationId, applicationId));
    this.mountRows = this.mountRows.filter((f) => !same(f.applicationId, applicationId));
    this.pivots = this.pivots.filter((p) => !same(p.applicationId, applicationId));
    return this.rows.length < before;
  }
}

interface Answer {
  status: number;
  data: Record<string, unknown>;
  error: { code: string; message: string; details: { fields?: Record<string, string[]>; description?: string; pendingRename?: Record<string, string> } };
}

const sealed = (plaintext: string) => `fp1:1:${Buffer.from(plaintext).toString("base64")}`;
const opened = (stored: string) => Buffer.from(stored.slice("fp1:1:".length), "base64").toString();

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
  /** The applications whose labels were generated again, and what the generator found stored for each. */
  const labelled: Array<{ uuid: string; settingsOf: unknown; customLabels: unknown }> = [];
  const runner: ApplicationResourcesRunner = async (_env, orgId, fn) => {
    orgs.push(orgId);
    return fn({
      store,
      content: { encrypt: async (plaintext) => sealed(plaintext), decrypt: async (stored) => opened(stored) },
      generateLabels: async (uuid) => {
        const row = store.byUuid(uuid);
        labelled.push({ uuid, settingsOf: row.settings_of, customLabels: row.custom_labels });
        row.custom_labels = `generated:${uuid}`;
      },
    });
  };
  /** path: what follows /applications/, with its query. */
  const call = async (method: string, path: string, body?: unknown): Promise<Answer> => {
    const init: RequestInit = { method };
    if (body !== undefined && method !== "GET") init.body = JSON.stringify(body);
    const segments = path.split("?")[0]!.split("/").filter(Boolean);
    const res = await handleApplicationResources(env, "req_1", actor, ORG_UUID, segments, new Request(`${BASE}/applications/${path}`, init), runner);
    const parsed = (await res.json()) as { data?: Record<string, unknown>; error?: Answer["error"] };
    return { status: res.status, data: parsed.data ?? {}, error: parsed.error ?? { code: "", message: "", details: {} } };
  };
  const get = (path: string) => call("GET", `app1/${path}`);
  const post = (path: string, body: unknown = {}) => call("POST", `app1/${path}`, body);
  const patch = (path: string, body: unknown = {}) => call("PATCH", `app1/${path}`, body);
  const del = (path: string) => call("DELETE", path === "" ? "app1" : `app1/${path}`);
  /** A refusal as [status, message or the messages by field]. */
  const refused = (r: Answer) => [r.status, r.error.details.fields ?? r.error.message];
  return { store, asked, orgs, labelled, env, call, get, post, patch, del, refused };
}

type Items = Array<Record<string, unknown>>;

// ---------------------------------------------------------------- path rules

describe("the path rules of file and directory mounts (bootstrap/helpers/shared.php, LocalFileVolume)", () => {
  const message = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      if (e instanceof StoragePathError) return e.message;
      throw e;
    }
    return "";
  };

  it("validateShellSafePath: Coolify's forbidden characters, each with its reason", () => {
    expect(validateShellSafePath("/etc/nginx/nginx.conf")).toBe("/etc/nginx/nginx.conf");
    expect(validateShellSafePath("/srv/my app/~x@1+2")).toBe("/srv/my app/~x@1+2");
    const reasons: Array<[string, string, string]> = [
      ["/a`id`", "`", "backtick (command substitution)"],
      ["/a$(id)", "$(", "command substitution"],
      ["/a${X}", "${", "variable substitution with potential command injection"],
      ["/a|b", "|", "pipe operator"],
      ["/a&b", "&", "background/AND operator"],
      ["/a;b", ";", "command separator"],
      ["/a\nb", "\n", "newline (command separator)"],
      ["/a\rb", "\r", "carriage return"],
      ["/a\tb", "\t", "tab (token separator)"],
      ["/a>b", ">", "output redirection"],
      ["/a<b", "<", "input redirection"],
    ];
    for (const [input, char, reason] of reasons) {
      expect(message(() => validateShellSafePath(input, "storage path"))).toBe(`Invalid storage path: contains forbidden character '${char}' (${reason}). Shell metacharacters are not allowed for security reasons.`);
    }
    // The first forbidden character of the list, not of the input.
    expect(message(() => validateShellSafePath("/a;b`c"))).toContain("'`' (backtick");
  });

  it("validateFileMountPath: a container path with one leading slash, no relative segments", () => {
    expect(validateFileMountPath("etc/app.conf")).toBe("/etc/app.conf");
    expect(validateFileMountPath("  //etc///app.conf ")).toBe("/etc/app.conf");
    expect(validateFileMountPath("/etc/.env")).toBe("/etc/.env");
    expect(validateFileMountPath("/a/..b/c")).toBe("/a/..b/c");
    expect(message(() => validateFileMountPath("/etc/../passwd", "file storage path"))).toBe("Invalid file storage path: relative path segments ('.' or '..') are not allowed.");
    expect(message(() => validateFileMountPath("./app.conf", "file storage path"))).toBe("Invalid file storage path: relative path segments ('.' or '..') are not allowed.");
    expect(message(() => validateFileMountPath("/a\\b", "file storage path"))).toBe("Invalid file storage path: backslash directory separators are not allowed.");
    expect(message(() => validateFileMountPath("/a\0b", "file storage path"))).toBe("Invalid file storage path: contains null byte. Null bytes are not allowed in file mount paths for security reasons.");
    expect(message(() => validateFileMountPath("/a;b"))).toBe("Invalid file mount path: contains forbidden character ';' (command separator). Shell metacharacters are not allowed for security reasons.");
  });

  it("validateHostFileMountPath: an absolute path of the host that names a file", () => {
    expect(validateHostFileMountPath(" /etc//nginx/nginx.conf ")).toBe("/etc/nginx/nginx.conf");
    expect(message(() => validateHostFileMountPath("etc/hosts", "host file source path"))).toBe("Invalid host file source path: must be an absolute path.");
    expect(message(() => validateHostFileMountPath("  ", "host file source path"))).toBe("Invalid host file source path: must be an absolute path.");
    expect(message(() => validateHostFileMountPath("/", "host file source path"))).toBe("Invalid host file source path: must point to a file, not a directory.");
    expect(message(() => validateHostFileMountPath("/etc/nginx/", "host file source path"))).toBe("Invalid host file source path: must point to a file, not a directory.");
    expect(message(() => validateHostFileMountPath("/etc/../shadow", "host file source path"))).toBe("Invalid host file source path: relative path segments ('.' or '..') are not allowed.");
    expect(message(() => validateHostFileMountPath("/a\\b", "host file source path"))).toBe("Invalid host file source path: backslash directory separators are not allowed.");
    expect(message(() => validateHostFileMountPath("/a\0b", "host file source path"))).toBe("Invalid host file source path: contains null byte.");
  });

  it("normalizeUnixPath and confineFileMountPath: lexical, and never above the base", () => {
    expect(normalizeUnixPath("/a//b/./c/../d")).toBe("/a/b/d");
    expect(normalizeUnixPath("/")).toBe("/");
    expect(normalizeUnixPath("a/../..")).toBe("..");
    expect(normalizeUnixPath("./")).toBe(".");
    expect(message(() => normalizeUnixPath("/a/../.."))).toBe("Invalid path: resolved path escapes the base directory.");
    expect(message(() => normalizeUnixPath("/a\\b"))).toBe("Invalid path: backslash directory separators are not allowed.");
    expect(confineFileMountPath(WORKDIR, "/etc/nginx/nginx.conf", "file storage path")).toBe(`${WORKDIR}/etc/nginx/nginx.conf`);
    expect(confineFileMountPath(`${WORKDIR}/`, "app.conf")).toBe(`${WORKDIR}/app.conf`);
    expect(message(() => confineFileMountPath(WORKDIR, "/../x", "file storage path"))).toBe("Invalid file storage path: relative path segments ('.' or '..') are not allowed.");
  });

  it("resolveHostPath: absolute anywhere on the host, or relative and inside the resource directory", () => {
    expect(resolveHostPath(WORKDIR, "/srv/uploads")).toBe("/srv/uploads");
    expect(resolveHostPath(WORKDIR, " config/app.conf ")).toBe(`${WORKDIR}/config/app.conf`);
    expect(resolveHostPath(WORKDIR, "./config")).toBe(`${WORKDIR}/config`);
    expect(resolveHostPath(WORKDIR, `${WORKDIR}/a/../b`)).toBe(`${WORKDIR}/b`);
    expect(resolveHostPath(WORKDIR, WORKDIR)).toBe(WORKDIR);
    expect(message(() => resolveHostPath(WORKDIR, "  ", "storage source path"))).toBe("Invalid storage source path: the path is empty.");
    expect(message(() => resolveHostPath(WORKDIR, "~/data", "storage source path"))).toBe("Invalid storage source path: use an absolute path instead of ~.");
    expect(message(() => resolveHostPath(WORKDIR, "../other", "storage source path"))).toBe("Invalid storage source path: a relative path must stay inside the resource directory.");
    expect(message(() => resolveHostPath(WORKDIR, "/srv/../etc", "storage source path"))).toBe("Invalid storage source path: '.' and '..' segments are not allowed.");
    expect(message(() => resolveHostPath(WORKDIR, "/", "storage source path"))).toBe("Invalid storage source path: the root directory cannot be mounted.");
    expect(message(() => resolveHostPath(WORKDIR, "/srv/a|b", "storage source path"))).toContain("Invalid storage source path: contains forbidden character '|'");
    // A sibling whose name starts like the resource directory is outside it.
    expect(resolveHostPath(WORKDIR, `${WORKDIR}-other/x`)).toBe(`${WORKDIR}-other/x`);
  });

  it("resolvedFsPath and isOutsideResourceDirectory: a stored relative path is inside the workdir", () => {
    expect(resolvedFsPath("./config/app.conf", WORKDIR)).toBe(`${WORKDIR}/config/app.conf`);
    expect(resolvedFsPath("config", `${WORKDIR}/`)).toBe(`${WORKDIR}/config`);
    expect(resolvedFsPath(".", WORKDIR)).toBe(WORKDIR);
    expect(resolvedFsPath("/srv/x", WORKDIR)).toBe("/srv/x");
    expect(resolvedFsPath("~/x", WORKDIR)).toBe("~/x");
    expect(isOutsideResourceDirectory(`${WORKDIR}/etc/app.conf`, WORKDIR)).toBe(false);
    expect(isOutsideResourceDirectory("./etc/app.conf", WORKDIR)).toBe(false);
    expect(isOutsideResourceDirectory("/srv/uploads", WORKDIR)).toBe(true);
    expect(isOutsideResourceDirectory(`${WORKDIR}-other/x`, WORKDIR)).toBe(true);
    expect(isOutsideResourceDirectory("~/x", WORKDIR)).toBe(true);
    // A path that cannot be resolved counts as outside.
    expect(isOutsideResourceDirectory("/a/../../b", WORKDIR)).toBe(true);
    expect(isOutsideResourceDirectory("/srv/a;b", WORKDIR)).toBe(true);
  });
});

// ---------------------------------------------------------------- Persistent Storage: volumes

describe("the Persistent Storage page: volume mounts (Storage, Storages\\All)", () => {
  it("reads an application without storage: the host path, the default volume name, no mounts", async () => {
    const t = setup();
    const r = await t.get("storages");
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({
      canUpdate: true,
      canDeploy: true,
      isSwarm: false,
      gitBased: false,
      hostPath: WORKDIR,
      defaultVolumeName: "docker-image-app1-data",
      volumeUnavailableReason: null,
      volumes: [],
      files: [],
      directories: [],
    });
    expect((r.data.application as { uuid: string }).uuid).toBe("app1");
    // generateDefaultVolumeName(): the slug of the name, or "volume".
    t.store.app.name = "Shop API (v2)";
    expect((await t.get("storages")).data.defaultVolumeName).toBe("shop-api-v2-data");
    t.store.app.name = "###";
    expect((await t.get("storages")).data.defaultVolumeName).toBe("volume-data");
    // git_based(): not a Docker image application, and no Dockerfile of its own.
    t.store.app.build_pack = "nixpacks";
    expect((await t.get("storages")).data.gitBased).toBe(true);
    t.store.app.has_dockerfile = true;
    expect((await t.get("storages")).data.gitBased).toBe(false);
  });

  it("adds a volume under the application's uuid; the mount path is trimmed and gets its leading slash", async () => {
    const t = setup();
    const r = await t.post("storages", { type: "volume", name: "data", mount_path: " var/lib/data " });
    expect(r.status).toBe(201);
    expect(r.data.message).toBe("Volume added successfully");
    expect(r.data.unavailable).toBeUndefined();
    expect(r.data.volumes).toEqual([
      { id: String(t.store.volumeRows[0]!.id), name: "app1-data", mountPath: "/var/lib/data", hostPath: null, isPreviewSuffixEnabled: true, isReadOnly: false, isShared: false, backup: { enabled: false, s3: false } },
    ]);
    expect(t.store.volumeRows[0]).toMatchObject({ applicationId: 1, name: "app1-data", mount_path: "/var/lib/data", host_path: null });
    expect(t.store.volumeRows[0]!.uuid).toMatch(/^[a-z0-9]{24}$/);
    await t.post("storages", { type: "volume", name: "cache.v1_x", mount_path: "///cache" });
    expect(t.store.volumeRows.map((v) => [v.name, v.mount_path])).toEqual([
      ["app1-data", "/var/lib/data"],
      ["app1-cache.v1_x", "/cache"],
    ]);
  });

  it("answers the volume form's rules with Laravel's and Coolify's messages, and stores nothing", async () => {
    const t = setup();
    const add = async (body: Record<string, unknown>) => t.refused(await t.post("storages", { type: "volume", ...body }));
    const REGEX = "The volume name must start with an alphanumeric character and contain only alphanumeric characters, dots, hyphens, and underscores.";
    expect(await add({})).toEqual([422, { name: ["The name field is required."], mount_path: ["The mount path field is required."] }]);
    expect(await add({ name: "  ", mount_path: "/data" })).toEqual([422, { name: ["The name field is required."] }]);
    expect(await add({ name: ["a"], mount_path: { a: 1 } })).toEqual([422, { name: ["The name field must be a string."], mount_path: ["The mount path field must be a string."] }]);
    for (const bad of ["-data", ".data", "my data", "data/1", "data;rm", "dätä", "$(id)"]) expect([bad, await add({ name: bad, mount_path: "/data" })]).toEqual([bad, [422, { name: [REGEX] }]]);
    expect(await add({ name: "a".repeat(256), mount_path: "/data" })).toEqual([422, { name: ["The name field must not be greater than 255 characters."] }]);
    expect(await add({ name: `-${"a".repeat(256)}`, mount_path: "/data" })).toEqual([422, { name: ["The name field must not be greater than 255 characters.", REGEX] }]);
    for (const good of ["data", "Data_1.cache-2", "0", 7]) expect([good, (await t.post("storages", { type: "volume", name: good, mount_path: "/d" })).status]).toEqual([good, 201]);
    expect(t.store.volumeRows.map((v) => v.name)).toEqual(["app1-data", "app1-Data_1.cache-2", "app1-0", "app1-7"]);
    expect(t.refused(await t.post("storages", { type: "bucket" }))).toEqual([422, { type: ["The selected type is invalid."] }]);
    expect(t.refused(await t.post("storages", {}))).toEqual([422, { type: ["The selected type is invalid."] }]);
  });

  it("refuses a second volume of the same name, as Coolify's unique index does", async () => {
    const t = setup();
    const DUPLICATE = "Duplicate entry found. Please use a different name.";
    await t.post("storages", { type: "volume", name: "data", mount_path: "/data" });
    expect(t.refused(await t.post("storages", { type: "volume", name: "data", mount_path: "/other" }))).toEqual([422, DUPLICATE]);
    // The name is compared as stored: exactly.
    expect((await t.post("storages", { type: "volume", name: "Data", mount_path: "/other" })).status).toBe(201);
    const [data, upper] = t.store.volumeRows;
    expect(t.store.volumeRows.map((v) => v.name)).toEqual(["app1-data", "app1-Data"]);
    // A rename onto another volume's name: asked first, refused at the save.
    expect((await t.patch(`storages/volumes/${upper!.id}`, { name: "app1-data" })).status).toBe(409);
    expect(t.refused(await t.patch(`storages/volumes/${upper!.id}`, { name: "app1-data", renameConfirmed: true }))).toEqual([422, DUPLICATE]);
    expect(upper!.name).toBe("app1-Data");
    // Another application's volume of that name is no duplicate.
    t.store.rows.push(application(2, "app2"));
    t.store.volumeRows.push({ ...data!, id: 900, applicationId: 2, name: "app1-other" });
    expect((await t.post("storages", { type: "volume", name: "other", mount_path: "/other" })).status).toBe(201);
  });

  it("an application on several servers cannot have a volume (persistentStorageUnavailableReason)", async () => {
    const t = setup();
    t.store.app.additional_servers = "1";
    const REASON = "Applications that use multiple servers cannot have persistent storage because volumes are not shared between servers.";
    expect((await t.get("storages")).data.volumeUnavailableReason).toBe(REASON);
    const r = await t.post("storages", { type: "volume", name: "data", mount_path: "/data" });
    expect([r.status, r.error.message, r.error.details.description]).toEqual([422, "Failed to add volume.", REASON]);
    // The form's rules come first.
    expect(t.refused(await t.post("storages", { type: "volume", name: "", mount_path: "/data" }))).toEqual([422, { name: ["The name field is required."] }]);
    expect(t.store.volumeRows).toEqual([]);
  });

  it("updates a volume's mount path and PR suffix; a new name waits for its confirmation", async () => {
    const t = setup();
    await t.post("storages", { type: "volume", name: "data", mount_path: "/data" });
    const id = t.store.volumeRows[0]!.id;
    const saved = await t.patch(`storages/volumes/${id}`, { mountPath: "/var/data", isPreviewSuffixEnabled: false });
    expect([saved.status, saved.data.message]).toEqual([200, "Storage updated successfully"]);
    expect(t.store.volumeRows[0]).toMatchObject({ name: "app1-data", mount_path: "/var/data", is_preview_suffix_enabled: false });
    expect((saved.data.volumes as Items)[0]).toMatchObject({ mountPath: "/var/data", isPreviewSuffixEnabled: false });
    // What the body leaves out stays.
    await t.patch(`storages/volumes/${id}`, { isPreviewSuffixEnabled: "1" });
    expect(t.store.volumeRows[0]).toMatchObject({ name: "app1-data", mount_path: "/var/data", is_preview_suffix_enabled: true });

    // A new name mounts another Docker volume: 409 with the two names, nothing stored.
    const pending = await t.patch(`storages/volumes/${id}`, { name: "app1-archive", mountPath: "/archive" });
    expect([pending.status, pending.error.code, pending.error.details.pendingRename]).toEqual([409, "conflict", { storageId: String(id), from: "app1-data", to: "app1-archive" }]);
    expect(t.store.volumeRows[0]).toMatchObject({ name: "app1-data", mount_path: "/var/data" });
    const renamed = await t.patch(`storages/volumes/${id}`, { name: "app1-archive", mountPath: "/archive", renameConfirmed: true });
    expect(renamed.status).toBe(200);
    expect(t.store.volumeRows[0]).toMatchObject({ name: "app1-archive", mount_path: "/archive" });
    // The same name is no rename.
    expect((await t.patch(`storages/volumes/${id}`, { name: "app1-archive" })).status).toBe(200);
  });

  it("answers the volume row's rules: the name, a safe mount path, the switch", async () => {
    const t = setup();
    await t.post("storages", { type: "volume", name: "data", mount_path: "/data" });
    const id = t.store.volumeRows[0]!.id;
    const edit = async (body: Record<string, unknown>) => t.refused(await t.patch(`storages/volumes/${id}`, body));
    expect(await edit({ name: "", mountPath: "" })).toEqual([422, { name: ["The name field is required."], mountPath: ["The mount field is required."] }]);
    expect(await edit({ name: "bad name" })).toEqual([
      422,
      { name: ["The volume name must start with an alphanumeric character and contain only alphanumeric characters, dots, hyphens, and underscores."] },
    ]);
    for (const bad of ["data", "/my data", "/a;b", "/a$b", "/data\\x"]) expect([bad, await edit({ mountPath: bad })]).toEqual([bad, [422, { mountPath: ["Mount path must start with / and only contain safe path characters."] }]]);
    for (const good of ["/", "/var/lib/data", "/a.b_c-d/~e@f+g"]) expect([good, (await t.patch(`storages/volumes/${id}`, { mountPath: good })).status]).toEqual([good, 200]);
    expect(await edit({ isPreviewSuffixEnabled: "maybe" })).toEqual([422, { isPreviewSuffixEnabled: [`The forms.${id}.is preview suffix enabled field must be true or false.`] }]);
    expect(t.store.volumeRows[0]).toMatchObject({ name: "app1-data", mount_path: "/a.b_c-d/~e@f+g" });
    // A volume that is not this application's, or not a row id, is not found.
    expect((await t.patch("storages/volumes/999", { mountPath: "/x" })).status).toBe(404);
    expect((await t.patch("storages/volumes/abc", { mountPath: "/x" })).status).toBe(404);
    expect((await t.patch("storages/volumes/0", { mountPath: "/x" })).status).toBe(404);
  });

  it("a Docker Compose application's volumes are read-only; a SQLite database's volume keeps its name", async () => {
    const t = setup();
    await t.post("storages", { type: "volume", name: "data", mount_path: "/data" });
    const volume = t.store.volumeRows[0]!;
    volume.standalone_sqlite_id = 5;
    expect(((await t.get("storages")).data.volumes as Items)[0]).toMatchObject({ isShared: true, isReadOnly: false });
    // A shared volume is never renamed: the other fields are saved, the name is not.
    const saved = await t.patch(`storages/volumes/${volume.id}`, { name: "app1-other", mountPath: "/db" });
    expect(saved.status).toBe(200);
    expect(volume).toMatchObject({ name: "app1-data", mount_path: "/db" });
    expect(t.refused(await t.del(`storages/volumes/${volume.id}`))).toEqual([422, "This volume is connected to a SQLite database. Unlink it on the SQLite database page."]);

    volume.standalone_sqlite_id = null;
    t.store.app.build_pack = "dockercompose";
    expect(((await t.get("storages")).data.volumes as Items)[0]).toMatchObject({ isReadOnly: true });
    expect(t.refused(await t.patch(`storages/volumes/${volume.id}`, { mountPath: "/x" }))).toEqual([422, "This volume is read-only."]);
    expect(t.refused(await t.del(`storages/volumes/${volume.id}`))).toEqual([422, "This volume is managed by the current Docker Compose file."]);
    expect(t.store.volumeRows).toHaveLength(1);
  });

  it("deletes a volume's row; a backup schedule keeps it, and deleting the Docker volume needs the server", async () => {
    const t = setup();
    await t.post("storages", { type: "volume", name: "data", mount_path: "/data" });
    await t.post("storages", { type: "volume", name: "cache", mount_path: "/cache" });
    const [data, cache] = t.store.volumeRows;
    Object.assign(data!, { has_backups: true, backup_enabled: true, backup_save_s3: true });
    expect(((await t.get("storages")).data.volumes as Items)[0]).toMatchObject({ backup: { enabled: true, s3: true } });
    expect(t.refused(await t.del(`storages/volumes/${data!.id}`))).toEqual([422, "Delete this volume backup schedule and its archives before deleting the volume."]);
    // A disabled schedule shows no badge and still keeps the volume.
    Object.assign(data!, { backup_enabled: false });
    expect(((await t.get("storages")).data.volumes as Items)[0]).toMatchObject({ backup: { enabled: false, s3: false } });
    expect((await t.del(`storages/volumes/${data!.id}`)).status).toBe(422);

    const withVolume = await t.del(`storages/volumes/${cache!.id}?deleteDockerVolume=true`);
    expect([withVolume.status, withVolume.error.code, withVolume.error.message]).toEqual([501, "unsupported", UNAVAILABLE("Deleting the Docker volume on the server")]);
    expect(t.store.volumeRows).toHaveLength(2);
    const gone = await t.del(`storages/volumes/${cache!.id}`);
    expect([gone.status, gone.data.message, (gone.data.volumes as Items).map((v) => v.name)]).toEqual([200, null, ["app1-data"]]);
    expect((await t.del(`storages/volumes/${cache!.id}`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------- Persistent Storage: files and directories

describe("the Persistent Storage page: file, host file and directory mounts (Storage, FileStorage, LocalFileVolume)", () => {
  it("adds a managed file: the row with its encrypted content, in the application's directory; the write is not available yet", async () => {
    const t = setup();
    const r = await t.post("storages", { type: "file", file_storage_path: "etc//nginx/nginx.conf", file_storage_content: "server { listen 80; }\n" });
    expect(r.status).toBe(201);
    expect(r.data.message).toBe("File mount added successfully");
    expect(r.data.unavailable).toBe(UNAVAILABLE("Writing the file to the server"));
    const row = t.store.mountRows[0]!;
    expect(row).toMatchObject({ applicationId: 1, fs_path: `${WORKDIR}/etc/nginx/nginx.conf`, mount_path: "/etc/nginx/nginx.conf", is_directory: false, is_host_file: false });
    // Stored encrypted (the `encrypted` cast), read back decrypted.
    expect(row.content).toBe(sealed("server { listen 80; }\n"));
    expect(row.content).not.toContain("listen");
    expect(r.data.files).toEqual([
      {
        id: String(row.id), fsPath: `${WORKDIR}/etc/nginx/nginx.conf`, mountPath: "/etc/nginx/nginx.conf", isDirectory: false, isHostFile: false, isBasedOnGit: false, isPreviewSuffixEnabled: true,
        content: "server { listen 80; }\n", isBinary: false, isTooLarge: false, canDeleteFromServer: true, hasEnabledBackup: false,
      },
    ]);
    expect(r.data.directories).toEqual([]);
    // Without content the row has none.
    await t.post("storages", { type: "file", file_storage_path: "/empty.txt", file_storage_content: "" });
    expect(t.store.mountRows[1]).toMatchObject({ fs_path: `${WORKDIR}/empty.txt`, content: null });
  });

  it("answers the file form's rules and path errors; a source path is checked on the server first", async () => {
    const t = setup();
    const add = async (body: Record<string, unknown>) => t.refused(await t.post("storages", { type: "file", ...body }));
    expect(await add({})).toEqual([422, { file_storage_path: ["The file storage path field is required."] }]);
    expect(await add({ file_storage_path: 5, file_storage_source: ["x"], file_storage_content: { a: 1 } })).toEqual([
      422,
      { file_storage_source: ["The file storage source field must be a string."], file_storage_content: ["The file storage content field must be a string."] },
    ]);
    expect(await add({ file_storage_path: "/etc/../passwd" })).toEqual([422, "Invalid file storage path: relative path segments ('.' or '..') are not allowed."]);
    expect(await add({ file_storage_path: "/etc/a;b" })).toEqual([422, "Invalid file storage path: contains forbidden character ';' (command separator). Shell metacharacters are not allowed for security reasons."]);
    expect(await add({ file_storage_path: "/app.conf", file_storage_source: "~/app.conf" })).toEqual([422, "Invalid file storage source path: use an absolute path instead of ~."]);
    expect(await add({ file_storage_path: "/app.conf", file_storage_source: "../app.conf" })).toEqual([422, "Invalid file storage source path: a relative path must stay inside the resource directory."]);
    // assertHostPathOnServer(): inside the resource directory a confinement check, outside it a symlink check.
    for (const source of ["/srv/config/app.conf", "config/app.conf"]) {
      const r = await t.post("storages", { type: "file", file_storage_path: "/app.conf", file_storage_source: source });
      expect([source, r.status, r.error.code, r.error.message]).toEqual([source, 501, "unsupported", UNAVAILABLE("Checking the path on the server")]);
    }
    expect(t.store.mountRows).toEqual([]);
  });

  it("adds a host file mount: a row only, never written or deleted on the server", async () => {
    const t = setup();
    const r = await t.post("storages", { type: "host-file", host_file_storage_source: " /etc//nginx/nginx.conf ", host_file_storage_destination: "etc/nginx/nginx.conf" });
    expect([r.status, r.data.message, r.data.unavailable]).toEqual([201, "Host file mount added successfully", undefined]);
    expect(t.store.mountRows[0]).toMatchObject({ fs_path: "/etc/nginx/nginx.conf", mount_path: "/etc/nginx/nginx.conf", content: null, is_directory: false, is_host_file: true });
    expect((r.data.files as Items)[0]).toMatchObject({ isHostFile: true, content: null, canDeleteFromServer: false });
    const add = async (body: Record<string, unknown>) => t.refused(await t.post("storages", { type: "host-file", ...body }));
    expect(await add({})).toEqual([
      422,
      { host_file_storage_source: ["The host file storage source field is required."], host_file_storage_destination: ["The host file storage destination field is required."] },
    ]);
    expect(await add({ host_file_storage_source: "etc/hosts", host_file_storage_destination: "/etc/hosts" })).toEqual([422, "Invalid host file source path: must be an absolute path."]);
    expect(await add({ host_file_storage_source: "/etc/", host_file_storage_destination: "/etc/hosts" })).toEqual([422, "Invalid host file source path: must point to a file, not a directory."]);
    expect(await add({ host_file_storage_source: "/etc/hosts", host_file_storage_destination: "/etc/./hosts" })).toEqual([422, "Invalid host file destination path: relative path segments ('.' or '..') are not allowed."]);
    expect(t.store.mountRows).toHaveLength(1);
  });

  it("adds a directory mount elsewhere on the host as a row; one inside the application's directory is checked on the server first", async () => {
    const t = setup();
    const r = await t.post("storages", { type: "directory", file_storage_directory_source: "/srv/uploads/", file_storage_directory_destination: "uploads" });
    expect([r.status, r.data.message, r.data.unavailable]).toEqual([201, "Directory mount added successfully", undefined]);
    expect(t.store.mountRows[0]).toMatchObject({ fs_path: "/srv/uploads", mount_path: "/uploads", content: null, is_directory: true, is_host_file: false });
    expect(r.data.files).toEqual([]);
    expect((r.data.directories as Items)[0]).toMatchObject({ fsPath: "/srv/uploads", mountPath: "/uploads", isDirectory: true, content: null, canDeleteFromServer: false });

    for (const source of [WORKDIR, `${WORKDIR}/etc/nginx`, "etc/nginx", "./data"]) {
      const inside = await t.post("storages", { type: "directory", file_storage_directory_source: source, file_storage_directory_destination: "/etc/nginx" });
      expect([source, inside.status, inside.error.message]).toEqual([source, 501, UNAVAILABLE("Checking the path on the server")]);
    }
    const add = async (body: Record<string, unknown>) => t.refused(await t.post("storages", { type: "directory", ...body }));
    expect(await add({})).toEqual([
      422,
      { file_storage_directory_source: ["The file storage directory source field is required."], file_storage_directory_destination: ["The file storage directory destination field is required."] },
    ]);
    expect(await add({ file_storage_directory_source: "/", file_storage_directory_destination: "/data" })).toEqual([422, "Invalid storage source path: the root directory cannot be mounted."]);
    expect(await add({ file_storage_directory_source: "~/data", file_storage_directory_destination: "/data" })).toEqual([422, "Invalid storage source path: use an absolute path instead of ~."]);
    expect(await add({ file_storage_directory_source: "/srv/data", file_storage_directory_destination: "/a/../b" })).toEqual([422, "Invalid storage destination path: relative path segments ('.' or '..') are not allowed."]);
    expect(t.store.mountRows).toHaveLength(1);
  });

  it("refuses a second file or directory mount at the same destination path, as Coolify's unique index does", async () => {
    const t = setup();
    const DUPLICATE = "Duplicate entry found. Please use a different name.";
    await t.post("storages", { type: "file", file_storage_path: "/etc/app.conf" });
    expect(t.refused(await t.post("storages", { type: "file", file_storage_path: "etc//app.conf" }))).toEqual([422, DUPLICATE]);
    expect(t.refused(await t.post("storages", { type: "host-file", host_file_storage_source: "/srv/app.conf", host_file_storage_destination: "/etc/app.conf" }))).toEqual([422, DUPLICATE]);
    expect(t.refused(await t.post("storages", { type: "directory", file_storage_directory_source: "/srv/etc", file_storage_directory_destination: "/etc/app.conf" }))).toEqual([422, DUPLICATE]);
    expect(t.store.mountRows).toHaveLength(1);
    // What Coolify checks on the server comes before the row, so before the index.
    expect((await t.post("storages", { type: "file", file_storage_path: "/etc/app.conf", file_storage_source: "/srv/app.conf" })).status).toBe(501);
    // A volume mounted at that path is another table.
    expect((await t.post("storages", { type: "volume", name: "conf", mount_path: "/etc/app.conf" })).status).toBe(201);
  });

  it("saving a file's content writes it on the server: 501, the row as it was; the switches alone are a row", async () => {
    const t = setup();
    await t.post("storages", { type: "file", file_storage_path: "/app.conf", file_storage_content: "a=1" });
    const row = t.store.mountRows[0]!;
    const save = await t.patch(`storages/files/${row.id}`, { action: "save", content: "a=2" });
    expect([save.status, save.error.code, save.error.message]).toEqual([501, "unsupported", UNAVAILABLE("Writing the file to the server")]);
    expect(row.content).toBe(sealed("a=1"));

    // instantSave(): syncData(true) — the content and the two switches, no server.
    const instant = await t.patch(`storages/files/${row.id}`, { action: "instantSave", isBasedOnGit: true, isPreviewSuffixEnabled: false });
    expect([instant.status, instant.data.message]).toEqual([200, "File updated."]);
    expect(row).toMatchObject({ content: sealed("a=1"), is_based_on_git: true, is_preview_suffix_enabled: false });
    await t.patch(`storages/files/${row.id}`, { action: "instantSave", content: "a=3" });
    expect(row).toMatchObject({ content: sealed("a=3"), is_based_on_git: true, is_preview_suffix_enabled: false });
    await t.patch(`storages/files/${row.id}`, { action: "instantSave", content: "", isBasedOnGit: 0 });
    expect(row).toMatchObject({ content: null, is_based_on_git: false });
    expect(t.refused(await t.patch(`storages/files/${row.id}`, { action: "instantSave", isBasedOnGit: "yes", isPreviewSuffixEnabled: 2 }))).toEqual([
      422,
      { isBasedOnGit: ["The is based on git field must be true or false."], isPreviewSuffixEnabled: ["The is preview suffix enabled field must be true or false."] },
    ]);
    expect(t.refused(await t.patch(`storages/files/${row.id}`, { action: "rename" }))).toEqual([422, { action: ["The selected action is invalid."] }]);
    expect(t.refused(await t.patch(`storages/files/${row.id}`, {}))).toEqual([422, { action: ["The selected action is invalid."] }]);
    expect((await t.patch("storages/files/999", { action: "instantSave" })).status).toBe(404);
  });

  it("converting and loading run on the server first: 501; a host file and a file too large are refused as Coolify refuses them", async () => {
    const t = setup();
    await t.post("storages", { type: "file", file_storage_path: "/app.conf", file_storage_content: "a=1" });
    await t.post("storages", { type: "host-file", host_file_storage_source: "/etc/hosts", host_file_storage_destination: "/etc/hosts" });
    await t.post("storages", { type: "directory", file_storage_directory_source: "/srv/uploads", file_storage_directory_destination: "/uploads" });
    const [file, host, directory] = t.store.mountRows;
    const act = async (row: Mount, action: string) => t.refused(await t.patch(`storages/files/${row.id}`, { action, content: "x" }));
    expect(await act(file!, "convertToDirectory")).toEqual([501, UNAVAILABLE("Converting the mount on the server")]);
    expect(await act(directory!, "convertToFile")).toEqual([501, UNAVAILABLE("Converting the mount on the server")]);
    expect(await act(file!, "loadFromServer")).toEqual([501, UNAVAILABLE("Loading the file from the server")]);
    // A directory with a backup schedule is not converted.
    directory!.has_backups = true;
    expect(await act(directory!, "convertToFile")).toEqual([422, "Delete this directory backup schedule and its archives before converting it to a file."]);

    expect(await act(host!, "save")).toEqual([422, "Host file mounts are bind-only and cannot be edited from the UI."]);
    expect(await act(host!, "instantSave")).toEqual([422, "Host file mounts are bind-only and cannot be edited from the UI."]);
    expect(await act(host!, "convertToDirectory")).toEqual([422, "Host file mounts are bind-only and cannot be converted."]);
    expect(await act(host!, "convertToFile")).toEqual([422, "Host file mounts are bind-only and cannot be converted."]);
    expect(await act(host!, "loadFromServer")).toEqual([422, "Host file mounts are bind-only and cannot be loaded from the server."]);

    file!.content = sealed(TOO_LARGE_PLACEHOLDER);
    expect(await act(file!, "save")).toEqual([422, "File on server is too large to edit from the UI."]);
    expect(await act(file!, "instantSave")).toEqual([422, "File on server is too large to edit from the UI."]);
    expect(((await t.get("storages")).data.files as Items)[0]).toMatchObject({ isTooLarge: true, isBinary: false, content: TOO_LARGE_PLACEHOLDER });
    file!.content = sealed(BINARY_PLACEHOLDER);
    expect(((await t.get("storages")).data.files as Items)[0]).toMatchObject({ isTooLarge: false, isBinary: true });
    // A stored content over 5 MB is not sent.
    file!.content = sealed("x".repeat(5_242_881));
    expect(((await t.get("storages")).data.files as Items)[0]).toMatchObject({ isTooLarge: true, content: TOO_LARGE_PLACEHOLDER });
    expect(t.store.mountRows.map((f) => [f.is_directory, f.is_host_file])).toEqual([[false, false], [false, true], [true, false]]);
  });

  it("deletes a mount's row; deleting it on the server too needs the server, and only inside the application's directory", async () => {
    const t = setup();
    await t.post("storages", { type: "file", file_storage_path: "/app.conf" });
    await t.post("storages", { type: "host-file", host_file_storage_source: "/etc/hosts", host_file_storage_destination: "/etc/hosts" });
    await t.post("storages", { type: "directory", file_storage_directory_source: "/srv/uploads", file_storage_directory_destination: "/uploads" });
    const [file, host, directory] = t.store.mountRows;

    // The dialog's checkbox ("permanently deleted from the server") is on by default.
    const onServer = await t.del(`storages/files/${file!.id}?permanently_delete=true`);
    expect([onServer.status, onServer.error.message]).toEqual([501, UNAVAILABLE("Deleting the mount from the server")]);
    expect(t.store.mountRows).toHaveLength(3);
    const row = await t.del(`storages/files/${file!.id}`);
    expect([row.status, row.data.message]).toEqual([200, "File deleted."]);

    // Outside the application's directory nothing is ever deleted on the server: the option changes nothing.
    directory!.has_backups = true;
    expect(t.refused(await t.del(`storages/files/${directory!.id}`))).toEqual([422, "Delete this directory backup schedule and its archives before deleting the directory."]);
    directory!.has_backups = false;
    const dir = await t.del(`storages/files/${directory!.id}?permanently_delete=true`);
    expect([dir.status, dir.data.message]).toEqual([200, "Directory deleted."]);
    const bound = await t.del(`storages/files/${host!.id}?permanently_delete=1`);
    expect([bound.status, bound.data.message, bound.data.files]).toEqual([200, "Host file mount removed.", []]);
    expect(t.store.mountRows).toEqual([]);
    expect((await t.del(`storages/files/${host!.id}`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------- Tags

describe("the Tags page (Tags, Tag)", () => {
  it("strip_tags and the name as the model stores it", () => {
    expect(stripTags("<b>prod</b>")).toBe("prod");
    expect(stripTags("a<script>x")).toBe("ax");
    expect(stripTags("a<b")).toBe("a");
    expect(stripTags("api")).toBe("api");
    expect(tagName("Production")).toBe("production");
    expect(tagName("<i>API</i>-V2")).toBe("api-v2");
    // strtolower(): ASCII letters only.
    expect(tagName("ÉCOLE")).toBe("École");
  });

  it("adds names separated by spaces: a new name creates the org's tag, an existing tag is attached", async () => {
    const t = setup();
    t.store.tagRows.push({ id: 1, uuid: "tag1", name: "api" }, { id: 2, uuid: "tag2", name: "zeta" });
    const empty = await t.get("tags");
    expect(empty.data).toMatchObject({ canUpdate: true, tags: [], availableTags: [{ id: "1", name: "api" }, { id: "2", name: "zeta" }] });

    const r = await t.post("tags", { newTags: " Production api customer-a " });
    expect([r.status, r.data.message, r.data.errors]).toEqual([200, null, []]);
    expect((r.data.tags as Items).map((x) => x.name).sort()).toEqual(["api", "customer-a", "production"]);
    expect(r.data.availableTags).toEqual([{ id: "2", name: "zeta" }]);
    // "api" was attached, not created again.
    expect(t.store.tagRows.map((x) => x.name)).toEqual(["api", "zeta", "production", "customer-a"]);
    expect(t.store.tagRows[2]!.uuid).toMatch(/^[a-z0-9]{24}$/);
    expect(t.store.pivots.map((p) => [p.applicationId, t.store.tagRows.find((x) => x.id === p.tagId)!.name])).toEqual([[1, "production"], [1, "api"], [1, "customer-a"]]);
  });

  it("reports a name that is too short or already attached, and adds the others", async () => {
    const t = setup();
    await t.post("tags", { newTags: "api" });
    const r = await t.post("tags", { newTags: "api x  <b>db</b> API web" });
    expect(r.status).toBe(200);
    expect(r.data.errors).toEqual([
      { title: "Duplicate tags.", description: "Tag api already added." },
      { title: "Invalid tag.", description: "Tag x is invalid. Min length is 2." },
      // Two spaces: an empty name between them.
      { title: "Invalid tag.", description: "Tag  is invalid. Min length is 2." },
      // The stored name is lower case, so "API" is "api".
      { title: "Duplicate tags.", description: "Tag API already added." },
    ]);
    expect((r.data.tags as Items).map((x) => x.name)).toEqual(["api", "db", "web"]);
    // A tag that markup alone made long enough is too short without it.
    expect((await t.post("tags", { newTags: "<b>a</b>" })).data.errors).toEqual([{ title: "Invalid tag.", description: "Tag a is invalid. Min length is 2." }]);
    // The same name twice in one go: the second is a duplicate.
    expect((await t.post("tags", { newTags: "new new" })).data.errors).toEqual([{ title: "Duplicate tags.", description: "Tag new already added." }]);
    expect(t.store.tagRows.map((x) => x.name)).toEqual(["api", "db", "web", "new"]);
  });

  it("answers the form's rule: required|string|min:2", async () => {
    const t = setup();
    expect(t.refused(await t.post("tags", {}))).toEqual([422, { newTags: ["The new tags field is required."] }]);
    expect(t.refused(await t.post("tags", { newTags: "   " }))).toEqual([422, { newTags: ["The new tags field is required."] }]);
    expect(t.refused(await t.post("tags", { newTags: ["a"] }))).toEqual([422, { newTags: ["The new tags field must be a string."] }]);
    expect(t.refused(await t.post("tags", { newTags: "a" }))).toEqual([422, { newTags: ["The new tags field must be at least 2 characters."] }]);
    expect(t.store.tagRows).toEqual([]);
  });

  it("attaches one of the org's tags by id, and detaches a tag: the tag itself stays", async () => {
    const t = setup();
    t.store.tagRows.push({ id: 1, uuid: "tag1", name: "api" }, { id: 2, uuid: "tag2", name: "web" });
    const added = await t.post("tags/2");
    expect([added.status, added.data.message, added.data.tags, added.data.availableTags]).toEqual([200, "Tag added.", [{ id: "2", name: "web" }], [{ id: "1", name: "api" }]]);
    const again = await t.post("tags/2");
    expect([again.status, again.error.message, again.error.details.description]).toEqual([422, "Duplicate tags.", "Tag web already added."]);
    // A tag that is not the org's (findOrFail), or not a row id.
    expect((await t.post("tags/999")).status).toBe(404);
    expect((await t.post("tags/web")).status).toBe(404);

    const removed = await t.del("tags/2");
    expect([removed.status, removed.data.message, removed.data.tags]).toEqual([200, "Tag removed.", []]);
    expect(removed.data.availableTags).toEqual([{ id: "1", name: "api" }, { id: "2", name: "web" }]);
    expect(t.store.tagRows).toHaveLength(2);
    // detach() of a tag that is not attached changes nothing and still answers.
    expect((await t.del("tags/1")).status).toBe(200);
  });
});

// ---------------------------------------------------------------- Resource Operations

describe("the Resource Operations page (ResourceOperations, clone_application)", () => {
  it("lists where the application can go: projects by name with their environments, servers with their destinations, build servers apart", async () => {
    const t = setup();
    const r = await t.get("resource-operations");
    expect(r.status).toBe(200);
    expect(r.data.projects).toEqual([
      { uuid: "prj2", name: "archive", environments: [{ uuid: "env3", name: "production" }] },
      { uuid: "prj3", name: "Blank", environments: [] },
      { uuid: "prj1", name: "Shop", environments: [{ uuid: "env1", name: "production" }, { uuid: "env2", name: "staging" }] },
    ]);
    expect(r.data.servers).toEqual([
      { uuid: "srv1", name: "main", ip: "203.0.113.10", isFunctional: false, destinations: [{ uuid: "dst1", name: "freeploy" }] },
      { uuid: "srv2", name: "edge", ip: "203.0.113.20", isFunctional: true, destinations: [{ uuid: "dst2", name: "edge-net" }, { uuid: "swm2", name: "overlay" }] },
    ]);
    expect(r.data.buildServers).toEqual([{ uuid: "srv3", name: "builder" }]);
    expect(r.data.application).toMatchObject({ project: { uuid: "prj1" }, environment: { uuid: "env1" }, server: { uuid: "srv1" }, destination: { uuid: "dst1" } });
  });

  it("moves the application to another environment of the org", async () => {
    const t = setup();
    const r = await t.post("resource-operations/move", { environment_uuid: "env3" });
    expect([r.status, r.data]).toEqual([200, { projectUuid: "prj2", environmentUuid: "env3", applicationUuid: "app1" }]);
    expect(t.store.app).toMatchObject({ environment_id: 13, environment_uuid: "env3", project_uuid: "prj2" });
    for (const body of [{}, { environment_uuid: "nope" }, { environment_uuid: "" }, { environment_uuid: 13 }]) {
      expect(t.refused(await t.post("resource-operations/move", body))).toEqual([422, { environment_id: ["Environment not found."] }]);
    }
    expect(t.store.app.environment_uuid).toBe("env3");
    expect((await t.call("POST", "nope/resource-operations/move", { environment_uuid: "env1" })).status).toBe(404);
  });

  it("the clone's name and its volumes' names", () => {
    expect(strLimit("docker-image-app1", 20)).toBe("docker-image-app1");
    expect(strLimit("a".repeat(20), 20)).toBe("a".repeat(20));
    expect(strLimit("docker-image-abcdefghijklmnop", 20)).toBe("docker-image-abcdefg...");
    // The cut is right-trimmed before the dots.
    expect(strLimit("nineteen characters x and more", 20)).toBe("nineteen characters...");
    const plain = { standalone_sqlite_id: null };
    expect(clonedVolumeName({ ...plain, name: "app1-data" }, "app1", "clone9")).toBe("clone9-data");
    expect(clonedVolumeName({ ...plain, name: "app1-app1-x" }, "app1", "clone9")).toBe("clone9-clone9-x");
    // A name without the source's uuid: the clone's uuid and what follows the last hyphen.
    expect(clonedVolumeName({ ...plain, name: "shared-pg-data" }, "app1", "clone9")).toBe("clone9-data");
    expect(clonedVolumeName({ ...plain, name: "uploads" }, "app1", "clone9")).toBe("clone9-uploads");
    // A SQLite database's volume: the whole name behind the clone's uuid.
    expect(clonedVolumeName({ standalone_sqlite_id: 4, name: "sqlite-data-abc" }, "app1", "clone9")).toBe("clone9-sqlite-data-abc");
  });

  it("clones the application to a destination and an environment, with what belongs to it", async () => {
    const t = setup();
    await t.post("storages", { type: "volume", name: "data", mount_path: "/data" });
    await t.post("storages", { type: "file", file_storage_path: "/app.conf", file_storage_content: "a=1" });
    await t.post("storages", { type: "host-file", host_file_storage_source: "/etc/hosts", host_file_storage_destination: "/etc/hosts" });
    await t.post("tags", { newTags: "production api" });
    t.store.tasks.push({ id: 50, uuid: "task1", applicationId: 1, name: "prune" });
    t.store.variables.push({ id: 60, uuid: "ev1", applicationId: 1, key: "API_KEY", value: "fp1:1:secret", is_preview: false }, { id: 61, uuid: "ev2", applicationId: 1, key: "API_KEY", value: "fp1:1:preview", is_preview: true });
    Object.assign(t.store.app, { name: "docker-image-abcdefghijklmnop", status: "running:healthy", custom_labels: "bGFiZWxz", domain_port_overrides: JSON.stringify({ "http://app1.203.0.113.10.sslip.io": 3000 }), noindex_domains: JSON.stringify(["http://app1.203.0.113.10.sslip.io"]) });

    const r = await t.post("resource-operations/clone", { destination_uuid: "swm2", environment_uuid: "env2" });
    expect(r.status).toBe(201);
    const uuid = r.data.applicationUuid as string;
    expect(uuid).toMatch(/^[a-z0-9]{24}$/);
    expect(r.data).toEqual({ projectUuid: "prj1", environmentUuid: "env2", applicationUuid: uuid });

    // The row: a new name and — the labels being read-only on a server with a proxy — a domain generated for the new server.
    expect(t.store.replicas).toEqual([
      {
        uuid,
        name: `clone-of-docker-image-abcdefg...-${uuid}`,
        fqdn: `https://${uuid}.apps.example.com`,
        domainPortOverrides: null,
        // The source's noindex flag was for a domain the clone does not have.
        noindexDomains: "[]",
        customLabels: null,
        environmentId: 12,
        destinationId: 23,
        destinationType: "swarm",
      },
    ]);
    const clone = t.store.byUuid(uuid);
    // The labels are generated again for the clone, once its row (the source's labels cleared) and its settings are there.
    expect(t.labelled).toEqual([{ uuid, settingsOf: 1, customLabels: null }]);
    expect(clone).toMatchObject({ status: "exited", environment_uuid: "env2", destination_uuid: "swm2", server_uuid: "srv2", settings_of: 1, custom_labels: `generated:${uuid}` });
    // The source is as it was.
    expect(t.store.app).toMatchObject({ status: "running:healthy", environment_uuid: "env1", destination_uuid: "dst1", custom_labels: "bGFiZWxz" });

    // Volumes under the clone's uuid; mounts with their stored path and content; tags, tasks and variables.
    expect(t.store.volumeRows.filter((v) => v.applicationId === clone.id).map((v) => [v.name, v.mount_path])).toEqual([[`${uuid}-data`, "/data"]]);
    expect(t.store.mountRows.filter((f) => f.applicationId === clone.id).map((f) => [f.fs_path, f.mount_path, f.content, f.is_host_file])).toEqual([
      [`${WORKDIR}/app.conf`, "/app.conf", sealed("a=1"), false],
      ["/etc/hosts", "/etc/hosts", null, true],
    ]);
    const copies = [...t.store.volumeRows, ...t.store.mountRows].filter((x) => x.applicationId === clone.id);
    const originals = [...t.store.volumeRows, ...t.store.mountRows].filter((x) => x.applicationId === 1);
    for (const copy of copies) expect(originals.map((o) => o.uuid)).not.toContain(copy.uuid);
    expect(t.store.pivots.filter((p) => p.applicationId === clone.id)).toHaveLength(2);
    expect(t.store.tasks.filter((x) => x.applicationId === clone.id).map((x) => [x.name, x.uuid === "task1"])).toEqual([["prune", false]]);
    expect(t.store.variables.filter((v) => v.applicationId === clone.id).map((v) => [v.key, v.value, v.is_preview, v.uuid.startsWith("ev")])).toEqual([
      // The values as stored: a ciphertext is bound to the org and the column, not to the row.
      ["API_KEY", "fp1:1:secret", false, false],
      ["API_KEY", "fp1:1:preview", true, false],
    ]);
    expect(t.store.variables).toHaveLength(4);
  });

  it("keeps the source's domain when the labels are editable or the server has no proxy; the environment defaults to the source's", async () => {
    const t = setup();
    Object.assign(t.store.app, { is_container_label_readonly_enabled: false, custom_labels: "bGFiZWxz", fqdn: "https://shop.example.com", domain_port_overrides: JSON.stringify({ "https://shop.example.com": 3000 }) });
    const r = await t.post("resource-operations/clone", { destination_uuid: "dst2" });
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ projectUuid: "prj1", environmentUuid: "env1" });
    const replica = t.store.replicas[0]!;
    expect(replica).toMatchObject({ fqdn: "https://shop.example.com", domainPortOverrides: JSON.stringify({ "https://shop.example.com": 3000 }), environmentId: 11, destinationId: 22, destinationType: "standalone" });
    // The labels and the noindex flags stay the source's: nothing is generated.
    expect(t.labelled).toEqual([]);
    expect("customLabels" in replica).toBe(false);
    expect("noindexDomains" in replica).toBe(false);

    t.store.app.is_container_label_readonly_enabled = true;
    t.store.servers[1]!.proxy = { type: "NONE" };
    await t.post("resource-operations/clone", { destination_uuid: "dst2", environment_uuid: null });
    expect(t.store.replicas[1]).toMatchObject({ fqdn: "https://shop.example.com", environmentId: 11 });
    expect(t.labelled).toEqual([]);
    // The proxy as the driver may hand it back: JSON text.
    t.store.servers[1]!.proxy = JSON.stringify({ type: "CADDY" });
    await t.post("resource-operations/clone", { destination_uuid: "dst2" });
    expect(t.store.replicas[2]!.fqdn).toBe(`https://${t.store.replicas[2]!.uuid}.apps.example.com`);
    expect(t.labelled.map((x) => x.uuid)).toEqual([t.store.replicas[2]!.uuid]);
  });

  it("stores the clone first, then says what it could not do on the server: the volume data, a mount inside the clone's directory", async () => {
    const t = setup();
    // Without volumes there is no data to copy.
    expect((await t.post("resource-operations/clone", { destination_uuid: "dst1", cloneVolumeData: true })).data.unavailable).toBeUndefined();
    await t.post("storages", { type: "volume", name: "data", mount_path: "/data" });
    await t.post("storages", { type: "file", file_storage_path: "/app.conf" });
    // A mount copied from the source keeps the source's absolute path, which is outside the clone's directory: nothing is queued for it.
    expect((await t.post("resource-operations/clone", { destination_uuid: "dst1" })).data.unavailable).toBeUndefined();
    const withData = await t.post("resource-operations/clone", { destination_uuid: "dst1", cloneVolumeData: true });
    expect([withData.status, withData.data.unavailable]).toEqual([201, UNAVAILABLE("Copying the volume data to the clone")]);
    expect(t.store.rows).toHaveLength(4);
    // A legacy relative path resolves inside the clone's own directory.
    t.store.mountRows.find((f) => f.applicationId === 1)!.fs_path = "./app.conf";
    const both = await t.post("resource-operations/clone", { destination_uuid: "dst1", cloneVolumeData: true });
    expect(both.data.unavailable).toBe(`${UNAVAILABLE("Copying the volume data to the clone")} ${UNAVAILABLE("Writing the clone's file mounts to the server")}`);
    expect(t.store.rows).toHaveLength(5);
  });

  it("two volumes that would get the same name in the clone: nothing is cloned", async () => {
    const t = setup();
    await t.post("storages", { type: "volume", name: "data", mount_path: "/data" });
    const [data] = t.store.volumeRows;
    // Names without the application's uuid (an older volume, a renamed one): both end in "-data".
    data!.name = "legacy-data";
    t.store.volumeRows.push({ ...data!, id: 901, name: "other-data" });
    expect(t.refused(await t.post("resource-operations/clone", { destination_uuid: "dst1" }))).toEqual([422, "Duplicate entry found. Please use a different name."]);
    expect([t.store.replicas, t.store.rows.length, t.store.volumeRows.length]).toEqual([[], 1, 2]);
  });

  it("answers Coolify's errors and stores nothing: an unknown environment, a destination that is not the org's or on a build server", async () => {
    const t = setup();
    const clone = async (body: Record<string, unknown>) => t.refused(await t.post("resource-operations/clone", body));
    expect(await clone({ destination_uuid: "dst1", environment_uuid: "nope" })).toEqual([422, { environment_id: ["Environment not found."] }]);
    expect(await clone({ destination_uuid: "dst1", environment_uuid: 12 })).toEqual([422, { environment_id: ["Environment not found."] }]);
    for (const destination of [undefined, "", "nope", "dst3", 21]) expect([destination, await clone({ destination_uuid: destination })]).toEqual([destination, [422, { destination_id: ["Destination not found."] }]]);
    expect(t.store.replicas).toEqual([]);
    expect(t.store.rows).toHaveLength(1);
    expect((await t.call("POST", "nope/resource-operations/clone", { destination_uuid: "dst1" })).status).toBe(404);
  });
});

// ---------------------------------------------------------------- Danger Zone

describe("the Danger Zone (Danger, DeleteResourceJob)", () => {
  it("the delete's options are Coolify's query fields, with its defaults", () => {
    const q = (s: string) => deleteOptions(new URLSearchParams(s));
    expect(q("")).toEqual({ delete_volumes: true, delete_connected_networks: true, delete_configurations: true, docker_cleanup: true, delete_backups: false });
    expect(q("delete_volumes=false&docker_cleanup=0&delete_backups=true")).toEqual({ delete_volumes: false, delete_connected_networks: true, delete_configurations: true, docker_cleanup: false, delete_backups: true });
    // filter_var(FILTER_VALIDATE_BOOLEAN): 1, true, on, yes; anything else is false.
    expect(q("delete_volumes=YES&delete_connected_networks=on&delete_configurations=1&docker_cleanup=maybe&delete_backups=")).toEqual({
      delete_volumes: true, delete_connected_networks: true, delete_configurations: true, docker_cleanup: false, delete_backups: false,
    });
  });

  it("reads the page: who may delete, whether the server answers, whether anything was ever deployed", async () => {
    const t = setup();
    expect((await t.get("danger")).data).toMatchObject({ canUpdate: true, canDelete: true, serverIsFunctional: false, neverDeployed: true });
    Object.assign(t.store.app, { server_is_reachable: true, server_is_usable: true, status: "running:healthy" });
    expect((await t.get("danger")).data).toMatchObject({ serverIsFunctional: true, neverDeployed: false });
  });

  it("deletes an application nothing was ever deployed of, with everything that belongs to it", async () => {
    const t = setup();
    await t.post("storages", { type: "volume", name: "data", mount_path: "/data" });
    await t.post("storages", { type: "file", file_storage_path: "/app.conf", file_storage_content: "a=1" });
    await t.post("tags", { newTags: "production" });
    const r = await t.call("DELETE", "app1?delete_volumes=false&delete_backups=true");
    expect(r.status).toBe(200);
    expect(r.data).toEqual({
      deleted: true,
      projectUuid: "prj1",
      environmentUuid: "env1",
      options: { delete_volumes: false, delete_connected_networks: true, delete_configurations: true, docker_cleanup: true, delete_backups: true },
    });
    expect(t.store.deleted).toEqual([1]);
    // The volume rows go also without delete_volumes (the forceDeleting hook); the tag itself stays.
    expect([t.store.rows, t.store.volumeRows, t.store.mountRows, t.store.pivots]).toEqual([[], [], [], []]);
    expect(t.store.tagRows.map((x) => x.name)).toEqual(["production"]);
    expect((await t.del("")).status).toBe(404);
    expect((await t.get("danger")).status).toBe(404);
  });

  it("an application that may have something on a server is not deleted until the SSH executor exists", async () => {
    const MESSAGE = UNAVAILABLE("Stopping the application and removing its containers, volumes, networks and configuration files from the server");
    const cases: Array<[string, (t: ReturnType<typeof setup>) => void]> = [
      ["it runs", (t) => (t.store.app.status = "running:healthy")],
      ["it restarts", (t) => (t.store.app.status = "restarting")],
      ["a container of it is known", (t) => (t.store.app.container_present = true)],
      ["a deployment was queued for it", (t) => t.store.deployments.push(1)],
    ];
    for (const [name, arrange] of cases) {
      const t = setup();
      arrange(t);
      const r = await t.del("");
      expect([name, r.status, r.error.code, r.error.message]).toEqual([name, 501, "unsupported", MESSAGE]);
      expect([name, t.store.deleted, t.store.rows.length]).toEqual([name, [], 1]);
      expect([name, (await t.get("danger")).data.neverDeployed]).toEqual([name, false]);
    }
    // 'exited' with its health suffix, and a container known to be gone, is still never deployed.
    const t = setup();
    Object.assign(t.store.app, { status: "exited:unhealthy", container_present: false });
    expect((await t.del("")).status).toBe(200);
  });
});

// ---------------------------------------------------------------- routing

describe("routing and authorization", () => {
  it("knows its routes: the four pages of an application and the application's DELETE", () => {
    expect(isApplicationResourceRoute(["app1"], "DELETE")).toBe(true);
    for (const method of ["GET", "PATCH", "POST", "PUT"]) expect([method, isApplicationResourceRoute(["app1"], method)]).toEqual([method, false]);
    for (const page of ["storages", "tags", "resource-operations", "danger"]) {
      expect([page, isApplicationResourceRoute(["app1", page], "GET"), isApplicationResourceRoute(["app1", page, "x", "1"], "PATCH")]).toEqual([page, true, true]);
    }
    for (const page of ["domains", "deploy", "persistent-storage", "storage"]) expect([page, isApplicationResourceRoute(["app1", page], "GET")]).toEqual([page, false]);
    expect(isApplicationResourceRoute([], "DELETE")).toBe(false);
  });

  it("each route has its methods; unknown paths and applications are 404", async () => {
    const t = setup();
    await t.post("storages", { type: "volume", name: "data", mount_path: "/data" });
    await t.post("storages", { type: "file", file_storage_path: "/app.conf" });
    const volume = t.store.volumeRows[0]!.id;
    const file = t.store.mountRows[0]!.id;
    const methods: Array<[string, string[]]> = [
      ["storages", ["GET", "POST"]],
      [`storages/volumes/${volume}`, ["PATCH", "DELETE"]],
      [`storages/files/${file}`, ["PATCH", "DELETE"]],
      ["tags", ["GET", "POST"]],
      ["tags/5", ["POST", "DELETE"]],
      ["resource-operations", ["GET"]],
      ["resource-operations/clone", ["POST"]],
      ["resource-operations/move", ["POST"]],
      ["danger", ["GET"]],
    ];
    for (const [path, allowed] of methods) {
      for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"].filter((m) => !allowed.includes(m))) {
        expect([path, method, (await t.call(method, `app1/${path}`, {})).status]).toEqual([path, method, 405]);
      }
    }
    for (const path of ["storages/volumes", "storages/buckets/1", "storages/volumes/1/more", "tags/1/more", "resource-operations/migrate", "danger/now", "storages/files/1/2/3"]) {
      expect([path, (await t.call("GET", `app1/${path}`)).status]).toEqual([path, 404]);
    }
    for (const path of ["storages", "tags", "resource-operations", "danger"]) {
      expect([path, (await t.call("GET", `nope/${path}`)).status]).toEqual([path, 404]);
      expect([path, (await t.call("GET", `bad uuid/${path}`)).status]).toEqual([path, 404]);
    }
    expect((await t.call("POST", "nope/storages", { type: "volume", name: "data", mount_path: "/d" })).status).toBe(404);
    expect((await t.call("POST", "nope/tags", { newTags: "api" })).status).toBe(404);
    expect((await t.call("DELETE", "nope")).status).toBe(404);
    expect(t.orgs.every((o) => o === ORG_UUID)).toBe(true);
  });

  it("a member without deploy.resource.write reads with canUpdate false — no file content, no available tags, no targets — and gets 404 on every write", async () => {
    const full = setup();
    await full.post("storages", { type: "file", file_storage_path: "/app.conf", file_storage_content: "secret=1" });
    await full.post("storages", { type: "volume", name: "data", mount_path: "/data" });
    await full.post("tags", { newTags: "api web" });
    await full.del(`tags/${full.store.tagRows[1]!.id}`);

    const t = setup({ write: false });
    Object.assign(t.store, { mountRows: full.store.mountRows, volumeRows: full.store.volumeRows, tagRows: full.store.tagRows, pivots: full.store.pivots });
    const storages = await t.get("storages");
    expect([storages.status, storages.data.canUpdate, storages.data.canDeploy]).toEqual([200, false, false]);
    expect((storages.data.files as Items)[0]).toMatchObject({ mountPath: "/app.conf", content: null });
    expect((storages.data.volumes as Items)[0]).toMatchObject({ name: "app1-data", isReadOnly: true });
    const tags = await t.get("tags");
    expect([tags.status, tags.data.canUpdate, tags.data.tags, tags.data.availableTags]).toEqual([200, false, [{ id: String(full.store.tagRows[0]!.id), name: "api" }], []]);
    const operations = await t.get("resource-operations");
    expect([operations.status, operations.data.canUpdate, operations.data.projects, operations.data.servers, operations.data.buildServers]).toEqual([200, false, [], [], []]);
    const danger = await t.get("danger");
    expect([danger.status, danger.data.canDelete]).toEqual([200, false]);

    const volume = t.store.volumeRows[0]!.id;
    const file = t.store.mountRows[0]!.id;
    const writes: Array<[string, string]> = [
      ["POST", "storages"], ["PATCH", `storages/volumes/${volume}`], ["DELETE", `storages/volumes/${volume}`], ["PATCH", `storages/files/${file}`], ["DELETE", `storages/files/${file}`],
      ["POST", "tags"], ["POST", "tags/1"], ["DELETE", "tags/1"], ["POST", "resource-operations/clone"], ["POST", "resource-operations/move"],
    ];
    for (const [method, path] of writes) expect([method, path, (await t.call(method, `app1/${path}`, { type: "volume", name: "x", mount_path: "/x", newTags: "xy", destination_uuid: "dst1", environment_uuid: "env2" })).status]).toEqual([method, path, 404]);
    expect((await t.del("")).status).toBe(404);
    expect([t.store.rows.length, t.store.volumeRows.length, t.store.mountRows.length, t.store.pivots.length, t.store.replicas.length, t.store.deleted.length]).toEqual([1, 1, 1, 1, 0, 0]);
    expect(t.store.app.environment_uuid).toBe("env1");
  });

  it("a member without deploy.resource.read gets 404 on every read", async () => {
    const t = setup({ read: false, write: false });
    for (const page of ["storages", "tags", "resource-operations", "danger"]) expect([page, (await t.get(page)).status]).toEqual([page, 404]);
    expect(t.orgs).toEqual([]);
  });

  it("handleApplications and route() send these routes here, behind the same checks", async () => {
    const t = setup({ read: false, write: false });
    const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
    const routes: Array<[string, string]> = [
      ["GET", "app1/storages"], ["PATCH", "app1/storages/volumes/1"], ["DELETE", "app1/storages/files/1"], ["GET", "app1/tags"], ["POST", "app1/tags/1"],
      ["GET", "app1/resource-operations"], ["POST", "app1/resource-operations/clone"], ["GET", "app1/danger"], ["DELETE", "app1"],
    ];
    for (const [method, path] of routes) {
      const viaHandler = await handleApplications(t.env, "req_1", actor, ORG_UUID, path.split("/"), new Request(`${BASE}/applications/${path}`, { method }));
      expect([method, path, viaHandler.status]).toEqual([method, path, 404]);
      const viaRoute = await route(new Request(`${BASE}/applications/${path}`, { method, headers }), t.env);
      expect([method, path, viaRoute.status]).toEqual([method, path, 404]);
      expect([method, path, (await route(new Request(`${BASE}/applications/${path}`, { method }), t.env)).status]).toEqual([method, path, 401]);
    }
    // Each was denied by policy-worker, not by the router: a write asks for deploy.resource.write only.
    expect(t.asked.filter((a) => a === "deploy.resource.write").length).toBe(routes.length * 2);
    expect(t.asked.filter((a) => a === "deploy.resource.read").length).toBe(4 * 2);
    // Without bindings the handler answers 503: the route exists.
    const bare: Env = { ENVIRONMENT: "test" };
    expect((await route(new Request(`${BASE}/applications/app1/storages/volumes/1`, { method: "PATCH", headers }), bare)).status).toBe(503);
    expect((await route(new Request(`${BASE}/applications/app1`, { method: "DELETE", headers }), bare)).status).toBe(503);
    // Five segments below /applications are no route at all.
    expect((await route(new Request(`${BASE}/applications/app1/storages/volumes/1/more/still`, { headers }), bare)).status).toBe(404);
  });
});

describe("two requests at once: the unique index answers as the question before the write does (DP-63)", () => {
  it("a volume name or a mount path stored between the look-up and the write is 'Duplicate entry found…'", async () => {
    const t = setup();
    await t.post("storages", { type: "volume", name: "data", mount_path: "/data" });
    const volume = t.store.volumeRows[0]!;

    t.store.insertVolume = refusedBy(DEPLOY_UNIQUE_INDEXES.persistentVolumeName);
    expect(t.refused(await t.post("storages", { type: "volume", name: "cache", mount_path: "/cache" }))).toEqual([422, DUPLICATE_ENTRY]);
    t.store.updateVolume = refusedBy(DEPLOY_UNIQUE_INDEXES.persistentVolumeName);
    expect(t.refused(await t.patch(`storages/volumes/${volume.id}`, { name: "app1-cache", mount_path: "/data", renameConfirmed: true }))).toEqual([422, DUPLICATE_ENTRY]);

    t.store.insertFile = refusedBy(DEPLOY_UNIQUE_INDEXES.fileVolumeMountPath);
    expect(t.refused(await t.post("storages", { type: "file", file_storage_path: "/etc/app.conf" }))).toEqual([422, DUPLICATE_ENTRY]);
    expect(t.refused(await t.post("storages", { type: "host-file", host_file_storage_source: "/srv/app.conf", host_file_storage_destination: "/etc/app.conf" }))).toEqual([422, DUPLICATE_ENTRY]);
    expect(t.refused(await t.post("storages", { type: "directory", file_storage_directory_source: "/srv/etc", file_storage_directory_destination: "/etc/app" }))).toEqual([422, DUPLICATE_ENTRY]);
    expect([t.store.volumeRows.map((v) => v.name), t.store.mountRows]).toEqual([["app1-data"], []]);

    // Another index is no duplicate name.
    t.store.insertFile = refusedBy("local_file_volumes_pkey");
    expect((await t.post("storages", { type: "file", file_storage_path: "/etc/app.conf" })).status).toBe(503);
  });

  it("a tag another request attached first is 'Duplicate tags.', by id and by name", async () => {
    const t = setup();
    t.store.tagRows.push({ id: 2, uuid: "tag2", name: "web" });
    t.store.attachTag = refusedBy(DEPLOY_UNIQUE_INDEXES.taggable);
    const byId = await t.post("tags/2");
    expect([byId.status, byId.error.message, byId.error.details.description]).toEqual([422, "Duplicate tags.", "Tag web already added."]);
    // Typed: the transaction is over with the refusal, so the request ends there with the same words.
    const typed = await t.post("tags", { newTags: "Web" });
    expect([typed.status, typed.error.message, typed.error.details.description]).toEqual([422, "Duplicate tags.", "Tag Web already added."]);
  });
});
