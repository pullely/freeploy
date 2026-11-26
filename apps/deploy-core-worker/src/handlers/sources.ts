// Derived from coollabsio/coolify@91b7e3e:routes/web.php (/sources, /source/github/{uuid}), routes/webhooks.php
// (/source/github/redirect, /source/github/install), app/Livewire/Source/Github/{Create,Change}.php,
// app/Http/Controllers/Webhook/Github.php (redirect, install), app/Livewire/Project/New/GithubPrivateRepository.php
// (loadRepositories, loadBranches) and app/Policies/GithubAppPolicy.php (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/sources — Integrations → Git sources (freeploy-coolify-parity DP-72):
//
//   GET    /sources                                     the org's sources (Team::sources) and Create's default name
//   POST   /sources { name, organization, html_url, api_url, custom_user, custom_port, use_for_pull_request_previews }
//                                                       Create::createGitHubApp → { uuid, previews }
//   GET    /sources/github/{uuid}                       Change: the App, its form, the manifest state and install URL
//   PATCH  /sources/github/{uuid} { …form, instantSave? } Change::submit / instantSave
//   DELETE /sources/github/{uuid}                       Change::delete
//   POST   /sources/github/{uuid}/manual                createGithubAppManually
//   POST   /sources/github/{uuid}/permissions           checkPermissions (GithubAppPermissionJob)
//   POST   /sources/github/{uuid}/test                  testConnection
//   POST   /sources/github/{uuid}/sync-name { appId, privateKeyId }  updateGithubAppName
//   POST   /sources/github/redirect { code, state }     Github::redirect — the manifest's code, from deploy-web's
//                                                       /webhooks/source/github/redirect page
//   POST   /sources/github/install { installation_id, setup_action, state }  Github::install
//   GET    /sources/github/{uuid}/repositories          GithubPrivateRepository::loadRepositories
//   GET    /sources/github/{uuid}/repositories/{owner}/{repo}/branches?default_branch=  loadBranches
//
// Coolify's GithubAppPolicy: view for members, create/update/delete for admins (Coolify's member is a
// Freeploy builder, read-only: DP-69). Here: deploy.resource.read for the reads, deploy.resource.write for
// the rest (useTeamCredentials, which the repository listing asks, too); a denial answers 404.
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  listSourcesPage,
  findGithubAppByUuid,
  findGithubAppById,
  insertGithubApp,
  replicateGithubApp,
  updateGithubApp as updateGithubAppRow,
  deleteGithubApp as deleteGithubAppRow,
  findGithubAppInstallation,
  findGithubAppByInstallationId,
  findGithubAppPrivateKey,
  listPrivateKeyChoices,
  insertPrivateKey,
  privateKeyFingerprintExists,
  renamePrivateKey,
  privateKeyUsedOutsideGithubApp,
  deletePrivateKeyRow,
  listSourceApplications,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse } from "../http.js";
import { authorizeDeploy, columnCipher, readJson } from "./cloud-tokens.js";
import { dohResolver, type HostResolver } from "../s3-storages/safe-url.js";
import {
  checkGithubAppPermissions,
  checkInstallArguments,
  completeGithubAppInstallation,
  completeGithubAppManifest,
  createGithubApp,
  createGithubAppManually,
  credentialsOf,
  defaultGithubAppName,
  deleteGithubApp,
  installationUpdateTarget,
  listSources,
  setupStateTarget,
  showGithubApp,
  SOURCE_MESSAGES,
  SourceError,
  syncGithubAppNameAction,
  testGithubAppConnection,
  updateGithubApp,
  type SourceContext,
  type SourceStore,
} from "../sources/service.js";
import { InstallationTokens, loadInstallationRepositories, loadRepositoryBranches, sortBranchesByPriority, type SourceHttp } from "../sources/github.js";

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;
/** A GitHub owner or repository name, as GitHub allows them. */
const REPO_PART_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function sqlSourceStore(tx: SqlExecutor, orgId: string): SourceStore {
  return {
    list: () => listSourcesPage(tx),
    findByUuid: (uuid) => findGithubAppByUuid(tx, uuid),
    findById: (id) => findGithubAppById(tx, id),
    insert: (app) => insertGithubApp(tx, { ...app, orgId }),
    replicate: (id, uuid) => replicateGithubApp(tx, id, uuid),
    update: (id, changes) => updateGithubAppRow(tx, id, changes),
    delete: (id) => deleteGithubAppRow(tx, id),
    findInstallation: (apiUrl, appId, installationId) => findGithubAppInstallation(tx, apiUrl, appId, installationId),
    findByInstallationId: (installationId) => findGithubAppByInstallationId(tx, installationId),
    privateKey: (id) => findGithubAppPrivateKey(tx, id),
    privateKeys: () => listPrivateKeyChoices(tx),
    insertPrivateKey: (key) => insertPrivateKey(tx, { ...key, orgId, description: null, isGitRelated: true }),
    fingerprintExists: (fingerprint) => privateKeyFingerprintExists(tx, fingerprint),
    renamePrivateKey: (id, name) => renamePrivateKey(tx, id, name),
    privateKeyUsedElsewhere: (keyId, appId) => privateKeyUsedOutsideGithubApp(tx, keyId, appId),
    deletePrivateKey: (id) => deletePrivateKeyRow(tx, id),
    applications: (appId) => listSourceApplications(tx, appId),
  };
}

/** Runs fn with one org's source context, in one transaction confined to that org. */
export type SourceRunner = <T>(env: Env, orgId: string, org: string, http: SourceHttp, fn: (ctx: SourceContext) => Promise<T>) => Promise<T>;

export const runSourcesInOrg: SourceRunner = async (env, orgId, org, http, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => {
      const ciphers = new Map<string, ReturnType<typeof columnCipher>>();
      return fn({
        store: sqlSourceStore(tx, orgId),
        cipher: (column) => {
          let found = ciphers.get(column);
          if (!found) ciphers.set(column, (found = columnCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, column)));
          return found;
        },
        http,
        org,
        stateSecret: env.DEPLOY_ENCRYPTION_KEY ?? "",
        resolve: dohResolver,
      });
    });
  } finally {
    await db.dispose();
  }
};

/** GitHub through the Worker's fetch. */
export const sourceFetch: SourceHttp = { fetch: (url, init) => fetch(url, init) };

export interface SourceDeps {
  runner: SourceRunner;
  http: SourceHttp;
  resolve?: HostResolver;
}

const DEFAULT_DEPS: SourceDeps = { runner: runSourcesInOrg, http: sourceFetch };

function failure(e: unknown, requestId: string): Response {
  if (e instanceof SourceError) {
    if (e.fields) return errorResponse("validation_failed", e.message, 422, requestId, { fields: e.fields });
    const code = e.status === 403 ? "forbidden" : e.status === 404 ? "not_found" : "validation_failed";
    return errorResponse(code, e.message, e.status, requestId, e.kind === "info" ? { kind: "info" } : undefined);
  }
  return errorResponse("internal_error", "Service unavailable", 503, requestId);
}

/**
 * segments: what follows /sources. `org` is the org's public id from the route (setup states name it).
 * `deps` is replaceable for tests.
 */
export async function handleSources(env: Env, requestId: string, actor: ActorContext, orgId: string, org: string, segments: string[], request: Request, deps: SourceDeps = DEFAULT_DEPS): Promise<Response> {
  const method = request.method;
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  const run = <T>(fn: (ctx: SourceContext) => Promise<T>): Promise<T> => deps.runner(env, orgId, org, deps.http, (ctx) => fn(deps.resolve ? { ...ctx, resolve: deps.resolve } : ctx));
  type Op = { write: boolean; run: (canWrite: boolean) => Promise<Response> };
  let op: Op | null = null;
  const [kind, first, second, third, fourth, fifth] = segments;

  if (segments.length === 0) {
    if (method === "GET") op = { write: false, run: (canWrite) => list(canWrite) };
    else if (method === "POST") op = { write: true, run: create };
  } else if (kind !== "github") {
    return notFound();
  } else if (segments.length === 2 && first === "redirect") {
    if (method === "POST") op = { write: true, run: redirect };
  } else if (segments.length === 2 && first === "install") {
    if (method === "POST") op = { write: true, run: install };
  } else if (segments.length === 2 && UUID_RE.test(first!)) {
    if (method === "GET") op = { write: false, run: (canWrite) => show(first!, canWrite) };
    else if (method === "PATCH") op = { write: true, run: () => update(first!) };
    else if (method === "DELETE") op = { write: true, run: () => remove(first!) };
  } else if (segments.length === 3 && UUID_RE.test(first!) && ["manual", "permissions", "test", "sync-name"].includes(second!)) {
    if (method === "POST") op = { write: true, run: () => action(first!, second!) };
  } else if (segments.length === 3 && UUID_RE.test(first!) && second === "repositories") {
    if (method === "GET") op = { write: true, run: () => repositories(first!) };
  } else if (segments.length === 6 && UUID_RE.test(first!) && second === "repositories" && REPO_PART_RE.test(third!) && REPO_PART_RE.test(fourth!) && fifth === "branches") {
    if (method === "GET") op = { write: true, run: () => branches(first!, third!, fourth!) };
  } else {
    return notFound();
  }
  if (!op) return methodNotAllowed(requestId);

  async function list(canWrite: boolean): Promise<Response> {
    const sources = await run((ctx) => listSources(ctx));
    return successResponse({ sources, canCreate: canWrite, defaultName: defaultGithubAppName() }, requestId);
  }

  async function create(): Promise<Response> {
    const created = await run(async (ctx) => createGithubApp(ctx, await readJson(request)));
    return successResponse(created, requestId, 201);
  }

  async function show(uuid: string, canWrite: boolean): Promise<Response> {
    const page = await run((ctx) => showGithubApp(ctx, uuid, canWrite));
    if (!page) return notFound();
    return successResponse({ ...page, canUpdate: canWrite, canDelete: canWrite, canCreate: canWrite }, requestId);
  }

  async function update(uuid: string): Promise<Response> {
    const body = await readJson(request);
    const row = await run((ctx) => updateGithubApp(ctx, uuid, body));
    if (!row) return notFound();
    return successResponse({ uuid: row.uuid, name: row.name, message: SOURCE_MESSAGES.updated }, requestId);
  }

  async function remove(uuid: string): Promise<Response> {
    if (!(await run((ctx) => deleteGithubApp(ctx, uuid)))) return notFound();
    return successResponse({ deleted: true, redirect: "/sources" }, requestId);
  }

  async function action(uuid: string, name: string): Promise<Response> {
    if (name === "manual") {
      if (!(await run((ctx) => createGithubAppManually(ctx, uuid)))) return notFound();
      return successResponse({ message: SOURCE_MESSAGES.manuallyCreated }, requestId);
    }
    if (name === "permissions") {
      const result = await run((ctx) => checkGithubAppPermissions(ctx, uuid));
      return result ? successResponse(result, requestId) : notFound();
    }
    if (name === "test") {
      const result = await run((ctx) => testGithubAppConnection(ctx, uuid, new InstallationTokens(deps.http)));
      return result ? successResponse(result, requestId) : notFound();
    }
    const body = await readJson(request);
    const result = await run((ctx) => syncGithubAppNameAction(ctx, uuid, body));
    return result ? successResponse(result, requestId) : notFound();
  }

  /** Github::redirect(): the state must be valid and name this org; otherwise Coolify redirects to /sources. */
  async function redirect(): Promise<Response> {
    const body = await readJson(request);
    if (typeof body.code !== "string" || body.code.trim() === "") return errorResponse("validation_failed", SOURCE_MESSAGES.missingCode, 422, requestId);
    const target = await setupStateTarget(env.DEPLOY_ENCRYPTION_KEY ?? "", body.state, "manifest");
    if (!target || target.org !== org) return errorResponse("not_found", "Not found", 404, requestId, { redirect: "/sources" });
    const result = await run((ctx) => completeGithubAppManifest(ctx, target.app, body.code));
    if (!result) return notFound();
    return successResponse({ redirect: `/source/github/${result.uuid}`, error: result.error }, requestId);
  }

  /** Github::install(). */
  async function install(): Promise<Response> {
    const body = await readJson(request);
    const args = checkInstallArguments(body.setup_action, typeof body.installation_id === "number" ? String(body.installation_id) : body.installation_id);
    if (args.setupAction === "update") {
      const uuid = await run((ctx) => installationUpdateTarget(ctx, args.installationId));
      return successResponse({ redirect: uuid ? `/source/github/${uuid}` : "/sources", error: null, success: null }, requestId);
    }
    const target = await setupStateTarget(env.DEPLOY_ENCRYPTION_KEY ?? "", body.state, "install");
    if (!target || target.org !== org) return errorResponse("not_found", "Not found", 404, requestId, { redirect: "/sources" });
    const result = await run((ctx) => completeGithubAppInstallation(ctx, target.app, args.installationId));
    if (!result) return notFound();
    return successResponse({ redirect: `/source/github/${result.uuid}`, error: result.error, success: result.success }, requestId);
  }

  /** loadRepositories(): the installation's repositories by name; an error is handleError's toast. */
  async function repositories(uuid: string): Promise<Response> {
    const credentials = await run(async (ctx) => {
      const app = await ctx.store.findByUuid(uuid);
      return app && !app.is_public && app.app_id !== null ? credentialsOf(ctx, app) : null;
    });
    if (!credentials) return notFound();
    const list = await loadInstallationRepositories(deps.http, new InstallationTokens(deps.http), credentials).catch((e: unknown) => {
      throw new SourceError(e instanceof Error ? e.message : String(e));
    });
    return successResponse(
      {
        repositories: list.map((r) => ({ id: r.id, name: r.name, full_name: typeof r.full_name === "string" ? r.full_name : r.name, owner: { login: r.owner?.login ?? "" }, default_branch: r.default_branch ?? null })),
        total_count: list.length,
      },
      requestId,
    );
  }

  /** loadBranches(): every branch, main and master first; the repository's default branch, else the first, is selected. */
  async function branches(uuid: string, owner: string, repo: string): Promise<Response> {
    const credentials = await run(async (ctx) => {
      const app = await ctx.store.findByUuid(uuid);
      return app && !app.is_public && app.app_id !== null ? credentialsOf(ctx, app) : null;
    });
    if (!credentials) return notFound();
    const list = sortBranchesByPriority(
      await loadRepositoryBranches(deps.http, new InstallationTokens(deps.http), credentials, owner, repo).catch((e: unknown) => {
        throw new SourceError(e instanceof Error ? e.message : String(e));
      }),
    );
    const wanted = new URL(request.url).searchParams.get("default_branch") ?? "main";
    const names = list.map((b) => String(b.name));
    return successResponse({ branches: names, selected: names.includes(wanted) ? wanted : (names[0] ?? "main") }, requestId);
  }

  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;
  try {
    return await op.run(auth.canWrite);
  } catch (e) {
    return failure(e, requestId);
  }
}
