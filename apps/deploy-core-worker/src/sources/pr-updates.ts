// Derived from coollabsio/coolify@91b7e3e:app/Jobs/ApplicationPullRequestUpdateJob.php,
// app/Jobs/SyncGithubDeploymentJob.php, app/Enums/{ProcessStatus,ApplicationDeploymentStatus}.php and
// bootstrap/helpers/shared.php (gitRepositorySlug) (Apache-2.0), modified.
//
// What Coolify tells GitHub about a deployment of a GitHub App's repository: the pull request comment of a
// preview (ApplicationPullRequestUpdateJob) and the GitHub Deployment with its statuses (SyncGithubDeploymentJob)
// — as pure request builders: the endpoint, the method and the JSON each sends. **Nothing sends them yet.**
// Both are dispatched when a deployment changes state (queued, in progress, finished, failed, cancelled), and
// no Freeploy deployment can run before the SSH executor exists (WAITING.md W3); the one place they would be
// sent today without a deployment — deleting the comment of a closed pull request — has no comment to delete,
// because none was ever posted. They are held to Coolify's own requests by the goldens of
// tests/deploy-core-worker/fixtures/sources.
import { sshGitUrlToHttps } from "../applications/git.js";
import { parseUrl } from "../s3-storages/safe-url.js";

/** One request githubApi() sends: the endpoint below the API URL, the method, the JSON body. */
export interface GithubRequest {
  method: "get" | "post" | "patch" | "delete";
  endpoint: string;
  data: Record<string, unknown> | null;
}

/** gitRepositorySlug(): owner/name of a repository however it is written. */
export function gitRepositorySlug(gitRepository: string | null): string {
  if (typeof gitRepository !== "string" || gitRepository === "") return "";
  let repo = gitRepository;
  const https = sshGitUrlToHttps(repo);
  if (https !== null) repo = parseUrl(https)?.path ?? "";
  else if (repo.startsWith("http") || repo.includes("github.com")) repo = repo.split("https://").join("").split("http://").join("").split("github.com/").join("");
  repo = repo.replace(/^\/+|\/+$/g, "");
  return repo.endsWith(".git") ? repo.slice(0, -4) : repo;
}

/** ProcessStatus. */
export type ProcessStatus = "queued" | "in_progress" | "finished" | "error" | "killed" | "cancelled" | "closed";

export interface PullRequestCommentInput {
  status: ProcessStatus;
  applicationName: string;
  applicationUuid: string;
  projectUuid: string;
  environmentUuid: string;
  deploymentUuid: string | null;
  buildPack: string;
  previewFqdn: string | null;
  previewDockerComposeDomains: string | null;
  /** base_url(): the console's URL. */
  baseUrl: string;
  /** now()->toDateTimeString(): 'Y-m-d H:i:s' in UTC. */
  now: string;
}

/** getPreviewLinks(): "[Open Preview](…) | ", or one link per Compose service with a domain. */
function previewLinks(input: PullRequestCommentInput): string {
  if (input.buildPack === "dockercompose") {
    let domains: unknown = null;
    try {
      domains = JSON.parse(input.previewDockerComposeDomains ?? "null");
    } catch {
      domains = null;
    }
    const links: string[] = [];
    if (domains !== null && typeof domains === "object") {
      for (const [service, config] of Object.entries(domains as Record<string, unknown>)) {
        const domain = config !== null && typeof config === "object" ? (config as { domain?: unknown }).domain : undefined;
        if (domain === undefined || domain === null || domain === "" || domain === "0") continue;
        const first = String(domain).split(",")[0]!.trim();
        if (first !== "" && first !== "0") links.push(`[Open ${service}](${first})`);
      }
    }
    return links.length ? `${links.join(" | ")} | ` : "";
  }
  return input.previewFqdn ? `[Open Preview](${input.previewFqdn}) | ` : "";
}

/** commentBody(): the status line, the build and application log links, the update time. */
export function pullRequestCommentBody(input: PullRequestCommentInput): string {
  const name = input.applicationName;
  const head: Record<ProcessStatus, string> = {
    queued: `The preview deployment for **${name}** is queued. ⏳\n\n`,
    in_progress: `The preview deployment for **${name}** is in progress. 🟡\n\n`,
    finished: `The preview deployment for **${name}** is ready. 🟢\n\n${previewLinks(input)}`,
    error: `The preview deployment for **${name}** failed. 🔴\n\n`,
    killed: `The preview deployment for **${name}** was killed. ⚫\n\n`,
    cancelled: `The preview deployment for **${name}** was cancelled. 🚫\n\n`,
    closed: "",
  };
  const app = `${input.baseUrl}/project/${input.projectUuid}/environment/${input.environmentUuid}/application/${input.applicationUuid}`;
  // imageScanLine(): no deployment of Freeploy's has a scan gate result, so it is always empty.
  return `${head[input.status]}[Open Build Logs](${app}/deployment/${input.deploymentUuid ?? ""}) | [Open Application Logs](${app}/logs)\n\n\nLast updated at: ${input.now} CET`;
}

/**
 * handle(): nothing for a public repository; CLOSED deletes the comment; otherwise the comment is updated
 * when the preview has one, else created (a comment GitHub no longer has is created again).
 */
export function pullRequestUpdateRequest(
  input: PullRequestCommentInput & { isPublicRepository: boolean; gitRepository: string; pullRequestId: number; issueCommentId: string | null },
): GithubRequest | null {
  if (input.isPublicRepository) return null;
  const slug = gitRepositorySlug(input.gitRepository);
  if (input.status === "closed") return { method: "delete", endpoint: `/repos/${slug}/issues/comments/${input.issueCommentId ?? ""}`, data: null };
  const body = pullRequestCommentBody(input);
  if (input.issueCommentId) return { method: "patch", endpoint: `/repos/${slug}/issues/comments/${input.issueCommentId}`, data: { body } };
  return { method: "post", endpoint: `/repos/${slug}/issues/${input.pullRequestId}/comments`, data: { body } };
}

// ── GitHub Deployments ──────────────────────────────────────────────────────────────────────────────────

export type GithubDeploymentState = "in_progress" | "success" | "failure" | "error" | "inactive";

/** githubState(): the GitHub state of a deployment's status, or null for one GitHub does not show. */
export function githubDeploymentState(status: string): GithubDeploymentState | null {
  return ({ "in_progress": "in_progress", finished: "success", failed: "failure", "cancelled-by-user": "error" } as Record<string, GithubDeploymentState>)[status] ?? null;
}

/** description(). */
export function githubDeploymentDescription(state: GithubDeploymentState): string {
  return {
    in_progress: "Deploying with Freeploy.",
    success: "Deployed with Freeploy.",
    failure: "The Freeploy deployment failed.",
    error: "The Freeploy deployment was cancelled.",
    inactive: "The pull request was closed.",
  }[state];
}

/** Str::limit($value, $limit, ''): at most `limit` characters. */
const limit = (value: string, n: number): string => [...value].slice(0, n).join("");

/** createGithubDeployment()'s POST repos/{slug}/deployments. */
export function githubDeploymentCreateRequest(input: { gitRepository: string; applicationName: string; pullRequestId: number; ref: string }): GithubRequest {
  const isPreview = input.pullRequestId !== 0;
  return {
    method: "post",
    endpoint: `repos/${gitRepositorySlug(input.gitRepository)}/deployments`,
    data: {
      ref: input.ref,
      environment: limit(isPreview ? `${input.applicationName} (preview)` : input.applicationName, 255),
      description: limit(isPreview ? `Freeploy preview for PR #${input.pullRequestId}` : "Freeploy deployment", 140),
      auto_merge: false,
      required_contexts: [],
      transient_environment: isPreview,
      production_environment: !isPreview,
    },
  };
}

/**
 * ref(): the head branch of a same-repository pull request while it still points at the deployed commit,
 * else the commit (or the pull request's head commit); the commit, else the branch, for a branch deployment.
 */
export function githubDeploymentRef(input: { commit: string | null; pullRequestId: number; gitBranch: string; repositorySlug: string; pullRequest: unknown }): string {
  const commit = input.commit !== null && input.commit.trim() !== "" && input.commit !== "HEAD" ? input.commit : null;
  if (input.pullRequestId !== 0) {
    const pr = (input.pullRequest ?? {}) as { head?: { repo?: { full_name?: unknown }; ref?: unknown; sha?: unknown }; base?: { repo?: { full_name?: unknown } } };
    const headRepository = String(pr.head?.repo?.full_name ?? "");
    const baseRepository = String(pr.base?.repo?.full_name ?? input.repositorySlug);
    const headBranch = pr.head?.ref;
    const headCommit = String(pr.head?.sha ?? "");
    const isDeployedCommit = commit === null || commit.toLowerCase() === headCommit.toLowerCase();
    if (typeof headBranch === "string" && headBranch.trim() !== "" && headRepository.toLowerCase() === baseRepository.toLowerCase() && isDeployedCommit) return headBranch;
    return commit ?? headCommit;
  }
  return commit ?? input.gitBranch;
}

/** environmentUrl(): the first domain of the preview or the application, when it is an http(s) URL. */
export function githubDeploymentEnvironmentUrl(input: { buildPack: string; fqdn: string | null; dockerComposeDomains: string | null }): string | null {
  let domains: unknown = input.fqdn;
  if (input.buildPack === "dockercompose") {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(input.dockerComposeDomains ?? "");
    } catch {
      parsed = null;
    }
    domains = null;
    if (parsed !== null && typeof parsed === "object") {
      for (const config of Object.values(parsed as Record<string, unknown>)) {
        const d = config !== null && typeof config === "object" ? (config as { domain?: unknown }).domain : undefined;
        if (d !== undefined && d !== null && d !== "" && d !== "0" && d !== false) {
          domains = d;
          break;
        }
      }
    }
  }
  const url = String(domains ?? "").split(",")[0]!.trim();
  return url.startsWith("http://") || url.startsWith("https://") ? url : null;
}

/** handle()'s POST repos/{slug}/deployments/{id}/statuses: array_filter() leaves out the empty fields. */
export function githubDeploymentStatusRequest(input: { gitRepository: string; githubDeploymentId: number | string; state: GithubDeploymentState; logUrl: string; environmentUrl: string | null }): GithubRequest {
  const data: Record<string, unknown> = { state: input.state, description: githubDeploymentDescription(input.state), log_url: input.logUrl };
  if (input.state === "success" && input.environmentUrl !== null && input.environmentUrl !== "" && input.environmentUrl !== "0") data.environment_url = input.environmentUrl;
  return { method: "post", endpoint: `repos/${gitRepositorySlug(input.gitRepository)}/deployments/${input.githubDeploymentId}/statuses`, data };
}
