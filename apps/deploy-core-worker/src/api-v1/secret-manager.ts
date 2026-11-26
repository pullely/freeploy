// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/SecretManagerController.php (show, update, destroy, keys,
// addReference, import, findResource, sourceLink, noSourceResponse, sourceData, validateBody),
// app/Services/SecretManagers/ResourceSecretManager.php (availableTokens, findToken, settingsRules, link, unlink, keyNames,
// addReference, importAll), app/Models/SecretManagerLink.php (fetchSecrets, importMissingReferences) and
// app/Models/IntegrationToken.php (hasCapability) (Apache-2.0), modified.
//
// Coolify's /api/v1/{applications,services,databases}/{uuid}/secret-manager[/keys|/references|/import] (DP-106): the
// secret manager source of a resource — a Doppler, Infisical or Vault integration token of the org (DP-104's rows, the
// token encrypted with the org's key) and its settings, stored in deploy.secret_manager_links — the key names of its
// secrets, and the {{vault.KEY}} environment variables made from them (the Environment Variables page's createVariable(),
// so an application's variable gets its preview copy). What the controller authorizes is policy-worker's answer:
// authorize('view') is deploy.resource.read, authorize('update') and the Gate useTeamCredentials (write access on the whole
// team, which decides which tokens a resource may read) are deploy.resource.write. The provider is asked through the
// context's fetch (integration-tokens/secret-managers.ts), outside the org's transaction; only key names come back from it,
// and no secret value is stored or answered. A {{vault.KEY}} variable is resolved when a deployment runs; Freeploy's
// deployments run nothing yet, so the variables are only stored here, as Coolify stores them.
//
// Not ported: the audit log lines (`api.<resource>.secret_manager.*`).
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  ENVIRONMENT_VARIABLE_MORPH_CLASS,
  databaseEnvironmentVariableResourceType,
  deleteSecretManagerLink,
  findDatabaseByUuid,
  findSecretManagerLink,
  listSecretManagerTokens,
  saveSecretManagerLink,
  type DeployEnvironmentVariableResourceRow,
  type DeploySecretManagerLinkRow,
  type DeploySecretManagerTokenRow,
  type EnvironmentVariableResourceType,
} from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, isObj, obj, type CoolifyAnswer, type PhpValue } from "@saas/contracts/coolify-api";
import { columnCipher } from "../handlers/cloud-tokens.js";
import { environmentVariableContext } from "../handlers/environment-variables.js";
import { createVariable, type EnvironmentVariableContext } from "../environment-variables/service.js";
import { newPublicId } from "../helpers/names.js";
import { capabilitiesOf, metadataOf } from "../integration-tokens/service.js";
import { ProviderConnectionError, filled } from "../integration-tokens/providers.js";
import { SecretFetchError, dopplerTokenType, fetchSecretKeys, isValidEnvironmentVariableKey, phpSortStrings, referencesToImport } from "../integration-tokens/secret-managers.js";
import { phpJsonDecode } from "./cloud-providers.js";
import { message, UPDATE_DENIED, type ApiV1Context } from "./context.js";
import { INTEGRATION_TOKEN_COLUMN } from "./integration-tokens.js";
import { addError, extraFields, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rules } from "./rules.js";
import { safeExternalUrlMessage } from "./server-settings.js";

export type SecretManagerResourceType = "applications" | "services" | "databases";
export const SECRET_MANAGER_RESOURCE_TYPES: readonly string[] = ["applications", "services", "databases"];

/** Copy shown to the user: Coolify's, word for word. */
export const SECRET_MANAGER_MESSAGES = {
  tokenNotFound: "Secret manager integration token not found.",
  noSource: "The resource has no secret manager source.",
  removed: "Secret manager source removed. Existing {{vault.*}} variables fail the next deployment until they are removed.",
  couldNotFetch: (reason: string) => `Could not fetch keys: ${reason}`,
  notAKey: (key: string) => `${key} is not a key of the secret manager source.`,
  notAVariableName: (key: string) => `${key} is not a valid variable name.`,
  variableExists: (key: string) => `A variable with the key ${key} already exists.`,
} as const;

const KIND = { applications: "application", services: "service", databases: "database" } as const;
const NAME = { applications: "Application", services: "Service", databases: "Database" } as const;

/** The resource of the route: its environment variables' type (the morph class with it), its row and its variables' store. */
interface Found {
  type: EnvironmentVariableResourceType;
  morphClass: string;
  id: string | number;
  ctx: EnvironmentVariableContext;
  resource: DeployEnvironmentVariableResourceRow;
}

/** Application::ownedByCurrentTeamAPI(), Service::whereRelation('environment.project.team'), queryDatabaseByUuidWithinTeam(). */
async function lookup(tx: SqlExecutor, c: ApiV1Context, resourceType: SecretManagerResourceType, uuid: string): Promise<Found | null> {
  let type: EnvironmentVariableResourceType;
  if (resourceType === "applications") type = "application";
  else if (resourceType === "services") type = "service";
  else {
    const db = await findDatabaseByUuid(tx, uuid);
    if (!db) return null;
    type = databaseEnvironmentVariableResourceType(db.engine);
  }
  const ctx = environmentVariableContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, type);
  const resource = await ctx.store.findResource(uuid);
  if (!resource) return null;
  return { type, morphClass: ENVIRONMENT_VARIABLE_MORPH_CLASS[type], id: resource.id, ctx, resource };
}

/** findResource(): the 404 of the resource type, then $this->authorize($ability) (view: read; update: write). */
async function findResource(tx: SqlExecutor, c: ApiV1Context, resourceType: SecretManagerResourceType, uuid: string, write: boolean) {
  const found = await lookup(tx, c, resourceType, uuid);
  if (!found) return { answer: message(`${NAME[resourceType]} not found.`, 404) };
  if (!(await c.allows(write))) return { answer: COOLIFY_API.unauthorized(write ? UPDATE_DENIED[KIND[resourceType]] : undefined) };
  return { found };
}

const cipher = (tx: SqlExecutor, c: ApiV1Context) => columnCipher(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, INTEGRATION_TOKEN_COLUMN);
/** hasCapability('secrets'): in_array($capability, $this->capabilities ?? [], true). */
const hasSecrets = (row: Pick<DeploySecretManagerTokenRow, "capabilities">): boolean => capabilitiesOf(row.capabilities).some((v) => v === "secrets");
/** The settings column as the `array` cast gives it ($link->settings): null, or the decoded JSON. */
const settingsValue = (text: string | null): PhpValue => (text === null ? null : phpJsonDecode(text));
/** The settings as a plain record (data_get() on them). */
function settingsRecord(text: string | null): Record<string, unknown> {
  const v = settingsValue(text);
  return isObj(v) ? Object.fromEntries(v.entries) : {};
}

/** routes/api.php's secret-manager routes of one resource; null for every other path (the fallback 404). */
export async function secretManagerApi(c: ApiV1Context, resourceType: SecretManagerResourceType, uuid: string, segments: string[]): Promise<CoolifyAnswer | null> {
  const [sub, extra] = segments;
  const m = c.method;
  if (extra !== undefined) return null;
  if (sub === undefined) return m === "GET" ? show(c, resourceType, uuid) : m === "PATCH" ? update(c, resourceType, uuid) : m === "DELETE" ? destroy(c, resourceType, uuid) : null;
  if (sub === "keys") return m === "GET" ? keys(c, resourceType, uuid) : null;
  if (sub === "references") return m === "POST" ? addReference(c, resourceType, uuid) : null;
  if (sub === "import") return m === "POST" ? importAll(c, resourceType, uuid) : null;
  return null;
}

async function show(c: ApiV1Context, resourceType: SecretManagerResourceType, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const r = await findResource(tx, c, resourceType, uuid, false);
    if (r.answer) return r.answer;
    const link = await findSecretManagerLink(tx, r.found.morphClass, r.found.id);
    // availableTokens(): the org's secret manager tokens with the secrets capability; without write on the whole team, the linked one only.
    let tokens = await listSecretManagerTokens(tx);
    if (!(await c.allows(true))) tokens = tokens.filter((t) => link !== null && String(t.id) === String(link.integration_token_id));
    return coolifyJson(
      obj({
        linked: link !== null,
        integration_token_uuid: link?.token_uuid ?? null,
        provider: link?.token_provider ?? null,
        settings: link ? settingsValue(link.settings) : null,
        available_tokens: tokens.filter(hasSecrets).map((t) => obj({ uuid: t.uuid, name: t.name, provider: t.provider })),
      }),
    );
  });
}

/** settingsRules(): a Doppler service account's project and config, Infisical's project, environment and path, Vault's mount and path. */
function settingsRules(provider: string, token: string): Rules {
  switch (provider) {
    case "doppler":
      return dopplerTokenType(provider, token) === "service_account"
        ? [
            ["settings.project", ["required", "string"]],
            ["settings.config", ["required", "string"]],
          ]
        : [];
    case "infisical":
      return [
        ["settings.project_id", ["required", "string"]],
        ["settings.environment", ["required", "string"]],
        ["settings.secret_path", ["nullable", "string"]],
      ];
    case "vault":
      return [
        ["settings.mount", ["required", "string"]],
        ["settings.path", ["required", "string"]],
      ];
    default:
      return [];
  }
}

/** validateBody(): customApiValidator() with the rules, then every field the rules do not name ("This field is not allowed."). */
async function validateBody(body: Record<string, unknown>, rules: Rules): Promise<Errors> {
  const errors: Errors = [];
  await validateRules(errors, body, rules, { nestedDisplay: true });
  const allowed = [...new Set(rules.map(([field]) => field.split(".")[0]!))];
  extraFields(errors, body, allowed);
  return errors;
}

async function update(c: ApiV1Context, resourceType: SecretManagerResourceType, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const r = await findResource(tx, c, resourceType, uuid, true);
    if (r.answer) return r.answer;
    const read = await readApiBody(c.request);
    if (read.incomingError) return read.incomingError;
    const body = read.all;
    // findToken(): the org's secret manager token with the secrets capability.
    const tokenUuid = body.integration_token_uuid;
    const token = typeof tokenUuid === "string" ? (await listSecretManagerTokens(tx)).find((t) => t.uuid === tokenUuid && hasSecrets(t)) : undefined;
    if (!token) return message(SECRET_MANAGER_MESSAGES.tokenNotFound, 404);
    const secret = (await cipher(tx, c).decrypt(token.token)) ?? "";
    const rules = settingsRules(token.provider, secret);
    const errors = await validateBody(body, [["integration_token_uuid", ["required", "string"]], ["settings", ["sometimes", "array"]], ...rules]);
    if (errors.length) return validationFailed(errors);
    // $validator->validated()['settings'] (with settings.* rules, only the keys they name, in their order), Arr::only() of
    // those keys, then link()'s array_filter(filled()).
    const given = body.settings !== null && typeof body.settings === "object" ? (body.settings as Record<string, unknown>) : {};
    const entries: Array<[string, unknown]> = [];
    for (const [field] of rules) {
      const key = field.slice("settings.".length);
      if (Object.hasOwn(given, key) && filled(given[key])) entries.push([key, given[key]]);
    }
    // link(): Gate::authorize('useTeamCredentials'), asked by findResource()'s deploy.resource.write already.
    const settings = entries.length ? Object.fromEntries(entries) : null;
    await saveSecretManagerLink(tx, { orgId: c.orgId, uuid: newPublicId(), resourceableType: r.found.morphClass, resourceableId: r.found.id, integrationTokenId: token.id, settings: settings === null ? null : JSON.stringify(settings) });
    return coolifyJson(obj({ integration_token_uuid: token.uuid, provider: token.provider, settings: settings === null ? null : obj(entries as Array<[string, PhpValue]>) }));
  });
}

async function destroy(c: ApiV1Context, resourceType: SecretManagerResourceType, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const r = await findResource(tx, c, resourceType, uuid, true);
    if (r.answer) return r.answer;
    if (!(await findSecretManagerLink(tx, r.found.morphClass, r.found.id))) return message(SECRET_MANAGER_MESSAGES.noSource, 404);
    await deleteSecretManagerLink(tx, r.found.morphClass, r.found.id);
    return message(SECRET_MANAGER_MESSAGES.removed, 200);
  });
}

/** The link of an authorized resource, with its token decrypted: what the provider is asked with, outside the transaction. */
type Source = { link: DeploySecretManagerLinkRow; secret: string };

async function sourceOf(tx: SqlExecutor, c: ApiV1Context, found: Found): Promise<Source | null> {
  const link = await findSecretManagerLink(tx, found.morphClass, found.id);
  if (!link) return null;
  return { link, secret: (await cipher(tx, c).decrypt(link.token_secret)) ?? "" };
}

/** SecretManagerLink::fetchSecrets()'s key names; a failure is the controller's catch (Throwable): its message. */
async function fetchKeys(c: ApiV1Context, source: Source): Promise<{ keys: string[] } | { failure: CoolifyAnswer }> {
  try {
    const keys = await fetchSecretKeys(c.providers, (url) => safeExternalUrlMessage(c, url, "base_url", c.s3.resolve), {
      provider: source.link.token_provider,
      token: source.secret,
      metadata: metadataOf(source.link.token_metadata),
      settings: settingsRecord(source.link.settings),
    });
    return { keys };
  } catch (e) {
    // Coolify's message is the exception's: the provider service's, or cURL's for a transfer that fails (here the fetch's).
    if (e instanceof SecretFetchError || e instanceof ProviderConnectionError) return { failure: message(SECRET_MANAGER_MESSAGES.couldNotFetch(e.message), 400) };
    throw e;
  }
}

async function keys(c: ApiV1Context, resourceType: SecretManagerResourceType, uuid: string): Promise<CoolifyAnswer> {
  const found = await c.sql(c.env, c.orgId, async (tx) => {
    const r = await findResource(tx, c, resourceType, uuid, true);
    if (r.answer) return { answer: r.answer };
    const source = await sourceOf(tx, c, r.found);
    return source ? { source } : { answer: message(SECRET_MANAGER_MESSAGES.noSource, 404) };
  });
  if ("answer" in found) return found.answer;
  const fetched = await fetchKeys(c, found.source);
  if ("failure" in fetched) return fetched.failure;
  // keyNames(): sorted, the values discarded.
  return coolifyJson(obj({ keys: phpSortStrings(fetched.keys) }));
}

/** The {{vault.KEY}} variable of one key: EnvironmentVariable::create(['key', 'value']) with the model's defaults. */
async function createReference(ctx: EnvironmentVariableContext, resource: DeployEnvironmentVariableResourceRow, key: string): Promise<void> {
  await createVariable(ctx, resource, {
    key,
    value: `{{vault.${key}}}`,
    comment: null,
    order: null,
    isPreview: false,
    isLiteral: false,
    isMultiline: false,
    isShownOnce: false,
    isRuntime: true,
    isBuildtime: true,
    isRequired: false,
  });
}

async function addReference(c: ApiV1Context, resourceType: SecretManagerResourceType, uuid: string): Promise<CoolifyAnswer> {
  const found = await c.sql(c.env, c.orgId, async (tx) => {
    const r = await findResource(tx, c, resourceType, uuid, true);
    if (r.answer) return { answer: r.answer };
    const source = await sourceOf(tx, c, r.found);
    if (!source) return { answer: message(SECRET_MANAGER_MESSAGES.noSource, 404) };
    const read = await readApiBody(c.request);
    if (read.incomingError) return { answer: read.incomingError };
    const errors = await validateBody(read.all, [["key", ["required", "string", "max:255"]]]);
    if (errors.length) return { answer: validationFailed(errors) };
    return { source, key: read.all.key as string };
  });
  if ("answer" in found) return found.answer;
  const fetched = await fetchKeys(c, found.source);
  if ("failure" in fetched) return fetched.failure;
  const { key } = found;
  const invalid = (text: string) => {
    const errors: Errors = [];
    addError(errors, "key", text);
    return validationFailed(errors);
  };
  if (!fetched.keys.includes(key)) return invalid(SECRET_MANAGER_MESSAGES.notAKey(key));
  if (!isValidEnvironmentVariableKey(key)) return invalid(SECRET_MANAGER_MESSAGES.notAVariableName(key));
  return c.sql(c.env, c.orgId, async (tx) => {
    const again = await lookup(tx, c, resourceType, uuid);
    if (!again) return message(`${NAME[resourceType]} not found.`, 404);
    if ((await again.ctx.store.findByKey(again.id, false, key)).length > 0) return invalid(SECRET_MANAGER_MESSAGES.variableExists(key));
    await createReference(again.ctx, again.resource, key);
    return coolifyJson(obj({ key, value: `{{vault.${key}}}` }), 201);
  });
}

async function importAll(c: ApiV1Context, resourceType: SecretManagerResourceType, uuid: string): Promise<CoolifyAnswer> {
  const found = await c.sql(c.env, c.orgId, async (tx) => {
    const r = await findResource(tx, c, resourceType, uuid, true);
    if (r.answer) return { answer: r.answer };
    const source = await sourceOf(tx, c, r.found);
    return source ? { source } : { answer: message(SECRET_MANAGER_MESSAGES.noSource, 404) };
  });
  if ("answer" in found) return found.answer;
  const fetched = await fetchKeys(c, found.source);
  if ("failure" in fetched) return fetched.failure;
  return c.sql(c.env, c.orgId, async (tx) => {
    const again = await lookup(tx, c, resourceType, uuid);
    if (!again) return message(`${NAME[resourceType]} not found.`, 404);
    // importMissingReferences(): $resource->environment_variables()->pluck('key') (an application's production ones).
    const existing = new Set((await again.ctx.store.list(again.id, false, "order")).map((v) => String(v.key)));
    const result = referencesToImport(fetched.keys, existing);
    for (const key of result.imported) {
      await createReference(again.ctx, again.resource, key);
      existing.add(key);
    }
    return coolifyJson(obj({ imported: result.imported, skipped: result.skipped }));
  });
}
