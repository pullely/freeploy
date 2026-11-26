// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/tags/show.blade.php,
// resources/views/livewire/tags/partials/new-tag-form.blade.php, app/Livewire/Tags/Show.php and
// app/Livewire/Concerns/CreatesTags.php (Apache-2.0), modified.
//
// /tags/{tagName?} (tags.show, DP-97): without a name, the team's tags — search, sorts, a grid or a table, pages,
// "New tag"; with one, the tag's deploy webhook, its applications and services, its queued and running
// deployments, "Delete" and "Redeploy all" (which needs the SSH executor once the tag has resources).
// Not ported: "Connect to resources" (a resource's own Tags page attaches it) and "Connect in canvas" (the tags
// canvas, /canvas/tags, is DP-98's; this page does not link to it yet), and the canvas view Coolify opens instead
// of the list when it was the last one chosen.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { edgeBase, getJson } from "../lib/api";
import { Reicon } from "../components/Reicon";
import { Empty, FormInput, ModalConfirmation, ModalInput, SettingsSection, StatusBadge } from "../components/Coolify";
import { deploymentStatusLabel, filterTags, pageOfTags, plural, sortDeployments, TAG_SORT_OPTIONS, type ActiveDeployment, type DeploymentSort, type TagSort, type TagSummary } from "../lib/tags";
import { sendJson, showError, showSaved } from "./ApplicationResource";
import { CopyInput } from "./ApplicationWebhooks";

interface Resource {
  uuid: string;
  name: string;
  description: string | null;
  projectName: string;
  environmentName: string;
  link: string;
}

interface IndexData {
  tags: TagSummary[];
  canCreate: boolean;
}

interface TagData {
  tags: TagSummary[];
  tag: { id: string; name: string };
  webhookPath: string;
  applications: Resource[];
  services: Resource[];
  deployments: ActiveDeployment[];
  canDelete: boolean;
}

const tagsApi = (orgId: string | undefined) => `/v1/organizations/${orgId ?? ""}/deploy/tags`;

/** The tag's name from /tags/{tagName}. */
export const tagNameFromPath = (pathname = window.location.pathname): string => {
  const segment = pathname.split("/")[2] ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

const CARD = "rounded-xl border border-neutral-200 bg-white p-3 dark:border-white/[0.08] dark:bg-white/[0.05]";
const TAG_ICON = "flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-fg-dim";

/** partials/new-tag-form.blade.php: CreatesTags::createTag(), then the new tag's page. */
export function NewTagForm({ orgId }: { orgId: string | undefined }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = await sendJson<{ name: string }>("POST", tagsApi(orgId), { newTagName: name });
    if (!r.ok) {
      setError(r.error.fields.newTagName?.[0]);
      if (!r.error.messages.length) showError(r.error);
      return;
    }
    window.location.assign(`/tags/${encodeURIComponent(r.data.name)}`);
  }
  return (
    <form className="flex w-full flex-col gap-4" onSubmit={(e) => void submit(e)}>
      <FormInput id="newTagName" label="Name" placeholder="production" required value={name} onChange={setName} error={error} helper="Lowercase, without spaces." />
      <div className="flex justify-end border-t border-neutral-200 pt-4 dark:border-white/[0.07]">
        <button type="submit" className="button button-highlighted">
          Create tag
        </button>
      </div>
    </form>
  );
}

function Header({ subtitle, canCreate, orgId, hiddenOnDesktop }: { subtitle: string; canCreate: boolean; orgId: string | undefined; hiddenOnDesktop?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <header className={`mb-5 flex items-start justify-between gap-4${hiddenOnDesktop ? " lg:hidden" : ""}`}>
      <div className="min-w-0">
        <h1 className="truncate text-[24px]! leading-7! font-semibold! tracking-tight!">Tags</h1>
        <p className="mt-1 text-[13px] text-neutral-500 dark:text-fg-dim">{subtitle}</p>
      </div>
      {canCreate ? (
        <div className="flex shrink-0 items-center gap-2">
          <ModalInput
            title="New tag"
            open={open}
            onOpenChange={setOpen}
            trigger={
              <button type="button" className="button button-highlighted whitespace-nowrap">
                <Reicon name="plus" className="size-3.5" />
                New tag
              </button>
            }
          >
            <NewTagForm orgId={orgId} />
          </ModalInput>
        </div>
      ) : null}
    </header>
  );
}

/** <x-table.sort-header>: the first click sorts by `first`, the next one the other way. */
function SortHeader({ label, asc, desc, first = "asc", current, onSort }: { label: string; asc: string; desc: string; first?: "asc" | "desc"; current: string | null; onSort: (sort: string) => void }) {
  const active = current === asc || current === desc;
  const next = current === asc ? desc : current === desc ? asc : first === "desc" ? desc : asc;
  return (
    <button type="button" className={`inline-flex items-center gap-1 text-left ${active ? "text-black dark:text-fg" : ""}`} onClick={() => onSort(next)}>
      {label}
      {active ? <Reicon name="chevron-down" className={`size-3 ${current === asc ? "rotate-180" : ""}`} /> : null}
    </button>
  );
}

/** tagsIndex(): the list without a tag. */
function TagsIndex({ data, orgId }: { data: IndexData; orgId: string | undefined }) {
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<TagSort>("name-asc");
  const [viewMode, setViewMode] = useState<"grid" | "table">(() => {
    try {
      return window.localStorage.getItem("freeploy.list-view.tags") === "table" ? "table" : "grid";
    } catch {
      return "grid";
    }
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const filtered = filterTags(data.tags, search, sortBy);
  const paged = pageOfTags(filtered, page, pageSize);
  const count = data.tags.length;
  const subtitle = count === 0 ? "Group applications and services for bulk deploys" : `${count} ${plural("tag", count)} for bulk deploys and grouping`;
  const switchView = (mode: "grid" | "table") => {
    setViewMode(mode);
    setPage(1);
    try {
      window.localStorage.setItem("freeploy.list-view.tags", mode);
    } catch {
      // The choice is only remembered where storage is available.
    }
  };
  const href = (tag: TagSummary) => `/tags/${encodeURIComponent(tag.name)}`;
  const resources = (n: number) => `${n} ${n === 1 ? "resource" : "resources"}`;

  return (
    <div className="application-settings-form w-full">
      <Header subtitle={subtitle} canCreate={data.canCreate} orgId={orgId} />
      {count === 0 ? (
        <Empty title="No tags yet" description="Create a tag, then connect it to resources to group related deployments." iconName="tags" />
      ) : (
        <div className="w-full">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-sm">
              <Reicon name="search" className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
              <input
                type="search"
                placeholder="Search tags"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                className="input h-8! w-full rounded-lg! py-0! pr-8! pl-8! text-[12px]!"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {viewMode === "grid" ? (
                <select className="input h-8! w-44! text-[12px]!" aria-label="Sort" value={sortBy} onChange={(e) => (setSortBy(e.target.value as TagSort), setPage(1))}>
                  {TAG_SORT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : null}
              <div className="inline-flex items-center gap-0.5 rounded-lg bg-neutral-100 p-1 dark:bg-white/[0.04]">
                {(["grid", "table"] as const).map((mode) => (
                  <button key={mode} type="button" aria-pressed={viewMode === mode} title={mode === "grid" ? "Grid view" : "List view"} className={`rounded-md px-2 py-1 text-[12px] ${viewMode === mode ? "bg-white shadow-sm dark:bg-white/[0.08]" : ""}`} onClick={() => switchView(mode)}>
                    <Reicon name={mode === "grid" ? "grid" : "unordered-list"} className="size-3.5" />
                  </button>
                ))}
              </div>
            </div>
          </div>

          {viewMode === "grid" ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {paged.items.map((tag) => (
                <article key={tag.id} className="group relative flex min-h-28 flex-col rounded-xl border border-neutral-200 bg-white p-3 shadow-sm transition-all hover:-translate-y-px hover:border-neutral-300 hover:shadow-md dark:border-white/[0.08] dark:bg-white/[0.05] dark:hover:border-white/[0.14]">
                  <a href={href(tag)} className="absolute inset-0 rounded-xl" aria-label={`Open ${tag.name}`} />
                  <div className="flex items-start gap-3">
                    <div className={TAG_ICON}>
                      <Reicon name="tags" className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-[13px]! leading-4! font-semibold! text-black dark:text-fg">{tag.name}</h2>
                      <p className="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-fg-faint">Team tag</p>
                    </div>
                  </div>
                  <div className="mt-auto flex items-center pt-4">
                    <span className="text-[11px] text-neutral-500 dark:text-fg-dim">{resources(tag.resourceCount)}</span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.05]">
              <div className="grid grid-cols-[minmax(0,1fr)_7rem_7rem_7rem] border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[11px] font-medium text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-faint">
                <SortHeader label="Tag" asc="name-asc" desc="name-desc" current={sortBy} onSort={(s) => (setSortBy(s as TagSort), setPage(1))} />
                <SortHeader label="Resources" asc="resources-asc" desc="resources-desc" first="desc" current={sortBy} onSort={(s) => (setSortBy(s as TagSort), setPage(1))} />
                <SortHeader label="Applications" asc="applications-asc" desc="applications-desc" first="desc" current={sortBy} onSort={(s) => (setSortBy(s as TagSort), setPage(1))} />
                <SortHeader label="Services" asc="services-asc" desc="services-desc" first="desc" current={sortBy} onSort={(s) => (setSortBy(s as TagSort), setPage(1))} />
              </div>
              {paged.items.map((tag) => (
                <a key={tag.id} href={href(tag)} aria-label={`Open ${tag.name}`} className="grid min-h-14 grid-cols-[minmax(0,1fr)_7rem_7rem_7rem] items-center border-b border-neutral-200 px-4 py-2.5 transition-colors last:border-b-0 hover:bg-neutral-50 hover:no-underline dark:border-white/[0.07] dark:hover:bg-white/[0.025]">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className={TAG_ICON}>
                      <Reicon name="tags" className="size-4" />
                    </div>
                    <span className="truncate text-[13px] font-semibold text-black dark:text-fg">{tag.name}</span>
                  </div>
                  <span className="text-[12px] text-neutral-600 dark:text-fg-dim">{tag.resourceCount}</span>
                  <span className="text-[12px] text-neutral-600 dark:text-fg-dim">{tag.applicationsCount}</span>
                  <span className="text-[12px] text-neutral-600 dark:text-fg-dim">{tag.servicesCount}</span>
                </a>
              ))}
            </div>
          )}

          {filtered.length === 0 ? (
            <div className="mt-3">
              <Empty size="sm" title="No tags found" description="Try a different search." iconName="search" />
            </div>
          ) : (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-neutral-200 bg-white px-3 py-2 text-[12px] shadow-sm dark:border-white/[0.08] dark:bg-white/[0.05]">
              <span className="text-neutral-500 dark:text-fg-dim">{`${paged.rangeStart}-${paged.rangeEnd} of ${filtered.length}`}</span>
              <div className="flex items-center gap-2">
                <select className="input h-7! w-20! text-[12px]!" aria-label="Per page" value={pageSize} onChange={(e) => (setPageSize(Number(e.target.value)), setPage(1))}>
                  {[12, 24, 48, 96].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <button type="button" className="button" disabled={paged.page <= 1} onClick={() => setPage(paged.page - 1)}>
                  Previous
                </button>
                <button type="button" className="button" disabled={paged.page >= paged.totalPages} onClick={() => setPage(paged.page + 1)}>
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResourceCards({ resources, fallback }: { resources: Resource[]; fallback: string }) {
  return (
    <>
      {resources.map((r) => (
        <a key={r.uuid} href={r.link} className="group flex min-h-24 flex-col rounded-lg border border-neutral-200 bg-neutral-50/70 p-3 transition-colors hover:border-neutral-300 hover:no-underline dark:border-white/[0.08] dark:bg-white/[0.025]">
          <div className="flex items-start gap-2.5">
            <div className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md border border-neutral-200 bg-white text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.035] dark:text-fg-dim">
              <Reicon name={fallback === "Service" ? "layers" : "browser-code"} className="size-3.5" />
            </div>
            <div className="min-w-0">
              <h3 className="truncate text-[12px]! leading-4! font-semibold! text-black dark:text-fg">{r.name}</h3>
              <p className="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-fg-faint">
                {r.projectName}/{r.environmentName}
              </p>
            </div>
          </div>
          <p className="mt-auto truncate pt-3 text-[11px] text-neutral-500 dark:text-fg-dim">{r.description || fallback}</p>
        </a>
      ))}
    </>
  );
}

/** Show with a tag. */
function TagShow({ data, orgId, reload }: { data: TagData; orgId: string | undefined; reload: () => void }) {
  const [sort, setSort] = useState<DeploymentSort | null>(null);
  const resourceCount = data.applications.length + data.services.length;
  const base = `${tagsApi(orgId)}/${encodeURIComponent(data.tag.name)}`;
  const deployments = sortDeployments(data.deployments, sort);

  /** Show::deleteTag(): then the list. */
  async function remove() {
    const r = await sendJson<{ deleted: true }>("DELETE", base);
    if (!r.ok) return showError(r.error);
    window.location.assign("/tags");
  }
  /** Show::redeployAll() */
  async function redeploy() {
    const r = await sendJson<{ message: string }>("POST", `${base}/redeploy`);
    if (!r.ok) return showError(r.error);
    showSaved(r.data);
    reload();
  }

  const stat = (label: string, value: number, note: string) => (
    <div className={CARD}>
      <p className="text-[11px] font-medium text-neutral-500 dark:text-fg-faint">{label}</p>
      <p className="mt-1 text-[20px] font-semibold tracking-tight text-black dark:text-fg">{value}</p>
      <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-fg-dim">{note}</p>
    </div>
  );
  const confirmation = "Please confirm the execution of the actions by entering the Tag Name below";

  return (
    <div className="application-settings-form w-full">
      <Header subtitle="Manage webhook deploys and resources for this tag" canCreate={false} orgId={orgId} hiddenOnDesktop />
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {stat("Resources", resourceCount, "Applications & services")}
          {stat("Applications", data.applications.length, "Using this tag")}
          {stat("Active deployments", data.deployments.length, "Queued or running")}
        </div>

        <SettingsSection
          title={data.tag.name}
          helper="Use this webhook to deploy every resource with this tag."
          actions={
            <>
              {data.canDelete ? (
                <ModalConfirmation
                  title="Delete this tag?"
                  buttonTitle="Delete"
                  actions={["The tag will be removed from every resource.", "The deploy webhook of this tag will stop working."]}
                  confirmationText={data.tag.name}
                  confirmationLabel={confirmation}
                  shortConfirmationLabel="Tag Name"
                  step2ButtonText="Delete tag"
                  onSubmit={remove}
                />
              ) : null}
              <ModalConfirmation
                title="Redeploy all resources with this tag?"
                buttonTitle="Redeploy all"
                trigger={
                  <button type="button" className="button">
                    Redeploy all
                  </button>
                }
                actions={["All resources with this tag will be redeployed.", "During redeploy resources will be temporarily unavailable."]}
                confirmationText={data.tag.name}
                confirmationLabel={confirmation}
                shortConfirmationLabel="Tag Name"
                step2ButtonText="Redeploy All"
                onSubmit={redeploy}
              />
            </>
          }
        >
          <CopyInput label="Deploy webhook URL" text={edgeBase() + data.webhookPath} />
        </SettingsSection>

        <SettingsSection title="Resources" helper={`${resourceCount} ${plural("resource", resourceCount)} use this tag.`}>
          {resourceCount === 0 ? (
            <Empty title="No resources use this tag" description="Connect this tag to resources to see them here." iconName="tags" size="sm" />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <ResourceCards resources={data.applications} fallback="Application" />
              <ResourceCards resources={data.services} fallback="Service" />
            </div>
          )}
        </SettingsSection>

        <SettingsSection title="Active deployments" helper="Queued and running deployments for applications using this tag." flush>
          <div className="overflow-x-auto">
            {data.deployments.length === 0 ? (
              <div className="p-3">
                <Empty title="No active deployments" description="Deployments will appear here while they are queued or running." iconName="play-circle" size="sm" />
              </div>
            ) : (
              <>
                <div className="grid min-w-[620px] grid-cols-[minmax(0,1fr)_minmax(10rem,.55fr)_7rem] border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[11px] font-medium text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-faint">
                  <SortHeader label="Resource" asc="resource-asc" desc="resource-desc" current={sort} onSort={(s) => setSort(s as DeploymentSort)} />
                  <SortHeader label="Server" asc="server-asc" desc="server-desc" current={sort} onSort={(s) => setSort(s as DeploymentSort)} />
                  <SortHeader label="Status" asc="status-asc" desc="status-desc" current={sort} onSort={(s) => setSort(s as DeploymentSort)} />
                </div>
                {deployments.map((d) => (
                  <a key={d.id} href={d.deploymentUrl ?? undefined} className="grid min-h-13 min-w-[620px] grid-cols-[minmax(0,1fr)_minmax(10rem,.55fr)_7rem] items-center border-b border-neutral-200 px-4 py-2.5 text-[12px] transition-colors last:border-b-0 hover:bg-neutral-50 hover:no-underline dark:border-white/[0.07] dark:hover:bg-white/[0.025]">
                    <div className="truncate font-medium text-black dark:text-fg">{d.applicationName}</div>
                    <div className="truncate text-neutral-500 dark:text-fg-dim">{d.serverName}</div>
                    <div>
                      <StatusBadge label={deploymentStatusLabel(d.status)} type={d.status === "in_progress" ? "warning" : "neutral"} />
                    </div>
                  </a>
                ))}
              </>
            )}
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}

function TagsContent() {
  const { me } = useSignedIn();
  const name = tagNameFromPath();
  const path = name ? `${tagsApi(me.team?.id)}/${encodeURIComponent(name)}` : tagsApi(me.team?.id);
  const [index, setIndex] = useState<IndexData | null>(null);
  const [tag, setTag] = useState<TagData | null>(null);
  const load = useCallback(async () => {
    if (name) {
      const r = await getJson<TagData>(path);
      // Show::mount(): a name the team has no tag of goes back to the list.
      if (!r.data) {
        if (r.status === 404) window.location.replace("/tags");
        return;
      }
      setTag(r.data);
    } else {
      const r = await getJson<IndexData>(path);
      if (r.data) setIndex(r.data);
    }
  }, [name, path]);
  useEffect(() => {
    void load();
  }, [load]);
  // wire:poll="getDeployments": the active deployments, every two seconds while any is queued or running.
  useEffect(() => {
    if (!tag || tag.deployments.length === 0) return;
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [tag, load]);
  if (name) return tag ? <TagShow data={tag} orgId={me.team?.id} reload={() => void load()} /> : null;
  return index ? <TagsIndex data={index} orgId={me.team?.id} /> : null;
}

export function TagsPage() {
  return (
    <Layout title="Tags" href="/tags" navHref="/tags" documentTitle="Tags">
      <TagsContent />
    </Layout>
  );
}
