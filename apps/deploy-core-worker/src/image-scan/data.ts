// Derived from coollabsio/coolify@91b7e3e:app/Services/ImageScan/ResourceScans.php (find, loadScanRelations,
// refreshSummaries) and app/Models/BaseModel.php (the image accessor) (Apache-2.0), modified.
//
// The engine's rows, read once per request in the org's transaction (packages/db deploy/image-scans.ts), as the models the
// engine reads: the relations Coolify loads (settings, destination server, a service's parts, a scan's resource) set here.
// A variable value that sets an image is decrypted here; the engine never sees another one.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  findImageScanResource,
  listImageScanDeployments,
  listImageScanIgnores,
  listImageScanPolicies,
  findInstanceImageScanPolicy,
  type ImageScanPolicyRow,
  listImageScanResources,
  listImageScans,
  listImageScanServers,
  listImageScanVariables,
  listLatestFinishedCommits,
  saveImageScanSummary,
  type ImageScanResources,
  type ImageScanServerRow,
  type ImageScanStoredRow,
} from "@saas/db/deploy";
import { sanitizeString } from "../databases/urls.js";
import { ComposeImageVariable } from "./image-ref.js";
import { MORPH, keyOf, type ApplicationModel, type DatabaseModel, type ImageScanRow, type PolicyRow, type ScanData, type ScanOwner, type ScanResource, type ScanServer, type ServiceModel, type ServicePartModel } from "./model.js";
import { isRecord, parseTime, record, type Json } from "./php.js";
import { findings, owners as ownersOf, summaryFor } from "./resource-scans.js";
import { IgnoreMatcher } from "./rules.js";
import { store } from "./security-status.js";

/** Decrypts an environment variable's stored value. */
export type DecryptValue = (stored: string) => Promise<string | null>;

const json = (text: string | null): Json => {
  if (text === null) return null;
  try {
    return JSON.parse(text) as Json;
  } catch {
    return null;
  }
};

const serverOf = (row: ImageScanServerRow | null): ScanServer | null =>
  row === null ? null : { id: Number(row.id), uuid: row.uuid, name: row.name, isImageScanEnabled: row.is_image_scan_enabled, serverMetadata: json(row.server_metadata) };

const environmentOf = (row: { environment_uuid: string | null; project_uuid: string | null }) => (row.environment_uuid === null ? null : { uuid: row.environment_uuid, projectUuid: row.project_uuid });

/** The keys of the variables that set an image: the parts' images, and every `$KEY` of a Compose application's file. */
function variableKeys(images: ReadonlyArray<string | null>): string[] {
  const keys = new Set<string>();
  for (const image of images) {
    const variable = ComposeImageVariable.parse(image ?? "");
    if (variable !== null) keys.add(variable.key);
  }
  return [...keys];
}
const composeKeys = (compose: string | null): string[] => [...new Set([...(compose ?? "").matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!))];

async function variablesOf(tx: SqlExecutor, decrypt: DecryptValue, morphClass: string, id: number, keys: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const row of await listImageScanVariables(tx, morphClass, [id], keys)) {
    if (out.has(row.key)) continue;
    out.set(row.key, row.value === null ? null : await decrypt(row.value));
  }
  return out;
}

/** The models of the rows, in TeamVulnerabilities::resources()'s order: applications, services, databases by engine. */
export async function modelsOf(tx: SqlExecutor, rows: ImageScanResources, decrypt: DecryptValue): Promise<ScanResource[]> {
  const out: ScanResource[] = [];
  for (const a of rows.applications) {
    const keys = a.build_pack === "dockercompose" ? composeKeys(a.docker_compose_raw) : [];
    const model: ApplicationModel = {
      kind: "application",
      morphClass: MORPH.application,
      id: a.id,
      uuid: a.uuid,
      name: a.name,
      buildPack: a.build_pack,
      dockerRegistryImageName: a.docker_registry_image_name,
      dockerRegistryImageTag: a.docker_registry_image_tag,
      dockerfile: a.dockerfile,
      dockerCompose: a.docker_compose,
      dockerComposeRaw: a.docker_compose_raw,
      dockerComposeImageOverrides: json(a.docker_compose_image_overrides),
      composeParsingVersion: a.compose_parsing_version,
      dockerComposeCustomBuildCommand: a.docker_compose_custom_build_command,
      dockerComposeCustomStartCommand: a.docker_compose_custom_start_command,
      settings: a.settings_is_image_scan_enabled === null ? null : { isImageScanEnabled: a.settings_is_image_scan_enabled, isRawComposeDeploymentEnabled: a.settings_is_raw_compose_deployment_enabled === true },
      destinationServer: serverOf(a.destination_server),
      environment: environmentOf(a),
      variables: keys.length === 0 ? new Map() : await variablesOf(tx, decrypt, MORPH.application, a.id, keys),
    };
    out.push(model);
  }
  for (const s of rows.services) {
    const service: ServiceModel = {
      kind: "service",
      morphClass: MORPH.service,
      id: s.id,
      uuid: s.uuid,
      name: s.name,
      destinationServer: serverOf(s.destination_server),
      server: serverOf(s.server),
      environment: environmentOf(s),
      applications: [],
      databases: [],
      variables: new Map(),
    };
    const part = (p: (typeof s.applications)[number]): ServicePartModel => ({
      kind: p.kind,
      morphClass: p.kind === "serviceApplication" ? MORPH.serviceApplication : MORPH.serviceDatabase,
      id: p.id,
      uuid: p.uuid,
      name: p.name,
      humanName: p.human_name,
      image: sanitizeString(p.image),
      excludeFromStatus: p.exclude_from_status === true,
      serviceId: p.service_id,
      service,
    });
    service.applications = s.applications.map(part);
    service.databases = s.databases.map(part);
    const keys = variableKeys([...service.applications, ...service.databases].map((p) => p.image));
    service.variables = keys.length === 0 ? new Map() : await variablesOf(tx, decrypt, MORPH.service, s.id, keys);
    out.push(service);
  }
  for (const d of rows.databases) {
    const model: DatabaseModel = { kind: "database", morphClass: d.morph_class, id: d.id, uuid: d.uuid, name: d.name, engine: d.engine, image: sanitizeString(d.image), destinationServer: serverOf(d.destination_server), environment: environmentOf(d) };
    out.push(model);
  }
  return out;
}

/** ResourceScans::find(): the resource of a resource page, or null. */
export async function findResource(tx: SqlExecutor, type: "application" | "service" | "database", uuid: string, decrypt: DecryptValue): Promise<ScanResource | null> {
  return (await modelsOf(tx, await findImageScanResource(tx, type, uuid), decrypt))[0] ?? null;
}

/** Every resource of the org (TeamVulnerabilities::resources()). */
export async function listResources(tx: SqlExecutor, decrypt: DecryptValue): Promise<ScanResource[]> {
  return modelsOf(tx, await listImageScanResources(tx), decrypt);
}

const scanOf = (r: ImageScanStoredRow): ImageScanRow => ({
  id: Number(r.id),
  uuid: r.uuid,
  serverId: Number(r.server_id),
  imageId: r.image_id,
  repoDigest: r.repo_digest,
  resourceType: r.resource_type,
  resourceId: Number(r.resource_id),
  imageRef: r.image_ref,
  deploymentQueueId: r.deployment_queue_id === null ? null : Number(r.deployment_queue_id),
  status: r.status,
  errorCode: r.error_code,
  errorContext: json(r.error_context),
  summary: json(r.summary),
  findings: json(r.findings),
  candidates: json(r.candidates),
  baseImageRef: r.base_image_ref,
  buildsImage: r.builds_image === true,
  isBaseline: r.is_baseline === true,
  grypeDbBuiltAt: parseTime(r.grype_db_built_at),
  scannedAt: parseTime(r.scanned_at),
});

/** An image_scan_policies row as the engine reads it (ImageScanPolicy's enum and boolean casts). */
export const policyRowOf = (p: ImageScanPolicyRow): PolicyRow => ({
  id: Number(p.id),
  scopeType: p.scope_type,
  scopeId: p.scope_id === null ? null : Number(p.scope_id),
  gateMode: p.gate_mode === "off" || p.gate_mode === "on" || p.gate_mode === "strict" ? p.gate_mode : null,
  onScanError: p.on_scan_error === "deploy" || p.on_scan_error === "block" ? p.on_scan_error : null,
  countMedium: p.count_medium,
});

/** What the engine reads about these resources' scans: the scans of their owners and what those scans name. */
export async function loadScanData(tx: SqlExecutor, resources: readonly ScanResource[], now: Date, withFindings: boolean): Promise<ScanData> {
  const ownerList: ScanOwner[] = resources.flatMap((r) => ownersOf(r));
  const idsByType: Record<string, number[]> = {};
  for (const owner of ownerList) (idsByType[owner.morphClass] ??= []).push(owner.id);
  const scans = (await listImageScans(tx, idsByType, withFindings)).map(scanOf);
  const deploymentIds = [...new Set(scans.map((s) => s.deploymentQueueId).filter((id): id is number => id !== null))];
  const deployments = new Map((await listImageScanDeployments(tx, deploymentIds)).map((d) => [Number(d.id), { id: Number(d.id), applicationId: d.application_id, pullRequestId: Number(d.pull_request_id), forceRebuild: d.force_rebuild === true, commit: d.commit, status: d.status }]));
  const applicationIds = ownerList.filter((o) => o.kind === "application").map((o) => o.id);
  const latestFinishedCommit = new Map((await listLatestFinishedCommits(tx, applicationIds)).map((r) => [Number(r.application_id), r.commit]));
  const ignores = (await listImageScanIgnores(tx)).map((i) => ({
    id: Number(i.id),
    uuid: i.uuid,
    resourceType: i.resource_type,
    resourceId: i.resource_id === null ? null : Number(i.resource_id),
    vulnerabilityId: i.vulnerability_id,
    package: i.package,
    reason: i.reason,
    expiresAt: parseTime(i.expires_at),
    createdAt: parseTime(i.created_at),
  }));
  const policies: PolicyRow[] = (await listImageScanPolicies(tx)).map(policyRowOf);
  // DP-116: the instance level, the platform's row (readable in the org's transaction, migration 740).
  const instance = await findInstanceImageScanPolicy(tx);
  const instancePolicy = instance === null ? null : policyRowOf(instance);
  const servers = new Map((await listImageScanServers(tx, [...new Set(scans.map((s) => s.serverId))])).map((s) => [Number(s.id), serverOf(s)!]));
  const byKey = new Map(ownerList.map((o) => [keyOf(o), o]));
  const owners = new Map<number, ScanOwner>();
  for (const scan of scans) {
    const owner = byKey.get(`${scan.resourceType}:${scan.resourceId}`);
    if (owner !== undefined) owners.set(scan.id, owner);
  }
  return { now, scans, deployments, latestFinishedCommit, ignores, policies, instancePolicy, servers, owners };
}

/** A PHP array as json_encode() writes it: an empty array is `[]`, never `{}`. */
export const phpArrayJson = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => (isRecord(v) && Object.keys(v).length === 0 ? [] : v));

/**
 * ResourceScans::refreshSummaries() of one scan of the org: its summary written again — the ignored findings, the end-of-life
 * OS, the cut report, then SecurityStatus::store() — so that its stored status matches its findings.
 */
export async function refreshScanSummary(tx: SqlExecutor, scanId: number, now: Date, decrypt: DecryptValue): Promise<void> {
  await refreshScanSummaries(tx, [scanId], now, decrypt);
}

/** ResourceScans::refreshSummaries() of these scans of the org, read once (DP-114: after an ignore is added or removed, or a rule changed). */
export async function refreshScanSummaries(tx: SqlExecutor, scanIds: readonly number[], now: Date, decrypt: DecryptValue): Promise<void> {
  if (scanIds.length === 0) return;
  const resources = await listResources(tx, decrypt);
  const data = await loadScanData(tx, resources, now, true);
  for (const scanId of scanIds) {
    const scan = data.scans.find((s) => s.id === scanId);
    const owner = scan === undefined ? undefined : data.owners.get(scan.id);
    if (scan === undefined || owner === undefined) continue;
    const summary = record(scan.summary);
    scan.summary = summaryFor(findings(scan), IgnoreMatcher.forResource(owner, data), isRecord(summary.eol_distro) ? (summary.eol_distro as Json) : null, Boolean(summary.truncated ?? false) && summary.truncated !== "0" && summary.truncated !== 0);
    store(scan, data);
    await saveImageScanSummary(tx, scan.id, phpArrayJson(scan.summary));
  }
}
