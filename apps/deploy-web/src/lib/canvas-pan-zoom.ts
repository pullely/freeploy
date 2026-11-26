// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas-core.js (Apache-2.0), modified.
//
// The canvases' pan and zoom: wheel zoom (Ctrl/Cmd) and pan, two-finger pinch,
// drag-to-pan on the background, and middle-button drag-to-pan anywhere.
import { MAX_ZOOM, MIN_ZOOM, type View } from "./environment-canvas";

/** Viewport position inside the root, so the root's dots (floating nav, see app.css) line up with the viewport's. */
function canvasDotsOffset(root: HTMLElement, viewport: HTMLElement) {
  const r = root.getBoundingClientRect();
  const v = viewport.getBoundingClientRect();
  return { x: v.left - r.left, y: v.top - r.top };
}

function setCanvasDots(root: HTMLElement, size: number, x: number, y: number, atMaxZoom = false) {
  root.style.setProperty("--canvas-dots-size", `${size}px ${size}px`);
  root.style.setProperty("--canvas-dots-position", `${x}px ${y}px`);
  // Fully zoomed in: the grid dots turn into small logos (app.css).
  root.classList.toggle("canvas-zoom-max", atMaxZoom);
}

export interface PanZoomOptions {
  root: HTMLElement;
  viewport: HTMLElement;
  world: HTMLElement;
  getView: () => View;
  onChange?: () => void;
  /** Which left-button presses pan. */
  canPan: (e: PointerEvent) => boolean;
  onPanStart?: () => void;
  /** Runs when a left-button pan ends; moved is false for a click. */
  onPanEnd?: (moved: boolean) => void;
}

export interface PanZoom {
  apply: () => void;
  toWorld: (cx: number, cy: number) => { x: number; y: number };
  zoomTo: (z: number, cx?: number, cy?: number) => void;
  destroy: () => void;
}

/** getView() returns the current { x, y, z }, which is changed in place. */
export function panZoom({ root, viewport, world, getView, onChange, canPan, onPanStart, onPanEnd }: PanZoomOptions): PanZoom {
  const cleanups: Array<() => void> = [];
  const on = <K extends keyof HTMLElementEventMap>(type: K, listener: (e: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions | boolean) => {
    viewport.addEventListener(type, listener, options);
    cleanups.push(() => viewport.removeEventListener(type, listener, options));
  };
  function apply() {
    const { x, y, z } = getView();
    const offset = canvasDotsOffset(root, viewport);
    world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    viewport.style.backgroundSize = `${20 * z}px ${20 * z}px`;
    viewport.style.backgroundPosition = `${x}px ${y}px`;
    setCanvasDots(root, 20 * z, x + offset.x, y + offset.y, z >= MAX_ZOOM);
    onChange?.();
  }
  function toWorld(cx: number, cy: number) {
    const view = getView();
    const r = viewport.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.z, y: (cy - r.top - view.y) / view.z };
  }
  /** Zooms to z around a screen point (the viewport centre by default). */
  function zoomTo(z: number, cx?: number, cy?: number) {
    const view = getView();
    const r = viewport.getBoundingClientRect();
    const px = cx ?? r.left + r.width / 2;
    const py = cy ?? r.top + r.height / 2;
    const before = toWorld(px, py);
    view.z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    view.x = px - r.left - before.x * view.z;
    view.y = py - r.top - before.y * view.z;
    apply();
  }

  on(
    "wheel",
    (e) => {
      e.preventDefault();
      const view = getView();
      if (e.ctrlKey || e.metaKey) {
        zoomTo(view.z * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
      } else {
        view.x -= e.deltaX;
        view.y -= e.deltaY;
        apply();
      }
    },
    { passive: false },
  );
  // Touch: two fingers pinch to zoom and pan, anywhere on the viewport (also on cards).
  const touches = new Map<number, { x: number; y: number }>();
  const pinchFingers = new Set<number>();
  let pinch: { cx: number; cy: number; d: number; z: number; x: number; y: number } | null = null;
  const pinchState = () => {
    const [a, b] = [...touches.values()] as [{ x: number; y: number }, { x: number; y: number }];
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  };
  on(
    "pointerdown",
    (e) => {
      if (e.pointerType !== "touch") return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size !== 2) return;
      for (const id of touches.keys()) pinchFingers.add(id);
      const start = pinchState();
      pinch = { ...start, z: getView().z, ...toWorld(start.cx, start.cy) };
      onPanStart?.();
      e.stopImmediatePropagation();
    },
    true,
  );
  on(
    "pointermove",
    (e) => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!pinchFingers.has(e.pointerId)) return;
      e.stopImmediatePropagation();
      if (!pinch || touches.size < 2) return;
      const now = pinchState();
      const view = getView();
      const r = viewport.getBoundingClientRect();
      view.z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (pinch.z * now.d) / pinch.d));
      view.x = now.cx - r.left - pinch.x * view.z;
      view.y = now.cy - r.top - pinch.y * view.z;
      apply();
    },
    true,
  );
  const liftFinger = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    pinchFingers.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
  };
  on("pointerup", liftFinger, true);
  on("pointercancel", liftFinger, true);

  // A native drag (card logos, links) cancels the pointer, so the pan drag stops after a few pixels.
  on("dragstart", (e) => e.preventDefault());
  // A middle-button pan that moved does not also open the link under the pointer in a new tab.
  let panned = false;
  on(
    "auxclick",
    (e) => {
      if (!panned) return;
      panned = false;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );

  function startPan(e: PointerEvent, middle: boolean) {
    onPanStart?.();
    const view = getView();
    const start = { cx: e.clientX, cy: e.clientY, x: view.x, y: view.y };
    let moved = false;
    try {
      viewport.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already released pointer.
    }
    viewport.classList.add("panning");
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.cx, ev.clientY - start.cy) < 4) return;
      moved = true;
      view.x = start.x + ev.clientX - start.cx;
      view.y = start.y + ev.clientY - start.cy;
      apply();
    };
    const up = () => {
      viewport.classList.remove("panning");
      viewport.removeEventListener("pointermove", move);
      viewport.removeEventListener("pointerup", up);
      viewport.removeEventListener("pointercancel", up);
      if (middle) panned = moved;
      else onPanEnd?.(moved);
    };
    viewport.addEventListener("pointermove", move);
    viewport.addEventListener("pointerup", up);
    viewport.addEventListener("pointercancel", up);
  }
  // The middle mouse button pans from anywhere (also from cards and frames).
  on(
    "pointerdown",
    (e) => {
      panned = false;
      if (pinch || e.pointerType !== "mouse" || e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      startPan(e, true);
    },
    true,
  );
  on("pointerdown", (e) => {
    if (e.button !== 0 || pinch || !canPan(e)) return;
    startPan(e, false);
  });

  return { apply, toWorld, zoomTo, destroy: () => cleanups.forEach((c) => c()) };
}
