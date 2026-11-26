// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/{gitlab,gitea}.php (refreshGitlabToken, refreshGiteaToken,
// loadGitlabRepositories, loadGiteaRepositories, loadGitlabBranches, loadGiteaBranches), app/Models/{GitlabApp,GiteaApp}.php
// (apiUrlBase, allowsRepositoryOwner, isConnected), app/Http/Controllers/Webhook/{Gitlab,Gitea}.php (redirect: the
// authorization code's exchange) and app/Providers/AppServiceProvider.php (Http::GitSource, Http::GitLab, Http::Gitea)
// (Apache-2.0), modified.
//
// What a GitLab or Gitea / Forgejo source asks its instance (DP-103): the OAuth token exchange and refresh, the
// signed-in user (Test connection), the repositories and branches the source may use. Every call goes through an
// injectable fetch (ProviderNetwork: the API's ApiV1Context.providers, the console's SourceHttp), with Laravel's
// timeouts and retries as each call sets them. Coolify's messages word for word. Coolify keeps the refresh under a cache
// lock (Cache::lock) so two requests do not refresh at once; Freeploy has no shared lock, and the later refresh wins.
import { isObj, type PhpValue } from "@saas/contracts/coolify-api";
import { providerSend, type ProviderNetwork, type ProviderResponse } from "../api-v1/cloud-providers.js";
import { rawurlencode } from "../deployments/php.js";
import type { SourceHttp } from "./github.js";

export type OauthKind = "gitlab" | "gitea";

/** What differs between the two providers. */
export const OAUTH_PROVIDERS = {
  gitlab: {
    /** The API URL a source's HTML URL derives (gitlabApiUrlFromHtmlUrl). */
    apiSuffix: "/api/v4",
    tokenPath: "/oauth/token",
    authorizePath: "/oauth/authorize",
    scope: "api read_user read_repository",
    /** expires_in when the instance gives none. */
    defaultExpiresIn: 7200,
    /** The field of GET /user Test connection names. */
    userField: "username",
    redirectPath: "/webhooks/source/gitlab/redirect",
    eventsPath: "/webhooks/source/gitlab/events",
  },
  gitea: {
    apiSuffix: "/api/v1",
    tokenPath: "/login/oauth/access_token",
    authorizePath: "/login/oauth/authorize",
    scope: "read:user read:repository read:organization",
    defaultExpiresIn: 3600,
    userField: "login",
    redirectPath: "/webhooks/source/gitea/redirect",
    eventsPath: "/webhooks/source/gitea/events",
  },
} as const;

export const OAUTH_GIT_MESSAGES = {
  noRefreshToken: { gitlab: "GitLab source has no refresh token. Please reconnect the GitLab app.", gitea: "Gitea / Forgejo source has no refresh token. Please reconnect the Gitea / Forgejo App." },
  refreshFailed: (kind: OauthKind, error: string) => `Failed to refresh ${kind === "gitlab" ? "GitLab" : "Gitea"} token: ${error}`,
} as const;

/** A RuntimeException of refreshGitlabToken() / refreshGiteaToken(): its message is what Coolify shows or answers. */
export class OauthRefreshError extends Error {}

/** A PHP error Coolify does not catch as a RuntimeException ('Undefined array key "refresh_token"'). */
export class OauthPhpError extends Error {}

/** Laravel's default timeout for a request with no timeout() of its own, and the helpers' timeout(20). */
const DEFAULT_TIMEOUT_MS = 30_000;
const TIMEOUT_MS = 20_000;
/** Coolify's safety margin: a token that expires within a minute is refreshed first. */
const SAFETY_MARGIN = 60;

const rtrimSlash = (v: string): string => v.replace(/\/+$/, "");

/** GitlabApp::apiUrlBase() / GiteaApp::apiUrlBase(): the API URL, with /api/v4 (/api/v1) appended when it has none. */
export function apiUrlBase(kind: OauthKind, apiUrl: string): string {
  const url = rtrimSlash(apiUrl);
  const suffix = OAUTH_PROVIDERS[kind].apiSuffix;
  return url.includes(suffix) ? url : `${url}${suffix}`;
}

/** gitlabApiUrlFromHtmlUrl() / giteaApiUrlFromHtmlUrl(). */
export const apiUrlFromHtmlUrl = (kind: OauthKind, htmlUrl: string): string => `${rtrimSlash(htmlUrl)}${OAUTH_PROVIDERS[kind].apiSuffix}`;

/** GiteaApp::allowsRepositoryOwner(): the organization field limits the source to these owners; empty allows all. */
export function allowsRepositoryOwner(organization: string | null, owner: unknown): boolean {
  const allowed = String(organization ?? "")
    .split(",")
    .map((o) => o.trim().toLowerCase())
    .filter((o) => o !== "");
  return allowed.length === 0 || allowed.includes(String(owner ?? "").toLowerCase());
}

/** isConnected(): an access token and a refresh token. */
export const isOauthConnected = (row: { access_token: string | null; refresh_token: string | null }): boolean => !blankText(row.access_token) && !blankText(row.refresh_token);
const blankText = (v: string | null | undefined): boolean => v === null || v === undefined || v === "" || v === "0";

/** The console's SourceHttp as the API's ProviderNetwork. */
export function networkOf(http: SourceHttp): ProviderNetwork {
  return {
    fetch: ((url: string, init: { method: string; headers: Record<string, string>; body?: string }) => http.fetch(String(url), { method: init.method, headers: init.headers, ...(init.body !== undefined && { body: init.body }) })) as unknown as typeof fetch,
    sleep: http.sleep ?? (async () => undefined),
    ...(http.now && { now: http.now }),
  };
}

const nowSeconds = (net: ProviderNetwork): number => Math.floor((net.now ?? (() => new Date()))().getTime() / 1000);

/** data_get($response->json(), $key, $default) */
function field(r: ProviderResponse, key: string): PhpValue | undefined {
  return isObj(r.json) ? r.json.entries.find(([k]) => k === key)?.[1] : undefined;
}
const text = (v: PhpValue | undefined): string => (v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v === true ? "1" : v === false ? "" : v) : JSON.stringify(v));

/** The decrypted credentials of a source the calls read. */
export interface OauthCredentials {
  html_url: string;
  api_url: string;
  client_id: string | null;
  client_secret: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
  redirect_uri: string | null;
}

export interface OauthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

/** $data['access_token'], $data['refresh_token']: PHP's warning when the key or the array is missing. */
function arrayKey(r: ProviderResponse, key: string): PhpValue {
  if (!isObj(r.json) && !Array.isArray(r.json)) throw new OauthPhpError("Trying to access array offset on value of type null");
  const v = field(r, key);
  if (v === undefined) throw new OauthPhpError(`Undefined array key "${key}"`);
  return v;
}

/** The token answer: the tokens and expires_at = time() + (expires_in ?? the provider's default). */
function tokensOf(kind: OauthKind, r: ProviderResponse, net: ProviderNetwork, previousRefresh: string | null): OauthTokens {
  const access = arrayKey(r, "access_token");
  // GitLab reads $data['refresh_token']; Gitea $data['refresh_token'] ?? $source->refresh_token.
  const refreshed = kind === "gitea" ? (field(r, "refresh_token") ?? previousRefresh) : arrayKey(r, "refresh_token");
  const expiresIn = field(r, "expires_in");
  const seconds = expiresIn === null || expiresIn === undefined ? OAUTH_PROVIDERS[kind].defaultExpiresIn : Number(expiresIn);
  return { access_token: text(access), refresh_token: text(refreshed ?? null), expires_at: nowSeconds(net) + (Number.isFinite(seconds) ? Math.trunc(seconds) : 0) };
}

/**
 * refreshGitlabToken() / refreshGiteaToken(): nothing when the token is good for more than a minute; else the refresh
 * token is exchanged ({html_url}/oauth/token, Gitea's /login/oauth/access_token, as a form). The new tokens are answered
 * for the caller to store; null when no refresh was needed.
 */
export async function refreshOauthToken(net: ProviderNetwork, kind: OauthKind, source: OauthCredentials): Promise<OauthTokens | null> {
  if (blankText(source.refresh_token)) throw new OauthRefreshError(OAUTH_GIT_MESSAGES.noRefreshToken[kind]);
  if (source.expires_at && source.expires_at > nowSeconds(net) + SAFETY_MARGIN) return null;
  const base = rtrimSlash(source.html_url);
  const form: Array<[string, string]> = [
    ["client_id", source.client_id ?? ""],
    ["client_secret", source.client_secret ?? ""],
    ["refresh_token", source.refresh_token ?? ""],
    ["grant_type", "refresh_token"],
    ...(kind === "gitlab" ? ([["redirect_uri", source.redirect_uri ?? ""]] as Array<[string, string]>) : []),
  ];
  const r = await providerSend(net, { method: "post", url: `${base}${OAUTH_PROVIDERS[kind].tokenPath}`, headers: {}, form, timeoutMs: DEFAULT_TIMEOUT_MS });
  if (!r.successful) {
    const description = field(r, "error_description");
    throw new OauthRefreshError(OAUTH_GIT_MESSAGES.refreshFailed(kind, description === undefined ? r.text : text(description)));
  }
  return tokensOf(kind, r, net, source.refresh_token);
}

/**
 * Webhook\Gitlab::redirect() / Webhook\Gitea::redirect(): the authorization code exchanged ({html_url}/oauth/token, as a
 * form, with the source's redirect URI). A refusal is { error: error_description ?? 'Token exchange failed' }.
 */
export async function exchangeOauthCode(net: ProviderNetwork, kind: OauthKind, source: OauthCredentials, code: string): Promise<OauthTokens | { error: string }> {
  const base = rtrimSlash(source.html_url);
  const r = await providerSend(net, {
    method: "post",
    url: `${base}${OAUTH_PROVIDERS[kind].tokenPath}`,
    headers: {},
    form: [
      ["client_id", source.client_id ?? ""],
      ["client_secret", source.client_secret ?? ""],
      ["code", code],
      ["grant_type", "authorization_code"],
      ["redirect_uri", source.redirect_uri ?? ""],
    ],
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  if (!r.successful) {
    const description = field(r, "error_description");
    return { error: description === undefined ? "Token exchange failed" : text(description) };
  }
  return tokensOf(kind, r, net, null);
}

/** Http::GitLab($api, $token) / Http::Gitea($api, $token): JSON, with the bearer token. */
const apiHeaders = (token: string | null): Record<string, string> => ({ Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) });

/** testConnection(): GET {apiUrlBase}/user, timeout(10). */
export async function oauthUser(net: ProviderNetwork, kind: OauthKind, apiUrl: string, accessToken: string | null): Promise<ProviderResponse> {
  return providerSend(net, { method: "get", url: `${apiUrlBase(kind, apiUrl)}/user`, headers: apiHeaders(accessToken), timeoutMs: 10_000 });
}

/** A repository as loadGitlabRepositories() / loadGiteaRepositories() answer it. */
export type OauthRepository = Record<string, unknown> & { id: unknown; name: unknown };

/** loadGitlabRepositories() / loadGiteaRepositories() of one page: an unsuccessful answer is no repositories. */
export async function loadOauthRepositories(
  net: ProviderNetwork,
  kind: OauthKind,
  source: { api_url: string; access_token: string | null; group_name: string | null; organization: string | null },
  page: number,
): Promise<{ total_count: number; has_more: boolean; repositories: OauthRepository[] }> {
  const pageSize = kind === "gitlab" ? 100 : 50;
  const query: Array<[string, string | number]> =
    kind === "gitlab"
      ? [
          ["membership", "true"],
          ["per_page", 100],
          ["page", page],
          ["order_by", "name"],
          ["sort", "asc"],
        ]
      : [
          ["limit", 50],
          ["page", page],
        ];
  const r = await providerSend(net, { method: "get", url: `${apiUrlBase(kind, source.api_url)}${kind === "gitlab" ? "/projects" : "/user/repos"}`, query, headers: apiHeaders(source.access_token), timeoutMs: TIMEOUT_MS, retry: { tries: 3, sleep: () => 200 } });
  const list = r.successful ? (JSON.parse(r.text || "null") as unknown) : null;
  if (!r.successful || !Array.isArray(list)) return { total_count: 0, has_more: false, repositories: [] };
  const hasMore = list.length === pageSize;
  const get = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);
  let items = list as unknown[];
  if (kind === "gitlab") {
    const groups = String(source.group_name ?? "")
      .split(",")
      .map((g) => g.trim().toLowerCase())
      .filter((g) => g !== "");
    if (groups.length) {
      items = items.filter((p) => {
        const namespace = String(get(p, "namespace.full_path") ?? "").toLowerCase();
        return groups.some((g) => namespace === g || namespace.startsWith(`${g}/`));
      });
    }
    return {
      total_count: items.length,
      has_more: hasMore,
      repositories: items.map((p) => ({
        id: get(p, "id") ?? null,
        name: get(p, "name") ?? null,
        path_with_namespace: get(p, "path_with_namespace") ?? null,
        default_branch: get(p, "default_branch") ?? "main",
        web_url: get(p, "web_url") ?? null,
        namespace: { full_path: get(p, "namespace.full_path") ?? null, kind: get(p, "namespace.kind") ?? null },
      })),
    };
  }
  items = items.filter((repo) => allowsRepositoryOwner(source.organization, get(repo, "owner.login")));
  return {
    total_count: items.length,
    has_more: hasMore,
    repositories: items.map((repo) => ({
      id: get(repo, "id") ?? null,
      name: get(repo, "name") ?? null,
      full_name: get(repo, "full_name") ?? null,
      default_branch: get(repo, "default_branch") ?? "main",
      html_url: get(repo, "html_url") ?? null,
      owner: get(repo, "owner.login") ?? null,
    })),
  };
}

/** loadGitlabBranches($source, $projectId, $page) / loadGiteaBranches($source, $fullName, $page): an unsuccessful answer is none. */
export async function loadOauthBranches(net: ProviderNetwork, kind: OauthKind, source: { api_url: string; access_token: string | null }, repository: string, page: number): Promise<Array<Record<string, unknown>>> {
  // explode('/', $fullName, 2), each part rawurlencode()d.
  const [owner, ...rest] = repository.split("/");
  const parts = rest.length ? [owner!, rest.join("/")] : [owner!];
  const path = kind === "gitlab" ? `/projects/${repository}/repository/branches` : `/repos/${parts.map((p) => rawurlencode(p)).join("/")}/branches`;
  const query: Array<[string, string | number]> = kind === "gitlab" ? [["per_page", 100], ["page", page]] : [["limit", 50], ["page", page]];
  const r = await providerSend(net, { method: "get", url: `${apiUrlBase(kind, source.api_url)}${path}`, query, headers: apiHeaders(source.access_token), timeoutMs: TIMEOUT_MS, retry: { tries: 3, sleep: () => 200 } });
  if (!r.successful) return [];
  const list = JSON.parse(r.text || "null") as unknown;
  return Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
}

/** The Gitea repository check of POST /applications/private-gitea-app: GET {apiUrlBase}/repos/{owner}/{name}, retry(3, 200). */
export async function giteaRepository(net: ProviderNetwork, apiUrl: string, accessToken: string | null, repositoryPath: string): Promise<ProviderResponse> {
  const path = repositoryPath
    .split("/")
    .map((part) => rawurlencode(part))
    .join("/");
  return providerSend(net, { method: "get", url: `${apiUrlBase("gitea", apiUrl)}/repos/${path}`, headers: apiHeaders(accessToken), timeoutMs: TIMEOUT_MS, retry: { tries: 3, sleep: () => 200 } });
}
