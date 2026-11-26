// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Dashboard.php (mount: the team's servers and private keys),
// app/Livewire/Dashboard/ActiveDeployments.php (activeDeployments, recentDeployments, deploymentsQuery),
// app/Models/ApplicationDeploymentQueue.php (applicationIdsOwnedByTeam) and app/Livewire/Project/CloneMe.php (the
// project name check of cloneInto()) (Apache-2.0), modified.
//
// The rows behind the dashboard at / (DP-100) and the environment clone's project name check. Every function takes
// the transaction of withOrg(): row-level security confines each query to that org, which is what Coolify's
// ownedByCurrentTeam() / currentTeam() does.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

/** A server of the org with what Dashboard::serverStatus() reads. */
export interface DeployDashboardServerRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  description: string | null;
  ip: string;
  proxy: unknown;
  server_metadata: unknown;
  detected_traefik_version: string | null;
  traefik_outdated_info: unknown;
  sentinel_updated_at: string | Date | null;
  sentinel_waiting_since: string | Date | null;
  // server_settings
  is_reachable: boolean | null;
  is_usable: boolean | null;
  force_disabled: boolean | null;
  is_swarm_manager: boolean | null;
  is_swarm_worker: boolean | null;
  is_build_server: boolean | null;
  server_role: string | null;
  is_metrics_enabled: boolean | null;
  sentinel_push_interval_seconds: number | null;
}

/** Server::ownedByCurrentTeamCached(): the org's servers by name (orderBy('name')), with their settings. */
export async function listDashboardServers(tx: SqlExecutor): Promise<DeployDashboardServerRow[]> {
  const r = await tx.execute<DeployDashboardServerRow>(
    `SELECT s.id, s.uuid, s.name, s.description, s.ip, s.proxy, s.server_metadata, s.detected_traefik_version, s.traefik_outdated_info,
            s.sentinel_updated_at, s.sentinel_waiting_since,
            ss.is_reachable, ss.is_usable, ss.force_disabled, ss.is_swarm_manager, ss.is_swarm_worker, ss.is_build_server, ss.server_role,
            ss.is_metrics_enabled, ss.sentinel_push_interval_seconds
       FROM deploy.servers s LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id
      WHERE s.deleted_at IS NULL
      ORDER BY s.name, s.id`,
  );
  return r.rows;
}

/** PrivateKey::ownedByCurrentTeamCached()->isEmpty(): whether the org has a private key. */
export async function orgHasPrivateKeys(tx: SqlExecutor): Promise<boolean> {
  const r = await tx.execute("SELECT 1 FROM deploy.private_keys LIMIT 1");
  return r.rows.length > 0;
}

/** A deployment as ActiveDeployments::COLUMNS reads it, with the application's project and environment names. */
export interface DeployDashboardDeploymentRow extends SqlRow {
  id: string | number;
  application_id: string;
  application_name: string | null;
  deployment_url: string | null;
  deployment_uuid: string;
  pull_request_id: number;
  server_name: string | null;
  server_id: number | null;
  status: string;
  scan_gate_result: unknown;
  /** ISO 8601 with +00:00, or null. */
  created_at: string | null;
  finished_at: string | null;
  /** $deployment->application?->environment?->project?->name: null once the application is deleted. */
  project_name: string | null;
  environment_name: string | null;
}

/**
 * ActiveDeployments::activeDeployments() (`active`: queued or in progress, by status then id) and recentDeployments()
 * (the others, newest first), five each, of the org's applications — applicationIdsOwnedByTeam() counts soft-deleted
 * ones too (withTrashed). The application relation loads only one that is not deleted, as Eloquent's SoftDeletes does.
 */
export async function listDashboardDeployments(tx: SqlExecutor, active: boolean): Promise<DeployDashboardDeploymentRow[]> {
  const iso = (column: string) => `CASE WHEN q.${column} IS NULL THEN NULL ELSE to_char(q.${column}, 'YYYY-MM-DD"T"HH24:MI:SS"+00:00"') END`;
  const r = await tx.execute<DeployDashboardDeploymentRow>(
    `SELECT q.id, q.application_id, q.application_name, q.deployment_url, q.deployment_uuid, q.pull_request_id, q.server_name, q.server_id, q.status,
            q.scan_gate_result, ${iso("created_at")} AS created_at, ${iso("finished_at")} AS finished_at, p.name AS project_name, e.name AS environment_name
       FROM deploy.application_deployment_queues q
       LEFT JOIN deploy.applications a ON a.id::text = q.application_id AND a.deleted_at IS NULL
       LEFT JOIN deploy.environments e ON e.id = a.environment_id
       LEFT JOIN deploy.projects p ON p.id = e.project_id
      WHERE q.application_id IN (SELECT t.id::text FROM deploy.applications t)
        AND ${active ? "q.status IN ('in_progress', 'queued')" : "q.status NOT IN ('in_progress', 'queued')"}
      ORDER BY ${active ? "q.status, q.id" : "q.id DESC"}
      LIMIT 5`,
  );
  return r.rows;
}

/** CloneMe::cloneInto(): Project::query()->where('team_id', …)->where('name', $this->newName)->first(). */
export async function projectNameExists(tx: SqlExecutor, name: string): Promise<boolean> {
  const r = await tx.execute("SELECT 1 FROM deploy.projects WHERE name = $1 LIMIT 1", [name]);
  return r.rows.length > 0;
}
