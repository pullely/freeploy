// Derived from coollabsio/coolify@91b7e3e:app/Support/ValidationPatterns.php, app/Livewire/Team/Index.php
// (rules, messages) and app/Livewire/Team/InviteLink.php (rules) (Apache-2.0), modified.
//
// Laravel's validator for the team pages, rule by rule, with Coolify's messages and Laravel's defaults.
// All failing rules of a field are reported in rule order (no `bail`); a blank string skips every rule
// but `required`. tests/policy-worker/fixtures/role-matrix/goldens.json has what Coolify's own validator
// answers for each case of tests/membership-worker/src/team.test.ts.

export type FieldErrors = Record<string, string[]>;

/** PCRE's \s without UCP: space, \t, \n, \v, \f, \r. */
const WS = " \\t\\n\\x0B\\f\\r";
/** ValidationPatterns::NAME_PATTERN */
const NAME_PATTERN = new RegExp(`^[\\p{L}\\p{M}\\p{N}${WS}\\-_.@\\/&()#,:+]+$`, "u");
/** ValidationPatterns::DESCRIPTION_PATTERN */
const DESCRIPTION_PATTERN = new RegExp(`^[\\p{L}\\p{M}\\p{N}${WS}\\-_.,!?()'"+=*@\\/&]+$`, "u");

export const TEAM_MESSAGES = {
  /** Team\Index::messages(): 'name.required'. */
  nameRequired: "The Name field is required.",
  nameRegex: "The name may only contain letters (including Unicode), numbers, spaces, and these characters: - _ . / @ & ( ) # , : +",
  nameMin: "The name must be at least 3 characters.",
  nameMax: "The name may not be greater than 255 characters.",
  descriptionRegex: "The description may only contain letters (including Unicode), numbers, spaces, and common punctuation: - _ . , ! ? ( ) ' \" + = * / @ &",
  descriptionMax: "The description may not be greater than 255 characters.",
  string: (attribute: string) => `The ${attribute} field must be a string.`,
  /** Laravel's defaults for InviteLink's rules. */
  emailRequired: "The email field is required.",
  emailInvalid: "The email field must be a valid email address.",
  roleRequired: "The role field is required.",
  roleInvalid: "The selected role is invalid.",
} as const;

const blank = (v: unknown): boolean => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
const length = (s: string): number => [...s].length;
function add(errors: FieldErrors, field: string, message: string): void {
  (errors[field] ??= []).push(message);
}

/** Team\Index::rules(): name => nameRules() (required|string|min:3|max:255|regex), description => descriptionRules(). */
export function validateTeam(body: Record<string, unknown>): { ok: true; name: string; description: string | null } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const { name, description } = body;
  if (blank(name)) add(errors, "name", TEAM_MESSAGES.nameRequired);
  else if (typeof name !== "string") add(errors, "name", TEAM_MESSAGES.string("name"));
  else {
    if (length(name) < 3) add(errors, "name", TEAM_MESSAGES.nameMin);
    if (length(name) > 255) add(errors, "name", TEAM_MESSAGES.nameMax);
    if (!NAME_PATTERN.test(name)) add(errors, "name", TEAM_MESSAGES.nameRegex);
  }
  if (!blank(description)) {
    if (typeof description !== "string") add(errors, "description", TEAM_MESSAGES.string("description"));
    else {
      if (length(description) > 255) add(errors, "description", TEAM_MESSAGES.descriptionMax);
      if (!DESCRIPTION_PATTERN.test(description)) add(errors, "description", TEAM_MESSAGES.descriptionRegex);
    }
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  // Livewire keeps what the form sent; an empty description is saved as sent (Coolify stores '').
  return { ok: true, name: name as string, description: typeof description === "string" ? description : null };
}

// RFC 5322's atext and the dot-atom of egulias/email-validator's RFCValidation (Laravel's `email`).
const ATEXT = "A-Za-z0-9!#$%&'*+/=?^_`{|}~-";
const LOCAL_DOT_ATOM = new RegExp(`^[${ATEXT}]+(\\.[${ATEXT}]+)*$`);
const LOCAL_QUOTED = /^"(?:[^"\\\r\n]|\\.)*"$/;
const DOMAIN_LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u;
const DOMAIN_LITERAL = /^\[(?:\d{1,3}(?:\.\d{1,3}){3}|IPv6:[0-9A-Fa-f:.]+)\]$/;

/**
 * Laravel's `email` rule (RFCValidation). A port of its common cases, not of every RFC 5322 form egulias
 * accepts (comments, folding white space and obsolete forms are refused here): tested against what
 * Coolify's validator answers for the cases of the goldens.
 */
export function isEmail(value: string): boolean {
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (length(local) > 64 || length(domain) > 253) return false;
  if (!LOCAL_DOT_ATOM.test(local) && !LOCAL_QUOTED.test(local)) return false;
  if (DOMAIN_LITERAL.test(domain)) return true;
  return domain.split(".").every((label) => DOMAIN_LABEL.test(label));
}

export const COOLIFY_ROLES = ["member", "admin", "owner"] as const;
export type CoolifyRole = (typeof COOLIFY_ROLES)[number];

/** InviteLink::rules(): email => required|email, role => [required, Rule::enum(Role::class)]. */
export function validateInvite(body: Record<string, unknown>): { ok: true; email: string; role: CoolifyRole } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const { email, role } = body;
  if (blank(email)) add(errors, "email", TEAM_MESSAGES.emailRequired);
  else if (typeof email !== "string" || !isEmail(email)) add(errors, "email", TEAM_MESSAGES.emailInvalid);
  if (blank(role)) add(errors, "role", TEAM_MESSAGES.roleRequired);
  else if (typeof role !== "string" || !(COOLIFY_ROLES as readonly string[]).includes(role)) add(errors, "role", TEAM_MESSAGES.roleInvalid);
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, email: email as string, role: role as CoolifyRole };
}
