// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Server/CreatePage.php,
// app/Livewire/Server/New/{ByHetzner,ByVultr,ByDigitalOcean,ByHostinger}.php,
// app/Livewire/Server/New/Concerns/SetsImageScanning.php, app/Models/PrivateKey.php (ownedAndOnlySShKeys),
// app/Services/{HetznerService,VultrService,DigitalOceanService,HostingerService}.php and
// bootstrap/helpers/shared.php (handleError) (Apache-2.0), modified.
//
// The console's create-a-cloud-server flow (DP-118): /servers/new/{type} and /servers/new/{type}/{token_uuid}, for
// Hetzner, Vultr, DigitalOcean and Hostinger. Each component's three steps are kept: mount() (the provider's tokens, the
// SSH private keys, the saved cloud-init scripts, a random name and the team's image scanning default), the
// wire:init load of the provider's catalogue (load{Provider}Data(): what the component keeps in its state, sorted and
// filtered as it does; its computed properties are the console's, apps/deploy-web/src/lib/cloud-server.ts) and submit():
// the component's rules and messages, its own checks, the cloud-init script saved when asked, the server made at the
// provider through DP-90's clients (the context's fetch: injectable, never the network in tests) and stored as DP-110's
// storeCloudServer() stores it, with SetsImageScanning's choice. Coolify then queues ValidateNewCloudServerJob, which
// works over SSH: that answers 501 here, after the row is stored (DP-110's instant_validate departure), so a server the
// provider already bills for is never left untracked.
//
// The component's state lives in the browser here: submit() asks Hetzner for its server types again for the out of stock
// check and Hostinger for its lists again (providerSelectionsAreValid() does that in Coolify too). Ids the console shows
// are uuids where Coolify's are integer ids (the token, the private key, a saved script), so their `integer` rules are
// not checked. Team::serverLimitReached() is not ported (Freeploy has no server limit, as DP-78's POST /servers), nor
// the audit log line of a saved script, nor from_onboarding (Boarding has its own flow, DP-75).
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { phpJsonEncode, type PhpValue } from "@saas/contracts/coolify-api";
import {
  findCloudInitScriptByUuid,
  findCloudProviderTokenByUuid,
  findPrivateKeyByUuid,
  insertCloudInitScript,
  listCloudInitScripts,
  listCloudProviderTokens,
  listServerPrivateKeys,
  type DeployCloudProviderTokenWithSecretRow,
} from "@saas/db/deploy";
import type { Env } from "../env.js";
import { columnCipher } from "../handlers/cloud-tokens.js";
import { generateRandomName, newPublicId } from "../helpers/names.js";
import { hostnameError } from "./ip.js";
import { validateRules, type Rule, type Rules } from "../api-v1/rules.js";
import type { Errors } from "../api-v1/request.js";
import { cloudInitYamlRule } from "../api-v1/cloud-init-scripts.js";
import {
  at,
  blank,
  CloudProviderApiError,
  dataGet,
  digitalOcean,
  digitalOceanClient,
  hetzner,
  hetznerClient,
  HostingerApiError,
  hostinger,
  hostingerClient,
  isPhpArray,
  phpValues,
  RateLimitError,
  vultr,
  vultrClient,
  type ProviderClient,
  type ProviderNetwork,
} from "../api-v1/cloud-providers.js";
import {
  base64,
  dropletPublicIp,
  encodeRaw,
  hetznerServerIpv6,
  need,
  normalizePublicKey,
  nullableString,
  phpInt,
  phpString,
  publicKeyFacts,
  unique,
  vultrPublicIp,
} from "../api-v1/cloud-servers.js";
import { PLACEHOLDER_IP, publicIpOf, purchase, requestInt, storeCloudServer, waitForPublicIp } from "../api-v1/hostinger-servers.js";

/** routes/web.php's {type} of server.create.type / server.create.token (manual is ByIp's, DP-37). */
export const CLOUD_TYPES = ["hetzner", "vultr", "digital-ocean", "hostinger"] as const;
export type CloudType = (typeof CLOUD_TYPES)[number];
export const isCloudType = (v: unknown): v is CloudType => typeof v === "string" && (CLOUD_TYPES as readonly string[]).includes(v);

/** CreatePage::mount()'s tokenProvider and tokenProviderName (also its title). */
export const TOKEN_PROVIDER: Record<CloudType, "hetzner" | "vultr" | "digitalocean" | "hostinger"> = { hetzner: "hetzner", vultr: "vultr", "digital-ocean": "digitalocean", hostinger: "hostinger" };
export const PROVIDER_NAME: Record<CloudType, string> = { hetzner: "Hetzner", vultr: "Vultr", "digital-ocean": "DigitalOcean", hostinger: "Hostinger" };

export const CLOUD_NEW_MESSAGES = {
  /** Freeploy's: ValidateNewCloudServerJob installs Docker and the proxy over SSH (DP-110's 501). */
  validateUnavailable: "Validating the new server needs the SSH executor, which is not available yet.",
  tokenNotFound: "Selected token not found.",
  outOfStock: "This server type is out of stock in the selected location. Select a different server type or location.",
  protocols: "Enable at least one public IP protocol.",
  vultrIpv6: "Enable IPv6 when disabling public IPv4.",
  hostingerPrice: "The selected Hostinger plan or billing period is no longer available.",
  hostingerDataCenter: "The selected Hostinger data center is no longer available.",
  hostingerTemplate: "The selected Hostinger operating system is no longer available.",
  hostingerPublicKeys: "One or more selected Hostinger SSH keys are no longer available.",
  hostingerPostInstallScript: "The selected Hostinger post-install script is no longer available.",
} as const;

/** `'selected_token_id.required' => 'Please select a … token.'` */
export const selectTokenMessage = (type: CloudType): string => `Please select a ${PROVIDER_NAME[type]} token.`;
/** load{Provider}Data() without a token: `dispatch('error', 'Please select a valid … token.')`. */
export const validTokenMessage = (type: CloudType): string => `Please select a valid ${PROVIDER_NAME[type]} token.`;
/** The Hostinger toast before handleError()'s when the VPS was bought but its row could not be stored. */
export const hostingerUnsavedMessage = (id: number): string => `Hostinger VPS ${id} was purchased but could not be saved in Coolify. Manage it in hPanel.`;

export interface CloudNewContext {
  tx: SqlExecutor;
  orgId: string;
  env: Pick<Env, "DEPLOY_ENCRYPTION_KEY">;
  providers: ProviderNetwork;
  /** generate_random_name(); replaceable for tests. */
  randomName?: () => string;
}

// ── PHP helpers ──────────────────────────────────────────────────────────────

/** A decoded provider array as JSON (what Livewire sends the browser). */
const toJs = (v: PhpValue): unknown => JSON.parse(phpJsonEncode(v)) as unknown;

/** PHP 8's `<=>` of two decoded values (the ones Collection::sortBy() compares: numbers, numeric strings, strings, null). */
export function phpCompare(a: PhpValue | undefined, b: PhpValue | undefined): number {
  const numeric = (v: PhpValue | undefined): v is number | string => typeof v === "number" || (typeof v === "string" && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(v));
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) {
    // null <=> string: as "" <=> string; null <=> number: as false <=> bool.
    const xs = x === null ? (typeof y === "number" ? 0 : "") : x;
    const ys = y === null ? (typeof x === "number" ? 0 : "") : y;
    if (x === null && y === null) return 0;
    return phpCompare(xs as PhpValue, ys as PhpValue);
  }
  if (numeric(x) && numeric(y)) return Math.sign(Number(x) - Number(y));
  if (typeof x === "boolean" || typeof y === "boolean") return Math.sign(Number(Boolean(x)) - Number(Boolean(y)));
  const xs = typeof x === "string" ? x : typeof x === "number" ? String(x) : phpJsonEncode(x);
  const ys = typeof y === "string" ? y : typeof y === "number" ? String(y) : phpJsonEncode(y);
  return xs < ys ? -1 : xs > ys ? 1 : 0;
}

/** collect($items)->sortBy($key)->values(): a stable sort by the key's value. */
export function sortBy(items: PhpValue[], key: (item: PhpValue) => PhpValue | undefined): PhpValue[] {
  return items
    .map((item, i) => ({ item, i, k: key(item) }))
    .sort((p, q) => phpCompare(p.k, q.k) || p.i - q.i)
    .map((p) => p.item);
}

/** PHP's empty() of a request value (`! empty($this->cloud_init_script)`). */
const phpEmpty = (v: unknown): boolean => v === undefined || v === null || v === false || v === 0 || v === "" || v === "0" || (Array.isArray(v) && v.length === 0);
/** A Livewire bool property. */
const bool = (v: unknown): boolean => v === true || v === 1 || v === "1" || v === "true";
/** A Livewire array property, its items as given. */
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v as Record<string, unknown>) : []);
/** The integer items of an array property (validated `integer`), as Livewire's typed ids reach the provider. */
const ints = (v: unknown): number[] => list(v).map((x) => requestInt(x));
const str = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

/** handleError($e, $this): the toast's message (the exception's getMessage()). */
export function errorMessage(e: unknown): string {
  if (e instanceof CloudProviderApiError) return e.fullMessage();
  if (e instanceof Error) return e.message;
  return String(e);
}

// ── mount() ───────────────────────────────────────────────────────────────────

export interface CloudNewMount {
  type: CloudType;
  provider: string;
  providerName: string;
  /** CreatePage's title. */
  title: string;
  tokens: Array<{ uuid: string; name: string | null; description: string | null }>;
  /** selectTokenFromUrl(): the {token_uuid} of the route when it is one of the provider's tokens, else null (step 1). */
  selectedTokenUuid: string | null;
  currentStep: 1 | 2;
  serverName: string;
  privateKeys: Array<{ uuid: string; name: string }>;
  privateKeyId: string | null;
  /** loadSavedCloudInitScripts() (none for Hostinger, whose component has no cloud-init). */
  cloudInitScripts: Array<{ uuid: string; name: string }>;
  /** mountSetsImageScanning(): the team's scan_images_on_new_servers. */
  scanImages: "on" | "off";
}

async function providerTokens(ctx: CloudNewContext, type: CloudType) {
  return listCloudProviderTokens(ctx.tx, TOKEN_PROVIDER[type]);
}

/** The provider's token of the org named by the route ($this->available_tokens->firstWhere('uuid', …)). */
async function routeToken(ctx: CloudNewContext, type: CloudType, tokenUuid: string | null): Promise<DeployCloudProviderTokenWithSecretRow | null> {
  if (!tokenUuid) return null;
  const row = await findCloudProviderTokenByUuid(ctx.tx, tokenUuid);
  return row && row.provider === TOKEN_PROVIDER[type] ? row : null;
}

/** PrivateKey::ownedAndOnlySShKeys()->get(): the org's keys that are not git deploy keys, by id. */
async function sshKeys(ctx: CloudNewContext) {
  return (await listServerPrivateKeys(ctx.tx)).filter((k) => !k.is_git_related);
}

/** CreatePage::mount() and By{Provider}::mount(). */
export async function cloudNewMount(ctx: CloudNewContext, type: CloudType, tokenUuid: string | null, scanImagesOnNewServers: boolean): Promise<CloudNewMount> {
  const tokens = await providerTokens(ctx, type);
  const selected = tokenUuid ? (tokens.find((t) => t.uuid === tokenUuid) ?? null) : null;
  const keys = await sshKeys(ctx);
  // CloudInitScript::ownedByCurrentTeam()->get(): by id.
  const scripts = type === "hostinger" ? [] : [...(await listCloudInitScripts(ctx.tx))].sort((a, b) => Number(a.id) - Number(b.id));
  return {
    type,
    provider: TOKEN_PROVIDER[type],
    providerName: PROVIDER_NAME[type],
    title: PROVIDER_NAME[type],
    tokens: tokens.map((t) => ({ uuid: t.uuid ?? "", name: t.name, description: t.description })),
    selectedTokenUuid: selected?.uuid ?? null,
    currentStep: selected ? 2 : 1,
    serverName: (ctx.randomName ?? generateRandomName)(),
    privateKeys: keys.map((k) => ({ uuid: k.uuid, name: k.name })),
    privateKeyId: keys[0]?.uuid ?? null,
    cloudInitScripts: scripts.map((s) => ({ uuid: s.uuid ?? "", name: s.name })),
    scanImages: scanImagesOnNewServers ? "on" : "off",
  };
}

// ── load{Provider}Data() ──────────────────────────────────────────────────────

export type CloudNewLoad = { data: Record<string, unknown> } | { providerDataError: string } | { toast: string };

async function decryptToken(ctx: CloudNewContext, row: DeployCloudProviderTokenWithSecretRow): Promise<string> {
  return columnCipher(ctx.tx, ctx.orgId, ctx.env.DEPLOY_ENCRYPTION_KEY, "cloud_provider_tokens.token").decrypt(row.token);
}

function clientFor(ctx: CloudNewContext, type: CloudType, token: string): ProviderClient {
  if (type === "hetzner") return hetznerClient(ctx.providers, token);
  if (type === "vultr") return vultrClient(ctx.providers, token);
  if (type === "digital-ocean") return digitalOceanClient(ctx.providers, token);
  return hostingerClient(ctx.providers, token);
}

/** providerDataErrorMessage(): the exception's message with the "{provider} API error: " prefix once. */
function providerDataErrorMessage(providerName: string, e: unknown): string {
  const details = errorMessage(e);
  const prefix = `${providerName} API error: `;
  return details.startsWith(prefix) ? details : prefix + details;
}

/** HostingerService's templates whose name has " with " include an application (templateIncludesApplication()). */
const includesApplication = (template: PhpValue): boolean => phpString(at(template, "name") ?? "").includes(" with ");

/** optionalProviderData(): a failure is reported, not shown. */
async function optional(read: () => Promise<PhpValue>): Promise<PhpValue> {
  try {
    return await read();
  } catch {
    return [];
  }
}

/** load{Provider}Data() for the route's token. */
export async function cloudNewLoad(ctx: CloudNewContext, type: CloudType, tokenUuid: string): Promise<CloudNewLoad> {
  const row = await routeToken(ctx, type, tokenUuid);
  const token = row ? await decryptToken(ctx, row) : "";
  if (!token) return { toast: validTokenMessage(type) };
  const client = clientFor(ctx, type, token);
  try {
    if (type === "hetzner") {
      const locations = await hetzner.locations(client);
      const serverTypes = await hetzner.serverTypes(client, null, true);
      // Only system images, not deprecated, by name.
      const images = sortBy(
        (await hetzner.images(client)).filter((image) => at(image, "type") === "system" && at(image, "deprecated") !== true),
        (image) => at(image, "name"),
      );
      const sshKeyList = await hetzner.sshKeys(client);
      const firewalls = sortBy(await hetzner.firewalls(client), (f) => at(f, "name"));
      const networks = sortBy(await hetzner.networks(client), (n) => at(n, "name"));
      return { data: { locations: toJs(locations), serverTypes: toJs(serverTypes), images: toJs(images), hetznerSshKeys: toJs(sshKeyList), hetznerFirewalls: toJs(firewalls), hetznerNetworks: toJs(networks) } };
    }
    if (type === "vultr") {
      const regions = sortBy(await vultr.regions(client), (r) => at(r, "id"));
      const plans = sortBy(await vultr.plans(client), (p) => at(p, "monthly_cost"));
      const operatingSystems = sortBy(await vultr.operatingSystems(client), (o) => at(o, "name"));
      const sshKeyList = await vultr.sshKeys(client);
      return { data: { regions: toJs(regions), plans: toJs(plans), operatingSystems: toJs(operatingSystems), vultrSshKeys: toJs(sshKeyList) } };
    }
    if (type === "digital-ocean") {
      const regions = await digitalOcean.regions(client);
      const sizes = await digitalOcean.sizes(client);
      const images = sortBy(await digitalOcean.images(client), (i) => `${phpString(at(i, "distribution") ?? "")} ${phpString(at(i, "name") ?? "")}`);
      const sshKeyList = await digitalOcean.sshKeys(client);
      return { data: { regions: toJs(regions), sizes: toJs(sizes), images: toJs(images), digitalOceanSshKeys: toJs(sshKeyList) } };
    }
    const dataCenters = await client.request("get", "/api/vps/v1/data-centers");
    const templates = sortBy(phpValues(await client.request("get", "/api/vps/v1/templates")), (t) => at(t, "name"));
    const catalogItems = await hostinger.catalog(client);
    const publicKeys = await optional(() => hostinger.sshKeys(client));
    const postInstallScripts = await optional(() => hostinger.postInstallScripts(client));
    // selectDefaultTemplate(): Ubuntu 24.04 LTS among the plain operating systems.
    const preferred = templates.filter((t) => !includesApplication(t)).find((t) => at(t, "name") === "Ubuntu 24.04 LTS");
    const defaultTemplate = preferred === undefined ? null : requestInt(at(preferred, "id"));
    return {
      data: {
        data_centers: toJs(dataCenters),
        templates: toJs(templates),
        catalog_items: toJs(catalogItems),
        hostinger_public_keys: toJs(publicKeys),
        post_install_scripts: toJs(postInstallScripts),
        selected_os_template_id: defaultTemplate,
        selected_template_id: defaultTemplate,
      },
    };
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    if (type === "hetzner") return { providerDataError: e instanceof CloudProviderApiError ? e.fullMessage() : `Hetzner API error: ${e.message}` };
    if (type === "hostinger") return { providerDataError: e.message };
    return { providerDataError: providerDataErrorMessage(PROVIDER_NAME[type], e) };
  }
}

// ── submit() ──────────────────────────────────────────────────────────────────

export type CloudNewSubmit =
  /** A ValidationException (validate(), or addError() and return): the fields' messages, 422. */
  | { fields: Record<string, string[]> }
  /** handleError() and the other dispatch('error', …): the toasts, in order. */
  | { toasts: string[] }
  /** Stored: ValidateNewCloudServerJob needs the SSH executor (501). */
  | { stored: { uuid: string } };

/** The component's rules() for step 2 (after selected_token_id and server_name), the `exists` rules over the org's rows. */
function componentRules(ctx: CloudNewContext, type: CloudType): Rules {
  const exists = (find: (uuid: string) => Promise<unknown>): Rule => ({ exists: async (v: unknown) => typeof v === "string" && (await find(v)) !== null });
  const privateKey: Rule = exists((u) => findPrivateKeyByUuid(ctx.tx, u));
  const cloudInit: Rules = [
    ["cloud_init_script", ["nullable", "string", cloudInitYamlRule("cloud init script")]],
    ["save_cloud_init_script", ["boolean"]],
    ["cloud_init_script_name", ["nullable", "string", "max:255"]],
    ["selected_cloud_init_script_id", ["nullable", exists((u) => findCloudInitScriptByUuid(ctx.tx, u))]],
  ];
  if (type === "hetzner") {
    return [
      ["selected_location", ["required", "string"]],
      ["selected_image", ["required", "integer"]],
      ["selected_server_type", ["required", "string"]],
      ["private_key_id", ["required", privateKey]],
      ["selectedHetznerSshKeyIds", ["nullable", "array"]],
      ["selectedHetznerSshKeyIds.*", ["integer"]],
      ["selectedHetznerFirewallIds", ["nullable", "array"]],
      ["selectedHetznerFirewallIds.*", ["integer"]],
      ["selectedHetznerNetworkIds", ["nullable", "array"]],
      ["selectedHetznerNetworkIds.*", ["integer"]],
      ["enable_ipv4", ["required", "boolean"]],
      ["enable_ipv6", ["required", "boolean"]],
      ["enable_backups", ["required", "boolean"]],
      ["show_cloud_init_script", ["boolean"]],
      ...cloudInit,
    ];
  }
  if (type === "vultr") {
    return [
      ["selected_region", ["required", "string"]],
      ["selected_plan", ["required", "string"]],
      ["selected_os_id", ["required", "integer"]],
      ["private_key_id", ["required", privateKey]],
      ["selectedVultrSshKeyIds", ["nullable", "array"]],
      ["selectedVultrSshKeyIds.*", ["string"]],
      ["enable_ipv6", ["required", "boolean"]],
      ["disable_public_ipv4", ["required", "boolean"]],
      ...cloudInit,
    ];
  }
  if (type === "digital-ocean") {
    return [
      ["selected_region", ["required", "string"]],
      ["selected_image", ["required"]],
      ["selected_size", ["required", "string"]],
      ["private_key_id", ["required", privateKey]],
      ["selectedDigitalOceanSshKeyIds", ["nullable", "array"]],
      ["selectedDigitalOceanSshKeyIds.*", ["integer"]],
      ["enable_ipv6", ["required", "boolean"]],
      ["monitoring", ["required", "boolean"]],
      ["show_cloud_init_script", ["boolean"]],
      ...cloudInit,
    ];
  }
  return [
    ["selected_data_center_id", ["required", "integer"]],
    ["selected_template_id", ["required", "integer"]],
    ["selected_price_id", ["required", "string"]],
    ["private_key_id", ["required", privateKey]],
    ["enable_backups", ["required", "boolean"]],
    ["selected_public_key_ids", ["array"]],
    ["selected_public_key_ids.*", ["integer"]],
    ["selected_post_install_script_id", ["nullable", "integer"]],
  ];
}

/** Livewire's validate() of the component's rules() with its messages(); the token is the route's (selectTokenFromUrl()). */
export async function validateCloudNew(ctx: CloudNewContext, type: CloudType, token: DeployCloudProviderTokenWithSecretRow | null, body: Record<string, unknown>): Promise<Errors> {
  const errors: Errors = [];
  const all: Record<string, unknown> = { ...body, selected_token_id: token?.uuid ?? null };
  const nameRule: Rule = {
    closure: (v: unknown) => {
      if (typeof v !== "string") return [];
      const e = hostnameError("server name", v);
      return e ? [e] : [];
    },
  };
  const rules: Rules = [["selected_token_id", ["required", { exists: () => token !== null }]], ["server_name", ["required", "string", "max:253", nameRule]], ...componentRules(ctx, type)];
  // Laravel puts the items of a `field.*` rule after the other attributes (DP-110).
  await validateRules(errors, all, [...rules.filter(([k]) => !k.includes("*")), ...rules.filter(([k]) => k.includes("*"))], {
    laravelMessages: true,
    nestedDisplay: true,
    emptyStringsAbsent: true,
    messages: { "selected_token_id.required": selectTokenMessage(type), "selected_token_id.exists": CLOUD_NEW_MESSAGES.tokenNotFound },
  });
  return errors;
}

/** The private key's name, decrypted key facts and id (PrivateKey::ownedByCurrentTeam()->findOrFail()). */
async function privateKeyOf(ctx: CloudNewContext, uuid: string) {
  const row = await findPrivateKeyByUuid(ctx.tx, uuid);
  if (!row) throw new Error("No query results for model [App\\Models\\PrivateKey].");
  const pem = await columnCipher(ctx.tx, ctx.orgId, ctx.env.DEPLOY_ENCRYPTION_KEY, "private_keys.private_key").decrypt(row.private_key);
  return { id: row.id, name: row.name, ...(await publicKeyFacts(pem)) };
}

/** Save cloud-init script if requested: CloudInitScript::create() (the script encrypted, as DP-45 stores it). */
async function saveScriptIfRequested(ctx: CloudNewContext, body: Record<string, unknown>): Promise<void> {
  if (!bool(body.save_cloud_init_script) || phpEmpty(body.cloud_init_script) || phpEmpty(body.cloud_init_script_name)) return;
  const cipher = columnCipher(ctx.tx, ctx.orgId, ctx.env.DEPLOY_ENCRYPTION_KEY, "cloud_init_scripts.script");
  await insertCloudInitScript(ctx.tx, { orgId: ctx.orgId, uuid: newPublicId(), name: str(body.cloud_init_script_name), script: await cipher.encrypt(str(body.cloud_init_script)) });
}

/** By{Provider}::submit() */
export async function cloudNewSubmit(ctx: CloudNewContext, type: CloudType, tokenUuid: string | null, body: Record<string, unknown>): Promise<CloudNewSubmit> {
  const token = await routeToken(ctx, type, tokenUuid);
  const errors = await validateCloudNew(ctx, type, token, body);
  if (errors.length) return { fields: Object.fromEntries(errors) };
  const secret = await decryptToken(ctx, token!);
  const client = clientFor(ctx, type, secret);
  const scanImages = body.scan_images === "on";
  if (type === "hetzner") return submitHetzner(ctx, client, token!, body, scanImages);
  if (type === "vultr") return submitVultr(ctx, client, token!, body, scanImages);
  if (type === "digital-ocean") return submitDigitalOcean(ctx, client, token!, body, scanImages);
  return submitHostinger(ctx, client, token!, body, scanImages);
}

/** isServerTypeOutOfStock(): the type's entry for the location says `available` false. */
function outOfStock(serverType: PhpValue, location: string): boolean {
  const entry = phpValues(at(serverType, "locations") ?? []).find((l) => at(l, "name") === location);
  return (at(entry, "available") ?? true) === false;
}

async function submitHetzner(ctx: CloudNewContext, client: ProviderClient, token: DeployCloudProviderTokenWithSecretRow, body: Record<string, unknown>, scanImages: boolean): Promise<CloudNewSubmit> {
  // $this->serverTypes, as loadHetznerData() read them (getServerTypes(includeOutOfStock: true)).
  let serverTypes: PhpValue[] = [];
  try {
    serverTypes = await hetzner.serverTypes(client, null, true);
  } catch {
    serverTypes = [];
  }
  const selectedType = serverTypes.find((t) => at(t, "name") === body.selected_server_type);
  if (selectedType !== undefined && outOfStock(selectedType, str(body.selected_location))) return { fields: { selected_server_type: [CLOUD_NEW_MESSAGES.outOfStock] } };
  const enableIpv4 = bool(body.enable_ipv4);
  const enableIpv6 = bool(body.enable_ipv6);
  if (!enableIpv4 && !enableIpv6) return { fields: { enable_ipv4: [CLOUD_NEW_MESSAGES.protocols], enable_ipv6: [CLOUD_NEW_MESSAGES.protocols] } };
  let serverId: PhpValue | undefined;
  let stored = false;
  try {
    await saveScriptIfRequested(ctx, body);
    const key = await privateKeyOf(ctx, str(body.private_key_id));
    // createHetznerServer(): the key Hetzner already has by its MD5 fingerprint, else the public key uploaded.
    let sshKeyId: PhpValue | undefined;
    for (const k of await hetzner.sshKeys(client)) {
      if (need(k, "fingerprint") === key.md5) {
        sshKeyId = need(k, "id");
        break;
      }
    }
    if (sshKeyId === undefined) sshKeyId = need(at(await client.request("post", "/ssh_keys", { name: key.name, public_key: key.publicKey }), "ssh_key") ?? [], "id");
    const normalizedServerName = str(body.server_name).trim().toLowerCase();
    const params: Record<string, unknown> = {
      name: normalizedServerName,
      server_type: body.selected_server_type,
      image: requestInt(body.selected_image),
      location: body.selected_location,
      start_after_create: true,
      ssh_keys: unique([sshKeyId, ...ints(body.selectedHetznerSshKeyIds)]),
      public_net: { enable_ipv4: enableIpv4, enable_ipv6: enableIpv6 },
    };
    const firewallIds = unique(ints(body.selectedHetznerFirewallIds));
    if (firewallIds.length) params.firewalls = firewallIds.map((id) => ({ firewall: id }));
    const networkIds = unique(ints(body.selectedHetznerNetworkIds));
    if (networkIds.length) params.networks = networkIds;
    if (!phpEmpty(body.cloud_init_script)) params.user_data = body.cloud_init_script;
    const server = at(await client.request("post", "/servers", params), "server") ?? [];
    serverId = isPhpArray(server) ? at(server, "id") : undefined;
    // Prefer IPv4, fall back to IPv6.
    let ipAddress: string | null = null;
    const ipv4 = dataGet(server, "public_net.ipv4.ip");
    const ipv6 = dataGet(server, "public_net.ipv6.ip");
    if (enableIpv4 && ipv4 !== undefined && ipv4 !== null) ipAddress = phpString(ipv4);
    else if (enableIpv6 && ipv6 !== undefined && ipv6 !== null) ipAddress = hetznerServerIpv6(ipv6);
    // Stored immediately so the Hetzner server is always tracked, even without an IP yet.
    const row = await storeCloudServer(ctx.tx, ctx, {
      name: str(body.server_name),
      ip: ipAddress ?? PLACEHOLDER_IP,
      privateKeyId: key.id,
      imageScanEnabled: scanImages,
      columns: [
        ["cloud_provider_token_id", token.id],
        ["hetzner_server_id", need(server, "id")],
        ["hetzner_server_status", at(server, "status") ?? null],
      ],
    });
    stored = true;
    if (bool(body.enable_backups)) {
      try {
        await client.request("post", `/servers/${phpInt(need(server, "id"))}/actions/enable_backup`);
      } catch {
        // report($e)
      }
    }
    // ValidateNewCloudServerJob::dispatch($server): over SSH.
    return { stored: { uuid: row.uuid } };
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    // deleteUntrackedHetznerServer()
    if (!stored && serverId !== undefined && serverId !== null) {
      try {
        await client.request("delete", `/servers/${phpInt(serverId)}`);
      } catch {
        // report($e)
      }
    }
    return { toasts: [errorMessage(e)] };
  }
}

async function submitVultr(ctx: CloudNewContext, client: ProviderClient, token: DeployCloudProviderTokenWithSecretRow, body: Record<string, unknown>, scanImages: boolean): Promise<CloudNewSubmit> {
  const enableIpv6 = bool(body.enable_ipv6);
  const disablePublicIpv4 = bool(body.disable_public_ipv4);
  // hasValidPublicNetworkConfiguration()
  if (disablePublicIpv4 && !enableIpv6) return { fields: { enable_ipv6: [CLOUD_NEW_MESSAGES.vultrIpv6] } };
  let instanceId: string | null = null;
  let stored = false;
  try {
    await saveScriptIfRequested(ctx, body);
    const key = await privateKeyOf(ctx, str(body.private_key_id));
    // findMatchingSshKey(): the key Vultr already has by its text, else the public key uploaded.
    let sshKeyId: PhpValue | undefined;
    const wanted = normalizePublicKey(key.publicKey);
    for (const k of await vultr.sshKeys(client)) {
      if (normalizePublicKey(phpString(at(k, "ssh_key") ?? "")) === wanted) {
        sshKeyId = need(k, "id");
        break;
      }
    }
    if (sshKeyId === undefined) sshKeyId = need(at(await client.request("post", "/ssh-keys", { name: key.name, ssh_key: key.publicKey }), "ssh_key") ?? [], "id");
    const normalizedServerName = str(body.server_name).trim().toLowerCase();
    const params: Record<string, unknown> = {
      region: body.selected_region,
      plan: body.selected_plan,
      os_id: requestInt(body.selected_os_id),
      label: normalizedServerName,
      hostname: normalizedServerName,
      sshkey_id: unique([sshKeyId, ...list(body.selectedVultrSshKeyIds)]),
      enable_ipv6: enableIpv6,
      disable_public_ipv4: disablePublicIpv4,
    };
    // createInstance(): the script base64-encoded.
    if (!phpEmpty(body.cloud_init_script)) params.user_data = base64(str(body.cloud_init_script));
    let instance = at(await client.request("post", "/instances", params), "instance") ?? [];
    instanceId = phpString(need(instance, "id"));
    const row = await storeCloudServer(ctx.tx, ctx, {
      name: normalizedServerName,
      ip: vultrPublicIp(instance, disablePublicIpv4, enableIpv6) ?? PLACEHOLDER_IP,
      privateKeyId: key.id,
      imageScanEnabled: scanImages,
      columns: [
        ["cloud_provider_token_id", token.id],
        ["vultr_instance_id", instanceId],
        ["vultr_instance_status", nullableString(at(instance, "status"))],
      ],
    });
    stored = true;
    try {
      // waitForPublicIp(): six more looks, a second apart.
      if (vultrPublicIp(instance, disablePublicIpv4, enableIpv6) === null && !blank(at(instance, "id"))) {
        for (let attempt = 0; attempt < 6; attempt++) {
          await ctx.providers.sleep(1000);
          instance = at(await client.request("get", `/instances/${encodeRaw(phpString(need(instance, "id")))}`), "instance") ?? [];
          if (vultrPublicIp(instance, disablePublicIpv4, enableIpv6) !== null) break;
        }
      }
      const assigned = vultrPublicIp(instance, disablePublicIpv4, enableIpv6);
      if (assigned && assigned !== row.ip) {
        await ctx.tx.execute("UPDATE deploy.servers SET ip = $2, vultr_instance_status = COALESCE($3, vultr_instance_status) WHERE id = $1", [row.id, assigned, nullableString(at(instance, "status"))]);
      }
    } catch {
      // Non-fatal: the server page polling backfills the IP later.
    }
    return { stored: { uuid: row.uuid } };
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    // deleteUntrackedInstance()
    if (instanceId && !stored) {
      try {
        await client.request("delete", `/instances/${encodeRaw(instanceId)}`);
      } catch {
        // report($e)
      }
    }
    return { toasts: [errorMessage(e)] };
  }
}

async function submitDigitalOcean(ctx: CloudNewContext, client: ProviderClient, token: DeployCloudProviderTokenWithSecretRow, body: Record<string, unknown>, scanImages: boolean): Promise<CloudNewSubmit> {
  const enableIpv6 = bool(body.enable_ipv6);
  let dropletId: number | null = null;
  let stored = false;
  try {
    await saveScriptIfRequested(ctx, body);
    const key = await privateKeyOf(ctx, str(body.private_key_id));
    // createDigitalOceanDroplet(): the key DigitalOcean already has by its MD5 fingerprint, else the public key uploaded.
    let sshKeyId: number | null = null;
    for (const k of await digitalOcean.sshKeys(client)) {
      if ((at(k, "fingerprint") ?? null) === key.md5) {
        sshKeyId = phpInt(need(k, "id"));
        break;
      }
    }
    if (!sshKeyId) sshKeyId = phpInt(need(at(await client.request("post", "/account/keys", { name: key.name, public_key: key.publicKey }), "ssh_key") ?? [], "id"));
    const normalizedServerName = str(body.server_name).trim().toLowerCase();
    const params: Record<string, unknown> = {
      name: normalizedServerName,
      region: body.selected_region,
      size: body.selected_size,
      image: body.selected_image,
      ssh_keys: unique([sshKeyId, ...ints(body.selectedDigitalOceanSshKeyIds)]),
      ipv6: enableIpv6,
      monitoring: bool(body.monitoring),
    };
    if (!phpEmpty(body.cloud_init_script)) params.user_data = body.cloud_init_script;
    let droplet = at(await client.request("post", "/droplets", params), "droplet") ?? [];
    dropletId = phpInt(need(droplet, "id"));
    // Persisted immediately so the droplet is always tracked, even if waiting for the public IP fails.
    const row = await storeCloudServer(ctx.tx, ctx, {
      name: normalizedServerName,
      ip: PLACEHOLDER_IP,
      privateKeyId: key.id,
      imageScanEnabled: scanImages,
      columns: [
        ["cloud_provider_token_id", token.id],
        ["digitalocean_droplet_id", dropletId],
        ["digitalocean_droplet_status", nullableString(at(droplet, "status"))],
      ],
    });
    stored = true;
    try {
      // waitForPublicIp(): thirty more looks, a second apart.
      if (dropletPublicIp(droplet, true, enableIpv6) === null && !blank(at(droplet, "id"))) {
        for (let attempt = 0; attempt < 30; attempt++) {
          await ctx.providers.sleep(1000);
          droplet = at(await client.request("get", `/droplets/${phpInt(need(droplet, "id"))}`), "droplet") ?? [];
          if (dropletPublicIp(droplet, true, enableIpv6) !== null) break;
        }
      }
      const address = dropletPublicIp(droplet, true, enableIpv6);
      if (address) await ctx.tx.execute("UPDATE deploy.servers SET ip = $2, digitalocean_droplet_status = COALESCE($3, digitalocean_droplet_status) WHERE id = $1", [row.id, address, nullableString(at(droplet, "status"))]);
    } catch {
      // Non-fatal: the server page polling backfills the IP later.
    }
    return { stored: { uuid: row.uuid } };
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    // deleteUntrackedDroplet()
    if (dropletId && !stored) {
      try {
        await client.request("delete", `/droplets/${dropletId}`);
      } catch {
        // report($e)
      }
    }
    return { toasts: [errorMessage(e)] };
  }
}

/** providerSelectionsAreValid(): each choice is asked of Hostinger again. */
async function hostingerSelectionErrors(client: ProviderClient, body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const priceIds = phpValues(await hostinger.catalog(client)).flatMap((item) => phpValues(at(item, "prices") ?? []).map((p) => at(p, "id")));
  const dataCenterIds = phpValues(await client.request("get", "/api/vps/v1/data-centers")).map((d) => requestInt(at(d, "id")));
  const templateIds = phpValues(await client.request("get", "/api/vps/v1/templates")).map((t) => requestInt(at(t, "id")));
  const selectedKeys = list(body.selected_public_key_ids);
  const postInstall = body.selected_post_install_script_id;
  const publicKeyIds = (phpEmpty(selectedKeys) ? [] : phpValues(await hostinger.sshKeys(client))).map((k) => requestInt(at(k, "id")));
  const scriptIds = (phpEmpty(postInstall) ? [] : phpValues(await hostinger.postInstallScripts(client))).map((s) => requestInt(at(s, "id")));
  const fields: Record<string, string[]> = {};
  // Collection::contains($value): a loose comparison.
  if (!priceIds.some((id) => id !== undefined && id !== null && phpString(id) === str(body.selected_price_id))) fields.selected_price_id = [CLOUD_NEW_MESSAGES.hostingerPrice];
  if (!dataCenterIds.includes(requestInt(body.selected_data_center_id))) fields.selected_data_center_id = [CLOUD_NEW_MESSAGES.hostingerDataCenter];
  if (!templateIds.includes(requestInt(body.selected_template_id))) fields.selected_template_id = [CLOUD_NEW_MESSAGES.hostingerTemplate];
  if (selectedKeys.some((id) => !publicKeyIds.includes(requestInt(id)))) fields.selected_public_key_ids = [CLOUD_NEW_MESSAGES.hostingerPublicKeys];
  if (!phpEmpty(postInstall) && !scriptIds.includes(requestInt(postInstall))) fields.selected_post_install_script_id = [CLOUD_NEW_MESSAGES.hostingerPostInstallScript];
  return fields;
}

async function submitHostinger(ctx: CloudNewContext, client: ProviderClient, token: DeployCloudProviderTokenWithSecretRow, body: Record<string, unknown>, scanImages: boolean): Promise<CloudNewSubmit> {
  let virtualMachineId: number | null = null;
  try {
    const key = await privateKeyOf(ctx, str(body.private_key_id));
    const invalid = await hostingerSelectionErrors(client, body);
    if (Object.keys(invalid).length) return { fields: invalid };
    const normalizedServerName = str(body.server_name).trim().toLowerCase();
    const setup: Array<[string, unknown]> = [
      ["data_center_id", requestInt(body.selected_data_center_id)],
      ["template_id", requestInt(body.selected_template_id)],
      ["hostname", normalizedServerName],
      ["enable_backups", bool(body.enable_backups)],
      ["public_key", { name: key.name, key: key.publicKey }],
    ];
    if (!phpEmpty(body.selected_post_install_script_id)) setup.push(["post_install_script_id", requestInt(body.selected_post_install_script_id)]);
    let vm = await purchase(client, body.selected_price_id, setup);
    virtualMachineId = requestInt(at(vm, "id"));
    const row = await storeCloudServer(ctx.tx, ctx, {
      name: normalizedServerName,
      ip: PLACEHOLDER_IP,
      privateKeyId: key.id,
      imageScanEnabled: scanImages,
      columns: [
        ["cloud_provider_token_id", token.id],
        ["hostinger_virtual_machine_id", nullableString(need(vm, "id"))],
        ["hostinger_virtual_machine_status", nullableString(at(vm, "state"))],
      ],
    });
    try {
      const selectedKeys = ints(body.selected_public_key_ids);
      if (selectedKeys.length) await client.request("post", `/api/vps/v1/public-keys/attach/${virtualMachineId}`, { ids: selectedKeys });
      vm = await waitForPublicIp(ctx, client, vm);
      const address = publicIpOf(vm);
      if (address !== null) await ctx.tx.execute("UPDATE deploy.servers SET ip = $2, hostinger_virtual_machine_status = COALESCE($3, hostinger_virtual_machine_status) WHERE id = $1", [row.id, address, nullableString(at(vm, "state"))]);
    } catch {
      // report($e)
    }
    return { stored: { uuid: row.uuid } };
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    const toasts = virtualMachineId ? [hostingerUnsavedMessage(virtualMachineId)] : [];
    toasts.push(e instanceof HostingerApiError || e instanceof RateLimitError ? e.message : errorMessage(e));
    return { toasts };
  }
}
