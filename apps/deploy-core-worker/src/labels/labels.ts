// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/docker.php (defaultLabels, isNoindexDomain,
// caddySiteAddress, fqdnLabelsForCaddy, traefikHostRulesWithoutIpv6Brackets, fqdnLabelsForTraefik,
// generateLabelsApplication, escapeDollarSign, caddyTrafficAppKey, traefikSafeServiceNameSegment),
// bootstrap/helpers/constants.php (the Traefik gzip middleware, Caddy's stream close delay),
// app/Models/Server.php (proxyType, traefikCertificateResolver, hasPendingProxyConfiguration,
// caddyDockerProxyImageVersion and the caddySupports… checks), app/Models/Application.php
// (usesArgon2idBasicAuth, the settings accessors), app/Traits/HasNoindexDomains.php (noindexDomains) and
// vendor spatie/url's Url::fromString as these functions use it (Apache-2.0), modified.
//
// The container labels Coolify generates for an application: the Traefik routers, services and
// middlewares and the Caddy directives that route its domains, and the coolify.* labels every container
// carries. Pure functions of their arguments; the output is byte-equal to Coolify's own PHP for the
// cases in tests/deploy-core-worker/fixtures/labels (emitted by that PHP, not written by hand).
//
// The label KEYS and VALUES are Coolify's, unchanged — `coolify.managed=true`, `coolify.applicationUuid=…`,
// `caddy_ingress_network=coolify` — also where Freeploy's pages say "Freeploy": they are written to the
// user's servers, and Coolify-compatible tooling (and Coolify's own proxy configuration) reads them back.
//
// The only inputs that are not arguments are the password hashes (a random salt) and the per-domain
// uuid of `generateUniqueUuid`; both come from `LabelDependencies`, so a test can fix them.
import { domainWithoutPort, normalizeApplicationDomainUrl, parseUrl } from "../applications/domains.js";
import { isIpv6 } from "../servers/ip.js";
import { caddyTrafficAppKey, traefikSafeServiceNameSegment } from "../helpers/docker.js";
import { newPublicId } from "../helpers/names.js";
import { bcryptHash } from "./bcrypt.js";

/** config('constants.coolify.version') at the pinned commit: the value of the `coolify.version` label. */
export const COOLIFY_VERSION = "4.7.6";

/** CADDY_STREAM_CLOSE_DELAY */
export const CADDY_STREAM_CLOSE_DELAY = "24h";
/** TRAEFIK_GZIP_MIDDLEWARE */
export const TRAEFIK_GZIP_MIDDLEWARE = "gzip-no-media";
/** TRAEFIK_GZIP_EXCLUDED_CONTENT_TYPES */
export const TRAEFIK_GZIP_EXCLUDED_CONTENT_TYPES = [
  "text/event-stream",
  "video/mp4", "video/webm", "video/ogg", "video/quicktime", "video/x-matroska", "video/x-msvideo",
  "video/mpeg", "video/mp2t", "video/3gpp", "video/x-m4v", "video/x-flv",
  "audio/mpeg", "audio/mp4", "audio/aac", "audio/ogg", "audio/opus", "audio/webm", "audio/wav",
  "audio/x-wav", "audio/flac", "audio/x-m4a",
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif",
  "application/pdf", "application/octet-stream", "application/zip", "application/gzip",
  "application/x-gzip", "application/zstd", "application/x-7z-compressed", "application/x-rar-compressed",
  "application/x-bzip2", "application/x-xz", "application/x-tar",
] as const;

export interface Argon2idOptions {
  memory_cost: number;
  time_cost: number;
}

/** What the generators cannot derive from their arguments. */
export interface LabelDependencies {
  /** password_hash($password, PASSWORD_BCRYPT, ['cost' => $cost]) */
  bcrypt(password: string, cost: number): string;
  /** password_hash($password, PASSWORD_ARGON2ID, $options); absent where Argon2id cannot be computed. */
  argon2id?(password: string, options: Argon2idOptions): string;
  /** new_public_id(), for generateUniqueUuid. */
  newUuid(): string;
}

export const DEFAULT_LABEL_DEPENDENCIES: LabelDependencies = {
  bcrypt: (password, cost) => bcryptHash(password, cost),
  newUuid: () => newPublicId(),
};

// ---------------------------------------------------------------------------
// PHP semantics
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** PHP compares two non-numeric strings byte by byte; JavaScript's `<` compares UTF-16 units. */
function compareBytes(a: string, b: string): number {
  if (a === b) return 0;
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/** Collection::sort() of label strings (asort, which is stable). */
const sortLabels = (labels: string[]): string[] => [...labels].sort(compareBytes);

/** PHP's truthiness of a string, a number or null: "", "0", 0 and null are false. */
const truthy = (value: string | number | null | undefined): boolean => value !== null && value !== undefined && value !== "" && value !== "0" && value !== 0;

/** Laravel's filled() for a string or null. */
const filled = (value: string | null | undefined): value is string => value !== null && value !== undefined && value.trim() !== "";

/** PHP's trim($value, $chars) for single-byte characters. */
function trimChars(value: string, chars: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value.charAt(start))) start++;
  while (end > start && chars.includes(value.charAt(end - 1))) end--;
  return value.slice(start, end);
}

/** The Latin letters voku/portable-ascii writes as more than their base letter (Str::ascii, language "en"). */
const ASCII_SPECIAL: Readonly<Record<string, string>> = {
  ß: "ss", ẞ: "SS", æ: "ae", Æ: "AE", œ: "oe", Œ: "OE", ø: "o", Ø: "O", đ: "d", Đ: "D", ł: "l", Ł: "L", þ: "th", Þ: "TH", ð: "d", Ð: "D", ı: "i",
};

/**
 * Str::slug($title): Str::ascii, "_" runs to "-", "@" to "-at-", lower case, everything but letters,
 * digits, "-" and whitespace removed, runs of "-" and whitespace to one "-", trimmed of "-".
 * Str::ascii is exact here for ASCII and for Latin letters with diacritics; a character of another
 * script, which Coolify transliterates through portable-ascii's tables, is dropped.
 */
export function slug(title: string): string {
  let ascii = "";
  for (const ch of title) {
    if (ch.charCodeAt(0) < 0x80) ascii += ch;
    else if (ASCII_SPECIAL[ch] !== undefined) ascii += ASCII_SPECIAL[ch];
    else ascii += ch.normalize("NFD").replace(/[^\x00-\x7f]/g, "");
  }
  return ascii
    .replace(/_+/g, "-")
    .replace(/@/g, "-at-")
    .toLowerCase()
    .replace(/[^-a-z0-9\s]+/g, "")
    .replace(/[-\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// defaultLabels
// ---------------------------------------------------------------------------

export interface DefaultLabelsInput {
  uuid: string;
  name: string;
  projectName: string;
  resourceName: string;
  environment: string;
  pullRequestId?: number | string | undefined;
  type?: string | undefined;
  subType?: string | null | undefined;
  subUuid?: string | null | undefined;
  subName?: string | null | undefined;
}

/** defaultLabels(): the coolify.* labels of every container, in Coolify's order. */
export function defaultLabels(input: DefaultLabelsInput): string[] {
  const type = input.type ?? "application";
  const labels = [
    "coolify.managed=true",
    `coolify.version=${COOLIFY_VERSION}`,
    `coolify.${type}Uuid=${input.uuid}`,
    `coolify.type=${type}`,
    `coolify.name=${slug(input.name)}`,
    `coolify.resourceName=${slug(input.resourceName)}`,
    `coolify.projectName=${slug(input.projectName)}`,
    `coolify.serviceName=${slug(input.subName ?? input.resourceName)}`,
    `coolify.environmentName=${slug(input.environment)}`,
    `coolify.pullRequestId=${input.pullRequestId ?? 0}`,
  ];
  if (type === "service") {
    if (truthy(input.subUuid)) labels.push(`coolify.service.subUuid=${input.subUuid}`);
    if (truthy(input.subType)) labels.push(`coolify.service.subType=${input.subType}`);
    if (truthy(input.subName)) labels.push(`coolify.service.subName=${slug(input.subName!)}`);
  }
  return labels;
}

/** escapeDollarSign(): what "Escape special characters" does to each label of a deployment. */
export function escapeDollarSign(value: string): string {
  return value.split("$").join("$$");
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

class InvalidUrl extends Error {}

const SPATIE_SCHEMES = ["http", "https", "mailto", "tel", ""];

interface LabelUrl {
  scheme: string;
  host: string;
  port: number | null;
  path: string;
}

/**
 * Spatie\Url\Url::fromString() as the generators read it: the scheme in lower case, the host, the
 * port and the path ("/" when the URL has none). It throws where Spatie does: parse_url() fails, or
 * the scheme is not http, https, mailto, tel or absent. Exact for "scheme://…" URLs — the only kind
 * Coolify's validation stores — and for a string without a scheme, which parse_url() reads as a path.
 */
function labelUrl(domain: string): LabelUrl {
  const parts = parseUrl(domain);
  if (!parts) throw new InvalidUrl(`The string \`${domain}\` is no valid url.`);
  const scheme = (parts.scheme ?? "").toLowerCase();
  if (!SPATIE_SCHEMES.includes(scheme)) throw new InvalidUrl(`The scheme \`${scheme}\` isn't valid. It should be either \`http\`, \`https\`, \`mailto\`, \`tel\`.`);
  return { scheme, host: parts.host ?? "", port: parts.port ?? null, path: parts.path ?? "/" };
}

/** isNoindexDomain(): flags are kept without a port, so both sides are compared without one. */
export function isNoindexDomain(domain: string, noindexDomains: readonly string[] | null | undefined): boolean {
  if (!noindexDomains || noindexDomains.length === 0) return false;
  const normalize = (url: string): string => domainWithoutPort(normalizeApplicationDomainUrl(url));
  return noindexDomains.map(normalize).includes(normalize(domain));
}

/** caddySiteAddress() */
export function caddySiteAddress(scheme: string, host: string, isForceHttpsEnabled: boolean): string {
  return scheme === "https" && !isForceHttpsEnabled ? `http://${host}, https://${host}` : `${scheme}://${host}`;
}

type Port = string | number | null;

/** The port of a domain: the URL's, else the domain's override, else the given defaults in turn. */
function domainPort(url: LabelUrl, domain: string, overrides: Readonly<Record<string, number | string>>, onlyPort: Port, predefinedPort: Port = null): Port {
  let port: Port = url.port ?? overrides[domainWithoutPort(domain)] ?? null;
  if (port === null && onlyPort !== null) port = onlyPort;
  if (port === null && truthy(predefinedPort)) port = predefinedPort;
  return port;
}

// ---------------------------------------------------------------------------
// fqdnLabelsForCaddy
// ---------------------------------------------------------------------------

export interface CaddyLabelsInput {
  network: string;
  uuid: string;
  domains: readonly string[];
  isForceHttpsEnabled?: boolean;
  onlyPort?: Port;
  /** Only whether it is given matters: a service's containers join the network named by the uuid. */
  serviceLabels?: readonly unknown[] | null;
  isGzipEnabled?: boolean | null;
  isStripprefixEnabled?: boolean | null;
  serviceName?: string | null;
  redirectDirection?: string;
  predefinedPort?: string | null;
  isHttpBasicAuthEnabled?: boolean;
  httpBasicAuthUsername?: string | null;
  httpBasicAuthPassword?: string | null;
  noindexDomains?: readonly string[] | null;
  isTrafficAnalyticsEnabled?: boolean;
  domainPortOverrides?: Readonly<Record<string, number | string>>;
  supportsLogAppend?: boolean;
  supportsBasicAuthDirective?: boolean;
  httpBasicAuthBcryptCost?: number | null;
  /** Given: the password is hashed with Argon2id. */
  httpBasicAuthArgon2idOptions?: Argon2idOptions | null;
  isPermanentRedirectEnabled?: boolean;
}

/** fqdnLabelsForCaddy(): the caddy-docker-proxy labels of the domains, sorted. An invalid URL throws, as in Coolify. */
export function fqdnLabelsForCaddy(input: CaddyLabelsInput, deps: LabelDependencies = DEFAULT_LABEL_DEPENDENCIES): string[] {
  const isForceHttpsEnabled = input.isForceHttpsEnabled ?? false;
  const isGzipEnabled = input.isGzipEnabled === undefined ? true : input.isGzipEnabled;
  const isStripprefixEnabled = input.isStripprefixEnabled === undefined ? true : input.isStripprefixEnabled;
  const redirectDirection = input.redirectDirection ?? "both";
  const username = input.httpBasicAuthUsername ?? null;
  const password = input.httpBasicAuthPassword ?? null;
  const argon2id = input.httpBasicAuthArgon2idOptions ?? null;
  const labels: string[] = [];
  // A Collection is truthy even when it is empty.
  labels.push(`caddy_ingress_network=${input.serviceLabels ? input.uuid : input.network}`);

  const basicAuth = (input.isHttpBasicAuthEnabled ?? false) && username !== null && password !== null;
  let hashedPassword = "";
  if (basicAuth) {
    if (argon2id) {
      if (!deps.argon2id) throw new Error("Argon2id password hashing is not available.");
      hashedPassword = deps.argon2id(password, argon2id);
    } else {
      hashedPassword = deps.bcrypt(password, input.httpBasicAuthBcryptCost ?? 10);
    }
  }
  const trafficAppKey = caddyTrafficAppKey(input.uuid, input.serviceName ?? null);

  input.domains.forEach((domain, loop) => {
    const url = labelUrl(domain);
    const host = url.host;
    const hostWithoutWww = host.split("www.").join("");
    const port = domainPort(url, domain, input.domainPortOverrides ?? {}, input.onlyPort ?? null, input.predefinedPort ?? null);
    const handle = isStripprefixEnabled ? "handle_path" : "handle";
    labels.push(`caddy_${loop}=${caddySiteAddress(url.scheme, host, isForceHttpsEnabled)}`);
    if (isNoindexDomain(domain, input.noindexDomains)) {
      labels.push(`caddy_${loop}.header.0_-Server=`);
      labels.push(`caddy_${loop}.header.1_X-Robots-Tag="noindex, nofollow"`);
    } else {
      labels.push(`caddy_${loop}.header=-Server`);
    }
    labels.push(`caddy_${loop}.try_files={path} /index.html /index.php`);
    labels.push(truthy(port) ? `caddy_${loop}.${handle}.${loop}_reverse_proxy={{upstreams ${port}}}` : `caddy_${loop}.${handle}.${loop}_reverse_proxy={{upstreams}}`);
    labels.push(`caddy_${loop}.${handle}.${loop}_reverse_proxy.stream_close_delay=${CADDY_STREAM_CLOSE_DELAY}`);
    labels.push(`caddy_${loop}.${handle}=${url.path}*`);
    if (isGzipEnabled) labels.push(`caddy_${loop}.encode=zstd gzip`);
    const redirectScheme = isForceHttpsEnabled ? url.scheme : "{scheme}";
    const redirectCode = input.isPermanentRedirectEnabled ? " permanent" : "";
    if (redirectDirection === "www" && !host.startsWith("www.")) labels.push(`caddy_${loop}.redir=${redirectScheme}://www.${host}{uri}${redirectCode}`);
    if (redirectDirection === "non-www" && host.startsWith("www.")) labels.push(`caddy_${loop}.redir=${redirectScheme}://${hostWithoutWww}{uri}${redirectCode}`);
    if (basicAuth) {
      // Caddy 2.8 renamed basicauth to basic_auth.
      const directive = input.supportsBasicAuthDirective ? "basic_auth" : "basicauth";
      if (argon2id) labels.push(`caddy_${loop}.${directive}=argon2id`);
      labels.push(`caddy_${loop}.${directive}.${username}="${hashedPassword}"`);
    }
    if (input.isTrafficAnalyticsEnabled) {
      labels.push(`caddy_${loop}.log.output=file /traffic/access.log`);
      labels.push(`caddy_${loop}.log.output.roll_size=20MiB`);
      labels.push(`caddy_${loop}.log.output.roll_keep=5`);
      labels.push(`caddy_${loop}.log.output.roll_keep_for=168h`);
      labels.push(`caddy_${loop}.log.format=json`);
      if (input.supportsLogAppend) labels.push(`caddy_${loop}.log_append=coolify_app_id ${trafficAppKey}`);
    }
  });
  return sortLabels(labels);
}

// ---------------------------------------------------------------------------
// fqdnLabelsForTraefik
// ---------------------------------------------------------------------------

/**
 * traefikHostRulesWithoutIpv6Brackets(): Traefik matches an IPv6 host without brackets, so
 * Host(`[2a01:4f8::1]`) in a saved label becomes Host(`2a01:4f8::1`).
 */
export function traefikHostRulesWithoutIpv6Brackets(labels: readonly string[]): string[] {
  return labels.map((label) => label.replace(/Host\(`\[([0-9A-Fa-f:.]+)\]`\)/g, (match, address: string) => (isIpv6(address) ? `Host(\`${address}\`)` : match)));
}

export interface TraefikLabelsInput {
  uuid: string;
  domains: readonly string[];
  isForceHttpsEnabled?: boolean;
  onlyPort?: Port;
  /** A compose service's own labels ("key=value", or a one-entry map from YAML): the middlewares they name join every router. */
  serviceLabels?: readonly unknown[] | null;
  isGzipEnabled?: boolean | null;
  isStripprefixEnabled?: boolean | null;
  serviceName?: string | null;
  /** A new_public_id() per domain in place of the uuid. */
  generateUniqueUuid?: boolean;
  image?: string | null;
  redirectDirection?: string;
  isHttpBasicAuthEnabled?: boolean;
  httpBasicAuthUsername?: string | null;
  httpBasicAuthPassword?: string | null;
  noindexDomains?: readonly string[] | null;
  /** "$$" (a compose file) or "$" before the capture groups of a www redirect. */
  escapeRedirectReplacementForCompose?: boolean;
  domainPortOverrides?: Readonly<Record<string, number | string>>;
  certificateResolver?: string | null;
  httpBasicAuthBcryptCost?: number | null;
  isPermanentRedirectEnabled?: boolean;
}

/** The middlewares a service's labels declare or ask for, without repeats. */
function middlewaresFromLabels(serviceLabels: readonly unknown[] | null | undefined): string[] {
  if (!serviceLabels) return [];
  const names: string[] = [];
  for (let item of serviceLabels) {
    if (item !== null && typeof item === "object") {
      // A YAML map entry ("traefik.enable: true"): its first key and value as "key=value".
      const [key, value] = Object.entries(item as Record<string, unknown>)[0] ?? ["", ""];
      item = `${key}=${String(value)}`;
    }
    if (typeof item !== "string") continue;
    const declared = /traefik\.http\.middlewares\.(.*?)(\.|$)/.exec(item);
    const asked = declared ? null : /coolify\.traefik\.middlewares=(.*)/.exec(item);
    for (const name of declared ? [declared[1]!] : asked ? asked[1]!.split(",") : []) {
      // filter(): PHP's falsy strings go; unique(): the first of each stays.
      if (truthy(name) && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** fqdnLabelsForTraefik(): the Traefik labels of the domains, sorted. A domain that is not a URL is left out. */
export function fqdnLabelsForTraefik(input: TraefikLabelsInput, deps: LabelDependencies = DEFAULT_LABEL_DEPENDENCIES): string[] {
  const isForceHttpsEnabled = input.isForceHttpsEnabled ?? false;
  const isGzipEnabled = input.isGzipEnabled === undefined ? true : input.isGzipEnabled;
  const isStripprefixEnabled = input.isStripprefixEnabled === undefined ? true : input.isStripprefixEnabled;
  const isPermanentRedirectEnabled = input.isPermanentRedirectEnabled ?? false;
  const redirectDirection = input.redirectDirection ?? "both";
  const username = input.httpBasicAuthUsername ?? null;
  const password = input.httpBasicAuthPassword ?? null;
  const certificateResolver = input.certificateResolver === undefined ? "letsencrypt" : input.certificateResolver;
  const ghost = (input.image ?? "").includes("ghost");
  let uuid = input.uuid;

  const labels: string[] = ["traefik.enable=true"];
  if (isGzipEnabled) labels.push(`traefik.http.middlewares.${TRAEFIK_GZIP_MIDDLEWARE}.compress.excludedcontenttypes=${TRAEFIK_GZIP_EXCLUDED_CONTENT_TYPES.join(",")}`);
  labels.push("traefik.http.middlewares.redirect-to-https.redirectscheme.scheme=https");
  // Every container declares the shared middleware, so a permanent variant needs its own name.
  let redirectToHttpsName = "redirect-to-https";
  if (isPermanentRedirectEnabled) {
    redirectToHttpsName = "redirect-to-https-permanent";
    labels.push("traefik.http.middlewares.redirect-to-https-permanent.redirectscheme.scheme=https");
    labels.push("traefik.http.middlewares.redirect-to-https-permanent.redirectscheme.permanent=true");
  }
  const redirectPermanent = isPermanentRedirectEnabled ? "true" : "false";

  const basicAuth = (input.isHttpBasicAuthEnabled ?? false) && username !== null && password !== null;
  // The middleware is named after the uuid given, also when each domain gets its own.
  const basicAuthName = `http-basic-auth-${uuid}`;
  if (basicAuth) labels.push(`traefik.http.middlewares.${basicAuthName}.basicauth.users=${username}:${deps.bcrypt(password, input.httpBasicAuthBcryptCost ?? 10)}`);

  const fromLabels = middlewaresFromLabels(input.serviceLabels);

  input.domains.forEach((domain, loop) => {
    if (input.generateUniqueUuid) uuid = deps.newUuid();
    let url: LabelUrl;
    try {
      url = labelUrl(domain);
    } catch (e) {
      // try { … } catch (Throwable) { continue; }
      if (e instanceof InvalidUrl) return;
      throw e;
    }
    const host = url.host;
    // Traefik matches an IPv6 Host header without brackets.
    const traefikHost = trimChars(host, "[]");
    const path = url.path;
    const port = domainPort(url, domain, input.domainPortOverrides ?? {}, input.onlyPort ?? null);
    let httpLabel = `http-${loop}-${uuid}`;
    let httpsLabel = `https-${loop}-${uuid}`;
    if (truthy(input.serviceName)) {
      const safe = traefikSafeServiceNameSegment(input.serviceName!);
      httpLabel = `http-${loop}-${uuid}-${safe}`;
      httpsLabel = `https-${loop}-${uuid}-${safe}`;
    }
    if (ghost) {
      labels.push(`traefik.http.middlewares.redir-ghost-${uuid}.redirectregex.regex=^${path}/(.*)`);
      labels.push(`traefik.http.middlewares.redir-ghost-${uuid}.redirectregex.replacement=/$1`);
      labels.push(`caddy_${loop}.handle_path.${loop}_redir-ghost-${uuid}.handler=rewrite`);
      labels.push(`caddy_${loop}.handle_path.${loop}_redir-ghost-${uuid}.rewrite.regexp=^${path}/(.*)`);
      labels.push(`caddy_${loop}.handle_path.${loop}_redir-ghost-${uuid}.rewrite.replacement=/$1`);
    }

    const noindexName = `${loop}-${uuid}-noindex`;
    const isNoindex = isNoindexDomain(domain, input.noindexDomains);
    if (isNoindex) labels.push(`traefik.http.middlewares.${noindexName}.headers.customresponseheaders.X-Robots-Tag=noindex, nofollow`);

    const toWwwName = `${loop}-${uuid}-to-www`;
    const toNonWwwName = `${loop}-${uuid}-to-non-www`;
    const capture = (input.escapeRedirectReplacementForCompose ?? true) ? "$$" : "$";

    /** The middlewares of this domain's router, shared by all four branches of Coolify's function. */
    const routerMiddlewares = (label: string): string[] => {
      const middlewares: string[] = [];
      if (path !== "/" && isStripprefixEnabled && !ghost) {
        labels.push(`traefik.http.middlewares.${label}-stripprefix.stripprefix.prefixes=${path}`);
        middlewares.push(`${label}-stripprefix`);
      }
      if (isGzipEnabled) middlewares.push(TRAEFIK_GZIP_MIDDLEWARE);
      if (ghost) middlewares.push(`redir-ghost-${uuid}`);
      if (redirectDirection === "non-www" && host.startsWith("www.")) {
        labels.push(
          `traefik.http.middlewares.${toNonWwwName}.redirectregex.regex=^(http|https)://www\\.(.+)`,
          `traefik.http.middlewares.${toNonWwwName}.redirectregex.replacement=${capture}{1}://${capture}{2}`,
          `traefik.http.middlewares.${toNonWwwName}.redirectregex.permanent=${redirectPermanent}`,
        );
        middlewares.push(toNonWwwName);
      }
      if (redirectDirection === "www" && !host.startsWith("www.")) {
        labels.push(
          `traefik.http.middlewares.${toWwwName}.redirectregex.regex=^(http|https)://(?:www\\.)?(.+)`,
          `traefik.http.middlewares.${toWwwName}.redirectregex.replacement=${capture}{1}://www.${capture}{2}`,
          `traefik.http.middlewares.${toWwwName}.redirectregex.permanent=${redirectPermanent}`,
        );
        middlewares.push(toWwwName);
      }
      if (basicAuth) middlewares.push(basicAuthName);
      if (isNoindex) middlewares.push(noindexName);
      middlewares.push(...fromLabels);
      return middlewares;
    };

    if (url.scheme === "https") {
      labels.push(`traefik.http.routers.${httpsLabel}.rule=Host(\`${traefikHost}\`) && PathPrefix(\`${path}\`)`);
      labels.push(`traefik.http.routers.${httpsLabel}.entryPoints=https`);
      if (truthy(port)) {
        labels.push(`traefik.http.routers.${httpsLabel}.service=${httpsLabel}`);
        labels.push(`traefik.http.services.${httpsLabel}.loadbalancer.server.port=${port}`);
      }
      const middlewares = routerMiddlewares(httpsLabel);
      if (middlewares.length) labels.push(`traefik.http.routers.${httpsLabel}.middlewares=${middlewares.join(",")}`);
      labels.push(`traefik.http.routers.${httpsLabel}.tls=true`);
      if (filled(certificateResolver)) labels.push(`traefik.http.routers.${httpsLabel}.tls.certresolver=${certificateResolver}`);

      // The http router of an https domain: a redirect to https, or the same middlewares.
      labels.push(`traefik.http.routers.${httpLabel}.rule=Host(\`${traefikHost}\`) && PathPrefix(\`${path}\`)`);
      labels.push(`traefik.http.routers.${httpLabel}.entryPoints=http`);
      if (truthy(port)) {
        labels.push(`traefik.http.services.${httpLabel}.loadbalancer.server.port=${port}`);
        labels.push(`traefik.http.routers.${httpLabel}.service=${httpLabel}`);
      }
      const httpMiddlewares = isForceHttpsEnabled ? [...(isNoindex ? [noindexName] : []), redirectToHttpsName] : middlewares;
      if (httpMiddlewares.length) labels.push(`traefik.http.routers.${httpLabel}.middlewares=${httpMiddlewares.join(",")}`);
    } else {
      labels.push(`traefik.http.routers.${httpLabel}.rule=Host(\`${traefikHost}\`) && PathPrefix(\`${path}\`)`);
      labels.push(`traefik.http.routers.${httpLabel}.entryPoints=http`);
      if (truthy(port)) {
        labels.push(`traefik.http.services.${httpLabel}.loadbalancer.server.port=${port}`);
        labels.push(`traefik.http.routers.${httpLabel}.service=${httpLabel}`);
      }
      const middlewares = routerMiddlewares(httpLabel);
      if (middlewares.length) labels.push(`traefik.http.routers.${httpLabel}.middlewares=${middlewares.join(",")}`);
    }
  });
  return sortLabels(labels);
}

// ---------------------------------------------------------------------------
// generateLabelsApplication
// ---------------------------------------------------------------------------

/** ServerSetting::TRAEFIK_CERTIFICATE_RESOLVER_NONE */
export const TRAEFIK_CERTIFICATE_RESOLVER_NONE = "none";

/** Server::MINIMUM_CURRENT_CADDY_PROXY_VERSION: the first caddy-docker-proxy that ships Caddy 2.8+. */
const MINIMUM_CURRENT_CADDY_PROXY_VERSION: readonly [number, number] = [2, 9];

/** Server::caddyDockerProxyImageVersion(): [major, minor] of a caddy-docker-proxy image, or null. */
export function caddyDockerProxyImageVersion(image: string | null): [number, number] | null {
  const m = image === null ? null : /(?:^|\/)caddy-docker-proxy:(\d+)\.(\d+)/.exec(image);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const atLeast = (version: readonly [number, number], minimum: readonly [number, number]): boolean => version[0] > minimum[0] || (version[0] === minimum[0] && version[1] >= minimum[1]);

/** The server an application's destination is on, as the label generator reads it. */
export interface LabelServer {
  /** servers.proxy (SchemalessAttributes): type, status, certificates_restart_required, last_saved_settings, last_applied_settings. */
  proxy: Readonly<Record<string, unknown>> | null;
  /**
   * Server::configuredCaddyProxyImage(): services.caddy.image of the saved proxy configuration (YAML),
   * read by the caller; null when there is none or the proxy is not Caddy.
   */
  caddyProxyImage: string | null;
  generateExactLabels: boolean;
  /** server_settings.traefik_certificate_resolver */
  traefikCertificateResolver: string | null;
  isTrafficAnalyticsEnabled: boolean;
}

/** Server::proxyType() */
export function proxyType(server: Pick<LabelServer, "proxy">): string | null {
  const type = server.proxy?.type;
  return typeof type === "string" ? type : null;
}

/** Server::hasPendingProxyConfiguration() */
function hasPendingProxyConfiguration(server: LabelServer): boolean {
  const proxy = server.proxy ?? {};
  if (proxy.status !== "running") return false;
  if (proxy.certificates_restart_required) return true;
  const saved = proxy.last_saved_settings;
  const applied = proxy.last_applied_settings;
  const isFilled = (v: unknown): boolean => !(v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0));
  return isFilled(saved) && isFilled(applied) && JSON.stringify(saved) !== JSON.stringify(applied);
}

/** Server::caddyRunsCurrentVersion(): Caddy 2.8+ (`log_append`, `basic_auth`), with nothing waiting to be applied. */
export function caddyRunsCurrentVersion(server: LabelServer): boolean {
  if (hasPendingProxyConfiguration(server)) return false;
  const version = caddyDockerProxyImageVersion(proxyType(server) === "CADDY" ? server.caddyProxyImage : null);
  return version !== null && atLeast(version, MINIMUM_CURRENT_CADDY_PROXY_VERSION);
}

/** Server::caddySupportsArgon2idBasicAuth(): Caddy 2.11, which caddy-docker-proxy 2.11 ships. */
export function caddySupportsArgon2idBasicAuth(server: LabelServer): boolean {
  if (!caddyRunsCurrentVersion(server)) return false;
  return atLeast(caddyDockerProxyImageVersion(server.caddyProxyImage)!, [2, 11]);
}

/** Server::traefikCertificateResolver(): the application's resolver, else the server's; "none" and blank are no resolver. */
export function traefikCertificateResolver(server: Pick<LabelServer, "traefikCertificateResolver">, resourceResolver: string | null): string | null {
  const resolver = filled(resourceResolver) ? resourceResolver : server.traefikCertificateResolver;
  return filled(resolver) && resolver !== TRAEFIK_CERTIFICATE_RESOLVER_NONE ? resolver : null;
}

/** An application as generateLabelsApplication() reads it. */
export interface LabelApplication {
  uuid: string;
  fqdn: string | null;
  portsExposes: string | null;
  /** applications.redirect: "www", "non-www" or "both". */
  redirect: string;
  isHttpBasicAuthEnabled: boolean;
  httpBasicAuthUsername: string | null;
  /** The password itself (the column is encrypted). */
  httpBasicAuthPassword: string | null;
  httpBasicAuthHashAlgorithm: string;
  httpBasicAuthBcryptCost: number | null;
  httpBasicAuthArgon2idMemoryCost: number;
  httpBasicAuthArgon2idTimeCost: number;
  /** applications.noindex_domains as stored (a list, or anything else for none). */
  noindexDomains: unknown;
  domainPortOverrides: Readonly<Record<string, number | string>> | null;
  // application_settings
  isStatic: boolean;
  isForceHttpsEnabled: boolean;
  isGzipEnabled: boolean;
  isStripprefixEnabled: boolean;
  isPermanentRedirectEnabled: boolean;
  traefikCertificateResolver: string | null;
  /** destination.network */
  destinationNetwork: string;
  server: LabelServer;
}

export interface LabelPreview {
  pullRequestId: number;
  fqdn: string | null;
  domainPortOverrides: Readonly<Record<string, number | string>> | null;
}

/** HasNoindexDomains::noindexDomains(): the stored flags, normalized, without repeats. */
function noindexDomainsOf(stored: unknown): string[] {
  const out: string[] = [];
  for (const domain of Array.isArray(stored) ? stored : []) {
    if (typeof domain !== "string" || domain.trim() === "") continue;
    const key = domainWithoutPort(normalizeApplicationDomainUrl(domain));
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * generateLabelsApplication(): the proxy labels of an application's domains, or of a preview's.
 * A server that generates exact labels gets its own proxy's (none for a proxy that is neither Traefik
 * nor Caddy); any other gets Traefik's and then Caddy's, so the proxy can be switched. An application
 * without domains has no proxy labels.
 */
export function generateLabelsApplication(application: LabelApplication, preview: LabelPreview | null, deps: LabelDependencies = DEFAULT_LABEL_DEPENDENCIES): string[] {
  // $application->ports_exposes_array: explode(',', …) of a string, [] for null; a static site listens on 80.
  const ports: Array<string | number> = application.isStatic ? [80] : application.portsExposes === null ? [] : application.portsExposes.split(",");
  const onlyPort: Port = ports.length > 0 ? ports[0]! : null;
  const pullRequestId = preview?.pullRequestId ?? 0;
  const production = pullRequestId === 0;
  const uuid = production ? application.uuid : `${application.uuid}-pr-${pullRequestId}`;
  const server = application.server;

  let domains: string[];
  if (production) {
    // if ($application->fqdn): "" and "0" are no domains.
    if (!truthy(application.fqdn)) return [];
    domains = application.fqdn!.split(",");
  } else {
    domains = truthy(preview!.fqdn) ? preview!.fqdn!.split(",") : [];
  }
  // Previews are ephemeral: every domain is noindex.
  const noindexDomains = production ? noindexDomainsOf(application.noindexDomains) : domains;
  const domainPortOverrides = (production ? application.domainPortOverrides : preview!.domainPortOverrides) ?? {};
  const usesArgon2id = application.httpBasicAuthHashAlgorithm === "argon2id" && caddySupportsArgon2idBasicAuth(server);

  const shared = {
    uuid,
    domains,
    onlyPort,
    isForceHttpsEnabled: application.isForceHttpsEnabled,
    isPermanentRedirectEnabled: application.isPermanentRedirectEnabled,
    isGzipEnabled: application.isGzipEnabled,
    isStripprefixEnabled: application.isStripprefixEnabled,
    // A preview's routers do not redirect between www and non-www.
    ...(production ? { redirectDirection: application.redirect } : {}),
    isHttpBasicAuthEnabled: application.isHttpBasicAuthEnabled,
    httpBasicAuthUsername: application.httpBasicAuthUsername,
    httpBasicAuthPassword: application.httpBasicAuthPassword,
    httpBasicAuthBcryptCost: application.httpBasicAuthBcryptCost,
    noindexDomains,
    domainPortOverrides,
  };
  const traefik = (escapeRedirectReplacementForCompose: boolean): string[] =>
    fqdnLabelsForTraefik(
      { ...shared, escapeRedirectReplacementForCompose, certificateResolver: traefikCertificateResolver(server, application.traefikCertificateResolver) },
      deps,
    );
  const caddy = (): string[] =>
    fqdnLabelsForCaddy(
      {
        ...shared,
        network: application.destinationNetwork,
        httpBasicAuthArgon2idOptions: usesArgon2id ? { memory_cost: application.httpBasicAuthArgon2idMemoryCost, time_cost: application.httpBasicAuthArgon2idTimeCost } : null,
        isTrafficAnalyticsEnabled: server.isTrafficAnalyticsEnabled,
        supportsLogAppend: caddyRunsCurrentVersion(server),
        supportsBasicAuthDirective: caddyRunsCurrentVersion(server),
      },
      deps,
    );

  if (server.generateExactLabels) {
    switch (proxyType(server)) {
      case "TRAEFIK":
        // Production keeps the function's default ("$$"); a preview passes false.
        return traefik(production);
      case "CADDY":
        return caddy();
      default:
        return [];
    }
  }
  return [...traefik(false), ...caddy()];
}
