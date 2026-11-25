// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Destination/{Index,Show,Resources}.php,
// app/Livewire/Destination/New/Docker.php, app/Livewire/Server/Destinations.php and
// app/Models/{StandaloneDocker,SwarmDocker}.php (the created hook, attachedTo) (Apache-2.0), modified.
//
// What the destination Livewire components do, as plain operations on one
// org's destinations. A destination is a row here and a Docker network on its
// server. The three steps that run on the server need the SSH executor, which
// is not deployed; each follows the order Coolify itself keeps between the
// row and the command:
//
//   add     Coolify stores the row first; the created hook then creates the
//           network and ignores a failure (throwError false). So the row is
//           stored and the answer says the network step is not available yet.
//           (Starting the proxy creates every destination's network anyway:
//           ensureProxyNetworksExist.)
//   delete  Coolify removes the network first and deletes the row only when
//           that worked. So a standalone destination is not deleted: 501. A
//           Swarm destination has no command and is deleted.
//   scan    Only a command (docker network ls): 501, nothing stored.
import type { DeployDestinationResourceRow, DeployDestinationRow, DeployServerRow, DeployUsableServerRow, DestinationType, NewDestination } from "@saas/db/deploy";
import { DEPLOY_UNIQUE_INDEXES, refusingDuplicates } from "@saas/db/deploy";
import { kebab, newPublicId } from "../helpers/names.js";
import { ServerError, serverShow, type ServerShow } from "../servers/service.js";
import type { NewDestinationInput, UpdateDestinationInput } from "./validation.js";

export interface DestinationStore {
  usableServers(): Promise<DeployUsableServerRow[]>;
  listUsable(): Promise<DeployDestinationRow[]>;
  listForServer(serverId: string | number): Promise<DeployDestinationRow[]>;
  findByUuid(uuid: string): Promise<DeployDestinationRow | null>;
  findServer(uuid: string): Promise<DeployServerRow | null>;
  networkExists(type: DestinationType, serverId: string | number, network: string): Promise<boolean>;
  insert(destination: Omit<NewDestination, "orgId">): Promise<DeployDestinationRow>;
  rename(type: DestinationType, id: string | number, name: string): Promise<boolean>;
  delete(type: DestinationType, id: string | number): Promise<boolean>;
  isAttached(type: DestinationType, id: string | number): Promise<boolean>;
  resources(type: DestinationType, id: string | number): Promise<DeployDestinationResourceRow[]>;
}

export interface DestinationContext {
  store: DestinationStore;
}

export const DESTINATION_MESSAGES = {
  /** Coolify's, word for word. */
  saved: "Destination saved.",
  networkExists: "Network already added to this server.",
  hasResources: "You must delete all resources before deleting this destination.",
  /** Freeploy's: the SSH executor is not deployed yet. */
  createNetworkUnavailable: "Creating the Docker network on the server needs the SSH executor, which is not available yet.",
  removeNetworkUnavailable: "Removing the Docker network from the server needs the SSH executor, which is not available yet.",
  scanUnavailable: "Scanning the server for Docker networks needs the SSH executor, which is not available yet.",
} as const;

export interface DestinationItem {
  uuid: string;
  name: string;
  network: string;
  type: DestinationType;
  /** The views' label for the type. */
  typeLabel: "Standalone Docker" | "Docker Swarm";
  server: { uuid: string; name: string; ip: string };
}

export function destinationItem(row: DeployDestinationRow): DestinationItem {
  return {
    uuid: row.uuid,
    name: row.name,
    network: row.network,
    type: row.type,
    typeLabel: row.type === "swarm" ? "Docker Swarm" : "Standalone Docker",
    server: { uuid: row.server_uuid, name: row.server_name, ip: row.server_ip },
  };
}

/** New/Docker::generateName(): str("{$server->name}-{$network}")->kebab(). */
export const destinationName = (serverName: string, network: string): string => kebab(`${serverName}-${network}`);

export interface DestinationIndex {
  destinations: DestinationItem[];
  /** New/Docker's server listbox: the usable servers, each with the name the form starts with. */
  servers: Array<{ uuid: string; name: string; destinationName: string }>;
  /** New/Docker::mount(): a new public id as the network. */
  network: string;
}

/**
 * Index::mount(): the usable servers and their destinations. Destinations of a
 * server that is not usable (not validated, disabled, a build server) are not
 * listed, as in Coolify.
 */
export async function listDestinations(ctx: DestinationContext): Promise<DestinationIndex> {
  const network = newPublicId();
  const [servers, destinations] = [await ctx.store.usableServers(), await ctx.store.listUsable()];
  return {
    destinations: destinations.map(destinationItem),
    servers: servers.map((s) => ({ uuid: s.uuid, name: s.name, destinationName: destinationName(s.name, network) })),
    network,
  };
}

/** Show::mount(): find_destination_for_current_team(). */
export async function showDestination(ctx: DestinationContext, uuid: string): Promise<DestinationItem | null> {
  const row = await ctx.store.findByUuid(uuid);
  return row ? destinationItem(row) : null;
}

/** Show::submit() → syncData(true): the name. */
export async function updateDestination(ctx: DestinationContext, uuid: string, input: UpdateDestinationInput): Promise<DestinationItem | null> {
  const row = await ctx.store.findByUuid(uuid);
  if (!row) return null;
  await ctx.store.rename(row.type, row.id, input.name);
  return destinationItem({ ...row, name: input.name });
}

/**
 * Show::delete(). A standalone destination: refused while resources use it,
 * then Coolify disconnects the proxy from the network and removes the network
 * on the server, and deletes the row only after that succeeded — so without
 * the SSH executor the row stays and the answer is 501. A Swarm destination
 * has neither the guard nor a command: the row is deleted.
 *
 * Coolify's view disables the button for the default network ("coolify");
 * its delete() does not check, and neither does this.
 */
export async function deleteDestination(ctx: DestinationContext, uuid: string): Promise<boolean> {
  const row = await ctx.store.findByUuid(uuid);
  if (!row) return false;
  if (row.type === "standalone") {
    if (await ctx.store.isAttached(row.type, row.id)) throw new ServerError(DESTINATION_MESSAGES.hasResources);
    throw new ServerError(DESTINATION_MESSAGES.removeNetworkUnavailable, null, 501);
  }
  return ctx.store.delete(row.type, row.id);
}

export interface DestinationResource {
  uuid: string;
  type: "application" | "service" | "database";
  name: string;
  project: string | null;
  environment: string | null;
  url: string | null;
  search: string;
}

/** Resources::resourceRow(): the route is project.{type}.configuration. */
export function destinationResource(row: DeployDestinationResourceRow): DestinationResource {
  const url =
    row.project_uuid && row.environment_uuid ? `/project/${row.project_uuid}/environment/${row.environment_uuid}/${row.type}/${row.uuid}` : null;
  return {
    uuid: row.uuid,
    type: row.type,
    name: row.name,
    project: row.project_name,
    environment: row.environment_name,
    url,
    // strtolower(implode(' ', array_filter([...])))
    search: [row.type, row.name, row.project_name, row.environment_name].filter((v) => v !== null && v !== "" && v !== "0").join(" ").toLowerCase(),
  };
}

/**
 * Resources::mount(): the applications, services and databases deployed to a
 * standalone destination. For a Swarm destination Coolify redirects to its
 * General page; here the list is empty and the page redirects.
 */
export async function destinationResources(ctx: DestinationContext, uuid: string): Promise<{ destination: DestinationItem; resources: DestinationResource[] } | null> {
  const row = await ctx.store.findByUuid(uuid);
  if (!row) return null;
  const resources = row.type === "standalone" ? (await ctx.store.resources(row.type, row.id)).map(destinationResource) : [];
  return { destination: destinationItem(row), resources };
}

export interface ServerDestinations {
  server: ServerShow;
  destinations: DestinationItem[];
  /** New/Docker::mount($server_id): the form's starting name and network. */
  newDestination: { name: string; network: string };
}

/** Server/Destinations: $server->standaloneDockers->concat($server->swarmDockers). */
export async function serverDestinations(ctx: DestinationContext, serverUuid: string): Promise<ServerDestinations | null> {
  const server = await ctx.store.findServer(serverUuid);
  if (!server) return null;
  const network = newPublicId();
  return {
    server: serverShow(server),
    destinations: (await ctx.store.listForServer(server.id)).map(destinationItem),
    newDestination: { name: destinationName(server.name, network), network },
  };
}

/**
 * New/Docker::submit(): a Swarm server gets a Swarm destination, any other a
 * standalone one, unless the server already has that network. The row is
 * stored as Coolify stores it; a standalone destination's created hook would
 * now create the network on the server, which is not available yet (see the
 * top of this file) — `unavailable` says so. A Swarm destination has no hook.
 */
export async function addDestination(ctx: DestinationContext, serverUuid: string, input: NewDestinationInput): Promise<{ uuid: string; unavailable: string | null } | null> {
  const server = await ctx.store.findServer(serverUuid);
  if (!server) return null;
  const type: DestinationType = Boolean(server.is_swarm_manager) || Boolean(server.is_swarm_worker) ? "swarm" : "standalone";
  if (await ctx.store.networkExists(type, server.id, input.network)) throw new ServerError(DESTINATION_MESSAGES.networkExists);
  // unique(server_id, network): what two requests at once both found free.
  const row = await refusingDuplicates(
    [DEPLOY_UNIQUE_INDEXES.standaloneNetwork, DEPLOY_UNIQUE_INDEXES.swarmNetwork],
    () => ctx.store.insert({ type, uuid: newPublicId(), name: input.name, network: input.network, serverId: server.id }),
    () => new ServerError(DESTINATION_MESSAGES.networkExists),
  );
  return { uuid: row.uuid, unavailable: type === "standalone" ? DESTINATION_MESSAGES.createNetworkUnavailable : null };
}

/** Server/Destinations::scan(): `docker network ls` on the server. */
export async function scanDestinations(ctx: DestinationContext, serverUuid: string): Promise<boolean> {
  const server = await ctx.store.findServer(serverUuid);
  if (!server) return false;
  throw new ServerError(DESTINATION_MESSAGES.scanUnavailable, null, 501);
}
