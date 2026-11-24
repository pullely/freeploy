// Servers (DP-37): Coolify's ByIp / Show rules and messages, the address
// helpers, the Index / ByIp / Show / PrivateKey/Show / Delete operations, and
// the handler's routing and authorization. The SQL behind the store (and its
// row-level security) is tested in tests/db.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { handleServers, type ServerRunner } from "@deploy-core-worker/handlers/servers";
import type { ServerStore } from "@deploy-core-worker/servers/service";
import type { KeyCipher } from "@deploy-core-worker/private-keys/service";
import { validateCreateServer, validateUpdateServer } from "@deploy-core-worker/servers/validation";
import { hostnameError, normalizeServerIp, serverIpError, isIpv4, isIpv6 } from "@deploy-core-worker/servers/ip";
import type { DeployPrivateKeyWithSecretRow, DeployServerListRow, DeployServerPrivateKeyRow, DeployServerRow, NewServer, ServerChanges, ServerSettingsChanges } from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy/servers`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const fixture = (name: string): string => readFileSync(join(process.cwd(), "fixtures", "ssh-keys", name), "utf8");
const ED25519 = fixture("ed25519.openssh");
const ECDSA = fixture("ecdsa256.openssh");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

type Row = DeployServerRow & { proxy: Record<string, unknown>; image_scan: boolean; ip_previous?: string | null };

/** deploy.servers, deploy.server_settings and the org's keys, in memory. */
class MemoryStore implements ServerStore {
  rows: Row[] = [];
  /** The default destination uuid each insert carried (the created hook's destination). */
  defaultDestinations: string[] = [];
  keys: DeployServerPrivateKeyRow[] = [];
  private next = 1;
  addKey(uuid: string, name: string, secret: string, gitRelated = false) {
    this.keys.push({ id: 100 + this.keys.length, uuid, name, description: null, is_git_related: gitRelated, private_key: `enc:${secret}` });
  }
  private withKey(r: Row): Row {
    return { ...r, private_key_uuid: this.keys.find((k) => k.id === r.private_key_id)?.uuid ?? null };
  }
  async list(): Promise<DeployServerListRow[]> {
    return [...this.rows]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => ({ id: r.id, uuid: r.uuid, name: r.name, description: r.description, is_reachable: r.is_reachable, is_usable: r.is_usable, force_disabled: r.force_disabled, server_metadata: r.server_metadata }));
  }
  async findByUuid(uuid: string) {
    const r = this.rows.find((x) => x.uuid === uuid);
    return r ? this.withKey(r) : null;
  }
  async insert(s: Omit<NewServer, "orgId">) {
    const row: Row = {
      id: this.next++, uuid: s.uuid, name: s.name, description: s.description, ip: s.ip, port: s.port, user: s.user, private_key_id: s.privateKeyId,
      private_key_uuid: null, proxy: s.proxy, validation_logs: null, server_metadata: null, is_validating: false, hetzner_server_id: null,
      vultr_instance_id: null, hostinger_virtual_machine_id: null, created_at: null, updated_at: null, settings_id: 1, is_reachable: false,
      is_usable: false, force_disabled: false, is_swarm_manager: false, is_swarm_worker: false, is_build_server: s.serverRole === "build",
      server_role: s.serverRole, connection_timeout: 10, wildcard_domain: null, public_ipv4: null, public_ipv6: null, server_timezone: "UTC",
      is_metrics_enabled: false, is_sentinel_enabled: true, is_image_scan_enabled: s.imageScanEnabled, ssh_host_key_pending: null, image_scan: s.imageScanEnabled,
      is_cloudflare_tunnel: false, org_uses_swarm: false,
    };
    this.rows.push(row);
    this.defaultDestinations.push(s.defaultDestinationUuid);
    return this.withKey(row);
  }
  async update(id: string | number, s: ServerChanges, st: ServerSettingsChanges) {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return false;
    if (r.ip !== s.ip) r.ip_previous = r.ip;
    Object.assign(r, { name: s.name, description: s.description, ip: s.ip, user: s.user, port: s.port });
    Object.assign(r, { connection_timeout: st.connectionTimeout, wildcard_domain: st.wildcardDomain, server_timezone: st.serverTimezone });
    if (st.publicIpv4 !== undefined) r.public_ipv4 = st.publicIpv4;
    if (st.publicIpv6 !== undefined) r.public_ipv6 = st.publicIpv6;
    return true;
  }
  async updateRole(id: string | number, role: "deployment" | "build" | "both", disableSentinel: boolean) {
    const r = this.rows.find((x) => x.id === id)!;
    Object.assign(r, { server_role: role, is_build_server: role === "build" });
    if (disableSentinel) Object.assign(r, { is_sentinel_enabled: false, is_metrics_enabled: false });
  }
  async setPrivateKey(id: string | number, keyId: string | number) {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return false;
    r.private_key_id = keyId;
    return true;
  }
  async delete(id: string | number) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    return this.rows.length < before;
  }
  async sshEndpointInUse(ip: string, port: number, exceptId?: string | number | null) {
    return this.rows.some((r) => r.ip === ip && r.port === port && r.id !== exceptId);
  }
  async otherBuildServerExists(exceptId: string | number) {
    return this.rows.some((r) => r.id !== exceptId && r.is_reachable && r.is_usable && r.server_role === "build");
  }
  async privateKeys() {
    return this.keys;
  }
  async findPrivateKey(uuid: string): Promise<DeployPrivateKeyWithSecretRow | null> {
    const k = this.keys.find((x) => x.uuid === uuid);
    return k ? { ...k, fingerprint: null, created_at: null, updated_at: null } : null;
  }
}

const cipher: KeyCipher = {
  encrypt: async (p) => `enc:${p}`,
  decrypt: async (s) => {
    if (!s.startsWith("enc:")) throw new Error("not encrypted");
    return s.slice(4);
  },
};

type Body = { data?: Record<string, unknown>; error?: { code: string; message: string; details: { fields?: Record<string, string[]> } } };

function setup(opts: { write?: boolean; read?: boolean } = {}) {
  const store = new MemoryStore();
  store.addKey("key1aaaaaaaaaaaaaaaaaaaa", "laptop", ED25519);
  store.addKey("key2bbbbbbbbbbbbbbbbbbbb", "ci", ECDSA);
  store.addKey("gitkeycccccccccccccccccc", "github app", ED25519, true);
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
  const runner: ServerRunner = async (_env, orgId, fn) => {
    orgs.push(orgId);
    return fn({ store, cipher });
  };
  const call = async (method: string, path = "", body?: unknown) => {
    const segments = path.split("?")[0]!.split("/").filter(Boolean);
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleServers(env, "req_1", actor, ORG_UUID, segments, new Request(`${BASE}${path ? `/${path}` : ""}`, init), runner);
    return { status: res.status, body: (await res.json()) as Body };
  };
  const add = async (over: Record<string, unknown> = {}) => {
    const r = await call("POST", "", { name: "prod-1", description: "", ip: "203.0.113.10", user: "root", port: 22, private_key_uuid: "key1aaaaaaaaaaaaaaaaaaaa", server_role: "both", ...over });
    return r;
  };
  return { store, asked, orgs, call, add };
}

const general = (over: Record<string, unknown> = {}) => ({
  name: "prod-1",
  description: "",
  ip: "203.0.113.10",
  user: "root",
  port: "22",
  connectionTimeout: 10,
  serverTimezone: "UTC",
  wildcardDomain: "",
  publicIpv4: "",
  publicIpv6: "",
  ...over,
});

describe("server addresses (ValidServerIp, ValidHostname, normalizeIp)", () => {
  it("accepts IPv4, IPv6 (bracketed too) and RFC 1123 hostnames", () => {
    for (const ok of ["203.0.113.10", "2001:db8::1", "[2001:db8::1]", "::ffff:192.0.2.1", "server.example.com", "my-host", "1.2.3.400"]) expect(serverIpError("ip", ok)).toBeNull();
    expect(isIpv4("01.2.3.4")).toBe(false);
    expect(isIpv6("1:2:3:4:5:6:7:8:9")).toBe(false);
    expect(isIpv6("1::2::3")).toBe(false);
  });

  it("refuses everything else with ValidServerIp's message", () => {
    for (const bad of ["http://example.com", "-bad.example.com", "a..b", "host name", "exa_mple.com"]) {
      expect(serverIpError("ip", bad)).toBe("The ip must be a valid IPv4 address, IPv6 address, or hostname.");
    }
  });

  it("ValidHostname's own messages, in its order", () => {
    expect(hostnameError("ip", "a;b")).toBe("The ip contains invalid characters. Only letters (a-z, A-Z), numbers (0-9), hyphens (-), and dots (.) are allowed.");
    expect(hostnameError("ip", ".example.com")).toBe("The ip cannot start or end with a dot.");
    expect(hostnameError("ip", "a..b")).toBe("The ip cannot contain consecutive dots.");
    expect(hostnameError("ip", `${"a".repeat(64)}.com`)).toBe("The ip contains an invalid label. Each segment must be 1-63 characters.");
    expect(hostnameError("ip", "-a.com")).toBe("The ip contains an invalid label. Labels cannot start or end with a hyphen.");
    expect(hostnameError("ip", "a".repeat(254))).toBe("The ip must not exceed 253 characters.");
  });

  it("stores IPv6 in inet_ntop's short lower-case form, without brackets", () => {
    expect(normalizeServerIp("[2A01:04F8:0000:0000:0000:0000:0000:0001]")).toBe("2a01:4f8::1");
    expect(normalizeServerIp("2001:db8:0:1:0:0:0:1")).toBe("2001:db8:0:1::1");
    expect(normalizeServerIp("0:0:0:0:0:ffff:c000:0201")).toBe("::ffff:192.0.2.1");
    expect(normalizeServerIp("0:0:0:0:0:0:0:1")).toBe("::1");
    expect(normalizeServerIp("1:0:2:0:3:0:4:0")).toBe("1:0:2:0:3:0:4:0");
    expect(normalizeServerIp(" Server.Example.com ")).toBe("Server.Example.com");
    expect(normalizeServerIp("10.0.0.1; rm -rf /")).toBe("10.0.0.1rm-rf");
  });
});

describe("ByIp and Show rules and messages", () => {
  it("ByIp: the IP Address/Domain, User and Port messages", () => {
    const r = validateCreateServer({ name: "abc", ip: "", user: "-bad user", port: 0, server_role: "web" });
    expect(!r.ok && r.errors).toEqual({
      ip: ["The IP Address/Domain is required."],
      user: ["The User may only contain letters, numbers, dots, hyphens, and underscores."],
      port: ["The Port field must be between 1 and 65535."],
      server_role: ["The selected Server Role is invalid."],
    });
    const p = validateCreateServer({ name: "abc", ip: "10.0.0.1", port: "abc" });
    expect(!p.ok && p.errors).toEqual({ port: ["The Port field must be an integer."] });
    const u = validateCreateServer({ name: "abc", ip: "10.0.0.1", user: "" });
    expect(!u.ok && u.errors).toEqual({ user: ["The User field is required."] });
  });

  it("ByIp: defaults root, 22 and both; scan_images on", () => {
    const r = validateCreateServer({ name: "abc", ip: "10.0.0.1", scan_images: "on" });
    expect(r.ok && r.input).toEqual({ privateKeyUuid: null, name: "abc", description: null, ip: "10.0.0.1", user: "root", port: 22, serverRole: "both", scanImages: true });
  });

  it("Show: its messages, and Laravel's defaults where it has none", () => {
    const r = validateUpdateServer(general({ ip: "", port: "x", connectionTimeout: 301, wildcardDomain: "not a url", publicIpv4: "2001:db8::1", publicIpv6: "10.0.0.1", serverTimezone: "" }));
    expect(!r.ok && r.errors).toEqual({
      ip: ["The IP Address field is required."],
      port: ["The port field must be an integer."],
      connectionTimeout: ["The SSH Connection Timeout must not exceed 300 seconds."],
      wildcardDomain: ["The Wildcard Domain must be a valid URL."],
      publicIpv4: ["The Public IPv4 must be a valid IPv4 address."],
      publicIpv6: ["The Public IPv6 must be a valid IPv6 address."],
      serverTimezone: ["The Server Timezone field is required."],
    });
    const t = validateUpdateServer(general({ connectionTimeout: "", port: 70000 }));
    expect(!t.ok && t.errors).toEqual({ port: ["The port field must be between 1 and 65535."], connectionTimeout: ["The SSH Connection Timeout field is required."] });
    expect(validateUpdateServer(general({ wildcardDomain: "https://example.com", publicIpv4: "198.51.100.7" })).ok).toBe(true);
  });
});

describe("servers", () => {
  it("adds a server unvalidated: Traefik proxy exited, settings with its role, a default destination", async () => {
    const t = setup();
    const r = await t.add({ ip: "[2001:DB8::10]", user: " deploy ", server_role: "build", scan_images: "on" });
    expect(r.status).toBe(422);
    expect(r.body.error?.details.fields).toEqual({ user: ["The User may only contain letters, numbers, dots, hyphens, and underscores."] });
    const ok = await t.add({ ip: "[2001:DB8::10]", user: "deploy", server_role: "build", scan_images: "on" });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toEqual({ uuid: expect.stringMatching(/^[a-z0-9]{24}$/) });
    const row = t.store.rows[0]!;
    expect(row).toMatchObject({ name: "prod-1", description: null, ip: "2001:db8::10", user: "deploy", port: 22, private_key_id: 100, server_role: "build", is_build_server: true, image_scan: true });
    expect(row.proxy).toEqual({ redirect_enabled: true, status: "exited", type: "TRAEFIK" });
    // The created hook's destination: its own public id (the store names it and its network).
    expect(t.store.defaultDestinations).toEqual([expect.stringMatching(/^[a-z0-9]{24}$/)]);
    expect(t.store.defaultDestinations[0]).not.toBe(row.uuid);
    expect(t.orgs.every((o) => o === ORG_UUID)).toBe(true);
  });

  it("refuses an SSH endpoint the org already has, a missing key, a key of no one", async () => {
    const t = setup();
    await t.add();
    const dup = await t.add({ name: "again" });
    expect(dup.status).toBe(422);
    expect(dup.body.error?.message).toBe("A server with this IP/Domain and SSH port already exists.");
    // Another port is another server.
    expect((await t.add({ name: "nat", port: 2222 })).status).toBe(201);
    const none = await t.add({ ip: "203.0.113.11", private_key_uuid: null });
    expect(none.body.error?.message).toBe("You must select a private key");
    const foreign = await t.add({ ip: "203.0.113.12", private_key_uuid: "nosuchkey" });
    expect(foreign.body.error?.details.fields).toEqual({ private_key_uuid: ["The selected Private Key is invalid."] });
    expect(t.store.rows).toHaveLength(2);
  });

  it("offers a random name and the org's keys for the form", async () => {
    const t = setup();
    const r = await t.call("GET", "new");
    expect(r.body.data).toEqual({
      name: expect.stringMatching(/^[a-z]+-[a-z]+-[a-z0-9]{24}$/),
      privateKeys: [
        { uuid: "key1aaaaaaaaaaaaaaaaaaaa", name: "laptop" },
        { uuid: "key2bbbbbbbbbbbbbbbbbbbb", name: "ci" },
        { uuid: "gitkeycccccccccccccccccc", name: "github app" },
      ],
      canCreatePrivateKey: true,
    });
    expect(t.asked).toEqual(["deploy.resource.write"]);
  });

  it("lists the org's servers by name with Index's status", async () => {
    const t = setup();
    await t.add({ name: "zeta", ip: "10.0.0.2" });
    await t.add({ name: "alpha", ip: "10.0.0.1", description: "edge" });
    Object.assign(t.store.rows[0]!, { is_reachable: true, is_usable: true });
    t.store.rows[1]!.server_metadata = { transfer: { status: "transferred" } };
    t.asked.length = 0;
    const r = await t.call("GET");
    expect(r.body.data).toEqual({
      servers: [
        { uuid: t.store.rows[1]!.uuid, name: "alpha", description: "edge", status: "Transferred away", statusType: "error", resourceCount: 0 },
        { uuid: t.store.rows[0]!.uuid, name: "zeta", description: null, status: "Ready", statusType: "success", resourceCount: 0 },
      ],
      canWrite: true,
    });
    expect(t.asked.sort()).toEqual(["deploy.resource.read", "deploy.resource.write"]);
  });

  it("shows the General page; never the Sentinel token", async () => {
    const t = setup();
    await t.add();
    const uuid = t.store.rows[0]!.uuid;
    const r = await t.call("GET", uuid);
    expect(r.body.data).toEqual({
      server: expect.objectContaining({ uuid, name: "prod-1", ip: "203.0.113.10", user: "root", port: 22, connectionTimeout: 10, serverTimezone: "UTC", serverRole: "both", isFunctional: false, isTransferredAway: false, privateKeyUuid: "key1aaaaaaaaaaaaaaaaaaaa" }),
      canUpdate: true,
    });
    expect(JSON.stringify(r.body)).not.toMatch(/sentinel/i);
    expect((await t.call("GET", "nosuchserver")).status).toBe(404);
  });

  it("saves the General page: 'Server settings updated.'", async () => {
    const t = setup();
    await t.add();
    const uuid = t.store.rows[0]!.uuid;
    const r = await t.call("PATCH", uuid, general({ name: "prod-2", description: "main", ip: "2001:DB8::1", port: "2222", connectionTimeout: "30", serverTimezone: "Europe/Berlin", wildcardDomain: "https://example.com", publicIpv4: "198.51.100.7" }));
    expect(r.status).toBe(200);
    expect(r.body.data?.message).toBe("Server settings updated.");
    expect(t.store.rows[0]).toMatchObject({ name: "prod-2", description: "main", ip: "2001:db8::1", ip_previous: "203.0.113.10", port: 2222, connection_timeout: 30, server_timezone: "Europe/Berlin", wildcard_domain: "https://example.com", public_ipv4: "198.51.100.7", public_ipv6: null });
  });

  it("refuses a duplicate endpoint, an unknown timezone, and connection changes of a transferred server", async () => {
    const t = setup();
    await t.add();
    await t.add({ name: "other", ip: "10.0.0.9" });
    const uuid = t.store.rows[0]!.uuid;
    const dup = await t.call("PATCH", uuid, general({ ip: "10.0.0.9" }));
    expect(dup.body.error?.message).toBe("A server with this IP/Domain and SSH port already exists.");
    // An unchanged endpoint is not checked again.
    expect((await t.call("PATCH", uuid, general({ name: "renamed" }))).status).toBe(200);
    const tz = await t.call("PATCH", uuid, general({ serverTimezone: "Mars/Olympus" }));
    expect(tz.body.error?.message).toBe("Invalid timezone.");
    t.store.rows[0]!.server_metadata = JSON.stringify({ transfer: { status: "transferred" } });
    const moved = await t.call("PATCH", uuid, general({ user: "admin" }));
    expect(moved.body.error?.message).toBe("The IP address, SSH user, and SSH port of a transferred server cannot be changed.");
  });

  it("changes the role as Show does: confirmation for builds, a build server first for deployments only", async () => {
    const t = setup();
    await t.add({ server_role: "deployment" });
    const uuid = t.store.rows[0]!.uuid;
    expect((await t.call("PATCH", `${uuid}/role`, { serverRole: "both" })).body.data).toEqual({ confirm: true });
    expect(t.store.rows[0]!.server_role).toBe("deployment");
    const confirmed = await t.call("PATCH", `${uuid}/role`, { serverRole: "both", confirmed: true });
    expect(confirmed.body.data).toEqual({ serverRole: "both", info: null, message: "Server settings updated." });
    const deploy = await t.call("PATCH", `${uuid}/role`, { serverRole: "deployment" });
    expect(deploy.body.error?.message).toBe("Add a usable build server before you set this server to deployments only.");
    const build = await t.call("PATCH", `${uuid}/role`, { serverRole: "build" });
    expect(build.body.data).toEqual({ serverRole: "build", info: "Sentinel has been disabled as build servers cannot run Sentinel.", message: "Server settings updated." });
    expect(t.store.rows[0]).toMatchObject({ server_role: "build", is_build_server: true, is_sentinel_enabled: false });
    expect((await t.call("PATCH", `${uuid}/role`, { serverRole: "web" })).body.error?.details.fields).toEqual({ serverRole: ["The selected Server Role is invalid."] });
  });

  it("lists the SSH keys for the server, its own first, with public keys", async () => {
    const t = setup();
    await t.add({ private_key_uuid: "key2bbbbbbbbbbbbbbbbbbbb" });
    const uuid = t.store.rows[0]!.uuid;
    const r = await t.call("GET", `${uuid}/private-key`);
    const keys = r.body.data?.privateKeys as Array<{ uuid: string; publicKey: string; isActive: boolean }>;
    expect(keys.map((k) => [k.uuid, k.isActive])).toEqual([
      ["key2bbbbbbbbbbbbbbbbbbbb", true],
      ["key1aaaaaaaaaaaaaaaaaaaa", false],
    ]);
    expect(keys[0]!.publicKey).toMatch(/^ecdsa-sha2-nistp256 AAAA/);
    expect(keys[1]!.publicKey).toMatch(/^ssh-ed25519 AAAA/);
    expect(JSON.stringify(r.body)).not.toContain("PRIVATE KEY");
  });

  it("switches the server's key: 'Private key updated successfully.'", async () => {
    const t = setup();
    await t.add();
    const uuid = t.store.rows[0]!.uuid;
    const r = await t.call("PATCH", `${uuid}/private-key`, { private_key_uuid: "key2bbbbbbbbbbbbbbbbbbbb" });
    expect(r.body.data).toEqual({ message: "Private key updated successfully." });
    expect(t.store.rows[0]!.private_key_id).toBe(101);
    const bad = await t.call("PATCH", `${uuid}/private-key`, { private_key_uuid: "nosuchkey" });
    expect(bad.body.error?.message).toBe("You are not allowed to use this private key.");
    t.store.rows[0]!.server_metadata = { transfer: { status: "transferred" } };
    const moved = await t.call("PATCH", `${uuid}/private-key`, { private_key_uuid: "key1aaaaaaaaaaaaaaaaaaaa" });
    expect(moved.body.error?.message).toBe("The private key of a transferred server cannot be changed.");
  });

  it("answers what needs SSH with what is missing", async () => {
    const t = setup();
    await t.add();
    const uuid = t.store.rows[0]!.uuid;
    const validate = await t.call("POST", `${uuid}/validate`);
    expect(validate.status).toBe(501);
    expect(validate.body.error).toMatchObject({ code: "unsupported", message: "Validating the server needs the SSH executor, which is not available yet." });
    const check = await t.call("POST", `${uuid}/check-connection`);
    expect(check.status).toBe(501);
    expect(check.body.error?.message).toBe("Checking the connection needs the SSH executor, which is not available yet.");
    const details = await t.call("POST", `${uuid}/refresh-metadata`);
    expect(details.status).toBe(422);
    expect(details.body.error?.message).toBe("Validate the server connection before fetching details.");
    expect((await t.call("POST", "nosuchserver/validate")).status).toBe(404);
  });

  it("deletes a server", async () => {
    const t = setup();
    await t.add();
    const uuid = t.store.rows[0]!.uuid;
    expect((await t.call("DELETE", uuid)).body.data).toEqual({ deleted: true });
    expect(t.store.rows).toHaveLength(0);
    expect((await t.call("DELETE", uuid)).status).toBe(404);
  });

  it("404s writes when policy denies deploy.resource.write, and reports canWrite false on reads", async () => {
    const t = setup({ write: false });
    expect((await t.add()).status).toBe(404);
    expect((await t.call("GET", "new")).status).toBe(404);
    expect(t.orgs).toHaveLength(0);
    expect((await t.call("GET")).body.data).toEqual({ servers: [], canWrite: false });
  });

  it("404s reads when policy denies deploy.resource.read", async () => {
    const t = setup({ read: false });
    expect((await t.call("GET")).status).toBe(404);
  });

  it("405s a method a path does not take, 404s an unknown path", async () => {
    const t = setup();
    expect((await t.call("PUT")).status).toBe(405);
    expect((await t.call("POST", "abc")).status).toBe(405);
    expect((await t.call("GET", "abc/validate")).status).toBe(405);
    expect((await t.call("GET", "abc/proxy")).status).toBe(404);
  });
});

describe("router: /deploy/servers", () => {
  const env: Env = { ENVIRONMENT: "test" };
  it("401s without an actor and 404s an org id that does not parse", async () => {
    expect((await route(new Request(BASE), env)).status).toBe(401);
    const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
    expect((await route(new Request("https://x/v1/organizations/nope/deploy/servers", { headers }), env)).status).toBe(404);
    expect((await route(new Request(`${BASE}/abc`, { headers }), env)).status).toBe(503);
    expect((await route(new Request(`${BASE}/abc/private-key/x`, { headers }), env)).status).toBe(404);
  });
});
