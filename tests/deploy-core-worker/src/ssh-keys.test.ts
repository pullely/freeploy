// The SSH key library (DP-33): Coolify's PrivateKey validation, public key, fingerprints and
// key generation, checked against ssh-keygen / openssl output for fake fixture keys.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COOLIFY_KEY_COMMENT,
  fingerprintMd5,
  fingerprintSha256,
  formatPrivateKey,
  generateSSHKey,
  publicKeyOpenSSH,
  SshKeyError,
  validationError,
} from "../../../apps/deploy-core-worker/src/keys/ssh-keys";

// Jest runs from tests/deploy-core-worker (its rootDir).
const dir = join(process.cwd(), "fixtures", "ssh-keys");
const fixture = (name: string): string => readFileSync(join(dir, name), "utf8");
const expected = JSON.parse(fixture("expected.json")) as Record<string, { public: string; sha256: string; md5: string }>;

const INVALID = "The private key is invalid. Paste an unencrypted private key, not a public key or a certificate.";
const NOT_PEM = 'PuTTY and other key formats are not supported. Paste the key in OpenSSH or PEM format. It starts with "-----BEGIN".';
const DSA = "DSA keys are not supported. Use an Ed25519 or RSA key.";
const RSA_SHORT = "RSA keys must have at least 2048 bits.";
const UNSUPPORTED = "This key type is not supported. Use an Ed25519, ECDSA (nistp256, nistp384, or nistp521), or RSA key.";

const SUPPORTED = [
  "ed25519.openssh",
  "ecdsa256.openssh",
  "ecdsa384.openssh",
  "ecdsa521.openssh",
  "rsa2048.openssh",
  "rsa2048.pkcs1.pem",
  "ec256.sec1.pem",
  "ec384.sec1.pem",
  "ec521.pkcs8.pem",
  "ed25519.pkcs8.pem",
  "rsa2048.pkcs8.pem",
];

describe("formatPrivateKey", () => {
  it("trims and ends with exactly one newline", () => {
    expect(formatPrivateKey("  \r\nKEY\r\n\n\t ")).toBe("KEY\n");
    expect(formatPrivateKey("KEY")).toBe("KEY\n");
    expect(formatPrivateKey("")).toBe("\n");
  });
  it("trims like PHP: only space, tab, CR, LF, NUL and vertical tab", () => {
    expect(formatPrivateKey("\0\x0BKEY ")).toBe("KEY \n");
  });
});

describe.each(SUPPORTED)("supported key %s", (name) => {
  const key = fixture(name);
  const want = expected[name];
  if (!want) throw new Error(`no expected entry for ${name}`);

  it("is valid", () => {
    expect(validationError(key)).toBeNull();
    expect(validationError(key, false)).toBeNull();
  });
  it("gives ssh-keygen -y's public key", async () => {
    await expect(publicKeyOpenSSH(key)).resolves.toBe(want.public);
    await expect(publicKeyOpenSSH(key, "a comment")).resolves.toBe(`${want.public} a comment`);
  });
  it("gives ssh-keygen -lf's fingerprints without the SHA256: / MD5: prefix", async () => {
    await expect(fingerprintSha256(key)).resolves.toBe(want.sha256);
    await expect(fingerprintMd5(key)).resolves.toBe(want.md5);
  });
  it("is unaffected by formatPrivateKey and CRLF line ends", async () => {
    const crlf = formatPrivateKey(key).replace(/\n/g, "\r\n");
    expect(validationError(crlf)).toBeNull();
    await expect(fingerprintSha256(crlf)).resolves.toBe(want.sha256);
  });
});

describe("validationError", () => {
  it.each([
    ["an empty key", ""],
    ["null", null],
    ["garbage", "this is not a key at all"],
    ["a public key", fixture("ed25519.pub")],
    ["a certificate", fixture("certificate.pem")],
    ["an encrypted OpenSSH key", fixture("encrypted.openssh")],
    ["an encrypted PKCS#8 key", fixture("encrypted.pkcs8.pem")],
    ["a truncated key", fixture("ed25519.openssh").slice(0, 200) + "\n-----END OPENSSH PRIVATE KEY-----"],
  ])("rejects %s as invalid", (_label, key) => {
    expect(validationError(key)).toBe(INVALID);
    expect(validationError(key, false)).toBe(INVALID);
  });

  it("rejects an OpenSSH key whose checkints differ", () => {
    const lines = fixture("ed25519.openssh").trim().split("\n");
    const body = Buffer.from(lines.slice(1, -1).join(""), "base64");
    // openssh-key-v1\0 + "none" + "none" + "" + u32 1 + pub blob (51) + u32 len, then checkint 1.
    const checkint = 15 + 8 + 8 + 4 + 4 + 4 + 51 + 4;
    body[checkint] = (body[checkint] ?? 0) ^ 0xff;
    const tampered = `${lines[0]}\n${body.toString("base64")}\n${lines[lines.length - 1]}\n`;
    expect(validationError(tampered)).toBe(INVALID);
  });

  it("rejects PuTTY keys only when strict", async () => {
    const ppk = fixture("ed25519.ppk");
    expect(validationError(ppk)).toBe(NOT_PEM);
    expect(validationError(ppk, false)).toBeNull();
    await expect(publicKeyOpenSSH(ppk)).resolves.toBe(expected["ed25519.openssh"]?.public);
  });

  it("rejects PEM without its BEGIN line only when strict", () => {
    const body = fixture("rsa2048.pkcs1.pem").split("\n").slice(1, -2).join("\n");
    expect(validationError(body)).toBe(NOT_PEM);
    expect(validationError(body, false)).toBeNull();
  });

  it.each(["dsa.pkcs8.pem", "dsa.traditional.pem"])("rejects DSA (%s) when strict", async (name) => {
    const key = fixture(name);
    expect(validationError(key)).toBe(DSA);
    expect(validationError(key, false)).toBeNull();
    await expect(publicKeyOpenSSH(key)).resolves.toBe(expected[name]?.public);
    await expect(fingerprintSha256(key)).resolves.toBe(expected[name]?.sha256);
    await expect(fingerprintMd5(key)).resolves.toBe(expected[name]?.md5);
  });

  it.each(["rsa1024.openssh", "rsa1024.pkcs1.pem"])("rejects RSA-1024 (%s) when strict", async (name) => {
    const key = fixture(name);
    expect(validationError(key)).toBe(RSA_SHORT);
    expect(validationError(key, false)).toBeNull();
    await expect(fingerprintSha256(key)).resolves.toBe(expected[name]?.sha256);
  });

  it.each(["secp256k1.sec1.pem", "ed448.pkcs8.pem"])("rejects key types without an OpenSSH form (%s)", async (name) => {
    const key = fixture(name);
    expect(validationError(key)).toBe(UNSUPPORTED);
    expect(validationError(key, false)).toBeNull();
    await expect(publicKeyOpenSSH(key)).rejects.toThrow(UNSUPPORTED);
    await expect(fingerprintSha256(key)).resolves.toBeNull();
    await expect(fingerprintMd5(key)).resolves.toBeNull();
  });
});

describe("invalid input elsewhere", () => {
  it("publicKeyOpenSSH throws SshKeyError and the fingerprints are null", async () => {
    await expect(publicKeyOpenSSH("garbage")).rejects.toBeInstanceOf(SshKeyError);
    await expect(fingerprintSha256(fixture("ed25519.pub"))).resolves.toBeNull();
    await expect(fingerprintMd5("")).resolves.toBeNull();
  });
  it("derives the EC public point when the SEC1 key leaves it out", async () => {
    const key = fixture("ec256-nopub.sec1.pem");
    expect(validationError(key)).toBeNull();
    await expect(publicKeyOpenSSH(key)).resolves.toBe(expected["ec256.sec1.pem"]?.public);
    await expect(fingerprintSha256(key)).resolves.toBe(expected["ec256.sec1.pem"]?.sha256);
  });
  it("leaves no trailing space without a comment", async () => {
    const line = await publicKeyOpenSSH(fixture("ed25519.openssh"), "");
    expect(line).toBe(expected["ed25519.openssh"]?.public);
  });
});

const hasSshKeygen = spawnSync("ssh-keygen", ["-?"]).error === undefined;

describe("generateSSHKey", () => {
  let tmp = "";
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "ssh-keys-test-"));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const sshKeygenPublic = (privateKey: string, file: string): string => {
    const path = join(tmp, file);
    writeFileSync(path, privateKey, { mode: 0o600 });
    return execFileSync("ssh-keygen", ["-y", "-f", path], { encoding: "utf8" }).trim();
  };

  it("makes an Ed25519 key in phpseclib's OpenSSH layout", async () => {
    const pair = await generateSSHKey("ed25519");
    const lines = pair.private.split("\n");
    expect(lines[0]).toBe("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(pair.private.endsWith("-----END OPENSSH PRIVATE KEY-----\n")).toBe(true);
    expect(lines.slice(1, -3).every((l) => l.length === 70)).toBe(true);
    const body = Buffer.from(lines.slice(1, -2).join(""), "base64");
    expect(body.includes(Buffer.from("phpseclib-generated-key"))).toBe(true);
    expect(body.includes(Buffer.from("none"))).toBe(true);
    expect(pair.public).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43} coolify-generated-ssh-key$/);
    expect(COOLIFY_KEY_COMMENT).toBe("coolify-generated-ssh-key");
    expect(validationError(pair.private)).toBeNull();
    await expect(publicKeyOpenSSH(pair.private, COOLIFY_KEY_COMMENT)).resolves.toBe(pair.public);
    const twice = await generateSSHKey("ed25519");
    expect(twice.public).not.toBe(pair.public);
  });

  it("makes a 4096-bit RSA key in phpseclib's PKCS#1 layout", async () => {
    const pair = await generateSSHKey("rsa");
    expect(pair.private.startsWith("-----BEGIN RSA PRIVATE KEY-----\r\n")).toBe(true);
    expect(pair.private.endsWith("\r\n-----END RSA PRIVATE KEY-----")).toBe(true);
    const lines = pair.private.split("\r\n");
    expect(lines.slice(1, -2).every((l) => l.length === 64)).toBe(true);
    expect(pair.public).toMatch(/^ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQ[A-Za-z0-9+/=]+ coolify-generated-ssh-key$/);
    expect(validationError(pair.private)).toBeNull();
    await expect(publicKeyOpenSSH(pair.private, COOLIFY_KEY_COMMENT)).resolves.toBe(pair.public);
  }, 60_000);

  (hasSshKeygen ? it : it.skip).each(["ed25519", "rsa"] as const)("ssh-keygen accepts the generated %s key", async (type) => {
    const pair = await generateSSHKey(type);
    const fromSshKeygen = sshKeygenPublic(pair.private, `${type}.key`);
    expect(fromSshKeygen.split(" ").slice(0, 2).join(" ")).toBe(pair.public.split(" ").slice(0, 2).join(" "));
    writeFileSync(join(tmp, `${type}.pub`), `${pair.public}\n`);
    const sha = execFileSync("ssh-keygen", ["-lf", join(tmp, `${type}.pub`), "-E", "sha256"], { encoding: "utf8" }).split(" ")[1];
    expect(sha).toBe(`SHA256:${await fingerprintSha256(pair.private)}`);
  }, 60_000);
});
