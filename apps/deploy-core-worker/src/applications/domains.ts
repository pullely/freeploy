// Derived from coollabsio/coolify@91b7e3e:app/Support/{ValidationPatterns,DomainUrlParts,DomainPortOverrides}.php
// (validateApplicationDomains, normalizeApplicationDomains, applicationDomainList), app/Traits/HasNoindexDomains.php,
// bootstrap/helpers/domains.php (isValidDomainUrl, domainConflictKey, applicationDomainEntries, checkDomainUsage) and
// bootstrap/helpers/shared.php (generateUrl, sslip, sslipHostLabel, sslipDomainWarning) (Apache-2.0), modified.
//
// An application's domains ("fqdn": a comma-separated list of URLs): Coolify's
// validation and normalisation, the per-domain port overrides its saving hook
// keeps apart from the URL, the generated sslip.io URL of a new application,
// and the domain conflict check. PHP's parse_url() and FILTER_VALIDATE_URL
// are re-implemented for the URLs these functions see.
import { isIpv4, isIpv6, normalizeIpAddress } from "../servers/ip.js";

/** Laravel's blank(): null, or a string that trims to nothing. */
const blank = (v: unknown): boolean => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

export interface UrlComponents {
  scheme?: string;
  host?: string;
  port?: number;
  user?: string;
  pass?: string;
  path?: string;
  query?: string;
  fragment?: string;
}

/**
 * PHP's parse_url() for "scheme://authority…" URLs: null where PHP returns
 * false (no host, a port that is not a number or above 65535). A string
 * without "scheme://" comes back with neither scheme nor host — PHP reads it
 * as a path or as host:port, and every caller here rejects both.
 */
export function parseUrl(url: string): UrlComponents | null {
  const m = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s);
  if (!m) return { path: url };
  const [, scheme, authority, path, query, fragment] = m;
  const out: UrlComponents = { scheme: scheme! };
  let hostPort = authority!;
  const at = hostPort.lastIndexOf("@");
  if (at !== -1) {
    const userinfo = hostPort.slice(0, at);
    hostPort = hostPort.slice(at + 1);
    const colon = userinfo.indexOf(":");
    out.user = colon === -1 ? userinfo : userinfo.slice(0, colon);
    if (colon !== -1) out.pass = userinfo.slice(colon + 1);
  }
  // The port follows the last colon, unless that colon is inside an IPv6 literal.
  let host = hostPort;
  const colon = hostPort.lastIndexOf(":");
  if (colon !== -1 && !(hostPort.startsWith("[") && hostPort.indexOf("]") > colon)) {
    const port = hostPort.slice(colon + 1);
    host = hostPort.slice(0, colon);
    if (port !== "") {
      if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) return null;
      out.port = Number(port);
    }
  }
  if (host === "") return null;
  out.host = host;
  if (path) out.path = path;
  if (query !== undefined) out.query = query;
  if (fragment !== undefined) out.fragment = fragment;
  return out;
}

/** PHP's _php_filter_validate_domain() with FILTER_FLAG_HOSTNAME. */
function isHostname(value: string): boolean {
  const host = value.endsWith(".") ? value.slice(0, -1) : value;
  if (host.length === 0 || host.length > 253) return false;
  return host.split(".").every((label) => label.length >= 1 && label.length <= 63 && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label));
}

/** FILTER_VALIDATE_URL for an http(s) URL: its host is a hostname or a bracketed IPv6 address. */
function filterValidateUrl(url: string): boolean {
  const parts = parseUrl(url);
  if (!parts?.scheme || !parts.host) return false;
  if (parts.host.startsWith("[") && parts.host.endsWith("]")) return isIpv6(parts.host.slice(1, -1));
  if (!isHostname(parts.host)) return false;
  // The user and password may hold only unreserved and sub-delimiter characters.
  return [parts.user, parts.pass].every((v) => v === undefined || /^[a-zA-Z0-9\-._~!$&'()*+,;=:%]*$/.test(v));
}

/** isValidDomainUrl(): an http(s) URL with a host, valid once "_" in the host reads "-". */
export function isValidDomainUrl(url: string): boolean {
  const c = parseUrl(url);
  if (!c) return false;
  const scheme = c.scheme ?? "";
  const host = c.host ?? "";
  if (!["http", "https"].includes(scheme.toLowerCase()) || host === "") return false;
  let rebuilt = `${scheme}://`;
  if (c.user !== undefined) rebuilt += `${c.user}${c.pass !== undefined ? `:${c.pass}` : ""}@`;
  rebuilt += host.replace(/_/g, "-");
  if (c.port !== undefined) rebuilt += `:${c.port}`;
  if (c.path !== undefined) rebuilt += c.path;
  if (c.query !== undefined) rebuilt += `?${c.query}`;
  if (c.fragment !== undefined) rebuilt += `#${c.fragment}`;
  return filterValidateUrl(rebuilt);
}

/** ValidationPatterns::APPLICATION_DOMAIN_FORBIDDEN_PATTERN */
const APPLICATION_DOMAIN_FORBIDDEN_PATTERN = /[`$;&|<>()\\\r\n]/;

/** ValidationPatterns::applicationDomainList(): the list's URLs, trimmed, blanks left out. */
export function applicationDomainList(value: string | null | undefined): string[] {
  if (blank(value)) return [];
  let v = value!;
  if (v.startsWith(",")) v = v.slice(1);
  if (v.endsWith(",")) v = v.slice(0, -1);
  return v
    .trim()
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url !== "");
}

/** ValidationPatterns::validateApplicationDomains(): one message per URL that is not acceptable. */
export function validateApplicationDomains(value: unknown): string[] {
  if (blank(value)) return [];
  if (typeof value !== "string") return ["The domains field must be a string."];
  const errors: string[] = [];
  for (const url of applicationDomainList(value)) {
    if (APPLICATION_DOMAIN_FORBIDDEN_PATTERN.test(url) || !isValidDomainUrl(url)) {
      errors.push(`Invalid URL: ${url}`);
      continue;
    }
    // isValidDomainUrl() has already required an http(s) scheme and a host.
    const parts = parseUrl(url)!;
    if (parts.port !== undefined && (parts.port < 1 || parts.port > 65535)) {
      errors.push(`Invalid port for URL: ${url}. The port must be between 1 and 65535.`);
      continue;
    }
    const unwrapped = parts.host!.replace(/^\[+|\]+$/g, "");
    if (!unwrapped.includes(".") && !isIpv4(unwrapped) && !isIpv6(unwrapped)) {
      errors.push(`Invalid URL: ${url}. The hostname must be a fully qualified domain name.`);
    }
  }
  return errors;
}

/** ValidationPatterns::normalizeApplicationDomainUrl(): scheme and host in lower case, the rest as written. */
export function normalizeApplicationDomainUrl(url: string): string {
  const c = parseUrl(url);
  if (!c) return url;
  let normalized = "";
  if (c.scheme !== undefined) normalized += `${c.scheme.toLowerCase()}://`;
  if (c.user !== undefined) normalized += `${c.user}${c.pass !== undefined ? `:${c.pass}` : ""}@`;
  if (c.host !== undefined) normalized += c.host.toLowerCase();
  if (c.port !== undefined) normalized += `:${c.port}`;
  if (c.path !== undefined) normalized += c.path;
  if (c.query !== undefined) normalized += `?${c.query}`;
  if (c.fragment !== undefined) normalized += `#${c.fragment}`;
  return normalized;
}

/** ValidationPatterns::normalizeApplicationDomains(): the list for storage, or null when it is empty. */
export function normalizeApplicationDomains(value: string | null | undefined): string | null {
  const urls = applicationDomainList(value);
  return urls.length === 0 ? null : urls.map(normalizeApplicationDomainUrl).join(",");
}

export interface DomainParts {
  scheme: string;
  host: string;
  port: string;
  path: string;
}

/** DomainUrlParts::split(). */
export function splitDomainUrl(url: string | null | undefined): DomainParts {
  const parts = blank(url) ? null : parseUrl(url!);
  if (!parts || blank(parts.host)) return { scheme: "https", host: "", port: "", path: "" };
  let path = parts.path ?? "";
  if (parts.query !== undefined) path += `?${parts.query}`;
  if (parts.fragment !== undefined) path += `#${parts.fragment}`;
  const scheme = (parts.scheme ?? "").toLowerCase();
  return { scheme: scheme === "http" || scheme === "https" ? scheme : "https", host: parts.host!, port: parts.port === undefined ? "" : String(parts.port), path };
}

/** DomainUrlParts::compose(). */
export function composeDomainUrl(scheme: string, host: string, port = "", path = ""): string {
  const s = scheme.trim().toLowerCase() === "http" ? "http" : "https";
  let p = path.trim();
  if (p !== "" && !/^[/?#]/.test(p)) p = `/${p}`;
  return `${s}://${host.trim()}${port.trim() !== "" ? `:${port.trim()}` : ""}${p}`;
}

/** DomainPortOverrides::withoutPort(). */
export function domainWithoutPort(url: string): string {
  const parts = splitDomainUrl(url);
  return composeDomainUrl(parts.scheme, parts.host, "", parts.path);
}

function wwwCounterpart(url: string): string | null {
  const parts = splitDomainUrl(url);
  if (parts.host === "") return null;
  const host = parts.host.toLowerCase().startsWith("www.") ? parts.host.slice(4) : `www.${parts.host}`;
  return composeDomainUrl(parts.scheme, host, "", parts.path);
}

/**
 * DomainPortOverrides::normalize(), which Application's saving hook runs on a
 * changed fqdn: each valid domain is stored without its port, and the port —
 * the one written in the URL, else the one already kept for that domain, else
 * the one of its www counterpart — goes to domain_port_overrides.
 */
export function normalizeDomainPortOverrides(fqdn: string | null | undefined, existing: Record<string, number | string> | null): { fqdn: string | null; overrides: Record<string, number> | null } {
  if (blank(fqdn)) return { fqdn: null, overrides: null };
  const existingOverrides = existing ?? {};
  // keyBy('domain'): a later entry for the same domain replaces the earlier one, in its place.
  const byDomain = new Map<string, number | null>();
  for (const domain of fqdn!.split(",").map((d) => d.trim())) {
    if (domain === "" || !isValidDomainUrl(domain)) continue;
    const portless = domainWithoutPort(domain);
    const parts = splitDomainUrl(domain);
    const kept = existingOverrides[portless];
    const port = parts.port !== "" ? Number(parts.port) : kept === undefined || kept === null || kept === "" ? null : Number(kept);
    byDomain.set(portless, port);
  }
  const effective = new Map([...byDomain].filter(([, port]) => port !== null));
  const overrides: Record<string, number> = {};
  for (const [domain, own] of byDomain) {
    let port = own;
    if (port === null) {
      const counterpart = wwwCounterpart(domain);
      port = counterpart === null ? null : (effective.get(counterpart) ?? null);
    }
    if (port !== null) overrides[domain] = port;
  }
  const normalized = [...byDomain.keys()].join(",");
  return { fqdn: normalized === "" ? null : normalized, overrides: Object.keys(overrides).length ? overrides : null };
}

/** HasNoindexDomains::normalizeNoindexDomain(). */
const noindexKey = (domain: string): string => domainWithoutPort(normalizeApplicationDomainUrl(domain));

/**
 * HasNoindexDomains::syncNoindexDomains(): the flags of domains the
 * application no longer has are dropped. `flags` is the stored value; the
 * answer is what to store, or undefined to leave it as it is (blank flags).
 */
export function syncNoindexDomains(flags: unknown, fqdn: string | null): string[] | undefined {
  if (!Array.isArray(flags) || flags.length === 0) return undefined;
  const current = new Set(applicationDomainList(fqdn).map(noindexKey));
  const kept: string[] = [];
  for (const flag of flags) {
    if (typeof flag !== "string" || blank(flag)) continue;
    const key = noindexKey(flag);
    if (current.has(key) && !kept.includes(key)) kept.push(key);
  }
  return kept;
}

/** sslipHostLabel(): an IPv6 address as a DNS label ("2a01-4f8--1"); anything else unchanged. */
export function sslipHostLabel(ip: string): string {
  let address = normalizeIpAddress(ip);
  if (!isIpv6(address)) return address;
  if (address.startsWith("::")) address = `0${address}`;
  if (address.endsWith("::")) address += "0";
  return address.replace(/:/g, "-");
}

/**
 * generateUrl(): "<scheme>://<random>.<host><path>" from the server's wildcard
 * domain, or from sslip() — "http://<ip>.sslip.io" — when it has none.
 */
export function generateUrl(server: { ip: string; wildcardDomain: string | null }, random: string): string {
  let wildcard = server.wildcardDomain;
  let parts = wildcard === null || wildcard === "" ? null : parseUrl(wildcard);
  if (!parts?.scheme || !parts.host) {
    wildcard = `http://${sslipHostLabel(server.ip)}.sslip.io`;
    parts = parseUrl(wildcard)!;
  }
  const path = parts.path === undefined || parts.path === "/" ? "" : parts.path;
  return `${parts.scheme!.toLowerCase()}://${random}.${parts.host!}${path}`;
}

/** sslipDomainWarning(): a domain that is both https and sslip (Let's Encrypt rate-limits sslip.io). */
export function sslipDomainWarning(domains: string | null | undefined): boolean {
  if (blank(domains)) return false;
  return domains!
    .trim()
    .split(",")
    .some((domain) => domain.includes("https") && domain.includes("sslip"));
}

/** domainConflictKey(): the domain without its scheme, its trailing slash and its (container) port. */
export function domainConflictKey(domain: string): string {
  const withoutSlash = domain.endsWith("/") ? domain.slice(0, domain.lastIndexOf("/")) : domain;
  return withoutSlash.replace(/^https?:\/\//i, "").replace(/^([^/:[]+|\[[^\]]+\]):\d+/, "$1");
}

/** applicationDomainEntries() for an application that is not a Compose one: its domains without a trailing slash. */
export function applicationDomainEntries(fqdn: string | null | undefined): string[] {
  return (fqdn ?? "")
    .split(",")
    .filter((domain) => domain !== "")
    .map((domain) => {
      const finished = domain.endsWith("/") ? domain : `${domain}/`;
      return finished.slice(0, finished.lastIndexOf("/"));
    });
}

export interface DomainConflict {
  domain: string;
  resource_name: string;
  resource_uuid: string;
  resource_type: "application";
  message: string;
}

/**
 * checkDomainUsage(resource: $application): the other applications of the
 * team (here, the org) that already use one of the application's domains.
 */
export function domainConflicts(application: { uuid: string; fqdn: string | null }, others: ReadonlyArray<{ uuid: string; name: string; fqdn: string | null }>): DomainConflict[] {
  // $resource->fqdns: the stored list, split on commas.
  const wanted = new Set(blank(application.fqdn) ? [] : application.fqdn!.split(",").map((d) => domainConflictKey(d)));
  const conflicts: DomainConflict[] = [];
  for (const other of others) {
    if (other.uuid === application.uuid) continue;
    for (const domain of applicationDomainEntries(other.fqdn)) {
      if (!wanted.has(domainConflictKey(domain))) continue;
      conflicts.push({
        domain,
        resource_name: other.name,
        resource_uuid: other.uuid,
        resource_type: "application",
        message: `Domain ${domain} is already in use by application '${other.name}'`,
      });
    }
  }
  return conflicts;
}
