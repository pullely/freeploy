// withOrg() (@saas/db/deploy) against a real Postgres: the transaction runs
// as deploy_app with deploy.org_id set, so even an unfiltered query is
// confined to the org (DP2).
import type { PGlite } from "@electric-sql/pglite";
import { withOrg, asPlatformAdmin, listProjects, TenancyError } from "@saas/db/deploy";
import { deployDatabase, executor } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

let db: PGlite;
beforeAll(async () => {
  db = await deployDatabase();
  // seed as the migration owner, bypassing nothing: insert through withOrg like the worker would
}, 120_000);
afterAll(async () => db?.close());

describe("withOrg", () => {
  it("confines an unfiltered read to the org", async () => {
    const ex = executor(db);
    await withOrg(ex, A, (tx) => tx.execute("INSERT INTO deploy.projects (uuid, name, org_id) VALUES ('pa', 'alpha', $1)", [A]));
    await withOrg(ex, B, (tx) => tx.execute("INSERT INTO deploy.projects (uuid, name, org_id) VALUES ('pb', 'beta', $1)", [B]));
    expect((await withOrg(ex, A, listProjects)).map((p) => p.name)).toEqual(["alpha"]);
    expect((await withOrg(ex, B, listProjects)).map((p) => p.name)).toEqual(["beta"]);
    expect((await asPlatformAdmin(ex, listProjects)).map((p) => p.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("refuses a write for another org inside its transaction", async () => {
    const ex = executor(db);
    await expect(withOrg(ex, A, (tx) => tx.execute("INSERT INTO deploy.projects (uuid, name, org_id) VALUES ('px', 'x', $1)", [B]))).rejects.toThrow(/row-level security/);
  });

  it("does not leak the org setting past its transaction", async () => {
    const ex = executor(db);
    await withOrg(ex, A, listProjects);
    const after = await db.query<{ v: string | null }>("SELECT current_setting('deploy.org_id', true) AS v");
    expect(after.rows[0]?.v ?? "").toBe("");
  });

  it("rejects a non-uuid org", async () => {
    await expect(withOrg(executor(db), "org_abc", listProjects)).rejects.toBeInstanceOf(TenancyError);
  });
});
