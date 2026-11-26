// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/New/{Select,DockerImage}.php,
// app/Livewire/Project/Resource/{Index,Create}.php, app/Livewire/Project/Application/{Configuration,General,Heading}.php,
// app/Models/{Application,ApplicationSetting,BaseModel}.php (the creating, created and saving hooks, the
// custom_network_aliases mutator, stoppedAfterRestartLimit, server_status) and bootstrap/helpers/shared.php
// (find_resource_destination_for_current_team) (Apache-2.0), modified.
//
// What the New Resource, Docker Image, application Configuration/General and
// environment resources components do, as plain operations on one org's
// applications. Nothing here talks to a server: creating an application
// stores its rows and deploys nothing (DockerImage::submit() redirects to the
// configuration page without queueing a deployment), and Deploy, Restart and
// Stop need the SSH executor and the deployment Workflow, which do not exist
// yet.
import type {
  DeployEnvironmentServiceCanvasRow,
  ApplicationGeneralChanges,
  ApplicationWebhookSecretColumn,
  DeployApplicationDomainsRow,
  DeployApplicationRow,
  DeployDatabaseRow,
  DeployDestinationRow,
  DeployEnvironmentListRow,
  DeployProjectRow,
  DeployResourceServerRow,
  DeployServerRow,
  NewDockerImageApplication,
} from "@saas/db/deploy";
import { APPLICATION_WEBHOOK_SECRET_COLUMNS } from "@saas/db/deploy";
import { newPublicId, randomString } from "../helpers/names.js";
import { compareEnvironmentNames } from "../projects/service.js";
import { effectiveServerRole } from "../servers/service.js";
import { DATABASES, DOCKER_BASED_APPLICATIONS, GIT_BASED_APPLICATIONS, type ResourceType } from "./catalogue.js";
import { storedDockerImage } from "./docker-image.js";
import { domainConflicts, generateUrl, normalizeApplicationDomains, normalizeDomainPortOverrides, sslipDomainWarning, syncNoindexDomains, type DomainConflict } from "./domains.js";
import type { CreateDockerImageInput, GeneralInput } from "./validation.js";
import type { ApplicationLabelContext } from "./labels-service.js";
import type { ApplicationBuildContext } from "./create.js";
import type { ServiceListResource } from "../services/resources.js";
import { databaseResources, type DatabaseResource } from "../databases/service.js";

export interface ApplicationStore {
  findProject(uuid: string): Promise<DeployProjectRow | null>;
  findEnvironment(projectId: string | number, uuid: string): Promise<DeployEnvironmentListRow | null>;
  environments(projectId: string | number): Promise<DeployEnvironmentListRow[]>;
  /** Server::isUsable() / Server::isUsableBuildServer(), by name. */
  resourceServers(kind: "deployment" | "build"): Promise<DeployResourceServerRow[]>;
  /** The destinations of the usable servers. */
  usableDestinations(): Promise<DeployDestinationRow[]>;
  /** find_destination_for_current_team() */
  findDestination(uuid: string): Promise<DeployDestinationRow | null>;
  findServer(uuid: string): Promise<DeployServerRow | null>;
  /** Application::save() with the creating and created hooks. */
  insertDockerImage(application: Omit<NewDockerImageApplication, "orgId">): Promise<DeployApplicationRow>;
  findByUuid(uuid: string): Promise<DeployApplicationRow | null>;
  listForEnvironment(environmentId: string | number): Promise<DeployApplicationRow[]>;
  updateGeneral(id: string | number, changes: ApplicationGeneralChanges): Promise<DeployApplicationRow | null>;
  /** Every application of the org that has domains (checkDomainUsage). */
  domains(): Promise<DeployApplicationDomainsRow[]>;
  /** $environment->databases(): the environment's standalone databases (databases/service.ts); a store without it lists applications only. */
  listDatabasesForEnvironment?(environmentId: string | number): Promise<DeployDatabaseRow[]>;
  /** The environment's services with their tags (DP-66); none when the store does not list them. */
  listServicesForEnvironment?(environmentId: string | number): Promise<ServiceListResource[]>;
  /** The environment's services with their server and their parts, as the canvas draws them (DP-91); none when the store does not list them. */
  listServiceCanvasRows?(environmentId: string | number): Promise<DeployEnvironmentServiceCanvasRow[]>;
}

export interface ApplicationContext {
  store: ApplicationStore;
  /** Encrypts a value for one of deploy.applications' `encrypted` columns, under the org's key. */
  encrypt(column: ApplicationWebhookSecretColumn, plaintext: string): Promise<string>;
  /** The container labels and HTTP Basic Authentication (labels-service.ts); a context without it serves the application without them. */
  labels?: ApplicationLabelContext;
  /** The store of the applications that are built (create.ts, build.ts); a runner without it serves Docker image applications only. */
  build?: ApplicationBuildContext;
}

export const APPLICATION_SERVICE_MESSAGES = {
  /** DockerImage::submit(): throw new \Exception('Destination not found.') */
  destinationNotFound: "Destination not found.",
  /** General::submit() */
  updated: "Application settings updated!",
  /** lang/en.json warning.sslipdomain, its HTML left out. */
  sslipDomain:
    "Your configuration is saved, but sslip domain with https is NOT recommended, because Let's Encrypt servers with this public domain are rate limited (SSL certificate validation will fail). Use your own domain instead.",
  /** The domain conflict modal's question (General::checkFqdns). */
  domainConflicts: "Domains are already in use by other resources.",
  /** Freeploy's: the SSH executor and the deployment Workflow are not deployed yet. */
  deployUnavailable: "Deploying the application needs the SSH executor, which is not available yet.",
  restartUnavailable: "Restarting the application needs the SSH executor, which is not available yet.",
  stopUnavailable: "Stopping the application needs the SSH executor, which is not available yet.",
} as const;

/** A failure Coolify reports through an exception, a field error or dispatch('error'). */
export class ApplicationError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    /** The domain conflicts of a 409 (General's conflict modal). */
    readonly conflicts: DomainConflict[] | null = null,
  ) {
    super(message);
  }
}

/** Server::isSwarm(): a Swarm manager or worker. */
const isSwarm = (row: { is_swarm_manager: boolean | null; is_swarm_worker: boolean | null }): boolean => Boolean(row.is_swarm_manager) || Boolean(row.is_swarm_worker);

export interface NewResourceDestination {
  uuid: string;
  name: string;
  network: string;
  type: "standalone" | "swarm";
}

export interface NewResourceServer {
  uuid: string;
  name: string;
  description: string | null;
  ip: string;
  isSwarm: boolean;
  /** $server->standaloneDockers, then $server->swarmDockers. */
  destinations: NewResourceDestination[];
}

export interface NewResourcePage {
  project: { uuid: string; name: string };
  environment: { uuid: string; name: string };
  /** $project->environments, for the environment switcher. */
  environments: Array<{ uuid: string; name: string }>;
  servers: NewResourceServer[];
  buildServers: Array<{ uuid: string; name: string }>;
  onlyBuildServerAvailable: boolean;
  gitBasedApplications: readonly ResourceType[];
  dockerBasedApplications: readonly ResourceType[];
  databases: readonly ResourceType[];
  /** The one-click service templates: none yet (DP8 ports get_service_templates() and its 390 templates). */
  services: never[];
  categories: never[];
}

/**
 * Select::mount(), loadServers() and loadServices(): the project and its
 * environment, the usable servers with their destinations, the build servers
 * (listed but not selectable), and the resource types.
 */
export async function newResourcePage(ctx: ApplicationContext, projectUuid: string, environmentUuid: string): Promise<NewResourcePage | null> {
  const project = await ctx.store.findProject(projectUuid);
  if (!project) return null;
  const environments = await ctx.store.environments(project.id);
  const environment = environments.find((e) => e.uuid === environmentUuid);
  if (!environment) return null;
  const [servers, buildServers, destinations] = [await ctx.store.resourceServers("deployment"), await ctx.store.resourceServers("build"), await ctx.store.usableDestinations()];
  return {
    project: { uuid: project.uuid, name: project.name },
    environment: { uuid: environment.uuid, name: environment.name },
    environments: [...environments].sort((a, b) => compareEnvironmentNames(a.name, b.name)).map((e) => ({ uuid: e.uuid, name: e.name })),
    servers: servers.map((s) => ({
      uuid: s.uuid,
      name: s.name,
      description: s.description ?? null,
      ip: s.ip,
      isSwarm: isSwarm(s),
      destinations: destinations.filter((d) => d.server_uuid === s.uuid).map((d) => ({ uuid: d.uuid, name: d.name, network: d.network, type: d.type })),
    })),
    buildServers: buildServers.map((s) => ({ uuid: s.uuid, name: s.name })),
    onlyBuildServerAvailable: servers.length === 0 && buildServers.length > 0,
    gitBasedApplications: GIT_BASED_APPLICATIONS,
    dockerBasedApplications: DOCKER_BASED_APPLICATIONS,
    databases: DATABASES,
    services: [],
    categories: [],
  };
}

/**
 * DockerImage::submit(), after its validation. The destination is
 * find_resource_destination_for_current_team(): one of the org's, on a server
 * whose role can host resources. Then `new Application([...])->save()` — the
 * creating hook gives it a uuid and its four webhook secrets, the created hook
 * its settings row — and the update that names it "docker-image-<uuid>" and
 * gives it generateUrl()'s domain, which the saving hook stores without a
 * port (DomainPortOverrides). Nothing is deployed. Null when the project or
 * the environment is not the org's.
 */
export async function createDockerImageApplication(
  ctx: ApplicationContext,
  input: CreateDockerImageInput,
): Promise<{ uuid: string; projectUuid: string; environmentUuid: string } | null> {
  const image = storedDockerImage(input);
  const destination = input.destinationUuid ? await ctx.store.findDestination(input.destinationUuid) : null;
  const server = destination ? await ctx.store.findServer(destination.server_uuid) : null;
  if (!destination || !server || effectiveServerRole(server) === "build" || (input.serverUuid !== null && input.serverUuid !== server.uuid)) {
    throw new ApplicationError(APPLICATION_SERVICE_MESSAGES.destinationNotFound, 404);
  }
  const project = await ctx.store.findProject(input.projectUuid);
  if (!project) return null;
  const environment = await ctx.store.findEnvironment(project.id, input.environmentUuid);
  if (!environment) return null;

  const uuid = newPublicId();
  const domain = normalizeDomainPortOverrides(generateUrl({ ip: server.ip, wildcardDomain: server.wildcard_domain }, uuid), null);
  const webhookSecrets = {} as Record<ApplicationWebhookSecretColumn, string>;
  // Str::random(40) each.
  for (const column of APPLICATION_WEBHOOK_SECRET_COLUMNS) webhookSecrets[column] = await ctx.encrypt(column, randomString(40));
  const application = await ctx.store.insertDockerImage({
    uuid,
    name: `docker-image-${uuid}`,
    fqdn: domain.fqdn,
    domainPortOverrides: domain.overrides,
    dockerRegistryImageName: image.name,
    dockerRegistryImageTag: image.tag,
    environmentId: environment.id,
    destinationId: destination.id,
    destinationType: destination.type,
    webhookSecrets,
  });
  return { uuid: application.uuid, projectUuid: project.uuid, environmentUuid: environment.uuid };
}

/** The custom_network_aliases accessor: the stored JSON list as "a,b"; anything else as stored. */
export function networkAliasesForForm(stored: string | null): string | null {
  if (stored === null) return null;
  try {
    const decoded: unknown = JSON.parse(stored);
    return Array.isArray(decoded) ? decoded.join(",") : stored;
  } catch {
    return stored;
  }
}

/**
 * The custom_network_aliases mutator: a JSON list or a comma-separated one,
 * each alias trimmed with its spaces as "-", blanks and repeats left out,
 * stored as a JSON list — or null when nothing is left.
 */
export function networkAliasesForStorage(value: string | null): string | null {
  if (value === null || value === "") return null;
  let list: unknown;
  try {
    list = JSON.parse(value);
  } catch {
    list = undefined;
  }
  // A JSON value that is not a list (a number, a quoted string) is one alias, as collect() wraps it.
  if (list === undefined) list = value.split(",");
  else if (!Array.isArray(list)) list = list !== null && typeof list === "object" ? Object.values(list) : [list];
  const aliases: string[] = [];
  for (const alias of list as unknown[]) {
    if (typeof alias !== "string") continue;
    const clean = alias.trim().replace(/ /g, "-");
    // filter(): PHP's falsy strings ("" and "0") go.
    if (clean === "" || clean === "0" || aliases.includes(clean)) continue;
    aliases.push(clean);
  }
  return aliases.length ? JSON.stringify(aliases) : null;
}

const json = (value: unknown): unknown => {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

export interface ApplicationShow {
  uuid: string;
  name: string;
  description: string | null;
  fqdn: string | null;
  buildPack: string;
  /** The stored status: 'exited' until something is deployed. */
  status: string;
  /** Application::stoppedAfterRestartLimit() */
  stoppedAfterRestartLimit: boolean;
  /** container_present: null until a deployment has reported it. */
  containerPresent: boolean | null;
  dockerRegistryImageName: string | null;
  dockerRegistryImageTag: string | null;
  portsExposes: string | null;
  portsMappings: string | null;
  customNetworkAliases: string | null;
  /** Commands and options can embed credentials: null unless the caller may update (General::syncData). */
  customDockerRunOptions: string | null;
  preDeploymentCommand: string | null;
  preDeploymentCommandContainer: string | null;
  postDeploymentCommand: string | null;
  postDeploymentCommandContainer: string | null;
  isContainerLabelReadonlyEnabled: boolean;
  isContainerLabelEscapeEnabled: boolean;
  project: { uuid: string; name: string };
  environment: { uuid: string; name: string };
  destination: { uuid: string; name: string; network: string; type: "standalone" | "swarm" } | null;
  server: { uuid: string; name: string; ip: string; isSwarm: boolean } | null;
}

const destinationKind = (morph: string | null): "standalone" | "swarm" => (morph !== null && morph.endsWith("SwarmDocker") ? "swarm" : "standalone");

/** Configuration::mount() and General::syncData(): the application as the configuration pages read it. */
export function applicationShow(row: DeployApplicationRow, canUpdate: boolean): ApplicationShow {
  const secret = (value: string | null): string | null => (canUpdate ? (value ?? null) : null);
  return {
    uuid: row.uuid,
    name: row.name,
    description: row.description ?? null,
    fqdn: row.fqdn ?? null,
    buildPack: row.build_pack,
    status: row.status,
    stoppedAfterRestartLimit: row.status.startsWith("exited") && row.container_present === true && row.restart_limit_reached === true,
    containerPresent: row.container_present ?? null,
    dockerRegistryImageName: row.docker_registry_image_name ?? null,
    dockerRegistryImageTag: row.docker_registry_image_tag ?? null,
    portsExposes: row.ports_exposes ?? null,
    portsMappings: row.ports_mappings ?? null,
    customNetworkAliases: networkAliasesForForm(row.custom_network_aliases ?? null),
    customDockerRunOptions: secret(row.custom_docker_run_options),
    preDeploymentCommand: secret(row.pre_deployment_command),
    preDeploymentCommandContainer: row.pre_deployment_command_container ?? null,
    postDeploymentCommand: secret(row.post_deployment_command),
    postDeploymentCommandContainer: row.post_deployment_command_container ?? null,
    isContainerLabelReadonlyEnabled: row.is_container_label_readonly_enabled !== false,
    isContainerLabelEscapeEnabled: row.is_container_label_escape_enabled !== false,
    project: { uuid: row.project_uuid, name: row.project_name },
    environment: { uuid: row.environment_uuid, name: row.environment_name },
    destination:
      row.destination_uuid === null
        ? null
        : { uuid: row.destination_uuid, name: row.destination_name ?? "", network: row.destination_network ?? "", type: destinationKind(row.destination_type) },
    server:
      row.server_uuid === null
        ? null
        : { uuid: row.server_uuid, name: row.server_name ?? "", ip: row.server_ip ?? "", isSwarm: Boolean(row.server_is_swarm_manager) || Boolean(row.server_is_swarm_worker) },
  };
}

export async function showApplication(ctx: ApplicationContext, uuid: string, canUpdate: boolean): Promise<ApplicationShow | null> {
  const row = await ctx.store.findByUuid(uuid);
  return row ? applicationShow(row, canUpdate) : null;
}

export interface GeneralSaved {
  application: ApplicationShow;
  /** The success toast, or — for an https sslip domain — the warning Coolify shows in its place. */
  message: string;
  warning: boolean;
}

/**
 * General::submit() for a Docker image application, after its validation: a
 * changed fqdn is normalized (normalizeApplicationDomains), checked against
 * the org's other applications unless the save is forced, and stored without
 * ports by the saving hook (DomainPortOverrides, syncNoindexDomains); the
 * custom Docker options are trimmed; the network aliases go through the
 * model's mutator. Only columns whose value changes are written.
 */
export async function updateGeneral(ctx: ApplicationContext, uuid: string, input: GeneralInput): Promise<GeneralSaved | null> {
  const row = await ctx.store.findByUuid(uuid);
  if (!row) return null;
  const changes: ApplicationGeneralChanges = {};
  const set = (column: keyof ApplicationGeneralChanges, value: string | null | undefined, current: string | null): void => {
    if (value !== undefined && value !== current) changes[column] = value;
  };

  let fqdn = row.fqdn ?? null;
  if (input.fqdn !== undefined && input.fqdn !== row.fqdn) {
    // The saving hook: '' is null, then the domains without their ports and the ports apart.
    const normalized = normalizeDomainPortOverrides(normalizeApplicationDomains(input.fqdn), json(row.domain_port_overrides) as Record<string, number> | null);
    fqdn = normalized.fqdn;
    if (fqdn !== null && !input.forceSaveDomains) {
      const conflicts = domainConflicts({ uuid: row.uuid, fqdn }, await ctx.store.domains());
      if (conflicts.length) throw new ApplicationError(APPLICATION_SERVICE_MESSAGES.domainConflicts, 409, conflicts);
    }
    if (fqdn !== (row.fqdn ?? null)) {
      changes.fqdn = fqdn;
      changes.domain_port_overrides = normalized.overrides === null ? null : JSON.stringify(normalized.overrides);
      const noindex = syncNoindexDomains(json(row.noindex_domains), fqdn);
      if (noindex !== undefined) changes.noindex_domains = JSON.stringify(noindex);
    }
  }

  set("name", input.name, row.name);
  set("description", input.description, row.description);
  set("docker_registry_image_name", input.dockerRegistryImageName, row.docker_registry_image_name);
  set("docker_registry_image_tag", input.dockerRegistryImageTag, row.docker_registry_image_tag);
  set("ports_exposes", input.portsExposes, row.ports_exposes);
  set("ports_mappings", input.portsMappings, row.ports_mappings);
  if (input.customNetworkAliases !== undefined) set("custom_network_aliases", networkAliasesForStorage(input.customNetworkAliases), row.custom_network_aliases);
  // "if ($this->customDockerRunOptions) { … trim() }"
  set("custom_docker_run_options", input.customDockerRunOptions ? input.customDockerRunOptions.trim() : input.customDockerRunOptions, row.custom_docker_run_options);
  set("pre_deployment_command", input.preDeploymentCommand, row.pre_deployment_command);
  set("pre_deployment_command_container", input.preDeploymentCommandContainer, row.pre_deployment_command_container);
  set("post_deployment_command", input.postDeploymentCommand, row.post_deployment_command);
  set("post_deployment_command_container", input.postDeploymentCommandContainer, row.post_deployment_command_container);

  const saved = Object.keys(changes).length ? await ctx.store.updateGeneral(row.id, changes) : row;
  if (!saved) return null;
  // $warning = sslipDomainWarning($this->fqdn): the success toast shows only without it.
  const warning = sslipDomainWarning(fqdn);
  return { application: applicationShow(saved, true), message: warning ? APPLICATION_SERVICE_MESSAGES.sslipDomain : APPLICATION_SERVICE_MESSAGES.updated, warning };
}

export interface EnvironmentResource {
  uuid: string;
  name: string;
  type: "application";
  typeLabel: "Application";
  fqdn: string | null;
  description: string | null;
  status: string;
  restartLimitReached: boolean;
  restartCount: number;
  maxRestartCount: number;
  /** Application's server_status: the destination's server is functional. */
  server_status: boolean;
  /** How the application is built, for <x-resource-logo>. */
  buildPack: string;
  destination: { server: { name: string } };
  /** Tags are not ported yet. */
  tags: never[];
}

/** Server::PLACEHOLDER_IPS */
const PLACEHOLDER_IPS = ["1.2.3.4", "0.0.0.0", "::"];

/** Index::toSearchableArray() for an application. */
export function environmentResource(row: DeployApplicationRow): EnvironmentResource {
  const restartLimitReached = row.status.startsWith("exited") && row.container_present === true && row.restart_limit_reached === true;
  const functional = Boolean(row.server_is_reachable) && Boolean(row.server_is_usable) && row.server_force_disabled === false && !PLACEHOLDER_IPS.includes(row.server_ip ?? "");
  return {
    uuid: row.uuid,
    name: row.name,
    type: "application",
    typeLabel: "Application",
    fqdn: row.fqdn ?? null,
    description: row.description ?? null,
    status: row.status ?? "",
    restartLimitReached,
    restartCount: restartLimitReached ? Math.max(Number(row.restart_count ?? 0), Number(row.max_restart_count ?? 0)) : Number(row.restart_count ?? 0),
    maxRestartCount: Number(row.max_restart_count ?? 0),
    server_status: row.server_uuid !== null && functional,
    buildPack: row.build_pack,
    destination: { server: { name: row.server_name ?? "Unknown" } },
    tags: [],
  };
}

export interface EnvironmentResources {
  project: { uuid: string; name: string };
  environment: { uuid: string; name: string };
  /** $this->environment->applications()…->sortBy('name'), then its databases, engine by engine, each sorted by name. */
  resources: Array<EnvironmentResource | DatabaseResource | ServiceListResource>;
}

/** Resource\Index::mount() + render(): the environment's applications, standalone databases and services. */
export async function environmentResources(ctx: ApplicationContext, projectUuid: string, environmentUuid: string): Promise<EnvironmentResources | null> {
  const project = await ctx.store.findProject(projectUuid);
  if (!project) return null;
  const environment = await ctx.store.findEnvironment(project.id, environmentUuid);
  if (!environment) return null;
  const rows = await ctx.store.listForEnvironment(environment.id);
  const databases = ctx.store.listDatabasesForEnvironment ? await ctx.store.listDatabasesForEnvironment(environment.id) : [];
  const services = ctx.store.listServicesForEnvironment ? await ctx.store.listServicesForEnvironment(environment.id) : [];
  return {
    project: { uuid: project.uuid, name: project.name },
    environment: { uuid: environment.uuid, name: environment.name },
    // sortBy('name'): PHP's regular comparison, stable.
    resources: [...rows.map(environmentResource).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), ...databaseResources(databases), ...services],
  };
}

export type ApplicationAction = "deploy" | "restart" | "stop";

/**
 * Heading::deploy(), restart() and stop(): each runs on the server (the
 * deployment job, docker restart/stop), so each answers 501 until the SSH
 * executor and the deployment Workflow exist. Null when the application is
 * not the org's.
 */
export async function unavailableAction(ctx: ApplicationContext, uuid: string, action: ApplicationAction): Promise<null> {
  if (!(await ctx.store.findByUuid(uuid))) return null;
  const message = { deploy: APPLICATION_SERVICE_MESSAGES.deployUnavailable, restart: APPLICATION_SERVICE_MESSAGES.restartUnavailable, stop: APPLICATION_SERVICE_MESSAGES.stopUnavailable }[action];
  throw new ApplicationError(message, 501);
}
