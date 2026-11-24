// Derived from coollabsio/coolify@91b7e3e:app/Models/PrivateKey.php and bootstrap/helpers/shared.php (generateSSHKey, formatPrivateKey) (Apache-2.0), modified: phpseclib's key handling re-implemented for Workers.
//
// What Coolify does with phpseclib3 (PublicKeyLoader, getFingerprint, toString('OpenSSH'),
// createKey), done here with a small DER / SSH-wire parser plus Web Crypto:
//
//   formatPrivateKey, validationError   sync (pure parsing, no crypto)
//   publicKeyOpenSSH, fingerprintSha256,
//   fingerprintMd5, generateSSHKey      async (Web Crypto: SHA-256, Ed25519/ECDSA public
//                                       key derivation, key generation; MD5 is in-file
//                                       because Web Crypto has none)
//
// No node:crypto, so this runs with or without nodejs_compat.
//
// Formats read (what phpseclib's PublicKeyLoader accepts that a user plausibly pastes):
//   - OpenSSH "openssh-key-v1", cipher none: ssh-ed25519, ecdsa-sha2-nistp256/384/521,
//     ssh-rsa, ssh-dss
//   - PEM PKCS#1 (RSA PRIVATE KEY), SEC1 (EC PRIVATE KEY), PKCS#8 (PRIVATE KEY: RSA, EC,
//     Ed25519, DSA, and Ed448/X25519/X448 which load but have no OpenSSH form),
//     "DSA PRIVATE KEY"; also the same DER as bare base64 without the BEGIN/END lines
//   - PuTTY .ppk v2/v3, Encryption: none (the public blob is read; the MAC is not checked)
// Not read: XML/JWK/MSBLOB/libsodium raw keys, which phpseclib also loads.

const MSG_INVALID = "The private key is invalid. Paste an unencrypted private key, not a public key or a certificate.";
const MSG_NOT_PEM = 'PuTTY and other key formats are not supported. Paste the key in OpenSSH or PEM format. It starts with "-----BEGIN".';
const MSG_DSA = "DSA keys are not supported. Use an Ed25519 or RSA key.";
const MSG_RSA_SHORT = "RSA keys must have at least 2048 bits.";
const MSG_UNSUPPORTED = "This key type is not supported. Use an Ed25519, ECDSA (nistp256, nistp384, or nistp521), or RSA key.";

/**
 * The comment on public keys Coolify generates. It must stay byte-identical to Coolify's:
 * it is part of the authorized_keys line written to servers, and old install scripts
 * look for it.
 */
export const COOLIFY_KEY_COMMENT = "coolify-generated-ssh-key";

/** phpseclib's OpenSSH::$comment default; EC::createKey()->toString('OpenSSH') writes it into the private key. */
const PHPSECLIB_DEFAULT_COMMENT = "phpseclib-generated-key";

export class SshKeyError extends Error {
  constructor(message = MSG_INVALID) {
    super(message);
    this.name = "SshKeyError";
  }
}

// ---------------------------------------------------------------- Coolify's helpers

/** PHP's trim(): " \t\n\r\0\x0B" only (String.prototype.trim strips more). */
function phpTrim(s: string): string {
  return s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "");
}

/** Coolify's formatPrivateKey: trim, then end with exactly one "\n". */
export function formatPrivateKey(key: string): string {
  const trimmed = phpTrim(key);
  return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}

/**
 * Why a private key cannot be used, or null when it is valid (PrivateKey::validationError).
 * Without `strict`, only checks that the key can be loaded.
 */
export function validationError(privateKey: string | null, strict = true): string | null {
  let key: ParsedKey;
  try {
    key = parsePrivateKey(privateKey ?? "");
  } catch {
    return MSG_INVALID;
  }
  if (!strict) return null;
  if (!phpTrim(privateKey ?? "").startsWith("-----BEGIN ")) return MSG_NOT_PEM;
  if (key.kind === "dsa") return MSG_DSA;
  if (key.kind === "rsa" && bitLength(key.n) < 2048) return MSG_RSA_SHORT;
  if (key.kind === "unsupported") return MSG_UNSUPPORTED;
  return null;
}

/**
 * The OpenSSH public key line, "ssh-ed25519 AAAA… comment" (phpseclib's
 * getPublicKey()->toString('OpenSSH', ['comment' => …])). Without a comment there is no
 * trailing space (phpseclib would leave one). Throws SshKeyError when the key cannot be
 * loaded or has no OpenSSH form.
 */
export async function publicKeyOpenSSH(privateKey: string, comment?: string): Promise<string> {
  const { type, blob } = await sshPublicKey(parsePrivateKey(privateKey));
  const c = (comment ?? "").replace(/[\r\n]/g, "");
  return c === "" ? `${type} ${b64encode(blob)}` : `${type} ${b64encode(blob)} ${c}`;
}

/**
 * phpseclib getFingerprint('sha256'): base64 of SHA-256 of the public key blob, with the
 * last character (the single "=" pad) cut off, no "SHA256:" prefix. Same as ssh-keygen's
 * value. null when the key cannot be loaded or has no OpenSSH form (Coolify's
 * generateFingerprint returns null then too).
 */
export async function fingerprintSha256(privateKey: string): Promise<string | null> {
  const blob = await publicBlobOrNull(privateKey);
  if (!blob) return null;
  const base = b64encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(blob))));
  return base.slice(0, -1);
}

/** phpseclib getFingerprint('md5'): lowercase hex pairs joined by ":", no "MD5:" prefix. */
export async function fingerprintMd5(privateKey: string): Promise<string | null> {
  const blob = await publicBlobOrNull(privateKey);
  if (!blob) return null;
  return Array.from(md5(blob), (b) => b.toString(16).padStart(2, "0")).join(":");
}

export interface SshKeyPair {
  private: string;
  public: string;
}

/**
 * Coolify's generateSSHKey:
 *  - ed25519: EC::createKey('Ed25519')->toString('OpenSSH'): openssh-key-v1, cipher none,
 *    random checkint pair, comment "phpseclib-generated-key", 1,2,3… padding to 8 bytes,
 *    base64 in 70-character lines, "\n" line ends.
 *  - rsa: RSA::createKey(4096)->toString('PKCS1'): "BEGIN RSA PRIVATE KEY", 64-character
 *    lines, "\r\n" line ends, no newline after the END line (phpseclib's exact layout).
 * The public key carries COOLIFY_KEY_COMMENT.
 */
export async function generateSSHKey(type: "ed25519" | "rsa"): Promise<SshKeyPair> {
  if (type === "rsa") {
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    if (!("privateKey" in pair)) throw new SshKeyError("RSA key generation failed.");
    const jwk = await exportJwk(pair.privateKey);
    const ints = [jwk.n, jwk.e, jwk.d, jwk.p, jwk.q, jwk.dp, jwk.dq, jwk.qi].map((v) => bytesToBigInt(b64urlDecode(v)));
    const der = tlv(0x30, derInt(0n), ...ints.map(derInt));
    const pem = `-----BEGIN RSA PRIVATE KEY-----\r\n${chunk(b64encode(der), 64, "\r\n")}-----END RSA PRIVATE KEY-----`;
    const n = ints[0] ?? 0n;
    const e = ints[1] ?? 0n;
    return { private: pem, public: `ssh-rsa ${b64encode(rsaBlob(e, n))} ${COOLIFY_KEY_COMMENT}` };
  }
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new SshKeyError("Ed25519 key generation failed.");
  const jwk = await exportJwk(pair.privateKey);
  const seed = b64urlDecode(jwk.d);
  const pub = b64urlDecode(jwk.x);
  const pubBlob = sshConcat(sshString("ssh-ed25519"), sshString(pub));
  const checkint = crypto.getRandomValues(new Uint8Array(4));
  let section = sshConcat(
    checkint,
    checkint,
    sshString("ssh-ed25519"),
    sshString(pub),
    sshString(sshConcat(seed, pub)),
    sshString(PHPSECLIB_DEFAULT_COMMENT),
  );
  const padLength = (8 - (section.length % 8)) % 8;
  section = sshConcat(section, Uint8Array.from({ length: padLength }, (_, i) => i + 1));
  const body = sshConcat(
    utf8("openssh-key-v1\0"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    u32(1),
    sshString(pubBlob),
    sshString(section),
  );
  return {
    private: `-----BEGIN OPENSSH PRIVATE KEY-----\n${chunk(b64encode(body), 70, "\n")}-----END OPENSSH PRIVATE KEY-----\n`,
    public: `ssh-ed25519 ${b64encode(pubBlob)} ${COOLIFY_KEY_COMMENT}`,
  };
}

// ---------------------------------------------------------------- parsed keys

type Curve = "nistp256" | "nistp384" | "nistp521";

const CURVES: Record<Curve, { oid: string; jwk: string; size: number }> = {
  nistp256: { oid: "1.2.840.10045.3.1.7", jwk: "P-256", size: 32 },
  nistp384: { oid: "1.3.132.0.34", jwk: "P-384", size: 48 },
  nistp521: { oid: "1.3.132.0.35", jwk: "P-521", size: 66 },
};

const OID = {
  rsa: "1.2.840.113549.1.1.1",
  rsaPss: "1.2.840.113549.1.1.10",
  ec: "1.2.840.10045.2.1",
  dsa: "1.2.840.10040.4.1",
  ed25519: "1.3.101.112",
  x25519: "1.3.101.110",
  x448: "1.3.101.111",
  ed448: "1.3.101.113",
};

/** Named-curve families phpseclib knows (SEC 2, X9.62 prime, brainpool): they load, but only nistp* have an OpenSSH form. */
const OTHER_CURVE_PREFIXES = ["1.3.132.0.", "1.2.840.10045.3.", "1.3.36.3.3.2.8.1.1."];

type ParsedKey =
  | { kind: "ed25519"; pub: Uint8Array | null; pkcs8: Uint8Array | null }
  | { kind: "ecdsa"; curve: Curve; pub: Uint8Array | null; pkcs8: Uint8Array | null }
  | { kind: "rsa"; n: bigint; e: bigint }
  | { kind: "dsa"; p: bigint; q: bigint; g: bigint; y: bigint }
  | { kind: "unsupported" };

function fail(): never {
  throw new SshKeyError();
}

function parsePrivateKey(input: string): ParsedKey {
  const text = phpTrim(input);
  if (text === "") fail();
  const openssh = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(text);
  if (openssh) return parseOpenSsh(b64decode(openssh[1] ?? ""));
  const pem = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END ([A-Z0-9 ]+)-----/.exec(text);
  if (pem) {
    const label = pem[1] ?? "";
    const body = pem[2] ?? "";
    if (/ENCRYPTED|PUBLIC|CERTIFICATE/.test(label) || /Proc-Type:\s*4,ENCRYPTED/i.test(body)) fail();
    const base64 = body
      .split(/\r?\n/)
      .filter((line) => !line.includes(":"))
      .join("");
    return parseDer(b64decode(base64));
  }
  if (text.startsWith("PuTTY-User-Key-File-")) return parsePpk(text);
  return parseDer(b64decode(text));
}

async function publicBlobOrNull(privateKey: string): Promise<Uint8Array | null> {
  try {
    return (await sshPublicKey(parsePrivateKey(privateKey))).blob;
  } catch {
    return null;
  }
}

async function sshPublicKey(key: ParsedKey): Promise<{ type: string; blob: Uint8Array }> {
  switch (key.kind) {
    case "ed25519": {
      let pub = key.pub;
      if (!pub) {
        if (!key.pkcs8) fail();
        const jwk = await importJwk(key.pkcs8, { name: "Ed25519" });
        pub = b64urlDecode(jwk.x);
      }
      return { type: "ssh-ed25519", blob: sshConcat(sshString("ssh-ed25519"), sshString(pub)) };
    }
    case "ecdsa": {
      const info = CURVES[key.curve];
      let pub = key.pub;
      if (!pub) {
        if (!key.pkcs8) fail();
        const jwk = await importJwk(key.pkcs8, { name: "ECDSA", namedCurve: info.jwk });
        pub = sshConcat(new Uint8Array([4]), padLeft(b64urlDecode(jwk.x), info.size), padLeft(b64urlDecode(jwk.y), info.size));
      }
      const type = `ecdsa-sha2-${key.curve}`;
      return { type, blob: sshConcat(sshString(type), sshString(key.curve), sshString(pub)) };
    }
    case "rsa":
      return { type: "ssh-rsa", blob: rsaBlob(key.e, key.n) };
    case "dsa":
      return { type: "ssh-dss", blob: sshConcat(sshString("ssh-dss"), mpint(key.p), mpint(key.q), mpint(key.g), mpint(key.y)) };
    case "unsupported":
      throw new SshKeyError(MSG_UNSUPPORTED);
  }
}

function rsaBlob(e: bigint, n: bigint): Uint8Array {
  return sshConcat(sshString("ssh-rsa"), mpint(e), mpint(n));
}

// ---------------------------------------------------------------- OpenSSH and PuTTY

function parseOpenSsh(bytes: Uint8Array): ParsedKey {
  const magic = utf8("openssh-key-v1\0");
  if (bytes.length < magic.length || !magic.every((b, i) => bytes[i] === b)) fail();
  const r = new SshReader(bytes.subarray(magic.length));
  const cipher = r.text();
  const kdf = r.text();
  r.string(); // kdf options
  if (cipher !== "none" || kdf !== "none" || r.u32() !== 1) fail();
  const pubBlob = r.string();
  const p = new SshReader(r.string());
  if (p.u32() !== p.u32()) fail();
  const type = p.text();
  const key = parsePublicBlob(pubBlob, type);
  // The private fields must be there and well formed, as phpseclib reads them.
  switch (type) {
    case "ssh-ed25519":
      if (p.string().length !== 32 || p.string().length !== 64) fail();
      break;
    case "ssh-rsa":
      for (let i = 0; i < 6; i++) p.mpint();
      break;
    case "ssh-dss":
      for (let i = 0; i < 5; i++) p.mpint();
      break;
    default:
      p.string();
      p.string();
      p.mpint();
  }
  p.string(); // comment
  return key;
}

function parsePpk(text: string): ParsedKey {
  const lines = text.split(/\r?\n/);
  const header = /^PuTTY-User-Key-File-([23]): (\S+)$/.exec(lines[0] ?? "");
  if (!header) fail();
  const field = (name: string): { value: string; index: number } => {
    const index = lines.findIndex((l) => l.startsWith(`${name}: `));
    if (index < 0) fail();
    return { value: (lines[index] ?? "").slice(name.length + 2).trim(), index };
  };
  if (field("Encryption").value !== "none") fail();
  const pub = field("Public-Lines");
  const count = Number(pub.value);
  if (!Number.isInteger(count) || count < 1) fail();
  field("Private-Lines");
  field("Private-MAC");
  const blob = b64decode(lines.slice(pub.index + 1, pub.index + 1 + count).join(""));
  return parsePublicBlob(blob, header[2] ?? "");
}

function parsePublicBlob(blob: Uint8Array, expectedType: string): ParsedKey {
  const r = new SshReader(blob);
  const type = r.text();
  if (type !== expectedType) fail();
  let key: ParsedKey;
  switch (type) {
    case "ssh-ed25519": {
      const pub = r.string();
      if (pub.length !== 32) fail();
      key = { kind: "ed25519", pub, pkcs8: null };
      break;
    }
    case "ecdsa-sha2-nistp256":
    case "ecdsa-sha2-nistp384":
    case "ecdsa-sha2-nistp521": {
      const curve = type.slice("ecdsa-sha2-".length) as Curve;
      if (r.text() !== curve) fail();
      const pub = r.string();
      if (pub.length !== 1 + 2 * CURVES[curve].size || pub[0] !== 4) fail();
      key = { kind: "ecdsa", curve, pub, pkcs8: null };
      break;
    }
    case "ssh-rsa": {
      const e = r.mpint();
      key = { kind: "rsa", e, n: r.mpint() };
      break;
    }
    case "ssh-dss":
      key = { kind: "dsa", p: r.mpint(), q: r.mpint(), g: r.mpint(), y: r.mpint() };
      break;
    default:
      fail();
  }
  if (!r.done()) fail();
  return key;
}

class SshReader {
  private off = 0;
  constructor(private readonly buf: Uint8Array) {}
  u32(): number {
    if (this.off + 4 > this.buf.length) fail();
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.off, 4).getUint32(0);
    this.off += 4;
    return v;
  }
  string(): Uint8Array {
    const len = this.u32();
    if (this.off + len > this.buf.length) fail();
    const v = this.buf.subarray(this.off, this.off + len);
    this.off += len;
    return v;
  }
  text(): string {
    return new TextDecoder().decode(this.string());
  }
  mpint(): bigint {
    const v = this.string();
    if (v.length > 0 && ((v[0] ?? 0) & 0x80) !== 0) fail(); // negative
    return bytesToBigInt(v);
  }
  done(): boolean {
    return this.off === this.buf.length;
  }
}

// ---------------------------------------------------------------- DER (PKCS#1, SEC1, PKCS#8, DSA)

interface Tlv {
  tag: number;
  body: Uint8Array;
  end: number;
}

function readTlv(b: Uint8Array, off: number): Tlv {
  const tag = b[off];
  let len = b[off + 1];
  if (tag === undefined || len === undefined) fail();
  let p = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) fail();
    len = 0;
    for (let i = 0; i < n; i++) {
      const byte = b[p++];
      if (byte === undefined) fail();
      len = len * 256 + byte;
    }
  }
  if (p + len > b.length) fail();
  return { tag, body: b.subarray(p, p + len), end: p + len };
}

function readOnly(b: Uint8Array): Tlv {
  const t = readTlv(b, 0);
  if (t.end !== b.length) fail();
  return t;
}

function children(b: Uint8Array): Tlv[] {
  const out: Tlv[] = [];
  for (let off = 0; off < b.length; ) {
    const t = readTlv(b, off);
    out.push(t);
    off = t.end;
  }
  return out;
}

function intOf(t: Tlv | undefined): bigint {
  if (!t || t.tag !== 0x02 || t.body.length === 0) fail();
  if (((t.body[0] ?? 0) & 0x80) !== 0) fail(); // negative
  return bytesToBigInt(t.body);
}

function oidOf(t: Tlv | undefined): string {
  if (!t || t.tag !== 0x06 || t.body.length === 0) fail();
  const parts: number[] = [];
  let v = 0;
  for (const byte of t.body) {
    v = v * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      parts.push(v);
      v = 0;
    }
  }
  const first = parts.shift() ?? 0;
  const head = first < 40 ? [0, first] : first < 80 ? [1, first - 40] : [2, first - 80];
  return [...head, ...parts].join(".");
}

function parseDer(der: Uint8Array): ParsedKey {
  const top = readOnly(der);
  if (top.tag !== 0x30) fail();
  const k = children(top.body);
  const [k0, k1, k2] = k;
  if (k0?.tag === 0x02 && k1?.tag === 0x30 && k2?.tag === 0x04) return parsePkcs8(k);
  if (k.length >= 9 && k.every((t) => t.tag === 0x02) && intOf(k0) <= 1n) {
    return { kind: "rsa", n: intOf(k1), e: intOf(k2) };
  }
  if (k.length === 6 && k.every((t) => t.tag === 0x02) && intOf(k0) === 0n) {
    return { kind: "dsa", p: intOf(k1), q: intOf(k2), g: intOf(k[3]), y: intOf(k[4]) };
  }
  if (k0?.tag === 0x02 && intOf(k0) === 1n && k1?.tag === 0x04) return parseSec1(k, null);
  fail();
}

/** SEC1 ECPrivateKey: version 1, d, [0] curve OID, [1] public point. */
function parseSec1(k: Tlv[], algCurve: Tlv | null): ParsedKey {
  const d = k[1]?.body;
  if (!d || d.length === 0) fail();
  const params = k.find((t) => t.tag === 0xa0);
  const curveTlv = params ? readOnly(params.body) : algCurve;
  if (!curveTlv) fail();
  if (curveTlv.tag === 0x30) return { kind: "unsupported" }; // explicit curve parameters
  const oid = oidOf(curveTlv);
  const curve = (Object.keys(CURVES) as Curve[]).find((c) => CURVES[c].oid === oid);
  if (!curve) {
    if (OTHER_CURVE_PREFIXES.some((p) => oid.startsWith(p))) return { kind: "unsupported" };
    fail();
  }
  let pub: Uint8Array | null = null;
  const pubTlv = k.find((t) => t.tag === 0xa1);
  if (pubTlv) {
    const bits = readOnly(pubTlv.body);
    if (bits.tag !== 0x03 || bits.body[0] !== 0) fail();
    pub = bits.body.subarray(1);
    if (pub.length !== 1 + 2 * CURVES[curve].size || pub[0] !== 4) fail();
  }
  const size = CURVES[curve].size;
  const pkcs8 = tlv(
    0x30,
    derInt(0n),
    tlv(0x30, derOid(OID.ec), derOid(CURVES[curve].oid)),
    tlv(0x04, tlv(0x30, derInt(1n), tlv(0x04, padLeft(d, size)))),
  );
  return { kind: "ecdsa", curve, pub, pkcs8 };
}

function parsePkcs8(k: Tlv[]): ParsedKey {
  const version = intOf(k[0]);
  if (version > 1n) fail();
  const alg = children(k[1]?.body ?? fail());
  const oid = oidOf(alg[0]);
  const inner = k[2]?.body ?? fail();
  switch (oid) {
    case OID.rsa:
    case OID.rsaPss: {
      const key = parseDer(inner);
      if (key.kind !== "rsa") fail();
      return key;
    }
    case OID.ec: {
      const sec1 = readOnly(inner);
      if (sec1.tag !== 0x30) fail();
      const ik = children(sec1.body);
      if (intOf(ik[0]) !== 1n || ik[1]?.tag !== 0x04) fail();
      return parseSec1(ik, alg[1] ?? null);
    }
    case OID.ed25519: {
      const seed = readOnly(inner);
      if (seed.tag !== 0x04 || seed.body.length !== 32) fail();
      let pub: Uint8Array | null = null;
      const pubTlv = k.find((t) => t.tag === 0x81 || t.tag === 0xa1);
      if (pubTlv) {
        const bits = pubTlv.tag === 0x81 ? pubTlv.body : readOnly(pubTlv.body).body;
        if (bits.length !== 33 || bits[0] !== 0) fail();
        pub = bits.subarray(1);
      }
      const pkcs8 = tlv(0x30, derInt(0n), tlv(0x30, derOid(OID.ed25519)), tlv(0x04, tlv(0x04, seed.body)));
      return { kind: "ed25519", pub, pkcs8 };
    }
    case OID.ed448:
    case OID.x25519:
    case OID.x448:
      return { kind: "unsupported" };
    case OID.dsa: {
      const params = children(alg[1]?.tag === 0x30 ? alg[1].body : fail());
      const p = intOf(params[0]);
      const q = intOf(params[1]);
      const g = intOf(params[2]);
      const x = intOf(readOnly(inner));
      return { kind: "dsa", p, q, g, y: modPow(g, x, p) };
    }
    default:
      fail();
  }
}

function derLength(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = sshConcat(...parts);
  return sshConcat(new Uint8Array([tag]), derLength(body.length), body);
}

function derInt(v: bigint): Uint8Array {
  return tlv(0x02, twosComplement(v));
}

function derOid(oid: string): Uint8Array {
  const [a = 0, b = 0, ...rest] = oid.split(".").map(Number);
  const out: number[] = [a * 40 + b];
  for (const n of rest) {
    const groups: number[] = [];
    for (let v = n; ; v = Math.floor(v / 128)) {
      groups.unshift((v & 0x7f) | (groups.length ? 0x80 : 0));
      if (v < 128) break;
    }
    out.push(...groups);
  }
  return tlv(0x06, new Uint8Array(out));
}

// ---------------------------------------------------------------- bytes and numbers

function bytesToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}

function bigIntToBytes(v: bigint): Uint8Array {
  if (v === 0n) return new Uint8Array(0);
  let hex = v.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
}

/** Minimal unsigned value with a leading 0x00 when the high bit is set (DER INTEGER and SSH mpint). */
function twosComplement(v: bigint): Uint8Array {
  const b = bigIntToBytes(v);
  if (b.length === 0) return new Uint8Array([0]);
  return ((b[0] ?? 0) & 0x80) !== 0 ? sshConcat(new Uint8Array([0]), b) : b;
}

function mpint(v: bigint): Uint8Array {
  return sshString(v === 0n ? new Uint8Array(0) : twosComplement(v));
}

function bitLength(v: bigint): number {
  return v === 0n ? 0 : v.toString(2).length;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod <= 1n) fail();
  let result = 1n;
  let b = base % mod;
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
  }
  return result;
}

function padLeft(b: Uint8Array, size: number): Uint8Array {
  if (b.length >= size) return b.subarray(b.length - size);
  const out = new Uint8Array(size);
  out.set(b, size - b.length);
  return out;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

function sshString(v: string | Uint8Array): Uint8Array {
  const b = typeof v === "string" ? utf8(v) : v;
  return sshConcat(u32(b.length), b);
}

function sshConcat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function b64encode(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s);
}

function b64decode(text: string): Uint8Array {
  const s = text.replace(/\s+/g, "");
  if (s.length === 0 || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) fail();
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function b64urlDecode(v: string | undefined): Uint8Array {
  if (!v) fail();
  const s = v.replace(/-/g, "+").replace(/_/g, "/");
  return b64decode(s + "=".repeat((4 - (s.length % 4)) % 4));
}

/** PHP chunk_split: every chunk, the last one included, ends with `end`. */
function chunk(s: string, size: number, end: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += size) out += s.slice(i, i + size) + end;
  return out;
}

// ---------------------------------------------------------------- Web Crypto

async function exportJwk(key: CryptoKey): Promise<JsonWebKey> {
  const jwk = await crypto.subtle.exportKey("jwk", key);
  if (jwk instanceof ArrayBuffer) fail();
  return jwk;
}

async function importJwk(pkcs8: Uint8Array, algorithm: { name: string; namedCurve?: string }): Promise<JsonWebKey> {
  try {
    const key = await crypto.subtle.importKey("pkcs8", new Uint8Array(pkcs8), algorithm, true, ["sign"]);
    return await exportJwk(key);
  } catch {
    fail();
  }
}

// ---------------------------------------------------------------- MD5 (RFC 1321; Web Crypto has none)

const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);

function md5(msg: Uint8Array): Uint8Array {
  const total = Math.ceil((msg.length + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const view = new DataView(buf.buffer);
  const bits = msg.length * 8;
  view.setUint32(total - 8, bits >>> 0, true);
  view.setUint32(total - 4, Math.floor(bits / 2 ** 32), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476;
  for (let off = 0; off < total; off += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + (MD5_K[i] ?? 0) + view.getUint32(off + g * 4, true)) | 0;
      const s = MD5_S[(i >> 4) * 4 + (i % 4)] ?? 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((f << s) | (f >>> (32 - s)))) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v >>> 0, true));
  return out;
}

// ---------------------------------------------------------------- shared with src/ssl (DP-48)

/** The DER, byte and Web Crypto helpers above, for the X.509 code in src/ssl/. Readers throw SshKeyError. */
export {
  parsePrivateKey,
  CURVES,
  OID,
  readTlv,
  readOnly,
  children,
  intOf,
  oidOf,
  tlv,
  derInt,
  derOid,
  bytesToBigInt,
  padLeft,
  utf8,
  sshConcat as concatBytes,
  b64encode,
  b64decode,
  b64urlDecode,
  chunk,
  exportJwk,
  importJwk,
  type ParsedKey,
  type Curve,
  type Tlv,
};
