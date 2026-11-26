// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/shared.php (validate_cron_expression) and
// bootstrap/helpers/constants.php (VALID_CRON_STRINGS) (Apache-2.0), modified.
//
// Cron expression checks for backup schedules (DP-65).
//
// The five-field parser below is an independent implementation, written from
// the verdicts Coolify's PHP gives (tests/deploy-core-worker/fixtures/s3,
// the `cron` goldens) and the crontab(5) manual. It is not derived from
// poliander/cron, the library Coolify calls, whose source was not consulted.
// Only the wrapper — empty input refused, Coolify's named schedules accepted
// as they are — follows Coolify's own helper.
//
// Accepted: `minute hour day-of-month month day-of-week`, separated by
// whitespace; in each field `*`, a number, a range `a-b` (a <= b), `*/n` or
// `a-b/n` (1 <= n <= the field's span), and comma lists of those. A month or
// weekday may also be written by its three-letter English name (any case),
// but only as the whole field. Weekday 0 and 7 are both Sunday. Refused:
// anything else (`L`, `W`, `#`, `?`, `@` macros other than Coolify's named
// ones, a single value with a step, empty list items, non-digits), and a
// schedule that can never fire (31 April, 30 February).

/** Coolify's VALID_CRON_STRINGS: accepted by name, exactly as written. */
const NAMED_SCHEDULES: ReadonlySet<string> = new Set([
  "every_minute",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "@hourly",
  "@daily",
  "@weekly",
  "@monthly",
  "@yearly",
]);

interface FieldSpec {
  lo: number;
  hi: number;
  names?: readonly string[];
  nameBase?: number;
}

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;
const WEEKDAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

const FIELDS: readonly FieldSpec[] = [
  { lo: 0, hi: 59 }, // minute
  { lo: 0, hi: 23 }, // hour
  { lo: 1, hi: 31 }, // day of month
  { lo: 1, hi: 12, names: MONTH_NAMES, nameBase: 1 }, // month
  { lo: 0, hi: 7, names: WEEKDAY_NAMES, nameBase: 0 }, // day of week (7 = Sunday)
];

const DIGITS = /^\d+$/;

function toNumber(text: string, spec: FieldSpec): number | null {
  if (!DIGITS.test(text)) return null;
  const n = Number(text);
  return n >= spec.lo && n <= spec.hi ? n : null;
}

/** One comma-separated item, as the set of values it selects, or null when malformed. */
function parseItem(item: string, spec: FieldSpec): number[] | null {
  const slash = item.split("/");
  if (slash.length > 2) return null;
  const [base, stepText] = slash as [string, string | undefined];

  let from: number;
  let to: number;
  if (base === "*") {
    from = spec.lo;
    to = spec.hi;
  } else {
    const dash = base.split("-");
    if (dash.length === 1) {
      if (stepText !== undefined) return null; // `5/2`: a step needs a range
      const n = toNumber(base, spec);
      return n === null ? null : [n];
    }
    if (dash.length !== 2) return null;
    const a = toNumber(dash[0]!, spec);
    const b = toNumber(dash[1]!, spec);
    if (a === null || b === null || a > b) return null;
    from = a;
    to = b;
  }

  let step = 1;
  if (stepText !== undefined) {
    if (!DIGITS.test(stepText)) return null;
    step = Number(stepText);
    if (step < 1 || step > spec.hi - spec.lo) return null;
  }
  const values: number[] = [];
  for (let v = from; v <= to; v += step) values.push(v);
  return values;
}

/** A whole field as its selected values, or null when it is not valid. */
function parseField(field: string, spec: FieldSpec): Set<number> | null {
  if (spec.names) {
    const index = spec.names.indexOf(field.toUpperCase() as never);
    if (index >= 0) return new Set([index + (spec.nameBase ?? 0)]);
  }
  const selected = new Set<number>();
  for (const item of field.split(",")) {
    const values = parseItem(item, spec);
    if (values === null) return null;
    for (const v of values) selected.add(v);
  }
  return selected;
}

/** Days searched for a date the schedule fires on: long enough to reach a 29 February. */
const SEARCH_DAYS = 9 * 366;
const DAY_MS = 86_400_000;

/**
 * Whether `expression` is a valid five-field cron expression that fires at
 * least once, looking forward from `now` (UTC). Named schedules are not
 * accepted here; see validateCronExpressionStrict().
 */
export function isValidCronExpression(expression: string, now: Date = new Date()): boolean {
  if (typeof expression !== "string") return false;
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== FIELDS.length) return false;

  const sets: Set<number>[] = [];
  for (let i = 0; i < FIELDS.length; i++) {
    const set = parseField(parts[i]!, FIELDS[i]!);
    if (set === null || set.size === 0) return false;
    sets.push(set);
  }
  const [, , days, months, weekdays] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (weekdays.has(7)) weekdays.add(0);

  // crontab(5): with both day fields restricted, a day matching either one fires.
  const dayRestricted = parts[2] !== "*";
  const weekdayRestricted = parts[4] !== "*";

  const start = Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  const startDay = Math.floor(start / DAY_MS) * DAY_MS;
  for (let d = 0; d < SEARCH_DAYS; d++) {
    const date = new Date(startDay + d * DAY_MS);
    if (!months.has(date.getUTCMonth() + 1)) continue;
    const dayOk = days.has(date.getUTCDate());
    const weekdayOk = weekdays.has(date.getUTCDay());
    const fires = dayRestricted && weekdayRestricted ? dayOk || weekdayOk : dayOk && weekdayOk;
    if (fires) return true;
  }
  return false;
}

/**
 * Coolify's validate_cron_expression(): empty input is refused, a named
 * schedule is accepted as written, anything else must be a valid five-field
 * expression.
 */
export function validateCronExpressionStrict(expression: unknown): boolean {
  if (typeof expression !== "string" || expression === "" || expression === "0") return false;
  if (NAMED_SCHEDULES.has(expression)) return true;
  return isValidCronExpression(expression);
}
