// The Docker image deployment (DP-56), replayed against Coolify's own PHP. fixtures/deployments/goldens.json
// holds, for every case of cases.json, what coollabsio/coolify@91b7e3e's real ApplicationDeploymentJob did on a
// faked server: each SSH process it started (script and stdin), the deployment log it wrote, the statuses it
// left, how long it slept, what it notified and queued, and what it threw. Here the engine runs every one of
// those cases against an executor that plays the same server: it must start the same processes in the same
// order, and leave the same log and the same statuses. Nothing is deployed anywhere: until the SSH executor is
// deployed (WAITING.md W3) this replay and the PHP goldens are the only proof the engine has.
import { goldenRun, runCases, type GoldenLog, type GoldenRun, type RunCase } from "./deployment-goldens";
import { compactLogs, contextOf, depsOf, newWorld, replayExecutor, type World } from "./deployment-fixtures";
import { DEPLOYMENT_STEPS, initialState, runDeployment, runStep, thrownText, type DeploymentEffect, type EngineState } from "@deploy-core-worker/deployments/engine";

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

describe("the Docker image deployment, replayed against Coolify's ApplicationDeploymentJob", () => {
  it("has a golden run for every case, and enough of them", () => {
    expect(started.length).toBeGreaterThanOrEqual(120);
    for (const run of runCases) expect(goldenRun(run.id)).toBeDefined();
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
    // Sleeps, notifications, the jobs it hands on, and how the job ends.
    expect(world.sleeps).toEqual(golden.sleeps);
    expect(notifications(world.effects)).toEqual(golden.notifications);
    expect(jobs(world.effects)).toEqual(golden.jobs);
    expect(thrownText(state)).toBe(golden.thrown === null ? null : brand(golden.thrown));
    expect(state.next).toBe("done");
  });
});

describe("the engine, where no golden run reaches", () => {
  const base = runCases.find((run) => run.id === "run.rolling")!;

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
    ["another build pack", (run: RunCase) => void (run.application.build_pack = "nixpacks"), "Deploying the nixpacks build pack is not available yet."],
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
