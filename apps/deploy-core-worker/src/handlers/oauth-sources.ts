// Derived from coollabsio/coolify@91b7e3e:routes/web.php (/source/gitlab/{uuid}, /source/gitea/{uuid}),
// routes/webhooks.php (/source/gitlab/redirect, /source/gitea/redirect), app/Livewire/Source/{Gitlab,Gitea}/{Create,
// Change}.php, app/Http/Controllers/Webhook/{Gitlab,Gitea}.php (redirect),
// app/Livewire/Project/New/{GitlabPrivateRepository,GiteaPrivateRepository}.php (loadRepositories, loadBranches) and
// app/Policies/{GitlabAppPolicy,GiteaAppPolicy}.php (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/sources/{gitlab|gitea} — the two OAuth Git sources (freeploy-coolify-parity DP-103):
//
//   POST   /sources/{kind} { name, html_url, api_url, custom_user, custom_port, group_name | organization, is_system_wide }
//                                                       Create::createGitLabApp / createGiteaApp → { uuid }
//   GET    /sources/{kind}/{uuid}                       Change: the source, its form, its applications, the OAuth state
//   PATCH  /sources/{kind}/{uuid} { …form }              Change::submit
//   DELETE /sources/{kind}/{uuid}                       Change::delete
//   POST   /sources/{kind}/{uuid}/test                  Change::testConnection
//   POST   /sources/{kind}/redirect { code, state }     Webhook\{Gitlab,Gitea}::redirect — from deploy-web's
//                                                       /webhooks/source/{kind}/redirect page
//   GET    /sources/{kind}/{uuid}/repositories          loadRepositories
//   GET    /sources/gitlab/{uuid}/repositories/{project_id}/branches?default_branch=   loadBranches
//   GET    /sources/gitea/{uuid}/repositories/{owner}/{repo}/branches?default_branch=  loadBranches
//
// Coolify's GitlabAppPolicy / GiteaAppPolicy: view for members, create/update/delete for team admins (Coolify's member is
// a Freeploy builder, read-only: DP-69). Here: deploy.resource.read for the page and Test connection (Coolify's
// authorize('view')), deploy.resource.write for the rest (useTeamCredentials for the repositories); a denial answers 404
// and runs nothing.
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  findOauthSourceByUuid,
  insertOauthSource,
  updateOauthSource as updateOauthSourceRow,
  deleteOauthSource as deleteOauthSourceRow,
  findGithubAppPrivateKey,
  listPrivateKeyChoices,
  listSourceApplications,
  OAUTH_SOURCE_MORPH_CLASS,
  type OauthSourceKind,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse } from "../http.js";
import { authorizeDeploy, columnCipher, readJson } from "./cloud-tokens.js";
import { DEFAULT_CONSOLE_URL } from "./notifications.js";
import { dohResolver, type HostResolver } from "../s3-storages/safe-url.js";
import type { SourceHttp } from "../sources/github.js";
import { SourceError } from "../sources/service.js";
import { setupStateTarget } from "../sources/service.js";
import {
  completeOauthRedirect,
  createOauthSource,
  deleteOauthSource,
  listOauthBranches,
  listOauthRepositories,
  OAUTH_SOURCE_MESSAGES,
  showOauthSource,
  testOauthConnection,
  updateOauthSource,
  type OauthSourceContext,
  type OauthSourceStore,
} from "../sources/oauth-sources.js";

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;
/** A Gitea owner or repository name; a GitLab project id. */
const REPO_PART_RE = /^[A-Za-z0-9._-]{1,100}$/;
const PROJECT_ID_RE = /^\d{1,18}$/;

export function sqlOauthSourceStore(tx: SqlExecutor, orgId: string): OauthSourceStore {
  return {
    findByUuid: (kind, uuid) => findOauthSourceByUuid(tx, kind, uuid),
    insert: (kind, source) => insertOauthSource(tx, kind, { ...source, orgId }),
    update: (kind, id, changes) => updateOauthSourceRow(tx, kind, id, changes),
    delete: (kind, id) => deleteOauthSourceRow(tx, kind, id),
    privateKey: (id) => findGithubAppPrivateKey(tx, id),
    privateKeys: () => listPrivateKeyChoices(tx),
    applications: (kind, id) => listSourceApplications(tx, id, OAUTH_SOURCE_MORPH_CLASS[kind]),
  };
}

/** Runs fn with one org's OAuth source context, in one transaction confined to that org. */
export type OauthSourceRunner = <T>(env: Env, orgId: string, org: string, http: SourceHttp, fn: (ctx: OauthSourceContext) => Promise<T>) => Promise<T>;

export const runOauthSourcesInOrg: OauthSourceRunner = async (env, orgId, org, http, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => {
      const ciphers = new Map<string, ReturnType<typeof columnCipher>>();
      return fn({
        store: sqlOauthSourceStore(tx, orgId),
        cipher: (column) => {
          let found = ciphers.get(column);
          if (!found) ciphers.set(column, (found = columnCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, column)));
          return found;
        },
        http,
        org,
        stateSecret: env.DEPLOY_ENCRYPTION_KEY ?? "",
        resolve: dohResolver,
        consoleUrl: env.DEPLOY_CONSOLE_URL || DEFAULT_CONSOLE_URL,
      });
    });
  } finally {
    await db.dispose();
  }
};

export interface OauthSourceDeps {
  runner: OauthSourceRunner;
  http: SourceHttp;
  resolve?: HostResolver;
}

function failure(e: unknown, requestId: string): Response {
  if (e instanceof SourceError) {
    if (e.fields) return errorResponse("validation_failed", e.message, 422, requestId, { fields: e.fields });
    const code = e.status === 403 ? "forbidden" : e.status === 404 ? "not_found" : "validation_failed";
    return errorResponse(code, e.message, e.status, requestId);
  }
  return errorResponse("internal_error", "Service unavailable", 503, requestId);
}

/** segments: what follows /sources/{kind}. */
export async function handleOauthSources(env: Env, requestId: string, actor: ActorContext, orgId: string, org: string, kind: OauthSourceKind, segments: string[], request: Request, deps: OauthSourceDeps): Promise<Response> {
  const method = request.method;
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  const run = <T>(fn: (ctx: OauthSourceContext) => Promise<T>): Promise<T> => deps.runner(env, orgId, org, deps.http, (ctx) => fn(deps.resolve ? { ...ctx, resolve: deps.resolve } : ctx));
  type Op = { write: boolean; run: (canWrite: boolean) => Promise<Response> };
  let op: Op | null = null;
  const [first, second, third, fourth, fifth] = segments;

  if (segments.length === 0) {
    if (method === "POST") op = { write: true, run: create };
  } else if (segments.length === 1 && first === "redirect") {
    if (method === "POST") op = { write: true, run: redirect };
  } else if (segments.length === 1 && UUID_RE.test(first!)) {
    if (method === "GET") op = { write: false, run: (canWrite) => show(first!, canWrite) };
    else if (method === "PATCH") op = { write: true, run: () => update(first!) };
    else if (method === "DELETE") op = { write: true, run: () => remove(first!) };
  } else if (segments.length === 2 && UUID_RE.test(first!) && second === "test") {
    if (method === "POST") op = { write: false, run: () => test(first!) };
  } else if (segments.length === 2 && UUID_RE.test(first!) && second === "repositories") {
    if (method === "GET") op = { write: true, run: () => repositories(first!) };
  } else if (kind === "gitlab" && segments.length === 4 && UUID_RE.test(first!) && second === "repositories" && PROJECT_ID_RE.test(third!) && fourth === "branches") {
    if (method === "GET") op = { write: true, run: () => branches(first!, third!) };
  } else if (kind === "gitea" && segments.length === 5 && UUID_RE.test(first!) && second === "repositories" && REPO_PART_RE.test(third!) && REPO_PART_RE.test(fourth!) && fifth === "branches") {
    if (method === "GET") op = { write: true, run: () => branches(first!, `${third!}/${fourth!}`) };
  } else {
    return notFound();
  }
  if (!op) return methodNotAllowed(requestId);

  async function create(): Promise<Response> {
    const created = await run(async (ctx) => createOauthSource(ctx, kind, await readJson(request)));
    return successResponse(created, requestId, 201);
  }

  async function show(uuid: string, canWrite: boolean): Promise<Response> {
    const page = await run((ctx) => showOauthSource(ctx, kind, uuid, canWrite));
    if (!page) return notFound();
    return successResponse({ ...page, canUpdate: canWrite, canDelete: canWrite }, requestId);
  }

  async function update(uuid: string): Promise<Response> {
    const body = await readJson(request);
    const row = await run((ctx) => updateOauthSource(ctx, kind, uuid, body));
    if (!row) return notFound();
    return successResponse({ uuid: row.uuid, name: row.name, message: OAUTH_SOURCE_MESSAGES[kind].updated }, requestId);
  }

  async function remove(uuid: string): Promise<Response> {
    if (!(await run((ctx) => deleteOauthSource(ctx, kind, uuid)))) return notFound();
    return successResponse({ deleted: true, redirect: "/sources" }, requestId);
  }

  async function test(uuid: string): Promise<Response> {
    const result = await run((ctx) => testOauthConnection(ctx, kind, uuid));
    return result ? successResponse(result, requestId) : notFound();
  }

  /**
   * Webhook\{Gitlab,Gitea}::redirect(): a missing code or state, or a state that is not valid for this org, is Coolify's
   * redirect to the Sources page with its message.
   */
  async function redirect(): Promise<Response> {
    const body = await readJson(request);
    const messages = OAUTH_SOURCE_MESSAGES[kind];
    if (typeof body.code !== "string" || body.code === "" || typeof body.state !== "string" || body.state === "") return successResponse({ redirect: "/sources", error: messages.invalidCallback }, requestId);
    const target = await setupStateTarget(env.DEPLOY_ENCRYPTION_KEY ?? "", body.state, kind);
    if (!target || target.org !== org) return successResponse({ redirect: "/sources", error: messages.invalidState }, requestId);
    const result = await run((ctx) => completeOauthRedirect(ctx, kind, target.app, body.code as string));
    if (!result) return notFound();
    return successResponse(result, requestId);
  }

  async function repositories(uuid: string): Promise<Response> {
    const result = await run((ctx) => listOauthRepositories(ctx, kind, uuid));
    return result ? successResponse(result, requestId) : notFound();
  }

  async function branches(uuid: string, repository: string): Promise<Response> {
    const wanted = new URL(request.url).searchParams.get("default_branch") ?? "main";
    const result = await run((ctx) => listOauthBranches(ctx, kind, uuid, repository, wanted));
    return result ? successResponse(result, requestId) : notFound();
  }

  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;
  try {
    return await op.run(auth.canWrite);
  } catch (e) {
    return failure(e, requestId);
  }
}
