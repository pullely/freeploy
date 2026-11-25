// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Security/{CloudTokens,CloudProviderTokens,CloudProviderTokenForm}.php,
// app/Livewire/Security/CloudProviderToken/Show.php, app/Livewire/Server/CloudProviderToken/Show.php
// and app/Policies/CloudProviderTokenPolicy.php (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/cloud-tokens — Keys & Tokens → Cloud Tokens.
//
//   GET    /cloud-tokens                     CloudProviderTokens: the org's tokens (never the token itself)
//   POST   /cloud-tokens                     CloudProviderTokenForm::addToken { provider, token, name, description }:
//                                            the provider is asked first, then the token is stored
//   GET    /cloud-tokens/{uuid}              CloudProviderToken\Show
//   PATCH  /cloud-tokens/{uuid}              Show::save { name, description }
//   DELETE /cloud-tokens/{uuid}              Show::delete / deleteToken (no body: the edge does not forward one)
//   POST   /cloud-tokens/{uuid}/validate     validateToken → { valid, message }
//
// and, routed here by handleServers (servers.ts), a server's Cloud Token page:
//
//   GET    /servers/{uuid}/cloud-provider-token            Server\CloudProviderToken\Show
//   PATCH  /servers/{uuid}/cloud-provider-token            setCloudProviderToken { cloud_provider_token_uuid }
//   POST   /servers/{uuid}/cloud-provider-token/validate   validateToken → { valid, message }
//
// Coolify's policy: every ability is team admin. Here: deploy.resource.read
// for the lists and pages (never a secret) and deploy.resource.write for the
// rest, asking a provider with a stored token included; asked of policy-worker
// after membership-worker's facts; a denial answers 404 (never leaks).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  loadKek,
  orgDek,
  encryptField,
  decryptField,
  listCloudProviderTokens,
  findCloudProviderTokenByUuid,
  findCloudProviderTokenById,
  insertCloudProviderToken,
  updateCloudProviderToken,
  deleteCloudProviderToken,
  cloudProviderTokenServerCount,
  findServerByUuid,
  findServerCloud,
  setServerCloudProviderToken,
  type OrgDek,
} from "@saas/db/deploy";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy, type AuthorizeResult } from "../policy-client.js";
import { deniedResponse, errorResponse, methodNotAllowed, successResponse, validationError } from "../http.js";
import type { KeyCipher } from "../private-keys/service.js";
import { providerFetch, validateNewToken, validateServerToken, validateStoredToken, validateTokenForServer, type ProviderHttp } from "../cloud-tokens/providers.js";
import { validateCreateToken, validateUpdateToken } from "../cloud-tokens/validation.js";
import {
  assignServerToken,
  chooseServerToken,
  CLOUD_TOKEN_MESSAGES,
  CloudTokenError,
  cloudTokenSecret,
  deleteCloudToken,
  listCloudTokens,
  serverCloudTokenPage,
  serverTokenSecret,
  showCloudToken,
  storeCloudToken,
  updateCloudToken,
  validationResult,
  type CloudTokenContext,
  type CloudTokenStore,
} from "../cloud-tokens/service.js";

const COLUMN = "cloud_provider_tokens.token";
const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

/** Runs fn with one org's token store and cipher, in one transaction confined to that org. */
export type CloudTokenRunner = <T>(env: Env, orgId: string, fn: (ctx: CloudTokenContext) => Promise<T>) => Promise<T>;

function sqlStore(tx: SqlExecutor, orgId: string): CloudTokenStore {
  return {
    list: (provider) => listCloudProviderTokens(tx, provider),
    findByUuid: (uuid) => findCloudProviderTokenByUuid(tx, uuid),
    findById: (id) => findCloudProviderTokenById(tx, id),
    insert: (token) => insertCloudProviderToken(tx, { ...token, orgId }),
    update: (id, changes) => updateCloudProviderToken(tx, id, changes),
    delete: (id) => deleteCloudProviderToken(tx, id),
    serverCount: (id) => cloudProviderTokenServerCount(tx, id),
    findServer: (uuid) => findServerByUuid(tx, uuid),
    findServerCloud: (uuid) => findServerCloud(tx, uuid),
    setServerToken: (serverId, tokenId) => setServerCloudProviderToken(tx, serverId, tokenId),
  };
}

/** A cipher for one encrypted column; the org's data key is looked up (or created) on first use only. */
export function columnCipher(tx: SqlExecutor, orgId: string, secret: string | undefined, column: string): KeyCipher {
  let dek: Promise<OrgDek> | null = null;
  const key = () => (dek ??= loadKek(secret).then((kek) => orgDek(tx, orgId, kek)));
  return {
    encrypt: async (plaintext) => encryptField(await key(), column, plaintext),
    decrypt: async (stored) => decryptField(await key(), column, stored),
  };
}

export const runCloudTokensInOrg: CloudTokenRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => fn({ store: sqlStore(tx, orgId), cipher: columnCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, COLUMN) }));
  } finally {
    await db.dispose();
  }
};

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const b: unknown = await request.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * What handlePrivateKeys does before it runs anything: membership-worker's
 * facts, then policy-worker on deploy.resource.read (reads) and
 * deploy.resource.write. A read also learns whether the caller may write.
 */
export async function authorizeDeploy(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  needsWrite: boolean,
): Promise<{ ok: true; canWrite: boolean } | { ok: false; response: Response }> {
  if (!env.PLATFORM_DB || !env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) {
    return { ok: false, response: errorResponse("internal_error", "Service unavailable", 503, requestId) };
  }
  const ctx = await fetchAuthorizationContext(env.MEMBERSHIP_WORKER, actor.subjectId, actor.subjectType, orgId, requestId);
  if (!ctx.ok) return { ok: false, response: deniedResponse(env.ENVIRONMENT, requestId, ctx.reason) };
  const ask = (action: string) =>
    authorizeViaPolicy(env.POLICY_WORKER!, actor.subjectId, actor.subjectType, action, { kind: "organization", orgId: orgId as never }, ctx.memberships, requestId);
  const [read, write] = await Promise.all([needsWrite ? Promise.resolve<AuthorizeResult>({ allow: true }) : ask("deploy.resource.read"), ask("deploy.resource.write")]);
  if (!read.allow || (needsWrite && !write.allow)) {
    return { ok: false, response: deniedResponse(env.ENVIRONMENT, requestId, (read.allow ? write.reason : read.reason) ?? "denied", { memberships: ctx.memberships.length }) };
  }
  return { ok: true, canWrite: write.allow };
}

function failure(e: unknown, requestId: string): Response {
  if (e instanceof CloudTokenError) return errorResponse(e.status === 409 ? "conflict" : "validation_failed", e.message, e.status, requestId);
  return errorResponse("internal_error", "Service unavailable", 503, requestId);
}

type Op = { write: boolean; run: (canWrite: boolean) => Promise<Response> };

async function authorized(env: Env, requestId: string, actor: ActorContext, orgId: string, op: Op): Promise<Response> {
  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;
  try {
    return await op.run(auth.canWrite);
  } catch (e) {
    return failure(e, requestId);
  }
}

/**
 * segments: what follows /cloud-tokens, split on "/" ([] for the collection).
 * `runner` and `http` are replaceable for tests.
 */
export async function handleCloudTokens(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segments: string[],
  request: Request,
  runner: CloudTokenRunner = runCloudTokensInOrg,
  http: ProviderHttp = providerFetch,
): Promise<Response> {
  const method = request.method;
  const [first, second] = segments;
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  let op: Op | null = null;

  if (segments.length === 0) {
    if (method === "GET") op = { write: false, run: list };
    else if (method === "POST") op = { write: true, run: create };
  } else if (segments.length === 1 && UUID_RE.test(first!)) {
    if (method === "GET") op = { write: false, run: (canWrite) => show(first!, canWrite) };
    else if (method === "PATCH") op = { write: true, run: () => update(first!) };
    else if (method === "DELETE") op = { write: true, run: () => remove(first!) };
  } else if (segments.length === 2 && UUID_RE.test(first!) && second === "validate") {
    if (method === "POST") op = { write: true, run: () => validate(first!) };
  } else {
    return notFound();
  }
  if (!op) return methodNotAllowed(requestId);

  async function list(canWrite: boolean): Promise<Response> {
    const tokens = await runner(env, orgId, (c) => listCloudTokens(c));
    return successResponse({ tokens, canWrite }, requestId);
  }

  async function create(): Promise<Response> {
    const v = validateCreateToken(await readJson(request));
    if (!v.ok) return validationError(requestId, v.errors);
    // "Validate the token with the provider's API", before anything is stored.
    if (!(await validateNewToken(http, v.input.provider, v.input.token))) throw new CloudTokenError(CLOUD_TOKEN_MESSAGES.invalidToken);
    const row = await runner(env, orgId, (c) => storeCloudToken(c, v.input));
    return successResponse({ uuid: row.uuid, message: CLOUD_TOKEN_MESSAGES.added }, requestId, 201);
  }

  async function show(uuid: string, canWrite: boolean): Promise<Response> {
    const token = await runner(env, orgId, (c) => showCloudToken(c, uuid));
    if (!token) return notFound();
    return successResponse({ ...token, canUpdate: canWrite }, requestId);
  }

  async function update(uuid: string): Promise<Response> {
    const v = validateUpdateToken(await readJson(request));
    if (!v.ok) return validationError(requestId, v.errors);
    const row = await runner(env, orgId, (c) => updateCloudToken(c, uuid, v.input));
    if (!row) return notFound();
    return successResponse({ uuid: row.uuid, message: CLOUD_TOKEN_MESSAGES.updated }, requestId);
  }

  async function remove(uuid: string): Promise<Response> {
    const deleted = await runner(env, orgId, (c) => deleteCloudToken(c, uuid));
    if (!deleted) return notFound();
    return successResponse({ deleted: true, message: CLOUD_TOKEN_MESSAGES.deleted }, requestId);
  }

  async function validate(uuid: string): Promise<Response> {
    const secret = await runner(env, orgId, (c) => cloudTokenSecret(c, uuid));
    if (!secret) return notFound();
    return successResponse(validationResult(secret.provider, await validateStoredToken(http, secret.provider, secret.token)), requestId);
  }

  return authorized(env, requestId, actor, orgId, op);
}

/**
 * A server's Cloud Token page. segments: what follows
 * /servers/{uuid}/cloud-provider-token ([] or ["validate"]).
 */
export async function handleServerCloudToken(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  uuid: string,
  segments: string[],
  request: Request,
  runner: CloudTokenRunner = runCloudTokensInOrg,
  http: ProviderHttp = providerFetch,
): Promise<Response> {
  const method = request.method;
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  let op: Op | null = null;

  if (segments.length === 0) {
    if (method === "GET") op = { write: false, run: show };
    else if (method === "PATCH") op = { write: true, run: set };
  } else if (segments.length === 1 && segments[0] === "validate") {
    if (method === "POST") op = { write: true, run: validate };
  } else {
    return notFound();
  }
  if (!op) return methodNotAllowed(requestId);

  async function show(canWrite: boolean): Promise<Response> {
    const page = await runner(env, orgId, (c) => serverCloudTokenPage(c, uuid));
    if (!page) return notFound();
    // canGate="update" on the server, and @can('create', CloudProviderToken::class).
    return successResponse({ ...page, canUpdate: canWrite, canCreateToken: canWrite }, requestId);
  }

  async function set(): Promise<Response> {
    const body = await readJson(request);
    const choice = await runner(env, orgId, (c) => chooseServerToken(c, uuid, body.cloud_provider_token_uuid));
    if (!choice) return notFound();
    // "Validate the token works and can access this specific server".
    const error = await validateTokenForServer(http, choice.secret.provider, choice.secret.token, choice.ids);
    if (error) throw new CloudTokenError(error);
    if (!(await runner(env, orgId, (c) => assignServerToken(c, choice)))) return notFound();
    return successResponse({ message: CLOUD_TOKEN_MESSAGES.serverTokenUpdated(choice.providerName) }, requestId);
  }

  async function validate(): Promise<Response> {
    const found = await runner(env, orgId, (c) => serverTokenSecret(c, uuid));
    if (!found) return notFound();
    if (!found.secret) throw new CloudTokenError(CLOUD_TOKEN_MESSAGES.noServerToken(found.providerName));
    let valid: boolean;
    try {
      valid = await validateServerToken(http, found.secret.provider, found.secret.token);
    } catch (e) {
      // handleError(): the exception's message as the error toast.
      throw new CloudTokenError(e instanceof Error ? e.message : String(e));
    }
    const message = valid ? CLOUD_TOKEN_MESSAGES.serverTokenValid(found.providerName) : CLOUD_TOKEN_MESSAGES.serverTokenInvalid(found.providerName);
    return successResponse({ valid, message }, requestId);
  }

  return authorized(env, requestId, actor, orgId, op);
}
