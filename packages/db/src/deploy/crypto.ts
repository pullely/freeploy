// Envelope encryption for the deploy context's encrypted columns (DP2).
//
//   platform KEK (Worker secret DEPLOY_ENCRYPTION_KEY, 32 bytes base64)
//     └─ wraps each org's DEK (32 random bytes)          → deploy.org_keys
//          └─ encrypts a column value (AES-256-GCM)      → "fp1:<v>:<iv>:<ct>"
//
// The value is bound to its org and column through the GCM additional data
// (`<org>:<table>.<column>`), so a ciphertext copied to another org's row or
// another column does not decrypt. Decryption of SSH private keys happens
// only in the ssh-executor (DP4); this module is what it and the worker share.
import type { SqlExecutor } from "../hyperdrive/executor.js";

const PREFIX = "fp1";
const enc = new TextEncoder();
const dec = new TextDecoder();

/** A standalone ArrayBuffer copy: accepted as BufferSource under both Workers and Node typings. */
const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class CryptoError extends Error {}

// Types taken from crypto.subtle itself, so this compiles under the Workers
// types and under Node's alike.
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
type Usage = Parameters<typeof crypto.subtle.importKey>[4][number];

async function aesKey(raw: Uint8Array, usage: Usage[]): Promise<Key> {
  if (raw.length !== 32) throw new CryptoError("an AES-256 key must be 32 bytes");
  return crypto.subtle.importKey("raw", buf(raw), { name: "AES-GCM" }, false, usage);
}

async function seal(key: Key, plaintext: Uint8Array, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(enc.encode(aad)) }, key, buf(plaintext)));
  return `${b64(iv)}:${b64(ct)}`;
}

async function open(key: Key, sealed: string, aad: string): Promise<Uint8Array> {
  const [iv, ct] = sealed.split(":");
  if (!iv || !ct) throw new CryptoError("malformed ciphertext");
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(unb64(iv)), additionalData: buf(enc.encode(aad)) }, key, buf(unb64(ct))));
  } catch {
    throw new CryptoError("decryption failed (wrong key, org or column, or tampered value)");
  }
}

/** The platform KEK from the Worker secret. */
export async function loadKek(secret: string | undefined): Promise<Key> {
  if (!secret) throw new CryptoError("DEPLOY_ENCRYPTION_KEY is not configured");
  return aesKey(unb64(secret), ["encrypt", "decrypt"]);
}

export interface OrgDek {
  orgId: string;
  version: number;
  key: Key;
}

/**
 * The org's current data key, creating it on first use. Must run inside
 * withOrg(): row-level security confines deploy.org_keys to that org.
 */
export async function orgDek(tx: SqlExecutor, orgId: string, kek: Key): Promise<OrgDek> {
  const found = await tx.execute<{ version: number; wrapped_dek: string }>(
    "SELECT version, wrapped_dek FROM deploy.org_keys WHERE org_id = $1 AND retired_at IS NULL ORDER BY version DESC LIMIT 1",
    [orgId],
  );
  const row = found.rows[0];
  if (row) {
    const raw = await open(kek, row.wrapped_dek, `dek:${orgId}:${row.version}`);
    return { orgId, version: row.version, key: await aesKey(raw, ["encrypt", "decrypt"]) };
  }
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await seal(kek, raw, `dek:${orgId}:1`);
  await tx.execute("INSERT INTO deploy.org_keys (org_id, version, wrapped_dek) VALUES ($1, 1, $2) ON CONFLICT DO NOTHING", [orgId, wrapped]);
  // A concurrent first use may have won the insert: read back whichever key is stored.
  const again = await tx.execute<{ version: number; wrapped_dek: string }>(
    "SELECT version, wrapped_dek FROM deploy.org_keys WHERE org_id = $1 AND version = 1",
    [orgId],
  );
  const stored = again.rows[0]!;
  const key = await aesKey(await open(kek, stored.wrapped_dek, `dek:${orgId}:1`), ["encrypt", "decrypt"]);
  return { orgId, version: 1, key };
}

const aadFor = (dek: OrgDek, column: string) => `${dek.orgId}:${column}`;

/** Encrypt one column value, e.g. encryptField(dek, "private_keys.private_key", pem). */
export async function encryptField(dek: OrgDek, column: string, value: string): Promise<string> {
  return `${PREFIX}:${dek.version}:${await seal(dek.key, enc.encode(value), aadFor(dek, column))}`;
}

export async function decryptField(dek: OrgDek, column: string, stored: string): Promise<string> {
  const [prefix, version, iv, ct] = stored.split(":");
  if (prefix !== PREFIX || !version || !iv || !ct) throw new CryptoError("not an fp1 ciphertext");
  if (Number(version) !== dek.version) throw new CryptoError(`value is under key version ${version}, not ${dek.version}`);
  return dec.decode(await open(dek.key, `${iv}:${ct}`, aadFor(dek, column)));
}

export const isEncrypted = (stored: unknown): boolean => typeof stored === "string" && stored.startsWith(`${PREFIX}:`);
