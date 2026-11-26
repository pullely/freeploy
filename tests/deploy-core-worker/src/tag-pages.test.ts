// The team's Tags page through its handler (DP-97): the list with its counts, a tag's webhook, resources and
// active deployments, CreatesTags::createTag()'s rules and messages, Delete, Redeploy all (501 once the tag has
// resources), authorization, org isolation and routing. The store is in memory; the SQL is tested in tests/db.
import type { Env } from "@deploy-core-worker/env";
import { route } from "@deploy-core-worker/router";
import { handleTagPages, ORG_DEPLOY_TAGS_RE, type TagPagesRunner } from "@deploy-core-worker/handlers/tag-pages";
import type { TagPagesStore } from "@deploy-core-worker/tags/page";
import type { DeployActiveDeploymentRow, DeployTagCountRow, DeployTaggedResourceRow } from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const OTHER_UUID = "00000000-0000-0000-0000-00000000000b";
const BASE = `https://x/v1/organizations/${ORG}/deploy`;
const actor = { subjectId: "usr_1", subjectType: "user" };
type Body = Record<string, unknown>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

const resource = (id: number, name: string, description: string | null = null): DeployTaggedResourceRow => ({
  id, uuid: `${name}-uuid`, name, description, environment_uuid: "env1", environment_name: "production", project_uuid: "prj1", project_name: "Shop",
});

/** Each org's tags, the resources that carry them and the deployment queue, in memory. */
class World {
  tags = new Map<string, DeployTagCountRow[]>([
    [ORG_UUID, [
      { id: 2, uuid: "t2", name: "web", applications_count: 1, services_count: 1 },
      { id: 1, uuid: "t1", name: "api", applications_count: 0, services_count: 0 },
      { id: 3, uuid: "t3", name: "Zeta", applications_count: 0, services_count: 0 },
    ]],
    [OTHER_UUID, [{ id: 9, uuid: "t9", name: "secret", applications_count: 1, services_count: 0 }]],
  ]);
  applications = new Map<string, DeployTaggedResourceRow[]>([["2", [resource(11, "shop", "Storefront")]], ["9", [resource(99, "hidden")]]]);
  services = new Map<string, DeployTaggedResourceRow[]>([["2", [resource(21, "umami")]]]);
  queue: Array<DeployActiveDeploymentRow & { org: string }> = [
    { org: ORG_UUID, id: 5, application_id: "11", application_name: "shop", deployment_url: "/project/prj1/environment/env1/application/shop-uuid/deployment/d5", pull_request_id: 0, server_name: "main", server_id: 1, status: "in_progress" },
    { org: ORG_UUID, id: 4, application_id: "11", application_name: "shop", deployment_url: null, pull_request_id: 0, server_name: "main", server_id: 1, status: "queued" },
  ];
  deleted: string[] = [];
  store(org: string): TagPagesStore {
    const mine = () => this.tags.get(org) ?? [];
    return {
      tags: async () => mine().map((t) => ({ ...t })),
      applications: async (tagId) => (mine().some((t) => String(t.id) === String(tagId)) ? (this.applications.get(String(tagId)) ?? []) : []),
      services: async (tagId) => (mine().some((t) => String(t.id) === String(tagId)) ? (this.services.get(String(tagId)) ?? []) : []),
      deployments: async (ids) => this.queue.filter((d) => d.org === org && ids.map(String).includes(d.application_id)).sort((a, b) => Number(a.id) - Number(b.id)),
      findByName: async (name) => mine().find((t) => t.name === name) ?? null,
      insert: async (tag) => {
        const row = { id: 100 + mine().length, uuid: tag.uuid, name: tag.name, applications_count: 0, services_count: 0 };
        this.tags.set(org, [...mine(), row]);
        return row;
      },
      delete: async (id) => {
        this.deleted.push(String(id));
        this.tags.set(org, mine().filter((t) => String(t.id) !== String(id)));
      },
    };
  }
}

function setup(opts: { write?: boolean; read?: boolean } = {}) {
  const world = new World();
  const asked: string[] = [];
  const orgs: string[] = [];
  const env: Env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      asked.push(body.action);
      const allow = body.action === "deploy.resource.write" ? (opts.write ?? true) : (opts.read ?? true);
      return json({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
  };
  const runner: TagPagesRunner = async (_env, orgId, fn) => {
    orgs.push(orgId);
    return fn(world.store(orgId));
  };
  const call = async (method: string, path: string, body?: unknown, org = ORG_UUID) => {
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
    const res = await handleTagPages(env, "req_1", actor, org, segments, new Request(`${BASE}/tags/${path}`, init), runner);
    return { status: res.status, body: (await res.json()) as Body };
  };
  return { world, asked, orgs, env, call };
}

const data = <T = Body>(r: { body: Body }) => r.body.data as T;
const error = (r: { body: Body }) => r.body.error as { code: string; message: string; details?: Body };

describe("the Tags list", () => {
  it("answers the org's tags sorted by name (byte order) with their counts, and whether the reader may create", async () => {
    const { call } = setup();
    const r = await call("GET", "");
    expect(r.status).toBe(200);
    expect(data<{ tags: Body[] }>(r).tags).toEqual([
      { id: "3", name: "Zeta", applicationsCount: 0, servicesCount: 0, resourceCount: 0 },
      { id: "1", name: "api", applicationsCount: 0, servicesCount: 0, resourceCount: 0 },
      { id: "2", name: "web", applicationsCount: 1, servicesCount: 1, resourceCount: 2 },
    ]);
    expect(data<Body>(r).canCreate).toBe(true);
    expect(data<Body>(await setup({ write: false }).call("GET", "")).canCreate).toBe(false);
  });
});

describe("a tag", () => {
  it("answers its webhook, its applications and services with their links, and its active deployments in id order", async () => {
    const { call } = setup();
    const r = await call("GET", "web");
    expect(r.status).toBe(200);
    expect(data<Body>(r)).toMatchObject({
      tag: { id: "2", name: "web" },
      webhookPath: "/api/v1/deploy?tag=web",
      applications: [{ uuid: "shop-uuid", name: "shop", description: "Storefront", projectName: "Shop", environmentName: "production", link: "/project/prj1/environment/env1/application/shop-uuid" }],
      services: [{ uuid: "umami-uuid", name: "umami", description: null, link: "/project/prj1/environment/env1/service/umami-uuid" }],
      canDelete: true,
    });
    expect((data<{ deployments: Body[] }>(r).deployments).map((d) => [d.id, d.status])).toEqual([["4", "queued"], ["5", "in_progress"]]);
  });

  it("is a 404 for a name the org has no tag of, matched exactly; another org's tag is not seen", async () => {
    const { call } = setup();
    expect((await call("GET", "WEB")).status).toBe(404);
    expect((await call("GET", "secret")).status).toBe(404);
    expect((await call("DELETE", "secret")).status).toBe(404);
  });

  it("Delete removes the tag; Redeploy all toasts Coolify's success for a tag without resources and needs the SSH executor otherwise", async () => {
    const { call, world } = setup();
    expect(data<Body>(await call("POST", "api/redeploy"))).toEqual({ message: "Mass deployment started." });
    const busy = await call("POST", "web/redeploy");
    expect([busy.status, error(busy).message]).toEqual([501, "Deploying the resources with this tag needs the SSH executor, which is not available yet."]);
    expect(data<Body>(await call("DELETE", "api"))).toEqual({ deleted: true });
    expect(world.deleted).toEqual(["1"]);
    expect((await call("GET", "api")).status).toBe(404);
  });
});

describe("New tag (CreatesTags::createTag)", () => {
  it("refuses what its rules refuse, with Laravel's messages and its own regex message", async () => {
    const { call, world } = setup();
    const cases: Array<[unknown, string[]]> = [
      ["", ["The new tag name field is required."]],
      ["   ", ["The new tag name field is required."]],
      [undefined, ["The new tag name field is required."]],
      [5, ["The new tag name field must be a string."]],
      ["a", ["The new tag name field must be at least 2 characters."]],
      ["a b", ["A tag name cannot contain spaces."]],
      ["x".repeat(256), ["The new tag name field must not be greater than 255 characters."]],
      ["<b>x</b>", ["The tag name must be at least 2 characters after sanitization."]],
      ["API", ["A tag with this name already exists."]],
    ];
    for (const [newTagName, messages] of cases) {
      const r = await call("POST", "", newTagName === undefined ? {} : { newTagName });
      expect([newTagName, r.status, error(r).details?.fields]).toEqual([newTagName, 422, { newTagName: messages }]);
    }
    expect(world.tags.get(ORG_UUID)).toHaveLength(3);
  });

  it("stores the name stripped of tags and lower-cased, and answers it for the redirect", async () => {
    const { call, world } = setup();
    const r = await call("POST", "", { newTagName: "<i>Staging</i>" });
    expect([r.status, data<Body>(r)]).toEqual([201, { name: "staging" }]);
    expect(world.tags.get(ORG_UUID)!.map((t) => t.name)).toContain("staging");
  });
});

describe("authorization and routing", () => {
  it("reads ask deploy.resource.read, writes deploy.resource.write; a denial is a 404 and changes nothing", async () => {
    const reader = setup({ write: false });
    expect((await reader.call("POST", "", { newTagName: "new" })).status).toBe(404);
    expect((await reader.call("DELETE", "web")).status).toBe(404);
    expect((await reader.call("POST", "web/redeploy")).status).toBe(404);
    expect(reader.world.deleted).toEqual([]);
    const denied = setup({ read: false, write: false });
    expect((await denied.call("GET", "")).status).toBe(404);
    expect((await denied.call("GET", "web")).status).toBe(404);
    const t = setup();
    await t.call("GET", "web");
    expect(t.asked[0]).toBe("deploy.resource.read");
    expect(t.orgs.every((o) => o === ORG_UUID)).toBe(true);
  });

  it("answers 405 for a method a route does not have and 404 below it", async () => {
    const { call, asked } = setup();
    expect((await call("PUT", "")).status).toBe(405);
    expect((await call("PATCH", "web", {})).status).toBe(405);
    expect((await call("GET", "web/redeploy")).status).toBe(405);
    expect((await call("GET", "web/other")).status).toBe(404);
    expect(asked).toEqual([]);
  });

  it("route() sends /deploy/tags here with each segment decoded", async () => {
    expect(`/v1/organizations/${ORG}/deploy/tags`).toMatch(ORG_DEPLOY_TAGS_RE);
    expect(`/v1/organizations/${ORG}/deploy/tags/web/redeploy`).toMatch(ORG_DEPLOY_TAGS_RE);
    expect(`/v1/organizations/${ORG}/deploy/tags/a/b/c`).not.toMatch(ORG_DEPLOY_TAGS_RE);
    const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
    const { env } = setup({ read: false, write: false });
    expect((await route(new Request(`${BASE}/tags/web`, { headers }), env)).status).toBe(404);
    expect((await route(new Request(`${BASE}/tags/%E0%A4%A`, { headers }), env)).status).toBe(404);
    // Without bindings the handler answers 503: the route exists.
    expect((await route(new Request(`${BASE}/tags`, { headers }), { ENVIRONMENT: "test" })).status).toBe(503);
  });
});
