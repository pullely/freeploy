// deploy-core-worker: routing, authentication and deny-by-default (DP2).
// The database confinement itself is proven against a real Postgres in
// tests/db (deploy-isolation and deploy-with-org).
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";

const ORG = "org_" + "0".repeat(31) + "a";

function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function env(over: Partial<Env> = {}): Env {
  return { ENVIRONMENT: "test", ...over };
}
const actor = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };

describe("deploy-core-worker", () => {
  it("answers health with its bindings", async () => {
    const res = await route(new Request("https://x/health"), env({ PLATFORM_DB: {} as Hyperdrive }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { service: string; checks: { database: { configured: boolean } } } };
    expect(body.data.service).toBe("deploy-core-worker");
    expect(body.data.checks.database.configured).toBe(true);
  });

  it("404s an unknown path", async () => {
    expect((await route(new Request("https://x/v1/nope"), env())).status).toBe(404);
  });

  it("405s a non-GET on the projects list", async () => {
    const res = await route(new Request(`https://x/v1/organizations/${ORG}/deploy/projects`, { method: "DELETE", headers: actor }), env());
    expect(res.status).toBe(405);
  });

  it("401s without an actor", async () => {
    expect((await route(new Request(`https://x/v1/organizations/${ORG}/deploy/projects`), env())).status).toBe(401);
  });

  it("404s an org id that does not parse", async () => {
    expect((await route(new Request("https://x/v1/organizations/not-an-org/deploy/projects", { headers: actor }), env())).status).toBe(404);
  });

  it("503s when its bindings are missing", async () => {
    expect((await route(new Request(`https://x/v1/organizations/${ORG}/deploy/projects`, { headers: actor }), env())).status).toBe(503);
  });

  it("404s (never leaks) when the caller has no membership in the org", async () => {
    const res = await route(
      new Request(`https://x/v1/organizations/${ORG}/deploy/projects`, { headers: actor }),
      env({
        PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
        MEMBERSHIP_WORKER: fetcher(() => json({ error: { code: "not_found" } }, 404)),
        POLICY_WORKER: fetcher(() => json({ data: { decision: "allow" } })),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("404s when policy denies deploy.resource.read, and asks for exactly that action", async () => {
    let asked = "";
    const res = await route(
      new Request(`https://x/v1/organizations/${ORG}/deploy/projects`, { headers: actor }),
      env({
        PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
        MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
        POLICY_WORKER: fetcher(async (req) => {
          asked = JSON.stringify(await req.json());
          return json({ data: { decision: "deny", allow: false } });
        }),
      }),
    );
    expect(res.status).toBe(404);
    expect(asked).toContain("deploy.resource.read");
  });
});
