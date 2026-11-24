// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/docker-cleanup.blade.php,
// resources/views/livewire/server/docker-cleanup-executions.blade.php (its empty state) and
// app/Livewire/Server/DockerCleanup.php (Apache-2.0), modified.
//
// /server/{uuid}/docker-cleanup: the cleanup schedule, threshold and what it
// may delete. Saving works; "Run cleanup" dispatches a job that runs over SSH,
// so the API answers that it is not available yet. No cleanup has run, so the
// executions list is its empty state.
import { useEffect, useState, type FormEvent } from "react";
import { Layout } from "../layout/Layout";
import { Reicon } from "../components/Reicon";
import { Callout, Empty, FormInput, Listbox, ModalConfirmation, SettingsSection, SettingsSubsection, UnsavedBar } from "../components/Coolify";
import { limit, ServerWorkspace, useServerSection, yesNo } from "./ServerChrome";

interface DockerCleanup {
  dockerCleanupFrequency: string;
  dockerCleanupThreshold: number;
  forceDockerCleanup: boolean;
  deleteUnusedVolumes: boolean;
  deleteUnusedNetworks: boolean;
  disableApplicationImageRetention: boolean;
  isCleanupStale: boolean;
  lastExecutionTime: string | null;
}

type Toggle = "forceDockerCleanup" | "deleteUnusedVolumes" | "deleteUnusedNetworks" | "disableApplicationImageRetention";

const title = (name: string) => `${limit(name, 10)} > Docker Cleanup | Freeploy`;

function ServerDockerCleanupContent() {
  const { me, data, errors, saving, save, post } = useServerSection<DockerCleanup>("docker-cleanup", title);
  const [frequency, setFrequency] = useState("");
  const [threshold, setThreshold] = useState("");
  const [toggles, setToggles] = useState<Record<Toggle, boolean> | null>(null);
  useEffect(() => {
    if (!data) return;
    const s = data.settings;
    setFrequency(s.dockerCleanupFrequency);
    setThreshold(String(s.dockerCleanupThreshold));
    setToggles({ forceDockerCleanup: s.forceDockerCleanup, deleteUnusedVolumes: s.deleteUnusedVolumes, deleteUnusedNetworks: s.deleteUnusedNetworks, disableApplicationImageRetention: s.disableApplicationImageRetention });
  }, [data]);
  if (!data || !toggles) return null;
  const { server, settings, canUpdate } = data;
  // The unsaved bar's targets: the cron and threshold fields (the listboxes save at once).
  const dirty = frequency !== settings.dockerCleanupFrequency || threshold !== String(settings.dockerCleanupThreshold);
  const body = (t = toggles) => ({ dockerCleanupFrequency: frequency, dockerCleanupThreshold: threshold, ...t });
  const submit = () => void save(body());
  /** A listbox with onChange="instantSave". */
  const toggle = (k: Toggle) => (v: string) => {
    const next = { ...toggles, [k]: v === "true" };
    setToggles(next);
    void save(body(next), true);
  };

  return (
    <ServerWorkspace server={server} orgId={me.team?.id} active="docker-cleanup" canUpdate={canUpdate}>
      <div className="application-settings-form flex w-full flex-col gap-6">
        <form
          className="contents"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            submit();
          }}
        >
          <UnsavedBar dirty={dirty} saving={saving} onSave={submit} />

          <SettingsSection
            id="docker-cleanup-overview-section"
            title="Docker cleanup"
            helper="Remove unused Docker data and keep disk usage under control."
            actions={
              canUpdate ? (
                <ModalConfirmation
                  title="Confirm Docker Cleanup?"
                  trigger={
                    <button type="button" className="button button-highlighted">
                      Run cleanup
                    </button>
                  }
                  actions={[
                    "Deletes stopped containers managed by Freeploy.",
                    "Deletes unused images and clears the build cache.",
                    "Removes old Freeploy helper images.",
                    "May delete unused volumes or networks when those options are enabled.",
                  ]}
                  confirmationText={null}
                  step2ButtonText="Run Docker Cleanup"
                  onSubmit={async () => {
                    await post("run");
                  }}
                />
              ) : undefined
            }
          >
            {settings.isCleanupStale ? (
              <Callout title="Docker cleanup may be stalled">The last cleanup ran {settings.lastExecutionTime ?? "at an unknown time"}.</Callout>
            ) : (
              <div className="flex items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500 dark:bg-white/[0.06] dark:text-fg-dim">
                  <Reicon name="storages" className="size-4" />
                </div>
                <div>
                  <p className="text-sm font-medium text-neutral-950 dark:text-fg">Scheduled maintenance</p>
                  <p className="mt-1 text-xs leading-5 text-neutral-500 dark:text-fg-dim">Cleanup runs automatically using the schedule and threshold configured below.</p>
                </div>
              </div>
            )}
            <SettingsSubsection id="docker-cleanup-configuration-section" title="Schedule" helper="Choose when cleanup runs and whether it should wait for a disk threshold.">
              <div className="grid gap-4 lg:grid-cols-3">
                <FormInput
                  id="dockerCleanupFrequency"
                  label="Cleanup frequency"
                  placeholder="0 0 * * *"
                  required
                  helper="Cron expression or preset such as hourly, daily, weekly, monthly, or yearly."
                  disabled={!canUpdate}
                  value={frequency}
                  onChange={setFrequency}
                  error={errors.dockerCleanupFrequency}
                />
                <Listbox
                  id="forceDockerCleanup"
                  label="Cleanup trigger"
                  helper="Forced cleanup runs on every schedule without waiting for the threshold."
                  options={[
                    { value: "false", label: "Only above disk threshold" },
                    { value: "true", label: "Run on every schedule" },
                  ]}
                  value={yesNo(toggles.forceDockerCleanup)}
                  onChange={toggle("forceDockerCleanup")}
                  disabled={!canUpdate}
                />
                {!toggles.forceDockerCleanup ? (
                  <FormInput
                    id="dockerCleanupThreshold"
                    type="number"
                    min={1}
                    max={99}
                    label="Disk threshold"
                    required
                    helper="Run cleanup after disk usage exceeds this percentage."
                    disabled={!canUpdate}
                    value={threshold}
                    onChange={setThreshold}
                    error={errors.dockerCleanupThreshold}
                  />
                ) : null}
              </div>
            </SettingsSubsection>
            <SettingsSubsection id="docker-cleanup-advanced-section" title="Advanced cleanup" helper="Control destructive cleanup behavior and application image retention.">
              <Callout title="These options can remove recoverable data">
                Unused volumes may contain data from stopped containers, while removing retained images disables rollback to older application versions.
              </Callout>
              <div className="mt-4 grid gap-4 lg:grid-cols-3">
                <Listbox
                  id="deleteUnusedVolumes"
                  label="Unused volumes"
                  helper="Permanently remove volumes not attached to running containers."
                  options={[
                    { value: "false", label: "Keep unused volumes" },
                    { value: "true", label: "Delete unused volumes" },
                  ]}
                  value={yesNo(toggles.deleteUnusedVolumes)}
                  onChange={toggle("deleteUnusedVolumes")}
                  disabled={!canUpdate}
                />
                <Listbox
                  id="deleteUnusedNetworks"
                  label="Unused networks"
                  helper="Remove Docker networks not attached to running containers."
                  options={[
                    { value: "false", label: "Keep unused networks" },
                    { value: "true", label: "Delete unused networks" },
                  ]}
                  value={yesNo(toggles.deleteUnusedNetworks)}
                  onChange={toggle("deleteUnusedNetworks")}
                  disabled={!canUpdate}
                />
                <Listbox
                  id="disableApplicationImageRetention"
                  label="Application images"
                  helper="Choose Keep retained images to follow each application’s Images to keep setting under Rollback. Delete all old images ignores that setting and keeps only the running image."
                  options={[
                    { value: "false", label: "Keep retained images" },
                    { value: "true", label: "Delete all old images" },
                  ]}
                  value={yesNo(toggles.disableApplicationImageRetention)}
                  onChange={toggle("disableApplicationImageRetention")}
                  disabled={!canUpdate}
                />
              </div>
            </SettingsSubsection>
          </SettingsSection>
        </form>

        <SettingsSection id="docker-cleanup-executions-section" title="Recent executions" helper="Review cleanup status, duration, and command output." flush>
          <Empty title="No cleanup executions" description="Run a manual cleanup or wait for the next scheduled execution." iconName="storages" />
        </SettingsSection>
      </div>
    </ServerWorkspace>
  );
}

export function ServerDockerCleanupPage() {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle="Docker Cleanup">
      <ServerDockerCleanupContent />
    </Layout>
  );
}
