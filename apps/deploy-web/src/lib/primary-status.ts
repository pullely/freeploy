// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/shared/destination.blade.php (the
// branch for what is not an application) (Apache-2.0), modified.

export type PrimaryStatusType = "success" | "error" | "warning" | "neutral";

/** Str::headline(): words split on separators and case changes, each capitalised. */
function headline(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * The primary server card's status of a database or a service: realStatus()'s type by its start, and its
 * label str($status)->before(':')->headline(), "Unknown" when empty.
 */
export function primaryStatus(status: string): { label: string; type: PrimaryStatusType } {
  const type: PrimaryStatusType = status.startsWith("running") ? "success" : status.startsWith("exited") ? "error" : status.startsWith("starting") || status.startsWith("restarting") ? "warning" : "neutral";
  const before = status.includes(":") ? status.slice(0, status.indexOf(":")) : status;
  return { label: headline(before) || "Unknown", type };
}
