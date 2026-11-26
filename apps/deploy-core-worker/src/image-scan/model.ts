// Derived from coollabsio/coolify@91b7e3e:app/Models/ImageScan.php (the casts, candidateEntries, candidateStatus,
// updateCandidates), app/Models/ImageScanIgnore.php, app/Models/ImageScanPolicy.php, app/Enums/{ImageScanStatus,
// ImageScanErrorCode,ImageScanFixState,SecurityStatusType,SecurityActionType}.php and app/Models/Server.php
// (isTransferredAway) (Apache-2.0), modified.
//
// The rows the security status engine reads, as plain objects: what Coolify's models give it through their relations
// (an application's settings and destination server, a service's applications and databases, a scan's resource,
// deployment and server) is loaded once per request (packages/db deploy/image-scans.ts) and carried here, so the engine
// itself is pure. Morph classes are Coolify's class names (Coolify has no morph map), which Freeploy's rows hold too.
import { ImageRef } from "./image-ref.js";
import { dataGet, isRecord, type Json } from "./php.js";

export const MORPH = {
  application: "App\\Models\\Application",
  service: "App\\Models\\Service",
  serviceApplication: "App\\Models\\ServiceApplication",
  serviceDatabase: "App\\Models\\ServiceDatabase",
  team: "App\\Models\\Team",
  server: "App\\Models\\Server",
} as const;

export type SecurityStatusType = "not_checked" | "check_needed" | "update_now" | "update_available" | "no_fix" | "ok";
/** SecurityActionType: the cases in the order the actions are listed. */
export const SECURITY_ACTION_TYPES = ["update_image", "pull_latest", "change_base", "rebuild", "upgrade_in_dockerfile", "upgrade_package", "rebuild_in_ci"] as const;
export type SecurityActionType = (typeof SECURITY_ACTION_TYPES)[number];
export type ImageScanFixState = "fixed" | "no_fix";

export interface ScanServer {
  id: number;
  uuid: string;
  name: string;
  /** server_settings.is_image_scan_enabled; null without a settings row. */
  isImageScanEnabled: boolean | null;
  serverMetadata: unknown;
}

/** Server::isTransferredAway(). */
export const isTransferredAway = (server: ScanServer | null | undefined): boolean => dataGet(server?.serverMetadata, "transfer.status") === "transferred";

export interface EnvironmentRef {
  uuid: string;
  projectUuid: string | null;
}

interface ModelBase {
  morphClass: string;
  id: number;
  uuid: string;
  name: string | null;
}

export interface ApplicationModel extends ModelBase {
  kind: "application";
  buildPack: string | null;
  dockerRegistryImageName: string | null;
  dockerRegistryImageTag: string | null;
  dockerfile: string | null;
  dockerCompose: string | null;
  dockerComposeRaw: string | null;
  dockerComposeImageOverrides: unknown;
  composeParsingVersion: string | null;
  dockerComposeCustomBuildCommand: string | null;
  dockerComposeCustomStartCommand: string | null;
  settings: { isImageScanEnabled: boolean; isRawComposeDeploymentEnabled: boolean } | null;
  destinationServer: ScanServer | null;
  environment: EnvironmentRef | null;
  /** Its environment variables that are not previews, by key (the first of a key), the values decrypted. */
  variables: ReadonlyMap<string, string | null>;
}

export interface ServicePartModel extends ModelBase {
  kind: "serviceApplication" | "serviceDatabase";
  humanName: string | null;
  /** The `image` attribute (BaseModel's accessor: sanitize_string()). */
  image: string | null;
  excludeFromStatus: boolean;
  serviceId: number;
  service: ServiceModel | null;
}

export interface ServiceModel extends ModelBase {
  kind: "service";
  destinationServer: ScanServer | null;
  server: ScanServer | null;
  environment: EnvironmentRef | null;
  applications: ServicePartModel[];
  databases: ServicePartModel[];
  variables: ReadonlyMap<string, string | null>;
}

export interface DatabaseModel extends ModelBase {
  kind: "database";
  engine: string;
  image: string | null;
  destinationServer: ScanServer | null;
  environment: EnvironmentRef | null;
}

/** What owns scan rows: an application, an application or database of a service, a standalone database. */
export type ScanOwner = ApplicationModel | ServicePartModel | DatabaseModel;
/** What a resource page, the team page and the API show: an application, a service, a standalone database. */
export type ScanResource = ApplicationModel | ServiceModel | DatabaseModel;
export type AnyModel = ScanOwner | ServiceModel;

/** ResourceScans::key(): unique across resource types. */
export const keyOf = (m: { morphClass: string; id: number }): string => `${m.morphClass}:${m.id}`;

export interface ImageScanRow {
  id: number;
  uuid: string;
  serverId: number;
  imageId: string;
  repoDigest: string | null;
  resourceType: string;
  resourceId: number;
  imageRef: string;
  deploymentQueueId: number | null;
  status: string | null;
  errorCode: string | null;
  errorContext: Json;
  summary: Json;
  /** Null when the caller did not load them (a list reads only the stored statuses). */
  findings: Json;
  candidates: Json;
  baseImageRef: string | null;
  buildsImage: boolean;
  isBaseline: boolean;
  grypeDbBuiltAt: Date | null;
  scannedAt: Date | null;
}

export interface DeploymentRow {
  id: number;
  applicationId: string;
  pullRequestId: number;
  forceRebuild: boolean;
  commit: string | null;
  status: string;
}

export interface IgnoreRow {
  id: number;
  uuid: string;
  resourceType: string | null;
  resourceId: number | null;
  vulnerabilityId: string | null;
  package: string | null;
  reason: string;
  expiresAt: Date | null;
  createdAt: Date | null;
}

export interface PolicyRow {
  id: number;
  scopeType: string | null;
  scopeId: number | null;
  gateMode: "off" | "on" | "strict" | null;
  onScanError: "deploy" | "block" | null;
  countMedium: boolean | null;
}

/**
 * What the engine reads besides the resources: the request's clock, every scan of the owners concerned, the deployments
 * they name (and the latest finished one of each application), the org's ignores and policies, and the scans' servers.
 * One org's rows: row-level security does what Coolify's team checks do.
 */
export interface ScanData {
  now: Date;
  scans: readonly ImageScanRow[];
  deployments: ReadonlyMap<number, DeploymentRow>;
  /** ApplicationDeploymentQueue: the commit of the latest finished deployment that is not a preview, by application id. */
  latestFinishedCommit: ReadonlyMap<number, string | null>;
  ignores: readonly IgnoreRow[];
  policies: readonly PolicyRow[];
  servers: ReadonlyMap<number, ScanServer>;
  /** The scan owner of each row, set where ResourceScans sets the `resource` relation. */
  owners: Map<number, ScanOwner>;
}

/** $scan->resource. */
export const resourceOf = (scan: ImageScanRow, data: ScanData): ScanOwner | null => data.owners.get(scan.id) ?? null;

/** Entries of `candidates`: written as {status, checked_at, entries}; older rows hold a bare list. */
export function candidateEntries(scan: ImageScanRow): Array<Record<string, Json>> {
  const candidates = scan.candidates;
  if (candidates === null || typeof candidates !== "object") return [];
  const entries = Array.isArray(candidates) ? candidates : (candidates.entries ?? []);
  if (entries === null || typeof entries !== "object") return [];
  return (Array.isArray(entries) ? entries : Object.values(entries)).filter((e): e is Record<string, Json> => typeof e === "object" && e !== null);
}

/** ok, no_better, cannot_compare, auth_required or failed; null before the first check. */
export function candidateStatus(scan: ImageScanRow): string | null {
  const c = scan.candidates;
  const status = isRecord(c) ? (c.status ?? null) : null;
  return typeof status === "string" ? status : null;
}

/** The better candidates: newer tags of the same line first, then a newer build of the same tag. Never a major version. */
export function updateCandidates(scan: ImageScanRow): Array<Record<string, Json>> {
  const current = ImageRef.tryParse(scan.imageRef);
  if (current === null || current.digest !== null) return [];
  const currentTag = current.tag ?? "latest";
  const lineEntries: Array<Record<string, Json>> = [];
  const sameTag: Array<Record<string, Json>> = [];
  for (const entry of candidateEntries(scan)) {
    if (entry.better !== true || typeof entry.ref !== "string") continue;
    const ref = ImageRef.tryParse(entry.ref);
    if (ref === null || ref.qualifiedName() !== current.qualifiedName() || ref.digest !== null || ref.tag === null) continue;
    const kind = entry.kind ?? null;
    if (kind === "line" && ref.tag !== currentTag) lineEntries.push(entry);
    else if (kind === "same_tag" && ref.tag === currentTag) sameTag.push(entry);
  }
  return [...lineEntries, ...sameTag];
}

/** VulnerabilitiesController::SEVERITY_RANK and TeamVulnerabilities::SEVERITY_RANK. */
export const SEVERITY_RANK: Readonly<Record<string, number>> = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 };
