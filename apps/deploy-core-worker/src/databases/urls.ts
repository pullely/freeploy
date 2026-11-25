// Derived from coollabsio/coolify@91b7e3e:app/Models/Standalone{Postgresql,Redis,Mysql,Mariadb,Mongodb,Keydb,Dragonfly,Clickhouse}.php
// (the internalDbUrl and externalDbUrl accessors, getRedisVersion, redisUsername, connectionPassword),
// app/Models/BaseModel.php (the image accessor) and bootstrap/helpers/shared.php (sanitize_string, formatHostForUrl)
// (Apache-2.0), modified; phpVersionCompare() follows PHP's ext/standard/versioning.c (PHP License 3.01).
//
// The connection URLs of a database, as pure functions of its row: the
// internal one (the container's name on the Docker network) and the public
// one (the server's address and the public port, while the database is
// public). The hosts, ports, paths and query strings are Coolify's, byte for
// byte — /etc/ssl/certs/coolify-ca.crt included: it is a path inside the
// container (design §1.2).
import type { DatabaseEngine } from "@saas/db/deploy";
import { isIpv6, normalizeIpAddress } from "../servers/ip.js";
import { stripTags } from "../applications/tags.js";

/** PHP's rawurlencode(): everything but letters, digits and -_.~ is percent-encoded. */
export function rawUrlEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * sanitize_string(): strip_tags(), htmlspecialchars(ENT_QUOTES | ENT_HTML5),
 * control characters removed, trimmed. BaseModel reads `image` through it.
 */
export function sanitizeString(input: string | null): string | null {
  if (input === null) return null;
  const escaped = stripTags(input).replace(/[&"'<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "'": "&apos;", "<": "&lt;", ">": "&gt;" })[c]!);
  return escaped.replace(/[\x00-\x1F\x7F]/g, "").replace(/^[ \n\r\t\v\0]+|[ \n\r\t\v\0]+$/g, "");
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

/** php_canonicalize_version(): "-", "_", "+" and other punctuation become dots, and a dot separates digits from letters. */
function canonicalizeVersion(version: string): string {
  if (version === "") return "";
  let out = version[0]!;
  let last = version[0]!;
  const isAlnum = (c: string) => /^[A-Za-z0-9]$/.test(c);
  const isDig = (c: string) => isDigit(c);
  const isNdig = (c: string) => !isDigit(c) && c !== ".";
  for (const c of version.slice(1)) {
    const written = out[out.length - 1];
    if (c === "-" || c === "_" || c === "+") {
      if (written !== ".") out += ".";
    } else if ((isNdig(last) && isDig(c)) || (isDig(last) && isNdig(c))) {
      if (written !== ".") out += ".";
      out += c;
    } else if (!isAlnum(c)) {
      if (written !== ".") out += ".";
    } else {
      out += c;
    }
    last = c;
  }
  return out;
}

const SPECIAL_FORMS: ReadonlyArray<[string, number]> = [
  ["dev", 0],
  ["alpha", 1],
  ["a", 1],
  ["beta", 2],
  ["b", 2],
  ["RC", 3],
  ["rc", 3],
  ["#", 4],
  ["pl", 5],
  ["p", 5],
];
/** compare_special_version_forms(): a form is recognized by its first letters; anything else sorts before "dev". */
const specialForm = (part: string): number => SPECIAL_FORMS.find(([name]) => part.startsWith(name))?.[1] ?? -1;

/** PHP's version_compare($a, $b): -1, 0 or 1. */
export function phpVersionCompare(a: string, b: string): number {
  if (a === "" || b === "") return a === "" && b === "" ? 0 : a === "" ? -1 : 1;
  let p1 = canonicalizeVersion(a);
  let p2 = canonicalizeVersion(b);
  let n1: number | null = 0;
  let n2: number | null = 0;
  let compare = 0;
  while (p1 !== "" && n1 !== null && p2 !== "" && n2 !== null) {
    n1 = p1.includes(".") ? p1.indexOf(".") : null;
    n2 = p2.includes(".") ? p2.indexOf(".") : null;
    const part1 = n1 === null ? p1 : p1.slice(0, n1);
    const part2 = n2 === null ? p2 : p2.slice(0, n2);
    if (isDigit(part1[0]) && isDigit(part2[0])) compare = Math.sign(parseInt(part1, 10) - parseInt(part2, 10));
    else if (!isDigit(part1[0]) && !isDigit(part2[0])) compare = Math.sign(specialForm(part1) - specialForm(part2));
    else if (isDigit(part1[0])) compare = Math.sign(specialForm("#N#") - specialForm(part2));
    else compare = Math.sign(specialForm(part1) - specialForm("#N#"));
    if (compare !== 0) break;
    if (n1 !== null) p1 = p1.slice(n1 + 1);
    if (n2 !== null) p2 = p2.slice(n2 + 1);
  }
  if (compare === 0) {
    // What is left of the longer version: more digits make it the newer one, a word (alpha, rc, …) is compared with a number.
    if (n1 !== null) compare = isDigit(p1[0]) ? 1 : phpVersionCompare(p1, "#N#");
    else if (n2 !== null) compare = isDigit(p2[0]) ? -1 : phpVersionCompare("#N#", p2);
  }
  return compare;
}

/** StandaloneRedis::getRedisVersion(): what follows the image's first colon, or '0.0'. */
export function redisVersion(image: string | null): string {
  return (sanitizeString(image) ?? "").split(":")[1] ?? "0.0";
}

/** version_compare($redisVersion, '6.0', '>='): the server knows users, so the username is part of the URL and of the form. */
export const redisHasUsername = (image: string | null): boolean => phpVersionCompare(redisVersion(image), "6.0") >= 0;

/** Laravel's filled(): not null, and not a string that trims to nothing. */
const filled = (value: string | null | undefined): value is string => value !== null && value !== undefined && value.trim() !== "";

/** The redisUsername accessor: the REDIS_USERNAME variable's value, or 'default'. */
export const redisUsername = (variable: string | null | undefined): string => (filled(variable) ? variable : "default");

/** formatHostForUrl(): an IPv6 address in brackets and in its short form; anything else as it is. */
export function formatHostForUrl(host: string): string {
  const normalized = normalizeIpAddress(host);
  return isIpv6(normalized) ? `[${normalized}]` : normalized;
}

export interface DatabaseUrlInput {
  engine: DatabaseEngine;
  uuid: string;
  /** The stored image (Redis reads its version from it). */
  image: string | null;
  isPublic: boolean;
  publicPort: number | null;
  enableSsl: boolean;
  sslMode: string | null;
  /** Server::getIp of the destination's server. */
  serverIp: string | null;
  /** The engine's own columns, the encrypted ones decrypted. */
  values: Readonly<Record<string, string | null | undefined>>;
  /** The REDIS_USERNAME and REDIS_PASSWORD variables' values (null without the variable). */
  usernameVariable?: string | null;
  passwordVariable?: string | null;
  /** legacy_password_quoting: a KeyDB or Dragonfly created before the variable set the server password keeps its stored one. */
  legacyPasswordQuoting?: boolean;
}

/**
 * connectionPassword(): the REDIS_PASSWORD variable when it is the server
 * password and is not empty, else the stored password — which for Redis is
 * that same variable.
 */
function connectionPassword(d: DatabaseUrlInput, column: string | null): string {
  const variable = d.passwordVariable ?? null;
  if (column === null) return variable ?? "";
  if (variable !== null && variable !== "" && !d.legacyPasswordQuoting) return variable;
  return d.values[column] ?? "";
}

/** The URL with `host` and `port` in the place of the container's name and port; `internal` picks Redis's TLS port. */
function url(d: DatabaseUrlInput, host: string, port: number | null): string {
  const v = (column: string): string => d.values[column] ?? "";
  const enc = (column: string): string => rawUrlEncode(v(column));
  switch (d.engine) {
    case "postgresql": {
      let out = `postgres://${enc("postgres_user")}:${enc("postgres_password")}@${host}:${port ?? 5432}/${v("postgres_db")}`;
      if (d.enableSsl) {
        out += `?sslmode=${d.sslMode ?? ""}`;
        if (d.sslMode === "verify-ca" || d.sslMode === "verify-full") out += "&sslrootcert=/etc/ssl/certs/coolify-ca.crt";
      }
      return out;
    }
    case "mysql": {
      let out = `mysql://${enc("mysql_user")}:${enc("mysql_password")}@${host}:${port ?? 3306}/${v("mysql_database")}`;
      if (d.enableSsl) {
        out += `?ssl-mode=${d.sslMode ?? ""}`;
        if (d.sslMode === "VERIFY_CA" || d.sslMode === "VERIFY_IDENTITY") out += "&ssl-ca=/etc/ssl/certs/coolify-ca.crt";
      }
      return out;
    }
    case "mariadb":
      return `mysql://${enc("mariadb_user")}:${enc("mariadb_password")}@${host}:${port ?? 3306}/${v("mariadb_database")}`;
    case "mongodb": {
      let out = `mongodb://${enc("mongo_initdb_root_username")}:${enc("mongo_initdb_root_password")}@${host}:${port ?? 27017}/?directConnection=true`;
      if (d.enableSsl) {
        out += "&tls=true&tlsCAFile=/etc/mongo/certs/ca.pem";
        if (d.sslMode === "verify-full") out += "&tlsCertificateKeyFile=/etc/mongo/certs/server.pem";
      }
      return out;
    }
    case "clickhouse":
      return `clickhouse://${enc("clickhouse_admin_user")}:${enc("clickhouse_admin_password")}@${host}:${port ?? 9000}/${d.values.clickhouse_db ?? "default"}`;
    case "redis":
    case "keydb":
    case "dragonfly": {
      const scheme = d.enableSsl ? "rediss" : "redis";
      // Redis from 6.0 on has users; KeyDB and Dragonfly connect with the password alone.
      const user = d.engine === "redis" ? (redisHasUsername(d.image) ? `${rawUrlEncode(redisUsername(d.usernameVariable))}:` : "") : ":";
      const password = rawUrlEncode(connectionPassword(d, d.engine === "redis" ? null : d.engine === "keydb" ? "keydb_password" : "dragonfly_password"));
      let out = `${scheme}://${user}${password}@${host}:${port ?? (d.enableSsl ? 6380 : 6379)}/0`;
      // These tables have no ssl_mode: the model reads null, so the CA parameter is never added. Kept as the accessor has it.
      if (d.enableSsl && d.sslMode === "verify-ca") out += "?cacert=/etc/ssl/certs/coolify-ca.crt";
      return out;
    }
  }
}

/** internal_db_url: the database at its container name, on its own port. */
export function internalDbUrl(d: DatabaseUrlInput): string {
  return url(d, d.uuid, null);
}

/** external_db_url: the database at the server's address and the public port — null unless it is public with a port and the server has an address. */
export function externalDbUrl(d: DatabaseUrlInput): string | null {
  if (!d.isPublic || !d.publicPort) return null;
  if (d.serverIp === null || d.serverIp === "" || d.serverIp === "0") return null;
  return url(d, formatHostForUrl(d.serverIp), d.publicPort);
}
