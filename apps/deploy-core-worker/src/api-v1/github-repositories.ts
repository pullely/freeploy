// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/GithubController.php (load_repositories,
// load_branches), app/Http/Controllers/Api/ApplicationsController.php (githubAppRepository, teamSourceByUuid),
// app/Models/GithubApp.php (installationToken), bootstrap/helpers/github.php (githubAppPrivateKey, generateGithubToken,
// generateGithubInstallationToken, isTransientGithubFailure, githubRateLimitMessage) and
// app/Providers/AppServiceProvider.php (Http::GitHub) (Apache-2.0), modified.
//
// Coolify's /api/v1 through one of the org's GitHub Apps (DP-93): the installation's repositories and a repository's
// branches, and the repository check of POST /applications/private-github-app. The App signs its JWT (RS256, DP-72's
// jwt.ts) with its private key, decrypted from the org's private_keys row, and asks GitHub for an installation token;
// GitHub is reached through the context's fetch (ApiV1Context.providers, DP-90's), with Laravel's retry(…, throw: false)
// as each call sets it, and its answers are written back as Coolify writes what $response->json() decoded. A failure
// Coolify does not catch (no installation token, no private key) reaches its exception handler: 500 "Server Error".
// Neither route asks a policy (Coolify's controller calls none).
import type { SqlExecutor } from "@saas/db/hyperdrive";
import type { ApiRow } from "@saas/db/deploy";
import { coolifyJson, isObj, obj, type CoolifyAnswer, type PhpValue } from "@saas/contracts/coolify-api";
import { githubAppJwt } from "../sources/jwt.js";
import { compareBytes, githubRateLimitMessage } from "../sources/github.js";
import { rawurlencode } from "../deployments/php.js";
import { decryptColumn, message, rowsOf, type ApiV1Context } from "./context.js";
import { rowValue } from "./models.js";
import { providerSend, type Failure, type ProviderResponse } from "./cloud-providers.js";

/** An uncaught exception (handleError() rethrows it) as Laravel answers it under api/* without APP_DEBUG. */
export const GITHUB_SERVER_ERROR: CoolifyAnswer = { status: 500, body: '{\n    "message": "Server Error"\n}', headers: { "content-type": "application/json" } };

/** What Coolify's controller does not catch: the RuntimeExceptions of generateGithubToken(). */
export class GithubTokenError extends Error {}

/** Laravel's default timeout for a request with no timeout() of its own (generateGithubToken's), and the controllers' timeout(20). */
const DEFAULT_TIMEOUT_MS = 30_000;
const TIMEOUT_MS = 20_000;

/** isTransientGithubFailure(): a dropped connection, or a 5xx answer. */
const transient = (f: Failure): boolean => "error" in f || f.response.status >= 500;

const nowOf = (c: ApiV1Context): Date => (c.providers.now ?? (() => new Date()))();

/** $response->json()['message'] ?? null */
const messageOf = (r: ProviderResponse): PhpValue | undefined => (isObj(r.json) ? r.json.entries.find(([k]) => k === "message")?.[1] : undefined);

/** The App's row of the org (team_id = the token's team). */
export async function githubAppById(tx: SqlExecutor, id: string): Promise<ApiRow | null> {
  if (!/^\d+$/.test(id)) return null;
  return (await rowsOf(tx)("github_apps", "t.id = $1", [id]))[0] ?? null;
}

/**
 * GithubApp::installationToken() (generateGithubToken($source, 'installation')): the App's JWT, signed with its private key
 * (githubAppPrivateKey(): the App's own team's key), POST {api}/app/installations/{id}/access_tokens, a 5xx or a dropped
 * connection tried three times, a second and then two apart; a refusal is Coolify's RuntimeException.
 */
export async function githubInstallationTokenOf(tx: SqlExecutor, c: ApiV1Context, app: ApiRow): Promise<string> {
  const keyId = rowValue(app, "private_key_id");
  const key = keyId === null || keyId === undefined ? undefined : (await rowsOf(tx)("private_keys", "t.id = $1", [keyId]))[0];
  const pem = key ? await decryptColumn(tx, c, "private_keys", "private_key", rowValue(key, "private_key")) : null;
  if (pem === null) throw new GithubTokenError("Private key not found for this GitHub App.");
  const jwt = await githubAppJwt(pem, String(rowValue(app, "app_id") ?? ""), nowOf(c));
  const installation = String(rowValue(app, "installation_id") ?? "");
  const response = await providerSend(c.providers, {
    method: "post",
    url: `${String(rowValue(app, "api_url"))}/app/installations/${installation}/access_tokens`,
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github.machine-man-preview+json" },
    // post($url) of a JSON request: an empty array, "[]".
    json: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retry: { tries: 3, sleep: (attempt) => attempt * 1000, when: transient },
  });
  if (!response.successful) {
    let error = messageOf(response);
    let text = typeof error === "string" ? error : `HTTP ${response.status}`;
    if (text === "Not Found") text = `GitHub App installation ${installation} was not found. Install the GitHub App again or update its installation ID.`;
    error = text;
    throw new GithubTokenError(`Failed to get installation token for ${String(rowValue(app, "name"))} with error: ${error}`);
  }
  const token = isObj(response.json) ? response.json.entries.find(([k]) => k === "token")?.[1] : undefined;
  if (typeof token !== "string") throw new GithubTokenError("The installation token GitHub answered is not a string.");
  return token;
}

/** Http::GitHub($api_url, $token)->timeout(20)->retry(3, 200, …, throw: false)->get(…) */
function githubGet(c: ApiV1Context, app: ApiRow, token: string, path: string, query: Array<[string, string | number]> | undefined, when?: (f: Failure) => boolean): Promise<ProviderResponse> {
  return providerSend(c.providers, {
    method: "get",
    url: `${String(rowValue(app, "api_url")).replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`,
    ...(query && { query }),
    headers: { "X-GitHub-Api-Version": "2022-11-28", Accept: "application/vnd.github.v3+json", Authorization: `Bearer ${token}` },
    timeoutMs: TIMEOUT_MS,
    retry: { tries: 3, sleep: () => 200, ...(when && { when }) },
  });
}

/** PHP 8's comparison of two names (Collection::sortBy(): SORT_REGULAR): numeric strings as numbers, others byte-wise. */
function compareNames(a: PhpValue | undefined, b: PhpValue | undefined): number {
  const numeric = (v: unknown): v is string | number => typeof v === "number" || (typeof v === "string" && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(v));
  if (numeric(a) && numeric(b)) return Math.sign(Number(a) - Number(b));
  return Math.sign(compareBytes(String(a ?? ""), String(b ?? "")));
}

const nameOf = (v: PhpValue): PhpValue | undefined => (isObj(v) ? v.entries.find(([k]) => k === "name")?.[1] : undefined);
const listOf = (v: PhpValue | undefined): PhpValue[] => (Array.isArray(v) ? v : isObj(v) ? v.entries.map(([, x]) => x) : []);

/** load_repositories(): every page of the installation's repositories (100 a page, at most 100 pages) until one is empty, sorted by name. */
async function loadRepositories(c: ApiV1Context, id: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const app = await githubAppById(tx, id);
    if (!app) return message("GitHub app not found", 404);
    let token: string;
    try {
      token = await githubInstallationTokenOf(tx, c, app);
    } catch (e) {
      if (e instanceof GithubTokenError) return GITHUB_SERVER_ERROR;
      throw e;
    }
    const repositories: PhpValue[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await githubGet(c, app, token, "/installation/repositories", [["per_page", 100], ["page", page]]);
      if (response.status !== 200) {
        const m = messageOf(response);
        return coolifyJson(obj({ message: m === undefined || m === null ? "Failed to load repositories" : m }), response.status);
      }
      const repos = listOf(isObj(response.json) ? response.json.entries.find(([k]) => k === "repositories")?.[1] : undefined);
      if (repos.length === 0) break;
      repositories.push(...repos);
    }
    const sorted = repositories.map((r, i) => ({ r, i })).sort((a, b) => compareNames(nameOf(a.r), nameOf(b.r)) || a.i - b.i);
    return coolifyJson(obj({ repositories: sorted.map(({ r }) => r) }));
  });
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** load_branches(): the owner and repository checked, then GET /repos/{owner}/{repo}/branches (one page, GitHub's default). */
async function loadBranches(c: ApiV1Context, id: string, owner: string, repo: string): Promise<CoolifyAnswer> {
  const errors: Array<[string, PhpValue]> = [];
  for (const [field, value] of [["owner", owner], ["repo", repo]] as const) if (!SEGMENT.test(value) || value === "." || value === "..") errors.push([field, [`The ${field} is invalid.`]]);
  if (errors.length) return coolifyJson(obj({ message: "Validation failed.", errors: obj(errors) }), 422);
  return c.sql(c.env, c.orgId, async (tx) => {
    const app = await githubAppById(tx, id);
    if (!app) return message("GitHub app not found", 404);
    let token: string;
    try {
      token = await githubInstallationTokenOf(tx, c, app);
    } catch (e) {
      if (e instanceof GithubTokenError) return GITHUB_SERVER_ERROR;
      throw e;
    }
    const response = await githubGet(c, app, token, `/repos/${rawurlencode(owner)}/${rawurlencode(repo)}/branches`, undefined);
    if (response.status !== 200) return coolifyJson(obj({ message: "Error loading branches from GitHub.", error: messageOf(response) ?? null }), response.status);
    return coolifyJson(obj({ branches: response.json }));
  });
}

/** routes/api.php's /github-apps/{github_app_id}/repositories[/{owner}/{repo}/branches]. */
export async function githubRepositoriesApi(c: ApiV1Context, id: string, segments: string[]): Promise<CoolifyAnswer | null> {
  if (c.method !== "GET") return null;
  if (segments.length === 0) return loadRepositories(c, id);
  const [owner, repo, branches, extra] = segments;
  if (branches === "branches" && extra === undefined && owner !== undefined && repo !== undefined) return loadBranches(c, id, owner, repo);
  return null;
}

/**
 * githubAppRepository(): the org's App by uuid (Freeploy has no system-wide one), its installation token, then
 * GET /repos/{slug} (a 5xx or a dropped connection tried three times, 200 ms apart): a rate limit's 429, 404 for a
 * repository the App cannot read, 400 for another failure; else the repository's id (repository_project_id).
 */
export async function githubAppRepository(tx: SqlExecutor, c: ApiV1Context, uuid: string, slug: string): Promise<{ app: ApiRow; repositoryProjectId: PhpValue } | CoolifyAnswer> {
  const app = (await rowsOf(tx)("github_apps", "t.uuid = $1", [uuid]))[0];
  if (!app) return message("Github App not found.", 404);
  let token: string;
  try {
    token = await githubInstallationTokenOf(tx, c, app);
  } catch (e) {
    if (e instanceof GithubTokenError) return GITHUB_SERVER_ERROR;
    throw e;
  }
  const response = await githubGet(c, app, token, `/repos/${slug}`, undefined, transient);
  const rateLimit = githubRateLimitMessage(new Response(null, { status: response.status, headers: response.headers }), toJs(response.json), nowOf(c));
  if (rateLimit !== null) return message(rateLimit, 429);
  if (response.status === 404 || response.status === 403) return message("Repository not found or not accessible by the GitHub App.", 404);
  if (!response.successful) {
    const m = messageOf(response);
    return message(`Failed to verify repository access: ${typeof m === "string" ? m : m === undefined || m === null ? "Unknown error" : String(m)}`, 400);
  }
  const repositoryId = isObj(response.json) ? (response.json.entries.find(([k]) => k === "id")?.[1] ?? null) : null;
  return { app, repositoryProjectId: repositoryId };
}

/** A decoded answer as plain JavaScript, for the helpers that read `message`. */
function toJs(v: PhpValue): unknown {
  if (Array.isArray(v)) return v.map(toJs);
  if (isObj(v)) return Object.fromEntries(v.entries.map(([k, x]) => [k, toJs(x)]));
  return v;
}

