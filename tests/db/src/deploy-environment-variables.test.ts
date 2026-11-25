// deploy.environment_variables (DP-51) against a real Postgres: the store
// functions of @saas/db/deploy inside withOrg() — the resource a variable
// belongs to with its settings and scopes, a variable's row column by column
// (Coolify's polymorphic resourceable_type / resourceable_id), the orders the
// list comes in, the refused second row of a key, updates, deletes, the
// lookups of shared variables that {{scope.KEY}} references need — and
// row-level security keeping each org's variables to itself.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  insertPrivateKey,
  insertServer,
  insertProject,
  listServerDestinations,
  insertDockerImageApplication,
  findEnvironmentVariableResource,
  updateEnvironmentVariableSettings,
  listEnvironmentVariables,
  findEnvironmentVariableByUuid,
  findEnvironmentVariablesByKey,
  maxEnvironmentVariableOrder,
  insertEnvironmentVariable,
  updateEnvironmentVariable,
  deleteEnvironmentVariables,
  findSharedVariableForReference,
  listSharedVariableKeys,
  APPLICATION_WEBHOOK_SECRET_COLUMNS,
  ENVIRONMENT_VARIABLE_MORPH_CLASS,
  type NewDockerImageApplication,
  type NewEnvironmentVariable,
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

interface Fixture {
  serverId: string | number;
  projectId: string | number;
  environmentId: string | number;
  applicationId: string | number;
}
const fx: Record<string, Fixture> = {};

async function fixture(org: string, tag: string): Promise<Fixture> {
  return withOrg(ex, org, async (tx) => {
    const key = await insertPrivateKey(tx, { orgId: org, uuid: `key${tag}`, name: "key", description: null, privateKey: "fp1:fake", fingerprint: null });
    const server = await insertServer(tx, {
      orgId: org, uuid: `srv${tag}`, name: `server-${tag}`, description: null, ip: "203.0.113.10", user: "root", port: 22, privateKeyId: key.id,
      proxy: {}, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: `dst${tag}`,
    });
    const destination = (await listServerDestinations(tx, server.id))[0]!;
    const { project, environment } = await insertProject(tx, { orgId: org, uuid: `prj${tag}`, name: `project-${tag}`, description: null, productionEnvironmentUuid: `env${tag}` });
    const application = await insertDockerImageApplication(tx, {
      orgId: org, uuid: `app${tag}`, name: `docker-image-app${tag}`, fqdn: null, domainPortOverrides: null, dockerRegistryImageName: "nginx", dockerRegistryImageTag: "latest",
      environmentId: environment.id, destinationId: destination.id, destinationType: "standalone",
      webhookSecrets: Object.fromEntries(APPLICATION_WEBHOOK_SECRET_COLUMNS.map((c) => [c, "fp1:fake"])) as NewDockerImageApplication["webhookSecrets"],
    });
    return { serverId: server.id, projectId: project.id, environmentId: environment.id, applicationId: application.id };
  });
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SQL);
  ex = executor(db);
  fx.a = await fixture(A, "a");
  fx.b = await fixture(B, "b");
}, 120_000);
afterAll(async () => db?.close());

const variable = (org: string, uuid: string, key: string, over: Partial<NewEnvironmentVariable> = {}): NewEnvironmentVariable => ({
  orgId: org, uuid, key, value: `fp1:${key}`, comment: null, order: null, isPreview: false, isMultiline: false, isLiteral: false, isRuntime: true, isBuildtime: true,
  isRequired: false, isShownOnce: false, isShared: false, version: "4.7.6", ...over,
});

const raw = async (where: string, params: unknown[]) =>
  (await asPlatformAdmin(ex, (tx) => tx.execute<Record<string, unknown>>(`SELECT * FROM deploy.environment_variables WHERE ${where}`, params))).rows;

const keys = async (org: string, isPreview: boolean, orderBy: "order" | "key" = "order") =>
  (await withOrg(ex, org, (tx) => listEnvironmentVariables(tx, "application", fx[org === A ? "a" : "b"]!.applicationId, isPreview, orderBy))).map((r) => r.key);

describe("the resource of an Environment Variables page", () => {
  it("finds an application with its settings and the ids of its shared variable scopes", async () => {
    expect(await withOrg(ex, A, (tx) => findEnvironmentVariableResource(tx, "application", "appa"))).toEqual({
      id: fx.a!.applicationId,
      uuid: "appa",
      name: "docker-image-appa",
      build_pack: "dockerimage",
      // DockerImage::submit()'s placeholder repository: Coolify shows previews because of it.
      git_repository: "coollabsio/coolify",
      dockerfile: null,
      docker_compose: null,
      environment_id: fx.a!.environmentId,
      environment_uuid: "enva",
      project_id: fx.a!.projectId,
      project_uuid: "prja",
      server_id: fx.a!.serverId,
      server_uuid: "srva",
      // The schema's defaults.
      is_env_sorting_enabled: false,
      use_build_secrets: false,
      include_coolify_default_variables: true,
      redact_all_env_values_in_logs: true,
    });
    expect(await withOrg(ex, A, (tx) => findEnvironmentVariableResource(tx, "application", "missing"))).toBeNull();
  });

  it("saves only the given switches in the application's settings", async () => {
    expect(await withOrg(ex, A, (tx) => updateEnvironmentVariableSettings(tx, "application", fx.a!.applicationId, { is_env_sorting_enabled: true, redact_all_env_values_in_logs: false }))).toBe(true);
    expect(await withOrg(ex, A, (tx) => findEnvironmentVariableResource(tx, "application", "appa"))).toMatchObject({
      is_env_sorting_enabled: true, use_build_secrets: false, include_coolify_default_variables: true, redact_all_env_values_in_logs: false,
    });
    await withOrg(ex, A, (tx) => updateEnvironmentVariableSettings(tx, "application", fx.a!.applicationId, { is_env_sorting_enabled: false, redact_all_env_values_in_logs: true }));
    // No settings row: nothing to save.
    expect(await withOrg(ex, A, (tx) => updateEnvironmentVariableSettings(tx, "application", 999999, { use_build_secrets: true }))).toBe(false);
  });

  it("a soft-deleted application is gone, and one whose server is gone has no server scope", async () => {
    await withOrg(ex, A, (tx) => tx.execute(`UPDATE deploy.servers SET deleted_at = now() WHERE id = $1`, [fx.a!.serverId]));
    expect(await withOrg(ex, A, (tx) => findEnvironmentVariableResource(tx, "application", "appa"))).toMatchObject({ server_id: null, server_uuid: null });
    await withOrg(ex, A, (tx) => tx.execute(`UPDATE deploy.servers SET deleted_at = NULL WHERE id = $1`, [fx.a!.serverId]));
    await withOrg(ex, A, (tx) => tx.execute(`UPDATE deploy.applications SET deleted_at = now() WHERE uuid = 'appa'`));
    expect(await withOrg(ex, A, (tx) => findEnvironmentVariableResource(tx, "application", "appa"))).toBeNull();
    await withOrg(ex, A, (tx) => tx.execute(`UPDATE deploy.applications SET deleted_at = NULL WHERE uuid = 'appa'`));
  });
});

describe("deploy.environment_variables", () => {
  it("stores a variable as Coolify's model does, column by column, under the application's morph class", async () => {
    const row = await withOrg(ex, A, (tx) =>
      insertEnvironmentVariable(tx, "application", fx.a!.applicationId, variable(A, "var1aaaaaaaaaaaaaaaaaaaa", "NODE_ENV", { comment: "the mode", order: 1, isLiteral: true, isBuildtime: false })),
    );
    expect(row).toMatchObject({
      uuid: "var1aaaaaaaaaaaaaaaaaaaa", key: "NODE_ENV", value: "fp1:NODE_ENV", comment: "the mode", order: 1, is_preview: false, is_multiline: false, is_literal: true,
      is_runtime: true, is_buildtime: false, is_required: false, is_shown_once: false, is_shared: false, version: "4.7.6",
    });
    expect(ENVIRONMENT_VARIABLE_MORPH_CLASS.application).toBe("App\\Models\\Application");
    const [stored] = await raw("uuid = $1", ["var1aaaaaaaaaaaaaaaaaaaa"]);
    expect(stored).toMatchObject({
      resourceable_type: "App\\Models\\Application",
      resourceable_id: Number(fx.a!.applicationId),
      org_id: A,
      // Columns Freeploy does not write keep the schema's defaults.
      uses_legacy_escaping: false,
      preserve_compose_null: false,
    });
    expect(stored!.created_at).toEqual(stored!.updated_at);
    expect(stored!.created_at).not.toBeNull();
  });

  it("refuses a second row of a key for the same resource and preview flag (performInsert), not for the other flag", async () => {
    expect(await withOrg(ex, A, (tx) => insertEnvironmentVariable(tx, "application", fx.a!.applicationId, variable(A, "var2aaaaaaaaaaaaaaaaaaaa", "NODE_ENV")))).toBeNull();
    expect(await raw("uuid = $1", ["var2aaaaaaaaaaaaaaaaaaaa"])).toEqual([]);
    const preview = await withOrg(ex, A, (tx) => insertEnvironmentVariable(tx, "application", fx.a!.applicationId, variable(A, "var3aaaaaaaaaaaaaaaaaaaa", "NODE_ENV", { isPreview: true, value: null })));
    expect(preview).toMatchObject({ key: "NODE_ENV", is_preview: true, value: null, order: null });
    // A key is case sensitive.
    expect(await withOrg(ex, A, (tx) => insertEnvironmentVariable(tx, "application", fx.a!.applicationId, variable(A, "var4aaaaaaaaaaaaaaaaaaaa", "node_env", { order: 2 })))).not.toBeNull();
  });

  it("lists the production or the preview variables by order then id, or by key; a variable without an order comes last", async () => {
    await withOrg(ex, A, async (tx) => {
      await insertEnvironmentVariable(tx, "application", fx.a!.applicationId, variable(A, "var5aaaaaaaaaaaaaaaaaaaa", "ZED", { order: 0 }));
      await insertEnvironmentVariable(tx, "application", fx.a!.applicationId, variable(A, "var6aaaaaaaaaaaaaaaaaaaa", "ALPHA"));
      await insertEnvironmentVariable(tx, "application", fx.a!.applicationId, variable(A, "var7aaaaaaaaaaaaaaaaaaaa", "BETA", { order: 2 }));
    });
    expect(await keys(A, false)).toEqual(["ZED", "NODE_ENV", "node_env", "BETA", "ALPHA"]);
    // By key: where a lower-case key falls depends on the database's collation.
    expect(new Set(await keys(A, false, "key"))).toEqual(new Set(["ALPHA", "BETA", "NODE_ENV", "ZED", "node_env"]));
    expect((await keys(A, false, "key")).filter((k) => k === k.toUpperCase())).toEqual(["ALPHA", "BETA", "NODE_ENV", "ZED"]);
    expect(await keys(A, true)).toEqual(["NODE_ENV"]);
    // max('order') of the production variables.
    expect(await withOrg(ex, A, (tx) => maxEnvironmentVariableOrder(tx, "application", fx.a!.applicationId))).toBe(2);
    expect(await withOrg(ex, B, (tx) => maxEnvironmentVariableOrder(tx, "application", fx.b!.applicationId))).toBe(0);
  });

  it("finds a variable by uuid, and the copies of a key oldest first", async () => {
    expect(await withOrg(ex, A, (tx) => findEnvironmentVariableByUuid(tx, "application", fx.a!.applicationId, "var7aaaaaaaaaaaaaaaaaaaa"))).toMatchObject({ key: "BETA", order: 2 });
    expect(await withOrg(ex, A, (tx) => findEnvironmentVariableByUuid(tx, "application", fx.a!.applicationId, "missing"))).toBeNull();
    // Not this resource's.
    expect(await withOrg(ex, A, (tx) => findEnvironmentVariableByUuid(tx, "application", 999999, "var7aaaaaaaaaaaaaaaaaaaa"))).toBeNull();
    // A copy from an earlier duplicate save (Coolify's table has no unique index).
    await asPlatformAdmin(ex, (tx) =>
      tx.execute(
        `INSERT INTO deploy.environment_variables (uuid, "key", "value", resourceable_type, resourceable_id, org_id) VALUES ('var8aaaaaaaaaaaaaaaaaaaa', 'BETA', 'fp1:copy', $1, $2, $3)`,
        [ENVIRONMENT_VARIABLE_MORPH_CLASS.application, fx.a!.applicationId, A],
      ),
    );
    expect((await withOrg(ex, A, (tx) => findEnvironmentVariablesByKey(tx, "application", fx.a!.applicationId, false, "BETA"))).map((r) => r.uuid)).toEqual(["var7aaaaaaaaaaaaaaaaaaaa", "var8aaaaaaaaaaaaaaaaaaaa"]);
    expect(await withOrg(ex, A, (tx) => findEnvironmentVariablesByKey(tx, "application", fx.a!.applicationId, true, "BETA"))).toEqual([]);
  });

  it("updates only the given columns, a null value included", async () => {
    const row = (await withOrg(ex, A, (tx) => findEnvironmentVariableByUuid(tx, "application", fx.a!.applicationId, "var7aaaaaaaaaaaaaaaaaaaa")))!;
    const saved = await withOrg(ex, A, (tx) => updateEnvironmentVariable(tx, row.id, { key: "GAMMA", value: null, comment: "renamed", order: 7, is_shown_once: true, is_shared: true, is_required: true, is_multiline: true }));
    expect(saved).toMatchObject({
      uuid: "var7aaaaaaaaaaaaaaaaaaaa", key: "GAMMA", value: null, comment: "renamed", order: 7, is_shown_once: true, is_shared: true, is_required: true, is_multiline: true,
      is_literal: false, is_runtime: true, is_buildtime: true,
    });
    expect(await withOrg(ex, A, (tx) => updateEnvironmentVariable(tx, row.id, { comment: null }))).toMatchObject({ key: "GAMMA", comment: null, order: 7 });
    expect(await withOrg(ex, A, (tx) => updateEnvironmentVariable(tx, 999999, { comment: "x" }))).toBeNull();
  });

  it("deletes the given rows and says how many went", async () => {
    const copy = (await withOrg(ex, A, (tx) => findEnvironmentVariableByUuid(tx, "application", fx.a!.applicationId, "var8aaaaaaaaaaaaaaaaaaaa")))!;
    expect(await withOrg(ex, A, (tx) => deleteEnvironmentVariables(tx, []))).toBe(0);
    expect(await withOrg(ex, A, (tx) => deleteEnvironmentVariables(tx, [copy.id, 999999]))).toBe(1);
    expect(await keys(A, false)).toEqual(["ZED", "NODE_ENV", "node_env", "GAMMA", "ALPHA"]);
  });

  it("keeps each org's variables to itself (row-level security)", async () => {
    const mine = (await withOrg(ex, A, (tx) => findEnvironmentVariableByUuid(tx, "application", fx.a!.applicationId, "var1aaaaaaaaaaaaaaaaaaaa")))!;
    expect(await withOrg(ex, B, (tx) => findEnvironmentVariableResource(tx, "application", "appa"))).toBeNull();
    expect(await withOrg(ex, B, (tx) => listEnvironmentVariables(tx, "application", fx.a!.applicationId, false))).toEqual([]);
    expect(await withOrg(ex, B, (tx) => findEnvironmentVariableByUuid(tx, "application", fx.a!.applicationId, "var1aaaaaaaaaaaaaaaaaaaa"))).toBeNull();
    expect(await withOrg(ex, B, (tx) => findEnvironmentVariablesByKey(tx, "application", fx.a!.applicationId, false, "NODE_ENV"))).toEqual([]);
    expect(await withOrg(ex, B, (tx) => updateEnvironmentVariable(tx, mine.id, { comment: "taken over" }))).toBeNull();
    expect(await withOrg(ex, B, (tx) => deleteEnvironmentVariables(tx, [mine.id]))).toBe(0);
    expect(await withOrg(ex, B, (tx) => updateEnvironmentVariableSettings(tx, "application", fx.a!.applicationId, { use_build_secrets: true }))).toBe(false);
    expect((await withOrg(ex, A, (tx) => findEnvironmentVariableByUuid(tx, "application", fx.a!.applicationId, "var1aaaaaaaaaaaaaaaaaaaa")))!.comment).toBe("the mode");
    // A variable cannot be written into another org.
    await expect(withOrg(ex, B, (tx) => insertEnvironmentVariable(tx, "application", fx.b!.applicationId, variable(A, "varcrossorgaaaaaaaaaaaaa", "CROSS")))).rejects.toThrow();
  });
});

describe("the shared variables a value references", () => {
  const share = (org: string, type: string, key: string, scope: { project_id?: unknown; environment_id?: unknown; server_id?: unknown } = {}, locked = false) =>
    withOrg(ex, org, (tx) =>
      tx.execute(
        `INSERT INTO deploy.shared_environment_variables ("key", "value", is_shown_once, "type", project_id, environment_id, server_id, org_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [key, `fp1:${type}:${key}`, locked, type, scope.project_id ?? null, scope.environment_id ?? null, scope.server_id ?? null, org],
      ),
    );

  beforeAll(async () => {
    await share(A, "team", "TOKEN");
    await share(A, "team", "LOCKED", {}, true);
    await share(A, "project", "TOKEN", { project_id: fx.a!.projectId });
    await share(A, "environment", "DB_URL", { environment_id: fx.a!.environmentId });
    await share(B, "team", "TOKEN");
    await share(B, "project", "OTHER", { project_id: fx.b!.projectId });
  });

  it("finds the variable a reference names in the org, a project or an environment, with its stored value and its lock", async () => {
    expect(await withOrg(ex, A, (tx) => findSharedVariableForReference(tx, { type: "team" }, "TOKEN"))).toEqual({ key: "TOKEN", value: "fp1:team:TOKEN", is_shown_once: false });
    expect(await withOrg(ex, A, (tx) => findSharedVariableForReference(tx, { type: "team" }, "LOCKED"))).toMatchObject({ is_shown_once: true });
    expect(await withOrg(ex, A, (tx) => findSharedVariableForReference(tx, { type: "project", id: fx.a!.projectId }, "TOKEN"))).toMatchObject({ value: "fp1:project:TOKEN" });
    expect(await withOrg(ex, A, (tx) => findSharedVariableForReference(tx, { type: "environment", id: fx.a!.environmentId }, "DB_URL"))).toMatchObject({ value: "fp1:environment:DB_URL" });
    // The scope decides: an environment variable is not a team one, and a key is case sensitive.
    expect(await withOrg(ex, A, (tx) => findSharedVariableForReference(tx, { type: "team" }, "DB_URL"))).toBeNull();
    expect(await withOrg(ex, A, (tx) => findSharedVariableForReference(tx, { type: "team" }, "token"))).toBeNull();
    expect(await withOrg(ex, A, (tx) => findSharedVariableForReference(tx, { type: "environment", id: 999999 }, "DB_URL"))).toBeNull();
    expect(await withOrg(ex, A, (tx) => findSharedVariableForReference(tx, { type: "server", id: fx.a!.serverId }, "TOKEN"))).toBeNull();
  });

  it("lists a scope's keys for the value field's suggestions", async () => {
    expect(await withOrg(ex, A, (tx) => listSharedVariableKeys(tx, { type: "team" }))).toEqual(["TOKEN", "LOCKED"]);
    expect(await withOrg(ex, A, (tx) => listSharedVariableKeys(tx, { type: "project", id: fx.a!.projectId }))).toEqual(["TOKEN"]);
    expect(await withOrg(ex, A, (tx) => listSharedVariableKeys(tx, { type: "environment", id: fx.a!.environmentId }))).toEqual(["DB_URL"]);
    expect(await withOrg(ex, A, (tx) => listSharedVariableKeys(tx, { type: "server", id: fx.a!.serverId }))).toEqual([]);
  });

  it("never reads another org's shared variables", async () => {
    expect(await withOrg(ex, B, (tx) => listSharedVariableKeys(tx, { type: "team" }))).toEqual(["TOKEN"]);
    expect(await withOrg(ex, B, (tx) => findSharedVariableForReference(tx, { type: "team" }, "TOKEN"))).toMatchObject({ value: "fp1:team:TOKEN" });
    expect(await withOrg(ex, B, (tx) => findSharedVariableForReference(tx, { type: "team" }, "LOCKED"))).toBeNull();
    expect(await withOrg(ex, B, (tx) => listSharedVariableKeys(tx, { type: "project", id: fx.a!.projectId }))).toEqual([]);
    expect(await withOrg(ex, B, (tx) => findSharedVariableForReference(tx, { type: "environment", id: fx.a!.environmentId }, "DB_URL"))).toBeNull();
  });
});
