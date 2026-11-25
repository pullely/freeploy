// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/resource/index.blade.php,
// resources/views/components/resource-logo.blade.php and app/Livewire/Project/Resource/Index.php
// (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}: the environment's header and its
// resources — applications and standalone databases — as a table or a grid, with search, sort
// and paging; "No resources yet" when it has none. The filters (type, status,
// server, tags), the tags column's values, the image scan markers and a
// resource's favicon are not ported; "Shared variables" and the canvas lead
// to pages that are not ported yet.
import { useEffect, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson } from "../lib/api";
import { Reicon } from "../components/Reicon";
import { Empty } from "../components/Coolify";
import { CanvasViewToggle, ClientPagination, ListSearch, SortDropdown, SortHeader, useListState, type ListState, type SortOption } from "../components/CoolifyList";
import { environmentPath, environmentUuidFromPath, limit, ProjectBreadcrumb, projectPath, projectsApi, projectUuidFromPath, type EnvironmentShowData } from "./ProjectChrome";
import { applicationPath } from "./ApplicationChrome";
import { databasePath } from "./DatabaseChrome";
import { servicePath } from "../lib/service-templates";

/** Index::toSearchableArray(). */
interface ResourceItem {
  uuid: string;
  name: string;
  type: "application" | "database" | "service";
  typeLabel: string;
  /** A database's type(), "standalone-postgresql": which logo it has. */
  databaseType?: string;
  fqdn: string | null;
  description: string | null;
  status: string;
  restartLimitReached: boolean;
  restartCount: number;
  maxRestartCount: number;
  buildPack: string;
  destination: { server: { name: string } };
}

const statusState = (item: ResourceItem) => (item.restartLimitReached ? "restart-limit" : String(item.status || "unknown").split(":")[0]!.toLowerCase());
function statusLabel(item: ResourceItem): string {
  if (item.restartLimitReached) return "Restart limit reached";
  const state = statusState(item);
  return state.charAt(0).toUpperCase() + state.slice(1);
}
const statusTitle = (item: ResourceItem) => (item.restartLimitReached ? `${item.restartCount}/${item.maxRestartCount} restarts. Container preserved.` : statusLabel(item));
function statusDotClass(item: ResourceItem): string {
  if (item.restartLimitReached) return "bg-warning";
  const state = statusState(item);
  if (state === "running") return "bg-emerald-500";
  if (["starting", "restarting", "degraded"].includes(state)) return "bg-warning";
  if (["exited", "stopped", "failed"].includes(state)) return "bg-red-500";
  return "bg-neutral-400 dark:bg-neutral-500";
}
const firstDomain = (fqdn: string) => fqdn.split(",")[0]!.trim();
const displayDomain = (fqdn: string | null) => (fqdn ? firstDomain(fqdn).replace(/^https?:\/\//, "") : "");
const serverName = (item: ResourceItem) => item.destination?.server?.name || "Unknown";

const SORT_VALUES: Record<string, (item: ResourceItem) => string | number> = {
  name: (item) => item.name,
  type: (item) => item.typeLabel,
  status: (item) => statusLabel(item),
  domain: (item) => displayDomain(item.fqdn),
  server: (item) => serverName(item),
};
const SORT_OPTIONS: SortOption[] = [
  { value: "name-asc", label: "Name: A to Z" },
  { value: "name-desc", label: "Name: Z to A" },
  { value: "type-asc", label: "Type: A to Z" },
  { value: "status-asc", label: "Status: A to Z" },
  { value: "server-asc", label: "Server: A to Z" },
];

/** <x-resource-logo>: how the application is built, else the resource type icon. */
function ResourceLogo({ item }: { item: ResourceItem }) {
  // A service's logo is its template's; Freeploy ships none yet, so Coolify's placeholder (DP-59).
  if (item.type === "service") {
    return (
      <span className="flex size-full items-center justify-center" data-resource-logo-image="">
        <img src="/svgs/default.webp" alt="" className="size-full object-contain" />
      </span>
    );
  }
  if (item.type === "database") {
    // resource_logo(): the engine's logo, with a dark variant for KeyDB and Dragonfly.
    const engine = (item.databaseType ?? "").replace(/^standalone-/, "");
    const logo = engine === "postgresql" ? "postgres" : engine;
    if (!["postgres", "mysql", "mariadb", "mongodb", "redis", "keydb", "dragonfly", "clickhouse"].includes(logo)) return <Reicon name="database" className="size-4" />;
    const dark = logo === "keydb" || logo === "dragonfly";
    return (
      <span className="flex size-full items-center justify-center" data-resource-logo-image="">
        <img src={`/svgs/resources/${logo}.svg`} alt="" className={dark ? "size-full object-contain dark:hidden" : "size-full object-contain"} />
        {dark ? <img src={`/svgs/resources/${logo}-dark.svg`} alt="" className="hidden size-full object-contain dark:block" /> : null}
      </span>
    );
  }
  if (item.buildPack === "dockerimage") {
    return (
      <span className="flex size-full items-center justify-center" data-resource-logo-image="">
        <img src="/svgs/resources/docker-image.svg" alt="" className="size-full object-contain" />
      </span>
    );
  }
  return <Reicon name="browser-code" className="size-4" />;
}

function StatusBadge({ item, className = "" }: { item: ResourceItem; className?: string }) {
  return (
    <span className={`inline-flex max-w-full items-center whitespace-nowrap text-neutral-700 dark:text-fg gap-1.5 text-[13px] ${className}`.trimEnd()} title={statusTitle(item)}>
      <span className={`size-1.5 shrink-0 rounded-full ${statusDotClass(item)}`} />
      <span className="truncate">{statusLabel(item)}</span>
    </span>
  );
}

function NoMatching({ className = "" }: { className?: string }) {
  return (
    <div className={`flex min-h-52 flex-col items-center justify-center px-6 text-center ${className}`.trimEnd()}>
      <Reicon name="search" className="mb-3 size-6 text-neutral-300 dark:text-fg-faint" />
      <p className="text-[13px] font-medium">No matching resources</p>
      <p className="mt-1 text-[12px] text-neutral-500 dark:text-fg-dim">Try a different search or filter.</p>
    </div>
  );
}

function ResourceList({ list, href, canvasUrl }: { list: ListState<ResourceItem>; href: (item: ResourceItem) => string; canvasUrl: string }) {
  const untyped = list as unknown as ListState<unknown>;
  return (
    <>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <ListSearch list={untyped} placeholder="Search resources" />
        <div className="flex flex-wrap items-center gap-2">
          <SortDropdown list={untyped} options={SORT_OPTIONS} panelClass="w-52!" />
          <CanvasViewToggle list={untyped} canvasUrl={canvasUrl} />
        </div>
      </div>

      {list.viewMode === "table" ? (
        <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.05]">
          <div className="environment-resource-grid border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[11px] font-medium text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-faint">
            <SortHeader list={untyped} label="Resource" asc="name-asc" desc="name-desc" />
            <SortHeader list={untyped} label="Type" asc="type-asc" desc="type-desc" className="resource-type" />
            <SortHeader list={untyped} label="Status" asc="status-asc" desc="status-desc" />
            <SortHeader list={untyped} label="Domain" asc="domain-asc" desc="domain-desc" className="resource-domain" />
            <SortHeader list={untyped} label="Server" asc="server-asc" desc="server-desc" className="resource-server" />
            <div className="resource-tags">Tags</div>
          </div>

          {list.paginated.map((item) => (
            <div
              key={item.uuid}
              className="environment-resource-grid group relative min-h-14 items-center border-b border-neutral-200 px-4 py-2.5 transition-colors last:border-b-0 hover:bg-neutral-50 dark:border-white/[0.07] dark:hover:bg-white/[0.025]"
            >
              <a href={href(item)} className="absolute inset-0" aria-label={`Open ${item.name}`} />
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.035] dark:text-fg-dim">
                  <ResourceLogo item={item} />
                </div>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <a href={href(item)} className="relative block truncate text-[13px] font-semibold text-black hover:underline dark:text-fg">
                      {item.name}
                    </a>
                  </div>
                  {item.description?.trim() ? <p className="truncate text-[11px] text-neutral-500 dark:text-fg-faint">{item.description}</p> : null}
                  <div className="mobile-resource-domain min-w-0">
                    {item.fqdn ? (
                      <a href={firstDomain(item.fqdn)} target="_blank" rel="noopener noreferrer" className="relative z-10 block truncate text-[11px] text-neutral-500 hover:underline dark:text-fg-dim">
                        {displayDomain(item.fqdn)}
                      </a>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="resource-type min-w-0">
                <span className="truncate text-[12px] text-neutral-600 dark:text-fg-dim">{item.typeLabel}</span>
              </div>

              <div className="min-w-0">
                <StatusBadge item={item} />
              </div>

              <div className="resource-domain min-w-0">
                {item.fqdn ? (
                  <a href={firstDomain(item.fqdn)} target="_blank" rel="noreferrer" className="relative inline-block max-w-full truncate align-middle text-[12px] text-neutral-600 hover:underline dark:text-fg-dim">
                    {displayDomain(item.fqdn)}
                  </a>
                ) : (
                  <span className="text-[12px] text-neutral-400 dark:text-fg-faint">-</span>
                )}
              </div>

              <div className="resource-server min-w-0">
                <span className="truncate text-[12px] text-neutral-600 dark:text-fg-dim">{serverName(item)}</span>
              </div>

              <div className="resource-tags flex min-w-0 items-center gap-1 overflow-hidden">
                <span className="text-[12px] text-neutral-400 dark:text-fg-faint">-</span>
              </div>
            </div>
          ))}

          {list.filtered.length === 0 ? <NoMatching /> : null}
          <ClientPagination list={untyped} />
        </div>
      ) : (
        <div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {list.paginated.map((item) => (
              <article
                key={item.uuid}
                className="group relative flex min-h-28 flex-col rounded-xl border border-neutral-200 bg-white p-3 shadow-sm transition-all hover:-translate-y-px hover:border-neutral-300 hover:shadow-md dark:border-white/[0.08] dark:bg-white/[0.05] dark:hover:border-white/[0.14]"
              >
                <a href={href(item)} className="absolute inset-0 rounded-xl" aria-label={`Open ${item.name}`} />
                <div className="flex items-start gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-fg-dim">
                    <ResourceLogo item={item} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <h2 className="truncate text-[13px]! leading-4! font-semibold! text-black dark:text-fg">{item.name}</h2>
                    </div>
                    <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-fg-faint">{item.typeLabel}</p>
                  </div>
                  <StatusBadge item={item} />
                </div>
                <div className="mt-auto flex min-w-0 flex-col gap-0.5 pt-4">
                  <p className="min-h-4 truncate text-[11px] text-neutral-500 dark:text-fg-faint">{item.description ? <span>{item.description}</span> : null}</p>
                  {item.fqdn ? (
                    <a
                      href={firstDomain(item.fqdn)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="relative z-10 max-w-full self-start truncate text-[11px] text-neutral-500 hover:underline dark:text-fg-dim"
                      title={displayDomain(item.fqdn)}
                    >
                      {displayDomain(item.fqdn)}
                    </a>
                  ) : null}
                </div>
              </article>
            ))}
          </div>

          {list.filtered.length === 0 ? <NoMatching className="rounded-xl border border-neutral-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.05]" /> : null}
          <ClientPagination list={untyped} className="mt-3 rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.05]" />
        </div>
      )}
    </>
  );
}

function EnvironmentResourcesContent() {
  const { me } = useSignedIn();
  const projectUuid = projectUuidFromPath();
  const environmentUuid = environmentUuidFromPath();
  const base = `${projectsApi(me.team?.id)}/${encodeURIComponent(projectUuid)}/environments/${encodeURIComponent(environmentUuid)}`;
  const [data, setData] = useState<EnvironmentShowData | null>(null);
  const [resources, setResources] = useState<ResourceItem[] | null>(null);
  const list = useListState({
    items: resources ?? [],
    page: "environment",
    pageSizeKey: "freeploy.page-size.environment-resources",
    defaultSort: "name-asc",
    sortValues: SORT_VALUES,
    fallbackColumn: "name",
    defaultView: "table",
  });

  useEffect(() => {
    void (async () => {
      const [r, listed] = await Promise.all([getJson<EnvironmentShowData>(base), getJson<{ resources: ResourceItem[] }>(`${base}/resources`)]);
      if (!r.data) {
        if (r.status === 404) window.location.replace("/projects");
        return;
      }
      setData(r.data);
      setResources(listed.data?.resources ?? []);
    })();
  }, [base]);
  useEffect(() => {
    if (data) document.title = `${limit(data.environment.name, 10)} > Resources | Freeploy`;
  }, [data]);

  if (!data || !resources) return null;
  const { project, environment, canUpdate } = data;
  const here = environmentPath(project.uuid, environment.uuid);
  const count = environment.resourceCount;

  return (
    <div>
      <ProjectBreadcrumb orgId={me.team?.id} project={project} environment={environment} />
      <div className="w-full">
        <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <h1 className="truncate text-[24px]! leading-7! font-semibold! tracking-tight!">{environment.name}</h1>
              {canUpdate ? (
                <a
                  href={`${here}/edit`}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-black dark:text-fg-faint dark:hover:bg-white/[0.06] dark:hover:text-fg"
                  title="Environment settings"
                  aria-label={`Open settings for ${environment.name}`}
                >
                  <Reicon name="settings" className="size-4" />
                </a>
              ) : null}
            </div>
            <p className="mt-1 text-[13px] text-neutral-500 dark:text-fg-dim">
              <span>{`${count} ${count === 1 ? "resource" : "resources"}`}</span> in{" "}
              <a
                href={projectPath(project.uuid)}
                className="font-medium text-neutral-700 underline-offset-2 hover:text-black hover:underline dark:text-fg dark:hover:text-white"
                title={`Show all environments in ${project.name}`}
              >
                {project.name}
              </a>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            {environment.isEmpty ? <CanvasViewToggle canvasUrl={`${here}/canvas`} /> : null}
            <a
              href={`/shared-variables/environments/project/${project.uuid}/environment/${environment.uuid}`}
              className="button whitespace-nowrap"
              title="Shared variables for this environment"
              aria-label={`Shared variables for ${environment.name}`}
            >
              <Reicon name="variables" className="size-3.5" />
              Shared variables
            </a>
            {canUpdate ? (
              <a href={`${here}/new`} className="button whitespace-nowrap button-highlighted">
                <Reicon name="plus" className="size-3.5" />
                New resource
              </a>
            ) : null}
          </div>
        </header>

        {environment.isEmpty ? (
          <Empty title="No resources yet" description="Add an application, database, or service to this environment." iconName="layers">
            {canUpdate ? (
              <a href={`${here}/new`} className="button">
                <Reicon name="plus" className="size-3.5" />
                Add resource
              </a>
            ) : null}
          </Empty>
        ) : (
          <ResourceList list={list} href={(item) => (item.type === "database" ? databasePath : item.type === "service" ? servicePath : applicationPath)(project.uuid, environment.uuid, item.uuid)} canvasUrl={`${here}/canvas`} />
        )}
      </div>
    </div>
  );
}

export function EnvironmentResourcesPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Resources">
      <EnvironmentResourcesContent />
    </Layout>
  );
}
