// Derived from coollabsio/coolify@91b7e3e:app/Livewire/ImageScan/ScanSettings.php,
// resources/views/livewire/image-scan/{scan-settings,partials/scan-rules,partials/scan-ignores}.blade.php,
// app/Services/ImageScan/ImageScanPolicyResolver.php (forScope, inheritedFor), app/Models/ImageScanPolicy.php
// (validationRules) and app/Enums/{ImageScanGateMode,ImageScanOnError}.php (Apache-2.0), modified.
//
// The scan settings of a resource's Security page (DP-114): an application's rules (Scan this app, Who builds this image,
// Block deploys, If the scan cannot run, Count medium problems), each saved on change, and the ignores a resource lists
// (a database's and a service's page lists only its ignores). A null value inherits from the level above.
//
// DP-116: the instance, team and server scopes — the rules of /settings/image-scanning (the platform's row, which every
// rule must set: `required` instead of `nullable`), of /team/image-scanning (with Scan images on new servers, the org's
// scan_images_on_new_servers, and the team-wide ignores) and of a server's Vulnerabilities page (embedded).
import { MORPH, type ApplicationModel, type IgnoreRow, type PolicyRow, type ScanData, type ScanOwner, type ScanResource } from "./model.js";
import { instanceRow, mainServerOf, resolveLevels, scopeRow, teamRow, type Level, type Resolved } from "./policy.js";
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

export const boolToOption = (v: boolean | null | undefined): string => (v === true ? "1" : v === false ? "0" : "");
export const optionToBool = (v: string | null): boolean | null => (v === "1" ? true : v === "0" ? false : null);

/** The application's own policy row (forScope(): firstOrNew by scope). */
const appRow = (application: ApplicationModel, data: ScanData): PolicyRow | null => data.policies.find((p) => p.scopeType === MORPH.application && p.scopeId === application.id) ?? null;

/** inheritedFor(): the values an application inherits from the levels above it, each with the level it comes from. */
function inheritLabels(application: ApplicationModel, data: ScanData): Record<string, string> {
  const levels: Level[] = [["instance", instanceRow(data)], ["team", teamRow(data)]];
  const server = mainServerOf(application);
  if (server !== null) levels.push(["server", scopeRow(data, MORPH.server, server.id)]);
  return inheritLabelsOf(resolveLevels(levels));
}

/** inheritLabels(): "Use {level} default ({value})" per rule, from what the level inherits. */
export function inheritLabelsOf(resolved: Resolved): Record<string, string> {
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

// ── DP-116: the instance, team and server scopes ────────────────────────────

export type LevelScope = "instance" | "team" | "server";

export const LEVEL_MESSAGES = {
  /** saveRule() of the instance: `required` (Laravel's message with the property's name). */
  required: { gate_mode: "The gate mode field is required.", on_scan_error: "The on scan error field is required.", count_medium: "The count medium field is required." },
  /** updatedScanNewServers(): ['required', 'in:1,0']. */
  scanNewServersRequired: "The scan new servers field is required.",
  scanNewServersInvalid: "The selected scan new servers is invalid.",
} as const;

/** saveRule()'s rules for a scope: ImageScanPolicy::validationRules(), with `required` for the instance (no `nullable`). */
export function validateLevelRule(scope: LevelScope, column: "gate_mode" | "on_scan_error" | "count_medium", value: unknown): string | null {
  if (scope === "instance" && (value === null || value === undefined || value === "")) return LEVEL_MESSAGES.required[column];
  return validateRule(column, value);
}

/** updatedScanNewServers(): $this->validate(['scanNewServers' => ['required', 'in:1,0']]); the value as a boolean. */
export function validateScanNewServers(value: unknown): { ok: true; value: boolean } | { ok: false; message: string } {
  if (value === null || value === undefined || value === "") return { ok: false, message: LEVEL_MESSAGES.scanNewServersRequired };
  const v = typeof value === "number" ? String(value) : value;
  if (v !== "1" && v !== "0") return { ok: false, message: LEVEL_MESSAGES.scanNewServersInvalid };
  return { ok: true, value: v === "1" };
}

export interface LevelSettingsInput {
  scope: LevelScope;
  /** forScope($scope): the level's own row (the instance's exists once the operator's page read it). */
  row: PolicyRow | null;
  data: Pick<ScanData, "policies" | "instancePolicy">;
  canEdit: boolean;
  /** The team: the org's scan_images_on_new_servers, and whether the user may change it (membership-worker's team update). */
  scanNewServers?: boolean;
  canEditScanNewServers?: boolean;
  /** The team: its team-wide ignores. */
  ignores?: readonly IgnoreRow[];
}

/** mount() and render() of ScanSettings for the instance, a team or a server. */
export function renderLevelSettings(input: LevelSettingsInput) {
  const { scope, row, data, canEdit } = input;
  // inheritLabels(): null for the instance level (its listboxes have no inherit option).
  const levels: Level[] = scope === "team" ? [["instance", instanceRow(data)]] : [["instance", instanceRow(data)], ["team", teamRow(data)]];
  const inherited = scope === "instance" ? null : inheritLabelsOf(resolveLevels(levels));
  const ignoreRows = (input.ignores ?? []).map((i) => ({
    uuid: i.uuid,
    vulnerabilityId: i.vulnerabilityId,
    package: i.package,
    reason: i.reason,
    expires: i.expiresAt === null ? null : i.expiresAt.toISOString().slice(0, 10),
    teamWide: true,
    ownerName: null,
  }));
  return {
    scopeType: scope,
    canEdit,
    showsIgnores: scope === "team",
    showsTeamSettingsLink: false,
    ignores: ignoreRows,
    rules: {
      gateMode: row?.gateMode ?? "",
      onScanError: row?.onScanError ?? "",
      countMedium: boolToOption(row?.countMedium ?? null),
      ...(scope === "team" ? { scanNewServers: boolToOption(input.scanNewServers === true), canEditScanNewServers: input.canEditScanNewServers === true } : {}),
      appScanOn: true,
      inheritLabels: inherited,
      gateModeOptions: GATE_MODE_OPTIONS,
      onScanErrorOptions: ON_SCAN_ERROR_OPTIONS,
      countMediumOptions: COUNT_MEDIUM_OPTIONS,
    },
  };
}
