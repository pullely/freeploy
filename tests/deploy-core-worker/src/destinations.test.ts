// Destinations (DP-44): the list, a destination's General, Resources and
// Danger Zone, and a server's destinations — Coolify's rules and messages,
// what is stored, what needs SSH answering "not available yet", and the
// routing and authorization through route(), handleDestinations and
// handleServers. The SQL behind the store is tested in tests/db.
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { handleDestinations, type DestinationRunner } from "@deploy-core-worker/handlers/destinations";
import { handleServers, type ServerRunner } from "@deploy-core-worker/handlers/servers";
import type { ServerSettingsRunner } from "@deploy-core-worker/handlers/server-settings";
import { destinationName, destinationResource, type DestinationStore } from "@deploy-core-worker/destinations/service";
import { validateNewDestination, validateUpdateDestination } from "@deploy-core-worker/destinations/validation";
import type { DeployDestinationResourceRow, DeployDestinationRow, DeployServerRow, DestinationType, NewDestination } from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy`;
const SERVER = "srvaaaaaaaaaaaaaaaaaaaaa";
const DEFAULT = "dstaaaaaaaaaaaaaaaaaaaaa";
const SWARM = "dstsssssssssssssssssssss";
const actor = { subjectId: "usr_1", subjectType: "user" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

function serverRow(over: Partial<DeployServerRow> = {}): DeployServerRow {
  return {
    id: 1, uuid: SERVER, name: "prod-1", description: null, ip: "203.0.113.10", port: 22, user: "root", private_key_id: 100, private_key_uuid: null,
    proxy: {}, validation_logs: null, server_metadata: null, is_validating: false, hetzner_server_id: null, vultr_instance_id: null,
    hostinger_virtual_machine_id: null, created_at: null, updated_at: null, settings_id: 1, is_reachable: true, is_usable: true, force_disabled: false,
    is_swarm_manager: false, is_swarm_worker: false, is_build_server: false, server_role: "both", connection_timeout: 10, wildcard_domain: null,
    public_ipv4: null, public_ipv6: null, server_timezone: "UTC", is_metrics_enabled: false, is_sentinel_enabled: true, is_image_scan_enabled: false,
    ssh_host_key_pending: null, is_cloudflare_tunnel: false, org_uses_swarm: false,
    ...over,
  };
}

/** One org's servers and destinations, with the store's rules (usable servers, per-kind lookups). */
class MemoryStore implements DestinationStore {
  servers: DeployServerRow[] = [serverRow()];
  rows: DeployDestinationRow[] = [];
  attached = new Map<string, DeployDestinationResourceRow[]>();
  private nextId = 1;
  constructor() {
    this.add("standalone", DEFAULT, "freeploy", "coolify", 1);
  }
  add(type: DestinationType, uuid: string, name: string, network: string, serverId: string | number): DeployDestinationRow {
    const server = this.servers.find((s) => s.id === serverId)!;
    const row: DeployDestinationRow = { id: this.nextId++, uuid, name, network, type, server_id: serverId, server_uuid: server.uuid, server_name: server.name, server_ip: server.ip, created_at: null, updated_at: null };
    this.rows.push(row);
    return row;
  }
  private usable = (s: DeployServerRow) => Boolean(s.is_reachable) && Boolean(s.is_usable) && !s.is_swarm_worker && !s.force_disabled && s.server_role !== "build";
  private ordered = (rows: DeployDestinationRow[]) => [...rows.filter((r) => r.type === "standalone"), ...rows.filter((r) => r.type === "swarm")];
  async usableServers() {
    return this.servers.filter(this.usable).sort((a, b) => a.name.localeCompare(b.name)).map((s) => ({ id: s.id, uuid: s.uuid, name: s.name }));
  }
  async listUsable() {
    const servers = await this.usableServers();
    return servers.flatMap((s) => this.ordered(this.rows.filter((r) => r.server_id === s.id)));
  }
  async listForServer(serverId: string | number) {
    return this.ordered(this.rows.filter((r) => r.server_id === serverId));
  }
  async findByUuid(uuid: string) {
    return this.ordered(this.rows).find((r) => r.uuid === uuid) ?? null;
  }
  async findServer(uuid: string) {
    return this.servers.find((s) => s.uuid === uuid) ?? null;
  }
  async networkExists(type: DestinationType, serverId: string | number, network: string) {
    return this.rows.some((r) => r.type === type && r.server_id === serverId && r.network === network);
  }
  async insert(d: Omit<NewDestination, "orgId">) {
    return this.add(d.type, d.uuid, d.name, d.network, d.serverId);
  }
  async rename(type: DestinationType, id: string | number, name: string) {
    const row = this.rows.find((r) => r.type === type && r.id === id);
    if (row) row.name = name;
    return Boolean(row);
  }
  async delete(type: DestinationType, id: string | number) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !(r.type === type && r.id === id));
    return this.rows.length < before;
  }
  async isAttached(type: DestinationType, id: string | number) {
    return (this.attached.get(`${type}:${id}`) ?? []).length > 0;
  }
  async resources(type: DestinationType, id: string | number) {
    return this.attached.get(`${type}:${id}`) ?? [];
  }
}

type Body = { data?: Record<string, unknown>; error?: { code: string; message: string; details: { fields?: Record<string, string[]> } } };

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
  const runner: DestinationRunner = async (_env, orgId, fn) => {
    orgs.push(orgId);
    return fn({ store });
  };
  const unused = (name: string) => async () => {
    throw new Error(`the ${name} runner is not used by the destination routes`);
  };
  const init = (method: string, body?: unknown): RequestInit => (body === undefined ? { method } : { method, body: JSON.stringify(body) });
  /** /destinations/{path} */
  const call = async (method: string, path = "", body?: unknown) => {
    const res = await handleDestinations(env, "req_1", actor, ORG_UUID, path.split("/").filter(Boolean), new Request(`${BASE}/destinations/${path}`, init(method, body)), runner);
    return { status: res.status, body: (await res.json()) as Body };
  };
  /** /servers/{path} */
  const server = async (method: string, path: string, body?: unknown) => {
    const res = await handleServers(
      env, "req_1", actor, ORG_UUID, path.split("/").filter(Boolean), new Request(`${BASE}/servers/${path}`, init(method, body)),
      unused("servers") as ServerRunner, unused("settings") as ServerSettingsRunner, runner,
    );
    return { status: res.status, body: (await res.json()) as Body };
  };
  return { store, asked, orgs, call, server };
}

describe("validation (Laravel's messages)", () => {
  it("Show: the name is required and a string", () => {
    expect(validateUpdateDestination({ name: "apps" })).toEqual({ ok: true, input: { name: "apps" } });
    expect(validateUpdateDestination({})).toEqual({ ok: false, errors: { name: ["The name field is required."] } });
    expect(validateUpdateDestination({ name: "   " })).toEqual({ ok: false, errors: { name: ["The name field is required."] } });
    expect(validateUpdateDestination({ name: 5 })).toEqual({ ok: false, errors: { name: ["The name field must be a string."] } });
    // Not Coolify's rule: the column holds 255 characters.
    expect(validateUpdateDestination({ name: "a".repeat(256) })).toEqual({ ok: false, errors: { name: ["The name field must not be greater than 255 characters."] } });
    expect(validateUpdateDestination({ name: "a".repeat(255) }).ok).toBe(true);
  });

  it("New/Docker: name, and a network that is a Docker network name", () => {
    expect(validateNewDestination({ name: "prod-1-apps", network: "apps_1.net-a" })).toEqual({ ok: true, input: { name: "prod-1-apps", network: "apps_1.net-a" } });
    expect(validateNewDestination({})).toEqual({ ok: false, errors: { name: ["The name field is required."], network: ["The network field is required."] } });
    expect(validateNewDestination({ name: "x", network: ["a"] })).toEqual({ ok: false, errors: { network: ["The network field must be a string."] } });
    for (const network of ["-apps", ".apps", "my apps", "apps;rm -rf /", "$(id)", "apps\n"]) {
      expect(validateNewDestination({ name: "x", network })).toEqual({ ok: false, errors: { network: ["The network field format is invalid."] } });
    }
    expect(validateNewDestination({ name: "x", network: "a".repeat(256) })).toEqual({ ok: false, errors: { network: ["The network field must not be greater than 255 characters."] } });
    expect(validateNewDestination({ name: "x", network: "-".repeat(256) })).toEqual({
      ok: false,
      errors: { network: ["The network field must not be greater than 255 characters.", "The network field format is invalid."] },
    });
  });

  it("names a new destination as New/Docker::generateName() does (kebab)", () => {
    expect(destinationName("prod-1", "k3j2abc")).toBe("prod-1-k3j2abc");
    expect(destinationName("My Server", "k3j2abc")).toBe("my-server-k3j2abc");
  });
});

describe("the destinations list (Index)", () => {
  it("lists the destinations of usable servers with their server, and what New Destination needs", async () => {
    const t = setup();
    t.store.add("swarm", SWARM, "prod-1-overlay", "coolify-overlay", 1);
    const r = await t.call("GET");
    expect(r.status).toBe(200);
    expect(r.body.data?.destinations).toEqual([
      { uuid: DEFAULT, name: "freeploy", network: "coolify", type: "standalone", typeLabel: "Standalone Docker", server: { uuid: SERVER, name: "prod-1", ip: "203.0.113.10" } },
      { uuid: SWARM, name: "prod-1-overlay", network: "coolify-overlay", type: "swarm", typeLabel: "Docker Swarm", server: { uuid: SERVER, name: "prod-1", ip: "203.0.113.10" } },
    ]);
    const network = r.body.data?.network as string;
    expect(network).toMatch(/^[a-z0-9]{24}$/);
    expect(r.body.data?.servers).toEqual([{ uuid: SERVER, name: "prod-1", destinationName: `prod-1-${network}` }]);
    expect(r.body.data?.canCreate).toBe(true);
    expect(t.orgs).toEqual([ORG_UUID]);
  });

  it("lists nothing for a server that is not validated yet, as Coolify's Server::isUsable()", async () => {
    const t = setup({ write: false });
    t.store.servers = [serverRow({ is_reachable: false, is_usable: false })];
    const r = await t.call("GET");
    expect(r.body.data).toMatchObject({ destinations: [], servers: [], canCreate: false });
  });
});

describe("a destination (Show)", () => {
  it("shows the name, the network and the server's address", async () => {
    const r = await setup({ write: false }).call("GET", DEFAULT);
    expect(r.body.data).toEqual({
      destination: { uuid: DEFAULT, name: "freeploy", network: "coolify", type: "standalone", typeLabel: "Standalone Docker", server: { uuid: SERVER, name: "prod-1", ip: "203.0.113.10" } },
      canUpdate: false,
    });
  });

  it("saves the name with Coolify's message, and only the name", async () => {
    const t = setup();
    const r = await t.call("PATCH", DEFAULT, { name: "main network", network: "hacked" });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ message: "Destination saved.", destination: { name: "main network", network: "coolify" } });
    expect(t.store.rows[0]).toMatchObject({ name: "main network", network: "coolify" });
    const bad = await t.call("PATCH", DEFAULT, { name: "" });
    expect(bad.status).toBe(422);
    expect(bad.body.error?.details.fields).toEqual({ name: ["The name field is required."] });
    expect(t.store.rows[0]!.name).toBe("main network");
  });

  it("does not delete a standalone destination: removing its network needs SSH (501), after the resources guard", async () => {
    const t = setup();
    const row = t.store.add("standalone", "dstbbbbbbbbbbbbbbbbbbbbb", "prod-1-apps", "apps", 1);
    t.store.attached.set(`standalone:${row.id}`, [{ type: "application", uuid: "app1", name: "web", environment_uuid: null, environment_name: null, project_uuid: null, project_name: null }]);
    const guarded = await t.call("DELETE", row.uuid);
    expect(guarded.status).toBe(422);
    expect(guarded.body.error?.message).toBe("You must delete all resources before deleting this destination.");
    t.store.attached.clear();
    const r = await t.call("DELETE", row.uuid);
    expect(r.status).toBe(501);
    expect(r.body.error).toMatchObject({ code: "unsupported", message: "Removing the Docker network from the server needs the SSH executor, which is not available yet." });
    // The row stays: Coolify deletes it only after the network is gone.
    expect(t.store.rows.map((d) => d.uuid)).toContain(row.uuid);
  });

  it("deletes a Swarm destination: Coolify runs nothing on the server for it, and has no resources guard", async () => {
    const t = setup();
    const row = t.store.add("swarm", SWARM, "prod-1-overlay", "coolify-overlay", 1);
    t.store.attached.set(`swarm:${row.id}`, [{ type: "service", uuid: "svc1", name: "x", environment_uuid: null, environment_name: null, project_uuid: null, project_name: null }]);
    const r = await t.call("DELETE", SWARM);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ deleted: true });
    expect(t.store.rows.map((d) => d.uuid)).toEqual([DEFAULT]);
    expect((await t.call("DELETE", SWARM)).status).toBe(404);
  });
});

describe("a destination's resources (Resources)", () => {
  it("is empty until something is deployed to the destination", async () => {
    const r = await setup().call("GET", `${DEFAULT}/resources`);
    expect(r.body.data).toMatchObject({ destination: { uuid: DEFAULT }, resources: [], canUpdate: true });
  });

  it("lists each resource with its project, environment, link and search text (resourceRow)", async () => {
    const t = setup();
    t.store.attached.set("standalone:1", [
      { type: "application", uuid: "app1", name: "Web", environment_uuid: "env1", environment_name: "production", project_uuid: "prj1", project_name: "Shop" },
      { type: "database", uuid: "db1", name: "cache", environment_uuid: null, environment_name: null, project_uuid: null, project_name: null },
    ]);
    const r = await t.call("GET", `${DEFAULT}/resources`);
    expect(r.body.data?.resources).toEqual([
      { uuid: "app1", type: "application", name: "Web", project: "Shop", environment: "production", url: "/project/prj1/environment/env1/application/app1", search: "application web shop production" },
      { uuid: "db1", type: "database", name: "cache", project: null, environment: null, url: null, search: "database cache" },
    ]);
    expect(destinationResource({ type: "service", uuid: "s1", name: "plausible", environment_uuid: "e", environment_name: "staging", project_uuid: "p", project_name: "Shop" }).url).toBe("/project/p/environment/e/service/s1");
  });

  it("lists none for a Swarm destination (Coolify redirects to its General page)", async () => {
    const t = setup();
    const row = t.store.add("swarm", SWARM, "prod-1-overlay", "coolify-overlay", 1);
    t.store.attached.set(`swarm:${row.id}`, [{ type: "service", uuid: "svc1", name: "x", environment_uuid: null, environment_name: null, project_uuid: null, project_name: null }]);
    expect((await t.call("GET", `${SWARM}/resources`)).body.data).toMatchObject({ destination: { type: "swarm" }, resources: [] });
  });
});

describe("a server's destinations (Server/Destinations, New/Docker)", () => {
  it("lists the server's destinations, validated or not, with the new destination's starting values", async () => {
    const t = setup({ write: false });
    t.store.servers = [serverRow({ is_reachable: false, is_usable: false })];
    const r = await t.server("GET", `${SERVER}/destinations`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ server: { uuid: SERVER, isFunctional: false }, destinations: [{ uuid: DEFAULT, network: "coolify", typeLabel: "Standalone Docker" }], canUpdate: false });
    const next = r.body.data?.newDestination as { name: string; network: string };
    expect(next.network).toMatch(/^[a-z0-9]{24}$/);
    expect(next.name).toBe(`prod-1-${next.network}`);
  });

  it("adds a standalone destination: the row is stored, the network on the server is not available yet", async () => {
    const t = setup();
    const r = await t.server("POST", `${SERVER}/destinations`, { name: "prod-1-apps", network: "apps" });
    expect(r.status).toBe(201);
    expect(r.body.data?.unavailable).toBe("Creating the Docker network on the server needs the SSH executor, which is not available yet.");
    const row = t.store.rows.find((d) => d.network === "apps")!;
    expect(r.body.data?.uuid).toBe(row.uuid);
    expect(row).toMatchObject({ type: "standalone", name: "prod-1-apps", server_id: 1 });
    expect(row.uuid).toMatch(/^[a-z0-9]{24}$/);
  });

  it("adds a Swarm destination on a Swarm server: nothing runs on the server for it", async () => {
    const t = setup();
    t.store.servers = [serverRow({ is_swarm_manager: true })];
    const r = await t.server("POST", `${SERVER}/destinations`, { name: "overlay", network: "apps-overlay" });
    expect(r.status).toBe(201);
    expect(r.body.data?.unavailable).toBeNull();
    expect(t.store.rows.find((d) => d.network === "apps-overlay")).toMatchObject({ type: "swarm", name: "overlay" });
    // The same network name as a standalone destination's is another kind: allowed, as in Coolify.
    expect((await t.server("POST", `${SERVER}/destinations`, { name: "x", network: "coolify" })).status).toBe(201);
  });

  it("refuses a network the server already has, and an invalid form", async () => {
    const t = setup();
    const dup = await t.server("POST", `${SERVER}/destinations`, { name: "again", network: "coolify" });
    expect(dup.status).toBe(422);
    expect(dup.body.error?.message).toBe("Network already added to this server.");
    const bad = await t.server("POST", `${SERVER}/destinations`, { name: "", network: "bad name" });
    expect(bad.status).toBe(422);
    expect(bad.body.error?.details.fields).toEqual({ name: ["The name field is required."], network: ["The network field format is invalid."] });
    expect(t.store.rows).toHaveLength(1);
  });

  it("scanning the server for networks needs SSH (501)", async () => {
    const t = setup();
    const r = await t.server("POST", `${SERVER}/destinations/scan`, {});
    expect(r.status).toBe(501);
    expect(r.body.error).toMatchObject({ code: "unsupported", message: "Scanning the server for Docker networks needs the SSH executor, which is not available yet." });
    expect(t.store.rows).toHaveLength(1);
  });
});

describe("routing and authorization", () => {
  it("reads ask deploy.resource.read and report whether the caller may write; changes need deploy.resource.write", async () => {
    const reader = setup({ write: false });
    expect((await reader.call("GET")).status).toBe(200);
    expect(reader.asked.sort()).toEqual(["deploy.resource.read", "deploy.resource.write"]);
    expect((await reader.call("PATCH", DEFAULT, { name: "x" })).status).toBe(404);
    expect((await reader.call("DELETE", DEFAULT)).status).toBe(404);
    expect((await reader.server("POST", `${SERVER}/destinations`, { name: "x", network: "apps" })).status).toBe(404);
    expect((await reader.server("POST", `${SERVER}/destinations/scan`, {})).status).toBe(404);
    expect(reader.store.rows).toHaveLength(1);
    expect(reader.store.rows[0]!.name).toBe("freeploy");
    const none = setup({ read: false, write: false });
    for (const path of ["", DEFAULT, `${DEFAULT}/resources`]) expect((await none.call("GET", path)).status).toBe(404);
    expect((await none.server("GET", `${SERVER}/destinations`)).status).toBe(404);
    expect(none.orgs).toEqual([]);
  });

  it("404s an unknown destination, server or path; 405s a method a path does not take", async () => {
    const t = setup();
    expect((await t.call("GET", "nosuchdestination")).status).toBe(404);
    expect((await t.call("PATCH", "nosuchdestination", { name: "x" })).status).toBe(404);
    expect((await t.call("GET", "nosuchdestination/resources")).status).toBe(404);
    expect((await t.call("GET", `${DEFAULT}/danger`)).status).toBe(404);
    expect((await t.call("GET", `${DEFAULT}/resources/more`)).status).toBe(404);
    expect((await t.call("POST")).status).toBe(405);
    expect((await t.call("PUT", DEFAULT, {})).status).toBe(405);
    expect((await t.call("DELETE", `${DEFAULT}/resources`)).status).toBe(405);
    expect((await t.server("GET", "nosuchserver/destinations")).status).toBe(404);
    expect((await t.server("POST", "nosuchserver/destinations", { name: "x", network: "apps" })).status).toBe(404);
    expect((await t.server("POST", "nosuchserver/destinations/scan", {})).status).toBe(404);
    expect((await t.server("POST", `${SERVER}/destinations/add`, {})).status).toBe(404);
    expect((await t.server("PATCH", `${SERVER}/destinations`, {})).status).toBe(405);
    expect((await t.server("GET", `${SERVER}/destinations/scan`)).status).toBe(405);
  });

  it("the router sends /destinations to the handler: an actor, an org id, at most two segments", async () => {
    const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
    const env: Env = { ENVIRONMENT: "test" };
    // 503: routed and matched, then no database binding in this env.
    expect((await route(new Request(`${BASE}/destinations`, { headers }), env)).status).toBe(503);
    expect((await route(new Request(`${BASE}/destinations/${DEFAULT}`, { method: "DELETE", headers }), env)).status).toBe(503);
    expect((await route(new Request(`${BASE}/destinations/${DEFAULT}/resources`, { headers }), env)).status).toBe(503);
    expect((await route(new Request(`${BASE}/servers/${SERVER}/destinations/scan`, { method: "POST", headers }), env)).status).toBe(503);
    expect((await route(new Request(`${BASE}/destinations/${DEFAULT}/resources/more`, { headers }), env)).status).toBe(404);
    expect((await route(new Request(`${BASE}/destinations`, {}), env)).status).toBe(401);
    expect((await route(new Request(`https://x/v1/organizations/nope/deploy/destinations`, { headers }), env)).status).toBe(404);
    expect((await route(new Request(`${BASE}/destinations`, { method: "POST", headers }), env)).status).toBe(405);
  });
});
