// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/api.php (serializeApiResponse,
// removeServerProxySecrets, invalidTokenResponse) and routes/api.php (the fallback route), and from PHP's
// json_encode() and Laravel's date serialization (Apache-2.0 / MIT / PHP-3.01), modified.
//
// What Coolify's /api/v1 answers look like on the wire, shared by the workers that answer them
// (identity-worker: tokens and teams; deploy-core-worker: everything else) and api-edge (the middleware):
// the JSON bytes PHP writes, the key order serializeApiResponse() gives, and Coolify's fixed bodies.

/** An ordered JSON object: PHP arrays keep insertion order, and their keys may look like numbers. */
export type PhpValue = null | boolean | number | string | PhpValue[] | PhpObject;
export interface PhpObject {
  readonly [phpObject]: true;
  entries: Array<[string, PhpValue]>;
}
const phpObject = Symbol("phpObject");

export function obj(entries: Array<[string, PhpValue]> | Record<string, PhpValue>): PhpObject {
  return { [phpObject]: true, entries: Array.isArray(entries) ? entries : Object.entries(entries) };
}

export function isObj(v: unknown): v is PhpObject {
  return typeof v === "object" && v !== null && (v as PhpObject)[phpObject] === true;
}

export function get(o: PhpObject, key: string): PhpValue | undefined {
  return o.entries.find(([k]) => k === key)?.[1];
}

export function put(o: PhpObject, key: string, value: PhpValue): PhpObject {
  const at = o.entries.findIndex(([k]) => k === key);
  if (at === -1) o.entries.push([key, value]);
  else o.entries[at] = [key, value];
  return o;
}

export function without(o: PhpObject, keys: readonly string[]): PhpObject {
  return obj(o.entries.filter(([k]) => !keys.includes(k)));
}

/** A plain JS value (from JSON or a row) as a PhpValue: objects keep their key order. */
export function fromJs(v: unknown): PhpValue {
  if (v === null || v === undefined) return null;
  if (isObj(v)) return v;
  if (Array.isArray(v)) return v.map(fromJs);
  if (v instanceof Date) return laravelDate(v);
  if (typeof v === "object") return obj(Object.entries(v as Record<string, unknown>).map(([k, x]): [string, PhpValue] => [k, fromJs(x)]));
  if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") return v;
  return String(v);
}

const HEX = "0123456789abcdef";
function escapeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i]!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "/") out += "\\/";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 0x20 || c > 0x7f) out += `\\u${HEX[(c >> 12) & 15]}${HEX[(c >> 8) & 15]}${HEX[(c >> 4) & 15]}${HEX[c & 15]}`;
    else out += ch;
  }
  return `${out}"`;
}

/**
 * json_encode($value) with PHP's default flags, as Laravel's response()->json() writes it: "/" escaped,
 * every character outside printable ASCII as \uXXXX (UTF-16 units). Numbers must be integers: PHP writes
 * a float with a ".0" that JavaScript cannot tell apart, and Coolify's API answers carry none.
 */
export function phpJsonEncode(value: PhpValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("phpJsonEncode: not a finite number");
    return String(value);
  }
  if (typeof value === "string") return escapeString(value);
  if (Array.isArray(value)) return `[${value.map(phpJsonEncode).join(",")}]`;
  return `{${value.entries.map(([k, v]) => `${escapeString(k)}:${phpJsonEncode(v)}`).join(",")}}`;
}

/** A Carbon date as Laravel serializes a model's dates: 2026-01-01T00:00:00.000000Z. */
export function laravelDate(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 19)}.${String(date.getUTCMilliseconds()).padStart(3, "0")}000Z`;
}

/** A date column without a cast, as PostgreSQL gives it to Eloquent: 2026-01-01 00:00:00. */
export function sqlDate(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/** PHP's truthiness, as data_get(...) in an `if` reads it. */
export function phpTruthy(v: PhpValue | undefined): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "" || v === "0") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isObj(v)) return v.entries.length > 0;
  return true;
}

/** ksort(SORT_REGULAR) on string keys: numeric strings by value, the rest byte by byte. */
function ksortCompare(a: string, b: string): number {
  const na = /^-?\d+(\.\d+)?$/.test(a);
  const nb = /^-?\d+(\.\d+)?$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

function prepend(entries: Array<[string, PhpValue]>, key: string, value: PhpValue): Array<[string, PhpValue]> {
  return [[key, value], ...entries.filter(([k]) => k !== key)];
}

/**
 * serializeApiResponse() for one model (or array): its keys sorted, created_at and updated_at moved to the
 * end, then name, description, uuid and id moved to the front, each only when it has a (truthy; for id,
 * non-null) value; then removeServerProxySecretsFromApiPayload().
 */
export function serializeApiResponse(data: PhpObject, canReadServerSecrets = false): PhpObject {
  let entries = [...data.entries].sort(([a], [b]) => ksortCompare(a, b));
  for (const k of ["created_at", "updated_at"]) {
    const v = entries.find(([key]) => key === k)?.[1];
    if (phpTruthy(v)) entries = [...entries.filter(([key]) => key !== k), [k, v!]];
  }
  for (const k of ["name", "description", "uuid"]) {
    const v = entries.find(([key]) => key === k)?.[1];
    if (phpTruthy(v)) entries = prepend(entries, k, v!);
  }
  const id = entries.find(([key]) => key === "id")?.[1];
  if (id !== null && id !== undefined) entries = prepend(entries, "id", id);
  const out = obj(entries);
  return canReadServerSecrets ? out : (removeServerProxySecrets(out) as PhpObject);
}

/** serializeApiResponse() of a collection: each item as above. */
export function serializeApiCollection(items: PhpObject[], canReadServerSecrets = false): PhpObject[] {
  return items.map((d) => serializeApiResponse(d, canReadServerSecrets));
}

/** removeServerProxySecrets(): a proxy's saved configuration and the validation logs, at any depth. */
export function removeServerProxySecrets(value: PhpValue): PhpValue {
  if (Array.isArray(value)) return value.map(removeServerProxySecrets);
  if (!isObj(value)) return value;
  let entries = value.entries;
  const proxy = entries.find(([k]) => k === "proxy")?.[1];
  if (isObj(proxy)) {
    entries = entries.map(([k, v]): [string, PhpValue] => (k === "proxy" ? [k, without(proxy, ["last_saved_proxy_configuration"])] : [k, v]));
    entries = entries.filter(([k]) => k !== "validation_logs");
  }
  return obj(entries.map(([k, v]): [string, PhpValue] => [k, Array.isArray(v) || isObj(v) ? removeServerProxySecrets(v) : v]));
}

/** An answer as Coolify gives it: the status, the exact bytes and the headers. A worker sends it with `new Response(a.body, a)`. */
export interface CoolifyAnswer {
  status: number;
  body: string;
  headers: Record<string, string>;
}

/** A JSON answer as Coolify's controllers give it. */
export function coolifyJson(body: PhpValue, status = 200, headers?: Record<string, string>): CoolifyAnswer {
  return { status, body: phpJsonEncode(body), headers: { "content-type": "application/json", ...headers } };
}

/** response('text'): Laravel's plain answer. */
export function coolifyText(text: string, status = 200): CoolifyAnswer {
  return { status, body: text, headers: { "content-type": "text/html; charset=utf-8" } };
}

/** Coolify's fixed answers, word for word. */
export const COOLIFY_API = {
  /** auth:sanctum without a valid token (Coolify's exception handler for an AuthenticationException). */
  unauthenticated: () => coolifyJson(obj({ message: "Unauthenticated." }), 401),
  /** EnsureTokenBelongsToCurrentTeamMember */
  invalidTokenTeam: () => coolifyJson(obj({ message: "Invalid token." }), 401),
  exceedsAccess: () => coolifyJson(obj({ message: "This API token has more access than you have in this team. Revoke it and create a new token." }), 403),
  /** invalidTokenResponse() */
  invalidToken: () => coolifyJson(obj({ message: "Invalid token.", docs: "https://coolify.io/docs/api-reference/authorization" }), 400),
  /** ApiAllowed */
  apiDisabled: () => coolifyJson(obj({ success: false, message: "API is disabled." }), 403),
  ipNotAllowed: () => coolifyJson(obj({ success: false, message: "You are not allowed to access the API." }), 403),
  /** ApiAbility */
  missingAbilities: (abilities: readonly string[]) => coolifyJson(obj({ message: `Missing required permissions: ${abilities.join(", ")}` }), 403),
  /** routes/api.php's Route::any('/{any}') — also every /api/v1 operation Freeploy has not ported. */
  notFound: () => coolifyJson(obj({ message: "Not found.", docs: "https://coolify.io/docs" }), 404),
  /** Gate::authorize() failing (AuthorizationException). */
  unauthorized: () => coolifyJson(obj({ message: "This action is unauthorized." }), 403),
  /** validateIncomingRequest() */
  notJson: () => coolifyJson(obj({ message: "Invalid request.", error: "Content-Type must be application/json." }), 400),
  invalidJson: () => coolifyJson(obj({ message: "Invalid request.", error: "Invalid JSON." }), 400),
  emptyJson: () => coolifyJson(obj({ message: "Invalid request.", error: "Empty JSON." }), 400),
  /** The version this API is: Coolify's at the commit Freeploy ports (config('constants.coolify.version')). */
  version: "4.7.6",
} as const;

/** The headers api-edge sends with an /api/v1 request it forwards (the token resolved). */
export const API_V1_HEADERS = {
  org: "x-api-v1-org",
  user: "x-api-v1-user",
  abilities: "x-api-v1-abilities",
  canReadSensitive: "x-api-v1-can-read-sensitive",
  tokenNumber: "x-api-v1-token",
} as const;
