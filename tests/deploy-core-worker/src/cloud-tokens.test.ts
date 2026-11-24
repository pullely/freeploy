// Keys & Tokens → Cloud Tokens, and a server's Cloud Token page (DP-45):
// Coolify's rules and messages, what each provider is asked (through a fake
// ProviderHttp: no test touches the network), the token stored encrypted and
// never returned, and the handlers' routing and authorization. The SQL behind
// the store (and its row-level security) is tested in tests/db.
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { handleCloudTokens, handleServerCloudToken, type CloudTokenRunner } from "@deploy-core-worker/handlers/cloud-tokens";
import { handleServers } from "@deploy-core-worker/handlers/servers";
import type { CloudTokenStore } from "@deploy-core-worker/cloud-tokens/service";
import { utcIso } from "@deploy-core-worker/cloud-tokens/service";
import { providerName, validationEndpoint, type ProviderHttp } from "@deploy-core-worker/cloud-tokens/providers";
import { validateCreateToken, validateUpdateToken } from "@deploy-core-worker/cloud-tokens/validation";
import type { KeyCipher } from "@deploy-core-worker/private-keys/service";
import type { CloudProviderTokenChanges, DeployCloudProviderTokenWithSecretRow, DeployServerCloudRow, DeployServerRow } from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy/cloud-tokens`;
const SERVERS = `https://x/v1/organizations/${ORG}/deploy/servers`;
const SERVER = "srvaaaaaaaaaaaaaaaaaaaaa";
const actor = { subjectId: "usr_1", subjectType: "user" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

function serverRow(over: Partial<DeployServerRow> = {}): DeployServerRow {
  return {
    id: 1, uuid: SERVER, name: "cloud-1", description: null, ip: "203.0.113.10", port: 22, user: "root", private_key_id: 100, private_key_uuid: null,
    proxy: {}, validation_logs: null, server_metadata: null, is_validating: false, hetzner_server_id: 4242, vultr_instance_id: null,
    hostinger_virtual_machine_id: null, created_at: null, updated_at: null, settings_id: 1, is_reachable: true, is_usable: true, force_disabled: false,
    is_swarm_manager: false, is_swarm_worker: false, is_build_server: false, server_role: "both", connection_timeout: 10, wildcard_domain: null,
    public_ipv4: null, public_ipv6: null, server_timezone: "UTC", is_metrics_enabled: false, is_sentinel_enabled: true, is_image_scan_enabled: false,
    ssh_host_key_pending: null, is_cloudflare_tunnel: false, org_uses_swarm: false,
    ...over,
  };
}

/** deploy.cloud_provider_tokens and one server of one org, in memory; "encryption" is a reversible marker. */
class MemoryStore implements CloudTokenStore {
  rows: DeployCloudProviderTokenWithSecretRow[] = [];
  server = serverRow();
  serverTokenId: string | number | null = null;
  /** Servers other than `server` that use a token, by token id. */
  otherServers = new Map<number, number>();
  private next = 1;
  private strip(row: DeployCloudProviderTokenWithSecretRow) {
    return { id: row.id, uuid: row.uuid, provider: row.provider, name: row.name, description: row.description, created_at: row.created_at, updated_at: row.updated_at };
  }
  async list(provider?: string) {
    return this.rows.filter((r) => provider === undefined || r.provider === provider).map((r) => this.strip(r));
  }
  async findByUuid(uuid: string) {
    return this.rows.find((r) => r.uuid === uuid) ?? null;
  }
  async findById(id: string | number) {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async insert(token: { uuid: string; provider: string; token: string; name: string; description: string | null }) {
    const row: DeployCloudProviderTokenWithSecretRow = { id: this.next++, ...token, created_at: "2026-11-24 09:30:00", updated_at: "2026-11-24 09:30:00" };
    this.rows.push(row);
    return this.strip(row);
  }
  async update(id: string | number, changes: CloudProviderTokenChanges) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, changes);
    return this.strip(row);
  }
  async delete(id: string | number) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    return this.rows.length < before;
  }
  async serverCount(id: string | number) {
    return (this.otherServers.get(Number(id)) ?? 0) + (this.serverTokenId === id ? 1 : 0);
  }
  async findServer(uuid: string) {
    return uuid === this.server.uuid ? this.server : null;
  }
  async findServerCloud(uuid: string): Promise<DeployServerCloudRow | null> {
    const s = this.server;
    if (uuid !== s.uuid) return null;
    return {
      id: s.id, uuid: s.uuid, name: s.name, hetzner_server_id: s.hetzner_server_id, vultr_instance_id: s.vultr_instance_id,
      hostinger_virtual_machine_id: s.hostinger_virtual_machine_id, cloud_provider_token_id: this.serverTokenId,
    };
  }
  async setServerToken(serverId: string | number, tokenId: string | number) {
    if (serverId !== this.server.id) return false;
    this.serverTokenId = tokenId;
    return true;
  }
}

const cipher: KeyCipher = {
  encrypt: async (p) => `enc:${p}`,
  decrypt: async (s) => {
    if (!s.startsWith("enc:")) throw new Error("not encrypted");
    return s.slice(4);
  },
};

type Body = { data?: Record<string, unknown>; error?: { code: string; message: string; details: { fields?: Record<string, string[]>; denied?: string } } };

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
  const runner: CloudTokenRunner = async (_env, orgId, fn) => {
    orgs.push(orgId);
    return fn({ store, cipher });
  };
  /** The provider: every request recorded; `answer` decides whether it is 2xx. */
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const provider = { answer: (_url: string): boolean => true, fail: null as Error | null };
  const http: ProviderHttp = async (url, headers) => {
    requests.push({ url, headers });
    if (provider.fail) throw provider.fail;
    return { ok: provider.answer(url) };
  };
  const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });
  const call = async (method: string, path = "", body?: unknown) => {
    const segments = path.split("/").filter(Boolean);
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    return answer(await handleCloudTokens(env, "req_1", actor, ORG_UUID, segments, new Request(`${BASE}${path ? `/${path}` : ""}`, init), runner, http));
  };
  const server = async (method: string, path = "", body?: unknown, uuid = SERVER) => {
    const segments = path.split("/").filter(Boolean);
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    return answer(await handleServerCloudToken(env, "req_1", actor, ORG_UUID, uuid, segments, new Request(`${SERVERS}/${uuid}/cloud-provider-token${path ? `/${path}` : ""}`, init), runner, http));
  };
  const add = async (providerId: string, name: string, token = "tok-1") => {
    const r = await call("POST", "", { provider: providerId, token, name });
    requests.length = 0;
    asked.length = 0;
    return String(r.body.data?.uuid);
  };
  return { store, asked, orgs, call, server, add, env, requests, provider };
}

describe("Coolify's validation rules and messages", () => {
  it("CloudProviderTokenForm: provider, token and name with the component's messages", () => {
    const r = validateCreateToken({ provider: "", token: " ", name: null });
    expect(!r.ok && r.errors).toEqual({ provider: ["Please select a cloud provider."], token: ["API token is required."], name: ["Token name is required."] });
    const bad = validateCreateToken({ provider: "aws", token: "t", name: "n" });
    expect(!bad.ok && bad.errors).toEqual({ provider: ["Invalid cloud provider selected."] });
    const types = validateCreateToken({ provider: 5, token: 5, name: 5, description: 5 });
    expect(!types.ok && types.errors).toEqual({
      provider: ["The provider field must be a string.", "Invalid cloud provider selected."],
      token: ["The token field must be a string."],
      name: ["The name field must be a string."],
      description: ["The description field must be a string."],
    });
  });

  it("name max 255 and description max 1000, Laravel's default messages; a blank description is null and a kept one is trimmed", () => {
    const long = validateCreateToken({ provider: "hetzner", token: "t", name: "é".repeat(256), description: "d".repeat(1001) });
    expect(!long.ok && long.errors).toEqual({
      name: ["The name field must not be greater than 255 characters."],
      description: ["The description field must not be greater than 1000 characters."],
    });
    const ok = validateCreateToken({ provider: "vultr", token: " t ", name: "é".repeat(255), description: "  notes <b>  " });
    expect(ok.ok && ok.input).toEqual({ provider: "vultr", token: " t ", name: "é".repeat(255), description: "notes <b>" });
    for (const p of ["hetzner", "digitalocean", "vultr", "hostinger"]) expect(validateCreateToken({ provider: p, token: "t", name: "n" }).ok).toBe(true);
    const blank = validateUpdateToken({ name: "n", description: "   " });
    expect(blank.ok && blank.input).toEqual({ name: "n", description: null });
  });

  it("Show: 'Token name is required.'", () => {
    const r = validateUpdateToken({ name: "" });
    expect(!r.ok && r.errors).toEqual({ name: ["Token name is required."] });
  });
});

describe("providers", () => {
  it("names them as Coolify does; anything else reads Hetzner", () => {
    expect(["hetzner", "digitalocean", "vultr", "hostinger", "other"].map(providerName)).toEqual(["Hetzner", "DigitalOcean", "Vultr", "Hostinger", "Hetzner"]);
  });
  it("validationEndpoint() per provider", () => {
    expect(["hetzner", "digitalocean", "vultr", "hostinger"].map(validationEndpoint)).toEqual([
      "https://api.hetzner.cloud/v1/servers",
      "https://api.digitalocean.com/v2/account",
      "https://api.vultr.com/v2/account",
      "https://developers.hostinger.com/api/vps/v1/virtual-machines",
    ]);
  });
  it("reads a stored timestamp as UTC", () => {
    expect(utcIso("2026-11-24 09:30:00")).toBe("2026-11-24T09:30:00.000Z");
    expect(utcIso(new Date("2026-11-24T09:30:00Z"))).toBe("2026-11-24T09:30:00.000Z");
    expect(utcIso(null)).toBeNull();
  });
});

describe("cloud tokens", () => {
  it("adds a token once the provider accepts it: each provider's request, the token stored encrypted", async () => {
    const expected: Record<string, { url: string; headers: Record<string, string> }> = {
      hetzner: { url: "https://api.hetzner.cloud/v1/servers", headers: { Authorization: "Bearer tok-1" } },
      digitalocean: { url: "https://api.digitalocean.com/v2/account", headers: { Authorization: "Bearer tok-1", Accept: "application/json" } },
      vultr: { url: "https://api.vultr.com/v2/account", headers: { Authorization: "Bearer tok-1" } },
      hostinger: { url: "https://developers.hostinger.com/api/vps/v1/virtual-machines", headers: { Authorization: "Bearer tok-1", Accept: "application/json" } },
    };
    for (const [provider, request] of Object.entries(expected)) {
      const t = setup();
      const r = await t.call("POST", "", { provider, token: "tok-1", name: `Production ${provider} token`, description: " notes " });
      expect(r.status).toBe(201);
      expect(r.body.data).toEqual({ uuid: expect.stringMatching(/^[a-z0-9]{24}$/), message: "Cloud provider token added successfully." });
      expect(t.requests).toEqual([request]);
      expect(t.store.rows[0]).toMatchObject({ provider, token: "enc:tok-1", name: `Production ${provider} token`, description: "notes" });
      expect(JSON.stringify(r.body)).not.toContain("tok-1");
      expect(t.orgs).toEqual([ORG_UUID]);
    }
  });

  it("refuses a token the provider does not accept, or that cannot be checked: nothing stored", async () => {
    const t = setup();
    t.provider.answer = () => false;
    const r = await t.call("POST", "", { provider: "hetzner", token: "bad", name: "n" });
    expect(r.status).toBe(422);
    expect(r.body.error?.message).toBe("Invalid API token. Please check your token and try again.");
    t.provider.fail = new Error("connect timeout");
    expect((await t.call("POST", "", { provider: "hetzner", token: "bad", name: "n" })).body.error?.message).toBe("Invalid API token. Please check your token and try again.");
    expect(t.store.rows).toHaveLength(0);
    expect(t.orgs).toHaveLength(0);
  });

  it("answers field errors before asking the provider", async () => {
    const t = setup();
    const r = await t.call("POST", "", { provider: "aws", token: "", name: "" });
    expect(r.status).toBe(422);
    expect(r.body.error?.details.fields).toEqual({ provider: ["Invalid cloud provider selected."], token: ["API token is required."], name: ["Token name is required."] });
    expect(t.requests).toHaveLength(0);
  });

  it("lists the org's tokens with the provider badge, never the token", async () => {
    const t = setup();
    await t.add("digitalocean", "ocean", "do-secret");
    await t.add("hetzner", "hz", "hz-secret");
    const r = await t.call("GET");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      tokens: [
        { uuid: t.store.rows[0]!.uuid, name: "ocean", description: null, provider: "digitalocean", providerName: "DigitalOcean", createdAt: "2026-11-24T09:30:00.000Z" },
        { uuid: t.store.rows[1]!.uuid, name: "hz", description: null, provider: "hetzner", providerName: "Hetzner", createdAt: "2026-11-24T09:30:00.000Z" },
      ],
      canWrite: true,
    });
    expect(JSON.stringify(r.body)).not.toContain("secret");
    expect(t.asked.sort()).toEqual(["deploy.resource.read", "deploy.resource.write"]);
  });

  it("shows a token: name, description, provider, created; never the token", async () => {
    const t = setup();
    const uuid = await t.add("vultr", "edge", "vu-secret");
    const r = await t.call("GET", uuid);
    expect(r.body.data).toEqual({ uuid, name: "edge", description: null, provider: "vultr", providerName: "Vultr", createdAt: "2026-11-24T09:30:00.000Z", canUpdate: true });
    expect((await t.call("GET", "nosuchtoken")).status).toBe(404);
  });

  it("renames a token: 'Cloud provider token updated.'; the provider and the token stay", async () => {
    const t = setup();
    const uuid = await t.add("hetzner", "old");
    const r = await t.call("PATCH", uuid, { name: "new", description: "  prod  ", provider: "vultr", token: "other" });
    expect(r.body.data).toEqual({ uuid, message: "Cloud provider token updated." });
    expect(t.store.rows[0]).toMatchObject({ name: "new", description: "prod", provider: "hetzner", token: "enc:tok-1" });
    const bad = await t.call("PATCH", uuid, { name: "" });
    expect(bad.body.error?.details.fields).toEqual({ name: ["Token name is required."] });
    expect((await t.call("PATCH", "nosuchtoken", { name: "x" })).status).toBe(404);
  });

  it("validates a stored token: each provider's request and Coolify's toast", async () => {
    const expected: Array<[string, string, Record<string, string>, string]> = [
      ["hetzner", "https://api.hetzner.cloud/v1/servers?per_page=1", { Authorization: "Bearer tok-1" }, "Hetzner"],
      ["digitalocean", "https://api.digitalocean.com/v2/account", { Authorization: "Bearer tok-1" }, "DigitalOcean"],
      ["vultr", "https://api.vultr.com/v2/account", { Authorization: "Bearer tok-1" }, "Vultr"],
      ["hostinger", "https://developers.hostinger.com/api/vps/v1/virtual-machines", { Authorization: "Bearer tok-1", Accept: "application/json" }, "Hostinger"],
    ];
    for (const [provider, url, headers, name] of expected) {
      const t = setup();
      const uuid = await t.add(provider, "n");
      const ok = await t.call("POST", `${uuid}/validate`);
      expect(ok.status).toBe(200);
      expect(ok.body.data).toEqual({ valid: true, message: `${name} token is valid.` });
      expect(t.requests).toEqual([{ url, headers }]);
      t.provider.answer = () => false;
      expect((await t.call("POST", `${uuid}/validate`)).body.data).toEqual({ valid: false, message: `${name} token validation failed. Please check the token.` });
      t.provider.fail = new Error("timeout");
      expect((await t.call("POST", `${uuid}/validate`)).body.data).toEqual({ valid: false, message: `${name} token validation failed. Please check the token.` });
    }
  });

  it("answers 'Unknown provider.' for a provider Coolify does not know, without a request", async () => {
    const t = setup();
    const uuid = await t.add("hetzner", "n");
    t.store.rows[0]!.provider = "linode";
    expect((await t.call("POST", `${uuid}/validate`)).body.data).toEqual({ valid: false, message: "Unknown provider." });
    expect(t.requests).toHaveLength(0);
    expect((await t.call("POST", "nosuchtoken/validate")).status).toBe(404);
  });

  it("refuses to delete a token servers use, with Coolify's count", async () => {
    const t = setup();
    const uuid = await t.add("hetzner", "used");
    t.store.otherServers.set(1, 2);
    const r = await t.call("DELETE", uuid);
    expect(r.status).toBe(409);
    expect(r.body.error?.message).toBe("Cannot delete this token. It is currently used by 2 server(s). Please reassign those servers to a different token first.");
    t.store.otherServers.clear();
    expect((await t.call("DELETE", uuid)).body.data).toEqual({ deleted: true, message: "Cloud provider token deleted successfully." });
    expect(t.store.rows).toHaveLength(0);
    expect((await t.call("DELETE", uuid)).status).toBe(404);
  });

  it("404s writes when policy denies deploy.resource.write, validating included, and reports canWrite false on reads", async () => {
    const t = setup({ write: false });
    const r = await t.call("POST", "", { provider: "hetzner", token: "t", name: "n" });
    expect(r.status).toBe(404);
    expect(t.asked).toEqual(["deploy.resource.write"]);
    expect(t.requests).toHaveLength(0);
    expect((await t.call("POST", "abc/validate")).status).toBe(404);
    expect((await t.call("PATCH", "abc", { name: "n" })).status).toBe(404);
    expect((await t.call("DELETE", "abc")).status).toBe(404);
    expect(t.orgs).toHaveLength(0);
    expect((await t.call("GET")).body.data).toEqual({ tokens: [], canWrite: false });
  });

  it("404s reads when policy denies deploy.resource.read; says which step denied outside prod only", async () => {
    const t = setup({ read: false });
    const r = await t.call("GET");
    expect(r.status).toBe(404);
    expect(r.body.error?.details).toEqual({ denied: "denied", memberships: 0 });
    t.env.ENVIRONMENT = "prod";
    expect((await t.call("GET")).body.error?.details).toEqual({});
  });

  it("405s a method a path does not take, 404s an unknown path", async () => {
    const t = setup();
    expect((await t.call("PUT")).status).toBe(405);
    expect((await t.call("GET", "abc/validate")).status).toBe(405);
    expect((await t.call("POST", "abc/reveal")).status).toBe(404);
    expect((await t.call("GET", "abc/def/ghi")).status).toBe(404);
  });
});

describe("a server's Cloud Token page", () => {
  it("shows the org's tokens of the server's provider, and which one the server uses", async () => {
    const t = setup();
    const hz = await t.add("hetzner", "hz one");
    await t.add("vultr", "vu");
    const second = await t.add("hetzner", "hz two");
    t.store.rows[2]!.description = "second project";
    t.store.serverTokenId = 3;
    const r = await t.server("GET");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      provider: "hetzner",
      providerName: "Hetzner",
      hasCloudProvider: true,
      tokens: [
        { uuid: hz, name: "hz one", description: null, createdAt: "2026-11-24T09:30:00.000Z", active: false },
        { uuid: second, name: "hz two", description: "second project", createdAt: "2026-11-24T09:30:00.000Z", active: true },
      ],
      canUpdate: true,
      canCreateToken: true,
    });
    expect((r.body.data?.server as { uuid: string; name: string; hasCloudProvider: boolean }).name).toBe("cloud-1");
    expect(JSON.stringify(r.body)).not.toContain("tok-1");
    expect(t.asked.sort()).toEqual(["deploy.resource.read", "deploy.resource.write"]);
  });

  it("follows the server's provider id: Vultr, then Hostinger, else Hetzner; none is no integration", async () => {
    const t = setup();
    t.store.server = serverRow({ hetzner_server_id: null, vultr_instance_id: "vi-1", hostinger_virtual_machine_id: 9 });
    expect((await t.server("GET")).body.data).toMatchObject({ provider: "vultr", providerName: "Vultr", hasCloudProvider: true });
    t.store.server = serverRow({ hetzner_server_id: null, hostinger_virtual_machine_id: 9 });
    expect((await t.server("GET")).body.data).toMatchObject({ provider: "hostinger", providerName: "Hostinger", hasCloudProvider: true });
    t.store.server = serverRow({ hetzner_server_id: null });
    expect((await t.server("GET")).body.data).toMatchObject({ provider: "hetzner", providerName: "Hetzner", hasCloudProvider: false, tokens: [] });
    expect((await t.server("GET", "", undefined, "nosuchserver")).status).toBe(404);
  });

  it("uses a token once it works and reads this very server: '… token updated successfully.'", async () => {
    const t = setup();
    const uuid = await t.add("hetzner", "hz");
    const r = await t.server("PATCH", "", { cloud_provider_token_uuid: uuid });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ message: "Hetzner token updated successfully." });
    expect(t.requests).toEqual([
      { url: "https://api.hetzner.cloud/v1/servers", headers: { Authorization: "Bearer tok-1" } },
      { url: "https://api.hetzner.cloud/v1/servers/4242", headers: { Authorization: "Bearer tok-1" } },
    ]);
    expect(t.store.serverTokenId).toBe(1);
    expect(t.asked).toEqual(["deploy.resource.write"]);
  });

  it("asks Vultr and Hostinger for their instance as Coolify does", async () => {
    const t = setup();
    const vu = await t.add("vultr", "vu");
    t.store.server = serverRow({ hetzner_server_id: null, vultr_instance_id: "vi-1" });
    expect((await t.server("PATCH", "", { cloud_provider_token_uuid: vu })).body.data).toEqual({ message: "Vultr token updated successfully." });
    expect(t.requests.map((r) => r.url)).toEqual(["https://api.vultr.com/v2/account", "https://api.vultr.com/v2/instances/vi-1"]);
    t.requests.length = 0;
    const ho = await t.add("hostinger", "ho");
    t.store.server = serverRow({ hetzner_server_id: null, hostinger_virtual_machine_id: 77 });
    expect((await t.server("PATCH", "", { cloud_provider_token_uuid: ho })).body.data).toEqual({ message: "Hostinger token updated successfully." });
    expect(t.requests).toEqual([
      { url: "https://developers.hostinger.com/api/vps/v1/virtual-machines", headers: { Authorization: "Bearer tok-1" } },
      { url: "https://developers.hostinger.com/api/vps/v1/virtual-machines/77", headers: { Authorization: "Bearer tok-1", Accept: "application/json" } },
    ]);
  });

  it("refuses a token that is invalid, cannot read the server, or could not be checked; the server keeps its token", async () => {
    const t = setup();
    const uuid = await t.add("hetzner", "hz");
    t.provider.answer = () => false;
    const invalid = await t.server("PATCH", "", { cloud_provider_token_uuid: uuid });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error?.message).toBe("This token is invalid or has insufficient permissions.");
    t.provider.answer = (url) => !url.endsWith("/4242");
    expect((await t.server("PATCH", "", { cloud_provider_token_uuid: uuid })).body.error?.message).toBe(
      "This token cannot access this server. It may belong to a different Hetzner project.",
    );
    t.store.server = serverRow({ hetzner_server_id: null, vultr_instance_id: "vi-1" });
    t.provider.answer = (url) => !url.endsWith("/vi-1");
    expect((await t.server("PATCH", "", { cloud_provider_token_uuid: uuid })).body.error?.message).toBe(
      "This token cannot access this instance. It may belong to a different Vultr account.",
    );
    t.store.server = serverRow({ hetzner_server_id: null, hostinger_virtual_machine_id: 77 });
    t.provider.answer = (url) => !url.endsWith("/77");
    expect((await t.server("PATCH", "", { cloud_provider_token_uuid: uuid })).body.error?.message).toBe(
      "This token cannot access this VPS. It may belong to a different Hostinger account.",
    );
    t.provider.fail = new Error("connect timeout");
    expect((await t.server("PATCH", "", { cloud_provider_token_uuid: uuid })).body.error?.message).toBe("Failed to validate token: connect timeout");
    expect(t.store.serverTokenId).toBeNull();
  });

  it("refuses a token that is not the org's: 'You are not allowed to use this token.'", async () => {
    const t = setup();
    for (const body of [{ cloud_provider_token_uuid: "nosuchtoken" }, { cloud_provider_token_uuid: 5 }, {}]) {
      const r = await t.server("PATCH", "", body);
      expect(r.status).toBe(422);
      expect(r.body.error?.message).toBe("You are not allowed to use this token.");
    }
    expect(t.requests).toHaveLength(0);
    expect((await t.server("PATCH", "", { cloud_provider_token_uuid: "x" }, "nosuchserver")).status).toBe(404);
  });

  it("validates the server's token: valid and working, invalid, none, or the request's own failure", async () => {
    const t = setup();
    const none = await t.server("POST", "validate");
    expect(none.status).toBe(422);
    expect(none.body.error?.message).toBe("No Hetzner token is associated with this server.");
    await t.add("hetzner", "hz");
    t.store.serverTokenId = 1;
    expect((await t.server("POST", "validate")).body.data).toEqual({ valid: true, message: "Hetzner token is valid and working." });
    expect(t.requests).toEqual([{ url: "https://api.hetzner.cloud/v1/servers", headers: { Authorization: "Bearer tok-1" } }]);
    t.provider.answer = () => false;
    expect((await t.server("POST", "validate")).body.data).toEqual({ valid: false, message: "Hetzner token is invalid or has insufficient permissions." });
    t.provider.fail = new Error("connect timeout");
    expect((await t.server("POST", "validate")).body.error?.message).toBe("connect timeout");
    expect((await t.server("POST", "validate", undefined, "nosuchserver")).status).toBe(404);
  });

  it("404s setting and validating when policy denies deploy.resource.write; a reader sees the page, canUpdate false", async () => {
    const t = setup({ write: false });
    expect((await t.server("PATCH", "", { cloud_provider_token_uuid: "x" })).status).toBe(404);
    expect((await t.server("POST", "validate")).status).toBe(404);
    expect(t.orgs).toHaveLength(0);
    expect((await t.server("GET")).body.data).toMatchObject({ canUpdate: false, canCreateToken: false });
    const denied = setup({ read: false });
    expect((await denied.server("GET")).status).toBe(404);
  });

  it("405s a method the page does not take, 404s a path below it", async () => {
    const t = setup();
    expect((await t.server("DELETE")).status).toBe(405);
    expect((await t.server("GET", "validate")).status).toBe(405);
    expect((await t.server("POST", "rotate")).status).toBe(404);
  });

  it("is reached through handleServers", async () => {
    const t = setup();
    const through = (method: string, path: string) =>
      handleServers(t.env, "req_1", actor, ORG_UUID, path.split("/").filter(Boolean), new Request(`${SERVERS}/${path}`, { method }));
    expect((await through("DELETE", `${SERVER}/cloud-provider-token`)).status).toBe(405);
    expect((await through("GET", `${SERVER}/cloud-provider-token/validate`)).status).toBe(405);
    expect((await through("POST", `${SERVER}/cloud-provider-token/validate/x`)).status).toBe(404);
  });
});

describe("router: /deploy/cloud-tokens", () => {
  const env: Env = { ENVIRONMENT: "test" };
  const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
  it("401s without an actor and 404s an org id that does not parse", async () => {
    expect((await route(new Request(BASE), env)).status).toBe(401);
    expect((await route(new Request("https://x/v1/organizations/nope/deploy/cloud-tokens", { headers }), env)).status).toBe(404);
    expect((await route(new Request(`${BASE}/abc`, { headers }), env)).status).toBe(503);
    expect((await route(new Request(`${BASE}/abc/validate`, { method: "POST", headers }), env)).status).toBe(503);
    expect((await route(new Request(`${BASE}/abc/validate/x`, { headers }), env)).status).toBe(404);
  });
  it("routes a server's cloud-provider-token below /deploy/servers", async () => {
    expect((await route(new Request(`${SERVERS}/${SERVER}/cloud-provider-token`, { headers }), env)).status).toBe(503);
    expect((await route(new Request(`${SERVERS}/${SERVER}/cloud-provider-token/validate`, { method: "POST", headers }), env)).status).toBe(503);
    expect((await route(new Request(`${SERVERS}/${SERVER}/cloud-provider-token`, { method: "PUT", headers }), env)).status).toBe(405);
  });
});
