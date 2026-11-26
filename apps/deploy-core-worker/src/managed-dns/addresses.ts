// Derived from coollabsio/coolify@91b7e3e:app/Services/Dns/ServerDnsAddresses.php, app/Support/DnsRecordHints.php
// (isPublicAddress, sameAddress, NO_PUBLIC_ADDRESS_MESSAGE) and bootstrap/helpers/shared.php (resolveServerIpAddress)
// (Apache-2.0), modified.
//
// The addresses a server's DNS records may point to: its public IPv4 and IPv6 (server_settings), else its own address
// when that is of the family, only the public ones (PHP's FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE as PHP 8.3
// applies them, then CGNAT and multicast), IPv4 first. A server address that is a host name is resolved through the
// resolver Freeploy asks names with (DNS over HTTPS; Coolify asks the system's resolver and caches the answer).
import type { DeployDnsServerRow } from "@saas/db/deploy";
import { isIpv4, parseIpv6 } from "../servers/ip.js";

export const NO_PUBLIC_ADDRESS_MESSAGE = "The server has no public IP address; add the DNS record manually.";

/** A host name's addresses (A records first). */
export type DnsResolver = (host: string) => Promise<string[]>;

/** inet_pton(): the address's bytes (4 or 16), or null. */
export function inetPton(value: string): number[] | null {
  if (isIpv4(value)) return value.split(".").map(Number);
  const words = parseIpv6(value);
  return words ? words.flatMap((w) => [w >> 8, w & 0xff]) : null;
}

/** filter_var($address, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false (PHP 8.3). */
function notPrivateOrReserved(bytes: number[]): boolean {
  if (bytes.length === 4) {
    const [a, b] = bytes as [number, number];
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
    return !(a === 0 || a >= 240 || a === 127 || (a === 169 && b === 254));
  }
  const w = Array.from({ length: 8 }, (_, i) => (bytes[2 * i]! << 8) | bytes[2 * i + 1]!);
  if (w[0]! >= 0xfc00 && w[0]! <= 0xfdff) return false;
  const unspecifiedOrLoopback = w.slice(0, 7).every((x) => x === 0) && (w[7] === 0 || w[7] === 1);
  // PHP compares the first word with 0x5f (not 0x5f00), so 5f00::/8 passes.
  return !(unspecifiedOrLoopback || w[0] === 0x5f || (w[0]! >= 0xfe80 && w[0]! <= 0xfebf) || (w[0] === 0x2001 && (w[1] === 0x0db8 || (w[1]! >= 0x0010 && w[1]! <= 0x001f))) || w[0] === 0x3ff3);
}

/** DnsRecordHints::isPublicAddress(): an IPv4-mapped IPv6 address is judged as its IPv4 address. */
export function isPublicAddress(address: string): boolean {
  let bytes = inetPton(address);
  if (bytes === null) return false;
  if (bytes.length === 16 && bytes.slice(0, 10).every((x) => x === 0) && bytes[10] === 0xff && bytes[11] === 0xff) bytes = bytes.slice(12);
  if (!notPrivateOrReserved(bytes)) return false;
  if (bytes.length === 4) {
    const cgnat = bytes[0] === 100 && (bytes[1]! & 0xc0) === 64;
    return !cgnat && (bytes[0]! & 0xf0) !== 224;
  }
  return bytes[0] !== 0xff;
}

/** DnsRecordHints::sameAddress(): IP addresses compared as bytes (trimmed), anything else as text. */
export function sameAddress(first: string | null | undefined, second: string | null | undefined): boolean {
  if (first === null || first === undefined || second === null || second === undefined) return false;
  const a = inetPton(phpTrim(first));
  const b = inetPton(phpTrim(second));
  if (a !== null && b !== null) return a.length === b.length && a.every((x, i) => x === b[i]);
  return first === second;
}

/** PHP's trim(): spaces, tabs, new lines, NUL and vertical tabs. */
export const phpTrim = (s: string): string => s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "");

const isIp = (v: string): boolean => isIpv4(v) || parseIpv6(v) !== null;

/** resolveServerIpAddress()['ip']: an IP as it is (brackets stripped), else the host name's first IPv4, else its first IPv6. */
async function resolveServerIp(value: string | null, resolve: DnsResolver): Promise<{ ip: string | null; configured: string | null }> {
  const configured = value === null || phpTrim(value) === "" ? null : phpTrim(value);
  if (configured === null) return { ip: null, configured: null };
  const candidate = configured.replace(/^[[\]]+|[[\]]+$/g, "");
  if (isIp(candidate)) return { ip: candidate, configured };
  let found: string[] = [];
  try {
    found = await resolve(candidate.toLowerCase());
  } catch {
    found = [];
  }
  return { ip: found.find(isIpv4) ?? found.find((a) => parseIpv6(a) !== null) ?? null, configured };
}

/** ServerDnsAddresses: the address (resolved, or as configured), and the public IP of each family. */
export interface ServerDnsAddresses {
  address: string | null;
  publicIpv4: string | null;
  publicIpv6: string | null;
}

const filledOrNull = (v: string | null | undefined): string | null => (v === null || v === undefined || v === "" || v === "0" ? null : v);

/** ServerDnsAddresses::forServer(): the public IPs win over the SSH address. */
export async function serverDnsAddresses(server: DeployDnsServerRow | null, resolve: DnsResolver): Promise<ServerDnsAddresses> {
  if (server === null) return { address: null, publicIpv4: null, publicIpv6: null };
  const ipv4Setting = filledOrNull(server.public_ipv4);
  const ipv6Setting = filledOrNull(server.public_ipv6);
  const configured = ipv4Setting ?? ipv6Setting ?? server.ip;
  const resolved = await resolveServerIp(configured, resolve);
  // ipsByFamily(): the server's own address fills a family without a public IP.
  let [ipv4, ipv6] = [ipv4Setting, ipv6Setting];
  if (ipv4 === null || ipv6 === null) {
    const own = (await resolveServerIp(server.ip, resolve)).ip;
    if (own !== null) {
      ipv4 ??= isIpv4(own) ? own : null;
      ipv6 ??= parseIpv6(own) !== null ? own : null;
    }
  }
  return { address: resolved.ip ?? resolved.configured, publicIpv4: ipv4, publicIpv6: ipv6 };
}

/** addresses(): the IPv4 and the IPv6 address. */
function familyAddresses(a: ServerDnsAddresses): [string | null, string | null] {
  let ipv4: string | null = null;
  let ipv6: string | null = null;
  if (a.address !== null && a.address !== "") {
    if (isIpv4(a.address)) ipv4 = a.address;
    else if (parseIpv6(a.address) !== null) ipv6 = a.address;
  }
  if (ipv4 === null && a.publicIpv4 !== null && isIpv4(a.publicIpv4)) ipv4 = a.publicIpv4;
  if (ipv6 === null && a.publicIpv6 !== null && parseIpv6(a.publicIpv6) !== null) ipv6 = a.publicIpv6;
  return [ipv4, ipv6];
}

/** publicAddresses(): what a DNS provider may publish, IPv4 first. */
export function publicAddresses(a: ServerDnsAddresses): string[] {
  return familyAddresses(a).filter((x): x is string => x !== null && isPublicAddress(x));
}

/** recordContent(): the first public address, or the one requested when it is one of them; else null. */
export function recordContent(a: ServerDnsAddresses, requested: string | null = null): string | null {
  const list = publicAddresses(a);
  if (requested === null) return list[0] ?? null;
  return list.find((x) => sameAddress(x, requested)) ?? null;
}

/** CloudflareDnsProvider::recordType() */
export function recordType(content: string): "A" | "AAAA" | "CNAME" {
  if (parseIpv6(content) !== null) return "AAAA";
  if (isIpv4(content)) return "A";
  return "CNAME";
}
