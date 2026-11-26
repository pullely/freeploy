// Derived from coollabsio/coolify@91b7e3e:app/Services/ImageScan/SecurityCard.php,
// app/Actions/ImageScan/RefreshCandidates.php (message, isQueued) and app/Actions/ImageScan/UpdateResourceImage.php
// (subResourcesUsing) (Apache-2.0), modified.
//
// What the main card of a resource's Security page shows (spec 15.7, 15.11): the status of the resource, and one row per
// image with its status badge, sentence, primary action with its button or copy text, why-list, provenance, the other
// actions, and the running digest. Buttons are only offered to who may run them (`canUpdate`, `canDeploy`); the actions
// authorize again — and, in Freeploy, answer that the SSH executor is not available yet.
//
// Departures: an action's key is the first 16 hex digits of an md5 (Coolify: of a sha1) of the same JSON — a key the page
// sends back, never compared with Coolify's; RefreshCandidates::isQueued() is false, because Freeploy queues no version
// check (no row reads "Checking" while a check waits).
import { md5 } from "../helpers/docker.js";
import { tidyTitle } from "./finding.js";
import { imageName, ImageRef } from "./image-ref.js";
import { keyOf, type ApplicationModel, type ImageScanRow, type ScanData, type ScanOwner, type ScanResource, type ServicePartModel } from "./model.js";
import { dataGet, filled, int, isRecord, lower, phpTrim, record, spaceship, str, versionCompare, type Json } from "./php.js";
import { activeComposeImageOverrides, composeServiceNames, configuredImage, findings, isScanTarget, owners as ownersOf, uncheckedComposeRefs } from "./resource-scans.js";
import type { RelevanceRules } from "./rules.js";
import { EXPLOITED, LIKELY } from "./rules.js";
import { composeServicesValue, type SecurityAction } from "./security-actions.js";
import { attackNote, badge, CHECKING_BADGE, databaseUpdateConfirmation, imageSentence, imagesNeedingUpdate, lines, noFixAdvice, provenance, shortDigest, versionCheckRunning } from "./security-sentences.js";
import { forScan, isBlockedCheck, NOT_SCANNED, primaryOf, REASON_VERSIONS_UNCHECKED, security, type ResourceSecurity, type WhyEntry } from "./security-status.js";
import { candidateStatus } from "./model.js";

export const OTHER_ACTIONS_LIMIT = 5;

/** Image rows, worst first (the order of the team page). */
const ROW_ORDER = ["update_now", "update_available", "no_fix", "check_needed", "ok", "not_checked"];
const PROBLEM_STATUSES = ["update_now", "update_available", "no_fix", "check_needed"];

const DATABASE_NAMES: Record<string, string> = {
  postgresql: "PostgreSQL",
  redis: "Redis",
  mongodb: "MongoDB",
  mysql: "MySQL",
  mariadb: "MariaDB",
  keydb: "KeyDB",
  dragonfly: "Dragonfly",
  clickhouse: "ClickHouse",
};

export interface ButtonData {
  label: string;
  title: string;
  /** The action the confirmation runs: rebuild, updateImage { candidateRef, ownerUuid }, updateImages { actionKey }. */
  submit: { action: "rebuild" } | { action: "updateImage"; candidateRef: string; ownerUuid: string } | { action: "updateImages"; actionKey: string };
  actions: string[];
  warning: string;
}

export interface ActionData {
  key: string;
  type: string;
  sentence: string;
  copy: string | null;
  button: ButtonData | null;
}

export interface WhyData {
  title: string;
  display_id: string;
  link: string | null;
  score: string;
  cvss: string | null;
  cvssNote: string | null;
  severity: string;
  signal: string | null;
  exploited: boolean;
  package: string;
  version: string;
}

export interface ImageRowData {
  key: string;
  name: string | null;
  ref: string;
  status: string;
  checking: boolean;
  badge: string | null;
  badgeType: string;
  open: boolean;
  sentence: string;
  attackNote: string | null;
  advice: string | null;
  lines: string[];
  primary: ActionData | null;
  mergedWith: string | null;
  why: WhyData[];
  whyMore: number;
  provenance: string | null;
  others: ActionData[];
  moreActions: number;
  versionNotes: Array<{ text: string; link: string | null }>;
  filter: string | null;
  override: { service: string; from: string; to: string } | null;
}

export interface CardData {
  status: string;
  checking: boolean;
  badge: string | null;
  badgeType: string;
  header: string | null;
  total: number;
  single: boolean;
  rows: ImageRowData[];
}

/** What the viewer may do: $user->can('update', $resource), can('deploy', $resource), can('update', $server). */
export interface CardViewer {
  canUpdate: boolean;
  canDeploy: boolean;
  canUpdateServer: boolean;
  /** route('server.registries', …) of a server. */
  registriesUrl: (serverUuid: string) => string;
}

const ownerName = (owner: ScanOwner | ScanResource): string => str(("humanName" in owner && filled(owner.humanName) ? owner.humanName : null) ?? owner.name);
const ownerKey = (owner: ScanOwner | ScanResource | null | undefined): string => (owner === null || owner === undefined ? "" : keyOf(owner));

/** SecurityCard::for() */
export function securityCard(
  resource: ScanResource,
  sec: ResourceSecurity,
  data: ScanData,
  scans: readonly ImageScanRow[],
  viewer: CardViewer,
  imageStatuses: ReadonlyMap<string, ResourceSecurity>,
  rulesFor: (owner: ScanOwner) => RelevanceRules,
): CardData {
  const status = sec.status;
  const rows = images(resource, sec, data, scans, viewer, imageStatuses, rulesFor);
  const total = rows.length;
  const needsUpdate = rows.filter((r) => r.status === "update_now" || r.status === "update_available").length;
  const waiting = rows.filter((r) => r.status === "check_needed");
  const checking = status === "check_needed" && waiting.length > 0 && waiting.every((r) => r.checking);
  return {
    status,
    checking,
    badge: checking ? CHECKING_BADGE : badge(status),
    badgeType: badgeType(status),
    header: total > 1 ? imagesNeedingUpdate(needsUpdate, total) : null,
    total,
    single: total === 1,
    rows,
  };
}

interface Entry {
  key: string;
  scan: ImageScanRow | null;
  owner: ScanOwner;
  ref: string;
  name: string | null;
  security: ResourceSecurity;
}

/** SecurityCard::images() */
export function images(
  resource: ScanResource,
  sec: ResourceSecurity,
  data: ScanData,
  scans: readonly ImageScanRow[],
  viewer: CardViewer,
  imageStatuses: ReadonlyMap<string, ResourceSecurity>,
  rulesFor: (owner: ScanOwner) => RelevanceRules,
): ImageRowData[] {
  const isService = resource.kind === "service";
  const owners = ownersOf(resource);
  const statusOwners = isService ? owners.filter((o) => isScanTarget(o)) : owners;
  const isStatusOwner = (owner: ScanOwner | null | undefined) => owner !== null && owner !== undefined && statusOwners.some((c) => keyOf(c) === keyOf(owner));

  const digests: Record<string, string | null> = {};
  for (const scan of scans) {
    const k = ownerKey(data.owners.get(scan.id));
    if (!(k in digests)) digests[k] = shortDigest(filled(scan.repoDigest) ? scan.repoDigest : scan.imageId);
  }

  const notChecked = security("not_checked", { checkReason: NOT_SCANNED });
  const composeServices = resource.kind === "application" ? composeServiceNames(resource) : new Map<string, string>();
  const entries: Entry[] = [];
  for (const scan of scans) {
    const owner = data.owners.get(scan.id)!;
    if (isService && !isStatusOwner(owner)) continue;
    entries.push({
      key: `scan-${scan.uuid}`,
      scan,
      owner,
      ref: scan.imageRef,
      name: isService ? ownerName(owner) : (composeServices.get(imageName(scan.imageRef)) ?? null),
      security: imageStatuses.get(scan.uuid) ?? forScan(scan, data, rulesFor(owner)),
    });
  }
  for (const owner of statusOwners) {
    if (isService && !scans.some((s) => keyOf(data.owners.get(s.id) ?? { morphClass: "", id: -1 }) === keyOf(owner))) {
      entries.push({ key: `owner-${owner.uuid}`, scan: null, owner, ref: configuredImage(owner, data), name: ownerName(owner), security: notChecked });
    }
  }
  if (resource.kind === "application") {
    for (const image of uncheckedComposeRefs(resource, scans, data)) {
      entries.push({ key: `compose-${md5(image.name ?? image.ref)}`, scan: null, owner: resource, ref: image.ref, name: image.name, security: notChecked });
    }
  }

  const rank = (s: string) => ROW_ORDER.indexOf(s);
  const ordered = entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => spaceship([rank(a.e.security.status), lower(str(a.e.name)), a.e.ref], [rank(b.e.security.status), lower(str(b.e.name)), b.e.ref]) || a.i - b.i)
    .map(({ e }) => e);

  const merged = sec.actions.filter((a) => a.parts.length > 0);
  const mergedStats: Record<string, Record<string, unknown>> = {};
  sec.actions.forEach((a, index) => {
    if (a.parts.length > 0) mergedStats[actionKey(a)] = record(dataGet(sec.facts, `action_stats.${index}`, {}));
  });
  const groupFirst: Record<string, string> = {};
  const single = ordered.length === 1;
  const noun = resource.kind === "application" ? "this app" : resource.kind === "service" ? "this service" : "this database";
  const composeOverrides = resource.kind === "application" && resource.buildPack === "dockercompose" ? activeComposeImageOverrides(resource, composeServicesValue(resource)) : new Map<string, { from: string; to: string }>();
  let opened = false;
  const rows: ImageRowData[] = [];
  for (const entry of ordered) {
    const imageSecurity = entry.security;
    const { scan, owner, ref, name } = entry;
    const st = imageSecurity.status;
    const showsActions = st === "update_now" || st === "update_available";

    const actions: ActionData[] = [];
    if (showsActions) {
      imageSecurity.actions.forEach((a, index) => {
        actions.push(action(resource, a, record(dataGet(imageSecurity.facts, `action_stats.${index}`, {})), data, viewer, digests));
      });
    }

    const primaryAction = showsActions ? primaryOf(imageSecurity) : null;
    let primary: ActionData | null = actions[0] ?? null;
    let mergedWith: string | null = null;
    const group = primaryAction === null ? null : mergedGroup(merged, primaryAction, owner);
    if (group !== null) {
      const groupKey = actionKey(group);
      if (groupKey in groupFirst) {
        mergedWith = groupFirst[groupKey]!;
        primary = null;
      } else {
        groupFirst[groupKey] = name ?? ref;
        primary = action(resource, group, mergedStats[groupKey] ?? {}, data, viewer, digests);
      }
    }

    const open: boolean = single || (!opened && PROBLEM_STATUSES.includes(st));
    opened = opened || open;
    const others = actions.slice(1);
    // RefreshCandidates::isQueued(): Freeploy queues no version check.
    const checking = st === "check_needed" && scan !== null && imageSecurity.checkReason === REASON_VERSIONS_UNCHECKED && isQueued(scan);
    const withWhy = st === "update_now" || st === "update_available" || st === "no_fix";

    rows.push({
      key: entry.key,
      name,
      ref,
      status: st,
      checking,
      badge: checking ? CHECKING_BADGE : badge(st),
      badgeType: badgeType(st),
      open,
      sentence: checking ? versionCheckRunning(ref, scan, data) : imageSentence(imageSecurity, ref, data.now, scan, data),
      attackNote: attackNote(imageSecurity),
      advice: noFixAdvice(imageSecurity, noun),
      lines: [...lines(imageSecurity), ...eolLine(imageSecurity)],
      primary,
      mergedWith,
      why: withWhy ? imageSecurity.why.map(whyRow) : [],
      whyMore: showsActions ? Math.max(0, imageSecurity.moreFixed) : 0,
      provenance: scan === null || !withWhy ? null : provenance(scan, primaryAction, imageSecurity, data.now, provenanceCounts(scan, primaryAction)),
      others: others.slice(0, OTHER_ACTIONS_LIMIT),
      moreActions: Math.max(0, others.length - OTHER_ACTIONS_LIMIT),
      versionNotes: scan === null ? [] : versionCheckNotes([scan], data, viewer),
      filter: single ? null : ref,
      override: name !== null && composeOverrides.has(name) ? { service: name, ...composeOverrides.get(name)! } : null,
    });
  }
  return rows;
}

/** RefreshCandidates::isQueued(): a version check waits in the queue. Freeploy queues none. */
export const isQueued = (_scan: ImageScanRow): boolean => false;

const badgeType = (status: string): string => (status === "update_now" ? "error" : status === "update_available" ? "warning" : "neutral");

/** The severity of a CVSS base score: 9.0 critical, 7.0 high, 4.0 medium, 0.1 low. */
export function cvssSeverity(score: number): string {
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "high";
  if (score >= 4.0) return "medium";
  if (score > 0.0) return "low";
  return "unknown";
}

const ucfirst = (s: string): string => (s === "" ? s : s[0]!.toUpperCase() + s.slice(1));
/** number_format($score, 1) (scores are below 1,000). */
const oneDecimal = (n: number): string => n.toFixed(1);

/** A why row: the score next to the badge only when its CVSS range has the same severity, else only in the tooltip. */
function whyRow(why: WhyEntry): WhyData {
  const severity = lower(str(why.severity ?? "unknown"));
  const cvss = why.score === null ? null : oneDecimal(why.score);
  const matches = cvss !== null && cvssSeverity(why.score!) === severity;
  return {
    title: tidyTitle(str(why.title)),
    display_id: str(why.display_id),
    link: why.link,
    score: why.score === null ? "No score" : `${oneDecimal(why.score)} ${ucfirst(str(why.severity))}`,
    cvss: matches ? cvss : null,
    cvssNote: cvss === null ? null : `CVSS ${cvss}`,
    severity,
    signal: why.signal === EXPLOITED ? "Used by attackers" : why.signal === LIKELY ? "Likely to be exploited" : null,
    exploited: why.signal === EXPLOITED,
    package: str(why.package ?? ""),
    version: str(why.version ?? ""),
  };
}

/** The merged service update (from the status of the resource) that contains this image's update. */
function mergedGroup(merged: readonly SecurityAction[], a: SecurityAction, owner: ScanOwner): SecurityAction | null {
  if (a.type !== "update_image") return null;
  for (const group of merged) {
    for (const part of group.parts) {
      if (part.owner_type === owner.morphClass && String(part.owner_id) === String(owner.id) && part.ref === a.ref) return group;
    }
  }
  return null;
}

/** The first fixed version of a package upgrade, for the provenance line. */
function provenanceCounts(scan: ImageScanRow, a: SecurityAction | null): { fixed_in?: string | null } {
  if (a === null || !(a.type === "upgrade_package" || a.type === "upgrade_in_dockerfile")) return {};
  const ids = new Set(a.fixedIds.map(lower));
  let fixedIn: string | null = null;
  const ltrimV = (s: string) => s.replace(/^[vV]+/, "");
  for (const f of findings(scan)) {
    if (f.package === a.target && ids.has(lower(f.id)) && filled(f.fixedIn) && (fixedIn === null || versionCompare(ltrimV(str(f.fixedIn)), ltrimV(fixedIn)) > 0)) fixedIn = str(f.fixedIn);
  }
  return { fixed_in: fixedIn };
}

/** RefreshCandidates::message(): what a version check (or the base image's check) found, for the card. */
export function candidateMessage(scan: ImageScanRow, base: boolean, data: ScanData): string | null {
  const result = base ? dataGet(scan.candidates, "base") : scan.candidates;
  const status = isRecord(result) ? (result.status ?? null) : null;
  const image = ImageRef.tryParse(str(base ? scan.baseImageRef : scan.imageRef));
  if (image === null) return null;
  const name = ImageRef.parse(image.qualifiedName()).toString();
  const server = str(data.servers.get(scan.serverId)?.name ?? "the server");
  switch (status) {
    case "no_better":
      return `No newer version of ${name} is better yet. Coolify checks again every day.`;
    case "cannot_compare":
      return "Coolify cannot compare versions of this image. Check the image page for a newer version.";
    case "auth_required":
      return `Coolify cannot read the tags of ${name}. Log in to ${image.registry} on ${server}.`;
    case "failed":
      return dataGet(result, "error") === "daily_limit" ? `Coolify reached the daily limit of version checks on ${server}. It checks again tomorrow.` : `Coolify could not check for newer versions of ${name}. It tries again tomorrow.`;
    default:
      return null;
  }
}

/** Lines for version and base checks that only the user can unblock: a registry login links to the server's registry logins. */
export function versionCheckNotes(scans: readonly ImageScanRow[], data: ScanData, viewer: CardViewer): Array<{ text: string; link: string | null }> {
  const notes = new Map<string, { text: string; link: string | null }>();
  for (const scan of scans) {
    const base = dataGet(scan.candidates, "base");
    const checks: Array<[boolean, unknown, unknown]> = [[false, candidateStatus(scan), dataGet(scan.candidates, "error")]];
    if (filled(scan.baseImageRef) && isRecord(base) && (base.image ?? null) === scan.baseImageRef) checks.push([true, base.status ?? null, base.error ?? null]);
    for (const [isBase, st, error] of checks) {
      if (!isBlockedCheck(st, error)) continue;
      const text = candidateMessage(scan, isBase, data);
      if (text === null || notes.has(text)) continue;
      const server = data.servers.get(scan.serverId) ?? null;
      notes.set(text, { text, link: st === "auth_required" && server !== null && viewer.canUpdateServer ? viewer.registriesUrl(server.uuid) : null });
    }
  }
  return [...notes.values()];
}

/** PHP's json_encode() of the key parts (no slashes escaped here: the key is Freeploy's own). */
function phpJson(value: unknown): string {
  return JSON.stringify(value).replace(/\//g, "\\/").replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** A stable key of an action: its type, the image and candidate, and every part of a merged update. */
export function actionKey(a: SecurityAction): string {
  return md5(phpJson([a.type, a.image, a.ref, a.target, a.parts.map((p) => [String(p.owner_type), String(p.owner_id), String(p.ref)])])).slice(0, 16);
}

/** A Git app can be rebuilt only from a known commit: "HEAD" or no commit would build whatever the branch has now. */
export function knowsRunningCommit(application: ApplicationModel, commit: string | null): boolean {
  const c = phpTrim(str(commit));
  const gitBased = !filled(application.dockerfile) && application.buildPack !== "dockerimage";
  return !gitBased || (c !== "" && c.toUpperCase() !== "HEAD");
}

export function shortCommit(commit: string | null): string {
  const c = phpTrim(str(commit));
  return c === "" ? "HEAD" : [...c].slice(0, 7).join("");
}

/** The end-of-life OS, when the sentence does not say it already. */
function eolLine(s: ResourceSecurity): string[] {
  if (s.eol === null || s.eol.name === "") return [];
  const said = (s.status === "update_now" || s.status === "update_available") && int(dataGet(s.facts, "action_stats.0.eol", 0)) > 0;
  if (said) return [];
  return [`${phpTrim(`This image uses ${ucfirst(s.eol.name)} ${s.eol.version}`)}, which no longer gets security fixes.`];
}

function action(resource: ScanResource, a: SecurityAction, stats: Record<string, unknown>, data: ScanData, viewer: CardViewer, digests: Record<string, string | null>): ActionData {
  return {
    key: actionKey(a),
    type: a.type,
    sentence: a.sentence,
    copy: a.copy,
    button: a.button && resource.id !== 0 ? button(resource, a, stats, data, viewer, digests) : null,
  };
}

function button(resource: ScanResource, a: SecurityAction, stats: Record<string, unknown>, data: ScanData, viewer: CardViewer, digests: Record<string, string | null>): ButtonData | null {
  if (a.type === "rebuild") {
    if (resource.kind !== "application" || !viewer.canDeploy) return null;
    // runningDeployment(): the latest finished deployment that is not a preview.
    if (!data.latestFinishedCommit.has(resource.id)) return null;
    const runningCommit = data.latestFinishedCommit.get(resource.id) ?? null;
    if (!knowsRunningCommit(resource, runningCommit)) return null;
    const commit = shortCommit(runningCommit);
    return {
      label: "Rebuild",
      title: "Rebuild without cache?",
      submit: { action: "rebuild" },
      actions: [`Rebuild commit ${commit} without cache.`, "Redeploy the app."],
      warning: `Coolify rebuilds commit ${commit} without cache and redeploys it.`,
    };
  }
  if (!(a.type === "update_image" || a.type === "pull_latest") || !viewer.canUpdate) return null;
  if (a.parts.length > 0) return mergedButton(resource, a, data, digests);

  const image = str(a.image);
  const ref = str(a.ref);
  if (image === "" || ref === "") return null;
  const owners = ownersOf(resource);
  const owner = resource.kind === "service" ? (owners.find((o) => o.morphClass === (stats.owner_type ?? null) && String(o.id) === String(stats.owner_id ?? "")) ?? null) : resource;
  if (owner === null) return null;
  const ownerUuid = resource.kind === "service" ? owner.uuid : "";
  const submit = { action: "updateImage" as const, candidateRef: ref, ownerUuid };
  const restart = restartLine(resource);

  if (a.type === "pull_latest") {
    return {
      label: "Pull latest and restart",
      title: `Pull the newest build of ${image}?`,
      submit,
      actions: [`Pull the build of ${image} that Coolify scanned.`, restart],
      warning: `Coolify pulls exactly the build that it scanned, not a build pushed after the check. The settings keep ${image}, so later restarts pull its newest build as usual.`,
    };
  }

  const tag = str(a.target);
  const changes =
    resource.kind === "service" ? subResourcesUsing(resource, image).map((sub) => `${ownerName(sub)}: ${change(image, digests[keyOf(sub)] ?? null, ref)}`) : [change(image, digests[keyOf(resource)] ?? null, ref)];
  return { label: `Update to ${tag}`, title: `Update to ${tag}?`, submit, actions: [...changes, restart], warning: updateWarning(resource, image, ref) };
}

/** One confirmation for every image of a merged service update. */
function mergedButton(resource: ScanResource, a: SecurityAction, _data: ScanData, digests: Record<string, string | null>): ButtonData | null {
  if (resource.kind !== "service") return null;
  const changes = new Map<string, string>();
  for (const part of a.parts) {
    const image = str(part.image);
    const ref = str(part.ref);
    if (image === "" || ref === "") return null;
    for (const sub of subResourcesUsing(resource, image)) changes.set(keyOf(sub), `${ownerName(sub)}: ${change(image, digests[keyOf(sub)] ?? null, ref)}`);
  }
  if (changes.size === 0) return null;
  const tag = str(a.target);
  return {
    label: `Update to ${tag}`,
    title: `Update to ${tag}?`,
    submit: { action: "updateImages", actionKey: actionKey(a) },
    actions: [...changes.values(), restartLine(resource)],
    warning: updateWarning(resource, "", ""),
  };
}

/** UpdateResourceImage::subResourcesUsing(): the applications and databases of a service that run this image. */
export function subResourcesUsing(service: Extract<ScanResource, { kind: "service" }>, imageRef: string): ServicePartModel[] {
  const scanned = ImageRef.tryParse(imageRef);
  if (scanned === null) return [];
  return ownersOf(service).filter((sub): sub is ServicePartModel => {
    if (sub.kind !== "serviceApplication" && sub.kind !== "serviceDatabase") return false;
    const image = ImageRef.tryParse(phpTrim(str(sub.image)));
    if (image === null) return false;
    return image.digest === null && scanned.digest === null && image.qualifiedName() === scanned.qualifiedName() && (image.tag ?? "latest") === (scanned.tag ?? "latest");
  });
}

function updateWarning(resource: ScanResource, image: string, ref: string): string {
  if (resource.kind === "service") return "One-click services pin versions that work together. Check the service template before you update.";
  if (resource.kind === "application" && resource.buildPack === "dockercompose") {
    return "Coolify redeploys the app with the new image. Your compose file in Git does not change: Coolify keeps using the new image until the file names another one.";
  }
  if (resource.kind === "application") return "Coolify redeploys the app with the new image.";
  const fromTag = ImageRef.tryParse(image)?.tag ?? null;
  const toTag = ImageRef.tryParse(ref)?.tag ?? null;
  const name = DATABASE_NAMES[resource.engine] ?? null;
  if (name !== null && fromTag !== null && toTag !== null && major(fromTag) !== null && major(fromTag) === major(toTag)) return databaseUpdateConfirmation(name, fromTag, toTag);
  return "Check the release notes. Some updates need a data migration.";
}

/** What restarts. A service restarts every container, so the line names its images. */
function restartLine(resource: ScanResource): string {
  if (resource.kind === "service") {
    const names = ownersOf(resource)
      .map((o) => ownerName(o))
      .filter((n) => filled(n));
    return names.length === 0 ? "Pull the images and restart the service." : `Pull the images and restart the service: ${names.join(", ")}.`;
  }
  return resource.kind === "application" ? "Redeploy the app." : "Restart the database.";
}

/** "postgres:15.0 3f1a2b4c5d6e → postgres:15.13" */
const change = (image: string, digest: string | null, ref: string): string => `${phpTrim(`${image} ${digest ?? ""}`)} → ${ref}`;

function major(tag: string): string | null {
  const m = /^v?(\d+)/i.exec(tag);
  return m === null ? null : m[1]!;
}

export type { Json };
