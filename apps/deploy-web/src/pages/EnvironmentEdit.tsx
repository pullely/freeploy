// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/{environment-edit,
// delete-environment}.blade.php and app/Livewire/Project/{EnvironmentEdit,DeleteEnvironment}.php
// (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/edit: the environment's name and
// description, and deleting the environment once it is empty. "Clone
// environment" leads to a page that is not ported yet. Coolify's route answers
// 403 to a member who cannot update the environment; here that member is sent
// back to the environment.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { FormInput, ModalConfirmation, UnsavedBar } from "../components/Coolify";
import { environmentPath, environmentUuidFromPath, limit, ProjectBreadcrumb, projectPath, projectsApi, projectUuidFromPath, type EnvironmentShowData } from "./ProjectChrome";

interface Details {
  name: string;
  description: string;
}

function EnvironmentEditContent() {
  const { me } = useSignedIn();
  const projectUuid = projectUuidFromPath();
  const environmentUuid = environmentUuidFromPath();
  const base = `${projectsApi(me.team?.id)}/${encodeURIComponent(projectUuid)}/environments/${encodeURIComponent(environmentUuid)}`;
  const [data, setData] = useState<EnvironmentShowData | null>(null);
  const [form, setForm] = useState<Details | null>(null);
  const [saved, setSaved] = useState<Details | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await getJson<EnvironmentShowData>(base);
      if (!r.data) {
        if (r.status === 404) window.location.replace("/projects");
        return;
      }
      if (!r.data.canUpdate) return window.location.replace(environmentPath(projectUuid, environmentUuid));
      const details = { name: r.data.environment.name, description: r.data.environment.description ?? "" };
      setData(r.data);
      setForm(details);
      setSaved(details);
    })();
  }, [base, projectUuid, environmentUuid]);
  useEffect(() => {
    if (data) document.title = `${limit(data.environment.name, 10)} > Edit | Freeploy`;
  }, [data]);

  /** EnvironmentEdit::submit(): syncData(true), then the page loads again (redirectRoute('project.environment.edit')). */
  const submit = useCallback(async () => {
    if (!form) return;
    setSaving(true);
    const r = await postJson<{ uuid: string }>(base, form, "PATCH");
    if (!r.ok) {
      setSaving(false);
      const fields = r.error.fields ?? {};
      const inline: Record<string, string> = {};
      for (const f of ["name", "description"]) if (fields[f]?.[0]) inline[f] = fields[f][0];
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    window.location.assign(`${environmentPath(projectUuid, r.data.uuid)}/edit`);
  }, [base, form, projectUuid]);

  /** DeleteEnvironment::delete(): then redirectRoute('project.show'). */
  async function remove() {
    const r = await postJson<{ deleted: boolean }>(base, {}, "DELETE");
    if (!r.ok) return notify.error(summarize(r.error.messages));
    window.location.assign(projectPath(projectUuid));
  }

  if (!data || !form || !saved) return null;
  const { project, environment } = data;
  const dirty = form.name !== saved.name || form.description !== saved.description;

  return (
    <div>
      <ProjectBreadcrumb orgId={me.team?.id} project={project} environment={environment} />
      <div className="w-full max-w-none">
        <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="truncate text-[24px]! leading-7! font-semibold! tracking-tight!">{environment.name}</h1>
            <p className="mt-1 text-[13px] text-neutral-500 dark:text-fg-dim">Environment settings in {project.name}</p>
          </div>
          <div className="flex w-fit shrink-0 items-center gap-2">
            <a className="button whitespace-nowrap" href={`${environmentPath(project.uuid, environment.uuid)}/clone`}>
              <Reicon name="layers" className="size-3.5 opacity-70" />
              Clone environment
            </a>
          </div>
        </header>

        <div className="flex flex-col gap-6">
          <form
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              void submit();
            }}
          >
            <UnsavedBar dirty={dirty} saving={saving} onSave={() => void submit()} />
            <section className="application-settings-section">
              <div className="application-settings-section-header">
                <div>
                  <h2>Environment details</h2>
                  <p>Name and describe this environment inside {project.name}.</p>
                </div>
              </div>
              <div className="application-settings-section-body grid gap-4 sm:grid-cols-2">
                <FormInput label="Name" id="name" value={form.name} onChange={(name) => setForm({ ...form, name })} error={errors.name} />
                <FormInput label="Description" id="description" value={form.description} onChange={(description) => setForm({ ...form, description })} error={errors.description} />
              </div>
            </section>
          </form>

          {data.canDelete ? (
            <section className="overflow-hidden rounded-[10px] border border-red-300 bg-red-50/80 dark:border-red-500/25 dark:bg-red-500/[0.06]">
              <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-red-800 dark:text-red-300">Delete environment</h2>
                  <p className="mt-1 max-w-2xl text-sm text-red-700/80 dark:text-red-200/70">Remove every resource before permanently deleting this environment.</p>
                </div>
                <div className="shrink-0 sm:pt-0.5">
                  <ModalConfirmation
                    title="Confirm Environment Deletion?"
                    buttonTitle="Delete"
                    disabled={!environment.isEmpty}
                    actions={["This will delete the selected environment."]}
                    confirmationLabel="Please confirm the execution of the actions by entering the Environment Name below"
                    shortConfirmationLabel="Environment Name"
                    confirmationText={environment.name}
                    step2ButtonText="Permanently Delete"
                    onSubmit={remove}
                  />
                </div>
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function EnvironmentEditPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Edit">
      <EnvironmentEditContent />
    </Layout>
  );
}
