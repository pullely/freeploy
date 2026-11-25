// The routes of DP-62: POST …/deploy/databases/{uuid}/{start,restart,stop}, the Access listbox of PATCH, and
// POST …/ssl/regenerate. Without the SSH executor's binding (env.SSH_SESSION — which is how the worker is
// deployed today) the three actions and a running database's proxy answer 501 and store nothing. With a fake
// binding the handler runs the engine: the server here is an executor that answers what a case of
// fixtures/database-start scripts, and the rows are that case's world in memory — the processes are compared
// with the ones Coolify's own PHP started for the same case.
import type { DatabaseColumnValue, DatabaseEngine, DeployDatabaseRow, DeployDatabaseVariableRow } from "@saas/db/deploy";
import { DATABASE_TABLES } from "@saas/db/deploy";
import type { Env } from "@deploy-core-worker/env";
import { handleDatabases, type DatabaseActionRunner, type DatabaseRunner } from "@deploy-core-worker/handlers/databases";
import { DATABASE_SERVICE_MESSAGES, type DatabaseStore } from "@deploy-core-worker/databases/service";
import { OPERATION_MESSAGES, type DatabaseServerAccess } from "@deploy-core-worker/databases/operations";
import type { DeploymentExecutor } from "@deploy-core-worker/deployments/engine";
import { generateSslCertificate } from "@deploy-core-worker/ssl/ssl-helper";
import { GOLDEN_NOW, contextOf, goldenRun, newWorld, runCases, scriptedExecutor, storeOf, type Response as ScriptedResponse, type RunCase, type World } from "./database-start-fixtures";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const UUID = "db0000000000000000000001";
const UNAVAILABLE = (what: string) => `${what} needs the SSH executor, which is not available yet.`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

/** A value sealed for one column, as the org's cipher binds it. */
const seal = (column: string, plaintext: string) => `fp1:1:${column}:${Buffer.from(plaintext).toString("base64")}`;
function open(column: string, stored: string): string {
  const prefix = `fp1:1:${column}:`;
  if (!stored.startsWith(prefix)) throw new Error(`${stored} is not sealed for ${column}`);
  return Buffer.from(stored.slice(prefix.length), "base64").toString();
}

interface Answer {
  status: number;
  data: Record<string, unknown>;
  error: { code: string; message: string };
}

/** The world of one case of fixtures/database-start behind the handler. */
function setup(caseId: string, opts: { ssh?: boolean; write?: boolean; key?: boolean; responses?: ScriptedResponse[]; change?: (run: RunCase) => RunCase } = {}) {
  const base = runCases.find((run) => run.id === caseId)!;
  const run = opts.change ? opts.change(structuredClone(base)) : base;
  const world: World = newWorld(run);
  const engine: DatabaseEngine = run.engine;
  const executor: DeploymentExecutor = scriptedExecutor(world, [...(opts.responses ?? []), ...run.responses]);
  /** Columns the General page wrote, which the fixtures' world does not hold. */
  const extra: Record<string, DatabaseColumnValue> = {};
  const updates: Array<Record<string, DatabaseColumnValue>> = [];
  let actionRuns = 0;

  const row = (): DeployDatabaseRow => {
    const ctx = contextOf(world);
    const table = DATABASE_TABLES[engine];
    const own = Object.fromEntries(table.columns.map((c) => [c, ctx.database.values[c] === undefined || ctx.database.values[c] === null ? null : table.encrypted.includes(c) ? seal(`${table.table}.${c}`, ctx.database.values[c]!) : ctx.database.values[c]]));
    return {
      engine,
      id: 5,
      uuid: UUID,
      name: ctx.database.name,
      description: null,
      status: world.database.status,
      image: ctx.database.image,
      is_public: world.database.is_public,
      public_port: ctx.database.public_port,
      public_port_timeout: ctx.database.public_port_timeout,
      ports_mappings: ctx.database.ports_mappings,
      started_at: world.database.started_at,
      destination_id: 21,
      destination_type: "App\\Models\\StandaloneDocker",
      environment_id: 11,
      is_log_drain_enabled: ctx.database.is_log_drain_enabled,
      config_hash: null,
      custom_docker_run_options: ctx.database.custom_docker_run_options,
      last_online_at: world.database.last_online_at,
      created_at: null,
      updated_at: null,
      enable_ssl: table.enableSsl ? ctx.database.enable_ssl : null,
      ssl_mode: table.sslMode ? ctx.database.ssl_mode : null,
      legacy_password_quoting: table.legacyPasswordQuoting ? ctx.database.legacy_password_quoting : null,
      environment_uuid: "env1",
      environment_name: ctx.environmentName,
      project_uuid: "prj1",
      project_name: ctx.projectName,
      destination_uuid: "dst1",
      destination_name: "coolify",
      destination_network: ctx.network,
      server_id: 7,
      server_uuid: "srv1",
      server_name: "srv",
      server_ip: ctx.server.ip,
      server_is_swarm_manager: false,
      server_is_swarm_worker: false,
      server_is_reachable: Boolean(run.serverSettings.is_reachable),
      server_is_usable: Boolean(run.serverSettings.is_usable),
      server_force_disabled: Boolean(run.serverSettings.force_disabled),
      server_is_logdrain_newrelic_enabled: false,
      server_is_logdrain_axiom_enabled: false,
      server_is_logdrain_custom_enabled: false,
      server_is_logdrain_cloudwatch_enabled: false,
      ...own,
      ...extra,
    } as unknown as DeployDatabaseRow;
  };

  const refuse = (): never => {
    throw new Error("not a part of these routes");
  };
  const store: DatabaseStore = {
    findProject: refuse,
    findEnvironment: refuse,
    findDestination: refuse,
    findServer: refuse,
    insert: refuse,
    findByUuid: async (uuid) => (uuid === UUID ? row() : null),
    update: async (_engine, _id, changes) => {
      updates.push(changes);
      for (const [column, value] of Object.entries(changes)) {
        if (column === "is_public") world.database.is_public = value === true;
        else if (column === "public_port" || column === "public_port_timeout") run.database[column] = value;
        else extra[column] = value;
      }
      return row();
    },
    findVariable: async (_engine, _id, key) => {
      const found = world.variables.find((v) => v.key === key);
      return found ? ({ id: 1, uuid: "var1", key, value: found.value === null ? null : seal("environment_variables.value", found.value), is_shown_once: false, is_shared: false } as unknown as DeployDatabaseVariableRow) : null;
    },
    insertVariable: refuse,
    updateVariableValue: refuse,
    certificateValidUntil: async () => world.certificates.find((c) => c.resource === "database")?.valid_until ?? null,
    delete: refuse,
  };

  /** What the SQL runtime builds from the rows and the binding: here, from the case's world. */
  const access = (): DatabaseServerAccess => ({
    context: async () => contextOf(world),
    store: storeOf(world),
    executor: opts.ssh && opts.key !== false ? executor : null,
    now: () => new Date(GOLDEN_NOW),
    sleep: async (seconds) => {
      world.sleeps.push(seconds);
    },
    generateCertificate: (options) => generateSslCertificate({ ...options, now: new Date(GOLDEN_NOW) }),
  });

  const asked: string[] = [];
  const env: Env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      asked.push(body.action);
      const allow = body.action === "deploy.resource.write" ? (opts.write ?? true) : true;
      return json({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
    // A fake binding: its presence is what the handler looks at.
    ...(opts.ssh ? { SSH_SESSION: {} as NonNullable<Env["SSH_SESSION"]> } : {}),
  };
  const runner: DatabaseRunner = (_env, _orgId, fn) =>
    fn({
      store,
      cipher: (column) => ({ encrypt: async (plaintext) => seal(column, plaintext), decrypt: async (stored) => open(column, stored) }),
      server: async (uuid) => (uuid === UUID ? access() : null),
    });
  const actionRunner: DatabaseActionRunner = async (_env, orgId, uuid, fn) => {
    actionRuns++;
    expect(orgId).toBe(ORG_UUID);
    return uuid === UUID ? fn(access()) : null;
  };
  const call = async (method: string, path: string, body?: unknown): Promise<Answer> => {
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const segments = path.split("/").filter(Boolean);
    const res = await handleDatabases(env, "req_1", actor, ORG_UUID, segments, new Request(`${BASE}/databases/${path}`, init), runner, actionRunner);
    const parsed = (await res.json()) as { data?: Record<string, unknown>; error?: Answer["error"] };
    return { status: res.status, data: parsed.data ?? {}, error: parsed.error ?? { code: "", message: "" } };
  };
  const scripts = (): string[] => world.processes.map((p) => p.script);
  return { run, world, call, scripts, updates, asked, actionRuns: () => actionRuns };
}

const firstLines = (scripts: string[]): string[] => scripts.map((script) => script.split("\n")[0]!);

describe("without the SSH executor (env.SSH_SESSION is not bound: every deployment today)", () => {
  it.each([
    ["start", "Starting the database"],
    ["restart", "Restarting the database"],
    ["stop", "Stopping the database"],
  ] as const)("POST …/%s answers 501 and stores nothing", async (action, what) => {
    const t = setup("postgresql.already running");
    const before = structuredClone(t.world.database);
    const r = await t.call("POST", `${UUID}/${action}`);
    expect([r.status, r.error.code, r.error.message]).toEqual([501, "unsupported", UNAVAILABLE(what)]);
    expect(t.world.database).toEqual(before);
    expect(t.world.processes).toEqual([]);
    expect(t.updates).toEqual([]);
    // The engine is never opened.
    expect(t.actionRuns()).toBe(0);
    expect((await t.call("POST", `nope/${action}`)).status).toBe(404);
    expect((await t.call("GET", `${UUID}/${action}`)).status).toBe(405);
  });

  it("a database that was never started keeps started_at empty, so it can still be deleted at once", async () => {
    const t = setup("mysql.defaults");
    expect((await t.call("POST", `${UUID}/start`)).status).toBe(501);
    expect(t.world.database.started_at).toBeNull();
    expect(t.world.database.status).toBe("exited");
  });

  it("PATCH instantSave: a running database's proxy needs the server — 501, nothing stored", async () => {
    const t = setup("postgresql.already running");
    const save = (body: Record<string, unknown>) => t.call("PATCH", UUID, { action: "instantSave", ...body });
    const make = await save({ isPublic: true, publicPort: 15432 });
    expect([make.status, make.error.message]).toEqual([501, UNAVAILABLE("Starting the database's TCP proxy on the server")]);
    const unmake = await save({ isPublic: false });
    expect([unmake.status, unmake.error.message]).toEqual([501, UNAVAILABLE("Stopping the database's TCP proxy on the server")]);
    expect(t.updates).toEqual([]);
    expect(t.world.database.is_public).toBe(false);
    expect(t.world.processes).toEqual([]);
  });

  it("PATCH instantSave: a database that never started is made private in the rows alone", async () => {
    const t = setup("postgresql.defaults");
    const r = await t.call("PATCH", UUID, { action: "instantSave", isPublic: false, publicPort: 15432 });
    expect([r.status, r.data.message]).toEqual([200, "Database is no longer publicly accessible."]);
    expect(t.updates).toEqual([{ public_port: 15432 }]);
    expect(t.world.processes).toEqual([]);
  });

  it("POST …/ssl/regenerate: the rows of a new certificate are stored; its files wait for the server", async () => {
    const t = setup("postgresql.ssl require");
    const before = t.world.certificates.find((c) => c.resource === "database")!;
    const r = await t.call("POST", `${UUID}/ssl/regenerate`);
    expect([r.status, r.data.message, r.data.unavailable]).toEqual([200, "SSL certificates regenerated. Restart database to apply changes.", UNAVAILABLE("Writing the new certificate files to the server")]);
    const after = t.world.certificates.find((c) => c.resource === "database")!;
    // A new key and a new certificate, with the old one's names and paths, signed by the server's CA.
    expect(after.certificate).not.toBe(before.certificate);
    expect(after.certificate).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(after.privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect({ ...after, certificate: "", privateKey: "", given: true }).toEqual({ ...before, certificate: "", privateKey: "", given: true });
    expect(t.world.certificates.filter((c) => c.is_ca_certificate)).toHaveLength(1);
    // The file mounts hold the new texts.
    expect(t.world.fileStorages.map((f) => [f.fs_path, f.mount_path, f.chmod, f.content])).toEqual([
      [`/data/coolify/databases/${UUID}/ssl/server.crt`, "/var/lib/postgresql/certs/server.crt", "644", after.certificate],
      [`/data/coolify/databases/${UUID}/ssl/server.key`, "/var/lib/postgresql/certs/server.key", "600", after.privateKey],
    ]);
    expect(t.world.processes).toEqual([]);
    expect(t.asked).toContain("deploy.resource.write");
  });

  it("POST …/ssl/regenerate: MongoDB's certificate and key are one file; a database without a certificate has nothing to regenerate", async () => {
    const mongo = setup("mongodb.ssl require");
    expect((await mongo.call("POST", `${UUID}/ssl/regenerate`)).status).toBe(200);
    const certificate = mongo.world.certificates.find((c) => c.resource === "database")!;
    expect(mongo.world.fileStorages.map((f) => [f.mount_path, f.chmod, f.content])).toEqual([["/etc/mongo/certs/server.pem", "600", `${certificate.certificate}\n${certificate.privateKey}`]]);

    const none = setup("postgresql.defaults");
    const r = await none.call("POST", `${UUID}/ssl/regenerate`);
    expect([r.status, r.error.message]).toEqual([422, "No existing SSL certificate found for this database."]);
    const clickhouse = setup("clickhouse.defaults");
    expect((await clickhouse.call("POST", `${UUID}/ssl/regenerate`)).error.message).toBe(DATABASE_SERVICE_MESSAGES.sslUnsupported);
  });
});

describe("with the SSH executor's binding", () => {
  it("POST …/start runs Coolify's start: the same processes, then the answer with the log and the status", async () => {
    const t = setup("postgresql.custom configuration", { ssh: true });
    const golden = goldenRun("postgresql.custom configuration");
    const r = await t.call("POST", `${UUID}/start`);
    expect(r.status).toBe(200);
    expect(t.scripts()).toEqual(golden.processes.map((p) => p.script));
    expect(r.data).toEqual({
      action: "start",
      refused: null,
      message: null,
      activity: { status: "finished", exitCode: 0, error: null, log: [{ type: "out", output: "Starting database.\nDatabase started.\n" }] },
      status: "running:healthy",
      proxy: null,
      deferred: [],
    });
    expect(t.world.database).toMatchObject({ status: "running:healthy", started_at: "2026-11-20 10:11:12", last_online_at: "2026-11-20 10:11:12" });
    // PostgreSQL's configuration got its listen_addresses, as Coolify stores it.
    expect(t.world.database.conf).toBe(golden.database.conf);
    expect(t.asked).toEqual(["deploy.resource.write"]);
    expect(t.actionRuns()).toBe(1);
  });

  it("POST …/start of a public database starts its TCP proxy after it, as the job Coolify queues does", async () => {
    const t = setup("redis.public port", { ssh: true });
    const start = goldenRun("redis.public port").processes.map((p) => p.script);
    const r = await t.call("POST", `${UUID}/start`);
    expect(r.status).toBe(200);
    expect(r.data.proxy).toEqual({ started: true, disabled: null, error: null });
    expect(t.scripts().slice(0, start.length)).toEqual(start);
    // The proxy's two processes are those of StartDatabaseProxy, with this database's timeout.
    const proxy = t.scripts().slice(start.length);
    expect(firstLines(proxy)).toEqual(["docker network inspect 'coolify' --format '{{.EnableIPv6}}'", `mkdir -p /data/coolify/databases/${UUID}/proxy`]);
    const conf = Buffer.from(/echo '([A-Za-z0-9+/=]+)' \| base64 -d \| tee \S+nginx\.conf/.exec(proxy[1]!)![1]!, "base64").toString();
    expect(conf).toContain(`set $upstream ${UUID}:6379;`);
    expect(conf).toContain("proxy_timeout 600s;");
  });

  it("POST …/start with SSL: the certificate is made, its files are written at once, and the CA's other work is named as left", async () => {
    // The server as it answers: each file is missing when it is written, and there when the start checks.
    const states = { match: "sh -c 'i=0", sequence: [{ output: "1:missing\n" }, { output: "1:missing\n" }, { output: "1:file\n2:file\n" }] };
    const t = setup("mysql.ssl generated", { ssh: true, responses: [states] });
    const r = await t.call("POST", `${UUID}/start`);
    expect(r.status).toBe(200);
    expect((r.data.activity as { status: string }).status).toBe("finished");
    expect(r.data.deferred).toEqual([OPERATION_MESSAGES.regenerateServerCertificates]);
    const first = firstLines(t.scripts());
    // The CA file, then each certificate file (Coolify queues those writes), then the check and the start.
    expect(first[0]).toBe("mkdir -p /data/coolify/ssl");
    const batch = first.indexOf("echo 'Starting database.'");
    const writes = t.scripts().slice(1, batch).filter((script) => script.includes("| base64 -d | tee '"));
    expect(writes.map((script) => /tee '([^']+)'/.exec(script)![1])).toEqual([`/data/coolify/databases/${UUID}/ssl/server.crt`, `/data/coolify/databases/${UUID}/ssl/server.key`]);
    // So the start has nothing left to write, and says nothing about missing files.
    expect(t.scripts()[batch]).not.toContain("missing configuration file");
    expect(t.world.certificates.map((c) => [c.is_ca_certificate, c.common_name, c.mount_path])).toEqual([
      [true, "Coolify CA Certificate", null],
      [false, UUID, "/etc/mysql/certs"],
    ]);
  });

  it("POST …/start that fails on the server answers with the failed log; the database stays marked as started", async () => {
    const t = setup("keydb.pull fails", { ssh: true });
    const r = await t.call("POST", `${UUID}/start`);
    expect(r.status).toBe(200);
    expect(r.data.activity).toMatchObject({ status: "error", exitCode: 1, error: "Database start failed." });
    expect(r.data.status).toBe("exited");
    expect(t.world.database.started_at).toBe("2026-11-20 10:11:12");
  });

  it("POST …/start is refused with Coolify's reason when the server is not functional, and nothing is stored", async () => {
    const t = setup("mariadb.server unreachable", { ssh: true });
    const r = await t.call("POST", `${UUID}/start`);
    expect([r.status, r.error.code, r.error.message]).toEqual([422, "validation_failed", "Server is not functional"]);
    expect(t.world.processes).toEqual([]);
    expect(t.world.database.started_at).toBeNull();
  });

  it("POST …/start is refused when the server has no private key the executor could use", async () => {
    const t = setup("mariadb.defaults", { ssh: true, key: false });
    const r = await t.call("POST", `${UUID}/start`);
    expect([r.status, r.error.message]).toEqual([422, OPERATION_MESSAGES.noExecutor]);
    expect(t.world.database.started_at).toBeNull();
  });

  it("POST …/restart and …/stop run Coolify's restart and stop", async () => {
    const restart = setup("dragonfly.restart", { ssh: true });
    const restarted = await restart.call("POST", `${UUID}/restart`);
    expect([restarted.status, restarted.data.message, restarted.data.status]).toEqual([200, "Restarting database.", "running:healthy"]);
    expect(restart.scripts()).toEqual(goldenRun("dragonfly.restart").processes.map((p) => p.script));

    const stop = setup("dragonfly.stop public", { ssh: true });
    const stopped = await stop.call("POST", `${UUID}/stop`);
    expect([stopped.status, stopped.data.message, stopped.data.status]).toEqual([200, "Database stopped successfully", "exited:unhealthy"]);
    expect(stop.scripts()).toEqual(goldenRun("dragonfly.stop public").processes.map((p) => p.script));

    const failing = setup("dragonfly.stop public and the proxy fails", { ssh: true });
    const failed = await failing.call("POST", `${UUID}/stop`);
    expect([failed.status, failed.error.message]).toEqual([422, "Database stop failed: permission denied"]);
  });

  it("POST …/stop resets the restart counters unless dockerCleanup is false, as the page's checkbox does", async () => {
    const counters = (t: ReturnType<typeof setup>) => [t.world.database.restart_count, t.world.database.last_restart_at, t.world.database.last_restart_type];
    const reset = setup("mysql.stop after crash restarts", { ssh: true });
    expect((await reset.call("POST", `${UUID}/stop`)).status).toBe(200);
    expect(counters(reset)).toEqual([0, null, null]);

    const kept = setup("mysql.stop without cleanup after crash restarts", { ssh: true });
    expect((await kept.call("POST", `${UUID}/stop`, { dockerCleanup: false })).status).toBe(200);
    expect(counters(kept)).toEqual([3, "2026-11-19 08:00:00", "crash"]);
    expect(kept.scripts()).toEqual(goldenRun("mysql.stop without cleanup after crash restarts").processes.map((p) => p.script));
  });

  it("needs deploy.resource.write: a denial is 404 and nothing runs", async () => {
    const t = setup("postgresql.defaults", { ssh: true, write: false });
    for (const action of ["start", "restart", "stop"]) expect((await t.call("POST", `${UUID}/${action}`)).status).toBe(404);
    expect(t.actionRuns()).toBe(0);
    expect(t.world.processes).toEqual([]);
    const unknown = setup("postgresql.defaults", { ssh: true });
    expect((await unknown.call("POST", "nope/start")).status).toBe(404);
    expect((await unknown.call("GET", `${UUID}/start`)).status).toBe(405);
  });

  it("PATCH instantSave: public stores the switch, then starts the proxy with Coolify's commands", async () => {
    const t = setup("postgresql.proxy start", { ssh: true, change: (run) => ({ ...run, database: { ...run.database, is_public: false } }) });
    const r = await t.call("PATCH", UUID, { action: "instantSave", isPublic: true, publicPort: 15432 });
    expect([r.status, r.data.message]).toEqual([200, "Database is now publicly accessible."]);
    expect(t.updates).toEqual([{ is_public: true }]);
    expect(t.scripts()).toEqual(goldenRun("postgresql.proxy start").processes.map((p) => p.script));
    expect(t.world.database.is_public).toBe(true);
  });

  it("PATCH instantSave: a taken port makes the database private again, and the answer says why", async () => {
    const t = setup("postgresql.proxy start and the port is taken", { ssh: true, change: (run) => ({ ...run, database: { ...run.database, is_public: false } }) });
    const r = await t.call("PATCH", UUID, { action: "instantSave", isPublic: true });
    expect(r.status).toBe(200);
    expect(r.data.proxyDisabled).toMatch(/^TCP Proxy for postgresql-database-db0000000000000000000001 database has been disabled due to error: .*port is already allocated$/);
    expect(t.world.database.is_public).toBe(false);
  });

  it("PATCH instantSave: a proxy that cannot be started is Coolify's error", async () => {
    const t = setup("postgresql.proxy start fails", { ssh: true, change: (run) => ({ ...run, database: { ...run.database, is_public: false } }) });
    const r = await t.call("PATCH", UUID, { action: "instantSave", isPublic: true });
    expect([r.status, r.error.message]).toEqual([422, "Cannot connect to the Docker daemon"]);
  });

  it("PATCH instantSave: private removes the proxy container", async () => {
    const t = setup("postgresql.proxy stop", { ssh: true });
    const r = await t.call("PATCH", UUID, { action: "instantSave", isPublic: false });
    expect([r.status, r.data.message]).toEqual([200, "Database is no longer publicly accessible."]);
    expect(t.scripts()).toEqual(goldenRun("postgresql.proxy stop").processes.map((p) => p.script));
    expect(t.updates).toEqual([{ is_public: false }]);
    expect(t.world.database.is_public).toBe(false);
  });

  it("POST …/ssl/regenerate also writes the new files to the server", async () => {
    const t = setup("redis.ssl on", { ssh: true, responses: [{ match: "sh -c 'i=0", output: "1:file\n" }] });
    const r = await t.call("POST", `${UUID}/ssl/regenerate`);
    expect([r.status, r.data.message, r.data.unavailable]).toEqual([200, "SSL certificates regenerated. Restart database to apply changes.", undefined]);
    const certificate = t.world.certificates.find((c) => c.resource === "database")!;
    const base64 = (text: string) => Buffer.from(text).toString("base64");
    const writes = t.scripts().filter((script) => script.includes("| base64 -d | tee '"));
    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain(`echo '${base64(certificate.certificate)}' | base64 -d | tee '/data/coolify/databases/${UUID}/ssl/server.crt' > /dev/null`);
    expect(writes[0]).toContain(`chmod -- '644' '/data/coolify/databases/${UUID}/ssl/server.crt'`);
    expect(writes[1]).toContain(`echo '${base64(certificate.privateKey)}' | base64 -d | tee '/data/coolify/databases/${UUID}/ssl/server.key' > /dev/null`);
    expect(writes[1]).toContain(`chmod -- '600' '/data/coolify/databases/${UUID}/ssl/server.key'`);
  });
});
