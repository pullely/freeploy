// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Shared/Destination.php (the queries) and
// app/Models/Application.php (additional_servers, additional_networks) (Apache-2.0), modified.
//
// deploy.additional_destinations: the pivot between an application and the
// standalone Docker networks it is also deployed to, one row per (application,
// server, network). Every function takes the transaction of withOrg():
// row-level security confines each query to that org, which is what Coolify's
// where('team_id', …) does.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { DESTINATION_MORPH_CLASS } from "./destinations.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** A standalone Docker network with its server and what decides whether the server can take a deployment. */
export interface DeployServerNetworkRow extends SqlRow {
  /** standalone_dockers.id */
  id: string | number;
  uuid: string;
  name: string;
  network: string;
  server_id: string | number;
  server_uuid: string;
  server_name: string;
  server_proxy: unknown;
  is_reachable: boolean | null;
  is_usable: boolean | null;
  is_swarm_worker: boolean | null;
  force_disabled: boolean | null;
  is_build_server: boolean | null;
  server_role: string | null;
}

/** One of an application's additional destinations: the network, its server and the pivot's status. */
export interface DeployAdditionalDestinationRow extends DeployServerNetworkRow {
  /** pivot.status: the application's status on that server. */
  status: string;
}

const NETWORK_COLUMNS = `d.id, d.uuid, d.name, d.network, s.id AS server_id, s.uuid AS server_uuid, s.name AS server_name, s.proxy AS server_proxy,
       ss.is_reachable, ss.is_usable, ss.is_swarm_worker, ss.force_disabled, ss.is_build_server, ss.server_role`;
const NETWORK_FROM = `deploy.standalone_dockers d
       JOIN deploy.servers s ON s.id = d.server_id AND s.deleted_at IS NULL
       LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id`;

/** $application->additional_networks (with pivot server_id and status), oldest first. */
export async function listAdditionalDestinations(tx: SqlExecutor, applicationId: string | number): Promise<DeployAdditionalDestinationRow[]> {
  const r = await tx.execute<DeployAdditionalDestinationRow>(
    `SELECT ${NETWORK_COLUMNS}, p.status
       FROM deploy.additional_destinations p
       JOIN ${NETWORK_FROM} ON d.id = p.standalone_docker_id AND s.id = p.server_id
      WHERE p.application_id = $1
      ORDER BY p.id`,
    [applicationId],
  );
  return r.rows;
}

/** resourceServers()->with('settings', 'standaloneDockers')->orderBy('name'): every standalone network of the org's servers. */
export async function listServerNetworks(tx: SqlExecutor): Promise<DeployServerNetworkRow[]> {
  const r = await tx.execute<DeployServerNetworkRow>(`SELECT ${NETWORK_COLUMNS} FROM ${NETWORK_FROM} ORDER BY s.name, s.id, d.id`);
  return r.rows;
}

/** A server of the org by id, with the settings findUsableServer() reads. */
export interface DeployDestinationServerRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  proxy: unknown;
  is_reachable: boolean | null;
  is_usable: boolean | null;
  is_swarm_worker: boolean | null;
  force_disabled: boolean | null;
  is_build_server: boolean | null;
  server_role: string | null;
}

/** resourceServers()->findOrFail($serverId) */
export async function findDestinationServer(tx: SqlExecutor, serverId: string | number): Promise<DeployDestinationServerRow | null> {
  const r = await tx.execute<DeployDestinationServerRow>(
    `SELECT s.id, s.uuid, s.name, s.proxy, ss.is_reachable, ss.is_usable, ss.is_swarm_worker, ss.force_disabled, ss.is_build_server, ss.server_role
       FROM deploy.servers s LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id
      WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [serverId],
  );
  return r.rows[0] ?? null;
}

/** StandaloneDocker::query()->where('server_id', $server->id)->find($networkId) */
export async function findServerNetwork(tx: SqlExecutor, serverId: string | number, networkId: string | number): Promise<{ id: string | number; uuid: string; name: string; network: string } | null> {
  const r = await tx.execute<{ id: string | number; uuid: string; name: string; network: string }>(
    "SELECT id, uuid, name, network FROM deploy.standalone_dockers WHERE id = $1 AND server_id = $2",
    [networkId, serverId],
  );
  return r.rows[0] ?? null;
}

/** additional_networks()->wherePivot('server_id', $serverId)[->whereKey($networkId)]->exists() */
export async function additionalDestinationExists(tx: SqlExecutor, applicationId: string | number, serverId: string | number, networkId?: string | number): Promise<boolean> {
  const r = await tx.execute(
    `SELECT 1 FROM deploy.additional_destinations WHERE application_id = $1 AND server_id = $2${networkId === undefined ? "" : " AND standalone_docker_id = $3"} LIMIT 1`,
    networkId === undefined ? [applicationId, serverId] : [applicationId, serverId, networkId],
  );
  return r.rows.length > 0;
}

/**
 * additional_networks()->syncWithoutDetaching([$networkId => ['server_id' =>
 * $serverId]]): the network is attached once — a second call for the same
 * network changes its pivot's server and adds no row. The pivot's status
 * starts as the column's default, 'exited'. True when a row was added.
 */
export async function attachAdditionalDestination(tx: SqlExecutor, orgId: string, applicationId: string | number, serverId: string | number, networkId: string | number): Promise<boolean> {
  const updated = await tx.execute("UPDATE deploy.additional_destinations SET server_id = $3 WHERE application_id = $1 AND standalone_docker_id = $2 RETURNING id", [applicationId, networkId, serverId]);
  if (updated.rows.length > 0) return false;
  await tx.execute("INSERT INTO deploy.additional_destinations (application_id, server_id, standalone_docker_id, org_id) VALUES ($1, $2, $3, $4)", [applicationId, serverId, networkId, orgId]);
  return true;
}

/** additional_networks()->wherePivot('server_id', $serverId)->detach($networkId). True when it was attached. */
export async function detachAdditionalDestination(tx: SqlExecutor, applicationId: string | number, serverId: string | number, networkId: string | number): Promise<boolean> {
  const r = await tx.execute("DELETE FROM deploy.additional_destinations WHERE application_id = $1 AND server_id = $2 AND standalone_docker_id = $3 RETURNING id", [applicationId, serverId, networkId]);
  return r.rows.length > 0;
}

/**
 * Destination::promote()'s transaction: the application's main destination
 * becomes the network, the network leaves the additional destinations, and
 * the former main destination joins them (`attach`: with the column's default
 * status). `main` is null when the application has no standalone main
 * destination left to keep. False when the application is gone.
 */
export async function promoteAdditionalDestination(
  tx: SqlExecutor,
  orgId: string,
  applicationId: string | number,
  promoted: { serverId: string | number; networkId: string | number },
  main: { serverId: string | number; networkId: string | number } | null,
): Promise<boolean> {
  const r = await tx.execute(
    `UPDATE deploy.applications SET destination_id = $2, destination_type = $3, updated_at = ${NOW} WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [applicationId, promoted.networkId, DESTINATION_MORPH_CLASS.standalone],
  );
  if (!r.rows.length) return false;
  await detachAdditionalDestination(tx, applicationId, promoted.serverId, promoted.networkId);
  if (main) {
    await tx.execute("INSERT INTO deploy.additional_destinations (application_id, server_id, standalone_docker_id, org_id) VALUES ($1, $2, $3, $4)", [applicationId, main.serverId, main.networkId, orgId]);
  }
  return true;
}

/** What deleting an application removes of the pivot (the foreign key cascades in Coolify). */
export async function deleteAdditionalDestinations(tx: SqlExecutor, applicationId: string | number): Promise<void> {
  await tx.execute("DELETE FROM deploy.additional_destinations WHERE application_id = $1", [applicationId]);
}
