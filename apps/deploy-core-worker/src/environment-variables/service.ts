// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Shared/EnvironmentVariable/{All,Add,Show}.php,
// app/Models/EnvironmentVariable.php (the creating, created and saving hooks, the value accessor and mutator,
// real_value, is_really_required, resolveReferencedValue) and bootstrap/helpers/shared.php (handleError)
// (Apache-2.0), modified.
//
// What the Environment Variables page does, as plain operations on one
// resource's variables: the list, a variable's value, add, update, lock,
// delete, the four switches above the list, and the developer view with its
// bulk save. The store is bound to one resource type (Coolify's resourceable);
// only applications are wired. Nothing here talks to a server: the .env file
// of a deployment is written by the deployment job, which does not exist yet.
import type {
  DeployEnvironmentVariableResourceRow,
  DeployEnvironmentVariableRow,
  DeploySharedVariableReferenceRow,
  EnvironmentVariableChanges,
  EnvironmentVariableResourceType,
  EnvironmentVariableSettingChanges,
  NewEnvironmentVariable,
  SharedVariableRefScope,
} from "@saas/db/deploy";
import { newPublicId } from "../helpers/names.js";
import type { KeyCipher } from "../private-keys/service.js";
import type { FieldErrors } from "../private-keys/validation.js";
import {
  blankString,
  EnvFormatError,
  formatEnvValueForDevView,
  formatEnvVariableForDevView,
  isMagicEnvironmentVariable,
  isProtectedEnvironmentVariable,
  parseEnvDevView,
  parseEnvFormatToArray,
  withoutEdgeLineBreaks,
  type DevViewEntry,
} from "./env-format.js";
import { isSharedReference, referencedVariableKey, resolveRealValue, SHARED_VARIABLE_TYPES, sharedVariableReferences, type ResolvedSharedVariable, type SharedVariableType } from "./references.js";
import {
  ENVIRONMENT_VARIABLE_MESSAGES,
  normalizeEnvironmentVariables,
  submittedKey,
  validateUpdate,
  type AddInput,
  type BulkInput,
  type SettingsInput,
} from "./validation.js";

type Id = string | number;
type Row = DeployEnvironmentVariableRow;
type Resource = DeployEnvironmentVariableResourceRow;

/** One resource type's variables, settings and shared variable lookups, within one org. */
export interface EnvironmentVariableStore {
  findResource(uuid: string): Promise<Resource | null>;
  /** The production or the preview variables, by `order` then id, or by key. */
  list(resourceId: Id, isPreview: boolean, orderBy: "order" | "key"): Promise<Row[]>;
  findByUuid(resourceId: Id, uuid: string): Promise<Row | null>;
  /** The variables of one preview flag that have the key, oldest first. */
  findByKey(resourceId: Id, isPreview: boolean, key: string): Promise<Row[]>;
  /** The highest `order` among the production variables, or 0. */
  maxOrder(resourceId: Id): Promise<number>;
  /** Null when the key already has a row (EnvironmentVariable::performInsert). */
  insert(resourceId: Id, variable: Omit<NewEnvironmentVariable, "orgId">): Promise<Row | null>;
  update(id: Id, changes: EnvironmentVariableChanges): Promise<Row | null>;
  delete(ids: Id[]): Promise<number>;
  updateSettings(resourceId: Id, changes: EnvironmentVariableSettingChanges): Promise<boolean>;
  /** The shared variable a {{type.KEY}} reference names in one scope. */
  sharedVariable(scope: SharedVariableRefScope, key: string): Promise<DeploySharedVariableReferenceRow | null>;
  sharedVariableKeys(scope: SharedVariableRefScope): Promise<string[]>;
}

export interface EnvironmentVariableContext {
  resourceType: EnvironmentVariableResourceType;
  store: EnvironmentVariableStore;
  /** Encrypts / decrypts deploy.environment_variables.value under the org's key. */
  cipher: KeyCipher;
  /** Decrypts deploy.shared_environment_variables.value. */
  sharedCipher: KeyCipher;
}

/**
 * Coolify's abilities on the resource: `manageEnvironment` (every change) and
 * `viewSensitive` (reading a value). Listing needs `view`, which the handler
 * has checked.
 */
export interface EnvironmentVariableAccess {
  canManage: boolean;
  canViewValues: boolean;
}

/** config('constants.coolify.version') at 91b7e3e (release.json): what the creating hook stores as a variable's version. */
export const ENVIRONMENT_VARIABLE_VERSION = "4.7.6";

export const ENVIRONMENT_VARIABLE_SERVICE_MESSAGES = {
  /** All::handleSingleSubmit() and Show::submit() */
  exists: "Environment variable already exists.",
  /** All::handleSingleSubmit() */
  added: "Environment variable added.",
  /** Show::submit() */
  updated: "Environment variable updated.",
  requiredEmpty: "Required environment variables cannot be empty.",
  /** Show::delete() */
  deleted: "Environment variable deleted successfully.",
  /** All::handleBulkSubmit() */
  bulkUpdated: "Environment variables updated.",
  /** All::submit(): the prefix of a parse error in the preview text. */
  previewPrefix: "Preview deployments: ",
  /** All::instantSave() and saveCoolifyDefaultVariables() */
  settingsUpdated: "Environment variable settings updated.",
  /** All::saveLogRedactionSetting() */
  logRedactionUpdated: "Log redaction setting updated.",
  /** handleError() for a UniqueConstraintViolationException */
  duplicate: "Duplicate entry found. Please use a different name.",
} as const;

/** A failure Coolify reports through dispatch('error'), an exception or — with `field` — a ValidationException. */
export class EnvironmentVariableError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    readonly field: string | null = null,
  ) {
    super(message);
  }
}

const sameId = (a: Id, b: Id): boolean => String(a) === String(b);

/**
 * All::mount(): previews show for an application that has a Git repository
 * and no Dockerfile of its own. A Docker image application has Coolify's
 * placeholder repository, so it shows them too.
 */
export function showsPreview(type: EnvironmentVariableResourceType, resource: Pick<Resource, "git_repository" | "dockerfile">): boolean {
  return type === "application" && !blankString(resource.git_repository) && blankString(resource.dockerfile);
}

/** The value accessor: null for a stored null or '', else the decrypted value without its edge line breaks. */
async function storedValue(ctx: EnvironmentVariableContext, row: Pick<Row, "value">): Promise<string | null> {
  if (!row.value) return null;
  return withoutEdgeLineBreaks(await ctx.cipher.decrypt(row.value));
}

/** The scopes a resource's values can reference; a resource whose server is gone has no `server` scope. */
function scopesOf(resource: Resource): Record<SharedVariableType, SharedVariableRefScope | null> {
  return {
    team: { type: "team" },
    project: { type: "project", id: resource.project_id },
    environment: { type: "environment", id: resource.environment_id },
    server: resource.server_id === null ? null : { type: "server", id: resource.server_id },
  };
}

/**
 * real_value: the value with its shared variable references filled in. For
 * display and copy (displayRealValue) a locked shared variable keeps its
 * reference text; a deployment and is_really_required reveal it.
 */
async function realValue(ctx: EnvironmentVariableContext, resource: Resource, value: string | null, revealLockedSharedVariables: boolean): Promise<string | null> {
  if (value === null || value === "") return value;
  const scopes = scopesOf(resource);
  const found = new Map<string, ResolvedSharedVariable | null>();
  for (const { type, key } of sharedVariableReferences(withoutEdgeLineBreaks(value))) {
    const name = `${type}.${key}`;
    if (found.has(name) || !(SHARED_VARIABLE_TYPES as readonly string[]).includes(type)) continue;
    const scope = scopes[type as SharedVariableType];
    const shared = scope ? await ctx.store.sharedVariable(scope, key) : null;
    if (!shared) found.set(name, null);
    else if (shared.is_shown_once && !revealLockedSharedVariables) found.set(name, { value: "", isShownOnce: true });
    else found.set(name, { value: await ctx.sharedCipher.decrypt(shared.value), isShownOnce: shared.is_shown_once });
  }
  return resolveRealValue(value, { find: (type, key) => found.get(`${type}.${key}`) ?? null, revealLockedSharedVariables });
}

/** A row of the list: what the table shows without decrypting a value. */
export interface EnvironmentVariableItem {
  uuid: string;
  key: string;
  comment: string | null;
  scope: "production" | "preview";
  order: number | null;
  isMultiline: boolean;
  isLiteral: boolean;
  isRuntime: boolean;
  isBuildtime: boolean;
  isRequired: boolean;
  /** is_shown_once: locked, the value is never returned again. */
  isShownOnce: boolean;
  /** The stored column: the value is one shared variable reference. */
  isShared: boolean;
  /** Show::checkEnvs(): a SERVICE_FQDN / SERVICE_URL / SERVICE_NAME variable, managed and not editable. */
  isMagic: boolean;
  /** Required and without a resolved value: these lead the list. */
  isMissingRequired: boolean;
}

function item(row: Row, isMissingRequired: boolean): EnvironmentVariableItem {
  return {
    uuid: row.uuid ?? "",
    key: row.key,
    comment: row.comment ?? null,
    scope: row.is_preview ? "preview" : "production",
    order: row.order ?? null,
    isMultiline: row.is_multiline,
    isLiteral: row.is_literal,
    isRuntime: row.is_runtime,
    isBuildtime: row.is_buildtime,
    isRequired: row.is_required,
    isShownOnce: row.is_shown_once,
    isShared: row.is_shared,
    isMagic: isMagicEnvironmentVariable(row.key),
    isMissingRequired,
  };
}

/** SQL's key LIKE 'SERVICE_FQDN%' OR … (the "_" matches any one character): the rows the list puts first and calls managed. */
export const sortsAsManaged = (key: string): boolean => /^SERVICE.(?:FQDN|URL|NAME)/s.test(key);

/** is_really_required: required, and the resolved value is empty. */
async function isMissingRequired(ctx: EnvironmentVariableContext, resource: Resource, row: Row): Promise<boolean> {
  if (!row.is_required) return false;
  return ((await realValue(ctx, resource, await storedValue(ctx, row), true)) ?? "") === "";
}

/**
 * All::managedEnvironmentVariablesQuery(): the variables that are required and
 * empty first, then the managed ones, then by key (the "Alphabetical"
 * setting) or by `order` and id.
 */
async function listItems(ctx: EnvironmentVariableContext, resource: Resource, isPreview: boolean): Promise<EnvironmentVariableItem[]> {
  const rows = await ctx.store.list(resource.id, isPreview, resource.is_env_sorting_enabled ? "key" : "order");
  const items: EnvironmentVariableItem[] = [];
  for (const row of rows) items.push(item(row, await isMissingRequired(ctx, resource, row)));
  const rank = (i: EnvironmentVariableItem) => (i.isMissingRequired ? 0 : 2) + (sortsAsManaged(i.key) ? 0 : 1);
  // Array.prototype.sort is stable: the store's order stays within a rank.
  return items.sort((a, b) => rank(a) - rank(b));
}

export interface EnvironmentVariableSettings {
  isEnvSortingEnabled: boolean;
  useBuildSecrets: boolean;
  includeCoolifyDefaultVariables: boolean;
  redactAllEnvValuesInLogs: boolean;
}

/** All::mount(): the settings' values, with the defaults of a resource without a settings row. */
function settingsOf(resource: Resource): EnvironmentVariableSettings {
  return {
    isEnvSortingEnabled: resource.is_env_sorting_enabled ?? false,
    useBuildSecrets: resource.use_build_secrets ?? false,
    includeCoolifyDefaultVariables: resource.include_coolify_default_variables !== false,
    redactAllEnvValuesInLogs: resource.redact_all_env_values_in_logs ?? true,
  };
}

export interface EnvironmentVariablesPage {
  resource: { type: EnvironmentVariableResourceType; uuid: string; name: string; buildPack: string | null };
  /** The preview variables are listed and the developer view has its "Preview deployments" text. */
  showPreview: boolean;
  settings: EnvironmentVariableSettings;
  /** The production variables, then the preview ones, each in Coolify's default order. */
  variables: EnvironmentVariableItem[];
  /** Add::availableSharedVariables(): the keys the value field suggests after "{{". */
  availableSharedVariables: Record<SharedVariableType, string[]>;
}

/** All::mount() and the list: the settings and every variable, without a value. Null for a resource that is not the org's. */
export async function environmentVariablesPage(ctx: EnvironmentVariableContext, uuid: string): Promise<EnvironmentVariablesPage | null> {
  const resource = await ctx.store.findResource(uuid);
  if (!resource) return null;
  const showPreview = showsPreview(ctx.resourceType, resource);
  const scopes = scopesOf(resource);
  const available = {} as Record<SharedVariableType, string[]>;
  for (const type of SHARED_VARIABLE_TYPES) {
    const scope = scopes[type];
    available[type] = scope ? await ctx.store.sharedVariableKeys(scope) : [];
  }
  return {
    resource: { type: ctx.resourceType, uuid: resource.uuid, name: resource.name, buildPack: resource.build_pack ?? null },
    showPreview,
    settings: settingsOf(resource),
    variables: [...(await listItems(ctx, resource, false)), ...(showPreview ? await listItems(ctx, resource, true) : [])],
    availableSharedVariables: available,
  };
}

export interface EnvironmentVariableValues {
  /** Null for a locked variable, and for a caller who may not read values. */
  value: string | null;
  /** The value with its shared variable references filled in, when it is one (is_shared); else null. */
  realValue: string | null;
  isShared: boolean;
  /** Required, and the (resolved) value is blank. */
  isReallyRequired: boolean;
  /** The caller may not read values (viewSensitive). */
  isValueHidden: boolean;
  /** Show::copyValue(): what the copy button copies; null for a locked or hidden value. */
  copyValue: string | null;
}

/**
 * Show::loadValues() / hydrateValueFields() and copyValue(): a variable's
 * value as the edit dialog shows it. A locked value is never returned, and
 * nothing is decrypted for a caller who may not read values.
 */
export async function showEnvironmentVariable(ctx: EnvironmentVariableContext, uuid: string, envUuid: string, access: EnvironmentVariableAccess): Promise<EnvironmentVariableValues | null> {
  const resource = await ctx.store.findResource(uuid);
  const row = resource ? await ctx.store.findByUuid(resource.id, envUuid) : null;
  if (!resource || !row) return null;
  if (!access.canViewValues) return { value: null, realValue: null, isShared: row.is_shared, isReallyRequired: row.is_required, isValueHidden: true, copyValue: null };
  const value = await storedValue(ctx, row);
  const isShared = isSharedReference(value);
  const resolved = isShared ? await realValue(ctx, resource, value, false) : null;
  const isReallyRequired = row.is_required && blankString(isShared ? resolved : value);
  if (row.is_shown_once) return { value: null, realValue: null, isShared, isReallyRequired, isValueHidden: false, copyValue: null };

  // resolveReferencedValue(): "$OTHER" copies the value of the variable OTHER of the same resource, unless that one is locked.
  let copy = value;
  const referencedKey = referencedVariableKey(value, row.is_literal);
  if (referencedKey !== null) {
    const referenced = (await ctx.store.findByKey(resource.id, row.is_preview, referencedKey)).find((r) => !r.is_shown_once);
    copy = (referenced ? await storedValue(ctx, referenced) : null) ?? value;
  }
  return { value, realValue: resolved, isShared, isReallyRequired, isValueHidden: false, copyValue: await realValue(ctx, resource, copy, false) };
}

/** What a new variable is, before the model's hooks. */
interface NewVariable {
  key: string;
  value: string | null;
  comment: string | null;
  order: number | null;
  isPreview: boolean;
  isMultiline: boolean;
  isLiteral: boolean;
  isRuntime: boolean;
  isBuildtime: boolean;
  isRequired: boolean;
  isShownOnce: boolean;
}

/** ValidationPatterns::rejectNulByteInEnvironmentVariableValue(): a container cannot start with a NUL in its environment. */
function rejectNulByte(value: string | null): void {
  if (value !== null && value.includes("\0")) throw new EnvironmentVariableError(ENVIRONMENT_VARIABLE_MESSAGES.nulByte, 422, "value");
}

/**
 * EnvironmentVariable::save() for a new variable: the value loses its edge
 * line breaks and is encrypted, the creating hook gives it a uuid and
 * Coolify's version, the saving hook refuses a NUL and sets is_shared, and the
 * created hook gives an application's production variable its preview copy
 * (without an order) when the key has none.
 */
async function createVariable(ctx: EnvironmentVariableContext, resource: Resource, variable: NewVariable): Promise<Row> {
  const value = variable.value === null ? null : withoutEdgeLineBreaks(variable.value);
  rejectNulByte(value);
  const row = await ctx.store.insert(resource.id, {
    uuid: newPublicId(),
    key: variable.key,
    value: value === null ? null : await ctx.cipher.encrypt(value),
    comment: variable.comment,
    order: variable.order,
    isPreview: variable.isPreview,
    isMultiline: variable.isMultiline,
    isLiteral: variable.isLiteral,
    isRuntime: variable.isRuntime,
    isBuildtime: variable.isBuildtime,
    isRequired: variable.isRequired,
    isShownOnce: variable.isShownOnce,
    isShared: isSharedReference(value),
    version: ENVIRONMENT_VARIABLE_VERSION,
  });
  if (!row) throw new EnvironmentVariableError(ENVIRONMENT_VARIABLE_SERVICE_MESSAGES.duplicate, 409);
  if (ctx.resourceType === "application" && !variable.isPreview && (await ctx.store.findByKey(resource.id, true, variable.key)).length === 0) {
    await createVariable(ctx, resource, { ...variable, value, order: null, isPreview: true });
  }
  return row;
}

/** What a save may change of an existing variable; `value` is the plaintext. */
interface VariableChanges {
  key?: string;
  value?: string | null;
  comment?: string | null;
  order?: number | null;
  isMultiline?: boolean;
  isLiteral?: boolean;
  isRuntime?: boolean;
  isBuildtime?: boolean;
  isRequired?: boolean;
  isShownOnce?: boolean;
}

/**
 * EnvironmentVariable::save() for an existing variable: only what differs
 * from the stored row is written (a value is compared decrypted). The saving
 * hook keeps a lock (is_shown_once never goes back to false), refuses a NUL in
 * a changed value and sets is_shared from the value. `current` is the stored
 * value, decrypted. Answers whether anything was written.
 */
async function saveVariable(ctx: EnvironmentVariableContext, row: Row, current: string | null, changes: VariableChanges): Promise<boolean> {
  const dirty: EnvironmentVariableChanges = {};
  let value = current;
  if (changes.value !== undefined) {
    value = changes.value === null ? null : withoutEdgeLineBreaks(changes.value);
    if (value !== current) {
      rejectNulByte(value);
      dirty.value = value === null ? null : await ctx.cipher.encrypt(value);
    }
  }
  if (changes.key !== undefined && changes.key !== row.key) dirty.key = changes.key;
  if (changes.comment !== undefined && changes.comment !== (row.comment ?? null)) dirty.comment = changes.comment;
  if (changes.order !== undefined && changes.order !== (row.order ?? null)) dirty.order = changes.order;
  if (changes.isMultiline !== undefined && changes.isMultiline !== row.is_multiline) dirty.is_multiline = changes.isMultiline;
  if (changes.isLiteral !== undefined && changes.isLiteral !== row.is_literal) dirty.is_literal = changes.isLiteral;
  if (changes.isRuntime !== undefined && changes.isRuntime !== row.is_runtime) dirty.is_runtime = changes.isRuntime;
  if (changes.isBuildtime !== undefined && changes.isBuildtime !== row.is_buildtime) dirty.is_buildtime = changes.isBuildtime;
  if (changes.isRequired !== undefined && changes.isRequired !== row.is_required) dirty.is_required = changes.isRequired;
  if (changes.isShownOnce !== undefined && !row.is_shown_once && changes.isShownOnce) dirty.is_shown_once = true;
  const isShared = isSharedReference(value);
  if (isShared !== row.is_shared) dirty.is_shared = isShared;
  if (Object.keys(dirty).length === 0) return false;
  await ctx.store.update(row.id, dirty);
  return true;
}

/**
 * Add::submit() after its validation, then All::handleSingleSubmit(): a key
 * the resource already has is refused, the variable takes the place after the
 * last production one. Null for a resource that is not the org's.
 */
export async function addEnvironmentVariable(ctx: EnvironmentVariableContext, uuid: string, input: AddInput): Promise<{ uuid: string; message: string } | null> {
  const resource = await ctx.store.findResource(uuid);
  if (!resource) return null;
  if ((await ctx.store.findByKey(resource.id, input.isPreview, input.key)).length > 0) throw new EnvironmentVariableError(ENVIRONMENT_VARIABLE_SERVICE_MESSAGES.exists, 409);
  const order = (await ctx.store.maxOrder(resource.id)) + 1;
  const row = await createVariable(ctx, resource, { ...input, order, isRequired: false, isShownOnce: false });
  return { uuid: row.uuid ?? "", message: ENVIRONMENT_VARIABLE_SERVICE_MESSAGES.added };
}

/** Laravel's `boolean` values that are true; what a bool property makes of the rest is false. */
const truthy = (value: unknown): boolean => value === true || value === 1 || value === "1";

/**
 * Show::submit(): a key that another variable of the resource has is refused,
 * a required variable cannot be emptied — both before the form is validated —
 * then Show::syncData(true). The form never holds a locked value: the stored
 * one stays unless `newLockedValue` replaces it, and the lock stays. A field
 * the request leaves out keeps what is stored. Null for a variable that is
 * not the org's.
 */
export async function updateEnvironmentVariable(
  ctx: EnvironmentVariableContext,
  uuid: string,
  envUuid: string,
  body: Record<string, unknown>,
): Promise<{ message: string; variable: EnvironmentVariableItem } | { errors: FieldErrors } | null> {
  const resource = await ctx.store.findResource(uuid);
  const row = resource ? await ctx.store.findByUuid(resource.id, envUuid) : null;
  if (!resource || !row) return null;

  // keyBelongsToAnotherVariable()
  const key = submittedKey(body, row.key);
  if ((await ctx.store.findByKey(resource.id, row.is_preview, key)).some((other) => !sameId(other.id, row.id))) {
    throw new EnvironmentVariableError(ENVIRONMENT_VARIABLE_SERVICE_MESSAGES.exists, 409);
  }

  const current = await storedValue(ctx, row);
  const newLockedValue = typeof body.newLockedValue === "string" && !blankString(body.newLockedValue) ? body.newLockedValue : null;
  const submittedValue = row.is_shown_once ? (newLockedValue ?? current) : body.value === undefined ? current : body.value;
  const isRequired = body.is_required === undefined ? row.is_required : truthy(body.is_required);
  if (isRequired && (submittedValue === null || submittedValue === "")) throw new EnvironmentVariableError(ENVIRONMENT_VARIABLE_SERVICE_MESSAGES.requiredEmpty);

  const v = validateUpdate(body, {
    key: row.key,
    comment: row.comment ?? null,
    isMultiline: row.is_multiline,
    isLiteral: row.is_literal,
    isShownOnce: row.is_shown_once,
    isRuntime: row.is_runtime,
    isBuildtime: row.is_buildtime,
    isRequired: row.is_required,
  });
  if (!v.ok) return { errors: v.errors };
  const input = v.input;
  const changes: VariableChanges = {
    key: input.key,
    comment: input.comment,
    isMultiline: input.isMultiline,
    isLiteral: input.isLiteral,
    isRuntime: input.isRuntime,
    isBuildtime: input.isBuildtime,
    isRequired: input.isRequired,
  };
  if (!row.is_shown_once) {
    if (input.value !== undefined) changes.value = input.value;
    changes.isShownOnce = input.isShownOnce;
  } else if (input.newLockedValue !== null && !blankString(input.newLockedValue)) {
    changes.value = input.newLockedValue;
  }
  await saveVariable(ctx, row, current, changes);
  const saved = (await ctx.store.findByUuid(resource.id, envUuid)) ?? row;
  return { message: ENVIRONMENT_VARIABLE_SERVICE_MESSAGES.updated, variable: item(saved, await isMissingRequired(ctx, resource, saved)) };
}

/** Show::lock(): the value is hidden for good. False for a variable that is not the org's. */
export async function lockEnvironmentVariable(ctx: EnvironmentVariableContext, uuid: string, envUuid: string): Promise<boolean> {
  const resource = await ctx.store.findResource(uuid);
  const row = resource ? await ctx.store.findByUuid(resource.id, envUuid) : null;
  if (!resource || !row) return false;
  await saveVariable(ctx, row, await storedValue(ctx, row), { isShownOnce: true });
  return true;
}

/** Show::delete(). The preview copy of a production variable stays, as in Coolify. */
export async function deleteEnvironmentVariable(ctx: EnvironmentVariableContext, uuid: string, envUuid: string): Promise<{ message: string } | null> {
  const resource = await ctx.store.findResource(uuid);
  const row = resource ? await ctx.store.findByUuid(resource.id, envUuid) : null;
  if (!resource || !row) return null;
  await ctx.store.delete([row.id]);
  return { message: ENVIRONMENT_VARIABLE_SERVICE_MESSAGES.deleted };
}

/**
 * All::instantSave(), saveCoolifyDefaultVariables() and
 * saveLogRedactionSetting(): the switches above the list. The toast is the
 * log redaction one when that is the only switch sent.
 */
export async function updateEnvironmentVariableSettings(ctx: EnvironmentVariableContext, uuid: string, input: SettingsInput): Promise<{ message: string; settings: EnvironmentVariableSettings } | null> {
  const resource = await ctx.store.findResource(uuid);
  if (!resource) return null;
  if (Object.keys(input).length > 0) await ctx.store.updateSettings(resource.id, input);
  const fields = Object.keys(input);
  const message = fields.length === 1 && fields[0] === "redact_all_env_values_in_logs" ? ENVIRONMENT_VARIABLE_SERVICE_MESSAGES.logRedactionUpdated : ENVIRONMENT_VARIABLE_SERVICE_MESSAGES.settingsUpdated;
  return { message, settings: settingsOf({ ...resource, ...input }) };
}

/**
 * All::getEnvironmentVariables() and formatEnvironmentVariables(): one set of
 * variables as developer view text — the required ones without a stored value
 * first, then by key or `order`; the generated Compose variables left out; a
 * value decrypted only when its line shows it.
 */
async function devViewText(ctx: EnvironmentVariableContext, resource: Resource, isPreview: boolean, canViewValues: boolean): Promise<string> {
  const rows = await ctx.store.list(resource.id, isPreview, resource.is_env_sorting_enabled ? "key" : "order");
  const rank = (row: Row) => (row.is_required && (row.value === null || row.value === "") ? 0 : 1);
  const lines: string[] = [];
  for (const row of [...rows].sort((a, b) => rank(a) - rank(b))) {
    if (isProtectedEnvironmentVariable(row.key)) continue;
    const shows = canViewValues && !row.is_shown_once && !row.is_multiline;
    lines.push(
      formatEnvVariableForDevView(
        {
          key: row.key,
          value: shows ? await storedValue(ctx, row) : null,
          isShownOnce: row.is_shown_once,
          isMultiline: row.is_multiline,
          flags: { literal: row.is_literal, buildtime: row.is_buildtime, runtime: row.is_runtime },
        },
        canViewValues,
      ),
    );
  }
  return lines.join("\n");
}

export interface DeveloperView {
  showPreview: boolean;
  variables: string;
  /** Null unless the resource shows previews. */
  variablesPreview: string | null;
}

async function developerViewOf(ctx: EnvironmentVariableContext, resource: Resource, canViewValues: boolean): Promise<DeveloperView> {
  const showPreview = showsPreview(ctx.resourceType, resource);
  return {
    showPreview,
    variables: await devViewText(ctx, resource, false, canViewValues),
    variablesPreview: showPreview ? await devViewText(ctx, resource, true, canViewValues) : null,
  };
}

/** All::getDevView(): the variables as editable text. Null for a resource that is not the org's. */
export async function developerView(ctx: EnvironmentVariableContext, uuid: string, access: EnvironmentVariableAccess): Promise<DeveloperView | null> {
  const resource = await ctx.store.findResource(uuid);
  return resource ? developerViewOf(ctx, resource, access.canViewValues) : null;
}

type Parsed = Map<string, DevViewEntry>;

/** All::submit(): both texts parsed and their keys normalized before anything is saved; PHP's exception message as the error. */
function parseBulk(input: BulkInput, showPreview: boolean): { variables: Parsed; previewVariables: Parsed } {
  let variables: Parsed;
  let previewVariables: Parsed = new Map();
  try {
    variables = normalizeEnvironmentVariables(parseEnvDevView(input.variables));
  } catch (e) {
    if (e instanceof EnvFormatError) throw new EnvironmentVariableError(e.message);
    throw e;
  }
  if (showPreview) {
    try {
      previewVariables = normalizeEnvironmentVariables(parseEnvDevView(input.variablesPreview));
    } catch (e) {
      if (e instanceof EnvFormatError) throw new EnvironmentVariableError(ENVIRONMENT_VARIABLE_SERVICE_MESSAGES.previewPrefix + e.message);
      throw e;
    }
  }
  return { variables, previewVariables };
}

/** All::deleteRemovedVariables(): the variables whose key the text no longer has go, the generated Compose ones excepted. */
async function deleteRemovedVariables(ctx: EnvironmentVariableContext, resource: Resource, isPreview: boolean, variables: Parsed): Promise<number> {
  const removed = (await ctx.store.list(resource.id, isPreview, "order")).filter((row) => !variables.has(row.key) && !isProtectedEnvironmentVariable(row.key));
  if (removed.length === 0) return 0;
  await ctx.store.delete(removed.map((row) => row.id));
  return removed.length;
}

/**
 * All::updateOrCreateVariables(): every copy of a key that the developer view
 * can edit (not locked, not multiline, a value the format can hold) takes the
 * text's value, its inline comment when it has one, and the flags of its
 * "# coolify:" line; a key without a row is created. Magic variables are left
 * alone. Answers how many rows were written.
 */
async function updateOrCreateVariables(ctx: EnvironmentVariableContext, resource: Resource, isPreview: boolean, variables: Parsed): Promise<number> {
  let count = 0;
  for (const [key, data] of variables) {
    if (isMagicEnvironmentVariable(key)) continue;
    const flags: VariableChanges = {};
    if (data.settings.is_literal !== undefined) flags.isLiteral = data.settings.is_literal;
    if (data.settings.is_buildtime !== undefined) flags.isBuildtime = data.settings.is_buildtime;
    if (data.settings.is_runtime !== undefined) flags.isRuntime = data.settings.is_runtime;
    const copies = await ctx.store.findByKey(resource.id, isPreview, key);
    for (const found of copies) {
      if (found.is_shown_once || found.is_multiline) continue;
      const current = await storedValue(ctx, found);
      if (formatEnvValueForDevView(current) === null) continue;
      const changes: VariableChanges = { ...flags };
      if (current !== data.value) changes.value = data.value;
      if (data.comment !== null && (found.comment ?? null) !== data.comment) changes.comment = data.comment;
      if (await saveVariable(ctx, found, current, changes)) count++;
    }
    if (copies.length === 0) {
      await createVariable(ctx, resource, {
        key,
        value: data.value,
        comment: data.comment,
        order: null,
        isPreview,
        isMultiline: false,
        isLiteral: flags.isLiteral ?? false,
        isRuntime: flags.isRuntime ?? true,
        isBuildtime: flags.isBuildtime ?? true,
        isRequired: false,
        isShownOnce: false,
      });
      count++;
    }
  }
  return count;
}

/** All::updateOrder(): each key's first variable takes the line number of its key in the text. */
async function updateOrder(ctx: EnvironmentVariableContext, resource: Resource, isPreview: boolean, text: string | null): Promise<void> {
  let order = 1;
  for (const key of normalizeEnvironmentVariables(parseEnvFormatToArray(text ?? "")).keys()) {
    const [first] = await ctx.store.findByKey(resource.id, isPreview, key);
    if (first) await saveVariable(ctx, first, await storedValue(ctx, first), { order });
    order++;
  }
}

export interface BulkSaved extends DeveloperView {
  /** 'Environment variables updated.', or null when the text changed nothing. */
  message: string | null;
}

/**
 * All::submit() without $data — the developer view's save — with
 * handleBulkSubmit() and updateOrder(): the production text, then the preview
 * text when the resource shows previews. An error changes nothing: the whole
 * save is one transaction. Null for a resource that is not the org's.
 */
export async function saveDeveloperView(ctx: EnvironmentVariableContext, uuid: string, input: BulkInput): Promise<BulkSaved | null> {
  const resource = await ctx.store.findResource(uuid);
  if (!resource) return null;
  const showPreview = showsPreview(ctx.resourceType, resource);
  const { variables, previewVariables } = parseBulk(input, showPreview);

  let changes = (await deleteRemovedVariables(ctx, resource, false, variables)) + (await updateOrCreateVariables(ctx, resource, false, variables));
  if (showPreview) changes += (await deleteRemovedVariables(ctx, resource, true, previewVariables)) + (await updateOrCreateVariables(ctx, resource, true, previewVariables));

  await updateOrder(ctx, resource, false, input.variables);
  if (showPreview) await updateOrder(ctx, resource, true, input.variablesPreview);

  return { message: changes > 0 ? ENVIRONMENT_VARIABLE_SERVICE_MESSAGES.bulkUpdated : null, ...(await developerViewOf(ctx, resource, true)) };
}
