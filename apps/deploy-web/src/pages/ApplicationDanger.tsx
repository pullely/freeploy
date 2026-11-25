// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/shared/danger.blade.php,
// app/Livewire/Project/Shared/Danger.php and lang/en.json (resource.delete_volumes and its siblings)
// (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/application/{app_uuid}/danger
// (project.application.danger): delete the application. The dialog's
// checkboxes go to the API as Coolify's query fields. An application nothing
// was ever deployed of is removed at once; any other needs the SSH executor
// to stop and remove what is on the server, and the API says so. Coolify also
// asks for the account password, which deploy-core cannot check yet, so that
// step is left out. The same component is a database's Danger Zone
// (DangerContent with kind "database"): its label is "resource", Redis, KeyDB
// and Dragonfly add "Flush all data" (which needs the SSH executor), and a
// database that was never started is removed at once.
import { Layout } from "../layout/Layout";
import { Button, Callout, DangerCallout, DangerZone, ModalConfirmation, SettingsSection, type ConfirmationCheckbox } from "../components/Coolify";
import { environmentPath } from "./ProjectChrome";
import { resourceApi, resourceFrame, useResourceSection, type ResourceKind, type ResourceSectionData } from "./ApplicationSection";
import { ResourceWorkspace } from "./ResourceWorkspace";
import { sendJson, showError, showSaved } from "./ApplicationResource";

type Data = ResourceSectionData & {
  canDelete: boolean;
  serverIsFunctional: boolean;
  neverDeployed: boolean;
};

/** danger.blade.php: the database types with "Flush all data". */
const FLUSHABLE = ["standalone-redis", "standalone-keydb", "standalone-dragonfly"];

/** Danger::render(): the checkboxes, with Danger's defaults ($delete_volumes … true, $delete_backups false). */
const CHECKBOXES: ConfirmationCheckbox[] = [
  { id: "delete_volumes", label: "Permanently delete all volumes associated with this resource.", checked: true },
  { id: "delete_connected_networks", label: "Permanently delete all non-predefined networks associated with this resource.", checked: true },
  { id: "delete_configurations", label: "Permanently delete all configuration files from the server.", checked: true },
  { id: "docker_cleanup", label: "Run Docker Cleanup (remove unused images and builder cache).", checked: true },
  {
    id: "delete_backups",
    label: "Permanently delete all database and storage backups of this resource, on the server and on S3.",
    defaultWarning: "The database and storage backups of this resource stay on the server and on S3. Freeploy no longer manages them, so you must delete them yourself.",
    checked: false,
  },
];

/** <livewire:project.shared.danger :resource>: an application's or a database's Danger Zone. */
export function DangerContent({ kind }: { kind: ResourceKind }) {
  const { me, data } = useResourceSection<Data>(kind, "danger");
  if (!data) return null;
  const { canDelete } = data;
  const resource = resourceFrame(data);
  const base = resourceApi(kind, me.team?.id, resource.uuid);
  // $resourceLabel: 'application' for an application, 'resource' for every database type.
  const resourceLabel = kind === "application" ? "application" : "resource";
  const flushable = "database" in data && FLUSHABLE.includes(data.database.databaseType);
  // @can('manage', $resource)
  const canManage = "database" in data && data.canManage;

  /** Danger::flush(): the API answers that it needs the server. */
  async function flush() {
    const r = await sendJson<{ message?: string }>("POST", `${base}/danger/flush`);
    if (!r.ok) return showError(r.error);
    showSaved(r.data);
  }

  /** Danger::delete(): then redirectRoute('project.resource.index'). */
  async function remove(selectedActions: string[]) {
    const query = CHECKBOXES.map((c) => `${c.id}=${selectedActions.includes(c.id)}`).join("&");
    const r = await sendJson<{ deleted: boolean }>("DELETE", `${base}?${query}`);
    if (!r.ok) return showError(r.error);
    window.location.assign(environmentPath(resource.project.uuid, resource.environment.uuid));
  }

  return (
    <ResourceWorkspace data={data} orgId={me.team?.id} active="Danger Zone">
      <div>
        {/* Coolify's notice here is for a server that does not answer ("Deleting removes this application from
            Coolify only…"): it deletes the rows and leaves the server as it is. Freeploy does not do that, so the
            notice is not shown; what it cannot do yet is said in its place. */}
        {data.neverDeployed ? null : (
          <Callout type="warning" title="Not available yet" className="mb-4">
            Deleting this {resourceLabel} needs the SSH executor, which is not available yet: its containers, volumes, networks, and configuration files must be removed from the server first.
          </Callout>
        )}
        <SettingsSection id="danger-zone-section" title="Danger zone" helper="Destructive resource actions cannot be undone.">
          {flushable ? (
            // <x-danger-zone class="mb-4">
            <div className="mb-4">
              <DangerZone
                title="Flush all data"
                action={
                  <ModalConfirmation
                    title="Flush all data?"
                    buttonTitle="Flush all data"
                    actions={["Permanently remove every key from every logical database."]}
                    confirmationText={resource.name}
                    confirmationLabel="Enter the database name to confirm flushing all data"
                    shortConfirmationLabel="Database name"
                    disabled={!canManage}
                    disabledTooltip="You do not have permission to flush this database."
                    onSubmit={flush}
                  />
                }
              >
                <p>
                  Permanently remove every key from <strong className="font-semibold text-black dark:text-fg">{resource.name}</strong>. The database keeps running.
                </p>
              </DangerZone>
            </div>
          ) : null}
          <DangerZone
            title={`Delete ${resourceLabel}`}
            action={
              canDelete ? (
                <ModalConfirmation
                  title={`Delete ${resourceLabel}?`}
                  buttonTitle={`Delete ${resourceLabel}`}
                  checkboxes={CHECKBOXES}
                  actions={["Permanently delete this resource and its selected Docker resources."]}
                  confirmationText={resource.name}
                  confirmationLabel="Enter the resource name to confirm permanent deletion"
                  shortConfirmationLabel="Resource name"
                  onSubmit={remove}
                />
              ) : (
                <Button error disabled tooltip="You do not have permission to delete this resource.">
                  Delete {resourceLabel}
                </Button>
              )
            }
          >
            <p>
              Permanently delete <strong className="font-semibold text-black dark:text-fg">{resource.name}</strong>, stop its containers, and remove the selected Docker resources and configuration.
            </p>
            <ul className="space-y-1 text-xs">
              <li>• Active deployments will be stopped.</li>
              <li>• Selected volumes and stored data may be permanently removed.</li>
              <li>• This {resourceLabel} cannot be restored from Freeploy after deletion.</li>
            </ul>
          </DangerZone>

          {canDelete ? null : (
            <div className="mt-4">
              <DangerCallout title="Insufficient permissions" className="">
                Contact a team administrator if this resource must be deleted.
              </DangerCallout>
            </div>
          )}
        </SettingsSection>
      </div>
    </ResourceWorkspace>
  );
}

export function ApplicationDangerPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
      <DangerContent kind="application" />
    </Layout>
  );
}
