// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/environment/EnvironmentCanvas.svelte (Apache-2.0), modified.
//
// Environment canvas (Beta): a read-only diagram of one environment. Server zones hold
// resource cards; a click opens the card's side panel, a double-click its page.
//
// Ported: the layout (zones, cards, link curves and their labels and end dots), pan and zoom
// (wheel, pinch, drag, middle button, Cmd/Ctrl +/-/0), fit, the saved view per team and page,
// the toolbar with the beta badge and "View only", the side panel, the empty and error states,
// Refresh and the refresh when the tab comes back, the toast and the small-screen notice.
// Not ported: moving cards and zones and drawing, labelling and removing links (Freeploy saves
// neither positions nor links yet, so the canvas is view only), the live status over Echo
// (Freeploy has no realtime channel yet: Refresh and the tab's return load the latest status), and
// the server, project, dashboard, shared variable and tag canvases that reuse this view.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { getJson } from "../../../lib/api";
import { panZoom, type PanZoom } from "../../../lib/canvas-pan-zoom";
import {
  cardRect,
  DOUBLE_CLICK_MS,
  fitView,
  layoutGraph,
  linkPath,
  MOBILE_NOTICE_KEY,
  normalizeGraph,
  readView,
  unreachableZones,
  zoneBoxes,
  type CanvasGraph,
  type Point,
  type Size,
  type View,
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

export function EnvironmentCanvas(props: {
  /** The canvas endpoint (GET …/projects/{uuid}/environments/{env_uuid}/canvas). */
  endpoint: string;
  /** The team of the page, so the saved view is kept per team and page. */
  team: string;
  /** The page's views (List view, Shared variables, Settings, New resource), moved into the toolbar. */
  views: ReactNode;
  viewOnlyTitle: string;
  /** "Add resource" in the empty state, for users who may create resources. */
  newHref: string | null;
}) {
  const [graph, setGraph] = useState<CanvasGraph | null>(null);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const [selected, setSelected] = useState<Selection>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panelTop, setPanelTop] = useState("");
  const [showNotice, setShowNotice] = useState(noticeOpen);
  const [desktop, setDesktop] = useState(() => desktopQuery().matches);

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
  const graphRef = useRef<CanvasGraph | null>(null);
  const timers = useRef({ toast: 0, view: 0, refresh: 0 });

  const canEdit = !!graph?.can_edit;
  const nodeById = useCallback((id: string) => graph?.nodes.find((n) => n.id === id), [graph]);
  const linkById = (id: string) => graph?.links.find((l) => l.id === id);
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
        if (!moved) setSelected(null);
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

  // ── Data ──
  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (loadingRef.current) {
        reloadQueued.current = true;
        return;
      }
      loadingRef.current = true;
      setLoading(true);
      try {
        const r = await getJson<CanvasGraph>(props.endpoint);
        if (!r.data) {
          const message = `Request failed (HTTP ${r.status}).`;
          if (graphRef.current) toast(message, true);
          else setError(message);
          return;
        }
        const next = normalizeGraph(r.data);
        graphRef.current = next;
        setGraph(next);
        setPositions(layoutGraph(next));
        setError(null);
        setHover((h) => (h && next.nodes.some((n) => n.id === h) ? h : null));
        setSelected((s) => (s && (s.kind === "node" ? next.nodes.some((n) => n.id === s.id) : next.links.some((l) => l.id === s.id)) ? s : null));
        if (!quiet && fitted.current) toast("Canvas refreshed.");
      } finally {
        loadingRef.current = false;
        setLoading(false);
        if (reloadQueued.current) {
          reloadQueued.current = false;
          void load({ quiet: true });
        }
      }
    },
    [props.endpoint, toast],
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

  useEffect(() => {
    void load({ quiet: true });
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timers.current.refresh);
      timers.current.refresh = window.setTimeout(() => void load({ quiet: true }), 300);
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setSelected(null);
    };
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("keydown", onKeydown);
    window.addEventListener("pagehide", saveView);
    const t = timers.current;
    return () => {
      saveView();
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pagehide", saveView);
      window.clearTimeout(t.toast);
      window.clearTimeout(t.view);
      window.clearTimeout(t.refresh);
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

  // ── Interactions ──
  // A press on a card that does not move selects it (cards cannot be moved here: view only).
  function pressCard(id: string, e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || (e.target as Element).closest("a,button,input,[data-ec-port]")) return;
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY };
    const card = e.currentTarget;
    try {
      card.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already released pointer.
    }
    const up = (ev: PointerEvent) => {
      card.removeEventListener("pointerup", up);
      card.removeEventListener("pointercancel", up);
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) setSelected({ kind: "node", id });
    };
    card.addEventListener("pointerup", up);
    card.addEventListener("pointercancel", up);
  }
  function hoverCard(id: string, on: boolean) {
    if (on) setHover(id);
    else setHover((h) => (h === id ? null : h));
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
                <Zone key={box.id ?? "__none"} box={box} movable={false} nodes={box.nodes.map((id) => nodeById(id)).filter((n) => !!n)} onPress={() => undefined} />
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
                      setSelected({ kind: "link", id: shape.link.id });
                    }}
                  >
                    <title>{shape.title}</title>
                  </path>
                </g>
              ))}
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
                      setSelected({ kind: "link", id: shape.link.id });
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
                  movable={false}
                  zoneNames={zoneNames(node)}
                  serverDown={!!node.zone && downZones.has(node.zone)}
                  onPress={(e) => pressCard(node.id, e)}
                  onSelect={() => setSelected({ kind: "node", id: node.id })}
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
            onSelect={setSelected}
            onClose={() => setSelected(null)}
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
