// Derived from coollabsio/coolify@91b7e3e:app/Livewire/ImageScan/FleetVulnerabilities.php,
// resources/views/livewire/image-scan/fleet-vulnerabilities.blade.php and app/Services/ImageScan/{TeamVulnerabilities,
// FleetExport}.php (vulnerabilitiesUrl, entries) (Apache-2.0), modified.
//
// The team Security page at /vulnerabilities (spec 15.8), without the DOM (DP-114): the org's resources with their stored
// security status, most urgent first, and a search by vulnerability ID or package across their current scans; the
// filters by status, server and project, the hidden "Not checked" resources, and the exports. No buttons and no bulk
// actions. The page's state (search, statuses, servers, projects, showNotChecked, page, perPage) is the request's query,
// normalized as normalizeFilters() normalizes it. The live reload on scan events is not ported: Freeploy runs no scan.
import type { ScanData, ScanResource } from "./model.js";
import { diffForHumans, iso8601, phpTrim, str } from "./php.js";
import { action, imagesLine, MAX_DECODED_SCANS, searchTeam, STATE_LABELS, STATUS_ORDER, statusLabel, type SearchMatch, type TeamEntry } from "./team-vulnerabilities.js";
import { dayDateTime } from "./vulnerabilities-page.js";
import type { FleetExportEntry } from "./exports.js";

export interface FleetState {
  search: string;
  statuses: string[];
  servers: string[];
  projects: string[];
  showNotChecked: boolean;
  page: number;
  perPage: number;
}

export function fleetState(q: URLSearchParams): FleetState {
  const strings = (name: string) => [...new Set(q.getAll(name).flatMap((v) => v.split(",")).filter((v) => v !== ""))];
  const n = Number.parseInt(q.get("page") ?? "", 10);
  const p = Number.parseInt(q.get("perPage") ?? "", 10);
  return {
    search: q.get("search") ?? "",
    servers: strings("servers"),
    projects: strings("projects"),
    statuses: strings("statuses").filter((s) => (STATUS_ORDER as readonly string[]).includes(s)),
    showNotChecked: q.get("showNotChecked") === "1" || q.get("showNotChecked") === "true",
    page: Number.isFinite(n) ? n : 1,
    perPage: Number.isFinite(p) ? p : 25,
  };
}

export interface Place {
  environmentName: string | null;
  projectUuid: string | null;
  projectName: string | null;
}

export interface FleetEntry extends TeamEntry {
  place: Place;
  link: string | null;
  match?: SearchMatch;
}

/** TeamVulnerabilities::vulnerabilitiesUrl() */
export function vulnerabilitiesUrl(resource: ScanResource): string | null {
  const env = resource.environment;
  if (env === null || env.projectUuid === null) return null;
  const kind = resource.kind === "application" ? "application" : resource.kind === "service" ? "service" : "database";
  return `/project/${env.projectUuid}/environment/${env.uuid}/${kind}/${resource.uuid}/vulnerabilities`;
}

const natcase = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

/** byStatus(): update_now … not_checked, then the resource name. */
export function byStatus<T extends TeamEntry>(entries: readonly T[]): T[] {
  const rank = (s: string) => (STATUS_ORDER as readonly string[]).indexOf(s);
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e.security.status) - rank(b.e.security.status) || natcase(str(a.e.resource.name), str(b.e.resource.name)) || a.i - b.i)
    .map(({ e }) => e);
}

/** "3 resources on 2 servers were not scanned, so Coolify cannot tell." */
export function notScannedSentence(resources: number, servers: number): string {
  let subject = `${resources} ${resources === 1 ? "resource" : "resources"}`;
  if (servers > 0) subject += ` on ${servers} ${servers === 1 ? "server" : "servers"}`;
  return `${subject}${resources === 1 ? " was" : " were"} not scanned, so Coolify cannot tell.`;
}

/** listing(): the resources in scope, the ones the table shows on all its pages, and the filter options. */
export function fleetListing(entries: readonly FleetEntry[], state: FleetState, data: ScanData) {
  const serverOptions = new Map<string, string>();
  const projectOptions = new Map<string, string>();
  for (const e of entries) {
    if (e.server !== null && !serverOptions.has(e.server.uuid)) serverOptions.set(e.server.uuid, e.server.name);
    if (e.place.projectUuid !== null && !projectOptions.has(e.place.projectUuid)) projectOptions.set(e.place.projectUuid, str(e.place.projectName));
  }
  const sorted = (m: Map<string, string>) => Object.fromEntries([...m].sort((a, b) => natcase(a[1], b[1])));
  const servers = state.servers.filter((s) => serverOptions.has(s));
  const projects = state.projects.filter((p) => projectOptions.has(p));
  const inScope = entries.filter((e) => (servers.length === 0 || (e.server !== null && servers.includes(e.server.uuid))) && (projects.length === 0 || (e.place.projectUuid !== null && projects.includes(e.place.projectUuid))));
  const filtered = inScope.filter((e) => (state.statuses.length === 0 ? state.showNotChecked || e.security.status !== "not_checked" : state.statuses.includes(e.security.status)));
  const searching = phpTrim(state.search) !== "";
  let capped = false;
  let rows: FleetEntry[];
  if (searching) {
    const result = searchTeam(
      filtered.filter((e) => e.scanned),
      state.search,
      data,
    );
    capped = result.capped;
    rows = result.matches as FleetEntry[];
  } else rows = byStatus(filtered);
  return { inScope, notScanned: inScope.filter((e) => e.security.status === "not_checked"), rows, searching, capped, servers, projects, serverOptions: sorted(serverOptions), projectOptions: sorted(projectOptions) };
}

const checkedAtOf = (e: TeamEntry): Date | null => e.security.checkedAt ?? e.scans.reduce<Date | null>((m, s) => (s.scannedAt !== null && (m === null || s.scannedAt.getTime() > m.getTime()) ? s.scannedAt : m), null);

const BADGE_TYPES: Record<string, string> = { update_now: "error", update_available: "warning", no_fix: "neutral", check_needed: "neutral" };
const RESOURCE_TYPES: Record<string, string> = { application: "application", service: "service" };

/** str(class_basename($resource))->snake(): "application", "service", "standalone_postgresql", … */
function typeOf(resource: ScanResource): string {
  if (resource.kind !== "database") return RESOURCE_TYPES[resource.kind]!;
  return resource.morphClass
    .replace(/^.*\\/, "")
    .replace(/(?<!^)([A-Z])/g, "_$1")
    .toLowerCase();
}

/** render(): what fleet-vulnerabilities.blade.php shows. */
export function renderFleet(entries: readonly FleetEntry[], state: FleetState, data: ScanData, serversNotScanning: number) {
  const l = fleetListing(entries, state, data);
  const counts: Record<string, number> = {};
  for (const e of l.inScope) counts[e.security.status] = (counts[e.security.status] ?? 0) + 1;
  const statusOptions = Object.fromEntries(STATUS_ORDER.map((s) => [s, `${statusLabel(s)} (${(counts[s] ?? 0).toLocaleString("en-US")})`]));
  const notScannedServers = new Set(l.notScanned.map((e) => e.server?.id).filter((id) => id !== undefined)).size;
  const perPage = Math.max(1, Math.min(100, state.perPage));
  const lastPage = Math.max(1, Math.ceil(l.rows.length / perPage));
  const page = Math.max(1, Math.min(state.page, lastPage));
  const slice = l.rows.slice((page - 1) * perPage, page * perPage);
  return {
    state: { search: state.search, statuses: state.statuses, servers: l.servers, projects: l.projects, showNotChecked: state.showNotChecked },
    items: {
      items: slice.map((e) => {
        const checkedAt = checkedAtOf(e);
        const act = l.searching ? null : action(e.security, data.now);
        return {
          key: e.key,
          name: str(e.resource.name),
          kind: e.resource.kind,
          type: typeOf(e.resource),
          link: e.link,
          project: e.place.projectName,
          environment: e.place.environmentName,
          server: e.server?.name ?? null,
          status: e.security.status,
          statusLabel: statusLabel(e.security.status),
          badgeType: BADGE_TYPES[e.security.status] ?? null,
          imagesLine: l.searching ? null : imagesLine(e.security, e.images),
          action: act,
          match: l.searching ? (e.match ?? null) : null,
          checkedAt: checkedAt === null ? null : { iso: iso8601(checkedAt), ago: diffForHumans(checkedAt, data.now), title: dayDateTime(checkedAt) },
        };
      }),
      total: l.rows.length,
      perPage,
      currentPage: page,
      lastPage,
      firstItem: slice.length === 0 ? null : (page - 1) * perPage + 1,
      lastItem: slice.length === 0 ? null : (page - 1) * perPage + slice.length,
    },
    shownCount: l.rows.length,
    searching: l.searching,
    notScannedLine: l.notScanned.length === 0 ? null : notScannedSentence(l.notScanned.length, notScannedServers),
    notCheckedToggle: l.notScanned.length === 0 || state.statuses.length > 0 || l.searching ? null : state.showNotChecked ? "Hide them" : "Show them",
    hidesNotChecked: state.statuses.length === 0 && !state.showNotChecked && l.notScanned.length > 0,
    searchCapped: l.searching && l.capped,
    maxDecodedScans: MAX_DECODED_SCANS,
    serversNotScanning,
    serverOptions: l.serverOptions,
    projectOptions: l.projectOptions,
    statusOptions,
    hasFilters: l.servers.length > 0 || l.projects.length > 0 || state.statuses.length > 0,
    hasResources: entries.length > 0,
    stateLabels: STATE_LABELS,
  };
}

/** FleetExport::entries() */
export function fleetExportEntries(rows: readonly FleetEntry[], searching: boolean, now: Date): FleetExportEntry[] {
  return rows.map((e) => {
    const checkedAt = checkedAtOf(e);
    const values: FleetExportEntry = {
      resource: str(e.resource.name),
      type: typeOf(e.resource),
      project: e.place.projectName,
      environment: e.place.environmentName,
      server: e.server?.name ?? null,
      status: statusLabel(e.security.status),
      checked_at: null,
      url: null,
    };
    if (searching && e.match) {
      const m = e.match;
      Object.assign(values, {
        match_id: m.id,
        severity: m.severity === "" ? "" : m.severity[0]!.toUpperCase() + m.severity.slice(1),
        package: m.package,
        version: m.version,
        state: (STATE_LABELS as Record<string, string>)[m.state] ?? m.state,
        fixed_in: m.fixedIn !== null && m.fixedIn !== "" ? m.fixedIn : null,
        other_matches: m.more,
      });
    } else {
      Object.assign(values, { action: action(e.security, now)?.text ?? null, images: imagesLine(e.security, e.images) });
    }
    // checked_at and url come last, as Coolify's `$values + [...]` puts them.
    delete (values as Partial<FleetExportEntry>).checked_at;
    delete (values as Partial<FleetExportEntry>).url;
    return { ...values, checked_at: checkedAt === null ? null : iso8601(checkedAt), url: e.link };
  });
}
