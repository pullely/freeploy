// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/api.php (validateIncomingRequest),
// bootstrap/helpers/shared.php (customApiValidator), app/Support/ValidationPatterns.php,
// app/Http/Middleware/TrimStrings.php and Laravel's TrimStrings, ConvertEmptyStringsToNull and Validator
// (Apache-2.0 / MIT), modified.
//
// An /api/v1 request body as Coolify's controllers see it, and the subset of Laravel's validator they use.
import { COOLIFY_API, coolifyJson, obj, type CoolifyAnswer, type PhpObject, type PhpValue } from "@saas/contracts/coolify-api";
import { DESCRIPTION_PATTERN, MESSAGES, NAME_PATTERN } from "../private-keys/validation.js";

/** TrimStrings' $except. */
const NOT_TRIMMED = new Set(["current_password", "password", "password_confirmation", "value"]);

/** The global middleware on the JSON input: TrimStrings, then ConvertEmptyStringsToNull, at any depth. */
export function cleanInput(v: unknown, key = ""): unknown {
  if (typeof v === "string") {
    const t = NOT_TRIMMED.has(key) ? v : v.replace(/^[\s\u0000\u000B]+|[\s\u0000\u000B]+$/g, "");
    return t === "" ? null : t;
  }
  if (Array.isArray(v)) return v.map((x) => cleanInput(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, cleanInput(x, k)]));
  return v;
}

const phpFalsy = (v: unknown) => v === null || v === false || v === 0 || v === "" || v === "0" || (Array.isArray(v) && v.length === 0);

export interface ApiBody {
  /** $request->all(), cleaned. */
  all: Record<string, unknown>;
  isJson: boolean;
  /** validateIncomingRequest()'s answer, or null when the body passes it. */
  incomingError: CoolifyAnswer | null;
}

/** Reads the body once: what validateIncomingRequest() says of it, and $request->all(). */
export async function readApiBody(request: Request): Promise<ApiBody> {
  const contentType = request.headers.get("content-type") ?? "";
  const isJson = /\/json|\+json/.test(contentType);
  const text = request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
  let parsed: unknown = null;
  let ok = false;
  try {
    parsed = JSON.parse(text);
    ok = true;
  } catch {
    ok = false;
  }
  const all = ok && parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (cleanInput(parsed) as Record<string, unknown>) : ok && Array.isArray(parsed) ? Object.fromEntries(parsed.map((x, i) => [String(i), cleanInput(x)])) : {};
  let incomingError: CoolifyAnswer | null = null;
  if (!isJson) incomingError = COOLIFY_API.notJson();
  // json_decode() of the content: invalid, or a falsy value ("[]", "0", "null", "false").
  else if (!ok || phpFalsy(parsed)) incomingError = COOLIFY_API.invalidJson();
  else if (Object.keys(all).length === 0) incomingError = COOLIFY_API.emptyJson();
  return { all: isJson ? all : {}, isJson, incomingError };
}

export type Errors = Array<[string, string[]]>;

export function addError(errors: Errors, field: string, message: string): void {
  const at = errors.find(([k]) => k === field);
  if (at) at[1].push(message);
  else errors.push([field, [message]]);
}

export function errorsObject(errors: Errors): PhpObject {
  return obj(errors.map(([k, v]): [string, PhpValue] => [k, v]));
}

/** {"message":"Validation failed.","errors":{…}} with 422. */
export function validationFailed(errors: Errors): CoolifyAnswer {
  return coolifyJson(obj({ message: "Validation failed.", errors: errorsObject(errors) }), 422);
}

/** The `$extraFields` check: every key of $request->all() not allowed, in the request's order. */
export function extraFields(errors: Errors, all: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(all)) if (!allowed.includes(k)) addError(errors, k, "This field is not allowed.");
}

const length = (s: string) => [...s].length;
/** Laravel's getSize() for a field without a numeric rule. */
const size = (v: unknown) => (Array.isArray(v) ? v.length : typeof v === "string" ? length(v) : v === null || v === undefined ? 0 : length(String(v)));
const isStringy = (v: unknown) => typeof v === "string" || typeof v === "number";

export interface NameRuleOptions {
  required?: boolean;
  nullable?: boolean;
  /** The message of `required` (Laravel's, or customApiValidator's "This field is required."). */
  requiredMessage?: string;
}

/**
 * ValidationPatterns::nameRules($required, 3, 255, $nullable) with combinedMessages(): required or
 * nullable, then string|min:3|max:255|regex:NAME_PATTERN, each failure reported (no bail), none after a
 * failed `required`. A key that is absent skips every rule but `required`.
 */
export function nameRules(errors: Errors, all: Record<string, unknown>, field: string, o: NameRuleOptions = {}): void {
  const present = field in all;
  const v = all[field];
  const required = o.required ?? true;
  const nullable = !required && (o.nullable ?? true);
  if (required && (v === null || v === undefined || (Array.isArray(v) && v.length === 0))) return addError(errors, field, o.requiredMessage ?? MESSAGES.required(field));
  if (!present || (nullable && v === null)) return;
  if (typeof v !== "string") addError(errors, field, MESSAGES.string(field));
  if (size(v) < 3) addError(errors, field, MESSAGES.nameMin(3));
  if (size(v) > 255) addError(errors, field, MESSAGES.nameMax(255));
  if (!isStringy(v) || !NAME_PATTERN.test(String(v))) addError(errors, field, MESSAGES.nameRegex);
}

/** ValidationPatterns::descriptionRules(): nullable|string|max:255|regex:DESCRIPTION_PATTERN. */
export function descriptionRules(errors: Errors, all: Record<string, unknown>, field = "description"): void {
  const v = all[field];
  if (!(field in all) || v === null) return;
  if (typeof v !== "string") addError(errors, field, MESSAGES.string(field));
  if (size(v) > 255) addError(errors, field, MESSAGES.descriptionMax(255));
  if (!isStringy(v) || !DESCRIPTION_PATTERN.test(String(v))) addError(errors, field, MESSAGES.descriptionRegex);
}

/** `required|string` with customApiValidator's required message; `string` alone when not required. */
export function stringRule(errors: Errors, all: Record<string, unknown>, field: string, required: boolean): void {
  const v = all[field];
  if (required && (v === null || v === undefined)) return addError(errors, field, "This field is required.");
  if (!(field in all)) return;
  if (typeof v !== "string") addError(errors, field, MESSAGES.string(field));
}

/** Laravel's `boolean`: true, false, 0, 1, "0", "1". */
export function booleanRule(errors: Errors, all: Record<string, unknown>, field: string): void {
  if (!(field in all) || all[field] === null) return;
  if (![true, false, 0, 1, "0", "1"].includes(all[field] as never)) addError(errors, field, `The ${field} field must be true or false.`);
}

/** $request->boolean($key) */
export function requestBoolean(all: Record<string, unknown>, field: string): boolean {
  const v = all[field];
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  return typeof v === "string" && ["1", "true", "on", "yes"].includes(v.toLowerCase());
}
