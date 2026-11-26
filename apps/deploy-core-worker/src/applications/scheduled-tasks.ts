// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Shared/ScheduledTask/{All,Add,Show,Executions}.php,
// app/Models/ScheduledTask.php and bootstrap/helpers/shared.php (validate_cron_expression) (Apache-2.0), modified.
//
// An application's Scheduled Tasks page: commands run inside its container on
// a cron schedule. The tasks are rows; what runs them (the scheduler) and
// "Execute now" need the SSH executor, so a task's executions stay empty.
import type { DeployScheduledTaskExecutionRow, DeployScheduledTaskRow, ScheduledTaskChanges } from "@saas/db/deploy";
import { newPublicId } from "../helpers/names.js";
import { blank, length, type FieldErrors } from "../private-keys/validation.js";
import { validateCronExpression } from "../servers/settings-validation.js";
import type { ApplicationShow } from "./service.js";
import { SettingsError, SettingsFieldErrors } from "./settings.js";
import { needsExecutor, text } from "./resources.js";
import { booleanValue, integerOf, isRunning, loadApplication, type ApplicationMoreContext, type LoadedApplication } from "./more.js";

type Body = Record<string, unknown>;

export const TASK_TIMEOUT = { min: 60, max: 36000, default: 300 } as const;
/** deploy.scheduled_tasks stores name, command, frequency and container as VARCHAR(255). */
export const TASK_COLUMN_MAX = 255;

/** $validationAttributes of Add (Show's properties read as their own names). */
const ATTRIBUTES: Record<string, string> = { name: "name", command: "command", frequency: "frequency", container: "container", timeout: "timeout", useShell: "run in a shell" };

export const TASK_MESSAGES = {
  required: (attribute: string) => `The ${attribute} field is required.`,
  string: (attribute: string) => `The ${attribute} field must be a string.`,
  integer: (attribute: string) => `The ${attribute} field must be an integer.`,
  boolean: (attribute: string) => `The ${attribute} field must be true or false.`,
  min: (attribute: string, n: number) => `The ${attribute} field must be at least ${n}.`,
  max: (attribute: string, n: number) => `The ${attribute} field must not be greater than ${n}.`,
  maxString: (attribute: string, n: number) => `The ${attribute} field must not be greater than ${n} characters.`,
  /** Add::submit() and Show::syncData() */
  invalidCron: "Invalid Cron / Human expression.",
  added: "Scheduled task added.",
  updated: "Scheduled task updated.",
  enabled: "Scheduled task enabled.",
  disabled: "Scheduled task disabled.",
  deleted: "Scheduled task deleted.",
  /** Show::syncData(): the command of a task for who may not update the resource. */
  hiddenCommand: "Hidden (only admins can view)",
  /** Freeploy's: the SSH executor is not deployed yet. */
  executeUnavailable: needsExecutor("Running the scheduled task now"),
} as const;

export interface TaskItem {
  uuid: string;
  name: string;
  enabled: boolean;
  container: string | null;
  frequency: string;
  /** data_get($task->latest_log, 'status'): success, failed, running, or null when it never ran. */
  status: string | null;
}

export interface TaskDetail {
  uuid: string;
  name: string;
  /** Hidden for who may not update. */
  command: string;
  frequency: string;
  container: string | null;
  timeout: number;
  useShell: boolean;
  isEnabled: boolean;
  /**
   * $task->disabled_reason: why the task was disabled automatically. Nothing
   * writes it before the scheduler exists; enabling the task again clears it.
   */
  disabledReason: string | null;
}

export interface TaskExecution {
  id: string;
  status: string;
  createdAt: string | null;
  finishedAt: string | null;
  /** The output, for who may update. */
  message: string | null;
}

/** What the list answers beside the resource's frame. */
export interface TasksPageBody {
  tasks: TaskItem[];
  /**
   * All::mount(): a service's applications' and databases' names; the Compose services of a Docker Compose
   * application (Compose files are not parsed here yet: none); else none.
   */
  containerNames: string[];
  /** getServerTimezone(): the server's timezone setting. */
  serverTimezone: string;
  /** $resource->isRunning(): "Execute now" shows. */
  isRunning: boolean;
}

export interface ScheduledTasksPage extends TasksPageBody {
  application: ApplicationShow;
}

/** One task owner's rows: an application's or a service's (scheduled_tasks.application_id / service_id). */
export interface TaskRows {
  tasks(): Promise<DeployScheduledTaskRow[]>;
  findTask(uuid: string): Promise<DeployScheduledTaskRow | null>;
  insertTask(task: { uuid: string; name: string; command: string; frequency: string; container: string | null; timeout: number; useShell: boolean }): Promise<DeployScheduledTaskRow>;
  updateTask(id: string | number, changes: ScheduledTaskChanges): Promise<boolean>;
  deleteTask(id: string | number): Promise<boolean>;
  executions(taskId: string | number): Promise<DeployScheduledTaskExecutionRow[]>;
}

/** The resource All, Add and Show are given (`:resource`): an application or, since DP-97, a service. */
export interface TaskHost {
  /** $resource->type() */
  kind: "application" | "service";
  /** The page's frame: { application } or { service }. */
  frame: object;
  rows: TaskRows;
  containerNames: string[];
  serverTimezone: string;
  isRunning: boolean;
}

const item = (t: DeployScheduledTaskRow): TaskItem => ({ uuid: t.uuid, name: t.name, enabled: Boolean(t.enabled), container: t.container ?? null, frequency: t.frequency, status: t.latest_status ?? null });

const detail = (t: DeployScheduledTaskRow, canUpdate: boolean): TaskDetail => ({
  uuid: t.uuid,
  name: t.name,
  command: canUpdate ? t.command : TASK_MESSAGES.hiddenCommand,
  frequency: t.frequency,
  container: t.container ?? null,
  timeout: t.timeout ?? TASK_TIMEOUT.default,
  useShell: t.use_shell ?? true,
  isEnabled: Boolean(t.enabled),
  disabledReason: t.disabled_reason ?? null,
});

const stamp = (v: string | Date | null): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
const execution = (e: DeployScheduledTaskExecutionRow, canUpdate: boolean): TaskExecution => ({
  id: String(e.id),
  status: e.status,
  createdAt: stamp(e.created_at),
  finishedAt: stamp(e.finished_at),
  message: canUpdate ? (e.message ?? null) : null,
});

async function hostPage(host: TaskHost): Promise<TasksPageBody> {
  return { ...host.frame, tasks: (await host.rows.tasks()).map(item), containerNames: host.containerNames, serverTimezone: host.serverTimezone, isRunning: host.isRunning };
}

/** An application as All's resource. */
async function applicationHost(ctx: ApplicationMoreContext, l: LoadedApplication): Promise<TaskHost> {
  const id = l.row.id;
  return {
    kind: "application",
    frame: { application: l.application },
    rows: {
      tasks: () => ctx.store.tasks(id),
      findTask: (uuid) => ctx.store.findTask(id, uuid),
      insertTask: (t) => ctx.store.insertTask({ applicationId: id, ...t }),
      updateTask: (taskId, changes) => ctx.store.updateTask(id, taskId, changes),
      deleteTask: (taskId) => ctx.store.deleteTask(id, taskId),
      executions: (taskId) => ctx.store.executions(taskId),
    },
    containerNames: [],
    serverTimezone: (await ctx.store.rollback(l.row.uuid))?.server_timezone || "UTC",
    isRunning: isRunning(l.frame.status),
  };
}

async function hostOf(ctx: ApplicationMoreContext, uuid: string, canUpdate: boolean): Promise<TaskHost | null> {
  const l = await loadApplication(ctx, uuid, canUpdate);
  return l ? applicationHost(ctx, l) : null;
}

/** All::mount() for any resource. */
export const showHostTasks = (host: TaskHost): Promise<TasksPageBody> => hostPage(host);

/** All::mount() */
export async function showScheduledTasks(ctx: ApplicationMoreContext, uuid: string, canUpdate: boolean): Promise<ScheduledTasksPage | null> {
  const host = await hostOf(ctx, uuid, canUpdate);
  return host ? ((await hostPage(host)) as ScheduledTasksPage) : null;
}

export interface TaskPageBody extends TasksPageBody {
  task: TaskDetail;
  /** Executions::mount(): the last 20, the newest first. */
  executions: TaskExecution[];
}

export type TaskPage = TaskPageBody & ScheduledTasksPage;

/** All::openTask() with Show::mount(): one task of the resource. */
export async function showHostTask(host: TaskHost, taskUuid: string, canUpdate: boolean): Promise<TaskPageBody | null> {
  const task = await host.rows.findTask(taskUuid);
  return task ? { ...(await hostPage(host)), task: detail(task, canUpdate), executions: (await host.rows.executions(task.id)).map((e) => execution(e, canUpdate)) } : null;
}

/** All::openTask() with Show::mount(): one task of the application. */
export async function showScheduledTask(ctx: ApplicationMoreContext, uuid: string, taskUuid: string, canUpdate: boolean): Promise<TaskPage | null> {
  const host = await hostOf(ctx, uuid, canUpdate);
  return host ? ((await showHostTask(host, taskUuid, canUpdate)) as TaskPage | null) : null;
}

interface TaskInput {
  name: string;
  command: string;
  frequency: string;
  container: string | null;
  timeout: number;
  useShell: boolean;
  isEnabled?: boolean;
}

/**
 * The rules Add ($rules) and Show (#[Validate]) share: name, command and
 * frequency required strings, container a nullable string, the timeout an
 * integer from 60 to 36000, the switches booleans. `attributes` names the
 * fields as each component does. The four text columns hold 255 characters;
 * Coolify lets the database refuse a longer value, here Laravel's `max`
 * message does.
 */
function validate(body: Body, attributes: Record<string, string>, defaults: { timeout: unknown; useShell: boolean; container: unknown }, withEnabled: boolean): TaskInput {
  const errors: FieldErrors = {};
  const required = (field: string): string => {
    const value = text(body[field]);
    const attribute = attributes[field]!;
    if (blank(value)) errors[field] = [TASK_MESSAGES.required(attribute)];
    else if (typeof value !== "string") errors[field] = [TASK_MESSAGES.string(attribute)];
    else if (length(value) > TASK_COLUMN_MAX) errors[field] = [TASK_MESSAGES.maxString(attribute, TASK_COLUMN_MAX)];
    return typeof value === "string" ? value : "";
  };
  const name = required("name");
  const command = required("command");
  const frequency = required("frequency");
  const rawContainer = body.container === undefined ? defaults.container : text(body.container);
  let container: string | null = null;
  if (rawContainer !== null && rawContainer !== undefined && rawContainer !== "") {
    if (typeof rawContainer !== "string") errors.container = [TASK_MESSAGES.string(attributes.container!)];
    else if (length(rawContainer) > TASK_COLUMN_MAX) errors.container = [TASK_MESSAGES.maxString(attributes.container!, TASK_COLUMN_MAX)];
    else container = rawContainer;
  } else if (rawContainer === "") container = "";
  const rawTimeout = body.timeout === undefined ? defaults.timeout : body.timeout;
  const timeout = integerOf(rawTimeout);
  if (blank(rawTimeout)) errors.timeout = [TASK_MESSAGES.required(attributes.timeout!)];
  else if (timeout === null) errors.timeout = [TASK_MESSAGES.integer(attributes.timeout!)];
  else if (timeout < TASK_TIMEOUT.min) errors.timeout = [TASK_MESSAGES.min(attributes.timeout!, TASK_TIMEOUT.min)];
  else if (timeout > TASK_TIMEOUT.max) errors.timeout = [TASK_MESSAGES.max(attributes.timeout!, TASK_TIMEOUT.max)];
  const flag = (field: string, fallback: boolean): boolean => {
    if (body[field] === undefined) return fallback;
    const value = booleanValue(body[field]);
    if (value === undefined) errors[field] = [TASK_MESSAGES.boolean(attributes[field]!)];
    return value ?? fallback;
  };
  const useShell = flag("useShell", defaults.useShell);
  const isEnabled = withEnabled ? flag("isEnabled", true) : undefined;
  if (Object.keys(errors).length) throw new SettingsFieldErrors(errors);
  return { name, command, frequency, container, timeout: timeout!, useShell, ...(isEnabled === undefined ? {} : { isEnabled }) };
}

export interface TasksSaved extends TasksPageBody {
  message: string;
  /** The task that was added or changed (absent after a deletion). */
  task?: TaskDetail;
}

export const ADD_MESSAGES = {
  /**
   * Add::submit() for a service whose task names no container: `$this->container = $this->subServiceName`, a
   * property Add does not declare — Livewire's PropertyNotFoundException, as handleError() toasts it.
   */
  subServiceName: "Property [$subServiceName] not found on component: [project.shared.scheduled-task.add]",
} as const;

/**
 * Add::submit(): the fields as typed (Add does not trim), the task enabled.
 * An empty container stays empty for an application (it has one container
 * unless it is a Docker Compose one); for a service it is refused as above.
 */
export async function addHostTask(host: TaskHost, body: Body): Promise<TasksSaved> {
  const input = validate(body, ATTRIBUTES, { timeout: TASK_TIMEOUT.default, useShell: true, container: "" }, false);
  if (!validateCronExpression(input.frequency)) throw new SettingsError(TASK_MESSAGES.invalidCron, 422);
  if (host.kind === "service" && (input.container === null || input.container === "" || input.container === "null")) throw new SettingsError(ADD_MESSAGES.subServiceName, 422);
  const task = await host.rows.insertTask({ uuid: newPublicId(), name: input.name, command: input.command, frequency: input.frequency, container: input.container, timeout: input.timeout, useShell: input.useShell });
  return { ...(await hostPage(host)), task: detail(task, true), message: TASK_MESSAGES.added };
}

export async function addScheduledTask(ctx: ApplicationMoreContext, uuid: string, body: Body): Promise<TasksSaved | null> {
  const host = await hostOf(ctx, uuid, true);
  return host ? addHostTask(host, body) : null;
}

/** Show's attribute names: the property's own words. */
const SHOW_ATTRIBUTES: Record<string, string> = { ...ATTRIBUTES, useShell: "use shell", isEnabled: "is enabled" };

/** Show::submit() / instantSave(): syncData(true) — validated, the cron expression checked, the texts trimmed. */
export async function updateHostTask(host: TaskHost, taskUuid: string, body: Body): Promise<TasksSaved | null> {
  const task = await host.rows.findTask(taskUuid);
  if (!task) return null;
  const input = validate({ isEnabled: task.enabled, ...body }, SHOW_ATTRIBUTES, { timeout: task.timeout, useShell: task.use_shell, container: task.container }, true);
  if (!validateCronExpression(input.frequency)) throw new SettingsError(TASK_MESSAGES.invalidCron, 422);
  const changes: ScheduledTaskChanges = {
    enabled: input.isEnabled ?? task.enabled,
    name: input.name.trim(),
    command: input.command.trim(),
    frequency: input.frequency.trim(),
    // str($this->container)->trim()->value(): null becomes "".
    container: (input.container ?? "").trim(),
    timeout: input.timeout,
    use_shell: input.useShell,
  };
  await host.rows.updateTask(task.id, changes);
  return afterWrite(host, taskUuid, TASK_MESSAGES.updated);
}

export async function updateScheduledTask(ctx: ApplicationMoreContext, uuid: string, taskUuid: string, body: Body): Promise<TasksSaved | null> {
  const host = await hostOf(ctx, uuid, true);
  return host ? updateHostTask(host, taskUuid, body) : null;
}

async function afterWrite(host: TaskHost, taskUuid: string, message: string): Promise<TasksSaved | null> {
  const task = await host.rows.findTask(taskUuid);
  return task && { ...(await hostPage(host)), task: detail(task, true), message };
}

/** Show::toggleEnabled() */
export async function toggleHostTask(host: TaskHost, taskUuid: string): Promise<TasksSaved | null> {
  const task = await host.rows.findTask(taskUuid);
  if (!task) return null;
  await host.rows.updateTask(task.id, { enabled: !task.enabled });
  return afterWrite(host, taskUuid, task.enabled ? TASK_MESSAGES.disabled : TASK_MESSAGES.enabled);
}

export async function toggleScheduledTask(ctx: ApplicationMoreContext, uuid: string, taskUuid: string): Promise<TasksSaved | null> {
  const host = await hostOf(ctx, uuid, true);
  return host ? toggleHostTask(host, taskUuid) : null;
}

/** Show::delete(): the task and its execution history. */
export async function deleteHostTask(host: TaskHost, taskUuid: string): Promise<TasksSaved | null> {
  const task = await host.rows.findTask(taskUuid);
  if (!task) return null;
  await host.rows.deleteTask(task.id);
  return { ...(await hostPage(host)), message: TASK_MESSAGES.deleted };
}

export async function deleteScheduledTask(ctx: ApplicationMoreContext, uuid: string, taskUuid: string): Promise<TasksSaved | null> {
  const host = await hostOf(ctx, uuid, true);
  return host ? deleteHostTask(host, taskUuid) : null;
}

/** Show::executeNow(): ScheduledTaskJob runs the command in the container, which needs the SSH executor. */
export async function executeHostTask(host: TaskHost, taskUuid: string): Promise<null> {
  if (!(await host.rows.findTask(taskUuid))) return null;
  throw new SettingsError(TASK_MESSAGES.executeUnavailable, 501);
}

export async function executeScheduledTask(ctx: ApplicationMoreContext, uuid: string, taskUuid: string): Promise<null> {
  const host = await hostOf(ctx, uuid, true);
  return host ? executeHostTask(host, taskUuid) : null;
}
