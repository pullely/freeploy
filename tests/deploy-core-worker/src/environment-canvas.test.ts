// The environment canvas's graph (DP-91): EnvironmentCanvas::graph() over
// Freeploy's rows — server zones, application, service and database cards, their
// statuses, subtitles, URLs, links and logos — and the read endpoint's routing
// and authorization. The SQL behind listEnvironmentServiceCanvasRows is a
// sibling of listEnvironmentServiceResources (tests/db).
import type { Env } from "@deploy-core-worker/env";
import { route } from "@deploy-core-worker/router";
import { handleEnvironmentResources, type ApplicationRunner } from "@deploy-core-worker/handlers/applications";
import { canvasGraph, splitUrls } from "@deploy-core-worker/applications/canvas";
import type { ApplicationStore } from "@deploy-core-worker/applications/service";
import type { DeployApplicationRow, DeployDatabaseRow, DeployEnvironmentServiceCanvasRow } from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const PROJECT = "abc123def456ghi789jkl012";
const ENVIRONMENT = "mno345pqr678stu901vwx234";
const HERE = `/project/${PROJECT}/environment/${ENVIRONMENT}`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

const server = { server_uuid: "srv-a", server_name: "server-a", server_ip: "10.0.0.1", server_is_reachable: true, server_is_usable: true };
const app = (over: Partial<DeployApplicationRow>) =>
  ({ id: 1, uuid: "app1", name: "web", status: "running:healthy", fqdn: "https://a.example.com, https://b.example.com,https://a.example.com", build_pack: "nixpacks", git_branch: "main", docker_registry_image_name: null, docker_registry_image_tag: null, ...server, ...over }) as unknown as DeployApplicationRow;
const database = (over: Partial<DeployDatabaseRow>) =>
  ({ id: 1, uuid: "db1", name: "pg", status: "exited:unhealthy", engine: "postgresql", image: "postgres:17-alpine", ...server, ...over }) as unknown as DeployDatabaseRow;
const service = (over: Partial<DeployEnvironmentServiceCanvasRow>): DeployEnvironmentServiceCanvasRow => ({
  uuid: "svc1",
  name: "umami",
  ...server,
  server_uuid: "srv-b",
  server_name: "server-b",
  server_is_reachable: false,
  server_is_usable: false,
  parts: [
    { name: "umami", kind: "application", status: "running:healthy", fqdn: "https://umami.example.com", exclude_from_status: false, is_removed_from_compose: false },
    { name: "postgresql", kind: "database", status: "running:healthy", fqdn: null, exclude_from_status: false, is_removed_from_compose: false },
  ],
  ...over,
});

describe("canvasGraph (EnvironmentCanvas::graph)", () => {
  it("draws one zone per server, in the order the cards name them, and the cards in loadResources() order", () => {
    const g = canvasGraph(HERE, [app({}), app({ uuid: "app2", name: "api", server_uuid: null, server_name: null })], [service({})], [database({ uuid: "db2", name: "cache", engine: "redis", image: "redis:7.2" }), database({})]);
    expect(g.zones).toEqual([
      { id: "srv-a", name: "server-a", ip: null, is_reachable: true, is_usable: true, link: "/server/srv-a" },
      { id: "srv-b", name: "server-b", ip: null, is_reachable: false, is_usable: false, link: "/server/srv-b" },
    ]);
    // Applications, then services, then databases engine by engine (PostgreSQL before Redis).
    expect(g.nodes.map((n) => [n.id, n.type, n.zone])).toEqual([
      ["app1", "application", "srv-a"],
      ["app2", "application", null],
      ["svc1", "service", "srv-b"],
      ["db1", "database", "srv-a"],
      ["db2", "database", "srv-a"],
    ]);
  });

  it("an application card: build pack and branch, its domains, its page and its build logo", () => {
    const [node] = canvasGraph(HERE, [app({})], [], []).nodes;
    expect(node).toMatchObject({
      name: "web",
      status: "running:healthy",
      urls: ["https://a.example.com", "https://b.example.com"],
      kind: "nixpacks",
      subtitle: "Nixpacks · main",
      children: [],
      link: `${HERE}/application/app1`,
      logo: { src: "/svgs/resources/public-repo.svg", dark: null, padded: false, favicon: null },
    });
    const [image] = canvasGraph(HERE, [app({ build_pack: "dockerimage", docker_registry_image_name: "nginx", docker_registry_image_tag: "alpine", fqdn: null })], [], []).nodes;
    expect(image).toMatchObject({ subtitle: "Docker Image · nginx:alpine", urls: [], logo: { src: "/svgs/resources/docker-image.svg" } });
  });

  it("a service card: its containers as children, their domains, and the status of its parts", () => {
    const [node] = canvasGraph(HERE, [], [service({})], []).nodes;
    expect(node).toMatchObject({
      status: "running:healthy",
      subtitle: "Service · 2 containers",
      urls: ["https://umami.example.com"],
      children: [
        { name: "umami", type: "application", status: "running:healthy" },
        { name: "postgresql", type: "database", status: "running:healthy" },
      ],
      link: `${HERE}/service/svc1`,
      logo: null,
    });
    const [one] = canvasGraph(HERE, [], [service({ parts: JSON.stringify([{ name: "n8n", kind: "application", status: "exited", fqdn: null, exclude_from_status: false, is_removed_from_compose: false }]) })], []).nodes;
    expect(one).toMatchObject({ subtitle: "Service · 1 container", status: "exited", urls: [] });
  });

  it("a database card: engine and image, its page, its engine logo (with a dark one for KeyDB)", () => {
    const nodes = canvasGraph(HERE, [], [], [database({}), database({ uuid: "db3", engine: "keydb", image: "eqalpha/keydb:latest" })]).nodes;
    expect(nodes[0]).toMatchObject({ subtitle: "PostgreSQL · postgres:17-alpine", kind: "postgresql", link: `${HERE}/database/db1`, logo: { src: "/svgs/resources/postgres.svg", dark: null } });
    expect(nodes[1]).toMatchObject({ subtitle: "KeyDB · eqalpha/keydb:latest", logo: { src: "/svgs/resources/keydb.svg", dark: "/svgs/resources/keydb-dark.svg" } });
  });

  it("splitUrls trims, drops empties and repeats", () => {
    expect(splitUrls(" https://a.io ,,https://a.io,http://b.io ")).toEqual(["https://a.io", "http://b.io"]);
    expect(splitUrls(null)).toEqual([]);
  });
});

describe("GET /projects/{uuid}/environments/{env_uuid}/canvas", () => {
  function setup(read = true) {
    const asked: string[] = [];
    const env: Env = {
      PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
      MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
      POLICY_WORKER: fetcher(async (req) => {
        const body = (await req.json()) as { action: string };
        asked.push(body.action);
        return json({ data: { decision: read ? "allow" : "deny", allow: read } });
      }),
    } as unknown as Env;
    const store = {
      findProject: async (uuid: string) => (uuid === PROJECT ? { id: 1, uuid: PROJECT, name: "My project" } : null),
      findEnvironment: async (_projectId: unknown, uuid: string) => (uuid === ENVIRONMENT ? { id: 7, uuid: ENVIRONMENT, name: "production" } : null),
      listForEnvironment: async () => [app({})],
      listServiceCanvasRows: async () => [service({})],
      listDatabasesForEnvironment: async () => [database({})],
    } as unknown as ApplicationStore;
    const runner: ApplicationRunner = async (_env, _orgId, fn) => fn({ store } as never);
    const get = async (projectUuid = PROJECT, environmentUuid = ENVIRONMENT, method = "GET") => {
      const res = await handleEnvironmentResources(env, "req_1", actor, ORG_UUID, { projectUuid, environmentUuid, page: "canvas" }, new Request(`${BASE}/projects/${projectUuid}/environments/${environmentUuid}/canvas`, { method }), runner);
      return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown> } };
    };
    return { get, asked };
  }

  it("answers EnvironmentCanvasController::show()'s payload, read only, with policy deploy.resource.read", async () => {
    const t = setup();
    const r = await t.get();
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      project: { uuid: PROJECT, name: "My project", link: `/project/${PROJECT}` },
      environment: { uuid: ENVIRONMENT, name: "production", link: HERE },
      can_edit: false,
      links: [],
      positions: {},
    });
    expect((r.body.data!.nodes as unknown[]).length).toBe(3);
    expect((r.body.data!.zones as Array<{ id: string }>).map((z) => z.id)).toEqual(["srv-a", "srv-b"]);
    expect(t.asked[0]).toBe("deploy.resource.read");
  });

  it("is 404 for another org's project or environment, for a reader who is denied, and 405 for a write", async () => {
    expect((await setup().get("nope")).status).toBe(404);
    expect((await setup().get(PROJECT, "nope")).status).toBe(404);
    expect((await setup(false).get()).status).toBe(404);
    expect((await setup().get(PROJECT, ENVIRONMENT, "POST")).status).toBe(405);
  });

  it("is routed by route() behind the same checks as the other environment pages", async () => {
    const bare = { ENVIRONMENT: "test" } as Env;
    const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
    const url = `${BASE}/projects/${PROJECT}/environments/${ENVIRONMENT}/canvas`;
    expect((await route(new Request(url), bare)).status).toBe(401);
    // Past the identity check, it reaches the handler, which needs the database.
    expect((await route(new Request(url, { headers }), bare)).status).toBe(503);
  });
});
