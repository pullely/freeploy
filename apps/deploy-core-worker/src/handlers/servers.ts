// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Server/{Index,CreatePage,Show,Delete}.php,
// app/Livewire/Server/New/ByIp.php, app/Livewire/Server/PrivateKey/Show.php and
// app/Policies/ServerPolicy.php (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/servers — Servers.
//
//   GET    /servers                          Index: the org's servers and their status
//   GET    /servers/new                      ByIp::mount: a random name and the org's private keys
//   POST   /servers                          ByIp::submit { name, description, ip, user, port, private_key_uuid, server_role, scan_images }
//   GET    /servers/{uuid}                   Show (General)
//   PATCH  /servers/{uuid}                   Show::submit { name, description, ip, user, port, connectionTimeout,
//                                            serverTimezone, wildcardDomain, publicIpv4, publicIpv6 }
//   PATCH  /servers/{uuid}/role              Show::requestServerRoleChange / confirmServerRoleChange { serverRole, confirmed }
//   POST   /servers/{uuid}/validate          Show::validateServer — needs the ssh-executor, not available yet
//   POST   /servers/{uuid}/refresh-metadata  Show::refreshServerMetadata
//   GET    /servers/{uuid}/private-key       PrivateKey/Show
//   PATCH  /servers/{uuid}/private-key       PrivateKey/Show::setPrivateKey { private_key_uuid }
//   POST   /servers/{uuid}/check-connection  PrivateKey/Show::checkConnection — not available yet
//   …      /servers/{uuid}/cloud-provider-token[/validate]
//                                            the Cloud Token page (DP-45): handleServerCloudToken in cloud-tokens.ts
//   …      /servers/{uuid}/ca-certificate[/regenerate]
//                                            the CA Certificate page (DP-48): handleServerCaCertificate in ca-certificate.ts
//   DELETE /servers/{uuid}                   Delete::delete (no body: the edge does not forward one)
//   …      /servers/{uuid}/{advanced,docker-cleanup,log-drains,swarm,sentinel}[/{action}]
//                                            the settings pages (DP-42): see server-settings.ts
//   …      /servers/{uuid}/destinations[/scan] the server's destinations (DP-44): see destinations.ts
//   …      /servers/{uuid}/registries[/{registry}[/check]]
//                                            the Registries page (DP-47): handleServerRegistries in registries.ts
//
// Coolify's policy: view = team member, create/update/delete = team admin.
// Here: deploy.resource.read and deploy.resource.write, asked of policy-worker
// after membership-worker's facts; a denial answers 404 (never leaks).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  loadKek,
  orgDek,
  decryptField,
  encryptField,
  listServers as listServerRows,
  findServerByUuid,
  insertServer,
  updateServer as updateServerRows,
  updateServerRole,
  setServerPrivateKey as setServerPrivateKeyRow,
  deleteServer as deleteServerRows,
  serverSshEndpointInUse,
  otherBuildServerExists,
  listServerPrivateKeys,
  findPrivateKeyByUuid,
  type OrgDek,
} from "@saas/db/deploy";
import { runServerSettingsInOrg, serverSettingsRoute, SETTINGS_ACTIONS, SETTINGS_SECTIONS, settingsNeedsWrite, type ServerSettingsRunner, type SettingsSection } from "./server-settings.js";
import { runDestinationsInOrg, SERVER_DESTINATION_ACTIONS, serverDestinationsRoute, type DestinationRunner } from "./destinations.js";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy, type AuthorizeResult } from "../policy-client.js";
import { deniedResponse, errorResponse, methodNotAllowed, successResponse, validationError } from "../http.js";
import type { KeyCipher } from "../private-keys/service.js";
import { handleServerCloudToken } from "./cloud-tokens.js";
import { handleServerRegistries } from "./registries.js";
import { handleServerCaCertificate } from "./ca-certificate.js";
import { SERVER_MESSAGES, SERVER_ROLES, validateCreateServer, validateUpdateServer, type ServerRole } from "../servers/validation.js";
import {
  changeServerRole,
  createServer,
  createServerOptions,
  deleteServer,
  listServers,
  refreshServerMetadata,
  serverPrivateKeys,
  SERVER_SERVICE_MESSAGES,
  ServerError,
  setServerPrivateKey,
  showServer,
  unavailableOnServer,
  updateServer,
  type ServerContext,
  type ServerStore,
} from "../servers/service.js";

const COLUMN = "private_keys.private_key";
const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

/** Runs fn with one org's server store, in one transaction confined to that org. */
export type ServerRunner = <T>(env: Env, orgId: string, fn: (ctx: ServerContext) => Promise<T>) => Promise<T>;

function sqlStore(tx: SqlExecutor, orgId: string): ServerStore {
  return {
    list: () => listServerRows(tx),
    findByUuid: (uuid) => findServerByUuid(tx, uuid),
    insert: (server) => insertServer(tx, { ...server, orgId }),
    update: (id, server, settings) => updateServerRows(tx, id, server, settings),
    updateRole: (id, role, disableSentinel) => updateServerRole(tx, id, role, disableSentinel),
    setPrivateKey: (id, keyId) => setServerPrivateKeyRow(tx, id, keyId),
    delete: (id) => deleteServerRows(tx, id),
    sshEndpointInUse: (ip, port, exceptId) => serverSshEndpointInUse(tx, ip, port, exceptId),
    otherBuildServerExists: (exceptId) => otherBuildServerExists(tx, exceptId),
    privateKeys: () => listServerPrivateKeys(tx),
    findPrivateKey: (uuid) => findPrivateKeyByUuid(tx, uuid),
  };
}

/** The org's data key is looked up on first use only: most server pages need none. */
function sqlCipher(tx: SqlExecutor, orgId: string, secret: string | undefined): KeyCipher {
  let dek: Promise<OrgDek> | null = null;
  const key = () => (dek ??= loadKek(secret).then((kek) => orgDek(tx, orgId, kek)));
  return {
    encrypt: async (plaintext) => encryptField(await key(), COLUMN, plaintext),
    decrypt: async (stored) => decryptField(await key(), COLUMN, stored),
  };
}

export const runServersInOrg: ServerRunner = async (env, orgId, fn) => {
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

function failure(e: unknown, requestId: string): Response {
  if (e instanceof ServerError) {
    if (e.field) return validationError(requestId, { [e.field]: [e.message] });
    const code = e.status === 501 ? "unsupported" : e.status >= 500 ? "internal_error" : "validation_failed";
    return errorResponse(code, e.message, e.status, requestId);
  }
  return errorResponse("internal_error", "Service unavailable", 503, requestId);
}

/**
 * segments: what follows /servers, split on "/" ([] for the collection).
 * `runner` is replaceable for tests.
 */
export async function handleServers(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segments: string[],
  request: Request,
  runner: ServerRunner = runServersInOrg,
  settingsRunner: ServerSettingsRunner = runServerSettingsInOrg,
  destinationsRunner: DestinationRunner = runDestinationsInOrg,
): Promise<Response> {
  const method = request.method;
  // The Cloud Token page routes and authorizes itself (DP-45).
  if (segments.length >= 2 && segments[1] === "cloud-provider-token" && UUID_RE.test(segments[0]!)) {
    return handleServerCloudToken(env, requestId, actor, orgId, segments[0]!, segments.slice(2), request);
  }
  // So does the Registries page (DP-47).
  if (segments.length >= 2 && segments[1] === "registries") {
    return handleServerRegistries(env, requestId, actor, orgId, segments[0]!, segments.slice(2), request);
  }
  // The CA Certificate page routes and authorizes itself too (DP-48).
  if (segments.length >= 2 && segments[1] === "ca-certificate" && UUID_RE.test(segments[0]!)) {
    return handleServerCaCertificate(env, requestId, actor, orgId, segments[0]!, segments.slice(2), request);
  }
  const [first, second, third] = segments;
  const section = SETTINGS_SECTIONS.includes(second as SettingsSection) ? (second as SettingsSection) : null;
  type Op = { write: boolean; run: () => Promise<Response> };
  let op: Op | null = null;

  if (segments.length === 0) {
    if (method === "GET") op = { write: false, run: async () => list() };
    else if (method === "POST") op = { write: true, run: async () => create() };
  } else if (segments.length === 1 && first === "new") {
    if (method === "GET") op = { write: true, run: async () => createOptions() };
  } else if (segments.length === 1 && UUID_RE.test(first!)) {
    if (method === "GET") op = { write: false, run: async () => show(first!) };
    else if (method === "PATCH") op = { write: true, run: async () => update(first!) };
    else if (method === "DELETE") op = { write: true, run: async () => remove(first!) };
  } else if (segments.length === 2 && UUID_RE.test(first!) && second === "role") {
    if (method === "PATCH") op = { write: true, run: async () => role(first!) };
  } else if (segments.length === 2 && UUID_RE.test(first!) && second === "private-key") {
    if (method === "GET") op = { write: false, run: async () => privateKeys(first!) };
    else if (method === "PATCH") op = { write: true, run: async () => setPrivateKey(first!) };
  } else if (segments.length === 2 && UUID_RE.test(first!) && (second === "validate" || second === "check-connection")) {
    if (method === "POST") op = { write: true, run: async () => unavailable(first!, second) };
  } else if (segments.length === 2 && UUID_RE.test(first!) && second === "refresh-metadata") {
    if (method === "POST") op = { write: true, run: async () => refresh(first!) };
  } else if (segments.length === 2 && UUID_RE.test(first!) && second === "destinations") {
    if (method === "GET") op = { write: false, run: async () => destinations(first!, null) };
    else if (method === "POST") op = { write: true, run: async () => destinations(first!, null) };
  } else if (segments.length === 3 && UUID_RE.test(first!) && second === "destinations" && SERVER_DESTINATION_ACTIONS.includes(third!)) {
    if (method === "POST") op = { write: true, run: async () => destinations(first!, third!) };
  } else if (segments.length === 2 && UUID_RE.test(first!) && section) {
    if (method === "GET" || method === "PATCH") op = { write: settingsNeedsWrite(section, method), run: async () => settings(first!, section, null) };
  } else if (segments.length === 3 && UUID_RE.test(first!) && section && SETTINGS_ACTIONS[section]?.includes(third!)) {
    if (method === "POST") op = { write: true, run: async () => settings(first!, section, third!) };
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
  // Reads also say whether the caller may write (Coolify's @can / canGate="update" in the views).
  const [read, write] = await Promise.all([op.write ? Promise.resolve<AuthorizeResult>({ allow: true }) : ask("deploy.resource.read"), ask("deploy.resource.write")]);
  if (!read.allow || (op.write && !write.allow)) return deniedResponse(env.ENVIRONMENT, requestId, (read.allow ? write.reason : read.reason) ?? "denied", { memberships: ctx.memberships.length });
  const canWrite = write.allow;
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);

  async function list(): Promise<Response> {
    const servers = await runner(env, orgId, (c) => listServers(c));
    return successResponse({ servers, canWrite }, requestId);
  }

  async function createOptions(): Promise<Response> {
    const data = await runner(env, orgId, (c) => createServerOptions(c));
    return successResponse({ ...data, canCreatePrivateKey: canWrite }, requestId);
  }

  async function create(): Promise<Response> {
    const v = validateCreateServer(await readJson(request));
    if (!v.ok) return validationError(requestId, v.errors);
    const row = await runner(env, orgId, (c) => createServer(c, v.input));
    return successResponse({ uuid: row.uuid }, requestId, 201);
  }

  async function show(uuid: string): Promise<Response> {
    const server = await runner(env, orgId, (c) => showServer(c, uuid));
    if (!server) return notFound();
    return successResponse({ server, canUpdate: canWrite }, requestId);
  }

  async function update(uuid: string): Promise<Response> {
    const v = validateUpdateServer(await readJson(request));
    if (!v.ok) return validationError(requestId, v.errors);
    const server = await runner(env, orgId, (c) => updateServer(c, uuid, v.input));
    if (!server) return notFound();
    return successResponse({ server, message: SERVER_SERVICE_MESSAGES.updated }, requestId);
  }

  async function role(uuid: string): Promise<Response> {
    const body = await readJson(request);
    if (!SERVER_ROLES.includes(body.serverRole as ServerRole)) return validationError(requestId, { serverRole: [SERVER_MESSAGES.serverRoleIn] });
    const r = await runner(env, orgId, (c) => changeServerRole(c, uuid, body.serverRole as ServerRole, body.confirmed === true));
    if (!r) return notFound();
    if ("confirm" in r) return successResponse({ confirm: true }, requestId);
    return successResponse({ serverRole: r.serverRole, info: r.info, message: SERVER_SERVICE_MESSAGES.updated }, requestId);
  }

  async function privateKeys(uuid: string): Promise<Response> {
    const data = await runner(env, orgId, (c) => serverPrivateKeys(c, uuid));
    if (!data) return notFound();
    return successResponse({ ...data, canUpdate: canWrite }, requestId);
  }

  async function setPrivateKey(uuid: string): Promise<Response> {
    const body = await readJson(request);
    const done = await runner(env, orgId, (c) => setServerPrivateKey(c, uuid, body.private_key_uuid));
    if (!done) return notFound();
    return successResponse({ message: SERVER_SERVICE_MESSAGES.keyUpdated }, requestId);
  }

  async function refresh(uuid: string): Promise<Response> {
    const found = await runner(env, orgId, (c) => refreshServerMetadata(c, uuid));
    return found ? successResponse({}, requestId) : notFound();
  }

  async function unavailable(uuid: string, action: "validate" | "check-connection"): Promise<Response> {
    const found = await runner(env, orgId, (c) => unavailableOnServer(c, uuid, action));
    return found ? successResponse({}, requestId) : notFound();
  }

  async function settings(uuid: string, s: SettingsSection, action: string | null): Promise<Response> {
    const body = method === "GET" ? {} : await readJson(request);
    return serverSettingsRoute({ env, orgId, requestId, uuid, section: s, action, body, method, canWrite, notFound }, settingsRunner);
  }

  async function destinations(uuid: string, action: string | null): Promise<Response> {
    const body = method === "GET" ? {} : await readJson(request);
    return serverDestinationsRoute({ env, orgId, requestId, uuid, action, body, method, canWrite, notFound }, destinationsRunner);
  }

  async function remove(uuid: string): Promise<Response> {
    const deleted = await runner(env, orgId, (c) => deleteServer(c, uuid));
    if (!deleted) return notFound();
    return successResponse({ deleted: true }, requestId);
  }

  try {
    return await op.run();
  } catch (e) {
    return failure(e, requestId);
  }
}
