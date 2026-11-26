// Derived from coollabsio/coolify@91b7e3e:app/Livewire/ImageScan/ScanSettings.php,
// resources/views/livewire/image-scan/{scan-settings,partials/scan-rules,partials/scan-ignores}.blade.php,
// app/Services/ImageScan/ImageScanPolicyResolver.php (forScope, inheritedFor), app/Models/ImageScanPolicy.php
// (validationRules) and app/Enums/{ImageScanGateMode,ImageScanOnError}.php (Apache-2.0), modified.
//
// The scan settings of a resource's Security page (DP-114): an application's rules (Scan this app, Who builds this image,
// Block deploys, If the scan cannot run, Count medium problems), each saved on change, and the ignores a resource lists
// (a database's and a service's page lists only its ignores). A null value inherits from the level above; the instance
// level is Coolify's seeded row, which Freeploy has no row for (policy.ts). The team, server and instance scopes of
// ScanSettings are not ported (IMPLEMENTATION-STATUS.md, DP-114).
import { MORPH, type ApplicationModel, type IgnoreRow, type PolicyRow, type ScanData, type ScanOwner, type ScanResource } from "./model.js";
import { mainServerOf } from "./policy.js";
import { owners as ownersOf } from "./resource-scans.js";

export const GATE_MODE_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "on", label: "On", description: "Blocks a deploy when the new image adds a problem that attackers are using or are likely to use." },
  { value: "strict", label: "Strict", description: "Also blocks critical, high, and counted medium problems that have a fix, and operating systems that no longer get security fixes." },
];
export const ON_SCAN_ERROR_OPTIONS = [
  { value: "deploy", label: "Deploy anyway" },
  { value: "block", label: "Block the deploy" },
];
export const COUNT_MEDIUM_OPTIONS = [
  { value: "1", label: "Yes" },
  { value: "0", label: "No" },
];
const GATE_LABELS: Record<string, string> = { off: "Off", on: "On", strict: "Strict" };
const ON_ERROR_LABELS: Record<string, string> = { deploy: "Deploy anyway", block: "Block the deploy" };
const LEVEL_NAMES: Record<string, string> = { instance: "Coolify", team: "team", server: "server" };

export const SETTINGS_MESSAGES = { saved: "Saved.", removed: "Removed.", scanFirst: "Turn on the scan for this app first." } as const;

const boolToOption = (v: boolean | null | undefined): string => (v === true ? "1" : v === false ? "0" : "");
export const optionToBool = (v: string | null): boolean | null => (v === "1" ? true : v === "0" ? false : null);

/** The application's own policy row (forScope(): firstOrNew by scope). */
const appRow = (application: ApplicationModel, data: ScanData): PolicyRow | null => data.policies.find((p) => p.scopeType === MORPH.application && p.scopeId === application.id) ?? null;

/** inheritedFor(): the values an application inherits from the levels above it, each with the level it comes from. */
function inheritLabels(application: ApplicationModel, data: ScanData): Record<string, string> {
  const resolved = { gate_mode: { value: "off", source: "instance" }, on_scan_error: { value: "deploy", source: "instance" }, count_medium: { value: false as boolean, source: "instance" } };
  const levels: Array<[string, PolicyRow | null]> = [["instance", null], ["team", data.policies.find((p) => p.scopeType === MORPH.team) ?? null]];
  const server = mainServerOf(application);
  if (server !== null) levels.push(["server", data.policies.find((p) => p.scopeType === MORPH.server && p.scopeId === server.id) ?? null]);
  for (const [source, row] of levels) {
    if (row === null) continue;
    if (row.gateMode !== null) resolved.gate_mode = { value: row.gateMode, source };
    if (row.onScanError !== null) resolved.on_scan_error = { value: row.onScanError, source };
    if (row.countMedium !== null) resolved.count_medium = { value: row.countMedium, source };
  }
  const label = (source: string, value: string) => `Use ${LEVEL_NAMES[source]} default (${value})`;
  return {
    gate_mode: label(resolved.gate_mode.source, GATE_LABELS[resolved.gate_mode.value]!),
    on_scan_error: label(resolved.on_scan_error.source, ON_ERROR_LABELS[resolved.on_scan_error.value]!),
    count_medium: label(resolved.count_medium.source, resolved.count_medium.value ? "Yes" : "No"),
  };
}

const ownerName = (o: ScanOwner): string => String(("humanName" in o && o.humanName ? o.humanName : null) ?? o.name ?? "");

/** The ignores of a resource scope: team-wide ones and those of the resource (a service: of its parts and of itself). */
export function resourceIgnoreOwners(resource: ScanResource): Array<{ morphClass: string; id: number }> {
  return resource.kind === "service" ? [...ownersOf(resource), resource] : [resource];
}

/** mount() and render() of a resource's ScanSettings. */
export function renderScanSettings(resource: ScanResource, data: ScanData, ignores: readonly IgnoreRow[], buildsByTeam: boolean | null, canEdit: boolean) {
  const scopeType = resource.kind === "application" ? "application" : resource.kind;
  const names = resource.kind === "service" ? new Map(ownersOf(resource).map((o) => [`${o.morphClass}:${o.id}`, ownerName(o)])) : new Map<string, string>();
  const ignoreRows = ignores.map((i) => ({
    uuid: i.uuid,
    vulnerabilityId: i.vulnerabilityId,
    package: i.package,
    reason: i.reason,
    expires: i.expiresAt === null ? null : i.expiresAt.toISOString().slice(0, 10),
    teamWide: i.resourceId === null,
    ownerName: i.resourceId !== null ? (names.get(`${i.resourceType}:${i.resourceId}`) ?? null) : null,
  }));
  const base = { scopeType, canEdit, showsIgnores: true, showsTeamSettingsLink: true, ignores: ignoreRows };
  if (resource.kind !== "application") return { ...base, rules: null };
  const row = appRow(resource, data);
  const appScanOn = resource.settings?.isImageScanEnabled === true;
  return {
    ...base,
    rules: {
      gateMode: row?.gateMode ?? "",
      onScanError: row?.onScanError ?? "",
      countMedium: boolToOption(row?.countMedium ?? null),
      appScanEnabled: boolToOption(appScanOn),
      buildsByTeam: boolToOption(buildsByTeam),
      appScanOn,
      isDockerImage: resource.buildPack === "dockerimage",
      inheritLabels: inheritLabels(resource, data),
      gateModeOptions: GATE_MODE_OPTIONS,
      onScanErrorOptions: ON_SCAN_ERROR_OPTIONS,
      countMediumOptions: COUNT_MEDIUM_OPTIONS,
    },
  };
}

/** $this->validate([$property => ImageScanPolicy::validationRules()[$column]]): Laravel's message, or null. */
export function validateRule(column: "gate_mode" | "on_scan_error" | "count_medium", value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (column === "gate_mode") return typeof value === "string" && value in GATE_LABELS ? null : "The selected gate mode is invalid.";
  if (column === "on_scan_error") return typeof value === "string" && value in ON_ERROR_LABELS ? null : "The selected on scan error is invalid.";
  return [true, false, 0, 1, "0", "1"].includes(value as never) ? null : "The count medium field must be true or false.";
}
