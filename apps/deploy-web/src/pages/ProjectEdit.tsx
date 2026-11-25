// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/{edit,delete-project}.blade.php
// and app/Livewire/Project/{Edit,DeleteProject}.php (Apache-2.0), modified.
//
// /project/{uuid}/edit: the project's name and description, and deleting the
// project once it is empty. The project icon (upload, remove) is not ported.
// Coolify's route answers 403 to a member who cannot update the project; here
// that member is sent back to the project.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { FormInput, ModalConfirmation, UnsavedBar } from "../components/Coolify";
import { limit, ProjectBreadcrumb, projectPath, projectsApi, projectUuidFromPath, type ProjectShowData } from "./ProjectChrome";

interface Details {
  name: string;
  description: string;
}

function ProjectEditContent() {
  const { me } = useSignedIn();
  const uuid = projectUuidFromPath();
  const base = `${projectsApi(me.team?.id)}/${encodeURIComponent(uuid)}`;
  const [data, setData] = useState<ProjectShowData | null>(null);
  const [form, setForm] = useState<Details | null>(null);
  const [saved, setSaved] = useState<Details | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await getJson<ProjectShowData>(base);
      if (!r.data) {
        if (r.status === 404) window.location.replace("/projects");
        return;
      }
      if (!r.data.canUpdate) return window.location.replace(projectPath(uuid));
      const details = { name: r.data.project.name, description: r.data.project.description ?? "" };
      setData(r.data);
      setForm(details);
      setSaved(details);
    })();
  }, [base, uuid]);
  useEffect(() => {
    if (data) document.title = `${limit(data.project.name, 10)} > Edit | Freeploy`;
  }, [data]);

  /** Edit::submit(): syncData(true), dispatch('success', 'Project updated.'). */
  const submit = useCallback(async () => {
    if (!form) return;
    setSaving(true);
    const r = await postJson<{ name: string; description: string | null; message: string }>(base, form, "PATCH");
    setSaving(false);
    if (!r.ok) {
      const fields = r.error.fields ?? {};
      const inline: Record<string, string> = {};
      for (const f of ["name", "description"]) if (fields[f]?.[0]) inline[f] = fields[f][0];
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    setErrors({});
    const details = { name: r.data.name, description: r.data.description ?? "" };
    setForm(details);
    setSaved(details);
    setData((d) => (d ? { ...d, project: { ...d.project, name: r.data.name, description: r.data.description } } : d));
    notify.success(r.data.message);
  }, [base, form]);

  /** DeleteProject::delete(): then redirectRoute('project.index'). */
  async function remove() {
    const r = await postJson<{ deleted: boolean }>(base, {}, "DELETE");
    if (!r.ok) return notify.error(summarize(r.error.messages));
    window.location.assign("/projects");
  }

  if (!data || !form || !saved) return null;
  const { project } = data;
  const dirty = form.name !== saved.name || form.description !== saved.description;

  return (
    <div>
      <ProjectBreadcrumb orgId={me.team?.id} project={project} />
      <div className="w-full max-w-none">
        <header className="mb-5">
          <h1 className="truncate text-[24px]! leading-7! font-semibold! tracking-tight!">{project.name}</h1>
          <p className="mt-1 text-[13px] text-neutral-500 dark:text-fg-dim">Project settings</p>
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
                  <h2>Project details</h2>
                  <p>Icon, name, and description shown across the dashboard.</p>
                </div>
              </div>
              <div className="application-settings-section-body grid gap-4 sm:grid-cols-2">
                <FormInput label="Name" id="name" value={form.name} onChange={(name) => setForm({ ...form, name })} error={errors.name} />
                <FormInput label="Description" id="description" value={form.description} onChange={(description) => setForm({ ...form, description })} error={errors.description} />
              </div>
            </section>
          </form>

          <section className="overflow-hidden rounded-[10px] border border-red-300 bg-red-50/80 dark:border-red-500/25 dark:bg-red-500/[0.06]">
            <div className="flex items-start justify-between gap-4 px-5 py-4">
              <div>
                <h2 className="text-sm font-semibold text-red-800 dark:text-red-300">Delete project</h2>
                <p className="mt-1 max-w-2xl text-sm text-red-700/80 dark:text-red-200/70">Empty the project before permanently deleting it.</p>
              </div>
              <ModalConfirmation
                title="Confirm Project Deletion?"
                buttonTitle="Delete Project"
                disabled={!project.isEmpty || !data.canDelete}
                actions={["This will delete the selected project", "All Environments inside the project will be deleted as well."]}
                confirmationLabel="Please confirm the execution of the actions by entering the Project Name below"
                shortConfirmationLabel="Project Name"
                confirmationText={project.name}
                step2ButtonText="Permanently Delete"
                onSubmit={remove}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export function ProjectEditPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Edit">
      <ProjectEditContent />
    </Layout>
  );
}
