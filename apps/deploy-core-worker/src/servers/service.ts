// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Server/{Index,Show,Delete}.php,
// app/Livewire/Server/New/ByIp.php, app/Livewire/Server/PrivateKey/Show.php and
// app/Models/Server.php (isFunctional, isTransferredAway, isSentinelEnabled, the
// created hook with its predefined shared variables, defaultStandaloneDockerAttributes)
// (Apache-2.0), modified.
//
// What the server Livewire components do without SSH, as plain operations on
// one org's servers. Everything that needs a connection to the server
// (validation, connection checks, server details) answers "not available yet".
import type {
  DeployPrivateKeyWithSecretRow,
  DeployServerListRow,
  DeployServerPrivateKeyRow,
  DeployServerRow,
  NewServer,
  ServerChanges,
  ServerSettingsChanges,
} from "@saas/db/deploy";
import { publicKeyOpenSSH } from "../keys/ssh-keys.js";
import { generateRandomName, newPublicId } from "../helpers/names.js";
import type { KeyCipher } from "../private-keys/service.js";
import { PRIVATE_KEY_MESSAGES } from "../private-keys/service.js";
import { normalizeServerIp } from "./ip.js";
import { SERVER_MESSAGES, timezones, type CreateServerInput, type ServerRole, type UpdateServerInput } from "./validation.js";

export interface ServerStore {
  list(): Promise<DeployServerListRow[]>;
  findByUuid(uuid: string): Promise<DeployServerRow | null>;
  insert(server: Omit<NewServer, "orgId">): Promise<DeployServerRow>;
  update(id: string | number, server: ServerChanges, settings: ServerSettingsChanges): Promise<boolean>;
  updateRole(id: string | number, role: ServerRole, disableSentinel: boolean): Promise<void>;
  setPrivateKey(id: string | number, privateKeyId: string | number): Promise<boolean>;
  delete(id: string | number): Promise<boolean>;
  sshEndpointInUse(ip: string, port: number, exceptId?: string | number | null): Promise<boolean>;
  otherBuildServerExists(exceptId: string | number): Promise<boolean>;
  privateKeys(): Promise<DeployServerPrivateKeyRow[]>;
  findPrivateKey(uuid: string): Promise<DeployPrivateKeyWithSecretRow | null>;
  /** A server-wide shared variable of the server (the created hook's predefined variables); `value` is encrypted. */
  addSharedVariable(variable: { serverId: string | number; key: string; value: string; isLiteral: boolean }): Promise<void>;
}

export interface ServerContext {
  store: ServerStore;
  cipher: KeyCipher;
  /** Encrypts the value column of shared variables ("shared_environment_variables.value"). */
  variables: KeyCipher;
}

/**
 * The server-wide shared variables the created hook adds to every server.
 * User compose files reference them ({{server.COOLIFY_SERVER_UUID}}), so the
 * keys are Coolify's byte for byte.
 */
export const PREDEFINED_SERVER_VARIABLE_KEYS = ["COOLIFY_SERVER_UUID", "COOLIFY_SERVER_NAME"] as const;

/** Copy shown to the user: Coolify's, word for word. */
export const SERVER_SERVICE_MESSAGES = {
  endpointInUse: "A server with this IP/Domain and SSH port already exists.",
  selectPrivateKey: "You must select a private key",
  transferredConnection: "The IP address, SSH user, and SSH port of a transferred server cannot be changed.",
  invalidTimezone: "Invalid timezone.",
  updated: "Server settings updated.",
  deploymentNeedsBuildServer: "Add a usable build server before you set this server to deployments only.",
  sentinelDisabled: "Sentinel has been disabled as build servers cannot run Sentinel.",
  keyNotAllowed: "You are not allowed to use this private key.",
  keyOfTransferred: "The private key of a transferred server cannot be changed.",
  keyUpdated: "Private key updated successfully.",
  validateFirst: "Validate the server connection before fetching details.",
  cannotRevalidate: "This server was transferred to another Freeploy instance. Manage it from the target instance instead.",
  /** Freeploy's: the SSH executor is not deployed yet. */
  validateUnavailable: "Validating the server needs the SSH executor, which is not available yet.",
  checkConnectionUnavailable: "Checking the connection needs the SSH executor, which is not available yet.",
  detailsUnavailable: "Fetching server details needs the SSH executor, which is not available yet.",
} as const;

/** A failure Coolify reports through a field error or dispatch('error'). */
export class ServerError extends Error {
  constructor(
    message: string,
    /** The field of a validation error, or null for a plain error toast. */
    readonly field: string | null = null,
    readonly status = 422,
  ) {
    super(message);
  }
}

/** Server::PLACEHOLDER_IPS */
const PLACEHOLDER_IPS = ["1.2.3.4", "0.0.0.0", "::"];

function metadata(row: { server_metadata: unknown }): Record<string, unknown> | null {
  const m = row.server_metadata;
  if (typeof m === "string") {
    try {
      return JSON.parse(m) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return m && typeof m === "object" ? (m as Record<string, unknown>) : null;
}

/** Server::isTransferredAway(): data_get($server_metadata, 'transfer.status') === 'transferred'. */
export function isTransferredAway(row: { server_metadata: unknown }): boolean {
  const transfer = metadata(row)?.transfer;
  return Boolean(transfer && typeof transfer === "object" && (transfer as Record<string, unknown>).status === "transferred");
}

/** Server::isFunctional(): reachable, usable, not disabled, a real address. */
export function isFunctional(row: Pick<DeployServerRow, "is_reachable" | "is_usable" | "force_disabled" | "ip">): boolean {
  return Boolean(row.is_reachable) && Boolean(row.is_usable) && row.force_disabled === false && !PLACEHOLDER_IPS.includes(row.ip);
}

/** ServerSetting::effectiveServerRole(). */
export function effectiveServerRole(row: Pick<DeployServerRow, "server_role" | "is_build_server">): ServerRole {
  if (row.server_role === "deployment" || row.server_role === "build" || row.server_role === "both") return row.server_role;
  return row.is_build_server ? "build" : "both";
}

/** Server::isSentinelEnabled(). */
export function isSentinelEnabled(row: DeployServerRow): boolean {
  const swarm = Boolean(row.is_swarm_manager) || Boolean(row.is_swarm_worker);
  return effectiveServerRole(row) !== "build" && !swarm && !row.force_disabled && !isTransferredAway(row);
}

export interface ServerListItem {
  uuid: string;
  name: string;
  description: string | null;
  status: "Transferred away" | "Disabled" | "Ready" | "Validation required";
  statusType: "success" | "error";
  /** definedResources()->count(): nothing can be deployed to a destination yet, so 0. */
  resourceCount: number;
}

/**
 * index.blade.php's $serverRows. "Attention required" (proxy or Sentinel) needs a
 * ready server, which needs SSH validation, so it does not occur yet; nor do patch badges.
 */
export function serverListItem(row: DeployServerListRow): ServerListItem {
  const transferred = isTransferredAway(row);
  const ready = Boolean(row.is_reachable) && Boolean(row.is_usable) && !row.force_disabled && !transferred;
  const status = transferred ? "Transferred away" : row.force_disabled ? "Disabled" : ready ? "Ready" : "Validation required";
  return { uuid: row.uuid, name: row.name, description: row.description, status, statusType: ready ? "success" : "error", resourceCount: 0 };
}

export async function listServers(ctx: ServerContext): Promise<ServerListItem[]> {
  return (await ctx.store.list()).map(serverListItem);
}

/** ByIp::mount(): a random name, and the org's keys for the picker (the first is preselected). */
export async function createServerOptions(ctx: ServerContext): Promise<{ name: string; privateKeys: Array<{ uuid: string; name: string }> }> {
  const keys = await ctx.store.privateKeys();
  return { name: generateRandomName(), privateKeys: keys.map((k) => ({ uuid: k.uuid, name: k.name })) };
}

/** The `user` mutator and the saving hook: characters SSH does not allow removed, trimmed. */
const cleanUser = (user: string) => user.replace(/[^A-Za-z0-9.\-_]/g, "").trim();

/** ByIp::submit() after validate(): the server stored unvalidated, as Coolify stores it before validation. */
export async function createServer(ctx: ServerContext, input: CreateServerInput): Promise<DeployServerRow> {
  // The exists rule on private_key_id: a key of this org.
  const key = input.privateKeyUuid === null ? null : await ctx.store.findPrivateKey(input.privateKeyUuid);
  if (input.privateKeyUuid !== null && !key) throw new ServerError(SERVER_MESSAGES.privateKeyInvalid, "private_key_uuid");
  const ip = normalizeServerIp(input.ip);
  if (await ctx.store.sshEndpointInUse(ip, input.port)) throw new ServerError(SERVER_SERVICE_MESSAGES.endpointInUse);
  if (!key) throw new ServerError(SERVER_SERVICE_MESSAGES.selectPrivateKey);
  const server = await ctx.store.insert({
    uuid: newPublicId(),
    name: input.name,
    description: input.description,
    ip: ip.trim(),
    user: cleanUser(input.user),
    port: input.port,
    privateKeyId: key.id,
    // The created hook's redirect_enabled, then ByIp's proxy status and type.
    proxy: { redirect_enabled: true, status: "exited", type: input.proxyType ?? "TRAEFIK" },
    serverRole: input.serverRole,
    imageScanEnabled: input.scanImages,
    // The created hook's default destination (network "coolify"): a row only, as Coolify saves it quietly.
    defaultDestinationUuid: newPublicId(),
  });
  // The created hook's predefined server shared variables: the uuid and the name, both literal.
  const predefined: Record<(typeof PREDEFINED_SERVER_VARIABLE_KEYS)[number], string> = { COOLIFY_SERVER_UUID: server.uuid, COOLIFY_SERVER_NAME: server.name };
  for (const variable of PREDEFINED_SERVER_VARIABLE_KEYS) {
    await ctx.store.addSharedVariable({ serverId: server.id, key: variable, value: await ctx.variables.encrypt(predefined[variable]), isLiteral: true });
  }
  return server;
}

export interface ServerShow {
  uuid: string;
  name: string;
  description: string | null;
  ip: string;
  user: string;
  port: number;
  connectionTimeout: number;
  serverTimezone: string;
  wildcardDomain: string | null;
  publicIpv4: string | null;
  publicIpv6: string | null;
  serverRole: ServerRole;
  isSwarmWorker: boolean;
  isSwarmManager: boolean;
  isCloudflareTunnel: boolean;
  /** Team::usesSwarm(): the org has a Swarm server (the menu's Swarm item). */
  usesSwarm: boolean;
  isFunctional: boolean;
  isTransferredAway: boolean;
  isForceDisabled: boolean;
  isLocalhost: boolean;
  isValidating: boolean;
  sshHostKeyPending: boolean;
  validationLogs: string | null;
  hasServerMetadata: boolean;
  hostingerVirtualMachineId: string | null;
  /** A cloud provider server is linked (the sidebar's Cloud Token item). */
  hasCloudProvider: boolean;
  privateKeyUuid: string | null;
}

/** Show::mount() → syncData(false). The Sentinel token is not part of this page. */
export function serverShow(row: DeployServerRow): ServerShow {
  return {
    uuid: row.uuid,
    name: row.name,
    description: row.description,
    ip: row.ip,
    user: row.user,
    port: Number(row.port),
    connectionTimeout: Number(row.connection_timeout ?? 10),
    serverTimezone: row.server_timezone ?? "UTC",
    wildcardDomain: row.wildcard_domain,
    publicIpv4: row.public_ipv4,
    publicIpv6: row.public_ipv6,
    serverRole: effectiveServerRole(row),
    isSwarmWorker: Boolean(row.is_swarm_worker),
    isSwarmManager: Boolean(row.is_swarm_manager),
    isCloudflareTunnel: Boolean(row.is_cloudflare_tunnel),
    usesSwarm: Boolean(row.org_uses_swarm),
    isFunctional: isFunctional(row),
    isTransferredAway: isTransferredAway(row),
    isForceDisabled: Boolean(row.force_disabled),
    isLocalhost: row.ip === "host.docker.internal",
    isValidating: Boolean(row.is_validating),
    sshHostKeyPending: Boolean(row.ssh_host_key_pending),
    validationLogs: row.validation_logs,
    hasServerMetadata: metadata(row) !== null,
    hostingerVirtualMachineId: row.hostinger_virtual_machine_id === null || row.hostinger_virtual_machine_id === undefined ? null : String(row.hostinger_virtual_machine_id),
    hasCloudProvider: Boolean(row.hetzner_server_id || row.vultr_instance_id || row.hostinger_virtual_machine_id),
    privateKeyUuid: row.private_key_uuid,
  };
}

export async function showServer(ctx: ServerContext, uuid: string): Promise<ServerShow | null> {
  const row = await ctx.store.findByUuid(uuid);
  return row ? serverShow(row) : null;
}

/** Show::submit() → syncData(true). */
export async function updateServer(ctx: ServerContext, uuid: string, input: UpdateServerInput): Promise<ServerShow | null> {
  const server = await ctx.store.findByUuid(uuid);
  if (!server) return null;
  const ip = normalizeServerIp(input.ip);
  const endpointChanged = ip !== normalizeServerIp(server.ip) || input.port !== Number(server.port);
  if (isTransferredAway(server) && (endpointChanged || cleanUser(input.user) !== server.user)) throw new ServerError(SERVER_SERVICE_MESSAGES.transferredConnection);
  // Only a changed IP or port is checked, so that an old duplicate does not block saving other fields.
  if (endpointChanged && (await ctx.store.sshEndpointInUse(ip, input.port, server.id))) throw new ServerError(SERVER_SERVICE_MESSAGES.endpointInUse);
  if (!timezones().includes(input.serverTimezone)) throw new ServerError(SERVER_SERVICE_MESSAGES.invalidTimezone);
  const localhost = server.ip === "host.docker.internal";
  await ctx.store.update(
    server.id,
    { name: input.name, description: input.description, ip: ip.trim(), user: cleanUser(input.user), port: input.port },
    {
      connectionTimeout: input.connectionTimeout,
      wildcardDomain: input.wildcardDomain,
      serverTimezone: input.serverTimezone,
      ...(localhost ? {} : { publicIpv4: input.publicIpv4, publicIpv6: input.publicIpv6 }),
    },
  );
  return showServer(ctx, uuid);
}

export type RoleChange = { confirm: true } | { serverRole: ServerRole; info: string | null };

/**
 * Show::requestServerRoleChange() and confirmServerRoleChange(): turning
 * builds on for a deployment-only server asks for confirmation first.
 */
export async function changeServerRole(ctx: ServerContext, uuid: string, role: ServerRole, confirmed: boolean): Promise<RoleChange | null> {
  const server = await ctx.store.findByUuid(uuid);
  if (!server) return null;
  const current = effectiveServerRole(server);
  // hasEnabledGithubRunners() and isEmpty() have nothing to find yet: GitHub runners and resources are not ported.
  if (role === "deployment" && !(await ctx.store.otherBuildServerExists(server.id))) throw new ServerError(SERVER_SERVICE_MESSAGES.deploymentNeedsBuildServer);
  if (role === "both" && current !== "both" && !confirmed) return { confirm: true };
  const disableSentinel = role === "build" && isSentinelEnabled(server);
  await ctx.store.updateRole(server.id, role, disableSentinel);
  return { serverRole: role, info: disableSentinel ? SERVER_SERVICE_MESSAGES.sentinelDisabled : null };
}

export interface ServerPrivateKeyItem {
  uuid: string;
  name: string;
  description: string | null;
  publicKey: string;
  isActive: boolean;
}

/** PrivateKey/Show::loadPrivateKeys(): the org's SSH keys (not Git ones), the server's own first. */
export async function serverPrivateKeys(ctx: ServerContext, uuid: string): Promise<{ server: ServerShow; privateKeys: ServerPrivateKeyItem[] } | null> {
  const server = await ctx.store.findByUuid(uuid);
  if (!server) return null;
  const keys = (await ctx.store.privateKeys()).filter((k) => !k.is_git_related);
  const ordered = [...keys.filter((k) => String(k.id) === String(server.private_key_id)), ...keys.filter((k) => String(k.id) !== String(server.private_key_id))];
  const items: ServerPrivateKeyItem[] = [];
  for (const k of ordered) {
    let publicKey: string;
    try {
      publicKey = await publicKeyOpenSSH(await ctx.cipher.decrypt(k.private_key));
    } catch {
      publicKey = PRIVATE_KEY_MESSAGES.publicKeyError;
    }
    items.push({ uuid: k.uuid, name: k.name, description: k.description, publicKey, isActive: k.uuid === server.private_key_uuid });
  }
  return { server: serverShow(server), privateKeys: items };
}

/**
 * PrivateKey/Show::setPrivateKey(). Coolify then checks the connection with the
 * new key and rolls back when it fails; that check needs the SSH executor, so
 * the key is stored unchecked, as a new server's key is.
 */
export async function setServerPrivateKey(ctx: ServerContext, uuid: string, privateKeyUuid: unknown): Promise<boolean> {
  const server = await ctx.store.findByUuid(uuid);
  if (!server) return false;
  const key = typeof privateKeyUuid === "string" && privateKeyUuid !== "" ? await ctx.store.findPrivateKey(privateKeyUuid) : null;
  if (!key) throw new ServerError(SERVER_SERVICE_MESSAGES.keyNotAllowed);
  if (isTransferredAway(server)) throw new ServerError(SERVER_SERVICE_MESSAGES.keyOfTransferred);
  return ctx.store.setPrivateKey(server.id, key.id);
}

/** Show::refreshServerMetadata(): without a validated connection there is nothing to fetch. */
export async function refreshServerMetadata(ctx: ServerContext, uuid: string): Promise<boolean> {
  const server = await ctx.store.findByUuid(uuid);
  if (!server) return false;
  if (!isFunctional(server)) throw new ServerError(SERVER_SERVICE_MESSAGES.validateFirst);
  throw new ServerError(SERVER_SERVICE_MESSAGES.detailsUnavailable, null, 501);
}

/** Show::validateServer() and PrivateKey/Show::checkConnection(): both need SSH. */
export async function unavailableOnServer(ctx: ServerContext, uuid: string, action: "validate" | "check-connection"): Promise<boolean> {
  const server = await ctx.store.findByUuid(uuid);
  if (!server) return false;
  if (action === "validate" && isTransferredAway(server)) throw new ServerError(SERVER_SERVICE_MESSAGES.cannotRevalidate);
  throw new ServerError(action === "validate" ? SERVER_SERVICE_MESSAGES.validateUnavailable : SERVER_SERVICE_MESSAGES.checkConnectionUnavailable, null, 501);
}

/**
 * Delete::delete(): the server, its destinations and its settings (rows only:
 * Coolify does not remove the networks from a server it deletes either).
 * Resources cannot exist yet, so nothing else is deleted or refused.
 */
export async function deleteServer(ctx: ServerContext, uuid: string): Promise<boolean> {
  const server = await ctx.store.findByUuid(uuid);
  if (!server) return false;
  return ctx.store.delete(server.id);
}
