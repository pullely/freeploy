// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/Source.php,
// app/Models/Application.php (deploymentType, customRepository, gitSshHost, gitBranchLocation, gitCommits,
// gitWebhook, sourceRepositoryUrl), bootstrap/helpers/shared.php (convertGitUrl),
// app/Rules/{ValidGitRepositoryUrl,ValidGitBranch}.php and
// resources/views/livewire/project/application/source.blade.php (the subtitles) (Apache-2.0), modified.
//
// An application's Git Source page: the repository, branch and commit; the
// SSH host keys git accepts; the HTTPS credentials of a custom Git host; the
// deploy key; and the Git source. Rows only: reading a host's keys needs the
// SSH executor, and asking a Git App for the repository's id needs the App's
// connection (DP6).
import { PUBLIC_GITHUB_SOURCE, GIT_SOURCE_MORPH_CLASS, gitSourceKind, type ApplicationSourceChanges, type DeployApplicationSourceRow, type DeployGitSourceRow, type GitSourceKind } from "@saas/db/deploy";
import { blank, length, type FieldErrors } from "../private-keys/validation.js";
import { LARAVEL } from "../servers/settings-validation.js";
import { parseUrl } from "./domains.js";
import { gitBranchError, gitRepositoryUrlError, parseScpStyleGitUrl, phpTrim, sshGitUrlToHttps } from "./git.js";
import {
  GIT_PINNED_HOST_KEYS,
  hostsWithPublishedKeys,
  isValidKnownHostsLine,
  knownHostFingerprint,
  knownHostsLineHosts,
  knownHostsLines,
  lineHasHostWithPublishedKeys,
  lineId,
  normalizedLines,
  pinnedHosts,
} from "./host-keys.js";
import type { ApplicationShow } from "./service.js";
import { SettingsError, SettingsFieldErrors } from "./settings.js";
import { needsExecutor, text } from "./resources.js";
import { loadApplication, type ApplicationMoreContext, type LoadedApplication } from "./more.js";

type Body = Record<string, unknown>;

export const SOURCE_MESSAGES = {
  /** submit(): ValidationException::withMessages */
  knownHostsLine: 'Each line must be "host key-type key" (for example "[git.example.com]:2222 ssh-ed25519 AAAA..."). Hashed hosts and comments are not supported.',
  httpsPasswordMissing: "Enter the password or token for this username.",
  /** "Coolify always uses the published host keys of …": Freeploy's name. */
  publishedHosts: () => `Freeploy always uses the published host keys of ${hostsWithPublishedKeys().join(", ")}. Remove the lines of these hosts.`,
  /** dispatch('success' | 'error', …) */
  updated: "Application source updated!",
  hostKeyRemoved: "Host key removed.",
  credentialsRemoved: "HTTPS credentials removed.",
  privateKeyUpdated: "Private key updated!",
  sourceUpdated: "Source updated!",
  notSsh: "The repository does not use SSH.",
  /** Freeploy's: what is not there yet. */
  fetchUnavailable: needsExecutor("Reading the host keys of the Git host"),
  repositoryIdUnavailable: "Reading the repository's id from the Git provider needs the Git App connection, which is not available yet.",
} as const;

/** #[Validate(['nullable', 'string', 'regex:…'])] on gitCommitSha. */
const COMMIT_SHA_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/]*$/;

/** The application's source as the model's `source` relation gives it: a row of the org, the public GitHub source, or none. */
export interface ResolvedSource {
  kind: GitSourceKind;
  id: string;
  name: string;
  htmlUrl: string;
  isPublic: boolean;
  account: string | null;
  customUser: string;
  customPort: number;
}

const resolved = (s: DeployGitSourceRow): ResolvedSource => ({
  kind: s.kind,
  id: String(s.id),
  name: s.name,
  htmlUrl: s.html_url,
  isPublic: Boolean(s.is_public),
  account: s.account ?? null,
  customUser: s.custom_user ?? "git",
  customPort: Number(s.custom_port ?? 22),
});

/** $application->source: source_id 0 with GithubApp's morph class is the public GitHub source (DP-54). */
export async function resolveSource(ctx: ApplicationMoreContext, row: Pick<DeployApplicationSourceRow, "source_id" | "source_type">): Promise<ResolvedSource | null> {
  const kind = gitSourceKind(row.source_type);
  if (kind === null || row.source_id === null || row.source_id === undefined) return null;
  if (kind === "github" && String(row.source_id) === String(PUBLIC_GITHUB_SOURCE.id)) {
    return { kind, id: "0", name: PUBLIC_GITHUB_SOURCE.name, htmlUrl: PUBLIC_GITHUB_SOURCE.htmlUrl, isPublic: true, account: null, customUser: "git", customPort: 22 };
  }
  const found = await ctx.store.findGitSource(kind, row.source_id);
  return found ? resolved(found) : null;
}

export type DeploymentType = "deploy_key" | "source" | "other";

/** Application::deploymentType(): a real key first, then a source, then the localhost key (id 0). */
export function deploymentType(privateKeyId: string | number | null, source: ResolvedSource | null): DeploymentType {
  const key = privateKeyId === null || privateKeyId === undefined ? null : Number(privateKeyId);
  if (key !== null && key > 0) return "deploy_key";
  if (source) return "source";
  if (key === 0) return "deploy_key";
  return "other";
}

/** convertGitUrl(): the repository git clones and the SSH port, by deployment type. */
export function convertGitUrl(gitRepository: string, type: DeploymentType, source: ResolvedSource | null): { repository: string; port: string | number } {
  let repository = gitRepository;
  let port: string | number = 22;
  // preg_match('/((.*?)\:\/\/)?(.*@.*:.*)/'): whether it reads as an SSH repository.
  const looksSsh = /((.*?):\/\/)?(.*@.*:.*)/.test(gitRepository);
  if (type === "deploy_key" && !looksSsh && source) {
    // An HTTP URL where an SSH one is needed: rewritten for the source's host.
    const host = parseUrl(source.htmlUrl)?.host ?? "";
    port = source.customPort;
    if (host !== "") {
      repository = source.customPort === 22 ? `${source.customUser}@${host}:${gitRepository}` : `ssh://${source.customUser}@${host}:${source.customPort}/${gitRepository}`;
    }
  }
  if (repository.includes("://")) {
    const parsed = parseUrl(repository);
    if (parsed?.port !== undefined && parsed.port !== null && String(parsed.port) !== "") port = String(parsed.port);
  } else {
    const scp = parseScpStyleGitUrl(repository);
    if (scp !== null && scp.port !== null) {
      port = scp.port;
      repository = `${scp.user}@${scp.host}:${scp.path}`;
    }
  }
  return { repository, port };
}

/** Application::gitSshHost(): the host and port git connects to over SSH, or null when the repository does not use SSH. */
export function gitSshHost(gitRepository: string, type: DeploymentType, source: ResolvedSource | null): { host: string; port: number } | null {
  const converted = convertGitUrl(gitRepository, type, source);
  let host: string | null | undefined;
  if (converted.repository.includes("://")) {
    const url = parseUrl(converted.repository);
    if (url?.scheme !== "ssh") return null;
    host = url.host;
  } else {
    host = parseScpStyleGitUrl(converted.repository)?.host;
  }
  const port = type === "source" && source ? source.customPort : converted.port;
  const bare = (host ?? "").replace(/^[[\]]+|[[\]]+$/g, "");
  if (!/^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/.test(bare) || !/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(String(port))) return null;
  return { host: bare, port: Math.trunc(Number(port)) };
}

const withoutGitSuffix = (value: string): string => (value.endsWith(".git") ? value.slice(0, -4) : value);
const httpScheme = (value: string | null): boolean => typeof value === "string" && ["http", "https"].includes(parseUrl(value)?.scheme ?? "");

/** httpsUrlFromSshGitRepository() */
function httpsFromSsh(gitRepository: string | null): string | null {
  const https = sshGitUrlToHttps(gitRepository);
  return typeof https === "string" ? withoutGitSuffix(https) : null;
}

/** sourceRepositoryUrl(): the repository's page at its provider. */
function sourceRepositoryUrl(gitRepository: string, source: ResolvedSource): string {
  const https = httpsFromSsh(gitRepository);
  if (https !== null) return https;
  // Url::fromString(Str::replaceEnd('.git', '', …))->withUserInfo('')
  if (httpScheme(gitRepository)) return withoutGitSuffix(gitRepository).replace(/^(https?:\/\/)[^/@]*@/, "$1");
  return `${source.htmlUrl}/${gitRepository}`;
}

export interface GitLinks {
  /** gitBranchLocation: the "Repository" button. */
  branch: string | null;
  /** gitCommits: the "Commits" button. */
  commits: string | null;
  /** gitWebhook: the "Repository settings" button of the Webhooks page. */
  webhook: string | null;
}

/** Application's gitBranchLocation, gitCommits and gitWebhook attributes. */
export function gitLinks(row: Pick<DeployApplicationSourceRow, "git_repository" | "git_branch" | "base_directory">, source: ResolvedSource | null): GitLinks {
  const repository = row.git_repository;
  const branch = row.git_branch;
  const baseDirectory = row.base_directory ?? "/";
  const plain = httpScheme(repository) ? repository : null;
  if (source && repository !== null && branch !== null) {
    const url = sourceRepositoryUrl(repository, source);
    const tree = source.kind === "gitea" ? `${url}/src/branch/${branch}${baseDirectory}` : repository.includes("bitbucket") ? `${url}/src/${branch}${baseDirectory}` : `${url}/tree/${branch}${baseDirectory}`;
    return { branch: tree, commits: source.kind === "gitea" ? `${url}/commits/branch/${branch}` : `${url}/commits/${branch}`, webhook: `${url}/settings/hooks` };
  }
  const https = httpsFromSsh(repository);
  if (https !== null) {
    return { branch: (repository ?? "").includes("bitbucket") ? `${https}/src/${branch}${baseDirectory}` : `${https}/tree/${branch}${baseDirectory}`, commits: `${https}/commits/${branch}`, webhook: `${https}/settings/hooks` };
  }
  return { branch: plain, commits: plain, webhook: plain };
}

export interface SourceOption {
  id: string;
  kind: GitSourceKind;
  /** getMorphClass(): what changeSource() is called with. */
  type: string;
  name: string;
  subtitle: string;
}

/** The view's $sourceSubtitle / $currentSourceSubtitle. */
export function sourceSubtitle(source: Pick<ResolvedSource, "kind" | "account" | "isPublic">): string {
  if (source.kind === "github") return source.account ? `GitHub · ${source.account}` : source.isPublic ? "Public GitHub" : "GitHub · Personal account";
  if (source.kind === "gitlab") return source.account ? `GitLab · ${source.account}` : "GitLab · Personal account";
  return source.account ? `Gitea · ${source.account}` : "Gitea · Personal account";
}

const option = (s: ResolvedSource): SourceOption => ({ id: s.id, kind: s.kind, type: GIT_SOURCE_MORPH_CLASS[s.kind], name: s.name, subtitle: sourceSubtitle(s) });

export interface HostKey {
  /** sha1 of the line, or "published-" + it for a provider's key. */
  id: string;
  published: boolean;
  host: string;
  type: string;
  fingerprint: string;
}

export interface SourcePage {
  application: ApplicationShow;
  source: {
    gitRepository: string;
    gitBranch: string;
    gitCommitSha: string | null;
    /** The "Repository" and "Commits" buttons (null: not shown). */
    gitBranchLocation: string | null;
    gitCommits: string | null;
    deploymentType: DeploymentType;
    /** $application->gitSshHost() !== null */
    usesGitSsh: boolean;
    gitSshKnownHosts: string | null;
    /** The providers' published keys of the repository's host, then the saved keys. */
    hostKeys: HostKey[];
    gitHttpsUsername: string | null;
    /** The saved password or token is never sent. */
    hasGitHttpsPassword: boolean;
    privateKeyId: string | null;
    privateKeyName: string | null;
    /** The org's other private keys (empty for who may not update). */
    privateKeys: Array<{ id: string; name: string }>;
    currentSource: SourceOption | null;
    /** The org's other usable Git sources, by name (empty for who may not update). */
    sources: SourceOption[];
  };
}

async function hostKeys(row: DeployApplicationSourceRow, sshHost: { host: string } | null): Promise<HostKey[]> {
  const keys: HostKey[] = [];
  // publishedHostKeyFingerprints(): the pinned keys of GitHub, GitLab.com or Bitbucket Cloud.
  const host = (sshHost?.host ?? "").toLowerCase();
  if (pinnedHosts().includes(host)) {
    for (const line of GIT_PINNED_HOST_KEYS.filter((l) => knownHostsLineHosts(l).includes(host))) {
      keys.push({ id: `published-${await lineId(line)}`, published: true, ...(await knownHostFingerprint(line)), host });
    }
  }
  // knownHostFingerprints()
  for (const line of knownHostsLines(row.git_ssh_known_hosts)) keys.push({ id: await lineId(line), published: false, ...(await knownHostFingerprint(line)) });
  return keys;
}

async function page(ctx: ApplicationMoreContext, l: LoadedApplication, row: DeployApplicationSourceRow, canUpdate: boolean): Promise<SourcePage> {
  const source = await resolveSource(ctx, row);
  const type = deploymentType(row.private_key_id, source);
  const sshHost = gitSshHost(row.git_repository ?? "", type, source);
  const links = gitLinks(row, source);
  // canUseTeamCredentials(): other keys and sources only for who may write.
  const keys = canUpdate ? (await ctx.store.deployKeys()).filter((k) => String(k.id) !== String(row.private_key_id)) : [];
  const sources = canUpdate
    ? (await ctx.store.gitSources())
        .filter((s) => !(source && s.kind === source.kind && String(s.id) === source.id) && Boolean(s.usable))
        .map(resolved)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    : [];
  return {
    application: l.application,
    source: {
      gitRepository: row.git_repository ?? "",
      gitBranch: row.git_branch ?? "",
      gitCommitSha: row.git_commit_sha ?? null,
      gitBranchLocation: links.branch,
      gitCommits: links.commits,
      deploymentType: type,
      usesGitSsh: sshHost !== null,
      gitSshKnownHosts: row.git_ssh_known_hosts ?? null,
      hostKeys: await hostKeys(row, sshHost),
      gitHttpsUsername: row.git_https_username ?? null,
      hasGitHttpsPassword: !blank(row.git_https_password),
      privateKeyId: row.private_key_id === null ? null : String(row.private_key_id),
      privateKeyName: row.private_key_name ?? null,
      privateKeys: keys.map((k) => ({ id: String(k.id), name: k.name })),
      currentSource: source ? option(source) : null,
      sources: sources.map(option),
    },
  };
}

async function load(ctx: ApplicationMoreContext, uuid: string, canUpdate: boolean): Promise<{ l: LoadedApplication; row: DeployApplicationSourceRow } | null> {
  const l = await loadApplication(ctx, uuid, canUpdate);
  const row = l ? await ctx.store.source(uuid) : null;
  return l && row ? { l, row } : null;
}

/** Source::mount() */
export async function showSource(ctx: ApplicationMoreContext, uuid: string, canUpdate: boolean): Promise<SourcePage | null> {
  const found = await load(ctx, uuid, canUpdate);
  return found ? page(ctx, found.l, found.row, canUpdate) : null;
}

export interface SourceSaved extends SourcePage {
  message: string;
  /** What could not run after the rows were stored. */
  unavailable?: string;
}

async function saved(ctx: ApplicationMoreContext, uuid: string, message: string, unavailable?: string): Promise<SourceSaved | null> {
  const shown = await showSource(ctx, uuid, true);
  return shown && { ...shown, message, ...(unavailable ? { unavailable } : {}) };
}

/** A nullable string field with a maximum and a pattern, as Laravel reports it. */
function stringRule(errors: FieldErrors, property: string, value: unknown, max: number, pattern: RegExp | null): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    errors[property] = [LARAVEL.string(property)];
    return null;
  }
  if (length(value) > max) errors[property] = [LARAVEL.maxString(property, max)];
  else if (pattern && !pattern.test(value)) errors[property] = [LARAVEL.regex(property)];
  return value;
}

/**
 * Source::submit(): the known hosts and the credentials are checked first
 * (each its own ValidationException), then syncData(true) validates every
 * field, and the repository's own rule runs only when it changed. The host
 * keys are written only when they differ from what the form was loaded with
 * (`loadedGitSshKnownHosts`; the stored text when the form does not send it),
 * the credentials only with a new password or beside a saved one.
 */
export async function saveSource(ctx: ApplicationMoreContext, uuid: string, body: Body): Promise<SourceSaved | null> {
  const found = await load(ctx, uuid, true);
  if (!found) return null;
  const { row } = found;
  // updatedGitRepository() and its siblings: trim().
  const trimmed = (v: unknown): unknown => (typeof text(v) === "string" ? phpTrim(text(v) as string) : v);
  const gitRepository = trimmed(body.gitRepository);
  const gitBranch = trimmed(body.gitBranch);
  let gitCommitSha = trimmed(body.gitCommitSha);
  // str($this->gitCommitSha)->isEmpty()
  if (gitCommitSha === null || gitCommitSha === undefined || gitCommitSha === "") gitCommitSha = "HEAD";
  const knownHosts = body.gitSshKnownHosts === undefined ? row.git_ssh_known_hosts : body.gitSshKnownHosts;
  const loadedKnownHosts = typeof body.loadedGitSshKnownHosts === "string" ? body.loadedGitSshKnownHosts : body.loadedGitSshKnownHosts === null ? null : row.git_ssh_known_hosts;
  const username = body.gitHttpsUsername === undefined ? row.git_https_username : body.gitHttpsUsername;
  const password = body.gitHttpsPassword;
  const hasPassword = !blank(row.git_https_password);

  const lines = normalizedLines(typeof knownHosts === "string" ? knownHosts : "").filter((line) => line !== "");
  if (lines.some((line) => !isValidKnownHostsLine(line))) throw new SettingsFieldErrors({ gitSshKnownHosts: [SOURCE_MESSAGES.knownHostsLine] });
  if (!blank(username) && blank(password) && !hasPassword) throw new SettingsFieldErrors({ gitHttpsPassword: [SOURCE_MESSAGES.httpsPasswordMissing] });
  const loadedLines = normalizedLines(loadedKnownHosts);
  if (lines.some((line) => lineHasHostWithPublishedKeys(line) && !loadedLines.includes(line))) throw new SettingsFieldErrors({ gitSshKnownHosts: [SOURCE_MESSAGES.publishedHosts()] });

  // $this->validate()
  const errors: FieldErrors = {};
  if (blank(gitRepository)) errors.gitRepository = [LARAVEL.required("gitRepository")];
  else if (typeof gitRepository !== "string") errors.gitRepository = [LARAVEL.string("gitRepository")];
  if (blank(gitBranch)) errors.gitBranch = [LARAVEL.required("gitBranch")];
  else if (typeof gitBranch !== "string") errors.gitBranch = [LARAVEL.string("gitBranch")];
  else {
    const refused = gitBranchError("git branch", gitBranch);
    if (refused) errors.gitBranch = [refused];
  }
  stringRule(errors, "gitCommitSha", gitCommitSha, Infinity, COMMIT_SHA_RE);
  stringRule(errors, "gitSshKnownHosts", knownHosts, 65535, null);
  stringRule(errors, "gitHttpsUsername", username, 255, /^[^:\r\n]*$/);
  stringRule(errors, "gitHttpsPassword", password, 2048, /^[^\r\n]*$/);
  if (Object.keys(errors).length) throw new SettingsFieldErrors(errors);
  // Only a changed repository meets ValidGitRepositoryUrl(allowRepositoryPath: true).
  if (gitRepository !== row.git_repository) {
    const refused = gitRepositoryUrlError("git repository", gitRepository, true);
    if (refused) throw new SettingsFieldErrors({ gitRepository: [refused] });
  }

  const changes: ApplicationSourceChanges = { git_repository: gitRepository as string, git_branch: gitBranch as string, git_commit_sha: gitCommitSha as string };
  const next = knownHostsLines(typeof knownHosts === "string" ? knownHosts : "");
  const loaded = knownHostsLines(loadedKnownHosts);
  if (next.length !== loaded.length || next.some((line, i) => line !== loaded[i])) changes.git_ssh_known_hosts = next.join("\n") || null;
  const usernameValue = blank(username) ? null : (username as string);
  if (!blank(password)) {
    changes.git_https_username = usernameValue;
    changes.git_https_password = await ctx.secret("git_https_password").encrypt(password as string);
  } else if (hasPassword) {
    changes.git_https_username = usernameValue;
  }
  await ctx.store.updateSource(row.id, changes);
  return saved(ctx, uuid, SOURCE_MESSAGES.updated);
}

/** Source::removeHostKey(): the saved line with this id goes; the next deployment saves the key the host sends then. */
export async function removeHostKey(ctx: ApplicationMoreContext, uuid: string, id: string): Promise<SourceSaved | null> {
  const found = await load(ctx, uuid, true);
  if (!found) return null;
  const kept: string[] = [];
  for (const line of knownHostsLines(found.row.git_ssh_known_hosts)) if ((await lineId(line)) !== id) kept.push(line);
  await ctx.store.updateSource(found.row.id, { git_ssh_known_hosts: kept.join("\n") || null });
  return saved(ctx, uuid, SOURCE_MESSAGES.hostKeyRemoved);
}

/**
 * Source::fetchHostKeys(): a repository that does not use SSH and has no
 * saved keys is refused as Coolify refuses it; reading the keys runs
 * ssh-keyscan from a server, which needs the SSH executor.
 */
export async function fetchHostKeys(ctx: ApplicationMoreContext, uuid: string): Promise<null> {
  const found = await load(ctx, uuid, true);
  if (!found) return null;
  const source = await resolveSource(ctx, found.row);
  const sshHost = gitSshHost(found.row.git_repository ?? "", deploymentType(found.row.private_key_id, source), source);
  if (sshHost === null && knownHostsLines(found.row.git_ssh_known_hosts).length === 0) throw new SettingsError(SOURCE_MESSAGES.notSsh, 422);
  throw new SettingsError(SOURCE_MESSAGES.fetchUnavailable, 501);
}

/** Source::removeGitHttpsCredential() */
export async function removeHttpsCredentials(ctx: ApplicationMoreContext, uuid: string): Promise<SourceSaved | null> {
  const found = await load(ctx, uuid, true);
  if (!found) return null;
  await ctx.store.updateSource(found.row.id, { git_https_username: null, git_https_password: null });
  return saved(ctx, uuid, SOURCE_MESSAGES.credentialsRemoved);
}

/**
 * Source::setPrivateKey(): another of the org's keys becomes the deploy key.
 * Coolify saves the form's other fields with it (syncData(true)); here only
 * the key changes. Null when the application or the key is not the org's.
 */
export async function setPrivateKey(ctx: ApplicationMoreContext, uuid: string, body: Body): Promise<SourceSaved | null> {
  const found = await load(ctx, uuid, true);
  const id = text(body.privateKeyId);
  const key = found && typeof id === "string" && /^\d{1,18}$/.test(id) ? await ctx.store.findDeployKey(id) : null;
  if (!found || !key) return null;
  await ctx.store.updateSource(found.row.id, { private_key_id: key.id });
  return saved(ctx, uuid, SOURCE_MESSAGES.privateKeyUpdated);
}

/**
 * Source::changeSource(): the source's id and type are stored first, as in
 * Coolify; the repository's id is then asked of the provider with the App's
 * credentials, which do not exist before DP6 — the answer says so.
 * Null when the application, the type or the source is not the org's.
 */
export async function changeSource(ctx: ApplicationMoreContext, uuid: string, body: Body): Promise<SourceSaved | null> {
  const found = await load(ctx, uuid, true);
  const kind = gitSourceKind(typeof body.sourceType === "string" ? body.sourceType : null);
  const id = text(body.sourceId);
  // abort_unless(in_array($sourceType, $allowedSourceTypes, true), 404); findOrFail($sourceId)
  const source = found && kind && typeof id === "string" && /^\d{1,18}$/.test(id) ? await ctx.store.findGitSource(kind, id) : null;
  if (!found || !kind || !source) return null;
  await ctx.store.updateSource(found.row.id, { source_id: source.id, source_type: GIT_SOURCE_MORPH_CLASS[kind] });
  return saved(ctx, uuid, SOURCE_MESSAGES.sourceUpdated, SOURCE_MESSAGES.repositoryIdUnavailable);
}
