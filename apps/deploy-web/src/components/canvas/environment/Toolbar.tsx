// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/environment/Toolbar.svelte (Apache-2.0), modified.
// Filters and view toggles: the beta badge, "View only", the page's views (its list view link and
// actions) and, on the connect and server views, the project / environment filters. Desktop: it sits
// in the zoom controls bar (bottom centre); small screens: a rounded box above the canvas.
import type { ReactNode } from "react";
import type { CanvasFilter } from "../../../lib/environment-canvas";
import { BetaBadge } from "../BetaBadge";
import { Select, type SelectOption } from "./Select";

/** The classes the canvas root gives the toolbar where it docks it (EnvironmentCanvas.svelte placeBar()). */
export const DOCKED_BAR = "ml-0.5 flex items-center gap-2 border-l border-neutral-200 pr-0.5 pl-2 dark:border-white/[0.08]";
export const BOXED_BAR = "flex shrink-0 flex-wrap items-center gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2.5 dark:border-white/[0.08] dark:bg-panel";

const SELECT = "w-44 max-lg:w-auto max-lg:min-w-0 max-lg:flex-1 max-lg:basis-32";
type Choice = { uuid: string; name: string };
const options = (all: string, list: readonly Choice[]): SelectOption[] => [{ value: "", label: all }, ...list.map((o) => ({ value: o.uuid, label: o.name }))];
const valueOf = (list: readonly Choice[], wanted: string | undefined) => (list.some((o) => o.uuid === wanted) ? wanted! : "");

export function Toolbar({
  className,
  viewOnly,
  viewOnlyTitle,
  views,
  filter = {},
  projects = [],
  environments = [],
  onFilter,
}: {
  className: string;
  viewOnly: boolean;
  viewOnlyTitle: string;
  views: ReactNode;
  filter?: CanvasFilter;
  projects?: readonly Choice[];
  environments?: readonly Choice[];
  onFilter?: (filter: CanvasFilter) => void;
}) {
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
      <div className="ml-auto flex shrink-0 items-center gap-2 max-lg:min-w-0 max-lg:shrink max-lg:flex-wrap">
        {views}
        {/* Connect and server views: show the resources of one project and / or environment only. */}
        {projects.length > 1 ? (
          <Select className={SELECT} label="Filter by project" value={valueOf(projects, filter.project)} options={options("All projects", projects)} onChange={(project) => onFilter?.({ project, environment: "" })} />
        ) : null}
        {environments.length > 1 ? (
          <Select className={SELECT} label="Filter by environment" value={valueOf(environments, filter.environment)} options={options("All environments", environments)} onChange={(environment) => onFilter?.({ ...filter, environment })} />
        ) : null}
      </div>
    </div>
  );
}
