// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/github.php (githubUrlHost, githubUrlOrigin,
// isGithubDotComHost, isGheDotComHost, isGithubEnterpriseServerHost, githubApiUrlFromHtmlUrl,
// normalizeGithubOrganization, encodeGithubPathSegment, assertGithubClockInSync, githubRateLimitMessage,
// generateGithubToken, githubApi, syncGithubAppName, getInstallationPath, getPermissionsPath,
// loadRepositoryByPage, getGithubCommitRangeFiles, getGithubCommitMessage, getGithubPullRequestFiles),
// app/Models/GithubApp.php (installationToken, isConnected, accountName, settingsUrl, canSyncDeployments),
// app/Providers/AppServiceProvider.php (Http::GitHub, Http::GitSource) and
// app/Livewire/Project/New/GithubPrivateRepository.php (loadBranchByPage) (Apache-2.0), modified.
//
// Everything Freeploy asks GitHub for a private GitHub App: the App's JWT, an installation token, the
// installation's repositories and their branches, a push's or a pull request's changed files and a commit's
// message — through a `fetch` the caller hands in, so tests never touch the network. Coolify's messages
// word for word; where Coolify joins the lines of a message with <br>, these have line breaks.
import { githubAppJwt } from "./jwt.js";
import { parseUrl } from "../s3-storages/safe-url.js";
import { rawurlencode } from "../deployments/php.js";
import { kebab } from "../helpers/names.js";

/** The part of fetch() the GitHub calls need. */
export type SourceFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;

export interface SourceHttp {
  fetch: SourceFetch;
  /** The instant a JWT is issued at and a clock is compared with; replaceable for tests. */
  now?: () => Date;
  /** Waits between retries; replaceable so tests do not wait. */
  sleep?: (milliseconds: number) => Promise<void>;
}

/** The columns of a github_apps row these calls read. */
export interface GithubAppCredentials {
  name: string;
  organization: string | null;
  api_url: string;
  html_url: string;
  app_id: number | string | null;
  installation_id: number | string | null;
  is_public: boolean;
  /** The App's private key (decrypted), from its private_keys row; null when the row is gone or another org's. */
  privateKey: string | null;
}

const defaultSleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
const nowOf = (http: SourceHttp): Date => (http.now ?? (() => new Date()))();
const utf8 = new TextEncoder();
/** PHP's strcmp() sign: byte-wise over UTF-8. */
export function compareBytes(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}
const blank = (value: unknown): boolean => value === null || value === undefined || (typeof value === "string" && value.trim() === "");

/** GitHub refuses a request without a User-Agent; Laravel's HTTP client always sends one. */
const USER_AGENT = "Freeploy";

// ── URLs ────────────────────────────────────────────────────────────────────────────────────────────────

/** githubUrlHost(): the lowercase host of a URL, or null. */
export function githubUrlHost(url: string | null | undefined): string | null {
  if (blank(url)) return null;
  const host = parseUrl(url!)?.host;
  return typeof host === "string" && host !== "" ? host.toLowerCase() : null;
}

/** githubUrlOrigin(): scheme://host[:port]. */
export function githubUrlOrigin(url: string): string {
  const parsed = parseUrl(url);
  const host = githubUrlHost(url);
  if (!parsed?.scheme || !host) throw new Error("GitHub URL must include a valid scheme and host.");
  return `${parsed.scheme}://${host}${parsed.port ? `:${parsed.port}` : ""}`;
}

export const isGithubDotComHost = (htmlUrl: string | null | undefined): boolean => githubUrlHost(htmlUrl) === "github.com";

export function isGheDotComHost(htmlUrl: string | null | undefined): boolean {
  const host = githubUrlHost(htmlUrl);
  return host !== null && host.endsWith(".ghe.com") && !host.startsWith("api.");
}

export const isGithubEnterpriseServerHost = (htmlUrl: string | null | undefined): boolean => !blank(htmlUrl) && !(isGithubDotComHost(htmlUrl) || isGheDotComHost(htmlUrl));

/** githubApiUrlFromHtmlUrl(): api.github.com, api.<host> for *.ghe.com, <origin>/api/v3 for GitHub Enterprise Server. */
export function githubApiUrlFromHtmlUrl(htmlUrl: string): string {
  if (isGithubDotComHost(htmlUrl)) return "https://api.github.com";
  if (isGheDotComHost(htmlUrl)) return `https://api.${githubUrlHost(htmlUrl)}`;
  return `${githubUrlOrigin(htmlUrl)}/api/v3`;
}

/** normalizeGithubOrganization(): trimmed of slashes and whitespace, null when blank. */
export function normalizeGithubOrganization(organization: string | null | undefined): string | null {
  if (blank(organization)) return null;
  return organization!.replace(/^[/ \t\n\r\0\x0B]+|[/ \t\n\r\0\x0B]+$/g, "");
}

const segment = (value: string): string => rawurlencode(value);
const rtrimSlash = (value: string): string => value.replace(/\/+$/, "");

/** GithubApp::settingsUrl(): the App's settings page at GitHub. */
export function githubAppSettingsUrl(app: Pick<GithubAppCredentials, "name" | "organization" | "html_url">): string {
  const name = segment(app.name);
  const organization = normalizeGithubOrganization(app.organization);
  if (organization !== null && organization !== "") return `${rtrimSlash(app.html_url)}/organizations/${segment(organization)}/settings/apps/${name}`;
  return `${rtrimSlash(app.html_url)}/settings/apps/${name}`;
}

/** getPermissionsPath(): the App's permissions page at GitHub. */
export function githubAppPermissionsUrl(app: Pick<GithubAppCredentials, "name" | "organization" | "html_url">): string {
  const name = segment(kebab(app.name));
  const organization = normalizeGithubOrganization(app.organization);
  if (organization !== null && organization !== "") return `${rtrimSlash(app.html_url)}/organizations/${segment(organization)}/settings/apps/${name}/permissions`;
  return `${rtrimSlash(app.html_url)}/settings/apps/${name}/permissions`;
}

/** http_build_query(['state' => $state]) for the state's characters (letters and digits). */
const stateQuery = (state: string): string => `state=${encodeURIComponent(state)}`;

/**
 * getInstallationPath(): where GitHub installs the App on an account, with the setup state. The state is
 * the caller's (a signed one here: setup-state.ts); Coolify keeps a random one in its cache.
 */
export function githubAppInstallationUrl(app: Pick<GithubAppCredentials, "name" | "organization" | "html_url">, state: string): string {
  const name = segment(kebab(app.name));
  const organization = normalizeGithubOrganization(app.organization);
  let path: string;
  if (isGithubEnterpriseServerHost(app.html_url)) path = `github-apps/${name}`;
  else if (isGheDotComHost(app.html_url) && organization !== null && organization !== "") path = `apps/${segment(organization)}/${name}`;
  else path = `apps/${name}`;
  return `${rtrimSlash(app.html_url)}/${path}/installations/new?${stateQuery(state)}`;
}

/** GithubApp::isConnected(): registered and installed (a public source always is). */
export const isGithubAppConnected = (app: Pick<GithubAppCredentials, "is_public" | "app_id" | "installation_id">): boolean => app.is_public || (!blank(app.app_id) && !blank(app.installation_id));

/** GithubApp::accountName(): the installation's account, else the App's organization. */
export const githubAppAccountName = (app: { installation_account: string | null; organization: string | null }): string | null =>
  app.installation_account !== null && app.installation_account !== "" && app.installation_account !== "0" ? app.installation_account : normalizeGithubOrganization(app.organization);

/** GithubApp::canSyncDeployments(): a private App whose installation granted "Deployments: write". */
export const githubAppCanSyncDeployments = (app: { is_public: boolean; deployments: string | null }): boolean => !app.is_public && app.deployments === "write";

// ── Errors ──────────────────────────────────────────────────────────────────────────────────────────────

/** Coolify's exceptions of these calls: its message, the lines that Coolify joins with <br> on lines of their own. */
export class GithubSourceError extends Error {}

const pad = (n: number): string => String(n).padStart(2, "0");
/** Carbon's format('Y-m-d H:i:s') in UTC. */
export const ymdHis = (d: Date): string => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

/**
 * assertGithubClockInSync(): GitHub refuses a JWT when the clocks differ; a failed answer's Date header
 * shows by how much.
 */
export function assertGithubClockInSync(response: Response, now: Date): void {
  const date = response.headers.get("Date");
  if (blank(date)) return;
  const github = new Date(date!);
  if (Number.isNaN(github.getTime())) return;
  const diff = Math.abs(Math.trunc((github.getTime() - now.getTime()) / 1000));
  if (diff > 50) {
    throw new GithubSourceError(
      ["System time is out of sync with GitHub API time:", `- System time: ${ymdHis(now)} UTC`, `- GitHub time: ${ymdHis(github)} UTC`, `- Difference: ${diff} seconds`, "Please synchronize your system clock."].join("\n"),
    );
  }
}

async function jsonOf(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text());
  } catch {
    return null;
  }
}

const messageOf = (json: unknown): string | null =>
  json !== null && typeof json === "object" && typeof (json as { message?: unknown }).message === "string" ? (json as { message: string }).message : null;

/** githubRateLimitMessage(): when to try again, for a 403 or 429 that is a rate limit; null for anything else. */
export function githubRateLimitMessage(response: Response, json: unknown, now: Date): string | null {
  if (response.status !== 403 && response.status !== 429) return null;
  const retryAfter = response.headers.get("Retry-After");
  const reset = response.headers.get("X-RateLimit-Reset");
  const errorMessage = messageOf(json) ?? "";
  const numeric = (v: string | null): boolean => v !== null && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(v);
  if (response.headers.get("X-RateLimit-Remaining") !== "0" && !numeric(retryAfter) && !errorMessage.toLowerCase().includes("rate limit")) return null;
  const retryAt = numeric(retryAfter) ? new Date(now.getTime() + Math.trunc(Number(retryAfter)) * 1000) : numeric(reset) ? new Date(Math.trunc(Number(reset)) * 1000) : new Date(now.getTime() + 60_000);
  const message = `GitHub API rate limit exceeded. Try again after ${ymdHis(retryAt)} UTC. See https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api.`;
  const requestId = response.headers.get("X-GitHub-Request-Id");
  return !blank(requestId) ? `${message} GitHub request ID: ${requestId}.` : message;
}

/** The base URL joined to an endpoint as Laravel's baseUrl() joins them. */
const joinUrl = (base: string, endpoint: string): string => `${base.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`.replace(/^\/+/, "");

/**
 * Laravel's retry(3, …, isTransientGithubFailure, throw: false): a dropped connection or a 5xx answer is
 * tried again, three times in all, `delay(attempt)` apart; the last answer is returned.
 */
async function withRetries(http: SourceHttp, delay: (attempt: number) => number, send: () => Promise<Response>): Promise<Response> {
  const sleep = http.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await send();
      if (response.status < 500 || attempt === 3) return response;
    } catch (e) {
      if (attempt === 3) throw e;
    }
    await sleep(delay(attempt));
  }
}

// ── Tokens ──────────────────────────────────────────────────────────────────────────────────────────────

/** generateGithubJwt(): the App's JWT. */
export async function githubJwt(app: Pick<GithubAppCredentials, "app_id" | "privateKey">, now: Date): Promise<string> {
  if (app.privateKey === null) throw new GithubSourceError("Private key not found for this GitHub App.");
  return githubAppJwt(app.privateKey, app.app_id ?? "", now);
}

/**
 * generateGithubToken($source, 'installation'): an installation access token, asked of
 * POST {api}/app/installations/{id}/access_tokens with the JWT (a 5xx or a dropped connection tried three
 * times, a second, then two, apart); a refusal says why in Coolify's words.
 */
export async function githubInstallationToken(http: SourceHttp, app: GithubAppCredentials): Promise<string> {
  const now = nowOf(http);
  const jwt = await githubJwt(app, now);
  const url = `${app.api_url}/app/installations/${app.installation_id ?? ""}/access_tokens`;
  const response = await withRetries(
    http,
    (attempt) => attempt * 1000,
    () => http.fetch(url, { method: "POST", headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github.machine-man-preview+json", "User-Agent": USER_AGENT } }),
  );
  const json = await jsonOf(response);
  if (response.status < 200 || response.status >= 300) {
    assertGithubClockInSync(response, now);
    let error = messageOf(json) ?? `HTTP ${response.status}`;
    if (error === "Not Found") error = `GitHub App installation ${app.installation_id ?? ""} was not found. Install the GitHub App again or update its installation ID.`;
    throw new GithubSourceError(`Failed to get installation token for ${app.name} with error: ${error}`);
  }
  const token = json !== null && typeof json === "object" ? (json as { token?: unknown }).token : undefined;
  if (typeof token !== "string") throw new GithubSourceError(`Failed to get installation token for ${app.name} with error: HTTP ${response.status}`);
  return token;
}

/**
 * GithubApp::installationToken(): one token per App for 50 minutes (GitHub's expire after an hour), so one
 * deployment or one page does not ask GitHub for a new token each time.
 */
export class InstallationTokens {
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();
  constructor(private readonly http: SourceHttp) {}
  async token(app: GithubAppCredentials & { private_key_id?: unknown }): Promise<string> {
    const key = [app.api_url, app.app_id, app.installation_id, app.private_key_id ?? ""].join("|");
    const now = nowOf(this.http).getTime();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) return hit.token;
    const token = await githubInstallationToken(this.http, app);
    this.cache.set(key, { token, expiresAt: now + 50 * 60_000 });
    return token;
  }
}

// ── githubApi() ─────────────────────────────────────────────────────────────────────────────────────────

export interface GithubApiAnswer {
  status: number;
  rateLimitRemaining: string | null;
  rateLimitReset: string | null;
  data: unknown;
}

/**
 * githubApi($source, $endpoint, $method, $data, $throwError): Http::GitHub — with the installation token
 * for a private App, without one for the public source — and only reads retried (a repeated POST could make
 * a second comment). A refusal throws Coolify's message with the rate limit's state, unless `throwError` is
 * false.
 */
export async function githubApi(
  http: SourceHttp,
  tokens: InstallationTokens,
  app: GithubAppCredentials,
  endpoint: string,
  options: { method?: "get" | "post" | "patch" | "put" | "delete"; data?: Record<string, unknown> | null; throwError?: boolean } = {},
): Promise<GithubApiAnswer> {
  const method = options.method ?? "get";
  const headers: Record<string, string> = app.is_public
    ? { Accept: "application/vnd.github.v3+json", "User-Agent": USER_AGENT }
    : { "X-GitHub-Api-Version": "2022-11-28", Accept: "application/vnd.github.v3+json", Authorization: `Bearer ${await tokens.token(app)}`, "User-Agent": USER_AGENT };
  const url = joinUrl(app.api_url, endpoint);
  const init: { method: string; headers: Record<string, string>; body?: string } = { method: method.toUpperCase(), headers };
  if (options.data && (method === "post" || method === "patch" || method === "put")) {
    init.body = JSON.stringify(options.data);
    init.headers = { ...headers, "Content-Type": "application/json" };
  }
  const response = method === "get" ? await withRetries(http, (attempt) => attempt * 1000, () => http.fetch(url, init)) : await http.fetch(url, init);
  const data = await jsonOf(response);
  if ((response.status < 200 || response.status >= 300) && options.throwError !== false) {
    const reset = new Date(Math.trunc(Number(/^\s*([+-]?\d+)/.exec(response.headers.get("X-RateLimit-Reset") ?? "")?.[1] ?? 0)) * 1000);
    throw new GithubSourceError(
      ["GitHub API call failed:", `Error: ${messageOf(data) ?? "no error message found"}`, "Rate Limit Status:", `- Remaining Calls: ${response.headers.get("X-RateLimit-Remaining") ?? ""}`, `- Reset Time: ${ymdHis(reset)} UTC`].join("\n"),
    );
  }
  return { status: response.status, rateLimitRemaining: response.headers.get("X-RateLimit-Remaining"), rateLimitReset: response.headers.get("X-RateLimit-Reset"), data };
}

// ── Repositories and branches ───────────────────────────────────────────────────────────────────────────

export interface GithubRepository {
  id: number;
  name: string;
  owner: { login: string };
  default_branch?: string;
  [key: string]: unknown;
}

/** loadRepositoryByPage(): one page of the installation's repositories (100 a page). */
export async function loadRepositoryByPage(http: SourceHttp, app: GithubAppCredentials, token: string, page: number): Promise<{ total_count: number; repositories: GithubRepository[] }> {
  const url = `${joinUrl(app.api_url, "/installation/repositories")}?per_page=100&page=${page}`;
  const response = await withRetries(
    http,
    () => 200,
    () => http.fetch(url, { method: "GET", headers: { "X-GitHub-Api-Version": "2022-11-28", Accept: "application/vnd.github.v3+json", Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT } }),
  );
  const json = await jsonOf(response);
  if (response.status !== 200) {
    const error = githubRateLimitMessage(response, json, nowOf(http)) ?? messageOf(json) ?? `HTTP ${response.status}`;
    throw new GithubSourceError(`Failed to load repositories for ${app.name} with error: ${error}`);
  }
  const body = (json ?? {}) as { total_count?: unknown; repositories?: unknown };
  if (body.total_count === 0) return { total_count: 0, repositories: [] };
  return { total_count: Number(body.total_count ?? 0), repositories: Array.isArray(body.repositories) ? (body.repositories as GithubRepository[]) : [] };
}

/**
 * GithubPrivateRepository::loadRepositories(): every page of the installation's repositories until the
 * total is reached, sorted by name (Collection::sortBy('name'): PHP's string comparison).
 */
export async function loadInstallationRepositories(http: SourceHttp, tokens: InstallationTokens, app: GithubAppCredentials): Promise<GithubRepository[]> {
  const token = await tokens.token(app);
  let page = 1;
  let first = await loadRepositoryByPage(http, app, token, page);
  let total = first.total_count;
  const repositories = [...first.repositories];
  while (repositories.length < total) {
    page++;
    first = await loadRepositoryByPage(http, app, token, page);
    total = first.total_count;
    // A page with nothing new would never reach the total: Coolify loops on; this stops.
    if (first.repositories.length === 0) break;
    repositories.push(...first.repositories);
  }
  return repositories
    .map((r, i) => ({ r, i }))
    .sort((a, b) => compareBytes(String(a.r.name), String(b.r.name)) || a.i - b.i)
    .map(({ r }) => r);
}

export interface GithubBranch {
  name: string;
  [key: string]: unknown;
}

/**
 * loadBranches() with loadBranchByPage(): the repository's branches, 100 a page while a page is full (a
 * refusal: "Failed to load branches of owner/repo with error: …"); retried after 200 ms on any failure, as
 * retry(3, 200) does.
 */
export async function loadRepositoryBranches(http: SourceHttp, tokens: InstallationTokens, app: GithubAppCredentials, owner: string, repo: string): Promise<GithubBranch[]> {
  const branches: GithubBranch[] = [];
  for (let page = 1; ; page++) {
    const token = await tokens.token(app);
    const url = `${joinUrl(app.api_url, `/repos/${owner}/${repo}/branches`)}?per_page=100&page=${page}`;
    const sleep = http.sleep ?? defaultSleep;
    let response: Response | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        response = await http.fetch(url, { method: "GET", headers: { "X-GitHub-Api-Version": "2022-11-28", Accept: "application/vnd.github.v3+json", Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT } });
        if (response.status >= 200 && response.status < 300) break;
      } catch (e) {
        if (attempt === 3) throw e;
      }
      if (attempt < 3) await sleep(200);
    }
    const json = await jsonOf(response!);
    if (response!.status !== 200) throw new GithubSourceError(`Failed to load branches of ${owner}/${repo} with error: ${messageOf(json) ?? `HTTP ${response!.status}`}`);
    const pageBranches = Array.isArray(json) ? (json as GithubBranch[]) : [];
    branches.push(...pageBranches);
    if (pageBranches.length !== 100) return branches;
  }
}

/** sortBranchesByPriority(): by "0_main", "1_master", "2_<name>" (a byte-wise, stable sort). */
export function sortBranchesByPriority(branches: GithubBranch[]): GithubBranch[] {
  const key = (b: GithubBranch): string => (b.name === "main" ? "0_main" : b.name === "master" ? "1_master" : `2_${String(b.name)}`);
  return branches
    .map((b, i) => ({ b, i, k: key(b) }))
    .sort((x, y) => compareBytes(x.k, y.k) || x.i - y.i)
    .map(({ b }) => b);
}

// ── What a webhook asks of GitHub ───────────────────────────────────────────────────────────────────────

/** getGithubCommitRangeFiles(): the files a push changes between two commits; null when the list is unknown (an error, or 300 files). */
export async function githubCommitRangeFiles(http: SourceHttp, tokens: InstallationTokens, app: GithubAppCredentials | null, owner: string, repo: string, before: string, after: string): Promise<string[] | null> {
  try {
    if (!app) return [];
    const answer = await githubApi(http, tokens, app, `/repos/${owner}/${repo}/compare/${before}...${after}`);
    const data = answer.data as { files?: unknown } | null;
    const files = Array.isArray(data?.files) ? (data!.files as unknown[]) : [];
    if (files.length >= 300) return null;
    const names: string[] = [];
    for (const file of files) {
      for (const key of ["filename", "previous_filename"]) {
        const name = file !== null && typeof file === "object" ? (file as Record<string, unknown>)[key] : undefined;
        if (typeof name === "string" && name !== "" && !names.includes(name)) names.push(name);
      }
    }
    return names;
  } catch {
    return null;
  }
}

/** getGithubCommitMessage(): a commit's message, or null. */
export async function githubCommitMessage(http: SourceHttp, tokens: InstallationTokens, app: GithubAppCredentials | null, owner: string, repo: string, sha: string): Promise<string | null> {
  try {
    if (!app || blank(owner) || blank(repo) || blank(sha) || sha === "HEAD") return null;
    const answer = await githubApi(http, tokens, app, `/repos/${owner}/${repo}/commits/${sha}`, { throwError: false });
    const message = (answer.data as { commit?: { message?: unknown } } | null)?.commit?.message;
    return typeof message === "string" ? message : null;
  } catch {
    return null;
  }
}

/** getGithubPullRequestFiles(): every file of a pull request, 100 a page and 30 pages at most; null when unknown. */
export async function githubPullRequestFiles(http: SourceHttp, tokens: InstallationTokens, app: GithubAppCredentials | null, owner: string, repo: string, pullRequestId: number): Promise<string[] | null> {
  try {
    if (!app) return [];
    const files: string[] = [];
    for (let page = 1; page <= 30; page++) {
      const answer = await githubApi(http, tokens, app, `/repos/${owner}/${repo}/pulls/${pullRequestId}/files?per_page=100&page=${page}`);
      const pageFiles = Array.isArray(answer.data) ? (answer.data as Array<Record<string, unknown>>) : [];
      for (const f of pageFiles) {
        const name = f?.filename;
        if (name !== null && name !== undefined && name !== "" && name !== "0" && name !== false) files.push(String(name));
      }
      if (pageFiles.length < 100) return files;
    }
    return null;
  } catch {
    return null;
  }
}

// ── The App itself ──────────────────────────────────────────────────────────────────────────────────────

/** GET {api}/app with the JWT (GithubAppPermissionJob, testConnection, syncGithubAppName). */
export async function githubAppInfo(http: SourceHttp, app: GithubAppCredentials, extraHeaders: Record<string, string> = {}): Promise<{ response: Response; json: unknown }> {
  const now = nowOf(http);
  const jwt = await githubJwt(app, now);
  const response = await http.fetch(`${app.api_url}/app`, { method: "GET", headers: { ...extraHeaders, Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": USER_AGENT } });
  return { response, json: await jsonOf(response) };
}

/** GET {api}/app/installations/{id} with the JWT. */
export async function githubInstallation(http: SourceHttp, app: GithubAppCredentials, installationId: string | number): Promise<{ response: Response; json: unknown }> {
  const jwt = await githubJwt(app, nowOf(http));
  const response = await http.fetch(`${app.api_url}/app/installations/${installationId}`, { method: "GET", headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": USER_AGENT } });
  return { response, json: await jsonOf(response) };
}

/** POST {api}/app-manifests/{code}/conversions: what GitHub registered from the manifest. */
export async function githubManifestConversion(http: SourceHttp, apiUrl: string, code: string): Promise<unknown> {
  const response = await http.fetch(`${apiUrl}/app-manifests/${code}/conversions`, { method: "POST", headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT } });
  const json = await jsonOf(response);
  // ->throw(): Laravel's RequestException for a 4xx or 5xx.
  if (response.status >= 400) throw new GithubSourceError(`HTTP request returned status code ${response.status}`);
  return json;
}

export { messageOf as githubErrorMessage };
