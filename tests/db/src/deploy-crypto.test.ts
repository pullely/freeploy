// Envelope encryption for the deploy context (DP2): per-org data keys wrapped
// by the platform KEK, values bound to their org and column.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { withOrg } from "@saas/db/deploy";
import { loadKek, orgDek, encryptField, decryptField, isEncrypted, CryptoError } from "../../../packages/db/src/deploy/crypto.js";
import { ENCRYPTED_COLUMNS } from "../../../packages/db/src/deploy/encrypted-columns.js";
import { deployDatabase, executor, REPO_ROOT } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
/** Laravel's `encrypted` / `encrypted:*` casts and Coolify's Encrypted*Cast classes, as the generator reads them. */
const ENCRYPTING_CAST = /^encrypted(:|$)|^(?:\\?App\\Casts\\)?Encrypted\w*Cast(::class)?$/;
const kekB64 = (seed: number) => Buffer.from(new Uint8Array(32).fill(seed)).toString("base64");

let db: PGlite;
beforeAll(async () => {
  db = await deployDatabase();
}, 120_000);
afterAll(async () => db?.close());

describe("envelope encryption", () => {
  it("round-trips a value and stores a ciphertext, not the value", async () => {
    const kek = await loadKek(kekB64(1));
    const ex = executor(db);
    const stored = await withOrg(ex, A, async (tx) => encryptField(await orgDek(tx, A, kek), "private_keys.private_key", "-----BEGIN KEY-----"));
    expect(isEncrypted(stored)).toBe(true);
    expect(stored).not.toContain("BEGIN KEY");
    const back = await withOrg(ex, A, async (tx) => decryptField(await orgDek(tx, A, kek), "private_keys.private_key", stored));
    expect(back).toBe("-----BEGIN KEY-----");
  });

  it("gives each org its own key, stored only wrapped and only visible to that org", async () => {
    const kek = await loadKek(kekB64(1));
    const ex = executor(db);
    await withOrg(ex, B, async (tx) => orgDek(tx, B, kek));
    const asA = await withOrg(ex, A, (tx) => tx.execute<{ org_id: string; wrapped_dek: string }>("SELECT org_id, wrapped_dek FROM deploy.org_keys"));
    expect(asA.rows.map((r) => r.org_id)).toEqual([A]);
    expect(asA.rows[0]!.wrapped_dek).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  });

  it("does not decrypt under another org, another column, another KEK, or after tampering", async () => {
    const kek = await loadKek(kekB64(1));
    const ex = executor(db);
    const stored = await withOrg(ex, A, async (tx) => encryptField(await orgDek(tx, A, kek), "s3_storages.secret", "s3cr3t"));
    await expect(withOrg(ex, B, async (tx) => decryptField(await orgDek(tx, B, kek), "s3_storages.secret", stored))).rejects.toBeInstanceOf(CryptoError);
    await expect(withOrg(ex, A, async (tx) => decryptField(await orgDek(tx, A, kek), "s3_storages.key", stored))).rejects.toBeInstanceOf(CryptoError);
    const otherKek = await loadKek(kekB64(2));
    await expect(withOrg(ex, A, async (tx) => orgDek(tx, A, otherKek))).rejects.toBeInstanceOf(CryptoError);
    const tampered = stored.slice(0, -4) + (stored.endsWith("AAAA") ? "BBBB" : "AAAA");
    await expect(withOrg(ex, A, async (tx) => decryptField(await orgDek(tx, A, kek), "s3_storages.secret", tampered))).rejects.toBeInstanceOf(CryptoError);
  });

  it("refuses to run without a KEK", async () => {
    await expect(loadKek(undefined)).rejects.toBeInstanceOf(CryptoError);
  });
});

describe("encrypted column coverage", () => {
  it("lists every Coolify cast that encrypts a column of a deploy table, and each listed column exists", async () => {
    const models = JSON.parse(readFileSync(resolve(REPO_ROOT, "specs/epics/freeploy-coolify-parity/parity/models.json"), "utf8"));
    const casts = models.rows.flatMap((m: { casts: Record<string, string> }) => Object.entries(m.casts ?? {}).filter(([, c]) => ENCRYPTING_CAST.test(c)));
    // 87 `encrypted`, one `encrypted:array` and the two `EncryptedArrayCast::class` of ApplicationDeploymentQueue (DP-63).
    expect(casts).toHaveLength(90);
    const listed = Object.entries(ENCRYPTED_COLUMNS).flatMap(([t, cols]) => cols.map((c) => `${t}.${c}`));
    // The rest are excluded with a reason in the generated file: two live on tables Lumen owns
    // (audit_events.changes, team_invitations.link); three are Coolify casts on columns its own
    // migrations only ever create on server_settings (instance_settings.sentinel_token,
    // servers.logdrain_axiom_api_key, servers.logdrain_newrelic_license_key).
    const src = readFileSync(resolve(REPO_ROOT, "packages/db/src/deploy/encrypted-columns.ts"), "utf8");
    const excluded = (src.match(/ \(\w+: (table owned by Lumen|cast on a column Coolify's schema does not have)\)/g) ?? []).length;
    expect(excluded).toBe(5);
    expect(listed).toHaveLength(85);
    expect(listed.length + excluded).toBe(casts.length);
    // Coolify's own cast class (app/Casts/EncryptedArrayCast.php: Crypt::encryptString of the JSON) counts: the
    // deployment queue's configuration snapshot and diff hold environment values and are ciphertexts at rest.
    expect(listed).toEqual(expect.arrayContaining(["application_deployment_queues.configuration_snapshot", "application_deployment_queues.configuration_diff"]));
    // In the schema at head, and of a type that can hold an `fp1` ciphertext.
    const columns = await db.query<{ tc: string; data_type: string }>("SELECT table_name || '.' || column_name AS tc, data_type FROM information_schema.columns WHERE table_schema = 'deploy'");
    const types = new Map(columns.rows.map((r) => [r.tc, r.data_type]));
    for (const tc of listed) {
      expect([tc, types.has(tc)]).toEqual([tc, true]);
      expect([tc, ["text", "character varying"].includes(types.get(tc)!)]).toEqual([tc, true]);
    }
  });
});
