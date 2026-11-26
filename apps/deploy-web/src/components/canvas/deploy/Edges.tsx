// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/deploy/Edges.svelte (Apache-2.0), modified.
//
// The lines: connections (click one to remove it), every resource line into
// Deploy, the result pill's line, and the line being dragged.
import { curve, nodeById, planOf, type FlowEdge } from "../../../lib/deploy-canvas";
import { cv, inPoint, outPoint, removeEdge, useDeployCanvas } from "./state";

export function Edges() {
  useDeployCanvas();
  const flow = cv.flow;
  const runState = cv.runState;
  const lines: Array<{ d: string; cls: string | undefined; edge: FlowEdge | null }> = [];
  for (const edge of flow.edges) {
    const a = nodeById(edge.from, flow);
    const b = nodeById(edge.to, flow);
    if (!a || !b) continue;
    const st = runState[edge.to]?.state;
    const cls = st === "running" ? "flow" : runState[edge.from]?.state === "done" && st ? "live" : undefined;
    // Start's connection to the first Server cannot be removed.
    const removable = !(edge.from === "start" && edge.to === "server");
    lines.push({ d: curve(outPoint(a), inPoint(b)), cls, edge: removable ? edge : null });
  }
  const plan = planOf(flow);
  const deploy = plan.deploy;
  const st = deploy ? runState[deploy.id]?.state : undefined;
  if (deploy) {
    for (const { end } of plan.lines) lines.push({ d: curve(outPoint(end), inPoint(deploy)), cls: st === "running" ? "flow" : st === "done" ? "live" : undefined, edge: null });
  }
  const after = cv.result && nodeById(cv.result.after, flow);
  if (after) {
    const a = outPoint(after);
    lines.push({ d: curve(a, { x: a.x + 72, y: a.y }), cls: "live", edge: null });
  }
  const dragged = cv.temp ?? cv.pendingLine;
  return (
    <svg className="cv-edges">
      {lines.map((line, i) => (
        <g key={i}>
          {line.edge ? (
            // Pointer only, like the rest of the canvas.
            <path className="hit" d={line.d} onClick={() => removeEdge(line.edge!)}>
              <title>Click to remove this connection</title>
            </path>
          ) : null}
          <path className={line.cls} d={line.d} />
        </g>
      ))}
      {dragged ? <path className="temp" d={curve(dragged.a, dragged.b)} /> : null}
    </svg>
  );
}
