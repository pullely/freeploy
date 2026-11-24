// New resource and Docker image applications (DP-49): Coolify's rules and
// messages, the image reference parser, the domain helpers, what a new Docker
// image application is stored as (field by field against DockerImage::submit
// and the model's hooks), General's save, the environment's resources, the
// 501s, and the handler's routing and authorization. The SQL behind the store
// (and its row-level security) is tested in tests/db.
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { handleApplications, handleEnvironmentResources, type ApplicationRunner } from "@deploy-core-worker/handlers/applications";
import { networkAliasesForForm, networkAliasesForStorage, type ApplicationStore } from "@deploy-core-worker/applications/service";
import { parseDockerImage, splitPastedImageName, storedDockerImage } from "@deploy-core-worker/applications/docker-image";
import {
  applicationDomainList,
  domainConflictKey,
  generateUrl,
  isValidDomainUrl,
  normalizeApplicationDomains,
  normalizeDomainPortOverrides,
  parseUrl,
  sslipHostLabel,
  syncNoindexDomains,
  validateApplicationDomains,
} from "@deploy-core-worker/applications/domains";
import { validateCreateDockerImage, validateGeneral } from "@deploy-core-worker/applications/validation";
import { DATABASES, DOCKER_BASED_APPLICATIONS, GIT_BASED_APPLICATIONS } from "@deploy-core-worker/applications/catalogue";
import type {
  ApplicationGeneralChanges,
  DeployApplicationRow,
  DeployDestinationRow,
  DeployEnvironmentListRow,
  DeployProjectRow,
  DeployResourceServerRow,
  DeployServerRow,
  NewDockerImageApplication,
} from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const PUBLIC_ID = /^[a-z0-9]{24}$/;
const SHA = "59e02939b1bf39f16c93138a28727aec520bb916da021180ae502c61626b3cf0";
const SHELL_SAFE =
  "Allowed: alphanumerics, && / || chaining, balanced quotes, globs (*, ?), !, and safe path/arg chars. Blocked: bare &, bare |, ;, $, backtick, (, ), <, >, \\, newlines.";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

interface MemoryServer {
  id: number;
  uuid: string;
  name: string;
  description: string | null;
  ip: string;
  wildcard_domain: string | null;
  server_role: string | null;
  is_build_server: boolean;
  is_reachable: boolean;
  is_usable: boolean;
  is_swarm_manager: boolean;
  is_swarm_worker: boolean;
  force_disabled: boolean;
}

/** One org's projects, servers, destinations, applications and application settings, in memory. */
class MemoryStore implements ApplicationStore {
  projects: DeployProjectRow[] = [{ id: 1, uuid: "prj1", name: "Shop", description: null, created_at: null, updated_at: null }];
  envs: Array<{ id: number; uuid: string; name: string; project_id: number }> = [
    { id: 10, uuid: "env1", name: "production", project_id: 1 },
    { id: 11, uuid: "env2", name: "staging", project_id: 1 },
  ];
  servers: MemoryServer[] = [];
  destinations: Array<{ id: number; uuid: string; name: string; network: string; type: "standalone" | "swarm"; server_id: number }> = [];
  /** What insertDockerImage() was given, as the row deploy.applications gets. */
  inserted: Array<Omit<NewDockerImageApplication, "orgId">> = [];
  applications: Array<Record<string, unknown> & { id: number; uuid: string }> = [];
  settings: Array<{ application_id: number }> = [];
  updates: ApplicationGeneralChanges[] = [];
  private next = 100;

  addServer(over: Partial<MemoryServer> & { uuid: string; name: string }): MemoryServer {
    const server: MemoryServer = {
      id: this.next++, description: null, ip: "203.0.113.10", wildcard_domain: null, server_role: "both", is_build_server: false,
      is_reachable: true, is_usable: true, is_swarm_manager: false, is_swarm_worker: false, force_disabled: false, ...over,
    };
    this.servers.push(server);
    return server;
  }
  addDestination(server: MemoryServer, uuid: string, name: string, network: string, type: "standalone" | "swarm" = "standalone") {
    const destination = { id: this.next++, uuid, name, network, type, server_id: server.id };
    this.destinations.push(destination);
    return destination;
  }
  private usable(kind: "deployment" | "build") {
    return this.servers
      .filter((s) => s.is_reachable && s.is_usable && !s.is_swarm_worker && !s.force_disabled)
      .filter((s) => (kind === "build" ? s.server_role === "build" || (s.server_role === null && s.is_build_server) : ["deployment", "both"].includes(s.server_role ?? "") || (s.server_role === null && !s.is_build_server)))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }
  private destinationRow(d: MemoryStore["destinations"][number]): DeployDestinationRow {
    const s = this.servers.find((x) => x.id === d.server_id)!;
    return { id: d.id, uuid: d.uuid, name: d.name, network: d.network, type: d.type, server_id: s.id, server_uuid: s.uuid, server_name: s.name, server_ip: s.ip, created_at: null, updated_at: null };
  }
  private applicationRow(a: MemoryStore["applications"][number]): DeployApplicationRow {
    const e = this.envs.find((x) => x.id === a.environment_id)!;
    const p = this.projects.find((x) => x.id === e.project_id)!;
    const d = this.destinations.find((x) => x.id === a.destination_id && (a.destination_type as string).endsWith(x.type === "swarm" ? "SwarmDocker" : "StandaloneDocker"));
    const s = d ? this.servers.find((x) => x.id === d.server_id) : undefined;
    return {
      ...a,
      is_container_label_readonly_enabled: true,
      is_container_label_escape_enabled: true,
      environment_uuid: e.uuid,
      environment_name: e.name,
      project_uuid: p.uuid,
      project_name: p.name,
      destination_uuid: d?.uuid ?? null,
      destination_name: d?.name ?? null,
      destination_network: d?.network ?? null,
      server_uuid: s?.uuid ?? null,
      server_name: s?.name ?? null,
      server_ip: s?.ip ?? null,
      server_is_swarm_manager: s?.is_swarm_manager ?? null,
      server_is_swarm_worker: s?.is_swarm_worker ?? null,
      server_is_reachable: s?.is_reachable ?? null,
      server_is_usable: s?.is_usable ?? null,
      server_force_disabled: s?.force_disabled ?? null,
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
  async resourceServers(kind: "deployment" | "build") {
    return this.usable(kind).map((s) => ({ id: s.id, uuid: s.uuid, name: s.name, description: s.description, ip: s.ip, is_swarm_manager: s.is_swarm_manager, is_swarm_worker: s.is_swarm_worker }) as DeployResourceServerRow);
  }
  async usableDestinations() {
    const usable = new Set(this.usable("deployment").map((s) => s.id));
    return this.destinations.filter((d) => usable.has(d.server_id)).map((d) => this.destinationRow(d));
  }
  async findDestination(uuid: string) {
    const d = this.destinations.find((x) => x.uuid === uuid);
    return d ? this.destinationRow(d) : null;
  }
  async findServer(uuid: string) {
    return (this.servers.find((s) => s.uuid === uuid) as unknown as DeployServerRow | undefined) ?? null;
  }
  async insertDockerImage(application: Omit<NewDockerImageApplication, "orgId">) {
    this.inserted.push(application);
    // The columns the SQL sets, then the schema's defaults the pages read.
    const row = {
      id: this.next++,
      uuid: application.uuid,
      name: application.name,
      description: null,
      fqdn: application.fqdn,
      domain_port_overrides: application.domainPortOverrides,
      noindex_domains: null,
      build_pack: "dockerimage",
      status: "exited",
      git_repository: "coollabsio/coolify",
      git_branch: "main",
      docker_registry_image_name: application.dockerRegistryImageName,
      docker_registry_image_tag: application.dockerRegistryImageTag,
      ports_exposes: "80",
      ports_mappings: null,
      custom_network_aliases: null,
      custom_labels: null,
      custom_docker_run_options: null,
      pre_deployment_command: null,
      pre_deployment_command_container: null,
      post_deployment_command: null,
      post_deployment_command_container: null,
      health_check_enabled: false,
      restart_count: 0,
      max_restart_count: 0,
      restart_limit_reached: false,
      container_present: null,
      environment_id: application.environmentId,
      destination_id: application.destinationId,
      destination_type: application.destinationType === "swarm" ? "App\\Models\\SwarmDocker" : "App\\Models\\StandaloneDocker",
    };
    this.applications.push(row);
    this.settings.push({ application_id: row.id });
    return this.applicationRow(row);
  }
  async findByUuid(uuid: string) {
    const a = this.applications.find((x) => x.uuid === uuid);
    return a ? this.applicationRow(a) : null;
  }
  async listForEnvironment(environmentId: string | number) {
    return this.applications.filter((a) => a.environment_id === environmentId).map((a) => this.applicationRow(a));
  }
  async updateGeneral(id: string | number, changes: ApplicationGeneralChanges) {
    const a = this.applications.find((x) => x.id === id);
    if (!a) return null;
    this.updates.push(changes);
    Object.assign(a, changes);
    return this.applicationRow(a);
  }
  async domains() {
    return this.applications
      .filter((a) => typeof a.fqdn === "string" && a.fqdn !== "")
      .map((a) => ({ uuid: a.uuid, name: a.name as string, fqdn: a.fqdn as string, environment_uuid: "env1", project_uuid: "prj1" }));
  }
}

type Body = { data?: Record<string, unknown>; error?: { code: string; message: string; details: { fields?: Record<string, string[]>; conflicts?: unknown[] } } };

function setup(opts: { write?: boolean; read?: boolean } = {}) {
  const store = new MemoryStore();
  const server = store.addServer({ uuid: "srv1", name: "main" });
  store.addDestination(server, "dst1", "freeploy", "coolify");
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
  const encrypted: Array<[string, string]> = [];
  const runner: ApplicationRunner = async (_env, orgId, fn) => {
    orgs.push(orgId);
    return fn({
      store,
      encrypt: async (column, plaintext) => {
        encrypted.push([column, plaintext]);
        return `fp1:${column}`;
      },
    });
  };
  const call = async (method: string, path = "", body?: unknown) => {
    const segments = path.split("/").filter(Boolean);
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleApplications(env, "req_1", actor, ORG_UUID, segments, new Request(`${BASE}/applications${path ? `/${path}` : ""}`, init), runner);
    return { status: res.status, body: (await res.json()) as Body };
  };
  const page = async (projectUuid: string, environmentUuid: string, name: string, method = "GET") => {
    const res = await handleEnvironmentResources(env, "req_1", actor, ORG_UUID, { projectUuid, environmentUuid, page: name }, new Request(`${BASE}/projects/${projectUuid}/environments/${environmentUuid}/${name}`, { method }), runner);
    return { status: res.status, body: (await res.json()) as Body };
  };
  const form = (over: Record<string, unknown> = {}) => ({ type: "dockerimage", project_uuid: "prj1", environment_uuid: "env1", server_uuid: "srv1", destination_uuid: "dst1", imageName: "nginx", imageTag: "", imageSha256: "", ...over });
  /** A Docker image application through the API; its uuid. */
  const create = async (over: Record<string, unknown> = {}) => ((await call("POST", "", form(over))).body.data as { uuid: string }).uuid;
  return { store, server, asked, orgs, encrypted, call, page, form, create, env };
}

describe("DockerImageParser", () => {
  it("splits a reference into registry, name and tag or digest", () => {
    expect(parseDockerImage("nginx")).toEqual({ registryUrl: "", imageName: "nginx", tag: "latest", isImageHash: false });
    expect(parseDockerImage("nginx:1.27-alpine")).toEqual({ registryUrl: "", imageName: "nginx", tag: "1.27-alpine", isImageHash: false });
    expect(parseDockerImage("ghcr.io/user/app:v1.2.3")).toEqual({ registryUrl: "ghcr.io", imageName: "user/app", tag: "v1.2.3", isImageHash: false });
    // A colon before the last slash is a registry port.
    expect(parseDockerImage("localhost:5000/app")).toEqual({ registryUrl: "localhost:5000", imageName: "app", tag: "latest", isImageHash: false });
    expect(parseDockerImage("registry.example.com:5000/team/app:2")).toEqual({ registryUrl: "registry.example.com:5000", imageName: "team/app", tag: "2", isImageHash: false });
    // A path without a dot or colon in its first part has no registry.
    expect(parseDockerImage("library/nginx:stable")).toEqual({ registryUrl: "", imageName: "library/nginx", tag: "stable", isImageHash: false });
    expect(parseDockerImage(`nginx@sha256:${SHA}`)).toEqual({ registryUrl: "", imageName: "nginx", tag: SHA, isImageHash: true });
    // A tag before the digest stays in the name part.
    expect(parseDockerImage(`nginx:stable@sha256:${SHA}`)).toEqual({ registryUrl: "", imageName: "nginx:stable", tag: SHA, isImageHash: true });
    // A bare 64-hex tag counts as a digest; a later colon belongs to a ${VAR:-default} tag.
    expect(parseDockerImage(`nginx:${SHA}`)).toMatchObject({ imageName: "nginx", tag: SHA, isImageHash: true });
    expect(parseDockerImage("app:${TAG:-latest}")).toEqual({ registryUrl: "", imageName: "app", tag: "${TAG:-latest}", isImageHash: false });
  });

  it("stores what DockerImage::submit builds from the form's three fields", () => {
    expect(storedDockerImage({ imageName: "nginx", imageTag: "", imageSha256: "" })).toEqual({ name: "nginx", tag: "latest" });
    expect(storedDockerImage({ imageName: "ghcr.io/user/app", imageTag: "v1.2.3", imageSha256: "" })).toEqual({ name: "ghcr.io/user/app", tag: "v1.2.3" });
    expect(storedDockerImage({ imageName: "localhost:5000/app", imageTag: "", imageSha256: "" })).toEqual({ name: "localhost:5000/app", tag: "latest" });
    // A digest: "@sha256" on the name, "sha256-<hash>" as the tag.
    expect(storedDockerImage({ imageName: "nginx", imageTag: "", imageSha256: SHA })).toEqual({ name: "nginx@sha256", tag: `sha256-${SHA}` });
    expect(storedDockerImage({ imageName: "ghcr.io/user/app", imageTag: "", imageSha256: `sha256:${SHA}` })).toEqual({ name: "ghcr.io/user/app@sha256", tag: `sha256-${SHA}` });
    // The name already carries the marker: it is not appended twice.
    expect(storedDockerImage({ imageName: "nginx@sha256", imageTag: "", imageSha256: SHA })).toEqual({ name: "nginx@sha256", tag: `sha256-${SHA}` });
  });

  it("splits a pasted reference as updatedImageName does", () => {
    const f = (imageName: string, imageTag = "", imageSha256 = "") => splitPastedImageName({ imageName, imageTag, imageSha256 });
    expect(f("ghcr.io/user/app:v1.2.3")).toEqual({ imageName: "ghcr.io/user/app", imageTag: "v1.2.3", imageSha256: "" });
    expect(f(`nginx@sha256:${SHA}`)).toEqual({ imageName: "nginx", imageTag: "", imageSha256: SHA });
    expect(f("nginx:latest")).toEqual({ imageName: "nginx", imageTag: "latest", imageSha256: "" });
    // Nothing to split, or a tag or digest is already filled in.
    expect(f("nginx")).toEqual({ imageName: "nginx", imageTag: "", imageSha256: "" });
    expect(f("localhost:5000/app")).toEqual({ imageName: "localhost:5000/app", imageTag: "", imageSha256: "" });
    expect(f("nginx:1.27", "1.26")).toEqual({ imageName: "nginx:1.27", imageTag: "1.26", imageSha256: "" });
    expect(f("nginx:1.27", "", SHA)).toEqual({ imageName: "nginx:1.27", imageTag: "", imageSha256: SHA });
  });
});

describe("the Docker Image form's rules and messages (DockerImage::submit)", () => {
  const base = { type: "dockerimage", project_uuid: "prj1", environment_uuid: "env1", destination_uuid: "dst1" };

  it("imageName: required, a string, at most 255 characters, DOCKER_IMAGE_NAME_PATTERN — Laravel's default messages", () => {
    const missing = validateCreateDockerImage({ ...base });
    expect(!missing.ok && missing.errors).toEqual({ imageName: ["The image name field is required."] });
    const blank = validateCreateDockerImage({ ...base, imageName: "  " });
    expect(!blank.ok && blank.errors.imageName).toEqual(["The image name field is required."]);
    const notString = validateCreateDockerImage({ ...base, imageName: 5 });
    expect(!notString.ok && notString.errors.imageName).toEqual(["The image name field must be a string."]);
    const long = validateCreateDockerImage({ ...base, imageName: "a".repeat(256) });
    expect(!long.ok && long.errors.imageName).toEqual(["The image name field must not be greater than 255 characters.", "The image name field format is invalid."]);
    for (const bad of ["nginx:latest", "Nginx", "nginx; rm -rf /", "nginx$(id)", "-nginx", "nginx/", "ghcr.io//app", "nginx latest"]) {
      const r = validateCreateDockerImage({ ...base, imageName: bad });
      expect([bad, !r.ok && r.errors.imageName]).toEqual([bad, ["The image name field format is invalid."]]);
    }
    for (const good of ["nginx", "library/nginx", "ghcr.io/user/app", "localhost:5000/app", "registry.example.com:5000/team/my-app_v2", "[2a01:4f8::1]:5000/app", "a__b/c--d", "nginx@sha256"]) {
      expect([good, validateCreateDockerImage({ ...base, imageName: good }).ok]).toEqual([good, true]);
    }
  });

  it("imageTag: nullable, a string, at most 128 characters, DOCKER_IMAGE_TAG_PATTERN", () => {
    const tag = (imageTag: unknown) => validateCreateDockerImage({ ...base, imageName: "nginx", imageTag });
    for (const good of ["latest", "v1.2.3", "1.27-alpine", "_internal", "$TAG", "${TAG}", "${TAG:-latest}", "${TAG-1.0}", "v${MAJOR}.${MINOR}", "a".repeat(128)]) {
      expect([good, tag(good).ok]).toEqual([good, true]);
    }
    for (const bad of ["-latest", ".1", "v1 beta", "v1;id", "$(id)", "${TAG:?err}", "$1", "$$", "${A:-${B}}", "a/b"]) {
      const r = tag(bad);
      expect([bad, !r.ok && r.errors.imageTag]).toEqual([bad, ["The image tag field format is invalid."]]);
    }
    const long = tag("a".repeat(129));
    expect(!long.ok && long.errors.imageTag).toEqual(["The image tag field must not be greater than 128 characters.", "The image tag field format is invalid."]);
    const notString = tag(7);
    expect(!notString.ok && notString.errors.imageTag).toEqual(["The image tag field must be a string."]);
    const empty = tag(null);
    expect(empty.ok && empty.input.imageTag).toBe("");
  });

  it("imageSha256: nullable, a string, 64 hex characters; a tag and a digest together are refused on both fields", () => {
    const sha = (imageSha256: unknown, imageTag = "") => validateCreateDockerImage({ ...base, imageName: "nginx", imageTag, imageSha256 });
    expect(sha(SHA).ok).toBe(true);
    expect(sha(SHA.toUpperCase()).ok).toBe(true);
    for (const bad of ["abc", `sha256:${SHA}`, `${SHA}0`, SHA.replace("5", "g")]) {
      const r = sha(bad);
      expect([bad, !r.ok && r.errors.imageSha256]).toEqual([bad, ["The image sha256 field format is invalid."]]);
    }
    const notString = sha(1);
    expect(!notString.ok && notString.errors.imageSha256).toEqual(["The image sha256 field must be a string."]);
    const both = sha(SHA, "latest");
    expect(!both.ok && both.errors).toEqual({
      imageTag: ["Provide either a tag or SHA256 digest, not both."],
      imageSha256: ["Provide either a tag or SHA256 digest, not both."],
    });
  });

  it("needs the type and the page's project and environment", () => {
    const r = validateCreateDockerImage({ imageName: "nginx", type: "dockerfile" });
    expect(!r.ok && r.errors).toEqual({
      type: ["The selected type is invalid."],
      project_uuid: ["The project uuid field is required."],
      environment_uuid: ["The environment uuid field is required."],
    });
    const ok = validateCreateDockerImage({ ...base, imageName: "nginx", server_uuid: "srv1" });
    expect(ok.ok && ok.input).toEqual({ projectUuid: "prj1", environmentUuid: "env1", serverUuid: "srv1", destinationUuid: "dst1", imageName: "nginx", imageTag: "", imageSha256: "" });
  });
});

describe("General's rules and messages for a Docker image application", () => {
  const stored = { fqdn: "http://app.203.0.113.10.sslip.io" };
  const errors = (body: Record<string, unknown>) => {
    const r = validateGeneral(body, stored);
    return r.ok ? null : r.errors;
  };

  it("name and description: ValidationPatterns with General's 'The Name field is required.'", () => {
    expect(errors({ name: "" })).toEqual({ name: ["The Name field is required."] });
    expect(errors({ name: "a$" })).toEqual({
      name: ["The name must be at least 3 characters.", "The name may only contain letters (including Unicode), numbers, spaces, and these characters: - _ . / @ & ( ) # , : +"],
    });
    expect(errors({ description: "no <tags>" })).toEqual({
      description: ["The description may only contain letters (including Unicode), numbers, spaces, and common punctuation: - _ . , ! ? ( ) ' \" + = * / @ &"],
    });
    const ok = validateGeneral({ name: "web", description: "" }, stored);
    expect(ok.ok && ok.input).toEqual({ name: "web", description: "", forceSaveDomains: false });
  });

  it("the image: the name is required for a Docker image application; both use General's attribute names", () => {
    expect(errors({ dockerRegistryImageName: "" })).toEqual({ dockerRegistryImageName: ["The Docker registry image name field is required."] });
    expect(errors({ dockerRegistryImageName: null })).toEqual({ dockerRegistryImageName: ["The Docker registry image name field is required."] });
    expect(errors({ dockerRegistryImageName: "nginx:latest" })).toEqual({ dockerRegistryImageName: ["The Docker registry image name field format is invalid."] });
    expect(errors({ dockerRegistryImageName: "a".repeat(256) })).toEqual({
      dockerRegistryImageName: ["The Docker registry image name field must not be greater than 255 characters.", "The Docker registry image name field format is invalid."],
    });
    expect(errors({ dockerRegistryImageName: 1 })).toEqual({ dockerRegistryImageName: ["The Docker registry image name field must be a string."] });
    expect(errors({ dockerRegistryImageTag: "v1 beta" })).toEqual({ dockerRegistryImageTag: ["The Docker registry image tag field format is invalid."] });
    expect(errors({ dockerRegistryImageTag: "a".repeat(129) })).toEqual({
      dockerRegistryImageTag: ["The Docker registry image tag field must not be greater than 128 characters.", "The Docker registry image tag field format is invalid."],
    });
    // The stored form of a digest passes both rules.
    expect(errors({ dockerRegistryImageName: "nginx@sha256", dockerRegistryImageTag: `sha256-${SHA}` })).toBeNull();
    const cleared = validateGeneral({ dockerRegistryImageTag: "" }, stored);
    expect(cleared.ok && cleared.input.dockerRegistryImageTag).toBe("");
  });

  it("ports: spaces are removed first; exposes is a list of numbers, mappings Coolify's port mapping pattern", () => {
    const ports = validateGeneral({ portsExposes: " 3000, 3001 ", portsMappings: "8080:80, 127.0.0.1:8443:443/tcp" }, stored);
    expect(ports.ok && ports.input).toMatchObject({ portsExposes: "3000,3001", portsMappings: "8080:80,127.0.0.1:8443:443/tcp" });
    // "… ?: null": an emptied list is null.
    const empty = validateGeneral({ portsExposes: "  ", portsMappings: "" }, stored);
    expect(empty.ok && empty.input).toMatchObject({ portsExposes: null, portsMappings: "" });
    for (const bad of ["80,", "http", "80;90", "80-90", ",80"]) {
      expect([bad, errors({ portsExposes: bad })]).toEqual([bad, { portsExposes: ["Ports exposes must be a comma-separated list of port numbers (e.g. 3000,3001)."] }]);
    }
    expect(errors({ portsExposes: 80 })).toEqual({ portsExposes: ["The Ports exposes field must be a string."] });
    for (const good of ["3000:3000", "8080:80/udp", "127.0.0.1:8080:80", "[::1]::80", ":80", "3000-3005:3000-3005", "3000:3000,3002:3002"]) {
      expect([good, errors({ portsMappings: good })]).toEqual([good, null]);
    }
    for (const bad of ["3000", "a:b", "3000:3000;", "3000:", "3000:3000/icmp", "3000:3000,"]) {
      expect([bad, errors({ portsMappings: bad })]).toEqual([
        bad,
        { portsMappings: ["Port mappings must be a comma-separated list of port pairs or ranges with optional IP and protocol (e.g. 3000:3000, 8080:80/udp, 127.0.0.1:8080:80, [::1]::80)."] },
      ]);
    }
  });

  it("custom Docker options: shell-safe, at most 2000 characters; the command containers a container name", () => {
    expect(errors({ customDockerRunOptions: "--cap-add SYS_ADMIN --device=/dev/fuse --ulimit nofile=1024:1024 --tmpfs /run:rw,noexec,nosuid,size=65536k --hostname=myapp" })).toBeNull();
    expect(errors({ customDockerRunOptions: `--entrypoint "sh -c 'npm start'" && true || false` })).toBeNull();
    for (const bad of ["--name x; id", "--env A=$(id)", "--env A=`id`", "a | b", "a & b", "a > b", '--label "a$b"', "a\nb", "a\\b"]) {
      expect([bad, errors({ customDockerRunOptions: bad })]).toEqual([bad, { customDockerRunOptions: [`The custom Docker run options contain invalid characters. ${SHELL_SAFE}`] }]);
    }
    expect(errors({ customDockerRunOptions: "a".repeat(2001) })).toEqual({ customDockerRunOptions: ["The Custom docker run commands field must not be greater than 2000 characters."] });
    expect(errors({ customDockerRunOptions: 1 })).toEqual({ customDockerRunOptions: ["The Custom docker run commands field must be a string."] });
    expect(errors({ preDeploymentCommandContainer: "my app", postDeploymentCommandContainer: "-x" })).toEqual({
      preDeploymentCommandContainer: ["The pre-deployment command container name must contain only alphanumeric characters, dots, hyphens, and underscores."],
      postDeploymentCommandContainer: ["The post-deployment command container name must contain only alphanumeric characters, dots, hyphens, and underscores."],
    });
    expect(errors({ preDeploymentCommandContainer: "a".repeat(256) })).toEqual({ preDeploymentCommandContainer: ["The pre deployment command container field must not be greater than 255 characters."] });
    // The commands themselves are only 'nullable': any shell is allowed.
    expect(errors({ preDeploymentCommand: "php artisan migrate && echo $HOME; ls | wc", postDeploymentCommand: null, customNetworkAliases: "api.internal, api.local" })).toBeNull();
    expect(errors({ preDeploymentCommand: 1 })).toEqual({ preDeploymentCommand: ["The pre deployment command field must be a string."] });
  });

  it("fqdn: an unchanged value is only 'nullable'; a changed one goes through applicationDomainRules", () => {
    // Unchanged, even if it would not pass today.
    expect(validateGeneral({ fqdn: "not a url" }, { fqdn: "not a url" }).ok).toBe(true);
    expect(errors({ fqdn: "https://app.example.com,http://www.example.com:3000/path" })).toBeNull();
    expect(errors({ fqdn: "app.example.com" })).toEqual({ fqdn: ["Invalid URL: app.example.com"] });
    expect(errors({ fqdn: "ftp://app.example.com" })).toEqual({ fqdn: ["Invalid URL: ftp://app.example.com"] });
    expect(errors({ fqdn: "https://app.example.com;id, https://localhost" })).toEqual({
      fqdn: ["Invalid URL: https://app.example.com;id", "Invalid URL: https://localhost. The hostname must be a fully qualified domain name."],
    });
    expect(errors({ fqdn: "https://app.example.com:0" })).toEqual({ fqdn: ["Invalid port for URL: https://app.example.com:0. The port must be between 1 and 65535."] });
    expect(errors({ fqdn: "https://app.example.com:70000" })).toEqual({ fqdn: ["Invalid URL: https://app.example.com:70000"] });
    expect(errors({ fqdn: 5 })).toEqual({ fqdn: ["The FQDN field must be a string."] });
    expect(errors({ fqdn: `https://${"a".repeat(2040)}.example.com` })?.fqdn?.[0]).toBe("The FQDN field must not be greater than 2048 characters.");
    expect(validateGeneral({ fqdn: "" }, stored).ok).toBe(true);
  });
});

describe("domains", () => {
  it("parse_url for the URLs a domain list holds", () => {
    expect(parseUrl("https://user:pw@App.Example.com:8443/a/b?x=1#top")).toEqual({ scheme: "https", user: "user", pass: "pw", host: "App.Example.com", port: 8443, path: "/a/b", query: "x=1", fragment: "top" });
    expect(parseUrl("http://[2a01:4f8::1]:3000")).toEqual({ scheme: "http", host: "[2a01:4f8::1]", port: 3000 });
    expect(parseUrl("http://[::1]/x")).toEqual({ scheme: "http", host: "[::1]", path: "/x" });
    expect(parseUrl("http://example.com:")).toEqual({ scheme: "http", host: "example.com" });
    // Where PHP answers false.
    expect(parseUrl("http:///path")).toBeNull();
    expect(parseUrl("http://example.com:abc")).toBeNull();
    expect(parseUrl("http://example.com:65536")).toBeNull();
    // No scheme: neither scheme nor host.
    expect(parseUrl("example.com/path")).toEqual({ path: "example.com/path" });
  });

  it("isValidDomainUrl: http(s), a host that is a hostname once '_' reads '-', or a bracketed IPv6", () => {
    for (const good of ["http://example.com", "HTTPS://Example.COM/Path", "https://my_app.example.com", "http://203.0.113.10:8080", "http://[2a01:4f8::1]:3000", "https://xn--bcher-kva.example", "http://localhost"]) {
      expect([good, isValidDomainUrl(good)]).toEqual([good, true]);
    }
    for (const bad of ["example.com", "ftp://example.com", "https://", "https://-bad.example.com", "https://bad-.example.com", "https://a..b", "https://exa mple.com", "https://bücher.example", "http://[zz::1]", `https://${"a".repeat(64)}.com`]) {
      expect([bad, isValidDomainUrl(bad)]).toEqual([bad, false]);
    }
  });

  it("validates, lists and normalizes a domain list", () => {
    expect(applicationDomainList(" ,https://a.example.com , ,http://b.example.com,")).toEqual(["https://a.example.com", "http://b.example.com"]);
    expect(applicationDomainList(null)).toEqual([]);
    expect(validateApplicationDomains("")).toEqual([]);
    expect(validateApplicationDomains(["x"])).toEqual(["The domains field must be a string."]);
    expect(validateApplicationDomains("https://a.example.com,https://203.0.113.10,http://[2a01:4f8::1]")).toEqual([]);
    expect(validateApplicationDomains("https://a.example.com|x")).toEqual(["Invalid URL: https://a.example.com|x"]);
    // Scheme and host in lower case; path, query and fragment as written.
    expect(normalizeApplicationDomains(" HTTPS://App.Example.COM/Path?Q=1 , http://B.example.com:3000 ")).toBe("https://app.example.com/Path?Q=1,http://b.example.com:3000");
    expect(normalizeApplicationDomains(" , ")).toBeNull();
    expect(normalizeApplicationDomains(null)).toBeNull();
  });

  it("the saving hook keeps ports apart from the domains (DomainPortOverrides::normalize)", () => {
    expect(normalizeDomainPortOverrides("https://app.example.com:3000,http://api.example.com/v1", null)).toEqual({
      fqdn: "https://app.example.com,http://api.example.com/v1",
      overrides: { "https://app.example.com": 3000 },
    });
    // A port already kept for a domain stays; the www counterpart shares it; an invalid entry is dropped.
    expect(normalizeDomainPortOverrides("https://app.example.com, https://www.app.example.com,not-a-url", { "https://app.example.com": 8080 })).toEqual({
      fqdn: "https://app.example.com,https://www.app.example.com",
      overrides: { "https://app.example.com": 8080, "https://www.app.example.com": 8080 },
    });
    // The same domain twice: one entry, the later port.
    expect(normalizeDomainPortOverrides("http://a.example.com:1,http://a.example.com:2", null)).toEqual({ fqdn: "http://a.example.com", overrides: { "http://a.example.com": 2 } });
    expect(normalizeDomainPortOverrides("", { "https://x.example.com": 1 })).toEqual({ fqdn: null, overrides: null });
    expect(normalizeDomainPortOverrides("nothing valid", null)).toEqual({ fqdn: null, overrides: null });
  });

  it("drops the noindex flags of domains that are gone", () => {
    expect(syncNoindexDomains(null, "https://a.example.com")).toBeUndefined();
    expect(syncNoindexDomains([], "https://a.example.com")).toBeUndefined();
    expect(syncNoindexDomains(["https://A.example.com", "https://gone.example.com", "https://a.example.com"], "https://a.example.com,https://b.example.com")).toEqual(["https://a.example.com"]);
    expect(syncNoindexDomains(["https://a.example.com"], null)).toEqual([]);
  });

  it("generates a new application's URL from the server's wildcard domain, else sslip.io (generateUrl)", () => {
    expect(generateUrl({ ip: "203.0.113.10", wildcardDomain: null }, "abc")).toBe("http://abc.203.0.113.10.sslip.io");
    expect(generateUrl({ ip: "203.0.113.10", wildcardDomain: "" }, "abc")).toBe("http://abc.203.0.113.10.sslip.io");
    expect(generateUrl({ ip: "2a01:4f8::1", wildcardDomain: null }, "abc")).toBe("http://abc.2a01-4f8--1.sslip.io");
    expect(generateUrl({ ip: "203.0.113.10", wildcardDomain: "https://apps.example.com" }, "abc")).toBe("https://abc.apps.example.com");
    expect(generateUrl({ ip: "203.0.113.10", wildcardDomain: "HTTP://apps.example.com/" }, "abc")).toBe("http://abc.apps.example.com");
    expect(generateUrl({ ip: "203.0.113.10", wildcardDomain: "https://apps.example.com:8443/base" }, "abc")).toBe("https://abc.apps.example.com/base");
    expect(sslipHostLabel("::1")).toBe("0--1");
    expect(sslipHostLabel("2a01:4f8::")).toBe("2a01-4f8--0");
    expect(sslipHostLabel("server.example.com")).toBe("server.example.com");
  });

  it("domainConflictKey: no scheme, no trailing slash, no port", () => {
    expect(domainConflictKey("https://app.example.com/")).toBe("app.example.com");
    expect(domainConflictKey("HTTP://app.example.com:3000/api")).toBe("app.example.com/api");
    expect(domainConflictKey("http://[2a01:4f8::1]:3000")).toBe("[2a01:4f8::1]");
  });
});

describe("the custom_network_aliases mutator and accessor", () => {
  it("stores a JSON list from a comma-separated or JSON value, and reads it back comma-separated", () => {
    expect(networkAliasesForStorage("api.internal, api local ,api.internal,,")).toBe('["api.internal","api-local"]');
    expect(networkAliasesForStorage('["a","b ","a"]')).toBe('["a","b"]');
    expect(networkAliasesForStorage("")).toBeNull();
    expect(networkAliasesForStorage(null)).toBeNull();
    expect(networkAliasesForStorage(" , ")).toBeNull();
    expect(networkAliasesForForm('["api.internal","api-local"]')).toBe("api.internal,api-local");
    expect(networkAliasesForForm("legacy,value")).toBe("legacy,value");
    expect(networkAliasesForForm(null)).toBeNull();
  });
});

describe("the New Resource page (Select)", () => {
  it("lists Coolify's application and database types, word for word, and marks what Freeploy can create", () => {
    expect(GIT_BASED_APPLICATIONS.map((t) => [t.id, t.name])).toEqual([
      ["public", "Public Git Repository"],
      ["private-deploy-key", "Private Git Repository (with Deploy Key)"],
      ["private-gh-app", "Git Repository (with GitHub App)"],
      ["private-gitlab-app", "Git Repository (with GitLab App)"],
      ["private-gitea-app", "Git Repository (with Gitea / Forgejo App)"],
    ]);
    expect(DOCKER_BASED_APPLICATIONS.map((t) => [t.id, t.name])).toEqual([
      ["dockerfile", "Dockerfile"],
      ["docker-compose-empty", "Docker Compose"],
      ["docker-image", "Docker Image"],
    ]);
    expect(DATABASES.map((t) => [t.id, t.name])).toEqual([
      ["postgresql", "PostgreSQL"],
      ["mysql", "MySQL"],
      ["mariadb", "MariaDB"],
      ["redis", "Redis / Valkey"],
      ["keydb", "KeyDB"],
      ["dragonfly", "Dragonfly"],
      ["mongodb", "MongoDB"],
      ["clickhouse", "ClickHouse"],
      ["sqlite", "SQLite"],
    ]);
    const all = [...GIT_BASED_APPLICATIONS, ...DOCKER_BASED_APPLICATIONS, ...DATABASES];
    expect(all.filter((t) => t.creatable).map((t) => t.id)).toEqual(["docker-image"]);
    expect(DOCKER_BASED_APPLICATIONS[2]).toEqual({
      id: "docker-image",
      name: "Docker Image",
      description: "Deploy an application using a prebuilt image from any Docker registry, without a Git repository.",
      documentation: "https://coolify.io/docs/applications",
      logo: "resources/docker-image",
      creatable: true,
    });
    expect(GIT_BASED_APPLICATIONS[0]!.description).toBe("Deploy any public Git repository. Freeploy builds it from source, no credentials required.");
    expect(DATABASES.find((d) => d.id === "sqlite")).toMatchObject({ experimental: true, logo: "resources/sqlite" });
    expect(DATABASES.find((d) => d.id === "redis")).toMatchObject({ logo: "resources/redis-valkey", logoDark: "resources/redis-valkey-dark" });
    expect(all.every((t) => !/coolify/i.test(`${t.name} ${t.description}`))).toBe(true);
  });

  it("answers the usable servers with their destinations, the build servers apart, and the types", async () => {
    const t = setup();
    t.store.addDestination(t.server, "dst2", "apps", "apps");
    const swarm = t.store.addServer({ uuid: "srv2", name: "cluster", description: "the swarm", ip: "203.0.113.20", is_swarm_manager: true });
    t.store.addDestination(swarm, "dst3", "overlay", "coolify-overlay", "swarm");
    t.store.addServer({ uuid: "srv3", name: "builder", server_role: "build" });
    const unvalidated = t.store.addServer({ uuid: "srv4", name: "aaa-new", is_reachable: false, is_usable: false });
    t.store.addDestination(unvalidated, "dst4", "freeploy", "coolify");

    const r = await t.page("prj1", "env2", "new");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      project: { uuid: "prj1", name: "Shop" },
      environment: { uuid: "env2", name: "staging" },
      environments: [
        { uuid: "env1", name: "production" },
        { uuid: "env2", name: "staging" },
      ],
      servers: [
        { uuid: "srv2", name: "cluster", description: "the swarm", ip: "203.0.113.20", isSwarm: true, destinations: [{ uuid: "dst3", name: "overlay", network: "coolify-overlay", type: "swarm" }] },
        {
          uuid: "srv1", name: "main", description: null, ip: "203.0.113.10", isSwarm: false,
          destinations: [
            { uuid: "dst1", name: "freeploy", network: "coolify", type: "standalone" },
            { uuid: "dst2", name: "apps", network: "apps", type: "standalone" },
          ],
        },
      ],
      buildServers: [{ uuid: "srv3", name: "builder" }],
      onlyBuildServerAvailable: false,
      services: [],
      categories: [],
    });
    expect((r.body.data!.dockerBasedApplications as Array<{ id: string }>).map((a) => a.id)).toEqual(["dockerfile", "docker-compose-empty", "docker-image"]);
    expect(r.body.data!.gitBasedApplications).toHaveLength(5);
    expect(r.body.data!.databases).toHaveLength(9);
    // Create::mount() authorizes createAnyResource: the page is asked with write.
    expect(t.asked).toEqual(["deploy.resource.write"]);
  });

  it("says when only build servers are available, and 404s for a project or environment that is not the org's", async () => {
    const t = setup();
    t.server.server_role = "build";
    const r = await t.page("prj1", "env1", "new");
    expect(r.body.data).toMatchObject({ servers: [], buildServers: [{ uuid: "srv1", name: "main" }], onlyBuildServerAvailable: true });
    expect((await t.page("nope", "env1", "new")).status).toBe(404);
    expect((await t.page("prj1", "nope", "new")).status).toBe(404);
    expect((await t.page("prj1", "env1", "new", "POST")).status).toBe(405);
    expect((await t.page("prj1", "env1", "other")).status).toBe(404);
  });
});

describe("creating a Docker image application (DockerImage::submit)", () => {
  it("stores the application and its settings row as Coolify does, field by field, and deploys nothing", async () => {
    const t = setup();
    const r = await t.call("POST", "", t.form({ imageName: "ghcr.io/user/app", imageTag: "v1.2.3" }));
    expect(r.status).toBe(201);
    const uuid = r.body.data!.uuid as string;
    expect(r.body.data).toEqual({ uuid: expect.stringMatching(PUBLIC_ID), projectUuid: "prj1", environmentUuid: "env1" });
    expect(t.store.inserted).toHaveLength(1);
    expect(t.store.inserted[0]).toEqual({
      // BaseModel's creating hook: new_public_id().
      uuid,
      // 'name' => 'docker-image-'.$application->uuid (the second update).
      name: `docker-image-${uuid}`,
      // generateUrl(server: $destination->server, random: $application->uuid): sslip.io for a server without a wildcard domain.
      fqdn: `http://${uuid}.203.0.113.10.sslip.io`,
      domainPortOverrides: null,
      dockerRegistryImageName: "ghcr.io/user/app",
      dockerRegistryImageTag: "v1.2.3",
      // 'environment_id', 'destination_id', 'destination_type' => $destination->getMorphClass().
      environmentId: 10,
      destinationId: t.store.destinations[0]!.id,
      destinationType: "standalone",
      // The creating hook: Str::random(40) for each provider, stored encrypted.
      webhookSecrets: {
        manual_webhook_secret_github: "fp1:manual_webhook_secret_github",
        manual_webhook_secret_gitlab: "fp1:manual_webhook_secret_gitlab",
        manual_webhook_secret_bitbucket: "fp1:manual_webhook_secret_bitbucket",
        manual_webhook_secret_gitea: "fp1:manual_webhook_secret_gitea",
      },
    });
    expect(t.encrypted.map(([column]) => column)).toEqual(["manual_webhook_secret_github", "manual_webhook_secret_gitlab", "manual_webhook_secret_bitbucket", "manual_webhook_secret_gitea"]);
    for (const [, secret] of t.encrypted) expect(secret).toMatch(/^[A-Za-z0-9]{40}$/);
    expect(new Set(t.encrypted.map(([, secret]) => secret)).size).toBe(4);
    // The created hook: one settings row.
    expect(t.store.settings).toEqual([{ application_id: t.store.applications[0]!.id }]);
    expect(t.orgs.every((o) => o === ORG_UUID)).toBe(true);
    expect(t.asked).toEqual(["deploy.resource.write"]);
  });

  it("parses the image: no tag is latest, a digest is name@sha256 with the tag sha256-<hash>", async () => {
    const t = setup();
    await t.create({ imageName: "nginx" });
    await t.create({ imageName: "nginx", imageSha256: SHA });
    await t.create({ imageName: "localhost:5000/team/app", imageTag: "${TAG:-latest}" });
    await t.create({ imageName: "nginx@sha256", imageSha256: SHA.toUpperCase() });
    expect(t.store.inserted.map((a) => [a.dockerRegistryImageName, a.dockerRegistryImageTag])).toEqual([
      ["nginx", "latest"],
      ["nginx@sha256", `sha256-${SHA}`],
      ["localhost:5000/team/app", "${TAG:-latest}"],
      ["nginx@sha256", `sha256-${SHA.toUpperCase()}`],
    ]);
  });

  it("uses the server's wildcard domain for the URL, and a Swarm destination's morph", async () => {
    const t = setup();
    t.server.wildcard_domain = "https://apps.example.com:8443";
    const swarm = t.store.addServer({ uuid: "srv2", name: "cluster", ip: "2a01:4f8::1", is_swarm_manager: true });
    t.store.addDestination(swarm, "dst3", "overlay", "coolify-overlay", "swarm");
    const first = await t.create();
    const second = await t.create({ server_uuid: "srv2", destination_uuid: "dst3", environment_uuid: "env2" });
    expect(t.store.inserted[0]).toMatchObject({ fqdn: `https://${first}.apps.example.com`, domainPortOverrides: null });
    expect(t.store.inserted[1]).toMatchObject({ fqdn: `http://${second}.2a01-4f8--1.sslip.io`, destinationType: "swarm", environmentId: 11 });
  });

  it("answers the form's field errors before touching the store", async () => {
    const t = setup();
    const r = await t.call("POST", "", t.form({ imageName: "nginx:latest", imageTag: "a b" }));
    expect(r.status).toBe(422);
    expect(r.body.error?.details.fields).toEqual({ imageName: ["The image name field format is invalid."], imageTag: ["The image tag field format is invalid."] });
    const both = await t.call("POST", "", t.form({ imageTag: "latest", imageSha256: SHA }));
    expect(both.body.error?.details.fields).toEqual({
      imageTag: ["Provide either a tag or SHA256 digest, not both."],
      imageSha256: ["Provide either a tag or SHA256 digest, not both."],
    });
    expect((await t.call("POST", "", undefined)).status).toBe(422);
    expect(t.orgs).toHaveLength(0);
    expect(t.store.inserted).toHaveLength(0);
  });

  it("'Destination not found.' for a destination that is missing, not the org's, on a build server, or not the given server's", async () => {
    const t = setup();
    const builder = t.store.addServer({ uuid: "srv3", name: "builder", server_role: "build" });
    t.store.addDestination(builder, "dst9", "freeploy", "coolify");
    for (const over of [{ destination_uuid: "nope" }, { destination_uuid: undefined }, { destination_uuid: "dst9", server_uuid: "srv3" }, { server_uuid: "srv3" }]) {
      const r = await t.call("POST", "", t.form(over));
      expect([over, r.status, r.body.error?.message]).toEqual([over, 404, "Destination not found."]);
    }
    // The server is optional (Coolify's form reads only the destination).
    expect((await t.call("POST", "", t.form({ server_uuid: undefined }))).status).toBe(201);
    // A destination of a server that is not validated yet is accepted, as find_resource_destination_for_current_team() does.
    t.server.is_reachable = false;
    expect((await t.call("POST", "", t.form())).status).toBe(201);
    expect(t.store.inserted).toHaveLength(2);
  });

  it("404s for a project or environment that is not the org's", async () => {
    const t = setup();
    expect((await t.call("POST", "", t.form({ project_uuid: "nope" }))).status).toBe(404);
    expect((await t.call("POST", "", t.form({ environment_uuid: "nope" }))).status).toBe(404);
    expect(t.store.inserted).toHaveLength(0);
  });
});

describe("an application's configuration (Configuration, General)", () => {
  it("shows the application with its project, environment, destination and server, status exited", async () => {
    const t = setup();
    const uuid = await t.create({ imageName: "nginx", imageTag: "alpine" });
    t.asked.length = 0;
    const r = await t.call("GET", uuid);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      application: {
        uuid,
        name: `docker-image-${uuid}`,
        description: null,
        fqdn: `http://${uuid}.203.0.113.10.sslip.io`,
        buildPack: "dockerimage",
        status: "exited",
        stoppedAfterRestartLimit: false,
        containerPresent: null,
        dockerRegistryImageName: "nginx",
        dockerRegistryImageTag: "alpine",
        portsExposes: "80",
        portsMappings: null,
        customNetworkAliases: null,
        customDockerRunOptions: null,
        preDeploymentCommand: null,
        preDeploymentCommandContainer: null,
        postDeploymentCommand: null,
        postDeploymentCommandContainer: null,
        isContainerLabelReadonlyEnabled: true,
        isContainerLabelEscapeEnabled: true,
        project: { uuid: "prj1", name: "Shop" },
        environment: { uuid: "env1", name: "production" },
        destination: { uuid: "dst1", name: "freeploy", network: "coolify", type: "standalone" },
        server: { uuid: "srv1", name: "main", ip: "203.0.113.10", isSwarm: false },
      },
      canUpdate: true,
      canDeploy: true,
    });
    expect(t.asked.sort()).toEqual(["deploy.resource.read", "deploy.resource.write"]);
    expect((await t.call("GET", "nosuchapplication")).status).toBe(404);
  });

  it("hides commands and options from a member who cannot update (General::syncData)", async () => {
    const writer = setup();
    const uuid = await writer.create();
    await writer.call("PATCH", uuid, { customDockerRunOptions: "--cap-add SYS_ADMIN", preDeploymentCommand: "php artisan migrate", postDeploymentCommand: "echo done", preDeploymentCommandContainer: "web" });
    const reader = setup({ write: false });
    reader.store.applications = writer.store.applications;
    reader.store.destinations = writer.store.destinations;
    reader.store.servers = writer.store.servers;
    const r = await reader.call("GET", uuid);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      application: { customDockerRunOptions: null, preDeploymentCommand: null, postDeploymentCommand: null, preDeploymentCommandContainer: "web", dockerRegistryImageName: "nginx" },
      canUpdate: false,
      canDeploy: false,
    });
    expect(((await writer.call("GET", uuid)).body.data!.application as Record<string, unknown>).customDockerRunOptions).toBe("--cap-add SYS_ADMIN");
  });

  it("General's save writes only what changed, trims the Docker options, and answers Coolify's toast", async () => {
    const t = setup();
    const uuid = await t.create();
    const r = await t.call("PATCH", uuid, {
      name: "Web shop",
      description: "the site",
      dockerRegistryImageName: "nginx",
      dockerRegistryImageTag: "1.27",
      portsExposes: "3000, 3001",
      portsMappings: "8080:3000",
      customNetworkAliases: "shop.internal, shop local",
      customDockerRunOptions: "  --cap-add SYS_ADMIN  ",
      preDeploymentCommand: "php artisan migrate",
      postDeploymentCommand: "",
    });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ message: "Application settings updated!", warning: false, application: { name: "Web shop", portsExposes: "3000,3001", customNetworkAliases: "shop.internal,shop-local", customDockerRunOptions: "--cap-add SYS_ADMIN" } });
    expect(t.store.updates).toEqual([
      {
        name: "Web shop",
        description: "the site",
        docker_registry_image_tag: "1.27",
        ports_exposes: "3000,3001",
        ports_mappings: "8080:3000",
        custom_network_aliases: '["shop.internal","shop-local"]',
        custom_docker_run_options: "--cap-add SYS_ADMIN",
        pre_deployment_command: "php artisan migrate",
        post_deployment_command: "",
      },
    ]);
    // Nothing changed: nothing is written, the toast still shows.
    const again = await t.call("PATCH", uuid, { name: "Web shop", portsExposes: "3000,3001" });
    expect(again.body.data).toMatchObject({ message: "Application settings updated!" });
    expect(t.store.updates).toHaveLength(1);
    // Fields of other build packs are ignored, as they do not apply to a Docker image.
    await t.call("PATCH", uuid, { buildPack: "nixpacks", gitRepository: "x", installCommand: "npm i", customLabels: "a=b" });
    expect(t.store.updates).toHaveLength(1);
    expect(t.store.applications[0]).toMatchObject({ build_pack: "dockerimage", git_repository: "coollabsio/coolify", custom_labels: null });
    // An emptied Ports Exposes is stored as null.
    await t.call("PATCH", uuid, { portsExposes: "" });
    expect(t.store.updates[1]).toEqual({ ports_exposes: null });
  });

  it("answers General's field errors and stores nothing", async () => {
    const t = setup();
    const uuid = await t.create();
    const r = await t.call("PATCH", uuid, { name: "", dockerRegistryImageName: "", portsExposes: "http", customDockerRunOptions: "a; b" });
    expect(r.status).toBe(422);
    expect(r.body.error?.details.fields).toEqual({
      name: ["The Name field is required."],
      dockerRegistryImageName: ["The Docker registry image name field is required."],
      portsExposes: ["Ports exposes must be a comma-separated list of port numbers (e.g. 3000,3001)."],
      customDockerRunOptions: [`The custom Docker run options contain invalid characters. ${SHELL_SAFE}`],
    });
    expect(t.store.updates).toHaveLength(0);
    expect((await t.call("PATCH", "nosuchapplication", { name: "abc" })).status).toBe(404);
  });

  it("a changed fqdn is normalized, stored without ports, and warned about when it is https on sslip", async () => {
    const t = setup();
    const uuid = await t.create();
    const r = await t.call("PATCH", uuid, { fqdn: " HTTPS://Shop.Example.com:3000/Path , https://www.shop.example.com/Path" });
    expect(r.status).toBe(200);
    expect(t.store.updates[0]).toEqual({
      fqdn: "https://shop.example.com/Path,https://www.shop.example.com/Path",
      domain_port_overrides: JSON.stringify({ "https://shop.example.com/Path": 3000, "https://www.shop.example.com/Path": 3000 }),
    });
    expect(r.body.data).toMatchObject({ warning: false, application: { fqdn: "https://shop.example.com/Path,https://www.shop.example.com/Path" } });
    // Unchanged: not validated again, nothing written.
    await t.call("PATCH", uuid, { fqdn: "https://shop.example.com/Path,https://www.shop.example.com/Path" });
    expect(t.store.updates).toHaveLength(1);
    const invalid = await t.call("PATCH", uuid, { fqdn: "shop.example.com" });
    expect(invalid.body.error?.details.fields).toEqual({ fqdn: ["Invalid URL: shop.example.com"] });
    const sslip = await t.call("PATCH", uuid, { fqdn: "https://shop.203.0.113.10.sslip.io" });
    expect(sslip.body.data).toMatchObject({ warning: true });
    expect(sslip.body.data!.message).toMatch(/^Your configuration is saved, but sslip domain with https is NOT recommended/);
    // Cleared: null, and the overrides go.
    await t.call("PATCH", uuid, { fqdn: "" });
    expect(t.store.updates.at(-1)).toEqual({ fqdn: null, domain_port_overrides: null });
  });

  it("refuses a domain another application of the org uses, unless the save is forced (checkDomainUsage)", async () => {
    const t = setup();
    const first = await t.create();
    const second = await t.create();
    await t.call("PATCH", first, { name: "first", fqdn: "https://shop.example.com" });
    const r = await t.call("PATCH", second, { fqdn: "http://shop.example.com:8080/" });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({
      code: "conflict",
      message: "Domains are already in use by other resources.",
      details: { conflicts: [{ domain: "https://shop.example.com", resource_name: "first", resource_uuid: first, resource_type: "application", message: "Domain https://shop.example.com is already in use by application 'first'" }] },
    });
    expect(t.store.applications[1]!.fqdn).toBe(`http://${second}.203.0.113.10.sslip.io`);
    const forced = await t.call("PATCH", second, { fqdn: "http://shop.example.com:8080/", forceSaveDomains: true });
    expect(forced.status).toBe(200);
    expect(t.store.applications[1]).toMatchObject({ fqdn: "http://shop.example.com/", domain_port_overrides: JSON.stringify({ "http://shop.example.com/": 8080 }) });
    // Its own domain is not a conflict.
    expect((await t.call("PATCH", first, { fqdn: "https://shop.example.com,https://www.shop.example.com" })).status).toBe(409);
    expect((await t.call("PATCH", first, { fqdn: "https://shop.example.com,https://other.example.com", forceSaveDomains: false })).status).toBe(409);
  });
});

describe("the environment's resources (Resource\\Index)", () => {
  it("lists the environment's applications by name with what the view shows", async () => {
    const t = setup();
    const b = await t.create();
    const a = await t.create();
    await t.create({ environment_uuid: "env2" });
    await t.call("PATCH", b, { name: "beta", description: "second" });
    await t.call("PATCH", a, { name: "alpha" });
    t.asked.length = 0;
    const r = await t.page("prj1", "env1", "resources");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      project: { uuid: "prj1", name: "Shop" },
      environment: { uuid: "env1", name: "production" },
      resources: [
        {
          uuid: a, name: "alpha", type: "application", typeLabel: "Application", fqdn: `http://${a}.203.0.113.10.sslip.io`, description: null, status: "exited",
          restartLimitReached: false, restartCount: 0, maxRestartCount: 0, server_status: true, buildPack: "dockerimage", destination: { server: { name: "main" } }, tags: [],
        },
        {
          uuid: b, name: "beta", type: "application", typeLabel: "Application", fqdn: `http://${b}.203.0.113.10.sslip.io`, description: "second", status: "exited",
          restartLimitReached: false, restartCount: 0, maxRestartCount: 0, server_status: true, buildPack: "dockerimage", destination: { server: { name: "main" } }, tags: [],
        },
      ],
      canCreate: true,
    });
    expect(t.asked.sort()).toEqual(["deploy.resource.read", "deploy.resource.write"]);
    // The server is not functional (not reachable): server_status false.
    t.server.is_reachable = false;
    expect(((await t.page("prj1", "env1", "resources")).body.data!.resources as Array<{ server_status: boolean }>)[0]!.server_status).toBe(false);
    expect(((await t.page("prj1", "env2", "resources")).body.data!.resources as unknown[]).length).toBe(1);
    expect((await t.page("prj1", "nope", "resources")).status).toBe(404);
  });

  it("a reader lists the resources with canCreate false, and cannot open the New Resource page", async () => {
    const t = setup({ write: false });
    const r = await t.page("prj1", "env1", "resources");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ resources: [], canCreate: false });
    expect((await t.page("prj1", "env1", "new")).status).toBe(404);
  });
});

describe("what needs the SSH executor", () => {
  it("deploy, restart and stop answer 501 and change nothing", async () => {
    const t = setup();
    const uuid = await t.create();
    for (const [action, message] of [
      ["deploy", "Deploying the application needs the SSH executor, which is not available yet."],
      ["restart", "Restarting the application needs the SSH executor, which is not available yet."],
      ["stop", "Stopping the application needs the SSH executor, which is not available yet."],
    ] as const) {
      const r = await t.call("POST", `${uuid}/${action}`);
      expect([action, r.status, r.body.error?.code, r.body.error?.message]).toEqual([action, 501, "unsupported", message]);
      expect([action, (await t.call("POST", `nosuchapplication/${action}`)).status]).toEqual([action, 404]);
      expect([action, (await t.call("GET", `${uuid}/${action}`)).status]).toEqual([action, 405]);
    }
    expect(t.store.applications[0]!.status).toBe("exited");
    expect(t.store.updates).toHaveLength(0);
  });
});

describe("routing and authorization", () => {
  it("there is no list and no delete; unknown paths are 404", async () => {
    const t = setup();
    const uuid = await t.create();
    expect((await t.call("GET")).status).toBe(405);
    expect((await t.call("DELETE", uuid)).status).toBe(405);
    expect((await t.call("PUT", uuid)).status).toBe(405);
    expect((await t.call("POST", `${uuid}/delete`)).status).toBe(404);
    expect((await t.call("GET", `${uuid}/deploy/more`)).status).toBe(404);
    expect((await t.call("GET", "bad uuid")).status).toBe(404);
    expect(t.store.applications).toHaveLength(1);
  });

  it("a member without deploy.resource.write gets 404 on every write, and reads with canUpdate false", async () => {
    const t = setup({ write: false });
    for (const [method, path] of [["POST", ""], ["PATCH", "app1"], ["POST", "app1/deploy"], ["POST", "app1/restart"], ["POST", "app1/stop"]] as const) {
      const r = await t.call(method, path, t.form());
      expect([method, path, r.status, r.body.error?.code]).toEqual([method, path, 404, "not_found"]);
    }
    expect(t.orgs).toHaveLength(0);
    expect(t.store.inserted).toHaveLength(0);
  });

  it("a member without deploy.resource.read gets 404 on every read", async () => {
    const t = setup({ read: false });
    expect((await t.call("GET", "app1")).status).toBe(404);
    expect((await t.page("prj1", "env1", "resources")).status).toBe(404);
    expect(t.orgs).toHaveLength(0);
  });

  it("route() sends the applications paths and the two environment pages to the handler behind the same checks", async () => {
    const bare: Env = { ENVIRONMENT: "test" };
    const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
    for (const path of ["/applications", "/applications/app1", "/applications/app1/deploy", "/projects/prj1/environments/env1/new", "/projects/prj1/environments/env1/resources"]) {
      const method = path === "/applications" || path.endsWith("/deploy") ? "POST" : "GET";
      expect([path, (await route(new Request(`${BASE}${path}`, { method }), bare)).status]).toEqual([path, 401]);
      expect([path, (await route(new Request(`https://x/v1/organizations/not-an-org/deploy${path}`, { method, headers }), bare)).status]).toEqual([path, 404]);
      // Routed to the handler: without bindings it answers 503.
      expect([path, (await route(new Request(`${BASE}${path}`, { method, headers }), bare)).status]).toEqual([path, 503]);
    }
    expect((await route(new Request(`${BASE}/applications/app1/deploy/more`, { headers }), bare)).status).toBe(404);
    expect((await route(new Request(`${BASE}/applications/app1`, { method: "DELETE", headers }), bare)).status).toBe(405);
    expect((await route(new Request(`${BASE}/projects/prj1/environments/env1/new`, { method: "POST", headers }), bare)).status).toBe(405);
    // Another fourth segment is still the projects handler's 404.
    expect((await route(new Request(`${BASE}/projects/prj1/environments/env1/canvas`, { headers }), bare)).status).toBe(404);
    expect((await route(new Request(`${BASE}/projects/prj1/other/env1/new`, { headers }), bare)).status).toBe(404);
  });
});
