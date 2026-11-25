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
   * Why the task was disabled automatically. Nothing disables a task before
   * the scheduler exists (and the folded schema has no such column): null.
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

export interface ScheduledTasksPage {
  application: ApplicationShow;
  tasks: TaskItem[];
  /** All::mount(): the Compose services of a Docker Compose application, else none. Compose files are not parsed here yet: none. */
  containerNames: string[];
  /** getServerTimezone(): the server's timezone setting. */
  serverTimezone: string;
  /** $resource->isRunning(): "Execute now" shows. */
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
  disabledReason: null,
});

const stamp = (v: string | Date | null): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
const execution = (e: DeployScheduledTaskExecutionRow, canUpdate: boolean): TaskExecution => ({
  id: String(e.id),
  status: e.status,
  createdAt: stamp(e.created_at),
  finishedAt: stamp(e.finished_at),
  message: canUpdate ? (e.message ?? null) : null,
});

async function page(ctx: ApplicationMoreContext, l: LoadedApplication): Promise<ScheduledTasksPage> {
  return {
    application: l.application,
    tasks: (await ctx.store.tasks(l.row.id)).map(item),
    containerNames: [],
    serverTimezone: (await ctx.store.rollback(l.row.uuid))?.server_timezone || "UTC",
    isRunning: isRunning(l.frame.status),
  };
}

/** All::mount() */
export async function showScheduledTasks(ctx: ApplicationMoreContext, uuid: string, canUpdate: boolean): Promise<ScheduledTasksPage | null> {
  const l = await loadApplication(ctx, uuid, canUpdate);
  return l ? page(ctx, l) : null;
}

export interface TaskPage extends ScheduledTasksPage {
  task: TaskDetail;
  /** Executions::mount(): the last 20, the newest first. */
  executions: TaskExecution[];
}

async function taskPage(ctx: ApplicationMoreContext, l: LoadedApplication, task: DeployScheduledTaskRow, canUpdate: boolean): Promise<TaskPage> {
  return { ...(await page(ctx, l)), task: detail(task, canUpdate), executions: (await ctx.store.executions(task.id)).map((e) => execution(e, canUpdate)) };
}

/** All::openTask() with Show::mount(): one task of the application. */
export async function showScheduledTask(ctx: ApplicationMoreContext, uuid: string, taskUuid: string, canUpdate: boolean): Promise<TaskPage | null> {
  const l = await loadApplication(ctx, uuid, canUpdate);
  const task = l ? await ctx.store.findTask(l.row.id, taskUuid) : null;
  return l && task ? taskPage(ctx, l, task, canUpdate) : null;
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

export interface TasksSaved extends ScheduledTasksPage {
  message: string;
  /** The task that was added or changed (absent after a deletion). */
  task?: TaskDetail;
}

/**
 * Add::submit(): the fields as typed (Add does not trim), the task enabled.
 * An empty container stays empty: an application has one container unless it
 * is a Docker Compose one.
 */
export async function addScheduledTask(ctx: ApplicationMoreContext, uuid: string, body: Body): Promise<TasksSaved | null> {
  const l = await loadApplication(ctx, uuid, true);
  if (!l) return null;
  const input = validate(body, ATTRIBUTES, { timeout: TASK_TIMEOUT.default, useShell: true, container: "" }, false);
  if (!validateCronExpression(input.frequency)) throw new SettingsError(TASK_MESSAGES.invalidCron, 422);
  const task = await ctx.store.insertTask({ applicationId: l.row.id, uuid: newPublicId(), name: input.name, command: input.command, frequency: input.frequency, container: input.container, timeout: input.timeout, useShell: input.useShell });
  return { ...(await page(ctx, l)), task: detail(task, true), message: TASK_MESSAGES.added };
}

/** Show's attribute names: the property's own words. */
const SHOW_ATTRIBUTES: Record<string, string> = { ...ATTRIBUTES, useShell: "use shell", isEnabled: "is enabled" };

/** Show::submit() / instantSave(): syncData(true) — validated, the cron expression checked, the texts trimmed. */
export async function updateScheduledTask(ctx: ApplicationMoreContext, uuid: string, taskUuid: string, body: Body): Promise<TasksSaved | null> {
  const l = await loadApplication(ctx, uuid, true);
  const task = l ? await ctx.store.findTask(l.row.id, taskUuid) : null;
  if (!l || !task) return null;
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
  await ctx.store.updateTask(l.row.id, task.id, changes);
  return afterWrite(ctx, l, taskUuid, TASK_MESSAGES.updated);
}

async function afterWrite(ctx: ApplicationMoreContext, l: LoadedApplication, taskUuid: string, message: string): Promise<TasksSaved | null> {
  const task = await ctx.store.findTask(l.row.id, taskUuid);
  return task && { ...(await page(ctx, l)), task: detail(task, true), message };
}

/** Show::toggleEnabled() */
export async function toggleScheduledTask(ctx: ApplicationMoreContext, uuid: string, taskUuid: string): Promise<TasksSaved | null> {
  const l = await loadApplication(ctx, uuid, true);
  const task = l ? await ctx.store.findTask(l.row.id, taskUuid) : null;
  if (!l || !task) return null;
  await ctx.store.updateTask(l.row.id, task.id, { enabled: !task.enabled });
  return afterWrite(ctx, l, taskUuid, task.enabled ? TASK_MESSAGES.disabled : TASK_MESSAGES.enabled);
}

/** Show::delete(): the task and its execution history. */
export async function deleteScheduledTask(ctx: ApplicationMoreContext, uuid: string, taskUuid: string): Promise<TasksSaved | null> {
  const l = await loadApplication(ctx, uuid, true);
  const task = l ? await ctx.store.findTask(l.row.id, taskUuid) : null;
  if (!l || !task) return null;
  await ctx.store.deleteTask(l.row.id, task.id);
  return { ...(await page(ctx, l)), message: TASK_MESSAGES.deleted };
}

/** Show::executeNow(): ScheduledTaskJob runs the command in the container, which needs the SSH executor. */
export async function executeScheduledTask(ctx: ApplicationMoreContext, uuid: string, taskUuid: string): Promise<null> {
  const l = await loadApplication(ctx, uuid, true);
  const task = l ? await ctx.store.findTask(l.row.id, taskUuid) : null;
  if (!l || !task) return null;
  throw new SettingsError(TASK_MESSAGES.executeUnavailable, 501);
}
