// Derived from coollabsio/coolify@91b7e3e:app/Jobs/ApplicationDeploymentJob.php (handle, networkHostFlags,
// detectBuildKitCapabilities, decide_what_to_do, post_deployment, deploy_dockerimage_buildpack,
// write_deployment_configurations, save_runtime_environment_variables, rolling_update,
// wait_for_proxy_to_route_new_container, proxyLabelsChanged, health_check, query_logs, create_workdir,
// hostCaBundleMount, dockerConfigPath, prepare_builder_image, write_compose_file_to_workdir,
// graceful_shutdown_container, removeContainerWithTimeout, stop_running_container, oldGeneratedContainerNames,
// containerNamesToRemove, start_by_compose_file, pull_docker_image, resolveCommandContainer,
// run_pre_deployment_command, run_post_deployment_command, checkForCancellation, startDeployPhase,
// transitionToStatus, isInTerminalState, handleSuccessfulDeployment, handleFailedDeployment, failed),
// app/Traits/ExecuteRemoteCommand.php (execute_remote_command, executeCommandWithProcess, commandFailureMessage and
// its hints, redactSensitiveCommandPayloads, saveCommandOutput), app/Models/{Application,Server,StandaloneDocker}.php
// (the status mutator, isFunctional, hasPlaceholderIp, proxyConnectCommand), bootstrap/helpers/remoteProcess.php
// (instant_remote_process, excludeCertainErrors), bootstrap/helpers/docker.php (executeInDocker,
// getCurrentApplicationContainerStatus, containersOwnedBy, format_docker_command_output_to_json) and
// bootstrap/helpers/shared.php (validateGitRef, generate_readme_file, sanitize_string, coolifyHelperImage)
// (Apache-2.0), modified.
//
// The deployment of a Docker image application — one server, no preview, no Swarm — as Coolify's job runs it:
// the same commands in the same order with the same flags, the same log entries, the same status updates. It
// is written against an executor and a store, and every source of time is given to it, so it runs the same in
// a test as in a Workflow. tests/deploy-core-worker replays every run Coolify's own PHP made
// (fixtures/deployments) through it: each process must be the one Coolify started, and the log and the
// statuses must come out the same.
//
// It is a list of steps (DEPLOYMENT_STEPS). The state between two steps is a plain object (EngineState):
// runStep() takes one and gives the next, so a Workflow can keep it and go on after a restart, and
// runDeployment() runs them all. A step that fails does what handle()'s `catch` and `finally` do: Coolify's
// failed() as the next step, then the cleanup.
//
// What Coolify does here and Freeploy does not yet (each named where it would happen): build servers and
// additional servers, previews, Swarm, the image scan gate, file storages with content, the configuration
// snapshot of a finished deployment, notifications and the container status check (both asked of `effects`),
// non-root servers (sudo), the retry of a command after an SSH connection error, and the PID of the SSH
// process (there is none: the executor owns the connection).
import type { DeployDeploymentApplicationRow, DeployDeploymentRow, DeployFileStorageRow, DeployPersistentStorageRow, NewDeploymentLogEntry } from "@saas/db/deploy";
import { DEPLOYMENT_STATUS } from "@saas/db/deploy";
import { CONTAINER_NAME_PATTERN } from "../applications/validation.js";
import { DEFAULT_ROLLING_UPDATE_DRAIN_SECONDS, MAX_ROLLING_UPDATE_DRAIN_SECONDS } from "../applications/settings-validation.js";
import { dockerPsByOwnerCommands, dockerRemoveCommandWithTimeout, dockerStopCommand, parseDockerEngineVersion } from "../helpers/docker.js";
import { remoteCommandWithTimeout, sanitize_utf8_text } from "../helpers/remote-process.js";
import { ComposeError, explodeList, generateApplicationContainerName, generateComposeFile, productionImageName, resolveDockerImageTag, stopGracePeriodSeconds, type ComposeInput, type ComposeResult } from "./compose.js";
import { seccompProfileMountFlags } from "./docker-run-options.js";
import { gitSshSetupCommand } from "./git-ssh.js";
import { buildLogEntry, redactLogText, REDACTED } from "./logs.js";
import { base64DecodeStrict, base64Encode, escapeshellarg, phpTrim, utf8FromBinary } from "./php.js";
import { generateRuntimeEnvironmentVariables, logRedactionSecretsFor, RuntimeEnvError, validateDeploymentEnvironmentVariableKeys, type EnvLogEntry, type LogRedactionSecrets, type RuntimeVariable } from "./runtime-env.js";

// ── What the engine is given ────────────────────────────────────────────────────────────────────────────

/** One SSH process, as Coolify starts one for each command of a deployment. */
export interface RemoteProcess {
  /**
   * Without `input`: the command batch, which goes to the remote shell on its stdin. With `input`: one remote
   * command, and the input goes to that command's stdin.
   */
  script: string;
  input?: string;
}

export interface RemoteResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DeploymentExecutor {
  /** Runs the process on the deployment's server. `onOutput` gets each piece of output as it arrives. */
  run(process: RemoteProcess, onOutput?: (stream: "out" | "err", chunk: string) => Promise<void> | void): Promise<RemoteResult>;
}

/** Everything a deployment reads, as plain row data. */
export interface DeploymentContext {
  orgId: string;
  deployment: DeployDeploymentRow;
  /** The application with its settings, its destination and that destination's server. */
  application: DeployDeploymentApplicationRow;
  /** The production variables in the order of the Environment Variables page (by key when the application sorts them). */
  variables: RuntimeVariable[];
  persistentStorages: DeployPersistentStorageRow[];
  fileStorages: DeployFileStorageRow[];
  /** generateLabelsApplication($application, null), with the decrypted Basic Authentication password. */
  generateLabels: () => string[];
}

/** What a deployment writes. Every method is its own transaction, as each of Coolify's queries is. */
export interface DeploymentStore {
  /** $deployment->refresh()->status; null when the deployment is gone. */
  status(deploymentId: string | number): Promise<string | null>;
  /** addLogEntry(): the entry, and the hint after it unless the log already has one. */
  appendLog(deploymentId: string | number, entry: NewDeploymentLogEntry, hint: NewDeploymentLogEntry | null): Promise<void>;
  /** In progress, unless it was cancelled meanwhile; answers the status afterwards. */
  markInProgress(deploymentId: string | number, worker: string | null): Promise<string | null>;
  markDeployStarted(deploymentId: string | number): Promise<void>;
  setStatus(deploymentId: string | number, status: "finished" | "failed"): Promise<void>;
  setFinishedAt(deploymentId: string | number): Promise<void>;
  updateApplication(applicationId: string | number, changes: { status?: string; restart_count?: number; last_restart_at?: null; last_restart_type?: null; restart_limit_reached?: boolean; custom_labels?: string }): Promise<void>;
  rememberDockerVersion(serverId: string | number, version: string | null): Promise<void>;
  /** queue_next_deployment(): start what can run now; the uuids of the deployments it started. */
  startNextQueued(applicationId: string | number, serverId: string | number | null): Promise<string[]>;
}

/** What Coolify hands to other jobs, notifications and broadcasts: Freeploy's side of each comes later. */
export type DeploymentEffect =
  /** A deployment that was started from the queue: its job must run. */
  | { type: "dispatch"; deploymentUuid: string }
  | { type: "notify"; notification: "DeploymentSuccess" | "DeploymentFailed"; deploymentUuid: string }
  /** GetContainersStatus, CleanupHelperContainersJob (after `delayMinutes`), RemoveContainerJob (a container, after `delayMinutes`). */
  | { type: "job"; job: "GetContainersStatus" | "CleanupHelperContainersJob" | "RemoveContainerJob"; serverId: string | number | null; container?: string; delayMinutes?: number }
  | { type: "event"; event: "ServiceStatusChanged" | "ApplicationConfigurationChanged" };

export interface EngineConfig {
  /** coolifyHelperImage(): the image of the helper container that runs docker compose. */
  helperImage: string;
  /** getHelperVersion() */
  helperVersion: string;
  /** gethostname(): the worker that runs the deployment. */
  worker: string | null;
}

/** The helper image Coolify 4.7.6 deploys with (config/constants.php, versions.json). */
export const DEFAULT_ENGINE_CONFIG: EngineConfig = { helperImage: "docker.io/coollabsio/coolify-helper", helperVersion: "1.0.19", worker: null };

export interface EngineDeps {
  executor: DeploymentExecutor;
  store: DeploymentStore;
  /** Carbon::now() */
  now: () => Date;
  /** Sleep::for($seconds)->seconds() */
  sleep: (seconds: number) => Promise<void>;
  effect: (effect: DeploymentEffect) => Promise<void> | void;
  config?: EngineConfig;
}

// ── Errors, as PHP classes ──────────────────────────────────────────────────────────────────────────────

/** A PHP exception: its class shows in messages and in the log. */
export interface Failure {
  /** get_class($e) */
  phpClass: string;
  message: string;
  code: number;
  /** DeploymentException::alreadyLogged(): the log already explains it. */
  alreadyLogged?: boolean;
  previous?: Failure;
}

const DEPLOYMENT_EXCEPTION = "App\\Exceptions\\DeploymentException";
const RUNTIME_EXCEPTION = "RuntimeException";
/** The code of "cancelled by user" (and of a failed registry push): the new container is not removed. */
const CANCELLED = 69420;

class PhpException extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message);
  }
}

const deploymentException = (message: string, code = 0, previous?: Failure, alreadyLogged = false): PhpException =>
  new PhpException({ phpClass: DEPLOYMENT_EXCEPTION, message, code, ...(alreadyLogged ? { alreadyLogged } : {}), ...(previous ? { previous } : {}) });
const runtimeException = (message: string, code = 0): PhpException => new PhpException({ phpClass: RUNTIME_EXCEPTION, message, code });

/** Anything thrown, as a PHP exception: an error of this code itself is an \Exception. */
function failureOf(error: unknown): Failure {
  if (error instanceof PhpException) return error.failure;
  return { phpClass: "Exception", message: error instanceof Error ? error.message : String(error), code: 0 };
}

// ── The state between two steps ─────────────────────────────────────────────────────────────────────────

export const DEPLOYMENT_STEPS = ["start", "detect", "prepare", "configure", "deploy", "health", "drain", "remove_old", "post", "failed", "finish"] as const;
export type DeploymentStep = (typeof DEPLOYMENT_STEPS)[number];

export interface EngineState {
  /** The step to run next; "done" when the deployment is over. */
  next: DeploymentStep | "done";
  /** generateApplicationContainerName(), made once when the job is created. */
  containerName: string;
  /** static::$batch_counter: the execute_remote_command() calls so far. */
  batch: number;
  /** $this->saved_outputs */
  saved: Record<string, string>;
  /** `echo $HOME` on the server. */
  home: string;
  /** The Docker config with the registry logins that the helper mounts, or null. */
  dockerConfigPath: string | null;
  /** The Docker version the server answered with (Server::rememberDockerVersion), or the stored one. */
  dockerVersion: string | null;
  /** isset($this->generated_docker_compose): the compose file was generated. */
  composeGenerated: boolean;
  /** $this->full_healthcheck_url */
  fullHealthcheckUrl: string | null;
  /** The rolling update's branch: false when the old container is stopped first. */
  rolling: boolean;
  /** Cache "deployment-new-version-healthy:<uuid>" */
  newVersionHealthy: boolean;
  /** The containers that ran before the rolling update started its new container; null outside one. */
  containerNamesBeforeRollingUpdate: string[] | null;
  /** health_check(): where its loop is. */
  health: { started: boolean; counter: number; done: boolean };
  /** The hint about hidden environment values was added to the log. */
  hintAdded: boolean;
  /** Seconds the caller waits before the next step; `ticks`: one second at a time, as Coolify's loops sleep. */
  wait: { seconds: number; ticks: boolean } | null;
  /** The exception handle()'s catch got: failed() runs with it. */
  failure: Failure | null;
  /** Whether the `finally` of handle() runs after the failure (not for a failure before its try). */
  cleanupAfterFailure: boolean;
  /** What handle() throws in the end; null when it returns. */
  thrown: Failure | null;
}

export function initialState(ctx: DeploymentContext, now: Date): EngineState {
  return {
    next: "start",
    containerName: generateApplicationContainerName(ctx.application, ctx.application, now),
    batch: 0,
    saved: {},
    home: "",
    dockerConfigPath: null,
    dockerVersion: ctx.application.server_docker_version ?? null,
    composeGenerated: false,
    fullHealthcheckUrl: null,
    rolling: false,
    newVersionHealthy: false,
    containerNamesBeforeRollingUpdate: null,
    health: { started: false, counter: 1, done: false },
    hintAdded: false,
    wait: null,
    failure: null,
    cleanupAfterFailure: false,
    thrown: null,
  };
}

// ── Pieces ──────────────────────────────────────────────────────────────────────────────────────────────

/** executeInDocker() */
export function executeInDocker(containerId: string, command: string): string {
  return `docker exec ${containerId} bash -c '${command.split("'").join("'\\''")}'`;
}

/** Server::PLACEHOLDER_IPS */
const PLACEHOLDER_IPS = ["1.2.3.4", "0.0.0.0", "::"];

/** Server::isFunctional(): reachable, usable, not disabled, and with a real address. */
export function serverIsFunctional(application: Pick<DeployDeploymentApplicationRow, "server_ip" | "server_is_reachable" | "server_is_usable" | "server_force_disabled">): boolean {
  const ip = application.server_ip;
  const placeholder = ip === null || phpTrim(ip) === "" || PLACEHOLDER_IPS.includes(ip);
  return Boolean(application.server_is_reachable) && Boolean(application.server_is_usable) && application.server_force_disabled === false && !placeholder;
}

/** The Application model's status mutator: "running" is stored as "running:unhealthy" until a status check says more. */
export function storedApplicationStatus(value: string): string {
  if (value.includes("(")) return `${phpTrim(value.slice(0, value.indexOf("(")))}:${phpTrim(value.slice(value.indexOf("(") + 1).split(")")[0] ?? "")}`;
  if (value.includes(":")) return `${phpTrim(value.slice(0, value.indexOf(":")))}:${phpTrim(value.slice(value.indexOf(":") + 1))}`;
  return `${value}:unhealthy`;
}

/** validateGitRef(): HEAD, or a ref of letters, digits, dots, hyphens, underscores and slashes. */
export function validateGitRef(input: string, context = "git ref"): string {
  const ref = phpTrim(input);
  if (ref === "" || ref === "HEAD") return ref;
  if (ref.startsWith("-")) throw new Error(`Invalid ${context}: must not start with a hyphen.`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-/]*$/.test(ref)) throw new Error(`Invalid ${context}: contains disallowed characters. Only alphanumeric characters, dots, hyphens, underscores, and slashes are allowed.`);
  return ref;
}

/** strip_tags(): what stands between "<" and ">" goes, when a tag could start there. */
function stripTags(text: string): string {
  return text.replace(/<(?:[^\s<>"']|"[^"]*"|'[^']*')(?:[^<>"']|"[^"]*"|'[^']*')*(?:>|$)/g, "");
}

/** sanitize_string(): no tags, HTML's special characters as entities, no control characters, trimmed. */
function sanitizeString(input: string): string {
  const entities: Record<string, string> = { "&": "&amp;", '"': "&quot;", "'": "&apos;", "<": "&lt;", ">": "&gt;" };
  return phpTrim(stripTags(input).replace(/[&"'<>]/g, (c) => entities[c]!).replace(/[\x00-\x1F\x7F]/g, ""));
}

/** generate_readme_file() */
export function generateReadmeFile(name: string, updatedAt: string): string {
  return `Resource name: ${sanitizeString(name)}\nLatest Deployment Date: ${sanitizeString(updatedAt)}`;
}

/** Carbon's __toString(): 'Y-m-d H:i:s', UTC. */
const dateTimeString = (date: Date): string => date.toISOString().slice(0, 19).replace("T", " ");

/** A container as `docker ps --format '{{json .}}'` prints it. */
type Container = Record<string, unknown>;

/** format_docker_command_output_to_json(): one JSON document a line; nothing when a line is not JSON. */
function parseContainers(output: string | null): Container[] {
  const containers: Container[] = [];
  for (const line of (output ?? "").split("\n")) {
    // reject(fn ($line) => empty($line))
    if (line === "" || line === "0") continue;
    try {
      const decoded: unknown = JSON.parse(line);
      containers.push(decoded !== null && typeof decoded === "object" ? (decoded as Container) : {});
    } catch {
      return [];
    }
  }
  return containers;
}

const nameOf = (container: Container): string | null => (typeof container.Names === "string" && container.Names !== "" && container.Names !== "0" ? container.Names : null);

/** The redaction of a command that embeds secrets: its base64 payloads never reach a log line or a message. */
function redactSensitiveCommandPayloads(text: string, command: string): string {
  if (text === "") return text;
  const candidates: string[] = command.match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? [];
  const payloads = candidates
    .filter((candidate, index) => candidates.indexOf(candidate) === index)
    .filter((candidate) => {
      const binary = base64DecodeStrict(candidate);
      const decoded = binary === null ? null : utf8FromBinary(binary);
      // Text: valid UTF-8 without control characters other than tab and line breaks.
      return decoded !== null && !/[^\P{C}\t\n\r]/u.test(decoded);
    })
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const payload of payloads) out = out.split(payload).join(REDACTED);
  return out;
}

const SENSITIVE_COMMAND_PLACEHOLDER = "[command hidden because it contains sensitive data]";
const CONTAINER_REMOVE_TIMEOUT_MARKER = "__COOLIFY_CONTAINER_REMOVE_TIMEOUT__";
const HOST_CA_BUNDLE_PATHS = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/ca-bundle.pem", "/etc/pki/tls/cacert.pem", "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem", "/etc/ssl/cert.pem"];
const HELPER_HOST_CA_BUNDLE_PATH = "/etc/ssl/certs/coolify-host-ca-certificates.crt";
const HELPER_CA_BUNDLE_PATH = "/etc/ssl/certs/ca-certificates.crt";
/** base_configuration_dir().'/applications' */
const APPLICATION_CONFIGURATION_DIR = "/data/coolify/applications";

/** One command of execute_remote_command(). */
interface Command {
  command: string;
  hidden?: boolean;
  /** The type of its log entries, whatever stream the output came on. */
  type?: string;
  ignoreErrors?: boolean;
  /** false: the saved output is the last piece, trimmed; otherwise the pieces are joined. */
  append?: boolean;
  save?: string;
  /** Content for the command's stdin. */
  input?: string;
  /** The command embeds secrets: it is never logged, and its payloads are redacted from its output. */
  skipCommandLog?: boolean;
  /** A cleanup command that must also run after a cancel. */
  skipCancellationCheck?: boolean;
}

// ── The job ─────────────────────────────────────────────────────────────────────────────────────────────

class Job {
  private readonly config: EngineConfig;
  private readonly secrets: LogRedactionSecrets;
  private composed: ComposeResult | null = null;

  constructor(
    private readonly deps: EngineDeps,
    private readonly ctx: DeploymentContext,
    readonly state: EngineState,
  ) {
    this.config = deps.config ?? DEFAULT_ENGINE_CONFIG;
    this.secrets = logRedactionSecretsFor(ctx.variables, ctx.application.redact_all_env_values_in_logs !== false);
  }

  private get app(): DeployDeploymentApplicationRow {
    return this.ctx.application;
  }
  private get id(): string | number {
    return this.ctx.deployment.id;
  }
  private get uuid(): string {
    return this.ctx.deployment.deployment_uuid;
  }
  /** $this->basedir, and $this->workdir: a Docker image application has no base directory. */
  private get workdir(): string {
    return `/artifacts/${this.uuid}`;
  }
  private get configurationDir(): string {
    return `${APPLICATION_CONFIGURATION_DIR}/${this.app.uuid}`;
  }
  private get network(): string {
    return this.app.destination_network ?? "";
  }
  private get imageTag(): string {
    return resolveDockerImageTag(this.app, this.ctx.deployment);
  }
  private get image(): string {
    return productionImageName(this.app.docker_registry_image_name, this.imageTag);
  }
  private get consistentName(): boolean {
    return Boolean(this.app.is_consistent_container_name_enabled);
  }

  // The log.

  private async log(message: string, type = "stdout", hidden = false, command: string | null = null, batch = 1): Promise<void> {
    const built = buildLogEntry({ message, type, hidden, command, batch }, this.secrets, this.deps.now(), this.state.hintAdded);
    if (built.hint) this.state.hintAdded = true;
    await this.deps.store.appendLog(this.id, built.entry, built.hint);
  }

  private async logAll(entries: EnvLogEntry[]): Promise<void> {
    for (const entry of entries) await this.log(entry.message, entry.type);
  }

  /** redact_sensitive_info() */
  private redact(text: string): string {
    return redactLogText(text, this.secrets);
  }

  // Remote commands.

  private async cancelled(): Promise<boolean> {
    return (await this.deps.store.status(this.id)) === DEPLOYMENT_STATUS.cancelledByUser;
  }

  /** checkForCancellation() */
  private async checkForCancellation(): Promise<void> {
    if (await this.cancelled()) {
      await this.log("Deployment cancelled by user, stopping execution.");
      throw deploymentException("Deployment cancelled by user", CANCELLED);
    }
  }

  /**
   * instant_remote_process(): the batch's trimmed output, null for "null". A failure throws the error text
   * (or its exit code), unless `throwError` is false: then null.
   */
  private async instant(commands: string[], throwError = true): Promise<string | null> {
    const result = await this.deps.executor.run({ script: commands.join("\n") });
    if (result.exitCode !== 0) {
      if (!throwError) return null;
      // excludeCertainErrors()
      throw runtimeException(phpTrim(result.stderr) || `SSH command failed with exit code: ${result.exitCode}`, result.exitCode);
    }
    const output = phpTrim(result.stdout);
    return output === "null" ? null : sanitize_utf8_text(output);
  }

  /** execute_remote_command(): each command its own process, with its log entries and saved output. */
  private async exec(...commands: Command[]): Promise<void> {
    this.state.batch++;
    const batch = this.state.batch;
    for (const c of commands) {
      // Check for cancellation before executing commands. Cleanup commands must also run after a cancel.
      if (!c.skipCancellationCheck && (await this.cancelled())) throw runtimeException("Deployment cancelled by user", CANCELLED);

      const addLogEntry = async (stream: "out" | "err", output: string): Promise<void> => {
        const text = phpTrim(sanitize_utf8_text(output));
        await this.log(c.skipCommandLog ? redactSensitiveCommandPayloads(text, c.command) : text, c.type ?? (stream === "err" ? "stderr" : "stdout"), c.hidden ?? false, c.skipCommandLog ? null : c.command, batch);
      };
      // Output is logged per complete line, so a secret split across two output chunks is still redacted.
      const pending = new Map<"out" | "err", string>();
      const onOutput = async (stream: "out" | "err", chunk: string): Promise<void> => {
        const waiting = (pending.get(stream) ?? "") + chunk;
        const end = Math.max(waiting.lastIndexOf("\n"), waiting.lastIndexOf("\r"));
        const { taken, rest } = takeLines(waiting, end);
        pending.set(stream, rest);
        if (taken !== "") await addLogEntry(stream, taken);
        // saveCommandOutput()
        if (c.save) {
          const piece = sanitize_utf8_text(chunk);
          this.state.saved[c.save] = c.append === false ? phpTrim(piece) : (this.state.saved[c.save] ?? "") + piece;
        }
      };
      const result = await this.deps.executor.run(c.input === undefined ? { script: c.command } : { script: c.command, input: c.input }, onOutput);
      // What is left when the process ends, in the order the streams first spoke.
      for (const [stream, waiting] of pending) {
        const remaining = waiting.replace(UNFINISHED_PRIVATE_KEY, REDACTED);
        if (remaining !== "") await addLogEntry(stream, remaining);
      }
      if (result.exitCode !== 0 && !c.ignoreErrors) {
        // Check if deployment was cancelled while command was running
        if (await this.cancelled()) throw runtimeException("Deployment cancelled by user", CANCELLED);
        // empty(): "" and "0".
        let error = result.stderr;
        if (error === "" || error === "0") error = result.stdout !== "" && result.stdout !== "0" ? result.stdout : "Command failed with no error output";
        throw deploymentException(this.commandFailureMessage(c.command, result.exitCode, error, Boolean(c.skipCommandLog)), result.exitCode);
      }
    }
  }

  /** commandFailureMessage(): the command and its error, redacted, and what usually helps. */
  private commandFailureMessage(command: string, exitCode: number, error: string, sensitive: boolean): string {
    const commandText = sensitive ? SENSITIVE_COMMAND_PLACEHOLDER : this.redact(command);
    const redacted = this.redact(sensitive ? redactSensitiveCommandPayloads(error, command) : error);
    let hints = "";
    if (/ParseAddr\("[0-9A-Fa-f:.]+\/\d+"\)/.test(redacted)) {
      hints += "\nDocker Engine on this server reports a Docker network gateway with a prefix length, which is a Docker Engine bug fixed in 28.0.1. Run 'systemctl restart docker' on the server (this restarts all containers) or upgrade Docker Engine, then deploy again.";
    }
    if (/pull access denied|requested access to the resource is denied|no basic auth credentials|unauthorized: authentication required|\/v2\/[^"\s]*": (?:unauthorized|denied)/i.test(redacted)) {
      hints += `\nThe registry refused access to the image. Deployments use the Docker registry logins of the SSH user (${this.app.server_user ?? "root"}) on the server ${this.app.server_name ?? ""}. Log in to the registry on the Registries page of this server, then deploy again. If a 'docker pull' of the image on the server also fails, the token cannot read the image: check its scopes.`;
    }
    if (exitCode === 255) {
      hints += "\nExit code 255 usually means that the SSH connection to the server closed before the command finished. Check the network between Freeploy and the server, and the sshd logs and memory usage of the server, then deploy again.";
    }
    return `Command execution failed (exit code ${exitCode}): ${commandText}\nError: ${redacted}${hints}`;
  }

  /** getCurrentApplicationContainerStatus(): the application's containers that are no preview's. */
  private async containers(): Promise<Container[]> {
    const output = await this.instant(dockerPsByOwnerCommands("application", this.app.uuid));
    const seen = new Set<unknown>();
    const owned = parseContainers(output).filter((c) => Object.keys(c).length > 0 && !seen.has(c.ID) && seen.add(c.ID));
    return owned.filter((container) => {
      const labels = typeof container.Labels === "string" ? container.Labels : "";
      const pullRequest = /coolify\.pullRequestId=(\d+)/.exec(labels);
      // A missing label or pullRequestId=0 is the base deployment.
      return !labels.includes("coolify.pullRequestId=") || Number(pullRequest?.[1] ?? 0) === 0;
    });
  }

  /** generate_compose_file()'s result, generated once a step. */
  private compose(): ComposeResult {
    if (this.composed) return this.composed;
    const input: ComposeInput = {
      application: this.app,
      settings: this.app,
      containerName: this.state.containerName,
      productionImageName: this.image,
      network: this.network,
      primaryNetwork: this.network,
      projectName: this.app.project_name,
      environmentName: this.app.environment_name,
      logDrain: this.app,
      persistentStorages: this.ctx.persistentStorages,
      fileStorages: this.ctx.fileStorages,
      generateLabels: this.ctx.generateLabels,
    };
    try {
      this.composed = generateComposeFile(input);
    } catch (e) {
      if (e instanceof ComposeError) throw deploymentException(e.message);
      throw e;
    }
    return this.composed;
  }

  // ── handle(), before its try ──

  async start(): Promise<void> {
    const s = this.state;
    // Check if deployment was cancelled before we even started
    if (await this.cancelled()) {
      await this.log("Deployment was cancelled before starting.");
      s.next = "done";
      return;
    }
    try {
      try {
        await this.logAll(validateDeploymentEnvironmentVariableKeys(this.ctx.variables));
      } catch (e) {
        if (e instanceof RuntimeEnvError) {
          await this.logAll((e as RuntimeEnvError & { logs?: EnvLogEntry[] }).logs ?? []);
          throw deploymentException(e.message, 0, { phpClass: "InvalidArgumentException", message: "Invalid build-time environment variable key.", code: 0 }, true);
        }
        throw e;
      }
      this.refuseWhatIsNotPorted();
    } catch (e) {
      // "$this->fail($e); throw $e;": failed() runs, and nothing of handle()'s finally.
      s.failure = failureOf(e);
      s.cleanupAfterFailure = false;
      s.thrown = s.failure;
      s.next = "failed";
      return;
    }
    // A conditional update, so a cancel that came after the check above is not overwritten.
    if ((await this.deps.store.markInProgress(this.id, this.config.worker)) === DEPLOYMENT_STATUS.cancelledByUser) {
      await this.log("Deployment was cancelled before starting.");
      s.next = "done";
      return;
    }
    if (!serverIsFunctional(this.app)) {
      await this.log("Server is not functional.");
      // $this->fail('Server is not functional.'): failed() with a ManuallyFailedException, then handle() returns.
      s.failure = { phpClass: "Illuminate\\Queue\\ManuallyFailedException", message: "Server is not functional.", code: 0 };
      s.cleanupAfterFailure = false;
      s.next = "failed";
      return;
    }
    s.next = "detect";
  }

  /** What this engine does not deploy: said before anything runs on the server. */
  private refuseWhatIsNotPorted(): void {
    const app = this.app;
    if (app.build_pack !== "dockerimage") throw deploymentException(`Deploying the ${app.build_pack} build pack is not available yet.`);
    if (this.ctx.deployment.pull_request_id !== 0) throw deploymentException("Preview deployments are not available yet.");
    if (app.server_is_swarm_manager || app.server_is_swarm_worker) throw deploymentException("Deploying to a Swarm cluster is not available yet.");
    if ((app.server_user ?? "root") !== "root") throw deploymentException(`Deploying to a server with a non-root user (${app.server_user}) is not available yet.`);
    if (this.ctx.fileStorages.some((storage) => !storage.is_directory && storage.has_content)) throw deploymentException("Deploying an application with file storages is not available yet: their content is not written to the server.");
  }

  // ── handle(), its try ──

  /** networkHostFlags() and detectBuildKitCapabilities(). */
  async detect(): Promise<void> {
    const app = this.app;
    if (app.dockerfile_target_build !== null && app.dockerfile_target_build !== "" && app.dockerfile_target_build !== "0" && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(app.dockerfile_target_build)) {
      throw runtimeException("Invalid dockerfile_target_build: contains forbidden characters.");
    }
    // The --add-host flags of a build: a Docker image deployment builds nothing, so only the command runs.
    if (app.include_network_hosts_in_build !== false) await this.instant([`docker network inspect ${escapeshellarg(this.network)} -f '{{json .Containers}}' `]);

    const serverName = `deployment server (${app.server_name ?? ""})`;
    try {
      const dockerVersion = await this.instant(["docker version --format '{{.Server.Version}}'"]);
      const remembered = parseDockerEngineVersion(dockerVersion);
      await this.deps.store.rememberDockerVersion(app.server_id ?? 0, remembered);
      this.state.dockerVersion = remembered;
      const parts = (dockerVersion ?? "").split(".");
      const major = parseInt(parts[0] ?? "", 10) || 0;
      const minor = parseInt(parts[1] ?? "", 10) || 0;
      if (major < 18 || (major === 18 && minor < 9)) {
        await this.log(`Docker ${dockerVersion ?? ""} on ${serverName} does not support BuildKit (requires 18.09+).`);
        return;
      }
      let buildkit = false;
      // Check buildx availability
      const buildx = await this.instant(["docker buildx version >/dev/null 2>&1 && echo 'available' || echo 'not-available'"]);
      if (phpTrim(buildx ?? "") === "available") {
        buildkit = true;
        await this.log(`Docker ${dockerVersion ?? ""} with BuildKit and Buildx detected on ${serverName}.`);
      } else {
        // Fallback: test DOCKER_BUILDKIT=1 support via --progress flag
        const test = await this.instant(["DOCKER_BUILDKIT=1 docker build --help 2>&1 | grep -q '\\-\\-progress' && echo 'supported' || echo 'not-supported'"]);
        if (phpTrim(test ?? "") === "supported") {
          buildkit = true;
          await this.log(`Docker ${dockerVersion ?? ""} with BuildKit support detected on ${serverName}.`);
        } else {
          await this.log(`Docker ${dockerVersion ?? ""} on ${serverName} does not support BuildKit. Build output progress will be limited.`);
        }
      }
      if (app.use_build_secrets && buildkit) {
        const secrets = await this.instant(["docker build --help 2>&1 | grep -q 'secret' && echo 'supported' || echo 'not-supported'"]);
        if (phpTrim(secrets ?? "") === "supported") await this.log("Build secrets are enabled and will be used for enhanced security.");
        else await this.log(`Docker on ${serverName} does not support build secrets. Using traditional build arguments.`);
      }
    } catch (e) {
      await this.log(`Could not detect BuildKit capabilities on ${serverName}: ${failureOf(e).message}`);
    }
  }

  /** deploy_dockerimage_buildpack() up to prepare_builder_image(), with the pre-deployment command. */
  async prepare(): Promise<void> {
    const app = this.app;
    const tag = this.imageTag;
    const display = tag.startsWith("sha256-") ? `${app.docker_registry_image_name ?? ""}@sha256:${tag.slice("sha256-".length)}` : `${app.docker_registry_image_name ?? ""}:${tag}`;
    await this.log(`Starting deployment of ${display} to ${app.server_name ?? ""}.`);

    // prepare_builder_image()
    await this.checkForCancellation();
    const helperImage = `${this.config.helperImage}:${this.config.helperVersion}`;
    // Get user home directory
    this.state.home = (await this.instant(["echo $HOME"])) ?? "";
    const home = this.state.home;
    await this.instant([`mkdir -p ${home}/.docker/buildx`]);
    // dockerConfigPath(): the config of the SSH user.
    const configPath = `${home}/.docker/config.json`;
    this.state.dockerConfigPath = (await this.instant([`test -f ${configPath} && echo 'OK' || echo 'NOK'`])) === "OK" ? configPath : null;
    const buildxMetadataVolume = `-v ${home}/.docker/buildx:/root/.docker/buildx`;
    // hostCaBundleMount(): the helper trusts the same registries as the Docker daemon.
    const bundle = await this.instant([`for f in ${HOST_CA_BUNDLE_PATHS.join(" ")}; do if [ -f "$f" ]; then echo "$f"; break; fi; done`], false);
    // Unlike -v, --mount does not create a missing source as a directory on the server.
    const hostCaBundleVolume = bundle !== null && HOST_CA_BUNDLE_PATHS.includes(bundle) ? ` --mount type=bind,source=${bundle},target=${HELPER_HOST_CA_BUNDLE_PATH},readonly` : "";
    // docker compose runs in this helper and reads seccomp profile files from the custom Docker options
    const seccompMounts = seccompProfileMountFlags(app.custom_docker_run_options);
    const safeNetwork = escapeshellarg(this.network);
    // No build secrets in a deployment that builds nothing: the helper's environment stays empty.
    const envFlags = "";
    const runCommand =
      this.state.dockerConfigPath !== null
        ? `docker run -d --network ${safeNetwork} --name ${this.uuid} ${envFlags} --rm -v ${this.state.dockerConfigPath}:/root/.docker/config.json:ro ${buildxMetadataVolume}${hostCaBundleVolume} -v /var/run/docker.sock:/var/run/docker.sock ${seccompMounts} ${helperImage}`
        : `docker run -d --network ${safeNetwork} --name ${this.uuid} ${envFlags} --rm ${buildxMetadataVolume}${hostCaBundleVolume} -v /var/run/docker.sock:/var/run/docker.sock ${seccompMounts} ${helperImage}`;
    await this.log(`Preparing container with helper image: ${helperImage}`);

    // "docker stop" returns before the --rm auto-removal frees the name, so the "docker run" below can conflict with it.
    await this.removeContainerWithTimeout(this.uuid);
    const commands: Command[] = [{ command: runCommand, hidden: true }];
    // git and curl use OpenSSL, which reads only the helper bundle
    if (hostCaBundleVolume !== "") commands.push({ command: executeInDocker(this.uuid, `cat ${HELPER_HOST_CA_BUNDLE_PATH} >> ${HELPER_CA_BUNDLE_PATH}`), hidden: true });
    commands.push({ command: executeInDocker(this.uuid, `mkdir -p ${this.workdir}`) });
    commands.push({ command: executeInDocker(this.uuid, gitSshSetupCommand(this.uuid, app.git_ssh_known_hosts)), hidden: true });
    await this.exec(...commands);
    await this.runPreDeploymentCommand();
  }

  /** removeContainerWithTimeout() */
  private async removeContainerWithTimeout(containerName: string): Promise<void> {
    const key = `container_remove_${containerName}`;
    await this.exec({ command: dockerRemoveCommandWithTimeout(containerName), hidden: true, ignoreErrors: true, save: key, append: false });
    if (!(this.state.saved[key] ?? "").includes(CONTAINER_REMOVE_TIMEOUT_MARKER)) return;
    await this.log(`Warning: Removing container ${containerName} timed out after 60 seconds. The deployment will continue and cleanup will be retried in 5 minutes.`, "stderr");
    await this.deps.effect({ type: "job", job: "RemoveContainerJob", serverId: this.app.server_id, container: containerName, delayMinutes: 5 });
  }

  /** resolveCommandContainer(): the one container, or the one named for an application with several. */
  private async resolveCommandContainer(containers: Container[], specified: string | null, commandType: string): Promise<Container | null> {
    if (containers.length === 0) return null;
    if (containers.length === 1) return containers[0]!;
    const available = containers.map((c) => (typeof c.Names === "string" ? c.Names : "")).join(", ");
    // Multi-container: require a container name to be specified
    if (specified === null || specified === "" || specified === "0") {
      await this.log(`${commandType} command: Multiple containers found but no container name specified. Available: ${available}`);
      return null;
    }
    // Multi-container: match by specified name prefix
    const prefix = `${specified}-${this.app.uuid}`;
    const match = containers.find((c) => typeof c.Names === "string" && c.Names.startsWith(prefix));
    if (match) return match;
    await this.log(`${commandType} command: Container '${specified}' not found. Available: ${available}`);
    return null;
  }

  /**
   * The command inside the container: the user's command is arbitrary shell input by design; the single quote
   * escaping keeps it inside `sh -c`, and line breaks become spaces.
   */
  private commandInContainer(containerName: string | null, command: string): string {
    if (containerName !== null && !CONTAINER_NAME_PATTERN.test(containerName)) throw runtimeException("Invalid container name: contains forbidden characters.");
    return `docker exec ${containerName ?? ""} sh -c '${command.replace(/\r\n|\r|\n/g, " ").split("'").join("'\\''")}'`;
  }

  /** run_pre_deployment_command() */
  private async runPreDeploymentCommand(): Promise<void> {
    const command = this.app.pre_deployment_command;
    if (command === null || command === "" || command === "0") return;
    const containers = await this.containers();
    if (containers.length === 0) {
      await this.log("Pre-deployment command: No running containers found. Skipping.");
      return;
    }
    await this.log("Executing pre-deployment command (see debug log for output/errors).");
    const container = await this.resolveCommandContainer(containers, this.app.pre_deployment_command_container, "Pre-deployment");
    if (container === null) throw deploymentException("Pre-deployment command: Could not find a valid container. Is the container name correct?");
    await this.exec({ command: this.commandInContainer(nameOf(container), command), hidden: true });
  }

  /** run_post_deployment_command() */
  private async runPostDeploymentCommand(): Promise<void> {
    const command = this.app.post_deployment_command;
    if (command === null || command === "" || command === "0") return;
    await this.log("----------------------------------------");
    await this.log("Executing post-deployment command (see debug log for output).");
    const containers = await this.containers();
    if (containers.length === 0) {
      await this.log("Post-deployment command: No running containers found. Skipping.");
      return;
    }
    const container = await this.resolveCommandContainer(containers, this.app.post_deployment_command_container, "Post-deployment");
    if (container === null) throw deploymentException("Post-deployment command: Could not find a valid container. Is the container name correct?");
    const exec = this.commandInContainer(nameOf(container), command);
    try {
      await this.exec({ command: exec, hidden: true, save: "post-deployment-command-output" });
    } catch {
      const output = this.state.saved["post-deployment-command-output"];
      if (output !== undefined && output !== "" && output !== "0") {
        await this.log("Post-deployment command failed.");
        await this.log(output, "stderr");
      }
    }
  }

  /** generate_compose_file() and save_runtime_environment_variables(). */
  async configure(): Promise<void> {
    // generate_compose_file()
    await this.checkForCancellation();
    // create_workdir()
    await this.exec({ command: executeInDocker(this.uuid, `mkdir -p ${this.workdir}`) }, { command: `mkdir -p ${this.configurationDir}` });
    const compose = this.compose();
    if (compose.customLabels !== undefined) await this.deps.store.updateApplication(this.app.id, { custom_labels: compose.customLabels });
    await this.logAll(compose.logs);
    this.state.composeGenerated = true;
    this.state.fullHealthcheckUrl = compose.fullHealthcheckUrl;

    // save_runtime_environment_variables(): the .env file with all runtime variables.
    let env;
    try {
      env = generateRuntimeEnvironmentVariables({
        application: this.app,
        settings: this.app,
        commit: this.ctx.deployment.commit,
        containerName: this.state.containerName,
        projectName: this.app.project_name,
        environmentName: this.app.environment_name,
        serverIp: this.app.server_ip,
        variables: this.ctx.variables,
      });
    } catch (e) {
      if (e instanceof RuntimeEnvError) throw deploymentException(e.message, 0, undefined, e.alreadyLogged);
      throw e;
    }
    await this.logAll(env.logs);
    // Each .env write first removes the file: Coolify writes a regular file, never through a link.
    if (env.lines.length === 0) {
      // The compose file always references .env, so an empty one is created.
      await this.log("Creating empty .env file (no environment variables defined).");
      await this.exec({ command: executeInDocker(this.uuid, `rm -f ${this.workdir}/.env && touch ${this.workdir}/.env`) });
      await this.exec({ command: `rm -f ${this.configurationDir}/.env`, hidden: true }, { command: `touch ${this.configurationDir}/.env` });
      return;
    }
    const encoded = base64Encode(env.lines.join("\n"));
    await this.log("Creating .env file with runtime variables for container.", "stdout", true);
    await this.exec({ command: executeInDocker(this.uuid, `rm -f ${this.workdir}/.env && echo '${encoded}' | base64 -d | tee ${this.workdir}/.env > /dev/null`), skipCommandLog: true });
    await this.exec({ command: `rm -f ${this.configurationDir}/.env`, hidden: true }, { command: `echo '${encoded}' | base64 -d | tee ${this.configurationDir}/.env > /dev/null`, skipCommandLog: true });
  }

  /** "Rolling update failed (<class>): <message>" around what rolling_update() does. */
  private async rollingUpdate<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const failure = failureOf(e);
      throw deploymentException(`Rolling update failed (${failure.phpClass}): ${failure.message}`, failure.code, failure);
    }
  }

  /** rolling_update() up to the new container: started first (a rolling update), or after the old one is stopped. */
  async deploy(): Promise<void> {
    await this.rollingUpdate(async () => {
      const app = this.app;
      // startDeployPhase(): from here on a newer deployment does not cancel this one.
      await this.deps.store.markDeployStarted(this.id);
      await this.checkForCancellation();
      // write_compose_file_to_workdir(): after any build, so the file never ends up in an image.
      const compose = this.compose();
      await this.exec(
        { command: `docker exec ${this.uuid} rm -f ${this.workdir}/docker-compose.yaml`, hidden: true },
        { command: `docker exec -i ${this.uuid} tee ${this.workdir}/docker-compose.yaml > /dev/null`, input: compose.yaml, hidden: true },
      );
      const mapped = explodeList(app.ports_mappings).length > 0;
      const customIp = (app.custom_docker_run_options ?? "").includes("--ip");
      if (mapped || this.consistentName || customIp) {
        await this.log("----------------------------------------");
        if (mapped) await this.log("Application has ports mapped to the host system, rolling update is not supported.");
        if (this.consistentName) await this.log("Consistent container name feature enabled, rolling update is not supported.");
        if (this.consistentName && app.custom_internal_name !== null && app.custom_internal_name !== "") await this.log("Custom internal name is set, rolling update is not supported.");
        if (customIp) await this.log("Custom IP address is set, rolling update is not supported.");
        this.state.rolling = false;
        await this.stopRunningContainer(true);
        await this.startByComposeFile();
        this.state.next = "post";
        return;
      }
      await this.log("----------------------------------------");
      await this.log("Rolling update started.");
      this.state.rolling = true;
      this.state.containerNamesBeforeRollingUpdate = (await this.containers()).map((c) => c.Names as string);
      await this.startByComposeFile();
      this.state.next = "health";
    });
  }

  /** start_by_compose_file() */
  private async startByComposeFile(): Promise<void> {
    try {
      // Ensure .env file exists before docker compose tries to load it (defensive programming)
      await this.exec({ command: `touch ${this.configurationDir}/.env`, hidden: true }, { command: `docker network connect ${escapeshellarg(this.network)} coolify-proxy >/dev/null 2>&1 || true`, hidden: true, ignoreErrors: true });
      const project = `docker compose --project-name ${this.app.uuid} --project-directory ${this.workdir}`;
      await this.pullDockerImage(project);
      // "{$this->coolify_variables} docker compose …": a Docker image deployment has none, the space stays.
      await this.exec({ command: executeInDocker(this.uuid, ` ${project} up --build -d`), hidden: true });
      await this.log("New container started.");
    } catch (e) {
      const failure = failureOf(e);
      throw deploymentException(`Failed to start container: ${failure.message}`, failure.code, failure);
    }
  }

  /**
   * pull_docker_image(): an image that is only on the server cannot be pulled. When the pull fails, the
   * deployment starts the image that is on the server. Without that image, the pull error stops it.
   */
  private async pullDockerImage(project: string): Promise<void> {
    await this.log("Pulling latest images from the registry.");
    try {
      await this.exec({ command: executeInDocker(this.uuid, `${project} pull`), hidden: true });
    } catch (e) {
      if (!(e instanceof PhpException) || e.failure.phpClass !== DEPLOYMENT_EXCEPTION) throw e;
      await this.exec({
        command: executeInDocker(this.uuid, `docker image inspect --format ${escapeshellarg("{{.Id}}")} ${escapeshellarg(this.image)} 2>/dev/null || true`),
        hidden: true,
        save: "local_docker_image",
        append: false,
      });
      if ((this.state.saved.local_docker_image ?? "") === "") throw e;
      await this.log(`Could not pull the image (${this.image}) from the registry. Using the image that is already on the server.`, "stderr");
    }
  }

  /** health_check(): its start, then one attempt a call, so the waits between them are the caller's. */
  async health(): Promise<void> {
    await this.rollingUpdate(async () => {
      try {
        await this.healthCheck();
      } catch (e) {
        const failure = failureOf(e);
        throw deploymentException(`Health check failed (${failure.phpClass}): ${failure.message}`, failure.code, failure);
      }
    });
  }

  private async healthCheck(): Promise<void> {
    const app = this.app;
    const s = this.state;
    const h = s.health;
    const disabled = app.health_check_enabled === false;
    if (!h.started) {
      if (disabled && app.custom_healthcheck_found === false) {
        s.newVersionHealthy = true;
        s.next = "drain";
        return;
      }
      if (disabled) await this.log("Using the custom healthcheck from the Dockerfile.");
      await this.log("Waiting for healthcheck to pass on the new container.");
      if (s.fullHealthcheckUrl !== null && s.fullHealthcheckUrl !== "" && s.fullHealthcheckUrl !== "0") {
        await this.log(`${app.health_check_type === "cmd" ? "Healthcheck command" : "Healthcheck URL"} (inside the container): ${s.fullHealthcheckUrl}`);
      }
      await this.log(`Waiting for the start period (${app.health_check_start_period} seconds) before starting healthcheck.`);
      h.started = true;
      if (app.health_check_start_period > 0) s.wait = { seconds: app.health_check_start_period, ticks: true };
      return;
    }
    const escaped = escapeshellarg(s.containerName);
    if (h.counter <= app.health_check_retries) {
      await this.exec(
        { command: `docker inspect --format='{{json .State.Health.Status}}' ${escaped}`, hidden: true, save: "health_check", append: false },
        { command: `docker inspect --format='{{json .State.Health.Log}}' ${escaped}`, hidden: true, save: "health_check_logs", append: false },
      );
      await this.log(`Attempt ${h.counter} of ${app.health_check_retries} | Healthcheck status: ${s.saved.health_check ?? ""}`);
      const last = lastHealthLog(s.saved.health_check_logs);
      if (last.output !== "(no logs)" || last.code !== "(no return code)") await this.log(`Healthcheck logs: ${last.output} | Return code: ${last.code}`);
      const status = this.healthStatus();
      if (status === "healthy") {
        s.newVersionHealthy = true;
        await this.deps.store.updateApplication(app.id, { status: storedApplicationStatus("running") });
        await this.log("New container is healthy.");
        h.done = true;
      } else if (status === "unhealthy") {
        s.newVersionHealthy = false;
        await this.log("New container is unhealthy.", "error");
        await this.queryLogs();
        h.done = true;
      } else {
        // The loop sleeps after every attempt that settles nothing, the last one too.
        h.counter++;
        if (app.health_check_interval > 0) {
          s.wait = { seconds: app.health_check_interval, ticks: true };
          return;
        }
        if (h.counter <= app.health_check_retries) return;
      }
    }
    if (this.healthStatus() === "starting") await this.queryLogs();
    s.next = "drain";
  }

  private healthStatus(): string {
    return phpTrim(this.state.saved.health_check ?? "").split('"').join("");
  }

  /** query_logs() */
  private async queryLogs(): Promise<void> {
    await this.log("----------------------------------------");
    await this.log("Container logs:");
    await this.exec({ command: remoteCommandWithTimeout(`docker logs -n 100 ${escapeshellarg(this.state.containerName)}`, 30), type: "stderr", ignoreErrors: true });
    await this.log("----------------------------------------");
  }

  /**
   * wait_for_proxy_to_route_new_container(): the proxy adds the new container some seconds after it is
   * healthy. Stopping the old container before that sends requests to a closed port.
   */
  async drain(): Promise<void> {
    await this.rollingUpdate(async () => {
      const s = this.state;
      s.next = "remove_old";
      const seconds = Math.min(Math.max(this.app.rolling_update_drain_seconds ?? DEFAULT_ROLLING_UPDATE_DRAIN_SECONDS, 0), MAX_ROLLING_UPDATE_DRAIN_SECONDS);
      if (seconds === 0 || !s.newVersionHealthy) return;
      const old = (await this.containers()).filter((c) => c.State === "running" && c.Names !== s.containerName).map((c) => c.Names as string);
      if (old.length === 0) return;
      if (await this.proxyLabelsChanged(old)) {
        // The proxy drops a route that two containers define differently until the old one stops.
        await this.log("The proxy labels changed, so the old containers stop without waiting.");
        return;
      }
      await this.log(`Waiting ${seconds} seconds for the proxy to send traffic to the new container.`);
      s.wait = { seconds, ticks: false };
    });
  }

  private async proxyLabelsChanged(oldContainerNames: string[]): Promise<boolean> {
    const names = [this.state.containerName, ...oldContainerNames].map(escapeshellarg).join(" ");
    const output = await this.instant([`docker inspect --format '{{json .Config.Labels}}' ${names}`], false);
    const sets = new Set<string>();
    for (const line of phpTrim(output ?? "").split(/\r\n|[\n\v\f\r]/)) {
      let labels: unknown = null;
      try {
        labels = JSON.parse(line);
      } catch {
        labels = null;
      }
      const proxy = Object.entries(labels !== null && typeof labels === "object" ? (labels as Record<string, unknown>) : {})
        .filter(([key]) => key.startsWith("traefik.") || key.startsWith("caddy"))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      sets.add(JSON.stringify(proxy));
    }
    return sets.size > 1;
  }

  /** The end of a rolling update: stop_running_container(). */
  async removeOld(): Promise<void> {
    await this.rollingUpdate(async () => {
      await this.stopRunningContainer(false);
      await this.log("Rolling update completed.");
      this.state.next = "post";
    });
  }

  /** stop_running_container() */
  private async stopRunningContainer(force: boolean): Promise<void> {
    const s = this.state;
    try {
      await this.log("Removing old containers.");
      if (s.newVersionHealthy || force) {
        const names = (await this.containers()).map(nameOf);
        let remove: string[];
        if (this.consistentName) {
          // containerNamesToRemove(): every container of the application, and the name the new one takes.
          remove = [...names, s.containerName].filter((n): n is string => n !== null).filter((n, i, all) => all.indexOf(n) === i);
        } else {
          // oldGeneratedContainerNames(): all except the new one, and after a rolling update only the ones that ran before it.
          remove = names.filter((n): n is string => n !== null && n !== s.containerName);
          const before = s.containerNamesBeforeRollingUpdate;
          if (before !== null) remove = remove.filter((n) => before.includes(n));
        }
        for (const name of remove) await this.gracefulShutdownContainer(name);
      } else {
        await this.log("----------------------------------------");
        await this.log("WARNING: Dockerfile or Docker Image based deployment detected. The healthcheck needs a curl or wget command to check the health of the application. Please make sure that it is available in the image or turn off healthcheck on Freeploy's UI.");
        await this.log("----------------------------------------");
        await this.log("New container is not healthy, rolling back to the old container.");
        await this.transitionToStatus("failed");
        await this.gracefulShutdownContainer(s.containerName);
      }
    } catch (e) {
      const failure = failureOf(e);
      // If new version is healthy, this is just cleanup - don't fail the deployment
      if (s.newVersionHealthy || force) {
        await this.log(`Warning: Could not remove old container: ${failure.message}`, "stderr", true);
        return;
      }
      throw deploymentException(`Failed to stop running container: ${failure.message}`, failure.code, failure);
    }
  }

  /** graceful_shutdown_container() */
  private async gracefulShutdownContainer(containerName: string, skipRemove = false): Promise<void> {
    try {
      const stop = dockerStopCommand(stopGracePeriodSeconds(this.app.stop_grace_period), escapeshellarg(containerName), this.state.dockerVersion);
      if (skipRemove) {
        // The helper container (started with --rm) must also stop when the deployment was cancelled.
        await this.exec({ command: stop, hidden: true, ignoreErrors: true, skipCancellationCheck: true });
      } else {
        await this.exec({ command: stop, hidden: true, ignoreErrors: true });
        await this.removeContainerWithTimeout(containerName);
      }
    } catch (e) {
      await this.log(`Error stopping container ${containerName}: ${failureOf(e).message}`, "stderr");
    }
  }

  /** transitionToStatus(): the single source of truth for status transitions. */
  private async transitionToStatus(status: "finished" | "failed"): Promise<void> {
    // isInTerminalState(): finished and failed cannot be changed, and a cancel stops the job.
    const current = await this.deps.store.status(this.id);
    if (current === DEPLOYMENT_STATUS.finished || current === DEPLOYMENT_STATUS.failed) return;
    if (current === DEPLOYMENT_STATUS.cancelledByUser) {
      await this.log("Deployment cancelled by user, stopping execution.");
      throw deploymentException("Deployment cancelled by user", CANCELLED);
    }
    await this.deps.store.setStatus(this.id, status);
    // The status is stored. Side effect failures are logged so they cannot flip a finished deployment to
    // failed or stop the next queued deployment from starting.
    try {
      if (status === "finished") {
        // Reset restart count after successful deployment
        await this.deps.store.updateApplication(this.app.id, { restart_count: 0, last_restart_at: null, last_restart_type: null, restart_limit_reached: false });
        await this.deps.effect({ type: "event", event: "ApplicationConfigurationChanged" });
        await this.deps.effect({ type: "notify", notification: "DeploymentSuccess", deploymentUuid: this.uuid });
      } else {
        await this.deps.effect({ type: "notify", notification: "DeploymentFailed", deploymentUuid: this.uuid });
      }
    } catch (e) {
      await this.logSideEffectFailure(`Post-${status} actions failed`, e);
    }
    try {
      for (const deploymentUuid of await this.deps.store.startNextQueued(this.app.id, this.ctx.deployment.server_id)) await this.deps.effect({ type: "dispatch", deploymentUuid });
    } catch (e) {
      await this.logSideEffectFailure("Starting the next queued deployment failed", e);
    }
  }

  private async logSideEffectFailure(context: string, error: unknown): Promise<void> {
    try {
      await this.log(`Warning: ${context}: ${failureOf(error).message}`, "stderr");
    } catch {
      // Nothing else to tell it to.
    }
  }

  /** post_deployment() */
  async post(): Promise<void> {
    // Mark deployment as complete FIRST, before any other operations.
    await this.transitionToStatus("finished");
    // Then handle side effects - these should not fail the deployment
    try {
      await this.deps.effect({ type: "job", job: "GetContainersStatus", serverId: this.app.server_id });
    } catch {
      // The status check is asked for again by the next deployment.
    }
    try {
      await this.runPostDeploymentCommand();
    } catch {
      // A post-deployment command never fails the deployment.
    }
    this.state.next = "finish";
  }

  /** failed(): what Laravel calls with the exception that failed the job. */
  async failed(): Promise<void> {
    const failure = this.state.failure!;
    const s = this.state;
    s.next = s.cleanupAfterFailure ? "finish" : "done";
    await this.transitionToStatus("failed");
    try {
      await this.deps.effect({ type: "job", job: "CleanupHelperContainersJob", serverId: this.ctx.deployment.server_id, delayMinutes: 10 });
    } catch (e) {
      await this.logSideEffectFailure("Queueing the helper container cleanup failed", e);
    }
    await this.log("========================================", "stderr");
    if (failure.phpClass === DEPLOYMENT_EXCEPTION && failure.alreadyLogged) await this.log("Deployment failed.", "stderr");
    else await this.log(`Deployment failed: ${failure.message !== "" && failure.message !== "0" ? failure.message : "Unknown error occurred"}`, "stderr");
    await this.log(`Error type: ${failure.phpClass}`, "stderr", true);
    await this.log(`Error code: ${failure.code}`, "stderr", true);
    // Coolify's "Location: <file>:<line>" and "  at <file>:<line>" name its PHP sources: there is none to name here.
    if (failure.previous) {
      await this.log("Caused by:", "stderr", true);
      await this.log(`  ${failure.previous.phpClass}: ${failure.previous.message !== "" && failure.previous.message !== "0" ? failure.previous.message : "No message"}`, "stderr", true);
    }
    await this.log("========================================", "stderr");
    // 69420: the new version is not removed, as it is the one that runs.
    if (failure.code !== CANCELLED) {
      if (this.consistentName) {
        // do not remove the already running container
      } else if (s.newVersionHealthy) {
        // The new container passed its health check, so the old container may already be removed.
        await this.log("Deployment failed after the new version became healthy. Keeping the new version of your application running.", "stderr");
      } else {
        await this.log("Deployment failed. Removing the new version of your application.", "stderr");
        await this.removeContainerWithTimeout(s.containerName);
      }
    }
  }

  /** handle()'s finally: each part in a try of its own, so cleanup never hides the status. */
  async finish(): Promise<void> {
    this.state.next = "done";
    try {
      await this.deps.store.setFinishedAt(this.id);
    } catch {
      // finished_at is not critical
    }
    try {
      await this.writeDeploymentConfigurations();
    } catch (e) {
      await this.log(`Warning: Failed to write deployment configurations: ${failureOf(e).message}`, "stderr");
    }
    try {
      await this.log(`Gracefully shutting down build container: ${this.uuid}`);
      await this.gracefulShutdownContainer(this.uuid, true);
    } catch {
      // container cleanup errors are expected when the container is already gone
    }
    try {
      await this.deps.effect({ type: "event", event: "ServiceStatusChanged" });
    } catch {
      // event dispatch errors shouldn't prevent status updates
    }
  }

  /** write_deployment_configurations(): the compose file and a README in the application's folder on the server. */
  private async writeDeploymentConfigurations(): Promise<void> {
    if (!this.state.composeGenerated) return;
    const dir = this.configurationDir;
    const composeFile = `${dir}/docker-compose.yaml`;
    // The deployment's updated_at: finished_at was written to it just before.
    const readme = generateReadmeFile(this.app.name, dateTimeString(this.deps.now()));
    await this.exec(
      { command: `mkdir -p ${dir}` },
      // Remove what could be symlinks first, so that regular files are written.
      { command: `rm -f ${composeFile} ${dir}/README.md`, hidden: true },
      { command: `tee ${composeFile} > /dev/null`, input: this.compose().yaml },
      { command: `echo '${readme}' | tee ${dir}/README.md > /dev/null` },
    );
  }
}

const UNFINISHED_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----(?![\s\S]*-----END [A-Z ]*PRIVATE KEY-----)[\s\S]*/;

/** RunRemoteProcess::takeCompleteOutput(): the complete lines, without the start of an unfinished private key. */
function takeLines(waiting: string, end: number): { taken: string; rest: string } {
  if (end < 0) return { taken: "", rest: waiting };
  let taken = waiting.slice(0, end + 1);
  const key = UNFINISHED_PRIVATE_KEY.exec(taken);
  if (key) taken = taken.slice(0, key.index);
  return { taken, rest: waiting.slice(taken.length) };
}

/** The last entry of `docker inspect`'s .State.Health.Log: its output and exit code, or what stands for none. */
function lastHealthLog(saved: string | undefined): { output: string; code: string } {
  let last: unknown = null;
  try {
    const decoded: unknown = saved === undefined ? null : JSON.parse(saved);
    const list = Array.isArray(decoded) ? decoded : decoded !== null && typeof decoded === "object" ? Object.values(decoded) : [];
    last = list.length > 0 ? list[list.length - 1] : null;
  } catch {
    last = null;
  }
  const entry = last !== null && typeof last === "object" ? (last as Record<string, unknown>) : {};
  const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : value === true ? "1" : "");
  let output = entry.Output === undefined || entry.Output === null ? "(no logs)" : text(entry.Output);
  // empty(): "" and "0".
  if (output === "" || output === "0") output = "(no logs)";
  const code = entry.ExitCode === undefined || entry.ExitCode === null ? "(no return code)" : text(entry.ExitCode);
  return { output, code };
}

// ── Running it ──────────────────────────────────────────────────────────────────────────────────────────

/** The steps inside handle()'s try: a failure there runs failed(), then the cleanup. */
const TRY_STEPS: readonly DeploymentStep[] = ["detect", "prepare", "configure", "deploy", "health", "drain", "remove_old", "post"];
const FOLLOWING: Readonly<Partial<Record<DeploymentStep, DeploymentStep>>> = { detect: "prepare", prepare: "configure", configure: "deploy" };

/**
 * One step of the deployment: the state after it. Nothing is thrown for a failed deployment — the state says
 * what to run next (failed(), then the cleanup) and, in the end, what Coolify's job would have thrown.
 */
export async function runStep(deps: EngineDeps, ctx: DeploymentContext, state: EngineState): Promise<EngineState> {
  const next: EngineState = { ...state, saved: { ...state.saved }, health: { ...state.health }, wait: null };
  const step = next.next;
  if (step === "done") return next;
  const job = new Job(deps, ctx, next);
  if (step === "start") {
    await job.start();
    return next;
  }
  if (step === "failed") {
    try {
      await job.failed();
    } catch (e) {
      // failed() stops at a cancelled deployment: that exception is the one handle() ends with.
      next.thrown = failureOf(e);
    }
    return next;
  }
  if (step === "finish") {
    await job.finish();
    return next;
  }
  try {
    if (step === "detect") await job.detect();
    else if (step === "prepare") await job.prepare();
    else if (step === "configure") await job.configure();
    else if (step === "deploy") await job.deploy();
    else if (step === "health") await job.health();
    else if (step === "drain") await job.drain();
    else if (step === "remove_old") await job.removeOld();
    else await job.post();
    if (next.next === step && FOLLOWING[step]) next.next = FOLLOWING[step];
  } catch (e) {
    if (!TRY_STEPS.includes(step)) throw e;
    // "catch (Exception $e) { $this->fail($e); throw $e; } finally { … }"
    next.failure = failureOf(e);
    next.thrown = next.failure;
    next.cleanupAfterFailure = true;
    next.wait = null;
    next.next = "failed";
  }
  return next;
}

/** The whole deployment, from a fresh state or one that was kept: every step, with the waits between them. */
export async function runDeployment(deps: EngineDeps, ctx: DeploymentContext, state: EngineState = initialState(ctx, deps.now())): Promise<EngineState> {
  let current = state;
  while (current.next !== "done") {
    current = await runStep(deps, ctx, current);
    if (current.wait) {
      // Coolify's loops sleep one second at a time; the drain wait is one sleep.
      if (current.wait.ticks) for (let i = 0; i < current.wait.seconds; i++) await deps.sleep(1);
      else await deps.sleep(current.wait.seconds);
    }
  }
  return current;
}

/** The "Class: message" Coolify's job ends with, or null when it returns. */
export const thrownText = (state: EngineState): string | null => (state.thrown ? `${state.thrown.phpClass}: ${state.thrown.message}` : null);
