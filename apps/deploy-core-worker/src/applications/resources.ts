// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/Configuration.php (Apache-2.0),
// modified.
//
// What an application's Persistent Storage, Tags, Resource Operations and
// Danger Zone pages share: the store they read and write through, and the
// application as the configuration frame and each page need it.
import type {
  ApplicationReplica,
  DeployApplicationConfigurationRow,
  DeployApplicationRow,
  DeployDestinationRow,
  DeployFileVolumeRow,
  DeployOperationDestinationRow,
  DeployOperationEnvironmentRow,
  DeployOperationEnvironmentTarget,
  DeployOperationServerRow,
  DeployPersistentVolumeRow,
  DeployServerRow,
  DeployTagRow,
  FileVolumeChanges,
  PersistentVolumeChanges,
} from "@saas/db/deploy";
import type { KeyCipher } from "../private-keys/service.js";
import { applicationShow, type ApplicationShow } from "./service.js";

type Id = string | number;

export interface ApplicationResourcesStore {
  /** The application as the configuration frame reads it (heading, menu). */
  findByUuid(uuid: string): Promise<DeployApplicationRow | null>;
  /** The application with its settings and its destination's server. */
  configuration(uuid: string): Promise<DeployApplicationConfigurationRow | null>;

  // Persistent Storage
  /** $application->persistentStorages, oldest first. */
  volumes(applicationId: Id): Promise<DeployPersistentVolumeRow[]>;
  findVolume(applicationId: Id, id: Id): Promise<DeployPersistentVolumeRow | null>;
  insertVolume(volume: { applicationId: Id; uuid: string; name: string; mountPath: string }): Promise<DeployPersistentVolumeRow>;
  updateVolume(applicationId: Id, id: Id, changes: PersistentVolumeChanges): Promise<boolean>;
  deleteVolume(applicationId: Id, id: Id): Promise<boolean>;
  /** $application->fileStorages: files and directories, oldest first; the content as stored (encrypted). */
  files(applicationId: Id): Promise<DeployFileVolumeRow[]>;
  findFile(applicationId: Id, id: Id): Promise<DeployFileVolumeRow | null>;
  insertFile(file: { applicationId: Id; uuid: string; fsPath: string; mountPath: string; content: string | null; isDirectory: boolean; isHostFile: boolean }): Promise<DeployFileVolumeRow>;
  updateFile(applicationId: Id, id: Id, changes: FileVolumeChanges): Promise<boolean>;
  deleteFile(applicationId: Id, id: Id): Promise<boolean>;

  // Tags
  /** The org's tags, by name. */
  tags(): Promise<DeployTagRow[]>;
  applicationTags(applicationId: Id): Promise<DeployTagRow[]>;
  findTagByName(name: string): Promise<DeployTagRow | null>;
  findTagById(id: Id): Promise<DeployTagRow | null>;
  insertTag(tag: { uuid: string; name: string }): Promise<DeployTagRow>;
  hasTag(applicationId: Id, tagId: Id): Promise<boolean>;
  attachTag(applicationId: Id, tagId: Id): Promise<void>;
  detachTag(applicationId: Id, tagId: Id): Promise<boolean>;

  // Resource Operations
  operationEnvironments(): Promise<DeployOperationEnvironmentRow[]>;
  operationServers(): Promise<DeployOperationServerRow[]>;
  operationDestinations(): Promise<DeployOperationDestinationRow[]>;
  findEnvironment(uuid: string): Promise<DeployOperationEnvironmentTarget | null>;
  findDestination(uuid: string): Promise<DeployDestinationRow | null>;
  findServer(uuid: string): Promise<DeployServerRow | null>;
  move(applicationId: Id, environmentId: Id): Promise<boolean>;
  replicateApplication(sourceId: Id, replica: ApplicationReplica): Promise<Id | null>;
  replicateSettings(sourceId: Id, applicationId: Id): Promise<boolean>;
  copyTags(sourceId: Id, applicationId: Id): Promise<void>;
  scheduledTaskIds(applicationId: Id): Promise<Id[]>;
  replicateScheduledTask(taskId: Id, replica: { uuid: string; applicationId: Id }): Promise<void>;
  replicateVolume(volumeId: Id, replica: { uuid: string; name: string; resourceId: Id }): Promise<void>;
  replicateFile(fileId: Id, replica: { uuid: string; resourceId: Id }): Promise<void>;
  environmentVariableIds(applicationId: Id): Promise<Id[]>;
  replicateEnvironmentVariable(variableId: Id, replica: { uuid: string; applicationId: Id }): Promise<void>;

  // Danger Zone
  /** Whether a deployment was ever queued for the application. */
  hasDeployments(applicationId: Id): Promise<boolean>;
  /** The application with every row that belongs to it. */
  deleteApplication(applicationId: Id): Promise<boolean>;
}

export interface ApplicationResourcesContext {
  store: ApplicationResourcesStore;
  /** The cipher of local_file_volumes.content (an `encrypted` cast). */
  content: KeyCipher;
  /**
   * generateLabelsApplication() for an application of the org, stored as its
   * custom_labels (base64 of the text): what clone_application() does for a
   * clone whose domain was generated again.
   */
  generateLabels?: (uuid: string) => Promise<void>;
}

export interface LoadedApplication {
  row: DeployApplicationConfigurationRow;
  application: ApplicationShow;
}

/** The application for the frame and for the page, or null when it is not the org's. */
export async function loadApplication(ctx: ApplicationResourcesContext, uuid: string, canUpdate: boolean): Promise<LoadedApplication | null> {
  const row = await ctx.store.configuration(uuid);
  const frame = row ? await ctx.store.findByUuid(uuid) : null;
  return row && frame ? { row, application: applicationShow(frame, canUpdate) } : null;
}

/** A row id from the path: digits only (a bigint), else null. */
export function rowId(value: string | undefined): string | null {
  return value !== undefined && /^[1-9]\d{0,17}$/.test(value) ? value : null;
}

/** What a body field holds when it is a string (a number is read as its text, as PHP coerces it); anything else as it is. */
export const text = (v: unknown): unknown => (typeof v === "number" && Number.isFinite(v) ? String(v) : v);

/** "<What> needs the SSH executor, which is not available yet." */
export const needsExecutor = (what: string): string => `${what} needs the SSH executor, which is not available yet.`;
