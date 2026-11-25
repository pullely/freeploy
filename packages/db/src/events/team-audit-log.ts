// The team's audit log (freeploy-coolify-parity DP10, DP-75): Coolify's Team\AuditLog reads its
// audit_events for the current team over the last 90 days (AuditEvent::pruneExpired()); Freeploy's are the
// organization's events.audit_entries. This reads them, newest first, for events-worker to map onto
// Coolify's columns, filter, sort and page.
//
// The actor's and a member's name and email are identity's: read here, narrowly (display name and email),
// joined on the subject id (`usr_<hex>` of the user's id), as the team pages read them
// (packages/db/src/membership/team.ts); nothing here writes.
import type { SqlExecutor } from "../hyperdrive/executor.js";

export interface TeamAuditRow {
  id: string;
  eventType: string;
  actorType: string;
  actorId: string;
  /** identity.users of the actor (a user), else null. */
  actorName: string | null;
  actorEmail: string | null;
  subjectKind: string;
  subjectId: string;
  subjectName: string | null;
  description: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
  /** The member a membership event names (payload.memberId), when it is a user. */
  memberName: string | null;
  memberEmail: string | null;
}

/** AuditEvent::pruneExpired(): Coolify keeps 90 days. */
export const TEAM_AUDIT_DAYS = 90;
/** A bound on one read; a team's 90 days are far fewer rows in practice. */
export const TEAM_AUDIT_MAX_ROWS = 5000;

const USER_HEX = (alias: string) => `'usr_' || replace(${alias}.id::text, '-', '')`;

/**
 * The organization's audit entries since `since`, newest first (created_at, then id: latestFirst()). Legacy
 * membership rows stored the org as `org_<hex>`, so both forms are read (as queryAuditByOrg does).
 */
export async function listTeamAuditRows(ex: SqlExecutor, orgId: string, since: Date, limit = TEAM_AUDIT_MAX_ROWS): Promise<TeamAuditRow[]> {
  const legacy = `org_${orgId.replace(/-/g, "")}`;
  const r = await ex.execute<Record<string, unknown>>(
    `SELECT a.id, a.event_type, a.actor_type, a.actor_id, a.subject_kind, a.subject_id, a.subject_name, a.description,
            a.occurred_at, a.payload, au.display_name AS actor_name, au.email AS actor_email,
            mu.display_name AS member_name, mu.email AS member_email
       FROM events.audit_entries a
       LEFT JOIN identity.users au ON ${USER_HEX("au")} = a.actor_id
       LEFT JOIN membership.organization_members om ON 'mem_' || replace(om.id::text, '-', '') = a.payload->>'memberId'
       LEFT JOIN identity.users mu ON ${USER_HEX("mu")} = om.subject_id
      WHERE a.org_id IN ($1, $2) AND a.occurred_at >= $3
      ORDER BY a.occurred_at DESC, a.id DESC
      LIMIT $4`,
    [orgId, legacy, since.toISOString(), limit],
  );
  return r.rows.map((row) => ({
    id: String(row.id),
    eventType: String(row.event_type),
    actorType: String(row.actor_type),
    actorId: String(row.actor_id),
    actorName: (row.actor_name as string | null) ?? null,
    actorEmail: (row.actor_email as string | null) ?? null,
    subjectKind: String(row.subject_kind),
    subjectId: String(row.subject_id),
    subjectName: (row.subject_name as string | null) ?? null,
    description: String(row.description ?? ""),
    occurredAt: new Date(row.occurred_at as string),
    payload: typeof row.payload === "string" ? (JSON.parse(row.payload) as Record<string, unknown>) : ((row.payload as Record<string, unknown> | null) ?? {}),
    memberName: (row.member_name as string | null) ?? null,
    memberEmail: (row.member_email as string | null) ?? null,
  }));
}
