// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/CloneMe.php, resources/views/livewire/project/
// clone-me.blade.php, app/Http/Middleware/CanCreateResources.php, app/Support/ValidationPatterns.php (nameRules),
// app/Traits/HasSafeStringAttribute.php and app/Models/{Project,Environment}.php (the created hook, customizeName),
// bootstrap/helpers/shared.php (clone_resource_name, handleError) and bootstrap/helpers/services.php (clone_service)
// (Apache-2.0), modified.
//
// An environment's Clone page, /project/{uuid}/environment/{env_uuid}/clone (route project.clone-me, DP-100).
//
// mount(): the project (the org's, else 404), the environment, the servers that are not build servers (by id, each
// with its standalone then Swarm destinations), and the default name str(clone_resource_name($project->name,
// new_public_id()))->slug(). clone($type): Livewire's validate() with CloneMe::messages(), then "Environment not
// found.", "Destination not found." (findProjectTeamDestination(): one of the org's, on a server that can host
// resources), then in one transaction — a new project ("Project with the same name already exists."; its
// production environment, and the environment's own name when that is not production) or a new environment of the
// project ("Environment with the same name already exists.") — every application (clone_application(): DP-55's
// cloneApplicationTo()), every standalone database (the database branch, which is DP-64's cloneDatabaseTo() with the
// source's name kept) and every service (clone_service()). Each failure is handleError()'s toast; the page then goes
// to the new environment.
//
// What is not Coolify's: what Coolify does on a server once the transaction commits — copying the volume data
// (cloneVolumeData) and writing a managed file mount into a clone's directory — answers 501 "… needs the SSH executor,
// which is not available yet.", the first in Coolify's order (resource by resource: applications, databases, then
// services — DP-108's clone_service(), services/clone.ts, whose file mounts are written before its volume data is
// copied); the transaction is rolled back: nothing is stored. The audit log entry (ui.project.clone_started) and the
// secret manager links of applications and databases are not written.
import type {
  DeployApplicationRow,
  DeployDatabaseRow,
  DeployDestinationRow,
  DeployEnvironmentRow,
  DeployOperationDestinationRow,
  DeployOperationServerRow,
  DeployProjectRow,
  DeployServerRow,
  DeployServiceRow,
} from "@saas/db/deploy";
import { blank, length, NAME_PATTERN, type FieldErrors } from "../private-keys/validation.js";
import { newPublicId } from "../helpers/names.js";
import { slug } from "../labels/labels.js";
import { effectiveServerRole } from "../servers/service.js";
import { SettingsError, SettingsFieldErrors } from "../applications/settings.js";
import { cloneApplicationTo, RESOURCE_OPERATION_MESSAGES } from "../applications/resource-operations.js";
import type { ApplicationResourcesContext } from "../applications/resources.js";
import { cloneDatabaseTo, cloneResourceName, type DatabaseResourcesContext } from "../databases/resources.js";
import { cloneService, findCloneDestination } from "../services/clone.js";
import type { ServiceResourcesContext } from "../services/resources.js";
import { ServiceConfigurationError } from "../services/configuration.js";
import { customizeEnvironmentName } from "./service.js";

type Body = Record<string, unknown>;

/** CloneMe::messages(), Laravel's defaults for the rest (the attribute "newName" is shown as "new name"), and clone()'s exceptions. */
export const CLONE_ME_MESSAGES = {
  /** 'selectedDestination' => …: every rule of the attribute. */
  selectedDestination: "Please select a server & destination.",
  newNameRequired: "Please enter a name for the new project or environment.",
  /** nameMessages() is keyed by `name.*`, so the other rules of newName get Laravel's own messages. */
  newNameString: "The new name field must be a string.",
  newNameMin: (min: number) => `The new name field must be at least ${min} characters.`,
  newNameMax: (max: number) => `The new name field must not be greater than ${max} characters.`,
  newNameRegex: "The new name field format is invalid.",
  environmentNotFound: "Environment not found.",
  destinationNotFound: "Destination not found.",
  projectExists: "Project with the same name already exists.",
  environmentExists: "Environment with the same name already exists.",
  /** handleError() for a UniqueConstraintViolationException. */
  duplicate: "Duplicate entry found. Please use a different name.",
  /** Freeploy's: the SSH executor is not deployed yet. */
  volumeDataUnavailable: RESOURCE_OPERATION_MESSAGES.volumeDataUnavailable,
  fileMountsUnavailable: RESOURCE_OPERATION_MESSAGES.fileMountsUnavailable,
} as const;

/** handleError()'s toast: a message with the status Freeploy answers it with. */
export class CloneMeError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
  }
}

export interface CloneMeStore {
  findProject(uuid: string): Promise<DeployProjectRow | null>;
  /** $this->project->environments->where('uuid', …)->first() */
  findEnvironment(projectId: string | number, uuid: string): Promise<DeployEnvironmentRow | null>;
  applications(environmentId: string | number): Promise<DeployApplicationRow[]>;
  databases(environmentId: string | number): Promise<DeployDatabaseRow[]>;
  services(environmentId: string | number): Promise<DeployServiceRow[]>;
  servers(): Promise<DeployOperationServerRow[]>;
  destinations(): Promise<DeployOperationDestinationRow[]>;
  findDestination(uuid: string): Promise<DeployDestinationRow | null>;
  findServer(uuid: string): Promise<DeployServerRow | null>;
  projectNameExists(name: string): Promise<boolean>;
  environmentNameExists(projectId: string | number, name: string): Promise<boolean>;
  /** Project::create() with its created hook (the settings row and the production environment). */
  insertProject(project: { uuid: string; name: string; description: string | null; productionEnvironmentUuid: string }): Promise<{ project: DeployProjectRow; environment: DeployEnvironmentRow }>;
  insertEnvironment(environment: { projectId: string | number; uuid: string; name: string }): Promise<DeployEnvironmentRow>;
}

export interface CloneMeContext {
  store: CloneMeStore;
  /** DP-55's application clone, in this transaction. */
  application: ApplicationResourcesContext;
  /** DP-64's database clone of one database, in this transaction. */
  database(uuid: string): Promise<DatabaseResourcesContext>;
  /** DP-108's clone_service(), in this transaction. */
  service: ServiceResourcesContext;
}

export interface CloneMeResource {
  uuid: string;
  name: string;
  description: string | null;
}

export interface CloneMePage {
  project: { uuid: string; name: string };
  environment: { uuid: string; name: string };
  /** str(clone_resource_name($project->name, new_public_id()))->slug() */
  newName: string;
  /** $servers->sortBy('id'), each with $server->destinations(). */
  servers: Array<{ uuid: string; name: string; destinations: Array<{ uuid: string; name: string }> }>;
  /** Each kind sortBy('name'). */
  applications: CloneMeResource[];
  databases: CloneMeResource[];
  services: CloneMeResource[];
}

const NUMERIC = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/;

/** PHP 8's comparison of two names (Collection::sortBy(): SORT_REGULAR): numeric strings as numbers, others byte-wise. */
export function phpCompareNames(a: string, b: string): number {
  if (NUMERIC.test(a) && NUMERIC.test(b)) return Math.sign(Number(a) - Number(b));
  const x = [...a].map((c) => c.codePointAt(0)!);
  const y = [...b].map((c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return Math.sign(x.length - y.length);
}

const byName = <T extends { name: string }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => phpCompareNames(a.name, b.name));
const resource = (r: { uuid: string; name: string; description: string | null }): CloneMeResource => ({ uuid: r.uuid, name: r.name, description: r.description ?? null });

/** CloneMe::mount(): the project, the environment and what the page lists. Null when either is not the org's. */
export async function showCloneMe(ctx: CloneMeContext, projectUuid: string, environmentUuid: string): Promise<CloneMePage | null> {
  const project = await ctx.store.findProject(projectUuid);
  if (!project) return null;
  // Coolify's view needs the environment (the middleware lets an unknown one through); here it is the page's 404.
  const environment = await ctx.store.findEnvironment(project.id, environmentUuid);
  if (!environment) return null;
  const destinations = await ctx.store.destinations();
  const servers = (await ctx.store.servers())
    .filter((s) => effectiveServerRole(s) !== "build")
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((s) => ({ uuid: s.uuid, name: s.name, destinations: destinations.filter((d) => String(d.server_id) === String(s.id)).map((d) => ({ uuid: d.uuid, name: d.name })) }));
  return {
    project: { uuid: project.uuid, name: project.name },
    environment: { uuid: environment.uuid, name: environment.name },
    newName: slug(cloneResourceName(project.name, newPublicId())),
    servers,
    applications: byName(await ctx.store.applications(environment.id)).map(resource),
    databases: byName(await ctx.store.databases(environment.id)).map(resource),
    services: byName(await ctx.store.services(environment.id)).map(resource),
  };
}

/**
 * clone()'s $this->validate(['selectedDestination' => 'required', 'newName' => ValidationPatterns::nameRules()]) with
 * messages(): every failing rule of a field in rule order (no bail); a blank value fails `required` alone.
 */
export function validateCloneMe(body: Body): FieldErrors {
  const errors: FieldErrors = {};
  const add = (field: string, message: string) => (errors[field] ??= []).push(message);
  if (blank(body.selectedDestination)) add("selectedDestination", CLONE_ME_MESSAGES.selectedDestination);
  const name = body.newName;
  if (blank(name)) add("newName", CLONE_ME_MESSAGES.newNameRequired);
  else if (typeof name !== "string") add("newName", CLONE_ME_MESSAGES.newNameString);
  else {
    if (length(name) < 3) add("newName", CLONE_ME_MESSAGES.newNameMin(3));
    if (length(name) > 255) add("newName", CLONE_ME_MESSAGES.newNameMax(255));
    if (!NAME_PATTERN.test(name)) add("newName", CLONE_ME_MESSAGES.newNameRegex);
  }
  return errors;
}

/** strip_tags(): HasSafeStringAttribute's setter (the name rules already refuse "<"). */
const stripTags = (value: string) => value.replace(/<[^>]*>?/g, "");

export interface CloneMeResult {
  /** redirect()->route('project.resource.index', …) */
  projectUuid: string;
  environmentUuid: string;
}

/**
 * CloneMe::clone($type): "environment" (a new environment of this project named newName) or "project" (a new
 * project named newName). Null when the project is not the org's (mount()'s firstOrFail()).
 */
export async function cloneEnvironment(ctx: CloneMeContext, projectUuid: string, environmentUuid: string, type: "environment" | "project", body: Body): Promise<CloneMeResult | null> {
  const { store } = ctx;
  const source = await store.findProject(projectUuid);
  if (!source) return null;
  const errors = validateCloneMe(body);
  if (Object.keys(errors).length) throw new SettingsFieldErrors(errors);
  const newName = body.newName as string;
  const cloneVolumeData = body.cloneVolumeData === true;

  const environment = await store.findEnvironment(source.id, environmentUuid);
  if (!environment) throw new CloneMeError(CLONE_ME_MESSAGES.environmentNotFound);
  // findProjectTeamDestination(): a standalone or Swarm destination of the org whose server can host resources.
  const destination = await store.findDestination(body.selectedDestination as string);
  const server = destination ? await store.findServer(destination.server_uuid) : null;
  if (!destination || !server || effectiveServerRole(server) === "build") throw new CloneMeError(CLONE_ME_MESSAGES.destinationNotFound);

  // cloneInto(), in the request's transaction.
  let target: { projectUuid: string; environment: DeployEnvironmentRow };
  if (type === "project") {
    if (await store.projectNameExists(stripTags(newName))) throw new CloneMeError(CLONE_ME_MESSAGES.projectExists);
    const created = await store.insertProject({
      uuid: newPublicId(),
      name: stripTags(newName),
      // $this->project->description.' (clone)': PHP's null is ''.
      description: stripTags(`${source.description ?? ""} (clone)`),
      productionEnvironmentUuid: newPublicId(),
    });
    let env = created.environment;
    if (environment.name !== "production") env = await store.insertEnvironment({ projectId: created.project.id, uuid: newPublicId(), name: customizeEnvironmentName(stripTags(environment.name)) });
    target = { projectUuid: created.project.uuid, environment: env };
  } else {
    if (await store.environmentNameExists(source.id, newName)) throw new CloneMeError(CLONE_ME_MESSAGES.environmentExists);
    const name = customizeEnvironmentName(stripTags(newName));
    // The model stores the name lower-cased: unique(name, project_id) refuses one that differs only in case.
    if (await store.environmentNameExists(source.id, name)) throw new CloneMeError(CLONE_ME_MESSAGES.duplicate);
    target = { projectUuid: source.uuid, environment: await store.insertEnvironment({ projectId: source.id, uuid: newPublicId(), name }) };
  }

  const into = { environment_uuid: target.environment.uuid, destination_uuid: destination.uuid, cloneVolumeData };
  // What Coolify queues for after the commit, resource by resource: the first one Freeploy cannot do yet.
  let unavailable: string | null = null;
  const clone = async (run: () => Promise<{ unavailable?: string } | null>) => {
    try {
      const result = await run();
      // The volume copy is queued before the file mounts' writes (clone_application() and the database branch).
      if (result?.unavailable && unavailable === null) {
        unavailable = [CLONE_ME_MESSAGES.volumeDataUnavailable, CLONE_ME_MESSAGES.fileMountsUnavailable].find((m) => result.unavailable!.includes(m)) ?? result.unavailable;
      }
    } catch (e) {
      // Two volumes of a source under one name in the clone: the unique index, handleError()'s toast.
      if (e instanceof SettingsError && e.status === 422) throw new CloneMeError(CLONE_ME_MESSAGES.duplicate);
      // handleError(): the parser's message for a service whose Compose file does not parse.
      if (e instanceof ServiceConfigurationError) throw new CloneMeError(e.message, e.status);
      throw e;
    }
  };
  for (const application of await store.applications(environment.id)) {
    await clone(() => cloneApplicationTo(ctx.application, application.uuid, into, { uuid: newPublicId() }));
  }
  for (const database of await store.databases(environment.id)) {
    await clone(async () => cloneDatabaseTo(await ctx.database(database.uuid), database.uuid, into, { uuid: newPublicId(), name: database.name }));
  }
  // clone_service($service, $selectedDestination, ['name' => $service->name, 'environment_id' => …], $cloneVolumeData)
  const services = await store.services(environment.id);
  if (services.length > 0) {
    const serviceDestination = await findCloneDestination(ctx.service, destination.uuid);
    for (const service of services) {
      const source = serviceDestination ? await ctx.service.configuration.store.find(service.uuid) : null;
      if (!serviceDestination || !source) continue;
      await clone(async () => cloneService(ctx.service, source, serviceDestination, { name: service.name, environmentId: target.environment.id }, cloneVolumeData));
    }
  }
  if (unavailable !== null) throw new CloneMeError(unavailable, 501);
  return { projectUuid: target.projectUuid, environmentUuid: target.environment.uuid };
}
