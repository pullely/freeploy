// Account deletion's "the team still holds resources" check (DP-25, Team::isEmpty()):
// identity's orgResourceCount counts an org's projects, servers and Git sources.
//
// Every deploy table FORCES row-level security, so a plain query only sees rows
// when the connection's role bypasses RLS (a superuser, or a role with
// BYPASSRLS). PGlite runs as a superuser, which would hide the problem; these
// tests also run the count from a session that is itself subject to RLS
// (SET ROLE deploy_app with no org set), the case where the old plain query
// counted nothing and let an account be deleted while its team owned servers.
import type { PGlite } from "@electric-sql/pglite";
import { createAccountStore } from "@saas/db/identity";
import { withOrg } from "@saas/db/deploy";
import { deployDatabase, executor } from "./deploy-schema.js";

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";

/** One project and one server for org A; nothing for org B. */
async function seed(db: PGlite): Promise<void> {
  await withOrg(executor(db), A, async (tx) => {
    await tx.execute(`INSERT INTO deploy.projects (uuid, name, org_id) VALUES ('prjaaaaaaaaaaaaaaaaaaaaa', 'Shop', $1)`, [A]);
    await tx.execute(`INSERT INTO deploy.servers (uuid, name, ip, private_key_id, proxy, org_id) VALUES ('srvaaaaaaaaaaaaaaaaaaaaa', 'prod-1', '203.0.113.10', 1, '{}', $1)`, [A]);
  });
}

/** The old count: a plain query, relying on the connection's role to see the rows. */
async function plainCount(db: PGlite, orgId: string): Promise<number> {
  const r = await db.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM deploy.projects WHERE org_id = $1)
          + (SELECT count(*) FROM deploy.servers WHERE org_id = $1)
          + (SELECT count(*) FROM deploy.github_apps WHERE org_id = $1)
          + (SELECT count(*) FROM deploy.gitlab_apps WHERE org_id = $1) AS n`,
    [orgId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

describe("identity orgResourceCount (account deletion's team check)", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await deployDatabase();
    await seed(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("counts the org's projects and servers, and nothing of another org", async () => {
    const store = createAccountStore(executor(db));
    expect(await store.orgResourceCount(A)).toBe(2);
    expect(await store.orgResourceCount(B)).toBe(0);
  });

  it("counts them when the connection is subject to row-level security, where a plain query sees none", async () => {
    await db.exec("SET ROLE deploy_app");
    // What account deletion did before: with RLS applying and no org set, every row is hidden.
    expect(await plainCount(db, A)).toBe(0);
    // Inside withOrg the org is set, so the rows are seen whatever role the worker connects as.
    expect(await createAccountStore(executor(db)).orgResourceCount(A)).toBe(2);
    expect(await createAccountStore(executor(db)).orgResourceCount(B)).toBe(0);
  });

  it("counts Git sources too", async () => {
    await withOrg(executor(db), B, async (tx) => {
      const cols = await tx.execute<{ column_name: string; is_nullable: string; column_default: string | null }>(
        `SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'deploy' AND table_name = 'github_apps'`,
      );
      const required = cols.rows.filter((c) => c.is_nullable === "NO" && c.column_default === null && c.column_name !== "id").map((c) => c.column_name);
      const value = (c: string) => (c === "org_id" ? B : c === "uuid" ? "ghaaaaaaaaaaaaaaaaaaaaaa" : c.endsWith("_id") ? 1 : c.startsWith("is_") ? false : "x");
      await tx.execute(
        `INSERT INTO deploy.github_apps (${required.join(", ")}) VALUES (${required.map((_, i) => `$${i + 1}`).join(", ")})`,
        required.map(value),
      );
    });
    expect(await createAccountStore(executor(db)).orgResourceCount(B)).toBe(1);
  });
});
