// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Admin/Index.php and app/Livewire/Team/AdminView.php
// (Apache-2.0), modified.
//
// The platform operator's Admin View data (freeploy-coolify-parity DP12), read only, for
// deploy-core-worker's platform routes — service-binding only, never routed by api-edge:
//
//   POST /v1/internal/membership/platform/users        { search, teamFilter, orgId, sort, perPage, page, excludeUserId }
//                                                      → { users: [{ id, name, email, hasActiveSubscription }], total, page, perPage }
//   GET  /v1/internal/membership/platform/subscribers  → { active, inactive }
//
// The caller has asked policy-worker for `platform.admin.read` before it calls (the operator's alone).
// Nothing is changed: Coolify's "Switch user" (impersonation) and user deletion are not ported.
import type { Env } from "../env.js";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import { countPlatformSubscribers, listPlatformUsers, type PlatformTeamFilter, type PlatformUserSort } from "@saas/db/membership";
import { uuidFromPublicId, uuidToHex } from "@saas/db/ids";
import { successResponse, errorResponse, methodNotAllowed } from "../http.js";

export const PLATFORM_USERS_PATH = "/v1/internal/membership/platform/users";
export const PLATFORM_SUBSCRIBERS_PATH = "/v1/internal/membership/platform/subscribers";

const SORTS: readonly PlatformUserSort[] = ["name_asc", "name_desc", "email_asc", "email_desc"];
const FILTERS: readonly PlatformTeamFilter[] = ["all", "current", "outside"];

export interface PlatformAdminDeps {
  db?: SqlExecutor;
}

function int(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

async function withDb<T>(env: Env, deps: PlatformAdminDeps, fn: (db: SqlExecutor) => Promise<T>): Promise<T> {
  if (deps.db) return fn(deps.db);
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await fn(db);
  } finally {
    await db.dispose();
  }
}

export async function handlePlatformAdmin(request: Request, env: Env, requestId: string, path: string, deps: PlatformAdminDeps = {}): Promise<Response> {
  if (!deps.db && !env.PLATFORM_DB) return errorResponse("internal_error", "Database not configured", 503, requestId);
  try {
    if (path === PLATFORM_SUBSCRIBERS_PATH) {
      if (request.method !== "GET") return methodNotAllowed(requestId);
      return successResponse(await withDb(env, deps, (db) => countPlatformSubscribers(db)), requestId);
    }
    if (request.method !== "POST") return methodNotAllowed(requestId);
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await request.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
    }
    const search = typeof body.search === "string" ? body.search.trim() : "";
    const teamFilter = FILTERS.includes(body.teamFilter as PlatformTeamFilter) ? (body.teamFilter as PlatformTeamFilter) : "all";
    const sort = SORTS.includes(body.sort as PlatformUserSort) ? (body.sort as PlatformUserSort) : "name_asc";
    // AdminView::updatedPerPage(): max(1, min(100, perPage)).
    const perPage = Math.max(1, Math.min(100, int(body.perPage, 10)));
    const page = Math.max(1, int(body.page, 1));
    const orgId = typeof body.orgId === "string" ? uuidFromPublicId(body.orgId, "org") : null;
    const excludeUserId = typeof body.excludeUserId === "string" ? uuidFromPublicId(body.excludeUserId, "usr") : null;
    const result = await withDb(env, deps, (db) =>
      listPlatformUsers(db, { search, teamFilter, orgId, sort, excludeUserId, limit: perPage, offset: (page - 1) * perPage }),
    );
    return successResponse(
      {
        users: result.users.map((u) => ({ id: `usr_${uuidToHex(u.userId)}`, name: u.displayName, email: u.email, hasActiveSubscription: u.hasActiveSubscription })),
        total: result.total,
        page,
        perPage,
      },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "Failed to read the platform's users", 503, requestId);
  }
}
