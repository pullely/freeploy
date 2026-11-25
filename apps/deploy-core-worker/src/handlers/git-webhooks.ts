// Derived from coollabsio/coolify@91b7e3e:routes/webhooks.php and app/Http/Controllers/Webhook/{Github,Gitlab,
// Bitbucket,Gitea}.php (Apache-2.0), modified.
//
// The Git webhooks (freeploy-coolify-parity DP-72), handed over by api-edge from its public origin — Coolify's
// paths below /webhooks — with the raw body and the provider's headers:
//
//   POST /v1/internal/webhooks/source/github/events          Github::normal  (a GitHub App's deliveries)
//   POST /v1/internal/webhooks/source/github/events/manual   Github::manual  (a repository's own webhook)
//   POST /v1/internal/webhooks/source/{gitlab,gitea}/events[/manual], /bitbucket/events/manual
//                                                            501: not ported (DP-72 cut them; see the status note)
//
// No actor: the signature is the authentication. A delivery names no org, so the App or the applications it is
// for are found across orgs with asPlatformAdmin() — which answers only org ids and row ids — and everything
// after that, the secret included, is read inside that org's withOrg().
import type { Env } from "../env.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  asPlatformAdmin,
  findGithubAppWebhookTarget,
  findManualWebhookTargets,
  findGithubAppById,
  listWebhookApplications,
  listGithubAppWebhookApplications,
  findApplicationPreview,
  insertApplicationPreview,
  updateApplicationPreview,
  previewHasDeployments,
  deleteApplicationPreview,
  insertSkippedDeployment,
  findGithubAppPrivateKey,
} from "@saas/db/deploy";
import { errorResponse } from "../http.js";
import { columnCipher } from "./cloud-tokens.js";
import { githubAppWebhook, githubManualWebhook, type WebhookAnswer, type WebhookDeps, type WebhookOrgContext } from "../sources/github-webhook.js";
import { InstallationTokens } from "../sources/github.js";
import { checkGithubAppPermissions, credentialsOf, type SourceContext } from "../sources/service.js";
import { sourceFetch, sqlSourceStore } from "./sources.js";
import { dohResolver } from "../s3-storages/safe-url.js";

export const GIT_WEBHOOK_INTERNAL_RE = /^\/v1\/internal\/webhooks\/source\/(github|gitlab|gitea|bitbucket)\/events(\/manual)?$/;

/** GitHub's largest delivery is 25 MB; a bigger body is refused before it is read. */
export const WEBHOOK_MAX_BODY_BYTES = 25 * 1024 * 1024;

export const GIT_WEBHOOK_MESSAGES = {
  /** Freeploy's: the GitLab, Gitea and Bitbucket receivers are not ported (DP-72's cut). */
  providerUnavailable: (provider: string) => `${provider} webhooks are not available yet.`,
  tooLarge: "The webhook payload is too large.",
} as const;

const PROVIDER_NAME: Record<string, string> = { gitlab: "GitLab", gitea: "Gitea", bitbucket: "Bitbucket" };

function orgContext(tx: SqlExecutor, orgId: string, env: Env, deps: Pick<WebhookDeps, "http">): WebhookOrgContext {
  const ciphers = new Map<string, ReturnType<typeof columnCipher>>();
  const cipher = (column: string) => {
    let found = ciphers.get(column);
    if (!found) ciphers.set(column, (found = columnCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, column)));
    return found;
  };
  const sourceCtx = (): SourceContext => ({ store: sqlSourceStore(tx, orgId), cipher, http: deps.http, org: "", stateSecret: env.DEPLOY_ENCRYPTION_KEY ?? "", resolve: dohResolver });
  return {
    orgId,
    githubApp: (id) => findGithubAppById(tx, id),
    decrypt: (column, stored) => cipher(column).decrypt(stored),
    applications: (ids) => listWebhookApplications(tx, ids),
    githubAppApplications: (appId, repositoryProjectId, branch) => listGithubAppWebhookApplications(tx, appId, repositoryProjectId, branch),
    credentials: async (app) => credentialsOf({ store: { privateKey: (id: string | number | null) => findGithubAppPrivateKey(tx, id) } as SourceContext["store"], cipher }, app),
    findPreview: (applicationId, pullRequestId) => findApplicationPreview(tx, applicationId, pullRequestId),
    insertPreview: (preview) => insertApplicationPreview(tx, { ...preview, orgId }),
    updatePreview: (id, changes) => updateApplicationPreview(tx, id, changes),
    previewHasDeployments: (applicationId, pullRequestId) => previewHasDeployments(tx, applicationId, pullRequestId),
    deletePreview: (id) => deleteApplicationPreview(tx, id),
    insertSkippedDeployment: async (deployment) => {
      await insertSkippedDeployment(tx, { ...deployment, orgId });
    },
    syncPermissions: async (app) => {
      await checkGithubAppPermissions(sourceCtx(), app.uuid);
    },
  };
}

/** The webhook dependencies over the platform database. */
export function sqlWebhookDeps(env: Env): WebhookDeps {
  const http = sourceFetch;
  const deps: WebhookDeps = {
    http,
    tokens: new InstallationTokens(http),
    now: () => new Date(),
    async githubAppTarget(appId, installationId) {
      const db = createSqlExecutor(env.PLATFORM_DB!);
      try {
        return await asPlatformAdmin(db, (tx) => findGithubAppWebhookTarget(tx, appId, installationId));
      } finally {
        await db.dispose();
      }
    },
    async manualTargets(pattern, branches) {
      const db = createSqlExecutor(env.PLATFORM_DB!);
      try {
        return await asPlatformAdmin(db, (tx) => findManualWebhookTargets(tx, pattern, branches));
      } finally {
        await db.dispose();
      }
    },
    async inOrg(orgId, fn) {
      const db = createSqlExecutor(env.PLATFORM_DB!);
      try {
        return await withOrg(db, orgId, (tx) => fn(orgContext(tx, orgId, env, deps)));
      } finally {
        await db.dispose();
      }
    },
  };
  return deps;
}

/** Laravel's response(): a string is text/html, anything else JSON. */
export function webhookResponse(answer: WebhookAnswer): Response {
  if (typeof answer.body === "string") return new Response(answer.body, { status: answer.status, headers: { "content-type": "text/html; charset=utf-8", ...answer.headers } });
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json", ...answer.headers } });
}

/** The raw body, at most WEBHOOK_MAX_BODY_BYTES; null when it is bigger. */
async function readRaw(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BODY_BYTES) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > WEBHOOK_MAX_BODY_BYTES) return null;
  return new TextDecoder().decode(bytes);
}

export async function handleGitWebhook(request: Request, env: Env, requestId: string, provider: string, manual: boolean, deps?: WebhookDeps): Promise<Response> {
  if (request.method !== "POST") return errorResponse("unsupported", "Method not allowed", 405, requestId);
  if (provider !== "github") return errorResponse("unsupported", GIT_WEBHOOK_MESSAGES.providerUnavailable(PROVIDER_NAME[provider] ?? provider), 501, requestId);
  if (!deps && !env.PLATFORM_DB) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  const raw = await readRaw(request);
  if (raw === null) return errorResponse("payload_too_large", GIT_WEBHOOK_MESSAGES.tooLarge, 413, requestId);
  const d = deps ?? sqlWebhookDeps(env);
  try {
    const handled = manual ? await githubManualWebhook(d, { headers: request.headers, raw }) : await githubAppWebhook(d, { headers: request.headers, raw });
    // What Coolify queues runs after the answer is made; its failure does not change the answer.
    for (const job of handled.after) {
      try {
        await job();
      } catch {
        // ProcessGithubPullRequestWebhook / GithubAppPermissionJob failing is the queue's, not the delivery's.
      }
    }
    return webhookResponse(handled.answer);
  } catch {
    // handleError(): an exception the controller did not expect is a server error.
    return errorResponse("internal_error", "Internal error", 500, requestId);
  }
}
