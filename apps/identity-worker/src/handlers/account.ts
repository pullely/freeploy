// Derived from coollabsio/coolify@91b7e3e (app/Actions/User/DeleteUserAccount.php;
// app/Livewire/Profile/Index.php deleteAccount and render; verifyPasswordConfirmation)
// (Apache-2.0), modified.
//
//   GET    /v1/auth/account/deletion   { blockers, actions }
//   DELETE /v1/auth/account            { password }
//
// Coolify's self-hosted rule (the reference's): a team where the user is the
// only member must be emptied of projects, servers and Git sources first.
// Freeploy runs in Solo mode, so every user's one team is a personal team they
// own alone; the multi-member rules (another owner or admin) arrive with DP10.
import type { Env } from "../env.js";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import { createAccountStore, createIdentityRepository, createPasswordStore } from "@saas/db/identity";
import { hexToUuid } from "@saas/db/ids";
import { createAuthService } from "../services/auth.js";
import { successResponse, errorResponse, validationError, extractBearerToken } from "../http.js";
import { verifyPassword } from "../password.js";

interface Team {
  id: string;
  name: string;
}

async function teamsOf(env: Env, requestId: string, user: { publicId: string; email: string }): Promise<Team[]> {
  if (!env.MEMBERSHIP_WORKER) return [];
  const res = await env.MEMBERSHIP_WORKER.fetch("https://membership.internal/v1/organizations?limit=100", {
    headers: { "x-request-id": requestId, "x-actor-subject-id": user.publicId, "x-actor-subject-type": "user", "x-actor-email": user.email },
  });
  if (!res.ok) return [];
  const body = (await res.json().catch(() => null)) as { data?: { organizations?: Array<{ id: string; name: string }> } } | null;
  return body?.data?.organizations ?? [];
}

export async function deletionBlockers(db: SqlExecutor, teams: Team[]): Promise<string[]> {
  const store = createAccountStore(db);
  const out: string[] = [];
  for (const t of teams) {
    const orgId = hexToUuid(t.id.slice(4));
    if (orgId && (await store.orgResourceCount(orgId)) > 0) out.push(`Delete all projects, servers, and Git sources of the team "${t.name}".`);
  }
  return out;
}

/** DeleteUserAccount::confirmationActions() without Cloud's team removal. */
export const DELETION_ACTIONS = ["Your account will be permanently deleted from Freeploy."];

async function withUser(request: Request, env: Env, requestId: string, fn: (db: SqlExecutor, user: { id: string; publicId: string; email: string }) => Promise<Response>): Promise<Response> {
  const token = extractBearerToken(request);
  if (!token) return errorResponse("unauthenticated", "Missing or invalid Authorization header", 401, requestId);
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Database not configured", 503, requestId);
  const db = createSqlExecutor(env.PLATFORM_DB);
  try {
    const s = await createAuthService({ repo: createIdentityRepository(db), now: () => new Date() }).getSession(token);
    if ("error" in s) return errorResponse("unauthenticated", s.message, 401, requestId);
    const id = hexToUuid(s.user.id.slice(4));
    if (!id) return errorResponse("unauthenticated", "Invalid session", 401, requestId);
    return await fn(db, { id, publicId: s.user.id, email: s.user.email });
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    await db.dispose();
  }
}

export function handleDeletionInfo(request: Request, env: Env, requestId: string): Promise<Response> {
  return withUser(request, env, requestId, async (db, user) => {
    const blockers = await deletionBlockers(db, await teamsOf(env, requestId, user));
    return successResponse({ blockers, actions: DELETION_ACTIONS }, requestId, 200);
  });
}

export function handleAccountDelete(request: Request, env: Env, requestId: string): Promise<Response> {
  return withUser(request, env, requestId, async (db, user) => {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      /* empty body */
    }
    const hash = await createPasswordStore(db).get(user.id);
    if (typeof body.password !== "string" || !hash || !(await verifyPassword(body.password, hash))) {
      return validationError(requestId, { password: ["The provided password is incorrect."] });
    }
    const blockers = await deletionBlockers(db, await teamsOf(env, requestId, user));
    if (blockers.length) return errorResponse("toast", blockers.join(" "), 422, requestId);
    await createAccountStore(db).deactivate(user.id);
    return successResponse({ status: "deleted" }, requestId, 200);
  });
}
