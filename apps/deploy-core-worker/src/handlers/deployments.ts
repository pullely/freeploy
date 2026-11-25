// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/{Heading,DeploymentNavbar}.php,
// app/Livewire/Project/Application/Deployment/{Index,Show}.php, app/Policies/ApplicationPolicy.php and
// bootstrap/helpers/applications.php (queue_application_deployment's dispatch, fail_undispatchable_deployment)
// (Apache-2.0), modified.
//
// The deployment queue of an application, for handlers/applications.ts, which hands these routes over
// (segments: what follows /applications):
//
//   POST /{uuid}/deploy { force_rebuild? }            Heading::deploy            — only when SSH_SESSION is bound
//   POST /{uuid}/restart                              Heading::restart           — only when SSH_SESSION is bound
//   GET  /{uuid}/deployments                          Deployment\Index: ?skip&take&pull_request_id&search&sort&filters=a,b
//   GET  /{uuid}/deployments/{deployment_uuid}        Deployment\Show: the status and the log lines
//   GET  /{uuid}/deployments/{deployment_uuid}/logs   exportLogs (?timestamps=0&search=) or, with ?all=1, downloadAllLogs
//   POST /{uuid}/deployments/{deployment_uuid}/cancel       DeploymentNavbar::cancel       — needs SSH_SESSION (501 without)
//   POST /{uuid}/deployments/{deployment_uuid}/force-start  DeploymentNavbar::force_start  — needs SSH_SESSION (501 without)
//   POST /{uuid}/deployments/{deployment_uuid}/debug        Show::toggleDebug
//
// Without the SSH executor (env.SSH_SESSION, WAITING.md W3) nothing is queued: Deploy and Restart keep their
// "not available yet" answer in handlers/applications.ts, because a queued deployment that can never run
// would be a lie. With it, a deployment is admitted as Coolify admits it; one that starts is handed to its
// Workflow (env.DEPLOYMENT_WORKFLOW), and one whose job cannot be started fails at once, as Coolify's does.
//
// Coolify's policy: view = read; deploy and update = write. A denial answers 404.
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  appendDeploymentLog,
  deploymentFilterOptions,
  enqueueDeployment,
  failUnattendedDeployment,
  findDeploymentApplicationById,
  findDeploymentApplicationByUuid,
  findDeploymentByUuid,
  findRunningDeploymentUrl,
  listDeployments,
  setApplicationDebugEnabled,
  startNextQueuedDeployments,
  startQueuedDeployment,
  updateDeploymentStatus,
  type DeployDeploymentRow,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse } from "../http.js";
import { authorizeDeploy, readJson } from "./cloud-tokens.js";
import { sessionExecutor, sessionFetch } from "../deployments/session-executor.js";
import { loadDeploymentVariables, loadServerConnection } from "../deployments/sql.js";
import {
  cancelDeployment,
  DeploymentError,
  deploymentLogsText,
  deploymentShow,
  deploymentsIndex,
  failUndispatchableDeployment,
  forceStartDeployment,
  queueDeployment,
  toggleDebug,
  undispatchableReason,
  type DeploymentServiceContext,
  type DeploymentServiceStore,
} from "../deployments/service.js";

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

export const DEPLOYMENT_HANDLER_MESSAGES = {
  cancelUnavailable: "Cancelling a deployment needs the SSH executor, which is not available yet.",
  forceStartUnavailable: "Starting a deployment needs the SSH executor, which is not available yet.",
  /** Freeploy's: the Workflow binding is missing although the SSH executor is there. */
  noWorkflow: "the deployment Workflow is not bound to this Worker.",
} as const;

/** How the handler reaches the database and starts jobs; replaceable for tests. */
export interface DeploymentDeps {
  /** Runs fn with one org's deployment store, in one transaction confined to that org. */
  run<T>(env: Env, orgId: string, fn: (ctx: DeploymentServiceContext) => Promise<T>): Promise<T>;
  /** Starts the job of a deployment that was started; throws when it cannot. */
  dispatch(env: Env, orgId: string, deployment: DeployDeploymentRow): Promise<void>;
}

function sqlStore(tx: SqlExecutor, orgId: string, secret: string | undefined): DeploymentServiceStore {
  return {
    findApplication: (uuid) => findDeploymentApplicationByUuid(tx, uuid),
    findApplicationById: (id) => findDeploymentApplicationById(tx, id),
    enqueue: (input) => enqueueDeployment(tx, { ...input, orgId }),
    list: (applicationId, options) => listDeployments(tx, applicationId, options),
    filterOptions: (applicationId) => deploymentFilterOptions(tx, applicationId),
    find: (applicationId, deploymentUuid) => findDeploymentByUuid(tx, applicationId, deploymentUuid),
    cancel: async (id) => {
      await updateDeploymentStatus(tx, id, "cancelled-by-user");
    },
    appendLog: async (id, entry, hint) => {
      await appendDeploymentLog(tx, id, entry, hint);
    },
    startQueued: (id, force) => startQueuedDeployment(tx, id, force),
    startNextQueued: (applicationId, serverId) => startNextQueuedDeployments(tx, applicationId, serverId),
    failUnattended: (id) => failUnattendedDeployment(tx, id),
    variables: (application) => loadDeploymentVariables(tx, orgId, secret, application),
    setDebug: async (applicationId, enabled) => {
      await setApplicationDebugEnabled(tx, applicationId, enabled);
    },
    runningDeploymentUrl: (applicationId) => findRunningDeploymentUrl(tx, applicationId),
  };
}

export const sqlDeploymentDeps: DeploymentDeps = {
  async run(env, orgId, fn) {
    const db = createSqlExecutor(env.PLATFORM_DB!);
    try {
      return await withOrg(db, orgId, (tx) =>
        fn({
          store: sqlStore(tx, orgId, env.DEPLOY_ENCRYPTION_KEY),
          executor: async (application) => {
            if (!env.SSH_SESSION || application.server_id === null) return null;
            const connection = await loadServerConnection(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, application.server_id);
            return connection ? sessionExecutor(sessionFetch(env.SSH_SESSION, connection.serverUuid), connection.conn, 30) : null;
          },
          now: () => new Date(),
        }),
      );
    } finally {
      await db.dispose();
    }
  },
  async dispatch(env, orgId, deployment) {
    if (!env.DEPLOYMENT_WORKFLOW) throw new Error(DEPLOYMENT_HANDLER_MESSAGES.noWorkflow);
    await env.DEPLOYMENT_WORKFLOW.create({ id: deployment.deployment_uuid, params: { orgId, deploymentUuid: deployment.deployment_uuid } });
  },
};

/** The routes of this handler, among what follows /applications. Deploy and Restart only with the SSH executor. */
export function isDeploymentRoute(env: Env, segments: string[]): boolean {
  if (segments[1] === "deployments") return true;
  return Boolean(env.SSH_SESSION) && segments.length === 2 && (segments[1] === "deploy" || segments[1] === "restart");
}

export async function handleDeployments(env: Env, requestId: string, actor: ActorContext, orgId: string, segments: string[], request: Request, deps: DeploymentDeps = sqlDeploymentDeps): Promise<Response> {
  const method = request.method;
  const [uuid, second, deploymentUuid, action] = segments;
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  if (!uuid || !UUID_RE.test(uuid) || segments.length > 4 || (deploymentUuid !== undefined && !UUID_RE.test(deploymentUuid))) return notFound();

  type Op = { write: boolean; method: "GET" | "POST"; run: (canWrite: boolean) => Promise<Response> };
  let op: Op | null = null;
  if (segments.length === 2 && (second === "deploy" || second === "restart")) op = { write: true, method: "POST", run: () => queue(second) };
  else if (second !== "deployments") return notFound();
  else if (segments.length === 2) op = { write: false, method: "GET", run: index };
  else if (segments.length === 3) op = { write: false, method: "GET", run: show };
  else if (action === "logs") op = { write: false, method: "GET", run: logs };
  else if (action === "cancel") op = { write: true, method: "POST", run: cancel };
  else if (action === "force-start") op = { write: true, method: "POST", run: forceStart };
  else if (action === "debug") op = { write: true, method: "POST", run: debug };
  else return notFound();
  if (method !== op.method) return methodNotAllowed(requestId);

  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;
  try {
    return await op.run(auth.canWrite);
  } catch (e) {
    if (e instanceof DeploymentError) {
      const code = e.status === 501 ? "unsupported" : e.status === 409 ? "conflict" : "validation_failed";
      return errorResponse(code, e.message, e.status, requestId, e.title ? { title: e.title } : undefined);
    }
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  /**
   * ApplicationDeploymentJob::dispatch(): start the job; a deployment whose job cannot be created or queued
   * fails at once, and what it blocked starts instead. Answers why this deployment could not start, or null.
   */
  async function start(deployment: DeployDeploymentRow): Promise<string | null> {
    let reason: string | null = null;
    const waiting = [deployment];
    // Each failure moves one deployment from in progress to failed, so this ends.
    for (let next = waiting.shift(); next; next = waiting.shift()) {
      const current = next;
      try {
        const refused = await deps.run(env, orgId, async (c) => {
          const application = await c.store.findApplicationById(current.application_id);
          return application ? undispatchableReason(application, current) : null;
        });
        if (refused !== null) throw new Error(refused);
        await deps.dispatch(env, orgId, current);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (current === deployment) reason = message;
        waiting.push(...(await deps.run(env, orgId, (c) => failUndispatchableDeployment(c, current, message))));
      }
    }
    return reason;
  }

  async function queue(kind: "deploy" | "restart"): Promise<Response> {
    const body = await readJson(request);
    const outcome = await deps.run(env, orgId, (c) => queueDeployment(c, uuid!, kind === "restart" ? { restartOnly: true } : { forceRebuild: body.force_rebuild === true }));
    if (!outcome) return notFound();
    if (outcome.status === "skipped") return successResponse(outcome, requestId);
    const { dispatch, ...answer } = outcome;
    if (dispatch) {
      const reason = await start(dispatch);
      if (reason !== null) return errorResponse("internal_error", `Deployment could not be started: ${reason}`, 503, requestId, { deploymentUuid: outcome.deploymentUuid, redirect: outcome.redirect });
    }
    return successResponse(answer, requestId, 201);
  }

  async function index(): Promise<Response> {
    const q = new URL(request.url).searchParams;
    const number = (name: string): number | undefined => (q.has(name) && /^\d+$/.test(q.get(name)!) ? Number(q.get(name)) : undefined);
    const skip = number("skip");
    const take = number("take");
    const data = await deps.run(env, orgId, (c) =>
      deploymentsIndex(c, uuid!, {
        ...(skip === undefined ? {} : { skip }),
        ...(take === undefined ? {} : { take }),
        pullRequestId: q.get("pull_request_id"),
        search: q.get("search") ?? "",
        filters: (q.get("filters") ?? "").split(",").filter(Boolean),
        sort: q.get("sort") ?? "newest",
      }),
    );
    return data ? successResponse(data, requestId) : notFound();
  }

  async function show(canWrite: boolean): Promise<Response> {
    const data = await deps.run(env, orgId, (c) => deploymentShow(c, uuid!, deploymentUuid!, canWrite));
    // The view's @can('update' | 'deploy', $application).
    return data ? successResponse({ ...data, canUpdate: canWrite, canDeploy: canWrite }, requestId) : notFound();
  }

  async function logs(canWrite: boolean): Promise<Response> {
    const q = new URL(request.url).searchParams;
    const all = q.get("all") === "1";
    // downloadAllLogs(): $this->authorize('update', $this->application).
    if (all && !canWrite) return notFound();
    const text = await deps.run(env, orgId, (c) => deploymentLogsText(c, uuid!, deploymentUuid!, { all, canUpdate: canWrite, withTimestamps: q.get("timestamps") !== "0", search: q.get("search") ?? "" }));
    return text === null ? notFound() : successResponse({ logs: text }, requestId);
  }

  async function cancel(): Promise<Response> {
    if (!env.SSH_SESSION) return errorResponse("unsupported", DEPLOYMENT_HANDLER_MESSAGES.cancelUnavailable, 501, requestId);
    const outcome = await deps.run(env, orgId, (c) => cancelDeployment(c, uuid!, deploymentUuid!));
    if (!outcome) return notFound();
    for (const next of outcome.dispatch) await start(next);
    // handleError(): the cleanup's failure is an error toast; the deployment is cancelled all the same.
    if (outcome.error !== null) return errorResponse("validation_failed", outcome.error, 422, requestId, { cancelled: true });
    return successResponse({ status: "cancelled-by-user" }, requestId);
  }

  async function forceStart(): Promise<Response> {
    if (!env.SSH_SESSION) return errorResponse("unsupported", DEPLOYMENT_HANDLER_MESSAGES.forceStartUnavailable, 501, requestId);
    const outcome = await deps.run(env, orgId, (c) => forceStartDeployment(c, uuid!, deploymentUuid!));
    if (!outcome) return notFound();
    if (outcome.dispatch) {
      const reason = await start(outcome.dispatch);
      if (reason !== null) return errorResponse("internal_error", `Deployment could not be started: ${reason}`, 503, requestId);
    }
    return successResponse({ started: outcome.started, message: outcome.message }, requestId);
  }

  async function debug(): Promise<Response> {
    const toggled = await deps.run(env, orgId, (c) => toggleDebug(c, uuid!));
    return toggled ? successResponse(toggled, requestId) : notFound();
  }
}
