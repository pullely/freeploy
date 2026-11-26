// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Dashboard.php (ITEM_LIMIT, the sort columns, sortItems,
// isValidSort, setProjectSort, setServerSort), resources/views/livewire/dashboard.blade.php and
// resources/views/livewire/dashboard/active-deployments.blade.php ($deploymentStatusMeta) (Apache-2.0), modified.
//
// What the dashboard at / decides in the browser (DP-100): the projects' and the servers' sorts and the first eight of
// each, the singular and plural words of the cards, and a deployment's status badge.

/** Str::headline(): words split on -, _, spaces and capitals, each capitalized (as lib/server-pages.ts has it). */
function headline(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase()))
    .join(" ");
}

/** Dashboard::ITEM_LIMIT: the dashboard shows only the first projects and servers of the sorted lists. */
export const DASHBOARD_ITEM_LIMIT = 8;

export const PROJECT_SORT_COLUMNS = ["name", "resources", "description"] as const;
export const SERVER_SORT_COLUMNS = ["name", "description", "status"] as const;

export interface DashboardProject {
  uuid: string;
  name: string;
  description: string | null;
  environmentCount: number;
  resourceCount: number;
  onlyEnvironmentUuid: string | null;
  firstEnvironmentUuid: string | null;
}

export interface DashboardServer {
  uuid: string;
  name: string;
  description: string | null;
  status: string;
  statusType: "success" | "warning" | "error";
  isMetricsEnabled: boolean;
}

export interface DashboardDeployment {
  deploymentUuid: string;
  applicationName: string | null;
  deploymentUrl: string | null;
  pullRequestId: number;
  serverName: string | null;
  status: string;
  imageScanBlocked: boolean;
  createdAt: string | null;
  finishedAt: string | null;
  environmentPath: string;
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
const isSpace = (c: string | undefined): boolean => c === " " || (c !== undefined && c >= "\t" && c <= "\r");

/**
 * PHP's strnatcasecmp() (strnatcmp.c), which SORT_NATURAL | SORT_FLAG_CASE sorts with: runs of digits compare as
 * numbers (as fractions when one starts with "0"), white space is skipped, the rest compares case-folded.
 */
export function strnatcasecmp(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return a.length === 0 ? (b.length === 0 ? 0 : -1) : 1;
  let i = 0;
  let j = 0;
  while (a[i] === "0" && isDigit(a[i + 1])) i++;
  while (b[j] === "0" && isDigit(b[j + 1])) j++;
  for (;;) {
    while (isSpace(a[i])) i++;
    while (isSpace(b[j])) j++;
    if (isDigit(a[i]) && isDigit(b[j])) {
      const fractional = a[i] === "0" || b[j] === "0";
      let x = i;
      let y = j;
      while (isDigit(a[x])) x++;
      while (isDigit(b[y])) y++;
      const ra = a.slice(i, x);
      const rb = b.slice(j, y);
      let result = 0;
      if (fractional) {
        const n = Math.min(ra.length, rb.length);
        for (let k = 0; k < n && result === 0; k++) if (ra[k] !== rb[k]) result = ra[k]! < rb[k]! ? -1 : 1;
        if (result === 0 && ra.length !== rb.length) result = ra.length < rb.length ? -1 : 1;
      } else if (ra.length !== rb.length) {
        result = ra.length < rb.length ? -1 : 1;
      } else if (ra !== rb) {
        result = ra < rb ? -1 : 1;
      }
      if (result !== 0) return result;
      i = x;
      j = y;
      if (i >= a.length && j >= b.length) return 0;
      if (i >= a.length) return -1;
      if (j >= b.length) return 1;
    }
    const ca = (a[i] ?? "").toUpperCase();
    const cb = (b[j] ?? "").toUpperCase();
    if (ca < cb) return -1;
    if (ca > cb) return 1;
    i++;
    j++;
    if (i >= a.length && j >= b.length) return 0;
    if (i >= a.length) return -1;
    if (j >= b.length) return 1;
  }
}

/** Collection::sortBy($callback, SORT_NATURAL | SORT_FLAG_CASE, $descending): a stable sort. */
function sortBy<T>(items: readonly T[], value: (item: T) => string | number, descending = false): T[] {
  return items
    .map((item, index) => ({ item, index, key: String(value(item)) }))
    .sort((x, y) => (descending ? -1 : 1) * strnatcasecmp(x.key, y.key) || x.index - y.index)
    .map((x) => x.item);
}

/** Dashboard::isValidSort(): a known column and asc or desc. */
export function isValidSort(sort: string, columns: readonly string[]): boolean {
  const at = sort.indexOf("-");
  const [column, direction] = at === -1 ? [sort, null] : [sort.slice(0, at), sort.slice(at + 1)];
  return columns.includes(column) && (direction === "asc" || direction === "desc");
}

/** Dashboard::sortItems(): by name, then by the sort's column (the name breaks ties), descending when asked. */
export function sortItems<T extends { name: string }>(items: readonly T[], sort: string, value: (item: T, column: string) => string | number): T[] {
  const at = sort.indexOf("-");
  const column = sort.slice(0, at);
  const direction = sort.slice(at + 1);
  return sortBy(
    sortBy(items, (item) => item.name),
    (item) => value(item, column),
    direction === "desc",
  );
}

/** sortedProjects(): name, resources (the count) or description. */
export const projectSortValue = (project: DashboardProject, column: string): string | number =>
  column === "resources" ? Number(project.resourceCount) : column === "description" ? (project.description ?? "") : project.name;

/** sortedServers(): name, description or status (serverStatus()'s label). */
export const serverSortValue = (server: DashboardServer, column: string): string => (column === "description" ? (server.description ?? "") : column === "status" ? server.status : server.name);

/** render(): the sorted lists' first ITEM_LIMIT items. */
export function dashboardProjects(projects: readonly DashboardProject[], sort: string): DashboardProject[] {
  return sortItems(projects, sort, projectSortValue).slice(0, DASHBOARD_ITEM_LIMIT);
}

export function dashboardServers(servers: readonly DashboardServer[], sort: string): DashboardServer[] {
  return sortItems(servers, sort, serverSortValue).slice(0, DASHBOARD_ITEM_LIMIT);
}

/** Project::navigateTo(): a project with exactly one environment opens it, else the project. */
export function projectHref(project: Pick<DashboardProject, "uuid" | "onlyEnvironmentUuid">): string {
  return project.onlyEnvironmentUuid ? `/project/${project.uuid}/environment/${project.onlyEnvironmentUuid}` : `/project/${project.uuid}`;
}

/** The card's "1 environment" / "2 environments", "1 resource" / "0 resources". */
export const countWord = (count: number, one: string, many: string): string => (Number(count) === 1 ? one : many);

/** $deploymentStatusMeta: the label and badge type of a deployment. */
export function deploymentStatusMeta(deployment: Pick<DashboardDeployment, "status" | "imageScanBlocked">): [string, "success" | "warning" | "error" | "neutral"] {
  if (deployment.imageScanBlocked) return ["Blocked", "error"];
  const status = String(deployment.status ?? "");
  const labels: Record<string, string> = { finished: "Success", in_progress: "In progress", "cancelled-by-user": "Cancelled", queued: "Queued", failed: "Failed" };
  const label = labels[status] ?? headline(status);
  const type = status === "finished" ? "success" : status === "in_progress" || status === "queued" ? "warning" : status === "failed" ? "error" : "neutral";
  return [label, type];
}

/** The section's title: "Recent deployments" when it lists finished ones, else "Deployments". */
export const deploymentsTitle = (recent: number): string => (recent > 0 ? "Recent deployments" : "Deployments");
