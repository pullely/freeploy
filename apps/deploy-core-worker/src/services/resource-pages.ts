// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/service/configuration.blade.php (the
// scheduled-tasks, webhooks and resource-operations branches), app/Livewire/Project/Shared/{Webhooks,
// ResourceOperations}.php, app/Livewire/Project/Shared/ScheduledTask/{All,Add,Show}.php, app/Models/Service.php
// (isRunning) and bootstrap/helpers/shared.php (getServerTimezone) (Apache-2.0), modified.
//
// The pages of a service that are Coolify's shared components with `:resource="$service"` beside those of
// resources.ts (DP-97): Scheduled Tasks (applications/scheduled-tasks.ts on the service's task rows), Webhooks
// (the deploy webhook only, as for anything that is not an application) and Resource Operations (where it can
// go, and Move; Clone is clone.ts's).
import type { DeployOperationEnvironmentTarget, DeployScheduledTaskExecutionRow, DeployScheduledTaskRow, ScheduledTaskChanges } from "@saas/db/deploy";
import { blank } from "../private-keys/validation.js";
import { SettingsFieldErrors } from "../applications/settings.js";
import { RESOURCE_OPERATION_MESSAGES } from "../applications/resource-operations.js";
import type { TaskHost } from "../applications/scheduled-tasks.js";
import { loadServiceInfo, type ServiceInfo } from "./configuration.js";
import type { ServiceResourcesContext } from "./resources.js";

type Id = string | number;
type Body = Record<string, unknown>;

/** What the pages of this module read and write beside the configuration's rows. */
export interface ServicePagesStore {
  tasks(serviceId: Id): Promise<DeployScheduledTaskRow[]>;
  findTask(serviceId: Id, uuid: string): Promise<DeployScheduledTaskRow | null>;
  insertTask(task: { serviceId: Id; uuid: string; name: string; command: string; frequency: string; container: string | null; timeout: number; useShell: boolean }): Promise<DeployScheduledTaskRow>;
  updateTask(serviceId: Id, id: Id, changes: ScheduledTaskChanges): Promise<boolean>;
  deleteTask(serviceId: Id, id: Id): Promise<boolean>;
  executions(taskId: Id): Promise<DeployScheduledTaskExecutionRow[]>;
  /** data_get($server, 'settings.server_timezone') */
  serverTimezone(serverId: Id | null): Promise<string | null>;
  /** findResourceTeamEnvironment(): an environment of the org, by uuid. */
  findEnvironment(uuid: string): Promise<DeployOperationEnvironmentTarget | null>;
  /** $service->fill(['environment_id' => …])->save() */
  move(serviceId: Id, environmentId: Id): Promise<boolean>;
}

/** The pages' store: every runner of the handler gives one. */
export function pagesOf(ctx: ServiceResourcesContext): ServicePagesStore {
  if (!ctx.pages) throw new Error("The service's pages store is missing.");
  return ctx.pages;
}

/** Service::isRunning(): str($status)->contains('running'). */
export const serviceIsRunning = (status: string): boolean => status.includes("running");

/** The service as All's resource: its task rows, its parts' names as the containers, its server's timezone. */
export async function serviceTaskHost(ctx: ServiceResourcesContext, uuid: string): Promise<TaskHost | null> {
  const loaded = await loadServiceInfo(ctx.configuration, uuid);
  if (!loaded) return null;
  const store = pagesOf(ctx);
  const id = loaded.row.id;
  return {
    kind: "service",
    frame: { service: loaded.info },
    rows: {
      tasks: () => store.tasks(id),
      findTask: (taskUuid) => store.findTask(id, taskUuid),
      insertTask: (t) => store.insertTask({ serviceId: id, ...t }),
      updateTask: (taskId, changes) => store.updateTask(id, taskId, changes),
      deleteTask: (taskId) => store.deleteTask(id, taskId),
      executions: (taskId) => store.executions(taskId),
    },
    // $this->resource->applications()->pluck('name')->merge($this->resource->databases()->pluck('name'))
    containerNames: [...loaded.parts.filter((p) => p.kind === "application"), ...loaded.parts.filter((p) => p.kind === "database")].map((p) => p.row.name),
    // getServerTimezone($this->resource->destination?->server): the setting, else UTC.
    serverTimezone: (await store.serverTimezone(loaded.row.server_id)) || "UTC",
    isRunning: serviceIsRunning(loaded.info.status),
  };
}

export interface ServiceWebhooksPage {
  service: ServiceInfo;
  /** generateDeployWebhook($resource): the path of /api/v1/deploy for this service. */
  deployWebhookPath: string;
}

/** Webhooks::mount() for a service: the deploy webhook only. Null when the service is not the org's. */
export async function showServiceWebhooks(ctx: ServiceResourcesContext, uuid: string): Promise<ServiceWebhooksPage | null> {
  const loaded = await loadServiceInfo(ctx.configuration, uuid);
  return loaded ? { service: loaded.info, deployWebhookPath: `/api/v1/deploy?uuid=${loaded.row.uuid}&force=false` } : null;
}

export interface ServiceOperationResult {
  /** Where the page goes next: the service's configuration, "#resource-operations". */
  projectUuid: string;
  environmentUuid: string;
  serviceUuid: string;
  /** What Coolify would now do on the server and cannot be done yet. */
  unavailable?: string;
}

/** findResourceTeamEnvironment(): an environment of the org, by uuid; Coolify's field error otherwise. */
export async function serviceTargetEnvironment(ctx: ServiceResourcesContext, value: unknown): Promise<DeployOperationEnvironmentTarget> {
  const found = typeof value === "string" && !blank(value) ? await pagesOf(ctx).findEnvironment(value) : null;
  if (!found) throw new SettingsFieldErrors({ environment_id: [RESOURCE_OPERATION_MESSAGES.environmentNotFound] });
  return found;
}

/** ResourceOperations::moveTo() for a service: its environment changes. Null when the service is not the org's. */
export async function moveServiceTo(ctx: ServiceResourcesContext, uuid: string, body: Body): Promise<ServiceOperationResult | null> {
  const loaded = await loadServiceInfo(ctx.configuration, uuid);
  if (!loaded) return null;
  const environment = await serviceTargetEnvironment(ctx, body.environment_uuid);
  await pagesOf(ctx).move(loaded.row.id, environment.id);
  return { projectUuid: environment.project_uuid, environmentUuid: environment.uuid, serviceUuid: loaded.row.uuid };
}
