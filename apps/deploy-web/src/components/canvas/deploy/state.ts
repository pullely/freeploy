// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/deploy/state.svelte.js (Apache-2.0), modified.
//
// Deploy canvas runtime: the state of the open canvas, what the steps do to it (add, connect, run…),
// and the pointer drags around canvas-core.js' helpers (pan/zoom, card sizes). Svelte's $state is a
// plain object here: every change calls changed(), and the components re-render through
// useDeployCanvas() (useSyncExternalStore).
//
// Departure: runFlow() validates the plan as Coolify does, then sends it once (POST …/deploy/canvas/run);
// the server runs the steps in Coolify's order and answers each step's status and message, which this
// file then shows step by step in the run panel and on the cards. Deploying answers Freeploy's 501, so
// the Deploy step and each resource's tab show it as failed; no deployment log is followed.
import { useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import { canvasApi, CanvasApiError } from "../../../lib/canvas-api";
import { panZoom, type PanZoom } from "../../../lib/canvas-pan-zoom";
import { freeSpot, MIN_ZOOM, type Box } from "../../../lib/environment-canvas";
import {
  CARD_W,
  canFollow,
  defaults,
  fresh,
  lists,
  load,
  multiOut,
  nextOf,
  nodeById,
  outsOf,
  planBody,
  planOf,
  PORT_Y,
  resourceHref,
  restoredFlow,
  save,
  setDeployCanvasCalls,
  setServiceCatalogue,
  targetFrom,
  TYPES,
  uid,
  uniqueLabels,
  validate,
  withDeploy,
  withoutSecrets,
  withTarget,
  type Field,
  type Flow,
  type FlowEdge,
  type FlowNode,
  type Option,
  type RunAnswer,
  type StepType,
} from "../../../lib/deploy-canvas";

export { PORT_Y };

type Point = { x: number; y: number };
export type StepState = "" | "running" | "done" | "failed";
export interface Pane {
  key: string;
  label: string;
  href: string;
  state: StepState;
  status: string;
  lines: Array<{ text: string; cls: string }>;
}
export interface RunPanelState {
  open: boolean;
  title: string;
  sub: string;
  steps: Array<{ id: string; label: string; state: StepState; message: string }>;
  panes: Pane[];
  active: string | null;
  defaultHref: string;
  openHref: string;
  showOpen: boolean;
}
export interface DropdownState {
  /** Mounted again for each trigger ({#key cv.dropdown?.trigger}). */
  key: number;
  trigger: HTMLElement;
  items: Option[];
  current: string;
  onPick: (value: string) => void;
  add: { label: string; placeholder: string; create: (name: string) => Promise<string>; done: (picked: string) => void } | null;
}

const emptyRun = (): RunPanelState => ({ open: false, title: "Deploy", sub: "", steps: [], panes: [], active: null, defaultHref: "", openHref: "", showOpen: false });

export const cv = {
  canAdd: false, // may create projects and environments (from the page)
  target: null as { project: string; environment: string } | null, // the environment that opened the canvas
  flow: fresh(),
  view: { x: 40, y: 40, z: 1 },
  runState: {} as Record<string, { state: StepState; message: string }>,
  invalid: {} as Record<string, true>, // a required field is empty
  // The last successful run's addresses, shown as a pill after Deploy.
  result: null as { after: string; urls: string[]; href: string } | null,
  running: false as false | "save" | "deploy",
  sizes: {} as Record<string, { w: number; h: number }>,
  listsVersion: 0, // bumped when an option list loads
  menu: null as { prev: string; valid: StepType[]; p: Point; left: number; top: number } | null, // the "Add the next step" menu
  pendingLine: null as { a: Point; b: Point } | null, // the dragged line, kept while its menu is open
  temp: null as { a: Point; b: Point } | null, // the line being dragged from a port
  armed: null as string | null, // node id of the port being dragged
  dropTarget: null as string | null, // node id the dragged line would connect to
  toast: null as { text: string; bad: boolean } | null,
  dropdown: null as DropdownState | null,
  run: emptyRun(), // the run panel
  version: 0,
};

// ── The store ──────────────────────────────────────────────────────────
const listeners = new Set<() => void>();
/** A change of cv: the components re-render. */
export function changed(): void {
  cv.version++;
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
/** The canvas state, re-rendering on each change. */
export function useDeployCanvas(): typeof cv {
  useSyncExternalStore(
    subscribe,
    () => cv.version,
    () => cv.version,
  );
  return cv;
}

// DOM of the open canvas (set by the components); mount counts the canvases, so a run of an earlier one stops writing here.
export const els = { root: null as HTMLElement | null, stage: null as HTMLElement | null, viewport: null as HTMLElement | null, pz: null as PanZoom | null, nodeEls: new Map<string, HTMLElement>(), mount: 0, fitOnOpen: false };

lists.onChange = () => {
  cv.listsVersion++;
  changed();
};

/** The page's data (GET …/deploy/canvas). */
export interface DeployCanvasPage {
  can_add: boolean;
  service_templates: Option[];
  service_logos: Record<string, [string, string]>;
}

/** The deploy canvas endpoints of the org, …/deploy/canvas. */
let endpoint = "";

export function init(base: string, page: DeployCanvasPage | null): void {
  els.mount++;
  els.nodeEls.clear();
  endpoint = base;
  setDeployCanvasCalls({
    list: (path) => canvasApi<Option[]>("GET", `${base}/options${path}`),
    create: (path, body) => canvasApi<{ uuid: string }>("POST", `${base}${path}`, body),
  });
  setServiceCatalogue(page?.service_templates ?? [], page?.service_logos ?? {});
  lists.cache = {};
  lists.errors = {};
  cv.canAdd = !!page?.can_add;
  if (load("deployed", false)) {
    save("flow", null);
    save("result", null);
    save("deployed", false);
  }
  cv.target = targetFrom(location.search);
  cv.flow = withTarget(withDeploy(restoredFlow(load<unknown>("flow", null)) || fresh()), cv.target);
  save("flow", withoutSecrets(cv.flow)); // drops secrets that older versions stored
  // Small screens: the default view is made for desktop, so the first visit fits the steps instead.
  els.fitOnOpen = !load("view", null) && !matchMedia("(min-width: 768px)").matches;
  cv.view = load("view", { x: 40, y: 40, z: 1 });
  cv.result = load("result", null);
  Object.assign(cv, { runState: {}, invalid: {}, running: false, sizes: {}, menu: null, pendingLine: null, temp: null, armed: null, dropTarget: null, toast: null, dropdown: null, run: emptyRun() });
  changed();
}

/** The canvas left the page: its runs stop. */
export function leave(): void {
  els.mount++;
}

// ── Pan and card sizes ─────────────────────────────────────────────────

let shownZoom = 1;
/** pan on the viewport: wheel and pinch zoom, drag to pan. Returns its cleanup. */
export function pan(viewport: HTMLElement): () => void {
  const world = viewport.querySelector<HTMLElement>(".cv-world")!;
  const edges = viewport.querySelector(".cv-edges");
  els.viewport = viewport;
  els.stage = viewport.parentElement;
  els.root = viewport.closest<HTMLElement>(".cv-root");
  const pz = panZoom({
    root: els.root!,
    viewport,
    world,
    getView: () => cv.view,
    onChange: () => {
      closeDropdown();
      queueSave();
      // CanvasControls shows cv.view.z: only a zoom redraws.
      if (cv.view.z !== shownZoom) {
        shownZoom = cv.view.z;
        changed();
      }
    },
    canPan: (e) => [viewport, world, edges].includes(e.target as HTMLElement),
    onPanStart: closeMenu,
  });
  els.pz = pz;
  // The root paints the dots, so move them with the viewport when the Steps panel folds or the window resizes.
  const sizes = new ResizeObserver(() => pz.apply());
  sizes.observe(viewport);
  return () => {
    sizes.disconnect();
    pz.destroy();
  };
}

/** track on a card: its element (for measuring) and its size (for the lines). Returns its cleanup. */
export function track(node: HTMLElement, id: string): () => void {
  els.nodeEls.set(id, node);
  const measure = () => {
    const was = cv.sizes[id];
    if (was && was.w === node.offsetWidth && was.h === node.offsetHeight) return;
    cv.sizes[id] = { w: node.offsetWidth, h: node.offsetHeight };
    changed();
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(node);
  return () => {
    observer.disconnect();
    if (els.nodeEls.get(id) === node) els.nodeEls.delete(id);
    delete cv.sizes[id];
  };
}

// ── Canvas: geometry, fit ──────────────────────────────────────────────
// Port positions in world coordinates.
export const outPoint = (n: FlowNode) => ({ x: n.x + (cv.sizes[n.id]?.w || CARD_W), y: n.y + PORT_Y });
export const inPoint = (n: FlowNode) => ({ x: n.x, y: n.y + PORT_Y });
const toWorld = (cx: number, cy: number) => els.pz!.toWorld(cx, cy);
const width = (n: FlowNode) => els.nodeEls.get(n.id)?.offsetWidth || CARD_W;
const height = (n: FlowNode) => els.nodeEls.get(n.id)?.offsetHeight || 160;
// A card's box in world units (its rendered size, or a usual card size).
const boxOf = (n: FlowNode): Box => ({ x: n.x, y: n.y, w: width(n), h: height(n) });

// The part of the viewport that the floating Steps panel does not cover,
// relative to the viewport (on small screens the panel is above it).
function openArea() {
  const r = els.viewport!.getBoundingClientRect();
  const p = els.root!.querySelector(".cv-palette")!.getBoundingClientRect();
  const left = p.bottom > r.top ? Math.max(0, p.right - r.left) : 0;
  return { left, width: r.width - left, height: r.height };
}

export function fit(): void {
  if (!els.nodeEls.size || !els.pz) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of cv.flow.nodes) {
    const node = els.nodeEls.get(n.id);
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + (node?.offsetWidth || 280));
    maxY = Math.max(maxY, n.y + (node?.offsetHeight || 120));
  }
  const pill = els.root!.querySelector<HTMLElement>(".cv-result");
  if (pill) {
    maxX = Math.max(maxX, pill.offsetLeft + pill.offsetWidth);
    maxY = Math.max(maxY, pill.offsetTop + pill.offsetHeight);
  }
  const r = openArea();
  const pad = 60;
  const view = cv.view;
  view.z = Math.min(1.2, Math.max(MIN_ZOOM, Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY))));
  view.x = r.left + (r.width - (maxX - minX) * view.z) / 2 - minX * view.z;
  view.y = (r.height - (maxY - minY) * view.z) / 2 - minY * view.z;
  els.pz.apply();
}

// ── Toast, menus, dropdown ─────────────────────────────────────────────
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string, bad = false): void {
  cv.toast = { text, bad };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      cv.toast = null;
      changed();
    },
    bad ? 4200 : 2600,
  );
  changed();
}

export function closeMenu(): void {
  if (!cv.menu && !cv.pendingLine) return;
  cv.menu = null;
  cv.pendingLine = null;
  changed();
}
// Close an older menu but keep the line being dropped.
function openNextMenu(prev: FlowNode, cx: number, cy: number, p: Point) {
  cv.menu = null;
  const valid = (Object.keys(TYPES) as StepType[]).filter((type) => canFollow(prev, type, null, cv.flow));
  if (!valid.length) return toast("Nothing can follow this step.", true);
  const r = els.stage!.getBoundingClientRect();
  cv.menu = { prev: prev.id, valid, p, left: Math.min(cx - r.left, r.width - 220), top: Math.min(cy - r.top, r.height - 40 * valid.length - 40) };
  changed();
}
export function pickNext(type: StepType): void {
  const { prev, p } = cv.menu!;
  closeMenu();
  const n = addNode(type, p.x + 8, p.y - PORT_Y, true);
  connect(prev, n.id);
}

// Our dropdown panel (fixed in the canvas root, so zoom never shrinks it).
let dropdownKey = 0;
export function closeDropdown(): void {
  if (!cv.dropdown) return;
  cv.dropdown = null;
  changed();
}
export function openDropdown(trigger: HTMLElement, items: Option[], current: string, onPick: (value: string) => void, add: DropdownState["add"] = null): void {
  if (cv.dropdown?.trigger === trigger) return closeDropdown();
  cv.dropdown = { key: ++dropdownKey, trigger, items, current, onPick, add };
  changed();
}

// ── Flow edits ─────────────────────────────────────────────────────────
// A structural change redraws the cards, which clears their invalid marks.
const redraw = () => {
  cv.invalid = {};
};

export function connect(from: string, to: string): void {
  const a = nodeById(from, cv.flow)!;
  cv.flow.edges = cv.flow.edges.filter((e) => !(e.from === from && e.to === to) && (multiOut(a) || e.from !== from) && e.to !== to);
  cv.flow.edges.push({ from, to });
  redraw();
  changed();
}
export function removeEdge(edge: FlowEdge): void {
  if (cv.running) return;
  cv.flow.edges = cv.flow.edges.filter((e) => e !== edge);
  redraw();
  toast("Connection removed.");
}
export function addNode(type: StepType, x: number, y: number, quiet = false): FlowNode {
  cv.flow.nodes.push({ id: uid(), type, x: Math.round(x), y: Math.round(y), data: defaults(type) });
  const n = cv.flow.nodes.at(-1)!;
  redraw();
  flushSync(changed); // render the card, to measure it
  settle(n);
  if (!quiet) toast(`${TYPES[type].title} added. Connect it from the dot of the step before.`);
  else changed();
  return n;
}
export function removeNode(id: string): void {
  if (cv.running) return;
  cv.flow.nodes = cv.flow.nodes.filter((n) => n.id !== id);
  cv.flow.edges = cv.flow.edges.filter((e) => e.from !== id && e.to !== id);
  delete cv.runState[id];
  redraw();
  changed();
}
export function resetCanvas(): void {
  if (cv.running) return;
  cv.flow = withTarget(fresh(), cv.target);
  cv.runState = {};
  cv.result = null;
  save("result", null);
  save("deployed", false);
  redraw();
  changed();
}
export function hideResult(): void {
  cv.result = null;
  save("result", null);
  changed();
}
// A field change. Fields loaded from the one changed (`rerender`) start empty again.
export function setField(n: FlowNode, f: Field, value: string): void {
  const fields = TYPES[n.type].fields;
  n.data[f.key] = value;
  f.after?.(n.data);
  if (f.rerender) {
    for (const other of fields) if (other.load && other !== f && other.key !== f.key && fields.indexOf(other) > fields.indexOf(f)) delete n.data[other.key];
  }
  delete cv.invalid[n.id];
  changed();
}

// Move a card to the nearest spot where it does not cover another card.
function settle(n: FlowNode) {
  const spot = freeSpot(
    boxOf(n),
    cv.flow.nodes.filter((m) => m !== n).map(boxOf),
  );
  if (!spot || (spot.x === n.x && spot.y === n.y)) return;
  n.x = Math.round(spot.x);
  n.y = Math.round(spot.y);
}
// Click on a step in the list: add it after the step it most likely follows.
function appendToChain(type: StepType) {
  const flow = cv.flow;
  const plan = planOf(flow);
  // The newest step in the tree this one can follow, with room for it.
  const inTree = [plan.start, ...plan.servers, ...plan.lines.flatMap((l) => [l.source, ...l.settings])].filter((n): n is FlowNode => !!n);
  const parent = inTree.reverse().find((n) => canFollow(n, type, null, flow) && (multiOut(n) || !nextOf(n.id, flow)));
  if (!parent) {
    const [x, y] = centre();
    addNode(type, x, y);
    return;
  }
  const siblings = multiOut(parent)
    ? outsOf(parent.id, flow)
        .map((id) => nodeById(id, flow))
        .filter((n): n is FlowNode => !!n)
    : [];
  const y = siblings.length ? Math.max(...siblings.map((n) => n.y + height(n))) + 40 : parent.y;
  const n = addNode(type, parent.x + width(parent) + 80, y, true);
  connect(parent.id, n.id);
}
function centre(): [number, number] {
  const r = els.viewport!.getBoundingClientRect();
  const a = openArea();
  const p = toWorld(r.left + a.left + a.width / 2, r.top + r.height / 2);
  return [p.x - 140, p.y - 60];
}

// ── Pointer drags ──────────────────────────────────────────────────────

/** A palette step: drag it to the canvas, or click to append it to the chain. */
export function dragFromPalette(type: StepType, event: ReactPointerEvent<HTMLElement>): void {
  if (event.button !== 0) return;
  const item = event.currentTarget;
  const startX = event.clientX;
  const startY = event.clientY;
  let ghost: HTMLElement | null = null;
  const move = (e: PointerEvent) => {
    if (!ghost && Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return;
    if (!ghost) {
      ghost = item.cloneNode(true) as HTMLElement;
      Object.assign(ghost.style, { position: "fixed", zIndex: "2147483001", width: `${item.offsetWidth}px`, pointerEvents: "none", opacity: "0.9", background: "var(--cv-ghost)", borderRadius: "8px", boxShadow: "0 8px 24px -8px rgb(0 0 0 / 0.35)" });
      ghost.style.setProperty("--cv-ghost", "light-dark(#fff, #222)");
      els.root!.appendChild(ghost);
    }
    ghost.style.left = `${e.clientX - 20}px`;
    ghost.style.top = `${e.clientY - 18}px`;
  };
  const stop = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    removeEventListener("pointercancel", cancel);
  };
  // Touch: a sideways swipe scrolls the step strip (small screens) and cancels the pointer.
  const cancel = () => {
    stop();
    ghost?.remove();
  };
  const up = (e: PointerEvent) => {
    stop();
    if (!ghost) return appendToChain(type);
    ghost.remove();
    const r = els.viewport!.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    if ((e.target as Element | null)?.closest?.(".cv-palette")) return;
    const p = toWorld(e.clientX, e.clientY);
    addNode(type, p.x - 30, p.y - 16);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
  addEventListener("pointercancel", cancel);
}

/** Drag a card by its header. Pointer capture keeps the drag even when the pointer outruns the card. */
export function dragNode(n: FlowNode, event: ReactPointerEvent<HTMLElement>): void {
  if (event.button !== 0 || (event.target as Element).closest("button, input, select, textarea")) return;
  const handle = event.currentTarget;
  const pointerId = event.pointerId;
  event.stopPropagation();
  event.preventDefault();
  closeMenu();
  try {
    handle.setPointerCapture(pointerId);
  } catch {
    // Not capturable.
  }
  const ox = event.clientX / cv.view.z - n.x;
  const oy = event.clientY / cv.view.z - n.y;
  // The other cards stay put during the drag, so measure them once.
  const others = cv.flow.nodes.filter((m) => m !== n).map(boxOf);
  const move = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    const wanted = { x: e.clientX / cv.view.z - ox, y: e.clientY / cv.view.z - oy, w: width(n), h: height(n) };
    // Cards cannot cover each other: stop at the edge of a card in the way.
    const spot = freeSpot(wanted, others);
    if (!spot) return;
    n.x = Math.round(spot.x);
    n.y = Math.round(spot.y);
    changed();
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    removeEventListener("pointercancel", up);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
  addEventListener("pointercancel", up);
}

// Drag from an output port: drop on a node to connect, on empty space to pick.
export function startConnect(n: FlowNode, event: ReactPointerEvent<HTMLElement>): void {
  event.stopPropagation();
  event.preventDefault();
  if (cv.running) return;
  cv.armed = n.id;
  changed();
  const a = outPoint(n);
  let target: FlowNode | null = null;
  const move = (e: PointerEvent) => {
    cv.temp = { a, b: toWorld(e.clientX, e.clientY) };
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest?.<HTMLElement>(".cv-node");
    const id = hit?.dataset.id;
    const candidate = id && id !== n.id ? nodeById(id, cv.flow) : null;
    target = candidate && canFollow(n, candidate.type, candidate, cv.flow) ? candidate : null;
    cv.dropTarget = target?.id ?? null;
    changed();
  };
  const up = (e: PointerEvent) => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    cv.armed = null;
    cv.temp = null;
    cv.dropTarget = null;
    changed();
    if (target) return connect(n.id, target.id);
    const over = document.elementFromPoint(e.clientX, e.clientY);
    if (over?.closest?.(".cv-node")) return toast("That step cannot follow this one.", true);
    const p = toWorld(e.clientX, e.clientY);
    if (Math.hypot(p.x - a.x, p.y - a.y) < 12) return;
    cv.pendingLine = { a, b: p };
    openNextMenu(n, e.clientX, e.clientY, p);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
}

// ── Run ────────────────────────────────────────────────────────────────
// Log panes: "all" holds the steps; each deployed resource gets its own tab and pane.
const paneOf = (key: string | null) => cv.run.panes.find((pane) => pane.key === key);
function openPane(key: string, label: string): Pane {
  if (!paneOf(key)) cv.run.panes.push({ key, label, href: "", state: "", status: "", lines: [] });
  return paneOf(key)!;
}
export function showPane(key: string | null): void {
  const r = cv.run;
  r.active = key;
  const href = paneOf(key)?.href || r.defaultHref;
  if (href) r.openHref = href;
  changed();
}
function setPaneState(key: string, state: StepState, status: string) {
  const pane = paneOf(key);
  if (!pane) return;
  pane.state = state;
  pane.status = status;
}
function logLine(text: string, cls = "", key = "all") {
  const pane = paneOf(key) || paneOf("all")!;
  const box = els.root?.querySelector<HTMLElement>(`.cv-logs[data-key="${pane.key}"]`);
  const atEnd = !box || box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  pane.lines.push({ text, cls });
  if (box && atEnd) requestAnimationFrame(() => (box.scrollTop = box.scrollHeight));
}
function setStep(id: string, state: StepState, message: string) {
  cv.runState[id] = { state, message };
  delete cv.invalid[id];
  const row = cv.run.steps.find((s) => s.id === id);
  if (row) {
    row.state = state;
    row.message = message || "";
  }
}

export async function runFlow(action: "save" | "deploy" = "deploy"): Promise<void> {
  if (cv.running) return;
  closeMenu();
  const plan = planOf(cv.flow);
  const { problems, invalid } = validate(plan);
  for (const id of invalid) cv.invalid[id] = true;
  if (problems.length) {
    toast(problems[0]!, true);
    return;
  }
  cv.running = action;
  cv.runState = {};
  cv.result = null;
  save("result", null);
  save("deployed", false);
  const servers = [...new Set(plan.lines.map((l) => l.server))];
  const list = [plan.start!, ...servers, ...plan.lines.flatMap((l) => [l.source, ...l.settings]), plan.deploy!];
  const names = uniqueLabels(plan.lines.map((l) => l.source));
  const labelOf = (n: FlowNode) => names.get(n.id) || TYPES[n.type].title;
  const r = cv.run;
  r.open = true;
  r.title = action === "save" ? "Saving" : "Deploying";
  r.sub = `${plan.lines.length} resource${plan.lines.length === 1 ? "" : "s"}`;
  r.panes = [];
  r.active = null;
  r.defaultHref = "";
  openPane("all", "Steps");
  showPane("all");
  r.showOpen = false;
  r.steps = list.map((n) => ({ id: n.id, label: labelOf(n), state: "", message: "Waiting" }));
  redraw();
  // The page can be left (and the canvas mounted again) during a run.
  const owner = els.mount;
  const live = () => els.mount === owner;
  // The server runs every step; the first one runs until it answers.
  setStep(plan.start!.id, "running", "Running…");
  changed();
  let answer: RunAnswer;
  try {
    answer = await canvasApi<RunAnswer>("POST", `${endpoint}/run`, planBody(action, plan));
  } catch (error) {
    if (!live()) return;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof CanvasApiError) for (const id of (error.body as { error?: { details?: { invalid?: string[] } } } | null)?.error?.details?.invalid ?? []) cv.invalid[id] = true;
    setStep(plan.start!.id, "failed", message);
    logLine(`✗ ${labelOf(plan.start!)}: ${message}`, "err");
    r.title = "Stopped";
    r.sub = "A step failed. Fix it and try again.";
    cv.running = false;
    changed();
    return;
  }
  if (!live()) return;
  const byId = new Map(list.map((n) => [n.id, n]));
  const shipped = answer.resources.map((res) => ({ ...res, ctx: { project: answer.project, environment: answer.environment, resource: { kind: res.kind, uuid: res.uuid } } }));
  const href = () => (shipped.length === 1 ? resourceHref(shipped[0]!.ctx) : `/project/${answer.project}/environment/${answer.environment}`);
  const showOpen = () => {
    if (!shipped.length) return;
    r.showOpen = true;
    r.openHref = r.defaultHref = href();
  };
  for (const s of answer.steps) {
    const n = byId.get(s.id);
    if (!n || s.state === "") continue;
    if (n === plan.deploy) showOpen();
    if (n === plan.deploy && action === "deploy") {
      // deployAll(): a tab per resource, in order; the first one opens.
      for (const res of shipped) openPane(res.source, res.label).href = resourceHref(res.ctx);
      if (shipped.length) showPane(shipped[0]!.source);
      for (const d of answer.deploys) {
        setPaneState(d.source, d.state, d.message);
        if (d.state === "done") {
          logLine(d.message, "", d.source);
          logLine(`✓ ${d.label}: ${d.message}`, "dim");
        } else {
          logLine(d.message, "err", d.source);
        }
      }
    }
    setStep(s.id, s.state, s.message);
    if (s.state === "done") logLine(`✓ ${labelOf(n)}: ${s.message}`, "dim");
    else if (s.state === "failed") logLine(`✗ ${labelOf(n)}: ${s.message}`, "err");
    if (s.state === "failed" && n !== plan.deploy) showOpen();
  }
  if (shipped.length) r.defaultHref = href();
  showPane(r.active);
  const ok = answer.ok;
  if (ok) {
    cv.result = { after: plan.deploy!.id, urls: [], href: href() };
    save("result", cv.result);
    // The next visit starts with an empty canvas.
    if (action === "deploy") save("deployed", true);
  }
  r.title = ok ? "Done" : "Stopped";
  r.sub = ok ? (action === "save" ? "Saved in Freeploy. Deploy them from there or from here." : "Every step finished.") : "A step failed. Fix it and try again.";
  cv.running = false;
  changed();
}

/** Keeps the flow (without secrets) and the view, 200 ms after a change. */
let saveTimer: ReturnType<typeof setTimeout> | undefined;
export function queueSave(): void {
  const flow = JSON.stringify(withoutSecrets(cv.flow));
  const view = JSON.stringify(cv.view);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem("coolify-canvas:flow", flow);
      localStorage.setItem("coolify-canvas:view", view);
    } catch {
      // Storage blocked.
    }
  }, 200);
}

export type { Flow };
