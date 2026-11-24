// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/advanced.blade.php and
// app/Livewire/Server/Advanced.php (Apache-2.0), modified.
//
// /server/{uuid}/advanced: disk usage checks, backup compression and build
// limits. Only deploy.server_settings is read and written.
import { useEffect, useState, type FormEvent } from "react";
import { Layout } from "../layout/Layout";
import { FormInput, Listbox, SettingsSection, UnsavedBar } from "../components/Coolify";
import { limit, ServerWorkspace, useServerSection } from "./ServerChrome";

interface Advanced {
  serverDiskUsageCheckFrequency: string;
  serverDiskUsageNotificationThreshold: number;
  serverDiskUsageNotificationIntervalHours: number;
  concurrentBuilds: number;
  dynamicTimeout: number;
  deploymentQueueLimit: number;
  backupCompressionCpuPercentage: number;
}

/** The form's fields (wire:model), as typed. */
type Form = Record<Exclude<keyof Advanced, "backupCompressionCpuPercentage">, string>;
const formOf = (a: Advanced): Form => ({
  serverDiskUsageCheckFrequency: a.serverDiskUsageCheckFrequency,
  serverDiskUsageNotificationThreshold: String(a.serverDiskUsageNotificationThreshold),
  serverDiskUsageNotificationIntervalHours: String(a.serverDiskUsageNotificationIntervalHours),
  concurrentBuilds: String(a.concurrentBuilds),
  dynamicTimeout: String(a.dynamicTimeout),
  deploymentQueueLimit: String(a.deploymentQueueLimit),
});

const CPU_OPTIONS = [
  { value: "25", label: "Low (25%)" },
  { value: "50", label: "Balanced (50%)" },
  { value: "75", label: "High (75%)" },
  { value: "100", label: "Maximum (100%)" },
];

const title = (name: string) => `${limit(name, 10)} > Advanced | Freeploy`;

function ServerAdvancedContent() {
  const { me, data, errors, saving, save } = useServerSection<Advanced>("advanced", title);
  const [form, setForm] = useState<Form | null>(null);
  const [cpu, setCpu] = useState("25");
  useEffect(() => {
    if (!data) return;
    setForm(formOf(data.settings));
    setCpu(String(data.settings.backupCompressionCpuPercentage));
  }, [data]);
  if (!data || !form) return null;
  const { server, settings, canUpdate } = data;
  const saved = formOf(settings);
  const dirty = (Object.keys(form) as Array<keyof Form>).some((k) => form[k] !== saved[k]);
  const set = (k: keyof Form) => (v: string) => setForm({ ...form, [k]: v });
  /** submit() and instantSave() save the whole form. */
  const body = (cpuValue = cpu) => ({ ...form, backupCompressionCpuPercentage: cpuValue });
  const submit = () => void save(body());

  return (
    <ServerWorkspace server={server} orgId={me.team?.id} active="advanced" canUpdate={canUpdate}>
      <form
        className="application-settings-form flex w-full flex-col gap-6"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          submit();
        }}
      >
        <UnsavedBar dirty={dirty} saving={saving} onSave={submit} />

        <SettingsSection id="server-disk-usage-section" title="Disk usage" helper="Control when Freeploy checks this server and when your team is notified.">
          <div className="grid gap-4 lg:grid-cols-3">
            <FormInput
              id="serverDiskUsageCheckFrequency"
              label="Check frequency"
              placeholder="0 23 * * *"
              required
              helper="Cron expression or preset such as hourly, daily, weekly, monthly, or yearly."
              disabled={!canUpdate}
              value={form.serverDiskUsageCheckFrequency}
              onChange={set("serverDiskUsageCheckFrequency")}
              error={errors.serverDiskUsageCheckFrequency}
            />
            <FormInput
              id="serverDiskUsageNotificationThreshold"
              type="number"
              min={1}
              max={99}
              label="Notification threshold"
              required
              helper="Notify the team when root filesystem usage exceeds this percentage."
              disabled={!canUpdate}
              value={form.serverDiskUsageNotificationThreshold}
              onChange={set("serverDiskUsageNotificationThreshold")}
              error={errors.serverDiskUsageNotificationThreshold}
            />
            <FormInput
              id="serverDiskUsageNotificationIntervalHours"
              type="number"
              min={1}
              max={720}
              label="Notification interval (hours)"
              required
              helper="Minimum time between high disk usage notifications for this server."
              disabled={!canUpdate}
              value={form.serverDiskUsageNotificationIntervalHours}
              onChange={set("serverDiskUsageNotificationIntervalHours")}
              error={errors.serverDiskUsageNotificationIntervalHours}
            />
          </div>
        </SettingsSection>

        <SettingsSection id="server-backups-section" title="Backups" helper="Limit how much CPU volume backup compression may use on this server.">
          <Listbox
            id="backupCompressionCpuPercentage"
            label="Backup compression CPU"
            helper="Sets how many CPU threads can be used to compress volume backups, based on this server's available CPUs."
            options={CPU_OPTIONS}
            value={cpu}
            disabled={!canUpdate}
            error={errors.backupCompressionCpuPercentage}
            onChange={(v) => {
              setCpu(v);
              void save(body(v), true);
            }}
          />
        </SettingsSection>

        <SettingsSection id="server-builds-section" title="Builds" helper="Set deployment concurrency, execution timeouts, and queue capacity.">
          <div className="grid gap-4 lg:grid-cols-3">
            <FormInput
              id="concurrentBuilds"
              type="number"
              min={1}
              label="Concurrent builds"
              required
              helper="Maximum deployments that can build at the same time."
              disabled={!canUpdate}
              value={form.concurrentBuilds}
              onChange={set("concurrentBuilds")}
              error={errors.concurrentBuilds}
            />
            <FormInput
              id="dynamicTimeout"
              type="number"
              min={1}
              label="Deployment timeout"
              required
              helper="Maximum deployment duration in seconds."
              disabled={!canUpdate}
              value={form.dynamicTimeout}
              onChange={set("dynamicTimeout")}
              error={errors.dynamicTimeout}
            />
            <FormInput
              id="deploymentQueueLimit"
              type="number"
              min={1}
              label="Queue limit"
              required
              helper="Maximum queued deployments before new requests are rejected."
              disabled={!canUpdate}
              value={form.deploymentQueueLimit}
              onChange={set("deploymentQueueLimit")}
              error={errors.deploymentQueueLimit}
            />
          </div>
        </SettingsSection>
      </form>
    </ServerWorkspace>
  );
}

export function ServerAdvancedPage() {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle="Advanced">
      <ServerAdvancedContent />
    </Layout>
  );
}
