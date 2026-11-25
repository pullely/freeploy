// The platform facade (freeploy-coolify-parity DP12, DP-79): /v1/platform/* — Coolify's /settings/*, /admin and
// Team → Admin View — goes to deploy-core-worker with the signed-in actor, and every failure to get there is the
// same 404 as an unknown route: no credentials, a credential identity does not resolve (a Coolify /api/v1 token,
// `root` included: /v1/auth/resolve refuses API tokens), an unknown method. And /api/v1 has no settings or admin
// route: a root token asking there gets Coolify's own 404 fallback.
import worker from "@api-edge/index";
import { handlePlatformRoute, isPlatformRoute } from "@api-edge/platform-facade";
import { handleApiV1 } from "@api-edge/api-v1/index";
import type { Env } from "@api-edge/env";

interface Call {
  url: string;
  headers: Headers;
  method: string;
}

function fetcher(handler: (url: string, init: RequestInit) => Response, calls: Call[] = []): Fetcher {
  return {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, headers: new Headers(init?.headers), method: init?.method ?? "GET" });
      return Promise.resolve(handler(url, init ?? {}));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

const USER = "usr_" + "a".repeat(32);
/** identity-worker: a session token resolves to its user; anything else (an API token among them) is refused. */
const identity = fetcher((url, init) => {
  // /api/v1's token resolution: the root token is a valid token of an org owner, with the root ability.
  if (url.includes("/v1/internal/api-tokens/resolve")) {
    return Response.json({ data: { status: "ok", tokenNumber: 7, orgId: "org_" + "c".repeat(32), userId: USER, abilities: ["root"], canReadSensitive: true } });
  }
  if (!url.includes("/v1/auth/resolve")) return Response.json({}, { status: 404 });
  const auth = new Headers(init.headers).get("authorization");
  if (auth === "Bearer sps_ses_good") {
    return Response.json({ data: { actor: { actorType: "user", actorId: USER, email: "op@example.com" }, user: { id: USER, email: "op@example.com" } } });
  }
  return Response.json({ error: { code: "unauthenticated", message: "Authentication failed" } }, { status: 401 });
});

function env(deployCalls: Call[]): Env {
  return {
    ENVIRONMENT: "test",
    IDENTITY_WORKER: identity,
    DEPLOY_CORE_WORKER: fetcher(() => Response.json({ data: { operator: true }, meta: { requestId: "r", cursor: null } }), deployCalls),
  } as Env;
}

const req = (path: string, method = "GET", token?: string) =>
  new Request(`https://edge.test${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("api-edge platform facade", () => {
  test("matches /v1/platform and below only", () => {
    expect(isPlatformRoute("/v1/platform")).toBe(true);
    expect(isPlatformRoute("/v1/platform/settings")).toBe(true);
    expect(isPlatformRoute("/v1/platform/admin/users")).toBe(true);
    expect(isPlatformRoute("/v1/platforms")).toBe(false);
    expect(isPlatformRoute("/v1/organizations/org_x/deploy/settings")).toBe(false);
  });

  test("forwards a signed-in user's request to deploy-core-worker with the actor", async () => {
    const calls: Call[] = [];
    const res = await handlePlatformRoute(req("/v1/platform/admin/users?search=bob", "GET", "sps_ses_good"), env(calls), "req_1", "/v1/platform/admin/users");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://deploy-core.internal/v1/platform/admin/users?search=bob");
    expect(calls[0]!.headers.get("x-actor-subject-id")).toBe(USER);
    expect(calls[0]!.headers.get("x-actor-subject-type")).toBe("user");
  });

  test.each([
    ["no credentials", undefined],
    ["a session identity does not know", "sps_ses_bad"],
    // A Coolify API token (`<id>|<plain text>`), with the root ability: identity's resolve refuses every API token.
    ["a Coolify API token with the root ability", "7|abcdefghijklmnopqrstuvwxyz0123456789ABCDa1b2c3d4"],
  ])("%s: 404, the same as an unknown route, and deploy-core-worker is never asked", async (_what, token) => {
    for (const [path, method] of [
      ["/v1/platform/operator", "GET"],
      ["/v1/platform/settings", "GET"],
      ["/v1/platform/settings", "PATCH"],
      ["/v1/platform/admin", "GET"],
      ["/v1/platform/admin/users", "GET"],
    ] as const) {
      const calls: Call[] = [];
      const res = await handlePlatformRoute(req(path, method, token), env(calls), "req_1", path);
      expect([path, method, res.status]).toEqual([path, method, 404]);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
      expect(calls).toEqual([]);
    }
  });

  test("a method no platform page uses is a 404 too", async () => {
    const calls: Call[] = [];
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await handlePlatformRoute(req("/v1/platform/settings", method, "sps_ses_good"), env(calls), "req_1", "/v1/platform/settings")).status).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  test("the edge routes /v1/platform/* to the facade", async () => {
    const calls: Call[] = [];
    const res = await worker.fetch(req("/v1/platform/operator", "GET", "sps_ses_good"), env(calls));
    expect(res.status).toBe(200);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/platform/operator"]);
  });

  test("/api/v1 has no instance settings or admin route: a root token gets Coolify's 404 fallback", async () => {
    for (const path of ["/api/v1/settings", "/api/v1/settings/advanced", "/api/v1/admin", "/api/v1/instance-settings"]) {
      const res = await handleApiV1(req(path, "GET", "7|abcdefghijklmnopqrstuvwxyz0123456789ABCDa1b2c3d4"), { ...env([]), API_FAILED_REQUEST_RATE_LIMIT: "0" } as Env, "req_1");
      expect([path, res.status]).toEqual([path, 404]);
      expect(await res.text()).toBe('{"message":"Not found.","docs":"https:\\/\\/coolify.io\\/docs"}');
    }
  });
});
