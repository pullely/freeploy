// Derived from coollabsio/coolify@91b7e3e:app/Livewire/ImageScan/{Vulnerabilities,Packages,FleetVulnerabilities}.php,
// resources/views/livewire/image-scan/{vulnerabilities,packages,fleet-vulnerabilities}.blade.php,
// resources/views/livewire/image-scan/partials/{ignore-modal,security-image,scan-ignores}.blade.php and
// resources/views/components/image-scan/{export-menu,severity-badge,image-select}.blade.php (Apache-2.0), modified.
//
// The decisions of DP-114's Security pages, without the DOM: the page state each Livewire property keeps and the query
// that carries it to the API, the state changes of the page's methods (setFixState, toggleSeverity, selectImage,
// showImageFindings, …), the ignore modal's options, the export menu's copy, and the small text helpers of the views.

/** Vulnerabilities' public properties. */
export interface FindingsState {
  fixState: string;
  severities: string[];
  images: string[];
  view: string;
  search: string;
  showIgnored: boolean;
  page: number;
  perPage: number;
}

/** Packages' public properties. */
export interface PackagesState {
  search: string;
  types: string[];
  images: string[];
  page: number;
  perPage: number;
}

/** FleetVulnerabilities' public properties. */
export interface FleetState {
  search: string;
  statuses: string[];
  servers: string[];
  projects: string[];
  showNotChecked: boolean;
  page: number;
  perPage: number;
}

export const INITIAL_FINDINGS: FindingsState = { fixState: "fixed", severities: [], images: [], view: "package", search: "", showIgnored: false, page: 1, perPage: 10 };
export const INITIAL_PACKAGES: PackagesState = { search: "", types: [], images: [], page: 1, perPage: 10 };
export const INITIAL_FLEET: FleetState = { search: "", statuses: [], servers: [], projects: [], showNotChecked: false, page: 1, perPage: 25 };

export const SEVERITY_OPTIONS = ["critical", "high", "medium", "low", "unknown"] as const;
export const STATUS_ORDER = ["update_now", "update_available", "no_fix", "check_needed", "ok", "not_checked"] as const;

/** The API query of a resource's page: its findings' and its packages' state. */
export function resourceQuery(f: FindingsState, p: PackagesState): string {
  const q = new URLSearchParams();
  if (f.fixState !== "fixed") q.set("fixState", f.fixState);
  if (f.severities.length) q.set("severities", f.severities.join(","));
  for (const image of f.images) q.append("images", image);
  if (f.view !== "package") q.set("view", f.view);
  if (f.search !== "") q.set("search", f.search);
  if (f.showIgnored) q.set("showIgnored", "1");
  if (f.page !== 1) q.set("page", String(f.page));
  if (f.perPage !== 10) q.set("perPage", String(f.perPage));
  if (p.search !== "") q.set("packagesSearch", p.search);
  for (const t of p.types) q.append("packagesTypes", t);
  for (const image of p.images) q.append("packagesImages", image);
  if (p.page !== 1) q.set("packagesPage", String(p.page));
  if (p.perPage !== 10) q.set("packagesPerPage", String(p.perPage));
  const s = q.toString();
  return s === "" ? "" : `?${s}`;
}

/** The API query of the team page (and the URL's: #[Url] keeps search, statuses and showNotChecked in the address). */
export function fleetQuery(s: FleetState): string {
  const q = new URLSearchParams();
  if (s.search !== "") q.set("search", s.search);
  if (s.statuses.length) q.set("statuses", s.statuses.join(","));
  if (s.servers.length) q.set("servers", s.servers.join(","));
  if (s.projects.length) q.set("projects", s.projects.join(","));
  if (s.showNotChecked) q.set("showNotChecked", "1");
  if (s.page !== 1) q.set("page", String(s.page));
  if (s.perPage !== 25) q.set("perPage", String(s.perPage));
  const t = q.toString();
  return t === "" ? "" : `?${t}`;
}

/** #[Url(except: …)]: the team page's state from the address (search, statuses, showNotChecked). */
export function fleetStateFromUrl(search: string): FleetState {
  const q = new URLSearchParams(search);
  const statuses = (q.get("statuses") ?? "").split(",").filter((s) => (STATUS_ORDER as readonly string[]).includes(s));
  return { ...INITIAL_FLEET, search: q.get("search") ?? "", statuses, showNotChecked: q.get("showNotChecked") === "1" };
}

/** The address of the team page for its #[Url] properties. */
export function fleetUrl(s: FleetState): string {
  const q = new URLSearchParams();
  if (s.search !== "") q.set("search", s.search);
  if (s.statuses.length) q.set("statuses", s.statuses.join(","));
  if (s.showNotChecked) q.set("showNotChecked", "1");
  const t = q.toString();
  return `/vulnerabilities${t === "" ? "" : `?${t}`}`;
}

const toggle = (values: readonly string[], value: string): string[] => (values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);

/** updated('fixState' | 'search' | 'view' | 'perPage' | 'showIgnored'): the list goes back to its first page. */
export const setFindings = (s: FindingsState, change: Partial<FindingsState>): FindingsState => ({ ...s, ...change, page: change.page ?? 1 });

/** setFixState(): a known state, else "fixed"; the ignored list closes. */
export const setFixState = (s: FindingsState, state: string): FindingsState => ({ ...s, fixState: state === "fixed" || state === "no_fix" ? state : "fixed", showIgnored: false, page: 1 });

/** toggleSeverity(): a known severity only. */
export const toggleSeverity = (s: FindingsState, severity: string): FindingsState => ((SEVERITY_OPTIONS as readonly string[]).includes(severity) ? { ...s, severities: toggle(s.severities, severity), page: 1 } : s);

/** resetFilters(): the severities only (the image and the search stay). */
export const resetFindingFilters = (s: FindingsState): FindingsState => ({ ...s, severities: [], page: 1 });

/** selectImage(): one image, or every image for ''. */
export const selectImage = (s: FindingsState, image: string, refs: readonly string[]): FindingsState => (image === "" ? { ...s, images: [], page: 1 } : showImageFindings(s, image, refs));

/** showImageFindings(): the findings of that image only, when it is one of the current scans'. */
export const showImageFindings = (s: FindingsState, image: string, refs: readonly string[]): FindingsState => (refs.includes(image) ? { ...s, images: [image], showIgnored: false, page: 1 } : s);

/** Packages::toggleType(), showImage(), resetFilters(). */
export const togglePackageType = (s: PackagesState, type: string): PackagesState => ({ ...s, types: toggle(s.types, type), page: 1 });
export const showPackageImage = (s: PackagesState, image: string): PackagesState => ({ ...s, images: image === "" ? [] : [image], page: 1 });
export const resetPackageFilters = (s: PackagesState): PackagesState => ({ ...s, types: [], page: 1 });

/** FleetVulnerabilities' toggles and resetFilters(); each goes back to the first page. */
export function toggleFleet(s: FleetState, field: "statuses" | "servers" | "projects", value: string): FleetState {
  if (field === "statuses" && !(STATUS_ORDER as readonly string[]).includes(value)) return s;
  return { ...s, [field]: toggle(s[field], value), page: 1 };
}
export const resetFleetFilters = (s: FleetState): FleetState => ({ ...s, servers: [], projects: [], statuses: [], page: 1 });

/** number_format($n) */
export const numberFormat = (n: number): string => n.toLocaleString("en-US");

/** str($noun)->plural($count) */
export const plural = (noun: string, count: number): string => (count === 1 ? noun : `${noun}s`);

/** trans_choice('{1} 1 finding|[2,*] :count findings', …) */
export const countOf = (n: number, noun: string): string => (n === 1 ? `1 ${noun}` : `${numberFormat(n)} ${noun}s`);

/** The export menu's copy (export-menu.blade.php). */
export function exportMenu(count: number, noun: "finding" | "resource") {
  const countText = `${numberFormat(count)} ${plural(noun, count)}`;
  return {
    intro: `The ${countText} in this list, from all pages.`,
    markdownDone: `Copied ${countText} as Markdown.`,
    idsDone: `Copied the IDs of ${countText}.`,
    noClipboard: "The clipboard needs HTTPS or localhost.",
    copyFailed: "Could not copy the list.",
  };
}

/** <x-image-scan.severity-badge>: the badge's type and label. */
export function severityBadge(severity: string, count: number | null = null): { type: string; label: string } {
  const s = ["critical", "high", "medium", "low"].includes(severity) ? severity : "unknown";
  return { type: s === "unknown" ? "neutral" : `severity-${s}`, label: count === null ? s[0]!.toUpperCase() + s.slice(1) : `${count} ${s}` };
}

/** The ignore modal's options: the team scope for who may ignore for the team; "Never" unless an exploit signal forbids it. */
export function ignoreModal(kind: "vulnerability" | "package", neverAllowed: boolean, canIgnoreForTeam: boolean) {
  return {
    title: kind === "package" ? "Ignore package" : "Ignore finding",
    scopeOptions: [{ value: "resource", label: "This resource" }, ...(canIgnoreForTeam ? [{ value: "team", label: "All team resources" }] : [])],
    expiresOptions: [{ value: "30", label: "30 days" }, { value: "90", label: "90 days" }, ...(neverAllowed ? [{ value: "never", label: "Never" }] : [])],
    expiresHelper: neverAllowed ? undefined : "Attackers are using or are likely to use this problem, so its ignore expires.",
  };
}

/** The image sentence starts with the image ref: the view sets the ref in code (security-image.blade.php). */
export function splitSentence(sentence: string, ref: string): { ref: string | null; rest: string } {
  return ref.length > 0 && sentence.startsWith(ref) ? { ref, rest: sentence.slice(ref.length) } : { ref: null, rest: sentence };
}

/** "{n} more problem(s) this update fixes" */
export const whyMoreText = (n: number): string => `${numberFormat(n)} more ${n === 1 ? "problem" : "problems"} this update fixes`;

/** "{n} other fix(es)" */
export const otherFixesText = (n: number): string => `${numberFormat(n)} other ${n === 1 ? "fix" : "fixes"}`;

/** "1 server does not scan images." */
export const serversNotScanningTitle = (n: number): string => (n === 1 ? "1 server does not scan images." : `${n} servers do not scan images.`);

/** The SBOM download route of a scan (project.{type}.vulnerabilities.sbom). */
export const sbomPath = (resourcePath: string, scanUuid: string, format: "cyclonedx" | "spdx"): string => `${resourcePath}/vulnerabilities/sbom/${encodeURIComponent(scanUuid)}/${format}`;

/** The scan uuid and format of an SBOM download route, from its path. */
export function sbomFromPath(pathname: string): { resourcePath: string; scanUuid: string; format: string } | null {
  const m = /^(.*)\/vulnerabilities\/sbom\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  return m === null ? null : { resourcePath: m[1]!, scanUuid: decodeURIComponent(m[2]!), format: m[3]! };
}

/** The environment uuid of a resource path (/project/{p}/environment/{e}/…). */
export const environmentOfPath = (pathname: string): string | null => /^\/project\/[^/]+\/environment\/([^/]+)\//.exec(pathname)?.[1] ?? null;
