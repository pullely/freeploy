// Derived from coollabsio/coolify@91b7e3e:app/Actions/Database/{StartDatabase,RestartDatabase,StopDatabase,
// StartDatabaseProxy,StopDatabaseProxy}.php, app/Jobs/DatabaseStartJob.php, the SSL part of each
// app/Actions/Database/Start*.php, app/Services/{DatabaseStartCommandExecutor,ResourceStatusRefresher,
// ContainerStatusAggregator}.php (execute; refreshDatabase, refresh, store; containerStatus),
// app/Support/ResourceStartActivity.php (markFailed), app/Exceptions/DatabaseStartException.php,
// app/Helpers/SslHelper.php (the rows generateSslCertificate() writes), app/Models/Server.php (ensureCaCertificate,
// generateCaCertificate, isFunctional), app/Models/StandaloneClickhouse.php (anonymousDataVolume) and
// app/Traits/HasDatabaseStatusInfo.php (regenerateSslCertificate) (Apache-2.0), modified.
//
// Starting, restarting and stopping a standalone database, and starting and stopping its TCP proxy, as Coolify
// runs them: the same processes on the server in the same order, the same row updates. It is written against an
// executor and a store, and every source of time and randomness is given to it, so it runs the same in a test
// as against a server. tests/deploy-core-worker replays every run Coolify's own PHP made
// (fixtures/database-start) through it: each process must be the one Coolify started.
//
// A start is a list of steps (DATABASE_START_STEPS): `check` (what StartDatabase refuses before it queues
// anything), `start` (what DatabaseStartJob runs: the certificate rows, the content files, the plan, and its
// command batch), `status` (the container's status, right after) and `failed` (the job's failed()). The state
// between two steps is a plain object.
//
// What differs from Coolify, on purpose:
//   - started_at. Coolify sets it from the page, once a started database is seen running. Freeploy sets it in
//     `check`, before the first command reaches the server: a database without it has nothing on any server, and
//     deleting one relies on that.
//   - The start's log. Coolify keeps it in an activity row that the page follows; Freeploy has no activity table,
//     so the log is part of the state the start ends with, and is not stored.
//   - The start runs where it is called. Coolify queues it and refuses a second start, restart or import while
//     one is reserved, queued or running (DatabaseOperationReservation, ResourceStartActivity); with no queue
//     and no activity rows there is nothing to refuse by. This waits for the Workflow that will run a start.
// Not done here, each named where it would happen: image scans, the stop notification's "expected stop" mark,
// the Docker cleanup after a stop, a non-root server user (sudo), Swarm, and what Coolify only asks for — the
// queued jobs, the events and the notification are handed to `effect`.
import type { DatabaseEngine } from "@saas/db/deploy";
import type { ComposeLogDrain } from "../deployments/compose.js";
import type { DeploymentExecutor } from "../deployments/engine.js";
import { storedApplicationStatus } from "../deployments/engine.js";
import { escapeshellarg, phpTrim } from "../deployments/php.js";
import { dockerStopCommand } from "../helpers/docker.js";
import { redactSensitiveText, remove_iip, sanitize_utf8_text } from "../helpers/remote-process.js";
import { CA_COMMON_NAME, CA_VALIDITY_DAYS, caCertificateFileCommands, generateSslCertificate, type GenerateSslCertificateOptions, type GeneratedSslCertificate } from "../ssl/ssl-helper.js";
import { RemoteCommandError, contentFileEchoCommands, ensureContentFilesOnServer, instantRemote, type ContentFile } from "./content-files.js";
import { buildProxyPlan, isNonTransientProxyError, networkIpv6Command, proxyStopCommand } from "./proxy-plan.js";
import { RemoteSecretError, SSL_MOUNT_PATH, assertVariablesResolvable, buildStartPlan, databaseWorkdir, sslFileMountPaths, sslPemKeyFileRequired, type StartDatabase, type StartPersistentStorage, type StartPlan, type StartVariable } from "./start-plan.js";

// ── What the engine is given ────────────────────────────────────────────────────────────────────────────

/** Everything an operation reads, as plain row data with the `encrypted` columns decrypted. */
export interface DatabaseOperationContext {
  engine: DatabaseEngine;
  database: StartDatabase & {
    /** The stored status ("exited", "running:healthy", …). */
    status: string;
    is_public: boolean;
    public_port: number | null;
    public_port_timeout: number | null;
  };
  projectName: string;
  environmentName: string;
  /** $database->destination->network */
  network: string;
  server: {
    ip: string | null;
    user: string;
    /** Server::isFunctional(): reachable, usable, not disabled, and with a real address. */
    functional: boolean;
    /** Server::isSwarm() */
    swarm: boolean;
    dockerVersion: string | null;
    logDrain: ComposeLogDrain;
  };
  persistentStorages: StartPersistentStorage[];
  /** $database->fileStorages()->get(), oldest first. */
  fileStorages: ContentFile[];
  /** runtime_environment_variables, oldest first. */
  variables: StartVariable[];
}

/** A file mount generateSslCertificate() creates for a certificate. */
export interface NewCertificateFile {
  fs_path: string;
  mount_path: string;
  content: string;
  chmod: string;
}

/** The database's certificate row, as regenerateSslCertificate() reads it. */
export interface StoredCertificate {
  commonName: string;
  subjectAlternativeNames: string[];
  configurationDir: string | null;
  mountPath: string | null;
}

/** What an operation writes. Every method is its own transaction, as each of Coolify's queries is. */
export interface DatabaseOperationStore {
  /** Freeploy's: started_at, unless it is set. */
  markStarted(now: Date): Promise<void>;
  /** $database->update(['status' => …]): the stored form, with the saving hook's last_online_at. */
  setStatus(status: string, now: Date): Promise<void>;
  /** $database->update(['last_online_at' => now()]) */
  touchLastOnline(now: Date): Promise<void>;
  /**
   * $database->update(['restart_count' => 0, 'last_restart_at' => null, 'last_restart_type' => null]): no write
   * when they are so already, as Eloquent writes only what changed.
   */
  resetRestartCounters(): Promise<void>;
  /** $database->update(['is_public' => …]) */
  setPublic(isPublic: boolean): Promise<void>;
  /** PostgreSQL: $database->postgres_conf = …; save(). */
  setPostgresConf(conf: string): Promise<void>;
  /** Redis: $env->update(['value' => …]) of the REDIS_USERNAME variable. */
  setVariableValue(key: string, value: string): Promise<void>;
  /** $server->sslCertificates()->where('is_ca_certificate', true)->first(), decrypted. */
  findCaCertificate(): Promise<{ certificate: string; privateKey: string } | null>;
  /** generateSslCertificate() for the server's CA: the old one goes, the new one is stored. */
  replaceCaCertificate(generated: GeneratedSslCertificate): Promise<void>;
  /** $database->sslCertificates()->first() */
  findCertificate(): Promise<StoredCertificate | null>;
  /** $database->sslCertificates()->delete() */
  deleteCertificates(): Promise<void>;
  /** The database's file mounts at these mount paths go; answers the file mounts afterwards. */
  deleteFileStorages(mountPaths: string[]): Promise<ContentFile[]>;
  /**
   * generateSslCertificate() for the database: its certificate rows go and the new one is stored; its file
   * mounts at `mountPaths` go and `files` are created. Answers the file mounts afterwards.
   */
  replaceCertificate(generated: GeneratedSslCertificate, where: { configurationDir: string; mountPath: string }, mountPaths: string[], files: NewCertificateFile[]): Promise<ContentFile[]>;
}

/** What Coolify hands to other jobs, notifications and broadcasts: Freeploy's side of each comes later. */
export type DatabaseEffect =
  /**
   * RegenerateSslCertJob (every certificate of the server, after a new CA), ServerStorageSaveJob (a new file
   * mount's file), StartDatabaseProxy (the proxy of a public database that starts).
   */
  | { type: "job"; job: "RegenerateSslCertJob" | "StartDatabaseProxy" }
  | { type: "job"; job: "ServerStorageSaveJob"; file: ContentFile }
  | { type: "event"; event: "DatabaseStatusChanged" | "ServiceStatusChanged" | "DatabaseProxyStopped" | "FileStorageChanged" }
  | { type: "notify"; notification: "ContainerRestarted"; message: string };

export interface DatabaseEngineDeps {
  executor: DeploymentExecutor;
  store: DatabaseOperationStore;
  /** Carbon::now() */
  now: () => Date;
  /** Sleep::for($seconds)->seconds() */
  sleep: (seconds: number) => Promise<void>;
  effect: (effect: DatabaseEffect) => Promise<void> | void;
  /** SslHelper::generateSslCertificate()'s key and certificate; replaceable in tests. */
  generateCertificate?: (options: GenerateSslCertificateOptions) => Promise<GeneratedSslCertificate>;
}

// ── Messages and errors ─────────────────────────────────────────────────────────────────────────────────

export const DATABASE_OPERATION_MESSAGES = {
  serverNotFunctional: "Server is not functional",
  /** DatabaseStartException */
  missingCaCertificate: "No CA certificate found for this database. Please generate a CA certificate for this server in the server/advanced page.",
  clickhouseDataInAnonymousVolume: (volume: string): string =>
    `This ClickHouse database keeps its current data in the unnamed Docker volume ${volume}, not in its data volume. A start or restart would use the data volume, and the current data would seem lost. On the database's General page, click "Keep current data" first.`,
  /** DatabaseStartJob::failed() */
  startFailed: "Database start failed.",
  /** StopDatabase */
  stopped: "Database stopped successfully",
  stopFailed: (message: string): string => `Database stop failed: ${message}`,
  /** StartDatabaseProxy */
  proxyDisabled: (name: string, message: string): string => `TCP Proxy for ${name} database has been disabled due to error: ${message}`,
  /** Freeploy's: what the engine does not run yet. */
  nonRootServer: "Starting a database on a server with a non-root user is not available yet.",
} as const;

/** DatabaseStartException: an expected, user-facing reason why a database could not be started. */
export class DatabaseStartError extends Error {}

/** A PHP exception: its class shows in what a run ended with. */
export interface OperationFailure {
  phpClass: string;
  message: string;
}

function failureOf(error: unknown): OperationFailure {
  if (error instanceof DatabaseStartError) return { phpClass: "App\\Exceptions\\DatabaseStartException", message: error.message };
  if (error instanceof RemoteSecretError) return { phpClass: "App\\Exceptions\\RemoteSecretException", message: error.message };
  if (error instanceof RemoteCommandError) return { phpClass: "RuntimeException", message: error.message };
  return { phpClass: "RuntimeException", message: error instanceof Error ? error.message : String(error) };
}

// ── The start's log ─────────────────────────────────────────────────────────────────────────────────────

export interface StartLogEntry {
  /** `out` and `err`: the command batch's output. `stderr`: why the start failed. */
  type: "out" | "err" | "stderr";
  output: string;
  /** Milliseconds since the epoch (Coolify: hrtime). */
  timestamp: number;
  batch: 1;
  order: number;
}

/** The activity of a start: what Coolify keeps in its activity log. */
export interface StartActivity {
  status: "queued" | "in_progress" | "finished" | "error";
  exitCode: number | null;
  error: string | null;
  failedAt: string | null;
  log: StartLogEntry[];
}

export const DATABASE_START_STEPS = ["check", "start", "status", "failed"] as const;
export type DatabaseStartStep = (typeof DATABASE_START_STEPS)[number];

export interface DatabaseStartState {
  /** The step to run next; null when the start is over. */
  step: DatabaseStartStep | null;
  /** Why the start was refused before anything was queued; null when it was not. */
  refused: string | null;
  activity: StartActivity | null;
  /** The exception the start job ended with. */
  thrown: OperationFailure | null;
  /** The status as the model reads it, once the status step has stored one. */
  status: string | null;
}

export const initialStartState = (): DatabaseStartState => ({ step: "check", refused: null, activity: null, thrown: null, status: null });

/** ResourceStatusRefresher: inspections while a health check still reports "starting" (about 15 seconds in total). */
const HEALTH_WAIT_ATTEMPTS = 8;
const HEALTH_WAIT_INTERVAL_SECONDS = 2;

/** StandaloneClickhouse::DATA_DIRECTORY */
const CLICKHOUSE_DATA_DIRECTORY = "/var/lib/clickhouse";

type Json = Record<string, unknown>;
const get = (value: unknown, ...path: string[]): unknown => path.reduce<unknown>((at, key) => (at !== null && typeof at === "object" ? (at as Json)[key] : undefined), value);

/** format_docker_command_output_to_json(): one JSON document a line; nothing when a line is not JSON. */
function parseContainers(output: string): unknown[] {
  const containers: unknown[] = [];
  for (const line of output.split("\n")) {
    // reject(fn ($line) => empty($line))
    if (line === "" || line === "0") continue;
    try {
      containers.push(JSON.parse(line) as unknown);
    } catch {
      return [];
    }
  }
  // ->filter()
  return containers.filter((container) => Boolean(container) && !(Array.isArray(container) && container.length === 0));
}

/** ContainerStatusAggregator::containerStatus() */
function containerStatus(container: unknown): string {
  const state = get(container, "State", "Status");
  if (state === "exited") return "exited";
  const health = get(container, "State", "Health", "Status");
  return `${typeof state === "string" ? state : ""}:${typeof health === "string" ? health : "unknown"}`;
}

/** One operation on one database: the engine's steps share what they have read. */
class Operation {
  private fileStorages: ContentFile[];

  constructor(
    private readonly deps: DatabaseEngineDeps,
    private readonly ctx: DatabaseOperationContext,
  ) {
    this.fileStorages = ctx.fileStorages;
  }

  private get uuid(): string {
    return this.ctx.database.uuid;
  }

  private instant(commands: string[], throwError = true): Promise<string | null> {
    return instantRemote(this.deps.executor, commands, throwError);
  }

  /** StandaloneClickhouse::anonymousDataVolume(): the unnamed Docker volume that holds the database's data, or null. */
  private async anonymousDataVolume(): Promise<string | null> {
    if (!this.ctx.server.functional) return null;
    const format = `{{range .Mounts}}{{if eq .Destination "${CLICKHOUSE_DATA_DIRECTORY}"}}{{.Type}} {{.Name}}{{end}}{{end}}`;
    let output: string | null;
    try {
      output = await this.instant([`docker inspect --format ${escapeshellarg(format)} ${escapeshellarg(this.uuid)} 2>/dev/null || true`]);
    } catch {
      return null;
    }
    const trimmed = phpTrim(output ?? "");
    const space = trimmed.indexOf(" ");
    const type = space < 0 ? trimmed : trimmed.slice(0, space);
    const name = space < 0 ? "" : trimmed.slice(space + 1);
    if (type !== "volume" || name === "" || this.ctx.persistentStorages.some((storage) => storage.name === name)) return null;
    return name;
  }

  /** Server::ensureCaCertificate(): the server's CA certificate, generated first when it does not exist yet. */
  private async ensureCaCertificate(): Promise<{ certificate: string; privateKey: string } | null> {
    const existing = await this.deps.store.findCaCertificate();
    if (existing) return existing;
    // generateCaCertificate(); its failure is reported (handleError) and leaves the server without one.
    try {
      const generated = await (this.deps.generateCertificate ?? generateSslCertificate)({ commonName: CA_COMMON_NAME, isCaCertificate: true, validityDays: CA_VALIDITY_DAYS, now: this.deps.now() });
      await this.deps.store.replaceCaCertificate(generated);
      await this.instant(caCertificateFileCommands(generated.sslCertificate), false);
      await this.deps.effect({ type: "job", job: "RegenerateSslCertJob" });
    } catch {
      // handleError($e)
    }
    return this.deps.store.findCaCertificate();
  }

  /** StartDatabase::prerequisiteError(): what would make the start fail, told before anything is queued. */
  private async prerequisiteError(): Promise<string | null> {
    if (this.ctx.engine === "clickhouse") {
      const volume = await this.anonymousDataVolume();
      if (volume !== null) return DATABASE_OPERATION_MESSAGES.clickhouseDataInAnonymousVolume(volume);
    }
    if (!this.ctx.database.enable_ssl || SSL_MOUNT_PATH[this.ctx.engine] === null) return null;
    if (!(await this.ensureCaCertificate())) return DATABASE_OPERATION_MESSAGES.missingCaCertificate;
    return null;
  }

  /** What StartDatabase::queueStart() refuses before it queues the start; null when the start goes on. */
  async check(): Promise<string | null> {
    if (!this.ctx.server.functional) return DATABASE_OPERATION_MESSAGES.serverNotFunctional;
    if (this.ctx.server.user !== "root") return DATABASE_OPERATION_MESSAGES.nonRootServer;
    // From here on commands reach the server. A database with started_at may have something there.
    await this.deps.store.markStarted(this.deps.now());
    const prerequisite = await this.prerequisiteError();
    if (prerequisite !== null) return prerequisite;
    await this.deps.store.resetRestartCounters();
    return null;
  }

  /** The SSL part of the engine's Start action: the rows of the certificate and of its files. */
  private async prepareSsl(): Promise<{ caCertificate: string; generated: boolean } | null> {
    const { engine, database } = this.ctx;
    const mountPath = SSL_MOUNT_PATH[engine];
    if (mountPath === null) return null;
    if (!database.enable_ssl) {
      await this.deps.store.deleteCertificates();
      this.fileStorages = await this.deps.store.deleteFileStorages(sslFileMountPaths(engine));
      return null;
    }
    const ca = await this.ensureCaCertificate();
    if (!ca) throw new DatabaseStartError(DATABASE_OPERATION_MESSAGES.missingCaCertificate);
    if (await this.deps.store.findCertificate()) return { caCertificate: ca.certificate, generated: false };
    await this.generateCertificate(ca, { commonName: database.uuid, subjectAlternativeNames: [], configurationDir: databaseWorkdir(database.uuid), mountPath });
    return { caCertificate: ca.certificate, generated: true };
  }

  /** SslHelper::generateSslCertificate() for the database: a new key and certificate, their rows and their file mounts. */
  async generateCertificate(ca: { certificate: string; privateKey: string }, certificate: { commonName: string; subjectAlternativeNames: string[]; configurationDir: string | null; mountPath: string | null }): Promise<void> {
    const generated = await (this.deps.generateCertificate ?? generateSslCertificate)({
      commonName: certificate.commonName,
      subjectAlternativeNames: certificate.subjectAlternativeNames,
      caCert: ca.certificate,
      caKey: ca.privateKey,
      serverIp: this.ctx.server.ip,
      now: this.deps.now(),
    });
    const { configurationDir, mountPath } = certificate;
    const files: NewCertificateFile[] = [];
    if (configurationDir && mountPath) {
      if (sslPemKeyFileRequired(this.ctx.engine)) {
        files.push({ fs_path: `${configurationDir}/ssl/server.pem`, mount_path: `${mountPath}/server.pem`, content: `${generated.sslCertificate}\n${generated.sslPrivateKey}`, chmod: "600" });
      } else {
        files.push({ fs_path: `${configurationDir}/ssl/server.crt`, mount_path: `${mountPath}/server.crt`, content: generated.sslCertificate, chmod: "644" });
        files.push({ fs_path: `${configurationDir}/ssl/server.key`, mount_path: `${mountPath}/server.key`, content: generated.sslPrivateKey, chmod: "600" });
      }
    }
    const mountPaths = mountPath ? [`${mountPath}/server.crt`, `${mountPath}/server.key`, `${mountPath}/server.pem`] : [];
    this.fileStorages = await this.deps.store.replaceCertificate(generated, { configurationDir: configurationDir ?? "", mountPath: mountPath ?? "" }, mountPaths, files);
    // The created hook of each new file mount: its file is written by a queued job.
    for (const file of files) {
      await this.deps.effect({ type: "job", job: "ServerStorageSaveJob", file: { ...file, is_directory: false, is_host_file: false, is_based_on_git: false, chown: null } });
    }
  }

  /** The engine's Start action up to its command list. */
  async plan(): Promise<StartPlan> {
    const ssl = await this.prepareSsl();
    const ensured = await ensureContentFilesOnServer(this.deps.executor, this.fileStorages, databaseWorkdir(this.uuid));
    for (let i = 0; i < ensured.replacedEmptyDirectories; i++) await this.deps.effect({ type: "event", event: "FileStorageChanged" });
    const plan = buildStartPlan({
      engine: this.ctx.engine,
      database: this.ctx.database,
      projectName: this.ctx.projectName,
      environmentName: this.ctx.environmentName,
      network: this.ctx.network,
      server: this.ctx.server,
      persistentStorages: this.ctx.persistentStorages,
      fileStorages: this.fileStorages,
      variables: this.ctx.variables,
      ssl,
      contentFileCommands: contentFileEchoCommands(ensured.log),
      now: this.deps.now(),
    });
    if (plan.changes.postgresConf !== undefined) await this.deps.store.setPostgresConf(plan.changes.postgresConf);
    if (plan.changes.redisUsername !== undefined) await this.deps.store.setVariableValue("REDIS_USERNAME", plan.changes.redisUsername);
    return plan;
  }

  /**
   * DatabaseStartCommandExecutor::execute(): the commands as one batch on the server's shell, with the output
   * in the activity's log as it arrives. Output is redacted per complete line.
   */
  async execute(commands: string[], activity: StartActivity): Promise<void> {
    activity.status = "in_progress";
    const redact = (text: string): string => sanitize_utf8_text(redactSensitiveText(text));
    const append = (type: "out" | "err", output: string): void => {
      if (output === "") return;
      activity.log.push({ type, output, timestamp: this.deps.now().getTime(), batch: 1, order: activity.log.length + 1 });
    };
    const pending = new Map<"out" | "err", string>();
    const result = await this.deps.executor
      .run({ script: commands.join("\n") }, (stream, chunk) => {
        const waiting = (pending.get(stream) ?? "") + chunk;
        const end = Math.max(waiting.lastIndexOf("\n"), waiting.lastIndexOf("\r"));
        if (end < 0) {
          pending.set(stream, waiting);
          return;
        }
        append(stream, redact(waiting.slice(0, end + 1)));
        pending.set(stream, waiting.slice(end + 1));
      })
      .finally(() => {
        for (const [stream, output] of pending) append(stream, redact(output));
      });
    activity.status = result.exitCode === 0 ? "finished" : "error";
    activity.exitCode = result.exitCode;
    if (result.exitCode !== 0) throw new RemoteCommandError(redact(result.stderr), result.exitCode);
  }

  /** ResourceStatusRefresher::refreshDatabase(): the container's status, stored right after the start. */
  async refreshStatus(): Promise<string | null> {
    if (!this.ctx.server.functional || this.ctx.server.swarm) return null;
    const command = `docker container inspect ${escapeshellarg(this.uuid)} --format '{{json .}}'`;
    // $database->status, as the model's accessor reads it.
    let current = storedApplicationStatus(this.ctx.database.status);
    let stored: string | null = null;
    for (let attempt = 1; ; attempt++) {
      const containers = parseContainers((await this.instant([command], false)) ?? "");
      if (containers.length === 0) return stored;
      const container = containers.find((c) => get(c, "Name") === `/${this.uuid}`);
      if (container !== undefined) {
        const status = containerStatus(container);
        if (current !== status) {
          current = storedApplicationStatus(status);
          await this.deps.store.setStatus(current, this.deps.now());
        } else {
          await this.deps.store.touchLastOnline(this.deps.now());
        }
        stored = current;
      }
      const healthStarting = containers.some((c) => get(c, "State", "Health", "Status") === "starting");
      if (!healthStarting || attempt >= HEALTH_WAIT_ATTEMPTS) return stored;
      await this.deps.sleep(HEALTH_WAIT_INTERVAL_SECONDS);
    }
  }

  /** ensureRemoteSecretsResolvable(): a variable that needs a secret manager is told before the database is stopped. */
  remoteSecretError(): string | null {
    try {
      assertVariablesResolvable(this.ctx.variables);
      return null;
    } catch (e) {
      if (e instanceof RemoteSecretError) return e.message;
      throw e;
    }
  }

  /** RestartDatabase::handle()'s own checks, before it hands over to the start. */
  async restartCheck(): Promise<string | null> {
    if (!this.ctx.server.functional) return DATABASE_OPERATION_MESSAGES.serverNotFunctional;
    if (this.ctx.server.user !== "root") return DATABASE_OPERATION_MESSAGES.nonRootServer;
    const prerequisite = await this.prerequisiteError();
    if (prerequisite !== null) return prerequisite;
    // Check remote secrets before stopping: if the secret manager fails, the database keeps running.
    return this.remoteSecretError();
  }

  /** StopDatabase::handle(); `resetRestartCount` is the page's "docker cleanup" checkbox, as Heading::stop() passes it. */
  async stop(resetRestartCount: boolean): Promise<string> {
    try {
      if (!this.ctx.server.functional) return DATABASE_OPERATION_MESSAGES.serverNotFunctional;
      // A removed container loses the link to the unnamed volume that holds the current data.
      const removeContainer = !(this.ctx.engine === "clickhouse" && (await this.anonymousDataVolume()) !== null);
      // stopContainer()
      const commands = [dockerStopCommand(30, this.uuid, this.ctx.server.dockerVersion)];
      if (removeContainer) commands.push(`docker rm -f ${this.uuid}`);
      await this.instant(commands, false);

      const status = storedApplicationStatus("exited");
      if (status !== this.ctx.database.status) await this.deps.store.setStatus(status, this.deps.now());
      // Reset restart tracking when database is manually stopped
      if (resetRestartCount) await this.deps.store.resetRestartCounters();
      if (this.ctx.database.is_public) await this.stopProxy();
      return DATABASE_OPERATION_MESSAGES.stopped;
    } catch (e) {
      return DATABASE_OPERATION_MESSAGES.stopFailed(e instanceof Error ? e.message : String(e));
    } finally {
      await this.deps.effect({ type: "event", event: "ServiceStatusChanged" });
    }
  }

  /** StartDatabaseProxy::handle(). A start that fails because the port is taken makes the database private. */
  async startProxy(): Promise<{ disabled: string | null }> {
    const { database, engine, network } = this.ctx;
    const ipv6 = phpTrim((await this.instant([networkIpv6Command(network)], false)) ?? "") === "true";
    const plan = buildProxyPlan({ engine, uuid: database.uuid, network, publicPort: database.public_port ?? 0, publicPortTimeout: database.public_port_timeout, enableSsl: database.enable_ssl, ipv6Enabled: ipv6 });
    try {
      await this.instant(plan.commands);
    } catch (e) {
      if (!(e instanceof RemoteCommandError) || !isNonTransientProxyError(e.message)) throw e;
      await this.deps.store.setPublic(false);
      const message = DATABASE_OPERATION_MESSAGES.proxyDisabled(database.name, e.message);
      await this.deps.effect({ type: "notify", notification: "ContainerRestarted", message });
      return { disabled: message };
    }
    return { disabled: null };
  }

  /** StopDatabaseProxy::handle() */
  async stopProxy(): Promise<void> {
    await this.instant([proxyStopCommand(this.uuid)]);
    await this.deps.effect({ type: "event", event: "DatabaseProxyStopped" });
  }
}

// ── The start ───────────────────────────────────────────────────────────────────────────────────────────

/** ResourceStartActivity::markFailed(): the activity as failed, with the reason at the end of its log. */
function markFailed(activity: StartActivity, message: string, now: Date): void {
  // Callers can pass exception or command output text, which can contain secrets.
  const reason = remove_iip(message);
  activity.status = "error";
  activity.error = reason;
  // now()->toIso8601String()
  activity.failedAt = now.toISOString().slice(0, 19) + "+00:00";
  if (activity.exitCode === null) activity.exitCode = 1;
  const lastOrder = activity.log.reduce((max, entry) => Math.max(max, entry.order), 0);
  activity.log.push({ type: "stderr", output: `\n${reason}\n`, timestamp: now.getTime(), batch: 1, order: lastOrder + 1 });
}

/**
 * Runs one step of a start and answers the state after it. `ctx` is what the database is at that moment: a
 * caller that runs the steps apart reads it again before each.
 */
export async function runStartStep(deps: DatabaseEngineDeps, ctx: DatabaseOperationContext, state: DatabaseStartState): Promise<DatabaseStartState> {
  const operation = new Operation(deps, ctx);
  const next = { ...state };
  switch (state.step) {
    case null:
      return next;
    case "check": {
      // StartDatabase::queueStart()
      next.refused = await operation.check();
      if (next.refused !== null) {
        next.step = null;
        return next;
      }
      // logQueuedStartActivity()
      next.activity = { status: "queued", exitCode: null, error: null, failedAt: null, log: [] };
      // The proxy of a public database is started by its own job.
      if (ctx.database.is_public && ctx.database.public_port) await deps.effect({ type: "job", job: "StartDatabaseProxy" });
      next.step = "start";
      return next;
    }
    case "start": {
      // DatabaseStartJob::runStart(): the engine's Start action.
      const activity: StartActivity = { ...(state.activity ?? { status: "queued", exitCode: null, error: null, failedAt: null, log: [] }), log: [...(state.activity?.log ?? [])] };
      next.activity = activity;
      try {
        const plan = await operation.plan();
        await operation.execute(plan.commands, activity);
        next.step = "status";
      } catch (e) {
        next.thrown = failureOf(e);
        next.step = "failed";
      }
      return next;
    }
    case "status": {
      // Store the new status now; the regular status check can wait behind other jobs.
      try {
        next.status = await operation.refreshStatus();
      } catch {
        // Log::warning('Could not refresh the status of a started database.')
      }
      await deps.effect({ type: "event", event: "DatabaseStatusChanged" });
      next.step = null;
      return next;
    }
    case "failed": {
      // DatabaseStartJob::failed(): an expected reason is shown as it is, anything else is not.
      const expected = state.thrown !== null && (state.thrown.phpClass.endsWith("DatabaseStartException") || state.thrown.phpClass.endsWith("RemoteSecretException"));
      const activity: StartActivity = { ...(state.activity ?? { status: "queued", exitCode: null, error: null, failedAt: null, log: [] }), log: [...(state.activity?.log ?? [])] };
      markFailed(activity, expected ? state.thrown!.message : DATABASE_OPERATION_MESSAGES.startFailed, deps.now());
      next.activity = activity;
      await deps.effect({ type: "event", event: "DatabaseStatusChanged" });
      next.step = null;
      return next;
    }
  }
}

/** StartDatabase::run(): every step of a start, one after the other. */
export async function runDatabaseStart(deps: DatabaseEngineDeps, ctx: DatabaseOperationContext, reload: () => Promise<DatabaseOperationContext> = () => Promise.resolve(ctx)): Promise<DatabaseStartState> {
  let state = initialStartState();
  let current = ctx;
  while (state.step !== null) {
    state = await runStartStep(deps, current, state);
    if (state.step !== null) current = await reload();
  }
  return state;
}

/**
 * RestartDatabase::run(): its own checks, then the start — whose script stops the container only after the
 * image pull, so a failed pull keeps the database running.
 */
export async function runDatabaseRestart(deps: DatabaseEngineDeps, ctx: DatabaseOperationContext, reload: () => Promise<DatabaseOperationContext> = () => Promise.resolve(ctx)): Promise<DatabaseStartState> {
  const refused = await new Operation(deps, ctx).restartCheck();
  if (refused !== null) return { ...initialStartState(), step: null, refused };
  return runDatabaseStart(deps, await reload(), reload);
}

/**
 * StopDatabase::run($database, false, $docker_cleanup), as the page's Stop dispatches it: the answer Coolify's
 * action returns. `dockerCleanup` is the page's checkbox (checked by default), which resets the restart counters.
 */
export function runDatabaseStop(deps: DatabaseEngineDeps, ctx: DatabaseOperationContext, dockerCleanup = true): Promise<string> {
  return new Operation(deps, ctx).stop(dockerCleanup);
}

/** StartDatabaseProxy::run(). Throws RemoteCommandError when the proxy cannot be started for another reason than a taken port. */
export function runDatabaseProxyStart(deps: DatabaseEngineDeps, ctx: DatabaseOperationContext): Promise<{ disabled: string | null }> {
  return new Operation(deps, ctx).startProxy();
}

/** StopDatabaseProxy::run(). Throws RemoteCommandError when the container cannot be removed. */
export function runDatabaseProxyStop(deps: DatabaseEngineDeps, ctx: DatabaseOperationContext): Promise<void> {
  return new Operation(deps, ctx).stopProxy();
}

/**
 * HasDatabaseStatusInfo::regenerateSslCertificate(): a new key and certificate for a database that has one, with
 * the names and paths of the old. False when the database has no certificate. The new files reach the server
 * with the next start (Coolify also queues their write at once).
 */
export async function regenerateDatabaseCertificate(deps: DatabaseEngineDeps, ctx: DatabaseOperationContext): Promise<"regenerated" | "no-certificate" | "no-ca"> {
  const existing = await deps.store.findCertificate();
  if (!existing) return "no-certificate";
  let ca = await deps.store.findCaCertificate();
  if (!ca) {
    // $server->generateCaCertificate(), without its write to the server.
    const generated = await (deps.generateCertificate ?? generateSslCertificate)({ commonName: CA_COMMON_NAME, isCaCertificate: true, validityDays: CA_VALIDITY_DAYS, now: deps.now() });
    await deps.store.replaceCaCertificate(generated);
    await deps.effect({ type: "job", job: "RegenerateSslCertJob" });
    ca = await deps.store.findCaCertificate();
  }
  if (!ca) return "no-ca";
  await new Operation(deps, ctx).generateCertificate(ca, existing);
  return "regenerated";
}
