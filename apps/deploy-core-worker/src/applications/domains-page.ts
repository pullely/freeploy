// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/Domains.php,
// app/Models/Application.php (the saving hook, availableInternalPorts, portRequiresConfirmation),
// app/Traits/HasNoindexDomains.php, app/Support/{DomainUrlParts,DomainPortOverrides}.php,
// app/Services/Dns/ServerDnsAddresses.php, app/Actions/Shared/CheckDomainDns.php, app/Jobs/CheckDomainDnsJob.php
// and bootstrap/helpers/shared.php (dnsMismatchGuidanceMessage, dnsRecordTypeForIp, dnsGuidanceTargetAddress,
// resolveServerIpAddress) (Apache-2.0), modified.
//
// The Domains page of an application that is not a Docker Compose one: its
// domains as rows (internal port, search indexing, DNS status), adding,
// editing, removing and generating a domain, the www redirect with its
// automatic www/non-www pairs, and the two redirect switches. Everything is
// stored in deploy.applications (fqdn, redirect, domain_port_overrides,
// noindex_domains, domain_dns_statuses) and deploy.application_settings, and
// takes effect at the next deployment.
//
// DNS checks: Coolify queues a job per domain that asks DNS servers from the
// Coolify host. Freeploy has no such job yet, so a check takes the path
// Coolify takes when the job cannot be queued — the row is stored as skipped,
// "DNS check could not be started." — except for an sslip.io host, which the
// check accepts without asking DNS. Managed DNS records (Cloudflare Domain
// Connect, DNS providers) and the container labels are not ported.
import type { ApplicationConfigurationChanges, DeployApplicationConfigurationRow } from "@saas/db/deploy";
import { blank, type FieldErrors } from "../private-keys/validation.js";
import { isIpv4, isIpv6 } from "../servers/ip.js";
import { newPublicId } from "../helpers/names.js";
import {
  composeDomainUrl,
  domainConflicts,
  domainWithoutPort,
  generateUrl,
  normalizeApplicationDomains,
  normalizeApplicationDomainUrl,
  normalizeDomainPortOverrides,
  parseUrl,
  splitDomainUrl,
  sslipDomainWarning,
  syncNoindexDomains,
  validateApplicationDomains,
  type DomainParts,
} from "./domains.js";
import { APPLICATION_SERVICE_MESSAGES, type ApplicationShow } from "./service.js";
import { jsonValue, loadConfiguration, SettingsError, SettingsFieldErrors, type ApplicationSettingsContext } from "./settings.js";
import { validateChoice, validateDomainField, validateRedirect, validateSwitch, REDIRECTS, type Redirect } from "./settings-validation.js";

export const DOMAINS_MESSAGES = {
  /** Domains::addDomain() */
  labelsWritableAdd: "Domains cannot be edited while container labels are writable. Set domains in the Labels section on General.",
  /** updateDomain(), removeDomain(), generateDomain() */
  labelsWritable: "Domains cannot be edited while container labels are writable.",
  invalidNew: "Please enter a valid domain URL.",
  invalidEdit: "Please enter a single valid domain URL.",
  alreadyConfigured: (url: string) => `Domain ${url} is already configured.`,
  added: "Domain added.",
  updated: "Domain updated.",
  removed: "Domain removed.",
  generated: "Domain generated.",
  noServer: "No server found for this application.",
  couldNotGenerate: "Could not generate a domain.",
  redirectUpdated: "Redirect updated.",
  forceHttpsUpdated: "HTTP to HTTPS redirect updated.",
  permanentRedirectUpdated: "Redirect type updated.",
  /** The port warning dialog of domains.blade.php, its markup left out. */
  unrecognizedPort: (port: number) =>
    `Port ${port} is not listed in Ports Exposes and is not used by any application domain. The proxy will still route to it, but the container may not be listening there.`,
  /** Domains::assertRedirectDomainsPresent(), its <br> tags as line breaks. */
  redirectNeedsBoth: (missing: string, hint: string) =>
    `Redirect requires both www and non-www domains, but the ${missing} host could not be added automatically (e.g. only IP/sslip hosts).\n\nPlease add the ${missing} domain manually (${hint}).`,
  /** Domains::dispatchDnsCheckNotification() */
  dnsOk: (host: string) => `DNS is configured correctly for ${host}.`,
  /** CheckDomainDns */
  dnsLooksCorrect: "DNS looks correct.",
  dnsNoServer: "No server available for DNS validation.",
  dnsNotChecked: "Not checked yet.",
  /** Domains::markUrlsDnsCheckUnavailable() */
  dnsCouldNotStart: "DNS check could not be started.",
  /** Freeploy's: there is no DNS check job yet. */
  dnsUnavailable: "Checking DNS is not available yet.",
  domainNotFound: "Domain not found.",
} as const;

type Body = Record<string, unknown>;

interface DnsStatus {
  status: string;
  message: string;
  expected_ip: string | null;
  checked_at: string | null;
  check_id?: string | null;
}

export interface DomainRow {
  url: string;
  /** getFqdnWithoutPort($row['url']) */
  publicUrl: string;
  internalPort: number | null;
  hasPortOverride: boolean;
  /** The port a domain uses without an override of its own: the first exposed port. */
  inheritedPort: number | null;
  dnsStatus: string;
  dnsMessage: string;
  expectedIp: string | null;
  checkedAt: string | null;
  isNoindexed: boolean;
  /** The edit dialog's parts: the URL split, with the override as its port. */
  parts: DomainParts;
}

export interface DomainsState {
  rows: DomainRow[];
  redirect: Redirect;
  isForceHttpsEnabled: boolean;
  isPermanentRedirectEnabled: boolean;
  /** Container labels are edited by hand: domains are set in the labels, not here. */
  labelsAreWritable: boolean;
  isCompose: boolean;
  dnsValidationEnabled: boolean;
  /** The address DNS records point to, and the server's address as configured. */
  serverIp: string | null;
  dnsTargetLabel: string | null;
}

export interface DomainsPage {
  application: ApplicationShow;
  domains: DomainsState;
}

export interface DomainsSaved extends DomainsPage {
  /** The success toast. */
  message: string | null;
  /** Further success toasts (a finished DNS check). */
  notices: string[];
  /** Coolify's sslip-with-https warning, when the saved list has such a domain. */
  warning: string | null;
  /** What could not run here: the DNS checks. */
  unavailable: string | null;
}

/** Domains::splitDomains() */
export function splitDomains(value: string | null | undefined): string[] {
  if (blank(value)) return [];
  return value!
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d !== "" && d !== "0");
}

const unique = <T>(list: T[]): T[] => [...new Set(list)];
const normalizeRedirect = (redirect: unknown): Redirect => ((REDIRECTS as readonly unknown[]).includes(redirect) ? (redirect as Redirect) : "both");

/** parse_url($url, PHP_URL_HOST), null when there is none. */
export function domainHost(url: string): string | null {
  const host = parseUrl(url)?.host;
  return host ? host : null;
}

/**
 * Domains::wwwCounterpartUrl(): the same URL on the www host, or on the bare
 * host for a www one. Never for an IP address or localhost; for a generated
 * sslip.io / nip.io host only when a redirect needs the pair.
 */
export function wwwCounterpartUrl(url: string, forRedirectPairing = false): string | null {
  const parts = parseUrl(url);
  const host = parts?.host;
  if (!parts || !host) return null;
  const lower = host.toLowerCase();
  const bare = host.replace(/^\[+|\]+$/g, "");
  if (isIpv4(bare) || isIpv6(bare) || lower === "localhost") return null;
  if (!forRedirectPairing && (lower.includes("sslip.io") || lower.includes("nip.io"))) return null;
  const counterpart = lower.startsWith("www.") ? host.slice(4) : `www.${host}`;
  if (counterpart === "" || counterpart === host) return null;
  const port = parts.port === undefined ? "" : `:${parts.port}`;
  const query = parts.query === undefined ? "" : `?${parts.query}`;
  const fragment = parts.fragment === undefined ? "" : `#${parts.fragment}`;
  return `${parts.scheme ?? "https"}://${counterpart}${port}${parts.path ?? ""}${query}${fragment}`;
}

/** DomainUrlParts::hasDnsRelevantChange() */
function hasDnsRelevantChange(oldUrl: string, newUrl: string): boolean {
  const a = splitDomainUrl(oldUrl);
  const b = splitDomainUrl(newUrl);
  return a.scheme !== b.scheme || a.host.toLowerCase() !== b.host.toLowerCase();
}

/** dnsRecordTypeForIp() */
export function dnsRecordTypeForIp(ipOrHost: string | null): "A" | "AAAA" {
  const candidate = dnsGuidanceTargetAddress(ipOrHost);
  return candidate !== null && isIpv6(candidate) ? "AAAA" : "A";
}

/** dnsGuidanceTargetAddress(): the first token of a label, without brackets. */
function dnsGuidanceTargetAddress(ipOrLabel: string | null): string | null {
  if (ipOrLabel === null || ipOrLabel.trim() === "") return null;
  const candidate = (ipOrLabel.trim().match(/^(\S+)/)?.[1] ?? "").replace(/^\[+|\]+$/g, "");
  return candidate !== "" ? candidate : null;
}

/** dnsMismatchGuidanceMessage() */
export function dnsMismatchGuidanceMessage(targetLabel: string | null, ipForRecordType: string | null = null): string {
  const address = dnsGuidanceTargetAddress(ipForRecordType) ?? dnsGuidanceTargetAddress(targetLabel);
  if (address === null) return "DNS validation failed. Check your DNS records.";
  return `Required DNS record type ${dnsRecordTypeForIp(address)} pointing to ${address}`;
}

/**
 * ServerDnsAddresses::forServer(): the server's public IPv4, else its public
 * IPv6, else its address. Coolify resolves a hostname to its IP; the Worker
 * has no resolver, so a hostname stays as configured (as Coolify leaves it
 * when it does not resolve).
 */
export function serverDnsAddresses(row: Pick<DeployApplicationConfigurationRow, "server_id" | "server_ip" | "server_public_ipv4" | "server_public_ipv6">): { address: string | null; configured: string | null } {
  if (row.server_id === null) return { address: null, configured: null };
  const raw = row.server_public_ipv4 || row.server_public_ipv6 || row.server_ip;
  const configured = blank(raw) ? null : raw!.trim();
  if (configured === null) return { address: null, configured: null };
  const candidate = configured.replace(/^\[+|\]+$/g, "");
  return { address: isIpv4(candidate) || isIpv6(candidate) ? candidate : configured, configured };
}

/** Domains::dnsTargetLabel(): the IP, with the configured hostname when it differs. */
export function dnsTargetLabel(addresses: { address: string | null; configured: string | null }): string | null {
  const { address, configured } = addresses;
  if (blank(address)) return configured;
  if (!blank(configured) && configured !== address && !isIpv4(configured!) && !isIpv6(configured!)) return `${address} (${configured})`;
  return address;
}

/** The application as the component holds it between reading and saving. */
interface Model {
  row: DeployApplicationConfigurationRow;
  fqdn: string | null;
  overrides: Record<string, number> | null;
  /** noindex_domains as stored, or as set by this request. */
  noindex: unknown;
  redirect: string;
  statuses: Record<string, DnsStatus>;
  serverIp: string | null;
  labelsAreWritable: boolean;
}

function overridesOf(value: unknown): Record<string, number> | null {
  const decoded = jsonValue(value);
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const out: Record<string, number> = {};
  for (const [domain, port] of Object.entries(decoded as Record<string, unknown>)) if (!blank(port) && !Number.isNaN(Number(port))) out[domain] = Number(port);
  return Object.keys(out).length ? out : null;
}

function statusesOf(value: unknown): Record<string, DnsStatus> {
  const decoded = jsonValue(value);
  return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded) ? ({ ...decoded } as Record<string, DnsStatus>) : {};
}

function modelOf(row: DeployApplicationConfigurationRow): Model {
  return {
    row,
    fqdn: blank(row.fqdn) ? null : row.fqdn,
    overrides: overridesOf(row.domain_port_overrides),
    noindex: jsonValue(row.noindex_domains),
    redirect: row.redirect ?? "both",
    statuses: statusesOf(row.domain_dns_statuses),
    serverIp: serverDnsAddresses(row).address,
    labelsAreWritable: row.is_container_label_readonly_enabled === false,
  };
}

/** HasNoindexDomains::normalizeNoindexDomain() */
const noindexKey = (domain: string): string => domainWithoutPort(normalizeApplicationDomainUrl(domain));

/** HasNoindexDomains::noindexDomains() */
function noindexDomains(model: Model): string[] {
  return Array.isArray(model.noindex) ? unique(model.noindex.filter((d): d is string => typeof d === "string" && !blank(d)).map(noindexKey)) : [];
}

/** Domains::inheritedDomainInternalPort() for an application that is not a Compose one. */
function inheritedPort(row: DeployApplicationConfigurationRow): number | null {
  if (row.is_static) return 80;
  const first = row.ports_exposes === null || row.ports_exposes === undefined ? undefined : row.ports_exposes.split(",")[0];
  return first !== undefined && first.trim() !== "" && !Number.isNaN(Number(first)) && Math.trunc(Number(first)) > 0 ? Math.trunc(Number(first)) : null;
}

/** Application::availableInternalPorts(): the exposed ports and the ports domains already use. */
export function availableInternalPorts(row: Pick<DeployApplicationConfigurationRow, "is_static" | "ports_exposes" | "fqdn">, overrides: Record<string, number> | null): number[] {
  const ports: number[] = [];
  const push = (value: unknown) => {
    const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
    if (text !== "" && !Number.isNaN(Number(text)) && Math.trunc(Number(text)) > 0) ports.push(Math.trunc(Number(text)));
  };
  if (row.is_static) push(80);
  else for (const port of row.ports_exposes === null || row.ports_exposes === undefined ? [] : row.ports_exposes.split(",")) push(port);
  for (const port of Object.values(overrides ?? {})) push(port);
  for (const url of (row.fqdn ?? "").split(",")) if (url.trim() !== "") push(splitDomainUrl(url.trim()).port);
  return unique(ports).sort((a, b) => a - b);
}

/** Domains::currentRowPort(): the override kept for the domain, else the port still written in its URL. */
function currentRowPort(model: Model, url: string): number | null {
  const override = model.overrides?.[domainWithoutPort(url)];
  if (override !== undefined && override > 0) return override;
  const legacy = splitDomainUrl(url).port;
  return /^\d+$/.test(legacy) ? Number(legacy) : null;
}

/** Domains::buildDomainRows() with domainRowFromStored() and effectiveDomainInternalPort(). */
function rowsOf(model: Model): DomainRow[] {
  const noindexed = noindexDomains(model);
  const inherited = inheritedPort(model.row);
  const rows = splitDomains(model.fqdn).map((url): DomainRow => {
    const parts = splitDomainUrl(url);
    const override = model.overrides?.[domainWithoutPort(url)];
    const legacy = parts.port !== "" ? Number(parts.port) : null;
    const hasPortOverride = override !== undefined || legacy !== null;
    const internalPort = override !== undefined ? override : (legacy ?? inherited);
    const entry = model.statuses[url];
    const checked = entry !== undefined && entry !== null && typeof entry === "object" && !blank(entry.status);
    return {
      url,
      publicUrl: domainWithoutPort(url),
      internalPort,
      hasPortOverride,
      inheritedPort: inherited,
      dnsStatus: checked ? String(entry.status) : "pending",
      dnsMessage: checked ? String(entry.message ?? DOMAINS_MESSAGES.dnsNotChecked) : DOMAINS_MESSAGES.dnsNotChecked,
      expectedIp: (checked ? entry.expected_ip : null) || model.serverIp,
      checkedAt: checked ? (entry.checked_at ?? null) : null,
      isNoindexed: noindexed.includes(noindexKey(url)),
      parts: hasPortOverride ? { ...parts, port: String(internalPort) } : parts,
    };
  });
  // sortDomainRowsByDnsStatus(): the failed ones first, the rest in their order.
  return [...rows.filter((r) => r.dnsStatus === "failed"), ...rows.filter((r) => r.dnsStatus !== "failed")];
}

function stateOf(model: Model): DomainsState {
  const addresses = serverDnsAddresses(model.row);
  return {
    rows: rowsOf(model),
    redirect: normalizeRedirect(model.redirect),
    isForceHttpsEnabled: model.row.is_force_https_enabled === true,
    isPermanentRedirectEnabled: model.row.is_permanent_redirect_enabled === true,
    labelsAreWritable: model.labelsAreWritable,
    isCompose: model.row.build_pack === "dockercompose",
    // instanceSettings()->is_dns_validation_enabled: Freeploy has no such setting; Coolify's default.
    dnsValidationEnabled: true,
    serverIp: addresses.address,
    dnsTargetLabel: dnsTargetLabel(addresses),
  };
}

/** Domains::mount() and loadDomainState(). */
export async function showDomains(ctx: ApplicationSettingsContext, uuid: string, canUpdate: boolean): Promise<DomainsPage | null> {
  const l = await loadConfiguration(ctx, uuid, canUpdate);
  return l ? { application: l.application, domains: stateOf(modelOf(l.row)) } : null;
}

/** now()->toIso8601String() */
const iso = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, "+00:00");

interface DnsOutcome {
  notices: string[];
  unavailable: boolean;
}

/**
 * A DNS check of the given URLs' rows. What CheckDomainDns answers without
 * asking DNS is stored as it stores it: no server is "skipped", an sslip.io
 * host is "ok". Any other host needs the check job, which does not exist
 * yet: stored as markUrlsDnsCheckUnavailable() stores a check that could not
 * be queued. `announce` adds the toast pollDnsChecks() shows for a finished
 * check.
 */
function checkDns(ctx: ApplicationSettingsContext, model: Model, urls: string[], outcome: DnsOutcome, announce: boolean): void {
  const now = iso((ctx.now ?? (() => new Date()))());
  for (const url of splitDomains(model.fqdn)) {
    if (!urls.includes(url)) continue;
    const host = domainHost(url) ?? url;
    if (model.row.server_id === null) {
      model.statuses[url] = { status: "skipped", message: DOMAINS_MESSAGES.dnsNoServer, expected_ip: null, checked_at: now };
    } else if (host.includes("sslip.io")) {
      model.statuses[url] = { status: "ok", message: DOMAINS_MESSAGES.dnsLooksCorrect, expected_ip: model.serverIp, checked_at: now };
      if (announce) outcome.notices.push(DOMAINS_MESSAGES.dnsOk(host));
    } else {
      model.statuses[url] = { status: "skipped", message: DOMAINS_MESSAGES.dnsCouldNotStart, expected_ip: model.serverIp, checked_at: now, check_id: newPublicId() };
      outcome.unavailable = true;
    }
  }
}

/**
 * Domains::saveDomainList() up to the model's save: the list normalized and
 * validated, the conflict check, then the saving hook — every domain stored
 * without its port, the ports in domain_port_overrides, the noindex flags of
 * domains that are gone dropped. Answers whether the saved list earns the
 * sslip warning.
 */
async function setDomainList(ctx: ApplicationSettingsContext, model: Model, domains: string[], opts: { checkConflicts: boolean; force: boolean; noindex?: string[] }): Promise<boolean> {
  const joined = unique(domains.filter((d) => d !== "")).join(",");
  const domainString = joined === "" ? null : normalizeApplicationDomains(joined);
  if (domainString) {
    const errors = validateApplicationDomains(domainString);
    if (errors.length) throw new SettingsError(errors[0]!, 422);
  }
  if (opts.noindex !== undefined) model.noindex = syncNoindexDomains(opts.noindex, domainString) ?? [];
  if (opts.checkConflicts && !opts.force && domainString !== null) {
    const conflicts = domainConflicts({ uuid: model.row.uuid, fqdn: domainString }, await ctx.store.domains());
    if (conflicts.length) throw new SettingsError(APPLICATION_SERVICE_MESSAGES.domainConflicts, 409, { conflicts });
  }
  // The saving hook, when fqdn is dirty.
  if (domainString !== (blank(model.row.fqdn) ? null : model.row.fqdn) || domainString !== model.fqdn) {
    const normalized = normalizeDomainPortOverrides(domainString, model.overrides);
    model.fqdn = normalized.fqdn;
    model.overrides = normalized.overrides;
    const kept = syncNoindexDomains(model.noindex, model.fqdn);
    if (kept !== undefined) model.noindex = kept;
  }
  return sslipDomainWarning(domainString ?? "");
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * $application->save() and persistDomainDnsStatuses(): the columns that
 * changed, with the DNS statuses kept only for the domains the application
 * still has.
 */
async function persist(ctx: ApplicationSettingsContext, model: Model): Promise<void> {
  const current = splitDomains(model.fqdn);
  const statuses = Object.fromEntries(Object.entries(model.statuses).filter(([key, entry]) => current.includes(key) && entry !== null && typeof entry === "object" && !blank(entry.status)));
  const row = model.row;
  const changes: ApplicationConfigurationChanges = {};
  if (model.fqdn !== (blank(row.fqdn) ? null : row.fqdn)) changes.fqdn = model.fqdn;
  if (model.redirect !== row.redirect) changes.redirect = model.redirect;
  if (!sameJson(model.overrides, overridesOf(row.domain_port_overrides))) changes.domain_port_overrides = model.overrides === null ? null : JSON.stringify(model.overrides);
  if (!sameJson(model.noindex, jsonValue(row.noindex_domains))) changes.noindex_domains = model.noindex === null ? null : JSON.stringify(model.noindex);
  const storedStatuses = Object.keys(statuses).length ? statuses : null;
  if (!sameJson(storedStatuses, jsonValue(row.domain_dns_statuses))) changes.domain_dns_statuses = storedStatuses === null ? null : JSON.stringify(storedStatuses);
  model.statuses = statuses;
  if (Object.keys(changes).length) await ctx.store.update(row.id, changes);
}

async function saved(ctx: ApplicationSettingsContext, application: ApplicationShow, uuid: string, message: string | null, warning: boolean, outcome: DnsOutcome): Promise<DomainsSaved> {
  const row = (await ctx.store.configuration(uuid))!;
  const frame = await ctx.store.findByUuid(uuid);
  return {
    // The heading and General read fqdn: answer the application as it is now.
    application: frame ? { ...application, fqdn: frame.fqdn ?? null } : application,
    domains: stateOf(modelOf(row)),
    message,
    notices: outcome.notices,
    warning: warning ? APPLICATION_SERVICE_MESSAGES.sslipDomain : null,
    unavailable: outcome.unavailable ? DOMAINS_MESSAGES.dnsUnavailable : null,
  };
}

/** The four parts of <x-forms.domain-input>, as the form sends them. */
function partsOf(value: unknown): DomainParts | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const text = (x: unknown): string => (typeof x === "string" ? x : typeof x === "number" ? String(x) : "");
  return { scheme: text(v.scheme) || "https", host: text(v.host), port: text(v.port), path: text(v.path) };
}

/** Domains::portFromParts() */
function portFromParts(parts: DomainParts | null): number | null {
  const port = (parts?.port ?? "").trim();
  return /^\d+$/.test(port) && Number(port) > 0 ? Number(port) : null;
}

/** Domains::shouldConfirmPort() and openPortWarning(): a port the application neither exposes nor uses needs a confirmation. */
function confirmPort(model: Model, port: number | null, currentPort: number | null, force: boolean): void {
  if (force || port === null || (currentPort !== null && port === currentPort)) return;
  if (!availableInternalPorts({ ...model.row, fqdn: model.fqdn }, model.overrides).includes(port)) {
    throw new SettingsError(DOMAINS_MESSAGES.unrecognizedPort(port), 409, { unrecognizedPort: port });
  }
}

function fieldError(field: string, message: string): SettingsFieldErrors {
  return new SettingsFieldErrors({ [field]: [message] });
}

function checked<T>(errors: FieldErrors, value: T): T {
  if (Object.keys(errors).length) throw new SettingsFieldErrors(errors);
  return value;
}

/**
 * Domains::ensureWwwNonWwwPairsConfigured(): the missing www or non-www
 * counterpart of every domain is added as a domain of its own (also for
 * sslip.io / nip.io hosts), so the proxy can serve one and redirect the
 * other. Answers the sslip warning of the save, or null when nothing was
 * missing.
 */
async function ensureWwwPairs(ctx: ApplicationSettingsContext, model: Model, force: boolean): Promise<boolean | null> {
  const current = splitDomains(model.fqdn);
  const known = new Set(current.map((url) => domainHost(url)?.toLowerCase()).filter((h): h is string => h !== undefined));
  const toAdd: string[] = [];
  for (const url of current) {
    const counterpart = wwwCounterpartUrl(url, true);
    const host = counterpart === null ? null : domainHost(counterpart);
    if (counterpart === null || host === null || known.has(host.toLowerCase())) continue;
    known.add(host.toLowerCase());
    toAdd.push(counterpart);
  }
  if (!toAdd.length) return null;
  return setDomainList(ctx, model, unique([...current, ...toAdd]), { checkConflicts: true, force });
}

/** Domains::assertRedirectDomainsPresent(): a www or non-www redirect needs a host of each kind. */
function assertRedirectDomainsPresent(model: Model, redirect: Redirect): void {
  if (redirect === "both") return;
  const hosts = splitDomains(model.fqdn).map((url) => (domainHost(url) ?? "").toLowerCase());
  const hasWww = hosts.some((h) => h.startsWith("www."));
  const hasNonWww = hosts.some((h) => h !== "" && !h.startsWith("www."));
  if (hasWww && hasNonWww) return;
  const hint = dnsMismatchGuidanceMessage(dnsTargetLabel(serverDnsAddresses(model.row)) ?? model.serverIp, model.serverIp);
  throw new SettingsError(DOMAINS_MESSAGES.redirectNeedsBoth(hasWww ? "non-www" : "www", hint), 422);
}

/** A request of the Domains page: the application for the frame and the model to change. */
async function open(ctx: ApplicationSettingsContext, uuid: string): Promise<{ application: ApplicationShow; model: Model } | null> {
  const l = await loadConfiguration(ctx, uuid, true);
  return l ? { application: l.application, model: modelOf(l.row) } : null;
}

/**
 * Domains::addDomain(): `newDomainParts` (protocol, host, port, path) or
 * `newDomain` (a URL, or a comma-separated list). The www or non-www
 * counterpart of each new domain is added with it. `forceSaveDomains`
 * answers the conflict dialog, `forceUseUnknownPort` the port warning.
 */
export async function addDomain(ctx: ApplicationSettingsContext, uuid: string, body: Body): Promise<DomainsSaved | null> {
  const o = await open(ctx, uuid);
  if (!o) return null;
  const { model } = o;
  if (model.labelsAreWritable) throw new SettingsError(DOMAINS_MESSAGES.labelsWritableAdd, 422);
  const parts = partsOf(body.newDomainParts);
  const errors: FieldErrors = {};
  const newDomain = checked(errors, validateDomainField(errors, "newDomain", parts ? composeDomainUrl(parts.scheme, parts.host, parts.port, parts.path) : body.newDomain));
  const normalized = normalizeApplicationDomains(newDomain);
  if (blank(normalized)) throw fieldError("newDomain", DOMAINS_MESSAGES.invalidNew);

  const newUrls = splitDomains(normalized);
  const pairedUrls = newUrls.map((url) => wwwCounterpartUrl(url)).filter((url): url is string => url !== null);
  const current = splitDomains(model.fqdn);
  const canonical = current.map(domainWithoutPort);
  for (const url of newUrls) if (canonical.includes(domainWithoutPort(url))) throw fieldError("newDomain", DOMAINS_MESSAGES.alreadyConfigured(url));
  confirmPort(model, portFromParts(parts), null, body.forceUseUnknownPort === true);

  const warning = await setDomainList(ctx, model, unique([...current, ...newUrls, ...pairedUrls]), { checkConflicts: true, force: body.forceSaveDomains === true });
  const outcome: DnsOutcome = { notices: [], unavailable: false };
  // The new rows are found by the URL as it was entered: one entered with a port has no row to mark, as in Coolify.
  checkDns(ctx, model, unique([...newUrls, ...pairedUrls]), outcome, false);
  await persist(ctx, model);
  return saved(ctx, o.application, uuid, DOMAINS_MESSAGES.added, warning, outcome);
}

/**
 * Domains::updateDomain(): the domain `url` becomes `editingDomainParts` (or
 * `editingDomain`), with its search indexing and the application's www
 * redirect. A port left empty removes the domain's override. After
 * "Regenerate hostname" (`generatedHost`) the redirect's counterpart moves to
 * the new hostname too; a redirect newly set to www or non-www adds the
 * missing counterparts.
 */
export async function updateDomain(ctx: ApplicationSettingsContext, uuid: string, body: Body): Promise<DomainsSaved | null> {
  const o = await open(ctx, uuid);
  if (!o) return null;
  const { model } = o;
  if (model.labelsAreWritable) throw new SettingsError(DOMAINS_MESSAGES.labelsWritable, 422);
  const current = splitDomains(model.fqdn);
  const oldUrl = typeof body.url === "string" ? body.url : "";
  if (!current.includes(oldUrl)) throw new SettingsError(DOMAINS_MESSAGES.domainNotFound, 404);

  const parts = partsOf(body.editingDomainParts);
  const originalRedirect = normalizeRedirect(model.redirect);
  const errors: FieldErrors = {};
  const editingDomain = validateDomainField(errors, "editingDomain", parts ? composeDomainUrl(parts.scheme, parts.host, parts.port, parts.path) : body.editingDomain);
  const indexing = body.editingIndexing === undefined ? (noindexDomains(model).includes(noindexKey(oldUrl)) ? "noindex" : "index") : validateChoice(errors, "editingIndexing", body.editingIndexing, ["index", "noindex"] as const);
  const redirect = body.editingRedirect === undefined ? originalRedirect : validateChoice(errors, "editingRedirect", body.editingRedirect, REDIRECTS);
  checked(errors, null);

  const normalized = normalizeApplicationDomains(editingDomain);
  if (blank(normalized) || splitDomains(normalized).length !== 1) throw fieldError("editingDomain", DOMAINS_MESSAGES.invalidEdit);
  const newUrl = splitDomains(normalized)[0]!;
  if (blank(splitDomainUrl(newUrl).port) && model.overrides) {
    const overrides = { ...model.overrides };
    delete overrides[domainWithoutPort(oldUrl)];
    delete overrides[domainWithoutPort(newUrl)];
    model.overrides = Object.keys(overrides).length ? overrides : null;
  }
  const others = current.filter((url) => url !== oldUrl).map(domainWithoutPort);
  if (others.includes(domainWithoutPort(newUrl))) throw fieldError("editingDomain", DOMAINS_MESSAGES.alreadyConfigured(newUrl));
  confirmPort(model, portFromParts(parts), currentRowPort(model, oldUrl), body.forceUseUnknownPort === true);

  const replacements = new Map<string, string>([[oldUrl, newUrl]]);
  const generatedHost = typeof body.generatedHost === "string" && !blank(body.generatedHost) ? body.generatedHost : null;
  if (generatedHost !== null && redirect !== "both") {
    const oldCounterpart = wwwCounterpartUrl(oldUrl, true);
    const counterpartHost = oldCounterpart === null ? null : domainHost(oldCounterpart);
    const existing = current.find((url) => domainHost(url) === counterpartHost);
    if (existing !== undefined) {
      const counterpartParts = splitDomainUrl(existing);
      const port = currentRowPort(model, existing);
      const host = counterpartParts.host.toLowerCase().startsWith("www.") ? `www.${generatedHost}` : generatedHost;
      replacements.set(existing, composeDomainUrl(counterpartParts.scheme, host, port === null ? counterpartParts.port : String(port), counterpartParts.path));
    }
  }

  const updated = unique(current.map((url) => replacements.get(url) ?? url));
  if (redirect !== originalRedirect && redirect !== "both") {
    for (const url of [...updated]) {
      const counterpart = wwwCounterpartUrl(url, true);
      const host = counterpart === null ? null : domainHost(counterpart);
      if (counterpart !== null && !blank(host) && !updated.some((candidate) => domainHost(candidate) === host)) updated.push(counterpart);
    }
  }
  const urlsToCheck = unique(updated.filter((url) => !current.some((existing) => !hasDnsRelevantChange(existing, url))).map(domainWithoutPort));

  let noindex = noindexDomains(model);
  for (const [previous, replacement] of replacements) {
    const wasNoindexed = previous === oldUrl ? indexing === "noindex" : noindex.includes(noindexKey(previous));
    noindex = noindex.filter((domain) => domain !== previous);
    if (wasNoindexed) noindex.push(replacement);
  }
  model.redirect = redirect!;
  const warning = await setDomainList(ctx, model, updated, { checkConflicts: true, force: body.forceSaveDomains === true, noindex });
  const outcome: DnsOutcome = { notices: [], unavailable: false };
  checkDns(ctx, model, urlsToCheck, outcome, false);
  await persist(ctx, model);
  return saved(ctx, o.application, uuid, DOMAINS_MESSAGES.updated, warning, outcome);
}

/** Domains::removeDomain(): the domain leaves the list (no conflict check), and its DNS status with it. */
export async function removeDomain(ctx: ApplicationSettingsContext, uuid: string, body: Body): Promise<DomainsSaved | null> {
  const o = await open(ctx, uuid);
  if (!o) return null;
  const { model } = o;
  if (model.labelsAreWritable) throw new SettingsError(DOMAINS_MESSAGES.labelsWritable, 422);
  const current = splitDomains(model.fqdn);
  if (typeof body.url !== "string" || !current.includes(body.url)) throw new SettingsError(DOMAINS_MESSAGES.domainNotFound, 404);
  const warning = await setDomainList(ctx, model, current.filter((url) => url !== body.url), { checkConflicts: false, force: true });
  await persist(ctx, model);
  return saved(ctx, o.application, uuid, DOMAINS_MESSAGES.removed, warning, { notices: [], unavailable: false });
}

/**
 * Domains::generateDomain(): generateUrl() for the application's uuid — the
 * server's wildcard domain, else sslip.io — added without a conflict check,
 * then the counterpart a www or non-www redirect needs
 * (syncRedirectDomainPairs), and a DNS check of what was added.
 */
export async function generateDomain(ctx: ApplicationSettingsContext, uuid: string, body: Body): Promise<DomainsSaved | null> {
  const o = await open(ctx, uuid);
  if (!o) return null;
  const { model } = o;
  if (model.labelsAreWritable) throw new SettingsError(DOMAINS_MESSAGES.labelsWritable, 422);
  if (model.row.server_id === null) throw new SettingsError(DOMAINS_MESSAGES.noServer, 422);
  const fqdn = generateUrl({ ip: model.row.server_ip ?? "", wildcardDomain: model.row.server_wildcard_domain }, model.row.uuid);
  let warning = await setDomainList(ctx, model, unique([...splitDomains(model.fqdn), fqdn]), { checkConflicts: false, force: true });
  const before = splitDomains(model.fqdn);
  if (normalizeRedirect(model.redirect) !== "both") warning = (await ensureWwwPairs(ctx, model, body.forceSaveDomains === true)) ?? warning;
  const paired = splitDomains(model.fqdn).filter((url) => !before.includes(url));
  const outcome: DnsOutcome = { notices: [], unavailable: false };
  checkDns(ctx, model, unique([fqdn, ...paired]), outcome, false);
  await persist(ctx, model);
  return saved(ctx, o.application, uuid, DOMAINS_MESSAGES.generated, warning, outcome);
}

/**
 * Domains::regenerateEditingDomain(): a new generated hostname for the edit
 * dialog. Nothing is stored until the dialog is saved.
 */
export async function regenerateHostname(ctx: ApplicationSettingsContext, uuid: string): Promise<{ host: string } | null> {
  const row = await ctx.store.configuration(uuid);
  if (!row) return null;
  if (row.is_container_label_readonly_enabled === false) throw new SettingsError(DOMAINS_MESSAGES.labelsWritable, 422);
  if (row.server_id === null) throw new SettingsError(DOMAINS_MESSAGES.noServer, 422);
  const host = domainHost(generateUrl({ ip: row.server_ip ?? "", wildcardDomain: row.server_wildcard_domain }, newPublicId()));
  if (host === null) throw new SettingsError(DOMAINS_MESSAGES.couldNotGenerate, 422);
  return { host };
}

/**
 * Domains::setRedirect(): the www redirect of the application. "www" and
 * "non-www" need a host of each kind: the missing counterparts are added as
 * domains first.
 */
export async function setRedirect(ctx: ApplicationSettingsContext, uuid: string, body: Body): Promise<DomainsSaved | null> {
  const o = await open(ctx, uuid);
  if (!o) return null;
  const { model } = o;
  const errors: FieldErrors = {};
  const redirect = checked(errors, validateRedirect(errors, body.redirect))!;
  model.redirect = redirect;
  const before = splitDomains(model.fqdn);
  let warning = false;
  if (redirect !== "both") warning = (await ensureWwwPairs(ctx, model, body.forceSaveDomains === true)) ?? false;
  assertRedirectDomainsPresent(model, redirect);
  const outcome: DnsOutcome = { notices: [], unavailable: false };
  checkDns(ctx, model, splitDomains(model.fqdn).filter((url) => !before.includes(url)), outcome, false);
  await persist(ctx, model);
  return saved(ctx, o.application, uuid, DOMAINS_MESSAGES.redirectUpdated, warning, outcome);
}

/** Domains::updateForceHttps() and updatePermanentRedirect(): one switch of the Redirects section. */
export async function setRedirectSwitch(ctx: ApplicationSettingsContext, uuid: string, body: Body, field: "isForceHttpsEnabled" | "isPermanentRedirectEnabled"): Promise<DomainsSaved | null> {
  const o = await open(ctx, uuid);
  if (!o) return null;
  const errors: FieldErrors = {};
  const value = checked(errors, validateSwitch(errors, body, field))!;
  const column = field === "isForceHttpsEnabled" ? "is_force_https_enabled" : "is_permanent_redirect_enabled";
  if (o.model.row[column] !== value) await ctx.store.updateSettings(o.model.row.id, { [column]: value });
  const message = field === "isForceHttpsEnabled" ? DOMAINS_MESSAGES.forceHttpsUpdated : DOMAINS_MESSAGES.permanentRedirectUpdated;
  return saved(ctx, o.application, uuid, message, false, { notices: [], unavailable: false });
}

/** Domains::checkDomainDns() — `url` — and checkAllDns(). */
export async function checkDomainsDns(ctx: ApplicationSettingsContext, uuid: string, body: Body): Promise<DomainsSaved | null> {
  const o = await open(ctx, uuid);
  if (!o) return null;
  const { model } = o;
  const current = splitDomains(model.fqdn);
  if (body.url !== undefined && (typeof body.url !== "string" || !current.includes(body.url))) throw new SettingsError(DOMAINS_MESSAGES.domainNotFound, 404);
  const outcome: DnsOutcome = { notices: [], unavailable: false };
  checkDns(ctx, model, typeof body.url === "string" ? [body.url] : current, outcome, true);
  await persist(ctx, model);
  return saved(ctx, o.application, uuid, null, false, outcome);
}
