// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Shared/Danger.php, app/Jobs/DeleteResourceJob.php,
// app/Actions/Application/StopApplication.php and app/Http/Controllers/Api/ApplicationsController.php
// (delete_by_uuid: the query fields) (Apache-2.0), modified.
//
// A resource's Danger Zone: the page (shared by an application and a
// standalone database, `:resource`), and deleting an application (a
// database's delete is databases/service.ts's deleteDatabaseNow()).
// Deleting an application: Coolify soft-deletes the row and
// queues DeleteResourceJob, which stops and removes the containers, deletes
// the configuration files, the volumes and the networks on the server, and
// only then removes the rows. Here, an application nothing was ever deployed
// of has nothing on any server: its rows are removed at once. Any other
// application answers 501 until the SSH executor exists — removing only its
// rows would leave its containers running with nothing managing them.
import { SettingsError } from "./settings.js";
import { applicationResource, loadApplication, needsExecutor, type ApplicationResourcesContext, type ResourceFrame, type ResourcesContext } from "./resources.js";

export const DANGER_MESSAGES = {
  /** Freeploy's: the SSH executor is not deployed yet. */
  deleteUnavailable: needsExecutor("Stopping the application and removing its containers, volumes, networks and configuration files from the server"),
} as const;

/** Danger's checkboxes, which are the query fields of Coolify's DELETE /applications/{uuid}. */
export const DELETE_OPTIONS = ["delete_volumes", "delete_connected_networks", "delete_configurations", "docker_cleanup", "delete_backups"] as const;
export type DeleteOption = (typeof DELETE_OPTIONS)[number];
export type DeleteOptions = Record<DeleteOption, boolean>;

/** Danger's defaults: everything but the backups. */
export const DELETE_DEFAULTS: DeleteOptions = { delete_volumes: true, delete_connected_networks: true, delete_configurations: true, docker_cleanup: true, delete_backups: false };

/** filter_var($value, FILTER_VALIDATE_BOOLEAN) of each query field; the default when it is not given. */
export function deleteOptions(query: URLSearchParams): DeleteOptions {
  const options = { ...DELETE_DEFAULTS };
  for (const option of DELETE_OPTIONS) {
    const value = query.get(option);
    if (value !== null) options[option] = ["1", "true", "on", "yes"].includes(value.trim().toLowerCase());
  }
  return options;
}

export type DangerPage = ResourceFrame & {
  /** Server::isFunctional(): when false the view warns that nothing on the server can be removed. */
  serverIsFunctional: boolean;
  /**
   * Nothing of the resource exists on a server, so the delete removes its rows
   * at once: an application that never left 'exited', with no container known
   * and no deployment queued; a database that was never started.
   */
  neverDeployed: boolean;
};

/** Danger::mount() */
export async function showDanger(ctx: ResourcesContext, uuid: string, canUpdate: boolean): Promise<DangerPage | null> {
  const l = await ctx.load(uuid, canUpdate);
  return l ? { ...l.frame, serverIsFunctional: l.serverIsFunctional, neverDeployed: await l.nothingOnServer() } : null;
}

export interface ApplicationDeleted {
  deleted: true;
  /** Where the page goes next: the environment's resources. */
  projectUuid: string;
  environmentUuid: string;
  /** The options as they were read. */
  options: DeleteOptions;
}

/**
 * Danger::delete(). The options say what DeleteResourceJob removes on the
 * server; the rows it removes are the same whatever they are (the model's
 * forceDeleting hook deletes the volume rows also without `delete_volumes`).
 * Null when the application is not the org's.
 */
export async function deleteApplicationNow(ctx: ApplicationResourcesContext, uuid: string, options: DeleteOptions): Promise<ApplicationDeleted | null> {
  const l = await loadApplication(ctx, uuid, true);
  if (!l) return null;
  if (!(await applicationResource(ctx, l).nothingOnServer())) throw new SettingsError(DANGER_MESSAGES.deleteUnavailable, 501);
  await ctx.store.deleteApplication(l.row.id);
  return { deleted: true, projectUuid: l.application.project.uuid, environmentUuid: l.application.environment.uuid, options };
}
