// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Server/Resources.php (render, sortColumns) and
// resources/views/livewire/server/{resources,sentinel/logs}.blade.php (Apache-2.0), modified.
//
// What the server pages of DP-96 decide in the browser: Laravel's Str::headline() of a type or status (as the views
// call it), the resource list's sort, search and pages, the status badges' types and Sentinel's status badge.

/** Str::headline(): words split on -, _, spaces and capitals, each capitalized (a colon starts a word, as MB_CASE_TITLE). */
export function headline(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase()))
    .join(" ");
}

/** A resource of GET /servers/{uuid}/resources. */
export interface ServerResourceRow {
  uuid: string;
  name: string;
  /** $resource->type(): application, service, standalone-postgresql, … */
  type: string;
  status: string;
  project: string | null;
  environment: string | null;
  link: string | null;
}

export type ResourceColumn = "name" | "project" | "environment" | "type" | "status";
const COLUMNS: readonly ResourceColumn[] = ["name", "project", "environment", "type", "status"];

/** SORT_NATURAL | SORT_FLAG_CASE */
const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

/**
 * Resources::render(): sorted by name, then by the chosen column (a stable sort, descending when asked; an unknown
 * column sorts by name), filtered by name (case-insensitive), then the page — the page size clamped to 1–100 and
 * the page to the pages there are.
 */
export function shownResources(rows: readonly ServerResourceRow[], sort: string, search: string, page: number, perPage: number) {
  const [column, direction] = sort.split("_") as [string, string | undefined];
  const col: ResourceColumn = (COLUMNS as readonly string[]).includes(column) ? (column as ResourceColumn) : "name";
  const key = (r: ServerResourceRow) => String(r[col] ?? "");
  const byName = [...rows].sort((a, b) => natural(a.name, b.name));
  const sorted = byName
    .map((r, i) => ({ r, i }))
    .sort((a, b) => natural(key(a.r), key(b.r)) * (direction === "desc" ? -1 : 1) || a.i - b.i)
    .map((x) => x.r);
  const q = search.trim().toLowerCase();
  const matching = q === "" ? sorted : sorted.filter((r) => r.name.toLowerCase().includes(q));
  const size = Math.max(1, Math.min(100, perPage));
  const lastPage = Math.max(1, Math.ceil(matching.length / size));
  const current = Math.max(1, Math.min(page, lastPage));
  return {
    total: matching.length,
    page: current,
    lastPage,
    rows: matching.slice((current - 1) * size, current * size),
    from: matching.length ? (current - 1) * size + 1 : 0,
    to: Math.min(current * size, matching.length),
  };
}

/** The managed list's status badge: running is success, failed or exited an error, anything else neutral. */
export function resourceStatusType(status: string): "success" | "error" | "neutral" {
  return status.includes("running") ? "success" : status.includes("failed") || status.includes("exited") ? "error" : "neutral";
}

export type SentinelStatus = "restarting" | "waiting" | "in_sync" | "out_of_sync";

/** Sentinel logs' status badge (the view's match): waiting, in sync, anything else out of sync. */
export function sentinelBadge(status: SentinelStatus): { label: string; type: "neutral" | "success" | "warning" } {
  if (status === "waiting") return { label: "Waiting for first report", type: "neutral" };
  if (status === "in_sync") return { label: "In sync", type: "success" };
  return { label: "Out of sync", type: "warning" };
}
