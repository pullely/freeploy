// The PHP behaviour the notification ports depend on, byte for byte: json_encode() with its default flags
// (what Laravel's HTTP client and Guzzle send), trim(), ucfirst(), mb_strlen()/mb_substr() (code points),
// htmlspecialchars() and Laravel's e(), filled(), and data_get() on a button.
//
// A PHP array is a JS array when it is a list and a plain object when it has string keys. PHP has one empty
// array, so an empty object is encoded as [] too.

export type PhpValue = null | boolean | number | string | PhpValue[] | { [key: string]: PhpValue | undefined };

function hex4(code: number): string {
  return "\\u" + code.toString(16).padStart(4, "0");
}

/** A string as json_encode() writes it without flags: "/" escaped, everything outside ASCII as \uXXXX. */
export function phpJsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x2f) out += "\\/";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 0x20 || c > 0x7f) out += hex4(c);
    else out += s[i];
  }
  return out + '"';
}

/** json_encode($value) with PHP's default flags. Keys whose value is undefined are left out (unset). */
export function phpJsonEncode(value: PhpValue | undefined): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("json_encode: Inf and NaN cannot be JSON encoded");
    return String(value);
  }
  if (typeof value === "string") return phpJsonString(value);
  if (Array.isArray(value)) return "[" + value.map((v) => phpJsonEncode(v)).join(",") + "]";
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "[]";
  return "{" + entries.map(([k, v]) => phpJsonString(k) + ":" + phpJsonEncode(v)).join(",") + "}";
}

const TRIM_CHARS = " \t\n\r\0\x0B";

/** PHP's trim(): only " \t\n\r\0\x0B" unless a character list is given. */
export function phpTrim(s: string, chars = TRIM_CHARS): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start]!)) start++;
  while (end > start && chars.includes(s[end - 1]!)) end--;
  return s.slice(start, end);
}

export function phpRtrim(s: string, chars = TRIM_CHARS): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1]!)) end--;
  return s.slice(0, end);
}

/** ucfirst(): the first byte, ASCII only. */
export function ucfirst(s: string): string {
  const c = s.charCodeAt(0);
  return c >= 0x61 && c <= 0x7a ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** mb_strlen() in UTF-8: code points. */
export function mbStrlen(s: string): number {
  let n = 0;
  for (const ch of s) {
    void ch;
    n++;
  }
  return n;
}

/** mb_substr($s, $start, $length) for a start of 0 or more. */
export function mbSubstr(s: string, start: number, length?: number): string {
  const chars = Array.from(s);
  return chars.slice(start, length === undefined ? undefined : start + length).join("");
}

/** htmlspecialchars($s, ENT_QUOTES | ENT_HTML5, 'UTF-8'). */
export function htmlspecialcharsHtml5(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Laravel's e(): htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'). */
export function e(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

/** Laravel's filled(): not null, not a blank string, not an empty array. */
export function filled(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return phpTrim(v) !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** "Interpolation" of a PHP value in a double-quoted string: null and false are "", true is "1". */
export function str(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined || v === false) return "";
  if (v === true) return "1";
  return String(v);
}

/** str($fqdn)->explode(',')->first() when there is more than one domain; the value itself otherwise. */
export function firstFqdn(fqdn: string | null | undefined): string | null {
  if (fqdn === null || fqdn === undefined) return null;
  const parts = fqdn.split(",");
  return parts.length > 1 ? parts[0]! : fqdn;
}

/**
 * A button as the jobs read it: data_get($button, 'url') and data_get($button, 'text', 'Click here'). A button
 * that is not an array with keys (a string, a list) has neither.
 */
export type Button = PhpValue;

function buttonKeys(button: Button): { [key: string]: PhpValue | undefined } | null {
  return button !== null && typeof button === "object" && !Array.isArray(button) ? button : null;
}

export function buttonUrl(button: Button): string | null {
  const b = buttonKeys(button);
  const url = b?.url;
  return typeof url === "string" ? url : null;
}

export function buttonText(button: Button): string {
  const b = buttonKeys(button);
  if (!b || !("text" in b)) return "Click here";
  return typeof b.text === "string" ? b.text : "";
}
