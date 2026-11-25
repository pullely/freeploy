// deploy.ssl_certificates (DP-48) against a real Postgres: the store functions
// of @saas/db/deploy inside withOrg(), the certificate and private key columns
// encrypted with the org's data key, and row-level security keeping each org's
// rows to itself.
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
  isEncryptedColumn,
  findServerCaCertificate,
  deleteSslCertificates,
  insertSslCertificate,
  updateSslCertificateContent,
  type NewSslCertificate,
} from "@saas/db/deploy";
import type { SqlExecutor, TransactionalSqlExecutor } from "@saas/db/hyperdrive";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SQL = ["500_deploy_core", "510_deploy_org_keys", "520_deploy_schema_fold_fixes"].map((m) => readFileSync(resolve(root, `packages/db/src/migrations/${m}/up.sql`), "utf8")).join("\n");
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const KEK = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const CERT_COLUMN = "ssl_certificates.ssl_certificate";
const KEY_COLUMN = "ssl_certificates.ssl_private_key";
const CERT = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const KEY = "-----BEGIN PRIVATE KEY-----\nMIHu\n-----END PRIVATE KEY-----\n";

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
const serverId: Record<string, number> = {};
beforeAll(async () => {
  db = new PGlite();
  await db.exec(SQL);
  ex = executor(db);
  for (const [org, key, uuid] of [
    [A, 800, "srvcaa"],
    [B, 801, "srvcab"],
  ] as const) {
    await withOrg(ex, org, async (tx) => {
      await tx.execute(`INSERT INTO deploy.private_keys (id, uuid, name, private_key, org_id) VALUES ($1, $2, 'k', 'x', $3)`, [key, `pk${key}`, org]);
      const r = await tx.execute<{ id: string | number }>(
        `INSERT INTO deploy.servers (uuid, name, ip, private_key_id, proxy, org_id) VALUES ($1, 'ca-server', '10.0.0.9', $2, '{}', $3) RETURNING id`,
        [uuid, key, org],
      );
      serverId[org] = Number(r.rows[0]!.id);
    });
  }
}, 120_000);
afterAll(async () => db?.close());

async function addCertificate(org: string, over: Partial<NewSslCertificate> = {}, cert = CERT, key = KEY) {
  return withOrg(ex, org, async (tx) => {
    const dek = await orgDek(tx, org, await loadKek(KEK));
    return insertSslCertificate(tx, {
      orgId: org,
      serverId: serverId[org]!,
      resourceType: null,
      resourceId: null,
      sslCertificate: await encryptField(dek, CERT_COLUMN, cert),
      sslPrivateKey: await encryptField(dek, KEY_COLUMN, key),
      configurationDir: null,
      mountPath: null,
      commonName: "Coolify CA Certificate",
      subjectAlternativeNames: [],
      validUntil: new Date("2036-11-21T21:52:24.731Z"),
      isCaCertificate: true,
      ...over,
    });
  });
}

describe("deploy.ssl_certificates", () => {
  it("has Coolify's two encrypted columns", () => {
    expect(isEncryptedColumn("ssl_certificates", "ssl_certificate")).toBe(true);
    expect(isEncryptedColumn("ssl_certificates", "ssl_private_key")).toBe(true);
  });

  it("has no CA certificate for a new server", async () => {
    expect(await withOrg(ex, A, (tx) => findServerCaCertificate(tx, serverId[A]!))).toBeNull();
  });

  it("round-trips a CA certificate: both columns ciphertexts of the org, the private key not part of the inserted row", async () => {
    const row = await addCertificate(A);
    expect(row).toMatchObject({ common_name: "Coolify CA Certificate", is_ca_certificate: true, resource_type: null, resource_id: null, configuration_dir: null, mount_path: null });
    expect(Number(row.server_id)).toBe(serverId[A]);
    expect(row).not.toHaveProperty("ssl_private_key");
    expect(row.subject_alternative_names).toEqual([]);
    expect(row.created_at).not.toBeNull();
    const found = (await withOrg(ex, A, (tx) => findServerCaCertificate(tx, serverId[A]!)))!;
    expect(isEncrypted(found.ssl_certificate)).toBe(true);
    expect(isEncrypted(found.ssl_private_key)).toBe(true);
    expect(found.ssl_certificate).not.toContain("BEGIN");
    expect(found.ssl_private_key).not.toContain("BEGIN");
    const open = (column: string, value: string, org = A) => withOrg(ex, org, async (tx) => decryptField(await orgDek(tx, org, await loadKek(KEK)), column, value));
    expect(await open(CERT_COLUMN, found.ssl_certificate)).toBe(CERT);
    expect(await open(KEY_COLUMN, found.ssl_private_key)).toBe(KEY);
    // B's data key does not open A's values, and each value is bound to its column.
    await expect(open(KEY_COLUMN, found.ssl_private_key, B)).rejects.toThrow();
    await expect(open(CERT_COLUMN, found.ssl_private_key)).rejects.toThrow();
    await expect(open(KEY_COLUMN, found.ssl_certificate)).rejects.toThrow();
  });

  it("stores valid_until as the UTC wall-clock second (Laravel's TIMESTAMP(0))", async () => {
    const r = await withOrg(ex, A, (tx) => tx.execute<{ v: string }>(`SELECT to_char(valid_until, 'YYYY-MM-DD HH24:MI:SS') AS v FROM deploy.ssl_certificates WHERE server_id = $1`, [serverId[A]!]));
    expect(r.rows.map((x) => x.v)).toEqual(["2036-11-21 21:52:24"]);
  });

  it("keeps each org's certificates to itself (row-level security)", async () => {
    await addCertificate(B);
    const a = (await withOrg(ex, A, (tx) => findServerCaCertificate(tx, serverId[A]!)))!;
    expect(await withOrg(ex, B, (tx) => findServerCaCertificate(tx, serverId[A]!))).toBeNull();
    expect(await withOrg(ex, B, (tx) => updateSslCertificateContent(tx, a.id, "stolen"))).toBe(false);
    expect(await withOrg(ex, B, (tx) => deleteSslCertificates(tx, { serverId: serverId[A]!, resourceType: null, resourceId: null }))).toBe(0);
    expect((await withOrg(ex, A, (tx) => findServerCaCertificate(tx, serverId[A]!)))!.ssl_certificate).toBe(a.ssl_certificate);
    await expect(addCertificate(B, { orgId: A })).rejects.toThrow(/row-level security/);
  });

  it("replaces the certificate only: the private key and valid_until stay (saveCaCertificate)", async () => {
    const before = (await withOrg(ex, A, (tx) => findServerCaCertificate(tx, serverId[A]!)))!;
    expect(await withOrg(ex, A, (tx) => updateSslCertificateContent(tx, before.id, "fp1:new"))).toBe(true);
    const after = (await withOrg(ex, A, (tx) => findServerCaCertificate(tx, serverId[A]!)))!;
    expect(after.ssl_certificate).toBe("fp1:new");
    expect(after.ssl_private_key).toBe(before.ssl_private_key);
    expect(String(after.valid_until)).toBe(String(before.valid_until));
    expect(await withOrg(ex, A, (tx) => updateSslCertificateContent(tx, 999_999, "x"))).toBe(false);
  });

  it("deletes the certificates of one owner: a null resource is the server's own, not a database's", async () => {
    const leaf = await addCertificate(A, {
      resourceType: "App\\Models\\StandalonePostgresql",
      resourceId: 7,
      isCaCertificate: false,
      commonName: "postgres-abc",
      subjectAlternativeNames: ["DNS:postgres-abc", "IP:10.0.0.9"],
      configurationDir: "/data/coolify/databases/abc",
      mountPath: "/var/lib/postgresql/certs",
    });
    expect(leaf).toMatchObject({ resource_type: "App\\Models\\StandalonePostgresql", is_ca_certificate: false, mount_path: "/var/lib/postgresql/certs" });
    expect(leaf.subject_alternative_names).toEqual(["DNS:postgres-abc", "IP:10.0.0.9"]);
    // The CA is still the one found: the leaf is not a CA certificate.
    const ca = (await withOrg(ex, A, (tx) => findServerCaCertificate(tx, serverId[A]!)))!;
    expect(ca.is_ca_certificate).toBe(true);
    // Regenerating the CA deletes the server's own certificate and leaves the database's.
    expect(await withOrg(ex, A, (tx) => deleteSslCertificates(tx, { serverId: serverId[A]!, resourceType: null, resourceId: null }))).toBe(1);
    expect(await withOrg(ex, A, (tx) => findServerCaCertificate(tx, serverId[A]!))).toBeNull();
    const left = await withOrg(ex, A, (tx) => tx.execute<{ common_name: string }>(`SELECT common_name FROM deploy.ssl_certificates WHERE server_id = $1`, [serverId[A]!]));
    expect(left.rows.map((r) => r.common_name)).toEqual(["postgres-abc"]);
    // And a database's certificates go by its type and id.
    expect(await withOrg(ex, A, (tx) => deleteSslCertificates(tx, { serverId: serverId[A]!, resourceType: "App\\Models\\StandalonePostgresql", resourceId: 8 }))).toBe(0);
    expect(await withOrg(ex, A, (tx) => deleteSslCertificates(tx, { serverId: serverId[A]!, resourceType: "App\\Models\\StandalonePostgresql", resourceId: 7 }))).toBe(1);
  });
});
