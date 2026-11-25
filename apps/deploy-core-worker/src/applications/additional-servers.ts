// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Shared/Destination.php,
// app/Models/Application.php (additional_networks, additionalServersUnavailableReason, proxyMismatchReason) and
// resources/views/livewire/project/shared/destination.blade.php (Apache-2.0), modified.
//
// An application's Servers page: its primary server and network, the servers
// it is also deployed to, and the servers it can be added to. Adding a server
// and making one primary are rows only, as in Coolify. Stopping, deploying
// and removing a server the application may run on need the SSH executor.
import { DEPLOY_UNIQUE_INDEXES, refusingDuplicates, type DeployDestinationServerRow, type DeployServerNetworkRow } from "@saas/db/deploy";
import { effectiveServerRole } from "../servers/service.js";
import type { ApplicationShow } from "./service.js";
import { SettingsError, jsonValue } from "./settings.js";
import { needsExecutor, text } from "./resources.js";
import { loadApplication, type ApplicationMoreContext, type LoadedApplication } from "./more.js";

type Body = Record<string, unknown>;
type Id = string | number;

export const SERVERS_MESSAGES = {
  /** findUsableServer(): dispatch('error', $title, …) */
  addFailed: "Failed to add server.",
  promoteFailed: "Failed to promote.",
  deployFailed: "Failed to deploy.",
  notReachable: (name: string) => `The server ${name} is not reachable. Check the connection on the server page and try again.`,
  cannotHost: (name: string) => `The server ${name} cannot host resources.`,
  /** Application::additionalServersUnavailableReason() */
  compose: "Docker Compose applications cannot use multiple servers.",
  persistentStorage: "Applications with persistent storage cannot use multiple servers because volumes are not shared between servers.",
  proxyMismatch: (primary: string, name: string, proxy: string) =>
    `The primary server uses ${primary} and ${name} uses ${proxy}. All servers of an application must use the same proxy, because they share the same proxy labels.`,
  /** redeploy(): the description's text (Coolify adds a link to its documentation). */
  imageNeeded: "Before deploying to multiple servers, you must first set a Docker image in the General tab.",
  /** promote(): handleError() on the pivot's unique index — the main destination is already an additional one. */
  duplicate: "Duplicate entry found. Please use a different name.",
  /** removeServer() */
  mainServer: "You are trying to remove the main server.",
  /** Freeploy's: the SSH executor is not deployed yet. */
  statusUnavailable: needsExecutor("Refreshing the status of the application's containers on the server"),
  stopUnavailable: needsExecutor("Stopping the application on the server"),
  deployUnavailable: needsExecutor("Deploying the application to the server"),
} as const;

export interface ServerCard {
  /** The network: standalone_dockers.id. */
  networkId: string;
  serverId: string;
  serverUuid: string;
  serverName: string;
  /** The Docker network's name (`network`). */
  network: string;
  /** The application's status there (the pivot's, or the application's own on the primary server). */
  status: string;
}

export interface AvailableNetwork {
  networkId: string;
  serverId: string;
  serverName: string;
  /** $network->name, which is what the view prints beside "Network". */
  name: string;
}

export interface ServersPage {
  application: ApplicationShow;
  /** Null when the destination or its server is gone. */
  primary: ServerCard | null;
  additional: ServerCard[];
  /** $networks: where the application can be added (empty for who may not update). */
  available: AvailableNetwork[];
  /** $resource->persistentStorages()->count() > 0: additional servers are unavailable. */
  hasPersistentStorage: boolean;
}

const proxyType = (proxy: unknown): string | null => {
  const value = jsonValue(proxy);
  const type = value && typeof value === "object" ? (value as { type?: unknown }).type : null;
  return typeof type === "string" ? type : null;
};

/** Server::canHostResources(): the effective role can deploy. */
const canHost = (s: Pick<DeployDestinationServerRow, "server_role" | "is_build_server">): boolean => effectiveServerRole(s) !== "build";
/** usableResourceServers() */
const usable = (s: Pick<DeployServerNetworkRow, "is_reachable" | "is_usable" | "is_swarm_worker" | "force_disabled">): boolean =>
  Boolean(s.is_reachable) && Boolean(s.is_usable) && !s.is_swarm_worker && !s.force_disabled;

const same = (a: Id | null | undefined, b: Id | null | undefined): boolean => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);

async function page(ctx: ApplicationMoreContext, l: LoadedApplication, canUpdate: boolean): Promise<ServersPage> {
  const additional = await ctx.store.additionalDestinations(l.row.id);
  const mainServerId = l.row.server_id;
  // Destination::loadData(): the standalone networks of the usable servers the caller may place a resource on,
  // without the application's own networks, its primary server and its additional servers.
  const attached = [l.frame.destination_id, ...additional.map((d) => d.id)];
  const available = canUpdate
    ? (await ctx.store.serverNetworks()).filter(
        (n) => usable(n) && canHost(n) && !attached.some((id) => same(id, n.id)) && !same(n.server_id, mainServerId) && !additional.some((d) => same(d.server_id, n.server_id)),
      )
    : [];
  return {
    application: l.application,
    primary:
      l.frame.destination_id === null || l.row.server_id === null
        ? null
        : {
            networkId: String(l.frame.destination_id),
            serverId: String(l.row.server_id),
            serverUuid: l.row.server_uuid ?? "",
            serverName: l.row.server_name ?? "",
            network: l.frame.destination_network ?? "",
            status: l.frame.status,
          },
    additional: additional.map((d) => ({ networkId: String(d.id), serverId: String(d.server_id), serverUuid: d.server_uuid, serverName: d.server_name, network: d.network, status: d.status })),
    available: available.map((n) => ({ networkId: String(n.id), serverId: String(n.server_id), serverName: n.server_name, name: n.name })),
    hasPersistentStorage: (await ctx.store.volumeCount(l.row.id)) > 0,
  };
}

/** Destination::mount() */
export async function showServers(ctx: ApplicationMoreContext, uuid: string, canUpdate: boolean): Promise<ServersPage | null> {
  const l = await loadApplication(ctx, uuid, canUpdate);
  return l ? page(ctx, l, canUpdate) : null;
}

export interface ServersSaved extends ServersPage {
  /** What could not run after the rows were stored. */
  unavailable?: string;
}

/** A row id of the body or the query: digits only. */
const idOf = (value: unknown): string | null => {
  const v = text(value);
  return typeof v === "string" && /^[1-9]\d{0,17}$/.test(v) ? v : null;
};

/**
 * findUsableServer(): the org's server by id (null: 404), refused with the
 * action's title when it cannot take a deployment right now.
 */
async function findUsableServer(ctx: ApplicationMoreContext, serverId: string, title: string): Promise<DeployDestinationServerRow | null> {
  const server = await ctx.store.findServer(serverId);
  if (!server) return null;
  if (!server.is_reachable || !server.is_usable) throw new SettingsError(title, 422, { description: SERVERS_MESSAGES.notReachable(server.name) });
  if (server.force_disabled || server.is_swarm_worker || !canHost(server)) throw new SettingsError(title, 422, { description: SERVERS_MESSAGES.cannotHost(server.name) });
  return server;
}

/** Application::additionalServersUnavailableReason($server) */
async function unavailableReason(ctx: ApplicationMoreContext, l: LoadedApplication, server: DeployDestinationServerRow): Promise<string | null> {
  if (l.row.build_pack === "dockercompose") return SERVERS_MESSAGES.compose;
  if ((await ctx.store.volumeCount(l.row.id)) > 0) return SERVERS_MESSAGES.persistentStorage;
  // proxyMismatchReason(): Traefik labels do not work on a Caddy server and the reverse.
  const routing = ["TRAEFIK", "CADDY"];
  const primary = proxyType(l.row.server_proxy);
  const other = proxyType(server.proxy);
  if (primary === null || other === null || !routing.includes(primary) || !routing.includes(other) || primary === other) return null;
  return SERVERS_MESSAGES.proxyMismatch(primary, server.name, other);
}

/**
 * Destination::addServer(): the network of a usable server becomes an
 * additional destination (syncWithoutDetaching). Rows only; nothing is
 * deployed there until the application is deployed. Null when the
 * application, the server or the network is not the org's.
 *
 * As in Coolify, nothing here refuses the application's own main network:
 * the page does not offer it, a direct call attaches it, and promote() is
 * where that row is in the way.
 */
export async function addServer(ctx: ApplicationMoreContext, uuid: string, body: Body): Promise<ServersSaved | null> {
  const l = await loadApplication(ctx, uuid, true);
  const serverId = idOf(body.server_id);
  const networkId = idOf(body.network_id);
  if (!l || !serverId || !networkId) return null;
  const server = await findUsableServer(ctx, serverId, SERVERS_MESSAGES.addFailed);
  const network = server ? await ctx.store.findNetwork(server.id, networkId) : null;
  if (!server || !network) return null;
  const reason = await unavailableReason(ctx, l, server);
  if (reason) throw new SettingsError(SERVERS_MESSAGES.addFailed, 422, { description: reason });
  await ctx.store.attachDestination(l.row.id, server.id, network.id);
  return page(ctx, l, true);
}

/**
 * Destination::promote(): the additional network becomes the application's
 * main destination and the former main one an additional destination, in one
 * transaction. Coolify then reads the containers' status from the server
 * (refreshServers), which needs the SSH executor: the rows are stored and the
 * answer says what did not run.
 *
 * When the main destination is already one of the additional ones (see
 * addServer()), Coolify's attach() violates the pivot's unique index, its
 * transaction rolls back and handleError() shows "Duplicate entry found.":
 * nothing is promoted. Here the row is looked for first, with the same
 * answer and nothing changed; the index still answers for two promotions at
 * the same moment.
 */
export async function promoteServer(ctx: ApplicationMoreContext, uuid: string, networkId: string, body: Body): Promise<ServersSaved | null> {
  const l = await loadApplication(ctx, uuid, true);
  const serverId = idOf(body.server_id);
  if (!l || !serverId) return null;
  const server = await findUsableServer(ctx, serverId, SERVERS_MESSAGES.promoteFailed);
  const network = server ? await ctx.store.findNetwork(server.id, networkId) : null;
  if (!server || !network || !(await ctx.store.hasAdditionalDestination(l.row.id, server.id, network.id))) return null;
  const standaloneMain = l.application.destination?.type === "standalone" && l.frame.destination_id !== null && l.row.server_id !== null;
  const main = standaloneMain ? { serverId: l.row.server_id!, networkId: l.frame.destination_id! } : null;
  const duplicate = (): SettingsError => new SettingsError(SERVERS_MESSAGES.duplicate, 422);
  if (main && (await ctx.store.hasAdditionalDestination(l.row.id, main.serverId, main.networkId))) throw duplicate();
  await refusingDuplicates([DEPLOY_UNIQUE_INDEXES.additionalDestination], () => ctx.store.promoteDestination(l.row.id, { serverId: server.id, networkId: network.id }, main), duplicate);
  const reloaded = await loadApplication(ctx, uuid, true);
  return reloaded && { ...(await page(ctx, reloaded, true)), unavailable: SERVERS_MESSAGES.statusUnavailable };
}

/**
 * Whether nothing of the application can exist on a server: it never left
 * 'exited', no container of it is known, and no deployment was ever queued
 * (the Danger Zone's rule, DP-55).
 */
async function neverDeployed(ctx: ApplicationMoreContext, l: LoadedApplication): Promise<boolean> {
  return l.frame.status.startsWith("exited") && l.application.containerPresent !== true && !(await ctx.store.hasDeployments(l.row.id));
}

/**
 * Destination::removeServer(): Coolify stops the application on that server
 * first and then detaches the network. Where nothing of the application was
 * ever deployed there is nothing to stop and the row goes at once; otherwise
 * the stop needs the SSH executor and nothing is changed. Null when the
 * application or the server is not the org's.
 */
export async function removeServer(ctx: ApplicationMoreContext, uuid: string, networkId: string, serverIdRaw: unknown): Promise<ServersSaved | null> {
  const l = await loadApplication(ctx, uuid, true);
  const serverId = idOf(serverIdRaw);
  if (!l || !serverId) return null;
  if (same(l.row.server_id, serverId) && same(l.frame.destination_id, networkId)) throw new SettingsError(SERVERS_MESSAGES.mainServer, 422);
  const server = await ctx.store.findServer(serverId);
  if (!server) return null;
  const pivot = (await ctx.store.additionalDestinations(l.row.id)).find((d) => same(d.id, networkId) && same(d.server_id, serverId));
  if (pivot && !(pivot.status.startsWith("exited") && (await neverDeployed(ctx, l)))) throw new SettingsError(SERVERS_MESSAGES.stopUnavailable, 501);
  await ctx.store.detachDestination(l.row.id, serverId, networkId);
  return page(ctx, l, true);
}

/** Destination::stop(): 404 unless the application runs on that server; stopping it needs the SSH executor. */
export async function stopOnServer(ctx: ApplicationMoreContext, uuid: string, body: Body): Promise<null> {
  const l = await loadApplication(ctx, uuid, true);
  const serverId = idOf(body.server_id);
  const server = l && serverId ? await ctx.store.findServer(serverId) : null;
  if (!l || !server) return null;
  // runsOnServer()
  if (!same(l.row.server_id, server.id) && !(await ctx.store.hasAdditionalDestination(l.row.id, server.id))) return null;
  throw new SettingsError(SERVERS_MESSAGES.stopUnavailable, 501);
}

/**
 * Destination::redeploy(): Coolify's checks in its order — a Docker image
 * must be set before deploying to several servers, the server must be
 * usable, the network must be the application's on that server — and then
 * the deployment, which needs the SSH executor.
 */
export async function redeployOnServer(ctx: ApplicationMoreContext, uuid: string, networkId: string, body: Body): Promise<null> {
  const l = await loadApplication(ctx, uuid, true);
  const serverId = idOf(body.server_id);
  if (!l || !serverId) return null;
  const additional = await ctx.store.additionalDestinations(l.row.id);
  if (additional.length > 0 && (l.application.dockerRegistryImageName ?? "") === "") throw new SettingsError(SERVERS_MESSAGES.deployFailed, 422, { description: SERVERS_MESSAGES.imageNeeded });
  const server = await findUsableServer(ctx, serverId, SERVERS_MESSAGES.deployFailed);
  const network = server ? await ctx.store.findNetwork(server.id, networkId) : null;
  if (!server || !network) return null;
  // isAttachedDestination()
  const main = l.application.destination?.type === "standalone" && same(l.frame.destination_id, network.id);
  if (!main && !(await ctx.store.hasAdditionalDestination(l.row.id, server.id, network.id))) return null;
  throw new SettingsError(SERVERS_MESSAGES.deployUnavailable, 501);
}
