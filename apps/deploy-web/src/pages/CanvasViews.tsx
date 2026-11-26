// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/{projects-canvas,project-canvas}.blade.php,
// resources/views/livewire/server/canvas.blade.php, resources/views/livewire/dashboard/canvas.blade.php,
// resources/views/livewire/shared-variables/canvas.blade.php, resources/views/livewire/tags/canvas.blade.php,
// resources/views/components/canvas-view-toggle.blade.php and app/Livewire/{Project/ProjectsCanvas,Project/ProjectCanvas,
// Server/Canvas,Dashboard/Canvas,SharedVariables/Canvas,Tags/Canvas}.php (Apache-2.0), modified.
//
// The canvases that reuse the environment canvas's view (DP-98), each a full-bleed page that holds
// components/canvas/environment's EnvironmentCanvas over deploy-core-worker's /canvas/api endpoints, with the
// page's views moved into its toolbar:
//
//   /projects/canvas                 project.canvas.index        List view, New project (@can('createAnyResource'))
//   /project/{uuid}/canvas           project.canvas              List view, Settings and New environment (@can('update', $project))
//   /servers/canvas                  server.canvas.index         List view, New server (@can('createAnyResource'))
//   /server/{uuid}/canvas            server.canvas               the server's navbar, List view
//   /dashboard/canvas                dashboard.canvas            List view; reloads every 5 s (data-poll)
//   /shared-variables/team/canvas, …/project/{uuid}/canvas, …/environments/project/{p}/environment/{e}/canvas,
//   …/server/{uuid}/canvas           shared-variables.*.canvas   List view, Add variable (@can('update', $owner))
//   /canvas/tags                     tags.canvas                 List view, New tag (@can('create', Tag::class))
//
// Every @can here is deploy.resource.write, which the canvas's can_edit carries, so the actions show once
// the canvas has loaded. The dialogs are the list pages' own (New Project, New Environment, New Shared
// Variable, New tag). The view is not remembered in a cookie (RemembersCanvasView): the list pages stay the
// default. A canvas whose owner is not the org's goes back to its list, as the other pages do.
import { useCallback, useState, type ReactNode } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { Reicon } from "../components/Reicon";
import { ModalInput } from "../components/Coolify";
import { EnvironmentCanvas } from "../components/canvas/environment/EnvironmentCanvas";
import type { CanvasGraph, CanvasNode } from "../lib/environment-canvas";
import { projectPath, projectsApi, projectUuidFromPath } from "./ProjectChrome";
import { AddEmpty } from "./Projects";
import { NewEnvironmentForm } from "./ProjectShow";
import { NewTagForm } from "./Tags";
import { AddVariable } from "./SharedVariablesEditor";
import { scopeHeadline, scopePath, sharedVariablesApi, type SharedVariableScope } from "./SharedVariablesChrome";
import { ServerNavbar, serverUuidFromPath, useServerPage, type ServerPageData } from "./ServerChrome";

const VIEW_ITEM = "relative flex h-7.5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[12px] font-medium transition-colors";
const VIEW_IDLE = "text-neutral-400 hover:bg-neutral-100 hover:text-black dark:hover:text-white";

/** The canvas API: Coolify's /canvas/api, which its canvases call with the browser session. */
export const canvasApiRoot = (orgId: string | undefined) => `/v1/organizations/${orgId ?? ""}/deploy/canvas/api`;
/** A card's environment canvas endpoint: the server view saves its moves and links there. */
export const environmentCanvasEndpoint = (orgId: string | undefined) => (node: CanvasNode | undefined) =>
  `${projectsApi(orgId)}/${encodeURIComponent(node?.project?.uuid ?? "")}/environments/${encodeURIComponent(node?.environment?.uuid ?? "")}/canvas`;

/** <x-canvas-view-toggle on-canvas>: on the canvas only the way back, one labelled link to the list (its first view). */
export function CanvasListLink({ listUrl, view = "table", ...rest }: { listUrl: string; view?: string; "data-ec-views"?: string }) {
  return (
    <div className="view-toggle" {...rest}>
      <a href={`${listUrl}?view=${view}`} className={`${VIEW_ITEM} ${VIEW_IDLE}`} title="List view">
        <Reicon name="unordered-list" className="size-3.5" />
        List view
      </a>
    </div>
  );
}

/** A button that opens one of the list page's dialogs (the canvas moves it into its toolbar). */
function DialogButton({ title, label, children }: { title: string; label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <ModalInput
      title={title}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button type="button" className="button button-highlighted whitespace-nowrap">
          <Reicon name="plus" className="size-3.5" />
          {label}
        </button>
      }
    >
      {children}
    </ModalInput>
  );
}

/** The loaded graph, so the page's title and its actions follow it. */
function useGraph(title: (graph: CanvasGraph) => string) {
  const [graph, setGraph] = useState<CanvasGraph | null>(null);
  const onLoad = useCallback(
    (next: CanvasGraph) => {
      setGraph(next);
      document.title = `${title(next)} > Canvas | Freeploy`;
    },
    [title],
  );
  return { graph, canEdit: !!graph?.can_edit, onLoad };
}

const goTo = (path: string) => () => window.location.replace(path);

// ── /projects/canvas ──────────────────────────────────────────────────

function ProjectsCanvasContent() {
  const { me } = useSignedIn();
  const org = me.team?.id;
  const { canEdit, onLoad } = useGraph(useCallback(() => "Projects", []));
  const views = (
    <div data-ec-views="" className="flex items-center gap-2 max-lg:flex-wrap">
      <CanvasListLink listUrl="/projects" />
      {canEdit ? (
        <DialogButton title="New Project" label="New project">
          <AddEmpty base={projectsApi(org)} />
        </DialogButton>
      ) : null}
    </div>
  );
  return (
    <div className="h-full">
      <div data-environment-canvas="" data-endpoint="/projects/canvas" data-team={org ?? ""} className="relative h-full">
        <EnvironmentCanvas
          endpoint={`${canvasApiRoot(org)}/projects/canvas`}
          apiRoot={canvasApiRoot(org)}
          serverView
          environmentEndpoint={environmentCanvasEndpoint(org)}
          team={org ?? ""}
          views={views}
          emptyText="No resources in your projects yet"
          viewOnlyTitle="Only team admins can move cards and edit links."
          onLoad={onLoad}
        />
      </div>
    </div>
  );
}

export function ProjectsCanvasPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Canvas" fullBleed>
      <ProjectsCanvasContent />
    </Layout>
  );
}

// ── /project/{uuid}/canvas ────────────────────────────────────────────

function ProjectCanvasContent() {
  const { me } = useSignedIn();
  const org = me.team?.id;
  const uuid = projectUuidFromPath();
  const { graph, canEdit, onLoad } = useGraph(useCallback((g: CanvasGraph) => g.title ?? "", []));
  const views = (
    <div data-ec-views="" className="flex items-center gap-2 max-lg:flex-wrap">
      <CanvasListLink listUrl={projectPath(uuid)} />
      {canEdit ? (
        <>
          <a href={`${projectPath(uuid)}/edit`} className="button whitespace-nowrap" title="Project settings" aria-label={`Open settings for ${graph?.title ?? ""}`}>
            <Reicon name="settings" className="size-3.5" />
            Settings
          </a>
          <DialogButton title="New Environment" label="New environment">
            <NewEnvironmentForm base={`${projectsApi(org)}/${encodeURIComponent(uuid)}`} projectUuid={uuid} />
          </DialogButton>
        </>
      ) : null}
    </div>
  );
  return (
    <div className="h-full">
      <div data-environment-canvas="" data-endpoint={`/projects/${uuid}/canvas`} data-team={org ?? ""} className="relative h-full">
        <EnvironmentCanvas
          endpoint={`${canvasApiRoot(org)}/projects/${encodeURIComponent(uuid)}/canvas`}
          apiRoot={canvasApiRoot(org)}
          serverView
          environmentEndpoint={environmentCanvasEndpoint(org)}
          team={org ?? ""}
          views={views}
          emptyText="No resources in this project yet"
          viewOnlyTitle="Only team admins can move cards and edit links."
          onLoad={onLoad}
          onNotFound={goTo("/projects")}
        />
      </div>
    </div>
  );
}

export function ProjectCanvasPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Canvas" fullBleed>
      <ProjectCanvasContent />
    </Layout>
  );
}

// ── /servers/canvas and /server/{uuid}/canvas ─────────────────────────

function ServersCanvasContent() {
  const { me } = useSignedIn();
  const org = me.team?.id;
  const { canEdit, onLoad } = useGraph(useCallback(() => "Servers", []));
  // The canvas moves this group into its toolbar; the page actions come last, at the right end.
  const views = (
    <div data-ec-views="" className="flex items-center gap-2 max-lg:flex-wrap">
      <CanvasListLink listUrl="/servers" />
      {canEdit ? (
        <a href="/servers/new" className="button button-highlighted whitespace-nowrap">
          <Reicon name="plus" className="size-3.5" />
          New server
        </a>
      ) : null}
    </div>
  );
  return (
    <div className="flex h-full flex-col">
      <div data-environment-canvas="" data-endpoint="/servers/canvas" data-team={org ?? ""} className="relative min-h-0 flex-1">
        <EnvironmentCanvas endpoint={`${canvasApiRoot(org)}/servers/canvas`} apiRoot={canvasApiRoot(org)} serverView environmentEndpoint={environmentCanvasEndpoint(org)} team={org ?? ""} views={views} onLoad={onLoad} />
      </div>
    </div>
  );
}

export function ServersCanvasPage() {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle="Canvas" fullBleed>
      <ServersCanvasContent />
    </Layout>
  );
}

function ServerCanvasContent() {
  const title = useCallback((name: string) => `${name} > Canvas | Freeploy`, []);
  const { me, data } = useServerPage<ServerPageData>("resources", title);
  const org = me.team?.id;
  const uuid = serverUuidFromPath();
  const { onLoad } = useGraph(useCallback((g: CanvasGraph) => g.title ?? "", []));
  const views = <CanvasListLink data-ec-views="" listUrl={`/server/${uuid}/resources`} view="list" />;
  return (
    <div className="flex h-full flex-col">
      {/* Status, proxy actions and the server name dock in the top bar. */}
      {data ? <ServerNavbar server={data.server} orgId={org} /> : null}
      <div data-environment-canvas="" data-endpoint={`/servers/${uuid}/canvas`} data-team={org ?? ""} className="relative min-h-0 flex-1">
        <EnvironmentCanvas
          endpoint={`${canvasApiRoot(org)}/servers/${encodeURIComponent(uuid)}/canvas`}
          apiRoot={canvasApiRoot(org)}
          serverView
          environmentEndpoint={environmentCanvasEndpoint(org)}
          team={org ?? ""}
          views={views}
          onLoad={onLoad}
          onNotFound={goTo("/servers")}
        />
      </div>
    </div>
  );
}

export function ServerCanvasPage() {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle="Canvas" fullBleed>
      <ServerCanvasContent />
    </Layout>
  );
}

// ── /dashboard/canvas ─────────────────────────────────────────────────

function DashboardCanvasContent() {
  const { me } = useSignedIn();
  const org = me.team?.id;
  const { onLoad } = useGraph(useCallback(() => "Dashboard", []));
  // The canvas moves this group into its toolbar.
  const views = (
    <div data-ec-views="" className="flex items-center gap-2 max-lg:flex-wrap">
      <CanvasListLink listUrl="/dashboard" view="list" />
    </div>
  );
  return (
    <div className="flex h-full flex-col">
      {/* data-poll: deployments start without a broadcast event, so the canvas reloads while it is open. */}
      <div data-environment-canvas="" data-endpoint="/dashboard/canvas" data-poll="5" data-team={org ?? ""} className="relative min-h-0 flex-1">
        <EnvironmentCanvas endpoint={`${canvasApiRoot(org)}/dashboard/canvas`} apiRoot={canvasApiRoot(org)} serverView environmentEndpoint={environmentCanvasEndpoint(org)} team={org ?? ""} views={views} poll={5} onLoad={onLoad} />
      </div>
    </div>
  );
}

export function DashboardCanvasPage() {
  return (
    <Layout title="Dashboard" href="/dashboard" documentTitle="Canvas" fullBleed>
      <DashboardCanvasContent />
    </Layout>
  );
}

// ── The shared variable canvases ──────────────────────────────────────

/** SharedVariables\Canvas::mount(): the scope and its owner from the path. */
export function sharedVariablesCanvasScope(pathname = window.location.pathname): { scope: SharedVariableScope; uuid: string | null; projectUuid: string | null } {
  const parts = pathname.replace(/\/+$/, "").split("/").map(decodeURIComponent);
  // /shared-variables/server/{uuid}/canvas, …/environments/project/{p}/environment/{e}/canvas, …/project/{uuid}/canvas, …/team/canvas
  if (parts[2] === "server") return { scope: "server", uuid: parts[3] ?? "", projectUuid: null };
  if (parts[2] === "environments") return { scope: "environment", uuid: parts[6] ?? "", projectUuid: parts[4] ?? "" };
  if (parts[2] === "project") return { scope: "project", uuid: parts[3] ?? "", projectUuid: null };
  return { scope: "team", uuid: null, projectUuid: null };
}

function SharedVariablesCanvasContent() {
  const { me } = useSignedIn();
  const org = me.team?.id;
  const { scope, uuid, projectUuid } = sharedVariablesCanvasScope();
  const headline = scopeHeadline(scope);
  const { canEdit, onLoad } = useGraph(useCallback(() => `${headline} Variables`, [headline]));
  // SharedVariableCanvas::pageLink() and the canvas's own url.
  const listUrl = scope === "team" ? "/shared-variables/team" : (scopePath(scope, uuid, projectUuid) ?? "/shared-variables");
  const endpoint = scope === "team" ? "/shared-variables/team/canvas" : `/shared-variables/${scope}/${encodeURIComponent(uuid ?? "")}/canvas`;
  const variablesApi = `${sharedVariablesApi(org)}/${scope === "team" ? "team" : `${scope}/${encodeURIComponent(uuid ?? "")}`}`;
  const views = (
    <div data-ec-views="" className="flex items-center gap-2 max-lg:flex-wrap">
      <CanvasListLink listUrl={listUrl} view="list" />
      {canEdit ? (
        <DialogButton title="New Shared Variable" label="Add variable">
          {/* saveKey(): the canvas opens again with the new card. */}
          <AddVariable base={variablesApi} onDone={() => window.location.assign(window.location.pathname)} />
        </DialogButton>
      ) : null}
    </div>
  );
  return (
    <div className="flex h-full flex-col">
      <div data-environment-canvas="" data-mode="variables" data-endpoint={endpoint} data-team={org ?? ""} className="relative min-h-0 flex-1">
        <EnvironmentCanvas endpoint={`${canvasApiRoot(org)}${endpoint}`} apiRoot={canvasApiRoot(org)} mode="variables" team={org ?? ""} views={views} onLoad={onLoad} onNotFound={goTo("/shared-variables")} />
      </div>
    </div>
  );
}

export function SharedVariablesCanvasPage() {
  return (
    <Layout title="Shared Variables" href="/shared-variables" documentTitle="Canvas" fullBleed>
      <SharedVariablesCanvasContent />
    </Layout>
  );
}

// ── /canvas/tags ──────────────────────────────────────────────────────

function TagsCanvasContent() {
  const { me } = useSignedIn();
  const org = me.team?.id;
  const { canEdit, onLoad } = useGraph(useCallback(() => "Tags", []));
  const views = (
    <div data-ec-views="" className="flex items-center gap-2 max-lg:flex-wrap">
      <CanvasListLink listUrl="/tags" />
      {canEdit ? (
        <DialogButton title="New tag" label="New tag">
          <NewTagForm orgId={org} />
        </DialogButton>
      ) : null}
    </div>
  );
  return (
    <div className="h-full">
      <div data-environment-canvas="" data-mode="tags" data-endpoint="/tags/canvas" data-team={org ?? ""} className="relative h-full">
        <EnvironmentCanvas endpoint={`${canvasApiRoot(org)}/tags/canvas`} apiRoot={canvasApiRoot(org)} mode="tags" team={org ?? ""} views={views} onLoad={onLoad} />
      </div>
    </div>
  );
}

export function TagsCanvasPage() {
  return (
    <Layout title="Tags" href="/tags" navHref="/tags" documentTitle="Canvas" fullBleed>
      <TagsCanvasContent />
    </Layout>
  );
}
