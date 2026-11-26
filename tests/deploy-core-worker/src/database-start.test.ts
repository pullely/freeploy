// Starting, stopping and restarting a standalone database, and its TCP proxy (DP-62), replayed against
// Coolify's own PHP. fixtures/database-start/goldens.json holds, for every case of cases.json, what
// coollabsio/coolify@91b7e3e's real StartDatabase, DatabaseStartJob, the engine's Start action, RestartDatabase,
// StopDatabase, StartDatabaseProxy and StopDatabaseProxy did on a faked server: each SSH process they started,
// the start's log, the rows they left, how long they slept, and what they queued, notified and broadcast. Here
// the engine runs every one of those cases against an executor that plays the same server: it must start the
// same processes in the same order — which holds the docker-compose file and the whole command list of a start,
// byte for byte — and leave the same rows. Nothing is started anywhere: until the SSH executor is deployed
// (WAITING.md W3) this replay and the PHP goldens are the only proof the engine has.
import { ENGINES, GOLDEN_NOW, LAST_ONLINE_AT, contextOf, depsOf, goldenRun, masked, newWorld, replayExecutor, runCases, scriptedExecutor, type GoldenRun, type RunCase, type World } from "./database-start-fixtures";
import {
  DATABASE_OPERATION_MESSAGES,
  initialStartState,
  runDatabaseProxyStart,
  runDatabaseProxyStop,
  runDatabaseRestart,
  runDatabaseStart,
  runDatabaseStop,
  runStartStep,
  type DatabaseEffect,
  type DatabaseStartState,
} from "@deploy-core-worker/databases/start-engine";
import { buildStartPlan } from "@deploy-core-worker/databases/start-plan";
import { buildProxyPlan } from "@deploy-core-worker/databases/proxy-plan";
import { parseCertificate, readCertificatePem } from "@deploy-core-worker/ssl/x509";

/** The decoded docker-compose file a command batch writes with `tee`; null when it writes none. */
function composeOf(scripts: string[]): string | null {
  let compose: string | null = null;
  for (const script of scripts) {
    const match = /^echo '([A-Za-z0-9+/=]+)' \| base64 -d \| tee \S+\/docker-compose\.ya?ml > \/dev\/null$/m.exec(script);
    if (match) compose = Buffer.from(match[1]!, "base64").toString("utf8");
  }
  return compose;
}

const NAME_ATTRIBUTES: Record<string, string> = { "2.5.4.3": "CN", "2.5.4.10": "O", "2.5.4.6": "C", "2.5.4.8": "ST" };
const CURVES: Record<string, string> = { "06082a8648ce3d030107": "prime256v1", "06052b81040023": "secp521r1" };

/** A certificate's names, days of validity, signature algorithm and key curve, as emit.php tells them of Coolify's. */
function factsOf(pem: string) {
  const parsed = parseCertificate(readCertificatePem(pem)!);
  const name = (attributes: Array<{ oid: string; value: string }>) => Object.fromEntries(attributes.map((a) => [NAME_ATTRIBUTES[a.oid] ?? a.oid, a.value]));
  return {
    subject: name(parsed.subject),
    issuer: name(parsed.issuer),
    validDays: Math.floor((parsed.notAfter!.getTime() - parsed.notBefore!.getTime()) / 86_400_000),
    signature: parsed.signatureAlgorithm === "1.2.840.10045.4.3.4" ? "ecdsa-with-SHA512" : parsed.signatureAlgorithm,
    curve: CURVES[Buffer.from(parsed.publicKeyParameters ?? []).toString("hex")] ?? null,
  };
}

/** The jobs Coolify queued, but for the start's own job: the engine is that job. */
const goldenJobs = (golden: GoldenRun): string[] => golden.jobs.filter((job) => job !== "DatabaseStartJob").sort();
const jobs = (effects: DatabaseEffect[]): string[] => effects.flatMap((e) => (e.type === "job" ? [e.job] : [])).sort();
const events = (effects: DatabaseEffect[]): string[] => effects.flatMap((e) => (e.type === "event" ? [e.event] : [])).sort();
const notifications = (effects: DatabaseEffect[]): string[] => effects.flatMap((e) => (e.type === "notify" ? [e.notification] : []));

interface Replayed {
  world: World;
  /** A start's or a restart's state. */
  state: DatabaseStartState | null;
  /** What a stop answered. */
  answer: string | null;
  /** "<class>: <message>" of what a proxy action threw. */
  thrown: string | null;
}

async function replay(run: RunCase, golden: GoldenRun): Promise<Replayed> {
  const world = newWorld(run);
  const deps = depsOf(world, replayExecutor(world, golden.processes));
  const reload = async () => contextOf(world);
  const out: Replayed = { world, state: null, answer: null, thrown: null };
  try {
    if (run.action === "start") out.state = await runDatabaseStart(deps, contextOf(world), reload);
    else if (run.action === "restart") out.state = await runDatabaseRestart(deps, contextOf(world), reload);
    else if (run.action === "stop") out.answer = await runDatabaseStop(deps, contextOf(world), run.dockerCleanup ?? true);
    else if (run.action === "proxy-start") await runDatabaseProxyStart(deps, contextOf(world));
    else await runDatabaseProxyStop(deps, contextOf(world));
  } catch (e) {
    if (world.mismatch !== null) throw e;
    out.thrown = `RuntimeException: ${e instanceof Error ? e.message : String(e)}`;
  }
  return out;
}

/** Where the engine may not be Coolify: each id is listed in the README with its reason. */
const KNOWN_DIFFERENCES: ReadonlySet<string> = new Set<string>([]);

describe("fixtures/database-start", () => {
  it("has at least twelve start cases for each engine, and a golden run for every case", () => {
    for (const engine of ENGINES) {
      const starts = runCases.filter((run) => run.engine === engine && run.action === "start");
      expect(starts.length).toBeGreaterThanOrEqual(12);
      // SQLite (DP-112) has no TCP proxy, so no proxy runs and no public restart or stop.
      expect(runCases.filter((run) => run.engine === engine && run.action !== "start").length).toBeGreaterThanOrEqual(engine === "sqlite" ? 11 : 12);
    }
    for (const run of runCases) expect(goldenRun(run.id)).toBeDefined();
    expect(KNOWN_DIFFERENCES.size).toBe(0);
  });
});

describe.each(ENGINES)("%s, replayed against Coolify's own run", (engine) => {
  const cases = runCases.filter((run) => run.engine === engine);

  it.each(cases.map((run) => [run.id, run] as const))("%s", async (_id, run) => {
    const golden = goldenRun(run.id);
    const { world, state, answer, thrown } = await replay(run, golden);

    // Every process Coolify started, and no other: the executor refuses a different one on the way. With a
    // start's batch this is its whole command list, and the compose file inside it, byte for byte.
    expect(world.mismatch).toBeNull();
    expect(world.processes.map((p) => p.script)).toEqual(golden.processes.map((p) => p.script));
    expect(composeOf(world.processes.map((p) => p.script))).toBe(composeOf(golden.processes.map((p) => p.script)));

    // What the action answered.
    if (run.action === "start" || run.action === "restart") {
      expect(state!.refused === null ? { activity: true } : state!.refused).toEqual(golden.result);
      expect(state!.thrown === null ? null : `${state!.thrown.phpClass}: ${state!.thrown.message}`).toBe(golden.jobThrown);
      expect(state!.step).toBeNull();
      // The start's log and how it ended.
      const activity = state!.activity;
      expect(activity === null ? null : { status: activity.status, exitCode: activity.exitCode, error: activity.error, log: activity.log.map((entry) => ({ type: entry.type, output: entry.output })) }).toEqual(
        golden.activity === null ? null : { status: golden.activity.status, exitCode: golden.activity.exitCode, error: golden.activity.error, log: golden.activity.log },
      );
      if (activity) expect(activity.log.map((entry) => entry.order)).toEqual(activity.log.map((_, index) => index + 1));
    } else if (run.action === "stop") {
      expect(answer).toBe(golden.result);
    } else {
      expect(thrown).toBe(golden.thrown);
    }

    // The database's row.
    expect(world.database.status).toBe(golden.database.status);
    expect(world.database.last_online_at).toBe(golden.database.last_online_at);
    expect(world.database.is_public).toBe(golden.database.is_public);
    expect([world.database.restart_count, world.database.last_restart_at, world.database.last_restart_type]).toEqual([golden.database.restart_count, golden.database.last_restart_at, golden.database.last_restart_type]);
    if (golden.database.conf !== undefined) expect(world.database.conf).toBe(golden.database.conf);
    // started_at is Freeploy's: Coolify leaves it to the page. It is set as soon as a start may reach the server.
    const reachesServer = (run.action === "start" || run.action === "restart") && golden.result !== DATABASE_OPERATION_MESSAGES.serverNotFunctional && !(run.action === "restart" && typeof golden.result === "string");
    expect(world.database.started_at).toBe(reachesServer ? (golden.database.started_at ?? GOLDEN_NOW.slice(0, 19).replace("T", " ")) : golden.database.started_at);

    // Its certificates, file mounts and variables.
    expect(world.certificates.map(({ certificate: _c, privateKey: _k, ...row }) => ({ ...row, subject_alternative_names: row.subject_alternative_names ?? [] }))).toEqual(
      golden.certificates.map((row) => ({ ...row, subject_alternative_names: row.subject_alternative_names ?? [] })),
    );
    expect(world.fileStorages.map((f) => ({ fs_path: f.fs_path, mount_path: f.mount_path, content: f.content === null ? null : masked(world, f.content), is_directory: f.is_directory, chmod: f.chmod, chown: f.chown }))).toEqual(golden.fileStorages);
    // (A variable without a value reads "" from the model and null from the row.)
    expect(world.variables.map((v) => ({ key: v.key, value: v.value ?? "" }))).toEqual(golden.variables.map((v) => ({ key: v.key, value: v.value ?? "" })));

    // A certificate Coolify generated and the one generated here cannot be the same bytes (a fresh key, a
    // random serial): they are masked in everything above, and held to the same names, validity and signature.
    for (const [which, generated] of [["ca", world.generated.ca], ["certificate", world.generated.leaf]] as const) {
      const facts = golden.generated?.[which];
      expect(generated !== null).toBe(facts !== undefined);
      if (generated && facts) expect(factsOf(generated.sslCertificate)).toEqual({ subject: facts.subject, issuer: facts.issuer, validDays: facts.validDays, signature: facts.signature, curve: facts.curve });
    }

    // Sleeps, and what it hands on.
    expect(world.sleeps).toEqual(golden.sleeps);
    expect(jobs(world.effects)).toEqual(goldenJobs(golden));
    expect(events(world.effects)).toEqual([...golden.events].sort());
    expect(notifications(world.effects)).toEqual(golden.notifications);
  });
});

describe("the plan of a start, on its own", () => {
  const input = (run: RunCase, contentFileCommands: string[] = []) => {
    const ctx = contextOf(newWorld(run));
    return { engine: ctx.engine, database: ctx.database, projectName: ctx.projectName, environmentName: ctx.environmentName, network: ctx.network, server: ctx.server, persistentStorages: ctx.persistentStorages, fileStorages: ctx.fileStorages, variables: ctx.variables, ssl: null, contentFileCommands, now: new Date(GOLDEN_NOW) };
  };

  it.each(ENGINES)("%s: is a pure function of the rows — the compose file and the command list of Coolify's batch", (engine) => {
    const run = runCases.find((r) => r.id === `${engine}.defaults`)!;
    const golden = goldenRun(run.id);
    const batch = golden.processes.find((p) => p.script.startsWith("echo 'Starting database.'"))!;
    const plan = buildStartPlan(input(run));
    expect(plan.commands.join("\n")).toBe(batch.script);
    expect(plan.compose).toBe(composeOf([batch.script]));
    expect(plan.composeFile).toBe(`/data/coolify/databases/${String(run.database.uuid)}/docker-compose.yml`);
    // Twice the same.
    expect(buildStartPlan(input(run))).toEqual(plan);
  });

  it("puts what the content file check says before the engine's own files", () => {
    const run = runCases.find((r) => r.id === "postgresql.defaults")!;
    const plan = buildStartPlan(input(run, ["echo 'Writing 1 missing configuration file.'"]));
    const at = plan.commands.indexOf("echo 'Writing 1 missing configuration file.'");
    expect(plan.commands[at - 1]).toBe("rm -rf /data/coolify/databases/db0000000000000000000001/ssl");
    expect(plan.commands[at + 1]).toMatch(/^find .*docker-entrypoint-initdb\.d/);
  });

  it("the proxy's plan is a pure function too", () => {
    const run = runCases.find((r) => r.id === "postgresql.proxy start with ipv6 and a timeout")!;
    const golden = goldenRun(run.id);
    const plan = buildProxyPlan({ engine: "postgresql", uuid: String(run.database.uuid), network: "coolify", publicPort: 15432, publicPortTimeout: 120, enableSsl: false, ipv6Enabled: true });
    expect(plan.commands.join("\n")).toBe(golden.processes[1]!.script);
    expect(plan.nginxConf).toContain("listen 15432;\n        listen [::]:15432;");
    expect(plan.nginxConf).toContain("proxy_timeout 120s;");
    expect(plan.compose).toBe(composeOf([golden.processes[1]!.script]));
  });
});

describe("the engine, step by step", () => {
  const caseOf = (id: string): RunCase => runCases.find((run) => run.id === id)!;

  it("is a list of steps: run one at a time, with the state kept between them, it does the same", async () => {
    const run = caseOf("postgresql.ssl generated");
    const golden = goldenRun(run.id);
    const world = newWorld(run);
    const deps = depsOf(world, replayExecutor(world, golden.processes));
    let state = initialStartState();
    const visited: string[] = [];
    while (state.step !== null) {
      visited.push(state.step);
      // The state between two steps is plain data.
      state = await runStartStep(deps, contextOf(world), JSON.parse(JSON.stringify(state)) as DatabaseStartState);
    }
    expect(visited).toEqual(["check", "start", "status"]);
    expect(world.mismatch).toBeNull();
    expect(world.processes.map((p) => p.script)).toEqual(golden.processes.map((p) => p.script));
    expect(state.activity!.status).toBe("finished");
    expect(state.status).toBe("running:healthy");
    expect(world.database.status).toBe("running:healthy");
  });

  it("marks the database as started before the first command reaches the server", async () => {
    const run = caseOf("mysql.ssl generated");
    const world = newWorld(run);
    const startedAtFirstProcess: Array<string | null> = [];
    const inner = scriptedExecutor(world);
    const deps = depsOf(world, {
      run: (process, onOutput) => {
        startedAtFirstProcess.push(world.database.started_at);
        return inner.run(process, onOutput);
      },
    });
    expect(world.database.started_at).toBeNull();
    await runDatabaseStart(deps, contextOf(world), async () => contextOf(world));
    expect(startedAtFirstProcess.length).toBeGreaterThan(3);
    expect(startedAtFirstProcess.every((at) => at === "2026-11-20 10:11:12")).toBe(true);
  });

  it("keeps the first start's date at a later start", async () => {
    const run = caseOf("redis.already running");
    const world = newWorld(run);
    await runDatabaseStart(depsOf(world, scriptedExecutor(world)), contextOf(world), async () => contextOf(world));
    expect(world.database.started_at).toBe("2026-11-01 08:00:00");
  });

  it("does not mark a database whose server cannot be reached, and starts nothing", async () => {
    const run = caseOf("keydb.server unreachable");
    const world = newWorld(run);
    const state = await runDatabaseStart(depsOf(world, scriptedExecutor(world)), contextOf(world));
    expect(state).toEqual({ step: null, refused: "Server is not functional", activity: null, thrown: null, status: null });
    expect(world.processes).toEqual([]);
    expect(world.database.started_at).toBeNull();
    expect(world.database.last_online_at).toBe(LAST_ONLINE_AT);
  });

  it("a successful start: one batch, the log as it arrives, then the container's status", async () => {
    const run = caseOf("mariadb.defaults");
    const world = newWorld(run);
    const state = await runDatabaseStart(depsOf(world, scriptedExecutor(world)), contextOf(world), async () => contextOf(world));
    expect(world.processes.map((p) => p.script.split("\n")[0])).toEqual(["echo 'Starting database.'", "docker container inspect 'db0000000000000000000001' --format '{{json .}}'"]);
    expect(state.activity).toMatchObject({ status: "finished", exitCode: 0, error: null });
    expect(state.activity!.log.map((entry) => [entry.type, entry.output])).toEqual([["out", "Starting database.\nDatabase started.\n"]]);
    expect(world.database).toMatchObject({ status: "running:healthy", started_at: "2026-11-20 10:11:12", last_online_at: "2026-11-20 10:11:12" });
    expect(world.effects).toEqual([{ type: "event", event: "DatabaseStatusChanged" }]);
  });

  it("a failed pull: the batch stops, the start fails with Coolify's words, and the status is not asked for", async () => {
    const run = caseOf("mongodb.pull fails");
    const world = newWorld(run);
    const state = await runDatabaseStart(depsOf(world, scriptedExecutor(world)), contextOf(world), async () => contextOf(world));
    expect(world.processes).toHaveLength(1);
    // The pull comes before the old container is stopped: a failed pull keeps a running database running.
    const commands = world.processes[0]!.script.split("\n");
    const pull = commands.findIndex((c) => c.endsWith("docker-compose.yml pull"));
    expect(pull).toBeGreaterThan(0);
    expect(commands.findIndex((c) => c.startsWith("docker stop"))).toBeGreaterThan(pull);
    expect(state.thrown).toEqual({ phpClass: "RuntimeException", message: "Error response from daemon: pull access denied for nope, repository does not exist\n" });
    expect(state.activity).toMatchObject({ status: "error", exitCode: 1, error: "Database start failed.", failedAt: "2026-11-20T10:11:12+00:00" });
    expect(state.activity!.log.map((entry) => [entry.type, entry.output])).toEqual([
      ["out", "Starting database.\nPulling image.\n"],
      ["err", "Error response from daemon: pull access denied for nope, repository does not exist\n"],
      ["stderr", "\nDatabase start failed.\n"],
    ]);
    expect(world.database.status).toBe("exited");
    // Something may be on the server now.
    expect(world.database.started_at).toBe("2026-11-20 10:11:12");
    expect(world.effects).toEqual([{ type: "event", event: "DatabaseStatusChanged" }]);
  });

  it("a failing command without output: the exit code is kept", async () => {
    const run = caseOf("dragonfly.command fails without output");
    const world = newWorld(run);
    const state = await runDatabaseStart(depsOf(world, scriptedExecutor(world)), contextOf(world), async () => contextOf(world));
    expect(state.thrown).toEqual({ phpClass: "RuntimeException", message: "" });
    expect(state.activity).toMatchObject({ status: "error", exitCode: 125, error: "Database start failed." });
    expect(state.activity!.log.map((entry) => entry.output)).toEqual(["\nDatabase start failed.\n"]);
  });

  it("output without a line break at its end stays one entry until the process ends", async () => {
    const run = caseOf("clickhouse.defaults");
    const world = newWorld(run);
    const deps = depsOf(world, {
      run: async (process, onOutput) => {
        world.processes.push({ script: process.script });
        if (!process.script.startsWith("echo 'Starting database.'")) return { exitCode: 0, stdout: "", stderr: "" };
        await onOutput?.("out", "one\ntw");
        await onOutput?.("err", "warn");
        await onOutput?.("out", "o\rthree");
        return { exitCode: 0, stdout: "one\ntwo\rthree", stderr: "warn" };
      },
    });
    const state = await runDatabaseStart(deps, contextOf(world), async () => contextOf(world));
    expect(state.activity!.log.map((entry) => [entry.type, entry.output, entry.order])).toEqual([
      ["out", "one\n", 1],
      ["out", "two\r", 2],
      ["out", "three", 3],
      ["err", "warn", 4],
    ]);
  });

  it("a restart with a variable that needs a secret manager is refused before anything is stopped", async () => {
    const run = caseOf("postgresql.restart with a vault reference");
    const world = newWorld(run);
    const state = await runDatabaseRestart(depsOf(world, scriptedExecutor(world)), contextOf(world));
    expect(state.refused).toBe("Environment variables reference remote secrets, but no secret manager source is configured.");
    expect(world.processes).toEqual([]);
    expect(world.database.status).toBe("running:healthy");
  });

  it("refuses a server with a non-root user, which needs sudo", async () => {
    const run = { ...caseOf("postgresql.defaults"), server: { ...caseOf("postgresql.defaults").server, user: "deploy" } };
    const world = newWorld(run);
    const state = await runDatabaseStart(depsOf(world, scriptedExecutor(world)), contextOf(world));
    expect(state.refused).toBe(DATABASE_OPERATION_MESSAGES.nonRootServer);
    expect(world.processes).toEqual([]);
    expect(world.database.started_at).toBeNull();
  });
});
