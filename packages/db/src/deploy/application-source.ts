// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/Source.php,
// app/Livewire/Project/Shared/Webhooks.php, app/Models/Application.php (source, private_key, the
// Git columns and the manual webhook secrets) and app/Models/Team.php (sources) (Apache-2.0), modified.
//
// What an application's Git Source and Webhooks pages read and write: the Git
// columns of deploy.applications, the org's private keys by name, and the
// org's Git sources (deploy.github_apps, gitlab_apps, gitea_apps). Every
// function takes the transaction of withOrg(): row-level security confines
// each query to that org, which is what Coolify's where('team_id', …) does.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { APPLICATION_WEBHOOK_SECRET_COLUMNS, type ApplicationWebhookSecretColumn } from "./applications.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** getMorphClass() of the three Git sources. */
export const GIT_SOURCE_MORPH_CLASS = {
  github: "App\\Models\\GithubApp",
  gitlab: "App\\Models\\GitlabApp",
  gitea: "App\\Models\\GiteaApp",
} as const;
export type GitSourceKind = keyof typeof GIT_SOURCE_MORPH_CLASS;
export const GIT_SOURCE_KINDS = Object.keys(GIT_SOURCE_MORPH_CLASS) as GitSourceKind[];

const TABLE: Record<GitSourceKind, string> = { github: "github_apps", gitlab: "gitlab_apps", gitea: "gitea_apps" };

/** The kind of a stored source_type, or null. */
export function gitSourceKind(morphClass: string | null | undefined): GitSourceKind | null {
  return GIT_SOURCE_KINDS.find((k) => GIT_SOURCE_MORPH_CLASS[k] === morphClass) ?? null;
}

/** The Git columns of an application, as the Source and Webhooks pages read them. */
export interface DeployApplicationSourceRow extends SqlRow {
  id: string | number;
  uuid: string;
  build_pack: string;
  /** Whether the application has a Dockerfile of its own (git_based() is then false). */
  has_dockerfile: boolean;
  git_repository: string | null;
  git_branch: string | null;
  git_commit_sha: string | null;
  base_directory: string | null;
  repository_project_id: string | number | null;
  source_id: string | number | null;
  source_type: string | null;
  private_key_id: string | number | null;
  /** $application->private_key->name (null when the key is gone). */
  private_key_name: string | null;
  git_https_username: string | null;
  /** An `encrypted` cast: the stored ciphertext. */
  git_https_password: string | null;
  git_ssh_known_hosts: string | null;
  /** The four `encrypted` manual webhook secrets, as stored. */
  manual_webhook_secret_github: string | null;
  manual_webhook_secret_gitlab: string | null;
  manual_webhook_secret_bitbucket: string | null;
  manual_webhook_secret_gitea: string | null;
}

/** $application with private_key, the columns of Source and Webhooks. */
export async function findApplicationSource(tx: SqlExecutor, uuid: string): Promise<DeployApplicationSourceRow | null> {
  const r = await tx.execute<DeployApplicationSourceRow>(
    `SELECT a.id, a.uuid, a.build_pack, (a.dockerfile IS NOT NULL AND a.dockerfile <> '') AS has_dockerfile,
            a.git_repository, a.git_branch, a.git_commit_sha, a.base_directory, a.repository_project_id,
            a.source_id, a.source_type, a.private_key_id, k.name AS private_key_name,
            a.git_https_username, a.git_https_password, a.git_ssh_known_hosts,
            ${APPLICATION_WEBHOOK_SECRET_COLUMNS.map((c) => `a."${c}"`).join(", ")}
       FROM deploy.applications a
       LEFT JOIN deploy.private_keys k ON k.id = a.private_key_id
      WHERE a.uuid = $1 AND a.deleted_at IS NULL`,
    [uuid],
  );
  return r.rows[0] ?? null;
}

/** The columns Source and Webhooks write. */
export const APPLICATION_SOURCE_COLUMNS = [
  "git_repository",
  "git_branch",
  "git_commit_sha",
  "private_key_id",
  "git_ssh_known_hosts",
  "git_https_username",
  "git_https_password",
  "source_id",
  "source_type",
  "repository_project_id",
  ...APPLICATION_WEBHOOK_SECRET_COLUMNS,
] as const;
export type ApplicationSourceColumn = (typeof APPLICATION_SOURCE_COLUMNS)[number];
export type ApplicationSourceChanges = Partial<Record<ApplicationSourceColumn, string | number | null>>;

/** $application->save() / update([...]): only the given columns, and updated_at. False when the application is gone. */
export async function updateApplicationSource(tx: SqlExecutor, id: string | number, changes: ApplicationSourceChanges): Promise<boolean> {
  const columns = APPLICATION_SOURCE_COLUMNS.filter((c) => changes[c] !== undefined);
  if (!columns.length) return true;
  const sets = columns.map((c, i) => `"${c}" = $${i + 2}`);
  const r = await tx.execute<{ id: string | number }>(
    `UPDATE deploy.applications SET ${[...sets, `updated_at = ${NOW}`].join(", ")} WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [id, ...columns.map((c) => changes[c] ?? null)],
  );
  return r.rows.length > 0;
}

/** The manual webhook secret columns by provider (Webhooks::SECRET_FIELDS). */
export const WEBHOOK_SECRET_COLUMN: Record<"github" | "gitlab" | "bitbucket" | "gitea", ApplicationWebhookSecretColumn> = {
  github: "manual_webhook_secret_github",
  gitlab: "manual_webhook_secret_gitlab",
  bitbucket: "manual_webhook_secret_bitbucket",
  gitea: "manual_webhook_secret_gitea",
};

/** PrivateKey::where('team_id', …)->get(), the columns the Deploy key list shows. */
export async function listDeployKeys(tx: SqlExecutor): Promise<Array<{ id: string | number; uuid: string; name: string }>> {
  const r = await tx.execute<{ id: string | number; uuid: string; name: string }>("SELECT id, uuid, name FROM deploy.private_keys ORDER BY id");
  return r.rows;
}

/** PrivateKey::where('team_id', …)->findOrFail($id) */
export async function findDeployKey(tx: SqlExecutor, id: string | number): Promise<{ id: string | number; uuid: string; name: string } | null> {
  const r = await tx.execute<{ id: string | number; uuid: string; name: string }>("SELECT id, uuid, name FROM deploy.private_keys WHERE id = $1", [id]);
  return r.rows[0] ?? null;
}

/** One of the org's Git sources, with what the Source page shows and filters by. */
export interface DeployGitSourceRow extends SqlRow {
  kind: GitSourceKind;
  id: string | number;
  uuid: string;
  name: string;
  html_url: string;
  api_url: string;
  is_public: boolean;
  /** GithubApp::accountName(): installation_account, else the organization; GitLab's group_name; Gitea's organization. */
  account: string | null;
  /** GithubApp: app_id is set. GitlabApp / GiteaApp: isConnected() (an access and a refresh token). */
  usable: boolean;
  /** The SSH user and port of the provider (git, 22 unless changed). */
  custom_user: string;
  custom_port: number;
}

const SOURCE_COLUMNS = "id, uuid, name, html_url, api_url, is_public, custom_user, custom_port";
const SOURCE_SELECT: Record<GitSourceKind, string> = {
  github: `SELECT 'github' AS kind, ${SOURCE_COLUMNS}, COALESCE(NULLIF(installation_account, ''), NULLIF(organization, '')) AS account, (app_id IS NOT NULL) AS usable FROM deploy.github_apps`,
  gitlab: `SELECT 'gitlab' AS kind, ${SOURCE_COLUMNS}, NULLIF(group_name, '') AS account,
                  (COALESCE(access_token, '') <> '' AND COALESCE(refresh_token, '') <> '') AS usable FROM deploy.gitlab_apps`,
  gitea: `SELECT 'gitea' AS kind, ${SOURCE_COLUMNS}, NULLIF(organization, '') AS account,
                 (COALESCE(access_token, '') <> '' AND COALESCE(refresh_token, '') <> '') AS usable FROM deploy.gitea_apps`,
};

/**
 * Team::sources(): the org's GitHub, GitLab and Gitea Apps that are not
 * public, GitHub's first. Coolify also lists the instance's `is_system_wide`
 * sources; a row here belongs to one org, so there are none.
 */
export async function listGitSources(tx: SqlExecutor): Promise<DeployGitSourceRow[]> {
  const rows: DeployGitSourceRow[] = [];
  for (const kind of GIT_SOURCE_KINDS) {
    const r = await tx.execute<DeployGitSourceRow>(`${SOURCE_SELECT[kind]} WHERE is_public = false ORDER BY id`);
    rows.push(...r.rows);
  }
  return rows;
}

/** $sourceType::query()->where('team_id', …)->find($id): the source whatever is_public says (the application's own source). */
export async function findGitSource(tx: SqlExecutor, kind: GitSourceKind, id: string | number): Promise<DeployGitSourceRow | null> {
  const r = await tx.execute<DeployGitSourceRow>(`${SOURCE_SELECT[kind]} WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

/** The table of a kind (for tests and fixtures). */
export const gitSourceTable = (kind: GitSourceKind): string => `deploy.${TABLE[kind]}`;
