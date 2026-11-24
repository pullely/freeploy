// Keys & Tokens → Cloud-Init Scripts (DP-45): Coolify's rules and messages
// (with the one YAML error ValidCloudInitYaml's port can tell), the script
// stored encrypted and shown only to who may write, and the handler's routing
// and authorization. The SQL behind the store is tested in tests/db.
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { handleCloudInitScripts, type CloudInitScriptRunner } from "@deploy-core-worker/handlers/cloud-init-scripts";
import type { CloudInitScriptStore } from "@deploy-core-worker/cloud-init-scripts/service";
import { cloudInitYamlError, validateScript } from "@deploy-core-worker/cloud-init-scripts/validation";
import type { KeyCipher } from "@deploy-core-worker/private-keys/service";
import type { CloudInitScriptChanges, DeployCloudInitScriptWithSecretRow } from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy/cloud-init-scripts`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const CLOUD_CONFIG = "#cloud-config\npackages:\n  - htop\n";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

/** deploy.cloud_init_scripts for one org, in memory (newest first, as the SQL orders); "encryption" is a reversible marker. */
class MemoryStore implements CloudInitScriptStore {
  rows: DeployCloudInitScriptWithSecretRow[] = [];
  private next = 1;
  private strip(row: DeployCloudInitScriptWithSecretRow) {
    return { id: row.id, uuid: row.uuid, name: row.name, created_at: row.created_at, updated_at: row.updated_at };
  }
  async list() {
    return [...this.rows].reverse().map((r) => this.strip(r));
  }
  async findByUuid(uuid: string) {
    return this.rows.find((r) => r.uuid === uuid) ?? null;
  }
  async insert(script: { uuid: string; name: string; script: string }) {
    const row: DeployCloudInitScriptWithSecretRow = { id: this.next++, ...script, created_at: "2026-11-24 09:30:00", updated_at: "2026-11-24 09:30:00" };
    this.rows.push(row);
    return this.strip(row);
  }
  async update(id: string | number, changes: CloudInitScriptChanges) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, changes, { updated_at: "2026-11-24 10:00:00" });
    return this.strip(row);
  }
  async delete(id: string | number) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    return this.rows.length < before;
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
  const runner: CloudInitScriptRunner = async (_env, orgId, fn) => {
    orgs.push(orgId);
    return fn({ store, cipher });
  };
  const call = async (method: string, path = "", body?: unknown) => {
    const segments = path.split("/").filter(Boolean);
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleCloudInitScripts(env, "req_1", actor, ORG_UUID, segments, new Request(`${BASE}${path ? `/${path}` : ""}`, init), runner);
    return { status: res.status, body: (await res.json()) as Body };
  };
  return { store, asked, orgs, call, env };
}

describe("Coolify's validation rules and messages", () => {
  it("name and script are required, with the components' messages", () => {
    const r = validateScript({ name: " ", script: "" });
    expect(!r.ok && r.errors).toEqual({ name: ["Script name is required."], script: ["Cloud-init script content is required."] });
    const long = validateScript({ name: "é".repeat(256), script: CLOUD_CONFIG });
    expect(!long.ok && long.errors).toEqual({ name: ["Script name cannot exceed 255 characters."] });
    const types = validateScript({ name: 5, script: 5 });
    expect(!types.ok && types.errors).toEqual({ name: ["The name field must be a string."], script: ["The script field must be a string."] });
    const ok = validateScript({ name: "é".repeat(255), script: CLOUD_CONFIG });
    expect(ok.ok && ok.input).toEqual({ name: "é".repeat(255), script: CLOUD_CONFIG });
  });

  it("ValidCloudInitYaml: a shebang script is never parsed", () => {
    expect(cloudInitYamlError("#!/bin/bash\n\tapt-get update\n")).toBeNull();
    expect(cloudInitYamlError("\n  #!/bin/sh\n\techo hi")).toBeNull();
    expect(cloudInitYamlError("0")).toBeNull();
  });

  it("ValidCloudInitYaml: cloud-config, with or without its header, passes", () => {
    expect(cloudInitYamlError(CLOUD_CONFIG)).toBeNull();
    expect(cloudInitYamlError("packages:\n  - htop\nruncmd:\n  - [ls, -l]\n")).toBeNull();
    // preg_replace('/^#cloud-config\s*/m', …) takes the white space after the header with it, a tab included.
    expect(cloudInitYamlError("#cloud-config\n\tpackages: []\n")).toBeNull();
  });

  it("ValidCloudInitYaml: a first line indented with a tab is Symfony's parse error, in Coolify's two messages", () => {
    expect(cloudInitYamlError("#cloud-config\n# packages\n\tpackages: []\n")).toBe(
      'The script must be valid YAML format. Error: A YAML file cannot contain tabs as indentation at line 2 (near "\tpackages: []").',
    );
    expect(cloudInitYamlError("# my config\n\n\tpackages: []\n")).toBe(
      'The script must be either a valid bash script (starting with #!) or valid cloud-config YAML. YAML parse error: A YAML file cannot contain tabs as indentation at line 3 (near "\tpackages: []").',
    );
    const r = validateScript({ name: "tabs", script: "# c\n\tpackages: []" });
    expect(!r.ok && r.errors.script).toEqual([
      'The script must be either a valid bash script (starting with #!) or valid cloud-config YAML. YAML parse error: A YAML file cannot contain tabs as indentation at line 2 (near "\tpackages: []").',
    ]);
  });
});

describe("cloud-init scripts", () => {
  it("creates a script: stored encrypted, 'Cloud-init script created successfully.'", async () => {
    const t = setup();
    const r = await t.call("POST", "", { name: "base", script: CLOUD_CONFIG });
    expect(r.status).toBe(201);
    expect(r.body.data).toEqual({ uuid: expect.stringMatching(/^[a-z0-9]{24}$/), message: "Cloud-init script created successfully." });
    expect(t.store.rows[0]).toMatchObject({ name: "base", script: `enc:${CLOUD_CONFIG}` });
    expect(t.orgs).toEqual([ORG_UUID]);
    expect(t.asked).toEqual(["deploy.resource.write"]);
  });

  it("answers field errors before touching the store", async () => {
    const t = setup();
    const r = await t.call("POST", "", { name: "", script: "" });
    expect(r.status).toBe(422);
    expect(r.body.error?.details.fields).toEqual({ name: ["Script name is required."], script: ["Cloud-init script content is required."] });
    expect(t.orgs).toHaveLength(0);
  });

  it("lists the org's scripts newest first, never the script", async () => {
    const t = setup();
    await t.call("POST", "", { name: "first", script: CLOUD_CONFIG });
    await t.call("POST", "", { name: "second", script: "#!/bin/sh\necho secret-step\n" });
    t.asked.length = 0;
    const r = await t.call("GET");
    expect(r.body.data).toEqual({
      scripts: [
        { uuid: t.store.rows[1]!.uuid, name: "second", updatedAt: "2026-11-24T09:30:00.000Z" },
        { uuid: t.store.rows[0]!.uuid, name: "first", updatedAt: "2026-11-24T09:30:00.000Z" },
      ],
      canWrite: true,
    });
    expect(JSON.stringify(r.body)).not.toContain("secret-step");
    expect(t.asked.sort()).toEqual(["deploy.resource.read", "deploy.resource.write"]);
  });

  it("shows a script with its content to who may write; a reader gets the name only", async () => {
    const t = setup();
    await t.call("POST", "", { name: "base", script: CLOUD_CONFIG });
    const uuid = t.store.rows[0]!.uuid!;
    expect((await t.call("GET", uuid)).body.data).toEqual({ uuid, name: "base", script: CLOUD_CONFIG, canUpdate: true });
    expect((await t.call("GET", "nosuchscript")).status).toBe(404);
    const reader = setup({ write: false });
    reader.store.rows = t.store.rows;
    const r = await reader.call("GET", uuid);
    expect(r.body.data).toEqual({ uuid, name: "base", script: null, canUpdate: false });
    expect(JSON.stringify(r.body)).not.toContain("htop");
  });

  it("updates the name and the script: 'Cloud-init script updated successfully.'", async () => {
    const t = setup();
    await t.call("POST", "", { name: "base", script: CLOUD_CONFIG });
    const uuid = t.store.rows[0]!.uuid!;
    const r = await t.call("PATCH", uuid, { name: "base 2", script: "#!/bin/sh\necho hi\n" });
    expect(r.body.data).toEqual({ uuid, message: "Cloud-init script updated successfully." });
    expect(t.store.rows[0]).toMatchObject({ name: "base 2", script: "enc:#!/bin/sh\necho hi\n" });
    const bad = await t.call("PATCH", uuid, { name: "base 2", script: " " });
    expect(bad.body.error?.details.fields).toEqual({ script: ["Cloud-init script content is required."] });
    expect((await t.call("PATCH", "nosuchscript", { name: "x", script: "#!x" })).status).toBe(404);
  });

  it("deletes a script: 'Cloud-init script deleted successfully.'", async () => {
    const t = setup();
    await t.call("POST", "", { name: "base", script: CLOUD_CONFIG });
    const uuid = t.store.rows[0]!.uuid!;
    expect((await t.call("DELETE", uuid)).body.data).toEqual({ deleted: true, message: "Cloud-init script deleted successfully." });
    expect(t.store.rows).toHaveLength(0);
    expect((await t.call("DELETE", uuid)).status).toBe(404);
  });

  it("404s writes when policy denies deploy.resource.write, and reports canWrite false on reads", async () => {
    const t = setup({ write: false });
    expect((await t.call("POST", "", { name: "n", script: "#!x" })).status).toBe(404);
    expect((await t.call("PATCH", "abc", { name: "n", script: "#!x" })).status).toBe(404);
    expect((await t.call("DELETE", "abc")).status).toBe(404);
    expect(t.orgs).toHaveLength(0);
    expect((await t.call("GET")).body.data).toEqual({ scripts: [], canWrite: false });
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
    expect((await t.call("POST", "abc")).status).toBe(405);
    expect((await t.call("GET", "abc/def")).status).toBe(404);
  });
});

describe("router: /deploy/cloud-init-scripts", () => {
  const env: Env = { ENVIRONMENT: "test" };
  it("401s without an actor and 404s an org id that does not parse", async () => {
    expect((await route(new Request(BASE), env)).status).toBe(401);
    const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
    expect((await route(new Request("https://x/v1/organizations/nope/deploy/cloud-init-scripts", { headers }), env)).status).toBe(404);
    expect((await route(new Request(`${BASE}/abc`, { headers }), env)).status).toBe(503);
    expect((await route(new Request(`${BASE}/abc/def`, { headers }), env)).status).toBe(404);
  });
});
