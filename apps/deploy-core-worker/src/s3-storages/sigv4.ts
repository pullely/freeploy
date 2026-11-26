// AWS Signature Version 4 (header-based, AWS4-HMAC-SHA256) on Web Crypto: the
// signing Coolify's S3 storages get from the AWS SDK for PHP (Aws\Signature\SignatureV4 /
// S3SignatureV4). No dependency: SHA-256 and HMAC-SHA256 come from crypto.subtle.
//
// Held to AWS's published Signature Version 4 test suite (canonical request,
// string to sign, Authorization header) and to the requests aws-sdk-php
// signs for Coolify's connection test (tests/deploy-core-worker/fixtures/s3).
//
// S3 does not normalize or double-encode the path (the SDK's S3SignatureV4
// sets both off), and neither does this signer: a path is encoded once, each
// segment with UriEncode, '/' kept.

const encoder = new TextEncoder();
/** UTF-8 bytes in a buffer of their own (what crypto.subtle takes in every lib version). */
const utf8 = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(encoder.encode(s));

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

async function hmac(key: ArrayBuffer | Uint8Array<ArrayBuffer>, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, utf8(data));
}

/** SHA-256 of the empty payload (a GET's x-amz-content-sha256). */
export const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** UriEncode(): every byte but A–Z a–z 0–9 - _ . ~ as %XY (upper-case hex); '/' too unless `keepSlash`. */
export function uriEncode(value: string, keepSlash = false): string {
  let out = "";
  for (const byte of encoder.encode(value)) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === "/")) out += c;
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

export interface SignableRequest {
  method: string;
  /** The path, not encoded ("/bucket/"). */
  path: string;
  /** Query parameters, not encoded, in any order; a key without a value is [key, ""]. */
  query: Array<[string, string]>;
  /** Headers to sign, as sent (name in any case; repeated names allowed). */
  headers: Array<[string, string]>;
  /** Hex SHA-256 of the body. */
  payloadHash: string;
}

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** A header value as SigV4 canonicalizes it: trimmed, runs of whitespace (folded lines included) as one space. */
function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** The canonical headers (each `name:value\n`) and the signed headers list. */
function canonicalHeaders(headers: Array<[string, string]>): { canonical: string; signed: string } {
  const byName = new Map<string, string[]>();
  for (const [name, value] of headers) {
    const key = name.toLowerCase().trim();
    const values = byName.get(key) ?? [];
    values.push(canonicalHeaderValue(value));
    byName.set(key, values);
  }
  const names = [...byName.keys()].sort();
  return { canonical: names.map((n) => `${n}:${byName.get(n)!.join(",")}\n`).join(""), signed: names.join(";") };
}

/** The canonical query string: encoded keys and values, sorted by key, then value. */
export function canonicalQuery(query: Array<[string, string]>): string {
  return query
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** <HTTPMethod>\n<CanonicalURI>\n<CanonicalQueryString>\n<CanonicalHeaders>\n<SignedHeaders>\n<HashedPayload> */
export function canonicalRequest(request: SignableRequest): { canonicalRequest: string; signedHeaders: string } {
  const { canonical, signed } = canonicalHeaders(request.headers);
  const uri = uriEncode(request.path === "" ? "/" : request.path, true);
  return {
    canonicalRequest: [request.method.toUpperCase(), uri, canonicalQuery(request.query), canonical, signed, request.payloadHash].join("\n"),
    signedHeaders: signed,
  };
}

/** The scope: <YYYYMMDD>/<region>/<service>/aws4_request. */
export function credentialScope(amzDate: string, region: string, service: string): string {
  return `${amzDate.slice(0, 8)}/${region}/${service}/aws4_request`;
}

/** AWS4-HMAC-SHA256\n<amzDate>\n<scope>\n<hex SHA-256 of the canonical request> */
export async function stringToSign(amzDate: string, scope: string, canonical: string): Promise<string> {
  return ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonical)].join("\n");
}

/** kSigning = HMAC(HMAC(HMAC(HMAC("AWS4" + secret, date), region), service), "aws4_request"). */
export async function signingKey(secretAccessKey: string, date: string, region: string, service: string): Promise<ArrayBuffer> {
  const kDate = await hmac(utf8("AWS4" + secretAccessKey), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export interface Signature {
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  signedHeaders: string;
  /** The Authorization header's value. */
  authorization: string;
}

/**
 * Signs a request. `amzDate` is the X-Amz-Date value (YYYYMMDD'T'HHMMSS'Z'),
 * which must also be one of the headers when the request is sent.
 */
export async function sign(request: SignableRequest, credentials: Credentials, region: string, service: string, amzDate: string): Promise<Signature> {
  const { canonicalRequest: creq, signedHeaders } = canonicalRequest(request);
  const scope = credentialScope(amzDate, region, service);
  const sts = await stringToSign(amzDate, scope, creq);
  const signature = hex(await hmac(await signingKey(credentials.secretAccessKey, amzDate.slice(0, 8), region, service), sts));
  return {
    canonicalRequest: creq,
    stringToSign: sts,
    signature,
    signedHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** X-Amz-Date for a moment: 20150830T123600Z. */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
