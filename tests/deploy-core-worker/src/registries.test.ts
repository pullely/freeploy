// Docker registries (DP-47): the overview and a server's Registries page —
// Coolify's registry names, the rows of a card, the login form's rules and
// messages, what needs SSH answering "not available yet" with nothing stored,
// and the routing and authorization through route(), handleRegistries and
// handleServers. The SQL behind the store is tested in tests/db.
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { handleRegistries, handleServerRegistries, type RegistryRunner } from "@deploy-core-worker/handlers/registries";
import { handleServers, type ServerRunner } from "@deploy-core-worker/handlers/servers";
import { normalizeRegistry, parseConfig, providerFor, providerPreset, REGISTRY_PATTERN, registryFromImage, registryRows } from "@deploy-core-worker/registries/logins";
import { registriesCard, REGISTRY_MESSAGES, registryUsers, type DockerConfigReader, type RegistryStore } from "@deploy-core-worker/registries/service";
import { validateRegistryLogin, validateSelectedServers } from "@deploy-core-worker/registries/validation";
import type { DeployRegistryUserRow, DeployServerRow } from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy`;
const SERVER = "srvaaaaaaaaaaaaaaaaaaaaa";
const BUILD = "srvbbbbbbbbbbbbbbbbbbbbb";
const actor = { subjectId: "usr_1", subjectType: "user" };
const SSH = "needs the SSH executor, which is not available yet.";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

function serverRow(over: Partial<DeployServerRow> = {}): DeployServerRow {
  return {
    id: 1, uuid: SERVER, name: "prod-1", description: null, ip: "203.0.113.10", port: 22, user: "root", private_key_id: 100, private_key_uuid: null,
    proxy: {}, validation_logs: null, server_metadata: null, is_validating: false, hetzner_server_id: null, vultr_instance_id: null,
    hostinger_virtual_machine_id: null, created_at: null, updated_at: null, settings_id: 1, is_reachable: false, is_usable: false, force_disabled: false,
    is_swarm_manager: false, is_swarm_worker: false, is_build_server: false, server_role: "both", connection_timeout: 10, wildcard_domain: null,
    public_ipv4: null, public_ipv6: null, server_timezone: "UTC", is_metrics_enabled: false, is_sentinel_enabled: true, is_image_scan_enabled: false,
    ssh_host_key_pending: null, is_cloudflare_tunnel: false, org_uses_swarm: false,
    ...over,
  };
}

function userRow(type: DeployRegistryUserRow["type"], name: string, image: string | null, over: Partial<DeployRegistryUserRow> = {}): DeployRegistryUserRow {
  const kind = type === "Database" ? "database" : type === "Service" ? "service" : "application";
  return { type, kind, image, uuid: `${kind.slice(0, 3)}-${name}`, name, environment_uuid: "env1", project_uuid: "prj1", ...over };
}

/** One org's servers and the resources that use images on them. Nothing can be written: registries have no table. */
class MemoryStore implements RegistryStore {
  rows: DeployServerRow[] = [serverRow(), serverRow({ id: 2, uuid: BUILD, name: "builder", server_role: "build" })];
  users = new Map<string | number, DeployRegistryUserRow[]>();
  builds = new Map<string | number, DeployRegistryUserRow[]>();
  async servers() {
    return [...this.rows].sort((a, b) => a.name.localeCompare(b.name));
  }
  async findServer(uuid: string) {
    return this.rows.find((s) => s.uuid === uuid) ?? null;
  }
  async imageUsers(serverId: string | number) {
    return this.users.get(serverId) ?? [];
  }
  async buildApplications(serverId: string | number) {
    return this.builds.get(serverId) ?? [];
  }
}

type Body = { data?: Record<string, unknown>; error?: { code: string; message: string; details: { fields?: Record<string, string[]>; denied?: string } } };
type Card = { uuid: string; name: string; isFunctional: boolean; error: string | null; registries: Array<{ registry: string; logged_in: boolean; source: string | null; username: string | null; used_by: Array<{ type: string; name: string; link: string | null }> }> };

function setup(opts: { write?: boolean; read?: boolean; readDockerConfig?: DockerConfigReader | null } = {}) {
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
  const runner: RegistryRunner = async (_env, orgId, fn) => {
    orgs.push(orgId);
    return fn({ store, readDockerConfig: opts.readDockerConfig ?? null });
  };
  const init = (method: string, body?: unknown): RequestInit => (body === undefined ? { method } : { method, body: JSON.stringify(body) });
  /** /registries */
  const call = async (method: string, body?: unknown, path = "") => {
    const res = await handleRegistries(env, "req_1", actor, ORG_UUID, path.split("/").filter(Boolean), new Request(`${BASE}/registries/${path}`, init(method, body)), runner);
    return { status: res.status, body: (await res.json()) as Body };
  };
  /** /servers/{uuid}/registries/{path} */
  const server = async (method: string, uuid: string, path = "", body?: unknown) => {
    const res = await handleServerRegistries(env, "req_1", actor, ORG_UUID, uuid, path.split("/").filter(Boolean), new Request(`${BASE}/servers/${uuid}/registries/${path}`, init(method, body)), runner);
    return { status: res.status, body: (await res.json()) as Body };
  };
  return { env, store, asked, orgs, call, server };
}

const login = (over: Record<string, unknown> = {}) => ({ provider: "ghcr", registry: "", username: "octocat", password: "ghp_secret", ...over });

describe("registry names (DockerRegistryLogins)", () => {
  it("normalizeRegistry: a config key as a registry host; Docker Hub's hosts are docker.io", () => {
    expect(normalizeRegistry("https://index.docker.io/v1/")).toBe("docker.io");
    expect(normalizeRegistry("registry-1.docker.io")).toBe("docker.io");
    expect(normalizeRegistry("registry.hub.docker.com/library")).toBe("docker.io");
    expect(normalizeRegistry("  GHCR.io \n")).toBe("ghcr.io");
    expect(normalizeRegistry("http://Registry.Example.com:5000/v2/")).toBe("registry.example.com:5000");
    expect(normalizeRegistry("oci+https://[2A01:4F8::1]:5000/x")).toBe("[2a01:4f8::1]:5000");
    expect(normalizeRegistry("")).toBe("");
  });

  it("registryFromImage: the first path part is a registry only with a dot or a port, or as localhost", () => {
    expect(registryFromImage("nginx")).toBe("docker.io");
    expect(registryFromImage("  ")).toBe("docker.io");
    expect(registryFromImage("library/nginx:1.27")).toBe("docker.io");
    expect(registryFromImage("docker.io/library/nginx")).toBe("docker.io");
    expect(registryFromImage("index.docker.io/acme/web")).toBe("docker.io");
    expect(registryFromImage("ghcr.io/acme/web:latest")).toBe("ghcr.io");
    expect(registryFromImage("localhost/web")).toBe("localhost");
    expect(registryFromImage("registry:5000/web")).toBe("registry:5000");
    expect(registryFromImage(" GHCR.IO/acme/web ")).toBe("ghcr.io");
  });

  it("REGISTRY_PATTERN: a host with an optional port, an IPv6 host in brackets", () => {
    for (const ok of ["ghcr.io", "registry.example.com:5000", "localhost", "a", "[2a01:4f8::1]:5000", "10.0.0.1:443"]) expect(REGISTRY_PATTERN.test(ok)).toBe(true);
    for (const bad of ["", "-x.io", "x.io-", "GHCR.io", "ghcr.io/acme", "x.io:123456", "user@x.io", "x.io; rm -rf /", "[2a01::g]", "x.io\n"]) expect(REGISTRY_PATTERN.test(bad)).toBe(false);
  });

  it("providerFor: a fixed host, a host pattern, else Other", () => {
    expect(providerFor("docker.io")).toBe("dockerhub");
    expect(providerFor("ghcr.io")).toBe("ghcr");
    expect(providerFor("registry.gitlab.com")).toBe("gitlab");
    expect(providerFor("europe-west1-docker.pkg.dev")).toBe("google");
    expect(providerFor("eu.gcr.io")).toBe("google");
    expect(providerFor("myregistry.azurecr.io")).toBe("azure");
    expect(providerFor("123456789012.dkr.ecr.eu-west-1.amazonaws.com")).toBe("aws");
    expect(providerFor("registry.example.com")).toBe("custom");
    expect(providerPreset("nope").label).toBe("Other");
    expect(providerPreset("aws").username).toBe("AWS");
  });
});

describe("parseConfig: the logins of a Docker config, names and usernames only", () => {
  const auth = (value: string) => Buffer.from(value, "utf8").toString("base64");

  it("reads auths before credHelpers, by name, the first entry of a registry winning", () => {
    const config = JSON.stringify({
      auths: {
        "registry.example.com:5000": { auth: auth("deploy:s3cret:with:colons") },
        "https://index.docker.io/v1/": { auth: auth("octocat:hunter2") },
        "docker.io": { auth: auth("second:x") },
        "ghcr.io": { username: "named", password: "p", auth: auth("ignored:x") },
        "Not A Host": { auth: auth("x:y") },
      },
      credHelpers: { "123456789012.dkr.ecr.eu-west-1.amazonaws.com": "ecr-login", "ghcr.io": "also-ignored" },
    });
    const parsed = parseConfig(config);
    expect(Object.keys(parsed)).toEqual(["123456789012.dkr.ecr.eu-west-1.amazonaws.com", "docker.io", "ghcr.io", "registry.example.com:5000"]);
    expect(parsed).toEqual({
      "123456789012.dkr.ecr.eu-west-1.amazonaws.com": { source: "credHelpers", username: null },
      "docker.io": { source: "auths", username: "octocat" },
      "ghcr.io": { source: "auths", username: "named" },
      "registry.example.com:5000": { source: "auths", username: "deploy" },
    });
    // No password leaves the function.
    expect(JSON.stringify(parsed)).not.toMatch(/hunter2|s3cret/);
  });

  it("a username that cannot be read is null; what is not a config is no login", () => {
    const usernames = (auths: Record<string, unknown>) => Object.values(parseConfig(JSON.stringify({ auths }))).map((l) => l.username);
    expect(usernames({ "a.io": { auth: "not base64!" }, "b.io": { auth: auth("nocolon") }, "c.io": { auth: auth(":onlypassword") }, "d.io": {}, "e.io": "text", "f.io": { auth: `${auth("u:p")}=` } })).toEqual([null, null, null, null, null, null]);
    expect(usernames({ "a.io": { auth: Buffer.from([0xff, 0xfe, 0x3a, 0x70]).toString("base64") }, "b.io": { auth: ` ${auth("spaced:p")}\n` }, "c.io": { auth: auth("unpadded:pw").replace(/=+$/, "") } })).toEqual([null, "spaced", "unpadded"]);
    for (const nothing of [null, "", "{", "null", "3", '"text"', '{"auths": "x"}', "{}"]) expect(parseConfig(nothing)).toEqual({});
  });
});

describe("the rows of a card (rows, usersOf)", () => {
  it("one row per registry, by name: the logins with the registries the resources use", () => {
    const rows = registryRows({ "ghcr.io": { source: "auths", username: "octocat" }, "quay.io": { source: "credHelpers", username: null } }, [
      { registry: "docker.io", type: "Database", name: "db", link: null },
      { registry: "ghcr.io", type: "Application", name: "web", link: "/project/p/environment/e/application/a" },
      { registry: "docker.io", type: "Service", name: "plausible", link: null },
    ]);
    expect(rows).toEqual([
      { registry: "docker.io", logged_in: false, source: null, username: null, used_by: [{ type: "Database", name: "db", link: null }, { type: "Service", name: "plausible", link: null }] },
      { registry: "ghcr.io", logged_in: true, source: "auths", username: "octocat", used_by: [{ type: "Application", name: "web", link: "/project/p/environment/e/application/a" }] },
      { registry: "quay.io", logged_in: true, source: "credHelpers", username: null, used_by: [] },
    ]);
    expect(registryRows({}, [])).toEqual([]);
  });

  it("usersOf: resources with a named image; a service once per registry; builds only on a build server", async () => {
    const store = new MemoryStore();
    store.users.set(1, [
      userRow("Application", "web", "ghcr.io/acme/web"),
      userRow("Application", "plain", null),
      userRow("Application", "blank", "  "),
      userRow("Database", "db", "postgres:16-alpine", { environment_uuid: null, project_uuid: null }),
      userRow("Service", "plausible", "ghcr.io/plausible/community-edition:v2"),
      userRow("Service", "plausible", "ghcr.io/plausible/other"),
      userRow("Service", "plausible", "clickhouse/clickhouse-server:24"),
    ]);
    store.builds.set(1, [userRow("Build", "ignored", "ghcr.io/acme/ignored")]);
    store.builds.set(2, [userRow("Build", "pushed", "registry.example.com:5000/pushed")]);
    expect(await registryUsers(store, store.rows[0]!)).toEqual([
      { registry: "ghcr.io", type: "Application", name: "web", link: "/project/prj1/environment/env1/application/app-web" },
      { registry: "docker.io", type: "Database", name: "db", link: null },
      { registry: "ghcr.io", type: "Service", name: "plausible", link: "/project/prj1/environment/env1/service/ser-plausible" },
      { registry: "docker.io", type: "Service", name: "plausible", link: "/project/prj1/environment/env1/service/ser-plausible" },
    ]);
    expect(await registryUsers(store, store.rows[1]!)).toEqual([{ registry: "registry.example.com:5000", type: "Build", name: "pushed", link: "/project/prj1/environment/env1/application/app-pushed" }]);
    // A legacy row without a role follows the build flag.
    expect(await registryUsers(store, { id: 2, server_role: null, is_build_server: false })).toEqual([]);
    expect(await registryUsers(store, { id: 2, server_role: null, is_build_server: true })).toHaveLength(1);
  });

  it("a card: not reachable, not readable yet, read, or unreadable", async () => {
    const store = new MemoryStore();
    store.users.set(1, [userRow("Application", "web", "ghcr.io/acme/web")]);
    const used = [{ type: "Application", name: "web", link: "/project/prj1/environment/env1/application/app-web" }];
    const functional = serverRow({ is_reachable: true, is_usable: true });
    // Not validated: Coolify's message, and the registries the resources use.
    expect(await registriesCard({ store, readDockerConfig: null }, store.rows[0]!)).toEqual({
      uuid: SERVER, name: "prod-1", isFunctional: false, error: "The server is not reachable. Validate the server to read its registry logins.",
      registries: [{ registry: "ghcr.io", logged_in: false, source: null, username: null, used_by: used }],
    });
    // A placeholder address or a disabled server is not functional either, and is never asked.
    const never: DockerConfigReader = async () => {
      throw new Error("a server that is not functional is not asked");
    };
    for (const row of [serverRow({ is_reachable: true, is_usable: true, ip: "1.2.3.4" }), serverRow({ is_reachable: true, is_usable: true, force_disabled: true })]) {
      expect((await registriesCard({ store, readDockerConfig: never }, row)).error).toBe(REGISTRY_MESSAGES.notReachable);
    }
    // Functional, but no SSH executor: the card says so, and no registry is claimed either way.
    const unread = await registriesCard({ store, readDockerConfig: null }, functional);
    expect(unread.error).toBe(`Reading the Docker configuration on the server ${SSH}`);
    expect(unread.isFunctional).toBe(true);
    expect(unread.registries.map((r) => [r.registry, r.logged_in])).toEqual([["ghcr.io", false]]);
    // With a reader (the executor, later): the logins are read from the server.
    const asked: string[] = [];
    const reader: DockerConfigReader = async (uuid) => {
      asked.push(uuid);
      return JSON.stringify({ auths: { "ghcr.io": { auth: Buffer.from("octocat:pw").toString("base64") }, "quay.io": {} } });
    };
    const read = await registriesCard({ store, readDockerConfig: reader }, functional);
    expect(asked).toEqual([SERVER]);
    expect(read.error).toBeNull();
    expect(read.registries).toEqual([
      { registry: "ghcr.io", logged_in: true, source: "auths", username: "octocat", used_by: used },
      { registry: "quay.io", logged_in: true, source: "auths", username: null, used_by: [] },
    ]);
    expect(JSON.stringify(read)).not.toContain("pw");
    // The read fails: Coolify's message.
    const failing: DockerConfigReader = async () => {
      throw new Error("ssh: connect to host 203.0.113.10 port 22: Connection refused");
    };
    const failed = await registriesCard({ store, readDockerConfig: failing }, functional);
    expect(failed.error).toBe("Could not read the Docker configuration on this server.");
    expect(failed.registries.map((r) => r.logged_in)).toEqual([false]);
  });
});

describe("validation (Login::login, Coolify's and Laravel's messages)", () => {
  it("the servers of the overview: at least one, as a list, without repeats", () => {
    for (const none of [undefined, null, "", "  ", []]) expect(validateSelectedServers(none)).toEqual({ ok: false, errors: { selectedServers: ["Choose at least one server."] } });
    expect(validateSelectedServers(SERVER)).toEqual({ ok: false, errors: { selectedServers: ["The selected servers field must be an array."] } });
    expect(validateSelectedServers([SERVER, BUILD, SERVER])).toEqual({ ok: true, uuids: [SERVER, BUILD] });
  });

  it("a provider with a fixed host uses it; Other normalizes what was typed", () => {
    expect(validateRegistryLogin(login({ registry: "ignored.example.com" }))).toEqual({ ok: true, input: { registry: "ghcr.io", username: "octocat", password: "ghp_secret", edit: false } });
    expect(validateRegistryLogin(login({ provider: "custom", registry: " https://Registry.Example.com:5000/v2/ " }))).toMatchObject({ ok: true, input: { registry: "registry.example.com:5000" } });
    expect(validateRegistryLogin(login({ provider: "custom", registry: "https://index.docker.io/v1/" }))).toMatchObject({ ok: true, input: { registry: "docker.io" } });
    // An unknown provider is Other.
    expect(validateRegistryLogin(login({ provider: "nope", registry: "quay.io" }))).toMatchObject({ ok: true, input: { registry: "quay.io" } });
  });

  it("the registry: required, a string, at most 255 characters, a registry host", () => {
    const errors = (body: Record<string, unknown>) => {
      const v = validateRegistryLogin(login({ provider: "custom", ...body }));
      return v.ok ? null : v.errors;
    };
    const host = "Enter a registry host, for example ghcr.io or registry.example.com:5000.";
    expect(errors({ registry: "" })).toEqual({ registry: ["The registry field is required."] });
    expect(errors({ registry: "https:///" })).toEqual({ registry: ["The registry field is required."] });
    expect(errors({ registry: undefined })).toEqual({ registry: ["The registry field is required."] });
    expect(errors({ registry: 42 })).toEqual({ registry: ["The registry field must be a string."] });
    expect(errors({ registry: "user@ghcr.io" })).toEqual({ registry: [host] });
    expect(errors({ registry: "ghcr.io; rm -rf ~" })).toEqual({ registry: [host] });
    expect(errors({ registry: `${"a".repeat(253)}.io` })).toEqual({ registry: ["The registry field must not be greater than 255 characters."] });
    expect(errors({ registry: `${"a".repeat(253)}_io` })).toEqual({ registry: ["The registry field must not be greater than 255 characters.", host] });
    expect(errors({ registry: `${"a".repeat(252)}.io` })).toBeNull();
  });

  it("a provider with a host pattern checks the typed host, with its own message — once", () => {
    const errors = (provider: string, registry: string) => {
      const v = validateRegistryLogin(login({ provider, registry }));
      return v.ok ? null : v.errors;
    };
    expect(errors("google", "europe-west1-docker.pkg.dev")).toBeNull();
    expect(errors("google", "gcr.io")).toBeNull();
    expect(errors("google", "ghcr.io")).toEqual({ registry: ["Enter a valid Google Artifact Registry host, for example europe-west1-docker.pkg.dev. Choose Other for a different registry."] });
    expect(errors("google", "not a host")).toEqual({ registry: ["Enter a valid Google Artifact Registry host, for example europe-west1-docker.pkg.dev. Choose Other for a different registry."] });
    expect(errors("azure", "myregistry.azurecr.io")).toBeNull();
    expect(errors("azure", "myregistry.azurecr.com")).toEqual({ registry: ["Enter a valid Azure Container Registry host, for example myregistry.azurecr.io. Choose Other for a different registry."] });
    expect(errors("aws", "123456789012.dkr.ecr.eu-west-1.amazonaws.com")).toBeNull();
    expect(errors("aws", "12345.dkr.ecr.eu-west-1.amazonaws.com")).toEqual({ registry: ["Enter a valid AWS ECR host, for example 123456789012.dkr.ecr.eu-west-1.amazonaws.com. Choose Other for a different registry."] });
    expect(errors("aws", "")).toEqual({ registry: ["The registry field is required."] });
  });

  it("editing keeps the login's registry: no provider host, no host pattern", () => {
    expect(validateRegistryLogin(login({ provider: "google", registry: "typed.example.com", editRegistry: "https://Registry.Example.com:5000/" }))).toEqual({
      ok: true,
      input: { registry: "registry.example.com:5000", username: "octocat", password: "ghp_secret", edit: true },
    });
    expect(validateRegistryLogin(login({ editRegistry: "bad host" }))).toEqual({ ok: false, errors: { registry: ["Enter a registry host, for example ghcr.io or registry.example.com:5000."] } });
  });

  it("the username and the password", () => {
    const errors = (body: Record<string, unknown>) => {
      const v = validateRegistryLogin(login(body));
      return v.ok ? null : v.errors;
    };
    expect(errors({ username: "", password: "" })).toEqual({ username: ["The username field is required."], password: ["The password field is required."] });
    expect(errors({ username: 1, password: 2 })).toEqual({ username: ["The username field must be a string."], password: ["The password field must be a string."] });
    expect(errors({ username: "octo cat" })).toEqual({ username: ["The username must not contain spaces."] });
    expect(errors({ username: "octo\tcat" })).toEqual({ username: ["The username must not contain spaces."] });
    expect(errors({ username: "a".repeat(256) })).toEqual({ username: ["The username field must not be greater than 255 characters."] });
    expect(errors({ username: "_json_key", password: "x".repeat(20000) })).toBeNull();
    expect(errors({ password: "x".repeat(20001) })).toEqual({ password: ["The password field must not be greater than 20000 characters."] });
    // Every field at once, in the form's order.
    expect(Object.keys(errors({ provider: "custom", registry: "", username: "", password: "" })!)).toEqual(["registry", "username", "password"]);
  });
});

describe("GET /registries (DockerRegistries)", () => {
  it("a card per server by name, with the registries its resources use and the providers", async () => {
    const t = setup();
    t.store.users.set(1, [userRow("Application", "web", "ghcr.io/acme/web"), userRow("Database", "db", "postgres:16-alpine")]);
    t.store.builds.set(2, [userRow("Build", "pushed", "ghcr.io/acme/pushed")]);
    const r = await t.call("GET");
    expect(r.status).toBe(200);
    const servers = r.body.data!.servers as Card[];
    expect(servers.map((s) => [s.name, s.isFunctional, s.error])).toEqual([
      ["builder", false, REGISTRY_MESSAGES.notReachable],
      ["prod-1", false, REGISTRY_MESSAGES.notReachable],
    ]);
    expect(servers[0]!.registries).toEqual([{ registry: "ghcr.io", logged_in: false, source: null, username: null, used_by: [{ type: "Build", name: "pushed", link: "/project/prj1/environment/env1/application/app-pushed" }] }]);
    expect(servers[1]!.registries.map((x) => [x.registry, x.used_by.map((u) => u.type)])).toEqual([
      ["docker.io", ["Database"]],
      ["ghcr.io", ["Application"]],
    ]);
    const providers = r.body.data!.providers as Array<Record<string, string>>;
    expect(providers.map((p) => [p.value, p.label])).toEqual([
      ["dockerhub", "Docker Hub"],
      ["ghcr", "GitHub Container Registry"],
      ["gitlab", "GitLab Container Registry"],
      ["google", "Google Artifact Registry"],
      ["azure", "Azure Container Registry"],
      ["aws", "AWS ECR"],
      ["custom", "Other"],
    ]);
    expect(providers[3]).toEqual({ value: "google", label: "Google Artifact Registry", registry: "", username: "_json_key", placeholder: "europe-west1-docker.pkg.dev", hint: "Paste the JSON key of a service account with the Artifact Registry Reader role.", hostPattern: "(^|\\.)gcr\\.io$|-docker\\.pkg\\.dev$" });
    expect(providers.map((p) => p.hostPattern === null)).toEqual([true, true, true, false, false, false, true]);
    expect(t.orgs).toEqual([ORG_UUID]);
  });

  it("a functional server's logins cannot be read yet: the card says so", async () => {
    const t = setup();
    t.store.rows = [serverRow({ is_reachable: true, is_usable: true })];
    const servers = (await t.call("GET")).body.data!.servers as Card[];
    expect(servers).toEqual([{ uuid: SERVER, name: "prod-1", isFunctional: true, error: `Reading the Docker configuration on the server ${SSH}`, registries: [] }]);
  });

  it("an org without servers has no cards", async () => {
    const t = setup();
    t.store.rows = [];
    expect((await t.call("GET")).body.data!.servers).toEqual([]);
  });
});

describe("POST /registries (Login::login on the chosen servers)", () => {
  it("asks for the servers first, then the form, then answers that docker login is not available yet", async () => {
    const t = setup();
    // targetServers() runs before the form's rules: only its error shows.
    const none = await t.call("POST", login({ selectedServers: [], username: "" }));
    expect(none.status).toBe(422);
    expect(none.body.error!.details.fields).toEqual({ selectedServers: ["Choose at least one server."] });
    // A server that is not the org's: abort_if(…, 403), before the form's rules.
    const foreign = await t.call("POST", login({ selectedServers: [SERVER, "srvzzzzzzzzzzzzzzzzzzzzz"], username: "" }));
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toMatchObject({ code: "forbidden", message: "Forbidden" });
    const invalid = await t.call("POST", login({ selectedServers: [SERVER], provider: "custom", registry: "bad host", username: "a b", password: "" }));
    expect(invalid.status).toBe(422);
    expect(invalid.body.error!.details.fields).toEqual({
      registry: ["Enter a registry host, for example ghcr.io or registry.example.com:5000."],
      username: ["The username must not contain spaces."],
      password: ["The password field is required."],
    });
    // The overview's form never edits a login: editRegistry is ignored.
    const edit = await t.call("POST", login({ selectedServers: [SERVER], provider: "google", registry: "ghcr.io", editRegistry: "ghcr.io" }));
    expect(edit.status).toBe(422);
    const ok = await t.call("POST", login({ selectedServers: [SERVER, BUILD, SERVER] }));
    expect(ok.status).toBe(501);
    expect(ok.body.error).toMatchObject({ code: "unsupported", message: `Running docker login on the server ${SSH}` });
    expect(JSON.stringify(ok.body)).not.toContain("ghp_secret");
  });
});

describe("/servers/{uuid}/registries (Registries, ServerRegistries, Login)", () => {
  it("GET: the server and its card", async () => {
    const t = setup();
    t.store.users.set(1, [userRow("Service", "plausible", "ghcr.io/plausible/community-edition:v2")]);
    const r = await t.server("GET", SERVER);
    expect(r.status).toBe(200);
    expect(r.body.data!.server).toMatchObject({ uuid: SERVER, name: "prod-1", isFunctional: false });
    expect(r.body.data!.card).toEqual({
      uuid: SERVER, name: "prod-1", isFunctional: false, error: REGISTRY_MESSAGES.notReachable,
      registries: [{ registry: "ghcr.io", logged_in: false, source: null, username: null, used_by: [{ type: "Service", name: "plausible", link: "/project/prj1/environment/env1/service/ser-plausible" }] }],
    });
    expect(r.body.data!.canUpdate).toBe(true);
    expect((r.body.data!.providers as unknown[]).length).toBe(7);
    expect((await t.server("GET", "srvzzzzzzzzzzzzzzzzzzzzz")).status).toBe(404);
  });

  it("POST: the form's rules, then docker login is not available yet — nothing is stored", async () => {
    const t = setup();
    const invalid = await t.server("POST", SERVER, "", login({ provider: "aws", registry: "ecr.example.com" }));
    expect(invalid.status).toBe(422);
    expect(invalid.body.error!.details.fields).toEqual({ registry: ["Enter a valid AWS ECR host, for example 123456789012.dkr.ecr.eu-west-1.amazonaws.com. Choose Other for a different registry."] });
    for (const body of [login(), login({ editRegistry: "registry.example.com:5000" }), login({ provider: "google", registry: "europe-west1-docker.pkg.dev", username: "_json_key", password: '{"type":"service_account"}' })]) {
      const r = await t.server("POST", SERVER, "", body);
      expect(r.status).toBe(501);
      expect(r.body.error).toMatchObject({ code: "unsupported", message: `Running docker login on the server ${SSH}` });
    }
    expect((await t.server("POST", "srvzzzzzzzzzzzzzzzzzzzzz", "", login())).status).toBe(404);
    // The card is as before: no login appeared.
    const card = (await t.server("GET", SERVER)).body.data!.card as Card;
    expect(card.registries).toEqual([]);
  });

  it("POST …/{registry}/check and DELETE …/{registry}: the name is checked, then not available yet", async () => {
    const t = setup();
    for (const registry of ["ghcr.io", "registry.example.com%3A5000", "%5B2a01%3A4f8%3A%3A1%5D%3A5000", "https%3A%2F%2Findex.docker.io%2Fv1%2F"]) {
      const check = await t.server("POST", SERVER, `${registry}/check`, {});
      expect(check.status).toBe(501);
      expect(check.body.error).toMatchObject({ code: "unsupported", message: `Running docker login on the server ${SSH}` });
      const logout = await t.server("DELETE", SERVER, registry);
      expect(logout.status).toBe(501);
      expect(logout.body.error).toMatchObject({ code: "unsupported", message: `Running docker logout on the server ${SSH}` });
    }
    for (const bad of ["bad%20host", "x.io%3B%20rm%20-rf", `${"a".repeat(260)}.io`]) {
      const check = await t.server("POST", SERVER, `${bad}/check`, {});
      expect(check.status).toBe(422);
      expect(check.body.error).toMatchObject({ code: "validation_failed", message: "The registry name is not valid." });
      expect((await t.server("DELETE", SERVER, bad)).body.error!.message).toBe("The registry name is not valid.");
    }
    expect((await t.server("DELETE", SERVER, "%E0%A4%A")).status).toBe(404);
    expect((await t.server("POST", "srvzzzzzzzzzzzzzzzzzzzzz", "ghcr.io/check", {})).status).toBe(404);
    expect((await t.server("DELETE", "srvzzzzzzzzzzzzzzzzzzzzz", "ghcr.io")).status).toBe(404);
  });

  it("answers 404 for unknown paths and 405 for other methods", async () => {
    const t = setup();
    expect((await t.server("GET", SERVER, "ghcr.io/check/more")).status).toBe(404);
    expect((await t.server("GET", SERVER, "ghcr.io/other")).status).toBe(404);
    expect((await t.server("PATCH", SERVER)).status).toBe(405);
    expect((await t.server("GET", SERVER, "ghcr.io")).status).toBe(405);
    expect((await t.server("GET", SERVER, "ghcr.io/check")).status).toBe(405);
    expect((await t.server("GET", "bad uuid")).status).toBe(404);
    expect((await t.call("GET", undefined, "more")).status).toBe(404);
    expect((await t.call("DELETE")).status).toBe(405);
    expect(t.asked).toEqual([]);
  });
});

describe("authorization and routing", () => {
  it("every route needs deploy.resource.write, the reads too (Coolify: team admins)", async () => {
    const t = setup({ write: false });
    for (const r of [await t.call("GET"), await t.call("POST", login({ selectedServers: [SERVER] })), await t.server("GET", SERVER), await t.server("POST", SERVER, "", login()), await t.server("DELETE", SERVER, "ghcr.io"), await t.server("POST", SERVER, "ghcr.io/check", {})]) {
      expect(r.status).toBe(404);
      expect(r.body.error!.code).toBe("not_found");
    }
    expect(new Set(t.asked)).toEqual(new Set(["deploy.resource.write"]));
    expect(t.orgs).toEqual([]);
  });

  it("handleServers hands /servers/{uuid}/registries to the Registries page", async () => {
    const t = setup({ write: false });
    const unused = (async () => {
      throw new Error("the servers runner is not used by the registries routes");
    }) as ServerRunner;
    const res = await handleServers(t.env, "req_1", actor, ORG_UUID, [SERVER, "registries"], new Request(`${BASE}/servers/${SERVER}/registries`), unused);
    expect(res.status).toBe(404);
    expect(t.asked).toEqual(["deploy.resource.write"]);
  });

  it("route(): 401 without an actor, 404 for a bad org id, and the paths reach their handlers", async () => {
    const t = setup({ write: false });
    const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
    expect((await route(new Request(`${BASE}/registries`), t.env)).status).toBe(401);
    expect((await route(new Request(`${BASE}/servers/${SERVER}/registries/ghcr.io/check`, { method: "POST" }), t.env)).status).toBe(401);
    expect((await route(new Request(`https://x/v1/organizations/nope/deploy/registries`, { headers }), t.env)).status).toBe(404);
    expect(t.asked).toEqual([]);
    for (const [method, path] of [
      ["GET", "registries"],
      ["POST", "registries/"],
      ["GET", `servers/${SERVER}/registries`],
      ["POST", `servers/${SERVER}/registries/ghcr.io/check`],
      ["DELETE", `servers/${SERVER}/registries/registry.example.com%3A5000`],
    ] as const) {
      const res = await route(new Request(`${BASE}/${path}`, { method, headers }), t.env);
      const body = (await res.json()) as Body;
      // The denial of the write policy: the request reached its handler.
      expect([res.status, body.error!.details.denied !== undefined]).toEqual([404, true]);
    }
    expect(t.asked).toHaveLength(5);
    expect((await route(new Request(`${BASE}/registries/more`, { headers }), t.env)).status).toBe(404);
    expect((await route(new Request(`${BASE}/servers/${SERVER}/registries/a/check/more`, { headers }), t.env)).status).toBe(404);
  });
});
