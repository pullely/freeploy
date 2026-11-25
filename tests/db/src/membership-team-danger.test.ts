// The team's Danger Zone queries (DP-75, packages/db/src/membership/team-danger.ts) on the identity,
// membership and deploy migrations of the manifest: the team's deploy records read through withOrg() (as
// deploy_app, row-level security on: another org's records are not counted), the subject's active teams,
// and the team's deletion (the org marked deleted, its members, roles and pending invitations ended).
import { PGlite } from "@electric-sql/pglite";
import { manifest } from "@saas/db";
import { countSubjectTeams, deleteTeam, findTeam, teamDeployResources } from "@saas/db/membership";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { executor, migrationSql } from "./deploy-schema.js";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";
const ALICE = "usr_0000000000004000800000000000000a";
const NOW = new Date("2026-01-01T00:00:00Z");

let db: PGlite;
let ex: TransactionalSqlExecutor;
const admin = (sql: string, params: unknown[] = []) => db.query(sql, params);

beforeAll(async () => {
  db = new PGlite();
  for (const m of manifest.migrations.filter((x) => x.context === "identity" || x.context === "membership" || x.context === "deploy")) await db.exec(migrationSql(m.id));
  ex = executor(db);
  await admin(`INSERT INTO membership.organizations (id, name, slug, slug_lower) VALUES ($1, 'Acme', 'acme', 'acme'), ($2, 'Other', 'other', 'other')`, [ORG, OTHER]);
  await admin(
    `INSERT INTO membership.organization_members (id, org_id, subject_id) VALUES (gen_random_uuid(), $1, $3), (gen_random_uuid(), $2, $3), (gen_random_uuid(), $1, 'usr_bob')`,
    [ORG, OTHER, ALICE],
  );
  await admin(
    `INSERT INTO membership.role_assignments (id, org_id, subject_id, role) VALUES (gen_random_uuid(), $1, $3, 'owner'), (gen_random_uuid(), $2, $3, 'owner'), (gen_random_uuid(), $1, 'usr_bob', 'builder')`,
    [ORG, OTHER, ALICE],
  );
  await admin(
    `INSERT INTO membership.organization_invitations (id, org_id, email, email_lower, role, token_hash, invited_by, expires_at) VALUES (gen_random_uuid(), $1, 'new@example.com', 'new@example.com', 'builder', 'h1', $2, now() + interval '3 days')`,
    [ORG, ALICE],
  );
}, 120_000);
afterAll(async () => db?.close());

describe("the team's deploy records (withOrg, read only)", () => {
  test("an empty team owns nothing", async () => {
    expect(await teamDeployResources(ex, ORG)).toEqual({ blockers: {}, owned: {}, projects: [], servers: [] });
  });

  test("Coolify's blockers and what Coolify deletes with the team, only the team's own", async () => {
    await admin(`INSERT INTO deploy.projects (uuid, name, org_id) VALUES ('p1', 'Shop', $1), ('p2', 'Blog', $1), ('px', 'Theirs', $2)`, [ORG, OTHER]);
    await admin(`INSERT INTO deploy.private_keys (id, uuid, name, private_key, org_id) VALUES (900, 'k1', 'key', 'x', $1), (901, 'k2', 'theirs', 'x', $2)`, [ORG, OTHER]);
    await admin(`INSERT INTO deploy.servers (uuid, name, ip, private_key_id, proxy, org_id) VALUES ('s1', 'prod-1', '10.0.0.1', 900, '{}', $1)`, [ORG]);
    await admin(`INSERT INTO deploy.servers (uuid, name, ip, private_key_id, proxy, deleted_at, org_id) VALUES ('s0', 'gone', '10.0.0.2', 900, '{}', now(), $1)`, [ORG]);
    const base = "uuid, name, api_url, html_url, org_id";
    await admin(`INSERT INTO deploy.github_apps (${base}) VALUES ('gh1', 'app', 'https://api.github.com', 'https://github.com', $1)`, [ORG]);
    await admin(`INSERT INTO deploy.github_apps (${base}, is_system_wide) VALUES ('gh2', 'shared', 'https://api.github.com', 'https://github.com', $1, true)`, [ORG]);
    await admin(`INSERT INTO deploy.s3_storages (uuid, name, "key", secret, org_id) VALUES ('s3a', 'bucket', 'k', 's', $1)`, [ORG]);
    await admin(`INSERT INTO deploy.tags (uuid, name, org_id) VALUES ('t1', 'prod', $1)`, [ORG]);
    expect(await teamDeployResources(ex, ORG)).toEqual({
      // A soft-deleted server and an instance-wide source do not hold the team (Server's SoftDeletes, is_system_wide).
      blockers: { projects: 2, servers: 1, sources: 1 },
      owned: { privateKeys: 1, storages: 1, tags: 1 },
      projects: [
        { uuid: "p1", name: "Shop" },
        { uuid: "p2", name: "Blog" },
      ],
      servers: [{ uuid: "s1", name: "prod-1" }],
    });
    expect((await teamDeployResources(ex, OTHER)).blockers).toEqual({ projects: 1 });
  });
});

describe("the subject's teams and the team's deletion", () => {
  test("countSubjectTeams counts active memberships of active organizations", async () => {
    expect(await countSubjectTeams(ex, ALICE)).toBe(2);
    expect(await countSubjectTeams(ex, "usr_bob")).toBe(1);
    expect(await countSubjectTeams(ex, "usr_nobody")).toBe(0);
  });

  test("deleteTeam marks the org deleted and ends its members, roles and pending invitations; once", async () => {
    expect(await ex.transaction((tx) => deleteTeam(tx, ORG, NOW))).toBe(true);
    expect(await findTeam(ex, ORG)).toBeNull();
    const org = await admin(`SELECT status FROM membership.organizations WHERE id = $1`, [ORG]);
    expect(org.rows).toEqual([{ status: "deleted" }]);
    const members = await admin(`SELECT DISTINCT status FROM membership.organization_members WHERE org_id = $1`, [ORG]);
    expect(members.rows).toEqual([{ status: "removed" }]);
    const roles = await admin(`SELECT count(*)::int AS n FROM membership.role_assignments WHERE org_id = $1 AND revoked_at IS NULL`, [ORG]);
    expect(roles.rows).toEqual([{ n: 0 }]);
    const invitations = await admin(`SELECT status FROM membership.organization_invitations WHERE org_id = $1`, [ORG]);
    expect(invitations.rows).toEqual([{ status: "revoked" }]);
    // The other team is untouched; Alice has one team left, Bob none.
    expect(await countSubjectTeams(ex, ALICE)).toBe(1);
    expect(await countSubjectTeams(ex, "usr_bob")).toBe(0);
    expect(await ex.transaction((tx) => deleteTeam(tx, ORG, NOW))).toBe(false);
  });
});
