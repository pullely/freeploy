// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/IntegrationTokensController.php (index, show, store,
// update, destroy, syncZones, findToken, connectionErrorResponse, tokenData), app/Policies/IntegrationTokenPolicy.php and
// app/Exceptions/Handler.php (a ValidationException under api/*) (Apache-2.0), modified.
//
// Coolify's /api/v1/security/integration-tokens (DP-104), on the rows the console's Integration Tokens page writes
// (packages/db's deploy/integration-tokens.ts, the token encrypted with the org's key under the column context
// "integration_tokens.token"). Every ability of IntegrationTokenPolicy is a team admin's, so each is policy-worker's
// deploy.resource.write, asked where the controller authorizes: before anything is read for the list and a create, after
// the token is found otherwise. The secret and the settings (a base URL can carry credentials) are never answered. The
// provider is asked through the context's fetch (providers.ts), outside the org's transaction.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { deleteIntegrationToken, findIntegrationTokenByUuid, insertIntegrationToken, integrationTokenUsage, listIntegrationTokens, syncIntegrationTokenZones, updateIntegrationToken, type DeployIntegrationTokenRow, type DeployIntegrationTokenWithSecretRow } from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, fromJs, laravelDate, obj, type CoolifyAnswer, type PhpObject, type PhpValue } from "@saas/contracts/coolify-api";
import { columnCipher } from "../handlers/cloud-tokens.js";
import { utcIso } from "../cloud-tokens/service.js";
import { newPublicId } from "../helpers/names.js";
import { message, type ApiV1Context } from "./context.js";
import { addError, errorsObject, extraFields, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rules } from "./rules.js";
import { safeExternalUrlMessage } from "./server-settings.js";
import { INTEGRATION_PROVIDER_MESSAGES, ProviderConnectionError, ProviderRejectedError, TokenValidationException, fetchCloudflareZones, type BaseUrlCheck } from "../integration-tokens/providers.js";
import {
  INTEGRATION_TOKEN_MESSAGES,
  automaticDnsEnabled,
  capabilitiesOf,
  decodeJson,
  deletionBlocker,
  metadataOf,
  prepareCreate,
  prepareUpdate,
  proxiedDnsEnabled,
  syncedMetadata,
  tokenRules,
  type Metadata,
} from "../integration-tokens/service.js";

export const INTEGRATION_TOKEN_COLUMN = "integration_tokens.token";
const cipher = (tx: SqlExecutor, c: ApiV1Context) => columnCipher(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, INTEGRATION_TOKEN_COLUMN);
const denied = async (c: ApiV1Context): Promise<CoolifyAnswer | null> => ((await c.allows(true)) ? null : COOLIFY_API.unauthorized());
const notFound = () => message(INTEGRATION_TOKEN_MESSAGES.apiNotFound, 404);
const nowOf = (c: ApiV1Context): Date => (c.providers.now ?? (() => new Date()))();
const checkUrl = (c: ApiV1Context): BaseUrlCheck => (url) => safeExternalUrlMessage(c, url, "base_url", c.s3.resolve);

/** routes/api.php's /security/integration-tokens routes; null for every other path (the caller answers the fallback 404). */
export async function integrationTokensApi(c: ApiV1Context, segments: string[]): Promise<CoolifyAnswer | null> {
  const [uuid, sub, extra] = segments;
  const m = c.method;
  if (extra !== undefined) return null;
  if (uuid === undefined) return m === "GET" ? list(c) : m === "POST" ? store(c) : null;
  if (sub === undefined) return m === "GET" ? show(c, uuid) : m === "PATCH" ? update(c, uuid) : m === "DELETE" ? destroy(c, uuid) : null;
  return sub === "sync-zones" && m === "POST" ? syncZones(c, uuid) : null;
}

/** tokenData(): the fields that are safe to return; Cloudflare's settings, zone count and last sync for a Cloudflare token. */
function tokenData(row: DeployIntegrationTokenRow): PhpObject {
  const metadata = metadataOf(row.metadata);
  const entries: Array<[string, PhpValue]> = [
    ["uuid", row.uuid],
    ["name", row.name],
    ["provider", row.provider],
    ["capabilities", fromJs(decodeJson(row.capabilities) ?? [])],
  ];
  if (row.provider === "cloudflare") {
    entries.push(
      ["automatic_dns", automaticDnsEnabled(row.provider, metadata)],
      ["proxied_dns", proxiedDnsEnabled(row.provider, metadata)],
      ["dns_zones_count", Number(row.dns_zones_count)],
      ["zones_synced_at", fromJs(metadata.zones_synced_at ?? null)],
    );
  }
  entries.push(["created_at", laravelDate(utcIso(row.created_at))], ["updated_at", laravelDate(utcIso(row.updated_at))]);
  return obj(entries);
}

/** The exception handler's answer to an uncaught ValidationException: its summary and the errors. */
function uncaughtValidation(e: TokenValidationException): CoolifyAnswer {
  const all = Object.values(e.errors).flat();
  const more = all.length - 1;
  const summary = more > 0 ? `${all[0]} (and ${more} more ${more === 1 ? "error" : "errors"})` : (all[0] ?? "");
  return coolifyJson(obj({ message: summary, errors: obj(Object.entries(e.errors).map(([k, v]): [string, PhpValue] => [k, v])) }), 422);
}

/** catch (ConnectionException) / catch (RuntimeException): 502 with connectionErrorMessage(), 400 with the message. */
function providerFailure(e: unknown, provider: string): CoolifyAnswer {
  if (e instanceof ProviderConnectionError) return message(INTEGRATION_PROVIDER_MESSAGES.connection(provider), 502);
  if (e instanceof ProviderRejectedError) return message(e.message, 400);
  throw e;
}

/** findToken(): the org's token by the route's uuid (row-level security confines it to the org). */
const findToken = (tx: SqlExecutor, uuid: string): Promise<DeployIntegrationTokenWithSecretRow | null> => findIntegrationTokenByUuid(tx, uuid);

async function list(c: ApiV1Context): Promise<CoolifyAnswer> {
  const no = await denied(c);
  if (no) return no;
  return c.sql(c.env, c.orgId, async (tx) => coolifyJson((await listIntegrationTokens(tx)).map(tokenData)));
}

async function show(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const row = await findToken(tx, uuid);
    if (!row) return notFound();
    return (await denied(c)) ?? coolifyJson(tokenData(row));
  });
}

/** The cleaned JSON body's value of a boolean the validator accepted, as PHP passes it to a bool parameter. */
const asBool = (v: unknown): boolean => !(v === null || v === undefined || v === false || v === 0 || v === "0" || v === "");
const isArrayValue = (v: unknown): v is Record<string, unknown> | unknown[] => v !== null && typeof v === "object";
/** array_values(array_unique($capabilities)) */
const unique = (v: unknown): string[] => [...new Set((Array.isArray(v) ? v : isArrayValue(v) ? Object.values(v) : []).map((x) => String(x)))];
/** metadata, automatic_dns and proxied_dns: prohibited on the other kind of provider. */
const flagRules = (cloudflare: boolean): Rules => [
  ["metadata", cloudflare ? ["prohibited"] : ["sometimes", "array"]],
  ["automatic_dns", cloudflare ? ["sometimes", "boolean"] : ["prohibited"]],
  ["proxied_dns", cloudflare ? ["sometimes", "boolean"] : ["prohibited"]],
];
const RULE_OPTIONS = { laravelWildcards: true, nestedDisplay: true } as const;

async function store(c: ApiV1Context): Promise<CoolifyAnswer> {
  // $this->authorize('create', IntegrationToken::class) before the body is read.
  const no = await denied(c);
  if (no) return no;
  const read = await readApiBody(c.request);
  if (read.incomingError) return read.incomingError;
  const body: Record<string, unknown> = { ...read.all };
  const provider = typeof body.provider === "string" ? body.provider : "";
  const cloudflare = provider === "cloudflare";
  if (body.capabilities === undefined || body.capabilities === null) body.capabilities = cloudflare ? ["dns"] : ["secrets"];
  const { head, wildcard } = tokenRules(provider);
  const errors: Errors = [];
  await validateRules(errors, body, [...head, ...flagRules(cloudflare), ...wildcard], RULE_OPTIONS);
  extraFields(errors, body, ["provider", "name", "token", "capabilities", "automatic_dns", "proxied_dns", "metadata"]);
  if (errors.length) return validationFailed(errors);
  let prepared;
  try {
    prepared = await prepareCreate(c.providers, checkUrl(c), {
      provider,
      name: body.name as string,
      token: body.token as string,
      capabilities: unique(body.capabilities),
      metadata: isArrayValue(body.metadata) ? ({ ...body.metadata } as Metadata) : {},
      automaticDns: body.automatic_dns === undefined ? true : asBool(body.automatic_dns),
      proxiedDns: body.proxied_dns === undefined ? false : asBool(body.proxied_dns),
    });
  } catch (e) {
    // InfisicalService's and VaultService's SafeExternalUrl: a ValidationException the controller does not catch.
    if (e instanceof TokenValidationException) return uncaughtValidation(e);
    return providerFailure(e, provider);
  }
  const uuid = newPublicId();
  await c.sql(c.env, c.orgId, async (tx) => {
    const row = await insertIntegrationToken(tx, {
      orgId: c.orgId,
      uuid,
      provider,
      name: body.name as string,
      token: await cipher(tx, c).encrypt(body.token as string),
      capabilities: JSON.stringify(unique(body.capabilities)),
      metadata: prepared.metadata === null ? null : JSON.stringify(prepared.metadata),
    });
    if (prepared.zones) await syncIntegrationTokenZones(tx, c.orgId, row.id, prepared.zones, newPublicId, JSON.stringify(syncedMetadata(prepared.metadata, nowOf(c))));
  });
  return coolifyJson(obj({ uuid }), 201);
}

async function update(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const found = await c.sql(c.env, c.orgId, async (tx) => {
    const row = await findToken(tx, uuid);
    if (!row) return { answer: notFound() };
    const no = await denied(c);
    if (no) return { answer: no };
    return { row, secret: await cipher(tx, c).decrypt(row.token) };
  });
  if ("answer" in found) return found.answer;
  const { row, secret } = found;
  const read = await readApiBody(c.request);
  if (read.incomingError) return read.incomingError;
  const body = read.all;
  const cloudflare = row.provider === "cloudflare";
  const storedMetadata = metadataOf(row.metadata);
  const metadataColumn = decodeJson(row.metadata);
  const merged: Record<string, unknown> = {
    name: body.name ?? row.name,
    token: body.token ?? null,
    capabilities: body.capabilities ?? capabilitiesOf(row.capabilities),
    // array_merge($storedMetadata, $body['metadata']): string keys replaced in place, new ones appended.
    metadata: isArrayValue(body.metadata) ? { ...storedMetadata, ...(body.metadata as Record<string, unknown>) } : storedMetadata,
  };
  const { head, wildcard } = tokenRules(row.provider, true);
  const errors: Errors = [];
  await validateRules(errors, merged, [...head, ...wildcard], RULE_OPTIONS);
  const flags: Errors = [];
  await validateRules(flags, body, flagRules(cloudflare), RULE_OPTIONS);
  // $errors->merge($flags->errors()): a key's messages appended, a new key after.
  for (const [k, v] of flags) for (const text of v) addError(errors, k, text);
  extraFields(errors, body, ["name", "token", "capabilities", "automatic_dns", "proxied_dns", "metadata"]);
  if (errors.length) return validationFailed(errors);
  let prepared;
  try {
    prepared = await prepareUpdate(
      c.providers,
      checkUrl(c),
      { provider: row.provider, name: row.name, capabilities: capabilitiesOf(row.capabilities), metadata: metadataColumn !== null && typeof metadataColumn === "object" && !Array.isArray(metadataColumn) ? storedMetadata : null, token: secret },
      {
        name: merged.name as string,
        newToken: typeof merged.token === "string" ? merged.token : null,
        capabilities: unique(merged.capabilities),
        metadata: merged.metadata as Metadata,
        automaticDns: body.automatic_dns === undefined || body.automatic_dns === null ? automaticDnsEnabled(row.provider, storedMetadata) : asBool(body.automatic_dns),
        proxiedDns: body.proxied_dns === undefined || body.proxied_dns === null ? proxiedDnsEnabled(row.provider, storedMetadata) : asBool(body.proxied_dns),
      },
    );
  } catch (e) {
    // UpdateIntegrationToken's own ValidationException, and SafeExternalUrl's: caught, "Validation failed.".
    if (e instanceof TokenValidationException) return coolifyJson(obj({ message: "Validation failed.", errors: errorsObject(Object.entries(e.errors)) }), 422);
    return providerFailure(e, row.provider);
  }
  return c.sql(c.env, c.orgId, async (tx) => {
    const { changes } = prepared;
    await updateIntegrationToken(tx, row.id, {
      ...(changes.name !== undefined && { name: changes.name }),
      ...(changes.token !== undefined && { token: await cipher(tx, c).encrypt(changes.token) }),
      ...(changes.capabilities !== undefined && { capabilities: JSON.stringify(changes.capabilities) }),
      ...(changes.metadata !== undefined && { metadata: changes.metadata === null ? null : JSON.stringify(changes.metadata) }),
    });
    if (prepared.zones) await syncIntegrationTokenZones(tx, c.orgId, row.id, prepared.zones, newPublicId, JSON.stringify(syncedMetadata(prepared.metadata, nowOf(c))));
    const fresh = await findToken(tx, uuid);
    return fresh ? coolifyJson(tokenData(fresh)) : notFound();
  });
}

async function destroy(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const row = await findToken(tx, uuid);
    if (!row) return notFound();
    const no = await denied(c);
    if (no) return no;
    const blocker = deletionBlocker(await integrationTokenUsage(tx, row.id));
    if (blocker) return message(blocker, 409);
    await deleteIntegrationToken(tx, row.id);
    return message(INTEGRATION_TOKEN_MESSAGES.apiDeleted, 200);
  });
}

async function syncZones(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const found = await c.sql(c.env, c.orgId, async (tx) => {
    const row = await findToken(tx, uuid);
    if (!row) return { answer: notFound() };
    const no = await denied(c);
    if (no) return { answer: no };
    if (row.provider !== "cloudflare") return { answer: message(INTEGRATION_TOKEN_MESSAGES.notCloudflare, 422) };
    return { row, secret: await cipher(tx, c).decrypt(row.token) };
  });
  if ("answer" in found) return found.answer;
  let zones;
  try {
    zones = await fetchCloudflareZones(c.providers, found.secret);
  } catch (e) {
    return providerFailure(e, "cloudflare");
  }
  const metadata = decodeJson(found.row.metadata);
  await c.sql(c.env, c.orgId, (tx) => syncIntegrationTokenZones(tx, c.orgId, found.row.id, zones, newPublicId, JSON.stringify(syncedMetadata(metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Metadata) : null, nowOf(c)))));
  return coolifyJson(obj({ zones_count: zones.length }));
}
