// The platform facade (freeploy-coolify-parity DP12): forwards /v1/platform/* — Coolify's instance-level
// pages (/settings/*, /admin, Team → Admin View), the platform operator's alone — to deploy-core-worker
// with the signed-in actor. deploy-core-worker asks policy-worker for the platform action, which only the
// deployment's PLATFORM_OPERATORS pass.
//
// Every failure to get there answers the same 404 as an unknown route: no credentials, a credential that
// does not resolve (a Coolify /api/v1 token, with any ability, `root` included, is refused by identity's
// resolve), an unavailable identity service. A customer, of any role, cannot tell the routes exist.
import type { Env } from "./env.js";
import { errorResponse, notFound, withEdgeTimings } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";

const PLATFORM_RE = /^\/v1\/platform(\/.*)?$/;
const METHODS = new Set(["GET", "PATCH"]);
const FORWARDED_HEADERS = ["content-type", "traceparent"];

export function isPlatformRoute(pathname: string): boolean {
  return PLATFORM_RE.test(pathname);
}

export async function handlePlatformRoute(request: Request, env: Env, requestId: string, pathname: string): Promise<Response> {
  if (!METHODS.has(request.method)) return notFound(requestId, pathname);
  return replayOrExecute(request, requestId, env, "deploy", async () => {
    if (!env.IDENTITY_WORKER || !env.DEPLOY_CORE_WORKER) return notFound(requestId, pathname);
    const timings = createTimings();
    const endTotal = timings.start("edge_total");
    const session = await timings.measure("edge_auth", () => resolveActor(request, env, requestId));
    if ("error" in session) return notFound(requestId, pathname);
    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("x-actor-subject-id", session.subjectId);
    headers.set("x-actor-subject-type", session.subjectType);
    headers.set("x-actor-email", session.email);
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const url = new URL(request.url);
    const target = new URL(pathname + url.search, "https://deploy-core.internal");
    const init: RequestInit = { method: request.method, headers };
    if (request.method === "PATCH") init.body = request.body;
    try {
      const downstream = await timings.measure("edge_downstream", () => env.DEPLOY_CORE_WORKER!.fetch(target.toString(), init));
      const res = new Response(downstream.body, { status: downstream.status, headers: downstream.headers });
      endTotal();
      return withEdgeTimings(res, requestId, "edge.platform", timings);
    } catch {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
  });
}
