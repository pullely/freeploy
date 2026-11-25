// deploy.application_deployment_queues (DP-56) against a real Postgres: the store functions of
// @saas/db/deploy inside withOrg() — Coolify's admission rules (the queue limit, "already queued", one
// deployment of an application at a time, the server's concurrent builds), starting what waits, the log, the
// status updates the job makes, the history list with its search and filters, what the job reads of an
// application — and row-level security keeping each org's deployments to itself.
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
  enqueueDeployment,
  nextQueuable,
  activeBuildsOnServer,
  startQueuedDeployment,
  startNextQueuedDeployments,
  failUnattendedDeployment,
  markDeploymentInProgress,
  markDeployStarted,
  setDeploymentFinishedAt,
  updateDeploymentStatus,
  deploymentStatus,
  appendDeploymentLog,
  decodeDeploymentLogs,
  findDeploymentByUuid,
  findDeploymentForJob,
  findRunningDeploymentUrl,
  listDeployments,
  deploymentFilterOptions,
  findDeploymentApplicationByUuid,
  findDeploymentApplicationById,
  listApplicationPersistentStorages,
  listApplicationFileStorages,
  updateApplicationDeploymentState,
  rememberServerDockerVersion,
  setApplicationDebugEnabled,
  findServerSshConnection,
  APPLICATION_WEBHOOK_SECRET_COLUMNS,
  type EnqueueResult,
  type NewDeployment,
  type NewDeploymentLogEntry,
  type NewDockerImageApplication,
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
  serverId: number;
  destinationId: string | number;
  environmentId: string | number;
  /** Two applications on the server. */
  app1: number;
  app2: number;
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
    const app = (uuid: string) =>
      insertDockerImageApplication(tx, {
        orgId: org, uuid, name: `docker-image-${uuid}`, fqdn: `http://${uuid}.example.com`, domainPortOverrides: null, dockerRegistryImageName: "nginx", dockerRegistryImageTag: "1.27",
        environmentId: environment.id, destinationId: destination.id, destinationType: "standalone", webhookSecrets: secrets(uuid),
      });
    const app1 = await app(`app1${tag}`);
    const app2 = await app(`app2${tag}`);
    return { serverId: Number(server.id), destinationId: destination.id, environmentId: environment.id, app1: Number(app1.id), app2: Number(app2.id) };
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

/** Each test starts from an empty queue and the server settings' defaults. */
beforeEach(async () => {
  await asPlatformAdmin(ex, async (tx) => {
    await tx.execute("DELETE FROM deploy.application_deployment_queues");
    await tx.execute("UPDATE deploy.server_settings SET concurrent_builds = 2, deployment_queue_limit = 25");
  });
});

const raw = async (where: string, params: unknown[] = []) =>
  (await asPlatformAdmin(ex, (tx) => tx.execute<Record<string, unknown>>(`SELECT * FROM deploy.application_deployment_queues WHERE ${where} ORDER BY id`, params))).rows;

let counter = 0;
const deployment = (org: string, applicationId: number, over: Partial<NewDeployment> = {}): NewDeployment => {
  const f = org === A ? fx.a! : fx.b!;
  const uuid = over.deploymentUuid ?? `dep${String(++counter).padStart(21, "0")}`;
  return {
    orgId: org,
    applicationId,
    applicationName: "docker-image-app",
    serverId: f.serverId,
    serverName: "server-a",
    destinationId: f.destinationId,
    deploymentUuid: uuid,
    deploymentUrl: `/project/prja/environment/enva/application/app1a/deployment/${uuid}`,
    commit: "HEAD",
    ...over,
  };
};
const enqueue = (org: string, applicationId: number, over: Partial<NewDeployment> = {}): Promise<EnqueueResult> => withOrg(ex, org, (tx) => enqueueDeployment(tx, deployment(org, applicationId, over)));
const queued = (result: EnqueueResult) => {
  if (result.status !== "queued") throw new Error(`expected a queued deployment, got ${result.status}`);
  return result;
};

describe("queue_application_deployment(): admission", () => {
  it("stores the deployment as Coolify does, column by column, and starts it on an idle server", async () => {
    const result = queued(await enqueue(A, fx.a!.app1, { deploymentUuid: "depfirst0000000000000001", forceRebuild: true }));
    expect(result.started).toBe(true);
    expect(result.deployment).toMatchObject({ deployment_uuid: "depfirst0000000000000001", status: "in_progress", commit: "HEAD", force_rebuild: true, restart_only: false, rollback: false });

    const [stored] = await raw("deployment_uuid = $1", ["depfirst0000000000000001"]);
    expect(stored).toMatchObject({
      // A varchar column in Coolify's schema.
      application_id: String(fx.a!.app1),
      application_name: "docker-image-app",
      server_id: fx.a!.serverId,
      server_name: "server-a",
      destination_id: String(fx.a!.destinationId),
      deployment_url: "/project/prja/environment/enva/application/app1a/deployment/depfirst0000000000000001",
      pull_request_id: 0,
      docker_registry_image_tag: null,
      force_rebuild: true,
      is_webhook: false,
      is_api: false,
      is_mcp: false,
      restart_only: false,
      commit: "HEAD",
      rollback: false,
      git_type: null,
      only_this_server: false,
      status: "in_progress",
      logs: null,
      build_server_id: null,
      finished_at: null,
      deploy_started_at: null,
      org_id: A,
    });
    expect(stored!.created_at).not.toBeNull();
    expect(stored!.updated_at).not.toBeNull();
  });

  it("queues a second deployment of the application behind the one that runs", async () => {
    expect(queued(await enqueue(A, fx.a!.app1)).started).toBe(true);
    const second = queued(await enqueue(A, fx.a!.app1, { commit: "other" }));
    expect(second.started).toBe(false);
    expect(second.deployment.status).toBe("queued");
  });

  it("skips a commit that is already queued or in progress — unless forced, a rollback, or no questions asked", async () => {
    const first = queued(await enqueue(A, fx.a!.app1, { deploymentUuid: "depsame00000000000000001" }));
    expect(first.started).toBe(true);
    expect(await enqueue(A, fx.a!.app1)).toEqual({ status: "skipped", deploymentUuid: "depsame00000000000000001" });
    // Another commit, another image tag, another application: not the same deployment.
    expect((await enqueue(A, fx.a!.app1, { commit: "abc1234" })).status).toBe("queued");
    expect((await enqueue(A, fx.a!.app1, { dockerRegistryImageTag: "pr-1" })).status).toBe("queued");
    expect((await enqueue(A, fx.a!.app2)).status).toBe("queued");
    // … and the three ways past the check.
    expect((await enqueue(A, fx.a!.app1, { forceRebuild: true })).status).toBe("queued");
    expect((await enqueue(A, fx.a!.app1, { rollback: true })).status).toBe("queued");
    const pushed = queued(await enqueue(A, fx.a!.app1, { noQuestionsAsked: true }));
    // No questions asked also starts it, whatever runs.
    expect(pushed.started).toBe(true);
    expect((await raw("status = 'in_progress'")).length).toBe(3);
  });

  it("a finished deployment of the same commit is no reason to skip", async () => {
    const first = queued(await enqueue(A, fx.a!.app1));
    await withOrg(ex, A, (tx) => updateDeploymentStatus(tx, first.deployment.id, "finished"));
    expect(queued(await enqueue(A, fx.a!.app1)).started).toBe(true);
  });

  it("refuses a deployment when the server's queue is full (server_settings.deployment_queue_limit)", async () => {
    await asPlatformAdmin(ex, (tx) => tx.execute("UPDATE deploy.server_settings SET deployment_queue_limit = 2 WHERE server_id = $1", [fx.a!.serverId]));
    queued(await enqueue(A, fx.a!.app1)); // runs
    queued(await enqueue(A, fx.a!.app1, { commit: "c1" })); // queued 1
    queued(await enqueue(A, fx.a!.app1, { commit: "c2" })); // queued 2
    expect(await enqueue(A, fx.a!.app1, { commit: "c3" })).toEqual({ status: "queue_full" });
    expect(await enqueue(A, fx.a!.app2)).toEqual({ status: "queue_full" });
    expect((await raw("true")).length).toBe(3);
  });

  it("runs as many deployments at once on a server as its concurrent builds allow", async () => {
    await asPlatformAdmin(ex, (tx) => tx.execute("UPDATE deploy.server_settings SET concurrent_builds = 1 WHERE server_id = $1", [fx.a!.serverId]));
    expect(queued(await enqueue(A, fx.a!.app1)).started).toBe(true);
    const waiting = queued(await enqueue(A, fx.a!.app2));
    expect(waiting.started).toBe(false);
    expect(await withOrg(ex, A, (tx) => activeBuildsOnServer(tx, fx.a!.serverId))).toBe(1);
    expect(await withOrg(ex, A, (tx) => nextQueuable(tx, waiting.deployment))).toBe(false);
    await asPlatformAdmin(ex, (tx) => tx.execute("UPDATE deploy.server_settings SET concurrent_builds = 2 WHERE server_id = $1", [fx.a!.serverId]));
    expect(await withOrg(ex, A, (tx) => nextQueuable(tx, waiting.deployment))).toBe(true);
  });

  it("a deployment of an application that is gone, or on a server that is gone, cannot start", async () => {
    expect(await withOrg(ex, A, (tx) => nextQueuable(tx, { application_id: "999999", pull_request_id: 0, server_id: fx.a!.serverId }))).toBe(false);
    expect(await withOrg(ex, A, (tx) => nextQueuable(tx, { application_id: String(fx.a!.app1), pull_request_id: 0, server_id: 999999 }))).toBe(false);
    expect(await withOrg(ex, A, (tx) => nextQueuable(tx, { application_id: String(fx.a!.app1), pull_request_id: 0, server_id: null }))).toBe(false);
  });
});

describe("starting what waits", () => {
  it("start_queued_deployment(): only a queued deployment that may run; force skips the limits, not the queued check", async () => {
    const running = queued(await enqueue(A, fx.a!.app1));
    const waiting = queued(await enqueue(A, fx.a!.app1, { commit: "next" }));
    expect(await withOrg(ex, A, (tx) => startQueuedDeployment(tx, waiting.deployment.id))).toBe(false);
    expect(await withOrg(ex, A, (tx) => startQueuedDeployment(tx, waiting.deployment.id, true))).toBe(true);
    // A repeated force start never runs the same deployment twice.
    expect(await withOrg(ex, A, (tx) => startQueuedDeployment(tx, waiting.deployment.id, true))).toBe(false);
    expect(await withOrg(ex, A, (tx) => startQueuedDeployment(tx, running.deployment.id, true))).toBe(false);
    expect(await withOrg(ex, A, (tx) => startQueuedDeployment(tx, 999999, true))).toBe(false);
  });

  it("start_next_queued_deployments(): the oldest first, one an application, within the server's limit", async () => {
    const first = queued(await enqueue(A, fx.a!.app1));
    const second = queued(await enqueue(A, fx.a!.app1, { commit: "second" }));
    const third = queued(await enqueue(A, fx.a!.app1, { commit: "third" }));
    expect([second.started, third.started]).toEqual([false, false]);
    // Nothing can start while the first runs.
    expect(await withOrg(ex, A, (tx) => startNextQueuedDeployments(tx, fx.a!.app1, fx.a!.serverId))).toEqual([]);
    await withOrg(ex, A, (tx) => updateDeploymentStatus(tx, first.deployment.id, "finished"));
    const started = await withOrg(ex, A, (tx) => startNextQueuedDeployments(tx, fx.a!.app1, fx.a!.serverId));
    expect(started.map((d) => d.deployment_uuid)).toEqual([second.deployment.deployment_uuid]);
    expect(started[0]!.status).toBe("in_progress");
    expect(await withOrg(ex, A, (tx) => deploymentStatus(tx, third.deployment.id))).toBe("queued");
  });

  it("a deployment that ends frees its slot for another application's deployment on that server", async () => {
    await asPlatformAdmin(ex, (tx) => tx.execute("UPDATE deploy.server_settings SET concurrent_builds = 1 WHERE server_id = $1", [fx.a!.serverId]));
    const first = queued(await enqueue(A, fx.a!.app1));
    const other = queued(await enqueue(A, fx.a!.app2));
    expect(other.started).toBe(false);
    await withOrg(ex, A, (tx) => updateDeploymentStatus(tx, first.deployment.id, "failed"));
    const started = await withOrg(ex, A, (tx) => startNextQueuedDeployments(tx, fx.a!.app1, fx.a!.serverId));
    expect(started.map((d) => d.deployment_uuid)).toEqual([other.deployment.deployment_uuid]);
  });

  it("fail_unattended_deployment(): only what is in progress", async () => {
    const running = queued(await enqueue(A, fx.a!.app1));
    const waiting = queued(await enqueue(A, fx.a!.app1, { commit: "next" }));
    expect(await withOrg(ex, A, (tx) => failUnattendedDeployment(tx, waiting.deployment.id))).toBe(false);
    expect(await withOrg(ex, A, (tx) => failUnattendedDeployment(tx, running.deployment.id))).toBe(true);
    expect(await withOrg(ex, A, (tx) => failUnattendedDeployment(tx, running.deployment.id))).toBe(false);
    const [row] = await raw("id = $1", [running.deployment.id]);
    expect(row).toMatchObject({ status: "failed" });
    expect(row!.finished_at).not.toBeNull();
  });
});

describe("what the job writes", () => {
  it("the status: a final one stamps finished_at once; in progress does not overwrite a cancel", async () => {
    const d = queued(await enqueue(A, fx.a!.app1)).deployment;
    expect(await withOrg(ex, A, (tx) => markDeploymentInProgress(tx, d.id, "worker-1"))).toBe("in_progress");
    expect((await raw("id = $1", [d.id]))[0]).toMatchObject({ horizon_job_worker: "worker-1", finished_at: null });

    await withOrg(ex, A, (tx) => markDeployStarted(tx, d.id));
    const started = (await raw("id = $1", [d.id]))[0]!.deploy_started_at;
    expect(started).not.toBeNull();

    const cancelled = await withOrg(ex, A, (tx) => updateDeploymentStatus(tx, d.id, "cancelled-by-user"));
    expect(cancelled).toMatchObject({ status: "cancelled-by-user" });
    expect(cancelled!.finished_at).not.toBeNull();
    // The conditional update of handle(): the cancel stays.
    expect(await withOrg(ex, A, (tx) => markDeploymentInProgress(tx, d.id, "worker-2"))).toBe("cancelled-by-user");
    expect(await withOrg(ex, A, (tx) => deploymentStatus(tx, d.id))).toBe("cancelled-by-user");
    expect(await withOrg(ex, A, (tx) => deploymentStatus(tx, 999999))).toBeNull();
    expect(await withOrg(ex, A, (tx) => updateDeploymentStatus(tx, 999999, "failed"))).toBeNull();
  });

  it("deploy_started_at is set once, and only for a deployment in progress", async () => {
    const running = queued(await enqueue(A, fx.a!.app1)).deployment;
    const waiting = queued(await enqueue(A, fx.a!.app1, { commit: "next" })).deployment;
    await withOrg(ex, A, (tx) => markDeployStarted(tx, waiting.id));
    expect((await raw("id = $1", [waiting.id]))[0]!.deploy_started_at).toBeNull();
    await withOrg(ex, A, (tx) => markDeployStarted(tx, running.id));
    await withOrg(ex, A, (tx) => setDeploymentFinishedAt(tx, running.id));
    const row = (await raw("id = $1", [running.id]))[0]!;
    expect(row.deploy_started_at).not.toBeNull();
    expect(row.finished_at).not.toBeNull();
  });

  it("the log: entries in Coolify's stored format, numbered in order; the hint follows once", async () => {
    const d = queued(await enqueue(A, fx.a!.app1)).deployment;
    const entry = (output: string, over: Partial<NewDeploymentLogEntry> = {}): NewDeploymentLogEntry => ({ command: null, output, type: "stdout", timestamp: "2026-11-20T10:11:12.000000Z", hidden: false, batch: 1, ...over });
    const hint = entry("Some environment variable values are hidden in this log.");
    expect(await withOrg(ex, A, (tx) => appendDeploymentLog(tx, d.id, entry("first")))).toBe(true);
    expect(await withOrg(ex, A, (tx) => appendDeploymentLog(tx, d.id, entry("token <REDACTED>", { command: "docker pull x", hidden: true, batch: 4 }), hint))).toBe(true);
    // A second hint is not added: the log has one.
    expect(await withOrg(ex, A, (tx) => appendDeploymentLog(tx, d.id, entry("again <REDACTED>", { type: "stderr" }), hint))).toBe(true);

    const stored = await withOrg(ex, A, (tx) => findDeploymentByUuid(tx, fx.a!.app1, d.deployment_uuid));
    expect(JSON.parse(stored!.logs!)).toEqual([
      { command: null, output: "first", type: "stdout", timestamp: "2026-11-20T10:11:12.000000Z", hidden: false, batch: 1, order: 1 },
      { command: "docker pull x", output: "token <REDACTED>", type: "stdout", timestamp: "2026-11-20T10:11:12.000000Z", hidden: true, batch: 4, order: 2 },
      { command: null, output: "Some environment variable values are hidden in this log.", type: "stdout", timestamp: "2026-11-20T10:11:12.000000Z", hidden: false, batch: 1, order: 3 },
      { command: null, output: "again <REDACTED>", type: "stderr", timestamp: "2026-11-20T10:11:12.000000Z", hidden: false, batch: 1, order: 4 },
    ]);
    expect(decodeDeploymentLogs(stored!.logs)!.map((e) => e.order)).toEqual([1, 2, 3, 4]);
    expect(await withOrg(ex, A, (tx) => appendDeploymentLog(tx, 999999, entry("x")))).toBe(false);
  });

  it("a stored log that cannot be decoded is kept: the entry is dropped", async () => {
    const d = queued(await enqueue(A, fx.a!.app1)).deployment;
    await asPlatformAdmin(ex, (tx) => tx.execute("UPDATE deploy.application_deployment_queues SET logs = $2 WHERE id = $1", [d.id, "{not json"]));
    expect(await withOrg(ex, A, (tx) => appendDeploymentLog(tx, d.id, { command: null, output: "x", type: "stdout", timestamp: "t", hidden: false, batch: 1 }))).toBe(false);
    expect((await raw("id = $1", [d.id]))[0]!.logs).toBe("{not json");
    expect(decodeDeploymentLogs("{not json")).toBeNull();
    expect(decodeDeploymentLogs(null)).toEqual([]);
    expect(decodeDeploymentLogs("  ")).toEqual([]);
    expect(decodeDeploymentLogs('"text"')).toBeNull();
  });

  it("the application: its status and restart counters; the server: the Docker version it answered with", async () => {
    await withOrg(ex, A, (tx) => updateApplicationDeploymentState(tx, fx.a!.app1, { status: "running:unhealthy" }));
    await withOrg(ex, A, (tx) => updateApplicationDeploymentState(tx, fx.a!.app1, { restart_count: 0, last_restart_at: null, last_restart_type: null, restart_limit_reached: false }));
    await withOrg(ex, A, (tx) => rememberServerDockerVersion(tx, fx.a!.serverId, "27.0.3"));
    await withOrg(ex, A, (tx) => setApplicationDebugEnabled(tx, fx.a!.app1, true));
    const app = await withOrg(ex, A, (tx) => findDeploymentApplicationById(tx, fx.a!.app1));
    expect(app).toMatchObject({ status: "running:unhealthy", server_docker_version: "27.0.3", is_debug_enabled: true });
    expect(await withOrg(ex, A, (tx) => updateApplicationDeploymentState(tx, 999999, { status: "x" }))).toBe(false);
    await withOrg(ex, A, (tx) => updateApplicationDeploymentState(tx, fx.a!.app1, { status: "exited" }));
    await withOrg(ex, A, (tx) => setApplicationDebugEnabled(tx, fx.a!.app1, false));
  });
});

describe("what the job reads", () => {
  it("the application with its settings, destination, server, environment and project", async () => {
    const app = await withOrg(ex, A, (tx) => findDeploymentApplicationByUuid(tx, "app1a"));
    expect(app).toMatchObject({
      uuid: "app1a",
      name: "docker-image-app1a",
      build_pack: "dockerimage",
      status: "exited",
      fqdn: "http://app1a.example.com",
      git_branch: "main",
      has_dockerfile: false,
      docker_registry_image_name: "nginx",
      docker_registry_image_tag: "1.27",
      ports_exposes: "80",
      ports_mappings: null,
      custom_labels: null,
      health_check_enabled: false,
      health_check_type: "http",
      health_check_method: "GET",
      health_check_scheme: "http",
      health_check_host: "localhost",
      health_check_path: "/",
      health_check_return_code: 200,
      health_check_interval: 5,
      health_check_timeout: 5,
      health_check_retries: 10,
      health_check_start_period: 5,
      limits_cpus: "0",
      limits_cpuset: null,
      limits_cpu_shares: 1024,
      limits_memory: "0",
      limits_memory_swappiness: 60,
      compose_parsing_version: "5",
      redirect: "both",
      // application_settings' defaults.
      is_static: false,
      is_container_label_readonly_enabled: true,
      is_container_label_escape_enabled: true,
      is_consistent_container_name_enabled: false,
      stop_grace_period: null,
      rolling_update_drain_seconds: 5,
      is_gpu_enabled: false,
      is_env_sorting_enabled: false,
      include_coolify_default_variables: true,
      redact_all_env_values_in_logs: true,
      use_build_secrets: false,
      include_network_hosts_in_build: true,
      is_debug_enabled: false,
      environment_uuid: "enva",
      environment_name: "production",
      project_uuid: "prja",
      project_name: "project-a",
      destination_network: "coolify",
      server_uuid: "srva",
      server_name: "server-a",
      server_ip: "203.0.113.10",
      server_user: "root",
      server_port: 22,
      server_is_reachable: false,
      server_is_usable: false,
      server_force_disabled: false,
      server_timezone: "UTC",
      is_logdrain_axiom_enabled: false,
      is_logdrain_cloudwatch_enabled: false,
    });
    expect(Number(app!.id)).toBe(fx.a!.app1);
    expect(Number(app!.server_id)).toBe(fx.a!.serverId);
    expect(await withOrg(ex, A, (tx) => findDeploymentApplicationById(tx, "not-a-number"))).toBeNull();
    expect(await withOrg(ex, A, (tx) => findDeploymentApplicationByUuid(tx, "nope"))).toBeNull();
  });

  it("its storages", async () => {
    await withOrg(ex, A, async (tx) => {
      await tx.execute("INSERT INTO deploy.local_persistent_volumes (name, mount_path, host_path, resource_id, resource_type, org_id) VALUES ('data', '/data', NULL, $1, $2, $3), ('cfg', '/etc/app', '/srv/cfg', $1, $2, $3)", [fx.a!.app1, "App\\Models\\Application", A]);
      await tx.execute("INSERT INTO deploy.local_file_volumes (uuid, fs_path, mount_path, content, is_directory, resource_id, resource_type, org_id) VALUES ('vol1', '/data/x/app.conf', '/etc/app.conf', 'a=b', false, $1, $2, $3), ('vol2', '/data/x/uploads', '/uploads', NULL, true, $1, $2, $3)", [fx.a!.app1, "App\\Models\\Application", A]);
    });
    expect((await withOrg(ex, A, (tx) => listApplicationPersistentStorages(tx, fx.a!.app1))).map((s) => [s.name, s.mount_path, s.host_path])).toEqual([["data", "/data", null], ["cfg", "/etc/app", "/srv/cfg"]]);
    expect((await withOrg(ex, A, (tx) => listApplicationFileStorages(tx, fx.a!.app1))).map((s) => [s.fs_path, s.mount_path, s.is_directory, s.has_content])).toEqual([
      ["/data/x/app.conf", "/etc/app.conf", false, true],
      ["/data/x/uploads", "/uploads", true, false],
    ]);
    expect(await withOrg(ex, A, (tx) => listApplicationPersistentStorages(tx, fx.a!.app2))).toEqual([]);
  });

  it("the server as the SSH executor connects to it", async () => {
    expect(await withOrg(ex, A, (tx) => findServerSshConnection(tx, fx.a!.serverId))).toMatchObject({ uuid: "srva", ip: "203.0.113.10", port: 22, user: "root", private_key: "fp1:fake", ssh_host_key: null });
    expect(await withOrg(ex, A, (tx) => findServerSshConnection(tx, 999999))).toBeNull();
  });
});

describe("the history (Application::deployments)", () => {
  /** Seven deployments of app1, a minute apart, oldest first: d1 … d7. */
  async function history(): Promise<void> {
    await asPlatformAdmin(ex, async (tx) => {
      const rows: Array<[string, string, string, Record<string, unknown>]> = [
        ["d1", "finished", "aaa1111", {}],
        ["d2", "failed", "bbb2222", { commit_message: "Fix the login form\n\nlong text" }],
        ["d3", "finished", "ccc3333", { is_webhook: true }],
        ["d4", "cancelled-by-user", "ddd4444", { rollback: true }],
        ["d5", "finished", "eee5555", { is_api: true }],
        ["d6", "queued", "fff6666", { pull_request_id: 12 }],
        ["d7", "in_progress", "HEAD", { is_mcp: true, server_id: 999, server_name: "other-server" }],
      ];
      for (const [index, [uuid, status, commit, over]] of rows.entries()) {
        const row = { application_id: String(fx.a!.app1), deployment_uuid: uuid, status, commit, server_id: fx.a!.serverId, server_name: "server-a", deployment_url: `/d/${uuid}`, org_id: A, ...over };
        const columns = Object.keys(row);
        await tx.execute(
          `INSERT INTO deploy.application_deployment_queues (${columns.map((c) => `"${c}"`).join(", ")}, created_at, updated_at) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}, TIMESTAMP '2026-11-20 10:00:00' + $${columns.length + 1} * INTERVAL '1 minute', TIMESTAMP '2026-11-20 10:00:00')`,
          [...Object.values(row), index],
        );
      }
      await tx.execute("INSERT INTO deploy.application_deployment_queues (application_id, deployment_uuid, status, org_id) VALUES ($1, 'other-app', 'finished', $2)", [String(fx.a!.app2), A]);
    });
  }
  const list = async (options: Parameters<typeof listDeployments>[2] = {}) => {
    const page = await withOrg(ex, A, (tx) => listDeployments(tx, fx.a!.app1, options));
    return { count: page.count, uuids: page.deployments.map((d) => d.deployment_uuid) };
  };

  it("pages newest first, ten at a time, and counts all that match", async () => {
    await history();
    expect(await list()).toEqual({ count: 7, uuids: ["d7", "d6", "d5", "d4", "d3", "d2", "d1"] });
    expect(await list({ take: 3 })).toEqual({ count: 7, uuids: ["d7", "d6", "d5"] });
    expect(await list({ take: 3, skip: 3 })).toEqual({ count: 7, uuids: ["d4", "d3", "d2"] });
    expect(await list({ take: 3, skip: 6 })).toEqual({ count: 7, uuids: ["d1"] });
    expect(await list({ sort: "oldest", take: 2 })).toEqual({ count: 7, uuids: ["d1", "d2"] });
    // The page size is held between 1 and 100.
    expect((await list({ take: 0 })).uuids).toEqual(["d7"]);
    expect((await list({ take: 1000 })).uuids.length).toBe(7);
  });

  it("never loads the log", async () => {
    await history();
    const page = await withOrg(ex, A, (tx) => listDeployments(tx, fx.a!.app1));
    expect(Object.keys(page.deployments[0]!).sort()).toEqual(
      ["application_id", "commit", "commit_message", "created_at", "deployment_uuid", "finished_at", "id", "is_api", "is_mcp", "is_webhook", "pull_request_id", "rollback", "server_id", "server_name", "status", "updated_at"].sort(),
    );
  });

  it("filters by pull request, status, source and server", async () => {
    await history();
    expect((await list({ pullRequestId: "12" })).uuids).toEqual(["d6"]);
    // "0" is no pull request filter (PHP's truthiness).
    expect((await list({ pullRequestId: "0" })).count).toBe(7);
    expect((await list({ filters: ["status:finished"] })).uuids).toEqual(["d5", "d3", "d1"]);
    expect((await list({ filters: ["status:finished", "status:failed"] })).uuids).toEqual(["d5", "d3", "d2", "d1"]);
    expect((await list({ filters: ["source:webhook"] })).uuids).toEqual(["d3"]);
    expect((await list({ filters: ["source:rollback"] })).uuids).toEqual(["d4"]);
    expect((await list({ filters: ["source:api"] })).uuids).toEqual(["d5"]);
    expect((await list({ filters: ["source:mcp"] })).uuids).toEqual(["d7"]);
    expect((await list({ filters: ["source:pull-request"] })).uuids).toEqual(["d6"]);
    expect((await list({ filters: ["source:manual"] })).uuids).toEqual(["d2", "d1"]);
    expect((await list({ filters: ["source:manual", "source:api"] })).uuids).toEqual(["d5", "d2", "d1"]);
    // An unknown source matches nothing.
    expect((await list({ filters: ["source:nope"] })).count).toBe(0);
    expect((await list({ filters: ["server:999"] })).uuids).toEqual(["d7"]);
    expect((await list({ filters: ["server:abc"] })).count).toBe(7);
    // Different kinds of filter narrow each other.
    expect((await list({ filters: ["status:finished", "source:manual"] })).uuids).toEqual(["d1"]);
  });

  it("searches the uuid, commit, commit message, server and status, and the words Coolify knows", async () => {
    await history();
    expect((await list({ search: "ccc" })).uuids).toEqual(["d3"]);
    expect((await list({ search: "LOGIN form" })).uuids).toEqual(["d2"]);
    expect((await list({ search: "other-server" })).uuids).toEqual(["d7"]);
    expect((await list({ search: " success " })).uuids).toEqual(["d5", "d3", "d1"]);
    expect((await list({ search: "In Progress" })).uuids).toEqual(["d7"]);
    expect((await list({ search: "cancelled" })).uuids).toEqual(["d4"]);
    expect((await list({ search: "pr" })).uuids).toEqual(["d7", "d6"]); // "in_progress" has "pr" in it too
    expect((await list({ search: "12" })).uuids).toEqual(["d6"]);
    expect((await list({ search: "webhooks" })).uuids).toEqual(["d3"]);
    expect((await list({ search: "manual" })).uuids).toEqual(["d2", "d1"]);
    // LIKE's wildcards are ordinary characters.
    expect((await list({ search: "%" })).count).toBe(0);
    expect((await list({ search: "d_" })).count).toBe(0);
  });

  it("offers the filters the application's deployments have", async () => {
    await history();
    const options = await withOrg(ex, A, (tx) => deploymentFilterOptions(tx, fx.a!.app1));
    expect([...options.statuses].sort()).toEqual(["cancelled-by-user", "failed", "finished", "in_progress", "queued"]);
    expect([...options.sources].sort()).toEqual(["api", "manual", "mcp", "pull-request", "rollback", "webhook"]);
    expect(options.servers).toEqual([{ id: 999, name: "other-server" }, { id: fx.a!.serverId, name: "server-a" }]);
    expect(options.pullRequestIds).toEqual([12]);
    expect(await withOrg(ex, A, (tx) => deploymentFilterOptions(tx, fx.a!.app2))).toEqual({ statuses: ["finished"], sources: ["manual"], servers: [], pullRequestIds: [] });
  });

  it("finds one deployment of the application with its log, and the one that runs", async () => {
    await history();
    expect(await withOrg(ex, A, (tx) => findDeploymentByUuid(tx, fx.a!.app1, "d2"))).toMatchObject({ deployment_uuid: "d2", status: "failed", logs: null });
    // Another application's deployment is not this application's.
    expect(await withOrg(ex, A, (tx) => findDeploymentByUuid(tx, fx.a!.app1, "other-app"))).toBeNull();
    expect(await withOrg(ex, A, (tx) => findDeploymentForJob(tx, "other-app"))).toMatchObject({ application_id: String(fx.a!.app2) });
    // The newest that runs or waits.
    expect(await withOrg(ex, A, (tx) => findRunningDeploymentUrl(tx, fx.a!.app1))).toBe("/d/d7");
    expect(await withOrg(ex, A, (tx) => findRunningDeploymentUrl(tx, fx.a!.app2))).toBeNull();
  });
});

describe("row-level security", () => {
  it("keeps each org's deployments to itself", async () => {
    const mine = queued(await enqueue(A, fx.a!.app1, { deploymentUuid: "depofa000000000000000001" })).deployment;
    queued(await enqueue(B, fx.b!.app1, { deploymentUuid: "depofb000000000000000001" }));

    expect(await withOrg(ex, B, (tx) => findDeploymentForJob(tx, "depofa000000000000000001"))).toBeNull();
    expect(await withOrg(ex, B, (tx) => findDeploymentByUuid(tx, fx.a!.app1, "depofa000000000000000001"))).toBeNull();
    expect((await withOrg(ex, B, (tx) => listDeployments(tx, fx.a!.app1))).count).toBe(0);
    expect(await withOrg(ex, B, (tx) => deploymentStatus(tx, mine.id))).toBeNull();
    expect(await withOrg(ex, B, (tx) => updateDeploymentStatus(tx, mine.id, "cancelled-by-user"))).toBeNull();
    expect(await withOrg(ex, B, (tx) => startQueuedDeployment(tx, mine.id, true))).toBe(false);
    expect(await withOrg(ex, B, (tx) => appendDeploymentLog(tx, mine.id, { command: null, output: "x", type: "stdout", timestamp: "t", hidden: false, batch: 1 }))).toBe(false);
    expect(await withOrg(ex, B, (tx) => findDeploymentApplicationByUuid(tx, "app1a"))).toBeNull();
    expect(await withOrg(ex, B, (tx) => findServerSshConnection(tx, fx.a!.serverId))).toBeNull();
    // The other org's running deployment does not count against this org's server.
    expect(await withOrg(ex, B, (tx) => activeBuildsOnServer(tx, fx.a!.serverId))).toBe(0);
    expect((await withOrg(ex, A, (tx) => findDeploymentForJob(tx, "depofa000000000000000001")))!.status).toBe("in_progress");
  });

  it("refuses a deployment stored for another org", async () => {
    await expect(withOrg(ex, B, (tx) => enqueueDeployment(tx, deployment(A, fx.a!.app1)))).rejects.toThrow();
  });
});
