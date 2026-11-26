// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/environment/EnvironmentCanvas.svelte (Apache-2.0), modified.
//
// Environment canvas (Beta): a read-mostly diagram of one environment. Server zones hold
// resource cards; those who may edit the environment move cards and zones and draw
// visual-only links. Positions and links are stored through deploy-core-worker's canvas
// endpoints (…/environments/{env_uuid}/canvas/{positions,links}, DP-92).
//
// Ported: the layout (zones, cards, link curves and their labels and end dots), pan and zoom
// (wheel, pinch, drag, middle button, Cmd/Ctrl +/-/0), fit, the saved view per team and page,
// the toolbar with the beta badge and "View only", the side panel, the empty and error states,
// Refresh and the refresh when the tab comes back, the toast and the small-screen notice; and
// (DP-92) dragging a card (it stops before it covers another card or zone) and a zone (its
// cards move with it), the saves 400 ms after a move (and on leaving the page, with keepalive),
// moves kept on the canvas until a load that started after their save returns them, drawing a
// link from a card's drag dot onto another card, the link's label and "Remove link".
// Not ported: the live status over Echo (Freeploy has no realtime channel yet: Refresh and the
// tab's return load the latest status), and the server, project, dashboard, shared variable and
// tag canvases that reuse this view (their filters, group frames and drags, zone saves, unmanaged
// containers, usage, polling, recent deployments and placeholder cards).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { canvasApi } from "../../../lib/canvas-api";
import { panZoom, type PanZoom } from "../../../lib/canvas-pan-zoom";
import {
  BOX_GAP,
  canConnect,
  canLink,
  cardRect,
  DOUBLE_CLICK_MS,
  dragRules,
  fitView,
  freeSpot,
  layoutGraph,
  linkPath,
  MOBILE_NOTICE_KEY,
  normalizeGraph,
  readView,
  toBox,
  unreachableZones,
  zoneBoxes,
  type CanvasGraph,
  type CanvasLink,
  type Point,
  type Size,
  type View,
  type ZoneBox,
} from "../../../lib/environment-canvas";
import { CanvasControls } from "../CanvasControls";
import { Card } from "./Card";
import { CanvasIcon } from "./Icon";
import { Panel, type Selection } from "./Panel";
import { BOXED_BAR, DOCKED_BAR, Toolbar } from "./Toolbar";
import { Zone } from "./Zone";

/** Small screens: the notice that the canvas is not optimized for mobile; closed once, it stays closed. */
function noticeOpen(): boolean {
  try {
    return !JSON.parse(localStorage.getItem(MOBILE_NOTICE_KEY) ?? "null");
  } catch {
    return true; // Storage blocked: show the notice.
  }
}

const desktopQuery = () => window.matchMedia("(min-width: 1024px)");
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Follows a captured pointer on `el` until it is released. */
function track(el: Element, move: (e: PointerEvent) => void, up: () => void) {
  const onMove = (e: Event) => move(e as PointerEvent);
  const release = () => {
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", release);
    el.removeEventListener("pointercancel", release);
    up();
  };
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);
}
function capture(el: Element, pointerId: number) {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // Synthetic or already released pointer; window-level fallbacks are not needed for real pointers.
  }
}

type Settling = Record<string, { at: Point; after: number }>;

export function EnvironmentCanvas(props: {
  /** The canvas endpoint (GET …/projects/{uuid}/environments/{env_uuid}/canvas); the save actions are below it. */
  endpoint: string;
  /** The team of the page, so the saved view is kept per team and page. */
  team: string;
  /** The page's views (List view, Shared variables, Settings, New resource), moved into the toolbar. */
  views: ReactNode;
  viewOnlyTitle: string;
  /** "Add resource" in the empty state, for users who may create resources. */
  newHref: string | null;
}) {
  const base = props.endpoint;
  const [graph, setGraphState] = useState<CanvasGraph | null>(null);
  const [positions, setPositionsState] = useState<Record<string, Point>>({});
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const [selected, setSelected] = useState<Selection>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [pending, setPending] = useState<Array<{ source: string; target: string }>>([]); // links being saved, drawn as moving dashes
  const [temp, setTemp] = useState<{ from: Point; to: Point } | null>(null); // the link being drawn
  const [dropTarget, setDropTargetState] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panelTop, setPanelTop] = useState("");
  const [showNotice, setShowNotice] = useState(noticeOpen);
  const [desktop, setDesktop] = useState(() => desktopQuery().matches);
  const [focusLabel, setFocusLabel] = useState(0);

  // Zoom and pan are kept per team and page, so a reload opens the canvas where it was.
  const viewKey = `coolify-canvas-view:${props.team}:${window.location.pathname}`;
  const restored = useRef<View | null>(readView(viewKey));
  const view = useRef<View>(restored.current ?? { x: 40, y: 40, z: 1 });
  const rootEl = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const pz = useRef<PanZoom | null>(null);
  const fitted = useRef(false);
  const loadingRef = useRef(false);
  const reloadQueued = useRef(false);
  const destroyed = useRef(false);
  const timers = useRef({ toast: 0, view: 0, refresh: 0, save: 0 });
  // What the pointer handlers read between renders.
  const graphRef = useRef<CanvasGraph | null>(null);
  const positionsRef = useRef<Record<string, Point>>({});
  const sizesRef = useRef<Record<string, Size>>({});
  const dropTargetRef = useRef<string | null>(null);
  const selectedRef = useRef<Selection>(null);
  // Plain bookkeeping (not rendered).
  const interactions = useRef(new Set<string>()); // active drags; loads wait until they end
  const deferred = useRef<CanvasGraph | null>(null);
  const unsaved = useRef<Record<string, Point>>({});
  // Saved moves stay on the canvas until a load that started after the save returns them, so an older
  // response (a refresh during the drag or the request) cannot put the cards back for a moment.
  const settling = useRef<Settling>({}); // id -> { at, after: load number the save finished at }
  const loads = useRef(0);

  const setGraph = (next: CanvasGraph | null) => {
    graphRef.current = next;
    setGraphState(next);
  };
  const setPositions = (next: Record<string, Point>) => {
    positionsRef.current = next;
    setPositionsState(next);
  };
  const setDropTarget = (id: string | null) => {
    dropTargetRef.current = id;
    setDropTargetState(id);
  };
  const select = (selection: Selection) => {
    selectedRef.current = selection;
    setSelected(selection);
  };
  useEffect(() => {
    sizesRef.current = sizes;
  }, [sizes]);

  const canEdit = !!graph?.can_edit;
  // Only the environment canvas has its own card positions (the server and project views save on it).
  const canMove = canEdit;
  const nodeById = useCallback((id: string) => graph?.nodes.find((n) => n.id === id), [graph]);
  const linkById = (id: string) => graph?.links.find((l) => l.id === id);
  const rectOf = (id: string) => {
    const node = graphRef.current?.nodes.find((n) => n.id === id);
    return node ? cardRect(node, positionsRef.current, sizesRef.current) : null;
  };
  const zoneNames = useCallback(
    (node: { zone?: string | null; extra_zones?: string[] }) => {
      const names = new Map((graph?.zones ?? []).map((z) => [z.id, z.name]));
      return [node.zone, ...(node.extra_zones ?? [])].filter((id): id is string => !!id).map((id) => names.get(id) || id);
    },
    [graph],
  );

  const toast = useCallback((text: string, bad = false) => {
    setToastMessage({ text, bad });
    window.clearTimeout(timers.current.toast);
    timers.current.toast = window.setTimeout(() => setToastMessage(null), bad ? 5000 : 2600);
  }, []);

  function saveView() {
    window.clearTimeout(timers.current.view);
    try {
      localStorage.setItem(viewKey, JSON.stringify(view.current));
    } catch {
      // Storage full or blocked: the canvas fits to the screen next time.
    }
  }

  // ── Toolbar placement: desktop docks it in the zoom controls bar, small screens above the canvas ──
  useEffect(() => {
    const query = desktopQuery();
    const onChange = () => setDesktop(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  /** Desktop: the canvas fills the space behind the top bar, so fit and the side panel use only the part it does not cover. */
  const coveredInsets = useCallback(() => {
    const gap = 8;
    const topbar = document.querySelector(".app-topbar");
    const v = viewport.current?.getBoundingClientRect();
    if (!v || !desktopQuery().matches || !topbar) return { top: 0, left: 0 };
    if (document.documentElement.dataset.navStyle !== "floating") return { top: Math.max(0, topbar.getBoundingClientRect().bottom + gap - v.top), left: 0 };
    const panels = [document.querySelector(".app-sidebar > div > nav")].map((el) => el?.getBoundingClientRect()).filter((r): r is DOMRect => !!r?.width);
    return { top: Math.max(0, topbar.getBoundingClientRect().bottom + gap - v.top), left: Math.max(0, ...panels.map((r) => r.right + gap - v.left)) };
  }, []);
  useEffect(() => {
    const align = () => setPanelTop(desktopQuery().matches && document.querySelector(".app-topbar") ? `${coveredInsets().top}px` : "");
    align();
    window.addEventListener("resize", align);
    return () => window.removeEventListener("resize", align);
  }, [desktop, coveredInsets]);

  // ── View ──
  useEffect(() => {
    const root = rootEl.current;
    const vp = viewport.current;
    const w = world.current;
    if (!root || !vp || !w) return;
    pz.current = panZoom({
      root,
      viewport: vp,
      world: w,
      getView: () => view.current,
      onChange: () => {
        setZoom(view.current.z);
        window.clearTimeout(timers.current.view);
        timers.current.view = window.setTimeout(saveView, 300);
      },
      canPan: (e) => !(e.target as Element).closest("[data-ec-card],[data-ec-zone-header],[data-ec-zone-drag],[data-ec-group-header],[data-ec-label],[data-ec-link],a,button,input"),
      onPanEnd: (moved) => {
        if (!moved && selectedRef.current) select(null);
      },
    });
    pz.current.apply();
    return () => pz.current?.destroy();
    // saveView reads refs only.
  }, []);

  /** Shows every card; the first fit of a load keeps them readable (see fitView). */
  const fit = useCallback(
    ({ readable = false } = {}, g = graphRef.current, at = positions, measured = sizes) => {
      const vp = viewport.current;
      if (!vp || !pz.current) return;
      const all = g ? zoneBoxes(g, at, measured) : [];
      const r = vp.getBoundingClientRect();
      const inset = coveredInsets();
      if (!all.length || !r.width) {
        view.current = { x: inset.left + 40, y: inset.top + 40, z: 1 };
      } else {
        const bounds = {
          minX: Math.min(...all.map((b) => b.x)),
          minY: Math.min(...all.map((b) => b.y)),
          maxX: Math.max(...all.map((b) => b.x + b.width)),
          maxY: Math.max(...all.map((b) => b.y + b.height)),
        };
        view.current = fitView(bounds, { left: inset.left, top: inset.top, width: r.width - inset.left, height: r.height - inset.top }, readable);
      }
      pz.current.apply();
    },
    [positions, sizes, coveredInsets],
  );

  /** Changes the shown graph (links, saved positions) without laying the cards out again. */
  const patchGraph = (changes: Partial<CanvasGraph>) => {
    const current = graphRef.current;
    if (current) setGraph({ ...current, ...changes });
  };

  // ── Data ──
  /** Shows a loaded graph: local moves that are not saved yet (or not loaded back yet) stay where the user put them. */
  const applyGraph = useCallback((loaded: CanvasGraph) => {
    if (destroyed.current) return;
    if (interactions.current.size) {
      deferred.current = loaded;
      return;
    }
    const next = normalizeGraph(loaded);
    const kept = Object.fromEntries(Object.entries(settling.current).map(([id, s]) => [id, s.at]));
    next.positions = { ...next.positions, ...kept, ...Object.fromEntries(Object.entries(unsaved.current).map(([id, p]) => [id, { x: p.x, y: p.y }])) };
    setGraph(next);
    setPositions(layoutGraph(next));
    setError(null);
    setHover((h) => (h && next.nodes.some((n) => n.id === h) ? h : null));
    const s = selectedRef.current;
    if (s && !(s.kind === "node" ? next.nodes.some((n) => n.id === s.id) : next.links.some((l) => l.id === s.id))) select(null);
  }, []);

  /** A load that started after the save returned the saved moves. */
  const dropSettled = (started: number) => {
    for (const [id, entry] of Object.entries(settling.current)) if (entry.after < started) delete settling.current[id];
  };

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (destroyed.current) return;
      if (loadingRef.current) {
        reloadQueued.current = true;
        return;
      }
      loadingRef.current = true;
      setLoading(true);
      const started = ++loads.current;
      try {
        const next = await canvasApi<CanvasGraph>("GET", base);
        dropSettled(started);
        applyGraph(next);
        if (!quiet && fitted.current && next) toast("Canvas refreshed.");
      } catch (e) {
        if (destroyed.current) return;
        if (graphRef.current) toast(errorText(e), true);
        else setError(errorText(e));
      } finally {
        loadingRef.current = false;
        setLoading(false);
        if (!destroyed.current && reloadQueued.current) {
          reloadQueued.current = false;
          void load({ quiet: true });
        }
      }
    },
    [base, toast, applyGraph],
  );

  // Render the cards, then measure them, so frames, links and fit use their real sizes.
  useLayoutEffect(() => {
    const root = rootEl.current;
    if (!root || !graph) return;
    const next: Record<string, Size> = {};
    for (const el of root.querySelectorAll<HTMLElement>("[data-ec-card]")) {
      if (el.offsetWidth && el.dataset.id) next[el.dataset.id] = { width: el.offsetWidth, height: el.offsetHeight };
    }
    const same = Object.keys(next).length === Object.keys(sizes).length && Object.entries(next).every(([id, s]) => sizes[id]?.width === s.width && sizes[id]?.height === s.height);
    if (!same) {
      sizesRef.current = next;
      setSizes(next);
      return;
    }
    if (!fitted.current) {
      fitted.current = true;
      // The first load keeps a saved view.
      if (restored.current) {
        restored.current = null;
        pz.current?.apply();
      } else fit({ readable: true }, graph, positions, next);
    }
  }, [graph, positions, sizes, fit]);

  // A new link: its panel opens with the label field focused.
  useEffect(() => {
    if (focusLabel) rootEl.current?.querySelector<HTMLInputElement>("[data-ec-label-input]")?.focus();
  }, [focusLabel]);

  // ── Persistence ──
  /** Keeps moves that are being saved on the canvas (see settling). */
  const hold = (moves: Record<string, Point>) => {
    for (const [id, at] of Object.entries(moves)) settling.current[id] = { at, after: Infinity };
  };
  /** The save is done: loads that start from now on return the moves, so they can replace them. */
  const settle = (moves: Record<string, Point>) => {
    for (const id of Object.keys(moves)) if (settling.current[id]?.at === moves[id]) settling.current[id]!.after = loads.current;
  };
  const release = (moves: Record<string, Point>) => {
    for (const id of Object.keys(moves)) if (settling.current[id]?.at === moves[id]) delete settling.current[id];
  };

  async function flushSave(options: { keepalive?: boolean } = {}) {
    window.clearTimeout(timers.current.save);
    const batch = { ...unsaved.current };
    const ids = Object.keys(batch);
    if (!ids.length || !graphRef.current) return;
    const rounded = Object.fromEntries(ids.map((id) => [id, { x: Math.round(batch[id]!.x), y: Math.round(batch[id]!.y) }]));
    hold(rounded);
    for (const id of ids) if (unsaved.current[id] === batch[id]) delete unsaved.current[id];
    try {
      await canvasApi("PATCH", `${base}/positions`, { positions: rounded }, options);
      settle(rounded);
      if (graphRef.current && !destroyed.current) patchGraph({ positions: { ...(graphRef.current.positions || {}), ...rounded } });
    } catch (e) {
      release(rounded);
      if (destroyed.current) return;
      toast(errorText(e), true);
      void load({ quiet: true });
    }
  }
  const flushRef = useRef(flushSave);
  flushRef.current = flushSave;
  function queueSave(moves: Record<string, Point>) {
    Object.assign(unsaved.current, moves);
    window.clearTimeout(timers.current.save);
    timers.current.save = window.setTimeout(() => void flushRef.current(), 400);
  }

  useEffect(() => {
    destroyed.current = false;
    void load({ quiet: true });
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timers.current.refresh);
      timers.current.refresh = window.setTimeout(() => void load({ quiet: true }), 300);
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedRef.current && !e.defaultPrevented) select(null);
    };
    const onPageHide = () => {
      saveView();
      if (Object.keys(unsaved.current).length) void flushRef.current({ keepalive: true });
    };
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("keydown", onKeydown);
    window.addEventListener("pagehide", onPageHide);
    const t = timers.current;
    return () => {
      saveView();
      if (Object.keys(unsaved.current).length) void flushRef.current({ keepalive: true });
      destroyed.current = true;
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pagehide", onPageHide);
      window.clearTimeout(t.toast);
      window.clearTimeout(t.view);
      window.clearTimeout(t.refresh);
      window.clearTimeout(t.save);
    };
    // saveView reads refs only.
  }, [load]);

  function closeNotice() {
    try {
      localStorage.setItem(MOBILE_NOTICE_KEY, "true");
    } catch {
      // Storage blocked: closed until the next page load.
    }
    setShowNotice(false);
  }

  // ── Links ──
  function replaceLink(link: CanvasLink) {
    const g = graphRef.current;
    if (g) patchGraph({ links: g.links.map((l) => (l.id === link.id ? link : l)) });
  }

  async function saveLabel(link: CanvasLink, value: string): Promise<boolean> {
    try {
      const updated = await canvasApi<CanvasLink>("PATCH", `${base}/links/${encodeURIComponent(link.id)}`, { label: value || null });
      replaceLink({ ...link, ...(updated?.id ? updated : { label: value || null }) });
      toast("Label saved.");
      return true;
    } catch (e) {
      toast(errorText(e), true);
      return false;
    }
  }

  async function deleteLink(link: CanvasLink) {
    try {
      await canvasApi("DELETE", `${base}/links/${encodeURIComponent(link.id)}`);
      const g = graphRef.current;
      if (g) patchGraph({ links: g.links.filter((l) => l.id !== link.id) });
      select(null);
      toast("Link removed.");
    } catch (e) {
      toast(errorText(e), true);
    }
  }

  async function createLink(source: string, target: string) {
    const g = graphRef.current;
    if (!g) return;
    if (!canLink(g.links, source, target)) {
      toast("These resources are already linked.", true);
      return;
    }
    const entry = { source, target };
    setPending((p) => [...p, entry]);
    try {
      const created = await canvasApi<CanvasLink>("POST", `${base}/links`, { source, target });
      if (destroyed.current) return;
      const current = graphRef.current;
      if (created?.id && current) {
        patchGraph({ links: [...current.links.filter((l) => l.id !== created.id), created] });
        select({ kind: "link", id: created.id });
        setFocusLabel((n) => n + 1);
      } else {
        void load({ quiet: true });
      }
    } catch (e) {
      toast(errorText(e), true);
    } finally {
      setPending((p) => p.filter((x) => x !== entry));
    }
  }

  // ── Interactions ──
  function begin(key: string) {
    interactions.current.add(key);
  }
  function end(key: string) {
    interactions.current.delete(key);
    if (!interactions.current.size && deferred.current) {
      const next = deferred.current;
      deferred.current = null;
      applyGraph(next);
    }
  }
  function hoverCard(id: string, on: boolean) {
    if (on && !interactions.current.size) setHover(id);
    else if (!on) setHover((h) => (h === id ? null : h));
  }

  function startCardDrag(id: string, card: HTMLElement, e: ReactPointerEvent<HTMLDivElement>) {
    const g = graphRef.current;
    if (!g || e.button !== 0 || (e.target as Element).closest("a,button,input,[data-ec-port]")) return;
    e.stopPropagation();
    const from = positionsRef.current[id];
    const start = { cx: e.clientX, cy: e.clientY, x: from?.x ?? 0, y: from?.y ?? 0 };
    const movable = canMove;
    // The other cards and frames stay put during the drag, so measure them once.
    const rules = dragRules(g, positionsRef.current, sizesRef.current, id);
    let moved = false;
    capture(card, e.pointerId);
    begin(`card:${id}`);
    track(
      card,
      (ev) => {
        if (!moved && Math.hypot(ev.clientX - start.cx, ev.clientY - start.cy) < 4) return;
        if (!movable) return;
        const rect = rectOf(id);
        if (!rect) return;
        const z = view.current.z;
        const wanted = { x: start.x + (ev.clientX - start.cx) / z, y: start.y + (ev.clientY - start.cy) / z, w: rect.width, h: rect.height };
        // Cards cannot cover each other or another zone: stop at the edge of what is in the way.
        const spot = freeSpot(wanted, rules.others, BOX_GAP, rules.fits);
        if (!spot) return;
        moved = true;
        setPositions({ ...positionsRef.current, [id]: { x: spot.x, y: spot.y } });
      },
      () => {
        if (moved) queueSave({ [id]: { ...positionsRef.current[id]! } });
        else select({ kind: "node", id });
        end(`card:${id}`);
      },
    );
  }

  function startZoneDrag(box: ZoneBox, header: HTMLElement, e: ReactPointerEvent<HTMLDivElement>) {
    const g = graphRef.current;
    if (!g || e.button !== 0 || !canMove || (e.target as Element).closest("a,button")) return;
    e.stopPropagation();
    const ids = box.nodes.filter((id) => positionsRef.current[id]);
    const starts = Object.fromEntries(ids.map((id) => [id, { ...positionsRef.current[id]! }]));
    const origin = { cx: e.clientX, cy: e.clientY };
    // Zones cannot cover each other: the frame stops at the edge of another zone.
    const zone = toBox(box);
    const others = zoneBoxes(g, positionsRef.current, sizesRef.current)
      .filter((z) => z.id !== box.id)
      .map(toBox);
    let moved: Point | null = null; // how far the zone moved
    capture(header, e.pointerId);
    begin("zone");
    track(
      header,
      (ev) => {
        if (!moved && Math.hypot(ev.clientX - origin.cx, ev.clientY - origin.cy) < 4) return;
        const z = view.current.z;
        const spot = freeSpot({ ...zone, x: zone.x + (ev.clientX - origin.cx) / z, y: zone.y + (ev.clientY - origin.cy) / z }, others);
        if (!spot) return;
        const delta = { x: spot.x - zone.x, y: spot.y - zone.y };
        moved = delta;
        const next = { ...positionsRef.current };
        for (const id of ids) next[id] = { x: starts[id]!.x + delta.x, y: starts[id]!.y + delta.y };
        setPositions(next);
      },
      () => {
        if (moved) queueSave(Object.fromEntries(ids.map((id) => [id, { ...positionsRef.current[id]! }])));
        end("zone");
      },
    );
  }

  function startConnect(id: string, port: HTMLElement, e: ReactPointerEvent<HTMLSpanElement>) {
    if (e.button !== 0 || !graphRef.current?.can_edit) return;
    e.stopPropagation();
    e.preventDefault();
    const a = rectOf(id);
    if (!a) return;
    const from = { x: a.x + a.width, y: a.y + a.height / 2 };
    capture(port, e.pointerId);
    begin("connect");
    setHover(null);
    track(
      port,
      (ev) => {
        const to = pz.current?.toWorld(ev.clientX, ev.clientY);
        if (to) setTemp({ from, to });
        const tid = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-ec-card]")?.dataset.id;
        setDropTarget(tid && canConnect(graphRef.current, id, tid) ? tid : null);
      },
      () => {
        const chosen = dropTargetRef.current;
        setDropTarget(null);
        setTemp(null);
        const done = () => end("connect");
        if (chosen) void createLink(id, chosen).finally(done);
        else done();
      },
    );
  }

  // Double-click on a card opens its page. Tracked on pointerdown (capture phase): the first click
  // re-renders the card and can open the side panel over it, so two presses at the same point open
  // the page of the first one.
  const lastOpen = useRef<{ href: string; at: number; x: number; y: number } | null>(null);
  function openOnDoubleClick(e: ReactPointerEvent<HTMLDivElement>) {
    const target = e.target as Element;
    const own = e.button !== 0 || !!target.closest("a,button,input,[data-ec-port]");
    const last = lastOpen.current;
    if (!own && last && e.timeStamp - last.at < DOUBLE_CLICK_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 6) {
      e.preventDefault();
      e.stopPropagation();
      window.location.assign(last.href);
      lastOpen.current = null;
      return;
    }
    const href = own ? null : (target.closest<HTMLElement>("[data-ec-open]")?.dataset.ecOpen ?? null);
    lastOpen.current = href ? { href, at: e.timeStamp, x: e.clientX, y: e.clientY } : null;
  }

  // ── Derived view data ──
  const boxes = useMemo(() => (graph ? zoneBoxes(graph, positions, sizes) : []), [graph, positions, sizes]);
  const downZones = useMemo(() => unreachableZones(graph), [graph]);
  const shapes = useMemo(() => {
    const out = [];
    for (const link of graph?.links ?? []) {
      const sourceNode = graph?.nodes.find((n) => n.id === link.source);
      const targetNode = graph?.nodes.find((n) => n.id === link.target);
      const a = sourceNode ? cardRect(sourceNode, positions, sizes) : null;
      const b = targetNode ? cardRect(targetNode, positions, sizes) : null;
      if (!a || !b) continue;
      const isSelected = selected?.kind === "link" && selected.id === link.id;
      const related = !!hover && (link.source === hover || link.target === hover);
      out.push({
        link,
        ...linkPath(a, b),
        selected: isSelected,
        faded: !!hover && !related,
        stroke: isSelected
          ? "fill-none stroke-coollabs dark:stroke-warning"
          : link.missing
            ? `ec-missing fill-none stroke-red-400 dark:stroke-red-400/70 ${hover && !related ? "opacity-20" : ""}`
            : related
              ? "fill-none stroke-neutral-700 dark:stroke-white/80"
              : hover
                ? "fill-none stroke-neutral-400 opacity-20 dark:stroke-white/40"
                : "fill-none stroke-neutral-400 dark:stroke-white/35",
        title: link.label ? `${link.label} (click to open)` : "Click to open this link",
      });
    }
    return out;
  }, [graph, positions, sizes, selected, hover]);
  const pendingPaths = useMemo(() => {
    const rect = (id: string) => {
      const node = graph?.nodes.find((n) => n.id === id);
      return node ? cardRect(node, positions, sizes) : null;
    };
    return pending.flatMap((p) => {
      const a = rect(p.source);
      const b = rect(p.target);
      return a && b ? [linkPath(a, b).d] : [];
    });
  }, [pending, graph, positions, sizes]);
  const tempPath = useMemo(() => {
    if (!temp) return null;
    const { from, to } = temp;
    const dx = Math.max(40, Math.abs(to.x - from.x) / 2);
    return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
  }, [temp]);
  const panelNode = selected?.kind === "node" ? (nodeById(selected.id) ?? null) : null;
  const panelLink = selected?.kind === "link" ? (linkById(selected.id) ?? null) : null;
  const empty = !!graph && !graph.nodes.length;
  const toolbar = (className: string) => <Toolbar className={className} viewOnly={!!graph && !canEdit} viewOnlyTitle={props.viewOnlyTitle} views={props.views} />;

  return (
    // Same look as the deploy canvas: a rounded top bar box on the backdrop.
    <div ref={rootEl} className="absolute inset-0 z-0 flex flex-col gap-2 overflow-hidden bg-neutral-50 p-2 text-[13px] text-neutral-700 dark:bg-app dark:text-fg-dim" data-ec-root="" onPointerDownCapture={openOnDoubleClick}>
      {/* The toolbar's place above the canvas on small screens; on desktop it is in the zoom controls bar. */}
      {desktop ? null : toolbar(BOXED_BAR)}

      {showNotice ? (
        <div className="flex shrink-0 items-start gap-2 rounded-xl bg-red-600 py-2.5 pr-2 pl-3 text-[12.5px] leading-[1.125rem] text-white md:hidden" data-ec-mobile-notice="" role="note">
          <CanvasIcon name="info" className="size-4 mt-px" />
          <p className="min-w-0 flex-1">The canvas is not optimized for mobile yet. It works best on a larger screen.</p>
          <button type="button" className="grid size-6.5 shrink-0 -mt-0.75 place-items-center rounded-md hover:bg-white/20" title="Close" aria-label="Close this notice" onClick={closeNotice}>
            <CanvasIcon name="x" className="size-4" />
          </button>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div
          ref={viewport}
          className="absolute inset-0 cursor-grab touch-none overflow-hidden select-none bg-[radial-gradient(circle,rgb(0_0_0/0.13)_1px,transparent_1px)] active:cursor-grabbing dark:bg-[radial-gradient(circle,rgb(255_255_255/0.09)_1px,transparent_1px)]"
          data-ec-viewport=""
        >
          <div ref={world} className="absolute top-0 left-0 origin-top-left">
            <div className="absolute top-0 left-0">
              {boxes.map((box) => (
                <Zone key={box.id ?? "__none"} box={box} movable={canMove} nodes={box.nodes.map((id) => nodeById(id)).filter((n) => !!n)} onPress={(e) => startZoneDrag(box, e.currentTarget, e)} />
              ))}
            </div>
            <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width="1" height="1">
              {shapes.map((shape) => (
                <g key={shape.link.id}>
                  <path d={shape.d} strokeWidth={shape.selected ? "2.5" : "1.75"} strokeLinecap="round" className={`${shape.stroke} transition-opacity`} />
                  <path
                    d={shape.d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth="14"
                    pointerEvents="stroke"
                    className="cursor-pointer"
                    data-ec-link={shape.link.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      select({ kind: "link", id: shape.link.id });
                    }}
                  >
                    <title>{shape.title}</title>
                  </path>
                </g>
              ))}
              {pendingPaths.map((d, i) => (
                <path key={`pending:${i}`} d={d} strokeWidth="2" strokeLinecap="round" className="ec-temp fill-none stroke-coollabs dark:stroke-warning" />
              ))}
              {tempPath ? <path d={tempPath} strokeWidth="2" strokeLinecap="round" className="ec-temp fill-none stroke-coollabs dark:stroke-warning" /> : null}
            </svg>
            <div className="absolute top-0 left-0">
              {shapes
                .filter((s) => s.link.label)
                .map((shape) => (
                  <button
                    key={shape.link.id}
                    type="button"
                    className={`absolute max-w-48 -translate-x-1/2 -translate-y-1/2 cursor-pointer truncate rounded-full border px-2 py-0.5 text-[11px] font-medium shadow-sm transition-opacity ${
                      shape.selected ? "border-coollabs bg-white text-coollabs dark:border-warning dark:bg-panel dark:text-warning" : "border-neutral-200 bg-white text-neutral-600 dark:border-white/[0.1] dark:bg-panel dark:text-fg-dim"
                    } ${shape.faded ? "opacity-30" : ""}`}
                    style={{ left: `${shape.mid.x}px`, top: `${shape.mid.y}px` }}
                    data-ec-label=""
                    onClick={(e) => {
                      e.stopPropagation();
                      select({ kind: "link", id: shape.link.id });
                    }}
                  >
                    {shape.link.label}
                  </button>
                ))}
            </div>
            <div className="absolute top-0 left-0">
              {(graph?.nodes ?? []).map((node) => (
                <Card
                  key={node.id}
                  node={node}
                  position={positions[node.id]}
                  selected={selected?.kind === "node" && selected.id === node.id}
                  dropTarget={dropTarget === node.id}
                  movable={canMove}
                  port={canEdit ? "Drag to another card to draw a link" : null}
                  zoneNames={zoneNames(node)}
                  serverDown={!!node.zone && downZones.has(node.zone)}
                  onPress={(e, card) => startCardDrag(node.id, card, e)}
                  onConnect={(e, port) => startConnect(node.id, port, e)}
                  onSelect={() => select({ kind: "node", id: node.id })}
                  onHover={(on) => hoverCard(node.id, on)}
                />
              ))}
            </div>
            {/* Link end dots sit above the cards, on their edges (like the deploy canvas ports). */}
            <div className="pointer-events-none absolute top-0 left-0">
              {shapes.flatMap((shape) =>
                [shape.from, shape.to].map((at, i) => (
                  <span
                    key={`${shape.link.id}:${i}`}
                    className={`absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow dark:border-raised ${shape.selected ? "bg-coollabs dark:bg-warning" : "bg-neutral-400 dark:bg-neutral-500"} ${shape.faded ? "opacity-30" : ""}`}
                    style={{ left: `${at.x}px`, top: `${at.y}px` }}
                  ></span>
                )),
              )}
            </div>
          </div>
        </div>

        {error || empty ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
            <div className="pointer-events-auto flex max-w-sm flex-col items-center rounded-xl border border-neutral-200 bg-white px-6 py-8 text-center shadow-sm dark:border-white/[0.08] dark:bg-white/[0.05]">
              <div className="mb-3 flex size-9 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-fg-dim">
                <CanvasIcon name="service" className="size-4" />
              </div>
              {error ? (
                <>
                  <p className="text-[13px] font-semibold text-black dark:text-fg">Could not load the canvas</p>
                  <p className="mt-1 text-[12px] text-neutral-500 dark:text-fg-faint">{error}</p>
                  <button type="button" className="button mt-4" onClick={() => void load()}>
                    Try again
                  </button>
                </>
              ) : (
                <>
                  <p className="text-[13px] font-semibold text-black dark:text-fg">No resources in this environment yet</p>
                  {props.newHref ? (
                    <a className="button button-highlighted mt-4" href={props.newHref}>
                      <CanvasIcon name="plus" />
                      Add resource
                    </a>
                  ) : null}
                </>
              )}
            </div>
          </div>
        ) : null}

        {/* Bottom: the zoom controls in the center. On desktop, an open side panel shifts the center to the free area. */}
        <div className={`pointer-events-none absolute bottom-3 left-3 right-3 z-20 grid grid-cols-[1fr_auto_1fr] items-end gap-2 *:pointer-events-auto ${panelNode || panelLink ? "lg:pr-[20.5rem]" : ""}`.trimEnd()} data-ec-dock="">
          <div className="justify-self-start"></div>
          <CanvasControls inline zoom={zoom} loading={loading} onZoom={(z) => pz.current?.zoomTo(z)} onFit={() => fit()} onRefresh={() => void load()}>
            {desktop ? toolbar(DOCKED_BAR) : null}
          </CanvasControls>
        </div>

        {graph && (panelNode || panelLink) ? (
          <Panel
            key={`${selected?.kind}:${selected?.id}`}
            graph={graph}
            node={panelNode}
            link={panelLink}
            canEdit={canEdit}
            top={panelTop}
            nodeById={nodeById}
            zoneNames={zoneNames}
            onSelect={select}
            onClose={() => select(null)}
            onLabel={saveLabel}
            onDelete={deleteLink}
          />
        ) : null}

        {/* Above the zoom controls. */}
        <div className="pointer-events-none absolute bottom-16 left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-2">
          {toastMessage ? (
            <div
              className={
                toastMessage.bad
                  ? "pointer-events-auto max-w-md rounded-lg border border-red-200 bg-white px-3 py-2 text-[12px] text-red-700 shadow-lg dark:border-red-500/30 dark:bg-panel dark:text-red-300"
                  : "pointer-events-auto max-w-md rounded-lg border border-neutral-200 bg-white px-3 py-2 text-[12px] text-neutral-700 shadow-lg dark:border-white/[0.08] dark:bg-panel dark:text-fg"
              }
              role={toastMessage.bad ? "alert" : "status"}
            >
              {toastMessage.text}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
