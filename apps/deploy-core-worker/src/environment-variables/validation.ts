// Derived from coollabsio/coolify@91b7e3e:app/Support/ValidationPatterns.php (the environment variable key
// pattern, rules, messages and normalization, rejectNulByteInEnvironmentVariableValue),
// app/Livewire/Project/Shared/EnvironmentVariable/{Add,Show,All}.php (rules, messages, validationAttributes,
// normalizeEnvironmentVariables) (Apache-2.0), modified.
//
// Laravel's validator for the environment variable forms, rule by rule. Add
// names its attributes ("The multiline field …"); Show does not, so Laravel
// derives them from the property ("The is multiline field …"). All failing
// rules of a field are reported in rule order (no `bail`); a blank value skips
// every rule but `required`.
import { add, blank, length, type FieldErrors } from "../private-keys/validation.js";
import { EnvFormatError } from "./env-format.js";

/** ValidationPatterns::ENVIRONMENT_VARIABLE_KEY_PATTERN: '/\A[A-Za-z_][A-Za-z0-9_.]*\z/u' */
export const ENVIRONMENT_VARIABLE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export const ENVIRONMENT_VARIABLE_MESSAGES = {
  /** ValidationPatterns::environmentVariableKeyMessages() */
  keyRegex: "The key must start with a letter or underscore and may only contain letters, numbers, underscores, and dots.",
  keyMax: (max: number) => `The key may not be greater than ${max} characters.`,
  /** ValidationPatterns::rejectNulByteInEnvironmentVariableValue() */
  nulByte: "The value cannot contain a NUL character.",
  /** All::normalizeEnvironmentVariables() */
  duplicateAfterNormalization: (key: string) => `Duplicate environment variable key after normalization: ${key}.`,
  /** Laravel's lang/en/validation.php defaults. */
  required: (attribute: string) => `The ${attribute} field is required.`,
  string: (attribute: string) => `The ${attribute} field must be a string.`,
  boolean: (attribute: string) => `The ${attribute} field must be true or false.`,
  max: (attribute: string, max: number) => `The ${attribute} field must not be greater than ${max} characters.`,
} as const;

/**
 * Illuminate\Support\Str::trim() without a character list: PCRE's \s, PHP's
 * trim() characters and Laravel's list of invisible characters, from both ends.
 */
const INVISIBLE =
  "\\u0009\\u0020\\u00A0\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180E\\u2000-\\u200F\\u202F\\u205F\\u2060-\\u2065\\u206A-\\u206F\\u3000\\u2800\\u3164\\uFEFF\\uFFA0\\u{1D159}\\u{1D173}-\\u{1D17A}\\u{E0020}";
const EDGE = `[ \\t\\n\\v\\f\\r\\0${INVISIBLE}]+`;
const LARAVEL_TRIM = new RegExp(`^${EDGE}|${EDGE}$`, "gu");

/** ValidationPatterns::normalizeEnvironmentVariableKey(): str($value)->trim(). */
export function normalizeEnvironmentVariableKey(value: string): string {
  return value.replace(LARAVEL_TRIM, "");
}

export const isValidEnvironmentVariableKey = (value: string): boolean => ENVIRONMENT_VARIABLE_KEY_PATTERN.test(value);

/** ValidationPatterns::validatedEnvironmentVariableKey(): the normalized key, or PHP's InvalidArgumentException. */
export function validatedEnvironmentVariableKey(value: string): string {
  const key = normalizeEnvironmentVariableKey(value);
  if (!isValidEnvironmentVariableKey(key)) throw new EnvFormatError(ENVIRONMENT_VARIABLE_MESSAGES.keyRegex);
  return key;
}

/**
 * All::normalizeEnvironmentVariables(): the parsed developer view with its
 * keys normalized and validated; two keys that normalize to the same one are
 * refused.
 */
export function normalizeEnvironmentVariables<T>(variables: Map<string, T>): Map<string, T> {
  const normalized = new Map<string, T>();
  for (const [key, data] of variables) {
    const normalizedKey = validatedEnvironmentVariableKey(key);
    if (normalized.has(normalizedKey)) throw new EnvFormatError(ENVIRONMENT_VARIABLE_MESSAGES.duplicateAfterNormalization(normalizedKey));
    normalized.set(normalizedKey, data);
  }
  return normalized;
}

type Body = Record<string, unknown>;
type Result<T> = { ok: true; input: T } | { ok: false; errors: FieldErrors };

/** ValidationPatterns::environmentVariableKeyRules(): required|string|max:255|regex, after the key is normalized. */
function keyRule(errors: FieldErrors, value: unknown): string {
  const key = typeof value === "string" ? normalizeEnvironmentVariableKey(value) : value;
  if (blank(key)) {
    add(errors, "key", ENVIRONMENT_VARIABLE_MESSAGES.required("key"));
    return "";
  }
  if (typeof key !== "string") {
    add(errors, "key", ENVIRONMENT_VARIABLE_MESSAGES.string("key"));
    return "";
  }
  if (length(key) > 255) add(errors, "key", ENVIRONMENT_VARIABLE_MESSAGES.keyMax(255));
  if (!isValidEnvironmentVariableKey(key)) add(errors, "key", ENVIRONMENT_VARIABLE_MESSAGES.keyRegex);
  return key;
}

/** 'nullable|string|max:256' */
function commentRule(errors: FieldErrors, value: unknown): string | null {
  if (blank(value)) return typeof value === "string" ? value : null;
  if (typeof value !== "string") {
    add(errors, "comment", ENVIRONMENT_VARIABLE_MESSAGES.string("comment"));
    return null;
  }
  if (length(value) > 256) add(errors, "comment", ENVIRONMENT_VARIABLE_MESSAGES.max("comment", 256));
  return value;
}

/**
 * 'value' => 'nullable': the property is a ?string, so a string or null. A
 * number becomes its text as PHP coerces it; anything else is refused with
 * Laravel's `string` message (Livewire would fail on the property's type).
 */
function valueRule(errors: FieldErrors, field: string, attribute: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  add(errors, field, ENVIRONMENT_VARIABLE_MESSAGES.string(attribute));
  return null;
}

/** Laravel's `boolean`: true, false, 1, 0, "1", "0". */
function booleanValue(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

/** 'required|boolean' for a property that has a default: left out, it keeps `fallback` (Livewire always sends it). */
function booleanRule(errors: FieldErrors, body: Body, field: string, attribute: string, fallback: boolean): boolean {
  const value = body[field];
  if (value === undefined) return fallback;
  if (value === null || value === "") {
    add(errors, field, ENVIRONMENT_VARIABLE_MESSAGES.required(attribute));
    return fallback;
  }
  const parsed = booleanValue(value);
  if (parsed === null) add(errors, field, ENVIRONMENT_VARIABLE_MESSAGES.boolean(attribute));
  return parsed ?? fallback;
}

export interface AddInput {
  key: string;
  value: string | null;
  comment: string | null;
  isMultiline: boolean;
  isLiteral: boolean;
  isRuntime: boolean;
  isBuildtime: boolean;
  isPreview: boolean;
}

/** Add::submit(): the key is normalized, then Add::rules() with its messages and $validationAttributes. */
export function validateAdd(body: Body): Result<AddInput> {
  const errors: FieldErrors = {};
  const key = keyRule(errors, body.key);
  const value = valueRule(errors, "value", "value", body.value);
  const comment = commentRule(errors, body.comment);
  const isMultiline = booleanRule(errors, body, "is_multiline", "multiline", false);
  const isLiteral = booleanRule(errors, body, "is_literal", "literal", false);
  const isRuntime = booleanRule(errors, body, "is_runtime", "runtime", true);
  const isBuildtime = booleanRule(errors, body, "is_buildtime", "buildtime", true);
  // Not in Add::rules(): the component's own bool property, false on the page.
  const isPreview = booleanRule(errors, body, "is_preview", "is preview", false);
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, input: { key, value, comment, isMultiline, isLiteral, isRuntime, isBuildtime, isPreview } };
}

/** What a variable holds now, for the fields an update leaves out. */
export interface UpdateDefaults {
  key: string;
  comment: string | null;
  isMultiline: boolean;
  isLiteral: boolean;
  isShownOnce: boolean;
  isRuntime: boolean;
  isBuildtime: boolean;
  isRequired: boolean;
}

export interface UpdateInput extends UpdateDefaults {
  /** Undefined: the request does not carry a value (the stored one stays). */
  value: string | null | undefined;
  /** A new value for a locked variable. */
  newLockedValue: string | null;
}

/** The key as Show::syncData(true) normalizes it, before any rule: what keyBelongsToAnotherVariable() compares. */
export function submittedKey(body: Body, current: string): string {
  return typeof body.key === "string" ? normalizeEnvironmentVariableKey(body.key) : body.key === undefined ? current : "";
}

/** Show::rules() with Show::messages(); the attributes are the property names, spaced. */
export function validateUpdate(body: Body, current: UpdateDefaults): Result<UpdateInput> {
  const errors: FieldErrors = {};
  const key = body.key === undefined ? current.key : keyRule(errors, body.key);
  const value = body.value === undefined ? undefined : valueRule(errors, "value", "value", body.value);
  const comment = body.comment === undefined ? current.comment : commentRule(errors, body.comment);
  const isMultiline = booleanRule(errors, body, "is_multiline", "is multiline", current.isMultiline);
  const isLiteral = booleanRule(errors, body, "is_literal", "is literal", current.isLiteral);
  const isShownOnce = booleanRule(errors, body, "is_shown_once", "is shown once", current.isShownOnce);
  const isRuntime = booleanRule(errors, body, "is_runtime", "is runtime", current.isRuntime);
  const isBuildtime = booleanRule(errors, body, "is_buildtime", "is buildtime", current.isBuildtime);
  // 'newLockedValue' => 'nullable|string'
  let newLockedValue: string | null = null;
  if (!blank(body.newLockedValue)) {
    if (typeof body.newLockedValue === "string") newLockedValue = body.newLockedValue;
    else add(errors, "newLockedValue", ENVIRONMENT_VARIABLE_MESSAGES.string("new locked value"));
  }
  const isRequired = booleanRule(errors, body, "is_required", "is required", current.isRequired);
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, input: { key, value, comment, isMultiline, isLiteral, isShownOnce, isRuntime, isBuildtime, isRequired, newLockedValue } };
}

/** The switches above the list: the application's settings (All::instantSave, saveCoolifyDefaultVariables, saveLogRedactionSetting). */
export const SETTING_FIELDS = ["is_env_sorting_enabled", "use_build_secrets", "include_coolify_default_variables", "redact_all_env_values_in_logs"] as const;
export type SettingField = (typeof SETTING_FIELDS)[number];
export type SettingsInput = Partial<Record<SettingField, boolean>>;

/** The Livewire properties are bools; here Laravel's `boolean` with its message for whatever else is sent. */
export function validateSettings(body: Body): Result<SettingsInput> {
  const errors: FieldErrors = {};
  const input: SettingsInput = {};
  for (const field of SETTING_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    const parsed = booleanValue(value);
    if (parsed === null) add(errors, field, ENVIRONMENT_VARIABLE_MESSAGES.boolean(field.replaceAll("_", " ")));
    else input[field] = parsed;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, input };
}

export interface BulkInput {
  variables: string | null;
  variablesPreview: string | null;
}

/** All::$variables and $variablesPreview: ?string properties. */
export function validateBulk(body: Body): Result<BulkInput> {
  const errors: FieldErrors = {};
  const text = (field: "variables" | "variablesPreview", attribute: string): string | null => {
    const value = body[field];
    if (value === undefined || value === null) return null;
    if (typeof value === "string") return value;
    add(errors, field, ENVIRONMENT_VARIABLE_MESSAGES.string(attribute));
    return null;
  };
  const input = { variables: text("variables", "variables"), variablesPreview: text("variablesPreview", "variables preview") };
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, input };
}
