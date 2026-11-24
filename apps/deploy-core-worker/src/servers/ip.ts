// Derived from coollabsio/coolify@91b7e3e:app/Rules/{ValidServerIp,ValidHostname}.php,
// app/Models/Server.php (normalizeIp) and bootstrap/helpers/shared.php (normalizeIpAddress)
// (Apache-2.0), modified.
//
// PHP's filter_var(FILTER_VALIDATE_IP) and inet_ntop(inet_pton()) as used by
// Coolify's server address rules, without PHP.

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
/** FILTER_FLAG_IPV4: four decimal octets, no leading zeros. */
const IPV4_RE = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);
const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;

export function isIpv4(value: string): boolean {
  return IPV4_RE.test(value);
}

/** The eight 16-bit words of an IPv6 address (FILTER_FLAG_IPV6's syntax), or null. */
export function parseIpv6(value: string): number[] | null {
  if (!value.includes(":")) return null;
  let text = value;
  let tailWords: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const last = text.slice(lastColon + 1);
  if (last.includes(".")) {
    // An embedded IPv4 address takes the last two words.
    if (!isIpv4(last)) return null;
    const o = last.split(".").map(Number);
    tailWords = [(o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!];
    text = text.slice(0, lastColon + 1);
    // "::1.2.3.4" leaves "::", "1:2:…:6:1.2.3.4" leaves "…:6:": drop the separator that is not part of "::".
    if (!text.endsWith("::")) text = text.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string | undefined): string[] | null => {
    if (part === undefined || part === "") return [];
    const g = part.split(":");
    return g.every((x) => HEX_GROUP.test(x)) ? g : null;
  };
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (!head || !tail) return null;
  const explicit = head.length + tail.length + tailWords.length;
  const words = [...head, ...tail].map((g) => parseInt(g, 16));
  if (halves.length === 2) {
    if (explicit > 7) return null;
    return [...head.map((g) => parseInt(g, 16)), ...new Array<number>(8 - explicit).fill(0), ...tail.map((g) => parseInt(g, 16)), ...tailWords];
  }
  if (explicit !== 8) return null;
  return [...words, ...tailWords];
}

export function isIpv6(value: string): boolean {
  return parseIpv6(value) !== null;
}

/** inet_ntop() for AF_INET6 (glibc / BIND): lower case, the longest run of two or more zero words as "::". */
export function formatIpv6(words: number[]): string {
  let best = { base: -1, len: 0 };
  let cur = { base: -1, len: 0 };
  for (let i = 0; i < 8; i++) {
    if (words[i] === 0) {
      if (cur.base === -1) cur = { base: i, len: 1 };
      else cur.len++;
    } else if (cur.base !== -1) {
      if (best.base === -1 || cur.len > best.len) best = cur;
      cur = { base: -1, len: 0 };
    }
  }
  if (cur.base !== -1 && (best.base === -1 || cur.len > best.len)) best = cur;
  if (best.base !== -1 && best.len < 2) best = { base: -1, len: 0 };
  let out = "";
  for (let i = 0; i < 8; i++) {
    if (best.base !== -1 && i >= best.base && i < best.base + best.len) {
      if (i === best.base) out += ":";
      continue;
    }
    if (i !== 0) out += ":";
    // An IPv4-compatible or IPv4-mapped address keeps its dotted tail.
    if (i === 6 && best.base === 0 && (best.len === 6 || (best.len === 7 && words[7] !== 1) || (best.len === 5 && words[5] === 0xffff))) {
      out += [words[6]! >> 8, words[6]! & 0xff, words[7]! >> 8, words[7]! & 0xff].join(".");
      return out;
    }
    out += words[i]!.toString(16);
  }
  if (best.base !== -1 && best.base + best.len === 8) out += ":";
  return out;
}

/** normalizeIpAddress(): an IPv6 address in its short lower-case form; anything else as it is (trimmed). */
export function normalizeIpAddress(value: string): string {
  const trimmed = value.trim();
  const withoutBrackets = trimmed.replace(/^\[+|\]+$/g, "");
  const words = parseIpv6(withoutBrackets);
  return words ? formatIpv6(words) : trimmed;
}

/** Server::normalizeIp(): unsafe characters removed (IPv6 brackets too), then normalizeIpAddress(). */
export function normalizeServerIp(value: string | null | undefined): string {
  return normalizeIpAddress(String(value ?? "").replace(/[^0-9a-zA-Z.:%-]/g, ""));
}

const DANGEROUS = [";", "|", "&", "$", "`", "(", ")", "{", "}", "<", ">", "\n", "\r", "\0", '"', "'", "\\", "!", "*", "?", "[", "]", "~", "^", ":", "#", "@", "%", "=", "+", ",", " "];
const INVALID_CHARACTERS = "contains invalid characters. Only letters (a-z, A-Z), numbers (0-9), hyphens (-), and dots (.) are allowed.";

/** ValidHostname (RFC 1123): the failure message for `attribute`, or null. Empty values pass. */
export function hostnameError(attribute: string, value: string): string | null {
  if (value === "") return null;
  let hostname = value.trim();
  // strlen(): bytes.
  if (new TextEncoder().encode(hostname).length > 253) return `The ${attribute} must not exceed 253 characters.`;
  if (/[\x00-\x1f\x7f]/.test(hostname)) return `The ${attribute} ${INVALID_CHARACTERS}`;
  if (DANGEROUS.some((c) => hostname.includes(c))) return `The ${attribute} ${INVALID_CHARACTERS}`;
  hostname = hostname.toLowerCase();
  if (hostname.startsWith(".") || hostname.endsWith(".")) return `The ${attribute} cannot start or end with a dot.`;
  if (hostname.includes("..")) return `The ${attribute} cannot contain consecutive dots.`;
  for (const label of hostname.split(".")) {
    const bytes = new TextEncoder().encode(label).length;
    if (bytes < 1 || bytes > 63) return `The ${attribute} contains an invalid label. Each segment must be 1-63 characters.`;
    if (label.startsWith("-") || label.endsWith("-")) return `The ${attribute} contains an invalid label. Labels cannot start or end with a hyphen.`;
    if (!/^[a-z0-9-]+$/.test(label)) return `The ${attribute} ${INVALID_CHARACTERS}`;
  }
  return null;
}

/**
 * ValidServerIp: an IPv4 address, an IPv6 address (optionally in brackets) or
 * an RFC 1123 hostname. Laravel's :attribute for the `ip` field is "ip".
 */
export function serverIpError(attribute: string, value: string): string | null {
  if (value === "" || value === "0") return null; // empty($value)
  const trimmed = value.trim();
  if (isIpv4(trimmed) || isIpv6(trimmed)) return null;
  if (trimmed.startsWith("[") && trimmed.endsWith("]") && isIpv6(trimmed.slice(1, -1))) return null;
  return hostnameError(attribute, trimmed) === null ? null : `The ${attribute} must be a valid IPv4 address, IPv6 address, or hostname.`;
}
