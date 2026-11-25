// deploy.cloud_provider_tokens and deploy.cloud_init_scripts (DP-45) against a
// real Postgres: the store functions of @saas/db/deploy inside withOrg(), the
// token and script columns encrypted with the org's data key, and row-level
// security keeping each org's rows to itself.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  loadKek,
  orgDek,
  encryptField,
  decryptField,
  isEncrypted,
  isEncryptedColumn,
  listCloudProviderTokens,
  findCloudProviderTokenByUuid,
  findCloudProviderTokenById,
  insertCloudProviderToken,
  updateCloudProviderToken,
  deleteCloudProviderToken,
  cloudProviderTokenServerCount,
  findServerCloud,
  setServerCloudProviderToken,
  listCloudInitScripts,
  findCloudInitScriptByUuid,
  insertCloudInitScript,
  updateCloudInitScript,
  deleteCloudInitScript,
} from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, executor, TEST_KEK as KEK } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const TOKEN_COLUMN = "cloud_provider_tokens.token";
const SCRIPT_COLUMN = "cloud_init_scripts.script";
const SCRIPT = "#cloud-config\npackages:\n  - htop\n";

let db: PGlite;
let ex: TransactionalSqlExecutor;
beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
}, 120_000);
afterAll(async () => db?.close());

async function addToken(org: string, uuid: string, provider: string, name: string, secret = "hc-secret") {
  return withOrg(ex, org, async (tx) => {
    const dek = await orgDek(tx, org, await loadKek(KEK));
    return insertCloudProviderToken(tx, { orgId: org, uuid, provider, token: await encryptField(dek, TOKEN_COLUMN, secret), name, description: null });
  });
}

async function addScript(org: string, uuid: string, name: string) {
  return withOrg(ex, org, async (tx) => {
    const dek = await orgDek(tx, org, await loadKek(KEK));
    return insertCloudInitScript(tx, { orgId: org, uuid, name, script: await encryptField(dek, SCRIPT_COLUMN, SCRIPT) });
  });
}

describe("deploy.cloud_provider_tokens", () => {
  it("is one of Coolify's encrypted columns, as the script is", () => {
    expect(isEncryptedColumn("cloud_provider_tokens", "token")).toBe(true);
    expect(isEncryptedColumn("cloud_init_scripts", "script")).toBe(true);
  });

  it("round-trips a token: stored as a ciphertext of the org, never part of the returned row", async () => {
    const row = await addToken(A, "ctaaaaaaaaaaaaaaaaaaaaaa", "hetzner", "alpha");
    expect(row).toMatchObject({ uuid: "ctaaaaaaaaaaaaaaaaaaaaaa", provider: "hetzner", name: "alpha", description: null });
    expect(row.created_at).not.toBeNull();
    expect(row).not.toHaveProperty("token");
    const found = (await withOrg(ex, A, (tx) => findCloudProviderTokenByUuid(tx, "ctaaaaaaaaaaaaaaaaaaaaaa")))!;
    expect(isEncrypted(found.token)).toBe(true);
    expect(found.token).not.toContain("hc-secret");
    expect(await withOrg(ex, A, async (tx) => decryptField(await orgDek(tx, A, await loadKek(KEK)), TOKEN_COLUMN, found.token))).toBe("hc-secret");
    // B's data key does not open A's value, and the value is bound to its column.
    await expect(withOrg(ex, B, async (tx) => decryptField(await orgDek(tx, B, await loadKek(KEK)), TOKEN_COLUMN, found.token))).rejects.toThrow();
    await expect(withOrg(ex, A, async (tx) => decryptField(await orgDek(tx, A, await loadKek(KEK)), SCRIPT_COLUMN, found.token))).rejects.toThrow();
    expect((await withOrg(ex, A, (tx) => findCloudProviderTokenById(tx, found.id)))!.uuid).toBe("ctaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("keeps each org's tokens to itself (row-level security)", async () => {
    await addToken(B, "ctbbbbbbbbbbbbbbbbbbbbbb", "hetzner", "beta");
    expect((await withOrg(ex, A, (tx) => listCloudProviderTokens(tx))).map((t) => t.name)).toEqual(["alpha"]);
    expect((await withOrg(ex, B, (tx) => listCloudProviderTokens(tx))).map((t) => t.name)).toEqual(["beta"]);
    expect(await withOrg(ex, B, (tx) => findCloudProviderTokenByUuid(tx, "ctaaaaaaaaaaaaaaaaaaaaaa"))).toBeNull();
    const aId = (await withOrg(ex, A, (tx) => findCloudProviderTokenByUuid(tx, "ctaaaaaaaaaaaaaaaaaaaaaa")))!.id;
    expect(await withOrg(ex, B, (tx) => findCloudProviderTokenById(tx, aId))).toBeNull();
    expect(await withOrg(ex, B, (tx) => deleteCloudProviderToken(tx, aId))).toBe(false);
    expect(await withOrg(ex, B, (tx) => updateCloudProviderToken(tx, aId, { name: "stolen", description: null }))).toBeNull();
    await expect(
      withOrg(ex, B, (tx) => insertCloudProviderToken(tx, { orgId: A, uuid: "ctxxxxxxxxxxxxxxxxxxxxxx", provider: "hetzner", token: "x", name: "x", description: null })),
    ).rejects.toThrow(/row-level security/);
  });

  it("lists the tokens of one provider (forProvider)", async () => {
    await addToken(A, "ctdddddddddddddddddddddd", "digitalocean", "ocean");
    expect((await withOrg(ex, A, (tx) => listCloudProviderTokens(tx))).map((t) => t.name)).toEqual(["alpha", "ocean"]);
    expect((await withOrg(ex, A, (tx) => listCloudProviderTokens(tx, "digitalocean"))).map((t) => t.name)).toEqual(["ocean"]);
    expect(await withOrg(ex, A, (tx) => listCloudProviderTokens(tx, "vultr"))).toEqual([]);
  });

  it("renames a token and changes its description, nothing else", async () => {
    const a = (await withOrg(ex, A, (tx) => findCloudProviderTokenByUuid(tx, "ctaaaaaaaaaaaaaaaaaaaaaa")))!;
    const renamed = await withOrg(ex, A, (tx) => updateCloudProviderToken(tx, a.id, { name: "alpha 2", description: "production" }));
    expect(renamed).toMatchObject({ name: "alpha 2", description: "production", provider: "hetzner" });
    const after = (await withOrg(ex, A, (tx) => findCloudProviderTokenByUuid(tx, "ctaaaaaaaaaaaaaaaaaaaaaa")))!;
    expect(after.token).toBe(a.token);
  });

  it("counts the servers that use a token, and sets a server's token", async () => {
    const a = (await withOrg(ex, A, (tx) => findCloudProviderTokenByUuid(tx, "ctaaaaaaaaaaaaaaaaaaaaaa")))!;
    expect(await withOrg(ex, A, (tx) => cloudProviderTokenServerCount(tx, a.id))).toBe(0);
    await withOrg(ex, A, async (tx) => {
      await tx.execute(`INSERT INTO deploy.private_keys (id, uuid, name, private_key, org_id) VALUES (700, 'pk700', 'k', 'x', $1)`, [A]);
      await tx.execute(
        `INSERT INTO deploy.servers (uuid, name, ip, private_key_id, proxy, hetzner_server_id, org_id) VALUES ('srvcloud', 'cloud-1', '10.0.0.9', 700, '{}', 4242, $1)`,
        [A],
      );
      await tx.execute(`INSERT INTO deploy.servers (uuid, name, ip, private_key_id, proxy, deleted_at, org_id) VALUES ('srvgone', 'gone', '10.0.0.8', 700, '{}', now(), $1)`, [A]);
    });
    const server = (await withOrg(ex, A, (tx) => findServerCloud(tx, "srvcloud")))!;
    expect(server).toMatchObject({ uuid: "srvcloud", name: "cloud-1", vultr_instance_id: null, hostinger_virtual_machine_id: null, cloud_provider_token_id: null });
    expect(Number(server.hetzner_server_id)).toBe(4242);
    // A trashed server is no server (SoftDeletes); another org's is not found.
    expect(await withOrg(ex, A, (tx) => findServerCloud(tx, "srvgone"))).toBeNull();
    expect(await withOrg(ex, B, (tx) => findServerCloud(tx, "srvcloud"))).toBeNull();
    expect(await withOrg(ex, B, (tx) => setServerCloudProviderToken(tx, server.id, a.id))).toBe(false);
    expect(await withOrg(ex, A, (tx) => setServerCloudProviderToken(tx, server.id, a.id))).toBe(true);
    expect(Number((await withOrg(ex, A, (tx) => findServerCloud(tx, "srvcloud")))!.cloud_provider_token_id)).toBe(Number(a.id));
    expect(await withOrg(ex, A, (tx) => cloudProviderTokenServerCount(tx, a.id))).toBe(1);
    await withOrg(ex, A, (tx) => tx.execute(`UPDATE deploy.servers SET cloud_provider_token_id = $1 WHERE uuid = 'srvgone'`, [a.id]));
    expect(await withOrg(ex, A, (tx) => cloudProviderTokenServerCount(tx, a.id))).toBe(1);
  });

  it("deletes a token of the org", async () => {
    const id = (await addToken(A, "ctcccccccccccccccccccccc", "vultr", "spare")).id;
    expect(await withOrg(ex, A, (tx) => deleteCloudProviderToken(tx, id))).toBe(true);
    expect(await withOrg(ex, A, (tx) => findCloudProviderTokenByUuid(tx, "ctcccccccccccccccccccccc"))).toBeNull();
    expect(await withOrg(ex, A, (tx) => deleteCloudProviderToken(tx, id))).toBe(false);
  });
});

describe("deploy.cloud_init_scripts", () => {
  it("round-trips a script: stored as a ciphertext of the org, never part of the returned row", async () => {
    const row = await addScript(A, "ciaaaaaaaaaaaaaaaaaaaaaa", "base");
    expect(row).toMatchObject({ uuid: "ciaaaaaaaaaaaaaaaaaaaaaa", name: "base" });
    expect(row).not.toHaveProperty("script");
    const found = (await withOrg(ex, A, (tx) => findCloudInitScriptByUuid(tx, "ciaaaaaaaaaaaaaaaaaaaaaa")))!;
    expect(isEncrypted(found.script)).toBe(true);
    expect(found.script).not.toContain("htop");
    expect(await withOrg(ex, A, async (tx) => decryptField(await orgDek(tx, A, await loadKek(KEK)), SCRIPT_COLUMN, found.script))).toBe(SCRIPT);
    await expect(withOrg(ex, B, async (tx) => decryptField(await orgDek(tx, B, await loadKek(KEK)), SCRIPT_COLUMN, found.script))).rejects.toThrow();
  });

  it("lists the newest first, and keeps each org's scripts to itself", async () => {
    await addScript(A, "cibbbbbbbbbbbbbbbbbbbbbb", "second");
    await addScript(B, "cizzzzzzzzzzzzzzzzzzzzzz", "other org");
    const first = (await withOrg(ex, A, (tx) => findCloudInitScriptByUuid(tx, "ciaaaaaaaaaaaaaaaaaaaaaa")))!;
    await withOrg(ex, A, (tx) => tx.execute(`UPDATE deploy.cloud_init_scripts SET created_at = created_at - interval '1 hour' WHERE id = $1`, [first.id]));
    expect((await withOrg(ex, A, listCloudInitScripts)).map((s) => s.name)).toEqual(["second", "base"]);
    expect((await withOrg(ex, B, listCloudInitScripts)).map((s) => s.name)).toEqual(["other org"]);
    expect(await withOrg(ex, B, (tx) => findCloudInitScriptByUuid(tx, "ciaaaaaaaaaaaaaaaaaaaaaa"))).toBeNull();
    expect(await withOrg(ex, B, (tx) => deleteCloudInitScript(tx, first.id))).toBe(false);
    expect(await withOrg(ex, B, (tx) => updateCloudInitScript(tx, first.id, { name: "stolen", script: "x" }))).toBeNull();
    await expect(withOrg(ex, B, (tx) => insertCloudInitScript(tx, { orgId: A, uuid: "cixxxxxxxxxxxxxxxxxxxxxx", name: "x", script: "x" }))).rejects.toThrow(/row-level security/);
  });

  it("updates the name and the script, and deletes a script", async () => {
    const a = (await withOrg(ex, A, (tx) => findCloudInitScriptByUuid(tx, "ciaaaaaaaaaaaaaaaaaaaaaa")))!;
    const updated = await withOrg(ex, A, (tx) => updateCloudInitScript(tx, a.id, { name: "base 2", script: "fp1:new" }));
    expect(updated).toMatchObject({ name: "base 2" });
    expect((await withOrg(ex, A, (tx) => findCloudInitScriptByUuid(tx, "ciaaaaaaaaaaaaaaaaaaaaaa")))!.script).toBe("fp1:new");
    expect(await withOrg(ex, A, (tx) => deleteCloudInitScript(tx, a.id))).toBe(true);
    expect(await withOrg(ex, A, (tx) => findCloudInitScriptByUuid(tx, "ciaaaaaaaaaaaaaaaaaaaaaa"))).toBeNull();
    expect(await withOrg(ex, A, (tx) => deleteCloudInitScript(tx, a.id))).toBe(false);
  });
});
