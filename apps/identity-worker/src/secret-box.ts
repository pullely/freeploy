// Encryption for identity secrets at rest (the 2FA secret, recovery codes,
// sign-in challenges): AES-256-GCM under IDENTITY_ENCRYPTION_KEY (a Worker
// secret, 32 bytes base64), with a context string as additional data so a
// value encrypted for one user or purpose does not decrypt for another.
// Stored as "fp1:" + base64(iv ‖ ciphertext).
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class SecretBoxError extends Error {}

export async function loadKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) throw new SecretBoxError("IDENTITY_ENCRYPTION_KEY is not configured");
  const raw = unb64(secret);
  if (raw.length !== 32) throw new SecretBoxError("IDENTITY_ENCRYPTION_KEY must be 32 bytes");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function seal(key: CryptoKey, context: string, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(context) }, key, enc.encode(value)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return `fp1:${b64(out)}`;
}

export async function open(key: CryptoKey, context: string, stored: string): Promise<string> {
  if (!stored.startsWith("fp1:")) throw new SecretBoxError("not a sealed value");
  const raw = unb64(stored.slice(4));
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12), additionalData: enc.encode(context) }, key, raw.slice(12));
    return dec.decode(pt);
  } catch {
    throw new SecretBoxError("cannot open sealed value");
  }
}
