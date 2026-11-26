// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/deploy/DeployCanvas.svelte and
// resources/js/canvas/deploy/index.js (Apache-2.0), modified.
//
// The deploy canvas: header, step palette, and the canvas with the step cards. The state lives in
// state.ts (init() runs before the first render). Theme: the app's (html.dark).
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { ICONS, load, nodeById, PALETTE, save } from "../../../lib/deploy-canvas";
import { BetaBadge } from "../BetaBadge";
import { CanvasControls } from "../CanvasControls";
import { Dropdown } from "./Dropdown";
import { Edges } from "./Edges";
import { Icon } from "./Icon";
import { Node } from "./Node";
import { PaletteItem } from "./PaletteItem";
import { RunPanel } from "./RunPanel";
import { injectStyles } from "./styles";
import { closeMenu, cv, els, fit, hideResult, leave, pan, pickNext, PORT_Y, queueSave, useDeployCanvas } from "./state";

const stop = (e: PointerEvent) => e.stopPropagation();
const desktopQuery = () => matchMedia("(min-width: 1024px)");
const isDark = () => document.documentElement.classList.contains("dark");

/** onAskReset opens the page's confirmation ("Reset the canvas?"), which resets on confirm. */
export function DeployCanvas({ onAskReset }: { onAskReset: () => void }) {
  useDeployCanvas();
  const viewport = useRef<HTMLDivElement>(null);
  const [dark, setDark] = useState(isDark);
  // Palette: full or icons only ('coolify-canvas:collapsed').
  const [folded, setFolded] = useState(() => load("collapsed", false));
  // Small screens: a notice that the canvas is not optimized for mobile. CSS
  // shows it below 768px; closed once, it stays closed.
  const [noticeOpen, setNoticeOpen] = useState(() => !load("mobile-notice-dismissed", false));
  // Desktop: the header sits in the zoom controls bar (bottom left), as on the
  // other canvases. Small screens: a box above the canvas.
  const [desktop, setDesktop] = useState(() => desktopQuery().matches);

  // A pill joined to the Deploy card: each address opens in a new tab.
  const resultNode = cv.result && nodeById(cv.result.after, cv.flow);
  const foldTitle = folded ? "Show the step names" : "Collapse the steps";

  function toggleFolded() {
    save("collapsed", !load("collapsed", false));
    setFolded(load("collapsed", false));
  }
  function closeNotice() {
    save("mobile-notice-dismissed", true);
    setNoticeOpen(false);
  }
  function askReset() {
    if (!cv.running) onAskReset();
  }

  // Save the flow (without secrets) and the view, 200 ms after a change.
  useEffect(() => queueSave(), [cv.version]);

  useLayoutEffect(() => {
    injectStyles();
    return pan(viewport.current!);
  }, []);

  useEffect(() => {
    els.pz?.apply();
    if (els.fitOnOpen) requestAnimationFrame(fit);
    const theme = new MutationObserver(() => setDark(isDark()));
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const escape = (e: KeyboardEvent) => {
      if (els.root?.isConnected && e.key === "Escape") closeMenu();
    };
    addEventListener("keydown", escape);
    const query = desktopQuery();
    const media = () => setDesktop(query.matches);
    query.addEventListener("change", media);
    return () => {
      query.removeEventListener("change", media);
      theme.disconnect();
      removeEventListener("keydown", escape);
      leave();
    };
  }, []);

  const header = (
    <>
      <div className="mr-auto flex min-w-0 items-center gap-2">
        {cv.target ? (
          // Opened from an environment's New resource page: back to that environment.
          <a className="cv-back button px-2!" href={`/project/${cv.target.project}/environment/${cv.target.environment}`} title="Back to the environment" aria-label="Back to the environment">
            <Icon name="back" cls="size-4" />
          </a>
        ) : null}
        <BetaBadge />
      </div>
      <button type="button" className="button shrink-0" title="Start again with an empty canvas" onClick={askReset}>
        Reset
      </button>
    </>
  );

  const rootClass = ["cv-root", dark && "cv-dark", folded && "cv-folded", desktop && "cv-docked"].filter(Boolean).join(" ");
  return (
    <div className={rootClass}>
      {!desktop ? <div className="cv-island cv-top">{header}</div> : null}

      {noticeOpen ? (
        <div className="cv-island cv-notice" role="note">
          <Icon name={ICONS.info} />
          <p>
            The canvas is not optimized for mobile yet. It works best on a larger screen.
            {cv.target ? (
              <>
                {" On a phone, use the "}
                <a href={`/project/${cv.target.project}/environment/${cv.target.environment}/new`}>New resource page</a>.
              </>
            ) : null}
          </p>
          <button type="button" className="cv-x" title="Close" aria-label="Close this notice" onClick={closeNotice}>
            <Icon name={ICONS.x} />
          </button>
        </div>
      ) : null}

      <aside className="cv-island cv-palette">
        <div className="cv-palette-head">
          <div>
            <b>Steps</b>
            <span>Drag one onto the canvas</span>
          </div>
          <button type="button" className="cv-x cv-fold" title={foldTitle} aria-label={foldTitle} aria-expanded={!folded} onClick={toggleFolded}>
            <Icon name={ICONS.fold} />
          </button>
        </div>
        {PALETTE.map(([group, types]) => (
          <Fragment key={group}>
            <h4>{group}</h4>
            {types.map((type) => (
              <PaletteItem key={type} type={type} />
            ))}
          </Fragment>
        ))}
      </aside>

      <section className="cv-island cv-stage">
        <div className="cv-viewport" ref={viewport}>
          <div className="cv-world">
            <Edges />
            {cv.flow.nodes.map((n) => (
              <Node key={n.id} n={n} />
            ))}
            {resultNode && cv.result ? (
              <div className="cv-result" style={{ left: `${resultNode.x + (cv.sizes[resultNode.id]?.w || 296) + 72}px`, top: `${resultNode.y + PORT_Y - 19}px` }} onPointerDown={stop}>
                <span className="cv-port in"></span>
                <i></i>
                {cv.result.urls.length ? (
                  cv.result.urls.slice(0, 3).map((url) => (
                    <a key={url} href={url} target="_blank" rel="noopener noreferrer" title={`Open ${url}`}>
                      {url.replace(/^https?:\/\//, "")}
                      <Icon name={ICONS.out} />
                    </a>
                  ))
                ) : (
                  <a href={cv.result.href} target="_blank" rel="noreferrer">
                    Open in Freeploy
                  </a>
                )}
                <button className="cv-x" title="Hide" onClick={hideResult}>
                  <Icon name={ICONS.x} />
                </button>
              </div>
            ) : null}
          </div>
        </div>
        <RunPanel />
        {cv.menu ? (
          <div className="cv-menu" style={{ left: `${cv.menu.left}px`, top: `${cv.menu.top}px` }}>
            <h5>Add the next step</h5>
            {cv.menu.valid.map((type) => (
              <PaletteItem key={type} type={type} onPick={() => pickNext(type)} />
            ))}
          </div>
        ) : null}
        {cv.toast ? <div className={`cv-toast${cv.toast.bad ? " bad" : ""}`}>{cv.toast.text}</div> : null}
      </section>

      {/* Bottom left of the whole canvas, below the Steps panel. */}
      <CanvasControls zoom={cv.view.z} onZoom={(z) => els.pz?.zoomTo(z)} onFit={fit}>
        {desktop ? header : null}
      </CanvasControls>

      {cv.dropdown ? <Dropdown key={cv.dropdown.key} dropdown={cv.dropdown} /> : null}
    </div>
  );
}
