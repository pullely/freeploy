// Derived from coollabsio/coolify@91b7e3e:routes/web.php (the /canvas/api group) and
// app/Http/Controllers/Api/{ProjectCanvas,ServerCanvas,SharedVariableCanvas,TagCanvas}Controller.php (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/canvas/api/… — the canvases that reuse the environment canvas's view (DP-98),
// at Coolify's own /canvas/api paths, which the canvas calls with the browser session:
//
//   GET    /projects/canvas                                          ProjectCanvasController::index
//   PATCH  /projects/canvas/positions                                ProjectCanvasController::updatePositions
//   GET    /projects/{uuid}/canvas                                   ProjectCanvasController::show
//   GET    /servers/canvas                                           ServerCanvasController::index
//   PATCH  /servers/canvas/positions                                 ServerCanvasController::updatePositions
//   GET    /dashboard/canvas                                         ServerCanvasController::dashboard
//   PATCH  /dashboard/canvas/positions                               ServerCanvasController::updatePositions
//   GET    /servers/{uuid}/canvas                                    ServerCanvasController::show
//   GET    /servers/{uuid}/canvas/containers                         ServerCanvasController::containers (SSH: 501 on a functional server)
//   GET    /servers/{uuid}/canvas/usage                              ServerCanvasController::usage (SSH: 501 with metrics on)
//   GET    /tags/canvas                                              TagCanvasController::show
//   POST   /tags/canvas/links                                        TagCanvasController::storeLink
//   DELETE /tags/canvas/links/{link_id}                              TagCanvasController::destroyLink
//   GET    /shared-variables/team/canvas                             SharedVariableCanvasController::show
//   POST   /shared-variables/team/canvas/links                       SharedVariableCanvasController::storeLink
//   DELETE /shared-variables/team/canvas/links/{link_id}             SharedVariableCanvasController::destroyLink
//   GET    /shared-variables/{project|environment|server}/{uuid}/canvas[/links[/{link_id}]]   the same, for one owner
//
// Coolify's policies: reading a canvas is `view` / `viewAny` / `viewSharedVariables` (deploy.resource.read here);
// can_edit and every write are `update` / `manageEnvironment` with a write token (deploy.resource.write). Each
// route asks policy-worker after membership-worker's facts, a denial answers 404 (never leaks), and every read
// and write runs inside withOrg. The cards' own moves and links go through the environment canvas's endpoints (DP-92).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  attachTag,
  deleteEnvironmentVariables,
  detachTag,
  findEnvironmentVariableResource,
  listCanvasDeployments,
  listCanvasEnvironments,
  listCanvasEnvironmentVariables,
  listCanvasProjects,
  listCanvasServers,
  listOrgApplications,
  listOrgDatabases,
  listOrgResourceLinks,
  listOrgServiceCanvasRows,
  listOrgTaggables,
  listSharedVariables,
  listTags,
  saveProjectCanvasPosition,
  saveServerCanvasPosition,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse } from "../http.js";
import { readApiBody, type ApiBody } from "../api-v1/request.js";
import { authorizeDeploy, columnCipher } from "./cloud-tokens.js";
import { environmentVariableContext } from "./environment-variables.js";
import { createVariable } from "../environment-variables/service.js";
import { withoutEdgeLineBreaks } from "../environment-variables/env-format.js";
import type { CanvasAnswer } from "../applications/canvas.js";
import {
  dashboardCanvas,
  destroyTagLink,
  destroyVariableLink,
  findScopeOwner,
  ownerNotFound,
  projectCanvas,
  projectsCanvas,
  serverCanvas,
  serverCanvasContainers,
  serverCanvasUsage,
  serversCanvas,
  sharedVariableCanvas,
  storeTagLink,
  storeVariableLink,
  tagsCanvas,
  updateZonePositions,
  type CanvasScope,
  type CanvasViewsStore,
} from "../applications/canvas-views.js";

/** Runs fn with one org's canvas store, in one transaction confined to that org. Replaceable for tests. */
export type CanvasViewsRunner = <T>(env: Env, orgId: string, fn: (store: CanvasViewsStore) => Promise<T>) => Promise<T>;

export function canvasViewsSqlStore(tx: SqlExecutor, orgId: string, secret: string | undefined): CanvasViewsStore {
  const cipher = columnCipher(tx, orgId, secret, "environment_variables.value");
  return {
    environments: () => listCanvasEnvironments(tx),
    projects: () => listCanvasProjects(tx),
    servers: () => listCanvasServers(tx),
    applications: () => listOrgApplications(tx),
    services: () => listOrgServiceCanvasRows(tx),
    databases: () => listOrgDatabases(tx),
    links: () => listOrgResourceLinks(tx),
    saveProjectPosition: (id, position) => saveProjectCanvasPosition(tx, id, position),
    saveServerPosition: (id, position) => saveServerCanvasPosition(tx, id, position),
    deployments: (serverIds, active) => listCanvasDeployments(tx, serverIds, active),
    tags: () => listTags(tx),
    taggables: () => listOrgTaggables(tx),
    attachTag: (resource, tagId) => attachTag(tx, orgId, resource, tagId),
    detachTag: (resource, tagId) => detachTag(tx, resource, tagId),
    sharedVariables: (scope, ownerId) => listSharedVariables(tx, { type: scope, id: ownerId }),
    variables: (resources, withPreview) => listCanvasEnvironmentVariables(tx, resources, withPreview),
    // The value accessor: null for a stored null or '', else the decrypted value without its edge line breaks.
    decrypt: async (value) => (value ? withoutEdgeLineBreaks(await cipher.decrypt(value)) : null),
    addVariable: async (resource, variable) => {
      const ctx = environmentVariableContext(tx, orgId, secret, resource.type);
      const row = await ctx.store.findResource(resource.uuid);
      if (!row) throw new Error("the resource is gone");
      // new EnvironmentVariable: key, value, is_multiline and is_literal; the other columns keep their defaults.
      await createVariable(ctx, row, {
        key: variable.key,
        value: variable.value,
        comment: null,
        order: null,
        isPreview: false,
        isMultiline: variable.isMultiline,
        isLiteral: variable.isLiteral,
        isRuntime: true,
        isBuildtime: true,
        isRequired: false,
        isShownOnce: false,
      });
    },
    deleteVariables: async (ids) => {
      await deleteEnvironmentVariables(tx, [...ids]);
    },
    dockerCompose: async (resource) => (await findEnvironmentVariableResource(tx, resource.type, resource.uuid))?.docker_compose ?? null,
  };
}

export const runCanvasViewsInOrg: CanvasViewsRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => fn(canvasViewsSqlStore(tx, orgId, env.DEPLOY_ENCRYPTION_KEY)));
  } finally {
    await db.dispose();
  }
};

const UUID_RE = /^[A-Za-z0-9_-]{1,255}$/;
const OWNER_SCOPES: readonly string[] = ["project", "environment", "server"];

/** A save action's answer in Freeploy's envelope: its data, or Coolify's message with the field errors (422) or the body's fault (400). */
function answerResponse(answer: CanvasAnswer, requestId: string): Response {
  if (answer.ok) return successResponse(answer.data, requestId, answer.status);
  const code = answer.status === 404 ? "not_found" : answer.status === 400 ? "bad_request" : answer.status === 501 ? "unsupported" : "validation_failed";
  const details: Record<string, unknown> = {};
  if (answer.errors) details.fields = Object.fromEntries(answer.errors);
  if (answer.error) details.error = answer.error;
  return errorResponse(code, answer.message, answer.status, requestId, Object.keys(details).length ? details : undefined);
}

interface Op {
  write: boolean;
  /** The page's data (null: the owner is not the org's), or a save action's answer. */
  run: (store: CanvasViewsStore, canWrite: boolean) => Promise<CanvasAnswer>;
}

const ok = (data: unknown): CanvasAnswer => ({ ok: true, status: 200, data });
const found = (message: string, data: unknown): CanvasAnswer => (data === null ? { ok: false, status: 404, message } : ok(data));

/** The connect view's routes of one owner: …/canvas, …/canvas/links and …/canvas/links/{link_id}. */
function connectOp(method: string, rest: string[], body: ApiBody, show: Op["run"], store: (body: ApiBody) => Op["run"], destroy: (linkId: string) => Op["run"]): Op | null | undefined {
  if (rest.length === 0) return method === "GET" ? { write: false, run: show } : null;
  if (rest[0] !== "links" || rest.length > 2) return undefined;
  if (rest.length === 1) return method === "POST" ? { write: true, run: store(body) } : null;
  return method === "DELETE" ? { write: true, run: destroy(rest[1]!) } : null;
}

/**
 * segments: what follows /deploy/canvas/api, split on "/" (each decoded here: a link id holds ":" and "|").
 * `runner` is replaceable for tests. Undefined op: no such route (404); null: not that method (405).
 */
export async function handleCanvasViews(env: Env, requestId: string, actor: ActorContext, orgId: string, raw: string[], request: Request, runner: CanvasViewsRunner = runCanvasViewsInOrg): Promise<Response> {
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  let segments: string[];
  try {
    segments = raw.map(decodeURIComponent);
  } catch {
    return notFound();
  }
  const method = request.method;
  // Read once, before the transaction (validateIncomingRequest() checks it in the action).
  const body = method === "POST" || method === "PATCH" ? await readApiBody(request) : { all: {}, isJson: true, incomingError: null };
  const [first, second, third, ...more] = segments;
  let op: Op | null | undefined;
  const get = (run: Op["run"]): Op | null => (method === "GET" ? { write: false, run } : null);
  const positions = (kind: "projects" | "servers"): Op | null => (method === "PATCH" ? { write: true, run: (s) => updateZonePositions(s, kind, body) } : null);

  if ((first === "projects" || first === "servers" || first === "dashboard") && second === "canvas") {
    if (third === undefined) op = get(async (s, w) => ok(first === "projects" ? await projectsCanvas(s, w) : first === "servers" ? await serversCanvas(s, w) : await dashboardCanvas(s, w)));
    else if (third === "positions" && more.length === 0) op = positions(first === "projects" ? "projects" : "servers");
  } else if (first === "projects" && second && UUID_RE.test(second) && third === "canvas" && more.length === 0) {
    op = get(async (s, w) => found("Project not found.", await projectCanvas(s, second, w)));
  } else if (first === "servers" && second && UUID_RE.test(second) && third === "canvas") {
    if (more.length === 0) op = get(async (s, w) => found("Server not found.", await serverCanvas(s, second, w)));
    else if (more.length === 1 && more[0] === "containers") op = get((s) => serverCanvasContainers(s, second));
    else if (more.length === 1 && more[0] === "usage") op = get((s) => serverCanvasUsage(s, second));
  } else if (first === "tags" && second === "canvas") {
    op = connectOp(
      method,
      [third, ...more].filter((x): x is string => x !== undefined),
      body,
      async (s, w) => ok(await tagsCanvas(s, w)),
      (body) => (s) => storeTagLink(s, body),
      (linkId) => (s) => destroyTagLink(s, linkId),
    );
  } else if (first === "shared-variables") {
    // /shared-variables/team/canvas… or /shared-variables/{scope}/{uuid}/canvas…
    const team = second === "team" && third === "canvas";
    const scoped = !!second && OWNER_SCOPES.includes(second) && !!third && UUID_RE.test(third) && more[0] === "canvas";
    if (team || scoped) {
      const scope = (team ? "team" : second) as CanvasScope;
      const uuid = team ? null : third!;
      const rest = team ? more : more.slice(1);
      const withOwner =
        (fn: (s: CanvasViewsStore, owner: NonNullable<Awaited<ReturnType<typeof findScopeOwner>>>, w: boolean) => Promise<CanvasAnswer>) =>
        async (s: CanvasViewsStore, w: boolean): Promise<CanvasAnswer> => {
          const owner = await findScopeOwner(s, scope, uuid);
          return owner ? fn(s, owner, w) : { ok: false, status: 404, message: ownerNotFound(scope) };
        };
      op = connectOp(
        method,
        rest,
        body,
        withOwner(async (s, owner, w) => ok(await sharedVariableCanvas(s, owner, w))),
        (body) => withOwner((s, owner) => storeVariableLink(s, owner, body)),
        (linkId) => withOwner((s, owner) => destroyVariableLink(s, owner, linkId)),
      );
    }
  }
  if (op === undefined) return notFound();
  if (op === null) return methodNotAllowed(requestId);

  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;
  const run = op.run;
  try {
    return answerResponse(await runner(env, orgId, (s) => run(s, auth.canWrite)), requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}
