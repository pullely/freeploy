// Derived from coollabsio/coolify@91b7e3e:app/Services/ImageScan/SecuritySentences.php (Apache-2.0), modified.
//
// The copy of the security status card (spec 15.5, 15.7, 15.11): pure functions of a stored status and the stored scan.
// "Coolify" in these sentences is the brand of the product the text describes; Freeploy keeps Coolify's words, as its
// other ported copy does where it names the engine's own behaviour.
import { ImageRef, tagOf } from "./image-ref.js";
import { candidateEntries, candidateStatus, resourceOf, updateCandidates, type ImageScanRow, type ScanData, type SecurityStatusType } from "./model.js";
import { dataGet, diffForHumans, filled, int, iso8601, isRecord, list, lower, parseTime, str, unique } from "./php.js";
import { findings } from "./resource-scans.js";
import { BUILDER_TEXT, COOLIFY_TEXT, imageKind, type SecurityAction } from "./security-actions.js";
import { NOT_SCANNED, primaryOf, REASON_DB_OUTDATED, REASON_IMAGE_CHANGED, REASON_IMAGES_UNCHECKED, REASON_STALE, REASON_TRUNCATED, REASON_VERSIONS_UNCHECKED, type ResourceSecurity } from "./security-status.js";
import type { Finding } from "./finding.js";

const REGISTRY_NAMES: Record<string, string> = { "docker.io": "Docker Hub", "ghcr.io": "GitHub Container Registry", "quay.io": "Quay" };
export const CHECKING_BADGE = "Checking";
const CHECK_REASONS = [REASON_IMAGES_UNCHECKED, REASON_TRUNCATED, REASON_STALE, REASON_DB_OUTDATED, REASON_IMAGE_CHANGED, REASON_VERSIONS_UNCHECKED];
const MAJOR_NOTE = " This is a major version change. Check for breaking changes.";

/** The sentence under the status line. */
export function headline(s: ResourceSecurity, now: Date): string {
  switch (s.status) {
    case "update_now":
      return updateNow(s);
    case "update_available":
      return updateAvailable(s);
    case "no_fix":
      return noFix(s);
    case "ok":
      return "No action needed.";
    case "check_needed":
      return `Coolify needs to check this image again: ${CHECK_REASONS.includes(s.checkReason ?? "") ? checkReason(str(s.checkReason), checkContext(s), now) : "the last check is incomplete"}.`;
    case "not_checked":
      return checkReason(s.checkReason ?? NOT_SCANNED, s.checkContext, now);
  }
}

/** Extra lines under the headline. */
export function lines(s: ResourceSecurity): string[] {
  if (!s.exploitedWithoutFix) return [];
  const unfixed = s.status === "update_now" ? s.exploitedCount - s.problemCount : s.status === "update_available" ? s.exploitedCount : 0;
  if (unfixed < 1) return [];
  const use = int(dataGet(s.facts, "counts.kev_unfixed", 0)) > 0 ? "are using" : "are likely to use";
  return [unfixed > 1 ? `${unfixed} more problems that attackers ${use} have no fix yet.` : `One more problem that attackers ${use} has no fix yet.`];
}

/** The reason of a check_needed status, or the text of a not_checked status. */
export function checkReason(code: string, context: Record<string, unknown>, now: Date): string {
  switch (code) {
    case REASON_IMAGES_UNCHECKED:
      return `${int(context.checked ?? 0)} of ${int(context.total ?? 0)} images were checked`;
    case REASON_TRUNCATED:
      return "the scan result was too large to read completely";
    case REASON_STALE:
      return `the last check was ${ago(context.time ?? null, now)}`;
    case REASON_DB_OUTDATED:
      return "the vulnerability database is out of date";
    case REASON_IMAGE_CHANGED:
      return "the running image is not the checked image";
    case REASON_VERSIONS_UNCHECKED:
      return "Coolify has not checked for newer versions yet";
    case "server":
      return "Image scanning is off for this server.";
    case "application":
      return "Image scanning is off for this app.";
    default:
      return "This image has not been scanned yet.";
  }
}

/** The line after the why-list; empty for none. */
export function whyMore(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? "and 1 more problem that this update fixes" : `and ${count} more problems that this update fixes`;
}

export function badge(status: SecurityStatusType): string | null {
  switch (status) {
    case "update_now":
      return "Update now";
    case "update_available":
      return "Security update";
    case "no_fix":
      return "No fix yet";
    case "check_needed":
      return "Check needed";
    default:
      return null;
  }
}

/** The confirmation before a database moves to a newer tag of the same major version. */
export function databaseUpdateConfirmation(dbType: string, fromTag: string, toTag: string): string {
  const m = /^v?(\d+)/i.exec(toTag) ?? /^v?(\d+)/i.exec(fromTag);
  const name = m === null ? dbType : `${dbType} ${m[1]}`;
  return `This is a patch release of ${name}. Your data stays as it is. The database restarts and is unavailable for a few seconds.`;
}

/** The sentence of one image row: it starts with the image ref, or with "This app" for an image Coolify builds. */
export function imageSentence(s: ResourceSecurity, imageRef: string, now: Date, scan: ImageScanRow | null = null, data: ScanData | null = null): string {
  const subject = builtByCoolify(scan, data) ? "This app" : imageRef;
  switch (s.status) {
    case "update_now":
      return updateNow(s, subject, "A newer build");
    case "update_available":
      return imageUpdateAvailable(s, subject);
    case "no_fix":
      return s.builderImage ? noFix(s, subject) : `${subject} has ${problems(s.problemCount)} that attackers ${s.anyExploited ? "are using" : "are likely to use"}. ${noFixState(scan, s)}`;
    case "ok":
      return `${subject} needs no action.`;
    case "check_needed":
      return `${subject} needs another check: ${CHECK_REASONS.includes(s.checkReason ?? "") ? checkReason(str(s.checkReason), checkContext(s), now) : "the last check is incomplete"}.`;
    case "not_checked":
      return s.checkReason === null || s.checkReason === NOT_SCANNED ? `${subject} has not been checked yet.` : checkReason(s.checkReason, s.checkContext, now);
  }
}

/** The sentence of an image row while its queued version check runs. */
export function versionCheckRunning(imageRef: string, scan: ImageScanRow | null = null, data: ScanData | null = null): string {
  return `Coolify is checking for newer versions of ${builtByCoolify(scan, data) ? "this app" : imageRef}.`;
}

/** The short action text of a no_fix status for the team page; null for other statuses. */
export function noFixAction(s: ResourceSecurity): string | null {
  if (s.status !== "no_fix") return null;
  return s.builderImage ? "Needs a builder update in a Coolify release." : "No fix released yet. Coolify checks daily.";
}

function builtByCoolify(scan: ImageScanRow | null, data: ScanData | null): boolean {
  if (scan === null || data === null || !scan.buildsImage) return false;
  const owner = resourceOf(scan, data);
  return owner !== null && ["dockerfile", "compose", "builder"].includes(imageKind(scan, owner));
}

function noFixState(scan: ImageScanRow | null, s: ResourceSecurity): string {
  const none = "No fixed version exists yet, and Coolify checks every day.";
  const found = scan === null ? [] : whyFindings(scan, s);
  const withFix = found.filter(hasPackageFix).length;
  if (found.length === 0 || withFix === 0) return none;
  const many = s.problemCount > 1;
  if (withFix < found.length) return "Some of them have a fix that the image does not include yet. Coolify checks every day.";
  const newest = newestImageWithout(scan!, found);
  if (newest !== null) return `${many ? "The fixes are" : "The fix is"} not in the newest ${newest} image yet. Coolify checks every day.`;
  return many ? "A fix exists for each, but the image does not include them yet. Coolify checks every day." : "A fix exists, but the image does not include it yet. Coolify checks every day.";
}

function newestImageWithout(scan: ImageScanRow, found: readonly Finding[]): string | null {
  if (!["ok", "no_better"].includes(candidateStatus(scan) ?? "")) return null;
  const image = ImageRef.tryParse(scan.imageRef);
  const name = image === null ? null : ImageRef.tryParse(image.qualifiedName());
  if (image === null || name === null) return null;
  const line = releaseLine(image.tag, image.tag);
  if (line === null) return null;
  const ids = new Set(found.flatMap((f) => [f.id, ...f.aliases].map((id) => lower(str(id)))));
  for (const entry of candidateEntries(scan)) {
    if (entry.kind !== "same_tag" && entry.kind !== "line") continue;
    for (const id of list(entry.fixed_ids ?? [])) if (ids.has(lower(str(id)))) return null;
  }
  return `${name.toString()} ${line}`;
}

function whyFindings(scan: ImageScanRow, s: ResourceSecurity): Finding[] {
  const whyIds = new Set(s.why.map((w) => lower(str(w.display_id))));
  return findings(scan).filter((f) => [f.id, f.displayId, ...f.aliases].some((id) => whyIds.has(lower(id))));
}

const hasPackageFix = (f: Finding): boolean => f.fixState === "fixed" && filled(f.fixedIn);

/** The short note after an update_available image row's sentence. */
export function attackNote(s: ResourceSecurity): string | null {
  if (s.status !== "update_available" || s.exploitedWithoutFix) return null;
  return `No known attacks on ${Math.max(1, s.fixedByPrimary) > 1 ? "these problems" : "this problem"}.`;
}

/** The advice under a no_fix image row, until a fix exists. */
export function noFixAdvice(s: ResourceSecurity, resourceNoun = "this app"): string | null {
  if (s.status !== "no_fix" || s.builderImage) return null;
  return s.problemCount > 1
    ? `Until then, limit who can reach ${resourceNoun}, or ignore the problems if the affected parts are not used.`
    : `Until then, limit who can reach ${resourceNoun}, or ignore the problem if the affected part is not used.`;
}

/** How Coolify knows that the action of an image row fixes its problems, or that no fix exists (spec 15.11). */
export function provenance(scan: ImageScanRow, action: SecurityAction | null, s: ResourceSecurity, now: Date, counts: { fixes?: number | null; adds?: number | null; fixed_in?: string | null } = {}): string | null {
  if (action === null) return s.status === "no_fix" && !s.builderImage ? noFixProvenance(scan, s, now) : null;
  const registry = registryName(scan.imageRef);
  switch (action.type) {
    case "pull_latest":
    case "update_image": {
      const entry = candidateEntry(scan, action);
      if (entry === null) return null;
      const tag = str(action.target ?? tagOf(str(action.ref)));
      const line = releaseLine(tagOf(scan.imageRef), tag);
      const intro = action.type === "pull_latest" ? `${registry} has a newer build of ${tag}.` : line === null ? `${tag} is the newest release of this line on ${registry}.` : `${tag} is the newest ${line} release on ${registry}.`;
      return `${intro} Coolify scanned it${scannedAt(entry.scanned_at ?? null, now)}${candidateFindings(entry)}`;
    }
    case "change_base": {
      const base = dataGet(scan.candidates, "base");
      const entries = isRecord(base) ? list(base.entries) : [];
      const entry = entries.find((e): e is Record<string, unknown> => isRecord(e) && e.kind === "line" && e.better === true && str(e.ref ?? "") !== "" && tagOf(str(e.ref)) === tagOf(str(action.target)));
      if (entry === undefined) return null;
      return `${action.target ?? ""} is the newest release of your base image. Coolify scanned it${scannedAt(entry.scanned_at ?? null, now)}${candidateFindings(entry)}`;
    }
    case "upgrade_package":
    case "upgrade_in_dockerfile": {
      const fixedIn = counts.fixed_in ?? null;
      return filled(fixedIn) && filled(action.target) ? `The advisory lists ${action.target} ${fixedIn} as the first fixed version.` : null;
    }
    case "rebuild":
      return filled(scan.baseImageRef) ? `The current ${scan.baseImageRef} image already has the fixed system packages.` : "The current base image already has the fixed system packages.";
    default:
      return null;
  }
}

/** "Docker Hub", "GitHub Container Registry", "Quay", else the host. */
export function registryName(imageRef: string): string {
  const ref = ImageRef.tryParse(imageRef);
  if (ref === null) return "the registry";
  return REGISTRY_NAMES[ref.registry] ?? ref.registry;
}

/** "2 of 3 images need an update"; null when none needs one. */
export function imagesNeedingUpdate(count: number, total: number): string | null {
  if (count < 1) return null;
  return `${count} of ${total} images ${count === 1 ? "needs" : "need"} an update`;
}

/** "12 known issues". */
export function knownIssues(known: number): string {
  return known < 1 ? "No known issues" : known === 1 ? "1 known issue" : `${known} known issues`;
}

/** The first 12 characters of the digest, without "sha256:". */
export function shortDigest(digest: string | null): string | null {
  const d = (digest ?? "").trim();
  if (d === "") return null;
  const hex = d.includes("sha256:") ? d.slice(d.indexOf("sha256:") + "sha256:".length) : d;
  return hex.slice(0, 12) || null;
}

function noFixProvenance(scan: ImageScanRow, s: ResourceSecurity, now: Date): string | null {
  const checkedAt = isRecord(scan.candidates) ? (scan.candidates.checked_at ?? null) : null;
  if (typeof checkedAt !== "string" || !["ok", "no_better"].includes(candidateStatus(scan) ?? "")) return null;
  const one = s.problemCount <= 1;
  const entries = candidateEntries(scan);
  const tag = tagOf(scan.imageRef);
  const checked = `Coolify checked ${registryName(scan.imageRef)}${scannedAt(checkedAt, now)}`;
  const newer = unique(entries.filter((e) => e.kind === "same_tag" || e.kind === "line").map((e) => (e.kind === "same_tag" ? `a newer build of ${tag ?? ""}` : str(tagOf(str(e.ref ?? ""))))));
  const line = releaseLine(tag, tag);
  const sentences: Array<string | null> = [
    newer.length === 0 ? `${checked}: you already run the newest ${line === null ? `build of ${tag ?? ""}` : `${line} version`}.` : `${checked}: ${andList(newer)}${newer.length > 1 ? " are" : " is"} newer, but not better.`,
  ];
  sentences.push(noFixPackages(scan, s, one));
  const majorEntry = entries.find((e) => e.kind === "major" && "fixes_problems" in e);
  if (majorEntry !== undefined) {
    const fixed = new Set(list(majorEntry.fixed_ids ?? []).map((id) => lower(str(id))));
    const whyIds = s.why.map((w) => lower(str(w.display_id)));
    const fixedWhy = whyIds.filter((id) => fixed.has(id)).length;
    const ref = str(majorEntry.ref ?? "");
    sentences.push(
      majorEntry.fixes_problems === true && fixedWhy > 0
        ? `${ref}, a new major version, fixes ${fixedWhy < whyIds.length ? "some of them" : one ? "it" : "them"}. Coolify does not change major versions for you, because they can need a data migration or code changes: read its upgrade notes first.`
        : `The newest major version, ${ref}, is not better either.`,
    );
  }
  return sentences.filter((x): x is string => x !== null && x !== "").join(" ");
}

function noFixPackages(scan: ImageScanRow, s: ResourceSecurity, one: boolean): string | null {
  const packages = unique(s.why.map((w) => str(w.package)).filter((p) => p !== "" && p !== "0"));
  if (packages.length === 0) return null;
  const found = whyFindings(scan, s);
  const withFix = found.filter(hasPackageFix).length;
  const names = andList(packages);
  const where = `${s.problemCount > s.why.length ? "The listed problems are" : one ? "The problem is" : "The problems are"} in ${names}`;
  if (found.length === 0) return `${where}.`;
  if (withFix === 0) return `${where}, and no fixed version of ${packages.length > 1 ? "them" : "it"} exists yet.`;
  if (withFix === found.length) return `${where}. Fixed versions exist, but the image does not include them yet.`;
  return `${where}. Some of them have a fixed version that the image does not include yet.`;
}

/** "8.x", or "8.0.x" when both tags have three or more parts with the same minor; null for a tag that is not a version. */
function releaseLine(currentTag: string | null, tag: string | null): string | null {
  const parts = (value: string | null): string[] => {
    const m = value === null ? null : /^[^0-9]*(\d+(?:\.\d+)*)/.exec(value);
    return m ? m[1]!.split(".") : [];
  };
  const current = parts(currentTag);
  const candidate = parts(tag);
  if (candidate.length === 0) return null;
  if (candidate.length >= 3 && current.length >= 3 && current[0] === candidate[0] && current[1] === candidate[1] && currentTag !== tag) return `${candidate[0]}.${candidate[1]}.x`;
  return `${candidate[0]}.x`;
}

/** "a", "a and b", "a, b, and c". */
const andList = (items: readonly string[]): string => (items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`);

function candidateFindings(entry: Record<string, unknown>): string {
  let text = ": it fixes these problems and adds none that attackers use.";
  const added = entry.added ?? null;
  if (typeof added === "number" && Number.isInteger(added) && added > 0) {
    text += added === 1 ? " It has 1 other problem that attackers are not known to use." : ` It has ${added} other problems that attackers are not known to use.`;
  }
  return text;
}

function candidateEntry(scan: ImageScanRow, action: SecurityAction): Record<string, unknown> | null {
  const kind = action.type === "pull_latest" ? "same_tag" : "line";
  return updateCandidates(scan).find((e) => e.kind === kind && (action.ref === null || (e.ref ?? null) === action.ref)) ?? null;
}

const scannedAt = (time: unknown, now: Date): string => (typeof time === "string" && time !== "" ? ` ${ago(time, now)}` : "");

/** update_available in the words of an image row. */
function imageUpdateAvailable(s: ResourceSecurity, imageRef: string): string {
  const action = primaryOf(s);
  const fixed = Math.max(1, s.fixedByPrimary);
  const only = s.primaryCritical > 0 && s.primaryHigh === 0 && s.primaryMedium === 0 ? "critical" : s.primaryMedium > 0 && s.primaryCritical === 0 && s.primaryHigh === 0 ? "medium" : null;
  const parts = severityParts(s);
  const problemsText =
    fixed === 1 ? (only === null ? "a serious problem" : `a ${only} problem`) : only !== null ? `${fixed} ${only} problems` : `${fixed} ${problemsNoun(s, "problems")}${parts.length === 0 ? "" : ` (${parts.join(", ")})`}`;
  const it = fixed === 1 ? "it" : "them";
  let sentence = str(action?.sentence);
  let note = "";
  if (sentence.endsWith(MAJOR_NOTE)) {
    sentence = sentence.slice(0, -MAJOR_NOTE.length);
    note = MAJOR_NOTE;
  }
  let text: string;
  if (action === null) text = `${imageRef} has ${problemsText}.`;
  else if (action.type === "pull_latest" && sentence !== COOLIFY_TEXT) text = `${imageRef} has a newer build that fixes ${problemsText}.${sentence.includes("Redeploy this app to pull it.") ? " Redeploy this app to pull it." : ""}`;
  else if (action.type === "update_image" && sentence.startsWith("Update to ") && sentence.endsWith(".")) text = `${imageRef} has ${problemsText}. ${sentence.slice(0, -1)} to fix ${it}.`;
  else text = `${imageRef} has ${problemsText}. ${sentence}`;
  const eol = eolSentence(s);
  return `${text}${note}${eol === "" ? "" : ` ${eol}`}`.trim();
}

function updateNow(s: ResourceSecurity, subject = "This image", newerBuild = "A newer build of this image"): string {
  const headlineText = `${subject} has ${problems(s.problemCount)} that attackers ${s.anyExploited ? "are using" : "are likely to use"}.`;
  const action = primaryOf(s);
  if (action === null) return headlineText;
  const fixed = s.fixedByPrimary;
  const what = fixed > 0 && fixed < s.problemCount ? `${fixed} of them` : s.problemCount === 1 ? "it" : "them";
  let sentence = action.sentence;
  if (action.type === "update_image" && sentence.startsWith("Update ") && sentence !== COOLIFY_TEXT && sentence.endsWith(".")) sentence = `${sentence.slice(0, -1)} to fix ${what}.`;
  else if (action.type === "pull_latest" && sentence !== COOLIFY_TEXT) sentence = `${newerBuild} fixes ${what}. ${pullInstruction(sentence)}`;
  return `${headlineText} ${sentence} ${eolSentence(s)}`.trim();
}

function updateAvailable(s: ResourceSecurity): string {
  const action = primaryOf(s);
  const fixed = Math.max(1, s.fixedByPrimary);
  const parts = severityParts(s);
  const breakdown = parts.length === 0 ? "" : ` (${parts.join(", ")})`;
  const noun = problemsNoun(s, fixed === 1 ? "problem" : "problems");
  const fixes = `This fixes ${fixed} ${noun}${breakdown}.`;
  let sentence = action?.sentence ?? "";
  if (action?.type === "pull_latest" && sentence !== COOLIFY_TEXT) sentence = `A newer build of this image is available. ${pullInstruction(sentence)}`;
  let note = "";
  if (sentence.endsWith(MAJOR_NOTE)) {
    sentence = sentence.slice(0, -MAJOR_NOTE.length);
    note = MAJOR_NOTE;
  }
  let text = `${sentence} ${fixes}`.trim() + note;
  const eol = eolSentence(s);
  if (eol !== "") text += ` ${eol}`;
  if (!s.exploitedWithoutFix) text += ` Attackers are not known to use ${fixed === 1 ? "it" : "them"}.`;
  return text;
}

function severityParts(s: ResourceSecurity): string[] {
  return [s.primaryCritical > 0 ? `${s.primaryCritical} critical` : null, s.primaryHigh > 0 ? `${s.primaryHigh} high` : null, s.primaryMedium > 0 ? `${s.primaryMedium} medium` : null].filter((x): x is string => x !== null);
}

const problemsNoun = (s: ResourceSecurity, noun: string): string => (s.primaryMedium > 0 ? noun : `serious ${noun}`);

function noFix(s: ResourceSecurity, subject = "This image"): string {
  const problemsText = problems(s.problemCount);
  const use = s.anyExploited ? "are using" : "are likely to use";
  if (s.builderImage) return `${subject} has ${problemsText} that attackers ${use}. ${BUILDER_TEXT}`;
  const ignore = s.problemCount > 1 ? "ignore the problems if the affected parts are not used" : "ignore the problem if the affected part is not used";
  return `${subject} has ${problemsText} that attackers ${use}, and no fixed version exists yet. Coolify checks every day and tells you when a fix is out. Until then, limit who can reach this app, or ${ignore}.`;
}

function pullInstruction(sentence: string): string {
  if (sentence.includes("Redeploy this app to pull it.")) return "Redeploy this app to pull it.";
  if (sentence.endsWith(" and redeploy.")) return "Pull it and redeploy.";
  return "Pull it and restart.";
}

function eolSentence(s: ResourceSecurity): string {
  if (s.eol === null || s.eol.name === "" || int(dataGet(s.facts, "action_stats.0.eol", 0)) < 1) return "";
  const name = s.eol.name.charAt(0).toUpperCase() + s.eol.name.slice(1);
  return `${`It moves off ${name} ${s.eol.version}`.trim()}, which no longer gets security fixes.`;
}

const problems = (count: number): string => (count > 1 ? `${count} security problems` : "a security problem");

function checkContext(s: ResourceSecurity): Record<string, unknown> {
  const context: Record<string, unknown> = { ...s.checkContext };
  if ((context.time ?? null) === null && s.checkedAt !== null) context.time = iso8601(s.checkedAt);
  return context;
}

function ago(time: unknown, now: Date): string {
  if (typeof time !== "string" || time === "") return "a while ago";
  const parsed = parseTime(time);
  return parsed === null ? "a while ago" : diffForHumans(parsed, now);
}
