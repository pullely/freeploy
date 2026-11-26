// Derived from coollabsio/coolify@91b7e3e:app/Models/{GitlabApp,GiteaApp}.php,
// app/Livewire/Source/{Gitlab,Gitea}/{Create,Change}.php and app/Http/Controllers/Webhook/{Gitlab,Gitea}.php
// (redirect) (Apache-2.0), modified.
//
// The SQL of the two OAuth Git sources (freeploy-coolify-parity DP-103): deploy.gitlab_apps and deploy.gitea_apps rows —
// what Create inserts, what Change reads and saves, what the OAuth redirect stores, the delete. Every function takes the
// transaction of withOrg(), so row-level security confines it to one org (Coolify's where('team_id', …)). The secrets
// (client_secret, the tokens, GitLab's webhook_token and Gitea's webhook_secret) are fp1 ciphertexts here; these
// functions never decrypt. The tables are 500_deploy_core's (Coolify's 2023_03_28 and 2026_10_12 migrations and the
// OAuth columns of 2026_06_03), with org_id and FORCE ROW LEVEL SECURITY.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

const NOW = "date_trunc('second', timezone('UTC', now()))";

export type OauthSourceKind = "gitlab" | "gitea";

/** getMorphClass(), as applications.source_type stores it. */
export const OAUTH_SOURCE_MORPH_CLASS: Record<OauthSourceKind, string> = { gitlab: "App\\Models\\GitlabApp", gitea: "App\\Models\\GiteaApp" };

const TABLE: Record<OauthSourceKind, string> = { gitlab: "deploy.gitlab_apps", gitea: "deploy.gitea_apps" };

/** The columns both rows have. */
export interface DeployOauthSourceRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  organization: string | null;
  api_url: string;
  html_url: string;
  custom_port: number;
  custom_user: string;
  is_system_wide: boolean;
  is_public: boolean;
  client_id: string | null;
  /** fp1 ciphertexts (encrypted casts). */
  client_secret: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
  redirect_uri: string | null;
  private_key_id: string | number | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
  /** GitLab's: the repository filter, and the webhook token (fp1). Null on a Gitea row. */
  group_name: string | null;
  webhook_token: string | null;
  /** Gitea's webhook secret (fp1). Null on a GitLab row. */
  webhook_secret: string | null;
}

const COMMON = "id, uuid, name, organization, api_url, html_url, custom_port, custom_user, is_system_wide, is_public, client_id, client_secret, access_token, refresh_token, expires_at, redirect_uri, private_key_id, created_at, updated_at";
const COLUMNS: Record<OauthSourceKind, string> = {
  gitlab: `${COMMON}, group_name, webhook_token, NULL::text AS webhook_secret`,
  gitea: `${COMMON}, NULL::varchar AS group_name, NULL::text AS webhook_token, webhook_secret`,
};

/** The columns the pages and the OAuth redirect write. */
const WRITABLE: Record<OauthSourceKind, readonly string[]> = {
  gitlab: ["name", "api_url", "html_url", "custom_user", "custom_port", "client_id", "client_secret", "webhook_token", "group_name", "is_system_wide", "private_key_id", "redirect_uri", "access_token", "refresh_token", "expires_at"],
  gitea: ["name", "api_url", "html_url", "custom_user", "custom_port", "client_id", "client_secret", "webhook_secret", "organization", "is_system_wide", "private_key_id", "redirect_uri", "access_token", "refresh_token", "expires_at"],
};
export type OauthSourceChanges = Partial<Record<string, string | number | boolean | null>>;

export interface NewOauthSource {
  orgId: string;
  uuid: string;
  name: string;
  apiUrl: string;
  htmlUrl: string;
  customUser: string;
  customPort: number;
  isSystemWide: boolean;
  /** GitLab's group_name, Gitea's organization. */
  filter: string | null;
  /** GitLab's webhook_token, Gitea's webhook_secret: Str::random(32), encrypted. */
  webhookSecret: string;
}

/** GitlabApp::create([...]) of Create::createGitLabApp(), GiteaApp::create([...]) of Create::createGiteaApp(). */
export async function insertOauthSource(tx: SqlExecutor, kind: OauthSourceKind, s: NewOauthSource): Promise<DeployOauthSourceRow> {
  const [filter, secret] = kind === "gitlab" ? ["group_name", "webhook_token"] : ["organization", "webhook_secret"];
  const r = await tx.execute<DeployOauthSourceRow>(
    `INSERT INTO ${TABLE[kind]} (uuid, name, api_url, html_url, custom_user, custom_port, is_system_wide, ${filter}, ${secret}, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${NOW}, ${NOW}) RETURNING ${COLUMNS[kind]}`,
    [s.uuid, s.name, s.apiUrl, s.htmlUrl, s.customUser, s.customPort, s.isSystemWide, s.filter, s.webhookSecret, s.orgId],
  );
  return r.rows[0]!;
}

/** GitlabApp::where(team_id …)->whereUuid($uuid)->first(): the org's source (Freeploy has no system-wide one). */
export async function findOauthSourceByUuid(tx: SqlExecutor, kind: OauthSourceKind, uuid: string): Promise<DeployOauthSourceRow | null> {
  const r = await tx.execute<DeployOauthSourceRow>(`SELECT ${COLUMNS[kind]} FROM ${TABLE[kind]} WHERE uuid = $1`, [uuid]);
  return r.rows[0] ?? null;
}

export async function findOauthSourceById(tx: SqlExecutor, kind: OauthSourceKind, id: string | number): Promise<DeployOauthSourceRow | null> {
  const r = await tx.execute<DeployOauthSourceRow>(`SELECT ${COLUMNS[kind]} FROM ${TABLE[kind]} WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

/** GitlabApp::private() / GiteaApp::private(): the org's sources that are not public and hold an access token, by id. */
export async function listConnectedOauthSources(tx: SqlExecutor, kind: OauthSourceKind): Promise<DeployOauthSourceRow[]> {
  const r = await tx.execute<DeployOauthSourceRow>(`SELECT ${COLUMNS[kind]} FROM ${TABLE[kind]} WHERE is_public = false AND access_token IS NOT NULL ORDER BY id`);
  return r.rows;
}

/** $source->save() / ->update([...]) of the given columns; updated_at as Eloquent sets it. Unknown columns are ignored. */
export async function updateOauthSource(tx: SqlExecutor, kind: OauthSourceKind, id: string | number, changes: OauthSourceChanges): Promise<DeployOauthSourceRow | null> {
  const columns = Object.keys(changes).filter((c) => WRITABLE[kind].includes(c));
  if (columns.length === 0) return findOauthSourceById(tx, kind, id);
  const r = await tx.execute<DeployOauthSourceRow>(`UPDATE ${TABLE[kind]} SET ${columns.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = ${NOW} WHERE id = $1 RETURNING ${COLUMNS[kind]}`, [
    id,
    ...columns.map((c) => changes[c] ?? null),
  ]);
  return r.rows[0] ?? null;
}

export async function deleteOauthSource(tx: SqlExecutor, kind: OauthSourceKind, id: string | number): Promise<boolean> {
  const r = await tx.execute(`DELETE FROM ${TABLE[kind]} WHERE id = $1 RETURNING id`, [id]);
  return r.rows.length > 0;
}
