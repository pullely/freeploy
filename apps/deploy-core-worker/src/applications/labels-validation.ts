// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/General.php (rules, messages,
// validationAttributes: the container label and HTTP Basic Authentication fields) (Apache-2.0), modified.
//
// Laravel's validator for General's Labels and Authentication fields, rule by rule. The messages are
// Laravel's own for these rules (tests/deploy-core-worker/fixtures/labels: the `validate.*` goldens
// run General::rules() through the validator). A field the body leaves out is not validated: it keeps
// its stored value (Livewire always sends every property; this API is a PATCH).
import { add, length, type FieldErrors } from "../private-keys/validation.js";

/** HttpBasicAuthHashAlgorithm */
export const HTTP_BASIC_AUTH_HASH_ALGORITHMS = ["bcrypt", "argon2id"] as const;
export type HttpBasicAuthHashAlgorithm = (typeof HTTP_BASIC_AUTH_HASH_ALGORITHMS)[number];

export interface LabelFieldsInput {
  /** General::instantSave(): a listbox was changed; only the instant fields are saved. */
  instantSave: boolean;
  customLabels?: string | null;
  isContainerLabelEscapeEnabled?: boolean;
  isContainerLabelReadonlyEnabled?: boolean;
  isHttpBasicAuthEnabled?: boolean;
  httpBasicAuthUsername?: string | null;
  httpBasicAuthPassword?: string | null;
  httpBasicAuthHashAlgorithm?: HttpBasicAuthHashAlgorithm;
  httpBasicAuthBcryptCost?: number;
  httpBasicAuthArgon2idMemoryCost?: number;
  httpBasicAuthArgon2idTimeCost?: number;
}

/** The body's fields this validator reads. */
export const LABEL_FIELDS = [
  "customLabels",
  "isContainerLabelEscapeEnabled",
  "isContainerLabelReadonlyEnabled",
  "isHttpBasicAuthEnabled",
  "httpBasicAuthUsername",
  "httpBasicAuthPassword",
  "httpBasicAuthHashAlgorithm",
  "httpBasicAuthBcryptCost",
  "httpBasicAuthArgon2idMemoryCost",
  "httpBasicAuthArgon2idTimeCost",
] as const;

/** General::messages() for the three settings; every other message is Laravel's default for the property ("http basic auth username"). */
const SETTING_NAMES = {
  isContainerLabelEscapeEnabled: "Container Label Escape",
  isContainerLabelReadonlyEnabled: "Container Label Readonly",
  isHttpBasicAuthEnabled: "HTTP Basic Auth",
} as const;

/** Laravel's displayable attribute of a property without an entry in $validationAttributes: snake case, "_" as spaces. */
const attribute = (property: string): string => property.replace(/(.)(?=[A-Z])/g, "$1_").toLowerCase().replace(/_/g, " ");

type Result<T> = { ok: true; input: T } | { ok: false; errors: FieldErrors };
type Body = Record<string, unknown>;

/** 'boolean|required': true, false, 1, 0, "1" and "0" are booleans; null fails both rules, "" only `required`. */
function booleanRequired(errors: FieldErrors, field: keyof typeof SETTING_NAMES, value: unknown): boolean | undefined {
  const name = SETTING_NAMES[field];
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  const empty = value === null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
  if (!empty || value === null) add(errors, field, `The ${name} setting must be true or false.`);
  if (empty) add(errors, field, `The ${name} setting is required.`);
  return undefined;
}

/** 'string|nullable|max:n': null and "" pass; the length is in characters (mb_strlen). */
function nullableString(errors: FieldErrors, field: string, value: unknown, max?: number): string | null | undefined {
  if (value === null || value === "") return value;
  if (typeof value !== "string") {
    add(errors, field, `The ${attribute(field)} field must be a string.`);
    // max:n of an array counts its items; nothing else reaches it with a size above n here.
    return undefined;
  }
  if (max !== undefined && length(value) > max) {
    add(errors, field, `The ${attribute(field)} field must not be greater than ${max} characters.`);
    return undefined;
  }
  return value;
}

/** FILTER_VALIDATE_INT, which the `integer` rule uses. */
const INT_RE = /^\s*[+-]?(?:0|[1-9]\d*)\s*$/;
/** is_numeric() */
const NUMERIC_RE = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/;

/** 'required|integer|min:a|max:b'. With `integer`, min and max compare a numeric value, and the length of anything else. */
function integerBetween(errors: FieldErrors, field: string, value: unknown, min: number, max: number): number | undefined {
  const name = attribute(field);
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0)) {
    add(errors, field, `The ${name} field is required.`);
    return undefined;
  }
  const isInteger = typeof value === "number" ? Number.isInteger(value) : typeof value === "string" && INT_RE.test(value);
  if (!isInteger) add(errors, field, `The ${name} field must be an integer.`);
  const numeric = typeof value === "number" || (typeof value === "string" && NUMERIC_RE.test(value));
  const size = numeric ? Number(value) : typeof value === "string" ? length(value) : Array.isArray(value) ? value.length : length(value === true ? "1" : "");
  if (size < min) add(errors, field, `The ${name} field must be at least ${min}.`);
  if (size > max) add(errors, field, `The ${name} field must not be greater than ${max}.`);
  return isInteger && size >= min && size <= max ? Number(value) : undefined;
}

/**
 * General::rules() for the label fields:
 *   customLabels 'nullable'; isContainerLabelEscapeEnabled, isContainerLabelReadonlyEnabled and
 *   isHttpBasicAuthEnabled 'boolean|required'; httpBasicAuthUsername 'string|nullable';
 *   httpBasicAuthPassword 'string|nullable|max:72' (bcrypt reads 72 bytes); httpBasicAuthHashAlgorithm
 *   required, one of the enum; the bcrypt cost 4–14, the Argon2id memory 8192–262144 KiB and time 1–12.
 * customLabels has no rule but `nullable` in Coolify, where anything but a string then fails in
 * base64_encode(); here it is a field error.
 */
export function validateLabelFields(body: Body): Result<LabelFieldsInput> {
  const errors: FieldErrors = {};
  const input: LabelFieldsInput = { instantSave: body.instantSave === true };
  const has = (field: (typeof LABEL_FIELDS)[number]): boolean => body[field] !== undefined;
  const put = <K extends keyof LabelFieldsInput>(key: K, value: LabelFieldsInput[K] | undefined): void => {
    if (value !== undefined) input[key] = value;
  };

  if (has("customLabels")) {
    if (body.customLabels === null || typeof body.customLabels === "string") input.customLabels = body.customLabels;
    else add(errors, "customLabels", "The Custom labels field must be a string.");
  }
  for (const field of ["isContainerLabelEscapeEnabled", "isContainerLabelReadonlyEnabled", "isHttpBasicAuthEnabled"] as const) {
    if (has(field)) put(field, booleanRequired(errors, field, body[field]));
  }
  if (has("httpBasicAuthUsername")) put("httpBasicAuthUsername", nullableString(errors, "httpBasicAuthUsername", body.httpBasicAuthUsername));
  if (has("httpBasicAuthPassword")) put("httpBasicAuthPassword", nullableString(errors, "httpBasicAuthPassword", body.httpBasicAuthPassword, 72));
  if (has("httpBasicAuthHashAlgorithm")) {
    const value = body.httpBasicAuthHashAlgorithm;
    if (value === null || (typeof value === "string" && value.trim() === "")) add(errors, "httpBasicAuthHashAlgorithm", "The http basic auth hash algorithm field is required.");
    else if (!HTTP_BASIC_AUTH_HASH_ALGORITHMS.includes(value as HttpBasicAuthHashAlgorithm)) add(errors, "httpBasicAuthHashAlgorithm", "The selected http basic auth hash algorithm is invalid.");
    else input.httpBasicAuthHashAlgorithm = value as HttpBasicAuthHashAlgorithm;
  }
  if (has("httpBasicAuthBcryptCost")) put("httpBasicAuthBcryptCost", integerBetween(errors, "httpBasicAuthBcryptCost", body.httpBasicAuthBcryptCost, 4, 14));
  if (has("httpBasicAuthArgon2idMemoryCost")) put("httpBasicAuthArgon2idMemoryCost", integerBetween(errors, "httpBasicAuthArgon2idMemoryCost", body.httpBasicAuthArgon2idMemoryCost, 8192, 262144));
  if (has("httpBasicAuthArgon2idTimeCost")) put("httpBasicAuthArgon2idTimeCost", integerBetween(errors, "httpBasicAuthArgon2idTimeCost", body.httpBasicAuthArgon2idTimeCost, 1, 12));
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, input };
}
