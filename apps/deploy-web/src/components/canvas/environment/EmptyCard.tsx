// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/environment/EmptyCard.svelte (Apache-2.0), modified.
// Placeholder card of an environment (or project) without resources: opens the deploy canvas (admins) or its page on click.
import type { CanvasNode, Point } from "../../../lib/environment-canvas";
import { CanvasIcon } from "./Icon";

export function EmptyCard({ node, position }: { node: CanvasNode; position: Point | undefined }) {
  return (
    <a
      className="group absolute flex w-[260px] items-center gap-2.5 rounded-xl border border-dashed border-neutral-300 bg-white/60 p-3 hover:border-neutral-400 dark:border-white/[0.12] dark:bg-white/[0.02] dark:hover:border-white/[0.24]"
      style={position ? { left: `${position.x}px`, top: `${position.y}px` } : undefined}
      href={node.link ?? undefined}
      draggable="false"
      data-ec-card=""
      data-id={node.id}
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-neutral-300 text-neutral-400 dark:border-white/[0.12] dark:text-fg-faint">
        <CanvasIcon name="plus" className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] leading-4 font-semibold text-neutral-500 underline-offset-2 group-hover:underline dark:text-fg-dim">{node.name}</div>
        <div className="mt-0.5 truncate text-[11px] leading-4 text-neutral-400 dark:text-fg-faint">{node.subtitle}</div>
      </div>
    </a>
  );
}
