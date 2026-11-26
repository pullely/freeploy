// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Database/Configuration.php and its view (the
// shared components a database's pages render with `:resource="$database"`), app/Livewire/Project/Shared/
// {ResourceOperations,ResourceLimits,Webhooks,Danger}.php (the database branch of cloneTo(), moveTo(), the
// limits, the deploy webhook, flush()), app/Livewire/Project/Service/Storage.php (fileStorageHostPath for a
// Standalone* model), app/Models/Standalone*.php (workdir, the created hook a replica passes through) and
// bootstrap/helpers/shared.php (clone_resource_name, generateDeployWebhook) (Apache-2.0), modified.
//
// A standalone database as the resource of the configuration pages Coolify
// shares with applications — Persistent Storage, Tags, Resource Operations,
// Resource Limits, Webhooks and the Danger Zone (the Environment Variables
// page is environment-variables/service.ts with the database's type) — and
// what a database does differently on them: its clone and move, its limits on
// its own row, the flush of Redis, KeyDB and Dragonfly. Rows only; what
// Coolify then does on a server answers "not available yet".
import type {
  DatabaseEngine,
  DatabaseLimitChanges,
  DatabaseReplica,
  DeployDatabaseLimitsRow,
  DeployDatabaseRow,
  DeployDestinationRow,
  DeployOperationEnvironmentTarget,
  DeployServerRow,
} from "@saas/db/deploy";
import type { KeyCipher } from "../private-keys/service.js";
import { blank } from "../private-keys/validation.js";
import { newPublicId } from "../helpers/names.js";
import { effectiveServerRole } from "../servers/service.js";
import { ENVIRONMENT_VARIABLE_VERSION } from "../environment-variables/service.js";
import { needsExecutor, type LoadedResource, type ResourceFrame, type ResourceRowsStore, type ResourcesContext } from "../applications/resources.js";
import { RESOURCE_OPERATION_MESSAGES, strLimit } from "../applications/resource-operations.js";
import { APPLICATION_SETTINGS_MESSAGES, SettingsError, SettingsFieldErrors, resourceLimitChanges, resourceLimits, type ResourceLimits } from "../applications/settings.js";
import { databaseWorkdir, isOutsideResourceDirectory } from "../applications/storage-paths.js";
import { DatabaseError, serverIsFunctional, showDatabase, type DatabaseContext, type DatabaseShow } from "./service.js";

type Id = string | number;
type Body = Record<string, unknown>;

/** What a database's shared pages need beyond its volumes, mounts and tags (rows). */
export interface DatabaseResourcesStore {
  findEnvironment(uuid: string): Promise<DeployOperationEnvironmentTarget | null>;
  findDestination(uuid: string): Promise<DeployDestinationRow | null>;
  findServer(uuid: string): Promise<DeployServerRow | null>;
  /** moveTo(): the database's environment. */
  move(engine: DatabaseEngine, id: Id, environmentId: Id): Promise<boolean>;
  /** $this->resource->replicate()->fill([…])->save(): the clone's id, or null when the source is gone. */
  replicate(engine: DatabaseEngine, sourceId: Id, replica: DatabaseReplica): Promise<Id | null>;
  /** $new_resource->tags()->attach() for each of the source's tags. */
  copyTags(engine: DatabaseEngine, sourceId: Id, cloneId: Id): Promise<void>;
  replicateVolume(volumeId: Id, replica: { uuid: string; name: string; resourceId: Id }): Promise<void>;
  replicateFile(fileId: Id, replica: { uuid: string; resourceId: Id }): Promise<void>;
  /** $this->resource->scheduledBackups()->get() */
  backupScheduleIds(engine: DatabaseEngine, id: Id): Promise<Id[]>;
  replicateBackupSchedule(scheduleId: Id, replica: { uuid: string; engine: DatabaseEngine; databaseId: Id }): Promise<void>;
  /** $this->resource->environment_variables()->get() */
  environmentVariableIds(engine: DatabaseEngine, id: Id): Promise<Id[]>;
  replicateEnvironmentVariable(variableId: Id, replica: { uuid: string; engine: DatabaseEngine; databaseId: Id; version: string }): Promise<void>;
  limits(engine: DatabaseEngine, id: Id): Promise<DeployDatabaseLimitsRow | null>;
  updateLimits(engine: DatabaseEngine, id: Id, changes: DatabaseLimitChanges): Promise<boolean>;
}

export interface DatabaseResourcesContext {
  /** DP-57's store and ciphers: the database as its own pages read it (showDatabase). */
  database: DatabaseContext;
  /** The database's volumes, mounts and tags: bound to its morph class. */
  rows: ResourceRowsStore;
  /** The cipher of local_file_volumes.content. */
  content: KeyCipher;
  store: DatabaseResourcesStore;
}

export const DATABASE_RESOURCE_MESSAGES = {
  /** Freeploy's: the SSH executor is not deployed yet. */
  flushUnavailable: needsExecutor("Flushing the database's data on the server"),
} as const;

/** The engines whose Danger Zone has "Flush all data" (danger.blade.php). */
export const FLUSHABLE_ENGINES: readonly DatabaseEngine[] = ["redis", "keydb", "dragonfly"];

interface LoadedDatabase {
  row: DeployDatabaseRow;
  database: DatabaseShow;
}

async function loadDatabase(ctx: DatabaseResourcesContext, uuid: string, canUpdate: boolean): Promise<LoadedDatabase | null> {
  const row = await ctx.database.store.findByUuid(uuid);
  const database = row ? await showDatabase(ctx.database, uuid, canUpdate) : null;
  return row && database ? { row, database } : null;
}

/**
 * A database as the shared pages' resource: its directory on the server is
 * workdir() (database_configuration_dir()/uuid), it has no Compose file, no
 * preview deployments and no additional servers, and Storage::mount() looks
 * for a Swarm server only for an application.
 */
export function databaseResource(l: LoadedDatabase): LoadedResource {
  const { row, database } = l;
  return {
    kind: "database",
    id: row.id,
    uuid: row.uuid,
    name: row.name,
    frame: { database },
    projectUuid: row.project_uuid,
    environmentUuid: row.environment_uuid,
    workdir: databaseWorkdir(row.uuid),
    isCompose: false,
    isSwarm: false,
    gitBased: false,
    volumeUnavailableReason: null,
    serverIsFunctional: serverIsFunctional(row),
    // DP-57's delete rule: a database that never left 'exited' and was never started has nothing on a server.
    nothingOnServer: async () => row.status.startsWith("exited") && row.started_at === null,
  };
}

/** A database's context for the shared pages. */
export function databaseResources(ctx: DatabaseResourcesContext): ResourcesContext {
  return {
    rows: ctx.rows,
    content: ctx.content,
    load: async (uuid, canUpdate) => {
      const l = await loadDatabase(ctx, uuid, canUpdate);
      return l ? databaseResource(l) : null;
    },
  };
}

// ---------------------------------------------------------------- Resource Operations

/**
 * clone_resource_name(): the name without the clone suffixes it already has,
 * cut to leave room (Str::limit with no ending), then "-clone-<uuid>".
 */
export function cloneResourceName(name: string, uuid: string): string {
  const suffix = `-clone-${uuid}`;
  const base = name.replace(/(-clone-[a-z0-9]{7,})+$/i, "");
  return `${strLimit(base, 255 - suffix.length, "")}${suffix}`;
}

/** The prefixes cloneTo() renames to the clone's uuid, in its order. */
const DATA_VOLUME_PREFIXES = ["postgres-data-", "mysql-data-", "redis-data-", "clickhouse-data-", "mariadb-data-", "mongodb-data-", "keydb-data-", "dragonfly-data-", "sqlite-data-"] as const;

/**
 * cloneTo()'s name for a volume of a database's clone: a known data volume
 * prefix with the clone's uuid; else the name with the clone's uuid in place
 * of the source's when it starts with it; else the clone's uuid, a hyphen and
 * the whole name. MongoDB's two volumes (mongodb-configdb-, mongodb-db-) have
 * none of the prefixes, so they get the last form, as in Coolify.
 */
export function clonedDatabaseVolumeName(name: string, sourceUuid: string, cloneUuid: string): string {
  const prefix = DATA_VOLUME_PREFIXES.find((p) => name.startsWith(p));
  if (prefix) return `${prefix}${cloneUuid}`;
  // str()->replace(): every occurrence.
  if (name.startsWith(sourceUuid)) return name.split(sourceUuid).join(cloneUuid);
  return `${cloneUuid}-${name}`;
}

export interface DatabaseOperationResult {
  /** Where the page goes next: the database's configuration, "#resource-operations". */
  projectUuid: string;
  environmentUuid: string;
  databaseUuid: string;
  /** What Coolify would now do on the server and cannot be done yet. */
  unavailable?: string;
}

/** findResourceTeamEnvironment(): an environment of the org, by uuid; Coolify's field error otherwise. */
async function targetEnvironment(ctx: DatabaseResourcesContext, value: unknown): Promise<DeployOperationEnvironmentTarget> {
  const found = typeof value === "string" && !blank(value) ? await ctx.store.findEnvironment(value) : null;
  if (!found) throw new SettingsFieldErrors({ environment_id: [RESOURCE_OPERATION_MESSAGES.environmentNotFound] });
  return found;
}

/** ResourceOperations::moveTo() for a database: its environment changes. Null when the database is not the org's. */
export async function moveDatabaseTo(ctx: DatabaseResourcesContext, uuid: string, body: Body): Promise<DatabaseOperationResult | null> {
  const row = await ctx.database.store.findByUuid(uuid);
  if (!row) return null;
  const environment = await targetEnvironment(ctx, body.environment_uuid);
  await ctx.store.move(row.engine, row.id, environment.id);
  return { projectUuid: environment.project_uuid, environmentUuid: environment.uuid, databaseUuid: row.uuid };
}

/**
 * ResourceOperations::cloneTo() for a standalone database:
 *
 *   the database's row (a new uuid, clone_resource_name(), status 'exited',
 *   never started, the chosen environment and destination; credentials,
 *   public port and configuration as stored — Coolify generates no new
 *   password or port), its tags, its volumes under the clone's names (the
 *   created hook's are deleted first, so the clone has exactly the source's),
 *   its file and directory mounts, its backup schedules with their S3
 *   destinations, and its environment variables (Redis's credentials among
 *   them), values as stored.
 *
 * Not copied here: the secret manager link. After the rows:
 * `cloneVolumeData` stops the source and copies its volumes on the server,
 * and a managed mount inside the clone's own directory is written there —
 * neither is available yet. Null when the database is not the org's.
 */
export async function cloneDatabaseTo(ctx: DatabaseResourcesContext, uuid: string, body: Body, opts: { uuid?: string; name?: string } = {}): Promise<DatabaseOperationResult | null> {
  const source = await ctx.database.store.findByUuid(uuid);
  if (!source) return null;
  let environment = { id: source.environment_id!, uuid: source.environment_uuid, project_uuid: source.project_uuid };
  if (body.environment_uuid !== undefined && body.environment_uuid !== null) environment = await targetEnvironment(ctx, body.environment_uuid);
  // findResourceTeamDestination(): one of the org's, on a server that can host resources.
  const destination = typeof body.destination_uuid === "string" && !blank(body.destination_uuid) ? await ctx.store.findDestination(body.destination_uuid) : null;
  const server = destination ? await ctx.store.findServer(destination.server_uuid) : null;
  if (!destination || !server || effectiveServerRole(server) === "build") throw new SettingsFieldErrors({ destination_id: [RESOURCE_OPERATION_MESSAGES.destinationNotFound] });

  // The API's clone_by_uuid() may give the uuid and the name (DP-86).
  const clone = opts.uuid ?? newPublicId();
  const volumes = await ctx.rows.volumes(source.id);
  const volumeNames = volumes.map((volume) => clonedDatabaseVolumeName(volume.name, source.uuid, clone));
  // Coolify fails on the table's unique index in the middle of the clone and keeps what it had copied; here nothing is copied.
  if (new Set(volumeNames).size !== volumeNames.length) throw new SettingsError(RESOURCE_OPERATION_MESSAGES.duplicate, 422);

  const id = await ctx.store.replicate(source.engine, source.id, {
    uuid: clone,
    name: opts.name ?? cloneResourceName(source.name, clone),
    environmentId: environment.id,
    destinationId: destination.id,
    destinationType: destination.type,
  });
  if (id === null) return null;
  await ctx.store.copyTags(source.engine, source.id, id);
  for (const [i, volume] of volumes.entries()) await ctx.store.replicateVolume(volume.id, { uuid: newPublicId(), name: volumeNames[i]!, resourceId: id });
  const files = await ctx.rows.files(source.id);
  for (const file of files) await ctx.store.replicateFile(file.id, { uuid: newPublicId(), resourceId: id });
  for (const schedule of await ctx.store.backupScheduleIds(source.engine, source.id)) {
    await ctx.store.replicateBackupSchedule(schedule, { uuid: newPublicId(), engine: source.engine, databaseId: id });
  }
  for (const variable of await ctx.store.environmentVariableIds(source.engine, source.id)) {
    await ctx.store.replicateEnvironmentVariable(variable, { uuid: newPublicId(), engine: source.engine, databaseId: id, version: ENVIRONMENT_VARIABLE_VERSION });
  }

  const unavailable: string[] = [];
  if (body.cloneVolumeData === true && volumes.length > 0) unavailable.push(RESOURCE_OPERATION_MESSAGES.volumeDataUnavailable);
  // LocalFileVolume's created hook queues the write of a managed mount inside the clone's own directory.
  if (files.some((f) => !f.is_host_file && !isOutsideResourceDirectory(f.fs_path, databaseWorkdir(clone)))) unavailable.push(RESOURCE_OPERATION_MESSAGES.fileMountsUnavailable);
  return { projectUuid: environment.project_uuid, environmentUuid: environment.uuid, databaseUuid: clone, ...(unavailable.length ? { unavailable: unavailable.join(" ") } : {}) };
}

// ---------------------------------------------------------------- Resource Limits

export type DatabaseLimitsPage = ResourceFrame & { settings: ResourceLimits };

/** ResourceLimits::mount() for a database. */
export async function showDatabaseLimits(ctx: DatabaseResourcesContext, uuid: string, canUpdate: boolean): Promise<DatabaseLimitsPage | null> {
  const l = await loadDatabase(ctx, uuid, canUpdate);
  const limits = l ? await ctx.store.limits(l.row.engine, l.row.id) : null;
  return l && limits ? { database: l.database, settings: resourceLimits(limits) } : null;
}

/** ResourceLimits::submit() for a database: the same defaults, rules and messages; the limits are its own row's. */
export async function saveDatabaseLimits(ctx: DatabaseResourcesContext, uuid: string, body: Body): Promise<(DatabaseLimitsPage & { message: string }) | null> {
  const l = await loadDatabase(ctx, uuid, true);
  const limits = l ? await ctx.store.limits(l.row.engine, l.row.id) : null;
  if (!l || !limits) return null;
  const changes = resourceLimitChanges(body, limits);
  if (Object.keys(changes).length) await ctx.store.updateLimits(l.row.engine, l.row.id, changes);
  return { database: l.database, settings: resourceLimits((await ctx.store.limits(l.row.engine, l.row.id))!), message: APPLICATION_SETTINGS_MESSAGES.limitsUpdated };
}

// ---------------------------------------------------------------- Webhooks

export type DatabaseWebhooksPage = ResourceFrame & {
  /** generateDeployWebhook(): the path and query below the API origin (the page knows the origin). */
  deployWebhookPath: string;
};

/** Webhooks::mount() for a database: only the deploy webhook (webhooks.blade.php's branch for what is not an application). */
export async function showDatabaseWebhooks(ctx: DatabaseResourcesContext, uuid: string, canUpdate: boolean): Promise<DatabaseWebhooksPage | null> {
  const l = await loadDatabase(ctx, uuid, canUpdate);
  return l ? { database: l.database, deployWebhookPath: `/api/v1/deploy?uuid=${l.row.uuid}&force=false` } : null;
}

// ---------------------------------------------------------------- Danger Zone

/**
 * Danger::flush(): FlushDatabase removes every key on the server, so it
 * answers 501. Only Redis, KeyDB and Dragonfly have it; null for another
 * engine, as for a database that is not the org's.
 */
export async function flushDatabase(ctx: DatabaseResourcesContext, uuid: string): Promise<null> {
  const row = await ctx.database.store.findByUuid(uuid);
  if (!row || !FLUSHABLE_ENGINES.includes(row.engine)) return null;
  throw new DatabaseError(DATABASE_RESOURCE_MESSAGES.flushUnavailable, 501);
}
