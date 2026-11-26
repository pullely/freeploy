// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Security/PrivateKey/{Index,Create,Show,Rotate}.php
// and app/Policies/PrivateKeyPolicy.php (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/private-keys — Keys & Tokens → Private Keys.
//
//   GET    /private-keys                     Index: the org's keys (never the key itself)
//   POST   /private-keys                     Create { name, description, value }
//   POST   /private-keys/generate            Index::generatePrivateKey { type: ed25519 | rsa }
//   POST   /private-keys/cleanup             Index::cleanupUnusedKeys
//   POST   /private-keys/validate            Create::validatePrivateKey { value } → { error, publicKey }
//   GET    /private-keys/{uuid}              Show (?usage_search=…)
//   PATCH  /private-keys/{uuid}              Show::changePrivateKey { name, description, newPrivateKey? }
//   DELETE /private-keys/{uuid}              Show::delete (no body: the edge does not forward one)
//   POST   /private-keys/{uuid}/reveal       Show::revealPrivateKey — not available yet
//   POST   /private-keys/{uuid}/rotate       Rotate::rotate — needs the ssh-executor, not available yet
//
// Coolify's policy: view = team member, create/update/delete = team admin.
// Here: deploy.resource.read and deploy.resource.write, asked of policy-worker
// after membership-worker's facts; a denial answers 404 (never leaks).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor, type SqlExecutor, type TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  loadKek,
  orgDek,
  encryptField,
  decryptField,
  listPrivateKeys,
  findPrivateKeyByUuid,
  insertPrivateKey,
  updatePrivateKey as updatePrivateKeyRow,
  deletePrivateKey as deletePrivateKeyRow,
  privateKeyFingerprintExists,
  privateKeyIsInUse,
  privateKeyUsages,
  type DeployPrivateKeyListRow,
  type OrgDek,
} from "@saas/db/deploy";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy, type AuthorizeResult } from "../policy-client.js";
import { deniedResponse, errorResponse, methodNotAllowed, successResponse, validationError } from "../http.js";
import { validateCreate, validateUpdate } from "../private-keys/validation.js";
import {
  cleanupUnusedKeys,
  createPrivateKey,
  deletePrivateKey,
  generatePrivateKey,
  inspectPrivateKey,
  PRIVATE_KEY_MESSAGES,
  PrivateKeyError,
  showPrivateKey,
  updatePrivateKey,
  type KeyCipher,
  type OrgContext,
  type PrivateKeyStore,
} from "../private-keys/service.js";

const COLUMN = "private_keys.private_key";
const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

/** Runs fn with one org's key store and cipher, in one transaction confined to that org. */
export type OrgRunner = <T>(env: Env, orgId: string, fn: (ctx: OrgContext) => Promise<T>) => Promise<T>;

/** The key store over one org's transaction (exported for DP-94's tests). */
export function sqlStore(tx: SqlExecutor, orgId: string): PrivateKeyStore {
  return {
    list: () => listPrivateKeys(tx),
    findByUuid: (uuid) => findPrivateKeyByUuid(tx, uuid),
    insert: (key) => insertPrivateKey(tx, { ...key, orgId }),
    update: (id, changes) => updatePrivateKeyRow(tx, id, changes),
    delete: (id) => deletePrivateKeyRow(tx, id),
    fingerprintExists: (fp, excludeId) => privateKeyFingerprintExists(tx, fp, excludeId),
    isInUse: (id) => privateKeyIsInUse(tx, id),
    usages: (id, search) => privateKeyUsages(tx, id, search),
  };
}

/** The org's data key is looked up (or created) on first use only: listing keys needs none. */
export function sqlCipher(tx: SqlExecutor, orgId: string, secret: string | undefined): KeyCipher {
  let dek: Promise<OrgDek> | null = null;
  const key = () => (dek ??= loadKek(secret).then((kek) => orgDek(tx, orgId, kek)));
  return {
    encrypt: async (plaintext) => encryptField(await key(), COLUMN, plaintext),
    decrypt: async (stored) => decryptField(await key(), COLUMN, stored),
  };
}

/** runInOrg() on a given database (DP-93: the /api/v1 replays run on PGlite): withOrg(), the same stores. */
export const runInOrgOn =
  (db: TransactionalSqlExecutor): OrgRunner =>
  (env, orgId, fn) =>
    withOrg(db, orgId, (tx) => fn({ store: sqlStore(tx, orgId), cipher: sqlCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY) }));

export const runInOrg: OrgRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => fn({ store: sqlStore(tx, orgId), cipher: sqlCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY) }));
  } finally {
    await db.dispose();
  }
};

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const b: unknown = await request.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function toPublicPrivateKey(row: DeployPrivateKeyListRow) {
  return { uuid: row.uuid, name: row.name, description: row.description ?? null, is_git_related: Boolean(row.is_git_related), is_in_use: Boolean(row.in_use) };
}

function failure(e: unknown, requestId: string): Response {
  if (e instanceof PrivateKeyError) {
    // A ValidationException from the saving hook carries its field; the console shows it as Coolify's error toast.
    if (e.field) return validationError(requestId, { [e.field]: [e.message] });
    return errorResponse(e.status === 409 ? "conflict" : e.status >= 500 ? "internal_error" : "validation_failed", e.message, e.status, requestId);
  }
  return errorResponse("internal_error", "Service unavailable", 503, requestId);
}

/**
 * segments: what follows /private-keys, split on "/" ([] for the collection).
 * `runner` is replaceable for tests.
 */
export async function handlePrivateKeys(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segments: string[],
  request: Request,
  runner: OrgRunner = runInOrg,
): Promise<Response> {
  const method = request.method;
  const [first, second] = segments;
  type Op = { write: boolean; run: () => Promise<Response> };
  let op: Op | null = null;

  if (segments.length === 0) {
    if (method === "GET") op = { write: false, run: async () => list() };
    else if (method === "POST") op = { write: true, run: async () => create() };
  } else if (segments.length === 1 && first === "generate") {
    if (method === "POST") op = { write: true, run: async () => generate() };
  } else if (segments.length === 1 && first === "cleanup") {
    if (method === "POST") op = { write: true, run: async () => cleanup() };
  } else if (segments.length === 1 && first === "validate") {
    if (method === "POST") op = { write: false, run: async () => validate() };
  } else if (segments.length === 1 && UUID_RE.test(first!)) {
    if (method === "GET") op = { write: false, run: async () => show(first!) };
    else if (method === "PATCH") op = { write: true, run: async () => update(first!) };
    else if (method === "DELETE") op = { write: true, run: async () => remove(first!) };
  } else if (segments.length === 2 && UUID_RE.test(first!) && (second === "reveal" || second === "rotate")) {
    if (method === "POST") op = { write: true, run: async () => unavailable(first!, second) };
  } else {
    return errorResponse("not_found", "Not found", 404, requestId);
  }
  if (!op) return methodNotAllowed(requestId);

  if (!env.PLATFORM_DB || !env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  const ctx = await fetchAuthorizationContext(env.MEMBERSHIP_WORKER, actor.subjectId, actor.subjectType, orgId, requestId);
  if (!ctx.ok) return deniedResponse(env.ENVIRONMENT, requestId, ctx.reason);
  const ask = (action: string) =>
    authorizeViaPolicy(env.POLICY_WORKER!, actor.subjectId, actor.subjectType, action, { kind: "organization", orgId: orgId as never }, ctx.memberships, requestId);
  // Reads also say whether the caller may write (Coolify's @can('create' | 'update', …) in the views).
  const [read, write] = await Promise.all([op.write ? Promise.resolve<AuthorizeResult>({ allow: true }) : ask("deploy.resource.read"), ask("deploy.resource.write")]);
  if (!read.allow || (op.write && !write.allow)) return deniedResponse(env.ENVIRONMENT, requestId, (read.allow ? write.reason : read.reason) ?? "denied", { memberships: ctx.memberships.length });
  const canWrite = write.allow;

  async function list(): Promise<Response> {
    const rows = await runner(env, orgId, ({ store }) => store.list());
    return successResponse({ privateKeys: rows.map(toPublicPrivateKey), canWrite }, requestId);
  }

  async function create(): Promise<Response> {
    const v = validateCreate(await readJson(request));
    if (!v.ok) return validationError(requestId, v.errors);
    const row = await runner(env, orgId, (c) => createPrivateKey(c, v.input));
    return successResponse({ uuid: row.uuid, message: PRIVATE_KEY_MESSAGES.created }, requestId, 201);
  }

  async function generate(): Promise<Response> {
    const body = await readJson(request);
    if (body.type !== "ed25519" && body.type !== "rsa") return errorResponse("validation_failed", PRIVATE_KEY_MESSAGES.invalidType, 422, requestId);
    const row = await runner(env, orgId, (c) => generatePrivateKey(c, body.type));
    return successResponse({ uuid: row.uuid, message: PRIVATE_KEY_MESSAGES.generated }, requestId, 201);
  }

  async function cleanup(): Promise<Response> {
    const deleted = await runner(env, orgId, (c) => cleanupUnusedKeys(c));
    return successResponse({ deleted, message: PRIVATE_KEY_MESSAGES.cleanedUp }, requestId);
  }

  async function validate(): Promise<Response> {
    const body = await readJson(request);
    return successResponse(await inspectPrivateKey(typeof body.value === "string" ? body.value : ""), requestId);
  }

  async function show(uuid: string): Promise<Response> {
    const search = new URL(request.url).searchParams.get("usage_search") ?? "";
    const data = await runner(env, orgId, (c) => showPrivateKey(c, uuid, search));
    if (!data) return errorResponse("not_found", "Not found", 404, requestId);
    return successResponse({ ...data, canUpdate: canWrite }, requestId);
  }

  async function update(uuid: string): Promise<Response> {
    const v = validateUpdate(await readJson(request));
    if (!v.ok) return validationError(requestId, v.errors);
    const row = await runner(env, orgId, (c) => updatePrivateKey(c, uuid, v.input));
    if (!row) return errorResponse("not_found", "Not found", 404, requestId);
    return successResponse({ uuid: row.uuid, message: PRIVATE_KEY_MESSAGES.updated }, requestId);
  }

  async function remove(uuid: string): Promise<Response> {
    const deleted = await runner(env, orgId, (c) => deletePrivateKey(c, uuid));
    if (!deleted) return errorResponse("not_found", "Not found", 404, requestId);
    return successResponse({ deleted: true }, requestId);
  }

  async function unavailable(uuid: string, action: "reveal" | "rotate"): Promise<Response> {
    const found = await runner(env, orgId, ({ store }) => store.findByUuid(uuid));
    if (!found) return errorResponse("not_found", "Not found", 404, requestId);
    const message = action === "rotate" ? PRIVATE_KEY_MESSAGES.rotateUnavailable : PRIVATE_KEY_MESSAGES.revealUnavailable;
    return errorResponse("unsupported", message, 501, requestId);
  }

  try {
    return await op.run();
  } catch (e) {
    return failure(e, requestId);
  }
}
