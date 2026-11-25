// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/application/deployment/show.blade.php,
// resources/views/livewire/project/application/deployment-navbar.blade.php,
// app/Livewire/Project/Application/Deployment/Show.php and
// app/Livewire/Project/Application/DeploymentNavbar.php (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/application/{app_uuid}/deployment/{deployment_uuid}
// (project.application.deployment.show): one deployment's logs with the
// viewer's toolbar (follow, fullscreen, the status, Force start and Cancel,
// Find in logs, the View and Export menus). Like the view it reloads every
// two seconds until the deployment is over. The history beside the logs
// (the embedded index) is not ported: the Deployment Logs page lists it.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Layout } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { TableDropdown } from "../components/CoolifyList";
import { environmentPath, environmentUuidFromPath, limit, projectUuidFromPath } from "./ProjectChrome";
import { ApplicationWorkspace } from "./ApplicationChrome";
import { useApplicationFrame } from "./ApplicationDeployments";

type Tone = "success" | "warning" | "error" | "neutral";

interface LogLine {
  line: string;
  timestamp: string;
  stderr: boolean;
  hidden: boolean;
  command?: true;
}

interface Show {
  deployment: { uuid: string; status: string; statusLabel: string; statusType: Tone; commit: string | null; createdAt: string | null; finishedAt: string | null };
  lines: LogLine[];
  isDebugEnabled: boolean;
  isKeepAliveOn: boolean;
  canUpdate: boolean;
  canDeploy: boolean;
}

const DOT: Record<Tone, string> = { success: "bg-emerald-500", warning: "bg-warning motion-safe:animate-pulse", error: "bg-red-500", neutral: "bg-neutral-400 dark:bg-neutral-500" };

/** The view's $lineContent. */
const contentOf = (line: LogLine) => (line.command ? "[CMD]: " : "") + line.line.trim();

/** highlightText(): the matches of the query, marked. */
function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const out: ReactNode[] = [];
  let last = 0;
  for (let at = lower.indexOf(query, last); at !== -1; at = lower.indexOf(query, last)) {
    if (at > last) out.push(text.substring(last, at));
    out.push(
      <span key={at} className="log-highlight">
        {text.substring(at, at + query.length)}
      </span>,
    );
    last = at + query.length;
  }
  if (last < text.length) out.push(text.substring(last));
  return out;
}

/** downloadLogs(): the text as a file. */
function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");

function ApplicationDeploymentContent() {
  const { me, base, frame, reloadFrame } = useApplicationFrame();
  const deploymentUuid = decodeURIComponent(window.location.pathname.split("/")[8] ?? "");
  const api = `${base}/deployments/${encodeURIComponent(deploymentUuid)}`;
  const [show, setShow] = useState<Show | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [follow, setFollow] = useState(true);
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const followManuallyDisabled = useRef(false);
  const container = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const wasAlive = useRef(false);

  const load = useCallback(async () => {
    const r = await getJson<Show>(api);
    if (!r.data) {
      // mount(): a deployment that is not the application's goes back to the application's environment.
      if (r.status === 404) window.location.replace(environmentPath(projectUuidFromPath(), environmentUuidFromPath()));
      return;
    }
    setShow(r.data);
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  // wire:poll.2000ms="polling" while isKeepAliveOn.
  const alive = show?.isKeepAliveOn ?? false;
  useEffect(() => {
    if (!alive) {
      // 'deploymentFinished': the heading's status follows, and the logs stop following.
      if (wasAlive.current) {
        wasAlive.current = false;
        void reloadFrame();
        const timer = window.setTimeout(() => setFollow(false), 500);
        return () => window.clearTimeout(timer);
      }
      return;
    }
    wasAlive.current = true;
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [alive, load, reloadFrame]);

  // x-model.debounce.300ms="searchQuery"
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(typed.trim().toLowerCase()), 300);
    return () => window.clearTimeout(timer);
  }, [typed]);

  useEffect(() => {
    if (frame) document.title = `${limit(frame.application.name, 10)} > Deployment | Freeploy`;
  }, [frame]);

  // scrollToBottom() after each update while the logs are followed.
  const lines = show?.lines;
  useEffect(() => {
    if (follow && alive && container.current) container.current.scrollTop = container.current.scrollHeight;
  }, [lines, follow, alive]);

  // handleFindShortcut(): Ctrl+F / ⌘F focuses "Find in logs".
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const isFind = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key?.toLowerCase() === "f";
      if (!isFind || !searchInput.current || document.activeElement === searchInput.current) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.isContentEditable || active.matches("input, textarea, select"))) return;
      event.preventDefault();
      searchInput.current.focus();
      searchInput.current.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const rendered = useMemo(
    () =>
      (lines ?? []).map((line) => {
        const content = contentOf(line);
        return { line, content, searchable: `${line.timestamp} ${content}`.toLowerCase() };
      }),
    [lines],
  );

  if (!frame || !show) return null;
  const { application } = frame;
  const { deployment } = show;
  const visible = query ? rendered.filter((r) => r.searchable.includes(query)) : rendered;
  const matchCount = query ? visible.length : 0;

  /** exportLogs(): the displayed lines that match the search, their secrets hidden. */
  const exportLogs = async (): Promise<string | null> => {
    const q = new URLSearchParams({ timestamps: showTimestamps ? "1" : "0" });
    if (typed.trim() !== "") q.set("search", typed.trim());
    const r = await getJson<{ logs: string }>(`${api}/logs?${q.toString()}`);
    if (!r.data) {
      notify.error("Failed to prepare logs for export.");
      return null;
    }
    return r.data.logs;
  };
  const copyLogs = async () => {
    if (!navigator.clipboard) return notify.error("Clipboard is not available. Please use HTTPS or localhost.");
    const content = await exportLogs();
    if (content === null) return;
    try {
      await navigator.clipboard.writeText(content);
      notify.success("Logs copied to clipboard.");
    } catch {
      notify.error("Failed to copy logs to clipboard.");
    }
  };
  const downloadLogs = async () => {
    const content = await exportLogs();
    if (content) download(`deployment-${deployment.uuid}-${stamp()}.txt`, `${content}\n`);
  };
  const downloadAllLogs = async () => {
    setDownloadingAll(true);
    const r = await getJson<{ logs: string }>(`${api}/logs?all=1`);
    setDownloadingAll(false);
    if (!r.data?.logs) return;
    download(`deployment-${deployment.uuid}-all-logs-${stamp()}.txt`, r.data.logs);
    notify.success("All logs downloaded.");
  };

  /** DeploymentNavbar: force_start(), cancel() and show_debug(). */
  const act = async (action: "force-start" | "cancel" | "debug") => {
    setBusy(true);
    const r = await postJson<{ message?: string }>(`${api}/${action}`, {});
    setBusy(false);
    if (!r.ok) notify.error(summarize(r.error.messages));
    else if (r.data.message) notify.success(r.data.message);
    await load();
    void reloadFrame();
  };

  const toggleFollow = () => {
    followManuallyDisabled.current = follow;
    setFollow(!follow);
  };
  /** handleScroll(): back at the bottom, the logs are followed again unless the button turned it off. */
  const onScroll = () => {
    const el = container.current;
    if (!el || follow || followManuallyDisabled.current) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 10) setFollow(true);
  };
  const queued = deployment.status === "queued";
  const running = queued || deployment.status === "in_progress";

  return (
    <ApplicationWorkspace application={application} orgId={me.team?.id} active="Deployment Logs" canUpdate={frame.canUpdate} canDeploy={frame.canDeploy}>
      <div className={`flex h-[calc(100dvh-8rem)] min-h-[32rem] w-full min-w-0 flex-col overflow-hidden${fullscreen ? "" : " 2xl:sticky 2xl:top-4"}`}>
        <div id="screen" className={fullscreen ? "fullscreen flex flex-col" : "mt-2 flex flex-1 min-h-0 flex-col overflow-hidden lg:mt-0"}>
          <div className={`logs-viewer flex min-h-0 w-full flex-col overflow-hidden bg-white text-neutral-800 dark:bg-log dark:text-neutral-100 ${fullscreen ? "h-full" : "flex-1 rounded-xl border shadow-sm"}`}>
            <div className="runtime-log-toolbar logs-viewer-toolbar">
              <div className="logs-viewer-toolbar-controls">
                <div className="logs-viewer-primary">
                  <div className="logs-viewer-actions">
                    {show.isKeepAliveOn ? (
                      <button type="button" title="Follow Logs" className={`logs-viewer-btn${follow ? " logs-viewer-btn-active" : ""}`} onClick={toggleFollow}>
                        <svg className="size-4" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                          <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 5v14m4-4l-4 4m-4-4l4 4" />
                        </svg>
                      </button>
                    ) : null}
                    {fullscreen ? (
                      <button type="button" title="Minimize" className="logs-viewer-btn" onClick={() => setFullscreen(false)}>
                        <svg className="size-4" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                          <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 14h4m0 0v4m0-4l-6 6m14-10h-4m0 0V6m0 4l6-6" />
                        </svg>
                      </button>
                    ) : (
                      <button type="button" title="Fullscreen" className="logs-viewer-btn" onClick={() => setFullscreen(true)}>
                        <svg className="size-4" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                          <path
                            fill="currentColor"
                            d="M9.793 12.793a1 1 0 0 1 1.497 1.32l-.083.094L6.414 19H9a1 1 0 0 1 .117 1.993L9 21H4a1 1 0 0 1-.993-.883L3 20v-5a1 1 0 0 1 1.993-.117L5 15v2.586l4.793-4.793ZM20 3a1 1 0 0 1 .993.883L21 4v5a1 1 0 0 1-1.993.117L19 9V6.414l-4.793 4.793a1 1 0 0 1-1.497-1.32l.083-.094L17.586 5H15a1 1 0 0 1-.117-1.993L15 3h5Z"
                          />
                        </svg>
                      </button>
                    )}
                  </div>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-neutral-600 dark:text-fg-dim">
                    {deployment.status === "in_progress" ? (
                      <svg className="loading-indicator size-3.5 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <circle className="opacity-20" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
                        <path className="opacity-80" d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    ) : (
                      <span className={`size-2 shrink-0 rounded-full ${DOT[deployment.statusType]}`} />
                    )}
                    {deployment.statusLabel}
                  </span>
                </div>
                <div className="logs-viewer-end">
                  <div className={`logs-viewer-deployment-actions${running ? "" : " hidden"}`}>
                    {running ? (
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {queued ? (
                          <button type="button" className="button logs-viewer-deployment-btn" disabled={busy} onClick={() => void act("force-start")}>
                            Force start
                          </button>
                        ) : null}
                        <button type="button" className="button button-error logs-viewer-deployment-btn logs-viewer-cancel-btn" disabled={busy} onClick={() => void act("cancel")}>
                          <span className="sm:hidden">Cancel</span>
                          <span className="hidden sm:inline">Cancel deployment</span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <div className="logs-viewer-search relative">
                    <Reicon name="search" className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
                    <input
                      ref={searchInput}
                      type="search"
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      placeholder="Find in logs"
                      aria-label="Find in logs"
                      aria-keyshortcuts={mac ? "Meta+F" : "Control+F"}
                      className="h-8! w-full rounded-lg! border-neutral-200! bg-white! py-0! pr-8! pl-8! text-[12px]! shadow-none! placeholder:text-neutral-400 focus:border-accent! focus:ring-0! dark:border-white/[0.08]! dark:bg-white/[0.035]! dark:text-fg! dark:placeholder:text-fg-faint"
                    />
                    {typed ? (
                      <button
                        type="button"
                        onClick={() => setTyped("")}
                        className="absolute top-1/2 right-2 z-10 flex size-5 -translate-y-1/2 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-black dark:text-fg-faint dark:hover:bg-white/[0.07] dark:hover:text-fg"
                        aria-label="Clear search"
                      >
                        <Reicon name="x" className="size-3" />
                      </button>
                    ) : (
                      <kbd aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2 z-10 -translate-y-1/2 rounded border border-neutral-200 px-1 font-sans text-[10px] leading-4 text-neutral-400 dark:border-white/[0.08] dark:text-fg-faint">
                        {mac ? "\u{2318}F" : "Ctrl+F"}
                      </kbd>
                    )}
                  </div>
                  <div className="runtime-log-menus">
                    <TableDropdown
                      panelClass="runtime-log-menu min-w-48! max-h-none!"
                      trigger={(open) => (
                        <button type="button" title="View Options" className="button" aria-haspopup="menu" aria-expanded={open}>
                          <svg className="size-3.5 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75"
                            />
                          </svg>
                          <span>View</span>
                          <Reicon name="chevron-down" className={`size-3 transition-transform${open ? " rotate-180" : ""}`} />
                        </button>
                      )}
                    >
                      {() => (
                        <div>
                          <p className="runtime-log-menu-label">Display</p>
                          <button type="button" className="listbox-option" role="menuitemcheckbox" aria-checked={showTimestamps} onClick={() => setShowTimestamps(!showTimestamps)}>
                            <span className="flex-1 text-left">Timestamps</span>
                            {showTimestamps ? <span>{"\u{2713}"}</span> : null}
                          </button>
                          {show.canUpdate ? (
                            <button type="button" className="listbox-option" role="menuitemcheckbox" aria-checked={show.isDebugEnabled} disabled={busy} onClick={() => void act("debug")}>
                              <span className="flex-1 text-left">Debug logs</span>
                              {show.isDebugEnabled ? <span>{"\u{2713}"}</span> : null}
                            </button>
                          ) : null}
                        </div>
                      )}
                    </TableDropdown>
                    <TableDropdown
                      panelClass="runtime-log-menu min-w-52!"
                      trigger={(open) => (
                        <button type="button" title="Copy or Download Logs" className="button" aria-haspopup="menu" aria-expanded={open}>
                          <svg className="size-3.5 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
                          </svg>
                          <span>Export</span>
                          <Reicon name="chevron-down" className={`size-3 transition-transform${open ? " rotate-180" : ""}`} />
                        </button>
                      )}
                    >
                      {(close) => (
                        <div>
                          <p className="px-2 py-1.5 text-xs text-neutral-500 dark:text-fg-dim">Copied and downloaded logs hide secrets.</p>
                          <button
                            type="button"
                            role="menuitem"
                            className="listbox-option"
                            onClick={() => {
                              void copyLogs();
                              close();
                            }}
                          >
                            <span className="flex-1 text-left">Copy visible logs</span>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="listbox-option"
                            onClick={() => {
                              void downloadLogs();
                              close();
                            }}
                          >
                            <span className="flex-1 text-left">Download visible logs</span>
                          </button>
                          {show.canUpdate ? (
                            <button
                              type="button"
                              role="menuitem"
                              className={`listbox-option${downloadingAll ? " opacity-50 cursor-not-allowed" : ""}`}
                              disabled={downloadingAll}
                              onClick={() => void downloadAllLogs().finally(close)}
                            >
                              <span className="flex-1 text-left">{downloadingAll ? "Downloading..." : "Download full log (with debug)"}</span>
                            </button>
                          ) : null}
                        </div>
                      )}
                    </TableDropdown>
                  </div>
                  <div className="logs-viewer-meta">{query ? <span className="text-xs text-neutral-500 whitespace-nowrap">{`${matchCount} matches`}</span> : null}</div>
                </div>
              </div>
            </div>
            <div
              id="logsContainer"
              ref={container}
              tabIndex={0}
              onScroll={onScroll}
              onWheel={(e) => {
                if (follow && e.deltaY < 0) setFollow(false);
              }}
              onKeyDown={(e) => {
                if (follow && ["ArrowUp", "PageUp", "Home"].includes(e.key)) setFollow(false);
              }}
              className="logs-viewer-viewport flex min-h-40 flex-1 flex-col overflow-y-auto overflow-x-hidden scrollbar"
            >
              <div id="logs" className="flex min-w-0 flex-col font-logs text-[11px] leading-relaxed sm:text-xs">
                {query && matchCount === 0 ? <div className="py-2 text-neutral-500">No matches found.</div> : null}
                {rendered.length === 0 ? <span className="mb-2 font-logs text-neutral-400">No logs yet.</span> : null}
                {visible.map(({ line, content }, i) => (
                  <div key={i} data-log-line className={`${line.command ? "mt-2 " : ""}log-line logs-viewer-line`}>
                    {showTimestamps ? <span className="logs-viewer-timestamp">{line.timestamp}</span> : null}
                    <span className={`${line.hidden ? "text-success dark:text-warning " : ""}${line.stderr ? "text-red-500 " : ""}${line.command ? "font-bold " : ""}logs-viewer-line-text`}>{highlight(content, query)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </ApplicationWorkspace>
  );
}

export function ApplicationDeploymentPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Deployment">
      <ApplicationDeploymentContent />
    </Layout>
  );
}
