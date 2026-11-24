// The SSL library (DP-48): SslHelper::generateSslCertificate for a CA and for a
// leaf, and the X.509 reading saveCaCertificate needs, on Web Crypto. Checked
// against certificates made by Coolify's own PHP code (fixtures/ssl/php-*:
// PHP 8.3, OpenSSL 3.0, throwaway keys) and, when the binary is there, against
// the system `openssl`.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CA_COMMON_NAME, CA_VALIDITY_DAYS, caCertificateFileCommands, generateSslCertificate, SslError } from "@deploy-core-worker/ssl/ssl-helper";
import { certificateMatchesPrivateKey, exportCertificatePem, parseCertificate, readCertificatePem, X509Error, type ParsedCertificate } from "@deploy-core-worker/ssl/x509";

// Jest runs from tests/deploy-core-worker (its rootDir).
const dir = join(process.cwd(), "fixtures", "ssl");
const fixture = (name: string): string => readFileSync(join(dir, name), "utf8");
const PHP_CA = fixture("php-ca.crt");
const PHP_CA_KEY = fixture("php-ca.key.txt");
const PHP_LEAF = fixture("php-leaf.crt");
/** What the PHP leaf was made with: generateSslCertificate('postgres-abc', […], caCert, caKey). */
const LEAF_CN = "postgres-abc";
const LEAF_SANS = ["DNS:localhost", "IP:10.0.0.5", "IP:2001:db8::1", "DNS:postgres-abc"];

const NOW = new Date("2026-11-24T21:52:24.731Z");
const DAY = 86_400_000;
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const der = (pem: string): Uint8Array => new Uint8Array(Buffer.from(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64"));
const parsed = (pem: string): ParsedCertificate => parseCertificate(readCertificatePem(pem)!);

const OID = {
  ecdsaWithSha512: "1.2.840.10045.4.3.4",
  ecPublicKey: "1.2.840.10045.2.1",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extendedKeyUsage: "2.5.29.37",
  subjectKeyIdentifier: "2.5.29.14",
  subjectAltName: "2.5.29.17",
};
/** CN, O, C, ST with their ASN.1 string types: UTF8String (0x0c), and PrintableString (0x13) for the country. */
const subjectOf = (cn: string) => [
  { oid: "2.5.4.3", value: cn, tag: 0x0c },
  { oid: "2.5.4.10", value: "Coolify", tag: 0x0c },
  { oid: "2.5.4.6", value: "XX", tag: 0x13 },
  { oid: "2.5.4.8", value: "Default", tag: 0x0c },
];

/** The certificate's ECDSA signature checked with Web Crypto against the signer's public key. */
async function signedBy(cert: ParsedCertificate, signer: ParsedCertificate): Promise<boolean> {
  const curve = hex(signer.publicKeyParameters!) === "06052b81040023" ? { name: "P-521", size: 66 } : { name: "P-256", size: 32 };
  const key = await crypto.subtle.importKey("spki", new Uint8Array(signer.spki), { name: "ECDSA", namedCurve: curve.name }, false, ["verify"]);
  // SEQUENCE { INTEGER r, INTEGER s } → r ‖ s, each padded to the field size.
  const raw = new Uint8Array(curve.size * 2);
  let off = cert.signature[1]! & 0x80 ? 2 + (cert.signature[1]! & 0x7f) : 2;
  for (const at of [0, curve.size]) {
    const len = cert.signature[off + 1]!;
    let int = cert.signature.subarray(off + 2, off + 2 + len);
    if (int.length > curve.size && int[0] === 0) int = int.subarray(1);
    // A signature of another curve's size is not this signer's.
    if (int.length > curve.size) return false;
    raw.set(int, at + curve.size - int.length);
    off += 2 + len;
  }
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-512" }, key, raw, new Uint8Array(cert.tbs));
}

const pemLines = (pem: string, label: string) => {
  const lines = pem.split("\n");
  expect(lines[0]).toBe(`-----BEGIN ${label}-----`);
  expect(lines.at(-2)).toBe(`-----END ${label}-----`);
  expect(lines.at(-1)).toBe("");
  const body = lines.slice(1, -2);
  expect(body.slice(0, -1).every((l) => l.length === 64)).toBe(true);
  expect(body.at(-1)!.length).toBeGreaterThan(0);
  expect(body.at(-1)!.length).toBeLessThanOrEqual(64);
};

describe("generateSslCertificate: a CA", () => {
  const made = generateSslCertificate({ commonName: CA_COMMON_NAME, isCaCertificate: true, validityDays: CA_VALIDITY_DAYS, now: NOW });

  it("uses Coolify's name and ten years", () => {
    expect(CA_COMMON_NAME).toBe("Coolify CA Certificate");
    expect(CA_VALIDITY_DAYS).toBe(3650);
  });

  it("answers what Coolify stores", async () => {
    const ca = await made;
    expect(ca.commonName).toBe("Coolify CA Certificate");
    expect(ca.isCaCertificate).toBe(true);
    expect(ca.subjectAlternativeNames).toEqual([]);
    expect(ca.validUntil.toISOString()).toBe("2036-11-21T21:52:24.000Z");
  });

  it("writes PEM as openssl_x509_export and openssl_pkey_export do", async () => {
    const ca = await made;
    pemLines(ca.sslCertificate, "CERTIFICATE");
    pemLines(ca.sslPrivateKey, "PRIVATE KEY");
  });

  it("exports the key in PHP's layout: PKCS#8, secp521r1, the ECPrivateKey with its public key and no parameters", async () => {
    const ours = der((await made).sslPrivateKey);
    const php = der(PHP_CA_KEY);
    expect(ours.length).toBe(php.length);
    // Everything up to the private scalar: lengths, version, id-ecPublicKey, secp521r1, ECPrivateKey version 1.
    expect(hex(ours.subarray(0, 35))).toBe(hex(php.subarray(0, 35)));
    expect(hex(ours.subarray(0, 35))).toBe("3081ee020100301006072a8648ce3d020106052b810400230481d63081d30201010442");
    // After the 66-byte scalar: [1] { BIT STRING { 0x04 ‖ x ‖ y } }.
    expect(hex(ours.subarray(101, 109))).toBe("a181890381860004");
    expect(hex(php.subarray(101, 109))).toBe("a181890381860004");
    expect(ours.length).toBe(109 + 2 * 66);
  });

  it("is a v3 certificate with Coolify's subject, issued to itself, signed with ecdsa-with-SHA512", async () => {
    const c = parsed((await made).sslCertificate);
    expect(c.version).toBe(2);
    expect(c.serial).toBeGreaterThan(0n);
    expect(c.serial).toBeLessThan(2n ** 63n);
    expect(c.signatureAlgorithm).toBe(OID.ecdsaWithSha512);
    expect(c.subject).toEqual(subjectOf("Coolify CA Certificate"));
    expect(c.issuer).toEqual(c.subject);
    expect(hex(c.issuerDer)).toBe(hex(c.subjectDer));
    expect(await signedBy(c, c)).toBe(true);
  });

  it("has byte for byte the names of the CA that PHP made", async () => {
    const c = parsed((await made).sslCertificate);
    const php = parsed(PHP_CA);
    expect(hex(c.subjectDer)).toBe(hex(php.subjectDer));
    expect(hex(c.issuerDer)).toBe(hex(php.issuerDer));
    expect(c.signatureAlgorithm).toBe(php.signatureAlgorithm);
    expect(c.version).toBe(php.version);
  });

  it("is valid from now for validityDays × 24 hours", async () => {
    const c = parsed((await made).sslCertificate);
    expect(c.notBefore!.toISOString()).toBe("2026-11-24T21:52:24.000Z");
    expect(c.notAfter!.getTime() - c.notBefore!.getTime()).toBe(3650 * DAY);
    const php = parsed(PHP_CA);
    expect(php.notAfter!.getTime() - php.notBefore!.getTime()).toBe(3650 * DAY);
  });

  it("has a secp521r1 key", async () => {
    const c = parsed((await made).sslCertificate);
    expect(c.publicKeyAlgorithm).toBe(OID.ecPublicKey);
    expect(hex(c.publicKeyParameters!)).toBe("06052b81040023");
    expect(c.publicKey.length).toBe(133);
    expect(c.publicKey[0]).toBe(4);
  });

  it("has the [ v3_req ] extensions of a CA, in order and criticality, and no others", async () => {
    const c = parsed((await made).sslCertificate);
    const keyId = hex(new Uint8Array(await crypto.subtle.digest("SHA-1", new Uint8Array(c.publicKey))));
    expect(c.extensions.map((e) => ({ oid: e.oid, critical: e.critical, value: hex(e.value) }))).toEqual([
      // critical, CA:TRUE, pathlen:0
      { oid: OID.basicConstraints, critical: true, value: "30060101ff020100" },
      // critical, keyCertSign, cRLSign
      { oid: OID.keyUsage, critical: true, value: "03020106" },
      // hash
      { oid: OID.subjectKeyIdentifier, critical: false, value: `0414${keyId}` },
    ]);
    // The same as the CA PHP made, the key identifier aside.
    const php = parsed(PHP_CA);
    expect(c.extensions.map((e) => [e.oid, e.critical, e.oid === OID.subjectKeyIdentifier ? e.value.length : hex(e.value)])).toEqual(
      php.extensions.map((e) => [e.oid, e.critical, e.oid === OID.subjectKeyIdentifier ? e.value.length : hex(e.value)]),
    );
  });

  it("matches its own private key and no other", async () => {
    const ca = await made;
    expect(await certificateMatchesPrivateKey(ca.sslCertificate, ca.sslPrivateKey)).toBe(true);
    expect(await certificateMatchesPrivateKey(ca.sslCertificate, PHP_CA_KEY)).toBe(false);
    expect(await certificateMatchesPrivateKey(PHP_CA, ca.sslPrivateKey)).toBe(false);
  });

  it("gets no alternative names, not even the server's address", async () => {
    const ca = await generateSslCertificate({ commonName: "x", isCaCertificate: true, serverIp: "203.0.113.10", subjectAlternativeNames: ["DNS:kept-as-given"] });
    expect(ca.subjectAlternativeNames).toEqual(["DNS:kept-as-given"]);
    expect(parsed(ca.sslCertificate).extensions.map((e) => e.oid)).not.toContain(OID.subjectAltName);
  });

  it("makes a new key and serial each time", async () => {
    const [a, b] = await Promise.all([made, generateSslCertificate({ commonName: CA_COMMON_NAME, isCaCertificate: true, now: NOW })]);
    expect(a.sslPrivateKey).not.toBe(b.sslPrivateKey);
    expect(parsed(a.sslCertificate).serial).not.toBe(parsed(b.sslCertificate).serial);
    // The default validity is a year.
    expect(b.validUntil.getTime() - Math.floor(NOW.getTime() / 1000) * 1000).toBe(365 * DAY);
  });

  it("writes GeneralizedTime from 2050 on, as ASN1_TIME does", async () => {
    const ca = await generateSslCertificate({ commonName: "x", isCaCertificate: true, validityDays: 3650, now: new Date("2045-06-01T00:00:00Z") });
    const raw = hex(parsed(ca.sslCertificate).tbs);
    expect(raw).toContain(hex(Buffer.from("450601000000Z")));
    expect(raw).toContain(hex(Buffer.from("20550530000000Z")));
    expect(parsed(ca.sslCertificate).notAfter!.toISOString()).toBe("2055-05-30T00:00:00.000Z");
  });
});

describe("generateSslCertificate: a leaf signed by a CA", () => {
  const made = generateSslCertificate({ commonName: LEAF_CN, subjectAlternativeNames: LEAF_SANS, caCert: PHP_CA, caKey: PHP_CA_KEY, now: NOW });

  it("answers what Coolify stores: the common name first among the alternative names, each once", async () => {
    const leaf = await made;
    expect(leaf.isCaCertificate).toBe(false);
    expect(leaf.subjectAlternativeNames).toEqual(["DNS:postgres-abc", "DNS:localhost", "IP:10.0.0.5", "IP:2001:db8::1"]);
    expect(leaf.validUntil.toISOString()).toBe("2027-11-24T21:52:24.000Z");
    pemLines(leaf.sslCertificate, "CERTIFICATE");
    pemLines(leaf.sslPrivateKey, "PRIVATE KEY");
  });

  it("has a prime256v1 key, exported as PKCS#8", async () => {
    const leaf = await made;
    const c = parsed(leaf.sslCertificate);
    expect(hex(c.publicKeyParameters!)).toBe("06082a8648ce3d030107");
    expect(c.publicKey.length).toBe(65);
    expect(hex(der(leaf.sslPrivateKey).subarray(0, 36))).toBe("308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420");
    expect(await certificateMatchesPrivateKey(leaf.sslCertificate, leaf.sslPrivateKey)).toBe(true);
  });

  it("is issued by the CA's subject and signed by the CA's key with SHA-512", async () => {
    const c = parsed((await made).sslCertificate);
    const ca = parsed(PHP_CA);
    expect(c.subject).toEqual(subjectOf("postgres-abc"));
    expect(hex(c.issuerDer)).toBe(hex(ca.subjectDer));
    expect(c.signatureAlgorithm).toBe(OID.ecdsaWithSha512);
    expect(await signedBy(c, ca)).toBe(true);
    expect(await signedBy(c, c)).toBe(false);
    expect(c.notAfter!.getTime() - c.notBefore!.getTime()).toBe(365 * DAY);
  });

  it("has byte for byte the names and extensions of the leaf PHP made from the same input", async () => {
    const c = parsed((await made).sslCertificate);
    const php = parsed(PHP_LEAF);
    expect(await signedBy(php, parsed(PHP_CA))).toBe(true);
    expect(hex(c.subjectDer)).toBe(hex(php.subjectDer));
    expect(hex(c.issuerDer)).toBe(hex(php.issuerDer));
    expect(hex(c.publicKeyParameters!)).toBe(hex(php.publicKeyParameters!));
    const keyId = hex(new Uint8Array(await crypto.subtle.digest("SHA-1", new Uint8Array(c.publicKey))));
    const ours = c.extensions.map((e) => ({ oid: e.oid, critical: e.critical, value: hex(e.value) }));
    expect(ours).toEqual([
      // critical, CA:FALSE
      { oid: OID.basicConstraints, critical: true, value: "3000" },
      // critical, digitalSignature, keyAgreement
      { oid: OID.keyUsage, critical: true, value: "03020388" },
      // serverAuth, clientAuth
      { oid: OID.extendedKeyUsage, critical: false, value: "301406082b0601050507030106082b06010505070302" },
      { oid: OID.subjectKeyIdentifier, critical: false, value: `0414${keyId}` },
      // DNS:postgres-abc, DNS:localhost, IP:10.0.0.5, IP:2001:db8::1
      { oid: OID.subjectAltName, critical: false, value: "3031820c706f7374677265732d61626382096c6f63616c686f737487040a000005871020010db8000000000000000000000001" },
    ]);
    expect(ours.filter((e) => e.oid !== OID.subjectKeyIdentifier)).toEqual(
      php.extensions.filter((e) => e.oid !== OID.subjectKeyIdentifier).map((e) => ({ oid: e.oid, critical: e.critical, value: hex(e.value) })),
    );
  });

  it("adds the server's address as an IP or a DNS alternative name", async () => {
    const withIp = await generateSslCertificate({ commonName: "db", serverIp: "203.0.113.10" });
    expect(withIp.subjectAlternativeNames).toEqual(["DNS:db", "IP:203.0.113.10"]);
    const withV6 = await generateSslCertificate({ commonName: "db", serverIp: "2001:db8::2", subjectAlternativeNames: ["IP:2001:db8::2"] });
    expect(withV6.subjectAlternativeNames).toEqual(["DNS:db", "IP:2001:db8::2"]);
    const withHost = await generateSslCertificate({ commonName: "db", serverIp: "db.example.com", subjectAlternativeNames: ["email:ops@example.com", "URI:https://example.com/x"] });
    expect(withHost.subjectAlternativeNames).toEqual(["DNS:db", "email:ops@example.com", "URI:https://example.com/x", "DNS:db.example.com"]);
    const san = parsed(withHost.sslCertificate).extensions.find((e) => e.oid === OID.subjectAltName)!;
    const text = Buffer.from(san.value).toString("latin1");
    expect(text).toContain("\x81\x0fops@example.com");
    expect(text).toContain("\x86\x15https://example.com/x");
    expect(text).toContain("\x82\x0edb.example.com");
  });

  it("signs itself without a CA", async () => {
    const leaf = await generateSslCertificate({ commonName: "self-leaf" });
    const c = parsed(leaf.sslCertificate);
    expect(hex(c.issuerDer)).toBe(hex(c.subjectDer));
    expect(await signedBy(c, c)).toBe(true);
    expect(c.extensions.find((e) => e.oid === OID.basicConstraints)!.value.length).toBe(2);
  });

  it("fails with Coolify's prefix", async () => {
    await expect(generateSslCertificate({ commonName: "db", subjectAlternativeNames: ["IP:not-an-ip"] })).rejects.toThrow(SslError);
    await expect(generateSslCertificate({ commonName: "db", subjectAlternativeNames: ["IP:not-an-ip"] })).rejects.toThrow(/^SSL Certificate generation failed: /);
    await expect(generateSslCertificate({ commonName: "db", subjectAlternativeNames: ["nocolon"] })).rejects.toThrow(/^SSL Certificate generation failed: /);
    await expect(generateSslCertificate({ commonName: "db", subjectAlternativeNames: ["otherName:1.2.3;UTF8:x"] })).rejects.toThrow(/Unsupported subject alternative name type/);
    await expect(generateSslCertificate({ commonName: "db", caCert: "not a certificate", caKey: PHP_CA_KEY })).rejects.toThrow(/^SSL Certificate generation failed: Failed to sign certificate/);
    await expect(generateSslCertificate({ commonName: "db", caCert: PHP_CA, caKey: "not a key" })).rejects.toThrow(/^SSL Certificate generation failed: /);
  });

  it("refuses a signing key that is not the CA certificate's, as openssl_csr_sign does", async () => {
    const other = await generateSslCertificate({ commonName: CA_COMMON_NAME, isCaCertificate: true });
    await expect(generateSslCertificate({ commonName: "db", caCert: PHP_CA, caKey: other.sslPrivateKey })).rejects.toThrow(/private key does not correspond to signing cert/);
    await expect(generateSslCertificate({ commonName: "db", caCert: PHP_CA })).rejects.toThrow(/private key does not correspond to signing cert/);
  });
});

describe("reading a certificate (openssl_x509_read, openssl_x509_export)", () => {
  it("exports PHP's certificate as PHP exported it", () => {
    expect(exportCertificatePem(readCertificatePem(PHP_CA)!)).toBe(PHP_CA);
    expect(exportCertificatePem(readCertificatePem(PHP_LEAF)!)).toBe(PHP_LEAF);
  });

  it("normalizes what OpenSSL's PEM reader accepts: CRLF, text around the block, other blocks before it, unwrapped base64", () => {
    const messy = `junk\n${PHP_CA}\n\ntrailing`.replace(/\n/g, "\r\n");
    expect(exportCertificatePem(readCertificatePem(messy)!)).toBe(PHP_CA);
    expect(exportCertificatePem(readCertificatePem(`${PHP_CA_KEY}${PHP_CA}`)!)).toBe(PHP_CA);
    expect(exportCertificatePem(readCertificatePem(`${PHP_CA}${PHP_LEAF}`)!)).toBe(PHP_CA);
    const oneLine = `-----BEGIN CERTIFICATE-----\n${PHP_CA.split("\n").slice(1, -2).join("")}\n-----END CERTIFICATE-----`;
    expect(exportCertificatePem(readCertificatePem(oneLine)!)).toBe(PHP_CA);
    expect(exportCertificatePem(readCertificatePem(PHP_CA.replace(/CERTIFICATE/g, "X509 CERTIFICATE"))!)).toBe(PHP_CA);
    expect(exportCertificatePem(readCertificatePem(PHP_CA.replace(/\n/g, "  \t\n"))!)).toBe(PHP_CA);
  });

  it("refuses what PHP refuses", () => {
    expect(readCertificatePem("")).toBeNull();
    expect(readCertificatePem("not a certificate")).toBeNull();
    // PHP 8.3 / OpenSSL 3.0: the BEGIN line must start its line, and the block needs its line breaks.
    expect(readCertificatePem(`   ${PHP_CA}`)).toBeNull();
    expect(readCertificatePem(PHP_CA.replace(/\n/g, ""))).toBeNull();
    expect(readCertificatePem(PHP_CA_KEY)).toBeNull();
    expect(readCertificatePem(PHP_CA.replace("-----END CERTIFICATE-----", ""))).toBeNull();
    expect(readCertificatePem(PHP_CA.replace("-----END CERTIFICATE-----", "-----END X509 CRL-----"))).toBeNull();
    expect(readCertificatePem("-----BEGIN CERTIFICATE-----\n!!!!\n-----END CERTIFICATE-----\n")).toBeNull();
    expect(readCertificatePem("-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n")).toBeNull();
    // Valid base64 that is not a certificate: a private key under a certificate's name, and a cut certificate.
    expect(readCertificatePem(PHP_CA_KEY.replace(/PRIVATE KEY/g, "CERTIFICATE"))).toBeNull();
    const lines = PHP_CA.split("\n");
    expect(readCertificatePem([...lines.slice(0, 4), ...lines.slice(-2)].join("\n"))).toBeNull();
  });

  it("parses the fields of PHP's CA", () => {
    const c = parsed(PHP_CA);
    expect(c.version).toBe(2);
    expect(c.serial).toBe(0x0d2e1853ae4457f6n);
    expect(c.subject).toEqual(subjectOf("Coolify CA Certificate"));
    expect(c.notBefore!.toISOString()).toBe("2026-11-24T21:52:24.000Z");
    expect(c.notAfter!.toISOString()).toBe("2036-11-21T21:52:24.000Z");
    expect(hex(c.der)).toBe(hex(der(PHP_CA)));
    expect(() => parseCertificate(der(PHP_CA).subarray(0, 100))).toThrow(X509Error);
    expect(() => parseCertificate(new Uint8Array([0x30, 0x00]))).toThrow(X509Error);
    // Bytes after the certificate are not part of it.
    expect(hex(parseCertificate(new Uint8Array([...der(PHP_CA), 1, 2, 3])).der)).toBe(hex(der(PHP_CA)));
  });
});

describe("certificateMatchesPrivateKey (openssl_x509_check_private_key)", () => {
  it("answers what PHP answered for its own certificates", async () => {
    expect(await certificateMatchesPrivateKey(PHP_CA, PHP_CA_KEY)).toBe(true);
    expect(await certificateMatchesPrivateKey(PHP_LEAF, PHP_CA_KEY)).toBe(false);
    expect(await certificateMatchesPrivateKey(readCertificatePem(PHP_CA)!, PHP_CA_KEY)).toBe(true);
  });

  it("is false for what cannot be read", async () => {
    expect(await certificateMatchesPrivateKey("nothing", PHP_CA_KEY)).toBe(false);
    expect(await certificateMatchesPrivateKey(PHP_CA, "nothing")).toBe(false);
    expect(await certificateMatchesPrivateKey(PHP_CA, PHP_CA)).toBe(false);
  });
});

describe("caCertificateFileCommands", () => {
  it("writes the certificate in place under /data/coolify/ssl, Coolify's commands exactly", () => {
    const certificate = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
    expect(caCertificateFileCommands(certificate)).toEqual([
      "mkdir -p /data/coolify/ssl",
      "chown 9999:root /data/coolify/ssl",
      "chmod 700 /data/coolify/ssl",
      "find /data/coolify/ssl -mindepth 1 -maxdepth 1 -name coolify-ca.crt -type d -exec rm -rf {} +",
      "echo 'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUIKLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQo=' | base64 -d | tee /data/coolify/ssl/coolify-ca.crt > /dev/null",
      "chmod 644 /data/coolify/ssl/coolify-ca.crt",
    ]);
  });

  it("carries the whole certificate as base64", () => {
    const command = caCertificateFileCommands(PHP_CA)[4]!;
    const encoded = /^echo '([A-Za-z0-9+/=]+)' \| base64 -d \| tee/.exec(command)![1]!;
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(PHP_CA);
  });
});

// ---------------------------------------------------------------- the system openssl

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
const withOpenssl = hasOpenssl ? it : it.skip;

describe("generated certificates, read by the system openssl", () => {
  let tmp = "";
  const file = (name: string, content: string): string => {
    const path = join(tmp, name);
    writeFileSync(path, content);
    return path;
  };
  const openssl = (...args: string[]): string => execFileSync("openssl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const fails = (...args: string[]): boolean => spawnSync("openssl", args).status !== 0;
  /** `openssl x509 -text` with runs of whitespace as one space. */
  const text = (path: string): string => openssl("x509", "-in", path, "-noout", "-text").replace(/\s+/g, " ");

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "ssl-test-"));
  });
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  withOpenssl("parses the CA: subject, validity, key, extensions and signature algorithm", async () => {
    const ca = await generateSslCertificate({ commonName: CA_COMMON_NAME, isCaCertificate: true, validityDays: CA_VALIDITY_DAYS, now: NOW });
    const path = file("ca.crt", ca.sslCertificate);
    const t = text(path);
    expect(t).toContain("Version: 3 (0x2)");
    expect(t).toContain("Signature Algorithm: ecdsa-with-SHA512");
    expect(t).toContain("Issuer: CN = Coolify CA Certificate, O = Coolify, C = XX, ST = Default");
    expect(t).toContain("Subject: CN = Coolify CA Certificate, O = Coolify, C = XX, ST = Default");
    expect(t).toContain("Not Before: Nov 24 21:52:24 2026 GMT");
    expect(t).toContain("Not After : Nov 21 21:52:24 2036 GMT");
    expect(t).toContain("Public Key Algorithm: id-ecPublicKey");
    expect(t).toContain("Public-Key: (521 bit)");
    expect(t).toContain("ASN1 OID: secp521r1");
    expect(t).toContain("X509v3 Basic Constraints: critical CA:TRUE, pathlen:0");
    expect(t).toContain("X509v3 Key Usage: critical Certificate Sign, CRL Sign");
    expect(t).toContain("X509v3 Subject Key Identifier: ");
    expect(t).not.toContain("Authority Key Identifier");
    expect(t).not.toContain("Extended Key Usage");
    expect(t).not.toContain("Subject Alternative Name");
    // The extensions section is what openssl prints for the CA PHP made, the key identifier aside.
    const extensions = (s: string) => s.slice(s.indexOf("X509v3 extensions:"), s.indexOf("Signature Algorithm:", s.indexOf("X509v3 extensions:"))).replace(/([0-9A-F]{2}:){19}[0-9A-F]{2}/, "<key id>");
    expect(extensions(t)).toBe(extensions(text(file("php-ca.crt", PHP_CA))));
    // The serial is a positive number below 2^63.
    const serial = BigInt(`0x${openssl("x509", "-in", path, "-noout", "-serial").trim().replace("serial=", "")}`);
    expect(serial > 0n && serial < 2n ** 63n).toBe(true);
    // Self-signed: it verifies as its own trust anchor.
    expect(openssl("verify", "-CAfile", path, path)).toContain(": OK");
    // openssl writes the same PEM back.
    expect(openssl("x509", "-in", path)).toBe(ca.sslCertificate);
  });

  withOpenssl("reads the private key, writes the same PKCS#8 back, and finds the certificate's key in it", async () => {
    const ca = await generateSslCertificate({ commonName: CA_COMMON_NAME, isCaCertificate: true });
    const key = file("ca-key.txt", ca.sslPrivateKey);
    const cert = file("ca2.crt", ca.sslCertificate);
    expect(openssl("pkey", "-in", key, "-noout", "-text")).toContain("ASN1 OID: secp521r1");
    expect(openssl("pkey", "-in", key)).toBe(ca.sslPrivateKey);
    expect(fails("ec", "-in", key, "-check", "-noout")).toBe(false);
    expect(openssl("x509", "-in", cert, "-noout", "-pubkey")).toBe(openssl("pkey", "-in", key, "-pubout"));
  });

  withOpenssl("verifies a leaf against its CA, and not against another CA", async () => {
    const ca = await generateSslCertificate({ commonName: CA_COMMON_NAME, isCaCertificate: true, validityDays: CA_VALIDITY_DAYS });
    const other = await generateSslCertificate({ commonName: CA_COMMON_NAME, isCaCertificate: true, validityDays: CA_VALIDITY_DAYS });
    const leaf = await generateSslCertificate({ commonName: LEAF_CN, subjectAlternativeNames: LEAF_SANS, caCert: ca.sslCertificate, caKey: ca.sslPrivateKey, serverIp: "203.0.113.10" });
    const caPath = file("leaf-ca.crt", ca.sslCertificate);
    const otherPath = file("other-ca.crt", other.sslCertificate);
    const leafPath = file("leaf.crt", leaf.sslCertificate);
    expect(openssl("verify", "-CAfile", caPath, leafPath)).toContain(": OK");
    // As a TLS server and client certificate for its names.
    expect(openssl("verify", "-CAfile", caPath, "-purpose", "sslserver", "-verify_hostname", "postgres-abc", leafPath)).toContain(": OK");
    expect(openssl("verify", "-CAfile", caPath, "-purpose", "sslclient", "-verify_ip", "203.0.113.10", leafPath)).toContain(": OK");
    expect(fails("verify", "-CAfile", otherPath, leafPath)).toBe(true);
    expect(fails("verify", "-CAfile", caPath, "-verify_hostname", "elsewhere", leafPath)).toBe(true);

    const t = text(leafPath);
    expect(t).toContain("Signature Algorithm: ecdsa-with-SHA512");
    expect(t).toContain("Issuer: CN = Coolify CA Certificate, O = Coolify, C = XX, ST = Default");
    expect(t).toContain("Subject: CN = postgres-abc, O = Coolify, C = XX, ST = Default");
    expect(t).toContain("Public-Key: (256 bit)");
    expect(t).toContain("ASN1 OID: prime256v1");
    expect(t).toContain("X509v3 Basic Constraints: critical CA:FALSE");
    expect(t).toContain("X509v3 Key Usage: critical Digital Signature, Key Agreement");
    expect(t).toContain("X509v3 Extended Key Usage: TLS Web Server Authentication, TLS Web Client Authentication");
    expect(t).toContain("X509v3 Subject Alternative Name: DNS:postgres-abc, DNS:localhost, IP Address:10.0.0.5, IP Address:2001:DB8:0:0:0:0:0:1, IP Address:203.0.113.10");
    expect(t).not.toContain("Authority Key Identifier");
    // Valid for a year from now.
    expect(fails("x509", "-in", leafPath, "-noout", "-checkend", String(364 * 86_400))).toBe(false);
    expect(fails("x509", "-in", leafPath, "-noout", "-checkend", String(366 * 86_400))).toBe(true);
    expect(openssl("pkey", "-in", file("leaf-key.txt", leaf.sslPrivateKey))).toBe(leaf.sslPrivateKey);
  });

  withOpenssl("verifies a leaf signed with the CA PHP made, as the leaf PHP signed", async () => {
    const leaf = await generateSslCertificate({ commonName: LEAF_CN, subjectAlternativeNames: LEAF_SANS, caCert: PHP_CA, caKey: PHP_CA_KEY });
    const caPath = file("php-ca2.crt", PHP_CA);
    expect(openssl("verify", "-CAfile", caPath, file("php-leaf.crt", PHP_LEAF))).toContain(": OK");
    const ours = file("our-leaf.crt", leaf.sslCertificate);
    expect(openssl("verify", "-CAfile", caPath, ours)).toContain(": OK");
    // Coolify's [ v3_req ] has no authorityKeyIdentifier, so neither leaf passes OpenSSL's strict RFC 5280 mode.
    for (const path of [ours, join(tmp, "php-leaf.crt")]) {
      const strict = spawnSync("openssl", ["verify", "-x509_strict", "-CAfile", caPath, path], { encoding: "utf8" });
      expect(strict.status).not.toBe(0);
      expect(strict.stderr).toContain("Missing Authority Key Identifier");
    }
  });

  withOpenssl("accepts a certificate openssl made for the stored CA key (a custom CA), and not one made for another key", async () => {
    const ca = await generateSslCertificate({ commonName: CA_COMMON_NAME, isCaCertificate: true });
    const key = file("custom-key.txt", ca.sslPrivateKey);
    const custom = openssl("req", "-x509", "-new", "-key", key, "-sha256", "-days", "30", "-subj", "/CN=My Own CA/O=Example");
    expect(await certificateMatchesPrivateKey(custom, ca.sslPrivateKey)).toBe(true);
    expect(exportCertificatePem(readCertificatePem(custom)!)).toBe(custom);
    expect(parsed(custom).subject.map((a) => a.value)).toEqual(["My Own CA", "Example"]);
    // Another EC key, an RSA key and an Ed25519 key: each matches its own certificate only.
    for (const args of [["ecparam", "-name", "prime256v1", "-genkey", "-noout"], ["genrsa", "2048"], ["genpkey", "-algorithm", "ed25519"]]) {
      const otherKey = openssl(...args);
      const otherCert = openssl("req", "-x509", "-new", "-key", file("other-key.txt", otherKey), "-days", "30", "-subj", "/CN=Other");
      expect(await certificateMatchesPrivateKey(otherCert, otherKey)).toBe(true);
      expect(await certificateMatchesPrivateKey(otherCert, ca.sslPrivateKey)).toBe(false);
      expect(await certificateMatchesPrivateKey(custom, otherKey)).toBe(false);
    }
  });
});
