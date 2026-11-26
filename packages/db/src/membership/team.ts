// The deploy console's team pages (freeploy-coolify-parity DP10, DP-69): Coolify's team, its members and
// its invitations (app/Models/{Team,TeamInvitation}.php, team_user) are Freeploy's organization, its members
// with their organization roles, and its invitations. These are the queries membership-worker's team
// handler runs, inside one transaction per request. Nothing here decides who may do what: the handler
// does, with policy-worker.
//
// A member's name, email and two-factor state are identity's. They are read here, narrowly (display name,
// email, whether two-factor is confirmed), joined on the member's subject id (`usr_<hex>` of the user's
// id), as the support repository reads identity.users; nothing here writes outside membership.
import type { SqlExecutor } from "../hyperdrive/executor.js";

export interface TeamRecord {
  id: string;
  name: string;
  slug: string;
  description: string | null;
}

export interface TeamMemberRecord {
  memberId: string;
  subjectId: string;
  subjectType: string;
  /** The member's active organization-scoped roles. */
  roles: string[];
  /** identity.users.display_name, null when the user has none (or is not a user). */
  displayName: string | null;
  email: string | null;
  /** Coolify's two_factor_confirmed_at is filled. */
  twoFactorConfirmed: boolean;
  createdAt: Date;
}

export interface TeamInvitationRecord {
  id: string;
  orgId: string;
  email: string;
  role: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface NewTeamInvitation {
  id: string;
  orgId: string;
  email: string;
  role: string;
  /** SHA-256 of a random token nobody is given: the team pages' links name the invitation, not a token. */
  tokenHash: string;
  invitedBy: string;
  createdAt: Date;
  expiresAt: Date;
}

const USER_OF_SUBJECT = `LEFT JOIN identity.users u ON 'usr_' || replace(u.id::text, '-', '') = m.subject_id
  LEFT JOIN identity.two_factor tf ON tf.user_id = u.id AND tf.confirmed_at IS NOT NULL`;

const MEMBER_COLUMNS = `m.id AS member_id, m.subject_id, m.subject_type, m.created_at,
  u.display_name, u.email, (tf.user_id IS NOT NULL) AS two_factor_confirmed,
  COALESCE((SELECT array_agg(ra.role ORDER BY ra.role) FROM membership.role_assignments ra
    WHERE ra.org_id = m.org_id AND ra.subject_id = m.subject_id AND ra.scope_kind = 'organization' AND ra.revoked_at IS NULL), '{}') AS roles`;

function rolesOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  // node-postgres answers a text[] as an array; a driver that does not answers '{a,b}'.
  if (typeof value === "string") return value.replace(/^\{|\}$/g, "").split(",").filter(Boolean);
  return [];
}

function mapMember(row: Record<string, unknown>): TeamMemberRecord {
  return {
    memberId: String(row.member_id),
    subjectId: String(row.subject_id),
    subjectType: String(row.subject_type),
    roles: rolesOf(row.roles),
    displayName: (row.display_name as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    twoFactorConfirmed: row.two_factor_confirmed === true,
    createdAt: new Date(row.created_at as string),
  };
}

function mapInvitation(row: Record<string, unknown>): TeamInvitationRecord {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    email: String(row.email),
    role: String(row.role),
    status: String(row.status),
    createdAt: new Date(row.created_at as string),
    expiresAt: new Date(row.expires_at as string),
  };
}

const INVITATION_COLUMNS = "id, org_id, email, role, status, created_at, expires_at";

export async function findTeam(ex: SqlExecutor, orgId: string): Promise<TeamRecord | null> {
  const r = await ex.execute<Record<string, unknown>>(
    `SELECT id, name, slug, description FROM membership.organizations WHERE id = $1 AND status = 'active'`,
    [orgId],
  );
  const row = r.rows[0];
  return row ? { id: String(row.id), name: String(row.name), slug: String(row.slug), description: (row.description as string | null) ?? null } : null;
}

/** Team\Index::submit(): the name and description. The slug (the org's URL name) is kept. */
export async function updateTeam(ex: SqlExecutor, orgId: string, name: string, description: string | null, now: Date): Promise<TeamRecord | null> {
  const r = await ex.execute<Record<string, unknown>>(
    `UPDATE membership.organizations SET name = $2, description = $3, updated_at = $4
     WHERE id = $1 AND status = 'active' RETURNING id, name, slug, description`,
    [orgId, name, description, now.toISOString()],
  );
  const row = r.rows[0];
  return row ? { id: String(row.id), name: String(row.name), slug: String(row.slug), description: (row.description as string | null) ?? null } : null;
}

/** Team::members: the active members, oldest first. */
export async function listTeamMembers(ex: SqlExecutor, orgId: string): Promise<TeamMemberRecord[]> {
  const r = await ex.execute<Record<string, unknown>>(
    `SELECT ${MEMBER_COLUMNS} FROM membership.organization_members m ${USER_OF_SUBJECT}
     WHERE m.org_id = $1 AND m.status = 'active' ORDER BY m.created_at, m.id`,
    [orgId],
  );
  return r.rows.map(mapMember);
}

export async function findTeamMember(ex: SqlExecutor, orgId: string, memberId: string): Promise<TeamMemberRecord | null> {
  const r = await ex.execute<Record<string, unknown>>(
    `SELECT ${MEMBER_COLUMNS} FROM membership.organization_members m ${USER_OF_SUBJECT}
     WHERE m.org_id = $1 AND m.id = $2 AND m.status = 'active'`,
    [orgId, memberId],
  );
  return r.rows[0] ? mapMember(r.rows[0]) : null;
}

export async function findTeamMemberBySubject(ex: SqlExecutor, orgId: string, subjectId: string): Promise<TeamMemberRecord | null> {
  const r = await ex.execute<Record<string, unknown>>(
    `SELECT ${MEMBER_COLUMNS} FROM membership.organization_members m ${USER_OF_SUBJECT}
     WHERE m.org_id = $1 AND m.subject_id = $2 AND m.status = 'active'`,
    [orgId, subjectId],
  );
  return r.rows[0] ? mapMember(r.rows[0]) : null;
}

/** The active members holding the organization's owner role. */
export async function countTeamOwners(ex: SqlExecutor, orgId: string): Promise<number> {
  const r = await ex.execute<Record<string, unknown>>(
    `SELECT COUNT(DISTINCT m.id) AS n FROM membership.organization_members m
     JOIN membership.role_assignments ra ON ra.org_id = m.org_id AND ra.subject_id = m.subject_id
     WHERE m.org_id = $1 AND m.status = 'active' AND ra.role = 'owner' AND ra.scope_kind = 'organization' AND ra.revoked_at IS NULL`,
    [orgId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** Member::updateRole(): the member's organization roles become this one role. */
export async function setTeamMemberRole(
  ex: SqlExecutor,
  input: { orgId: string; subjectId: string; subjectType: string; role: string; assignmentId: string; now: Date },
): Promise<void> {
  await ex.execute(
    `UPDATE membership.role_assignments SET revoked_at = $3
     WHERE org_id = $1 AND subject_id = $2 AND scope_kind = 'organization' AND revoked_at IS NULL`,
    [input.orgId, input.subjectId, input.now.toISOString()],
  );
  await ex.execute(
    `INSERT INTO membership.role_assignments (id, org_id, subject_id, subject_type, role, scope_kind, scope_ref, created_at)
     VALUES ($1, $2, $3, $4, $5, 'organization', NULL, $6)`,
    [input.assignmentId, input.orgId, input.subjectId, input.subjectType, input.role, input.now.toISOString()],
  );
}

/** Member::remove(): the membership ends and every role in the organization is revoked. */
export async function removeTeamMember(ex: SqlExecutor, orgId: string, memberId: string, subjectId: string, now: Date): Promise<boolean> {
  const r = await ex.execute(
    `UPDATE membership.organization_members SET status = 'removed', updated_at = $3 WHERE org_id = $1 AND id = $2 AND status = 'active' RETURNING id`,
    [orgId, memberId, now.toISOString()],
  );
  // rowCount is the number of rows returned (executor.ts), hence RETURNING.
  if (r.rows.length === 0) return false;
  await ex.execute(
    `UPDATE membership.role_assignments SET revoked_at = $3 WHERE org_id = $1 AND subject_id = $2 AND revoked_at IS NULL`,
    [orgId, subjectId, now.toISOString()],
  );
  return true;
}

/** TeamInvitation::ownedByCurrentTeam(): the pending ones (accepted and revoked rows are history), oldest first. */
export async function listTeamInvitations(ex: SqlExecutor, orgId: string): Promise<TeamInvitationRecord[]> {
  const r = await ex.execute<Record<string, unknown>>(
    `SELECT ${INVITATION_COLUMNS} FROM membership.organization_invitations
     WHERE org_id = $1 AND status = 'pending' ORDER BY created_at, id`,
    [orgId],
  );
  return r.rows.map(mapInvitation);
}

export async function findTeamInvitation(ex: SqlExecutor, id: string): Promise<TeamInvitationRecord | null> {
  const r = await ex.execute<Record<string, unknown>>(
    `SELECT ${INVITATION_COLUMNS} FROM membership.organization_invitations WHERE id = $1 AND status = 'pending'`,
    [id],
  );
  return r.rows[0] ? mapInvitation(r.rows[0]) : null;
}

export async function findTeamInvitationByEmail(ex: SqlExecutor, orgId: string, emailLower: string): Promise<TeamInvitationRecord | null> {
  const r = await ex.execute<Record<string, unknown>>(
    `SELECT ${INVITATION_COLUMNS} FROM membership.organization_invitations
     WHERE org_id = $1 AND email_lower = $2 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
    [orgId, emailLower],
  );
  return r.rows[0] ? mapInvitation(r.rows[0]) : null;
}

export async function createTeamInvitation(ex: SqlExecutor, input: NewTeamInvitation): Promise<TeamInvitationRecord> {
  const r = await ex.execute<Record<string, unknown>>(
    `INSERT INTO membership.organization_invitations (id, org_id, email, email_lower, role, token_hash, invited_by, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${INVITATION_COLUMNS}`,
    [input.id, input.orgId, input.email, input.email.toLowerCase(), input.role, input.tokenHash, input.invitedBy, input.expiresAt.toISOString(), input.createdAt.toISOString()],
  );
  return mapInvitation(r.rows[0]!);
}

/**
 * The end of a pending invitation, which Coolify deletes: `revoked` (Invitations::deleteInvitation),
 * `expired` (TeamInvitation::isValid() on an expired one) or `accepted`.
 */
export async function closeTeamInvitation(ex: SqlExecutor, orgId: string, id: string, status: "revoked" | "expired" | "accepted", now: Date): Promise<boolean> {
  const at = status === "accepted" ? "accepted_at" : "revoked_at";
  const r = await ex.execute(
    `UPDATE membership.organization_invitations SET status = $3, ${at} = $4 WHERE org_id = $1 AND id = $2 AND status = 'pending' RETURNING id`,
    [orgId, id, status, now.toISOString()],
  );
  return r.rows.length > 0;
}

/**
 * `$user->teams()->attach($team, ['role' => …])`: the subject becomes an active member with the role. A
 * subject that was removed before gets its membership back (one row per org and subject).
 */
export async function addTeamMember(
  ex: SqlExecutor,
  input: { orgId: string; subjectId: string; subjectType: string; role: string; memberId: string; assignmentId: string; now: Date },
): Promise<string> {
  const at = input.now.toISOString();
  const r = await ex.execute<Record<string, unknown>>(
    `INSERT INTO membership.organization_members (id, org_id, subject_id, subject_type, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'active', $5, $5)
     ON CONFLICT (org_id, subject_id) DO UPDATE SET status = 'active', updated_at = EXCLUDED.updated_at
     RETURNING id`,
    [input.memberId, input.orgId, input.subjectId, input.subjectType, at],
  );
  await setTeamMemberRole(ex, { orgId: input.orgId, subjectId: input.subjectId, subjectType: input.subjectType, role: input.role, assignmentId: input.assignmentId, now: input.now });
  return String(r.rows[0]!.id);
}
