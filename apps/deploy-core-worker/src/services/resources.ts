// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/service/configuration.blade.php (the
// storages, tags and danger branches), app/Livewire/Project/Service/{Storage,FileStorage}.php,
// app/Livewire/Project/Shared/{Tags,Danger}.php, app/Models/Service.php (workdir, tags),
// app/Actions/Service/DeleteService.php and app/Jobs/DeleteResourceJob.php (Apache-2.0), modified.
//
// The pages Coolify renders for a service with its shared components: Tags and the Danger Zone with
// `:resource="$service"` (rows bound to App\Models\Service), and Persistent Storage, which is one
// `<livewire:project.service.storage :resource="…">` per application and database of the service — their
// volumes, files and directories, under the service's directory on the server and read-only where the
// Compose file defines them. Each runs on the shared code of applications/{storages,tags,danger}.ts
// through a ResourcesContext; deleting a service removes its rows when it never ran, else answers 501.
import type { DeployEnvironmentServiceRow, ServicePartKind } from "@saas/db/deploy";
import { SERVICE_MORPH_CLASS, SERVICE_PART_MORPH_CLASS } from "@saas/db/deploy";
import { needsExecutor, type LoadedResource, type ResourceRowsStore, type ResourcesContext } from "../applications/resources.js";
import { showStorages, type StoragesPage } from "../applications/storages.js";
import type { KeyCipher } from "../private-keys/service.js";
import { BASE_CONFIGURATION_DIR } from "./parser.js";
import { isFunctional } from "../servers/service.js";
import type { ServicePagesStore } from "./resource-pages.js";
import type { ServiceCloneStore } from "./clone.js";
import { loadServiceInfo, ServiceConfigurationError, serviceStatus, type ServiceConfigurationContext, type ServiceInfo } from "./configuration.js";

type Id = string | number;

/** Service::workdir(): service_configuration_dir()/{uuid}. */
export const serviceWorkdir = (uuid: string): string => `${BASE_CONFIGURATION_DIR}/services/${uuid}`;

export interface ServiceResourcesContext {
  configuration: ServiceConfigurationContext;
  /** One morph class's volumes, mounts and tags (App\Models\Service, ServiceApplication or ServiceDatabase). */
  rows(morphClass: string): ResourceRowsStore;
  /** local_file_volumes.content */
  content: KeyCipher;
  /** Every row of the service and the service (deleteService). */
  deleteService(serviceId: Id): Promise<boolean>;
  /** The rows of Scheduled Tasks and Resource Operations (DP-97, resource-pages.ts). */
  pages?: ServicePagesStore;
  /** The destination lookups of Clone (DP-97, clone.ts). */
  clone?: ServiceCloneStore;
}

export const SERVICE_RESOURCE_MESSAGES = {
  /** Freeploy's: DeleteResourceJob stops the service and removes it from the server first. */
  deleteUnavailable: needsExecutor("Stopping the service and removing its containers, volumes, networks and configuration files from the server"),
} as const;

async function serviceResource(ctx: ServiceResourcesContext, uuid: string): Promise<LoadedResource | null> {
  const loaded = await loadServiceInfo(ctx.configuration, uuid);
  if (!loaded) return null;
  const { info, row } = loaded;
  return {
    kind: "service",
    id: row.id,
    uuid: row.uuid,
    name: row.name,
    frame: { service: info },
    projectUuid: info.project.uuid,
    environmentUuid: info.environment.uuid,
    workdir: serviceWorkdir(row.uuid),
    isCompose: true,
    isSwarm: false,
    gitBased: false,
    volumeUnavailableReason: null,
    serverIsFunctional: info.server?.isFunctional ?? false,
    nothingOnServer: async () => !(await ctx.configuration.store.hasRun(row.id)),
  };
}

/** The service's own context: Tags and the Danger Zone. */
export function serviceResources(ctx: ServiceResourcesContext): ResourcesContext {
  return { rows: ctx.rows(SERVICE_MORPH_CLASS), content: ctx.content, load: (uuid) => serviceResource(ctx, uuid) };
}

/** One application's or database's context: its storage, inside the service's frame. Null when not the service's. */
async function partResources(ctx: ServiceResourcesContext, uuid: string, partUuid: string): Promise<{ resources: ResourcesContext; kind: ServicePartKind } | null> {
  const loaded = await loadServiceInfo(ctx.configuration, uuid);
  const part = loaded?.parts.find((p) => p.row.uuid === partUuid);
  if (!loaded || !part) return null;
  const resource: LoadedResource = {
    kind: "service",
    id: part.row.id,
    uuid: part.row.uuid,
    name: part.row.name,
    frame: { service: loaded.info },
    projectUuid: loaded.info.project.uuid,
    environmentUuid: loaded.info.environment.uuid,
    // fileStorageHostPath(): the part's workdir() is the service's.
    workdir: serviceWorkdir(loaded.row.uuid),
    // "Service volume mounts are read-only here."
    isCompose: true,
    isSwarm: false,
    gitBased: false,
    volumeUnavailableReason: null,
    serverIsFunctional: loaded.info.server?.isFunctional ?? false,
    nothingOnServer: async () => !(await ctx.configuration.store.hasRun(loaded.row.id)),
  };
  return {
    kind: part.kind,
    resources: { rows: ctx.rows(SERVICE_PART_MORPH_CLASS[part.kind]), content: ctx.content, load: async (u) => (u === partUuid ? resource : null) },
  };
}

/** Runs one of the shared storage operations on a part of the service. */
export async function onServicePart<T>(ctx: ServiceResourcesContext, uuid: string, partUuid: string, fn: (resources: ResourcesContext) => Promise<T | null>): Promise<T | null> {
  const part = await partResources(ctx, uuid, partUuid);
  return part ? fn(part.resources) : null;
}

export interface ServiceStoragesPage {
  service: ServiceInfo;
  /** One section per application, then per database: storage.blade.php's service branch. */
  sections: Array<{ kind: ServicePartKind; uuid: string; name: string; title: string; storages: Omit<StoragesPage, "service"> }>;
}

/** configuration.blade.php's storages branch: every part's Storage. */
export async function showServiceStorages(ctx: ServiceResourcesContext, uuid: string, canUpdate: boolean): Promise<ServiceStoragesPage | null> {
  const loaded = await loadServiceInfo(ctx.configuration, uuid);
  if (!loaded) return null;
  const sections: ServiceStoragesPage["sections"] = [];
  for (const part of loaded.parts) {
    const page = await onServicePart(ctx, uuid, part.row.uuid, (resources) => showStorages(resources, part.row.uuid, canUpdate));
    if (!page) continue;
    // The frame is the service's, once for the page.
    const storages: Omit<StoragesPage, "service"> = Object.fromEntries(Object.entries(page).filter(([key]) => key !== "service")) as Omit<StoragesPage, "service">;
    const summary = [...loaded.info.applications, ...loaded.info.databases].find((p) => p.uuid === part.row.uuid);
    sections.push({ kind: part.kind, uuid: part.row.uuid, name: part.row.name, title: summary?.displayName ?? part.row.name, storages });
  }
  return { service: loaded.info, sections };
}

export interface ServiceDeleted {
  deleted: true;
  projectUuid: string;
  environmentUuid: string;
}

/**
 * Danger::delete() for a service: DeleteResourceJob stops it and removes its containers, volumes, networks and
 * files on the server, then DeleteService::deleteLocal() removes the rows. A service none of whose parts ever
 * ran has nothing on a server: its rows are removed at once. Any other answers 501. Null when not the org's.
 */
export async function deleteServiceNow(ctx: ServiceResourcesContext, uuid: string): Promise<ServiceDeleted | null> {
  const loaded = await loadServiceInfo(ctx.configuration, uuid);
  if (!loaded) return null;
  if (await ctx.configuration.store.hasRun(loaded.row.id)) throw new ServiceConfigurationError(SERVICE_RESOURCE_MESSAGES.deleteUnavailable, 501);
  await ctx.deleteService(loaded.row.id);
  return { deleted: true, projectUuid: loaded.info.project.uuid, environmentUuid: loaded.info.environment.uuid };
}

/** A service in the environment's resources list (Resource/Index::toSearchableArray($services, 'service', 'Service')). */
export interface ServiceListResource {
  uuid: string;
  name: string;
  type: "service";
  typeLabel: "Service";
  /** A service has no fqdn of its own. */
  fqdn: null;
  description: string | null;
  status: string;
  restartLimitReached: false;
  restartCount: 0;
  maxRestartCount: 0;
  /** The server_status accessor: the service's server is functional. */
  server_status: boolean;
  buildPack: "";
  destination: { server: { name: string } };
  tags: { id: string; name: string }[];
}

/** $environment->services()->…->sortBy('name'), each as the list shows it. */
export function serviceListResources(rows: readonly DeployEnvironmentServiceRow[], tags: ReadonlyMap<string, { id: string; name: string }[]> = new Map()): ServiceListResource[] {
  return [...rows]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((row) => {
      const parts = (typeof row.parts === "string" ? JSON.parse(row.parts) : row.parts) as { status: string; exclude_from_status: boolean; is_removed_from_compose: boolean }[] | null;
      return {
        uuid: row.uuid,
        name: row.name,
        type: "service",
        typeLabel: "Service",
        fqdn: null,
        description: row.description,
        status: serviceStatus(parts ?? []),
        restartLimitReached: false,
        restartCount: 0,
        maxRestartCount: 0,
        server_status:
          row.server_name !== null && isFunctional({ is_reachable: row.server_is_reachable, is_usable: row.server_is_usable, force_disabled: row.server_force_disabled, ip: row.server_ip ?? "" } as Parameters<typeof isFunctional>[0]),
        buildPack: "",
        destination: { server: { name: row.server_name ?? "Unknown" } },
        tags: tags.get(row.uuid) ?? [],
      };
    });
}
