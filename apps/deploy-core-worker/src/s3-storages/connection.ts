// Derived from coollabsio/coolify@91b7e3e:app/Models/S3Storage.php (testConnection, s3Filesystem,
// usesPathStyleEndpoint, detectPathStyleEndpoint, listFilesWithAddressingStyleFallback,
// isPathStyleRejection, toUserFriendlyConnectionException) and what its disk does through
// league/flysystem-aws-s3-v3 and aws/aws-sdk-php (ListObjectsV2, the S3 endpoint rules, the XML error
// parser, the error message) (Apache-2.0), modified.
//
// Coolify's connection test lists the bucket's root once — ListObjectsV2 with
// prefix "" and delimiter "/" — signed with Signature Version 4 for the
// storage's region, and the storage is usable when that answers 2xx. Here the
// request goes through an injectable function, so no test touches the
// network; the message of a failure is the one Coolify shows, word for word
// (fixtures/s3 holds what Coolify's PHP raises for each answer).
//
// Departures: a request that fails before any answer (DNS, refused, TLS)
// carries the runtime's fetch error where Coolify shows cURL's text; the
// endpoint is not pinned to the addresses the validation resolved (a Worker
// cannot pin, and cannot reach private addresses either); TLS verification
// cannot be turned off from a Worker, so "Skip TLS certificate verification"
// is stored but not applied; a timed-out request is reported as "… timed out
// after 15 seconds" so that Coolify's timeout message applies.
import { amzDate, EMPTY_PAYLOAD_SHA256, sign, uriEncode } from "./sigv4.js";
import { safeUrlError, type HostResolver } from "./safe-url.js";
import { validS3BucketName, BUCKET_NAME_MESSAGE } from "./validation.js";

/** One HTTP exchange: what fetch gives, reduced to what the SDK reads. */
export type S3Http = (url: string, init: { method: string; headers: Record<string, string>; timeoutMs: number }) => Promise<{ status: number; headers: Headers; body: string }>;

export const s3Fetch: S3Http = async (url, init) => {
  try {
    const r = await fetch(url, { method: init.method, headers: init.headers, redirect: "manual", signal: AbortSignal.timeout(init.timeoutMs) });
    return { status: r.status, headers: r.headers, body: await r.text() };
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new Error(`Request timed out after ${init.timeoutMs / 1000} seconds for ${url}`);
    throw e;
  }
};

/** What a connection test reads of a storage. */
export interface S3Connection {
  endpoint: string | null;
  bucket: string | null;
  region: string | null;
  key: string;
  secret: string;
  usePathStyleEndpoint: boolean;
}

/** CONNECTION_TIMEOUT_SECONDS and REQUEST_TIMEOUT_SECONDS. */
const TIMEOUT_MS = 15_000;
/** The SDK's retries: three attempts for a server error or a failed exchange. */
const ATTEMPTS = 3;

/** VIRTUAL_HOSTED_STYLE_HOST_SUFFIXES */
const VIRTUAL_HOSTED_STYLE_HOST_SUFFIXES = ["aliyuncs.com", "myqcloud.com", "volces.com", "bytepluses.com"];
/** PATH_STYLE_REJECTION_ERRORS */
const PATH_STYLE_REJECTION_ERRORS = ["secondleveldomainforbidden", "pathstyledomainforbidden", "virtual hosted style", "virtual-hosted style", "virtual-styled"];

export const CONNECTION_MESSAGES = {
  /** toUserFriendlyConnectionException() */
  timeout: "Could not connect to the S3 endpoint within 15 seconds. Please verify the endpoint, bucket, credentials, region, and network/firewall settings.",
  endpointNotAllowed: (reason: string) => `S3 endpoint is not allowed: ${reason}`,
  bucketNotAllowed: (reason: string) => `S3 bucket name is not allowed: ${reason}`,
} as const;

/** detectPathStyleEndpoint(): virtual-hosted style for providers that reject path-style URLs. */
export function detectPathStyleEndpoint(endpoint: string | null): boolean {
  let host = "";
  try {
    host = endpoint ? new URL(endpoint).hostname.toLowerCase() : "";
  } catch {
    host = "";
  }
  return !VIRTUAL_HOSTED_STYLE_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
}

/** The S3 endpoint rules' isVirtualHostableS3Bucket(bucket, false): one DNS label, lower case, not an address. */
function virtualHostable(bucket: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) && !/^\d+\.\d+\.\d+\.\d+$/.test(bucket);
}

/** The ListObjectsV2 request of the connection test: its URL, its host and the path and query it signs. */
export function listObjectsRequest(c: S3Connection, pathStyle: boolean): { url: string; host: string; path: string; query: Array<[string, string]> } {
  const endpoint = (c.endpoint ?? "").trim();
  let parsed: URL;
  try {
    if (/[?#]/.test(endpoint)) throw new Error("query");
    parsed = new URL(endpoint);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
  } catch {
    throw new S3ConnectionError(`Custom endpoint \`${endpoint}\` was not a valid URI`);
  }
  const bucket = c.bucket ?? "";
  let base = parsed.pathname.replace(/\/+$/, "");
  try {
    base = decodeURIComponent(base);
  } catch {
    /* an invalid escape stays as written */
  }
  const virtual = !pathStyle && virtualHostable(bucket);
  const hostname = virtual ? `${bucket}.${parsed.hostname}` : parsed.hostname;
  const host = parsed.port ? `${hostname}:${parsed.port}` : hostname;
  const path = virtual ? `${base}/` : `${base}/${bucket}/`;
  const query: Array<[string, string]> = [
    ["list-type", "2"],
    ["prefix", ""],
    ["delimiter", "/"],
  ];
  return { url: `${parsed.protocol}//${host}${uriEncode(path, true)}?list-type=2&prefix=&delimiter=%2F`, host, path, query };
}

/** The headers of the request as signed and sent: host, the payload hash, the date; and Authorization. */
export async function signedListObjects(c: S3Connection, pathStyle: boolean, now: Date, extraHeaders: Array<[string, string]> = []) {
  const req = listObjectsRequest(c, pathStyle);
  const date = amzDate(now);
  const headers: Array<[string, string]> = [["host", req.host], ...extraHeaders, ["x-amz-content-sha256", EMPTY_PAYLOAD_SHA256], ["x-amz-date", date]];
  const signature = await sign({ method: "GET", path: req.path, query: req.query, headers, payloadHash: EMPTY_PAYLOAD_SHA256 }, { accessKeyId: c.key, secretAccessKey: c.secret }, c.region ?? "", "s3", date);
  return { ...req, headers, signature };
}

/** A failed connection test, with the message Coolify shows. */
export class S3ConnectionError extends Error {}

// ------------------------------------------------------------ the SDK's error message

const REASONS: Record<number, string> = {
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 411: "Length Required",
  412: "Precondition Failed", 416: "Range Not Satisfiable", 429: "Too Many Requests", 500: "Internal Server Error", 501: "Not Implemented",
  502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) =>
    e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'" : String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)),
  );
}

/** A well-formed XML document's elements in document order (name and direct text), or null where SimpleXML would not parse it. */
export function xmlElements(body: string): Array<{ name: string; text: string }> | null {
  const s = body.replace(/^﻿/, "");
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|([^<]+)|(<)/g;
  const stack: Array<{ name: string; text: string }> = [];
  const out: Array<{ name: string; text: string }> = [];
  let roots = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m[7]) return null;
    if (m[1] !== undefined) {
      if (!stack.length) return null;
      stack[stack.length - 1]!.text += m[1];
    } else if (m[2]) {
      const top = stack.pop();
      if (!top || top.name !== m[2]) return null;
    } else if (m[3]) {
      if (!stack.length && roots++ > 0) return null;
      const el = { name: m[3], text: "" };
      out.push(el);
      if (m[5] !== "/") stack.push(el);
    } else if (m[6] !== undefined) {
      if (stack.length) stack[stack.length - 1]!.text += decodeEntities(m[6]);
      else if (m[6].trim() !== "") return null;
    }
  }
  return stack.length === 0 && roots === 1 ? out : null;
}

/** WrappedHttpHandler's "AWS HTTP error:\n…" part for an answer that is not 2xx, as XmlErrorParser reads it. */
export function serviceError(status: number, headers: Headers, body: string): string {
  const type = String(status)[0] === "4" ? "client" : "server";
  if (body === "") {
    const code = status === 404 ? "NotFound" : "";
    const requestId = headers.get("x-amz-request-id");
    return `AWS HTTP error:\n${code} (${type}): ${status} ${REASONS[status] ?? ""}${requestId ? ` (Request-ID: ${requestId})` : ""}`;
  }
  const elements = xmlElements(body);
  if (!elements) return "AWS HTTP error:\n Unable to parse error information from response - Error parsing XML: String could not be parsed as XML";
  const local = (n: string) => n.replace(/^.*:/, "");
  const code = elements.find((e) => local(e.name) === "Code")?.text ?? "";
  const message = elements.find((e) => local(e.name) === "Message")?.text ?? "";
  return `AWS HTTP error:\n${code} (${type}): ${message}`;
}

/** UnableToListContents::atLocation('', false, …) around the SDK's S3Exception. */
const listingError = (reason: string) => `Unable to list contents for '', shallow listing\n\nReason: ${reason}`;

export interface ConnectionTestOptions {
  http: S3Http;
  now?: () => Date;
  /** The pause before a retry. */
  sleep?: (ms: number) => Promise<void>;
}

/** $this->filesystem()->files(): one ListObjectsV2, retried as the SDK retries. */
export async function listFiles(c: S3Connection, pathStyle: boolean, opts: ConnectionTestOptions): Promise<void> {
  let req: Awaited<ReturnType<typeof signedListObjects>>;
  try {
    req = await signedListObjects(c, pathStyle, (opts.now ?? (() => new Date()))());
  } catch (e) {
    throw new S3ConnectionError(listingError(e instanceof Error ? e.message : String(e)));
  }
  const failure = (detail: string) => new S3ConnectionError(listingError(`Error executing "ListObjectsV2" on "${req.url}"; ${detail}`));
  for (let attempt = 1; ; attempt++) {
    let answer: Awaited<ReturnType<S3Http>>;
    try {
      const headers: Record<string, string> = { "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256, "x-amz-date": req.signature.stringToSign.split("\n")[1]!, authorization: req.signature.authorization };
      answer = await opts.http(req.url, { method: "GET", headers, timeoutMs: TIMEOUT_MS });
    } catch (e) {
      if (attempt < ATTEMPTS) {
        await (opts.sleep ?? defaultSleep)(retryDelay(attempt));
        continue;
      }
      throw failure(`AWS HTTP error:\n${e instanceof Error ? e.message : String(e)}`);
    }
    if (answer.status >= 200 && answer.status < 300) return;
    if (answer.status >= 500 && attempt < ATTEMPTS) {
      await (opts.sleep ?? defaultSleep)(retryDelay(attempt));
      continue;
    }
    throw failure(serviceError(answer.status, answer.headers, answer.body));
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** The SDK's exponential backoff, without its jitter. */
const retryDelay = (attempt: number) => 100 * 2 ** (attempt - 1);

function isPathStyleRejection(message: string): boolean {
  const lower = message.toLowerCase();
  return PATH_STYLE_REJECTION_ERRORS.some((e) => lower.includes(e));
}

/** toUserFriendlyConnectionException() for an S3 storage. */
function userFriendly(message: string): string {
  const lower = message.toLowerCase();
  return ["timed out", "timeout", "connection refused", "could not resolve", "curl error 28"].some((s) => lower.includes(s)) ? CONNECTION_MESSAGES.timeout : message;
}

export interface ConnectionTestResult {
  /** The URL style that worked, or the one tried. */
  usePathStyleEndpoint: boolean;
}

/**
 * S3Storage::testConnection() for an S3 storage: the endpoint and the bucket
 * as SafeWebhookUrl and ValidS3BucketName see them, then the listing — and
 * when the provider rejects a path-style URL, the listing again in virtual-
 * hosted style, kept when it works. Throws S3ConnectionError with Coolify's
 * message; the caller sets is_usable.
 */
export async function testS3Connection(c: S3Connection, resolve: HostResolver, opts: ConnectionTestOptions): Promise<ConnectionTestResult> {
  if (c.endpoint === null || c.endpoint.trim() === "") throw new S3ConnectionError(CONNECTION_MESSAGES.endpointNotAllowed("The endpoint field is required."));
  const endpointError = await safeUrlError(c.endpoint, "endpoint", "endpoint", resolve);
  if (endpointError) throw new S3ConnectionError(CONNECTION_MESSAGES.endpointNotAllowed(endpointError));
  if (c.bucket === null || c.bucket.trim() === "") throw new S3ConnectionError(CONNECTION_MESSAGES.bucketNotAllowed("The bucket field is required."));
  if (!validS3BucketName(c.bucket)) throw new S3ConnectionError(CONNECTION_MESSAGES.bucketNotAllowed(BUCKET_NAME_MESSAGE("bucket")));
  try {
    await listFiles(c, c.usePathStyleEndpoint, opts);
    return { usePathStyleEndpoint: c.usePathStyleEndpoint };
  } catch (first) {
    if (!(first instanceof S3ConnectionError)) throw first;
    if (!c.usePathStyleEndpoint || !isPathStyleRejection(first.message)) throw new S3ConnectionError(userFriendly(first.message));
    try {
      await listFiles(c, false, opts);
      return { usePathStyleEndpoint: false };
    } catch {
      throw new S3ConnectionError(userFriendly(first.message));
    }
  }
}
