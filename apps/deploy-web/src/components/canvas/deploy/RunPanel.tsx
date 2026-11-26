// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/deploy/RunPanel.svelte (Apache-2.0), modified.
//
// Run panel: an island with the steps as status lights, then the logs
// ("Steps", and a tab per deployed resource).
import { ICONS, shortLabel } from "../../../lib/deploy-canvas";
import { Icon } from "./Icon";
import { changed, cv, showPane, useDeployCanvas } from "./state";

export function RunPanel() {
  useDeployCanvas();
  const r = cv.run;
  return (
    <aside className="cv-run" hidden={!r.open}>
      <header>
        <div>
          <b>{r.title}</b>
          <span>{r.sub}</span>
        </div>
        <button
          className="cv-x"
          title="Close"
          onClick={() => {
            if (!cv.running) {
              r.open = false;
              changed();
            }
          }}
        >
          <Icon name={ICONS.x} />
        </button>
      </header>
      <div className="cv-steps">
        {r.steps.map((step) => (
          <div key={step.id} className={`cv-step ${step.state}`} data-id={step.id}>
            <i></i>
            <div>
              <span>{step.label}</span>
              <small>{step.message}</small>
            </div>
          </div>
        ))}
      </div>
      <div className="cv-seg cv-tabs" role="tablist" hidden={r.panes.length < 2}>
        {r.panes.map((pane) => (
          <button key={pane.key} type="button" role="tab" className={r.active === pane.key ? "on" : undefined} aria-selected={r.active === pane.key} title={`${pane.label}${pane.status ? `: ${pane.status}` : ""}`} onClick={() => showPane(pane.key)}>
            <i className={pane.state || undefined}></i>
            <span>{shortLabel(pane.label)}</span>
          </button>
        ))}
      </div>
      <div className="cv-logs-wrap">
        {r.panes.map((pane) => (
          <pre key={pane.key} className="cv-logs" data-key={pane.key} hidden={r.active !== pane.key}>
            {pane.lines.map((line, i) => (
              <span key={i} className={line.cls || undefined}>{`${line.text}\n`}</span>
            ))}
          </pre>
        ))}
      </div>
      <footer>
        <a className="button" target="_blank" rel="noreferrer" href={r.openHref || undefined} hidden={!r.showOpen}>
          Open
        </a>
      </footer>
    </aside>
  );
}
