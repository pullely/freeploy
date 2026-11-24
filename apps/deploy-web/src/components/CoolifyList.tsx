// Derived from coollabsio/coolify@91b7e3e:resources/views/components/{client-pagination,
// page-size-select,canvas-view-toggle}.blade.php, resources/views/components/table/{dropdown,
// sort-header}.blade.php and the list pages' Alpine state in
// resources/views/livewire/project/{index,show}.blade.php (Apache-2.0), modified.
//
// What Coolify's list pages share: search, sort, the table / grid switch and
// client-side paging. The Blade components as React components (the same DOM,
// classes and copy) and the pages' Alpine data (projectsIndex(),
// projectEnvironments()) as one hook.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Reicon } from "./Reicon";
import { toast } from "../lib/toast";

const HIDDEN = { display: "none" as const };
const shown = (open: boolean) => (open ? undefined : HIDDEN);

export type ViewMode = "table" | "grid";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the choice lasts this page only */
  }
}

/**
 * RemembersCanvasView::listView($page, $default): ?view=table|grid, else the
 * remembered view, else the default. Coolify remembers it in a cookie per
 * user; here it is this browser's storage.
 */
function initialViewMode(page: string, fallback: ViewMode): ViewMode {
  for (const view of [new URLSearchParams(window.location.search).get("view"), stored(`freeploy.view.${page}`)]) {
    if (view === "table" || view === "grid") return view;
  }
  return fallback;
}

export interface ListState<T> {
  search: string;
  setSearch: (value: string) => void;
  sortBy: string;
  setSortBy: (value: string) => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  page: number;
  setPage: (page: number) => void;
  pageSize: number;
  setPageSize: (size: number) => void;
  /** Where <x-page-size-select> remembers the page size (its storage-key). */
  pageSizeKey: string;
  filtered: T[];
  paginated: T[];
  totalPages: number;
  rangeStart: number;
  rangeEnd: number;
}

/**
 * The list pages' x-data: `search` over name and description, `sortBy` as
 * "<column>-<asc|desc>" (ties by name), and paging. Without a sort value for
 * the column the items keep the server's order, unless `fallbackColumn` names one.
 */
export function useListState<T extends { name: string; description: string | null }>(opts: {
  items: T[];
  /** RemembersCanvasView's page name: "projects", "project". */
  page: string;
  /** <x-client-pagination storage-key="…">: the saved page size (1 to 100) is the first one shown. */
  pageSizeKey: string;
  defaultSort: string;
  sortValues: Record<string, (item: T) => string | number>;
  fallbackColumn?: string;
  /** listView($page, $default)'s default: "grid" unless the page says otherwise. */
  defaultView?: ViewMode;
}): ListState<T> {
  const { items, sortValues, fallbackColumn } = opts;
  const [search, setSearchValue] = useState("");
  const [sortBy, setSortByValue] = useState(opts.defaultSort);
  const [viewMode, setViewModeValue] = useState<ViewMode>(() => initialViewMode(opts.page, opts.defaultView ?? "grid"));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeValue] = useState(() => {
    const saved = Number(stored(opts.pageSizeKey));
    return saved >= 1 && saved <= 100 ? saved : 12;
  });

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matching = items.filter((item) => !query || [item.name, item.description].filter(Boolean).join(" ").toLowerCase().includes(query));
    const [column = "", direction] = sortBy.split("-");
    const sortValue = sortValues[column] ?? (fallbackColumn ? sortValues[fallbackColumn] : undefined);
    if (!sortValue) return matching;
    const order = direction === "desc" ? -1 : 1;
    const compare = (first: string | number, second: string | number) => (typeof first === "number" ? first - Number(second) : first.localeCompare(String(second)));
    return matching.sort((first, second) => order * compare(sortValue(first), sortValue(second)) || first.name.localeCompare(second.name));
  }, [items, search, sortBy, sortValues, fallbackColumn]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  // paginatedProjects: a page past the end falls back to the last one.
  const current = Math.min(page, totalPages);
  const start = (current - 1) * pageSize;
  return {
    search,
    setSearch: (value) => {
      setSearchValue(value);
      setPage(1);
    },
    sortBy,
    setSortBy: (value) => {
      setSortByValue(value);
      setPage(1);
    },
    viewMode,
    setViewMode: (mode) => {
      setViewModeValue(mode);
      setPage(1);
      store(`freeploy.view.${opts.page}`, mode);
    },
    page: current,
    setPage,
    pageSize,
    setPageSize: (size) => {
      setPageSizeValue(size);
      setPage(1);
      store(opts.pageSizeKey, String(size));
    },
    pageSizeKey: opts.pageSizeKey,
    filtered,
    paginated: filtered.slice(start, start + pageSize),
    totalPages,
    rangeStart: filtered.length === 0 ? 0 : start + 1,
    rangeEnd: Math.min(current * pageSize, filtered.length),
  };
}

/** <x-table.dropdown>: a trigger and a fixed panel placed under (or above) it, right-aligned. */
export function TableDropdown(props: { panelClass?: string; trigger: (open: boolean) => ReactNode; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({ position: "fixed", minWidth: 0, visibility: "hidden" });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  // updatePosition(): right edges aligned, kept inside the viewport; above the trigger when there is no room below.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (!trigger.current || !panel.current) return;
      const t = trigger.current.getBoundingClientRect();
      const p = panel.current.getBoundingClientRect();
      const viewportPadding = 8;
      const left = Math.max(viewportPadding, Math.min(t.right - p.width, window.innerWidth - p.width - viewportPadding));
      const spaceBelow = window.innerHeight - t.bottom - viewportPadding;
      const top = spaceBelow >= p.height ? t.bottom + 4 : Math.max(viewportPadding, t.top - p.height - 4);
      setPanelStyle({ position: "fixed", left, top, minWidth: 0 });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle() {
    if (!open) setPanelStyle({ position: "fixed", minWidth: 0, visibility: "hidden" });
    setOpen(!open);
  }

  return (
    <div className="relative" ref={root}>
      <div ref={trigger} onClick={toggle}>
        {props.trigger(open)}
      </div>
      <div ref={panel} style={open ? panelStyle : HIDDEN} className={`listbox-panel origin-top fixed! right-auto! bottom-auto! z-[90]! mt-0! ${props.panelClass ?? ""}`.trimEnd()} role="listbox">
        {props.children(() => setOpen(false))}
      </div>
    </div>
  );
}

export interface SortOption {
  value: string;
  label: string;
}

/** The list toolbar's "Sort" button with its options (shown in the grid view; in the table view only on a narrow screen). */
export function SortDropdown({ list, options, panelClass, hiddenFrom = "min-[641px]:hidden" }: { list: ListState<unknown>; options: SortOption[]; panelClass: string; hiddenFrom?: string }) {
  return (
    <div className={list.viewMode === "grid" ? "" : hiddenFrom}>
      <TableDropdown
        panelClass={panelClass}
        trigger={(open) => (
          <button type="button" className="button" aria-haspopup="listbox" aria-expanded={open}>
            <svg className="size-3.5 opacity-65" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M8 5v14m0 0-3-3m3 3 3-3M16 19V5m0 0-3 3m3-3 3 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Sort
          </button>
        )}
      >
        {(close) =>
          options.map((option) => (
            <button
              key={option.value}
              type="button"
              className="listbox-option"
              onClick={() => {
                list.setSortBy(option.value);
                close();
              }}
            >
              <span className="flex-1">{option.label}</span>
              <svg className="size-3.5 text-black dark:text-fg" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={shown(list.sortBy === option.value)}>
                <path d="m2.5 6.25 2.1 2.1 4.9-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ))
        }
      </TableDropdown>
    </div>
  );
}

/** <x-table.sort-header>: the first click sorts by `first`, the next flips the direction; an arrow shows it. */
export function SortHeader(props: { list: ListState<unknown>; label: string; asc: string; desc: string; first?: "asc" | "desc"; className?: string }) {
  const { list, asc, desc } = props;
  const firstValue = props.first === "desc" ? desc : asc;
  const otherValue = props.first === "desc" ? asc : desc;
  const sorted = list.sortBy === asc || list.sortBy === desc;
  const ariaBase = `Sort by ${props.label.toLowerCase()}`;
  return (
    <button
      type="button"
      onClick={() => list.setSortBy(list.sortBy === firstValue ? otherValue : firstValue)}
      aria-label={ariaBase + (list.sortBy === asc ? ", sorted ascending" : list.sortBy === desc ? ", sorted descending" : "")}
      className={["table-sort-header group", props.className ?? "", sorted ? "is-sorted" : ""].filter(Boolean).join(" ")}
    >
      <span className="truncate">{props.label}</span>
      <svg
        className={["table-sort-header-icon", sorted ? "is-visible" : "", list.sortBy === desc ? "rotate-180" : ""].filter(Boolean).join(" ")}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 15l6-6 6 6" />
      </svg>
    </button>
  );
}

/** <x-page-size-select>: the rows per page, one of the options or a custom number up to 100 (the list remembers it). */
function PageSizeSelect({ value, onChange, options }: { value: number; onChange: (size: number) => void; options: number[] }) {
  const [customizing, setCustomizing] = useState(false);
  const [custom, setCustom] = useState("");
  const input = useRef<HTMLInputElement>(null);

  function apply(raw: string | number) {
    if (raw === "" || raw === null) return setCustomizing(false);
    if (Number(raw) > 100) toast("Maximum is 100 rows per page.", { type: "warning" });
    const size = Math.min(100, Math.max(1, Number(raw) || 1));
    setCustomizing(false);
    onChange(size);
  }
  useEffect(() => {
    if (customizing) input.current?.focus();
  }, [customizing]);

  return (
    <div className="mb-0! flex h-7 items-center gap-1.5 text-[11px] text-neutral-500 dark:text-fg-dim">
      <div style={shown(!customizing)}>
        <TableDropdown
          panelClass="min-w-24!"
          trigger={(open) => (
            <button
              type="button"
              aria-label="Items per page"
              aria-haspopup="listbox"
              aria-expanded={open}
              className="flex h-7! items-center gap-1 whitespace-nowrap rounded-md border border-neutral-200 pr-1.5 pl-2 text-[11px]! leading-none! tabular-nums text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-black disabled:pointer-events-none disabled:opacity-35 dark:border-white/[0.08] dark:text-fg-dim dark:hover:bg-white/[0.06] dark:hover:text-fg"
            >
              <span>{value}</span>
              <span className="text-neutral-400 dark:text-fg-faint">/ page</span>
              <Reicon name="chevron-down" className="size-3.5 shrink-0 text-neutral-400 dark:text-fg-faint" />
            </button>
          )}
        >
          {(close) => (
            <>
              {options.map((option) => (
                <button
                  key={option}
                  type="button"
                  className="listbox-option"
                  role="option"
                  aria-selected={value === option}
                  onClick={() => {
                    close();
                    apply(option);
                  }}
                >
                  <span>{option}</span>
                  <Reicon name="check" className="size-3.5" {...(value === option ? {} : { style: HIDDEN })} />
                </button>
              ))}
              <button
                type="button"
                className="listbox-option"
                role="option"
                aria-selected={false}
                onClick={() => {
                  close();
                  setCustom("");
                  setCustomizing(true);
                }}
              >
                Custom…
              </button>
            </>
          )}
        </TableDropdown>
      </div>
      <input
        ref={input}
        style={shown(customizing)}
        value={custom}
        onChange={(e) => setCustom(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            apply(custom);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setCustomizing(false);
          }
        }}
        onBlur={() => {
          if (customizing) apply(custom);
        }}
        type="number"
        min={1}
        max={100}
        placeholder="1–100"
        inputMode="numeric"
        aria-label="Custom items per page"
        className="mb-0! h-7! w-14! rounded-md! border-neutral-200! bg-transparent! px-1.5! py-0! text-[11px]! tabular-nums shadow-none! focus:border-neutral-300! focus:ring-0! dark:border-white/[0.08]! dark:text-fg-dim!"
      />
    </div>
  );
}

const PAGER_BUTTON =
  "flex size-7 items-center justify-center rounded-md border border-neutral-200 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-black disabled:pointer-events-none disabled:opacity-35 dark:border-white/[0.08] dark:text-fg-dim dark:hover:bg-white/[0.06] dark:hover:text-fg";

/** <x-client-pagination>: "1-12 of 30", the page size and the previous / next buttons; hidden while everything fits the smallest page. */
export function ClientPagination({ list, options = [12, 24, 48, 96], className = "" }: { list: ListState<unknown>; options?: number[]; className?: string }) {
  const total = list.filtered.length;
  return (
    <footer
      hidden={total <= Math.min(...options)}
      style={shown(total > 0)}
      className={`pager flex min-h-11 items-center justify-between border-t border-neutral-200 px-4 text-[11px] text-neutral-500 dark:border-white/[0.08] dark:text-fg-faint ${className}`.trimEnd()}
    >
      <div className="flex items-center gap-3">
        <span className="inline-flex h-7 items-center whitespace-nowrap tabular-nums">{`${list.rangeStart}-${list.rangeEnd} of ${total}`}</span>
        <PageSizeSelect value={list.pageSize} onChange={list.setPageSize} options={options} />
      </div>
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => list.setPage(Math.max(1, list.page - 1))} disabled={list.page === 1} className={PAGER_BUTTON} aria-label="Previous page">
          <Reicon name="arrow-right" className="size-3.5 rotate-180" />
        </button>
        <button type="button" onClick={() => list.setPage(Math.min(list.totalPages, list.page + 1))} disabled={list.page >= list.totalPages} className={PAGER_BUTTON} aria-label="Next page">
          <Reicon name="arrow-right" className="size-3.5" />
        </button>
      </div>
    </footer>
  );
}

const VIEW_ITEM = "relative flex h-7.5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[12px] font-medium transition-colors";
const VIEW_IDLE = "text-neutral-400 hover:bg-neutral-100 hover:text-black dark:hover:text-white";
const VIEWS: Array<[ViewMode, string, string]> = [
  ["table", "Table view", "unordered-list"],
  ["grid", "Grid view", "grid"],
];

/**
 * <x-canvas-view-toggle> on a list page: an icon button to the view that is
 * not current, and the link to the canvas. Without `list` (a page with one
 * list view) only the canvas link shows.
 */
export function CanvasViewToggle({ list, canvasUrl }: { list?: ListState<unknown>; canvasUrl: string }) {
  return (
    <div className="view-toggle">
      {list ? (
        <span className="flex w-7.5 shrink-0">
          {VIEWS.map(([mode, label, icon]) => (
            <button key={mode} type="button" onClick={() => list.setViewMode(mode)} style={shown(list.viewMode !== mode)} className={`${VIEW_ITEM} ${VIEW_IDLE} w-7.5 justify-center px-0!`} title={label} aria-label={label}>
              <Reicon name={icon} className="size-3.5" />
            </button>
          ))}
        </span>
      ) : null}
      <a href={canvasUrl} className={`${VIEW_ITEM} ${VIEW_IDLE}`} title="Canvas view (beta): see everything and how it connects">
        <Reicon name="deploy-canvas" className="size-3.5" />
        Canvas
        <span className="ml-0.5 inline-flex items-center rounded-full bg-coollabs px-1.5 py-px text-[10px] leading-4 font-semibold text-white">Try it</span>
      </a>
    </div>
  );
}

/** The list toolbar's search field with its clear button. */
export function ListSearch({ list, placeholder }: { list: ListState<unknown>; placeholder: string }) {
  return (
    <div className="relative w-full sm:max-w-sm">
      <Reicon name="search" className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
      <input
        type="search"
        placeholder={placeholder}
        value={list.search}
        onChange={(e) => list.setSearch(e.target.value)}
        className="h-8! w-full rounded-lg! border-neutral-200! bg-white! py-0! pr-8! pl-8! text-[12px]! shadow-none! placeholder:text-neutral-400 focus:border-accent! focus:ring-0! dark:border-white/[0.08]! dark:bg-white/[0.035]! dark:text-fg! dark:placeholder:text-fg-faint"
      />
      <button
        type="button"
        style={shown(list.search !== "")}
        onClick={() => list.setSearch("")}
        className="absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-black dark:text-fg-faint dark:hover:bg-white/[0.07] dark:hover:text-fg"
        aria-label="Clear search"
      >
        <span className="text-sm leading-none">×</span>
      </button>
    </div>
  );
}

/** "No matching …": what a search that matches nothing shows. */
export function NoMatches({ list, title }: { list: ListState<unknown>; title: string }) {
  return (
    <div
      style={shown(list.filtered.length === 0)}
      className="flex min-h-52 flex-col items-center justify-center rounded-xl border border-neutral-200 bg-white px-6 text-center dark:border-white/[0.08] dark:bg-white/[0.05]"
    >
      <Reicon name="search" className="mb-3 size-6 text-neutral-300 dark:text-fg-faint" />
      <p className="text-[13px] font-medium">{title}</p>
      <p className="mt-1 text-[12px] text-neutral-500 dark:text-fg-dim">Try a different search.</p>
    </div>
  );
}
