// deploy.shared_environment_variables (DP-50) against a real Postgres: the
// store functions of @saas/db/deploy inside withOrg(), the value column
// encrypted with the org's data key, the four scopes (590 lets `type` be
// 'server'), and row-level security keeping each org's variables to itself.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  loadKek,
  orgDek,
  encryptField,
  decryptField,
  isEncrypted,
  isEncryptedColumn,
  insertPrivateKey,
  insertProject,
  deleteProject,
  insertEnvironment,
  deleteEnvironment,
  insertServer,
  deleteServer,
  listSharedVariables,
  findSharedVariableById,
  findSharedVariableByKey,
  insertSharedVariable,
  updateSharedVariable,
  deleteSharedVariable,
  deleteSharedVariablesExcept,
  listSharedVariablesOverview,
  listSharedVariableProjects,
  listSharedVariableEnvironments,
  findSharedVariableEnvironment,
  listSharedVariableServers,
  SHARED_VARIABLE_SCOPES,
  type SharedVariableOwner,
} from "@saas/db/deploy";
import type { SqlExecutor, TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, deployDatabaseAfter, executor, migrationSql, TEST_KEK as KEK } from "./deploy-schema.js";

// The step this suite tests by itself: what came before 590, then 590. Everything else runs on the schema at head.
const BEFORE_590 = ["500_deploy_core", "510_deploy_org_keys", "520_deploy_schema_fold_fixes"];
const SERVER_SCOPE = migrationSql("590_deploy_shared_variables_server_scope");
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const COLUMN = "shared_environment_variables.value";
const TEAM: SharedVariableOwner = { type: "team", id: null };

let db: PGlite;
let ex: TransactionalSqlExecutor;
const owners: Record<string, SharedVariableOwner> = {};

async function encrypted(org: string, tx: SqlExecutor, value: string) {
  return encryptField(await orgDek(tx, org, await loadKek(KEK)), COLUMN, value);
}

function add(org: string, owner: SharedVariableOwner, key: string, value = "v", extra: { comment?: string | null; isMultiline?: boolean; isLiteral?: boolean } = {}, on: TransactionalSqlExecutor = ex) {
  return withOrg(on, org, async (tx) => insertSharedVariable(tx, { orgId: org, owner, key, value: await encrypted(org, tx, value), ...extra }));
}

const keysOf = (org: string, owner: SharedVariableOwner) => withOrg(ex, org, async (tx) => (await listSharedVariables(tx, owner)).map((v) => v.key));

beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);

  for (const [org, name] of [
    [A, "a"],
    [B, "b"],
  ] as const) {
    const { project, environment } = await withOrg(ex, org, (tx) => insertProject(tx, { orgId: org, uuid: `prj${name.repeat(21)}`, name: `Project ${name}`, description: null, productionEnvironmentUuid: `env${name.repeat(21)}` }));
    const key = await withOrg(ex, org, (tx) => insertPrivateKey(tx, { orgId: org, uuid: `key${name.repeat(21)}`, name: "key", description: null, privateKey: "fp1:fake", fingerprint: null }));
    const server = await withOrg(ex, org, (tx) =>
      insertServer(tx, { orgId: org, uuid: `srv${name.repeat(21)}`, name: `server-${name}`, description: null, ip: "203.0.113.10", user: "root", port: 22, privateKeyId: key.id, proxy: {}, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: `dst${name.repeat(21)}` }),
    );
    owners[`${name}.project`] = { type: "project", id: project.id };
    owners[`${name}.environment`] = { type: "environment", id: environment.id };
    owners[`${name}.server`] = { type: "server", id: server.id };
  }
}, 120_000);
afterAll(async () => db?.close());

describe("deploy.shared_environment_variables", () => {
  it("has Coolify's four scopes, and its value is one of Coolify's encrypted columns", () => {
    expect([...SHARED_VARIABLE_SCOPES]).toEqual(["team", "project", "environment", "server"]);
    expect(isEncryptedColumn("shared_environment_variables", "value")).toBe(true);
  });

  it("refuses a server-wide variable until 590 widens the type check, which still refuses an unknown type", async () => {
    const step = await deployDatabaseAfter(BEFORE_590);
    try {
      const old = executor(step);
      // The server's id is all the variable needs of it: deploy has no foreign keys.
      const server: SharedVariableOwner = { type: "server", id: 1 };
      let serverScopeBefore590 = true;
      try {
        await add(A, server, "TOO_EARLY", "v", {}, old);
      } catch {
        serverScopeBefore590 = false;
      }
      expect(serverScopeBefore590).toBe(false);
      await step.exec(SERVER_SCOPE);
      expect(await add(A, server, "ON_TIME", "v", {}, old)).toMatchObject({ key: "ON_TIME", type: "server" });
      await expect(
        withOrg(old, A, (tx) => tx.execute(`INSERT INTO deploy.shared_environment_variables (key, value, type, org_id) VALUES ('X', 'x', 'instance', $1)`, [A])),
      ).rejects.toThrow();
      // Applying it again changes nothing (the runner may retry a migration).
      await step.exec(SERVER_SCOPE);
    } finally {
      await step.close();
    }
    // And at head the unknown type is still refused.
    await expect(
      withOrg(ex, A, (tx) => tx.execute(`INSERT INTO deploy.shared_environment_variables (key, value, type, org_id) VALUES ('X', 'x', 'instance', $1)`, [A])),
    ).rejects.toThrow();
  }, 120_000);

  it("stores a variable for each scope: the type and the owner's column follow the owner, the value is a ciphertext", async () => {
    const team = await add(A, TEAM, "TEAM_KEY", "team-secret", { comment: "a note", isLiteral: true });
    expect(team).toMatchObject({ key: "TEAM_KEY", type: "team", project_id: null, environment_id: null, server_id: null, comment: "a note", is_literal: true, is_multiline: false, is_shown_once: false });
    expect(team.created_at).not.toBeNull();
    expect(team).not.toHaveProperty("value");

    const project = await add(A, owners["a.project"]!, "PROJECT_KEY", "p", { isMultiline: true });
    expect(project).toMatchObject({ type: "project", environment_id: null, server_id: null, is_multiline: true, is_literal: false, comment: null });
    expect(String(project.project_id)).toBe(String(owners["a.project"]!.id));
    const environment = await add(A, owners["a.environment"]!, "ENVIRONMENT_KEY");
    expect(environment).toMatchObject({ type: "environment", project_id: null, server_id: null });
    expect(String(environment.environment_id)).toBe(String(owners["a.environment"]!.id));
    const server = await add(A, owners["a.server"]!, "COOLIFY_SERVER_UUID", "srvaaaaaaaaaaaaaaaaaaaaa", { isLiteral: true });
    expect(server).toMatchObject({ type: "server", project_id: null, environment_id: null });
    expect(String(server.server_id)).toBe(String(owners["a.server"]!.id));

    const found = (await withOrg(ex, A, (tx) => findSharedVariableByKey(tx, TEAM, "TEAM_KEY")))!;
    expect(isEncrypted(found.value)).toBe(true);
    expect(found.value).not.toContain("team-secret");
    expect(await withOrg(ex, A, async (tx) => decryptField(await orgDek(tx, A, await loadKek(KEK)), COLUMN, found.value))).toBe("team-secret");
    // B's data key does not open A's value, and the value is bound to its column.
    await expect(withOrg(ex, B, async (tx) => decryptField(await orgDek(tx, B, await loadKek(KEK)), COLUMN, found.value))).rejects.toThrow();
    await expect(withOrg(ex, A, async (tx) => decryptField(await orgDek(tx, A, await loadKek(KEK)), "cloud_provider_tokens.token", found.value))).rejects.toThrow();
  });

  it("lists and finds a variable within its owner only, in the order the variables were created", async () => {
    await add(A, TEAM, "ALPHA");
    await add(A, owners["a.project"]!, "ALPHA");
    expect(await keysOf(A, TEAM)).toEqual(["TEAM_KEY", "ALPHA"]);
    expect(await keysOf(A, owners["a.project"]!)).toEqual(["PROJECT_KEY", "ALPHA"]);
    expect(await keysOf(A, owners["a.environment"]!)).toEqual(["ENVIRONMENT_KEY"]);
    expect(await keysOf(A, owners["a.server"]!)).toEqual(["COOLIFY_SERVER_UUID"]);

    const teamAlpha = (await withOrg(ex, A, (tx) => findSharedVariableByKey(tx, TEAM, "ALPHA")))!;
    const projectAlpha = (await withOrg(ex, A, (tx) => findSharedVariableByKey(tx, owners["a.project"]!, "ALPHA")))!;
    expect(teamAlpha.type).toBe("team");
    expect(projectAlpha.type).toBe("project");
    expect(String(teamAlpha.id)).not.toBe(String(projectAlpha.id));
    expect(await withOrg(ex, A, (tx) => findSharedVariableByKey(tx, owners["a.environment"]!, "ALPHA"))).toBeNull();
    expect((await withOrg(ex, A, (tx) => findSharedVariableById(tx, TEAM, teamAlpha.id)))!.key).toBe("ALPHA");
    // An id of another scope is not found through this one.
    expect(await withOrg(ex, A, (tx) => findSharedVariableById(tx, TEAM, projectAlpha.id))).toBeNull();
    expect(await withOrg(ex, A, (tx) => findSharedVariableById(tx, { type: "project", id: 999_999 }, projectAlpha.id))).toBeNull();
  });

  it("changes only what a save names, and a lock is permanent", async () => {
    const row = (await withOrg(ex, A, (tx) => findSharedVariableByKey(tx, TEAM, "ALPHA")))!;
    const renamed = (await withOrg(ex, A, (tx) => updateSharedVariable(tx, row.id, { key: "BETA", comment: "renamed" })))!;
    expect(renamed).toMatchObject({ key: "BETA", comment: "renamed", is_multiline: false, is_literal: false, is_shown_once: false });
    expect((await withOrg(ex, A, (tx) => findSharedVariableById(tx, TEAM, row.id)))!.value).toBe(row.value);

    const next = await withOrg(ex, A, (tx) => encrypted(A, tx, "next"));
    const changed = (await withOrg(ex, A, (tx) => updateSharedVariable(tx, row.id, { value: next, isMultiline: true, isLiteral: true, comment: null })))!;
    expect(changed).toMatchObject({ key: "BETA", comment: null, is_multiline: true, is_literal: true });
    expect((await withOrg(ex, A, (tx) => findSharedVariableById(tx, TEAM, row.id)))!.value).toBe(next);

    expect((await withOrg(ex, A, (tx) => updateSharedVariable(tx, row.id, { isShownOnce: true })))!.is_shown_once).toBe(true);
    // The saving hook: no save unlocks a variable.
    expect((await withOrg(ex, A, (tx) => updateSharedVariable(tx, row.id, { isShownOnce: false, key: "GAMMA" })))!).toMatchObject({ key: "GAMMA", is_shown_once: true });
    expect(await withOrg(ex, A, (tx) => updateSharedVariable(tx, 999_999, { key: "NOPE" }))).toBeNull();
  });

  it("deletes one variable, and every variable of an owner whose key a developer view no longer has", async () => {
    const project = owners["a.project"]!;
    await add(A, project, "KEEP");
    await add(A, project, "DROP_1");
    await add(A, project, "DROP_2");
    expect(await withOrg(ex, A, (tx) => deleteSharedVariablesExcept(tx, project, ["KEEP", "PROJECT_KEY", "NEW_ONE"]))).toBe(3);
    expect(await keysOf(A, project)).toEqual(["PROJECT_KEY", "KEEP"]);
    // The other scopes keep theirs.
    expect(await keysOf(A, TEAM)).toEqual(["TEAM_KEY", "GAMMA"]);

    const server = owners["a.server"]!;
    await add(A, server, "COOLIFY_SERVER_NAME", "server-a", { isLiteral: true });
    await add(A, server, "REGION", "eu");
    // A server's predefined variables stay when the text is empty.
    expect(await withOrg(ex, A, (tx) => deleteSharedVariablesExcept(tx, server, [], ["COOLIFY_SERVER_UUID", "COOLIFY_SERVER_NAME"]))).toBe(1);
    expect(await keysOf(A, server)).toEqual(["COOLIFY_SERVER_UUID", "COOLIFY_SERVER_NAME"]);

    const environment = owners["a.environment"]!;
    await add(A, environment, "SECOND");
    expect(await withOrg(ex, A, (tx) => deleteSharedVariablesExcept(tx, environment, []))).toBe(2);
    expect(await keysOf(A, environment)).toEqual([]);

    const keep = (await withOrg(ex, A, (tx) => findSharedVariableByKey(tx, project, "KEEP")))!;
    expect(await withOrg(ex, A, (tx) => deleteSharedVariable(tx, keep.id))).toBe(true);
    expect(await withOrg(ex, A, (tx) => deleteSharedVariable(tx, keep.id))).toBe(false);
    expect(await keysOf(A, project)).toEqual(["PROJECT_KEY"]);
  });

  it("keeps each org's variables to itself (row-level security)", async () => {
    await add(B, TEAM, "B_TEAM");
    await add(B, owners["b.project"]!, "B_PROJECT");
    expect(await keysOf(B, TEAM)).toEqual(["B_TEAM"]);
    expect(await keysOf(A, TEAM)).toEqual(["TEAM_KEY", "GAMMA"]);
    // A's project through B's session: nothing to list, find, change or delete.
    expect(await keysOf(B, owners["a.project"]!)).toEqual([]);
    const aRow = (await withOrg(ex, A, (tx) => findSharedVariableByKey(tx, TEAM, "TEAM_KEY")))!;
    expect(await withOrg(ex, B, (tx) => findSharedVariableById(tx, TEAM, aRow.id))).toBeNull();
    expect(await withOrg(ex, B, (tx) => updateSharedVariable(tx, aRow.id, { key: "STOLEN" }))).toBeNull();
    expect(await withOrg(ex, B, (tx) => deleteSharedVariable(tx, aRow.id))).toBe(false);
    expect(await withOrg(ex, B, (tx) => deleteSharedVariablesExcept(tx, TEAM, ["B_TEAM"]))).toBe(0);
    expect(await keysOf(A, TEAM)).toEqual(["TEAM_KEY", "GAMMA"]);
    await expect(withOrg(ex, B, (tx) => insertSharedVariable(tx, { orgId: A, owner: TEAM, key: "X", value: "x" }))).rejects.toThrow();
  });

  it("gives the overview every variable with its owner's names, and the index pages their owners", async () => {
    await add(A, owners["a.environment"]!, "ENV_ONLY");
    const overview = await withOrg(ex, A, (tx) => listSharedVariablesOverview(tx));
    expect(overview.map((v) => `${v.type}:${v.key}`)).toEqual(["team:TEAM_KEY", "project:PROJECT_KEY", "server:COOLIFY_SERVER_UUID", "team:GAMMA", "server:COOLIFY_SERVER_NAME", "environment:ENV_ONLY"]);
    expect(overview.every((v) => !("value" in v))).toBe(true);
    expect(overview.find((v) => v.key === "TEAM_KEY")).toMatchObject({ project_name: null, environment_name: null, server_name: null });
    expect(overview.find((v) => v.key === "PROJECT_KEY")).toMatchObject({ project_uuid: "prjaaaaaaaaaaaaaaaaaaaaa", project_name: "Project a", environment_name: null });
    expect(overview.find((v) => v.key === "ENV_ONLY")).toMatchObject({ environment_uuid: "envaaaaaaaaaaaaaaaaaaaaa", environment_name: "production", environment_project_uuid: "prjaaaaaaaaaaaaaaaaaaaaa", environment_project_name: "Project a", project_name: null });
    expect(overview.find((v) => v.key === "COOLIFY_SERVER_NAME")).toMatchObject({ server_uuid: "srvaaaaaaaaaaaaaaaaaaaaa", server_name: "server-a" });
    expect((await withOrg(ex, B, (tx) => listSharedVariablesOverview(tx))).map((v) => v.key)).toEqual(["B_TEAM", "B_PROJECT"]);

    await withOrg(ex, A, (tx) => insertProject(tx, { orgId: A, uuid: "prjzzzzzzzzzzzzzzzzzzzzz", name: "another", description: "second", productionEnvironmentUuid: "envzzzzzzzzzzzzzzzzzzzzz" }));
    expect(await withOrg(ex, A, (tx) => listSharedVariableProjects(tx))).toMatchObject([
      { uuid: "prjzzzzzzzzzzzzzzzzzzzzz", name: "another", description: "second", variable_count: 0 },
      { uuid: "prjaaaaaaaaaaaaaaaaaaaaa", name: "Project a", variable_count: 1 },
    ]);

    const project = (await withOrg(ex, A, (tx) => listSharedVariableProjects(tx))).find((p) => p.name === "Project a")!;
    await withOrg(ex, A, (tx) => insertEnvironment(tx, { orgId: A, projectId: project.id, uuid: "envstaging00000000000000", name: "staging", description: "pre-production" }));
    expect((await withOrg(ex, A, (tx) => listSharedVariableEnvironments(tx))).map((e) => `${e.project_name}/${e.name}`)).toEqual(["another/production", "Project a/production", "Project a/staging"]);
    expect(await withOrg(ex, A, (tx) => findSharedVariableEnvironment(tx, "envstaging00000000000000"))).toMatchObject({
      name: "staging",
      description: "pre-production",
      project_uuid: "prjaaaaaaaaaaaaaaaaaaaaa",
      project_name: "Project a",
      project_description: null,
    });
    expect(await withOrg(ex, B, (tx) => findSharedVariableEnvironment(tx, "envstaging00000000000000"))).toBeNull();

    expect(await withOrg(ex, A, (tx) => listSharedVariableServers(tx))).toMatchObject([{ uuid: "srvaaaaaaaaaaaaaaaaaaaaa", name: "server-a", description: null, ip: "203.0.113.10", is_reachable: false, is_usable: false, force_disabled: false }]);
    expect((await withOrg(ex, B, (tx) => listSharedVariableServers(tx))).map((s) => s.name)).toEqual(["server-b"]);
  });

  it("removes an owner's variables with the owner, as Coolify's foreign keys do", async () => {
    const serverOwner = owners["a.server"]!;
    expect(await keysOf(A, serverOwner)).toEqual(["COOLIFY_SERVER_UUID", "COOLIFY_SERVER_NAME"]);
    expect(await withOrg(ex, A, (tx) => deleteServer(tx, serverOwner.id!))).toBe(true);
    expect(await keysOf(A, serverOwner)).toEqual([]);

    const environmentOwner = owners["a.environment"]!;
    expect(await keysOf(A, environmentOwner)).toEqual(["ENV_ONLY"]);
    expect(await withOrg(ex, A, (tx) => deleteEnvironment(tx, environmentOwner.id!))).toBe(true);
    expect(await keysOf(A, environmentOwner)).toEqual([]);

    const projectOwner = owners["a.project"]!;
    expect(await keysOf(A, projectOwner)).toEqual(["PROJECT_KEY"]);
    expect(await withOrg(ex, A, (tx) => deleteProject(tx, projectOwner.id!))).toBe(true);
    expect(await keysOf(A, projectOwner)).toEqual([]);
    // The org's own variables and the other org's stay.
    expect(await keysOf(A, TEAM)).toEqual(["TEAM_KEY", "GAMMA"]);
    expect(await keysOf(B, owners["b.project"]!)).toEqual(["B_PROJECT"]);
  });
});
