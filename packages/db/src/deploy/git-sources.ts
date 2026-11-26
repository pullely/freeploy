// Derived from coollabsio/coolify@91b7e3e:app/Models/{GithubApp,GitlabApp,GiteaApp,Team,ApplicationPreview}.php,
// app/Livewire/Source/Github/{Create,Change}.php, app/Http/Controllers/Webhook/{Github,Concerns/
// MatchesManualWebhookApplications}.php, app/Jobs/ProcessGithubPullRequestWebhook.php and
// app/Livewire/Project/New/GithubPrivateRepository.php (Apache-2.0), modified.
//
// The SQL of Git sources (freeploy-coolify-parity DP-72): deploy.github_apps rows, the org's sources for the
// Sources page, the App's private key, the applications a source serves, and what the Git webhooks read and
// write — the applications a delivery matches, their previews, a skipped deployment. Every function takes the
// transaction of withOrg(), so row-level security confines it to one org, except the two `…Targets`
// functions: a webhook reaches Freeploy without an org (GitHub names the App, a manual webhook the
// repository), so they run under asPlatformAdmin() and answer only which org and which row ids match —
// nothing else of any row — and everything after them runs inside that org's withOrg(). The secrets
// (client_secret, webhook_secret, the manual webhook secrets, the private key) are fp1 ciphertexts here;
// these functions never decrypt.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { DESTINATION_MORPH_CLASS } from "./destinations.js";

const NOW = "date_trunc('second', timezone('UTC', now()))";
const STANDALONE = DESTINATION_MORPH_CLASS.standalone.replace(/\\/g, "\\\\");
const SWARM = DESTINATION_MORPH_CLASS.swarm.replace(/\\/g, "\\\\");
/** GithubApp's morph class, as applications.source_type stores it. */
export const GITHUB_APP_MORPH_CLASS = "App\\Models\\GithubApp";
const GITHUB_MORPH = GITHUB_APP_MORPH_CLASS.replace(/\\/g, "\\\\");

// ── github_apps ─────────────────────────────────────────────────────────────────────────────────────────

export interface DeployGithubAppRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  organization: string | null;
  api_url: string;
  html_url: string;
  custom_user: string;
  custom_port: number;
  app_id: number | null;
  installation_id: number | null;
  installation_account: string | null;
  client_id: string | null;
  /** fp1 ciphertexts (encrypted casts). */
  client_secret: string | null;
  webhook_secret: string | null;
  is_system_wide: boolean;
  is_public: boolean;
  private_key_id: string | number | null;
  contents: string | null;
  metadata: string | null;
  pull_requests: string | null;
  administration: string | null;
  deployments: string | null;
  organization_self_hosted_runners: string | null;
  actions: string | null;
  webhook_events: unknown;
  runner_group_id: string | number | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

const APP_COLUMNS = [
  "id",
  "uuid",
  "name",
  "organization",
  "api_url",
  "html_url",
  "custom_user",
  "custom_port",
  "app_id",
  "installation_id",
  "installation_account",
  "client_id",
  "client_secret",
  "webhook_secret",
  "is_system_wide",
  "is_public",
  "private_key_id",
  "contents",
  "metadata",
  "pull_requests",
  "administration",
  "deployments",
  "organization_self_hosted_runners",
  "actions",
  "webhook_events",
  "runner_group_id",
  "created_at",
  "updated_at",
].join(", ");

/** The columns a GitHub App's pages and flows write. */
export const GITHUB_APP_WRITABLE = [
  "name",
  "organization",
  "api_url",
  "html_url",
  "custom_user",
  "custom_port",
  "app_id",
  "installation_id",
  "installation_account",
  "client_id",
  "client_secret",
  "webhook_secret",
  "is_system_wide",
  "private_key_id",
  "contents",
  "metadata",
  "pull_requests",
  "administration",
  "deployments",
  "organization_self_hosted_runners",
  "actions",
  "webhook_events",
] as const;
export type GithubAppColumn = (typeof GITHUB_APP_WRITABLE)[number];
export type GithubAppChanges = Partial<Record<GithubAppColumn, string | number | boolean | null>>;

export interface NewGithubApp {
  orgId: string;
  uuid: string;
  name: string;
  organization: string | null;
  apiUrl: string;
  htmlUrl: string;
  customUser: string;
  customPort: number;
  isSystemWide: boolean;
}

/** GithubApp::create($payload) of Create::createGitHubApp(). */
export async function insertGithubApp(tx: SqlExecutor, app: NewGithubApp): Promise<DeployGithubAppRow> {
  const r = await tx.execute<DeployGithubAppRow>(
    `INSERT INTO deploy.github_apps (uuid, name, organization, api_url, html_url, custom_user, custom_port, is_system_wide, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${NOW}, ${NOW}) RETURNING ${APP_COLUMNS}`,
    [app.uuid, app.name, app.organization, app.apiUrl, app.htmlUrl, app.customUser, app.customPort, app.isSystemWide, app.orgId],
  );
  return r.rows[0]!;
}

/** $github_app->replicate([...]) of sourceForGithubInstallation(): the App's row without its installation, as a new source. */
export async function replicateGithubApp(tx: SqlExecutor, id: string | number, uuid: string): Promise<DeployGithubAppRow | null> {
  const copied = APP_COLUMNS.split(", ").filter((c) => !["id", "uuid", "installation_id", "installation_account", "deployments", "runner_group_id", "created_at", "updated_at"].includes(c));
  const r = await tx.execute<DeployGithubAppRow>(
    `INSERT INTO deploy.github_apps (uuid, ${copied.join(", ")}, org_id, created_at, updated_at)
     SELECT $2, ${copied.join(", ")}, org_id, ${NOW}, ${NOW} FROM deploy.github_apps WHERE id = $1 RETURNING ${APP_COLUMNS}`,
    [id, uuid],
  );
  return r.rows[0] ?? null;
}

/** GithubApp::ownedByCurrentTeam()->whereUuid($uuid)->first(): any of the org's, public or not. */
export async function findGithubAppByUuid(tx: SqlExecutor, uuid: string): Promise<DeployGithubAppRow | null> {
  const r = await tx.execute<DeployGithubAppRow>(`SELECT ${APP_COLUMNS} FROM deploy.github_apps WHERE uuid = $1`, [uuid]);
  return r.rows[0] ?? null;
}

export async function findGithubAppById(tx: SqlExecutor, id: string | number): Promise<DeployGithubAppRow | null> {
  const r = await tx.execute<DeployGithubAppRow>(`SELECT ${APP_COLUMNS} FROM deploy.github_apps WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

/** GithubPrivateRepository::mount(): the org's private GitHub Apps that are registered (app_id set), by id. */
export async function listRegisteredGithubApps(tx: SqlExecutor): Promise<DeployGithubAppRow[]> {
  const r = await tx.execute<DeployGithubAppRow>(`SELECT ${APP_COLUMNS} FROM deploy.github_apps WHERE is_public = false AND app_id IS NOT NULL ORDER BY id`);
  return r.rows;
}

/** sourceForGithubInstallation(): the org's source of the same App on the same host with this installation. */
export async function findGithubAppInstallation(tx: SqlExecutor, apiUrl: string, appId: number | string, installationId: number | string): Promise<DeployGithubAppRow | null> {
  const r = await tx.execute<DeployGithubAppRow>(`SELECT ${APP_COLUMNS} FROM deploy.github_apps WHERE api_url = $1 AND app_id = $2 AND installation_id = $3 ORDER BY id LIMIT 1`, [apiUrl, appId, installationId]);
  return r.rows[0] ?? null;
}

/** GithubApp::ownedByCurrentTeam()->where('installation_id', …)->first() (an installation's update). */
export async function findGithubAppByInstallationId(tx: SqlExecutor, installationId: number | string): Promise<DeployGithubAppRow | null> {
  const r = await tx.execute<DeployGithubAppRow>(`SELECT ${APP_COLUMNS} FROM deploy.github_apps WHERE installation_id = $1 ORDER BY id LIMIT 1`, [installationId]);
  return r.rows[0] ?? null;
}

/** $github_app->save() of the given columns; updated_at as Eloquent sets it. */
export async function updateGithubApp(tx: SqlExecutor, id: string | number, changes: GithubAppChanges): Promise<DeployGithubAppRow | null> {
  const columns = Object.keys(changes).filter((c): c is GithubAppColumn => (GITHUB_APP_WRITABLE as readonly string[]).includes(c));
  if (columns.length === 0) return findGithubAppById(tx, id);
  const sets = columns.map((c, i) => (c === "webhook_events" ? `${c} = $${i + 2}::json` : `${c} = $${i + 2}`));
  const r = await tx.execute<DeployGithubAppRow>(`UPDATE deploy.github_apps SET ${sets.join(", ")}, updated_at = ${NOW} WHERE id = $1 RETURNING ${APP_COLUMNS}`, [
    id,
    ...columns.map((c) => (c === "webhook_events" && changes[c] !== null && typeof changes[c] !== "string" ? JSON.stringify(changes[c]) : changes[c])),
  ]);
  return r.rows[0] ?? null;
}

export async function deleteGithubApp(tx: SqlExecutor, id: string | number): Promise<boolean> {
  const r = await tx.execute("DELETE FROM deploy.github_apps WHERE id = $1 RETURNING id", [id]);
  return r.rows.length > 0;
}

// ── The Sources page ────────────────────────────────────────────────────────────────────────────────────

export interface DeploySourceListRow extends SqlRow {
  kind: "github" | "gitlab" | "gitea";
  uuid: string;
  name: string;
  /** GithubApp::accountName() (installation_account, else the organization), GitlabApp's group_name, GiteaApp's organization. */
  account: string | null;
  /** isConnected(). */
  connected: boolean;
  html_url: string;
  /** A GitHub App with an App id (the private repository flow lists only these); GitLab and Gitea false. */
  registered: boolean;
}

/** Team::sources() as source/all.blade.php lists them: the GitHub Apps, then GitLab's, then Gitea's; never a public one. */
export async function listSourcesPage(tx: SqlExecutor): Promise<DeploySourceListRow[]> {
  const r = await tx.execute<DeploySourceListRow>(
    `SELECT kind, uuid, name, account, connected, html_url, registered FROM (
       SELECT 1 AS k, id, 'github' AS kind, uuid, name, COALESCE(NULLIF(installation_account, ''), NULLIF(btrim(organization, E'/ \\t\\n\\r'), '')) AS account,
              (app_id IS NOT NULL AND installation_id IS NOT NULL) AS connected, html_url, (app_id IS NOT NULL) AS registered FROM deploy.github_apps WHERE is_public = false
       UNION ALL
       SELECT 2, id, 'gitlab', uuid, name, group_name, (COALESCE(access_token, '') <> '' AND COALESCE(refresh_token, '') <> ''), html_url, false FROM deploy.gitlab_apps WHERE is_public = false
       UNION ALL
       SELECT 3, id, 'gitea', uuid, name, organization, (COALESCE(access_token, '') <> '' AND COALESCE(refresh_token, '') <> ''), html_url, false FROM deploy.gitea_apps WHERE is_public = false
     ) s ORDER BY k, id`,
  );
  return r.rows;
}

// ── The App's private key ───────────────────────────────────────────────────────────────────────────────

/** githubAppPrivateKey(): the App's key when it is the org's (row-level security makes another org's invisible). */
export async function findGithubAppPrivateKey(tx: SqlExecutor, privateKeyId: string | number | null): Promise<{ id: string | number; name: string; private_key: string } | null> {
  if (privateKeyId === null) return null;
  const r = await tx.execute<{ id: string | number; name: string; private_key: string }>("SELECT id, name, private_key FROM deploy.private_keys WHERE id = $1", [privateKeyId]);
  return r.rows[0] ?? null;
}

/** PrivateKey::ownedByCurrentTeamCached(): the listbox of the App's page. */
export async function listPrivateKeyChoices(tx: SqlExecutor): Promise<Array<{ id: string | number; uuid: string; name: string }>> {
  const r = await tx.execute<{ id: string | number; uuid: string; name: string }>("SELECT id, uuid, name FROM deploy.private_keys ORDER BY id");
  return r.rows;
}

/** $privateKey->name = "github-app-{$slug}"; $privateKey->save() (syncGithubAppName). */
export async function renamePrivateKey(tx: SqlExecutor, id: string | number, name: string): Promise<void> {
  await tx.execute(`UPDATE deploy.private_keys SET name = $2, updated_at = ${NOW} WHERE id = $1`, [id, name]);
}

/**
 * The deleting hook's check: is the key used by anything but this App — a server, an application, another
 * GitHub App, a GitLab or Gitea App?
 */
export async function privateKeyUsedOutsideGithubApp(tx: SqlExecutor, privateKeyId: string | number, githubAppId: string | number): Promise<boolean> {
  const r = await tx.execute<{ used: boolean }>(
    `SELECT (EXISTS (SELECT 1 FROM deploy.servers WHERE private_key_id = $1)
          OR EXISTS (SELECT 1 FROM deploy.applications WHERE private_key_id = $1)
          OR EXISTS (SELECT 1 FROM deploy.github_apps WHERE private_key_id = $1 AND id <> $2)
          OR EXISTS (SELECT 1 FROM deploy.gitlab_apps WHERE private_key_id = $1)
          OR EXISTS (SELECT 1 FROM deploy.gitea_apps WHERE private_key_id = $1)) AS used`,
    [privateKeyId, githubAppId],
  );
  return Boolean(r.rows[0]?.used);
}

export async function deletePrivateKeyRow(tx: SqlExecutor, id: string | number): Promise<void> {
  await tx.execute("DELETE FROM deploy.private_keys WHERE id = $1", [id]);
}

// ── What a source serves ────────────────────────────────────────────────────────────────────────────────

export interface DeploySourceApplicationRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  project_uuid: string;
  project_name: string;
  environment_uuid: string;
  environment_name: string;
  fqdn: string | null;
  status: string;
  /** The Resources table's "Repository" (git_repository:git_branch) of a GitLab or Gitea source (DP-103). */
  git_repository: string | null;
  git_branch: string | null;
}

/** $github_app->applications(): the applications whose source is this App (not soft-deleted). */
export async function listSourceApplications(tx: SqlExecutor, sourceId: string | number, morphClass = GITHUB_APP_MORPH_CLASS): Promise<DeploySourceApplicationRow[]> {
  const r = await tx.execute<DeploySourceApplicationRow>(
    `SELECT a.id, a.uuid, a.name, p.uuid AS project_uuid, p.name AS project_name, e.uuid AS environment_uuid, e.name AS environment_name, a.fqdn, a.status, a.git_repository, a.git_branch
       FROM deploy.applications a JOIN deploy.environments e ON e.id = a.environment_id JOIN deploy.projects p ON p.id = e.project_id
      WHERE a.source_id = $1 AND a.source_type = $2 AND a.deleted_at IS NULL ORDER BY a.id`,
    [sourceId, morphClass],
  );
  return r.rows;
}

// ── Webhooks: which org ─────────────────────────────────────────────────────────────────────────────────

export interface WebhookTarget extends SqlRow {
  org_id: string;
  id: string | number;
}

/**
 * Github::normal(): GithubApp::where('app_id', $target)->where('installation_id', $installation)->first(), else
 * where('app_id', $target)->first() — across orgs, under asPlatformAdmin(): only the org and the row id.
 */
export async function findGithubAppWebhookTarget(admin: SqlExecutor, appId: number, installationId: number | null): Promise<WebhookTarget | null> {
  if (installationId !== null) {
    const r = await admin.execute<WebhookTarget>("SELECT org_id::text AS org_id, id FROM deploy.github_apps WHERE app_id = $1 AND installation_id = $2 ORDER BY id LIMIT 1", [appId, installationId]);
    if (r.rows[0]) return r.rows[0];
  }
  const r = await admin.execute<WebhookTarget>("SELECT org_id::text AS org_id, id FROM deploy.github_apps WHERE app_id = $1 ORDER BY id LIMIT 1", [appId]);
  return r.rows[0] ?? null;
}

/**
 * The manual webhooks' Application::query()->where('git_branch', …)->whereRaw("LOWER(git_repository) LIKE ?")
 * across orgs, under asPlatformAdmin(): only the orgs and the application ids (by id). `branches` null matches
 * every branch (a closed pull request).
 */
export async function findManualWebhookTargets(admin: SqlExecutor, pattern: string, branches: string[] | null): Promise<WebhookTarget[]> {
  const r =
    branches === null
      ? await admin.execute<WebhookTarget>(`SELECT org_id::text AS org_id, id FROM deploy.applications WHERE deleted_at IS NULL AND LOWER(git_repository) LIKE $1 ESCAPE '\\' ORDER BY id`, [pattern])
      : await admin.execute<WebhookTarget>(`SELECT org_id::text AS org_id, id FROM deploy.applications WHERE deleted_at IS NULL AND git_branch = ANY($2::text[]) AND LOWER(git_repository) LIKE $1 ESCAPE '\\' ORDER BY id`, [
          pattern,
          branches,
        ]);
  return r.rows;
}

// ── Webhooks: the applications ──────────────────────────────────────────────────────────────────────────

export interface DeployWebhookApplicationRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  git_repository: string | null;
  git_branch: string;
  watch_paths: string | null;
  build_pack: string;
  fqdn: string | null;
  docker_compose_domains: string | null;
  preview_url_template: string | null;
  domain_port_overrides: unknown;
  repository_project_id: number | null;
  source_id: string | number | null;
  source_type: string | null;
  /** fp1 ciphertexts, or null. */
  manual_webhook_secret_github: string | null;
  manual_webhook_secret_gitlab: string | null;
  manual_webhook_secret_bitbucket: string | null;
  manual_webhook_secret_gitea: string | null;
  is_auto_deploy_enabled: boolean;
  is_preview_deployments_enabled: boolean;
  is_pr_deployments_public_enabled: boolean;
  destination_id: string | number | null;
  server_id: string | number | null;
  server_name: string | null;
  server_ip: string | null;
  server_wildcard_domain: string | null;
  server_is_reachable: boolean | null;
  server_is_usable: boolean | null;
  server_force_disabled: boolean | null;
  project_uuid: string;
  environment_uuid: string;
}

const WEBHOOK_APPLICATION_SELECT = `
  SELECT a.id, a.uuid, a.name, a.git_repository, a.git_branch, a.watch_paths, a.build_pack, a.fqdn, a.docker_compose_domains,
         a.preview_url_template, a.domain_port_overrides, a.repository_project_id, a.source_id, a.source_type,
         a.manual_webhook_secret_github, a.manual_webhook_secret_gitlab, a.manual_webhook_secret_bitbucket, a.manual_webhook_secret_gitea,
         COALESCE(st.is_auto_deploy_enabled, true) AS is_auto_deploy_enabled,
         COALESCE(st.is_preview_deployments_enabled, false) AS is_preview_deployments_enabled,
         COALESCE(st.is_pr_deployments_public_enabled, false) AS is_pr_deployments_public_enabled,
         a.destination_id, s.id AS server_id, s.name AS server_name, s.ip AS server_ip, ss.wildcard_domain AS server_wildcard_domain,
         ss.is_reachable AS server_is_reachable, ss.is_usable AS server_is_usable, ss.force_disabled AS server_force_disabled,
         p.uuid AS project_uuid, e.uuid AS environment_uuid
    FROM deploy.applications a
    JOIN deploy.environments e ON e.id = a.environment_id
    JOIN deploy.projects p ON p.id = e.project_id
    LEFT JOIN deploy.application_settings st ON st.application_id = a.id
    LEFT JOIN deploy.standalone_dockers sd ON sd.id = a.destination_id AND a.destination_type = E'${STANDALONE}'
    LEFT JOIN deploy.swarm_dockers wd ON wd.id = a.destination_id AND a.destination_type = E'${SWARM}'
    LEFT JOIN deploy.servers s ON s.id = COALESCE(sd.server_id, wd.server_id) AND s.deleted_at IS NULL
    LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id`;

/** The org's applications of these ids, by id (what a manual webhook checks the secret of). */
export async function listWebhookApplications(tx: SqlExecutor, ids: Array<string | number>): Promise<DeployWebhookApplicationRow[]> {
  if (ids.length === 0) return [];
  const r = await tx.execute<DeployWebhookApplicationRow>(`${WEBHOOK_APPLICATION_SELECT} WHERE a.id = ANY($1::bigint[]) AND a.deleted_at IS NULL ORDER BY a.id`, [ids.map(String)]);
  return r.rows;
}

/**
 * Github::normal(): Application::where('repository_project_id', $id)->where('source_id', $app)->where('source_type',
 * GithubApp)->whereRelation('source', 'is_public', false)[->where('git_branch', $branch)], by id.
 */
export async function listGithubAppWebhookApplications(tx: SqlExecutor, githubAppId: string | number, repositoryProjectId: number, branch: string | null): Promise<DeployWebhookApplicationRow[]> {
  const r = await tx.execute<DeployWebhookApplicationRow>(
    `${WEBHOOK_APPLICATION_SELECT}
      WHERE a.deleted_at IS NULL AND a.repository_project_id = $1 AND a.source_id = $2 AND a.source_type = E'${GITHUB_MORPH}'
        AND EXISTS (SELECT 1 FROM deploy.github_apps g WHERE g.id = a.source_id AND g.is_public = false)
        AND ($3::text IS NULL OR a.git_branch = $3)
      ORDER BY a.id`,
    [repositoryProjectId, String(githubAppId), branch],
  );
  return r.rows;
}

// ── Previews ────────────────────────────────────────────────────────────────────────────────────────────

export interface DeployApplicationPreviewRow extends SqlRow {
  id: string | number;
  uuid: string;
  application_id: string | number;
  pull_request_id: number;
  pull_request_html_url: string;
  pull_request_issue_comment_id: string | null;
  fqdn: string | null;
  status: string;
  git_type: string | null;
  docker_compose_domains: string | null;
  domain_port_overrides: unknown;
  is_same_repository: boolean;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

const PREVIEW_COLUMNS =
  "id, uuid, application_id, pull_request_id, pull_request_html_url, pull_request_issue_comment_id, fqdn, status, git_type, docker_compose_domains, domain_port_overrides, is_same_repository, created_at, updated_at";

/** ApplicationPreview::where('application_id', …)->where('pull_request_id', …)->first() (not soft-deleted). */
export async function findApplicationPreview(tx: SqlExecutor, applicationId: string | number, pullRequestId: number): Promise<DeployApplicationPreviewRow | null> {
  const r = await tx.execute<DeployApplicationPreviewRow>(
    `SELECT ${PREVIEW_COLUMNS} FROM deploy.application_previews WHERE application_id = $1 AND pull_request_id = $2 AND deleted_at IS NULL ORDER BY id LIMIT 1`,
    [String(applicationId), pullRequestId],
  );
  return r.rows[0] ?? null;
}

export interface NewApplicationPreview {
  orgId: string;
  uuid: string;
  applicationId: string | number;
  pullRequestId: number;
  pullRequestHtmlUrl: string;
  /** Null for a Docker Image application's preview (DP-86). */
  gitType: string | null;
  dockerComposeDomains: string | null;
  /** The preview's image tag (a Docker Image application's, DP-86). */
  dockerRegistryImageTag?: string | null;
}

/** ApplicationPreview::create([...]) of ProcessGithubPullRequestWebhook and ApplicationPreviewsController::store() (DP-86). */
export async function insertApplicationPreview(tx: SqlExecutor, preview: NewApplicationPreview): Promise<DeployApplicationPreviewRow> {
  const r = await tx.execute<DeployApplicationPreviewRow>(
    `INSERT INTO deploy.application_previews (uuid, application_id, pull_request_id, pull_request_html_url, git_type, docker_compose_domains, docker_registry_image_tag, org_id, last_online_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${NOW}, ${NOW}, ${NOW}) RETURNING ${PREVIEW_COLUMNS}`,
    [preview.uuid, String(preview.applicationId), preview.pullRequestId, preview.pullRequestHtmlUrl, preview.gitType, preview.dockerComposeDomains, preview.dockerRegistryImageTag ?? null, preview.orgId],
  );
  return r.rows[0]!;
}

export interface ApplicationPreviewChanges {
  fqdn?: string | null;
  domain_port_overrides?: Record<string, number> | null;
  is_same_repository?: boolean;
  /** DP-86: what the API's store() fills and update_preview_by_pull_request_id() saves. */
  pull_request_html_url?: string;
  git_type?: string | null;
  docker_registry_image_tag?: string | null;
  docker_compose_domains?: string | null;
}

/** $preview->save() of generate_preview_fqdn(), recordSameRepository() and the API's store() and update (DP-86). */
export async function updateApplicationPreview(tx: SqlExecutor, id: string | number, changes: ApplicationPreviewChanges): Promise<void> {
  const columns = Object.keys(changes) as Array<keyof typeof changes>;
  if (columns.length === 0) return;
  const sets = columns.map((c, i) => (c === "domain_port_overrides" ? `${c} = $${i + 2}::json` : `${c} = $${i + 2}`));
  await tx.execute(`UPDATE deploy.application_previews SET ${sets.join(", ")}, updated_at = ${NOW} WHERE id = $1`, [
    id,
    ...columns.map((c) => (c === "domain_port_overrides" ? (changes[c] === null ? null : JSON.stringify(changes[c])) : changes[c])),
  ]);
}

/** Has any deployment of this pull request ever been queued (so something of it can be on the server)? */
export async function previewHasDeployments(tx: SqlExecutor, applicationId: string | number, pullRequestId: number): Promise<boolean> {
  const r = await tx.execute<{ found: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM deploy.application_deployment_queues WHERE application_id = $1 AND pull_request_id = $2 AND status <> 'skipped') AS found",
    [String(applicationId), pullRequestId],
  );
  return Boolean(r.rows[0]?.found);
}

/** DeleteResourceJob's deleteApplicationPreviewLocally(): the preview and its persistent storages' rows. */
export async function deleteApplicationPreview(tx: SqlExecutor, id: string | number): Promise<boolean> {
  await tx.execute(`DELETE FROM deploy.local_persistent_volumes WHERE resource_type = 'App\\Models\\ApplicationPreview' AND resource_id = $1`, [String(id)]);
  const r = await tx.execute("DELETE FROM deploy.application_previews WHERE id = $1 RETURNING id", [id]);
  return r.rows.length > 0;
}

/** $preview->delete(): SoftDeletes sets deleted_at (and updated_at), DP-86. */
export async function softDeleteApplicationPreview(tx: SqlExecutor, id: string | number): Promise<void> {
  await tx.execute(`UPDATE deploy.application_previews SET deleted_at = ${NOW}, updated_at = ${NOW} WHERE id = $1`, [id]);
}

/** The FQDNs the org's applications and previews hold: a generated preview domain must not take one (the unique index). */
export async function previewFqdnTaken(tx: SqlExecutor, fqdn: string): Promise<boolean> {
  const r = await tx.execute<{ taken: boolean }>("SELECT EXISTS (SELECT 1 FROM deploy.application_previews WHERE fqdn = $1) AS taken", [fqdn]);
  return Boolean(r.rows[0]?.taken);
}

// ── A skipped deployment ────────────────────────────────────────────────────────────────────────────────

export interface NewSkippedDeployment {
  orgId: string;
  applicationId: string | number;
  applicationName: string;
  deploymentUuid: string;
  deploymentUrl: string;
  serverId: string | number | null;
  serverName: string | null;
  destinationId: string | number | null;
  pullRequestId: number;
  commit: string;
  commitMessage: string;
  gitType: string;
  /** The log entries, as appendDeploymentLog would add them one by one. */
  logs: Array<Record<string, unknown>>;
}

/** ProcessGithubPullRequestWebhook::recordSkippedDeployment(): a finished row with the reason as its message and log. */
export async function insertSkippedDeployment(tx: SqlExecutor, d: NewSkippedDeployment): Promise<string | number> {
  const r = await tx.execute<{ id: string | number }>(
    `INSERT INTO deploy.application_deployment_queues
       (application_id, application_name, deployment_uuid, deployment_url, server_id, server_name, destination_id, pull_request_id, "commit", commit_message,
        status, is_webhook, git_type, finished_at, logs, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'skipped', true, $11, ${NOW}, $12, $13, ${NOW}, ${NOW}) RETURNING id`,
    [
      String(d.applicationId),
      d.applicationName,
      d.deploymentUuid,
      d.deploymentUrl,
      d.serverId,
      d.serverName,
      d.destinationId === null ? null : String(d.destinationId),
      d.pullRequestId,
      d.commit,
      d.commitMessage,
      d.gitType,
      JSON.stringify(d.logs),
      d.orgId,
    ],
  );
  return r.rows[0]!.id;
}

/** update_repository_project_id(): the repository's id at GitHub, when it changed. */
export async function setApplicationRepositoryProjectId(tx: SqlExecutor, applicationId: string | number, repositoryProjectId: number): Promise<void> {
  await tx.execute(`UPDATE deploy.applications SET repository_project_id = $2, updated_at = ${NOW} WHERE id = $1 AND repository_project_id IS DISTINCT FROM $2`, [applicationId, repositoryProjectId]);
}
