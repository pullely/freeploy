// Derived from coollabsio/coolify@91b7e3e:resources/views/components/shared-variables/{layout,
// sidebar,view-controls}.blade.php and resources/views/components/section-heading.blade.php
// (Apache-2.0), modified.
//
// What every Shared Variables page shares: the paths (routes/web.php's
// shared-variables.*), the API's shapes, <x-shared-variables.layout> (the
// mobile title and the pages fed to the page search; the menu itself is the
// Shared Variables submenu of the main sidebar), the index pages' search and
// list / grid switch, and <x-section-heading>.
import { useState, type ReactNode } from "react";
import { Reicon } from "../components/Reicon";

export type SharedVariableScope = "team" | "project" | "environment" | "server";

export const sharedVariablesApi = (orgId: string | undefined) => `/v1/organizations/${orgId ?? ""}/deploy/shared-variables`;
export const projectVariablesPath = (projectUuid: string) => `/shared-variables/project/${projectUuid}`;
export const environmentVariablesPath = (projectUuid: string, environmentUuid: string) => `/shared-variables/environments/project/${projectUuid}/environment/${environmentUuid}`;
export const serverVariablesPath = (serverUuid: string) => `/shared-variables/server/${serverUuid}`;

/** A scope's page, or its canvas (which is not ported: the link leads to the not-ported notice). */
export function scopePath(scope: SharedVariableScope, ownerUuid: string | null, projectUuid: string | null): string | null {
  if (scope === "team") return "/shared-variables/team";
  if (!ownerUuid) return null;
  if (scope === "project") return projectVariablesPath(ownerUuid);
  if (scope === "server") return serverVariablesPath(ownerUuid);
  return projectUuid ? environmentVariablesPath(projectUuid, ownerUuid) : null;
}

/** str($type)->headline(). */
export const scopeHeadline = (scope: SharedVariableScope): string => scope.charAt(0).toUpperCase() + scope.slice(1);

/** Str::plural($word, $count) for the regular nouns these pages count. */
export const plural = (word: string, count: number): string => (count === 1 ? word : `${word}s`);

/** The Shared Variables pages, as settingsSearchItems() feeds them to the page search. */
function searchItems(): string {
  const origin = window.location.origin;
  const pages: Array<[string, string]> = [
    ["Overview", "/shared-variables"],
    ["Team", "/shared-variables/team"],
    ["Projects", "/shared-variables/projects"],
    ["Environments", "/shared-variables/environments"],
    ["Servers", "/shared-variables/servers"],
  ];
  return JSON.stringify(pages.map(([label, path]) => ({ label, breadcrumb: "Shared variables", search_text: `${label} Shared variables`, href: origin + path, navigate: true })));
}

/** <x-shared-variables.layout>. */
export function SharedVariablesLayout({ children }: { children: ReactNode }) {
  return (
    <section className="application-settings-workspace w-full max-w-none">
      <header className="mb-6 xl:hidden">
        <h1 className="text-[24px]! leading-7! font-semibold! tracking-tight!">Shared variables</h1>
        <p className="mt-1 text-[13px] text-neutral-500 dark:text-fg-dim">Reusable environment variables across resources</p>
      </header>

      <div hidden data-settings-search-items={searchItems()} />
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export type IndexViewMode = "list" | "grid";

export interface IndexView {
  search: string;
  setSearch: (value: string) => void;
  viewMode: IndexViewMode;
  setViewMode: (mode: IndexViewMode) => void;
  /** matches(values): the search is empty, or one of the values contains it. */
  matches: (values: Array<string | null | undefined>) => boolean;
}

/**
 * The index pages' x-data: `search`, and `viewMode` remembered in this
 * browser under Coolify's storage key ('shared-variables-projects-view', …),
 * a grid at first.
 */
export function useIndexView(storageKey: string): IndexView {
  const [search, setSearch] = useState("");
  const [viewMode, setMode] = useState<IndexViewMode>(() => {
    try {
      return localStorage.getItem(storageKey) === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  const query = search.trim().toLowerCase();
  return {
    search,
    setSearch,
    viewMode,
    setViewMode: (mode) => {
      setMode(mode);
      try {
        localStorage.setItem(storageKey, mode);
      } catch {
        /* storage blocked: the choice lasts this page only */
      }
    },
    matches: (values) => !query || values.some((value) => String(value || "").toLowerCase().includes(query)),
  };
}

export const SEARCH_INPUT =
  "h-8! w-full rounded-lg! border-neutral-200! bg-white! py-0! pr-8! pl-8! text-[12px]! shadow-none! placeholder:text-neutral-400 focus:border-accent! focus:ring-0! dark:border-white/[0.08]! dark:bg-white/[0.035]! dark:text-fg! dark:placeholder:text-fg-faint";
const SEARCH_CLEAR =
  "absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-black dark:text-fg-faint dark:hover:bg-white/[0.07] dark:hover:text-fg";

/** The search field of these pages with its clear button. */
export function SearchField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <div className="relative w-full sm:max-w-sm">
      <Reicon name="search" className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
      <input type="search" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} className={SEARCH_INPUT} />
      <button type="button" onClick={() => onChange("")} className={SEARCH_CLEAR} aria-label="Clear search" {...(value ? {} : { style: { display: "none" as const } })}>
        <Reicon name="x" className="size-3" />
      </button>
    </div>
  );
}

const VIEW_MODES: Array<[IndexViewMode, string, string]> = [
  ["list", "List view", "unordered-list"],
  ["grid", "Grid view", "grid"],
];

/** <x-shared-variables.view-controls>: the search, and an icon button to the view that is not current. */
export function ViewControls({ label, view }: { label: string; view: IndexView }) {
  return (
    <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <SearchField value={view.search} onChange={view.setSearch} placeholder={`Search ${label.toLowerCase()}`} />

      <div className="view-toggle w-fit">
        {VIEW_MODES.map(([mode, viewLabel, icon]) => (
          <button
            key={mode}
            type="button"
            onClick={() => view.setViewMode(mode)}
            title={viewLabel}
            aria-label={viewLabel}
            className="relative flex h-7.5 w-7.5 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-black dark:hover:text-white"
            {...(view.viewMode !== mode ? {} : { style: { display: "none" as const } })}
          >
            <Reicon name={icon} className="size-3.5" />
          </button>
        ))}
      </div>
    </div>
  );
}

/** <x-section-heading> with a title and an optional subtitle. */
export function SectionHeading({ title, subtitle }: { title: string; subtitle?: string | null }) {
  return (
    <div className="mb-3 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <h2 className="min-w-0 truncate text-[14px]! leading-5! font-semibold! text-black dark:text-fg">{title}</h2>
          </div>
        </div>
      </div>
      {subtitle?.trim() ? <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-fg-faint">{subtitle}</p> : null}
    </div>
  );
}

/** The card of the index pages' grids and of the overview, with its minimum height ("min-h-28"). */
export const card = (minHeight: string): string =>
  `group flex ${minHeight} flex-col rounded-xl border border-neutral-200 bg-white p-3 shadow-sm transition-all hover:-translate-y-px hover:border-neutral-300 hover:no-underline hover:shadow-md dark:border-white/[0.08] dark:bg-white/[0.05] dark:hover:border-white/[0.14]`;
export const GLYPH = "flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-fg-dim";
export const LIST = "overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.05]";
export const LIST_ROW = "flex min-h-14 items-center gap-3 border-b border-neutral-200 px-4 py-2.5 last:border-b-0 hover:bg-neutral-50 hover:no-underline dark:border-white/[0.07] dark:hover:bg-white/[0.025]";
