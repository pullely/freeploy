import type { Env } from "./env.js";
import { ENVIRONMENT_RESOURCE_PAGES, handleApplications, handleEnvironmentResources } from "./handlers/applications.js";
import { handleDatabases } from "./handlers/databases.js";
import { handleDestinations } from "./handlers/destinations.js";
import { handleHealth } from "./handlers/health.js";
import { handleCloudTokens } from "./handlers/cloud-tokens.js";
import { handleCloudInitScripts } from "./handlers/cloud-init-scripts.js";
import { handleProjects } from "./handlers/projects.js";
import { handlePrivateKeys } from "./handlers/private-keys.js";
import { handleRegistries } from "./handlers/registries.js";
import { handleServers } from "./handlers/servers.js";
import { handleSharedVariables } from "./handlers/shared-variables.js";
import { handleServices } from "./handlers/services.js";
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

/** Projects: the collection and up to four segments below it (a page of a project's environment). */
export const ORG_DEPLOY_PROJECTS_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/projects((?:\/[^/]+){0,4})\/?$/;
/** Applications: the collection and up to four segments below it (an application, one of its actions or pages, a row of a page). */
export const ORG_DEPLOY_APPLICATIONS_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/applications((?:\/[^/]+){0,4})\/?$/;
/** Standalone databases: the collection and up to four segments below it (a database, one of its actions or pages, a row of a page). */
export const ORG_DEPLOY_DATABASES_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/databases((?:\/[^/]+){0,4})\/?$/;
/** One-click services (DP-59): the collection, the template catalogue and a service. */
export const ORG_DEPLOY_SERVICES_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/services((?:\/[^/]+){0,1})\/?$/;
/** Keys & Tokens → Cloud Tokens: the collection, a token, and a token's validate action. */
export const ORG_DEPLOY_CLOUD_TOKENS_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/cloud-tokens((?:\/[^/]+){0,2})\/?$/;
/** Keys & Tokens → Cloud-Init Scripts: the collection and a script. */
export const ORG_DEPLOY_CLOUD_INIT_SCRIPTS_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/cloud-init-scripts((?:\/[^/]+){0,1})\/?$/;
/** Keys & Tokens → Private Keys: the collection and up to two segments below it. */
export const ORG_DEPLOY_PRIVATE_KEYS_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/private-keys((?:\/[^/]+){0,2})\/?$/;
/** Servers: the collection and up to four segments below it (a settings page's action; a registry's login check). */
export const ORG_DEPLOY_SERVERS_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/servers((?:\/[^/]+){0,4})\/?$/;
/** Destinations: the collection, one destination, and its resources. */
export const ORG_DEPLOY_DESTINATIONS_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/destinations((?:\/[^/]+){0,2})\/?$/;

/** Integrations → Registries: the overview (a server's registries are below /servers). */
export const ORG_DEPLOY_REGISTRIES_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/registries\/?$/;
/** Shared Variables: the overview and up to four segments below it (a scope's kind and uuid, a variable, its lock). */
export const ORG_DEPLOY_SHARED_VARIABLES_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/shared-variables((?:\/[^/]+){0,4})\/?$/;

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
      // …/projects/{uuid}/environments/{env_uuid}/{new,resources}: the New Resource page and the environment's resources.
      if (segments.length === 4 && segments[1] === "environments" && ENVIRONMENT_RESOURCE_PAGES.includes(segments[3]!)) {
        return handleEnvironmentResources(env, requestId, actor, orgId, { projectUuid: segments[0]!, environmentUuid: segments[2]!, page: segments[3]! }, request);
      }
      return handleProjects(env, requestId, actor, orgId, segments, request);
    }

    const applications = url.pathname.match(ORG_DEPLOY_APPLICATIONS_RE);
    if (applications) {
      const orgId = parseOrgPublicId(applications[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      const segments = (applications[2] ?? "").split("/").filter(Boolean);
      return handleApplications(env, requestId, actor, orgId, segments, request);
    }

    const databases = url.pathname.match(ORG_DEPLOY_DATABASES_RE);
    if (databases) {
      const orgId = parseOrgPublicId(databases[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      const segments = (databases[2] ?? "").split("/").filter(Boolean);
      return handleDatabases(env, requestId, actor, orgId, segments, request);
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

    const registries = url.pathname.match(ORG_DEPLOY_REGISTRIES_RE);
    if (registries) {
      const orgId = parseOrgPublicId(registries[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      return handleRegistries(env, requestId, actor, orgId, [], request);
    }

    const sharedVariables = url.pathname.match(ORG_DEPLOY_SHARED_VARIABLES_RE);
    if (sharedVariables) {
      const orgId = parseOrgPublicId(sharedVariables[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      const segments = (sharedVariables[2] ?? "").split("/").filter(Boolean);
      return handleSharedVariables(env, requestId, actor, orgId, segments, request);
    }
    const services = url.pathname.match(ORG_DEPLOY_SERVICES_RE);
    if (services) {
      const orgId = parseOrgPublicId(services[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      const segments = (services[2] ?? "").split("/").filter(Boolean);
      return handleServices(env, requestId, actor, orgId, segments, request);
    }
    return notFound(requestId, url.pathname);
  } catch {
    return errorResponse("internal_error", "Internal error", 500, requestId);
  }
}
