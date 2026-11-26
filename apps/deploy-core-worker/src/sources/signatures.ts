// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Webhook/{Github,Gitlab,Gitea,Bitbucket}.php — the
// signature checks: hash_hmac('sha256', $request->getContent(), $secret) and hash_equals() (Apache-2.0), modified.
//
// HMAC-SHA256 over the raw body, as lowercase hex (hash_hmac), and PHP's hash_equals(): false at once for
// strings of different lengths (their length is not secret), otherwise a comparison that looks at every
// character whatever it finds.

const enc = new TextEncoder();

/** hash_hmac('sha256', $data, $key). */
export async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** hash_equals($known, $user): constant-time over the bytes of two strings of the same length. */
export function hashEquals(known: string, user: string): boolean {
  const a = enc.encode(known);
  const b = enc.encode(user);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
