// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/destination/index.blade.php,
// resources/views/livewire/shared/{list-search-controls,list-search-empty}.blade.php and
// app/Livewire/Destination/Index.php (Apache-2.0), modified.
//
// /destinations: the Docker networks of the org's usable servers, with
// search and the table and grid views. As in Coolify, a server that is not
// validated lists none, and New destination shows only when a server is usable.
import { useEffect, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Empty, ListSearchControls, ListSearchEmpty, ModalInput, StatusBadge, type ListViewMode } from "../components/Coolify";
import { NewDestinationForm, type DestinationInfo } from "./DestinationChrome";

interface Index {
  destinations: DestinationInfo[];
  servers: Array<{ uuid: string; name: string; destinationName: string }>;
  network: string;
  canCreate: boolean;
}

/** Coolify's key: the view stays the one chosen on this browser. */
const VIEW_KEY = "coolify-destinations-view";
function storedView(): ListViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "table";
  } catch {
    return "table";
  }
}

const COLUMNS = "min-w-[620px] grid-cols-[minmax(0,1fr)_minmax(10rem,.7fr)_10rem]";

function DestinationsContent() {
  const { me } = useSignedIn();
  const [data, setData] = useState<Index | null>(null);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ListViewMode>(storedView);
  const [newOpen, setNewOpen] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await getJson<Index>(`/v1/organizations/${me.team?.id ?? ""}/deploy/destinations`);
      if (!r.data) {
        if (r.status !== 401) notify.error("Failed to load destinations.");
        setData({ destinations: [], servers: [], network: "", canCreate: false });
        return;
      }
      setData(r.data);
    })();
  }, [me.team?.id]);

  function changeView(mode: ListViewMode) {
    setViewMode(mode);
    try {
      localStorage.setItem(VIEW_KEY, mode);
    } catch {
      /* storage blocked: the view lasts this page only */
    }
  }

  if (!data) return null;
  const { destinations, servers } = data;
  const query = search.trim().toLowerCase();
  const filtered = destinations.filter((d) => !query || [d.name, d.server.name, d.typeLabel].some((v) => v.toLowerCase().includes(query)));
  const first = servers[0];

  return (
    <div className="application-settings-form w-full">
      <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-[24px]! leading-7! font-semibold! tracking-tight!">Destinations</h1>
          <p className="mt-1 text-[13px] text-neutral-500 dark:text-fg-dim">
            {destinations.length} {destinations.length === 1 ? "network endpoint" : "network endpoints"}
          </p>
        </div>
        {first && data.canCreate ? (
          <div className="w-fit shrink-0">
            <ModalInput
              title="New Destination"
              open={newOpen}
              onOpenChange={setNewOpen}
              trigger={
                <button type="button" className="button button-highlighted">
                  <Reicon name="plus" className="size-3.5" />
                  New destination
                </button>
              }
            >
              <NewDestinationForm servers={servers} initial={{ serverUuid: first.uuid, name: first.destinationName, network: data.network }} canCreate={data.canCreate} />
            </ModalInput>
          </div>
        ) : null}
      </header>

      {destinations.length === 0 ? (
        <Empty title="No destinations yet" description="Add a Docker network endpoint to choose where your resources are deployed." iconName="destinations" />
      ) : (
        <div>
          <ListSearchControls placeholder="Search destinations" search={search} onSearch={setSearch} viewMode={viewMode} onViewMode={changeView} />

          {viewMode === "grid" ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {filtered.map((destination) => (
                <a
                  key={destination.uuid}
                  className="group flex min-h-28 flex-col rounded-xl border border-neutral-200 bg-white p-3 shadow-sm transition-all hover:-translate-y-px hover:border-neutral-300 hover:no-underline hover:shadow-md dark:border-white/[0.08] dark:bg-white/[0.05] dark:hover:border-white/[0.14]"
                  href={`/destination/${destination.uuid}`}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-fg-dim">
                      <Reicon name="destinations" className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-[13px]! leading-4! font-semibold! text-black dark:text-fg">{destination.name}</h2>
                      <p className="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-fg-faint">{destination.server.name}</p>
                    </div>
                  </div>

                  <div className="mt-auto flex items-center gap-2 pt-4">
                    <StatusBadge label={destination.typeLabel} type={destination.type === "swarm" ? "warning" : "success"} />
                  </div>
                </a>
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.05]">
              <div className={`grid ${COLUMNS} border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[11px] font-medium text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-faint`}>
                <div>Destination</div>
                <div>Server</div>
                <div>Type</div>
              </div>
              {filtered.map((destination) => (
                <a
                  key={destination.uuid}
                  href={`/destination/${destination.uuid}`}
                  className={`grid min-h-14 ${COLUMNS} items-center border-b border-neutral-200 px-4 py-2.5 text-[12px] transition-colors last:border-b-0 hover:bg-neutral-50 hover:no-underline dark:border-white/[0.07] dark:hover:bg-white/[0.025]`}
                >
                  <div className="truncate font-semibold text-black dark:text-fg">{destination.name}</div>
                  <div className="truncate text-neutral-500 dark:text-fg-dim">{destination.server.name}</div>
                  <div>
                    <StatusBadge label={destination.typeLabel} type={destination.type === "swarm" ? "warning" : "success"} />
                  </div>
                </a>
              ))}
            </div>
          )}
          {filtered.length === 0 ? <ListSearchEmpty label="destinations" /> : null}
        </div>
      )}
    </div>
  );
}

export function DestinationsPage() {
  return (
    <Layout title="Destinations" href="/destinations">
      <DestinationsContent />
    </Layout>
  );
}
