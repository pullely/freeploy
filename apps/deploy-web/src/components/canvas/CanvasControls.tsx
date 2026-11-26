// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/CanvasControls.svelte (Apache-2.0), modified.
// Zoom and fit controls that float in the bottom-left corner of a canvas.
// With `onRefresh` (environment canvas) it also has a Refresh button. `inline`: the parent places it.
// `children`: more actions after the zoom buttons (the toolbar, on desktop).
import { useEffect, type ReactNode } from "react";
import { zoomShortcut } from "../../lib/environment-canvas";
import { CanvasIcon } from "./environment/Icon";

const BUTTON =
  "grid h-7 min-w-7 place-items-center rounded-md px-1.5 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 disabled:pointer-events-none disabled:opacity-50 dark:text-fg-dim dark:hover:bg-white/[0.07] dark:hover:text-fg";

export function CanvasControls(props: { zoom: number; onZoom: (z: number) => void; onFit: () => void; onRefresh?: () => void; loading?: boolean; inline?: boolean; children?: ReactNode }) {
  const { zoom, onZoom } = props;
  // Cmd/Ctrl + / - / 0 zoom the canvas instead of the page.
  useEffect(() => {
    const onKeydown = (e: KeyboardEvent) => {
      const shortcut = e.defaultPrevented ? null : zoomShortcut(e);
      if (!shortcut) return;
      e.preventDefault();
      onZoom(shortcut === "in" ? zoom * 1.2 : shortcut === "out" ? zoom / 1.2 : 1);
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [zoom, onZoom]);
  return (
    <div
      className={`${props.inline ? "shrink-0" : "absolute bottom-3 left-3 z-20"} flex items-center gap-0.5 rounded-lg border border-neutral-200 bg-white/85 p-0.5 shadow-sm backdrop-blur-sm dark:border-white/[0.08] dark:bg-panel/85`}
      data-canvas-controls=""
    >
      <button type="button" className={BUTTON} title="Zoom out" aria-label="Zoom out" onClick={() => onZoom(zoom / 1.2)}>
        <CanvasIcon name="minus" />
      </button>
      <button type="button" className={`${BUTTON} w-12 text-[12px] font-medium tabular-nums`} title="Reset zoom to 100%" onClick={() => onZoom(1)}>
        {`${Math.round(zoom * 100)}%`}
      </button>
      <button type="button" className={BUTTON} title="Zoom in" aria-label="Zoom in" onClick={() => onZoom(zoom * 1.2)}>
        <CanvasIcon name="plus" />
      </button>
      <span className="mx-0.5 h-4 w-px bg-neutral-200 dark:bg-white/[0.08]"></span>
      <button type="button" className={BUTTON} title="Fit to screen" aria-label="Fit to screen" onClick={props.onFit}>
        <CanvasIcon name="fit" />
      </button>
      {props.onRefresh ? (
        <button type="button" className={BUTTON} title="Load the latest status" aria-label="Refresh" disabled={props.loading} onClick={props.onRefresh}>
          <CanvasIcon name="refresh" className={`size-3.5 ${props.loading ? "animate-spin" : ""}`} />
        </button>
      ) : null}
      {props.children}
    </div>
  );
}
