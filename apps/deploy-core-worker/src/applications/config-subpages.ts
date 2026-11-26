// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/Swarm.php, config/deprecations.php (swarm),
// app/Livewire/Project/Shared/Maintenance.php, app/Traits/HasMaintenancePage.php (syncMaintenancePage),
// app/Models/{Application,Service}.php (maintenanceServers), app/Models/Server.php (isSwarm, proxyType,
// isFunctional, PROXY_ERROR_PAGE_MAX_BYTES) and bootstrap/helpers/proxy.php (proxyPageSizeRule) (Apache-2.0), modified.
//
// The rules of an application's Swarm page and of the Maintenance Mode page an application and a service share
// (DP-102), without IO: handlers/config-subpages.ts reads and writes the rows.
//
// Swarm: Swarm::syncData(true) — the replicas, the custom placement constraints (stored base64-encoded, as Coolify
// stores them) and the node placement — with the #[Validate] rules; the page exists only for an application whose
// server is a Swarm one (configuration.blade.php renders the component only then).
//
// Maintenance mode: the switch and the custom page. Turning it on or off, and saving or resetting the page while it
// is on, end in syncMaintenancePage(), which writes the proxy's maintenance files on every functional server that
// runs the resource: that needs the SSH executor, so it answers 501 after Coolify's checks and stores nothing. With
// no functional server, Coolify's sync does nothing and the row is stored, as here.
import type { DeployMaintenanceServerRow } from "@saas/db/deploy";
import { add, blank, type FieldErrors } from "../private-keys/validation.js";
import { LARAVEL } from "../servers/settings-validation.js";

/** Freeploy's convention, written out: this module loads inside the router's import cycle. */
const needsExecutor = (what: string): string => `${what} needs the SSH executor, which is not available yet.`;

/** Server::PROXY_ERROR_PAGE_MAX_BYTES */
export const PROXY_ERROR_PAGE_MAX_BYTES = 1048576;

export const SWARM_MESSAGES = {
  /** Swarm::instantSave() / submit() */
  updated: "Swarm settings updated.",
} as const;

export const MAINTENANCE_MESSAGES = {
  /** Maintenance::toggleMaintenance() */
  enabled: "Maintenance mode enabled.",
  disabled: "Maintenance mode disabled.",
  /** Maintenance::submit() */
  saved: "Maintenance page saved.",
  /** Maintenance::resetMaintenancePage() */
  reset: "Default maintenance page restored.",
  /** proxyPageSizeRule('maintenance page') */
  tooLarge: `The maintenance page must not be larger than ${PROXY_ERROR_PAGE_MAX_BYTES / 1024} KB.`,
  /** syncMaintenancePage() on a functional server: Freeploy's. */
  unavailable: needsExecutor("Applying the maintenance page on the server"),
  /** maintenance.blade.php, when no server has a supported proxy. */
  unsupported: "Maintenance mode needs a Traefik or Caddy proxy on a server that is not part of a Docker Swarm.",
} as const;

// ---------------------------------------------------------------- servers

/** Server::PLACEHOLDER_IPS */
const PLACEHOLDER_IPS = ["1.2.3.4", "0.0.0.0", "::"];

/** Server::isSwarm(): a Swarm manager or worker. */
export const isSwarmServer = (s: Pick<DeployMaintenanceServerRow, "is_swarm_manager" | "is_swarm_worker">): boolean => Boolean(s.is_swarm_manager) || Boolean(s.is_swarm_worker);

/** Server::isFunctional() */
export const isFunctionalServer = (s: Pick<DeployMaintenanceServerRow, "is_reachable" | "is_usable" | "force_disabled" | "ip">): boolean =>
  Boolean(s.is_reachable) && Boolean(s.is_usable) && s.force_disabled === false && !PLACEHOLDER_IPS.includes(s.ip);

/** Server::proxyType(): data_get($this->proxy, 'type'). */
export function proxyType(proxy: unknown): string | null {
  let value = proxy;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  const type = value !== null && typeof value === "object" ? (value as Record<string, unknown>).type : null;
  return typeof type === "string" ? type : null;
}

/** Maintenance::getIsSupportedProperty(): a server that runs the resource has Traefik or Caddy and is not a Swarm one. */
export function maintenanceSupported(servers: readonly DeployMaintenanceServerRow[]): boolean {
  return servers.some((s) => !isSwarmServer(s) && ["TRAEFIK", "CADDY"].includes(proxyType(s.proxy) ?? ""));
}

/** syncMaintenancePage(): whether it would run on a server (it skips the ones that are not functional). */
export const maintenanceSyncRuns = (servers: readonly DeployMaintenanceServerRow[]): boolean => servers.some(isFunctionalServer);

// ---------------------------------------------------------------- Maintenance

export interface MaintenanceState {
  isMaintenanceEnabled: boolean;
  maintenancePage: string | null;
  /** $this->isSupported */
  isSupported: boolean;
  /** Server::PROXY_ERROR_PAGE_MAX_BYTES / 1024, the textarea's helper. */
  maxKilobytes: number;
}

export function maintenanceState(row: { is_maintenance_enabled: boolean; maintenance_page: string | null }, servers: readonly DeployMaintenanceServerRow[]): MaintenanceState {
  return { isMaintenanceEnabled: row.is_maintenance_enabled === true, maintenancePage: row.maintenance_page, isSupported: maintenanceSupported(servers), maxKilobytes: PROXY_ERROR_PAGE_MAX_BYTES / 1024 };
}

/** strlen(): bytes. */
const byteLength = (value: string): number => new TextEncoder().encode(value).length;

/**
 * Maintenance::submit()'s $this->validate(): 'maintenancePage' => ['nullable', 'string', proxyPageSizeRule()].
 * Answers the page to store (filled() ? the page : null), or the errors.
 */
export function validateMaintenancePage(value: unknown): { ok: true; page: string | null } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  if (value === null || value === undefined) return { ok: true, page: null };
  if (typeof value !== "string") {
    add(errors, "maintenancePage", LARAVEL.string("maintenancePage"));
    return { ok: false, errors };
  }
  if (byteLength(value) > PROXY_ERROR_PAGE_MAX_BYTES) {
    add(errors, "maintenancePage", MAINTENANCE_MESSAGES.tooLarge);
    return { ok: false, errors };
  }
  return { ok: true, page: blank(value) ? null : value };
}

// ---------------------------------------------------------------- Swarm

export interface SwarmSettings {
  swarmReplicas: number;
  /** base64_decode() of the stored constraints, or null. */
  swarmPlacementConstraints: string | null;
  isSwarmOnlyWorkerNodes: boolean;
}

/** PHP's truthiness of a string: "" and "0" are false. */
const phpTruthy = (value: string | null): boolean => value !== null && value !== "" && value !== "0";

/** base64_encode() of the UTF-8 text. */
export function base64Encode(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** base64_decode() (non-strict: characters outside the alphabet are skipped), read as UTF-8. */
export function base64Decode(encoded: string): string {
  const clean = encoded.replace(/[^A-Za-z0-9+/]/g, "");
  const padded = clean.length % 4 === 1 ? clean.slice(0, -1) : clean;
  let binary: string;
  try {
    binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  } catch {
    return "";
  }
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** Swarm::syncData(): the stored row as the form shows it. */
export function swarmSettings(row: { swarm_replicas: number; swarm_placement_constraints: string | null; is_swarm_only_worker_nodes: boolean | null }): SwarmSettings {
  return {
    swarmReplicas: Number(row.swarm_replicas),
    swarmPlacementConstraints: phpTruthy(row.swarm_placement_constraints) ? base64Decode(row.swarm_placement_constraints!) : null,
    isSwarmOnlyWorkerNodes: row.is_swarm_only_worker_nodes === true,
  };
}

/** Livewire's hydration of a typed bool: true/false, and their text and number forms. */
function asBool(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return null;
}

/**
 * Swarm's $this->validate(): swarmReplicas 'required' (an int property), swarmPlacementConstraints 'nullable' (a ?string
 * property), isSwarmOnlyWorkerNodes 'required' (a bool property). A value the typed property cannot hold gets
 * Laravel's message for that type. Answers the columns to store: the replicas, the constraints base64-encoded (null
 * when empty), the node placement.
 */
export function validateSwarm(body: Record<string, unknown>): { ok: true; swarmReplicas: number; swarmPlacementConstraints: string | null; isSwarmOnlyWorkerNodes: boolean } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const replicasValue = body.swarmReplicas;
  let replicas = 0;
  if (blank(replicasValue)) add(errors, "swarmReplicas", LARAVEL.required("swarmReplicas"));
  else if (typeof replicasValue === "number" && Number.isInteger(replicasValue)) replicas = replicasValue;
  else if (typeof replicasValue === "string" && /^\s*[+-]?\d+\s*$/.test(replicasValue)) replicas = Number(replicasValue.trim());
  else add(errors, "swarmReplicas", LARAVEL.integer("swarmReplicas"));

  const constraints = body.swarmPlacementConstraints;
  if (constraints !== undefined && constraints !== null && typeof constraints !== "string") add(errors, "swarmPlacementConstraints", LARAVEL.string("swarmPlacementConstraints"));

  const nodes = body.isSwarmOnlyWorkerNodes;
  const workerOnly = asBool(nodes);
  if (nodes === undefined || nodes === null || nodes === "") add(errors, "isSwarmOnlyWorkerNodes", LARAVEL.required("isSwarmOnlyWorkerNodes"));
  else if (workerOnly === null) add(errors, "isSwarmOnlyWorkerNodes", LARAVEL.boolean("isSwarmOnlyWorkerNodes"));

  if (Object.keys(errors).length) return { ok: false, errors };
  const text = typeof constraints === "string" ? constraints : null;
  return { ok: true, swarmReplicas: replicas, swarmPlacementConstraints: phpTruthy(text) ? base64Encode(text!) : null, isSwarmOnlyWorkerNodes: workerOnly! };
}
