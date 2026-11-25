// Derived from coollabsio/coolify@91b7e3e:app/Jobs/DeleteResourceJob.php (deleteLocalResource,
// volumeBackupSchedules) and app/Models/Application.php (the forceDeleting hook) (Apache-2.0), modified.
//
// What deleting an application removes from the database, once nothing of it
// is left on a server: DeleteResourceJob::deleteLocalResource() and the
// model's forceDeleting hook, row for row. Every function takes the
// transaction of withOrg(): row-level security confines each query to that
// org.
import type { SqlExecutor } from "../hyperdrive/executor.js";
import { APPLICATION_MORPH_CLASS, FILE_VOLUME_MORPH_CLASS, PERSISTENT_VOLUME_MORPH_CLASS } from "./storages.js";

/** $application->deployment_queue: whether a deployment was ever queued for it (application_id is a string column). */
export async function applicationHasDeployments(tx: SqlExecutor, id: string | number): Promise<boolean> {
  const r = await tx.execute("SELECT 1 FROM deploy.application_deployment_queues WHERE application_id = $1 LIMIT 1", [String(id)]);
  return r.rows.length > 0;
}

/**
 * deleteLocalResource() and forceDelete() for an application, in Coolify's
 * order:
 *
 *   the backup schedules of its volumes and directories (with their
 *   executions and S3 links, which Coolify's foreign keys cascade to),
 *   its volume, file and directory mounts, its environment variables
 *   (production and preview), its settings row, its secret manager link, its
 *   scheduled tasks (with their executions), its tags (the pivot rows: the
 *   tags stay), its previews, its deployment records, and the application.
 *
 * Coolify soft-deletes the previews (`previews()->delete()`); here they go
 * with the application. False when the application is not there.
 */
export async function deleteApplication(tx: SqlExecutor, id: string | number): Promise<boolean> {
  const app = [APPLICATION_MORPH_CLASS, id];
  const schedules = `SELECT b.id FROM deploy.scheduled_volume_backups b
    WHERE (b.backupable_type = $3 AND b.backupable_id IN (SELECT v.id FROM deploy.local_persistent_volumes v WHERE v.resource_type = $1 AND v.resource_id = $2))
       OR (b.backupable_type = $4 AND b.backupable_id IN (SELECT f.id FROM deploy.local_file_volumes f WHERE f.resource_type = $1 AND f.resource_id = $2))`;
  const morphs = [...app, PERSISTENT_VOLUME_MORPH_CLASS, FILE_VOLUME_MORPH_CLASS];
  await tx.execute(`DELETE FROM deploy.scheduled_volume_backup_executions WHERE scheduled_volume_backup_id IN (${schedules})`, morphs);
  await tx.execute(`DELETE FROM deploy.scheduled_volume_backup_s3_storage WHERE scheduled_volume_backup_id IN (${schedules})`, morphs);
  await tx.execute(`DELETE FROM deploy.scheduled_volume_backups WHERE id IN (${schedules})`, morphs);
  await tx.execute("DELETE FROM deploy.local_persistent_volumes WHERE resource_type = $1 AND resource_id = $2", app);
  await tx.execute("DELETE FROM deploy.local_file_volumes WHERE resource_type = $1 AND resource_id = $2", app);
  await tx.execute("DELETE FROM deploy.environment_variables WHERE resourceable_type = $1 AND resourceable_id = $2", app);
  await tx.execute("DELETE FROM deploy.application_settings WHERE application_id = $1", [id]);
  await tx.execute("DELETE FROM deploy.secret_manager_links WHERE resourceable_type = $1 AND resourceable_id = $2", app);
  await tx.execute("DELETE FROM deploy.scheduled_task_executions WHERE scheduled_task_id IN (SELECT t.id FROM deploy.scheduled_tasks t WHERE t.application_id = $1)", [id]);
  await tx.execute("DELETE FROM deploy.scheduled_tasks WHERE application_id = $1", [id]);
  await tx.execute("DELETE FROM deploy.taggables WHERE taggable_type = $1 AND taggable_id = $2", app);
  await tx.execute("DELETE FROM deploy.application_previews WHERE application_id = $1", [id]);
  await tx.execute("DELETE FROM deploy.application_deployment_queues WHERE application_id = $1", [String(id)]);
  const r = await tx.execute("DELETE FROM deploy.applications WHERE id = $1 RETURNING id", [id]);
  return r.rows.length > 0;
}
