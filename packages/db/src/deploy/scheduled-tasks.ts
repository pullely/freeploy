// Derived from coollabsio/coolify@91b7e3e:app/Models/{ScheduledTask,ScheduledTaskExecution}.php and
// app/Livewire/Project/Shared/ScheduledTask/{All,Add,Show,Executions}.php (the queries) (Apache-2.0), modified.
//
// deploy.scheduled_tasks and deploy.scheduled_task_executions. A task belongs
// to an application or to a service (application_id / service_id); every
// function takes the owner, so services reuse them. Every function takes the
// transaction of withOrg(): row-level security confines each query to that
// org, which is what Coolify's where('team_id', …) does.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** What a scheduled task belongs to. */
export interface ScheduledTaskOwner {
  kind: "application" | "service";
  id: string | number;
}

const OWNER_COLUMN: Record<ScheduledTaskOwner["kind"], string> = { application: "application_id", service: "service_id" };

export interface DeployScheduledTaskRow extends SqlRow {
  id: string | number;
  uuid: string;
  enabled: boolean;
  name: string;
  command: string;
  frequency: string;
  container: string | null;
  timeout: number;
  use_shell: boolean;
  /** Why Coolify's scheduler disabled the task (660_deploy_schema_catch_up); null for a task nobody disabled automatically. */
  disabled_reason: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
  /** $task->latest_log->status: the newest execution's status, or null when it never ran. */
  latest_status: string | null;
}

const COLUMNS = "t.id, t.uuid, t.enabled, t.name, t.command, t.frequency, t.container, t.timeout, t.use_shell, t.disabled_reason, t.created_at, t.updated_at";
/** latest_log(): hasOne(ScheduledTaskExecution::class)->latest() — the newest by created_at. */
const LATEST = "(SELECT e.status FROM deploy.scheduled_task_executions e WHERE e.scheduled_task_id = t.id ORDER BY e.created_at DESC NULLS LAST, e.id DESC LIMIT 1) AS latest_status";

/** $resource->scheduled_tasks, oldest first. */
export async function listScheduledTasks(tx: SqlExecutor, owner: ScheduledTaskOwner): Promise<DeployScheduledTaskRow[]> {
  const r = await tx.execute<DeployScheduledTaskRow>(`SELECT ${COLUMNS}, ${LATEST} FROM deploy.scheduled_tasks t WHERE t.${OWNER_COLUMN[owner.kind]} = $1 ORDER BY t.id`, [owner.id]);
  return r.rows;
}

/** $resource->scheduled_tasks()->where('uuid', $uuid)->first() */
export async function findScheduledTask(tx: SqlExecutor, owner: ScheduledTaskOwner, uuid: string): Promise<DeployScheduledTaskRow | null> {
  const r = await tx.execute<DeployScheduledTaskRow>(`SELECT ${COLUMNS}, ${LATEST} FROM deploy.scheduled_tasks t WHERE t.${OWNER_COLUMN[owner.kind]} = $1 AND t.uuid = $2`, [owner.id, uuid]);
  return r.rows[0] ?? null;
}

export interface NewScheduledTask {
  orgId: string;
  owner: ScheduledTaskOwner;
  /** BaseModel's creating hook: new_public_id(). */
  uuid: string;
  name: string;
  command: string;
  frequency: string;
  container: string | null;
  timeout: number;
  useShell: boolean;
}

/** Add::saveScheduledTask(): `enabled` is the column's default, true. */
export async function insertScheduledTask(tx: SqlExecutor, task: NewScheduledTask): Promise<DeployScheduledTaskRow> {
  const r = await tx.execute<DeployScheduledTaskRow>(
    `INSERT INTO deploy.scheduled_tasks AS t (uuid, name, command, frequency, container, timeout, use_shell, ${OWNER_COLUMN[task.owner.kind]}, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${NOW}, ${NOW})
     RETURNING ${COLUMNS}, NULL::varchar AS latest_status`,
    [task.uuid, task.name, task.command, task.frequency, task.container, task.timeout, task.useShell, task.owner.id, task.orgId],
  );
  return r.rows[0]!;
}

export const SCHEDULED_TASK_COLUMNS = ["enabled", "name", "command", "frequency", "container", "timeout", "use_shell"] as const;
export type ScheduledTaskColumn = (typeof SCHEDULED_TASK_COLUMNS)[number];
export type ScheduledTaskChanges = Partial<Record<ScheduledTaskColumn, string | number | boolean | null>>;

/**
 * ScheduledTask's saving hook: a task that is enabled again (isDirty('enabled')
 * && enabled) starts a new failure streak. SET reads the row as it was, so
 * `enabled = false` is the value before this update.
 */
const REENABLED = ["consecutive_failures = CASE WHEN enabled = false THEN 0 ELSE consecutive_failures END", "failing_since = CASE WHEN enabled = false THEN NULL ELSE failing_since END", "disabled_reason = CASE WHEN enabled = false THEN NULL ELSE disabled_reason END"];

/** $task->save(): only the given columns, and updated_at. False when the task is not the owner's. */
export async function updateScheduledTask(tx: SqlExecutor, owner: ScheduledTaskOwner, id: string | number, changes: ScheduledTaskChanges): Promise<boolean> {
  const columns = SCHEDULED_TASK_COLUMNS.filter((c) => changes[c] !== undefined);
  if (!columns.length) return true;
  const sets = columns.map((c, i) => `"${c}" = $${i + 3}`);
  const r = await tx.execute(
    `UPDATE deploy.scheduled_tasks SET ${[...sets, ...(changes.enabled === true ? REENABLED : []), `updated_at = ${NOW}`].join(", ")} WHERE id = $1 AND ${OWNER_COLUMN[owner.kind]} = $2 RETURNING id`,
    [id, owner.id, ...columns.map((c) => changes[c] ?? null)],
  );
  return r.rows.length > 0;
}

/** $task->delete(), with its executions (Coolify's foreign key cascades). False when the task is not the owner's. */
export async function deleteScheduledTask(tx: SqlExecutor, owner: ScheduledTaskOwner, id: string | number): Promise<boolean> {
  const found = await tx.execute(`SELECT 1 FROM deploy.scheduled_tasks WHERE id = $1 AND ${OWNER_COLUMN[owner.kind]} = $2`, [id, owner.id]);
  if (!found.rows.length) return false;
  await tx.execute("DELETE FROM deploy.scheduled_task_executions WHERE scheduled_task_id = $1", [id]);
  await tx.execute("DELETE FROM deploy.scheduled_tasks WHERE id = $1", [id]);
  return true;
}

export interface DeployScheduledTaskExecutionRow extends SqlRow {
  id: string | number;
  uuid: string;
  status: string;
  message: string | null;
  created_at: string | Date | null;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  duration: string | number | null;
  retry_count: number;
}

/** $task->executions()->take($limit)->get(): the last execution first. */
export async function listScheduledTaskExecutions(tx: SqlExecutor, taskId: string | number, limit = 20): Promise<DeployScheduledTaskExecutionRow[]> {
  const r = await tx.execute<DeployScheduledTaskExecutionRow>(
    `SELECT id, uuid, status, message, created_at, started_at, finished_at, duration, retry_count
       FROM deploy.scheduled_task_executions WHERE scheduled_task_id = $1
      ORDER BY created_at DESC NULLS LAST, id DESC LIMIT $2`,
    [taskId, limit],
  );
  return r.rows;
}
