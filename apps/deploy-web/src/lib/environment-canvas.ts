// Derived from coollabsio/coolify@91b7e3e:resources/js/environment-canvas.js and
// resources/js/canvas-core.js (Apache-2.0), modified.
//
// The environment canvas (Beta, DP-91): its pure model — card sizes, the zones
// (one per server) and the cards' places in them, the frames, the link curves,
// the status tones and words, fit — over the graph that deploy-core-worker's
// GET …/projects/{uuid}/environments/{env_uuid}/canvas answers in
// EnvironmentCanvas::payload()'s shape. DOM-free, so `node --test` imports it.
//
// Only what the environment canvas uses is ported: the server, project, dashboard,
// shared variable and tag canvases (layoutServerView, layoutConnectView, the filters,
// the group frames and drags) are not. DP-92 adds what moves cards and draws links:
// canvas-core.js' freeSpot, dragRules (without the server view's groups), canConnect
// (without the connect and server views' rules) and ApiError's message.

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
/** Space that cards and frames keep between them. */
export const BOX_GAP = 16;

export const CARD_WIDTH = 260;
export const COLUMN_GAP = 48;
export const ROW_GAP = 24;
export const ZONE_GAP = 72;
export const ZONE_PADDING = 24;
export const ZONE_HEADER = 40;
/** Server canvas: a second header row with host facts, proxy and usage. */
export const SERVER_ZONE_HEADER = 68;
/** Server canvas: room for the header (name, IP, status, host facts) above one card. */
export const SERVER_ZONE_MIN_WIDTH = 560;
export const MAX_CHILDREN = 5;
/** Auto placement wraps a type into another column after this many cards. */
export const MAX_ROWS = 6;
export const NO_SERVER = "No server";
export const DOUBLE_CLICK_MS = 400;
export const READABLE_ZOOM = 0.6;
const FIT_PAD = 48;

// ── The graph (EnvironmentCanvas::payload()) ─────────────────────────

export type NodeType = "application" | "service" | "database" | "container" | "variable" | "tag" | "empty";

export interface CanvasLogo {
  src: string;
  dark?: string | null;
  fallback?: string | null;
  padded?: boolean;
  favicon?: string | null;
}

export interface ZoneDetails {
  os?: string | null;
  arch?: string | null;
  cpus?: number | null;
  memory_bytes?: number | null;
  uptime_since?: string | null;
  proxy?: { type: string; status?: string | null } | null;
  usage_endpoint?: string | null;
}

export interface CanvasZone {
  id: string;
  name: string;
  ip?: string | null;
  is_reachable?: boolean;
  is_usable?: boolean;
  link?: string | null;
  icon?: string | null;
  details?: ZoneDetails | null;
}

export interface CanvasChild {
  name: string;
  type?: string;
  status?: string | null;
}

export interface CanvasNode {
  id: string;
  type: NodeType;
  name: string;
  status?: string | null;
  zone?: string | null;
  extra_zones?: string[];
  urls?: string[];
  kind?: string | null;
  subtitle?: string | null;
  children?: CanvasChild[];
  link?: string | null;
  logo?: CanvasLogo | null;
  security?: { text?: string; label?: string; tooltip?: string; status?: string } | null;
  missing?: boolean;
  context?: string;
  deployment?: { status: string; link: string; pull_request_id?: number | null } | null;
}

export interface CanvasLink {
  id: string;
  source: string;
  target: string;
  label?: string | null;
  missing?: boolean;
}

export interface Point {
  x: number;
  y: number;
}

export interface CanvasGraph {
  project?: { uuid: string; name: string; link: string };
  environment?: { uuid: string; name: string; link: string };
  can_edit?: boolean;
  layout?: string;
  zones: CanvasZone[];
  nodes: CanvasNode[];
  links: CanvasLink[];
  positions: Record<string, Point>;
}

/** The API's answer as the canvas reads it: missing lists are empty, a positions list (PHP's empty array) is no positions. */
export function normalizeGraph(data: Partial<CanvasGraph> | null | undefined): CanvasGraph {
  const positions = data?.positions && !Array.isArray(data.positions) ? data.positions : {};
  return { ...data, zones: data?.zones ?? [], nodes: data?.nodes ?? [], links: data?.links ?? [], positions };
}

export interface Size {
  width: number;
  height: number;
}
export interface Rect extends Point, Size {}
export interface Box extends Point {
  w: number;
  h: number;
}

const COLUMNS: Partial<Record<NodeType, number>> = { application: 0, service: 1, database: 2 };
/** Connect view: shared variable and tag cards are link sources; every other card is a resource. */
export const isSource = (node: CanvasNode | null | undefined) => node?.type === "variable" || node?.type === "tag";
const columnOf = (node: CanvasNode) => COLUMNS[node.type] ?? 0;
const columnLeft = (originX: number, column: number) => originX + column * (CARD_WIDTH + COLUMN_GAP);
const isPoint = (p: Point | null | undefined): p is Point => !!p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y));
/** Header height of a zone frame: server canvas zones show a second row of server details. */
export const zoneHeader = (zone: CanvasZone | null | undefined) => (zone?.details ? SERVER_ZONE_HEADER : ZONE_HEADER);

// ── Collisions (canvas-core.js) ──────────────────────────────────────

/** True when boxes a and b are at least `gap` apart. */
export const apart = (a: Box, b: Box, gap = BOX_GAP) => a.x >= b.x + b.w + gap || a.x + a.w + gap <= b.x || a.y >= b.y + b.h + gap || a.y + a.h + gap <= b.y;

/**
 * The free spot nearest to `box` that keeps `gap` clear of every box in `others` (and passes `fits`,
 * when given): the box itself, or it pushed against an edge (or a corner) of the boxes in the way.
 * Null when no such spot is found.
 */
export function freeSpot(box: Box, others: readonly Box[], gap = BOX_GAP, fits: (b: Box) => boolean = () => true): Box | null {
  const free = (b: Box) => others.every((o) => apart(b, o, gap)) && fits(b);
  if (free(box)) return box;
  const xs = [box.x, ...others.flatMap((o) => [o.x - box.w - gap, o.x + o.w + gap])];
  const ys = [box.y, ...others.flatMap((o) => [o.y - box.h - gap, o.y + o.h + gap])];
  let best: Box | null = null;
  let bestDistance = Infinity;
  for (const x of xs) {
    for (const y of ys) {
      const distance = Math.hypot(x - box.x, y - box.y);
      if (distance < bestDistance && free({ ...box, x, y })) {
        best = { ...box, x, y };
        bestDistance = distance;
      }
    }
  }
  return best;
}

// ── Layout ───────────────────────────────────────────────────────────

/** Estimated card height in px; matches the rendered card closely enough for auto placement. */
export function estimateNodeHeight(node: CanvasNode): number {
  let height = 58; // padding + icon/name row
  if (node.urls?.length) height += 20;
  if (node.extra_zones?.length || node.security?.text) height += 28;
  const children = node.children?.length || 0;
  if (children) height += 12 + Math.min(children, MAX_CHILDREN) * 20 + (children > MAX_CHILDREN ? 20 : 0);
  return height;
}

export interface ZoneGroup {
  id: string | null;
  name: string;
  zone: CanvasZone | null;
  nodes: CanvasNode[];
}

/** Zones in display order (graph.zones order, then "No server"), each with its nodes. Empty zones are skipped. */
export function zoneGroups(graph: CanvasGraph): ZoneGroup[] {
  const known = new Set(graph.zones.map((z) => z.id));
  const groups: ZoneGroup[] = graph.zones.map((zone) => ({ id: zone.id, name: zone.name, zone, nodes: [] }));
  const none: ZoneGroup = { id: null, name: NO_SERVER, zone: null, nodes: [] };
  for (const node of graph.nodes) {
    const group = node.zone !== null && node.zone !== undefined && known.has(node.zone) ? groups.find((g) => g.id === node.zone) : undefined;
    (group ?? none).nodes.push(node);
  }
  return [...groups, none].filter((g) => g.nodes.length);
}

/**
 * Places nodes in a grid from (originX, top): applications, then services, then
 * databases, each type in its own column(s) that wrap after MAX_ROWS cards.
 * Returns the bottom of the lowest card (top when there are no nodes).
 */
function placeGrid(nodes: CanvasNode[], originX: number, top: number, out: Record<string, Point>): number {
  let firstColumn = 0;
  let bottom = top;
  for (const column of [0, 1, 2]) {
    const ofType = nodes.filter((n) => columnOf(n) === column);
    const nextY: number[] = [];
    ofType.forEach((n, i) => {
      const sub = Math.floor(i / MAX_ROWS);
      nextY[sub] ??= top;
      out[n.id] = { x: columnLeft(originX, firstColumn + sub), y: nextY[sub] };
      nextY[sub] += estimateNodeHeight(n) + ROW_GAP;
    });
    firstColumn += nextY.length;
    bottom = Math.max(bottom, ...nextY.map((v) => v - ROW_GAP));
  }
  return bottom;
}

/**
 * Card positions (top-left, world px) for every node. Stored positions win;
 * other nodes are placed in their zone: applications left, services middle,
 * databases right. Zones without stored cards stack below everything else.
 */
export function layoutGraph(graph: CanvasGraph): Record<string, Point> {
  const stored = graph.positions;
  const out: Record<string, Point> = {};
  const placedBottom: number[] = [];
  const fresh: ZoneGroup[] = [];
  for (const group of zoneGroups(graph)) {
    const fixed = group.nodes.filter((n) => isPoint(stored[n.id]));
    if (!fixed.length) {
      fresh.push(group);
      continue;
    }
    for (const n of fixed) out[n.id] = { x: Number(stored[n.id]!.x), y: Number(stored[n.id]!.y) };
    const originX = Math.min(...fixed.map((n) => out[n.id]!.x));
    const fixedBottom = Math.max(...fixed.map((n) => out[n.id]!.y + estimateNodeHeight(n)));
    // New cards go in a grid below the saved ones, so they never cover a saved card.
    const bottom = placeGrid(
      group.nodes.filter((n) => !out[n.id]),
      originX,
      fixedBottom + ROW_GAP,
      out,
    );
    placedBottom.push(Math.max(fixedBottom, bottom));
  }
  let y = placedBottom.length ? Math.max(...placedBottom) + ZONE_PADDING + ZONE_GAP : 0;
  for (const group of fresh) {
    y = placeGrid(group.nodes, 0, y + ZONE_HEADER + ZONE_PADDING, out) + ZONE_PADDING + ZONE_GAP;
  }
  return out;
}

/** Card rect from positions and measured sizes (falls back to the estimate). */
export function cardRect(node: CanvasNode, positions: Record<string, Point>, sizes: Record<string, Size> = {}): Rect | null {
  const p = positions[node.id];
  if (!p) return null;
  return { x: p.x, y: p.y, width: sizes[node.id]?.width ?? CARD_WIDTH, height: sizes[node.id]?.height ?? estimateNodeHeight(node) };
}

export interface ZoneBox extends Rect {
  id: string | null;
  name: string;
  zone: CanvasZone | null;
  nodes: string[];
}

/** Frame per zone: bbox of its cards + padding, with room for the header on top. */
export function zoneBoxes(graph: CanvasGraph, positions: Record<string, Point>, sizes: Record<string, Size> = {}): ZoneBox[] {
  const boxes: ZoneBox[] = [];
  for (const group of zoneGroups(graph)) {
    const rects = group.nodes.map((n) => cardRect(n, positions, sizes)).filter((r): r is Rect => !!r);
    if (!rects.length) continue;
    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.width));
    const maxY = Math.max(...rects.map((r) => r.y + r.height));
    boxes.push({
      id: group.id,
      name: group.name,
      zone: group.zone,
      nodes: group.nodes.map((n) => n.id),
      x: minX - ZONE_PADDING,
      y: minY - ZONE_PADDING - zoneHeader(group.zone),
      width: Math.max(maxX - minX + ZONE_PADDING * 2, group.zone?.details ? SERVER_ZONE_MIN_WIDTH : 0),
      height: maxY - minY + ZONE_PADDING * 2 + zoneHeader(group.zone),
    });
  }
  return boxes;
}

/** A rect as a collision box. */
export const toBox = (r: Rect): Box => ({ x: r.x, y: r.y, w: r.width, h: r.height });
// A frame reaches `side` past its cards left, right and below, and `top` above them.
const grow = (b: Box, side: number, top: number): Box => ({ x: b.x - side, y: b.y - top, w: b.w + side * 2, h: b.h + side + top });
const frameAround = (boxes: readonly Box[], side: number, top: number): Box => {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return grow({ x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y }, side, top);
};
// Area of `b` within `gap` of `a`: 0 when they are apart().
const crowding = (a: Box, b: Box, gap: number) =>
  Math.max(0, Math.min(a.x + a.w + gap, b.x + b.w) - Math.max(a.x - gap, b.x)) * Math.max(0, Math.min(a.y + a.h + gap, b.y + b.h) - Math.max(a.y - gap, b.y));

/**
 * What a dragged card must keep clear of, for freeSpot(): `others` are the other cards and the other
 * zone frames, grown by the room the card's own zone frame takes around it. `fits` checks the card's
 * zone frame, which also spans its other cards, against those frames: it must not come closer to them
 * than at the start of the drag. Frames that are already too close (the layout uses estimated card
 * heights) do not lock the cards in place. The server view's project / environment groups are not
 * ported: the environment canvas has none.
 */
export function dragRules(graph: CanvasGraph, positions: Record<string, Point>, sizes: Record<string, Size>, id: string): { others: Box[]; fits: (box: Box) => boolean } {
  const node = graph.nodes.find((n) => n.id === id);
  const own = zoneGroups(graph).find((z) => z.nodes.some((n) => n.id === id));
  const rects = (nodes: readonly CanvasNode[]) =>
    nodes
      .filter((n) => n.id !== id)
      .map((n) => cardRect(n, positions, sizes))
      .filter((r): r is Rect => !!r)
      .map(toBox);
  const side = ZONE_PADDING;
  const top = ZONE_PADDING + zoneHeader(own?.zone);
  const zones = zoneBoxes(graph, positions, sizes)
    .filter((z) => !z.nodes.includes(id))
    .map(toBox);
  const zoneMates = rects(own?.nodes ?? []);
  // The other box must keep the frame's room on the side that faces the card.
  const room = (b: Box, s: number, t: number): Box => ({ x: b.x - s, y: b.y - s, w: b.w + s * 2, h: b.h + s + t });
  const at = node ? cardRect(node, positions, sizes) : null;
  const start = at ? frameAround([...zoneMates, toBox(at)], side, top) : null;
  const zoneFits = (box: Box) => {
    const moved = frameAround([...zoneMates, box], side, top);
    return zones.every((b) => crowding(moved, b, BOX_GAP) <= (start ? crowding(start, b, BOX_GAP) : 0));
  };
  return {
    others: [...rects(graph.nodes), ...zones.map((z) => room(z, side, top))],
    fits: zoneFits,
  };
}

/** A link may be drawn from a card to another card (the connect and server views' rules are not ported). */
export function canConnect(graph: CanvasGraph | null, source: string, target: string): boolean {
  return !!graph && !!source && !!target && source !== target;
}

export interface LinkPath {
  d: string;
  side: "right" | "left" | "down" | "up";
  from: Point;
  to: Point;
  mid: Point;
}

/**
 * SVG path between two card rects. Target right of source: right edge →
 * left edge; target left of source: left edge → right edge; overlapping
 * columns (stacked): bottom → top (or top → bottom when the target is above).
 */
export function linkPath(a: Rect, b: Rect): LinkPath {
  let side: LinkPath["side"];
  let from: Point;
  let to: Point;
  if (b.x >= a.x + a.width) {
    side = "right";
    from = { x: a.x + a.width, y: a.y + a.height / 2 };
    to = { x: b.x, y: b.y + b.height / 2 };
  } else if (b.x + b.width <= a.x) {
    side = "left";
    from = { x: a.x, y: a.y + a.height / 2 };
    to = { x: b.x + b.width, y: b.y + b.height / 2 };
  } else if (b.y + b.height / 2 >= a.y + a.height / 2) {
    side = "down";
    from = { x: a.x + a.width / 2, y: a.y + a.height };
    to = { x: b.x + b.width / 2, y: b.y };
  } else {
    side = "up";
    from = { x: a.x + a.width / 2, y: a.y };
    to = { x: b.x + b.width / 2, y: b.y + b.height };
  }
  let c1: Point;
  let c2: Point;
  if (side === "right" || side === "left") {
    const dx = Math.max(40, Math.abs(to.x - from.x) / 2) * (side === "right" ? 1 : -1);
    c1 = { x: from.x + dx, y: from.y };
    c2 = { x: to.x - dx, y: to.y };
  } else {
    const dy = Math.max(40, Math.abs(to.y - from.y) / 2) * (side === "down" ? 1 : -1);
    c1 = { x: from.x, y: from.y + dy };
    c2 = { x: to.x, y: to.y - dy };
  }
  const mid = { x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8, y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8 };
  const r = (v: number) => Math.round(v * 10) / 10;
  const d = `M ${r(from.x)} ${r(from.y)} C ${r(c1.x)} ${r(c1.y)}, ${r(c2.x)} ${r(c2.y)}, ${r(to.x)} ${r(to.y)}`;
  return { d, side, from, to, mid };
}

/** A link may be drawn between two different nodes that are not linked yet (either direction). */
export function canLink(links: readonly CanvasLink[], source: string, target: string): boolean {
  if (!source || !target || source === target) return false;
  return !links.some((l) => (l.source === source && l.target === target) || (l.source === target && l.target === source));
}

// ── Status ───────────────────────────────────────────────────────────

export type Tone = "ok" | "warn" | "bad" | "idle" | "busy";
const BUSY = ["starting", "restarting", "created", "removing", "in_progress", "queued", "deploying", "building"];
const BAD = ["exited", "stopped", "dead", "failed", "error"];

/** Coolify status string → 'ok' | 'warn' | 'bad' | 'idle' | 'busy'. */
export function statusTone(status: string | null | undefined): Tone {
  const value = String(status ?? "")
    .trim()
    .toLowerCase();
  if (!value) return "idle";
  const [state = "", health = ""] = value.replace(/\)$/, "").split(/\s*[:(]\s*/);
  if (BUSY.includes(state) || health === "starting") return "busy";
  if (BAD.includes(state)) return "bad";
  if (state === "degraded") return "warn";
  if (state === "running" || state === "healthy") return health === "unhealthy" ? "warn" : "ok";
  return "idle";
}

/** "running:healthy" → "Running (healthy)". */
export function statusLabel(status: string | null | undefined): string {
  const value = String(status ?? "").trim();
  if (!value) return "Unknown";
  const [state = "", health] = value.replace(/\)$/, "").split(/\s*[:(]\s*/);
  const word = state.charAt(0).toUpperCase() + state.slice(1).replace(/_/g, " ");
  return health ? `${word} (${health})` : word;
}

/** "running:healthy" → "Running": the state word for the status text on a card. */
export function statusWord(status: string | null | undefined): string {
  return statusLabel(status).replace(/\s*\(.*$/, "");
}

/** Resource cards per status tone; unmanaged containers and placeholder cards are not counted. */
export function statusSummary(nodes: readonly CanvasNode[]): Record<Tone, number> {
  const out: Record<Tone, number> = { ok: 0, warn: 0, bad: 0, busy: 0, idle: 0 };
  for (const n of nodes) if (n.type !== "container" && n.type !== "empty" && !isSource(n)) out[statusTone(n.status)]++;
  return out;
}

/**
 * Ids of the server zones whose server is not reachable. The saved status of their resources is stale,
 * so the canvas shows it as unknown. Zones with an icon (projects, connect view) are not servers.
 */
export function unreachableZones(graph: CanvasGraph | null): Set<string> {
  return new Set((graph?.zones ?? []).filter((z) => !z.icon && z.is_reachable === false).map((z) => z.id));
}

/** 1007820800 → "1 GB", 17179869184 → "16 GB". */
export function formatMemory(bytes: number | null | undefined): string | null {
  if (!bytes) return null;
  const gb = bytes / 1024 ** 3;
  return `${gb < 10 ? Math.round(gb * 10) / 10 : Math.round(gb)} GB`;
}

/** Time since a "YYYY-MM-DD HH:MM:SS" (UTC) or ISO date, as "45m", "5h", "12d". */
export function formatUptime(since: string | null | undefined, now = Date.now()): string | null {
  const at = Date.parse(String(since || "").replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(since || "") ? "" : "Z"));
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

// ── View ─────────────────────────────────────────────────────────────

export interface View {
  x: number;
  y: number;
  z: number;
}

/**
 * View that shows the content bounds in the free part of the viewport.
 * `readable`: never below READABLE_ZOOM; content that does not fit then starts at its top-left,
 * so the cards can be read and the user scrolls to the rest.
 */
export function fitView(bounds: { minX: number; minY: number; maxX: number; maxY: number }, area: { left: number; top: number; width: number; height: number }, readable = false): View {
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const room = { w: area.width - FIT_PAD * 2, h: area.height - FIT_PAD * 2 };
  const whole = Math.min(room.w / w, room.h / h);
  const z = Math.min(1.1, Math.max(readable ? READABLE_ZOOM : MIN_ZOOM, whole));
  const x = w * z <= room.w ? area.left + (area.width - w * z) / 2 : area.left + FIT_PAD;
  const y = h * z <= room.h ? area.top + (area.height - h * z) / 2 : area.top + FIT_PAD;
  return { z, x: x - bounds.minX * z, y: y - bounds.minY * z };
}

/**
 * The browser zoom shortcut in a keydown event (Cmd/Ctrl with +, - or 0), so the
 * canvas can zoom itself instead: 'in', 'out', 'reset', or null for other keys.
 */
export function zoomShortcut(e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; key: string }): "in" | "out" | "reset" | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.key === "+" || e.key === "=") return "in";
  if (e.key === "-" || e.key === "_") return "out";
  if (e.key === "0") return "reset";
  return null;
}

/** A saved { x, y, z } canvas view, or null when it is missing or not valid. */
export function readView(key: string, storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): View | null {
  try {
    const v = JSON.parse(storage?.getItem(key) ?? "null") as Partial<View> | null;
    const ok = v && [v.x, v.y, v.z].every((n) => Number.isFinite(n)) && v.z! >= MIN_ZOOM && v.z! <= MAX_ZOOM;
    return ok ? { x: v.x!, y: v.y!, z: v.z! } : null;
  } catch {
    return null;
  }
}

// ── API errors (canvas-core.js ApiError) ─────────────────────────────

/** A failed answer of the canvas endpoints, in Freeploy's envelope. */
export interface CanvasErrorBody {
  error?: { message?: string; details?: { fields?: Record<string, string[]> } };
}

/** ApiError's message: the body's message (or "Request failed (HTTP n)."), then every field error that is not that message. */
export function canvasErrorMessage(status: number, body: CanvasErrorBody | null): string {
  const message = body?.error?.message;
  const fields = body?.error?.details?.fields;
  const errors = fields ? Object.values(fields).flat().map(String) : [];
  return [message || `Request failed (HTTP ${status}).`, ...errors.filter((e) => e !== message)].join(" ");
}

/** Small screens: the notice that the canvas is not optimized for mobile; closed once, it stays closed on every canvas. */
export const MOBILE_NOTICE_KEY = "coolify-canvas:mobile-notice-dismissed";

// ── Card and panel constants ─────────────────────────────────────────

export const TYPE_LABELS: Partial<Record<NodeType, string>> = {
  application: "Application",
  service: "Service",
  database: "Database",
  container: "Unmanaged container",
  variable: "Shared variable",
  tag: "Tag",
};
export const TONE_DOT: Record<Tone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-warning",
  bad: "bg-red-500",
  idle: "bg-neutral-400 dark:bg-neutral-500",
  busy: "bg-warning",
};
/** Outline icons, drawn from local paths. */
export const ICONS: Record<string, string[]> = {
  chevron: ["M6 15l6-6 6 6"],
  application: ["M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z", "M3 9h18", "M9.5 13l-2 2 2 2", "M14.5 13l2 2-2 2"],
  service: ["M12 4 3 8.5l9 4.5 9-4.5z", "M3 12.5l9 4.5 9-4.5", "M3 16.5l9 4.5 9-4.5"],
  database: ["M5 6c0-1.66 3.13-3 7-3s7 1.34 7 3-3.13 3-7 3-7-1.34-7-3z", "M5 6v12c0 1.66 3.13 3 7 3s7-1.34 7-3V6", "M5 12c0 1.66 3.13 3 7 3s7-1.34 7-3"],
  container: ["M12 3 4 7.5v9L12 21l8-4.5v-9z", "M4 7.5 12 12l8-4.5", "M12 12v9"],
  server: ["M4 4h16v6H4z", "M4 14h16v6H4z", "M7.5 7h.01", "M7.5 17h.01"],
  refresh: ["M20 11a8 8 0 0 0-14.9-3.9", "M4 4v4h4", "M4 13a8 8 0 0 0 14.9 3.9", "M20 20v-4h-4"],
  plus: ["M12 5v14", "M5 12h14"],
  minus: ["M5 12h14"],
  fit: ["M4 9V4h5", "M20 9V4h-5", "M4 15v5h5", "M20 15v5h-5"],
  x: ["M6 6l12 12", "M18 6 6 18"],
  external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"],
  link: ["M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1", "M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"],
  variable: ["M8 4H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1", "M16 4h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"],
  search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M20 20l-4-4"],
  tag: ["M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z", "M7.5 7.5h.01"],
  info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 11v5", "M12 8h.01"],
  shieldAlert: ["M12 3 5 5.5v5.6c0 4.4 2.9 8.2 7 9.9 4.1-1.7 7-5.5 7-9.9V5.5z", "M12 8v4", "M12 15.5h.01"],
};
