// Derived from coollabsio/coolify@91b7e3e:app/Livewire/ImageScan/Vulnerabilities.php,
// resources/views/livewire/image-scan/vulnerabilities.blade.php, resources/views/livewire/image-scan/partials/finding-row.blade.php
// and app/Models/ImageScanIgnore.php (validationRules) (Apache-2.0), modified.
//
// The Security page of a resource (spec 15.7), without the DOM (DP-114): the main card with the status, the sentence and
// the action that fixes the most, then the findings of the images the resource runs (spec 6.2) in the page's fix states,
// filters, views and pages, as Livewire's render() computes them, and the rules and messages of its actions. The page's
// state (fixState, severities, images, view, search, showIgnored, page, perPage) is the request's query, normalized as
// render() normalizes its public properties.
import type { Finding } from "./finding.js";
import { md5 } from "../helpers/docker.js";
import { isTransferredAway, SEVERITY_RANK, type IgnoreRow, type ImageScanRow, type ScanData, type ScanOwner, type ScanResource } from "./model.js";
import { dataGet, filled, isRecord, list, lower, phpTrim, spaceship, str, versionCompare } from "./php.js";
import { offState, policyFor } from "./policy.js";
import { advisoryUrl, current, currentFor, currentImageRef, exploitLikelihood, findings as findingsOf, isAdvisoryId, key, owners as ownersOf } from "./resource-scans.js";
import { exploitSignal, isCpeOnlyOsMatch, type RelevanceRules } from "./rules.js";
import { fixStates } from "./security-actions.js";
import { forResource, forScan, relevanceRulesFor, type ResourceSecurity } from "./security-status.js";
import { securityCard, type CardData, type CardViewer } from "./security-card.js";
import { diffForHumans, iso8601 } from "./php.js";

export const SEVERITIES = ["critical", "high", "medium", "low", "unknown"] as const;
const VIEWS = ["package", "cve"];
export const EXPIRES = ["30", "90", "never"] as const;
/** The fix states of the findings table. */
export const FIX_STATES: Record<string, string> = { fixed: "Fix available upstream", no_fix: "No fix yet" };

/** Every action of the page that would scan, pull, update or rebuild an image on a server answers this, after Coolify's checks. */
export const SSH_UNAVAILABLE = {
  scan: "Scanning the images needs the SSH executor, which is not available yet.",
  update: "Updating the image needs the SSH executor, which is not available yet.",
  rebuild: "Rebuilding the app needs the SSH executor, which is not available yet.",
} as const;

export const MESSAGES = {
  scanRunning: "A scan is already running.",
  transferred: "Another Coolify instance manages this server now.",
  scanOff: "Image scanning is off for this resource.",
  deployFirst: "Deploy the app first.",
  scanStarted: "Scan started",
  overrideRemoved: "The next deploy uses the image of the compose file.",
  notOffered: "This update is no longer offered. Reload the page.",
  noButton: "Coolify cannot run this update. Follow the steps on this page instead.",
  ownResources: "Coolify does not rebuild its own resources.",
  unknownCommit: "Coolify does not know which commit runs now. Redeploy the app first.",
  serverGone: "The server of the running deployment is no longer one of this app.",
  ignored: "Ignored",
  notInResults: "This is not in the scan results.",
  mustExpire: "Attackers are using or are likely to use this problem, so its ignore must expire. Choose 30 or 90 days.",
} as const;

/** The page's public properties, from the query. */
export interface PageState {
  fixState: string;
  severities: string[];
  images: string[];
  view: string;
  search: string;
  showIgnored: boolean;
  page: number;
  perPage: number;
}

/** The query as the page's properties (Livewire keeps only what its methods allow). */
export function pageState(q: URLSearchParams): PageState {
  const listOf = (name: string) => q.getAll(name).flatMap((v) => v.split(",")).filter((v) => v !== "");
  const int = (name: string, fallback: number) => {
    const n = Number.parseInt(q.get(name) ?? "", 10);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    fixState: q.get("fixState") ?? "fixed",
    severities: [...new Set(listOf("severities"))],
    images: [...new Set(q.getAll("images"))],
    view: q.get("view") ?? "package",
    search: q.get("search") ?? "",
    showIgnored: q.get("showIgnored") === "1" || q.get("showIgnored") === "true",
    page: int("page", 1),
    perPage: int("perPage", 10),
  };
}

interface Row {
  key: string;
  scan: string;
  finding: Finding;
  state: string;
  ignore: IgnoreRow | null;
  image: string;
  owner: string;
  base: string | null;
  neverAllowed: boolean;
  packageNeverAllowed: boolean;
}

/** A finding whose ignore must expire (spec 15.2): an exploit signal, and not a CPE-only OS match. */
export const hasExploitSignal = (f: Finding): boolean => exploitSignal(f) !== null && !isCpeOnlyOsMatch(f);

/** The current scans of a page and the relevance rules of its owners, loaded once per request. */
export interface PageContext {
  resource: ScanResource;
  data: ScanData;
  scans: ImageScanRow[];
  rulesFor: (owner: ScanOwner) => RelevanceRules;
}

export function pageContext(resource: ScanResource, data: ScanData): PageContext {
  const cache = new Map<string, RelevanceRules>();
  const rulesFor = (owner: ScanOwner): RelevanceRules => {
    let r = cache.get(key(owner));
    if (r === undefined) {
      r = relevanceRulesFor(owner, data);
      cache.set(key(owner), r);
    }
    return r;
  };
  return { resource, data, scans: current(resource, data), rulesFor };
}

/** The IDs of the findings that the current base image of a Dockerfile build has too, from the last base check. */
function baseIds(scan: ImageScanRow): Set<string> {
  const base = dataGet(scan.candidates, "base");
  if (!filled(scan.baseImageRef) || !isRecord(base) || (base.image ?? null) !== scan.baseImageRef) return new Set();
  return new Set(list(base.attributable_ids).filter((id): id is string => typeof id === "string" && id !== "").map(lower));
}

/** findingRows(): one row per finding of the current scans, with its fix state and the ignore that matches it. */
function findingRows(c: PageContext): Row[] {
  const rows: Row[] = [];
  for (const scan of c.scans) {
    const owner = c.data.owners.get(scan.id)!;
    const rules = c.rulesFor(owner);
    const classify = fixStates(scan, rules, c.data);
    const ids = baseIds(scan);
    findingsOf(scan).forEach((finding, index) => {
      const fromBase = ids.size > 0 && [finding.id, ...finding.aliases].some((id) => ids.has(lower(id)));
      rows.push({ key: `${scan.uuid}-${index}`, scan: scan.uuid, finding, state: classify(finding), ignore: rules.ignores.matches(finding), image: scan.imageRef, owner: owner.uuid, base: fromBase ? str(scan.baseImageRef) : null, neverAllowed: true, packageNeverAllowed: true });
    });
  }
  // The ignore modal offers "Never" only when no finding the ignore would match has an exploit signal.
  const signalIds = new Map<string, Set<string>>();
  const signalPackages = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!hasExploitSignal(row.finding)) continue;
    for (const id of [row.finding.id, ...row.finding.aliases]) (signalIds.get(row.owner) ?? signalIds.set(row.owner, new Set()).get(row.owner)!).add(lower(id));
    (signalPackages.get(row.owner) ?? signalPackages.set(row.owner, new Set()).get(row.owner)!).add(row.finding.package);
  }
  for (const row of rows) {
    row.neverAllowed = !(signalIds.get(row.owner)?.has(lower(row.finding.id)) ?? false);
    row.packageNeverAllowed = !(signalPackages.get(row.owner)?.has(row.finding.package) ?? false);
  }
  return rows;
}

const severityOf = (f: Finding): string => {
  const s = f.severity.toLowerCase();
  return (SEVERITIES as readonly string[]).includes(s) ? s : "unknown";
};

function filterRows(rows: readonly Row[], state: PageState): Row[] {
  const search = lower(phpTrim(state.search));
  const severities = state.severities.filter((s) => (SEVERITIES as readonly string[]).includes(s));
  return rows.filter((row) => {
    const f = row.finding;
    if (severities.length > 0 && !severities.includes(severityOf(f))) return false;
    if (state.images.length > 0 && !state.images.includes(row.image)) return false;
    if (search === "") return true;
    return lower([f.id, ...f.aliases, f.package, f.version].join(" ")).includes(search);
  });
}

function sortRows(rows: readonly Row[]): Row[] {
  const k = (r: Row) => [r.finding.kev, SEVERITY_RANK[severityOf(r.finding)], r.finding.risk ?? 0.0];
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => spaceship(k(b.r), k(a.r)) || a.i - b.i)
    .map(({ r }) => r);
}

/** shownRows(): the ignored ones, or the current fix state, with the filters, worst first. */
function shownRows(all: readonly Row[], state: PageState): Row[] {
  return sortRows(filterRows(all.filter((row) => (state.showIgnored ? row.ignore !== null : row.ignore === null && row.state === state.fixState)), state));
}

interface Group {
  key: string;
  package: string;
  version: string;
  type: string;
  image: string;
  owner: string;
  severity: string;
  kev: boolean;
  neverAllowed: boolean;
  fixed: string | null;
  count: number;
  rows: Row[];
}

/** strnatcmp() over two strings (numbers compared as numbers). */
const strnatcmp = (a: string, b: string): number => Math.sign(a.localeCompare(b, "en", { numeric: true, sensitivity: "variant" }));

/** packageGroups(): one row per package version of an image, worst first. */
function packageGroups(rows: readonly Row[]): Group[] {
  const groups = new Map<string, Group & { fixedAll: string[] }>();
  for (const row of rows) {
    const f = row.finding;
    const k = md5(`${row.owner}\0${row.image}\0${f.package}\0${f.version}`);
    let g = groups.get(k);
    if (g === undefined) {
      g = { key: k, package: f.package, version: f.version, type: f.type, image: row.image, owner: row.owner, severity: "unknown", kev: false, neverAllowed: row.packageNeverAllowed, fixed: null, count: 0, rows: [], fixedAll: [] };
      groups.set(k, g);
    }
    g.rows.push(row);
    g.kev = g.kev || f.kev;
    if (SEVERITY_RANK[severityOf(f)]! > SEVERITY_RANK[g.severity]!) g.severity = severityOf(f);
    if (f.fixedIn !== null && f.fixedIn !== "") g.fixedAll.push(f.fixedIn);
  }
  const out = [...groups.values()].map(({ fixedAll, ...g }) => {
    const fixed = [...new Set(fixedAll)].sort((a, b) => versionCompare(b, a) || strnatcmp(b, a));
    return { ...g, fixed: fixed[0] ?? null, count: g.rows.length };
  });
  return out
    .map((g, i) => ({ g, i }))
    .sort((a, b) => spaceship([b.g.kev, SEVERITY_RANK[b.g.severity], b.g.count, a.g.package], [a.g.kev, SEVERITY_RANK[a.g.severity], a.g.count, b.g.package]) || a.i - b.i)
    .map(({ g }) => g);
}

/** Carbon's toFormattedDateString(): "Jan 1, 2026". */
export function formattedDate(d: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** A finding row as finding-row.blade.php reads it. */
function rowView(row: Row) {
  const f = row.finding;
  return {
    key: row.key,
    id: f.id,
    url: advisoryUrl(f.id),
    package: f.package,
    version: f.version,
    fixedIn: filled(f.fixedIn) ? f.fixedIn : null,
    severity: lower(f.severity),
    kev: f.kev,
    summary: f.summary,
    likelihood: exploitLikelihood(f.epss),
    aliases: f.aliases.filter((alias) => alias !== f.id && isAdvisoryId(alias)).map((alias) => ({ id: alias, url: advisoryUrl(alias) })),
    ignore: row.ignore === null ? null : { reason: row.ignore.reason, until: row.ignore.expiresAt === null ? null : formattedDate(row.ignore.expiresAt) },
    image: row.image,
    owner: row.owner,
    base: row.base,
    neverAllowed: row.neverAllowed,
  };
}

/** paginate(): the page clamped to the last one, perPage to 1–100. */
function paginate<T>(items: readonly T[], state: PageState) {
  const perPage = Math.max(1, Math.min(100, state.perPage));
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const page = Math.max(1, Math.min(state.page, lastPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  return { items: slice, total: items.length, perPage, currentPage: page, lastPage, firstItem: slice.length === 0 ? null : (page - 1) * perPage + 1, lastItem: slice.length === 0 ? null : (page - 1) * perPage + slice.length };
}

/** Carbon's toDayDateTimeString(): "Thu, Jan 1, 2026 12:00 AM". */
export function dayDateTime(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const h = d.getUTCHours();
  return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export interface PageViewer extends CardViewer {
  /** route('server.security.vulnerabilities', …) when the user may update the server. */
  serverUrl: (serverUuid: string) => string;
}

/** render(): what vulnerabilities.blade.php shows. */
export function renderVulnerabilities(c: PageContext, state: PageState, viewer: PageViewer) {
  const { resource, data } = c;
  const server = policyFor(resource, data).scanServer;
  const off = offState(resource, server);
  const base = {
    offState: off,
    serverName: str(server?.name ?? "this server"),
    serverUrl: server !== null && viewer.canUpdateServer ? viewer.serverUrl(server.uuid) : null,
    canUpdate: viewer.canUpdate,
    isApplication: resource.kind === "application",
  };
  if (off !== null) return { ...base, state: null };

  const fixState = state.fixState in FIX_STATES ? state.fixState : "fixed";
  const view = VIEWS.includes(state.view) ? state.view : "package";
  const st: PageState = { ...state, fixState, view };
  const scans = c.scans;
  const all = findingRows(c);
  const active = all.filter((r) => r.ignore === null);
  const ignoredCount = all.length - active.length;
  const stateCounts: Record<string, number> = { fixed: 0, no_fix: 0 };
  for (const row of filterRows(active, st)) stateCounts[row.state] = (stateCounts[row.state] ?? 0) + 1;
  const listRows = shownRows(all, st);
  const grouped = !st.showIgnored && view === "package";
  const items = grouped ? paginate(packageGroups(listRows), st) : paginate(listRows, st);

  const imageStatuses = new Map<string, ResourceSecurity>(scans.map((s) => [s.uuid, forScan(s, data, c.rulesFor(data.owners.get(s.id)!))]));
  const sec = scans.length === 0 ? null : forResource(resource, data, scans, imageStatuses);
  const latest = scans.reduce<Date | null>((m, s) => (s.scannedAt !== null && (m === null || s.scannedAt.getTime() > m.getTime()) ? s.scannedAt : m), null);
  const checkedAt = sec?.checkedAt ?? latest;
  const imageOptions = [...new Set(scans.map((s) => s.imageRef))];
  const card: CardData | null = sec === null ? null : securityCard(resource, sec, data, scans, viewer, imageStatuses, c.rulesFor);

  return {
    ...base,
    state: { fixState, severities: st.severities, images: st.images, view, search: st.search, showIgnored: st.showIgnored },
    hasScans: scans.length > 0,
    progress: null,
    checkpoints: [],
    // ScanImage::lastErrorCacheKey(): Freeploy runs no scan, so no last error is cached.
    errorMessages: [] as Array<{ message: string; detail: string | null }>,
    card,
    checkedAt: checkedAt === null ? null : { iso: iso8601(checkedAt), ago: diffForHumans(checkedAt, data.now), title: dayDateTime(checkedAt) },
    truncated: scans.some((s) => {
      const t = dataGet(s.summary, "truncated", false);
      return t === true || t === 1 || t === "1";
    }),
    findingCount: active.length,
    stateCounts,
    fixStates: FIX_STATES,
    ignoredCount,
    shownCount: listRows.length,
    items: {
      ...items,
      items: grouped
        ? (items.items as Group[]).map((g) => ({ key: g.key, package: g.package, version: g.version, type: g.type, image: g.image, owner: g.owner, severity: g.severity, kev: g.kev, neverAllowed: g.neverAllowed, fixed: g.fixed, count: g.count, rows: g.rows.map(rowView) }))
        : (items.items as Row[]).map(rowView),
    },
    grouped,
    groupedFindingCount: grouped ? listRows.length : null,
    imageOptions: imageOptions.length > 1 ? imageOptions : [],
    showsImage: imageOptions.length > 1,
    isService: resource.kind === "service",
    canIgnoreForTeam: viewer.canUpdate,
    hasFilters: st.severities.length > 0 || st.images.length > 0 || phpTrim(st.search) !== "",
    severityOptions: SEVERITIES,
  };
}

/** The rows of copyList()/downloadList(): the shown findings on all pages; null when the page shows its off state (404). */
export function exportRows(c: PageContext, state: PageState): { rows: Row[]; multipleImages: boolean } | null {
  if (offState(c.resource, policyFor(c.resource, c.data).scanServer) !== null) return null;
  const fixState = state.fixState in FIX_STATES ? state.fixState : "fixed";
  return { rows: shownRows(findingRows(c), { ...state, fixState }), multipleImages: new Set(c.scans.map((s) => s.imageRef)).size > 1 };
}

/** trans_choice('{1} 1 finding|[2,*] :count findings', n) */
export const findingsCount = (n: number): string => (n === 1 ? "1 finding" : `${n.toLocaleString("en-US")} findings`);

// ── actions ─────────────────────────────────────────────────────────────────

/** A Livewire refusal: its toast, or (status 4xx) an abort or a ValidationException. */
export class PageRefusal extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fields: Record<string, string[]> | null = null,
  ) {
    super(message);
  }
}

/** applicationImageRefs(): the image the app runs, else the images of its current scans. */
export function applicationImageRefs(application: Extract<ScanResource, { kind: "application" }>, data: ScanData): string[] {
  const ref = currentImageRef(application, data);
  if (ref !== null) return [ref];
  return [...new Set(currentFor(application, data).map((s) => s.imageRef).filter((r) => r !== ""))];
}

/** scanNow()'s checks; null when a scan would start (which needs the SSH executor), else the error toast. */
export function scanNowRefusal(resource: ScanResource, data: ScanData): string | null {
  // progress(): Freeploy runs no scan, so none is in progress.
  const policy = policyFor(resource, data);
  if (policy.scanServer !== null && isTransferredAway(policy.scanServer)) return MESSAGES.transferred;
  if (!policy.scanEnabled) return MESSAGES.scanOff;
  if (resource.kind === "application" && applicationImageRefs(resource, data).length === 0) return MESSAGES.deployFirst;
  return null;
}

/** updateRefusal() */
export function updateRefusal(a: { button: boolean } | null | undefined): string | null {
  if (a === null || a === undefined) return MESSAGES.notOffered;
  if (!a.button) return MESSAGES.noButton;
  return null;
}

/** The scans of the owner whose findings an ignore of $target would match (ownerFindings()). */
export function ownerFindings(c: PageContext, owner: ScanOwner, kind: string, target: string): Finding[] {
  const t = kind === "package" ? target : lower(target);
  const out: Finding[] = [];
  for (const scan of c.scans) {
    if (key(c.data.owners.get(scan.id)!) !== key(owner)) continue;
    for (const f of findingsOf(scan)) {
      const matches = kind === "package" ? f.package === t : [f.id, ...f.aliases].map(lower).includes(t);
      if (matches) out.push(f);
    }
  }
  return out;
}

const IGNORE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Validator::make($data, ImageScanIgnore::validationRules() + kind, scope, expires): Laravel's messages, in rule order. */
export function validateIgnore(input: { kind: string; scope: string; expires: string; vulnerability_id: string | null; package: string | null; reason: string }): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  const add = (field: string, message: string) => (errors[field] ??= []).push(message);
  const vid = input.vulnerability_id === "" ? null : input.vulnerability_id;
  const pkg = input.package === "" ? null : input.package;
  if (vid !== null && !IGNORE_ID.test(vid)) add("vulnerability_id", "The vulnerability id field format is invalid.");
  if (vid === null && pkg === null) add("vulnerability_id", "The vulnerability id field is required when package is not present.");
  if (pkg !== null && [...pkg].length > 214) add("package", "The package field must not be greater than 214 characters.");
  if (pkg === null && vid === null) add("package", "The package field is required when vulnerability id is not present.");
  if (input.reason === "") add("reason", "The reason field is required.");
  else if ([...input.reason].length > 500) add("reason", "The reason field must not be greater than 500 characters.");
  if (input.kind === "") add("kind", "The kind field is required.");
  else if (!["vulnerability", "package"].includes(input.kind)) add("kind", "The selected kind is invalid.");
  if (input.scope === "") add("scope", "The scope field is required.");
  else if (!["resource", "team"].includes(input.scope)) add("scope", "The selected scope is invalid.");
  if (input.expires === "") add("expires", "The expires field is required.");
  else if (!(EXPIRES as readonly string[]).includes(input.expires)) add("expires", "The selected expires is invalid.");
  return errors;
}

/** The owner of a service page's finding by its uuid, else the resource itself. */
export function ownerOf(resource: ScanResource, ownerUuid: string | null): ScanOwner | null {
  if (resource.kind !== "service") return resource;
  return ownerUuid === null ? null : (ownersOf(resource).find((o) => o.uuid === ownerUuid) ?? null);
}

/** now()->addDays($n) as the column stores it. */
export function addDays(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}
