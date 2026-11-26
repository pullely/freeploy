// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/application/backup/index.blade.php and
// resources/views/livewire/project/service/volume-backup/index.blade.php (the Alpine list: search, type filter, sorts,
// the status labels) (Apache-2.0), modified.
//
// The storage backup lists' model (DP-99), apart from the page so that it can be tested.

export interface BackupListItem {
  uuid: string;
  targetName: string;
  targetType: string;
  frequency: string;
  enabled: boolean;
  saveS3: boolean;
  storages: Array<{ name: string; label: string }>;
  latestStatus: string | null;
  latestFinishedAt: string | null;
  executionsCount: number;
  databaseRunning?: boolean;
}

/** The status badge of a schedule: its latest execution's, else Waiting or Disabled. */
export function scheduleStatus(b: Pick<BackupListItem, "latestStatus" | "enabled">): [string, "neutral" | "success" | "warning" | "error"] {
  if (b.latestStatus === "running") return ["In progress", "warning"];
  if (b.latestStatus === "success") return ["Success", "success"];
  if (b.latestStatus === "failed") return ["Failed", "error"];
  return [b.enabled ? "Waiting" : "Disabled", "neutral"];
}

type SortKey = "target" | "type" | "schedule" | "status" | "s3" | "lastrun" | "executions";

/**
 * filteredBackups(): the search over target, type and schedule (lower case), the type filter, then the sort of
 * `column_direction` — a number by value, text by localeCompare() — with the target's name as the tie-breaker.
 */
export function filterBackups<T extends BackupListItem>(all: readonly T[], search: string, typeFilter: string, sortBy: string, now = Date.now()): T[] {
  const q = search.toLowerCase();
  const values: Record<SortKey, (b: T) => string | number> = {
    target: (b) => b.targetName.toLowerCase(),
    type: (b) => b.targetType.toLowerCase(),
    schedule: (b) => b.frequency.toLowerCase(),
    status: (b) => scheduleStatus(b)[0].toLowerCase(),
    s3: (b) => (b.saveS3 ? b.storages.length : -1),
    lastrun: (b) => (b.latestFinishedAt ? Date.parse(b.latestFinishedAt) / 1000 : b.latestStatus === "running" ? now / 1000 : 0),
    executions: (b) => b.executionsCount,
  };
  const [column, direction] = sortBy.split("_") as [SortKey, string];
  const value = values[column] ?? values.target;
  const order = direction === "desc" ? -1 : 1;
  return all
    .filter((b) => (!q || b.targetName.toLowerCase().includes(q) || b.targetType.toLowerCase().includes(q) || b.frequency.toLowerCase().includes(q)) && (typeFilter === "all" || b.targetType.toLowerCase() === typeFilter))
    .sort((l, r) => {
      const a = value(l);
      const b = value(r);
      return order * (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b))) || l.targetName.toLowerCase().localeCompare(r.targetName.toLowerCase());
    });
}

/** filterOptions: All targets, each type of the schedules, and Database on a service's list. */
export function backupFilterOptions(backups: readonly BackupListItem[], withDatabase: boolean): Array<{ value: string; label: string }> {
  const types = new Map<string, string>(backups.map((b) => [b.targetType.toLowerCase(), b.targetType]));
  if (withDatabase && !types.has("database")) types.set("database", "Database");
  return [{ value: "all", label: "All targets" }, ...[...types.entries()].map(([value, label]) => ({ value, label }))];
}
