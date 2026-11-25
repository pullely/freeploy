// Laravel's helpers, as far as Coolify's Compose parser uses them, over the PHP value model of php.ts:
// Illuminate\Support\Str (after, before, …), data_get, and the Collection operations whose results depend
// on PHP's array rules (merge renumbers integer keys, a list is an array with the keys 0..n-1).
// Nothing in this file is copied from Coolify; it restates documented Laravel behaviour.
import { PhpArray, isNumericString, phpString, type PhpKey, type PhpValue } from "./php.js";

/** Str::after: the rest after the first occurrence; the subject itself when there is none. */
export function after(subject: string, search: string): string {
  if (search === "") return subject;
  const index = subject.indexOf(search);
  return index === -1 ? subject : subject.slice(index + search.length);
}

/** Str::afterLast. */
export function afterLast(subject: string, search: string): string {
  if (search === "") return subject;
  const index = subject.lastIndexOf(search);
  return index === -1 ? subject : subject.slice(index + search.length);
}

/** Str::before. */
export function before(subject: string, search: string): string {
  if (search === "") return subject;
  const index = subject.indexOf(search);
  return index === -1 ? subject : subject.slice(0, index);
}

/** Str::beforeLast. */
export function beforeLast(subject: string, search: string): string {
  if (search === "") return subject;
  const index = subject.lastIndexOf(search);
  return index === -1 ? subject : subject.slice(0, index);
}

/** Str::replaceFirst. */
export function replaceFirst(search: string, replace: string, subject: string): string {
  if (search === "") return subject;
  const index = subject.indexOf(search);
  return index === -1 ? subject : subject.slice(0, index) + replace + subject.slice(index + search.length);
}

/** Str::replaceLast. */
export function replaceLast(search: string, replace: string, subject: string): string {
  if (search === "") return subject;
  const index = subject.lastIndexOf(search);
  return index === -1 ? subject : subject.slice(0, index) + replace + subject.slice(index + search.length);
}

/** PHP's trim() with its default characters. */
export function trim(value: string): string {
  return value.replace(/^[ \t\n\r\0\v]+|[ \t\n\r\0\v]+$/g, "");
}

/** PHP's ltrim() with its default characters. */
export function ltrim(value: string): string {
  return value.replace(/^[ \t\n\r\0\v]+/, "");
}

/** Laravel's blank(): null, an empty or whitespace string, an empty array. */
export function blank(value: PhpValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return trim(value) === "";
  if (value instanceof PhpArray) return value.size === 0;
  return false;
}

/** `filter_var($value, FILTER_VALIDATE_BOOLEAN)`. */
export function filterBoolean(value: PhpValue | undefined): boolean {
  if (value === true) return true;
  if (value === null || value === undefined || value === false || value instanceof PhpArray) return false;
  return ["1", "true", "on", "yes"].includes(trim(phpString(value)).toLowerCase());
}

/** `data_get($target, 'a.b', $default)` for plain keys: the default when a segment is missing. */
export function dataGet(target: PhpValue | undefined, path: string | readonly PhpKey[], fallback: PhpValue = null): PhpValue {
  let current: PhpValue | undefined = target;
  for (const segment of typeof path === "string" ? path.split(".") : path) {
    if (!(current instanceof PhpArray) || !current.has(segment)) return fallback;
    current = current.get(segment);
  }
  return current ?? null;
}

/** `collect($value)`: an array as it is, null as an empty collection, a scalar as a one-item list. */
export function collect(value: PhpValue | undefined): PhpArray {
  if (value instanceof PhpArray) return value.clone();
  if (value === null || value === undefined) return new PhpArray();
  return PhpArray.list([value]);
}

/** `array_merge` / Collection::merge: string keys are overwritten in place, integer keys are appended. */
export function merge(target: PhpArray, ...sources: PhpArray[]): PhpArray {
  const result = new PhpArray();
  for (const source of [target, ...sources]) {
    for (const [key, value] of source) {
      if (typeof key === "number") result.push(value);
      else result.set(key, value);
    }
  }
  return result;
}

/** PHP's loose `==` between two scalars or null (PHP 8), enough for comparing names. */
export function looseEquals(a: PhpValue | undefined, b: PhpValue | undefined): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (left instanceof PhpArray || right instanceof PhpArray) return false;
  if (left === null || right === null) {
    const other = left === null ? right : left;
    return other === null || other === false || other === "" || other === 0;
  }
  if (typeof left === "boolean" || typeof right === "boolean") {
    const truthy = (value: PhpValue) => !(value === false || value === "" || value === "0" || value === 0);
    return truthy(left) === truthy(right);
  }
  const leftText = phpString(left);
  const rightText = phpString(right);
  const leftNumeric = typeof left !== "string" || isNumericString(left);
  const rightNumeric = typeof right !== "string" || isNumericString(right);
  if (leftNumeric && rightNumeric) return Number(leftText) === Number(rightText);
  return leftText === rightText;
}

/** UTF-8 byte length, where PHP's strlen counts bytes. */
export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
