// What Coolify's security status engine leans on from PHP and Laravel, restated: casts, trim(), blank()/filled(),
// data_get(), the comparison of `<=>` and usort(), version_compare() (ext/standard/versioning.c), mb_* on code points,
// and Carbon's toIso8601String() and diffForHumans() for the fixed clock of a request. Nothing here is copied from Coolify.

/** A decoded JSON value as PHP's json_decode(…, true) gives it: objects are plain records (key order is jsonb's). */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** PHP's trim(): " \t\n\r\0\x0B" only. */
export const phpTrim = (s: string): string => s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "");

/** (string) $value for the scalars a decoded row holds. */
export function str(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (v === true) return "1";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === "string") return v;
  return "Array";
}

/** is_numeric(). */
export function isNumeric(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v !== "string") return false;
  return /^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\v\f]*$/.test(v);
}

/** (float) $value: a leading numeric string, else 0. */
export function float(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v !== "string") return 0;
  const m = /^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(v);
  return m ? Number(m[0]) : 0;
}

/** (int) $value. */
export function int(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") return Math.trunc(float(v));
  return 0;
}

/** (bool) $value. */
export function bool(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "" || v === "0") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isRecord(v)) return Object.keys(v).length > 0;
  return true;
}

/** Laravel's blank(). */
export function blank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return phpTrim(v) === "";
  if (typeof v === "number" || typeof v === "boolean") return false;
  if (Array.isArray(v)) return v.length === 0;
  if (isRecord(v)) return Object.keys(v).length === 0;
  return false;
}
export const filled = (v: unknown): boolean => !blank(v);

/** (array) $value of a decoded JSON value: a list stays a list, a record its values keyed; a scalar is [scalar]. */
export function list(v: unknown): unknown[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (isRecord(v)) return Object.values(v);
  return [v];
}

/** (array) $value as a record (a list's indexes as its keys). */
export function record(v: unknown): Record<string, unknown> {
  if (isRecord(v)) return v;
  if (Array.isArray(v)) return Object.fromEntries(v.map((x, i) => [String(i), x]));
  if (v === null || v === undefined) return {};
  return { "0": v };
}

/** array_is_list(): a JSON array, or an empty value. */
export const isList = (v: unknown): boolean => Array.isArray(v);

/** data_get($target, "a.b.0") on decoded arrays. */
export function dataGet(target: unknown, path: string, fallback: unknown = null): unknown {
  let current: unknown = target;
  for (const key of path.split(".")) {
    if (Array.isArray(current)) {
      const index = /^(?:0|[1-9]\d*)$/.test(key) ? Number(key) : -1;
      if (index < 0 || index >= current.length) return fallback;
      current = current[index];
    } else if (isRecord(current)) {
      if (!(key in current)) return fallback;
      current = current[key];
    } else return fallback;
  }
  return current === undefined ? fallback : current;
}

/** isset($a[$k]): present and not null. */
export const isset = (v: unknown): boolean => v !== null && v !== undefined;

/** PHP 8's comparison of two strings: numeric strings as numbers, else byte by byte. */
function compareStrings(a: string, b: string): number {
  if (isNumeric(a) && isNumeric(b)) return Math.sign(Number(a) - Number(b));
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `$a <=> $b` for the values the engine compares: numbers, booleans, strings, null and arrays of them, element by element. */
export function spaceship(a: unknown, b: unknown): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    for (let i = 0; i < a.length; i++) {
      const c = spaceship(a[i], b[i]);
      if (c !== 0) return c;
    }
    return 0;
  }
  if (typeof a === "string" && typeof b === "string") return compareStrings(a, b);
  if (typeof a === "boolean" || typeof b === "boolean") return Math.sign(Number(bool(a)) - Number(bool(b)));
  if (a === null && b === null) return 0;
  const x = typeof a === "number" ? a : float(a);
  const y = typeof b === "number" ? b : float(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** mb_strtolower(). */
export const lower = (s: string): string => s.toLowerCase();

/** mb_substr($s, $start, $length) on code points. */
export function mbSubstr(s: string, start: number, length?: number): string {
  const points = [...s];
  return points.slice(start, length === undefined ? undefined : start + length).join("");
}

/** array_values(array_unique($list)) of strings. */
export const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

// ── version_compare() ───────────────────────────────────────────────────────

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isAlnum = (c: string): boolean => /^[A-Za-z0-9]$/.test(c);

/** php_canonicalize_version(). */
function canonicalize(version: string): string {
  if (version === "") return "";
  let out = version[0]!;
  let lp = version[0]!;
  const isdig = (x: string) => isDigit(x) && x !== ".";
  const isndig = (x: string) => !isDigit(x) && x !== ".";
  for (let i = 1; i < version.length; i++) {
    const p = version[i]!;
    const last = out[out.length - 1];
    if (p === "-" || p === "_" || p === "+") {
      if (last !== ".") out += ".";
    } else if ((isndig(lp) && isdig(p)) || (isdig(lp) && isndig(p))) {
      if (last !== ".") out += ".";
      out += p;
    } else if (!isAlnum(p)) {
      if (last !== ".") out += ".";
    } else out += p;
    lp = p;
  }
  return out;
}

const SPECIAL_FORMS: Array<[string, number]> = [["dev", 0], ["alpha", 1], ["a", 1], ["beta", 2], ["b", 2], ["RC", 3], ["rc", 3], ["#", 4], ["pl", 5], ["p", 5]];
function specialForm(form: string): number {
  for (const [name, order] of SPECIAL_FORMS) if (form.startsWith(name)) return order;
  return -1;
}

function compareCanonical(v1: string, v2: string): number {
  if (v1 === "" && v2 === "") return 0;
  if (v1 === "") return v2 === "" ? 0 : -1;
  if (v2 === "") return 1;
  const p1 = v1.split(".");
  const p2 = v2.split(".");
  let compare = 0;
  let i = 0;
  for (; i < p1.length && i < p2.length && compare === 0; i++) {
    const a = p1[i]!;
    const b = p2[i]!;
    const da = a !== "" && isDigit(a[0]!);
    const db = b !== "" && isDigit(b[0]!);
    if (da && db) {
      const x = Number.parseInt(a, 10);
      const y = Number.parseInt(b, 10);
      compare = Math.sign(x - y);
    } else if (!da && !db) compare = Math.sign(specialForm(a) - specialForm(b));
    else if (da) compare = Math.sign(specialForm("#N#") - specialForm(b));
    else compare = Math.sign(specialForm(a) - specialForm("#N#"));
  }
  if (compare === 0) {
    if (i < p1.length) {
      const rest = p1[i]!;
      compare = rest !== "" && isDigit(rest[0]!) ? 1 : compareCanonical(p1.slice(i).join("."), "#N#");
    } else if (i < p2.length) {
      const rest = p2[i]!;
      compare = rest !== "" && isDigit(rest[0]!) ? -1 : compareCanonical("#N#", p2.slice(i).join("."));
    }
  }
  return compare;
}

/** version_compare($a, $b): -1, 0 or 1. */
export function versionCompare(a: string, b: string): number {
  return compareCanonical(canonicalize(a), canonicalize(b));
}

// ── Carbon ──────────────────────────────────────────────────────────────────

/** A stored time: "Y-m-d H:i:s" (a timestamp column read as UTC) or ISO 8601 with an offset, as Carbon::parse() reads it. */
export function parseTime(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string" || value === "") return null;
  const sql = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)(\.\d+)?$/.exec(value);
  const date = sql ? new Date(Date.UTC(+sql[1]!, +sql[2]! - 1, +sql[3]!, +sql[4]!, +sql[5]!, +sql[6]!)) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** Carbon's toIso8601String() of a UTC time: 2025-12-31T12:00:00+00:00. */
export function iso8601(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00:00`;
}

const daysInMonth = (year: number, month0: number): number => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

/**
 * Carbon 3's diffForHumans() against `now` with its defaults: the largest unit of DateTime::diff() (years, months, weeks
 * from the days, days, hours, minutes, seconds), truncated, "ago" for the past and "from now" for the future.
 */
export function diffForHumans(time: Date, now: Date): string {
  const future = time.getTime() > now.getTime();
  const [from, to] = future ? [now, time] : [time, now];
  let years = to.getUTCFullYear() - from.getUTCFullYear();
  let months = to.getUTCMonth() - from.getUTCMonth();
  let days = to.getUTCDate() - from.getUTCDate();
  let hours = to.getUTCHours() - from.getUTCHours();
  let minutes = to.getUTCMinutes() - from.getUTCMinutes();
  let seconds = to.getUTCSeconds() - from.getUTCSeconds();
  if (seconds < 0) {
    seconds += 60;
    minutes -= 1;
  }
  if (minutes < 0) {
    minutes += 60;
    hours -= 1;
  }
  if (hours < 0) {
    hours += 24;
    days -= 1;
  }
  if (days < 0) {
    const month = to.getUTCMonth() - 1;
    days += daysInMonth(month < 0 ? to.getUTCFullYear() - 1 : to.getUTCFullYear(), (month + 12) % 12);
    months -= 1;
  }
  if (months < 0) {
    months += 12;
    years -= 1;
  }
  const units: Array<[number, string]> = [
    [years, "year"],
    [months, "month"],
    [Math.floor(days / 7), "week"],
    [days, "day"],
    [hours, "hour"],
    [minutes, "minute"],
    [seconds, "second"],
  ];
  const [count, unit] = units.find(([n]) => n > 0) ?? [0, "second"];
  return `${count} ${unit}${count === 1 ? "" : "s"} ${future ? "from now" : "ago"}`;
}

/** now()->subDays($n). */
export const subDays = (d: Date, n: number): Date => new Date(d.getTime() - n * 86_400_000);
