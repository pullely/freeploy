// Derived from coollabsio/coolify@91b7e3e:app/Services/ImageScan/SecurityRules.php, app/Services/ImageScan/IgnoreMatcher.php
// and app/Services/ImageScan/RelevanceRules.php, and app/Models/ImageScanIgnore.php (scopeActive) (Apache-2.0), modified.
//
// Which findings matter (spec 15.2): relevance, the exploit signal, and the ignores of a resource and its team.
import type { Finding } from "./finding.js";
import type { AnyModel, IgnoreRow, ScanData } from "./model.js";
import { lower, phpTrim, subDays } from "./php.js";

export const EXPLOITED = "exploited";
export const LIKELY = "likely";
const LIKELY_EPSS = 0.1;
const LIKELY_SCORE = 7.0;
const SERIOUS_SEVERITIES = ["critical", "high"];
const OS_PACKAGE_TYPES = ["apk", "deb", "rpm"];

/** `exploited` for a finding in CISA KEV; `likely` for EPSS 0.10 or more with CVSS 7.0 or more (high or critical without a score). */
export function exploitSignal(finding: Finding): string | null {
  if (finding.kev) return EXPLOITED;
  const severe = finding.cvssScore !== null ? finding.cvssScore >= LIKELY_SCORE : isSerious(finding);
  return finding.epss !== null && finding.epss >= LIKELY_EPSS && severe ? LIKELY : null;
}

/** Not ignored, not a CPE-only OS match, and an exploit signal, severity critical or high, or a counted medium. */
export function isRelevant(finding: Finding, rules: RelevanceRules): boolean {
  return !isCpeOnlyOsMatch(finding) && (exploitSignal(finding) !== null || isSerious(finding) || isCountedMedium(finding, rules.countMedium)) && rules.ignores.matches(finding) === null;
}

/** An OS package (apk, deb, rpm) that Grype matched only by CPE. */
export function isCpeOnlyOsMatch(finding: Finding): boolean {
  return lower(finding.namespace).startsWith("nvd:cpe") && OS_PACKAGE_TYPES.includes(lower(finding.type));
}

/** The IDs and aliases of the relevant findings, lower case. */
export function relevantIds(findings: readonly Finding[], rules: RelevanceRules): string[] {
  const ids: string[] = [];
  for (const finding of findings) {
    if (!isRelevant(finding, rules)) continue;
    for (const id of [finding.id, ...finding.aliases]) if (id !== "") ids.push(lower(id));
  }
  return [...new Set(ids)];
}

function isCountedMedium(finding: Finding, countMedium: boolean): boolean {
  return lower(finding.severity) === "medium" && (countMedium || (finding.epss !== null && finding.epss >= LIKELY_EPSS));
}

const isSerious = (finding: Finding): boolean => SERIOUS_SEVERITIES.includes(lower(finding.severity));

// ── IgnoreMatcher ───────────────────────────────────────────────────────────

/** An ignore of a problem with an exploit signal applies for at most this many days after it was made. */
export const EXPLOIT_SIGNAL_IGNORE_DAYS = 90;

const normalize = (value: string | null): string | null => {
  const v = phpTrim(value ?? "");
  return v === "" ? null : lower(v);
};
const normalizePackage = (value: string | null): string | null => (value === null || value === "" ? null : value);

/** Matches findings against the active ignores of one resource and its team. */
export class IgnoreMatcher {
  private readonly byVulnerability = new Map<string, IgnoreRow[]>();
  private readonly byPackage = new Map<string, IgnoreRow[]>();

  private constructor(
    ignores: readonly IgnoreRow[],
    private readonly now: Date,
  ) {
    for (const ignore of ignores) {
      if (ignore.expiresAt !== null && ignore.expiresAt.getTime() < now.getTime()) continue;
      const vulnerabilityId = normalize(ignore.vulnerabilityId);
      const pkg = normalizePackage(ignore.package);
      if (vulnerabilityId !== null) this.byVulnerability.set(vulnerabilityId, [...(this.byVulnerability.get(vulnerabilityId) ?? []), ignore]);
      else if (pkg !== null) this.byPackage.set(pkg, [...(this.byPackage.get(pkg) ?? []), ignore]);
    }
  }

  static fromIgnores(ignores: readonly IgnoreRow[], now: Date): IgnoreMatcher {
    return new IgnoreMatcher(ignores, now);
  }

  /** The active ignores of the team (resource null) and of this resource (ImageScanIgnore::active()). */
  static forResource(resource: AnyModel, data: ScanData): IgnoreMatcher {
    // $resource->team(): an application or database of a service without its service has none.
    if ((resource.kind === "serviceApplication" || resource.kind === "serviceDatabase") && resource.service === null) return new IgnoreMatcher([], data.now);
    const active = data.ignores.filter(
      (i) => (i.expiresAt === null || i.expiresAt.getTime() > data.now.getTime()) && (i.resourceType === null || (i.resourceType === resource.morphClass && i.resourceId === resource.id)),
    );
    return new IgnoreMatcher(active, data.now);
  }

  matches(finding: Finding): IgnoreRow | null {
    const signal = exploitSignal(finding) !== null && !isCpeOnlyOsMatch(finding);
    for (const candidate of [finding.id, ...finding.aliases]) {
      for (const ignore of this.byVulnerability.get(normalize(candidate) ?? "") ?? []) {
        const pkg = normalizePackage(ignore.package);
        if ((pkg === null || pkg === finding.package) && this.applies(ignore, signal)) return ignore;
      }
    }
    for (const ignore of this.byPackage.get(finding.package) ?? []) if (this.applies(ignore, signal)) return ignore;
    return null;
  }

  /** An ignore of a problem with an exploit signal ends 90 days after it was made. */
  private applies(ignore: IgnoreRow, signal: boolean): boolean {
    if (!signal || ignore.createdAt === null) return true;
    return ignore.createdAt.getTime() >= subDays(this.now, EXPLOIT_SIGNAL_IGNORE_DAYS).getTime();
  }
}

/** What decides relevance for one resource: its active ignores and the "Count medium problems" rule. */
export class RelevanceRules {
  constructor(
    readonly ignores: IgnoreMatcher,
    readonly countMedium = false,
  ) {}

  /** The same ignores with every medium counted. */
  withAllMediums(): RelevanceRules {
    return new RelevanceRules(this.ignores, true);
  }
}
