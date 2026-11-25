// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/shared.php (generateEnvValue) and, as that
// function calls them, laravel/framework's Str::password and Str::random and lcobucci/jwt's HS256 builder
// (Apache-2.0, MIT and BSD-3-Clause), modified.
//
// The values Coolify generates for a service's magic variables: SERVICE_PASSWORD_X, SERVICE_USER_X,
// SERVICE_BASE64_64_X, SERVICE_HEX_32_X, SERVICE_REALBASE64_X … and the two Supabase keys, which are JWTs
// signed with the service's SERVICE_PASSWORD_JWT. Randomness and the clock are arguments (`MagicValueSource`),
// so a test can replay the values PHP drew and compare everything derived from them.
import { utf8 } from "../compose/php.js";

export interface MagicValueSource {
  /** `count` random bytes. */
  bytes(count: number): Uint8Array;
  /** The current time in seconds since the epoch. */
  now(): number;
}

export const DEFAULT_MAGIC_VALUE_SOURCE: MagicValueSource = {
  bytes: (count) => crypto.getRandomValues(new Uint8Array(count)),
  now: () => Math.floor(Date.now() / 1000),
};

const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const NUMBERS = "0123456789";
const SYMBOLS = "~!#$%^&*()-_.,<>?/\\{}[]|:;";
const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A uniform integer in [0, n): rejection sampling over one byte, no modulo bias. */
function randomInt(source: MagicValueSource, n: number): number {
  const limit = Math.floor(256 / n) * n;
  for (;;) {
    const byte = source.bytes(1)[0] ?? 0;
    if (byte < limit) return byte % n;
  }
}

/** Str::random($length): letters and digits. */
export function randomString(source: MagicValueSource, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) value += ALPHANUMERIC.charAt(randomInt(source, ALPHANUMERIC.length));
  return value;
}

/** Str::password($length, symbols: $symbols): one character of each kind, the rest from all of them, shuffled. */
export function randomPassword(source: MagicValueSource, length: number, symbols: boolean): string {
  const kinds = symbols ? [LETTERS, NUMBERS, SYMBOLS] : [LETTERS, NUMBERS];
  const characters = kinds.map((kind) => kind.charAt(randomInt(source, kind.length)));
  const all = kinds.join("");
  while (characters.length < length) characters.push(all.charAt(randomInt(source, all.length)));
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const other = randomInt(source, index + 1);
    [characters[index], characters[other]] = [characters[other] ?? "", characters[index] ?? ""];
  }
  return characters.join("");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---- SHA-256 and HMAC, synchronous (WebCrypto's are not) ----

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

export function sha256(message: Uint8Array): Uint8Array {
  const length = message.length;
  const padded = new Uint8Array((((length + 8) >> 6) + 1) << 6);
  padded.set(message);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (length * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const w15 = w[index - 15] ?? 0;
      const w2 = w[index - 2] ?? 0;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[index] = ((w[index - 16] ?? 0) + s0 + (w[index - 7] ?? 0) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0] ?? 0, h[1] ?? 0, h[2] ?? 0, h[3] ?? 0, h[4] ?? 0, h[5] ?? 0, h[6] ?? 0, h[7] ?? 0];
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + (K[index] ?? 0) + (w[index] ?? 0)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      [hh, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    [a, b, c, d, e, f, g, hh].forEach((value, index) => {
      h[index] = ((h[index] ?? 0) + value) >>> 0;
    });
  }
  const digest = new Uint8Array(32);
  const out = new DataView(digest.buffer);
  h.forEach((value, index) => out.setUint32(index * 4, value));
  return digest;
}

export function hmacSha256(keyInput: Uint8Array, message: Uint8Array): Uint8Array {
  const key = keyInput.length > 64 ? sha256(keyInput) : keyInput;
  const inner = new Uint8Array(64 + message.length).fill(0x36, 0, 64);
  const outer = new Uint8Array(64 + 32).fill(0x5c, 0, 64);
  key.forEach((byte, index) => {
    inner[index] = byte ^ 0x36;
    outer[index] = byte ^ 0x5c;
  });
  inner.set(message, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

const base64Url = (bytes: Uint8Array): string => base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

/** The Supabase key Coolify issues: an HS256 JWT for `role`, issued at the current minute, valid 100 years. */
export function supabaseJwt(signingKey: string, role: string, nowSeconds: number): string {
  const issuedAt = nowSeconds - (nowSeconds % 60);
  const issued = new Date(issuedAt * 1000);
  const expires = Date.UTC(issued.getUTCFullYear() + 100, issued.getUTCMonth(), issued.getUTCDate(), issued.getUTCHours(), issued.getUTCMinutes()) / 1000;
  const header = base64Url(utf8('{"typ":"JWT","alg":"HS256"}'));
  const claims = base64Url(utf8(JSON.stringify({ iss: "supabase", iat: issuedAt, exp: expires, role })));
  const signature = base64Url(hmacSha256(utf8(signingKey), utf8(`${header}.${claims}`)));
  return `${header}.${claims}.${signature}`;
}

/**
 * generateEnvValue(): the value of a magic variable's command, or null for a command Coolify does not
 * know (SERVICE_API_KEY, …), which leaves the variable empty for the user to fill in. `signingKey` is the
 * service's SERVICE_PASSWORD_JWT, read by the caller; without it the Supabase keys are null.
 */
export function generateEnvValue(command: string, source: MagicValueSource = DEFAULT_MAGIC_VALUE_SOURCE, signingKey: string | null = null): string | null {
  switch (command) {
    case "PASSWORD":
      return randomPassword(source, 32, false);
    case "PASSWORD_64":
      return randomPassword(source, 64, false);
    case "PASSWORDWITHSYMBOLS":
      return randomPassword(source, 32, true);
    case "PASSWORDWITHSYMBOLS_64":
      return randomPassword(source, 64, true);
    case "BASE64_64":
      return randomString(source, 64);
    case "BASE64_128":
      return randomString(source, 128);
    case "BASE64":
    case "BASE64_32":
      return randomString(source, 32);
    case "REALBASE64_64":
      return base64(source.bytes(64));
    case "REALBASE64_128":
      return base64(source.bytes(128));
    case "REALBASE64":
    case "REALBASE64_32":
      return base64(source.bytes(32));
    case "HEX_32":
      return hex(source.bytes(16));
    case "HEX_64":
      return hex(source.bytes(32));
    case "HEX_128":
      return hex(source.bytes(64));
    case "USER":
      return randomString(source, 16);
    case "LOWERCASEUSER":
      return randomString(source, 16).toLowerCase();
    case "SUPABASEANON":
      return signingKey === null ? null : supabaseJwt(signingKey, "anon", source.now());
    case "SUPABASESERVICE":
      return signingKey === null ? null : supabaseJwt(signingKey, "service_role", source.now());
    default:
      return null;
  }
}
