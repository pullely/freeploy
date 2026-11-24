// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/shared/resource-limits.blade.php
// and app/Livewire/Project/Shared/ResourceLimits.php (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/application/{app_uuid}/resource-limits
// (project.application.resource-limits): the container's CPU and memory
// limits. They are stored and apply at the next deployment.
import { useEffect, useState, type FormEvent } from "react";
import { Layout } from "../layout/Layout";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { FormInput, SettingsSection, UnsavedBar } from "../components/Coolify";
import { ApplicationWorkspace } from "./ApplicationChrome";
import { useApplicationSection, type ApplicationSectionData } from "./ApplicationSection";

interface Limits {
  limitsCpus: string;
  limitsCpuset: string | null;
  limitsCpuShares: number;
  limitsMemory: string;
  limitsMemorySwap: string;
  limitsMemorySwappiness: number;
  limitsMemoryReservation: string;
}

interface Data extends ApplicationSectionData {
  settings: Limits;
}

/** The form's fields (wire:model), as typed. */
type Form = Record<keyof Limits, string>;
const formOf = (l: Limits): Form => ({
  limitsCpus: l.limitsCpus,
  limitsCpuset: l.limitsCpuset ?? "",
  limitsCpuShares: String(l.limitsCpuShares),
  limitsMemory: l.limitsMemory,
  limitsMemorySwap: l.limitsMemorySwap,
  limitsMemorySwappiness: String(l.limitsMemorySwappiness),
  limitsMemoryReservation: l.limitsMemoryReservation,
});

function ApplicationResourceLimitsContent() {
  const { me, data, setData, saving, patch } = useApplicationSection<Data>("resource-limits");
  const [form, setForm] = useState<Form | null>(null);
  useEffect(() => {
    if (data) setForm(formOf(data.settings));
  }, [data]);
  if (!data || !form) return null;
  const { application, canUpdate } = data;
  const saved = formOf(data.settings);
  const dirty = (Object.keys(form) as Array<keyof Form>).some((k) => form[k] !== saved[k]);
  const field = (name: keyof Form) => ({ id: name, value: form[name], onChange: (v: string) => setForm({ ...form, [name]: v }), disabled: !canUpdate });

  /** ResourceLimits::submit(): a validation error is one error toast per message. */
  const submit = async () => {
    const r = await patch<{ settings: Limits; message: string | null }>(form);
    if (!r.ok) {
      const messages = r.error.messages.length ? r.error.messages : [r.error.message];
      for (const message of messages) notify.error(message);
      return;
    }
    setData({ ...data, settings: r.data.settings });
    if (r.data.message) notify.success(r.data.message);
  };

  return (
    <ApplicationWorkspace application={application} orgId={me.team?.id} active="Resource Limits" canUpdate={canUpdate} canDeploy={data.canDeploy}>
      <form
        className="application-settings-form flex flex-col gap-6"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          void submit();
        }}
      >
        <UnsavedBar dirty={dirty} saving={saving} onSave={() => void submit()} />

        <SettingsSection
          id="cpu-limits-section"
          title="CPU"
          helper="Limit CPU capacity, affinity, and scheduling priority for this container."
          actions={
            <a className="button" target="_blank" rel="noopener noreferrer" href="https://docs.docker.com/engine/containers/resource_constraints/#cpu">
              Docker CPU constraints
              <Reicon name="external-link" className="size-3.5" />
            </a>
          }
        >
          <div className="grid gap-4 md:grid-cols-3">
            <FormInput {...field("limitsCpus")} placeholder="1.5" helper="Set to 0 to use all available CPUs. Decimal values such as 0.5 are supported." label="CPU limit" />
            <FormInput {...field("limitsCpuset")} placeholder="0-2" helper="Restrict execution to specific cores, for example 0-2 or 0,1,3. Leave empty for all cores." label="CPU set" />
            <FormInput {...field("limitsCpuShares")} placeholder="1024" helper="Relative CPU scheduling weight. Docker uses 1024 by default." label="CPU weight" />
          </div>
        </SettingsSection>

        <SettingsSection id="memory-limits-section" title="Memory" helper="Set hard and soft memory limits, swap allowance, and swappiness.">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormInput {...field("limitsMemoryReservation")} helper="Soft reservation used when the host is under memory pressure. Use values such as 256m or 1g." label="Memory reservation" />
            <FormInput {...field("limitsMemory")} helper="Maximum memory available to the container. Set to 0 for unlimited." label="Memory limit" />
            <FormInput {...field("limitsMemorySwap")} helper="Combined memory and swap allowance. Use values such as 512m or 2g." label="Memory and swap limit" />
            <FormInput
              {...field("limitsMemorySwappiness")}
              helper="Controls how aggressively anonymous memory is swapped. Enter a value from 0 to 100."
              type="number"
              min={0}
              max={100}
              label="Swappiness"
            />
          </div>
          <p className="mt-4 text-xs leading-5 text-neutral-500 dark:text-fg-dim">
            Accepted units are <code className="font-mono">b</code>, <code className="font-mono">k</code>, <code className="font-mono">m</code>, and <code className="font-mono">g</code>.
          </p>
        </SettingsSection>
      </form>
    </ApplicationWorkspace>
  );
}

export function ApplicationResourceLimitsPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
      <ApplicationResourceLimitsContent />
    </Layout>
  );
}
