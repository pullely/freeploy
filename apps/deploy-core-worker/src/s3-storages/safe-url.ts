// Derived from coollabsio/coolify@91b7e3e:app/Rules/SafeWebhookUrl.php (validate() and the IP checks it
// makes) and PHP's FILTER_VALIDATE_URL / parse_url() as that rule uses them (Apache-2.0), modified.
//
// The endpoint of an S3 storage must be an http(s) URL whose host is not —
// and does not resolve to — a loopback, private, link-local or reserved
// address, and is not localhost, *.local, *.internal or *.cluster.local.
// Coolify lets an instance operator allow internal targets (and localhost);
// Freeploy is one multi-tenant service and has no such list, so nothing
// internal is ever allowed, and the "private address" message ends after its
// first sentence (Coolify's goes on with a link to its Advanced settings).
// Host names are resolved through an injectable resolver (DNS over HTTPS by
// default), so tests never touch the network.

/** Looks a host name up: its A and AAAA addresses ([] when it has none). */
export type HostResolver = (host: string) => Promise<string[]>;

/** Cloudflare's DNS over HTTPS (JSON), A and AAAA. */
export const dohResolver: HostResolver = async (host) => {
  const ask = async (type: "A" | "AAAA"): Promise<string[]> => {
    try {
      const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return [];
      const body = (await r.json()) as { Answer?: Array<{ type: number; data: string }> };
      return (body.Answer ?? []).filter((a) => a.type === (type === "A" ? 1 : 28)).map((a) => a.data);
    } catch {
      return [];
    }
  };
  const [a, aaaa] = await Promise.all([ask("A"), ask("AAAA")]);
  return [...new Set([...a, ...aaaa])];
};

// ------------------------------------------------------------ PHP's URL functions

export interface ParsedUrl {
  scheme?: string;
  user?: string;
  pass?: string;
  host?: string;
  port?: number;
  path?: string;
  query?: string;
  fragment?: string;
}

/** parse_url() for the URLs an endpoint is: scheme://[user[:pass]@]host[:port][/path][?query][#fragment]. null where PHP answers false. */
export function parseUrl(value: string): ParsedUrl | null {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(value);
  if (!m) return null;
  const out: ParsedUrl = { scheme: m[1]! };
  let rest = m[2]!;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    out.fragment = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  const q = rest.indexOf("?");
  if (q >= 0) {
    out.query = rest.slice(q + 1);
    rest = rest.slice(0, q);
  }
  if (rest.startsWith("//")) {
    rest = rest.slice(2);
    const slash = rest.indexOf("/");
    let authority = slash >= 0 ? rest.slice(0, slash) : rest;
    if (slash >= 0) out.path = rest.slice(slash);
    const at = authority.lastIndexOf("@");
    if (at >= 0) {
      const userinfo = authority.slice(0, at);
      authority = authority.slice(at + 1);
      const colon = userinfo.indexOf(":");
      out.user = colon >= 0 ? userinfo.slice(0, colon) : userinfo;
      if (colon >= 0) out.pass = userinfo.slice(colon + 1);
    }
    let host = authority;
    let port: string | null = null;
    if (authority.startsWith("[")) {
      const end = authority.indexOf("]");
      if (end < 0) return null;
      host = authority.slice(0, end + 1);
      const after = authority.slice(end + 1);
      if (after.startsWith(":")) port = after.slice(1);
      else if (after !== "") return null;
    } else {
      const colon = authority.lastIndexOf(":");
      if (colon >= 0) {
        host = authority.slice(0, colon);
        port = authority.slice(colon + 1);
      }
    }
    if (port !== null && port !== "") {
      if (!/^\d+$/.test(port) || Number(port) > 65535) return null;
      out.port = Number(port);
    }
    if (host !== "") out.host = host;
    else if (port !== null || out.user !== undefined) return null;
  } else if (rest !== "") {
    out.path = rest;
  }
  return out;
}

/** The characters php_filter_url() keeps; FILTER_VALIDATE_URL fails on any other. */
const URL_CHARS = /^[A-Za-z0-9$\-_.+!*'(),{}|\\^~[\]`<>#%";/?:@&=]*$/;

/** _php_filter_validate_domain() with FILTER_FLAG_HOSTNAME. */
function validHostname(host: string): boolean {
  let s = host;
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (s.length === 0 || s.length > 253) return false;
  const alnum = (c: string | undefined) => c !== undefined && /[A-Za-z0-9]/.test(c);
  if (!alnum(s[0])) return false;
  let label = 1;
  for (let i = 0; i < s.length - 1; i++) {
    const c = s[i]!;
    if (c === ".") {
      if (s[i + 1] === "." || !alnum(s[i - 1]) || !alnum(s[i + 1])) return false;
      label = 1;
    } else {
      if (label > 63 || (c !== "-" && !alnum(c))) return false;
      label++;
    }
  }
  const last = s[s.length - 1]!;
  return label <= 63 && (last === "-" || alnum(last));
}

/** filter_var($value, FILTER_VALIDATE_URL). */
export function filterValidateUrl(value: unknown): boolean {
  if (typeof value !== "string" || value === "" || !URL_CHARS.test(value)) return false;
  const url = parseUrl(value);
  if (!url || !url.scheme) return false;
  const scheme = url.scheme.toLowerCase();
  if (url.host === undefined && !["mailto", "news", "file"].includes(scheme)) return false;
  if ((scheme === "http" || scheme === "https") && url.host !== undefined) {
    if (url.host.startsWith("[")) {
      if (!url.host.endsWith("]") || parseIpv6(url.host.slice(1, -1)) === null) return false;
    } else if (!validHostname(url.host)) return false;
  }
  const userinfo = /^[A-Za-z0-9\-._~!$&'()*+,;=:%]*$/;
  if ((url.user !== undefined && !userinfo.test(url.user)) || (url.pass !== undefined && !userinfo.test(url.pass))) return false;
  return true;
}

// ------------------------------------------------------------ addresses

/** filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4): four decimal octets, no leading zeros. */
export function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255) return null;
    out.push(Number(p));
  }
  return out;
}

/** inet_pton() of an IPv6 address: its 16 bytes, or null. */
export function parseIpv6(ip: string): number[] | null {
  if (!/^[0-9A-Fa-f:.]+$/.test(ip)) return null;
  let tail: number[] = [];
  let text = ip;
  const lastColon = ip.lastIndexOf(":");
  if (ip.includes(".")) {
    const v4 = parseIpv4(ip.slice(lastColon + 1));
    if (!v4) return null;
    tail = v4;
    text = ip.slice(0, lastColon + 1) + "0:0";
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (s: string) => (s === "" ? [] : s.split(":"));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  if ([...head, ...rest].some((g) => !/^[0-9A-Fa-f]{1,4}$/.test(g))) return null;
  const total = head.length + rest.length;
  if (halves.length === 1 ? total !== 8 : total > 7) return null;
  const words = [...head, ...Array<string>(8 - total).fill("0"), ...rest].map((g) => parseInt(g, 16));
  const bytes = words.flatMap((w) => [w >> 8, w & 0xff]);
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

function inCidr(bytes: number[], network: number[], prefix: number): boolean {
  for (let i = 0; i < prefix; i++) {
    const bit = (b: number[]) => (b[i >> 3]! >> (7 - (i & 7))) & 1;
    if (bit(bytes) !== bit(network)) return false;
  }
  return true;
}

function cidrs(list: string[], parse: (s: string) => number[] | null): Array<[number[], number]> {
  return list.map((c) => {
    const [net, prefix] = c.split("/");
    return [parse(net!)!, Number(prefix)];
  });
}

/** PHP's private and reserved ranges (FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) and SafeWebhookUrl's special-use ones: what is not public. */
const V4_NOT_PUBLIC = cidrs(
  ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32"],
  parseIpv4,
);
const V6_NOT_PUBLIC = cidrs(
  ["::/128", "::1/128", "::ffff:0:0/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/23", "2001:2::/48", "2001:db8::/32", "2002::/16", "fc00::/7", "fe80::/10", "ff00::/8"],
  parseIpv6,
);

/** extractIpv4FromMappedIpv6(): the IPv4 address of ::ffff:a.b.c.d. */
function mappedIpv4(v6: number[]): number[] | null {
  return v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff ? v6.slice(12) : null;
}

/** isAllowedIp() with no allowlist and no localhost: public, and not link-local. */
export function classifyIp(ip: string): "public" | "link-local" | "private" | null {
  let v4 = parseIpv4(ip);
  const v6 = v4 ? null : parseIpv6(ip);
  if (!v4 && !v6) return null;
  if (v6) v4 = mappedIpv4(v6);
  if (v4) {
    if (inCidr(v4, [169, 254, 0, 0], 16)) return "link-local";
    return V4_NOT_PUBLIC.some(([n, p]) => inCidr(v4!, n, p)) ? "private" : "public";
  }
  if (inCidr(v6!, parseIpv6("fe80::")!, 10)) return "link-local";
  return V6_NOT_PUBLIC.some(([n, p]) => inCidr(v6!, n, p)) ? "private" : "public";
}

// ------------------------------------------------------------ the rule

export const SAFE_URL_MESSAGES = {
  invalid: (a: string) => `The ${a} must be a valid URL.`,
  scheme: (a: string, schemes: string[]) => `The ${a} must use the ${schemes.join(" or ")} scheme.`,
  host: (a: string) => `The ${a} must contain a valid host.`,
  trailingDot: (a: string) => `The ${a} host must not end with a trailing dot.`,
  linkLocal: (a: string) => `The ${a} must not point to link-local addresses.`,
  resolvesLinkLocal: (a: string) => `The ${a} must not resolve to a link-local address.`,
  unresolved: (a: string) => `The ${a} host could not be resolved.`,
  /** privateTargetMessage(): the attribute's raw name, not its display name. */
  privateTarget: (rawAttribute: string) => `The ${rawAttribute} points to a local or private address that is not allowed.`,
} as const;

/**
 * SafeWebhookUrl::validate(): the first failure's message, or null. `display`
 * is the attribute as Laravel shows it (:attribute), `raw` its key (the
 * private-target message uses the key).
 */
export async function safeUrlError(value: unknown, display: string, raw: string, resolve: HostResolver, schemes: string[] = ["https", "http"]): Promise<string | null> {
  if (!filterValidateUrl(value)) return SAFE_URL_MESSAGES.invalid(display);
  const url = parseUrl(value as string)!;
  const scheme = (url.scheme ?? "").toLowerCase();
  if (!schemes.includes(scheme)) return SAFE_URL_MESSAGES.scheme(display, schemes);
  if (!url.host) return SAFE_URL_MESSAGES.host(display);
  if (url.host.endsWith(".")) return SAFE_URL_MESSAGES.trailingDot(display);
  const host = url.host.toLowerCase();
  const forIp = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const forDns = forIp.replace(/\.+$/, "");
  if (forDns === "localhost" || forDns.endsWith(".local") || forDns.endsWith(".internal") || forDns.endsWith(".cluster.local")) return SAFE_URL_MESSAGES.privateTarget(raw);
  const literal = classifyIp(forIp);
  if (literal) {
    if (literal === "public") return null;
    return literal === "link-local" ? SAFE_URL_MESSAGES.linkLocal(display) : SAFE_URL_MESSAGES.privateTarget(raw);
  }
  const ips = (await resolve(forDns)).filter((ip) => classifyIp(ip) !== null);
  if (ips.length === 0) return SAFE_URL_MESSAGES.unresolved(display);
  for (const ip of ips) {
    const kind = classifyIp(ip);
    if (kind !== "public") return kind === "link-local" ? SAFE_URL_MESSAGES.resolvesLinkLocal(display) : SAFE_URL_MESSAGES.privateTarget(raw);
  }
  return null;
}
