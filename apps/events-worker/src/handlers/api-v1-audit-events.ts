// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/AuditEventsController.php (Apache-2.0), modified.
//
//   GET /v1/internal/api-v1/{org}/audit-events   (api-edge's /api/v1/audit-events, DP-107: src/api-v1-audit-events.ts)
//
// The answers are Coolify's bodies (its envelope), never Freeploy's {error:{…}}. Who may read: audit.read (owner and
// admin: Coolify's isAdminOfTeam), asked of policy-worker before anything is read, as the team audit log page asks (DP-75).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { TEAM_AUDIT_DAYS } from "@saas/db/events";
import { coolifyJson, obj, type CoolifyAnswer } from "@saas/contracts/coolify-api";
import { AUDIT_EVENTS_MESSAGES, auditEventsPage } from "../api-v1-audit-events.js";
import { liveTeamAuditDeps, type TeamAuditLogDeps } from "./team-audit-log.js";

export const API_V1_AUDIT_EVENTS_RE = /^\/v1\/internal\/api-v1\/(org_[0-9a-f]{32})\/audit-events$/;

const send = (a: CoolifyAnswer) => new Response(a.body, { status: a.status, headers: a.headers });

export async function handleApiV1AuditEvents(request: Request, env: Env, requestId: string, actor: ActorContext, orgPublicId: string, orgUuid: string, injected?: TeamAuditLogDeps): Promise<Response> {
  const deps = injected ?? liveTeamAuditDeps(env, actor, requestId);
  if (!deps) return send(coolifyJson(obj({ message: "Service Unavailable" }), 503));
  try {
    if (!(await deps.allowed(orgUuid))) return send(coolifyJson(obj({ message: AUDIT_EVENTS_MESSAGES.notAdmin }), 403));
    const url = new URL(request.url);
    const path = request.headers.get("x-api-v1-url") ?? `${url.origin}/api/v1/audit-events`;
    const since = new Date(deps.now().getTime() - TEAM_AUDIT_DAYS * 86_400_000);
    const rows = await deps.rows(orgUuid, since);
    return send(auditEventsPage({ url, teamId: orgPublicId, canReadSensitive: request.headers.get("x-api-v1-can-read-sensitive") === "1", path }, rows));
  } catch {
    return send(coolifyJson(obj({ message: "Service Unavailable" }), 503));
  }
}
