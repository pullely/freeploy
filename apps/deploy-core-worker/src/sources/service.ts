// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Source/Github/{Create,Change}.php,
// app/Http/Controllers/Webhook/Github.php (redirect, install, syncGithubAppOwner, sourceForGithubInstallation,
// installationReplacesSourceInstallation, redirectAfterGithubAppInstallationUpdate,
// verifiedGithubInstallation, githubAppHasManifestCredentials), app/Jobs/GithubAppPermissionJob.php,
// app/Models/{GithubApp,PrivateKey}.php (the deleting and saving hooks), routes/web.php (/sources) and
// bootstrap/helpers/github.php (syncGithubAppName) (Apache-2.0), modified.
//
// Integrations → Git sources for one org: the list, a GitHub App's creation (Create), its page (Change: the
// manifest and manual flows, the form, Test connection, Sync name, Check permissions, delete), and the two
// redirects GitHub sends the browser back with (the manifest's code, the installation). The store is the
// org's rows (withOrg); `cipher(column)` encrypts the encrypted casts; every GitHub call goes through
// `http`. Coolify's rules and messages word for word.
import type { DeployGithubAppRow, DeploySourceApplicationRow, DeploySourceListRow, GithubAppChanges, NewGithubApp } from "@saas/db/deploy";
import type { KeyCipher } from "../private-keys/service.js";
import { fingerprintSha256, formatPrivateKey, validationError } from "../keys/ssh-keys.js";
import { generateRandomName, kebab, newPublicId } from "../helpers/names.js";
import { isUrl } from "../servers/validation.js";
import { safeUrlError, type HostResolver } from "../s3-storages/safe-url.js";
import { add, blank, type FieldErrors } from "../private-keys/validation.js";
import {
  assertGithubClockInSync,
  githubAppAccountName,
  githubAppInfo,
  githubAppInstallationUrl,
  githubAppPermissionsUrl,
  githubAppSettingsUrl,
  githubApiUrlFromHtmlUrl,
  githubErrorMessage,
  githubInstallation,
  githubManifestConversion,
  GithubSourceError,
  isGithubAppConnected,
  normalizeGithubOrganization,
  type GithubAppCredentials,
  type InstallationTokens,
  type SourceHttp,
} from "./github.js";
import { GithubKeyError } from "./jwt.js";
import { createSetupState, readSetupState, type SetupAction } from "./setup-state.js";

export const SOURCE_MESSAGES = {
  updated: "Github App updated.",
  manuallyCreated: "Github App updated. You can now configure the details.",
  permissionsUpdated: "Github App permissions updated.",
  missingPermissionFields: (fields: string) => `Cannot fetch permissions. Please set the following required fields first: ${fields}`,
  privateKeyNotFound: "Private Key not found. Please select a valid private key.",
  unsupportedKey:
    "The selected private key format is not supported for GitHub Apps. \n\nPlease use an RSA private key in PEM format (BEGIN RSA PRIVATE KEY). \n\nOpenSSH format keys (BEGIN OPENSSH PRIVATE KEY) are not supported.",
  notSetUp: "GitHub App is not fully set up. Please complete installation first.",
  connectionFailed: (error: string) => `Connection failed: ${error}`,
  connectionSuccessful: (name: string) => `Connection successful! Authenticated as GitHub App: ${name}`,
  appIdRequired: "App ID is required before synchronizing the GitHub App name.",
  noPrivateKey: "No private key found for this GitHub App.",
  nameSynchronized: "GitHub App name and private key name synchronized successfully.",
  slugNotFound: "Could not find App Name (slug) in GitHub response.",
  inUse: "This source is being used by an application. Please delete all applications first.",
  organizationRequired: "GitHub Actions runners are registered at organization level. Enter the organization.",
  missingCode: "Missing GitHub App manifest code.",
  credentialsConfigured: "GitHub App credentials are already configured.",
  incompleteConversion: "GitHub App manifest conversion response is incomplete.",
  invalidSetupAction: "Invalid GitHub App setup action.",
  missingInstallationId: "Missing GitHub App installation id.",
  notVerified: (reason: string) => `GitHub App installation could not be verified: ${reason}`,
  missingAppIdOrKey: "The GitHub App ID or private key is missing.",
  differentApp: "The installation belongs to a different GitHub App.",
  newInstallationSource: "Added a new source for this installation. Each account that installs the GitHub App has its own source.",
  /** Freeploy's: a source shared with every org would cross tenants. */
  systemWide: "This action is unauthorized.",
} as const;

/** dispatch('error' | 'info', …), a ValidationException's field errors, or an abort(status, message). */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    readonly fields: FieldErrors | null = null,
    readonly kind: "error" | "info" = "error",
  ) {
    super(message);
  }
}

export interface SourceStore {
  list(): Promise<DeploySourceListRow[]>;
  findByUuid(uuid: string): Promise<DeployGithubAppRow | null>;
  findById(id: string | number): Promise<DeployGithubAppRow | null>;
  insert(app: Omit<NewGithubApp, "orgId">): Promise<DeployGithubAppRow>;
  replicate(id: string | number, uuid: string): Promise<DeployGithubAppRow | null>;
  update(id: string | number, changes: GithubAppChanges): Promise<DeployGithubAppRow | null>;
  delete(id: string | number): Promise<boolean>;
  findInstallation(apiUrl: string, appId: number | string, installationId: number | string): Promise<DeployGithubAppRow | null>;
  findByInstallationId(installationId: number | string): Promise<DeployGithubAppRow | null>;
  privateKey(id: string | number | null): Promise<{ id: string | number; name: string; private_key: string } | null>;
  privateKeys(): Promise<Array<{ id: string | number; uuid: string; name: string }>>;
  insertPrivateKey(key: { uuid: string; name: string; privateKey: string; fingerprint: string | null }): Promise<{ id: string | number }>;
  fingerprintExists(fingerprint: string | null): Promise<boolean>;
  renamePrivateKey(id: string | number, name: string): Promise<void>;
  privateKeyUsedElsewhere(privateKeyId: string | number, appId: string | number): Promise<boolean>;
  deletePrivateKey(id: string | number): Promise<void>;
  applications(appId: string | number): Promise<DeploySourceApplicationRow[]>;
}

export interface SourceContext {
  store: SourceStore;
  /** The cipher of an encrypted column ("github_apps.client_secret", "private_keys.private_key", …). */
  cipher(column: string): KeyCipher;
  http: SourceHttp;
  /** The org's public id (org_…). */
  org: string;
  /** What setup states are signed with (DEPLOY_ENCRYPTION_KEY). */
  stateSecret: string;
  resolve: HostResolver;
}

const PRIVATE_KEY_COLUMN = "private_keys.private_key";

/** The App with its private key decrypted, for the GitHub calls. */
export async function credentialsOf(ctx: Pick<SourceContext, "store" | "cipher">, app: DeployGithubAppRow): Promise<GithubAppCredentials & { private_key_id: string | number | null }> {
  const key = await ctx.store.privateKey(app.private_key_id);
  return {
    name: app.name,
    organization: app.organization,
    api_url: app.api_url,
    html_url: app.html_url,
    app_id: app.app_id,
    installation_id: app.installation_id,
    is_public: app.is_public,
    privateKey: key ? await ctx.cipher(PRIVATE_KEY_COLUMN).decrypt(key.private_key) : null,
    private_key_id: app.private_key_id,
  };
}

const decryptOrNull = async (ctx: SourceContext, column: string, stored: string | null): Promise<string | null> => (stored === null || stored === "" ? null : ctx.cipher(column).decrypt(stored));
const encryptOrNull = async (ctx: SourceContext, column: string, plain: string | null): Promise<string | null> => (plain === null ? null : ctx.cipher(column).encrypt(plain));

// ── The list ────────────────────────────────────────────────────────────────────────────────────────────

export interface SourceListItem {
  kind: "github" | "gitlab" | "gitea";
  uuid: string;
  name: string;
  /** "GitHub", "GitLab" or "Gitea / Forgejo", as the grid cards say. */
  provider: string;
  account: string | null;
  connected: boolean;
  htmlUrl: string;
  registered: boolean;
}

const PROVIDER = { github: "GitHub", gitlab: "GitLab", gitea: "Gitea / Forgejo" } as const;

/** routes/web.php /sources: Team::sources(). */
export async function listSources(ctx: SourceContext): Promise<SourceListItem[]> {
  return (await ctx.store.list()).map((s) => ({ kind: s.kind, uuid: s.uuid, name: s.name, provider: PROVIDER[s.kind], account: s.account, connected: Boolean(s.connected), htmlUrl: s.html_url, registered: Boolean(s.registered) }));
}

// ── Create ──────────────────────────────────────────────────────────────────────────────────────────────

/** Laravel's `bool` and `boolean` rules. */
const asBool = (value: unknown): boolean | null => (value === true || value === 1 || value === "1" ? true : value === false || value === 0 || value === "0" ? false : null);
/** Laravel's `int` rule (FILTER_VALIDATE_INT). */
const asInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : typeof value === "string" && /^[+-]?\d+$/.test(value.trim()) && value.trim() === value ? Number(value) : null;

const ORGANIZATION_RE = /^[^\s/?#]+$/;

async function urlRules(ctx: SourceContext, errors: FieldErrors, field: string, attribute: string, value: unknown): Promise<void> {
  if (blank(value)) return add(errors, field, `The ${attribute} field is required.`);
  if (typeof value !== "string") return add(errors, field, `The ${attribute} field must be a string.`);
  if (!isUrl(value)) add(errors, field, `The ${attribute} field must be a valid URL.`);
  // SafeExternalUrl::forGitSource(): Freeploy is hosted, so private networks stay blocked (Coolify Cloud's rule).
  const unsafe = await safeUrlError(value, attribute, field, ctx.resolve);
  if (unsafe) add(errors, field, unsafe);
}

export interface CreateGithubAppInput {
  name: string;
  organization: string | null;
  apiUrl: string;
  htmlUrl: string;
  customUser: string;
  customPort: number;
  previews: boolean;
}

/**
 * Create::createGitHubApp(): the organization normalized, the API URL derived from the HTML URL when empty,
 * then its rules. Is "System wide" — a source every org could use — is refused: Freeploy has no instance
 * admin who may make one. The GitHub Actions runners option is not offered (runners are not ported).
 */
export async function createGithubApp(ctx: SourceContext, body: Record<string, unknown>): Promise<{ uuid: string; previews: boolean }> {
  if (asBool(body.is_system_wide) === true) throw new SourceError(SOURCE_MESSAGES.systemWide, 403);
  const errors: FieldErrors = {};
  const organization = typeof body.organization === "string" ? normalizeGithubOrganization(body.organization) : body.organization === undefined ? null : body.organization;
  const htmlUrl = body.html_url === undefined ? "https://github.com" : body.html_url;
  let apiUrl = body.api_url === undefined ? "https://api.github.com" : body.api_url;
  if (blank(apiUrl) && typeof htmlUrl === "string") {
    try {
      apiUrl = githubApiUrlFromHtmlUrl(htmlUrl);
    } catch (e) {
      throw new SourceError(e instanceof Error ? e.message : String(e));
    }
  }
  const name = body.name;
  if (blank(name)) add(errors, "name", "The name field is required.");
  else if (typeof name !== "string") add(errors, "name", "The name field must be a string.");
  if (!blank(organization)) {
    if (typeof organization !== "string") add(errors, "organization", "The organization field must be a string.");
    else if (!ORGANIZATION_RE.test(organization)) add(errors, "organization", "The organization field format is invalid.");
  }
  await urlRules(ctx, errors, "api_url", "api url", apiUrl);
  await urlRules(ctx, errors, "html_url", "html url", htmlUrl);
  const customUser = body.custom_user === undefined ? "git" : body.custom_user;
  if (blank(customUser)) add(errors, "custom_user", "The custom user field is required.");
  else if (typeof customUser !== "string") add(errors, "custom_user", "The custom user field must be a string.");
  const customPort = body.custom_port === undefined ? 22 : body.custom_port;
  if (blank(customPort)) add(errors, "custom_port", "The custom port field is required.");
  else if (asInt(customPort) === null) add(errors, "custom_port", "The custom port field must be an integer.");
  const previews = body.use_for_pull_request_previews === undefined ? true : asBool(body.use_for_pull_request_previews);
  if (previews === null) add(errors, "use_for_pull_request_previews", "The use for pull request previews field must be true or false.");
  if (Object.keys(errors).length) throw new SourceError("Validation failed", 422, errors);
  const row = await ctx.store.insert({
    uuid: newPublicId(),
    name: name as string,
    organization: organization as string | null,
    apiUrl: apiUrl as string,
    htmlUrl: htmlUrl as string,
    customUser: customUser as string,
    customPort: asInt(customPort)!,
    isSystemWide: false,
  });
  return { uuid: row.uuid, previews: previews! };
}

/** Create::mount(): substr(generate_random_name(), 0, 30). */
export const defaultGithubAppName = (): string => generateRandomName().slice(0, 30);

// ── The page ────────────────────────────────────────────────────────────────────────────────────────────

export interface GithubAppPage {
  uuid: string;
  /** str($github_app->name)->kebab(), as the page shows it. */
  name: string;
  storedName: string;
  organization: string | null;
  apiUrl: string;
  htmlUrl: string;
  customUser: string;
  customPort: number;
  appId: number | null;
  installationId: number | null;
  installationAccount: string | null;
  accountName: string | null;
  clientId: string | null;
  /** Only for who may update. */
  clientSecret: string | null;
  webhookSecret: string | null;
  isSystemWide: boolean;
  privateKeyId: string | number | null;
  contents: string | null;
  metadata: string | null;
  pullRequests: string | null;
  administration: string | null;
  deployments: string | null;
  organizationSelfHostedRunners: string | null;
  actions: string | null;
  webhookEvents: string[];
  /** GithubApp::missingDeploymentRequirements() and missingRunnerRequirements(), as the Permissions tab lists them. */
  missingDeploymentRequirements: string[];
  missingRunnerRequirements: string[];
  isConnected: boolean;
  privateKeys: Array<{ id: string | number; name: string }>;
  applications: DeploySourceApplicationRow[];
  /** The state the manifest form posts with (only for who may update). */
  manifestState: string | null;
  /** getInstallationPath(), with a fresh install state (only for who may update and a registered App). */
  installationUrl: string | null;
  settingsUrl: string;
  permissionsUrl: string;
}

/** The webhook_events JSON column as a list. */
function webhookEventsOf(value: unknown): string[] {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : [];
}

/** GithubApp::missingRunnerRequirements(): what GitHub Actions runners need and the App does not have. */
function missingRunnerRequirements(app: DeployGithubAppRow): string[] {
  const missing: string[] = [];
  if (normalizeGithubOrganization(app.organization) === null) missing.push("An organization (runners are registered at organization level)");
  if (app.organization_self_hosted_runners !== "write") missing.push('Organization permission "Self-hosted runners": write');
  if (app.actions !== "read" && app.actions !== "write") missing.push('Repository permission "Actions": read');
  if (!webhookEventsOf(app.webhook_events).includes("workflow_job")) missing.push('Webhook event "Workflow job"');
  return missing;
}

/** Change::mount() and what the view reads: the App, its form's values, and the URLs of its buttons. */
export async function showGithubApp(ctx: SourceContext, uuid: string, canUpdate: boolean): Promise<GithubAppPage | null> {
  const app = await ctx.store.findByUuid(uuid);
  if (!app) return null;
  return {
    uuid: app.uuid,
    name: kebab(app.name),
    storedName: app.name,
    organization: app.organization,
    apiUrl: app.api_url,
    htmlUrl: app.html_url,
    customUser: app.custom_user,
    customPort: Number(app.custom_port),
    appId: app.app_id === null ? null : Number(app.app_id),
    installationId: app.installation_id === null ? null : Number(app.installation_id),
    installationAccount: app.installation_account,
    accountName: githubAppAccountName(app),
    clientId: app.client_id,
    clientSecret: canUpdate ? await decryptOrNull(ctx, "github_apps.client_secret", app.client_secret) : null,
    webhookSecret: canUpdate ? await decryptOrNull(ctx, "github_apps.webhook_secret", app.webhook_secret) : null,
    isSystemWide: app.is_system_wide,
    privateKeyId: app.private_key_id,
    contents: app.contents,
    metadata: app.metadata,
    pullRequests: app.pull_requests,
    administration: app.administration,
    deployments: app.deployments,
    organizationSelfHostedRunners: app.organization_self_hosted_runners,
    actions: app.actions,
    webhookEvents: webhookEventsOf(app.webhook_events),
    missingDeploymentRequirements: app.deployments === "write" ? [] : ['Repository permission "Deployments": write'],
    missingRunnerRequirements: missingRunnerRequirements(app),
    isConnected: isGithubAppConnected(app),
    privateKeys: (await ctx.store.privateKeys()).map((k) => ({ id: k.id, name: k.name })),
    applications: await ctx.store.applications(app.id),
    manifestState: canUpdate ? await createSetupState(ctx.stateSecret, "manifest", app.uuid, ctx.org) : null,
    installationUrl: canUpdate && app.app_id !== null ? githubAppInstallationUrl(app, await createSetupState(ctx.stateSecret, "install", app.uuid, ctx.org)) : null,
    settingsUrl: githubAppSettingsUrl(app),
    permissionsUrl: githubAppPermissionsUrl(app),
  };
}

/** The form's properties: what is sent, else what syncData(false) loaded. */
interface FormState {
  name: unknown;
  organization: unknown;
  apiUrl: unknown;
  htmlUrl: unknown;
  customUser: unknown;
  customPort: unknown;
  appId: unknown;
  installationId: unknown;
  clientId: unknown;
  clientSecret: unknown;
  webhookSecret: unknown;
  isSystemWide: unknown;
  privateKeyId: unknown;
  contents: unknown;
  metadata: unknown;
  pullRequests: unknown;
}

async function formState(ctx: SourceContext, app: DeployGithubAppRow, body: Record<string, unknown>): Promise<FormState> {
  const pick = (key: keyof FormState, loaded: unknown): unknown => (key in body ? body[key] : loaded);
  return {
    name: pick("name", kebab(app.name)),
    organization: pick("organization", app.organization),
    apiUrl: pick("apiUrl", app.api_url),
    htmlUrl: pick("htmlUrl", app.html_url),
    customUser: pick("customUser", app.custom_user),
    customPort: pick("customPort", app.custom_port),
    appId: pick("appId", app.app_id),
    installationId: pick("installationId", app.installation_id),
    clientId: pick("clientId", app.client_id),
    clientSecret: "clientSecret" in body ? body.clientSecret : await decryptOrNull(ctx, "github_apps.client_secret", app.client_secret),
    webhookSecret: "webhookSecret" in body ? body.webhookSecret : await decryptOrNull(ctx, "github_apps.webhook_secret", app.webhook_secret),
    isSystemWide: pick("isSystemWide", app.is_system_wide),
    privateKeyId: pick("privateKeyId", app.private_key_id),
    contents: pick("contents", app.contents),
    metadata: pick("metadata", app.metadata),
    pullRequests: pick("pullRequests", app.pull_requests),
  };
}

const nullableString = (errors: FieldErrors, field: string, attribute: string, value: unknown): void => {
  if (!blank(value) && typeof value !== "string") add(errors, field, `The ${attribute} field must be a string.`);
};
const nullableInt = (errors: FieldErrors, field: string, attribute: string, value: unknown): void => {
  if (!blank(value) && asInt(value) === null) add(errors, field, `The ${attribute} field must be an integer.`);
};

async function privateKeyRule(ctx: SourceContext, errors: FieldErrors, value: unknown): Promise<void> {
  if (blank(value)) return;
  if (asInt(value) === null) return add(errors, "privateKeyId", "The private key id field must be an integer.");
  // Rule::exists('private_keys', 'id')->where('team_id', …): row-level security keeps it to the org.
  if (!(await ctx.store.privateKey(asInt(value)!))) add(errors, "privateKeyId", "The selected private key id is invalid.");
}

/** Change::rules(), with the camelCase properties as Laravel names them ("api url", "private key id"). */
async function validateForm(ctx: SourceContext, form: FormState): Promise<FieldErrors> {
  const errors: FieldErrors = {};
  if (blank(form.name)) add(errors, "name", "The name field is required.");
  else if (typeof form.name !== "string") add(errors, "name", "The name field must be a string.");
  if (!blank(form.organization)) {
    if (typeof form.organization !== "string") add(errors, "organization", "The organization field must be a string.");
    else if (!ORGANIZATION_RE.test(form.organization)) add(errors, "organization", "The organization field format is invalid.");
  }
  await urlRules(ctx, errors, "apiUrl", "api url", form.apiUrl);
  await urlRules(ctx, errors, "htmlUrl", "html url", form.htmlUrl);
  if (blank(form.customUser)) add(errors, "customUser", "The custom user field is required.");
  else if (typeof form.customUser !== "string") add(errors, "customUser", "The custom user field must be a string.");
  if (blank(form.customPort)) add(errors, "customPort", "The custom port field is required.");
  else if (asInt(form.customPort) === null) add(errors, "customPort", "The custom port field must be an integer.");
  nullableInt(errors, "appId", "app id", form.appId);
  nullableInt(errors, "installationId", "installation id", form.installationId);
  nullableString(errors, "clientId", "client id", form.clientId);
  nullableString(errors, "clientSecret", "client secret", form.clientSecret);
  nullableString(errors, "webhookSecret", "webhook secret", form.webhookSecret);
  if (blank(form.isSystemWide) && form.isSystemWide !== false) add(errors, "isSystemWide", "The is system wide field is required.");
  else if (asBool(form.isSystemWide) === null) add(errors, "isSystemWide", "The is system wide field must be true or false.");
  nullableString(errors, "contents", "contents", form.contents);
  nullableString(errors, "metadata", "metadata", form.metadata);
  nullableString(errors, "pullRequests", "pull requests", form.pullRequests);
  await privateKeyRule(ctx, errors, form.privateKeyId);
  return errors;
}

const strOrNull = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const intOrNull = (v: unknown): number | null => (blank(v) ? null : asInt(v));

/** syncData(true): every property onto the row, the secrets encrypted. */
async function changesOf(ctx: SourceContext, form: FormState): Promise<GithubAppChanges> {
  return {
    name: String(form.name),
    organization: strOrNull(form.organization),
    api_url: String(form.apiUrl),
    html_url: String(form.htmlUrl),
    custom_user: String(form.customUser),
    custom_port: asInt(form.customPort)!,
    app_id: intOrNull(form.appId),
    installation_id: intOrNull(form.installationId),
    client_id: strOrNull(form.clientId),
    client_secret: await encryptOrNull(ctx, "github_apps.client_secret", strOrNull(form.clientSecret)),
    webhook_secret: await encryptOrNull(ctx, "github_apps.webhook_secret", strOrNull(form.webhookSecret)),
    is_system_wide: asBool(form.isSystemWide)!,
    private_key_id: intOrNull(form.privateKeyId),
    contents: strOrNull(form.contents),
    metadata: strOrNull(form.metadata),
    pull_requests: strOrNull(form.pullRequests),
  };
}

/**
 * Change::submit() (and, with `instantSave`, instantSave(): only the private key is validated): the
 * organization normalized and the API URL derived when empty, the rules, then every property saved.
 * Making the App system-wide is refused (authorizeSystemWideChange: no one in Freeploy may).
 */
export async function updateGithubApp(ctx: SourceContext, uuid: string, body: Record<string, unknown>): Promise<DeployGithubAppRow | null> {
  const app = await ctx.store.findByUuid(uuid);
  if (!app) return null;
  const form = await formState(ctx, app, body);
  if (asBool(form.isSystemWide) === true && !app.is_system_wide) throw new SourceError(SOURCE_MESSAGES.systemWide, 403);
  if (body.instantSave === true) {
    const errors: FieldErrors = {};
    await privateKeyRule(ctx, errors, form.privateKeyId);
    if (Object.keys(errors).length) throw new SourceError(errors.privateKeyId![0]!, 422, errors);
  } else {
    form.organization = typeof form.organization === "string" ? normalizeGithubOrganization(form.organization) : form.organization;
    if (blank(form.apiUrl) && typeof form.htmlUrl === "string") {
      try {
        form.apiUrl = githubApiUrlFromHtmlUrl(form.htmlUrl);
      } catch (e) {
        throw new SourceError(e instanceof Error ? e.message : String(e));
      }
    }
    const errors = await validateForm(ctx, form);
    if (Object.keys(errors).length) throw new SourceError("Validation failed", 422, errors);
  }
  return ctx.store.update(app.id, await changesOf(ctx, form));
}

/** createGithubAppManually(): placeholder ids, so the page shows the form to fill in. */
export async function createGithubAppManually(ctx: SourceContext, uuid: string): Promise<boolean> {
  const app = await ctx.store.findByUuid(uuid);
  if (!app) return false;
  await ctx.store.update(app.id, { app_id: 1234567890, installation_id: 1234567890 });
  return true;
}

const isUnsupportedKey = (e: unknown): boolean => {
  const message = e instanceof Error ? e.message : String(e);
  return message.includes("DECODER routines::unsupported") || message.includes("parse your key");
};

/** handleError(): the exception's message as the error toast; Coolify's wording for an unreadable key. */
function asSourceError(e: unknown): SourceError {
  if (e instanceof SourceError) return e;
  if (e instanceof GithubKeyError || isUnsupportedKey(e)) return new SourceError(SOURCE_MESSAGES.unsupportedKey);
  return new SourceError(e instanceof Error ? e.message : String(e));
}

/**
 * GithubAppPermissionJob: GET /app for the permissions the App requests and its events, and the installation
 * for what it granted (deployments) and its account.
 */
async function syncPermissions(ctx: SourceContext, app: DeployGithubAppRow): Promise<DeployGithubAppRow | null> {
  const credentials = await credentialsOf(ctx, app);
  const now = (ctx.http.now ?? (() => new Date()))();
  const { response, json } = await githubAppInfo(ctx.http, credentials);
  if (response.status < 200 || response.status >= 300) {
    assertGithubClockInSync(response, now);
    throw new GithubSourceError(`Failed to fetch GitHub app permissions: ${JSON.stringify(json ?? "")}`);
  }
  const permissions = ((json as { permissions?: Record<string, unknown> } | null)?.permissions ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const changes: GithubAppChanges = {
    contents: str(permissions.contents),
    metadata: str(permissions.metadata),
    pull_requests: str(permissions.pull_requests),
    administration: str(permissions.administration),
    organization_self_hosted_runners: str(permissions.organization_self_hosted_runners),
    actions: str(permissions.actions),
    webhook_events: JSON.stringify((json as { events?: unknown } | null)?.events ?? []),
  };
  if (app.installation_id !== null) {
    const installation = await githubInstallation(ctx.http, credentials, app.installation_id);
    if (installation.response.status < 200 || installation.response.status >= 300) throw new GithubSourceError(`Failed to fetch GitHub app installation permissions: ${JSON.stringify(installation.json ?? "")}`);
    const inst = installation.json as { permissions?: { deployments?: unknown }; account?: { login?: unknown } } | null;
    changes.deployments = str(inst?.permissions?.deployments);
    changes.installation_account = str(inst?.account?.login);
  } else {
    changes.deployments = null;
  }
  return ctx.store.update(app.id, changes);
}

/**
 * syncGithubAppName(): the App's slug from GET /app becomes its name, and its private key's name
 * "github-app-<slug>". Null when there is no App id, key, or slug; with `throwErrors`, GitHub's refusal throws.
 */
async function syncGithubAppName(ctx: SourceContext, app: DeployGithubAppRow, throwErrors: boolean): Promise<string | null> {
  try {
    if (app.app_id === null || app.private_key_id === null) return null;
    const key = await ctx.store.privateKey(app.private_key_id);
    if (!key) return null;
    const credentials = await credentialsOf(ctx, app);
    const now = (ctx.http.now ?? (() => new Date()))();
    const { response, json } = await githubAppInfo(ctx.http, credentials, { "X-GitHub-Api-Version": "2022-11-28" });
    if (response.status < 200 || response.status >= 300) {
      assertGithubClockInSync(response, now);
      throw new GithubSourceError(githubErrorMessage(json) ?? "Failed to fetch GitHub App information.");
    }
    const slug = (json as { slug?: unknown } | null)?.slug;
    if (typeof slug !== "string" || slug.trim() === "") return null;
    await ctx.store.update(app.id, { name: slug });
    await ctx.store.renamePrivateKey(key.id, `github-app-${slug}`);
    return slug;
  } catch (e) {
    if (throwErrors) throw e;
    return null;
  }
}

/** checkPermissions(). */
export async function checkGithubAppPermissions(ctx: SourceContext, uuid: string): Promise<{ message: string } | null> {
  const app = await ctx.store.findByUuid(uuid);
  if (!app) return null;
  const missing = [...(app.app_id === null ? ["App ID"] : []), ...(app.private_key_id === null ? ["Private Key"] : [])];
  if (missing.length) throw new SourceError(SOURCE_MESSAGES.missingPermissionFields(missing.join(", ")));
  if (!(await ctx.store.privateKey(app.private_key_id))) throw new SourceError(SOURCE_MESSAGES.privateKeyNotFound);
  try {
    await syncGithubAppName(ctx, app, false);
    const fresh = (await ctx.store.findById(app.id)) ?? app;
    await syncPermissions(ctx, fresh);
  } catch (e) {
    throw asSourceError(e);
  }
  return { message: SOURCE_MESSAGES.permissionsUpdated };
}

/** testConnection(): GET /app with the JWT, then an installation token. */
export async function testGithubAppConnection(ctx: SourceContext, uuid: string, tokens: InstallationTokens): Promise<{ message: string } | null> {
  const app = await ctx.store.findByUuid(uuid);
  if (!app) return null;
  if (!isGithubAppConnected(app)) throw new SourceError(SOURCE_MESSAGES.notSetUp);
  if (app.private_key_id === null || !(await ctx.store.privateKey(app.private_key_id))) throw new SourceError(SOURCE_MESSAGES.privateKeyNotFound);
  try {
    const credentials = await credentialsOf(ctx, app);
    const now = (ctx.http.now ?? (() => new Date()))();
    const { response, json } = await githubAppInfo(ctx.http, credentials);
    if (response.status < 200 || response.status >= 300) {
      assertGithubClockInSync(response, now);
      throw new SourceError(SOURCE_MESSAGES.connectionFailed(githubErrorMessage(json) ?? "Unknown error"));
    }
    await tokens.token(credentials);
    const info = (json ?? {}) as { name?: unknown; slug?: unknown };
    const name = info.name ?? info.slug ?? "unknown";
    return { message: SOURCE_MESSAGES.connectionSuccessful(String(name)) };
  } catch (e) {
    throw asSourceError(e);
  }
}

/** updateGithubAppName(): the form's App id and key (not saved first), then syncGithubAppName(throw: true). */
export async function syncGithubAppNameAction(ctx: SourceContext, uuid: string, body: Record<string, unknown>): Promise<{ message: string; kind: "success" | "info"; name: string } | null> {
  const app = await ctx.store.findByUuid(uuid);
  if (!app) return null;
  const appId = "appId" in body ? intOrNull(body.appId) : app.app_id;
  const privateKeyId = "privateKeyId" in body ? intOrNull(body.privateKeyId) : app.private_key_id === null ? null : Number(app.private_key_id);
  if (appId === null || appId === 0) throw new SourceError(SOURCE_MESSAGES.appIdRequired);
  if (privateKeyId === null || !(await ctx.store.privateKey(privateKeyId))) throw new SourceError(SOURCE_MESSAGES.noPrivateKey);
  let slug: string | null;
  try {
    slug = await syncGithubAppName(ctx, { ...app, app_id: appId, private_key_id: privateKeyId }, true);
  } catch (e) {
    throw asSourceError(e);
  }
  // The App id and key are saved with the name only when GitHub answered with a slug.
  if (slug !== null) {
    await ctx.store.update(app.id, { app_id: appId, private_key_id: privateKeyId });
    return { message: SOURCE_MESSAGES.nameSynchronized, kind: "success", name: kebab(slug) };
  }
  return { message: SOURCE_MESSAGES.slugNotFound, kind: "info", name: kebab(app.name) };
}

/**
 * Change::delete() and the deleting hook: refused while an application uses the App; its private key goes
 * with it unless anything else uses that key.
 */
export async function deleteGithubApp(ctx: SourceContext, uuid: string): Promise<boolean> {
  const app = await ctx.store.findByUuid(uuid);
  if (!app) return false;
  const applications = await ctx.store.applications(app.id);
  if (applications.length > 0) throw new SourceError(SOURCE_MESSAGES.inUse);
  const key = await ctx.store.privateKey(app.private_key_id);
  if (key && !(await ctx.store.privateKeyUsedElsewhere(key.id, app.id))) {
    await ctx.store.delete(app.id);
    await ctx.store.deletePrivateKey(key.id);
    return true;
  }
  return ctx.store.delete(app.id);
}

// ── GitHub's redirects ──────────────────────────────────────────────────────────────────────────────────

/** githubAppHasManifestCredentials(). */
const hasManifestCredentials = (app: DeployGithubAppRow): boolean =>
  app.app_id !== null || !blank(app.client_id) || !blank(app.client_secret) || !blank(app.webhook_secret) || app.private_key_id !== null;

/**
 * syncGithubAppOwner(): GitHub registers the App on the account its form shows, not always on the manifest's
 * organization; the real owner is stored, and the user warned when it is not the one asked for.
 */
export function githubAppOwner(requestedOrganization: string | null, owner: { login?: unknown; type?: unknown }): { organization: string | null | undefined; warning: string | null } {
  const login = owner.login;
  if (typeof login !== "string" || login.trim() === "") return { organization: undefined, warning: null };
  const requested = normalizeGithubOrganization(requestedOrganization);
  const isOrganization = owner.type === "Organization";
  const organization = isOrganization ? login : null;
  if (requested === null || requested === "" || (isOrganization && requested.toLowerCase() === login.toLowerCase())) return { organization, warning: null };
  const account = owner.type === "User" ? `personal account ${login}` : `account ${login}`;
  return {
    organization,
    warning:
      `GitHub registered this GitHub App on your ${account}, not on the organization ${requested}. ` +
      `It can only be installed on ${login}. Make sure that your GitHub user is an owner or a GitHub App manager of ${requested}, ` +
      "then delete this GitHub App on GitHub and in Freeploy, and create it again.",
  };
}

/** The org and App a setup state names, or null (Coolify redirects to the Sources page). */
export async function setupStateTarget(stateSecret: string, state: unknown, action: SetupAction): Promise<{ org: string; app: string } | null> {
  const payload = await readSetupState(stateSecret, state, action);
  return payload ? { org: payload.org, app: payload.app } : null;
}

/**
 * Github::redirect(): the manifest's code exchanged for the App's credentials, the private key stored as a
 * PrivateKey "github-app-<slug>" (is_git_related), the App's id, client id and secret, webhook secret and
 * owner saved. The caller has checked the state and that the actor may update the App.
 */
export async function completeGithubAppManifest(ctx: SourceContext, appUuid: string, code: unknown): Promise<{ uuid: string; error: string | null } | null> {
  if (typeof code !== "string" || code.trim() === "") throw new SourceError(SOURCE_MESSAGES.missingCode, 422);
  const app = await ctx.store.findByUuid(appUuid);
  if (!app) return null;
  if (hasManifestCredentials(app)) throw new SourceError(SOURCE_MESSAGES.credentialsConfigured, 403);
  const data = (await githubManifestConversion(ctx.http, app.api_url, code)) as Record<string, unknown> | null;
  const get = (key: string): unknown => (data !== null && typeof data === "object" ? data[key] : undefined);
  const [id, slug, clientId, clientSecret, pem, webhookSecret] = ["id", "slug", "client_id", "client_secret", "pem", "webhook_secret"].map(get);
  if ([id, slug, clientId, clientSecret, pem, webhookSecret].some((v) => blank(v))) throw new SourceError(SOURCE_MESSAGES.incompleteConversion, 422);
  // PrivateKey::create(): the saving hook formats, checks and fingerprints the key.
  const formatted = formatPrivateKey(String(pem));
  const invalid = validationError(formatted, true);
  if (invalid) throw new SourceError(invalid, 422, { private_key: [invalid] });
  const fingerprint = await fingerprintSha256(formatted);
  if (await ctx.store.fingerprintExists(fingerprint)) throw new SourceError("This private key already exists.", 422, { private_key: ["This private key already exists."] });
  const key = await ctx.store.insertPrivateKey({ uuid: newPublicId(), name: `github-app-${String(slug)}`, privateKey: await ctx.cipher(PRIVATE_KEY_COLUMN).encrypt(formatted), fingerprint });
  const owner = githubAppOwner(app.organization, (get("owner") ?? {}) as { login?: unknown; type?: unknown });
  await ctx.store.update(app.id, {
    name: String(slug),
    app_id: Number(id),
    client_id: String(clientId),
    client_secret: await ctx.cipher("github_apps.client_secret").encrypt(String(clientSecret)),
    webhook_secret: await ctx.cipher("github_apps.webhook_secret").encrypt(String(webhookSecret)),
    private_key_id: key.id,
    ...(owner.organization === undefined ? {} : { organization: owner.organization }),
  });
  return { uuid: app.uuid, error: owner.warning };
}

/**
 * verifiedGithubInstallation(): the installation id came in a query string, so GitHub is asked, with the
 * App's own JWT, whether it is this App's.
 */
async function verifiedInstallation(ctx: SourceContext, app: DeployGithubAppRow, installationId: string): Promise<{ installation: Record<string, unknown> } | { error: string }> {
  const credentials = await credentialsOf(ctx, app);
  if (app.app_id === null || blank(credentials.privateKey)) return { error: SOURCE_MESSAGES.missingAppIdOrKey };
  let answer: { response: Response; json: unknown };
  try {
    answer = await githubInstallation(ctx.http, credentials, installationId);
    if (answer.response.status < 200 || answer.response.status >= 300) assertGithubClockInSync(answer.response, (ctx.http.now ?? (() => new Date()))());
  } catch (e) {
    return { error: (e instanceof Error ? e.message : String(e)).replace(/\n/g, " ").replace(/<[^>]*>/g, "") };
  }
  if (answer.response.status < 200 || answer.response.status >= 300) return { error: `GitHub API returned HTTP ${answer.response.status}: ${githubErrorMessage(answer.json) ?? "no error message found"}` };
  const installation = answer.json;
  if (installation === null || typeof installation !== "object" || Array.isArray(installation) || String((installation as Record<string, unknown>).app_id) !== String(app.app_id)) {
    return { error: SOURCE_MESSAGES.differentApp };
  }
  return { installation: installation as Record<string, unknown> };
}

/** installationReplacesSourceInstallation(): no installation yet, the same one, or the old one gone or the same account's. */
async function replacesInstallation(ctx: SourceContext, app: DeployGithubAppRow, installationId: string, installation: Record<string, unknown>): Promise<boolean> {
  if (app.installation_id === null || String(app.installation_id) === installationId) return true;
  try {
    const current = await githubInstallation(ctx.http, await credentialsOf(ctx, app), app.installation_id);
    if (current.response.status === 404) return true;
    const account = (v: unknown): unknown => (v !== null && typeof v === "object" ? (v as { account?: { id?: unknown } }).account?.id : undefined);
    return current.response.status >= 200 && current.response.status < 300 && account(current.json) === account(installation);
  } catch {
    return false;
  }
}

/** Github::install() for setup_action "update": the org's source of that installation, else the list. */
export async function installationUpdateTarget(ctx: SourceContext, installationId: string): Promise<string | null> {
  const app = await ctx.store.findByInstallationId(installationId);
  return app ? app.uuid : null;
}

/** Github::install() argument checks, before anything is read. */
export function checkInstallArguments(setupAction: unknown, installationId: unknown): { setupAction: "install" | "update"; installationId: string } {
  if (setupAction !== "install" && setupAction !== "update") throw new SourceError(SOURCE_MESSAGES.invalidSetupAction, 422);
  if (typeof installationId !== "string" || !/^\d+$/.test(installationId)) throw new SourceError(SOURCE_MESSAGES.missingInstallationId, 422);
  return { setupAction, installationId };
}

/**
 * Github::install() for setup_action "install": the installation verified, then stored on the App — or, when
 * the App is already installed on another account, on a new source for this installation (a copy of the App),
 * as one App installed on several accounts is several sources.
 */
export async function completeGithubAppInstallation(ctx: SourceContext, appUuid: string, installationId: string): Promise<{ uuid: string; error: string | null; success: string | null } | null> {
  const app = await ctx.store.findByUuid(appUuid);
  if (!app) return null;
  const verified = await verifiedInstallation(ctx, app, installationId);
  if ("error" in verified) return { uuid: app.uuid, error: SOURCE_MESSAGES.notVerified(verified.error), success: null };
  const installation = verified.installation;
  let source: DeployGithubAppRow | null = app;
  if (!(await replacesInstallation(ctx, app, installationId, installation))) {
    source = (await ctx.store.findInstallation(app.api_url, app.app_id!, installationId)) ?? (await ctx.store.replicate(app.id, newPublicId()));
  }
  if (!source) return null;
  const account = (installation.account as { login?: unknown } | undefined)?.login;
  const deployments = (installation.permissions as { deployments?: unknown } | undefined)?.deployments;
  await ctx.store.update(source.id, {
    installation_id: Number(installationId),
    installation_account: typeof account === "string" ? account : null,
    deployments: typeof deployments === "string" ? deployments : null,
  });
  return { uuid: source.uuid, error: null, success: source.id === app.id ? null : SOURCE_MESSAGES.newInstallationSource };
}
