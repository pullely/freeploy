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
