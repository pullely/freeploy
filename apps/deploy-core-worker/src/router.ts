import type { Env } from "./env.js";
import { handleDestinations } from "./handlers/destinations.js";
import { handleHealth } from "./handlers/health.js";
import { handleCloudTokens } from "./handlers/cloud-tokens.js";
import { handleCloudInitScripts } from "./handlers/cloud-init-scripts.js";
import { handleProjects } from "./handlers/projects.js";
import { handlePrivateKeys } from "./handlers/private-keys.js";
import { handleServers } from "./handlers/servers.js";
import { errorResponse, notFound } from "./http.js";
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

/** Projects: the collection and up to three segments below it (a project's environment). */
export const ORG_DEPLOY_PROJECTS_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/projects((?:\/[^/]+){0,3})\/?$/;
/** Keys & Tokens → Cloud Tokens: the collection, a token, and a token's validate action. */
export const ORG_DEPLOY_CLOUD_TOKENS_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/cloud-tokens((?:\/[^/]+){0,2})\/?$/;
/** Keys & Tokens → Cloud-Init Scripts: the collection and a script. */
export const ORG_DEPLOY_CLOUD_INIT_SCRIPTS_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/cloud-init-scripts((?:\/[^/]+){0,1})\/?$/;
/** Keys & Tokens → Private Keys: the collection and up to two segments below it. */
export const ORG_DEPLOY_PRIVATE_KEYS_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/private-keys((?:\/[^/]+){0,2})\/?$/;
/** Servers: the collection and up to three segments below it (a settings page's action). */
export const ORG_DEPLOY_SERVERS_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/servers((?:\/[^/]+){0,3})\/?$/;
/** Destinations: the collection, one destination, and its resources. */
export const ORG_DEPLOY_DESTINATIONS_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/destinations((?:\/[^/]+){0,2})\/?$/;

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);
  try {
    if (url.pathname === "/health" && request.method === "GET") return handleHealth(env, requestId);

    const projects = url.pathname.match(ORG_DEPLOY_PROJECTS_RE);
    if (projects) {
      const orgId = parseOrgPublicId(projects[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      const segments = (projects[2] ?? "").split("/").filter(Boolean);
      return handleProjects(env, requestId, actor, orgId, segments, request);
    }

    const cloudTokens = url.pathname.match(ORG_DEPLOY_CLOUD_TOKENS_RE);
    const cloud = cloudTokens ?? url.pathname.match(ORG_DEPLOY_CLOUD_INIT_SCRIPTS_RE);
    if (cloud) {
      const orgId = parseOrgPublicId(cloud[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      const segments = (cloud[2] ?? "").split("/").filter(Boolean);
      return (cloudTokens ? handleCloudTokens : handleCloudInitScripts)(env, requestId, actor, orgId, segments, request);
    }

    const privateKeys = url.pathname.match(ORG_DEPLOY_PRIVATE_KEYS_RE);
    if (privateKeys) {
      const orgId = parseOrgPublicId(privateKeys[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      const segments = (privateKeys[2] ?? "").split("/").filter(Boolean);
      return handlePrivateKeys(env, requestId, actor, orgId, segments, request);
    }

    const servers = url.pathname.match(ORG_DEPLOY_SERVERS_RE);
    if (servers) {
      const orgId = parseOrgPublicId(servers[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      const segments = (servers[2] ?? "").split("/").filter(Boolean);
      return handleServers(env, requestId, actor, orgId, segments, request);
    }

    const destinations = url.pathname.match(ORG_DEPLOY_DESTINATIONS_RE);
    if (destinations) {
      const orgId = parseOrgPublicId(destinations[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      const segments = (destinations[2] ?? "").split("/").filter(Boolean);
      return handleDestinations(env, requestId, actor, orgId, segments, request);
    }
    return notFound(requestId, url.pathname);
  } catch {
    return errorResponse("internal_error", "Internal error", 500, requestId);
  }
}
