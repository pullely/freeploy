// Derived from coollabsio/coolify@91b7e3e:app/Livewire/SharedVariables/Index.php,
// app/Livewire/SharedVariables/Team/Index.php,
// app/Livewire/SharedVariables/{Project,Environment,Server}/{Index,Show}.php,
// app/Livewire/Project/Shared/EnvironmentVariable/{Add,Show}.php (the shared variable paths),
// app/Models/SharedEnvironmentVariable.php and app/Services/SharedVariableCanvas.php (overview)
// (Apache-2.0), modified.
//
// What the shared variable components do, as plain operations on one org's
// deploy.shared_environment_variables (row-level security, withOrg). A scope
// is whose variables a page shows: the org (Coolify's team), a project, an
// environment or a server. The cipher encrypts the value column. A value
// leaves this module only for who may read it (`canViewValues`, Coolify's
// viewSensitive) and never once the variable is locked (is_shown_once); a
// server's predefined variables are the exception Coolify makes: every reader
// of the page sees their values.
import type {
  DeployProjectRow,
  DeployServerRow,
  DeploySharedVariableEnvironmentRow,
  DeploySharedVariableOverviewRow,
  DeploySharedVariableProjectRow,
  DeploySharedVariableRow,
  DeploySharedVariableServerRow,
  DeploySharedVariableWithSecretRow,
  NewSharedVariable,
  SharedVariableChanges,
  SharedVariableOwner,
  SharedVariableScope,
} from "@saas/db/deploy";
import { SHARED_VARIABLE_UNIQUE_INDEXES, refusingDuplicates } from "@saas/db/deploy";
import { utcIso } from "../cloud-tokens/service.js";
import type { KeyCipher } from "../private-keys/service.js";
import { isFunctional, PREDEFINED_SERVER_VARIABLE_KEYS } from "../servers/service.js";
import { DevViewError, formatEnvValueForDevView, formatEnvVariableForDevView, parseEnvDevView, phpTrim } from "./dev-view.js";
import { isValidEnvironmentVariableKey, normalizeEnvironmentVariableKey, SHARED_VARIABLE_VALIDATION_MESSAGES, type AddVariableInput, type UpdateVariableInput } from "./validation.js";

export interface SharedVariableStore {
  findProject(uuid: string): Promise<Pick<DeployProjectRow, "id" | "uuid" | "name"> | null>;
  findEnvironment(uuid: string): Promise<DeploySharedVariableEnvironmentRow | null>;
  findServer(uuid: string): Promise<Pick<DeployServerRow, "id" | "uuid" | "name"> | null>;
  projects(): Promise<DeploySharedVariableProjectRow[]>;
  environments(): Promise<DeploySharedVariableEnvironmentRow[]>;
  servers(): Promise<DeploySharedVariableServerRow[]>;
  overview(): Promise<DeploySharedVariableOverviewRow[]>;
  list(owner: SharedVariableOwner): Promise<DeploySharedVariableWithSecretRow[]>;
  findById(owner: SharedVariableOwner, id: string): Promise<DeploySharedVariableWithSecretRow | null>;
  findByKey(owner: SharedVariableOwner, key: string): Promise<DeploySharedVariableWithSecretRow | null>;
  insert(variable: Omit<NewSharedVariable, "orgId">): Promise<DeploySharedVariableRow>;
  update(id: string | number, changes: SharedVariableChanges): Promise<DeploySharedVariableRow | null>;
  delete(id: string | number): Promise<boolean>;
  deleteExcept(owner: SharedVariableOwner, keys: string[], protectedKeys: string[]): Promise<number>;
}

export interface SharedVariableContext {
  store: SharedVariableStore;
  /** Encrypts / decrypts the value column ("shared_environment_variables.value"). */
  cipher: KeyCipher;
}

/** Copy shown to the user: Coolify's, word for word. */
export const SHARED_VARIABLE_MESSAGES = {
  /** saveKey() */
  exists: "Variable already exists.",
  predefined: "Cannot create predefined variable.",
  /** handleError() on a unique violation */
  duplicate: "Duplicate entry found. Please use a different name.",
  /** EnvironmentVariable\Show::submit() and delete() */
  updated: "Environment variable updated.",
  deleted: "Environment variable deleted successfully.",
  /** handleBulkSubmit() */
  bulkUpdated: "Environment variables updated.",
} as const;

/** A failure Coolify reports through dispatch('error'), or on a field when `field` is set. */
export class SharedVariableError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    readonly field: string | null = null,
  ) {
    super(message);
  }
}

/** unique(key, <owner>, org_id): the answer of the question before the write, for the write the index refuses. */
const refusingDuplicateKey = <T>(write: () => Promise<T>, refusal: () => SharedVariableError): Promise<T> => refusingDuplicates(SHARED_VARIABLE_UNIQUE_INDEXES, write, refusal);
const keyExists = (): SharedVariableError => new SharedVariableError(SHARED_VARIABLE_MESSAGES.exists);
const duplicateKey = (): SharedVariableError => new SharedVariableError(SHARED_VARIABLE_MESSAGES.duplicate, 409);

/** Which scope a request names. */
export type ScopeRef = { type: "team" } | { type: "project" | "environment" | "server"; uuid: string };

export interface ScopeInfo {
  type: SharedVariableScope;
  /** The project's, environment's or server's uuid; null for the org. */
  uuid: string | null;
  /** The editor's title: "Team variables", the project, "project / environment", the server. */
  title: string;
  /** An environment's project (its page's path carries both uuids). */
  project: { uuid: string; name: string } | null;
}

interface ResolvedScope {
  owner: SharedVariableOwner;
  info: ScopeInfo;
}

/** mount(): the scope's owner in the org, or null (Coolify redirects to the dashboard or answers 404). */
async function resolveScope(ctx: SharedVariableContext, ref: ScopeRef): Promise<ResolvedScope | null> {
  if (ref.type === "team") return { owner: { type: "team", id: null }, info: { type: "team", uuid: null, title: "Team variables", project: null } };
  if (ref.type === "project") {
    const project = await ctx.store.findProject(ref.uuid);
    return project ? { owner: { type: "project", id: project.id }, info: { type: "project", uuid: project.uuid, title: project.name, project: null } } : null;
  }
  if (ref.type === "environment") {
    const environment = await ctx.store.findEnvironment(ref.uuid);
    if (!environment) return null;
    return {
      owner: { type: "environment", id: environment.id },
      info: { type: "environment", uuid: environment.uuid, title: `${environment.project_name} / ${environment.name}`, project: { uuid: environment.project_uuid, name: environment.project_name } },
    };
  }
  const server = await ctx.store.findServer(ref.uuid);
  return server ? { owner: { type: "server", id: server.id }, info: { type: "server", uuid: server.uuid, title: server.name, project: null } } : null;
}

/** The editor's readOnlyKeys: a server's predefined variables. */
const readOnlyKeys = (type: SharedVariableScope): string[] => (type === "server" ? [...PREDEFINED_SERVER_VARIABLE_KEYS] : []);

export interface SharedVariableItem {
  id: string;
  key: string;
  comment: string | null;
  isMultiline: boolean;
  isLiteral: boolean;
  /** Locked: the value is never shown again. */
  isShownOnce: boolean;
  /** A predefined server variable ("Built-in · Read-only"). */
  readOnly: boolean;
  /** Only a read-only variable carries its value in the list. */
  value: string | null;
}

function item(row: DeploySharedVariableRow, readOnly: boolean, value: string | null): SharedVariableItem {
  return {
    id: String(row.id),
    key: row.key,
    comment: row.comment ?? null,
    isMultiline: Boolean(row.is_multiline),
    isLiteral: Boolean(row.is_literal),
    isShownOnce: Boolean(row.is_shown_once),
    readOnly,
    value,
  };
}

/** $collection->sortBy('key') over keys: byte order. */
const byKey = (a: { key: string }, b: { key: string }): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * getDevView(): the scope's variables by key, each as
 * formatEnvVariableForDevView() writes it; a server's predefined variables are
 * left out. A value is decrypted only for who may read it.
 */
async function devView(ctx: SharedVariableContext, rows: DeploySharedVariableWithSecretRow[], hidden: string[], canViewValues: boolean): Promise<string> {
  const lines: string[] = [];
  for (const row of rows.filter((r) => !hidden.includes(r.key)).sort(byKey)) {
    const editable = canViewValues && !row.is_shown_once && !row.is_multiline;
    lines.push(
      formatEnvVariableForDevView(
        { key: row.key, value: editable ? await ctx.cipher.decrypt(row.value) : null, isShownOnce: Boolean(row.is_shown_once), isMultiline: Boolean(row.is_multiline), isLiteral: Boolean(row.is_literal) },
        canViewValues,
      ),
    );
  }
  return lines.join("\n");
}

export interface SharedVariablesPage {
  scope: ScopeInfo;
  /** The scope's variables in the order they were created. */
  variables: SharedVariableItem[];
  readOnlyKeys: string[];
  /** The developer view's text. */
  devView: string;
}

/** mount() + render(): the editor of a scope, in both of its views. */
export async function sharedVariablesPage(ctx: SharedVariableContext, ref: ScopeRef, canViewValues: boolean): Promise<SharedVariablesPage | null> {
  const scope = await resolveScope(ctx, ref);
  if (!scope) return null;
  const rows = await ctx.store.list(scope.owner);
  const builtIn = readOnlyKeys(scope.info.type);
  const variables: SharedVariableItem[] = [];
  for (const row of rows) {
    const readOnly = builtIn.includes(row.key);
    variables.push(item(row, readOnly, readOnly ? await ctx.cipher.decrypt(row.value) : null));
  }
  return { scope: scope.info, variables, readOnlyKeys: builtIn, devView: await devView(ctx, rows, builtIn, canViewValues) };
}

/**
 * EnvironmentVariable\Show::loadValues() and copyValue(): one variable with
 * its value, which stays null for a locked variable and for who may not read
 * values.
 */
export async function showSharedVariable(ctx: SharedVariableContext, ref: ScopeRef, id: string, canViewValues: boolean): Promise<(SharedVariableItem & { isValueHidden: boolean }) | null> {
  const scope = await resolveScope(ctx, ref);
  if (!scope) return null;
  const row = await ctx.store.findById(scope.owner, id);
  if (!row) return null;
  const readOnly = readOnlyKeys(scope.info.type).includes(row.key);
  const visible = readOnly || (canViewValues && !row.is_shown_once);
  return { ...item(row, readOnly, visible ? await ctx.cipher.decrypt(row.value) : null), isValueHidden: !readOnly && !canViewValues };
}

/** The model's saving hook: a container cannot start with a NUL byte in a value. */
function rejectNulByte(value: string, field: string | null): void {
  if (value.includes("\0")) throw new SharedVariableError(SHARED_VARIABLE_VALIDATION_MESSAGES.valueNul, 422, field);
}

/** saveKey(): a new variable of the scope; its key is not one the scope has. */
export async function addSharedVariable(ctx: SharedVariableContext, ref: ScopeRef, input: AddVariableInput): Promise<SharedVariableItem | null> {
  const scope = await resolveScope(ctx, ref);
  if (!scope) return null;
  if (readOnlyKeys(scope.info.type).includes(input.key)) throw new SharedVariableError(SHARED_VARIABLE_MESSAGES.predefined);
  if (await ctx.store.findByKey(scope.owner, input.key)) throw new SharedVariableError(SHARED_VARIABLE_MESSAGES.exists);
  rejectNulByte(input.value, null);
  const value = await ctx.cipher.encrypt(input.value);
  const row = await refusingDuplicateKey(() => ctx.store.insert({ owner: scope.owner, key: input.key, value, comment: input.comment, isMultiline: input.isMultiline, isLiteral: input.isLiteral }), keyExists);
  return item(row, false, null);
}

/** filled(): not null and not blank after PHP's trim(). */
const filled = (value: string | null): value is string => value !== null && phpTrim(value) !== "";

/** A variable of the scope that its pages can change: not one of a server's predefined variables. */
async function editable(ctx: SharedVariableContext, ref: ScopeRef, id: string): Promise<{ scope: ResolvedScope; row: DeploySharedVariableWithSecretRow } | null> {
  const scope = await resolveScope(ctx, ref);
  if (!scope) return null;
  const row = await ctx.store.findById(scope.owner, id);
  if (!row || readOnlyKeys(scope.info.type).includes(row.key)) return null;
  return { scope, row };
}

/**
 * EnvironmentVariable\Show::submit() → syncData(true) for a shared variable.
 * A locked variable keeps its stored value unless a new one is given, and
 * stays locked (the saving hook). Coolify leaves a key that another variable
 * of the scope has to the unique index; here the answer is the same message
 * for every scope.
 */
export async function updateSharedVariable(ctx: SharedVariableContext, ref: ScopeRef, id: string, input: UpdateVariableInput): Promise<SharedVariableItem | null> {
  const found = await editable(ctx, ref, id);
  if (!found) return null;
  const { scope, row } = found;
  if (input.key !== row.key && (await ctx.store.findByKey(scope.owner, input.key))) throw new SharedVariableError(SHARED_VARIABLE_MESSAGES.duplicate, 409);
  const changes: SharedVariableChanges = { key: input.key, comment: input.comment, isMultiline: input.isMultiline, isLiteral: input.isLiteral };
  if (!row.is_shown_once) {
    rejectNulByte(input.value, "value");
    changes.value = await ctx.cipher.encrypt(input.value);
    changes.isShownOnce = input.isShownOnce;
  } else if (filled(input.newLockedValue)) {
    rejectNulByte(input.newLockedValue, "value");
    changes.value = await ctx.cipher.encrypt(input.newLockedValue);
  }
  const saved = await refusingDuplicateKey(() => ctx.store.update(row.id, changes), duplicateKey);
  return saved ? item(saved, false, null) : null;
}

/** EnvironmentVariable\Show::lock(): the value is hidden for good. */
export async function lockSharedVariable(ctx: SharedVariableContext, ref: ScopeRef, id: string): Promise<SharedVariableItem | null> {
  const found = await editable(ctx, ref, id);
  if (!found) return null;
  const saved = await ctx.store.update(found.row.id, { isShownOnce: true });
  return saved ? item(saved, false, null) : null;
}

/** EnvironmentVariable\Show::delete(). */
export async function deleteSharedVariable(ctx: SharedVariableContext, ref: ScopeRef, id: string): Promise<boolean> {
  const found = await editable(ctx, ref, id);
  return found ? ctx.store.delete(found.row.id) : false;
}

/** The key mutator of the model: ValidationPatterns::validatedEnvironmentVariableKey(), and the column's length. */
function validatedKey(key: string): string {
  const normalized = normalizeEnvironmentVariableKey(key);
  if (!isValidEnvironmentVariableKey(normalized)) throw new SharedVariableError(SHARED_VARIABLE_VALIDATION_MESSAGES.keyRegex);
  if ([...normalized].length > 255) throw new SharedVariableError(SHARED_VARIABLE_VALIDATION_MESSAGES.keyMax(255));
  return normalized;
}

/** The comment column's length (Coolify lets the database refuse a longer one). */
function validatedComment(comment: string | null): string | null {
  if (comment !== null && [...comment].length > 256) throw new SharedVariableError(SHARED_VARIABLE_VALIDATION_MESSAGES.max("comment", 256));
  return comment;
}

/**
 * submit() of the developer view → handleBulkSubmit(): the text is parsed
 * first, so an invalid "# coolify:" line changes nothing; then the variables
 * whose keys the text no longer has are deleted, and each line updates the
 * variable with its key or creates one. A locked or multiline variable, and
 * one whose value the view cannot hold, is left as it is. Only the server
 * view writes a line's inline comment (and so clears the comment of a line
 * without one), as Coolify's does; a server's predefined variables are neither
 * deleted nor written. Returns whether anything changed; the caller's
 * transaction undoes everything when a line fails.
 */
export async function saveSharedVariablesDevView(ctx: SharedVariableContext, ref: ScopeRef, text: string): Promise<{ changed: boolean } | null> {
  const scope = await resolveScope(ctx, ref);
  if (!scope) return null;
  let variables: ReturnType<typeof parseEnvDevView>;
  try {
    variables = parseEnvDevView(text);
  } catch (e) {
    if (e instanceof DevViewError) throw new SharedVariableError(e.message);
    throw e;
  }
  const { owner } = scope;
  const isServer = owner.type === "server";
  const builtIn = readOnlyKeys(owner.type);

  let changed = (await ctx.store.deleteExcept(owner, [...variables.keys()], builtIn)) > 0;
  for (const [key, data] of variables) {
    // Skip predefined variables
    if (builtIn.includes(key)) continue;
    const literal = data.settings.is_literal;
    const found = await ctx.store.findByKey(owner, key);
    if (found) {
      if (found.is_shown_once || found.is_multiline) continue;
      const current = await ctx.cipher.decrypt(found.value);
      if (formatEnvValueForDevView(current) === null) continue;
      const changes: SharedVariableChanges = {};
      if (current !== data.value) {
        rejectNulByte(data.value, null);
        changes.value = await ctx.cipher.encrypt(data.value);
      }
      if (isServer && (found.comment ?? null) !== data.comment) changes.comment = validatedComment(data.comment);
      if (literal !== undefined && literal !== Boolean(found.is_literal)) changes.isLiteral = literal;
      if (Object.keys(changes).length === 0) continue;
      await ctx.store.update(found.id, changes);
    } else {
      const normalized = validatedKey(key);
      // The key as typed was not found, but its trimmed form may be a variable of the scope (Coolify's unique index).
      if (normalized !== key && (await ctx.store.findByKey(owner, normalized))) throw new SharedVariableError(SHARED_VARIABLE_MESSAGES.duplicate, 409);
      rejectNulByte(data.value, null);
      const value = await ctx.cipher.encrypt(data.value);
      const comment = isServer ? validatedComment(data.comment) : null;
      await refusingDuplicateKey(() => ctx.store.insert({ owner, key: normalized, value, comment, isMultiline: false, isLiteral: literal ?? false }), duplicateKey);
    }
    changed = true;
  }
  return { changed };
}

// ---------------------------------------------------------------- the overview and the index pages

export interface OverviewVariable {
  id: string;
  key: string;
  scope: SharedVariableScope;
  /** 'Team', the project, "project / environment" or the server; null when the owner is gone. */
  owner: string | null;
  /** The uuids of the owner's pages (an environment's page needs its project's too). */
  ownerUuid: string | null;
  projectUuid: string | null;
  /** How many resources reference the variable. */
  resources: number;
  updatedAt: string | null;
}

export interface SharedVariablesOverview {
  scopes: Record<SharedVariableScope, { variables: number; owners: number }>;
  recent: OverviewVariable[];
  used: OverviewVariable[];
  unused: OverviewVariable[];
  /** References in resource variables to a shared variable that does not exist. */
  missing: number;
}

const OWNER_ID: Record<SharedVariableScope, (row: DeploySharedVariableOverviewRow) => string> = {
  team: () => "team",
  project: (row) => String(row.project_id),
  environment: (row) => String(row.environment_id),
  server: (row) => String(row.server_id),
};

function overviewVariable(row: DeploySharedVariableOverviewRow): OverviewVariable {
  const base = { id: String(row.id), key: row.key, scope: row.type, resources: 0, updatedAt: utcIso(row.updated_at) };
  if (row.type === "team") return { ...base, owner: "Team", ownerUuid: null, projectUuid: null };
  if (row.type === "project") return { ...base, owner: row.project_name, ownerUuid: row.project_uuid, projectUuid: row.project_uuid };
  if (row.type === "server") return { ...base, owner: row.server_name, ownerUuid: row.server_uuid, projectUuid: null };
  const owner = row.environment_name === null ? null : `${row.environment_project_name ?? ""} / ${row.environment_name}`;
  return { ...base, owner, ownerUuid: row.environment_uuid, projectUuid: row.environment_project_uuid };
}

/**
 * SharedVariableCanvas::overview(): the counts per scope, the six variables
 * changed last and the variables no resource references, by key. Keys and
 * counts only; no value is read. A server's predefined variables are left out.
 * Which resources reference a variable comes from the resources' own
 * environment variables, which no resource has yet: every variable counts as
 * not used and no reference is missing.
 */
export async function sharedVariablesOverview(ctx: SharedVariableContext): Promise<SharedVariablesOverview> {
  const builtIn: readonly string[] = PREDEFINED_SERVER_VARIABLE_KEYS;
  const rows = (await ctx.store.overview()).filter((row) => !(row.type === "server" && builtIn.includes(row.key)));
  const count = (scope: SharedVariableScope) => {
    const ofScope = rows.filter((row) => row.type === scope);
    return { variables: ofScope.length, owners: new Set(ofScope.map(OWNER_ID[scope])).size };
  };
  const variables = rows.map(overviewVariable);
  const time = (v: OverviewVariable) => (v.updatedAt === null ? -Infinity : Date.parse(v.updatedAt));
  return {
    scopes: { team: count("team"), project: count("project"), environment: count("environment"), server: count("server") },
    recent: [...variables].sort((a, b) => time(b) - time(a)).slice(0, 6),
    used: variables.filter((v) => v.resources > 0),
    unused: variables.filter((v) => v.resources === 0).sort(byKey),
    missing: 0,
  };
}

export interface ProjectVariablesItem {
  uuid: string;
  name: string;
  description: string | null;
  variableCount: number;
}

/** Project\Index: the org's projects, each with how many variables it has. */
export async function sharedVariableProjects(ctx: SharedVariableContext): Promise<ProjectVariablesItem[]> {
  return (await ctx.store.projects()).map((p) => ({ uuid: p.uuid, name: p.name, description: p.description, variableCount: Number(p.variable_count) }));
}

export interface EnvironmentVariablesProject {
  uuid: string;
  name: string;
  description: string | null;
  environments: Array<{ uuid: string; name: string; description: string | null }>;
}

/** Environment\Index: the projects that have an environment, each with its environments. */
export async function sharedVariableEnvironments(ctx: SharedVariableContext): Promise<EnvironmentVariablesProject[]> {
  const projects = new Map<string, EnvironmentVariablesProject>();
  for (const row of await ctx.store.environments()) {
    let project = projects.get(row.project_uuid);
    if (!project) {
      project = { uuid: row.project_uuid, name: row.project_name, description: row.project_description, environments: [] };
      projects.set(row.project_uuid, project);
    }
    project.environments.push({ uuid: row.uuid, name: row.name, description: row.description });
  }
  return [...projects.values()];
}

export interface ServerVariablesItem {
  uuid: string;
  name: string;
  description: string | null;
  ip: string;
  /** Server::isFunctional(): 'Ready', else 'Validation required'. */
  isFunctional: boolean;
}

/** Server\Index: the org's servers by name. */
export async function sharedVariableServers(ctx: SharedVariableContext): Promise<ServerVariablesItem[]> {
  return (await ctx.store.servers()).map((s) => ({ uuid: s.uuid, name: s.name, description: s.description, ip: s.ip, isFunctional: isFunctional(s) }));
}
