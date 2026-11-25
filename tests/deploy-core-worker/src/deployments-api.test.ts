// The deployment queue's routes (DP-56), through the handler with an in-memory store: Deploy and Restart
// (nothing queued without the SSH executor; Coolify's admission with it, behind a fake binding), the history,
// a deployment's log lines by the viewer's role, the export, cancel, force start, the debug switch, and the
// authorization. The SQL behind the store is tested in tests/db; the deployment itself in
// deployments-engine.test.ts.
import type { Env } from "@deploy-core-worker/env";
import { route } from "@deploy-core-worker/router";
import { handleDeployments, isDeploymentRoute, DEPLOYMENT_HANDLER_MESSAGES, type DeploymentDeps } from "@deploy-core-worker/handlers/deployments";
import { undispatchableReason, deploymentListItem, type DeploymentServiceStore } from "@deploy-core-worker/deployments/service";
import type { DeploymentExecutor, RemoteProcess } from "@deploy-core-worker/deployments/engine";
import { sessionExecutor, withStdin } from "@deploy-core-worker/deployments/session-executor";
import type { RuntimeVariable } from "@deploy-core-worker/deployments/runtime-env";
import type { DeployDeploymentBuildRow, DeployDeploymentListRow, DeployDeploymentRow, DeployDeploymentWithLogsRow, DeploymentLogEntry, EnqueueResult, NewDeployment } from "@saas/db/deploy";
import { applicationRow, buildRow } from "./deployment-fixtures";
import { runCases } from "./deployment-goldens";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy/applications`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const APP = "app0000000000000000000001";
const NOW = new Date("2026-11-20T10:11:12Z");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}
type Body = { data?: Record<string, unknown>; error?: { code: string; message: string; details?: Record<string, unknown> } };

/** One application's deployments in memory, with the admission rules of the SQL store in their simplest form. */
class MemoryStore implements DeploymentServiceStore {
  application = { ...applicationRow(runCases.find((r) => r.id === "run.first")!), server_is_reachable: true, server_is_usable: true };
  rows: DeployDeploymentWithLogsRow[] = [];
  variables_: RuntimeVariable[] = [];
  queueLimit = 25;
  private next = 1;

  add(over: Partial<DeployDeploymentWithLogsRow> & { deployment_uuid: string }): DeployDeploymentWithLogsRow {
    const row: DeployDeploymentWithLogsRow = {
      id: this.next++, application_id: "1", pull_request_id: 0, force_rebuild: false, commit: "HEAD", status: "finished", is_webhook: false, is_api: false, is_mcp: false,
      restart_only: false, rollback: false, only_this_server: false, git_type: null, server_id: 1, build_server_id: null, application_name: "app", server_name: "srv",
      deployment_url: `/d/${over.deployment_uuid}`, destination_id: "1", commit_message: null, docker_registry_image_tag: null, parent_deployment_uuid: null,
      created_at: "2026-11-20 10:00:00", updated_at: "2026-11-20 10:00:00", finished_at: "2026-11-20 10:01:05", deploy_started_at: null, logs: null, ...over,
    };
    this.rows.push(row);
    return row;
  }
  logsOf(uuid: string): DeploymentLogEntry[] {
    return JSON.parse(this.rows.find((r) => r.deployment_uuid === uuid)!.logs ?? "[]") as DeploymentLogEntry[];
  }
  private byId(id: string | number) {
    return this.rows.find((r) => r.id === id)!;
  }

  findApplication = async (uuid: string) => (uuid === this.application.uuid ? this.application : null);
  findApplicationById = async (id: string | number) => (String(id) === String(this.application.id) ? this.application : null);
  /** The Git and build columns: those of a public repository on GitHub, unless a test says otherwise. */
  build: DeployDeploymentBuildRow = buildRow(runCases.find((r) => r.id === "dockerfile.first")!);
  findBuild = async (id: string | number) => (String(id) === String(this.application.id) ? this.build : null);
  async enqueue(input: Omit<NewDeployment, "orgId">): Promise<EnqueueResult> {
    if (this.rows.filter((r) => r.status === "queued").length >= this.queueLimit) return { status: "queue_full" };
    const existing = this.rows.find((r) => r.commit === input.commit && (r.status === "queued" || r.status === "in_progress"));
    if (existing && !input.forceRebuild) return { status: "skipped", deploymentUuid: existing.deployment_uuid };
    const started = !this.rows.some((r) => r.status === "in_progress");
    const deployment = this.add({
      deployment_uuid: input.deploymentUuid, status: started ? "in_progress" : "queued", commit: input.commit, force_rebuild: input.forceRebuild ?? false, restart_only: input.restartOnly ?? false,
      deployment_url: input.deploymentUrl, application_name: input.applicationName, server_name: input.serverName, finished_at: null,
    });
    return { status: "queued", deployment, started };
  }
  async list(_applicationId: string | number, options: { skip?: number; take?: number; filters?: string[]; sort?: string; search?: string | null; pullRequestId?: string | null }) {
    let rows = [...this.rows].reverse();
    const statuses = (options.filters ?? []).filter((f) => f.startsWith("status:")).map((f) => f.slice(7));
    if (statuses.length) rows = rows.filter((r) => statuses.includes(r.status));
    if (options.sort === "oldest") rows.reverse();
    const skip = options.skip ?? 0;
    return { count: rows.length, deployments: rows.slice(skip, skip + (options.take ?? 10)) as DeployDeploymentListRow[] };
  }
  filterOptions = async () => ({
    statuses: [...new Set(this.rows.map((r) => r.status))],
    sources: [...new Set(this.rows.map((r) => (r.pull_request_id > 0 ? "pull-request" : r.is_webhook ? "webhook" : "manual")))],
    servers: this.rows.length ? [{ id: 1, name: "srv" }] : [],
    pullRequestIds: [...new Set(this.rows.filter((r) => r.pull_request_id > 0).map((r) => r.pull_request_id))],
  });
  find = async (_applicationId: string | number, uuid: string) => this.rows.find((r) => r.deployment_uuid === uuid) ?? null;
  async cancel(id: string | number) {
    this.byId(id).status = "cancelled-by-user";
  }
  async appendLog(id: string | number, entry: Omit<DeploymentLogEntry, "order">) {
    const row = this.byId(id);
    const logs = JSON.parse(row.logs ?? "[]") as DeploymentLogEntry[];
    logs.push({ ...entry, order: logs.length + 1 });
    row.logs = JSON.stringify(logs);
  }
  async startQueued(id: string | number, force: boolean) {
    const row = this.byId(id);
    if (row.status !== "queued" || (!force && this.rows.some((r) => r.status === "in_progress"))) return false;
    row.status = "in_progress";
    return true;
  }
  async startNextQueued(): Promise<DeployDeploymentRow[]> {
    if (this.rows.some((r) => r.status === "in_progress")) return [];
    const next = this.rows.find((r) => r.status === "queued");
    if (!next) return [];
    next.status = "in_progress";
    return [next];
  }
  async failUnattended(id: string | number) {
    const row = this.byId(id);
    if (row.status !== "in_progress") return false;
    row.status = "failed";
    return true;
  }
  variables = async () => this.variables_;
  async setDebug(_id: string | number, enabled: boolean) {
    this.application = { ...this.application, is_debug_enabled: enabled };
  }
  runningDeploymentUrl = async () => [...this.rows].reverse().find((r) => r.status === "queued" || r.status === "in_progress")?.deployment_url ?? null;
}

function setup(opts: { write?: boolean; read?: boolean; ssh?: boolean; workflow?: "ok" | "fails" | "none" } = {}) {
  const store = new MemoryStore();
  const asked: string[] = [];
  const env: Env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      asked.push(body.action);
      const allow = body.action === "deploy.resource.write" ? (opts.write ?? true) : (opts.read ?? true);
      return json({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
    // A fake binding: its presence is what the handler looks at.
    ...(opts.ssh ? { SSH_SESSION: {} as NonNullable<Env["SSH_SESSION"]> } : {}),
  };
  const dispatched: string[] = [];
  const processes: RemoteProcess[] = [];
  /** What the server answers a command with. */
  const answers: Array<{ match: string; stdout?: string; stderr?: string; exitCode?: number }> = [];
  const executor: DeploymentExecutor = {
    async run(process) {
      processes.push(process);
      const answer = answers.find((a) => process.script.includes(a.match));
      return { exitCode: answer?.exitCode ?? 0, stdout: answer?.stdout ?? "", stderr: answer?.stderr ?? "" };
    },
  };
  let uuids = 0;
  const deps: DeploymentDeps = {
    run: (_env, _orgId, fn) => fn({ store, executor: async () => (opts.ssh ? executor : null), now: () => NOW, newUuid: () => `dep${String(++uuids).padStart(21, "0")}` }),
    dispatch: async (_env, _orgId, deployment) => {
      if (opts.workflow === "none") throw new Error(DEPLOYMENT_HANDLER_MESSAGES.noWorkflow);
      if (opts.workflow === "fails") throw new Error("workflow instance could not be created");
      dispatched.push(deployment.deployment_uuid);
    },
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const [pathname, query = ""] = path.split("?");
    const segments = pathname!.split("/").filter(Boolean);
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleDeployments(env, "req_1", actor, ORG_UUID, segments, new Request(`${BASE}/${pathname}${query ? `?${query}` : ""}`, init), deps);
    return { status: res.status, body: (await res.json()) as Body };
  };
  return { store, env, asked, dispatched, processes, answers, call };
}

describe("Deploy and Restart", () => {
  it("without the SSH executor these routes are not the queue's: the 501 of the application routes stays, and nothing is stored", async () => {
    const t = setup();
    expect(isDeploymentRoute(t.env, [APP, "deploy"])).toBe(false);
    expect(isDeploymentRoute(t.env, [APP, "restart"])).toBe(false);
    expect(isDeploymentRoute(t.env, [APP, "deployments"])).toBe(true);
    expect(isDeploymentRoute(t.env, [APP, "deployments", "dep1", "cancel"])).toBe(true);
    // Through the router, as api-edge calls it: Deploy answers "not available yet" before any store is opened.
    const res = await route(new Request(`${BASE}/${APP}/deploy`, { method: "POST", headers: { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" } }), { ENVIRONMENT: "test" });
    expect(res.status).toBe(503); // no database in this test: the application route was reached, not the queue's
    expect(t.store.rows).toEqual([]);
  });

  it("with it, Deploy queues a deployment as Coolify does, starts it, and answers with its page", async () => {
    const t = setup({ ssh: true });
    expect(isDeploymentRoute(t.env, [APP, "deploy"])).toBe(true);
    expect(isDeploymentRoute(t.env, [APP, "stop"])).toBe(false);
    const r = await t.call("POST", `${APP}/deploy`, {});
    expect(r.status).toBe(201);
    expect(r.body.data).toEqual({
      status: "queued",
      message: "Deployment queued.",
      deploymentUuid: "dep000000000000000000001",
      redirect: `/project/prj0000000000000000000001/environment/env0000000000000000000001/application/${APP}/deployment/dep000000000000000000001`,
    });
    expect(t.store.rows[0]).toMatchObject({ deployment_uuid: "dep000000000000000000001", status: "in_progress", commit: "HEAD", force_rebuild: false, restart_only: false, application_name: "app", server_name: "srv" });
    expect(t.store.rows[0]!.deployment_url).toBe((r.body.data as { redirect: string }).redirect);
    expect(t.dispatched).toEqual(["dep000000000000000000001"]);
    expect(t.asked).toEqual(["deploy.resource.write"]);
  });

  it("Deploy (without cache) forces and queues next to the same commit; Restart is restart_only, and is skipped while its commit runs", async () => {
    const t = setup({ ssh: true });
    await t.call("POST", `${APP}/deploy`, {});
    expect((await t.call("POST", `${APP}/deploy`, { force_rebuild: true })).status).toBe(201);
    // Heading::restart() shows this one as a success toast.
    expect((await t.call("POST", `${APP}/restart`)).body.data).toMatchObject({ status: "skipped", title: "Deployment skipped" });
    expect(t.store.rows.map((r) => [r.status, r.force_rebuild, r.restart_only])).toEqual([["in_progress", false, false], ["queued", true, false]]);
    // The one that waits is not dispatched.
    expect(t.dispatched).toEqual(["dep000000000000000000001"]);
    for (const row of t.store.rows) row.status = "finished";
    expect((await t.call("POST", `${APP}/restart`)).status).toBe(201);
    expect(t.store.rows[2]).toMatchObject({ status: "in_progress", restart_only: true, force_rebuild: false });
  });

  it("the same commit again is skipped, with Coolify's toast", async () => {
    const t = setup({ ssh: true });
    await t.call("POST", `${APP}/deploy`, {});
    const r = await t.call("POST", `${APP}/deploy`, {});
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ status: "skipped", title: "Deployment skipped", message: "Deployment already queued for this commit.", deploymentUuid: "dep000000000000000000001" });
    expect(t.store.rows.length).toBe(1);
  });

  it("a full queue is refused, with Coolify's toast", async () => {
    const t = setup({ ssh: true });
    t.store.queueLimit = 0;
    const r = await t.call("POST", `${APP}/deploy`, {});
    expect([r.status, r.body.error?.code, r.body.error?.message, r.body.error?.details]).toEqual([409, "conflict", "Deployment queue is full. Please wait for existing deployments to complete.", { title: "Deployment queue full" }]);
    expect(t.store.rows).toEqual([]);
  });

  it("a deployment whose job cannot be started fails at once, with the reason in its log", async () => {
    for (const [workflow, reason] of [["none", "the deployment Workflow is not bound to this Worker."], ["fails", "workflow instance could not be created"]] as const) {
      const t = setup({ ssh: true, workflow });
      const r = await t.call("POST", `${APP}/deploy`, {});
      expect([r.status, r.body.error?.message]).toEqual([503, `Deployment could not be started: ${reason}`]);
      expect(t.store.rows[0]!.status).toBe("failed");
      expect(t.store.logsOf("dep000000000000000000001").map((e) => [e.output, e.type])).toEqual([
        ["========================================", "stderr"],
        [`Deployment could not be started: ${reason}`, "stderr"],
        ["========================================", "stderr"],
      ]);
    }
  });

  it("what the job's constructor refuses is such a failure too", async () => {
    const t = setup({ ssh: true });
    t.store.application = { ...t.store.application, docker_registry_image_name: "Not A Valid Name" };
    const r = await t.call("POST", `${APP}/deploy`, {});
    expect([r.status, r.body.error?.message]).toEqual([503, "Deployment could not be started: Docker registry image name contains invalid characters."]);
    expect(t.dispatched).toEqual([]);
    expect(undispatchableReason({ docker_registry_image_name: "ghcr.io/acme/app", docker_registry_image_tag: "${TAG:-latest}" }, { commit: "HEAD" })).toBeNull();
    expect(undispatchableReason({ docker_registry_image_name: "nginx", docker_registry_image_tag: "a b" }, { commit: "HEAD" })).toBe("Docker registry image tag contains invalid characters.");
    expect(undispatchableReason({ docker_registry_image_name: "nginx", docker_registry_image_tag: null }, { commit: "-x" })).toBe("Invalid deployment commit: must not start with a hyphen.");
  });

  it.each(["dockerfile", "nixpacks", "static"])("a %s application of a public repository is queued with the commit it is pinned to, and its job starts", async (buildPack) => {
    const t = setup({ ssh: true });
    t.store.application = { ...t.store.application, build_pack: buildPack, docker_registry_image_name: null, docker_registry_image_tag: null };
    const head = await t.call("POST", `${APP}/deploy`, {});
    expect([head.status, head.body.data?.status]).toEqual([201, "queued"]);
    expect(t.store.rows.map((r) => [r.commit, r.status, r.restart_only])).toEqual([["HEAD", "in_progress", false]]);
    expect(t.dispatched).toEqual([t.store.rows[0]!.deployment_uuid]);
    // $commit ?: ($application->git_commit_sha ?: 'HEAD')
    t.store.rows[0]!.status = "finished";
    t.store.build = { ...t.store.build, git_commit_sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c" };
    const pinned = await t.call("POST", `${APP}/restart`, {});
    expect(pinned.status).toBe(201);
    expect(t.store.rows.map((r) => [r.commit, r.restart_only])).toEqual([["HEAD", false], ["0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c", true]]);
  });

  it("a pasted Dockerfile is deployed whatever its Git columns say", async () => {
    const t = setup({ ssh: true });
    t.store.application = { ...t.store.application, build_pack: "dockerfile", has_dockerfile: true, docker_registry_image_name: null, docker_registry_image_tag: null };
    t.store.build = { ...t.store.build, private_key_id: 4, source_id: null, source_type: null };
    expect((await t.call("POST", `${APP}/deploy`, {})).status).toBe(201);
  });

  it.each([
    ["a Docker Compose application", { build_pack: "dockercompose" }, {}, "Deploying a Docker Compose application is not available yet."],
    ["a Railpack application", { build_pack: "railpack" }, {}, "Deploying the railpack build pack is not available yet."],
    ["a build server", { build_pack: "nixpacks" }, { is_build_server_enabled: true }, "Building on a build server is not available yet: turn off \"Use a Build Server\" to build on the application's server."],
    ["a server for deployments only", { build_pack: "dockerfile" }, { server_role: "deployment" }, "The application's server is set to deployments only, so the application is built on a build server, which is not available yet."],
    ["a preserved repository", { build_pack: "nixpacks" }, { is_preserve_repository_enabled: true }, "Deploying with \"Preserve Repository During Deployment\" is not available yet."],
    ["a deploy key", { build_pack: "dockerfile" }, { private_key_id: 4 }, "Deploying from a private repository with a deploy key is not available yet: only public repositories can be deployed."],
    ["a GitHub App", { build_pack: "static" }, { source_id: 7 }, "Deploying from a Git App source is not available yet: only public repositories can be deployed."],
    ["a GitLab App", { build_pack: "static" }, { source_id: 0, source_type: "App\\Models\\GitlabApp" }, "Deploying from a Git App source is not available yet: only public repositories can be deployed."],
    ["HTTPS credentials", { build_pack: "nixpacks" }, { source_id: null, source_type: null, has_git_https_credentials: true }, "Deploying from a repository with HTTPS credentials is not available yet: only public repositories can be deployed."],
  ])("%s is refused with its reason, and nothing is queued", async (_what, application, build, message) => {
    const t = setup({ ssh: true });
    t.store.application = { ...t.store.application, ...application };
    t.store.build = { ...t.store.build, ...build };
    const r = await t.call("POST", `${APP}/deploy`, {});
    expect([r.status, r.body.error?.code, r.body.error?.message]).toEqual([501, "unsupported", message]);
    expect(t.store.rows).toEqual([]);
    expect(t.dispatched).toEqual([]);
  });

  it("needs deploy.resource.write, and answers 404 for another org's application", async () => {
    const denied = setup({ ssh: true, write: false });
    expect((await denied.call("POST", `${APP}/deploy`, {})).status).toBe(404);
    expect(denied.store.rows).toEqual([]);
    const t = setup({ ssh: true });
    expect((await t.call("POST", "nope/deploy", {})).status).toBe(404);
    expect((await t.call("GET", `${APP}/deploy`)).status).toBe(405);
  });
});

describe("the history", () => {
  function history() {
    const t = setup();
    t.store.add({ deployment_uuid: "d1", status: "finished", commit: "aaa1111aaa", commit_message: "First\nmore" });
    t.store.add({ deployment_uuid: "d2", status: "failed", is_webhook: true });
    t.store.add({ deployment_uuid: "d3", status: "in_progress", finished_at: null, server_name: null });
    return t;
  }

  it("lists the deployments newest first with Coolify's labels, and the filters they offer", async () => {
    const t = history();
    const r = await t.call("GET", `${APP}/deployments`);
    expect(r.status).toBe(200);
    const data = r.body.data as Record<string, unknown>;
    expect(data).toMatchObject({
      count: 3, skip: 0, take: 10, currentPage: 1, lastPage: 1, pullRequestId: null, invalidPullRequestId: false, search: "", filters: [], sort: "newest",
      statusFilterOptions: [{ value: "status:finished", label: "Success" }, { value: "status:failed", label: "Failed" }, { value: "status:in_progress", label: "In progress" }],
      sourceFilterOptions: [{ value: "source:manual", label: "Manual" }, { value: "source:webhook", label: "Webhooks" }],
      serverFilterOptions: [{ value: "server:1", label: "srv" }],
      pullRequestOptions: [{ value: "", label: "All deployments" }],
      runningDeploymentUrl: "/d/d3",
      serverTimezone: "UTC",
    });
    expect(data.deployments).toEqual([
      { uuid: "d3", status: "in_progress", statusLabel: "In progress", statusType: "warning", sourceLabel: "Manual", sourceKey: "manual", pullRequestId: 0, commit: "HEAD", commitMessage: null, serverId: 1, serverName: "srv", createdAt: "2026-11-20T10:00:00.000Z", finishedAt: null },
      { uuid: "d2", status: "failed", statusLabel: "Failed", statusType: "error", sourceLabel: "Webhook", sourceKey: "webhook", pullRequestId: 0, commit: "HEAD", commitMessage: null, serverId: 1, serverName: "srv", createdAt: "2026-11-20T10:00:00.000Z", finishedAt: "2026-11-20T10:01:05.000Z" },
      { uuid: "d1", status: "finished", statusLabel: "Success", statusType: "success", sourceLabel: "Manual", sourceKey: "manual", pullRequestId: 0, commit: "aaa1111aaa", commitMessage: "First", serverId: 1, serverName: "srv", createdAt: "2026-11-20T10:00:00.000Z", finishedAt: "2026-11-20T10:01:05.000Z" },
    ]);
    expect(t.asked.sort()).toEqual(["deploy.resource.read", "deploy.resource.write"]);
  });

  it("pages, sorts and filters as the query says; a filter that is not offered is dropped", async () => {
    const t = history();
    const page = (await t.call("GET", `${APP}/deployments?take=2&skip=2&sort=oldest`)).body.data as { deployments: Array<{ uuid: string }>; currentPage: number; lastPage: number };
    expect([page.deployments.map((d) => d.uuid), page.currentPage, page.lastPage]).toEqual([["d3"], 2, 2]);
    const filtered = (await t.call("GET", `${APP}/deployments?filters=status:failed,status:nope,source:api`)).body.data as { deployments: Array<{ uuid: string }>; filters: string[] };
    expect([filtered.deployments.map((d) => d.uuid), filtered.filters]).toEqual([["d2"], ["status:failed"]]);
  });

  it("a pull request id that is no positive integer clears the filter (Coolify's error toast is the page's)", async () => {
    const t = history();
    for (const bad of ["abc", "0", "-3", "1.5"]) {
      expect((await t.call("GET", `${APP}/deployments?pull_request_id=${bad}`)).body.data).toMatchObject({ pullRequestId: null, invalidPullRequestId: true });
    }
    expect((await t.call("GET", `${APP}/deployments?pull_request_id=7`)).body.data).toMatchObject({
      pullRequestId: "7",
      invalidPullRequestId: false,
      pullRequestOptions: [{ value: "", label: "All deployments" }, { value: "7", label: "Pull request #7" }],
    });
  });

  it("the labels of a row, source by source", () => {
    const row = (over: Partial<DeployDeploymentListRow>): DeployDeploymentListRow =>
      ({ id: 1, application_id: "1", deployment_uuid: "d", pull_request_id: 0, status: "finished", commit: "HEAD", commit_message: null, is_webhook: false, is_api: false, is_mcp: false, rollback: false, server_id: null, server_name: null, created_at: null, updated_at: null, finished_at: null, ...over }) as DeployDeploymentListRow;
    const labels = (over: Partial<DeployDeploymentListRow>) => {
      const item = deploymentListItem(row(over), { server_name: "main" });
      return [item.sourceLabel, item.sourceKey, item.statusLabel, item.statusType, item.serverName];
    };
    expect(labels({})).toEqual(["Manual", "manual", "Success", "success", "main"]);
    expect(labels({ is_webhook: true, pull_request_id: 4, status: "queued" })).toEqual(["Webhook · PR #4", "pull-request", "Queued", "warning", "main"]);
    expect(labels({ pull_request_id: 4, status: "cancelled-by-user" })).toEqual(["Pull request #4", "pull-request", "Cancelled", "neutral", "main"]);
    expect(labels({ rollback: true, status: "skipped" })).toEqual(["Rollback", "rollback", "Skipped", "neutral", "main"]);
    expect(labels({ is_mcp: true, is_api: true })).toEqual(["MCP", "mcp", "Success", "success", "main"]);
    expect(labels({ is_api: true, server_name: "edge" })).toEqual(["API", "api", "Success", "success", "edge"]);
  });

  it("is read with deploy.resource.read; a denial and an unknown application answer 404", async () => {
    expect((await setup({ read: false }).call("GET", `${APP}/deployments`)).status).toBe(404);
    expect((await setup().call("GET", "nope/deployments")).status).toBe(404);
    expect((await setup().call("POST", `${APP}/deployments`)).status).toBe(405);
  });
});

describe("one deployment", () => {
  const logs: DeploymentLogEntry[] = [
    { command: null, output: "Starting deployment of nginx:1.27 to srv.", type: "stdout", timestamp: "2026-11-20T10:11:12.000000Z", hidden: false, batch: 1, order: 1 },
    { command: "docker compose pull", output: "nginx Pulled\ntoken tok_live_0123456789", type: "stdout", timestamp: "2026-11-20T10:11:13.000000Z", hidden: true, batch: 8, order: 2 },
    { command: null, output: "New container is unhealthy.", type: "stderr", timestamp: "2026-11-20T10:11:14.000000Z", hidden: false, batch: 1, order: 3 },
  ];
  function one(opts: Parameters<typeof setup>[0] = {}) {
    const t = setup(opts);
    t.store.add({ deployment_uuid: "d1", status: "in_progress", finished_at: null, logs: JSON.stringify(logs) });
    return t;
  }

  it("shows its status and the lines Coolify's page shows; debug lines stay out until debug logs are on", async () => {
    const t = one();
    const r = await t.call("GET", `${APP}/deployments/d1`);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      deployment: { uuid: "d1", status: "in_progress", statusLabel: "In progress", statusType: "warning", commit: "HEAD", createdAt: "2026-11-20T10:00:00.000Z", finishedAt: null },
      lines: [
        { line: "Starting deployment of nginx:1.27 to srv.", timestamp: "2026-Nov-20 10:11:12", stderr: false, hidden: false },
        { line: "New container is unhealthy.", timestamp: "2026-Nov-20 10:11:14", stderr: true, hidden: false },
      ],
      isDebugEnabled: false,
      isKeepAliveOn: true,
      canUpdate: true,
      canDeploy: true,
    });
  });

  it("with debug logs on, who may update sees the commands and hidden output; a reader never does", async () => {
    const t = one();
    expect((await t.call("POST", `${APP}/deployments/d1/debug`)).body.data).toEqual({ isDebugEnabled: true });
    const lines = ((await t.call("GET", `${APP}/deployments/d1`)).body.data as { lines: Array<{ line: string; command?: boolean; hidden: boolean }>; isDebugEnabled: boolean }).lines;
    expect(lines.map((l) => [l.line, l.command ?? false, l.hidden])).toEqual([
      ["Starting deployment of nginx:1.27 to srv.", false, false],
      ["docker compose pull", true, true],
      ["nginx Pulled", false, true],
      ["token tok_live_0123456789", false, true],
      ["New container is unhealthy.", false, false],
    ]);
    const reader = one({ write: false });
    reader.store.application = { ...reader.store.application, is_debug_enabled: true };
    const seen = (await reader.call("GET", `${APP}/deployments/d1`)).body.data as { lines: unknown[]; isDebugEnabled: boolean; canUpdate: boolean };
    expect([seen.lines.length, seen.isDebugEnabled, seen.canUpdate]).toEqual([2, false, false]);
    // … and may not switch them on.
    expect((await reader.call("POST", `${APP}/deployments/d1/debug`)).status).toBe(404);
    // The switch goes back.
    expect((await t.call("POST", `${APP}/deployments/d1/debug`)).body.data).toEqual({ isDebugEnabled: false });
  });

  it("stops polling once the deployment is finished, failed or skipped — a cancelled one keeps polling, as Coolify's does", async () => {
    for (const [status, keepAlive, label, type] of [["finished", false, "Finished", "success"], ["failed", false, "Failed", "error"], ["skipped", false, "Skipped", "neutral"], ["cancelled-by-user", true, "Cancelled By User", "neutral"], ["queued", true, "Queued", "warning"]] as const) {
      const t = setup();
      t.store.add({ deployment_uuid: "d1", status });
      expect((await t.call("GET", `${APP}/deployments/d1`)).body.data).toMatchObject({ isKeepAliveOn: keepAlive, deployment: { statusLabel: label, statusType: type } });
    }
  });

  it("exports the visible lines, or — for who may update — every line with the debug lines marked; secrets are hidden again", async () => {
    const t = one();
    t.store.variables_ = [{ key: "T", value: "tok_live_0123456789", realValue: "tok_live_0123456789", is_literal: false, is_multiline: false, is_runtime: true, is_buildtime: true, is_shown_once: false, referencesLockedSharedVariable: false }];
    expect((await t.call("GET", `${APP}/deployments/d1/logs`)).body.data).toEqual({ logs: "2026-Nov-20 10:11:12 Starting deployment of nginx:1.27 to srv.\n2026-Nov-20 10:11:14 New container is unhealthy." });
    expect((await t.call("GET", `${APP}/deployments/d1/logs?timestamps=0&search=UNHEALTHY`)).body.data).toEqual({ logs: "New container is unhealthy." });
    expect((await t.call("GET", `${APP}/deployments/d1/logs?all=1`)).body.data).toEqual({
      logs: "2026-Nov-20 10:11:12 Starting deployment of nginx:1.27 to srv.\n2026-Nov-20 10:11:13 [DEBUG] [CMD]: docker compose pull\n2026-Nov-20 10:11:13 [DEBUG] nginx Pulled\n2026-Nov-20 10:11:13 [DEBUG] token <REDACTED>\n2026-Nov-20 10:11:14 New container is unhealthy.",
    });
    expect((await one({ write: false }).call("GET", `${APP}/deployments/d1/logs?all=1`)).status).toBe(404);
  });

  it("answers 404 for a deployment that is not the application's, and for a path it does not serve", async () => {
    const t = one();
    expect((await t.call("GET", `${APP}/deployments/nope`)).status).toBe(404);
    expect((await t.call("GET", `${APP}/deployments/d1/nope`)).status).toBe(404);
    expect((await t.call("GET", `${APP}/deployments/d1/logs/more`)).status).toBe(404);
    expect((await t.call("POST", `${APP}/deployments/d1`)).status).toBe(405);
  });
});

describe("cancel and force start", () => {
  it("need the SSH executor: 501 without it, and nothing changes", async () => {
    const t = setup();
    t.store.add({ deployment_uuid: "d1", status: "in_progress" });
    const cancel = await t.call("POST", `${APP}/deployments/d1/cancel`);
    expect([cancel.status, cancel.body.error?.message]).toEqual([501, "Cancelling a deployment needs the SSH executor, which is not available yet."]);
    const force = await t.call("POST", `${APP}/deployments/d1/force-start`);
    expect([force.status, force.body.error?.message]).toEqual([501, "Starting a deployment needs the SSH executor, which is not available yet."]);
    expect(t.store.rows[0]!.status).toBe("in_progress");
  });

  it("cancel marks the deployment first, removes its helper container on the server, and starts what waited", async () => {
    const t = setup({ ssh: true });
    t.store.add({ deployment_uuid: "d1", status: "in_progress" });
    t.store.add({ deployment_uuid: "d2", status: "queued", commit: "next" });
    t.answers.push({ match: "docker ps -a --filter name=d1", stdout: "d1\n" });
    const r = await t.call("POST", `${APP}/deployments/d1/cancel`);
    expect([r.status, r.body.data]).toEqual([200, { status: "cancelled-by-user" }]);
    expect(t.processes.map((p) => p.script)).toEqual(["docker ps -a --filter name=d1 --format '{{.Names}}'", "docker rm -f d1"]);
    expect(t.store.rows.map((d) => d.status)).toEqual(["cancelled-by-user", "in_progress"]);
    expect(t.store.logsOf("d1").map((e) => [e.output, e.type])).toEqual([["Deployment cancelled by user.", "stderr"], ["Deployment container stopped.", "stdout"]]);
    expect(t.dispatched).toEqual(["d2"]);
  });

  it("a helper that has not started yet is left to the job's next check", async () => {
    const t = setup({ ssh: true });
    t.store.add({ deployment_uuid: "d1", status: "queued" });
    await t.call("POST", `${APP}/deployments/d1/cancel`);
    expect(t.processes.length).toBe(1);
    expect(t.store.logsOf("d1").map((e) => e.output)).toEqual(["Deployment cancelled by user.", "Deployment container not yet started. Will be cancelled when job checks status."]);
  });

  it("a cleanup that fails is reported; the deployment is cancelled and the queue advances all the same", async () => {
    const t = setup({ ssh: true });
    t.store.add({ deployment_uuid: "d1", status: "in_progress" });
    t.store.add({ deployment_uuid: "d2", status: "queued", commit: "next" });
    t.answers.push({ match: "docker ps", exitCode: 1, stderr: "Cannot connect to the Docker daemon\n" });
    const r = await t.call("POST", `${APP}/deployments/d1/cancel`);
    expect([r.status, r.body.error?.message, r.body.error?.details]).toEqual([422, "Cannot connect to the Docker daemon", { cancelled: true }]);
    expect(t.store.rows.map((d) => d.status)).toEqual(["cancelled-by-user", "in_progress"]);
    expect(t.dispatched).toEqual(["d2"]);
  });

  it("force start starts a queued deployment whatever runs, once", async () => {
    const t = setup({ ssh: true });
    t.store.add({ deployment_uuid: "d1", status: "in_progress" });
    t.store.add({ deployment_uuid: "d2", status: "queued", commit: "next" });
    expect((await t.call("POST", `${APP}/deployments/d2/force-start`)).body.data).toEqual({ started: true, message: null });
    expect(t.dispatched).toEqual(["d2"]);
    expect((await t.call("POST", `${APP}/deployments/d2/force-start`)).body.data).toEqual({ started: false, message: "This deployment is no longer queued, so it was not started again." });
    expect(t.dispatched).toEqual(["d2"]);
  });

  it("both need deploy.resource.write", async () => {
    const t = setup({ ssh: true, write: false });
    t.store.add({ deployment_uuid: "d1", status: "queued" });
    expect((await t.call("POST", `${APP}/deployments/d1/cancel`)).status).toBe(404);
    expect((await t.call("POST", `${APP}/deployments/d1/force-start`)).status).toBe(404);
    expect(t.store.rows[0]!.status).toBe("queued");
  });
});

describe("the engine's executor over ssh-executor", () => {
  const conn = { host: "10.0.0.5", port: 22, user: "root", privateKey: "key", hostKey: "" };
  const ndjson = (...events: unknown[]) => new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", { status: 200 });

  it("sends one batch a process and hands the output on line by line, in order", async () => {
    const bodies: Array<{ commands: string[]; timeout?: number }> = [];
    const executor = sessionExecutor(async (_path, init) => {
      bodies.push(JSON.parse(init.body) as { commands: string[] });
      return ndjson({ t: "out", line: "a" }, { t: "err", line: "warn" }, { t: "out", line: "b" }, { t: "exit", code: 3 });
    }, conn, 60);
    const seen: Array<[string, string]> = [];
    const result = await executor.run({ script: "docker ps\ndocker info" }, async (stream, chunk) => {
      await Promise.resolve();
      seen.push([stream, chunk]);
    });
    expect(bodies).toEqual([{ conn, commands: ["docker ps\ndocker info"], timeout: 60 }]);
    expect(seen).toEqual([["out", "a\n"], ["err", "warn\n"], ["out", "b\n"]]);
    expect(result).toEqual({ exitCode: 3, stdout: "a\nb\n", stderr: "warn\n" });
  });

  it("content for a command's stdin travels inside the batch", async () => {
    let sent = "";
    const executor = sessionExecutor(async (_path, init) => {
      sent = (JSON.parse(init.body) as { commands: string[] }).commands[0]!;
      return ndjson({ t: "exit", code: 0 });
    }, conn);
    await executor.run({ script: "tee /x/docker-compose.yaml > /dev/null", input: "services:\n  ü: 1\n" });
    expect(sent).toBe(withStdin("tee /x/docker-compose.yaml > /dev/null", "services:\n  ü: 1\n"));
    expect(sent).toBe(`echo '${Buffer.from("services:\n  ü: 1\n").toString("base64")}' | base64 -d | tee /x/docker-compose.yaml > /dev/null`);
  });

  it("a connection that fails is a failed command with ssh's error", async () => {
    const executor = sessionExecutor(async () => ndjson({ t: "error", code: 255, message: "ssh: connect to host 10.0.0.5 port 22: Connection refused" }), conn);
    const seen: string[] = [];
    const result = await executor.run({ script: "true" }, (stream, chunk) => void seen.push(`${stream}:${chunk}`));
    expect(result).toEqual({ exitCode: 255, stdout: "", stderr: "ssh: connect to host 10.0.0.5 port 22: Connection refused\n" });
    expect(seen).toEqual(["err:ssh: connect to host 10.0.0.5 port 22: Connection refused\n"]);
  });
});
