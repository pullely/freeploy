// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Webhook/Concerns/{ReadsWebhookPushPayload,
// MatchesManualWebhookApplications,DetectsSkipDeployCommits,ValidatesPreviewDeploymentRepository}.php,
// app/Exceptions/InvalidWebhookPayloadException.php, app/Http/Controllers/Webhook/Github.php
// (readPullRequestPayload, isForkPullRequest), app/Models/Application.php (isWatchPathsTriggered,
// matchPaths, globMatch, globToRegex) and bootstrap/helpers/shared.php (parseScpStyleGitUrl) (Apache-2.0),
// modified.
//
// How a webhook's body is read: defensively, as Coolify reads it. A payload is untrusted — the typed readers
// throw InvalidWebhookPayload for a value of the wrong type or format, which the receiver answers with a
// clean "Nothing to do. Invalid '<field>' in the request." and never with a 500 or a deployment.
import { parseUrl } from "../s3-storages/safe-url.js";
import { parseScpStyleGitUrl } from "../applications/git.js";

/** A decoded JSON body: what Laravel's $request->collect() and data_get() walk. */
export type Payload = unknown;

/** InvalidWebhookPayloadException::forField(). */
export class InvalidWebhookPayload extends Error {
  constructor(field: string) {
    super(`Nothing to do. Invalid '${field}' in the request.`);
  }
}

/** Largest value of an integer column (pull_request_id, repository_project_id). */
export const WEBHOOK_MAX_DATABASE_INTEGER = 2147483647;
/** Length of application_previews.pull_request_html_url. */
export const WEBHOOK_MAX_URL_LENGTH = 255;

/** data_get() with a dotted key over arrays and objects. */
export function dataGet(payload: Payload, key: string): unknown {
  let value: unknown = payload;
  for (const part of key.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** webhookPushBranch(): the branch of "refs/heads/main" (Str::after), or null. */
export function webhookPushBranch(ref: unknown): string | null {
  if (typeof ref !== "string" || ref === "") return null;
  const at = ref.indexOf("refs/heads/");
  const branch = at === -1 ? ref : ref.slice(at + "refs/heads/".length);
  return branch === "" ? null : branch;
}

/** webhookString(): a non-empty string, else null. */
export const webhookString = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** webhookPayloadString(): a string field; missing, null or "" is null. */
export function webhookPayloadString(payload: Payload, key: string, required = false): string | null {
  const value = dataGet(payload, key);
  if (value === null || value === undefined || value === "") {
    if (required) throw new InvalidWebhookPayload(key);
    return null;
  }
  if (typeof value !== "string") throw new InvalidWebhookPayload(key);
  return value;
}

/** webhookPayloadId(): a positive integer, sent as a number or a string of digits, at most `max`. */
export function webhookPayloadId(payload: Payload, key: string, required = false, max = Number.MAX_SAFE_INTEGER): number | null {
  let value = dataGet(payload, key);
  if (value === null || value === undefined) {
    if (required) throw new InvalidWebhookPayload(key);
    return null;
  }
  if (typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)) {
    // FILTER_VALIDATE_INT: false past PHP_INT_MAX.
    const n = Number(value);
    value = BigInt(value) <= 9223372036854775807n ? n : false;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) throw new InvalidWebhookPayload(key);
  return value;
}

export const webhookPayloadDatabaseId = (payload: Payload, key: string, required = false): number | null => webhookPayloadId(payload, key, required, WEBHOOK_MAX_DATABASE_INTEGER);
export const webhookPullRequestId = (payload: Payload, key: string): number => webhookPayloadDatabaseId(payload, key, true)!;

/** webhookCommitSha(): 7 to 64 hex characters; missing, null or "" is null. */
export function webhookCommitSha(payload: Payload, key: string): string | null {
  const value = dataGet(payload, key);
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^[0-9a-fA-F]{7,64}$/.test(value)) throw new InvalidWebhookPayload(key);
  return value;
}

/** webhookPayloadUrl(): an absolute http(s) URL of at most 255 bytes without whitespace or control characters. */
export function webhookPayloadUrl(payload: Payload, key: string, required = false): string | null {
  const value = webhookPayloadString(payload, key, required);
  if (value === null) return null;
  const parsed = parseUrl(value);
  const scheme = parsed?.scheme;
  const host = parsed?.host;
  if (
    new TextEncoder().encode(value).length > WEBHOOK_MAX_URL_LENGTH ||
    /[\s\x00-\x1F\x7F]/.test(value) ||
    typeof scheme !== "string" ||
    !["http", "https"].includes(scheme.toLowerCase()) ||
    typeof host !== "string" ||
    host === ""
  ) {
    throw new InvalidWebhookPayload(key);
  }
  return value;
}

const isPhpArray = (value: unknown): value is Record<string, unknown> | unknown[] => value !== null && typeof value === "object";
const valuesOf = (value: Record<string, unknown> | unknown[]): unknown[] => (Array.isArray(value) ? value : Object.values(value));

/** webhookPushChangedFiles(): what the commits add, remove or modify, unique; null without a commit list. */
export function webhookPushChangedFiles(payload: Payload): string[] | null {
  const commits = dataGet(payload, "commits");
  if (!isPhpArray(commits)) return null;
  const files: string[] = [];
  for (const commit of valuesOf(commits)) {
    if (!isPhpArray(commit)) continue;
    for (const type of ["added", "removed", "modified"]) {
      const list = (commit as Record<string, unknown>)[type];
      if (!isPhpArray(list)) continue;
      for (const file of valuesOf(list)) if (typeof file === "string" && file !== "" && !files.includes(file)) files.push(file);
    }
  }
  return files;
}

/** webhookPushCommitMessages(): the commits' messages that are strings. */
export function webhookPushCommitMessages(payload: Payload, commitsPath = "commits"): string[] {
  const commits = dataGet(payload, commitsPath);
  if (!isPhpArray(commits)) return [];
  return valuesOf(commits)
    .map((c) => (isPhpArray(c) ? (c as Record<string, unknown>).message : null))
    .filter((m): m is string => typeof m === "string");
}

/** isWebhookBranchDeletionPush(): `deleted`, or an all-zero `after`. */
export function isWebhookBranchDeletionPush(payload: Payload): boolean {
  if (dataGet(payload, "deleted") === true) return true;
  const after = dataGet(payload, "after");
  return typeof after === "string" && /^0+$/.test(after);
}

/** filled() of a string: not blank after trim. */
const filledString = (m: unknown): boolean => typeof m === "string" && m.trim() !== "";

/** shouldSkipDeploy(): every non-empty message carries [skip cd] or [skip ci]. */
export function shouldSkipDeploy(messages: unknown[]): boolean {
  const list = messages.filter(filledString) as string[];
  if (list.length === 0) return false;
  return list.every((m) => {
    const lower = m.toLowerCase();
    return lower.includes("[skip cd]") || lower.includes("[skip ci]");
  });
}

/** shouldSkipDeployAny(): one non-empty message carries a skip marker. */
export function shouldSkipDeployAny(messages: unknown[]): boolean {
  return messages.some((m) => filledString(m) && ((m as string).toLowerCase().includes("[skip cd]") || (m as string).toLowerCase().includes("[skip ci]")));
}

// ── The repository of a manual webhook ─────────────────────────────────────────────────────────────────

/** normalizeManualWebhookRepositoryPath(): trimmed, without query or fragment, slashes, or ".git". */
export function normalizeManualWebhookRepositoryPath(path: string): string {
  let p = path.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "");
  // strtok($path, '?#') ?: $path — the first token, skipping leading delimiters.
  const token = /[^?#]+/.exec(p)?.[0];
  if (token !== undefined && token !== "" && token !== "0") p = token;
  p = p.replace(/^\/+|\/+$/g, "");
  return p.replace(/\.git$/i, "");
}

/** manualWebhookRepositoryFullName(): `owner/repo[/…]` of a payload, or null. */
export function manualWebhookRepositoryFullName(fullName: unknown): string | null {
  if (typeof fullName !== "string") return null;
  const trimmed = fullName.replace(/^[ \t\n\r\0\x0B/]+|[ \t\n\r\0\x0B/]+$/g, "");
  if (trimmed === "") return null;
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(trimmed)) return null;
  return normalizeManualWebhookRepositoryPath(trimmed);
}

/** canonicalManualWebhookRepository(): the path of an application's git_repository. */
export function canonicalManualWebhookRepository(gitRepository: string | null): string | null {
  if (typeof gitRepository !== "string") return null;
  const repo = gitRepository.trim();
  if (repo === "") return null;
  let path: string | undefined;
  const parts = parseUrl(repo);
  const scp = parseScpStyleGitUrl(repo);
  if (parts && parts.scheme !== undefined && /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(repo)) path = parts.path;
  else if (scp) path = scp.path;
  else path = repo;
  if (typeof path !== "string" || path === "") return null;
  return normalizeManualWebhookRepositoryPath(path);
}

/** manualWebhookRepositoryMatches(): the same path, case-insensitively, or one under a sub-path. */
export function manualWebhookRepositoryMatches(gitRepository: string | null, fullName: string): boolean {
  const path = canonicalManualWebhookRepository(gitRepository);
  if (path === null) return false;
  const name = fullName.toLowerCase();
  const p = path.toLowerCase();
  return p === name || p.endsWith(`/${name}`);
}

/** The LIKE the database narrows the applications with: every accepted form contains the name. */
export const manualWebhookRepositoryPattern = (fullName: string): string => `%${fullName.toLowerCase().replace(/_/g, "\\_")}%`;

export const UNAUTHENTICATED_MANUAL_WEBHOOK_FAILURE = { status: "failed", message: "No matching application or invalid signature." } as const;

// ── Pull requests ───────────────────────────────────────────────────────────────────────────────────────

export interface PullRequestPayload {
  action: string;
  pullRequestId: number;
  pullRequestHtmlUrl: string;
  pullRequestTitle: string | null;
  branch: string | null;
  baseBranch: string | null;
  beforeSha: string | null;
  afterSha: string | null;
  commitSha: string;
  isForkPullRequest: boolean;
}

/** Github::isForkPullRequest(): ids first, then head.repo.fork, then the names; an unknown head is a fork. */
export function isForkPullRequest(payload: Payload): boolean {
  const head = webhookPayloadId(payload, "pull_request.head.repo.id");
  const base = webhookPayloadId(payload, "pull_request.base.repo.id");
  if (head !== null && base !== null) return head !== base;
  if (dataGet(payload, "pull_request.head.repo.fork") === true) return true;
  const headName = dataGet(payload, "pull_request.head.repo.full_name");
  const baseName = dataGet(payload, "pull_request.base.repo.full_name");
  if (typeof headName === "string" && typeof baseName === "string") return headName.toLowerCase() !== baseName.toLowerCase();
  return true;
}

/** Github::readPullRequestPayload(), in its order of reads (the first invalid field is the one named). */
export function readGithubPullRequestPayload(payload: Payload): PullRequestPayload {
  const headSha = webhookCommitSha(payload, "pull_request.head.sha");
  const action = webhookPayloadString(payload, "action", true)!;
  const pullRequestId = webhookPullRequestId(payload, "number");
  const pullRequestHtmlUrl = webhookPayloadUrl(payload, "pull_request.html_url", true)!;
  const pullRequestTitle = webhookPayloadString(payload, "pull_request.title");
  const branch = webhookString(dataGet(payload, "pull_request.head.ref"));
  const baseBranch = webhookString(dataGet(payload, "pull_request.base.ref"));
  const beforeSha = webhookCommitSha(payload, "before");
  const afterSha = webhookCommitSha(payload, "after") ?? headSha;
  return { action, pullRequestId, pullRequestHtmlUrl, pullRequestTitle, branch, baseBranch, beforeSha, afterSha, commitSha: headSha ?? "HEAD", isForkPullRequest: isForkPullRequest(payload) };
}

// ── Watch paths ─────────────────────────────────────────────────────────────────────────────────────────

/** Application::globToRegex(): *, **, ?, [abc] and [!abc]; the rest literal. */
export function globToRegex(pattern: string): string {
  let regex = "";
  let inGroup = false;
  // str_split(): bytes; a non-ASCII character is several of them, literal either way.
  const chars = [...pattern];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    switch (c) {
      case "*":
        if (i + 1 < chars.length && chars[i + 1] === "*") {
          regex += ".*";
          i++;
          if (i + 1 < chars.length && chars[i + 1] === "/") i++;
        } else regex += "[^/]*";
        break;
      case "?":
        regex += "[^/]";
        break;
      case "[":
        inGroup = true;
        regex += "[";
        if (i + 1 < chars.length && (chars[i + 1] === "!" || chars[i + 1] === "^")) {
          regex += "^";
          i++;
        }
        break;
      case "]":
        regex += inGroup ? "]" : "\\]";
        inGroup = false;
        break;
      case ".":
      case "(":
      case ")":
      case "+":
      case "{":
      case "}":
      case "$":
      case "^":
      case "|":
      case "\\":
        regex += `\\${c}`;
        break;
      default:
        regex += c;
    }
  }
  return `^${regex}$`;
}

/**
 * Application::globMatch(). A pattern PCRE cannot compile makes preg_match() warn, which Laravel turns into
 * an exception: the webhook fails (a server error), as Coolify's does.
 */
export function globMatch(pattern: string, path: string): boolean {
  let regex: RegExp;
  try {
    // PCRE's `$` also matches before a final line break.
    regex = new RegExp(globToRegex(pattern).replace(/\$$/, "(?:\\n)?$"));
  } catch {
    throw new Error("preg_match(): Compilation failed");
  }
  return regex.test(path);
}

/** Application::matchPaths(): the last matching pattern decides; only exclusions include by default. */
export function matchWatchPaths(files: string[], watchPaths: string[]): string[] {
  if (watchPaths.length === 0) return [];
  return files.filter((file) => {
    let include: boolean | null = null;
    for (const raw of watchPaths) {
      const pattern = raw.trim();
      if (pattern === "" || pattern === "0") continue;
      const exclusion = pattern.startsWith("!");
      if (globMatch(exclusion ? pattern.slice(1) : pattern, file)) include = !exclusion;
    }
    if (include === null) return !watchPaths.some((p) => !p.trim().startsWith("!"));
    return include;
  });
}

/** webhookPushMatchesWatchPaths(): no watch paths or unknown files deploy; else isWatchPathsTriggered(). */
export function webhookPushMatchesWatchPaths(watchPaths: string | null, changedFiles: string[] | null): boolean {
  if (watchPaths === null || watchPaths.trim() === "" || changedFiles === null) return true;
  return matchWatchPaths(changedFiles, watchPaths.split("\n")).length > 0;
}
