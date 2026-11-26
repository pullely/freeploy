// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/services.php (clone_service),
// app/Livewire/Project/Shared/ResourceOperations.php (cloneTo, findResourceTeamEnvironment,
// findResourceTeamDestination), app/Models/Service.php (the creating hook, parse), app/Models/LocalFileVolume.php (the
// created hook), app/Traits/HasSecretManager.php (cloneSecretManagerLinkTo) and
// app/Actions/Shared/CloneVolumeDataWithSourceStopped.php (Apache-2.0), modified.
//
// clone_service() (DP-108): the service's row replicated onto a destination (a new uuid and name, the destination's
// server, the caller's environment, the creating hook's parser version), its tags, scheduled tasks, environment
// variables and secret manager link copied, then Service::parse() on the clone — the replica has no applications,
// databases, volumes or files, so the parser makes them, with the copied variables, as it does for any stored service
// (rows.ts: the clone's rows loaded, parsed, written back) — and the backup schedules of the source's databases given to
// the clone's databases of the same name, with their S3 storages. The parts the parser makes are 'exited' (the
// columns' default), so status => 'exited' saves nothing.
//
// What Coolify then does on a server, after the commit, is Freeploy's 501, in Coolify's order: a file mount the parser
// made inside the clone's directory (LocalFileVolume's created hook queues ServerStorageSaveJob, during the parse), then
// the volume data (cloneVolumeData: the source's volumes whose mount path the clone's part of the same name has, which
// CloneVolumeDataWithSourceStopped chains). The caller rolls its transaction back, so nothing is stored. The DNS records
// Coolify queues for the clone's hostnames (ResourceDnsRecords::queueAutomaticRecords) are not: DP-105 cut the DNS jobs.
//
// cloneServiceTo() is ResourceOperations::cloneTo() for a service (DP-97's checks, then clone_service() with the chosen
// environment).
import { SERVICE_PART_MORPH_CLASS, type DeployDestinationRow, type DeployServerRow, type DeployServiceConfigurationRow, type ServicePartKind } from "@saas/db/deploy";
import { blank } from "../private-keys/validation.js";
import { newPublicId } from "../helpers/names.js";
import { SettingsError, SettingsFieldErrors } from "../applications/settings.js";
import { RESOURCE_OPERATION_MESSAGES } from "../applications/resource-operations.js";
import { isOutsideResourceDirectory } from "../applications/storage-paths.js";
import { ENVIRONMENT_VARIABLE_VERSION } from "../environment-variables/service.js";
import { effectiveServerRole } from "../servers/service.js";
import { cloneResourceName } from "../databases/resources.js";
import { loadServiceInfo, ServiceConfigurationError, serviceParserContext } from "./configuration.js";
import { ComposeError } from "./compose-helpers.js";
import { parseService } from "./parser.js";
import { loadServiceRows, writeServiceRows } from "./rows.js";
import { serviceWorkdir, type ServiceResourcesContext } from "./resources.js";
import { serviceTargetEnvironment, type ServiceOperationResult } from "./resource-pages.js";
import type { ServiceCreateDependencies } from "./service.js";

type Body = Record<string, unknown>;
type Id = string | number;

export const SERVICE_CLONE_MESSAGES = {
  volumeDataUnavailable: RESOURCE_OPERATION_MESSAGES.volumeDataUnavailable,
  fileMountsUnavailable: RESOURCE_OPERATION_MESSAGES.fileMountsUnavailable,
} as const;

/** The rows clone_service() reads and writes besides the parser's (an SQL implementation in handlers/service-configuration.ts). */
export interface ServiceCloneStore {
  findDestination(uuid: string): Promise<DeployDestinationRow | null>;
  findServer(uuid: string): Promise<DeployServerRow | null>;
  replicateService(sourceId: Id, replica: { uuid: string; name: string; environmentId: Id; destinationId: Id; destinationType: DeployDestinationRow["type"]; serverId: Id }): Promise<Id | null>;
  copyTags(sourceId: Id, cloneId: Id): Promise<void>;
  scheduledTaskIds(serviceId: Id): Promise<Id[]>;
  replicateScheduledTask(taskId: Id, replica: { uuid: string; serviceId: Id }): Promise<void>;
  environmentVariableIds(serviceId: Id): Promise<Id[]>;
  replicateEnvironmentVariable(variableId: Id, replica: { uuid: string; serviceId: Id; version: string }): Promise<void>;
  cloneSecretManagerLink(sourceId: Id, cloneId: Id, uuid: string): Promise<void>;
  backupScheduleIds(databaseId: Id): Promise<Id[]>;
  replicateBackupSchedule(scheduleId: Id, replica: { uuid: string; databaseId: Id }): Promise<void>;
}

/** clone_service()'s $overrides: the uuid, the name and the environment its callers give. */
export interface ServiceCloneOverrides {
  uuid?: string;
  name?: string;
  environmentId?: Id;
}

export interface ServiceCloned {
  id: Id;
  uuid: string;
  name: string;
  /** What Coolify would now do on a server and Freeploy cannot yet: the first, in Coolify's order. */
  unavailable?: string;
}

const storeOf = (ctx: ServiceResourcesContext): ServiceCloneStore => {
  if (!ctx.clone) throw new Error("the service clone store is not configured");
  return ctx.clone;
};

/**
 * clone_service($source, $destination, $overrides, $cloneVolumeData) on the org's transaction. Throws
 * ServiceConfigurationError 422 with the parser's message when the clone's Compose file does not parse.
 */
export async function cloneService(
  ctx: ServiceResourcesContext,
  source: DeployServiceConfigurationRow,
  destination: DeployDestinationRow & { server_id: Id },
  overrides: ServiceCloneOverrides,
  cloneVolumeData: boolean,
  deps: ServiceCreateDependencies = {},
): Promise<ServiceCloned | null> {
  const store = storeOf(ctx);
  const newUuid = deps.newUuid ?? (() => newPublicId());
  const uuid = overrides.uuid ?? newUuid();
  const name = overrides.name ?? cloneResourceName(source.name, uuid);
  const id = await store.replicateService(source.id, {
    uuid,
    name,
    environmentId: overrides.environmentId ?? source.environment_id,
    destinationId: destination.id,
    destinationType: destination.type,
    serverId: destination.server_id,
  });
  if (id === null) return null;
  await store.copyTags(source.id, id);
  for (const task of await store.scheduledTaskIds(source.id)) await store.replicateScheduledTask(task, { uuid: newUuid(), serviceId: id });
  for (const variable of await store.environmentVariableIds(source.id)) await store.replicateEnvironmentVariable(variable, { uuid: newUuid(), serviceId: id, version: ENVIRONMENT_VARIABLE_VERSION });
  await store.cloneSecretManagerLink(source.id, id, newUuid());

  // $newService->parse(): the replica's rows (the service and its copied variables) parsed and written back.
  const rows = ctx.configuration.store;
  const configured = await rows.find(uuid);
  if (!configured) return null;
  const loaded = await loadServiceRows(rows, configured, ctx.configuration.ciphers);
  try {
    parseService(loaded.store, serviceParserContext(configured, deps));
  } catch (error) {
    if (error instanceof ComposeError) throw new ServiceConfigurationError(error.message, 422);
    throw error;
  }
  await writeServiceRows(rows, loaded, ctx.configuration.ciphers, newUuid);

  const unavailable: string[] = [];
  // LocalFileVolume's created hook: a managed mount inside the clone's directory is written on the server.
  const files = await rows.files(id);
  if (files.some((f) => !f.is_host_file && !isOutsideResourceDirectory(f.fs_path, serviceWorkdir(uuid)))) unavailable.push(SERVICE_CLONE_MESSAGES.fileMountsUnavailable);

  // The parts of the clone and of the source, by name (keyBy('name'): the last of a name wins).
  const partsOf = async (serviceId: Id) => {
    const byName: Record<ServicePartKind, Map<string, Id>> = { application: new Map(), database: new Map() };
    for (const kind of ["application", "database"] as const) for (const part of await rows.parts(kind, serviceId)) byName[kind].set(part.name, part.id);
    return byName;
  };
  const sourceParts = await partsOf(source.id);
  const cloneParts = await partsOf(id);

  let pendingVolumeClones = 0;
  if (cloneVolumeData) {
    const morph = (kind: ServicePartKind) => SERVICE_PART_MORPH_CLASS[kind];
    const sourceVolumes = await rows.volumes(source.id);
    const cloneVolumes = await rows.volumes(id);
    for (const kind of ["application", "database"] as const) {
      for (const [partName, cloneId] of cloneParts[kind]) {
        const sourceId = sourceParts[kind].get(partName);
        if (sourceId === undefined) continue;
        const targets = new Set(cloneVolumes.filter((v) => v.resource_type === morph(kind) && String(v.resource_id) === String(cloneId)).map((v) => v.mount_path));
        pendingVolumeClones += sourceVolumes.filter((v) => v.resource_type === morph(kind) && String(v.resource_id) === String(sourceId) && targets.has(v.mount_path)).length;
      }
    }
  }

  for (const [partName, cloneId] of cloneParts.database) {
    const sourceId = sourceParts.database.get(partName);
    if (sourceId === undefined) continue;
    for (const schedule of await store.backupScheduleIds(sourceId)) await store.replicateBackupSchedule(schedule, { uuid: newUuid(), databaseId: cloneId });
  }

  // CloneVolumeDataWithSourceStopped::run(): only when both servers are known and there is a volume to copy.
  if (pendingVolumeClones > 0 && source.server_id !== null) unavailable.push(SERVICE_CLONE_MESSAGES.volumeDataUnavailable);
  return { id, uuid, name, ...(unavailable.length ? { unavailable: unavailable[0] } : {}) };
}

/** findResourceTeamDestination() / findProjectTeamDestination(): one of the org's, on a server that can host resources. */
export async function findCloneDestination(ctx: ServiceResourcesContext, value: unknown): Promise<(DeployDestinationRow & { server_id: Id }) | null> {
  const store = storeOf(ctx);
  const destination = typeof value === "string" && !blank(value) ? await store.findDestination(value) : null;
  const server = destination ? await store.findServer(destination.server_uuid) : null;
  if (!destination || !server || effectiveServerRole(server) === "build") return null;
  return { ...destination, server_id: server.id };
}

/**
 * cloneTo($destination_uuid, $environment_id) for a service: the environment (the service's own unless one is chosen),
 * then the destination, then clone_service() with the environment. Null when the service is not the org's. What needs
 * the server answers 501 (SettingsError), which the caller's transaction rolls back.
 */
export async function cloneServiceTo(ctx: ServiceResourcesContext, uuid: string, body: Body, deps: ServiceCreateDependencies = {}): Promise<ServiceOperationResult | null> {
  const loaded = await loadServiceInfo(ctx.configuration, uuid);
  if (!loaded) return null;
  // $new_environment = $this->resource->environment, unless one is given.
  const environment =
    body.environment_uuid !== undefined && body.environment_uuid !== null
      ? await serviceTargetEnvironment(ctx, body.environment_uuid)
      : { id: loaded.row.environment_id, uuid: loaded.row.environment_uuid, project_uuid: loaded.row.project_uuid };
  const destination = await findCloneDestination(ctx, body.destination_uuid);
  if (!destination) throw new SettingsFieldErrors({ destination_id: [RESOURCE_OPERATION_MESSAGES.destinationNotFound] });
  const cloned = await cloneService(ctx, loaded.row, destination, { environmentId: environment.id }, body.cloneVolumeData === true, deps);
  if (!cloned) return null;
  if (cloned.unavailable) throw new SettingsError(cloned.unavailable, 501);
  return { projectUuid: environment.project_uuid, environmentUuid: environment.uuid, serviceUuid: cloned.uuid };
}
