// The environment canvas's editing model (DP-92): canvas-core.js' freeSpot, dragRules (a dragged
// card stops before it covers another card or zone), dragging a zone, canConnect and canLink for a
// new link, the saved positions coming back from the API, and ApiError's message from Freeploy's
// error envelope. The drag expectations follow Coolify 91b7e3e's resources/js/environment-canvas.test.js
// ('a dragged card stops before it covers a card or another zone').
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apart,
  BOX_GAP,
  CARD_WIDTH,
  canConnect,
  canLink,
  canvasErrorMessage,
  dragRules,
  estimateNodeHeight,
  freeSpot,
  layoutGraph,
  normalizeGraph,
  toBox,
  zoneBoxes,
  type CanvasGraph,
  type CanvasNode,
  type Point,
} from "../src/lib/environment-canvas.ts";

const node = (id: string, type: CanvasNode["type"], zone: string | null, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, type, zone, name: id, status: "running:healthy", extra_zones: [], urls: [], children: [], ...extra });
const graph = (nodes: CanvasNode[], extra: Partial<CanvasGraph> = {}): CanvasGraph => ({
  zones: [
    { id: "s1", name: "One" },
    { id: "s2", name: "Two" },
  ],
  nodes,
  links: [],
  positions: {},
  ...extra,
});
const rectApart = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

/** Drags card `id` to the top-left of `onto`, as the canvas does: it stops at the nearest free spot. */
function dragOnto(g: CanvasGraph, positions: Record<string, Point>, id: string, onto: string) {
  const { others, fits } = dragRules(g, positions, {}, id);
  const card = g.nodes.find((n) => n.id === id)!;
  const start = { ...positions[id]!, w: CARD_WIDTH, h: estimateNodeHeight(card) };
  assert.deepEqual(freeSpot(start, others, undefined, fits), start, "the laid out card is already free, so it does not jump");
  const spot = freeSpot({ ...start, ...positions[onto]! }, others, undefined, fits)!;
  return { ...positions, [id]: { x: spot.x, y: spot.y } };
}

test("freeSpot: the box itself when it is free, else the nearest spot against an edge of what is in the way", () => {
  const wall = { x: 0, y: 0, w: 100, h: 100 };
  assert.deepEqual(freeSpot({ x: 200, y: 0, w: 50, h: 50 }, [wall]), { x: 200, y: 0, w: 50, h: 50 });
  // Dropped onto the wall's right part: pushed out to its right edge plus the gap.
  assert.deepEqual(freeSpot({ x: 80, y: 10, w: 50, h: 50 }, [wall]), { x: 100 + BOX_GAP, y: 10, w: 50, h: 50 });
  // A spot that `fits` refuses is not taken.
  assert.equal(freeSpot({ x: 80, y: 10, w: 50, h: 50 }, [wall], BOX_GAP, () => false), null);
  assert.equal(apart({ x: 0, y: 0, w: 10, h: 10 }, { x: 10 + BOX_GAP, y: 0, w: 10, h: 10 }), true);
});

test("a dragged card stops before it covers a card or another zone", () => {
  const g = graph([node("a", "application", "s1"), node("b", "database", "s1"), node("c", "application", "s2")]);
  const before = layoutGraph(g);
  for (const [id, onto] of [
    ["a", "b"],
    ["a", "c"],
    ["c", "a"],
  ] as const) {
    const positions = dragOnto(g, before, id, onto);
    const rects = Object.fromEntries(g.nodes.map((n) => [n.id, { ...positions[n.id]!, width: CARD_WIDTH, height: estimateNodeHeight(n) }]));
    for (const n of g.nodes) if (n.id !== id) assert.ok(rectApart(rects[id]!, rects[n.id]!), `${id} does not cover ${n.id}`);
    const [z1, z2] = zoneBoxes(g, positions);
    assert.ok(rectApart(z1!, z2!), "the zones do not overlap");
  }
});

test("a dragged zone (all its cards) stops at the edge of another zone", () => {
  const g = graph([node("a", "application", "s1"), node("c", "application", "s2")]);
  const positions = layoutGraph(g);
  const [z1, z2] = zoneBoxes(g, positions);
  // Drop zone Two straight onto zone One.
  const spot = freeSpot({ ...toBox(z2!), x: z1!.x, y: z1!.y }, [toBox(z1!)])!;
  assert.ok(apart(spot, toBox(z1!)));
  const moved = { ...positions, c: { x: positions.c!.x + spot.x - z2!.x, y: positions.c!.y + spot.y - z2!.y } };
  const [after1, after2] = zoneBoxes(g, moved);
  assert.ok(rectApart(after1!, after2!));
  assert.deepEqual(after1, z1, "the other zone stays where it was");
});

test("saved positions (canvas_positions) place the cards; a card without one goes below the saved ones of its zone", () => {
  const g = normalizeGraph(graph([node("a", "application", "s1"), node("b", "database", "s1")], { positions: { a: { x: 500, y: 300 } } }));
  const positions = layoutGraph(g);
  assert.deepEqual(positions.a, { x: 500, y: 300 });
  assert.equal(positions.b!.x, 500);
  assert.ok(positions.b!.y >= 300 + estimateNodeHeight(g.nodes[0]!));
});

test("canConnect and canLink: a new link joins two different cards that are not linked yet, either way round", () => {
  const g = graph([node("a", "application", "s1"), node("b", "database", "s1")], { links: [{ id: "l1", source: "a", target: "b", label: null }] });
  assert.equal(canConnect(g, "a", "b"), true);
  assert.equal(canConnect(g, "a", "a"), false);
  assert.equal(canConnect(null, "a", "b"), false);
  assert.equal(canLink(g.links, "a", "b"), false);
  assert.equal(canLink(g.links, "b", "a"), false);
  assert.equal(canLink([], "a", "b"), true);
});

test("canvasErrorMessage: ApiError's message from the edge's error, then each field error that is not it", () => {
  const validation = { error: { message: "Validation failed.", details: { fields: { target: ["These resources are already linked."] } } } };
  assert.equal(canvasErrorMessage(422, validation), "Validation failed. These resources are already linked.");
  assert.equal(canvasErrorMessage(404, { error: { message: "Link not found." } }), "Link not found.");
  assert.equal(canvasErrorMessage(500, null), "Request failed (HTTP 500).");
  assert.equal(canvasErrorMessage(422, { error: { message: "x", details: { fields: { a: ["x", "y"] } } } }), "x y");
});
