// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Security/{IntegrationTokens,IntegrationTokenForm,IntegrationTokenEditor}.php
// and app/Policies/IntegrationTokenPolicy.php (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/integration-tokens — Keys & Tokens → Integration Tokens.
//
//   GET    /integration-tokens                       IntegrationTokens::loadTokens(): the org's tokens, latest first, with
//                                                    their zone counts (never a token itself)
//   POST   /integration-tokens                       IntegrationTokenForm::addToken { provider, name, token, capabilities,
//                                                    metadata, automaticDns, proxiedDns }: the provider is asked first
//   GET    /integration-tokens/{uuid}                IntegrationTokenEditor::mount(): the fields, the settings and the zones
//   PATCH  /integration-tokens/{uuid}                IntegrationTokenEditor::save { name, newToken, capabilities, metadata,
//                                                    automaticDns, proxiedDns }
//   DELETE /integration-tokens/{uuid}                IntegrationTokenEditor::delete (deletionBlocker() refuses with 409)
//   POST   /integration-tokens/{uuid}/refresh-zones  IntegrationTokenEditor::refreshZones
//
// Coolify's policy: every ability is a team admin's. Here, as the cloud tokens port does: deploy.resource.read for the
// list and the editor (never a secret), deploy.resource.write for the rest, asking a provider included; asked of
// policy-worker after membership-worker's facts; a denial answers 404 and runs nothing. A failure Coolify reports with
// dispatch('error', …) is an error whose message is the toast; a validation failure is the fields' messages.
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  deleteIntegrationToken,
  findIntegrationTokenByUuid,
  insertIntegrationToken,
  integrationTokenUsage,
  listIntegrationTokens,
  listIntegrationTokenZones,
  syncIntegrationTokenZones,
  updateIntegrationToken,
  type DeployIntegrationTokenWithSecretRow,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse, validationError } from "../http.js";
import type { KeyCipher } from "../private-keys/service.js";
import { authorizeDeploy, columnCipher, readJson } from "./cloud-tokens.js";
import { newPublicId } from "../helpers/names.js";
import { validateRules, type Rules } from "../api-v1/rules.js";
import type { Errors } from "../api-v1/request.js";
import type { ProviderNetwork } from "../api-v1/cloud-providers.js";
import { dohResolver, type HostResolver } from "../s3-storages/safe-url.js";
import { safeExternalUrlMessage } from "../api-v1/server-settings.js";
import { INTEGRATION_PROVIDER_MESSAGES, ProviderConnectionError, ProviderRejectedError, TokenValidationException, fetchCloudflareZones, providerName, type BaseUrlCheck } from "../integration-tokens/providers.js";
import {
  INTEGRATION_TOKEN_MESSAGES,
  automaticDnsEnabled,
  capabilitiesOf,
  componentMessages,
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

const COLUMN = "integration_tokens.token";
const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

/** One org's transaction and the token column's cipher. */
export interface IntegrationTokenScope {
  tx: SqlExecutor;
  orgId: string;
  cipher: KeyCipher;
}

/** Runs fn in one transaction confined to the org; replaceable for tests. */
export type IntegrationTokenRunner = <T>(env: Env, orgId: string, fn: (scope: IntegrationTokenScope) => Promise<T>) => Promise<T>;

export const runIntegrationTokensInOrg: IntegrationTokenRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => fn({ tx, orgId, cipher: columnCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, COLUMN) }));
  } finally {
    await db.dispose();
  }
};

/** What the providers are asked with: the fetch, the resolver SafeExternalUrl uses, and the clock of zones_synced_at. */
export interface IntegrationTokenNetwork extends ProviderNetwork {
  resolve: HostResolver;
}

const DEFAULT_NETWORK: IntegrationTokenNetwork = { fetch: (input, init) => fetch(input, init), sleep: (ms) => new Promise((done) => setTimeout(done, ms)), resolve: dohResolver };

/** A failure Coolify reports through dispatch('error'). */
class ToastError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
  }
}

export interface IntegrationTokenListItem {
  uuid: string;
  name: string;
  provider: string;
  /** $savedToken->providerName() */
  providerName: string;
  capabilities: unknown[];
  /** automaticDnsEnabled(): the Auto DNS badge of a Cloudflare token. */
  automaticDns: boolean;
  /** withCount('dnsZones') */
  dnsZonesCount: number;
}

export interface IntegrationTokenZone {
  id: number;
  name: string;
  accountName: string | null;
  managedRecordsCount: number;
}

export interface IntegrationTokenDetail extends IntegrationTokenListItem {
  /** The editor's settings (base URL, client ID, namespace, timeout; a Cloudflare token's system keys). */
  metadata: Metadata;
  proxiedDns: boolean;
  zones: IntegrationTokenZone[];
  /** data_get($integrationToken->metadata, 'zones_synced_at') */
  zonesSyncedAt: string | null;
  canUpdate: boolean;
}

function listItem(row: { uuid: string; name: string; provider: string; capabilities: string; metadata: string | null; dns_zones_count: string | number }): IntegrationTokenListItem {
  const metadata = metadataOf(row.metadata);
  return {
    uuid: row.uuid,
    name: row.name,
    provider: row.provider,
    providerName: providerName(row.provider),
    capabilities: capabilitiesOf(row.capabilities),
    automaticDns: automaticDnsEnabled(row.provider, metadata),
    dnsZonesCount: Number(row.dns_zones_count),
  };
}

async function detail(scope: IntegrationTokenScope, row: DeployIntegrationTokenWithSecretRow, canUpdate: boolean): Promise<IntegrationTokenDetail> {
  const metadata = metadataOf(row.metadata);
  const zones = (await listIntegrationTokenZones(scope.tx, row.id)).map((z) => ({ id: Number(z.id), name: z.name, accountName: z.account_name, managedRecordsCount: Number(z.managed_records_count) }));
  const synced = metadata.zones_synced_at;
  return { ...listItem(row), metadata, proxiedDns: proxiedDnsEnabled(row.provider, metadata), zones, zonesSyncedAt: typeof synced === "string" ? synced : null, canUpdate };
}

/** validated()'s metadata: only the settings the rules name, as the form holds them. */
function ruledMetadata(provider: string, metadata: unknown): Metadata {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const keys = provider === "infisical" ? ["base_url", "client_id", "timeout"] : provider === "vault" ? ["base_url", "namespace", "timeout"] : [];
  const m = metadata as Metadata;
  return Object.fromEntries(keys.filter((k) => Object.hasOwn(m, k)).map((k) => [k, m[k]]));
}

const RULE_OPTIONS = { laravelMessages: true, laravelWildcards: true, nestedDisplay: true, emptyStringsAbsent: true } as const;
const fields = (errors: Errors): Record<string, string[]> => Object.fromEntries(errors);
/** The ValidationException's message (handleError()): its first message, with Laravel's "(and N more error)". */
function summary(e: TokenValidationException): string {
  const all = Object.values(e.errors).flat();
  const more = all.length - 1;
  return more > 0 ? `${all[0]} (and ${more} more ${more === 1 ? "error" : "errors"})` : (all[0] ?? "");
}

/**
 * segments: what follows /integration-tokens, split on "/" ([] for the collection). `runner` and `net` are replaceable for
 * tests.
 */
export async function handleIntegrationTokens(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segments: string[],
  request: Request,
  runner: IntegrationTokenRunner = runIntegrationTokensInOrg,
  net: IntegrationTokenNetwork = DEFAULT_NETWORK,
): Promise<Response> {
  const method = request.method;
  const [first, second] = segments;
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  type Op = { write: boolean; run: (canWrite: boolean) => Promise<Response> };
  let op: Op | null = null;

  if (segments.length === 0) {
    if (method === "GET") op = { write: false, run: list };
    else if (method === "POST") op = { write: true, run: create };
  } else if (segments.length === 1 && UUID_RE.test(first!)) {
    if (method === "GET") op = { write: false, run: (canWrite) => show(first!, canWrite) };
    else if (method === "PATCH") op = { write: true, run: () => save(first!) };
    else if (method === "DELETE") op = { write: true, run: () => remove(first!) };
  } else if (segments.length === 2 && UUID_RE.test(first!) && second === "refresh-zones") {
    if (method === "POST") op = { write: true, run: () => refreshZones(first!) };
  } else {
    return notFound();
  }
  if (!op) return methodNotAllowed(requestId);

  /** SafeExternalUrl on base_url, its private-target message pointing to the console's Advanced settings. */
  const checkUrl: BaseUrlCheck = (url) => safeExternalUrlMessage({ env }, url, "base_url", net.resolve);
  const now = () => (net.now ?? (() => new Date()))();

  /** handleError() and the ConnectionException catch: the toast a provider's failure shows. */
  function providerToast(e: unknown, provider: string): never {
    if (e instanceof ProviderConnectionError) throw new ToastError(INTEGRATION_PROVIDER_MESSAGES.connection(provider), 502);
    if (e instanceof ProviderRejectedError) throw new ToastError(e.message);
    if (e instanceof TokenValidationException) throw new ToastError(summary(e));
    throw e;
  }

  async function list(canWrite: boolean): Promise<Response> {
    const tokens = await runner(env, orgId, async (s) => (await listIntegrationTokens(s.tx)).map(listItem));
    return successResponse({ tokens, canWrite }, requestId);
  }

  async function create(): Promise<Response> {
    const body = await readJson(request);
    const provider = typeof body.provider === "string" ? body.provider : "";
    const data: Record<string, unknown> = {
      provider: body.provider ?? "",
      name: body.name ?? "",
      token: body.token ?? "",
      capabilities: body.capabilities ?? [],
      metadata: body.metadata ?? {},
      automaticDns: body.automaticDns ?? true,
      proxiedDns: body.proxiedDns ?? false,
    };
    const { head, wildcard } = tokenRules(provider);
    const errors: Errors = [];
    await validateRules(errors, data, [...head, ["automaticDns", ["boolean"]], ["proxiedDns", ["boolean"]], ...wildcard], { ...RULE_OPTIONS, messages: componentMessages(false) });
    if (errors.length) return validationError(requestId, fields(errors));
    const capabilities = (data.capabilities as unknown[]).map(String);
    const metadata = ruledMetadata(provider, data.metadata);
    let prepared;
    try {
      prepared = await prepareCreate(net, checkUrl, { provider, name: data.name as string, token: data.token as string, capabilities, metadata, automaticDns: data.automaticDns === true, proxiedDns: data.proxiedDns === true });
    } catch (e) {
      providerToast(e, provider);
    }
    const uuid = newPublicId();
    await runner(env, orgId, async (s) => {
      const row = await insertIntegrationToken(s.tx, {
        orgId: s.orgId,
        uuid,
        provider,
        name: data.name as string,
        token: await s.cipher.encrypt(data.token as string),
        capabilities: JSON.stringify(capabilities),
        metadata: prepared.metadata === null ? null : JSON.stringify(prepared.metadata),
      });
      if (prepared.zones) await syncIntegrationTokenZones(s.tx, s.orgId, row.id, prepared.zones, newPublicId, JSON.stringify(syncedMetadata(prepared.metadata, now())));
    });
    return successResponse({ uuid, message: INTEGRATION_TOKEN_MESSAGES.added }, requestId, 201);
  }

  async function show(uuid: string, canWrite: boolean): Promise<Response> {
    const token = await runner(env, orgId, async (s) => {
      const row = await findIntegrationTokenByUuid(s.tx, uuid);
      return row ? detail(s, row, canWrite) : null;
    });
    return token ? successResponse(token, requestId) : notFound();
  }

  async function save(uuid: string): Promise<Response> {
    const found = await runner(env, orgId, async (s) => {
      const row = await findIntegrationTokenByUuid(s.tx, uuid);
      return row ? { row, secret: await s.cipher.decrypt(row.token) } : null;
    });
    if (!found) return notFound();
    const { row, secret } = found;
    const body = await readJson(request);
    const data: Record<string, unknown> = {
      name: body.name ?? "",
      newToken: body.newToken ?? "",
      capabilities: body.capabilities ?? [],
      metadata: body.metadata ?? {},
      automaticDns: body.automaticDns ?? automaticDnsEnabled(row.provider, metadataOf(row.metadata)),
      proxiedDns: body.proxiedDns ?? proxiedDnsEnabled(row.provider, metadataOf(row.metadata)),
    };
    // IntegrationTokenEditor::rules(): name first, the update rules with newToken in token's place, the two settings.
    const { head, wildcard } = tokenRules(row.provider, true);
    const tokenRule = head.find(([k]) => k === "token")![1];
    const rules: Rules = [["name", ["required", "string", "max:255"]], ...head.filter(([k]) => k !== "name" && k !== "token"), ["newToken", tokenRule], ["automaticDns", ["boolean"]], ["proxiedDns", ["boolean"]], ...wildcard];
    const errors: Errors = [];
    await validateRules(errors, data, rules, { ...RULE_OPTIONS, messages: componentMessages(true) });
    if (errors.length) return validationError(requestId, fields(errors));
    const storedMetadata = decodeJson(row.metadata);
    let prepared;
    try {
      prepared = await prepareUpdate(
        net,
        checkUrl,
        { provider: row.provider, name: row.name, capabilities: capabilitiesOf(row.capabilities), metadata: storedMetadata !== null && typeof storedMetadata === "object" && !Array.isArray(storedMetadata) ? (storedMetadata as Metadata) : null, token: secret },
        {
          name: data.name as string,
          newToken: typeof data.newToken === "string" && data.newToken !== "" ? data.newToken : null,
          capabilities: (data.capabilities as unknown[]).map(String),
          metadata: ruledMetadata(row.provider, data.metadata),
          automaticDns: data.automaticDns === true,
          proxiedDns: data.proxiedDns === true,
        },
      );
    } catch (e) {
      // catch (ValidationException $e): $this->addError('newToken', $e->validator->errors()->first('token')).
      if (e instanceof TokenValidationException) return validationError(requestId, { newToken: [e.errors.token?.[0] ?? ""] });
      providerToast(e, row.provider);
    }
    const token = await runner(env, orgId, async (s) => {
      const { changes } = prepared;
      await updateIntegrationToken(s.tx, row.id, {
        ...(changes.name !== undefined && { name: changes.name }),
        ...(changes.token !== undefined && { token: await s.cipher.encrypt(changes.token) }),
        ...(changes.capabilities !== undefined && { capabilities: JSON.stringify(changes.capabilities) }),
        ...(changes.metadata !== undefined && { metadata: changes.metadata === null ? null : JSON.stringify(changes.metadata) }),
      });
      if (prepared.zones) await syncIntegrationTokenZones(s.tx, s.orgId, row.id, prepared.zones, newPublicId, JSON.stringify(syncedMetadata(prepared.metadata, now())));
      const fresh = await findIntegrationTokenByUuid(s.tx, uuid);
      return fresh ? detail(s, fresh, true) : null;
    });
    if (!token) return notFound();
    return successResponse({ token, message: INTEGRATION_TOKEN_MESSAGES.updated }, requestId);
  }

  async function remove(uuid: string): Promise<Response> {
    const deleted = await runner(env, orgId, async (s) => {
      const row = await findIntegrationTokenByUuid(s.tx, uuid);
      if (!row) return false;
      const blocker = deletionBlocker(await integrationTokenUsage(s.tx, row.id));
      if (blocker) throw new ToastError(blocker, 409);
      return deleteIntegrationToken(s.tx, row.id);
    });
    if (!deleted) return notFound();
    return successResponse({ deleted: true, uuid, message: INTEGRATION_TOKEN_MESSAGES.deleted }, requestId);
  }

  async function refreshZones(uuid: string): Promise<Response> {
    const found = await runner(env, orgId, async (s) => {
      const row = await findIntegrationTokenByUuid(s.tx, uuid);
      return row ? { row, secret: await s.cipher.decrypt(row.token) } : null;
    });
    if (!found) return notFound();
    // The button is a Cloudflare DNS token's; CloudflareDnsProvider would ask Cloudflare with any token.
    if (found.row.provider !== "cloudflare") throw new ToastError(INTEGRATION_TOKEN_MESSAGES.notCloudflare);
    let zones;
    try {
      zones = await fetchCloudflareZones(net, found.secret);
    } catch (e) {
      // handleError(): the exception's own message (a transfer error's too).
      throw new ToastError(e instanceof Error ? e.message : String(e), e instanceof ProviderConnectionError ? 502 : 422);
    }
    const token = await runner(env, orgId, async (s) => {
      const metadata = decodeJson(found.row.metadata);
      await syncIntegrationTokenZones(s.tx, s.orgId, found.row.id, zones, newPublicId, JSON.stringify(syncedMetadata(metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Metadata) : null, now())));
      const fresh = await findIntegrationTokenByUuid(s.tx, uuid);
      return fresh ? detail(s, fresh, true) : null;
    });
    if (!token) return notFound();
    return successResponse({ token, message: INTEGRATION_TOKEN_MESSAGES.zonesRefreshed(token.zones.length) }, requestId);
  }

  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;
  try {
    return await op.run(auth.canWrite);
  } catch (e) {
    if (e instanceof ToastError) return errorResponse(e.status === 409 ? "conflict" : e.status === 502 ? "provider_unreachable" : "validation_failed", e.message, e.status, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}
