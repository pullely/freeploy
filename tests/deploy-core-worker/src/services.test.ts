// One-click services through the handler (DP-59): the catalogue the New Resource page lists — against
// what Coolify's own Select::loadServices returns (fixtures/services/select-golden.json, emit-select.php) —
// what creating a service hands the store (the rows of the parser, which service-parser.test.ts holds to
// PHP, with their values encrypted), a service read back, the refusals, authorization and routing. The SQL
// behind the store is tested in tests/db.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "@deploy-core-worker/env";
import { route } from "@deploy-core-worker/router";
import { handleServices, type ServiceRunner } from "@deploy-core-worker/handlers/services";
import { headline } from "@deploy-core-worker/services/catalogue-build";
import { listServiceTemplates, serviceCategories, serviceLogoUrls, serviceWebsiteUrl, templateLastUpdated, validateCreateService, type ServiceStore } from "@deploy-core-worker/services/service";
import type { DeployDestinationRow, DeployEnvironmentListRow, DeployProjectRow, DeployServerRow, DeployServicePartRow, DeployServiceRow, DeployServiceServerRow, NewParsedService } from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy`;
const actor = { subjectId: "usr_1", subjectType: "user" };
type Body = Record<string, unknown>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

/** One org's project, servers and destinations, and the services stored, in memory. */
class MemoryStore implements ServiceStore {
  servers = [
    { id: 100, uuid: "srv1", ip: "203.0.113.10", wildcard_domain: null as string | null, server_role: "both", is_build_server: false, proxy: { type: "TRAEFIK" } as unknown },
    { id: 101, uuid: "srvb", ip: "203.0.113.11", wildcard_domain: null as string | null, server_role: "build", is_build_server: true, proxy: {} as unknown },
  ];
  destinations = [
    { id: 200, uuid: "dst1", network: "coolify", server_id: 100 },
    { id: 201, uuid: "dstb", network: "coolify", server_id: 101 },
  ];
  inserted: Array<Omit<NewParsedService, "orgId">> = [];

  async findProject(uuid: string) {
    return uuid === "prj1" ? ({ id: 1, uuid: "prj1", name: "Shop", description: null, created_at: null, updated_at: null } as DeployProjectRow) : null;
  }
  async findEnvironment(projectId: string | number, uuid: string) {
    return projectId === 1 && uuid === "env1" ? ({ id: 10, uuid: "env1", name: "production", description: null, project_id: 1, created_at: null, updated_at: null, resource_count: 0 } as DeployEnvironmentListRow) : null;
  }
  async findDestination(uuid: string) {
    const d = this.destinations.find((x) => x.uuid === uuid);
    const s = this.servers.find((x) => x.id === d?.server_id);
    return d && s ? ({ id: d.id, uuid: d.uuid, name: "default", network: d.network, type: "standalone", server_id: s.id, server_uuid: s.uuid, server_name: "main", server_ip: s.ip, created_at: null, updated_at: null } as DeployDestinationRow) : null;
  }
  async findServer(uuid: string) {
    return (this.servers.find((x) => x.uuid === uuid) as unknown as DeployServerRow | undefined) ?? null;
  }
  async serviceServer(serverId: string | number) {
    const s = this.servers.find((x) => x.id === serverId);
    return s ? ({ id: s.id, uuid: s.uuid, ip: s.ip, proxy: s.proxy, wildcard_domain: s.wildcard_domain, generate_exact_labels: false, traefik_certificate_resolver: "letsencrypt", is_traffic_analytics_enabled: false } as DeployServiceServerRow) : null;
  }
  async insert(service: Omit<NewParsedService, "orgId">) {
    this.inserted.push(service);
    return this.inserted.length;
  }
  async findByUuid(uuid: string) {
    const index = this.inserted.findIndex((s) => s.uuid === uuid);
    const s = this.inserted[index];
    if (!s) return null;
    return {
      id: index + 1, uuid: s.uuid, name: s.name, description: null, service_type: s.serviceType, docker_compose_raw: s.dockerComposeRaw, docker_compose: s.dockerCompose,
      connect_to_docker_network: s.connectToDockerNetwork, compose_parsing_version: s.composeParsingVersion, environment_id: 10, environment_uuid: "env1", environment_name: "production",
      project_uuid: "prj1", project_name: "Shop", server_id: s.serverId, destination_id: s.destinationId, destination_type: "App\\Models\\StandaloneDocker", created_at: null, updated_at: null,
    } as DeployServiceRow;
  }
  private parts(serviceId: string | number, kind: "applications" | "databases") {
    const s = this.inserted[Number(serviceId) - 1];
    return (s?.[kind] ?? []).map(
      (p, index) => ({ id: index + 1, uuid: p.uuid, name: p.name, human_name: p.humanName, image: p.image, ports: p.ports, status: "exited", fqdn: "fqdn" in p ? p.fqdn : null, exclude_from_status: p.excludeFromStatus, is_removed_from_compose: p.isRemovedFromCompose }) as DeployServicePartRow,
    );
  }
  async applications(serviceId: string | number) {
    return this.parts(serviceId, "applications");
  }
  async databases(serviceId: string | number) {
    return this.parts(serviceId, "databases");
  }
}

function setup(opts: { write?: boolean; read?: boolean } = {}) {
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
  const runner: ServiceRunner = async (_env, _orgId, fn) =>
    fn({ store, encryptVariable: async (plaintext) => `fp1:variable:${plaintext}`, encryptFileContent: async (plaintext) => `fp1:file:${plaintext.length}` });
  let counter = 0;
  const deps = { newUuid: () => `uuid${String(++counter).padStart(20, "0")}`, parser: { magicValue: (command: string, key: string) => (command === "" ? null : `generated-${key}`) } };
  const call = async (method: string, path = "", body?: unknown) => {
    const segments = path.split("/").filter(Boolean);
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleServices(env, "req_1", actor, ORG_UUID, segments, new Request(`${BASE}/services${path ? `/${path}` : ""}`, init), runner, deps);
    return { status: res.status, body: (await res.json()) as Body };
  };
  const form = (over: Record<string, unknown> = {}) => ({ type: "one-click-service-umami", project_uuid: "prj1", environment_uuid: "env1", server_uuid: "srv1", destination_uuid: "dst1", ...over });
  return { store, env, call, form };
}

interface SelectGolden {
  services: Record<string, Record<string, unknown>>;
  categories: string[];
}
const golden = JSON.parse(readFileSync(join(process.cwd(), "fixtures", "services", "select-golden.json"), "utf8")) as SelectGolden;

describe("the catalogue for the New Resource page, against Coolify's Select::loadServices", () => {
  const listed = listServiceTemplates();

  it("lists every template with Coolify's name, links, logos and flags", () => {
    expect(listed.services.map((s) => s.id)).toEqual(Object.keys(golden.services));
    const different: string[] = [];
    for (const service of listed.services) {
      const expected = golden.services[service.id] ?? {};
      // What Freeploy changes on purpose: no Coolify tracking parameters, its own origin for the logos, and
      // no logo URL on another host (Coolify's logo_cdn_url, in its GitHub repository).
      const comparable: Record<string, unknown> = {
        ...service,
        website: service.website === null ? null : `${service.website}?ref=coolify.io`,
        documentation: service.documentation === "https://coolify.io/docs" ? service.documentation : `${service.documentation}?utm_source=coolify.io`,
        logo: `http://localhost${service.logo}`,
        logo_default_url: `http://localhost${service.logo_default_url}`,
      };
      expect(String(expected.logo_cdn_url)).toMatch(/^https:\/\/raw\.githubusercontent\.com\/|^http:\/\/localhost\/svgs\/default\.webp$/);
      delete expected.logo_cdn_url;
      // The golden has no dates: Coolify's come from git and from file times.
      delete comparable.templateLastUpdated;
      for (const key of new Set([...Object.keys(comparable), ...Object.keys(expected)])) {
        if (JSON.stringify(comparable[key]) !== JSON.stringify(expected[key])) different.push(`${service.id}.${key}: ${JSON.stringify(comparable[key])} instead of ${JSON.stringify(expected[key])}`);
      }
    }
    expect(different).toEqual([]);
    expect(listed.services).toHaveLength(359);
  });

  it("carries no Compose file, and no logo on another host", () => {
    for (const service of listed.services) expect(Object.keys(service)).not.toEqual(expect.arrayContaining(["compose"]));
    for (const service of listed.services) expect([service.logo, service.logo_default_url].every((url) => /^\/(?!\/)/.test(url))).toBe(true);
    expect(JSON.stringify(listed)).not.toContain("githubusercontent");
    expect(JSON.stringify(listed).length).toBeLessThan(400_000);
  });

  it("lists Coolify's categories in Coolify's order", () => {
    expect(listed.categories).toEqual(golden.categories);
    expect(serviceCategories([{ category: "ai, CMS" }, { category: "cms" }, { category: null }, { category: "Zeta" }, { category: "storage" }])).toEqual(["AI", "CMS", "CMS", "storage", "Zeta"]);
  });

  it("formats names, dates, sites and logos as Coolify does", () => {
    expect(headline("n8n-with-postgresql")).toBe(golden.services["n8n-with-postgresql"]?.name);
    // What PHP's Str::headline answers for these (laravel/framework 12.72.0, PHP 8.3.6).
    const headlines = { "x.yaml": "X.yaml", denoKV: "Deno K V", "9router": "9Router", "foo_bar baz": "Foo Bar Baz", "it's-ok": "It's Ok", "my-app.v2.yml": "My App.v2.Yml", "ABC-def": "A B C Def", "a--b__c": "A B C", "0-zero": "Zero" };
    for (const [value, expected] of Object.entries(headlines)) expect(headline(value)).toBe(expected);
    expect(templateLastUpdated("2026-11-16T08:50:06+01:00")).toBe("Nov 16, 2026 07:50");
    expect(templateLastUpdated(null)).toBeNull();
    expect(templateLastUpdated("not a date")).toBeNull();
    expect(serviceWebsiteUrl("https://github.com/decolua/9router/tree/main?utm_source=coolify.io")).toBe("https://github.com/decolua/9router");
    expect(serviceWebsiteUrl("https://www.Example.com/docs/start")).toBe("https://www.Example.com");
    expect(serviceWebsiteUrl("ftp://example.com")).toBeNull();
    expect(serviceWebsiteUrl(null)).toBeNull();
    expect(serviceLogoUrls("svg/x.svg")).toEqual({ logo: "/svgs/x.svg", logo_default_url: "/svgs/default.webp" });
    expect(serviceLogoUrls(null)).toEqual({ logo: "/svgs/default.webp", logo_default_url: "/svgs/default.webp" });
  });

  it("answers GET /services/templates to a reader", async () => {
    const { call } = setup({ write: false });
    const r = await call("GET", "templates");
    expect(r.status).toBe(200);
    const data = r.body.data as { services: unknown[]; categories: string[] };
    expect(data.services).toHaveLength(359);
    expect(data.categories).toEqual(golden.categories);
  });
});

describe("POST /services: a one-click service", () => {
  it("stores the service and what its Compose file is parsed into", async () => {
    const { store, call, form } = setup();
    const r = await call("POST", "", form());
    expect(r.status).toBe(201);
    expect(r.body.data).toEqual({ uuid: "uuid00000000000000000001", name: "umami-uuid00000000000000000001", projectUuid: "prj1", environmentUuid: "env1" });
    const [service] = store.inserted;
    expect(service).toMatchObject({
      uuid: "uuid00000000000000000001",
      name: "umami-uuid00000000000000000001",
      environmentId: 10,
      serverId: 100,
      destinationId: 200,
      destinationType: "standalone",
      serviceType: "umami",
      composeParsingVersion: "5",
      connectToDockerNetwork: false,
      isContainerLabelEscapeEnabled: true,
      includeCoolifyDefaultVariables: true,
    });
    expect(service?.dockerComposeRaw.startsWith("services:\n  umami:\n    image: ")).toBe(true);
    expect(service?.dockerCompose).toContain("container_name: umami-uuid00000000000000000001");
    expect(service?.dockerCompose).toContain("COOLIFY_PROJECT_NAME: Shop");
    expect(service?.dockerCompose).toContain("- traefik.http.routers.http-0-uuid00000000000000000001-umami");
    expect(service?.applications.map((a) => [a.localId, a.uuid, a.name, a.fqdn])).toEqual([[1, "uuid00000000000000000002", "umami", "http://umami-uuid00000000000000000001.203.0.113.10.sslip.io"]]);
    expect(service?.databases.map((d) => [d.localId, d.uuid, d.name])).toEqual([[1, "uuid00000000000000000003", "postgresql"]]);
    expect(service?.persistentVolumes).toEqual([{ uuid: expect.stringMatching(/^uuid\d{20}$/) as string, name: "uuid00000000000000000001_postgresql-data", mountPath: "/var/lib/postgresql/data", owner: { kind: "database", localId: 1 } }]);
    expect(service?.fileVolumes).toEqual([]);
  });

  it("encrypts every variable's value, and leaves an empty one null", async () => {
    const { store, call, form } = setup();
    await call("POST", "", form());
    const variables = Object.fromEntries((store.inserted[0]?.variables ?? []).map((v) => [v.key, v.value]));
    expect(variables.SERVICE_URL_UMAMI).toBe("fp1:variable:http://umami-uuid00000000000000000001.203.0.113.10.sslip.io");
    expect(variables.SERVICE_FQDN_UMAMI_3000).toBe("fp1:variable:umami-uuid00000000000000000001.203.0.113.10.sslip.io:3000");
    expect(variables.SERVICE_PASSWORD_POSTGRES).toBe("fp1:variable:generated-SERVICE_PASSWORD_POSTGRES");
    expect(variables.POSTGRES_DB).toBe("fp1:variable:umami");
    expect((store.inserted[0]?.variables ?? []).every((v) => v.version === "4.7.6" && /^uuid\d{20}$/.test(v.uuid) && !v.isPreview)).toBe(true);
    // A variable without a value is stored as NULL, not as an encrypted empty string.
    const { store: other, call: create, form: otherForm } = setup();
    await create("POST", "", otherForm({ type: "one-click-service-activepieces" }));
    const empty = (other.inserted[0]?.variables ?? []).filter((v) => v.value === null);
    expect(empty.length).toBeGreaterThan(0);
  });

  it("encrypts the content of a file the template writes", async () => {
    const { store, call, form } = setup();
    const r = await call("POST", "", form({ type: "one-click-service-garage" }));
    expect(r.status).toBe(201);
    const files = store.inserted[0]?.fileVolumes ?? [];
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.content === null || f.content.startsWith("fp1:file:"))).toBe(true);
    expect(files.some((f) => f.content !== null && !f.isDirectory)).toBe(true);
    // The content is in the file storage, not in the Compose file that is kept.
    expect(store.inserted[0]?.dockerComposeRaw).not.toContain("content:");
  });

  it("joins the destination's network for the templates Coolify names", async () => {
    const { store, call, form } = setup();
    await call("POST", "", form({ type: "one-click-service-pgadmin" }));
    expect(store.inserted[0]?.connectToDockerNetwork).toBe(true);
  });

  it("refuses a type that is not a template, and a missing target", async () => {
    const { store, call, form } = setup();
    for (const type of ["one-click-service-does-not-exist", "postgresql", "", null, 5]) {
      const r = await call("POST", "", form({ type }));
      expect(r.status).toBe(422);
      expect((r.body.error as { details: { fields: Record<string, string[]> } }).details.fields.type).toBeDefined();
    }
    expect((await call("POST", "", form({ project_uuid: "" }))).status).toBe(422);
    expect((await call("POST", "", form({ environment_uuid: "a b" }))).status).toBe(422);
    expect(store.inserted).toEqual([]);
    expect(validateCreateService(form()).ok).toBe(true);
  });

  it("answers 404 for a destination, server, project or environment that is not the org's, and for a build server", async () => {
    const { store, call, form } = setup();
    expect((await call("POST", "", form({ destination_uuid: "nope" }))).status).toBe(404);
    expect((await call("POST", "", form({ destination_uuid: undefined }))).status).toBe(404);
    expect((await call("POST", "", form({ server_uuid: "srvb" }))).status).toBe(404);
    expect((await call("POST", "", form({ server_uuid: "srvb", destination_uuid: "dstb" }))).status).toBe(404);
    expect((await call("POST", "", form({ project_uuid: "other" }))).status).toBe(404);
    expect((await call("POST", "", form({ environment_uuid: "other" }))).status).toBe(404);
    expect(store.inserted).toEqual([]);
    // server_uuid is optional: the destination names its server.
    expect((await call("POST", "", form({ server_uuid: undefined }))).status).toBe(201);
  });

  it("needs the write permission", async () => {
    const { store, call, form } = setup({ write: false });
    const r = await call("POST", "", form());
    expect(r.status).toBe(404);
    expect(store.inserted).toEqual([]);
  });
});

describe("GET /services/{uuid}", () => {
  it("answers the service with its applications and databases", async () => {
    const { call, form } = setup();
    const created = await call("POST", "", form());
    const uuid = (created.body.data as { uuid: string }).uuid;
    const r = await call("GET", uuid);
    expect(r.status).toBe(200);
    expect((r.body.data as { service: unknown }).service).toMatchObject({
      uuid,
      name: `umami-${uuid}`,
      serviceType: "umami",
      project: { uuid: "prj1", name: "Shop" },
      environment: { uuid: "env1", name: "production" },
      applications: [{ name: "umami", status: "exited", fqdn: `http://umami-${uuid}.203.0.113.10.sslip.io`, isRemovedFromCompose: false }],
      databases: [{ name: "postgresql", fqdn: null }],
      canWrite: true,
    });
  });

  it("tells a reader that it cannot write, and answers 404 for an unknown service and to who may not read", async () => {
    const writer = setup();
    const uuid = ((await writer.call("POST", "", writer.form())).body.data as { uuid: string }).uuid;
    expect((await writer.call("GET", "unknown")).status).toBe(404);
    const denied = setup({ read: false, write: false });
    expect((await denied.call("GET", uuid)).status).toBe(404);
    expect((await denied.call("GET", "templates")).status).toBe(404);
  });
});

describe("routing", () => {
  it("answers 405 for the other methods and 404 below a service", async () => {
    const { call } = setup();
    expect((await call("GET", "")).status).toBe(405);
    expect((await call("DELETE", "templates")).status).toBe(405);
    expect((await call("PATCH", "abc")).status).toBe(405);
    expect((await call("GET", "abc/def")).status).toBe(404);
  });

  it("is reached through route(), behind the actor headers", async () => {
    const { env } = setup();
    const anonymous = await route(new Request(`${BASE}/services/templates`), env);
    expect(anonymous.status).toBe(401);
    const signedIn = await route(new Request(`${BASE}/services/templates`, { headers: { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" } }), env);
    expect(signedIn.status).toBe(200);
    expect((await route(new Request(`${BASE}/services/a/b/c`, { headers: { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" } }), env)).status).toBe(404);
  });
});
