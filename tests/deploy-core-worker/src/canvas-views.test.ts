// The canvases that reuse the environment canvas's view (DP-98), at Coolify's /canvas/api paths under
// /deploy/canvas/api: ProjectCanvas::teamPayload() and payload(), ServerCanvas::payload() and dashboardPayload(),
// SharedVariableCanvas::payload() for each scope and TagCanvas::payload() in their shapes; the zones' saved places
// (updatePositions), a tag attached and detached, a shared variable added to a resource and removed from it, with
// the controllers' rules and messages; the server's unmanaged containers and usage answering the SSH executor's 501;
// authorization (deploy.resource.read reads, deploy.resource.write for can_edit and every write, a denial 404 that
// runs nothing); org isolation (each org's runner sees only its own store, as withOrg's row-level security does); and
// the routing. The SQL behind the store is tests/db's deploy-canvas-views.test.ts.
/* eslint-disable @typescript-eslint/no-explicit-any -- the payloads are read as the JSON they are. */
import type { Env } from "@deploy-core-worker/env";
import { route } from "@deploy-core-worker/router";
import { handleCanvasViews, type CanvasViewsRunner } from "@deploy-core-worker/handlers/canvas-views";
import { referencedKeys, isExactReference, usedInDockerCompose, projectZones, zonePosition, type CanvasViewsStore } from "@deploy-core-worker/applications/canvas-views";
import type {
  DeployApplicationRow,
  DeployCanvasDeploymentRow,
  DeployCanvasEnvironmentRow,
  DeployCanvasProjectRow,
  DeployCanvasServerRow,
  DeployCanvasVariableRow,
  DeployDatabaseRow,
  DeployOrgServiceCanvasRow,
  DeployResourceLinkRow,
  DeploySharedVariableRow,
  DeployTaggableRow,
  DeployTagRow,
} from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_A = "00000000-0000-0000-0000-00000000000a";
const ORG_B = "00000000-0000-0000-0000-00000000000b";
const BASE = `https://x/v1/organizations/${ORG}/deploy/canvas/api`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const APP = "App\\Models\\Application";
const PG = "App\\Models\\StandalonePostgresql";
const SERVICE = "App\\Models\\Service";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

const serverFacts = (uuid: string | null) => ({ server_uuid: uuid, server_name: uuid ? `server-${uuid}` : null, server_ip: "10.0.0.1", server_is_reachable: true, server_is_usable: true });

/** One org in memory: two projects (Shop with production and staging, Blog with an empty production), two servers, resources and their rows. */
function memoryOrg() {
  const environments: DeployCanvasEnvironmentRow[] = [
    { id: 1, uuid: "env-prod", name: "production", project_id: 1, project_uuid: "shop", project_name: "Shop", canvas_positions: { web: { x: 40, y: 64 } } },
    { id: 2, uuid: "env-stage", name: "staging", project_id: 1, project_uuid: "shop", project_name: "Shop", canvas_positions: null },
    { id: 3, uuid: "env-blog", name: "production", project_id: 2, project_uuid: "blog", project_name: "Blog", canvas_positions: null },
  ];
  const projects: DeployCanvasProjectRow[] = [
    { id: 2, uuid: "blog", name: "Blog", canvas_position: null },
    { id: 1, uuid: "shop", name: "Shop", canvas_position: { x: 900, y: "-40" } },
  ];
  const servers: DeployCanvasServerRow[] = [
    {
      id: 10, uuid: "srv-a", name: "alpha", ip: "10.0.0.1", proxy: { type: "TRAEFIK", status: "running" }, server_metadata: { os: "Ubuntu 24.04", arch: "amd64", cpus: "4", memory_bytes: 8589934592, uptime_since: "2026-11-01 00:00:00" },
      canvas_position: { x: 0, y: 0 }, is_reachable: true, is_usable: true, force_disabled: false, is_metrics_enabled: true,
    },
    { id: 11, uuid: "srv-b", name: "bravo", ip: "10.0.0.2", proxy: { type: "NONE" }, server_metadata: null, canvas_position: null, is_reachable: false, is_usable: false, force_disabled: false, is_metrics_enabled: false },
  ];
  const app = (id: number, uuid: string, environment_id: number, extra: Partial<DeployApplicationRow> = {}) =>
    ({ id, uuid, name: uuid, status: "running:healthy", fqdn: null, build_pack: "dockerimage", git_branch: "main", docker_registry_image_name: "nginx", docker_registry_image_tag: "latest", environment_id, ...serverFacts("srv-a"), ...extra }) as unknown as DeployApplicationRow;
  const state = {
    applications: [app(1, "web", 1), app(2, "api", 2, { name: "API" }), app(3, "compose", 2, { build_pack: "dockercompose" })],
    services: [{ id: 5, uuid: "plausible", name: "plausible", environment_id: 1, server_id: 11, parts: [{ name: "plausible", kind: "application", status: "running:healthy", fqdn: "https://stats.example.com", exclude_from_status: false, is_removed_from_compose: false }], ...serverFacts("srv-b") }] as unknown as DeployOrgServiceCanvasRow[],
    databases: [{ id: 7, uuid: "pg", name: "pg", status: "running:healthy", engine: "postgresql", image: "postgres:17", environment_id: 1, server_id: 10, ...serverFacts("srv-a") }] as unknown as DeployDatabaseRow[],
    links: [
      { id: 1, uuid: "link-1", environment_id: 1, source_type: APP, source_id: 1, target_type: PG, target_id: 7, label: "reads" },
      { id: 2, uuid: "link-2", environment_id: 1, source_type: APP, source_id: 1, target_type: SERVICE, target_id: 5, label: null },
    ] as DeployResourceLinkRow[],
    tags: [
      { id: 21, uuid: "tag-prod", name: "prod" },
      { id: 22, uuid: "tag-web", name: "web" },
    ] as DeployTagRow[],
    taggables: [{ tag_id: 21, taggable_type: APP, taggable_id: 1 }] as DeployTaggableRow[],
    shared: {
      team: [
        { id: 31, key: "TOKEN", comment: null, is_multiline: false, is_literal: true },
        { id: 30, key: "API_URL", comment: "The API", is_multiline: false, is_literal: false },
      ],
      server: [
        { id: 40, key: "COOLIFY_SERVER_NAME", comment: null, is_multiline: false, is_literal: false },
        { id: 41, key: "REGION", comment: null, is_multiline: false, is_literal: false },
      ],
    } as Record<string, Array<Partial<DeploySharedVariableRow>>>,
    variables: [
      { id: 50, key: "API_URL", value: "enc:{{team.API_URL}}", is_preview: false, resourceable_type: APP, resourceable_id: 1 },
      { id: 51, key: "API_URL", value: "enc:{{team.API_URL}}", is_preview: true, resourceable_type: APP, resourceable_id: 1 },
      { id: 52, key: "BASE", value: "enc:https://{{ team.API_URL }}/v1", is_preview: false, resourceable_type: APP, resourceable_id: 2 },
      { id: 53, key: "OLD", value: "enc:{{team.GONE}}", is_preview: false, resourceable_type: APP, resourceable_id: 2 },
      { id: 54, key: "REGION", value: "enc:{{server.REGION}}", is_preview: false, resourceable_type: APP, resourceable_id: 1 },
      { id: 55, key: "API_URL", value: "enc:{{team.API_URL}}", is_preview: false, resourceable_type: APP, resourceable_id: 3 },
    ] as DeployCanvasVariableRow[],
    deployments: { active: [] as DeployCanvasDeploymentRow[], recent: [] as DeployCanvasDeploymentRow[] },
    compose: "services:\n  app:\n    environment:\n      API_URL: x\n",
    saves: [] as Array<[string, string, unknown]>,
    added: [] as unknown[],
    deleted: [] as unknown[],
    attached: [] as unknown[],
    detached: [] as unknown[],
    asked: [] as Array<[unknown, boolean]>,
  };
  const store: CanvasViewsStore = {
    environments: async () => environments,
    projects: async () => projects,
    servers: async () => servers,
    applications: async () => state.applications,
    services: async () => state.services,
    databases: async () => state.databases,
    links: async () => state.links,
    saveProjectPosition: async (id, position) => {
      state.saves.push(["project", String(id), position]);
      return true;
    },
    saveServerPosition: async (id, position) => {
      state.saves.push(["server", String(id), position]);
      return true;
    },
    deployments: async (ids, active) => {
      state.asked.push([ids, active]);
      return active ? state.deployments.active : state.deployments.recent;
    },
    tags: async () => state.tags,
    taggables: async () => state.taggables,
    attachTag: async (resource, tagId) => {
      state.attached.push([resource, tagId]);
      state.taggables.push({ tag_id: tagId, taggable_type: resource.type, taggable_id: resource.id });
    },
    detachTag: async (resource, tagId) => {
      state.detached.push([resource, tagId]);
      return true;
    },
    sharedVariables: async (scope) => (state.shared[scope] ?? []) as DeploySharedVariableRow[],
    variables: async (resources, withPreview) =>
      state.variables.filter((v) => (withPreview || !v.is_preview) && resources.some((r) => r.type === v.resourceable_type && String(r.id) === String(v.resourceable_id))).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : Number(a.id) - Number(b.id))),
    decrypt: async (value) => (value ? value.replace(/^enc:/, "") : null),
    addVariable: async (resource, variable) => {
      state.added.push([resource, variable]);
      state.variables.push({ id: 60 + state.added.length, key: variable.key, value: `enc:${variable.value}`, is_preview: false, resourceable_type: resource.type === "application" ? APP : resource.type === "service" ? SERVICE : PG, resourceable_id: resource.id });
    },
    deleteVariables: async (ids) => {
      state.deleted.push([...ids]);
    },
    dockerCompose: async () => state.compose,
  };
  return { store, state };
}

/** Another org's store: none of org A's rows (row-level security). */
function emptyOrg(): CanvasViewsStore {
  const none = async () => [];
  return {
    environments: none, projects: none, servers: none, applications: none, services: none, databases: none, links: none,
    saveProjectPosition: async () => false, saveServerPosition: async () => false, deployments: none, tags: none, taggables: none,
    attachTag: async () => {}, detachTag: async () => false, sharedVariables: none, variables: none, decrypt: async () => null,
    addVariable: async () => {}, deleteVariables: async () => {}, dockerCompose: async () => null,
  };
}

function setup({ read = true, write = true } = {}) {
  const asked: string[] = [];
  const env: Env = {
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      asked.push(body.action);
      const allow = body.action === "deploy.resource.write" ? write : read;
      return json({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
  } as unknown as Env;
  const a = memoryOrg();
  const b = emptyOrg();
  const runs: string[] = [];
  const runner: CanvasViewsRunner = async (_env, orgId, fn) => {
    runs.push(orgId);
    return fn(orgId === ORG_A ? a.store : b);
  };
  const send = async (method: string, path: string, body?: unknown, { org = ORG_A }: { org?: string } = {}) => {
    const init: RequestInit = { method, headers: { "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const segments = path.split("/").filter(Boolean);
    const res = await handleCanvasViews(env, "req_1", actor, org, segments, new Request(`${BASE}/${path}`, init), runner);
    return { status: res.status, body: (await res.json()) as { data?: Record<string, any>; error?: { code: string; message: string; details?: { fields?: Record<string, string[]>; error?: string } } } };
  };
  return { send, asked, runs, a };
}

describe("GET /projects/canvas (ProjectCanvas::teamPayload)", () => {
  it("one zone per project by name with its saved place, cards grouped by environment, placeholders for empty environments", async () => {
    const t = setup();
    const r = await t.send("GET", "projects/canvas");
    expect(r.status).toBe(200);
    const d = r.body.data!;
    expect(d).toMatchObject({ title: "Projects", title_link: "/projects", can_edit: true, can_move: false, can_move_groups: true, can_move_zones: true, layout: "server", positions: [] });
    expect(d.zones).toEqual([
      { id: "blog", name: "Blog", icon: "projects", link: "/project/blog", position: null },
      { id: "shop", name: "Shop", icon: "projects", link: "/project/shop", position: { x: 900, y: -40 } },
    ]);
    // Applications, services, then the databases (loadResources()' order); each card in its project's zone.
    expect(d.nodes.map((n: any) => [n.id, n.zone, n.context])).toEqual([
      ["web", "shop", "production"],
      ["api", "shop", "staging"],
      ["compose", "shop", "staging"],
      ["plausible", "shop", "production"],
      ["pg", "shop", "production"],
      ["empty:env-blog", "blog", "production"],
    ]);
    const web = d.nodes[0];
    expect(web).toMatchObject({ context_link: "/project/shop/environment/env-prod", project: { uuid: "shop", name: "Shop" }, environment: { uuid: "env-prod", name: "production" }, saved: { x: 40, y: 64 }, link: "/project/shop/environment/env-prod/application/web", subtitle: "Docker Image · nginx:latest" });
    expect(d.nodes[1].saved).toBeNull();
    // Admins' placeholder opens the deploy canvas.
    expect(d.nodes[5]).toMatchObject({ type: "empty", name: "No resources yet", subtitle: "Click to add a resource", link: "/canvas?project=blog&environment=env-blog", context_link: "/project/blog/environment/env-blog" });
    expect(d.links).toEqual([
      { id: "link-1", source: "web", target: "pg", label: "reads" },
      { id: "link-2", source: "web", target: "plausible", label: null },
    ]);
  });

  it("a reader gets can_edit false, and the placeholder opens the environment page", async () => {
    const t = setup({ write: false });
    const d = (await t.send("GET", "projects/canvas")).body.data!;
    expect(d).toMatchObject({ can_edit: false, can_move_groups: false, can_move_zones: false });
    expect(d.nodes.at(-1)).toMatchObject({ subtitle: "Open to see this environment", link: "/project/blog/environment/env-blog" });
  });
});

describe("GET /projects/{uuid}/canvas (ProjectCanvas::payload)", () => {
  it("every environment of the project, a zone per server, placeholders on the server most of the project's cards use", async () => {
    const t = setup();
    const d = (await t.send("GET", "projects/shop/canvas")).body.data!;
    expect(d).toMatchObject({ title: "Shop", title_link: "/project/shop", can_edit: true, can_move: false, can_move_groups: true, layout: "server" });
    expect(d.can_move_zones).toBeUndefined();
    expect(d.zones.map((z: any) => [z.id, z.name, z.ip, z.is_reachable, z.link])).toEqual([
      ["srv-a", "server-srv-a", null, true, "/server/srv-a"],
      ["srv-b", "server-srv-b", null, true, "/server/srv-b"],
    ]);
    expect(d.nodes.map((n: any) => n.id)).toEqual(["web", "api", "compose", "plausible", "pg"]);
    const blog = (await t.send("GET", "projects/blog/canvas")).body.data!;
    // A project without cards: its placeholder sits in the "Empty environments" zone.
    expect(blog.zones).toEqual([{ id: "empty", name: "Empty environments", icon: "service" }]);
    expect(blog.nodes).toEqual([expect.objectContaining({ id: "empty:env-blog", zone: "empty", context: "production" })]);
  });

  it("another org's project is \"Project not found.\"", async () => {
    const t = setup();
    const r = await t.send("GET", "projects/shop/canvas", undefined, { org: ORG_B });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatchObject({ code: "not_found", message: "Project not found." });
    expect(t.runs).toEqual([ORG_B]);
  });
});

describe("GET /servers/canvas, /servers/{uuid}/canvas and /dashboard/canvas (ServerCanvas)", () => {
  it("every server by name with its details and saved place; cards with their project / environment; empty environments and bare servers", async () => {
    const t = setup();
    const d = (await t.send("GET", "servers/canvas")).body.data!;
    expect(d).toMatchObject({ title: "Servers", title_link: null, containers_endpoint: null, can_move_zones: true, layout: "server" });
    expect(d.zones[0]).toEqual({
      id: "srv-a",
      name: "alpha",
      ip: null,
      is_reachable: true,
      is_usable: true,
      link: "/server/srv-a",
      details: { os: "Ubuntu 24.04", arch: "amd64", cpus: 4, memory_bytes: 8589934592, uptime_since: "2026-11-01 00:00:00", proxy: { type: "TRAEFIK", status: "running" }, usage_endpoint: "/servers/srv-a/canvas/usage" },
      position: { x: 0, y: 0 },
    });
    // NONE is no proxy; no metrics, no usage.
    expect(d.zones[1].details).toMatchObject({ proxy: null, usage_endpoint: null, os: null, cpus: null });
    expect(d.nodes.map((n: any) => [n.id, n.zone, n.context])).toEqual([
      ["web", "srv-a", "Shop / production"],
      ["api", "srv-a", "Shop / staging"],
      ["compose", "srv-a", "Shop / staging"],
      ["plausible", "srv-b", "Shop / production"],
      ["pg", "srv-a", "Shop / production"],
      ["empty:env-blog", "srv-a", "Blog / production"],
    ]);
    expect(d.links.map((l: any) => l.id)).toEqual(["link-1", "link-2"]);
  });

  it("one server: no zone place, no placeholder environments, its containers endpoint; a server without cards gets one placeholder", async () => {
    const t = setup();
    const d = (await t.send("GET", "servers/srv-b/canvas")).body.data!;
    expect(d).toMatchObject({ title: "bravo", title_link: "/server/srv-b", containers_endpoint: "/servers/srv-b/canvas/containers", can_move_zones: false });
    expect(d.zones.map((z: any) => [z.id, z.position])).toEqual([["srv-b", null]]);
    expect(d.nodes.map((n: any) => n.id)).toEqual(["plausible"]);
    // Only the links with both ends shown.
    expect(d.links).toEqual([]);
    t.a.state.services = [];
    const bare = (await t.send("GET", "servers/srv-b/canvas")).body.data!;
    expect(bare.nodes).toEqual([{ id: "empty-server:srv-b", type: "empty", name: "No resources yet", subtitle: "Open to see this server", status: null, zone: "srv-b", extra_zones: [], urls: [], children: [], link: "/server/srv-b", context: null, project: null, environment: null }]);
    expect((await t.send("GET", "servers/nope/canvas")).body.error?.message).toBe("Server not found.");
  });

  it("the dashboard: each application's oldest active deployment on its card, and the deployments list", async () => {
    const t = setup();
    const dep = (uuid: string, status: string, application_uuid: string | null, extra: Partial<DeployCanvasDeploymentRow> = {}) =>
      ({ deployment_uuid: uuid, application_id: application_uuid === "web" ? "1" : "2", application_uuid, application_name: "web", status, deployment_url: `/d/${uuid}`, pull_request_id: 0, server_name: "alpha", created_at: "2026-11-20T10:00:00+00:00", finished_at: null, ...extra }) as DeployCanvasDeploymentRow;
    t.a.state.deployments.active = [dep("p1", "in_progress", "web", { pull_request_id: 3 }), dep("q1", "queued", "web")];
    t.a.state.deployments.recent = [dep("f1", "finished", "api", { finished_at: "2026-11-20T10:05:00+00:00" })];
    const d = (await t.send("GET", "dashboard/canvas")).body.data!;
    expect(d).toMatchObject({ title: "Dashboard", title_link: "/dashboard", layout: "server" });
    expect(t.a.state.asked).toEqual([
      [[10, 11], true],
      [[10, 11], false],
    ]);
    expect(d.nodes.find((n: any) => n.id === "web").deployment).toEqual({ status: "in_progress", link: "/d/p1", pull_request_id: 3 });
    expect(d.nodes.find((n: any) => n.id === "api").deployment).toBeUndefined();
    expect(d.deployments.map((x: any) => [x.id, x.application, x.status, x.pull_request_id])).toEqual([
      ["p1", "web", "in_progress", 3],
      ["q1", "web", "queued", null],
      ["f1", "api", "finished", null],
    ]);
    expect(d.deployments[2]).toMatchObject({ name: "web", server: "alpha", link: "/d/f1", created_at: "2026-11-20T10:00:00+00:00", finished_at: "2026-11-20T10:05:00+00:00" });
  });

  it("a functional server's unmanaged containers and Sentinel usage answer the SSH executor's 501; others answer none", async () => {
    const t = setup();
    const containers = await t.send("GET", "servers/srv-a/canvas/containers");
    expect(containers.status).toBe(501);
    expect(containers.body.error).toMatchObject({ code: "unsupported", message: "Listing the containers on the server needs the SSH executor, which is not available yet." });
    expect((await t.send("GET", "servers/srv-b/canvas/containers")).body.data).toEqual({ nodes: [] });
    const usage = await t.send("GET", "servers/srv-a/canvas/usage");
    expect(usage.status).toBe(501);
    expect(usage.body.error?.message).toBe("Reading the server's usage from Sentinel needs the SSH executor, which is not available yet.");
    expect((await t.send("GET", "servers/srv-b/canvas/usage")).body.data).toEqual({ cpu: null, memory: null, disk: null });
  });
});

describe("PATCH /projects/canvas/positions, /servers/canvas/positions and /dashboard/canvas/positions (updatePositions)", () => {
  it("saves the top-left of each zone of the org, as integers, and answers the saved ones", async () => {
    const t = setup();
    const r = await t.send("PATCH", "projects/canvas/positions", { positions: { shop: { x: 10, y: "-20" }, nope: { x: 1, y: 2 } } });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ positions: { shop: { x: 10, y: -20 } } });
    expect(t.a.state.saves).toEqual([["project", "1", { x: 10, y: -20 }]]);
    expect((await t.send("PATCH", "servers/canvas/positions", { positions: { "srv-b": { x: 5, y: 6 } } })).body.data).toEqual({ positions: { "srv-b": { x: 5, y: 6 } } });
    expect((await t.send("PATCH", "dashboard/canvas/positions", { positions: { "srv-a": { x: 0, y: 0 } } })).body.data).toEqual({ positions: { "srv-a": { x: 0, y: 0 } } });
    expect(t.a.state.saves.slice(1)).toEqual([
      ["server", "11", { x: 5, y: 6 }],
      ["server", "10", { x: 0, y: 0 }],
    ]);
    // Nothing to save: an empty object.
    expect((await t.send("PATCH", "servers/canvas/positions", { positions: { nope: { x: 1, y: 1 } } })).body.data).toEqual({ positions: {} });
  });

  it("the rules: positions required, an array of at most 1000, each x and y a required integer between -100000 and 100000", async () => {
    const t = setup();
    const r = await t.send("PATCH", "projects/canvas/positions", { other: 1 });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ message: "Validation failed.", details: { fields: { positions: ["The positions field is required."] } } });
    expect((await t.send("PATCH", "projects/canvas/positions", { positions: { shop: { x: 1.5, y: 100001 } } })).body.error?.details?.fields).toEqual({
      "positions.shop.x": ["The positions.shop.x field must be an integer."],
      "positions.shop.y": ["The positions.shop.y field must be between -100000 and 100000."],
    });
    // Every uuid is validated, also unknown ones (Coolify checks before it looks the projects up).
    expect((await t.send("PATCH", "servers/canvas/positions", { positions: { nope: { x: "far", y: 0 } } })).status).toBe(422);
    expect(t.a.state.saves).toEqual([]);
  });
});

describe("GET /shared-variables/…/canvas (SharedVariableCanvas::payload)", () => {
  it("the team's variables by key, the resources by name, a link per referenced variable, and deleted ones", async () => {
    const t = setup();
    const d = (await t.send("GET", "shared-variables/team/canvas")).body.data!;
    expect(d).toMatchObject({ title: "Team variables", title_link: "/shared-variables/team", can_edit: true, can_move: false, layout: "connect", scope: "team", positions: [] });
    expect(d.zones).toEqual([
      { id: "sources", name: "Team variables", icon: "variable" },
      { id: "connected", name: "Using these variables", icon: "link" },
      { id: "resources", name: "Other resources", icon: "service" },
    ]);
    expect(d.nodes.slice(0, 3)).toEqual([
      { id: "variable:30", type: "variable", name: "API_URL", subtitle: "The API", reference: "{{team.API_URL}}", missing: false, zone: "sources", extra_zones: [], status: null },
      { id: "variable:31", type: "variable", name: "TOKEN", subtitle: "Team variable", reference: "{{team.TOKEN}}", missing: false, zone: "sources", extra_zones: [], status: null },
      { id: "missing:GONE", type: "variable", name: "GONE", subtitle: "Deleted shared variable", reference: "{{team.GONE}}", missing: true, zone: "sources", extra_zones: [], status: null },
    ]);
    // Resources by lower-cased name, in the resources zone, with their project / environment.
    expect(d.nodes.slice(3).map((n: any) => [n.id, n.zone, n.context])).toEqual([
      ["api", "resources", "Shop / staging"],
      ["compose", "resources", "Shop / staging"],
      ["pg", "resources", "Shop / production"],
      ["plausible", "resources", "Shop / production"],
      ["web", "resources", "Shop / production"],
    ]);
    expect(d.links).toEqual([
      // In the order of the resources' variables (by key): API_URL of web and compose, BASE and OLD of api.
      { id: "variable:30|web", source: "variable:30", target: "web", key: "API_URL", keys: ["API_URL"], label: null, removable: true, missing: false },
      { id: "variable:30|compose", source: "variable:30", target: "compose", key: "API_URL", keys: ["API_URL"], label: null, removable: true, missing: false },
      { id: "variable:30|api", source: "variable:30", target: "api", key: "API_URL", keys: ["BASE"], label: "BASE", removable: false, missing: false },
      { id: "missing:GONE|api", source: "missing:GONE", target: "api", key: "GONE", keys: ["OLD"], label: "OLD", removable: true, missing: true },
    ]);
  });

  it("the server scope: its built-in variables left out, the resources whose main server it is", async () => {
    const t = setup({ write: false });
    const d = (await t.send("GET", "shared-variables/server/srv-a/canvas")).body.data!;
    expect(d).toMatchObject({ title: "alpha variables", title_link: "/shared-variables/server/srv-a", can_edit: false, scope: "server" });
    expect(d.zones[0]).toEqual({ id: "sources", name: "Server variables", icon: "variable" });
    expect(d.nodes.filter((n: any) => n.type === "variable").map((n: any) => n.name)).toEqual(["REGION"]);
    // plausible's own server is srv-b.
    expect(d.nodes.filter((n: any) => n.type !== "variable").map((n: any) => n.id)).toEqual(["api", "compose", "pg", "web"]);
    expect(d.links.map((l: any) => l.id)).toEqual(["variable:41|web"]);
  });

  it("the project and environment scopes: their resources only; an owner of another org is not found", async () => {
    const t = setup();
    const env = (await t.send("GET", "shared-variables/environment/env-stage/canvas")).body.data!;
    expect(env).toMatchObject({ title: "Shop / staging variables", title_link: "/shared-variables/environments/project/shop/environment/env-stage" });
    expect(env.nodes.map((n: any) => n.id)).toEqual(["api", "compose"]);
    const project = (await t.send("GET", "shared-variables/project/blog/canvas")).body.data!;
    expect(project).toMatchObject({ title: "Blog variables", title_link: "/shared-variables/project/blog", nodes: [], links: [] });
    for (const [path, message] of [
      ["shared-variables/project/shop/canvas", "Project not found."],
      ["shared-variables/environment/env-prod/canvas", "Environment not found."],
      ["shared-variables/server/srv-a/canvas", "Server not found."],
    ] as const) {
      const r = await t.send("GET", path, undefined, { org: ORG_B });
      expect(r.status).toBe(404);
      expect(r.body.error?.message).toBe(message);
    }
  });
});

describe("POST and DELETE /shared-variables/…/canvas/links (storeLink, destroyLink)", () => {
  it("adds {{scope.KEY}} to a resource as a variable named KEY, with the shared variable's flags, and answers its link", async () => {
    const t = setup();
    const r = await t.send("POST", "shared-variables/team/canvas/links", { source: "variable:31", target: "pg" });
    expect(r.status).toBe(201);
    expect(t.a.state.added).toEqual([[{ type: "standalone-postgresql", uuid: "pg", id: 7 }, { key: "TOKEN", value: "{{team.TOKEN}}", isMultiline: false, isLiteral: true }]]);
    expect(r.body.data).toEqual({ id: "variable:31|pg", source: "variable:31", target: "pg", key: "TOKEN", keys: ["TOKEN"], label: null, removable: true, missing: false });
    expect(t.asked).toEqual(["deploy.resource.write"]);
  });

  it("the rules and Coolify's messages", async () => {
    const t = setup();
    const fields = async (body: unknown) => (await t.send("POST", "shared-variables/team/canvas/links", body)).body.error?.details?.fields;
    expect(await fields({ other: 1 })).toEqual({ source: ["The source field is required."], target: ["The target field is required."] });
    // validateIncomingRequest(): an empty body is 400.
    expect((await t.send("POST", "shared-variables/team/canvas/links", {})).body.error).toMatchObject({ code: "bad_request", message: "Invalid request.", details: { error: "Empty JSON." } });
    expect(await fields({ source: "variable:99", target: "nope" })).toEqual({ source: ["The source must be a shared variable of this scope."], target: ["The target must be a resource that can use this shared variable."] });
    const already = await t.send("POST", "shared-variables/team/canvas/links", { source: "variable:30", target: "web" });
    expect(already.status).toBe(422);
    expect(already.body.error).toMatchObject({ message: "web already uses API_URL.", details: { fields: { target: ["web already uses API_URL."] } } });
    t.a.state.variables.push({ id: 70, key: "TOKEN", value: "enc:plain", is_preview: false, resourceable_type: APP, resourceable_id: 1 });
    expect((await t.send("POST", "shared-variables/team/canvas/links", { source: "variable:31", target: "web" })).body.error?.message).toBe("web already has a variable named TOKEN. Rename or remove it first.");
    // A server's resources are only those whose main server it is.
    expect((await t.send("POST", "shared-variables/server/srv-a/canvas/links", { source: "variable:41", target: "plausible" })).body.error?.details?.fields).toEqual({ target: ["The target must be a resource that can use this shared variable."] });
    expect(t.a.state.added).toEqual([]);
  });

  it("removes the resource's variables that hold only the reference, its preview copies too", async () => {
    const t = setup();
    const r = await t.send("DELETE", `shared-variables/team/canvas/links/${encodeURIComponent("variable:30|web")}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ message: "Link removed." });
    expect(t.a.state.deleted).toEqual([[50, 51]]);
    // A deleted shared variable's reference can be removed by its key.
    expect((await t.send("DELETE", `shared-variables/team/canvas/links/${encodeURIComponent("missing:GONE|api")}`)).status).toBe(200);
    expect(t.a.state.deleted[1]).toEqual([53]);
  });

  it("refuses a reference inside a longer value, a variable the Compose file uses, and a link that is not there", async () => {
    const t = setup();
    const embedded = await t.send("DELETE", `shared-variables/team/canvas/links/${encodeURIComponent("variable:30|api")}`);
    expect(embedded.status).toBe(422);
    expect(embedded.body.error?.message).toBe("BASE on API uses {{team.API_URL}} inside a longer value. Edit it on the resource.");
    const compose = await t.send("DELETE", `shared-variables/team/canvas/links/${encodeURIComponent("variable:30|compose")}`);
    expect(compose.body.error?.message).toBe("Cannot remove API_URL from compose. Environment variable 'API_URL' is used directly in the Docker Compose file.");
    for (const id of ["variable:31|web", "variable:30|nope", "nothing", "missing:|web"]) {
      const r = await t.send("DELETE", `shared-variables/team/canvas/links/${encodeURIComponent(id)}`);
      expect([id, r.status, r.body.error?.message]).toEqual([id, 404, "Link not found."]);
    }
    expect(t.a.state.deleted).toEqual([]);
  });
});

describe("the tags canvas (TagCanvas)", () => {
  it("GET: the tags by name, the resources by name, a link for every tag on a resource", async () => {
    const t = setup();
    const d = (await t.send("GET", "tags/canvas")).body.data!;
    expect(d).toMatchObject({ title: "Tags", title_link: "/tags", can_edit: true, can_move: false, layout: "connect" });
    expect(d.zones.map((z: any) => z.name)).toEqual(["Tags", "Tagged resources", "Other resources"]);
    expect(d.nodes[0]).toEqual({ id: "tag:tag-prod", type: "tag", name: "prod", link: "/tags/prod", missing: false, zone: "sources", extra_zones: [], status: null });
    expect(d.links).toEqual([{ id: "tag:tag-prod|web", source: "tag:tag-prod", target: "web", key: "prod", keys: [], label: null, removable: true, missing: false }]);
  });

  it("POST tags a resource; DELETE untags it; Coolify's messages", async () => {
    const t = setup();
    const r = await t.send("POST", "tags/canvas/links", { source: "tag:tag-web", target: "plausible" });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ id: "tag:tag-web|plausible", source: "tag:tag-web", target: "plausible", key: "web" });
    expect(t.a.state.attached).toEqual([[{ type: SERVICE, id: 5 }, 22]]);
    expect((await t.send("POST", "tags/canvas/links", { source: "tag:tag-prod", target: "web" })).body.error?.message).toBe("web already has the prod tag.");
    expect((await t.send("POST", "tags/canvas/links", { source: "variable:1", target: "x" })).body.error?.details?.fields).toEqual({ source: ["The source must be a tag of this team."], target: ["The target must be a resource of this team."] });
    const removed = await t.send("DELETE", `tags/canvas/links/${encodeURIComponent("tag:tag-prod|web")}`);
    expect(removed.body.data).toEqual({ message: "Link removed." });
    expect(t.a.state.detached).toEqual([[{ type: APP, id: 1 }, 21]]);
    expect((await t.send("DELETE", `tags/canvas/links/${encodeURIComponent("tag:tag-web|api")}`)).body.error?.message).toBe("Link not found.");
  });
});

describe("authorization, org isolation and routing", () => {
  it("reads ask deploy.resource.read; can_edit is deploy.resource.write", async () => {
    const t = setup();
    await t.send("GET", "tags/canvas");
    expect(t.asked.sort()).toEqual(["deploy.resource.read", "deploy.resource.write"]);
  });

  it("a denied read or write is 404 and runs nothing", async () => {
    const reader = setup({ write: false });
    for (const [method, path, body] of [
      ["PATCH", "projects/canvas/positions", { positions: {} }],
      ["PATCH", "servers/canvas/positions", { positions: {} }],
      ["POST", "tags/canvas/links", { source: "tag:tag-web", target: "web" }],
      ["DELETE", "tags/canvas/links/x", undefined],
      ["POST", "shared-variables/team/canvas/links", { source: "variable:30", target: "pg" }],
      ["DELETE", "shared-variables/team/canvas/links/x", undefined],
    ] as const) {
      const r = await reader.send(method, path, body);
      expect([path, r.status]).toEqual([path, 404]);
    }
    expect(reader.runs).toEqual([]);
    const nobody = setup({ read: false, write: false });
    for (const path of ["projects/canvas", "projects/shop/canvas", "servers/canvas", "servers/srv-a/canvas", "dashboard/canvas", "tags/canvas", "shared-variables/team/canvas", "servers/srv-a/canvas/usage"]) {
      expect([path, (await nobody.send("GET", path)).status]).toEqual([path, 404]);
    }
    expect(nobody.runs).toEqual([]);
  });

  it("another org's runner sees none of org A's rows", async () => {
    const t = setup();
    const d = (await t.send("GET", "servers/canvas", undefined, { org: ORG_B })).body.data!;
    expect(d.zones).toEqual([]);
    expect(d.nodes).toEqual([]);
    expect((await t.send("GET", "tags/canvas", undefined, { org: ORG_B })).body.data!.nodes).toEqual([]);
    expect((await t.send("POST", "tags/canvas/links", { source: "tag:tag-prod", target: "web" }, { org: ORG_B })).status).toBe(422);
    expect(t.a.state.attached).toEqual([]);
  });

  it("unknown paths are 404, other methods 405; the router sends /deploy/canvas/api/… here", async () => {
    const t = setup();
    for (const path of ["projects", "projects/canvas/more", "servers/srv-a/canvas/other", "tags/canvas/links/a/b", "shared-variables/teams/canvas", "shared-variables/team/canvas/x", "shared-variables/project/a/b/canvas", "dashboard"]) {
      expect([path, (await t.send("GET", path)).status]).toEqual([path, 404]);
    }
    expect((await t.send("POST", "projects/canvas")).status).toBe(405);
    expect((await t.send("GET", "projects/canvas/positions")).status).toBe(405);
    expect((await t.send("GET", "tags/canvas/links")).status).toBe(405);
    expect((await t.send("PATCH", "tags/canvas/links/x")).status).toBe(405);
    const env = { PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive } as Env;
    const res = await route(new Request(`${BASE}/nowhere`), env);
    expect(res.status).toBe(401);
  });
});

describe("the helpers", () => {
  it("referencedKeys and isExactReference follow Coolify's patterns", () => {
    expect(referencedKeys("team", "{{team.A}} and {{ team.B }} and {{team.A}} and {{project.C}}")).toEqual(["A", "B"]);
    expect(referencedKeys("team", "  ")).toEqual([]);
    expect(isExactReference("team", "A", " {{ team.A }} ")).toBe(true);
    expect(isExactReference("team", "A", "x{{team.A}}")).toBe(false);
  });

  it("usedInDockerCompose: a key used directly, a reference, an unparsable file", () => {
    expect(usedInDockerCompose("A", "services:\n  web:\n    environment:\n      - B=$A\n")).toEqual([true, "Environment variable 'A' is referenced in the Docker Compose file."]);
    // str_contains($value, '$'.$key): ${A} is not $A.
    expect(usedInDockerCompose("A", "services:\n  web:\n    environment:\n      - B=${A}\n")).toEqual([false, ""]);
    expect(usedInDockerCompose("A", "services:\n  web:\n    environment:\n      A: 1\n")).toEqual([true, "Environment variable 'A' is used directly in the Docker Compose file."]);
    expect(usedInDockerCompose("A", "services:\n  web:\n    image: x\n")).toEqual([false, ""]);
    expect(usedInDockerCompose("A", ": : :")).toEqual([false, ""]);
    expect(usedInDockerCompose("A", null)).toEqual([false, ""]);
  });

  it("projectZones and zonePosition", () => {
    const zoneOf = projectZones([{ zone: "a", project: { uuid: "p" } }, { zone: "b", project: { uuid: "p" } }, { zone: "b", project: { uuid: "p" } }, { zone: null, project: { uuid: "q" } }], "fallback");
    expect(zoneOf("p")).toBe("b");
    expect(zoneOf("q")).toBe("fallback");
    expect(zonePosition({ x: "3", y: 4.7 })).toEqual({ x: 3, y: 4 });
    expect(zonePosition({ x: 1 })).toBeNull();
    expect(zonePosition(null)).toBeNull();
  });
});
