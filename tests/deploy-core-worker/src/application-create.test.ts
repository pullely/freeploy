// Applications from a Dockerfile and from a public Git repository (DP-54):
// Coolify's Git URL and branch rules, what it reads from a repository URL and
// from a Dockerfile, the GitHub branch lookup behind a fake fetch, what each
// creation stores (field by field against SimpleDockerfile::submit,
// PublicGitRepository::submit and the model's hooks), General's rules and
// saves for the build packs, the 501s, and the routing. The SQL behind the
// store is tested in tests/db.
import type { Env } from "@deploy-core-worker/env";
import { handleApplications, type ApplicationRunner } from "@deploy-core-worker/handlers/applications";
import type { ApplicationStore } from "@deploy-core-worker/applications/service";
import { ENVIRONMENT_VARIABLE_VERSION as COOLIFY_VERSION } from "@deploy-core-worker/environment-variables/service";
import {
  dockerComposeLocationForStorage,
  dockerfileLocationForStorage,
  normalizeDirectoryPath,
  validateCreateDockerfile,
  validateCreatePublic,
  type ApplicationBuildStore,
} from "@deploy-core-worker/applications/create";
import { base64Decode, base64Encode, defaultNginxConfiguration, injectDockerComposeFlags, validateBuild, watchPathsForStorage } from "@deploy-core-worker/applications/build";
import { dockerfileHealthcheckInstruction, dockerfileHealthcheckOptions, getPortFromDockerfile, parseDockerfileInterval } from "@deploy-core-worker/applications/dockerfile";
import { generateApplicationName, gitBranchError, gitRepositoryUrlError, gitSourceOfUrl, normalizeRepositoryUrl, parseScpStyleGitUrl, sshGitUrlToHttps } from "@deploy-core-worker/applications/git";
import { formatRateLimitReset, githubApi, lookupGithubBranch, phpUrlencode, type GithubDeps } from "@deploy-core-worker/applications/github";
import type { ApplicationLabelContext } from "@deploy-core-worker/applications/labels-service";
import type {
  DeployApplicationLabelRow,
  ApplicationBuildChanges,
  ApplicationBuildSettingChanges,
  ApplicationGeneralChanges,
  DeployApplicationBuildRow,
  DeployApplicationRow,
  DeployDestinationRow,
  DeployEnvironmentListRow,
  DeployProjectRow,
  DeployServerRow,
  NewBuiltApplication,
} from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const PUBLIC_ID = /^[a-z0-9]{24}$/;
const SHELL_SAFE =
  "Allowed: alphanumerics, && / || chaining, balanced quotes, globs (*, ?), !, and safe path/arg chars. Blocked: bare &, bare |, ;, $, backtick, (, ), <, >, \\, newlines.";
const FILE_PATH = "must be a valid path starting with / and containing only alphanumeric characters, dots, hyphens, underscores, slashes, @, ~, and +.";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

type Row = Record<string, unknown> & { id: number; uuid: string };

/** The schema's defaults of the columns these tests read (packages/db/src/migrations/500_deploy_core). */
const APPLICATION_DEFAULTS = {
  description: null, status: "exited", git_commit_sha: "HEAD", static_image: "nginx:alpine", install_command: null, build_command: null, start_command: null,
  ports_mappings: null, docker_registry_image_name: null, docker_registry_image_tag: null, dockerfile_target_build: null, docker_compose: null,
  docker_compose_raw: null, docker_compose_domains: null, docker_compose_custom_start_command: null, docker_compose_custom_build_command: null,
  watch_paths: null, custom_nginx_configuration: null, custom_network_aliases: null, custom_labels: null, custom_docker_run_options: null,
  pre_deployment_command: null, pre_deployment_command_container: null, post_deployment_command: null, post_deployment_command_container: null,
  noindex_domains: null, private_key_id: null, restart_count: 0, max_restart_count: 0, restart_limit_reached: false, container_present: null,
  compose_parsing_version: "5",
};
const SETTING_DEFAULTS = { is_spa: false, is_build_server_enabled: false, is_preserve_repository_enabled: false, is_raw_compose_deployment_enabled: false };

/** One org's project, server, destination, applications and their settings, in memory. */
class MemoryStore implements ApplicationStore, ApplicationBuildStore {
  projects: DeployProjectRow[] = [{ id: 1, uuid: "prj1", name: "Shop", description: null, created_at: null, updated_at: null }];
  envs = [{ id: 10, uuid: "env1", name: "production", project_id: 1 }];
  servers = [
    { id: 100, uuid: "srv1", name: "main", ip: "203.0.113.10", wildcard_domain: null as string | null, server_role: "both", is_build_server: false },
    { id: 101, uuid: "srvb", name: "builder", ip: "203.0.113.11", wildcard_domain: null as string | null, server_role: "build", is_build_server: true },
  ];
  destinations = [
    { id: 200, uuid: "dst1", name: "freeploy", network: "coolify", type: "standalone" as const, server_id: 100 },
    { id: 201, uuid: "dstb", name: "builder", network: "coolify", type: "standalone" as const, server_id: 101 },
  ];
  /** What insert() was given: the row deploy.applications gets, with its settings and variables. */
  inserted: Array<Omit<NewBuiltApplication, "orgId">> = [];
  applications: Row[] = [];
  settings = new Map<number, Record<string, boolean>>();
  buildUpdates: Array<{ changes: ApplicationBuildChanges; settings: ApplicationBuildSettingChanges }> = [];
  generalUpdates: ApplicationGeneralChanges[] = [];
  deletedServiceVariables: number[] = [];
  clearedFileStorages: number[] = [];
  buildServers = false;
  private next = 1000;

  private destinationRow(d: MemoryStore["destinations"][number]): DeployDestinationRow {
    const s = this.servers.find((x) => x.id === d.server_id)!;
    return { id: d.id, uuid: d.uuid, name: d.name, network: d.network, type: d.type, server_id: s.id, server_uuid: s.uuid, server_name: s.name, server_ip: s.ip, created_at: null, updated_at: null };
  }
  private applicationRow(a: Row): DeployApplicationRow {
    const d = this.destinations.find((x) => x.id === a.destination_id)!;
    const s = this.servers.find((x) => x.id === d.server_id)!;
    return {
      ...a, is_container_label_readonly_enabled: true, is_container_label_escape_enabled: true,
      environment_uuid: "env1", environment_name: "production", project_uuid: "prj1", project_name: "Shop",
      destination_uuid: d.uuid, destination_name: d.name, destination_network: d.network,
      server_uuid: s.uuid, server_name: s.name, server_ip: s.ip, server_is_swarm_manager: false, server_is_swarm_worker: false,
      server_is_reachable: true, server_is_usable: true, server_force_disabled: false,
    } as unknown as DeployApplicationRow;
  }

  async findProject(uuid: string) {
    return this.projects.find((p) => p.uuid === uuid) ?? null;
  }
  async environments(projectId: string | number) {
    return this.envs.filter((e) => e.project_id === projectId).map((e) => ({ ...e, description: null, created_at: null, updated_at: null, resource_count: 0 }) as DeployEnvironmentListRow);
  }
  async findEnvironment(projectId: string | number, uuid: string) {
    return (await this.environments(projectId)).find((e) => e.uuid === uuid) ?? null;
  }
  async resourceServers() {
    return [];
  }
  async usableDestinations() {
    return [];
  }
  async findDestination(uuid: string) {
    const d = this.destinations.find((x) => x.uuid === uuid);
    return d ? this.destinationRow(d) : null;
  }
  async findServer(uuid: string) {
    return (this.servers.find((s) => s.uuid === uuid) as unknown as DeployServerRow | undefined) ?? null;
  }
  async insertDockerImage(): Promise<DeployApplicationRow> {
    throw new Error("not a Docker image test");
  }
  async findByUuid(uuid: string) {
    const a = this.applications.find((x) => x.uuid === uuid);
    return a ? this.applicationRow(a) : null;
  }
  async listForEnvironment() {
    return this.applications.map((a) => this.applicationRow(a));
  }
  async updateGeneral(id: string | number, changes: ApplicationGeneralChanges) {
    const a = this.applications.find((x) => x.id === id);
    if (!a) return null;
    this.generalUpdates.push(changes);
    Object.assign(a, changes);
    return this.applicationRow(a);
  }
  async domains() {
    return [];
  }

  // What insertBuiltApplication() stores: the given columns, COALESCEd as the SQL does, then the schema's defaults.
  async insert(application: Omit<NewBuiltApplication, "orgId">) {
    this.inserted.push(application);
    const health = application.dockerfileHealthcheck;
    const row: Row = {
      ...APPLICATION_DEFAULTS,
      id: this.next++,
      uuid: application.uuid,
      name: application.name,
      fqdn: application.fqdn,
      domain_port_overrides: application.domainPortOverrides,
      repository_project_id: application.repositoryProjectId,
      git_repository: application.gitRepository,
      git_branch: application.gitBranch,
      build_pack: application.buildPack,
      ports_exposes: application.portsExposes,
      base_directory: application.baseDirectory,
      publish_directory: application.publishDirectory,
      dockerfile: application.dockerfile,
      dockerfile_location: application.dockerfileLocation,
      docker_compose_location: application.dockerComposeLocation ?? "/docker-compose.yaml",
      health_check_enabled: application.healthCheckEnabled ?? false,
      health_check_interval: health?.interval ?? 5,
      health_check_timeout: health?.timeout ?? 5,
      health_check_start_period: health?.startPeriod ?? 5,
      health_check_retries: health?.retries ?? 10,
      custom_healthcheck_found: health !== null,
      source_id: application.sourceId,
      source_type: application.sourceType,
      environment_id: application.environmentId,
      destination_id: application.destinationId,
      destination_type: "App\\Models\\StandaloneDocker",
    };
    this.applications.push(row);
    this.settings.set(row.id, { ...SETTING_DEFAULTS, is_static: application.isStatic });
    return row.id;
  }
  async findBuild(uuid: string) {
    const a = this.applications.find((x) => x.uuid === uuid);
    return a ? ({ ...a, ...this.settings.get(a.id) } as unknown as DeployApplicationBuildRow) : null;
  }
  async updateBuild(id: string | number, changes: ApplicationBuildChanges, settings: ApplicationBuildSettingChanges) {
    this.buildUpdates.push({ changes, settings });
    Object.assign(this.applications.find((x) => x.id === id)!, changes);
    Object.assign(this.settings.get(id as number)!, settings);
  }
  async otherApplicationBuildingImage(id: string | number, imageName: string) {
    const other = this.applications.find((a) => a.id !== id && a.docker_registry_image_name === imageName && !["dockerimage", "dockercompose"].includes(a.build_pack as string));
    return other ? { uuid: other.uuid, name: other.name as string } : null;
  }
  async deleteServiceVariables(id: string | number) {
    this.deletedServiceVariables.push(id as number);
    return 0;
  }
  async clearFileStoragesBasedOnGit(id: string | number) {
    this.clearedFileStorages.push(id as number);
  }
  async hasBuildServers() {
    return this.buildServers;
  }
}

type Body = { data?: Record<string, unknown>; error?: { code: string; message: string; details: { fields?: Record<string, string[]> } } };

/** A GitHub that knows the given branches of the given repositories. */
function fakeGithub(branches: Record<string, string[]>, headers: Record<string, string> = { "X-RateLimit-Remaining": "59", "X-RateLimit-Reset": "1795514400" }) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const deps: GithubDeps = {
    fetch: async (url, init) => {
      requests.push({ url, headers: init.headers });
      const m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/branches\/(.+)$/.exec(url);
      const known = m && (branches[m[1]!] ?? []).includes(decodeURIComponent(m[2]!));
      return known ? json({ name: decodeURIComponent(m![2]!) }, 200, headers) : json({ message: "Branch not found" }, 404, headers);
    },
    sleep: async () => undefined,
  };
  return { deps, requests };
}

/** The label store of DP-53 over the same rows: what the label generator reads, and its two writes. */
const LABEL_DEFAULTS = {
  redirect: "both", is_http_basic_auth_enabled: false, http_basic_auth_username: null, http_basic_auth_password: null, http_basic_auth_hash_algorithm: "bcrypt",
  http_basic_auth_bcrypt_cost: 10, http_basic_auth_argon2id_memory_cost: 65536, http_basic_auth_argon2id_time_cost: 4, is_force_https_enabled: true,
  is_gzip_enabled: true, is_stripprefix_enabled: true, is_permanent_redirect_enabled: false, is_container_label_readonly_enabled: true,
  is_container_label_escape_enabled: true, application_traefik_certificate_resolver: null, destination_network: "coolify", server_uuid: "srv1",
  server_proxy: null, server_generate_exact_labels: false, server_traefik_certificate_resolver: null, server_is_traffic_analytics_enabled: false,
};
function labelContext(store: MemoryStore): ApplicationLabelContext {
  return {
    store: {
      findSource: async (uuid) => {
        const a = store.applications.find((x) => x.uuid === uuid);
        return a ? ({ ...LABEL_DEFAULTS, ...a, ...store.settings.get(a.id) } as unknown as DeployApplicationLabelRow) : null;
      },
      updateLabels: async (id, changes) => {
        Object.assign(store.applications.find((x) => x.id === id)!, changes);
        return true;
      },
      updateSettings: async (applicationId, changes) => {
        Object.assign(store.settings.get(applicationId as number)!, changes);
        return true;
      },
    },
    cipher: { encrypt: async (plaintext) => `fp1:${plaintext}`, decrypt: async (stored) => stored.slice(4) },
  };
}

function setup(opts: { write?: boolean; read?: boolean; github?: GithubDeps; build?: boolean; labels?: boolean } = {}) {
  const store = new MemoryStore();
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
  const encrypted: Array<[string, string]> = [];
  const runner: ApplicationRunner = async (_env, _orgId, fn) =>
    fn({
      store,
      encrypt: async (column, plaintext) => {
        encrypted.push([column, plaintext]);
        return `fp1:${column}`;
      },
      ...(opts.labels ? { labels: labelContext(store) } : {}),
      ...(opts.build === false
        ? {}
        : {
            build: {
              store,
              encryptVariable: async (plaintext: string) => {
                encrypted.push(["environment_variables.value", plaintext]);
                return `fp1:variable:${plaintext}`;
              },
            },
          }),
    });
  const github = opts.github ?? {
    fetch: async () => {
      throw new Error("the network is not for tests");
    },
  };
  const call = async (method: string, path = "", body?: unknown) => {
    const segments = path.split("/").filter(Boolean);
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleApplications(env, "req_1", actor, ORG_UUID, segments, new Request(`${BASE}/applications${path ? `/${path}` : ""}`, init), runner, github);
    return { status: res.status, body: (await res.json()) as Body };
  };
  const target = { project_uuid: "prj1", environment_uuid: "env1", server_uuid: "srv1", destination_uuid: "dst1" };
  const dockerfileForm = (over: Record<string, unknown> = {}) => ({ type: "dockerfile", ...target, dockerfile: 'FROM nginx\nEXPOSE 80\nCMD ["nginx", "-g", "daemon off;"]\n', ...over });
  const publicForm = (over: Record<string, unknown> = {}) => ({
    type: "public", ...target, repository_url: "https://github.com/coollabsio/coolify-examples", git_branch: "main", build_pack: "railpack", port: 3000,
    isStatic: false, publish_directory: null, base_directory: "/", docker_compose_location: "/docker-compose.yaml", ...over,
  });
  const created = async (form: Record<string, unknown>) => {
    const r = await call("POST", "", form);
    if (r.status !== 201) throw new Error(`create answered ${r.status}: ${JSON.stringify(r.body)}`);
    return (r.body.data as { uuid: string }).uuid;
  };
  const stored = (uuid: string) => store.applications.find((a) => a.uuid === uuid)!;
  return { store, encrypted, call, target, dockerfileForm, publicForm, created, stored };
}

describe("ValidGitRepositoryUrl", () => {
  const error = (value: unknown, allowRepositoryPath = false) => gitRepositoryUrlError("repository", value, allowRepositoryPath);

  it("accepts https, http, git, ssh and scp-style URLs, and lets an empty value pass", () => {
    for (const good of [
      "https://github.com/coollabsio/coolify-examples",
      "https://github.com/coollabsio/coolify-examples/tree/nodejs-fastify",
      "https://gitea.com/sedlav/expressjs.git",
      "http://git.example.com:3000/team/app.git",
      "https://git.example.com/~user/app%20one.git",
      "https://[2001:db8::1]/team/app.git",
      "git@github.com:coollabsio/coolify.git",
      "git@git.example.com:2222/team/app.git",
      "ssh://git@git.example.com:2222/team/app.git",
      "git://git.example.com/team/app.git",
      "",
      "0",
      null,
    ]) {
      expect([good, error(good)]).toEqual([good, null]);
    }
  });

  it("refuses shell metacharacters, control characters and traversal with Coolify's messages", () => {
    for (const bad of ["https://github.com/a/b;id", "https://github.com/a/b|id", "https://github.com/a/$(id)", "https://github.com/a/b?x=1", "https://github.com/a/b#main", "https://github.com/a/b%3Bid", "https://github.com/a/b'", "https://github.com/a/b\nx", "https://github.com/a/b%0Ax", "https://[zz]/a/b"]) {
      expect([bad, error(bad)]).toEqual([bad, "The repository contains invalid characters."]);
    }
    expect(error("https://github.com/a/../b")).toBe("The repository contains invalid patterns.");
    // FILTER_VALIDATE_URL does not look at the path; the path rule does.
    expect(error("https://github.com/a/b c")).toBe("The repository path contains invalid characters.");
    expect(error("https://git hub.com/a/b")).toBe("The repository is not a valid URL.");
    expect(error("https://github.com/a/b:c")).toBe("The repository path contains invalid characters.");
    expect(error("https://us%65r@github.com/a/b")).toBe("The repository contains invalid characters.");
  });

  it("refuses internal hosts, malformed SSH and git URLs, and anything else", () => {
    for (const internal of ["http://localhost/a/b", "https://127.0.0.1/a/b", "https://0.0.0.0/a/b", "https://[::1]/a/b", "https://127.9.9.9/a/b", "https://169.254.1.1/a/b", "https://240.0.0.1/a/b", "https://[fe80::1]/a/b", "https://git.local/a/b"]) {
      expect([internal, error(internal)]).toEqual([internal, "The repository cannot point to internal hosts."]);
    }
    // A private range is not a reserved one.
    expect(error("https://10.0.0.5/a/b.git")).toBeNull();
    expect(error("git@github.com:")).toBe("The repository is not a valid SSH repository URL.");
    expect(error("ssh://github.com/a/b")).toBe("The repository is not a valid SSH repository URL.");
    expect(error("git://")).toBe("The repository is not a valid git:// URL.");
    expect(error("github.com/a/b")).toBe("The repository must start with https://, http://, git://, ssh://, or be an SSH URL (user@host:path).");
    expect(error("coollabsio/coolify")).toBe("The repository must start with https://, http://, git://, ssh://, or be an SSH URL (user@host:path).");
    // General: a repository path is what an application with a Git source stores.
    expect(error("coollabsio/coolify", true)).toBeNull();
    expect(error("group/sub.group/name", true)).toBeNull();
  });
});

describe("ValidGitBranch", () => {
  const error = (value: unknown) => gitBranchError("git branch", value);

  it("accepts branch names and refuses what Git or a shell would not take, with Coolify's messages", () => {
    for (const good of ["main", "release/1.2", "feature/my_branch-2", "v1.0.x", "", null]) expect([good, error(good)]).toEqual([good, null]);
    for (const bad of ["main;id", "a b", "a:b", "a~1", "a^", "a*", "a?", "a[1]", "a#b", "a$b", "a\\b", "a`b"]) expect([bad, error(bad)]).toEqual([bad, "The git branch contains invalid characters."]);
    expect(error("a..b")).toBe("The git branch contains invalid patterns.");
    expect(error("a//b")).toBe("The git branch contains invalid patterns.");
    expect(error("a@{1}")).toBe("The git branch contains invalid characters.");
    expect(error("/main")).toBe("The git branch cannot start or end with / or .");
    expect(error("main.")).toBe("The git branch cannot start or end with / or .");
    expect(error("maïn")).toBe("The git branch contains invalid characters. Only letters, numbers, hyphens, underscores, forward slashes, and dots are allowed.");
    expect(error("HEAD")).toBe("The git branch cannot be HEAD.");
    expect(error("main.lock")).toBe("The git branch cannot end with .lock.");
    // The name is trimmed before it is checked.
    expect(error(" main\n")).toBeNull();
  });
});

describe("reading a repository URL (loadBranch, getGitSource)", () => {
  it("reads an SSH URL as https, adds .git to any URL but GitHub's, and takes it off a GitHub one", () => {
    expect(parseScpStyleGitUrl("git@github.com:coollabsio/coolify.git")).toEqual({ user: "git", host: "github.com", port: null, path: "coollabsio/coolify.git" });
    expect(parseScpStyleGitUrl("git@git.example.com:2222/team/app.git")).toEqual({ user: "git", host: "git.example.com", port: "2222", path: "team/app.git" });
    expect(parseScpStyleGitUrl("https://github.com/a/b")).toBeNull();
    expect(sshGitUrlToHttps("git@github.com:coollabsio/coolify.git")).toBe("https://github.com/coollabsio/coolify.git");
    expect(sshGitUrlToHttps("ssh://git@git.example.com:2222/team/app.git")).toBe("https://git.example.com/team/app.git");
    expect(sshGitUrlToHttps("https://github.com/a/b")).toBeNull();

    expect(normalizeRepositoryUrl("https://github.com/coollabsio/coolify-examples")).toBe("https://github.com/coollabsio/coolify-examples");
    expect(normalizeRepositoryUrl("https://github.com/coollabsio/coolify-examples.git")).toBe("https://github.com/coollabsio/coolify-examples");
    expect(normalizeRepositoryUrl("git@github.com:coollabsio/coolify.git")).toBe("https://github.com/coollabsio/coolify");
    expect(normalizeRepositoryUrl("https://gitlab.com/andrasbacsai/nodejs-example")).toBe("https://gitlab.com/andrasbacsai/nodejs-example.git");
    expect(normalizeRepositoryUrl("https://gitea.com/sedlav/expressjs.git")).toBe("https://gitea.com/sedlav/expressjs.git");
    expect(normalizeRepositoryUrl("https://tangled.sh/@user/repo")).toBe("https://tangled.sh/@user/repo");
    // Rewriting twice changes nothing.
    for (const url of ["https://github.com/a/b", "git@gitlab.com:a/b.git", "https://codeberg.org/a/b"]) expect(normalizeRepositoryUrl(normalizeRepositoryUrl(url))).toBe(normalizeRepositoryUrl(url));
  });

  it("a github.com URL is owner/name with the public GitHub source; any other host keeps its URL and has no source", () => {
    expect(gitSourceOfUrl("https://github.com/coollabsio/coolify-examples")).toEqual({ gitHost: "github.com", gitRepository: "coollabsio/coolify-examples", gitBranch: "main", gitSource: "github" });
    expect(gitSourceOfUrl("https://github.com/coollabsio/coolify-examples/tree/nodejs-fastify")).toMatchObject({ gitRepository: "coollabsio/coolify-examples", gitBranch: "nodejs-fastify" });
    expect(gitSourceOfUrl("https://github.com/a/b/tree/feature/x/apps/web")).toMatchObject({ gitRepository: "a/b", gitBranch: "feature/x/apps/web" });
    expect(gitSourceOfUrl("https://gitlab.com/andrasbacsai/nodejs-example.git")).toEqual({
      gitHost: "gitlab.com", gitRepository: "https://gitlab.com/andrasbacsai/nodejs-example.git", gitBranch: "main", gitSource: "other",
    });
  });

  it("names a GitHub application after its repository and branch (generate_application_name)", () => {
    expect(generateApplicationName("coollabsio/coolify-examples", "main", "abc")).toBe("coolify-examples:main-abc");
    expect(generateApplicationName("coollabsio/MyApp", "feature/x", "abc")).toBe("my-app:feature/x-abc");
    expect(generateApplicationName("a/b", "main")).toMatch(/^b:main-[a-z0-9]{24}$/);
  });
});

describe("reading a Dockerfile", () => {
  it("get_port_from_dockerfile: the number after the first EXPOSE line", () => {
    expect(getPortFromDockerfile("FROM nginx\nEXPOSE 8080\nEXPOSE 9090\n")).toBe(8080);
    expect(getPortFromDockerfile("FROM nginx\n  EXPOSE 3000/tcp\n")).toBe(3000);
    expect(getPortFromDockerfile("FROM nginx\nEXPOSE 80 443\n")).toBe(80);
    expect(getPortFromDockerfile("FROM nginx\nEXPOSE $PORT\n")).toBe(0);
    expect(getPortFromDockerfile("FROM nginx\nexpose 80\n")).toBeNull();
    expect(getPortFromDockerfile("FROM nginx\n")).toBeNull();
  });

  it("dockerfileHealthcheckInstruction: the HEALTHCHECK of the stage Docker builds", () => {
    expect(dockerfileHealthcheckInstruction("FROM nginx\n")).toBeNull();
    expect(dockerfileHealthcheckInstruction("FROM nginx\nHEALTHCHECK --interval=30s CMD curl -f http://localhost/ || exit 1\n")).toBe("HEALTHCHECK --interval=30s CMD curl -f http://localhost/ || exit 1");
    // The last one of a stage wins; a continued line is one instruction.
    expect(dockerfileHealthcheckInstruction("FROM nginx\nHEALTHCHECK CMD a\nHEALTHCHECK --timeout=3s \\\n  CMD b\n")).toBe("HEALTHCHECK --timeout=3s CMD b");
    expect(dockerfileHealthcheckInstruction("FROM nginx\nHEALTHCHECK NONE\n")).toBeNull();
    // The last stage is built; it keeps the HEALTHCHECK of the stage it starts FROM.
    const multi = "FROM node AS build\nHEALTHCHECK CMD build\nFROM nginx AS base\nHEALTHCHECK CMD base\nFROM base AS final\nRUN true\n";
    expect(dockerfileHealthcheckInstruction(multi)).toBe("HEALTHCHECK CMD base");
    expect(dockerfileHealthcheckInstruction(multi, "build")).toBe("HEALTHCHECK CMD build");
    expect(dockerfileHealthcheckInstruction("FROM node AS build\nHEALTHCHECK CMD build\nFROM nginx\n")).toBeNull();
    // "# escape=`" at the top changes the continuation character.
    expect(dockerfileHealthcheckInstruction("# escape=`\nFROM nginx\nHEALTHCHECK --retries=2 `\n CMD c\n")).toBe("HEALTHCHECK --retries=2 CMD c");
  });

  it("dockerfileHealthcheckOptions and parseDockerfileInterval: whole seconds, Docker's defaults for zero", () => {
    expect(dockerfileHealthcheckOptions("HEALTHCHECK --interval=1m30s --timeout=3s --start-period=500ms --retries=4 CMD curl -f http://localhost/")).toEqual({ interval: 90, timeout: 3, startPeriod: 1, retries: 4 });
    expect(dockerfileHealthcheckOptions("HEALTHCHECK CMD true")).toEqual({ interval: null, timeout: null, startPeriod: null, retries: null });
    expect(dockerfileHealthcheckOptions('HEALTHCHECK --interval="0s" --timeout=0 --retries=0 CMD true')).toEqual({ interval: 30, timeout: 30, startPeriod: null, retries: 3 });
    // A flag after CMD belongs to the command.
    expect(dockerfileHealthcheckOptions("HEALTHCHECK CMD curl --retries=9 x")).toMatchObject({ retries: null });
    expect(parseDockerfileInterval("45")).toBe(45);
    expect(parseDockerfileInterval("1.5m")).toBe(90);
    expect(parseDockerfileInterval("0.3m")).toBe(18);
    expect(parseDockerfileInterval("1h")).toBe(3600);
    expect(parseDockerfileInterval("")).toBeNull();
    expect(parseDockerfileInterval("soon")).toBeNull();
    expect(parseDockerfileInterval("99999999999")).toBeNull();
  });
});

describe("asking GitHub for a branch (githubApi, getBranch)", () => {
  it("asks the public API with Http::GitHub's Accept header and answers the rate limit headers", async () => {
    const gh = fakeGithub({ "coollabsio/coolify-examples": ["main"] });
    const r = await githubApi(gh.deps, "https://api.github.com", "/repos/coollabsio/coolify-examples/branches/main");
    expect(r).toEqual({ rateLimitRemaining: "59", rateLimitReset: "1795514400", data: { name: "main" } });
    expect(gh.requests).toEqual([{ url: "https://api.github.com/repos/coollabsio/coolify-examples/branches/main", headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "Freeploy" } }]);
  });

  it("throws Coolify's message with the rate limit's state when GitHub refuses", async () => {
    const gh = fakeGithub({}, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1795514400" });
    await expect(githubApi(gh.deps, "https://api.github.com", "/repos/a/b/branches/main")).rejects.toThrow(
      "GitHub API call failed:\nError: Branch not found\nRate Limit Status:\n- Remaining Calls: 0\n- Reset Time: 2026-11-24 10:00:00 UTC",
    );
    expect(formatRateLimitReset("1795514400", true)).toBe("2026-Nov-24 10:00:00");
    expect(formatRateLimitReset(null)).toBe("1970-01-01 00:00:00");
  });

  it("tries a 5xx answer or a dropped connection three times, one then two seconds apart", async () => {
    const waits: number[] = [];
    let calls = 0;
    const flaky: GithubDeps = {
      fetch: async () => (++calls < 3 ? json({ message: "Bad Gateway" }, 502) : json({ name: "main" }, 200, { "X-RateLimit-Remaining": "58" })),
      sleep: async (ms) => void waits.push(ms),
    };
    expect(await githubApi(flaky, "https://api.github.com", "/x")).toMatchObject({ rateLimitRemaining: "58" });
    expect([calls, waits]).toEqual([3, [1000, 2000]]);

    calls = 0;
    const down: GithubDeps = { fetch: async () => (calls++, json({ message: "Unavailable" }, 503)), sleep: async () => undefined };
    await expect(githubApi(down, "https://api.github.com", "/x")).rejects.toThrow("Error: Unavailable");
    expect(calls).toBe(3);

    calls = 0;
    const dropped: GithubDeps = {
      fetch: async () => {
        calls++;
        throw new TypeError("connection reset");
      },
      sleep: async () => undefined,
    };
    await expect(githubApi(dropped, "https://api.github.com", "/x")).rejects.toThrow("connection reset");
    expect(calls).toBe(3);
    // A 404 is not tried again.
    const gh = fakeGithub({});
    await expect(githubApi(gh.deps, "https://api.github.com", "/repos/a/b/branches/x")).rejects.toThrow("GitHub API call failed");
    expect(gh.requests).toHaveLength(1);
  });

  it("cuts the URL's branch back until GitHub knows it; the rest is the base directory", async () => {
    const gh = fakeGithub({ "a/b": ["feature/x"] });
    expect(await lookupGithubBranch(gh.deps, "https://api.github.com", "a/b", "feature/x/apps/web")).toEqual({
      gitBranch: "feature/x", baseDirectory: "/apps/web", rateLimitRemaining: 59, rateLimitReset: "2026-Nov-24 10:00:00",
    });
    expect(gh.requests.map((r) => r.url.split("/branches/")[1])).toEqual(["feature%2Fx%2Fapps%2Fweb", "feature%2Fx%2Fapps", "feature%2Fx"]);
    await expect(lookupGithubBranch(gh.deps, "https://api.github.com", "a/b", "nope")).rejects.toThrow("Error: Branch not found");
    expect(phpUrlencode("a b/c~d!")).toBe("a+b%2Fc%7Ed%21");
  });
});

describe("Check repository (PublicGitRepository::loadBranch)", () => {
  it("finds the branch of a GitHub repository and answers the rate limit", async () => {
    const gh = fakeGithub({ "coollabsio/coolify-examples": ["main", "nodejs-fastify"] });
    const t = setup({ github: gh.deps });
    const r = await t.call("POST", "git/check", { repository_url: "https://github.com/coollabsio/coolify-examples.git" });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      repositoryUrl: "https://github.com/coollabsio/coolify-examples",
      gitHost: "github.com",
      gitRepository: "coollabsio/coolify-examples",
      gitSource: "github",
      gitBranch: "main",
      selectedBranch: "main",
      baseDirectory: "/",
      branchFound: true,
      rateLimitRemaining: 59,
      rateLimitReset: "2026-Nov-24 10:00:00",
      scan: { unavailable: "Scanning the repository needs the SSH executor, which is not available yet." },
    });
    const tree = await t.call("POST", "git/check", { repository_url: "https://github.com/coollabsio/coolify-examples/tree/nodejs-fastify/src" });
    expect(tree.body.data).toMatchObject({ gitBranch: "nodejs-fastify", selectedBranch: "nodejs-fastify", baseDirectory: "/src" });
  });

  it("when GitHub refuses: no requests left as far as the form knows is 'found'; else main is tried as master; else the error", async () => {
    const gh = fakeGithub({ "a/legacy": ["master"] });
    const t = setup({ github: gh.deps });
    // A first check knows of no remaining requests (the component's rate_limit_remaining starts at 0).
    const first = await t.call("POST", "git/check", { repository_url: "https://github.com/a/missing" });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ branchFound: true, gitBranch: "main", selectedBranch: "main", baseDirectory: "/", rateLimitRemaining: 0, rateLimitReset: 0 });

    const master = await t.call("POST", "git/check", { repository_url: "https://github.com/a/legacy", rate_limit_remaining: 59 });
    expect(master.body.data).toMatchObject({ branchFound: true, gitBranch: "master", selectedBranch: "master", rateLimitRemaining: 59 });

    const none = await t.call("POST", "git/check", { repository_url: "https://github.com/a/missing", rate_limit_remaining: 59 });
    expect(none.status).toBe(422);
    expect(none.body.error!.message).toBe("GitHub API call failed:\nError: Branch not found\nRate Limit Status:\n- Remaining Calls: 59\n- Reset Time: 2026-11-24 10:00:00 UTC");
    const other = await t.call("POST", "git/check", { repository_url: "https://github.com/a/legacy/tree/develop", rate_limit_remaining: 59 });
    expect([other.status, other.body.error!.message.split("\n")[1]]).toEqual([422, "Error: Branch not found"]);
  });

  it("does not ask about a repository on another host; a tangled one is on master", async () => {
    const t = setup();
    const r = await t.call("POST", "git/check", { repository_url: "https://gitlab.com/andrasbacsai/nodejs-example" });
    expect(r.body.data).toMatchObject({
      repositoryUrl: "https://gitlab.com/andrasbacsai/nodejs-example.git", gitHost: "gitlab.com", gitRepository: "https://gitlab.com/andrasbacsai/nodejs-example.git",
      gitSource: "other", gitBranch: "main", baseDirectory: "/", branchFound: true, rateLimitRemaining: 0, rateLimitReset: 0,
    });
    const ssh = await t.call("POST", "git/check", { repository_url: "git@codeberg.org:team/app.git" });
    expect(ssh.body.data).toMatchObject({ repositoryUrl: "https://codeberg.org/team/app.git", gitSource: "other" });
    const tangled = await t.call("POST", "git/check", { repository_url: "https://tangled.sh/@user/repo" });
    expect(tangled.body.data).toMatchObject({ repositoryUrl: "https://tangled.sh/@user/repo", gitBranch: "master", selectedBranch: "master" });
  });

  it("answers 'Invalid repository URL: …' with the rule's message", async () => {
    const t = setup();
    for (const [url, message] of [
      ["", "Invalid repository URL: The repository url field is required."],
      ["https://github.com/a/b;id", "Invalid repository URL: The repository url contains invalid characters."],
      ["https://localhost/a/b", "Invalid repository URL: The repository url cannot point to internal hosts."],
      ["a/b", "Invalid repository URL: The repository url must start with https://, http://, git://, ssh://, or be an SSH URL (user@host:path)."],
    ] as const) {
      const r = await t.call("POST", "git/check", { repository_url: url });
      expect([url, r.status, r.body.error!.message]).toEqual([url, 422, message]);
    }
  });
});

describe("Smart Scan (HasRepositoryDetection::detectRepository)", () => {
  it("validates the branch and the base directory, wants the org's destination, then needs the SSH executor", async () => {
    const t = setup();
    const invalid = await t.call("POST", "git/scan", { git_branch: "a b", base_directory: "/../etc", destination_uuid: "dst1" });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error!.details.fields).toEqual({ branch: ["The branch contains invalid characters."], base_directory: ["The base directory field format is invalid."] });
    expect((await t.call("POST", "git/scan", { base_directory: "/" })).body.error!.details.fields).toEqual({ branch: ["The branch field is required."] });
    const missing = await t.call("POST", "git/scan", { git_branch: "main", base_directory: "/", destination_uuid: "nope" });
    expect([missing.status, missing.body.error!.message]).toEqual([404, "Destination not found."]);
    const r = await t.call("POST", "git/scan", { git_branch: "main", base_directory: "/apps/web", destination_uuid: "dst1" });
    expect([r.status, r.body.error!.code, r.body.error!.message]).toEqual([501, "unsupported", "Scanning the repository needs the SSH executor, which is not available yet."]);
  });
});

describe("creating an application from a Dockerfile (SimpleDockerfile::submit)", () => {
  it("stores what Coolify stores, field by field, and deploys nothing", async () => {
    const t = setup();
    const r = await t.call("POST", "", t.dockerfileForm());
    expect(r.status).toBe(201);
    const { uuid } = r.body.data as { uuid: string };
    expect(r.body.data).toEqual({ uuid, projectUuid: "prj1", environmentUuid: "env1" });
    expect(uuid).toMatch(PUBLIC_ID);
    expect(t.store.inserted).toHaveLength(1);
    expect(t.store.inserted[0]).toEqual({
      uuid,
      // $application->update(['name' => 'dockerfile-'.$application->uuid, 'fqdn' => $fqdn])
      name: `dockerfile-${uuid}`,
      fqdn: `http://${uuid}.203.0.113.10.sslip.io`,
      domainPortOverrides: null,
      // new Application([...]): Coolify's placeholders and its public GitHub source, byte for byte.
      repositoryProjectId: 0,
      gitRepository: "coollabsio/coolify",
      gitBranch: "main",
      buildPack: "dockerfile",
      dockerfile: 'FROM nginx\nEXPOSE 80\nCMD ["nginx", "-g", "daemon off;"]\n',
      portsExposes: "80",
      healthCheckEnabled: false,
      sourceId: 0,
      sourceType: "App\\Models\\GithubApp",
      environmentId: 10,
      destinationId: 200,
      destinationType: "standalone",
      // Not set by the component: the schema's defaults.
      baseDirectory: "/",
      publishDirectory: null,
      dockerfileLocation: null,
      dockerComposeLocation: null,
      // No HEALTHCHECK in the file.
      dockerfileHealthcheck: null,
      isStatic: false,
      variables: [],
      // The creating hook: Str::random(40) each, encrypted for its column.
      webhookSecrets: {
        manual_webhook_secret_github: "fp1:manual_webhook_secret_github",
        manual_webhook_secret_gitlab: "fp1:manual_webhook_secret_gitlab",
        manual_webhook_secret_bitbucket: "fp1:manual_webhook_secret_bitbucket",
        manual_webhook_secret_gitea: "fp1:manual_webhook_secret_gitea",
      },
    });
    expect(t.encrypted.map(([column, plain]) => [column, /^[A-Za-z0-9]{40}$/.test(plain)])).toEqual([
      ["manual_webhook_secret_github", true], ["manual_webhook_secret_gitlab", true], ["manual_webhook_secret_bitbucket", true], ["manual_webhook_secret_gitea", true],
    ]);

    const shown = await t.call("GET", uuid);
    expect(shown.body.data!.application).toMatchObject({ name: `dockerfile-${uuid}`, buildPack: "dockerfile", status: "exited", portsExposes: "80" });
    expect(shown.body.data!.build).toMatchObject({ hasDockerfile: true, gitBased: false, supportsWatchPaths: false, dockerfile: 'FROM nginx\nEXPOSE 80\nCMD ["nginx", "-g", "daemon off;"]\n', dockerfileLocation: "/Dockerfile" });
  });

  it("takes the port of the first EXPOSE, else 80, and the HEALTHCHECK's timing (parseHealthcheckFromDockerfile)", async () => {
    const t = setup();
    await t.created(t.dockerfileForm({ dockerfile: "FROM node\nEXPOSE 3000\nHEALTHCHECK --interval=30s --timeout=3s --retries=5 CMD curl -f http://localhost:3000/\n" }));
    expect(t.store.inserted[0]).toMatchObject({ portsExposes: "3000", dockerfileHealthcheck: { interval: 30, timeout: 3, startPeriod: null, retries: 5 } });
    expect(t.store.applications[0]).toMatchObject({ health_check_interval: 30, health_check_timeout: 3, health_check_start_period: 5, health_check_retries: 5, custom_healthcheck_found: true, health_check_enabled: false });
    await t.created(t.dockerfileForm({ dockerfile: "FROM alpine\nCMD sleep 1d\n" }));
    expect(t.store.inserted[1]).toMatchObject({ portsExposes: "80", dockerfileHealthcheck: null });
    await t.created(t.dockerfileForm({ dockerfile: "FROM alpine\nEXPOSE $PORT\n" }));
    expect(t.store.inserted[2]!.portsExposes).toBe("80");
  });

  it("'The dockerfile field is required.', 'Destination not found.', and 404 for a project that is not the org's", async () => {
    const t = setup();
    for (const dockerfile of [undefined, "", "   "]) {
      const r = await t.call("POST", "", t.dockerfileForm({ dockerfile }));
      expect([r.status, r.body.error!.details.fields]).toEqual([422, { dockerfile: ["The dockerfile field is required."] }]);
    }
    expect(validateCreateDockerfile({ project_uuid: "p", environment_uuid: "e", dockerfile: 5 })).toEqual({ ok: false, errors: { dockerfile: ["The dockerfile field must be a string."] } });
    for (const over of [{ destination_uuid: "nope" }, { destination_uuid: undefined }, { destination_uuid: "dstb", server_uuid: "srvb" }, { server_uuid: "srvb" }]) {
      const r = await t.call("POST", "", t.dockerfileForm(over));
      expect([r.status, r.body.error!.message]).toEqual([404, "Destination not found."]);
    }
    expect((await t.call("POST", "", t.dockerfileForm({ project_uuid: "other" }))).status).toBe(404);
    expect((await t.call("POST", "", t.dockerfileForm({ environment_uuid: "other" }))).status).toBe(404);
    expect(t.store.inserted).toHaveLength(0);
  });
});

describe("creating an application from a public Git repository (PublicGitRepository::submit)", () => {
  it("a github.com repository: owner/name, the public GitHub source, a name from the repository and branch", async () => {
    const t = setup();
    const uuid = await t.created(t.publicForm());
    const row = t.store.inserted[0]!;
    expect(row.name).toMatch(/^coolify-examples:main-[a-z0-9]{24}$/);
    // generate_application_name() makes its own id: the name does not carry the application's uuid.
    expect(row.name.endsWith(uuid)).toBe(false);
    expect(row).toEqual({
      uuid,
      name: row.name,
      // $application_init
      gitRepository: "coollabsio/coolify-examples",
      gitBranch: "main",
      portsExposes: "3000",
      publishDirectory: null,
      environmentId: 10,
      destinationId: 200,
      destinationType: "standalone",
      sourceId: 0,
      sourceType: "App\\Models\\GithubApp",
      buildPack: "railpack",
      baseDirectory: "/",
      // Only set for the Dockerfile and Docker Compose build packs.
      dockerfileLocation: null,
      dockerComposeLocation: null,
      healthCheckEnabled: null,
      // Not set at all: no repository_project_id, no Dockerfile.
      repositoryProjectId: null,
      dockerfile: null,
      dockerfileHealthcheck: null,
      // $application->settings->is_static, then generateUrl().
      isStatic: false,
      fqdn: `http://${uuid}.203.0.113.10.sslip.io`,
      domainPortOverrides: null,
      // The created hook adds a variable for Nixpacks only.
      variables: [],
      webhookSecrets: expect.any(Object),
    });
    const shown = await t.call("GET", uuid);
    expect(shown.body.data!.build).toMatchObject({
      gitRepository: "coollabsio/coolify-examples", gitBranch: "main", gitCommitSha: "HEAD", gitBased: true, hasDockerfile: false, publicRepository: true,
      supportsWatchPaths: false, couldSetBuildCommands: true, staticImage: "nginx:alpine", baseDirectory: "/", siteType: "dynamic", composeLoadUnavailable: null,
    });
  });

  it("a repository on another host: its whole URL, no source, a random name", async () => {
    const t = setup();
    await t.created(t.publicForm({ repository_url: "https://gitlab.com/andrasbacsai/nodejs-example", git_branch: "develop" }));
    const row = t.store.inserted[0]!;
    expect(row).toMatchObject({ gitRepository: "https://gitlab.com/andrasbacsai/nodejs-example.git", gitBranch: "develop", sourceId: null, sourceType: null, repositoryProjectId: null });
    // generate_random_name(): "<adjective>-<noun>-<id>".
    expect(row.name).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{24}$/);
    const shown = await t.call("GET", row.uuid);
    expect(shown.body.data!.build).toMatchObject({ publicRepository: false, supportsWatchPaths: true });
  });

  it("Nixpacks gets NIXPACKS_NODE_VERSION = 22 and its preview copy, both encrypted (the created hooks)", async () => {
    const t = setup();
    await t.created(t.publicForm({ build_pack: "nixpacks" }));
    const variables = t.store.inserted[0]!.variables;
    expect(variables.map(({ uuid, ...rest }) => [PUBLIC_ID.test(uuid), rest])).toEqual([
      [true, { key: "NIXPACKS_NODE_VERSION", value: "fp1:variable:22", isMultiline: false, isLiteral: false, isBuildtime: true, isRuntime: false, isPreview: false, version: COOLIFY_VERSION }],
      [true, { key: "NIXPACKS_NODE_VERSION", value: "fp1:variable:22", isMultiline: false, isLiteral: false, isBuildtime: true, isRuntime: false, isPreview: true, version: COOLIFY_VERSION }],
    ]);
    expect(COOLIFY_VERSION).toBe("4.7.6");
    expect(t.encrypted.filter(([column]) => column === "environment_variables.value")).toEqual([["environment_variables.value", "22"], ["environment_variables.value", "22"]]);
  });

  it("a static site, a Dockerfile and a Compose file are stored through the model's mutators", async () => {
    const t = setup();
    await t.created(t.publicForm({ isStatic: true, port: 80, publish_directory: "dist/", base_directory: "apps/web/" }));
    expect(t.store.inserted[0]).toMatchObject({ isStatic: true, portsExposes: "80", publishDirectory: "/dist/", baseDirectory: "/apps/web", buildPack: "railpack" });
    // updatedBuildPack(): only Nixpacks and Railpack have a static output type.
    await t.created(t.publicForm({ build_pack: "static", isStatic: true, port: 80 }));
    expect(t.store.inserted[1]).toMatchObject({ buildPack: "static", isStatic: false, portsExposes: "80", healthCheckEnabled: null });

    await t.created(t.publicForm({ build_pack: "dockerfile", selectedDockerfile: "docker/Dockerfile.prod" }));
    expect(t.store.inserted[2]).toMatchObject({ buildPack: "dockerfile", dockerfileLocation: "/docker/Dockerfile.prod", healthCheckEnabled: false, dockerComposeLocation: null });
    // No Dockerfile picked: dockerfile_location stays null; General shows '/Dockerfile'.
    const plain = await t.created(t.publicForm({ build_pack: "dockerfile" }));
    expect(t.store.inserted[3]).toMatchObject({ dockerfileLocation: null, healthCheckEnabled: false });
    expect((await t.call("GET", plain)).body.data!.build).toMatchObject({ dockerfileLocation: "/Dockerfile", hasDockerfile: false, gitBased: true });

    const compose = await t.created(t.publicForm({ build_pack: "dockercompose", docker_compose_location: "/deploy/compose.yaml/", isStatic: true }));
    expect(t.store.inserted[4]).toMatchObject({ buildPack: "dockercompose", dockerComposeLocation: "/deploy/compose.yaml", isStatic: false, dockerfileLocation: null });
    // Coolify gives a Compose application a generated domain too.
    expect(t.store.inserted[4]!.fqdn).toBe(`http://${compose}.203.0.113.10.sslip.io`);
    expect((await t.call("GET", compose)).body.data!.build).toMatchObject({
      composeLoadUnavailable: "Loading the Compose file from the repository needs the SSH executor, which is not available yet.", dockerComposeLocation: "/deploy/compose.yaml", dockerComposeRaw: null,
    });
    await t.created(t.publicForm({ build_pack: "dockercompose", docker_compose_location: "" }));
    expect(t.store.inserted[5]!.dockerComposeLocation).toBe("/docker-compose.yaml");

    expect(normalizeDirectoryPath("apps/web/")).toBe("/apps/web");
    expect(normalizeDirectoryPath("")).toBe("/");
    expect(normalizeDirectoryPath(null)).toBe("/");
    expect(dockerfileLocationForStorage(null, "dockerfile")).toBe("/Dockerfile");
    expect(dockerfileLocationForStorage("", "nixpacks")).toBeNull();
    expect(dockerfileLocationForStorage("Dockerfile/", "dockerfile")).toBe("/Dockerfile");
    expect(dockerComposeLocationForStorage(null)).toBe("/docker-compose.yaml");
  });

  it("rules() with the component's attribute names and Laravel's default messages", () => {
    const base = { project_uuid: "prj1", environment_uuid: "env1" };
    const empty = validateCreatePublic(base);
    expect(!empty.ok && empty.errors).toEqual({
      repository_url: ["The repository field is required."],
      port: ["The port field is required."],
      isStatic: ["The static field is required."],
      build_pack: ["The build pack field is required."],
      git_branch: ["The git branch field is required."],
    });
    const bad = validateCreatePublic({
      ...base, repository_url: "https://github.com/a/b;id", port: "abc", isStatic: "yes", publish_directory: 5, build_pack: "dockerimage",
      base_directory: "/a b", docker_compose_location: "compose.yaml", git_branch: "a b",
    });
    expect(!bad.ok && bad.errors).toEqual({
      repository_url: ["The repository contains invalid characters."],
      port: ["The port field must be a number."],
      isStatic: ["The static field must be true or false."],
      publish_directory: ["The publish directory field must be a string."],
      build_pack: ["The selected build pack is invalid."],
      base_directory: ["The base directory field format is invalid."],
      docker_compose_location: ["The docker compose location field format is invalid."],
      git_branch: ["The git branch contains invalid characters."],
    });
    const long = validateCreatePublic({ ...base, repository_url: "https://github.com/a/b", port: 3000, isStatic: false, build_pack: "dockerfile", git_branch: "main", base_directory: `/${"a".repeat(255)}`, selectedDockerfile: "docker file" });
    expect(!long.ok && long.errors).toEqual({
      base_directory: ["The base directory field must not be greater than 255 characters."],
      selectedDockerfile: [`The Dockerfile location ${FILE_PATH}`],
    });
    const ok = validateCreatePublic({ ...base, repository_url: "https://github.com/a/b", port: "8080", isStatic: "1", build_pack: "nixpacks", git_branch: "main", base_directory: "apps/web/" });
    expect(ok.ok && ok.input).toMatchObject({ port: 8080, isStatic: true, baseDirectory: "/apps/web", selectedDockerfile: null, dockerComposeLocation: null });
  });

  it("answers the field errors, 'Destination not found.' and 404s as the other forms do", async () => {
    const t = setup();
    const r = await t.call("POST", "", t.publicForm({ git_branch: "HEAD", repository_url: "ftp://x/y" }));
    expect([r.status, r.body.error!.details.fields]).toEqual([
      422,
      { repository_url: ["The repository must start with https://, http://, git://, ssh://, or be an SSH URL (user@host:path)."], git_branch: ["The git branch cannot be HEAD."] },
    ]);
    const gone = await t.call("POST", "", t.publicForm({ destination_uuid: "nope" }));
    expect([gone.status, gone.body.error!.message]).toEqual([404, "Destination not found."]);
    expect((await t.call("POST", "", t.publicForm({ project_uuid: "other" }))).status).toBe(404);
    expect(t.store.inserted).toHaveLength(0);
  });
});

describe("Docker Compose (New\\DockerCompose)", () => {
  it("answers 501: Coolify creates a Service there, which needs the Compose parser", async () => {
    const t = setup();
    const r = await t.call("POST", "", { type: "dockercompose", ...t.target, dockerComposeRaw: "services:\n  app:\n    image: nginx:alpine\n" });
    expect([r.status, r.body.error!.code, r.body.error!.message]).toEqual([501, "unsupported", "Creating a service from a Docker Compose file needs the Compose parser, which is not available yet."]);
    expect(t.store.inserted).toHaveLength(0);
  });
});

describe("General's rules and messages for the build packs", () => {
  const stored = { build_pack: "nixpacks", install_command: "npm ci; echo done", build_command: null, start_command: null };
  const errors = (body: Record<string, unknown>) => {
    const r = validateBuild(body, stored);
    return r.ok ? null : r.errors;
  };

  it("build pack, static image, directories: General's messages() and validationAttributes", () => {
    expect(errors({ buildPack: "", staticImage: "", baseDirectory: "" })).toEqual({
      buildPack: ["The Build Pack field is required."],
      staticImage: ["The Static Image field is required."],
      baseDirectory: ["The Base Directory field is required."],
    });
    expect(errors({ buildPack: "dockerimage", staticImage: "apache:alpine", baseDirectory: "apps", publishDirectory: "/dist dir" })).toEqual({
      buildPack: ["The selected Build pack is invalid."],
      staticImage: ["The selected Static image is invalid."],
      baseDirectory: ["The base directory must be a valid path starting with / and containing only safe characters."],
      publishDirectory: ["The publish directory must be a valid path starting with / and containing only safe characters."],
    });
    expect(errors({ baseDirectory: `/${"a".repeat(255)}`, publishDirectory: 5 })).toEqual({
      baseDirectory: ["The Base directory field must not be greater than 255 characters."],
      publishDirectory: ["The Publish directory field must be a string."],
    });
    // The stored build pack passes whatever it is; every listbox value does.
    for (const buildPack of ["nixpacks", "railpack", "static", "dockerfile", "dockercompose"]) expect(errors({ buildPack })).toBeNull();
    expect(errors({ staticImage: "nginx:alpine", baseDirectory: "/", publishDirectory: "" })).toBeNull();
  });

  it("commands: shell-safe unless unchanged (changedCommandRules); the Compose commands always", () => {
    expect(errors({ installCommand: "npm ci; rm -rf /", buildCommand: "npm run build | tee log", startCommand: "node $(id)" })).toEqual({
      installCommand: [`The install command contains invalid characters. ${SHELL_SAFE}`],
      buildCommand: [`The build command contains invalid characters. ${SHELL_SAFE}`],
      startCommand: [`The start command contains invalid characters. ${SHELL_SAFE}`],
    });
    // A command saved before it was validated stays valid until it changes.
    expect(errors({ installCommand: "npm ci; echo done", buildCommand: "", startCommand: null })).toBeNull();
    expect(errors({ installCommand: "a".repeat(1001) })).toEqual({ installCommand: ["The Install command field must not be greater than 1000 characters."] });
    expect(errors({ dockerComposeCustomStartCommand: "docker compose up -d; id", dockerComposeCustomBuildCommand: "docker compose build > log" })).toEqual({
      dockerComposeCustomStartCommand: [`The Docker Compose start command contains invalid characters. ${SHELL_SAFE}`],
      dockerComposeCustomBuildCommand: [`The Docker Compose build command contains invalid characters. ${SHELL_SAFE}`],
    });
    expect(errors({ installCommand: "npm ci && npm run prepare", dockerComposeCustomBuildCommand: "docker compose build --no-cache" })).toBeNull();
  });

  it("the Dockerfile and Compose locations, the build target, the settings", () => {
    expect(errors({ dockerfileLocation: "Dockerfile", dockerComposeLocation: "/compose file.yaml", dockerfileTargetBuild: "-prod" })).toEqual({
      dockerfileLocation: [`The Dockerfile location ${FILE_PATH}`],
      dockerComposeLocation: [`The Docker Compose location ${FILE_PATH}`],
      dockerfileTargetBuild: ["The Dockerfile target build must contain only alphanumeric characters, dots, hyphens, and underscores."],
    });
    expect(errors({ dockerfileLocation: `/${"a".repeat(255)}`, dockerfileTargetBuild: "a".repeat(129) })).toEqual({
      dockerfileLocation: ["The Dockerfile location field must not be greater than 255 characters."],
      dockerfileTargetBuild: ["The Dockerfile target build field must not be greater than 128 characters."],
    });
    expect(errors({ isStatic: "yes", isSpa: null, isBuildServerEnabled: 2, isPreserveRepositoryEnabled: "" })).toEqual({
      isStatic: ["The Static setting must be true or false."],
      isSpa: ["The SPA setting is required."],
      isBuildServerEnabled: ["The Build Server setting must be true or false."],
      isPreserveRepositoryEnabled: ["The Preserve Repository setting is required."],
    });
    expect(errors({ dockerfile: 5, watchPaths: 5, customNginxConfiguration: 5 })).toEqual({
      dockerfile: ["The Dockerfile field must be a string."],
      watchPaths: ["The Watch paths field must be a string."],
      customNginxConfiguration: ["The Custom Nginx configuration field must be a string."],
    });
    const site = validateBuild({ siteType: "spa" }, stored);
    expect(site.ok && site.input).toMatchObject({ isStatic: true, isSpa: true });
    expect(errors({ siteType: "other" })).toEqual({ siteType: ["The selected site type is invalid."] });
  });

  it("the mutators' helpers: watch paths, the Nginx configuration, the Compose command preview", () => {
    expect(watchPathsForStorage(" /src/pages/** \n\n!/docs/**\n! /tmp \n")).toBe("src/pages/**\n!docs/**\n!tmp");
    expect(watchPathsForStorage("")).toBeNull();
    expect(base64Decode(base64Encode("server { # café }"))).toBe("server { # café }");
    expect(defaultNginxConfiguration()).toContain("try_files $uri $uri.html $uri/index.html $uri/index.htm $uri/ =404;");
    expect(defaultNginxConfiguration("spa")).toContain("try_files $uri $uri/ /index.html;");
    expect(defaultNginxConfiguration("spa").split("\n").slice(0, 3)).toEqual(["server {", "    location / {", "        root /usr/share/nginx/html;"]);
    expect(injectDockerComposeFlags("docker compose build", "./docker-compose.yaml", "/artifacts/build-time.env")).toBe("docker compose -f ./docker-compose.yaml --env-file /artifacts/build-time.env build");
    expect(injectDockerComposeFlags("docker compose -f other.yaml up -d", "./a.yaml", "{workdir}/.env")).toBe("docker compose --env-file {workdir}/.env -f other.yaml up -d");
    expect(injectDockerComposeFlags("docker compose --env-file x up && docker compose ps", "./a.yaml", "e")).toBe("docker compose -f ./a.yaml --env-file x up && docker compose ps");
  });
});

describe("General's save for the build packs (submit, instantSave, updatedBuildPack)", () => {
  it("saves the build fields through the mutators with General's own, in one PATCH, and answers both", async () => {
    const t = setup();
    const uuid = await t.created(t.publicForm({ repository_url: "https://gitlab.com/a/b" }));
    const r = await t.call("PATCH", uuid, {
      name: "shop-web", baseDirectory: "/apps/web/", publishDirectory: "/dist/", installCommand: " npm ci ", buildCommand: "npm run build", startCommand: "",
      watchPaths: "/src/**\n!/docs/**", dockerfileTargetBuild: "",
    });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ message: "Application settings updated!", warning: false });
    expect(t.store.buildUpdates).toEqual([
      { changes: { base_directory: "/apps/web", publish_directory: "/dist", install_command: "npm ci", build_command: "npm run build", watch_paths: "src/**\n!docs/**" }, settings: {} },
    ]);
    expect(t.store.generalUpdates).toEqual([{ name: "shop-web" }]);
    expect(r.body.data!.application).toMatchObject({ name: "shop-web" });
    expect(r.body.data!.build).toMatchObject({ baseDirectory: "/apps/web", publishDirectory: "/dist", installCommand: "npm ci", buildCommand: "npm run build", startCommand: null, watchPaths: "src/**\n!docs/**" });
    // Nothing changed: nothing is written.
    await t.call("PATCH", uuid, { baseDirectory: "/apps/web", publishDirectory: "/dist", installCommand: "npm ci" });
    expect(t.store.buildUpdates).toHaveLength(1);
  });

  it("answers the build fields' errors beside General's and stores nothing", async () => {
    const t = setup();
    const uuid = await t.created(t.publicForm());
    const r = await t.call("PATCH", uuid, { name: "", baseDirectory: "apps", portsExposes: "abc" });
    expect(r.status).toBe(422);
    expect(r.body.error!.details.fields).toEqual({
      name: ["The Name field is required."],
      portsExposes: ["Ports exposes must be a comma-separated list of port numbers (e.g. 3000,3001)."],
      baseDirectory: ["The base directory must be a valid path starting with / and containing only safe characters."],
    });
    expect([t.store.buildUpdates, t.store.generalUpdates]).toEqual([[], []]);
    // The image name is only required for a Docker image application.
    expect((await t.call("PATCH", uuid, { dockerRegistryImageName: "" })).status).toBe(200);
  });

  it("switching the build pack: Static gets port 80 and the default Nginx configuration; leaving Nixpacks ends the static output", async () => {
    const t = setup();
    const uuid = await t.created(t.publicForm({ isStatic: true, port: 80, publish_directory: "/dist" }));
    const r = await t.call("PATCH", uuid, { buildPack: "static" });
    expect(r.status).toBe(200);
    expect(t.store.buildUpdates).toEqual([{ changes: { build_pack: "static", custom_nginx_configuration: base64Encode(defaultNginxConfiguration("static")) }, settings: { is_static: false } }]);
    expect(r.body.data!.application).toMatchObject({ buildPack: "static", portsExposes: "80" });
    expect(r.body.data!.build).toMatchObject({ isStatic: false, siteType: "dynamic", couldSetBuildCommands: false, customNginxConfiguration: defaultNginxConfiguration("static") });

    const other = await t.created(t.publicForm({ port: 3000 }));
    await t.call("PATCH", other, { buildPack: "static" });
    expect(t.stored(other)).toMatchObject({ build_pack: "static", ports_exposes: "80" });
    // To the Dockerfile build pack: the location's default.
    await t.call("PATCH", other, { buildPack: "dockerfile" });
    expect(t.stored(other)).toMatchObject({ build_pack: "dockerfile", dockerfile_location: "/Dockerfile" });
  });

  it("the saving hook cleans up after the build pack that is left", async () => {
    const t = setup();
    const uuid = await t.created(t.publicForm({ build_pack: "dockerfile", selectedDockerfile: "/docker/Dockerfile" }));
    Object.assign(t.stored(uuid), { dockerfile_target_build: "prod", custom_healthcheck_found: true });
    await t.call("PATCH", uuid, { buildPack: "railpack" });
    expect(t.store.buildUpdates.at(-1)!.changes).toEqual({ build_pack: "railpack", dockerfile_location: null, dockerfile_target_build: null, custom_healthcheck_found: false });

    const compose = await t.created(t.publicForm({ build_pack: "dockercompose" }));
    Object.assign(t.stored(compose), { docker_compose_raw: "services: {}", docker_compose_domains: '{"app":{"domain":"https://a.example.com"}}' });
    await t.call("PATCH", compose, { buildPack: "nixpacks" });
    expect(t.store.buildUpdates.at(-1)!.changes).toEqual({ build_pack: "nixpacks", docker_compose_raw: null, docker_compose_domains: null });
    // The SERVICE_FQDN_* and SERVICE_URL_* variables go with it.
    expect(t.store.deletedServiceVariables).toEqual([t.stored(compose).id]);
  });

  it("a Compose application: its commands and their previews are stored; a changed path would load the file from the server", async () => {
    const t = setup();
    const uuid = await t.created(t.publicForm({ build_pack: "dockercompose", base_directory: "/deploy" }));
    const r = await t.call("PATCH", uuid, { dockerComposeCustomBuildCommand: "docker compose build", dockerComposeCustomStartCommand: "docker compose up -d", preDeploymentCommandContainer: "api" });
    expect(r.status).toBe(200);
    expect(r.body.data!.build).toMatchObject({
      dockerComposeBuildCommandPreview: "docker compose -f ./deploy/docker-compose.yaml --env-file /artifacts/build-time.env build",
      dockerComposeStartCommandPreview: "docker compose -f ./deploy/docker-compose.yaml --env-file {workdir}/.env up -d",
    });
    for (const body of [{ dockerComposeLocation: "/compose.yaml" }, { baseDirectory: "/" }]) {
      const refused = await t.call("PATCH", uuid, body);
      expect([refused.status, refused.body.error!.message]).toEqual([501, "Loading the Compose file from the repository needs the SSH executor, which is not available yet."]);
    }
    expect(t.stored(uuid)).toMatchObject({ docker_compose_location: "/docker-compose.yaml", base_directory: "/deploy" });
    // The unchanged paths save.
    expect((await t.call("PATCH", uuid, { dockerComposeLocation: "/docker-compose.yaml", baseDirectory: "/deploy" })).status).toBe(200);
  });

  it("the site type, the builder and 'Preserve repository' save themselves (instantSave); a new SPA setting regenerates the Nginx configuration", async () => {
    const t = setup();
    const uuid = await t.created(t.publicForm());
    const spa = await t.call("PATCH", uuid, { instantSave: true, siteType: "spa" });
    expect(spa.body.data).toMatchObject({ message: "Settings saved.", warning: false });
    expect(t.store.buildUpdates.at(-1)).toEqual({ changes: { custom_nginx_configuration: base64Encode(defaultNginxConfiguration("spa")) }, settings: { is_static: true, is_spa: true } });
    expect(spa.body.data!.build).toMatchObject({ siteType: "spa", isStatic: true, isSpa: true });
    const back = await t.call("PATCH", uuid, { instantSave: true, siteType: "static" });
    expect(t.store.buildUpdates.at(-1)).toEqual({ changes: { custom_nginx_configuration: base64Encode(defaultNginxConfiguration("static")) }, settings: { is_spa: false } });
    expect(back.body.data!.build).toMatchObject({ siteType: "static" });

    await t.call("PATCH", uuid, { instantSave: true, isBuildServerEnabled: true, isPreserveRepositoryEnabled: true });
    expect(t.store.buildUpdates.at(-1)!.settings).toEqual({ is_build_server_enabled: true, is_preserve_repository_enabled: true });
    expect(t.store.clearedFileStorages).toEqual([]);
    // Switched off: the application's file storages are no longer based on Git.
    await t.call("PATCH", uuid, { instantSave: true, isPreserveRepositoryEnabled: false });
    expect(t.store.clearedFileStorages).toEqual([t.stored(uuid).id]);
  });

  it("instantSave is one rule with the label listboxes of DP-53: both are validated together, saved together, answered once", async () => {
    const t = setup({ labels: true });
    const uuid = await t.created(t.publicForm());
    const id = t.stored(uuid).id;
    // One of each wrong: both errors, nothing written.
    const bad = await t.call("PATCH", uuid, { instantSave: true, isContainerLabelEscapeEnabled: "maybe", isSpa: "maybe", isBuildServerEnabled: true });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.error!.details.fields!).sort()).toEqual(["isContainerLabelEscapeEnabled", "isSpa"]);
    expect(t.store.settings.get(id)).toMatchObject({ is_build_server_enabled: false });
    expect(t.store.settings.get(id)!.is_container_label_escape_enabled).toBeUndefined();

    const r = await t.call("PATCH", uuid, { instantSave: true, isContainerLabelEscapeEnabled: false, siteType: "spa" });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ message: "Settings saved.", warning: false });
    expect(t.store.settings.get(id)).toMatchObject({ is_container_label_escape_enabled: false, is_static: true, is_spa: true });
    expect(r.body.data!.application).toMatchObject({ uuid, isContainerLabelEscapeEnabled: false });
    expect(r.body.data!.build).toMatchObject({ siteType: "spa", customNginxConfiguration: defaultNginxConfiguration("spa") });
    // Only a label listbox, or only a build setting: the same answer.
    const labelsOnly = await t.call("PATCH", uuid, { instantSave: true, isContainerLabelEscapeEnabled: true });
    expect(labelsOnly.body.data).toMatchObject({ message: "Settings saved.", build: { siteType: "spa" } });
    expect(t.store.settings.get(id)).toMatchObject({ is_container_label_escape_enabled: true, is_spa: true });
    const buildOnly = await t.call("PATCH", uuid, { instantSave: true, siteType: "dynamic" });
    expect(buildOnly.body.data).toMatchObject({ message: "Settings saved.", build: { siteType: "dynamic" } });
    expect((await t.call("PATCH", "nope", { instantSave: true, siteType: "spa" })).status).toBe(404);

    // A save of the whole form carries both too.
    const whole = await t.call("PATCH", uuid, { name: "both-kinds", baseDirectory: "/apps/web", isContainerLabelEscapeEnabled: false });
    expect(whole.body.data).toMatchObject({ message: "Application settings updated!", application: { name: "both-kinds", isContainerLabelEscapeEnabled: false }, build: { baseDirectory: "/apps/web" } });
  });

  it("generates the default Nginx configuration on request, and stores a custom one base64-encoded", async () => {
    const t = setup();
    const uuid = await t.created(t.publicForm({ build_pack: "static", port: 80 }));
    const generated = await t.call("PATCH", uuid, { generateNginxConfiguration: "spa" });
    expect(generated.body.data).toMatchObject({ message: "Nginx configuration generated." });
    expect(t.stored(uuid).custom_nginx_configuration).toBe(base64Encode(defaultNginxConfiguration("spa")));
    await t.call("PATCH", uuid, { customNginxConfiguration: "server { listen 80; }" });
    expect(t.stored(uuid).custom_nginx_configuration).toBe(base64Encode("server { listen 80; }"));
    // An empty configuration is null: the default is used.
    await t.call("PATCH", uuid, { customNginxConfiguration: "" });
    expect(t.stored(uuid).custom_nginx_configuration).toBeNull();
    expect((await t.call("PATCH", uuid, { generateNginxConfiguration: "apache" })).body.error!.details.fields).toEqual({ generateNginxConfiguration: ["The selected generate nginx configuration is invalid."] });
  });

  it("a changed Dockerfile sets the health check's timing, the port when none is given, and resets when the HEALTHCHECK goes", async () => {
    const t = setup();
    const uuid = await t.created(t.dockerfileForm());
    await t.call("PATCH", uuid, { dockerfile: "FROM node\nEXPOSE 3000\nHEALTHCHECK --interval=20s --retries=2 CMD true\n" });
    expect(t.store.buildUpdates.at(-1)!.changes).toEqual({ dockerfile: "FROM node\nEXPOSE 3000\nHEALTHCHECK --interval=20s --retries=2 CMD true\n", health_check_interval: 20, health_check_retries: 2, custom_healthcheck_found: true });
    // The port is kept: one was set.
    expect(t.stored(uuid).ports_exposes).toBe("80");
    await t.call("PATCH", uuid, { dockerfile: "FROM node\nEXPOSE 3000\n", portsExposes: "" });
    expect(t.store.buildUpdates.at(-1)!.changes).toEqual({ dockerfile: "FROM node\nEXPOSE 3000\n", health_check_interval: 5, health_check_retries: 10, custom_healthcheck_found: false });
    expect(t.stored(uuid).ports_exposes).toBe("3000");
  });

  it("refuses an image name another application of the org builds (otherApplicationBuildingSameImage)", async () => {
    const t = setup();
    const first = await t.created(t.publicForm());
    const second = await t.created(t.publicForm({ repository_url: "https://github.com/a/b" }));
    expect((await t.call("PATCH", first, { dockerRegistryImageName: "ghcr.io/acme/app" })).status).toBe(200);
    const r = await t.call("PATCH", second, { dockerRegistryImageName: "ghcr.io/acme/app", name: "renamed" });
    expect(r.status).toBe(422);
    expect(r.body.error!.details.fields).toEqual({
      dockerRegistryImageName: [
        `The application ${t.stored(first).name as string} also builds the Docker image ghcr.io/acme/app. Freeploy tags each build with the commit SHA (latest for a Dockerfile set in Freeploy, pr-<id>-<commit> for previews) and pushes the Docker image tag only in addition. A different Docker image tag does not keep the images apart, so one application can run the image of the other. Set a different Docker image name for each application in the General settings, for example ghcr.io/acme/app-staging.`,
      ],
    });
    expect(t.stored(second)).toMatchObject({ docker_registry_image_name: null });
    expect(t.stored(second).name).not.toBe("renamed");
  });

  it("hides commands, the Dockerfile and the Nginx configuration from a member who cannot update", async () => {
    const t = setup();
    const uuid = await t.created(t.dockerfileForm());
    Object.assign(t.stored(uuid), { install_command: "npm ci", custom_nginx_configuration: base64Encode("server {}"), docker_compose_raw: "services: {}" });
    const reader = setup({ write: false });
    reader.store.applications.push(t.stored(uuid));
    reader.store.settings.set(t.stored(uuid).id, t.store.settings.get(t.stored(uuid).id)!);
    const r = await reader.call("GET", uuid);
    expect(r.body.data).toMatchObject({ canUpdate: false });
    expect(r.body.data!.build).toMatchObject({ installCommand: null, dockerfile: null, customNginxConfiguration: null, dockerComposeRaw: null, hasDockerfile: true });
    expect((await t.call("GET", uuid)).body.data!.build).toMatchObject({ installCommand: "npm ci", customNginxConfiguration: "server {}", dockerComposeRaw: "services: {}" });
  });
});

describe("routing and authorization", () => {
  it("a member without deploy.resource.write gets 404 on every creation, check and scan", async () => {
    const t = setup({ write: false });
    for (const [path, body] of [["", t.dockerfileForm()], ["", t.publicForm()], ["", { type: "dockercompose" }], ["git/check", { repository_url: "https://gitlab.com/a/b" }], ["git/scan", { git_branch: "main" }]] as const) {
      expect([path, (await t.call("POST", path, body)).status]).toEqual([path, 404]);
    }
    expect(t.store.inserted).toHaveLength(0);
  });

  it("the git actions are POST only, and other names under /git are 404", async () => {
    const t = setup();
    expect((await t.call("GET", "git/check")).status).toBe(405);
    expect((await t.call("POST", "git/clone", {})).status).toBe(404);
  });

  it("a runner without the build store serves Docker image applications only", async () => {
    const t = setup({ build: false });
    expect((await t.call("POST", "", t.dockerfileForm())).status).toBe(503);
  });
});
