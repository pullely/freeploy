// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/github.php (githubApi, isTransientGithubFailure),
// app/Providers/AppServiceProvider.php (Http::GitHub) and app/Livewire/Project/New/PublicGitRepository.php
// (getBranch) (Apache-2.0), modified.
//
// The one call the Public Git Repository form makes to GitHub: does this
// branch exist. Coolify asks api.github.com as its public source, without a
// token; so does this, through a `fetch` the caller hands in (tests never
// touch the network).

/** The part of fetch() this needs. */
export type GithubFetch = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<Response>;

export interface GithubDeps {
  fetch: GithubFetch;
  /** Waits between retries; replaceable so tests do not wait. */
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface GithubApiResult {
  /** The X-RateLimit-Remaining and X-RateLimit-Reset headers, as sent. */
  rateLimitRemaining: string | null;
  rateLimitReset: string | null;
  data: unknown;
}

const pad = (n: number): string => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** PHP's (int) of a header value: its leading digits, else 0. */
const headerInt = (value: string | null): number => Number(/^\s*([+-]?\d+)/.exec(value ?? "")?.[1] ?? 0);

/**
 * Carbon::parse((int) $reset)->format(…) in UTC: 'Y-m-d H:i:s', or — with
 * `monthName` — the 'Y-M-d H:i:s' PublicGitRepository shows ("2026-Nov-24 10:00:00").
 */
export function formatRateLimitReset(reset: string | null, monthName = false): string {
  const d = new Date(headerInt(reset) * 1000);
  const month = monthName ? MONTHS[d.getUTCMonth()]! : pad(d.getUTCMonth() + 1);
  return `${d.getUTCFullYear()}-${month}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** githubApi()'s exception; Coolify's message joins its lines with <br>, here they are lines. */
export class GithubApiError extends Error {}

const defaultSleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * githubApi() for the public source: GET `${apiUrl}${endpoint}` with
 * Http::GitHub's Accept header. A dropped connection or a 5xx answer is tried
 * again, three times in all, one then two seconds apart
 * (isTransientGithubFailure); any answer that is not successful throws
 * Coolify's message with the rate limit's state.
 */
export async function githubApi(deps: GithubDeps, apiUrl: string, endpoint: string): Promise<GithubApiResult> {
  const sleep = deps.sleep ?? defaultSleep;
  let response: Response | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // GitHub refuses a request without a User-Agent; Laravel's HTTP client always sends one.
      response = await deps.fetch(`${apiUrl}${endpoint}`, { method: "GET", headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "Freeploy" } });
      if (response.status < 500) break;
    } catch (e) {
      if (attempt === 3) throw e;
    }
    if (attempt < 3) await sleep(attempt * 1000);
  }
  if (!response) throw new GithubApiError("GitHub API call failed");
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (response.status < 200 || response.status >= 300) {
    const message = data !== null && typeof data === "object" && typeof (data as { message?: unknown }).message === "string" ? (data as { message: string }).message : "no error message found";
    throw new GithubApiError(
      ["GitHub API call failed:", `Error: ${message}`, "Rate Limit Status:", `- Remaining Calls: ${response.headers.get("X-RateLimit-Remaining") ?? "0"}`, `- Reset Time: ${formatRateLimitReset(response.headers.get("X-RateLimit-Reset"))} UTC`].join("\n"),
    );
  }
  return { rateLimitRemaining: response.headers.get("X-RateLimit-Remaining"), rateLimitReset: response.headers.get("X-RateLimit-Reset"), data };
}

export interface BranchLookup {
  /** The branch GitHub knows. */
  gitBranch: string;
  /** What followed the branch in the URL ("/apps/web"), else "/". */
  baseDirectory: string;
  rateLimitRemaining: number;
  /** 'Y-M-d H:i:s' in UTC. */
  rateLimitReset: string;
}

/** PHP's urlencode(): everything but letters, digits, "-", "_" and "." is %XX, a space is "+". */
export const phpUrlencode = (value: string): string =>
  encodeURIComponent(value)
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");

/**
 * getBranch() for a GitHub repository: asks for the branch, and while GitHub
 * does not know it, for the same name without its last "/…" part — a URL
 * like …/tree/main/apps/web names the branch and a directory. What was cut
 * off is the base directory. Throws the last GithubApiError when no prefix is
 * a branch.
 */
export async function lookupGithubBranch(deps: GithubDeps, apiUrl: string, gitRepository: string, originalBranch: string): Promise<BranchLookup> {
  let branch = originalBranch;
  for (;;) {
    try {
      const r = await githubApi(deps, apiUrl, `/repos/${gitRepository}/branches/${phpUrlencode(branch)}`);
      // str($originalBranch)->after($branchToTry)->trim('/')
      const at = originalBranch.indexOf(branch);
      const remaining = (branch === "" || at === -1 ? originalBranch : originalBranch.slice(at + branch.length)).replace(/^\/+|\/+$/g, "");
      return {
        gitBranch: branch,
        baseDirectory: remaining.trim() !== "" ? `/${remaining}` : "/",
        rateLimitRemaining: headerInt(r.rateLimitRemaining),
        rateLimitReset: formatRateLimitReset(r.rateLimitReset, true),
      };
    } catch (e) {
      if (!branch.includes("/")) throw e;
      branch = branch.slice(0, branch.lastIndexOf("/"));
    }
  }
}
