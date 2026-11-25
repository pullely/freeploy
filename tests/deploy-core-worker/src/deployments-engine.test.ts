// The deployments — a Docker image (DP-56), and the builds on the server: a Dockerfile in a public repository,
// a pasted Dockerfile, Nixpacks and a static site (DP-61) — replayed against Coolify's own PHP. fixtures/deployments/goldens.json
// holds, for every case of cases.json, what coollabsio/coolify@91b7e3e's real ApplicationDeploymentJob did on a
// faked server: each SSH process it started (script and stdin), the deployment log it wrote, the statuses it
// left, how long it slept, what it notified and queued, and what it threw. Here the engine runs every one of
// those cases against an executor that plays the same server: it must start the same processes in the same
// order, and leave the same log and the same statuses. Nothing is deployed anywhere: until the SSH executor is
// deployed (WAITING.md W3) this replay and the PHP goldens are the only proof the engine has.
import { goldenRun, runCases, type GoldenLog, type GoldenRun, type RunCase } from "./deployment-goldens";
import { compactLogs, contextOf, depsOf, newWorld, replayExecutor, type World } from "./deployment-fixtures";
import { DEPLOYMENT_STEPS, initialState, runDeployment, runStep, thrownText, type DeploymentEffect, type EngineState } from "@deploy-core-worker/deployments/engine";
import { buildSecretsHashKey, hmacSha256Hex } from "@deploy-core-worker/deployments/build";

/** "Coolify" reads "Freeploy" in what Freeploy says; the commands and the names on the server stay Coolify's. */
const brand = (text: string): string => text.replace(/Coolify/g, "Freeploy");

/**
 * The log Coolify wrote, as Freeploy must write it: its own name in the messages, and without the two hidden
 * lines that name a PHP source file and line ("Location: …" and "at …") — the engine has no such place to name.
 */
function expectedLogs(logs: GoldenLog[]): GoldenLog[] {
  return logs.filter((entry) => !(entry.hidden && (/^Location: .+:\d+$/.test(entry.output) || /^at .+:\d+$/.test(entry.output)))).map((entry) => ({ ...entry, output: brand(entry.output) }));
}

const jobs = (effects: DeploymentEffect[]): string[] => effects.filter((e): e is Extract<DeploymentEffect, { type: "job" }> => e.type === "job").map((e) => e.job);
const notifications = (effects: DeploymentEffect[]): string[] => effects.filter((e): e is Extract<DeploymentEffect, { type: "notify" }> => e.type === "notify").map((e) => e.notification);

async function replay(run: RunCase, golden: GoldenRun): Promise<{ world: World; state: EngineState }> {
  const world = newWorld(run);
  const ctx = contextOf(run);
  const deps = depsOf(world, replayExecutor(world, golden.processes, run.cancelOn));
  const state = await runDeployment(deps, ctx);
  return { world, state };
}

/** The runs whose deployment Coolify started: the others never reach the job (the queue's own tests have them). */
const started = runCases.filter((run) => {
  const golden = goldenRun(run.id);
  return golden.deployment !== null && golden.deployment.status !== "queued";
});

/** The build packs of DP-61, by the prefix of their cases: a pasted Dockerfile is a "simple" one. */
const BUILD_PACKS = ["simple", "dockerfile", "nixpacks", "static"] as const;
const packOf = (run: RunCase): string => run.id.split(".")[0]!;

describe("the deployments, replayed against Coolify's ApplicationDeploymentJob", () => {
  it("has a golden run for every case, and enough of them", () => {
    expect(started.length).toBeGreaterThanOrEqual(120);
    for (const run of runCases) expect(goldenRun(run.id)).toBeDefined();
  });

  it.each(BUILD_PACKS)("has at least 25 golden runs of the %s build pack, with builds that end well and builds that fail", (pack) => {
    const runs = started.filter((run) => packOf(run) === pack);
    expect(runs.length).toBeGreaterThanOrEqual(25);
    const statuses = runs.map((run) => goldenRun(run.id).deployment!.status);
    expect(statuses.filter((status) => status === "finished").length).toBeGreaterThanOrEqual(15);
    expect(statuses.filter((status) => status === "failed").length).toBeGreaterThanOrEqual(5);
    // … and they are not one build twenty-five times: the build scripts differ.
    const scripts = runs.map((run) => goldenRun(run.id).processes.find((p) => p.script.includes("tee /artifacts/build.sh"))?.script).filter((script) => script !== undefined);
    expect(new Set(scripts).size).toBeGreaterThanOrEqual(pack === "static" ? 5 : 15);
  });

  it.each(started.map((run) => [run.id, run.about, run] as const))("%s — %s", async (_id, _about, run) => {
    const golden = goldenRun(run.id);
    const { world, state } = await replay(run, golden);

    // Every process Coolify started, and no other: the executor refuses a different one on the way.
    expect(world.mismatch).toBeNull();
    expect(world.processes.map((p) => p.script)).toEqual(golden.processes.map((p) => p.script));
    expect(world.processes.map((p) => p.input ?? null)).toEqual(golden.processes.map((p) => p.input ?? null));
    // The log, entry by entry.
    expect(compactLogs(world.deployment.logs)).toEqual(expectedLogs(golden.deployment!.logs ?? []));
    // The deployment row.
    expect(world.deployment.status).toBe(golden.deployment!.status);
    expect(world.deployment.finishedAt).toBe(golden.deployment!.finished_at !== null);
    expect(world.deployment.deployStartedAt).toBe(golden.deployment!.deploy_started_at !== null);
    // The application row.
    expect(world.application).toEqual(golden.application);
    // What a build leaves: the commit and its message on the deployment; on the application the health check a
    // Dockerfile declares, the SSH host keys git accepted and the variables Nixpacks needs.
    expect(world.build.commit).toBe(golden.deployment!.commit);
    expect(world.build.commitMessage).toBe(golden.deployment!.commit_message);
    expect(world.build.healthcheck).toEqual({
      health_check_enabled: golden.build.health_check_enabled,
      health_check_interval: golden.build.health_check_interval,
      health_check_timeout: golden.build.health_check_timeout,
      health_check_retries: golden.build.health_check_retries,
      health_check_start_period: golden.build.health_check_start_period,
      custom_healthcheck_found: golden.build.custom_healthcheck_found,
    });
    expect(world.build.gitSshKnownHosts).toBe(golden.build.git_ssh_known_hosts);
    // Each variable the job created; its preview copy is the model's created hook, which the SQL store repeats.
    expect(world.build.createdVariables).toEqual(golden.build.createdVariables.filter((variable) => !variable.is_preview));
    expect(golden.build.createdVariables.filter((variable) => variable.is_preview)).toEqual(world.build.createdVariables.map((variable) => ({ ...variable, is_preview: true })));
    // Sleeps, notifications, the jobs it hands on, and how the job ends.
    expect(world.sleeps).toEqual(golden.sleeps);
    expect(notifications(world.effects)).toEqual(golden.notifications);
    expect(jobs(world.effects)).toEqual(golden.jobs);
    expect(thrownText(state)).toBe(golden.thrown === null ? null : brand(golden.thrown));
    expect(state.next).toBe("done");
  });
});

describe("a build, one step at a time", () => {
  const builds = started.filter((run) => (BUILD_PACKS as readonly string[]).includes(packOf(run)));

  // What a Workflow keeps between two steps is the state as JSON, and it reads the rows again for every step.
  // Each golden build must come out the same that way: the same processes, log, sleeps and end.
  it.each(builds.map((run) => [run.id, run] as const))("%s", async (_id, run) => {
    const golden = goldenRun(run.id);
    const world = newWorld(run);
    const deps = depsOf(world, replayExecutor(world, golden.processes, run.cancelOn));
    let state = initialState(contextOf(run), deps.now());
    const visited: string[] = [];
    while (state.next !== "done") {
      visited.push(state.next);
      expect(visited.length).toBeLessThan(200);
      state = await runStep(deps, contextOf(run), JSON.parse(JSON.stringify(state)) as EngineState);
      if (state.wait) world.sleeps.push(...(state.wait.ticks ? Array<number>(state.wait.seconds).fill(1) : [state.wait.seconds]));
    }
    expect(world.mismatch).toBeNull();
    expect(world.processes).toEqual(golden.processes.map((p) => ({ script: p.script, ...(p.input === undefined ? {} : { input: p.input }) })));
    expect(compactLogs(world.deployment.logs)).toEqual(expectedLogs(golden.deployment!.logs ?? []));
    expect(world.sleeps).toEqual(golden.sleeps);
    expect(world.deployment.status).toBe(golden.deployment!.status);
    expect(thrownText(state)).toBe(golden.thrown === null ? null : brand(golden.thrown));
    for (const step of visited) expect(DEPLOYMENT_STEPS).toContain(step);
  });

  it("goes through the steps of its build pack: source, compose file, build, .env file, rolling update", async () => {
    const steps = async (id: string): Promise<string[]> => {
      const run = runCases.find((r) => r.id === id)!;
      const world = newWorld(run);
      const deps = depsOf(world, replayExecutor(world, goldenRun(id).processes));
      let state = initialState(contextOf(run), deps.now());
      const visited: string[] = [];
      while (state.next !== "done") {
        visited.push(state.next);
        state = await runStep(deps, contextOf(run), JSON.parse(JSON.stringify(state)) as EngineState);
      }
      return visited;
    };
    expect(await steps("dockerfile.first")).toEqual(["start", "detect", "prepare", "source", "configure", "build", "env", "deploy", "health", "drain", "remove_old", "post", "finish"]);
    // The image of the commit is there and nothing of its build changed: no build.
    expect(await steps("nixpacks.image-exists.same")).toEqual(["start", "detect", "prepare", "source", "configure", "env", "deploy", "health", "drain", "remove_old", "post", "finish"]);
    // A restart whose image is gone deploys in full, from the build pack's start.
    expect(await steps("static.restart.no-image")).toEqual(["start", "detect", "restart", "prepare", "source", "configure", "build", "env", "deploy", "health", "drain", "remove_old", "post", "finish"]);
    // A dropped connection during the clone: the source step waits, and goes on where it was.
    expect(await steps("dockerfile.clone-retry")).toEqual(["start", "detect", "prepare", "source", "source", "configure", "build", "env", "deploy", "health", "drain", "remove_old", "post", "finish"]);
    // A restart of a pasted Dockerfile looks for its image after the compose file, and writes that file again.
    expect(await steps("simple.restart")).toEqual(["start", "detect", "prepare", "source", "configure", "build", "configure", "env", "deploy", "health", "drain", "remove_old", "post", "finish"]);
    // A failed build: failed(), then the cleanup.
    expect(await steps("nixpacks.build-fails")).toEqual(["start", "detect", "prepare", "source", "configure", "build", "failed", "finish"]);
  });
});

describe("the engine, where no golden run reaches", () => {
  const base = runCases.find((run) => run.id === "run.rolling")!;

  it("a variable the job created is read once: from the state, or from the rows when they were read again", async () => {
    const run = runCases.find((r) => r.id === "nixpacks.laravel")!;
    const golden = goldenRun(run.id);
    const world = newWorld(run);
    const deps = depsOf(world, replayExecutor(world, golden.processes));
    let state = initialState(contextOf(run), deps.now());
    while (state.next !== "done") {
      // As the Workflow's store would: what the job created is among the rows of the next step.
      const ctx = contextOf(run);
      for (const made of world.build.createdVariables) {
        ctx.variables.push({ id: 100 + ctx.variables.length, key: made.key, value: made.value, realValue: made.value, is_literal: false, is_multiline: false, is_runtime: true, is_buildtime: true, is_shown_once: false, referencesLockedSharedVariable: false });
      }
      state = await runStep(deps, ctx, JSON.parse(JSON.stringify(state)) as EngineState);
    }
    expect(world.mismatch).toBeNull();
    expect(world.processes.map((p) => p.script)).toEqual(golden.processes.map((p) => p.script));
    expect(world.build.createdVariables.map((v) => v.key)).toEqual(["NIXPACKS_PHP_FALLBACK_PATH", "NIXPACKS_PHP_ROOT_DIR"]);
  });

  it("an SSH host key another deployment saved meanwhile is kept, and the log says the new one was not saved", async () => {
    const run = runCases.find((r) => r.id === "dockerfile.known-hosts")!;
    const golden = goldenRun(run.id);
    const world = newWorld(run);
    const deps = depsOf(world, replayExecutor(world, golden.processes));
    const other = "git.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyThatAnotherDeploymentSavedFirst00000000";
    // The other deployment's key arrives after this job read its application.
    const ctx = contextOf(run);
    world.build.gitSshKnownHosts = other;
    await runDeployment(deps, ctx);
    expect(world.mismatch).toBeNull();
    expect(world.build.gitSshKnownHosts).toBe(other);
    const outputs = compactLogs(world.deployment.logs);
    expect(outputs).toContainEqual({
      output: "Freeploy did not save the SSH host key of git.example.com (ssh-ed25519). Another deployment saved a different key of this type at the same time. Later deployments accept only the saved key.",
      type: "stderr",
    });
    expect(outputs.map((e) => e.output).filter((o) => o.startsWith("Saved the SSH host key"))).toEqual([]);
    expect(world.deployment.status).toBe("finished");
  });

  it("the key of the build secrets hash is derived from the deployment encryption key, one an org", async () => {
    const a = await buildSecretsHashKey("the-deployment-encryption-key", "00000000-0000-4000-8000-00000000000a");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await buildSecretsHashKey("the-deployment-encryption-key", "00000000-0000-4000-8000-00000000000a")).toBe(a);
    expect(await buildSecretsHashKey("the-deployment-encryption-key", "00000000-0000-4000-8000-00000000000b")).not.toBe(a);
    expect(a).not.toContain("the-deployment-encryption-key");
    expect(await buildSecretsHashKey(undefined, "00000000-0000-4000-8000-00000000000a")).toBe("");
    // hash_hmac('sha256', '', ''): an empty key is a key of zero bytes.
    expect(await hmacSha256Hex("", "")).toBe("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad");
  });

  it.each([
    ["a build server", (ctx: ReturnType<typeof contextOf>) => void (ctx.build.is_build_server_enabled = true), "App\\Exceptions\\DeploymentException: Building on a build server is not available yet: turn off \"Use a Build Server\" to build on the application's server."],
    ["a preserved repository", (ctx: ReturnType<typeof contextOf>) => void (ctx.build.is_preserve_repository_enabled = true), "App\\Exceptions\\DeploymentException: Deploying with \"Preserve Repository During Deployment\" is not available yet."],
    ["a deploy key", (ctx: ReturnType<typeof contextOf>) => void (ctx.build.private_key_id = 3), "App\\Exceptions\\DeploymentException: Deploying from a private repository with a deploy key is not available yet: only public repositories can be deployed."],
    ["a Git App source", (ctx: ReturnType<typeof contextOf>) => void (ctx.build.source_id = 12), "App\\Exceptions\\DeploymentException: Deploying from a Git App source is not available yet: only public repositories can be deployed."],
    ["HTTPS credentials", (ctx: ReturnType<typeof contextOf>) => void (ctx.build.has_git_https_credentials = true), "App\\Exceptions\\DeploymentException: Deploying from a repository with HTTPS credentials is not available yet: only public repositories can be deployed."],
    ["a base directory that is no safe path", (ctx: ReturnType<typeof contextOf>) => void (ctx.build.base_directory = "/app; rm -rf /"), "RuntimeException: Invalid base_directory: contains forbidden characters."],
    ["a base directory that leaves the repository", (ctx: ReturnType<typeof contextOf>) => void (ctx.build.base_directory = "/app/../.."), "RuntimeException: Invalid base_directory: path traversal detected."],
  ])("a build with %s is refused before anything runs on the server", async (_what, change, thrown) => {
    const run = runCases.find((r) => r.id === "nixpacks.first")!;
    const world = newWorld(run);
    const ctx = contextOf(run);
    change(ctx);
    // failed() removes the container the deployment would have started; nothing else runs.
    const state = await runDeployment(depsOf(world, replayExecutor(world, goldenRun("run.server-not-functional").processes)), ctx);
    expect(world.processes).toHaveLength(1);
    expect(world.deployment.status).toBe("failed");
    expect(thrownText(state)).toBe(thrown);
  });

  it("is a list of steps: run one at a time, with the state kept between them, it does the same", async () => {
    const run = runCases.find((r) => r.id === "run.rolling.healthy")!;
    const golden = goldenRun(run.id);
    const world = newWorld(run);
    const deps = depsOf(world, replayExecutor(world, golden.processes));
    let state = initialState(contextOf(run), deps.now());
    const visited: string[] = [];
    while (state.next !== "done") {
      visited.push(state.next);
      // What a Workflow keeps between two steps: the state as JSON, and the rows read again.
      state = await runStep(deps, contextOf(run), JSON.parse(JSON.stringify(state)) as EngineState);
      if (state.wait) world.sleeps.push(...(state.wait.ticks ? Array<number>(state.wait.seconds).fill(1) : [state.wait.seconds]));
    }
    expect(world.processes.map((p) => p.script)).toEqual(golden.processes.map((p) => p.script));
    expect(compactLogs(world.deployment.logs)).toEqual(expectedLogs(golden.deployment!.logs ?? []));
    expect(world.sleeps).toEqual(golden.sleeps);
    expect(world.deployment.status).toBe("finished");
    // start, detect, prepare, configure, deploy, health (its start and two attempts), drain, remove_old, post, finish.
    expect(visited).toEqual(["start", "detect", "prepare", "configure", "deploy", "health", "health", "health", "drain", "remove_old", "post", "finish"]);
    for (const step of visited) expect(DEPLOYMENT_STEPS).toContain(step);
  });

  it("a deployment that was cancelled before its job started runs nothing", async () => {
    const world = newWorld(base);
    world.deployment.status = "cancelled-by-user";
    const state = await runDeployment(depsOf(world, replayExecutor(world, [])), contextOf(base));
    expect(world.processes).toEqual([]);
    expect(compactLogs(world.deployment.logs)).toEqual([{ output: "Deployment was cancelled before starting." }]);
    expect(world.deployment.status).toBe("cancelled-by-user");
    expect(world.effects).toEqual([]);
    expect(state.thrown).toBeNull();
  });

  it("after a deployment ends, the queue advances: what the store started is dispatched", async () => {
    const golden = goldenRun(base.id);
    const world = newWorld(base);
    world.startNext = ["dep-next-1", "dep-next-2"];
    await runDeployment(depsOf(world, replayExecutor(world, golden.processes)), contextOf(base));
    expect(world.nextQueuedCalls).toEqual([{ applicationId: 1, serverId: 1 }]);
    expect(world.effects.filter((e) => e.type === "dispatch")).toEqual([
      { type: "dispatch", deploymentUuid: "dep-next-1" },
      { type: "dispatch", deploymentUuid: "dep-next-2" },
    ]);
    // The broadcasts Coolify sends, in their order.
    expect(world.effects.filter((e) => e.type === "event").map((e) => (e as { event: string }).event)).toEqual(["ApplicationConfigurationChanged", "ServiceStatusChanged"]);
  });

  it("a queue that cannot advance is a warning in the log, not a failed deployment", async () => {
    const golden = goldenRun(base.id);
    const world = newWorld(base);
    const deps = depsOf(world, replayExecutor(world, golden.processes));
    deps.store.startNextQueued = async () => {
      throw new Error("connection lost");
    };
    await runDeployment(deps, contextOf(base));
    expect(world.deployment.status).toBe("finished");
    expect(compactLogs(world.deployment.logs)).toContainEqual({ output: "Warning: Starting the next queued deployment failed: connection lost", type: "stderr" });
  });

  it.each([
    ["a Docker Compose application", (run: RunCase) => void (run.application.build_pack = "dockercompose"), "Deploying a Docker Compose application is not available yet."],
    ["another build pack", (run: RunCase) => void (run.application.build_pack = "railpack"), "Deploying the railpack build pack is not available yet."],
    ["a non-root server", (run: RunCase) => void (run.server.user = "deploy"), "Deploying to a server with a non-root user (deploy) is not available yet."],
    ["a file storage with content", (run: RunCase) => void run.fileStorages.push({ fs_path: "/data/x/app.conf", mount_path: "/etc/app.conf", content: "a=b" }), "Deploying an application with file storages is not available yet: their content is not written to the server."],
  ])("refuses %s before anything runs on the server", async (_what, change, message) => {
    const run = JSON.parse(JSON.stringify(base)) as RunCase;
    change(run);
    const world = newWorld(run);
    // failed() removes the container the deployment would have started; nothing else runs.
    const removal = goldenRun("run.server-not-functional").processes;
    const state = await runDeployment(depsOf(world, replayExecutor(world, removal)), contextOf(run));
    expect(world.processes).toHaveLength(1);
    expect(world.deployment.status).toBe("failed");
    expect(thrownText(state)).toBe(`App\\Exceptions\\DeploymentException: ${message}`);
    expect(compactLogs(world.deployment.logs).map((e) => e.output)).toContain(`Deployment failed: ${message}`);
  });

  it("a variable name that would break a line of the .env file stops the deployment, explained in the log", async () => {
    const run = JSON.parse(JSON.stringify(base)) as RunCase;
    run.variables.push({ key: "A=B", value: "x", is_runtime: true, is_buildtime: false });
    const world = newWorld(run);
    const state = await runDeployment(depsOf(world, replayExecutor(world, goldenRun("run.server-not-functional").processes)), contextOf(run));
    const outputs = compactLogs(world.deployment.logs).map((e) => e.output);
    expect(outputs.slice(0, 6)).toEqual([
      "----------------------------------------",
      "⚠️ Invalid environment variable name from the deployment environment: A=B",
      "Build-time variable names must start with a letter or underscore and contain only letters, numbers, underscores, and dots.",
      "💡 How to fix:",
      "Rename the environment variable to use only letters, numbers, and underscores, then redeploy.",
      "----------------------------------------",
    ]);
    // The log already explains it: failed() does not repeat the message.
    expect(outputs).toContain("Deployment failed.");
    expect(state.thrown?.alreadyLogged).toBe(true);
    expect(world.deployment.status).toBe("failed");
  });
});
