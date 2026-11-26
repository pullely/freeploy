// The dashboard at / (DP-100) through its handler: Dashboard::serverStatus()'s rules in memory, then the page and the
// active and recent deployments over the API goldens' fixture in PGlite (api-v1-database.ts), each case rolled back,
// with authorization, org isolation and routing.
import type { Env } from "@deploy-core-worker/env";
import { route } from "@deploy-core-worker/router";
import { dashboardSqlStore, handleDashboard, ORG_DEPLOY_DASHBOARD_RE } from "@deploy-core-worker/handlers/dashboard";
import { dashboardServerStatus, hasCurrentTraefikOutdatedInfo } from "@deploy-core-worker/dashboard/service";
import { withOrg, type DeployDashboardServerRow } from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { fixtureDatabase, ORG_UUID, type FixtureDatabase } from "./api-v1-database.js";

const ORG_A = ORG_UUID[1]!;
const ORG_B = ORG_UUID[2]!;
const ORG_PUBLIC = "org_" + "0".repeat(31) + "a";
const actor = { subjectId: "usr_" + "0".repeat(31) + "1", subjectType: "user" };
const NOW = Date.parse("2026-11-26T12:00:00Z");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

/** A ready server: reachable, usable, its proxy running, Sentinel reporting a minute ago. */
const server = (over: Partial<DeployDashboardServerRow> = {}): DeployDashboardServerRow => ({
  id: 1, uuid: "s1", name: "main", description: null, ip: "203.0.113.10", proxy: { type: "TRAEFIK", status: "running" }, server_metadata: null,
  detected_traefik_version: null, traefik_outdated_info: null, sentinel_updated_at: "2026-11-26 11:59:00", sentinel_waiting_since: null,
  is_reachable: true, is_usable: true, force_disabled: false, is_swarm_manager: false, is_swarm_worker: false, is_build_server: false, server_role: "both",
  is_metrics_enabled: false, sentinel_push_interval_seconds: 60, ...over,
});
const status = (over: Partial<DeployDashboardServerRow>) => dashboardServerStatus(server(over), NOW);

describe("Dashboard::serverStatus()", () => {
  it("Disabled, Unavailable, Unreachable and Not ready, in that order", () => {
    expect(status({ force_disabled: true, is_reachable: false, is_usable: false })).toEqual(["Disabled", "error"]);
    expect(status({ is_reachable: false, is_usable: false })).toEqual(["Unavailable", "error"]);
    expect(status({ is_reachable: false })).toEqual(["Unreachable", "error"]);
    expect(status({ is_usable: false })).toEqual(["Not ready", "warning"]);
    expect(status({})).toEqual(["Ready", "success"]);
  });

  it("Attention required: a set proxy that is not running or has current outdated info, or Sentinel out of sync", () => {
    expect(status({ proxy: { type: "TRAEFIK", status: "exited" } })).toEqual(["Attention required", "warning"]);
    expect(status({ proxy: JSON.stringify({ type: "CADDY" }) })).toEqual(["Attention required", "warning"]);
    // proxySet(): no proxy, NONE, a Swarm worker, a build server or a placeholder address have none to check.
    expect(status({ proxy: { type: "NONE", status: "exited" } })).toEqual(["Ready", "success"]);
    expect(status({ proxy: {}, sentinel_updated_at: "2026-11-26 11:59:00" })).toEqual(["Ready", "success"]);
    expect(status({ proxy: { type: "TRAEFIK" }, ip: "1.2.3.4" })).toEqual(["Ready", "success"]);
    const outdated = { detected_traefik_version: "v3.1.2", traefik_outdated_info: { current: "3.1.2", type: "patch_update" } };
    expect(hasCurrentTraefikOutdatedInfo({ proxy: { type: "TRAEFIK" }, ...outdated })).toBe(true);
    expect(hasCurrentTraefikOutdatedInfo({ proxy: { type: "TRAEFIK" }, ...outdated, traefik_outdated_info: { current: "3.1.1", type: "patch_update" } })).toBe(false);
    expect(hasCurrentTraefikOutdatedInfo({ proxy: { type: "TRAEFIK" }, ...outdated, traefik_outdated_info: { current: "3.1.2", type: "major_upgrade" } })).toBe(false);
    expect(hasCurrentTraefikOutdatedInfo({ proxy: { type: "CADDY" }, ...outdated })).toBe(false);
    expect(status(outdated)).toEqual(["Attention required", "warning"]);
    // Sentinel: out of sync after 120 s without a push (three intervals, at least 120 s), or waiting past its first report.
    expect(status({ sentinel_updated_at: "2026-11-26 11:57:00" })).toEqual(["Attention required", "warning"]);
    expect(status({ sentinel_waiting_since: "2026-11-26 11:59:45" })).toEqual(["Ready", "success"]);
    expect(status({ sentinel_waiting_since: "2026-11-26 11:58:00" })).toEqual(["Attention required", "warning"]);
    // isSentinelEnabled(): not for a Swarm or build server, nor one transferred away.
    expect(status({ sentinel_updated_at: "2026-11-26 11:00:00", proxy: {}, is_swarm_manager: true })).toEqual(["Ready", "success"]);
    expect(status({ sentinel_updated_at: "2026-11-26 11:00:00", proxy: {}, server_role: "build" })).toEqual(["Ready", "success"]);
    expect(status({ sentinel_updated_at: "2026-11-26 11:00:00", proxy: {}, server_metadata: { transfer: { status: "transferred" } } })).toEqual(["Ready", "success"]);
  });
});

let fixture: FixtureDatabase;
beforeAll(async () => {
  fixture = await fixtureDatabase();
}, 120_000);
afterAll(async () => fixture?.pg.close());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function setup(db: TransactionalSqlExecutor, { read = true, write = true } = {}) {
  const asked: string[] = [];
  const orgs: string[] = [];
  const env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      asked.push(body.action);
      const allow = body.action === "deploy.resource.write" ? write : read;
      return json({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
  } as unknown as Env;
  const send = async (path: string, org = ORG_A, method = "GET") => {
    const segments = path.split("/").filter(Boolean);
    const res = await handleDashboard(env, "req_1", actor, org, segments, new Request(`https://x/v1/organizations/${ORG_PUBLIC}/deploy/dashboard/${path}`, { method }), (_e, o, fn) => {
      orgs.push(o);
      return withOrg(db, o, (tx) => fn(dashboardSqlStore(tx)));
    });
    return { status: res.status, body: (await res.json()) as { data?: Json; error?: Json } };
  };
  const query = (sql: string, params: unknown[] = [], org = ORG_A) => withOrg(db, org, async (tx) => (await tx.execute(sql, params)).rows as Array<Record<string, Json>>);
  return { send, asked, orgs, query };
}

const inCase = <T>(fn: (db: TransactionalSqlExecutor) => Promise<T>) => fixture.inCase(fn);

describe("GET /dashboard", () => {
  it("answers the org's projects with their counts, its servers with their status, whether it has a private key, and the actions", () =>
    inCase(async (db) => {
      const { send, asked } = setup(db);
      const r = await send("");
      expect(r.status).toBe(200);
      expect(r.body.data.projects.map((p: Json) => [p.name, p.environmentCount, p.resourceCount, p.onlyEnvironmentUuid])).toEqual([
        ["Alpha", 2, 11, null],
        ["Beta", 1, 0, "e3betaproduction00000003"],
      ]);
      expect(r.body.data.servers).toEqual([
        { uuid: "s1parityserveruuid000001", name: "parity-server", description: "The fixture server", status: expect.any(String), statusType: expect.any(String), isMetricsEnabled: expect.any(Boolean) },
      ]);
      expect(r.body.data.hasPrivateKeys).toBe(true);
      expect([r.body.data.canCreate, r.body.data.canUpdate]).toEqual([true, true]);
      expect(asked).toEqual(["deploy.resource.read", "deploy.resource.write"]);
    }));

  it("a team without a private key is asked for one; a reader gets no actions; a denied reader a 404", () =>
    inCase(async (db) => {
      const { send, query } = setup(db);
      await query("UPDATE deploy.servers SET deleted_at = '2026-01-01 00:00:00'");
      await query("DELETE FROM deploy.private_keys");
      const r = await send("");
      expect([r.body.data.servers, r.body.data.hasPrivateKeys]).toEqual([[], false]);
      expect((await setup(db, { write: false }).send("")).body.data.canCreate).toBe(false);
      expect((await setup(db, { read: false, write: false }).send("")).status).toBe(404);
      expect((await setup(db, { read: false, write: false }).send("deployments")).status).toBe(404);
    }));

  it("another org sees only its own projects and servers", () =>
    inCase(async (db) => {
      const { send, orgs } = setup(db);
      const r = await send("", ORG_B);
      expect(r.body.data.projects.map((p: Json) => p.name)).toEqual(["Other"]);
      expect(r.body.data.servers.map((s: Json) => s.name)).toEqual(["other-server"]);
      expect(orgs).toEqual([ORG_B]);
    }));
});

describe("GET /dashboard/deployments", () => {
  it("answers the queued and running deployments by status then id, and the latest others newest first, of the org's applications", () =>
    inCase(async (db) => {
      const { send } = setup(db);
      const r = await send("deployments");
      expect(r.status).toBe(200);
      expect(r.body.data.active.map((d: Json) => [d.deploymentUuid, d.status])).toEqual([
        ["q1parityinprogress000001", "in_progress"],
        ["q2parityqueued0000000002", "queued"],
      ]);
      expect(r.body.data.recent.map((d: Json) => [d.deploymentUuid, d.status])).toEqual([
        ["q5paritygitfailed0000005", "failed"],
        ["q3parityfinished00000003", "finished"],
      ]);
      expect(r.body.data.recent[1]).toMatchObject({
        applicationName: "parity-image",
        serverName: "parity-server",
        pullRequestId: 0,
        imageScanBlocked: false,
        createdAt: "2025-12-30T10:00:00+00:00",
        finishedAt: "2025-12-30T10:05:00+00:00",
        environmentPath: "Alpha / production",
      });
      const theirs = await send("deployments", ORG_B);
      expect(theirs.body.data.active.map((d: Json) => d.deploymentUuid)).toEqual(["q4otherinprogress0000004"]);
    }));

  it("keeps the deployments of a deleted application without its environment, and reads an image scan's block", () =>
    inCase(async (db) => {
      const { send, query } = setup(db);
      await query("UPDATE deploy.applications SET deleted_at = '2026-01-01 00:00:00' WHERE uuid = 'a2paritygitapp0000000002'");
      await query(`UPDATE deploy.application_deployment_queues SET scan_gate_result = '{"blocked": true}' WHERE deployment_uuid = 'q3parityfinished00000003'`);
      const r = await send("deployments");
      expect(r.body.data.recent.map((d: Json) => [d.deploymentUuid, d.environmentPath, d.imageScanBlocked])).toEqual([
        ["q5paritygitfailed0000005", "", false],
        ["q3parityfinished00000003", "Alpha / production", true],
      ]);
    }));
});

describe("routing", () => {
  it("answers 405 for another method and 404 below it; route() sends /deploy/dashboard here", () =>
    inCase(async (db) => {
      const { send, asked } = setup(db);
      expect((await send("", ORG_A, "POST")).status).toBe(405);
      expect((await send("other")).status).toBe(404);
      expect(asked).toEqual([]);
      expect(`/v1/organizations/${ORG_PUBLIC}/deploy/dashboard/deployments`).toMatch(ORG_DEPLOY_DASHBOARD_RE);
      expect(`/v1/organizations/${ORG_PUBLIC}/deploy/dashboard/a/b`).not.toMatch(ORG_DEPLOY_DASHBOARD_RE);
      const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
      // Without bindings the handler answers 503: the route exists.
      expect((await route(new Request(`https://x/v1/organizations/${ORG_PUBLIC}/deploy/dashboard`, { headers }), { ENVIRONMENT: "test" } as Env)).status).toBe(503);
    }));
});
