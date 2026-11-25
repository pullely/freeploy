// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Security/ApiTokens.php (validateTokenForm,
// $expirationOptions), app/Livewire/Forms/ApiTokenForm.php, app/Policies/ApiTokenPolicy.php,
// app/Enums/AccessLevel.php, app/Services/Access/AccessResolver.php (memberGrants, defaultMemberGrants,
// userHolds), app/Http/Middleware/EnsureTokenBelongsToCurrentTeamMember.php (tokenWithinCreatorAccess),
// app/Models/PersonalAccessToken.php (generateSecret) and laravel/sanctum's PersonalAccessToken::findToken
// (Apache-2.0 / MIT), modified.
//
// Coolify's API tokens without its per-project scopes: every Freeploy token covers the whole org (Coolify's
// "All resources in the team"). The rules and messages are Coolify's, word for word.

/** ApiTokens::$expirationOptions */
export const EXPIRATION_OPTIONS: ReadonlyArray<readonly [number, string]> = [
  [7, "7 days"],
  [30, "30 days"],
  [60, "60 days"],
  [90, "90 days"],
  [365, "1 year"],
];

/** validateTokenForm()'s Rule::in for permissions.* */
export const ABILITIES = ["read", "read:sensitive", "write", "write:sensitive", "deploy", "delete", "root"] as const;

/** AccessLevel's cases (write:sensitive is an ability, not a level). */
const LEVELS = ["read", "read:sensitive", "deploy", "write", "delete", "root"] as const;
type Level = (typeof LEVELS)[number];

/** AccessLevel::includes() */
const INCLUDES: Record<Level, Level[]> = {
  root: [...LEVELS],
  write: ["write", "deploy", "read:sensitive", "read"],
  delete: ["delete", "read"],
  deploy: ["deploy", "read"],
  "read:sensitive": ["read:sensitive", "read"],
  read: ["read"],
};

export const TOKEN_MESSAGES = {
  writeSensitive: "You do not have permission to give tokens write:sensitive permissions.",
  exceedsAccess: "A token cannot have more access than you have. Choose fewer permissions or narrower projects, environments, or resources.",
  /** Freeploy's: Coolify's per-project scopes are not ported. */
  scopesUnavailable: "Tokens limited to selected projects, environments, or resources are not available yet.",
} as const;

/** Coolify's roles: owner and admin hold every level; any other Freeploy role is Coolify's "member". */
export type CoolifyRole = "owner" | "admin" | "member";

export function coolifyRole(freeployRoles: string[]): CoolifyRole | null {
  if (freeployRoles.length === 0) return null;
  if (freeployRoles.includes("owner")) return "owner";
  if (freeployRoles.includes("admin")) return "admin";
  return "member";
}

const isAdmin = (role: CoolifyRole): boolean => role === "owner" || role === "admin";

/**
 * AccessResolver::memberGrants(): null (everything) for owners and admins, else the member's stored
 * grants — Freeploy stores none, so Coolify's defaultMemberGrants(): Read on the whole team.
 */
function memberLevels(role: CoolifyRole): Level[] | null {
  return isAdmin(role) ? null : ["read"];
}

/** A grant of the member's levels allows `level` (Layer::allows on a team-wide grant). */
function memberAllows(role: CoolifyRole, level: Level): boolean {
  const levels = memberLevels(role);
  if (levels === null) return true;
  return levels.some((granted) => INCLUDES[granted].includes(level));
}

/** AccessLevel::parseMany(): the known levels, once each, unknown values ignored. */
function parseLevels(values: readonly string[]): Level[] {
  const out: Level[] = [];
  for (const v of values) if ((LEVELS as readonly string[]).includes(v) && !out.includes(v as Level)) out.push(v as Level);
  return out;
}

/** The page's $canUse* (ApiTokenPolicy::useRootPermissions … useDeletePermissions, coversWholeTeam). */
export function permissionsFor(role: CoolifyRole) {
  return {
    canUseRootPermissions: isAdmin(role) || memberAllows(role, "root"),
    canUseWritePermissions: isAdmin(role) || memberAllows(role, "write"),
    canUseDeployPermissions: isAdmin(role) || memberAllows(role, "deploy"),
    canUseSensitivePermissions: isAdmin(role) || memberAllows(role, "read:sensitive"),
    canUseDeletePermissions: isAdmin(role) || memberAllows(role, "delete"),
    canUseTeamScope: true,
  };
}

/** Laravel's ValidationException message: the first error, and "(and N more error[s])". */
export function summarize(messages: string[]): string {
  const [first, ...rest] = messages;
  if (!rest.length) return first ?? "";
  return `${first} (and ${rest.length} more ${rest.length === 1 ? "error" : "errors"})`;
}

/** Laravel's `required`: null, an empty or blank string, an empty array. */
const missing = (v: unknown): boolean => v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
/** mb_strlen */
const length = (s: string): number => [...s].length;
/** Rule::in compares loosely: 7 and "7" are the same choice. */
const looseIn = (v: unknown, choices: ReadonlyArray<string | number>): boolean =>
  (typeof v === "string" || typeof v === "number") && choices.some((c) => String(c) === String(v));

export interface TokenForm {
  description?: unknown;
  expiresInDays?: unknown;
  permissions?: unknown;
  scopeMode?: unknown;
}

/**
 * ApiTokenForm's defaults for what the request leaves out (expiresInDays 30, permissions ['read'],
 * scopeMode 'team'), and updatedPermissions() on the list the page sends: an empty list becomes ['read'],
 * and the list is sorted.
 */
export function withFormDefaults(form: TokenForm): TokenForm {
  const out: TokenForm = { ...form };
  if (!("expiresInDays" in form)) out.expiresInDays = 30;
  if (!("permissions" in form) || form.permissions === undefined) out.permissions = ["read"];
  if (Array.isArray(out.permissions)) {
    const list = [...(out.permissions as unknown[])];
    if (list.length === 0) list.push("read");
    out.permissions = list.sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
  }
  if (!("scopeMode" in form)) out.scopeMode = "team";
  return out;
}

export type ValidatedToken = { ok: true; name: string; abilities: string[]; expiresInDays: number | null } | { ok: false; message: string };

/**
 * validateTokenForm() for a new token: the rules (each failure in rule order; the page shows
 * handleError()'s toast, the ValidationException's summary), then whether the user may give it.
 */
export function validateTokenForm(input: TokenForm, role: CoolifyRole): ValidatedToken {
  const form = withFormDefaults(input);
  const errors: string[] = [];
  const d = form.description;
  // 'description' => 'required|min:3|max:255'
  if (missing(d)) errors.push("The description field is required.");
  else {
    const text = typeof d === "string" ? d : String(d);
    if (length(text) < 3) errors.push("The description field must be at least 3 characters.");
    if (length(text) > 255) errors.push("The description field must not be greater than 255 characters.");
  }
  // 'expiresInDays' => ['nullable', Rule::in([7, 30, 60, 90, 365])]
  const e = form.expiresInDays;
  const noExpiry = e === null || e === undefined || e === "";
  if (!noExpiry && !looseIn(e, EXPIRATION_OPTIONS.map(([days]) => days))) errors.push("The selected expires in days is invalid.");
  // 'permissions' => 'required|array|min:1', 'permissions.*' => ['required', 'string', Rule::in(ABILITIES)]
  const p = form.permissions;
  if (missing(p)) errors.push("The permissions field is required.");
  else if (!Array.isArray(p) && (typeof p !== "object" || p === null)) errors.push("The permissions field must be an array.");
  else {
    const values = Array.isArray(p) ? p : Object.values(p as Record<string, unknown>);
    const keys = Array.isArray(p) ? p.map((_, i) => String(i)) : Object.keys(p as Record<string, unknown>);
    values.forEach((v, i) => {
      const attr = `permissions.${keys[i]}`;
      if (missing(v)) return void errors.push(`The ${attr} field is required.`);
      if (typeof v !== "string") errors.push(`The ${attr} field must be a string.`);
      if (!looseIn(v, ABILITIES)) errors.push(`The selected ${attr} is invalid.`);
    });
  }
  // 'scopeMode' => ['required', Rule::in(['team', 'selected'])]
  const scope = form.scopeMode ?? "team";
  if (!looseIn(scope, ["team", "selected"])) errors.push("The selected scope mode is invalid.");
  if (errors.length) return { ok: false, message: summarize(errors) };
  if (scope === "selected") return { ok: false, message: TOKEN_MESSAGES.scopesUnavailable };

  const abilities = (Array.isArray(p) ? p : Object.values(p as Record<string, unknown>)).map(String);
  if (abilities.includes("write:sensitive") && !isAdmin(role)) return { ok: false, message: TOKEN_MESSAGES.writeSensitive };
  // userHolds($user, $teamId, [Grant::team($levels)])
  if (!parseLevels(abilities).every((level) => memberAllows(role, level))) return { ok: false, message: TOKEN_MESSAGES.exceedsAccess };
  return { ok: true, name: String(d), abilities, expiresInDays: noExpiry ? null : Number(e) };
}

/** EnsureTokenBelongsToCurrentTeamMember::tokenWithinCreatorAccess(): a token never does more than its owner. */
export function tokenWithinCreatorAccess(role: CoolifyRole, abilities: readonly string[]): boolean {
  if (isAdmin(role)) return true;
  const levels = parseLevels(abilities);
  // Abilities outside the access levels (write:sensitive, *) are for owners and admins only.
  if (levels.length !== new Set(abilities).size) return false;
  return levels.every((level) => memberAllows(role, level));
}

/** ApiSensitiveData: the token can read secrets when it has root or read:sensitive and its user is an admin of the team. */
export function canReadSensitive(role: CoolifyRole, abilities: readonly string[]): boolean {
  return (abilities.includes("root") || abilities.includes("*") || abilities.includes("read:sensitive")) && isAdmin(role);
}

const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Str::random(40): letters and digits. */
export function randomString(length: number, random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  let out = "";
  while (out.length < length) {
    for (const b of random(length * 2)) {
      // 62 * 4 = 248: rejection keeps the alphabet uniform.
      if (b < 248 && out.length < length) out += ALNUM[b % 62];
    }
  }
  return out;
}

let crcTable: Uint32Array | null = null;
/** PHP's hash('crc32b', …): CRC-32 (IEEE), as 8 lowercase hex digits. */
export function crc32b(text: string): string {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of new TextEncoder().encode(text)) crc = crcTable[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

/** PersonalAccessToken::generateSecret() with Sanctum's default token_prefix (''). */
export function generateSecret(random?: (n: number) => Uint8Array): string {
  const entropy = randomString(40, random);
  return `${entropy}${crc32b(entropy)}`;
}

/** Request::bearerToken(): what follows the last "Bearer " of the Authorization header. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const at = header.lastIndexOf("Bearer ");
  if (at === -1) return null;
  const token = header.slice(at + 7);
  return token === "" ? null : token;
}

/** PersonalAccessToken::findToken(): "<id>|<secret>" finds the row by id, a bare secret by its hash. */
export function splitToken(token: string): { tokenNumber: number | null; secret: string } {
  const bar = token.indexOf("|");
  if (bar === -1) return { tokenNumber: null, secret: token };
  const id = token.slice(0, bar);
  return { tokenNumber: /^\d+$/.test(id) ? Number(id) : Number.NaN, secret: token.slice(bar + 1) };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** hash_equals */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
