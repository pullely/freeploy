import type { Env } from "./env.js";
import { ENVIRONMENT_RESOURCE_PAGES, handleApplications, handleEnvironmentCanvas, handleEnvironmentResources } from "./handlers/applications.js";
import { handleDatabases } from "./handlers/databases.js";
import { handleDestinations } from "./handlers/destinations.js";
import { handleHealth } from "./handlers/health.js";
import { handleCloudTokens } from "./handlers/cloud-tokens.js";
import { handleIntegrationTokens } from "./handlers/integration-tokens.js";
import { handleCloudInitScripts } from "./handlers/cloud-init-scripts.js";
import { handleProjects } from "./handlers/projects.js";
import { handlePrivateKeys } from "./handlers/private-keys.js";
import { handleRegistries } from "./handlers/registries.js";
import { handleServers } from "./handlers/servers.js";
import { handleSharedVariables } from "./handlers/shared-variables.js";
import { handleServices } from "./handlers/services.js";
import { handleS3Storages, ORG_DEPLOY_STORAGES_RE } from "./handlers/s3-storages.js";
import { handleNotifications } from "./handlers/notifications.js";
import { errorResponse, notFound } from "./http.js";
import { generateRequestId, parseOrgPublicId } from "./ids.js";
import { API_V1_INTERNAL_RE, handleApiV1 } from "./api-v1/handler.js";
import { handleSources } from "./handlers/sources.js";
import { GIT_WEBHOOK_INTERNAL_RE, handleGitWebhook } from "./handlers/git-webhooks.js";
import { PLATFORM_RE, handlePlatform } from "./handlers/platform.js";
import { ORG_DEPLOY_CANVAS_RE, handleDeployCanvas } from "./handlers/deploy-canvas.js";
import { handleCanvasViews } from "./handlers/canvas-views.js";
import { ORG_DEPLOY_TAGS_RE, handleTagPages } from "./handlers/tag-pages.js";
import { ORG_DEPLOY_DASHBOARD_RE, handleDashboard } from "./handlers/dashboard.js";
import { ORG_DEPLOY_VULNERABILITIES_RE, handleFleetVulnerabilities } from "./handlers/image-scan-pages.js";
import { ORG_DEPLOY_TEAM_IMAGE_SCANNING_RE, handleTeamImageScanning } from "./handlers/image-scan-settings.js";
import { handleEnvironmentClone } from "./handlers/environment-clone.js";

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

/** Projects: the collection and up to four segments below it (a page of a project's environment), six for the environment canvas's save actions (DP-92). */
export const ORG_DEPLOY_PROJECTS_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/projects((?:\/[^/]+){0,6})\/?$/;
/** Applications: the collection and up to four segments below it (an application, one of its actions or pages, a row of a page). */
export const ORG_DEPLOY_APPLICATIONS_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/applications((?:\/[^/]+){0,4})\/?$/;
/** Standalone databases: the collection and up to four segments below it (a database, one of its actions or pages, a row of a page). */
export const ORG_DEPLOY_DATABASES_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/databases((?:\/[^/]+){0,4})\/?$/;
/** One-click services (DP-59): the collection, the template catalogue and a service; its configuration pages five segments deep (DP-66). */
export const ORG_DEPLOY_SERVICES_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/services((?:\/[^/]+){0,5})\/?$/;
/** Keys & Tokens → Cloud Tokens: the collection, a token, and a token's validate action. */
export const ORG_DEPLOY_CLOUD_TOKENS_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/cloud-tokens((?:\/[^/]+){0,2})\/?$/;
/** Keys & Tokens → Cloud-Init Scripts: the collection and a script. */
/** DP-104: Keys & Tokens → Integration Tokens: [/{uuid}[/refresh-zones]]. */
export const ORG_DEPLOY_INTEGRATION_TOKENS_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/integration-tokens((?:\/[^/]+){0,2})\/?$/;
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

/** Notifications (DP-67): the summary, a channel's page, and its test send. */
export const ORG_DEPLOY_NOTIFICATIONS_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/notifications((?:\/[^/]+){0,2})\/?$/;

/** Integrations → Git sources (DP-72): the list, a GitHub App and its actions, GitHub's two redirects, repositories and branches. */
export const ORG_DEPLOY_SOURCES_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/sources((?:\/[^/]+){0,6})\/?$/;

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);
  try {
    if (url.pathname === "/health" && request.method === "GET") return handleHealth(env, requestId);

    // Coolify's /api/v1 (DP-70), from api-edge once it has resolved the token: Coolify's answers, not Freeploy's envelope.
    const apiV1 = url.pathname.match(API_V1_INTERNAL_RE);
    if (apiV1) {
      const orgId = parseOrgPublicId(apiV1[1]!);
      const actor = resolveActor(request);
      if (!orgId || !actor) return new Response('{"message":"Unauthenticated."}', { status: 401, headers: { "content-type": "application/json" } });
      return handleApiV1(request, env, requestId, actor, orgId, apiV1[1]!, apiV1[2]!);
    }

    // The Git webhooks (DP-72), from api-edge's public /webhooks/source/*: no actor, the signature is the authentication.
    const gitWebhook = url.pathname.match(GIT_WEBHOOK_INTERNAL_RE);
    if (gitWebhook) return await handleGitWebhook(request, env, requestId, gitWebhook[1]!, gitWebhook[2] === "/manual");

    // The platform operator's pages (DP-79): no org; policy-worker's platform actions decide, a denial is a 404.
    const platform = url.pathname.match(PLATFORM_RE);
    if (platform) return await handlePlatform(env, requestId, resolveActor(request), platform[1] ?? "", request);

    const sources = url.pathname.match(ORG_DEPLOY_SOURCES_RE);
    if (sources) {
      const orgId = parseOrgPublicId(sources[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      return await handleSources(env, requestId, actor, orgId, sources[1]!, (sources[2] ?? "").split("/").filter(Boolean), request);
    }

    // The deploy canvas (DP-94): /canvas's page data, its option lists, its "New project" rows and its run.
    const deployCanvas = url.pathname.match(ORG_DEPLOY_CANVAS_RE);
    if (deployCanvas) {
      const orgId = parseOrgPublicId(deployCanvas[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      const below = (deployCanvas[2] ?? "").split("/").filter(Boolean);
      // DP-98: /canvas/api/… — the projects, servers, dashboard, shared variable and tag canvases (Coolify's /canvas/api paths).
      if (below[0] === "api") return await handleCanvasViews(env, requestId, actor, orgId, below.slice(1), request);
      return await handleDeployCanvas(env, requestId, actor, orgId, deployCanvas[1]!, below, request);
    }

    const projects = url.pathname.match(ORG_DEPLOY_PROJECTS_RE);
    const below = (projects?.[2] ?? "").split("/").filter(Boolean);
    // Five or six segments are the canvas's save actions only; any other path that deep is not a route of projects.
    if (projects && (below.length <= 4 || (below[1] === "environments" && below[3] === "canvas"))) {
      const orgId = parseOrgPublicId(projects[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      const segments = (projects[2] ?? "").split("/").filter(Boolean);
      // …/projects/{uuid}/environments/{env_uuid}/{new,resources}: the New Resource page and the environment's resources.
      if (segments.length === 4 && segments[1] === "environments" && ENVIRONMENT_RESOURCE_PAGES.includes(segments[3]!)) {
        return handleEnvironmentResources(env, requestId, actor, orgId, { projectUuid: segments[0]!, environmentUuid: segments[2]!, page: segments[3]! }, request);
      }
      // …/projects/{uuid}/environments/{env_uuid}/clone: the environment's Clone page (DP-100).
      if (segments.length === 4 && segments[1] === "environments" && segments[3] === "clone") {
        return handleEnvironmentClone(env, requestId, actor, orgId, { projectUuid: segments[0]!, environmentUuid: segments[2]! }, request);
      }
      // …/projects/{uuid}/environments/{env_uuid}/canvas/{positions,links[/{link_uuid}]}: the canvas's save actions (DP-92).
      if (segments.length > 4 && segments[1] === "environments" && segments[3] === "canvas") {
        return handleEnvironmentCanvas(env, requestId, actor, orgId, { projectUuid: segments[0]!, environmentUuid: segments[2]!, rest: segments.slice(4) }, request);
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

    const integrationTokens = url.pathname.match(ORG_DEPLOY_INTEGRATION_TOKENS_RE);
    if (integrationTokens) {
      const orgId = parseOrgPublicId(integrationTokens[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      const segments = (integrationTokens[2] ?? "").split("/").filter(Boolean);
      return handleIntegrationTokens(env, requestId, actor, orgId, segments, request);
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
    const storages = url.pathname.match(ORG_DEPLOY_STORAGES_RE);
    if (storages) {
      const orgId = parseOrgPublicId(storages[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      const segments = (storages[2] ?? "").split("/").filter(Boolean);
      return handleS3Storages(env, requestId, actor, orgId, segments, request);
    }

    const notifications = url.pathname.match(ORG_DEPLOY_NOTIFICATIONS_RE);
    if (notifications) {
      const orgId = parseOrgPublicId(notifications[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      const segments = (notifications[2] ?? "").split("/").filter(Boolean);
      return handleNotifications(env, requestId, actor, orgId, segments, request);
    }

    // The dashboard at / (DP-100).
    const dashboard = url.pathname.match(ORG_DEPLOY_DASHBOARD_RE);
    if (dashboard) {
      const orgId = parseOrgPublicId(dashboard[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      const segments = (dashboard[2] ?? "").split("/").filter(Boolean);
      return handleDashboard(env, requestId, actor, orgId, segments, request);
    }

    // The team's Security page at /vulnerabilities (DP-114).
    const vulnerabilities = url.pathname.match(ORG_DEPLOY_VULNERABILITIES_RE);
    if (vulnerabilities) {
      const orgId = parseOrgPublicId(vulnerabilities[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      const segments = (vulnerabilities[2] ?? "").split("/").filter(Boolean);
      return handleFleetVulnerabilities(env, requestId, actor, orgId, vulnerabilities[1]!, segments, request);
    }

    // The team's Image Scanning settings at /team/image-scanning (DP-116).
    const teamImageScanning = url.pathname.match(ORG_DEPLOY_TEAM_IMAGE_SCANNING_RE);
    if (teamImageScanning) {
      const orgId = parseOrgPublicId(teamImageScanning[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      return handleTeamImageScanning(env, requestId, actor, orgId, teamImageScanning[1]!, request);
    }

    // The team's Tags page (DP-97): a tag is named in the path, so each segment is decoded.
    const tags = url.pathname.match(ORG_DEPLOY_TAGS_RE);
    if (tags) {
      const orgId = parseOrgPublicId(tags[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      let segments: string[];
      try {
        segments = (tags[2] ?? "").split("/").filter(Boolean).map(decodeURIComponent);
      } catch {
        return errorResponse("not_found", "Not found", 404, requestId);
      }
      return handleTagPages(env, requestId, actor, orgId, segments, request);
    }
    return notFound(requestId, url.pathname);
  } catch {
    return errorResponse("internal_error", "Internal error", 500, requestId);
  }
}
