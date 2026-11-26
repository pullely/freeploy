// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/tags/show.blade.php (tagsIndex()) and
// app/Livewire/Tags/Show.php (setDeploymentSort, activeDeployments) (Apache-2.0), modified.
//
// The Tags page's models (DP-97): the list's search, sorts and pages, and the active deployments' sorts.

export interface TagSummary {
  id: string;
  name: string;
  applicationsCount: number;
  servicesCount: number;
  resourceCount: number;
}

export type TagSort = "name-asc" | "name-desc" | "resources-asc" | "resources-desc" | "applications-asc" | "applications-desc" | "services-asc" | "services-desc";

/** sortOptions: the grid's dropdown (the table's headers have the other sorts). */
export const TAG_SORT_OPTIONS: Array<{ value: TagSort; label: string }> = [
  { value: "name-asc", label: "Name A–Z" },
  { value: "name-desc", label: "Name Z–A" },
  { value: "resources-desc", label: "Most resources" },
];

/** tagsIndex().filteredTags: by a case-insensitive name match, then the sort with the name as the tie-breaker. */
export function filterTags(tags: readonly TagSummary[], search: string, sortBy: TagSort): TagSummary[] {
  const query = search.trim().toLowerCase();
  const found = tags.filter((tag) => !query || tag.name.toLowerCase().includes(query));
  const [column, direction] = sortBy.split("-") as [string, string];
  const values: Record<string, (tag: TagSummary) => string | number> = {
    name: (tag) => tag.name,
    resources: (tag) => Number(tag.resourceCount),
    applications: (tag) => Number(tag.applicationsCount),
    services: (tag) => Number(tag.servicesCount),
  };
  const value = values[column] ?? values.name!;
  const order = direction === "desc" ? -1 : 1;
  const compare = (a: string | number, b: string | number) => (typeof a === "number" ? a - (b as number) : a.localeCompare(b as string));
  return found.sort((a, b) => order * compare(value(a), value(b)) || a.name.localeCompare(b.name));
}

/** paginatedTags and the summary "start-end of total"; the page is kept inside the last one. */
export function pageOfTags(tags: readonly TagSummary[], page: number, pageSize: number): { page: number; totalPages: number; items: TagSummary[]; rangeStart: number; rangeEnd: number } {
  const totalPages = Math.max(1, Math.ceil(tags.length / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const start = (current - 1) * pageSize;
  return { page: current, totalPages, items: tags.slice(start, start + pageSize), rangeStart: tags.length === 0 ? 0 : start + 1, rangeEnd: Math.min(current * pageSize, tags.length) };
}

export interface ActiveDeployment {
  id: string;
  applicationName: string | null;
  deploymentUrl: string | null;
  pullRequestId: number;
  serverName: string | null;
  status: string;
}

export type DeploymentSort = "resource-asc" | "resource-desc" | "server-asc" | "server-desc" | "status-asc" | "status-desc";

/** PHP's strcasecmp(): ASCII letters folded, then byte order. */
function strcasecmp(a: string, b: string): number {
  const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const x = fold(a);
  const y = fold(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** activeDeployments(): in id order without a sort; else by the column (strcasecmp), then by id. */
export function sortDeployments(deployments: readonly ActiveDeployment[], sort: DeploymentSort | null): ActiveDeployment[] {
  if (sort === null) return [...deployments];
  const [column, direction] = sort.split("-") as [keyof typeof FIELDS, string];
  const field = FIELDS[column];
  const order = direction === "desc" ? -1 : 1;
  return [...deployments].sort((a, b) => order * strcasecmp(String(a[field] ?? ""), String(b[field] ?? "")) || Number(a.id) - Number(b.id));
}

const FIELDS = { resource: "applicationName", server: "serverName", status: "status" } as const;

/** str('in_progress')->headline() */
export const deploymentStatusLabel = (status: string): string =>
  status
    .replace(/[-_]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

/** Str::plural('tag', $n) / Str::plural('resource', $n) */
export const plural = (word: string, n: number): string => (n === 1 ? word : `${word}s`);
