// deploy.integration_tokens and deploy.dns_provider_zones (DP-104) against a real Postgres: the store functions of
// @saas/db/deploy inside withOrg(), the token column encrypted with the org's data key, the zones of a Cloudflare token
// synchronized as CloudflareDnsProvider::syncZones() does, deletionBlocker()'s two questions, and row-level security
// keeping each org's rows to itself. The tables are the deploy schema's (500_deploy_core, 660_deploy_schema_catch_up):
// DP-104 adds no migration.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  loadKek,
  orgDek,
  encryptField,
  decryptField,
  isEncrypted,
  isEncryptedColumn,
  listIntegrationTokens,
  findIntegrationTokenByUuid,
  insertIntegrationToken,
  updateIntegrationToken,
  deleteIntegrationToken,
  integrationTokenUsage,
  listIntegrationTokenZones,
  syncIntegrationTokenZones,
} from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, executor, TEST_KEK as KEK } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const COLUMN = "integration_tokens.token";

let db: PGlite;
let ex: TransactionalSqlExecutor;
beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
}, 120_000);
afterAll(async () => db?.close());

let n = 0;
const uuidOf = (prefix: string) => `${prefix}${String(++n).padStart(24 - prefix.length, "0")}`;

async function addToken(org: string, uuid: string, provider: string, name: string, secret = "cf-secret", metadata: string | null = null) {
  return withOrg(ex, org, async (tx) => {
    const dek = await orgDek(tx, org, await loadKek(KEK));
    return insertIntegrationToken(tx, { orgId: org, uuid, provider, name, token: await encryptField(dek, COLUMN, secret), capabilities: JSON.stringify(provider === "cloudflare" ? ["dns"] : ["secrets"]), metadata });
  });
}

describe("deploy.integration_tokens", () => {
  it("is one of Coolify's encrypted columns", () => {
    expect(isEncryptedColumn("integration_tokens", "token")).toBe(true);
  });

  it("round-trips a token: stored as a ciphertext of the org, never part of a list row; the JSON columns as their text", async () => {
    const uuid = uuidOf("ita");
    const row = await addToken(A, uuid, "infisical", "secrets", "client-secret", JSON.stringify({ base_url: "https://app.infisical.com", client_id: "c", timeout: 15 }));
    expect(row).toMatchObject({ uuid, provider: "infisical", name: "secrets", capabilities: '["secrets"]', metadata: '{"base_url":"https://app.infisical.com","client_id":"c","timeout":15}' });
    expect(Number(row.dns_zones_count)).toBe(0);
    expect(row).not.toHaveProperty("token");
    expect((await withOrg(ex, A, (tx) => listIntegrationTokens(tx))).every((r) => !("token" in r))).toBe(true);
    const found = (await withOrg(ex, A, (tx) => findIntegrationTokenByUuid(tx, uuid)))!;
    expect(isEncrypted(found.token)).toBe(true);
    expect(found.token).not.toContain("client-secret");
    expect(await withOrg(ex, A, async (tx) => decryptField(await orgDek(tx, A, await loadKek(KEK)), COLUMN, found.token))).toBe("client-secret");
    await expect(withOrg(ex, B, async (tx) => decryptField(await orgDek(tx, B, await loadKek(KEK)), COLUMN, found.token))).rejects.toThrow();
  });

  it("lists the latest first, and writes only what an update gives (updated_at untouched when nothing is)", async () => {
    const first = uuidOf("itb");
    const second = uuidOf("itb");
    await addToken(A, first, "doppler", "first");
    await db.exec(`UPDATE deploy.integration_tokens SET created_at = '2025-01-01 00:00:00', updated_at = '2025-01-01 00:00:00' WHERE uuid = '${first}'`);
    await addToken(A, second, "doppler", "second");
    const uuids = (await withOrg(ex, A, (tx) => listIntegrationTokens(tx))).map((r) => r.uuid);
    expect(uuids.indexOf(second)).toBeLessThan(uuids.indexOf(first));
    const id = (await withOrg(ex, A, (tx) => findIntegrationTokenByUuid(tx, first)))!.id;
    await withOrg(ex, A, (tx) => updateIntegrationToken(tx, id, {}));
    expect(String((await withOrg(ex, A, (tx) => findIntegrationTokenByUuid(tx, first)))!.updated_at)).toContain("2025");
    await withOrg(ex, A, (tx) => updateIntegrationToken(tx, id, { name: "renamed", capabilities: '["secrets"]', metadata: null }));
    const after = (await withOrg(ex, A, (tx) => findIntegrationTokenByUuid(tx, first)))!;
    expect(after.name).toBe("renamed");
    expect(String(after.updated_at)).not.toContain("2025");
  });

  it("synchronizes a Cloudflare token's zones: updates by provider id, adds, drops the others unless a managed record uses them", async () => {
    const uuid = uuidOf("itc");
    const token = await addToken(A, uuid, "cloudflare", "dns", "cf", JSON.stringify({ automatic_dns: false }));
    const zones = [
      { providerZoneId: "z-com", name: "example.com", accountId: "acc", accountName: "Account" },
      { providerZoneId: "z-org", name: "example.org", accountId: "acc", accountName: null },
      { providerZoneId: "z-net", name: "example.net", accountId: null, accountName: null },
    ];
    let k = 0;
    const newUuid = () => `zone${String(++k)}`.padEnd(24, "x");
    await withOrg(ex, A, (tx) => syncIntegrationTokenZones(tx, A, token.id, zones, newUuid, JSON.stringify({ automatic_dns: false, zones_synced_at: "2026-01-01T00:00:00+00:00" })));
    expect((await withOrg(ex, A, (tx) => listIntegrationTokenZones(tx, token.id))).map((z) => [z.name, z.account_name])).toEqual([
      ["example.com", "Account"],
      ["example.net", null],
      ["example.org", null],
    ]);
    const org = (await withOrg(ex, A, (tx) => listIntegrationTokenZones(tx, token.id))).find((z) => z.name === "example.org")!;
    await withOrg(ex, A, (tx) => tx.execute(`INSERT INTO deploy.managed_dns_records (uuid, integration_token_id, dns_provider_zone_id, provider_record_id, type, name, content, owned, org_id) VALUES ('rec-${uuid}', $1, $2, 'r', 'A', 'a.example.org', '203.0.113.1', true, $3)`, [token.id, org.id, A]));
    await withOrg(ex, A, (tx) => syncIntegrationTokenZones(tx, A, token.id, [{ providerZoneId: "z-com", name: "example.com", accountId: "acc", accountName: "Renamed" }], newUuid, JSON.stringify({ zones_synced_at: "2026-01-02T00:00:00+00:00" })));
    const left = await withOrg(ex, A, (tx) => listIntegrationTokenZones(tx, token.id));
    expect(left.map((z) => [z.name, z.account_name, Number(z.managed_records_count)])).toEqual([
      ["example.com", "Renamed", 0],
      ["example.org", null, 1],
    ]);
    const found = (await withOrg(ex, A, (tx) => findIntegrationTokenByUuid(tx, uuid)))!;
    expect(JSON.parse(found.metadata!)).toEqual({ zones_synced_at: "2026-01-02T00:00:00+00:00" });
    expect(Number(found.dns_zones_count)).toBe(2);
    expect(await withOrg(ex, A, (tx) => integrationTokenUsage(tx, token.id))).toEqual({ secretManagerLinks: false, managedDnsRecords: true });
  });

  it("answers deletionBlocker()'s questions, and deletes a token with its zones", async () => {
    const uuid = uuidOf("itd");
    const token = await addToken(A, uuid, "cloudflare", "gone");
    await withOrg(ex, A, (tx) => syncIntegrationTokenZones(tx, A, token.id, [{ providerZoneId: "z", name: "gone.example", accountId: null, accountName: null }], () => uuidOf("zd"), "{}"));
    await withOrg(ex, A, (tx) => tx.execute(`INSERT INTO deploy.secret_manager_links (uuid, resourceable_type, resourceable_id, integration_token_id, org_id) VALUES ($1, 'App\\Models\\Application', 1, $2, $3)`, [uuidOf("sml"), token.id, A]));
    expect(await withOrg(ex, A, (tx) => integrationTokenUsage(tx, token.id))).toEqual({ secretManagerLinks: true, managedDnsRecords: false });
    expect(await withOrg(ex, A, (tx) => deleteIntegrationToken(tx, token.id))).toBe(true);
    expect(await withOrg(ex, A, (tx) => findIntegrationTokenByUuid(tx, uuid))).toBeNull();
    expect(await withOrg(ex, A, (tx) => listIntegrationTokenZones(tx, token.id))).toEqual([]);
  });

  it("keeps each org's tokens and zones to itself (row-level security)", async () => {
    const mine = uuidOf("ite");
    const theirs = uuidOf("itf");
    const a = await addToken(A, mine, "cloudflare", "mine");
    const b = await addToken(B, theirs, "cloudflare", "theirs");
    await withOrg(ex, B, (tx) => syncIntegrationTokenZones(tx, B, b.id, [{ providerZoneId: "zb", name: "b.example", accountId: null, accountName: null }], () => uuidOf("zb"), "{}"));
    expect((await withOrg(ex, A, (tx) => listIntegrationTokens(tx))).map((r) => r.uuid)).not.toContain(theirs);
    expect(await withOrg(ex, A, (tx) => findIntegrationTokenByUuid(tx, theirs))).toBeNull();
    expect(await withOrg(ex, A, (tx) => listIntegrationTokenZones(tx, b.id))).toEqual([]);
    // Another org's token can be neither changed nor deleted, nor given zones.
    expect(await withOrg(ex, A, (tx) => updateIntegrationToken(tx, b.id, { name: "hijacked" }))).toBe(false);
    expect(await withOrg(ex, A, (tx) => deleteIntegrationToken(tx, b.id))).toBe(false);
    await expect(withOrg(ex, A, (tx) => tx.execute(`INSERT INTO deploy.integration_tokens (uuid, provider, name, token, capabilities, org_id) VALUES ('x', 'doppler', 'x', 'x', '[]', $1)`, [B]))).rejects.toThrow();
    expect((await withOrg(ex, B, (tx) => findIntegrationTokenByUuid(tx, theirs)))!.name).toBe("theirs");
    expect((await withOrg(ex, B, (tx) => listIntegrationTokenZones(tx, b.id))).map((z) => z.name)).toEqual(["b.example"]);
    expect((await withOrg(ex, A, (tx) => findIntegrationTokenByUuid(tx, mine)))!.uuid).toBe(a.uuid);
  });
});
