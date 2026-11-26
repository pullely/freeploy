// deploy.secret_manager_links (DP-106) against a real Postgres: a resource's secret manager source as the store functions
// of @saas/db/deploy keep it inside withOrg() — the org's secret manager tokens, one link per resource (updateOrCreate:
// the token and settings changed in place, updated_at untouched when neither changes), the link with its token's
// ciphertext, a removed link — and row-level security keeping each org's links and tokens to itself. The table is the
// deploy schema's (500_deploy_core, its unique resource index 660): DP-106 adds no migration.
import type { PGlite } from "@electric-sql/pglite";
import { withOrg, loadKek, orgDek, encryptField, decryptField, insertIntegrationToken, listSecretManagerTokens, findSecretManagerLink, saveSecretManagerLink, deleteSecretManagerLink } from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, executor, TEST_KEK as KEK } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const COLUMN = "integration_tokens.token";
const APP = "App\\Models\\Application";

let db: PGlite;
let ex: TransactionalSqlExecutor;
beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
}, 120_000);
afterAll(async () => db?.close());

let n = 0;
const uuidOf = (prefix: string) => `${prefix}${String(++n).padStart(24 - prefix.length, "0")}`;

async function addToken(org: string, provider: string, secret: string) {
  return withOrg(ex, org, async (tx) => {
    const dek = await orgDek(tx, org, await loadKek(KEK));
    return insertIntegrationToken(tx, { orgId: org, uuid: uuidOf("smt"), provider, name: provider, token: await encryptField(dek, COLUMN, secret), capabilities: JSON.stringify(provider === "cloudflare" ? ["dns"] : ["secrets"]), metadata: null });
  });
}

const save = (org: string, resourceId: number, tokenId: string | number, settings: string | null) =>
  withOrg(ex, org, (tx) => saveSecretManagerLink(tx, { orgId: org, uuid: uuidOf("sml"), resourceableType: APP, resourceableId: resourceId, integrationTokenId: tokenId, settings }));
const stamps = (org: string, resourceId: number) =>
  withOrg(ex, org, async (tx) => (await tx.execute<{ updated_at: unknown; settings: string | null }>("SELECT updated_at, settings::text AS settings FROM deploy.secret_manager_links WHERE resourceable_type = $1 AND resourceable_id = $2", [APP, resourceId])).rows);

describe("deploy.secret_manager_links", () => {
  it("lists the org's secret manager tokens only, with their ciphertext", async () => {
    const doppler = await addToken(A, "doppler", "dp.st.secret");
    await addToken(A, "cloudflare", "cf-secret");
    const tokens = await withOrg(ex, A, (tx) => listSecretManagerTokens(tx));
    expect(tokens.map((t) => t.provider)).not.toContain("cloudflare");
    const found = tokens.find((t) => t.uuid === doppler.uuid)!;
    expect(found.token).not.toContain("dp.st.secret");
    const plain = await withOrg(ex, A, async (tx) => decryptField(await orgDek(tx, A, await loadKek(KEK)), COLUMN, found.token));
    expect(plain).toBe("dp.st.secret");
  });

  it("keeps one link per resource: created, changed in place, untouched when nothing changes, removed", async () => {
    const vault = await addToken(A, "vault", "hvs.secret");
    const infisical = await addToken(A, "infisical", "inf-secret");
    expect(await save(A, 101, vault.id, '{"mount":"secret","path":"a"}')).toEqual({ created: true, changed: true });
    const link = await withOrg(ex, A, (tx) => findSecretManagerLink(tx, APP, 101));
    expect(link).toMatchObject({ token_uuid: vault.uuid, token_provider: "vault", settings: '{"mount":"secret","path":"a"}' });
    expect(link!.token_secret).not.toContain("hvs.secret");
    await withOrg(ex, A, (tx) => tx.execute("UPDATE deploy.secret_manager_links SET updated_at = '2025-12-30 00:00:00' WHERE resourceable_id = 101"));
    expect(await save(A, 101, vault.id, '{"mount": "secret", "path": "a"}')).toEqual({ created: false, changed: false });
    expect(String((await stamps(A, 101))[0]!.updated_at)).toContain("2025");
    expect(await save(A, 101, infisical.id, null)).toEqual({ created: false, changed: true });
    const rows = await stamps(A, 101);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.settings).toBeNull();
    expect((await withOrg(ex, A, (tx) => findSecretManagerLink(tx, APP, 101)))!.token_uuid).toBe(infisical.uuid);
    expect(await withOrg(ex, A, (tx) => deleteSecretManagerLink(tx, APP, 101))).toBe(1);
    expect(await withOrg(ex, A, (tx) => findSecretManagerLink(tx, APP, 101))).toBeNull();
  });

  it("keeps each org's links and tokens to itself (row-level security)", async () => {
    const theirs = await addToken(B, "doppler", "dp.st.theirs");
    await save(B, 202, theirs.id, null);
    expect((await withOrg(ex, A, (tx) => listSecretManagerTokens(tx))).map((t) => t.uuid)).not.toContain(theirs.uuid);
    expect(await withOrg(ex, A, (tx) => findSecretManagerLink(tx, APP, 202))).toBeNull();
    expect(await withOrg(ex, A, (tx) => deleteSecretManagerLink(tx, APP, 202))).toBe(0);
    await expect(withOrg(ex, A, (tx) => tx.execute(`INSERT INTO deploy.secret_manager_links (uuid, resourceable_type, resourceable_id, integration_token_id, org_id) VALUES ('x', $1, 9, 1, $2)`, [APP, B]))).rejects.toThrow();
    expect((await withOrg(ex, B, (tx) => findSecretManagerLink(tx, APP, 202)))!.token_uuid).toBe(theirs.uuid);
  });
});
