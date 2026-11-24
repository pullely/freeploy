import type { Env } from "./env";
import { errorResponse } from "./http";
import { replayOrExecute } from "./idempotency";
import { cacheApiStore, bearerToken } from "./actor-cache";

const LOGOUT_PATH = "/v1/auth/logout";

const AUTH_ROUTES: Record<string, string> = {
  "/v1/auth/login/start": "POST",
  "/v1/auth/login/complete": "POST",
  "/v1/auth/password/login": "POST",
  "/v1/auth/password/register": "POST",
  "/v1/auth/password/forgot": "POST",
  "/v1/auth/password/reset": "POST",
  "/v1/auth/password/change": "POST",
  "/v1/auth/password/confirm": "POST",
  "/v1/auth/two-factor/confirm": "POST",
  "/v1/auth/two-factor/recovery-codes": "POST",
  "/v1/auth/two-factor/challenge": "POST",
  "/v1/auth/passkeys/options": "POST",
  "/v1/auth/email/verification-notification": "POST",
  "/v1/auth/email/verify": "POST",
  "/v1/auth/account/deletion": "GET",
  "/v1/auth/account": "DELETE",
  "/v1/auth/email/change/verify": "POST",
  "/v1/auth/email/change/resend": "POST",
  "/v1/auth/passkeys/login/options": "POST",
  "/v1/auth/passkeys/login": "POST",
  "/v1/auth/session": "GET",
  "/v1/auth/resolve": "GET",
  "/v1/auth/logout": "POST",
  "/v1/auth/security-events": "GET",
};

const AUTH_MULTI_METHOD_ROUTES: Record<string, Set<string>> = {
  "/v1/auth/profile": new Set(["GET", "PATCH"]),
  "/v1/auth/two-factor": new Set(["GET", "POST", "DELETE"]),
  "/v1/auth/passkeys": new Set(["GET", "POST"]),
  "/v1/auth/email/change": new Set(["GET", "POST", "DELETE"]),
  "/v1/auth/avatar": new Set(["PUT", "DELETE"]),
};

// A user's avatar image (public GET).
const AVATAR_RE = /^\/v1\/auth\/avatar\/usr_[0-9a-f]{32}$/;

// One passkey: rename (PATCH) or delete (DELETE).
const PASSKEY_RE = /^\/v1\/auth\/passkeys\/[0-9a-f-]{36}$/;

// OAuth sign-in routes (all GET). `start` and `callback` are browser-redirect
// navigations; `providers` is a JSON read. The `:provider` segment is dynamic,
// so these are matched by pattern rather than the static route map.
const OAUTH_PROVIDERS_PATH = "/v1/auth/oauth/providers";
const OAUTH_START_RE = /^\/v1\/auth\/oauth\/[^/]+\/start$/;
const OAUTH_CALLBACK_RE = /^\/v1\/auth\/oauth\/[^/]+\/callback$/;

function isOAuthRoute(pathname: string): boolean {
  return (
    pathname === OAUTH_PROVIDERS_PATH ||
    OAUTH_START_RE.test(pathname) ||
    OAUTH_CALLBACK_RE.test(pathname)
  );
}

const FORWARDED_HEADERS = [
  "authorization",
  "content-type",
  "x-request-id",
  "traceparent",
  "idempotency-key",
  // Forwarded so the OAuth callback can read the state cookie set by `start`
  // (double-submit CSRF defense). Cookies are first-party to api-edge.
  "cookie",
];

/**
 * The steps that check a secret (a password, a code, a token, a passkey
 * assertion) and the sign-in flows: the brute-force targets, in the tight
 * `auth` rate-limit family. Everything else here is a signed-in user's own
 * account, in `account`.
 */
const SECRET_CHECKING = new Set([
  "/v1/auth/login/start",
  "/v1/auth/login/complete",
  "/v1/auth/logout",
  "/v1/auth/password/login",
  "/v1/auth/password/register",
  "/v1/auth/password/forgot",
  "/v1/auth/password/reset",
  "/v1/auth/password/change",
  "/v1/auth/password/confirm",
  "/v1/auth/two-factor/confirm",
  "/v1/auth/two-factor/challenge",
  "/v1/auth/passkeys/login/options",
  "/v1/auth/passkeys/login",
  "/v1/auth/email/verify",
  "/v1/auth/email/change/verify",
  "/v1/auth/account",
]);

export function rateLimitFamilyFor(pathname: string): "auth" | "account" {
  return SECRET_CHECKING.has(pathname) || pathname.startsWith("/v1/auth/oauth/") ? "auth" : "account";
}

export function isAuthRoute(pathname: string): boolean {
  return pathname in AUTH_ROUTES || pathname in AUTH_MULTI_METHOD_ROUTES || isOAuthRoute(pathname) || PASSKEY_RE.test(pathname) || AVATAR_RE.test(pathname);
}

export async function handleAuthRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  const expectedMethod = AUTH_ROUTES[pathname];
  const allowedMethods = AUTH_MULTI_METHOD_ROUTES[pathname] ?? (PASSKEY_RE.test(pathname) ? new Set(["PATCH", "DELETE"]) : AVATAR_RE.test(pathname) ? new Set(["GET"]) : undefined);
  const oauth = isOAuthRoute(pathname);

  if (!expectedMethod && !allowedMethods && !oauth) {
    return errorResponse("not_found", `Route not found: ${pathname}`, 404, requestId);
  }

  if (oauth) {
    if (request.method !== "GET") {
      return errorResponse("unsupported", "Method not allowed", 405, requestId);
    }
  } else if (expectedMethod && request.method !== expectedMethod) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  } else if (allowedMethods && !allowedMethods.has(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  return replayOrExecute(request, requestId, env, rateLimitFamilyFor(pathname), async () => {
    if (!env.IDENTITY_WORKER) {
      return errorResponse(
        "internal_error",
        "Authentication service unavailable",
        503,
        requestId,
      );
    }

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    for (const name of FORWARDED_HEADERS) {
      if (name === "x-request-id") continue;
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const url = new URL(request.url);
    const target = new URL(pathname + url.search, "https://identity.internal");

    const init: RequestInit = {
      method: request.method,
      headers,
      // OAuth `start`/`callback` return 302s (to the provider, then back to the
      // console). Without manual mode the service-binding fetch would FOLLOW
      // them server-side instead of handing the redirect to the browser.
      // Other auth routes never redirect, so this is inert for them.
      redirect: "manual",
    };

    if (request.method === "POST" || request.method === "PATCH") {
      init.body = request.body;
    }

    try {
      const downstream = await env.IDENTITY_WORKER.fetch(target.toString(), init);
      // On a successful logout, evict the cached actor so the (now-revoked)
      // session can't be served from the edge cache for the rest of its TTL.
      if (pathname === LOGOUT_PATH && downstream.ok) {
        const token = bearerToken(request.headers.get("authorization"));
        if (token) await cacheApiStore().evict(token);
      }
      return new Response(downstream.body, {
        status: downstream.status,
        headers: downstream.headers,
      });
    } catch {
      return errorResponse(
        "internal_error",
        "Authentication service unavailable",
        503,
        requestId,
      );
    }
  });
}
