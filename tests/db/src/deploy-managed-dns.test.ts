// deploy.managed_dns_records and deploy.managed_dns_record_references (DP-105) against a real Postgres: the store
// functions of @saas/db/deploy inside withOrg() — the Cloudflare zones with their token, a record inserted, tracked by its
// provider id, updated only where it differs, referenced once per resource, its references released, deleted with them —
// and row-level security keeping each org's records, references and zones to itself. The tables are the deploy schema's
// (500_deploy_core, 660_deploy_schema_catch_up): DP-105 adds no migration.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  insertIntegrationToken,
  syncIntegrationTokenZones,
  listCloudflareZones,
  insertManagedDnsRecord,
  updateManagedDnsRecord,
  findManagedDnsRecordByProviderId,
  listManagedDnsRecords,
  addManagedDnsReference,
  listManagedDnsReferences,
  deleteManagedDnsReferences,
  deleteManagedDnsRecord,
  managedDnsRecordsReferencing,
  managedDnsRecordProvider,
  dnsReferenceIsLive,
  dnsHostnameCandidates,
  DNS_RESOURCE_MORPH_CLASS,
} from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, executor } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const APP = DNS_RESOURCE_MORPH_CLASS.application;

let db: PGlite;
let ex: TransactionalSqlExecutor;
beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
}, 120_000);
afterAll(async () => db?.close());

let n = 0;
const uuidOf = (prefix: string) => `${prefix}${String(++n).padStart(24 - prefix.length, "0")}`;

/** A Cloudflare (or other) token of the org with one zone; the zone's id. */
async function zoneOf(org: string, name: string, provider = "cloudflare") {
  return withOrg(ex, org, async (tx) => {
    const token = await insertIntegrationToken(tx, { orgId: org, uuid: uuidOf("tok"), provider, name: `${name} token`, token: "fp1:not-decrypted-here", capabilities: '["dns"]', metadata: '{"proxied_dns":true}' });
    await syncIntegrationTokenZones(tx, org, token.id, [{ providerZoneId: `zone-${name}`, name, accountId: "acc", accountName: null }], () => uuidOf("zon"), '{"proxied_dns":true}');
    const r = await tx.execute<{ id: string }>("SELECT id FROM deploy.dns_provider_zones WHERE integration_token_id = $1", [token.id]);
    return { tokenId: token.id, tokenUuid: token.uuid, zoneId: r.rows[0]!.id };
  });
}

describe("deploy.managed_dns_records", () => {
  it("lists the org's Cloudflare zones with their token and records, by id or by name", async () => {
    const org = await zoneOf(A, "zeta.example");
    const alpha = await zoneOf(A, "alpha.example");
    await zoneOf(A, "secrets.example", "doppler");
    await withOrg(ex, A, (tx) => insertManagedDnsRecord(tx, A, uuidOf("rec"), { integrationTokenId: alpha.tokenId, zoneId: alpha.zoneId, providerRecordId: "r-1", type: "A", name: "app.alpha.example", content: "203.0.113.10", owned: true }));
    const byId = await withOrg(ex, A, (tx) => listCloudflareZones(tx));
    expect(byId.map((z) => z.name)).toEqual(["zeta.example", "alpha.example"]);
    const byName = await withOrg(ex, A, (tx) => listCloudflareZones(tx, true));
    expect(byName.map((z) => [z.name, Number(z.managed_records_count), z.token_metadata])).toEqual([["alpha.example", 1, '{"proxied_dns":true}'], ["zeta.example", 0, '{"proxied_dns":true}']]);
    expect(byName[1]).toMatchObject({ token_uuid: org.tokenUuid, provider_zone_id: "zone-zeta.example", token_secret: "fp1:not-decrypted-here" });
    expect(await withOrg(ex, B, (tx) => listCloudflareZones(tx))).toEqual([]);
  });

  it("tracks a record by its provider id, updates what differs, references each resource once, and deletes it with its references", async () => {
    const z = await zoneOf(A, "beta.example");
    const uuid = uuidOf("rec");
    const out = await withOrg(ex, A, async (tx) => {
      const row = await insertManagedDnsRecord(tx, A, uuid, { integrationTokenId: z.tokenId, zoneId: z.zoneId, providerRecordId: "r-2", type: "A", name: "web.beta.example", content: "203.0.113.10", owned: false });
      expect(row).toMatchObject({ uuid, provider_record_id: "r-2", owned: false, token_uuid: z.tokenUuid });
      expect((await findManagedDnsRecordByProviderId(tx, z.zoneId, "r-2"))?.uuid).toBe(uuid);
      expect(await findManagedDnsRecordByProviderId(tx, z.zoneId, "r-x")).toBeNull();
      const updated = await updateManagedDnsRecord(tx, row.id, { integrationTokenId: z.tokenId, type: "AAAA", name: "web.beta.example", content: "2606:4700::1", owned: true });
      expect(updated).toMatchObject({ type: "AAAA", content: "2606:4700::1", owned: true });
      await addManagedDnsReference(tx, A, row.id, [APP, 1]);
      await addManagedDnsReference(tx, A, row.id, [APP, 1]);
      await addManagedDnsReference(tx, A, row.id, [DNS_RESOURCE_MORPH_CLASS.serviceApplication, 1]);
      const refs = (await listManagedDnsReferences(tx, row.id)).map((f) => [f.resource_type, Number(f.resource_id)]);
      const referencing = (await managedDnsRecordsReferencing(tx, "web.beta.example", [APP, 1])).map((r) => r.uuid);
      const provider = await managedDnsRecordProvider(tx, row.id);
      await deleteManagedDnsReferences(tx, row.id, [[APP, 1]]);
      const afterRelease = (await listManagedDnsReferences(tx, row.id)).length;
      await deleteManagedDnsRecord(tx, row.id);
      const left = await tx.execute("SELECT 1 FROM deploy.managed_dns_record_references WHERE managed_dns_record_id = $1", [row.id]);
      return { refs, referencing, provider, afterRelease, left: left.rows.length, listed: await listManagedDnsRecords(tx, ["web.beta.example"]) };
    });
    expect(out.refs).toEqual([[APP, 1], [DNS_RESOURCE_MORPH_CLASS.serviceApplication, 1]]);
    expect(out.referencing).toEqual([uuid]);
    expect(out.provider).toEqual({ provider_zone_id: "zone-beta.example", token_secret: "fp1:not-decrypted-here" });
    expect(out.afterRelease).toBe(1);
    expect(out.left).toBe(0);
    expect(out.listed).toEqual([]);
  });

  it("keeps an org's records and references to itself", async () => {
    const z = await zoneOf(A, "gamma.example");
    const id = await withOrg(ex, A, async (tx) => {
      const row = await insertManagedDnsRecord(tx, A, uuidOf("rec"), { integrationTokenId: z.tokenId, zoneId: z.zoneId, providerRecordId: "r-3", type: "A", name: "x.gamma.example", content: "203.0.113.10", owned: true });
      await addManagedDnsReference(tx, A, row.id, [APP, 7]);
      return row.id;
    });
    await withOrg(ex, B, async (tx) => {
      expect(await listManagedDnsRecords(tx, ["x.gamma.example"])).toEqual([]);
      expect(await listManagedDnsReferences(tx, id)).toEqual([]);
      expect(await managedDnsRecordProvider(tx, id)).toBeNull();
      await deleteManagedDnsRecord(tx, id);
    });
    expect(await withOrg(ex, A, async (tx) => (await listManagedDnsRecords(tx, ["x.gamma.example"])).length)).toBe(1);
  });

  it("answers a reference to an unknown class or a missing row as dead, and finds no hostname user in an empty org", async () => {
    await withOrg(ex, A, async (tx) => {
      expect(await dnsReferenceIsLive(tx, ["App\\Models\\Unknown", 1])).toBe(false);
      expect(await dnsReferenceIsLive(tx, [APP, 424242])).toBe(false);
      expect(await dnsHostnameCandidates(tx, "nobody.example")).toEqual([]);
    });
  });
});
