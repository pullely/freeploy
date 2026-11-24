// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Server/{DockerRegistries,Registries}.php,
// app/Livewire/Server/DockerRegistries/{Login,ServerRegistries}.php,
// app/Http/Controllers/Api/ServerDockerRegistriesController.php (the route shapes) and
// app/Policies/ServerPolicy.php (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/registries — Integrations → Registries.
//
//   GET    /registries                       DockerRegistries: a card per server (the registries its resources
//                                            use; the logins cannot be read yet) and the login form's providers
//   POST   /registries                       Login::login on the chosen servers { selectedServers, provider,
//                                            registry, username, password } — needs SSH, not available yet (501)
//
// and, routed here by handleServers (servers.ts), a server's Registries page:
//
//   GET    /servers/{uuid}/registries                    Registries: the server and its card
//   POST   /servers/{uuid}/registries                    Login::login { provider, registry, username, password,
//                                                        editRegistry } — not available yet (501)
//   POST   /servers/{uuid}/registries/{registry}/check   ServerRegistries::testLogin — not available yet (501)
//   DELETE /servers/{uuid}/registries/{registry}         ServerRegistries::logout — not available yet (501)
//
// Nothing is stored by any of them: Coolify keeps a registry login only in the
// Docker config on the server.
//
// Coolify's policy: the overview is for team admins (abort_unless isAdmin),
// and a server's registries need `update` on the server (team admin), reading
// included (can.update.resource on the route). Here every route, the reads
// too, needs deploy.resource.write, asked of policy-worker after
// membership-worker's facts; a denial answers 404 (never leaks).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { withOrg, findServerByUuid, listRegistryServers, listServerImageUsers, listBuildServerApplications } from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse, validationError } from "../http.js";
import { ServerError } from "../servers/service.js";
import { authorizeDeploy, readJson } from "./cloud-tokens.js";
import {
  checkRegistryLogin,
  chosenServers,
  loginOnServer,
  loginOnServers,
  logoutFromRegistry,
  registriesOverview,
  serverRegistries,
  type RegistryContext,
  type RegistryStore,
} from "../registries/service.js";
import { validateRegistryLogin, validateSelectedServers } from "../registries/validation.js";

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

/** Runs fn with one org's registry store, in one transaction confined to that org. */
export type RegistryRunner = <T>(env: Env, orgId: string, fn: (ctx: RegistryContext) => Promise<T>) => Promise<T>;

function sqlStore(tx: SqlExecutor): RegistryStore {
  return {
    servers: () => listRegistryServers(tx),
    findServer: (uuid) => findServerByUuid(tx, uuid),
    imageUsers: (serverId) => listServerImageUsers(tx, serverId),
    buildApplications: (serverId) => listBuildServerApplications(tx, serverId),
  };
}

export const runRegistriesInOrg: RegistryRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    // readDockerConfig: the SSH executor is not deployed, so no server's Docker config can be read.
    return await withOrg(db, orgId, (tx) => fn({ store: sqlStore(tx), readDockerConfig: null }));
  } finally {
    await db.dispose();
  }
};

function failure(e: unknown, requestId: string): Response {
  if (e instanceof ServerError) {
    const code = e.status === 501 ? "unsupported" : e.status === 403 ? "forbidden" : "validation_failed";
    return errorResponse(code, e.message, e.status, requestId);
  }
  return errorResponse("internal_error", "Service unavailable", 503, requestId);
}

async function authorized(env: Env, requestId: string, actor: ActorContext, orgId: string, run: () => Promise<Response>): Promise<Response> {
  const auth = await authorizeDeploy(env, requestId, actor, orgId, true);
  if (!auth.ok) return auth.response;
  try {
    return await run();
  } catch (e) {
    return failure(e, requestId);
  }
}

/**
 * segments: what follows /registries, split on "/" (only [] is a route).
 * `runner` is replaceable for tests.
 */
export async function handleRegistries(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segments: string[],
  request: Request,
  runner: RegistryRunner = runRegistriesInOrg,
): Promise<Response> {
  if (segments.length !== 0) return errorResponse("not_found", "Not found", 404, requestId);
  const method = request.method;
  if (method !== "GET" && method !== "POST") return methodNotAllowed(requestId);

  return authorized(env, requestId, actor, orgId, async () => {
    if (method === "GET") {
      const data = await runner(env, orgId, (c) => registriesOverview(c));
      return successResponse(data, requestId);
    }
    const body = await readJson(request);
    // targetServers() runs before the form's rules.
    const chosen = validateSelectedServers(body.selectedServers);
    if (!chosen.ok) return validationError(requestId, chosen.errors);
    const uuids = await runner(env, orgId, (c) => chosenServers(c, chosen.uuids));
    const v = validateRegistryLogin({ ...body, editRegistry: null });
    if (!v.ok) return validationError(requestId, v.errors);
    return loginOnServers(uuids, v.input);
  });
}

/**
 * A server's Registries page. segments: what follows
 * /servers/{uuid}/registries ([], [registry] or [registry, "check"]).
 */
export async function handleServerRegistries(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  uuid: string,
  segments: string[],
  request: Request,
  runner: RegistryRunner = runRegistriesInOrg,
): Promise<Response> {
  const method = request.method;
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  let run: (() => Promise<Response>) | null = null;
  let registry = "";
  if (segments.length > 0) {
    try {
      registry = decodeURIComponent(segments[0]!);
    } catch {
      return notFound();
    }
  }

  if (segments.length === 0) {
    if (method === "GET") run = show;
    else if (method === "POST") run = login;
  } else if (segments.length === 1) {
    if (method === "DELETE") run = logout;
  } else if (segments.length === 2 && segments[1] === "check") {
    if (method === "POST") run = check;
  } else {
    return notFound();
  }
  if (!run) return methodNotAllowed(requestId);

  async function show(): Promise<Response> {
    const page = await runner(env, orgId, (c) => serverRegistries(c, uuid));
    if (!page) return notFound();
    // Everyone who reaches the page may update the server.
    return successResponse({ ...page, canUpdate: true }, requestId);
  }

  async function login(): Promise<Response> {
    const v = validateRegistryLogin(await readJson(request));
    if (!v.ok) return validationError(requestId, v.errors);
    await runner(env, orgId, (c) => loginOnServer(c, uuid, v.input));
    return notFound();
  }

  async function check(): Promise<Response> {
    await runner(env, orgId, (c) => checkRegistryLogin(c, uuid, registry));
    return notFound();
  }

  async function logout(): Promise<Response> {
    await runner(env, orgId, (c) => logoutFromRegistry(c, uuid, registry));
    return notFound();
  }

  if (!UUID_RE.test(uuid)) return notFound();
  return authorized(env, requestId, actor, orgId, run);
}
