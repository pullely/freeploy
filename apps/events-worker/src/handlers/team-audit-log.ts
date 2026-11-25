// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Team/AuditLog.php (Apache-2.0), modified.
//
//   GET /v1/organizations/{org}/audit/team-log?search=&action=&source=&sort=&perPage=&page=
//
// The team's audit log page (DP-75): the organization's audit entries of the last 90 days, mapped onto
// Coolify's columns (src/team-audit-log.ts), filtered, sorted and paged as the component does. Read
// only. Who may read it: Coolify's boot() aborts 403 unless the user isAdminOfTeam (owner or admin);
// Freeploy asks policy-worker for audit.read (owner and admin) and answers a denial with 404, as the
// org audit read does.
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { listTeamAuditRows, TEAM_AUDIT_DAYS, type TeamAuditRow } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, successResponse } from "../http.js";
import { parseTeamAuditQuery, teamAuditPage, toTeamAuditEvent } from "../team-audit-log.js";

export interface TeamAuditLogDeps {
  /** The audit rows since a time, newest first. */
  rows(orgId: string, since: Date): Promise<TeamAuditRow[]>;
  /** audit.read for the actor in the org. */
  allowed(orgId: string): Promise<boolean>;
  now(): Date;
}

function liveDeps(env: Env, actor: ActorContext, requestId: string): TeamAuditLogDeps | null {
  if (!env.PLATFORM_DB || !env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) return null;
  const membership = env.MEMBERSHIP_WORKER;
  const policy = env.POLICY_WORKER;
  return {
    async rows(orgId, since) {
      const executor = createSqlExecutor(env.PLATFORM_DB!);
      try {
        return await listTeamAuditRows(executor, orgId, since);
      } finally {
        await executor.dispose();
      }
    },
    async allowed(orgId) {
      const context = await fetchAuthorizationContext(membership, actor.subjectId, actor.subjectType, orgId, requestId);
      if (!context.ok) return false;
      const decision = await authorizeViaPolicy(policy, actor.subjectId, actor.subjectType, "audit.read", { kind: "organization", orgId }, context.memberships, requestId);
      return decision.allow;
    },
    now: () => new Date(),
  };
}

export async function handleTeamAuditLog(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string, injected?: TeamAuditLogDeps): Promise<Response> {
  const deps = injected ?? liveDeps(env, actor, requestId);
  if (!deps) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  try {
    // Deny by default: nothing is read before the decision.
    if (!(await deps.allowed(orgId))) return errorResponse("not_found", "Not found", 404, requestId);
    const since = new Date(deps.now().getTime() - TEAM_AUDIT_DAYS * 86_400_000);
    const events = (await deps.rows(orgId, since)).map(toTeamAuditEvent);
    return successResponse(teamAuditPage(events, parseTeamAuditQuery(new URL(request.url))), requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}
