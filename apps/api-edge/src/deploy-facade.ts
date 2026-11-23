// The deploy facade (freeploy-coolify-parity DP2): forwards
// /v1/organizations/{org}/deploy/* to deploy-core-worker after resolving the
// actor, the same way the project facade forwards to projects-worker.
import type { Env } from "./env.js";
import { errorResponse, withEdgeTimings } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";

const ORG_DEPLOY_RE = /^\/v1\/organizations\/[^/]+\/deploy(\/.*)?$/;
const METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);
const FORWARDED_HEADERS = ["content-type", "traceparent", "idempotency-key"];

export function isDeployRoute(pathname: string): boolean {
  return ORG_DEPLOY_RE.test(pathname);
}

export async function handleDeployRoute(request: Request, env: Env, requestId: string, pathname: string): Promise<Response> {
  if (!METHODS.has(request.method)) return errorResponse("unsupported", "Method not allowed", 405, requestId);
  return replayOrExecute(request, requestId, env, "deploy", async () => {
    if (!env.IDENTITY_WORKER) return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    if (!env.DEPLOY_CORE_WORKER) return errorResponse("internal_error", "Deploy service unavailable", 503, requestId);
    const timings = createTimings();
    const endTotal = timings.start("edge_total");
    const session = await timings.measure("edge_auth", () => resolveActor(request, env, requestId));
    if ("error" in session) return session.error;
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
    if (request.method !== "GET" && request.method !== "DELETE") init.body = request.body;
    try {
      const downstream = await timings.measure("edge_downstream", () => env.DEPLOY_CORE_WORKER!.fetch(target.toString(), init));
      const res = new Response(downstream.body, { status: downstream.status, headers: downstream.headers });
      endTotal();
      return withEdgeTimings(res, requestId, "edge.deploy", timings);
    } catch {
      return errorResponse("internal_error", "Deploy service unavailable", 503, requestId);
    }
  });
}
