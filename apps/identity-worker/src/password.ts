// Password hashing for email + password sign-in (DP3). PBKDF2-SHA256 through
// WebCrypto, 100,000 iterations (the most Cloudflare Workers' PBKDF2 allows;
// more throws at runtime), 16-byte salt.
// Stored as pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>.
const ITERATIONS = 100_000;
const enc = new TextEncoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", buf(enc.encode(password)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: buf(salt), iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, iterations);
  return ["pbkdf2-sha256", String(iterations), b64(salt), b64(hash)].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, iter, salt, hash] = stored.split("$");
  if (alg !== "pbkdf2-sha256" || !iter || !salt || !hash) return false;
  const got = await derive(password, unb64(salt), Number(iter));
  const want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i]! ^ want[i]!;
  return diff === 0;
}

/**
 * Laravel's Password::uncompromised(): the k-anonymity range lookup at
 * api.pwnedpasswords.com. Like Laravel's NotPwnedVerifier, a failed lookup
 * counts as not compromised.
 */
export async function isCompromised(password: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", buf(enc.encode(password))));
  const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  try {
    const res = await fetcher(`https://api.pwnedpasswords.com/range/${hex.slice(0, 5)}`, { headers: { "Add-Padding": "true" } });
    if (!res.ok) return false;
    const body = await res.text();
    return body.split("\n").some((line) => {
      const [suffix, count] = line.trim().split(":");
      return suffix === hex.slice(5) && Number(count) > 0;
    });
  } catch {
    return false;
  }
}
