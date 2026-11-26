// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/show.blade.php,
// resources/views/livewire/project/partials/new-environment-form.blade.php,
// app/Livewire/Project/Show.php and app/Livewire/Concerns/CreatesEnvironments.php (Apache-2.0), modified.
//
// /project/{uuid}: the project's environments as a grid or a table, with
// search, sort and paging, and the "New Environment" dialog. The Canvas link
// opens the project's canvas (DP-98).
import { useEffect, useState, type FormEvent } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Empty, FormInput, ModalInput } from "../components/Coolify";
import { CanvasViewToggle, ClientPagination, ListSearch, NoMatches, SortDropdown, SortHeader, useListState } from "../components/CoolifyList";
import { environmentPath, limit, ProjectBreadcrumb, projectPath, projectsApi, projectUuidFromPath, type EnvironmentItem, type ProjectShowData } from "./ProjectChrome";

const SORT_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "name-asc", label: "Name A–Z" },
  { value: "name-desc", label: "Name Z–A" },
  { value: "resources-desc", label: "Most resources" },
];

// "default" has no sort value: the server's order (production, staging, development, then by name).
const SORT_VALUES: Record<string, (environment: EnvironmentItem) => string | number> = {
  name: (environment) => environment.name,
  resources: (environment) => Number(environment.resourceCount),
  description: (environment) => environment.description || "",
};

/** The icon links' classes; `size` is "size-7", "size-7.5" or "size-7 shrink-0". */
const iconLink = (size: string) =>
  `flex ${size} items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-black dark:text-fg-faint dark:hover:bg-white/[0.06] dark:hover:text-fg`;

/** partials/new-environment-form.blade.php with CreatesEnvironments::submit(): the new environment opens. */
export function NewEnvironmentForm({ base, projectUuid }: { base: string; projectUuid: string }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = await postJson<{ uuid: string }>(`${base}/environments`, { name });
    if (!r.ok) {
      const inline = r.error.fields?.name?.[0];
      setError(inline);
      if (!inline) notify.error(summarize(r.error.messages));
      return;
    }
    window.location.assign(environmentPath(projectUuid, r.data.uuid));
  }

  return (
    <form className="space-y-4" onSubmit={(e) => void submit(e)}>
      <FormInput placeholder="staging" id="name" label="Name" required value={name} onChange={setName} error={error} />

      <footer className="flex justify-end border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
        <button type="submit" className="button button-highlighted">
          Create environment
        </button>
      </footer>
    </form>
  );
}

function ProjectShowContent() {
  const { me } = useSignedIn();
  const uuid = projectUuidFromPath();
  const base = `${projectsApi(me.team?.id)}/${encodeURIComponent(uuid)}`;
  const [data, setData] = useState<ProjectShowData | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const list = useListState({ items: data?.environments ?? [], page: "project", pageSizeKey: "freeploy.page-size.project-environments", defaultSort: "default", sortValues: SORT_VALUES });

  useEffect(() => {
    void (async () => {
      const r = await getJson<ProjectShowData>(base);
      if (!r.data) {
        if (r.status === 404) window.location.replace("/projects");
        return;
      }
      setData(r.data);
    })();
  }, [base]);
  useEffect(() => {
    if (data) document.title = `${limit(data.project.name, 10)} > Environments | Freeploy`;
  }, [data]);

  if (!data) return null;
  const { project, environments, canUpdate } = data;
  const href = (environment: EnvironmentItem) => environmentPath(project.uuid, environment.uuid);
  const settingsHref = (environment: EnvironmentItem) => (canUpdate ? `${href(environment)}/edit` : null);
  const addResourceHref = (environment: EnvironmentItem) => (canUpdate ? `${href(environment)}/new` : null);

  return (
    <div>
      <ProjectBreadcrumb orgId={me.team?.id} project={project} />
      <div className="w-full">
        <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <h1 className="truncate text-[24px]! leading-7! font-semibold! tracking-tight!">{project.name}</h1>
              {canUpdate ? (
                <a href={`${projectPath(project.uuid)}/edit`} className={iconLink("size-7 shrink-0")} title="Project settings" aria-label={`Open settings for ${project.name}`}>
                  <Reicon name="settings" className="size-4" />
                </a>
              ) : null}
            </div>
            <p className="mt-1 text-[13px] text-neutral-500 dark:text-fg-dim">
              <span>{`${environments.length} ${environments.length === 1 ? "environment" : "environments"}`}</span> in this project
            </p>
          </div>

          {canUpdate ? (
            <div className="flex w-fit shrink-0 items-center gap-2">
              <ModalInput
                title="New Environment"
                open={addOpen}
                onOpenChange={setAddOpen}
                trigger={
                  <button type="button" className="button button-highlighted">
                    <Reicon name="plus" className="size-3.5" />
                    New environment
                  </button>
                }
              >
                <NewEnvironmentForm base={base} projectUuid={project.uuid} />
              </ModalInput>
            </div>
          ) : null}
        </header>

        {environments.length === 0 ? (
          <Empty title="No environments yet" description="Add an environment to start organizing this project's resources." iconName="layers" />
        ) : (
          <>
            <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <ListSearch list={list} placeholder="Search environments" />

              <div className="flex flex-wrap items-center gap-2">
                <SortDropdown list={list} options={SORT_OPTIONS} panelClass="w-48!" />

                <CanvasViewToggle list={list} canvasUrl={`${projectPath(project.uuid)}/canvas`} />
              </div>
            </div>

            <div style={list.viewMode === "grid" ? undefined : { display: "none" }}>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {list.paginated.map((environment) => (
                  <article
                    key={environment.uuid}
                    className="group relative flex min-h-28 flex-col rounded-xl border border-neutral-200 bg-white p-3 shadow-sm transition-all hover:-translate-y-px hover:border-neutral-300 hover:shadow-md dark:border-white/[0.08] dark:bg-white/[0.05] dark:hover:border-white/[0.14]"
                  >
                    <a href={href(environment)} className="absolute inset-0 rounded-xl" aria-label={`Open ${environment.name}`} />

                    <div className="flex items-start gap-3">
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-fg-dim">
                        <Reicon name="layers" className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h2 className="truncate text-[13px]! leading-4! font-semibold! text-black dark:text-fg">{environment.name}</h2>
                        <p className="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-fg-faint">{environment.description || "Environment"}</p>
                      </div>
                    </div>

                    <div className="mt-auto flex items-center justify-between gap-3 pt-4">
                      <p className="min-w-0 truncate text-[11px] text-neutral-500 dark:text-fg-dim">{`${environment.resourceCount} ${environment.resourceCount === 1 ? "resource" : "resources"}`}</p>

                      <div className="relative z-10 flex shrink-0 items-center gap-0.5">
                        {addResourceHref(environment) ? (
                          <a href={addResourceHref(environment)!} className={iconLink("size-7.5")} title="Add resource" aria-label={`Add resource to ${environment.name}`}>
                            <Reicon name="plus" className="size-3" />
                          </a>
                        ) : null}
                        {settingsHref(environment) ? (
                          <a href={settingsHref(environment)!} className={iconLink("size-7.5")} title="Environment settings" aria-label={`Open settings for ${environment.name}`}>
                            <Reicon name="settings" className="size-3" />
                          </a>
                        ) : null}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
              <ClientPagination list={list} className="mt-3 rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.05]" />
            </div>

            <div
              style={list.viewMode === "table" ? undefined : { display: "none" }}
              className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.05]"
            >
              <div className="environments-table-grid border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[11px] font-medium text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-faint">
                <SortHeader list={list} label="Environment" asc="name-asc" desc="name-desc" />
                <SortHeader list={list} label="Resources" asc="resources-asc" desc="resources-desc" first="desc" className="environment-resource-count" />
                <SortHeader list={list} label="Description" asc="description-asc" desc="description-desc" className="environment-description" />
                <span className="text-right">Actions</span>
              </div>

              {list.paginated.map((environment) => (
                <div
                  key={environment.uuid}
                  className="environments-table-grid group relative min-h-14 items-center border-b border-neutral-200 px-4 py-2.5 transition-colors last:border-b-0 hover:bg-neutral-50 dark:border-white/[0.07] dark:hover:bg-white/[0.025]"
                >
                  <a href={href(environment)} className="absolute inset-0" aria-label={`Open ${environment.name}`} />
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.035] dark:text-fg-dim">
                      <Reicon name="layers" className="size-4" />
                    </div>
                    <a href={href(environment)} className="relative truncate text-[13px] font-semibold text-black hover:underline dark:text-fg">
                      {environment.name}
                    </a>
                  </div>

                  <div className="environment-resource-count text-[12px] text-neutral-600 dark:text-fg-dim">{environment.resourceCount}</div>
                  <p className="environment-description truncate text-[12px] text-neutral-500 dark:text-fg-dim">{environment.description || "-"}</p>

                  <div className="relative flex items-center justify-end gap-0.5">
                    {addResourceHref(environment) ? (
                      <a href={addResourceHref(environment)!} className={iconLink("size-7")} title="Add resource" aria-label={`Add resource to ${environment.name}`}>
                        <Reicon name="plus" className="size-3.5" />
                      </a>
                    ) : null}
                    {settingsHref(environment) ? (
                      <a href={settingsHref(environment)!} className={iconLink("size-7")} title="Environment settings" aria-label={`Open settings for ${environment.name}`}>
                        <Reicon name="settings" className="size-3.5" />
                      </a>
                    ) : null}
                  </div>
                </div>
              ))}
              <ClientPagination list={list} />
            </div>

            <NoMatches list={list} title="No matching environments" />
          </>
        )}
      </div>
    </div>
  );
}

export function ProjectShowPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Environments">
      <ProjectShowContent />
    </Layout>
  );
}
