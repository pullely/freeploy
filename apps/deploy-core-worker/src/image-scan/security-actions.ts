// Derived from coollabsio/coolify@91b7e3e:app/Services/ImageScan/SecurityActions.php, app/Services/ImageScan/SecurityAction.php,
// app/Services/ImageScan/BaseImageCheck.php, app/Actions/ImageScan/UpdateResourceImage.php (blockedReason, composeRefusal,
// composeMatches, composeServices, sameImage, variableValue) and app/Actions/ImageScan/RefreshCandidates.php
// (relevantFindings) (Apache-2.0), modified.
//
// Maps each relevant finding of a scanned image to the one action that fixes it, or to none (spec 15.5), from stored data
// only: the findings, the version and base checks in `candidates`, and for a Dockerfile app the latest rebuild without
// cache and the scan before it.
import { PhpArray, type PhpValue } from "../compose/php.js";
import { parseDockerComposeYaml } from "../compose/yaml.js";
import type { Finding } from "./finding.js";
import { ComposeImageVariable, ImageRef } from "./image-ref.js";
import { SECURITY_ACTION_TYPES, isTransferredAway, resourceOf, updateCandidates, type ImageScanFixState, type ImageScanRow, type ScanData, type ScanOwner, type SecurityActionType } from "./model.js";
import { bool, dataGet, filled, int, isRecord, list, lower, phpTrim, str, versionCompare, type Json } from "./php.js";
import { activeComposeImageOverrides, findings, runsOtherImage } from "./resource-scans.js";
import { isRelevant, type RelevanceRules } from "./rules.js";


export const BUILDER_TEXT = "A fix exists, but it reaches this app only with a builder update in a Coolify release. To choose the base image yourself, use the Dockerfile build pack.";
export const COOLIFY_TEXT = "Update Coolify to get a newer version.";
const OS_PACKAGE_TYPES = ["apk", "deb", "rpm"];
const LANGUAGE_PACKAGE_TYPES = ["npm", "python", "go-module", "java-archive", "gem", "php-composer", "rust-crate", "dotnet"];
const BUTTON_TYPES: readonly SecurityActionType[] = ["update_image", "pull_latest", "rebuild"];

export interface SecurityActionPart {
  owner_type: string;
  owner_id: Json;
  image: string | null;
  ref: string | null;
}

/** One action that fixes relevant findings of a scanned image (SecurityAction). */
export interface SecurityAction {
  type: SecurityActionType;
  sentence: string;
  target: string | null;
  copy: string | null;
  fixedIds: string[];
  button: boolean;
  image: string | null;
  ref: string | null;
  parts: SecurityActionPart[];
}

export function actionToArray(a: SecurityAction): Record<string, Json> {
  return {
    type: a.type,
    sentence: a.sentence,
    target: a.target,
    copy: a.copy,
    fixed_ids: a.fixedIds,
    button: a.button,
    image: a.image,
    ref: a.ref,
    parts: a.parts.map((p) => ({ owner_type: p.owner_type, owner_id: p.owner_id, image: p.image, ref: p.ref })),
  };
}

/** SecurityAction::fromArray(): null for data that is not an action. */
export function actionFromArray(data: Record<string, unknown>): SecurityAction | null {
  const type = str(data.type ?? "");
  if (!(SECURITY_ACTION_TYPES as readonly string[]).includes(type)) return null;
  const opt = (v: unknown): string | null => (v === null || v === undefined ? null : str(v));
  return {
    type: type as SecurityActionType,
    sentence: str(data.sentence ?? ""),
    target: opt(data.target),
    copy: opt(data.copy),
    fixedIds: list(data.fixed_ids ?? []).map(str),
    button: bool(data.button ?? false),
    image: opt(data.image),
    ref: opt(data.ref),
    parts: list(data.parts ?? [])
      .filter(isRecord)
      .map((p) => ({
        owner_type: str(dataGet(p, "owner_type", "")),
        owner_id: (dataGet(p, "owner_id") ?? null) as Json,
        image: typeof dataGet(p, "image") === "string" ? (dataGet(p, "image") as string) : null,
        ref: typeof dataGet(p, "ref") === "string" ? (dataGet(p, "ref") as string) : null,
      })),
  };
}

/** third_party: Coolify pulls it. docker_image: an image the team builds itself. dockerfile, compose, builder: Coolify builds it. */
export function imageKind(scan: ImageScanRow, owner: ScanOwner): "third_party" | "docker_image" | "dockerfile" | "compose" | "builder" {
  if (!scan.buildsImage || owner.kind !== "application") return "third_party";
  switch (owner.buildPack) {
    case "dockerimage":
      return "docker_image";
    case "dockerfile":
      return "dockerfile";
    case "dockercompose":
      return "compose";
    default:
      return "builder";
  }
}

/** The fix state of each finding for the findings lists: fixed when an action fixes it or a fixed package version exists. */
export function fixStates(scan: ImageScanRow, rules: RelevanceRules, data: ScanData): (finding: Finding) => ImageScanFixState {
  const byFinding = forScan(scan, rules, data).byFinding;
  return (finding) => (byFinding.has(finding.id) || (finding.fixState === "fixed" && filled(finding.fixedIn)) ? "fixed" : "no_fix");
}

interface Plan {
  type: SecurityActionType;
  ids: string[];
  package: string | null;
  fixedIn: string | null;
  versions: string[];
}

export interface ScanActions {
  actions: SecurityAction[];
  byFinding: Map<string, SecurityAction>;
  eol: SecurityAction | null;
}

interface BetterBase {
  from: string;
  to: string;
  entry: Record<string, Json>;
}

/** SecurityActions::forScan(). */
export function forScan(scan: ImageScanRow, rules: RelevanceRules, data: ScanData): ScanActions {
  const owner = resourceOf(scan, data);
  if (owner === null) return { actions: [], byFinding: new Map(), eol: null };
  const kind = imageKind(scan, owner);
  const [lineCandidate, sameTagCandidate] = kind === "third_party" || kind === "docker_image" ? imageCandidates(scan) : [null, null];
  const base = kind === "dockerfile" ? betterBase(scan) : null;
  const fromBaseOrNull = kind === "dockerfile" ? baseIds(scan) : new Set<string>();
  const originKnown = fromBaseOrNull !== null;
  const fromBase = fromBaseOrNull ?? new Set<string>();
  const lineFixed = idSet(list(lineCandidate?.fixed_ids ?? []));
  const sameTagFixed = idSet(list(sameTagCandidate?.fixed_ids ?? []));
  const baseFixed = idSet(list(base?.entry.fixed_ids ?? []));
  let beforeRebuild: Set<string> | null = null;

  const plans = new Map<string, Plan>();
  const byFindingKey = new Map<string, string>();
  for (const finding of findings(scan)) {
    if (!isRelevant(finding, rules)) continue;
    const ids = idsOf(finding);
    const type = lower(finding.type);
    const hasFix = finding.fixState === "fixed" && filled(finding.fixedIn);
    const isOs = OS_PACKAGE_TYPES.includes(type);
    const isFromBase = hits(ids, fromBase);
    const isPackageFix = hasFix && originKnown && !isFromBase && LANGUAGE_PACKAGE_TYPES.includes(type);

    let action: SecurityActionType | null = null;
    if (hits(ids, lineFixed)) action = "update_image";
    else if (hits(ids, sameTagFixed)) action = "pull_latest";
    else if (isFromBase && hits(ids, baseFixed)) action = "change_base";
    else if (kind === "dockerfile" && isOs && hasFix && originKnown && !isFromBase) {
      beforeRebuild ??= idsBeforeForcedRebuild(scan, owner, data);
      action = hits(ids, beforeRebuild) ? "upgrade_in_dockerfile" : "rebuild";
    } else if (kind !== "third_party" && isPackageFix) action = "upgrade_package";
    else if (kind === "docker_image" && isOs && hasFix) action = "rebuild_in_ci";
    if (action === null) continue;

    const perPackage = action === "upgrade_package" || action === "upgrade_in_dockerfile";
    const key = action + (perPackage ? `:${type}|${finding.package}` : "");
    let plan = plans.get(key);
    if (plan === undefined) {
      plan = { type: action, ids: [], package: perPackage ? finding.package : null, fixedIn: null, versions: [] };
      plans.set(key, plan);
    }
    if (!plan.ids.includes(finding.id)) plan.ids.push(finding.id);
    if (perPackage) {
      plan.fixedIn = higher(plan.fixedIn, str(finding.fixedIn));
      plan.versions.push(finding.version);
    }
    if (!byFindingKey.has(finding.id)) byFindingKey.set(finding.id, key);
  }

  let eolKey: string | null = null;
  if (isRecord(dataGet(scan.summary, "eol_distro"))) {
    const empty = (v: Json | undefined) => v === undefined || v === null || v === false || v === 0 || v === "" || v === "0" || (Array.isArray(v) && v.length === 0);
    const eolType: SecurityActionType | null =
      lineCandidate !== null && empty(lineCandidate.eol)
        ? "update_image"
        : sameTagCandidate !== null && empty(sameTagCandidate.eol)
          ? "pull_latest"
          : base !== null && empty(base.entry.eol)
            ? "change_base"
            : null;
    if (eolType !== null) {
      eolKey = eolType;
      if (!plans.has(eolKey)) plans.set(eolKey, { type: eolType, ids: [], package: null, fixedIn: null, versions: [] });
    }
  }

  const order = (t: SecurityActionType) => SECURITY_ACTION_TYPES.indexOf(t);
  const sorted = [...plans.entries()].sort(([, a], [, b]) => order(a.type) - order(b.type));
  const coolify = isCoolifyResource(owner);
  const server = data.servers.get(scan.serverId) ?? null;
  const context: ActionContext = {
    image: scan.imageRef,
    coolify,
    compose: owner.kind === "application" && owner.buildPack === "dockercompose",
    buttons: !coolify && !isTransferredAway(server),
    switchBlocked: lineCandidate !== null || sameTagCandidate !== null ? blockedReason(scan, owner, data) !== null : false,
    line: lineCandidate,
    sameTag: sameTagCandidate,
    base,
  };
  const actions = new Map(sorted.map(([key, plan]) => [key, actionOf(plan, context)]));
  return {
    actions: [...actions.values()],
    byFinding: new Map([...byFindingKey].map(([id, key]) => [id, actions.get(key)!])),
    eol: eolKey === null ? null : actions.get(eolKey)!,
  };
}

interface ActionContext {
  image: string | null;
  coolify: boolean;
  compose: boolean;
  buttons: boolean;
  switchBlocked: boolean;
  line: Record<string, Json> | null;
  sameTag: Record<string, Json> | null;
  base: BetterBase | null;
}

function actionOf(plan: Plan, context: ActionContext): SecurityAction {
  const type = plan.type;
  const pkg = str(plan.package);
  const fixedIn = str(plan.fixedIn);
  const candidate = type === "update_image" ? context.line : type === "pull_latest" ? context.sameTag : null;
  const ref = candidate === null ? null : str(candidate.ref);
  const tag = ref === null ? null : ImageRef.parse(ref).tag;
  const newBase = type === "change_base" ? str(context.base!.to) : null;

  let sentence: string;
  switch (type) {
    case "update_image":
      sentence = context.coolify ? COOLIFY_TEXT : context.compose && context.switchBlocked ? `Change the version to ${tag ?? ""} in the compose file of this app, then redeploy.` : `Update to ${tag ?? ""}.`;
      break;
    case "pull_latest":
      sentence = context.coolify
        ? COOLIFY_TEXT
        : context.compose && context.switchBlocked
          ? "A newer build of this image fixes it. Redeploy this app to pull it."
          : context.compose
            ? `Pull the newer build of ${ref ?? context.image ?? "this image"} and redeploy.`
            : `Pull the newer build of ${ref ?? context.image ?? "this image"} and restart.`;
      break;
    case "change_base":
      sentence = `Change the base image to ${newBase} in your Dockerfile, then redeploy.`;
      break;
    case "rebuild":
      sentence = "Rebuild without cache to get the fixed system packages.";
      break;
    case "upgrade_in_dockerfile":
      sentence = `Upgrade ${pkg} to ${fixedIn} or later in your Dockerfile.`;
      break;
    case "upgrade_package":
      sentence = `Upgrade ${pkg} to ${fixedIn} or later, then redeploy.` + (changesMajor(plan.versions, fixedIn) ? " This is a major version change. Check for breaking changes." : "");
      break;
    case "rebuild_in_ci":
      sentence = "Rebuild the image in your CI, then redeploy.";
      break;
  }
  return {
    type,
    sentence,
    target: type === "update_image" || type === "pull_latest" ? tag : type === "change_base" ? newBase : type === "upgrade_package" || type === "upgrade_in_dockerfile" ? pkg : null,
    copy: type === "change_base" ? `FROM ${newBase}` : type === "upgrade_package" ? `${pkg} ${fixedIn}` : null,
    fixedIds: plan.ids,
    button: BUTTON_TYPES.includes(type) && context.buttons && (type === "rebuild" || !context.switchBlocked),
    image: context.image,
    ref,
    parts: [],
  };
}

/** The better newer tag of the same line and the better newer build of the same tag. */
function imageCandidates(scan: ImageScanRow): [Record<string, Json> | null, Record<string, Json> | null] {
  const candidates = updateCandidates(scan);
  return [candidates.find((e) => e.kind === "line") ?? null, candidates.find((e) => e.kind === "same_tag") ?? null];
}

/** The relevant findings the current base image has too; empty without a base image; null while unknown. */
function baseIds(scan: ImageScanRow): Set<string> | null {
  if (scan.baseImageRef === null || phpTrim(scan.baseImageRef) === "") return new Set();
  const base = dataGet(scan.candidates, "base");
  if (!isRecord(base) || (base.image ?? null) !== scan.baseImageRef || !Number.isInteger(base.attributable)) return null;
  return idSet(list(base.attributable_ids ?? []));
}

/** The IDs that survived the latest rebuild without cache of the app (up to this scan). */
function idsBeforeForcedRebuild(scan: ImageScanRow, owner: ScanOwner, data: ScanData): Set<string> {
  if (owner.kind !== "application") return new Set();
  const scans = data.scans.filter((s) => s.resourceType === owner.morphClass && s.resourceId === owner.id && s.status === "completed").sort((a, b) => b.id - a.id);
  const rebuilt = scans.find((s) => {
    if (s.id > scan.id || s.deploymentQueueId === null) return false;
    const d = data.deployments.get(s.deploymentQueueId);
    return d !== undefined && d.pullRequestId === 0 && d.forceRebuild;
  });
  if (rebuilt === undefined) return new Set();
  const previous = scans.find((s) => {
    if (s.id >= rebuilt.id) return false;
    if (s.deploymentQueueId === null) return true;
    const d = data.deployments.get(s.deploymentQueueId);
    return d !== undefined && d.pullRequestId === 0;
  });
  if (previous === undefined) return new Set();
  const before = idSet(findings(previous).flatMap(idsOf));
  const survived: string[] = [];
  for (const finding of findings(rebuilt)) {
    const ids = idsOf(finding);
    if (hits(ids, before)) survived.push(...ids);
  }
  return idSet(survived);
}

function isCoolifyResource(owner: ScanOwner): boolean {
  if (owner.id === 0) return true;
  if (owner.kind !== "serviceApplication" && owner.kind !== "serviceDatabase") return false;
  const serviceId = owner.service?.id ?? owner.serviceId;
  return serviceId === 0;
}

/** The higher of two fixed versions (a leading `v` ignored); a version is preferred to a value that is not one. */
function higher(current: string | null, candidate: string): string {
  if (current === null) return candidate;
  const a = current.replace(/^v/i, "");
  const b = candidate.replace(/^v/i, "");
  const aIsVersion = /^\d/.test(a);
  const bIsVersion = /^\d/.test(b);
  if (!aIsVersion || !bIsVersion) return bIsVersion ? candidate : current;
  return versionCompare(b, a) > 0 ? candidate : current;
}

function changesMajor(versions: readonly string[], fixedIn: string): boolean {
  const target = major(fixedIn);
  return target !== null && versions.some((version) => {
    const m = major(version);
    return m !== null && m !== target;
  });
}

function major(version: string): number | null {
  const m = /^v?(\d+)/i.exec(version);
  return m ? int(m[1]) : null;
}

export const idsOf = (finding: Finding): string[] => [finding.id, ...finding.aliases].map(lower).filter((id) => id !== "");

function idSet(ids: readonly unknown[]): Set<string> {
  const set = new Set<string>();
  for (const id of ids) if (typeof id === "string" && id !== "") set.add(lower(id));
  return set;
}

const hits = (ids: readonly string[], set: ReadonlySet<string>): boolean => ids.some((id) => set.has(id));

// ── BaseImageCheck ──────────────────────────────────────────────────────────

/** The better `line` candidate of the base check, when the check is for the current base image and the candidate is a newer tag of it. */
export function betterBase(scan: ImageScanRow): BetterBase | null {
  const from = str(scan.baseImageRef);
  const base = dataGet(scan.candidates, "base");
  if (from === "" || !isRecord(base) || (base.status ?? null) !== "ok" || (base.image ?? null) !== from) return null;
  const entries = Array.isArray(base.entries) ? base.entries : isRecord(base.entries) ? Object.values(base.entries) : [];
  const entry = entries.find((e): e is Record<string, Json> => isRecord(e) && (e.kind ?? null) === "line" && e.better === true && typeof e.ref === "string");
  if (entry === undefined) return null;
  const currentRef = ImageRef.tryParse(from);
  const candidate = ImageRef.tryParse(entry.ref as string);
  if (currentRef === null || candidate === null) return null;
  if (currentRef.tag === null || currentRef.digest !== null || candidate.tag === null || candidate.tag === currentRef.tag || candidate.qualifiedName() !== currentRef.qualifiedName()) return null;
  return { from, to: `${from.slice(0, Math.max(0, from.lastIndexOf(":")))}:${candidate.tag}`, entry };
}

/** RefreshCandidates::relevantFindings(). */
export const relevantFindings = (scan: ImageScanRow, rules: RelevanceRules): Finding[] => findings(scan).filter((f) => isRelevant(f, rules));

/** A better base image for the final FROM: of the relevant findings the current base has too (total), how many the newer tag fixes. */
export function baseImage(scan: ImageScanRow, rules: RelevanceRules, data: ScanData): { from: string; to: string; fixed: number; total: number } | null {
  const better = betterBase(scan);
  if (better === null || resourceOf(scan, data) === null) return null;
  const base = dataGet(scan.candidates, "base");
  const attributableIds = idSet(list(isRecord(base) ? base.attributable_ids : []).map(str));
  const fixedIds = idSet(list(better.entry.fixed_ids ?? []).map(str));
  const has = (f: Finding, ids: Set<string>) => [f.id, ...f.aliases].some((id) => ids.has(lower(id)));
  const attributable = relevantFindings(scan, rules).filter((f) => has(f, attributableIds));
  const fixed = attributable.filter((f) => has(f, fixedIds)).length;
  if (attributable.length === 0 || fixed === 0) return null;
  return { from: better.from, to: better.to, fixed, total: attributable.length };
}

// ── UpdateResourceImage::blockedReason() ────────────────────────────────────

const NO_COMPOSE_SERVICE = "No service of the compose file runs this image in a way Coolify can change. Change the version in the compose file.";

class ImageUpdateRefused extends Error {}

/** Why Coolify cannot switch the image of this scan (the reason its update has no button), or null. */
export function blockedReason(scan: ImageScanRow, owner: ScanOwner, data: ScanData): string | null {
  if (owner.kind === "application" && owner.buildPack === "dockercompose") {
    const refused = composeRefusal(owner);
    if (refused !== null) return refused;
    try {
      if (composeMatches(owner, composeServices(owner), activeComposeImageOverrides(owner, composeServicesValue(owner)), scan.imageRef).length === 0) return NO_COMPOSE_SERVICE;
    } catch (e) {
      if (e instanceof ImageUpdateRefused) return e.message;
      throw e;
    }
  }
  const image = str(owner.kind === "application" ? null : owner.image);
  if (ComposeImageVariable.hasVariable(image) && ComposeImageVariable.parse(image) === null) return "The compose file sets this image in a way Coolify cannot change. Change the version in the compose file.";
  if (runsOtherImage(scan, owner, data)) return "The running image is not the scanned image. Scan it again to check for newer versions.";
  return null;
}

function composeRefusal(application: Extract<ScanOwner, { kind: "application" }>): string | null {
  if (application.settings?.isRawComposeDeploymentEnabled) return "This app deploys its compose file as written. Change the version in the compose file, then redeploy.";
  if (int(application.composeParsingVersion) < 3) return "Change the version in the compose file of this app, then redeploy.";
  if (filled(application.dockerComposeCustomBuildCommand)) return "This app uses a custom build command, so Coolify cannot choose the image. Change the image in your compose file.";
  if (filled(application.dockerComposeCustomStartCommand)) return "This app uses a custom start command, so Coolify cannot choose the image. Change the image in your compose file.";
  return null;
}

/** data_get(parseDockerComposeYaml($docker_compose_raw), 'services', []), or undefined when it does not parse. */
function composeServicesValue(application: Extract<ScanOwner, { kind: "application" }>): PhpValue | undefined {
  try {
    const compose = parseDockerComposeYaml(str(application.dockerComposeRaw));
    return compose instanceof PhpArray ? compose.get("services") : undefined;
  } catch {
    return undefined;
  }
}

/** The images of the services of the compose file from Git, as written, keyed by the service name. */
function composeServices(application: Extract<ScanOwner, { kind: "application" }>): Map<string, string> {
  let services: PhpValue | undefined;
  try {
    const compose = parseDockerComposeYaml(str(application.dockerComposeRaw));
    services = compose instanceof PhpArray ? compose.get("services") : undefined;
  } catch {
    services = undefined;
  }
  if (!(services instanceof PhpArray)) throw new ImageUpdateRefused("The compose file of this app is not valid.");
  const images = new Map<string, string>();
  for (const [name, service] of services) {
    const image = service instanceof PhpArray ? service.get("image") : undefined;
    if (typeof image === "string" && phpTrim(image) !== "") images.set(String(name), phpTrim(image));
  }
  return images;
}

/** The services that run the image in a way Coolify can change: an image line (or its override), or a variable that sets it. */
function composeMatches(application: Extract<ScanOwner, { kind: "application" }>, services: Map<string, string>, overrides: Map<string, { from: string; to: string }>, imageRef: string): string[] {
  const matches: string[] = [];
  for (const [name, image] of services) {
    const variable = ComposeImageVariable.parse(image);
    let currentImage: string | null;
    if (variable !== null) {
      const value = application.variables.get(variable.key);
      currentImage = variable.resolve(value === undefined || value === null ? null : String(value));
    } else currentImage = ComposeImageVariable.hasVariable(image) ? null : (overrides.get(name)?.to ?? image);
    if (currentImage !== null && sameTagImage(currentImage, imageRef)) matches.push(name);
  }
  return matches;
}

function sameTagImage(a: string, b: string): boolean {
  const first = ImageRef.tryParse(phpTrim(a));
  const second = ImageRef.tryParse(phpTrim(b));
  if (first === null || second === null) return false;
  return first.digest === null && second.digest === null && first.qualifiedName() === second.qualifiedName() && (first.tag ?? "latest") === (second.tag ?? "latest");
}

