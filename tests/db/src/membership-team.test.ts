// The team pages' queries (DP-69, packages/db/src/membership/team.ts) on the identity and membership
// migrations of the manifest, up to 710 (the team description): the team and its rename, the members
// with their names, emails, roles and two-factor state, role changes and removal, the pending
// invitations and their end, and a removed member coming back through an invitation.
import { PGlite } from "@electric-sql/pglite";
import { manifest } from "@saas/db";
import {
  findTeam,
  updateTeam,
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
} from "@saas/db/membership";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { executor, migrationSql } from "./deploy-schema.js";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER_A = "00000000-0000-4000-8000-00000000000a";
const USER_B = "00000000-0000-4000-8000-00000000000b";
const subject = (uuid: string) => `usr_${uuid.replace(/-/g, "")}`;
const NOW = new Date("2026-01-01T00:00:00Z");

let db: PGlite;
let ex: TransactionalSqlExecutor;
beforeAll(async () => {
  db = new PGlite();
  // identity and membership as the manifest has them, in its order.
  for (const m of manifest.migrations.filter((x) => x.context === "identity" || x.context === "membership")) await db.exec(migrationSql(m.id));
  ex = executor(db);
  await db.query(`INSERT INTO identity.users (id, email, email_lower, display_name) VALUES ($1, 'Alice@example.com', 'alice@example.com', 'Alice'), ($2, 'bob@example.com', 'bob@example.com', NULL)`, [USER_A, USER_B]);
  await db.query(`INSERT INTO identity.two_factor (user_id, secret, recovery_codes, confirmed_at) VALUES ($1, 's', 'r', now())`, [USER_A]);
  await db.query(`INSERT INTO membership.organizations (id, name, slug, slug_lower) VALUES ($1, 'Alice''s Team', 'alice', 'alice')`, [ORG]);
  await db.query(
    `INSERT INTO membership.organization_members (id, org_id, subject_id, created_at) VALUES ($4, $1, $2, '2026-01-01'), ($5, $1, $3, '2026-01-02')`,
    [ORG, subject(USER_A), subject(USER_B), MEMBER_A, MEMBER_B],
  );
  await db.query(
    `INSERT INTO membership.role_assignments (id, org_id, subject_id, role) VALUES (gen_random_uuid(), $1, $2, 'owner'), (gen_random_uuid(), $1, $3, 'builder')`,
    [ORG, subject(USER_A), subject(USER_B)],
  );
}, 120_000);
afterAll(async () => db?.close());

const MEMBER_A = "00000000-0000-4000-8000-0000000000a1";
const MEMBER_B = "00000000-0000-4000-8000-0000000000a2";

describe("membership team queries", () => {
  test("710 adds the description; the team is renamed and described, its slug kept", async () => {
    expect(await findTeam(ex, ORG)).toEqual({ id: ORG, name: "Alice's Team", slug: "alice", description: null });
    expect(await updateTeam(ex, ORG, "Acme", "Ops & dev", NOW)).toEqual({ id: ORG, name: "Acme", slug: "alice", description: "Ops & dev" });
    expect(await findTeam(ex, ORG)).toMatchObject({ name: "Acme", description: "Ops & dev" });
    expect(await findTeam(ex, "00000000-0000-4000-8000-0000000000ff")).toBeNull();
  });

  test("the members, oldest first, with identity's name, email and two-factor state and their org roles", async () => {
    const members = await listTeamMembers(ex, ORG);
    expect(members.map((m) => [m.memberId, m.displayName, m.email, m.roles, m.twoFactorConfirmed])).toEqual([
      [MEMBER_A, "Alice", "Alice@example.com", ["owner"], true],
      [MEMBER_B, null, "bob@example.com", ["builder"], false],
    ]);
    expect((await findTeamMember(ex, ORG, MEMBER_B))?.subjectId).toBe(subject(USER_B));
    expect((await findTeamMemberBySubject(ex, ORG, subject(USER_A)))?.memberId).toBe(MEMBER_A);
    expect(await countTeamOwners(ex, ORG)).toBe(1);
  });

  test("a role change replaces the member's organization roles with one", async () => {
    await ex.transaction(async (tx) => {
      await setTeamMemberRole(tx, { orgId: ORG, subjectId: subject(USER_B), subjectType: "user", role: "owner", assignmentId: "00000000-0000-4000-8000-0000000000c1", now: NOW });
    });
    expect((await findTeamMember(ex, ORG, MEMBER_B))?.roles).toEqual(["owner"]);
    expect(await countTeamOwners(ex, ORG)).toBe(2);
    await setTeamMemberRole(ex, { orgId: ORG, subjectId: subject(USER_B), subjectType: "user", role: "builder", assignmentId: "00000000-0000-4000-8000-0000000000c2", now: NOW });
    expect((await findTeamMember(ex, ORG, MEMBER_B))?.roles).toEqual(["builder"]);
  });

  test("invitations: created, found by id and address, listed while pending, closed once", async () => {
    const inv = await createTeamInvitation(ex, {
      id: "00000000-0000-4000-8000-0000000000d1",
      orgId: ORG,
      email: "Carol@Example.com",
      role: "admin",
      tokenHash: "a".repeat(64),
      invitedBy: subject(USER_A),
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 3 * 86_400_000),
    });
    expect(inv).toMatchObject({ orgId: ORG, email: "Carol@Example.com", role: "admin", status: "pending" });
    expect((await findTeamInvitation(ex, inv.id))?.id).toBe(inv.id);
    expect((await findTeamInvitationByEmail(ex, ORG, "carol@example.com"))?.id).toBe(inv.id);
    expect((await listTeamInvitations(ex, ORG)).map((i) => i.id)).toEqual([inv.id]);
    expect(await closeTeamInvitation(ex, ORG, inv.id, "revoked", NOW)).toBe(true);
    expect(await closeTeamInvitation(ex, ORG, inv.id, "revoked", NOW)).toBe(false);
    expect(await findTeamInvitation(ex, inv.id)).toBeNull();
    expect(await listTeamInvitations(ex, ORG)).toEqual([]);
    const row = await db.query<{ status: string; revoked_at: unknown }>(`SELECT status, revoked_at FROM membership.organization_invitations WHERE id = $1`, [inv.id]);
    expect(row.rows[0]!.status).toBe("revoked");
    expect(row.rows[0]!.revoked_at).not.toBeNull();
  });

  test("a removed member loses their roles, and comes back through an invitation on the same row", async () => {
    expect(await removeTeamMember(ex, ORG, MEMBER_B, subject(USER_B), NOW)).toBe(true);
    expect(await removeTeamMember(ex, ORG, MEMBER_B, subject(USER_B), NOW)).toBe(false);
    expect((await listTeamMembers(ex, ORG)).map((m) => m.memberId)).toEqual([MEMBER_A]);
    const active = await db.query(`SELECT 1 FROM membership.role_assignments WHERE subject_id = $1 AND revoked_at IS NULL`, [subject(USER_B)]);
    expect(active.rows.length).toBe(0);
    const id = await addTeamMember(ex, { orgId: ORG, subjectId: subject(USER_B), subjectType: "user", role: "admin", memberId: "00000000-0000-4000-8000-0000000000e1", assignmentId: "00000000-0000-4000-8000-0000000000e2", now: NOW });
    expect(id).toBe(MEMBER_B);
    expect((await findTeamMember(ex, ORG, MEMBER_B))?.roles).toEqual(["admin"]);
  });
});
