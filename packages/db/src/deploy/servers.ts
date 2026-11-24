// Derived from coollabsio/coolify@91b7e3e:app/Models/Server.php (booted hooks, ownedByCurrentTeam,
// sshEndpointInUse, buildServers), app/Models/ServerSetting.php (forgetSshHostKey) and
// app/Livewire/Server/{Index,Show,Delete,PrivateKey/Show}.php and New/ByIp.php, and app/Models/Team.php
// (usesSwarm) (Apache-2.0), modified.
//
// deploy.servers and deploy.server_settings queries. Every function takes the
// transaction of withOrg(): row-level security confines each query to that
// org, which is what Coolify's ownedByCurrentTeam() / whereTeamId() does.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** What the server list (Index) shows per server. */
export interface DeployServerListRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  description: string | null;
  is_reachable: boolean | null;
  is_usable: boolean | null;
  force_disabled: boolean | null;
  server_metadata: unknown;
}

/** Index: Server::ownedByCurrentTeam() (ordered by name), with the settings the status needs. */
export async function listServers(tx: SqlExecutor): Promise<DeployServerListRow[]> {
  const r = await tx.execute<DeployServerListRow>(
    `SELECT s.id, s.uuid, s.name, s.description, ss.is_reachable, ss.is_usable, ss.force_disabled, s.server_metadata
       FROM deploy.servers s LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id
      WHERE s.deleted_at IS NULL
      ORDER BY s.name, s.id`,
  );
  return r.rows;
}

/** A server with its settings (Show, PrivateKey/Show, Delete). */
export interface DeployServerRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  description: string | null;
  ip: string;
  port: number;
  user: string;
  private_key_id: string | number;
  /** The uuid of the server's private key, when the key still exists. */
  private_key_uuid: string | null;
  proxy: unknown;
  validation_logs: string | null;
  server_metadata: unknown;
  is_validating: boolean;
  hetzner_server_id: string | number | null;
  vultr_instance_id: string | null;
  hostinger_virtual_machine_id: string | number | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
  // server_settings
  settings_id: string | number | null;
  is_reachable: boolean | null;
  is_usable: boolean | null;
  force_disabled: boolean | null;
  is_swarm_manager: boolean | null;
  is_swarm_worker: boolean | null;
  is_build_server: boolean | null;
  server_role: string | null;
  connection_timeout: number | null;
  wildcard_domain: string | null;
  public_ipv4: string | null;
  public_ipv6: string | null;
  server_timezone: string | null;
  is_metrics_enabled: boolean | null;
  is_sentinel_enabled: boolean | null;
  is_image_scan_enabled: boolean | null;
  ssh_host_key_pending: string | null;
  is_cloudflare_tunnel: boolean | null;
  /** Team::usesSwarm() for the server's org (the sidebar's Swarm item). */
  org_uses_swarm: boolean;
}

const SERVER_COLUMNS = [
  "id", "uuid", "name", "description", "ip", "port", "user", "private_key_id", "proxy", "validation_logs", "server_metadata",
  "is_validating", "hetzner_server_id", "vultr_instance_id", "hostinger_virtual_machine_id", "created_at", "updated_at",
].map((c) => `s."${c}"`);
const SETTINGS_COLUMNS = [
  "is_reachable", "is_usable", "force_disabled", "is_swarm_manager", "is_swarm_worker", "is_build_server", "server_role", "connection_timeout",
  "wildcard_domain", "public_ipv4", "public_ipv6", "server_timezone", "is_metrics_enabled", "is_sentinel_enabled", "is_image_scan_enabled",
  "ssh_host_key_pending", "is_cloudflare_tunnel",
].map((c) => `ss."${c}"`);
/** Team::usesSwarm(): see orgUsesSwarm() in server-settings.ts. */
const ORG_USES_SWARM = `(EXISTS (SELECT 1 FROM deploy.servers sw JOIN deploy.server_settings sws ON sws.server_id = sw.id
    WHERE sw.deleted_at IS NULL AND (sws.is_swarm_manager OR sws.is_swarm_worker))
  OR EXISTS (SELECT 1 FROM deploy.swarm_dockers d JOIN deploy.servers sd ON sd.id = d.server_id WHERE sd.deleted_at IS NULL)) AS org_uses_swarm`;

const SELECT_SERVER = `SELECT ${SERVER_COLUMNS.join(", ")}, k.uuid AS private_key_uuid, ss.id AS settings_id, ${SETTINGS_COLUMNS.join(", ")}, ${ORG_USES_SWARM}
  FROM deploy.servers s
  LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id
  LEFT JOIN deploy.private_keys k ON k.id = s.private_key_id`;

/** Server::ownedByCurrentTeam()->whereUuid($uuid)->first(), with its settings. */
export async function findServerByUuid(tx: SqlExecutor, uuid: string): Promise<DeployServerRow | null> {
  const r = await tx.execute<DeployServerRow>(`${SELECT_SERVER} WHERE s.uuid = $1 AND s.deleted_at IS NULL`, [uuid]);
  return r.rows[0] ?? null;
}

export interface NewServer {
  orgId: string;
  uuid: string;
  name: string;
  description: string | null;
  ip: string;
  user: string;
  port: number;
  privateKeyId: string | number;
  /** The proxy JSON (SchemalessAttributes), stored as given. */
  proxy: Record<string, unknown>;
  /** ServerSetting: server_role and is_build_server (ByIp::submit), is_image_scan_enabled (applyImageScanning). */
  serverRole: "deployment" | "build" | "both";
  imageScanEnabled: boolean;
}

/**
 * Team::createServerWithinLimit() → Server::create(), then the created hook's
 * ServerSetting::create(['server_id' => …]) and ByIp's settings save, in the
 * caller's transaction.
 */
export async function insertServer(tx: SqlExecutor, server: NewServer): Promise<DeployServerRow> {
  const r = await tx.execute<{ id: string | number }>(
    `INSERT INTO deploy.servers (uuid, name, description, ip, "user", port, private_key_id, proxy, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::json, $9, ${NOW}, ${NOW}) RETURNING id`,
    [server.uuid, server.name, server.description, server.ip, server.user, server.port, server.privateKeyId, JSON.stringify(server.proxy), server.orgId],
  );
  const id = r.rows[0]!.id;
  await tx.execute(
    `INSERT INTO deploy.server_settings (server_id, server_role, is_build_server, is_image_scan_enabled, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, ${NOW}, ${NOW})`,
    [id, server.serverRole, server.serverRole === "build", server.imageScanEnabled, server.orgId],
  );
  return (await findServerByUuid(tx, server.uuid))!;
}

export interface ServerChanges {
  name: string;
  description: string | null;
  ip: string;
  user: string;
  port: number;
}

export interface ServerSettingsChanges {
  connectionTimeout: number;
  wildcardDomain: string | null;
  /** Left as they are when undefined (the localhost server keeps them). */
  publicIpv4?: string | null;
  publicIpv6?: string | null;
  serverTimezone: string;
}

/**
 * Show::syncData(true): the server's columns (the saving hook keeps the old ip
 * in ip_previous; the saved hook forgets the SSH host key when the address
 * changes), then its settings.
 */
export async function updateServer(tx: SqlExecutor, id: string | number, server: ServerChanges, settings: ServerSettingsChanges): Promise<boolean> {
  const before = await tx.execute<{ ip: string; port: number }>(`SELECT ip, port FROM deploy.servers WHERE id = $1`, [id]);
  const old = before.rows[0];
  if (!old) return false;
  await tx.execute(
    `UPDATE deploy.servers
        SET name = $2, description = $3,
            ip_previous = CASE WHEN ip IS DISTINCT FROM $4 AND ip <> '' THEN ip ELSE ip_previous END,
            ip = $4, "user" = $5, port = $6, updated_at = ${NOW}
      WHERE id = $1`,
    [id, server.name, server.description, server.ip, server.user, server.port],
  );
  const params: unknown[] = [id, settings.connectionTimeout, settings.wildcardDomain, settings.serverTimezone];
  let publicSql = "";
  if (settings.publicIpv4 !== undefined || settings.publicIpv6 !== undefined) {
    params.push(settings.publicIpv4 ?? null, settings.publicIpv6 ?? null);
    publicSql = ", public_ipv4 = $5, public_ipv6 = $6";
  }
  await tx.execute(
    `UPDATE deploy.server_settings SET connection_timeout = $2, wildcard_domain = $3, server_timezone = $4${publicSql}, updated_at = ${NOW} WHERE server_id = $1`,
    params,
  );
  if (old.ip !== server.ip || Number(old.port) !== Number(server.port)) await forgetSshHostKey(tx, id);
  return true;
}

/** ServerSetting::forgetSshHostKey(): a changed address has another host key. */
export async function forgetSshHostKey(tx: SqlExecutor, serverId: string | number): Promise<void> {
  await tx.execute(
    `UPDATE deploy.server_settings SET ssh_host_key = NULL, ssh_host_key_source = NULL, ssh_host_key_trusted_at = NULL, ssh_host_key_pending = NULL
      WHERE server_id = $1 AND (ssh_host_key IS NOT NULL OR ssh_host_key_pending IS NOT NULL)`,
    [serverId],
  );
}

/**
 * Show::saveServerRole(): server_role and is_build_server; a build server
 * cannot run Sentinel, so `disableSentinel` turns metrics, debug and Sentinel off.
 */
export async function updateServerRole(tx: SqlExecutor, serverId: string | number, role: "deployment" | "build" | "both", disableSentinel: boolean): Promise<void> {
  const sentinelSql = disableSentinel ? ", is_metrics_enabled = false, is_sentinel_debug_enabled = false, is_sentinel_enabled = false" : "";
  await tx.execute(
    `UPDATE deploy.server_settings SET server_role = $2, is_build_server = $3${sentinelSql}, updated_at = ${NOW} WHERE server_id = $1`,
    [serverId, role, role === "build"],
  );
}

/** PrivateKey/Show::setPrivateKey(): $server->privateKey()->associate($key)->save(). */
export async function setServerPrivateKey(tx: SqlExecutor, serverId: string | number, privateKeyId: string | number): Promise<boolean> {
  const r = await tx.execute(`UPDATE deploy.servers SET private_key_id = $2, updated_at = ${NOW} WHERE id = $1 RETURNING id`, [serverId, privateKeyId]);
  return r.rows.length > 0;
}

/**
 * Delete::delete() and the DeleteServer job's forceDelete: the server and its
 * settings (the forceDeleting hook deletes settings()).
 */
export async function deleteServer(tx: SqlExecutor, id: string | number): Promise<boolean> {
  await tx.execute(`DELETE FROM deploy.server_settings WHERE server_id = $1`, [id]);
  const r = await tx.execute(`DELETE FROM deploy.servers WHERE id = $1 RETURNING id`, [id]);
  return r.rows.length > 0;
}

/**
 * Server::sshEndpointInUse($ip, $port, $exceptServerId): a server already uses
 * this IP and SSH port. Coolify looks across every team; here row-level
 * security confines the check to the org.
 */
export async function serverSshEndpointInUse(tx: SqlExecutor, ip: string, port: number, exceptId?: string | number | null): Promise<boolean> {
  const r =
    exceptId === undefined || exceptId === null
      ? await tx.execute(`SELECT 1 FROM deploy.servers WHERE ip = $1 AND port = $2 AND deleted_at IS NULL LIMIT 1`, [ip, port])
      : await tx.execute(`SELECT 1 FROM deploy.servers WHERE ip = $1 AND port = $2 AND id <> $3 AND deleted_at IS NULL LIMIT 1`, [ip, port, exceptId]);
  return r.rows.length > 0;
}

/**
 * Server::buildServers($teamId)->whereKeyNot($id)->exists(): another reachable,
 * usable, enabled build server of the org (the GitHub runner condition has no
 * table rows yet).
 */
export async function otherBuildServerExists(tx: SqlExecutor, exceptId: string | number): Promise<boolean> {
  const r = await tx.execute(
    `SELECT 1 FROM deploy.servers s JOIN deploy.server_settings ss ON ss.server_id = s.id
      WHERE s.id <> $1 AND s.deleted_at IS NULL
        AND ss.is_reachable AND ss.is_usable AND NOT ss.is_swarm_worker AND NOT ss.force_disabled
        AND (ss.server_role = 'build' OR (ss.server_role IS NULL AND ss.is_build_server))
      LIMIT 1`,
    [exceptId],
  );
  return r.rows.length > 0;
}

/** A private key for the server pages, with its stored (encrypted) key for the public key. */
export interface DeployServerPrivateKeyRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  description: string | null;
  is_git_related: boolean;
  private_key: string;
}

/** The org's private keys (ByIp's list, PrivateKey/Show::loadPrivateKeys before its filter and sort). */
export async function listServerPrivateKeys(tx: SqlExecutor): Promise<DeployServerPrivateKeyRow[]> {
  const r = await tx.execute<DeployServerPrivateKeyRow>(`SELECT id, uuid, name, description, is_git_related, private_key FROM deploy.private_keys ORDER BY id`);
  return r.rows;
}
