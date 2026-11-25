export interface Env {
  PLATFORM_DB?: Hyperdrive;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  /** Platform KEK (base64, 32 bytes) wrapping each org's data key. A Worker secret. */
  DEPLOY_ENCRYPTION_KEY?: string;
  /** One SshSession (Container-backed Durable Object) per server; stage first (DP4). */
  SSH_SESSION?: DurableObjectNamespace<import("./ssh-session.js").SshSession>;
  /**
   * The Workflow that runs a deployment (deployments/workflow.ts). Not bound yet: it waits, with SSH_SESSION,
   * for the SSH executor (WAITING.md W3).
   */
  DEPLOYMENT_WORKFLOW?: { create(options: { id: string; params: { orgId: string; deploymentUuid: string } }): Promise<unknown> };
  ENVIRONMENT: string;
}
