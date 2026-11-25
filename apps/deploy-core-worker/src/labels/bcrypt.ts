// PHP's password_hash($password, PASSWORD_BCRYPT, ['cost' => $cost]), which Coolify's label generators
// (coollabsio/coolify@91b7e3e:bootstrap/helpers/docker.php, fqdnLabelsForTraefik and fqdnLabelsForCaddy)
// call for the HTTP Basic Authentication middleware. Written from the bcrypt specification (Provos and
// Mazières, "A Future-Adaptable Password Scheme"), not from Coolify or PHP source: the "$2y$" variant —
// the key is the password's bytes and a NUL, at most 72 bytes; a 16-byte salt; 2^cost rounds of the
// expensive key schedule; "OrpheanBeholderScryDoubt" encrypted 64 times; bcrypt's own base64 alphabet.
//
// The salt is the only random input, so it is a parameter: with PHP's salt this returns PHP's hash,
// byte for byte (tests/deploy-core-worker/src/labels.test.ts checks it against password_hash output).
import { BLOWFISH_PI_HEX } from "./blowfish-pi.js";

const P_WORDS = 18;
const S_WORDS = 4 * 256;

let initial: Uint32Array | null = null;
function initialState(): Uint32Array {
  if (!initial) {
    initial = new Uint32Array(P_WORDS + S_WORDS);
    for (let i = 0; i < initial.length; i++) initial[i] = parseInt(BLOWFISH_PI_HEX.slice(i * 8, i * 8 + 8), 16);
  }
  return initial;
}

/** One Blowfish block encryption of lr[0], lr[1] in place; `s` holds P (18 words) then the S-boxes. */
function encipher(s: Uint32Array, lr: Uint32Array): void {
  let l = lr[0]! ^ s[0]!;
  let r = lr[1]!;
  for (let i = 1; i <= 16; i += 2) {
    r ^= (((s[18 + (l >>> 24)]! + s[274 + ((l >>> 16) & 0xff)]!) ^ s[530 + ((l >>> 8) & 0xff)]!) + s[786 + (l & 0xff)]!) ^ s[i]!;
    l ^= (((s[18 + (r >>> 24)]! + s[274 + ((r >>> 16) & 0xff)]!) ^ s[530 + ((r >>> 8) & 0xff)]!) + s[786 + (r & 0xff)]!) ^ s[i + 1]!;
  }
  lr[0] = (r ^ s[17]!) >>> 0;
  lr[1] = l >>> 0;
}

/** The next big-endian word of `data`, read cyclically from offset.at. */
function streamWord(data: Uint8Array, offset: { at: number }): number {
  let word = 0;
  for (let i = 0; i < 4; i++) {
    word = ((word << 8) | data[offset.at]!) >>> 0;
    offset.at = (offset.at + 1) % data.length;
  }
  return word;
}

/** ExpandKey(state, salt, key); a null salt is the all-zero salt of the cost loop. */
function expandKey(s: Uint32Array, salt: Uint8Array | null, key: Uint8Array): void {
  const keyOffset = { at: 0 };
  for (let i = 0; i < P_WORDS; i++) s[i] = (s[i]! ^ streamWord(key, keyOffset)) >>> 0;
  const saltOffset = { at: 0 };
  const lr = new Uint32Array(2);
  for (let i = 0; i < s.length; i += 2) {
    if (salt) {
      lr[0] = (lr[0]! ^ streamWord(salt, saltOffset)) >>> 0;
      lr[1] = (lr[1]! ^ streamWord(salt, saltOffset)) >>> 0;
    }
    encipher(s, lr);
    s[i] = lr[0]!;
    s[i + 1] = lr[1]!;
  }
}

const ALPHABET = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** bcrypt's base64: its own alphabet, no padding. */
function encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += ALPHABET[b2 & 0x3f];
  }
  return out;
}

function decode(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let bits = 0;
  let held = 0;
  let at = 0;
  for (const ch of text) {
    const value = ALPHABET.indexOf(ch);
    if (value === -1) throw new Error("bcrypt: invalid salt");
    held = (held << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (at < length) out[at++] = (held >> bits) & 0xff;
    }
  }
  if (at !== length) throw new Error("bcrypt: invalid salt");
  return out;
}

/** The 16-byte salt of a "$2y$10$…" hash, to hash another password with it. */
export function bcryptSaltOf(hash: string): Uint8Array {
  const m = /^\$2[abxy]\$\d\d\$([./A-Za-z0-9]{22})/.exec(hash);
  if (!m) throw new Error("bcrypt: not a bcrypt hash");
  return decode(m[1]!, 16);
}

export function randomBcryptSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/**
 * password_hash($password, PASSWORD_BCRYPT, ['cost' => $cost]) with the given salt:
 * "$2y$" + two-digit cost + "$" + 22 characters of salt + 31 characters of hash.
 * PHP accepts a cost of 4 to 31 and refuses a password with a NUL byte.
 */
export function bcryptHash(password: string, cost: number, salt: Uint8Array = randomBcryptSalt()): string {
  if (!Number.isInteger(cost) || cost < 4 || cost > 31) throw new Error(`Invalid bcrypt cost parameter specified: ${cost}`);
  if (salt.length !== 16) throw new Error("bcrypt: the salt must be 16 bytes");
  const bytes = new TextEncoder().encode(password);
  if (bytes.includes(0)) throw new Error("Bcrypt password must not contain null character");
  // The password and its terminating NUL, cut at 72 bytes.
  const key = new Uint8Array(Math.min(bytes.length + 1, 72));
  key.set(bytes.subarray(0, key.length));
  if (bytes.length < 72) key[bytes.length] = 0;

  const s = initialState().slice();
  expandKey(s, salt, key);
  // 2^cost as a count of iterations: `1 << 31` would overflow, so count in a double.
  for (let rounds = 2 ** cost; rounds > 0; rounds--) {
    expandKey(s, null, key);
    expandKey(s, null, salt);
  }
  // "OrpheanBeholderScryDoubt" as three blocks.
  const text = new Uint32Array([0x4f727068, 0x65616e42, 0x65686f6c, 0x64657253, 0x63727944, 0x6f756274]);
  const block = new Uint32Array(2);
  for (let b = 0; b < 3; b++) {
    block[0] = text[b * 2]!;
    block[1] = text[b * 2 + 1]!;
    for (let i = 0; i < 64; i++) encipher(s, block);
    text[b * 2] = block[0]!;
    text[b * 2 + 1] = block[1]!;
  }
  const out = new Uint8Array(24);
  for (let i = 0; i < 6; i++) {
    out[i * 4] = text[i]! >>> 24;
    out[i * 4 + 1] = (text[i]! >>> 16) & 0xff;
    out[i * 4 + 2] = (text[i]! >>> 8) & 0xff;
    out[i * 4 + 3] = text[i]! & 0xff;
  }
  // bcrypt keeps 23 of the 24 bytes.
  return `$2y$${String(cost).padStart(2, "0")}$${encode(salt)}${encode(out.subarray(0, 23))}`;
}
