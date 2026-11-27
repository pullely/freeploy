// Derived from coollabsio/coolify@91b7e3e:routes/web.php (the /canvas/api group),
// app/Http/Middleware/UseSessionTeamApiToken.php and app/Http/Controllers/Api/EnvironmentCanvasController.php
// (show, findEnvironment) (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/canvas/api/… — Coolify's /canvas/api GET routes, the JSON its canvases fetch with the
// browser session (DP-119). Coolify answers them with its /api/v1 controllers and the canvas controllers, given an
// in-memory token of the page's team (UseSessionTeamApiToken); Freeploy answers them for the console's actor:
//
//   GET /projects                                                       ProjectController::projects          /api/v1, in-process
//   GET /projects/{uuid}/environments                                   ProjectController::get_environments  /api/v1, in-process
//   GET /servers                                                        ServersController::servers           /api/v1, in-process
//   GET /servers/{server_uuid}/destinations                             DestinationsController::index_by_server
//   GET /github-apps                                                    GithubController::list_github_apps
//   GET /github-apps/{github_app_id}/repositories                       GithubController::load_repositories  (DP-93, DP-72's JWT)
//   GET /github-apps/{github_app_id}/repositories/{owner}/{repo}/branches GithubController::load_branches
//   GET /security/keys                                                  SecurityController::keys
//   GET /applications/{uuid}                                            ApplicationsController::application_by_uuid
//   GET /deployments/{uuid}                                             DeployController::deployment_by_uuid
//   GET /projects/{uuid}/environments/{environment_name_or_uuid}/canvas EnvironmentCanvasController::show (DP-91's payload)
//   everything else under /canvas/api                                   handlers/canvas-views.ts (DP-98)
//
// Each route asks deploy.resource.read first (membership-worker's facts, then policy-worker); a denial answers the 404
// every denial gets and runs nothing. The /api/v1 routes are then answered by deploy-core-worker's own /api/v1 handler
// (each store call inside withOrg), told the same decision instead of asking policy-worker again, with the ability
// `read` and without read:sensitive: Coolify's admin token holds read:sensitive, but nothing the canvas shows is
// sensitive, so no private key, secret or token value leaves the worker (the departure). A success is Freeploy's
// envelope with Coolify's body as its `data`, written into it byte for byte (key order, `\/`, PHP's floats); a
// failure is Freeploy's error envelope with Coolify's message (and its field errors as details.fields).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { API_V1_HEADERS } from "@saas/contracts/coolify-api";
import { handleApiV1, type ApiV1Runners } from "../api-v1/handler.js";
import { errorResponse, methodNotAllowed } from "../http.js";
import { authorizeDeploy } from "./cloud-tokens.js";
import { apiFailure } from "./deploy-canvas.js";
import { handleCanvasViews, runCanvasViewsInOrg, type CanvasViewsRunner } from "./canvas-views.js";
import { runApplicationsInOrg, type ApplicationRunner } from "./applications.js";
import { environmentCanvasByNameOrUuid } from "../applications/canvas.js";

export interface CanvasApiDeps {
  /** handleApiV1's runners (the stores, the org's facts, GitHub's fetch); replaceable for tests. */
  apiRunners?: Partial<ApiV1Runners>;
  /** The environment canvas's store (DP-91's); replaceable for tests. */
  applications?: ApplicationRunner;
  /** The projects, servers, dashboard, shared variable and tag canvases' store (DP-98's); replaceable for tests. */
  canvasViews?: CanvasViewsRunner;
}

/** UseSessionTeamApiToken's abilities for these GET routes: `read` (api.ability:read), without read:sensitive. */
export const CANVAS_API_ABILITIES = ["read"] as const;

/** A path segment as the router hands it (still percent-encoded): /api/v1 decodes it as Laravel's router does. */
const SEGMENT_RE = /^[^/]{1,255}$/;

/** The /canvas/api GET routes answered by Coolify's /api/v1 controllers: the /api/v1 path of each, or null. */
export function canvasApiV1Path(segments: readonly string[]): string | null {
  const [a, b, c, d, e, f, ...more] = segments;
  if (more.length) return null;
  const ok = (...s: Array<string | undefined>) => s.every((x) => x !== undefined && SEGMENT_RE.test(x));
  const n = segments.length;
  if (n === 1 && (a === "projects" || a === "servers" || a === "github-apps")) return `/${a}`;
  if (n === 2 && a === "security" && b === "keys") return "/security/keys";
  if (n === 2 && (a === "applications" || a === "deployments") && ok(b)) return `/${a}/${b}`;
  if (n === 3 && a === "projects" && b !== "canvas" && ok(b) && c === "environments") return `/projects/${b}/environments`;
  if (n === 3 && a === "servers" && b !== "canvas" && ok(b) && c === "destinations") return `/servers/${b}/destinations`;
  if (n === 3 && a === "github-apps" && ok(b) && c === "repositories") return `/github-apps/${b}/repositories`;
  if (n === 6 && a === "github-apps" && ok(b) && c === "repositories" && ok(d, e) && f === "branches") return `/github-apps/${b}/repositories/${d}/${e}/branches`;
  return null;
}

/** Freeploy's success envelope around Coolify's body as written (successResponse()'s shape, the body not re-encoded). */
function coolifyData(body: string, status: number, requestId: string): Response {
  return new Response(`{"data":${body},"meta":${JSON.stringify({ requestId, cursor: null })}}`, { status, headers: { "content-type": "application/json" } });
}

/**
 * segments: what follows /deploy/canvas/api, as the router split them (not decoded). `orgPublicId` is the org as the
 * path names it (Coolify's team in /api/v1's answers).
 */
export async function handleCanvasApi(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  orgPublicId: string,
  segments: string[],
  request: Request,
  deps: CanvasApiDeps = {},
): Promise<Response> {
  const apiPath = canvasApiV1Path(segments);
  const isEnvironmentCanvas = segments.length === 5 && segments[0] === "projects" && SEGMENT_RE.test(segments[1]!) && segments[2] === "environments" && SEGMENT_RE.test(segments[3]!) && segments[4] === "canvas";
  if (!apiPath && !isEnvironmentCanvas) return handleCanvasViews(env, requestId, actor, orgId, segments, request, deps.canvasViews ?? runCanvasViewsInOrg);
  // Coolify's POST /projects, /projects/{uuid}/environments and PATCH /applications/{uuid} are the deploy canvas's
  // (DP-94's …/deploy/canvas/projects and run): only the GETs are served here.
  if (request.method !== "GET") return methodNotAllowed(requestId);

  const auth = await authorizeDeploy(env, requestId, actor, orgId, false);
  if (!auth.ok) return auth.response;

  try {
    if (isEnvironmentCanvas) {
      let projectUuid: string;
      let environment: string;
      try {
        [projectUuid, environment] = [decodeURIComponent(segments[1]!), decodeURIComponent(segments[3]!)];
      } catch {
        return errorResponse("not_found", "Project not found.", 404, requestId);
      }
      // can_edit: $user->can('update', $environment) and a token that may write (deploy.resource.write).
      const answer = await (deps.applications ?? runApplicationsInOrg)(env, orgId, (c) => environmentCanvasByNameOrUuid(c, projectUuid, environment, auth.canWrite));
      if (answer.ok) return new Response(JSON.stringify({ data: answer.data, meta: { requestId, cursor: null } }), { status: 200, headers: { "content-type": "application/json" } });
      return errorResponse("not_found", answer.message, 404, requestId);
    }

    // The in-memory token's request: /api/v1's handler with the actor, told the decision already made.
    const headers = new Headers({ [API_V1_HEADERS.abilities]: CANVAS_API_ABILITIES.join(","), [API_V1_HEADERS.canReadSensitive]: "0" });
    const query = new URL(request.url).search;
    const req = new Request(`https://deploy-core.internal/v1/internal/api-v1/${orgPublicId}${apiPath}${query}`, { method: "GET", headers });
    const runners: Partial<ApiV1Runners> = { allows: async (action) => action === "deploy.resource.read" || auth.canWrite, ...deps.apiRunners };
    const res = await handleApiV1(req, env, requestId, actor, orgId, orgPublicId, apiPath!, runners);
    const text = await res.text();
    if (res.status === 200) return coolifyData(text, 200, requestId);
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON.
    }
    return apiFailure(res.status, body, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}
