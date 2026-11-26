// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/resources.blade.php and
// app/Livewire/Server/Resources.php (Apache-2.0), modified.
//
// /server/{uuid}/resources: the applications, databases and services defined on the server (Server::definedResources())
// with search, the column sorts and pages of 10, as Coolify's component does them. The Unmanaged tab lists the Docker
// containers on the server: none for a server that is not validated (Server::loadUnmanagedContainers()); reading them
// from a validated one needs the SSH executor, which the error toast says, so their start, stop and restart are not
// ported. The canvas view (server.canvas) and the image scan markers are not ported.
import { useCallback, useMemo, useState } from "react";
import { Layout } from "../layout/Layout";
import { Reicon } from "../components/Reicon";
import { Button, Empty, SettingsSection, StatusBadge } from "../components/Coolify";
import { PAGER_BUTTON, PageSizeSelect } from "../components/CoolifyList";
import { notify } from "../lib/toast";
import { limit, ServerWorkspace, useServerPage, type ServerPageData } from "./ServerChrome";
import { headline, resourceStatusType, shownResources, type ResourceColumn, type ServerResourceRow } from "../lib/server-pages";

interface ResourcesData extends ServerPageData {
  resources: ServerResourceRow[];
}

type Column = ResourceColumn;

/** <x-table.sort-header> over setSort(): the first click sorts ascending, the next flips the direction. */
function SortHeader({ label, column, sort, onSort }: { label: string; column: Column; sort: string; onSort: (sort: string) => void }) {
  const asc = `${column}_asc`;
  const desc = `${column}_desc`;
  const sorted = sort === asc || sort === desc;
  return (
    <button
      type="button"
      onClick={() => onSort(sort === asc ? desc : asc)}
      aria-label={`Sort by ${label.toLowerCase()}${sort === asc ? ", sorted ascending" : sort === desc ? ", sorted descending" : ""}`}
      className={["table-sort-header group", sorted ? "is-sorted" : ""].filter(Boolean).join(" ")}
    >
      <span className="truncate">{label}</span>
      <svg className={["table-sort-header-icon", sorted ? "is-visible" : "", sort === desc ? "rotate-180" : ""].filter(Boolean).join(" ")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 15l6-6 6 6" />
      </svg>
    </button>
  );
}

function ServerResourcesContent() {
  const title = useCallback((name: string) => `${limit(name, 10)} > Server Resources | Freeploy`, []);
  const { me, data, reload, act } = useServerPage<ResourcesData>("resources", title);
  const [tab, setTab] = useState<"managed" | "unmanaged">("managed");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("name_asc");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(10);
  const shown = useMemo(() => shownResources(tab === "managed" ? (data?.resources ?? []) : [], sort, search, page, perPage), [data, tab, sort, search, page, perPage]);
  if (!data) return null;
  const { server, canUpdate } = data;

  /** loadManagedContainers / loadUnmanagedContainers: a new tab starts with no search, by name, on page 1. */
  async function switchTab(next: "managed" | "unmanaged") {
    if (next !== tab) {
      setSearch("");
      setSort("name_asc");
      setPage(1);
    }
    setTab(next);
    if (next === "unmanaged") await act("resources/unmanaged");
  }
  /** refreshStatus(): the tab loaded again, then Coolify's success toast (also after a failed load, as handleError() does not stop it). */
  async function refresh() {
    if (tab === "managed") await reload();
    else await act("resources/unmanaged");
    notify.success("Resource statuses refreshed.");
  }
  const tabClass = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors disabled:cursor-wait ${active ? "bg-white text-neutral-950 shadow-sm dark:bg-brand/15 dark:text-brand-light" : "text-neutral-500 hover:text-neutral-900 dark:text-fg-dim dark:hover:text-fg"}`;

  return (
    <ServerWorkspace server={server} orgId={me.team?.id} active="resources" canUpdate={canUpdate}>
      <div className="application-settings-form min-w-0 w-full">
        <SettingsSection
          id="server-resources-section"
          title="Resources"
          helper="Review Freeploy-managed resources and other Docker containers running on this server."
          flush
          actions={
            <>
              <div className="inline-flex w-fit rounded-[10px] bg-neutral-100 p-1 dark:bg-white/[0.05]">
                <button type="button" className={tabClass(tab === "managed")} onClick={() => void switchTab("managed")}>
                  Managed
                </button>
                <button type="button" className={tabClass(tab === "unmanaged")} onClick={() => void switchTab("unmanaged")}>
                  Unmanaged
                </button>
              </div>
              <Button onClick={() => void refresh()}>
                <Reicon name="refresh" className="size-3.5" />
                Refresh
              </Button>
            </>
          }
        >
          <div className="border-b border-neutral-200 p-3 dark:border-white/[0.08]">
            <div className="relative w-full max-w-sm">
              <Reicon name="search" className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
              <input
                type="search"
                placeholder="Search resources by name"
                aria-label="Search resources by name"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                className="h-8! w-full rounded-lg! border-neutral-200! bg-white! py-0! pr-8! pl-8! text-[12px]! shadow-none! placeholder:text-neutral-400 focus:border-accent! focus:ring-0! dark:border-white/[0.08]! dark:bg-white/[0.035]! dark:text-fg! dark:placeholder:text-fg-faint"
              />
              <button
                type="button"
                onClick={() => setSearch("")}
                className={`absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-black dark:text-fg-faint dark:hover:bg-white/[0.07] dark:hover:text-fg${search.trim() === "" ? " hidden" : ""}`}
                aria-label="Clear search"
              >
                <Reicon name="x" className="size-3" />
              </button>
            </div>
          </div>
          <div className="relative">
            {tab === "managed" ? (
              shown.total > 0 ? (
                <div className="data-table transition-opacity">
                  <div className="data-table-header server-resources-managed-table-grid">
                    <SortHeader label="Name" column="name" sort={sort} onSort={(s) => (setSort(s), setPage(1))} />
                    <SortHeader label="Project" column="project" sort={sort} onSort={(s) => (setSort(s), setPage(1))} />
                    <SortHeader label="Environment" column="environment" sort={sort} onSort={(s) => (setSort(s), setPage(1))} />
                    <SortHeader label="Type" column="type" sort={sort} onSort={(s) => (setSort(s), setPage(1))} />
                    <SortHeader label="Status" column="status" sort={sort} onSort={(s) => (setSort(s), setPage(1))} />
                  </div>
                  {shown.rows.map((r) => (
                    <div key={`${r.type}-${r.uuid}`} className="data-table-row server-resources-managed-table-grid border-b border-neutral-200 last:border-b-0 dark:border-white/[0.08]">
                      <div className="flex min-w-0 items-center gap-2">
                        {r.link ? (
                          <a className="block min-w-0 truncate text-[12px] font-medium text-neutral-950 hover:underline dark:text-fg" href={r.link}>
                            {r.name}
                          </a>
                        ) : (
                          <span className="block min-w-0 truncate text-[12px] font-medium text-neutral-950 dark:text-fg">{r.name}</span>
                        )}
                      </div>
                      <div className="truncate text-[11px] text-neutral-600 dark:text-fg-dim">{r.project}</div>
                      <div className="truncate text-[11px] text-neutral-600 dark:text-fg-dim">{r.environment}</div>
                      <div className="text-[11px] text-neutral-600 dark:text-fg-dim">{headline(r.type)}</div>
                      <div>
                        <StatusBadge label={headline(r.status)} type={resourceStatusType(r.status)} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-6">
                  <Empty
                    size="sm"
                    title={search.trim() !== "" ? "No matching resources" : "No managed resources"}
                    description={search.trim() !== "" ? "Try another name or clear the search." : "Resources assigned to this server will appear here."}
                    iconName="projects"
                  />
                </div>
              )
            ) : (
              <div className="p-6">
                <Empty
                  size="sm"
                  title={search.trim() !== "" ? "No matching containers" : "No unmanaged containers"}
                  description={search.trim() !== "" ? "Try another name or clear the search." : "All detected Docker containers are managed by Freeploy."}
                  iconName="servers"
                />
              </div>
            )}
            {shown.total > 0 ? (
              <footer className="pager flex min-h-11 items-center justify-between border-t border-neutral-200 px-4 text-[11px] text-neutral-500 dark:border-white/[0.08] dark:text-fg-faint">
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-7 items-center whitespace-nowrap tabular-nums">{`${shown.from}-${shown.to} of ${shown.total}`}</span>
                  <PageSizeSelect
                    value={perPage}
                    onChange={(size) => {
                      setPerPage(size);
                      setPage(1);
                    }}
                    options={[10, 25, 50, 100]}
                  />
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" className={PAGER_BUTTON} aria-label="Previous page" disabled={shown.page <= 1} onClick={() => setPage(shown.page - 1)}>
                    <Reicon name="arrow-right" className="size-3.5 rotate-180" />
                  </button>
                  <button type="button" className={PAGER_BUTTON} aria-label="Next page" disabled={shown.page >= shown.lastPage} onClick={() => setPage(shown.page + 1)}>
                    <Reicon name="arrow-right" className="size-3.5" />
                  </button>
                </div>
              </footer>
            ) : null}
          </div>
        </SettingsSection>
      </div>
    </ServerWorkspace>
  );
}

export function ServerResourcesPage() {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle="Server Resources">
      <ServerResourcesContent />
    </Layout>
  );
}
