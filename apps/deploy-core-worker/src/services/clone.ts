// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Shared/ResourceOperations.php (cloneTo,
// findResourceTeamEnvironment, findResourceTeamDestination) and bootstrap/helpers/services.php (clone_service)
// (Apache-2.0), modified.
//
// ResourceOperations::cloneTo() for a service. Coolify's checks are ported — the environment (the service's own
// unless one is chosen), then a destination of the org on a server that can host resources — and answer its field
// errors. clone_service() itself is not: it replicates the service, its tags, scheduled tasks and variables, then
// runs Service::parse() on the clone to create its applications, databases, volumes and files, copies its
// databases' backup schedules with their S3 storages, queues the volume copies and the DNS records. Freeploy's
// parser is held to PHP for a service being created or saved, not for a replicated one, so the clone would not be
// known to be Coolify's; it answers 501 after the checks, and nothing is stored.
import { blank } from "../private-keys/validation.js";
import { SettingsError, SettingsFieldErrors } from "../applications/settings.js";
import { RESOURCE_OPERATION_MESSAGES } from "../applications/resource-operations.js";
import { effectiveServerRole } from "../servers/service.js";
import type { DeployDestinationRow, DeployServerRow } from "@saas/db/deploy";
import { loadServiceInfo } from "./configuration.js";
import type { ServiceResourcesContext } from "./resources.js";
import { serviceTargetEnvironment, type ServiceOperationResult } from "./resource-pages.js";
import type { ServiceCreateDependencies } from "./service.js";

type Body = Record<string, unknown>;

export const SERVICE_CLONE_MESSAGES = {
  /** Freeploy's: clone_service() is not ported (see above). */
  cloneUnavailable: "Cloning a service is not available yet.",
} as const;

/** The destination lookups cloneTo() needs (the org's, by uuid). */
export interface ServiceCloneStore {
  findDestination(uuid: string): Promise<DeployDestinationRow | null>;
  findServer(uuid: string): Promise<DeployServerRow | null>;
}

/** cloneTo($destination_uuid, $environment_id) for a service. Null when the service is not the org's. */
export async function cloneServiceTo(ctx: ServiceResourcesContext, uuid: string, body: Body, _deps: ServiceCreateDependencies = {}): Promise<ServiceOperationResult | null> {
  const loaded = await loadServiceInfo(ctx.configuration, uuid);
  if (!loaded) return null;
  // $new_environment = $this->resource->environment, unless one is given.
  if (body.environment_uuid !== undefined && body.environment_uuid !== null) await serviceTargetEnvironment(ctx, body.environment_uuid);
  const store = ctx.clone;
  const destination = store && typeof body.destination_uuid === "string" && !blank(body.destination_uuid) ? await store.findDestination(body.destination_uuid) : null;
  const server = destination && store ? await store.findServer(destination.server_uuid) : null;
  // findResourceTeamDestination(): null unless the destination's server can host resources (not a build server).
  if (!destination || !server || effectiveServerRole(server) === "build") throw new SettingsFieldErrors({ destination_id: [RESOURCE_OPERATION_MESSAGES.destinationNotFound] });
  throw new SettingsError(SERVICE_CLONE_MESSAGES.cloneUnavailable, 501);
}
