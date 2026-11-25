// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/Rollback.php (mount,
// saveSettings) (Apache-2.0), modified.
//
// What an application's Rollback page stores: how many of its images are kept
// on the server (application_settings.docker_images_to_keep), and whether the
// server's settings switch image retention off (with the server's timezone,
// which the Scheduled Tasks page names). Every function takes the
// transaction of withOrg(): row-level security confines each query to that
// org.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { DESTINATION_MORPH_CLASS } from "./destinations.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

export interface DeployApplicationRollbackRow extends SqlRow {
  id: string | number;
  /** $application->settings->docker_images_to_keep (null when the settings row is missing). */
  docker_images_to_keep: number | null;
  /** $application->destination->server->settings->disable_application_image_retention */
  disable_application_image_retention: boolean | null;
  /** getServerTimezone($application->destination->server): the Scheduled Tasks page names it. */
  server_timezone: string | null;
}

/** Rollback::mount() */
export async function findApplicationRollback(tx: SqlExecutor, uuid: string): Promise<DeployApplicationRollbackRow | null> {
  const r = await tx.execute<DeployApplicationRollbackRow>(
    `SELECT a.id, st.docker_images_to_keep, ss.disable_application_image_retention, ss.server_timezone
       FROM deploy.applications a
       LEFT JOIN deploy.application_settings st ON st.application_id = a.id
       LEFT JOIN deploy.standalone_dockers sd ON sd.id = a.destination_id AND a.destination_type = $2
       LEFT JOIN deploy.swarm_dockers wd ON wd.id = a.destination_id AND a.destination_type = $3
       LEFT JOIN deploy.servers s ON s.id = COALESCE(sd.server_id, wd.server_id) AND s.deleted_at IS NULL
       LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id
      WHERE a.uuid = $1 AND a.deleted_at IS NULL`,
    [uuid, DESTINATION_MORPH_CLASS.standalone, DESTINATION_MORPH_CLASS.swarm],
  );
  return r.rows[0] ?? null;
}

/** $application->settings->docker_images_to_keep = …; save(). False when the settings row is missing. */
export async function updateApplicationImagesToKeep(tx: SqlExecutor, applicationId: string | number, dockerImagesToKeep: number): Promise<boolean> {
  const r = await tx.execute(`UPDATE deploy.application_settings SET docker_images_to_keep = $2, updated_at = ${NOW} WHERE application_id = $1 RETURNING id`, [applicationId, dockerImagesToKeep]);
  return r.rows.length > 0;
}
