// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/application/deployment/index.blade.php,
// resources/views/components/table/{toolbar,search,filter}.blade.php,
// resources/views/components/table-pagination.blade.php, app/Livewire/Project/Application/Deployment/Index.php
// and bootstrap/helpers/timezone.php (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/application/{app_uuid}/deployment
// (project.application.deployment.index): the deployment history with its
// search, its filters (status, source, server, pull request), the sort by
// start and the pages. Like the view it reloads every five seconds on the
// first page. A commit is shown without the link to the Git host.
import { useCallback, useEffect, useRef, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson } from "../lib/api";
import { ago } from "../lib/ago";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Empty, SettingsSection } from "../components/Coolify";
import { PAGER_BUTTON, PageSizeSelect, TableDropdown } from "../components/CoolifyList";
import { environmentPath, environmentUuidFromPath, limit, projectUuidFromPath } from "./ProjectChrome";
import { applicationPath, applicationsApi, applicationUuidFromPath, ApplicationWorkspace, type ApplicationShowData } from "./ApplicationChrome";

type Tone = "success" | "warning" | "error" | "neutral";

export interface DeploymentItem {
  uuid: string;
  status: string;
  statusLabel: string;
  statusType: Tone;
  sourceLabel: string;
  sourceKey: string;
  pullRequestId: number;
  commit: string | null;
  commitMessage: string | null;
  serverId: number | null;
  serverName: string;
  createdAt: string | null;
  finishedAt: string | null;
}

interface FilterOption {
  value: string;
  label: string;
}

interface Index {
  deployments: DeploymentItem[];
  count: number;
  skip: number;
  take: number;
  currentPage: number;
  lastPage: number;
  pullRequestId: string | null;
  invalidPullRequestId: boolean;
  search: string;
  filters: string[];
  sort: "newest" | "oldest";
  statusFilterOptions: FilterOption[];
  sourceFilterOptions: FilterOption[];
  serverFilterOptions: FilterOption[];
  pullRequestOptions: FilterOption[];
  serverTimezone: string;
}

const two = (n: number) => String(n).padStart(2, "0");

/** calculateDuration(): '%Im %Ss', with the hours and the days when there are any. */
export function calculateDuration(start: string, end: string | number): string {
  const s = Math.max(0, Math.floor(((typeof end === "number" ? end : Date.parse(end)) - Date.parse(start)) / 1000));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const tail = `${two(Math.floor((s % 3600) / 60))}m ${two(s % 60)}s`;
  if (days > 0) return `${days}d ${two(hours)}h ${tail}`;
  return hours > 0 ? `${two(hours)}h ${tail}` : tail;
}

/** The view's $duration. */
export function deploymentDuration(d: Pick<DeploymentItem, "status" | "createdAt" | "finishedAt">, now = Date.now()): string {
  if (d.status === "queued") return "Waiting";
  if (!d.createdAt) return "-";
  if (d.status === "in_progress") return calculateDuration(d.createdAt, now);
  return d.finishedAt ? calculateDuration(d.createdAt, d.finishedAt) : "-";
}

/** formatDateInServerTimezone(): 'Y-m-d H:i:s T'; UTC when the zone is not one. */
export function formatInTimezone(iso: string, timezone: string): string {
  const format = (timeZone: string) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short" }).formatToParts(new Date(iso));
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")} ${part("timeZoneName")}`;
  };
  try {
    return format(timezone);
  } catch {
    return format("UTC");
  }
}

/** <x-status-badge as="button">: the dot (a spinner while the deployment runs) and the label. */
function StatusFilterBadge({ label, type, spinning, onClick }: { label: string; type: Tone; spinning: boolean; onClick: () => void }) {
  const dot = { neutral: "bg-neutral-400 dark:bg-neutral-500", success: "bg-emerald-500", warning: "bg-warning", error: "bg-red-500" }[type];
  return (
    <button
      type="button"
      title={`Filter by ${label}`}
      onClick={onClick}
      className="inline-flex max-w-full items-center whitespace-nowrap text-neutral-700 dark:text-fg gap-1.5 text-[13px] relative isolate before:absolute before:-inset-x-1.5 before:-inset-y-1 before:-z-10 before:rounded-md before:transition-colors hover:before:bg-neutral-100 dark:hover:before:bg-white/[0.07] table-filter-value table-filter-badge"
    >
      {spinning ? (
        <svg className="loading-indicator size-3 shrink-0 animate-spin text-neutral-500 dark:text-fg-dim" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle className="opacity-20" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
          <path className="opacity-80" d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ) : (
        <span className="relative flex size-1.5 shrink-0">
          <span className={`relative inline-flex size-1.5 rounded-full ${dot}`} />
        </span>
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}

const GROUP_LABEL = "px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-neutral-400 dark:text-fg-faint";

/** One checkbox option of the filter menu. */
function FilterCheck({ option, selected, onClick }: { option: FilterOption; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" className="listbox-option" role="option" aria-selected={selected} onClick={onClick}>
      <span className="truncate">{option.label}</span>
      <span
        className={`flex size-4 shrink-0 items-center justify-center rounded-[5px] border ${selected ? "border-coollabs bg-coollabs text-white dark:border-brand dark:bg-brand dark:text-white" : "border-neutral-300 bg-white dark:border-white/[0.14] dark:bg-white/[0.045]"}`}
      >
        {selected ? (
          <svg className="size-3" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="m2.25 6.15 2.35 2.3 5.15-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </span>
    </button>
  );
}

const PAGE_SIZE_KEY = "coolify.page-size.deployments";

function storedPageSize(): number {
  try {
    const n = Number(window.localStorage.getItem(PAGE_SIZE_KEY));
    return Number.isInteger(n) && n >= 1 && n <= 100 ? n : 10;
  } catch {
    return 10;
  }
}

/** Configuration::mount() for the deployment pages: the application of the frame, or back to the environment. */
export function useApplicationFrame() {
  const { me } = useSignedIn();
  const projectUuid = projectUuidFromPath();
  const environmentUuid = environmentUuidFromPath();
  const uuid = applicationUuidFromPath();
  const base = `${applicationsApi(me.team?.id)}/${encodeURIComponent(uuid)}`;
  const [frame, setFrame] = useState<ApplicationShowData | null>(null);
  const load = useCallback(async () => {
    const r = await getJson<ApplicationShowData>(base);
    if (!r.data) {
      if (r.status === 404) window.location.replace(environmentPath(projectUuid, environmentUuid));
      return;
    }
    if (r.data.application.project.uuid !== projectUuid || r.data.application.environment.uuid !== environmentUuid) return window.location.replace("/projects");
    setFrame(r.data);
  }, [base, projectUuid, environmentUuid]);
  useEffect(() => {
    void load();
  }, [load]);
  return { me, base, frame, reloadFrame: load };
}

function ApplicationDeploymentsContent() {
  const { me, base, frame, reloadFrame } = useApplicationFrame();
  const [index, setIndex] = useState<Index | null>(null);
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<string[]>([]);
  const [pullRequestId, setPullRequestId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("pull_request_id"));
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [skip, setSkip] = useState(0);
  const [take, setTake] = useState(storedPageSize);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);

  // wire:model.live.debounce.300ms="search"; updatedSearch() goes back to the first page.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (typed === search) return;
      setSearch(typed);
      setSkip(0);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [typed, search]);

  const load = useCallback(
    async (quiet: boolean) => {
      const id = ++request.current;
      if (!quiet) setLoading(true);
      const q = new URLSearchParams({ skip: String(skip), take: String(take), sort });
      if (search.trim() !== "") q.set("search", search);
      if (filters.length > 0) q.set("filters", filters.join(","));
      if (pullRequestId !== null && pullRequestId !== "") q.set("pull_request_id", pullRequestId);
      const r = await getJson<Index>(`${base}/deployments?${q.toString()}`);
      if (id !== request.current) return;
      setLoading(false);
      if (!r.data) return;
      setIndex(r.data);
      // mount(): 'Invalid Pull Request ID' and the filter is dropped.
      if (r.data.invalidPullRequestId) {
        notify.error("Invalid Pull Request ID");
        setPullRequestId(null);
      }
      // goToPage(): a page past the last one is the last one.
      if (r.data.skip !== skip) setSkip(r.data.skip);
    },
    [base, skip, take, sort, search, filters, pullRequestId],
  );
  useEffect(() => {
    void load(false);
  }, [load]);
  // wire:poll.5000ms="reloadDeployments", on the first page only.
  useEffect(() => {
    if (skip !== 0) return;
    const timer = window.setInterval(() => {
      void load(true);
      void reloadFrame();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [skip, load, reloadFrame]);
  useEffect(() => {
    if (frame) document.title = `${limit(frame.application.name, 10)} > Deployments | Freeploy`;
  }, [frame]);

  if (!frame) return null;
  const { application } = frame;
  const here = `${applicationPath(application.project.uuid, application.environment.uuid, application.uuid)}/deployment`;

  /** toggleDeploymentFilter() */
  const toggle = (value: string) => {
    setFilters((current) => (current.includes(value) ? current.filter((f) => f !== value) : [...current, value]));
    setSkip(0);
  };
  /** setPullRequestFilter(): the URL keeps the filter. */
  const setPullRequest = (value: string | null) => {
    setPullRequestId(value);
    setSkip(0);
    const url = new URL(window.location.href);
    if (value) url.searchParams.set("pull_request_id", value);
    else url.searchParams.delete("pull_request_id");
    window.history.replaceState(window.history.state, "", url.toString());
  };
  /** clearFilter() */
  const clear = () => {
    setFilters([]);
    setPullRequest(null);
  };
  const changeTake = (size: number) => {
    try {
      window.localStorage.setItem(PAGE_SIZE_KEY, String(size));
    } catch {
      // The page size is then not remembered.
    }
    setTake(size);
    setSkip(0);
  };

  const prActive = pullRequestId !== null && pullRequestId !== "";
  const activeCount = filters.length + (prActive ? 1 : 0);
  const hasActiveQuery = search.trim() !== "" || activeCount > 0;
  const deployments = index?.deployments ?? [];
  const count = index?.count ?? 0;
  const lastPage = Math.max(1, Math.ceil(count / take));
  const currentPage = Math.trunc(skip / take) + 1;
  const from = count === 0 ? 0 : skip + 1;
  const to = Math.min(skip + deployments.length, count);
  const groups: Array<[string, FilterOption[]]> = [
    ["Status", index?.statusFilterOptions ?? []],
    ["Source", index?.sourceFilterOptions ?? []],
    ["Server", index?.serverFilterOptions ?? []],
  ];
  const pullRequests = (index?.pullRequestOptions ?? []).slice(1);
  const sortLabel = sort === "newest" ? "Sort by started, oldest first" : "Sort by started, newest first";

  return (
    <ApplicationWorkspace application={application} orgId={me.team?.id} active="Deployment Logs" canUpdate={frame.canUpdate} canDeploy={frame.canDeploy}>
      <div className="application-settings-form min-w-0">
        <SettingsSection title="Deployment history" helper="Search, filter, and open a deployment to inspect its build logs." flush>
          <div className="table-toolbar flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center border-b border-neutral-200 p-3 dark:border-white/[0.08]">
            <div className="min-w-0 w-full flex-1 sm:max-w-md">
              <div className="table-search relative min-w-0 w-full">
                <input type="search" placeholder="Search deployments" aria-label="Search deployments" className="input w-full pl-8!" value={typed} onChange={(e) => setTyped(e.target.value)} />
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-2.5">
                  <Reicon name="search" className="size-3.5 text-neutral-400 dark:text-fg-faint" />
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
              <div className="table-filter">
                <TableDropdown
                  panelClass="w-44! overflow-hidden! p-0!"
                  trigger={(open) => (
                    <button type="button" aria-haspopup="listbox" aria-expanded={open} title={prActive ? `Pull request #${pullRequestId}` : undefined} className={`button max-w-80 min-w-0${activeCount > 0 ? " button-highlighted" : ""}`}>
                      <Reicon name="filter" className="size-3.5 shrink-0" />
                      <span className="truncate">{prActive ? `Pull request #${pullRequestId}` : "Filter"}</span>
                      {activeCount > 0 ? <span className="shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500 dark:bg-white/[0.07] dark:text-fg-dim">{activeCount}</span> : null}
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      <div className="max-h-80 overflow-y-auto p-1">
                        {groups.map(([label, options]) =>
                          options.length > 0 ? (
                            <div key={label} className="flex flex-col">
                              <span className={GROUP_LABEL}>{label}</span>
                              {options.map((option) => (
                                <FilterCheck key={option.value} option={option} selected={filters.includes(option.value)} onClick={() => toggle(option.value)} />
                              ))}
                            </div>
                          ) : null,
                        )}
                        {pullRequests.length > 0 ? (
                          <div className="flex flex-col">
                            <span className={GROUP_LABEL}>Pull request</span>
                            {pullRequests.map((option) => (
                              <button
                                key={option.value}
                                type="button"
                                className="listbox-option"
                                role="option"
                                aria-selected={pullRequestId === option.value}
                                onClick={() => {
                                  setPullRequest(option.value);
                                  close();
                                }}
                              >
                                <span>{option.label}</span>
                                {pullRequestId === option.value ? (
                                  <svg className="size-3.5 shrink-0" viewBox="0 0 24 24" fill="none">
                                    <path d="m4.5 12.75 6 6 9-13.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                                  </svg>
                                ) : null}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <div className="border-t border-neutral-200 bg-white p-1 dark:border-white/10 dark:bg-raised">
                        <button
                          type="button"
                          className="listbox-option text-neutral-500 dark:text-fg-dim"
                          disabled={activeCount === 0}
                          onClick={() => {
                            clear();
                            close();
                          }}
                        >
                          <span>Reset filters</span>
                          <Reicon name="x" className="size-3.5" />
                        </button>
                      </div>
                    </>
                  )}
                </TableDropdown>
              </div>
            </div>
          </div>

          {deployments.length > 0 ? (
            <div className={`data-table relative w-full transition-opacity${loading ? " opacity-50 pointer-events-none" : ""}`}>
              <div className="deployment-table-scroll">
                <div className="data-table-header deployment-table-grid rounded-none!">
                  <span>Status</span>
                  <span>Source</span>
                  <span>Commit</span>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-left"
                    aria-label={sortLabel}
                    title={sortLabel}
                    onClick={() => {
                      setSort(sort === "newest" ? "oldest" : "newest");
                      setSkip(0);
                    }}
                  >
                    <span>Started</span>
                    <Reicon name="chevron-down" className={`size-3 shrink-0${sort === "oldest" ? " rotate-180" : ""}`} />
                  </button>
                  <span>Duration</span>
                  <span>Server</span>
                </div>
                {deployments.map((d) => {
                  const url = `${here}/${d.uuid}`;
                  return (
                    <div
                      key={d.uuid}
                      className="data-table-row deployment-table-row deployment-table-grid group relative border-b border-neutral-200 text-[13px] text-neutral-600 hover:text-neutral-950 dark:border-white/[0.08] dark:text-fg-dim dark:hover:text-white"
                    >
                      <span className="min-w-0">
                        <StatusFilterBadge label={d.statusLabel} type={d.statusType} spinning={d.status === "in_progress"} onClick={() => toggle(`status:${d.status}`)} />
                      </span>
                      <span className="min-w-0">
                        <button type="button" className="table-filter-value truncate" title={`Filter by ${d.sourceLabel}`} onClick={() => toggle(`source:${d.sourceKey}`)}>
                          {d.sourceLabel}
                        </button>
                      </span>
                      <span className="min-w-0">
                        {d.commit ? (
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="shrink-0 font-mono text-xs text-neutral-950 dark:text-fg group-hover:text-neutral-950 dark:group-hover:text-white">{d.commit.slice(0, 7)}</span>
                            {d.commitMessage ? (
                              <a href={url} className="truncate text-neutral-500 dark:text-fg-faint group-hover:text-neutral-950 dark:group-hover:text-white" title={d.commitMessage}>
                                {d.commitMessage}
                              </a>
                            ) : null}
                          </span>
                        ) : (
                          <span className="text-neutral-400 dark:text-fg-faint group-hover:text-neutral-950 dark:group-hover:text-white">-</span>
                        )}
                      </span>
                      <a href={url} title={d.createdAt ? formatInTimezone(d.createdAt, index?.serverTimezone ?? "UTC") : undefined}>
                        {d.createdAt ? ago(d.createdAt) : "-"}
                      </a>
                      <a href={url} className="tabular-nums">
                        {deploymentDuration(d)}
                      </a>
                      {d.serverId ? (
                        <span className="min-w-0">
                          <button type="button" className="table-filter-value truncate" title={`Filter by ${d.serverName}`} onClick={() => toggle(`server:${d.serverId}`)}>
                            {d.serverName}
                          </button>
                        </span>
                      ) : (
                        <a href={url} className="truncate">
                          {d.serverName}
                        </a>
                      )}
                      <a href={url} className="deployment-row-link absolute inset-0" aria-hidden="true" tabIndex={-1} />
                    </div>
                  );
                })}
              </div>
              <footer hidden={count <= 10} className="pager flex min-h-11 items-center justify-between border-t border-neutral-200 px-4 text-[11px] text-neutral-500 dark:border-white/[0.08] dark:text-fg-faint">
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-7 items-center whitespace-nowrap tabular-nums">{`${from}\u{2013}${to} of ${count}`}</span>
                  <PageSizeSelect value={take} onChange={changeTake} options={[10, 25, 50, 100]} />
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" className={PAGER_BUTTON} aria-label="Previous page" disabled={currentPage <= 1} onClick={() => setSkip(Math.max(0, skip - take))}>
                    <Reicon name="arrow-right" className="size-3.5 rotate-180" />
                  </button>
                  <button type="button" className={PAGER_BUTTON} aria-label="Next page" disabled={currentPage >= lastPage} onClick={() => setSkip(skip + take)}>
                    <Reicon name="arrow-right" className="size-3.5" />
                  </button>
                </div>
              </footer>
            </div>
          ) : index ? (
            <Empty
              size="sm"
              title="No deployments found"
              description={hasActiveQuery ? "No deployments match the current search and filters." : "Deploy the application to create its first deployment record."}
              iconName="layers"
            />
          ) : null}
        </SettingsSection>
      </div>
    </ApplicationWorkspace>
  );
}

export function ApplicationDeploymentsPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Deployments">
      <ApplicationDeploymentsContent />
    </Layout>
  );
}
