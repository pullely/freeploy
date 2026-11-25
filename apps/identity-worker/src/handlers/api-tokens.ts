// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Security/ApiTokens.php (mount, getTokens,
// addNewToken, revoke), app/Models/User.php (createToken), laravel/sanctum's Guard and
// PersonalAccessToken::findToken, app/Http/Middleware/EnsureTokenBelongsToCurrentTeamMember.php and
// app/Http/Middleware/ApiSensitiveData.php (Apache-2.0 / MIT), modified.
//
// Keys & Tokens → API Tokens on identity API keys (migration 720), and the token check behind /api/v1.
//
//   GET    /v1/organizations/{org}/api-tokens            the page: the user's tokens in the org, and what they may give
//   POST   /v1/organizations/{org}/api-tokens            addNewToken { description, expiresInDays, permissions, scopeMode }
//                                                         → 201 { token: "<id>|<plain text>" }, shown once
//   DELETE /v1/organizations/{org}/api-tokens/{id}       revoke
//   POST   /v1/internal/api-tokens/resolve               (api-edge only) the bearer token of an /api/v1 request:
//                                                         auth:sanctum, then api.token.team and api.sensitive
//
// A token belongs to the user who made it and to one org. It authenticates nothing but /api/v1, where it acts
// as its user with its abilities; GET /v1/auth/resolve refuses it.
import type { Env } from "../env.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createApiTokenStore, type ApiTokenRow, type ApiTokenStore } from "@saas/db/identity";
import { fetchAuthorizationContext } from "../membership-client.js";
import { errorResponse, successResponse } from "../http.js";
import { parseOrgPublicId, parseSubjectUuid, userPublicId } from "../ids.js";
import {
  bearerToken,
  canReadSensitive,
  coolifyRole,
  EXPIRATION_OPTIONS,
  generateSecret,
  permissionsFor,
  sha256Hex,
  splitToken,
  timingSafeEqual,
  tokenWithinCreatorAccess,
  validateTokenForm,
  type CoolifyRole,
} from "../api-tokens/rules.js";

export const ORG_API_TOKENS_RE = /^\/v1\/organizations\/([^/]+)\/api-tokens(?:\/([^/]+))?$/;
export const API_TOKEN_RESOLVE_PATH = "/v1/internal/api-tokens/resolve";

export interface ApiTokenDeps {
  /** Runs fn with the token store, in one transaction. Replaceable in tests. */
  withStore?: <T>(fn: (store: ApiTokenStore) => Promise<T>) => Promise<T>;
  /** The user's Coolify role in the org, or null when not a member. Replaceable in tests. */
  roleOf?: (userPublicId: string, orgUuid: string, requestId: string) => Promise<CoolifyRole | null>;
  now?: () => Date;
  random?: (n: number) => Uint8Array;
}

function storeRunner(env: Env, deps?: ApiTokenDeps) {
  if (deps?.withStore) return deps.withStore;
  return async <T>(fn: (store: ApiTokenStore) => Promise<T>): Promise<T> => {
    const db = createSqlExecutor(env.PLATFORM_DB!);
    try {
      return await db.transaction((tx) => fn(createApiTokenStore(tx)));
    } finally {
      await db.dispose();
    }
  };
}

function roleResolver(env: Env, deps?: ApiTokenDeps) {
  if (deps?.roleOf) return deps.roleOf;
  return async (userId: string, orgUuid: string, requestId: string): Promise<CoolifyRole | null> => {
    const ctx = await fetchAuthorizationContext(env.MEMBERSHIP_WORKER!, userId, "user", orgUuid, requestId);
    if (!ctx.ok) return null;
    // Coolify's roles are team-wide: only org-wide Freeploy roles count (a project role alone is not a team member).
    return coolifyRole(ctx.memberships.filter((m) => m.scope.kind === "organization").map((m) => m.role));
  };
}

/** The page's row of a token (the columns the view reads). */
function tokenView(t: ApiTokenRow) {
  return {
    id: t.tokenNumber,
    name: t.name,
    abilities: t.abilities,
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    expiresAt: t.expiresAt?.toISOString() ?? null,
  };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const b: unknown = await request.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** /v1/organizations/{org}/api-tokens[/{id}], forwarded by api-edge with the signed-in user. */
export async function handleApiTokens(request: Request, env: Env, requestId: string, deps?: ApiTokenDeps): Promise<Response> {
  const url = new URL(request.url);
  const m = url.pathname.match(ORG_API_TOKENS_RE);
  if (!m) return errorResponse("not_found", "Not found", 404, requestId);
  const [, orgPublic, tokenSegment] = m;
  const method = request.method;
  if (tokenSegment === undefined ? method !== "GET" && method !== "POST" : method !== "DELETE") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }
  if (!deps?.withStore && !env.PLATFORM_DB) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  if (!deps?.roleOf && !env.MEMBERSHIP_WORKER) return errorResponse("internal_error", "Service unavailable", 503, requestId);

  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || subjectType !== "user") return errorResponse("unauthorized", "Unauthorized", 401, requestId);
  const userUuid = parseSubjectUuid(subjectId);
  const orgUuid = parseOrgPublicId(orgPublic!);
  if (!userUuid || !orgUuid) return errorResponse("not_found", "Not found", 404, requestId);

  // ApiTokenPolicy: any member may manage their own tokens; what they may give depends on their role.
  const role = await roleResolver(env, deps)(subjectId, orgUuid, requestId);
  if (!role) return errorResponse("not_found", "Not found", 404, requestId);
  const withStore = storeRunner(env, deps);
  const now = (deps?.now ?? (() => new Date()))();

  try {
    if (method === "GET") {
      const tokens = await withStore((s) => s.list(orgUuid, userUuid));
      return successResponse(
        {
          tokens: tokens.map(tokenView),
          ...permissionsFor(role),
          expirationOptions: EXPIRATION_OPTIONS.map(([days, label]) => ({ value: String(days), label })),
        },
        requestId,
      );
    }

    if (method === "POST") {
      const v = validateTokenForm(await readJson(request), role);
      // handleError(): the page shows the message as an error toast.
      if (!v.ok) return errorResponse("validation_failed", v.message, 422, requestId);
      const secret = generateSecret(deps?.random);
      const expiresAt = v.expiresInDays === null ? null : new Date(now.getTime() + v.expiresInDays * 86_400_000);
      // Sanctum stores the SHA-256 of what follows "<id>|".
      const keyHash = await sha256Hex(secret);
      const row = await withStore((s) =>
        s.create({
          id: crypto.randomUUID(),
          servicePrincipalId: crypto.randomUUID(),
          orgId: orgUuid,
          userId: userUuid,
          name: v.name,
          abilities: v.abilities,
          keyPrefix: secret.slice(0, 8),
          keyHash,
          expiresAt,
          createdAt: now,
        }),
      );
      // Do NOT strip the numeric prefix: Sanctum (and so /api/v1) finds the token by it.
      return successResponse({ token: `${row.tokenNumber}|${secret}`, apiToken: tokenView(row) }, requestId, 201);
    }

    // DELETE: findOwnToken() then delete(); someone else's token is not found.
    const number = /^\d+$/.test(tokenSegment!) ? Number(tokenSegment) : NaN;
    if (!Number.isSafeInteger(number)) return errorResponse("not_found", "Not found", 404, requestId);
    const revoked = await withStore((s) => s.revoke(orgUuid, userUuid, number, now));
    if (!revoked) return errorResponse("not_found", "Not found", 404, requestId);
    return successResponse({ revoked: true, id: number }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}

/** What api-edge needs to answer an /api/v1 request as Coolify's middleware would. */
export type ResolvedApiToken =
  | { status: "unauthenticated" }
  | { status: "invalid_token"; userId: string }
  | { status: "exceeds_access"; tokenNumber: number; userId: string }
  | { status: "ok"; tokenNumber: number; orgId: string; userId: string; abilities: string[]; canReadSensitive: boolean };

/**
 * auth:sanctum (the bearer token, its expiry, its user), then api.token.team (the user is still a member
 * of the token's team, and the token has no more access than the user) and api.sensitive.
 */
export async function resolveApiToken(authorization: string | null, env: Env, requestId: string, deps?: ApiTokenDeps): Promise<ResolvedApiToken> {
  const token = bearerToken(authorization);
  if (!token) return { status: "unauthenticated" };
  const { tokenNumber, secret } = splitToken(token);
  const withStore = storeRunner(env, deps);
  const now = (deps?.now ?? (() => new Date()))();
  const hash = await sha256Hex(secret);
  const row = await withStore(async (s) => {
    const found = tokenNumber === null ? await s.findByHash(hash) : Number.isSafeInteger(tokenNumber) ? await s.findByNumber(tokenNumber) : null;
    if (!found || !timingSafeEqual(found.keyHash, hash)) return null;
    // Guard::isValidAccessToken: not expired (and Freeploy's: not revoked); the tokenable still exists.
    if (found.status !== "active" || found.revokedAt) return null;
    if (found.expiresAt && found.expiresAt.getTime() <= now.getTime()) return null;
    if (!(await s.userIsActive(found.userId))) return null;
    await s.touch(found.id, now);
    return found;
  });
  if (!row) return { status: "unauthenticated" };
  const userId = userPublicId(row.userId);
  const role = await roleResolver(env, deps)(userId, row.orgId, requestId);
  if (!role) return { status: "invalid_token", userId };
  if (!tokenWithinCreatorAccess(role, row.abilities)) return { status: "exceeds_access", tokenNumber: row.tokenNumber, userId };
  return {
    status: "ok",
    tokenNumber: row.tokenNumber,
    orgId: `org_${row.orgId.replace(/-/g, "")}`,
    userId,
    abilities: row.abilities,
    canReadSensitive: canReadSensitive(role, row.abilities),
  };
}

/** POST /v1/internal/api-tokens/resolve — only api-edge calls it, over the service binding. */
export async function handleResolveApiToken(request: Request, env: Env, requestId: string, deps?: ApiTokenDeps): Promise<Response> {
  if (request.method !== "POST") return errorResponse("unsupported", "Method not allowed", 405, requestId);
  if (!deps?.withStore && !env.PLATFORM_DB) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  if (!deps?.roleOf && !env.MEMBERSHIP_WORKER) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  try {
    return successResponse(await resolveApiToken(request.headers.get("authorization"), env, requestId, deps), requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}
