// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/github.php (generateGithubToken's JWT,
// generateGithubAppJwt) and lcobucci/jwt's Builder, JoseEncoder and Rsa\Sha256 as Coolify uses them
// (Apache-2.0 / BSD-3-Clause), modified.
//
// The JSON Web Token a GitHub App signs to ask GitHub for anything about itself: RS256 over
// {"typ":"JWT","alg":"RS256"} and {"iss":"<app id>","iat":<now - 1 min>,"exp":<now + 8 min>}, the
// instant cut to whole seconds — byte for byte what lcobucci's Builder writes for Coolify. Signed with Web
// Crypto: the App's private key is a PEM, PKCS#1 ("BEGIN RSA PRIVATE KEY", what GitHub hands out) or
// PKCS#8 ("BEGIN PRIVATE KEY"). RSASSA-PKCS1-v1_5 is deterministic, so the same key, App id and instant
// always give the same token.

/** lcobucci's InvalidKeyProvided for a key openssl cannot read; Coolify's pages match "parse your key". */
export class GithubKeyError extends Error {}

const enc = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64Decode(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** A DER length. */
function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

const der = (tag: number, body: Uint8Array): Uint8Array => Uint8Array.from([tag, ...derLength(body.length), ...body]);

/** AlgorithmIdentifier { rsaEncryption, NULL }. */
const RSA_ALGORITHM = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);

/** PrivateKeyInfo around an RSAPrivateKey: what Web Crypto imports. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.from([0x02, 0x01, 0x00]);
  const octets = der(0x04, pkcs1);
  return der(0x30, Uint8Array.from([...version, ...RSA_ALGORITHM, ...octets]));
}

/** The PKCS#8 bytes of a PEM private key, or a GithubKeyError in lcobucci's words. */
export function rsaPkcs8(pem: string): Uint8Array {
  const block = /-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----([\s\S]*?)-----END \1-----/.exec(pem);
  if (!block) throw new GithubKeyError("It was not possible to parse your key, reason: error:1E08010C:DECODER routines::unsupported");
  let body: Uint8Array;
  try {
    body = base64Decode(block[2]!.replace(/\s+/g, ""));
  } catch {
    throw new GithubKeyError("It was not possible to parse your key, reason: error:1E08010C:DECODER routines::unsupported");
  }
  return block[1] === "RSA PRIVATE KEY" ? pkcs1ToPkcs8(body) : body;
}

async function importKey(pem: string): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey("pkcs8", new Uint8Array(rsaPkcs8(pem)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch (e) {
    if (e instanceof GithubKeyError) throw e;
    throw new GithubKeyError("It was not possible to parse your key, reason: error:1E08010C:DECODER routines::unsupported");
  }
}

/** Seconds since the epoch, cut to the second (Coolify sets the time with its own hour, minute and second). */
const wholeSeconds = (now: Date): number => Math.floor(now.getTime() / 1000);

/**
 * generateGithubAppJwt($privateKey, $appId): issued by the App id (as a string, as issuedBy() takes it),
 * issued a minute ago, expiring in eight minutes.
 */
export async function githubAppJwt(privateKeyPem: string, appId: string | number, now: Date = new Date()): Promise<string> {
  const key = await importKey(privateKeyPem);
  const seconds = wholeSeconds(now);
  const header = base64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "RS256" })));
  const payload = base64url(enc.encode(JSON.stringify({ iss: String(appId), iat: seconds - 60, exp: seconds + 8 * 60 })));
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${header}.${payload}`)));
  return `${header}.${payload}.${base64url(signature)}`;
}
