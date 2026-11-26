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

  r("GET", "/security/keys", "read", "deploy"),
  r("POST", "/security/keys", "write", "deploy"),
  r("GET", "/security/keys/{uuid}", "read", "deploy"),
  r("PATCH", "/security/keys/{uuid}", "write", "deploy"),
  r("DELETE", "/security/keys/{uuid}", "delete", "deploy"),

  r("GET", "/servers", "read", "deploy"),
  r("GET", "/servers/{uuid}", "read", "deploy"),
  r("POST", "/servers/{uuid}/validate", "write", "deploy"),

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
  return COMPILED.find(({ route, re }) => route.method === m && re.test(p))?.route ?? null;
}
