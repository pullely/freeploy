// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Destination/{Index,Show,Resources}.php,
// app/Livewire/Destination/New/Docker.php, app/Livewire/Server/Destinations.php and
// app/Policies/{StandaloneDockerPolicy,SwarmDockerPolicy,ServerPolicy}.php (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/destinations — Destinations.
//
//   GET    /destinations                    Index: the destinations of the org's usable servers, and what
//                                           New/Docker needs (the usable servers, a network id)
//   GET    /destinations/{uuid}             Show (General and Danger Zone)
//   PATCH  /destinations/{uuid}             Show::submit { name }
//   DELETE /destinations/{uuid}             Show::delete (no body: the edge does not forward one). A standalone
//                                           destination's network must be removed on the server first: 501
//   GET    /destinations/{uuid}/resources   Resources: what is deployed to the destination
//
// and below /servers/{uuid}, routed and authorized by handleServers (servers.ts):
//
//   GET    /destinations                    Server/Destinations: the server's destinations
//   POST   /destinations                    New/Docker::submit { name, network }: the row is stored; creating
//                                           the network on the server is reported as not available yet
//   POST   /destinations/scan               Server/Destinations::scan — needs SSH, not available yet (501)
//
// Coolify's policies: view = team member, update/delete = team admin; adding
// one needs update on the server. Here: deploy.resource.read and
// deploy.resource.write, asked of policy-worker after membership-worker's
// facts; a denial answers 404 (never leaks).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  listUsableServers,
  listUsableServerDestinations,
  listServerDestinations,
  findDestinationByUuid,
  findServerByUuid,
  destinationNetworkExists,
  insertDestination,
  updateDestinationName,
  deleteDestination as deleteDestinationRow,
  destinationIsAttached,
  listDestinationResources,
} from "@saas/db/deploy";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy, type AuthorizeResult } from "../policy-client.js";
import { deniedResponse, errorResponse, methodNotAllowed, successResponse, validationError } from "../http.js";
import { ServerError } from "../servers/service.js";
import {
  addDestination,
  deleteDestination,
  DESTINATION_MESSAGES,
  destinationResources,
  listDestinations,
  scanDestinations,
  serverDestinations,
  showDestination,
  updateDestination,
  type DestinationContext,
  type DestinationStore,
} from "../destinations/service.js";
import { validateNewDestination, validateUpdateDestination } from "../destinations/validation.js";

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

/** Runs fn with one org's destination store, in one transaction confined to that org. */
export type DestinationRunner = <T>(env: Env, orgId: string, fn: (ctx: DestinationContext) => Promise<T>) => Promise<T>;

function sqlStore(tx: SqlExecutor, orgId: string): DestinationStore {
  return {
    usableServers: () => listUsableServers(tx),
    listUsable: () => listUsableServerDestinations(tx),
    listForServer: (serverId) => listServerDestinations(tx, serverId),
    findByUuid: (uuid) => findDestinationByUuid(tx, uuid),
    findServer: (uuid) => findServerByUuid(tx, uuid),
    networkExists: (type, serverId, network) => destinationNetworkExists(tx, type, serverId, network),
    insert: (destination) => insertDestination(tx, { ...destination, orgId }),
    rename: (type, id, name) => updateDestinationName(tx, type, id, name),
    delete: (type, id) => deleteDestinationRow(tx, type, id),
    isAttached: (type, id) => destinationIsAttached(tx, type, id),
    resources: (type, id) => listDestinationResources(tx, type, id),
  };
}

export const runDestinationsInOrg: DestinationRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => fn({ store: sqlStore(tx, orgId) }));
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
 * segments: what follows /destinations, split on "/" ([] for the collection).
 * `runner` is replaceable for tests.
 */
export async function handleDestinations(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segments: string[],
  request: Request,
  runner: DestinationRunner = runDestinationsInOrg,
): Promise<Response> {
  const method = request.method;
  const [first, second] = segments;
  type Op = { write: boolean; run: () => Promise<Response> };
  let op: Op | null = null;

  if (segments.length === 0) {
    if (method === "GET") op = { write: false, run: async () => list() };
  } else if (segments.length === 1 && UUID_RE.test(first!)) {
    if (method === "GET") op = { write: false, run: async () => show(first!) };
    else if (method === "PATCH") op = { write: true, run: async () => update(first!) };
    else if (method === "DELETE") op = { write: true, run: async () => remove(first!) };
  } else if (segments.length === 2 && UUID_RE.test(first!) && second === "resources") {
    if (method === "GET") op = { write: false, run: async () => resources(first!) };
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
    const data = await runner(env, orgId, (c) => listDestinations(c));
    // @can('createAnyResource'): who may write to the whole org.
    return successResponse({ ...data, canCreate: canWrite }, requestId);
  }

  async function show(uuid: string): Promise<Response> {
    const destination = await runner(env, orgId, (c) => showDestination(c, uuid));
    if (!destination) return notFound();
    return successResponse({ destination, canUpdate: canWrite }, requestId);
  }

  async function update(uuid: string): Promise<Response> {
    const v = validateUpdateDestination(await readJson(request));
    if (!v.ok) return validationError(requestId, v.errors);
    const destination = await runner(env, orgId, (c) => updateDestination(c, uuid, v.input));
    if (!destination) return notFound();
    return successResponse({ destination, message: DESTINATION_MESSAGES.saved }, requestId);
  }

  async function resources(uuid: string): Promise<Response> {
    const data = await runner(env, orgId, (c) => destinationResources(c, uuid));
    if (!data) return notFound();
    return successResponse({ ...data, canUpdate: canWrite }, requestId);
  }

  async function remove(uuid: string): Promise<Response> {
    const deleted = await runner(env, orgId, (c) => deleteDestination(c, uuid));
    if (!deleted) return notFound();
    return successResponse({ deleted: true }, requestId);
  }

  try {
    return await op.run();
  } catch (e) {
    return failure(e, requestId);
  }
}

/** The POST action below /servers/{uuid}/destinations. */
export const SERVER_DESTINATION_ACTIONS: readonly string[] = ["scan"];

export interface ServerDestinationsCall {
  env: Env;
  orgId: string;
  requestId: string;
  /** The server's uuid. */
  uuid: string;
  action: string | null;
  body: Record<string, unknown>;
  method: string;
  canWrite: boolean;
  notFound: () => Response;
}

/** One /servers/{uuid}/destinations route, once handleServers has authorized it. */
export async function serverDestinationsRoute(c: ServerDestinationsCall, runner: DestinationRunner): Promise<Response> {
  const { env, orgId, requestId, uuid } = c;
  if (c.action === "scan") {
    const found = await runner(env, orgId, (ctx) => scanDestinations(ctx, uuid));
    return found ? successResponse({}, requestId) : c.notFound();
  }
  if (c.method === "GET") {
    const data = await runner(env, orgId, (ctx) => serverDestinations(ctx, uuid));
    return data ? successResponse({ ...data, canUpdate: c.canWrite }, requestId) : c.notFound();
  }
  const v = validateNewDestination(c.body);
  if (!v.ok) return validationError(requestId, v.errors);
  const created = await runner(env, orgId, (ctx) => addDestination(ctx, uuid, v.input));
  return created ? successResponse(created, requestId, 201) : c.notFound();
}
