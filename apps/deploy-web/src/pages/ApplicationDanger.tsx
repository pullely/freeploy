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
// step is left out.
import { Layout } from "../layout/Layout";
import { Button, Callout, DangerCallout, DangerZone, ModalConfirmation, SettingsSection, type ConfirmationCheckbox } from "../components/Coolify";
import { applicationsApi, ApplicationWorkspace } from "./ApplicationChrome";
import { environmentPath } from "./ProjectChrome";
import { useApplicationSection, type ApplicationSectionData } from "./ApplicationSection";
import { sendJson, showError } from "./ApplicationResource";

interface Data extends ApplicationSectionData {
  canDelete: boolean;
  serverIsFunctional: boolean;
  neverDeployed: boolean;
}

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

function ApplicationDangerContent() {
  const { me, data } = useApplicationSection<Data>("danger");
  if (!data) return null;
  const { application, canUpdate, canDelete } = data;
  const base = `${applicationsApi(me.team?.id)}/${encodeURIComponent(application.uuid)}`;
  // $resource->type() is 'application'.
  const resourceLabel = "application";

  /** Danger::delete(): then redirectRoute('project.resource.index'). */
  async function remove(selectedActions: string[]) {
    const query = CHECKBOXES.map((c) => `${c.id}=${selectedActions.includes(c.id)}`).join("&");
    const r = await sendJson<{ deleted: boolean }>("DELETE", `${base}?${query}`);
    if (!r.ok) return showError(r.error);
    window.location.assign(environmentPath(application.project.uuid, application.environment.uuid));
  }

  return (
    <ApplicationWorkspace application={application} orgId={me.team?.id} active="Danger Zone" canUpdate={canUpdate} canDeploy={data.canDeploy}>
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
          <DangerZone
            title={`Delete ${resourceLabel}`}
            action={
              canDelete ? (
                <ModalConfirmation
                  title={`Delete ${resourceLabel}?`}
                  buttonTitle={`Delete ${resourceLabel}`}
                  checkboxes={CHECKBOXES}
                  actions={["Permanently delete this resource and its selected Docker resources."]}
                  confirmationText={application.name}
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
              Permanently delete <strong className="font-semibold text-black dark:text-fg">{application.name}</strong>, stop its containers, and remove the selected Docker resources and configuration.
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
    </ApplicationWorkspace>
  );
}

export function ApplicationDangerPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
      <ApplicationDangerContent />
    </Layout>
  );
}
