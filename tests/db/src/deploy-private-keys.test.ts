// deploy.private_keys (DP-36) against a real Postgres: the store functions of
// @saas/db/deploy inside withOrg(), the private_key column encrypted with the
// org's data key, and row-level security keeping each org's keys to itself.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  loadKek,
  orgDek,
  encryptField,
  decryptField,
  isEncrypted,
  listPrivateKeys,
  findPrivateKeyByUuid,
  insertPrivateKey,
  updatePrivateKey,
  deletePrivateKey,
  privateKeyFingerprintExists,
  privateKeyIsInUse,
  privateKeyUsages,
} from "@saas/db/deploy";
import type { SqlExecutor, TransactionalSqlExecutor } from "@saas/db/hyperdrive";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SQL = ["500_deploy_core", "510_deploy_org_keys", "520_deploy_schema_fold_fixes"].map((m) => readFileSync(resolve(root, `packages/db/src/migrations/${m}/up.sql`), "utf8")).join("\n");
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const KEK = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const COLUMN = "private_keys.private_key";
const PEM = "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n";

if (!globalThis.crypto) (globalThis as { crypto: unknown }).crypto = webcrypto;

function executor(db: PGlite): TransactionalSqlExecutor {
  const wrap = (q: { query: PGlite["query"] }): SqlExecutor => ({
    async execute(text, params) {
      const r = await q.query(text, params ?? []);
      return { rows: r.rows as never[], rowCount: r.rows.length };
    },
  });
  return { ...wrap(db), transaction: (fn) => db.transaction((tx) => fn(wrap(tx as never))) };
}

let db: PGlite;
let ex: TransactionalSqlExecutor;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(SQL);
  ex = executor(db);
}, 120_000);
afterAll(async () => db?.close());

async function addKey(org: string, uuid: string, name: string, fingerprint: string) {
  return withOrg(ex, org, async (tx) => {
    const dek = await orgDek(tx, org, await loadKek(KEK));
    return insertPrivateKey(tx, { orgId: org, uuid, name, description: null, privateKey: await encryptField(dek, COLUMN, PEM), fingerprint });
  });
}

describe("deploy.private_keys", () => {
  it("round-trips a key: stored as a ciphertext of the org, decrypted with its data key", async () => {
    const row = await addKey(A, "pkaaaaaaaaaaaaaaaaaaaaaa", "alpha", "fpA");
    expect(row).toMatchObject({ uuid: "pkaaaaaaaaaaaaaaaaaaaaaa", name: "alpha", description: null, is_git_related: false, fingerprint: "fpA" });
    expect(row.created_at).not.toBeNull();
    expect(row).not.toHaveProperty("private_key");
    const found = await withOrg(ex, A, (tx) => findPrivateKeyByUuid(tx, "pkaaaaaaaaaaaaaaaaaaaaaa"));
    expect(isEncrypted(found!.private_key)).toBe(true);
    expect(found!.private_key).not.toContain("PRIVATE KEY");
    const plain = await withOrg(ex, A, async (tx) => decryptField(await orgDek(tx, A, await loadKek(KEK)), COLUMN, found!.private_key));
    expect(plain).toBe(PEM);
    // B's data key does not open A's value.
    await expect(withOrg(ex, B, async (tx) => decryptField(await orgDek(tx, B, await loadKek(KEK)), COLUMN, found!.private_key))).rejects.toThrow();
  });

  it("keeps each org's keys to itself (row-level security)", async () => {
    await addKey(B, "pkbbbbbbbbbbbbbbbbbbbbbb", "beta", "fpA");
    expect((await withOrg(ex, A, listPrivateKeys)).map((k) => k.name)).toEqual(["alpha"]);
    expect((await withOrg(ex, B, listPrivateKeys)).map((k) => k.name)).toEqual(["beta"]);
    expect(await withOrg(ex, B, (tx) => findPrivateKeyByUuid(tx, "pkaaaaaaaaaaaaaaaaaaaaaa"))).toBeNull();
    const aId = (await withOrg(ex, A, (tx) => findPrivateKeyByUuid(tx, "pkaaaaaaaaaaaaaaaaaaaaaa")))!.id;
    expect(await withOrg(ex, B, (tx) => deletePrivateKey(tx, aId))).toBe(false);
    expect(await withOrg(ex, B, (tx) => updatePrivateKey(tx, aId, { name: "stolen", description: null, isGitRelated: false }))).toBeNull();
    await expect(
      withOrg(ex, B, (tx) => insertPrivateKey(tx, { orgId: A, uuid: "pkxxxxxxxxxxxxxxxxxxxxxx", name: "x", description: null, privateKey: "x", fingerprint: null })),
    ).rejects.toThrow(/row-level security/);
  });

  it("checks fingerprints within the org only (fingerprintExists per team)", async () => {
    // B holds a key with A's fingerprint; it does not count for A, and A's own key is excluded by id.
    const a = (await withOrg(ex, A, (tx) => findPrivateKeyByUuid(tx, "pkaaaaaaaaaaaaaaaaaaaaaa")))!;
    expect(await withOrg(ex, A, (tx) => privateKeyFingerprintExists(tx, "fpA"))).toBe(true);
    expect(await withOrg(ex, A, (tx) => privateKeyFingerprintExists(tx, "fpA", a.id))).toBe(false);
    expect(await withOrg(ex, A, (tx) => privateKeyFingerprintExists(tx, "fpZ"))).toBe(false);
    expect(await withOrg(ex, A, (tx) => privateKeyFingerprintExists(tx, null))).toBe(false);
  });

  it("knows a key in use and lists where (isInUse, Show's usages)", async () => {
    const a = (await withOrg(ex, A, (tx) => findPrivateKeyByUuid(tx, "pkaaaaaaaaaaaaaaaaaaaaaa")))!;
    expect(await withOrg(ex, A, (tx) => privateKeyIsInUse(tx, a.id))).toBe(false);
    await withOrg(ex, A, async (tx) => {
      await tx.execute(`INSERT INTO deploy.servers (uuid, name, ip, private_key_id, proxy, org_id) VALUES ('srv1', 'prod-1', '10.0.0.1', $1, '{}', $2)`, [a.id, A]);
      await tx.execute(`INSERT INTO deploy.projects (id, uuid, name, org_id) VALUES (900, 'prj1', 'p', $1)`, [A]);
      await tx.execute(`INSERT INTO deploy.environments (id, uuid, name, project_id, org_id) VALUES (900, 'env1', 'production', 900, $1)`, [A]);
      await tx.execute(
        `INSERT INTO deploy.applications (uuid, name, git_repository, git_branch, build_pack, environment_id, private_key_id, org_id) VALUES ('app1', 'web', 'r', 'main', 'nixpacks', 900, $1, $2)`,
        [a.id, A],
      );
    });
    expect(await withOrg(ex, A, (tx) => privateKeyIsInUse(tx, a.id))).toBe(true);
    expect((await withOrg(ex, A, listPrivateKeys)).map((k) => [k.name, k.in_use])).toEqual([["alpha", true]]);
    expect((await withOrg(ex, B, listPrivateKeys)).map((k) => [k.name, k.in_use])).toEqual([["beta", false]]);
    const usages = await withOrg(ex, A, (tx) => privateKeyUsages(tx, a.id));
    expect(usages).toEqual({
      counts: { Server: 1, Application: 1 },
      matches: 2,
      rows: [
        { type: "Server", name: "prod-1", url: "/server/srv1" },
        { type: "Application", name: "web", url: "/project/prj1/environment/env1/application/app1" },
      ],
    });
    const searched = await withOrg(ex, A, (tx) => privateKeyUsages(tx, a.id, "PROD"));
    expect(searched).toEqual({ counts: { Server: 1, Application: 1 }, matches: 1, rows: [{ type: "Server", name: "prod-1", url: "/server/srv1" }] });
    // "%" is a literal in the search, as Coolify escapes it.
    expect((await withOrg(ex, A, (tx) => privateKeyUsages(tx, a.id, "%"))).matches).toBe(0);
  });

  it("updates names, and the key with its fingerprint only when given", async () => {
    const a = (await withOrg(ex, A, (tx) => findPrivateKeyByUuid(tx, "pkaaaaaaaaaaaaaaaaaaaaaa")))!;
    const renamed = await withOrg(ex, A, (tx) => updatePrivateKey(tx, a.id, { name: "alpha 2", description: "d", isGitRelated: false }));
    expect(renamed).toMatchObject({ name: "alpha 2", description: "d", fingerprint: "fpA" });
    await withOrg(ex, A, (tx) => updatePrivateKey(tx, a.id, { name: "alpha 2", description: null, isGitRelated: true, privateKey: { ciphertext: "fp1:new", fingerprint: "fpN" } }));
    const after = (await withOrg(ex, A, (tx) => findPrivateKeyByUuid(tx, "pkaaaaaaaaaaaaaaaaaaaaaa")))!;
    expect(after).toMatchObject({ private_key: "fp1:new", fingerprint: "fpN", is_git_related: true, description: null });
  });

  it("deletes a key of the org", async () => {
    const id = (await addKey(A, "pkcccccccccccccccccccccc", "spare", "fpC")).id;
    expect(await withOrg(ex, A, (tx) => deletePrivateKey(tx, id))).toBe(true);
    expect(await withOrg(ex, A, (tx) => findPrivateKeyByUuid(tx, "pkcccccccccccccccccccccc"))).toBeNull();
  });
});
