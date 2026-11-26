// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Service/Domains.php, app/Models/ServiceApplication.php
// (getRequiredPort, portRequiresConfirmation, extractPortFromUrl, the saving hook), app/Traits/HasNoindexDomains.php,
// app/Support/{DomainUrlParts,DomainPortOverrides}.php, bootstrap/helpers/services.php (updateCompose) and
// bootstrap/helpers/shared.php (checkDomainUsage, dnsMismatchGuidanceMessage) (Apache-2.0), modified.
//
// A service's Domains page (DP-102): the domains of every application of the service, grouped by application, with
// their internal port, search indexing, redirects and DNS status; adding a domain to an application, editing (its
// address, indexing and the application's www redirect), removing and generating one, and an application's two
// redirect switches. A save changes the service's rows in memory as Coolify's component changes its models — the
// application's fqdn through ServiceApplication's saving hook, then updateCompose() and Service::parse() — and writes
// back what changed (rows.ts), all in the org's transaction; the DNS statuses go to service_applications.
// domain_dns_statuses. Nothing here runs on a server.
//
// DNS checks: as the application's Domains page (applications/domains-page.ts), a check Coolify would queue is stored
// as the job could not be queued — "DNS check could not be started." — except an sslip.io host, which the check
// accepts without asking DNS, and a service without a server. Managed DNS (Cloudflare Domain Connect, DNS providers),
// the suggested www rows (buildSuggestedWwwRows(), which buildDomainRows() never calls) and toggleNoindexDomain()
// (the page sets indexing in the edit dialog) are not ported.
import type { DeployMaintenanceServerRow, DeployServiceApplicationDnsRow } from "@saas/db/deploy";
import { composeDomainUrl, domainConflicts, domainWithoutPort, generateUrl, normalizeApplicationDomains, splitDomainUrl, sslipDomainWarning, syncNoindexDomains, validateApplicationDomains, type DomainConflict, type DomainParts } from "../applications/domains.js";
import { DOMAINS_MESSAGES, dnsMismatchGuidanceMessage, dnsTargetLabel, domainHost, serverDnsAddresses, splitDomains, wwwCounterpartUrl } from "../applications/domains-page.js";
import { validateChoice, validateDomainField, REDIRECTS, type Redirect } from "../applications/settings-validation.js";
import { APPLICATION_SERVICE_MESSAGES } from "../applications/service.js";
import { add, blank, type FieldErrors } from "../private-keys/validation.js";
import { LARAVEL } from "../servers/settings-validation.js";
import { newPublicId } from "../helpers/names.js";
import { headline } from "./catalogue-build.js";
import { ComposeError } from "./compose-helpers.js";
import { loadServiceInfo, serviceParserContext, SERVICE_CONFIGURATION_MESSAGES, type ServiceConfigurationContext, type ServiceInfo } from "./configuration.js";
import { parseService, serviceApplicationRequiredPort, setServiceApplicationFqdn, updateServiceCompose, type ServiceParserContext } from "./parser.js";
import { loadServiceRows, writeServiceRows, type LoadedServiceRows } from "./rows.js";
import type { MemoryServiceStore, ServiceApplicationRow } from "./store.js";

type Body = Record<string, unknown>;
type Id = string | number;

export const SERVICE_DOMAINS_MESSAGES = {
  /** addDomain() */
  selectApplication: "Select a service application.",
  invalidNew: DOMAINS_MESSAGES.invalidNew,
  alreadyConfigured: (url: string) => `Domain ${url} is already configured for this service.`,
  added: "Domain added.",
  addedDnsStarted: "Domain added. DNS check started.",
  someDnsNotStarted: "Some DNS checks could not be started. Try again from the Domains page.",
  /** updateDomain() */
  invalidEdit: DOMAINS_MESSAGES.invalidEdit,
  updated: "Domain updated.",
  /** removeDomain() */
  removed: "Domain removed.",
  /** setServiceRedirect() */
  applicationNotFound: "Service application not found.",
  redirectUpdated: "Redirect updated.",
  redirectNeedsBoth: DOMAINS_MESSAGES.redirectNeedsBoth,
  /** updateForceHttps() / updatePermanentRedirect() */
  forceHttpsUpdated: "HTTP to HTTPS redirect updated.",
  permanentRedirectUpdated: "Redirect type updated.",
  /** generateDomain() */
  noApplicationOrServer: "Service application or server not found.",
  /** queueUrlsDns() */
  dnsNotStarted: "The DNS check could not be started. Try again from the Domains page.",
  /** dispatchDnsCheckNotification() */
  dnsOk: DOMAINS_MESSAGES.dnsOk,
  dnsCouldNotStart: DOMAINS_MESSAGES.dnsCouldNotStart,
  dnsNoServer: DOMAINS_MESSAGES.dnsNoServer,
  dnsNotChecked: DOMAINS_MESSAGES.dnsNotChecked,
  dnsLooksCorrect: DOMAINS_MESSAGES.dnsLooksCorrect,
  domainNotFound: DOMAINS_MESSAGES.domainNotFound,
  /** saveDomainListForApp() */
  multipleDomains: SERVICE_CONFIGURATION_MESSAGES.multipleDomains,
  sslipDomain: APPLICATION_SERVICE_MESSAGES.sslipDomain,
  domainConflicts: APPLICATION_SERVICE_MESSAGES.domainConflicts,
} as const;

/** A failure of one action: a toast (dispatch('error')), a field's message (addError), or a dialog (409). */
export class ServiceDomainsError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    readonly fields: FieldErrors | null = null,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

/** What the page needs beside the service's configuration store. */
export interface ServiceDomainsContext {
  configuration: ServiceConfigurationContext;
  dnsStatuses(serviceId: Id): Promise<DeployServiceApplicationDnsRow[]>;
  updateDnsStatuses(serviceId: Id, id: Id, statuses: Record<string, unknown> | null): Promise<boolean>;
  /** $service->server with its settings (the DNS target), or null. */
  server(serviceId: Id): Promise<DeployMaintenanceServerRow | null>;
  /** The clock, for the DNS statuses' checked_at. */
  now?: () => Date;
  /** new_public_id(), for a generated domain and a DNS check's id. */
  newId?: () => string;
}

interface DnsStatus {
  status: string;
  message: string;
  expected_ip: string | null;
  checked_at: string | null;
  check_id?: string | null;
}

export interface ServiceDomainApp {
  uuid: string;
  /** human_name ?: name */
  name: string;
  /** Str::headline() of the name: the group's heading. */
  heading: string;
  image: string | null;
  requiredPort: number | null;
  redirect: Redirect;
  isForceHttpsEnabled: boolean;
  isPermanentRedirectEnabled: boolean;
}

export interface ServiceDomainRow {
  serviceApplicationUuid: string;
  serviceName: string;
  url: string;
  /** getFqdnWithoutPort($row['url']) */
  publicUrl: string;
  internalPort: number | null;
  hasPortOverride: boolean;
  dnsStatus: string;
  dnsMessage: string;
  expectedIp: string | null;
  checkedAt: string | null;
  isNoindexed: boolean;
  /** The edit dialog's parts: the URL split, the internal port as its port. */
  parts: DomainParts;
}

export interface ServiceDomainsState {
  apps: ServiceDomainApp[];
  rows: ServiceDomainRow[];
  dnsValidationEnabled: boolean;
  serverIp: string | null;
  dnsTargetLabel: string | null;
}

export interface Toast {
  type: "success" | "warning" | "error";
  message: string;
}

export interface ServiceDomainsPage {
  service: ServiceInfo;
  domains: ServiceDomainsState;
}

export interface ServiceDomainsSaved extends ServiceDomainsPage {
  /** The toasts the action dispatches, in Coolify's order. */
  toasts: Toast[];
}

/** The service as one request of the component holds it. */
interface Model {
  info: ServiceInfo;
  serviceId: Id;
  loaded: LoadedServiceRows;
  memory: MemoryServiceStore;
  parser: ServiceParserContext;
  statuses: Map<number, Record<string, DnsStatus>>;
  storedStatuses: Map<number, string>;
  serverRow: DeployMaintenanceServerRow | null;
  serverIp: string | null;
  dnsTarget: string | null;
  serverId: Id | null;
  serverIpRaw: string | null;
  wildcardDomain: string | null;
}

const unique = <T>(list: T[]): T[] => [...new Set(list)];
const normalizeRedirect = (redirect: unknown): Redirect => ((REDIRECTS as readonly unknown[]).includes(redirect) ? (redirect as Redirect) : "both");
const displayName = (app: ServiceApplicationRow): string => (app.human_name ? app.human_name : app.name);
/** HasNoindexDomains::normalizeNoindexDomain() */
const noindexKey = (domain: string): string => domainWithoutPort(normalizeApplicationDomains(domain) ?? domain);
/** HasNoindexDomains::noindexDomains() */
const noindexDomains = (app: ServiceApplicationRow): string[] => unique((app.noindex_domains ?? []).filter((d): d is string => typeof d === "string" && !blank(d)).map(noindexKey));
const isDomainNoindexed = (app: ServiceApplicationRow, url: string): boolean => noindexDomains(app).includes(noindexKey(url));
/** now()->toIso8601String() */
const iso = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, "+00:00");

function statusesOf(value: unknown): Record<string, DnsStatus> {
  let decoded = value;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded) as unknown;
    } catch {
      decoded = null;
    }
  }
  return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded) ? ({ ...decoded } as Record<string, DnsStatus>) : {};
}

async function open(ctx: ServiceDomainsContext, uuid: string): Promise<Model | null> {
  const l = await loadServiceInfo(ctx.configuration, uuid);
  if (!l) return null;
  const loaded = await loadServiceRows(ctx.configuration.store, l.row, ctx.configuration.ciphers);
  const statuses = new Map<number, Record<string, DnsStatus>>();
  const storedStatuses = new Map<number, string>();
  for (const row of await ctx.dnsStatuses(l.row.id)) {
    const decoded = statusesOf(row.domain_dns_statuses);
    statuses.set(Number(row.id), decoded);
    storedStatuses.set(Number(row.id), JSON.stringify(Object.keys(decoded).length ? decoded : null));
  }
  const server = l.row.server_id === null ? null : await ctx.server(l.row.id);
  const addresses = serverDnsAddresses({ server_id: server?.id ?? null, server_ip: server?.ip ?? null, server_public_ipv4: server?.public_ipv4 ?? null, server_public_ipv6: server?.public_ipv6 ?? null });
  return {
    info: l.info,
    serviceId: l.row.id,
    loaded,
    memory: loaded.store,
    parser: serviceParserContext(l.row),
    statuses,
    storedStatuses,
    serverRow: server,
    serverIp: addresses.address,
    dnsTarget: dnsTargetLabel(addresses),
    serverId: server?.id ?? null,
    serverIpRaw: server?.ip ?? null,
    wildcardDomain: l.row.server_wildcard_domain,
  };
}

/** The applications sorted as loadDomainState() sorts them: by their name, case-insensitively. */
function sortedApps(model: Model): ServiceApplicationRow[] {
  return [...model.memory.applications()].sort((a, b) => {
    const x = displayName(a).toLowerCase();
    const y = displayName(b).toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

const requiredPort = (model: Model, app: ServiceApplicationRow): number | null => serviceApplicationRequiredPort(model.memory, model.parser, app);

/** effectiveDomainInternalPort() */
function effectivePort(model: Model, app: ServiceApplicationRow, url: string): { internalPort: number | null; hasPortOverride: boolean } {
  const override = (app.domain_port_overrides ?? {})[domainWithoutPort(url)];
  if (override !== undefined && override !== null) return { internalPort: Number(override), hasPortOverride: true };
  const legacy = splitDomainUrl(url).port;
  if (legacy !== "" && Number(legacy) > 0) return { internalPort: Number(legacy), hasPortOverride: true };
  const required = requiredPort(model, app);
  return { internalPort: required !== null && required > 0 ? required : null, hasPortOverride: false };
}

/** buildDomainRows() with domainRowFromStored(): every configured domain, the failed DNS checks first. */
function rowsOf(model: Model): ServiceDomainRow[] {
  const rows: ServiceDomainRow[] = [];
  for (const app of sortedApps(model)) {
    const stored = model.statuses.get(app.id) ?? {};
    for (const url of splitDomains(app.fqdn)) {
      const port = effectivePort(model, app, url);
      const entry = stored[url];
      const checked = entry !== undefined && entry !== null && typeof entry === "object" && !blank(entry.status);
      const parts = splitDomainUrl(url);
      rows.push({
        serviceApplicationUuid: app.uuid,
        serviceName: displayName(app),
        url,
        publicUrl: domainWithoutPort(url),
        internalPort: port.internalPort,
        hasPortOverride: port.hasPortOverride,
        dnsStatus: checked ? String(entry.status) : "pending",
        dnsMessage: checked ? String(entry.message ?? SERVICE_DOMAINS_MESSAGES.dnsNotChecked) : SERVICE_DOMAINS_MESSAGES.dnsNotChecked,
        expectedIp: (checked ? entry.expected_ip : null) || model.serverIp,
        checkedAt: checked ? (entry.checked_at ?? null) : null,
        isNoindexed: isDomainNoindexed(app, url),
        parts: port.internalPort !== null ? { ...parts, port: String(port.internalPort) } : parts,
      });
    }
  }
  return [...rows.filter((r) => r.dnsStatus === "failed"), ...rows.filter((r) => r.dnsStatus !== "failed")];
}

function stateOf(model: Model): ServiceDomainsState {
  return {
    apps: sortedApps(model).map((app) => ({
      uuid: app.uuid,
      name: displayName(app),
      heading: headline(displayName(app)),
      image: app.image,
      requiredPort: requiredPort(model, app),
      redirect: normalizeRedirect(app.redirect),
      isForceHttpsEnabled: app.is_force_https_enabled !== false,
      isPermanentRedirectEnabled: app.is_permanent_redirect_enabled === true,
    })),
    rows: rowsOf(model),
    // instanceSettings()->is_dns_validation_enabled: Freeploy has no such setting; Coolify's default.
    dnsValidationEnabled: true,
    serverIp: model.serverIp,
    dnsTargetLabel: model.dnsTarget,
  };
}

/** Domains::mount() and loadDomainState(). Null when the service is not the org's. */
export async function showServiceDomains(ctx: ServiceDomainsContext, uuid: string): Promise<ServiceDomainsPage | null> {
  const model = await open(ctx, uuid);
  return model ? { service: model.info, domains: stateOf(model) } : null;
}

// ---------------------------------------------------------------- saving

function findApp(model: Model, uuid: unknown): ServiceApplicationRow | null {
  return typeof uuid === "string" ? (model.memory.applications().find((app) => app.uuid === uuid) ?? null) : null;
}

/** ServiceApplication::extractPortFromUrl() */
function extractPortFromUrl(url: string): number | null {
  const withScheme = url.startsWith("http://") || url.startsWith("https://") ? url : `http://${url}`;
  const port = splitDomainUrl(withScheme).port;
  return port !== "" && Number(port) > 0 ? Number(port) : null;
}

/** ServiceApplication::portRequiresConfirmation() */
function portRequiresConfirmation(app: ServiceApplicationRow, fqdn: string, required: number | null): boolean {
  if (required === null) return false;
  const trimmed = fqdn.trim();
  if (trimmed === "") return false;
  const explicit = extractPortFromUrl(trimmed);
  if (explicit === null || explicit === required) return false;
  const existing = (app.domain_port_overrides ?? {})[domainWithoutPort(trimmed)];
  return Number(existing ?? 0) !== explicit;
}

interface SaveOptions {
  checkConflicts?: boolean;
  checkPorts?: boolean;
  noindex?: string[];
  redirect?: Redirect;
  forceSaveDomains: boolean;
  forceRemovePort: boolean;
}

/**
 * saveDomainListForApp(): the list normalized and validated (its first error a toast), the conflict dialog and the
 * port dialog (409s, answered by forceSaveDomains / forceRemovePort), then the save — the saving hook, updateCompose()
 * and parse() — with the sslip and multiple-domain warnings.
 */
function saveDomainList(model: Model, app: ServiceApplicationRow, domains: string[], owners: { uuid: string; name: string; fqdn: string | null }[], options: SaveOptions, toasts: Toast[]): void {
  const joined = unique(domains.filter((d) => d !== "")).join(",");
  const domainString = joined === "" ? null : normalizeApplicationDomains(joined);
  if (domainString) {
    const errors = validateApplicationDomains(domainString);
    if (errors.length) throw new ServiceDomainsError(errors[0]!);
  }
  if ((options.checkConflicts ?? true) && !options.forceSaveDomains && domainString !== null) {
    const conflicts: DomainConflict[] = domainConflicts({ uuid: app.uuid, fqdn: domainString }, owners);
    if (conflicts.length) throw new ServiceDomainsError(SERVICE_DOMAINS_MESSAGES.domainConflicts, 409, null, { conflicts });
  }
  if ((options.checkPorts ?? true) && !options.forceRemovePort && domainString) {
    const required = requiredPort(model, app);
    for (const fqdn of splitDomains(domainString)) {
      if (portRequiresConfirmation(app, fqdn, required)) throw new ServiceDomainsError(`This service requires port ${required}.`, 409, null, { requiredPort: required, requestedPort: extractPortFromUrl(fqdn) });
    }
  }
  if (options.redirect !== undefined) app.redirect = options.redirect;
  if (sslipDomainWarning(domainString ?? "")) toasts.push({ type: "warning", message: SERVICE_DOMAINS_MESSAGES.sslipDomain });
  // $app->save(): the saving hook (ports into domain_port_overrides, the noindex flags of the domains it still has).
  setServiceApplicationFqdn(app, domainString);
  if (options.noindex !== undefined) app.noindex_domains = syncNoindexDomains(options.noindex, app.fqdn) ?? [];
  reparse(model, app);
  if ((app.fqdn ?? "").includes(",")) toasts.push({ type: "warning", message: SERVICE_DOMAINS_MESSAGES.multipleDomains });
}

/** updateCompose($app) and $this->service->parse(). */
function reparse(model: Model, app: ServiceApplicationRow): void {
  updateServiceCompose(model.memory, model.parser, { kind: "application", row: app });
  try {
    parseService(model.memory, model.parser);
  } catch (error) {
    if (error instanceof ComposeError) throw new ServiceDomainsError(error.message);
    throw error;
  }
}

/**
 * The DNS check of the given URLs of one application (queueUrlsDns() / the check addDomain() queues): an sslip.io host
 * is accepted, no server is skipped, any other is stored as a check that could not be started. Answers whether one
 * could not be started.
 */
function checkDns(ctx: ServiceDomainsContext, model: Model, app: ServiceApplicationRow, urls: string[], toasts: Toast[], announce: boolean): boolean {
  const now = iso((ctx.now ?? (() => new Date()))());
  const statuses = model.statuses.get(app.id) ?? {};
  let notStarted = false;
  for (const url of unique(urls)) {
    const host = domainHost(url) ?? url;
    if (model.serverId === null) statuses[url] = { status: "skipped", message: SERVICE_DOMAINS_MESSAGES.dnsNoServer, expected_ip: model.serverIp, checked_at: now };
    else if (host.includes("sslip.io")) {
      statuses[url] = { status: "ok", message: SERVICE_DOMAINS_MESSAGES.dnsLooksCorrect, expected_ip: model.serverIp, checked_at: now, check_id: null };
      if (announce) toasts.push({ type: "success", message: SERVICE_DOMAINS_MESSAGES.dnsOk(host) });
    } else {
      statuses[url] = { status: "skipped", message: SERVICE_DOMAINS_MESSAGES.dnsCouldNotStart, expected_ip: model.serverIp, checked_at: now, check_id: (ctx.newId ?? newPublicId)() };
      notStarted = true;
    }
  }
  model.statuses.set(app.id, statuses);
  return notStarted;
}

/** writeServiceRows() and persistAllDomainDnsStatuses(): each application's statuses kept for its current domains. */
async function persist(ctx: ServiceDomainsContext, model: Model): Promise<void> {
  await writeServiceRows(ctx.configuration.store, model.loaded, ctx.configuration.ciphers);
  for (const app of model.memory.applications()) {
    const current = splitDomains(app.fqdn);
    const statuses = Object.fromEntries(Object.entries(model.statuses.get(app.id) ?? {}).filter(([url, entry]) => current.includes(url) && entry !== null && typeof entry === "object" && !blank(entry.status)));
    const value = Object.keys(statuses).length ? statuses : null;
    if (JSON.stringify(value) !== (model.storedStatuses.get(app.id) ?? "null")) await ctx.updateDnsStatuses(model.serviceId, app.id, value);
  }
}

async function saved(ctx: ServiceDomainsContext, uuid: string, toasts: Toast[]): Promise<ServiceDomainsSaved> {
  const after = await open(ctx, uuid);
  return { service: after!.info, domains: stateOf(after!), toasts };
}

/** The four parts of <x-forms.domain-input>, as the form sends them. */
function partsOf(value: unknown): DomainParts | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const text = (x: unknown): string => (typeof x === "string" ? x : typeof x === "number" ? String(x) : "");
  return { scheme: text(v.scheme) || "https", host: text(v.host), port: text(v.port), path: text(v.path) };
}

const fieldError = (field: string, message: string) => new ServiceDomainsError(message, 422, { [field]: [message] });

function checked<T>(errors: FieldErrors, value: T): T {
  if (Object.keys(errors).length) throw new ServiceDomainsError(Object.values(errors).flat()[0] ?? "Validation failed", 422, errors);
  return value;
}

const forceFlags = (body: Body) => ({ forceSaveDomains: body.forceSaveDomains === true, forceRemovePort: body.forceRemovePort === true });

/**
 * addDomain(): `newDomainParts` (or `newDomain`) for the application `serviceApplicationUuid`; the www or non-www
 * counterpart of each new domain comes with it when the application redirects to one.
 */
export async function addServiceDomain(ctx: ServiceDomainsContext, uuid: string, body: Body): Promise<ServiceDomainsSaved | null> {
  const model = await open(ctx, uuid);
  if (!model) return null;
  const parts = partsOf(body.newDomainParts);
  const errors: FieldErrors = {};
  const newDomain = checked(errors, validateDomainField(errors, "newDomain", parts ? composeDomainUrl(parts.scheme, parts.host, parts.port, parts.path) : body.newDomain));
  const app = findApp(model, body.serviceApplicationUuid);
  if (!app) throw new ServiceDomainsError(SERVICE_DOMAINS_MESSAGES.selectApplication);
  const normalized = normalizeApplicationDomains(newDomain);
  if (blank(normalized)) throw fieldError("newDomain", SERVICE_DOMAINS_MESSAGES.invalidNew);
  const newUrls = splitDomains(normalized);
  const paired = ["www", "non-www"].includes(normalizeRedirect(app.redirect)) ? newUrls.map((url) => wwwCounterpartUrl(url)).filter((url): url is string => url !== null) : [];
  const current = splitDomains(app.fqdn);
  const canonical = current.map(domainWithoutPort);
  for (const url of newUrls) if (canonical.includes(domainWithoutPort(url))) throw fieldError("newDomain", SERVICE_DOMAINS_MESSAGES.alreadyConfigured(url));
  const toasts: Toast[] = [];
  saveDomainList(model, app, unique([...current, ...newUrls, ...paired]), await ctx.configuration.store.domainOwners(), forceFlags(body), toasts);
  const added = unique([...newUrls, ...paired]);
  const notStarted = added.filter((url) => checkDns(ctx, model, app, [url], [], false)).length;
  await persist(ctx, model);
  if (notStarted > 0) toasts.push({ type: "error", message: SERVICE_DOMAINS_MESSAGES.someDnsNotStarted });
  toasts.push({ type: "success", message: notStarted === added.length ? SERVICE_DOMAINS_MESSAGES.added : SERVICE_DOMAINS_MESSAGES.addedDnsStarted });
  return saved(ctx, uuid, toasts);
}

/** queueUrlsDns(): one error toast when a check could not be started. */
function queueDns(ctx: ServiceDomainsContext, model: Model, app: ServiceApplicationRow, urls: string[], toasts: Toast[]): void {
  if (!urls.length) return;
  if (checkDns(ctx, model, app, urls, toasts, true)) toasts.push({ type: "error", message: SERVICE_DOMAINS_MESSAGES.dnsNotStarted });
}

/**
 * updateDomain(): the domain `url` of the application `serviceApplicationUuid` becomes `editingDomainParts` (or
 * `editingDomain`), with its search indexing (`editingIndexing`) and the application's www redirect
 * (`editingRedirect`). A port left as the inherited one, or empty, removes the domain's override. After "Regenerate
 * hostname" (`generatedHost`) the redirect's counterpart moves to the new hostname too; a redirect newly set to www or
 * non-www adds the missing counterparts.
 */
export async function updateServiceDomain(ctx: ServiceDomainsContext, uuid: string, body: Body): Promise<ServiceDomainsSaved | null> {
  const model = await open(ctx, uuid);
  if (!model) return null;
  const app = findApp(model, body.serviceApplicationUuid);
  const oldUrl = typeof body.url === "string" ? body.url : "";
  if (!app || !splitDomains(app.fqdn).includes(oldUrl)) throw new ServiceDomainsError(SERVICE_DOMAINS_MESSAGES.domainNotFound, 404);
  const row = rowsOf(model).find((r) => r.serviceApplicationUuid === app.uuid && r.url === oldUrl)!;
  const errors: FieldErrors = {};
  const parts = partsOf(body.editingDomainParts);
  let editingDomain: unknown = body.editingDomain;
  if (parts) {
    if (!row.hasPortOverride && parts.port === String(row.internalPort ?? "")) parts.port = "";
    if (!blank(parts.host)) editingDomain = composeDomainUrl(parts.scheme, parts.host, parts.port, parts.path);
  }
  const domain = validateDomainField(errors, "editingDomain", editingDomain);
  const indexing = validateChoice(errors, "editingIndexing", body.editingIndexing ?? (row.isNoindexed ? "noindex" : "index"), ["index", "noindex"] as const);
  const originalRedirect = normalizeRedirect(app.redirect);
  const redirect = validateChoice(errors, "editingRedirect", body.editingRedirect ?? originalRedirect, REDIRECTS);
  checked(errors, null);

  const normalized = normalizeApplicationDomains(domain);
  if (blank(normalized) || splitDomains(normalized).length !== 1) throw fieldError("editingDomain", SERVICE_DOMAINS_MESSAGES.invalidEdit);
  const newUrl = splitDomains(normalized)[0]!;
  const current = splitDomains(app.fqdn);
  if (blank(splitDomainUrl(newUrl).port)) {
    const overrides = { ...(app.domain_port_overrides ?? {}) };
    delete overrides[domainWithoutPort(oldUrl)];
    delete overrides[domainWithoutPort(newUrl)];
    app.domain_port_overrides = Object.keys(overrides).length ? overrides : null;
  }
  const others = current.filter((url) => url !== oldUrl).map(domainWithoutPort);
  if (others.includes(domainWithoutPort(newUrl))) throw fieldError("editingDomain", SERVICE_DOMAINS_MESSAGES.alreadyConfigured(newUrl));

  const replacements = new Map<string, string>([[oldUrl, newUrl]]);
  const generatedHost = typeof body.generatedHost === "string" && !blank(body.generatedHost) ? body.generatedHost : null;
  if (generatedHost && (redirect === "www" || redirect === "non-www")) {
    const oldCounterpartHost = domainHost(wwwCounterpartUrl(oldUrl, true) ?? "");
    const oldCounterpart = current.find((url) => domainHost(url) === oldCounterpartHost);
    if (oldCounterpart !== undefined) {
      const p = splitDomainUrl(oldCounterpart);
      const port = (app.domain_port_overrides ?? {})[domainWithoutPort(oldCounterpart)];
      replacements.set(oldCounterpart, composeDomainUrl(p.scheme, p.host.toLowerCase().startsWith("www.") ? `www.${generatedHost}` : generatedHost, port !== undefined && port !== null ? String(port) : p.port, p.path));
    }
  }
  const updated = unique(current.map((url) => replacements.get(url) ?? url));
  if (redirect !== originalRedirect && (redirect === "www" || redirect === "non-www")) {
    for (const url of [...updated]) {
      const counterpart = wwwCounterpartUrl(url, true);
      const host = counterpart === null ? null : domainHost(counterpart);
      if (counterpart !== null && !updated.some((candidate) => domainHost(candidate) === host)) updated.push(counterpart);
    }
  }
  const dnsRelevant = (a: string, b: string) => {
    const x = splitDomainUrl(a);
    const y = splitDomainUrl(b);
    return x.scheme !== y.scheme || x.host.toLowerCase() !== y.host.toLowerCase();
  };
  const toCheck = unique(updated.filter((url) => !current.some((existing) => !dnsRelevant(existing, url))).map(domainWithoutPort));
  let noindex = noindexDomains(app);
  for (const [previous, replacement] of replacements) {
    const isNoindexed = previous === oldUrl ? indexing === "noindex" : isDomainNoindexed(app, previous);
    noindex = noindex.filter((d) => d !== previous);
    if (isNoindexed) noindex.push(replacement);
  }
  const toasts: Toast[] = [];
  saveDomainList(model, app, updated, await ctx.configuration.store.domainOwners(), { ...forceFlags(body), noindex, redirect: redirect! }, toasts);
  toasts.push({ type: "success", message: SERVICE_DOMAINS_MESSAGES.updated });
  queueDns(ctx, model, app, toCheck, toasts);
  await persist(ctx, model);
  return saved(ctx, uuid, toasts);
}

/** removeDomain() / removeDomainByKey(): the domain `url` of the application `serviceApplicationUuid`. */
export async function removeServiceDomain(ctx: ServiceDomainsContext, uuid: string, body: Body): Promise<ServiceDomainsSaved | null> {
  const model = await open(ctx, uuid);
  if (!model) return null;
  const app = findApp(model, body.serviceApplicationUuid);
  const url = typeof body.url === "string" ? body.url : "";
  if (!app || !splitDomains(app.fqdn).includes(url)) throw new ServiceDomainsError(SERVICE_DOMAINS_MESSAGES.domainNotFound, 404);
  const toasts: Toast[] = [];
  saveDomainList(model, app, splitDomains(app.fqdn).filter((item) => item !== url), [], { checkConflicts: false, forceSaveDomains: true, forceRemovePort: true }, toasts);
  toasts.push({ type: "success", message: SERVICE_DOMAINS_MESSAGES.removed });
  await persist(ctx, model);
  return saved(ctx, uuid, toasts);
}

/**
 * generateDomain(): a domain on the server's wildcard domain (or sslip.io) for the add dialog, with the application's
 * required port when it has one. Nothing is stored.
 */
export async function generateServiceDomain(ctx: ServiceDomainsContext, uuid: string, body: Body): Promise<{ domain: string; parts: DomainParts } | null> {
  const model = await open(ctx, uuid);
  if (!model) return null;
  const app = findApp(model, body.serviceApplicationUuid);
  if (!app || model.serverId === null) throw new ServiceDomainsError(SERVICE_DOMAINS_MESSAGES.noApplicationOrServer);
  let domain = generateUrl({ ip: model.serverIpRaw ?? "", wildcardDomain: model.wildcardDomain }, (ctx.newId ?? newPublicId)());
  const required = requiredPort(model, app);
  if (required !== null) {
    const p = splitDomainUrl(domain);
    if (p.port === "") domain = composeDomainUrl(p.scheme, p.host, String(required), p.path);
  }
  return { domain, parts: splitDomainUrl(domain) };
}

/** regenerateEditingDomain(): a new generated hostname for the edit dialog (null without a server). Nothing is stored. */
export async function regenerateServiceHostname(ctx: ServiceDomainsContext, uuid: string): Promise<{ host: string | null } | null> {
  const model = await open(ctx, uuid);
  if (!model) return null;
  if (model.serverId === null) return { host: null };
  return { host: domainHost(generateUrl({ ip: model.serverIpRaw ?? "", wildcardDomain: model.wildcardDomain }, (ctx.newId ?? newPublicId)())) };
}

/** ensureWwwNonWwwPairsConfigured(): the missing counterparts as domains of their own, keeping a domain's port override. */
function ensurePairs(model: Model, app: ServiceApplicationRow, owners: { uuid: string; name: string; fqdn: string | null }[], body: Body, toasts: Toast[]): string[] {
  const current = splitDomains(app.fqdn);
  const known = new Set(current.map((url) => domainHost(url)?.toLowerCase()).filter((h): h is string => h !== undefined));
  const toAdd: string[] = [];
  const overrides = { ...(app.domain_port_overrides ?? {}) };
  for (const url of current) {
    const counterpart = wwwCounterpartUrl(url, true);
    const host = counterpart === null ? null : domainHost(counterpart);
    if (counterpart === null || host === null || known.has(host.toLowerCase())) continue;
    const port = effectivePort(model, app, url);
    if (port.hasPortOverride && port.internalPort !== null) overrides[domainWithoutPort(counterpart)] = port.internalPort;
    known.add(host.toLowerCase());
    toAdd.push(counterpart);
  }
  if (!toAdd.length) return [];
  app.domain_port_overrides = Object.keys(overrides).length ? overrides : null;
  saveDomainList(model, app, unique([...current, ...toAdd]), owners, { checkPorts: false, ...forceFlags(body) }, toasts);
  return splitDomains(app.fqdn).filter((url) => !current.includes(url));
}

/** setServiceRedirect() / updateServiceRedirect(): the application's www redirect `redirect`. */
export async function setServiceDomainRedirect(ctx: ServiceDomainsContext, uuid: string, body: Body): Promise<ServiceDomainsSaved | null> {
  const model = await open(ctx, uuid);
  if (!model) return null;
  const app = findApp(model, body.serviceApplicationUuid);
  if (!app) throw new ServiceDomainsError(SERVICE_DOMAINS_MESSAGES.applicationNotFound);
  // validateOnly("serviceRedirects.{id}"): 'string|in:both,www,non-www'.
  const field = `serviceRedirects.${app.id}`;
  const errors: FieldErrors = {};
  if (typeof body.redirect !== "string") {
    add(errors, field, LARAVEL.string(field));
    add(errors, field, LARAVEL.in(field));
  } else if (!(REDIRECTS as readonly string[]).includes(body.redirect)) add(errors, field, LARAVEL.in(field));
  checked(errors, null);
  const redirect = normalizeRedirect(body.redirect);
  const toasts: Toast[] = [];
  const owners = await ctx.configuration.store.domainOwners();
  let added: string[] = [];
  if (redirect === "www" || redirect === "non-www") added = ensurePairs(model, app, owners, body, toasts);
  // assertRedirectDomainsPresent()
  if (redirect !== "both") {
    const hosts = splitDomains(app.fqdn).map((url) => (domainHost(url) ?? "").toLowerCase());
    const hasWww = hosts.some((h) => h.startsWith("www."));
    const hasNonWww = hosts.some((h) => h !== "" && !h.startsWith("www."));
    if (!hasWww || !hasNonWww) throw new ServiceDomainsError(SERVICE_DOMAINS_MESSAGES.redirectNeedsBoth(hasWww ? "non-www" : "www", dnsMismatchGuidanceMessage(model.dnsTarget ?? model.serverIp, model.serverIp)));
  }
  app.redirect = redirect;
  reparse(model, app);
  toasts.push({ type: "success", message: SERVICE_DOMAINS_MESSAGES.redirectUpdated });
  queueDns(ctx, model, app, added, toasts);
  await persist(ctx, model);
  return saved(ctx, uuid, toasts);
}

/** updateForceHttps() / updatePermanentRedirect(): one switch of an application's group. */
export async function setServiceDomainSwitch(ctx: ServiceDomainsContext, uuid: string, body: Body, which: "forceHttps" | "permanentRedirect"): Promise<ServiceDomainsSaved | null> {
  const model = await open(ctx, uuid);
  if (!model) return null;
  const app = findApp(model, body.serviceApplicationUuid);
  // findOrFail()
  if (!app) throw new ServiceDomainsError(SERVICE_DOMAINS_MESSAGES.applicationNotFound, 404);
  const field = `${which === "forceHttps" ? "forceHttpsRedirects" : "permanentRedirects"}.${app.id}`;
  if (typeof body.enabled !== "boolean") throw new ServiceDomainsError(LARAVEL.boolean(field), 422, { [field]: [LARAVEL.boolean(field)] });
  if (which === "forceHttps") app.is_force_https_enabled = body.enabled;
  else app.is_permanent_redirect_enabled = body.enabled;
  reparse(model, app);
  await persist(ctx, model);
  return saved(ctx, uuid, [{ type: "success", message: which === "forceHttps" ? SERVICE_DOMAINS_MESSAGES.forceHttpsUpdated : SERVICE_DOMAINS_MESSAGES.permanentRedirectUpdated }]);
}

/** checkDomainDns() — `serviceApplicationUuid` and `url` — and checkAllDns(). */
export async function checkServiceDomainsDns(ctx: ServiceDomainsContext, uuid: string, body: Body): Promise<ServiceDomainsSaved | null> {
  const model = await open(ctx, uuid);
  if (!model) return null;
  const toasts: Toast[] = [];
  if (body.url !== undefined) {
    const app = findApp(model, body.serviceApplicationUuid);
    if (!app || typeof body.url !== "string" || !splitDomains(app.fqdn).includes(body.url)) throw new ServiceDomainsError(SERVICE_DOMAINS_MESSAGES.domainNotFound, 404);
    queueDns(ctx, model, app, [body.url], toasts);
  } else {
    for (const row of rowsOf(model)) queueDns(ctx, model, findApp(model, row.serviceApplicationUuid)!, [row.url], toasts);
  }
  await persist(ctx, model);
  return saved(ctx, uuid, toasts);
}
