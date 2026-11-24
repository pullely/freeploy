// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/destination/resources.blade.php and
// app/Livewire/Destination/Resources.php (Apache-2.0), modified.
//
// /destination/{uuid}/resources: the applications, databases and services
// deployed to a standalone destination, with search. Nothing can be deployed
// yet, so the list is its empty state until resources are ported. A Swarm
// destination has no such page: Coolify redirects to its General page.
import { useEffect, useState } from "react";
import { Layout } from "../layout/Layout";
import { Reicon } from "../components/Reicon";
import { Empty, SettingsSection } from "../components/Coolify";
import { DestinationWorkspace, useDestination, type DestinationInfo } from "./DestinationChrome";

interface ResourceRow {
  uuid: string;
  type: "application" | "service" | "database";
  name: string;
  project: string | null;
  environment: string | null;
  url: string | null;
  search: string;
}

interface Resources {
  destination: DestinationInfo;
  resources: ResourceRow[];
  canUpdate: boolean;
}

const ROW = "grid min-h-13 min-w-[680px] grid-cols-[minmax(10rem,.8fr)_minmax(10rem,.8fr)_minmax(12rem,1fr)_8rem] items-center border-b border-neutral-200 px-4 py-2.5 text-[12px] last:border-b-0 dark:border-white/[0.07]";

/** ucfirst($row['type']) */
const ucfirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Cells({ row }: { row: ResourceRow }) {
  return (
    <>
      <span className="truncate text-neutral-500 dark:text-fg-dim">{row.project}</span>
      <span className="truncate text-neutral-500 dark:text-fg-dim">{row.environment}</span>
      <span className="truncate font-medium text-black dark:text-fg">{row.name}</span>
      <span className="text-neutral-500 dark:text-fg-dim">{ucfirst(row.type)}</span>
    </>
  );
}

function DestinationResourcesContent() {
  const { data } = useDestination<Resources>("/resources");
  const [search, setSearch] = useState("");
  const swarm = data?.destination.type === "swarm";

  useEffect(() => {
    if (!data) return;
    // Resources::mount(): not a StandaloneDocker → redirect()->route('destination.show').
    if (swarm) window.location.replace(`/destination/${data.destination.uuid}`);
    else document.title = `${data.destination.name} Resources | Freeploy`;
  }, [data, swarm]);

  if (!data || swarm) return null;
  const { destination, resources } = data;
  const shown = resources.filter((row) => search === "" || row.search.includes(search.toLowerCase()));

  return (
    <DestinationWorkspace destination={destination} title={destination.name} subtitle="Applications, databases, and services on this network" active="resources">
      <div className="application-settings-form">
        <SettingsSection title="Resources" helper="Applications, databases, and services connected to this Docker network." flush>
          {resources.length === 0 ? (
            <Empty title="No resources use this destination" description="Resources will appear here after they are deployed to this network." iconName="destinations" size="sm" />
          ) : (
            <>
              <div className="border-b border-neutral-200 p-3 dark:border-white/[0.08]">
                <div className="relative w-full max-w-sm">
                  <Reicon name="search" className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
                  <input
                    type="search"
                    placeholder="Search resources"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-8! w-full rounded-lg! border-neutral-200! bg-white! py-0! pr-3! pl-8! text-[12px]! shadow-none! placeholder:text-neutral-400 focus:border-accent! focus:ring-0! dark:border-white/[0.08]! dark:bg-white/[0.035]! dark:text-fg! dark:placeholder:text-fg-faint"
                  />
                </div>
              </div>

              <div className="overflow-x-auto">
                <div className="grid min-w-[680px] grid-cols-[minmax(10rem,.8fr)_minmax(10rem,.8fr)_minmax(12rem,1fr)_8rem] border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[11px] font-medium text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-faint">
                  <div>Project</div>
                  <div>Environment</div>
                  <div>Resource</div>
                  <div>Type</div>
                </div>
                {shown.map((row) =>
                  row.url ? (
                    <a key={`${row.type}-${row.uuid}`} href={row.url} className={`${ROW} transition-colors hover:bg-neutral-50 hover:no-underline dark:hover:bg-white/[0.025]`}>
                      <Cells row={row} />
                    </a>
                  ) : (
                    <div key={`${row.type}-${row.uuid}`} className={ROW}>
                      <Cells row={row} />
                    </div>
                  ),
                )}
              </div>
            </>
          )}
        </SettingsSection>
      </div>
    </DestinationWorkspace>
  );
}

export function DestinationResourcesPage() {
  return (
    <Layout title="Destinations" href="/destinations" navHref="/destinations" documentTitle="Destination">
      <DestinationResourcesContent />
    </Layout>
  );
}
