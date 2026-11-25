// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/{index,add-empty}.blade.php
// and app/Livewire/Project/{Index,AddEmpty}.php (Apache-2.0), modified.
//
// /projects: the org's projects as a grid or a table, with search, sort and
// paging, and the "New Project" dialog. The canvas view and project icons are
// not ported: the Canvas link leads to the not-ported notice and every project
// shows the default glyph.
import { useEffect, useState, type FormEvent } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Empty, FormInput, ModalInput } from "../components/Coolify";
import { CanvasViewToggle, ClientPagination, ListSearch, NoMatches, SortDropdown, SortHeader, useListState } from "../components/CoolifyList";
import { environmentPath, projectPath, projectsApi, type ProjectListItem } from "./ProjectChrome";

const SORT_OPTIONS = [
  { value: "name-asc", label: "Name A–Z" },
  { value: "name-desc", label: "Name Z–A" },
  { value: "resources-desc", label: "Most resources" },
  { value: "environments-desc", label: "Most environments" },
];

const SORT_VALUES: Record<string, (project: ProjectListItem) => string | number> = {
  name: (project) => project.name,
  resources: (project) => Number(project.resourceCount),
  environments: (project) => Number(project.environmentCount),
  created: (project) => Date.parse(project.createdAt) || 0,
  description: (project) => project.description || "",
};

const GLYPH = "resource-glyph flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500";
const CARD_ACTION = "card-icon-button flex size-7.5 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-black";
const ROW_ACTION =
  "flex size-7 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-black dark:text-fg-faint dark:hover:bg-white/[0.06] dark:hover:text-fg";

/** add-empty.blade.php: Livewire's AddEmpty component. The new project opens on its production environment. */
function AddEmpty({ base }: { base: string }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = await postJson<{ uuid: string; environmentUuid: string }>(base, { name, description });
    if (!r.ok) {
      const fields = r.error.fields ?? {};
      const inline: Record<string, string> = {};
      for (const f of ["name", "description"]) if (fields[f]?.[0]) inline[f] = fields[f][0];
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    window.location.assign(environmentPath(r.data.uuid, r.data.environmentUuid));
  }

  return (
    <form className="space-y-4" onSubmit={(e) => void submit(e)}>
      <div className="grid gap-4 md:grid-cols-2">
        <FormInput placeholder="Your project name" id="name" label="Name" required value={name} onChange={setName} error={errors.name} />
        <FormInput placeholder="A short project description" id="description" label="Description" value={description} onChange={setDescription} error={errors.description} />
      </div>

      <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-[12px] text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-dim">
        A production environment will be created automatically.
      </p>

      <footer className="flex justify-end border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
        <button type="submit" className="button button-highlighted">
          Create project
        </button>
      </footer>
    </form>
  );
}

function ProjectsContent() {
  const { me } = useSignedIn();
  const base = projectsApi(me.team?.id);
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const list = useListState({ items: projects ?? [], page: "projects", pageSizeKey: "freeploy.page-size.projects", defaultSort: "name-asc", sortValues: SORT_VALUES, fallbackColumn: "name" });

  useEffect(() => {
    void (async () => {
      const r = await getJson<{ projects: ProjectListItem[]; canWrite: boolean }>(base);
      if (!r.data) {
        if (r.status !== 401) notify.error("Failed to load projects.");
        setProjects([]);
        return;
      }
      setProjects(r.data.projects);
      setCanWrite(r.data.canWrite);
    })();
  }, [base]);

  /** Project::navigateTo(): a project with one environment opens that environment. */
  const href = (project: ProjectListItem) => (project.onlyEnvironmentUuid ? environmentPath(project.uuid, project.onlyEnvironmentUuid) : projectPath(project.uuid));
  const settingsHref = (project: ProjectListItem) => (canWrite ? `${projectPath(project.uuid)}/edit` : null);
  const addResourceHref = (project: ProjectListItem) => (canWrite && project.firstEnvironmentUuid ? `${environmentPath(project.uuid, project.firstEnvironmentUuid)}/new` : null);

  return (
    <div className="application-settings-form w-full">
      <div className="w-full">
        <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="min-w-0 truncate text-[24px]! leading-7! font-semibold! tracking-tight!">Projects</h1>
          {canWrite ? (
            <div className="w-fit shrink-0">
              <ModalInput
                title="New Project"
                open={addOpen}
                onOpenChange={setAddOpen}
                trigger={
                  <button type="button" className="button button-highlighted">
                    <Reicon name="plus" className="size-3.5" />
                    New project
                  </button>
                }
              >
                <AddEmpty base={base} />
              </ModalInput>
            </div>
          ) : null}
        </header>

        {projects === null ? null : projects.length === 0 ? (
          <Empty title="No projects yet" description="Create a project to organize your environments and resources." iconName="projects">
            <a className="text-[12px] font-medium text-coollabs hover:underline dark:text-brand-light" href="/onboarding">
              Open onboarding
            </a>
          </Empty>
        ) : (
          <>
            <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <ListSearch list={list} placeholder="Search projects" />

              <div className="flex flex-wrap items-center gap-2">
                <SortDropdown list={list} options={SORT_OPTIONS} panelClass="w-52!" />

                <CanvasViewToggle list={list} canvasUrl="/projects/canvas" />
              </div>
            </div>

            <div style={list.viewMode === "grid" ? undefined : { display: "none" }}>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {list.paginated.map((project) => (
                  <article
                    key={project.uuid}
                    className="group relative flex min-h-28 flex-col rounded-xl border border-neutral-200 bg-white p-3 shadow-sm transition-all hover:-translate-y-px hover:border-neutral-300 hover:shadow-md dark:border-white/[0.08] dark:bg-white/[0.05] dark:hover:border-white/[0.14]"
                  >
                    <a href={href(project)} className="absolute inset-0 rounded-xl" aria-label={`Open ${project.name}`} />
                    <div className="flex items-start gap-3">
                      <div className={GLYPH}>
                        <Reicon name="projects" className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1 self-center">
                        <h2 className="truncate text-[13px]! leading-4! font-semibold! text-black dark:text-fg">{project.name}</h2>
                        {project.description?.trim() ? <p className="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-fg-faint">{project.description}</p> : null}
                      </div>
                    </div>

                    <div className="mt-auto flex items-center justify-between gap-3 border-t border-neutral-100 pt-2.5 dark:border-white/[0.06]">
                      <p className="project-card-stats relative z-10 min-w-0">
                        <b>{project.environmentCount}</b> <span>{Number(project.environmentCount) === 1 ? "environment" : "environments"}</span>{" "}
                        <span className="project-card-stats-dot" aria-hidden="true">
                          &middot;
                        </span>{" "}
                        <b>{project.resourceCount}</b> <span>{Number(project.resourceCount) === 1 ? "resource" : "resources"}</span>
                      </p>

                      <div className="relative z-10 flex shrink-0 items-center gap-0.5">
                        {addResourceHref(project) ? (
                          <a href={addResourceHref(project)!} className={CARD_ACTION} title="Add resource" aria-label={`Add resource to ${project.name}`}>
                            <Reicon name="plus" className="size-3" />
                          </a>
                        ) : null}
                        {settingsHref(project) ? (
                          <a href={settingsHref(project)!} className={CARD_ACTION} title="Project settings" aria-label={`Open settings for ${project.name}`}>
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
              <div className="projects-table-grid border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[11px] font-medium text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-faint">
                <SortHeader list={list} label="Project" asc="name-asc" desc="name-desc" />
                <SortHeader list={list} label="Contents" asc="resources-asc" desc="resources-desc" first="desc" />
                <SortHeader list={list} label="Created" asc="created-asc" desc="created-desc" first="desc" />
                <SortHeader list={list} label="Description" asc="description-asc" desc="description-desc" className="project-description" />
                <span className="text-right">Actions</span>
              </div>

              {list.paginated.map((project) => (
                <div
                  key={project.uuid}
                  className="projects-table-grid group min-h-14 items-center border-b border-neutral-200 px-4 py-2.5 transition-colors last:border-b-0 hover:bg-neutral-50 dark:border-white/[0.07] dark:hover:bg-white/[0.025]"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className={GLYPH}>
                      <Reicon name="projects" className="size-4" />
                    </div>
                    <a href={href(project)} className="truncate text-[13px] font-semibold text-black hover:underline dark:text-fg">
                      {project.name}
                    </a>
                  </div>

                  <div className="flex items-center gap-3 text-[12px] font-medium text-neutral-600 dark:text-fg-dim">
                    <span className="inline-flex items-center gap-1" data-tooltip="Environments" aria-label="Environments">
                      <Reicon name="layers" className="size-3.5 text-neutral-400 dark:text-fg-faint" />
                      <span>{project.environmentCount}</span>
                    </span>
                    <span className="inline-flex items-center gap-1" data-tooltip="Resources" aria-label="Resources">
                      <Reicon name="grid" className="size-3.5 text-neutral-400 dark:text-fg-faint" />
                      <span>{project.resourceCount}</span>
                    </span>
                  </div>
                  <div className="truncate text-[12px] text-neutral-500 dark:text-fg-dim">{project.createdAt}</div>
                  <p className="project-description truncate text-[12px] text-neutral-500 dark:text-fg-dim">{project.description || "-"}</p>

                  <div className="flex items-center justify-end gap-0.5">
                    {addResourceHref(project) ? (
                      <a href={addResourceHref(project)!} className={ROW_ACTION} title="Add resource" aria-label={`Add resource to ${project.name}`}>
                        <Reicon name="plus" className="size-3.5" />
                      </a>
                    ) : null}
                    {settingsHref(project) ? (
                      <a href={settingsHref(project)!} className={ROW_ACTION} title="Project settings" aria-label={`Open settings for ${project.name}`}>
                        <Reicon name="settings" className="size-3.5" />
                      </a>
                    ) : null}
                  </div>
                </div>
              ))}
              <ClientPagination list={list} />
            </div>

            <NoMatches list={list} title="No matching projects" />
          </>
        )}
      </div>
    </div>
  );
}

export function ProjectsPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects">
      <ProjectsContent />
    </Layout>
  );
}
