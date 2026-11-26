// The Git webhooks at the edge (DP-72): Coolify's public /webhooks/source/* paths, POST only, the raw body and the
// providers' signature headers streamed unread to deploy-core-worker (which checks the signature), a body over
// 25 MB refused before it is read, and deploy-core-worker's answer passed through as it is.
import { isGitWebhookRoute, handleGitWebhookRoute, GIT_WEBHOOK_MAX_BYTES } from "@api-edge/git-webhooks-facade";
import type { Env } from "@api-edge/env";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function fakeDeployCore(answer: () => Response = () => new Response("pong", { headers: { "content-type": "text/html; charset=utf-8" } })): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, init: init ?? {} });
      return Promise.resolve(answer());
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

const env = (fetcher?: Fetcher): Env => ({ DEPLOY_CORE_WORKER: fetcher }) as unknown as Env;

describe("isGitWebhookRoute", () => {
  it("matches Coolify's receivers, and nothing else", () => {
    for (const path of ["/webhooks/source/github/events", "/webhooks/source/github/events/manual", "/webhooks/source/gitlab/events", "/webhooks/source/gitlab/events/manual", "/webhooks/source/gitea/events/manual", "/webhooks/source/bitbucket/events/manual"]) {
      expect(isGitWebhookRoute(path)).toBe(true);
    }
    for (const path of ["/webhooks/source/github/redirect", "/webhooks/source/github/install", "/webhooks/source/other/events", "/v1/webhooks/source/github/events", "/webhooks/payments/stripe/events"]) {
      expect(isGitWebhookRoute(path)).toBe(false);
    }
  });
});

describe("handleGitWebhookRoute", () => {
  it("streams the raw body and the signature headers to deploy-core-worker's internal receiver", async () => {
    const { fetcher, calls } = fakeDeployCore();
    const body = '{"ref":"refs/heads/main",  "after":"abc"}';
    const request = new Request("https://api.example/webhooks/source/github/events/manual", {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": "sha256=abc", "x-github-hook-installation-target-id": "4242", authorization: "Bearer not-forwarded" },
      body,
    });
    const response = await handleGitWebhookRoute(request, env(fetcher), "req_1", "/webhooks/source/github/events/manual");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("pong");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://deploy-core.internal/v1/internal/webhooks/source/github/events/manual");
    const headers = calls[0]!.init.headers as Headers;
    expect(headers.get("x-github-event")).toBe("push");
    expect(headers.get("x-hub-signature-256")).toBe("sha256=abc");
    expect(headers.get("x-github-hook-installation-target-id")).toBe("4242");
    expect(headers.get("x-internal-caller")).toBe("api-edge");
    expect(headers.get("authorization")).toBeNull();
    // The exact bytes: whitespace included.
    expect(await new Response(calls[0]!.init.body).text()).toBe(body);
  });

  it("passes the receiver's answer through: status, body and content type", async () => {
    const { fetcher } = fakeDeployCore(() => Response.json([{ status: "failed", message: "No matching application or invalid signature." }]));
    const request = new Request("https://api.example/webhooks/source/github/events/manual", { method: "POST", body: "{}" });
    const response = await handleGitWebhookRoute(request, env(fetcher), "req_1", "/webhooks/source/github/events/manual");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual([{ status: "failed", message: "No matching application or invalid signature." }]);
  });

  it("answers anything but POST with 405, and never forwards it", async () => {
    const { fetcher, calls } = fakeDeployCore();
    const response = await handleGitWebhookRoute(new Request("https://api.example/webhooks/source/github/events", { method: "GET" }), env(fetcher), "req_1", "/webhooks/source/github/events");
    expect(response.status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  it("refuses a body over 25 MB before reading it", async () => {
    const { fetcher, calls } = fakeDeployCore();
    const request = new Request("https://api.example/webhooks/source/github/events", { method: "POST", headers: { "content-length": String(GIT_WEBHOOK_MAX_BYTES + 1) }, body: "x" });
    const response = await handleGitWebhookRoute(request, env(fetcher), "req_1", "/webhooks/source/github/events");
    expect(response.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("answers 503 without the deploy-core-worker binding, or when it cannot be reached", async () => {
    const request = () => new Request("https://api.example/webhooks/source/gitlab/events/manual", { method: "POST", body: "{}" });
    expect((await handleGitWebhookRoute(request(), env(), "req_1", "/webhooks/source/gitlab/events/manual")).status).toBe(503);
    const broken = { fetch: () => Promise.reject(new Error("down")), connect: () => undefined } as unknown as Fetcher;
    expect((await handleGitWebhookRoute(request(), env(broken), "req_1", "/webhooks/source/gitlab/events/manual")).status).toBe(503);
  });
});
