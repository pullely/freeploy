// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/shared/scheduled-task/{all,add,show,executions}.blade.php
// and app/Livewire/Project/Shared/ScheduledTask/{All,Add,Show,Executions}.php (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/application/{app_uuid}/scheduled-tasks
// (project.application.scheduled-tasks): commands run inside the application
// on a cron schedule. A task opens in a dialog (?task_uuid=…, as Coolify's
// #[Url]) with its configuration, its executions and its deletion.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Layout } from "../layout/Layout";
import { getJson } from "../lib/api";
import { Reicon } from "../components/Reicon";
import { Button, Checkbox, DangerZone, Empty, FormInput, ModalConfirmation, ModalInput, SettingsSection, StatusBadge, UnsavedBar } from "../components/Coolify";
import { applicationsApi, ApplicationWorkspace } from "./ApplicationChrome";
import { inlineErrors, useApplicationSection, type ApplicationSectionData } from "./ApplicationSection";
import { sendJson, showError, showSaved } from "./ApplicationResource";

interface TaskItem {
  uuid: string;
  name: string;
  enabled: boolean;
  container: string | null;
  frequency: string;
  status: string | null;
}

interface TaskDetail {
  uuid: string;
  name: string;
  command: string;
  frequency: string;
  container: string | null;
  timeout: number;
  useShell: boolean;
  isEnabled: boolean;
  disabledReason: string | null;
}

interface Execution {
  id: string;
  status: string;
  createdAt: string | null;
  finishedAt: string | null;
  message: string | null;
}

interface Tasks {
  tasks: TaskItem[];
  containerNames: string[];
  serverTimezone: string;
  isRunning: boolean;
}

type Data = ApplicationSectionData & Tasks;
type Saved = Tasks & { message: string; task?: TaskDetail };
type TaskPage = Tasks & { task: TaskDetail; executions: Execution[] };

const SHELL_HELPER =
  "Run the command with sh -c, so you can use variables, pipes, and redirects. Turn it off for containers without a shell (distroless or scratch images): Freeploy then splits the command into arguments and runs it directly.";
const scheduleHelper = (timezone: string) => `Use every_minute, hourly, daily, weekly, monthly, yearly, or a cron expression. Runs in the server timezone (${timezone}). Change it in the server settings.`;
const TYPE: Record<string, "success" | "error" | "warning"> = { success: "success", failed: "error", running: "warning" };
const LABEL: Record<string, string> = { success: "Success", failed: "Failed", running: "Running" };
const ICON = "flex shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500 ring-1 ring-neutral-200 dark:bg-white/[0.05] dark:text-fg-dim dark:ring-white/[0.07]";

const EMPTY_FORM = { name: "", command: "", frequency: "", container: "", timeout: "300", useShell: true };

/** scheduled-task/add.blade.php */
function AddTask({ base, timezone, onAdded }: { base: string; timezone: string; onAdded: (saved: Saved) => void }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (field: "name" | "command" | "frequency" | "container" | "timeout") => (value: string) => setForm({ ...form, [field]: value });
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = await sendJson<Saved>("POST", base, form);
    if (!r.ok) {
      setErrors(inlineErrors(r.error));
      if (!r.error.messages.length) showError(r.error);
      return;
    }
    // Add::clear()
    setForm(EMPTY_FORM);
    setErrors({});
    onAdded(r.data);
  }
  return (
    <form className="flex w-full flex-col gap-4" onSubmit={(e) => void submit(e)}>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormInput placeholder="Database cleanup" id="name" label="Name" value={form.name} onChange={set("name")} error={errors.name} />
        <FormInput placeholder="0 0 * * * or daily" helper={scheduleHelper(timezone)} id="frequency" label="Schedule" value={form.frequency} onChange={set("frequency")} error={errors.frequency} />
      </div>
      <FormInput placeholder="php artisan schedule:run" id="command" label="Command" value={form.command} onChange={set("command")} error={errors.command} />
      <Checkbox id="useShell" label="Run in a shell" helper={SHELL_HELPER} checked={form.useShell} onChange={(useShell) => setForm({ ...form, useShell })} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormInput type="number" placeholder="300" id="timeout" helper="Maximum execution time from 60 to 36,000 seconds." label="Timeout (seconds)" value={form.timeout} onChange={set("timeout")} error={errors.timeout} />
        <FormInput placeholder="php" id="container" helper="Leave empty when the resource only has one container." label="Container" value={form.container} onChange={set("container")} error={errors.container} />
      </div>
      <div className="flex justify-end border-t border-neutral-200 pt-4 dark:border-white/[0.07]">
        <Button type="submit">Add task</Button>
      </div>
    </form>
  );
}

/** scheduled-task/executions.blade.php */
function Executions({ executions }: { executions: Execution[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  if (executions.length === 0) return <Empty size="sm" title="No executions yet" description="Run this task now or wait for its next scheduled execution." iconName="browser-terminal" />;
  return (
    <>
      {executions.map((execution) => (
        <div key={execution.id} className="border-b border-neutral-200 last:border-b-0 dark:border-white/[0.07]">
          <button
            type="button"
            onClick={() => setSelected(selected === execution.id ? null : execution.id)}
            className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-white/[0.025]"
          >
            <div className={`${ICON} size-8`}>
              <Reicon name="browser-terminal" className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-black dark:text-fg">{execution.createdAt}</p>
              <p className="mt-0.5 text-xs text-neutral-500 dark:text-fg-dim">{execution.status === "running" ? "In progress" : `finished ${execution.finishedAt ?? ""}`}</p>
            </div>
            <StatusBadge label={LABEL[execution.status] ?? execution.status.charAt(0).toUpperCase() + execution.status.slice(1)} type={TYPE[execution.status] ?? "neutral"} />
          </button>
          {selected === execution.id ? (
            <div className="border-t border-neutral-200 bg-neutral-50 p-4 dark:border-white/[0.07] dark:bg-black/10">
              {execution.message ? (
                <pre className="max-h-[600px] overflow-y-auto whitespace-pre-wrap rounded-lg bg-neutral-950 p-4 font-mono text-xs leading-5 text-neutral-200 ring-1 ring-black/20 scrollbar">{execution.message}</pre>
              ) : (
                <p className="text-[13px] text-neutral-500 dark:text-fg-dim">{execution.status === "running" ? "Waiting for output…" : "No output was recorded for this execution."}</p>
              )}
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
}

/** scheduled-task/show.blade.php */
function ShowTask(props: { base: string; page: TaskPage; canUpdate: boolean; onSaved: (saved: Saved) => void; onDeleted: (saved: Saved) => void }) {
  const { page, canUpdate } = props;
  const { task } = page;
  const base = `${props.base}/${encodeURIComponent(task.uuid)}`;
  const [section, setSection] = useState<"general" | "executions" | "danger">("general");
  const initial = { name: task.name, command: task.command, frequency: task.frequency, container: task.container ?? "", timeout: String(task.timeout), useShell: task.useShell };
  const [form, setForm] = useState(initial);
  const [loaded, setLoaded] = useState(initial);
  const [isEnabled, setIsEnabled] = useState(task.isEnabled);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const set = (field: "name" | "command" | "frequency" | "container" | "timeout") => (value: string) => setForm({ ...form, [field]: value });
  const dirty = canUpdate && (Object.keys(form) as Array<keyof typeof form>).some((k) => form[k] !== loaded[k]);

  /** Show::submit() */
  async function submit() {
    setSaving(true);
    const r = await sendJson<Saved>("PATCH", base, { ...form, isEnabled });
    setSaving(false);
    if (!r.ok) {
      setErrors(inlineErrors(r.error));
      if (!r.error.messages.length) showError(r.error);
      return;
    }
    setErrors({});
    if (r.data.task) {
      const t = r.data.task;
      const next = { name: t.name, command: t.command, frequency: t.frequency, container: t.container ?? "", timeout: String(t.timeout), useShell: t.useShell };
      setForm(next);
      setLoaded(next);
    }
    props.onSaved(r.data);
  }

  async function action(path: "toggle" | "execute") {
    const r = await sendJson<Saved>("POST", `${base}/${path}`);
    if (!r.ok) return showError(r.error);
    if (r.data.task) setIsEnabled(r.data.task.isEnabled);
    props.onSaved(r.data);
  }

  async function remove() {
    const r = await sendJson<Saved>("DELETE", base);
    if (!r.ok) return showError(r.error);
    props.onDeleted(r.data);
  }

  const sections: Array<["general" | "executions" | "danger", string]> = [["general", "General"], ["executions", "Executions"], ...(canUpdate ? [["danger", "Danger Zone"] as ["danger", string]] : [])];
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <nav aria-label="Scheduled task sections" className="flex min-w-0 flex-wrap gap-1 border-b border-neutral-200 pb-2 dark:border-white/[0.08]">
        {sections.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setSection(key)}
            className={`inline-flex h-8 shrink-0 cursor-pointer items-center rounded-md px-3 text-[13px] font-medium transition-colors ${
              section === key
                ? "bg-coollabs/10 text-coollabs ring-1 ring-coollabs/25 dark:bg-brand/15 dark:text-brand-light dark:ring-brand-light/25"
                : "text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:text-fg-dim dark:hover:bg-white/[0.06] dark:hover:text-fg"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {section === "general" ? (
        <form
          className="application-settings-form flex flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <UnsavedBar dirty={dirty} saving={saving} onSave={() => void submit()} />
          <SettingsSection
            id="task-configuration-section"
            title="Task configuration"
            helper="Configure when this task runs and which command Freeploy executes."
            actions={
              canUpdate ? (
                <>
                  {page.isRunning ? <Button onClick={() => void action("execute")}>Execute now</Button> : null}
                  <Button highlighted={!isEnabled} onClick={() => void action("toggle")}>
                    {isEnabled ? "Disable" : "Enable"}
                  </Button>
                </>
              ) : undefined
            }
          >
            <div className="grid gap-4 md:grid-cols-2">
              <FormInput disabled={!canUpdate} placeholder="Name" id="name" label="Name" required value={form.name} onChange={set("name")} error={errors.name} />
              <FormInput disabled={!canUpdate} placeholder="0 0 * * * or daily" id="frequency" label="Schedule" helper={scheduleHelper(page.serverTimezone)} required value={form.frequency} onChange={set("frequency")} error={errors.frequency} />
              <FormInput disabled={!canUpdate} type="number" placeholder="300" id="timeout" helper="Maximum execution time from 60 to 36,000 seconds." label="Timeout (seconds)" required value={form.timeout} onChange={set("timeout")} error={errors.timeout} />
              <FormInput disabled={!canUpdate} placeholder="php" helper="Leave empty when the resource only has one container." id="container" label="Container" value={form.container} onChange={set("container")} error={errors.container} />
            </div>
            <div className="mt-4">
              <FormInput disabled={!canUpdate} placeholder="php artisan schedule:run" id="command" label="Command" required value={form.command} onChange={set("command")} error={errors.command} />
            </div>
            <div className="mt-2 md:w-1/2">
              <Checkbox disabled={!canUpdate} id="useShell" label="Run in a shell" helper={SHELL_HELPER} checked={form.useShell} onChange={(useShell) => setForm({ ...form, useShell })} />
            </div>
          </SettingsSection>
        </form>
      ) : null}

      {section === "executions" ? (
        <SettingsSection id="task-executions-section" title="Recent executions" helper="Execution history refreshes automatically while a task is running." flush>
          <Executions executions={page.executions} />
        </SettingsSection>
      ) : null}

      {section === "danger" && canUpdate ? (
        <div className="application-settings-form">
          <SettingsSection title="Delete scheduled task" helper="Permanently remove this task and its execution history.">
            <DangerZone
              title="This action cannot be undone."
              action={
                <ModalConfirmation
                  title="Delete scheduled task?"
                  buttonTitle="Delete task"
                  actions={["The selected scheduled task will be permanently deleted."]}
                  confirmationText={task.name}
                  confirmationLabel="Enter the scheduled task name to confirm deletion"
                  shortConfirmationLabel="Task name"
                  step2ButtonText="Permanently delete"
                  onSubmit={remove}
                />
              }
            >
              <p>The task stops running and cannot be restored.</p>
            </DangerZone>
          </SettingsSection>
        </div>
      ) : null}
    </div>
  );
}

function ApplicationScheduledTasksContent() {
  const { me, data, setData } = useApplicationSection<Data>("scheduled-tasks");
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<TaskPage | null>(null);
  const base = `${applicationsApi(me.team?.id)}/${encodeURIComponent(data?.application.uuid ?? "")}/scheduled-tasks`;

  /** All::openTask(): the task in the dialog, and its uuid in the URL. */
  const openTask = useCallback(
    async (uuid: string) => {
      const r = await getJson<TaskPage>(`${base}/${encodeURIComponent(uuid)}`);
      if (!r.data) return;
      setOpen(r.data);
      const url = new URL(window.location.href);
      url.searchParams.set("task_uuid", uuid);
      window.history.replaceState(null, "", url);
    },
    [base],
  );
  /** All::closeTask() */
  const closeTask = useCallback(() => {
    setOpen(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("task_uuid");
    window.history.replaceState(null, "", url);
  }, []);
  const ready = data !== null;
  useEffect(() => {
    // All::mount(): #[Url(as: 'task_uuid')]
    const uuid = new URL(window.location.href).searchParams.get("task_uuid");
    if (ready && uuid) void openTask(uuid);
  }, [ready, openTask]);
  if (!data) return null;
  const { application, canUpdate } = data;
  const apply = (saved: Saved) => {
    setData({ ...data, tasks: saved.tasks, containerNames: saved.containerNames, serverTimezone: saved.serverTimezone, isRunning: saved.isRunning });
    showSaved(saved);
  };

  return (
    <ApplicationWorkspace application={application} orgId={me.team?.id} active="Scheduled Tasks" canUpdate={canUpdate} canDeploy={data.canDeploy}>
      <div>
        {open ? (
          <ModalInput title="Edit scheduled task" subtitle={open.task.name} open onOpenChange={(next) => (next ? undefined : closeTask())}>
            <ShowTask key={open.task.uuid} base={base} page={open} canUpdate={canUpdate} onSaved={(saved) => (apply(saved), saved.task ? setOpen({ ...open, task: saved.task }) : undefined)} onDeleted={(saved) => (closeTask(), apply(saved))} />
          </ModalInput>
        ) : null}

        <SettingsSection
          id="scheduled-tasks-section"
          title="Scheduled tasks"
          helper="Run commands inside this resource automatically using a cron schedule."
          flush
          actions={
            canUpdate ? (
              <ModalInput
                title="New scheduled task"
                closeOutside={false}
                open={adding}
                onOpenChange={setAdding}
                trigger={
                  <button type="button" className="button button-highlighted">
                    <Reicon name="plus" className="size-3.5" />
                    Add task
                  </button>
                }
              >
                <AddTask base={base} timezone={data.serverTimezone} onAdded={(saved) => (setAdding(false), apply(saved))} />
              </ModalInput>
            ) : undefined
          }
        >
          {data.tasks.length ? (
            data.tasks.map((task) => (
              <div
                key={task.uuid}
                onClick={() => void openTask(task.uuid)}
                onKeyDown={(e) => e.key === "Enter" && void openTask(task.uuid)}
                role="button"
                tabIndex={0}
                className="group flex cursor-pointer items-center gap-3 border-b border-neutral-200 px-4 py-3.5 transition-colors last:border-b-0 hover:bg-neutral-50 dark:border-white/[0.07] dark:hover:bg-white/[0.025]"
              >
                <div className={`${ICON} size-9`}>
                  <Reicon name="browser-terminal" className="size-[18px]" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="truncate text-sm font-semibold text-black dark:text-fg">{task.name}</h4>
                    {task.enabled ? null : <StatusBadge label="Disabled" />}
                    {task.container ? <code className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-600 dark:bg-white/[0.05] dark:text-fg-dim">{task.container}</code> : null}
                  </div>
                  <p className="mt-1 text-[13px] text-neutral-500 dark:text-fg-dim">
                    Runs on
                    <code className="ml-1 rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs text-neutral-700 dark:bg-white/[0.05] dark:text-fg-dim">{task.frequency}</code>
                  </p>
                </div>
                <StatusBadge label={(task.status && LABEL[task.status]) || "Not run yet"} type={(task.status && TYPE[task.status]) || "neutral"} />
              </div>
            ))
          ) : (
            <Empty title="No scheduled tasks" description="Create a task to run maintenance commands, scripts, or recurring jobs automatically." iconName="browser-terminal" />
          )}
        </SettingsSection>
      </div>
    </ApplicationWorkspace>
  );
}

export function ApplicationScheduledTasksPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
      <ApplicationScheduledTasksContent />
    </Layout>
  );
}
