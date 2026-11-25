// Derived from coollabsio/coolify@91b7e3e:app/Support/ValidationPatterns.php (the environment
// variable key rules and messages, rejectNulByteInEnvironmentVariableValue) and
// app/Livewire/Project/Shared/EnvironmentVariable/{Add,Show}.php (rules, messages,
// validationAttributes) (Apache-2.0), modified.
//
// Laravel's validator for the shared variable forms, rule by rule: Coolify's
// messages where it sets them, Laravel's defaults elsewhere. All failing rules
// of a field are reported in rule order (no `bail`); a blank value skips every
// rule but `required`.
import { add, blank, length, MESSAGES, type FieldErrors } from "../private-keys/validation.js";

/** ValidationPatterns::ENVIRONMENT_VARIABLE_KEY_PATTERN (\A…\z: the whole string, no trailing newline). */
export const ENVIRONMENT_VARIABLE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export const SHARED_VARIABLE_VALIDATION_MESSAGES = {
  /** ValidationPatterns::environmentVariableKeyMessages() */
  keyRegex: "The key must start with a letter or underscore and may only contain letters, numbers, underscores, and dots.",
  keyMax: (max: number) => `The key may not be greater than ${max} characters.`,
  /** rejectNulByteInEnvironmentVariableValue() */
  valueNul: "The value cannot contain a NUL character.",
  /** Laravel's default validation.boolean / validation.max.string for the field's attribute name. */
  boolean: (attribute: string) => `The ${attribute} field must be true or false.`,
  max: (attribute: string, max: number) => `The ${attribute} field must not be greater than ${max} characters.`,
} as const;

const M = SHARED_VARIABLE_VALIDATION_MESSAGES;

/** Illuminate\Support\Str::trim(): PHP's trim() characters, \f, and the invisible marks Laravel adds. */
const EDGE = "[\\s\\0\\uFEFF\\u200B\\u200E]+";
const EDGES = new RegExp(`^${EDGE}|${EDGE}$`, "g");

/** ValidationPatterns::normalizeEnvironmentVariableKey(): str($value)->trim(). */
export function normalizeEnvironmentVariableKey(value: string): string {
  return value.replace(EDGES, "");
}

/** ValidationPatterns::isValidEnvironmentVariableKey(). */
export function isValidEnvironmentVariableKey(value: string): boolean {
  return ENVIRONMENT_VARIABLE_KEY_PATTERN.test(value);
}

/** ValidationPatterns::environmentVariableKeyRules(): required|string|max:255|regex. Returns the normalized key. */
function keyRules(errors: FieldErrors, value: unknown): string {
  const key = typeof value === "string" ? normalizeEnvironmentVariableKey(value) : value;
  if (blank(key)) {
    add(errors, "key", MESSAGES.required("key"));
    return "";
  }
  if (typeof key !== "string") {
    add(errors, "key", MESSAGES.string("key"));
    return "";
  }
  if (length(key) > 255) add(errors, "key", M.keyMax(255));
  if (!isValidEnvironmentVariableKey(key)) add(errors, "key", M.keyRegex);
  return key;
}

/** 'comment' => 'nullable|string|max:256'. */
function commentRules(errors: FieldErrors, value: unknown): void {
  if (blank(value)) return;
  if (typeof value !== "string") return add(errors, "comment", MESSAGES.string("comment"));
  if (length(value) > 256) add(errors, "comment", M.max("comment", 256));
}

/** Laravel's `boolean`: true, false, 1, 0, "1" and "0". */
function asBoolean(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

/** 'required|boolean' under the attribute name the component gives the field. */
function booleanRules(errors: FieldErrors, field: string, attribute: string, value: unknown): boolean {
  if (blank(value)) {
    add(errors, field, MESSAGES.required(attribute));
    return false;
  }
  const parsed = asBoolean(value);
  if (parsed === null) add(errors, field, M.boolean(attribute));
  return parsed ?? false;
}

/** A value the component's `?string` property can hold: 'nullable', so only its type is checked. */
function nullableString(errors: FieldErrors, field: string, attribute: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    add(errors, field, MESSAGES.string(attribute));
    return null;
  }
  return value;
}

const comment = (value: unknown): string | null => (typeof value === "string" && !blank(value) ? value : null);

export interface AddVariableInput {
  key: string;
  value: string;
  comment: string | null;
  isMultiline: boolean;
  isLiteral: boolean;
}

/**
 * Add::submit(): the key normalized, then Add::rules() with Add::messages()
 * and its $validationAttributes ('is_multiline' => 'multiline', 'is_literal'
 * => 'literal'). The buildtime and runtime flags are not part of a shared variable.
 */
export function validateAddVariable(body: Record<string, unknown>): { ok: true; input: AddVariableInput } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const key = keyRules(errors, body.key);
  const value = nullableString(errors, "value", "value", body.value);
  const isMultiline = booleanRules(errors, "is_multiline", "multiline", body.is_multiline);
  const isLiteral = booleanRules(errors, "is_literal", "literal", body.is_literal);
  commentRules(errors, body.comment);
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, input: { key, value: value ?? "", comment: comment(body.comment), isMultiline, isLiteral } };
}

export interface UpdateVariableInput {
  key: string;
  /** The form's value; what a locked variable's form sends is not read. */
  value: string;
  comment: string | null;
  isMultiline: boolean;
  isLiteral: boolean;
  isShownOnce: boolean;
  /** A new value for a locked variable; blank keeps the stored one. */
  newLockedValue: string | null;
}

/**
 * Show::syncData(true) for a shared variable: the key normalized, then its
 * rules with Show::messages(). Show sets no $validationAttributes, so Laravel
 * names a field by its property: "is multiline", "new locked value".
 */
export function validateUpdateVariable(body: Record<string, unknown>): { ok: true; input: UpdateVariableInput } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const key = keyRules(errors, body.key);
  const value = nullableString(errors, "value", "value", body.value);
  commentRules(errors, body.comment);
  const isMultiline = booleanRules(errors, "is_multiline", "is multiline", body.is_multiline);
  const isLiteral = booleanRules(errors, "is_literal", "is literal", body.is_literal);
  const isShownOnce = booleanRules(errors, "is_shown_once", "is shown once", body.is_shown_once);
  const newLockedValue = nullableString(errors, "newLockedValue", "new locked value", body.newLockedValue);
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, input: { key, value: value ?? "", comment: comment(body.comment), isMultiline, isLiteral, isShownOnce, newLockedValue } };
}
