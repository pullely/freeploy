// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/application/rollback.blade.php and
// app/Livewire/Project/Application/Rollback.php (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/application/{app_uuid}/rollback
// (project.application.rollback): how many of the application's images are
// kept for a rollback, and the images. Listing the images and rolling back
// need the SSH executor: in place of the list the page says so — it never
// shows Coolify's "No rollback images", which would be a statement about the
// server.
import { useState } from "react";
import { Layout } from "../layout/Layout";
import { Button, Callout, FormInput, SettingsSection, UnsavedBar } from "../components/Coolify";
import { applicationsApi, ApplicationWorkspace } from "./ApplicationChrome";
import { inlineErrors, useApplicationSection, type ApplicationSectionData } from "./ApplicationSection";
import { sendJson, showError, showSaved } from "./ApplicationResource";

interface Rollback {
  dockerImagesToKeep: number;
  serverRetentionDisabled: boolean;
  images: null;
  imagesUnavailable: string;
}

type Data = ApplicationSectionData & Rollback;
type Saved = Rollback & { message: string };

function ApplicationRollbackContent() {
  const { me, data, setData, saving, patch } = useApplicationSection<Data>("rollback");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | undefined>();
  /** The stored number the field was last filled from. */
  const [synced, setSynced] = useState<number | null>(null);
  if (data && synced !== data.dockerImagesToKeep) {
    setSynced(data.dockerImagesToKeep);
    setValue(String(data.dockerImagesToKeep));
  }
  if (!data) return null;
  const { application, canUpdate } = data;
  const base = `${applicationsApi(me.team?.id)}/${encodeURIComponent(application.uuid)}/rollback`;
  const dirty = canUpdate && value !== String(data.dockerImagesToKeep);

  /** Rollback::saveSettings() */
  async function save() {
    const r = await patch<Saved>({ dockerImagesToKeep: value });
    if (!r.ok) {
      setError(inlineErrors(r.error).dockerImagesToKeep);
      if (!r.error.messages.length) showError(r.error);
      return;
    }
    setError(undefined);
    setData({ ...data!, dockerImagesToKeep: r.data.dockerImagesToKeep, serverRetentionDisabled: r.data.serverRetentionDisabled });
    showSaved(r.data);
  }

  /** Rollback::loadImages(true) */
  async function reload() {
    const r = await sendJson<Saved>("POST", `${base}/images`);
    if (!r.ok) showError(r.error);
  }

  return (
    <ApplicationWorkspace application={application} orgId={me.team?.id} active="Rollback" canUpdate={canUpdate} canDeploy={data.canDeploy}>
      <div className="flex flex-col gap-6">
        <SettingsSection
          title="Rollback images"
          helper="Keep previously built Docker images available for fast rollbacks. Rollback uses an existing image without rebuilding the application. Images in the Docker registry are pulled to the server first."
          flush
          actions={<Button onClick={() => void reload()}>Reload images</Button>}
        >
          <form
            className="flex flex-col gap-4 border-b border-neutral-200 px-4 py-3.5 dark:border-white/[0.07]"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <UnsavedBar dirty={dirty} saving={saving} onSave={() => void save()} />
            {data.serverRetentionDisabled ? (
              <Callout type="warning" title="Disabled by the server">
                Image retention is disabled at the server level. This setting has no effect until a server administrator enables it.
              </Callout>
            ) : null}
            <div className="max-w-sm">
              <FormInput
                id="dockerImagesToKeep"
                type="number"
                min={0}
                max={100}
                label="Images to keep"
                helper="Set to 0 to keep only the running image. Pull request images are always removed during cleanup."
                value={value}
                onChange={setValue}
                disabled={!canUpdate || data.serverRetentionDisabled}
                error={error}
              />
            </div>
          </form>

          <div className="px-4 py-3.5">
            <Callout type="warning" title="Not available yet">
              {data.imagesUnavailable}
            </Callout>
          </div>
        </SettingsSection>
      </div>
    </ApplicationWorkspace>
  );
}

export function ApplicationRollbackPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
      <ApplicationRollbackContent />
    </Layout>
  );
}
