// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/remoteProcess.php (Apache-2.0), modified: TypeScript ports, byte-equal to Coolify's output (held by tools/parity/commands goldens).
// remove_iip() runs Coolify's App\Services\Security\SensitiveDataRedactor (app/Services/Security/SensitiveDataRedactor.php,
// same commit and licence), ported below as an internal helper; helpers/ files do not import each other (see docker.ts).
//
// PHP runs these regular expressions over UTF-8 bytes without the `u` modifier, so `\s` is ASCII whitespace
// and `.` is any byte but "\n"; the JavaScript patterns spell those classes out instead of using `\s` and `.`,
// which are Unicode-aware in JavaScript.

export function remoteCommandWithTimeout(command: string, seconds = 20): string {
  return `timeout -k 5s ${seconds}s ${command}`;
}

export function remove_iip(text: unknown): string {
  return redactText(phpToString(text));
}

export function sanitize_utf8_text(text: string | null): string {
  // empty(): null, "" and "0".
  if (text === null || text === "" || text === "0") return "";
  // mb_convert_encoding($text, 'UTF-8', 'UTF-8') replaces each invalid sequence with "?". A JavaScript string
  // can only be invalid UTF-8 through an unpaired surrogate.
  return text.replace(LONE_SURROGATES, "?");
}

// ---------------------------------------------------------------------------
// PHP builtins
// ---------------------------------------------------------------------------

const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const byteLength = (value: string): number => encoder.encode(value).length;

function phpTrim(value: string): string {
  const chars = " \t\n\r\0\x0B";
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value.charAt(start))) start++;
  while (end > start && chars.includes(value.charAt(end - 1))) end--;
  return value.slice(start, end);
}

/** (string) of a float under PHP's default `precision` (14). */
function phpFloatToString(value: number): string {
  if (Number.isNaN(value)) return "NAN";
  if (value === Infinity) return "INF";
  if (value === -Infinity) return "-INF";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const sign = value < 0 ? "-" : "";
  const [mantissa = "0", exp = "0"] = Math.abs(value).toExponential(13).split("e");
  const exponent = Number(exp);
  const digits = mantissa.replace(".", "").replace(/0+$/, "") || "0";
  if (exponent < -4 || exponent >= 14) {
    const frac = digits.length > 1 ? digits.slice(1) : "0";
    return `${sign}${digits.charAt(0)}.${frac}E${exponent < 0 ? "-" : "+"}${Math.abs(exponent)}`;
  }
  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  if (digits.length <= exponent + 1) return `${sign}${digits}${"0".repeat(exponent + 1 - digits.length)}`;
  return `${sign}${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
}

/** PHP's (string) cast of a JSON-decodable value. */
function phpToString(value: unknown): string {
  if (value === null || value === undefined || value === false) return "";
  if (value === true) return "1";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : phpFloatToString(value);
  if (typeof value === "bigint") return value.toString();
  return "Array";
}

/** json_encode() of a string with PHP's default flags: "/" and every non-ASCII unit escaped, lowercase hex. */
function phpJsonEncodeString(value: string): string {
  let out = '"';
  for (const ch of value.replace(LONE_SURROGATES, "�")) {
    for (let i = 0; i < ch.length; i++) {
      const code = ch.charCodeAt(i);
      const c = ch.charAt(i);
      if (c === '"') out += '\\"';
      else if (c === "\\") out += "\\\\";
      else if (c === "/") out += "\\/";
      else if (c === "\b") out += "\\b";
      else if (c === "\f") out += "\\f";
      else if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else if (code < 0x20 || code > 0x7f) out += "\\u" + code.toString(16).padStart(4, "0");
      else out += c;
    }
  }
  return out + '"';
}

/** rawurlencode(): RFC 3986 unreserved characters kept, every other UTF-8 byte as %XX. */
function rawurlencode(value: string): string {
  let out = "";
  for (const byte of encoder.encode(value)) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-_.~]/.test(c) ? c : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

const escapeRegExp = (value: string): string => value.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

// ---------------------------------------------------------------------------
// app/Services/Security/SensitiveDataRedactor.php (redactText, with email redaction on, as app() resolves it)
// ---------------------------------------------------------------------------

const REDACTED = "<REDACTED>";
const FAILURE_MESSAGE = "[LOG SUPPRESSED: REDACTION FAILED]";
const CHUNK_BYTES = 262144;
const MIN_KNOWN_SECRET_LENGTH = 8;
const SENSITIVE_KEYS = [
  "password", "passwd", "secret", "client_secret", "api_key", "apikey", "access_key", "private_key", "token", "access_token",
  "refresh_token", "auth_token", "authorization", "proxy_authorization", "cookie", "set_cookie", "webhook_secret",
  "signing_secret", "credential", "credentials", "connection_string", "database_url",
];

/** PCRE's non-UTF `\s`. */
const WS = String.raw`[\t\n\v\f\r ]`;

// PCRE's `(?i:…)` over ASCII, spelled out per letter so the pattern needs no regex modifiers.
const caseless = (value: string): string => value.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
const ASSIGNMENT_KEYS = SENSITIVE_KEYS.filter((key) => key !== "authorization" && key !== "proxy_authorization");
const KEYS =
  `(?:(?:[a-zA-Z0-9]+[_-])*(?:${ASSIGNMENT_KEYS.map(caseless).join("|")}))` +
  "|[A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*";
const VALUE = String.raw`(?<value>"(?:[^"\\\r\n]|\\[^\n])*"|'(?:[^'\\\r\n]|\\[^\n])*'|[^\t\n\v\f\r ,;}\]]+)`;
const ALREADY_REDACTED = `(?!${REDACTED})`;
const WRAPPED_ASSIGNMENT = new RegExp(String.raw`(?<![\w-])(["'])((?:${KEYS})${WS}*=${WS}*)${ALREADY_REDACTED}(?:(?!\1)[^\r\n])*\1`, "g");
const ASSIGNMENT = new RegExp(
  String.raw`(?<![\w-])(?<prefix>["']?(?<key>${KEYS})["']?${WS}*(?<separator>[=:])${WS}*)${ALREADY_REDACTED}${VALUE}`,
  "g",
);
// PHP's `(?<end>(?=[^\S\r\n]*(?:$|[\r\n,;}\]])))?` under /m, evaluated where the value ends: JavaScript never
// records an optional group that matched the empty string, so it is tested on the rest of the text.
const ENDS_VALUE = /^[\t\v\f ]*(?:[\r\n,;}\]]|$)/;

const PRIVATE_KEY_BEGIN_WITHOUT_END = /-----BEGIN [A-Z ]*PRIVATE KEY-----(?![\s\S]*-----END [A-Z ]*PRIVATE KEY-----)/;
const PRIVATE_KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;

const PATTERNS: [RegExp, (match: string, ...groups: string[]) => string][] = [
  [new RegExp(String.raw`((?:Authorization|Proxy-Authorization)${WS}*:${WS}*)[^\r\n]+`, "gi"), (_m, p1) => p1 + REDACTED],
  [/x-access-token:[^\n]*?(?=@)/g, () => "x-access-token:" + REDACTED],
  [/oauth2:[^\n]*?(?=@)/g, () => "oauth2:" + REDACTED],
  [
    /((?:https?|postgres|mysql|mongodb|rediss?|mariadb|ftp|sftp|ssh|amqp|amqps|ldap|ldaps|s3):\/\/[^:\t\n\v\f\r @/]+:)[^@\t\n\v\f\r ]+(@)/gi,
    (_m, p1, p2) => p1 + REDACTED + p2,
  ],
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, () => REDACTED],
  [new RegExp(String.raw`Bearer${WS}+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+`, "gi"), () => "Bearer " + REDACTED],
  [new RegExp(String.raw`Bearer${WS}+[^\t\n\v\f\r ,;]+`, "gi"), () => "Bearer " + REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9.\-_]{36,}(?![A-Za-z0-9.\-_])/g, () => REDACTED],
  [/\b(gl(?:pat|cbt|rt)-[A-Za-z0-9\-_]{20,})\b/g, () => REDACTED],
  [/\b(A(?:KIA|BIA|CCA|SIA)[A-Z0-9]{16})\b/g, () => REDACTED],
  [
    new RegExp(String.raw`(aws_secret_access_key|AWS_SECRET_ACCESS_KEY)[=:]${WS}*['"]?([A-Za-z0-9/+=]{40})['"]?`, "gi"),
    (_m, p1) => p1 + "=" + REDACTED,
  ],
  [
    new RegExp(String.raw`(api[_-]?key|apikey|api[_-]?secret|secret[_-]?key)[=:]${WS}*['"]?[A-Za-z0-9\-_]{16,}['"]?`, "gi"),
    (_m, p1) => p1 + "=" + REDACTED,
  ],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, () => REDACTED],
];

type Scalar = string | number | boolean;

function redactText(text: string, knownSecrets: Scalar[] = [], lockedSecrets: Scalar[] = []): string {
  try {
    let normalized = normalizeText(text);
    normalized = replaceKnownSecrets(normalized, knownSecrets, lockedSecrets);
    let redacted = "";
    for (const chunk of chunks(normalized)) redacted += redactChunk(chunk);
    return redacted;
  } catch {
    return FAILURE_MESSAGE;
  }
}

/**
 * PHP falls back to line-by-line redaction when a pattern hits a PCRE backtracking limit; JavaScript's engine
 * has no such limit, so that branch never runs here.
 */
function redactChunk(chunk: string): string {
  return redactAssignments(redactPatterns(chunk));
}

function normalizeText(text: string): string {
  return sanitize_utf8_text(text)
    .replace(/\x1B(?:[@-Z\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/** Split on line boundaries every CHUNK_BYTES UTF-8 bytes; a chunk never ends inside a private key block. */
function* chunks(text: string): Generator<string> {
  const bytes = encoder.encode(text);
  const length = bytes.length;
  const lineEnd = (position: number): number => {
    if (position >= length) return length;
    const newline = bytes.indexOf(0x0a, position);
    return newline === -1 ? length : newline + 1;
  };
  const slice = (from: number, to: number): string => decoder.decode(bytes.subarray(from, to));
  let offset = 0;
  while (offset < length) {
    let end = lineEnd(offset + CHUNK_BYTES);
    let chunk = slice(offset, end);
    if (PRIVATE_KEY_BEGIN_WITHOUT_END.test(chunk)) {
      const rest = slice(end, length);
      const match = PRIVATE_KEY_END.exec(rest);
      end = match !== null ? lineEnd(end + byteLength(rest.slice(0, match.index)) + byteLength(match[0])) : length;
      chunk = slice(offset, end);
    }
    yield chunk;
    offset = end;
  }
}

function replaceKnownSecrets(text: string, knownSecrets: Scalar[], lockedSecrets: Scalar[]): string {
  const variants: string[] = [];
  const shortVariants: string[] = [];
  for (const [secrets, minimumLength] of [[knownSecrets, MIN_KNOWN_SECRET_LENGTH], [lockedSecrets, 1]] as const) {
    for (const raw of secrets) {
      const secret = phpToString(raw);
      if (phpTrim(secret) === "" || byteLength(secret) < minimumLength) continue;
      const json = phpJsonEncodeString(secret);
      // Short locked values such as "ab" would hit inside ordinary words, so they only match as whole tokens.
      (byteLength(secret) < MIN_KNOWN_SECRET_LENGTH ? shortVariants : variants).push(secret, rawurlencode(secret), json.slice(1, -1));
    }
  }
  const byLengthDescending = (left: string, right: string): number => byteLength(right) - byteLength(left);
  // array_filter() drops "" and "0"; array_unique() keeps the first occurrence; usort() is stable.
  const longOnes = [...new Set(variants.filter((v) => v !== "" && v !== "0"))].sort(byLengthDescending);
  for (const variant of longOnes) text = text.split(variant).join(REDACTED);

  // The text is valid UTF-8 after normalization, so a variant that is not valid UTF-8 cannot appear in it.
  const shortOnes = [...new Set(shortVariants.filter((v) => v !== "" && !new RegExp(LONE_SURROGATES.source).test(v)))].sort(
    byLengthDescending,
  );
  if (shortOnes.length === 0) return text;
  const alternatives = shortOnes.map(escapeRegExp).join("|");
  return text.replace(new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])(?:${alternatives})(?![\\p{L}\\p{M}\\p{N}_])`, "gu"), REDACTED);
}

function redactAssignments(text: string): string {
  // A quote that opens before the key and closes after the value wraps the whole assignment, as in
  // the shell argument 'DB_PASSWORD=a b'. Hide everything up to the closing quote and keep the quote.
  const unwrapped = text.replace(WRAPPED_ASSIGNMENT, (_m, quote: string, assignment: string) => quote + assignment + REDACTED + quote);
  return unwrapped.replace(ASSIGNMENT, (...args: unknown[]) => {
    const match = args[0] as string;
    const groups = args[args.length - 1] as { prefix: string; key: string; separator: string; value: string };
    const offset = args[args.length - 3] as number;
    const subject = args[args.length - 2] as string;
    const value = groups.value;
    const first = value.charAt(0);
    const quote = value.length > 1 && (first === '"' || first === "'") && value.endsWith(first) ? first : "";
    const endsValue = ENDS_VALUE.test(subject.slice(offset + match.length));
    // Prose such as "Failed to refresh token: Connection refused" uses a plain word key, a colon, and a plain word value.
    const prefixFirst = groups.prefix.charAt(0);
    const isProse =
      quote === "" &&
      groups.separator === ":" &&
      prefixFirst !== '"' &&
      prefixFirst !== "'" &&
      /^[A-Za-z][a-z]*$/.test(groups.key) &&
      /^[A-Za-z]+$/.test(value) &&
      !endsValue;
    return isProse ? match : groups.prefix + quote + REDACTED + quote;
  });
}

function redactPatterns(text: string): string {
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement);
  return text;
}
