// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/deploy/Node.svelte (Apache-2.0), modified.
//
// A step card: header (drag handle), fields, ports, and its run status.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { ICONS, logoOf, nextOf, onlyOption, planOf, prevOf, resourceLabel, sourceAbove, TYPES, type FlowNode } from "../../../lib/deploy-canvas";
import { Field } from "./Field";
import { Icon } from "./Icon";
import { changed, cv, dragNode, removeNode, runFlow, startConnect, track, useDeployCanvas } from "./state";

const stop = (e: PointerEvent) => e.stopPropagation();

export function Node({ n }: { n: FlowNode }) {
  useDeployCanvas();
  const el = useRef<HTMLDivElement>(null);
  const t = TYPES[n.type];
  const st = cv.runState[n.id];
  const plan = planOf(cv.flow);
  // The logo of what the step creates (engine, template, build); a logo that fails to load
  // shows its fallback, then the step's glyph.
  const logo = logoOf(n);
  const [broken, setBroken] = useState<Record<string, true>>({});
  const logoSrc = logo && (broken[logo.src] ? logo.fallback : logo.src);
  const fields = t.fields.filter((f) => !f.show || f.show(n.data));
  // Start, Deploy and the first Server stay.
  const removable = n.type !== "start" && n.type !== "deploy" && n.id !== "server";
  const hasOut = !!nextOf(n.id, cv.flow) || plan.lines.some((l) => l.end.id === n.id);
  const hasIn = !!prevOf(n.id, cv.flow) || (n.type === "deploy" && plan.lines.length > 0);
  // Blank canvas: the Server ring pulses and a dashed trail shows where to drag it.
  const blank = n.id === "server" && cv.flow.nodes.every((x) => ["start", "server", "deploy"].includes(x.type));

  useLayoutEffect(() => track(el.current!, n.id), [n.id]);

  // A select with `only: true` takes its option when it has exactly one.
  useEffect(() => {
    let set = false;
    for (const f of fields) {
      if (f.kind !== "select" || !f.only) continue;
      const only = onlyOption(f.load ? f.load(n.data) : f.options, n.data[f.key]);
      if (only && only !== n.data[f.key]) {
        n.data[f.key] = only;
        set = true;
      }
    }
    if (set) changed();
  });

  const classes = [
    "cv-node",
    n.type === "start" && "start",
    st?.state === "running" && "running",
    st?.state === "done" && "done",
    st?.state === "failed" && "failed",
    cv.invalid[n.id] && "invalid",
    cv.dropTarget === n.id && "drop-ok",
    hasOut && "has-out",
    hasIn && "has-in",
    blank && "blank",
  ].filter(Boolean);
  const showLogo = !!logoSrc && !broken[logoSrc];
  return (
    <div className={classes.join(" ")} data-id={n.id} style={{ left: `${n.x}px`, top: `${n.y}px` }} ref={el}>
      <div className="cv-node-head" onPointerDown={(e) => dragNode(n, e)}>
        <i className={[showLogo && "cv-logo", logo?.padded && "padded"].filter(Boolean).join(" ") || undefined}>
          {showLogo ? (
            <>
              <img className={logo!.dark ? "cv-light" : undefined} alt="" src={logoSrc!} onError={() => setBroken((b) => ({ ...b, [logoSrc!]: true }))} />
              {logo!.dark ? <img className="cv-dark-only" alt="" src={logo!.dark} /> : null}
            </>
          ) : (
            <Icon name={t.icon} />
          )}
        </i>
        <div>
          <b>{t.title}</b>
          <small>{t.sub}</small>
        </div>
        {removable ? (
          <button className="cv-x" title="Remove step" onPointerDown={stop} onClick={() => removeNode(n.id)}>
            <Icon name={ICONS.x} />
          </button>
        ) : null}
      </div>
      <div className="cv-node-body">
        {fields.map((f) => (
          <Field key={`${f.key}:${f.kind}`} n={n} f={f} />
        ))}
        {n.type === "deploy" ? (
          <>
            {!plan.lines.length ? <p className="cv-note">Every resource you connect to a Server shows here.</p> : null}
            {plan.lines.map(({ source }) => (
              <div className="cv-field" key={source.id}>
                <label>{resourceLabel(source)}</label>
              </div>
            ))}
            {/* Save only creates the resources in Freeploy; Deploy also starts them. */}
            <div className="cv-actions">
              <button type="button" className="button cv-deploy-now" disabled={!!cv.running} title="Create the resources in Freeploy without starting them" onPointerDown={stop} onClick={() => void runFlow("save")}>
                <span>{cv.running === "save" ? "Working…" : "Save only"}</span>
              </button>
              <button type="button" className="button button-highlighted cv-deploy-now" disabled={!!cv.running} title="Create the resources and deploy them" onPointerDown={stop} onClick={() => void runFlow("deploy")}>
                <Icon name={ICONS.deploy} />
                <span>{cv.running === "deploy" ? "Working…" : "Deploy"}</span>
              </button>
            </div>
          </>
        ) : null}
        {t.stage === "config" && !sourceAbove(n.id, cv.flow) ? <p className="cv-note">Connect it after a source step.</p> : null}
      </div>
      {n.type !== "start" ? <span className="cv-port in"></span> : null}
      {st?.message ? <div className={`cv-status ${st.state}`}>{st.message}</div> : null}
      {n.type !== "deploy" ? <span className={`cv-port out${cv.armed === n.id ? " armed" : ""}`} title="Drag to connect the next step" onPointerDown={(e) => startConnect(n, e)}></span> : null}
      {blank ? (
        <div className="cv-hint">
          <span>Drag and drop to add a step</span>
        </div>
      ) : null}
    </div>
  );
}
