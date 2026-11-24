// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/General.php (mount, syncData,
// submit, checkFqdns, instantSave, resetDefaultLabels: what they do with custom_labels, the two container
// label settings and the HTTP Basic Authentication fields) and app/Models/Application.php
// (parseContainerLabels, usesArgon2idBasicAuth) (Apache-2.0), modified.
//
// The Labels and Authentication sections of an application's General page, as plain operations on one
// org's application. custom_labels holds base64 of the labels text, as in Coolify. While label
// management is on ("read-only labels"), the text is what generateLabelsApplication() returns and is
// regenerated when a save can change it; while it is off, the text is the user's. Nothing here talks to
// a server: the labels reach a container when it is deployed.
import type { ApplicationLabelChanges, ApplicationLabelSettingChanges, DeployApplicationLabelRow } from "@saas/db/deploy";
import type { KeyCipher } from "../private-keys/service.js";
import { DEFAULT_LABEL_DEPENDENCIES, caddySupportsArgon2idBasicAuth, generateLabelsApplication, proxyType, type LabelApplication, type LabelDependencies, type LabelServer } from "../labels/labels.js";
import { encodeLabels, parseContainerLabels } from "../labels/custom-labels.js";
import type { HttpBasicAuthHashAlgorithm, LabelFieldsInput } from "./labels-validation.js";

export interface ApplicationLabelStore {
  /** The application with what the label generator reads; null when it is not the org's. */
  findSource(uuid: string): Promise<DeployApplicationLabelRow | null>;
  updateLabels(id: string | number, changes: ApplicationLabelChanges): Promise<boolean>;
  updateSettings(applicationId: string | number, changes: ApplicationLabelSettingChanges): Promise<boolean>;
}

export interface ApplicationLabelContext {
  store: ApplicationLabelStore;
  /** The cipher of applications.http_basic_auth_password (an `encrypted` cast), under the org's key. */
  cipher: KeyCipher;
  /** The password hashes' salt source; replaceable for tests. */
  dependencies?: LabelDependencies;
}

export const LABEL_SERVICE_MESSAGES = {
  /** General::syncData(toModel: true) */
  argon2idUnsupported: "Argon2id needs a server that runs the Caddy proxy, version 2.11 or newer.",
  /** General::instantSave() */
  settingsSaved: "Settings saved.",
} as const;

/** A failure of General's that is reported as an error toast. */
export class LabelError extends Error {}

/** What the Labels and Authentication sections show. */
export interface ApplicationLabelFields {
  /** The labels text; null unless the caller may update (labels can embed credentials). */
  customLabels: string | null;
  isContainerLabelReadonlyEnabled: boolean;
  isContainerLabelEscapeEnabled: boolean;
  isHttpBasicAuthEnabled: boolean;
  httpBasicAuthUsername: string | null;
  /** Null unless the caller may update. */
  httpBasicAuthPassword: string | null;
  /** Argon2id only while the server supports it; bcrypt otherwise, whatever is stored. */
  httpBasicAuthHashAlgorithm: HttpBasicAuthHashAlgorithm;
  httpBasicAuthBcryptCost: number;
  httpBasicAuthArgon2idMemoryCost: number;
  httpBasicAuthArgon2idTimeCost: number;
  /** $server->caddySupportsArgon2idBasicAuth() and $server->proxyType(), for the Algorithm listbox. */
  supportsArgon2id: boolean;
  proxyType: string | null;
}

const json = (value: unknown): unknown => {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

/**
 * Server::configuredCaddyProxyImage(): services.caddy.image of the proxy configuration the server
 * last saved. Freeploy does not save proxy configurations yet (the proxy pages are not ported), so
 * there is none to read — as on a Coolify server whose configuration cannot be read: `basicauth`, no
 * `log_append`, no Argon2id.
 */
const configuredCaddyProxyImage = (): string | null => null;

function labelServer(row: DeployApplicationLabelRow): LabelServer {
  const proxy = json(row.server_proxy);
  return {
    proxy: proxy !== null && typeof proxy === "object" && !Array.isArray(proxy) ? (proxy as Record<string, unknown>) : null,
    caddyProxyImage: configuredCaddyProxyImage(),
    generateExactLabels: row.server_generate_exact_labels === true,
    traefikCertificateResolver: row.server_traefik_certificate_resolver ?? null,
    isTrafficAnalyticsEnabled: row.server_is_traffic_analytics_enabled === true,
  };
}

/** The row as generateLabelsApplication() reads the model; `password` is the decrypted column. */
function labelApplication(row: DeployApplicationLabelRow, password: string | null): LabelApplication {
  const overrides = json(row.domain_port_overrides);
  return {
    uuid: row.uuid,
    fqdn: row.fqdn ?? null,
    portsExposes: row.ports_exposes ?? null,
    redirect: row.redirect,
    isHttpBasicAuthEnabled: row.is_http_basic_auth_enabled === true,
    httpBasicAuthUsername: row.http_basic_auth_username ?? null,
    httpBasicAuthPassword: password,
    httpBasicAuthHashAlgorithm: row.http_basic_auth_hash_algorithm,
    httpBasicAuthBcryptCost: row.http_basic_auth_bcrypt_cost ?? null,
    httpBasicAuthArgon2idMemoryCost: row.http_basic_auth_argon2id_memory_cost,
    httpBasicAuthArgon2idTimeCost: row.http_basic_auth_argon2id_time_cost,
    noindexDomains: json(row.noindex_domains),
    domainPortOverrides: overrides !== null && typeof overrides === "object" && !Array.isArray(overrides) ? (overrides as Record<string, number | string>) : null,
    isStatic: row.is_static === true,
    // data_get($this, 'settings.is_force_https_enabled', false) and its siblings: the default only without a settings row.
    isForceHttpsEnabled: row.is_force_https_enabled ?? false,
    isGzipEnabled: row.is_gzip_enabled ?? true,
    isStripprefixEnabled: row.is_stripprefix_enabled ?? true,
    isPermanentRedirectEnabled: row.is_permanent_redirect_enabled === true,
    traefikCertificateResolver: row.application_traefik_certificate_resolver ?? null,
    destinationNetwork: row.destination_network ?? "",
    server: labelServer(row),
  };
}

/** One request's view of the application: the row, its password, and the labels as generated now. */
interface Loaded {
  row: DeployApplicationLabelRow;
  password: string | null;
}

async function load(ctx: ApplicationLabelContext, uuid: string): Promise<Loaded | null> {
  const row = await ctx.store.findSource(uuid);
  if (!row) return null;
  return { row, password: row.http_basic_auth_password === null || row.http_basic_auth_password === "" ? null : await ctx.cipher.decrypt(row.http_basic_auth_password) };
}

/**
 * str(implode('|coolify|', generateLabelsApplication($application)))->replace('|coolify|', "\n").
 * An application whose destination or server is gone has nothing to generate for.
 */
function generate(ctx: ApplicationLabelContext, loaded: Loaded): string[] {
  if (loaded.row.server_uuid === null) return [];
  return generateLabelsApplication(labelApplication(loaded.row, loaded.password), null, ctx.dependencies ?? DEFAULT_LABEL_DEPENDENCIES);
}

/** PHP's `! $value` for a string or null: null, "" and "0". */
const phpFalsy = (labels: string | null): boolean => labels === null || labels === "" || labels === "0";

function fields(loaded: Loaded, customLabels: string | null, canUpdate: boolean): ApplicationLabelFields {
  const { row } = loaded;
  const server = labelServer(row);
  const supportsArgon2id = caddySupportsArgon2idBasicAuth(server);
  return {
    customLabels: canUpdate ? customLabels : null,
    isContainerLabelReadonlyEnabled: row.is_container_label_readonly_enabled !== false,
    isContainerLabelEscapeEnabled: row.is_container_label_escape_enabled !== false,
    isHttpBasicAuthEnabled: row.is_http_basic_auth_enabled === true,
    httpBasicAuthUsername: row.http_basic_auth_username ?? null,
    httpBasicAuthPassword: canUpdate ? loaded.password : null,
    // usesArgon2idBasicAuth()
    httpBasicAuthHashAlgorithm: row.http_basic_auth_hash_algorithm === "argon2id" && supportsArgon2id ? "argon2id" : "bcrypt",
    httpBasicAuthBcryptCost: row.http_basic_auth_bcrypt_cost,
    httpBasicAuthArgon2idMemoryCost: row.http_basic_auth_argon2id_memory_cost,
    httpBasicAuthArgon2idTimeCost: row.http_basic_auth_argon2id_time_cost,
    supportsArgon2id,
    proxyType: proxyType(server),
  };
}

/** $application->custom_labels = …; save(): written only when the stored value changes. */
async function storeLabels(ctx: ApplicationLabelContext, loaded: Loaded, stored: string | null): Promise<void> {
  if (stored === (loaded.row.custom_labels ?? null)) return;
  await ctx.store.updateLabels(loaded.row.id, { custom_labels: stored });
  loaded.row.custom_labels = stored;
}

/** $application->parseContainerLabels(): the labels text, the row rewritten as base64 of it. */
async function parseStored(ctx: ApplicationLabelContext, loaded: Loaded): Promise<string | null> {
  const parsed = parseContainerLabels(loaded.row.custom_labels ?? null, () => generate(ctx, loaded));
  await storeLabels(ctx, loaded, parsed.store);
  return parsed.labels;
}

async function regenerate(ctx: ApplicationLabelContext, loaded: Loaded): Promise<string> {
  const labels = generate(ctx, loaded).join("\n");
  await storeLabels(ctx, loaded, encodeLabels(labels));
  return labels;
}

/**
 * General::mount() and syncData(): the stored labels, normalized to base64 of their text. An
 * application that has none yet gets the generated ones — when its labels are managed, its server has a
 * proxy (any type but NONE) and the caller may update, as mount() only saves for a user who can.
 */
export async function loadLabelFields(ctx: ApplicationLabelContext, uuid: string, canUpdate: boolean): Promise<ApplicationLabelFields | null> {
  const loaded = await load(ctx, uuid);
  if (!loaded) return null;
  let labels = await parseStored(ctx, loaded);
  if (phpFalsy(labels) && canUpdate && loaded.row.server_uuid !== null && proxyType(labelServer(loaded.row)) !== "NONE" && loaded.row.is_container_label_readonly_enabled === true) {
    labels = await regenerate(ctx, loaded);
  }
  return fields(loaded, labels, canUpdate);
}

/** syncData(toModel: true): "Argon2id needs a server that runs the Caddy proxy, version 2.11 or newer." */
export async function assertLabelFields(ctx: ApplicationLabelContext, uuid: string, input: LabelFieldsInput): Promise<void> {
  if (input.httpBasicAuthHashAlgorithm !== "argon2id") return;
  const row = await ctx.store.findSource(uuid);
  if (row && !caddySupportsArgon2idBasicAuth(labelServer(row))) throw new LabelError(LABEL_SERVICE_MESSAGES.argon2idUnsupported);
}

/** The model's dirty columns among the given fields, written; the row in memory follows. */
async function applyInput(ctx: ApplicationLabelContext, loaded: Loaded, input: LabelFieldsInput, only: ReadonlyArray<keyof LabelFieldsInput>): Promise<void> {
  const { row } = loaded;
  const given = <K extends keyof LabelFieldsInput>(key: K): LabelFieldsInput[K] | undefined => (only.includes(key) ? input[key] : undefined);

  const settings: ApplicationLabelSettingChanges = {};
  const escape = given("isContainerLabelEscapeEnabled");
  if (escape !== undefined && escape !== row.is_container_label_escape_enabled) settings.is_container_label_escape_enabled = escape;
  const readonly = given("isContainerLabelReadonlyEnabled");
  if (readonly !== undefined && readonly !== row.is_container_label_readonly_enabled) settings.is_container_label_readonly_enabled = readonly;
  if (Object.keys(settings).length) {
    await ctx.store.updateSettings(row.id, settings);
    Object.assign(row, settings);
  }

  const changes: ApplicationLabelChanges = {};
  const set = <C extends keyof ApplicationLabelChanges & keyof DeployApplicationLabelRow>(column: C, value: DeployApplicationLabelRow[C] | undefined): void => {
    if (value === undefined || value === row[column]) return;
    changes[column] = value as ApplicationLabelChanges[C];
    row[column] = value;
  };
  set("is_http_basic_auth_enabled", given("isHttpBasicAuthEnabled"));
  set("http_basic_auth_username", given("httpBasicAuthUsername"));
  set("http_basic_auth_hash_algorithm", given("httpBasicAuthHashAlgorithm"));
  set("http_basic_auth_bcrypt_cost", given("httpBasicAuthBcryptCost"));
  set("http_basic_auth_argon2id_memory_cost", given("httpBasicAuthArgon2idMemoryCost"));
  set("http_basic_auth_argon2id_time_cost", given("httpBasicAuthArgon2idTimeCost"));
  const password = given("httpBasicAuthPassword");
  if (password !== undefined && password !== loaded.password) {
    // The `encrypted` cast stores null as null and encrypts everything else, the empty string included.
    const stored = password === null ? null : await ctx.cipher.encrypt(password);
    changes.http_basic_auth_password = stored;
    row.http_basic_auth_password = stored;
    loaded.password = password;
  }
  if (Object.keys(changes).length) await ctx.store.updateLabels(row.id, changes);
}

const SUBMIT_FIELDS = [
  "isContainerLabelEscapeEnabled",
  "isContainerLabelReadonlyEnabled",
  "isHttpBasicAuthEnabled",
  "httpBasicAuthUsername",
  "httpBasicAuthPassword",
  "httpBasicAuthHashAlgorithm",
  "httpBasicAuthBcryptCost",
  "httpBasicAuthArgon2idMemoryCost",
  "httpBasicAuthArgon2idTimeCost",
] as const;

/** The fields whose listbox saves at once (onChange="instantSave"). */
const INSTANT_FIELDS = [
  "isContainerLabelEscapeEnabled",
  "isContainerLabelReadonlyEnabled",
  "isHttpBasicAuthEnabled",
  "httpBasicAuthHashAlgorithm",
  "httpBasicAuthBcryptCost",
  "httpBasicAuthArgon2idMemoryCost",
  "httpBasicAuthArgon2idTimeCost",
] as const;

/**
 * General::submit() for the label fields, after the application's other fields are saved. `before`
 * is the application as it was: submit() regenerates when the exposed ports or the escape setting
 * change. In submit()'s order:
 *   - the settings and the authentication fields are stored;
 *   - the labels text is the one given while labels are edited by hand, else the stored one;
 *   - checkFqdns(): an application with domains whose labels are managed gets them regenerated;
 *   - no labels, labels edited by hand and a proxy on the server: the generated ones are the start;
 *   - changed ports or a changed escape setting regenerate managed labels;
 *   - custom_labels = base64_encode($this->customLabels).
 */
export async function saveLabelFields(ctx: ApplicationLabelContext, uuid: string, input: LabelFieldsInput, before: { portsExposes: string | null }): Promise<ApplicationLabelFields | null> {
  const loaded = await load(ctx, uuid);
  if (!loaded) return null;
  const { row } = loaded;
  const oldEscape = row.is_container_label_escape_enabled;
  await applyInput(ctx, loaded, input, SUBMIT_FIELDS);
  const readonly = row.is_container_label_readonly_enabled !== false;

  let labels = parseContainerLabels(row.custom_labels ?? null, () => generate(ctx, loaded)).labels;
  // The textarea is read-only while labels are managed: what a client sends then is not taken.
  if (!readonly && input.customLabels !== undefined) labels = input.customLabels;

  const hasDomains = !phpFalsy(row.fqdn);
  const changed = (before.portsExposes ?? null) !== (row.ports_exposes ?? null) || oldEscape !== row.is_container_label_escape_enabled;
  const startFromGenerated = phpFalsy(labels) && !readonly && row.server_uuid !== null && proxyType(labelServer(row)) !== "NONE";
  if ((readonly && (hasDomains || changed)) || startFromGenerated) labels = generate(ctx, loaded).join("\n");

  await storeLabels(ctx, loaded, encodeLabels(labels ?? ""));
  return fields(loaded, labels, true);
}

/**
 * General::instantSave(): the changed listbox is stored — the two label settings, or the
 * authentication method and its hashing — then managed labels are regenerated. Coolify sends the whole
 * form with it and, when the method or the hashing changed, saves all of it; here only the instant
 * fields are read.
 */
export async function instantSaveLabelFields(ctx: ApplicationLabelContext, uuid: string, input: LabelFieldsInput): Promise<ApplicationLabelFields | null> {
  const loaded = await load(ctx, uuid);
  if (!loaded) return null;
  await applyInput(ctx, loaded, input, INSTANT_FIELDS);
  const labels = loaded.row.is_container_label_readonly_enabled !== false ? await regenerate(ctx, loaded) : await parseStored(ctx, loaded);
  return fields(loaded, labels, true);
}

/** General::resetDefaultLabels(true): the generated labels replace whatever is stored, managed or not. */
export async function resetDefaultLabels(ctx: ApplicationLabelContext, uuid: string): Promise<ApplicationLabelFields | null> {
  const loaded = await load(ctx, uuid);
  if (!loaded) return null;
  return fields(loaded, await regenerate(ctx, loaded), true);
}
