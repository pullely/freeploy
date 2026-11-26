// The server and connect views of the environment canvas's model (DP-98): the projects, servers and
// dashboard canvases' project / environment groups, the zones' saved places, the shared variable and
// tag canvases' connect layout, the filters, canConnect's rules, the dragged card's group rules, and
// the dashboard's deployment rows. The expectations follow Coolify 91b7e3e's
// resources/js/environment-canvas.test.js ('server view: …', 'variables view: …', 'projects canvas: …').
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CARD_WIDTH,
  COLUMN_GAP,
  CONNECT_TEXT,
  GROUP_GAP,
  MAX_ROWS,
  ROW_GAP,
  SERVER_ZONE_HEADER,
  ZONE_GAP,
  ZONE_HEADER,
  ZONE_PADDING,
  canConnect,
  compareEnvironmentNames,
  dragRules,
  estimateNodeHeight,
  filterGraph,
  filterOptions,
  freeSpot,
  groupByUse,
  groupFrames,
  groupKey,
  layoutBlock,
  layoutGraph,
  layoutServerView,
  zoneBoxes,
  ago,
  deploymentStatus,
  type CanvasGraph,
  type CanvasNode,
  type GroupMeta,
  type Point,
} from "../src/lib/environment-canvas.ts";

type Loose = Record<string, unknown>;
const asGraph = (g: Loose): CanvasGraph => ({ zones: [], nodes: [], links: [], positions: {}, ...g }) as CanvasGraph;
const node = (id: string, type: string, zone: string | null, extra: Loose = {}) => ({ id, type, zone, name: id, status: "running:healthy", extra_zones: [], urls: [], children: [], ...extra }) as CanvasNode;
const srv = (id: string, type: string, context: string, extra: Loose = {}) => ({ id, type, name: id, zone: "z1", context, ...extra }) as CanvasNode;
const envNode = (id: string, type: string, zone: string, environment: string, extra: Loose = {}) => srv(id, type, `Shop / ${environment}`, { zone, project: { uuid: "p", name: "Shop" }, environment: { uuid: environment, name: environment }, ...extra });
const rectApart = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

test("server view: a chain of linked cards runs left to right, source before target", () => {
  const nodes = [srv("db", "database", "A / prod"), srv("web", "application", "A / prod"), srv("api", "application", "A / prod")];
  const { positions } = layoutBlock(nodes, [
    { id: "1", source: "web", target: "api" },
    { id: "2", source: "api", target: "db" },
  ]);
  assert.equal(positions.web!.y, positions.api!.y);
  assert.equal(positions.api!.y, positions.db!.y);
  assert.ok(positions.web!.x < positions.api!.x && positions.api!.x < positions.db!.x);
  assert.equal(positions.api!.x - positions.web!.x, CARD_WIDTH + COLUMN_GAP);
});

test("server view: cards without links go below the chains, in a grid; a cycle still places every card", () => {
  const nodes = [srv("a", "application", "g"), srv("b", "application", "g"), srv("c", "service", "g"), srv("d", "database", "g"), srv("e", "database", "g")];
  const { positions } = layoutBlock(nodes, [{ id: "1", source: "a", target: "d" }]);
  assert.equal(positions.a!.y, positions.d!.y);
  for (const id of ["b", "c", "e"]) assert.ok(positions[id]!.y > positions.a!.y, `${id} is below the chain`);
  assert.equal(positions.b!.y, positions.c!.y);
  const cycle = layoutBlock([srv("x", "application", "g"), srv("y", "application", "g")], [
    { id: "1", source: "x", target: "y" },
    { id: "2", source: "y", target: "x" },
  ]).positions;
  assert.ok(cycle.x && cycle.y);
  assert.notDeepEqual(cycle.x, cycle.y);
});

test("server view: one frame per project / environment, production, staging and development first", () => {
  const g = asGraph({ layout: "server", zones: [{ id: "z1", name: "web" }], nodes: [srv("a", "application", "Shop / prod"), srv("b", "database", "Shop / prod"), srv("c", "application", "Blog / prod")], links: [{ id: "l", source: "a", target: "b" }] });
  const positions = layoutGraph(g);
  const frames = groupFrames(g.nodes, positions);
  assert.deepEqual(
    frames.map((f) => f.name),
    ["Blog / prod", "Shop / prod"],
  );
  assert.ok(rectApart(frames[0]!, frames[1]!));
  assert.equal(positions.a!.y, positions.b!.y);

  const env = (id: string, project: string, environment: string) => srv(id, "application", `${project} / ${environment}`, { project: { uuid: project, name: project }, environment: { uuid: id, name: environment } });
  const ordered = asGraph({ layout: "server", zones: [{ id: "z1", name: "web" }], nodes: [env("a", "Shop", "deprecated"), env("b", "Shop", "development"), env("c", "Shop", "production"), env("d", "Shop", "qa"), env("e", "Shop", "staging"), env("f", "Blog", "zeta")] });
  assert.deepEqual(
    groupFrames(ordered.nodes, layoutGraph(ordered)).map((f) => f.name),
    ["Blog / zeta", "Shop / production", "Shop / staging", "Shop / development", "Shop / deprecated", "Shop / qa"],
  );
  assert.ok(compareEnvironmentNames("Production", "alpha") < 0);
});

test("server view: cards keep the arrangement saved on their environment canvas, new cards go below; positions of its own are ignored", () => {
  const g = asGraph({
    layout: "server",
    zones: [{ id: "z1", name: "web" }],
    nodes: [envNode("a", "application", "z1", "prod", { saved: { x: 900, y: 700 } }), envNode("b", "database", "z1", "prod", { saved: { x: 600, y: 900 } }), envNode("c", "service", "z1", "prod")],
  });
  const p = layoutServerView(g);
  assert.equal(p.a!.x - p.b!.x, 300);
  assert.equal(p.b!.y - p.a!.y, 200);
  assert.equal(p.c!.x, p.b!.x);
  assert.ok(p.c!.y >= p.b!.y + estimateNodeHeight(g.nodes[1]!) + ROW_GAP);
  assert.deepEqual(layoutServerView({ ...g, positions: { a: { x: 1, y: 2 } } } as never), p);
});

test("server view: a group with one saved card matches the environment canvas arrangement", () => {
  const apps = Array.from({ length: MAX_ROWS + 1 }, (_, i) => envNode(`n${i}`, "application", "z1", "prod"));
  const nodes = [envNode("a", "application", "z1", "prod", { saved: { x: 1000, y: 697 } }), ...apps, envNode("d", "database", "z1", "prod")];
  const env = layoutGraph(asGraph({ zones: [{ id: "z1", name: "web" }], nodes, positions: { a: { x: 1000, y: 697 } } }));
  const server = layoutServerView(asGraph({ layout: "server", zones: [{ id: "z1", name: "web" }], nodes, links: [{ id: "l", source: "n0", target: "d" }] }));
  for (const n of nodes) assert.deepEqual({ x: server[n.id]!.x - server.a!.x, y: server[n.id]!.y - server.a!.y }, { x: env[n.id]!.x - env.a!.x, y: env[n.id]!.y - env.a!.y }, n.id);
});

test("server view: a moved card saved with its group on the environment canvas stays where it was dropped", () => {
  const nodes = [envNode("a", "application", "z1", "prod"), envNode("b", "service", "z1", "prod"), envNode("d", "database", "z1", "prod")];
  const g = asGraph({ layout: "server", zones: [{ id: "z1", name: "web" }], nodes });
  const groups: Record<string, GroupMeta> = {};
  const before = layoutServerView(g, groups);
  const { shift } = groups["prod:z1"]!;
  const dropped = { ...before, b: { x: before.b!.x + 120, y: before.b!.y + 400 } };
  const saved = Object.fromEntries(nodes.map((n) => [n.id, { x: dropped[n.id]!.x - shift.x, y: dropped[n.id]!.y - shift.y }]));
  assert.deepEqual(layoutServerView({ ...g, nodes: nodes.map((n) => ({ ...n, saved: saved[n.id] })) }), dropped);
});

test("server view: zones with server details get the taller header; groups sit where their cards are saved, inside the zone", () => {
  const details = asGraph({ layout: "server", zones: [{ id: "z1", name: "web", details: { os: "Ubuntu" } }], nodes: [envNode("a", "application", "z1", "prod")] });
  const positions = layoutServerView(details);
  assert.equal(zoneBoxes(details, positions)[0]!.y, 0);
  assert.ok(positions.a!.y > SERVER_ZONE_HEADER);

  const g = asGraph({
    layout: "server",
    zones: [{ id: "z1", name: "web" }],
    nodes: [envNode("a", "application", "z1", "prod", { saved: { x: 0, y: ZONE_HEADER + ZONE_PADDING } }), envNode("b", "application", "z1", "stage", { saved: { x: 600, y: ZONE_HEADER + ZONE_PADDING } }), envNode("c", "application", "z1", "dev")],
  });
  const groups: Record<string, GroupMeta> = {};
  const p = layoutServerView(g, groups);
  assert.equal(groups["prod:z1"]!.x, 0);
  assert.equal(groups["prod:z1"]!.y, groups["prod:z1"]!.inner.y);
  assert.equal(p.b!.x - p.a!.x, 600);
  const { shift } = groups["prod:z1"]!;
  assert.deepEqual({ x: p.b!.x - shift.x, y: p.b!.y - shift.y }, { x: 600, y: ZONE_HEADER + ZONE_PADDING });
  assert.ok(p.c!.y > p.a!.y + estimateNodeHeight(g.nodes[0]!));

  const left: Record<string, GroupMeta> = {};
  layoutServerView(asGraph({ layout: "server", zones: [{ id: "z1", name: "web" }], nodes: [envNode("a", "application", "z1", "prod", { saved: { x: -236, y: 251 } })] }), left);
  assert.equal(left["prod:z1"]!.x, left["prod:z1"]!.inner.x);
});

test("server view: the unmanaged containers group comes first; an empty environment sits right of its project's groups", () => {
  const g = asGraph({ layout: "server", zones: [{ id: "z1", name: "web" }], nodes: [node("a", "application", "z1", { context: "Alpha / prod" }), node("container:1", "container", "z1", { context: "Unmanaged containers" })] });
  const positions = layoutServerView(g);
  assert.ok(positions["container:1"]!.x < positions.a!.x);

  const shop = { uuid: "shop", name: "Shop" };
  const app = (id: string, context: string, extra: Loose = {}) => ({ id, type: "application", zone: "srv", context, project: shop, environment: { uuid: context, name: context }, ...extra }) as CanvasNode;
  const out = layoutServerView(asGraph({ layout: "server", zones: [{ id: "srv", name: "srv" }], nodes: [app("a", "Shop / staging", { saved: { x: 0, y: 0 } }), app("empty:prod", "Shop / production", { type: "empty" })] }));
  assert.equal(out["empty:prod"]!.y, out.a!.y);
  assert.ok(out["empty:prod"]!.x >= out.a!.x + CARD_WIDTH);
});

test("groupKey: a group with only an empty-environment placeholder has no key, so it cannot be moved", () => {
  const environment = { uuid: "env", name: "production" };
  assert.equal(groupKey([{ id: "empty:env", type: "empty", environment } as CanvasNode], "empty"), null);
  assert.equal(groupKey([{ id: "a", type: "application", environment } as CanvasNode], "srv"), "env:srv");
});

test("projects canvas: a zone with a saved place sits there; zones without one stack below it", () => {
  const g = asGraph({ layout: "server", zones: [{ id: "z1", name: "Blog" }, { id: "z2", name: "Shop", position: { x: 900, y: -400 } }], nodes: [envNode("a", "application", "z1", "prod"), envNode("b", "application", "z2", "prod")] });
  const groups: Record<string, GroupMeta> = {};
  const zones: Record<string, Point> = {};
  const positions = layoutServerView(g, groups, { zones });
  assert.deepEqual(zones, { z1: { x: 0, y: 0 }, z2: { x: 900, y: -400 } });
  const box = zoneBoxes(g, positions).find((z) => z.id === "z2")!;
  assert.deepEqual({ x: box.x + ZONE_PADDING, y: box.y }, { x: 900, y: -400 });
  assert.equal(groups["prod:z2"]!.inner.y, -400 + ZONE_HEADER + ZONE_PADDING);

  const stacked = asGraph({ layout: "server", zones: [{ id: "z1", name: "Blog", position: { x: 0, y: 0 } }, { id: "z2", name: "Shop" }, { id: "z3", name: "Wiki" }], nodes: [envNode("a", "application", "z1", "prod"), envNode("b", "application", "z2", "prod"), envNode("c", "application", "z3", "prod")] });
  const boxes = Object.fromEntries(zoneBoxes(stacked, layoutServerView(stacked)).map((z) => [z.id, z]));
  assert.ok(boxes.z2!.y >= boxes.z1!.y + boxes.z1!.height + ZONE_GAP);
  assert.ok(boxes.z3!.y >= boxes.z2!.y + boxes.z2!.height + ZONE_GAP);
});

test("server view: a dragged card stops before its group covers another group, and cannot bring it closer than the layout does", () => {
  const g = asGraph({ layout: "server", zones: [{ id: "z1", name: "web" }], nodes: [srv("a", "application", "Shop / prod"), srv("b", "database", "Shop / prod"), srv("c", "application", "Blog / prod")] });
  const before = layoutGraph(g);
  const { others, fits } = dragRules(g, before, {}, "a");
  const start = { ...before.a!, w: CARD_WIDTH, h: estimateNodeHeight(g.nodes[0]!) };
  assert.deepEqual(freeSpot(start, others, undefined, fits), start, "the laid out card is already free");
  const spot = freeSpot({ ...start, ...before.c! }, others, undefined, fits)!;
  const [f1, f2] = groupFrames(g.nodes, { ...before, a: { x: spot.x, y: spot.y } });
  assert.ok(rectApart(f1!, f2!), "the project / environment frames do not overlap");

  const two = asGraph({ layout: "server", zones: [{ id: "z1", name: "web" }], nodes: [srv("a", "application", "Shop / prod"), srv("c", "application", "Blog / prod")] });
  const laid = layoutServerView(two);
  const rules = dragRules(two, laid, {}, "a");
  const at = { ...laid.a!, w: CARD_WIDTH, h: estimateNodeHeight(two.nodes[0]!) };
  assert.equal(freeSpot({ ...at, x: at.x - 10 }, rules.others, undefined, rules.fits), null);
  // Measured cards wider than the estimate: the card can stay and move away, not closer.
  const measured = dragRules(two, laid, { c: { width: CARD_WIDTH + 20, height: estimateNodeHeight(two.nodes[1]!) } }, "a");
  assert.ok(measured.fits(at));
  assert.ok(measured.fits({ ...at, x: at.x + 50 }));
  assert.ok(!measured.fits({ ...at, x: at.x - 10 }));
  assert.ok(GROUP_GAP > 0);
});

test("server view: cards link only to cards of the same environment; connect view: from an existing source to a resource", () => {
  const g = asGraph({ layout: "server", nodes: [envNode("a", "application", "z1", "prod"), envNode("b", "database", "z2", "prod"), envNode("c", "application", "z1", "dev"), { id: "container:1", type: "container", zone: "z1" }] });
  assert.equal(canConnect(g, "a", "b"), true);
  assert.equal(canConnect(g, "a", "c"), false);
  assert.equal(canConnect(g, "a", "a"), false);
  assert.equal(canConnect(g, "a", "container:1"), false);
  assert.equal(canConnect(g, "container:1", "a"), false);

  const c = asGraph({ layout: "connect", nodes: [node("variable:1", "variable", "sources"), node("variable:2", "variable", "sources"), node("missing:OLD", "variable", "sources", { missing: true }), node("app", "application", "resources")] });
  assert.equal(canConnect(c, "variable:1", "app"), true);
  assert.equal(canConnect(c, "app", "variable:1"), false);
  assert.equal(canConnect(c, "variable:1", "variable:2"), false);
  assert.equal(canConnect(c, "missing:OLD", "app"), false);
  assert.equal(canConnect(asGraph({ nodes: c.nodes }), "app", "variable:1"), true, "other canvases link any two cards");
});

test("variables view: variables stack on the left by name, resources sit to their right", () => {
  const g = asGraph({
    layout: "connect",
    zones: [
      { id: "sources", name: "Team variables", icon: "variable" },
      { id: "resources", name: "Resources", icon: "service" },
    ],
    nodes: [node("variable:2", "variable", "sources", { name: "TOKEN" }), node("variable:1", "variable", "sources", { name: "API_URL" }), node("app", "application", "resources", { context: "Shop / prod" })],
    links: [{ id: "variable:1|app", source: "variable:1", target: "app" }],
  });
  const p = layoutGraph(g);
  assert.equal(p["variable:1"]!.x, 0);
  assert.equal(p["variable:2"]!.x, 0);
  assert.ok(p["variable:1"]!.y < p["variable:2"]!.y);
  assert.ok(p.app!.x > CARD_WIDTH + ZONE_PADDING * 2);
  const [variables, resources] = zoneBoxes(g, p);
  assert.ok(variables!.x + variables!.width < resources!.x, "zones do not overlap");
});

test("variables view: filter resources by project and environment, keep every variable", () => {
  const shop = { uuid: "p1", name: "Shop" };
  const blog = { uuid: "p2", name: "Blog" };
  const g = asGraph({
    layout: "connect",
    nodes: [
      node("variable:1", "variable", "sources"),
      node("a", "application", "resources", { project: shop, environment: { uuid: "e1", name: "production" } }),
      node("b", "application", "resources", { project: shop, environment: { uuid: "e2", name: "staging" } }),
      node("d", "application", "resources", { project: shop, environment: { uuid: "e4", name: "deprecated" } }),
      node("c", "application", "resources", { project: blog, environment: { uuid: "e3", name: "production" } }),
    ],
    links: [
      { id: "l1", source: "variable:1", target: "a" },
      { id: "l2", source: "variable:1", target: "c" },
    ],
  });
  assert.deepEqual(
    filterOptions(g).map((p) => [p.name, p.environments.map((e) => e.name)]),
    [
      ["Blog", ["production"]],
      ["Shop", ["production", "staging", "deprecated"]],
    ],
  );
  assert.equal(filterGraph(g, {}), g);
  const shopOnly = filterGraph(g, { project: "p1" });
  assert.deepEqual(
    shopOnly.nodes.map((n) => n.id),
    ["variable:1", "a", "b", "d"],
  );
  assert.deepEqual(
    shopOnly.links.map((l) => l.id),
    ["l1"],
  );
  assert.deepEqual(
    filterGraph(g, { environment: "e2" }).nodes.map((n) => n.id),
    ["variable:1", "b"],
  );
  assert.deepEqual(filterGraph(g, { environment: "e2" }).links, []);
});

test("variables view: resources that use a variable get their own zone, in one column; saved positions leave no gap", () => {
  const ctx = { context: "Shop / prod" };
  const g = groupByUse(
    asGraph({
      layout: "connect",
      zones: [
        { id: "sources", name: "", icon: "variable" },
        { id: "connected", name: "", icon: "link" },
        { id: "resources", name: "", icon: "service" },
      ],
      nodes: [node("variable:1", "variable", "sources"), node("app", "application", "resources", ctx), node("db", "database", "resources", ctx), node("idle", "application", "resources", ctx)],
      links: [
        { id: "l1", source: "variable:1", target: "app" },
        { id: "l2", source: "variable:1", target: "db" },
      ],
    }),
  );
  assert.deepEqual(
    g.nodes.map((n) => n.zone),
    ["sources", "connected", "connected", "resources"],
  );
  const p = layoutGraph(g);
  assert.equal(p.app!.x, p.db!.x);
  assert.ok(p.db!.y > p.app!.y);
  const boxes = zoneBoxes(g, p);
  const connected = boxes.find((b) => b.id === "connected")!;
  const others = boxes.find((b) => b.id === "resources")!;
  assert.ok(connected.y + connected.height < others.y);

  const saved = asGraph({
    layout: "connect",
    zones: [
      { id: "sources", name: "Server variables", icon: "variable" },
      { id: "resources", name: "Other resources", icon: "service" },
    ],
    nodes: [node("variable:1", "variable", "sources", { name: "COOLIFY_SERVER_NAME" }), node("app", "application", "resources", { context: "Shop / prod", environment: { uuid: "e1", name: "e1" }, saved: { x: 900, y: 1200 } })],
  });
  const [variables, resources] = zoneBoxes(saved, layoutGraph(saved));
  assert.equal(resources!.y, variables!.y);
  assert.ok(resources!.x - (variables!.x + variables!.width) <= ZONE_GAP * 2);
});

test("the connect view's wording, per mode", () => {
  assert.equal(CONNECT_TEXT.variables.added("API_URL", "web"), "Added API_URL to web. Redeploy it to use the variable.");
  assert.equal(CONNECT_TEXT.tags.removed("prod", "web"), "Removed the prod tag from web.");
  assert.equal(CONNECT_TEXT.tags.already("prod", "web"), "web already has the prod tag.");
  assert.equal(CONNECT_TEXT.variables.note({ name: "API_URL", reference: "{{team.API_URL}}" } as CanvasNode), "Adding creates a API_URL variable with the value {{team.API_URL}} on the resource. Redeploy or restart the resource to apply changes.");
});

test("the dashboard's deployment rows: Coolify's status labels and tones, and how long ago", () => {
  assert.deepEqual(deploymentStatus("in_progress"), ["In progress", "busy"]);
  assert.deepEqual(deploymentStatus("finished"), ["Success", "ok"]);
  assert.deepEqual(deploymentStatus("cancelled-by-user"), ["Cancelled", "idle"]);
  assert.deepEqual(deploymentStatus("timed_out"), ["timed out", "idle"]);
  assert.deepEqual(deploymentStatus(null), ["Unknown", "idle"]);
  const now = Date.parse("2026-11-26T12:00:00Z");
  assert.equal(ago("2026-11-26T11:59:30Z", now), "just now");
  assert.equal(ago("2026-11-26T11:57:00Z", now), "3m ago");
  assert.equal(ago("2026-11-26T09:00:00Z", now), "3h ago");
  assert.equal(ago("2026-11-24T12:00:00Z", now), "2d ago");
});
