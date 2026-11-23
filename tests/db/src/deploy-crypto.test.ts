// Envelope encryption for the deploy context (DP2): per-org data keys wrapped
// by the platform KEK, values bound to their org and column.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { withOrg } from "@saas/db/deploy";
import { loadKek, orgDek, encryptField, decryptField, isEncrypted, CryptoError } from "../../../packages/db/src/deploy/crypto.js";
import { ENCRYPTED_COLUMNS } from "../../../packages/db/src/deploy/encrypted-columns.js";
import type { SqlExecutor, TransactionalSqlExecutor } from "@saas/db/hyperdrive";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SQL = ["500_deploy_core", "510_deploy_org_keys", "520_deploy_schema_fold_fixes"].map((m) => readFileSync(resolve(root, `packages/db/src/migrations/${m}/up.sql`), "utf8")).join("\n");
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const kekB64 = (seed: number) => Buffer.from(new Uint8Array(32).fill(seed)).toString("base64");

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
beforeAll(async () => {
  db = new PGlite();
  await db.exec(SQL);
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
  it("lists every Coolify `encrypted` cast on a deploy table, and each listed column exists", () => {
    const models = JSON.parse(readFileSync(resolve(root, "specs/epics/freeploy-coolify-parity/parity/models.json"), "utf8"));
    const casts = models.rows.flatMap((m: { casts: Record<string, string> }) => Object.entries(m.casts ?? {}).filter(([, c]) => /^encrypted/.test(c)));
    const listed = Object.entries(ENCRYPTED_COLUMNS).flatMap(([t, cols]) => cols.map((c) => `${t}.${c}`));
    // The rest are excluded with a reason in the generated file: two live on tables Lumen owns
    // (audit_events.changes, team_invitations.link); three are Coolify casts on columns its own
    // migrations only ever create on server_settings (instance_settings.sentinel_token,
    // servers.logdrain_axiom_api_key, servers.logdrain_newrelic_license_key).
    const src = readFileSync(resolve(root, "packages/db/src/deploy/encrypted-columns.ts"), "utf8");
    const excluded = (src.match(/ \(\w+: (table owned by Lumen|cast on a column Coolify's schema does not have)\)/g) ?? []).length;
    expect(excluded).toBe(5);
    expect(listed.length + excluded).toBe(casts.length);
    for (const tc of listed) {
      const [t, c] = tc.split(".");
      const inCreate = new RegExp(`CREATE TABLE IF NOT EXISTS deploy\\.${t} \\(\\n[^;]*?"${c}"`).test(SQL);
      const added = SQL.includes(`ALTER TABLE deploy.${t} ADD COLUMN IF NOT EXISTS "${c}"`);
      expect([tc, inCreate || added]).toEqual([tc, true]);
    }
  });
});
