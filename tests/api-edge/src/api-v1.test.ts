// Coolify's /api/v1 at the edge (DP-70): its middleware, its two rate limiters and its answers, replayed
// against Coolify's real answers (tests/deploy-core-worker/fixtures/api/goldens.json, emitted by Coolify's
// PHP through its HTTP kernel; see that directory's README.md).
//
// identity-worker is faked from the fixture's tokens with the statuses its resolve gives (held to the same
// fixture by tests/identity-worker/src/api-tokens.test.ts); a worker behind the edge answers with the
// golden's own body, so a case the edge forwards checks what the edge adds (status, headers) and a case the
// edge answers itself checks every byte.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleApiV1, isApiV1Route } from "@api-edge/api-v1/index";
import { failedRecordStep, memoryLimiterStore, throttleStep, type FailedState, type WindowState } from "@api-edge/api-v1/limiters";
import { checkIpAgainstAllowlist, ipAllowed } from "@api-edge/api-v1/ip-allowlist";
import { API_V1_ROUTES, matchApiRoute } from "@api-edge/api-v1/routes";
import { RateLimiterDO } from "@api-edge/rate-limit-do";
import type { Env } from "@api-edge/env";
import edge from "@api-edge/index";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../deploy-core-worker/fixtures/api");
interface Step { token?: string; authorization?: string; method: string; path: string; body?: unknown; raw?: string; contentType?: string; ip?: string; advance?: number }
interface Case extends Step { name: string; instance?: { is_api_enabled?: boolean; allowed_ips?: string }; config?: { rate_limit?: number; failed_request_rate_limit?: number }; sequence?: Step[] }
interface Answer { status: number; headers: Record<string, string>; body: { json?: string; text?: string } }
interface Golden extends Answer { name: string; steps?: Answer[] }
interface Token { key: string; id: number; user: number; team: number; abilities: string[]; secret: string; expires_at?: string }
const CASES = JSON.parse(readFileSync(resolve(FIXTURES, "cases.json"), "utf8")) as { fixture: { tokens: Token[]; users: Array<{ id: number; teams: Array<{ team: number; role: string }> }> }; cases: Case[] };
const GOLDENS = JSON.parse(readFileSync(resolve(FIXTURES, "goldens.json"), "utf8")) as { cases: Golden[] };
const golden = (name: string) => GOLDENS.cases.find((c) => c.name === name)!;
const ORG = "org_" + "0".repeat(31) + "1";
const START = 1767225600; // 2026-01-01T00:00:00Z, the goldens' clock

/** identity-worker's /v1/internal/api-tokens/resolve for the fixture's tokens. */
function resolveFixtureToken(authorization: string | null) {
  const at = authorization?.lastIndexOf("Bearer ") ?? -1;
  if (!authorization || at === -1) return { status: "unauthenticated" };
  const token = authorization.slice(at + 7);
  const [id, secret] = token.includes("|") ? token.split("|", 2) : [null, token];
  const t = CASES.fixture.tokens.find((x) => x.secret === secret && (id === null || String(x.id) === id));
  if (!t || (t.expires_at && Date.parse(`${t.expires_at}Z`) <= START * 1000)) return { status: "unauthenticated" };
  const role = CASES.fixture.users.find((u) => u.id === t.user)!.teams.find((m) => m.team === t.team)?.role;
  const userId = `usr_${String(t.user).padStart(32, "0")}`;
  if (!role) return { status: "invalid_token", userId };
  const admin = role === "owner" || role === "admin";
  if (!admin && t.abilities.some((a) => a !== "read")) return { status: "exceeds_access", userId };
  return { status: "ok", tokenNumber: t.id, orgId: ORG, userId, abilities: t.abilities, canReadSensitive: admin && (t.abilities.includes("root") || t.abilities.includes("read:sensitive")) };
}

function fetcher(handler: (req: Request) => Response | Promise<Response>): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

function harness(c: Case) {
  let downstream: Answer | null = null;
  const forwarded: Request[] = [];
  const workerAnswer = (req: Request) => {
    forwarded.push(req);
    if (!downstream) return new Response("no answer", { status: 599 });
    // A worker's own Retry-After (DP-90: a cloud provider's rate limit, as Hostinger's controller answers it) passes through the edge.
    const retryAfter = downstream.status === 429 && downstream.headers["retry-after"] !== undefined ? { "retry-after": downstream.headers["retry-after"] } : {};
    return new Response(downstream.body.json ?? downstream.body.text ?? "", { status: downstream.status, headers: { "content-type": downstream.headers["content-type"] ?? "application/json", ...retryAfter } });
  };
  const env = {
    ENVIRONMENT: "test",
    IDENTITY_WORKER: fetcher((req) => (new URL(req.url).pathname === "/v1/internal/api-tokens/resolve" ? Response.json({ data: resolveFixtureToken(req.headers.get("authorization")) }) : workerAnswer(req))),
    DEPLOY_CORE_WORKER: fetcher(workerAnswer),
    ...(c.config?.rate_limit !== undefined && { API_RATE_LIMIT: String(c.config.rate_limit) }),
    ...(c.config?.failed_request_rate_limit !== undefined && { API_FAILED_REQUEST_RATE_LIMIT: String(c.config.failed_request_rate_limit) }),
    ...(c.instance?.is_api_enabled === false && { API_ENABLED: "false" }),
    ...(c.instance?.allowed_ips && { API_ALLOWED_IPS: c.instance.allowed_ips }),
  } as Env;
  const limiter = memoryLimiterStore();
  let now = START;
  return {
    forwarded,
    async send(step: Step, answer: Answer): Promise<Response> {
      if (step.advance) now += step.advance;
      downstream = answer;
      const headers = new Headers({ accept: "application/json", "cf-connecting-ip": step.ip ?? "203.0.113.50" });
      const token = step.token ? CASES.fixture.tokens.find((t) => t.key === step.token) : null;
      if (token) headers.set("authorization", `Bearer ${token.id}|${token.secret}`);
      if (step.authorization) headers.set("authorization", step.authorization);
      let body: string | undefined;
      if (step.raw !== undefined) {
        body = step.raw;
        headers.set("content-type", step.contentType ?? "application/json");
      } else if (step.body !== undefined) {
        body = JSON.stringify(step.body);
        headers.set("content-type", "application/json");
      }
      return handleApiV1(new Request(`https://api.freeploy.dev${step.path}`, { method: step.method, headers, ...(body !== undefined && { body }) }), env, "req_test", { limiter, now: () => now });
    },
  };
}

const HEADERS = ["content-type", "x-ratelimit-limit", "x-ratelimit-remaining", "retry-after", "x-ratelimit-reset"];
async function observed(res: Response) {
  const headers: Record<string, string> = {};
  for (const h of HEADERS) {
    const v = res.headers.get(h);
    if (v !== null) headers[h] = v;
  }
  return { status: res.status, headers, body: await res.text() };
}
const expected = (g: Answer) => ({ status: g.status, headers: g.headers, body: g.body.json ?? g.body.text ?? "" });

/** The cases about the middleware, the limiters, health and version: the edge's own answers. */
const EDGE_CASES = CASES.cases.filter((c) => /^(auth|ability|allowed|route|health|version|rate limit|failed requests)\b/.test(c.name));
/** Every other case the edge forwards; its answer here is the golden's, so status and headers are the edge's to get right. */
const FORWARDED_CASES = CASES.cases.filter((c) => !EDGE_CASES.includes(c) && !c.sequence);

describe("Coolify's /api/v1 at the edge, replayed against Coolify's answers", () => {
  it("has the goldens of every middleware scenario, the two limiters included", () => {
    expect(EDGE_CASES.length).toBeGreaterThanOrEqual(25);
    expect(EDGE_CASES.filter((c) => c.sequence).map((c) => c.name)).toEqual([
      "rate limit: API_RATE_LIMIT reached",
      "failed requests: blocked after the limit",
      "failed requests: per token, and a 404 with a token does not count",
    ]);
  });

  it.each(EDGE_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const g = golden(name);
    const h = harness(c);
    if (c.sequence) {
      const got = [];
      for (const [i, step] of c.sequence.entries()) got.push(await observed(await h.send(step, g.steps![i]!)));
      expect(got).toEqual(g.steps!.map(expected));
    } else {
      expect(await observed(await h.send(c, g))).toEqual(expected(g));
    }
  });

  it.each(FORWARDED_CASES.map((c) => [c.name, c] as const))("forwards %s with Coolify's status and headers", async (name, c) => {
    const g = golden(name);
    const h = harness(c);
    // A server's resources and domains and ?resources, DP-70's not-ported operations, are ported by DP-78.
    const res = await h.send(c, g);
    expect(await observed(res)).toEqual(expected(g));
  });
});

describe("what the edge sends a worker", () => {
  it("forwards the token's user, org, abilities and sensitivity, and the body as it came", async () => {
    const c = CASES.cases.find((x) => x.name === "projects: create")!;
    const h = harness(c);
    await h.send(c, golden(c.name));
    const req = h.forwarded[0]!;
    expect(new URL(req.url).pathname).toBe(`/v1/internal/api-v1/${ORG}/projects`);
    expect(req.headers.get("x-api-v1-abilities")).toBe("read,write");
    expect(req.headers.get("x-api-v1-can-read-sensitive")).toBe("0");
    expect(req.headers.get("x-actor-subject-type")).toBe("user");
    expect(await req.text()).toBe(JSON.stringify(c.body));
  });

  it("sends teams to identity-worker", async () => {
    const c = CASES.cases.find((x) => x.name === "teams: members")!;
    const h = harness(c);
    await h.send(c, golden(c.name));
    expect(new URL(h.forwarded[0]!.url).pathname).toBe("/v1/internal/api-v1/team/members");
  });

  it("is mounted on the edge for /api/ and never for Freeploy's routes", async () => {
    expect(isApiV1Route("/api/v1/projects")).toBe(true);
    expect(isApiV1Route("/v1/organizations")).toBe(false);
    const res = await edge.fetch(new Request("https://api.freeploy.dev/api/v1/health"), { ENVIRONMENT: "test" } as Env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });
});

describe("the routes", () => {
  it("are the 274 ported operations of openapi.json (health, the deprecated team aliases and the GET answers of start, restart and stop aside)", () => {
    const openapi = JSON.parse(readFileSync(resolve(FIXTURES, "../../../../specs/epics/freeploy-coolify-parity/parity/openapi.operations.json"), "utf8")) as { rows: Array<{ method: string; path: string }> };
    const ops = new Set(openapi.rows.map((r) => `${r.method} ${r.path}`));
    const routes = API_V1_ROUTES.map((r) => `${r.method} /api/v1${r.path}`);
    const inOpenapi = routes.filter((r) => ops.has(r));
    expect(routes.filter((r) => !ops.has(r))).toEqual([
      "GET /api/v1/teams/current",
      "GET /api/v1/teams/current/members",
      // OtherController::post_required (DP-71)
      "GET /api/v1/applications/{uuid}/start",
      "GET /api/v1/applications/{uuid}/restart",
      "GET /api/v1/applications/{uuid}/stop",
      // DP-73
      "GET /api/v1/databases/{uuid}/start",
      "GET /api/v1/databases/{uuid}/restart",
      "GET /api/v1/databases/{uuid}/stop",
      // DP-74
      "GET /api/v1/deploy",
      // DP-85: a service application's
      "GET /api/v1/services/{uuid}/applications/{app_uuid}/start",
      "GET /api/v1/services/{uuid}/applications/{app_uuid}/restart",
      "GET /api/v1/services/{uuid}/applications/{app_uuid}/stop",
      "GET /api/v1/services/{uuid}/start",
      "GET /api/v1/services/{uuid}/restart",
      "GET /api/v1/services/{uuid}/stop",
    ]);
    expect(inOpenapi.length + 1 /* GET /api/v1/health */).toBe(274);
  });

  it("take the first match in routes/api.php's order and ignore a trailing slash", () => {
    expect(matchApiRoute("GET", "/projects/")?.path).toBe("/projects");
    expect(matchApiRoute("GET", "/teams/current")?.path).toBe("/teams/current");
    expect(matchApiRoute("PUT", "/projects")).toBeNull();
    expect(matchApiRoute("GET", "/applications")?.path).toBe("/applications");
    expect(matchApiRoute("PATCH", "/applications/a1/envs/bulk")?.path).toBe("/applications/{uuid}/envs/bulk");
    expect(matchApiRoute("POST", "/databases/postgresql")?.path).toBe("/databases/postgresql");
    expect(matchApiRoute("GET", "/databases/postgresql")?.path).toBe("/databases/{uuid}");
    expect(matchApiRoute("POST", "/databases/sqlite")).toBeNull();
    expect(matchApiRoute("GET", "/databases/b1/backups/c1/executions")?.path).toBe("/databases/{uuid}/backups/{scheduled_backup_uuid}/executions");
    expect(matchApiRoute("GET", "/services")?.path).toBe("/services");
    expect(matchApiRoute("PATCH", "/services/s1/envs/bulk")?.path).toBe("/services/{uuid}/envs/bulk");
    expect(matchApiRoute("GET", "/services/s1/start")?.abilities).toEqual(["deploy"]);
    // DP-84
    expect(matchApiRoute("GET", "/services/s1/storages")?.path).toBe("/services/{uuid}/storages");
    expect(matchApiRoute("DELETE", "/databases/b1/storages/l1")?.abilities).toEqual(["delete"]);
    expect(matchApiRoute("PATCH", "/databases/b1/envs/bulk")?.path).toBe("/databases/{uuid}/envs/bulk");
    expect(matchApiRoute("GET", "/applications/a1/scheduled-tasks/n1/executions")?.path).toBe("/applications/{uuid}/scheduled-tasks/{task_uuid}/executions");
    // DP-88: executing a task, a storage's backup schedule, an import's status (->whereNumber('activity_id')).
    expect(matchApiRoute("POST", "/services/s1/scheduled-tasks/n1/execute")?.path).toBe("/services/{uuid}/scheduled-tasks/{task_uuid}/execute");
    expect(matchApiRoute("PUT", "/applications/a1/storages/l1/backups")?.abilities).toEqual(["write"]);
    expect(matchApiRoute("POST", "/databases/b1/storages/l1/backups/run")?.alsoAbilities).toEqual(["deploy"]);
    expect(matchApiRoute("GET", "/databases/b1/imports/12")?.path).toBe("/databases/{uuid}/imports/{activity_id}");
    expect(matchApiRoute("GET", "/databases/b1/imports/abc")).toBeNull();
    expect(matchApiRoute("GET", "/servers/s1/transfer")?.abilities).toEqual(["read", "write"]);
    expect(matchApiRoute("GET", "/servers/import/check")?.path).toBe("/servers/import/check");
    // DP-90: a server's proxy configuration; the cloud provider tokens and the providers' catalogs.
    expect(matchApiRoute("PUT", "/servers/s1/proxy/configuration")?.abilities).toEqual(["write"]);
    expect(matchApiRoute("POST", "/cloud-tokens/c1/validate")?.path).toBe("/cloud-tokens/{uuid}/validate");
    expect(matchApiRoute("GET", "/hetzner/server-types")?.target).toBe("deploy");
    expect(matchApiRoute("GET", "/hetzner/volumes")).toBeNull();
    expect(matchApiRoute("POST", "/servers/s1/transfer/complete")).toBeNull();
    expect(matchApiRoute("PATCH", "/team/envs/10")?.target).toBe("deploy");
    expect(matchApiRoute("PATCH", "/team")).toBeNull();
    expect(matchApiRoute("GET", "/deployments/applications/a1")?.path).toBe("/deployments/applications/{uuid}");
    // DP-78
    expect(matchApiRoute("GET", "/deployments/q1")?.path).toBe("/deployments/{uuid}");
    expect(matchApiRoute("GET", "/deployments")?.path).toBe("/deployments");
    expect(matchApiRoute("GET", "/projects/p1/environments")?.path).toBe("/projects/{uuid}/environments");
    expect(matchApiRoute("GET", "/projects/p1/production")?.path).toBe("/projects/{uuid}/{environment_name_or_uuid}");
    // DP-81: the shared variables' routes come before /projects/{uuid}/{environment_name_or_uuid}
    expect(matchApiRoute("GET", "/projects/p1/envs")?.path).toBe("/projects/{uuid}/envs");
    expect(matchApiRoute("PATCH", "/projects/p1/environments/production/envs/5")?.path).toBe("/projects/{uuid}/environments/{environment_name_or_uuid}/envs/{env_id}");
    expect(matchApiRoute("DELETE", "/applications/a1/tags/t1")?.abilities).toEqual(["delete"]);
    expect(matchApiRoute("POST", "/s3-storages/s1/validate")?.abilities).toEqual(["write"]);
    expect(matchApiRoute("GET", "/tags/t1")).toBeNull();
    expect(matchApiRoute("GET", "/servers/s1/resources")?.path).toBe("/servers/{uuid}/resources");
    expect(matchApiRoute("DELETE", "/servers/s1")?.abilities).toEqual(["delete"]);
    expect(matchApiRoute("PATCH", "/servers/s1")).toBeNull();
  });
});

describe("the limiters", () => {
  it("throttle: a fixed 60-second window from the first hit", () => {
    let s: WindowState | null = null;
    const d1 = throttleStep(s, 2, 100);
    s = d1.state;
    const d2 = throttleStep(s, 2, 130);
    s = d2.state;
    const d3 = throttleStep(s, 2, 159);
    expect([d1.allowed, d2.allowed, d3.allowed]).toEqual([true, true, false]);
    expect(d3).toMatchObject({ retryAfter: 1, resetAt: 160 });
    expect(throttleStep(d3.state, 2, 160).allowed).toBe(true);
  });

  it("failed requests: blocks for 1, 5, then 15 minutes, and forgets the strikes after an hour", () => {
    let s: FailedState | null = null;
    const strike = (now: number) => {
      const r = failedRecordStep(s, 1, now);
      s = r.state;
      return r.state.blockedUntil - now;
    };
    expect([strike(0), strike(100), strike(1000), strike(2000)]).toEqual([60, 300, 900, 900]);
    expect(strike(2000 + 3601)).toBe(60);
  });

  it("run atomically per key in RateLimiterDO", async () => {
    const dobj = new RateLimiterDO({} as DurableObjectState, {});
    const call = async (body: unknown) => (await dobj.fetch(new Request("https://x/", { method: "POST", body: JSON.stringify(body) }))).json() as Promise<Record<string, unknown>>;
    expect(await call({ kind: "coolify-throttle", limit: 1, now: 10 })).toMatchObject({ allowed: true, remaining: 0 });
    expect(await call({ kind: "coolify-throttle", limit: 1, now: 11 })).toMatchObject({ allowed: false, retryAfter: 59 });
    expect(await call({ kind: "coolify-failed-record", limit: 1, now: 11 })).toEqual({ blocked: true });
    expect(await call({ kind: "coolify-failed-check", now: 12 })).toEqual({ retryAfter: 59 });
    // The token-bucket messages are unchanged.
    expect(await call({ limit: 5, windowSec: 60, scope: "org" })).toMatchObject({ allowed: true });
  });
});

describe("the IP allow list (checkIPAgainstAllowlist)", () => {
  it("matches CIDRs, exact addresses and both forms of an IPv6 address", () => {
    expect(checkIpAgainstAllowlist("198.51.100.23", ["198.51.100.0/24"])).toBe(true);
    expect(checkIpAgainstAllowlist("198.51.101.23", ["198.51.100.0/24"])).toBe(false);
    expect(checkIpAgainstAllowlist("2001:db8::1", ["2001:db8:0:0::/64"])).toBe(true);
    expect(checkIpAgainstAllowlist("2001:db8:0:0:0:0:0:1", ["2001:db8::1"])).toBe(true);
    expect(checkIpAgainstAllowlist("10.0.0.1", ["0.0.0.0/8"])).toBe(true);
    expect(ipAllowed("10.0.0.1", " ")).toBe(true);
    expect(ipAllowed("10.0.0.1", "0.0.0.0")).toBe(true);
    expect(ipAllowed("10.0.0.1", "192.0.2.1, ")).toBe(false);
  });
});
