// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/Configuration.php,
// app/Livewire/Project/Database/Configuration.php and app/Livewire/Project/Service/Storage.php
// (fileStorageHostPath, getVolumeUnavailableReasonProperty) (Apache-2.0), modified.
//
// What the Persistent Storage, Tags, Resource Operations and Danger Zone
// pages share — Coolify's Livewire components for any resource
// (`:resource="$application"` or `:resource="$database"`): the rows they read
// and write through (ResourceRowsStore: volumes, mounts and tags are morph
// rows, so the store is bound to the resource's morph class), and the
// resource as the configuration frame and each page need it (LoadedResource).
// An application's store and loader are below; a standalone database's are in
// databases/resources.ts.
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
import type { DatabaseShow } from "../databases/service.js";
import { applicationShow, type ApplicationShow } from "./service.js";
import { serverIsFunctional } from "./settings.js";
import { applicationWorkdir } from "./storage-paths.js";

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

// ---------------------------------------------------------------- any resource

/** One resource's volumes, mounts and tags — the store binds them to its morph class — and where it can be cloned or moved to. */
export interface ResourceRowsStore {
  /** $resource->persistentStorages, oldest first. */
  volumes(resourceId: Id): Promise<DeployPersistentVolumeRow[]>;
  findVolume(resourceId: Id, id: Id): Promise<DeployPersistentVolumeRow | null>;
  insertVolume(volume: { resourceId: Id; uuid: string; name: string; mountPath: string }): Promise<DeployPersistentVolumeRow>;
  updateVolume(resourceId: Id, id: Id, changes: PersistentVolumeChanges): Promise<boolean>;
  deleteVolume(resourceId: Id, id: Id): Promise<boolean>;
  /** $resource->fileStorages: files and directories, oldest first; the content as stored (encrypted). */
  files(resourceId: Id): Promise<DeployFileVolumeRow[]>;
  findFile(resourceId: Id, id: Id): Promise<DeployFileVolumeRow | null>;
  insertFile(file: { resourceId: Id; uuid: string; fsPath: string; mountPath: string; content: string | null; isDirectory: boolean; isHostFile: boolean }): Promise<DeployFileVolumeRow>;
  updateFile(resourceId: Id, id: Id, changes: FileVolumeChanges): Promise<boolean>;
  deleteFile(resourceId: Id, id: Id): Promise<boolean>;
  /** The org's tags, by name. */
  tags(): Promise<DeployTagRow[]>;
  /** $resource->tags */
  resourceTags(resourceId: Id): Promise<DeployTagRow[]>;
  findTagByName(name: string): Promise<DeployTagRow | null>;
  findTagById(id: Id): Promise<DeployTagRow | null>;
  insertTag(tag: { uuid: string; name: string }): Promise<DeployTagRow>;
  hasTag(resourceId: Id, tagId: Id): Promise<boolean>;
  attachTag(resourceId: Id, tagId: Id): Promise<void>;
  detachTag(resourceId: Id, tagId: Id): Promise<boolean>;
  operationEnvironments(): Promise<DeployOperationEnvironmentRow[]>;
  operationServers(): Promise<DeployOperationServerRow[]>;
  operationDestinations(): Promise<DeployOperationDestinationRow[]>;
}

/** The configuration frame of the answer: the application or the database, as its own pages read it. */
export type ResourceFrame = { application: ApplicationShow } | { database: DatabaseShow };

/** A resource as the shared pages need it. */
export interface LoadedResource {
  kind: "application" | "database";
  id: Id;
  uuid: string;
  name: string;
  frame: ResourceFrame;
  projectUuid: string;
  environmentUuid: string;
  /** fileStorageHostPath(): the resource's directory on the server (its workdir()). */
  workdir: string;
  /** build_pack 'dockercompose': the volumes are the Compose file's, read-only here. */
  isCompose: boolean;
  /** Storage::mount(): an application on a Swarm server. */
  isSwarm: boolean;
  /** An application's git_based(): the views' preview deployment (PR suffix) controls. */
  gitBased: boolean;
  /** getVolumeUnavailableReasonProperty(): an application's only. */
  volumeUnavailableReason: string | null;
  /** Server::isFunctional() of the resource's server. */
  serverIsFunctional: boolean;
  /** Nothing of the resource can exist on a server: the Danger Zone deletes its rows at once. */
  nothingOnServer(): Promise<boolean>;
}

/** What the shared pages run with: the resource's rows, the file content's cipher, and how the resource is found. */
export interface ResourcesContext {
  rows: ResourceRowsStore;
  /** The cipher of local_file_volumes.content (an `encrypted` cast). */
  content: KeyCipher;
  /** The resource by uuid, or null when it is not the org's. */
  load(uuid: string, canUpdate: boolean): Promise<LoadedResource | null>;
}

/** Application::persistentStorageUnavailableReason() */
export const MULTIPLE_SERVERS_VOLUME_REASON = "Applications that use multiple servers cannot have persistent storage because volumes are not shared between servers.";

/** An application's store as the shared pages' rows. */
export function applicationRows(store: ApplicationResourcesStore): ResourceRowsStore {
  return {
    volumes: (id) => store.volumes(id),
    findVolume: (id, volumeId) => store.findVolume(id, volumeId),
    insertVolume: ({ resourceId, ...v }) => store.insertVolume({ applicationId: resourceId, ...v }),
    updateVolume: (id, volumeId, changes) => store.updateVolume(id, volumeId, changes),
    deleteVolume: (id, volumeId) => store.deleteVolume(id, volumeId),
    files: (id) => store.files(id),
    findFile: (id, fileId) => store.findFile(id, fileId),
    insertFile: ({ resourceId, ...f }) => store.insertFile({ applicationId: resourceId, ...f }),
    updateFile: (id, fileId, changes) => store.updateFile(id, fileId, changes),
    deleteFile: (id, fileId) => store.deleteFile(id, fileId),
    tags: () => store.tags(),
    resourceTags: (id) => store.applicationTags(id),
    findTagByName: (name) => store.findTagByName(name),
    findTagById: (id) => store.findTagById(id),
    insertTag: (tag) => store.insertTag(tag),
    hasTag: (id, tagId) => store.hasTag(id, tagId),
    attachTag: (id, tagId) => store.attachTag(id, tagId),
    detachTag: (id, tagId) => store.detachTag(id, tagId),
    operationEnvironments: () => store.operationEnvironments(),
    operationServers: () => store.operationServers(),
    operationDestinations: () => store.operationDestinations(),
  };
}

/** An application as a LoadedResource. */
export function applicationResource(ctx: ApplicationResourcesContext, l: LoadedApplication): LoadedResource {
  const { row, application } = l;
  return {
    kind: "application",
    id: row.id,
    uuid: row.uuid,
    name: row.name,
    frame: { application },
    projectUuid: application.project.uuid,
    environmentUuid: application.environment.uuid,
    workdir: applicationWorkdir(row.uuid),
    isCompose: row.build_pack === "dockercompose",
    isSwarm: application.server?.isSwarm ?? false,
    gitBased: !row.has_dockerfile && row.build_pack !== "dockerimage",
    volumeUnavailableReason: Number(row.additional_servers) > 0 ? MULTIPLE_SERVERS_VOLUME_REASON : null,
    serverIsFunctional: serverIsFunctional(row),
    // It never left 'exited', no container of it is known, and no deployment was ever queued.
    nothingOnServer: async () => row.status.startsWith("exited") && application.containerPresent !== true && !(await ctx.store.hasDeployments(row.id)),
  };
}

/** An application's context for the shared pages. */
export function applicationResources(ctx: ApplicationResourcesContext): ResourcesContext {
  return {
    rows: applicationRows(ctx.store),
    content: ctx.content,
    load: async (uuid, canUpdate) => {
      const l = await loadApplication(ctx, uuid, canUpdate);
      return l ? applicationResource(ctx, l) : null;
    },
  };
}
