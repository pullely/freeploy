// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Server/New/{ByHetzner,ByVultr,ByDigitalOcean,ByHostinger}.php
// (the computed properties and the updated* hooks) and resources/views/livewire/server/new/{by-hetzner,by-vultr,
// by-digital-ocean,by-hostinger}.blade.php (the @php option lists) (Apache-2.0), modified.
//
// DP-118: what the create-a-cloud-server components compute from the provider's catalogue, which the console keeps in
// the browser: the options each listbox offers, the filtered lists, the price on the button and the advanced options'
// summary. The catalogue is the component's state as deploy-core-worker sends it (GET …/servers/new/{type}/{token}/catalog).

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the providers' decoded arrays, read as the Blade reads them.
export type Item = Record<string, any>;

export interface Option {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export const CLOUD_TYPES = ["hetzner", "vultr", "digital-ocean", "hostinger"] as const;
export type CloudType = (typeof CLOUD_TYPES)[number];

/** CreatePage: the title and the provider's name of each {type}. */
export const PROVIDER_LABEL: Record<CloudType, string> = { hetzner: "Hetzner", vultr: "Vultr", "digital-ocean": "DigitalOcean", hostinger: "Hostinger" };

/** The {type} of /servers/new/{type}[/{token_uuid}], and the token's uuid. */
export function cloudRoute(pathname: string): { type: CloudType; tokenUuid: string | null } | null {
  const m = /^\/servers\/new\/(hetzner|vultr|digital-ocean|hostinger)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!m) return null;
  return { type: m[1] as CloudType, tokenUuid: m[2] ? decodeURIComponent(m[2]) : null };
}

/** PHP's isset(): set and not null. */
const isset = (v: unknown): boolean => v !== undefined && v !== null;
/** `$a ?? $b` */
const or = <T>(v: unknown, fallback: T): unknown => (isset(v) ? v : fallback);
/** PHP's string interpolation of a scalar. */
const s = (v: unknown): string => (v === true ? "1" : v === false || v === null || v === undefined ? "" : String(v));
/** PHP's truthiness. */
const truthy = (v: unknown): boolean => !(v === undefined || v === null || v === false || v === 0 || v === "" || v === "0" || (Array.isArray(v) && v.length === 0));

/** number_format($n, $decimals): rounded half away from zero, "," between thousands, "." before the decimals. */
export function numberFormat(n: unknown, decimals = 0): string {
  const x = Number(n);
  const value = Number.isFinite(x) ? x : 0;
  const factor = 10 ** decimals;
  const rounded = Math.sign(value) * Math.round(Math.abs(value) * factor + 1e-9) / factor;
  const [int, frac] = Math.abs(rounded).toFixed(decimals).split(".");
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${rounded < 0 ? "-" : ""}${grouped}${decimals > 0 ? `.${frac}` : ""}`;
}

/** str($word)->plural($count) for the components' regular nouns. */
const plural = (word: string, count: number): string => (count === 1 ? word : `${word}s`);

/** collect($items)->sortBy(fn)->values(): stable, false before true and numbers numerically. */
function sortBy<T>(items: T[], key: (item: T) => number | string | boolean): T[] {
  return items
    .map((item, i) => ({ item, i, k: key(item) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i))
    .map((p) => p.item);
}

// ── Hetzner ─────────────────────────────────────────────────────────────────

export interface HetznerCatalog {
  locations: Item[];
  serverTypes: Item[];
  images: Item[];
  hetznerSshKeys: Item[];
  hetznerFirewalls: Item[];
  hetznerNetworks: Item[];
}

/** getCpuVendorInfo() */
export function cpuVendorInfo(serverType: Item): string | null {
  const name = s(serverType.name).toLowerCase();
  if (name.startsWith("ccx")) return "AMD Milan EPYC™";
  if (name.startsWith("cpx")) return "AMD EPYC™";
  if (name.startsWith("cx")) return "Intel®/AMD";
  if (name.startsWith("cax")) return "Ampere®";
  return null;
}

/** isServerTypeOutOfStock(): the type's entry for the location says `available` false. */
export function isOutOfStock(serverType: Item, location: string | null): boolean {
  const entry = ((serverType.locations ?? []) as Item[]).find((l) => l.name === location);
  return (entry?.available ?? true) === false;
}

/** getAvailableServerTypesProperty(): the types offered in the location, with cpu_vendor_info and out_of_stock, in stock first. */
export function hetznerAvailableServerTypes(serverTypes: Item[], location: string | null): Item[] {
  if (!location) return [];
  const offered = serverTypes
    .filter((t) => isset(t.locations) && (t.locations as Item[]).map((l) => l.name).includes(location))
    .map((t) => ({ ...t, cpu_vendor_info: cpuVendorInfo(t), out_of_stock: isOutOfStock(t, location) }));
  return sortBy(offered, (t) => t.out_of_stock);
}

/** getAvailableImagesProperty(): the images of the server type's architecture (all without a type). */
export function hetznerAvailableImages(images: Item[], serverTypes: Item[], serverType: string | null): Item[] {
  if (!serverType) return images;
  const type = serverTypes.find((t) => t.name === serverType);
  if (!type || !isset(type.architecture)) return images;
  return images.filter((image) => or(image.architecture, null) === type.architecture);
}

const attachable = (network: Item, zone: string | null): boolean =>
  ((network.subnets ?? []) as Item[]).some((subnet) => ["cloud", "server"].includes(s(subnet.type)) && (zone === null || or(subnet.network_zone, null) === zone));

/** getAvailableNetworksProperty(): the networks with a cloud or server subnet, in the location's network zone. */
export function hetznerAvailableNetworks(networks: Item[], locations: Item[], location: string | null): Item[] {
  const usable = networks.filter((n) => attachable(n, null));
  if (!location) return usable;
  const zone = or(locations.find((l) => l.name === location)?.network_zone, null) as string | null;
  if (!zone) return usable;
  return usable.filter((n) => attachable(n, zone));
}

const grossPrice = (serverType: Item | undefined): unknown => serverType?.prices?.[0]?.price_monthly?.gross;

/** getSelectedServerPriceProperty(): "€4.51", or null. */
export function hetznerSelectedPrice(serverTypes: Item[], serverType: string | null): string | null {
  if (!serverType) return null;
  const price = grossPrice(serverTypes.find((t) => t.name === serverType));
  return isset(price) ? `€${numberFormat(price, 2)}` : null;
}

/** getSelectedServerBackupSurchargeProperty(): 20% of the price. */
export function hetznerBackupSurcharge(serverTypes: Item[], serverType: string | null): string | null {
  if (!serverType) return null;
  const price = grossPrice(serverTypes.find((t) => t.name === serverType));
  return isset(price) ? `€${numberFormat(Number(price) * 0.2, 2)}` : null;
}

export interface HetznerAdvanced {
  sshKeys: string[];
  firewalls: string[];
  networks: string[];
  enableBackups: boolean;
  enableIpv4: boolean;
  enableIpv6: boolean;
  showCloudInit: boolean;
  cloudInitScript: string;
  selectedScript: string;
}

const filled = (v: string | null | undefined): boolean => v !== null && v !== undefined && v.trim() !== "";

/** getAdvancedHetznerOptionsSummaryProperty() */
export function hetznerAdvancedSummary(a: HetznerAdvanced): string[] {
  const out: string[] = [];
  if (a.sshKeys.length) out.push(`${a.sshKeys.length} extra SSH ${plural("key", a.sshKeys.length)}`);
  if (a.firewalls.length) out.push(`${a.firewalls.length} ${plural("firewall", a.firewalls.length)}`);
  if (a.networks.length) out.push(`${a.networks.length} private ${plural("network", a.networks.length)}`);
  if (a.enableBackups) out.push("Backups on");
  if (!a.enableIpv4 || !a.enableIpv6) out.push([a.enableIpv4 ? "IPv4" : null, a.enableIpv6 ? "IPv6" : null].filter(Boolean).join(" + ") || "No public IP");
  if (a.showCloudInit || filled(a.cloudInitScript) || filled(a.selectedScript)) out.push("Cloud-init");
  return out;
}

export const hetznerLocationOptions = (locations: Item[]): Option[] => locations.map((l) => ({ value: s(l.name), label: `${s(l.city)} · ${s(l.country)}` }));

export function hetznerServerTypeOptions(types: Item[]): Option[] {
  return types.map((type) => {
    const price = grossPrice(type);
    let label = `${s(or(type.description, type.name))} · ${s(or(type.cores, "?"))} vCPU · ${s(or(type.memory, "?"))} GB RAM · ${s(or(type.disk, "?"))} GB`;
    label = truthy(price) ? `${label} · €${numberFormat(price, 2)}/mo` : label;
    return { value: s(type.name), label: type.out_of_stock ? `${label} · Out of stock` : label, disabled: type.out_of_stock === true };
  });
}

export const hetznerImageOptions = (images: Item[]): Option[] =>
  images.map((image) => ({ value: s(image.id), label: s(or(image.description, image.name)) + (isset(image.architecture) ? ` · ${s(image.architecture)}` : "") }));

// ── Vultr ───────────────────────────────────────────────────────────────────

export interface VultrCatalog {
  regions: Item[];
  plans: Item[];
  operatingSystems: Item[];
  vultrSshKeys: Item[];
}

/** getAvailablePlansProperty(): the plans of the region (a plan without locations everywhere). */
export function vultrAvailablePlans(plans: Item[], region: string | null): Item[] {
  if (!region) return plans;
  return plans.filter((plan) => {
    const locations = (plan.locations ?? []) as unknown[];
    return locations.length === 0 || locations.includes(region);
  });
}

/** getSelectedServerPriceProperty(): "$6.00", or null. */
export function vultrSelectedPrice(plans: Item[], plan: string | null): string | null {
  if (!plan) return null;
  const cost = plans.find((p) => p.id === plan)?.monthly_cost;
  return isset(cost) ? `$${numberFormat(cost, 2)}` : null;
}

/** getAdvancedVultrOptionsSummaryProperty() */
export function vultrAdvancedSummary(a: { sshKeys: string[]; enableIpv6: boolean; disablePublicIpv4: boolean; cloudInitScript: string }): string[] {
  const out: string[] = [];
  if (a.sshKeys.length) out.push(`${a.sshKeys.length} extra SSH ${plural("key", a.sshKeys.length)}`);
  if (!a.enableIpv6) out.push("IPv6 disabled");
  if (a.disablePublicIpv4) out.push("Public IPv4 disabled");
  if (truthy(a.cloudInitScript)) out.push("cloud-init");
  return out;
}

export const vultrRegionOptions = (regions: Item[]): Option[] => regions.map((r) => ({ value: s(r.id), label: `${s(or(r.city, r.id))} · ${s(or(r.country, r.id))}` }));

export function vultrPlanOptions(plans: Item[]): Option[] {
  return plans.map((plan) => {
    const label = `${s(plan.id)} · ${s(or(plan.vcpu_count, "?"))} vCPU · ${isset(plan.ram) ? numberFormat(Number(plan.ram) / 1024, 1) : "?"} GB RAM · ${s(or(plan.disk, "?"))} GB`;
    return { value: s(plan.id), label: isset(plan.monthly_cost) ? `${label} · $${numberFormat(plan.monthly_cost, 2)}/mo` : label };
  });
}

export const vultrOsOptions = (operatingSystems: Item[]): Option[] => operatingSystems.map((os) => ({ value: s(os.id), label: s(os.name) }));

// ── DigitalOcean ────────────────────────────────────────────────────────────

export interface DigitalOceanCatalog {
  regions: Item[];
  sizes: Item[];
  images: Item[];
  digitalOceanSshKeys: Item[];
}

/** getAvailableSizesProperty() / getAvailableImagesProperty(): the items of the region. */
export function digitalOceanInRegion(items: Item[], region: string | null): Item[] {
  if (!region) return items;
  return items.filter((item) => ((item.regions ?? []) as unknown[]).includes(region));
}

/** getSelectedDropletPriceProperty(): "$6.00", or null. */
export function digitalOceanSelectedPrice(sizes: Item[], size: string | null): string | null {
  if (!size) return null;
  const found = sizes.find((x) => x.slug === size);
  return found && isset(found.price_monthly) ? `$${numberFormat(found.price_monthly, 2)}` : null;
}

/** getAdvancedDigitalOceanOptionsSummaryProperty() */
export function digitalOceanAdvancedSummary(a: { sshKeys: string[]; enableIpv6: boolean; monitoring: boolean; showCloudInit: boolean; cloudInitScript: string; selectedScript: string }): string[] {
  const out: string[] = [];
  if (a.sshKeys.length) out.push(`${a.sshKeys.length} extra SSH ${plural("key", a.sshKeys.length)}`);
  if (!a.enableIpv6) out.push("IPv4 only");
  if (!a.monitoring) out.push("Monitoring off");
  if (a.showCloudInit || filled(a.cloudInitScript) || filled(a.selectedScript)) out.push("Cloud-init");
  return out;
}

export const digitalOceanRegionOptions = (regions: Item[]): Option[] => regions.map((r) => ({ value: s(r.slug), label: s(or(r.name, r.slug)) }));

export function digitalOceanSizeOptions(sizes: Item[]): Option[] {
  return sizes.map((size) => {
    const label = `${s(size.slug)} · ${s(or(size.memory, "?"))} MB RAM · ${s(or(size.vcpus, "?"))} vCPU${isset(size.disk) ? ` · ${s(size.disk)} GB` : ""}`;
    return { value: s(size.slug), label: isset(size.price_monthly) ? `${label} · $${numberFormat(size.price_monthly, 2)}/mo` : label };
  });
}

export const digitalOceanImageOptions = (images: Item[]): Option[] =>
  images.map((image) => ({ value: s(or(image.slug, image.id)), label: `${s(or(image.distribution, ""))} ${s(or(image.name, or(image.slug, image.id)))}`.trim() }));

// ── Hostinger ───────────────────────────────────────────────────────────────

export interface HostingerCatalog {
  data_centers: Item[];
  templates: Item[];
  catalog_items: Item[];
  hostinger_public_keys: Item[];
  post_install_scripts: Item[];
  selected_os_template_id: number | null;
  selected_template_id: number | null;
}

/** templateIncludesApplication(): a template whose name has " with ". */
const withApplication = (template: Item): boolean => s(or(template.name, "")).includes(" with ");
/** getOsTemplatesProperty() / getAppTemplatesProperty() */
export const hostingerOsTemplates = (templates: Item[]): Item[] => templates.filter((t) => !withApplication(t));
export const hostingerAppTemplates = (templates: Item[]): Item[] => templates.filter(withApplication);

/** planSize(): the KVM plan's number (hostingercom-vps-kvm4 is 4), else its CPU count. */
function planSize(item: Item): number {
  const m = /-vps-kvm(\d+)$/.exec(s(or(item.id, "")));
  return m ? Number(m[1]) : Math.trunc(Number(or(item.metadata?.cpus, 0)) || 0);
}

/** periodInMonths() */
function periodInMonths(price: Item): number {
  const period = Math.trunc(Number(or(price.period, 0)) || 0);
  const unit = s(or(price.period_unit, "month"));
  if (unit === "day") return period / 30;
  if (unit === "week") return (period * 7) / 30;
  if (unit === "year") return period * 12;
  if (unit === "none") return Number.MAX_SAFE_INTEGER;
  return period;
}

/** getPriceOptionsProperty(): every plan's prices with plan_name and plan_size, by size, then by period. */
export function hostingerPriceOptions(catalogItems: Item[]): Item[] {
  const prices = catalogItems.flatMap((item) => ((item.prices ?? []) as Item[]).map((price) => ({ ...price, plan_name: or(item.name, or(item.id, "VPS")), plan_size: planSize(item) })));
  return prices
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.plan_size - b.p.plan_size || periodInMonths(a.p) - periodInMonths(b.p) || a.i - b.i)
    .map((x) => x.p);
}

/** priceLabel(): "KVM 2 — USD 6.99 for 12 months, then USD 11.99". */
export function hostingerPriceLabel(price: Item): string {
  const currency = s(or(price.currency, "USD")).toUpperCase();
  const first = Math.trunc(Number(or(price.first_period_price, or(price.price, 0))) || 0);
  const renewal = Math.trunc(Number(or(price.price, first)) || 0);
  const period = Math.trunc(Number(or(price.period, 1)) || 0);
  const unit = s(or(price.period_unit, "month"));
  return `${s(or(price.plan_name, "VPS"))} — ${currency} ${(first / 100).toFixed(2)} for ${period} ${plural(unit, period)}, then ${currency} ${(renewal / 100).toFixed(2)}`;
}

export function hostingerDataCenterOptions(dataCenters: Item[]): Option[] {
  return dataCenters.map((d) => ({ value: s(d.id), label: s(or(d.city, or(d.name, d.id))) + (truthy(d.location) ? ` · ${s(d.location).toUpperCase()}` : "") }));
}

export const hostingerTemplateOptions = (templates: Item[]): Option[] => templates.map((t) => ({ value: s(t.id), label: s(or(t.name, or(t.description, t.id))) }));

/**
 * updatedSelectedOsTemplateId() / updatedSelectedAppTemplateId(): choosing one clears the other; the template is the one
 * chosen, else the other.
 */
export function hostingerTemplateChoice(choice: { os: string | null; app: string | null }, changed: "os" | "app"): { os: string | null; app: string | null; template: string | null } {
  if (changed === "os") {
    const app = choice.os !== null ? null : choice.app;
    return { os: choice.os, app, template: choice.os ?? app };
  }
  const os = choice.app !== null ? null : choice.os;
  return { os, app: choice.app, template: choice.app ?? os };
}

// ── Shared ──────────────────────────────────────────────────────────────────

/** The saved cloud-init scripts' listbox: "Start with an empty script", then each script. */
export const scriptOptions = (scripts: Array<{ uuid: string; name: string }>): Option[] => [{ value: "", label: "Start with an empty script" }, ...scripts.map((x) => ({ value: x.uuid, label: x.name }))];

/** The account's SSH keys as the "Extra SSH keys" listbox offers them. */
export const sshKeyOptions = (keys: Item[], fallbackLabel?: "fingerprint"): Option[] => keys.map((k) => ({ value: s(k.id), label: s(fallbackLabel ? or(k.name, k[fallbackLabel]) : k.name) }));
