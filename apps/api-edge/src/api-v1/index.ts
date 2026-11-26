// Derived from coollabsio/coolify@91b7e3e:app/Http/Kernel.php (the global middleware and the `api` group),
// routes/api.php, app/Http/Middleware/{ThrottleFailedApiRequests,ApiAllowed,ApiIpAllowed,ApiAbility,
// ApiSensitiveData,EnsureTokenBelongsToCurrentTeamMember}.php, app/Http/Controllers/Api/OtherController.php
// (healthcheck, version), bootstrap/helpers/shared.php (checkIPAgainstAllowlist) and laravel/sanctum's
// CheckForAnyAbility (Apache-2.0 / MIT), modified.
//
// https://<edge>/api/* — Coolify's API, in the order Coolify's kernel runs it:
//
//   1. ThrottleFailedApiRequests (global): a blocked client gets 429 at once; a counted failure after the answer.
//   2. The route, or the fallback (Coolify's 404 shape) for everything Freeploy has not ported.
//   3. throttle:api (the `api` group): API_RATE_LIMIT a minute per user — the token's, which
//      $request->user() resolves — or per client IP without a valid token; its headers on every answer
//      except auth:sanctum's 401, which Laravel renders from an exception.
//   4. auth:sanctum: the bearer token ("<id>|<plain text>", or the plain text) — identity-worker resolves it
//      (once, before the throttle needs its user).
//   5. api.token.team: the token's user still belongs to its team, and the token has no more access than them.
//   6. ApiAllowed: API_ENABLED (Coolify's instance setting is_api_enabled) and API_ALLOWED_IPS (allowed_ips).
//   7. api.sensitive, then api.ability:<ability> (root passes).
//   8. The worker that answers: identity-worker (teams), deploy-core-worker (the rest), or the edge (version).
//
// The answers are Coolify's bodies byte for byte, never Freeploy's {error:{…}} envelope.
import type { Env } from "../env.js";
import { API_V1_HEADERS, COOLIFY_API, coolifyText, type CoolifyAnswer } from "@saas/contracts/coolify-api";
import {
  API_FAILED_REQUEST_RATE_LIMIT_DEFAULT,
  API_HEALTH_RATE_LIMIT,
  API_RATE_LIMIT_DEFAULT,
  TOO_MANY_ATTEMPTS_BODY,
  durableLimiterStore,
  failedBlockedBody,
  isCountedFailure,
  limitFromEnv,
  memoryLimiterStore,
  throttleHeaders,
  type LimiterStore,
} from "./limiters.js";
import { matchApiRoute } from "./routes.js";
import { ipAllowed } from "./ip-allowlist.js";

export function isApiV1Route(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

/** What identity-worker's /v1/internal/api-tokens/resolve answers. */
type Resolved =
  | { status: "unauthenticated" }
  | { status: "invalid_token"; userId: string }
  | { status: "exceeds_access"; userId: string }
  | { status: "ok"; tokenNumber: number; orgId: string; userId: string; abilities: string[]; canReadSensitive: boolean };

export interface ApiV1Deps {
  limiter?: LimiterStore;
  /** Unix seconds. */
  now?: () => number;
}

const isolateLimiter = memoryLimiterStore();

const toResponse = (a: CoolifyAnswer, extra?: Record<string, string>): Response =>
  new Response(a.body, { status: a.status, headers: { ...a.headers, ...extra } });

/** Request::bearerToken() */
function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const at = header.lastIndexOf("Bearer ");
  if (at === -1) return null;
  const token = header.slice(at + 7);
  return token === "" ? null : token;
}

/** client_ip(): Cloudflare's CF-Connecting-IP (the edge is behind Cloudflare). */
function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "0.0.0.0";
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function resolveToken(request: Request, env: Env, requestId: string): Promise<Resolved | null> {
  if (!env.IDENTITY_WORKER) return null;
  const headers = new Headers({ "x-request-id": requestId });
  const authorization = request.headers.get("authorization");
  if (authorization) headers.set("authorization", authorization);
  try {
    const res = await env.IDENTITY_WORKER.fetch("https://identity.internal/v1/internal/api-tokens/resolve", { method: "POST", headers });
    if (!res.ok) return null;
    return ((await res.json()) as { data: Resolved }).data;
  } catch {
    return null;
  }
}

const SERVICE_UNAVAILABLE: CoolifyAnswer = { status: 503, body: '{"message":"Service Unavailable"}', headers: { "content-type": "application/json" } };

async function forward(request: Request, env: Env, requestId: string, target: "identity" | "deploy", path: string, token: Extract<Resolved, { status: "ok" }>): Promise<Response> {
  const worker = target === "identity" ? env.IDENTITY_WORKER : env.DEPLOY_CORE_WORKER;
  if (!worker) return toResponse(SERVICE_UNAVAILABLE);
  const url = new URL(request.url);
  const internal = target === "identity" ? `https://identity.internal/v1/internal/api-v1${path}` : `https://deploy-core.internal/v1/internal/api-v1/${token.orgId}${path}`;
  const headers = new Headers({
    "x-request-id": requestId,
    "x-actor-subject-id": token.userId,
    "x-actor-subject-type": "user",
    [API_V1_HEADERS.org]: token.orgId,
    [API_V1_HEADERS.user]: token.userId,
    [API_V1_HEADERS.abilities]: token.abilities.join(","),
    [API_V1_HEADERS.canReadSensitive]: token.canReadSensitive ? "1" : "0",
    [API_V1_HEADERS.tokenNumber]: String(token.tokenNumber),
  });
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const init: RequestInit = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = await request.text();
  try {
    const res = await worker.fetch(internal + url.search, init);
    return new Response(res.body, { status: res.status, headers: res.headers });
  } catch {
    return toResponse(SERVICE_UNAVAILABLE);
  }
}

/** Steps 2–8: the request inside ThrottleFailedApiRequests. */
async function handleRoute(request: Request, env: Env, requestId: string, limiter: LimiterStore, now: number): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const ip = clientIp(request);
  const rateLimit = limitFromEnv(env.API_RATE_LIMIT, API_RATE_LIMIT_DEFAULT);
  // $request->user(): the token's user, resolved by Sanctum's guard; none without a valid token.
  const token = bearerToken(request.headers.get("authorization")) === null ? ({ status: "unauthenticated" } as const) : await resolveToken(request, env, requestId);
  if (!token) return toResponse(SERVICE_UNAVAILABLE);
  const method = request.method.toUpperCase();
  const health = (path === "/api/health" || path === "/api/v1/health") && (method === "GET" || method === "HEAD");
  const route = !health && path.startsWith("/api/v1/") ? matchApiRoute(method, path.slice("/api/v1".length)) : null;

  // auth:sanctum runs before throttle:api (Laravel's middleware priority): a request it refuses is not
  // counted, and its 401 (rendered from an exception) has none of the throttle's headers.
  if (route && token.status === "unauthenticated") return toResponse(COOLIFY_API.unauthenticated());

  const throttleKey = token.status === "unauthenticated" ? `api:ip:${ip}` : `api:user:${token.userId}`;
  // RateLimiter::for('api'): 1000 for the path 'api/health', API_RATE_LIMIT for everything else.
  const throttle = await limiter.throttle(throttleKey, path === "/api/health" ? API_HEALTH_RATE_LIMIT : rateLimit, now);
  if (!throttle.allowed) {
    return new Response(TOO_MANY_ATTEMPTS_BODY, { status: 429, headers: { "content-type": "application/json", ...throttleHeaders(throttle) } });
  }
  const rl = throttleHeaders(throttle);

  // OtherController::healthcheck, outside the authenticated groups.
  if (health) return toResponse(coolifyText("OK"), rl);
  if (!route || token.status === "unauthenticated") return toResponse(COOLIFY_API.notFound(), rl);
  // api.token.team
  if (token.status === "invalid_token") return toResponse(COOLIFY_API.invalidTokenTeam(), rl);
  if (token.status === "exceeds_access") return toResponse(COOLIFY_API.exceedsAccess(), rl);
  // ApiAllowed (Freeploy is one hosted instance: the operator's variables are Coolify's instance settings).
  if (env.API_ENABLED === "false") return toResponse(COOLIFY_API.apiDisabled(), rl);
  if (!ipAllowed(ip, env.API_ALLOWED_IPS)) return toResponse(COOLIFY_API.ipNotAllowed(), rl);
  // api.ability: root passes; else any one of the route's abilities.
  if (!token.abilities.includes("root") && !route.abilities.some((a) => token.abilities.includes(a) || token.abilities.includes("*"))) {
    return toResponse(COOLIFY_API.missingAbilities(route.abilities), rl);
  }
  // A second api.ability middleware (DP-85: api.ability:write then api.ability:deploy): each in turn.
  for (const ability of route.alsoAbilities ?? []) {
    if (!token.abilities.includes("root") && !token.abilities.includes(ability) && !token.abilities.includes("*")) return toResponse(COOLIFY_API.missingAbilities([ability]), rl);
  }

  if (route.target === "edge") return toResponse(coolifyText(COOLIFY_API.version), rl);
  const res = await forward(request, env, requestId, route.target, path.slice("/api/v1".length), token);
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(rl)) out.headers.set(k, v);
  return out;
}

/** https://<edge>/api/* */
export async function handleApiV1(request: Request, env: Env, requestId: string, deps?: ApiV1Deps): Promise<Response> {
  const limiter = deps?.limiter ?? (env.RATE_LIMITER_DO ? durableLimiterStore(env.RATE_LIMITER_DO) : isolateLimiter);
  const now = (deps?.now ?? (() => Math.floor(Date.now() / 1000)))();
  const path = new URL(request.url).pathname;
  const failedLimit = limitFromEnv(env.API_FAILED_REQUEST_RATE_LIMIT, API_FAILED_REQUEST_RATE_LIMIT_DEFAULT);
  // ThrottleFailedApiRequests: off at 0, and never for the health checks.
  if (failedLimit <= 0 || path === "/api/health" || path === "/api/v1/health") return handleRoute(request, env, requestId, limiter, now);

  const bearer = bearerToken(request.headers.get("authorization"));
  const key = bearer ? `failed:token:${await sha256Hex(bearer)}` : `failed:ip:${clientIp(request)}`;
  const blockedFor = await limiter.failedBlockedFor(key, now);
  if (blockedFor > 0) {
    return new Response(failedBlockedBody(blockedFor), { status: 429, headers: { "content-type": "application/json", "retry-after": String(blockedFor) } });
  }
  const response = await handleRoute(request, env, requestId, limiter, now);
  if (isCountedFailure(response.status, bearer !== null)) {
    // The team's ApiTokenFailingNotification is not sent (DP-70's note).
    await limiter.failedRecord(key, failedLimit, now);
  }
  return response;
}
