// Derived from coollabsio/coolify@91b7e3e:routes/api.php (Apache-2.0), modified.
//
// The /api/v1 routes Freeploy answers, with the api.ability each one has in routes/api.php and the worker
// that answers it. Every other path under /api answers routes/api.php's fallback, Coolify's 404
// ({"message":"Not found.","docs":…}) — also for the operations of openapi.json not ported yet.

export type Target = "edge" | "identity" | "deploy";

export interface ApiRoute {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** The path after /api/v1, with Coolify's {parameters}. */
  path: string;
  /** api.ability:… — any one of them (CheckForAnyAbility); root passes every check. */
  abilities: readonly string[];
  target: Target;
  /** A path this route does not take: an earlier route of routes/api.php Freeploy has not ported takes it (DP-78). */
  except?: RegExp;
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
  r("POST", "/servers", "write", "deploy"),
  r("DELETE", "/servers/{uuid}", "delete", "deploy"),

  // DP-71
  r("GET", "/applications", "read", "deploy"),
  r("GET", "/applications/{uuid}", "read", "deploy"),
  r("DELETE", "/applications/{uuid}", "delete", "deploy"),
  r("GET", "/applications/{uuid}/envs", "read", "deploy"),
  r("POST", "/applications/{uuid}/envs", "write", "deploy"),
  r("PATCH", "/applications/{uuid}/envs/bulk", "write", "deploy"),
  r("PATCH", "/applications/{uuid}/envs", "write", "deploy"),
  r("DELETE", "/applications/{uuid}/envs/{env_uuid}", "delete", "deploy"),
  r("GET", "/applications/{uuid}/logs", "read:sensitive", "deploy"),
  // OtherController::post_required: "This endpoint has changed to a POST request."
  r("GET", "/applications/{uuid}/start", "deploy", "deploy"),
  r("GET", "/applications/{uuid}/restart", "deploy", "deploy"),
  r("GET", "/applications/{uuid}/stop", "deploy", "deploy"),
  r("POST", "/applications/{uuid}/start", "deploy", "deploy"),
  r("POST", "/applications/{uuid}/restart", "deploy", "deploy"),
  r("POST", "/applications/{uuid}/stop", "deploy", "deploy"),
  // DP-81: HandlesTagsApi
  r("GET", "/applications/{uuid}/tags", "read", "deploy"),
  r("POST", "/applications/{uuid}/tags", "write", "deploy"),
  r("DELETE", "/applications/{uuid}/tags/{tag_uuid}", "delete", "deploy"),

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
  r("GET", "/services/{uuid}/envs", "read", "deploy"),
  r("POST", "/services/{uuid}/envs", "write", "deploy"),
  r("PATCH", "/services/{uuid}/envs/bulk", "write", "deploy"),
  r("PATCH", "/services/{uuid}/envs", "write", "deploy"),
  r("DELETE", "/services/{uuid}/envs/{env_uuid}", "delete", "deploy"),
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
