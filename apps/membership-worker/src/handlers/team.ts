// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Team/{Index,Member,Invitations,InviteLink,DangerZone}.php,
// app/Actions/Team/DeleteTeam.php, resources/views/livewire/team/danger-zone.blade.php,
// app/Livewire/Team/Member/Index.php, app/Http/Controllers/Controller.php (showInvitation,
// acceptInvitation), app/Models/{Team,TeamInvitation,User}.php, app/Enums/Role.php and
// app/Policies/TeamPolicy.php (Apache-2.0), modified.
//
// The deploy console's team pages (freeploy-coolify-parity DP10). Coolify's team is the organization, its
// team_user rows are the organization's members with their organization role, and its team_invitations
// are the organization's invitations. Coolify's roles are owner, admin and member; Freeploy stores them as
// owner, admin and builder (packages/policy-engine), and shows Freeploy's other org roles (viewer,
// billing_admin) by their own names, ranked as members.
//
//   GET    /v1/organizations/{org}/team                     Team\Index::mount: { team, canUpdate }
//   PATCH  /v1/organizations/{org}/team                     Team\Index::submit { name, description }
//   PATCH  /v1/organizations/{org}/team/settings            TeamController::update_current_team (DP-107): the two
//                                                           settings of PATCH /api/v1/team, validated by identity-worker
//   DELETE /v1/organizations/{org}/team                     Team\DangerZone::delete (DP-75, see team-danger.ts)
//   GET    /v1/organizations/{org}/team/danger              Team\DangerZone: the state of danger-zone.blade.php
//   GET    /v1/organizations/{org}/team/members             Member\Index: the members, the actor's role and abilities
//   PATCH  /v1/organizations/{org}/team/members/{member}    Member::makeOwner | makeAdmin | makeReadonly { action }
//   DELETE /v1/organizations/{org}/team/members/{member}    Member::remove
//   GET    /v1/organizations/{org}/team/invitations         Invitations: the pending invitations
//   POST   /v1/organizations/{org}/team/invitations         InviteLink::viaLink { email, role } (viaEmail: 501, see below)
//   DELETE /v1/organizations/{org}/team/invitations/{inv}   Invitations::deleteInvitation
//   GET    /v1/team-invitations/{inv}                       Controller::showInvitation
//   POST   /v1/team-invitations/{inv}                       Controller::acceptInvitation
//
// Policy (TeamPolicy, every ability a team admin's but view): view = deploy.team.read, update =
// organization.settings.update, manageMembers = organization.member.update_role (a role change) and
// organization.member.remove (a removal), manageInvitations = organization.invitation.create / list /
// revoke, delete = organization.delete (the owner's alone). A denied ability answers 404, as every
// membership route does.
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { RoleAssignment } from "@saas/db/membership";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";
import {
  createMembershipRepository,
  findTeam,
  updateTeam,
  updateTeamSettings,
  listTeamMembers,
  findTeamMember,
  findTeamMemberBySubject,
  countTeamOwners,
  setTeamMemberRole,
  removeTeamMember,
  listTeamInvitations,
  findTeamInvitation,
  findTeamInvitationByEmail,
  createTeamInvitation,
  closeTeamInvitation,
  addTeamMember,
  teamDeployResources,
  countSubjectTeams,
  deleteTeam,
  type TeamDeployResources,
  type TeamRecord,
  type TeamSettingsChanges,
  type TeamSettingsRecord,
  type TeamMemberRecord,
  type TeamInvitationRecord,
  type NewTeamInvitation,
} from "@saas/db/membership";
import { createEventsRepository } from "@saas/db/events";
import { authorizeViaPolicy } from "../policy-client.js";
import { checkBillingEntitlement, decideMembersLimit } from "../billing-client.js";
import { successResponse, errorResponse, validationError, methodNotAllowed } from "../http.js";
import { parseOrgPublicId, orgPublicId, memberPublicId, parseMemberPublicId, invitationPublicId, parseInvitationPublicId, generateInvitationToken } from "../ids.js";
import { validateInvite, validateTeam, type CoolifyRole } from "../team-validation.js";

/** config('constants.invitation.link.expiration_days'). */
export const INVITATION_EXPIRATION_DAYS = 3;

/** The messages of the team pages, word for word. */
export const TEAM_TEXT = {
  updated: "Team updated.",
  notAuthorized: "You are not authorized to perform this action.",
  membersCannotInvite: "Members cannot invite admins or owners.",
  adminsCannotInviteOwners: "Admins cannot invite owners.",
  alreadyMember: (email: string, team: string) => `${email} is already a member of ${team}.`,
  pendingExists: (email: string) => `Pending invitation already exists for ${email}.`,
  linkGenerated: "Invitation link generated.",
  revoked: "Invitation revoked.",
  invitationNotFound: "Invitation not found.",
  notAllowedToAccept: "You are not allowed to accept this invitation.",
  expired: "Invitation expired.",
  /** invite-link.blade.php's callout title: Coolify hides "Send email" while transactional email is off. */
  emailNotConfigured: "Email delivery is not configured",
  /** Freeploy keeps an organization's last owner (membership-worker's own rule; Coolify has none). */
  lastOwnerRole: "Cannot change role of the last active owner",
  lastOwnerRemove: "Cannot remove the last active owner",
  // ── The Danger Zone (DP-75): danger-zone.blade.php and DeleteTeam::handle(), word for word ──
  onlyOwnersCanDelete: "Only team owners can delete this team.",
  lastOrPersonal: "Your last or personal team cannot be deleted.",
  /** DeleteTeam: the servers first, then every other resource (Team::isEmpty()). */
  deleteServersFirst: "Delete all team servers before deleting this team.",
  deleteResourcesFirst: "Delete all team resources before deleting this team.",
} as const;

/**
 * identity-worker's solo-mode.ts names every user's personal organization `personal-<user id>`; Coolify's
 * `personal_team`. Freeploy has no other marker, so an organization whose slug has that shape is a
 * personal team (refused, never deleted by mistake).
 */
export function isPersonalTeam(team: TeamRecord): boolean {
  return team.slug.startsWith("personal-");
}

/** danger-zone.blade.php's branches, in its order (the root team, id 0, and a Cloud subscription do not exist in Freeploy). */
export type DangerState = "not-owner" | "last-or-personal" | "blocked" | "deletable";

export function dangerState(input: { role: string; teams: number; personal: boolean; resources: TeamDeployResources }): DangerState {
  if (input.role !== "owner") return "not-owner";
  if (input.teams <= 1 || input.personal) return "last-or-personal";
  if (Object.keys(input.resources.blockers).length || Object.keys(input.resources.owned).length) return "blocked";
  return "deletable";
}

const RANK: Record<string, number> = { member: 1, admin: 2, owner: 3 };

/** The Coolify role of a member's organization roles (Role::rank decides between several). */
export function coolifyRole(roles: readonly string[]): string {
  if (roles.includes("owner")) return "owner";
  if (roles.includes("admin")) return "admin";
  if (roles.includes("builder")) return "member";
  return roles[0] ?? "member";
}

/** Role::rank(); Freeploy's own roles (viewer, billing_admin) rank as members. */
export function rank(role: string): number {
  return RANK[role] ?? 1;
}

/** The role Freeploy stores for a Coolify role. */
export function storedRole(role: CoolifyRole): string {
  return role === "member" ? "builder" : role;
}

/** TeamInvitation::hasExpired(): more than expiration_days since it was created (Carbon's float diffInDays). */
export function invitationExpired(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() > INVITATION_EXPIRATION_DAYS * 86_400_000;
}

export interface TeamEvent {
  type: string;
  subjectKind: string;
  subjectId: string;
  payload: Record<string, unknown>;
  description: string;
}

/** What one request may read and write, inside one transaction. */
export interface TeamStore {
  roleAssignments(orgId: string, subjectId: string): Promise<RoleAssignment[] | null>;
  team(orgId: string): Promise<TeamRecord | null>;
  updateTeam(orgId: string, name: string, description: string | null, now: Date): Promise<TeamRecord | null>;
  /** DP-107: PATCH /api/v1/team's two settings. */
  updateTeamSettings(orgId: string, changes: TeamSettingsChanges, now: Date): Promise<TeamSettingsRecord | null>;
  members(orgId: string): Promise<TeamMemberRecord[]>;
  member(orgId: string, memberId: string): Promise<TeamMemberRecord | null>;
  memberBySubject(orgId: string, subjectId: string): Promise<TeamMemberRecord | null>;
  countOwners(orgId: string): Promise<number>;
  setRole(input: { orgId: string; subjectId: string; subjectType: string; role: string; assignmentId: string; now: Date }): Promise<void>;
  removeMember(orgId: string, memberId: string, subjectId: string, now: Date): Promise<boolean>;
  addMember(input: { orgId: string; subjectId: string; subjectType: string; role: string; memberId: string; assignmentId: string; now: Date }): Promise<string>;
  invitations(orgId: string): Promise<TeamInvitationRecord[]>;
  invitation(id: string): Promise<TeamInvitationRecord | null>;
  invitationByEmail(orgId: string, emailLower: string): Promise<TeamInvitationRecord | null>;
  createInvitation(input: NewTeamInvitation): Promise<TeamInvitationRecord>;
  closeInvitation(orgId: string, id: string, status: "revoked" | "expired" | "accepted", now: Date): Promise<boolean>;
  /** active members + pending invitations: the seats `limit.members` counts. */
  billableMembers(orgId: string, now: Date): Promise<number | null>;
  event(orgId: string, e: TeamEvent): Promise<void>;
  /** The active teams the subject is a member of (DP-75: "Your last … team cannot be deleted."). */
  countTeams(subjectId: string): Promise<number>;
  /** DeleteTeam: the org locked, marked deleted, its members, roles and pending invitations ended. */
  deleteTeam(orgId: string, now: Date): Promise<boolean>;
}

export interface TeamDeps {
  run<T>(fn: (store: TeamStore) => Promise<T>): Promise<T>;
  /** The team's deploy records, read only (DP-75, packages/db/src/membership/team-danger.ts). */
  deployResources(orgId: string): Promise<TeamDeployResources>;
  authorize(action: string, orgId: string, roles: RoleAssignment[]): Promise<boolean>;
  /** The billing gate on a new invitation (Task 0080): null when allowed, else the denial's message. */
  membersLimit(orgId: string, billable: () => Promise<number | null>): Promise<{ deny: string; reason?: string } | { error: true } | null>;
  now(): Date;
  id(): string;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sqlStore(tx: SqlExecutor, actor: ActorContext, requestId: string): TeamStore {
  const repo = createMembershipRepository(tx);
  const events = createEventsRepository(tx);
  return {
    roleAssignments: async (orgId, subjectId) => {
      const r = await repo.listRoleAssignments(asUuid(orgId), subjectId);
      return r.ok ? r.value : null;
    },
    team: (orgId) => findTeam(tx, orgId),
    updateTeam: (orgId, name, description, now) => updateTeam(tx, orgId, name, description, now),
    updateTeamSettings: (orgId, changes, now) => updateTeamSettings(tx, orgId, changes, now),
    members: (orgId) => listTeamMembers(tx, orgId),
    member: (orgId, memberId) => findTeamMember(tx, orgId, memberId),
    memberBySubject: (orgId, subjectId) => findTeamMemberBySubject(tx, orgId, subjectId),
    countOwners: (orgId) => countTeamOwners(tx, orgId),
    setRole: (input) => setTeamMemberRole(tx, input),
    removeMember: (orgId, memberId, subjectId, now) => removeTeamMember(tx, orgId, memberId, subjectId, now),
    addMember: (input) => addTeamMember(tx, input),
    invitations: (orgId) => listTeamInvitations(tx, orgId),
    invitation: (id) => findTeamInvitation(tx, id),
    invitationByEmail: (orgId, emailLower) => findTeamInvitationByEmail(tx, orgId, emailLower),
    createInvitation: (input) => createTeamInvitation(tx, input),
    closeInvitation: (orgId, id, status, now) => closeTeamInvitation(tx, orgId, id, status, now),
    billableMembers: async (orgId, now) => {
      const r = await repo.countBillableMembers(asUuid(orgId), now);
      return r.ok ? r.value : null;
    },
    event: async (orgId, e) => {
      const now = new Date();
      const r = await events.appendEventWithAudit({
        event: {
          id: randomHex(16),
          type: e.type,
          version: 1,
          source: "membership-worker",
          occurredAt: now,
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId,
          subjectKind: e.subjectKind,
          subjectId: e.subjectId,
          requestId,
          payload: e.payload,
        },
        audit: { id: randomHex(16), category: "membership", description: e.description },
      });
      if (!r.ok) throw new Error("event_append_failed");
    },
    countTeams: (subjectId) => countSubjectTeams(tx, subjectId),
    deleteTeam: (orgId, now) => deleteTeam(tx, orgId, now),
  };
}

function liveDeps(env: Env, actor: ActorContext, requestId: string): TeamDeps | null {
  if (!env.PLATFORM_DB || !env.POLICY_WORKER) return null;
  const policy = env.POLICY_WORKER;
  return {
    async run(fn) {
      const executor = createSqlExecutor(env.PLATFORM_DB!);
      try {
        if (!("transaction" in executor)) return await fn(sqlStore(executor, actor, requestId));
        return await executor.transaction((tx) => fn(sqlStore(tx, actor, requestId)));
      } finally {
        await executor.dispose();
      }
    },
    async deployResources(orgId) {
      // A transaction of its own (withOrg: as deploy_app, confined to the org by row-level security).
      const executor = createSqlExecutor(env.PLATFORM_DB!);
      try {
        if (!("transaction" in executor)) throw new Error("transactions unavailable");
        return await teamDeployResources(executor, orgId);
      } finally {
        await executor.dispose();
      }
    },
    authorize: async (action, orgId, roles) =>
      (await authorizeViaPolicy(policy, { actor, action, resource: { kind: "organization", id: orgId, orgId }, orgId, roleAssignments: roles, requestId })).allow,
    async membersLimit(orgId, billable) {
      if (!env.BILLING_WORKER) return { error: true };
      const entitlement = await checkBillingEntitlement(env.BILLING_WORKER, orgPublicId(orgId), "limit.members", requestId);
      if (entitlement.kind === "service_error") return { error: true };
      const count = await billable();
      if (count === null) return { error: true };
      const gate = decideMembersLimit(entitlement.decision, count);
      if (gate.kind === "service_error") return { error: true };
      return gate.kind === "deny" ? { deny: gate.message, reason: gate.reason } : null;
    },
    now: () => new Date(),
    id: () => crypto.randomUUID(),
  };
}

class Answer {
  constructor(readonly response: Response) {}
}

function publicTeam(team: TeamRecord) {
  return { id: orgPublicId(team.id), name: team.name, slug: team.slug, description: team.description };
}

function publicInvitation(inv: TeamInvitationRecord, now: Date) {
  const id = invitationPublicId(inv.id);
  return {
    id,
    email: inv.email,
    role: coolifyRole([inv.role]),
    // The only way Freeploy invites until email is delivered (InviteLink::viaLink).
    via: "link",
    // routes/web.php team.invitation.show; the console puts its own origin in front (Coolify: base_url()).
    path: `/invitations/${id}`,
    createdAt: inv.createdAt.toISOString(),
    expired: invitationExpired(inv.createdAt, now),
  };
}

async function readBody(request: Request, requestId: string): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    /* answered below */
  }
  throw new Answer(validationError(requestId, { body: ["Request body must be a JSON object"] }));
}

/**
 * /v1/organizations/{org}/team[/members[/{member}]|/invitations[/{inv}]]. `segments` is what follows
 * /team, split on "/".
 */
export async function handleTeam(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  segments: string[],
  injected?: TeamDeps,
): Promise<Response> {
  const orgId = parseOrgPublicId(orgIdParam);
  const notFound = () => errorResponse("not_found", "Organization not found", 404, requestId);
  if (!orgId) return notFound();
  const deps = injected ?? liveDeps(env, actor, requestId);
  if (!deps) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  const [section, id, ...rest] = segments;
  const method = request.method;
  if (rest.length) return notFound();
  const fail = (message: string, status = 422) => new Answer(errorResponse("precondition_failed", message, status, requestId));

  try {
    const body = method === "PATCH" || method === "POST" ? await readBody(request, requestId) : {};
    return await deps.run(async (store) => {
      const roles = await store.roleAssignments(orgId, actor.subjectId);
      if (!roles || !roles.some((r) => r.scopeKind === "organization")) throw new Answer(notFound());
      const can = (action: string) => deps.authorize(action, orgId, roles);
      const need = async (action: string) => {
        if (!(await can(action))) throw new Answer(notFound());
      };
      const team = await store.team(orgId);
      if (!team) throw new Answer(notFound());
      const actorRole = coolifyRole(roles.filter((r) => r.scopeKind === "organization").map((r) => r.role));
      const now = deps.now();

      // ── Team\Index ────────────────────────────────────────────────────
      if (section === undefined) {
        if (method === "GET") {
          await need("deploy.team.read");
          return successResponse({ team: publicTeam(team), canUpdate: await can("organization.settings.update") }, requestId);
        }
        if (method === "DELETE") {
          // Team\DangerZone::delete(): authorize('delete'), then DeleteTeam::handle(). Freeploy also refuses the
          // last or personal team here (Coolify only hides the button), and what membership cannot delete.
          await need("organization.delete");
          if (actorRole !== "owner") throw fail(TEAM_TEXT.onlyOwnersCanDelete, 403);
          if (isPersonalTeam(team) || (await store.countTeams(actor.subjectId)) <= 1) throw fail(TEAM_TEXT.lastOrPersonal);
          const resources = await deps.deployResources(orgId);
          if (resources.blockers.servers) throw fail(TEAM_TEXT.deleteServersFirst);
          if (Object.keys(resources.blockers).length || Object.keys(resources.owned).length) throw fail(TEAM_TEXT.deleteResourcesFirst);
          if (!(await store.deleteTeam(orgId, now))) throw new Answer(notFound());
          await store.event(orgId, {
            type: "organization.deleted",
            subjectKind: "organization",
            subjectId: orgId,
            payload: { name: team.name, slug: team.slug },
            description: `Team ${orgPublicId(orgId)} deleted`,
          });
          return successResponse({ deleted: orgPublicId(orgId) }, requestId);
        }
        if (method !== "PATCH") return methodNotAllowed(requestId);
        await need("organization.settings.update");
        const v = validateTeam(body);
        if (!v.ok) return validationError(requestId, v.errors);
        const updated = await store.updateTeam(orgId, v.name, v.description, now);
        if (!updated) throw new Answer(notFound());
        await store.event(orgId, {
          type: "organization.updated",
          subjectKind: "organization",
          subjectId: orgId,
          payload: { name: updated.name, description: updated.description },
          description: `Team ${orgPublicId(orgId)} updated`,
        });
        return successResponse({ team: publicTeam(updated), canUpdate: true, message: TEAM_TEXT.updated }, requestId);
      }

      // ── PATCH /api/v1/team (DP-107): TeamPolicy::update, then the two settings ──
      if (section === "settings") {
        if (id !== undefined) throw new Answer(notFound());
        if (method !== "PATCH") return methodNotAllowed(requestId);
        await need("organization.settings.update");
        const changes: TeamSettingsChanges = {};
        const errors: Record<string, string[]> = {};
        for (const key of ["isBuildServerFallbackEnabled", "scanImagesOnNewServers"] as const) {
          if (!(key in body)) continue;
          if (typeof body[key] !== "boolean") errors[key] = ["Must be a boolean"];
          else changes[key] = body[key] as boolean;
        }
        if (Object.keys(errors).length) return validationError(requestId, errors);
        if (!Object.keys(changes).length) return validationError(requestId, { body: ["Nothing to update"] });
        const updated = await store.updateTeamSettings(orgId, changes, now);
        if (!updated) throw new Answer(notFound());
        await store.event(orgId, {
          type: "organization.updated",
          subjectKind: "organization",
          subjectId: orgId,
          payload: { name: updated.name, isBuildServerFallbackEnabled: updated.isBuildServerFallbackEnabled, scanImagesOnNewServers: updated.scanImagesOnNewServers },
          description: `Team ${orgPublicId(orgId)} updated`,
        });
        return successResponse(
          {
            organization: {
              id: orgPublicId(orgId),
              name: updated.name,
              createdAt: updated.createdAt.toISOString(),
              updatedAt: updated.updatedAt.toISOString(),
              isBuildServerFallbackEnabled: updated.isBuildServerFallbackEnabled,
              scanImagesOnNewServers: updated.scanImagesOnNewServers,
            },
          },
          requestId,
        );
      }

      // ── Team\DangerZone (DP-75) ───────────────────────────────────────
      if (section === "danger") {
        if (id !== undefined) throw new Answer(notFound());
        if (method !== "GET") return methodNotAllowed(requestId);
        // mount(): authorize('delete', $team) — the owner's page.
        await need("organization.delete");
        const [teams, resources] = await Promise.all([store.countTeams(actor.subjectId), deps.deployResources(orgId)]);
        const personal = isPersonalTeam(team);
        return successResponse(
          {
            team: publicTeam(team),
            role: actorRole,
            personal,
            state: dangerState({ role: actorRole, teams, personal, resources }),
            blockers: resources.blockers,
            owned: resources.owned,
            projects: resources.projects,
            servers: resources.servers,
          },
          requestId,
        );
      }

      // ── Member\Index and Member ───────────────────────────────────────
      if (section === "members") {
        if (id === undefined) {
          if (method !== "GET") return methodNotAllowed(requestId);
          await need("deploy.team.read");
          const [manageMembers, manageInvitations] = await Promise.all([can("organization.member.update_role"), can("organization.invitation.list")]);
          const members = await store.members(orgId);
          return successResponse(
            {
              team: publicTeam(team),
              role: actorRole,
              canManageMembers: manageMembers,
              canManageInvitations: manageInvitations,
              members: members.map((m) => ({
                id: memberPublicId(m.memberId),
                name: m.displayName?.trim() || m.email || m.subjectId,
                email: m.email,
                role: coolifyRole(m.roles),
                you: m.subjectId === actor.subjectId,
                // The 2FA column and count are for who can manage members (member/index.blade.php).
                twoFactor: manageMembers ? m.twoFactorConfirmed : null,
              })),
              membersWithoutTwoFactorCount: manageMembers ? members.filter((m) => !m.twoFactorConfirmed).length : null,
            },
            requestId,
          );
        }
        const memberId = parseMemberPublicId(id);
        if (!memberId) throw new Answer(errorResponse("not_found", "Member not found", 404, requestId));
        if (method !== "PATCH" && method !== "DELETE") return methodNotAllowed(requestId);
        await need(method === "PATCH" ? "organization.member.update_role" : "organization.member.remove");
        const member = await store.member(orgId, memberId);
        if (!member) throw new Answer(errorResponse("not_found", "Member not found", 404, requestId));
        const memberRole = coolifyRole(member.roles);
        const isOwner = member.roles.includes("owner");

        if (method === "DELETE") {
          // Member::remove(): an admin or owner, on a member who does not outrank them.
          if (rank(actorRole) < RANK.admin! || rank(memberRole) > rank(actorRole)) throw fail(TEAM_TEXT.notAuthorized);
          if (isOwner && (await store.countOwners(orgId)) <= 1) throw fail(TEAM_TEXT.lastOwnerRemove);
          if (!(await store.removeMember(orgId, member.memberId, member.subjectId, now))) throw new Answer(errorResponse("not_found", "Member not found", 404, requestId));
          await store.event(orgId, {
            type: "membership.removed",
            subjectKind: "member",
            subjectId: member.memberId,
            payload: { memberId: memberPublicId(member.memberId), previousRoles: member.roles },
            description: `Member ${memberPublicId(member.memberId)} removed from organization`,
          });
          return successResponse({ removed: memberPublicId(member.memberId) }, requestId);
        }

        // makeOwner (an owner), makeAdmin and makeReadonly (an admin or owner), on a member who does not outrank them.
        const target = ({ makeOwner: "owner", makeAdmin: "admin", makeReadonly: "member" } as const)[String(body.action) as "makeOwner"];
        if (!target) return validationError(requestId, { action: ["The action must be makeOwner, makeAdmin or makeReadonly."] });
        const needed = target === "owner" ? RANK.owner! : RANK.admin!;
        if (rank(actorRole) < needed || rank(memberRole) > rank(actorRole)) throw fail(TEAM_TEXT.notAuthorized);
        if (isOwner && target !== "owner" && (await store.countOwners(orgId)) <= 1) throw fail(TEAM_TEXT.lastOwnerRole);
        await store.setRole({ orgId, subjectId: member.subjectId, subjectType: member.subjectType, role: storedRole(target), assignmentId: deps.id(), now });
        await store.event(orgId, {
          type: "membership.updated",
          subjectKind: "member",
          subjectId: member.memberId,
          payload: { memberId: memberPublicId(member.memberId), previousRoles: member.roles, role: storedRole(target) },
          description: `Member ${memberPublicId(member.memberId)} role updated to ${storedRole(target)}`,
        });
        return successResponse({ member: { id: memberPublicId(member.memberId), role: target } }, requestId);
      }

      // ── Invitations and InviteLink ────────────────────────────────────
      if (section === "invitations") {
        if (id === undefined && method === "GET") {
          await need("organization.invitation.list");
          return successResponse({ invitations: (await store.invitations(orgId)).map((i) => publicInvitation(i, now)) }, requestId);
        }
        if (id === undefined && method === "POST") {
          await need("organization.invitation.create");
          const v = validateInvite(body);
          if (!v.ok) return validationError(requestId, v.errors);
          // viaEmail(): Freeploy delivers no email yet (WAITING W5); Coolify hides its button until mail is set up.
          if (body.via !== undefined && body.via !== "link") throw fail(TEAM_TEXT.emailNotConfigured, 501);
          // Prevent privilege escalation: users cannot invite someone with higher privileges.
          // Role::tryFrom() is null for Freeploy's own roles, which Coolify answers as it answers a member.
          if (!(actorRole in RANK) || (actorRole === "member" && rank(v.role) > RANK.member!)) throw fail(TEAM_TEXT.membersCannotInvite);
          if (actorRole === "admin" && v.role === "owner") throw fail(TEAM_TEXT.adminsCannotInviteOwners);
          const email = v.email.toLowerCase();
          const members = await store.members(orgId);
          if (members.some((m) => m.email?.toLowerCase() === email)) throw fail(TEAM_TEXT.alreadyMember(email, team.name));
          const existing = await store.invitationByEmail(orgId, email);
          if (existing) {
            if (!invitationExpired(existing.createdAt, now)) throw fail(TEAM_TEXT.pendingExists(email));
            await store.closeInvitation(orgId, existing.id, "expired", now);
          }
          const limit = await deps.membersLimit(orgId, () => store.billableMembers(orgId, now));
          if (limit && "error" in limit) throw new Answer(errorResponse("internal_error", "Service unavailable", 503, requestId));
          if (limit) throw new Answer(errorResponse("precondition_failed", limit.deny, 412, requestId, limit.reason ? { reason: limit.reason } : undefined));
          const token = await generateInvitationToken();
          const invitation = await store.createInvitation({
            id: deps.id(),
            orgId,
            email,
            role: storedRole(v.role),
            tokenHash: token.hash,
            invitedBy: actor.subjectId,
            createdAt: now,
            expiresAt: new Date(now.getTime() + INVITATION_EXPIRATION_DAYS * 86_400_000),
          });
          await store.event(orgId, {
            type: "invite.created",
            subjectKind: "invitation",
            subjectId: invitation.id,
            payload: { invitationId: invitationPublicId(invitation.id), role: invitation.role, via: "link" },
            description: `Invitation ${invitationPublicId(invitation.id)} created`,
          });
          return successResponse({ invitation: publicInvitation(invitation, now), message: TEAM_TEXT.linkGenerated }, requestId, 201);
        }
        if (id !== undefined && method === "DELETE") {
          await need("organization.invitation.revoke");
          const invId = parseInvitationPublicId(id);
          const inv = invId ? await store.invitation(invId) : null;
          if (!inv || inv.orgId !== orgId || !(await store.closeInvitation(orgId, inv.id, "revoked", now))) throw fail(TEAM_TEXT.invitationNotFound, 404);
          await store.event(orgId, {
            type: "invite.revoked",
            subjectKind: "invitation",
            subjectId: inv.id,
            payload: { invitationId: invitationPublicId(inv.id) },
            description: `Invitation ${invitationPublicId(inv.id)} revoked`,
          });
          return successResponse({ message: TEAM_TEXT.revoked }, requestId);
        }
        return methodNotAllowed(requestId);
      }
      throw new Answer(notFound());
    });
  } catch (e) {
    if (e instanceof Answer) return e.response;
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }
}

/** /v1/team-invitations/{inv}: Controller::showInvitation (GET) and acceptInvitation (POST), for the signed-in user. */
export async function handleTeamInvitation(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext & { email: string },
  invitationParam: string,
  injected?: TeamDeps,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed(requestId);
  const notFound = () => errorResponse("not_found", "Invitation not found", 404, requestId);
  const invId = parseInvitationPublicId(invitationParam);
  if (!invId) return notFound();
  const deps = injected ?? liveDeps(env, actor, requestId);
  if (!deps) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  try {
    return await deps.run(async (store) => {
      const inv = await store.invitation(invId);
      if (!inv) throw new Answer(notFound());
      const team = await store.team(inv.orgId);
      if (!team) throw new Answer(notFound());
      // abort(400, …): the invitation is for the user whose email it names.
      if (inv.email.toLowerCase() !== actor.email.toLowerCase()) throw new Answer(errorResponse("bad_request", TEAM_TEXT.notAllowedToAccept, 400, requestId));
      const now = deps.now();
      // TeamInvitation::isValid(): an expired invitation is deleted, and says so.
      if (invitationExpired(inv.createdAt, now)) {
        await store.closeInvitation(inv.orgId, inv.id, "expired", now);
        return { expired: true } as const;
      }
      const alreadyMember = (await store.memberBySubject(inv.orgId, actor.subjectId)) !== null;
      const shown = { team: { id: orgPublicId(team.id), name: team.name, slug: team.slug }, role: coolifyRole([inv.role]), alreadyMember };
      if (request.method === "GET") return successResponse(shown, requestId);
      if (!alreadyMember) {
        const memberId = await store.addMember({ orgId: inv.orgId, subjectId: actor.subjectId, subjectType: actor.subjectType, role: inv.role, memberId: deps.id(), assignmentId: deps.id(), now });
        await store.event(inv.orgId, {
          type: "membership.added",
          subjectKind: "member",
          subjectId: memberId,
          payload: { memberId: memberPublicId(memberId), role: inv.role, invitationId: invitationPublicId(inv.id) },
          description: `Member ${memberPublicId(memberId)} joined through invitation ${invitationPublicId(inv.id)}`,
        });
      }
      await store.closeInvitation(inv.orgId, inv.id, "accepted", now);
      await store.event(inv.orgId, {
        type: "invite.accepted",
        subjectKind: "invitation",
        subjectId: inv.id,
        payload: { invitationId: invitationPublicId(inv.id), alreadyMember },
        description: `Invitation ${invitationPublicId(inv.id)} accepted`,
      });
      return successResponse({ ...shown, accepted: true }, requestId);
    }).then((r) => (r instanceof Response ? r : errorResponse("bad_request", TEAM_TEXT.expired, 400, requestId)));
  } catch (e) {
    if (e instanceof Answer) return e.response;
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }
}
