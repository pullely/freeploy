// deploy.github_apps, the Sources page, and what the Git webhooks read and write (DP-72) against a real Postgres:
// the store functions of @saas/db/deploy inside withOrg(), row-level security keeping each org's rows to itself,
// and the two cross-org lookups a webhook starts with — under asPlatformAdmin(), answering only org and row ids.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  insertPrivateKey,
  insertServer,
  insertProject,
  insertDockerImageApplication,
  listServerDestinations,
  updateApplicationSource,
  insertGithubApp,
  replicateGithubApp,
  findGithubAppByUuid,
  findGithubAppById,
  updateGithubApp,
  deleteGithubApp,
  listRegisteredGithubApps,
  findGithubAppInstallation,
  findGithubAppByInstallationId,
  listSourcesPage,
  findGithubAppPrivateKey,
  privateKeyUsedOutsideGithubApp,
  listSourceApplications,
  findGithubAppWebhookTarget,
  findManualWebhookTargets,
  listWebhookApplications,
  listGithubAppWebhookApplications,
  findApplicationPreview,
  insertApplicationPreview,
  updateApplicationPreview,
  previewHasDeployments,
  deleteApplicationPreview,
  insertSkippedDeployment,
  setApplicationRepositoryProjectId,
  APPLICATION_WEBHOOK_SECRET_COLUMNS,
  GITHUB_APP_MORPH_CLASS,
  type NewDockerImageApplication,
} from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, executor } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

let db: PGlite;
let ex: TransactionalSqlExecutor;

async function world(org: string, tag: string) {
  return withOrg(ex, org, async (tx) => {
    const key = await insertPrivateKey(tx, { orgId: org, uuid: `key${tag}`, name: `github-app-${tag}`, description: null, privateKey: "fp1:app-key", fingerprint: null, isGitRelated: true });
    const server = await insertServer(tx, {
      orgId: org, uuid: `srv${tag}`, name: `main-${tag}`, description: null, ip: "203.0.113.10", user: "root", port: 22, privateKeyId: key.id,
      proxy: { type: "TRAEFIK", status: "exited" }, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: `dst${tag}`,
    });
    const { environment } = await insertProject(tx, { orgId: org, uuid: `prj${tag}`, name: `Project-${tag}`, description: null, productionEnvironmentUuid: `env${tag}` });
    const destination = (await listServerDestinations(tx, server.id))[0]!;
    const app = (uuid: string): NewDockerImageApplication => ({
      orgId: org, uuid, name: `web-${uuid}`, fqdn: "https://web.example.com", domainPortOverrides: null, dockerRegistryImageName: "nginx", dockerRegistryImageTag: "latest",
      environmentId: environment.id, destinationId: destination.id, destinationType: "standalone",
      webhookSecrets: Object.fromEntries(APPLICATION_WEBHOOK_SECRET_COLUMNS.map((c) => [c, `fp1:${uuid}:${c}`])) as NewDockerImageApplication["webhookSecrets"],
    });
    const github = await insertGithubApp(tx, { orgId: org, uuid: `gha${tag}`, name: `app-${tag}`, organization: "acme", apiUrl: "https://api.github.com", htmlUrl: "https://github.com", customUser: "git", customPort: 22, isSystemWide: false });
    await updateGithubApp(tx, github.id, { app_id: 4242, installation_id: tag === "a" ? 777 : 888, private_key_id: key.id, webhook_secret: "fp1:hook" });
    const one = await insertDockerImageApplication(tx, app(`app1${tag}${"x".repeat(19)}`));
    const two = await insertDockerImageApplication(tx, app(`app2${tag}${"x".repeat(19)}`));
    // A GitHub App application and a repository with a manual webhook.
    await updateApplicationSource(tx, one.id, { git_repository: "acme/app", git_branch: "main", source_id: github.id, source_type: GITHUB_APP_MORPH_CLASS, repository_project_id: 10 });
    await updateApplicationSource(tx, two.id, { git_repository: "https://github.com/Acme/App.git", git_branch: "main" });
    await tx.execute("UPDATE deploy.server_settings SET is_reachable = true, is_usable = true WHERE server_id = $1", [server.id]);
    return { keyId: key.id, githubId: github.id, one: one.id, two: two.id, serverId: server.id };
  });
}

let wa: Awaited<ReturnType<typeof world>>;
let wb: Awaited<ReturnType<typeof world>>;

beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
  wa = await world(A, "a");
  wb = await world(B, "b");
}, 120_000);
afterAll(async () => db?.close());

describe("deploy.github_apps", () => {
  it("inserts, reads, updates and keeps each org's Apps to itself", async () => {
    const row = await withOrg(ex, A, (tx) => findGithubAppByUuid(tx, "ghaa"));
    expect(row).toMatchObject({ name: "app-a", organization: "acme", api_url: "https://api.github.com", html_url: "https://github.com", custom_user: "git", custom_port: 22, app_id: 4242, installation_id: 777, webhook_secret: "fp1:hook", is_public: false, is_system_wide: false });
    expect(await withOrg(ex, B, (tx) => findGithubAppByUuid(tx, "ghaa"))).toBeNull();
    expect(await withOrg(ex, A, (tx) => findGithubAppById(tx, wb.githubId))).toBeNull();
    expect((await withOrg(ex, A, (tx) => listRegisteredGithubApps(tx))).map((a) => a.uuid)).toEqual(["ghaa"]);
    const updated = await withOrg(ex, A, (tx) => updateGithubApp(tx, wa.githubId, { contents: "read", webhook_events: JSON.stringify(["push"]) }));
    expect(updated).toMatchObject({ contents: "read", webhook_events: ["push"] });
  });

  it("finds an installation's source, and copies an App for another installation", async () => {
    expect((await withOrg(ex, A, (tx) => findGithubAppInstallation(tx, "https://api.github.com", 4242, 777)))!.uuid).toBe("ghaa");
    expect(await withOrg(ex, A, (tx) => findGithubAppInstallation(tx, "https://api.github.com", 4242, 888))).toBeNull();
    expect((await withOrg(ex, A, (tx) => findGithubAppByInstallationId(tx, 777)))!.uuid).toBe("ghaa");
    const copy = await withOrg(ex, A, (tx) => replicateGithubApp(tx, wa.githubId, "ghacopy"));
    expect(copy).toMatchObject({ uuid: "ghacopy", name: "app-a", app_id: 4242, installation_id: null, installation_account: null, deployments: null, webhook_secret: "fp1:hook" });
    expect(await withOrg(ex, A, (tx) => deleteGithubApp(tx, copy!.id))).toBe(true);
  });

  it("lists the Sources page: GitHub's, then GitLab's and Gitea's, never a public one", async () => {
    await withOrg(ex, A, async (tx) => {
      await tx.execute("INSERT INTO deploy.gitlab_apps (uuid, name, api_url, html_url, group_name, access_token, refresh_token, org_id) VALUES ('gla', 'lab', 'https://gitlab.com', 'https://gitlab.com', 'grp', 't', 'r', $1)", [A]);
      await tx.execute("INSERT INTO deploy.github_apps (uuid, name, api_url, html_url, is_public, org_id) VALUES ('ghpub', 'public', 'x', 'y', true, $1)", [A]);
    });
    expect(await withOrg(ex, A, (tx) => listSourcesPage(tx))).toEqual([
      { kind: "github", uuid: "ghaa", name: "app-a", account: "acme", connected: true, html_url: "https://github.com", registered: true },
      { kind: "gitlab", uuid: "gla", name: "lab", account: "grp", connected: true, html_url: "https://gitlab.com", registered: false },
    ]);
  });

  it("reads the App's key and what else uses it, and the applications it serves", async () => {
    expect(await withOrg(ex, A, (tx) => findGithubAppPrivateKey(tx, wa.keyId))).toMatchObject({ name: "github-app-a", private_key: "fp1:app-key" });
    expect(await withOrg(ex, B, (tx) => findGithubAppPrivateKey(tx, wa.keyId))).toBeNull();
    // The server's key too: it is used elsewhere.
    expect(await withOrg(ex, A, (tx) => privateKeyUsedOutsideGithubApp(tx, wa.keyId, wa.githubId))).toBe(true);
    expect((await withOrg(ex, A, (tx) => listSourceApplications(tx, wa.githubId))).map((a) => a.id)).toEqual([wa.one]);
  });
});

describe("the webhooks", () => {
  it("find the App's org across orgs, with the installation when there is one", async () => {
    expect(await asPlatformAdmin(ex, (tx) => findGithubAppWebhookTarget(tx, 4242, 888))).toEqual({ org_id: B, id: wb.githubId });
    expect(await asPlatformAdmin(ex, (tx) => findGithubAppWebhookTarget(tx, 4242, 999))).toEqual({ org_id: A, id: wa.githubId });
    expect(await asPlatformAdmin(ex, (tx) => findGithubAppWebhookTarget(tx, 1, null))).toBeNull();
    // Inside one org's withOrg() the lookup sees that org only.
    expect(await withOrg(ex, B, (tx) => findGithubAppWebhookTarget(tx, 4242, 777))).toEqual({ org_id: B, id: wb.githubId });
  });

  it("find a manual webhook's applications across orgs, by the repository's name and the branch", async () => {
    const targets = await asPlatformAdmin(ex, (tx) => findManualWebhookTargets(tx, "%acme/app%", ["main"]));
    expect(targets.map((t) => [t.org_id, t.id])).toEqual([
      [A, wa.one],
      [A, wa.two],
      [B, wb.one],
      [B, wb.two],
    ]);
    expect(await asPlatformAdmin(ex, (tx) => findManualWebhookTargets(tx, "%acme/app%", ["dev"]))).toEqual([]);
    expect((await asPlatformAdmin(ex, (tx) => findManualWebhookTargets(tx, "%acme/app%", null))).length).toBe(4);
    // `_` is literal in the name.
    expect(await asPlatformAdmin(ex, (tx) => findManualWebhookTargets(tx, "%acme\\_app%", null))).toEqual([]);
  });

  it("read the applications with their settings and server, and the App's applications by repository id and branch", async () => {
    const rows = await withOrg(ex, A, (tx) => listWebhookApplications(tx, [wa.one, wa.two, wb.one]));
    expect(rows.map((r) => r.id)).toEqual([wa.one, wa.two]);
    expect(rows[1]).toMatchObject({ git_repository: "https://github.com/Acme/App.git", manual_webhook_secret_github: expect.stringMatching(/^fp1:/), is_auto_deploy_enabled: true, is_preview_deployments_enabled: false, server_is_reachable: true, server_is_usable: true, server_force_disabled: false, project_uuid: "prja", environment_uuid: "enva" });
    expect((await withOrg(ex, A, (tx) => listGithubAppWebhookApplications(tx, wa.githubId, 10, "main"))).map((r) => r.id)).toEqual([wa.one]);
    expect(await withOrg(ex, A, (tx) => listGithubAppWebhookApplications(tx, wa.githubId, 10, "dev"))).toEqual([]);
    expect((await withOrg(ex, A, (tx) => listGithubAppWebhookApplications(tx, wa.githubId, 10, null))).map((r) => r.id)).toEqual([wa.one]);
    await withOrg(ex, A, (tx) => setApplicationRepositoryProjectId(tx, wa.one, 11));
    expect(await withOrg(ex, A, (tx) => listGithubAppWebhookApplications(tx, wa.githubId, 10, null))).toEqual([]);
    await withOrg(ex, A, (tx) => setApplicationRepositoryProjectId(tx, wa.one, 10));
  });

  it("create, update and remove a pull request's preview", async () => {
    const preview = await withOrg(ex, A, (tx) => insertApplicationPreview(tx, { orgId: A, uuid: "prv1", applicationId: wa.one, pullRequestId: 7, pullRequestHtmlUrl: "https://github.com/acme/app/pull/7", gitType: "github", dockerComposeDomains: null }));
    expect(preview).toMatchObject({ pull_request_id: 7, git_type: "github", fqdn: null, status: "exited", is_same_repository: false });
    await withOrg(ex, A, (tx) => updateApplicationPreview(tx, preview.id, { fqdn: "https://7.web.example.com", domain_port_overrides: { "https://7.web.example.com": 8080 }, is_same_repository: true }));
    expect(await withOrg(ex, A, (tx) => findApplicationPreview(tx, wa.one, 7))).toMatchObject({ fqdn: "https://7.web.example.com", domain_port_overrides: { "https://7.web.example.com": 8080 }, is_same_repository: true });
    expect(await withOrg(ex, B, (tx) => findApplicationPreview(tx, wa.one, 7))).toBeNull();
    expect(await withOrg(ex, A, (tx) => previewHasDeployments(tx, wa.one, 7))).toBe(false);
    expect(await withOrg(ex, A, (tx) => deleteApplicationPreview(tx, preview.id))).toBe(true);
    expect(await withOrg(ex, A, (tx) => findApplicationPreview(tx, wa.one, 7))).toBeNull();
  });

  it("store a skipped preview deployment with its reason, which no deployment counts as having run", async () => {
    await withOrg(ex, A, (tx) =>
      insertSkippedDeployment(tx, {
        orgId: A, applicationId: wa.one, applicationName: "web", deploymentUuid: "dep-skipped", deploymentUrl: "/project/p/environment/e/application/a/deployment/dep-skipped",
        serverId: wa.serverId, serverName: "main-a", destinationId: null, pullRequestId: 8, commit: "HEAD", commitMessage: "Skipped the preview deployment: …", gitType: "github",
        logs: [{ command: null, output: "Skipped the preview deployment: …", type: "stdout", timestamp: "2026-11-20T10:11:12.000000Z", hidden: false, batch: 1, order: 1 }],
      }),
    );
    const row = (await asPlatformAdmin(ex, async (tx) => (await tx.execute<Record<string, unknown>>("SELECT status, is_webhook, git_type, commit_message, finished_at, logs FROM deploy.application_deployment_queues WHERE deployment_uuid = 'dep-skipped'")).rows))[0]!;
    expect(row).toMatchObject({ status: "skipped", is_webhook: true, git_type: "github", commit_message: "Skipped the preview deployment: …" });
    expect(row.finished_at).not.toBeNull();
    expect(JSON.parse(String(row.logs))).toHaveLength(1);
    expect(await withOrg(ex, A, (tx) => previewHasDeployments(tx, wa.one, 8))).toBe(false);
  });
});
