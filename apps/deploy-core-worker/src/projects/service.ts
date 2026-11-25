// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/{Index,AddEmpty,Show,Edit,
// DeleteProject,DeleteEnvironment,EnvironmentEdit}.php, app/Livewire/Project/Resource/Index.php,
// app/Livewire/Concerns/CreatesEnvironments.php, app/Models/{Project,Environment}.php
// (navigateTo, isEmpty, compareNames, customizeName, the created hook) and
// bootstrap/helpers/shared.php (handleError) (Apache-2.0), modified.
//
// What the project and environment Livewire components do, as plain
// operations on one org's projects. The store is that org's deploy.projects,
// deploy.environments and deploy.project_settings (row-level security,
// withOrg).
import type {
  DeployEnvironmentListRow,
  DeployEnvironmentRow,
  DeployProjectListRow,
  DeployProjectRow,
  EnvironmentChanges,
  NewEnvironment,
  NewProject,
  ProjectChanges,
} from "@saas/db/deploy";
import { DEPLOY_UNIQUE_INDEXES, refusingDuplicates } from "@saas/db/deploy";
import { newPublicId } from "../helpers/names.js";
import type { NameDescriptionInput } from "./validation.js";

export interface ProjectStore {
  list(): Promise<DeployProjectListRow[]>;
  findByUuid(uuid: string): Promise<DeployProjectRow | null>;
  /** Project::create() with the created hook: the settings row and the "production" environment. */
  insert(project: Omit<NewProject, "orgId">): Promise<{ project: DeployProjectRow; environment: DeployEnvironmentRow }>;
  update(id: string | number, changes: ProjectChanges): Promise<DeployProjectRow | null>;
  /** Project::delete() with the deleting hook: its environments, settings and shared variables. */
  delete(id: string | number): Promise<boolean>;
  /** !Project::isEmpty() */
  projectHasResources(id: string | number): Promise<boolean>;
  environments(projectId: string | number): Promise<DeployEnvironmentListRow[]>;
  findEnvironment(projectId: string | number, uuid: string): Promise<DeployEnvironmentListRow | null>;
  insertEnvironment(environment: Omit<NewEnvironment, "orgId">): Promise<DeployEnvironmentRow>;
  updateEnvironment(id: string | number, changes: EnvironmentChanges): Promise<DeployEnvironmentRow | null>;
  /** Environment::delete() with the deleting hook: its shared variables. */
  deleteEnvironment(id: string | number): Promise<boolean>;
  environmentNameExists(projectId: string | number, name: string, excludeId?: string | number | null): Promise<boolean>;
  /** !Environment::isEmpty() */
  environmentHasResources(id: string | number): Promise<boolean>;
}

/** Copy shown to the user: Coolify's, word for word (its `<strong>` tags left out: the toast is plain text). */
export const PROJECT_MESSAGES = {
  updated: "Project updated.",
  /** DeleteProject::delete() */
  projectHasResources: (name: string) => `Project ${name} has resources defined, please delete them first.`,
  /** DeleteEnvironment::delete() */
  environmentHasResources: (name: string) => `Environment ${name} has defined resources, please delete them first.`,
  /** handleError() for a UniqueConstraintViolationException (environments: unique name per project). */
  duplicate: "Duplicate entry found. Please use a different name.",
} as const;

/** A failure Coolify reports through dispatch('error'). */
/** unique(name, project_id): the answer of the question before the write, for the write the index refuses. */
const refusingDuplicateName = <T>(write: () => Promise<T>): Promise<T> => refusingDuplicates([DEPLOY_UNIQUE_INDEXES.environmentName], write, () => new ProjectError(PROJECT_MESSAGES.duplicate));

export class ProjectError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
const isSpace = (c: string | undefined): boolean => c === " " || (c !== undefined && c >= "\t" && c <= "\r");

/**
 * PHP's strnatcasecmp() (strnatcmp.c): natural order, case folded. Runs of
 * digits compare as numbers (as fractions when one starts with "0"), white
 * space is skipped, everything else compares character by character.
 */
export function strnatcasecmp(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return a.length === 0 ? (b.length === 0 ? 0 : -1) : 1;
  let i = 0;
  let j = 0;
  // Leading zeros of the whole string are skipped once.
  while (a[i] === "0" && isDigit(a[i + 1])) i++;
  while (b[j] === "0" && isDigit(b[j + 1])) j++;
  for (;;) {
    while (isSpace(a[i])) i++;
    while (isSpace(b[j])) j++;
    if (isDigit(a[i]) && isDigit(b[j])) {
      const fractional = a[i] === "0" || b[j] === "0";
      let x = i;
      let y = j;
      while (isDigit(a[x])) x++;
      while (isDigit(b[y])) y++;
      const ra = a.slice(i, x);
      const rb = b.slice(j, y);
      let result = 0;
      if (fractional) {
        // compare_left: the first different digit decides; else the shorter run is smaller.
        const n = Math.min(ra.length, rb.length);
        for (let k = 0; k < n && result === 0; k++) if (ra[k] !== rb[k]) result = ra[k]! < rb[k]! ? -1 : 1;
        if (result === 0 && ra.length !== rb.length) result = ra.length < rb.length ? -1 : 1;
      } else if (ra.length !== rb.length) {
        // compare_right: the longer run is the bigger number.
        result = ra.length < rb.length ? -1 : 1;
      } else if (ra !== rb) {
        result = ra < rb ? -1 : 1;
      }
      if (result !== 0) return result;
      i = x;
      j = y;
      if (i >= a.length && j >= b.length) return 0;
      if (i >= a.length) return -1;
      if (j >= b.length) return 1;
    }
    const ca = (a[i] ?? "").toUpperCase();
    const cb = (b[j] ?? "").toUpperCase();
    if (ca < cb) return -1;
    if (ca > cb) return 1;
    i++;
    j++;
    if (i >= a.length && j >= b.length) return 0;
    if (i >= a.length) return -1;
    if (j >= b.length) return 1;
  }
}

/** Environment::compareNames(): production, staging and development first, then the others by name. */
export function compareEnvironmentNames(first: string, second: string): number {
  const order = ["production", "staging", "development"];
  const rank = (name: string): number => {
    const index = order.indexOf(name.toLowerCase());
    return index === -1 ? order.length : index;
  };
  return rank(first) - rank(second) || strnatcasecmp(first, second);
}

/** Environment::customizeName(): str($value)->lower()->trim()->replace('/', '-'). */
export function customizeEnvironmentName(value: string): string {
  return value.toLowerCase().trim().replace(/\//g, "-");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** $project->created_at?->format('M j, Y') ?? '-': the stored UTC wall-clock date. */
export function formatCreatedAt(value: string | Date | null): string {
  if (value === null) return "-";
  const m = (value instanceof Date ? value.toISOString() : String(value)).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : "-";
}

export interface ProjectListItem {
  uuid: string;
  name: string;
  description: string | null;
  environmentCount: number;
  resourceCount: number;
  /** 'M j, Y', or '-' */
  createdAt: string;
  /** Project::navigateTo(): the only environment's uuid when the project has exactly one (the card opens it), else null. */
  onlyEnvironmentUuid: string | null;
  /** The first environment's uuid ("Add resource" goes to its /new page), or null. */
  firstEnvironmentUuid: string | null;
}

/** Index::mount() + render(): the org's projects as the page's projectsJs. */
export async function listProjects(store: ProjectStore): Promise<ProjectListItem[]> {
  return (await store.list()).map((p) => ({
    uuid: p.uuid,
    name: p.name,
    description: p.description ?? null,
    environmentCount: Number(p.environment_count),
    resourceCount: Number(p.resource_count),
    createdAt: formatCreatedAt(p.created_at),
    onlyEnvironmentUuid: Number(p.environment_count) === 1 ? p.first_environment_uuid : null,
    firstEnvironmentUuid: p.first_environment_uuid,
  }));
}

/**
 * AddEmpty::submit(): Project::create() (its created hook adds the settings
 * row and the "production" environment), then the page goes to that
 * environment. AddEmpty's description is '' when the form leaves it empty.
 */
export async function createProject(store: ProjectStore, input: NameDescriptionInput): Promise<{ uuid: string; environmentUuid: string }> {
  const { project, environment } = await store.insert({
    uuid: newPublicId(),
    name: input.name,
    description: input.description ?? "",
    productionEnvironmentUuid: newPublicId(),
  });
  return { uuid: project.uuid, environmentUuid: environment.uuid };
}

export interface EnvironmentItem {
  uuid: string;
  name: string;
  description: string | null;
  resourceCount: number;
}

const toEnvironmentItem = (e: DeployEnvironmentListRow): EnvironmentItem => ({
  uuid: e.uuid,
  name: e.name,
  description: e.description ?? null,
  resourceCount: Number(e.resource_count),
});

/** Show::render(): the environments sorted by Environment::compareNames (ties keep the created_at order). */
async function sortedEnvironments(store: ProjectStore, projectId: string | number): Promise<EnvironmentItem[]> {
  return (await store.environments(projectId)).sort((a, b) => compareEnvironmentNames(a.name, b.name)).map(toEnvironmentItem);
}

export interface ProjectShow {
  project: { uuid: string; name: string; description: string | null; isEmpty: boolean };
  environments: EnvironmentItem[];
}

/** Show::mount() + render(), and Edit::mount() (the delete dialog is disabled unless $project->isEmpty()). */
export async function showProject(store: ProjectStore, uuid: string): Promise<ProjectShow | null> {
  const project = await store.findByUuid(uuid);
  if (!project) return null;
  return {
    project: { uuid: project.uuid, name: project.name, description: project.description ?? null, isEmpty: !(await store.projectHasResources(project.id)) },
    environments: await sortedEnvironments(store, project.id),
  };
}

/** Edit::submit(): syncData(true). */
export async function updateProject(store: ProjectStore, uuid: string, input: NameDescriptionInput): Promise<DeployProjectRow | null> {
  const project = await store.findByUuid(uuid);
  if (!project) return null;
  return store.update(project.id, { name: input.name, description: input.description });
}

/** DeleteProject::delete(): only an empty project is deleted. */
export async function deleteProject(store: ProjectStore, uuid: string): Promise<boolean> {
  const project = await store.findByUuid(uuid);
  if (!project) return false;
  if (await store.projectHasResources(project.id)) throw new ProjectError(PROJECT_MESSAGES.projectHasResources(project.name));
  return store.delete(project.id);
}

/** The project's environments (Show's list), or null when the project is not the org's. */
export async function listEnvironments(store: ProjectStore, projectUuid: string): Promise<EnvironmentItem[] | null> {
  const project = await store.findByUuid(projectUuid);
  if (!project) return null;
  return sortedEnvironments(store, project.id);
}

/**
 * CreatesEnvironments::submit(): Environment::create(['name' => …]) with the
 * name as customizeName() stores it. Coolify's unique(name, project_id) index
 * turns a second environment of that name into handleError()'s "Duplicate
 * entry found" toast.
 */
export async function createEnvironment(store: ProjectStore, projectUuid: string, input: NameDescriptionInput): Promise<{ uuid: string; name: string } | null> {
  const project = await store.findByUuid(projectUuid);
  if (!project) return null;
  const name = customizeEnvironmentName(input.name);
  if (await store.environmentNameExists(project.id, name)) throw new ProjectError(PROJECT_MESSAGES.duplicate);
  const environment = await refusingDuplicateName(() => store.insertEnvironment({ projectId: project.id, uuid: newPublicId(), name }));
  return { uuid: environment.uuid, name: environment.name };
}

export interface EnvironmentShow {
  project: { uuid: string; name: string };
  environment: EnvironmentItem & { isEmpty: boolean };
}

/** Resource\Index::mount() and EnvironmentEdit::mount(): the environment through its project. */
export async function showEnvironment(store: ProjectStore, projectUuid: string, environmentUuid: string): Promise<EnvironmentShow | null> {
  const project = await store.findByUuid(projectUuid);
  if (!project) return null;
  const environment = await store.findEnvironment(project.id, environmentUuid);
  if (!environment) return null;
  return {
    project: { uuid: project.uuid, name: project.name },
    environment: { ...toEnvironmentItem(environment), isEmpty: !(await store.environmentHasResources(environment.id)) },
  };
}

/** EnvironmentEdit::submit(): syncData(true). */
export async function updateEnvironment(store: ProjectStore, projectUuid: string, environmentUuid: string, input: NameDescriptionInput): Promise<DeployEnvironmentRow | null> {
  const project = await store.findByUuid(projectUuid);
  if (!project) return null;
  const environment = await store.findEnvironment(project.id, environmentUuid);
  if (!environment) return null;
  const name = customizeEnvironmentName(input.name);
  if (await store.environmentNameExists(project.id, name, environment.id)) throw new ProjectError(PROJECT_MESSAGES.duplicate);
  return refusingDuplicateName(() => store.updateEnvironment(environment.id, { name, description: input.description }));
}

/** DeleteEnvironment::delete(): only an empty environment is deleted. */
export async function deleteEnvironment(store: ProjectStore, projectUuid: string, environmentUuid: string): Promise<boolean> {
  const project = await store.findByUuid(projectUuid);
  if (!project) return false;
  const environment = await store.findEnvironment(project.id, environmentUuid);
  if (!environment) return false;
  if (await store.environmentHasResources(environment.id)) throw new ProjectError(PROJECT_MESSAGES.environmentHasResources(environment.name));
  return store.deleteEnvironment(environment.id);
}
