// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Source/Gitlab/{Create,Change}.php,
// app/Livewire/Source/Gitea/{Create,Change}.php, app/Http/Controllers/Webhook/{Gitlab,Gitea}.php (redirect),
// app/Livewire/Project/New/{GitlabPrivateRepository,GiteaPrivateRepository}.php (loadRepositories, loadBranches),
// app/Models/{GitlabApp,GiteaApp}.php and app/Policies/{GitlabAppPolicy,GiteaAppPolicy}.php (Apache-2.0), modified.
//
// Integrations → Git sources, the two OAuth sources (DP-103): a GitLab App and a Gitea / Forgejo App — the New source
// dialogs (Create), the source's page (Change: its form, Test connection, delete), the OAuth redirect the instance
// sends the browser back with, and the repositories and branches the source may use. The store is the org's rows
// (withOrg); `cipher(column)` encrypts the encrypted casts (GitLab's webhook_token too, which Coolify encrypts with
// Crypt::encryptString()); every call to the instance goes through `http`. Coolify's rules, messages and toasts word for
// word. Freeploy is a hosted service, so it runs as Coolify Cloud: no source is system-wide, the instance IPs are never
// offered, and the redirect URI is the console's own URL (config('app.url')), with no endpoint to choose.
import type { DeployOauthSourceRow, DeploySourceApplicationRow, NewOauthSource, OauthSourceChanges, OauthSourceKind } from "@saas/db/deploy";
import type { KeyCipher } from "../private-keys/service.js";
import { add, blank, type FieldErrors } from "../private-keys/validation.js";
import { randomString, newPublicId } from "../helpers/names.js";
import { safeUrlError, type HostResolver } from "../s3-storages/safe-url.js";
import { isUrl } from "../servers/validation.js";
import { createSetupState } from "./setup-state.js";
import { SOURCE_MESSAGES, SourceError } from "./service.js";
import { sortBranchesByPriority, type SourceHttp } from "./github.js";
import {
  apiUrlFromHtmlUrl,
  exchangeOauthCode,
  isOauthConnected,
  loadOauthBranches,
  loadOauthRepositories,
  networkOf,
  OAUTH_PROVIDERS,
  oauthUser,
  OauthPhpError,
  OauthRefreshError,
  refreshOauthToken,
  type OauthCredentials,
  type OauthRepository,
  type OauthTokens,
} from "./oauth-git.js";

export type { OauthSourceKind };

export const OAUTH_SOURCE_MESSAGES = {
  gitlab: {
    label: "GitLab App",
    updated: "GitLab App updated.",
    notConnected: "GitLab App is not connected. Please complete the OAuth flow first.",
    invalidCallback: "Invalid GitLab OAuth callback. Missing code or state.",
    invalidState: "Invalid or expired GitLab OAuth state. Please start the authorization again.",
    notAuthorized: "You are not authorized to connect this GitLab App.",
    oauthFailed: (error: string) => `GitLab OAuth failed: ${error}`,
  },
  gitea: {
    label: "Gitea / Forgejo App",
    updated: "Gitea / Forgejo App updated.",
    notConnected: "Gitea / Forgejo App is not connected. Please complete the OAuth flow first.",
    invalidCallback: "Invalid Gitea OAuth callback. Missing code or state.",
    invalidState: "Invalid or expired Gitea OAuth state. Please start the authorization again.",
    notAuthorized: "You are not authorized to connect this Gitea / Forgejo App.",
    oauthFailed: (error: string) => `Gitea OAuth failed: ${error}`,
  },
  connectionSuccessful: (user: string) => `Connection successful! Authenticated as: ${user}`,
  connectionFailed: (error: string) => `Connection failed: ${error}`,
  inUse: SOURCE_MESSAGES.inUse,
  /** Freeploy's: a source shared with every org would cross tenants (makeSystemWide). */
  systemWide: SOURCE_MESSAGES.systemWide,
} as const;

/** Create's defaults: gitlab.com, and Gitea.com (Gitea's provider listbox starts there). */
export const OAUTH_SOURCE_DEFAULTS = {
  gitlab: { htmlUrl: "https://gitlab.com", apiUrl: "https://gitlab.com/api/v4" },
  gitea: { htmlUrl: "https://gitea.com", apiUrl: "https://gitea.com/api/v1" },
} as const;

/** Gitea's Create::HOSTED_PROVIDERS: the hosted instances the provider choice fills in. */
export const GITEA_HOSTED_PROVIDERS: Record<string, string> = { "gitea.com": "https://gitea.com", "codeberg.org": "https://codeberg.org" };

export interface OauthSourceStore {
  findByUuid(kind: OauthSourceKind, uuid: string): Promise<DeployOauthSourceRow | null>;
  insert(kind: OauthSourceKind, source: Omit<NewOauthSource, "orgId">): Promise<DeployOauthSourceRow>;
  update(kind: OauthSourceKind, id: string | number, changes: OauthSourceChanges): Promise<DeployOauthSourceRow | null>;
  delete(kind: OauthSourceKind, id: string | number): Promise<boolean>;
  privateKey(id: string | number | null): Promise<{ id: string | number; name: string } | null>;
  privateKeys(): Promise<Array<{ id: string | number; uuid: string; name: string }>>;
  applications(kind: OauthSourceKind, id: string | number): Promise<DeploySourceApplicationRow[]>;
}

export interface OauthSourceContext {
  store: OauthSourceStore;
  /** The cipher of an encrypted column ("gitlab_apps.client_secret", …). */
  cipher(column: string): KeyCipher;
  http: SourceHttp;
  /** The org's public id (org_…): the OAuth state names it. */
  org: string;
  /** What the state is signed with (DEPLOY_ENCRYPTION_KEY). */
  stateSecret: string;
  resolve: HostResolver;
  /** config('app.url'): the console, where the instance sends the browser back to. */
  consoleUrl: string;
}

const TABLE: Record<OauthSourceKind, string> = { gitlab: "gitlab_apps", gitea: "gitea_apps" };
/** GitLab's webhook token, Gitea's webhook secret. */
const WEBHOOK_COLUMN: Record<OauthSourceKind, "webhook_token" | "webhook_secret"> = { gitlab: "webhook_token", gitea: "webhook_secret" };
/** The form's property of it, and of the repository filter (GitLab's group name, Gitea's organization). */
const WEBHOOK_FIELD: Record<OauthSourceKind, "webhookToken" | "webhookSecret"> = { gitlab: "webhookToken", gitea: "webhookSecret" };
const FILTER_FIELD: Record<OauthSourceKind, "groupName" | "organization"> = { gitlab: "groupName", gitea: "organization" };
const FILTER_COLUMN: Record<OauthSourceKind, "group_name" | "organization"> = { gitlab: "group_name", gitea: "organization" };

const decryptOrNull = async (ctx: Pick<OauthSourceContext, "cipher">, kind: OauthSourceKind, column: string, stored: string | null): Promise<string | null> =>
  stored === null || stored === "" ? null : ctx.cipher(`${TABLE[kind]}.${column}`).decrypt(stored);
const encrypt = (ctx: Pick<OauthSourceContext, "cipher">, kind: OauthSourceKind, column: string, plain: string): Promise<string> => ctx.cipher(`${TABLE[kind]}.${column}`).encrypt(plain);

/** Laravel's `bool` rule. */
const asBool = (value: unknown): boolean | null => (value === true || value === 1 || value === "1" ? true : value === false || value === 0 || value === "0" ? false : null);
/** Laravel's `int` rule (FILTER_VALIDATE_INT). */
const asInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : typeof value === "string" && /^[+-]?\d+$/.test(value.trim()) && value.trim() === value ? Number(value) : null;
const rtrimSlash = (v: string): string => v.replace(/\/+$/, "");
const strOrNull = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

/** The redirect URI the instance sends the browser back to: refreshRedirectUri() with config('app.url') as the base. */
export const oauthRedirectUri = (consoleUrl: string, kind: OauthSourceKind): string => `${rtrimSlash(consoleUrl)}${OAUTH_PROVIDERS[kind].redirectPath}`;

// ── Create ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ['required', 'string', 'url', SafeExternalUrl::forGitSource()]: Laravel's messages with the attribute's name, then
 * SafeWebhookUrl's (http and https, in its order; a private target named by the raw attribute, as Coolify words it).
 * Freeploy is hosted, so private networks stay blocked (Coolify Cloud's rule).
 */
async function urlRules(ctx: Pick<OauthSourceContext, "resolve">, errors: FieldErrors, field: string, attribute: string, value: unknown): Promise<void> {
  if (blank(value)) return add(errors, field, `The ${attribute} field is required.`);
  if (typeof value !== "string") return add(errors, field, `The ${attribute} field must be a string.`);
  if (!isUrl(value)) add(errors, field, `The ${attribute} field must be a valid URL.`);
  const unsafe = await safeUrlError(value, attribute, field, ctx.resolve, ["http", "https"]);
  if (unsafe) add(errors, field, unsafe);
}

function requiredString(errors: FieldErrors, field: string, attribute: string, value: unknown): void {
  if (blank(value)) add(errors, field, `The ${attribute} field is required.`);
  else if (typeof value !== "string") add(errors, field, `The ${attribute} field must be a string.`);
}
function nullableString(errors: FieldErrors, field: string, attribute: string, value: unknown): void {
  if (!blank(value) && typeof value !== "string") add(errors, field, `The ${attribute} field must be a string.`);
}
function requiredInt(errors: FieldErrors, field: string, attribute: string, value: unknown): void {
  if (blank(value)) add(errors, field, `The ${attribute} field is required.`);
  else if (asInt(value) === null) add(errors, field, `The ${attribute} field must be an integer.`);
}
function requiredBool(errors: FieldErrors, field: string, attribute: string, value: unknown): void {
  if (value === undefined || value === null || value === "") add(errors, field, `The ${attribute} field is required.`);
  else if (asBool(value) === null) add(errors, field, `The ${attribute} field must be true or false.`);
}

/**
 * Create::createGitLabApp() / Create::createGiteaApp(): the URLs' trailing slashes trimmed, the API URL derived from
 * the HTML URL when empty, the rules, then the source with a random webhook token (secret) and a redirect to its page.
 * "System wide" is refused (makeSystemWide: no one in Freeploy may). Gitea's provider choice is the dialog's: it fills
 * in the URLs, which are what is sent.
 */
export async function createOauthSource(ctx: OauthSourceContext, kind: OauthSourceKind, body: Record<string, unknown>): Promise<{ uuid: string }> {
  const filterField = FILTER_COLUMN[kind];
  const errors: FieldErrors = {};
  const isSystemWide = body.is_system_wide === undefined ? false : body.is_system_wide;
  let htmlUrl = body.html_url === undefined ? OAUTH_SOURCE_DEFAULTS[kind].htmlUrl : body.html_url;
  let apiUrl = body.api_url === undefined ? OAUTH_SOURCE_DEFAULTS[kind].apiUrl : body.api_url;
  if (typeof htmlUrl === "string") htmlUrl = rtrimSlash(htmlUrl);
  if (!blank(apiUrl)) apiUrl = typeof apiUrl === "string" ? rtrimSlash(apiUrl) : apiUrl;
  else if (typeof htmlUrl === "string") apiUrl = apiUrlFromHtmlUrl(kind, htmlUrl);
  requiredString(errors, "name", "name", body.name);
  await urlRules(ctx, errors, "html_url", "html url", htmlUrl);
  await urlRules(ctx, errors, "api_url", "api url", apiUrl);
  const customUser = body.custom_user === undefined ? "git" : body.custom_user;
  const customPort = body.custom_port === undefined ? 22 : body.custom_port;
  requiredString(errors, "custom_user", "custom user", customUser);
  requiredInt(errors, "custom_port", "custom port", customPort);
  requiredBool(errors, "is_system_wide", "is system wide", isSystemWide);
  nullableString(errors, filterField, kind === "gitlab" ? "group name" : "organization", body[filterField]);
  if (Object.keys(errors).length) throw new SourceError("Validation failed", 422, errors);
  if (asBool(isSystemWide) === true) throw new SourceError(OAUTH_SOURCE_MESSAGES.systemWide, 403);
  const row = await ctx.store.insert(kind, {
    uuid: newPublicId(),
    name: body.name as string,
    apiUrl: apiUrl as string,
    htmlUrl: htmlUrl as string,
    customUser: customUser as string,
    customPort: asInt(customPort)!,
    isSystemWide: false,
    filter: strOrNull(body[filterField]),
    webhookSecret: await encrypt(ctx, kind, WEBHOOK_COLUMN[kind], randomString(32)),
  });
  return { uuid: row.uuid };
}

// ── The page ────────────────────────────────────────────────────────────────────────────────────────────

export interface OauthSourcePage {
  kind: OauthSourceKind;
  uuid: string;
  name: string;
  apiUrl: string;
  htmlUrl: string;
  customUser: string;
  customPort: number;
  clientId: string | null;
  /** clientSecretInput and the webhook token (secret): only for who may update (syncData's Gate::allows). */
  clientSecretInput: string | null;
  webhookToken: string | null;
  webhookSecret: string | null;
  /** Whether a client secret is stored (Step 2's "required" when none is). */
  hasClientSecret: boolean;
  groupName: string | null;
  organization: string | null;
  isSystemWide: boolean;
  privateKeyId: string | number | null;
  privateKeys: Array<{ id: string | number; name: string }>;
  applications: DeploySourceApplicationRow[];
  isConnected: boolean;
  redirectUri: string;
  /** createOAuthState(): for who may update (only they may complete the OAuth flow). */
  oauthState: string | null;
}

/** Change::mount(): the source, its form's values, its applications and the OAuth state. */
export async function showOauthSource(ctx: OauthSourceContext, kind: OauthSourceKind, uuid: string, canUpdate: boolean): Promise<OauthSourcePage | null> {
  const app = await ctx.store.findByUuid(kind, uuid);
  if (!app) return null;
  const webhook = canUpdate ? await decryptOrNull(ctx, kind, WEBHOOK_COLUMN[kind], app[WEBHOOK_COLUMN[kind]]) : null;
  return {
    kind,
    uuid: app.uuid,
    name: app.name,
    apiUrl: app.api_url,
    htmlUrl: app.html_url,
    customUser: app.custom_user,
    customPort: Number(app.custom_port),
    clientId: app.client_id,
    clientSecretInput: canUpdate ? await decryptOrNull(ctx, kind, "client_secret", app.client_secret) : null,
    webhookToken: kind === "gitlab" ? webhook : null,
    webhookSecret: kind === "gitea" ? webhook : null,
    hasClientSecret: !blank(app.client_secret),
    groupName: kind === "gitlab" ? app.group_name : null,
    organization: kind === "gitea" ? app.organization : null,
    isSystemWide: Boolean(app.is_system_wide),
    privateKeyId: app.private_key_id,
    privateKeys: (await ctx.store.privateKeys()).map((k) => ({ id: k.id, name: k.name })),
    applications: await ctx.store.applications(kind, app.id),
    isConnected: isOauthConnected(app),
    redirectUri: oauthRedirectUri(ctx.consoleUrl, kind),
    oauthState: canUpdate ? await createSetupState(ctx.stateSecret, kind, app.uuid, ctx.org) : null,
  };
}

/**
 * Change::submit(): authorizeSystemWideChange() (refused: no one in Freeploy may make a source system-wide), the rules
 * (Laravel's attribute names of the camelCase properties: "api url", "client secret input"), then syncData(true): the HTML
 * URL's trailing slash trimmed, the secrets kept when left empty, the redirect URI the console's.
 */
export async function updateOauthSource(ctx: OauthSourceContext, kind: OauthSourceKind, uuid: string, body: Record<string, unknown>): Promise<DeployOauthSourceRow | null> {
  const app = await ctx.store.findByUuid(kind, uuid);
  if (!app) return null;
  const webhookField = WEBHOOK_FIELD[kind];
  const filterField = FILTER_FIELD[kind];
  const pick = (key: string, loaded: unknown): unknown => (key in body ? body[key] : loaded);
  const form = {
    name: pick("name", app.name),
    apiUrl: pick("apiUrl", app.api_url),
    htmlUrl: pick("htmlUrl", app.html_url),
    customUser: pick("customUser", app.custom_user),
    customPort: pick("customPort", app.custom_port),
    clientId: pick("clientId", app.client_id),
    clientSecretInput: "clientSecretInput" in body ? body.clientSecretInput : await decryptOrNull(ctx, kind, "client_secret", app.client_secret),
    webhook: webhookField in body ? body[webhookField] : await decryptOrNull(ctx, kind, WEBHOOK_COLUMN[kind], app[WEBHOOK_COLUMN[kind]]),
    filter: pick(filterField, app[FILTER_COLUMN[kind]]),
    isSystemWide: pick("isSystemWide", app.is_system_wide),
    privateKeyId: pick("privateKeyId", app.private_key_id),
  };
  if (asBool(form.isSystemWide) === true && !app.is_system_wide) throw new SourceError(OAUTH_SOURCE_MESSAGES.systemWide, 403);
  const errors: FieldErrors = {};
  requiredString(errors, "name", "name", form.name);
  await urlRules(ctx, errors, "apiUrl", "api url", form.apiUrl);
  await urlRules(ctx, errors, "htmlUrl", "html url", form.htmlUrl);
  requiredString(errors, "customUser", "custom user", form.customUser);
  requiredInt(errors, "customPort", "custom port", form.customPort);
  nullableString(errors, "clientId", "client id", form.clientId);
  nullableString(errors, "clientSecretInput", "client secret input", form.clientSecretInput);
  nullableString(errors, webhookField, kind === "gitlab" ? "webhook token" : "webhook secret", form.webhook);
  nullableString(errors, filterField, kind === "gitlab" ? "group name" : "organization", form.filter);
  requiredBool(errors, "isSystemWide", "is system wide", form.isSystemWide);
  if (!blank(form.privateKeyId)) {
    if (asInt(form.privateKeyId) === null) add(errors, "privateKeyId", "The private key id field must be an integer.");
    // Rule::exists('private_keys', 'id')->where('team_id', $app->team_id): row-level security keeps it to the org.
    else if (!(await ctx.store.privateKey(asInt(form.privateKeyId)!))) add(errors, "privateKeyId", "The selected private key id is invalid.");
  }
  if (Object.keys(errors).length) throw new SourceError("Validation failed", 422, errors);
  const changes: OauthSourceChanges = {
    name: String(form.name),
    api_url: String(form.apiUrl),
    html_url: rtrimSlash(String(form.htmlUrl)),
    custom_user: String(form.customUser),
    custom_port: asInt(form.customPort)!,
    client_id: strOrNull(form.clientId),
    [FILTER_COLUMN[kind]]: strOrNull(form.filter),
    is_system_wide: asBool(form.isSystemWide)!,
    private_key_id: blank(form.privateKeyId) ? null : asInt(form.privateKeyId),
    redirect_uri: oauthRedirectUri(ctx.consoleUrl, kind),
  };
  if (!blank(form.clientSecretInput)) changes.client_secret = await encrypt(ctx, kind, "client_secret", String(form.clientSecretInput));
  if (!blank(form.webhook)) changes[WEBHOOK_COLUMN[kind]] = await encrypt(ctx, kind, WEBHOOK_COLUMN[kind], String(form.webhook));
  return ctx.store.update(kind, app.id, changes);
}

/** Change::delete(): refused while an application uses the source. */
export async function deleteOauthSource(ctx: OauthSourceContext, kind: OauthSourceKind, uuid: string): Promise<boolean> {
  const app = await ctx.store.findByUuid(kind, uuid);
  if (!app) return false;
  if ((await ctx.store.applications(kind, app.id)).length > 0) throw new SourceError(OAUTH_SOURCE_MESSAGES.inUse);
  return ctx.store.delete(kind, app.id);
}

/** The source's credentials, decrypted, for the calls to its instance. */
async function credentialsOf(ctx: OauthSourceContext, kind: OauthSourceKind, app: DeployOauthSourceRow): Promise<OauthCredentials> {
  return {
    html_url: app.html_url,
    api_url: app.api_url,
    client_id: app.client_id,
    client_secret: await decryptOrNull(ctx, kind, "client_secret", app.client_secret),
    access_token: await decryptOrNull(ctx, kind, "access_token", app.access_token),
    refresh_token: await decryptOrNull(ctx, kind, "refresh_token", app.refresh_token),
    expires_at: app.expires_at === null ? null : Number(app.expires_at),
    redirect_uri: app.redirect_uri,
  };
}

/** $source->update([...tokens]): the tokens encrypted. */
async function storeTokens(ctx: OauthSourceContext, kind: OauthSourceKind, app: DeployOauthSourceRow, tokens: OauthTokens): Promise<void> {
  await ctx.store.update(kind, app.id, {
    access_token: await encrypt(ctx, kind, "access_token", tokens.access_token),
    refresh_token: await encrypt(ctx, kind, "refresh_token", tokens.refresh_token),
    expires_at: tokens.expires_at,
  });
}

/** refreshGitlabToken() / refreshGiteaToken(), the new tokens stored: the credentials to call with. */
async function freshCredentials(ctx: OauthSourceContext, kind: OauthSourceKind, app: DeployOauthSourceRow): Promise<OauthCredentials> {
  const credentials = await credentialsOf(ctx, kind, app);
  const tokens = await refreshOauthToken(networkOf(ctx.http), kind, credentials);
  if (!tokens) return credentials;
  await storeTokens(ctx, kind, app, tokens);
  return { ...credentials, ...tokens };
}

/** handleError(): the exception's message as the error toast. */
const asSourceError = (e: unknown): SourceError => (e instanceof SourceError ? e : new SourceError(e instanceof Error ? e.message : String(e)));

/**
 * Change::testConnection(): refused before the OAuth flow; the token refreshed when it is about to expire, then GET
 * {api}/user — "Authenticated as" its username (Gitea's login).
 */
export async function testOauthConnection(ctx: OauthSourceContext, kind: OauthSourceKind, uuid: string): Promise<{ message: string } | null> {
  const app = await ctx.store.findByUuid(kind, uuid);
  if (!app) return null;
  if (!isOauthConnected(app)) throw new SourceError(OAUTH_SOURCE_MESSAGES[kind].notConnected);
  let response;
  try {
    const credentials = await freshCredentials(ctx, kind, app);
    response = await oauthUser(networkOf(ctx.http), kind, app.api_url, credentials.access_token);
  } catch (e) {
    throw asSourceError(e);
  }
  const json = (() => {
    try {
      return JSON.parse(response.text) as unknown;
    } catch {
      return null;
    }
  })();
  const get = (key: string): unknown => (json !== null && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>)[key] : undefined);
  if (response.successful) {
    const user = get(OAUTH_PROVIDERS[kind].userField);
    return { message: OAUTH_SOURCE_MESSAGES.connectionSuccessful(user === undefined ? "unknown" : String(user ?? "")) };
  }
  const error = get("message");
  throw new SourceError(OAUTH_SOURCE_MESSAGES.connectionFailed(error === undefined ? "Unknown error" : String(error ?? "")));
}

// ── The OAuth redirect ──────────────────────────────────────────────────────────────────────────────────

/**
 * Webhook\Gitlab::redirect() / Webhook\Gitea::redirect(), after the state was checked (it names this org and the
 * source) and the actor may update the source: the code exchanged with the source's credentials and redirect URI, the
 * tokens stored. Where Coolify redirects with a flash: the source's page, or the Sources page on an exception.
 */
export async function completeOauthRedirect(ctx: OauthSourceContext, kind: OauthSourceKind, appUuid: string, code: string): Promise<{ redirect: string; error: string | null } | null> {
  const app = await ctx.store.findByUuid(kind, appUuid);
  if (!app) return null;
  const page = `/source/${kind}/${app.uuid}`;
  try {
    const result = await exchangeOauthCode(networkOf(ctx.http), kind, await credentialsOf(ctx, kind, app), code);
    if ("error" in result) return { redirect: page, error: OAUTH_SOURCE_MESSAGES[kind].oauthFailed(result.error) };
    await storeTokens(ctx, kind, app, result);
    return { redirect: page, error: null };
  } catch (e) {
    return { redirect: "/sources", error: e instanceof Error ? e.message : String(e) };
  }
}

// ── The repositories and branches of New Resource ───────────────────────────────────────────────────────

/** GitlabApp::private() / GiteaApp::private(): not public, with an access token. */
async function privateSource(ctx: OauthSourceContext, kind: OauthSourceKind, uuid: string): Promise<DeployOauthSourceRow | null> {
  const app = await ctx.store.findByUuid(kind, uuid);
  return app && !app.is_public && app.access_token !== null ? app : null;
}

/** sortBy('name'): PHP's comparison of the names, the stable order of equal ones. */
const byName = (a: OauthRepository, b: OauthRepository): number => {
  const [x, y] = [String(a.name ?? ""), String(b.name ?? "")];
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * loadRepositories(): every page (at most 50) of the source's repositories, by name; the first one selected. A failure
 * is the error toast.
 */
export async function listOauthRepositories(ctx: OauthSourceContext, kind: OauthSourceKind, uuid: string): Promise<{ repositories: OauthRepository[]; total_count: number } | null> {
  const app = await privateSource(ctx, kind, uuid);
  if (!app) return null;
  try {
    const credentials = await freshCredentials(ctx, kind, app);
    const net = networkOf(ctx.http);
    const source = { api_url: app.api_url, access_token: credentials.access_token, group_name: app.group_name, organization: app.organization };
    let page = 1;
    let result = await loadOauthRepositories(net, kind, source, page);
    const repositories = [...result.repositories];
    while (result.has_more && page < 50) {
      page++;
      result = await loadOauthRepositories(net, kind, source, page);
      repositories.push(...result.repositories);
    }
    return { repositories: repositories.map((r, i) => ({ r, i })).sort((x, y) => byName(x.r, y.r) || x.i - y.i).map(({ r }) => r), total_count: repositories.length };
  } catch (e) {
    if (e instanceof OauthRefreshError || e instanceof OauthPhpError) throw new SourceError(e.message);
    throw asSourceError(e);
  }
}

/**
 * loadBranches(): every page of the repository's branches (GitLab's by its project id, Gitea's by owner/name), main and
 * master first; the repository's default branch selected when it is one of them, else the first, else "main".
 */
export async function listOauthBranches(ctx: OauthSourceContext, kind: OauthSourceKind, uuid: string, repository: string, defaultBranch: string): Promise<{ branches: string[]; selected: string } | null> {
  const app = await privateSource(ctx, kind, uuid);
  if (!app) return null;
  const pageSize = kind === "gitlab" ? 100 : 50;
  try {
    const credentials = await freshCredentials(ctx, kind, app);
    const net = networkOf(ctx.http);
    const source = { api_url: app.api_url, access_token: credentials.access_token };
    let page = 1;
    let batch = await loadOauthBranches(net, kind, source, repository, page);
    const all = [...batch];
    while (batch.length === pageSize && (kind === "gitlab" || page < 50)) {
      page++;
      batch = await loadOauthBranches(net, kind, source, repository, page);
      all.push(...batch);
    }
    const names = sortBranchesByPriority(all.map((b) => ({ ...b, name: String(b.name ?? "") }))).map((b) => String(b.name));
    return { branches: names, selected: names.includes(defaultBranch) ? defaultBranch : (names[0] ?? "main") };
  } catch (e) {
    throw asSourceError(e);
  }
}
