// The Git webhooks (freeploy-coolify-parity DP-72): Coolify's public receivers, on Coolify's paths at the edge's
// origin — routes/webhooks.php under /webhooks:
//
//   POST /webhooks/source/github/events          a GitHub App's deliveries
//   POST /webhooks/source/github/events/manual   a repository's own webhook (the application's manual secret)
//   POST /webhooks/source/gitlab/events[/manual], /webhooks/source/gitea/events[/manual],
//        /webhooks/source/bitbucket/events/manual
//
// No session: the provider calls them. The edge neither verifies nor parses: it streams the raw body and the
// provider's signature headers to deploy-core-worker, which holds the secrets (encrypted, per org) and checks
// the signature over the exact bytes the provider signed. A body over GitHub's own maximum (25 MB) is refused
// before it is read.
import type { Env } from "./env";
import { errorResponse } from "./http";

const GIT_WEBHOOK_RE = /^\/webhooks\/source\/(github|gitlab|gitea|bitbucket)\/events(\/manual)?\/?$/;

/** GitHub's largest delivery. */
export const GIT_WEBHOOK_MAX_BYTES = 25 * 1024 * 1024;

/** What the receivers read: the content type and each provider's event, delivery and signature headers. */
const FORWARDED_HEADERS = [
  "content-type",
  "content-length",
  "user-agent",
  "x-github-event",
  "x-github-delivery",
  "x-github-hook-id",
  "x-github-hook-installation-target-id",
  "x-github-hook-installation-target-type",
  "x-hub-signature",
  "x-hub-signature-256",
  "x-gitlab-event",
  "x-gitlab-token",
  "x-gitea-event",
  "x-gitea-signature",
  "x-gitea-delivery",
  "x-event-key",
  "x-request-uuid",
  "cf-connecting-ip",
];

export function isGitWebhookRoute(pathname: string): boolean {
  return GIT_WEBHOOK_RE.test(pathname);
}

export async function handleGitWebhookRoute(request: Request, env: Env, requestId: string, pathname: string): Promise<Response> {
  // Coolify's routes are POST only.
  if (request.method !== "POST") return errorResponse("method_not_allowed", "Method not allowed", 405, requestId);
  if (!env.DEPLOY_CORE_WORKER) return errorResponse("service_unavailable", "Deploy service unavailable", 503, requestId);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > GIT_WEBHOOK_MAX_BYTES) return errorResponse("payload_too_large", "The webhook payload is too large.", 413, requestId);

  const headers = new Headers();
  headers.set("x-request-id", requestId);
  headers.set("x-internal-caller", "api-edge");
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const match = pathname.match(GIT_WEBHOOK_RE)!;
  const target = new URL(`/v1/internal/webhooks/source/${match[1]}/events${match[2] ?? ""}`, "https://deploy-core.internal");
  try {
    // The raw body, unread, so the bytes the provider signed reach the verifier intact.
    const downstream = await env.DEPLOY_CORE_WORKER.fetch(target.toString(), { method: "POST", headers, body: request.body });
    return new Response(downstream.body, { status: downstream.status, headers: downstream.headers });
  } catch {
    return errorResponse("service_unavailable", "Deploy service unavailable", 503, requestId);
  }
}
