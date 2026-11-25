// The PHP builtins the deployment code relies on, with the semantics that
// reach a command, a file or a log line. Nothing here is Coolify's: these are
// PHP's own escapeshellarg(), trim(), (float), (string), is_numeric(),
// base64_encode() and json_encode() as PHP 8.3 runs them.

/** PHP's escapeshellarg() on Linux: single-quote, `'` becomes `'\''`. PHP 8 throws on a NUL byte. */
export function escapeshellarg(value: string): string {
  if (value.includes("\0")) throw new Error("escapeshellarg(): Argument #1 ($arg) must not contain any null bytes");
  return "'" + value.split("'").join("'\\''") + "'";
}

const PHP_TRIM = " \t\n\r\0\x0B";

/** PHP's trim() with its default character list, not JavaScript's Unicode whitespace. */
export function phpTrim(value: string, characters = PHP_TRIM): string {
  let start = 0;
  let end = value.length;
  while (start < end && characters.includes(value.charAt(start))) start++;
  while (end > start && characters.includes(value.charAt(end - 1))) end--;
  return value.slice(start, end);
}

export function phpRtrim(value: string, characters = PHP_TRIM): string {
  let end = value.length;
  while (end > 0 && characters.includes(value.charAt(end - 1))) end--;
  return value.slice(0, end);
}

export function phpLtrim(value: string, characters = PHP_TRIM): string {
  let start = 0;
  while (start < value.length && characters.includes(value.charAt(start))) start++;
  return value.slice(start);
}

const encoder = new TextEncoder();

/** base64_encode() of the UTF-8 bytes of a string. */
export function base64Encode(text: string): string {
  let binary = "";
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** base64_decode($text, true) as a string of bytes (one char per byte), or null when it is not base64. */
export function base64DecodeStrict(text: string): string | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) return null;
  try {
    return atob(text);
  } catch {
    return null;
  }
}

/** The string as UTF-8, when its chars are bytes of valid UTF-8; null otherwise. */
export function utf8FromBinary(binary: string): string | null {
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** strlen(): the number of UTF-8 bytes. */
export const byteLength = (text: string): number => encoder.encode(text).length;

/** is_numeric() for a string: optional whitespace around a decimal or exponent number. */
export function isNumericString(value: string): boolean {
  return /^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\v\f]*$/.test(value);
}

/** (float) of a string: the leading number, or 0. */
export function floatval(value: string | number | null): number {
  if (typeof value === "number") return value;
  if (value === null) return 0;
  const match = /^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(value);
  return match ? Number(match[0]) : 0;
}

/** (int) of a string: the leading integer, or 0. */
export function intval(value: string | number | null): number {
  if (typeof value === "number") return Math.trunc(value);
  if (value === null) return 0;
  if (isNumericString(value)) return Math.trunc(Number(value));
  const match = /^[ \t\n\r\v\f]*[+-]?\d+/.exec(value);
  return match ? Number(match[0]) : 0;
}

/** (string) of a float under PHP's default `precision` (14): "0.1", "1.0E+25", "-0", "INF". */
export function phpFloatToString(value: number): string {
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

/** json_encode() of a string with PHP's defaults: "/" and every non-ASCII character escaped. */
export function phpJsonString(value: string): string {
  return JSON.stringify(value)
    .replace(/\//g, "\\/")
    .replace(/[\x7f-\u{ffff}]/gu, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** rawurlencode(): everything but A-Z a-z 0-9 - _ . ~ as %XX of its UTF-8 bytes. */
export function rawurlencode(value: string): string {
  let out = "";
  for (const byte of encoder.encode(value)) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-_.~]/.test(c) ? c : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** preg_quote($text, '/'). */
export function pregQuote(text: string): string {
  return text.replace(/[.\\+*?[^\]$(){}=!<>|:\-#/]/g, "\\$&");
}

/** json_validate(). */
export function jsonValidate(text: string): boolean {
  try {
    JSON.parse(text);
    // PHP's parser refuses what JSON.parse refuses, and neither takes an empty text.
    return true;
  } catch {
    return false;
  }
}
