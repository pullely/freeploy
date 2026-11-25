// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/applications.php (queue_application_deployment,
// force_start_deployment, fail_undispatchable_deployment, fail_unattended_deployment, next_after_cancel),
// app/Livewire/Project/Application/{Heading,DeploymentNavbar}.php (deploy, restart, cancel, force_start),
// app/Livewire/Project/Application/Deployment/{Index,Show}.php (mount, render, toggleDebug, exportLogs,
// downloadAllLogs), app/Actions/Application/CleanupCancelledDeployment.php,
// app/Jobs/ApplicationDeploymentJob.php (__construct: what makes a job impossible to create) and
// resources/views/livewire/project/application/deployment/{index,show}.blade.php (the labels) (Apache-2.0),
// modified.
//
// The deployment queue as plain operations on one org's deployments: queue a deployment (Deploy, Restart),
// list them (the history with its search and filters), show one with its log lines, cancel it, start it
// whatever the limits say. Nothing here runs a deployment: the handler hands a started one to its Workflow.
import type {
  DeployDeploymentApplicationRow,
  DeployDeploymentBuildRow,
  DeployDeploymentListRow,
  DeployDeploymentRow,
  DeployDeploymentWithLogsRow,
  DeploymentFilterOptions,
  DeploymentListOptions,
  EnqueueResult,
  NewDeployment,
  NewDeploymentLogEntry,
} from "@saas/db/deploy";
import { decodeDeploymentLogs, DEPLOYMENT_STATUS } from "@saas/db/deploy";
import { utcIso } from "../cloud-tokens/service.js";
import { newPublicId } from "../helpers/names.js";
import { buildUnavailableReason, validateGitRef, type DeploymentExecutor } from "./engine.js";
import { buildLogEntry, decodeDeploymentLogLines, exportAllDeploymentLogs, exportDeploymentLogs, type DeploymentLogLine } from "./logs.js";
import { phpTrim } from "./php.js";
import { logRedactionSecretsFor, type LogRedactionSecrets, type RuntimeVariable } from "./runtime-env.js";

type Id = string | number;
type Application = DeployDeploymentApplicationRow;

export interface DeploymentServiceStore {
  findApplication(uuid: string): Promise<Application | null>;
  /** Application::find($deployment->application_id) */
  findApplicationById(id: Id): Promise<Application | null>;
  /** The Git and build columns of an application, which only a build reads. */
  findBuild(applicationId: Id): Promise<DeployDeploymentBuildRow | null>;
  enqueue(input: Omit<NewDeployment, "orgId">): Promise<EnqueueResult>;
  list(applicationId: Id, options: DeploymentListOptions): Promise<{ count: number; deployments: DeployDeploymentListRow[] }>;
  filterOptions(applicationId: Id): Promise<DeploymentFilterOptions>;
  find(applicationId: Id, deploymentUuid: string): Promise<DeployDeploymentWithLogsRow | null>;
  /** $deployment->update(['status' => 'cancelled-by-user']) */
  cancel(id: Id): Promise<void>;
  appendLog(id: Id, entry: NewDeploymentLogEntry, hint: NewDeploymentLogEntry | null): Promise<void>;
  startQueued(id: Id, force: boolean): Promise<boolean>;
  startNextQueued(applicationId: Id, serverId: Id | null): Promise<DeployDeploymentRow[]>;
  failUnattended(id: Id): Promise<boolean>;
  /** The application's variables, decrypted: what the log must hide. */
  variables(application: Application): Promise<RuntimeVariable[]>;
  setDebug(applicationId: Id, enabled: boolean): Promise<void>;
  runningDeploymentUrl(applicationId: Id): Promise<string | null>;
}

export interface DeploymentServiceContext {
  store: DeploymentServiceStore;
  /** The SSH executor of the application's server; null when it cannot be reached (no key, no server). */
  executor(application: Application): Promise<DeploymentExecutor | null>;
  now(): Date;
  /** new_public_id() */
  newUuid?: () => string;
}

export const DEPLOYMENT_MESSAGES = {
  /** queue_application_deployment() */
  queued: "Deployment queued.",
  queueFull: "Deployment queue is full. Please wait for existing deployments to complete.",
  skipped: "Deployment already queued for this commit.",
  /** Heading::deploy(): the toast titles. */
  queueFullTitle: "Deployment queue full",
  skippedTitle: "Deployment skipped",
  swarmImage: "To deploy to a Swarm cluster you must set a Docker image name first.",
  /** DeploymentNavbar */
  notQueued: "This deployment is no longer queued, so it was not started again.",
  cancelled: "Deployment cancelled by user.",
  containerStopped: "Deployment container stopped.",
  containerNotStarted: "Deployment container not yet started. Will be cancelled when job checks status.",
  /** ApplicationDeploymentJob::validateDockerRegistryImageConfiguration() */
  imageName: "Docker registry image name contains invalid characters.",
  imageTag: "Docker registry image tag contains invalid characters.",
  noServer: "The application's server no longer exists.",
} as const;

/** A failure Coolify reports with an error toast. */
export class DeploymentError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    readonly title: string | null = null,
  ) {
    super(message);
  }
}

/** ValidationPatterns::DOCKER_IMAGE_NAME_PATTERN and DOCKER_IMAGE_TAG_PATTERN */
const DOCKER_IMAGE_NAME = /^(?=.{1,255}$)(?:(?:(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])(?::[0-9]+)?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*)(?:@sha256)?$/;
const TAG_VARIABLE = String.raw`\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*(?::?-[A-Za-z0-9_.-]*)?\})`;
const DOCKER_IMAGE_TAG = new RegExp(`^(?=.{1,128}$)(?:[A-Za-z0-9_]|${TAG_VARIABLE})(?:[A-Za-z0-9_.-]|${TAG_VARIABLE})*$`);
const blank = (value: string | null): boolean => value === null || phpTrim(value) === "";

/**
 * What ApplicationDeploymentJob's constructor refuses: a deployment whose job cannot be created fails as
 * "Deployment could not be started: …" (fail_undispatchable_deployment). Null when the job can be created.
 */
export function undispatchableReason(application: Pick<Application, "docker_registry_image_name" | "docker_registry_image_tag">, deployment: Pick<DeployDeploymentRow, "commit">): string | null {
  try {
    validateGitRef(deployment.commit, "deployment commit");
  } catch (e) {
    return (e as Error).message;
  }
  if (!blank(application.docker_registry_image_name) && (/\n/.test(application.docker_registry_image_name!) || !DOCKER_IMAGE_NAME.test(application.docker_registry_image_name!))) return DEPLOYMENT_MESSAGES.imageName;
  if (!blank(application.docker_registry_image_tag) && (/\n/.test(application.docker_registry_image_tag!) || !DOCKER_IMAGE_TAG.test(application.docker_registry_image_tag!))) return DEPLOYMENT_MESSAGES.imageTag;
  return null;
}

export const deploymentPath = (application: Pick<Application, "project_uuid" | "environment_uuid" | "uuid">, deploymentUuid: string): string =>
  `/project/${application.project_uuid}/environment/${application.environment_uuid}/application/${application.uuid}/deployment/${deploymentUuid}`;

export type QueueOutcome =
  | { status: "queued"; message: string; deploymentUuid: string; redirect: string; /** The deployment to hand to its job, when it was started. */ dispatch: DeployDeploymentRow | null }
  | { status: "skipped"; title: string; message: string; deploymentUuid: string };

/**
 * Heading::deploy() and restart(), with queue_application_deployment(): the checks, a new uuid, the admission.
 * A full queue is an error; an already queued commit is "skipped". Null when the application is not the org's.
 */
export async function queueDeployment(ctx: DeploymentServiceContext, applicationUuid: string, options: { forceRebuild?: boolean; restartOnly?: boolean }): Promise<QueueOutcome | null> {
  const application = await ctx.store.findApplication(applicationUuid);
  if (!application) return null;
  // Freeploy's: what the engine cannot deploy yet (engine.ts says what) is refused before anything is queued.
  const build = await ctx.store.findBuild(application.id);
  if (!build) return null;
  const unavailable = buildUnavailableReason(application, build, options.restartOnly ?? false);
  if (unavailable !== null) throw new DeploymentError(unavailable, 501);
  if (application.server_id === null || application.destination_id === null) throw new DeploymentError(DEPLOYMENT_MESSAGES.noServer, 422);
  if (!options.restartOnly && (application.server_is_swarm_manager || application.server_is_swarm_worker) && (application.docker_registry_image_name ?? "") === "") {
    throw new DeploymentError(DEPLOYMENT_MESSAGES.swarmImage, 422, "Failed to deploy.");
  }
  const deploymentUuid = (ctx.newUuid ?? newPublicId)();
  const redirect = deploymentPath(application, deploymentUuid);
  const result = await ctx.store.enqueue({
    applicationId: application.id,
    applicationName: application.name,
    serverId: application.server_id,
    serverName: application.server_name ?? "",
    destinationId: application.destination_id,
    deploymentUuid,
    deploymentUrl: redirect,
    // $commit ?: ($application->git_commit_sha ?: 'HEAD'): a Docker image application has no commit of its own.
    commit: application.build_pack === "dockerimage" || build.git_commit_sha === "" || build.git_commit_sha === "0" ? "HEAD" : build.git_commit_sha,
    forceRebuild: options.forceRebuild ?? false,
    restartOnly: options.restartOnly ?? false,
  });
  if (result.status === "queue_full") throw new DeploymentError(DEPLOYMENT_MESSAGES.queueFull, 409, DEPLOYMENT_MESSAGES.queueFullTitle);
  if (result.status === "skipped") return { status: "skipped", title: DEPLOYMENT_MESSAGES.skippedTitle, message: DEPLOYMENT_MESSAGES.skipped, deploymentUuid: result.deploymentUuid };
  return { status: "queued", message: DEPLOYMENT_MESSAGES.queued, deploymentUuid, redirect, dispatch: result.started ? result.deployment : null };
}

async function secretsOf(ctx: DeploymentServiceContext, application: Application): Promise<LogRedactionSecrets> {
  return logRedactionSecretsFor(await ctx.store.variables(application), application.redact_all_env_values_in_logs !== false);
}

async function addLog(ctx: DeploymentServiceContext, secrets: LogRedactionSecrets, id: Id, message: string, type = "stdout"): Promise<void> {
  const built = buildLogEntry({ message, type }, secrets, ctx.now(), false);
  await ctx.store.appendLog(id, built.entry, built.hint);
}

/**
 * fail_undispatchable_deployment(): a deployment whose job could not be created or queued fails — left in
 * progress it would block every later deployment of the application — and what it blocked starts. Answers
 * the deployments that started: their jobs must be dispatched.
 */
export async function failUndispatchableDeployment(ctx: DeploymentServiceContext, deployment: Pick<DeployDeploymentRow, "id" | "server_id" | "application_id">, reason: string): Promise<DeployDeploymentRow[]> {
  if (!(await ctx.store.failUnattended(deployment.id))) return [];
  const application = await ctx.store.findApplicationById(deployment.application_id);
  if (!application) return [];
  const secrets = await secretsOf(ctx, application);
  await addLog(ctx, secrets, deployment.id, "========================================", "stderr");
  await addLog(ctx, secrets, deployment.id, `Deployment could not be started: ${reason}`, "stderr");
  await addLog(ctx, secrets, deployment.id, "========================================", "stderr");
  // The failed deployment no longer holds its build slot, so the deployments it blocked can start.
  return ctx.store.startNextQueued(application.id, deployment.server_id);
}

// ── The history ─────────────────────────────────────────────────────────────────────────────────────────

/** Str::headline() of a status. */
const headline = (value: string): string =>
  value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

const STATUS_LABELS: Readonly<Record<string, string>> = { finished: "Success", failed: "Failed", in_progress: "In progress", queued: "Queued", "cancelled-by-user": "Cancelled", skipped: "Skipped" };
const SOURCE_LABELS: Readonly<Record<string, string>> = { manual: "Manual", "pull-request": "Pull requests", webhook: "Webhooks", api: "API", mcp: "MCP", rollback: "Rollbacks" };

export interface DeploymentListItem {
  uuid: string;
  status: string;
  /** index.blade.php: 'Success', 'In progress', 'Cancelled', 'Queued', or the status as a headline. */
  statusLabel: string;
  statusType: "success" | "warning" | "error" | "neutral";
  sourceLabel: string;
  sourceKey: string;
  pullRequestId: number;
  commit: string | null;
  /** The first line of the commit message. */
  commitMessage: string | null;
  serverId: number | null;
  serverName: string;
  createdAt: string | null;
  finishedAt: string | null;
}

export function deploymentListItem(row: DeployDeploymentListRow, application: Pick<Application, "server_name">): DeploymentListItem {
  const pr = Number(row.pull_request_id ?? 0);
  const statusLabel = { finished: "Success", in_progress: "In progress", "cancelled-by-user": "Cancelled", queued: "Queued" }[row.status] ?? headline(row.status);
  const statusType = row.status === "finished" ? "success" : row.status === "in_progress" || row.status === "queued" ? "warning" : row.status === "failed" ? "error" : "neutral";
  const sourceLabel = row.is_webhook && pr > 0 ? `Webhook · PR #${pr}` : row.is_webhook ? "Webhook" : pr > 0 ? `Pull request #${pr}` : row.rollback ? "Rollback" : row.is_mcp ? "MCP" : row.is_api ? "API" : "Manual";
  const sourceKey = pr > 0 ? "pull-request" : row.is_webhook ? "webhook" : row.rollback ? "rollback" : row.is_mcp ? "mcp" : row.is_api ? "api" : "manual";
  const message = row.commit_message === null || row.commit_message === "" ? null : row.commit_message.split("\n")[0]!;
  return {
    uuid: row.deployment_uuid,
    status: row.status,
    statusLabel,
    statusType,
    sourceLabel,
    sourceKey,
    pullRequestId: pr,
    commit: row.commit === "" ? null : row.commit,
    commitMessage: message,
    serverId: row.server_id === null ? null : Number(row.server_id),
    serverName: row.server_name || application.server_name || "-",
    createdAt: utcIso(row.created_at),
    finishedAt: utcIso(row.finished_at),
  };
}

export interface FilterOption {
  value: string;
  label: string;
}

export interface DeploymentsIndex {
  deployments: DeploymentListItem[];
  count: number;
  skip: number;
  take: number;
  currentPage: number;
  lastPage: number;
  /** The pull request filter in force, or null; `invalidPullRequestId` when the query's was not a positive integer. */
  pullRequestId: string | null;
  invalidPullRequestId: boolean;
  search: string;
  filters: string[];
  sort: "newest" | "oldest";
  statusFilterOptions: FilterOption[];
  sourceFilterOptions: FilterOption[];
  serverFilterOptions: FilterOption[];
  pullRequestOptions: FilterOption[];
  /** The page of the deployment that runs or waits, for the heading's "Deploying…" link. */
  runningDeploymentUrl: string | null;
  /** The server's timezone, for the times' titles. */
  serverTimezone: string;
}

export interface DeploymentsQuery {
  skip?: number;
  take?: number;
  pullRequestId?: string | null;
  search?: string;
  filters?: string[];
  sort?: string;
}

/** Deployment\Index: mount() and render(). Null when the application is not the org's. */
export async function deploymentsIndex(ctx: DeploymentServiceContext, applicationUuid: string, query: DeploymentsQuery): Promise<DeploymentsIndex | null> {
  const application = await ctx.store.findApplication(applicationUuid);
  if (!application) return null;
  // mount(): a pull request id that is no positive integer clears the filter, with an error toast.
  let pullRequestId: string | null = query.pullRequestId ?? null;
  let invalid = false;
  if (pullRequestId !== null && pullRequestId !== "") {
    const n = Number(pullRequestId);
    if (!/^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\v\f]*$/.test(pullRequestId) || n <= 0 || n !== Math.trunc(n)) {
      pullRequestId = null;
      invalid = true;
    } else pullRequestId = String(Math.trunc(n));
  } else pullRequestId = null;

  const options = await ctx.store.filterOptions(application.id);
  const statusFilterOptions = Object.entries(STATUS_LABELS).filter(([status]) => options.statuses.includes(status)).map(([status, label]) => ({ value: `status:${status}`, label }));
  const sourceFilterOptions = Object.entries(SOURCE_LABELS).filter(([source]) => options.sources.includes(source)).map(([source, label]) => ({ value: `source:${source}`, label }));
  const serverFilterOptions = options.servers.map((server) => ({ value: `server:${server.id}`, label: server.name || `Server #${server.id}` }));
  const pullRequests = options.pullRequestIds.map(String);
  if (pullRequestId && !pullRequests.includes(pullRequestId)) pullRequests.unshift(pullRequestId);
  const pullRequestOptions = [{ value: "", label: "All deployments" }, ...pullRequests.map((id) => ({ value: id, label: `Pull request #${id}` }))];

  // toggleDeploymentFilter(): only the filters that are offered.
  const valid = [...statusFilterOptions, ...sourceFilterOptions, ...serverFilterOptions].map((o) => o.value);
  const filters = (query.filters ?? []).filter((f, i, all) => valid.includes(f) && all.indexOf(f) === i);
  const take = Math.max(1, Math.min(100, Math.trunc(query.take ?? 10) || 10));
  const skip = Math.max(0, Math.trunc(query.skip ?? 0) || 0);
  const sort = query.sort === "oldest" ? "oldest" : "newest";
  const search = query.search ?? "";
  const page = await ctx.store.list(application.id, { skip, take, pullRequestId, search, filters, sort });
  return {
    deployments: page.deployments.map((row) => deploymentListItem(row, application)),
    count: page.count,
    skip,
    take,
    currentPage: Math.trunc(skip / take) + 1,
    lastPage: Math.max(1, Math.ceil(page.count / take)),
    pullRequestId,
    invalidPullRequestId: invalid,
    search,
    filters,
    sort,
    statusFilterOptions,
    sourceFilterOptions,
    serverFilterOptions,
    pullRequestOptions,
    runningDeploymentUrl: await ctx.store.runningDeploymentUrl(application.id),
    serverTimezone: application.server_timezone || "UTC",
  };
}

// ── One deployment ──────────────────────────────────────────────────────────────────────────────────────

export interface DeploymentShow {
  deployment: {
    uuid: string;
    status: string;
    /** show.blade.php: 'In progress', or the status as a headline. */
    statusLabel: string;
    statusType: "success" | "warning" | "error" | "neutral";
    commit: string | null;
    createdAt: string | null;
    finishedAt: string | null;
  };
  /** decode_remote_command_output(): the debug lines only for who may update, with debug logs on. */
  lines: DeploymentLogLine[];
  /** Show::$is_debug_enabled: false for who may not update the application. */
  isDebugEnabled: boolean;
  /** isKeepAliveOn(): the page polls until the deployment is finished, failed or skipped. */
  isKeepAliveOn: boolean;
}

const KEEP_ALIVE_OFF: readonly string[] = [DEPLOYMENT_STATUS.finished, DEPLOYMENT_STATUS.failed, DEPLOYMENT_STATUS.skipped];

async function load(ctx: DeploymentServiceContext, applicationUuid: string, deploymentUuid: string): Promise<{ application: Application; deployment: DeployDeploymentWithLogsRow } | null> {
  const application = await ctx.store.findApplication(applicationUuid);
  if (!application) return null;
  const deployment = await ctx.store.find(application.id, deploymentUuid);
  return deployment ? { application, deployment } : null;
}

/** Deployment\Show: mount() and getLogLinesProperty(). Null when the deployment is not one of the application's. */
export async function deploymentShow(ctx: DeploymentServiceContext, applicationUuid: string, deploymentUuid: string, canUpdate: boolean): Promise<DeploymentShow | null> {
  const found = await load(ctx, applicationUuid, deploymentUuid);
  if (!found) return null;
  const { application, deployment } = found;
  // Debug logs can hold secrets, so only users who can change the application see them.
  const isDebugEnabled = canUpdate && application.is_debug_enabled === true;
  const status = deployment.status;
  return {
    deployment: {
      uuid: deployment.deployment_uuid,
      status,
      statusLabel: status === "in_progress" ? "In progress" : headline(status),
      statusType: status === "finished" ? "success" : status === "failed" ? "error" : status === "queued" || status === "in_progress" ? "warning" : "neutral",
      commit: deployment.commit === "" ? null : deployment.commit,
      createdAt: utcIso(deployment.created_at),
      finishedAt: utcIso(deployment.finished_at),
    },
    lines: decodeDeploymentLogLines(decodeDeploymentLogs(deployment.logs), { includeHidden: isDebugEnabled, timezone: application.server_timezone }),
    isDebugEnabled,
    isKeepAliveOn: !KEEP_ALIVE_OFF.includes(status),
  };
}

/**
 * Show::exportLogs() — the displayed lines that match the search — or, with `all`, downloadAllLogs(): every
 * line, the debug lines marked. Secrets are hidden again with the application's values of now.
 */
export async function deploymentLogsText(ctx: DeploymentServiceContext, applicationUuid: string, deploymentUuid: string, options: { all: boolean; canUpdate: boolean; withTimestamps?: boolean; search?: string }): Promise<string | null> {
  const found = await load(ctx, applicationUuid, deploymentUuid);
  if (!found) return null;
  const { application, deployment } = found;
  const secrets = await secretsOf(ctx, application);
  const logs = decodeDeploymentLogs(deployment.logs);
  if (options.all) return exportAllDeploymentLogs(decodeDeploymentLogLines(logs, { includeHidden: true, timezone: application.server_timezone }), secrets);
  const lines = decodeDeploymentLogLines(logs, { includeHidden: options.canUpdate && application.is_debug_enabled === true, timezone: application.server_timezone });
  return exportDeploymentLogs(lines, secrets, { ...(options.withTimestamps === undefined ? {} : { withTimestamps: options.withTimestamps }), ...(options.search === undefined ? {} : { search: options.search }) });
}

/** Show::toggleDebug(): the application's "Debug logs" switch. Answers the new value; null for another org's application. */
export async function toggleDebug(ctx: DeploymentServiceContext, applicationUuid: string): Promise<{ isDebugEnabled: boolean } | null> {
  const application = await ctx.store.findApplication(applicationUuid);
  if (!application) return null;
  const enabled = application.is_debug_enabled !== true;
  await ctx.store.setDebug(application.id, enabled);
  return { isDebugEnabled: enabled };
}

/** The remote side of instant_remote_process(): the trimmed output, or an error with what the server said. */
async function instant(executor: DeploymentExecutor, command: string): Promise<string> {
  const result = await executor.run({ script: command });
  if (result.exitCode !== 0) throw new Error(phpTrim(result.stderr) || `SSH command failed with exit code: ${result.exitCode}`);
  return phpTrim(result.stdout);
}

export interface CancelOutcome {
  /** The deployments that started because this one ended: their jobs must be dispatched. */
  dispatch: DeployDeploymentRow[];
  /** What the cleanup on the server failed with (the deployment is cancelled all the same). */
  error: string | null;
}

/**
 * DeploymentNavbar::cancel(): the status first, so the job stops at its next check; then the helper container
 * is removed on the server (CleanupCancelledDeployment); and whatever happens, what waited starts
 * (next_after_cancel).
 */
export async function cancelDeployment(ctx: DeploymentServiceContext, applicationUuid: string, deploymentUuid: string): Promise<CancelOutcome | null> {
  const found = await load(ctx, applicationUuid, deploymentUuid);
  if (!found) return null;
  const { application, deployment } = found;
  // First, mark the deployment as cancelled to prevent further processing
  await ctx.store.cancel(deployment.id);
  let error: string | null = null;
  try {
    const secrets = await secretsOf(ctx, application);
    await addLog(ctx, secrets, deployment.id, DEPLOYMENT_MESSAGES.cancelled, "stderr");
    const executor = await ctx.executor(application);
    if (!executor) throw new Error(DEPLOYMENT_MESSAGES.noServer);
    const exists = await instant(executor, `docker ps -a --filter name=${deployment.deployment_uuid} --format '{{.Names}}'`);
    if (exists !== "") {
      await instant(executor, `docker rm -f ${deployment.deployment_uuid}`);
      await addLog(ctx, secrets, deployment.id, DEPLOYMENT_MESSAGES.containerStopped);
    } else {
      await addLog(ctx, secrets, deployment.id, DEPLOYMENT_MESSAGES.containerNotStarted);
    }
  } catch (e) {
    // Still marked as cancelled even if cleanup fails
    error = e instanceof Error ? e.message : String(e);
  }
  return { dispatch: await ctx.store.startNextQueued(application.id, deployment.server_id ?? application.server_id), error };
}

/**
 * DeploymentNavbar::force_start(): start a queued deployment whatever the limits say. `started` is false
 * when it is no longer queued, so a repeated force start never runs the same deployment twice.
 */
export async function forceStartDeployment(ctx: DeploymentServiceContext, applicationUuid: string, deploymentUuid: string): Promise<{ started: boolean; message: string | null; dispatch: DeployDeploymentRow | null } | null> {
  const found = await load(ctx, applicationUuid, deploymentUuid);
  if (!found) return null;
  const started = await ctx.store.startQueued(found.deployment.id, true);
  return { started, message: started ? null : DEPLOYMENT_MESSAGES.notQueued, dispatch: started ? { ...found.deployment, status: DEPLOYMENT_STATUS.inProgress } : null };
}
