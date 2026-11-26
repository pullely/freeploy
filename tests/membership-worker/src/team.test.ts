// The deploy console's team pages (DP-69): membership-worker's handlers/team.ts with an in-memory team
// store and a policy that decides as packages/policy-engine does. Coolify's rules and messages are held
// to Coolify's own answers: tests/policy-worker/fixtures/role-matrix/goldens.json (its emit.php runs
// Team\Index's and InviteLink's validators and TeamInvitation::hasExpired()). The SQL of the store is
// tests/db/src/membership-team.test.ts.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authorize } from "@saas/policy-engine";
import type { RoleAssignment, TeamDeployResources, TeamInvitationRecord, TeamMemberRecord, TeamRecord } from "@saas/db/membership";
import { handleTeam, handleTeamInvitation, invitationExpired, TEAM_TEXT, type TeamDeps, type TeamEvent, type TeamStore } from "@membership-worker/handlers/team";
import { validateInvite, validateTeam } from "@membership-worker/team-validation";
import { invitationPublicId, memberPublicId, orgPublicId } from "@membership-worker/ids";
import type { Env } from "@membership-worker/env";

const goldens = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../policy-worker/fixtures/role-matrix/goldens.json"), "utf8"),
) as {
  teamValidation: Record<string, { input: Record<string, unknown>; errors: Record<string, string[]> }>;
  inviteValidation: Record<string, { input: Record<string, unknown>; errors: Record<string, string[]> }>;
  invitationExpiry: { expiration_days: number; cases: Array<{ ageSeconds: number; expired: boolean }> };
};

const ORG = "00000000-0000-4000-8000-0000000000aa";
const OTHER_ORG = "00000000-0000-4000-8000-0000000000bb";
const NOW = new Date("2026-01-01T00:00:00Z");
const env = { ENVIRONMENT: "test" } as Env;

interface Person {
  subjectId: string;
  email: string;
  name: string;
  roles: string[];
  twoFactor?: boolean;
}

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`;

class World {
  team: TeamRecord = { id: ORG, name: "Acme", slug: "acme", description: null };
  /** DP-107: the team's two settings (migration 730's defaults) and when they last changed. */
  settings = { isBuildServerFallbackEnabled: true, scanImagesOnNewServers: false, updatedAt: NOW };
  members: Array<TeamMemberRecord & { status: string }> = [];
  invitations: Array<TeamInvitationRecord> = [];
  events: TeamEvent[] = [];
  committed = true;
  /** DP-75: the other active teams of each subject, and the team's deploy records. */
  otherTeams: Record<string, number> = {};
  deleted = false;
  resources: TeamDeployResources = { blockers: {}, owned: {}, projects: [], servers: [] };

  add(p: Person): string {
    const memberId = uuid();
    this.members.push({ memberId, subjectId: p.subjectId, subjectType: "user", roles: p.roles, displayName: p.name, email: p.email, twoFactorConfirmed: !!p.twoFactor, createdAt: NOW, status: "active" });
    return memberId;
  }

  invite(email: string, role: string, createdAt = NOW, orgId = ORG): string {
    const id = uuid();
    this.invitations.push({ id, orgId, email, role, status: "pending", createdAt, expiresAt: new Date(createdAt.getTime() + 3 * 86_400_000) });
    return id;
  }

  active() {
    return this.members.filter((m) => m.status === "active");
  }

  store(): TeamStore {
    const w = this;
    return {
      roleAssignments: async (orgId, subjectId) =>
        orgId !== ORG
          ? []
          : (w.active().find((m) => m.subjectId === subjectId)?.roles ?? []).map(
              (role) => ({ id: "ra", orgId, subjectId, subjectType: "user", role, scopeKind: "organization", scopeRef: null, createdAt: NOW, revokedAt: null }) as RoleAssignment,
            ),
      team: async (orgId) => (orgId === ORG ? { ...w.team } : null),
      updateTeam: async (_o, name, description) => {
        w.team = { ...w.team, name, description };
        return { ...w.team };
      },
      updateTeamSettings: async (orgId, changes, now) => {
        if (orgId !== ORG) return null;
        const next = { ...w.settings, ...changes };
        if (next.isBuildServerFallbackEnabled !== w.settings.isBuildServerFallbackEnabled || next.scanImagesOnNewServers !== w.settings.scanImagesOnNewServers) next.updatedAt = now;
        w.settings = next;
        return { id: ORG, name: w.team.name, createdAt: NOW, ...w.settings };
      },
      members: async () => w.active().map((m) => ({ ...m })),
      member: async (_o, id) => w.active().find((m) => m.memberId === id) ?? null,
      memberBySubject: async (_o, s) => w.active().find((m) => m.subjectId === s) ?? null,
      countOwners: async () => w.active().filter((m) => m.roles.includes("owner")).length,
      setRole: async ({ subjectId, role }) => {
        w.active().find((m) => m.subjectId === subjectId)!.roles = [role];
      },
      removeMember: async (_o, id) => {
        const m = w.active().find((x) => x.memberId === id);
        if (!m) return false;
        m.status = "removed";
        return true;
      },
      addMember: async ({ subjectId, role }) => {
        const old = w.members.find((m) => m.subjectId === subjectId);
        if (old) {
          old.status = "active";
          old.roles = [role];
          return old.memberId;
        }
        return w.add({ subjectId, email: `${subjectId}@example.com`, name: subjectId, roles: [role] });
      },
      invitations: async (orgId) => w.invitations.filter((i) => i.orgId === orgId && i.status === "pending"),
      invitation: async (id) => w.invitations.find((i) => i.id === id && i.status === "pending") ?? null,
      invitationByEmail: async (orgId, e) => w.invitations.find((i) => i.orgId === orgId && i.email === e && i.status === "pending") ?? null,
      createInvitation: async (input) => {
        const inv = { id: input.id, orgId: input.orgId, email: input.email, role: input.role, status: "pending", createdAt: input.createdAt, expiresAt: input.expiresAt };
        w.invitations.push(inv);
        return inv;
      },
      closeInvitation: async (_o, id, status) => {
        const i = w.invitations.find((x) => x.id === id && x.status === "pending");
        if (!i) return false;
        i.status = status;
        return true;
      },
      billableMembers: async () => w.active().length + w.invitations.filter((i) => i.status === "pending").length,
      event: async (_o, e) => {
        w.events.push(e);
      },
      countTeams: async (subjectId) => (w.deleted || !w.active().some((m) => m.subjectId === subjectId) ? 0 : 1) + (w.otherTeams[subjectId] ?? 0),
      deleteTeam: async () => {
        if (w.deleted) return false;
        w.deleted = true;
        for (const m of w.active()) m.status = "removed";
        for (const i of w.invitations) if (i.status === "pending") i.status = "revoked";
        return true;
      },
    };
  }

  deps(opts: { now?: Date; limit?: { deny: string } | null } = {}): TeamDeps {
    return {
      // A transaction: a thrown answer rolls back (here, by working on a copy).
      run: async (fn) => {
        const snapshot = JSON.stringify({ team: this.team, members: this.members, invitations: this.invitations, events: this.events });
        try {
          return await fn(this.store());
        } catch (e) {
          const s = JSON.parse(snapshot, (k, v) => (k === "createdAt" || k === "expiresAt" ? new Date(v as string) : v)) as World;
          Object.assign(this, { team: s.team, members: s.members, invitations: s.invitations, events: s.events });
          throw e;
        }
      },
      authorize: async (action, orgId, roles) =>
        authorize({
          subject: { type: "user", id: "usr_x" },
          action,
          resource: { kind: "organization", orgId },
          context: { memberships: roles.map((r) => ({ kind: "role_assignment", role: r.role as "owner", scope: { kind: "organization", orgId } })) },
        }).allow,
      deployResources: async () => structuredClone(this.resources),
      membersLimit: async () => opts.limit ?? null,
      now: () => opts.now ?? NOW,
      id: uuid,
    };
  }
}

const OWNER: Person = { subjectId: "usr_owner", email: "owner@example.com", name: "Owner", roles: ["owner"], twoFactor: true };
const OWNER2: Person = { subjectId: "usr_owner2", email: "owner2@example.com", name: "Owner Two", roles: ["owner"] };
const ADMIN: Person = { subjectId: "usr_admin", email: "admin@example.com", name: "Admin", roles: ["admin"] };
const ADMIN2: Person = { subjectId: "usr_admin2", email: "admin2@example.com", name: "Admin Two", roles: ["admin"] };
const MEMBER: Person = { subjectId: "usr_member", email: "member@example.com", name: "Member", roles: ["builder"] };
const VIEWER: Person = { subjectId: "usr_viewer", email: "viewer@example.com", name: "Viewer", roles: ["viewer"] };
const BILLING: Person = { subjectId: "usr_billing", email: "billing@example.com", name: "Billing", roles: ["billing_admin"] };

function world(...people: Person[]): { w: World; ids: Record<string, string> } {
  const w = new World();
  const ids: Record<string, string> = {};
  for (const p of people) ids[p.subjectId] = w.add({ ...p, roles: [...p.roles] });
  return { w, ids };
}

async function call(w: World, as: Person, method: string, path: string, body?: unknown, deps?: TeamDeps) {
  const segments = path.split("/").filter(Boolean);
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await handleTeam(new Request(`https://membership.internal/v1/organizations/${orgPublicId(ORG)}/team${path}`, init), env, "req_t", { subjectId: as.subjectId, subjectType: "user" }, orgPublicId(ORG), segments, deps ?? w.deps());
  return { status: res.status, json: (await res.json()) as { data?: Record<string, unknown> & { message?: string }; error?: { message: string; details?: { fields?: Record<string, string[]> } } } };
}

async function accept(w: World, as: Person, method: string, invId: string, deps?: TeamDeps) {
  const res = await handleTeamInvitation(new Request(`https://membership.internal/v1/team-invitations/${invitationPublicId(invId)}`, { method }), env, "req_t", { subjectId: as.subjectId, subjectType: "user", email: as.email }, invitationPublicId(invId), deps ?? w.deps());
  return { status: res.status, json: (await res.json()) as { data?: Record<string, unknown>; error?: { message: string } } };
}

describe("Coolify's validators, case by case (goldens.json)", () => {
  test.each(Object.entries(goldens.teamValidation))("Team\\Index: %s", (_case, { input, errors }) => {
    const v = validateTeam(input);
    expect(v.ok ? {} : v.errors).toEqual(errors);
  });
  test.each(Object.entries(goldens.inviteValidation))("InviteLink: %s", (_case, { input, errors }) => {
    const v = validateInvite(input);
    expect(v.ok ? {} : v.errors).toEqual(errors);
  });
  test.each(goldens.invitationExpiry.cases)("TeamInvitation::hasExpired() after $ageSeconds s: $expired", ({ ageSeconds, expired }) => {
    expect(goldens.invitationExpiry.expiration_days).toBe(3);
    expect(invitationExpired(new Date(NOW.getTime() - ageSeconds * 1000), NOW)).toBe(expired);
  });
});

describe("GET and PATCH /team (Team\\Index)", () => {
  test("every member reads the team; only owners and admins may update it", async () => {
    const { w } = world(OWNER, ADMIN, MEMBER, VIEWER, BILLING);
    for (const [p, canUpdate] of [[OWNER, true], [ADMIN, true], [MEMBER, false], [VIEWER, false]] as const) {
      const r = await call(w, p, "GET", "");
      expect(r.status).toBe(200);
      expect(r.json.data).toEqual({ team: { id: orgPublicId(ORG), name: "Acme", slug: "acme", description: null }, canUpdate });
    }
    // billing_admin has no part in the deploy console.
    expect((await call(w, BILLING, "GET", "")).status).toBe(404);
    // Not a member at all.
    expect((await call(w, { ...OWNER, subjectId: "usr_stranger" }, "GET", "")).status).toBe(404);
  });

  test("submit(): validated with Coolify's messages, saved, and answered with its toast", async () => {
    const { w } = world(OWNER, MEMBER);
    const bad = await call(w, OWNER, "PATCH", "", { name: "", description: "<b>" });
    expect(bad.status).toBe(422);
    expect(bad.json.error!.details!.fields).toEqual({
      name: ["The Name field is required."],
      description: [goldens.teamValidation["bad-description"]!.errors.description![0]],
    });
    const ok = await call(w, OWNER, "PATCH", "", { name: "Acme Platform", description: "Ops & dev" });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toEqual({ team: { id: orgPublicId(ORG), name: "Acme Platform", slug: "acme", description: "Ops & dev" }, canUpdate: true, message: "Team updated." });
    expect(w.events.map((e) => e.type)).toEqual(["organization.updated"]);
    // A member may not update (TeamPolicy::update), whatever they send.
    expect((await call(w, MEMBER, "PATCH", "", { name: "Mine now" })).status).toBe(404);
    expect(w.team.name).toBe("Acme Platform");
  });

  test("Coolify's own personal team name does not pass its rules (the apostrophe)", async () => {
    const { w } = world(OWNER);
    const r = await call(w, OWNER, "PATCH", "", { name: "Parity User's Team" });
    expect(r.status).toBe(422);
    expect(r.json.error!.details!.fields!.name).toEqual(goldens.teamValidation.valid!.errors.name);
  });
});

describe("PATCH /team/settings (PATCH /api/v1/team, DP-107)", () => {
  test("owners and admins change the two settings; members, viewers and billing admins do not", async () => {
    const { w } = world(OWNER, ADMIN, MEMBER, VIEWER, BILLING);
    for (const p of [MEMBER, VIEWER, BILLING]) expect((await call(w, p, "PATCH", "/settings", { scanImagesOnNewServers: true })).status).toBe(404);
    expect(w.settings.scanImagesOnNewServers).toBe(false);
    const later = new Date(NOW.getTime() + 60_000);
    const r = await call(w, ADMIN, "PATCH", "/settings", { isBuildServerFallbackEnabled: false, scanImagesOnNewServers: true }, w.deps({ now: later }));
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({
      organization: { id: orgPublicId(ORG), name: "Acme", createdAt: NOW.toISOString(), updatedAt: later.toISOString(), isBuildServerFallbackEnabled: false, scanImagesOnNewServers: true },
    });
    expect(w.events.map((e) => e.type)).toEqual(["organization.updated"]);
    // The same values again: nothing changes, not even the date.
    const again = await call(w, OWNER, "PATCH", "/settings", { scanImagesOnNewServers: true }, w.deps({ now: new Date(later.getTime() + 60_000) }));
    expect((again.json.data!.organization as { updatedAt: string }).updatedAt).toBe(later.toISOString());
  });

  test("takes booleans only, and something to change", async () => {
    const { w } = world(OWNER);
    expect((await call(w, OWNER, "PATCH", "/settings", { scanImagesOnNewServers: "1" })).status).toBe(422);
    expect((await call(w, OWNER, "PATCH", "/settings", {})).status).toBe(422);
    expect((await call(w, OWNER, "GET", "/settings")).status).toBe(405);
    expect(w.settings.scanImagesOnNewServers).toBe(false);
  });
});

describe("GET /team/members (Member\\Index)", () => {
  test("every member sees the list with roles; the 2FA column and count are for who can manage members", async () => {
    const { w, ids } = world(OWNER, ADMIN, MEMBER, VIEWER);
    const asOwner = await call(w, OWNER, "GET", "/members");
    expect(asOwner.status).toBe(200);
    expect(asOwner.json.data).toMatchObject({ role: "owner", canManageMembers: true, canManageInvitations: true, membersWithoutTwoFactorCount: 3 });
    expect(asOwner.json.data!.members).toEqual([
      { id: memberPublicId(ids.usr_owner!), name: "Owner", email: "owner@example.com", role: "owner", you: true, twoFactor: true },
      { id: memberPublicId(ids.usr_admin!), name: "Admin", email: "admin@example.com", role: "admin", you: false, twoFactor: false },
      { id: memberPublicId(ids.usr_member!), name: "Member", email: "member@example.com", role: "member", you: false, twoFactor: false },
      { id: memberPublicId(ids.usr_viewer!), name: "Viewer", email: "viewer@example.com", role: "viewer", you: false, twoFactor: false },
    ]);
    const asMember = await call(w, MEMBER, "GET", "/members");
    expect(asMember.json.data).toMatchObject({ role: "member", canManageMembers: false, canManageInvitations: false, membersWithoutTwoFactorCount: null });
    expect((asMember.json.data!.members as Array<{ twoFactor: unknown }>).every((m) => m.twoFactor === null)).toBe(true);
  });
});

describe("PATCH and DELETE /team/members/{member} (Member)", () => {
  const not = TEAM_TEXT.notAuthorized;
  // [actor, target, action, the answer: null = done, else the message]. Member.php: manageMembers, then
  // the actor's rank must reach admin (owner for makeOwner) and the target must not outrank the actor.
  const cases: Array<[Person, Person, string, string | null | 404]> = [
    [OWNER, MEMBER, "makeOwner", null],
    [OWNER, MEMBER, "makeAdmin", null],
    [OWNER, ADMIN, "makeReadonly", null],
    [OWNER, OWNER2, "makeAdmin", null],
    [OWNER, OWNER2, "makeReadonly", null],
    [ADMIN, MEMBER, "makeAdmin", null],
    [ADMIN, ADMIN2, "makeReadonly", null],
    [ADMIN, MEMBER, "makeOwner", not],
    [ADMIN, OWNER, "makeAdmin", not],
    [ADMIN, OWNER, "makeReadonly", not],
    [ADMIN, OWNER, "makeOwner", not],
    [ADMIN, VIEWER, "makeAdmin", null],
    // A member cannot manage members at all (TeamPolicy::manageMembers): the route answers 404.
    [MEMBER, ADMIN, "makeReadonly", 404],
    [MEMBER, VIEWER, "makeAdmin", 404],
  ];
  test.each(cases)("%s → %s: %s", async (actor, target, action, answer) => {
    const { w, ids } = world(OWNER, OWNER2, ADMIN, ADMIN2, MEMBER, VIEWER);
    const r = await call(w, actor, "PATCH", `/members/${memberPublicId(ids[target.subjectId]!)}`, { action });
    if (answer === null) {
      expect(r.status).toBe(200);
      const role = { makeOwner: "owner", makeAdmin: "admin", makeReadonly: "builder" }[action]!;
      expect(w.active().find((m) => m.subjectId === target.subjectId)!.roles).toEqual([role]);
      expect(w.events.map((e) => e.type)).toEqual(["membership.updated"]);
    } else if (answer === 404) {
      expect(r.status).toBe(404);
    } else {
      expect([r.status, r.json.error!.message]).toEqual([422, answer]);
      expect(w.active().find((m) => m.subjectId === target.subjectId)!.roles).toEqual(target.roles);
    }
  });

  const removals: Array<[Person, Person, string | null | 404]> = [
    [OWNER, OWNER2, null],
    [OWNER, ADMIN, null],
    [OWNER, MEMBER, null],
    [ADMIN, ADMIN2, null],
    [ADMIN, MEMBER, null],
    [ADMIN, OWNER, not],
    [MEMBER, VIEWER, 404],
  ];
  test.each(removals)("remove: %s → %s", async (actor, target, answer) => {
    const { w, ids } = world(OWNER, OWNER2, ADMIN, ADMIN2, MEMBER, VIEWER);
    const r = await call(w, actor, "DELETE", `/members/${memberPublicId(ids[target.subjectId]!)}`);
    const still = w.active().some((m) => m.subjectId === target.subjectId);
    if (answer === null) {
      expect([r.status, still]).toEqual([200, false]);
      expect(w.events.map((e) => e.type)).toEqual(["membership.removed"]);
    } else if (answer === 404) {
      expect([r.status, still]).toEqual([404, true]);
    } else {
      expect([r.status, r.json.error!.message, still]).toEqual([422, answer, true]);
    }
  });

  test("Freeploy keeps the last owner (Coolify has no such rule)", async () => {
    const { w, ids } = world(OWNER, ADMIN);
    const demote = await call(w, OWNER, "PATCH", `/members/${memberPublicId(ids.usr_owner!)}`, { action: "makeAdmin" });
    expect([demote.status, demote.json.error!.message]).toEqual([422, TEAM_TEXT.lastOwnerRole]);
    const remove = await call(w, OWNER, "DELETE", `/members/${memberPublicId(ids.usr_owner!)}`);
    expect([remove.status, remove.json.error!.message]).toEqual([422, TEAM_TEXT.lastOwnerRemove]);
    expect(w.active().find((m) => m.subjectId === "usr_owner")!.roles).toEqual(["owner"]);
  });

  test("an unknown action, an unknown member", async () => {
    const { w, ids } = world(OWNER, MEMBER);
    expect((await call(w, OWNER, "PATCH", `/members/${memberPublicId(ids.usr_member!)}`, { action: "makeGod" })).status).toBe(422);
    expect((await call(w, OWNER, "PATCH", `/members/${memberPublicId("00000000-0000-4000-8000-ffffffffffff")}`, { action: "makeAdmin" })).status).toBe(404);
    expect((await call(w, OWNER, "DELETE", "/members/nope")).status).toBe(404);
  });
});

describe("/team/invitations (InviteLink, Invitations)", () => {
  test("an owner or admin generates a link; the toast is Coolify's, and the role is stored as Freeploy's", async () => {
    const { w } = world(OWNER, ADMIN, MEMBER);
    const r = await call(w, ADMIN, "POST", "/invitations", { email: "New@Example.com", role: "member" });
    expect(r.status).toBe(201);
    expect(r.json.data!.message).toBe("Invitation link generated.");
    const inv = w.invitations[0]!;
    expect(inv).toMatchObject({ email: "new@example.com", role: "builder", status: "pending" });
    expect(inv.expiresAt.getTime() - inv.createdAt.getTime()).toBe(3 * 86_400_000);
    expect(r.json.data!.invitation).toEqual({ id: invitationPublicId(inv.id), email: "new@example.com", role: "member", via: "link", path: `/invitations/${invitationPublicId(inv.id)}`, createdAt: NOW.toISOString(), expired: false });
    const list = await call(w, OWNER, "GET", "/invitations");
    expect((list.json.data!.invitations as unknown[]).length).toBe(1);
  });

  test.each([
    [ADMIN, "owner", TEAM_TEXT.adminsCannotInviteOwners],
    [OWNER, "owner", null],
    [ADMIN, "admin", null],
  ] as const)("%s invites a %s", async (actor, role, answer) => {
    const { w } = world(OWNER, ADMIN);
    const r = await call(w, actor, "POST", "/invitations", { email: "x@example.com", role });
    if (answer === null) expect(r.status).toBe(201);
    else expect([r.status, r.json.error!.message, w.invitations.length]).toEqual([422, answer, 0]);
  });

  test("members and viewers cannot manage invitations at all (TeamPolicy::manageInvitations)", async () => {
    const { w } = world(OWNER, MEMBER, VIEWER);
    for (const p of [MEMBER, VIEWER]) {
      expect((await call(w, p, "POST", "/invitations", { email: "x@example.com", role: "member" })).status).toBe(404);
      expect((await call(w, p, "GET", "/invitations")).status).toBe(404);
    }
  });

  test("Coolify's refusals, word for word", async () => {
    const { w } = world(OWNER, MEMBER);
    const member = await call(w, OWNER, "POST", "/invitations", { email: "MEMBER@example.com", role: "member" });
    expect([member.status, member.json.error!.message]).toEqual([422, "member@example.com is already a member of Acme."]);
    await call(w, OWNER, "POST", "/invitations", { email: "new@example.com", role: "member" });
    const again = await call(w, OWNER, "POST", "/invitations", { email: "new@example.com", role: "admin" });
    expect([again.status, again.json.error!.message]).toEqual([422, "Pending invitation already exists for new@example.com."]);
    const invalid = await call(w, OWNER, "POST", "/invitations", { email: "nope", role: "viewer" });
    expect(invalid.json.error!.details!.fields).toEqual({ email: ["The email field must be a valid email address."], role: ["The selected role is invalid."] });
  });

  test("an expired invitation for the address is replaced", async () => {
    const { w } = world(OWNER);
    const old = w.invite("new@example.com", "builder", new Date(NOW.getTime() - 3 * 86_400_000 - 1000));
    const r = await call(w, OWNER, "POST", "/invitations", { email: "new@example.com", role: "admin" });
    expect(r.status).toBe(201);
    expect(w.invitations.find((i) => i.id === old)!.status).toBe("expired");
    expect(w.invitations.filter((i) => i.status === "pending").map((i) => i.role)).toEqual(["admin"]);
  });

  test("sending by email is not available: no email is sent and none is claimed (WAITING W5)", async () => {
    const { w } = world(OWNER);
    const r = await call(w, OWNER, "POST", "/invitations", { email: "new@example.com", role: "member", via: "email" });
    expect([r.status, r.json.error!.message, w.invitations.length]).toEqual([501, "Email delivery is not configured", 0]);
  });

  test("the plan's member limit still applies", async () => {
    const { w } = world(OWNER);
    const r = await call(w, OWNER, "POST", "/invitations", { email: "new@example.com", role: "member" }, w.deps({ limit: { deny: "Member limit reached for your current plan" } }));
    expect([r.status, w.invitations.length]).toEqual([412, 0]);
  });

  test("revoke: Coolify's toast, and 'Invitation not found.' for one that is gone or another team's", async () => {
    const { w } = world(OWNER);
    const id = w.invite("new@example.com", "builder");
    const theirs = w.invite("x@example.com", "builder", NOW, OTHER_ORG);
    const r = await call(w, OWNER, "DELETE", `/invitations/${invitationPublicId(id)}`);
    expect([r.status, r.json.data!.message]).toEqual([200, "Invitation revoked."]);
    for (const gone of [id, theirs]) {
      const again = await call(w, OWNER, "DELETE", `/invitations/${invitationPublicId(gone)}`);
      expect([again.status, again.json.error!.message]).toEqual([404, "Invitation not found."]);
    }
    expect(w.invitations.find((i) => i.id === theirs)!.status).toBe("pending");
  });
});

describe("/v1/team-invitations/{inv} (showInvitation, acceptInvitation)", () => {
  const INVITEE: Person = { subjectId: "usr_new", email: "new@example.com", name: "New", roles: [] };

  test("shows the team and role, then accepts: a member with the invitation's role, the invitation gone", async () => {
    const { w } = world(OWNER);
    const id = w.invite("new@example.com", "admin");
    const shown = await accept(w, INVITEE, "GET", id);
    expect(shown.json.data).toEqual({ team: { id: orgPublicId(ORG), name: "Acme", slug: "acme" }, role: "admin", alreadyMember: false });
    const done = await accept(w, INVITEE, "POST", id);
    expect(done.status).toBe(200);
    expect(w.active().find((m) => m.subjectId === "usr_new")!.roles).toEqual(["admin"]);
    expect(w.invitations[0]!.status).toBe("accepted");
    expect(w.events.map((e) => e.type)).toEqual(["membership.added", "invite.accepted"]);
    expect((await accept(w, INVITEE, "POST", id)).status).toBe(404);
  });

  test("abort(400): another user's invitation; an expired one is deleted and says so", async () => {
    const { w } = world(OWNER);
    const id = w.invite("new@example.com", "builder");
    const other = await accept(w, OWNER, "GET", id);
    expect([other.status, other.json.error!.message]).toEqual([400, "You are not allowed to accept this invitation."]);
    const old = w.invite("late@example.com", "builder", new Date(NOW.getTime() - 4 * 86_400_000));
    const late = await accept(w, { ...INVITEE, email: "late@example.com" }, "POST", old);
    expect([late.status, late.json.error!.message]).toEqual([400, "Invitation expired."]);
    expect(w.invitations.find((i) => i.id === old)!.status).toBe("expired");
  });

  test("already a member: the invitation is dismissed and the role kept", async () => {
    const { w } = world(OWNER, MEMBER);
    const id = w.invite("member@example.com", "admin");
    expect((await accept(w, MEMBER, "GET", id)).json.data!.alreadyMember).toBe(true);
    expect((await accept(w, MEMBER, "POST", id)).status).toBe(200);
    expect(w.active().find((m) => m.subjectId === MEMBER.subjectId)!.roles).toEqual(["builder"]);
    expect(w.invitations[0]!.status).toBe("accepted");
  });

  test("a removed member who is invited again comes back", async () => {
    const { w, ids } = world(OWNER, MEMBER);
    await call(w, OWNER, "DELETE", `/members/${memberPublicId(ids.usr_member!)}`);
    const id = w.invite("member@example.com", "builder");
    expect((await accept(w, MEMBER, "POST", id)).status).toBe(200);
    expect(w.active().find((m) => m.subjectId === MEMBER.subjectId)!.memberId).toBe(ids.usr_member);
  });
});

// ── The Danger Zone (DP-75): Team\DangerZone, danger-zone.blade.php and DeleteTeam::handle() ──
describe("GET /team/danger and DELETE /team (Team\\DangerZone)", () => {
  const EMPTY: TeamDeployResources = { blockers: {}, owned: {}, projects: [], servers: [] };

  test("mount() authorizes delete: the owner's page; admins, members and the others get the 404 of every denial", async () => {
    const { w } = world(OWNER, ADMIN, MEMBER, VIEWER, BILLING);
    w.otherTeams[OWNER.subjectId] = 1;
    for (const p of [ADMIN, MEMBER, VIEWER, BILLING]) {
      expect([p.subjectId, (await call(w, p, "GET", "/danger")).status]).toEqual([p.subjectId, 404]);
      expect([p.subjectId, (await call(w, p, "DELETE", "")).status]).toEqual([p.subjectId, 404]);
    }
    expect(w.deleted).toBe(false);
    const r = await call(w, OWNER, "GET", "/danger");
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({ team: { id: orgPublicId(ORG), name: "Acme", slug: "acme", description: null }, role: "owner", personal: false, state: "deletable", ...EMPTY });
  });

  test("the last team, or a personal one, cannot be deleted: the page says so and DELETE refuses", async () => {
    const { w } = world(OWNER);
    expect((await call(w, OWNER, "GET", "/danger")).json.data!.state).toBe("last-or-personal");
    const last = await call(w, OWNER, "DELETE", "");
    expect([last.status, last.json.error!.message]).toEqual([422, "Your last or personal team cannot be deleted."]);
    // identity-worker's personal organization (solo-mode.ts: personal-<user id>), even with other teams.
    w.otherTeams[OWNER.subjectId] = 3;
    w.team = { ...w.team, slug: "personal-usr-owner" };
    const page = await call(w, OWNER, "GET", "/danger");
    expect([page.json.data!.state, page.json.data!.personal]).toEqual(["last-or-personal", true]);
    const personal = await call(w, OWNER, "DELETE", "");
    expect([personal.status, personal.json.error!.message]).toEqual([422, TEAM_TEXT.lastOrPersonal]);
    expect(w.deleted).toBe(false);
  });

  test("Team::deletionBlockers(): the page lists them; DeleteTeam refuses servers first, then every other resource", async () => {
    const { w } = world(OWNER);
    w.otherTeams[OWNER.subjectId] = 1;
    w.resources = { blockers: { projects: 2, servers: 1, sources: 1 }, owned: {}, projects: [{ uuid: "p1", name: "Shop" }, { uuid: "p2", name: "Blog" }], servers: [{ uuid: "s1", name: "localhost" }] };
    const page = await call(w, OWNER, "GET", "/danger");
    expect(page.json.data).toMatchObject({ state: "blocked", blockers: { projects: 2, servers: 1, sources: 1 }, projects: [{ uuid: "p1", name: "Shop" }, { uuid: "p2", name: "Blog" }], servers: [{ uuid: "s1", name: "localhost" }] });
    const servers = await call(w, OWNER, "DELETE", "");
    expect([servers.status, servers.json.error!.message]).toEqual([422, "Delete all team servers before deleting this team."]);
    w.resources = { ...EMPTY, blockers: { sources: 1 } };
    const sources = await call(w, OWNER, "DELETE", "");
    expect([sources.status, sources.json.error!.message]).toEqual([422, "Delete all team resources before deleting this team."]);
    // What Coolify deletes with the team (private keys, S3 storages, …) holds it in Freeploy: membership cannot delete deploy records.
    w.resources = { ...EMPTY, owned: { privateKeys: 1, storages: 2 } };
    expect((await call(w, OWNER, "GET", "/danger")).json.data!.state).toBe("blocked");
    const owned = await call(w, OWNER, "DELETE", "");
    expect([owned.status, owned.json.error!.message]).toEqual([422, TEAM_TEXT.deleteResourcesFirst]);
    expect(w.deleted).toBe(false);
    expect(w.events).toEqual([]);
  });

  test("an empty team that is not the owner's last: deleted, its members and invitations ended, and the event recorded", async () => {
    const { w } = world(OWNER, ADMIN, MEMBER);
    w.otherTeams[OWNER.subjectId] = 1;
    w.invite("new@example.com", "builder");
    const r = await call(w, OWNER, "DELETE", "");
    expect([r.status, r.json.data]).toEqual([200, { deleted: orgPublicId(ORG) }]);
    expect(w.deleted).toBe(true);
    expect(w.active()).toEqual([]);
    expect(w.invitations.map((i) => i.status)).toEqual(["revoked"]);
    expect(w.events).toEqual([{ type: "organization.deleted", subjectKind: "organization", subjectId: ORG, payload: { name: "Acme", slug: "acme" }, description: `Team ${orgPublicId(ORG)} deleted` }]);
    // It is gone: every route answers 404.
    expect((await call(w, OWNER, "GET", "")).status).toBe(404);
    expect((await call(w, OWNER, "DELETE", "")).status).toBe(404);
  });

  test("the danger page takes GET only, and nothing below it", async () => {
    const { w } = world(OWNER);
    expect((await call(w, OWNER, "POST", "/danger", {})).status).toBe(405);
    expect((await call(w, OWNER, "GET", "/danger/x")).status).toBe(404);
  });
});
