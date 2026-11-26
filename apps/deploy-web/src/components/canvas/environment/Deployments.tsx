// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/environment/Deployments.svelte (Apache-2.0), modified.
// Dashboard canvas: running, queued, and recent deployments. A row shows its application card;
// the status opens the deployment. Folded or open is remembered in localStorage.
import { useState } from "react";
import { ago, deploymentStatus, TONE_DOT, type CanvasDeployment, type CanvasNode } from "../../../lib/environment-canvas";
import { CanvasIcon } from "./Icon";

export const DEPLOYMENTS_OPEN_KEY = "coolify-canvas-deployments-open";

function readOpen(): boolean {
  try {
    return localStorage.getItem(DEPLOYMENTS_OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}


export function Deployments({ deployments, nodeById, onShow }: { deployments: CanvasDeployment[]; nodeById: (id: string) => CanvasNode | undefined; onShow: (id: string) => void }) {
  const [open, setOpen] = useState(readOpen);
  function toggle() {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(DEPLOYMENTS_OPEN_KEY, String(next));
    } catch {
      // Storage blocked: the panel opens next time.
    }
  }
  return (
    <section className="flex max-h-80 w-72 min-w-0 flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-white/[0.08] dark:bg-panel" data-ec-deployments="">
      <button type="button" className="flex w-full shrink-0 items-center gap-2 px-3 py-2.5 text-left" aria-expanded={open} onClick={toggle}>
        <span className="min-w-0 flex-1 text-[12px] font-semibold text-black dark:text-fg">Recent deployments</span>
        <span className="text-[11px] text-neutral-400 dark:text-fg-faint">{deployments.length}</span>
        <CanvasIcon name="chevron" className={`size-3.5 text-neutral-400 transition-transform dark:text-fg-faint ${open ? "" : "rotate-180"}`.trimEnd()} />
      </button>
      {open ? (
        <ul className="min-h-0 overflow-y-auto border-t border-neutral-100 dark:border-white/[0.06]">
          {deployments.map((deployment) => {
            const [label, tone] = deploymentStatus(deployment.status);
            const node = deployment.application ? nodeById(deployment.application) : undefined;
            return (
              <li key={deployment.id} className="flex items-center gap-2 border-b border-neutral-100 px-3 py-2 last:border-b-0 dark:border-white/[0.06]">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left disabled:cursor-default enabled:hover:[&>p:first-child]:underline"
                  disabled={!node}
                  title={node ? "Show on the canvas" : undefined}
                  onClick={() => node && onShow(node.id)}
                >
                  <p className="truncate text-[12px] font-medium text-black underline-offset-2 dark:text-fg">{deployment.name}</p>
                  <p className="truncate text-[11px] text-neutral-500 dark:text-fg-faint">
                    {deployment.pull_request_id ? `PR #${deployment.pull_request_id} · ` : ""}
                    {deployment.created_at ? ago(deployment.created_at) : deployment.server}
                  </p>
                </button>
                <a
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-neutral-200 bg-neutral-50 px-2 text-[10px] leading-5 font-medium text-neutral-600 hover:border-neutral-300 hover:text-black dark:border-white/[0.1] dark:bg-white/[0.05] dark:text-fg-dim dark:hover:border-white/[0.2] dark:hover:text-fg"
                  href={deployment.link ?? undefined}
                  title="Open the deployment"
                >
                  <span className="relative flex size-1.5">
                    {tone === "busy" ? <span className={`absolute inline-flex size-full rounded-full opacity-75 motion-safe:animate-ping ${TONE_DOT.busy}`}></span> : null}
                    <span className={`relative inline-flex size-full rounded-full ${TONE_DOT[tone]}`}></span>
                  </span>
                  {label}
                </a>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
