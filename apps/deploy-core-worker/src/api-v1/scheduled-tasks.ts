// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/ScheduledTasksController.php (removeSensitiveData,
// canReadSensitive, enabledTaskForbiddenResponse, resolveApplication, resolveService, listTasks, createTask, updateTask,
// deleteTask, getExecutions and the *_by_application_uuid / *_by_service_uuid routes),
// app/Http/Controllers/Api/Concerns/RequiresDeployAbility.php, app/Models/{ScheduledTask,ScheduledTaskExecution}.php
// ($casts, the saving hook, the name's strip_tags(), RecordsWorkerHost's hidden worker_host) and
// bootstrap/helpers/shared.php (validate_cron_expression) (Apache-2.0), modified.
//
// Coolify's /api/v1 for the scheduled tasks of an application and of a service (DP-84), on the task rows the console's
// Scheduled Tasks pages use (packages/db's deploy/scheduled-tasks.ts) and DP-68's cron validator. A task is a row: what
// runs it is the scheduler. "Execute now" (POST …/execute, DP-88) queues ScheduledTaskJob, which runs the command over
// SSH: Freeploy answers 501 in Coolify's envelope after Coolify's checks (executeTask()), and stores nothing.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { deleteScheduledTask, insertScheduledTask, updateScheduledTask, type ApiRow, type ScheduledTaskChanges, type ScheduledTaskOwner } from "@saas/db/deploy";
import { COOLIFY_API, POLICY_DENIALS, coolifyJson, laravelDate, obj, serializeApiResponse, type CoolifyAnswer, type PhpObject, type PhpValue } from "@saas/contracts/coolify-api";
import { stripTags } from "../applications/tags.js";
import { validateCronExpression } from "../servers/settings-validation.js";
import { newPublicId } from "../helpers/names.js";
import { applicationRelation } from "./applications.js";
import { serviceResource } from "./services.js";
import { needsExecutor } from "../applications/resources.js";
import { hasDeployAbility, message, rowsOf, unavailable, type ApiV1Context, type Rows } from "./context.js";
import { rowValue, toModel, type ModelShape } from "./models.js";
import { extraFields, readApiBody, requestBoolean, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rules } from "./rules.js";

export type TaskOwnerKind = "application" | "service";
/** authorize('update', $resource): ApplicationPolicy's own message (ServicePolicy answers false), DP-93. */
const UPDATE_DENIED: Record<TaskOwnerKind, string | undefined> = { application: POLICY_DENIALS.applicationUpdate, service: undefined };

/** removeSensitiveData(): id and the owners hidden (the team is Freeploy's org_id, which a row never carries); command for a token that may read secrets. */
const TASK: ModelShape = { hidden: ["id", "team_id", "application_id", "service_id", "command"], dates: ["created_at", "updated_at", "failing_since"] };
/** getExecutions(): id and the task hidden, RecordsWorkerHost's worker_host; message for a token that may read secrets. */
const EXECUTION: ModelShape = { hidden: ["id", "scheduled_task_id", "worker_host", "message"], dates: ["created_at", "updated_at", "started_at", "finished_at"] };
const ALLOWED = ["name", "command", "frequency", "container", "timeout", "use_shell", "enabled"];
const NOT_FOUND: Record<TaskOwnerKind, string> = { application: "Application not found.", service: "Service not found." };
const ENABLED_REASON = "An enabled scheduled task runs commands in the resource containers, so it needs a token with the deploy permission.";

const denied = async (c: ApiV1Context, write: boolean, policyMessage?: string): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized(policyMessage));
/** enabledTaskForbiddenResponse() */
const enabledForbidden = (c: ApiV1Context, enabled: boolean): CoolifyAnswer | null => (!enabled || hasDeployAbility(c) ? null : message(`Missing required permissions: deploy. ${ENABLED_REASON}`, 403));
const badFrequency = (): CoolifyAnswer => validationFailed([["frequency", ["Invalid cron expression or frequency format."]]]);
/** PHP's (string) cast. */
const phpString = (v: unknown): string => (v === true ? "1" : v === false || v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "number" ? String(v) : "Array");
/** Laravel's boolean cast of an attribute set from the request. */
const castBoolean = (v: unknown): boolean => !(v === undefined || v === null || v === false || v === 0 || v === "" || v === "0");

/** `$request->uuid`: the input (the body, then the query string) before the route parameter. */
function param(c: ApiV1Context, all: Record<string, unknown>, route: string): unknown {
  if ("uuid" in all) return all.uuid;
  const q = c.url.searchParams.get("uuid");
  return q !== null ? q : route;
}

interface Resource {
  kind: TaskOwnerKind;
  row: ApiRow;
  owner: ScheduledTaskOwner;
}

/** resolveApplication() / resolveService(): the org's resource, not deleted. */
async function resolve(rows: Rows, kind: TaskOwnerKind, uuid: unknown): Promise<Resource | null> {
  if (typeof uuid !== "string" && typeof uuid !== "number") return null;
  const row = (await rows(kind === "application" ? "applications" : "services", "t.deleted_at IS NULL AND t.uuid = $1", [String(uuid)]))[0];
  return row ? { kind, row, owner: { kind, id: rowValue(row, "id") as number } } : null;
}

const ownerColumn = (kind: TaskOwnerKind) => (kind === "application" ? "application_id" : "service_id");
/** $resource->scheduled_tasks: ->orderBy('name', 'asc'). */
const tasksOf = (rows: Rows, r: Resource) => rows("scheduled_tasks", `t.${ownerColumn(r.kind)} = $1`, [r.owner.id], "name");
/** $resource->scheduled_tasks()->where('uuid', …)->first() */
const taskOf = async (rows: Rows, r: Resource, uuid: string) => (await rows("scheduled_tasks", `t.${ownerColumn(r.kind)} = $1 AND t.uuid = $2`, [r.owner.id, uuid]))[0] ?? null;

/**
 * The relations canReadSensitive() loaded ($task->application ?? $task->service): the application (null for a service's
 * task, then the service), as toArray() writes a loaded relation.
 */
async function relationsOf(tx: SqlExecutor, c: ApiV1Context, r: Resource): Promise<Array<[string, PhpValue]>> {
  const plain = { ...c, canReadSensitive: false };
  if (r.kind === "application") return [["application", await applicationRelation(tx, c, r.row)]];
  return [["application", null], ["service", await serviceResource(tx, plain, r.row)]];
}

/** removeSensitiveData($task): toArray() with the loaded relations, the command only for a token that may read secrets, then serializeApiResponse(). */
function taskModel(c: ApiV1Context, row: ApiRow, relations: Array<[string, PhpValue]>): PhpObject {
  return serializeApiResponse(toModel(row, TASK, { visible: c.canReadSensitive ? ["command"] : [], extra: relations }), c.canReadSensitive);
}

/** routes/api.php's /{applications,services}/{uuid}/scheduled-tasks routes; null for any other path (the fallback 404). */
export async function scheduledTasksApi(c: ApiV1Context, kind: TaskOwnerKind, uuid: string, segments: string[]): Promise<CoolifyAnswer | null> {
  const [taskUuid, sub, extra] = segments;
  if (extra !== undefined) return null;
  const m = c.method;
  if (taskUuid === undefined) return m === "GET" ? listTasks(c, kind, uuid) : m === "POST" ? createTask(c, kind, uuid) : null;
  if (sub === undefined) return m === "PATCH" ? updateTask(c, kind, uuid, taskUuid) : m === "DELETE" ? deleteTask(c, kind, uuid, taskUuid) : null;
  if (sub === "execute") return m === "POST" ? execute(c, kind, uuid, taskUuid) : null;
  return sub === "executions" && m === "GET" ? executions(c, kind, uuid, taskUuid) : null;
}

/** Freeploy's: ScheduledTaskJob runs the task's command in the resource's container over SSH. */
export const EXECUTE_TASK_UNAVAILABLE = needsExecutor("Running the scheduled task");

/** executeTask(): the update policy, the resource's task, then ScheduledTaskJob::dispatch() (501). A disabled task runs too. */
async function execute(c: ApiV1Context, kind: TaskOwnerKind, uuid: string, taskUuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const r = await resolve(rows, kind, param(c, {}, uuid));
    if (!r) return message(NOT_FOUND[kind], 404);
    const no = await denied(c, true, UPDATE_DENIED[kind]);
    if (no) return no;
    // $request->task_uuid: the input before the route parameter.
    const wanted = c.url.searchParams.get("task_uuid") ?? taskUuid;
    if (!(await taskOf(rows, r, wanted))) return message("Scheduled task not found.", 404);
    return unavailable(EXECUTE_TASK_UNAVAILABLE);
  });
}

async function listTasks(c: ApiV1Context, kind: TaskOwnerKind, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const r = await resolve(rows, kind, param(c, {}, uuid));
    if (!r) return message(NOT_FOUND[kind], 404);
    const no = await denied(c, false);
    if (no) return no;
    const tasks = await tasksOf(rows, r);
    const relations = tasks.length ? await relationsOf(tx, c, r) : [];
    return coolifyJson(tasks.map((t) => taskModel(c, t, relations)));
  });
}

const createRules: Rules = [
  ["name", ["required", "string", "max:255"]],
  ["command", ["required", "string"]],
  ["frequency", ["required", "string"]],
  ["container", ["string", "nullable"]],
  ["timeout", ["integer", "min:1", "max:36000"]],
  ["use_shell", ["boolean"]],
  ["enabled", ["boolean"]],
];
const updateRules: Rules = [
  ["name", ["string", "max:255"]],
  ["command", ["string"]],
  ["frequency", ["string"]],
  ["container", ["string", "nullable"]],
  ["timeout", ["integer", "min:1", "max:36000"]],
  ["use_shell", ["boolean"]],
  ["enabled", ["boolean"]],
];

async function validate(all: Record<string, unknown>, rules: Rules): Promise<CoolifyAnswer | null> {
  const errors: Errors = [];
  await validateRules(errors, all, rules);
  extraFields(errors, all, ALLOWED);
  return errors.length ? validationFailed(errors) : null;
}

async function createTask(c: ApiV1Context, kind: TaskOwnerKind, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  const all = body.all;
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const r = await resolve(rows, kind, param(c, all, uuid));
    if (!r) return message(NOT_FOUND[kind], 404);
    const no = await denied(c, true, UPDATE_DENIED[kind]);
    if (no) return no;
    if (body.incomingError) return body.incomingError;
    const invalid = await validate(all, createRules);
    if (invalid) return invalid;
    if (!validateCronExpression(all.frequency)) return badFrequency();
    const enabled = "enabled" in all ? requestBoolean(all, "enabled") : true;
    const forbidden = enabledForbidden(c, enabled);
    if (forbidden) return forbidden;
    const name = stripTags(phpString(all.name));
    const container = (all.container as string | null | undefined) ?? null;
    const timeout = "timeout" in all ? Number(all.timeout) : 300;
    const useShell = "use_shell" in all ? requestBoolean(all, "use_shell") : true;
    const created = await insertScheduledTask(tx, { orgId: c.orgId, owner: r.owner, uuid: newPublicId(), name, command: phpString(all.command), frequency: phpString(all.frequency), container, timeout, useShell, enabled });
    // $task->save() of a new model: the attributes it set (the saving hook resets the failure streak of an enabled task),
    // the creating hook's uuid, the timestamps — not read again.
    const now = laravelDate(new Date());
    const entries: Array<[string, PhpValue]> = [["name", name], ["command", phpString(all.command)], ["frequency", phpString(all.frequency)], ["container", container], ["timeout", timeout], ["use_shell", useShell], ["enabled", enabled]];
    if (enabled) entries.push(["consecutive_failures", 0], ["failing_since", null], ["disabled_reason", null]);
    entries.push(["uuid", created.uuid], ["updated_at", now], ["created_at", now], ...(await relationsOf(tx, c, r)));
    const shown = entries.filter(([k]) => k !== "command" || c.canReadSensitive);
    return coolifyJson(serializeApiResponse(obj(shown), c.canReadSensitive), 201);
  });
}

async function updateTask(c: ApiV1Context, kind: TaskOwnerKind, uuid: string, taskUuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  const all = body.all;
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const r = await resolve(rows, kind, param(c, all, uuid));
    if (!r) return message(NOT_FOUND[kind], 404);
    const no = await denied(c, true, UPDATE_DENIED[kind]);
    if (no) return no;
    if (body.incomingError) return body.incomingError;
    if (Object.keys(all).length === 0) return message("At least one field must be provided.", 422);
    const invalid = await validate(all, updateRules);
    if (invalid) return invalid;
    if ("frequency" in all && !validateCronExpression(all.frequency)) return badFrequency();
    const task = await taskOf(rows, r, taskUuid);
    if (!task) return message("Scheduled task not found.", 404);
    const enabled = "enabled" in all ? requestBoolean(all, "enabled") : rowValue(task, "enabled") === true;
    const forbidden = enabledForbidden(c, enabled);
    if (forbidden) return forbidden;
    // $task->fill($request->only($allowedFields)): the name's strip_tags(), the casts; save() writes what is dirty.
    const changes: ScheduledTaskChanges = {};
    const set = (column: keyof ScheduledTaskChanges & string, value: string | number | boolean | null) => {
      if (rowValue(task, column) !== value) changes[column] = value;
    };
    if ("name" in all) set("name", stripTags(phpString(all.name)));
    if ("command" in all) set("command", phpString(all.command));
    if ("frequency" in all) set("frequency", phpString(all.frequency));
    if ("container" in all) set("container", all.container === null ? null : phpString(all.container));
    if ("timeout" in all) set("timeout", Number(all.timeout));
    if ("use_shell" in all) set("use_shell", castBoolean(all.use_shell));
    if ("enabled" in all) set("enabled", castBoolean(all.enabled));
    const id = rowValue(task, "id") as number;
    if (Object.keys(changes).length) await updateScheduledTask(tx, r.owner, id, changes);
    const fresh = (await rows("scheduled_tasks", "t.id = $1", [id]))[0]!;
    return coolifyJson(taskModel(c, fresh, await relationsOf(tx, c, r)));
  });
}

async function deleteTask(c: ApiV1Context, kind: TaskOwnerKind, uuid: string, taskUuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const r = await resolve(rows, kind, param(c, {}, uuid));
    if (!r) return message(NOT_FOUND[kind], 404);
    const no = await denied(c, true);
    if (no) return no;
    const task = await taskOf(rows, r, taskUuid);
    if (!task) return message("Scheduled task not found.", 404);
    await deleteScheduledTask(tx, r.owner, rowValue(task, "id") as number, { keepExecutions: true });
    return message("Scheduled task deleted.", 200);
  });
}

async function executions(c: ApiV1Context, kind: TaskOwnerKind, uuid: string, taskUuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const r = await resolve(rows, kind, param(c, {}, uuid));
    if (!r) return message(NOT_FOUND[kind], 404);
    const no = await denied(c, false);
    if (no) return no;
    const task = await taskOf(rows, r, taskUuid);
    if (!task) return message("Scheduled task not found.", 404);
    // $task->executions(): ->orderBy('created_at', 'desc')
    const list = await rows("scheduled_task_executions", "t.scheduled_task_id = $1", [rowValue(task, "id")]);
    const sorted = [...list].sort((a, b) => String(rowValue(b, "created_at") ?? "").localeCompare(String(rowValue(a, "created_at") ?? "")));
    return coolifyJson(sorted.map((x) => serializeApiResponse(toModel(withFloat(x), EXECUTION, { visible: c.canReadSensitive ? ["message"] : [] }), c.canReadSensitive)));
  });
}

/** The `float` cast of duration: numeric(10,2) as a PHP float. */
function withFloat(row: ApiRow): ApiRow {
  return row.map(([k, v]) => [k, k === "duration" && v !== null && v !== undefined ? Number(v) : v] as [string, unknown]);
}
