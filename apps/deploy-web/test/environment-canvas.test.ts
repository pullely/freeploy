// The environment canvas's model (DP-91), from the API's graph: zones (one per server, then
// "No server"), the cards' places in them, the zone frames, the link curves, the status tones
// and words, fit, and the saved view. The expectations follow Coolify 91b7e3e's
// resources/js/environment-canvas.test.js where it covers the same helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CARD_WIDTH,
  COLUMN_GAP,
  canLink,
  estimateNodeHeight,
  fitView,
  layoutGraph,
  linkPath,
  MAX_ROWS,
  normalizeGraph,
  readView,
  ROW_GAP,
  statusLabel,
  statusSummary,
  statusTone,
  statusWord,
  unreachableZones,
  zoneBoxes,
  ZONE_GAP,
  ZONE_HEADER,
  ZONE_PADDING,
  zoneGroups,
  zoomShortcut,
  type CanvasGraph,
  type CanvasNode,
} from "../src/lib/environment-canvas.ts";

/** What GET …/environments/{env_uuid}/canvas answers for an environment on two servers (one unreachable). */
const payload = {
  project: { uuid: "p1", name: "My project", link: "/project/p1" },
  environment: { uuid: "e1", name: "production", link: "/project/p1/environment/e1" },
  can_edit: false,
  zones: [
    { id: "srv-a", name: "server-a", ip: null, is_reachable: true, is_usable: true, link: "/server/srv-a" },
    { id: "srv-b", name: "server-b", ip: null, is_reachable: false, is_usable: false, link: "/server/srv-b" },
  ],
  nodes: [
    { id: "app1", type: "application", name: "web", status: "running:healthy", zone: "srv-a", extra_zones: [], urls: ["https://web.example.com"], subtitle: "Nixpacks · main", children: [], link: "/project/p1/environment/e1/application/app1" },
    { id: "db1", type: "database", name: "pg", status: "exited:unhealthy", zone: "srv-a", extra_zones: [], urls: [], subtitle: "PostgreSQL · postgres:17", children: [], link: "/project/p1/environment/e1/database/db1" },
    {
      id: "svc1",
      type: "service",
      name: "umami",
      status: "starting:unhealthy",
      zone: "srv-b",
      extra_zones: [],
      urls: [],
      subtitle: "Service · 2 containers",
      children: [
        { name: "umami", type: "application", status: "running:healthy" },
        { name: "postgresql", type: "database", status: "running:healthy" },
      ],
      link: "/project/p1/environment/e1/service/svc1",
    },
    { id: "app2", type: "application", name: "orphan", status: "", zone: null, extra_zones: [], urls: [], subtitle: "Docker Image · nginx:alpine", children: [], link: "/project/p1/environment/e1/application/app2" },
  ],
  links: [],
  // PHP's empty array: no positions.
  positions: [],
} as unknown as Partial<CanvasGraph>;

test("normalizeGraph: the API's graph with empty lists filled and PHP's [] positions as none", () => {
  const g = normalizeGraph(payload);
  assert.deepEqual(g.positions, {});
  assert.equal(g.nodes.length, 4);
  assert.deepEqual(normalizeGraph(null), { zones: [], nodes: [], links: [], positions: {} });
});

test("zoneGroups: the zones in the API's order with their cards, then 'No server'", () => {
  const groups = zoneGroups(normalizeGraph(payload));
  assert.deepEqual(
    groups.map((g) => [g.id, g.name, g.nodes.map((n) => n.id)]),
    [
      ["srv-a", "server-a", ["app1", "db1"]],
      ["srv-b", "server-b", ["svc1"]],
      [null, "No server", ["app2"]],
    ],
  );
  // A zone without cards is not drawn; a card naming an unknown zone goes to "No server".
  const g = normalizeGraph({ zones: [{ id: "z", name: "empty" }], nodes: [{ id: "n", type: "application", name: "n", zone: "gone" }] });
  assert.deepEqual(
    zoneGroups(g).map((z) => z.id),
    [null],
  );
});

test("estimateNodeHeight: name row, a URL row, the children list with its '+N more' row", () => {
  const node = (over: Partial<CanvasNode>): CanvasNode => ({ id: "n", type: "application", name: "n", ...over });
  assert.equal(estimateNodeHeight(node({})), 58);
  assert.equal(estimateNodeHeight(node({ urls: ["https://a"] })), 78);
  assert.equal(estimateNodeHeight(node({ children: [{ name: "a" }, { name: "b" }] })), 58 + 12 + 40);
  assert.equal(estimateNodeHeight(node({ children: Array.from({ length: 7 }, (_, i) => ({ name: String(i) })) })), 58 + 12 + 100 + 20);
});

test("layoutGraph: each zone stacks below the last; applications, services and databases in their own columns", () => {
  const g = normalizeGraph(payload);
  const at = layoutGraph(g);
  const top = ZONE_HEADER + ZONE_PADDING;
  // server-a: the application in the first column, the database in the next one (no service column there).
  assert.deepEqual(at.app1, { x: 0, y: top });
  assert.deepEqual(at.db1, { x: CARD_WIDTH + COLUMN_GAP, y: top });
  // server-b starts below server-a's tallest card.
  const aBottom = top + Math.max(estimateNodeHeight(g.nodes[0]!), estimateNodeHeight(g.nodes[1]!));
  const bTop = aBottom + ZONE_PADDING + ZONE_GAP + ZONE_HEADER + ZONE_PADDING;
  assert.deepEqual(at.svc1, { x: 0, y: bTop });
  assert.equal(at.app2!.y, bTop + estimateNodeHeight(g.nodes[2]!) + ZONE_PADDING + ZONE_GAP + ZONE_HEADER + ZONE_PADDING);
});

test("layoutGraph: a type wraps into another column after MAX_ROWS cards; saved positions win", () => {
  const nodes = Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ id: `a${i}`, type: "application" as const, name: `a${i}`, zone: "z" }));
  const at = layoutGraph(normalizeGraph({ zones: [{ id: "z", name: "z" }], nodes }));
  assert.equal(at[`a${MAX_ROWS - 1}`]!.x, 0);
  assert.deepEqual(at[`a${MAX_ROWS}`], { x: CARD_WIDTH + COLUMN_GAP, y: ZONE_HEADER + ZONE_PADDING });
  const saved = layoutGraph(normalizeGraph({ zones: [{ id: "z", name: "z" }], nodes: nodes.slice(0, 2), positions: { a0: { x: 500, y: 300 } } }));
  assert.deepEqual(saved.a0, { x: 500, y: 300 });
  // A new card goes below the saved one, from its left edge.
  assert.deepEqual(saved.a1, { x: 500, y: 300 + 58 + ROW_GAP });
});

test("zoneBoxes: a frame around each zone's cards, with the header above them", () => {
  const g = normalizeGraph(payload);
  const at = layoutGraph(g);
  const sizes = { app1: { width: 260, height: 80 }, db1: { width: 260, height: 60 } };
  const [a] = zoneBoxes(g, at, sizes);
  assert.deepEqual(
    { id: a!.id, nodes: a!.nodes, x: a!.x, y: a!.y, width: a!.width, height: a!.height },
    { id: "srv-a", nodes: ["app1", "db1"], x: -ZONE_PADDING, y: 0, width: 2 * CARD_WIDTH + COLUMN_GAP + 2 * ZONE_PADDING, height: 80 + 2 * ZONE_PADDING + ZONE_HEADER },
  );
  assert.deepEqual(
    zoneBoxes(g, at, sizes).map((b) => b.name),
    ["server-a", "server-b", "No server"],
  );
});

test("linkPath: right edge to left edge side by side, bottom to top when stacked", () => {
  const right = linkPath({ x: 0, y: 0, width: 100, height: 40 }, { x: 200, y: 100, width: 100, height: 40 });
  assert.equal(right.side, "right");
  assert.deepEqual([right.from, right.to], [
    { x: 100, y: 20 },
    { x: 200, y: 120 },
  ]);
  assert.equal(right.d, "M 100 20 C 150 20, 150 120, 200 120");
  assert.deepEqual(right.mid, { x: 150, y: 70 });
  const down = linkPath({ x: 0, y: 0, width: 100, height: 40 }, { x: 20, y: 200, width: 100, height: 40 });
  assert.equal(down.side, "down");
  assert.equal(down.d, "M 50 40 C 50 120, 70 120, 70 200");
  assert.equal(linkPath({ x: 300, y: 0, width: 100, height: 40 }, { x: 0, y: 0, width: 100, height: 40 }).side, "left");
  assert.equal(linkPath({ x: 0, y: 300, width: 100, height: 40 }, { x: 0, y: 0, width: 100, height: 40 }).side, "up");
});

test("canLink: two different cards that are not linked yet, either way round", () => {
  const links = [{ id: "l1", source: "a", target: "b" }];
  assert.equal(canLink(links, "a", "c"), true);
  assert.equal(canLink(links, "b", "a"), false);
  assert.equal(canLink(links, "a", "a"), false);
});

test("statusTone, statusLabel and statusWord read Coolify's status strings", () => {
  assert.equal(statusTone("running:healthy"), "ok");
  assert.equal(statusTone("running:unhealthy"), "warn");
  assert.equal(statusTone("running (unhealthy)"), "warn");
  assert.equal(statusTone("starting:unhealthy"), "busy");
  assert.equal(statusTone("running:starting"), "busy");
  assert.equal(statusTone("exited:unhealthy"), "bad");
  assert.equal(statusTone("degraded:unhealthy"), "warn");
  assert.equal(statusTone(""), "idle");
  assert.equal(statusTone(null), "idle");
  assert.equal(statusTone("unknown"), "idle");
  assert.equal(statusLabel("running:healthy"), "Running (healthy)");
  assert.equal(statusLabel("in_progress"), "In progress");
  assert.equal(statusLabel(""), "Unknown");
  assert.equal(statusWord("exited:unhealthy"), "Exited");
});

test("statusSummary counts the resource cards per tone; unreachableZones names the servers that are down", () => {
  const g = normalizeGraph(payload);
  assert.deepEqual(statusSummary(g.nodes), { ok: 1, warn: 0, bad: 1, busy: 1, idle: 1 });
  assert.deepEqual([...unreachableZones(g)], ["srv-b"]);
  assert.deepEqual([...unreachableZones(null)], []);
});

test("fitView: centres content that fits, keeps it readable when it does not", () => {
  const view = fitView({ minX: 0, minY: 0, maxX: 400, maxY: 200 }, { left: 0, top: 0, width: 1000, height: 600 });
  assert.equal(view.z, 1.1);
  assert.deepEqual(view, { z: 1.1, x: (1000 - 440) / 2, y: (600 - 220) / 2 });
  const big = fitView({ minX: 0, minY: 0, maxX: 10000, maxY: 10000 }, { left: 0, top: 0, width: 1000, height: 600 }, true);
  assert.equal(big.z, 0.6);
  assert.deepEqual([big.x, big.y], [48, 48]);
});

test("zoomShortcut and readView", () => {
  assert.equal(zoomShortcut({ ctrlKey: true, metaKey: false, altKey: false, key: "=" }), "in");
  assert.equal(zoomShortcut({ ctrlKey: false, metaKey: true, altKey: false, key: "-" }), "out");
  assert.equal(zoomShortcut({ ctrlKey: true, metaKey: false, altKey: false, key: "0" }), "reset");
  assert.equal(zoomShortcut({ ctrlKey: false, metaKey: false, altKey: false, key: "=" }), null);
  const storage = (value: string | null) => ({ getItem: () => value });
  assert.deepEqual(readView("k", storage(JSON.stringify({ x: 1, y: 2, z: 1.5 }))), { x: 1, y: 2, z: 1.5 });
  assert.equal(readView("k", storage(JSON.stringify({ x: 1, y: 2, z: 9 }))), null);
  assert.equal(readView("k", storage("{")), null);
  assert.equal(readView("k", storage(null)), null);
});
