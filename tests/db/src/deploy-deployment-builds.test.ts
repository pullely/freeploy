// What a deployment that builds reads and writes (DP-61) against a real Postgres: the store functions of
// @saas/db/deploy's deployment-builds.ts inside withOrg() — the Git and build columns of an application, the
// commit and the commit message of a deployment, the health check a Dockerfile declares, the SSH host keys git
// accepted, and which container names are deployments — and row-level security keeping each org's rows to
// itself.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  insertPrivateKey,
  insertServer,
  insertProject,
  insertDockerImageApplication,
  listServerDestinations,
  enqueueDeployment,
  updateDeploymentStatus,
  findDeploymentBuild,
  setDeploymentCommit,
  setDeploymentCommitMessage,
  reuseDeploymentCommitMessage,
  updateApplicationHealthcheck,
  mergeApplicationGitSshKnownHosts,
  findDeploymentUuidsAmong,
  APPLICATION_WEBHOOK_SECRET_COLUMNS,
  type NewDockerImageApplication,
} from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, executor } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

let db: PGlite;
let ex: TransactionalSqlExecutor;

interface Fixture {
  serverId: number;
  destinationId: string | number;
  app: number;
}
const fx: Record<string, Fixture> = {};

const secrets = (tag: string) => Object.fromEntries(APPLICATION_WEBHOOK_SECRET_COLUMNS.map((c) => [c, `fp1:${tag}:${c}`])) as NewDockerImageApplication["webhookSecrets"];

async function fixture(org: string, tag: string): Promise<Fixture> {
  return withOrg(ex, org, async (tx) => {
    const key = await insertPrivateKey(tx, { orgId: org, uuid: `key${tag}`, name: "key", description: null, privateKey: "fp1:fake", fingerprint: null });
    const server = await insertServer(tx, {
      orgId: org, uuid: `srv${tag}`, name: `server-${tag}`, description: null, ip: "203.0.113.10", user: "root", port: 22, privateKeyId: key.id,
      proxy: { type: "TRAEFIK" }, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: `dst${tag}`,
    });
    const destination = (await listServerDestinations(tx, server.id))[0]!;
    const { environment } = await insertProject(tx, { orgId: org, uuid: `prj${tag}`, name: `project-${tag}`, description: null, productionEnvironmentUuid: `env${tag}` });
    const app = await insertDockerImageApplication(tx, {
      orgId: org, uuid: `app${tag}`, name: `app-${tag}`, fqdn: `http://app${tag}.example.com`, domainPortOverrides: null, dockerRegistryImageName: "nginx", dockerRegistryImageTag: "1.27",
      environmentId: environment.id, destinationId: destination.id, destinationType: "standalone", webhookSecrets: secrets(tag),
    });
    return { serverId: Number(server.id), destinationId: destination.id, app: Number(app.id) };
  });
}

beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
  fx.a = await fixture(A, "a");
  fx.b = await fixture(B, "b");
}, 120_000);
afterAll(async () => db?.close());

beforeEach(async () => {
  await asPlatformAdmin(ex, async (tx) => {
    await tx.execute("DELETE FROM deploy.application_deployment_queues");
    await tx.execute("UPDATE deploy.applications SET git_ssh_known_hosts = NULL, health_check_enabled = false, health_check_interval = 5, health_check_timeout = 5, health_check_retries = 10, health_check_start_period = 5, custom_healthcheck_found = false");
  });
});

const admin = async (sql: string, params: unknown[] = []) => (await asPlatformAdmin(ex, (tx) => tx.execute<Record<string, unknown>>(sql, params))).rows;

let counter = 0;
async function deployment(org: string, commit = "HEAD"): Promise<{ id: string | number; uuid: string }> {
  const f = org === A ? fx.a! : fx.b!;
  const uuid = `dep${String(++counter).padStart(21, "0")}`;
  const result = await withOrg(ex, org, (tx) =>
    enqueueDeployment(tx, { orgId: org, applicationId: f.app, applicationName: "app", serverId: f.serverId, serverName: "server", destinationId: f.destinationId, deploymentUuid: uuid, deploymentUrl: `/d/${uuid}`, commit, forceRebuild: true }),
  );
  if (result.status !== "queued") throw new Error(`expected a queued deployment, got ${result.status}`);
  return { id: result.deployment.id, uuid };
}

describe("what a build reads", () => {
  it("the Git and build columns of the application and its settings, with the schema's defaults", async () => {
    const build = await withOrg(ex, A, (tx) => findDeploymentBuild(tx, fx.a!.app));
    expect(build).toMatchObject({
      git_commit_sha: "HEAD",
      base_directory: "/",
      publish_directory: null,
      dockerfile: null,
      dockerfile_location: null,
      install_command: null,
      build_command: null,
      start_command: null,
      static_image: "nginx:alpine",
      custom_nginx_configuration: null,
      private_key_id: null,
      has_git_https_credentials: false,
      is_spa: false,
      is_git_submodules_enabled: true,
      is_git_lfs_enabled: true,
      is_git_shallow_clone_enabled: true,
      disable_build_cache: false,
      inject_build_args_to_dockerfile: true,
      include_source_commit_in_build: false,
      is_build_server_enabled: false,
      is_preserve_repository_enabled: false,
      server_role: "both",
    });
    expect(Number(build!.application_id)).toBe(fx.a!.app);
  });

  it("what the pages stored: the commit, the commands, the pasted Dockerfile, a deploy key, HTTPS credentials", async () => {
    await admin(
      `UPDATE deploy.applications SET git_repository = 'acme/site', git_commit_sha = 'abc1234', base_directory = '/web', publish_directory = '/dist', dockerfile = 'FROM nginx', dockerfile_location = '/Dockerfile.prod',
              install_command = 'npm ci', build_command = 'npm run build', start_command = 'npm start', source_id = 0, source_type = 'App\\Models\\GithubApp', private_key_id = 7, git_https_username = 'deploy'
        WHERE id = $1`,
      [fx.a!.app],
    );
    await admin("UPDATE deploy.application_settings SET is_spa = true, disable_build_cache = true, include_source_commit_in_build = true, is_git_lfs_enabled = false WHERE application_id = $1", [fx.a!.app]);
    try {
      const build = await withOrg(ex, A, (tx) => findDeploymentBuild(tx, fx.a!.app));
      expect(build).toMatchObject({
        git_repository: "acme/site", git_commit_sha: "abc1234", base_directory: "/web", publish_directory: "/dist", dockerfile: "FROM nginx", dockerfile_location: "/Dockerfile.prod",
        install_command: "npm ci", build_command: "npm run build", start_command: "npm start", source_type: "App\\Models\\GithubApp", has_git_https_credentials: true,
        is_spa: true, disable_build_cache: true, include_source_commit_in_build: true, is_git_lfs_enabled: false,
      });
      expect([Number(build!.source_id), Number(build!.private_key_id)]).toEqual([0, 7]);
    } finally {
      await admin(
        "UPDATE deploy.applications SET git_commit_sha = 'HEAD', base_directory = '/', publish_directory = NULL, dockerfile = NULL, dockerfile_location = NULL, install_command = NULL, build_command = NULL, start_command = NULL, source_id = NULL, source_type = NULL, private_key_id = NULL, git_https_username = NULL WHERE id = $1",
        [fx.a!.app],
      );
      await admin("UPDATE deploy.application_settings SET is_spa = false, disable_build_cache = false, include_source_commit_in_build = false, is_git_lfs_enabled = true WHERE application_id = $1", [fx.a!.app]);
    }
  });

  it("the role of the application's server: its own, or the one the build server switch stands for", async () => {
    const role = async () => (await withOrg(ex, A, (tx) => findDeploymentBuild(tx, fx.a!.app)))!.server_role;
    try {
      await admin("UPDATE deploy.server_settings SET server_role = 'deployment' WHERE server_id = $1", [fx.a!.serverId]);
      expect(await role()).toBe("deployment");
      await admin("UPDATE deploy.server_settings SET server_role = NULL, is_build_server = true WHERE server_id = $1", [fx.a!.serverId]);
      expect(await role()).toBe("build");
      await admin("UPDATE deploy.server_settings SET is_build_server = false WHERE server_id = $1", [fx.a!.serverId]);
      expect(await role()).toBe("both");
    } finally {
      await admin("UPDATE deploy.server_settings SET server_role = 'both', is_build_server = false WHERE server_id = $1", [fx.a!.serverId]);
    }
  });

  it("which container names are deployments: a build helper is named after its deployment", async () => {
    const one = await deployment(A);
    const other = await deployment(B);
    expect(await withOrg(ex, A, (tx) => findDeploymentUuidsAmong(tx, ["postgres-db", one.uuid, other.uuid]))).toEqual([one.uuid]);
    expect(await withOrg(ex, A, (tx) => findDeploymentUuidsAmong(tx, []))).toEqual([]);
  });
});

describe("what a build writes", () => {
  const SHA = "4a3c2b1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b";

  it("the commit the branch's head resolved to", async () => {
    const d = await deployment(A);
    await withOrg(ex, A, (tx) => setDeploymentCommit(tx, d.id, SHA));
    expect((await admin('SELECT "commit" FROM deploy.application_deployment_queues WHERE id = $1', [d.id]))[0]!.commit).toBe(SHA);
  });

  it("the commit's message, on every deployment of the application of that commit that was not skipped", async () => {
    const first = await deployment(A, SHA);
    const skipped = await deployment(A, SHA);
    const otherCommit = await deployment(A, "HEAD");
    const now = await deployment(A, SHA);
    await withOrg(ex, A, async (tx) => {
      await updateDeploymentStatus(tx, first.id, "finished");
      await updateDeploymentStatus(tx, skipped.id, "skipped");
      await setDeploymentCommitMessage(tx, fx.a!.app, SHA, "feat: the new thing");
    });
    const rows = await admin("SELECT id, commit_message FROM deploy.application_deployment_queues ORDER BY id");
    expect(rows.map((r) => r.commit_message)).toEqual(["feat: the new thing", null, null, "feat: the new thing"]);
    expect(rows.map((r) => String(r.id))).toEqual([first.id, skipped.id, otherCommit.id, now.id].map(String));
  });

  it("reuse_commit_message(): the newest message an earlier deployment of the commit stored, when this one has none", async () => {
    const old = await deployment(A, SHA);
    const newer = await deployment(A, SHA);
    const skipped = await deployment(A, SHA);
    const now = await deployment(A, SHA);
    await admin("UPDATE deploy.application_deployment_queues SET commit_message = 'old' WHERE id = $1", [old.id]);
    await admin("UPDATE deploy.application_deployment_queues SET commit_message = 'newer' WHERE id = $1", [newer.id]);
    await admin("UPDATE deploy.application_deployment_queues SET commit_message = 'from a skipped one', status = 'skipped' WHERE id = $1", [skipped.id]);
    expect(await withOrg(ex, A, (tx) => reuseDeploymentCommitMessage(tx, now.id, fx.a!.app, SHA))).toBe(true);
    expect((await admin("SELECT commit_message FROM deploy.application_deployment_queues WHERE id = $1", [now.id]))[0]!.commit_message).toBe("newer");
    // A deployment that has a message keeps it, and a commit nobody deployed gives none.
    await admin("UPDATE deploy.application_deployment_queues SET commit_message = 'changed' WHERE id = $1", [newer.id]);
    expect(await withOrg(ex, A, (tx) => reuseDeploymentCommitMessage(tx, now.id, fx.a!.app, SHA))).toBe(false);
    const fresh = await deployment(A, "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c");
    expect(await withOrg(ex, A, (tx) => reuseDeploymentCommitMessage(tx, fresh.id, fx.a!.app, "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"))).toBe(false);
  });

  it("the health check a Dockerfile declares: only the columns that are given", async () => {
    expect(await withOrg(ex, A, (tx) => updateApplicationHealthcheck(tx, fx.a!.app, { health_check_interval: 15, health_check_timeout: 3, health_check_retries: 4, health_check_start_period: 20, custom_healthcheck_found: true }))).toBe(true);
    const select = "SELECT health_check_enabled, health_check_interval, health_check_timeout, health_check_retries, health_check_start_period, custom_healthcheck_found FROM deploy.applications WHERE id = $1";
    expect((await admin(select, [fx.a!.app]))[0]).toEqual({ health_check_enabled: false, health_check_interval: 15, health_check_timeout: 3, health_check_retries: 4, health_check_start_period: 20, custom_healthcheck_found: true });
    expect(await withOrg(ex, A, (tx) => updateApplicationHealthcheck(tx, fx.a!.app, {}))).toBe(true);
    await withOrg(ex, A, (tx) => updateApplicationHealthcheck(tx, fx.a!.app, { health_check_enabled: true }));
    expect((await admin(select, [fx.a!.app]))[0]).toMatchObject({ health_check_enabled: true, health_check_interval: 15, custom_healthcheck_found: true });
  });

  it("the SSH host keys git accepted: merged with what is stored, and written only when that changes", async () => {
    const line = "git.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
    const seen: Array<string | null> = [];
    const merge = (add: string) => (stored: string | null) => {
      seen.push(stored);
      const lines = stored === null || stored === "" ? [] : stored.split("\n");
      const changed = !lines.includes(add);
      return { knownHosts: [...lines, ...(changed ? [add] : [])].join("\n"), changed };
    };
    expect(await withOrg(ex, A, (tx) => mergeApplicationGitSshKnownHosts(tx, fx.a!.app, merge(line)))).toEqual({ knownHosts: line, changed: true });
    expect(await withOrg(ex, A, (tx) => mergeApplicationGitSshKnownHosts(tx, fx.a!.app, merge(line)))).toEqual({ knownHosts: line, changed: false });
    expect(await withOrg(ex, A, (tx) => mergeApplicationGitSshKnownHosts(tx, fx.a!.app, merge("other.example.com ssh-rsa AAAAB3NzaC1yc2E=")))).toEqual({ knownHosts: `${line}\nother.example.com ssh-rsa AAAAB3NzaC1yc2E=`, changed: true });
    expect(seen).toEqual([null, line, line]);
    expect((await admin("SELECT git_ssh_known_hosts FROM deploy.applications WHERE id = $1", [fx.a!.app]))[0]!.git_ssh_known_hosts).toBe(`${line}\nother.example.com ssh-rsa AAAAB3NzaC1yc2E=`);
  });
});

describe("row-level security", () => {
  it("keeps each org's applications and deployments to itself", async () => {
    const d = await deployment(A, "HEAD");
    // Another org reads nothing of the application, and its writes change nothing.
    expect(await withOrg(ex, B, (tx) => findDeploymentBuild(tx, fx.a!.app))).toBeNull();
    expect(await withOrg(ex, B, (tx) => updateApplicationHealthcheck(tx, fx.a!.app, { health_check_interval: 99 }))).toBe(false);
    expect(await withOrg(ex, B, (tx) => mergeApplicationGitSshKnownHosts(tx, fx.a!.app, () => ({ knownHosts: "x", changed: true })))).toBeNull();
    await withOrg(ex, B, async (tx) => {
      await setDeploymentCommit(tx, d.id, "stolen");
      await setDeploymentCommitMessage(tx, fx.a!.app, "HEAD", "stolen");
    });
    expect(await withOrg(ex, B, (tx) => reuseDeploymentCommitMessage(tx, d.id, fx.a!.app, "HEAD"))).toBe(false);
    expect(await withOrg(ex, B, (tx) => findDeploymentUuidsAmong(tx, [d.uuid]))).toEqual([]);
    expect((await admin('SELECT "commit", commit_message FROM deploy.application_deployment_queues WHERE id = $1', [d.id]))[0]).toEqual({ commit: "HEAD", commit_message: null });
    expect((await admin("SELECT health_check_interval, git_ssh_known_hosts FROM deploy.applications WHERE id = $1", [fx.a!.app]))[0]).toEqual({ health_check_interval: 5, git_ssh_known_hosts: null });
  });
});
