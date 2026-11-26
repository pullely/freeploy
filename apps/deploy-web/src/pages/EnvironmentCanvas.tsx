// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/environment-canvas.blade.php,
// resources/views/components/canvas-view-toggle.blade.php and app/Livewire/Project/EnvironmentCanvas.php
// (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/canvas (project.environment.canvas, DP-91): the
// full-bleed page that holds the environment canvas (components/canvas/environment), with the
// page's views moved into its toolbar: "List view" back to the resources, Shared variables,
// Settings (@can('update')) and New resource (@can('createAnyResource')), which opens the deploy
// canvas (/canvas?project=…&environment=…, DP-94) as Coolify's does.
// The view is not remembered in a cookie (RemembersCanvasView): the list page stays the default.
import { useEffect, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson } from "../lib/api";
import { Reicon } from "../components/Reicon";
import { EnvironmentCanvas } from "../components/canvas/environment/EnvironmentCanvas";
import { environmentPath, environmentUuidFromPath, projectsApi, projectUuidFromPath, type EnvironmentShowData } from "./ProjectChrome";

const VIEW_ITEM = "relative flex h-7.5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[12px] font-medium transition-colors";
const VIEW_IDLE = "text-neutral-400 hover:bg-neutral-100 hover:text-black dark:hover:text-white";

/** EnvironmentCanvas.svelte's viewOnlyTitle for those who may not edit the environment (deploy.resource.write). */
export const ENVIRONMENT_CANVAS_VIEW_ONLY = "You can look around. Only team admins can move cards and edit links.";

function EnvironmentCanvasContent() {
  const { me } = useSignedIn();
  const projectUuid = projectUuidFromPath();
  const environmentUuid = environmentUuidFromPath();
  const base = `${projectsApi(me.team?.id)}/${encodeURIComponent(projectUuid)}/environments/${encodeURIComponent(environmentUuid)}`;
  const [data, setData] = useState<EnvironmentShowData | null>(null);
  useEffect(() => {
    void getJson<EnvironmentShowData>(base).then((r) => {
      if (r.data) setData(r.data);
      else if (r.status === 404) window.location.replace("/projects");
    });
  }, [base]);
  useEffect(() => {
    if (data) document.title = `${data.environment.name} > Canvas | Freeploy`;
  }, [data]);
  if (!data) return null;
  const { project, environment, canUpdate } = data;
  const here = environmentPath(project.uuid, environment.uuid);
  // route('deploy-canvas', ['project' => …, 'environment' => …])
  const deployCanvas = `/canvas?${new URLSearchParams({ project: project.uuid, environment: environment.uuid }).toString()}`;
  // The canvas moves this group into its toolbar; the page actions come last, at the right end.
  const views = (
    <div data-ec-views="" className="flex items-center gap-2 max-lg:flex-wrap">
      {/* <x-canvas-view-toggle on-canvas>: on the canvas only the way back, one labelled link to the list. */}
      <div className="view-toggle">
        <a href={`${here}?view=table`} className={`${VIEW_ITEM} ${VIEW_IDLE}`} title="List view">
          <Reicon name="unordered-list" className="size-3.5" />
          List view
        </a>
      </div>
      <a href={`/shared-variables/environments/project/${project.uuid}/environment/${environment.uuid}`} className="button whitespace-nowrap" title="Shared variables for this environment" aria-label={`Shared variables for ${environment.name}`}>
        <Reicon name="variables" className="size-3.5" />
        Shared variables
      </a>
      {canUpdate ? (
        <a href={`${here}/edit`} className="button whitespace-nowrap" title="Environment settings" aria-label={`Open settings for ${environment.name}`}>
          <Reicon name="settings" className="size-3.5" />
          Settings
        </a>
      ) : null}
      {canUpdate ? (
        <a href={deployCanvas} className="button button-highlighted whitespace-nowrap">
          <Reicon name="plus" className="size-3.5" />
          New resource
        </a>
      ) : null}
    </div>
  );
  return (
    <div className="h-full">
      <div data-environment-canvas="" data-project={project.uuid} data-environment={environment.uuid} data-team={me.team?.id ?? ""} className="relative h-full">
        <EnvironmentCanvas endpoint={`${base}/canvas`} team={me.team?.id ?? ""} views={views} viewOnlyTitle={ENVIRONMENT_CANVAS_VIEW_ONLY} newHref={canUpdate ? deployCanvas : null} />
      </div>
    </div>
  );
}

export function EnvironmentCanvasPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Canvas" fullBleed>
      <EnvironmentCanvasContent />
    </Layout>
  );
}
