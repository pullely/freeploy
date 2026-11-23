import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleListProjects } from "./handlers/list-projects.js";
import { errorResponse, notFound, methodNotAllowed } from "./http.js";
import { generateRequestId, parseOrgPublicId } from "./ids.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

export interface ActorContext {
  subjectId: string;
  subjectType: string;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  return header && REQUEST_ID_RE.test(header) ? header : generateRequestId();
}

function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  return subjectId && subjectType ? { subjectId, subjectType } : null;
}

export const ORG_DEPLOY_PROJECTS_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/projects$/;

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);
  try {
    if (url.pathname === "/health" && request.method === "GET") return handleHealth(env, requestId);

    const projects = url.pathname.match(ORG_DEPLOY_PROJECTS_RE);
    if (projects) {
      if (request.method !== "GET") return methodNotAllowed(requestId);
      const orgId = parseOrgPublicId(projects[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      return handleListProjects(env, requestId, actor, orgId);
    }
    return notFound(requestId, url.pathname);
  } catch {
    return errorResponse("internal_error", "Internal error", 500, requestId);
  }
}
