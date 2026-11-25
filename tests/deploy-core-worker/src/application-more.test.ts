// An application's Git Source, Servers, Webhooks, Scheduled Tasks and Rollback
// pages (DP-58): Coolify's rules and messages word for word, what each action
// stores, what answers "not available yet" and whether anything was stored
// before it, and the handler's routing and authorization. The SQL behind the
// store (and its row-level security) is tested in tests/db.
import { createHash } from "node:crypto";
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { handleApplications } from "@deploy-core-worker/handlers/applications";
import { handleApplicationMore, isApplicationMoreRoute, type ApplicationMoreRunner } from "@deploy-core-worker/handlers/application-more";
import type { ApplicationMoreStore } from "@deploy-core-worker/applications/more";
import { GIT_PINNED_HOST_KEYS, hostsWithPublishedKeys, isValidKnownHostsLine, knownHostFingerprint, knownHostsLineHosts, knownHostsLines, lineId, pinnedHosts } from "@deploy-core-worker/applications/host-keys";
import { convertGitUrl, deploymentType, gitLinks, gitSshHost, sourceSubtitle, type ResolvedSource } from "@deploy-core-worker/applications/source";
import type {
  ApplicationSourceChanges,
  DeployAdditionalDestinationRow,
  DeployApplicationConfigurationRow,
  DeployApplicationRollbackRow,
  DeployApplicationRow,
  DeployApplicationSourceRow,
  DeployDestinationServerRow,
  DeployGitSourceRow,
  DeployScheduledTaskExecutionRow,
  DeployScheduledTaskRow,
  DeployServerNetworkRow,
  GitSourceKind,
  ScheduledTaskChanges,
} from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const UNAVAILABLE = (what: string) => `${what} needs the SSH executor, which is not available yet.`;
const GITHUB = "App\\Models\\GithubApp";
const GITLAB = "App\\Models\\GitlabApp";
const ED25519 = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const HOST_LINE = `git.example.com ssh-ed25519 ${ED25519}`;
const PORT_LINE = `[git.example.com]:2222 ssh-ed25519 ${ED25519}`;
const sha1 = (value: string) => createHash("sha1").update(value).digest("hex");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

type Id = string | number;
type Row = Record<string, unknown> & { id: number; uuid: string };
const same = (a: Id | null | undefined, b: Id | null | undefined) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);

interface Server extends Record<string, unknown> {
  id: number;
  uuid: string;
  name: string;
  proxy: unknown;
  is_reachable: boolean;
  is_usable: boolean;
  is_swarm_worker: boolean;
  force_disabled: boolean;
  is_build_server: boolean;
  server_role: string | null;
}
interface Network {
  id: number;
  uuid: string;
  name: string;
  network: string;
  server_id: number;
}
interface Task extends Record<string, unknown> {
  id: number;
  applicationId: Id;
  uuid: string;
  enabled: boolean;
  name: string;
  command: string;
  frequency: string;
  container: string | null;
  timeout: number;
  use_shell: boolean;
}

const sealed = (plaintext: string) => `fp1:1:${Buffer.from(plaintext).toString("base64")}`;
const opened = (stored: string) => Buffer.from(stored.slice("fp1:1:".length), "base64").toString();

/** One org's application with what these pages read and write, in memory. */
class MemoryStore implements ApplicationMoreStore {
  next = 100;
  /** A public GitHub repository built with Nixpacks, on the server "main". */
  app: Row = {
    id: 1,
    uuid: "app1",
    name: "shop:main-app1",
    description: null,
    build_pack: "nixpacks",
    status: "exited",
    has_dockerfile: false,
    fqdn: null,
    docker_registry_image_name: null,
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
    // The Git columns
    git_repository: "acme/shop",
    git_branch: "main",
    git_commit_sha: "HEAD",
    base_directory: "/",
    repository_project_id: null,
    source_id: 0,
    source_type: GITHUB,
    private_key_id: null,
    git_https_username: null,
    git_https_password: null,
    git_ssh_known_hosts: null,
    manual_webhook_secret_github: sealed("github-secret-from-the-creating-hook"),
    manual_webhook_secret_gitlab: sealed("gitlab-secret-from-the-creating-hook"),
    manual_webhook_secret_bitbucket: sealed("short"),
    manual_webhook_secret_gitea: null,
  };
  sourceWrites: ApplicationSourceChanges[] = [];
  keys = [
    { id: 3, uuid: "key3", name: "deploy-a" },
    { id: 4, uuid: "key4", name: "deploy-b" },
  ];
  sources: Array<Record<string, unknown> & { kind: GitSourceKind; id: number; name: string }> = [
    { kind: "github", id: 5, uuid: "gh5", name: "zeta-app", html_url: "https://github.com", api_url: "https://api.github.com", is_public: false, account: "acme", usable: true, custom_user: "git", custom_port: 22 },
    { kind: "github", id: 6, uuid: "gh6", name: "half-made", html_url: "https://github.com", api_url: "https://api.github.com", is_public: false, account: null, usable: false, custom_user: "git", custom_port: 22 },
    { kind: "gitlab", id: 5, uuid: "gl5", name: "alpha-lab", html_url: "https://gitlab.com", api_url: "https://gitlab.com/api/v4", is_public: false, account: null, usable: true, custom_user: "git", custom_port: 22 },
    { kind: "gitea", id: 8, uuid: "gt8", name: "tea", html_url: "https://tea.example.com", api_url: "https://tea.example.com/api/v1", is_public: false, account: "crew", usable: true, custom_user: "git", custom_port: 2222 },
  ];
  servers: Server[] = [
    { id: 7, uuid: "srv1", name: "main", proxy: { type: "TRAEFIK" }, is_reachable: true, is_usable: true, is_swarm_worker: false, force_disabled: false, is_build_server: false, server_role: "both" },
    { id: 8, uuid: "srv2", name: "edge", proxy: { type: "TRAEFIK" }, is_reachable: true, is_usable: true, is_swarm_worker: false, force_disabled: false, is_build_server: false, server_role: "deployment" },
    { id: 9, uuid: "srv3", name: "builder", proxy: { type: "NONE" }, is_reachable: true, is_usable: true, is_swarm_worker: false, force_disabled: false, is_build_server: true, server_role: "build" },
    { id: 10, uuid: "srv4", name: "caddy", proxy: { type: "CADDY" }, is_reachable: true, is_usable: true, is_swarm_worker: false, force_disabled: false, is_build_server: false, server_role: null },
    { id: 11, uuid: "srv5", name: "down", proxy: { type: "TRAEFIK" }, is_reachable: false, is_usable: false, is_swarm_worker: false, force_disabled: false, is_build_server: false, server_role: "both" },
    { id: 12, uuid: "srv6", name: "blocked", proxy: { type: "TRAEFIK" }, is_reachable: true, is_usable: true, is_swarm_worker: false, force_disabled: true, is_build_server: false, server_role: "both" },
  ];
  networks: Network[] = [
    { id: 21, uuid: "dst1", name: "freeploy", network: "coolify", server_id: 7 },
    { id: 22, uuid: "dst2", name: "edge-net", network: "edge", server_id: 8 },
    { id: 23, uuid: "dst3", name: "edge-second", network: "edge2", server_id: 8 },
    { id: 24, uuid: "dst4", name: "build-net", network: "build", server_id: 9 },
    { id: 25, uuid: "dst5", name: "caddy-net", network: "caddy", server_id: 10 },
    { id: 26, uuid: "dst6", name: "down-net", network: "down", server_id: 11 },
    { id: 27, uuid: "dst7", name: "blocked-net", network: "blocked", server_id: 12 },
    { id: 28, uuid: "dst8", name: "main-second", network: "second", server_id: 7 },
  ];
  pivots: Array<{ applicationId: Id; serverId: Id; networkId: Id; status: string }> = [];
  volumes = 0;
  deployments = 0;
  taskRows: Task[] = [];
  executionRows: Array<Record<string, unknown> & { id: number; taskId: Id }> = [];
  settings = { docker_images_to_keep: 2 as number | null, disable_application_image_retention: false, server_timezone: "Europe/Madrid" as string | null };

  async findByUuid(uuid: string) {
    return uuid === this.app.uuid ? ({ ...this.app } as unknown as DeployApplicationRow) : null;
  }
  async configuration(uuid: string) {
    return uuid === this.app.uuid ? ({ ...this.app } as unknown as DeployApplicationConfigurationRow) : null;
  }
  async source(uuid: string) {
    if (uuid !== this.app.uuid) return null;
    const key = this.keys.find((k) => same(k.id, this.app.private_key_id as Id | null));
    return { ...this.app, private_key_name: key?.name ?? null } as unknown as DeployApplicationSourceRow;
  }
  async updateSource(applicationId: Id, changes: ApplicationSourceChanges) {
    if (!same(applicationId, this.app.id)) return false;
    this.sourceWrites.push(changes);
    Object.assign(this.app, changes);
    return true;
  }
  async deployKeys() {
    return this.keys;
  }
  async findDeployKey(id: Id) {
    return this.keys.find((k) => same(k.id, id)) ?? null;
  }
  async gitSources() {
    return this.sources.filter((s) => !s.is_public) as unknown as DeployGitSourceRow[];
  }
  async findGitSource(kind: GitSourceKind, id: Id) {
    return (this.sources.find((s) => s.kind === kind && same(s.id, id)) as unknown as DeployGitSourceRow | undefined) ?? null;
  }
  private network(n: Network): DeployServerNetworkRow {
    const s = this.servers.find((x) => x.id === n.server_id)!;
    return { ...n, server_uuid: s.uuid, server_name: s.name, server_proxy: s.proxy, is_reachable: s.is_reachable, is_usable: s.is_usable, is_swarm_worker: s.is_swarm_worker, force_disabled: s.force_disabled, is_build_server: s.is_build_server, server_role: s.server_role };
  }
  async additionalDestinations(applicationId: Id) {
    return this.pivots.filter((p) => same(p.applicationId, applicationId)).map((p) => ({ ...this.network(this.networks.find((n) => same(n.id, p.networkId))!), status: p.status })) as DeployAdditionalDestinationRow[];
  }
  async serverNetworks() {
    return [...this.networks].map((n) => this.network(n)).sort((a, b) => (a.server_name < b.server_name ? -1 : a.server_name > b.server_name ? 1 : Number(a.id) - Number(b.id)));
  }
  async findServer(serverId: Id) {
    return (this.servers.find((s) => same(s.id, serverId)) as unknown as DeployDestinationServerRow | undefined) ?? null;
  }
  async findNetwork(serverId: Id, networkId: Id) {
    return this.networks.find((n) => same(n.id, networkId) && same(n.server_id, serverId)) ?? null;
  }
  async hasAdditionalDestination(applicationId: Id, serverId: Id, networkId?: Id) {
    return this.pivots.some((p) => same(p.applicationId, applicationId) && same(p.serverId, serverId) && (networkId === undefined || same(p.networkId, networkId)));
  }
  async attachDestination(applicationId: Id, serverId: Id, networkId: Id) {
    if (this.pivots.some((p) => same(p.applicationId, applicationId) && same(p.networkId, networkId))) return false;
    this.pivots.push({ applicationId, serverId, networkId, status: "exited" });
    return true;
  }
  async detachDestination(applicationId: Id, serverId: Id, networkId: Id) {
    const before = this.pivots.length;
    this.pivots = this.pivots.filter((p) => !(same(p.applicationId, applicationId) && same(p.serverId, serverId) && same(p.networkId, networkId)));
    return this.pivots.length < before;
  }
  async promoteDestination(applicationId: Id, promoted: { serverId: Id; networkId: Id }, main: { serverId: Id; networkId: Id } | null) {
    const network = this.networks.find((n) => same(n.id, promoted.networkId))!;
    const server = this.servers.find((s) => same(s.id, promoted.serverId))!;
    Object.assign(this.app, { destination_id: network.id, destination_uuid: network.uuid, destination_name: network.name, destination_network: network.network, server_id: server.id, server_uuid: server.uuid, server_name: server.name, server_proxy: server.proxy });
    await this.detachDestination(applicationId, promoted.serverId, promoted.networkId);
    if (main) this.pivots.push({ applicationId, serverId: main.serverId, networkId: main.networkId, status: "exited" });
    return true;
  }
  async volumeCount() {
    return this.volumes;
  }
  async hasDeployments() {
    return this.deployments > 0;
  }
  private task(t: Task): DeployScheduledTaskRow {
    const latest = this.executionRows.filter((e) => same(e.taskId, t.id)).at(-1);
    return { ...t, created_at: null, updated_at: null, latest_status: (latest?.status as string | undefined) ?? null };
  }
  async tasks(applicationId: Id) {
    return this.taskRows.filter((t) => same(t.applicationId, applicationId)).map((t) => this.task(t));
  }
  async findTask(applicationId: Id, uuid: string) {
    const t = this.taskRows.find((x) => same(x.applicationId, applicationId) && x.uuid === uuid);
    return t ? this.task(t) : null;
  }
  async insertTask(t: { applicationId: Id; uuid: string; name: string; command: string; frequency: string; container: string | null; timeout: number; useShell: boolean }) {
    const row: Task = { id: this.next++, applicationId: t.applicationId, uuid: t.uuid, enabled: true, name: t.name, command: t.command, frequency: t.frequency, container: t.container, timeout: t.timeout, use_shell: t.useShell };
    this.taskRows.push(row);
    return this.task(row);
  }
  async updateTask(applicationId: Id, id: Id, changes: ScheduledTaskChanges) {
    const t = this.taskRows.find((x) => same(x.applicationId, applicationId) && same(x.id, id));
    if (!t) return false;
    Object.assign(t, changes);
    return true;
  }
  async deleteTask(applicationId: Id, id: Id) {
    const before = this.taskRows.length;
    this.taskRows = this.taskRows.filter((x) => !(same(x.applicationId, applicationId) && same(x.id, id)));
    this.executionRows = this.executionRows.filter((e) => !same(e.taskId, id));
    return this.taskRows.length < before;
  }
  async executions(taskId: Id) {
    return this.executionRows.filter((e) => same(e.taskId, taskId)).reverse() as unknown as DeployScheduledTaskExecutionRow[];
  }
  async rollback(uuid: string) {
    return uuid === this.app.uuid ? ({ id: this.app.id, ...this.settings } as DeployApplicationRollbackRow) : null;
  }
  async updateImagesToKeep(applicationId: Id, n: number) {
    if (!same(applicationId, this.app.id)) return false;
    this.settings.docker_images_to_keep = n;
    return true;
  }
}

interface Answer {
  status: number;
  data: Record<string, unknown>;
  error: { code: string; message: string; details: { fields?: Record<string, string[]>; description?: string } };
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
  /** The columns a secret was encrypted for. */
  const encryptedFor: string[] = [];
  const runner: ApplicationMoreRunner = async (_env, orgId, fn) => {
    orgs.push(orgId);
    return fn({
      store,
      secret: (column) => ({
        encrypt: async (plaintext) => {
          encryptedFor.push(column);
          return sealed(plaintext);
        },
        decrypt: async (stored) => opened(stored),
      }),
    });
  };
  /** path: what follows /applications/, with its query. */
  const call = async (method: string, path: string, body?: unknown): Promise<Answer> => {
    const init: RequestInit = { method };
    if (body !== undefined && method !== "GET" && method !== "DELETE") init.body = JSON.stringify(body);
    const segments = path.split("?")[0]!.split("/").filter(Boolean);
    const res = await handleApplicationMore(env, "req_1", actor, ORG_UUID, segments, new Request(`${BASE}/applications/${path}`, init), runner);
    const parsed = (await res.json()) as { data?: Record<string, unknown>; error?: Answer["error"] };
    return { status: res.status, data: parsed.data ?? {}, error: parsed.error ?? { code: "", message: "", details: {} } };
  };
  const get = (path: string) => call("GET", `app1/${path}`);
  const post = (path: string, body: unknown = {}) => call("POST", `app1/${path}`, body);
  const patch = (path: string, body: unknown = {}) => call("PATCH", `app1/${path}`, body);
  const del = (path: string) => call("DELETE", `app1/${path}`);
  /** A refusal as [status, the messages by field or the message, the description]. */
  const refused = (r: Answer) => [r.status, r.error.details.fields ?? r.error.message, ...(r.error.details.description ? [r.error.details.description] : [])];
  return { store, asked, orgs, encryptedFor, env, call, get, post, patch, del, refused };
}

type Items = Array<Record<string, unknown>>;
const source = (r: Answer) => r.data.source as Record<string, unknown>;

describe("the SSH host keys git accepts (bootstrap/helpers/applications.php)", () => {
  it("pins the keys GitHub, GitLab.com and Bitbucket Cloud publish, with ssh-keygen's fingerprints", async () => {
    expect(GIT_PINNED_HOST_KEYS).toHaveLength(9);
    expect(GIT_PINNED_HOST_KEYS.every(isValidKnownHostsLine)).toBe(true);
    expect(pinnedHosts()).toEqual(["github.com", "ssh.github.com", "gitlab.com", "altssh.gitlab.com", "bitbucket.org", "altssh.bitbucket.org"]);
    expect(hostsWithPublishedKeys()).toEqual(["github.com", "ssh.github.com", "bitbucket.org", "altssh.bitbucket.org"]);
    // The fingerprints GitHub documents for its Ed25519, ECDSA and RSA keys.
    expect(await Promise.all(GIT_PINNED_HOST_KEYS.slice(0, 3).map(async (line) => (await knownHostFingerprint(line)).fingerprint))).toEqual([
      "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
      "SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM",
      "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
    ]);
    expect(await knownHostFingerprint(PORT_LINE)).toEqual({ host: "[git.example.com]:2222", type: "ssh-ed25519", fingerprint: "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU" });
    expect(await lineId(HOST_LINE)).toBe(sha1(HOST_LINE));
  });

  it("accepts `host[,host] key-type key` lines only, and keeps the valid, distinct lines of other hosts", () => {
    for (const line of [HOST_LINE, PORT_LINE, `a.example.com,[b.example.com]:22 ssh-rsa AAAA`, `2001:db8::1 ecdsa-sha2-nistp256 AAAA==`, `h sk-ssh-ed25519@openssh.com AAAA`]) expect([line, isValidKnownHostsLine(line)]).toEqual([line, true]);
    for (const line of ["", "git.example.com ssh-ed25519", `|1|hash|hash ssh-ed25519 ${ED25519}`, `@cert-authority git.example.com ssh-ed25519 ${ED25519}`, `${HOST_LINE} comment`, `git.example.com ssh-dss AAAA`, `git.example.com  ssh-ed25519 ${ED25519}`, `[git.example.com]:222222 ssh-ed25519 AAAA`, `${HOST_LINE}\n`]) {
      expect([line, isValidKnownHostsLine(line)]).toEqual([line, false]);
    }
    expect(knownHostsLineHosts("GitHub.com,[ssh.github.com]:443 ssh-ed25519 AAAA")).toEqual(["github.com", "ssh.github.com"]);
    // Blank lines, extra whitespace, duplicates, invalid lines and the hosts with published keys go.
    expect(knownHostsLines(`  ${HOST_LINE}  \r\n\n${HOST_LINE.replace(/ /g, "\t ")}\nnot a line\ngithub.com ssh-ed25519 ${ED25519}\n${PORT_LINE}`)).toEqual([HOST_LINE, PORT_LINE]);
    // gitlab.com publishes no keys over HTTPS: a saved line of it is kept.
    expect(knownHostsLines(`gitlab.com ssh-ed25519 ${ED25519}`)).toEqual([`gitlab.com ssh-ed25519 ${ED25519}`]);
    expect(knownHostsLines(null)).toEqual([]);
  });
});

describe("how an application's repository is reached (Application, convertGitUrl)", () => {
  const publicGithub: ResolvedSource = { kind: "github", id: "0", name: "Public GitHub", htmlUrl: "https://github.com", isPublic: true, account: null, customUser: "git", customPort: 22 };
  const gitea: ResolvedSource = { kind: "gitea", id: "8", name: "tea", htmlUrl: "https://tea.example.com", isPublic: false, account: "crew", customUser: "gitea", customPort: 2222 };

  it("deploymentType(): a real key first, then a source, then the localhost key", () => {
    expect(deploymentType(3, publicGithub)).toBe("deploy_key");
    expect(deploymentType("3", null)).toBe("deploy_key");
    expect(deploymentType(null, publicGithub)).toBe("source");
    expect(deploymentType(0, publicGithub)).toBe("source");
    expect(deploymentType(0, null)).toBe("deploy_key");
    expect(deploymentType(null, null)).toBe("other");
  });

  it("convertGitUrl() and gitSshHost(): the SSH host and port, or none", () => {
    expect(convertGitUrl("acme/shop", "source", publicGithub)).toEqual({ repository: "acme/shop", port: 22 });
    expect(gitSshHost("acme/shop", "source", publicGithub)).toBeNull();
    // A deploy key needs SSH: an owner/name repository is rewritten for the source's host.
    expect(convertGitUrl("acme/shop", "deploy_key", publicGithub)).toEqual({ repository: "git@github.com:acme/shop", port: 22 });
    expect(gitSshHost("acme/shop", "deploy_key", publicGithub)).toEqual({ host: "github.com", port: 22 });
    expect(convertGitUrl("crew/app", "deploy_key", gitea)).toEqual({ repository: "ssh://gitea@tea.example.com:2222/crew/app", port: "2222" });
    expect(gitSshHost("crew/app", "deploy_key", gitea)).toEqual({ host: "tea.example.com", port: 2222 });
    expect(gitSshHost("git@git.example.com:team/app.git", "other", null)).toEqual({ host: "git.example.com", port: 22 });
    expect(convertGitUrl("git@git.example.com:2222/team/app.git", "other", null)).toEqual({ repository: "git@git.example.com:team/app.git", port: "2222" });
    expect(gitSshHost("git@git.example.com:2222/team/app.git", "other", null)).toEqual({ host: "git.example.com", port: 2222 });
    expect(gitSshHost("ssh://git@git.example.com:7999/team/app.git", "other", null)).toEqual({ host: "git.example.com", port: 7999 });
    expect(gitSshHost("git@[2001:db8::1]:team/app.git", "other", null)).toEqual({ host: "2001:db8::1", port: 22 });
    expect(gitSshHost("https://git.example.com/team/app.git", "other", null)).toBeNull();
    expect(gitSshHost("", "other", null)).toBeNull();
  });

  it("gitBranchLocation, gitCommits and gitWebhook, by source and repository", () => {
    expect(gitLinks({ git_repository: "acme/shop", git_branch: "main", base_directory: "/" }, publicGithub)).toEqual({
      branch: "https://github.com/acme/shop/tree/main/",
      commits: "https://github.com/acme/shop/commits/main",
      webhook: "https://github.com/acme/shop/settings/hooks",
    });
    expect(gitLinks({ git_repository: "crew/app", git_branch: "dev", base_directory: "/api" }, gitea)).toEqual({
      branch: "https://tea.example.com/crew/app/src/branch/dev/api",
      commits: "https://tea.example.com/crew/app/commits/branch/dev",
      webhook: "https://tea.example.com/crew/app/settings/hooks",
    });
    expect(gitLinks({ git_repository: "git@bitbucket.org:team/app.git", git_branch: "main", base_directory: null }, null)).toEqual({
      branch: "https://bitbucket.org/team/app/src/main/",
      commits: "https://bitbucket.org/team/app/commits/main",
      webhook: "https://bitbucket.org/team/app/settings/hooks",
    });
    expect(gitLinks({ git_repository: "https://user:pw@git.example.com/team/app.git", git_branch: "main", base_directory: "/" }, publicGithub).branch).toBe("https://git.example.com/team/app/tree/main/");
    // Without a source an http(s) repository links to itself; anything else has no link.
    expect(gitLinks({ git_repository: "https://git.example.com/team/app.git", git_branch: "main", base_directory: "/" }, null)).toEqual({
      branch: "https://git.example.com/team/app.git", commits: "https://git.example.com/team/app.git", webhook: "https://git.example.com/team/app.git",
    });
    expect(gitLinks({ git_repository: "coollabsio/coolify", git_branch: "main", base_directory: "/" }, null)).toEqual({ branch: null, commits: null, webhook: null });
  });

  it("names a source as the view does", () => {
    expect(sourceSubtitle({ kind: "github", account: "acme", isPublic: false })).toBe("GitHub · acme");
    expect(sourceSubtitle({ kind: "github", account: null, isPublic: true })).toBe("Public GitHub");
    expect(sourceSubtitle({ kind: "github", account: null, isPublic: false })).toBe("GitHub · Personal account");
    expect(sourceSubtitle({ kind: "gitlab", account: "team", isPublic: false })).toBe("GitLab · team");
    expect(sourceSubtitle({ kind: "gitlab", account: null, isPublic: false })).toBe("GitLab · Personal account");
    expect(sourceSubtitle({ kind: "gitea", account: null, isPublic: false })).toBe("Gitea · Personal account");
  });
});

describe("the Git Source page (Source)", () => {
  it("shows the repository, the public GitHub source and the org's other usable sources by name", async () => {
    const t = setup();
    const r = await t.get("source");
    expect([r.status, r.data.canUpdate, (r.data.application as Record<string, unknown>).uuid]).toEqual([200, true, "app1"]);
    expect(source(r)).toMatchObject({
      gitRepository: "acme/shop", gitBranch: "main", gitCommitSha: "HEAD", deploymentType: "source", usesGitSsh: false, hostKeys: [], gitSshKnownHosts: null,
      gitBranchLocation: "https://github.com/acme/shop/tree/main/", gitCommits: "https://github.com/acme/shop/commits/main",
      gitHttpsUsername: null, hasGitHttpsPassword: false, privateKeyId: null, privateKeyName: null,
      currentSource: { id: "0", kind: "github", type: GITHUB, name: "Public GitHub", subtitle: "Public GitHub" },
    });
    // Sorted by name; a GitHub App without an app id (not usable) is left out.
    expect(source(r).sources).toEqual([
      { id: "5", kind: "gitlab", type: GITLAB, name: "alpha-lab", subtitle: "GitLab · Personal account" },
      { id: "8", kind: "gitea", type: "App\\Models\\GiteaApp", name: "tea", subtitle: "Gitea · crew" },
      { id: "5", kind: "github", type: GITHUB, name: "zeta-app", subtitle: "GitHub · acme" },
    ]);
    expect(source(r).privateKeys).toEqual([{ id: "3", name: "deploy-a" }, { id: "4", name: "deploy-b" }]);
  });

  it("saves repository, branch and commit; an empty commit is HEAD, the fields are trimmed, the host keys and credentials are left alone", async () => {
    const t = setup();
    const r = await t.patch("source", { gitRepository: "  acme/store ", gitBranch: " release/1.x\n", gitCommitSha: "" });
    expect([r.status, r.data.message]).toEqual([200, "Application source updated!"]);
    expect(t.store.sourceWrites).toEqual([{ git_repository: "acme/store", git_branch: "release/1.x", git_commit_sha: "HEAD" }]);
    expect(source(r)).toMatchObject({ gitRepository: "acme/store", gitBranch: "release/1.x", gitCommitSha: "HEAD", gitCommits: "https://github.com/acme/store/commits/release/1.x" });
    const sha = await t.patch("source", { gitRepository: "acme/store", gitBranch: "main", gitCommitSha: " 0a1b2c3 " });
    expect(source(sha).gitCommitSha).toBe("0a1b2c3");
  });

  it("refuses with Laravel's and the rules' messages", async () => {
    const t = setup();
    const ok = { gitRepository: "acme/shop", gitBranch: "main", gitCommitSha: "HEAD" };
    const cases: Array<[Record<string, unknown>, Record<string, string[]>]> = [
      [{}, { gitRepository: ["The git repository field is required."], gitBranch: ["The git branch field is required."] }],
      [{ ...ok, gitRepository: 5, gitBranch: ["x"] }, { gitBranch: ["The git branch field must be a string."] }],
      [{ ...ok, gitRepository: ["x"] }, { gitRepository: ["The git repository field must be a string."] }],
      [{ ...ok, gitBranch: "feat;rm" }, { gitBranch: ["The git branch contains invalid characters."] }],
      [{ ...ok, gitBranch: "a..b" }, { gitBranch: ["The git branch contains invalid patterns."] }],
      [{ ...ok, gitBranch: "HEAD" }, { gitBranch: ["The git branch cannot be HEAD."] }],
      [{ ...ok, gitCommitSha: "-rf" }, { gitCommitSha: ["The git commit sha field format is invalid."] }],
      [{ ...ok, gitCommitSha: "abc def" }, { gitCommitSha: ["The git commit sha field format is invalid."] }],
      [{ ...ok, gitHttpsUsername: "a:b", gitHttpsPassword: "x" }, { gitHttpsUsername: ["The git https username field format is invalid."] }],
      [{ ...ok, gitHttpsUsername: "u".repeat(256), gitHttpsPassword: "x" }, { gitHttpsUsername: ["The git https username field must not be greater than 255 characters."] }],
      [{ ...ok, gitHttpsUsername: "u", gitHttpsPassword: "a\nb" }, { gitHttpsPassword: ["The git https password field format is invalid."] }],
      [{ ...ok, gitHttpsUsername: "u", gitHttpsPassword: "p".repeat(2049) }, { gitHttpsPassword: ["The git https password field must not be greater than 2048 characters."] }],
      // The repository's own rule runs only for a changed repository.
      [{ ...ok, gitRepository: "https://localhost/x.git" }, { gitRepository: ["The git repository cannot point to internal hosts."] }],
      [{ ...ok, gitRepository: "acme/shop;id" }, { gitRepository: ["The git repository contains invalid characters."] }],
      [{ ...ok, gitRepository: "just-a-name" }, { gitRepository: ["The git repository must start with https://, http://, git://, ssh://, or be an SSH URL (user@host:path)."] }],
    ];
    for (const [body, fields] of cases) expect([JSON.stringify(body).slice(0, 90), ...t.refused(await t.patch("source", body))]).toEqual([JSON.stringify(body).slice(0, 90), 422, fields]);
    expect(t.store.sourceWrites).toEqual([]);

    // A stored repository that would not pass the rule today is not checked again while it stays.
    t.store.app.git_repository = "just-a-name";
    expect((await t.patch("source", { ...ok, gitRepository: "just-a-name", gitBranch: "dev" })).status).toBe(200);
  });

  it("a repository over SSH has host keys: saved lines are validated, normalized and written only when they changed", async () => {
    const t = setup();
    Object.assign(t.store.app, { git_repository: "git@git.example.com:team/app.git", source_id: null, source_type: null });
    const fields = { gitRepository: "git@git.example.com:team/app.git", gitBranch: "main", gitCommitSha: "HEAD" };
    const shown = await t.get("source");
    expect(source(shown)).toMatchObject({ deploymentType: "other", usesGitSsh: true, hostKeys: [], currentSource: null, gitBranchLocation: "https://git.example.com/team/app/tree/main/" });

    expect(t.refused(await t.patch("source", { ...fields, gitSshKnownHosts: `${HOST_LINE}\n|1|abc|def ssh-ed25519 ${ED25519}` }))).toEqual([
      422,
      { gitSshKnownHosts: ['Each line must be "host key-type key" (for example "[git.example.com]:2222 ssh-ed25519 AAAA..."). Hashed hosts and comments are not supported.'] },
    ]);
    expect(t.refused(await t.patch("source", { ...fields, gitSshKnownHosts: `github.com ssh-ed25519 ${ED25519}` }))).toEqual([
      422,
      { gitSshKnownHosts: ["Freeploy always uses the published host keys of github.com, ssh.github.com, bitbucket.org, altssh.bitbucket.org. Remove the lines of these hosts."] },
    ]);
    expect(t.refused(await t.patch("source", { ...fields, gitSshKnownHosts: "x".repeat(65536) }))[0]).toBe(422);
    expect(t.store.sourceWrites).toEqual([]);

    const saved = await t.patch("source", { ...fields, gitSshKnownHosts: `  ${HOST_LINE}\r\n\n${PORT_LINE}  \n${HOST_LINE}` });
    expect(saved.status).toBe(200);
    expect(t.store.app.git_ssh_known_hosts).toBe(`${HOST_LINE}\n${PORT_LINE}`);
    expect(source(saved).hostKeys).toEqual([
      { id: sha1(HOST_LINE), published: false, host: "git.example.com", type: "ssh-ed25519", fingerprint: "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU" },
      { id: sha1(PORT_LINE), published: false, host: "[git.example.com]:2222", type: "ssh-ed25519", fingerprint: "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU" },
    ]);

    // The same lines again: the column is not written, so keys a deployment saved meanwhile stay.
    t.store.sourceWrites.length = 0;
    await t.patch("source", { ...fields, gitSshKnownHosts: `${HOST_LINE}\n${PORT_LINE}`, loadedGitSshKnownHosts: `${HOST_LINE}\n${PORT_LINE}` });
    expect(Object.keys(t.store.sourceWrites[0]!)).toEqual(["git_repository", "git_branch", "git_commit_sha"]);
    // A form loaded before a deployment saved a key does not remove that key.
    t.store.app.git_ssh_known_hosts = `${HOST_LINE}\n${PORT_LINE}\nother.example.com ssh-ed25519 ${ED25519}`;
    await t.patch("source", { ...fields, gitSshKnownHosts: `${HOST_LINE}\n${PORT_LINE}`, loadedGitSshKnownHosts: `${HOST_LINE}\n${PORT_LINE}` });
    expect(String(t.store.app.git_ssh_known_hosts)).toContain("other.example.com");
    // Emptying the text clears the column.
    await t.patch("source", { ...fields, gitSshKnownHosts: "" });
    expect(t.store.app.git_ssh_known_hosts).toBeNull();
  });

  it("removes one saved host key by its id; a provider's published keys are listed and cannot be removed", async () => {
    const t = setup();
    Object.assign(t.store.app, { git_repository: "git@github.com:acme/shop.git", source_id: null, source_type: null, git_ssh_known_hosts: `${HOST_LINE}\n${PORT_LINE}` });
    const shown = source(await t.get("source")).hostKeys as Items;
    expect(shown.map((k) => [k.published, k.host, k.type])).toEqual([
      [true, "github.com", "ssh-ed25519"],
      [true, "github.com", "ecdsa-sha2-nistp256"],
      [true, "github.com", "ssh-rsa"],
      [false, "git.example.com", "ssh-ed25519"],
      [false, "[git.example.com]:2222", "ssh-ed25519"],
    ]);
    expect(shown[0]!.id).toBe(`published-${sha1(GIT_PINNED_HOST_KEYS[0]!)}`);
    const removed = await t.del(`source/host-keys/${sha1(HOST_LINE)}`);
    expect([removed.status, removed.data.message]).toEqual([200, "Host key removed."]);
    expect(t.store.app.git_ssh_known_hosts).toBe(PORT_LINE);
    await t.del(`source/host-keys/${sha1(PORT_LINE)}`);
    expect(t.store.app.git_ssh_known_hosts).toBeNull();
    // A published key's id is no route.
    expect((await t.del(`source/host-keys/${shown[0]!.id as string}`)).status).toBe(404);
  });

  it("fetching the host's current keys needs the SSH executor; a repository without SSH is refused as in Coolify", async () => {
    const t = setup();
    expect(t.refused(await t.post("source/host-keys/fetch"))).toEqual([422, "The repository does not use SSH."]);
    t.store.app.git_repository = "git@git.example.com:team/app.git";
    Object.assign(t.store.app, { source_id: null, source_type: null });
    const r = await t.post("source/host-keys/fetch");
    expect([r.status, r.error.code, r.error.message]).toEqual([501, "unsupported", UNAVAILABLE("Reading the host keys of the Git host")]);
    expect(t.store.sourceWrites).toEqual([]);
  });

  it("HTTPS credentials of a custom Git host: the password is encrypted, never sent back, kept unless replaced, and removed on request", async () => {
    const t = setup();
    Object.assign(t.store.app, { git_repository: "https://dev.azure.com/acme/_git/shop", source_id: null, source_type: null });
    const fields = { gitRepository: "https://dev.azure.com/acme/_git/shop", gitBranch: "main", gitCommitSha: "HEAD" };
    expect(t.refused(await t.patch("source", { ...fields, gitHttpsUsername: "bot" }))).toEqual([422, { gitHttpsPassword: ["Enter the password or token for this username."] }]);

    const saved = await t.patch("source", { ...fields, gitHttpsUsername: "bot", gitHttpsPassword: "t0ken" });
    expect(source(saved)).toMatchObject({ deploymentType: "other", gitHttpsUsername: "bot", hasGitHttpsPassword: true });
    expect(JSON.stringify(saved.data)).not.toContain("t0ken");
    expect([t.store.app.git_https_username, opened(t.store.app.git_https_password as string), t.encryptedFor]).toEqual(["bot", "t0ken", ["git_https_password"]]);

    // Beside a saved password the username alone is stored; the password stays.
    await t.patch("source", { ...fields, gitHttpsUsername: "robot" });
    expect([t.store.app.git_https_username, opened(t.store.app.git_https_password as string)]).toEqual(["robot", "t0ken"]);
    expect(t.encryptedFor).toHaveLength(1);

    const removed = await t.del("source/https-credentials");
    expect([removed.status, removed.data.message, t.store.app.git_https_username, t.store.app.git_https_password]).toEqual([200, "HTTPS credentials removed.", null, null]);
    // Without a saved password and without a new one, a username is not stored at all.
    t.store.sourceWrites.length = 0;
    await t.patch("source", fields);
    expect(Object.keys(t.store.sourceWrites[0]!)).toEqual(["git_repository", "git_branch", "git_commit_sha"]);
  });

  it("the deploy key: another of the org's keys is selected; an unknown key is 404", async () => {
    const t = setup();
    t.store.app.private_key_id = 3;
    const shown = source(await t.get("source"));
    expect(shown).toMatchObject({ deploymentType: "deploy_key", usesGitSsh: true, privateKeyId: "3", privateKeyName: "deploy-a", privateKeys: [{ id: "4", name: "deploy-b" }] });
    const r = await t.post("source/private-key", { privateKeyId: 4 });
    expect([r.status, r.data.message, t.store.app.private_key_id]).toEqual([200, "Private key updated!", 4]);
    expect(source(r)).toMatchObject({ privateKeyId: "4", privateKeyName: "deploy-b", privateKeys: [{ id: "3", name: "deploy-a" }] });
    for (const privateKeyId of [99, "x", null, undefined]) expect([privateKeyId, (await t.post("source/private-key", { privateKeyId })).status]).toEqual([privateKeyId, 404]);
    expect(t.store.app.private_key_id).toBe(4);
  });

  it("changing the Git source stores it and says the repository's id could not be read; an unknown type or source is 404", async () => {
    const t = setup();
    const r = await t.post("source/change", { sourceId: 5, sourceType: GITLAB });
    expect([r.status, r.data.message, r.data.unavailable]).toEqual([200, "Source updated!", "Reading the repository's id from the Git provider needs the Git App connection, which is not available yet."]);
    expect([t.store.app.source_id, t.store.app.source_type, t.store.app.repository_project_id]).toEqual([5, GITLAB, null]);
    expect(source(r).currentSource).toEqual({ id: "5", kind: "gitlab", type: GITLAB, name: "alpha-lab", subtitle: "GitLab · Personal account" });
    // The current source is no longer offered; the public GitHub source is not among the org's sources.
    expect((source(r).sources as Items).map((s) => s.name)).toEqual(["tea", "zeta-app"]);
    for (const body of [{ sourceId: 5, sourceType: "App\\Models\\Server" }, { sourceId: 99, sourceType: GITHUB }, { sourceId: "x", sourceType: GITHUB }, { sourceId: 5 }, {}]) {
      expect([JSON.stringify(body), (await t.post("source/change", body)).status]).toEqual([JSON.stringify(body), 404]);
    }
    expect(t.store.app.source_type).toBe(GITLAB);
  });
});

describe("the Servers page (Destination)", () => {
  it("shows the primary server and the networks of the other usable servers that can host it", async () => {
    const t = setup();
    const r = await t.get("servers");
    expect(r.status).toBe(200);
    expect(r.data.primary).toEqual({ networkId: "21", serverId: "7", serverUuid: "srv1", serverName: "main", network: "coolify", status: "exited" });
    expect([r.data.additional, r.data.hasPersistentStorage]).toEqual([[], false]);
    // Not: the primary server's networks, a build server, a server that is down or disabled.
    expect(r.data.available).toEqual([
      { networkId: "25", serverId: "10", serverName: "caddy", name: "caddy-net" },
      { networkId: "22", serverId: "8", serverName: "edge", name: "edge-net" },
      { networkId: "23", serverId: "8", serverName: "edge", name: "edge-second" },
    ]);
  });

  it("adds a server as a row; the server's other networks are then no longer offered", async () => {
    const t = setup();
    const r = await t.post("servers", { network_id: "22", server_id: 8 });
    expect(r.status).toBe(200);
    expect(t.store.pivots).toEqual([{ applicationId: 1, serverId: 8, networkId: 22, status: "exited" }]);
    expect(r.data.additional).toEqual([{ networkId: "22", serverId: "8", serverUuid: "srv2", serverName: "edge", network: "edge", status: "exited" }]);
    expect((r.data.available as Items).map((n) => n.name)).toEqual(["caddy-net"]);
    // Again: attached once.
    await t.post("servers", { network_id: 22, server_id: 8 });
    expect(t.store.pivots).toHaveLength(1);
  });

  it("refuses a server that cannot take it, in Coolify's words", async () => {
    const t = setup();
    const add = (network_id: number, server_id: number) => t.post("servers", { network_id, server_id });
    expect(t.refused(await add(26, 11))).toEqual([422, "Failed to add server.", "The server down is not reachable. Check the connection on the server page and try again."]);
    expect(t.refused(await add(27, 12))).toEqual([422, "Failed to add server.", "The server blocked cannot host resources."]);
    expect(t.refused(await add(24, 9))).toEqual([422, "Failed to add server.", "The server builder cannot host resources."]);
    expect(t.refused(await add(25, 10))).toEqual([
      422,
      "Failed to add server.",
      "The primary server uses TRAEFIK and caddy uses CADDY. All servers of an application must use the same proxy, because they share the same proxy labels.",
    ]);
    t.store.volumes = 1;
    expect(t.refused(await add(22, 8))).toEqual([422, "Failed to add server.", "Applications with persistent storage cannot use multiple servers because volumes are not shared between servers."]);
    expect((await t.get("servers")).data.hasPersistentStorage).toBe(true);
    t.store.volumes = 0;
    t.store.app.build_pack = "dockercompose";
    expect(t.refused(await add(22, 8))).toEqual([422, "Failed to add server.", "Docker Compose applications cannot use multiple servers."]);
    // An unknown server, a network of another server, a missing id: 404.
    for (const [network, server] of [[22, 99], [22, 7], [99, 8]] as const) expect([network, server, (await add(network, server)).status]).toEqual([network, server, 404]);
    expect((await t.post("servers", { network_id: "x", server_id: 8 })).status).toBe(404);
    expect(t.store.pivots).toEqual([]);
  });

  it("makes an additional server primary in the database and says the status was not refreshed", async () => {
    const t = setup();
    await t.post("servers", { network_id: 22, server_id: 8 });
    const r = await t.post("servers/22/promote", { server_id: 8 });
    expect([r.status, r.data.unavailable]).toEqual([200, UNAVAILABLE("Refreshing the status of the application's containers on the server")]);
    expect(r.data.primary).toMatchObject({ networkId: "22", serverId: "8", serverName: "edge", network: "edge" });
    expect(r.data.additional).toEqual([{ networkId: "21", serverId: "7", serverUuid: "srv1", serverName: "main", network: "coolify", status: "exited" }]);
    expect(t.store.pivots).toEqual([{ applicationId: 1, serverId: 7, networkId: 21, status: "exited" }]);
    // A network that is not an additional destination, or an unusable server.
    expect((await t.post("servers/23/promote", { server_id: 8 })).status).toBe(404);
    expect((await t.post("servers/25/promote", { server_id: 10 })).status).toBe(404);
    expect(t.refused(await t.post("servers/26/promote", { server_id: 11 }))).toEqual([422, "Failed to promote.", "The server down is not reachable. Check the connection on the server page and try again."]);
  });

  it("removes a server nothing was deployed to at once; otherwise stopping it there comes first and needs the SSH executor", async () => {
    const t = setup();
    await t.post("servers", { network_id: 22, server_id: 8 });
    expect(t.refused(await t.del("servers/21?server_id=7"))).toEqual([422, "You are trying to remove the main server."]);
    expect((await t.del("servers/22?server_id=99")).status).toBe(404);
    expect((await t.del("servers/22")).status).toBe(404);

    // Something may run there: a deployment was queued once.
    t.store.deployments = 1;
    const blocked = await t.del("servers/22?server_id=8");
    expect([blocked.status, blocked.error.message]).toEqual([501, UNAVAILABLE("Stopping the application on the server")]);
    expect(t.store.pivots).toHaveLength(1);
    t.store.deployments = 0;
    t.store.pivots[0]!.status = "running:healthy";
    expect((await t.del("servers/22?server_id=8")).status).toBe(501);
    t.store.pivots[0]!.status = "exited";
    t.store.app.status = "running:healthy";
    expect((await t.del("servers/22?server_id=8")).status).toBe(501);
    expect(t.store.pivots).toHaveLength(1);

    t.store.app.status = "exited";
    const removed = await t.del("servers/22?server_id=8");
    expect([removed.status, removed.data.additional, t.store.pivots]).toEqual([200, [], []]);
  });

  it("stopping and deploying on one server need the SSH executor, after Coolify's own checks", async () => {
    const t = setup();
    await t.post("servers", { network_id: 22, server_id: 8 });
    expect(t.refused(await t.post("servers/stop", { server_id: 8 }))).toEqual([501, UNAVAILABLE("Stopping the application on the server")]);
    expect(t.refused(await t.post("servers/stop", { server_id: 7 }))).toEqual([501, UNAVAILABLE("Stopping the application on the server")]);
    // It does not run on that server.
    expect((await t.post("servers/stop", { server_id: 10 })).status).toBe(404);
    expect((await t.post("servers/stop", { server_id: 99 })).status).toBe(404);

    // Several servers need an image in a registry.
    expect(t.refused(await t.post("servers/22/redeploy", { server_id: 8 }))).toEqual([422, "Failed to deploy.", "Before deploying to multiple servers, you must first set a Docker image in the General tab."]);
    t.store.app.docker_registry_image_name = "registry.example.com/acme/shop";
    expect(t.refused(await t.post("servers/22/redeploy", { server_id: 8 }))).toEqual([501, UNAVAILABLE("Deploying the application to the server")]);
    expect(t.refused(await t.post("servers/21/redeploy", { server_id: 7 }))).toEqual([501, UNAVAILABLE("Deploying the application to the server")]);
    // A network of the server that is not the application's.
    expect((await t.post("servers/23/redeploy", { server_id: 8 })).status).toBe(404);
    expect((await t.post("servers/28/redeploy", { server_id: 7 })).status).toBe(404);
    t.store.servers[1]!.is_reachable = false;
    expect(t.refused(await t.post("servers/22/redeploy", { server_id: 8 }))).toEqual([422, "Failed to deploy.", "The server edge is not reachable. Check the connection on the server page and try again."]);
  });
});

describe("the Webhooks page (Webhooks, ManualWebhookSecret)", () => {
  const SECRETS = { githubManualWebhookSecret: "github-secret-from-the-creating-hook", gitlabManualWebhookSecret: "gitlab-secret-from-the-creating-hook", bitbucketManualWebhookSecret: "short", giteaManualWebhookSecret: null };

  it("answers the URLs' paths as Coolify builds them, and the secrets to who may update", async () => {
    const t = setup();
    const r = await t.get("webhooks");
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({
      deployWebhookPath: "/api/v1/deploy?uuid=app1&force=false",
      gitBased: true,
      manualWebhookPaths: {
        github: "/webhooks/source/github/events/manual", gitlab: "/webhooks/source/gitlab/events/manual",
        bitbucket: "/webhooks/source/bitbucket/events/manual", gitea: "/webhooks/source/gitea/events/manual",
      },
      gitlabAppWebhookPath: null,
      gitWebhook: "https://github.com/acme/shop/settings/hooks",
      secrets: SECRETS,
    });
  });

  it("an application with a Git App source has no manual webhooks; a GitLab App's source-level endpoint is shown; an image is not Git based", async () => {
    const t = setup();
    Object.assign(t.store.app, { source_id: 5, source_type: GITLAB });
    const lab = await t.get("webhooks");
    expect(lab.data).toMatchObject({ manualWebhookPaths: { github: null, gitlab: null, bitbucket: null, gitea: null }, gitlabAppWebhookPath: "/webhooks/source/gitlab/events", gitWebhook: "https://gitlab.com/acme/shop/settings/hooks" });
    Object.assign(t.store.app, { source_id: 5, source_type: GITHUB });
    expect((await t.get("webhooks")).data).toMatchObject({ manualWebhookPaths: { github: null }, gitlabAppWebhookPath: null });
    // No source at all: the manual webhooks again.
    Object.assign(t.store.app, { source_id: null, source_type: null, build_pack: "dockerimage" });
    expect((await t.get("webhooks")).data).toMatchObject({ gitBased: false, manualWebhookPaths: { github: "/webhooks/source/github/events/manual" } });
    Object.assign(t.store.app, { build_pack: "dockerfile", has_dockerfile: true });
    expect((await t.get("webhooks")).data.gitBased).toBe(false);
  });

  it("saves only the secrets that changed, each encrypted for its own column; an unchanged short secret keeps saving", async () => {
    const t = setup();
    const before = t.store.app.manual_webhook_secret_github;
    const r = await t.patch("webhooks", { ...SECRETS, gitlabManualWebhookSecret: "a-new-gitlab-secret-16", giteaManualWebhookSecret: "ñ".repeat(16) });
    expect([r.status, r.data.message]).toEqual([200, "Webhook secrets saved."]);
    expect(t.encryptedFor).toEqual(["manual_webhook_secret_gitlab", "manual_webhook_secret_gitea"]);
    expect(Object.keys(t.store.sourceWrites[0]!)).toEqual(["manual_webhook_secret_gitlab", "manual_webhook_secret_gitea"]);
    expect([t.store.app.manual_webhook_secret_github, opened(t.store.app.manual_webhook_secret_gitlab as string), opened(t.store.app.manual_webhook_secret_bitbucket as string)]).toEqual([before, "a-new-gitlab-secret-16", "short"]);
    expect(r.data.secrets).toMatchObject({ gitlabManualWebhookSecret: "a-new-gitlab-secret-16", bitbucketManualWebhookSecret: "short", giteaManualWebhookSecret: "ñ".repeat(16) });
    // An empty secret disables the webhook; a field the body leaves out is kept.
    await t.patch("webhooks", { githubManualWebhookSecret: "" });
    expect([t.store.app.manual_webhook_secret_github, opened(t.store.app.manual_webhook_secret_gitlab as string)]).toEqual([null, "a-new-gitlab-secret-16"]);
  });

  it("a new or changed secret needs 16 characters, in the rule's words", async () => {
    const t = setup();
    expect(t.refused(await t.patch("webhooks", { ...SECRETS, githubManualWebhookSecret: "fifteen-chars-x", bitbucketManualWebhookSecret: "shorter", giteaManualWebhookSecret: 12 }))).toEqual([
      422,
      {
        githubManualWebhookSecret: ["The GitHub webhook secret must be at least 16 characters."],
        bitbucketManualWebhookSecret: ["The Bitbucket webhook secret must be at least 16 characters."],
        giteaManualWebhookSecret: ["The Gitea webhook secret field must be a string."],
      },
    ]);
    expect(t.refused(await t.patch("webhooks", { gitlabManualWebhookSecret: "x" }))).toEqual([422, { gitlabManualWebhookSecret: ["The GitLab webhook secret must be at least 16 characters."] }]);
    expect([t.store.sourceWrites, t.encryptedFor]).toEqual([[], []]);
  });

  it("generates a 40 character secret for one provider and saves it at once", async () => {
    const t = setup();
    const r = await t.post("webhooks/gitea/generate");
    expect([r.status, r.data.message]).toEqual([200, "New Gitea webhook secret generated and saved."]);
    const secret = (r.data.secrets as Record<string, string>).giteaManualWebhookSecret!;
    expect(secret).toMatch(/^[A-Za-z0-9]{40}$/);
    expect([opened(t.store.app.manual_webhook_secret_gitea as string), Object.keys(t.store.sourceWrites[0]!), t.encryptedFor]).toEqual([secret, ["manual_webhook_secret_gitea"], ["manual_webhook_secret_gitea"]]);
    expect((await t.post("webhooks/github/generate")).data.message).toBe("New GitHub webhook secret generated and saved.");
    expect(t.refused(await t.post("webhooks/sourcehut/generate"))).toEqual([422, "Unknown webhook provider."]);
  });
});

describe("the Scheduled Tasks page (ScheduledTask\\All, Add, Show, Executions)", () => {
  const TASK = { name: "Cleanup", command: "php artisan cleanup", frequency: "daily" };

  it("starts empty, with the server's timezone", async () => {
    const t = setup();
    const r = await t.get("scheduled-tasks");
    expect([r.status, r.data.tasks, r.data.containerNames, r.data.serverTimezone, r.data.isRunning]).toEqual([200, [], [], "Europe/Madrid", false]);
    t.store.settings.server_timezone = null;
    t.store.app.status = "running:healthy";
    expect((await t.get("scheduled-tasks")).data).toMatchObject({ serverTimezone: "UTC", isRunning: true });
  });

  it("adds a task as typed, enabled, with the defaults of the form", async () => {
    const t = setup();
    const r = await t.post("scheduled-tasks", TASK);
    expect([r.status, r.data.message]).toEqual([201, "Scheduled task added."]);
    expect(t.store.taskRows[0]).toMatchObject({ applicationId: 1, enabled: true, name: "Cleanup", command: "php artisan cleanup", frequency: "daily", container: "", timeout: 300, use_shell: true });
    expect(t.store.taskRows[0]!.uuid).toMatch(/^[a-z0-9]{24}$/);
    expect(r.data.tasks).toEqual([{ uuid: t.store.taskRows[0]!.uuid, name: "Cleanup", enabled: true, container: "", frequency: "daily", status: null }]);
    await t.post("scheduled-tasks", { name: " Report ", command: "report | mail", frequency: "*/5 * * * *", container: "worker", timeout: "3600", useShell: false });
    expect(t.store.taskRows[1]).toMatchObject({ name: " Report ", frequency: "*/5 * * * *", container: "worker", timeout: 3600, use_shell: false });
  });

  it("accepts Coolify's schedule words and cron expressions, and nothing else", async () => {
    const t = setup();
    for (const frequency of ["every_minute", "hourly", "daily", "weekly", "monthly", "yearly", "@hourly", "@daily", "@weekly", "@monthly", "@yearly", "0 0 * * *", "*/15 9-17 * * 1-5", "0 0 1 JAN *"]) {
      expect([frequency, (await t.post("scheduled-tasks", { ...TASK, frequency })).status]).toEqual([frequency, 201]);
    }
    const before = t.store.taskRows.length;
    for (const frequency of ["every_hour", "sometimes", "* * * *", "61 * * * *", "0 0 * * * *", " daily"]) {
      expect([frequency, ...t.refused(await t.post("scheduled-tasks", { ...TASK, frequency }))]).toEqual([frequency, 422, "Invalid Cron / Human expression."]);
    }
    expect(t.store.taskRows).toHaveLength(before);
  });

  it("refuses with Laravel's messages, Add's attribute names", async () => {
    const t = setup();
    const cases: Array<[Record<string, unknown>, Record<string, string[]>]> = [
      [{}, { name: ["The name field is required."], command: ["The command field is required."], frequency: ["The frequency field is required."] }],
      [{ ...TASK, name: ["x"], command: { a: 1 } }, { name: ["The name field must be a string."], command: ["The command field must be a string."] }],
      [{ ...TASK, container: ["x"] }, { container: ["The container field must be a string."] }],
      [{ ...TASK, timeout: "" }, { timeout: ["The timeout field is required."] }],
      [{ ...TASK, timeout: "soon" }, { timeout: ["The timeout field must be an integer."] }],
      [{ ...TASK, timeout: 1.5 }, { timeout: ["The timeout field must be an integer."] }],
      [{ ...TASK, timeout: 59 }, { timeout: ["The timeout field must be at least 60."] }],
      [{ ...TASK, timeout: 36001 }, { timeout: ["The timeout field must not be greater than 36000."] }],
      [{ ...TASK, useShell: "yes" }, { useShell: ["The run in a shell field must be true or false."] }],
      // The columns hold 255 characters.
      [{ ...TASK, command: "c".repeat(256) }, { command: ["The command field must not be greater than 255 characters."] }],
    ];
    for (const [body, fields] of cases) expect([JSON.stringify(body).slice(0, 80), ...t.refused(await t.post("scheduled-tasks", body))]).toEqual([JSON.stringify(body).slice(0, 80), 422, fields]);
    expect((await t.post("scheduled-tasks", { ...TASK, timeout: 60 })).status).toBe(201);
    expect((await t.post("scheduled-tasks", { ...TASK, timeout: 36000, command: "c".repeat(255) })).status).toBe(201);
    expect(t.store.taskRows).toHaveLength(2);
  });

  it("opens a task with its executions (none until something runs it)", async () => {
    const t = setup();
    await t.post("scheduled-tasks", TASK);
    const uuid = t.store.taskRows[0]!.uuid;
    const r = await t.get(`scheduled-tasks/${uuid}`);
    expect(r.status).toBe(200);
    expect(r.data.task).toEqual({ uuid, name: "Cleanup", command: "php artisan cleanup", frequency: "daily", container: "", timeout: 300, useShell: true, isEnabled: true, disabledReason: null });
    expect([r.data.executions, r.data.serverTimezone]).toEqual([[], "Europe/Madrid"]);
    // What a scheduler would record is listed, the newest first, and shows in the list as the task's status.
    t.store.executionRows.push({ id: 1, taskId: t.store.taskRows[0]!.id, status: "failed", message: "boom", created_at: "2026-11-01 10:00:00", finished_at: "2026-11-01 10:00:05" });
    t.store.executionRows.push({ id: 2, taskId: t.store.taskRows[0]!.id, status: "success", message: "done", created_at: "2026-11-02 10:00:00", finished_at: "2026-11-02 10:00:03" });
    expect((await t.get(`scheduled-tasks/${uuid}`)).data.executions).toEqual([
      { id: "2", status: "success", createdAt: "2026-11-02 10:00:00", finishedAt: "2026-11-02 10:00:03", message: "done" },
      { id: "1", status: "failed", createdAt: "2026-11-01 10:00:00", finishedAt: "2026-11-01 10:00:05", message: "boom" },
    ]);
    expect(((await t.get("scheduled-tasks")).data.tasks as Items)[0]!.status).toBe("success");
    expect((await t.get("scheduled-tasks/nope")).status).toBe(404);
  });

  it("updates a task: validated with Show's attribute names, the texts trimmed", async () => {
    const t = setup();
    await t.post("scheduled-tasks", TASK);
    const uuid = t.store.taskRows[0]!.uuid;
    const r = await t.patch(`scheduled-tasks/${uuid}`, { isEnabled: false, name: "  Nightly  ", command: " backup.sh ", frequency: " 0 3 * * * ".trim(), container: " app ", timeout: 900, useShell: false });
    expect([r.status, r.data.message]).toEqual([200, "Scheduled task updated."]);
    expect(t.store.taskRows[0]).toMatchObject({ enabled: false, name: "Nightly", command: "backup.sh", frequency: "0 3 * * *", container: "app", timeout: 900, use_shell: false });
    expect(r.data.task).toMatchObject({ name: "Nightly", isEnabled: false, timeout: 900 });
    expect((r.data.tasks as Items)[0]).toMatchObject({ name: "Nightly", enabled: false, container: "app" });
    // Fields the body leaves out keep their values; the three texts are always required.
    const kept = await t.patch(`scheduled-tasks/${uuid}`, { name: "Nightly", command: "backup.sh", frequency: "weekly" });
    expect([kept.status, t.store.taskRows[0]]).toEqual([200, expect.objectContaining({ enabled: false, frequency: "weekly", container: "app", timeout: 900, use_shell: false })]);
    expect(t.refused(await t.patch(`scheduled-tasks/${uuid}`, { name: "", command: "x", frequency: "daily", useShell: "no", isEnabled: "maybe", timeout: 10 }))).toEqual([
      422,
      { name: ["The name field is required."], timeout: ["The timeout field must be at least 60."], useShell: ["The use shell field must be true or false."], isEnabled: ["The is enabled field must be true or false."] },
    ]);
    expect(t.refused(await t.patch(`scheduled-tasks/${uuid}`, { name: "n", command: "x", frequency: "never" }))).toEqual([422, "Invalid Cron / Human expression."]);
    expect(t.store.taskRows[0]!.frequency).toBe("weekly");
    expect((await t.patch("scheduled-tasks/nope", TASK)).status).toBe(404);
  });

  it("enables and disables, deletes with its executions, and cannot execute now yet", async () => {
    const t = setup();
    await t.post("scheduled-tasks", TASK);
    const uuid = t.store.taskRows[0]!.uuid;
    const off = await t.post(`scheduled-tasks/${uuid}/toggle`);
    expect([off.status, off.data.message, (off.data.task as Record<string, unknown>).isEnabled, t.store.taskRows[0]!.enabled]).toEqual([200, "Scheduled task disabled.", false, false]);
    const on = await t.post(`scheduled-tasks/${uuid}/toggle`);
    expect([on.data.message, t.store.taskRows[0]!.enabled]).toEqual(["Scheduled task enabled.", true]);

    const run = await t.post(`scheduled-tasks/${uuid}/execute`);
    expect([run.status, run.error.code, run.error.message]).toEqual([501, "unsupported", UNAVAILABLE("Running the scheduled task now")]);
    expect(t.store.executionRows).toEqual([]);
    expect((await t.post("scheduled-tasks/nope/execute")).status).toBe(404);
    expect((await t.post("scheduled-tasks/nope/toggle")).status).toBe(404);

    t.store.executionRows.push({ id: 1, taskId: t.store.taskRows[0]!.id, status: "success" });
    const gone = await t.del(`scheduled-tasks/${uuid}`);
    expect([gone.status, gone.data.message, gone.data.tasks, t.store.taskRows, t.store.executionRows]).toEqual([200, "Scheduled task deleted.", [], [], []]);
    expect((await t.del(`scheduled-tasks/${uuid}`)).status).toBe(404);
  });
});

describe("the Rollback page (Rollback)", () => {
  it("shows the setting and says the images cannot be listed — never an empty list", async () => {
    const t = setup();
    const r = await t.get("rollback");
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ dockerImagesToKeep: 2, serverRetentionDisabled: false, images: null, imagesUnavailable: UNAVAILABLE("Listing the application's images on the server") });
    t.store.settings = { docker_images_to_keep: null, disable_application_image_retention: true, server_timezone: "UTC" };
    expect((await t.get("rollback")).data).toMatchObject({ dockerImagesToKeep: 2, serverRetentionDisabled: true });
  });

  it("saves how many images to keep, from 0 to 100", async () => {
    const t = setup();
    for (const value of [0, 100, "7"]) {
      const r = await t.patch("rollback", { dockerImagesToKeep: value });
      expect([value, r.status, r.data.message, r.data.dockerImagesToKeep, t.store.settings.docker_images_to_keep]).toEqual([value, 200, "Settings saved.", Number(value), Number(value)]);
    }
    const cases: Array<[unknown, string]> = [
      [-1, "The docker images to keep field must be at least 0."],
      [101, "The docker images to keep field must not be greater than 100."],
      ["many", "The docker images to keep field must be an integer."],
      [2.5, "The docker images to keep field must be an integer."],
    ];
    for (const [value, message] of cases) expect([value, ...t.refused(await t.patch("rollback", { dockerImagesToKeep: value }))]).toEqual([value, 422, { dockerImagesToKeep: [message] }]);
    expect(t.store.settings.docker_images_to_keep).toBe(7);
  });

  it("loading the images and rolling back need the SSH executor", async () => {
    const t = setup();
    const images = await t.post("rollback/images");
    expect([images.status, images.error.code, images.error.message]).toEqual([501, "unsupported", UNAVAILABLE("Listing the application's images on the server")]);
    const back = await t.post("rollback/rollback", { commit: "0a1b2c3" });
    expect([back.status, back.error.message]).toEqual([501, UNAVAILABLE("Rolling back to an image")]);
    // Reloading the images is a read (loadImages() asks for 'view'); rolling back is not.
    const reader = setup({ write: false });
    expect((await reader.post("rollback/images")).status).toBe(501);
    expect((await reader.post("rollback/rollback", { commit: "0a1b2c3" })).status).toBe(404);
  });
});

describe("routing and authorization", () => {
  it("knows its routes: the five pages of an application, with what is below them", () => {
    for (const page of ["source", "servers", "webhooks", "scheduled-tasks", "rollback"]) {
      expect([page, isApplicationMoreRoute(["app1", page]), isApplicationMoreRoute(["app1", page, "x", "y"])]).toEqual([page, true, true]);
    }
    for (const page of ["domains", "storages", "deploy", "scheduled_tasks", "server"]) expect([page, isApplicationMoreRoute(["app1", page])]).toEqual([page, false]);
    expect([isApplicationMoreRoute([]), isApplicationMoreRoute(["app1"]), isApplicationMoreRoute(["source"])]).toEqual([false, false, false]);
  });

  it("each route has its methods; unknown paths and applications are 404", async () => {
    const t = setup();
    await t.post("scheduled-tasks", { name: "Cleanup", command: "x", frequency: "daily" });
    const task = t.store.taskRows[0]!.uuid;
    const methods: Array<[string, string[]]> = [
      ["source", ["GET", "PATCH"]],
      ["source/private-key", ["POST"]],
      ["source/change", ["POST"]],
      ["source/https-credentials", ["DELETE"]],
      ["source/host-keys/fetch", ["POST"]],
      [`source/host-keys/${sha1("x")}`, ["DELETE"]],
      ["servers", ["GET", "POST"]],
      ["servers/stop", ["POST"]],
      ["servers/22", ["DELETE"]],
      ["servers/22/promote", ["POST"]],
      ["servers/22/redeploy", ["POST"]],
      ["webhooks", ["GET", "PATCH"]],
      ["webhooks/github/generate", ["POST"]],
      ["scheduled-tasks", ["GET", "POST"]],
      [`scheduled-tasks/${task}`, ["GET", "PATCH", "DELETE"]],
      [`scheduled-tasks/${task}/toggle`, ["POST"]],
      [`scheduled-tasks/${task}/execute`, ["POST"]],
      ["rollback", ["GET", "PATCH"]],
      ["rollback/images", ["POST"]],
      ["rollback/rollback", ["POST"]],
    ];
    for (const [path, allowed] of methods) {
      for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"].filter((m) => !allowed.includes(m))) {
        expect([path, method, (await t.call(method, `app1/${path}`, {})).status]).toEqual([path, method, 405]);
      }
    }
    for (const path of ["source/keys", "source/host-keys", "source/host-keys/zz", "servers/x", "servers/22/stop", "servers/0", "webhooks/github", "webhooks/github/rotate", `scheduled-tasks/${task}/run`, "rollback/now", "rollback/images/1", "source/a/b/c"]) {
      expect([path, (await t.call("GET", `app1/${path}`)).status]).toEqual([path, 404]);
    }
    for (const page of ["source", "servers", "webhooks", "scheduled-tasks", "rollback"]) {
      expect([page, (await t.call("GET", `nope/${page}`)).status]).toEqual([page, 404]);
      expect([page, (await t.call("GET", `bad uuid/${page}`)).status]).toEqual([page, 404]);
    }
    expect((await t.call("PATCH", "nope/source", { gitRepository: "a/b", gitBranch: "main" })).status).toBe(404);
    expect((await t.call("POST", "nope/servers", { network_id: 22, server_id: 8 })).status).toBe(404);
    expect((await t.call("PATCH", "nope/webhooks", {})).status).toBe(404);
    expect((await t.call("POST", "nope/webhooks/github/generate", {})).status).toBe(404);
    expect((await t.call("POST", "nope/scheduled-tasks", { name: "a", command: "b", frequency: "daily" })).status).toBe(404);
    expect((await t.call("PATCH", "nope/rollback", { dockerImagesToKeep: 3 })).status).toBe(404);
    expect((await t.call("POST", "nope/rollback/images", {})).status).toBe(404);
    expect(t.orgs.every((o) => o === ORG_UUID)).toBe(true);
  });

  it("a member without deploy.resource.write reads with canUpdate false — no secrets, no command, no other keys, sources or servers — and gets 404 on every write", async () => {
    const full = setup();
    await full.post("scheduled-tasks", { name: "Cleanup", command: "mysql -psecret", frequency: "daily" });
    const t = setup({ write: false });
    Object.assign(t.store, { taskRows: full.store.taskRows });
    t.store.executionRows.push({ id: 1, taskId: t.store.taskRows[0]!.id, status: "success", message: "output with a secret", created_at: "2026-11-02 10:00:00", finished_at: null });
    t.store.app.git_https_password = sealed("t0ken");
    const task = t.store.taskRows[0]!.uuid;

    const src = await t.get("source");
    expect([src.status, src.data.canUpdate, src.data.canDeploy]).toEqual([200, false, false]);
    expect(source(src)).toMatchObject({ gitRepository: "acme/shop", hasGitHttpsPassword: true, privateKeys: [], sources: [], currentSource: { name: "Public GitHub" } });
    const servers = await t.get("servers");
    expect([servers.status, servers.data.canUpdate, servers.data.available, (servers.data.primary as Record<string, unknown>).serverName]).toEqual([200, false, [], "main"]);
    const hooks = await t.get("webhooks");
    expect([hooks.status, hooks.data.secrets, hooks.data.deployWebhookPath]).toEqual([200, null, "/api/v1/deploy?uuid=app1&force=false"]);
    expect(JSON.stringify(hooks.data)).not.toContain("creating-hook");
    const one = await t.get(`scheduled-tasks/${task}`);
    expect([(one.data.task as Record<string, unknown>).command, (one.data.executions as Items)[0]!.message]).toEqual(["Hidden (only admins can view)", null]);
    expect(JSON.stringify((await t.get("scheduled-tasks")).data)).not.toContain("secret");
    expect((await t.get("rollback")).data).toMatchObject({ canUpdate: false, dockerImagesToKeep: 2 });

    const writes: Array<[string, string]> = [
      ["PATCH", "source"], ["POST", "source/private-key"], ["POST", "source/change"], ["DELETE", "source/https-credentials"], ["POST", "source/host-keys/fetch"], ["DELETE", `source/host-keys/${sha1("x")}`],
      ["POST", "servers"], ["POST", "servers/stop"], ["DELETE", "servers/22?server_id=8"], ["POST", "servers/22/promote"], ["POST", "servers/22/redeploy"],
      ["PATCH", "webhooks"], ["POST", "webhooks/github/generate"],
      ["POST", "scheduled-tasks"], ["PATCH", `scheduled-tasks/${task}`], ["DELETE", `scheduled-tasks/${task}`], ["POST", `scheduled-tasks/${task}/toggle`], ["POST", `scheduled-tasks/${task}/execute`],
      ["PATCH", "rollback"], ["POST", "rollback/rollback"],
    ];
    const body = { gitRepository: "a/b", gitBranch: "main", privateKeyId: 3, sourceId: 5, sourceType: GITLAB, network_id: 22, server_id: 8, githubManualWebhookSecret: "", name: "n", command: "c", frequency: "daily", dockerImagesToKeep: 9 };
    for (const [method, path] of writes) expect([method, path, (await t.call(method, `app1/${path}`, body)).status]).toEqual([method, path, 404]);
    expect([t.store.sourceWrites, t.store.pivots, t.store.taskRows.length, t.store.taskRows[0]!.enabled, t.store.settings.docker_images_to_keep, t.encryptedFor]).toEqual([[], [], 1, true, 2, []]);
  });

  it("a member without deploy.resource.read gets 404 on every read", async () => {
    const t = setup({ read: false, write: false });
    for (const page of ["source", "servers", "webhooks", "scheduled-tasks", "scheduled-tasks/abc", "rollback"]) expect([page, (await t.get(page)).status]).toEqual([page, 404]);
    expect((await t.post("rollback/images")).status).toBe(404);
    expect(t.orgs).toEqual([]);
  });

  it("handleApplications and route() send these routes here, behind the same checks", async () => {
    const t = setup({ read: false, write: false });
    const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
    const routes: Array<[string, string]> = [
      ["GET", "app1/source"], ["PATCH", "app1/source"], ["DELETE", `app1/source/host-keys/${sha1("x")}`], ["GET", "app1/servers"], ["POST", "app1/servers/22/promote"],
      ["GET", "app1/webhooks"], ["POST", "app1/webhooks/github/generate"], ["GET", "app1/scheduled-tasks"], ["POST", "app1/scheduled-tasks/abc/toggle"], ["GET", "app1/rollback"], ["PATCH", "app1/rollback"],
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
    expect(t.asked.filter((a) => a === "deploy.resource.read").length).toBe(5 * 2);
    // Without bindings the handler answers 503: the route exists.
    const bare: Env = { ENVIRONMENT: "test" };
    expect((await route(new Request(`${BASE}/applications/app1/scheduled-tasks/abc/execute`, { method: "POST", headers }), bare)).status).toBe(503);
    expect((await route(new Request(`${BASE}/applications/app1/source`, { headers }), bare)).status).toBe(503);
  });
});
