// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/clone-me.blade.php and
// app/Livewire/Project/CloneMe.php (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/clone (route project.clone-me, DP-100): the new name, "Clone volume data",
// the destinations (server and Docker network, one selected), the resources that will be cloned, and "Clone to
// environment" / "Clone to project" (with volume data, each behind the confirmation). A failure is handleError()'s
// toast (a validation error summarised as Laravel does); a clone opens the new environment. Who may not create
// resources, and a project or environment that is not the org's, get Coolify's way back: the dashboard.
import { useEffect, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Checkbox, FormInput, ModalConfirmation } from "../components/Coolify";
import { environmentPath, environmentUuidFromPath, limit, ProjectBreadcrumb, projectsApi, projectUuidFromPath } from "./ProjectChrome";
import { CLONE_TYPES, cloneBody, destinationCount, plural, resourceCount, selectServer, type CloneMeData, type CloneMeResource, type Selection } from "../lib/clone-me";

function ResourceRow({ resource, type }: { resource: CloneMeResource; type: string }) {
  return (
    <div className="data-table-row clone-resources-table-grid border-b border-neutral-200 last:border-b-0 dark:border-white/[0.06]">
      <div className="truncate text-[12px] font-semibold text-black dark:text-fg">{resource.name}</div>
      <div>
        <span className="inline-flex max-w-full items-center whitespace-nowrap text-neutral-700 dark:text-fg gap-1.5 text-[13px]">
          <span className="relative flex size-1.5 shrink-0">
            <span className="relative inline-flex size-1.5 rounded-full bg-neutral-400 dark:bg-neutral-500" />
          </span>
          <span className="truncate">{type}</span>
        </span>
      </div>
      <div className="truncate text-[11px] text-neutral-600 dark:text-fg-dim">{resource.description || "-"}</div>
    </div>
  );
}

function CloneContent() {
  const { me } = useSignedIn();
  const projectUuid = projectUuidFromPath();
  const environmentUuid = environmentUuidFromPath();
  const base = `${projectsApi(me.team?.id)}/${encodeURIComponent(projectUuid)}/environments/${encodeURIComponent(environmentUuid)}/clone`;
  const [data, setData] = useState<CloneMeData | null>(null);
  const [newName, setNewName] = useState("");
  const [cloneVolumeData, setCloneVolumeData] = useState(false);
  const [selection, setSelection] = useState<Selection>({ server: null, destination: null });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await getJson<CloneMeData>(base);
      if (!r.data) {
        // can.create.resources' 403 and mount()'s firstOrFail(): back to the dashboard.
        if (r.status !== 401) window.location.replace("/");
        return;
      }
      setData(r.data);
      setNewName(r.data.newName);
    })();
  }, [base]);
  useEffect(() => {
    if (data) document.title = `${limit(data.project.name, 10)} > Clone | Freeploy`;
  }, [data]);

  /** clone($type): then redirect()->route('project.resource.index', …) of the clone. */
  async function clone(type: "environment" | "project") {
    setBusy(true);
    const r = await postJson<{ projectUuid: string; environmentUuid: string }>(base, cloneBody(type, newName, selection, cloneVolumeData));
    if (!r.ok) {
      setBusy(false);
      notify.error(summarize(r.error.messages));
      return;
    }
    window.location.assign(environmentPath(r.data.projectUuid, r.data.environmentUuid));
  }

  if (!data) return null;
  const { project, environment, servers } = data;
  const destinations = destinationCount(servers);
  const resources = resourceCount(data);
  const disabled = !selection.destination || busy;

  return (
    <div>
      <ProjectBreadcrumb orgId={me.team?.id} project={project} environment={environment} />
      <div className="w-full max-w-none">
        <header className="mb-5">
          <h1 className="truncate text-[24px]! leading-7! font-semibold! tracking-tight!">{environment.name}</h1>
          <p className="mt-1 text-[13px] text-neutral-500 dark:text-fg-dim">Clone this environment inside {project.name}</p>
        </header>

        <div className="flex flex-col gap-6">
          <section className="application-settings-section">
            <div className="application-settings-section-header">
              <div>
                <h2>Clone environment</h2>
                <p>Copy every resource from {environment.name} to a new project or environment.</p>
              </div>
            </div>
            <div className="application-settings-section-body">
              <div className="max-w-md">
                <FormInput required id="newName" label="New name" value={newName} onChange={setNewName} />
              </div>
              <div className="mt-4 max-w-md">
                <Checkbox
                  id="cloneVolumeData"
                  label="Clone volume data"
                  helper="Copies the data of the persistent volumes to the clones. Running source resources are stopped while the data is copied and started again afterwards."
                  checked={cloneVolumeData}
                  onChange={setCloneVolumeData}
                />
              </div>
            </div>
          </section>

          <section className="application-settings-section">
            <div className="application-settings-section-header">
              <div>
                <h2>Destination</h2>
                <p>Choose the server and Docker network that will receive the cloned resources.</p>
              </div>
            </div>
            <div className="application-settings-section-body p-0!">
              <div className="data-table">
                <div className="data-table-header clone-destinations-table-grid">
                  <span>
                    <span className="sr-only">Selected</span>
                  </span>
                  <span>Server</span>
                  <span>Network</span>
                </div>
                {servers.flatMap((server) =>
                  server.destinations.map((destination) => {
                    const selected = selection.destination === destination.uuid;
                    return (
                      <button
                        key={destination.uuid}
                        type="button"
                        onClick={() => setSelection(selectServer(selection, server.uuid, destination.uuid))}
                        className={`data-table-row clone-destinations-table-grid w-full border-b border-neutral-200 text-left last:border-b-0 dark:border-white/[0.06]${selected ? " bg-coollabs/5 dark:bg-brand/[0.08]" : ""}`}
                      >
                        <span
                          className={`flex size-4 items-center justify-center rounded-full border ${
                            selected ? "border-coollabs bg-coollabs text-white dark:border-brand dark:bg-brand dark:text-white" : "border-neutral-300 dark:border-white/[0.15]"
                          }`}
                        >
                          {selected ? <span className="size-1.5 rounded-full bg-current" /> : null}
                        </span>
                        <span className="truncate text-[12px] font-semibold text-black dark:text-fg">{server.name}</span>
                        <span className="truncate font-mono text-[11px] text-neutral-600 dark:text-fg-dim">{destination.name}</span>
                      </button>
                    );
                  }),
                )}
                <div className="flex min-h-11 items-center border-t border-neutral-200 px-4 text-[11px] text-neutral-500 dark:border-white/[0.08] dark:text-fg-faint">
                  {destinations} {plural("destination", destinations)}
                </div>
              </div>
            </div>
          </section>

          <section className="application-settings-section">
            <div className="application-settings-section-header">
              <div>
                <h2>Resources</h2>
                <p>
                  {resources} {plural("resource", resources)} will be cloned.
                </p>
              </div>
            </div>
            <div className="application-settings-section-body p-0!">
              <div className="data-table">
                <div className="data-table-header clone-resources-table-grid">
                  <span>Name</span>
                  <span>Type</span>
                  <span>Description</span>
                </div>
                {data.applications.map((r) => (
                  <ResourceRow key={r.uuid} resource={r} type="Application" />
                ))}
                {data.databases.map((r) => (
                  <ResourceRow key={r.uuid} resource={r} type="Database" />
                ))}
                {data.services.map((r) => (
                  <ResourceRow key={r.uuid} resource={r} type="Service" />
                ))}
                <div className="flex min-h-11 items-center border-t border-neutral-200 px-4 text-[11px] text-neutral-500 dark:border-white/[0.08] dark:text-fg-faint">
                  {resources} {plural("resource", resources)}
                </div>
              </div>
              <div className="flex flex-col gap-2 border-t border-neutral-200 p-4 sm:flex-row sm:justify-end dark:border-white/[0.06]">
                {CLONE_TYPES.map(([type, label]) =>
                  cloneVolumeData ? (
                    <div key={`clone-with-volume-data-${type}`}>
                      <ModalConfirmation
                        title="Clone with volume data?"
                        confirmationText={null}
                        step2ButtonText={label}
                        warningMessage="Running source resources are unavailable while their volume data is copied."
                        actions={["Running source resources are stopped while their volume data is copied.", "They are started again after the copy, also when the copy fails."]}
                        trigger={
                          <button type="button" className="button button-highlighted" disabled={disabled}>
                            {label}
                          </button>
                        }
                        onSubmit={() => clone(type)}
                      />
                    </div>
                  ) : (
                    <button key={type} type="button" className="button button-highlighted" disabled={disabled} onClick={() => void clone(type)}>
                      {label}
                    </button>
                  ),
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export function EnvironmentClonePage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Clone">
      <CloneContent />
    </Layout>
  );
}
