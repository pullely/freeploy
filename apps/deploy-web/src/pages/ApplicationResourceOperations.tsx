// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/shared/resource-operations.blade.php
// and app/Livewire/Project/Shared/ResourceOperations.php (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/application/{app_uuid}/resource-operations
// (project.application.resource-operations): clone the application to any
// destination and environment of the team, or move it to another
// environment. Both only write rows; what a clone would then do on a server
// (copy the volume data, write the file mounts) needs the SSH executor, and
// the clone's page says so. "Migrate to another server" shows in Coolify's
// development mode only and is not ported. The same component is a
// database's Resource Operations page (kind "database"): after a clone or a
// move it opens the database's page. And a service's (kind "service", DP-97): Move as Coolify's; Clone answers
// Coolify's checks, then that it is not available yet (clone_service() is not ported).
import { useEffect, useState } from "react";
import { servicePath } from "../lib/service-templates";
import { Layout } from "../layout/Layout";
import { flashNotice, takeNotice } from "../lib/flash";
import { toast } from "../lib/toast";
import { Button, Callout, Checkbox, DangerCallout, Empty, Listbox, ModalConfirmation, SettingsSection, type ListboxOption } from "../components/Coolify";
import { applicationPath } from "./ApplicationChrome";
import { databasePath } from "./DatabaseChrome";
import { resourceApi, resourceFrame, useResourceSection, type ResourceKind, type ResourceSectionData } from "./ApplicationSection";
import { ResourceWorkspace } from "./ResourceWorkspace";
import { sendJson, showError } from "./ApplicationResource";

interface Project {
  uuid: string;
  name: string;
  environments: Array<{ uuid: string; name: string }>;
}

interface Server {
  uuid: string;
  name: string;
  ip: string;
  isFunctional: boolean;
  destinations: Array<{ uuid: string; name: string }>;
}

type Data = ResourceSectionData & {
  projects: Project[];
  servers: Server[];
  buildServers: Array<{ uuid: string; name: string }>;
};

/** cloneTo() and moveTo(): where the resource now is (applicationUuid or databaseUuid). */
interface Result {
  projectUuid: string;
  environmentUuid: string;
  applicationUuid?: string;
  databaseUuid?: string;
  serviceUuid?: string;
  unavailable?: string;
}

const FOOTER = "mt-4 flex flex-col gap-3 border-t border-neutral-200 pt-4 sm:flex-row sm:items-center sm:justify-between dark:border-white/[0.07]";
const NOTE = "text-[13px] text-neutral-500 dark:text-fg-dim";

/** <livewire:project.shared.resource-operations :resource>: an application's or a database's clone and move. */
export function ResourceOperationsContent({ kind }: { kind: ResourceKind }) {
  const { me, data } = useResourceSection<Data>(kind, "resource-operations");
  const [cloneServer, setCloneServer] = useState<string | null>(null);
  const [cloneDestination, setCloneDestination] = useState<string | null>(null);
  const [cloneProject, setCloneProject] = useState<string | null>(null);
  const [cloneEnvironment, setCloneEnvironment] = useState<string | null>(null);
  const [moveProject, setMoveProject] = useState<string | null>(null);
  const [moveEnvironment, setMoveEnvironment] = useState<string | null>(null);
  const [cloneVolumeData, setCloneVolumeData] = useState(false);
  const [busy, setBusy] = useState(false);
  const resource = data ? resourceFrame(data) : null;
  const loaded = resource?.uuid;
  const currentServer = resource?.server?.uuid ?? null;
  const currentDestination = resource?.destination?.uuid ?? null;
  const currentProject = resource?.project.uuid ?? null;
  const currentEnvironment = resource?.environment.uuid ?? null;
  // x-init: the current server, destination, project and environment are selected for the clone.
  useEffect(() => {
    if (!loaded) return;
    setCloneServer(currentServer);
    setCloneDestination(currentDestination);
    setCloneProject(currentProject);
    setCloneEnvironment(currentEnvironment);
  }, [loaded, currentServer, currentDestination, currentProject, currentEnvironment]);
  // What the clone or the move that led here could not do yet.
  useEffect(() => {
    const notice = takeNotice();
    if (notice) toast(notice, { type: "warning" });
  }, []);
  if (!data || !resource) return null;
  const { canUpdate } = data;
  const base = `${resourceApi(kind, me.team?.id, resource.uuid)}/resource-operations`;
  const current = { server: currentServer, destination: currentDestination, project: currentProject, environment: currentEnvironment };
  const mark = (isCurrent: boolean) => (isCurrent ? " (current)" : "");

  const cloneServerOptions: ListboxOption[] = [
    ...data.servers.map((s) => ({ value: s.uuid, label: `${s.name} (${s.ip})${mark(s.uuid === current.server)}` })),
    ...data.buildServers.map((s) => ({ value: `build-${s.uuid}`, label: `${s.name} (build server)`, disabled: true })),
  ];
  const cloneDestinationOptions = (data.servers.find((s) => s.uuid === cloneServer)?.destinations ?? []).map((d) => ({ value: d.uuid, label: d.name + mark(d.uuid === current.destination) }));
  const projectOptions = data.projects.map((p) => ({ value: p.uuid, label: p.name + mark(p.uuid === current.project) }));
  const cloneEnvironments = data.projects.find((p) => p.uuid === cloneProject)?.environments ?? [];
  const cloneEnvironmentOptions = cloneEnvironments.map((e) => ({ value: e.uuid, label: e.name + mark(e.uuid === current.environment) }));
  // availableEnvironments: the current environment is excluded.
  const moveEnvironments = (data.projects.find((p) => p.uuid === moveProject)?.environments ?? []).filter((e) => e.uuid !== current.environment);

  /** cloneTo() and moveTo(): then the resource's page in its new place. */
  async function run(action: "clone" | "move", body: Record<string, unknown>) {
    setBusy(true);
    const r = await sendJson<Result>("POST", `${base}/${action}`, body);
    if (!r.ok) {
      setBusy(false);
      return showError(r.error);
    }
    if (r.data.unavailable) flashNotice(r.data.unavailable);
    const page =
      kind === "application"
        ? applicationPath(r.data.projectUuid, r.data.environmentUuid, r.data.applicationUuid ?? "")
        : kind === "service"
          ? servicePath(r.data.projectUuid, r.data.environmentUuid, r.data.serviceUuid ?? "")
          : databasePath(r.data.projectUuid, r.data.environmentUuid, r.data.databaseUuid ?? "");
    window.location.assign(`${page}/resource-operations`);
  }
  const clone = () => run("clone", { destination_uuid: cloneDestination, environment_uuid: cloneEnvironment, cloneVolumeData });
  const cloneDisabled = busy || !cloneDestination || !cloneEnvironment;

  return (
    <ResourceWorkspace data={data} orgId={me.team?.id} active="Resource Operations">
      <div className="flex flex-col gap-6">
        {canUpdate ? (
          <>
            <SettingsSection id="clone-resource-section" title="Clone resource" helper="Create a copy of this resource. Choose where it runs and where it belongs. The current values are selected by default.">
              <Callout type="info" title="What is copied">
                Cloning copies settings, environment variables, and resource configuration. Stored files, database records, and other persistent data are copied only when you select Clone volume data.
              </Callout>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <Listbox
                  id="clone-resource-server"
                  label="Server"
                  options={cloneServerOptions}
                  value={cloneServer}
                  onChange={(value) => {
                    setCloneServer(value);
                    setCloneDestination(null);
                  }}
                  placeholder="Choose a server…"
                />
                <Listbox
                  id="clone-resource-destination"
                  label="Network destination"
                  options={cloneDestinationOptions}
                  value={cloneDestination}
                  onChange={setCloneDestination}
                  disabled={cloneServer === null || cloneServer === ""}
                  placeholder="Choose a destination…"
                  emptyText="No network destinations are available on this server."
                />
                <Listbox
                  id="clone-resource-project"
                  label="Project"
                  options={projectOptions}
                  value={cloneProject}
                  onChange={(value) => {
                    setCloneProject(value);
                    setCloneEnvironment(null);
                  }}
                  placeholder="Choose a project…"
                />
                <Listbox
                  id="clone-resource-environment"
                  label="Environment"
                  options={cloneEnvironmentOptions}
                  value={cloneEnvironment}
                  onChange={setCloneEnvironment}
                  disabled={!cloneProject || cloneEnvironments.length === 0}
                  placeholder="Choose an environment…"
                />
              </div>

              <div className="mt-4 flex">
                <Checkbox
                  id="cloneVolumeData"
                  label="Clone volume data"
                  helper="Copies the data of the persistent volumes to the clone. A running source resource is stopped while the data is copied and started again afterwards."
                  checked={cloneVolumeData}
                  onChange={setCloneVolumeData}
                />
              </div>

              <div className={FOOTER}>
                {cloneVolumeData ? (
                  <>
                    <p className={NOTE}>A running resource is stopped while its volume data is copied.</p>
                    <ModalConfirmation
                      title="Clone this resource with its volume data?"
                      trigger={<Button disabled={cloneDisabled}>Clone resource</Button>}
                      disabled={cloneDisabled}
                      confirmationText={null}
                      step2ButtonText="Clone resource"
                      warningMessage="A running resource is unavailable while its volume data is copied."
                      actions={["If the resource is running, it is stopped while its volume data is copied.", "The resource is started again after the copy, also when the copy fails."]}
                      onSubmit={clone}
                    />
                  </>
                ) : (
                  <>
                    <p className={NOTE}>The running resource will not be changed.</p>
                    <Button disabled={cloneDisabled} onClick={() => void clone()}>
                      Clone resource
                    </Button>
                  </>
                )}
              </div>
            </SettingsSection>

            <SettingsSection id="move-resource-section" title="Move resource" helper="Transfer this resource to another project environment without changing the running deployment.">
              {data.projects.length > 0 ? (
                <>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Listbox
                      id="move-resource-project"
                      label="Project"
                      options={projectOptions}
                      value={moveProject}
                      onChange={(value) => {
                        setMoveProject(value);
                        setMoveEnvironment(null);
                      }}
                      placeholder="Choose a project…"
                    />
                    <Listbox
                      id="move-resource-environment"
                      label="Environment"
                      helper="The current environment is excluded."
                      options={moveEnvironments.map((e) => ({ value: e.uuid, label: e.name }))}
                      value={moveEnvironment}
                      onChange={setMoveEnvironment}
                      disabled={!moveProject || moveEnvironments.length === 0}
                      placeholder="Choose an environment…"
                    />
                  </div>

                  {moveEnvironment ? (
                    <div className={FOOTER}>
                      <p className={NOTE}>All configuration will move with the resource.</p>
                      <Button disabled={busy} onClick={() => void run("move", { environment_uuid: moveEnvironment })}>
                        Move resource
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : (
                <Empty size="sm" title="No destination environments" description="Create another project or environment before moving this resource." iconName="projects" />
              )}
            </SettingsSection>
          </>
        ) : (
          <DangerCallout title="Insufficient permissions" className="">
            You do not have permission to clone or move this resource. Contact a team administrator for access.
          </DangerCallout>
        )}
      </div>
    </ResourceWorkspace>
  );
}

export function ApplicationResourceOperationsPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
      <ResourceOperationsContent kind="application" />
    </Layout>
  );
}
