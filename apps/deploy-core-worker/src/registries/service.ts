// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Server/{DockerRegistries,Registries}.php,
// app/Livewire/Server/DockerRegistries/{Login,ServerRegistries}.php and
// app/Services/DockerRegistryLogins.php (usersOf, rows) (Apache-2.0), modified.
//
// What the Docker registries components do, as plain operations on one org's
// servers. Coolify stores nothing about a registry: a login lives only in the
// Docker config on the server ("Coolify does not save the token"), and the
// cards read that file over SSH each time. So nothing is stored here either,
// and every step that runs on the server needs the SSH executor, which is not
// deployed:
//
//   read    `cat ~/.docker/config.json`. Without it a card shows what the
//           database knows — the registries the server's resources use — and
//           says in the card's error line that the logins could not be read,
//           so no registry reads "Not logged in" (the view shows "Unknown").
//   login   `docker login` on each server: 501 after Coolify's validation;
//           the password is dropped.
//   check   `docker login` with the saved credentials: 501.
//   logout  `docker logout`: 501.
import type { DeployRegistryServerRow, DeployRegistryUserRow, DeployServerRow } from "@saas/db/deploy";
import { effectiveServerRole, isFunctional, ServerError, serverShow, type ServerShow } from "../servers/service.js";
import { normalizeRegistry, parseConfig, PROVIDERS, REGISTRY_PATTERN, registryFromImage, registryRows, type RegistryLogin, type RegistryRow, type RegistryUser } from "./logins.js";
import type { RegistryLoginInput } from "./validation.js";

export interface RegistryStore {
  servers(): Promise<DeployRegistryServerRow[]>;
  findServer(uuid: string): Promise<DeployServerRow | null>;
  imageUsers(serverId: string | number): Promise<DeployRegistryUserRow[]>;
  buildApplications(serverId: string | number): Promise<DeployRegistryUserRow[]>;
}

/** DockerRegistryLogins::READ_CONFIG on a server: the Docker config's text (it holds credentials). */
export type DockerConfigReader = (serverUuid: string) => Promise<string | null>;

export interface RegistryContext {
  store: RegistryStore;
  /** Null until the SSH executor is deployed. */
  readDockerConfig: DockerConfigReader | null;
}

export const REGISTRY_MESSAGES = {
  /** Coolify's, word for word. */
  notReachable: "The server is not reachable. Validate the server to read its registry logins.",
  configUnreadable: "Could not read the Docker configuration on this server.",
  invalidRegistry: "The registry name is not valid.",
  /** abort_if(…, 403): a chosen server is not one of the org's. */
  forbidden: "Forbidden",
  /** Freeploy's: the SSH executor is not deployed yet. */
  readUnavailable: "Reading the Docker configuration on the server needs the SSH executor, which is not available yet.",
  loginUnavailable: "Running docker login on the server needs the SSH executor, which is not available yet.",
  logoutUnavailable: "Running docker logout on the server needs the SSH executor, which is not available yet.",
} as const;

/** Laravel's filled(): not null and not a string that trims to nothing. */
const filled = (value: string | null): value is string => value !== null && value.replace(/^[ \n\r\t\v\0]+|[ \n\r\t\v\0]+$/g, "") !== "";

/** link(): the resource's configuration page, when its environment and project are known. */
function link(row: DeployRegistryUserRow): string | null {
  return row.project_uuid && row.environment_uuid ? `/project/${row.project_uuid}/environment/${row.environment_uuid}/${row.kind}/${row.uuid}` : null;
}

/**
 * DockerRegistryLogins::usersOf(): every resource that pulls or pushes a named
 * image on this server, with the registry of that image — applications with a
 * registry image, databases, services (once per registry), and for a build
 * server the applications it builds and pushes.
 */
export async function registryUsers(store: RegistryStore, server: Pick<DeployServerRow, "id" | "server_role" | "is_build_server">): Promise<Array<RegistryUser & { registry: string }>> {
  const user = (row: DeployRegistryUserRow & { image: string }) => ({ registry: registryFromImage(row.image), type: row.type, name: row.name, link: link(row) });
  const users: Array<RegistryUser & { registry: string }> = [];
  const services = new Set<string>();
  for (const row of await store.imageUsers(server.id)) {
    if (!filled(row.image)) continue;
    const entry = user({ ...row, image: row.image });
    if (row.type === "Service") {
      // ->unique(registry|link|name)
      const key = `${entry.registry}|${entry.link ?? ""}|${entry.name}`;
      if (services.has(key)) continue;
      services.add(key);
    }
    users.push(entry);
  }
  if (effectiveServerRole(server) === "build") {
    for (const row of await store.buildApplications(server.id)) if (filled(row.image)) users.push(user({ ...row, image: row.image }));
  }
  return users;
}

/** One server's registries card (ServerRegistries). */
export interface ServerRegistriesCard {
  uuid: string;
  name: string;
  /** Server::isFunctional(): New and the rows' Log in show only then. */
  isFunctional: boolean;
  registries: RegistryRow[];
  error: string | null;
}

type CardServer = Pick<DeployServerRow, "id" | "uuid" | "name" | "ip" | "is_reachable" | "is_usable" | "force_disabled" | "server_role" | "is_build_server">;

/**
 * ServerRegistries::loadRegistries(): the logins read from the server, with
 * the registries its resources use. A server that is not functional is not
 * asked; a functional one cannot be asked until the SSH executor is deployed.
 */
export async function registriesCard(ctx: RegistryContext, server: CardServer): Promise<ServerRegistriesCard> {
  const functional = isFunctional(server);
  let error: string | null = null;
  let loggedIn: Record<string, RegistryLogin> = {};
  if (!functional) error = REGISTRY_MESSAGES.notReachable;
  else if (!ctx.readDockerConfig) error = REGISTRY_MESSAGES.readUnavailable;
  else {
    try {
      loggedIn = parseConfig(await ctx.readDockerConfig(server.uuid));
    } catch {
      error = REGISTRY_MESSAGES.configUnreadable;
    }
  }
  return { uuid: server.uuid, name: server.name, isFunctional: functional, registries: registryRows(loggedIn, await registryUsers(ctx.store, server)), error };
}

/**
 * Login::render(): the provider listbox and each provider's preset. The host
 * pattern goes along as its source, for providerFor() on a row's Log in.
 */
export const REGISTRY_PROVIDERS = Object.entries(PROVIDERS).map(([value, p]) => ({
  value,
  label: p.label,
  registry: p.registry,
  username: p.username,
  placeholder: p.placeholder,
  hint: p.hint,
  hostPattern: p.hostPattern?.source ?? null,
}));

/** DockerRegistries::render(): a card per server of the org, by name. */
export async function registriesOverview(ctx: RegistryContext): Promise<{ servers: ServerRegistriesCard[]; providers: typeof REGISTRY_PROVIDERS }> {
  const servers: ServerRegistriesCard[] = [];
  for (const server of await ctx.store.servers()) servers.push(await registriesCard(ctx, server));
  return { servers, providers: REGISTRY_PROVIDERS };
}

/** Registries (server.registries): the server and its card. */
export async function serverRegistries(ctx: RegistryContext, uuid: string): Promise<{ server: ServerShow; card: ServerRegistriesCard; providers: typeof REGISTRY_PROVIDERS } | null> {
  const server = await ctx.store.findServer(uuid);
  if (!server) return null;
  return { server: serverShow(server), card: await registriesCard(ctx, server), providers: REGISTRY_PROVIDERS };
}

/**
 * Login::login() for a card's server: `docker login` on it. Coolify stores
 * nothing before or after, so there is nothing to keep: 501.
 */
export async function loginOnServer(ctx: RegistryContext, uuid: string, input: RegistryLoginInput): Promise<false> {
  void input;
  if (!(await ctx.store.findServer(uuid))) return false;
  throw new ServerError(REGISTRY_MESSAGES.loginUnavailable, null, 501);
}

/**
 * Login::targetServers() on the overview: every chosen server must be one of
 * the org's (abort_if(…, 403)). Called before the form is validated, as
 * Coolify does.
 */
export async function chosenServers(ctx: RegistryContext, uuids: string[]): Promise<string[]> {
  const own = new Set((await ctx.store.servers()).map((s) => s.uuid));
  if (uuids.some((uuid) => !own.has(uuid))) throw new ServerError(REGISTRY_MESSAGES.forbidden, null, 403);
  return uuids;
}

/** Login::login() on the overview: `docker login` on each chosen server — 501, nothing stored. */
export function loginOnServers(uuids: string[], input: RegistryLoginInput): never {
  void uuids;
  void input;
  throw new ServerError(REGISTRY_MESSAGES.loginUnavailable, null, 501);
}

/** normalizeRegistry() and REGISTRY_PATTERN on a registry named in a path: "The registry name is not valid." */
export function registryName(value: string): string {
  const registry = normalizeRegistry(value);
  if (registry.length > 255 || !REGISTRY_PATTERN.test(registry)) throw new ServerError(REGISTRY_MESSAGES.invalidRegistry);
  return registry;
}

/** ServerRegistries::testLogin(): `docker login` with the saved credentials. */
export async function checkRegistryLogin(ctx: RegistryContext, uuid: string, registry: string): Promise<false> {
  registryName(registry);
  if (!(await ctx.store.findServer(uuid))) return false;
  throw new ServerError(REGISTRY_MESSAGES.loginUnavailable, null, 501);
}

/** ServerRegistries::logout(): `docker logout` on the server. */
export async function logoutFromRegistry(ctx: RegistryContext, uuid: string, registry: string): Promise<false> {
  registryName(registry);
  if (!(await ctx.store.findServer(uuid))) return false;
  throw new ServerError(REGISTRY_MESSAGES.logoutUnavailable, null, 501);
}
