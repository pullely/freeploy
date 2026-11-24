// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/Rollback.php and
// resources/views/livewire/project/application/rollback.blade.php (Apache-2.0), modified.
//
// An application's Rollback page: how many of its images stay on the server
// for a rollback (a setting, stored), and the images themselves — which
// Coolify reads from the server and the registry, and rolls back to by
// queueing a deployment. Both need the SSH executor: the list is reported as
// not available, never as empty.
import { blank, type FieldErrors } from "../private-keys/validation.js";
import { LARAVEL } from "../servers/settings-validation.js";
import type { ApplicationShow } from "./service.js";
import { SettingsError, SettingsFieldErrors } from "./settings.js";
import { needsExecutor } from "./resources.js";
import { integerOf, loadApplication, type ApplicationMoreContext } from "./more.js";

type Body = Record<string, unknown>;

export const ROLLBACK_MESSAGES = {
  /** saveSettings() */
  saved: "Settings saved.",
  /** Freeploy's: the SSH executor is not deployed yet. */
  imagesUnavailable: needsExecutor("Listing the application's images on the server"),
  rollbackUnavailable: needsExecutor("Rolling back to an image"),
} as const;

export interface RollbackPage {
  application: ApplicationShow;
  /** $application->settings->docker_images_to_keep ?? 2 */
  dockerImagesToKeep: number;
  /** The server's settings switch image retention off: the setting has no effect. */
  serverRetentionDisabled: boolean;
  /** GetRollbackImages::run(): null — the images cannot be listed. */
  images: null;
  /** Why `images` is null. */
  imagesUnavailable: string;
}

/** Rollback::mount() */
export async function showRollback(ctx: ApplicationMoreContext, uuid: string, canUpdate: boolean): Promise<RollbackPage | null> {
  const l = await loadApplication(ctx, uuid, canUpdate);
  const row = l ? await ctx.store.rollback(uuid) : null;
  if (!l || !row) return null;
  return {
    application: l.application,
    dockerImagesToKeep: row.docker_images_to_keep ?? 2,
    serverRetentionDisabled: Boolean(row.disable_application_image_retention),
    images: null,
    imagesUnavailable: ROLLBACK_MESSAGES.imagesUnavailable,
  };
}

/** Rollback::saveSettings(): #[Validate(['integer', 'min:0', 'max:100'])] on dockerImagesToKeep. */
export async function saveRollback(ctx: ApplicationMoreContext, uuid: string, body: Body): Promise<(RollbackPage & { message: string }) | null> {
  const l = await loadApplication(ctx, uuid, true);
  if (!l) return null;
  const errors: FieldErrors = {};
  const value = integerOf(body.dockerImagesToKeep);
  // The rule has no `required`: an absent or empty field passes, and the typed property keeps its value.
  if (!blank(body.dockerImagesToKeep)) {
    if (value === null) errors.dockerImagesToKeep = [LARAVEL.integer("dockerImagesToKeep")];
    else if (value < 0) errors.dockerImagesToKeep = [LARAVEL.minNumeric("dockerImagesToKeep", 0)];
    else if (value > 100) errors.dockerImagesToKeep = [LARAVEL.maxNumeric("dockerImagesToKeep", 100)];
  }
  if (Object.keys(errors).length) throw new SettingsFieldErrors(errors);
  if (value !== null && !blank(body.dockerImagesToKeep)) await ctx.store.updateImagesToKeep(l.row.id, value);
  const shown = await showRollback(ctx, uuid, true);
  return shown && { ...shown, message: ROLLBACK_MESSAGES.saved };
}

/** Rollback::loadImages(): `docker images` on the server and the registry's tags. */
export async function loadRollbackImages(ctx: ApplicationMoreContext, uuid: string): Promise<null> {
  if (!(await loadApplication(ctx, uuid, false))) return null;
  throw new SettingsError(ROLLBACK_MESSAGES.imagesUnavailable, 501);
}

/** Rollback::rollbackImage(): a deployment of an image that is on the server. */
export async function rollbackToImage(ctx: ApplicationMoreContext, uuid: string): Promise<null> {
  if (!(await loadApplication(ctx, uuid, true))) return null;
  throw new SettingsError(ROLLBACK_MESSAGES.rollbackUnavailable, 501);
}
