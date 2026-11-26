// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Dashboard.php (mount, serverStatus), app/Livewire/Dashboard/
// ActiveDeployments.php, resources/views/livewire/dashboard/active-deployments.blade.php ($deploymentStatusMeta's
// isImageScanBlocked() branch), app/Models/Server.php (proxySet, proxyType, hasCurrentTraefikOutdatedInfo,
// isSentinelEnabled, isMetricsEnabled) and app/Models/ApplicationDeploymentQueue.php (isImageScanBlocked)
// (Apache-2.0), modified.
//
// The dashboard at / (route `dashboard`, DP-100): what Dashboard::mount() loads — the team's projects (with
// Project\Index's counts), its servers with serverStatus()'s label, and whether it has a private key (the empty
// servers section asks for one first) — and what <livewire:dashboard.active-deployments> polls. Sorting and the
// eight-item limit are the page's (setProjectSort / setServerSort run in the browser). Members limited to some
// projects (showsTeamSections) do not exist in Freeploy: every member sees the whole org.
import type { DeployDashboardDeploymentRow, DeployDashboardServerRow } from "@saas/db/deploy";
import { jsonValue } from "../applications/settings.js";
import { effectiveServerRole, isFunctional, isTransferredAway } from "../servers/service.js";
import { sentinelStatus } from "../servers/settings.js";
import { listProjects, type ProjectListItem, type ProjectStore } from "../projects/service.js";

export interface DashboardStore {
  projects: ProjectStore["list"];
  servers(): Promise<DeployDashboardServerRow[]>;
  hasPrivateKeys(): Promise<boolean>;
  deployments(active: boolean): Promise<DeployDashboardDeploymentRow[]>;
}

export type ServerStatusType = "success" | "warning" | "error";

export interface DashboardServer {
  uuid: string;
  name: string;
  description: string | null;
  /** serverStatus()'s label and badge type. */
  status: string;
  statusType: ServerStatusType;
  /** isMetricsEnabled(): the table gets a Usage column. */
  isMetricsEnabled: boolean;
}

export interface DashboardPage {
  projects: ProjectListItem[];
  servers: DashboardServer[];
  /** $privateKeys->isNotEmpty() */
  hasPrivateKeys: boolean;
}

const proxyOf = (row: DeployDashboardServerRow): Record<string, unknown> => {
  const proxy = jsonValue(row.proxy);
  return proxy !== null && typeof proxy === "object" && !Array.isArray(proxy) ? (proxy as Record<string, unknown>) : {};
};

/** Server::hasCurrentTraefikOutdatedInfo(): the stored outdated info is about the version Traefik runs now. */
export function hasCurrentTraefikOutdatedInfo(row: Pick<DeployDashboardServerRow, "proxy" | "detected_traefik_version" | "traefik_outdated_info">): boolean {
  if (proxyOf(row as DeployDashboardServerRow).type !== "TRAEFIK") return false;
  const info = jsonValue(row.traefik_outdated_info);
  const field = (k: string): unknown => (info !== null && typeof info === "object" ? (info as Record<string, unknown>)[k] : undefined);
  const strip = (v: unknown) => String(v ?? "").replace(/^v+/, "");
  const detected = strip(row.detected_traefik_version);
  return detected.trim() !== "" && strip(field("current")) === detected && (field("type") === "patch_update" || field("type") === "minor_upgrade");
}

/**
 * Dashboard::serverStatus(): Disabled, Unavailable, Unreachable, Not ready, Attention required (the proxy is set and
 * not running or has outdated info, or Sentinel is enabled and out of sync), else Ready.
 */
export function dashboardServerStatus(row: DeployDashboardServerRow, now = Date.now()): [string, ServerStatusType] {
  const role = effectiveServerRole({ server_role: row.server_role as never, is_build_server: row.is_build_server });
  const proxy = proxyOf(row);
  const type = proxy.type;
  const functional = isFunctional({ is_reachable: row.is_reachable, is_usable: row.is_usable, force_disabled: row.force_disabled, ip: row.ip });
  // proxySet(): a proxy type other than NONE, a functional server that is not a Swarm worker and can host resources.
  const proxySet = Boolean(type) && type !== "NONE" && functional && !row.is_swarm_worker && role !== "build";
  const proxyNeedsAttention = proxySet && (proxy.status !== "running" || hasCurrentTraefikOutdatedInfo(row));
  // isSentinelEnabled(): not a build server, not Swarm, not disabled, not transferred away.
  const sentinelEnabled = role !== "build" && !row.is_swarm_manager && !row.is_swarm_worker && !row.force_disabled && !isTransferredAway(row);
  const sentinelNeedsAttention =
    sentinelEnabled &&
    sentinelStatus(
      { sentinel_waiting_since: row.sentinel_waiting_since, sentinel_updated_at: row.sentinel_updated_at, sentinel_push_interval_seconds: Number(row.sentinel_push_interval_seconds ?? 60) },
      now,
    ) === "out_of_sync";
  if (row.force_disabled) return ["Disabled", "error"];
  if (!row.is_reachable && !row.is_usable) return ["Unavailable", "error"];
  if (!row.is_reachable) return ["Unreachable", "error"];
  if (!row.is_usable) return ["Not ready", "warning"];
  if (proxyNeedsAttention || sentinelNeedsAttention) return ["Attention required", "warning"];
  return ["Ready", "success"];
}

/** Dashboard::mount() + render(): the projects, the servers and whether a private key exists. */
export async function showDashboard(store: DashboardStore, now = Date.now()): Promise<DashboardPage> {
  const projects = await listProjects({ list: store.projects } as ProjectStore);
  const servers = (await store.servers()).map((row) => {
    const [status, statusType] = dashboardServerStatus(row, now);
    return { uuid: row.uuid, name: row.name, description: row.description ?? null, status, statusType, isMetricsEnabled: row.is_metrics_enabled === true };
  });
  return { projects, servers, hasPrivateKeys: await store.hasPrivateKeys() };
}

export interface DashboardDeployment {
  deploymentUuid: string;
  applicationName: string | null;
  deploymentUrl: string | null;
  pullRequestId: number;
  serverName: string | null;
  status: string;
  /** isImageScanBlocked(): (bool) data_get($scan_gate_result, 'blocked', false). */
  imageScanBlocked: boolean;
  createdAt: string | null;
  finishedAt: string | null;
  /** collect([$projectName, $environmentName])->filter()->join(' / '): '' when neither is known. */
  environmentPath: string;
}

/** PHP's (bool) of a decoded JSON value. */
function phpBool(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "" || value === "0") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

function deployment(row: DeployDashboardDeploymentRow): DashboardDeployment {
  const gate = jsonValue(row.scan_gate_result);
  const blocked = gate !== null && typeof gate === "object" && !Array.isArray(gate) ? (gate as Record<string, unknown>).blocked : undefined;
  return {
    deploymentUuid: row.deployment_uuid,
    applicationName: row.application_name,
    deploymentUrl: row.deployment_url,
    pullRequestId: Number(row.pull_request_id ?? 0),
    serverName: row.server_name,
    status: row.status,
    imageScanBlocked: phpBool(blocked),
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    // filter(): a null or empty name drops out.
    environmentPath: [row.project_name, row.environment_name].filter((v): v is string => typeof v === "string" && v !== "" && v !== "0").join(" / "),
  };
}

/** <livewire:dashboard.active-deployments>: the queued and running deployments, and the latest others. */
export async function dashboardDeployments(store: DashboardStore): Promise<{ active: DashboardDeployment[]; recent: DashboardDeployment[] }> {
  return { active: (await store.deployments(true)).map(deployment), recent: (await store.deployments(false)).map(deployment) };
}
