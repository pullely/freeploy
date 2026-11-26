// Derived from coollabsio/coolify@91b7e3e:routes/api.php (Apache-2.0), modified.
//
// The /api/v1 routes Freeploy answers, with the api.ability each one has in routes/api.php and the worker
// that answers it. Every other path under /api answers routes/api.php's fallback, Coolify's 404
// ({"message":"Not found.","docs":…}) — also for the operations of openapi.json not ported yet.

export type Target = "edge" | "identity" | "deploy";

export interface ApiRoute {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** The path after /api/v1, with Coolify's {parameters}. */
  path: string;
  /** api.ability:… — any one of them (CheckForAnyAbility); root passes every check. */
  abilities: readonly string[];
  target: Target;
  /**
   * A path this route does not take: an earlier route of routes/api.php Freeploy has not ported takes it (DP-78), or the
   * route's parameter constraint refuses it (->whereNumber(), DP-88).
   */
  except?: RegExp;
  /** The abilities of the route's further api.ability middlewares, each needed in turn (DP-85). */
  alsoAbilities?: readonly string[];
}

const r = (method: ApiRoute["method"], path: string, ability: string, target: Target): ApiRoute => ({ method, path, abilities: [ability], target });

/** In routes/api.php's order: Laravel takes the first route that matches. */
export const API_V1_ROUTES: readonly ApiRoute[] = [
  r("GET", "/version", "read", "edge"),
  r("GET", "/teams", "read", "identity"),
  r("GET", "/team", "read", "identity"),
  r("GET", "/team/members", "read", "identity"),
  r("GET", "/teams/current", "read", "identity"),
  r("GET", "/teams/current/members", "read", "identity"),
  // DP-85: the team's notification channels
  ...["email", "discord", "slack", "telegram", "pushover", "webhook"].flatMap((channel) => [r("GET", `/notifications/${channel}`, "read", "deploy"), r("PATCH", `/notifications/${channel}`, "write", "deploy")]),
  // DP-84: the team's shared variables (deploy-core-worker's, as the other shared variables are)
  r("GET", "/team/envs", "read", "deploy"),
  r("POST", "/team/envs", "write", "deploy"),
  r("PATCH", "/team/envs/{env_id}", "write", "deploy"),
  r("DELETE", "/team/envs/{env_id}", "delete", "deploy"),
  r("GET", "/teams/{id}", "read", "identity"),
  r("GET", "/teams/{id}/members", "read", "identity"),

  r("GET", "/projects", "read", "deploy"),
  r("GET", "/projects/{uuid}", "read", "deploy"),
  r("GET", "/projects/{uuid}/environments", "read", "deploy"),
  r("POST", "/projects/{uuid}/environments", "write", "deploy"),
  r("PATCH", "/projects/{uuid}/environments/{environment_name_or_uuid}", "write", "deploy"),
  r("DELETE", "/projects/{uuid}/environments/{environment_name_or_uuid}", "delete", "deploy"),
  r("POST", "/projects", "write", "deploy"),
  r("PATCH", "/projects/{uuid}", "write", "deploy"),
  r("DELETE", "/projects/{uuid}", "delete", "deploy"),
  // DP-81: the shared variables of a project and of an environment, before /projects/{uuid}/{environment_name_or_uuid}
  // (routes/api.php's order), which therefore never takes /projects/{uuid}/envs.
  r("GET", "/projects/{uuid}/envs", "read", "deploy"),
  r("POST", "/projects/{uuid}/envs", "write", "deploy"),
  r("PATCH", "/projects/{uuid}/envs/{env_id}", "write", "deploy"),
  r("DELETE", "/projects/{uuid}/envs/{env_id}", "delete", "deploy"),
  r("GET", "/projects/{uuid}/environments/{environment_name_or_uuid}/envs", "read", "deploy"),
  r("POST", "/projects/{uuid}/environments/{environment_name_or_uuid}/envs", "write", "deploy"),
  r("PATCH", "/projects/{uuid}/environments/{environment_name_or_uuid}/envs/{env_id}", "write", "deploy"),
  r("DELETE", "/projects/{uuid}/environments/{environment_name_or_uuid}/envs/{env_id}", "delete", "deploy"),
  // DP-78: after /projects/{uuid}/environments and the shared variables' routes (routes/api.php's order).
  r("GET", "/projects/{uuid}/{environment_name_or_uuid}", "read", "deploy"),
  r("GET", "/resources", "read", "deploy"),
  // DP-81: the team's tags
  r("GET", "/tags", "read", "deploy"),
  r("POST", "/tags", "write", "deploy"),
  r("PATCH", "/tags/{uuid}", "write", "deploy"),
  r("DELETE", "/tags/{uuid}", "delete", "deploy"),

  r("GET", "/security/keys", "read", "deploy"),
  r("POST", "/security/keys", "write", "deploy"),
  r("GET", "/security/keys/{uuid}", "read", "deploy"),
  r("PATCH", "/security/keys/{uuid}", "write", "deploy"),
  r("DELETE", "/security/keys/{uuid}", "delete", "deploy"),
  // DP-104: integration tokens
  r("GET", "/security/integration-tokens", "read", "deploy"),
  r("POST", "/security/integration-tokens", "write", "deploy"),
  r("GET", "/security/integration-tokens/{uuid}", "read", "deploy"),
  r("PATCH", "/security/integration-tokens/{uuid}", "write", "deploy"),
  r("DELETE", "/security/integration-tokens/{uuid}", "delete", "deploy"),
  r("POST", "/security/integration-tokens/{uuid}/sync-zones", "write", "deploy"),

  // DP-88: GitHub Apps
  r("GET", "/github-apps", "read", "deploy"),
  r("POST", "/github-apps", "write", "deploy"),
  r("PATCH", "/github-apps/{github_app_id}", "write", "deploy"),
  r("DELETE", "/github-apps/{github_app_id}", "delete", "deploy"),
  // DP-93: through a GitHub App, which asks GitHub
  r("GET", "/github-apps/{github_app_id}/repositories", "read", "deploy"),
  r("GET", "/github-apps/{github_app_id}/repositories/{owner}/{repo}/branches", "read", "deploy"),

  // DP-90: cloud provider tokens
  r("GET", "/cloud-tokens", "read", "deploy"),
  r("POST", "/cloud-tokens", "write", "deploy"),
  r("GET", "/cloud-tokens/{uuid}", "read", "deploy"),
  r("PATCH", "/cloud-tokens/{uuid}", "write", "deploy"),
  r("DELETE", "/cloud-tokens/{uuid}", "delete", "deploy"),
  r("POST", "/cloud-tokens/{uuid}/validate", "write", "deploy"),
  // DP-90: what each cloud provider offers, read through a cloud provider token
  ...["locations", "server-types", "images", "ssh-keys", "firewalls", "networks"].map((what) => r("GET", `/hetzner/${what}`, "read", "deploy")),
  ...["regions", "plans", "os", "ssh-keys"].map((what) => r("GET", `/vultr/${what}`, "read", "deploy")),
  ...["regions", "sizes", "images", "ssh-keys"].map((what) => r("GET", `/digitalocean/${what}`, "read", "deploy")),
  ...["data-centers", "catalog", "templates", "ssh-keys", "post-install-scripts"].map((what) => r("GET", `/hostinger/${what}`, "read", "deploy")),

  // DP-81: S3 storages
  r("GET", "/s3-storages", "read", "deploy"),
  r("POST", "/s3-storages", "write", "deploy"),
  r("GET", "/s3-storages/{uuid}", "read", "deploy"),
  r("PATCH", "/s3-storages/{uuid}", "write", "deploy"),
  r("DELETE", "/s3-storages/{uuid}", "delete", "deploy"),
  r("POST", "/s3-storages/{uuid}/validate", "write", "deploy"),

  r("GET", "/servers", "read", "deploy"),
  r("GET", "/servers/{uuid}", "read", "deploy"),
  r("POST", "/servers/{uuid}/validate", "write", "deploy"),
  // DP-78
  r("GET", "/servers/{uuid}/domains", "read", "deploy"),
  r("GET", "/servers/{uuid}/resources", "read", "deploy"),
  // DP-85: a server's Docker cleanup (run needs write and deploy: routes/api.php gives it both api.ability middlewares)
  r("GET", "/servers/{uuid}/docker-cleanup", "read", "deploy"),
  r("PATCH", "/servers/{uuid}/docker-cleanup", "write", "deploy"),
  { ...r("POST", "/servers/{uuid}/docker-cleanup/run", "write", "deploy"), alsoAbilities: ["deploy"] },
  r("GET", "/servers/{uuid}/docker-cleanup/executions", "read", "deploy"),
  // DP-88: a server's log drains, Sentinel, image scanning, Cloudflare Tunnel, host key, registries, proxy and transfer
  // (POST /servers/import and POST …/transfer/complete are not ported; PUT …/proxy/configuration is DP-90's)
  r("GET", "/servers/{uuid}/log-drains", "read", "deploy"),
  { ...r("PATCH", "/servers/{uuid}/log-drains", "write", "deploy"), alsoAbilities: ["deploy"] },
  r("GET", "/servers/{uuid}/sentinel", "read", "deploy"),
  { ...r("PATCH", "/servers/{uuid}/sentinel", "write", "deploy"), alsoAbilities: ["deploy"] },
  r("GET", "/servers/{uuid}/image-scanning", "read", "deploy"),
  r("PATCH", "/servers/{uuid}/image-scanning", "write", "deploy"),
  r("GET", "/servers/{uuid}/cloudflare-tunnel", "read", "deploy"),
  r("PATCH", "/servers/{uuid}/cloudflare-tunnel", "write", "deploy"),
  r("POST", "/servers/{uuid}/cloudflare-tunnel/enable", "write", "deploy"),
  r("POST", "/servers/{uuid}/cloudflare-tunnel/disable", "write", "deploy"),
  r("POST", "/servers/{uuid}/host-key/reset", "write", "deploy"),
  r("GET", "/servers/{uuid}/registries", "read:sensitive", "deploy"),
  { ...r("POST", "/servers/{uuid}/registries", "write", "deploy"), alsoAbilities: ["deploy"] },
  { ...r("POST", "/servers/{uuid}/registries/{registry}/check", "write", "deploy"), alsoAbilities: ["deploy"] },
  r("DELETE", "/servers/{uuid}/registries/{registry}", "delete", "deploy"),
  r("GET", "/servers/{uuid}/proxy", "read", "deploy"),
  r("PATCH", "/servers/{uuid}/proxy", "write", "deploy"),
  // DP-90
  r("PUT", "/servers/{uuid}/proxy/configuration", "write", "deploy"),
  r("POST", "/servers/{uuid}/proxy/restart", "deploy", "deploy"),
  { ...r("GET", "/servers/import/check", "write", "deploy"), alsoAbilities: ["deploy"] },
  // api.ability:read,write — either one.
  { method: "GET", path: "/servers/{uuid}/transfer", abilities: ["read", "write"], target: "deploy" },
  r("POST", "/servers/{uuid}/migrate", "write", "deploy"),
  // DP-85: destinations (in routes/api.php after the servers' settings routes; no route here matches both)
  r("GET", "/destinations", "read", "deploy"),
  r("GET", "/destinations/{uuid}", "read", "deploy"),
  r("PATCH", "/destinations/{uuid}", "write", "deploy"),
  r("DELETE", "/destinations/{uuid}", "delete", "deploy"),
  r("GET", "/servers/{server_uuid}/destinations", "read", "deploy"),
  r("POST", "/servers/{server_uuid}/destinations", "write", "deploy"),
  // DP-85: a server's shared variables
  r("GET", "/servers/{uuid}/envs", "read", "deploy"),
  r("POST", "/servers/{uuid}/envs", "write", "deploy"),
  r("PATCH", "/servers/{uuid}/envs/{env_id}", "write", "deploy"),
  r("DELETE", "/servers/{uuid}/envs/{env_id}", "delete", "deploy"),
  r("POST", "/servers", "write", "deploy"),
  // DP-93: a Hostinger VPS bought and stored as a server
  r("POST", "/servers/hostinger", "write", "deploy"),
  r("DELETE", "/servers/{uuid}", "delete", "deploy"),

  // DP-71
  r("GET", "/applications", "read", "deploy"),
  // DP-87: the create types (DP-93: private-github-app; private-gitea-app is not ported)
  r("POST", "/applications/public", "write", "deploy"),
  r("POST", "/applications/private-deploy-key", "write", "deploy"),
  r("POST", "/applications/private-github-app", "write", "deploy"),
  r("POST", "/applications/dockerfile", "write", "deploy"),
  r("POST", "/applications/dockerimage", "write", "deploy"),
  r("GET", "/applications/{uuid}", "read", "deploy"),
  // DP-87
  r("PATCH", "/applications/{uuid}", "write", "deploy"),
  r("DELETE", "/applications/{uuid}", "delete", "deploy"),
  r("GET", "/applications/{uuid}/envs", "read", "deploy"),
  r("POST", "/applications/{uuid}/envs", "write", "deploy"),
  r("PATCH", "/applications/{uuid}/envs/bulk", "write", "deploy"),
  r("PATCH", "/applications/{uuid}/envs", "write", "deploy"),
  r("DELETE", "/applications/{uuid}/envs/{env_uuid}", "delete", "deploy"),
  r("GET", "/applications/{uuid}/logs", "read:sensitive", "deploy"),
  // DP-86: a preview's container logs (logs_by_uuid with a pull request)
  r("GET", "/applications/{uuid}/previews/{pull_request_id}/logs", "read:sensitive", "deploy"),
  // DP-84: an application's storages
  r("GET", "/applications/{uuid}/storages", "read", "deploy"),
  r("POST", "/applications/{uuid}/storages", "write", "deploy"),
  r("PATCH", "/applications/{uuid}/storages", "write", "deploy"),
  r("DELETE", "/applications/{uuid}/storages/{storage_uuid}", "delete", "deploy"),
  // DP-88: a storage's backup schedule (run needs write and deploy)
  r("PUT", "/applications/{uuid}/storages/{storage_uuid}/backups", "write", "deploy"),
  { ...r("POST", "/applications/{uuid}/storages/{storage_uuid}/backups/run", "write", "deploy"), alsoAbilities: ["deploy"] },
  r("DELETE", "/applications/{uuid}/storages/{storage_uuid}/backups", "delete", "deploy"),
  // OtherController::post_required: "This endpoint has changed to a POST request."
  r("GET", "/applications/{uuid}/start", "deploy", "deploy"),
  r("GET", "/applications/{uuid}/restart", "deploy", "deploy"),
  r("GET", "/applications/{uuid}/stop", "deploy", "deploy"),
  r("POST", "/applications/{uuid}/start", "deploy", "deploy"),
  r("POST", "/applications/{uuid}/restart", "deploy", "deploy"),
  r("POST", "/applications/{uuid}/stop", "deploy", "deploy"),
  // DP-86: an application's previews (ApplicationPreviewsController; update and delete are ApplicationsController's)
  r("GET", "/applications/{uuid}/previews", "read", "deploy"),
  r("POST", "/applications/{uuid}/previews", "deploy", "deploy"),
  r("GET", "/applications/{uuid}/previews/{pull_request_id}", "read", "deploy"),
  r("PATCH", "/applications/{uuid}/previews/{pull_request_id}", "write", "deploy"),
  r("DELETE", "/applications/{uuid}/previews/{pull_request_id}", "delete", "deploy"),
  // DP-81: HandlesTagsApi
  r("GET", "/applications/{uuid}/tags", "read", "deploy"),
  r("POST", "/applications/{uuid}/tags", "write", "deploy"),
  r("DELETE", "/applications/{uuid}/tags/{tag_uuid}", "delete", "deploy"),
  // DP-86: move, migrate and clone; the additional destinations
  r("POST", "/applications/{uuid}/move", "write", "deploy"),
  r("POST", "/applications/{uuid}/migrate", "write", "deploy"),
  r("POST", "/applications/{uuid}/clone", "write", "deploy"),
  // DP-88: the rollback images and a rollback
  r("GET", "/applications/{uuid}/rollback-images", "read", "deploy"),
  r("POST", "/applications/{uuid}/rollback", "deploy", "deploy"),
  r("GET", "/applications/{uuid}/destinations", "read", "deploy"),
  r("POST", "/applications/{uuid}/destinations", "write", "deploy"),
  r("DELETE", "/applications/{uuid}/destinations/{destination_uuid}", "delete", "deploy"),

  // DP-73: the standalone databases (the eight engines Freeploy has; POST /databases/sqlite is not ported) and their
  // backup schedules
  r("GET", "/databases", "read", "deploy"),
  r("POST", "/databases/postgresql", "write", "deploy"),
  r("POST", "/databases/mysql", "write", "deploy"),
  r("POST", "/databases/mariadb", "write", "deploy"),
  r("POST", "/databases/mongodb", "write", "deploy"),
  r("POST", "/databases/redis", "write", "deploy"),
  r("POST", "/databases/clickhouse", "write", "deploy"),
  r("POST", "/databases/dragonfly", "write", "deploy"),
  r("POST", "/databases/keydb", "write", "deploy"),
  r("GET", "/databases/{uuid}", "read", "deploy"),
  r("GET", "/databases/{uuid}/backups", "read", "deploy"),
  r("GET", "/databases/{uuid}/backups/{scheduled_backup_uuid}/executions", "read", "deploy"),
  r("PATCH", "/databases/{uuid}", "write", "deploy"),
  r("POST", "/databases/{uuid}/backups", "write", "deploy"),
  r("PATCH", "/databases/{uuid}/backups/{scheduled_backup_uuid}", "write", "deploy"),
  r("DELETE", "/databases/{uuid}", "delete", "deploy"),
  r("DELETE", "/databases/{uuid}/backups/{scheduled_backup_uuid}", "delete", "deploy"),
  r("DELETE", "/databases/{uuid}/backups/{scheduled_backup_uuid}/executions/{execution_uuid}", "delete", "deploy"),
  // DP-88: a database's imports (an import's status: ->whereNumber('activity_id')) and its container logs
  r("POST", "/databases/{uuid}/imports/uploads", "write", "deploy"),
  r("POST", "/databases/{uuid}/imports", "write", "deploy"),
  { ...r("GET", "/databases/{uuid}/imports/{activity_id}", "read", "deploy"), except: /\/imports\/(?!\d+$)[^/]+$/ },
  r("GET", "/databases/{uuid}/logs", "read:sensitive", "deploy"),
  // DP-84: a database's storages and environment variables
  r("GET", "/databases/{uuid}/storages", "read", "deploy"),
  r("POST", "/databases/{uuid}/storages", "write", "deploy"),
  r("PATCH", "/databases/{uuid}/storages", "write", "deploy"),
  r("DELETE", "/databases/{uuid}/storages/{storage_uuid}", "delete", "deploy"),
  // DP-88
  r("PUT", "/databases/{uuid}/storages/{storage_uuid}/backups", "write", "deploy"),
  { ...r("POST", "/databases/{uuid}/storages/{storage_uuid}/backups/run", "write", "deploy"), alsoAbilities: ["deploy"] },
  r("DELETE", "/databases/{uuid}/storages/{storage_uuid}/backups", "delete", "deploy"),
  r("GET", "/databases/{uuid}/envs", "read", "deploy"),
  r("POST", "/databases/{uuid}/envs", "write", "deploy"),
  r("PATCH", "/databases/{uuid}/envs/bulk", "write", "deploy"),
  r("PATCH", "/databases/{uuid}/envs", "write", "deploy"),
  r("DELETE", "/databases/{uuid}/envs/{env_uuid}", "delete", "deploy"),
  // OtherController::post_required
  r("GET", "/databases/{uuid}/start", "deploy", "deploy"),
  r("GET", "/databases/{uuid}/restart", "deploy", "deploy"),
  r("GET", "/databases/{uuid}/stop", "deploy", "deploy"),
  r("POST", "/databases/{uuid}/start", "deploy", "deploy"),
  r("POST", "/databases/{uuid}/restart", "deploy", "deploy"),
  r("POST", "/databases/{uuid}/stop", "deploy", "deploy"),
  // DP-81: HandlesTagsApi
  r("GET", "/databases/{uuid}/tags", "read", "deploy"),
  r("POST", "/databases/{uuid}/tags", "write", "deploy"),
  r("DELETE", "/databases/{uuid}/tags/{tag_uuid}", "delete", "deploy"),
  // DP-86: move, migrate and clone
  r("POST", "/databases/{uuid}/move", "write", "deploy"),
  r("POST", "/databases/{uuid}/migrate", "write", "deploy"),
  r("POST", "/databases/{uuid}/clone", "write", "deploy"),

  // DP-74: deploying and deployments (GET /deployments and GET /deployments/{uuid}: DP-78), then services and
  // their environment variables. routes/api.php's /deploy and /deployments come before /servers; no route here
  // matches both, so the order between the groups does not change which route answers.
  // OtherController::post_required
  r("GET", "/deploy", "deploy", "deploy"),
  r("POST", "/deploy", "deploy", "deploy"),
  // DP-78
  r("GET", "/deployments", "read", "deploy"),
  r("GET", "/deployments/{uuid}", "read", "deploy"),
  r("POST", "/deployments/{uuid}/cancel", "deploy", "deploy"),
  r("GET", "/deployments/applications/{uuid}", "read", "deploy"),
  r("GET", "/services", "read", "deploy"),
  r("POST", "/services", "write", "deploy"),
  r("GET", "/services/{uuid}", "read", "deploy"),
  r("PATCH", "/services/{uuid}", "write", "deploy"),
  r("DELETE", "/services/{uuid}", "delete", "deploy"),
  // DP-84: a service's storages
  r("GET", "/services/{uuid}/storages", "read", "deploy"),
  r("POST", "/services/{uuid}/storages", "write", "deploy"),
  r("PATCH", "/services/{uuid}/storages", "write", "deploy"),
  r("DELETE", "/services/{uuid}/storages/{storage_uuid}", "delete", "deploy"),
  // DP-88
  r("PUT", "/services/{uuid}/storages/{storage_uuid}/backups", "write", "deploy"),
  { ...r("POST", "/services/{uuid}/storages/{storage_uuid}/backups/run", "write", "deploy"), alsoAbilities: ["deploy"] },
  r("DELETE", "/services/{uuid}/storages/{storage_uuid}/backups", "delete", "deploy"),
  r("GET", "/services/{uuid}/envs", "read", "deploy"),
  r("POST", "/services/{uuid}/envs", "write", "deploy"),
  r("PATCH", "/services/{uuid}/envs/bulk", "write", "deploy"),
  r("PATCH", "/services/{uuid}/envs", "write", "deploy"),
  r("DELETE", "/services/{uuid}/envs/{env_uuid}", "delete", "deploy"),
  // DP-85: a service's applications and databases (DP-88: and a service database's imports)
  r("GET", "/services/{uuid}/applications", "read", "deploy"),
  r("GET", "/services/{uuid}/applications/{app_uuid}", "read", "deploy"),
  r("PATCH", "/services/{uuid}/applications/{app_uuid}", "write", "deploy"),
  r("GET", "/services/{uuid}/applications/{app_uuid}/logs", "read:sensitive", "deploy"),
  r("POST", "/services/{uuid}/applications/{app_uuid}/logs", "read:sensitive", "deploy"),
  // OtherController::post_required
  r("GET", "/services/{uuid}/applications/{app_uuid}/start", "deploy", "deploy"),
  r("GET", "/services/{uuid}/applications/{app_uuid}/restart", "deploy", "deploy"),
  r("GET", "/services/{uuid}/applications/{app_uuid}/stop", "deploy", "deploy"),
  r("POST", "/services/{uuid}/applications/{app_uuid}/start", "deploy", "deploy"),
  r("POST", "/services/{uuid}/applications/{app_uuid}/restart", "deploy", "deploy"),
  r("POST", "/services/{uuid}/applications/{app_uuid}/stop", "deploy", "deploy"),
  r("GET", "/services/{uuid}/databases", "read", "deploy"),
  r("GET", "/services/{uuid}/databases/{database_uuid}", "read", "deploy"),
  r("PATCH", "/services/{uuid}/databases/{database_uuid}", "write", "deploy"),
  // DP-88
  r("POST", "/services/{uuid}/databases/{database_uuid}/imports/uploads", "write", "deploy"),
  r("POST", "/services/{uuid}/databases/{database_uuid}/imports", "write", "deploy"),
  { ...r("GET", "/services/{uuid}/databases/{database_uuid}/imports/{activity_id}", "read", "deploy"), except: /\/imports\/(?!\d+$)[^/]+$/ },
  r("GET", "/services/{uuid}/databases/{database_uuid}/logs", "read:sensitive", "deploy"),
  r("POST", "/services/{uuid}/databases/{database_uuid}/start", "deploy", "deploy"),
  r("POST", "/services/{uuid}/databases/{database_uuid}/restart", "deploy", "deploy"),
  r("POST", "/services/{uuid}/databases/{database_uuid}/stop", "deploy", "deploy"),
  // OtherController::post_required
  r("GET", "/services/{uuid}/start", "deploy", "deploy"),
  r("GET", "/services/{uuid}/restart", "deploy", "deploy"),
  r("GET", "/services/{uuid}/stop", "deploy", "deploy"),
  r("POST", "/services/{uuid}/start", "deploy", "deploy"),
  r("POST", "/services/{uuid}/restart", "deploy", "deploy"),
  r("POST", "/services/{uuid}/stop", "deploy", "deploy"),
  // DP-81: HandlesTagsApi
  r("GET", "/services/{uuid}/tags", "read", "deploy"),
  r("POST", "/services/{uuid}/tags", "write", "deploy"),
  r("DELETE", "/services/{uuid}/tags/{tag_uuid}", "delete", "deploy"),
  // DP-86: move and migrate (clone is not ported: clone_service() has no port yet)
  r("POST", "/services/{uuid}/move", "write", "deploy"),
  r("POST", "/services/{uuid}/migrate", "write", "deploy"),
  // DP-88: a service's container logs
  r("GET", "/services/{uuid}/logs", "read:sensitive", "deploy"),

  // DP-84: the scheduled tasks of an application and of a service (DP-88: and executing one now)
  r("GET", "/applications/{uuid}/scheduled-tasks", "read", "deploy"),
  r("POST", "/applications/{uuid}/scheduled-tasks", "write", "deploy"),
  r("PATCH", "/applications/{uuid}/scheduled-tasks/{task_uuid}", "write", "deploy"),
  r("DELETE", "/applications/{uuid}/scheduled-tasks/{task_uuid}", "delete", "deploy"),
  r("GET", "/applications/{uuid}/scheduled-tasks/{task_uuid}/executions", "read", "deploy"),
  r("POST", "/applications/{uuid}/scheduled-tasks/{task_uuid}/execute", "deploy", "deploy"),
  r("GET", "/services/{uuid}/scheduled-tasks", "read", "deploy"),
  r("POST", "/services/{uuid}/scheduled-tasks", "write", "deploy"),
  r("PATCH", "/services/{uuid}/scheduled-tasks/{task_uuid}", "write", "deploy"),
  r("DELETE", "/services/{uuid}/scheduled-tasks/{task_uuid}", "delete", "deploy"),
  r("GET", "/services/{uuid}/scheduled-tasks/{task_uuid}/executions", "read", "deploy"),
  r("POST", "/services/{uuid}/scheduled-tasks/{task_uuid}/execute", "deploy", "deploy"),
];

/** Laravel's route parameters match one segment ([^/]+). */
function compile(path: string): RegExp {
  return new RegExp(`^${path.replace(/\{\w+\}/g, "[^/]+")}$`);
}
const COMPILED = API_V1_ROUTES.map((route) => ({ route, re: compile(route.path) }));

/** The route of a request below /api/v1, or null (the fallback answers). A trailing slash is ignored, as Laravel does. */
export function matchApiRoute(method: string, path: string): ApiRoute | null {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  return COMPILED.find(({ route, re }) => route.method === m && re.test(p) && !route.except?.test(p))?.route ?? null;
}
