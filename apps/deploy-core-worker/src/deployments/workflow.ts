// The Cloudflare Workflow that runs one deployment (design.md: a Coolify job is a Workflow instance).
//
// NOT EXPORTED from src/index.ts, and nothing imports this file: until deploy-core-worker's Wrangler
// configuration has a `workflows` entry for it — which waits for the SSH executor (WAITING.md W3) — exporting
// the class would only add an entrypoint no binding names. When W3 is resolved: add the `workflows` binding
// (DEPLOYMENT_WORKFLOW, class ApplicationDeploymentWorkflow) and the SSH_SESSION binding to
// wrangler.template.jsonc, export the class from index.ts, and handlers/deployments.ts starts an instance for
// every deployment it starts (its `dispatch`).
//
// One instance runs one deployment: the engine's steps (engine.ts), one `step.do` each. The state between two
// steps is the engine's plain EngineState, which the Workflow keeps; the rows are read again for every step,
// so nothing decrypted — a variable's value, the Basic Authentication password, the server's key — is ever part
// of what the Workflow stores. The waits of a deployment (the healthcheck's start period and interval, the
// proxy drain) are `step.sleep`s, so a deployment that waits costs nothing.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { appendDeploymentLog, failUnattendedDeployment, findDeploymentForJob, startNextQueuedDeployments, withOrg } from "@saas/db/deploy";
import type { Env } from "../env.js";
import { sessionFetcher } from "../ssh-session.js";
import { initialState, runStep, type DeploymentEffect, type EngineDeps, type EngineState } from "./engine.js";
import { buildLogEntry } from "./logs.js";
import { sessionExecutor } from "./session-executor.js";
import { loadDeploymentContext, loadServerConnection, sqlDeploymentStore } from "./sql.js";

export interface DeploymentWorkflowParams {
  /** The org's uuid. */
  orgId: string;
  deploymentUuid: string;
}

/** What the Workflow can start: another instance of itself. */
export interface DeploymentWorkflowBinding {
  create(options: { id: string; params: DeploymentWorkflowParams }): Promise<unknown>;
}

type WorkflowEnv = Env & { DEPLOYMENT_WORKFLOW?: DeploymentWorkflowBinding };

/** A deployment may run for an hour (the server's deployment timeout); a step that hangs is not retried into a second run of its commands. */
const STEP = { retries: { limit: 0, delay: 1000 }, timeout: "60 minutes" } as const;

export class ApplicationDeploymentWorkflow extends WorkflowEntrypoint<WorkflowEnv, DeploymentWorkflowParams> {
  async run(event: WorkflowEvent<DeploymentWorkflowParams>, step: WorkflowStep): Promise<{ thrown: string | null }> {
    const { orgId, deploymentUuid } = event.payload;
    let state: EngineState | null = null;
    try {
      // A deployment has at most a few dozen steps: its retries decide how many healthcheck attempts there are.
      for (let n = 0; state === null || state.next !== "done"; n++) {
        const before: EngineState | null = state;
        const after = await step.do(`${before?.next ?? "start"} ${n}`, STEP, async () => JSON.stringify(await this.step(orgId, deploymentUuid, before)));
        const next = JSON.parse(after) as EngineState | null;
        // The deployment row is gone: nothing to run.
        if (next === null) return { thrown: null };
        state = next;
        if (state.wait) await step.sleep(`wait ${n}`, state.wait.seconds * 1000);
      }
    } catch (e) {
      // A step that could not run at all (the database, the executor's container): left in progress, the
      // deployment would block every later one of its application, so it fails as Coolify fails the
      // deployment of a worker that stopped (fail_unattended_deployment).
      await step.do("fail unattended", async () => this.failUnattended(orgId, deploymentUuid));
      throw e;
    }
    return { thrown: state.thrown ? `${state.thrown.phpClass}: ${state.thrown.message}` : null };
  }

  private async failUnattended(orgId: string, deploymentUuid: string): Promise<void> {
    const db = createSqlExecutor(this.env.PLATFORM_DB!);
    try {
      const started = await withOrg(db, orgId, async (tx) => {
        const deployment = await findDeploymentForJob(tx, deploymentUuid);
        if (!deployment || !(await failUnattendedDeployment(tx, deployment.id))) return [];
        for (const message of ["========================================", "Deployment failed: the worker that ran it stopped. Deploy again.", "========================================"]) {
          await appendDeploymentLog(tx, deployment.id, buildLogEntry({ message, type: "stderr" }, { known: [], locked: [] }, new Date(), true).entry);
        }
        return /^[0-9]+$/.test(deployment.application_id) ? startNextQueuedDeployments(tx, deployment.application_id, deployment.server_id) : [];
      });
      for (const next of started) await this.effect(orgId, { type: "dispatch", deploymentUuid: next.deployment_uuid });
    } finally {
      await db.dispose();
    }
  }

  /** One engine step, with the rows read now. */
  private async step(orgId: string, deploymentUuid: string, state: EngineState | null): Promise<EngineState | null> {
    const env = this.env;
    if (!env.PLATFORM_DB || !env.SSH_SESSION) throw new Error("The deployment Workflow needs PLATFORM_DB and SSH_SESSION.");
    const db = createSqlExecutor(env.PLATFORM_DB);
    try {
      const loaded = await withOrg(db, orgId, async (tx) => {
        const ctx = await loadDeploymentContext(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, deploymentUuid);
        const connection = ctx && ctx.application.server_id !== null ? await loadServerConnection(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, ctx.application.server_id) : null;
        return { ctx, connection };
      });
      if (!loaded.ctx) return null;
      const connection = loaded.connection;
      const deps: EngineDeps = {
        // A server without a key cannot be reached: every command fails as a closed connection does.
        executor: connection
          ? sessionExecutor(sessionFetcher(env.SSH_SESSION, connection.serverUuid), connection.conn)
          : { run: async () => ({ exitCode: 255, stdout: "", stderr: "The server has no private key.\n" }) },
        store: sqlDeploymentStore(db, orgId),
        now: () => new Date(),
        // The waits between steps are the Workflow's sleeps, not the engine's.
        sleep: async () => {},
        effect: (effect) => this.effect(orgId, effect),
      };
      return await runStep(deps, loaded.ctx, state ?? initialState(loaded.ctx, deps.now()));
    } finally {
      await db.dispose();
    }
  }

  /**
   * What a deployment hands on. A deployment that the queue started gets its own instance. Notifications, the
   * container status check, the delayed cleanups and the broadcasts have no receiver yet (DP6, DP11).
   */
  private async effect(orgId: string, effect: DeploymentEffect): Promise<void> {
    if (effect.type === "dispatch") await this.env.DEPLOYMENT_WORKFLOW?.create({ id: effect.deploymentUuid, params: { orgId, deploymentUuid: effect.deploymentUuid } });
  }
}
