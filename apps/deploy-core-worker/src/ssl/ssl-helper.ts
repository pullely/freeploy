// Derived from coollabsio/coolify@91b7e3e:app/Helpers/SslHelper.php (Apache-2.0), modified:
// what Coolify asks of PHP's openssl extension (openssl_pkey_new, openssl_csr_new,
// openssl_csr_sign with its generated openssl.cnf), built here as DER with Web Crypto.
//
// generateSslCertificate() makes the certificate SslHelper::generateSslCertificate()
// makes, for a server's CA and for a leaf (a database's server certificate):
//
//   key          EC, secp521r1 for a CA and prime256v1 for a leaf; exported as
//                openssl_pkey_export does on OpenSSL 3: PKCS#8 "PRIVATE KEY", the inner
//                ECPrivateKey with its public key and without curve parameters
//   subject      CN (UTF8String), O = Coolify (UTF8String), C = XX (PrintableString),
//                ST = Default (UTF8String), in the order of openssl_csr_new's array
//   issuer       the CA certificate's subject, or the subject itself (self-signed)
//   serial       random_int(1, PHP_INT_MAX): a positive 63-bit integer
//   validity     now … now + validityDays × 86400 s (UTCTime before 2050)
//   extensions   the [ v3_req ] section, in its order:
//                  CA    basicConstraints critical CA:TRUE pathlen:0; keyUsage critical
//                        keyCertSign, cRLSign; subjectKeyIdentifier hash
//                  leaf  basicConstraints critical CA:FALSE; keyUsage critical
//                        digitalSignature, keyAgreement; extendedKeyUsage serverAuth,
//                        clientAuth; subjectKeyIdentifier hash; subjectAltName
//                no authorityKeyIdentifier: the section has none
//   signature    ecdsa-with-SHA512, by the CA key, or the certificate's own key
//   output       PEM, 64-character lines (openssl_x509_export)
//
// The organization and the CA's common name stay Coolify's: the certificate is written
// to the server and mounted into containers (design §1.2: nothing on the server changes).
//
// Storing the certificate (the delete and the create of the same PHP function) is the
// caller's part: see ssl/ca-certificate.ts. The file storages of a database's
// certificate (server.crt, server.key, server.pem) belong to the database pages.
//
// Not reproduced: OpenSSL's config-file syntax applied to the common name and the
// alternative names ("$" expansion, "#" comments, quotes), the otherName, dirName and
// RID alternative names, and a CA key that is not an EC key.
import { b64urlDecode, concatBytes, CURVES, derInt, derOid, exportJwk, OID, padLeft, parsePrivateKey, tlv, utf8, b64encode, type Curve } from "../keys/ssh-keys.js";
import { isIpv4, parseIpv6 } from "../servers/ip.js";
import { certificateMatchesPrivateKey, exportCertificatePem, parseCertificate, pemEncode, readCertificatePem } from "./x509.js";

const DEFAULT_ORGANIZATION_NAME = "Coolify";
const DEFAULT_COUNTRY_NAME = "XX";
const DEFAULT_STATE_NAME = "Default";

/** Server::generateCaCertificate(), InstallDocker and CaCertificate\Show: the CA's common name and validity. */
export const CA_COMMON_NAME = "Coolify CA Certificate";
export const CA_VALIDITY_DAYS = 10 * 365;

/** config('constants.coolify.base_config_path'): a path on the server, not brand (design §1.2). */
const BASE_CONFIG_PATH = "/data/coolify";

const ECDSA_WITH_SHA512 = "1.2.840.10045.4.3.4";
const EXT = {
  subjectKeyIdentifier: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  extendedKeyUsage: "2.5.29.37",
};
const SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";

export class SslError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SslError";
  }
}

export interface GenerateSslCertificateOptions {
  commonName: string;
  /** "DNS:name", "IP:address", "email:address" or "URI:uri" entries. */
  subjectAlternativeNames?: string[];
  validityDays?: number;
  /** The CA certificate (PEM) whose subject becomes the issuer. */
  caCert?: string | null;
  /** The CA private key (PEM) that signs; without it the certificate signs itself. */
  caKey?: string | null;
  isCaCertificate?: boolean;
  /** $server->getIp of the server the certificate is for: a leaf gets it as an IP or DNS alternative name. */
  serverIp?: string | null;
  /** The signing time (default: now). */
  now?: Date;
}

export interface GeneratedSslCertificate {
  /** PEM certificate and PEM private key, as Coolify stores them (ssl_certificate, ssl_private_key). */
  sslCertificate: string;
  sslPrivateKey: string;
  commonName: string;
  /** What Coolify stores as subject_alternative_names: for a leaf, with "DNS:<commonName>" first. */
  subjectAlternativeNames: string[];
  /** CarbonImmutable::now()->addDays($validityDays), which is also the certificate's notAfter. */
  validUntil: Date;
  isCaCertificate: boolean;
}

// ---------------------------------------------------------------- DER pieces

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const sequence = (...parts: Uint8Array[]): Uint8Array => tlv(0x30, ...parts);
const utf8String = (text: string): Uint8Array => tlv(0x0c, utf8(text));
const printableString = (text: string): Uint8Array => tlv(0x13, utf8(text));

function attribute(oid: string, value: Uint8Array): Uint8Array {
  return tlv(0x31, sequence(derOid(oid), value));
}

/** openssl_csr_new(['commonName' => …, 'organizationName' => …, 'countryName' => …, 'stateOrProvinceName' => …]). */
function subjectName(commonName: string): Uint8Array {
  return sequence(
    attribute("2.5.4.3", utf8String(commonName)),
    attribute("2.5.4.10", utf8String(DEFAULT_ORGANIZATION_NAME)),
    attribute("2.5.4.6", printableString(DEFAULT_COUNTRY_NAME)),
    attribute("2.5.4.8", utf8String(DEFAULT_STATE_NAME)),
  );
}

/** ASN1_TIME: UTCTime for 1950–2049, GeneralizedTime otherwise. */
function derTime(date: Date): Uint8Array {
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  const year = date.getUTCFullYear();
  const rest = `${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return year >= 1950 && year < 2050 ? tlv(0x17, utf8(p(year % 100) + rest)) : tlv(0x18, utf8(p(year, 4) + rest));
}

function extension(oid: string, critical: boolean, value: Uint8Array): Uint8Array {
  return critical ? sequence(derOid(oid), tlv(0x01, bytes(0xff)), tlv(0x04, value)) : sequence(derOid(oid), tlv(0x04, value));
}

/**
 * One "TYPE:value" entry as a GeneralName, as OpenSSL reads "TYPE.n = value"
 * of a [ subject_alt_names ] section.
 */
function generalName(entry: string): Uint8Array {
  const colon = entry.indexOf(":");
  const type = colon < 0 ? entry : entry.slice(0, colon);
  const value = colon < 0 ? "" : entry.slice(colon + 1).trim();
  if (value === "") throw new SslError(`Invalid subject alternative name: ${entry}`);
  switch (type) {
    case "email":
      return tlv(0x81, utf8(value));
    case "DNS":
      return tlv(0x82, utf8(value));
    case "URI":
      return tlv(0x86, utf8(value));
    case "IP": {
      if (isIpv4(value)) return tlv(0x87, Uint8Array.from(value.split("."), Number));
      const words = parseIpv6(value);
      if (!words) throw new SslError(`Invalid IP address in subject alternative name: ${value}`);
      return tlv(0x87, Uint8Array.from(words.flatMap((w) => [w >> 8, w & 0xff])));
    }
    default:
      throw new SslError(`Unsupported subject alternative name type: ${type}`);
  }
}

/** PHP's array_unique() on strings: the first of each value, in order. */
const unique = (values: string[]): string[] => [...new Set(values)];

// ---------------------------------------------------------------- keys

interface EcKey {
  curve: Curve;
  privateKey: CryptoKey;
  /** The uncompressed point (0x04, x, y). */
  point: Uint8Array;
  /** The private scalar, padded to the field size. */
  d: Uint8Array;
}

function algorithm(curve: Curve): { name: "ECDSA"; namedCurve: string } {
  return { name: "ECDSA", namedCurve: CURVES[curve].jwk };
}

/** openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => …]). */
async function newEcKey(curve: Curve): Promise<EcKey> {
  const pair = await crypto.subtle.generateKey(algorithm(curve), true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new SslError("Failed to generate private key");
  const jwk = await exportJwk(pair.privateKey);
  const size = CURVES[curve].size;
  return {
    curve,
    privateKey: pair.privateKey,
    point: concatBytes(bytes(4), padLeft(b64urlDecode(jwk.x), size), padLeft(b64urlDecode(jwk.y), size)),
    d: padLeft(b64urlDecode(jwk.d), size),
  };
}

/**
 * openssl_pkey_export() of an EC key on OpenSSL 3 (PEM_write_bio_PrivateKey):
 * PKCS#8, whose ECPrivateKey carries the public key and leaves the curve to
 * the AlgorithmIdentifier.
 */
function exportPrivateKeyPem(key: EcKey): string {
  const ecPrivateKey = sequence(derInt(1n), tlv(0x04, key.d), tlv(0xa1, tlv(0x03, bytes(0), key.point)));
  return pemEncode("PRIVATE KEY", sequence(derInt(0n), sequence(derOid(OID.ec), derOid(CURVES[key.curve].oid)), tlv(0x04, ecPrivateKey)));
}

function subjectPublicKeyInfo(key: EcKey): Uint8Array {
  return sequence(sequence(derOid(OID.ec), derOid(CURVES[key.curve].oid)), tlv(0x03, bytes(0), key.point));
}

/** The CA private key ($caKey) as a signing key. */
async function importSigningKey(pem: string): Promise<{ curve: Curve; privateKey: CryptoKey }> {
  const key = parsePrivateKey(pem);
  if (key.kind !== "ecdsa" || !key.pkcs8) throw new SslError("The CA private key is not an EC key in PEM format");
  const privateKey = await crypto.subtle.importKey("pkcs8", new Uint8Array(key.pkcs8), algorithm(key.curve), false, ["sign"]);
  return { curve: key.curve, privateKey };
}

/** ECDSA with SHA-512 over `data`, as the DER Ecdsa-Sig-Value (Web Crypto answers r ‖ s). */
async function ecdsaSha512(key: { curve: Curve; privateKey: CryptoKey }, data: Uint8Array): Promise<Uint8Array> {
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-512" }, key.privateKey, new Uint8Array(data)));
  const size = CURVES[key.curve].size;
  const int = (b: Uint8Array) => derInt(b.reduce((v, byte) => (v << 8n) | BigInt(byte), 0n));
  return sequence(int(raw.subarray(0, size)), int(raw.subarray(size)));
}

/** random_int(1, PHP_INT_MAX). */
function randomSerial(): bigint {
  const b = crypto.getRandomValues(new Uint8Array(8));
  b[0] = (b[0] ?? 0) & 0x7f;
  const serial = b.reduce((v, byte) => (v << 8n) | BigInt(byte), 0n);
  return serial === 0n ? 1n : serial;
}

// ---------------------------------------------------------------- SslHelper

/**
 * SslHelper::generateSslCertificate(), up to the certificate and its key; the
 * answer is what Coolify then stores. Throws SslError with Coolify's
 * "SSL Certificate generation failed: …" prefix.
 */
export async function generateSslCertificate(options: GenerateSslCertificateOptions): Promise<GeneratedSslCertificate> {
  const { commonName } = options;
  const isCaCertificate = options.isCaCertificate ?? false;
  const validityDays = options.validityDays ?? 365;
  let subjectAlternativeNames = options.subjectAlternativeNames ?? [];
  try {
    // Electron clients such as MongoDB Compass (BoringSSL) cannot use a P-521 server key.
    const key = await newEcKey(isCaCertificate ? "nistp521" : "nistp256");
    const sslPrivateKey = exportPrivateKeyPem(key);

    const ip = options.serverIp ?? "";
    if (ip !== "" && ip !== "0" && !isCaCertificate) {
      const type = isIpv4(ip) || parseIpv6(ip) ? "IP" : "DNS";
      subjectAlternativeNames = unique([...subjectAlternativeNames, `${type}:${ip}`]);
    }

    const extensions: Uint8Array[] = [];
    if (isCaCertificate) {
      // basicConstraints = critical, CA:TRUE, pathlen:0; keyUsage = critical, keyCertSign, cRLSign
      extensions.push(extension(EXT.basicConstraints, true, sequence(tlv(0x01, bytes(0xff)), derInt(0n))));
      extensions.push(extension(EXT.keyUsage, true, tlv(0x03, bytes(1, 0x06))));
    } else {
      // basicConstraints = critical, CA:FALSE; keyUsage = critical, digitalSignature, keyAgreement
      extensions.push(extension(EXT.basicConstraints, true, sequence()));
      extensions.push(extension(EXT.keyUsage, true, tlv(0x03, bytes(3, 0x88))));
      // extendedKeyUsage = serverAuth, clientAuth
      extensions.push(extension(EXT.extendedKeyUsage, false, sequence(derOid(SERVER_AUTH), derOid(CLIENT_AUTH))));
      subjectAlternativeNames = unique([`DNS:${commonName}`, ...subjectAlternativeNames]);
    }
    // subjectKeyIdentifier = hash: SHA-1 of the public key bits.
    const keyId = new Uint8Array(await crypto.subtle.digest("SHA-1", new Uint8Array(key.point)));
    extensions.push(extension(EXT.subjectKeyIdentifier, false, tlv(0x04, keyId)));
    if (!isCaCertificate) extensions.push(extension(EXT.subjectAltName, false, sequence(...subjectAlternativeNames.map(generalName))));

    const subject = subjectName(commonName);
    let issuer = subject;
    if (options.caCert) {
      const ca = readCertificatePem(options.caCert);
      if (!ca) throw new SslError("Failed to sign certificate: the CA certificate cannot be read");
      // openssl_csr_sign() refuses a signing key that is not the CA certificate's.
      if (!options.caKey || !(await certificateMatchesPrivateKey(ca, options.caKey))) {
        throw new SslError("Failed to sign certificate: private key does not correspond to signing cert");
      }
      issuer = parseCertificate(ca).subjectDer;
    }
    const signer = options.caKey ? await importSigningKey(options.caKey) : key;

    // X509_gmtime_adj(notBefore, 0) and (notAfter, 60 * 60 * 24 * days).
    const notBefore = new Date(Math.floor((options.now ?? new Date()).getTime() / 1000) * 1000);
    const validUntil = new Date(notBefore.getTime() + validityDays * 86_400_000);
    const signatureAlgorithm = sequence(derOid(ECDSA_WITH_SHA512));
    const tbs = sequence(
      tlv(0xa0, derInt(2n)),
      derInt(randomSerial()),
      signatureAlgorithm,
      issuer,
      sequence(derTime(notBefore), derTime(validUntil)),
      subject,
      subjectPublicKeyInfo(key),
      tlv(0xa3, sequence(...extensions)),
    );
    const signature = await ecdsaSha512(signer, tbs);
    const certificate = sequence(tbs, signatureAlgorithm, tlv(0x03, bytes(0), signature));

    return { sslCertificate: exportCertificatePem(certificate), sslPrivateKey, commonName, subjectAlternativeNames, validUntil, isCaCertificate };
  } catch (e) {
    throw new SslError(`SSL Certificate generation failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Commands that write the CA certificate to the shared CA file on the server.
 *
 * The file is rewritten in place: containers bind-mount it, and a deleted or replaced file
 * leaves them with the old inode, which they cannot read (#6081). Only a directory that
 * Docker created at this path for a missing mount source is removed.
 */
export function caCertificateFileCommands(certificate: string): string[] {
  const caCertDirectory = `${BASE_CONFIG_PATH}/ssl`;
  const caCertFile = `${caCertDirectory}/coolify-ca.crt`;
  const base64Cert = b64encode(utf8(certificate));

  return [
    `mkdir -p ${caCertDirectory}`,
    `chown 9999:root ${caCertDirectory}`,
    `chmod 700 ${caCertDirectory}`,
    `find ${caCertDirectory} -mindepth 1 -maxdepth 1 -name coolify-ca.crt -type d -exec rm -rf {} +`,
    `echo '${base64Cert}' | base64 -d | tee ${caCertFile} > /dev/null`,
    `chmod 644 ${caCertFile}`,
  ];
}
