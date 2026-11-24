// Carbon's diffForHumans() for a past time: "5 minutes ago", "1 day ago".
const UNITS: Array<[string, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(1, Math.floor((now - Date.parse(iso)) / 1000));
  for (const [unit, size] of UNITS) {
    const n = Math.floor(s / size);
    if (n >= 1) return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  }
  return "1 second ago";
}

/** The units of Carbon's short form: "yr" / "yrs", "mo" / "mos", then one letter. */
const SHORT_UNITS: Array<[string, string, number]> = [
  ["yr", "yrs", 365 * 24 * 3600],
  ["mo", "mos", 30 * 24 * 3600],
  ["w", "w", 7 * 24 * 3600],
  ["d", "d", 24 * 3600],
  ["h", "h", 3600],
  ["m", "m", 60],
  ["s", "s", 1],
];

/** Carbon's diffForHumans(short: true) for a past time: "30s ago", "5m ago", "2mos ago", "1yr ago". */
export function agoShort(iso: string, now = Date.now()): string {
  const s = Math.max(1, Math.floor((now - Date.parse(iso)) / 1000));
  for (const [one, many, size] of SHORT_UNITS) {
    const n = Math.floor(s / size);
    if (n >= 1) return `${n}${n === 1 ? one : many} ago`;
  }
  return "1s ago";
}
