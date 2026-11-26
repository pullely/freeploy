// Derived from coollabsio/coolify@91b7e3e:app/Services/{HetznerService,DigitalOceanService,VultrService,HostingerService}.php,
// app/Exceptions/{CloudProviderApiException,RateLimitException}.php, laravel/framework's Illuminate\Http\Client\PendingRequest
// (send(), retry()) and Illuminate\Support\helpers.php (retry()), and PHP's json_decode() (Apache-2.0 / MIT / PHP-3.01),
// modified.
//
// What Coolify's /api/v1 asks a cloud provider (DP-90): the provider services' requests, sent through the context's
// fetch (injectable: the tests serve the answers emit.php fakes with Http::fake()), retried as Laravel's PendingRequest
// retries them (`retry($times, $sleep, $when, throw: false)`: a failed answer is sent again while the `when` callback
// allows it, the last one is returned), and the answers decoded as PHP's json_decode($text, true) decodes them, so that
// what Coolify writes back with response()->json() is written again byte for byte (an empty object is an empty PHP array,
// `[]`; an object whose keys are 0…n-1 is a list). A float whose value is a whole number is written as JavaScript writes
// it (`4`, where PHP writes `4.0`): no golden carries one.
import { isObj, obj, type PhpObject, type PhpValue } from "@saas/contracts/coolify-api";

// ── PHP's json_decode($text, true) ──────────────────────────────────────────

/** json_decode($text, true): null for invalid JSON (and for `null`), objects as ordered PHP arrays. */
export function phpJsonDecode(text: string): PhpValue {
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const fail = (): never => {
    throw new SyntaxError("json");
  };
  const value = (): PhpValue => {
    ws();
    const ch = text[i];
    if (ch === "{") {
      i++;
      const entries: Array<[string, PhpValue]> = [];
      ws();
      if (text[i] === "}") {
        i++;
        return [];
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        const key = string();
        ws();
        if (text[i] !== ":") fail();
        i++;
        const v = value();
        const at = entries.findIndex(([k]) => k === key);
        if (at === -1) entries.push([key, v]);
        else entries[at] = [key, v];
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          break;
        }
        fail();
      }
      // A PHP array whose keys are 0…n-1 in order is a list.
      if (entries.every(([k], n) => k === String(n))) return entries.map(([, v]) => v);
      return obj(entries);
    }
    if (ch === "[") {
      i++;
      const items: PhpValue[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return items;
      }
      for (;;) {
        items.push(value());
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          break;
        }
        fail();
      }
      return items;
    }
    if (ch === '"') return string();
    const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!m) return fail();
    i += m[0].length;
    if (m[0] === "true") return true;
    if (m[0] === "false") return false;
    if (m[0] === "null") return null;
    return Number(m[0]);
  };
  const string = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    if (i >= text.length) fail();
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  try {
    const v = value();
    ws();
    if (i !== text.length) return null;
    return v;
  } catch {
    return null;
  }
}

/** data_get($array, 'a.b.c'): undefined when a segment is missing. */
export function dataGet(v: PhpValue | undefined, path: string): PhpValue | undefined {
  let cur: PhpValue | undefined = v;
  for (const seg of path.split(".")) {
    if (cur === undefined || cur === null) return undefined;
    if (Array.isArray(cur)) cur = /^\d+$/.test(seg) ? cur[Number(seg)] : undefined;
    else if (isObj(cur)) cur = cur.entries.find(([k]) => k === seg)?.[1];
    else return undefined;
  }
  return cur;
}

/** $array[$key] ?? null on a PHP array (a list's integer keys too). */
export const at = (v: PhpValue | undefined, key: string): PhpValue | undefined =>
  Array.isArray(v) ? (/^\d+$/.test(key) ? v[Number(key)] : undefined) : isObj(v) ? v.entries.find(([k]) => k === key)?.[1] : undefined;

/** A closure typed `array $item`: anything else is a TypeError (the controllers' catch-all answers it). */
export function typedArray(v: PhpValue | undefined): PhpValue[] | PhpObject {
  if (!isPhpArray(v)) throw new TypeError("array expected");
  return v;
}

/** The values of a PHP array (a list's items, an object's values in order). */
export const phpValues = (v: PhpValue | undefined): PhpValue[] => (Array.isArray(v) ? v : isObj(v) ? v.entries.map(([, x]) => x) : []);

/** is_array() */
export const isPhpArray = (v: PhpValue | undefined): v is PhpValue[] | PhpObject => Array.isArray(v) || isObj(v);

/** blank() / filled() of a decoded value. */
export function blank(v: PhpValue | undefined): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (isObj(v)) return v.entries.length === 0;
  return false;
}

/** PHP's (string) cast of a scalar; null for an array, which PHP cannot cast without an error. */
export function phpCastString(v: PhpValue | undefined): string | null {
  if (v === undefined || v === null || v === false) return "";
  if (v === true) return "1";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return null;
}

// ── Laravel's HTTP client ───────────────────────────────────────────────────

/** What the API reaches out with: the context's fetch and a sleep (Laravel's retry() waits between attempts). */
export interface ProviderNetwork {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** The instant a GitHub App's JWT is issued at (DP-93); the clock when absent. */
  now?: () => Date;
}

export interface ProviderResponse {
  status: number;
  headers: Headers;
  text: string;
  /** $response->successful() */
  successful: boolean;
  /** $response->json() */
  json: PhpValue;
}

/** A failed answer that a `when` callback reads (Laravel's RequestException), or a transfer error (ConnectionException). */
export type Failure = { response: ProviderResponse } | { error: unknown };

export interface RetryPolicy {
  tries: number;
  /** The milliseconds to wait after the attempt that failed (1-based). */
  sleep: (attempt: number, failure: Failure) => number;
  /** Whether to send again; absent: always. */
  when?: (failure: Failure) => boolean;
}

export interface ProviderRequest {
  method: "get" | "post" | "delete";
  url: string;
  /** A GET's query (http_build_query of the data, in its order). */
  query?: Array<[string, string | number]>;
  /** A POST's JSON body. */
  json?: unknown;
  /** A POST's form body (asForm(), DP-103): application/x-www-form-urlencoded, in its order. */
  form?: Array<[string, string]>;
  headers: Record<string, string>;
  timeoutMs: number;
  retry?: RetryPolicy;
}

/** http_build_query() with PHP_QUERY_RFC3986, as Guzzle writes a request's query. */
export function httpBuildQuery(query: Array<[string, string | number]>): string {
  return query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
}

async function sendOnce(net: ProviderNetwork, r: ProviderRequest): Promise<ProviderResponse> {
  const url = r.query && r.query.length ? `${r.url}${r.url.includes("?") ? "&" : "?"}${httpBuildQuery(r.query)}` : r.url;
  const headers: Record<string, string> = { ...r.headers };
  let body: string | undefined;
  if (r.method !== "get" && r.form !== undefined) {
    body = new URLSearchParams(r.form).toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  } else if (r.method !== "get" && r.json !== undefined) {
    body = JSON.stringify(r.json);
    headers["Content-Type"] = "application/json";
  }
  const res = await net.fetch(url, { method: r.method.toUpperCase(), headers, ...(body !== undefined && { body }), signal: AbortSignal.timeout(r.timeoutMs) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, successful: res.status >= 200 && res.status < 300, json: phpJsonDecode(text) };
}

/** PendingRequest::send() with retry(…, throw: false): the last answer, or the last transfer error thrown. */
export async function providerSend(net: ProviderNetwork, r: ProviderRequest): Promise<ProviderResponse> {
  const tries = r.retry?.tries ?? 1;
  for (let attempt = 1; ; attempt++) {
    let failure: Failure;
    try {
      const response = await sendOnce(net, r);
      if (response.successful) return response;
      failure = { response };
    } catch (error) {
      failure = { error };
    }
    const again = attempt < tries && (r.retry?.when ? r.retry.when(failure) : true);
    if (!again) {
      if ("error" in failure) throw failure.error;
      return failure.response;
    }
    const ms = r.retry!.sleep(attempt, failure);
    if (ms > 0) await net.sleep(ms);
  }
}

const responseOf = (f: Failure): ProviderResponse | null => ("response" in f ? f.response : null);

// ── the provider errors ─────────────────────────────────────────────────────

/** RateLimitException */
export class RateLimitError extends Error {
  constructor(readonly retryAfter: number) {
    super("Rate limit exceeded. Please try again later.");
  }
}

/** CloudProviderApiException */
export class CloudProviderApiError extends Error {
  readonly errorCode: string | null;
  readonly invalidFields: string[];
  constructor(
    readonly provider: string,
    readonly status: number,
    errorCode: PhpValue | undefined = null,
    invalidFields: PhpValue[] = [],
  ) {
    super(`${provider} API error`);
    const code = typeof errorCode === "string" ? errorCode.toLowerCase() : null;
    this.errorCode = code !== null && /^[a-z_]{1,64}$/.test(code) ? code : null;
    this.invalidFields = invalidFields.filter((n): n is string => typeof n === "string" && /^[a-z0-9_.[\]]{1,64}$/i.test(n));
  }

  /** safeMessage() */
  safeMessage(): string {
    const p = this.provider;
    if (this.errorCode === "resource_limit_exceeded") return `Your ${p} account has reached a resource limit, for example the server limit. Remove unused resources or ask ${p} for a higher limit.`;
    if (this.errorCode === "resource_unavailable") return "The selected server type, image, or location is not available now. Select a different location or server type.";
    if (this.errorCode === "uniqueness_error") return `A resource with the same name already exists in your ${p} account, for example a server or an SSH key. Use a different name.`;
    if (this.errorCode === "maintenance" || this.status === 423 || this.status >= 500) return `${p} cannot process the request now. Try again later.`;
    if (this.status === 401) return `The ${p} API token is invalid or expired. Update the cloud provider token in Coolify.`;
    if (this.status === 403) return `The ${p} API token does not have permission for this request. Use a token with read and write access.`;
    if (this.status === 404) return `${p} could not find a requested resource, for example the location, server type, image, or SSH key.`;
    if (this.status === 409) return `${p} rejected the request because of a conflict with an existing resource.`;
    if (this.status === 422) return `${p} rejected the request as invalid. Check the selected values and your account limits.${this.invalidFields.length ? ` Invalid fields: ${this.invalidFields.join(", ")}.` : ""}`;
    return `${p} returned HTTP ${this.status}${this.errorCode !== null ? ` (error code: ${this.errorCode})` : ""}.`;
  }
}

/** The Hostinger service's `\Exception('Hostinger API error: …', $status)`. */
export class HostingerApiError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

/**
 * `$response->header('Retry-After')` as (int): Laravel's header() gives '' for a header the answer does not have, never
 * null, so the services' `!== null` checks always pass (0 without the header) and RateLimit-Reset is never read here.
 */
const retryAfterOf = (response: ProviderResponse): number => phpInt(response.headers.get("Retry-After") ?? "");

/** PHP's (int) of a header value. */
const phpInt = (s: string): number => {
  const m = /^\s*[+-]?\d+/.exec(s);
  return m ? Number(m[0]) : 0;
};

/** The backoff of Hetzner's and DigitalOcean's retry(): until RateLimit-Reset (60 s at most) for a 429, else 100 ms per attempt. */
function resetBackoff(attempt: number, f: Failure): number {
  const r = responseOf(f);
  if (r && r.status === 429) {
    const reset = r.headers.get("RateLimit-Reset");
    if (reset) return Math.min(Math.max(0, phpInt(reset) - Math.floor(Date.now() / 1000)), 60) * 1000;
  }
  return attempt * 100;
}

// ── the four services ───────────────────────────────────────────────────────

export interface ProviderClient {
  request(method: ProviderRequest["method"], endpoint: string, data?: Array<[string, string | number]> | unknown): Promise<PhpValue>;
}

/** HetznerService::request() */
export function hetznerClient(net: ProviderNetwork, token: string): ProviderClient {
  return {
    async request(method, endpoint, data = []) {
      const response = await providerSend(net, {
        method,
        url: `https://api.hetzner.cloud/v1${endpoint}`,
        ...(method === "get" ? { query: data as Array<[string, string | number]> } : { json: data }),
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: 30_000,
        retry: {
          tries: 3,
          sleep: resetBackoff,
          when: (f) => {
            const r = responseOf(f);
            if (r && r.status === 429) return true;
            // A POST that failed with a 5xx or a timeout can still have created the resource: only GET and DELETE are sent again.
            const isServerError = !r || r.status >= 500;
            return isServerError && (method === "get" || method === "delete");
          },
        },
      });
      if (!response.successful) {
        if (response.status === 429) throw new RateLimitError(retryAfterOf(response));
        const fields = dataGet(response.json, "error.details.fields");
        throw new CloudProviderApiError(
          "Hetzner",
          response.status,
          dataGet(response.json, "error.code"),
          phpValues(fields).map((f) => (isPhpArray(f) ? (at(f, "name") ?? null) : null)),
        );
      }
      return response.json;
    },
  };
}

/** HetznerService::requestPaginated() */
async function hetznerPaginated(client: ProviderClient, endpoint: string, key: string, data: Array<[string, string | number]> = []): Promise<PhpValue[]> {
  const all: PhpValue[] = [];
  let page: PhpValue | undefined = 1;
  do {
    const response = await client.request("get", endpoint, [...data, ["page", phpQueryValue(page)], ["per_page", 50]]);
    const items = at(response, key);
    if (items !== undefined && items !== null) all.push(...phpValues(items));
    const next = dataGet(response, "meta.pagination.next_page");
    page = next ?? null;
  } while (page !== null);
  return all;
}

/** A page number as http_build_query() writes it. */
const phpQueryValue = (v: PhpValue | undefined): string | number => (typeof v === "number" ? v : v === true ? 1 : v === false || v === null || v === undefined ? "" : typeof v === "string" ? v : "");

/** HetznerService: the catalog methods. */
export const hetzner = {
  locations: (c: ProviderClient) => hetznerPaginated(c, "/locations", "locations"),
  images: (c: ProviderClient) => hetznerPaginated(c, "/images", "images", [["type", "system"]]),
  sshKeys: (c: ProviderClient) => hetznerPaginated(c, "/ssh_keys", "ssh_keys"),
  firewalls: (c: ProviderClient) => hetznerPaginated(c, "/firewalls", "firewalls"),
  networks: (c: ProviderClient) => hetznerPaginated(c, "/networks", "networks"),
  /** getServerTypes($location): the types not deprecated, each with the locations where it is in stock and not deprecated. */
  async serverTypes(c: ProviderClient, location: string | null): Promise<PhpValue[]> {
    const out: PhpValue[] = [];
    for (const type of await hetznerPaginated(c, "/server_types", "server_types")) {
      const t = typedArray(type);
      if (at(t, "deprecated") === true) continue;
      const locations = phpValues(at(t, "locations") ?? []).filter((l) => phpEmpty(at(typedArray(l), "deprecation")) && (at(l, "available") ?? true) === true);
      const shaped = setKey(t, "locations", locations);
      const names = locations.map((l) => at(l, "name"));
      if (location === null ? locations.length > 0 : names.some((n) => n === location)) out.push(shaped);
    }
    return out;
  },
};

/** PHP's empty() */
const phpEmpty = (v: PhpValue | undefined): boolean => v === undefined || v === null || v === false || v === 0 || v === "" || v === "0" || (Array.isArray(v) && v.length === 0) || (isObj(v) && v.entries.length === 0);

/** $array[$key] = $value on a decoded PHP array (a list gains the key as an object, as PHP's array would). */
function setKey(v: PhpValue[] | PhpObject, key: string, value: PhpValue): PhpValue {
  const o = Array.isArray(v) ? obj(v.map((x, n): [string, PhpValue] => [String(n), x])) : obj([...v.entries]);
  const i = o.entries.findIndex(([k]) => k === key);
  if (i === -1) o.entries.push([key, value]);
  else o.entries[i] = [key, value];
  return o;
}

/** DigitalOceanService::request() */
export function digitalOceanClient(net: ProviderNetwork, token: string): ProviderClient {
  return {
    async request(method, endpoint, data = []) {
      const response = await providerSend(net, {
        method,
        url: `https://api.digitalocean.com/v2${endpoint}`,
        ...(method === "get" ? { query: data as Array<[string, string | number]> } : { json: data }),
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        timeoutMs: 30_000,
        retry: { tries: 3, sleep: resetBackoff },
      });
      if (!response.successful) {
        if (response.status === 429) throw new RateLimitError(retryAfterOf(response));
        throw new CloudProviderApiError("DigitalOcean", response.status, dataGet(response.json, "id"));
      }
      return response.json ?? [];
    },
  };
}

async function digitalOceanPaginated(client: ProviderClient, endpoint: string, key: string, data: Array<[string, string | number]> = []): Promise<PhpValue[]> {
  const all: PhpValue[] = [];
  let page = 1;
  let more: boolean;
  do {
    const response = await client.request("get", endpoint, [...data, ["page", page], ["per_page", 50]]);
    const items = at(response, key);
    if (items !== undefined && items !== null) all.push(...phpValues(items));
    more = !blank(dataGet(response, "links.pages.next"));
    page++;
  } while (more);
  return all;
}

/** `($item[$key] ?? true) === true` */
const trueOrMissing = (item: PhpValue, key: string): boolean => (at(typedArray(item), key) ?? true) === true;

/** DigitalOceanService: the catalog methods. */
export const digitalOcean = {
  regions: async (c: ProviderClient) => (await digitalOceanPaginated(c, "/regions", "regions")).filter((r) => trueOrMissing(r, "available")),
  sizes: async (c: ProviderClient) => (await digitalOceanPaginated(c, "/sizes", "sizes")).filter((s) => trueOrMissing(s, "available")),
  images: async (c: ProviderClient) => (await digitalOceanPaginated(c, "/images", "images", [["type", "distribution"]])).filter((i) => trueOrMissing(i, "public")),
  sshKeys: (c: ProviderClient) => digitalOceanPaginated(c, "/account/keys", "ssh_keys"),
};

/** VultrService::request() */
export function vultrClient(net: ProviderNetwork, token: string): ProviderClient {
  return {
    async request(method, endpoint, data = []) {
      const response = await providerSend(net, {
        method,
        url: `https://api.vultr.com/v2${endpoint}`,
        ...(method === "get" ? { query: data as Array<[string, string | number]> } : { json: data }),
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: 30_000,
        retry: { tries: 3, sleep: (attempt) => attempt * 100 },
      });
      if (!response.successful) {
        if (response.status === 429) throw new RateLimitError(retryAfterOf(response));
        throw new CloudProviderApiError("Vultr", response.status);
      }
      return response.json ?? [];
    },
  };
}

/** cursorFromNextLink(): the `cursor` of the next link's query (parse_url(…, PHP_URL_QUERY), parse_str()). */
function cursorFromNextLink(next: PhpValue | undefined): string | null {
  if (blank(next)) return null;
  const text = phpCastString(next) ?? "";
  const q = text.includes("?") ? text.slice(text.indexOf("?") + 1).split("#")[0]! : "";
  for (const part of q.split("&")) {
    const [k, v = ""] = part.split("=");
    if (k !== undefined && decodeURIComponent(k.replace(/\+/g, " ")) === "cursor") return decodeURIComponent(v.replace(/\+/g, " "));
  }
  return null;
}

async function vultrPaginated(client: ProviderClient, endpoint: string, key: string): Promise<PhpValue[]> {
  const all: PhpValue[] = [];
  let cursor: string | null = null;
  do {
    const query: Array<[string, string | number]> = [["per_page", 100]];
    if (cursor !== null) query.push(["cursor", cursor]);
    const response = await client.request("get", endpoint, query);
    const items = at(response, key);
    if (items !== undefined && items !== null) all.push(...phpValues(items));
    cursor = cursorFromNextLink(dataGet(response, "meta.links.next"));
  } while (cursor !== null);
  return all;
}

/** VultrService: the catalog methods. */
export const vultr = {
  regions: (c: ProviderClient) => vultrPaginated(c, "/regions", "regions"),
  plans: (c: ProviderClient) => vultrPaginated(c, "/plans", "plans"),
  operatingSystems: (c: ProviderClient) => vultrPaginated(c, "/os", "os"),
  sshKeys: (c: ProviderClient) => vultrPaginated(c, "/ssh-keys", "ssh_keys"),
};

/** HostingerService::request() */
export function hostingerClient(net: ProviderNetwork, token: string): ProviderClient {
  return {
    async request(method, endpoint, data = []) {
      const response = await providerSend(net, {
        method,
        url: `https://developers.hostinger.com${endpoint}`,
        ...(method === "get" ? { query: data as Array<[string, string | number]> } : { json: data }),
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        timeoutMs: 30_000,
        retry: {
          tries: method === "get" ? 3 : 1,
          sleep: (attempt) => attempt * 100,
          when: (f) => {
            const r = responseOf(f);
            return !r || r.status >= 500;
          },
        },
      });
      if (!response.successful) {
        if (response.status === 429) throw new RateLimitError(retryAfterOf(response));
        const m = dataGet(response.json, "message") ?? dataGet(response.json, "error") ?? "Unknown error";
        const text = phpCastString(m);
        // "Array to string conversion": Laravel's error handler makes the warning an ErrorException (code 0).
        if (text === null) throw new HostingerApiError("Array to string conversion", 0);
        throw new HostingerApiError(`Hostinger API error: ${text}`, response.status);
      }
      return response.json ?? [];
    },
  };
}

/** HostingerService: the catalog methods. */
export const hostinger = {
  dataCenters: (c: ProviderClient) => c.request("get", "/api/vps/v1/data-centers"),
  templates: (c: ProviderClient) => c.request("get", "/api/vps/v1/templates"),
  /** getCatalogItems(): the KVM VPS plans. */
  async catalog(c: ProviderClient): Promise<PhpValue> {
    const out: PhpValue[] = [];
    for (const item of phpValues(await c.request("get", "/api/billing/v1/catalog", [["category", "VPS"]]))) {
      if (!isPhpArray(item)) continue;
      const id = phpCastString(at(item, "id") ?? "");
      if (id === null) throw new HostingerApiError("Array to string conversion", 0);
      if (/-vps-kvm\d+$/.test(id)) out.push(item);
    }
    return out;
  },
  sshKeys: async (c: ProviderClient) => at(await c.request("get", "/api/vps/v1/public-keys"), "data") ?? [],
  postInstallScripts: async (c: ProviderClient) => at(await c.request("get", "/api/vps/v1/post-install-scripts"), "data") ?? [],
};
