// Derived from coollabsio/coolify@91b7e3e:app/Services/ImageScan/ResourceScans.php, app/Traits/HasImageScans.php and
// app/Models/Application.php (activeComposeImageOverrides, composeImageOverride) (Apache-2.0), modified.
//
// The current scan results of a resource: what its Vulnerabilities page, the team page and the API read. A service shows
// the results of its applications and databases. Coolify's queries become filters over the rows of ScanData, with
// PostgreSQL's order where Coolify relies on it (ORDER BY … DESC puts NULLs first).
import { PhpArray, type PhpValue } from "../compose/php.js";
import { SymfonyYamlParseException, symfonyYamlParse } from "../yaml/symfony/index.js";
import { findingFromArray, type Finding } from "./finding.js";
import { ComposeImageVariable, ImageRef, imageName } from "./image-ref.js";
import { keyOf, MORPH, type ApplicationModel, type ImageScanRow, type ScanData, type ScanOwner, type ScanResource, type ServicePartModel } from "./model.js";
import { dataGet, isRecord, list, phpTrim, str, type Json } from "./php.js";
import type { IgnoreMatcher } from "./rules.js";

export const RESOURCE_TYPES = ["application", "service", "database"] as const;
const ADVISORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** The resources that own scan rows: the applications and databases of a service, else the resource itself. */
export function owners(resource: ScanResource): ScanOwner[] {
  return resource.kind === "service" ? [...resource.applications, ...resource.databases] : [resource];
}

/** Whether Coolify scans the image of an application or database of a service, or of a standalone database. */
export function isScanTarget(owner: ScanOwner): boolean {
  const exclude = owner.kind === "serviceApplication" || owner.kind === "serviceDatabase" ? owner.excludeFromStatus : false;
  const image = owner.kind === "application" ? null : owner.image;
  return !exclude && phpTrim(str(image)) !== "";
}

/** The images Coolify scans for a resource without a deployment (HasImageScans: a standalone database, or a service's parts). */
export function scanTargets(resource: ScanResource, data: ScanData): Array<[ScanOwner, string]> {
  const list = resource.kind === "service" ? [...resource.applications, ...resource.databases] : resource.kind === "database" ? [resource] : [];
  return list.filter(isScanTarget).map((owner): [ScanOwner, string] => [owner, configuredImage(owner, data)]);
}

const pgDesc = (a: number | null, b: number | null): number => (a === b ? 0 : a === null ? -1 : b === null ? 1 : b - a);
const time = (d: Date | null): number | null => (d === null ? null : d.getTime());

/** completed, and of no deployment or of a deployment that is not a preview. */
function isCurrentCandidate(scan: ImageScanRow, data: ScanData): boolean {
  if (scan.status !== "completed") return false;
  if (scan.deploymentQueueId === null) return true;
  const deployment = data.deployments.get(scan.deploymentQueueId);
  return deployment !== undefined && deployment.pullRequestId === 0;
}

/**
 * latestFirst(): scans of finished deployments first (the latest first), then scans without a deployment, then scans of
 * deployments that did not finish; each by scan time after that.
 */
function latestFirst(a: ImageScanRow, b: ImageScanRow, data: ScanData): number {
  const group = (s: ImageScanRow) => (s.deploymentQueueId === null ? 1 : data.deployments.get(s.deploymentQueueId)?.status === "finished" ? 0 : 2);
  return group(a) - group(b) || pgDesc(a.deploymentQueueId, b.deploymentQueueId) || pgDesc(time(a.scannedAt), time(b.scannedAt)) || b.id - a.id;
}
const byScanTime = (a: ImageScanRow, b: ImageScanRow): number => pgDesc(time(a.scannedAt), time(b.scannedAt)) || b.id - a.id;

const ownedBy = (scan: ImageScanRow, owner: ScanOwner): boolean => scan.resourceType === owner.morphClass && scan.resourceId === owner.id;

/**
 * The completed scan of the latest deployment that is not a preview, else the latest scan without a deployment. The other
 * images scanned by the same deployment are current too.
 */
export function currentFor(owner: ScanOwner, data: ScanData): ImageScanRow[] {
  const candidates = data.scans.filter((s) => ownedBy(s, owner) && isCurrentCandidate(s, data));
  const latest = [...candidates].sort((a, b) => latestFirst(a, b, data))[0];
  if (latest === undefined) return [];
  const scans = latest.deploymentQueueId === null ? [latest] : candidates.filter((s) => s.deploymentQueueId === latest.deploymentQueueId).sort(byScanTime);
  for (const scan of scans) data.owners.set(scan.id, owner);
  return scans;
}

/** The current scans of every owner of the resource. */
export function current(resource: ScanResource, data: ScanData, ownerList: readonly ScanOwner[] = owners(resource)): ImageScanRow[] {
  return ownerList.flatMap((owner) => currentFor(owner, data));
}

/** Same as owners() for many resources, keyed by key(). */
export function ownersOfMany(resources: readonly ScanResource[]): Map<string, ScanOwner[]> {
  return new Map(resources.map((r) => [keyOf(r), owners(r)]));
}

/** The IDs of the current scans of the given owners. */
export function currentScanIds(ownerList: readonly ScanOwner[], data: ScanData): number[] {
  const ids: number[] = [];
  for (const owner of ownerList) ids.push(...currentFor(owner, data).map((s) => s.id));
  return [...new Set(ids)];
}

/** The current scans of many owners, keyed by key() of the owner, each owner's by scan time (the latest first). */
export function currentForMany(ownerList: readonly ScanOwner[], data: ScanData): Map<string, ImageScanRow[]> {
  const out = new Map<string, ImageScanRow[]>();
  const seen = new Set<string>();
  const all: ImageScanRow[] = [];
  for (const owner of ownerList) {
    if (seen.has(keyOf(owner))) continue;
    seen.add(keyOf(owner));
    all.push(...currentFor(owner, data));
  }
  for (const scan of all.sort(byScanTime)) {
    const key = `${scan.resourceType}:${scan.resourceId}`;
    out.set(key, [...(out.get(key) ?? []), scan]);
  }
  return out;
}

const isCompose = (owner: ScanOwner): owner is ApplicationModel => owner.kind === "application" && owner.buildPack === "dockercompose";

/** The scan rows of these deployments, of applications (deploymentRowsQuery()), in the table's order. */
function deploymentRows(deploymentIds: readonly number[], data: ScanData): ImageScanRow[] {
  return data.scans.filter((s) => s.resourceType === MORPH.application && s.deploymentQueueId !== null && deploymentIds.includes(s.deploymentQueueId)).sort((a, b) => a.id - b.id);
}

/** The number of images of a Compose application without a completed result in its current deployment. */
export function uncheckedComposeImages(owner: ScanOwner, currentScans: readonly ImageScanRow[], data: ScanData, rows?: Map<string, ImageScanRow[]>): number {
  return uncheckedComposeRefs(owner, currentScans, data, rows).length;
}

/**
 * The images of a Compose application without a completed result in its current deployment: rows of that deployment that
 * failed or did not finish, and images of the stored Compose file without a row of it. Images set with a variable are left out.
 */
export function uncheckedComposeRefs(owner: ScanOwner, currentScans: readonly ImageScanRow[], data: ScanData, preloaded?: Map<string, ImageScanRow[]>): Array<{ name: string | null; ref: string }> {
  if (!isCompose(owner)) return [];
  const deploymentId = currentScans[0]?.deploymentQueueId ?? null;
  const rows =
    deploymentId === null ? currentScans : preloaded?.has(keyOf(owner)) === true ? preloaded.get(keyOf(owner))! : deploymentRows([deploymentId], data).filter((s) => s.resourceId === owner.id);
  const images = composeImages(owner);
  const serviceOf = composeServiceNames(owner);
  const unchecked: Array<{ name: string | null; ref: string }> = [];
  const unfinished = deploymentId === null ? [] : rows.filter((row) => row.status !== "completed");
  for (const row of unfinished) unchecked.push({ name: serviceOf.get(imageName(row.imageRef)) ?? null, ref: row.imageRef });
  const rowNames = new Set(rows.map((row) => imageName(row.imageRef)));
  for (const [name, service] of serviceOf) if (!rowNames.has(name)) unchecked.push({ name: service, ref: phpTrim(images.get(service) ?? "") });
  return unchecked;
}

/** The scan rows of the current deployment of each Compose application among the owners, keyed by key(). */
export function composeDeploymentRows(ownerList: readonly ScanOwner[], currentScans: Map<string, ImageScanRow[]>, data: ScanData): Map<string, ImageScanRow[]> {
  const deployments = new Map<string, number>();
  for (const owner of ownerList) {
    if (!isCompose(owner)) continue;
    const id = currentScans.get(keyOf(owner))?.[0]?.deploymentQueueId ?? null;
    if (id !== null) deployments.set(keyOf(owner), id);
  }
  if (deployments.size === 0) return new Map();
  const rows = deploymentRows([...new Set(deployments.values())], data);
  return new Map([...deployments].map(([key, id]) => [key, rows.filter((r) => `${r.resourceType}:${r.resourceId}` === key && r.deploymentQueueId === id)]));
}

/** The Compose service of each image name of the stored Compose file, the first service when several use the image. */
export function composeServiceNames(owner: ScanOwner): Map<string, string> {
  if (!isCompose(owner)) return new Map();
  const serviceOf = new Map<string, string>();
  for (const [service, image] of composeImages(owner)) if (!serviceOf.has(imageName(image))) serviceOf.set(imageName(image), service);
  return serviceOf;
}

const composeImagesCache = new Map<string, Map<string, string>>();
const COMPOSE_IMAGES_CACHE_SIZE = 200;

/** The images of the services of the stored Compose file, keyed by the service name; images set with a variable left out. */
function composeImages(application: ApplicationModel): Map<string, string> {
  const yaml = application.dockerCompose !== null && application.dockerCompose !== "" && application.dockerCompose !== "0" ? application.dockerCompose : str(application.dockerComposeRaw);
  const cached = composeImagesCache.get(yaml);
  if (cached) return cached;
  let images = new Map<string, string>();
  try {
    const compose = symfonyYamlParse(yaml);
    const services = compose instanceof PhpArray ? compose.get("services") : undefined;
    if (services instanceof PhpArray) {
      for (const [name, service] of services) {
        const image = service instanceof PhpArray ? service.get("image") : undefined;
        if (typeof image === "string" && phpTrim(image) !== "" && !image.includes("$")) images.set(String(name), phpTrim(image));
      }
    }
  } catch (e) {
    if (!(e instanceof SymfonyYamlParseException)) throw e;
    images = new Map();
  }
  if (composeImagesCache.size >= COMPOSE_IMAGES_CACHE_SIZE) composeImagesCache.clear();
  composeImagesCache.set(yaml, images);
  return images;
}

/** A key for a resource or scan owner, unique across resource types. */
export { keyOf as key } from "./model.js";

/** The relevant findings of a scan that an action fixes, from its stored security status. */
export const storedFixedCount = (scan: ImageScanRow): number => Number(dataGet(scan.summary, "security.facts.counts.relevant_fixed", 0)) | 0;

/** The summary of a scan before its security status is added: ignored findings, the end-of-life OS, whether the report was cut. */
export function summaryFor(findingList: readonly Finding[], ignores: IgnoreMatcher, eol: Json, truncated: boolean): Record<string, Json> {
  return { ignored: findingList.filter((f) => ignores.matches(f) !== null).length, eol_distro: eol, truncated };
}

const decoded = new WeakMap<ImageScanRow, Finding[]>();

/** The findings of a scan, decoded once per loaded scan. */
export function findings(scan: ImageScanRow): Finding[] {
  let out = decoded.get(scan);
  if (out === undefined) {
    out = list(scan.findings).map((row) => findingFromArray(row));
    decoded.set(scan, out);
  }
  return out;
}

/** Whether the resource now runs another image than the scanned one, from the configuration and the deployments. */
export function runsOtherImage(scan: ImageScanRow, owner: ScanOwner, data: ScanData): boolean {
  if (owner.kind === "application") {
    if (owner.buildPack === "dockercompose") return false;
    if (owner.buildPack === "dockerimage") return !sameImage(dockerImageRef(owner), scan.imageRef);
    return builtCommitChanged(owner, scan, data);
  }
  return !sameImage(configuredImage(owner, data), scan.imageRef);
}

/** The image of a database or of a service's application or database, with the service variable that sets it resolved. */
export function configuredImage(owner: ScanOwner, data: ScanData): string {
  void data;
  const image = phpTrim(str(owner.kind === "application" ? null : owner.image));
  const variable = ComposeImageVariable.parse(image);
  const service = owner.kind === "serviceApplication" || owner.kind === "serviceDatabase" ? (owner as ServicePartModel).service : null;
  if (variable === null || service === null) return image;
  const value = service.variables.get(variable.key);
  return variable.resolve(typeof value === "string" ? value : null) ?? image;
}

/** The image an application runs now, named like the deploy job names it; null when Coolify cannot tell. */
export function currentImageRef(application: ApplicationModel, data: ScanData): string | null {
  let ref: string | null;
  if (application.buildPack === "dockercompose") ref = null;
  else if (application.buildPack === "dockerimage") ref = dockerImageRef(application);
  else if (!(application.dockerfile === null || phpTrim(application.dockerfile) === "")) ref = `${application.dockerRegistryImageName || application.uuid}:latest`;
  else ref = builtImageRef(application, data);
  if (ref === null) return null;
  return ImageRef.tryParse(ref) === null ? null : ref;
}

/** NVD for CVE IDs, GitHub for GHSA IDs, else none. */
export function advisoryUrl(id: string): string | null {
  if (!isAdvisoryId(id)) return null;
  if (id.startsWith("CVE-")) return `https://nvd.nist.gov/vuln/detail/${id}`;
  if (id.startsWith("GHSA-")) return `https://github.com/advisories/${id}`;
  return null;
}

export const isAdvisoryId = (id: string): boolean => ADVISORY_ID_PATTERN.test(id);

/** "low", "medium" or "high" from the EPSS score. */
export function exploitLikelihood(epss: number | null): string | null {
  if (epss === null) return null;
  return epss < 0.1 ? "low" : epss < 0.5 ? "medium" : "high";
}

function dockerImageRef(application: ApplicationModel): string | null {
  const name = phpTrim(str(application.dockerRegistryImageName));
  if (name === "") return null;
  const tag = phpTrim(str(application.dockerRegistryImageTag)) || "latest";
  return tag.startsWith("sha256-") ? `${name}@sha256:${tag.slice("sha256-".length)}` : `${name}:${tag}`;
}

function builtImageRef(application: ApplicationModel, data: ScanData): string | null {
  const commit = latestDeployedCommit(application, data);
  return commit === null ? null : `${application.dockerRegistryImageName || application.uuid}:${[...commit].slice(0, 128).join("")}`;
}

const latestDeployedCommit = (application: ApplicationModel, data: ScanData): string | null => usableCommit(data.latestFinishedCommit.get(application.id) ?? null);

function builtCommitChanged(application: ApplicationModel, scan: ImageScanRow, data: ScanData): boolean {
  const deployed = latestDeployedCommit(application, data);
  const deployment = scan.deploymentQueueId === null ? undefined : data.deployments.get(scan.deploymentQueueId);
  const scanned = usableCommit(deployment?.commit ?? null) ?? ImageRef.tryParse(scan.imageRef)?.tag ?? null;
  if (deployed === null || scanned === null || scanned === "latest") return false;
  return !deployed.startsWith(scanned) && !scanned.startsWith(deployed);
}

function usableCommit(commit: unknown): string | null {
  const c = phpTrim(str(commit));
  return c === "" || c === "HEAD" ? null : c;
}

/** Same repository and tag; a scan of a pinned digest matches any tag of the repository. */
function sameImage(configuredInput: string | null, scannedInput: string): boolean {
  const configured = phpTrim(str(configuredInput));
  const scanned = phpTrim(scannedInput);
  if (configured === "" || scanned === "") return true;
  const running = ImageRef.tryParse(configured);
  const result = ImageRef.tryParse(scanned);
  if (running === null || result === null) return configured === scanned;
  if (running.qualifiedName() !== result.qualifiedName()) return false;
  if (result.digest !== null) return running.digest === null || running.digest === result.digest;
  if (running.digest !== null) return false;
  return (running.tag ?? "latest") === (result.tag ?? "latest");
}

// ── an application's Compose image overrides (Application::activeComposeImageOverrides) ──

/** The overrides that still apply to the compose file, keyed by the service name. */
export function activeComposeImageOverrides(application: ApplicationModel, services: PhpValue | undefined): Map<string, { from: string; to: string }> {
  const active = new Map<string, { from: string; to: string }>();
  const stored = application.dockerComposeImageOverrides;
  if (!isRecord(stored)) return active;
  for (const [serviceName, override] of Object.entries(stored)) {
    const service = services instanceof PhpArray ? services.get(serviceName) : undefined;
    const image = service instanceof PhpArray ? service.get("image") : undefined;
    if (!isRecord(override) || typeof override.from !== "string" || typeof override.to !== "string") continue;
    if (typeof image === "string" && phpTrim(image) === phpTrim(override.from)) active.set(serviceName, { from: override.from, to: override.to });
  }
  return active;
}

