// Derived from coollabsio/coolify@91b7e3e:app/Rules/SafeWebhookUrl.php (Apache-2.0), modified.
//
// The webhook URL rule of the Discord, Slack and webhook settings, and the check their jobs make again
// before they send. The messages are Coolify's. What a Worker cannot do: resolve the host name. Coolify
// looks up its A/AAAA records and refuses a host that resolves to a private address; here a host name is
// accepted as written, and only a literal IP address, `localhost` and the internal suffixes are refused.
// A Worker's fetch() goes out through Cloudflare's network, which has no route to the instance's private
// networks, so the lookup's purpose (no request into the operator's LAN) holds without it. There is no
// allowlist either (Coolify's instance settings `webhook_allowed_internal_hosts`): Freeploy is hosted.

const IPV4_PRIVATE_OR_RESERVED = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "0.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
];

const IPV6_SPECIAL_USE = [
  "::/128",
  "::1/128",
  "::ffff:0:0/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2001:2::/48",
  "2001:db8::/32",
  "2002::/16",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
];

function ipv4Bytes(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  // filter_var() refuses leading zeros ("010.0.0.1").
  if (parts.some((p, i) => p > 255 || (m[i + 1]!.length > 1 && m[i + 1]!.startsWith("0")))) return null;
  return parts;
}

function ipv6Bytes(input: string): number[] | null {
  if (!/^[0-9a-f:.]+$/i.test(input) || !input.includes(":")) return null;
  let ip = input;
  // A trailing IPv4 part (::ffff:192.0.2.1) is its two last groups.
  const lastColon = ip.lastIndexOf(":");
  if (ip.slice(lastColon + 1).includes(".")) {
    const b = ipv4Bytes(ip.slice(lastColon + 1));
    if (!b) return null;
    ip = ip.slice(0, lastColon + 1) + ((b[0]! << 8) | b[1]!).toString(16) + ":" + ((b[2]! << 8) | b[3]!).toString(16);
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === "" ? [] : s.split(":"));
  const left = parse(halves[0]!);
  const right = halves.length === 2 ? parse(halves[1]!) : [];
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length > 7) return null;
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push(v >> 8, v & 0xff);
  }
  return bytes;
}

function inCidr(bytes: number[], network: number[], prefix: number): boolean {
  const full = Math.floor(prefix / 8);
  for (let i = 0; i < full; i++) if (bytes[i] !== network[i]) return false;
  const bits = prefix % 8;
  if (bits === 0) return true;
  const mask = (0xff << (8 - bits)) & 0xff;
  return (bytes[full]! & mask) === (network[full]! & mask);
}

function matches(bytes: number[], cidrs: string[], parse: (s: string) => number[] | null): boolean {
  return cidrs.some((c) => {
    const [net, prefix] = c.split("/");
    const n = parse(net!);
    return n !== null && inCidr(bytes, n, Number(prefix));
  });
}

/** A literal IP address of the host: its kind and whether Coolify's isAllowedIp() would allow it (no allowlist). */
function classifyIp(host: string): { ip: boolean; allowed: boolean; linkLocal: boolean } {
  const v4 = ipv4Bytes(host);
  if (v4) {
    const linkLocal = inCidr(v4, [169, 254, 0, 0], 16);
    return { ip: true, linkLocal, allowed: !linkLocal && !matches(v4, IPV4_PRIVATE_OR_RESERVED, ipv4Bytes) };
  }
  const v6 = ipv6Bytes(host);
  if (!v6) return { ip: false, allowed: true, linkLocal: false };
  // An IPv4-mapped address (::ffff:a.b.c.d) is checked as its IPv4 address.
  if (v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff) {
    const mapped = classifyIp(v6.slice(12).join("."));
    return { ip: true, allowed: mapped.allowed, linkLocal: mapped.linkLocal };
  }
  const linkLocal = inCidr(v6, ipv6Bytes("fe80::")!, 10);
  return { ip: true, linkLocal, allowed: !linkLocal && !matches(v6, IPV6_SPECIAL_USE, ipv6Bytes) };
}

/** SafeWebhookUrl::validate(): the message for the field, or null when the URL may be used. */
export function safeWebhookUrlMessage(attribute: string, value: string, settingsUrl: string): string | null {
  // filter_var(FILTER_VALIDATE_URL): a scheme, "//", printable ASCII only.
  let url: URL;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[\x21-\x7e]+$/.test(value)) return `The ${attribute} must be a valid URL.`;
  try {
    url = new URL(value);
  } catch {
    return `The ${attribute} must be a valid URL.`;
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme !== "http" && scheme !== "https") return `The ${attribute} must use the http or https scheme.`;
  const rawHost = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/.exec(value)?.[1] ?? "";
  if (rawHost === "") return `The ${attribute} must contain a valid host.`;
  if (rawHost.endsWith(".")) return `The ${attribute} host must not end with a trailing dot.`;
  const host = rawHost.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  const privateTarget = `The ${attribute} points to a local or private address that is not allowed. Configure allowed internal targets: ${settingsUrl}`;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".cluster.local")) return privateTarget;
  const ip = classifyIp(host);
  if (ip.ip && !ip.allowed) return ip.linkLocal ? `The ${attribute} must not point to link-local addresses.` : privateTarget;
  return null;
}
