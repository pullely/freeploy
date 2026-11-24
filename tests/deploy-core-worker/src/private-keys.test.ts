// Keys & Tokens → Private Keys (DP-36): Coolify's PrivateKey rules and messages, the
// Index / Create / Show operations, and the handler's routing and authorization.
// The SQL behind the store (and its row-level security) is tested in tests/db.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { handlePrivateKeys, type OrgRunner } from "@deploy-core-worker/handlers/private-keys";
import type { KeyCipher, PrivateKeyStore } from "@deploy-core-worker/private-keys/service";
import { MESSAGES, validateCreate, validateUpdate } from "@deploy-core-worker/private-keys/validation";
import { generateRandomName, newPublicId } from "@deploy-core-worker/helpers/names";
import { fingerprintSha256, formatPrivateKey } from "@deploy-core-worker/keys/ssh-keys";
import type { DeployPrivateKeyListRow, DeployPrivateKeyWithSecretRow, PrivateKeyChanges } from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy/private-keys`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const fixture = (name: string): string => readFileSync(join(process.cwd(), "fixtures", "ssh-keys", name), "utf8");
const ED25519 = fixture("ed25519.openssh");
const RSA2048 = fixture("rsa2048.openssh");
const ECDSA = fixture("ecdsa256.openssh");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

/** deploy.private_keys for one org, in memory; "encryption" is a reversible marker. */
class MemoryStore implements PrivateKeyStore {
  rows: DeployPrivateKeyWithSecretRow[] = [];
  inUse = new Set<number>();
  private next = 1;
  async list(): Promise<DeployPrivateKeyListRow[]> {
    return this.rows.map(({ private_key: _secret, ...r }) => ({ ...r, in_use: this.inUse.has(Number(r.id)) }));
  }
  async findByUuid(uuid: string) {
    return this.rows.find((r) => r.uuid === uuid) ?? null;
  }
  async insert(key: { uuid: string; name: string; description: string | null; privateKey: string; fingerprint: string | null }) {
    const row: DeployPrivateKeyWithSecretRow = {
      id: this.next++,
      uuid: key.uuid,
      name: key.name,
      description: key.description,
      private_key: key.privateKey,
      is_git_related: false,
      fingerprint: key.fingerprint,
      created_at: null,
      updated_at: null,
    };
    this.rows.push(row);
    return row;
  }
  async update(id: string | number, changes: PrivateKeyChanges) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, { name: changes.name, description: changes.description, is_git_related: changes.isGitRelated });
    if (changes.privateKey) Object.assign(row, { private_key: changes.privateKey.ciphertext, fingerprint: changes.privateKey.fingerprint });
    return row;
  }
  async delete(id: string | number) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    return this.rows.length < before;
  }
  async fingerprintExists(fp: string | null, excludeId?: string | number | null) {
    return fp !== null && this.rows.some((r) => r.fingerprint === fp && r.id !== excludeId);
  }
  async isInUse(id: string | number) {
    return this.inUse.has(Number(id));
  }
  async usages(id: string | number) {
    return this.inUse.has(Number(id))
      ? { counts: { Server: 1 }, matches: 1, rows: [{ type: "Server" as const, name: "prod-1", url: "/server/s1" }] }
      : { counts: {}, matches: 0, rows: [] };
  }
}

const cipher: KeyCipher = {
  encrypt: async (p) => `enc:${p}`,
  decrypt: async (s) => {
    if (!s.startsWith("enc:")) throw new Error("not encrypted");
    return s.slice(4);
  },
};

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
  const runner: OrgRunner = async (_env, orgId, fn) => {
    orgs.push(orgId);
    return fn({ store, cipher });
  };
  const call = async (method: string, path = "", body?: unknown) => {
    const segments = path.split("?")[0]!.split("/").filter(Boolean);
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handlePrivateKeys(env, "req_1", actor, ORG_UUID, segments, new Request(`${BASE}${path ? `/${path}` : ""}`, init), runner);
    return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown>; error?: { message: string; details: { fields?: Record<string, string[]> } } } };
  };
  return { store, asked, orgs, call, env };
}

describe("Coolify's validation rules and messages", () => {
  it("Create: name, description and the Private Key field", () => {
    const r = validateCreate({ name: "", description: "", value: " " });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual({ name: ["The name field is required."], value: ["The Private Key field is required."] });
  });

  it("names: min 3, max 255, NAME_PATTERN; every failing rule in order", () => {
    const short = validateCreate({ name: "a$", value: "k" });
    expect(!short.ok && short.errors.name).toEqual([MESSAGES.nameMin(3), MESSAGES.nameRegex]);
    expect(MESSAGES.nameMin(3)).toBe("The name must be at least 3 characters.");
    const long = validateCreate({ name: "é".repeat(256), value: "k" });
    expect(!long.ok && long.errors.name).toEqual(["The name may not be greater than 255 characters."]);
    expect(validateCreate({ name: "Ünïcode key (prod) #1, a/b: c+d @team & co", value: "k" }).ok).toBe(true);
    const bad = validateCreate({ name: "key<script>", value: "k" });
    expect(!bad.ok && bad.errors.name).toEqual(["The name may only contain letters (including Unicode), numbers, spaces, and these characters: - _ . / @ & ( ) # , : +"]);
  });

  it("descriptions: nullable, max 255, DESCRIPTION_PATTERN", () => {
    expect(validateCreate({ name: "abc", description: null, value: "k" }).ok).toBe(true);
    expect(validateCreate({ name: "abc", description: `It's "fine" = ok?!*`, value: "k" }).ok).toBe(true);
    const bad = validateCreate({ name: "abc", description: "no <tags>", value: "k" });
    expect(!bad.ok && bad.errors.description).toEqual([
      "The description may only contain letters (including Unicode), numbers, spaces, and common punctuation: - _ . , ! ? ( ) ' \" + = * / @ &",
    ]);
    const long = validateCreate({ name: "abc", description: "d".repeat(256), value: "k" });
    expect(!long.ok && long.errors.description).toEqual(["The description may not be greater than 255 characters."]);
  });

  it("Show: 'The Name field is required.'; an empty new key keeps the stored one; a blank description is null", () => {
    const r = validateUpdate({ name: " ", description: "x" });
    expect(!r.ok && r.errors.name).toEqual(["The Name field is required."]);
    const ok = validateUpdate({ name: "abc", description: "  ", newPrivateKey: "   " });
    expect(ok.ok && ok.input).toEqual({ name: "abc", description: null, newPrivateKey: null });
    const bad = validateUpdate({ name: "abc", newPrivateKey: 5 });
    expect(!bad.ok && bad.errors.newPrivateKey).toEqual(["The Private Key must be a valid string."]);
  });
});

describe("new_public_id and generate_random_name", () => {
  it("24 lowercase letters and digits", () => {
    for (let i = 0; i < 50; i++) expect(newPublicId()).toMatch(/^[a-z0-9]{24}$/);
  });
  it("an alliterating adjective-noun pair and a public id, kebab case", () => {
    for (let i = 0; i < 50; i++) {
      const name = generateRandomName();
      const m = name.match(/^([a-z]+)-([a-z]+)-([a-z0-9]{24})$/);
      expect(m).not.toBeNull();
      expect(m![1]![0]).toBe(m![2]![0]);
    }
    expect(generateRandomName("abc")).toMatch(/^[a-z]+-[a-z]+-abc$/);
  });
});

describe("private keys", () => {
  it("lists the org's keys with their status, never the key", async () => {
    const t = setup();
    await t.call("POST", "", { name: "my key", description: "", value: ED25519 });
    t.store.inUse.add(1);
    t.asked.length = 0;
    const r = await t.call("GET");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ privateKeys: [{ uuid: t.store.rows[0]!.uuid, name: "my key", description: "", is_git_related: false, is_in_use: true }], canWrite: true });
    expect(JSON.stringify(r.body)).not.toContain("PRIVATE KEY");
    expect(t.orgs.every((o) => o === ORG_UUID)).toBe(true);
    expect(t.asked.sort()).toEqual(["deploy.resource.read", "deploy.resource.write"]);
  });

  it("creates a key: trim($value).\"\\n\", stored encrypted with its fingerprint", async () => {
    const t = setup();
    const r = await t.call("POST", "", { name: "my key", description: "laptop", value: `\n${ED25519}\n\n` });
    expect(r.status).toBe(201);
    expect(r.body.data).toEqual({ uuid: expect.stringMatching(/^[a-z0-9]{24}$/), message: "Private key created successfully." });
    const row = t.store.rows[0]!;
    expect(row.private_key).toBe(`enc:${formatPrivateKey(ED25519)}`);
    expect(row.fingerprint).toBe(await fingerprintSha256(ED25519));
  });

  it("refuses the same key twice in the org: 'This private key already exists.'", async () => {
    const t = setup();
    await t.call("POST", "", { name: "one", value: ED25519 });
    const r = await t.call("POST", "", { name: "two", value: ED25519 });
    expect(r.status).toBe(422);
    expect(r.body.error?.details.fields).toEqual({ private_key: ["This private key already exists."] });
    expect(t.store.rows).toHaveLength(1);
  });

  it("refuses an invalid key with PrivateKey::validationError's message", async () => {
    const t = setup();
    const r = await t.call("POST", "", { name: "bad", value: fixture("ed25519.pub") });
    expect(r.status).toBe(422);
    expect(r.body.error?.details.fields?.private_key).toEqual(["The private key is invalid. Paste an unencrypted private key, not a public key or a certificate."]);
  });

  it("answers field errors before touching the store", async () => {
    const t = setup();
    const r = await t.call("POST", "", { name: "x", value: "" });
    expect(r.status).toBe(422);
    expect(r.body.error?.details.fields).toEqual({ name: ["The name must be at least 3 characters."], value: ["The Private Key field is required."] });
    expect(t.orgs).toHaveLength(0);
  });

  it("checks a key as it is typed: the error, or the public key", async () => {
    const t = setup();
    const ok = await t.call("POST", "validate", { value: ED25519 });
    expect(ok.body.data).toEqual({ error: null, publicKey: expect.stringMatching(/^ssh-ed25519 AAAA\S+$/) });
    const bad = await t.call("POST", "validate", { value: "nope" });
    expect(bad.body.data).toEqual({ error: "The private key is invalid. Paste an unencrypted private key, not a public key or a certificate.", publicKey: "" });
  });

  it("generates an ed25519 key with a random name, 'Created by Freeploy'", async () => {
    const t = setup();
    const r = await t.call("POST", "generate", { type: "ed25519" });
    expect(r.status).toBe(201);
    expect(r.body.data?.message).toBe("Private key generated successfully.");
    const row = t.store.rows[0]!;
    expect(row.name).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{24}$/);
    expect(row.description).toBe("Created by Freeploy");
    expect(row.private_key).toMatch(/^enc:-----BEGIN OPENSSH PRIVATE KEY-----\n[\s\S]+-----END OPENSSH PRIVATE KEY-----\n$/);
    expect(row.fingerprint).toMatch(/^[A-Za-z0-9+/]{43}$/);
  });

  it("generates an RSA key", async () => {
    const t = setup();
    const r = await t.call("POST", "generate", { type: "rsa" });
    expect(r.status).toBe(201);
    expect(t.store.rows[0]!.private_key).toMatch(/^enc:-----BEGIN RSA PRIVATE KEY-----/);
  }, 60_000);

  it("refuses another key type: 'Invalid private key type.'", async () => {
    const t = setup();
    const r = await t.call("POST", "generate", { type: "dsa" });
    expect(r.status).toBe(422);
    expect(r.body.error?.message).toBe("Invalid private key type.");
  });

  it("shows a key: public key, fingerprint, usage; never the private key", async () => {
    const t = setup();
    await t.call("POST", "", { name: "shown", value: ED25519 });
    t.store.inUse.add(1);
    const uuid = t.store.rows[0]!.uuid;
    const r = await t.call("GET", uuid);
    expect(r.status).toBe(200);
    const expected = JSON.parse(fixture("expected.json")) as Record<string, { public: string; sha256: string }>;
    expect(r.body.data).toMatchObject({
      uuid,
      name: "shown",
      description: null,
      publicKey: expected["ed25519.openssh"]!.public.split(" ").slice(0, 2).join(" "),
      fingerprint: expected["ed25519.openssh"]!.sha256,
      isInUse: true,
      hasServers: true,
      usedByOthers: false,
      canUpdate: true,
      usages: { counts: { Server: 1 }, matches: 1, rows: [{ type: "Server", name: "prod-1", url: "/server/s1" }] },
    });
    expect(JSON.stringify(r.body)).not.toContain("PRIVATE KEY");
    expect((await t.call("GET", "nosuchkey")).status).toBe(404);
  });

  it("shows 'Error loading private key' when the stored key does not load", async () => {
    const t = setup();
    await t.store.insert({ uuid: "broken", name: "broken", description: null, privateKey: "garbage", fingerprint: null });
    const r = await t.call("GET", "broken");
    expect(r.body.data?.publicKey).toBe("Error loading private key");
  });

  it("renames a key without touching it, and replaces it with a new one", async () => {
    const t = setup();
    await t.call("POST", "", { name: "first", value: ED25519 });
    const uuid = t.store.rows[0]!.uuid;
    const renamed = await t.call("PATCH", uuid, { name: "renamed", description: "" });
    expect(renamed.body.data?.message).toBe("Private key updated.");
    expect(t.store.rows[0]).toMatchObject({ name: "renamed", description: null, private_key: `enc:${formatPrivateKey(ED25519)}` });
    const replaced = await t.call("PATCH", uuid, { name: "renamed", description: "new", newPrivateKey: RSA2048 });
    expect(replaced.status).toBe(200);
    expect(t.store.rows[0]).toMatchObject({ description: "new", private_key: `enc:${formatPrivateKey(RSA2048)}`, fingerprint: await fingerprintSha256(RSA2048) });
  });

  it("refuses a replacement that is another key of the org, or not valid", async () => {
    const t = setup();
    await t.call("POST", "", { name: "first", value: ED25519 });
    await t.call("POST", "", { name: "second", value: ECDSA });
    const uuid = t.store.rows[1]!.uuid;
    const dup = await t.call("PATCH", uuid, { name: "second", newPrivateKey: ED25519 });
    expect(dup.body.error?.details.fields).toEqual({ private_key: ["This private key already exists."] });
    const short = await t.call("PATCH", uuid, { name: "second", newPrivateKey: fixture("rsa1024.openssh") });
    expect(short.body.error?.details.fields).toEqual({ private_key: ["RSA keys must have at least 2048 bits."] });
    const name = await t.call("PATCH", uuid, { name: "" });
    expect(name.body.error?.details.fields).toEqual({ name: ["The Name field is required."] });
  });

  it("refuses to delete a key in use, with Coolify's reason", async () => {
    const t = setup();
    await t.call("POST", "", { name: "used", value: ED25519 });
    t.store.inUse.add(1);
    const uuid = t.store.rows[0]!.uuid;
    const r = await t.call("DELETE", uuid);
    expect(r.status).toBe(409);
    expect(r.body.error?.message).toBe("This private key is currently used by a server, application, or Git app and cannot be deleted.");
    t.store.inUse.clear();
    expect((await t.call("DELETE", uuid)).body.data).toEqual({ deleted: true });
    expect(t.store.rows).toHaveLength(0);
  });

  it("cleans up the unused keys only: 'Unused keys have been cleaned up.'", async () => {
    const t = setup();
    await t.call("POST", "", { name: "used", value: ED25519 });
    await t.call("POST", "", { name: "spare", value: ECDSA });
    t.store.inUse.add(1);
    const r = await t.call("POST", "cleanup");
    expect(r.body.data).toEqual({ deleted: 1, message: "Unused keys have been cleaned up." });
    expect(t.store.rows.map((k) => k.name)).toEqual(["used"]);
  });

  it("answers rotation and reveal with what is missing", async () => {
    const t = setup();
    await t.call("POST", "", { name: "key1", value: ED25519 });
    const uuid = t.store.rows[0]!.uuid;
    const rotate = await t.call("POST", `${uuid}/rotate`, { keyType: "ed25519" });
    expect(rotate.status).toBe(501);
    expect(rotate.body.error?.message).toBe("Key rotation needs the SSH executor, which is not available yet.");
    expect((await t.call("POST", `${uuid}/reveal`, { password: "x" })).status).toBe(501);
    expect((await t.call("POST", "nosuchkey/rotate")).status).toBe(404);
  });

  it("404s writes when policy denies deploy.resource.write, and reports canWrite false on reads", async () => {
    const t = setup({ write: false });
    const r = await t.call("POST", "generate", { type: "ed25519" });
    expect(r.status).toBe(404);
    expect(t.asked).toEqual(["deploy.resource.write"]);
    expect(t.orgs).toHaveLength(0);
    expect((await t.call("GET")).body.data).toEqual({ privateKeys: [], canWrite: false });
  });

  it("404s reads when policy denies deploy.resource.read", async () => {
    const t = setup({ read: false });
    expect((await t.call("GET")).status).toBe(404);
  });

  it("says which step denied outside prod, and nothing in prod", async () => {
    const t = setup({ read: false });
    const r = await t.call("GET");
    expect(r.body.error?.details).toEqual({ denied: "denied", memberships: 0 });
    t.env.ENVIRONMENT = "prod";
    expect((await t.call("GET")).body.error?.details).toEqual({});
    t.env.ENVIRONMENT = "stage";
    t.env.MEMBERSHIP_WORKER = fetcher(() => new Response("{}", { status: 500 }));
    expect((await t.call("GET")).body.error?.details).toEqual({ denied: "membership_status_500" });
  });

  it("405s a method a path does not take, 404s an unknown path", async () => {
    const t = setup();
    expect((await t.call("PUT")).status).toBe(405);
    expect((await t.call("GET", "generate")).status).toBe(405);
    expect((await t.call("DELETE", "abc/def/ghi")).status).toBe(404);
  });
});

describe("router: /deploy/private-keys", () => {
  const env: Env = { ENVIRONMENT: "test" };
  it("401s without an actor and 404s an org id that does not parse", async () => {
    expect((await route(new Request(BASE), env)).status).toBe(401);
    const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
    expect((await route(new Request("https://x/v1/organizations/nope/deploy/private-keys", { headers }), env)).status).toBe(404);
    expect((await route(new Request(`${BASE}/abc`, { headers }), env)).status).toBe(503);
    expect((await route(new Request(`${BASE}/abc/rotate/x`, { headers }), env)).status).toBe(404);
  });
});
