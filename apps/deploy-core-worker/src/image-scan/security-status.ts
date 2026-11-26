// Derived from coollabsio/coolify@91b7e3e:app/Services/ImageScan/SecurityStatus.php and
// app/Services/ImageScan/ResourceSecurity.php (Apache-2.0), modified.
//
// One security status per image and per resource (spec 15.6) from stored data only: the findings, the version and base
// checks, the scan times and the resource's configuration. Each completed scan that is not a preview stores its status in
// `summary.security` (store()); stored() combines the stored statuses of a resource's current scans without the findings,
// forResource() does the same with statuses computed now. See SecurityStatus.php for the rules; the port keeps its order.
import { storedTitle, type Finding } from "./finding.js";
import { ImageRef } from "./image-ref.js";
import { candidateStatus, keyOf, resourceOf, SECURITY_ACTION_TYPES, type ImageScanRow, type ScanData, type ScanOwner, type ScanResource, type SecurityStatusType } from "./model.js";
import { bool, blank, dataGet, filled, int, iso8601, isNumeric, isRecord, list, lower, parseTime, record, spaceship, str, subDays, unique, type Json } from "./php.js";
import { countMediumFor, offState } from "./policy.js";
import { advisoryUrl, composeDeploymentRows, currentFor, currentForMany, findings, isScanTarget, owners as ownersOf, ownersOfMany, runsOtherImage, uncheckedComposeImages } from "./resource-scans.js";
import { actionFromArray, actionToArray, COOLIFY_TEXT, forScan as actionsForScan, imageKind, type SecurityAction } from "./security-actions.js";
import { EXPLOITED, exploitSignal, IgnoreMatcher, isRelevant, LIKELY, RelevanceRules } from "./rules.js";

export const STALE_AFTER_DAYS = 2;
export const DATABASE_MAX_AGE_DAYS = 5;
export const WHY_LIMIT = 3;
export const REASON_IMAGES_UNCHECKED = "images_unchecked";
export const REASON_STALE = "stale";
export const REASON_DB_OUTDATED = "db_outdated";
export const REASON_IMAGE_CHANGED = "image_changed";
export const REASON_VERSIONS_UNCHECKED = "versions_unchecked";
export const REASON_TRUNCATED = "truncated";
export const NOT_SCANNED = "not_scanned";
/** The check_needed reasons in the order they are shown. */
export const REASON_ORDER = [REASON_IMAGES_UNCHECKED, REASON_TRUNCATED, REASON_STALE, REASON_DB_OUTDATED, REASON_IMAGE_CHANGED, REASON_VERSIONS_UNCHECKED];
const CHECKED_STATUSES = ["ok", "no_better", "cannot_compare"];
const COUNT_KEYS = ["signal_fixed", "signal_unfixed", "kev_fixed", "kev_unfixed", "critical_fixed", "high_fixed", "medium_fixed", "relevant_fixed", "builder_unfixed"] as const;
type Counts = Record<(typeof COUNT_KEYS)[number], number>;

export interface WhyEntry {
  title: string;
  display_id: string;
  link: string | null;
  score: number | null;
  severity: string;
  signal: string | null;
  package: string;
  version: string;
}

export interface Eol {
  name: string;
  version: string;
  fixed: boolean;
}

/** The security status of one image or one resource (ResourceSecurity). */
export interface ResourceSecurity {
  status: SecurityStatusType;
  checkReason: string | null;
  checkContext: Record<string, Json>;
  actions: SecurityAction[];
  why: WhyEntry[];
  moreFixed: number;
  exploitedWithoutFix: boolean;
  problemCount: number;
  exploitedCount: number;
  anyExploited: boolean;
  criticalCount: number;
  highCount: number;
  fixedByPrimary: number;
  primaryCritical: number;
  primaryHigh: number;
  eol: Eol | null;
  checkedAt: Date | null;
  facts: Record<string, Json>;
  builderImage: boolean;
  mediumCount: number;
  primaryMedium: number;
}

export function security(status: SecurityStatusType, values: Partial<ResourceSecurity> = {}): ResourceSecurity {
  return {
    status,
    checkReason: null,
    checkContext: {},
    actions: [],
    why: [],
    moreFixed: 0,
    exploitedWithoutFix: false,
    problemCount: 0,
    exploitedCount: 0,
    anyExploited: false,
    criticalCount: 0,
    highCount: 0,
    fixedByPrimary: 0,
    primaryCritical: 0,
    primaryHigh: 0,
    eol: null,
    checkedAt: null,
    facts: {},
    builderImage: false,
    mediumCount: 0,
    primaryMedium: 0,
    ...values,
  };
}

export const primaryOf = (s: ResourceSecurity): SecurityAction | null => s.actions[0] ?? null;

/** ResourceSecurity::toArray(): what summary.security stores. */
export function securityToArray(s: ResourceSecurity): Record<string, Json> {
  return {
    status: s.status,
    check_reason: s.checkReason,
    check_context: s.checkContext,
    actions: s.actions.map(actionToArray),
    why: s.why as unknown as Json,
    more_fixed: s.moreFixed,
    exploited_without_fix: s.exploitedWithoutFix,
    problem_count: s.problemCount,
    exploited_count: s.exploitedCount,
    any_exploited: s.anyExploited,
    critical_count: s.criticalCount,
    high_count: s.highCount,
    medium_count: s.mediumCount,
    fixed_by_primary: s.fixedByPrimary,
    primary_critical: s.primaryCritical,
    primary_high: s.primaryHigh,
    primary_medium: s.primaryMedium,
    eol: s.eol as unknown as Json,
    checked_at: s.checkedAt === null ? null : iso8601(s.checkedAt),
    facts: s.facts,
    builder_image: s.builderImage,
  };
}

const STATUSES: readonly string[] = ["not_checked", "check_needed", "update_now", "update_available", "no_fix", "ok"];

/** ResourceSecurity::fromArray(). */
export function securityFromArray(input: unknown): ResourceSecurity {
  const data = record(input);
  const eol = isRecord(data.eol) ? data.eol : null;
  const facts = record(data.facts ?? []) as Record<string, Json>;
  const stats = list(facts.action_stats ?? []);
  const actions: SecurityAction[] = [];
  const actionStats: Json[] = [];
  list(data.actions ?? []).forEach((actionData, index) => {
    const action = isRecord(actionData) ? actionFromArray(actionData) : null;
    if (action !== null) {
      actions.push(action);
      actionStats.push((stats[index] ?? []) as Json);
    }
  });
  const newFacts: Record<string, Json> = { ...facts };
  if ("action_stats" in facts) newFacts.action_stats = actionStats;
  const status = str(data.status ?? "");
  return security(STATUSES.includes(status) ? (status as SecurityStatusType) : "not_checked", {
    checkReason: data.check_reason === null || data.check_reason === undefined ? null : str(data.check_reason),
    checkContext: record(data.check_context ?? []) as Record<string, Json>,
    actions,
    why: list(data.why ?? []).map((e) => whyEntry(record(e))),
    moreFixed: int(data.more_fixed ?? 0),
    exploitedWithoutFix: bool(data.exploited_without_fix ?? false),
    problemCount: int(data.problem_count ?? 0),
    exploitedCount: int(data.exploited_count ?? 0),
    anyExploited: bool(data.any_exploited ?? false),
    criticalCount: int(data.critical_count ?? 0),
    highCount: int(data.high_count ?? 0),
    fixedByPrimary: int(data.fixed_by_primary ?? 0),
    primaryCritical: int(data.primary_critical ?? 0),
    primaryHigh: int(data.primary_high ?? 0),
    eol: eol === null ? null : { name: str(eol.name ?? ""), version: str(eol.version ?? ""), fixed: bool(eol.fixed ?? false) },
    checkedAt: typeof data.checked_at === "string" && data.checked_at !== "" ? parseTime(data.checked_at) : null,
    facts: newFacts,
    builderImage: bool(data.builder_image ?? false),
    mediumCount: int(data.medium_count ?? 0),
    primaryMedium: int(data.primary_medium ?? 0),
  });
}

/** ResourceSecurity::whyEntry(). */
export function whyEntry(entry: Record<string, unknown>): WhyEntry {
  return {
    title: storedTitle(str(entry.title ?? ""), str(entry.package ?? ""), str(entry.version ?? ""), str(entry.severity ?? "unknown")),
    display_id: str(entry.display_id ?? ""),
    link: entry.link === null || entry.link === undefined ? null : str(entry.link),
    score: isNumeric(entry.score) ? Number(entry.score) : null,
    severity: str(entry.severity ?? "unknown"),
    signal: entry.signal === null || entry.signal === undefined ? null : str(entry.signal),
    package: str(entry.package ?? ""),
    version: str(entry.version ?? ""),
  };
}

// ── SecurityStatus ──────────────────────────────────────────────────────────

const notChecked = (reason: string): ResourceSecurity => security("not_checked", { checkReason: reason });

/** The status of one scanned image. `rules` are the relevance rules of the scan's owner, when the caller has them. */
export function forScan(scan: ImageScanRow, data: ScanData, rules?: RelevanceRules): ResourceSecurity {
  if (scan.status !== "completed" || resourceOf(scan, data) === null) return notChecked(NOT_SCANNED);
  return evaluate(scan, data, rules);
}

/** The status of a resource from its current scans, computed now (a service combines its applications and databases). */
export function forResource(resource: ScanResource, data: ScanData, currentScans?: readonly ImageScanRow[], imageStatuses: ReadonlyMap<string, ResourceSecurity> = new Map()): ResourceSecurity {
  const off = offState(resource);
  if (off !== null) return notChecked(off);
  const images = statusOwners(resource, ownersOf(resource)).map((owner) => {
    const scans = currentScans === undefined ? currentFor(owner, data) : currentScans.filter((s) => s.resourceType === owner.morphClass && s.resourceId === owner.id);
    return { parts: scans.map((s) => imageStatuses.get(s.uuid) ?? evaluate(s, data)), unchecked: uncheckedComposeImages(owner, scans, data) };
  });
  return combineImages(images, resource.kind === "service", data.now);
}

/** The status of a resource from the stored statuses of its current scans. */
export function stored(resource: ScanResource, data: ScanData): ResourceSecurity {
  return storedMany([resource], data)[keyOf(resource)]!;
}

/** stored() for many resources. `scans`: the current scans of the owners of the scanned resources, when the caller has them. */
export function storedMany(resources: readonly ScanResource[], data: ScanData, scans?: Map<string, ImageScanRow[]>): Record<string, ResourceSecurity> {
  if (resources.length === 0) return {};
  const offStates = new Map(resources.map((r) => [keyOf(r), offState(r)]));
  const scanned = resources.filter((r) => offStates.get(keyOf(r)) === null);
  const owners = ownersOfMany(scanned);
  const allOwners = [...owners.values()].flat();
  const current = scans ?? currentForMany(allOwners, data);
  const composeRows = composeDeploymentRows(allOwners, current, data);
  const result: Record<string, ResourceSecurity> = {};
  for (const resource of resources) {
    const key = keyOf(resource);
    const off = offStates.get(key) ?? null;
    if (off !== null) {
      result[key] = notChecked(off);
      continue;
    }
    const images = statusOwners(resource, owners.get(key) ?? []).map((owner) => {
      const ownerScans = current.get(keyOf(owner)) ?? [];
      return {
        parts: ownerScans.map((s) => (isRecord(dataGet(s.summary, "security")) ? securityFromArray(dataGet(s.summary, "security")) : null)),
        unchecked: uncheckedComposeImages(owner, ownerScans, data, composeRows),
      };
    });
    result[key] = combineImages(images, resource.kind === "service", data.now);
  }
  return result;
}

/** Adds the status of a completed scan to its summary (not saved); preview scans get none. */
export function store(scan: ImageScanRow, data: ScanData): void {
  if (scan.status !== "completed" || resourceOf(scan, data) === null) return;
  const summary: Record<string, Json> = { ...(record(scan.summary) as Record<string, Json>) };
  delete summary.security;
  const deployment = scan.deploymentQueueId === null ? undefined : data.deployments.get(scan.deploymentQueueId);
  if (scan.deploymentQueueId === null || (deployment?.pullRequestId ?? 0) === 0) summary.security = securityToArray(evaluate(scan, data));
  scan.summary = summary;
}

/** A finding of a builder image that a builder update would fix: an OS package with a fixed version. */
const builderCanFix = (f: Finding): boolean => ["apk", "deb", "rpm"].includes(lower(f.type)) && f.fixState === "fixed" && (f.fixedIn ?? "") !== "";

/** The owners whose images count: the scanned applications and databases of a service, else the resource itself. */
function statusOwners(resource: ScanResource, owners: readonly ScanOwner[]): ScanOwner[] {
  return resource.kind === "service" ? owners.filter(isScanTarget) : [...owners];
}

function combineImages(images: ReadonlyArray<{ parts: Array<ResourceSecurity | null>; unchecked: number }>, isService: boolean, now: Date): ResourceSecurity {
  let total = 0;
  const parts: ResourceSecurity[] = [];
  for (const owner of images) {
    total += Math.max(1, owner.parts.length) + owner.unchecked;
    for (const part of owner.parts) if (part !== null) parts.push(part);
  }
  if (parts.length === 0) return notChecked(NOT_SCANNED);
  return resolve(parts, { checked: parts.length, total }, isService, now);
}

interface Stats {
  owner: string | null;
  owner_type: string | null;
  owner_id: number | string | null;
  signal: number;
  kev: number;
  critical: number;
  high: number;
  medium: number;
  relevant: number;
  eol: number;
  why: WhyEntry[];
}

const emptyStats = (): Stats => ({ owner: null, owner_type: null, owner_id: null, signal: 0, kev: 0, critical: 0, high: 0, medium: 0, relevant: 0, eol: 0, why: [] });

function statsOf(input: unknown): Stats {
  const d = isRecord(input) ? input : {};
  const ownerId = d.owner_id ?? null;
  return {
    owner: d.owner === null || d.owner === undefined ? null : str(d.owner),
    owner_type: d.owner_type === null || d.owner_type === undefined ? null : str(d.owner_type),
    owner_id: typeof ownerId === "number" || typeof ownerId === "string" ? ownerId : null,
    signal: int(d.signal ?? 0),
    kev: int(d.kev ?? 0),
    critical: int(d.critical ?? 0),
    high: int(d.high ?? 0),
    medium: int(d.medium ?? 0),
    relevant: int(d.relevant ?? 0),
    eol: int(d.eol ?? 0),
    why: list(d.why ?? []).map((e) => whyEntry(record(e))),
  };
}

const statsJson = (s: Stats): Json => ({ ...s, why: s.why as unknown as Json }) as unknown as Json;

/** The status of one scan before it is combined with other images. */
function evaluate(scan: ImageScanRow, data: ScanData, givenRules?: RelevanceRules): ResourceSecurity {
  const owner = resourceOf(scan, data)!;
  const rules = givenRules ?? relevanceRulesFor(owner, data);
  const result = actionsForScan(scan, rules, data);
  const actions = result.actions;
  const ownerData = { owner: ownerName(owner), owner_type: owner.morphClass, owner_id: owner.id };
  const stats: Stats[] = actions.map(() => ({ ...emptyStats(), ...ownerData }));
  const counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])) as Counts;
  const unfixed: WhyEntry[] = [];
  const seen = new Set<string>();
  let hasRelevant = false;
  const isBuilder = imageKind(scan, owner) === "builder";
  for (const finding of findings(scan)) {
    const key = lower(finding.id);
    if (seen.has(key) || !isRelevant(finding, rules)) continue;
    seen.add(key);
    hasRelevant = true;
    const signal = exploitSignal(finding);
    const severity = lower(finding.severity);
    const action = result.byFinding.get(finding.id);
    const why = whyFor(finding, signal);
    if (action === undefined) {
      if (signal !== null) {
        counts.signal_unfixed++;
        counts.kev_unfixed += signal === EXPLOITED ? 1 : 0;
        counts.builder_unfixed += isBuilder && builderCanFix(finding) ? 1 : 0;
        unfixed.push(why);
      }
      continue;
    }
    const s = stats[actions.indexOf(action)]!;
    s.relevant++;
    s.why.push(why);
    counts.relevant_fixed++;
    if (signal !== null) {
      s.signal++;
      counts.signal_fixed++;
    }
    if (signal === EXPLOITED) {
      s.kev++;
      counts.kev_fixed++;
    }
    if (severity === "critical" || severity === "high" || severity === "medium") {
      s[severity]++;
      counts[`${severity}_fixed`]++;
    }
  }
  // Leaving an end-of-life OS counts as one critical relevant fix.
  if (result.eol !== null) {
    const s = stats[actions.indexOf(result.eol)]!;
    s.eol = 1;
    s.critical++;
    s.relevant++;
    counts.critical_fixed++;
    counts.relevant_fixed++;
  }
  for (const s of stats) s.why = topWhy(s.why);

  const eolDistro = dataGet(scan.summary, "eol_distro");
  const eol = isRecord(eolDistro) ? { name: str(eolDistro.name ?? ""), version: str(eolDistro.version ?? ""), fixed: result.eol !== null } : null;

  const reasons: string[] = [];
  if (bool(dataGet(scan.summary, "truncated", false))) reasons.push(REASON_TRUNCATED);
  if (databaseWasOld(scan)) reasons.push(REASON_DB_OUTDATED);
  if (runsOtherImage(scan, owner, data)) reasons.push(REASON_IMAGE_CHANGED);
  if ((hasRelevant || eol !== null) && !versionsChecked(scan, owner)) reasons.push(REASON_VERSIONS_UNCHECKED);

  return resolve(
    [
      security("ok", {
        actions,
        eol,
        checkedAt: scan.scannedAt,
        facts: { reasons, counts: counts as unknown as Json, action_stats: stats.map(statsJson), unfixed_why: topWhy(unfixed) as unknown as Json },
      }),
    ],
    null,
    false,
    data.now,
  );
}

/** RelevanceRules::forResource(). */
export function relevanceRulesFor(owner: ScanOwner, data: ScanData): RelevanceRules {
  return new RelevanceRules(IgnoreMatcher.forResource(owner, data), countMediumFor(owner, data));
}

/** Combines the statuses of images (or the raw data of one image) and applies the rules of spec 15.6. */
function resolve(parts: readonly ResourceSecurity[], images: { checked: number; total: number } | null, isService: boolean, now: Date): ResourceSecurity {
  let entries: Array<{ action: SecurityAction; stats: Stats }> = [];
  const counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])) as Counts;
  let reasons: string[] = [];
  let unfixed: WhyEntry[] = [];
  let eol: Eol | null = null;
  let checkedAt: Date | null = null;
  let unknownTime = false;
  for (const part of parts) {
    const facts = part.facts;
    part.actions.forEach((action, index) => entries.push({ action, stats: statsOf(dataGet(facts, `action_stats.${index}`)) }));
    for (const key of COUNT_KEYS) counts[key] += int(dataGet(facts, `counts.${key}`, 0));
    reasons = [...reasons, ...list(facts.reasons ?? []).filter((r): r is string => typeof r === "string")];
    unfixed = [...unfixed, ...list(facts.unfixed_why ?? []).map((e) => whyEntry(record(e)))];
    if (part.eol !== null && (eol === null || (eol.fixed && !part.eol.fixed))) eol = part.eol;
    if (part.checkedAt === null) unknownTime = true;
    else if (checkedAt === null || part.checkedAt.getTime() < checkedAt.getTime()) checkedAt = part.checkedAt;
  }
  if (unknownTime) checkedAt = null;
  if (isService) entries = mergeUpdates(entries);
  entries = sortEntries(entries);

  const actionStatus: SecurityStatusType = counts.signal_fixed > 0 ? "update_now" : counts.relevant_fixed > 0 ? "update_available" : counts.signal_unfixed > 0 ? "no_fix" : "ok";
  const storedReasons = unique(reasons);
  const allReasons = [...storedReasons];
  if (checkedAt === null || checkedAt.getTime() < subDays(now, STALE_AFTER_DAYS).getTime()) allReasons.push(REASON_STALE);
  if (images !== null && images.checked < images.total) allReasons.push(REASON_IMAGES_UNCHECKED);
  const reason = REASON_ORDER.find((code) => allReasons.includes(code)) ?? null;
  const status: SecurityStatusType = reason === null ? actionStatus : "check_needed";

  const primary = entries[0]?.stats ?? null;
  let why: WhyEntry[] = [];
  let moreFixed = 0;
  if (primary !== null && (actionStatus === "update_now" || actionStatus === "update_available")) {
    why = primary.why;
    moreFixed = Math.max(0, primary.relevant - primary.eol - why.length);
  } else if (actionStatus === "no_fix") why = topWhy(unfixed);

  return security(status, {
    checkReason: reason,
    checkContext: reason === REASON_IMAGES_UNCHECKED ? (images as unknown as Record<string, Json>) : reason === REASON_STALE ? { time: checkedAt === null ? null : iso8601(checkedAt) } : {},
    actions: entries.map((e) => e.action),
    why,
    moreFixed,
    exploitedWithoutFix: counts.signal_unfixed > 0 && (status === "update_now" || status === "update_available"),
    problemCount: actionStatus === "update_now" ? counts.signal_fixed : actionStatus === "update_available" ? counts.critical_fixed + counts.high_fixed + counts.medium_fixed : actionStatus === "no_fix" ? counts.signal_unfixed : 0,
    exploitedCount: counts.signal_fixed + counts.signal_unfixed,
    anyExploited: actionStatus === "update_now" ? counts.kev_fixed > 0 : actionStatus === "no_fix" ? counts.kev_unfixed > 0 : false,
    criticalCount: counts.critical_fixed,
    highCount: counts.high_fixed,
    mediumCount: counts.medium_fixed,
    fixedByPrimary: actionStatus === "update_now" ? (primary?.signal ?? 0) : actionStatus === "update_available" ? (primary?.critical ?? 0) + (primary?.high ?? 0) + (primary?.medium ?? 0) : 0,
    primaryCritical: primary?.critical ?? 0,
    primaryHigh: primary?.high ?? 0,
    primaryMedium: primary?.medium ?? 0,
    eol,
    checkedAt,
    facts: {
      action_status: actionStatus,
      reasons: storedReasons,
      counts: counts as unknown as Json,
      action_stats: entries.map((e) => statsJson(e.stats)),
      unfixed_why: topWhy(unfixed) as unknown as Json,
    },
    builderImage: counts.signal_unfixed > 0 && counts.builder_unfixed === counts.signal_unfixed,
  });
}

/** Images of one service that run the same tag and update to the same tag get one action. */
function mergeUpdates(entries: Array<{ action: SecurityAction; stats: Stats }>): Array<{ action: SecurityAction; stats: Stats }> {
  const groups = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    const key = updateKey(entry) ?? `single:${index}`;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  const merged: Array<{ action: SecurityAction; stats: Stats }> = [];
  for (const indexes of groups.values()) {
    const group = indexes.map((i) => entries[i]!);
    const names = unique(group.map((e) => str(e.stats.owner)));
    if (group.length === 1 || names.length < 2) {
      merged.push(...group);
      continue;
    }
    const first = group[0]!.action;
    const last = names.pop()!;
    const stats = emptyStats();
    for (const entry of group) {
      for (const key of ["signal", "kev", "critical", "high", "medium", "relevant", "eol"] as const) stats[key] += entry.stats[key];
      stats.why = [...stats.why, ...entry.stats.why];
    }
    stats.why = topWhy(stats.why);
    merged.push({
      action: {
        type: "update_image",
        sentence: `Update ${names.join(", ")} and ${last} to ${first.target ?? ""}.`,
        target: first.target,
        copy: null,
        fixedIds: unique(group.flatMap((e) => e.action.fixedIds)),
        button: group.every((e) => e.action.button),
        image: first.image,
        ref: first.ref,
        parts: group.map((e) => ({ owner_type: str(e.stats.owner_type), owner_id: e.stats.owner_id, image: e.action.image, ref: e.action.ref })),
      },
      stats,
    });
  }
  return merged;
}

function updateKey(entry: { action: SecurityAction; stats: Stats }): string | null {
  const action = entry.action;
  if (action.type !== "update_image" || action.sentence === COOLIFY_TEXT || blank(action.target) || blank(action.image) || blank(entry.stats.owner) || blank(entry.stats.owner_type)) return null;
  const current = ImageRef.tryParse(str(action.image));
  if (current === null) return null;
  return current.digest === null ? `${current.tag ?? "latest"}|${action.target}` : null;
}

/** Most fixes with an exploit signal first, then most critical and high, then most medium, then the action types' order. */
function sortEntries(entries: Array<{ action: SecurityAction; stats: Stats }>): Array<{ action: SecurityAction; stats: Stats }> {
  const order = (t: string) => (SECURITY_ACTION_TYPES as readonly string[]).indexOf(t);
  const key = (e: { action: SecurityAction; stats: Stats }, index: number) => [-e.stats.signal, -(e.stats.critical + e.stats.high), -e.stats.medium, order(e.action.type), index];
  return entries.map((e, i) => ({ e, k: key(e, i) })).sort((a, b) => spaceship(a.k, b.k)).map(({ e }) => e);
}

/** One why-list entry of a finding. */
export function whyFor(finding: Finding, signal: string | null): WhyEntry {
  return {
    title: finding.title,
    display_id: finding.displayId,
    link: advisoryUrl(finding.displayId),
    score: finding.cvssScore,
    severity: lower(finding.severity),
    signal,
    package: finding.package,
    version: finding.version,
  };
}

/** `exploited`, then `likely`, then the highest score (no score last), then severity, at most $limit. */
export function topWhy(entries: readonly WhyEntry[], limit = WHY_LIMIT): WhyEntry[] {
  const signalRank: Record<string, number> = { [EXPLOITED]: 0, [LIKELY]: 1 };
  const severityRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const key = (e: WhyEntry) => [signalRank[e.signal ?? ""] ?? 2, -(e.score ?? -1.0), severityRank[e.severity] ?? 4, e.display_id];
  return [...entries].sort((a, b) => spaceship(key(a), key(b))).slice(0, limit);
}

/** The vulnerability database was more than DATABASE_MAX_AGE_DAYS old when the image was scanned. */
function databaseWasOld(scan: ImageScanRow): boolean {
  const builtAt = scan.grypeDbBuiltAt;
  const scannedAt = scan.scannedAt;
  return builtAt !== null && scannedAt !== null && builtAt.getTime() < subDays(scannedAt, DATABASE_MAX_AGE_DAYS).getTime();
}

/** The version check and the base check have a result (or one only the user can unblock). */
export function versionsChecked(scan: ImageScanRow, owner: ScanOwner, blockedCounts = true): boolean {
  const settled = (status: unknown, error: unknown) => (typeof status === "string" && CHECKED_STATUSES.includes(status)) || (blockedCounts && isBlockedCheck(status, error));
  const needsImageCheck = owner.kind !== "application" || owner.buildPack === "dockerimage" || (owner.buildPack === "dockercompose" && scan.buildsImage === false);
  if (needsImageCheck && !settled(candidateStatus(scan), dataGet(scan.candidates, "error"))) return false;
  if (owner.kind === "application" && owner.buildPack === "dockerfile" && filled(scan.baseImageRef)) {
    const base = dataGet(scan.candidates, "base");
    return isRecord(base) && (base.image ?? null) === scan.baseImageRef && settled(base.status ?? null, base.error ?? null) && Number.isInteger(base.attributable);
  }
  return true;
}

/** A version or base check Coolify cannot finish by itself: a registry login, or the server's daily limit of checks. */
export const isBlockedCheck = (status: unknown, error: unknown): boolean => status === "auth_required" || (status === "failed" && error === "daily_limit");

function ownerName(owner: ScanOwner): string | null {
  const name = owner.kind === "serviceApplication" || owner.kind === "serviceDatabase" ? owner.humanName || owner.name : owner.name;
  return filled(name) ? str(name) : null;
}

