// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Resource/Create.php (createResource, the
// one-click service part), app/Livewire/Project/New/Select.php (loadServices, serviceWebsiteUrl, the
// category list) and bootstrap/helpers/services.php (service_logo_urls) (Apache-2.0), modified.
//
// One-click services: the catalogue as the New Resource page lists it, and creating a service from a
// template — the service row, then its Compose file parsed into applications, databases, environment
// variables and volumes (parser.ts), all stored in one transaction. As with an application, creating
// stores the rows and deploys nothing. The service's own pages are a later task; `showService` answers
// what a first page needs: the service and its parts.
import type {
  DeployDestinationRow,
  DeployEnvironmentRow,
  DeployProjectRow,
  DeployServerRow,
  DeployServicePartRow,
  DeployServiceRow,
  DeployServiceServerRow,
  NewParsedService,
} from "@saas/db/deploy";
import { newPublicId } from "../helpers/names.js";
import { add, blank, type FieldErrors } from "../private-keys/validation.js";
import { effectiveServerRole } from "../servers/service.js";
import { LARAVEL } from "../servers/settings-validation.js";
import { serviceTemplateForType, serviceTemplates } from "./catalogue.js";
import { headline } from "./catalogue-build.js";
import { ComposeError } from "./compose-helpers.js";
import { createServiceFromTemplate, newServiceFromTemplate, type ServiceParserContext } from "./parser.js";
import { MemoryServiceStore } from "./store.js";

type Body = Record<string, unknown>;
type Result<T> = { ok: true; input: T } | { ok: false; errors: FieldErrors };

export const SERVICE_MESSAGES = {
  /** As for an application (APPLICATION_SERVICE_MESSAGES.destinationNotFound). */
  destinationNotFound: "Destination not found.",
  /** Freeploy's: Coolify sends the browser back to the dashboard when the type has no template. */
  templateNotFound: "The selected type is invalid.",
} as const;

export class ServiceError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// The catalogue for the New Resource page
// ---------------------------------------------------------------------------

/** One service of Select::loadServices(), without its Compose file. */
export interface ServiceTemplateItem {
  id: string;
  name: string;
  docsSlug: string;
  templateLastUpdated: string | null;
  website: string | null;
  logo: string;
  logo_default_url: string;
  documentation: string;
  slogan: string;
  tags: string[] | Record<string, string> | null;
  category: string | null;
  minversion: string;
  port?: string;
  amd_only?: true;
  arm_only?: true;
  outdated?: true;
}

const DEFAULT_LOGO = "svgs/default.webp";

/**
 * service_logo_urls(): the logo and the placeholder, both on Freeploy's own origin. Coolify's third URL,
 * the same file in its GitHub repository, is left out: Freeploy's pages load nothing from another host.
 */
export function serviceLogoUrls(logo: unknown): { logo: string; logo_default_url: string } {
  const asset = (path: string) => `/${path}`;
  const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  if (typeof logo !== "string" || logo === "" || base(logo) === base(DEFAULT_LOGO)) {
    return { logo: asset(DEFAULT_LOGO), logo_default_url: asset(DEFAULT_LOGO) };
  }
  let path = logo.startsWith("svg/") ? `svgs/${logo.slice("svg/".length)}` : logo;
  path = path.replace(/^\/+/, "");
  return { logo: asset(path), logo_default_url: asset(DEFAULT_LOGO) };
}

const PROJECT_PATH_SEGMENTS: Readonly<Record<string, number>> = { "github.com": 2, "gitlab.com": 2, "codeberg.org": 2, "hub.docker.com": 3 };

/**
 * Select::serviceWebsiteUrl(): the project's site from its documentation link — on a shared host the
 * path that names the project is kept. Coolify appends "?ref=coolify.io"; Freeploy does not claim to be
 * Coolify to the sites it links to.
 */
export function serviceWebsiteUrl(documentation: string | null | undefined): string | null {
  const match = /^(https?):\/\/([^/?#]+)([^?#]*)/i.exec(documentation ?? "");
  if (!match) return null;
  const scheme = (match[1] ?? "").toLowerCase();
  const host = (match[2] ?? "").replace(/^[^@]*@/, "").replace(/:\d+$/, "");
  if (host === "") return null;
  const key = host.toLowerCase().replace(/^www\./, "");
  const segments = (match[3] ?? "").split("/").filter((segment) => segment !== "" && segment !== "0");
  const projectPath = segments.slice(0, PROJECT_PATH_SEGMENTS[key] ?? 0).join("/");
  return `${scheme}://${host}/${projectPath}`.replace(/\/+$/, "");
}

/** The catalogue's documentation links carry Coolify's "?utm_source=coolify.io"; a link from Freeploy does not. */
export function withoutCoolifyTracking(documentation: string): string {
  return documentation.endsWith("?utm_source=coolify.io") ? documentation.slice(0, -"?utm_source=coolify.io".length) : documentation;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** CarbonImmutable::parse($timestamp)->timezone('UTC')->format('M j, Y H:i'), or null. */
export function templateLastUpdated(timestamp: unknown): string | null {
  if (typeof timestamp !== "string" || timestamp === "") return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${MONTHS[date.getUTCMonth()] ?? ""} ${date.getUTCDate()}, ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

const ACRONYMS = new Set(
  "ai api ci cd cms crm erp iot vpn vps dns ssl tls ssh ftp http https smtp imap pop3 sql nosql json xml yaml csv pdf sms mfa 2fa oauth saml jwt rest soap grpc graphql websocket webrtc p2p b2b b2c seo sem ppc roi kpi ui ux ide sdk cli gui cdn ddos dos xss csrf sqli rce lfi rfi ssrf xxe idor owasp gdpr hipaa pci dss iso nist cve cwe cvss".split(
    " ",
  ),
);

/** The categories of Select::loadServices(): split on commas, acronyms in upper case, in natural order without case. */
export function serviceCategories(services: readonly Pick<ServiceTemplateItem, "category">[]): string[] {
  const seen: string[] = [];
  for (const service of services) {
    if (!service.category || seen.includes(service.category)) continue;
    seen.push(service.category);
  }
  const categories: string[] = [];
  for (const category of seen.flatMap((value) => (value.includes(",") ? value.split(",").map((part) => part.trim()) : [value]))) {
    if (!categories.includes(category)) categories.push(category);
  }
  return categories
    .map((category) => (ACRONYMS.has(category.toLowerCase()) ? category.toUpperCase() : category))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
}

let listed: { services: ServiceTemplateItem[]; categories: string[] } | undefined;

/** Select::loadServices(): every template of the catalogue, and the categories to filter them by. */
export function listServiceTemplates(): { services: ServiceTemplateItem[]; categories: string[] } {
  if (!listed) {
    const services = Object.entries(serviceTemplates()).map(([id, entry]): ServiceTemplateItem => {
      const item: ServiceTemplateItem = {
        id,
        name: headline(id),
        docsSlug: id.toLowerCase(),
        templateLastUpdated: templateLastUpdated(entry.template_last_updated_at),
        website: serviceWebsiteUrl(entry.documentation),
        ...serviceLogoUrls(entry.logo),
        documentation: withoutCoolifyTracking(entry.documentation),
        slogan: entry.slogan,
        tags: entry.tags,
        category: entry.category,
        minversion: entry.minversion,
      };
      // The Compose file and the template's variables stay in the Worker.
      if (entry.port !== undefined) item.port = entry.port;
      if (entry.amd_only) item.amd_only = true;
      if (entry.arm_only) item.arm_only = true;
      if (entry.outdated) item.outdated = true;
      return item;
    });
    listed = { services, categories: serviceCategories(services) };
  }
  return listed;
}

// ---------------------------------------------------------------------------
// Creating a service
// ---------------------------------------------------------------------------

export interface CreateServiceInput {
  type: string;
  projectUuid: string;
  environmentUuid: string;
  /** Optional: when given, the destination must be one of this server's. */
  serverUuid: string | null;
  destinationUuid: string | null;
}

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

/** The route parameters and the query string of Coolify's page are the body's type, project_uuid, environment_uuid, server_uuid and destination_uuid. */
export function validateCreateService(body: Body): Result<CreateServiceInput> {
  const errors: FieldErrors = {};
  if (typeof body.type !== "string" || !body.type.startsWith("one-click-service-")) add(errors, "type", LARAVEL.in("type"));
  else if (!serviceTemplateForType(body.type)) add(errors, "type", SERVICE_MESSAGES.templateNotFound);
  for (const field of ["project_uuid", "environment_uuid"] as const) {
    if (blank(body[field])) add(errors, field, `The ${field.replace("_", " ")} field is required.`);
    else if (typeof body[field] !== "string" || !UUID_RE.test(body[field])) add(errors, field, `The selected ${field.replace("_", " ")} is invalid.`);
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  const uuid = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
  return { ok: true, input: { type: body.type as string, projectUuid: body.project_uuid as string, environmentUuid: body.environment_uuid as string, serverUuid: uuid(body.server_uuid), destinationUuid: uuid(body.destination_uuid) } };
}

export interface ServiceStore {
  findProject(uuid: string): Promise<DeployProjectRow | null>;
  findEnvironment(projectId: string | number, uuid: string): Promise<DeployEnvironmentRow | null>;
  findDestination(uuid: string): Promise<DeployDestinationRow | null>;
  findServer(uuid: string): Promise<DeployServerRow | null>;
  /** The server with what the parser reads of its settings and proxy. */
  serviceServer(serverId: string | number): Promise<DeployServiceServerRow | null>;
  insert(service: Omit<NewParsedService, "orgId">): Promise<string | number>;
  findByUuid(uuid: string): Promise<DeployServiceRow | null>;
  applications(serviceId: string | number): Promise<DeployServicePartRow[]>;
  databases(serviceId: string | number): Promise<DeployServicePartRow[]>;
}

export interface ServiceContext {
  store: ServiceStore;
  /** Encrypts an environment variable's value (environment_variables.value) under the org's key. */
  encryptVariable(plaintext: string): Promise<string>;
  /** Encrypts a file's content (local_file_volumes.content) under the org's key. */
  encryptFileContent(plaintext: string): Promise<string>;
}

/** What a test fixes: the uuids and the parser's sources of randomness and time. */
export interface ServiceCreateDependencies {
  newUuid?: () => string;
  parser?: Pick<ServiceParserContext, "magicValue" | "labels">;
}

export interface CreatedService {
  uuid: string;
  name: string;
  projectUuid: string;
  environmentUuid: string;
}

function proxyType(proxy: unknown): string | null {
  let value: unknown = proxy;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  const type = value !== null && typeof value === "object" ? (value as Record<string, unknown>).type : null;
  return typeof type === "string" ? type : null;
}

/**
 * Create::createResource() for a one-click service: the destination must be one of the org's, on a server
 * that can host resources; the service is created from the template, parsed, and stored with everything
 * the parser made. Null when the project or the environment is not the org's. Nothing is deployed.
 */
export async function createOneClickService(ctx: ServiceContext, input: CreateServiceInput, deps: ServiceCreateDependencies = {}): Promise<CreatedService | null> {
  const destination = input.destinationUuid ? await ctx.store.findDestination(input.destinationUuid) : null;
  const server = destination ? await ctx.store.findServer(destination.server_uuid) : null;
  if (!destination || !server || effectiveServerRole(server) === "build" || (input.serverUuid !== null && input.serverUuid !== server.uuid)) {
    throw new ServiceError(SERVICE_MESSAGES.destinationNotFound, 404);
  }
  const project = await ctx.store.findProject(input.projectUuid);
  if (!project) return null;
  const environment = await ctx.store.findEnvironment(project.id, input.environmentUuid);
  if (!environment) return null;
  const settings = await ctx.store.serviceServer(server.id);
  if (!settings) throw new ServiceError(SERVICE_MESSAGES.destinationNotFound, 404);

  const newUuid = deps.newUuid ?? (() => newPublicId());
  const created = newServiceFromTemplate({ type: input.type, uuid: newUuid() });
  if (!created) throw new ServiceError(SERVICE_MESSAGES.templateNotFound, 422);
  const memory = MemoryServiceStore.forService(created.service);
  try {
    createServiceFromTemplate(memory, created.environment, newServiceParserContext({ project, environment, destination, settings }, newUuid, deps));
  } catch (error) {
    // What Coolify shows as the exception's message.
    if (error instanceof ComposeError) throw new ServiceError(error.message, 422);
    throw error;
  }
  await insertParsedRows(ctx, memory, { environment, server, destination }, newUuid);
  return { uuid: memory.service.uuid, name: memory.service.name, projectUuid: project.uuid, environmentUuid: environment.uuid };
}

/** Where a new service goes: its project and environment, its server (with what the parser reads of it) and destination. */
export interface ServicePlacement {
  project: Pick<DeployProjectRow, "name">;
  environment: Pick<DeployEnvironmentRow, "id" | "name">;
  server: Pick<DeployServerRow, "id">;
  destination: Pick<DeployDestinationRow, "id" | "type" | "network">;
  settings: DeployServiceServerRow;
}

/** The parser's context for a service that is being created on `placement`. */
export function newServiceParserContext(placement: Omit<ServicePlacement, "server">, newUuid: () => string, deps: ServiceCreateDependencies = {}): ServiceParserContext {
  const { settings } = placement;
  return {
    server: {
      ip: settings.ip,
      wildcardDomain: settings.wildcard_domain,
      proxyType: proxyType(settings.proxy),
      generateExactLabels: settings.generate_exact_labels === true,
      traefikCertificateResolver: settings.traefik_certificate_resolver,
      isTrafficAnalyticsEnabled: settings.is_traffic_analytics_enabled === true,
      // Freeploy saves no proxy configuration yet, so the Caddy version is unknown: no `log_append` (labels-service.ts).
      caddySupportsLogAppend: false,
      // No application of a new service has log draining on.
      logDrainConfiguration: null,
    },
    destinationNetwork: placement.destination.network,
    projectName: placement.project.name,
    environmentName: placement.environment.name,
    newUuid,
    ...deps.parser,
  };
}

/** The rows the parser made in memory for a new service, stored (encrypted where the columns are) in one go. Answers the service's id. */
export async function insertParsedRows(ctx: ServiceContext, memory: MemoryServiceStore, placement: Pick<ServicePlacement, "environment" | "server" | "destination">, newUuid: () => string = () => newPublicId()): Promise<string | number> {
  const { environment, server, destination } = placement;
  const rows = memory.rows();
  const part = (row: (typeof rows.databases)[number]) => ({
    localId: row.id,
    uuid: row.uuid,
    name: row.name,
    humanName: row.human_name,
    ports: row.ports,
    image: row.image,
    excludeFromStatus: row.exclude_from_status,
    isLogDrainEnabled: row.is_log_drain_enabled,
    isGzipEnabled: row.is_gzip_enabled,
    isStripprefixEnabled: row.is_stripprefix_enabled,
    isMigrated: row.is_migrated,
    isRemovedFromCompose: row.is_removed_from_compose,
  });
  const variables: NewParsedService["variables"] = [];
  for (const row of rows.environmentVariables) {
    variables.push({
      uuid: newUuid(),
      key: row.key,
      value: row.value === null ? null : await ctx.encryptVariable(row.value),
      isPreview: row.is_preview,
      isRequired: row.is_required,
      isShared: row.is_shared,
      isLiteral: row.is_literal,
      isMultiline: row.is_multiline,
      comment: row.comment,
      version: row.version,
      preserveComposeNull: row.preserve_compose_null,
    });
  }
  const fileVolumes: NewParsedService["fileVolumes"] = [];
  for (const row of rows.fileVolumes) {
    fileVolumes.push({
      uuid: newUuid(),
      fsPath: row.fs_path ?? "",
      mountPath: row.mount_path,
      content: row.content === null ? null : await ctx.encryptFileContent(row.content),
      isDirectory: row.is_directory,
      isHostFile: row.is_host_file,
      variableFsPath: row.variable_fs_path,
      owner: { kind: row.resource_type, localId: row.resource_id },
    });
  }
  return ctx.store.insert({
    uuid: rows.service.uuid,
    name: rows.service.name,
    environmentId: environment.id,
    serverId: server.id,
    destinationId: destination.id,
    destinationType: destination.type,
    dockerComposeRaw: rows.service.docker_compose_raw ?? "",
    dockerCompose: rows.service.docker_compose,
    connectToDockerNetwork: rows.service.connect_to_docker_network,
    serviceType: rows.service.service_type,
    composeParsingVersion: rows.service.compose_parsing_version,
    isContainerLabelEscapeEnabled: rows.service.is_container_label_escape_enabled,
    includeCoolifyDefaultVariables: rows.service.include_coolify_default_variables,
    applications: rows.applications.map((row) => ({
      ...part(row),
      fqdn: row.fqdn,
      noindexDomains: row.noindex_domains,
      redirect: row.redirect,
      isForceHttpsEnabled: row.is_force_https_enabled,
      isPermanentRedirectEnabled: row.is_permanent_redirect_enabled,
      domainPortOverrides: row.domain_port_overrides,
      traefikCertificateResolver: row.traefik_certificate_resolver,
    })),
    databases: rows.databases.map(part),
    variables,
    persistentVolumes: rows.persistentVolumes.map((row) => ({ uuid: newUuid(), name: row.name, mountPath: row.mount_path ?? "", owner: { kind: row.resource_type, localId: row.resource_id } })),
    fileVolumes,
  });
}

// ---------------------------------------------------------------------------
// A service
// ---------------------------------------------------------------------------

export interface ServicePartItem {
  uuid: string;
  name: string;
  humanName: string | null;
  image: string | null;
  ports: string | null;
  status: string;
  fqdn: string | null;
  isRemovedFromCompose: boolean;
}

export interface ServiceItem {
  uuid: string;
  name: string;
  description: string | null;
  serviceType: string | null;
  project: { uuid: string; name: string };
  environment: { uuid: string; name: string };
  applications: ServicePartItem[];
  databases: ServicePartItem[];
  canWrite: boolean;
}

const partItem = (row: DeployServicePartRow): ServicePartItem => ({
  uuid: row.uuid,
  name: row.name,
  humanName: row.human_name,
  image: row.image,
  ports: row.ports,
  status: row.status,
  fqdn: row.fqdn,
  isRemovedFromCompose: row.is_removed_from_compose,
});

/** The service with its applications and databases, or null when it is not the org's. */
export async function showService(ctx: Pick<ServiceContext, "store">, uuid: string, canWrite: boolean): Promise<ServiceItem | null> {
  const row = await ctx.store.findByUuid(uuid);
  if (!row) return null;
  return {
    uuid: row.uuid,
    name: row.name,
    description: row.description,
    serviceType: row.service_type,
    project: { uuid: row.project_uuid, name: row.project_name },
    environment: { uuid: row.environment_uuid, name: row.environment_name },
    applications: (await ctx.store.applications(row.id)).map(partItem),
    databases: (await ctx.store.databases(row.id)).map(partItem),
    canWrite,
  };
}
