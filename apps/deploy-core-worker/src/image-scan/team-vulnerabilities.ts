// Derived from coollabsio/coolify@91b7e3e:app/Services/ImageScan/TeamVulnerabilities.php and
// app/Services/ImageScan/VulnerabilityMarkers.php (Apache-2.0), modified.
//
// The resources of the org and their stored security status, for the team's Vulnerabilities page, the dashboard callout
// and GET /api/v1/vulnerabilities. Lists read only stored statuses; only the search decodes findings. Every resource of
// the org is listed: Freeploy has no member grants that hide projects (Coolify's resource models hide them for members
// whose access is limited to some projects).
import type { Finding } from "./finding.js";
import { keyOf, SEVERITY_RANK, type ImageScanRow, type ScanData, type ScanOwner, type ScanResource, type ScanServer } from "./model.js";
import { dataGet, int, iso8601, lower, mbSubstr, spaceship, str } from "./php.js";
import { countMediumForMany, isScanOn, mainServerOf } from "./policy.js";
import { currentForMany, findings, isScanTarget, ownersOfMany } from "./resource-scans.js";
import { IgnoreMatcher, RelevanceRules } from "./rules.js";
import { fixStates } from "./security-actions.js";
import { badge, checkReason as sentenceCheckReason, headline, noFixAction } from "./security-sentences.js";
import { primaryOf, storedMany, type ResourceSecurity } from "./security-status.js";

/** The sort order of the team page. */
export const STATUS_ORDER = ["update_now", "update_available", "no_fix", "check_needed", "ok", "not_checked"] as const;
export const STATE_LABELS = { fixed: "Fix available upstream", no_fix: "No fix yet", ignored: "Ignored" } as const;
const STATE_RANK: Record<string, number> = { fixed: 0, no_fix: 1, ignored: 2 };
export const MAX_DECODED_SCANS = 200;
/** The Action column of a resource that has a problem with no fix yet. */
export const NO_FIX_ACTION = "No fix released yet. Coolify checks daily.";

export interface TeamEntry {
  key: string;
  resource: ScanResource;
  server: ScanServer | null;
  scanned: boolean;
  scans: ImageScanRow[];
  security: ResourceSecurity;
  images: { update: number; total: number };
}

/** TeamVulnerabilities::load(): every resource with its stored status and its images counted. */
export function loadTeamVulnerabilities(resources: readonly ScanResource[], data: ScanData): TeamEntry[] {
  const owners = ownersOfMany(resources.filter((r) => isScanOn(r)));
  const scans = currentForMany([...owners.values()].flat(), data);
  const statuses = storedMany(resources, data, scans);
  return resources.map((resource) => {
    const key = keyOf(resource);
    const resourceOwners = owners.get(key) ?? [];
    const resourceScans = resourceOwners.flatMap((owner) => scans.get(keyOf(owner)) ?? []);
    return {
      key,
      resource,
      server: mainServerOf(resource),
      scanned: resourceScans.length > 0,
      scans: resourceScans,
      security: statuses[key]!,
      images: imageCounts(resource, resourceOwners, scans, statuses[key]!),
    };
  });
}

/** The images the status counts, and how many need an update (stored status update_now or update_available). */
function imageCounts(resource: ScanResource, owners: readonly ScanOwner[], scans: Map<string, ImageScanRow[]>, security: ResourceSecurity): { update: number; total: number } {
  let update = 0;
  let total = 0;
  for (const owner of owners) {
    if (resource.kind === "service" && !isScanTarget(owner)) continue;
    const ownerScans = scans.get(keyOf(owner)) ?? [];
    total += Math.max(1, ownerScans.length);
    update += ownerScans.filter((s) => ["update_now", "update_available"].includes(str(dataGet(s.summary, "security.status")))).length;
  }
  return { update, total: Math.max(total, int(security.checkContext.total ?? 0)) };
}

/** "2 of 3 images" under the status of a resource with several images that needs an update. */
export function imagesLine(s: ResourceSecurity, images: { update: number; total: number }): string | null {
  if (!(s.status === "update_now" || s.status === "update_available") || images.total < 2 || images.update < 1) return null;
  return `${images.update} of ${images.total} images`;
}

/** The status text of the team page. */
export function statusLabel(status: ResourceSecurity["status"]): string {
  if (status === "ok") return "No action needed";
  if (status === "not_checked") return "Not checked";
  return str(badge(status));
}

/** The Action column; null for ok. */
export function action(s: ResourceSecurity, now: Date): { text: string; link: boolean; muted: boolean } | null {
  switch (s.status) {
    case "no_fix":
      return { text: noFixAction(s) ?? NO_FIX_ACTION, link: false, muted: true };
    case "update_now":
    case "update_available": {
      const sentence = primaryOf(s)?.sentence ?? "";
      return sentence.trim() !== "" ? { text: sentence, link: true, muted: false } : null;
    }
    case "check_needed":
      return { text: `Check again: ${checkReasonOf(s, now)}.`, link: true, muted: true };
    case "not_checked":
      return { text: headline(s, now), link: false, muted: true };
    default:
      return null;
  }
}

function checkReasonOf(s: ResourceSecurity, now: Date): string {
  const context: Record<string, unknown> = { ...s.checkContext };
  if ((context.time ?? null) === null && s.checkedAt !== null) context.time = iso8601(s.checkedAt);
  return s.checkReason === null ? "the last check is incomplete" : sentenceCheckReason(s.checkReason, context, now);
}

export function severityOf(finding: Finding): string {
  const severity = lower(finding.severity);
  return severity in SEVERITY_RANK ? severity : "unknown";
}

/** The search term: lower case, at most 100 characters, without quotes and backslashes. */
export const searchTerm = (term: string): string => mbSubstr(lower(str(term).replace(/["\\]/g, "").replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "")), 0, 100);

const matches = (finding: Finding, term: string): boolean => [finding.id, ...finding.aliases, finding.package].some((v) => lower(v).includes(term));

export interface SearchMatch {
  id: string;
  package: string;
  version: string;
  fixedIn: string | null;
  severity: string;
  state: string;
  more: number;
}

/**
 * The resources of the entries that have a finding with this ID, alias or package, with the state of the most actionable
 * match. `scans` must be loaded with their findings; at most `maxScans` matching scans are read (`capped`).
 */
export function searchTeam(entries: readonly TeamEntry[], rawTerm: string, data: ScanData, maxScans = MAX_DECODED_SCANS): { matches: Array<TeamEntry & { match: SearchMatch }>; capped: boolean } {
  const term = searchTerm(rawTerm);
  const scanIds = entries.flatMap((e) => e.scans.map((s) => s.id));
  if (term === "" || scanIds.length === 0) return { matches: [], capped: false };
  // The database narrows the scans first (LIKE over the findings' jsonb text, "/" matching any run); here a superset by the
  // findings' JSON text, the newest first — every finding is matched again below, so only the cap can differ.
  let candidates = entries
    .flatMap((e) => e.scans)
    .filter((s) => JSON.stringify(s.findings ?? null).toLowerCase().includes(term))
    .sort((a, b) => b.id - a.id);
  let capped = false;
  if (candidates.length > maxScans) {
    capped = true;
    candidates = candidates.slice(0, maxScans);
  }
  const loaded = new Set(candidates.map((s) => s.id));
  const countMedium = countMediumForMany(
    entries.map((e) => e.resource),
    data,
  );
  const out: Array<TeamEntry & { match: SearchMatch }> = [];
  for (const entry of entries) {
    const found: Array<Omit<SearchMatch, "more">> = [];
    for (const scan of entry.scans) {
      if (!loaded.has(scan.id)) continue;
      const owner = data.owners.get(scan.id) ?? null;
      const ignores = IgnoreMatcher.fromIgnores(
        data.ignores.filter((i) => (i.expiresAt === null || i.expiresAt.getTime() > data.now.getTime()) && (i.resourceType === null || (owner !== null && i.resourceType === owner.morphClass && i.resourceId === owner.id))),
        data.now,
      );
      const rules = new RelevanceRules(ignores, countMedium[entry.key] ?? false);
      const classify = fixStates(scan, rules, data);
      for (const finding of findings(scan)) {
        if (!matches(finding, term)) continue;
        found.push({ id: finding.id, package: finding.package, version: finding.version, fixedIn: finding.fixedIn, severity: severityOf(finding), state: rules.ignores.matches(finding) !== null ? "ignored" : classify(finding) });
      }
    }
    if (found.length === 0) continue;
    found.sort((a, b) => spaceship([STATE_RANK[a.state], SEVERITY_RANK[b.severity], a.id], [STATE_RANK[b.state], SEVERITY_RANK[a.severity], b.id]));
    out.push({ ...entry, match: { ...found[0]!, more: found.length - 1 } });
  }
  out.sort(
    (a, b) =>
      STATE_RANK[a.match.state]! - STATE_RANK[b.match.state]! ||
      SEVERITY_RANK[b.match.severity]! - SEVERITY_RANK[a.match.severity]! ||
      str(a.resource.name).localeCompare(str(b.resource.name), "en", { numeric: true, sensitivity: "base" }),
  );
  return { matches: out, capped };
}

// ── VulnerabilityMarkers ────────────────────────────────────────────────────

const MARKER_TEXTS: Record<string, string> = { update_now: "Update now", no_fix: "No fix yet" };

/** The marker of one status: "Update now" for update_now, "No fix yet" for no_fix, none otherwise. */
export function marker(s: ResourceSecurity): { status: string; text: string; label: string; tooltip: string | null } | null {
  const text = MARKER_TEXTS[s.status];
  if (text === undefined) return null;
  const sentence = s.status === "update_now" ? (primaryOf(s)?.sentence ?? null) : null;
  const tooltip = sentence !== null && sentence.trim() !== "" ? sentence : null;
  return { status: s.status, text, label: `Security: ${lower(text)}${tooltip === null ? "" : `. ${tooltip}`}`, tooltip };
}
