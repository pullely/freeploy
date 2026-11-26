// Derived from laravel/framework's Illuminate\Validation\Validator and Concerns\{ValidatesAttributes,FormatsMessages}
// (validateAttribute, isValidatable, shouldStopValidating, getSize, the size messages) and its lang/en/validation.php
// (MIT), and coollabsio/coolify@91b7e3e:bootstrap/helpers/shared.php (customApiValidator) (Apache-2.0), modified.
//
// The part of Laravel's validator the database endpoints of Coolify's /api/v1 use (DP-73), with customApiValidator()'s
// "This field is required.": rules are checked attribute by attribute in the order they are given, every rule of an
// attribute (no bail) unless an implicit one (required) failed, and a non-implicit rule skips an absent attribute and a
// null one marked nullable. `field.*` applies to each item of an array.
//
// DP-86: present, missing, url, in and required_if, and — with `laravelWildcards` — a `field.*` rule expanded in the
// order Laravel's ValidationRuleParser::explodeWildcardRules() gives (ValidationData::initializeAndGatherData()).
import { addError, type Errors } from "./request.js";
import { isLaravelUrl } from "./laravel-url.js";

export type Rule =
  | "required"
  | "nullable"
  | "string"
  | "numeric"
  | "integer"
  | "boolean"
  | "array"
  | "distinct"
  | `min:${number}`
  | `max:${number}`
  | `between:${number},${number}`
  | { regex: RegExp }
  | { exists: (value: unknown) => Promise<boolean> | boolean }
  /** required_without:other (implicit), DP-74 */
  | { requiredWithout: string }
  /** array:key1,key2 — an array whose keys are only these; `message` is the controller's own message for it (DP-74) */
  | { arrayKeys: readonly string[]; message: string }
  /** A closure rule (or a rule object): the messages it fails with (DP-74; DP-81: it may wait, as SafeWebhookUrl resolves a host) */
  | { closure: (value: unknown) => string[] | Promise<string[]> }
  /** present, missing (both implicit) and url, DP-86 */
  | "present"
  | "missing"
  | "url"
  /** in:a,b,c / Rule::in([...]): "The selected x is invalid.", DP-86 */
  | { in: readonly string[] }
  /** required_if:other,value (implicit), DP-86 */
  | { requiredIf: readonly [string, string] };

export type Rules = Array<[string, readonly Rule[]]>;

/** PHP's is_numeric(): an int or float, or a numeric string (leading and trailing whitespace allowed). */
export function phpIsNumeric(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  return typeof v === "string" && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(v);
}

/** filter_var($value, FILTER_VALIDATE_INT) !== false */
export function phpIsInteger(v: unknown): boolean {
  if (typeof v === "number") return Number.isInteger(v);
  if (v === true) return true;
  return typeof v === "string" && /^[+-]?(0|[1-9]\d*)$/.test(v.trim()) && Number.isSafeInteger(Number(v.trim()));
}

const BOOLEAN_VALUES: readonly unknown[] = [true, false, 0, 1, "0", "1"];
const NUMERIC_RULES = ["numeric", "integer"];
/** The attribute in a message: snake case with spaces; an item of an array (`a.0`) as it is. */
const display = (attribute: string): string => (attribute.includes(".") ? attribute : attribute.replace(/_/g, " "));
const mbLength = (s: string): number => [...s].length;
/** PHP's (string) cast of a scalar. */
const phpString = (v: unknown): string => (v === true ? "1" : v === false || v === null || v === undefined ? "" : String(v));

type SizeType = "numeric" | "array" | "string";

function sizeOf(value: unknown, numeric: boolean): number {
  if (numeric && phpIsNumeric(value)) return Number(value);
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === "object") return Object.keys(value).length;
  return mbLength(phpString(value));
}

/** getAttributeType(): the message follows the rules (numeric, array), not the value — an array under `string|min:2` is "characters" (DP-81). */
const sizeType = (list: readonly Rule[], numeric: boolean): SizeType => (numeric ? "numeric" : list.some((r) => r === "array" || (typeof r === "object" && "arrayKeys" in r)) ? "array" : "string");

const MIN: Record<SizeType, (a: string, n: number) => string> = {
  numeric: (a, n) => `The ${a} field must be at least ${n}.`,
  array: (a, n) => `The ${a} field must have at least ${n} items.`,
  string: (a, n) => `The ${a} field must be at least ${n} characters.`,
};
const MAX: Record<SizeType, (a: string, n: number) => string> = {
  numeric: (a, n) => `The ${a} field must not be greater than ${n}.`,
  array: (a, n) => `The ${a} field must not have more than ${n} items.`,
  string: (a, n) => `The ${a} field must not be greater than ${n} characters.`,
};
const BETWEEN: Record<SizeType, (a: string, x: number, y: number) => string> = {
  numeric: (a, x, y) => `The ${a} field must be between ${x} and ${y}.`,
  array: (a, x, y) => `The ${a} field must have between ${x} and ${y} items.`,
  string: (a, x, y) => `The ${a} field must be between ${x} and ${y} characters.`,
};

/** The keys of an array or object of the request (none for anything else). */
const keysOf = (v: unknown): string[] => (Array.isArray(v) ? v.map((_, i) => String(i)) : v !== null && typeof v === "object" ? Object.keys(v) : []);

const isArrayLike = (v: unknown): v is Record<string, unknown> | unknown[] => v !== null && typeof v === "object";
const entriesOf = (v: Record<string, unknown> | unknown[]): Array<[string, unknown]> => (Array.isArray(v) ? v.map((x, i): [string, unknown] => [String(i), x]) : Object.entries(v));
const quote = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A wildcard attribute as a regular expression: each `*` one key ([^.]+ or, with `empty`, [^.]*). */
const wildcardPattern = (attribute: string, anchored: boolean, empty: boolean): RegExp => new RegExp(`^${attribute.split("*").map(quote).join(empty ? "[^.]*" : "[^.]+")}${anchored ? "$" : ""}`);

/** Arr::dot(): the leaves (a scalar, null or an empty array) by their dotted keys, in order. */
function arrDot(v: unknown, prefix: string, out: Array<[string, unknown]>): Array<[string, unknown]> {
  if (!isArrayLike(v)) return out;
  for (const [k, x] of entriesOf(v)) {
    if (isArrayLike(x) && entriesOf(x).length > 0) arrDot(x, `${prefix}${k}.`, out);
    else out.push([`${prefix}${k}`, x]);
  }
  return out;
}

/** data_set($target, $segments, null, true): a `*` segment over every item, a scalar on the way made an array. */
function dataSetNull(target: unknown, segments: readonly string[]): unknown {
  const [segment, ...rest] = segments;
  if (segment === "*") {
    const t = isArrayLike(target) ? target : [];
    const each = (x: unknown): unknown => (rest.length === 0 ? null : dataSetNull(x, rest));
    return Array.isArray(t) ? t.map(each) : Object.fromEntries(Object.entries(t).map(([k, x]) => [k, each(x)]));
  }
  const t: Record<string, unknown> = isArrayLike(target) ? (Array.isArray(target) ? Object.fromEntries(entriesOf(target)) : { ...target }) : {};
  t[segment!] = rest.length === 0 ? null : dataSetNull(t[segment!], rest);
  return t;
}

/** The keys explodeWildcardRules() gives a `field.*…` attribute, in its order (DP-86). */
function laravelWildcardKeys(all: Record<string, unknown>, attribute: string): string[] {
  const lead = attribute.split("*")[0]!.replace(/\.+$/, "");
  const { present, value } = valueOf(all, lead);
  if (!present) return [];
  let data: unknown = { [lead]: value };
  if (!attribute.endsWith("*")) data = dataSetNull(data, attribute.split("."));
  const dotted = arrDot(data, "", []).map(([k]) => k);
  // array_merge($dotted, extractValuesForWildcards()): the wildcard prefixes not already a leaf come after the leaves.
  const prefix = wildcardPattern(attribute, false, false);
  const merged = [...dotted];
  for (const k of dotted) {
    const m = prefix.exec(k);
    if (m && !merged.includes(m[0])) merged.push(m[0]);
  }
  const full = wildcardPattern(attribute, true, true);
  return merged.filter((k) => k.startsWith(attribute) || full.test(k));
}

/** Expands `field.*` and `field.*.child` into the items of the array the request holds (none when it is not an array). */
function expand(all: Record<string, unknown>, rules: Rules, laravelWildcards = false): Rules {
  const out: Rules = [];
  for (const [attribute, list] of rules) {
    const star = attribute.indexOf(".*");
    if (star === -1) {
      out.push([attribute, list]);
      continue;
    }
    if (laravelWildcards) {
      for (const k of laravelWildcardKeys(all, attribute)) out.push([k, list]);
      continue;
    }
    const parent = attribute.slice(0, star);
    const child = attribute.slice(star + 2);
    for (const k of keysOf(all[parent])) out.push([`${parent}.${k}${child}`, list]);
  }
  return out;
}

/** The attribute's value by its dotted path; absent when a step is missing (Laravel's Arr::has()). */
function valueOf(all: Record<string, unknown>, attribute: string): { present: boolean; value: unknown } {
  let at: unknown = all;
  for (const key of attribute.split(".")) {
    if (at === null || typeof at !== "object" || !Object.hasOwn(at, key)) return { present: false, value: undefined };
    at = (at as Record<string, unknown>)[key];
  }
  return { present: true, value: at };
}

/** validateRequired(): null, a blank string, an empty array. */
const missingValue = (value: unknown): boolean =>
  value === null || value === undefined || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0) || (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);

export interface RuleOptions {
  /** Laravel's own `required` message ("The x field is required."): Validator::make() without customApiValidator()'s (DP-74). */
  laravelMessages?: boolean;
  /** `field.*` expanded in Laravel's own order, and distinct over nested items (DP-86). */
  laravelWildcards?: boolean;
}

/** validateDistinct(): the other items' values of the same wildcard attribute (getDistinctValues()), loosely compared. */
function distinctFails(all: Record<string, unknown>, attribute: string, value: unknown): boolean {
  const parts = attribute.split(".");
  const index = parts.findIndex((p) => /^\d+$/.test(p));
  if (index === -1) return false;
  const lead = parts.slice(0, index).join(".");
  const { present, value: parent } = valueOf(all, lead);
  if (!present) return false;
  const pattern = wildcardPattern([...parts.slice(0, index), "*", ...parts.slice(index + 1)].join("."), true, false);
  const others = arrDot({ [lead]: parent }, "", [])
    .filter(([k]) => k !== attribute && pattern.test(k))
    .map(([, v]) => v);
  // in_array() without strict: PHP's loose ==, for the scalars a request holds.
  return others.some((o) => o === value || (o !== null && value !== null && typeof o !== "object" && typeof value !== "object" && String(o) === String(value)));
}

/** Validator::make($all, $rules, ['required' => 'This field is required.'])->errors(), appended to `errors`. */
export async function validateRules(errors: Errors, all: Record<string, unknown>, rules: Rules, options: RuleOptions = {}): Promise<void> {
  for (const [attribute, list] of expand(all, rules, options.laravelWildcards)) {
    const { present, value } = valueOf(all, attribute);
    const nullable = list.includes("nullable");
    const numeric = list.some((r) => typeof r === "string" && NUMERIC_RULES.includes(r));
    const name = display(attribute);
    const failed = (message: string) => addError(errors, attribute, message);
    const hasError = () => errors.some(([k]) => k === attribute);
    for (const rule of list) {
      if (rule === "required") {
        if (missingValue(value)) {
          failed(options.laravelMessages ? `The ${name} field is required.` : "This field is required.");
          break;
        }
        continue;
      }
      if (typeof rule === "object" && "requiredWithout" in rule) {
        if (missingValue(valueOf(all, rule.requiredWithout).value) && missingValue(value)) {
          failed(`The ${name} field is required when ${display(rule.requiredWithout)} is not present.`);
          break;
        }
        continue;
      }
      if (typeof rule === "object" && "requiredIf" in rule) {
        const other = valueOf(all, rule.requiredIf[0]).value;
        if (other !== null && other !== undefined && typeof other !== "object" && String(other) === rule.requiredIf[1] && missingValue(value)) {
          failed(`The ${name} field is required when ${display(rule.requiredIf[0])} is ${rule.requiredIf[1]}.`);
          break;
        }
        continue;
      }
      if (rule === "present" || rule === "missing") {
        if (present !== (rule === "present")) {
          failed(rule === "present" ? `The ${name} field must be present.` : `The ${name} field must be missing.`);
          break;
        }
        continue;
      }
      if (rule === "nullable") continue;
      // isValidatable(): a non-implicit rule skips an absent attribute, and a null one marked nullable.
      if (!present || (nullable && value === null)) continue;
      if (rule === "string") {
        if (typeof value !== "string") failed(`The ${name} field must be a string.`);
      } else if (rule === "numeric") {
        if (!phpIsNumeric(value)) failed(`The ${name} field must be a number.`);
      } else if (rule === "integer") {
        if (!phpIsInteger(value)) failed(`The ${name} field must be an integer.`);
      } else if (rule === "boolean") {
        if (!BOOLEAN_VALUES.includes(value)) failed(`The ${name} field must be true or false.`);
      } else if (rule === "array") {
        if (!Array.isArray(value) && !(value !== null && typeof value === "object")) failed(`The ${name} field must be an array.`);
      } else if (rule === "distinct" && options.laravelWildcards) {
        if (distinctFails(all, attribute, value)) failed(`The ${name} field has a duplicate value.`);
      } else if (rule === "url") {
        if (!isLaravelUrl(value)) failed(`The ${name} field must be a valid URL.`);
      } else if (typeof rule === "object" && "in" in rule) {
        if (value === null || typeof value === "object" || !rule.in.includes(phpString(value))) failed(`The selected ${name} is invalid.`);
      } else if (rule === "distinct") {
        const dot = attribute.lastIndexOf(".");
        const siblings = Object.values(all[attribute.slice(0, dot)] as Record<string, unknown>);
        if (siblings.filter((s) => s === value).length > 1) failed(`The ${name} field has a duplicate value.`);
      } else if (typeof rule === "string" && rule.startsWith("min:")) {
        const n = Number(rule.slice(4));
        if (sizeOf(value, numeric) < n) failed(MIN[sizeType(list, numeric)](name, n));
      } else if (typeof rule === "string" && rule.startsWith("max:")) {
        const n = Number(rule.slice(4));
        if (sizeOf(value, numeric) > n) failed(MAX[sizeType(list, numeric)](name, n));
      } else if (typeof rule === "string" && rule.startsWith("between:")) {
        const [x, y] = rule.slice(8).split(",").map(Number) as [number, number];
        const size = sizeOf(value, numeric);
        if (size < x || size > y) failed(BETWEEN[sizeType(list, numeric)](name, x, y));
      } else if (typeof rule === "object" && "regex" in rule) {
        if ((typeof value !== "string" && typeof value !== "number") || !rule.regex.test(String(value))) failed(`The ${name} field format is invalid.`);
      } else if (typeof rule === "object" && "arrayKeys" in rule) {
        const isArray = Array.isArray(value) || (value !== null && typeof value === "object");
        if (!isArray || keysOf(value).some((k) => !rule.arrayKeys.includes(k))) failed(rule.message.replace(":attribute", name));
      } else if (typeof rule === "object" && "closure" in rule) {
        for (const text of await rule.closure(value)) failed(text);
      } else if (typeof rule === "object" && "exists" in rule) {
        // hasNotFailedPreviousRuleIfPresenceRule(): exists runs only while the attribute has no error.
        if (!hasError() && !(await rule.exists(value))) failed(`The selected ${name} is invalid.`);
      }
    }
  }
}
