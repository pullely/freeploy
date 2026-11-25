// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Server/CaCertificate/Show.php (saveCaCertificate)
// and app/Helpers/SslHelper.php (Apache-2.0), modified: what Coolify asks of PHP's openssl
// extension (openssl_x509_read, openssl_x509_export, openssl_x509_check_private_key),
// re-implemented for Workers.
//
// X.509 reading on the DER helpers of keys/ssh-keys.ts plus Web Crypto. No node:crypto.
//
//   readCertificatePem        openssl_x509_read: the first certificate of a PEM text
//   exportCertificatePem      openssl_x509_export: PEM, 64-character lines, one final "\n"
//   parseCertificate          the fields the SSL code and its tests need
//   certificateMatchesPrivateKey   openssl_x509_check_private_key
//
// Known differences from OpenSSL: only DER is read (no BER indefinite lengths), a
// "file://" path is never read (PHP would open the file), and of the key types
// EVP_PKEY_eq compares, EC (P-256/384/521), RSA and Ed25519 are compared; any other
// key does not match.
import {
  b64encode,
  b64urlDecode,
  bytesToBigInt,
  chunk,
  concatBytes,
  CURVES,
  importJwk,
  intOf,
  OID,
  oidOf,
  padLeft,
  parsePrivateKey,
  readTlv,
  type Tlv,
} from "../keys/ssh-keys.js";

export class X509Error extends Error {
  constructor(message = "Invalid certificate.") {
    super(message);
    this.name = "X509Error";
  }
}

function fail(): never {
  throw new X509Error();
}

// ---------------------------------------------------------------- PEM

/** PEM as OpenSSL writes it: 64-character base64 lines, "\n" line ends, the END line included. */
export function pemEncode(label: string, der: Uint8Array): string {
  return `-----BEGIN ${label}-----\n${chunk(b64encode(der), 64, "\n")}-----END ${label}-----\n`;
}

/** openssl_x509_export(). */
export function exportCertificatePem(der: Uint8Array): string {
  return pemEncode("CERTIFICATE", der);
}

/** The names PEM_read_bio_X509 takes for a certificate. */
const CERTIFICATE_LABELS = ["CERTIFICATE", "X509 CERTIFICATE", "TRUSTED CERTIFICATE"];

/** OpenSSL drops trailing whitespace and control characters of each PEM line. */
const stripLineEnd = (line: string): string => line.replace(/[\x00-\x20]+$/, "");

/**
 * openssl_x509_read() for a PEM text: the DER of the first certificate block,
 * or null where PHP returns false. As OpenSSL's PEM reader: text before the
 * block and blocks of another kind are skipped, the BEGIN line must start its
 * line, CRLF line ends are fine, and what follows the block is ignored.
 */
export function readCertificatePem(text: string): Uint8Array | null {
  const lines = text.split("\n").map(stripLineEnd);
  for (let i = 0; i < lines.length; i++) {
    const begin = /^-----BEGIN (.+)-----$/.exec(lines[i] ?? "");
    if (!begin) continue;
    const label = begin[1] ?? "";
    const end = lines.indexOf(`-----END ${label}-----`, i + 1);
    if (end < 0) return null;
    if (!CERTIFICATE_LABELS.includes(label)) {
      i = end;
      continue;
    }
    let body = lines.slice(i + 1, end);
    // RFC 1421 headers ("Proc-Type: …") end at the first empty line.
    if (body.some((l) => l.includes(":"))) body = body.slice(body.indexOf("") + 1);
    const base64 = body.join("");
    if (base64 === "" || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
    try {
      return parseCertificate(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))).der;
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------- DER

interface Item extends Tlv {
  /** The whole element: tag, length and body. */
  raw: Uint8Array;
}

function itemAt(b: Uint8Array, off: number): Item {
  try {
    const t = readTlv(b, off);
    return { ...t, raw: b.subarray(off, t.end) };
  } catch {
    fail();
  }
}

function items(b: Uint8Array): Item[] {
  const out: Item[] = [];
  for (let off = 0; off < b.length; ) {
    const t = itemAt(b, off);
    out.push(t);
    off = t.end;
  }
  return out;
}

function expect(t: Item | undefined, tag: number): Item {
  if (!t || t.tag !== tag) fail();
  return t;
}

function oid(t: Item | undefined): string {
  try {
    return oidOf(t);
  } catch {
    fail();
  }
}

/** The bytes of a BIT STRING with no unused bits. */
function bitString(t: Item | undefined): Uint8Array {
  const b = expect(t, 0x03).body;
  if (b.length === 0 || b[0] !== 0) fail();
  return b.subarray(1);
}

/** UTCTime (YYMMDDHHMMSSZ, 1950–2049) or GeneralizedTime (YYYYMMDDHHMMSSZ); null when it is neither. */
function timeOf(t: Item | undefined): Date | null {
  if (!t || (t.tag !== 0x17 && t.tag !== 0x18)) fail();
  const text = new TextDecoder().decode(t.body);
  const m = t.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text) : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  if (!m) return null;
  const n = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const year = t.tag === 0x17 ? (n[0] < 50 ? 2000 + n[0] : 1900 + n[0]) : n[0];
  return new Date(Date.UTC(year, n[1] - 1, n[2], n[3], n[4], n[5]));
}

export interface NameAttribute {
  /** The attribute type, dotted ("2.5.4.3" is commonName). */
  oid: string;
  value: string;
  /** The ASN.1 string type of the value (0x0c UTF8String, 0x13 PrintableString, …). */
  tag: number;
}

function nameOf(t: Item): NameAttribute[] {
  const out: NameAttribute[] = [];
  for (const set of items(t.body)) {
    for (const pair of items(expect(set, 0x31).body)) {
      const [type, value] = items(expect(pair, 0x30).body);
      if (!value) fail();
      out.push({ oid: oid(type), value: new TextDecoder().decode(value.body), tag: value.tag });
    }
  }
  return out;
}

export interface CertificateExtension {
  oid: string;
  critical: boolean;
  /** The extension value: what the OCTET STRING holds. */
  value: Uint8Array;
}

export interface ParsedCertificate {
  /** The certificate itself, without anything that followed it. */
  der: Uint8Array;
  /** The TBSCertificate element: the bytes the signature covers. */
  tbs: Uint8Array;
  /** 0 is v1, 2 is v3. */
  version: number;
  serial: bigint;
  /** The signature algorithm, dotted ("1.2.840.10045.4.3.4" is ecdsa-with-SHA512). */
  signatureAlgorithm: string;
  /** The issuer and subject Name elements, and their attributes in order. */
  issuerDer: Uint8Array;
  subjectDer: Uint8Array;
  issuer: NameAttribute[];
  subject: NameAttribute[];
  notBefore: Date | null;
  notAfter: Date | null;
  /** SubjectPublicKeyInfo: the element, its algorithm, the algorithm's parameters element (or null) and the key bytes. */
  spki: Uint8Array;
  publicKeyAlgorithm: string;
  publicKeyParameters: Uint8Array | null;
  publicKey: Uint8Array;
  extensions: CertificateExtension[];
  /** The signature value (for ECDSA: the DER of SEQUENCE { r, s }). */
  signature: Uint8Array;
}

/**
 * A DER certificate's fields, checked against the Certificate template as
 * d2i_X509 checks it (RFC 5280 §4.1). Throws X509Error otherwise. Bytes after
 * the certificate are ignored, as d2i ignores them.
 */
export function parseCertificate(input: Uint8Array): ParsedCertificate {
  const cert = expect(itemAt(input, 0), 0x30);
  const [tbs, sigAlg, sig, ...extra] = items(cert.body);
  if (extra.length > 0) fail();
  const f = items(expect(tbs, 0x30).body);
  let version = 0;
  if (f[0]?.tag === 0xa0) {
    const [v, ...more] = items(f[0].body);
    if (more.length > 0 || expect(v, 0x02).body.length !== 1) fail();
    version = v?.body[0] ?? 0;
    f.shift();
  }
  const [serial, tbsAlg, issuer, validity, subject, spki, ...optional] = f;
  if (expect(serial, 0x02).body.length === 0) fail();
  oid(items(expect(tbsAlg, 0x30).body)[0]);
  const [notBefore, notAfter, ...moreTimes] = items(expect(validity, 0x30).body);
  if (moreTimes.length > 0) fail();
  const [keyAlg, key, ...moreKey] = items(expect(spki, 0x30).body);
  if (moreKey.length > 0) fail();
  const [keyOid, keyParams] = items(expect(keyAlg, 0x30).body);
  const extensions: CertificateExtension[] = [];
  // issuerUniqueID [1], subjectUniqueID [2], extensions [3], each at most once and in that order.
  let last = 0;
  for (const o of optional) {
    const n = o.tag === 0x81 || o.tag === 0xa1 ? 1 : o.tag === 0x82 || o.tag === 0xa2 ? 2 : o.tag === 0xa3 ? 3 : 0;
    if (n <= last) fail();
    last = n;
    if (n !== 3) continue;
    const [list, ...more] = items(o.body);
    if (more.length > 0) fail();
    for (const e of items(expect(list, 0x30).body)) {
      const parts = items(expect(e, 0x30).body);
      const critical = parts[1]?.tag === 0x01;
      const value = expect(parts[critical ? 2 : 1], 0x04);
      if (parts.length !== (critical ? 3 : 2)) fail();
      extensions.push({ oid: oid(parts[0]), critical: critical && parts[1]?.body[0] !== 0, value: value.body });
    }
  }
  return {
    der: cert.raw,
    tbs: expect(tbs, 0x30).raw,
    version,
    serial: bytesToBigInt(expect(serial, 0x02).body),
    signatureAlgorithm: oid(items(expect(sigAlg, 0x30).body)[0]),
    issuerDer: expect(issuer, 0x30).raw,
    subjectDer: expect(subject, 0x30).raw,
    issuer: nameOf(expect(issuer, 0x30)),
    subject: nameOf(expect(subject, 0x30)),
    notBefore: timeOf(notBefore),
    notAfter: timeOf(notAfter),
    spki: expect(spki, 0x30).raw,
    publicKeyAlgorithm: oid(keyOid),
    publicKeyParameters: keyParams ? keyParams.raw : null,
    publicKey: bitString(key),
    extensions,
    signature: bitString(sig),
  };
}

// ---------------------------------------------------------------- the key of a certificate

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * openssl_x509_check_private_key($certificate, $privateKey): whether the
 * certificate's public key is the private key's (EVP_PKEY_eq: the key type,
 * its parameters and the public key). False for anything that cannot be read.
 */
export async function certificateMatchesPrivateKey(certificate: string | Uint8Array, privateKeyPem: string): Promise<boolean> {
  try {
    const der = typeof certificate === "string" ? readCertificatePem(certificate) : certificate;
    if (!der) return false;
    const cert = parseCertificate(der);
    const key = parsePrivateKey(privateKeyPem);
    switch (key.kind) {
      case "ecdsa": {
        const curve = CURVES[key.curve];
        if (cert.publicKeyAlgorithm !== OID.ec || !cert.publicKeyParameters) return false;
        if (oidOf(readTlv(cert.publicKeyParameters, 0)) !== curve.oid) return false;
        let point = key.pub;
        if (!point) {
          if (!key.pkcs8) return false;
          const jwk = await importJwk(key.pkcs8, { name: "ECDSA", namedCurve: curve.jwk });
          point = concatBytes(new Uint8Array([4]), padLeft(b64urlDecode(jwk.x), curve.size), padLeft(b64urlDecode(jwk.y), curve.size));
        }
        const theirs = cert.publicKey;
        if (theirs[0] === 4) return sameBytes(theirs, point);
        // A compressed point: the x coordinate and the parity of y.
        if ((theirs[0] !== 2 && theirs[0] !== 3) || theirs.length !== 1 + curve.size) return false;
        const odd = ((point[point.length - 1] ?? 0) & 1) === 1;
        return sameBytes(theirs.subarray(1), point.subarray(1, 1 + curve.size)) && (theirs[0] === 3) === odd;
      }
      case "rsa": {
        if (cert.publicKeyAlgorithm !== OID.rsa) return false;
        const [n, e] = items(expect(itemAt(cert.publicKey, 0), 0x30).body);
        return intOf(n) === key.n && intOf(e) === key.e;
      }
      case "ed25519": {
        if (cert.publicKeyAlgorithm !== OID.ed25519) return false;
        let pub = key.pub;
        if (!pub) {
          if (!key.pkcs8) return false;
          pub = b64urlDecode((await importJwk(key.pkcs8, { name: "Ed25519" })).x);
        }
        return sameBytes(cert.publicKey, pub);
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}
