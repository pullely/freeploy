// deploy.projects, deploy.environments and deploy.project_settings (DP-46)
// against a real Postgres: the store functions of @saas/db/deploy inside
// withOrg(), Coolify's created and deleting hooks, the "has resources" guards,
// and row-level security keeping each org's projects to itself.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  listProjects,
  listProjectsWithCounts,
  findProjectByUuid,
  insertProject,
  updateProject,
  deleteProject,
  projectHasResources,
  listEnvironments,
  findEnvironmentByUuid,
  insertEnvironment,
  updateEnvironment,
  deleteEnvironment,
  environmentNameExists,
  environmentHasResources,
  ENVIRONMENT_RESOURCE_TABLES,
} from "@saas/db/deploy";
import type { SqlExecutor, TransactionalSqlExecutor } from "@saas/db/hyperdrive";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SQL = ["500_deploy_core", "510_deploy_org_keys", "520_deploy_schema_fold_fixes"].map((m) => readFileSync(resolve(root, `packages/db/src/migrations/${m}/up.sql`), "utf8")).join("\n");
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

function executor(db: PGlite): TransactionalSqlExecutor {
  const wrap = (q: { query: PGlite["query"] }): SqlExecutor => ({
    async execute(text, params) {
      const r = await q.query(text, params ?? []);
      return { rows: r.rows as never[], rowCount: r.rows.length };
    },
  });
  return { ...wrap(db), transaction: (fn) => db.transaction((tx) => fn(wrap(tx as never))) };
}

let db: PGlite;
let ex: TransactionalSqlExecutor;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(SQL);
  ex = executor(db);
}, 120_000);
afterAll(async () => db?.close());

const add = (org: string, uuid: string, name: string, description: string | null = null) =>
  withOrg(ex, org, (tx) => insertProject(tx, { orgId: org, uuid, name, description, productionEnvironmentUuid: `${uuid}-production` }));
const count = async (sql: string, params: unknown[] = []) => Number((await asPlatformAdmin(ex, (tx) => tx.execute<{ n: number }>(sql, params))).rows[0]!.n);

/** A resource row with only what its table requires. */
async function addResource(org: string, table: string, uuid: string, environmentId: string | number, deletedAt: string | null = null) {
  await withOrg(ex, org, async (tx) => {
    if (table === "applications") {
      await tx.execute(
        `INSERT INTO deploy.applications (uuid, name, git_repository, git_branch, build_pack, environment_id, deleted_at, org_id) VALUES ($1, 'web', 'r', 'main', 'nixpacks', $2, $3, $4)`,
        [uuid, environmentId, deletedAt, org],
      );
    } else if (table === "services") {
      await tx.execute(`INSERT INTO deploy.services (uuid, name, environment_id, docker_compose_raw, deleted_at, org_id) VALUES ($1, 'svc', $2, 'services: {}', $3, $4)`, [
        uuid,
        environmentId,
        deletedAt,
        org,
      ]);
    } else {
      // The standalone tables' own required columns (passwords, the SQLite image).
      const required: Record<string, string[]> = {
        standalone_postgresqls: ["postgres_password"],
        standalone_keydbs: ["keydb_password"],
        standalone_dragonflies: ["dragonfly_password"],
        standalone_clickhouses: ["clickhouse_admin_password"],
        standalone_mongodbs: ["mongo_initdb_root_password"],
        standalone_mysqls: ["mysql_root_password", "mysql_password"],
        standalone_mariadbs: ["mariadb_root_password", "mariadb_password"],
        standalone_sqlites: ["image"],
      };
      const cols = (required[table] ?? []).map((c) => `${c}, `).join("");
      const vals = (required[table] ?? []).map(() => "'x', ").join("");
      await tx.execute(
        `INSERT INTO deploy.${table} (uuid, name, ${cols}destination_id, destination_type, environment_id, deleted_at, org_id) VALUES ($1, 'db', ${vals}1, 'App\\Models\\StandaloneDocker', $2, $3, $4)`,
        [uuid, environmentId, deletedAt, org],
      );
    }
  });
}

describe("deploy.projects", () => {
  it("creates a project with its settings row and a production environment, every row in the org (the created hook)", async () => {
    const { project, environment } = await add(A, "prjaaaaaaaaaaaaaaaaaaaaa", "alpha", "first");
    expect(project).toMatchObject({ uuid: "prjaaaaaaaaaaaaaaaaaaaaa", name: "alpha", description: "first" });
    expect(project.created_at).not.toBeNull();
    expect(environment).toMatchObject({ uuid: "prjaaaaaaaaaaaaaaaaaaaaa-production", name: "production", description: null, project_id: project.id });
    expect(await count("SELECT count(*)::int AS n FROM deploy.project_settings WHERE project_id = $1 AND org_id = $2", [project.id, A])).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM deploy.environments WHERE project_id = $1 AND org_id = $2", [project.id, A])).toBe(1);
  });

  it("lists the org's projects by lower(name) with their environment and resource counts", async () => {
    await add(A, "prjazzzzzzzzzzzzzzzzzzzz", "Zeta");
    await add(A, "prjabbbbbbbbbbbbbbbbbbbb", "beta");
    await add(B, "prjbbbbbbbbbbbbbbbbbbbbb", "other org");
    const rows = await withOrg(ex, A, listProjectsWithCounts);
    expect(rows.map((p) => [p.name, p.environment_count, p.resource_count, p.first_environment_uuid])).toEqual([
      ["alpha", 1, 0, "prjaaaaaaaaaaaaaaaaaaaaa-production"],
      ["beta", 1, 0, "prjabbbbbbbbbbbbbbbbbbbb-production"],
      ["Zeta", 1, 0, "prjazzzzzzzzzzzzzzzzzzzz-production"],
    ]);
    // ProjectController@projects keeps its order (by id).
    expect((await withOrg(ex, A, listProjects)).map((p) => p.name)).toEqual(["alpha", "Zeta", "beta"]);
  });

  it("keeps each org's projects and environments to itself (row-level security)", async () => {
    expect((await withOrg(ex, B, listProjectsWithCounts)).map((p) => p.name)).toEqual(["other org"]);
    expect(await withOrg(ex, B, (tx) => findProjectByUuid(tx, "prjaaaaaaaaaaaaaaaaaaaaa"))).toBeNull();
    const a = (await withOrg(ex, A, (tx) => findProjectByUuid(tx, "prjaaaaaaaaaaaaaaaaaaaaa")))!;
    expect(await withOrg(ex, B, (tx) => listEnvironments(tx, a.id))).toEqual([]);
    expect(await withOrg(ex, B, (tx) => findEnvironmentByUuid(tx, a.id, "prjaaaaaaaaaaaaaaaaaaaaa-production"))).toBeNull();
    expect(await withOrg(ex, B, (tx) => updateProject(tx, a.id, { name: "stolen", description: null }))).toBeNull();
    expect(await withOrg(ex, B, (tx) => deleteProject(tx, a.id))).toBe(false);
    expect(await withOrg(ex, B, (tx) => environmentNameExists(tx, a.id, "production"))).toBe(false);
    await expect(add(B, "prjxxxxxxxxxxxxxxxxxxxxx", "x").then(() => withOrg(ex, B, (tx) => insertEnvironment(tx, { orgId: A, projectId: a.id, uuid: "envxxxxxxxxxxxxxxxxxxxxx", name: "x" })))).rejects.toThrow(
      /row-level security/,
    );
    await expect(withOrg(ex, B, (tx) => insertProject(tx, { orgId: A, uuid: "prjyyyyyyyyyyyyyyyyyyyyy", name: "y", description: null, productionEnvironmentUuid: "envyyyyyyyyyyyyyyyyyyyyy" }))).rejects.toThrow(
      /row-level security/,
    );
    // Nothing of A changed.
    expect((await withOrg(ex, A, (tx) => findProjectByUuid(tx, "prjaaaaaaaaaaaaaaaaaaaaa")))!.name).toBe("alpha");
    expect(await withOrg(ex, A, (tx) => listEnvironments(tx, a.id))).toHaveLength(1);
  });

  it("updates a project's name and description", async () => {
    const a = (await withOrg(ex, A, (tx) => findProjectByUuid(tx, "prjaaaaaaaaaaaaaaaaaaaaa")))!;
    expect(await withOrg(ex, A, (tx) => updateProject(tx, a.id, { name: "alpha 2", description: null }))).toMatchObject({ uuid: a.uuid, name: "alpha 2", description: null });
    expect(await withOrg(ex, A, (tx) => updateProject(tx, a.id, { name: "alpha", description: "first" }))).toMatchObject({ name: "alpha", description: "first" });
  });
});

describe("deploy.environments", () => {
  it("adds, finds, renames and lists a project's environments in creation order", async () => {
    const a = (await withOrg(ex, A, (tx) => findProjectByUuid(tx, "prjaaaaaaaaaaaaaaaaaaaaa")))!;
    const staging = await withOrg(ex, A, (tx) => insertEnvironment(tx, { orgId: A, projectId: a.id, uuid: "envastagingaaaaaaaaaaaaa", name: "staging" }));
    expect(staging).toMatchObject({ name: "staging", description: null, project_id: a.id });
    expect((await withOrg(ex, A, (tx) => listEnvironments(tx, a.id))).map((e) => [e.name, e.resource_count])).toEqual([
      ["production", 0],
      ["staging", 0],
    ]);
    expect(await withOrg(ex, A, (tx) => findEnvironmentByUuid(tx, a.id, "envastagingaaaaaaaaaaaaa"))).toMatchObject({ name: "staging", resource_count: 0 });
    // An environment is found only through its own project.
    const beta = (await withOrg(ex, A, (tx) => findProjectByUuid(tx, "prjabbbbbbbbbbbbbbbbbbbb")))!;
    expect(await withOrg(ex, A, (tx) => findEnvironmentByUuid(tx, beta.id, "envastagingaaaaaaaaaaaaa"))).toBeNull();
    expect(await withOrg(ex, A, (tx) => updateEnvironment(tx, staging.id, { name: "preview", description: "pr builds" }))).toMatchObject({ name: "preview", description: "pr builds" });
    expect((await withOrg(ex, A, listProjectsWithCounts)).find((p) => p.uuid === a.uuid)).toMatchObject({ environment_count: 2, first_environment_uuid: "prjaaaaaaaaaaaaaaaaaaaaa-production" });
  });

  it("knows a name taken in the project (Coolify's unique name per project), not in another project", async () => {
    const a = (await withOrg(ex, A, (tx) => findProjectByUuid(tx, "prjaaaaaaaaaaaaaaaaaaaaa")))!;
    const preview = (await withOrg(ex, A, (tx) => findEnvironmentByUuid(tx, a.id, "envastagingaaaaaaaaaaaaa")))!;
    expect(await withOrg(ex, A, (tx) => environmentNameExists(tx, a.id, "preview"))).toBe(true);
    expect(await withOrg(ex, A, (tx) => environmentNameExists(tx, a.id, "preview", preview.id))).toBe(false);
    expect(await withOrg(ex, A, (tx) => environmentNameExists(tx, a.id, "production", preview.id))).toBe(true);
    expect(await withOrg(ex, A, (tx) => environmentNameExists(tx, a.id, "staging"))).toBe(false);
    const beta = (await withOrg(ex, A, (tx) => findProjectByUuid(tx, "prjabbbbbbbbbbbbbbbbbbbb")))!;
    expect(await withOrg(ex, A, (tx) => environmentNameExists(tx, beta.id, "preview"))).toBe(false);
  });

  it("counts a resource of every kind, and not a soft-deleted one (isEmpty)", async () => {
    const a = (await withOrg(ex, A, (tx) => findProjectByUuid(tx, "prjaaaaaaaaaaaaaaaaaaaaa")))!;
    const production = (await withOrg(ex, A, (tx) => findEnvironmentByUuid(tx, a.id, "prjaaaaaaaaaaaaaaaaaaaaa-production")))!;
    const preview = (await withOrg(ex, A, (tx) => findEnvironmentByUuid(tx, a.id, "envastagingaaaaaaaaaaaaa")))!;
    expect(await withOrg(ex, A, (tx) => environmentHasResources(tx, production.id))).toBe(false);
    expect(await withOrg(ex, A, (tx) => projectHasResources(tx, a.id))).toBe(false);
    // A soft-deleted application does not count.
    await addResource(A, "applications", "appdeleted", production.id, "2026-01-01 00:00:00");
    expect(await withOrg(ex, A, (tx) => environmentHasResources(tx, production.id))).toBe(false);
    expect(await withOrg(ex, A, (tx) => projectHasResources(tx, a.id))).toBe(false);
    for (const table of ENVIRONMENT_RESOURCE_TABLES) {
      const uuid = `res-${table}`;
      await addResource(A, table, uuid, production.id);
      expect(await withOrg(ex, A, (tx) => environmentHasResources(tx, production.id))).toBe(true);
      expect(await withOrg(ex, A, (tx) => projectHasResources(tx, a.id))).toBe(true);
      expect((await withOrg(ex, A, (tx) => findEnvironmentByUuid(tx, a.id, production.uuid)))!.resource_count).toBe(1);
      expect((await withOrg(ex, A, listProjectsWithCounts)).find((p) => p.uuid === a.uuid)!.resource_count).toBe(1);
      // The other environment, the other project and the other org stay empty.
      expect(await withOrg(ex, A, (tx) => environmentHasResources(tx, preview.id))).toBe(false);
      expect(await withOrg(ex, B, (tx) => environmentHasResources(tx, production.id))).toBe(false);
      expect(await withOrg(ex, B, (tx) => projectHasResources(tx, a.id))).toBe(false);
      await asPlatformAdmin(ex, (tx) => tx.execute(`DELETE FROM deploy.${table} WHERE uuid = $1`, [uuid]));
    }
    expect(ENVIRONMENT_RESOURCE_TABLES).toHaveLength(11);
    expect(await withOrg(ex, A, (tx) => projectHasResources(tx, a.id))).toBe(false);
  });

  it("deletes an environment with its shared variables (the deleting hook)", async () => {
    const a = (await withOrg(ex, A, (tx) => findProjectByUuid(tx, "prjaaaaaaaaaaaaaaaaaaaaa")))!;
    const preview = (await withOrg(ex, A, (tx) => findEnvironmentByUuid(tx, a.id, "envastagingaaaaaaaaaaaaa")))!;
    await withOrg(ex, A, async (tx) => {
      await tx.execute(`INSERT INTO deploy.shared_environment_variables (key, value, type, environment_id, org_id) VALUES ('E', 'v', 'environment', $1, $2)`, [preview.id, A]);
      await tx.execute(`INSERT INTO deploy.shared_environment_variables (key, value, type, project_id, org_id) VALUES ('P', 'v', 'project', $1, $2)`, [a.id, A]);
      await tx.execute(`INSERT INTO deploy.shared_environment_variables (key, value, type, org_id) VALUES ('T', 'v', 'team', $1)`, [A]);
    });
    expect(await withOrg(ex, A, (tx) => deleteEnvironment(tx, preview.id))).toBe(true);
    expect(await withOrg(ex, A, (tx) => deleteEnvironment(tx, preview.id))).toBe(false);
    expect((await withOrg(ex, A, (tx) => listEnvironments(tx, a.id))).map((e) => e.name)).toEqual(["production"]);
    expect(await count("SELECT count(*)::int AS n FROM deploy.shared_environment_variables WHERE org_id = $1", [A])).toBe(2);
  });

  it("deletes a project with its environments, settings and shared variables (the deleting hook)", async () => {
    const a = (await withOrg(ex, A, (tx) => findProjectByUuid(tx, "prjaaaaaaaaaaaaaaaaaaaaa")))!;
    const production = (await withOrg(ex, A, (tx) => findEnvironmentByUuid(tx, a.id, "prjaaaaaaaaaaaaaaaaaaaaa-production")))!;
    await withOrg(ex, A, (tx) =>
      tx.execute(`INSERT INTO deploy.shared_environment_variables (key, value, type, environment_id, org_id) VALUES ('E2', 'v', 'environment', $1, $2)`, [production.id, A]),
    );
    expect(await withOrg(ex, A, (tx) => deleteProject(tx, a.id))).toBe(true);
    expect(await withOrg(ex, A, (tx) => findProjectByUuid(tx, "prjaaaaaaaaaaaaaaaaaaaaa"))).toBeNull();
    expect(await count("SELECT count(*)::int AS n FROM deploy.environments WHERE project_id = $1", [a.id])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM deploy.project_settings WHERE project_id = $1", [a.id])).toBe(0);
    // Only the team variable is left; the other projects keep their rows.
    expect(await count("SELECT count(*)::int AS n FROM deploy.shared_environment_variables WHERE org_id = $1", [A])).toBe(1);
    expect((await withOrg(ex, A, listProjectsWithCounts)).map((p) => [p.name, p.environment_count])).toEqual([
      ["beta", 1],
      ["Zeta", 1],
    ]);
    expect(await count("SELECT count(*)::int AS n FROM deploy.project_settings WHERE org_id = $1", [A])).toBe(2);
  });
});
