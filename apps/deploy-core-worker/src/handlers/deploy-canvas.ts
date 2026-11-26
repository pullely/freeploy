// Derived from coollabsio/coolify@91b7e3e:app/Livewire/DeployCanvas.php (serviceTemplates, serviceLogos,
// canAddProjects), app/Http/Middleware/UseSessionTeamApiToken.php, routes/web.php (the /canvas/api group the
// deploy canvas calls) and resources/js/deploy-canvas.js (LOADERS, the "New project" and "New environment"
// rows) (Apache-2.0), modified.
//
// The deploy canvas's endpoints (DP-94). Coolify's canvas calls its /api/v1 controllers at /canvas/api with
// the browser session, which UseSessionTeamApiToken turns into an in-memory token of the page's team (admins
// and owners: read, write, deploy, read:sensitive). Freeploy does the same in-process: each call below is
// answered by deploy-core-worker's own /api/v1 handler (handleApiV1) for the console's actor, with the
// abilities read, write and deploy — not read:sensitive, since nothing the canvas shows is sensitive — so
// the rules, messages and policy checks are /api/v1's. Every route asks deploy.resource.write first (the
// canvas creates resources; Coolify's member reads only) and answers a denial with the 404 every denial
// gets; each /api/v1 call then runs inside withOrg.
//
//   GET  /v1/organizations/{org}/deploy/canvas                                           the page's data: can_add, the
//                                                                                         one-click templates and their logos
//   GET  …/deploy/canvas/options/projects                                               [uuid, name] (GET /projects)
//   GET  …/deploy/canvas/options/projects/{uuid}/environments                           [uuid, name]
//   GET  …/deploy/canvas/options/servers                                                [uuid, name (unreachable)], not build-only
//   GET  …/deploy/canvas/options/servers/{uuid}/destinations                            [uuid, "name · network"]
//   GET  …/deploy/canvas/options/security/keys                                          [uuid, name]
//   GET  …/deploy/canvas/options/github-apps                                            ["id|uuid", name], private Apps with an App ID (DP-95)
//   GET  …/deploy/canvas/options/github-apps/{id}/repositories                          [full_name, full_name] (DP-93's route, GitHub through
//                                                                                         the context's fetch)
//   GET  …/deploy/canvas/options/github-apps/{id}/repositories/{owner}/{repo}/branches  [name, name] (DP-93's route)
//   POST …/deploy/canvas/projects { name }                                              POST /projects → { uuid }
//   POST …/deploy/canvas/projects/{uuid}/environments { name }                          POST /projects/{uuid}/environments → { uuid }
//   POST …/deploy/canvas/run { action: save|deploy, plan }                              validate() and runFlow() (applications/deploy-canvas.ts)
//
// Lists answer [value, label] pairs instead of /api/v1's rows, so no key material leaves the worker.
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { API_V1_HEADERS } from "@saas/contracts/coolify-api";
import { handleApiV1, type ApiV1Runners } from "../api-v1/handler.js";
import { errorResponse, methodNotAllowed, successResponse } from "../http.js";
import { authorizeDeploy } from "./cloud-tokens.js";
import { serviceTemplates } from "../services/catalogue.js";
import { headline } from "../services/catalogue-build.js";
import { serviceLogoUrls } from "../services/service.js";
import { DEPLOY_CANVAS_MESSAGES, apiErrorMessage, parsePlan, planFollows, runPlan, validatePlan, type CanvasCall } from "../applications/deploy-canvas.js";

export const ORG_DEPLOY_CANVAS_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/canvas((?:\/[^/]+){0,7})\/?$/;

/** UseSessionTeamApiToken's abilities for an admin or owner, without read:sensitive. */
export const DEPLOY_CANVAS_ABILITIES = ["read", "write", "deploy"] as const;

export interface DeployCanvasDeps {
  /** handleApiV1's runners (the stores and policy-worker's answer); replaceable for tests. */
  apiRunners?: Partial<ApiV1Runners>;
}

type Row = Record<string, unknown>;
type Option = [string, string];

const UUID_RE = /^[A-Za-z0-9_-]{1,255}$/;
/** A GitHub owner or repository name (load_branches() checks the same characters). */
const GITHUB_NAME_RE = /^[A-Za-z0-9_.-]{1,255}$/;
const isObject = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);
const rows = (body: unknown): Row[] => (Array.isArray(body) ? body.filter(isObject) : []);
const text = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/** DeployCanvas::serviceTemplates(): [key, headline(key)], by name. */
export function deployCanvasServiceTemplates(): Option[] {
  return Object.keys(serviceTemplates())
    .map((key): Option => [key, headline(key)])
    .sort((a, b) => (a[1].toLowerCase() < b[1].toLowerCase() ? -1 : a[1].toLowerCase() > b[1].toLowerCase() ? 1 : 0));
}

/** DeployCanvas::serviceLogos(): key → [logo, fallback]; templates without a logo are left out. */
export function deployCanvasServiceLogos(): Record<string, [string, string]> {
  const out: Record<string, [string, string]> = {};
  for (const [key, entry] of Object.entries(serviceTemplates())) {
    const logo = (entry as { logo?: unknown }).logo;
    if (typeof logo !== "string" || logo === "" || logo.slice(logo.lastIndexOf("/") + 1) === "default.webp") continue;
    const urls = serviceLogoUrls(logo);
    out[key] = [urls.logo, urls.logo_default_url];
  }
  return out;
}

/** deploy-canvas.js' LOADERS: the /api/v1 path of each list, and its options. */
const LISTS: Array<{ match: (s: string[]) => boolean; path: (s: string[]) => string; options: (body: unknown) => Option[] }> = [
  { match: (s) => s.length === 1 && s[0] === "projects", path: () => "/projects", options: (b) => rows(b).map((p) => [text(p.uuid), text(p.name)]) },
  {
    match: (s) => s.length === 3 && s[0] === "projects" && UUID_RE.test(s[1]!) && s[2] === "environments",
    path: (s) => `/projects/${encodeURIComponent(s[1]!)}/environments`,
    options: (b) => rows(b).map((e) => [text(e.uuid), text(e.name)]),
  },
  {
    match: (s) => s.length === 1 && s[0] === "servers",
    path: () => "/servers",
    // Build-only servers cannot run resources (as on the New resource page).
    options: (b) =>
      rows(b)
        .filter((s) => !isObject(s.settings) || s.settings.server_role !== "build")
        .map((s) => [text(s.uuid), `${text(s.name)}${s.is_reachable === false ? " (unreachable)" : ""}`]),
  },
  {
    match: (s) => s.length === 3 && s[0] === "servers" && UUID_RE.test(s[1]!) && s[2] === "destinations",
    path: (s) => `/servers/${encodeURIComponent(s[1]!)}/destinations`,
    options: (b) => rows(b).map((d) => [text(d.uuid), `${text(d.name)} · ${text(d.network)}`]),
  },
  { match: (s) => s.length === 2 && s[0] === "security" && s[1] === "keys", path: () => "/security/keys", options: (b) => rows(b).map((k) => [text(k.uuid), text(k.name)]) },
  // DP-95: the Git step's "GitHub app" access. The App's value carries its id (the repositories and branches
  // routes) and its uuid (POST /applications/private-github-app); public Apps and those without an App ID cannot
  // be installed on a private repository.
  {
    match: (s) => s.length === 1 && s[0] === "github-apps",
    path: () => "/github-apps",
    options: (b) =>
      rows(b)
        .filter((a) => !a.is_public && a.app_id)
        .map((a) => [`${text(a.id)}|${text(a.uuid)}`, text(a.name)]),
  },
  {
    match: (s) => s.length === 3 && s[0] === "github-apps" && UUID_RE.test(s[1]!) && s[2] === "repositories",
    path: (s) => `/github-apps/${encodeURIComponent(s[1]!)}/repositories`,
    options: (b) => rows(isObject(b) ? b.repositories : null).map((r) => [text(r.full_name), text(r.full_name)]),
  },
  {
    match: (s) => s.length === 6 && s[0] === "github-apps" && UUID_RE.test(s[1]!) && s[2] === "repositories" && GITHUB_NAME_RE.test(s[3]!) && GITHUB_NAME_RE.test(s[4]!) && s[5] === "branches",
    path: (s) => `/github-apps/${encodeURIComponent(s[1]!)}/repositories/${encodeURIComponent(s[3]!)}/${encodeURIComponent(s[4]!)}/branches`,
    options: (b) => rows(isObject(b) ? b.branches : null).map((r) => [text(r.name), text(r.name)]),
  },
];

/** An /api/v1 failure in Freeploy's envelope: its message, and its field errors as details.fields. */
function apiFailure(status: number, body: unknown, requestId: string): Response {
  const b = isObject(body) ? body : {};
  const code = status === 404 ? "not_found" : status === 422 ? "validation_failed" : status === 400 ? "bad_request" : status === 403 ? "forbidden" : status === 501 ? "unsupported" : "error";
  const details: Row = {};
  if (isObject(b.errors)) details.fields = b.errors;
  return errorResponse(code, typeof b.message === "string" && b.message ? b.message : apiErrorMessage(status, body), status, requestId, Object.keys(details).length ? details : undefined);
}

/**
 * segments: what follows /deploy/canvas. `orgPublicId` is the org as the path names it (Coolify's team in
 * /api/v1's answers).
 */
export async function handleDeployCanvas(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  orgPublicId: string,
  segments: string[],
  request: Request,
  deps: DeployCanvasDeps = {},
): Promise<Response> {
  const method = request.method;
  const [first, ...rest] = segments;
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  const isPage = first === undefined;
  const isOptions = first === "options" && LISTS.some((l) => l.match(rest));
  const isCreate = first === "projects" && (rest.length === 0 || (rest.length === 2 && UUID_RE.test(rest[0]!) && rest[1] === "environments"));
  const isRun = first === "run" && rest.length === 0;
  if (!isPage && !isOptions && !isCreate && !isRun) return notFound();
  if (((isPage || isOptions) && method !== "GET") || ((isCreate || isRun) && method !== "POST")) return methodNotAllowed(requestId);

  const auth = await authorizeDeploy(env, requestId, actor, orgId, true);
  if (!auth.ok) return auth.response;

  /** One /api/v1 call, answered in-process for the actor (UseSessionTeamApiToken's in-memory token). */
  const call = async (callMethod: string, path: string, body?: { text: string; contentType: string }) => {
    const headers = new Headers({ [API_V1_HEADERS.abilities]: DEPLOY_CANVAS_ABILITIES.join(","), [API_V1_HEADERS.canReadSensitive]: "0" });
    if (body) headers.set("content-type", body.contentType);
    const req = new Request(`https://deploy-core.internal/v1/internal/api-v1/${orgPublicId}${path}`, { method: callMethod, headers, ...(body && { body: body.text }) });
    const res = await handleApiV1(req, env, requestId, actor, orgId, orgPublicId, path, deps.apiRunners ?? {});
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // Empty body.
    }
    return { status: res.status, body: data };
  };

  try {
    if (isPage) {
      // canAddProjects: who reaches the canvas may create projects (deploy.resource.write).
      return successResponse({ can_add: true, service_templates: deployCanvasServiceTemplates(), service_logos: deployCanvasServiceLogos() }, requestId);
    }
    if (isOptions) {
      const list = LISTS.find((l) => l.match(rest))!;
      const res = await call("GET", list.path(rest));
      if (res.status !== 200) return apiFailure(res.status, res.body, requestId);
      return successResponse(list.options(res.body), requestId);
    }
    if (isCreate) {
      // The "New project" and "New environment" rows: the body goes to /api/v1 as it came, for its own checks.
      const path = rest.length ? `/projects/${encodeURIComponent(rest[0]!)}/environments` : "/projects";
      const res = await call("POST", path, { text: await request.text(), contentType: request.headers.get("content-type") ?? "" });
      if (res.status !== 201) return apiFailure(res.status, res.body, requestId);
      return successResponse({ uuid: text(isObject(res.body) ? res.body.uuid : "") }, requestId, 201);
    }
    return await run(request, requestId, async (m, path, body) => call(m, path, body && { text: JSON.stringify(body), contentType: "application/json" }));
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}

/** POST …/canvas/run: the body's checks, validate(), then runFlow(). */
async function run(request: Request, requestId: string, call: CanvasCall): Promise<Response> {
  let body: unknown;
  // The plan is read as sent (no TrimStrings): a Dockerfile or a Compose file goes to /api/v1 byte for byte, as Coolify's browser sends it.
  try {
    body = JSON.parse(await request.text());
  } catch {
    return errorResponse("bad_request", "Invalid request.", 400, requestId, { error: "Invalid JSON." });
  }
  if (!isObject(body)) return errorResponse("bad_request", "Invalid request.", 400, requestId, { error: "Invalid JSON." });
  const fields: Record<string, string[]> = {};
  if (body.action === undefined || body.action === null || body.action === "") fields.action = [DEPLOY_CANVAS_MESSAGES.actionRequired];
  else if (body.action !== "save" && body.action !== "deploy") fields.action = [DEPLOY_CANVAS_MESSAGES.invalidAction];
  const plan = parsePlan(body.plan);
  if (!plan) fields.plan = [DEPLOY_CANVAS_MESSAGES.invalidPlan];
  if (Object.keys(fields).length) return errorResponse("validation_failed", "Validation failed.", 422, requestId, { fields });
  if (!planFollows(plan!)) return errorResponse("validation_failed", DEPLOY_CANVAS_MESSAGES.cannotFollow, 422, requestId, { problems: [DEPLOY_CANVAS_MESSAGES.cannotFollow], invalid: [] });
  const { problems, invalid } = validatePlan(plan!);
  if (problems.length) return errorResponse("validation_failed", problems[0]!, 422, requestId, { problems, invalid });
  return successResponse(await runPlan(call, body.action as "save" | "deploy", plan!), requestId);
}
