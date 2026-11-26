// deploy.gitlab_apps and deploy.gitea_apps (DP-103) against a real Postgres: the tables 500_deploy_core made for them
// (Coolify's columns, org_id, FORCE ROW LEVEL SECURITY with the tenant_isolation policy), and the store functions of
// @saas/db/deploy inside withOrg() — each org's sources kept to itself, the applications a source serves.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  insertOauthSource,
  findOauthSourceByUuid,
  findOauthSourceById,
  listConnectedOauthSources,
  updateOauthSource,
  deleteOauthSource,
  listSourceApplications,
  listSourcesPage,
  insertProject,
  insertPrivateKey,
  insertServer,
  listServerDestinations,
  insertDockerImageApplication,
  updateApplicationSource,
  APPLICATION_WEBHOOK_SECRET_COLUMNS,
  OAUTH_SOURCE_MORPH_CLASS,
  type NewDockerImageApplication,
} from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, executor } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b1";

let db: PGlite;
let ex: TransactionalSqlExecutor;

beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
}, 120_000);
afterAll(async () => db?.close());

const source = (org: string, uuid: string, filter: string | null = null) => ({ orgId: org, uuid, name: `src-${uuid}`, apiUrl: "https://gitlab.acme.test/api/v4", htmlUrl: "https://gitlab.acme.test", customUser: "git", customPort: 22, isSystemWide: false, filter, webhookSecret: `fp1:${uuid}:hook` });

describe("the tables", () => {
  it("have Coolify's columns, org_id, and FORCE ROW LEVEL SECURITY with the tenant_isolation policy", async () => {
    for (const table of ["gitlab_apps", "gitea_apps"]) {
      const rls = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'deploy.${table}'::regclass`);
      expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const policies = await db.query<{ polname: string }>(`SELECT polname FROM pg_policy WHERE polrelid = 'deploy.${table}'::regclass`);
      expect(policies.rows.map((p) => p.polname)).toEqual(["tenant_isolation"]);
    }
    const columns = async (table: string) => (await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'deploy' AND table_name = $1 ORDER BY ordinal_position", [table])).rows.map((r) => r.column_name);
    // 2023_03_28_083726_create_gitlab_apps_table and 2026_06_03_000000_add_oauth_fields_to_gitlab_apps_table (team_id as org_id).
    expect(await columns("gitlab_apps")).toEqual([
      "id", "uuid", "name", "organization", "api_url", "html_url", "custom_port", "custom_user", "is_system_wide", "is_public", "app_id", "app_secret", "oauth_id", "group_name", "public_key",
      "webhook_token", "deploy_key_id", "private_key_id", "created_at", "updated_at", "client_id", "client_secret", "access_token", "refresh_token", "expires_at", "redirect_uri", "org_id",
    ]);
    // 2026_10_12_100000_create_gitea_apps_table.
    expect(await columns("gitea_apps")).toEqual([
      "id", "uuid", "name", "organization", "api_url", "html_url", "custom_port", "custom_user", "is_system_wide", "is_public", "client_id", "client_secret", "access_token", "refresh_token",
      "expires_at", "redirect_uri", "webhook_secret", "private_key_id", "created_at", "updated_at", "org_id",
    ]);
  });
});

describe("the OAuth sources", () => {
  it("inserts a GitLab App and a Gitea App with their filter and webhook secret, and keeps each org's to itself", async () => {
    const gitlab = await withOrg(ex, A, (tx) => insertOauthSource(tx, "gitlab", source(A, "gla1", "acme,acme/platform")));
    expect(gitlab).toMatchObject({ uuid: "gla1", name: "src-gla1", group_name: "acme,acme/platform", webhook_token: "fp1:gla1:hook", webhook_secret: null, organization: null, custom_port: 22, is_public: false, is_system_wide: false, access_token: null });
    const gitea = await withOrg(ex, A, (tx) => insertOauthSource(tx, "gitea", source(A, "gta1", "acme")));
    expect(gitea).toMatchObject({ uuid: "gta1", organization: "acme", webhook_secret: "fp1:gta1:hook", webhook_token: null, group_name: null });
    await withOrg(ex, B, (tx) => insertOauthSource(tx, "gitlab", source(B, "glb1")));
    expect(await withOrg(ex, B, (tx) => findOauthSourceByUuid(tx, "gitlab", "gla1"))).toBeNull();
    expect(await withOrg(ex, B, (tx) => findOauthSourceById(tx, "gitlab", gitlab.id))).toBeNull();
    expect((await withOrg(ex, A, (tx) => findOauthSourceByUuid(tx, "gitea", "gta1")))!.id).toBe(gitea.id);
    // The kinds are separate tables.
    expect(await withOrg(ex, A, (tx) => findOauthSourceByUuid(tx, "gitea", "gla1"))).toBeNull();
    // An insert for another org is refused by the policy's WITH CHECK.
    await expect(withOrg(ex, A, (tx) => insertOauthSource(tx, "gitea", source(B, "gtx")))).rejects.toThrow();
  });

  it("updates the written columns only, stores the tokens, lists the connected ones and deletes", async () => {
    const row = (await withOrg(ex, A, (tx) => findOauthSourceByUuid(tx, "gitlab", "gla1")))!;
    const updated = await withOrg(ex, A, (tx) => updateOauthSource(tx, "gitlab", row.id, { name: "renamed", client_id: "cid", client_secret: "fp1:cs", redirect_uri: "https://app.freeploy.dev/webhooks/source/gitlab/redirect", org_id: B, is_public: true }));
    expect(updated).toMatchObject({ name: "renamed", client_id: "cid", client_secret: "fp1:cs", is_public: false });
    expect(await withOrg(ex, A, (tx) => listConnectedOauthSources(tx, "gitlab"))).toEqual([]);
    await withOrg(ex, A, (tx) => updateOauthSource(tx, "gitlab", row.id, { access_token: "fp1:at", refresh_token: "fp1:rt", expires_at: 1767232800 }));
    expect((await withOrg(ex, A, (tx) => listConnectedOauthSources(tx, "gitlab"))).map((s) => [s.uuid, s.expires_at])).toEqual([["gla1", 1767232800]]);
    // Another org's row is not updated, nor deleted.
    expect(await withOrg(ex, B, (tx) => updateOauthSource(tx, "gitlab", row.id, { name: "taken" }))).toBeNull();
    expect(await withOrg(ex, B, (tx) => deleteOauthSource(tx, "gitlab", row.id))).toBe(false);
    // The Sources page reads them: connected once both tokens are set.
    expect((await withOrg(ex, A, (tx) => listSourcesPage(tx))).map((s) => [s.kind, s.uuid, s.account, s.connected])).toEqual([
      ["gitlab", "gla1", "acme,acme/platform", true],
      ["gitea", "gta1", "acme", false],
    ]);
    const gitea = (await withOrg(ex, A, (tx) => findOauthSourceByUuid(tx, "gitea", "gta1")))!;
    expect(await withOrg(ex, A, (tx) => deleteOauthSource(tx, "gitea", gitea.id))).toBe(true);
    expect(await withOrg(ex, A, (tx) => findOauthSourceByUuid(tx, "gitea", "gta1"))).toBeNull();
  });

  it("lists the applications a source serves, with their repository and branch, by its morph class", async () => {
    const ids = await withOrg(ex, A, async (tx) => {
      const key = await insertPrivateKey(tx, { orgId: A, uuid: "keyoa", name: "k", description: null, privateKey: "fp1:k", fingerprint: null, isGitRelated: false });
      const server = await insertServer(tx, { orgId: A, uuid: "srvoa", name: "srv", description: null, ip: "203.0.113.20", user: "root", port: 22, privateKeyId: key.id, proxy: { type: "TRAEFIK", status: "exited" }, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: "dstoa" });
      const { environment } = await insertProject(tx, { orgId: A, uuid: "prjoa", name: "P", description: null, productionEnvironmentUuid: "envoa" });
      const destination = (await listServerDestinations(tx, server.id))[0]!;
      const app: NewDockerImageApplication = {
        orgId: A, uuid: "appoa" + "x".repeat(19), name: "web", fqdn: null, domainPortOverrides: null, dockerRegistryImageName: "nginx", dockerRegistryImageTag: "latest",
        environmentId: environment.id, destinationId: destination.id, destinationType: "standalone",
        webhookSecrets: Object.fromEntries(APPLICATION_WEBHOOK_SECRET_COLUMNS.map((c) => [c, `fp1:${c}`])) as NewDockerImageApplication["webhookSecrets"],
      };
      const application = await insertDockerImageApplication(tx, app);
      const gitlab = (await findOauthSourceByUuid(tx, "gitlab", "gla1"))!;
      await updateApplicationSource(tx, application.id, { git_repository: "acme/web", git_branch: "main", source_id: gitlab.id, source_type: OAUTH_SOURCE_MORPH_CLASS.gitlab });
      return { application: application.id, gitlab: gitlab.id };
    });
    const served = await withOrg(ex, A, (tx) => listSourceApplications(tx, ids.gitlab, OAUTH_SOURCE_MORPH_CLASS.gitlab));
    expect(served).toEqual([expect.objectContaining({ id: ids.application, name: "web", project_name: "P", environment_name: "production", git_repository: "acme/web", git_branch: "main" })]);
    // Not a Gitea App's of the same id, nor another org's.
    expect(await withOrg(ex, A, (tx) => listSourceApplications(tx, ids.gitlab, OAUTH_SOURCE_MORPH_CLASS.gitea))).toEqual([]);
    expect(await withOrg(ex, B, (tx) => listSourceApplications(tx, ids.gitlab, OAUTH_SOURCE_MORPH_CLASS.gitlab))).toEqual([]);
  });
});
