// Derived from coollabsio/coolify@91b7e3e:app/Services/ImageScan/ImageScanPolicyResolver.php and
// app/Services/ImageScan/ResolvedImageScanPolicy.php, and app/Enums/{ImageScanGateMode,ImageScanOnError}.php
// (Apache-2.0), modified.
//
// Scan rules resolved through Instance, Team, Server and App; a null value inherits. Team and server come from the loaded
// resource. Freeploy has no instance-wide row of its own: the instance level is Coolify's seeded row (gate off, deploy
// anyway, mediums not counted), which is also the resolver's default, so only the org's team, server and app rows are read.
import { MORPH, keyOf, type AnyModel, type PolicyRow, type ScanData, type ScanResource, type ScanServer } from "./model.js";

export type GateMode = "off" | "on" | "strict";
export type OnScanError = "deploy" | "block";
type Source = "instance" | "team" | "server" | "app";

export interface ResolvedImageScanPolicy {
  gateMode: GateMode;
  onScanError: OnScanError;
  scanEnabled: boolean;
  sources: { gate_mode: Source; on_scan_error: Source; count_medium: Source };
  scanServer: ScanServer | null;
  countMedium: boolean;
}

interface Resolved {
  gate_mode: { value: GateMode; source: Source };
  on_scan_error: { value: OnScanError; source: Source };
  count_medium: { value: boolean; source: Source };
}

type Level = [Source, PolicyRow | null];

/** The server whose scan settings apply: the destination server, or the server of a service. */
export function mainServerOf(resource: AnyModel): ScanServer | null {
  const owner = resource.kind === "serviceApplication" || resource.kind === "serviceDatabase" ? resource.service : resource;
  if (owner === null) return null;
  let server = owner.kind === "database" || owner.kind === "application" || owner.kind === "service" ? owner.destinationServer : null;
  if (server === null && owner.kind === "service") server = owner.server;
  return server;
}

function resolveLevels(levels: readonly Level[]): Resolved {
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
const teamRow = (data: ScanData): PolicyRow | null => data.policies.find((p) => p.scopeType === MORPH.team) ?? null;
const scopeRow = (data: ScanData, morphClass: string, id: number): PolicyRow | null => data.policies.find((p) => p.scopeType === morphClass && p.scopeId === id) ?? null;

function levelsFor(resource: AnyModel, mainServer: ScanServer | null, data: ScanData): Level[] {
  const levels: Level[] = [["instance", null]];
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
    const levels: Level[] = [["instance", null], ["team", teamRow(data)]];
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
