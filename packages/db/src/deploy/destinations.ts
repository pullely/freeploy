// Derived from coollabsio/coolify@91b7e3e:app/Models/{StandaloneDocker,SwarmDocker}.php (server, ownedByCurrentTeam,
// attachedTo and the resource relations), app/Models/Server.php (isUsable, standaloneDockers, swarmDockers,
// defaultStandaloneDockerAttributes), bootstrap/helpers/shared.php (find_destination_for_current_team) and
// app/Livewire/Destination/{Index,Show,Resources,New/Docker}.php and app/Livewire/Server/Destinations.php
// (Apache-2.0), modified.
//
// deploy.standalone_dockers and deploy.swarm_dockers: a server's Docker
// networks ("destinations"). Every function takes the transaction of
// withOrg(): row-level security confines each query to that org, which is
// what Coolify's whereHas('server', team_id) does. Nothing here talks to a
// server: creating or removing the network itself is the SSH executor's job.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** Coolify's two destination models: StandaloneDocker and SwarmDocker. */
export const DESTINATION_TYPES = ["standalone", "swarm"] as const;
export type DestinationType = (typeof DESTINATION_TYPES)[number];

const TABLE: Record<DestinationType, string> = { standalone: "deploy.standalone_dockers", swarm: "deploy.swarm_dockers" };

/** getMorphClass(): what a resource's destination_type column holds (Coolify has no morph map). */
export const DESTINATION_MORPH_CLASS: Record<DestinationType, string> = {
  standalone: "App\\Models\\StandaloneDocker",
  swarm: "App\\Models\\SwarmDocker",
};

/**
 * Server::defaultStandaloneDockerAttributes(): the destination every new
 * server gets. The network is Coolify's, byte for byte: it is the Docker
 * network on the server, which the proxy and every generated command name
 * (design §1.2). The name is only a label in the console, so it carries the
 * product's name where Coolify's says "coolify".
 */
export const DEFAULT_STANDALONE_DESTINATION = { name: "freeploy", network: "coolify" } as const;

/** A destination with the server it belongs to. */
export interface DeployDestinationRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  network: string;
  type: DestinationType;
  server_id: string | number;
  server_uuid: string;
  server_name: string;
  server_ip: string;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

const select = (type: DestinationType) =>
  `SELECT d.id, d.uuid, d.name, d.network, '${type}'::text AS type, d.server_id, s.uuid AS server_uuid, s.name AS server_name, s.ip AS server_ip, d.created_at, d.updated_at
     FROM ${TABLE[type]} d JOIN deploy.servers s ON s.id = d.server_id AND s.deleted_at IS NULL`;

/**
 * Server::isUsable(): reachable, usable, not a Swarm worker, not disabled, and
 * of a role that runs resources (deployment or both; a null role falls back
 * to the legacy build flag).
 */
const USABLE = `ss.is_reachable AND ss.is_usable AND NOT ss.is_swarm_worker AND NOT ss.force_disabled
  AND (ss.server_role IN ('deployment', 'both') OR (ss.server_role IS NULL AND NOT ss.is_build_server))`;

/** A server a destination can be added to from the destinations list. */
export interface DeployUsableServerRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
}

/** Index::mount() and New/Docker::mount(): Server::isUsable()->get(), by name. */
export async function listUsableServers(tx: SqlExecutor): Promise<DeployUsableServerRow[]> {
  const r = await tx.execute<DeployUsableServerRow>(
    `SELECT s.id, s.uuid, s.name FROM deploy.servers s JOIN deploy.server_settings ss ON ss.server_id = s.id
      WHERE s.deleted_at IS NULL AND ${USABLE}
      ORDER BY s.name, s.id`,
  );
  return r.rows;
}

/**
 * Index::mount(): the destinations of the usable servers — per server (by
 * name), its standalone destinations and then its Swarm ones. A server that
 * is not usable (not validated yet, disabled, a build server) lists none.
 */
export async function listUsableServerDestinations(tx: SqlExecutor): Promise<DeployDestinationRow[]> {
  const part = (type: DestinationType, order: number) =>
    `SELECT x.*, ${order} AS kind_order FROM (${select(type)} JOIN deploy.server_settings ss ON ss.server_id = s.id WHERE ${USABLE}) x`;
  const r = await tx.execute<DeployDestinationRow>(
    `SELECT id, uuid, name, network, type, server_id, server_uuid, server_name, server_ip, created_at, updated_at
       FROM (${part("standalone", 0)} UNION ALL ${part("swarm", 1)}) u
      ORDER BY server_name, server_id, kind_order, id`,
  );
  return r.rows;
}

/** $server->standaloneDockers->concat($server->swarmDockers) (Server/Destinations). */
export async function listServerDestinations(tx: SqlExecutor, serverId: string | number): Promise<DeployDestinationRow[]> {
  const rows: DeployDestinationRow[] = [];
  for (const type of DESTINATION_TYPES) {
    const r = await tx.execute<DeployDestinationRow>(`${select(type)} WHERE d.server_id = $1 ORDER BY d.id`, [serverId]);
    rows.push(...r.rows);
  }
  return rows;
}

/** find_destination_for_current_team(): the standalone destination with this uuid, else the Swarm one. */
export async function findDestinationByUuid(tx: SqlExecutor, uuid: string): Promise<DeployDestinationRow | null> {
  for (const type of DESTINATION_TYPES) {
    const r = await tx.execute<DeployDestinationRow>(`${select(type)} WHERE d.uuid = $1 ORDER BY d.id LIMIT 1`, [uuid]);
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

/** $server->standaloneDockers()/swarmDockers()->where('network', $network)->first(): the server already has it. */
export async function destinationNetworkExists(tx: SqlExecutor, type: DestinationType, serverId: string | number, network: string): Promise<boolean> {
  const r = await tx.execute(`SELECT 1 FROM ${TABLE[type]} WHERE server_id = $1 AND network = $2 LIMIT 1`, [serverId, network]);
  return r.rows.length > 0;
}

export interface NewDestination {
  orgId: string;
  type: DestinationType;
  uuid: string;
  name: string;
  network: string;
  serverId: string | number;
}

/**
 * StandaloneDocker::create() / SwarmDocker::create(): the row only. Coolify's
 * created hook then creates the network on the server (standalone only); the
 * caller reports that step.
 */
export async function insertDestination(tx: SqlExecutor, destination: NewDestination): Promise<DeployDestinationRow> {
  await tx.execute(
    `INSERT INTO ${TABLE[destination.type]} (uuid, name, network, server_id, org_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, ${NOW}, ${NOW})`,
    [destination.uuid, destination.name, destination.network, destination.serverId, destination.orgId],
  );
  const r = await tx.execute<DeployDestinationRow>(`${select(destination.type)} WHERE d.uuid = $1`, [destination.uuid]);
  return r.rows[0]!;
}

/** Show::syncData(true): the name is all a destination lets you change. */
export async function updateDestinationName(tx: SqlExecutor, type: DestinationType, id: string | number, name: string): Promise<boolean> {
  const r = await tx.execute(`UPDATE ${TABLE[type]} SET name = $2, updated_at = ${NOW} WHERE id = $1 RETURNING id`, [id, name]);
  return r.rows.length > 0;
}

/** $destination->delete(): the row. */
export async function deleteDestination(tx: SqlExecutor, type: DestinationType, id: string | number): Promise<boolean> {
  const r = await tx.execute(`DELETE FROM ${TABLE[type]} WHERE id = $1 RETURNING id`, [id]);
  return r.rows.length > 0;
}

/** The forceDeleting hook of Server: $server->destinations()->each->delete(). */
export async function deleteServerDestinations(tx: SqlExecutor, serverId: string | number): Promise<void> {
  for (const type of DESTINATION_TYPES) await tx.execute(`DELETE FROM ${TABLE[type]} WHERE server_id = $1`, [serverId]);
}

/**
 * What can be deployed to a destination, in the order Resources::loadResources()
 * lists them: the tables whose rows carry destination_id and destination_type.
 */
const RESOURCE_TABLES: ReadonlyArray<{ table: string; type: "application" | "service" | "database" }> = [
  { table: "applications", type: "application" },
  { table: "services", type: "service" },
  { table: "standalone_postgresqls", type: "database" },
  { table: "standalone_redis", type: "database" },
  { table: "standalone_mongodbs", type: "database" },
  { table: "standalone_mysqls", type: "database" },
  { table: "standalone_mariadbs", type: "database" },
  { table: "standalone_keydbs", type: "database" },
  { table: "standalone_dragonflies", type: "database" },
  { table: "standalone_clickhouses", type: "database" },
  { table: "standalone_sqlites", type: "database" },
];

/** The morphMany relations of a destination; soft-deleted resources do not count (SoftDeletes' scope). */
const ATTACHED = RESOURCE_TABLES.map(
  ({ table, type }, i) =>
    `SELECT ${i} AS ord, '${type}'::text AS type, t.id, t.uuid, t.name, t.environment_id FROM deploy.${table} t
      WHERE t.destination_id = $1 AND t.destination_type = $2 AND t.deleted_at IS NULL`,
).join(" UNION ALL ");

/** attachedTo(): an application, database or service is deployed to the destination. */
export async function destinationIsAttached(tx: SqlExecutor, type: DestinationType, id: string | number): Promise<boolean> {
  const r = await tx.execute(`SELECT 1 FROM (${ATTACHED}) r LIMIT 1`, [id, DESTINATION_MORPH_CLASS[type]]);
  return r.rows.length > 0;
}

/** A resource deployed to a destination, with its environment and project. */
export interface DeployDestinationResourceRow extends SqlRow {
  type: "application" | "service" | "database";
  uuid: string;
  name: string;
  environment_uuid: string | null;
  environment_name: string | null;
  project_uuid: string | null;
  project_name: string | null;
}

/** Resources::loadResources(): applications, services, then each kind of database. */
export async function listDestinationResources(tx: SqlExecutor, type: DestinationType, id: string | number): Promise<DeployDestinationResourceRow[]> {
  const r = await tx.execute<DeployDestinationResourceRow>(
    `SELECT r.type, r.uuid, r.name, e.uuid AS environment_uuid, e.name AS environment_name, p.uuid AS project_uuid, p.name AS project_name
       FROM (${ATTACHED}) r
       LEFT JOIN deploy.environments e ON e.id = r.environment_id
       LEFT JOIN deploy.projects p ON p.id = e.project_id
      ORDER BY r.ord, r.id`,
    [id, DESTINATION_MORPH_CLASS[type]],
  );
  return r.rows;
}
