// Derived from coollabsio/coolify@91b7e3e:app/Services/ImageScan/ImageScanPolicyResolver.php and
// app/Services/ImageScan/ResolvedImageScanPolicy.php, and app/Enums/{ImageScanGateMode,ImageScanOnError}.php
// (Apache-2.0), modified.
//
// Scan rules resolved through Instance, Team, Server and App; a null value inherits. Team and server come from the loaded
// resource. The instance level is the platform's row with no scope (DP-116, migration 740: owned by the nil UUID, read in
// the org's transaction, edited on /settings/image-scanning); until the operator stores it, there is no instance row and
// the resolver's defaults apply, which are the values Coolify's migration seeds it with (gate off, deploy anyway, mediums
// not counted).
import { MORPH, keyOf, type AnyModel, type PolicyRow, type ScanData, type ScanResource, type ScanServer } from "./model.js";

export type GateMode = "off" | "on" | "strict";
export type OnScanError = "deploy" | "block";
export type Source = "instance" | "team" | "server" | "app";

export interface ResolvedImageScanPolicy {
  gateMode: GateMode;
  onScanError: OnScanError;
  scanEnabled: boolean;
  sources: { gate_mode: Source; on_scan_error: Source; count_medium: Source };
  scanServer: ScanServer | null;
  countMedium: boolean;
}

export interface Resolved {
  gate_mode: { value: GateMode; source: Source };
  on_scan_error: { value: OnScanError; source: Source };
  count_medium: { value: boolean; source: Source };
}

export type Level = [Source, PolicyRow | null];

/** ImageScanPolicyResolver::instanceRow() */
export const instanceRow = (data: Pick<ScanData, "instancePolicy">): PolicyRow | null => data.instancePolicy ?? null;

/** The server whose scan settings apply: the destination server, or the server of a service. */
export function mainServerOf(resource: AnyModel): ScanServer | null {
  const owner = resource.kind === "serviceApplication" || resource.kind === "serviceDatabase" ? resource.service : resource;
  if (owner === null) return null;
  let server = owner.kind === "database" || owner.kind === "application" || owner.kind === "service" ? owner.destinationServer : null;
  if (server === null && owner.kind === "service") server = owner.server;
  return server;
}

export function resolveLevels(levels: readonly Level[]): Resolved {
  const resolved: Resolved = {
    gate_mode: { value: "off", source: "instance" },
    on_scan_error: { value: "deploy", source: "instance" },
    count_medium: { value: false, source: "instance" },
  };
  for (const [source, row] of levels) {
    if (row === null) continue;
    if (row.gateMode !== null) resolved.gate_mode = { value: row.gateMode, source };
    if (row.onScanError !== null) resolved.on_scan_error = { value: row.onScanError, source };
    if (row.countMedium !== null) resolved.count_medium = { value: row.countMedium, source };
  }
  return resolved;
}

/** The org's row of the team level, or of a server or an application. */
export const teamRow = (data: Pick<ScanData, "policies">): PolicyRow | null => data.policies.find((p) => p.scopeType === MORPH.team) ?? null;
export const scopeRow = (data: Pick<ScanData, "policies">, morphClass: string, id: number): PolicyRow | null => data.policies.find((p) => p.scopeType === morphClass && p.scopeId === id) ?? null;

function levelsFor(resource: AnyModel, mainServer: ScanServer | null, data: ScanData): Level[] {
  const levels: Level[] = [["instance", instanceRow(data)]];
  // $resource->team(): an application or database of a service without its service has none.
  const hasTeam = !((resource.kind === "serviceApplication" || resource.kind === "serviceDatabase") && resource.service === null);
  if (hasTeam) levels.push(["team", teamRow(data)]);
  if (mainServer !== null) levels.push(["server", scopeRow(data, MORPH.server, mainServer.id)]);
  if (resource.kind === "application") levels.push(["app", scopeRow(data, MORPH.application, resource.id)]);
  return levels;
}

/** ImageScanPolicyResolver::for(): rules through the main destination server; `server` only decides where the image is scanned. */
export function policyFor(resource: AnyModel, data: ScanData, server: ScanServer | null = null): ResolvedImageScanPolicy {
  const mainServer = mainServerOf(resource);
  const scanServer = server ?? mainServer;
  const resolved = resolveLevels(levelsFor(resource, mainServer, data));
  return {
    // Services and databases have no deploy to block.
    gateMode: resource.kind === "application" ? resolved.gate_mode.value : "off",
    onScanError: resolved.on_scan_error.value,
    scanEnabled: offState(resource, scanServer) === null,
    sources: { gate_mode: resolved.gate_mode.source, on_scan_error: resolved.on_scan_error.source, count_medium: resolved.count_medium.source },
    scanServer,
    countMedium: resolved.count_medium.value,
  };
}

/** The "Count medium problems" rule of a resource. */
export function countMediumFor(resource: AnyModel, data: ScanData): boolean {
  return resolveLevels(levelsFor(resource, mainServerOf(resource), data)).count_medium.value;
}

/** countMediumFor() for many resources of the org, keyed by ResourceScans::key(). */
export function countMediumForMany(resources: readonly ScanResource[], data: ScanData): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const resource of resources) {
    const server = mainServerOf(resource);
    const levels: Level[] = [["instance", instanceRow(data)], ["team", teamRow(data)]];
    if (server !== null) levels.push(["server", scopeRow(data, MORPH.server, server.id)]);
    if (resource.kind === "application") levels.push(["app", scopeRow(data, MORPH.application, resource.id)]);
    out[keyOf(resource)] = resolveLevels(levels).count_medium.value;
  }
  return out;
}

/**
 * Why the resource is not scanned now: "server" (scanning is off for its server), "application" (the app turned its scan
 * off), or null when it is scanned. Every surface that shows results uses this rule.
 */
export function offState(resource: AnyModel, scanServer: ScanServer | null = null): "server" | "application" | null {
  const server = scanServer ?? mainServerOf(resource);
  if (server === null || server.isImageScanEnabled !== true) return "server";
  if (resource.kind === "application" && resource.settings?.isImageScanEnabled !== true) return "application";
  return null;
}

/** An app did not turn its scan off. */
export const isAllowedFor = (resource: AnyModel): boolean => resource.kind !== "application" || resource.settings?.isImageScanEnabled === true;

export const isScanOn = (resource: AnyModel): boolean => offState(resource) === null;

/**
 * ImageScanPolicyResolver::inheritedFor($scope) of a team or a server: the values the level inherits from the levels above
 * it, each with the level it comes from (a team: the instance; a server: the instance and its team). An application's
 * is scan-settings.ts' (DP-114), through its main server.
 */
export function inheritedFor(scope: "team" | "server", data: Pick<ScanData, "policies" | "instancePolicy">): Resolved {
  const levels: Level[] = [["instance", instanceRow(data)]];
  if (scope === "server") levels.push(["team", teamRow(data)]);
  return resolveLevels(levels);
}
