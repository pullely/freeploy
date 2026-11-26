// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/environment/Toolbar.svelte (Apache-2.0), modified.
// The beta badge, "View only" and the page's views (List view, Shared variables, Settings,
// New resource). Desktop: it sits in the zoom controls bar (bottom centre); small screens: a
// rounded box above the canvas. The connect and server views' project / environment filters
// (Select.svelte) are not ported: the environment canvas has none.
import type { ReactNode } from "react";
import { BetaBadge } from "../BetaBadge";

/** The classes the canvas root gives the toolbar where it docks it (EnvironmentCanvas.svelte placeBar()). */
export const DOCKED_BAR = "ml-0.5 flex items-center gap-2 border-l border-neutral-200 pr-0.5 pl-2 dark:border-white/[0.08]";
export const BOXED_BAR = "flex shrink-0 flex-wrap items-center gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2.5 dark:border-white/[0.08] dark:bg-panel";

export function Toolbar({ className, viewOnly, viewOnlyTitle, views }: { className: string; viewOnly: boolean; viewOnlyTitle: string; views: ReactNode }) {
  return (
    <div className={className} data-ec-toolbar="">
      <div className="flex min-w-0 items-center gap-2">
        <BetaBadge />
        <span
          className={`rounded-full border border-neutral-200 bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-500 dark:border-white/[0.12] dark:bg-white/[0.07] dark:text-fg-dim ${viewOnly ? "" : "hidden"}`.trimEnd()}
          title={viewOnlyTitle}
        >
          View only
        </span>
      </div>
      {/* Small screens: the actions wrap onto more rows instead of covering the title. */}
      <div className="ml-auto flex shrink-0 items-center gap-2 max-lg:min-w-0 max-lg:shrink max-lg:flex-wrap">{views}</div>
    </div>
  );
}
