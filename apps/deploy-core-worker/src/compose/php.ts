// PHP's value model, as far as Coolify's Compose parser depends on it.
//
// Coolify's parser (bootstrap/helpers/parsers.php) works on what Symfony YAML returns: PHP arrays —
// ordered maps whose keys are integers or strings, where a "list" is only an array whose keys happen
// to be 0..n-1 — and scalars that are cast to strings all over (`str($value)`, "$key=$value"). A port
// that used JavaScript arrays and objects would lose the key order (`{ "80": …, a: … }` is reordered),
// the difference between 3 and 3.0, and what `merge`, `put` and `diffKeys` do to integer keys. So the
// port keeps PHP's model: `PhpArray` for every collection, `PhpFloat` for a float, and the casts below.
// Nothing in this file is copied from Coolify; it restates documented PHP behaviour.

/** A PHP float. An integer is a plain `number` (or a `bigint` beyond 2^53). */
export class PhpFloat {
  readonly value: number;

  constructor(value: number) {
    this.value = value;
  }
}

export type PhpKey = number | string;
export type PhpValue = null | boolean | number | bigint | PhpFloat | string | PhpArray;

const INT_KEY = /^(?:0|-?[1-9][0-9]*)$/;

/** PHP turns the string key "8" into the integer 8, but not "08", "8.0" or "-0". */
export function normalizeKey(key: PhpKey): PhpKey {
  if (typeof key === "number") return key;
  if (INT_KEY.test(key) && key !== "-0") {
    const n = Number(key);
    if (Number.isSafeInteger(n)) return n;
  }
  return key;
}

/** A PHP array: an ordered map with integer and string keys. */
export class PhpArray<V = PhpValue> {
  private readonly map = new Map<PhpKey, V>();
  private nextIndex = 0;

  static list<V>(values: Iterable<V>): PhpArray<V> {
    const array = new PhpArray<V>();
    for (const value of values) array.push(value);
    return array;
  }

  static from<V>(entries: Iterable<readonly [PhpKey, V]>): PhpArray<V> {
    const array = new PhpArray<V>();
    for (const [key, value] of entries) array.set(key, value);
    return array;
  }

  get size(): number {
    return this.map.size;
  }

  has(key: PhpKey): boolean {
    return this.map.has(normalizeKey(key));
  }

  get(key: PhpKey): V | undefined {
    return this.map.get(normalizeKey(key));
  }

  /** `$array[$key] = $value`: an existing key keeps its position. */
  set(key: PhpKey, value: V): this {
    const normalized = normalizeKey(key);
    this.map.set(normalized, value);
    if (typeof normalized === "number" && normalized >= this.nextIndex) this.nextIndex = normalized + 1;
    return this;
  }

  /** `$array[] = $value`. */
  push(value: V): this {
    this.map.set(this.nextIndex, value);
    this.nextIndex += 1;
    return this;
  }

  delete(key: PhpKey): boolean {
    return this.map.delete(normalizeKey(key));
  }

  keys(): PhpKey[] {
    return [...this.map.keys()];
  }

  values(): V[] {
    return [...this.map.values()];
  }

  entries(): [PhpKey, V][] {
    return [...this.map.entries()];
  }

  [Symbol.iterator](): IterableIterator<[PhpKey, V]> {
    return this.map.entries();
  }

  /** `array_is_list`: the keys are 0..n-1 in order. An empty array is a list. */
  isList(): boolean {
    let expected = 0;
    for (const key of this.map.keys()) {
      if (key !== expected) return false;
      expected += 1;
    }
    return true;
  }

  /** A shallow copy, as assigning a PHP array to another variable gives. */
  clone(): PhpArray<V> {
    const copy = new PhpArray<V>();
    for (const [key, value] of this.map) copy.set(key, value);
    copy.nextIndex = this.nextIndex;
    return copy;
  }
}

export function isPhpArray(value: unknown): value is PhpArray {
  return value instanceof PhpArray;
}

/** A deep copy: PHP arrays are values, so nested arrays are copied when the outer one is. */
export function deepClone(value: PhpValue): PhpValue {
  if (!(value instanceof PhpArray)) return value;
  const copy = new PhpArray();
  for (const [key, item] of value) copy.set(key, deepClone(item));
  return copy;
}

/** `(string) $float` with PHP's default `precision` of 14. */
export function phpFloatToString(value: number): string {
  if (Number.isNaN(value)) return "NAN";
  if (value === Infinity) return "INF";
  if (value === -Infinity) return "-INF";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const [mantissa = "", exponentText = "0"] = value.toExponential(13).split("e");
  const exponent = Number(exponentText);
  const negative = mantissa.startsWith("-");
  const digits = mantissa.replace("-", "").replace(".", "").replace(/0+$/, "") || "0";
  const sign = negative ? "-" : "";
  if (exponent < -4 || exponent >= 14) {
    const fraction = digits.length > 1 ? digits.slice(1) : "0";
    return `${sign}${digits[0] ?? "0"}.${fraction}E${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent))}`;
  }
  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  if (digits.length <= exponent + 1) return `${sign}${digits}${"0".repeat(exponent + 1 - digits.length)}`;
  return `${sign}${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
}

/** `(string) $value` for a scalar: true is "1", false and null are "". An array casts to "Array". */
export function phpString(value: PhpValue | undefined): string {
  if (value === null || value === undefined || value === false) return "";
  if (value === true) return "1";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof PhpFloat) return phpFloatToString(value.value);
  return "Array";
}

const NUMERIC = /^[ \t\n\r\v\f]*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?[ \t\n\r\v\f]*$/;

/** `is_numeric()` for a string (PHP 8: surrounding whitespace is allowed). */
export function isNumericString(value: string): boolean {
  return NUMERIC.test(value);
}

/** `is_numeric()`. */
export function isNumeric(value: PhpValue | undefined): boolean {
  if (typeof value === "number" || typeof value === "bigint" || value instanceof PhpFloat) return true;
  return typeof value === "string" && isNumericString(value);
}

/** PHP's truthiness: `(bool) $value`. */
export function phpTruthy(value: PhpValue | undefined): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === true) return true;
  if (typeof value === "string") return value !== "" && value !== "0";
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  if (value instanceof PhpFloat) return value.value !== 0;
  return value.size > 0;
}

/** UTF-8 bytes of a string, for the places where PHP counts or matches bytes. */
export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
