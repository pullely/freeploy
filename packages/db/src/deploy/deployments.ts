// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/applications.php (queue_application_deployment,
// next_queuable, active_builds_on_server, start_queued_deployment, start_next_queued_deployments,
// fail_unattended_deployment), app/Models/ApplicationDeploymentQueue.php (the columns, addLogEntry, the saving
// hook), app/Models/Application.php (deployments, get_last_successful_deployment, the status mutator's column),
// app/Livewire/Project/Application/Deployment/Index.php (HISTORY_COLUMNS, the filter options),
// app/Livewire/Project/Application/Heading.php (getRunningDeploymentUrlProperty) and
// app/Jobs/ApplicationDeploymentJob.php (what it reads of an application, and the status updates it makes)
// (Apache-2.0), modified.
//
// deploy.application_deployment_queues: the deployment queue and its log. Every function takes the transaction
// of withOrg(), so row-level security confines it to that org. Coolify's "team" is the org.
//
// The admission rules are Coolify's: a server's queue has a limit (server_settings.deployment_queue_limit), the
// same commit of an application is queued once unless it is forced, one deployment of an application runs at a
// time, and a server runs as many at once as its "Concurrent builds" setting. Not here: build servers (a
// Docker image application builds nothing, so it never uses one) and the cancelling of the deployments a newer
// webhook or API deployment replaces (cancel_superseded_deployments): nothing queues those yet.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { DESTINATION_MORPH_CLASS } from "./destinations.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

const STANDALONE = DESTINATION_MORPH_CLASS.standalone.replace(/\\/g, "\\\\");
const SWARM = DESTINATION_MORPH_CLASS.swarm.replace(/\\/g, "\\\\");

/** App\Enums\ApplicationDeploymentStatus */
export const DEPLOYMENT_STATUS = {
  queued: "queued",
  inProgress: "in_progress",
  finished: "finished",
  failed: "failed",
  cancelledByUser: "cancelled-by-user",
  skipped: "skipped",
} as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUS)[keyof typeof DEPLOYMENT_STATUS];

/** ApplicationDeploymentStatus::isFinal(): a deployment in a final status does not run anymore, so it has an end time. */
export const FINAL_DEPLOYMENT_STATUSES: readonly string[] = [DEPLOYMENT_STATUS.finished, DEPLOYMENT_STATUS.failed, DEPLOYMENT_STATUS.cancelledByUser, DEPLOYMENT_STATUS.skipped];

/** A deployment without its log and its configuration payloads. */
export interface DeployDeploymentRow extends SqlRow {
  id: string | number;
  /** A varchar column in Coolify's schema: the application's id as text. */
  application_id: string;
  deployment_uuid: string;
  pull_request_id: number;
  force_rebuild: boolean;
  commit: string;
  status: string;
  is_webhook: boolean;
  is_api: boolean;
  is_mcp: boolean;
  restart_only: boolean;
  rollback: boolean;
  only_this_server: boolean;
  git_type: string | null;
  server_id: number | null;
  build_server_id: number | null;
  application_name: string | null;
  server_name: string | null;
  deployment_url: string | null;
  destination_id: string | null;
  commit_message: string | null;
  docker_registry_image_tag: string | null;
  parent_deployment_uuid: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
  finished_at: string | Date | null;
  deploy_started_at: string | Date | null;
}

/** … with its log: the stored JSON text. */
export interface DeployDeploymentWithLogsRow extends DeployDeploymentRow {
  logs: string | null;
}

const COLUMNS = [
  "id", "application_id", "deployment_uuid", "pull_request_id", "force_rebuild", "commit", "status", "is_webhook", "is_api", "is_mcp",
  "restart_only", "rollback", "only_this_server", "git_type", "server_id", "build_server_id", "application_name", "server_name",
  "deployment_url", "destination_id", "commit_message", "docker_registry_image_tag", "parent_deployment_uuid", "created_at", "updated_at",
  "finished_at", "deploy_started_at",
]
  .map((c) => `"${c}"`)
  .join(", ");

/** What queue_application_deployment() stores. */
export interface NewDeployment {
  orgId: string;
  applicationId: string | number;
  applicationName: string;
  serverId: string | number;
  serverName: string;
  destinationId: string | number;
  /** new_public_id() */
  deploymentUuid: string;
  /** The path of the deployment's page. */
  deploymentUrl: string;
  /** $commit ?: ($application->git_commit_sha ?: 'HEAD') */
  commit: string;
  pullRequestId?: number;
  forceRebuild?: boolean;
  restartOnly?: boolean;
  rollback?: boolean;
  isWebhook?: boolean;
  isApi?: boolean;
  isMcp?: boolean;
  gitType?: string | null;
  onlyThisServer?: boolean;
  dockerRegistryImageTag?: string | null;
  /** Start whatever the limits say (queue_application_deployment's $no_questions_asked). */
  noQuestionsAsked?: boolean;
}

export type EnqueueResult =
  | { status: "queue_full" }
  | { status: "skipped"; deploymentUuid: string }
  /** `started`: the deployment is in progress and its job must be dispatched; otherwise it waits in the queue. */
  | { status: "queued"; deployment: DeployDeploymentRow; started: boolean };

/** Server::query()->whereKey($id)->lockForUpdate(): the row lock that makes admission and starts one at a time on a server. */
async function lockServer(tx: SqlExecutor, serverId: string | number): Promise<boolean> {
  const r = await tx.execute<{ id: string | number }>("SELECT id FROM deploy.servers WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [serverId]);
  return r.rows.length > 0;
}

async function lockApplication(tx: SqlExecutor, applicationId: string | number): Promise<boolean> {
  const r = await tx.execute<{ id: string | number }>("SELECT id FROM deploy.applications WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [applicationId]);
  return r.rows.length > 0;
}

/**
 * active_builds_on_server(): the running deployments that build on a server — its own deployments without a
 * build server, and the deployments that it builds as a build server.
 */
export async function activeBuildsOnServer(tx: SqlExecutor, serverId: string | number): Promise<number> {
  const r = await tx.execute<{ count: number | string }>(
    `SELECT count(*) AS count FROM deploy.application_deployment_queues
      WHERE status = $1 AND (build_server_id = $2 OR (server_id = $2 AND build_server_id IS NULL))`,
    [DEPLOYMENT_STATUS.inProgress, serverId],
  );
  return Number(r.rows[0]?.count ?? 0);
}

/**
 * next_queuable(): can a queued deployment start now? Not while another deployment of the application (and
 * the same pull request) is in progress, not on a server or for an application that is gone, and not while
 * the server runs as many builds as its "Concurrent builds" setting allows. Call it while the application and
 * server rows are locked.
 */
export async function nextQueuable(tx: SqlExecutor, deployment: Pick<DeployDeploymentRow, "application_id" | "pull_request_id" | "server_id">): Promise<boolean> {
  const running = await tx.execute<{ id: string | number }>(
    "SELECT id FROM deploy.application_deployment_queues WHERE application_id = $1 AND pull_request_id = $2 AND status = $3 LIMIT 1",
    [String(deployment.application_id), deployment.pull_request_id, DEPLOYMENT_STATUS.inProgress],
  );
  if (running.rows.length > 0) return false;
  // A deleted server keeps its queued deployments; they cannot run anymore.
  if (deployment.server_id === null) return false;
  const server = await tx.execute<{ concurrent_builds: number | null }>(
    `SELECT ss.concurrent_builds FROM deploy.servers s LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [deployment.server_id],
  );
  const application = /^\d+$/.test(String(deployment.application_id))
    ? await tx.execute<{ id: string | number }>("SELECT id FROM deploy.applications WHERE id = $1 AND deleted_at IS NULL", [deployment.application_id])
    : { rows: [] };
  if (server.rows.length === 0 || application.rows.length === 0) return false;
  return (await activeBuildsOnServer(tx, deployment.server_id)) < Number(server.rows[0]!.concurrent_builds ?? 2);
}

/**
 * queue_application_deployment(), its admission transaction: under the application's and the server's row
 * locks, refuse a full queue, skip a commit that is already queued or running (unless forced, a rollback, or
 * no questions asked), store the deployment, and start it when it can run now.
 */
export async function enqueueDeployment(tx: SqlExecutor, input: NewDeployment): Promise<EnqueueResult> {
  const pullRequestId = input.pullRequestId ?? 0;
  const tag = input.dockerRegistryImageTag ?? null;
  // Lock stable rows because an empty deployment queue has no row to lock.
  await lockApplication(tx, input.applicationId);
  await lockServer(tx, input.serverId);
  const settings = await tx.execute<{ deployment_queue_limit: number | null }>("SELECT deployment_queue_limit FROM deploy.server_settings WHERE server_id = $1", [input.serverId]);
  const queueLimit = Number(settings.rows[0]?.deployment_queue_limit ?? 25);
  const queued = await tx.execute<{ count: number | string }>("SELECT count(*) AS count FROM deploy.application_deployment_queues WHERE server_id = $1 AND status = $2", [
    input.serverId,
    DEPLOYMENT_STATUS.queued,
  ]);
  if (Number(queued.rows[0]?.count ?? 0) >= queueLimit) return { status: "queue_full" };

  const existing = await tx.execute<{ deployment_uuid: string }>(
    `SELECT deployment_uuid FROM deploy.application_deployment_queues
      WHERE application_id = $1 AND "commit" = $2 AND pull_request_id = $3 AND docker_registry_image_tag IS NOT DISTINCT FROM $4 AND status IN ($5, $6)
      ORDER BY id LIMIT 1`,
    [String(input.applicationId), input.commit, pullRequestId, tag, DEPLOYMENT_STATUS.inProgress, DEPLOYMENT_STATUS.queued],
  );
  if (existing.rows[0] && !input.forceRebuild && !input.rollback && !input.noQuestionsAsked) return { status: "skipped", deploymentUuid: existing.rows[0].deployment_uuid };

  const inserted = await tx.execute<DeployDeploymentRow>(
    `INSERT INTO deploy.application_deployment_queues
       (application_id, application_name, server_id, server_name, destination_id, deployment_uuid, deployment_url, pull_request_id,
        docker_registry_image_tag, force_rebuild, is_webhook, is_api, is_mcp, restart_only, "commit", rollback, git_type, only_this_server,
        status, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, ${NOW}, ${NOW})
     RETURNING ${COLUMNS}`,
    [
      String(input.applicationId),
      input.applicationName,
      input.serverId,
      input.serverName,
      String(input.destinationId),
      input.deploymentUuid,
      input.deploymentUrl,
      pullRequestId,
      tag,
      input.forceRebuild ?? false,
      input.isWebhook ?? false,
      input.isApi ?? false,
      input.isMcp ?? false,
      input.restartOnly ?? false,
      input.commit,
      input.rollback ?? false,
      input.gitType ?? null,
      input.onlyThisServer ?? false,
      DEPLOYMENT_STATUS.queued,
      input.orgId,
    ],
  );
  let deployment = inserted.rows[0]!;
  // Decide whether to start while the application and server rows are still locked, so concurrent requests
  // cannot both see an idle queue and start two deployments.
  const started = Boolean(input.noQuestionsAsked) || (await nextQueuable(tx, deployment));
  if (started) deployment = (await setStatus(tx, deployment.id, DEPLOYMENT_STATUS.inProgress)) ?? deployment;
  return { status: "queued", deployment, started };
}

/** $deployment->update(['status' => …]) with the saving hook: a final status sets finished_at when it is not set. */
async function setStatus(tx: SqlExecutor, id: string | number, status: string): Promise<DeployDeploymentRow | null> {
  const final = FINAL_DEPLOYMENT_STATUSES.includes(status);
  const r = await tx.execute<DeployDeploymentRow>(
    `UPDATE deploy.application_deployment_queues
        SET status = $2, ${final ? `finished_at = COALESCE(finished_at, ${NOW}), ` : ""}updated_at = ${NOW}
      WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, status],
  );
  return r.rows[0] ?? null;
}

/** ApplicationDeploymentQueue::update(['status' => $status]). Null when the deployment is gone. */
export async function updateDeploymentStatus(tx: SqlExecutor, id: string | number, status: DeploymentStatus): Promise<DeployDeploymentRow | null> {
  return setStatus(tx, id, status);
}

/**
 * start_queued_deployment(), its transaction: under the same locks as admission, start a deployment that is
 * still queued and may run now (with `force`, whatever the limits say). False when it was not started.
 */
export async function startQueuedDeployment(tx: SqlExecutor, id: string | number, force = false): Promise<boolean> {
  const found = await tx.execute<Pick<DeployDeploymentRow, "id" | "application_id" | "server_id">>("SELECT id, application_id, server_id FROM deploy.application_deployment_queues WHERE id = $1", [id]);
  const row = found.rows[0];
  if (!row) return false;
  if (/^\d+$/.test(row.application_id)) await lockApplication(tx, row.application_id);
  if (row.server_id !== null) await lockServer(tx, row.server_id);
  const current = await tx.execute<DeployDeploymentRow>(`SELECT ${COLUMNS} FROM deploy.application_deployment_queues WHERE id = $1 FOR UPDATE`, [id]);
  const deployment = current.rows[0];
  if (!deployment || deployment.status !== DEPLOYMENT_STATUS.queued) return false;
  if (!force && !(await nextQueuable(tx, deployment))) return false;
  await setStatus(tx, id, DEPLOYMENT_STATUS.inProgress);
  return true;
}

/**
 * start_next_queued_deployments(): start the queued deployments that can run now on the application's own
 * server, on the server of the deployment that just ended, and on every other server with a queued
 * deployment of this application — oldest first. Answers the ones it started: their jobs must be dispatched.
 */
export async function startNextQueuedDeployments(tx: SqlExecutor, applicationId: string | number, finishedDeploymentServerId: string | number | null = null): Promise<DeployDeploymentRow[]> {
  const servers = await tx.execute<{ server_id: number | string | null }>(
    `SELECT DISTINCT server_id FROM deploy.application_deployment_queues WHERE application_id = $1 AND status = $2
      UNION
     SELECT COALESCE(sd.server_id, wd.server_id) AS server_id
       FROM deploy.applications a
       LEFT JOIN deploy.standalone_dockers sd ON sd.id = a.destination_id AND a.destination_type = E'${STANDALONE}'
       LEFT JOIN deploy.swarm_dockers wd ON wd.id = a.destination_id AND a.destination_type = E'${SWARM}'
      WHERE a.id = $3`,
    [String(applicationId), DEPLOYMENT_STATUS.queued, applicationId],
  );
  const serverIds = [...new Set([...servers.rows.map((r) => r.server_id), finishedDeploymentServerId].filter((id): id is number | string => id !== null).map(Number))];
  if (serverIds.length === 0) return [];
  const queued = await tx.execute<DeployDeploymentRow>(
    `SELECT ${COLUMNS} FROM deploy.application_deployment_queues WHERE server_id = ANY($1::int[]) AND status = $2 ORDER BY created_at, id`,
    [serverIds, DEPLOYMENT_STATUS.queued],
  );
  const started: DeployDeploymentRow[] = [];
  for (const next of queued.rows) {
    if (await startQueuedDeployment(tx, next.id)) started.push({ ...next, status: DEPLOYMENT_STATUS.inProgress });
  }
  return started;
}

/**
 * fail_unattended_deployment(), its update: an in-progress deployment that no job runs becomes failed. False
 * when it is no longer in progress.
 */
export async function failUnattendedDeployment(tx: SqlExecutor, id: string | number): Promise<boolean> {
  const r = await tx.execute<{ id: string | number }>(
    `UPDATE deploy.application_deployment_queues SET status = $2, finished_at = ${NOW}, updated_at = ${NOW} WHERE id = $1 AND status = $3 RETURNING id`,
    [id, DEPLOYMENT_STATUS.failed, DEPLOYMENT_STATUS.inProgress],
  );
  return r.rows.length > 0;
}

/**
 * The job's first step: in progress, unless the user cancelled since the deployment was queued ("a
 * conditional update, so a cancel that came after the check above is not overwritten"). Answers the status
 * the row has afterwards, or null when it is gone.
 */
export async function markDeploymentInProgress(tx: SqlExecutor, id: string | number, worker: string | null): Promise<string | null> {
  await tx.execute(
    `UPDATE deploy.application_deployment_queues SET status = $2, horizon_job_worker = $3, updated_at = ${NOW} WHERE id = $1 AND status <> $4`,
    [id, DEPLOYMENT_STATUS.inProgress, worker, DEPLOYMENT_STATUS.cancelledByUser],
  );
  return deploymentStatus(tx, id);
}

/**
 * startDeployPhase(): the deployment starts to change containers. Conditional, so it cannot race with a
 * cancel: exactly one of them wins.
 */
export async function markDeployStarted(tx: SqlExecutor, id: string | number): Promise<void> {
  await tx.execute(
    `UPDATE deploy.application_deployment_queues SET deploy_started_at = ${NOW}, updated_at = ${NOW} WHERE id = $1 AND status = $2 AND deploy_started_at IS NULL`,
    [id, DEPLOYMENT_STATUS.inProgress],
  );
}

/** The `finally` of the job: finished_at is now. */
export async function setDeploymentFinishedAt(tx: SqlExecutor, id: string | number): Promise<void> {
  await tx.execute(`UPDATE deploy.application_deployment_queues SET finished_at = ${NOW}, updated_at = ${NOW} WHERE id = $1`, [id]);
}

/** $deployment->refresh()->status: what every cancellation check reads. */
export async function deploymentStatus(tx: SqlExecutor, id: string | number): Promise<string | null> {
  const r = await tx.execute<{ status: string }>("SELECT status FROM deploy.application_deployment_queues WHERE id = $1", [id]);
  return r.rows[0]?.status ?? null;
}

/** One stored log entry (ApplicationDeploymentQueue::addLogEntry). */
export interface DeploymentLogEntry {
  command: string | null;
  output: string;
  type: string;
  /** Carbon::now('UTC') as JSON: "2026-11-20T10:11:12.000000Z". */
  timestamp: string;
  hidden: boolean;
  batch: number;
  order: number;
}

/** A log entry before it is stored: its order is its place in the stored list. */
export type NewDeploymentLogEntry = Omit<DeploymentLogEntry, "order">;

/** decodeLogs(): the stored list; [] for nothing stored; null when the stored text cannot be decoded. */
export function decodeDeploymentLogs(logs: string | null): DeploymentLogEntry[] | null {
  if (logs === null || logs.trim() === "") return [];
  try {
    const decoded: unknown = JSON.parse(logs);
    if (Array.isArray(decoded)) return decoded as DeploymentLogEntry[];
    return decoded !== null && typeof decoded === "object" ? (Object.values(decoded) as DeploymentLogEntry[]) : null;
  } catch {
    return null;
  }
}

/**
 * addLogEntry(), its transaction: the stored log is read under the row's lock, the entry gets the next order
 * and is appended, and — when given — the hint entry follows it unless the log already has one with that
 * output. A stored log that cannot be decoded is kept as it is and the entry is dropped (false).
 */
export async function appendDeploymentLog(tx: SqlExecutor, id: string | number, entry: NewDeploymentLogEntry, hint: NewDeploymentLogEntry | null = null): Promise<boolean> {
  const stored = await tx.execute<{ logs: string | null }>("SELECT logs FROM deploy.application_deployment_queues WHERE id = $1 FOR UPDATE", [id]);
  if (stored.rows.length === 0) return false;
  const logs = decodeDeploymentLogs(stored.rows[0]!.logs);
  if (logs === null) return false;
  const order = logs.length + 1;
  logs.push({ ...entry, order });
  if (hint && !logs.some((existing) => existing.output === hint.output)) logs.push({ ...hint, order: order + 1 });
  // Only the logs column: no updated_at, as Coolify's query update leaves it.
  await tx.execute("UPDATE deploy.application_deployment_queues SET logs = $2 WHERE id = $1", [id, JSON.stringify(logs)]);
  return true;
}

/** ApplicationDeploymentQueue::where('deployment_uuid', …)->where('application_id', …)->first(), with its log. */
export async function findDeploymentByUuid(tx: SqlExecutor, applicationId: string | number, deploymentUuid: string): Promise<DeployDeploymentWithLogsRow | null> {
  const r = await tx.execute<DeployDeploymentWithLogsRow>(`SELECT ${COLUMNS}, logs FROM deploy.application_deployment_queues WHERE deployment_uuid = $1 AND application_id = $2`, [
    deploymentUuid,
    String(applicationId),
  ]);
  return r.rows[0] ?? null;
}

/** The deployment a job runs, by its uuid alone (the org is the transaction's). */
export async function findDeploymentForJob(tx: SqlExecutor, deploymentUuid: string): Promise<DeployDeploymentRow | null> {
  const r = await tx.execute<DeployDeploymentRow>(`SELECT ${COLUMNS} FROM deploy.application_deployment_queues WHERE deployment_uuid = $1`, [deploymentUuid]);
  return r.rows[0] ?? null;
}

/** Heading::getRunningDeploymentUrlProperty(): the page of the newest deployment that runs or waits, or null. */
export async function findRunningDeploymentUrl(tx: SqlExecutor, applicationId: string | number): Promise<string | null> {
  const r = await tx.execute<{ deployment_url: string | null }>(
    "SELECT deployment_url FROM deploy.application_deployment_queues WHERE application_id = $1 AND status IN ($2, $3) ORDER BY id DESC LIMIT 1",
    [String(applicationId), DEPLOYMENT_STATUS.inProgress, DEPLOYMENT_STATUS.queued],
  );
  return r.rows[0]?.deployment_url ?? null;
}

/** Deployment\Index::HISTORY_COLUMNS: the history list never loads logs or configuration payloads. */
export interface DeployDeploymentListRow extends SqlRow {
  id: string | number;
  application_id: string;
  deployment_uuid: string;
  pull_request_id: number;
  status: string;
  commit: string;
  commit_message: string | null;
  is_webhook: boolean;
  is_api: boolean;
  is_mcp: boolean;
  rollback: boolean;
  server_id: number | null;
  server_name: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
  finished_at: string | Date | null;
}

const HISTORY_COLUMNS = '"id", "application_id", "deployment_uuid", "pull_request_id", "status", "commit", "commit_message", "is_webhook", "is_api", "is_mcp", "rollback", "server_id", "server_name", "created_at", "updated_at", "finished_at"';

export interface DeploymentListOptions {
  skip?: number;
  take?: number;
  /** A positive pull request id, as text; null for every deployment. */
  pullRequestId?: string | null;
  search?: string | null;
  /** "status:<status>", "source:<source>" and "server:<id>" values. */
  filters?: string[];
  sort?: "newest" | "oldest";
}

/** The `source:` filter of the history, in the view's precedence. */
const SOURCE_FILTERS: Readonly<Record<string, string>> = {
  "pull-request": "pull_request_id > 0",
  webhook: "pull_request_id <= 0 AND is_webhook = true",
  rollback: "pull_request_id <= 0 AND is_webhook = false AND rollback = true",
  api: "pull_request_id <= 0 AND is_webhook = false AND rollback = false AND is_api = true",
  mcp: "pull_request_id <= 0 AND is_webhook = false AND rollback = false AND is_mcp = true",
  manual: "pull_request_id <= 0 AND is_webhook = false AND rollback = false AND is_api = false AND is_mcp = false",
};

/** What a search word also finds, besides the text columns. */
const SEARCH_WORDS: Readonly<Record<string, string>> = {
  "pull request": "pull_request_id > 0",
  "pull requests": "pull_request_id > 0",
  pr: "pull_request_id > 0",
  webhook: "is_webhook = true",
  webhooks: "is_webhook = true",
  rollback: "rollback = true",
  rollbacks: "rollback = true",
  api: "is_api = true",
  mcp: "is_mcp = true",
  manual: "(pull_request_id <= 0 AND is_webhook = false AND rollback = false AND is_api = false AND is_mcp = false)",
};

const STATUS_ALIASES: Readonly<Record<string, string>> = { success: DEPLOYMENT_STATUS.finished, "in progress": DEPLOYMENT_STATUS.inProgress, cancelled: DEPLOYMENT_STATUS.cancelledByUser };

/** LIKE's wildcards in a search text are ordinary characters. */
const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

/**
 * Application::deployments(): one page of the application's deployments — by pull request, search text and
 * the status, source and server filters — newest (or oldest) first, and how many match in all.
 */
export async function listDeployments(tx: SqlExecutor, applicationId: string | number, options: DeploymentListOptions = {}): Promise<{ count: number; deployments: DeployDeploymentListRow[] }> {
  const params: unknown[] = [String(applicationId)];
  const p = (value: unknown): string => `$${params.push(value)}`;
  const where: string[] = ["application_id = $1"];

  // "if ($pullRequestId)": PHP's truthiness, so "0" is no filter.
  if (options.pullRequestId && options.pullRequestId !== "0") where.push(`pull_request_id = ${p(Number(options.pullRequestId))}`);

  const search = (options.search ?? "").trim();
  if (search !== "") {
    const like = p(likePattern(search));
    const lower = search.toLowerCase();
    const any = ["deployment_uuid", '"commit"', "commit_message", "server_name", "status"].map((column) => `${column} ILIKE ${like}`);
    if (STATUS_ALIASES[lower]) any.push(`status = ${p(STATUS_ALIASES[lower])}`);
    if (/^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\v\f]*$/.test(search) && Math.trunc(Number(search)) > 0) any.push(`pull_request_id = ${p(Math.trunc(Number(search)))}`);
    if (SEARCH_WORDS[lower]) any.push(SEARCH_WORDS[lower]);
    where.push(`(${any.join(" OR ")})`);
  }

  const filters = options.filters ?? [];
  const statuses = filters.filter((f) => f.startsWith("status:")).map((f) => f.slice("status:".length));
  if (statuses.length > 0) where.push(`status = ANY(${p(statuses)}::text[])`);
  const sources = filters.filter((f) => f.startsWith("source:")).map((f) => f.slice("source:".length));
  // An unknown source matches nothing, as Coolify's where('id', -1).
  if (sources.length > 0) where.push(`(${sources.map((source) => `(${SOURCE_FILTERS[source] ?? "false"})`).join(" OR ")})`);
  const servers = filters.filter((f) => f.startsWith("server:")).map((f) => f.slice("server:".length)).filter((id) => /^\d+$/.test(id)).map(Number);
  if (servers.length > 0) where.push(`server_id = ANY(${p(servers)}::int[])`);

  const condition = where.join(" AND ");
  const counted = await tx.execute<{ count: number | string }>(`SELECT count(*) AS count FROM deploy.application_deployment_queues WHERE ${condition}`, params);
  const direction = options.sort === "oldest" ? "ASC" : "DESC";
  const take = Math.max(1, Math.min(100, Math.trunc(options.take ?? 10)));
  const skip = Math.max(0, Math.trunc(options.skip ?? 0));
  const listed = await tx.execute<DeployDeploymentListRow>(
    `SELECT ${HISTORY_COLUMNS} FROM deploy.application_deployment_queues WHERE ${condition} ORDER BY created_at ${direction}, id ${direction} LIMIT ${take} OFFSET ${skip}`,
    params,
  );
  return { count: Number(counted.rows[0]?.count ?? 0), deployments: listed.rows };
}

/** What the history's filter menu offers: only what the application's deployments have. */
export interface DeploymentFilterOptions {
  statuses: string[];
  /** 'manual', 'pull-request', 'webhook', 'api', 'mcp' or 'rollback'. */
  sources: string[];
  servers: Array<{ id: number; name: string | null }>;
  /** Highest first. */
  pullRequestIds: number[];
}

/** Deployment\Index::loadDeploymentFilterOptions() and loadPullRequestOptions(), their queries. */
export async function deploymentFilterOptions(tx: SqlExecutor, applicationId: string | number): Promise<DeploymentFilterOptions> {
  const id = String(applicationId);
  const statuses = await tx.execute<{ status: string }>("SELECT DISTINCT status FROM deploy.application_deployment_queues WHERE application_id = $1", [id]);
  const sources = await tx.execute<{ source_key: string }>(
    `SELECT DISTINCT CASE
              WHEN pull_request_id > 0 THEN 'pull-request'
              WHEN is_webhook THEN 'webhook'
              WHEN rollback THEN 'rollback'
              WHEN is_mcp THEN 'mcp'
              WHEN is_api THEN 'api'
              ELSE 'manual'
            END AS source_key
       FROM deploy.application_deployment_queues WHERE application_id = $1`,
    [id],
  );
  const servers = await tx.execute<{ server_id: number; server_name: string | null }>(
    "SELECT DISTINCT server_id, server_name FROM deploy.application_deployment_queues WHERE application_id = $1 AND server_id IS NOT NULL ORDER BY server_name",
    [id],
  );
  const pullRequests = await tx.execute<{ pull_request_id: number }>(
    `SELECT DISTINCT pull_request_id FROM deploy.application_deployment_queues WHERE application_id = $1 AND pull_request_id > 0
      UNION SELECT pull_request_id FROM deploy.application_previews WHERE application_id = $2 AND deleted_at IS NULL`,
    [id, applicationId],
  );
  const seen = new Set<number>();
  return {
    statuses: statuses.rows.map((r) => r.status),
    sources: sources.rows.map((r) => r.source_key),
    // unique('server_id'): the first name of each server.
    servers: servers.rows.filter((r) => !seen.has(Number(r.server_id)) && seen.add(Number(r.server_id))).map((r) => ({ id: Number(r.server_id), name: r.server_name })),
    pullRequestIds: [...new Set(pullRequests.rows.map((r) => Number(r.pull_request_id)))].sort((a, b) => b - a),
  };
}

/**
 * An application as the deployment job reads it: its own columns, its settings, its destination, that
 * destination's server with its settings, and its environment and project. What the label generator reads is
 * here too (DeployApplicationLabelRow's columns), so one row serves both.
 */
export interface DeployDeploymentApplicationRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  build_pack: string;
  status: string;
  fqdn: string | null;
  git_branch: string;
  /** $application->dockerfile is set. */
  has_dockerfile: boolean;
  dockerfile_target_build: string | null;
  docker_registry_image_name: string | null;
  docker_registry_image_tag: string | null;
  ports_exposes: string | null;
  ports_mappings: string | null;
  custom_network_aliases: string | null;
  custom_labels: string | null;
  custom_docker_run_options: string | null;
  pre_deployment_command: string | null;
  pre_deployment_command_container: string | null;
  post_deployment_command: string | null;
  post_deployment_command_container: string | null;
  health_check_enabled: boolean;
  health_check_type: string | null;
  health_check_command: string | null;
  health_check_method: string;
  health_check_scheme: string;
  health_check_host: string;
  health_check_port: string | null;
  health_check_path: string | null;
  health_check_return_code: number | null;
  health_check_response_text: string | null;
  health_check_interval: number;
  health_check_timeout: number;
  health_check_retries: number;
  health_check_start_period: number;
  custom_healthcheck_found: boolean;
  limits_cpus: string;
  limits_cpuset: string | null;
  limits_cpu_shares: number;
  limits_memory: string;
  limits_memory_swap: string;
  limits_memory_swappiness: number;
  limits_memory_reservation: string;
  compose_parsing_version: string | null;
  git_ssh_known_hosts: string | null;
  redirect: string;
  is_http_basic_auth_enabled: boolean;
  http_basic_auth_username: string | null;
  /** An `encrypted` column: the stored value is ciphertext. */
  http_basic_auth_password: string | null;
  http_basic_auth_hash_algorithm: string;
  http_basic_auth_bcrypt_cost: number;
  http_basic_auth_argon2id_memory_cost: number;
  http_basic_auth_argon2id_time_cost: number;
  /** JSON columns: the driver may hand back the parsed value or its text. */
  noindex_domains: unknown;
  domain_port_overrides: unknown;
  // application_settings (null when the row is missing)
  is_static: boolean | null;
  is_force_https_enabled: boolean | null;
  is_gzip_enabled: boolean | null;
  is_stripprefix_enabled: boolean | null;
  is_permanent_redirect_enabled: boolean | null;
  is_container_label_readonly_enabled: boolean | null;
  is_container_label_escape_enabled: boolean | null;
  application_traefik_certificate_resolver: string | null;
  is_consistent_container_name_enabled: boolean | null;
  custom_internal_name: string | null;
  custom_container_name_prefix: string | null;
  stop_grace_period: number | null;
  rolling_update_drain_seconds: number | null;
  is_log_drain_enabled: boolean | null;
  is_gpu_enabled: boolean | null;
  gpu_driver: string | null;
  gpu_count: string | null;
  gpu_device_ids: string | null;
  gpu_options: string | null;
  is_env_sorting_enabled: boolean | null;
  include_coolify_default_variables: boolean | null;
  redact_all_env_values_in_logs: boolean | null;
  use_build_secrets: boolean | null;
  include_network_hosts_in_build: boolean | null;
  is_debug_enabled: boolean | null;
  // environment and project
  environment_id: string | number;
  environment_uuid: string;
  environment_name: string;
  project_id: string | number;
  project_uuid: string;
  project_name: string;
  // destination and its server
  destination_id: string | number | null;
  destination_type: string | null;
  destination_network: string | null;
  server_id: string | number | null;
  server_uuid: string | null;
  server_name: string | null;
  server_ip: string | null;
  server_user: string | null;
  server_port: number | null;
  /** servers.proxy (JSON): type, status and what the proxy pages keep there. */
  server_proxy: unknown;
  server_is_swarm_manager: boolean | null;
  server_is_swarm_worker: boolean | null;
  server_is_reachable: boolean | null;
  server_is_usable: boolean | null;
  server_force_disabled: boolean | null;
  server_docker_version: string | null;
  server_timezone: string | null;
  server_generate_exact_labels: boolean | null;
  server_traefik_certificate_resolver: string | null;
  server_is_traffic_analytics_enabled: boolean | null;
  is_logdrain_newrelic_enabled: boolean | null;
  is_logdrain_axiom_enabled: boolean | null;
  is_logdrain_custom_enabled: boolean | null;
  is_logdrain_cloudwatch_enabled: boolean | null;
  logdrain_cloudwatch_region: string | null;
  logdrain_cloudwatch_group: string | null;
  logdrain_cloudwatch_stream_prefix: string | null;
}

const DEPLOYMENT_APPLICATION_COLUMNS = [
  "id", "uuid", "name", "build_pack", "status", "fqdn", "git_branch", "dockerfile_target_build", "docker_registry_image_name",
  "docker_registry_image_tag", "ports_exposes", "ports_mappings", "custom_network_aliases", "custom_labels", "custom_docker_run_options",
  "pre_deployment_command", "pre_deployment_command_container", "post_deployment_command", "post_deployment_command_container",
  "health_check_enabled", "health_check_type", "health_check_command", "health_check_method", "health_check_scheme", "health_check_host",
  "health_check_port", "health_check_path", "health_check_return_code", "health_check_response_text", "health_check_interval",
  "health_check_timeout", "health_check_retries", "health_check_start_period", "custom_healthcheck_found", "limits_cpus", "limits_cpuset",
  "limits_cpu_shares", "limits_memory", "limits_memory_swap", "limits_memory_swappiness", "limits_memory_reservation",
  "compose_parsing_version", "git_ssh_known_hosts", "redirect", "is_http_basic_auth_enabled", "http_basic_auth_username",
  "http_basic_auth_password", "http_basic_auth_hash_algorithm", "http_basic_auth_bcrypt_cost", "http_basic_auth_argon2id_memory_cost",
  "http_basic_auth_argon2id_time_cost", "noindex_domains", "domain_port_overrides", "environment_id", "destination_id", "destination_type",
].map((c) => `a."${c}"`);

const DEPLOYMENT_SETTINGS_COLUMNS = [
  "is_static", "is_force_https_enabled", "is_gzip_enabled", "is_stripprefix_enabled", "is_permanent_redirect_enabled",
  "is_container_label_readonly_enabled", "is_container_label_escape_enabled", "is_consistent_container_name_enabled", "custom_internal_name",
  "custom_container_name_prefix", "stop_grace_period", "rolling_update_drain_seconds", "is_log_drain_enabled", "is_gpu_enabled", "gpu_driver",
  "gpu_count", "gpu_device_ids", "gpu_options", "is_env_sorting_enabled", "include_coolify_default_variables",
  "redact_all_env_values_in_logs", "use_build_secrets", "include_network_hosts_in_build", "is_debug_enabled",
].map((c) => `st."${c}"`);

const SERVER_SETTINGS_COLUMNS = [
  "is_logdrain_newrelic_enabled", "is_logdrain_axiom_enabled", "is_logdrain_custom_enabled", "is_logdrain_cloudwatch_enabled",
  "logdrain_cloudwatch_region", "logdrain_cloudwatch_group", "logdrain_cloudwatch_stream_prefix",
].map((c) => `ss."${c}"`);

const SELECT_DEPLOYMENT_APPLICATION = `SELECT ${[...DEPLOYMENT_APPLICATION_COLUMNS, ...DEPLOYMENT_SETTINGS_COLUMNS, ...SERVER_SETTINGS_COLUMNS].join(", ")},
       (a.dockerfile IS NOT NULL AND a.dockerfile <> '') AS has_dockerfile,
       st.traefik_certificate_resolver AS application_traefik_certificate_resolver,
       e.uuid AS environment_uuid, e.name AS environment_name, p.id AS project_id, p.uuid AS project_uuid, p.name AS project_name,
       COALESCE(sd.network, wd.network) AS destination_network,
       s.id AS server_id, s.uuid AS server_uuid, s.name AS server_name, s.ip AS server_ip, s."user" AS server_user, s.port AS server_port,
       s.proxy AS server_proxy,
       ss.is_swarm_manager AS server_is_swarm_manager, ss.is_swarm_worker AS server_is_swarm_worker,
       ss.is_reachable AS server_is_reachable, ss.is_usable AS server_is_usable, ss.force_disabled AS server_force_disabled,
       ss.docker_version AS server_docker_version, ss.server_timezone AS server_timezone,
       ss.generate_exact_labels AS server_generate_exact_labels,
       ss.traefik_certificate_resolver AS server_traefik_certificate_resolver,
       ss.is_traffic_analytics_enabled AS server_is_traffic_analytics_enabled
  FROM deploy.applications a
  JOIN deploy.environments e ON e.id = a.environment_id
  JOIN deploy.projects p ON p.id = e.project_id
  LEFT JOIN deploy.application_settings st ON st.application_id = a.id
  LEFT JOIN deploy.standalone_dockers sd ON sd.id = a.destination_id AND a.destination_type = E'${STANDALONE}'
  LEFT JOIN deploy.swarm_dockers wd ON wd.id = a.destination_id AND a.destination_type = E'${SWARM}'
  LEFT JOIN deploy.servers s ON s.id = COALESCE(sd.server_id, wd.server_id) AND s.deleted_at IS NULL
  LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id`;

/** The application a deployment is of, by its uuid (the pages and the routes). Null when it is not the org's. */
export async function findDeploymentApplicationByUuid(tx: SqlExecutor, uuid: string): Promise<DeployDeploymentApplicationRow | null> {
  const r = await tx.execute<DeployDeploymentApplicationRow>(`${SELECT_DEPLOYMENT_APPLICATION} WHERE a.uuid = $1 AND a.deleted_at IS NULL`, [uuid]);
  return r.rows[0] ?? null;
}

/** Application::find($deployment->application_id): the application a job deploys. */
export async function findDeploymentApplicationById(tx: SqlExecutor, id: string | number): Promise<DeployDeploymentApplicationRow | null> {
  if (!/^\d+$/.test(String(id))) return null;
  const r = await tx.execute<DeployDeploymentApplicationRow>(`${SELECT_DEPLOYMENT_APPLICATION} WHERE a.id = $1 AND a.deleted_at IS NULL`, [id]);
  return r.rows[0] ?? null;
}

/** The morph class Coolify stores for an application's storages. */
const APPLICATION_MORPH_CLASS = "App\\Models\\Application";

export interface DeployPersistentStorageRow extends SqlRow {
  id: string | number;
  name: string;
  mount_path: string;
  host_path: string | null;
}

/** $application->persistentStorages */
export async function listApplicationPersistentStorages(tx: SqlExecutor, applicationId: string | number): Promise<DeployPersistentStorageRow[]> {
  const r = await tx.execute<DeployPersistentStorageRow>(
    "SELECT id, name, mount_path, host_path FROM deploy.local_persistent_volumes WHERE resource_type = $1 AND resource_id = $2 ORDER BY id",
    [APPLICATION_MORPH_CLASS, applicationId],
  );
  return r.rows;
}

export interface DeployFileStorageRow extends SqlRow {
  id: string | number;
  fs_path: string;
  mount_path: string | null;
  is_directory: boolean;
  /** Whether the row has content to write (the content itself is not read here). */
  has_content: boolean;
}

/** $application->fileStorages */
export async function listApplicationFileStorages(tx: SqlExecutor, applicationId: string | number): Promise<DeployFileStorageRow[]> {
  const r = await tx.execute<DeployFileStorageRow>(
    `SELECT id, fs_path, mount_path, is_directory, (content IS NOT NULL) AS has_content
       FROM deploy.local_file_volumes WHERE resource_type = $1 AND resource_id = $2 ORDER BY id`,
    [APPLICATION_MORPH_CLASS, applicationId],
  );
  return r.rows;
}

/** What a deployment writes to its application: its status, and the restart counters a successful one resets. */
export interface ApplicationDeploymentState {
  status?: string;
  restart_count?: number;
  last_restart_at?: null;
  last_restart_type?: null;
  restart_limit_reached?: boolean;
}

/** $application->update([...]); a changed status also stamps last_online_at, as the saving hook does. */
export async function updateApplicationDeploymentState(tx: SqlExecutor, id: string | number, changes: ApplicationDeploymentState): Promise<boolean> {
  const columns = (["status", "restart_count", "last_restart_at", "last_restart_type", "restart_limit_reached"] as const).filter((c) => changes[c] !== undefined);
  if (columns.length === 0) return true;
  // The status is named twice in the statement, so its parameter is typed.
  const sets = columns.map((c, i) => `"${c}" = $${i + 2}${c === "status" ? "::varchar" : ""}`);
  if (changes.status !== undefined) sets.push(`last_online_at = CASE WHEN status IS DISTINCT FROM $${columns.indexOf("status") + 2}::varchar THEN ${NOW} ELSE last_online_at END`);
  const r = await tx.execute<{ id: string | number }>(`UPDATE deploy.applications SET ${[...sets, `updated_at = ${NOW}`].join(", ")} WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [
    id,
    ...columns.map((c) => changes[c] ?? null),
  ]);
  return r.rows.length > 0;
}

/** Server::rememberDockerVersion(): the version the server answered with, and when. */
export async function rememberServerDockerVersion(tx: SqlExecutor, serverId: string | number, version: string | null): Promise<void> {
  await tx.execute(`UPDATE deploy.server_settings SET docker_version = $2, docker_version_checked_at = ${NOW}, updated_at = ${NOW} WHERE server_id = $1`, [serverId, version]);
}

/** The Show page's "Debug logs" switch: application_settings.is_debug_enabled. */
export async function setApplicationDebugEnabled(tx: SqlExecutor, applicationId: string | number, enabled: boolean): Promise<boolean> {
  const r = await tx.execute<{ id: string | number }>(`UPDATE deploy.application_settings SET is_debug_enabled = $2, updated_at = ${NOW} WHERE application_id = $1 RETURNING id`, [applicationId, enabled]);
  return r.rows.length > 0;
}

/** What an SSH connection to a server needs: where, as whom, with which key, and the host key it is pinned to. */
export interface DeployServerSshRow extends SqlRow {
  id: string | number;
  uuid: string;
  ip: string;
  port: number;
  user: string;
  /** The fp1 ciphertext of the server's private key; null when the key is gone. */
  private_key: string | null;
  /** The pinned host key, or null before the first connection. */
  ssh_host_key: string | null;
}

/** The server of a deployment as the SSH executor connects to it. Null when the server is gone. */
export async function findServerSshConnection(tx: SqlExecutor, serverId: string | number): Promise<DeployServerSshRow | null> {
  const r = await tx.execute<DeployServerSshRow>(
    `SELECT s.id, s.uuid, s.ip, s.port, s."user", k.private_key, ss.ssh_host_key
       FROM deploy.servers s
       LEFT JOIN deploy.private_keys k ON k.id = s.private_key_id
       LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id
      WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [serverId],
  );
  return r.rows[0] ?? null;
}
