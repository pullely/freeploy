// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Server/New/ByIp.php and
// app/Livewire/Server/Show.php (rules, messages) and app/Support/ValidationPatterns.php
// (serverUsernameRules, serverUsernameMessages) (Apache-2.0), modified.
//
// Laravel's validator for the server forms, rule by rule, with Coolify's
// messages; the shared name and description rules are the private keys' ones.
import { add, blank, descriptionRules, MESSAGES, nameRules, type FieldErrors } from "../private-keys/validation.js";
import { isIpv4, isIpv6, serverIpError } from "./ip.js";

/** ValidationPatterns::SERVER_USERNAME_PATTERN */
export const SERVER_USERNAME_PATTERN = /^[a-zA-Z0-9_.][a-zA-Z0-9._-]*$/;

export const SERVER_ROLES = ["deployment", "build", "both"] as const;
export type ServerRole = (typeof SERVER_ROLES)[number];

export const SERVER_MESSAGES = {
  /** ByIp::messages() */
  privateKeyInvalid: "The selected Private Key is invalid.",
  createIpRequired: "The IP Address/Domain is required.",
  createIpString: "The IP Address/Domain must be a string.",
  userRequired: "The User field is required.",
  createUserString: "The User field must be a string.",
  /** ValidationPatterns::serverUsernameMessages() */
  userRegex: "The User may only contain letters, numbers, dots, hyphens, and underscores.",
  portRequired: "The Port field is required.",
  createPortInteger: "The Port field must be an integer.",
  createPortBetween: "The Port field must be between 1 and 65535.",
  serverRoleRequired: "The Server Role field is required.",
  serverRoleIn: "The selected Server Role is invalid.",
  /** Show::messages(), and Laravel's defaults where Show has none. */
  showIpRequired: "The IP Address field is required.",
  showUserString: "The user field must be a string.",
  showPortInteger: "The port field must be an integer.",
  showPortBetween: "The port field must be between 1 and 65535.",
  connectionTimeoutRequired: "The SSH Connection Timeout field is required.",
  connectionTimeoutInteger: "The SSH Connection Timeout must be an integer.",
  connectionTimeoutMin: "The SSH Connection Timeout must be at least 1 second.",
  connectionTimeoutMax: "The SSH Connection Timeout must not exceed 300 seconds.",
  wildcardDomainUrl: "The Wildcard Domain must be a valid URL.",
  publicIpv4: "The Public IPv4 must be a valid IPv4 address.",
  publicIpv6: "The Public IPv6 must be a valid IPv6 address.",
  serverTimezoneRequired: "The Server Timezone field is required.",
} as const;

/** Laravel's `integer` (filter_var FILTER_VALIDATE_INT): an int, or a string of one, no leading zeros. */
function integerValue(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return /^[+-]?(0|[1-9]\d*)$/.test(t) ? Number(t) : null;
}

/** Laravel's size for `between` / `min` / `max` on a field with a numeric rule: the number, or a string's length. */
function size(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : [...v].length;
  return 0;
}

/** The port rules (required|integer|between:1,65535). */
function portRules(errors: FieldErrors, value: unknown, messages: { required: string; integer: string; between: string }): void {
  if (blank(value)) return add(errors, "port", messages.required);
  if (integerValue(value) === null) add(errors, "port", messages.integer);
  const n = size(value);
  if (n < 1 || n > 65535) add(errors, "port", messages.between);
}

/** ValidationPatterns::serverUsernameRules(): required|string|regex. */
function userRules(errors: FieldErrors, value: unknown, stringMessage: string): void {
  if (blank(value)) return add(errors, "user", SERVER_MESSAGES.userRequired);
  if (typeof value !== "string") return add(errors, "user", stringMessage);
  if (!SERVER_USERNAME_PATTERN.test(value)) add(errors, "user", SERVER_MESSAGES.userRegex);
}

export interface CreateServerInput {
  /** The uuid of the org's private key (Coolify's private_key_id); null when none is chosen. */
  privateKeyUuid: string | null;
  name: string;
  description: string | null;
  ip: string;
  user: string;
  port: number;
  serverRole: ServerRole;
  /** SetsImageScanning: "on" turns image scanning on. */
  scanImages: boolean;
}

/** ByIp::rules() with ByIp::messages(). */
export function validateCreateServer(body: Record<string, unknown>): { ok: true; input: CreateServerInput } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const key = body.private_key_uuid;
  if (!blank(key) && typeof key !== "string") add(errors, "private_key_uuid", SERVER_MESSAGES.privateKeyInvalid);
  nameRules(errors, body.name, MESSAGES.required("name"));
  descriptionRules(errors, body.description);
  if (blank(body.ip)) add(errors, "ip", SERVER_MESSAGES.createIpRequired);
  else if (typeof body.ip !== "string") add(errors, "ip", SERVER_MESSAGES.createIpString);
  else {
    const e = serverIpError("ip", body.ip);
    if (e) add(errors, "ip", e);
  }
  userRules(errors, body.user ?? "root", SERVER_MESSAGES.createUserString);
  portRules(errors, body.port ?? 22, { required: SERVER_MESSAGES.portRequired, integer: SERVER_MESSAGES.createPortInteger, between: SERVER_MESSAGES.createPortBetween });
  const role = body.server_role ?? "both";
  if (blank(role)) add(errors, "server_role", SERVER_MESSAGES.serverRoleRequired);
  else if (!SERVER_ROLES.includes(role as ServerRole)) add(errors, "server_role", SERVER_MESSAGES.serverRoleIn);
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    input: {
      privateKeyUuid: typeof key === "string" && key.trim() !== "" ? key : null,
      name: body.name as string,
      description: typeof body.description === "string" && body.description !== "" ? body.description : null,
      ip: body.ip as string,
      user: (body.user ?? "root") as string,
      port: integerValue(body.port ?? 22)!,
      serverRole: role as ServerRole,
      scanImages: body.scan_images === "on",
    },
  };
}

/** Laravel's `url` rule, approximately: a scheme, "://", a host, no whitespace. */
export function isUrl(value: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i.test(value)) return false;
  try {
    return new URL(value).host !== "";
  } catch {
    return false;
  }
}

/** PHP's timezone_identifiers_list() as the runtime knows it (ICU), with UTC. */
export function timezones(): string[] {
  const list = new Set<string>(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []);
  list.add("UTC");
  return [...list].sort();
}

export interface UpdateServerInput {
  name: string;
  description: string | null;
  ip: string;
  user: string;
  port: number;
  connectionTimeout: number;
  wildcardDomain: string | null;
  publicIpv4: string | null;
  publicIpv6: string | null;
  serverTimezone: string;
}

const filledOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** Show::rules() with Show::messages(), for the fields the General page saves. */
export function validateUpdateServer(body: Record<string, unknown>): { ok: true; input: UpdateServerInput } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  nameRules(errors, body.name, MESSAGES.required("name"));
  descriptionRules(errors, body.description);
  if (blank(body.ip)) add(errors, "ip", SERVER_MESSAGES.showIpRequired);
  else {
    const e = serverIpError("ip", String(body.ip));
    if (e) add(errors, "ip", e);
  }
  userRules(errors, body.user, SERVER_MESSAGES.showUserString);
  portRules(errors, body.port, { required: SERVER_MESSAGES.portRequired, integer: SERVER_MESSAGES.showPortInteger, between: SERVER_MESSAGES.showPortBetween });
  const timeout = body.connectionTimeout;
  if (blank(timeout)) add(errors, "connectionTimeout", SERVER_MESSAGES.connectionTimeoutRequired);
  else {
    if (integerValue(timeout) === null) add(errors, "connectionTimeout", SERVER_MESSAGES.connectionTimeoutInteger);
    if (size(timeout) < 1) add(errors, "connectionTimeout", SERVER_MESSAGES.connectionTimeoutMin);
    if (size(timeout) > 300) add(errors, "connectionTimeout", SERVER_MESSAGES.connectionTimeoutMax);
  }
  if (!blank(body.wildcardDomain) && !(typeof body.wildcardDomain === "string" && isUrl(body.wildcardDomain))) add(errors, "wildcardDomain", SERVER_MESSAGES.wildcardDomainUrl);
  if (!blank(body.publicIpv4) && !(typeof body.publicIpv4 === "string" && isIpv4(body.publicIpv4))) add(errors, "publicIpv4", SERVER_MESSAGES.publicIpv4);
  if (!blank(body.publicIpv6) && !(typeof body.publicIpv6 === "string" && isIpv6(body.publicIpv6))) add(errors, "publicIpv6", SERVER_MESSAGES.publicIpv6);
  if (blank(body.serverTimezone)) add(errors, "serverTimezone", SERVER_MESSAGES.serverTimezoneRequired);
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    input: {
      name: body.name as string,
      description: filledOrNull(body.description),
      ip: String(body.ip),
      user: body.user as string,
      port: integerValue(body.port)!,
      connectionTimeout: integerValue(timeout)!,
      wildcardDomain: filledOrNull(body.wildcardDomain),
      publicIpv4: filledOrNull(body.publicIpv4),
      publicIpv6: filledOrNull(body.publicIpv6),
      serverTimezone: String(body.serverTimezone),
    },
  };
}
