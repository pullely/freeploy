// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Service/{Configuration,Heading,StackForm,EditCompose,
// Index,ResourceCard}.php, app/Models/{Service,ServiceApplication,ServiceDatabase}.php (status, containerStatus,
// aggregateResourceStatuses, documentation, isDeployable, url, setEditableUrls, workdir),
// app/Services/ContainerStatusAggregator.php (aggregateFromStrings, resolveStatus), bootstrap/helpers/shared.php
// (redactLockedValuesInGeneratedCompose, checkDomainUsage) and app/Policies/ServicePolicy.php (Apache-2.0), modified.
//
// A stored service's configuration: the frame of its pages (Heading and the configuration sidebar), the General
// page (StackForm, with "Edit Compose file"), each application's and database's own settings (Index, which
// Coolify opens in a dialog from the service's resource card), and what needs a server — start, stop, restart,
// deploy, a part's restart — answering 501 as Freeploy has no SSH executor. A save loads the service's rows,
// changes them in memory with the same code the parser tests hold to Coolify's PHP (stack-form.ts, parser.ts),
// and writes back what changed (rows.ts), all in the org's transaction.
import type { DeployServiceConfigurationRow, DeployServicePartFullRow, ServicePartKind } from "@saas/db/deploy";
import { applicationDomainList, domainConflicts, domainWithoutPort, composeDomainUrl, normalizeApplicationDomains, normalizeDomainPortOverrides, splitDomainUrl, sslipDomainWarning, syncNoindexDomains, validateApplicationDomains } from "../applications/domains.js";
import { needsExecutor } from "../applications/resources.js";
import { escapeDollarSign } from "../labels/labels.js";
import { LARAVEL } from "../servers/settings-validation.js";
import { isFunctional } from "../servers/service.js";
import { APPLICATION_SERVICE_MESSAGES } from "../applications/service.js";
import type { FieldErrors } from "../private-keys/validation.js";
import { descriptionRules } from "../private-keys/validation.js";
import { resolveServiceTemplateKey, serviceTemplates } from "./catalogue.js";
import { headline } from "./catalogue-build.js";
import { StackFormError, STACK_FORM_MESSAGES, submitStackForm } from "./stack-form.js";
import { stackFormFields, type StackFormField } from "./extra-fields.js";
import type { ServiceParserContext } from "./parser.js";
import { loadServiceRows, writeServiceRows, type ServiceRowCiphers, type ServiceRowsStore } from "./rows.js";
import { withoutCoolifyTracking, type ServiceCreateDependencies } from "./service.js";

type Id = string | number;
type Body = Record<string, unknown>;

export const SERVICE_CONFIGURATION_MESSAGES = {
  /** Freeploy's: saveComposeConfigs() writes the files over SSH, after the rows are stored. */
  composeFilesUnavailable: needsExecutor("Writing the Compose file and its .env file to the server"),
  /** Heading::start(), forceDeploy(), stop(), restart(), pullAndRestartEvent(); ResourceCard::restart(). */
  start: needsExecutor("Deploying the service"),
  stop: needsExecutor("Stopping the service"),
  restart: needsExecutor("Restarting the service"),
  partRestart: needsExecutor("Restarting the container"),
  /** Index::instantSaveLogDrain() / instantSaveApplicationAdvanced() */
  logDrainDisabled: "Log drain is not enabled on the server. Please enable it first.",
  logDrainSaved: "You need to restart the service for the changes to take effect.",
  /** Index::instantSave() */
  publicPortRequired: "Public port is required.",
  mustBeStarted: "Database must be started to be publicly accessible.",
  publicAccessUnavailable: needsExecutor("Stopping the database's public proxy"),
  /** Index::submitDatabase(), submitApplication(), instantSaveApplicationSettings(), saveMaxRestartCount() */
  databaseSaved: "Database saved.",
  serviceSaved: "Service saved.",
  settingsSaved: "Settings saved.",
  maxRestartCountSaved: "Max restart count saved.",
  /** warning.sslipdomain, as for an application. */
  sslipDomain: APPLICATION_SERVICE_MESSAGES.sslipDomain,
  multipleDomains: "Some services do not support multiple domains, which can lead to problems and is NOT RECOMMENDED.<br><br>Only use multiple domains if you know what you are doing.",
  domainConflicts: APPLICATION_SERVICE_MESSAGES.domainConflicts,
  /** Index::deleteApplication() / deleteDatabase() */
  applicationDeleted: "Application deleted.",
  databaseDeleted: "Database deleted.",
  partDeleteUnavailable: needsExecutor("Removing the container from the server"),
} as const;

export class ServiceConfigurationError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    readonly fields: FieldErrors | null = null,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

export interface ServiceConfigurationStore extends ServiceRowsStore {
  find(uuid: string): Promise<DeployServiceConfigurationRow | null>;
  /** The org's applications and service applications with their domains (checkDomainUsage). */
  domainOwners(): Promise<{ uuid: string; name: string; fqdn: string | null }[]>;
  /** A part of the service has run, or may still exist on its server. */
  hasRun(serviceId: Id): Promise<boolean>;
  deletePart(kind: ServicePartKind, serviceId: Id, id: Id): Promise<boolean>;
}

export interface ServiceConfigurationContext {
  store: ServiceConfigurationStore;
  ciphers: ServiceRowCiphers;
}

// ---------------------------------------------------------------- status

/** ContainerStatusAggregator::aggregateFromStrings() for a service's parts (no restart count: a part's own). */
export function aggregateStatuses(statuses: readonly string[]): string {
  if (statuses.length === 0) return "exited";
  const flags = { running: false, restarting: false, unhealthy: false, unknown: false, healthStarting: false, exited: false, starting: false, paused: false, dead: false, degraded: false };
  for (const status of statuses) {
    if (status.includes("degraded")) {
      flags.degraded = true;
      if (status.includes("unhealthy")) flags.unhealthy = true;
    } else if (status.includes("restarting")) flags.restarting = true;
    else if (status.includes("running")) {
      flags.running = true;
      if (status.includes("unhealthy")) flags.unhealthy = true;
      if (status.includes("unknown")) flags.unknown = true;
      if (status.includes("starting")) flags.healthStarting = true;
    } else if (status.includes("exited")) flags.exited = true;
    else if (status.includes("created") || status.includes("starting")) flags.starting = true;
    else if (status.includes("paused")) flags.paused = true;
    else if (status.includes("dead") || status.includes("removing")) flags.dead = true;
  }
  if (flags.degraded || flags.restarting || (flags.running && flags.exited)) return "degraded:unhealthy";
  if (flags.running && flags.starting) return "starting:unknown";
  if (flags.running) return flags.unhealthy ? "running:unhealthy" : flags.healthStarting ? "running:starting" : flags.unknown ? "running:unknown" : "running:healthy";
  if (flags.dead) return "degraded:unhealthy";
  if (flags.paused) return "paused:unknown";
  if (flags.starting) return "starting:unknown";
  return "exited";
}

type StatusPart = Pick<DeployServicePartFullRow, "status" | "exclude_from_status" | "is_removed_from_compose">;

/** Service::containerStatus(): the parts' statuses, the excluded ones only when every part is excluded. */
export function serviceStatus(parts: readonly StatusPart[]): string {
  const collect = (excludedOnly: boolean) => {
    const statuses: string[] = [];
    for (const part of parts) {
      if (part.is_removed_from_compose) continue;
      const excluded = part.exclude_from_status || part.status.includes(":excluded");
      if (excluded !== excludedOnly) continue;
      statuses.push(part.status.split(":excluded")[0] ?? "");
    }
    return statuses;
  };
  const included = collect(false);
  if (included.length > 0) {
    const [status, health] = aggregateStatuses(included).split(":");
    return health ? `${status}:${health}` : (status ?? "");
  }
  const excluded = collect(true);
  if (excluded.length === 0) return "unknown:unknown:excluded";
  const [status, health] = aggregateStatuses(excluded).split(":");
  return status && health ? `${status}:${health}:excluded` : "exited";
}

// ---------------------------------------------------------------- the frame

/** ServiceApplication's url accessor: each domain with the port its override keeps. */
export function partUrl(row: Pick<DeployServicePartFullRow, "fqdn" | "domain_port_overrides">): string | null {
  if (row.fqdn === null || row.fqdn.trim() === "") return null;
  const overrides = (typeof row.domain_port_overrides === "string" ? (JSON.parse(row.domain_port_overrides) as unknown) : row.domain_port_overrides) as Record<string, number> | null;
  return row.fqdn
    .split(",")
    .map((url) => {
      const trimmed = url.trim();
      const canonical = domainWithoutPort(trimmed);
      const port = overrides?.[canonical];
      if (port === undefined || port === null) return trimmed;
      const parts = splitDomainUrl(canonical);
      return composeDomainUrl(parts.scheme, parts.host, String(port), parts.path);
    })
    .join(",");
}

export interface ServicePartSummary {
  kind: ServicePartKind;
  uuid: string;
  name: string;
  /** resource-card.blade.php: Str::headline(human_name ?? name). */
  displayName: string;
  humanName: string | null;
  description: string | null;
  image: string | null;
  status: string;
  fqdn: string | null;
  excludeFromStatus: boolean;
  isRemovedFromCompose: boolean;
  isMigrated: boolean;
}

export interface ServiceInfo {
  uuid: string;
  name: string;
  description: string | null;
  serviceType: string | null;
  project: { uuid: string; name: string };
  environment: { uuid: string; name: string };
  server: { uuid: string; name: string; isFunctional: boolean } | null;
  destination: { uuid: string; name: string; network: string } | null;
  /** Service::status */
  status: string;
  /** isDeployable: no required variable is empty. */
  isDeployable: boolean;
  /** Service::documentation(): the template's documentation, without Coolify's tracking parameter; null without a template. */
  documentation: string | null;
  composeParsingVersion: string;
  applications: ServicePartSummary[];
  databases: ServicePartSummary[];
}

/** Server::isFunctional() of the service's server. */
export const serviceServerIsFunctional = (row: DeployServiceConfigurationRow): boolean =>
  row.server_id !== null && isFunctional({ is_reachable: row.server_is_reachable, is_usable: row.server_is_usable, force_disabled: row.server_force_disabled, ip: row.server_ip ?? "" } as Parameters<typeof isFunctional>[0]);

/** Server::isLogDrainEnabled() of the service's server. */
const serverLogDrainEnabled = (row: DeployServiceConfigurationRow): boolean =>
  Boolean(row.server_is_logdrain_newrelic_enabled) || Boolean(row.server_is_logdrain_axiom_enabled) || Boolean(row.server_is_logdrain_custom_enabled) || Boolean(row.server_is_logdrain_cloudwatch_enabled);

function summary(kind: ServicePartKind, row: DeployServicePartFullRow): ServicePartSummary {
  return {
    kind,
    uuid: row.uuid,
    name: row.name,
    displayName: headline(row.human_name ? row.human_name : row.name),
    humanName: row.human_name,
    description: row.description,
    image: row.image,
    status: row.status,
    fqdn: kind === "application" ? partUrl(row) : null,
    excludeFromStatus: row.exclude_from_status,
    isRemovedFromCompose: row.is_removed_from_compose,
    isMigrated: row.is_migrated,
  };
}

/** Service::documentation() */
function documentation(name: string): string | null {
  const templates = serviceTemplates();
  // str($this->name)->beforeLast('-')
  const dash = name.lastIndexOf("-");
  const entry = templates[resolveServiceTemplateKey(dash === -1 ? name : name.slice(0, dash), templates)];
  return entry?.documentation ? withoutCoolifyTracking(entry.documentation) : null;
}

interface Loaded {
  row: DeployServiceConfigurationRow;
  applications: DeployServicePartFullRow[];
  databases: DeployServicePartFullRow[];
  info: ServiceInfo;
}

async function load(ctx: ServiceConfigurationContext, uuid: string): Promise<Loaded | null> {
  const row = await ctx.store.find(uuid);
  if (!row) return null;
  const applications = await ctx.store.parts("application", row.id);
  const databases = await ctx.store.parts("database", row.id);
  // missingRequiredEnvironmentVariables(): required, and its value is empty.
  const required = (await ctx.store.variables(row.id)).filter((variable) => variable.is_required);
  let missing = false;
  for (const variable of required) if (variable.value === null || (await ctx.ciphers.variables.decrypt(variable.value)) === "") missing = true;
  const info: ServiceInfo = {
    uuid: row.uuid,
    name: row.name,
    description: row.description,
    serviceType: row.service_type,
    project: { uuid: row.project_uuid, name: row.project_name },
    environment: { uuid: row.environment_uuid, name: row.environment_name },
    server: row.server_uuid ? { uuid: row.server_uuid, name: row.server_name ?? "", isFunctional: serviceServerIsFunctional(row) } : null,
    destination: row.destination_uuid ? { uuid: row.destination_uuid, name: row.destination_name ?? "", network: row.destination_network ?? "" } : null,
    status: serviceStatus([...applications, ...databases]),
    isDeployable: !missing,
    documentation: documentation(row.name),
    composeParsingVersion: row.compose_parsing_version,
    applications: applications.map((part) => summary("application", part)),
    databases: databases.map((part) => summary("database", part)),
  };
  return { row, applications, databases, info };
}

/** The service as the frame of every page reads it, or null when it is not the org's. */
export async function loadServiceInfo(ctx: ServiceConfigurationContext, uuid: string): Promise<{ info: ServiceInfo; row: DeployServiceConfigurationRow; parts: { kind: ServicePartKind; row: DeployServicePartFullRow }[] } | null> {
  const l = await load(ctx, uuid);
  return l ? { info: l.info, row: l.row, parts: [...l.applications.map((row) => ({ kind: "application" as const, row })), ...l.databases.map((row) => ({ kind: "database" as const, row }))] } : null;
}

// ---------------------------------------------------------------- General

/** The parser's context for the service's server and destination (as on creation, service.ts). */
export function serviceParserContext(row: DeployServiceConfigurationRow, deps: ServiceCreateDependencies = {}): ServiceParserContext {
  let proxy: unknown = row.server_proxy;
  if (typeof proxy === "string") {
    try {
      proxy = JSON.parse(proxy) as unknown;
    } catch {
      proxy = null;
    }
  }
  const type = proxy !== null && typeof proxy === "object" ? (proxy as Record<string, unknown>).type : null;
  return {
    server: {
      ip: row.server_ip ?? "",
      wildcardDomain: row.server_wildcard_domain,
      proxyType: typeof type === "string" ? type : null,
      generateExactLabels: row.server_generate_exact_labels === true,
      traefikCertificateResolver: row.server_traefik_certificate_resolver,
      isTrafficAnalyticsEnabled: row.server_is_traffic_analytics_enabled === true,
      caddySupportsLogAppend: false,
      logDrainConfiguration: null,
    },
    destinationNetwork: row.destination_network ?? "",
    projectName: row.project_name,
    environmentName: row.environment_name,
    ...(deps.newUuid ? { newUuid: deps.newUuid } : {}),
    ...deps.parser,
  };
}

export type GeneralField = Omit<StackFormField, "sortOrder">;

export interface ServiceGeneralPage {
  service: ServiceInfo;
  general: {
    name: string;
    description: string | null;
    connectToDockerNetwork: boolean;
    isContainerLabelEscapeEnabled: boolean;
    /** Only who may update the service sees the Compose files (they can hold credentials). */
    dockerComposeRaw: string | null;
    /** The generated file, locked values replaced by <locked>. */
    dockerCompose: string | null;
    fields: GeneralField[];
    isPasswordHiddenForMember: boolean;
  };
}

/**
 * redactLockedValuesInGeneratedCompose(): every locked variable's value, as written, with its dollar signs
 * escaped, with its quotes doubled and JSON-escaped, replaced by <locked> (the longest first, not again
 * in what was replaced); values shorter than 4 characters are left alone.
 */
export function redactLockedValues(compose: string | null, lockedValues: readonly string[]): string | null {
  if (compose === null || compose.trim() === "") return compose;
  const variants = new Set<string>();
  for (const value of lockedValues) {
    for (const variant of [value, escapeDollarSign(value), value.replace(/'/g, "''"), JSON.stringify(value).slice(1, -1).replace(/\\\//g, "/")]) if ([...variant].length >= 4) variants.add(variant);
  }
  if (variants.size === 0) return compose;
  const ordered = [...variants].sort((a, b) => b.length - a.length);
  let out = "";
  for (let index = 0; index < compose.length; ) {
    const match = ordered.find((variant) => compose.startsWith(variant, index));
    if (match) {
      out += "<locked>";
      index += match.length;
    } else {
      out += compose[index];
      index += 1;
    }
  }
  return out;
}

async function generalPage(ctx: ServiceConfigurationContext, l: Loaded, canUpdate: boolean): Promise<ServiceGeneralPage> {
  const rows = await loadServiceRows(ctx.store, l.row, ctx.ciphers);
  const locked = rows.store.environmentVariables().filter((row) => row.is_shown_once && row.value !== null).map((row) => row.value as string);
  return {
    service: l.info,
    general: {
      name: l.row.name,
      description: l.row.description,
      connectToDockerNetwork: l.row.connect_to_docker_network,
      isContainerLabelEscapeEnabled: l.row.is_container_label_escape_enabled,
      dockerComposeRaw: canUpdate ? l.row.docker_compose_raw : null,
      dockerCompose: canUpdate ? redactLockedValues(l.row.docker_compose, locked) : null,
      fields: stackFormFields(rows.store, !canUpdate).map(({ sortOrder: _sortOrder, ...field }) => field),
      isPasswordHiddenForMember: !canUpdate,
    },
  };
}

/** Configuration::mount() with StackForm::mount(). Null when the service is not the org's. */
export async function showServiceGeneral(ctx: ServiceConfigurationContext, uuid: string, canUpdate: boolean): Promise<ServiceGeneralPage | null> {
  const l = await load(ctx, uuid);
  return l ? generalPage(ctx, l, canUpdate) : null;
}

export interface ServiceSaved extends ServiceGeneralPage {
  message: string;
  /** What Coolify would now do on the server and cannot be done yet. */
  unavailable?: string;
  warnings?: string[];
}

/**
 * StackForm::submit() ("Save", and "Save changes" of the Compose dialog, which sends the edited file as
 * dockerComposeRaw): the rows changed in memory and written back. Coolify then asks Docker Compose on the
 * server to accept a changed file (skipped by Coolify when the server is not functional, and here always)
 * and writes the files on the server: that is reported as not available yet, after the rows are stored.
 */
export async function saveServiceGeneral(ctx: ServiceConfigurationContext, uuid: string, body: Body, deps: ServiceCreateDependencies = {}): Promise<ServiceSaved | null> {
  const l = await load(ctx, uuid);
  if (!l) return null;
  const rows = await loadServiceRows(ctx.store, l.row, ctx.ciphers);
  let saved;
  try {
    saved = submitStackForm(rows.store, body, { parser: serviceParserContext(l.row, deps), canManageEnvironment: true, description: l.row.description });
  } catch (error) {
    if (error instanceof StackFormError) throw new ServiceConfigurationError(error.message, 422, Object.keys(error.fields).length ? error.fields : null);
    throw error;
  }
  await writeServiceRows(ctx.store, rows, ctx.ciphers, deps.newUuid);
  if (saved.description !== l.row.description) await ctx.store.update("service", l.row.id, l.row.id, { description: saved.description });
  const after = await load(ctx, uuid);
  return { ...(await generalPage(ctx, after!, true)), message: saved.message, unavailable: SERVICE_CONFIGURATION_MESSAGES.composeFilesUnavailable, ...(saved.warnings.length ? { warnings: saved.warnings } : {}) };
}

const asBoolean = (value: unknown): boolean | null => (value === true || value === false ? value : value === "true" || value === 1 || value === "1" ? true : value === "false" || value === 0 || value === "0" ? false : null);

/** StackForm::instantSave(): the network setting alone. */
export async function saveServiceNetwork(ctx: ServiceConfigurationContext, uuid: string, body: Body): Promise<ServiceSaved | null> {
  const l = await load(ctx, uuid);
  if (!l) return null;
  const value = asBoolean(body.connectToDockerNetwork);
  // 'connectToDockerNetwork' => 'nullable', and the column is not nullable: null is saved as false.
  await ctx.store.update("service", l.row.id, l.row.id, { connect_to_docker_network: value === true });
  return { ...(await generalPage(ctx, (await load(ctx, uuid))!, true)), message: STACK_FORM_MESSAGES.settingsSaved };
}

/** EditCompose::instantSave(): "Escape special characters in labels". */
export async function saveServiceLabelEscape(ctx: ServiceConfigurationContext, uuid: string, body: Body): Promise<ServiceSaved | null> {
  const l = await load(ctx, uuid);
  if (!l) return null;
  const value = asBoolean(body.isContainerLabelEscapeEnabled);
  if (value === null) throw new ServiceConfigurationError(LARAVEL.required("isContainerLabelEscapeEnabled"), 422, { isContainerLabelEscapeEnabled: [LARAVEL.required("isContainerLabelEscapeEnabled")] });
  await ctx.store.update("service", l.row.id, l.row.id, { is_container_label_escape_enabled: value });
  return { ...(await generalPage(ctx, (await load(ctx, uuid))!, true)), message: STACK_FORM_MESSAGES.updated };
}

export const SERVICE_ACTIONS = ["start", "force-deploy", "stop", "restart", "pull-restart"] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

/** Heading's actions: each runs on the server. Null when the service is not the org's. */
export async function runServiceAction(ctx: ServiceConfigurationContext, uuid: string, action: ServiceAction): Promise<null> {
  if (!(await ctx.store.find(uuid))) return null;
  const message = action === "stop" ? SERVICE_CONFIGURATION_MESSAGES.stop : action === "restart" || action === "pull-restart" ? SERVICE_CONFIGURATION_MESSAGES.restart : SERVICE_CONFIGURATION_MESSAGES.start;
  throw new ServiceConfigurationError(message, 501);
}

// ---------------------------------------------------------------- an application's or database's settings

export interface ServicePartPage {
  service: ServiceInfo;
  part: ServicePartSummary & {
    isLogDrainEnabled: boolean;
    // Applications
    isGzipEnabled?: boolean;
    isStripprefixEnabled?: boolean;
    certificateResolverMode?: "server" | "none" | "custom";
    certificateResolverName?: string | null;
    maxRestartCount?: number;
    showCertificateResolver?: boolean;
    serverCertificateResolver?: string;
    // Databases
    publicPort?: number | null;
    publicPortTimeout?: number | null;
    isPublic?: boolean;
  };
}

/** ServerSetting::TRAEFIK_CERTIFICATE_RESOLVER_NONE */
const RESOLVER_NONE = "none";

async function loadPart(ctx: ServiceConfigurationContext, uuid: string, partUuid: string): Promise<{ l: Loaded; kind: ServicePartKind; row: DeployServicePartFullRow } | null> {
  const l = await load(ctx, uuid);
  if (!l) return null;
  const application = l.applications.find((row) => row.uuid === partUuid);
  if (application) return { l, kind: "application", row: application };
  const database = l.databases.find((row) => row.uuid === partUuid);
  return database ? { l, kind: "database", row: database } : null;
}

function partPage(l: Loaded, kind: ServicePartKind, row: DeployServicePartFullRow): ServicePartPage {
  const base = { ...summary(kind, row), isLogDrainEnabled: row.is_log_drain_enabled };
  if (kind === "database") return { service: l.info, part: { ...base, publicPort: row.public_port, publicPortTimeout: row.public_port_timeout, isPublic: row.is_public === true } };
  const resolver = row.traefik_certificate_resolver;
  const proxy = serviceParserContext(l.row).server.proxyType;
  return {
    service: l.info,
    part: {
      ...base,
      isGzipEnabled: row.is_gzip_enabled,
      isStripprefixEnabled: row.is_stripprefix_enabled,
      certificateResolverMode: resolver === null || resolver.trim() === "" ? "server" : resolver === RESOLVER_NONE ? "none" : "custom",
      certificateResolverName: resolver !== null && resolver.trim() !== "" && resolver !== RESOLVER_NONE ? resolver : null,
      maxRestartCount: row.max_restart_count ?? 0,
      showCertificateResolver: proxy === "TRAEFIK",
      serverCertificateResolver: l.row.server_traefik_certificate_resolver ?? RESOLVER_NONE,
    },
  };
}

/** Index::mount() for one application or database of the service. */
export async function showServicePart(ctx: ServiceConfigurationContext, uuid: string, partUuid: string): Promise<ServicePartPage | null> {
  const found = await loadPart(ctx, uuid, partUuid);
  return found ? partPage(found.l, found.kind, found.row) : null;
}

export interface ServicePartSaved extends ServicePartPage {
  message: string | null;
  warning?: string;
  unavailable?: string;
}

/** ServerSetting::TRAEFIK_CERTIFICATE_RESOLVER_PATTERN */
const RESOLVER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function integerRule(errors: FieldErrors, field: string, value: unknown, min: number, max?: number): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = typeof value === "number" ? value : typeof value === "string" && /^\s*-?\d+\s*$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n)) {
    (errors[field] ??= []).push(LARAVEL.integer(field));
    return undefined;
  }
  if (n < min) (errors[field] ??= []).push(LARAVEL.minNumeric(field, min));
  if (max !== undefined && n > max) (errors[field] ??= []).push(LARAVEL.maxNumeric(field, max));
  return n;
}

/**
 * Index's saves of one part, by `action`:
 *   submit          submitApplication() / submitDatabase(): the form
 *   settings        instantSaveApplicationSettings(): gzip, strip prefixes, exclude from status (an application's)
 *   exclude         instantSaveExclude(): a database's exclude from status
 *   logDrain        instantSaveLogDrain() / instantSaveApplicationAdvanced()
 *   maxRestartCount saveMaxRestartCount()
 *   publicAccess    instantSave(): a database's public port, which needs the database running
 *   restart         ResourceCard::restart(): needs the server (501)
 * Null when the service or the part is not the org's.
 */
export async function saveServicePart(ctx: ServiceConfigurationContext, uuid: string, partUuid: string, body: Body): Promise<ServicePartSaved | null> {
  const found = await loadPart(ctx, uuid, partUuid);
  if (!found) return null;
  const { l, kind, row } = found;
  const serviceId = l.row.id;
  const done = async (message: string | null, extra: Partial<ServicePartSaved> = {}): Promise<ServicePartSaved> => {
    const again = (await loadPart(ctx, uuid, partUuid))!;
    return { ...partPage(again.l, again.kind, again.row), message, ...extra };
  };
  const errors: FieldErrors = {};
  const fail = () => {
    if (Object.keys(errors).length) throw new ServiceConfigurationError(Object.values(errors).flat()[0] ?? "", 422, errors);
  };
  const flag = (field: string, fallback: boolean): boolean => {
    if (body[field] === undefined) return fallback;
    const value = asBoolean(body[field]);
    if (value === null) (errors[field] ??= []).push(LARAVEL.boolean(field));
    return value ?? fallback;
  };

  switch (body.action) {
    case "restart":
      throw new ServiceConfigurationError(SERVICE_CONFIGURATION_MESSAGES.partRestart, 501);
    case "logDrain": {
      const enabled = flag("isLogDrainEnabled", row.is_log_drain_enabled);
      fail();
      if (!serverLogDrainEnabled(l.row)) throw new ServiceConfigurationError(SERVICE_CONFIGURATION_MESSAGES.logDrainDisabled, 422);
      await ctx.store.update(kind, serviceId, row.id, { is_log_drain_enabled: enabled });
      return done(SERVICE_CONFIGURATION_MESSAGES.logDrainSaved);
    }
    case "settings": {
      if (kind !== "application") return null;
      const changes = { is_gzip_enabled: flag("isGzipEnabled", row.is_gzip_enabled), is_stripprefix_enabled: flag("isStripprefixEnabled", row.is_stripprefix_enabled), exclude_from_status: flag("excludeFromStatus", row.exclude_from_status) };
      fail();
      await ctx.store.update(kind, serviceId, row.id, changes);
      return done(SERVICE_CONFIGURATION_MESSAGES.settingsSaved);
    }
    case "exclude": {
      if (kind !== "database") return null;
      const exclude = flag("excludeFromStatus", row.exclude_from_status);
      fail();
      await ctx.store.update(kind, serviceId, row.id, { exclude_from_status: exclude });
      return done(SERVICE_CONFIGURATION_MESSAGES.databaseSaved);
    }
    case "maxRestartCount": {
      if (kind !== "application") return null;
      const count = integerRule(errors, "maxRestartCount", body.maxRestartCount ?? 0, 0);
      fail();
      await ctx.store.update(kind, serviceId, row.id, { max_restart_count: count ?? 0, restart_limit_reached: false });
      return done(SERVICE_CONFIGURATION_MESSAGES.maxRestartCountSaved);
    }
    case "publicAccess": {
      if (kind !== "database") return null;
      const isPublic = flag("isPublic", row.is_public === true);
      const port = integerRule(errors, "publicPort", body.publicPort, 1, 65535);
      const timeout = integerRule(errors, "publicPortTimeout", body.publicPortTimeout, 1);
      fail();
      const publicPort = port === undefined ? row.public_port : port;
      if (isPublic) {
        if (!publicPort) throw new ServiceConfigurationError(SERVICE_CONFIGURATION_MESSAGES.publicPortRequired, 422);
        if (!row.status.startsWith("running")) throw new ServiceConfigurationError(SERVICE_CONFIGURATION_MESSAGES.mustBeStarted, 422);
      }
      // Turning it off stops the proxy on the server (StopDatabaseProxy) once the row is saved.
      await ctx.store.update(kind, serviceId, row.id, { is_public: isPublic, public_port: publicPort || null, public_port_timeout: (timeout === undefined ? row.public_port_timeout : timeout) || null });
      return done(null, { unavailable: SERVICE_CONFIGURATION_MESSAGES.publicAccessUnavailable });
    }
    case "submit":
      break;
    default:
      throw new ServiceConfigurationError("The selected action is invalid.", 422, { action: ["The selected action is invalid."] });
  }

  // submitApplication() / submitDatabase()
  const text = (field: string, fallback: string | null): string | null => {
    const value = body[field];
    if (value === undefined) return fallback;
    if (value === null || value === "") return value === "" ? "" : null;
    if (typeof value !== "string") {
      (errors[field] ??= []).push(LARAVEL.string(field));
      return fallback;
    }
    return value;
  };
  const humanName = text("humanName", row.human_name);
  const description = text("description", row.description);
  descriptionRules(errors, description);
  const image = text("image", row.image);
  // rulesFor(): the image is required when the stored part has one (a `build`-only Compose service has none).
  if (row.image !== null && row.image.trim() !== "" && (image === null || image.trim() === "")) (errors.image ??= []).push(LARAVEL.required("image"));
  const excludeFromStatus = flag("excludeFromStatus", row.exclude_from_status);
  const isLogDrainEnabled = flag("isLogDrainEnabled", row.is_log_drain_enabled);

  if (kind === "database") {
    const port = integerRule(errors, "publicPort", body.publicPort, 1, 65535);
    const timeout = integerRule(errors, "publicPortTimeout", body.publicPortTimeout, 1);
    fail();
    await ctx.store.update(kind, serviceId, row.id, {
      human_name: humanName,
      description,
      image,
      exclude_from_status: excludeFromStatus,
      is_log_drain_enabled: isLogDrainEnabled,
      public_port: (port === undefined ? row.public_port : port) || null,
      public_port_timeout: (timeout === undefined ? row.public_port_timeout : timeout) || null,
    });
    return done(SERVICE_CONFIGURATION_MESSAGES.databaseSaved);
  }

  // The application: its domains first (ValidationPatterns::applicationDomainRules()), then the resolver.
  const fqdnInput = text("fqdn", partUrl(row));
  for (const message of validateApplicationDomains(fqdnInput)) (errors.fqdn ??= []).push(message);
  const mode = body.certificateResolverMode === undefined ? (partPage(l, kind, row).part.certificateResolverMode ?? "server") : body.certificateResolverMode;
  if (!["server", "none", "custom"].includes(String(mode))) (errors.certificateResolverMode ??= []).push(LARAVEL.in("certificate resolver"));
  let resolver: string | null = null;
  if (mode === "custom") {
    const name = body.certificateResolverName === undefined ? row.traefik_certificate_resolver : body.certificateResolverName;
    if (name === null || name === undefined || (typeof name === "string" && name.trim() === "")) (errors.certificateResolverName ??= []).push(LARAVEL.required("certificate resolver name"));
    else if (typeof name !== "string") (errors.certificateResolverName ??= []).push(LARAVEL.string("certificate resolver name"));
    else {
      if ([...name].length > 255) (errors.certificateResolverName ??= []).push(LARAVEL.maxString("certificate resolver name", 255));
      if (!RESOLVER_PATTERN.test(name)) (errors.certificateResolverName ??= []).push(LARAVEL.regex("certificate resolver name"));
      if (name === RESOLVER_NONE) (errors.certificateResolverName ??= []).push(LARAVEL.in("certificate resolver name"));
      resolver = name;
    }
  } else if (mode === "none") resolver = RESOLVER_NONE;
  const isGzipEnabled = flag("isGzipEnabled", row.is_gzip_enabled);
  const isStripprefixEnabled = flag("isStripprefixEnabled", row.is_stripprefix_enabled);
  // 'maxRestartCount' => 'integer|min:0'; a changed limit clears restart_limit_reached.
  const maxRestartCount = integerRule(errors, "maxRestartCount", body.maxRestartCount, 0);
  fail();
  const restartLimit = maxRestartCount === undefined || maxRestartCount === null ? {} : { max_restart_count: maxRestartCount, ...(maxRestartCount !== (row.max_restart_count ?? 0) ? { restart_limit_reached: false } : {}) };

  const fqdn = normalizeApplicationDomains(fqdnInput);
  const warning = sslipDomainWarning(fqdn ?? "");
  // setEditableUrls(): the ports into domain_port_overrides; the saving hook syncs the noindex flags.
  const urls = normalizeDomainPortOverrides(fqdn, null);
  if (!body.forceSaveDomains) {
    const conflicts = domainConflicts({ uuid: row.uuid, fqdn: urls.fqdn }, await ctx.store.domainOwners());
    if (conflicts.length) throw new ServiceConfigurationError(SERVICE_CONFIGURATION_MESSAGES.domainConflicts, 409, null, { conflicts });
  }
  const noindex = syncNoindexDomains(row.noindex_domains, urls.fqdn);
  await ctx.store.update(kind, serviceId, row.id, {
    human_name: humanName,
    description,
    fqdn: urls.fqdn,
    domain_port_overrides: urls.overrides,
    ...(noindex !== undefined ? { noindex_domains: noindex } : {}),
    image,
    exclude_from_status: excludeFromStatus,
    is_log_drain_enabled: isLogDrainEnabled,
    is_gzip_enabled: isGzipEnabled,
    is_stripprefix_enabled: isStripprefixEnabled,
    traefik_certificate_resolver: resolver,
    ...restartLimit,
  });
  const multiple = applicationDomainList(urls.fqdn).length > 1;
  return done(multiple || warning ? null : SERVICE_CONFIGURATION_MESSAGES.serviceSaved, {
    ...(multiple ? { warning: SERVICE_CONFIGURATION_MESSAGES.multipleDomains } : warning ? { warning: SERVICE_CONFIGURATION_MESSAGES.sslipDomain } : {}),
  });
}

/**
 * Index::deleteApplication() / deleteDatabase(): the row with its volumes and file mounts (the deleting
 * hook). Coolify removes the part's container first when the server answers; a service that never ran has
 * none, and any other answers 501 until the SSH executor exists. Null when not the org's.
 */
export async function deleteServicePart(ctx: ServiceConfigurationContext, uuid: string, partUuid: string): Promise<{ deleted: true; message: string; service: ServiceInfo } | null> {
  const found = await loadPart(ctx, uuid, partUuid);
  if (!found) return null;
  if (await ctx.store.hasRun(found.l.row.id)) throw new ServiceConfigurationError(SERVICE_CONFIGURATION_MESSAGES.partDeleteUnavailable, 501);
  await ctx.store.deletePart(found.kind, found.l.row.id, found.row.id);
  const after = await load(ctx, uuid);
  return { deleted: true, message: found.kind === "application" ? SERVICE_CONFIGURATION_MESSAGES.applicationDeleted : SERVICE_CONFIGURATION_MESSAGES.databaseDeleted, service: after!.info };
}
