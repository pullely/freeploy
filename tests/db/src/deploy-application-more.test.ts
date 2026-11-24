// An application's Git source, additional destinations, scheduled tasks and
// rollback setting (DP-58) against a real Postgres: the store functions of
// @saas/db/deploy inside withOrg() — the Git columns and the org's keys and
// Git sources, the additional_destinations pivot (attach once, promote in
// one transaction, detach), scheduled tasks by owner with their executions,
// the images-to-keep setting, what deleting an application removes of them —
// and row-level security keeping each org's rows to itself.
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
  insertDockerImageApplication,
  listServerDestinations,
  findApplicationByUuid,
  findApplicationSource,
  updateApplicationSource,
  listDeployKeys,
  findDeployKey,
  listGitSources,
  findGitSource,
  gitSourceKind,
  gitSourceTable,
  listAdditionalDestinations,
  listServerNetworks,
  findDestinationServer,
  findServerNetwork,
  additionalDestinationExists,
  attachAdditionalDestination,
  detachAdditionalDestination,
  promoteAdditionalDestination,
  listScheduledTasks,
  findScheduledTask,
  insertScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  listScheduledTaskExecutions,
  findApplicationRollback,
  updateApplicationImagesToKeep,
  deleteApplication,
  APPLICATION_WEBHOOK_SECRET_COLUMNS,
  GIT_SOURCE_MORPH_CLASS,
  WEBHOOK_SECRET_COLUMN,
  type DeployDestinationRow,
  type NewDockerImageApplication,
  type ScheduledTaskOwner,
} from "@saas/db/deploy";
import type { SqlExecutor, TransactionalSqlExecutor } from "@saas/db/hyperdrive";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migration = (m: string) => readFileSync(resolve(root, `packages/db/src/migrations/${m}/up.sql`), "utf8");
const SCHEMA = ["500_deploy_core", "510_deploy_org_keys", "520_deploy_schema_fold_fixes", "610_deploy_tags_org_name_unique"].map(migration).join("\n");
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const APP1 = "app1aaaaaaaaaaaaaaaaaaaa";
const APP2 = "app2aaaaaaaaaaaaaaaaaaaa";
const APPB = "app1bbbbbbbbbbbbbbbbbbbb";

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
  keyId: string | number;
  serverId: string | number;
  destination: DeployDestinationRow;
  /** A second server with its own default network. */
  otherServerId: string | number;
  otherDestination: DeployDestinationRow;
  environmentId: string | number;
}
const fx: Record<string, Fixture> = {};
const ids: Record<string, string | number> = {};

async function fixture(org: string, tag: string): Promise<Fixture> {
  return withOrg(ex, org, async (tx) => {
    const key = await insertPrivateKey(tx, { orgId: org, uuid: `key${tag}`, name: `key-${tag}`, description: null, privateKey: "fp1:fake", fingerprint: null });
    const server = (name: string, uuid: string, dst: string) =>
      insertServer(tx, {
        orgId: org, uuid, name, description: null, ip: "203.0.113.10", user: "root", port: 22, privateKeyId: key.id,
        proxy: { type: "TRAEFIK", status: "exited" }, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: dst,
      });
    const main = await server(`main-${tag}`, `srv${tag}`, `dst${tag}`);
    const other = await server(`edge-${tag}`, `srv2${tag}`, `dst2${tag}`);
    const { environment } = await insertProject(tx, { orgId: org, uuid: `prj${tag}`, name: `Project-${tag}`, description: null, productionEnvironmentUuid: `env${tag}` });
    return {
      keyId: key.id,
      serverId: main.id,
      destination: (await listServerDestinations(tx, main.id))[0]!,
      otherServerId: other.id,
      otherDestination: (await listServerDestinations(tx, other.id))[0]!,
      environmentId: environment.id,
    };
  });
}

const newApp = (org: string, f: Fixture, uuid: string): NewDockerImageApplication => ({
  orgId: org,
  uuid,
  name: `docker-image-${uuid}`,
  fqdn: null,
  domainPortOverrides: null,
  dockerRegistryImageName: "nginx",
  dockerRegistryImageTag: "latest",
  environmentId: f.environmentId,
  destinationId: f.destination.id,
  destinationType: "standalone",
  webhookSecrets: Object.fromEntries(APPLICATION_WEBHOOK_SECRET_COLUMNS.map((c) => [c, `fp1:${uuid}:${c}`])) as NewDockerImageApplication["webhookSecrets"],
});

const admin = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => asPlatformAdmin(ex, async (tx) => (await tx.execute<T>(sql, params)).rows);
const raw = (table: string, where: string, params: unknown[]) => admin<Record<string, unknown>>(`SELECT * FROM deploy.${table} WHERE ${where} ORDER BY id`, params);
const count = async (table: string, where: string, params: unknown[]) => Number((await admin<{ n: number }>(`SELECT count(*)::int AS n FROM deploy.${table} WHERE ${where}`, params))[0]!.n);
const task = (key: string): ScheduledTaskOwner => ({ kind: "application", id: ids[key]! });

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  ex = executor(db);
  fx.a = await fixture(A, "a");
  fx.b = await fixture(B, "b");
  ids.app1 = (await withOrg(ex, A, (tx) => insertDockerImageApplication(tx, newApp(A, fx.a!, APP1)))).id;
  ids.app2 = (await withOrg(ex, A, (tx) => insertDockerImageApplication(tx, newApp(A, fx.a!, APP2)))).id;
  ids.appb = (await withOrg(ex, B, (tx) => insertDockerImageApplication(tx, newApp(B, fx.b!, APPB)))).id;
}, 120_000);
afterAll(async () => db?.close());

describe("an application's Git columns (deploy.applications)", () => {
  it("reads the Source and Webhooks columns with the deploy key's name", async () => {
    const row = (await withOrg(ex, A, (tx) => findApplicationSource(tx, APP1)))!;
    expect(row).toMatchObject({
      id: ids.app1, uuid: APP1, build_pack: "dockerimage", has_dockerfile: false, git_repository: "coollabsio/coolify", git_branch: "main", git_commit_sha: "HEAD",
      source_id: null, source_type: null, private_key_id: null, private_key_name: null, git_https_username: null, git_https_password: null, git_ssh_known_hosts: null,
      manual_webhook_secret_github: `fp1:${APP1}:manual_webhook_secret_github`, manual_webhook_secret_gitea: `fp1:${APP1}:manual_webhook_secret_gitea`,
    });
    expect(await withOrg(ex, A, (tx) => findApplicationSource(tx, "nope"))).toBeNull();
  });

  it("writes only the given columns, and a deleted application is not found", async () => {
    expect(
      await withOrg(ex, A, (tx) =>
        updateApplicationSource(tx, ids.app1!, { git_repository: "git@git.example.com:team/app.git", git_branch: "release", private_key_id: fx.a!.keyId, git_ssh_known_hosts: "git.example.com ssh-ed25519 AAAA", git_https_password: "fp1:secret" }),
      ),
    ).toBe(true);
    expect(await withOrg(ex, A, (tx) => findApplicationSource(tx, APP1))).toMatchObject({
      git_repository: "git@git.example.com:team/app.git", git_branch: "release", git_commit_sha: "HEAD", private_key_name: "key-a", git_ssh_known_hosts: "git.example.com ssh-ed25519 AAAA", git_https_password: "fp1:secret",
      manual_webhook_secret_gitlab: `fp1:${APP1}:manual_webhook_secret_gitlab`,
    });
    // A null clears; an empty change set writes nothing.
    await withOrg(ex, A, (tx) => updateApplicationSource(tx, ids.app1!, { git_https_password: null, [WEBHOOK_SECRET_COLUMN.gitlab]: null, source_id: 0, source_type: GIT_SOURCE_MORPH_CLASS.github, repository_project_id: 42 }));
    expect(await withOrg(ex, A, (tx) => findApplicationSource(tx, APP1))).toMatchObject({ git_https_password: null, manual_webhook_secret_gitlab: null, source_type: "App\\Models\\GithubApp", repository_project_id: 42 });
    expect(Number((await withOrg(ex, A, (tx) => findApplicationSource(tx, APP1)))!.source_id)).toBe(0);
    expect(await withOrg(ex, A, (tx) => updateApplicationSource(tx, ids.app1!, {}))).toBe(true);
    expect(await withOrg(ex, A, (tx) => updateApplicationSource(tx, 999999, { git_branch: "x" }))).toBe(false);
  });

  it("lists the org's private keys and finds one by id", async () => {
    expect((await withOrg(ex, A, (tx) => listDeployKeys(tx))).map((k) => k.name)).toEqual(["key-a"]);
    expect(await withOrg(ex, A, (tx) => findDeployKey(tx, fx.a!.keyId))).toMatchObject({ uuid: "keya", name: "key-a" });
    expect(await withOrg(ex, A, (tx) => findDeployKey(tx, fx.b!.keyId))).toBeNull();
  });

  it("row-level security: another org's application is neither read nor written", async () => {
    expect(await withOrg(ex, B, (tx) => findApplicationSource(tx, APP1))).toBeNull();
    expect(await withOrg(ex, B, (tx) => updateApplicationSource(tx, ids.app1!, { git_branch: "stolen" }))).toBe(false);
    expect((await withOrg(ex, A, (tx) => findApplicationSource(tx, APP1)))!.git_branch).toBe("release");
  });
});

describe("the org's Git sources (deploy.github_apps, gitlab_apps, gitea_apps)", () => {
  beforeAll(async () => {
    const base = "uuid, name, api_url, html_url, org_id";
    await admin(`INSERT INTO deploy.github_apps (${base}, app_id, installation_account, organization) VALUES ('gh1', 'my-app', 'https://api.github.com', 'https://github.com', $1, 7, 'acme', 'ignored')`, [A]);
    await admin(`INSERT INTO deploy.github_apps (${base}, organization) VALUES ('gh2', 'half-made', 'https://api.github.com', 'https://github.com', $1, 'acme-org')`, [A]);
    await admin(`INSERT INTO deploy.github_apps (${base}, app_id, is_public) VALUES ('gh3', 'public-one', 'https://api.github.com', 'https://github.com', $1, 9, true)`, [A]);
    await admin(`INSERT INTO deploy.gitlab_apps (${base}, group_name, access_token, refresh_token, custom_port) VALUES ('gl1', 'lab', 'https://gitlab.com/api/v4', 'https://gitlab.com', $1, 'team', 'fp1:a', 'fp1:r', 2222)`, [A]);
    await admin(`INSERT INTO deploy.gitea_apps (${base}) VALUES ('gt1', 'tea', 'https://gitea.example.com/api/v1', 'https://gitea.example.com', $1)`, [A]);
    await admin(`INSERT INTO deploy.github_apps (${base}, app_id) VALUES ('ghb', 'b-app', 'https://api.github.com', 'https://github.com', $1, 1)`, [B]);
  });

  it("lists the sources that are not public, GitHub's first, with what makes each usable", async () => {
    const sources = await withOrg(ex, A, (tx) => listGitSources(tx));
    expect(sources.map((s) => [s.kind, s.name, s.account, s.usable, s.is_public, s.custom_user, s.custom_port])).toEqual([
      ["github", "my-app", "acme", true, false, "git", 22],
      ["github", "half-made", "acme-org", false, false, "git", 22],
      ["gitlab", "lab", "team", true, false, "git", 2222],
      ["gitea", "tea", null, false, false, "git", 22],
    ]);
    expect((await withOrg(ex, B, (tx) => listGitSources(tx))).map((s) => s.name)).toEqual(["b-app"]);
  });

  it("finds a source by kind and id (also a public one), within the org", async () => {
    const [lab] = await raw("gitlab_apps", "uuid = 'gl1'", []);
    const [pub] = await raw("github_apps", "uuid = 'gh3'", []);
    expect(await withOrg(ex, A, (tx) => findGitSource(tx, "gitlab", lab!.id as number))).toMatchObject({ kind: "gitlab", name: "lab", html_url: "https://gitlab.com" });
    expect(await withOrg(ex, A, (tx) => findGitSource(tx, "github", pub!.id as number))).toMatchObject({ name: "public-one", is_public: true });
    expect(await withOrg(ex, A, (tx) => findGitSource(tx, "gitea", lab!.id as number + 1000))).toBeNull();
    expect(await withOrg(ex, B, (tx) => findGitSource(tx, "gitlab", lab!.id as number))).toBeNull();
    expect(gitSourceKind("App\\Models\\GiteaApp")).toBe("gitea");
    expect(gitSourceKind("App\\Models\\Server")).toBeNull();
    expect(gitSourceTable("github")).toBe("deploy.github_apps");
  });
});

describe("additional destinations (deploy.additional_destinations)", () => {
  it("lists every standalone network of the org's servers, by server name", async () => {
    const networks = await withOrg(ex, A, (tx) => listServerNetworks(tx));
    expect(networks.map((n) => [n.server_name, n.uuid, String(n.id)])).toEqual([
      ["edge-a", "dst2a", String(fx.a!.otherDestination.id)],
      ["main-a", "dsta", String(fx.a!.destination.id)],
    ]);
    expect(networks[0]).toMatchObject({ server_uuid: "srv2a", is_swarm_worker: false, force_disabled: false, server_role: "both" });
    expect(await withOrg(ex, A, (tx) => findDestinationServer(tx, fx.a!.otherServerId))).toMatchObject({ uuid: "srv2a", name: "edge-a", server_role: "both" });
    expect(await withOrg(ex, A, (tx) => findDestinationServer(tx, fx.b!.serverId))).toBeNull();
    expect(await withOrg(ex, A, (tx) => findServerNetwork(tx, fx.a!.otherServerId, fx.a!.otherDestination.id))).toMatchObject({ uuid: "dst2a" });
    // A network of another server is not that server's.
    expect(await withOrg(ex, A, (tx) => findServerNetwork(tx, fx.a!.serverId, fx.a!.otherDestination.id))).toBeNull();
  });

  it("attaches a network once (syncWithoutDetaching), with the pivot's default status", async () => {
    const other = fx.a!;
    expect(await withOrg(ex, A, (tx) => listAdditionalDestinations(tx, ids.app1!))).toEqual([]);
    expect(await withOrg(ex, A, (tx) => attachAdditionalDestination(tx, A, ids.app1!, other.otherServerId, other.otherDestination.id))).toBe(true);
    expect(await withOrg(ex, A, (tx) => attachAdditionalDestination(tx, A, ids.app1!, other.otherServerId, other.otherDestination.id))).toBe(false);
    const list = await withOrg(ex, A, (tx) => listAdditionalDestinations(tx, ids.app1!));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ uuid: "dst2a", server_uuid: "srv2a", server_name: "edge-a", status: "exited", network: other.otherDestination.network });
    expect(await count("additional_destinations", "application_id = $1 AND org_id = $2", [ids.app1, A])).toBe(1);
    expect(await withOrg(ex, A, (tx) => additionalDestinationExists(tx, ids.app1!, other.otherServerId))).toBe(true);
    expect(await withOrg(ex, A, (tx) => additionalDestinationExists(tx, ids.app1!, other.otherServerId, other.otherDestination.id))).toBe(true);
    expect(await withOrg(ex, A, (tx) => additionalDestinationExists(tx, ids.app1!, other.serverId))).toBe(false);
    expect(await withOrg(ex, A, (tx) => additionalDestinationExists(tx, ids.app2!, other.otherServerId))).toBe(false);
    // Another org sees none of it and cannot detach it.
    expect(await withOrg(ex, B, (tx) => listAdditionalDestinations(tx, ids.app1!))).toEqual([]);
    expect(await withOrg(ex, B, (tx) => detachAdditionalDestination(tx, ids.app1!, other.otherServerId, other.otherDestination.id))).toBe(false);
  });

  it("promotes it: the main destination changes and the former one becomes additional", async () => {
    const f = fx.a!;
    expect(
      await withOrg(ex, A, (tx) => promoteAdditionalDestination(tx, A, ids.app1!, { serverId: f.otherServerId, networkId: f.otherDestination.id }, { serverId: f.serverId, networkId: f.destination.id })),
    ).toBe(true);
    const app = (await withOrg(ex, A, (tx) => findApplicationByUuid(tx, APP1)))!;
    expect(app).toMatchObject({ destination_uuid: "dst2a", server_uuid: "srv2a", destination_type: "App\\Models\\StandaloneDocker" });
    expect((await withOrg(ex, A, (tx) => listAdditionalDestinations(tx, ids.app1!))).map((d) => [d.uuid, d.server_uuid, d.status])).toEqual([["dsta", "srva", "exited"]]);
    // Without a former main destination nothing is added; an application that is gone is not promoted.
    expect(await withOrg(ex, A, (tx) => promoteAdditionalDestination(tx, A, ids.app1!, { serverId: f.serverId, networkId: f.destination.id }, null))).toBe(true);
    expect(await withOrg(ex, A, (tx) => listAdditionalDestinations(tx, ids.app1!))).toEqual([]);
    expect(await withOrg(ex, A, (tx) => promoteAdditionalDestination(tx, A, 999999, { serverId: f.serverId, networkId: f.destination.id }, null))).toBe(false);
    expect(await withOrg(ex, B, (tx) => promoteAdditionalDestination(tx, B, ids.app1!, { serverId: f.otherServerId, networkId: f.otherDestination.id }, null))).toBe(false);
  });

  it("detaches a network, and deleting the application removes its pivot rows", async () => {
    const f = fx.a!;
    await withOrg(ex, A, (tx) => attachAdditionalDestination(tx, A, ids.app1!, f.otherServerId, f.otherDestination.id));
    expect(await withOrg(ex, A, (tx) => detachAdditionalDestination(tx, ids.app1!, f.otherServerId, f.otherDestination.id))).toBe(true);
    expect(await withOrg(ex, A, (tx) => detachAdditionalDestination(tx, ids.app1!, f.otherServerId, f.otherDestination.id))).toBe(false);

    await withOrg(ex, A, (tx) => attachAdditionalDestination(tx, A, ids.app2!, f.otherServerId, f.otherDestination.id));
    await withOrg(ex, A, (tx) => attachAdditionalDestination(tx, A, ids.app1!, f.otherServerId, f.otherDestination.id));
    expect(await withOrg(ex, A, (tx) => deleteApplication(tx, ids.app2!))).toBe(true);
    expect(await count("additional_destinations", "application_id = $1", [ids.app2])).toBe(0);
    // The other application's row stays.
    expect(await count("additional_destinations", "application_id = $1", [ids.app1])).toBe(1);
    await withOrg(ex, A, (tx) => detachAdditionalDestination(tx, ids.app1!, f.otherServerId, f.otherDestination.id));
  });
});

describe("scheduled tasks (deploy.scheduled_tasks, deploy.scheduled_task_executions)", () => {
  it("adds, lists, finds, updates and deletes an owner's tasks", async () => {
    const created = await withOrg(ex, A, (tx) => insertScheduledTask(tx, { orgId: A, owner: task("app1"), uuid: "task1", name: "Cleanup", command: "php artisan cleanup", frequency: "daily", container: "", timeout: 300, useShell: true }));
    expect(created).toMatchObject({ uuid: "task1", enabled: true, name: "Cleanup", command: "php artisan cleanup", frequency: "daily", container: "", timeout: 300, use_shell: true, latest_status: null });
    await withOrg(ex, A, (tx) => insertScheduledTask(tx, { orgId: A, owner: task("app1"), uuid: "task2", name: "Report", command: "report", frequency: "0 6 * * 1", container: "worker", timeout: 60, useShell: false }));
    expect((await withOrg(ex, A, (tx) => listScheduledTasks(tx, task("app1")))).map((t) => [t.uuid, t.frequency, t.container, t.use_shell])).toEqual([
      ["task1", "daily", "", true],
      ["task2", "0 6 * * 1", "worker", false],
    ]);
    const row = (await raw("scheduled_tasks", "uuid = 'task1'", []))[0]!;
    expect(row).toMatchObject({ application_id: ids.app1, service_id: null, org_id: A });
    expect(row.created_at).not.toBeNull();

    expect(await withOrg(ex, A, (tx) => updateScheduledTask(tx, task("app1"), created.id, { enabled: false, timeout: 120 }))).toBe(true);
    expect(await withOrg(ex, A, (tx) => findScheduledTask(tx, task("app1"), "task1"))).toMatchObject({ enabled: false, timeout: 120, name: "Cleanup", command: "php artisan cleanup" });
    expect(await withOrg(ex, A, (tx) => updateScheduledTask(tx, task("app1"), created.id, {}))).toBe(true);
    // A task is its owner's only: another kind of owner with the same id, or another org, does not reach it.
    expect(await withOrg(ex, A, (tx) => findScheduledTask(tx, { kind: "service", id: ids.app1! }, "task1"))).toBeNull();
    expect(await withOrg(ex, A, (tx) => updateScheduledTask(tx, { kind: "service", id: ids.app1! }, created.id, { name: "x" }))).toBe(false);
    expect(await withOrg(ex, B, (tx) => listScheduledTasks(tx, task("app1")))).toEqual([]);
    expect(await withOrg(ex, B, (tx) => updateScheduledTask(tx, task("app1"), created.id, { name: "stolen" }))).toBe(false);
    expect(await withOrg(ex, B, (tx) => deleteScheduledTask(tx, task("app1"), created.id))).toBe(false);
    expect((await withOrg(ex, A, (tx) => findScheduledTask(tx, task("app1"), "task1")))!.name).toBe("Cleanup");
  });

  it("a service's task uses service_id", async () => {
    const created = await withOrg(ex, A, (tx) => insertScheduledTask(tx, { orgId: A, owner: { kind: "service", id: 77 }, uuid: "svc-task", name: "Service job", command: "run", frequency: "hourly", container: "app", timeout: 300, useShell: true }));
    expect((await raw("scheduled_tasks", "uuid = 'svc-task'", []))[0]).toMatchObject({ application_id: null, service_id: 77 });
    expect((await withOrg(ex, A, (tx) => listScheduledTasks(tx, { kind: "service", id: 77 }))).map((t) => t.uuid)).toEqual(["svc-task"]);
    expect(await withOrg(ex, A, (tx) => deleteScheduledTask(tx, { kind: "service", id: 77 }, created.id))).toBe(true);
  });

  it("the latest execution's status and the executions, newest first; a deletion takes them along", async () => {
    const t = (await withOrg(ex, A, (tx) => findScheduledTask(tx, task("app1"), "task1")))!;
    await admin(
      `INSERT INTO deploy.scheduled_task_executions (uuid, status, message, scheduled_task_id, created_at, finished_at, org_id) VALUES
         ('ex1', 'failed', 'boom', $1, '2026-11-01 10:00:00', '2026-11-01 10:00:05', $2),
         ('ex2', 'success', 'done', $1, '2026-11-02 10:00:00', '2026-11-02 10:00:03', $2)`,
      [t.id, A],
    );
    expect((await withOrg(ex, A, (tx) => findScheduledTask(tx, task("app1"), "task1")))!.latest_status).toBe("success");
    expect((await withOrg(ex, A, (tx) => listScheduledTasks(tx, task("app1")))).map((x) => x.latest_status)).toEqual(["success", null]);
    expect((await withOrg(ex, A, (tx) => listScheduledTaskExecutions(tx, t.id))).map((e) => [e.uuid, e.status, e.message])).toEqual([
      ["ex2", "success", "done"],
      ["ex1", "failed", "boom"],
    ]);
    expect((await withOrg(ex, A, (tx) => listScheduledTaskExecutions(tx, t.id, 1))).map((e) => e.uuid)).toEqual(["ex2"]);
    expect(await withOrg(ex, B, (tx) => listScheduledTaskExecutions(tx, t.id))).toEqual([]);

    expect(await withOrg(ex, A, (tx) => deleteScheduledTask(tx, task("app1"), t.id))).toBe(true);
    expect(await count("scheduled_task_executions", "scheduled_task_id = $1", [t.id])).toBe(0);
    expect(await withOrg(ex, A, (tx) => findScheduledTask(tx, task("app1"), "task1"))).toBeNull();
    expect(await withOrg(ex, A, (tx) => deleteScheduledTask(tx, task("app1"), t.id))).toBe(false);
    expect((await withOrg(ex, A, (tx) => listScheduledTasks(tx, task("app1")))).map((x) => x.uuid)).toEqual(["task2"]);
  });
});

describe("the rollback setting (application_settings.docker_images_to_keep)", () => {
  it("reads the setting with the server's retention switch and timezone, and stores it", async () => {
    expect(await withOrg(ex, A, (tx) => findApplicationRollback(tx, APP1))).toMatchObject({ id: ids.app1, docker_images_to_keep: 2, disable_application_image_retention: false, server_timezone: "UTC" });
    expect(await withOrg(ex, A, (tx) => updateApplicationImagesToKeep(tx, ids.app1!, 5))).toBe(true);
    await admin("UPDATE deploy.server_settings SET disable_application_image_retention = true, server_timezone = 'Europe/Madrid' WHERE server_id = $1", [fx.a!.serverId]);
    expect(await withOrg(ex, A, (tx) => findApplicationRollback(tx, APP1))).toMatchObject({ docker_images_to_keep: 5, disable_application_image_retention: true, server_timezone: "Europe/Madrid" });
    expect((await raw("application_settings", "application_id = $1", [ids.app1]))[0]).toMatchObject({ docker_images_to_keep: 5 });
  });

  it("row-level security: another org neither reads nor writes it", async () => {
    expect(await withOrg(ex, B, (tx) => findApplicationRollback(tx, APP1))).toBeNull();
    expect(await withOrg(ex, B, (tx) => updateApplicationImagesToKeep(tx, ids.app1!, 9))).toBe(false);
    expect((await withOrg(ex, A, (tx) => findApplicationRollback(tx, APP1)))!.docker_images_to_keep).toBe(5);
    expect(await withOrg(ex, B, (tx) => findApplicationRollback(tx, APPB))).toMatchObject({ docker_images_to_keep: 2 });
  });
});
