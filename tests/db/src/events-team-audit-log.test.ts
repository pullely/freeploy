// The team audit log's read (DP-75, packages/db/src/events/team-audit-log.ts) on the identity, membership
// and events migrations of the manifest: the organization's entries since a time, newest first, in both
// org id forms, with the actor's and the named member's display name and email from identity.users.
import { PGlite } from "@electric-sql/pglite";
import { manifest } from "@saas/db";
import { listTeamAuditRows } from "@saas/db/events";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { executor, migrationSql } from "./deploy-schema.js";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";
const ALICE = "00000000-0000-4000-8000-00000000000a";
const BOB = "00000000-0000-4000-8000-00000000000b";
const MEMBER_BOB = "00000000-0000-4000-8000-0000000000b1";
const hex = (uuid: string) => uuid.replace(/-/g, "");

let db: PGlite;
let ex: TransactionalSqlExecutor;

async function entry(id: string, org: string, type: string, at: string, actor: string, payload: Record<string, unknown> = {}) {
  await db.query(
    `INSERT INTO events.event_log (id, type, source, occurred_at, actor_type, actor_id, org_id, subject_kind, subject_id, request_id, payload)
     VALUES ($1, $2, 'membership-worker', $3, 'user', $4, $5, 'member', 's', 'req', $6)`,
    [`ev_${id}`, type, at, actor, org, JSON.stringify(payload)],
  );
  await db.query(
    `INSERT INTO events.audit_entries (id, event_id, org_id, actor_type, actor_id, event_type, source, subject_kind, subject_id, description, occurred_at, request_id, payload)
     VALUES ($1, $2, $3, 'user', $4, $5, 'membership-worker', 'member', 's', $6, $7, 'req', $8)`,
    [id, `ev_${id}`, org, actor, type, `desc ${id}`, at, JSON.stringify(payload)],
  );
}

beforeAll(async () => {
  db = new PGlite();
  for (const m of manifest.migrations.filter((x) => x.context === "identity" || x.context === "membership" || x.context === "events")) await db.exec(migrationSql(m.id));
  ex = executor(db);
  await db.query(`INSERT INTO identity.users (id, email, email_lower, display_name) VALUES ($1, 'alice@example.com', 'alice@example.com', 'Alice'), ($2, 'bob@example.com', 'bob@example.com', NULL)`, [ALICE, BOB]);
  await db.query(`INSERT INTO membership.organizations (id, name, slug, slug_lower) VALUES ($1, 'Acme', 'acme', 'acme')`, [ORG]);
  await db.query(`INSERT INTO membership.organization_members (id, org_id, subject_id) VALUES ($1, $2, $3)`, [MEMBER_BOB, ORG, `usr_${hex(BOB)}`]);
  await entry("e1", ORG, "organization.updated", "2025-12-30T00:00:00Z", `usr_${hex(ALICE)}`, { name: "Acme" });
  await entry("e2", ORG, "membership.removed", "2025-12-31T00:00:00Z", `usr_${hex(ALICE)}`, { memberId: `mem_${hex(MEMBER_BOB)}` });
  // A legacy row: the org stored as its public id.
  await entry("e3", `org_${hex(ORG)}`, "invite.created", "2025-12-29T00:00:00Z", "sp_key");
  await entry("e4", ORG, "invite.revoked", "2025-08-01T00:00:00Z", `usr_${hex(ALICE)}`);
  await entry("e5", OTHER, "invite.created", "2025-12-31T00:00:00Z", `usr_${hex(ALICE)}`);
}, 120_000);
afterAll(async () => db?.close());

describe("listTeamAuditRows", () => {
  test("the org's entries since the time, newest first, in both org id forms; another org's are not read", async () => {
    const rows = await listTeamAuditRows(ex, ORG, new Date("2025-10-02T00:00:00Z"));
    expect(rows.map((r) => [r.id, r.eventType, r.description])).toEqual([
      ["e2", "membership.removed", "desc e2"],
      ["e1", "organization.updated", "desc e1"],
      ["e3", "invite.created", "desc e3"],
    ]);
    expect(rows[1]!.payload).toEqual({ name: "Acme" });
    expect(rows[1]!.occurredAt.toISOString()).toBe("2025-12-30T00:00:00.000Z");
  });

  test("the actor's and the named member's name and email from identity; none for a service principal", async () => {
    const [removed, , legacy] = await listTeamAuditRows(ex, ORG, new Date("2025-10-02T00:00:00Z"));
    expect([removed!.actorName, removed!.actorEmail, removed!.memberName, removed!.memberEmail]).toEqual(["Alice", "alice@example.com", null, "bob@example.com"]);
    expect([legacy!.actorId, legacy!.actorName, legacy!.actorEmail, legacy!.memberName]).toEqual(["sp_key", null, null, null]);
  });

  test("a limit bounds the read", async () => {
    expect(await listTeamAuditRows(ex, ORG, new Date("2025-01-01T00:00:00Z"), 2)).toHaveLength(2);
  });
});
