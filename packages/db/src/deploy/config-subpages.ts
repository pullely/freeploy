// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/Swarm.php (syncData),
// app/Livewire/Project/Shared/Maintenance.php, app/Models/{Application,Service}.php (maintenanceServers,
// additional_servers), app/Models/Server.php (isSwarm, proxyType) and app/Livewire/Project/Service/Domains.php
// (domain_dns_statuses) (Apache-2.0), modified.
//
// The rows of an application's Swarm and Maintenance Mode pages and of a service's Maintenance Mode and Domains
// pages (DP-102): the columns are all in the schema at head (500_deploy_core: applications.swarm_replicas,
// swarm_placement_constraints, application_settings.is_swarm_only_worker_nodes, service_applications.
// domain_dns_statuses; 660_deploy_schema_catch_up: is_maintenance_enabled and maintenance_page of applications and
// services). Every function takes the transaction of withOrg(): row-level security confines each query to that
// org. A soft-deleted resource or server is never returned.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { DESTINATION_MORPH_CLASS } from "./destinations.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";
const STANDALONE = DESTINATION_MORPH_CLASS.standalone.replace(/\\/g, "\\\\");
const SWARM = DESTINATION_MORPH_CLASS.swarm.replace(/\\/g, "\\\\");

type Id = string | number;

/** An application as its Swarm and Maintenance Mode pages read it. */
export interface DeployApplicationSubpageRow extends SqlRow {
  id: Id;
  uuid: string;
  swarm_replicas: number;
  /** base64 of the constraints, as Swarm::syncData(true) stores them. */
  swarm_placement_constraints: string | null;
  /** application_settings.is_swarm_only_worker_nodes (null when the settings row is missing). */
  is_swarm_only_worker_nodes: boolean | null;
  is_maintenance_enabled: boolean;
  maintenance_page: string | null;
}

/** A service as its Maintenance Mode page reads it. */
export interface DeployServiceSubpageRow extends SqlRow {
  id: Id;
  uuid: string;
  is_maintenance_enabled: boolean;
  maintenance_page: string | null;
}

/** A server that runs the resource: what Maintenance::getIsSupportedProperty(), isFunctional() and the DNS target read. */
export interface DeployMaintenanceServerRow extends SqlRow {
  id: Id;
  ip: string;
  proxy: unknown;
  is_swarm_manager: boolean | null;
  is_swarm_worker: boolean | null;
  is_reachable: boolean | null;
  is_usable: boolean | null;
  force_disabled: boolean | null;
  public_ipv4: string | null;
  public_ipv6: string | null;
}

const SERVER_COLUMNS = `s.id, s.ip, s.proxy, ss.is_swarm_manager, ss.is_swarm_worker, ss.is_reachable, ss.is_usable, ss.force_disabled,
        ss.public_ipv4, ss.public_ipv6`;

/** The application by uuid, with its settings' is_swarm_only_worker_nodes. */
export async function findApplicationSubpage(tx: SqlExecutor, uuid: string): Promise<DeployApplicationSubpageRow | null> {
  const r = await tx.execute<DeployApplicationSubpageRow>(
    `SELECT a.id, a.uuid, a.swarm_replicas, a.swarm_placement_constraints, st.is_swarm_only_worker_nodes, a.is_maintenance_enabled, a.maintenance_page
       FROM deploy.applications a
       LEFT JOIN deploy.application_settings st ON st.application_id = a.id
      WHERE a.uuid = $1 AND a.deleted_at IS NULL`,
    [uuid],
  );
  return r.rows[0] ?? null;
}

/**
 * Application::maintenanceServers(): its destination's server, then its additional servers in the order they were
 * added, each once.
 */
export async function listApplicationMaintenanceServers(tx: SqlExecutor, applicationId: Id): Promise<DeployMaintenanceServerRow[]> {
  const r = await tx.execute<DeployMaintenanceServerRow & { position: unknown; added: unknown }>(
    `SELECT ${SERVER_COLUMNS}, 0 AS position, 0 AS added
       FROM deploy.applications a
       LEFT JOIN deploy.standalone_dockers sd ON sd.id = a.destination_id AND a.destination_type = E'${STANDALONE}'
       LEFT JOIN deploy.swarm_dockers wd ON wd.id = a.destination_id AND a.destination_type = E'${SWARM}'
       JOIN deploy.servers s ON s.id = COALESCE(sd.server_id, wd.server_id) AND s.deleted_at IS NULL
       LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id
      WHERE a.id = $1
     UNION ALL
     SELECT ${SERVER_COLUMNS}, 1 AS position, ad.id AS added
       FROM deploy.additional_destinations ad
       JOIN deploy.servers s ON s.id = ad.server_id AND s.deleted_at IS NULL
       LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id
      WHERE ad.application_id = $1
      ORDER BY position, added`,
    [applicationId],
  );
  const seen = new Set<string>();
  const servers: DeployMaintenanceServerRow[] = [];
  for (const { position, added, ...row } of r.rows) {
    void position;
    void added;
    if (seen.has(String(row.id))) continue;
    seen.add(String(row.id));
    servers.push(row);
  }
  return servers;
}

/** The service by uuid. */
export async function findServiceSubpage(tx: SqlExecutor, uuid: string): Promise<DeployServiceSubpageRow | null> {
  const r = await tx.execute<DeployServiceSubpageRow>("SELECT id, uuid, is_maintenance_enabled, maintenance_page FROM deploy.services WHERE uuid = $1 AND deleted_at IS NULL", [uuid]);
  return r.rows[0] ?? null;
}

/** Service::maintenanceServers(): its server, when it has one. */
export async function listServiceMaintenanceServers(tx: SqlExecutor, serviceId: Id): Promise<DeployMaintenanceServerRow[]> {
  const r = await tx.execute<DeployMaintenanceServerRow>(
    `SELECT ${SERVER_COLUMNS}
       FROM deploy.services sv
       JOIN deploy.servers s ON s.id = sv.server_id AND s.deleted_at IS NULL
       LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id
      WHERE sv.id = $1`,
    [serviceId],
  );
  return r.rows;
}

/** Swarm::syncData(true): $application->save() and $application->settings->save(). False when the application is gone. */
export async function updateApplicationSwarm(
  tx: SqlExecutor,
  id: Id,
  changes: { swarmReplicas: number; swarmPlacementConstraints: string | null; isSwarmOnlyWorkerNodes: boolean },
): Promise<boolean> {
  const r = await tx.execute<{ id: Id }>(
    `UPDATE deploy.applications SET swarm_replicas = $2, swarm_placement_constraints = $3, updated_at = ${NOW} WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [id, changes.swarmReplicas, changes.swarmPlacementConstraints],
  );
  if (!r.rows.length) return false;
  await tx.execute(`UPDATE deploy.application_settings SET is_swarm_only_worker_nodes = $2, updated_at = ${NOW} WHERE application_id = $1`, [id, changes.isSwarmOnlyWorkerNodes]);
  return true;
}

/** Maintenance's $resource->save(): only the given columns, and updated_at. False when the resource is gone. */
export async function updateResourceMaintenance(tx: SqlExecutor, kind: "application" | "service", id: Id, changes: { is_maintenance_enabled?: boolean; maintenance_page?: string | null }): Promise<boolean> {
  const columns = (["is_maintenance_enabled", "maintenance_page"] as const).filter((c) => changes[c] !== undefined);
  if (!columns.length) return true;
  const sets = columns.map((c, i) => `"${c}" = $${i + 2}`);
  const table = kind === "application" ? "deploy.applications" : "deploy.services";
  const r = await tx.execute<{ id: Id }>(`UPDATE ${table} SET ${[...sets, `updated_at = ${NOW}`].join(", ")} WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [
    id,
    ...columns.map((c) => changes[c] ?? null),
  ]);
  return r.rows.length > 0;
}

/** A service application's stored DNS check results (Domains::persistAllDomainDnsStatuses()). */
export interface DeployServiceApplicationDnsRow extends SqlRow {
  id: Id;
  /** JSON: the driver may hand back the parsed value or its text. */
  domain_dns_statuses: unknown;
}

/** The DNS statuses of the service's applications, oldest first. */
export async function listServiceApplicationDnsStatuses(tx: SqlExecutor, serviceId: Id): Promise<DeployServiceApplicationDnsRow[]> {
  const r = await tx.execute<DeployServiceApplicationDnsRow>("SELECT id, domain_dns_statuses FROM deploy.service_applications WHERE service_id = $1 AND deleted_at IS NULL ORDER BY id", [serviceId]);
  return r.rows;
}

/** One service application's domain_dns_statuses (null clears them). False when it is not the service's. */
export async function updateServiceApplicationDnsStatuses(tx: SqlExecutor, serviceId: Id, id: Id, statuses: Record<string, unknown> | null): Promise<boolean> {
  const r = await tx.execute<{ id: Id }>(
    `UPDATE deploy.service_applications SET domain_dns_statuses = $3::json, updated_at = ${NOW} WHERE service_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING id`,
    [serviceId, id, statuses === null ? null : JSON.stringify(statuses)],
  );
  return r.rows.length > 0;
}
