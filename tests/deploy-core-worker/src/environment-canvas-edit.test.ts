// The environment canvas's save actions (DP-92): EnvironmentCanvasController::updatePositions, storeLink,
// updateLink and destroyLink — their rules and messages, the saved positions and links in GET's payload,
// can_edit, authorization (deploy.resource.write, a denial 404) and org isolation (each org's runner sees
// only its own store, as withOrg's row-level security does), and the routing. The SQL behind the canvas
// store is tests/db's deploy-canvas.test.ts.
import type { Env } from "@deploy-core-worker/env";
import { route } from "@deploy-core-worker/router";
import { handleEnvironmentCanvas, handleEnvironmentResources, isEnvironmentCanvasEdit, type ApplicationRunner } from "@deploy-core-worker/handlers/applications";
import { canvasLinks, filterPositions, normalizeLabel, type CanvasStore } from "@deploy-core-worker/applications/canvas";
import type { ApplicationStore } from "@deploy-core-worker/applications/service";
import type { CanvasResourceRow, DeployApplicationRow, DeployDatabaseRow, DeployResourceLinkRow } from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_A = "00000000-0000-0000-0000-00000000000a";
const ORG_B = "00000000-0000-0000-0000-00000000000b";
const BASE = `https://x/v1/organizations/${ORG}/deploy`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const PROJECT = "abc123def456ghi789jkl012";
const ENVIRONMENT = "mno345pqr678stu901vwx234";
const APP = "App\\Models\\Application";
const PG = "App\\Models\\StandalonePostgresql";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

const server = { server_uuid: "srv-a", server_name: "server-a", server_ip: "10.0.0.1", server_is_reachable: true, server_is_usable: true };
const app = (uuid: string, id: number) => ({ id, uuid, name: uuid, status: "running:healthy", fqdn: null, build_pack: "dockerimage", git_branch: null, docker_registry_image_name: "nginx", docker_registry_image_tag: "latest", ...server }) as unknown as DeployApplicationRow;
const database = (uuid: string, id: number) => ({ id, uuid, name: uuid, status: "running:healthy", engine: "postgresql", image: "postgres:17-alpine", ...server }) as unknown as DeployDatabaseRow;

/** One org's environment, its resources and its stored layout, in memory. */
function memoryOrg() {
  const resources: CanvasResourceRow[] = [
    { uuid: "web", type: APP, id: 1 },
    { uuid: "api", type: APP, id: 2 },
    { uuid: "pg", type: PG, id: 1 },
  ];
  const state = { positions: null as unknown, links: [] as DeployResourceLinkRow[], nextId: 1, saves: 0, locks: 0, exists: [] as unknown[] };
  const canvas: CanvasStore = {
    resources: async () => resources,
    positions: async () => state.positions,
    lockPositions: async () => {
      state.locks++;
      return { found: true, positions: state.positions };
    },
    savePositions: async (_id, positions) => {
      state.saves++;
      state.positions = JSON.parse(JSON.stringify(positions));
    },
    links: async () => [...state.links].sort((a, b) => Number(a.id) - Number(b.id)),
    findLink: async (_id, uuid) => state.links.find((l) => l.uuid === uuid) ?? null,
    linkExists: async (ends) => {
      state.exists.push(ends);
      return state.links.some((l) => l.source_type === ends.sourceType && String(l.source_id) === String(ends.sourceId) && l.target_type === ends.targetType && String(l.target_id) === String(ends.targetId));
    },
    insertLink: async (link) => {
      const row: DeployResourceLinkRow = {
        id: state.nextId++,
        uuid: link.uuid,
        environment_id: link.environmentId,
        source_type: link.sourceType,
        source_id: link.sourceId,
        target_type: link.targetType,
        target_id: link.targetId,
        label: link.label,
      };
      state.links.push(row);
      return row;
    },
    updateLabel: async (id, label) => {
      const row = state.links.find((l) => l.id === id);
      if (row) row.label = label;
      return row ?? null;
    },
    deleteLink: async (id) => {
      const before = state.links.length;
      state.links = state.links.filter((l) => l.id !== id);
      return state.links.length < before;
    },
  };
  const store = {
    findProject: async (uuid: string) => (uuid === PROJECT ? { id: 1, uuid: PROJECT, name: "My project" } : null),
    findEnvironment: async (_projectId: unknown, uuid: string) => (uuid === ENVIRONMENT ? { id: 7, uuid: ENVIRONMENT, name: "production" } : null),
    listForEnvironment: async () => [app("web", 1), app("api", 2)],
    listServiceCanvasRows: async () => [],
    listDatabasesForEnvironment: async () => [database("pg", 1)],
    canvas,
  } as unknown as ApplicationStore;
  return { store, state, resources };
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
  // Org A owns the project; org B's store has nothing of it (row-level security).
  const a = memoryOrg();
  const empty = { findProject: async () => null, findEnvironment: async () => null, canvas: memoryOrg().store.canvas } as unknown as ApplicationStore;
  const runs: string[] = [];
  const runner: ApplicationRunner = async (_env, orgId, fn) => {
    runs.push(orgId);
    return fn({ store: orgId === ORG_A ? a.store : empty } as never);
  };
  const send = async (method: string, rest: string[], body?: unknown, { org = ORG_A, contentType = "application/json", raw }: { org?: string; contentType?: string; raw?: string } = {}) => {
    const url = `${BASE}/projects/${PROJECT}/environments/${ENVIRONMENT}/canvas/${rest.join("/")}`;
    const init: RequestInit = { method, headers: { "content-type": contentType } };
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleEnvironmentCanvas(env, "req_1", actor, org, { projectUuid: PROJECT, environmentUuid: ENVIRONMENT, rest }, new Request(url, init), runner);
    return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown>; error?: { code: string; message: string; details: { fields?: Record<string, string[]>; error?: string } } } };
  };
  const get = async (org = ORG_A) => {
    const res = await handleEnvironmentResources(env, "req_1", actor, org, { projectUuid: PROJECT, environmentUuid: ENVIRONMENT, page: "canvas" }, new Request(`${BASE}/projects/${PROJECT}/environments/${ENVIRONMENT}/canvas`), runner);
    return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown> } };
  };
  return { send, get, asked, runs, a };
}

const fields = (r: Awaited<ReturnType<ReturnType<typeof setup>["send"]>>) => r.body.error?.details.fields;

describe("PATCH …/canvas/positions (updatePositions)", () => {
  it("saves the positions of the environment's cards as integers, merged with the saved ones, and answers them", async () => {
    const t = setup();
    t.a.state.positions = { api: { x: 5, y: 6 }, gone: { x: 1, y: 1 } };
    const r = await t.send("PATCH", ["positions"], { positions: { web: { x: 10, y: "-20" }, nope: { x: 1, y: 2 } } });
    expect(r.status).toBe(200);
    // Unknown uuids are dropped (only($nodeUuids)); a resource no longer in the environment is filtered out of the saved ones.
    expect(r.body.data).toEqual({ positions: { api: { x: 5, y: 6 }, web: { x: 10, y: -20 } } });
    expect(t.a.state.positions).toEqual({ api: { x: 5, y: 6 }, web: { x: 10, y: -20 } });
    expect(t.a.state.locks).toBe(1);
    expect(t.asked).toContain("deploy.resource.write");
  });

  it("the payload's rules: present, an array, at most 1000, and no other field", async () => {
    const t = setup();
    expect(fields(await t.send("PATCH", ["positions"], { other: 1 }))).toEqual({ positions: ["The positions field must be present."], other: ["This field is not allowed."] });
    expect(fields(await t.send("PATCH", ["positions"], { positions: "x" }))).toEqual({ positions: ["The positions field must be an array."] });
    const many = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`n${i}`, { x: 0, y: 0 }]));
    const r = await t.send("PATCH", ["positions"], { positions: many });
    expect(r.status).toBe(422);
    expect(r.body.error?.message).toBe("Validation failed.");
    expect(fields(r)).toEqual({ positions: ["The positions field must not have more than 1000 items."] });
    expect(t.a.state.saves).toBe(0);
  });

  it("each card's coordinates: required integers between -100000 and 100000; nothing is saved when one is wrong", async () => {
    const t = setup();
    const r = await t.send("PATCH", ["positions"], { positions: { web: { x: 1.5, y: 100001 }, api: "left", pg: { y: 0 } } });
    expect(r.status).toBe(422);
    // Laravel's wildcard expansion: a card that is not an array still has its x and y checked, as missing.
    expect(fields(r)).toEqual({
      "positions.api": ["The positions.api field must be an array."],
      "positions.web.x": ["The positions.web.x field must be an integer."],
      "positions.api.x": ["The positions.api.x field is required."],
      "positions.pg.x": ["The positions.pg.x field is required."],
      "positions.web.y": ["The positions.web.y field must be between -100000 and 100000."],
      "positions.api.y": ["The positions.api.y field is required."],
    });
    expect(Object.keys(fields(r)!)).toEqual(["positions.api", "positions.web.x", "positions.api.x", "positions.pg.x", "positions.web.y", "positions.api.y"]);
    expect(t.a.state.saves).toBe(0);
    // Positions of other uuids are not validated: they are dropped first.
    expect((await t.send("PATCH", ["positions"], { positions: { nope: { x: "far" } } })).status).toBe(200);
  });

  it("validateIncomingRequest(): a body that is not JSON, invalid JSON, or empty JSON is 400 Invalid request.", async () => {
    const t = setup();
    const notJson = await t.send("PATCH", ["positions"], undefined, { contentType: "text/plain", raw: "{}" });
    expect(notJson.status).toBe(400);
    expect(notJson.body.error).toMatchObject({ message: "Invalid request.", details: { error: "Content-Type must be application/json." } });
    expect((await t.send("PATCH", ["positions"], undefined, { raw: "{" })).body.error?.details.error).toBe("Invalid JSON.");
    expect((await t.send("PATCH", ["positions"], {})).body.error?.details.error).toBe("Empty JSON.");
  });
});

describe("POST …/canvas/links (storeLink)", () => {
  it("links two resources of the environment, with a trimmed label, and answers 201 with the link by uuid", async () => {
    const t = setup();
    const r = await t.send("POST", ["links"], { source: "web", target: "pg", label: "  reads from  " });
    expect(r.status).toBe(201);
    expect(r.body.data).toEqual({ id: expect.any(String), source: "web", target: "pg", label: "reads from" });
    expect(String(r.body.data!.id).length).toBeGreaterThan(0);
    expect(t.a.state.links[0]).toMatchObject({ source_type: APP, source_id: 1, target_type: PG, target_id: 1, label: "reads from" });
    // An empty label is none.
    expect((await t.send("POST", ["links"], { source: "api", target: "pg", label: "   " })).body.data).toMatchObject({ label: null });
  });

  it("the rules: required strings of at most 255, a target other than the source, a label of at most 64, no other field", async () => {
    const t = setup();
    expect(fields(await t.send("POST", ["links"], { label: 5, extra: true }))).toEqual({
      source: ["The source field is required."],
      target: ["The target field is required."],
      label: ["The label field must be a string."],
      extra: ["This field is not allowed."],
    });
    expect(fields(await t.send("POST", ["links"], { source: "web", target: "web" }))).toEqual({ target: ["The target field and source must be different."] });
    expect(fields(await t.send("POST", ["links"], { source: "x".repeat(256), target: 3, label: "y".repeat(65) }))).toEqual({
      source: ["The source field must not be greater than 255 characters."],
      target: ["The target field must be a string."],
      label: ["The label field must not be greater than 64 characters."],
    });
    expect(t.a.state.links).toEqual([]);
  });

  it("both ends must be resources of this environment", async () => {
    const t = setup();
    const r = await t.send("POST", ["links"], { source: "nope", target: "other" });
    expect(r.status).toBe(422);
    expect(fields(r)).toEqual({ source: ["The source must be a resource of this environment."], target: ["The target must be a resource of this environment."] });
  });

  it("a direction that is linked already is refused: These resources are already linked.", async () => {
    const t = setup();
    expect((await t.send("POST", ["links"], { source: "web", target: "pg" })).status).toBe(201);
    const again = await t.send("POST", ["links"], { source: "web", target: "pg" });
    expect(again.status).toBe(422);
    expect(fields(again)).toEqual({ target: ["These resources are already linked."] });
    // The other direction is another link for the API (the canvas refuses it before asking).
    expect((await t.send("POST", ["links"], { source: "pg", target: "web" })).status).toBe(201);
  });

  it("a link the unique index refuses (two requests at once) is the same 422", async () => {
    const t = setup();
    (t.a.store.canvas as CanvasStore).insertLink = async () => null;
    const r = await t.send("POST", ["links"], { source: "web", target: "pg" });
    expect(r.status).toBe(422);
    expect(fields(r)).toEqual({ target: ["These resources are already linked."] });
  });
});

describe("PATCH and DELETE …/canvas/links/{link_uuid} (updateLink, destroyLink)", () => {
  async function linked() {
    const t = setup();
    const id = String((await t.send("POST", ["links"], { source: "web", target: "pg", label: "old" })).body.data!.id);
    return { t, id };
  }

  it("relabels a link (an empty label clears it) and answers the link", async () => {
    const { t, id } = await linked();
    expect((await t.send("PATCH", ["links", id], { label: " new " })).body.data).toEqual({ id, source: "web", target: "pg", label: "new" });
    expect((await t.send("PATCH", ["links", id], { label: null })).body.data).toMatchObject({ label: null });
  });

  it("the label: present, nullable, a string of at most 64, no other field; the body must be JSON", async () => {
    const { t, id } = await linked();
    expect(fields(await t.send("PATCH", ["links", id], { name: "x" }))).toEqual({ label: ["The label field must be present."], name: ["This field is not allowed."] });
    expect(fields(await t.send("PATCH", ["links", id], { label: ["x"] }))).toEqual({ label: ["The label field must be a string."] });
    // ConvertEmptyStringsToNull: an empty label is null, which the rules allow.
    expect((await t.send("PATCH", ["links", id], { label: "" })).body.data).toMatchObject({ label: null });
    expect((await t.send("PATCH", ["links", id], undefined, { raw: "null" })).body.error?.details.error).toBe("Invalid JSON.");
  });

  it("Link not found.: an unknown link, or one whose end is no longer a resource of the environment", async () => {
    const { t, id } = await linked();
    const missing = await t.send("PATCH", ["links", "nolink"], { label: "x" });
    expect(missing.status).toBe(404);
    expect(missing.body.error?.message).toBe("Link not found.");
    t.a.resources.splice(2, 1); // the database is gone
    expect((await t.send("PATCH", ["links", id], { label: "x" })).body.error?.message).toBe("Link not found.");
    // Removing it still works (destroyLink does not check the ends).
    expect((await t.send("DELETE", ["links", id])).body.data).toEqual({ message: "Link deleted." });
  });

  it("removes a link: Link deleted., then Link not found.", async () => {
    const { t, id } = await linked();
    const r = await t.send("DELETE", ["links", id]);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ message: "Link deleted." });
    expect(t.a.state.links).toEqual([]);
    expect((await t.send("DELETE", ["links", id])).body.error?.message).toBe("Link not found.");
  });
});

describe("GET …/canvas with the saved layout", () => {
  it("carries the saved positions of its cards and its links by uuid; can_edit follows deploy.resource.write", async () => {
    const t = setup();
    await t.send("PATCH", ["positions"], { positions: { web: { x: 1, y: 2 } } });
    const link = (await t.send("POST", ["links"], { source: "web", target: "pg", label: "db" })).body.data!;
    const r = await t.get();
    expect(r.body.data).toMatchObject({ can_edit: true, positions: { web: { x: 1, y: 2 } }, links: [{ id: link.id, source: "web", target: "pg", label: "db" }] });
    const reader = setup({ write: false });
    expect((await reader.get()).body.data).toMatchObject({ can_edit: false });
  });

  it("canvasLinks leaves out a link with an end that is not a card; filterPositions keeps numeric positions of cards only", () => {
    const rows = [
      { id: 1, uuid: "l1", environment_id: 7, source_type: APP, source_id: 1, target_type: PG, target_id: 1, label: null },
      { id: 2, uuid: "l2", environment_id: 7, source_type: APP, source_id: 9, target_type: PG, target_id: 1, label: null },
    ] as DeployResourceLinkRow[];
    expect(canvasLinks(rows, [{ uuid: "web", type: APP, id: "1" }, { uuid: "pg", type: PG, id: 1 }])).toEqual([{ id: "l1", source: "web", target: "pg", label: null }]);
    expect(filterPositions({ web: { x: "3.9", y: -1.2 }, pg: { x: "a", y: 1 }, api: [1, 2], other: { x: 1, y: 1 } }, ["web", "pg", "api"])).toEqual({ web: { x: 3, y: -1 } });
    expect(filterPositions([], ["web"])).toEqual({});
    expect(filterPositions(null, ["web"])).toEqual({});
    expect(normalizeLabel("  a ")).toBe("a");
    expect(normalizeLabel(null)).toBeNull();
    expect(normalizeLabel(12)).toBe("12");
  });
});

describe("authorization and org isolation", () => {
  it("every save asks deploy.resource.write and answers its denial with the same 404, touching nothing", async () => {
    const t = setup({ write: false });
    for (const [method, rest, body] of [
      ["PATCH", ["positions"], { positions: {} }],
      ["POST", ["links"], { source: "web", target: "pg" }],
      ["PATCH", ["links", "l1"], { label: "x" }],
      ["DELETE", ["links", "l1"], undefined],
    ] as const) {
      const r = await t.send(method, [...rest], body);
      expect(r.status).toBe(404);
      expect(r.body.error?.code).toBe("not_found");
    }
    expect(t.runs).toEqual([]);
    expect(t.asked.every((a) => a === "deploy.resource.write")).toBe(true);
  });

  it("another org's project is not found, and nothing of org A changes", async () => {
    const t = setup();
    const r = await t.send("PATCH", ["positions"], { positions: { web: { x: 1, y: 1 } } }, { org: ORG_B });
    expect(r.status).toBe(404);
    expect(r.body.error?.message).toBe("Project not found.");
    expect((await t.send("POST", ["links"], { source: "web", target: "pg" }, { org: ORG_B })).status).toBe(404);
    expect((await t.send("DELETE", ["links", "l1"], undefined, { org: ORG_B })).status).toBe(404);
    expect(t.a.state.saves).toBe(0);
    expect(t.a.state.links).toEqual([]);
    expect(t.runs).toEqual([ORG_B, ORG_B, ORG_B]);
  });

  it("an unknown sub-path is 404 and a wrong method 405", async () => {
    const t = setup();
    expect(isEnvironmentCanvasEdit(["positions"])).toBe(true);
    expect(isEnvironmentCanvasEdit(["links", "abc"])).toBe(true);
    expect(isEnvironmentCanvasEdit(["links", "a/b"])).toBe(false);
    expect(isEnvironmentCanvasEdit(["positions", "x"])).toBe(false);
    expect((await t.send("PATCH", ["zones"], { positions: {} })).status).toBe(404);
    expect((await t.send("GET", ["positions"])).status).toBe(405);
    expect((await t.send("DELETE", ["links"])).status).toBe(405);
    expect((await t.send("POST", ["links", "abc"], { label: "x" })).status).toBe(405);
  });

  it("is routed by route() behind the identity check", async () => {
    const bare = { ENVIRONMENT: "test" } as Env;
    const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user", "content-type": "application/json" };
    const url = `${BASE}/projects/${PROJECT}/environments/${ENVIRONMENT}/canvas/positions`;
    expect((await route(new Request(url, { method: "PATCH", body: "{}" }), bare)).status).toBe(401);
    // Past the identity check, it reaches the handler, which needs the database.
    expect((await route(new Request(url, { method: "PATCH", headers, body: JSON.stringify({ positions: {} }) }), bare)).status).toBe(503);
    expect((await route(new Request(`${url.replace("/positions", "/links/abc")}`, { method: "DELETE", headers }), bare)).status).toBe(503);
  });
});
