// Derived from coollabsio/coolify@91b7e3e:app/Support/ValidationPatterns.php and
// app/Livewire/Security/PrivateKey/{Create,Show}.php (rules, messages) (Apache-2.0), modified.
//
// Laravel's validator for the private key forms, rule by rule, with Coolify's
// messages. All failing rules of a field are reported in rule order (no
// `bail`); the form shows the first. A blank string skips every rule but
// `required`, as Laravel skips non-implicit rules for an empty value.

/** PCRE's \s without UCP: space, \t, \n, \v, \f, \r. */
const WS = " \\t\\n\\x0B\\f\\r";
/** ValidationPatterns::NAME_PATTERN */
export const NAME_PATTERN = new RegExp(`^[\\p{L}\\p{M}\\p{N}${WS}\\-_.@\\/&()#,:+]+$`, "u");
/** ValidationPatterns::DESCRIPTION_PATTERN */
export const DESCRIPTION_PATTERN = new RegExp(`^[\\p{L}\\p{M}\\p{N}${WS}\\-_.,!?()'"+=*@\\/&]+$`, "u");

/** ValidationPatterns::nameMessages() + descriptionMessages() (combinedMessages). */
export const MESSAGES = {
  nameRegex: "The name may only contain letters (including Unicode), numbers, spaces, and these characters: - _ . / @ & ( ) # , : +",
  nameMin: (min: number) => `The name must be at least ${min} characters.`,
  nameMax: (max: number) => `The name may not be greater than ${max} characters.`,
  descriptionRegex: "The description may only contain letters (including Unicode), numbers, spaces, and common punctuation: - _ . , ! ? ( ) ' \" + = * / @ &",
  descriptionMax: (max: number) => `The description may not be greater than ${max} characters.`,
  /** Laravel's default validation.required / validation.string for the field's attribute name. */
  required: (attribute: string) => `The ${attribute} field is required.`,
  string: (attribute: string) => `The ${attribute} field must be a string.`,
  /** Create::messages() */
  valueRequired: "The Private Key field is required.",
  valueString: "The Private Key must be a valid string.",
  /** Show::messages() */
  showNameRequired: "The Name field is required.",
  newPrivateKeyString: "The Private Key must be a valid string.",
} as const;

export type FieldErrors = Record<string, string[]>;

/** Laravel's `required`: null, or a string that trims to nothing. */
const blank = (v: unknown): boolean => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
/** mb_strlen: code points. */
const length = (s: string): number => [...s].length;

function add(errors: FieldErrors, field: string, message: string): void {
  (errors[field] ??= []).push(message);
}

/** ValidationPatterns::nameRules(): required|string|min:3|max:255|regex:NAME_PATTERN. */
function nameRules(errors: FieldErrors, value: unknown, requiredMessage: string): void {
  if (blank(value)) return add(errors, "name", requiredMessage);
  if (typeof value !== "string") return add(errors, "name", MESSAGES.string("name"));
  if (length(value) < 3) add(errors, "name", MESSAGES.nameMin(3));
  if (length(value) > 255) add(errors, "name", MESSAGES.nameMax(255));
  if (!NAME_PATTERN.test(value)) add(errors, "name", MESSAGES.nameRegex);
}

/** ValidationPatterns::descriptionRules(): nullable|string|max:255|regex:DESCRIPTION_PATTERN. */
function descriptionRules(errors: FieldErrors, value: unknown): void {
  if (blank(value)) return;
  if (typeof value !== "string") return add(errors, "description", MESSAGES.string("description"));
  if (length(value) > 255) add(errors, "description", MESSAGES.descriptionMax(255));
  if (!DESCRIPTION_PATTERN.test(value)) add(errors, "description", MESSAGES.descriptionRegex);
}

export interface CreateInput {
  name: string;
  description: string | null;
  value: string;
}

/** Create::rules() with Create::messages(). */
export function validateCreate(body: Record<string, unknown>): { ok: true; input: CreateInput } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  nameRules(errors, body.name, MESSAGES.required("name"));
  descriptionRules(errors, body.description);
  if (blank(body.value)) add(errors, "value", MESSAGES.valueRequired);
  else if (typeof body.value !== "string") add(errors, "value", MESSAGES.valueString);
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    input: {
      name: body.name as string,
      description: typeof body.description === "string" ? body.description : null,
      value: body.value as string,
    },
  };
}

export interface UpdateInput {
  name: string;
  description: string | null;
  /** The replacement key, when the form carries one (filled(trim(newPrivateKey))). */
  newPrivateKey: string | null;
}

/** Show::rules() with Show::messages(). The field is newPrivateKey (Coolify's property); private_key is accepted too. */
export function validateUpdate(body: Record<string, unknown>): { ok: true; input: UpdateInput } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  nameRules(errors, body.name, MESSAGES.showNameRequired);
  descriptionRules(errors, body.description);
  const key = body.newPrivateKey ?? body.private_key;
  if (!blank(key) && typeof key !== "string") add(errors, "newPrivateKey", MESSAGES.newPrivateKeyString);
  if (Object.keys(errors).length) return { ok: false, errors };
  const description = body.description;
  return {
    ok: true,
    input: {
      name: body.name as string,
      // filled($this->description) ? $this->description : null
      description: typeof description === "string" && description.trim() !== "" ? description : null,
      newPrivateKey: typeof key === "string" && key.trim() !== "" ? key : null,
    },
  };
}
