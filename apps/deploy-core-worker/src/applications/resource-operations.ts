// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Shared/ResourceOperations.php (mount,
// cloneTo, moveTo, findResourceTeamEnvironment, findResourceTeamDestination), bootstrap/helpers/applications.php
// (clone_application), bootstrap/helpers/shared.php (clone_resource_name is for databases; an application's
// clone is "clone-of-…"), app/Models/Server.php (canHostResources, isBuildServer, isFunctional, proxyType) and
// app/Actions/Shared/CloneVolumeDataWithSourceStopped.php (Apache-2.0), modified.
//
// A resource's Resource Operations page (the same component for an
// application and a standalone database: where it can go), and an
// application's Clone (a copy of the application on any destination, in any
// environment of the org) and Move (to another environment); a database's are
// databases/resources.ts's. Both are rows; what a clone would then do on a server — copy
// the volume data, write the file mounts — is reported as not available yet,
// after the rows are stored, which is Coolify's own order.
import type { DeployApplicationConfigurationRow } from "@saas/db/deploy";
import { blank } from "../private-keys/validation.js";
import { newPublicId } from "../helpers/names.js";
import { effectiveServerRole, isFunctional } from "../servers/service.js";
import { generateUrl, normalizeDomainPortOverrides, syncNoindexDomains } from "./domains.js";
import { SettingsError, SettingsFieldErrors, jsonValue } from "./settings.js";
import { loadApplication, needsExecutor, type ApplicationResourcesContext, type ResourceFrame, type ResourcesContext } from "./resources.js";
import { applicationWorkdir, isOutsideResourceDirectory } from "./storage-paths.js";

type Body = Record<string, unknown>;

export const RESOURCE_OPERATION_MESSAGES = {
  /** cloneTo() and moveTo(): addError('environment_id' | 'destination_id', …) */
  environmentNotFound: "Environment not found.",
  destinationNotFound: "Destination not found.",
  /** handleError() for a UniqueConstraintViolationException: two volumes of the source get the same name in the clone. */
  duplicate: "Duplicate entry found. Please use a different name.",
  /** Freeploy's: the SSH executor is not deployed yet. */
  volumeDataUnavailable: needsExecutor("Copying the volume data to the clone"),
  fileMountsUnavailable: needsExecutor("Writing the clone's file mounts to the server"),
} as const;

export interface OperationProject {
  uuid: string;
  name: string;
  environments: Array<{ uuid: string; name: string }>;
}

export interface OperationServer {
  uuid: string;
  name: string;
  ip: string;
  isFunctional: boolean;
  destinations: Array<{ uuid: string; name: string }>;
}

export type ResourceOperationsPage = ResourceFrame & {
  /** The org's projects by name (case-insensitive), each with its environments. */
  projects: OperationProject[];
  /** The servers that can host resources, each with its destinations (standalone, then Swarm). */
  servers: OperationServer[];
  /** Build servers: listed, never selectable. */
  buildServers: Array<{ uuid: string; name: string }>;
};

/**
 * ResourceOperations::mount(). The lists are for who may update: the view
 * shows everyone else a notice only. `placeResource` is the org-wide write
 * permission here, so every server that is not a build server is listed.
 */
export async function showResourceOperations(ctx: ResourcesContext, uuid: string, canUpdate: boolean): Promise<ResourceOperationsPage | null> {
  const l = await ctx.load(uuid, canUpdate);
  if (!l) return null;
  if (!canUpdate) return { ...l.frame, projects: [], servers: [], buildServers: [] };

  const projects = new Map<string, OperationProject>();
  for (const row of await ctx.rows.operationEnvironments()) {
    let project = projects.get(row.project_uuid);
    if (!project) projects.set(row.project_uuid, (project = { uuid: row.project_uuid, name: row.project_name, environments: [] }));
    if (row.environment_uuid !== null) project.environments.push({ uuid: row.environment_uuid, name: row.environment_name ?? "" });
  }
  const all = await ctx.rows.operationServers();
  const destinations = await ctx.rows.operationDestinations();
  const build = (s: (typeof all)[number]) => effectiveServerRole(s) === "build";
  return {
    ...l.frame,
    projects: [...projects.values()],
    servers: all
      .filter((s) => !build(s))
      .map((s) => ({
        uuid: s.uuid,
        name: s.name,
        ip: s.ip,
        isFunctional: isFunctional(s),
        destinations: destinations.filter((d) => String(d.server_id) === String(s.id)).map((d) => ({ uuid: d.uuid, name: d.name })),
      })),
    buildServers: all.filter(build).map((s) => ({ uuid: s.uuid, name: s.name })),
  };
}

export interface OperationResult {
  /** Where the page goes next: the application's configuration, "#resource-operations". */
  projectUuid: string;
  environmentUuid: string;
  applicationUuid: string;
  /** What Coolify would now do on the server and cannot be done yet. */
  unavailable?: string;
}

/**
 * ResourceOperations::moveTo(): the application's environment changes; the
 * running deployment does not. The target is any environment of the org.
 */
export async function moveApplicationTo(ctx: ApplicationResourcesContext, uuid: string, body: Body): Promise<OperationResult | null> {
  const l = await loadApplication(ctx, uuid, true);
  if (!l) return null;
  const environment = typeof body.environment_uuid === "string" && !blank(body.environment_uuid) ? await ctx.store.findEnvironment(body.environment_uuid) : null;
  if (!environment) throw new SettingsFieldErrors({ environment_id: [RESOURCE_OPERATION_MESSAGES.environmentNotFound] });
  await ctx.store.move(l.row.id, environment.id);
  return { projectUuid: environment.project_uuid, environmentUuid: environment.uuid, applicationUuid: l.row.uuid };
}

/** Str::limit($value, $limit, $end): the first $limit characters, right-trimmed, then $end ("...") — when the value is longer. */
export function strLimit(value: string, limit: number, end = "..."): string {
  const characters = [...value];
  return characters.length <= limit ? value : `${characters.slice(0, limit).join("").trimEnd()}${end}`;
}

/**
 * clone_application()'s name for a volume of the clone: the source's name
 * with the clone's uuid in place of the source's, else the clone's uuid and
 * what follows the name's last hyphen. A SQLite database's volume gets the
 * whole name behind the clone's uuid (and is no longer connected).
 */
export function clonedVolumeName(volume: { name: string; standalone_sqlite_id: string | number | null }, sourceUuid: string, cloneUuid: string): string {
  if (volume.standalone_sqlite_id !== null) return `${cloneUuid}-${volume.name}`;
  // str()->replace(): every occurrence.
  if (volume.name.startsWith(sourceUuid)) return volume.name.split(sourceUuid).join(cloneUuid);
  const hyphen = volume.name.lastIndexOf("-");
  return `${cloneUuid}-${hyphen === -1 ? volume.name : volume.name.slice(hyphen + 1)}`;
}

const proxyType = (row: DeployApplicationConfigurationRow | { proxy: unknown }): unknown => {
  const proxy = jsonValue("proxy" in row ? row.proxy : row.server_proxy);
  return proxy !== null && typeof proxy === "object" ? (proxy as Record<string, unknown>).type : null;
};

/**
 * ResourceOperations::cloneTo() for an application — clone_application():
 *
 *   the application's row (a new uuid and name, status 'exited', the chosen
 *   environment and destination; its domain is generated again for the new
 *   server unless the container labels are editable or the server has no
 *   proxy), its settings row, its tags, its scheduled tasks, its volume
 *   mounts under the clone's names, its file and directory mounts, and its
 *   environment variables (production and preview), values as stored.
 *
 * Where the domain was generated again, so are the container labels
 * (generateLabelsApplication() for the clone, stored as base64), once its
 * settings row is there. Not copied here: the secret manager link and the
 * automatic DNS records.
 *
 * After the rows: `cloneVolumeData` queues the volume copy and every managed
 * file mount queues its write to the server — neither is available yet.
 */
export interface CloneOptions {
  /** The clone's uuid, when the caller made it (the API's clone_by_uuid(), DP-86). */
  uuid?: string;
  /** The clone's name, when the request gave one (the API's clone_by_uuid(), DP-86). */
  name?: string;
}

export async function cloneApplicationTo(ctx: ApplicationResourcesContext, uuid: string, body: Body, opts: CloneOptions = {}): Promise<OperationResult | null> {
  const l = await loadApplication(ctx, uuid, true);
  const source = l ? await ctx.store.findByUuid(uuid) : null;
  if (!l || !source) return null;

  let environment = { id: source.environment_id, uuid: source.environment_uuid, project_uuid: source.project_uuid };
  if (body.environment_uuid !== undefined && body.environment_uuid !== null) {
    const found = typeof body.environment_uuid === "string" && !blank(body.environment_uuid) ? await ctx.store.findEnvironment(body.environment_uuid) : null;
    if (!found) throw new SettingsFieldErrors({ environment_id: [RESOURCE_OPERATION_MESSAGES.environmentNotFound] });
    environment = found;
  }
  // findResourceTeamDestination(): one of the org's, on a server that can host resources.
  const destination = typeof body.destination_uuid === "string" && !blank(body.destination_uuid) ? await ctx.store.findDestination(body.destination_uuid) : null;
  const server = destination ? await ctx.store.findServer(destination.server_uuid) : null;
  if (!destination || !server || effectiveServerRole(server) === "build") throw new SettingsFieldErrors({ destination_id: [RESOURCE_OPERATION_MESSAGES.destinationNotFound] });

  const clone = opts.uuid ?? newPublicId();
  // Coolify fails on the table's unique index in the middle of the clone and keeps what it had copied; here nothing is copied.
  const volumes = await ctx.store.volumes(l.row.id);
  const volumeNames = volumes.map((volume) => clonedVolumeName(volume, l.row.uuid, clone));
  if (new Set(volumeNames).size !== volumeNames.length) throw new SettingsError(RESOURCE_OPERATION_MESSAGES.duplicate, 422);
  const regenerate = proxyType(server) !== "NONE" && l.row.is_container_label_readonly_enabled === true;
  const url = regenerate ? generateUrl({ ip: server.ip, wildcardDomain: server.wildcard_domain }, clone) : source.fqdn;
  // The saving hook, as for any changed fqdn: the ports to domain_port_overrides, the noindex flags of domains that are gone dropped.
  const stored = jsonValue(l.row.domain_port_overrides);
  const domain = normalizeDomainPortOverrides(url, stored !== null && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, number | string>) : null);
  const noindex = syncNoindexDomains(jsonValue(l.row.noindex_domains), domain.fqdn);

  const id = await ctx.store.replicateApplication(l.row.id, {
    uuid: clone,
    name: opts.name ?? `clone-of-${strLimit(l.row.name, 20)}-${clone}`,
    fqdn: domain.fqdn,
    domainPortOverrides: domain.overrides === null ? null : JSON.stringify(domain.overrides),
    ...(noindex === undefined ? {} : { noindexDomains: JSON.stringify(noindex) }),
    ...(regenerate ? { customLabels: null } : {}),
    environmentId: environment.id,
    destinationId: destination.id,
    destinationType: destination.type,
  });
  if (id === null) return null;
  await ctx.store.replicateSettings(l.row.id, id);
  // $newApplication->custom_labels = base64_encode(generateLabelsApplication($newApplication)).
  if (regenerate) await ctx.generateLabels?.(clone);
  await ctx.store.copyTags(l.row.id, id);
  for (const task of await ctx.store.scheduledTaskIds(l.row.id)) await ctx.store.replicateScheduledTask(task, { uuid: newPublicId(), applicationId: id });

  for (const [i, volume] of volumes.entries()) await ctx.store.replicateVolume(volume.id, { uuid: newPublicId(), name: volumeNames[i]!, resourceId: id });
  const files = await ctx.store.files(l.row.id);
  for (const file of files) await ctx.store.replicateFile(file.id, { uuid: newPublicId(), resourceId: id });
  for (const variable of await ctx.store.environmentVariableIds(l.row.id)) await ctx.store.replicateEnvironmentVariable(variable, { uuid: newPublicId(), applicationId: id });

  const unavailable: string[] = [];
  if (body.cloneVolumeData === true && volumes.length > 0) unavailable.push(RESOURCE_OPERATION_MESSAGES.volumeDataUnavailable);
  // LocalFileVolume's created hook queues the write of a managed mount inside the clone's own directory (a
  // mount copied from the source keeps the source's path, which is outside it; a relative path is inside).
  if (files.some((f) => !f.is_host_file && !isOutsideResourceDirectory(f.fs_path, applicationWorkdir(clone)))) unavailable.push(RESOURCE_OPERATION_MESSAGES.fileMountsUnavailable);
  return { projectUuid: environment.project_uuid, environmentUuid: environment.uuid, applicationUuid: clone, ...(unavailable.length ? { unavailable: unavailable.join(" ") } : {}) };
}
