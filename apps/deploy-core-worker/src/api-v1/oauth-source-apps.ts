// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/GitlabController.php (removeSensitiveData,
// findTeamGitlabApp, gitlabApiUrlFromHtmlUrl, list_gitlab_apps, create_gitlab_app, update_gitlab_app, delete_gitlab_app),
// app/Http/Controllers/Api/GiteaController.php (removeSensitiveData, list_gitea_apps), app/Models/{GitlabApp,GiteaApp}.php
// ($fillable, $hidden, $casts, webhookToken(), isConnected()) and app/Policies/{GitlabAppPolicy,GiteaAppPolicy}.php
// (Apache-2.0), modified.
//
// Coolify's /api/v1 for the org's GitLab Apps and Gitea Apps (DP-103), on the gitlab_apps and gitea_apps rows the console's
// Sources pages write (the secrets encrypted under the same column contexts; GitLab's webhook_token too, which Coolify
// encrypts with Crypt::encryptString()). Freeploy is a hosted service, so the API runs as Coolify Cloud does: no source is
// system-wide (is_system_wide is validated on create and never stored, and not accepted on update) and a git source's URL
// may not point to a private network (SafeExternalUrl). Every answer is the model as fresh() reads it, through
// serializeApiResponse(): the columns sorted, with the secrets (decrypted) for a token that may read them.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import type { ApiRow } from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, isObj, obj, serializeApiResponse, type CoolifyAnswer, type PhpObject, type PhpValue } from "@saas/contracts/coolify-api";
import { columnCipher } from "../handlers/cloud-tokens.js";
import { randomString, newPublicId } from "../helpers/names.js";
import { allowsRepositoryOwner, giteaRepository, isOauthConnected, OauthPhpError, OauthRefreshError, refreshOauthToken } from "../sources/oauth-git.js";
import { sshGitUrlToHttps } from "../applications/git.js";
import { parseUrl } from "../applications/domains.js";
import { message, rowsOf, type ApiV1Context } from "./context.js";
import { rowValue, toModel, type ModelShape } from "./models.js";
import { errorsObject, extraFields, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rule } from "./rules.js";
import { safeExternalUrlMessage } from "./server-settings.js";

type Kind = "gitlab" | "gitea";
const TABLE = { gitlab: "gitlab_apps", gitea: "gitea_apps" } as const;
/** removeSensitiveData()'s fields: what a token that may read secrets sees, decrypted. */
const SENSITIVE: Record<Kind, readonly string[]> = { gitlab: ["client_secret", "webhook_token", "access_token", "refresh_token"], gitea: ["client_secret", "access_token", "refresh_token", "webhook_secret"] };
const SHAPE: Record<Kind, ModelShape> = {
  gitlab: { hidden: ["webhook_token", "app_secret", "client_secret", "access_token", "refresh_token"], dates: ["created_at", "updated_at"] },
  gitea: { hidden: ["client_secret", "access_token", "refresh_token", "webhook_secret"], dates: ["created_at", "updated_at"] },
};
const NOW = "date_trunc('second', timezone('UTC', now()))";

const cipher = (tx: SqlExecutor, c: ApiV1Context, kind: Kind, column: string) => columnCipher(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, `${TABLE[kind]}.${column}`);
const filled = (v: unknown): boolean => !(v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0));
const rtrimSlash = (v: string): string => v.replace(/\/+$/, "");
const gitlabApiUrlFromHtmlUrl = (htmlUrl: string): string => `${rtrimSlash(htmlUrl)}/api/v4`;
const safeUrl = (c: ApiV1Context, attribute: string): Rule => ({
  closure: async (v) => {
    const e = await safeExternalUrlMessage(c, v, attribute, c.s3.resolve);
    return e ? [e] : [];
  },
});

/** The encrypted casts (and GitLab's webhookToken() accessor, which gives back a value it cannot decrypt as it is). */
async function decrypted(tx: SqlExecutor, c: ApiV1Context, kind: Kind, column: string, stored: unknown): Promise<string | null> {
  if (stored === null || stored === undefined || stored === "") return stored === "" ? "" : null;
  try {
    return await cipher(tx, c, kind, column).decrypt(String(stored));
  } catch {
    return kind === "gitlab" && column === "webhook_token" ? String(stored) : null;
  }
}

/** removeSensitiveData(): the model's toArray() with the secrets made visible (decrypted) for a token that may read them. */
async function sourceModel(tx: SqlExecutor, c: ApiV1Context, kind: Kind, row: ApiRow): Promise<PhpObject> {
  const visible: Array<[string, PhpValue]> = [];
  if (c.canReadSensitive) for (const k of SENSITIVE[kind]) visible.push([k, await decrypted(tx, c, kind, k, rowValue(row, k))]);
  return serializeApiResponse(toModel([...row, ["team_id", c.orgPublicId]], SHAPE[kind], { visible: c.canReadSensitive ? SENSITIVE[kind] : [], extra: visible }));
}

const findSource = async (tx: SqlExecutor, kind: Kind, id: string): Promise<ApiRow | null> => (/^\d+$/.test(id) ? ((await rowsOf(tx)(TABLE[kind], "t.id = $1", [id]))[0] ?? null) : null);

/** routes/api.php's /gitlab-apps routes. */
export async function gitlabAppsApi(c: ApiV1Context, segments: string[]): Promise<CoolifyAnswer | null> {
  const [id, extra] = segments;
  if (extra !== undefined) return null;
  const m = c.method;
  if (id === undefined) return m === "GET" ? list(c, "gitlab") : m === "POST" ? create(c) : null;
  return m === "PATCH" ? update(c, id) : m === "DELETE" ? destroy(c, id) : null;
}

/** routes/api.php's GET /gitea-apps. */
export async function giteaAppsApi(c: ApiV1Context, segments: string[]): Promise<CoolifyAnswer | null> {
  return segments.length === 0 && c.method === "GET" ? list(c, "gitea") : null;
}

/** GitlabApp/GiteaApp::where(team_id)->orWhere(is_system_wide)->get(): the org's sources; Gitea's with is_connected. */
async function list(c: ApiV1Context, kind: Kind): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const out: PhpObject[] = [];
    for (const row of await rowsOf(tx)(TABLE[kind])) {
      const model = await sourceModel(tx, c, kind, row);
      out.push(kind === "gitea" ? obj([...model.entries, ["is_connected", isOauthConnected({ access_token: rowValue(row, "access_token") as string | null, refresh_token: rowValue(row, "refresh_token") as string | null })]]) : model);
    }
    return coolifyJson(out);
  });
}

const ALLOWED = ["name", "html_url", "api_url", "custom_user", "custom_port", "group_name", "client_id", "client_secret", "webhook_token", "redirect_uri", "is_system_wide"];

async function create(c: ApiV1Context): Promise<CoolifyAnswer> {
  // $this->authorize('create', [GitlabApp::class]), before the request is read.
  if (!(await c.allows(true))) return COOLIFY_API.unauthorized();
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  const errors: Errors = [];
  await validateRules(errors, all, [
    ["name", ["required", "string", "max:255"]],
    ["html_url", ["required", "string", "url", safeUrl(c, "html_url")]],
    ["api_url", ["nullable", "string", "url", safeUrl(c, "api_url")]],
    ["custom_user", ["nullable", "string", "max:255"]],
    ["custom_port", ["nullable", "integer", "min:1", "max:65535"]],
    ["group_name", ["nullable", "string", "max:255"]],
    ["client_id", ["nullable", "string", "max:255"]],
    ["client_secret", ["nullable", "string"]],
    ["webhook_token", ["nullable", "string"]],
    // Callback to this Coolify instance: not SafeExternalUrl.
    ["redirect_uri", ["nullable", "string", "url"]],
    ["is_system_wide", ["boolean"]],
  ]);
  extraFields(errors, all, ALLOWED);
  if (errors.length) return validationFailed(errors);
  // On Coolify Cloud is_system_wide is neither authorized nor stored.
  return c.sql(c.env, c.orgId, async (tx) => {
    const htmlUrl = rtrimSlash(String(all.html_url));
    const apiUrl = filled(all.api_url) ? rtrimSlash(String(all.api_url)) : gitlabApiUrlFromHtmlUrl(htmlUrl);
    const input = (k: string, fallback: PhpValue = null): PhpValue => (k in all ? (all[k] as PhpValue) : fallback);
    const clientSecret = input("client_secret");
    const webhookToken = filled(all.webhook_token) ? String(all.webhook_token) : randomString(32);
    const r = await tx.execute<{ id: string }>(
      `INSERT INTO deploy.gitlab_apps (uuid, name, html_url, api_url, custom_user, custom_port, group_name, client_id, client_secret, webhook_token, redirect_uri, is_public, org_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, deploy.current_org(), ${NOW}, ${NOW}) RETURNING id::text AS id`,
      [
        newPublicId(),
        all.name,
        htmlUrl,
        apiUrl,
        input("custom_user", "git"),
        input("custom_port", 22),
        input("group_name"),
        input("client_id"),
        clientSecret === null ? null : await cipher(tx, c, "gitlab", "client_secret").encrypt(String(clientSecret)),
        await cipher(tx, c, "gitlab", "webhook_token").encrypt(webhookToken),
        input("redirect_uri"),
      ],
    );
    const row = (await findSource(tx, "gitlab", r.rows[0]!.id))!;
    return coolifyJson(await sourceModel(tx, c, "gitlab", row), 201);
  });
}

async function update(c: ApiV1Context, id: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  const all = body.all;
  return c.sql(c.env, c.orgId, async (tx) => {
    const row = await findSource(tx, "gitlab", id);
    if (!row) return message("GitLab app not found", 404);
    // $this->authorize('update', $gitlabApp)
    if (!(await c.allows(true))) return COOLIFY_API.unauthorized();
    // $request->only($allowedFields): on Coolify Cloud is_system_wide is not one of them.
    const payload: Record<string, unknown> = Object.fromEntries(Object.entries(all).filter(([k]) => ALLOWED.includes(k) && k !== "is_system_wide"));
    const set = (k: string) => payload[k] !== undefined && payload[k] !== null;
    const rules: Array<[string, Rule[]]> = [];
    if (set("name")) rules.push(["name", ["string", "max:255"]]);
    if (set("html_url")) rules.push(["html_url", ["url", safeUrl(c, "html_url")]]);
    if (set("api_url")) rules.push(["api_url", ["url", safeUrl(c, "api_url")]]);
    if (set("custom_user")) rules.push(["custom_user", ["string", "max:255"]]);
    if (set("custom_port")) rules.push(["custom_port", ["integer", "min:1", "max:65535"]]);
    for (const k of ["group_name", "client_id"]) if (k in payload) rules.push([k, ["nullable", "string", "max:255"]]);
    for (const k of ["client_secret", "webhook_token"]) if (k in payload) rules.push([k, ["nullable", "string"]]);
    if ("redirect_uri" in payload) rules.push(["redirect_uri", ["nullable", "url"]]);
    const errors: Errors = [];
    await validateRules(errors, payload, rules);
    if (errors.length) return coolifyJson(obj({ message: "Validation error", errors: errorsObject(errors) }), 422);
    if (set("html_url")) {
      payload.html_url = rtrimSlash(String(payload.html_url));
      if (!filled(payload.api_url)) payload.api_url = gitlabApiUrlFromHtmlUrl(payload.html_url as string);
    }
    if (set("api_url")) payload.api_url = rtrimSlash(String(payload.api_url));
    // $gitlabApp->update($payload): the secrets through their casts.
    const columns = Object.keys(payload);
    if (columns.length) {
      const values: unknown[] = [];
      for (const k of columns) {
        const v = payload[k] ?? null;
        values.push((k === "client_secret" || k === "webhook_token") && v !== null ? await cipher(tx, c, "gitlab", k).encrypt(String(v)) : v);
      }
      await tx.execute(`UPDATE deploy.gitlab_apps SET ${columns.map((k, i) => `"${k}" = $${i + 2}`).join(", ")}, updated_at = ${NOW} WHERE id = $1`, [rowValue(row, "id"), ...values]);
    }
    const fresh = (await findSource(tx, "gitlab", id))!;
    return coolifyJson(obj({ message: "GitLab app updated successfully", data: await sourceModel(tx, c, "gitlab", fresh) }));
  });
}

async function destroy(c: ApiV1Context, id: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const row = await findSource(tx, "gitlab", id);
    if (!row) return message("GitLab app not found", 404);
    if (!(await c.allows(true))) return COOLIFY_API.unauthorized();
    // $gitlabApp->applications: the applications whose source it is (morphMany on source).
    const used = await tx.execute<{ n: number }>("SELECT count(*)::int AS n FROM deploy.applications WHERE deleted_at IS NULL AND source_type = 'App\\Models\\GitlabApp' AND source_id = $1", [rowValue(row, "id")]);
    const n = used.rows[0]?.n ?? 0;
    if (n > 0) return message(`This GitLab app is being used by ${n} application(s). Please delete all applications first.`, 409);
    await tx.execute("DELETE FROM deploy.gitlab_apps WHERE id = $1", [rowValue(row, "id")]);
    return message("GitLab app deleted successfully", 200);
  });
}

// ── POST /applications/private-gitea-app's repository check ─────────────────────────────────────────────────────────

/** An uncaught exception (a PHP error of the token refresh) as Laravel answers it under api/* without APP_DEBUG. */
const SERVER_ERROR: CoolifyAnswer = { status: 500, body: '{\n    "message": "Server Error"\n}', headers: { "content-type": "application/json" } };

/** Str::chopStart() */
const chopStart = (v: string, prefix: string): string => (prefix !== "" && v.startsWith(prefix) ? v.slice(prefix.length) : v);

/**
 * giteaRepositoryPath(): owner/name from owner/name, or from an HTTPS or SSH URL on the source's own instance (its host,
 * and its path's prefix chopped); null when it is neither.
 */
export function giteaRepositoryPath(htmlUrl: string, gitRepository: string): string | null {
  let repository = sshGitUrlToHttps(gitRepository) ?? gitRepository;
  if (repository.includes("://")) {
    const host = (parseUrl(repository)?.host ?? "").toLowerCase();
    const sourceUrl = parseUrl(htmlUrl);
    if (host !== (sourceUrl?.host ?? "").toLowerCase()) return null;
    repository = chopStart(parseUrl(repository)?.path ?? "", rtrimSlash(sourceUrl?.path ?? ""));
  }
  repository = repository.replace(/^\/+|\/+$/g, "");
  if (repository.endsWith(".git")) repository = repository.slice(0, -".git".length);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split("/").some((p) => p === "." || p === "..")) return null;
  return repository;
}

/**
 * giteaAppRepository(teamSourceByUuid(GiteaApp::class, …)): the org's connected Gitea App (Freeploy has no system-wide one),
 * the repository's owner/name, the token refreshed when it is about to expire (and stored), then GET /repos/{owner}/{name}
 * tried three times, 200 ms apart: 404 for a repository the source cannot read (or whose owner its organization field
 * leaves out), 400 for another failure; else the repository's id (repository_project_id).
 */
export async function giteaAppRepository(tx: SqlExecutor, c: ApiV1Context, uuid: string, gitRepository: string): Promise<{ app: ApiRow; repository: string; repositoryProjectId: PhpValue } | CoolifyAnswer> {
  const app = (await rowsOf(tx)("gitea_apps", "t.uuid = $1", [uuid]))[0];
  const stored = (k: string): string | null => (app ? ((rowValue(app, k) as string | null) ?? null) : null);
  if (!app || !isOauthConnected({ access_token: stored("access_token"), refresh_token: stored("refresh_token") })) return message("Gitea App not found.", 404);
  const repository = giteaRepositoryPath(String(rowValue(app, "html_url")), gitRepository);
  if (repository === null) return coolifyJson(obj({ message: "Validation failed.", errors: obj({ git_repository: "The git_repository must be owner/name or a repository URL on the Gitea instance of the source." }) }), 422);
  const credentials = {
    html_url: String(rowValue(app, "html_url")),
    api_url: String(rowValue(app, "api_url")),
    client_id: stored("client_id"),
    client_secret: await decrypted(tx, c, "gitea", "client_secret", stored("client_secret")),
    access_token: await decrypted(tx, c, "gitea", "access_token", stored("access_token")),
    refresh_token: await decrypted(tx, c, "gitea", "refresh_token", stored("refresh_token")),
    expires_at: rowValue(app, "expires_at") === null ? null : Number(rowValue(app, "expires_at")),
    redirect_uri: stored("redirect_uri"),
  };
  let token = credentials.access_token;
  try {
    const tokens = await refreshOauthToken(c.providers, "gitea", credentials);
    if (tokens) {
      await tx.execute(`UPDATE deploy.gitea_apps SET access_token = $2, refresh_token = $3, expires_at = $4, updated_at = ${NOW} WHERE id = $1`, [
        rowValue(app, "id"),
        await cipher(tx, c, "gitea", "access_token").encrypt(tokens.access_token),
        await cipher(tx, c, "gitea", "refresh_token").encrypt(tokens.refresh_token),
        tokens.expires_at,
      ]);
      token = tokens.access_token;
    }
  } catch (e) {
    if (e instanceof OauthRefreshError) return message(e.message, 400);
    if (e instanceof OauthPhpError) return SERVER_ERROR;
    throw e;
  }
  const response = await giteaRepository(c.providers, credentials.api_url, token, repository);
  const json = isObj(response.json) ? response.json : null;
  const get = (k: string): PhpValue | undefined => json?.entries.find(([key]) => key === k)?.[1];
  const owner = get("owner");
  const ownerLogin = isObj(owner) ? owner.entries.find(([k]) => k === "login")?.[1] : undefined;
  if (response.status === 404 || response.status === 403 || (response.successful && !allowsRepositoryOwner(stored("organization"), ownerLogin ?? null))) {
    return message("Repository not found or not accessible by the Gitea App.", 404);
  }
  if (!response.successful) {
    const m = get("message");
    return message(`Failed to verify repository access: ${m === undefined ? "Unknown error" : m === null ? "" : String(m)}`, 400);
  }
  return { app, repository, repositoryProjectId: get("id") ?? null };
}
