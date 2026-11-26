// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/team/audit-log.blade.php,
// resources/views/components/{table-pagination,empty}.blade.php and app/Livewire/Team/AuditLog.php
// (Apache-2.0), modified.
//
// /team/audit-log: the team's audit log (DP-75), read only. The component's properties (search, action,
// source, sort, perPage, page) are sent to events-worker (GET …/audit/team-log), which filters, sorts and
// pages as AuditLog::render() does and maps Freeploy's events onto Coolify's columns. Who may read it:
// Coolify's boot() aborts 403 unless the user is the team's owner or admin; the API answers 404 then,
// shown as Coolify's 403 page. Freeploy records no field changes, so "View changes" is never shown.
import { useCallback, useEffect, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson } from "../lib/api";
import { ago } from "../lib/ago";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Empty, Listbox, SettingsSection } from "../components/Coolify";
import { PAGER_BUTTON, PageSizeSelect } from "../components/CoolifyList";
import { Sort, TeamLayout, teamApi } from "./Team";
import { Forbidden } from "./TeamDanger";

interface AuditEventRow {
  id: string;
  event: string;
  source: string;
  action: string;
  actorType: string;
  actorName: string | null;
  actorEmail: string | null;
  actorTokenName: string | null;
  description: string;
  createdAt: string;
}

interface AuditPage {
  sort: string;
  actionOptions: Array<{ value: string; label: string }>;
  sourceOptions: Array<{ value: string; label: string }>;
  events: AuditEventRow[];
  from: number;
  to: number;
  total: number;
  currentPage: number;
  lastPage: number;
  perPage: number;
}

/** Str::headline() for the few words the row shows (the API sends the action and actor type raw). */
function headline(value: string): string {
  return value
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Carbon's toDayDateTimeString() in UTC (Coolify's app timezone): "Thu, Jan 1, 2026 12:00 AM". */
function dayDateTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getUTCHours() % 12 || 12;
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${h}:${m} ${d.getUTCHours() < 12 ? "AM" : "PM"}`;
}

function readPageSize(): number {
  try {
    const n = Number(localStorage.getItem("freeploy.page-size.audit-log"));
    return n >= 10 && n <= 100 ? n : 25;
  } catch {
    return 25;
  }
}

const GRID = "grid-cols-[14rem_minmax(0,1fr)_12rem_9rem]";

function TeamAuditLog() {
  const { me } = useSignedIn();
  const base = `/v1/organizations/${me.team?.id ?? ""}/audit/team-log`;
  const [query, setQuery] = useState({ search: "", action: "all", source: "all", sort: "time-desc", perPage: readPageSize(), page: 1 });
  const [search, setSearch] = useState("");
  const [data, setData] = useState<AuditPage | null>(null);
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(false);
  // The settings layout's page search lists the pages by the user's role (as the General page reads it).
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    void getJson<{ role: string }>(`${teamApi(me.team?.id)}/members`).then((r) => setRole(r.data?.role ?? null));
  }, [me.team?.id]);

  // wire:model.live.debounce.300ms="search", then updatedSearch(): resetPage().
  useEffect(() => {
    const t = setTimeout(() => setQuery((q) => (q.search === search ? q : { ...q, search, page: 1 })), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ search: query.search, action: query.action, source: query.source, sort: query.sort, perPage: String(query.perPage), page: String(query.page) });
    const r = await getJson<AuditPage>(`${base}?${params.toString()}`);
    setLoading(false);
    if (r.data) return setData(r.data);
    if (r.status === 404) return setDenied(true);
    if (r.status !== 401) notify.error("Failed to load the audit log.");
  }, [base, query]);
  useEffect(() => {
    void load();
  }, [load]);

  const set = (patch: Partial<typeof query>) => setQuery((q) => ({ ...q, ...patch, page: patch.page ?? 1 }));
  const setPerPage = (n: number) => {
    const perPage = Math.max(10, Math.min(100, n));
    try {
      localStorage.setItem("freeploy.page-size.audit-log", String(perPage));
    } catch {
      /* storage blocked */
    }
    set({ perPage });
  };

  if (denied) return <Forbidden />;
  if (!data) return null;
  const sortBy = data.sort;
  return (
    <TeamLayout role={role}>
      <div className="application-settings-form">
        <SettingsSection title="Audit log" helper="Activity from the last 90 days for the current team." flush>
          <div className="flex flex-col gap-2 border-b border-neutral-200 p-3 sm:flex-row sm:items-center dark:border-white/[0.08]">
            <div className="relative min-w-0 flex-1 sm:max-w-sm">
              <Reicon name="search" className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                type="search"
                placeholder="Search activity"
                aria-label="Search activity"
                className="h-8! w-full rounded-lg! border-neutral-200! bg-white! py-0! pr-8! pl-8! text-[12px]! shadow-none! placeholder:text-neutral-400 focus:border-accent! focus:ring-0! dark:border-white/[0.08]! dark:bg-white/[0.035]! dark:text-fg! dark:placeholder:text-fg-faint"
              />
            </div>
            <div className="grid grid-cols-2 gap-2 sm:flex">
              <div className="sm:w-36">
                <Listbox id="action" options={data.actionOptions} value={query.action} onChange={(action) => set({ action })} />
              </div>
              <div className="sm:w-36">
                <Listbox id="source" options={data.sourceOptions} value={query.source} onChange={(source) => set({ source })} />
              </div>
            </div>
          </div>

          {data.events.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <div className={`data-table transition-opacity${loading ? " opacity-50 pointer-events-none" : ""}`}>
                  <div className={`grid min-w-[760px] ${GRID} gap-4 border-b border-neutral-200 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-neutral-500 dark:border-white/[0.07] dark:text-fg-faint`}>
                    <Sort label="Actor" asc="actor-asc" desc="actor-desc" sortBy={sortBy} onSort={(sort) => set({ sort })} />
                    <Sort label="Activity" asc="activity-asc" desc="activity-desc" sortBy={sortBy} onSort={(sort) => set({ sort })} />
                    <Sort label="Source" asc="source-asc" desc="source-desc" sortBy={sortBy} onSort={(sort) => set({ sort })} />
                    <Sort label="Time" asc="time-asc" desc="time-desc" first="desc" sortBy={sortBy} onSort={(sort) => set({ sort })} className="justify-self-end" />
                  </div>
                  {data.events.map((event) => (
                    <div key={event.id} className="min-w-[760px] border-b border-neutral-200 last:border-b-0 dark:border-white/[0.07]">
                      <div className={`grid ${GRID} gap-4 px-4 py-3`}>
                        <div className="min-w-0">
                          <div className="truncate text-[12px] font-medium text-black dark:text-fg">{event.actorName || headline(event.actorType)}</div>
                          {event.actorEmail ? <div className="truncate text-[11px] text-neutral-500 dark:text-fg-faint">{event.actorEmail}</div> : null}
                          {event.actorTokenName ? (
                            <div className="truncate text-[11px] text-neutral-500 dark:text-fg-faint" title={`Token: ${event.actorTokenName}`}>
                              Token: {event.actorTokenName}
                            </div>
                          ) : null}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-black dark:text-fg">{event.description}</div>
                          <div className="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-fg-faint">{event.event}</div>
                        </div>
                        <div className="flex items-center gap-2 text-[12px] text-neutral-500 dark:text-fg-dim">
                          <span className="rounded-md bg-neutral-100 px-2 py-1 dark:bg-white/[0.06]">{event.source.toUpperCase()}</span>
                          <span>{headline(event.action)}</span>
                        </div>
                        <time dateTime={event.createdAt} title={dayDateTime(event.createdAt)} className="self-center text-right text-[11px] text-neutral-500 dark:text-fg-faint">
                          {ago(event.createdAt)}
                        </time>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <footer hidden={data.total <= 10} className="pager flex min-h-11 items-center justify-between border-t border-neutral-200 px-4 text-[11px] text-neutral-500 dark:border-white/[0.08] dark:text-fg-faint">
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-7 items-center whitespace-nowrap tabular-nums">{`${data.from}–${data.to} of ${data.total}`}</span>
                  <PageSizeSelect value={data.perPage} onChange={setPerPage} options={[10, 25, 50, 100]} />
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => set({ page: data.currentPage - 1 })} disabled={data.currentPage <= 1} className={PAGER_BUTTON} aria-label="Previous page">
                    <Reicon name="arrow-right" className="size-3.5 rotate-180" />
                  </button>
                  <button type="button" onClick={() => set({ page: data.currentPage + 1 })} disabled={data.currentPage >= data.lastPage} className={PAGER_BUTTON} aria-label="Next page">
                    <Reicon name="arrow-right" className="size-3.5" />
                  </button>
                </div>
              </footer>
            </>
          ) : (
            <Empty title="No activity found" description="Team actions will appear here as they happen." iconName="time-back" size="sm" />
          )}
        </SettingsSection>
      </div>
    </TeamLayout>
  );
}

export function TeamAuditLogPage() {
  return (
    <Layout title="Team" href="/team/audit-log" documentTitle="Team Audit Log">
      <TeamAuditLog />
    </Layout>
  );
}
