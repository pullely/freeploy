// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/index.blade.php and
// app/Livewire/Server/Index.php (Apache-2.0), modified.
//
// /servers: the org's servers, with search. The canvas view and the patch
// column need parts that are not ported yet, so the table is the only view.
import { useEffect, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Empty } from "../components/Coolify";

interface ServerRow {
  uuid: string;
  name: string;
  description: string | null;
  status: string;
  statusType: "success" | "warning" | "error";
  resourceCount: number;
}

const ROW = "grid min-h-14 min-w-[480px] grid-cols-[minmax(0,1fr)_9.5rem] items-center border-b border-neutral-200 px-4 py-2.5 text-[12px] transition-colors last:border-b-0 hover:bg-neutral-50 hover:no-underline md:min-w-[560px] md:grid-cols-[minmax(0,1fr)_6rem_9.5rem] dark:border-white/[0.07] dark:hover:bg-white/[0.025]";

function ServersContent() {
  const { me } = useSignedIn();
  const base = `/v1/organizations/${me.team?.id ?? ""}/deploy/servers`;
  const [servers, setServers] = useState<ServerRow[] | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    void (async () => {
      const r = await getJson<{ servers: ServerRow[]; canWrite: boolean }>(base);
      if (!r.data) {
        if (r.status !== 401) notify.error("Failed to load servers.");
        setServers([]);
        return;
      }
      setServers(r.data.servers);
      setCanWrite(r.data.canWrite);
    })();
  }, [base]);

  const query = search.trim().toLowerCase();
  const filtered = (servers ?? []).filter((s) => !query || [s.name, s.description, s.status].some((v) => String(v || "").toLowerCase().includes(query)));

  return (
    <div className="application-settings-form w-full">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="min-w-0 text-[24px]! leading-7! font-semibold! tracking-tight!">Servers</h1>
        <div className="flex flex-wrap items-center gap-2">
          {canWrite ? (
            <a href="/servers/new" className="button w-fit shrink-0 whitespace-nowrap button-highlighted">
              <Reicon name="plus" className="size-3.5" />
              New server
            </a>
          ) : null}
        </div>
      </div>
      {servers === null ? null : servers.length === 0 ? (
        <Empty title="No servers yet" description="Add a server to deploy applications, databases, and services." iconName="servers" />
      ) : (
        <div>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-sm">
              <Reicon name="search" className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
              <input
                type="search"
                placeholder="Search servers"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8! w-full rounded-lg! border-neutral-200! bg-white! py-0! pr-8! pl-8! text-[12px]! shadow-none! placeholder:text-neutral-400 focus:border-accent! focus:ring-0! dark:border-white/[0.08]! dark:bg-white/[0.035]! dark:text-fg! dark:placeholder:text-fg-faint"
              />
              {search ? (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-black dark:text-fg-faint dark:hover:bg-white/[0.07] dark:hover:text-fg"
                  aria-label="Clear search"
                >
                  <Reicon name="x" className="size-3" />
                </button>
              ) : null}
            </div>
          </div>
          <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.05]">
            <div className="grid min-w-[480px] grid-cols-[minmax(0,1fr)_9.5rem] border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[11px] font-medium text-neutral-500 md:min-w-[560px] md:grid-cols-[minmax(0,1fr)_6rem_9.5rem] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-faint">
              <div>Server</div>
              <div className="hidden md:block">Resources</div>
              <div>Status</div>
            </div>
            {filtered.map((server) => (
              <a key={server.uuid} href={`/server/${server.uuid}`} className={ROW}>
                <div className="flex min-w-0 items-center gap-3">
                  <div className="resource-glyph flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500">
                    <Reicon name="servers" className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold text-black dark:text-fg">{server.name}</p>
                    <p className="truncate text-[11px] text-neutral-500 dark:text-fg-faint">{server.description}</p>
                  </div>
                  {server.statusType !== "success" ? (
                    <span
                      data-tooltip={server.status}
                      aria-label={`Server status: ${server.status}`}
                      className={`ml-auto flex size-6 shrink-0 items-center justify-center rounded-md md:hidden ${server.statusType === "warning" ? "text-orange-500 dark:text-warning" : "text-red-500 dark:text-red-400"}`}
                    >
                      <Reicon name="alert-triangle" className="size-4" />
                    </span>
                  ) : null}
                </div>
                <div className="hidden text-[12px] font-medium text-neutral-600 md:block dark:text-fg-dim">
                  <span className="inline-flex items-center gap-1" title={`${server.resourceCount} ${server.resourceCount === 1 ? "resource" : "resources"}`}>
                    <Reicon name="grid" className="size-3.5 text-neutral-400 dark:text-fg-faint" />
                    <span>{server.resourceCount}</span>
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-[13px] text-neutral-700 dark:text-fg">
                  <span
                    className={`hidden size-1.5 shrink-0 rounded-full md:inline-block ${server.statusType === "success" ? "bg-emerald-500" : server.statusType === "warning" ? "bg-warning" : "bg-red-500"}`}
                  />
                  <span>{server.status}</span>
                </div>
              </a>
            ))}
          </div>
          {filtered.length === 0 ? (
            <div className="flex min-h-52 flex-col items-center justify-center rounded-xl border border-neutral-200 bg-white px-6 text-center dark:border-white/[0.08] dark:bg-white/[0.05]">
              <Reicon name="search" className="mb-3 size-6 text-neutral-300 dark:text-fg-faint" />
              <p className="text-[13px] font-medium">No matching servers</p>
              <p className="mt-1 text-[12px] text-neutral-500 dark:text-fg-dim">Try a different search.</p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function ServersPage() {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers">
      <ServersContent />
    </Layout>
  );
}
