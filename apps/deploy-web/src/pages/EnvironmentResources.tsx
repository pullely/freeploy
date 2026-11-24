// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/resource/index.blade.php
// and app/Livewire/Project/Resource/Index.php (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}: the environment's header and its
// "No resources yet" state. No resource type is ported yet, so the list of
// resources (with its search, filters and views) is not here; "New resource",
// "Shared variables" and the canvas lead to pages that are not ported yet.
import { useEffect, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson } from "../lib/api";
import { Reicon } from "../components/Reicon";
import { Empty } from "../components/Coolify";
import { CanvasViewToggle } from "../components/CoolifyList";
import { environmentPath, environmentUuidFromPath, limit, ProjectBreadcrumb, projectPath, projectsApi, projectUuidFromPath, type EnvironmentShowData } from "./ProjectChrome";

function EnvironmentResourcesContent() {
  const { me } = useSignedIn();
  const projectUuid = projectUuidFromPath();
  const environmentUuid = environmentUuidFromPath();
  const base = `${projectsApi(me.team?.id)}/${encodeURIComponent(projectUuid)}/environments/${encodeURIComponent(environmentUuid)}`;
  const [data, setData] = useState<EnvironmentShowData | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await getJson<EnvironmentShowData>(base);
      if (!r.data) {
        if (r.status === 404) window.location.replace("/projects");
        return;
      }
      setData(r.data);
    })();
  }, [base]);
  useEffect(() => {
    if (data) document.title = `${limit(data.environment.name, 10)} > Resources | Freeploy`;
  }, [data]);

  if (!data) return null;
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
          // Freeploy's: resources cannot be created yet, so this only shows for rows written another way.
          <div data-freeploy-not-ported="">
            <div className="empty-state w-full">
              <div className="empty-state-well min-h-32">
                <h2 className="empty-state-title">The list of resources is not available in Freeploy yet</h2>
                <p className="empty-state-description text-[12px]">It is being ported.</p>
              </div>
            </div>
          </div>
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
