// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/shared.php (isBase64Encoded,
// decodeBase64EncodedLabels) and app/Models/Application.php (parseContainerLabels) (Apache-2.0), modified.
//
// applications.custom_labels: the container labels as one text, a label per line, stored as base64 —
// Coolify's format, kept so that a row means the same to both. Older rows hold the text itself, or the
// text encoded more than once; parseContainerLabels() reads all three and rewrites the row as base64 of
// the text. PHP strings are bytes, so base64 is handled on bytes here ("binary strings": one character
// per byte) and only the result is read as UTF-8.

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function utf8ToBinary(text: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(text)) out += String.fromCharCode(byte);
  return out;
}

/** The text of a binary string, or null when its bytes are not UTF-8 (mb_detect_encoding(…, 'UTF-8', true) === false). */
function binaryToUtf8(binary: string): string | null {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** base64_encode(base64_decode($value, true)) === $value, for a binary string. */
function isBase64Binary(binary: string): boolean {
  // Strict decoding accepts only the alphabet and correct padding; the round trip also needs the unused bits to be zero.
  return BASE64_RE.test(binary) && btoa(atob(binary)) === binary;
}

/** isBase64Encoded() */
export function isBase64Encoded(value: string): boolean {
  return isBase64Binary(utf8ToBinary(value));
}

/** base64_encode() of a text's UTF-8 bytes. */
export function encodeLabels(labels: string): string {
  return btoa(utf8ToBinary(labels));
}

const onlyLabels = (text: string): boolean => text.split(/\r\n|\n|\r/).every((line) => line === "" || (line.includes("=") && !line.startsWith("=")));

/**
 * decodeBase64EncodedLabels(): the labels of a base64 value, or null when the value is not base64 or
 * does not decode to UTF-8. A value encoded several times is decoded as far as each layer is still
 * base64 and the result still reads as labels ("key=value" lines).
 */
export function decodeBase64EncodedLabels(value: string): string | null {
  const stored = utf8ToBinary(value);
  if (!isBase64Binary(stored)) return null;
  let decoded = atob(stored);
  let labels = decoded;
  while (decoded !== "" && isBase64Binary(decoded)) {
    decoded = atob(decoded);
    const text = binaryToUtf8(decoded);
    if (text !== null && onlyLabels(text)) labels = decoded;
  }
  return binaryToUtf8(labels);
}

/**
 * Application::parseContainerLabels(): the labels text of a stored custom_labels value, and the value
 * the row is rewritten to (base64 of that text). Nothing stored ("" and "0" included) is null and
 * leaves the row alone. A value that is base64 of something that is not text is replaced by the
 * generated labels.
 */
export function parseContainerLabels(stored: string | null, generate: () => string[]): { labels: string | null; store: string | null } {
  if (stored === null || stored === "" || stored === "0") return { labels: null, store: stored };
  let labels = decodeBase64EncodedLabels(stored);
  if (labels === null) labels = isBase64Encoded(stored) ? generate().join("\n") : stored;
  return { labels, store: encodeLabels(labels) };
}
