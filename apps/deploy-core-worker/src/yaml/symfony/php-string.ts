// Derived from symfony/yaml@v8.1.11:Parser.php (MIT), modified — the PHP string functions Parser.php and Inline.php use.
//
// PHP strings are bytes: strlen(), substr() and $s[$i] count bytes of the UTF-8 text. The port works on "byte strings" —
// a JavaScript string with one character (0–255) per byte — so that every offset, length and slice is PHP's, and turns
// the text it returns back into UTF-8.

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/** UTF-8 text → a byte string. */
export function toBytes(text: string): string {
  const bytes = encoder.encode(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

/** A byte string → UTF-8 text (invalid sequences as U+FFFD, as a JSON encoder that substitutes them would write). */
export function fromBytes(bytes: string): string {
  // ASCII needs no decoding.
  if (!/[\x80-\xff]/.test(bytes)) return bytes;
  const array = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) array[i] = bytes.charCodeAt(i);
  return decoder.decode(array);
}

const DEFAULT_TRIM = " \t\n\r\0\x0B";

/** PHP's ltrim(). */
export function ltrim(s: string, chars = DEFAULT_TRIM): string {
  let i = 0;
  while (i < s.length && chars.includes(s[i]!)) i++;
  return s.slice(i);
}

/** PHP's rtrim(). */
export function rtrim(s: string, chars = DEFAULT_TRIM): string {
  let j = s.length;
  while (j > 0 && chars.includes(s[j - 1]!)) j--;
  return s.slice(0, j);
}

/** PHP's trim(). */
export const trim = (s: string, chars = DEFAULT_TRIM): string => rtrim(ltrim(s, chars), chars);

/** PHP's strspn($s, $chars, $offset). */
export function strspn(s: string, chars: string, offset = 0): number {
  let i = offset;
  while (i < s.length && chars.includes(s[i]!)) i++;
  return Math.max(0, i - offset);
}

/** PHP's strcspn($s, $chars, $offset). */
export function strcspn(s: string, chars: string, offset = 0): number {
  let i = offset;
  while (i < s.length && !chars.includes(s[i]!)) i++;
  return Math.max(0, i - offset);
}

/** PHP's substr($s, $start[, $length]) for the non-negative starts and the lengths Symfony passes. */
export function substr(s: string, start: number, length?: number): string {
  const from = start < 0 ? Math.max(0, s.length + start) : start;
  if (length === undefined) return s.slice(from);
  const to = length < 0 ? s.length + length : from + length;
  return s.slice(from, Math.max(from, to));
}

/** substr_count($s, $needle[, $offset, $length]). */
export function substrCount(s: string, needle: string, offset = 0, length?: number): number {
  const hay = length === undefined ? s.slice(offset) : s.slice(offset, offset + length);
  let n = 0;
  let at = hay.indexOf(needle);
  while (at !== -1) {
    n++;
    at = hay.indexOf(needle, at + needle.length);
  }
  return n;
}
