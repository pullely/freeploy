// Derived from the behaviour of pragmarx/google2fa as Laravel Fortify uses it
// in coollabsio/coolify@91b7e3e (MIT / Apache-2.0), modified: RFC 6238 TOTP,
// SHA-1, 6 digits, 30-second steps, a window of one step either side, and a
// code accepted only if its step is newer than the last one used.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Fortify's generateSecretKey(): 16 base32 characters (80 bits). */
export function generateSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(10)));
}

export const STEP_SECONDS = 30;
export const stepAt = (unixSeconds: number) => Math.floor(unixSeconds / STEP_SECONDS);

export async function codeAt(secret: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base32Decode(secret).slice().buffer as ArrayBuffer, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(step));
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, "0");
}

/** The step a code matches within one step of now, or null. */
export async function matchStep(secret: string, code: string, unixSeconds: number): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepAt(unixSeconds);
  for (const step of [now - 1, now, now + 1]) if ((await codeAt(secret, step)) === code) return step;
  return null;
}

/** Google2FA getQRCodeUrl(company, holder, secret). */
export function otpauthUrl(company: string, holder: string, secret: string): string {
  return `otpauth://totp/${encodeURIComponent(company)}:${encodeURIComponent(holder)}?secret=${secret}&issuer=${encodeURIComponent(company)}&algorithm=SHA1&digits=6&period=30`;
}

/** Fortify's RecoveryCode::generate(): Str::random(10).'-'.Str::random(10). */
export function recoveryCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  // Rejection sampling: 248 = 4 × 62, so every character is equally likely.
  const part = () => {
    let out = "";
    while (out.length < 10) for (const b of crypto.getRandomValues(new Uint8Array(16))) if (b < 248 && out.length < 10) out += chars[b % 62];
    return out;
  };
  return `${part()}-${part()}`;
}
