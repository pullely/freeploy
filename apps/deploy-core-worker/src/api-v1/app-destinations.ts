// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/ApplicationsController.php (destinations,
// add_destination, remove_destination), app/Models/Application.php (additional_networks, additionalServersUnavailableReason,
// proxyMismatchReason) and app/Models/Server.php (canHostResources, proxyType) (Apache-2.0), modified.
//
// Coolify's /api/v1 for an application's additional destinations (DP-86), on DP-58's deploy.additional_destinations:
// listed with the primary first, attached and detached as the controller does after its own refusals (the destination
// of the org on a server that can host resources, not the primary, not attached, not on the primary's server or on a
// server already attached, an application that can use more servers and a server of the same proxy).
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { APPLICATION_MORPH_CLASS, attachAdditionalDestination, detachAdditionalDestination, type ApiRow } from "@saas/db/deploy";
import { COOLIFY_API, POLICY_DENIALS, coolifyJson, obj, type CoolifyAnswer, type PhpValue } from "@saas/contracts/coolify-api";
import { effectiveServerRole } from "../servers/service.js";
import { message, rowsOf, type ApiV1Context, type Rows } from "./context.js";
import { rowValue } from "./models.js";
import { addError, readApiBody, validationFailed, type Errors } from "./request.js";

const DESTINATION_MORPH = "App\\Models\\StandaloneDocker";
const ROUTING_PROXIES = ["TRAEFIK", "CADDY"];

export const APP_DESTINATIONS_API_MESSAGES = {
  applicationNotFound: "Application not found.",
  destinationNotFound: "Destination not found.",
  alreadyPrimary: "Destination is already the primary destination.",
  alreadyAttached: "Destination is already attached.",
  samePrimaryServer: "Cannot attach a destination on the same server as the primary destination.",
  serverAttached: "A destination on this server is already attached.",
  compose: "Docker Compose applications cannot use multiple servers.",
  storage: "Applications with persistent storage cannot use multiple servers because volumes are not shared between servers.",
  primaryRemoved: "Cannot remove the primary destination.",
  attached: "Destination attached.",
  detached: "Destination detached.",
} as const;

/** routes/api.php's /applications/{uuid}/destinations routes; null for any other path. */
export async function appDestinationsApi(c: ApiV1Context, appUuid: string, segments: string[]): Promise<CoolifyAnswer | null> {
  const [destinationUuid, extra] = segments;
  if (extra !== undefined) return null;
  if (destinationUuid === undefined) return c.method === "GET" ? listDestinations(c, appUuid) : c.method === "POST" ? addDestination(c, appUuid) : null;
  return c.method === "DELETE" ? removeDestination(c, appUuid, destinationUuid) : null;
}

const denied = async (c: ApiV1Context, write: boolean, policyMessage?: string): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized(policyMessage));

async function applicationRow(rows: Rows, uuid: string): Promise<ApiRow | null> {
  return (await rows("applications", "t.deleted_at IS NULL AND t.uuid = $1", [uuid]))[0] ?? null;
}
const serverOf = async (rows: Rows, id: unknown): Promise<ApiRow | null> => (await rows("servers", "t.deleted_at IS NULL AND t.id = $1", [id]))[0] ?? null;
const settingsOf = async (rows: Rows, serverId: unknown): Promise<ApiRow | undefined> => (await rows("server_settings", "t.server_id = $1", [serverId]))[0];

/** $application->destination (a standalone one: Freeploy makes no Swarm destination). */
async function primaryOf(rows: Rows, app: ApiRow): Promise<ApiRow | null> {
  if (rowValue(app, "destination_type") !== DESTINATION_MORPH) return null;
  return (await rows("standalone_dockers", "t.id = $1", [rowValue(app, "destination_id")]))[0] ?? null;
}

/** $application->additional_networks, with the pivot's server_id, in the pivot's order. */
async function additionalOf(rows: Rows, app: ApiRow): Promise<Array<{ pivot: ApiRow; network: ApiRow }>> {
  const out: Array<{ pivot: ApiRow; network: ApiRow }> = [];
  for (const pivot of await rows("additional_destinations", "t.application_id = $1", [rowValue(app, "id")])) {
    const network = (await rows("standalone_dockers", "t.id = $1", [rowValue(pivot, "standalone_docker_id")]))[0];
    if (network) out.push({ pivot, network });
  }
  return out;
}

async function listDestinations(c: ApiV1Context, appUuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const app = await applicationRow(rows, appUuid);
    if (!app) return message(APP_DESTINATIONS_API_MESSAGES.applicationNotFound, 404);
    const no = await denied(c, false);
    if (no) return no;
    const entry = async (network: ApiRow, serverId: unknown, primary: boolean) => {
      const server = await serverOf(rows, rowValue(network, "server_id"));
      return obj({
        uuid: rowValue(network, "uuid") as PhpValue,
        name: rowValue(network, "name") as PhpValue,
        network: (rowValue(network, "network") ?? null) as PhpValue,
        server_uuid: (server ? rowValue(server, "uuid") : null) as PhpValue,
        server_id: Number(serverId),
        is_primary: primary,
      });
    };
    const out = [];
    const primary = await primaryOf(rows, app);
    if (primary) out.push(await entry(primary, rowValue(primary, "server_id"), true));
    for (const { pivot, network } of await additionalOf(rows, app)) out.push(await entry(network, rowValue(pivot, "server_id") ?? rowValue(network, "server_id"), false));
    return coolifyJson(out);
  });
}

const proxyType = (server: ApiRow | null): unknown => {
  const proxy = server ? rowValue(server, "proxy") : null;
  return proxy !== null && typeof proxy === "object" ? (proxy as Record<string, unknown>).type : null;
};

/** StandaloneDocker::ownedByCurrentTeamAPI()->where('uuid', …)->first() */
async function destinationRow(rows: Rows, uuid: unknown): Promise<ApiRow | null> {
  return (await rows("standalone_dockers", "t.uuid = $1", [String(uuid)]))[0] ?? null;
}

async function addDestination(c: ApiV1Context, appUuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  // customApiValidator(['destination_uuid' => 'required|string']), then the fields not allowed.
  const errors: Errors = [];
  const value = body.all.destination_uuid;
  if (value === null || value === undefined) addError(errors, "destination_uuid", "This field is required.");
  else if (typeof value !== "string") addError(errors, "destination_uuid", "The destination uuid field must be a string.");
  for (const k of Object.keys(body.all)) if (k !== "destination_uuid") addError(errors, k, "This field is not allowed.");
  if (errors.length) return validationFailed(errors);
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const app = await applicationRow(rows, appUuid);
    if (!app) return message(APP_DESTINATIONS_API_MESSAGES.applicationNotFound, 404);
    const no = await denied(c, true, POLICY_DENIALS.applicationUpdate);
    if (no) return no;
    const destination = await destinationRow(rows, value);
    const server = destination ? await serverOf(rows, rowValue(destination, "server_id")) : null;
    const settings = server ? await settingsOf(rows, rowValue(server, "id")) : undefined;
    const canHost = settings !== undefined && effectiveServerRole({ server_role: rowValue(settings, "server_role") as never, is_build_server: rowValue(settings, "is_build_server") as boolean }) !== "build";
    if (!destination || !server || !canHost) return message(APP_DESTINATIONS_API_MESSAGES.destinationNotFound, 404);
    // authorize('placeResource', $destination->server)
    const again = await denied(c, true, POLICY_DENIALS.placeResource);
    if (again) return again;
    const destinationId = Number(rowValue(destination, "id"));
    if (Number(rowValue(app, "destination_id")) === destinationId && rowValue(app, "destination_type") === DESTINATION_MORPH) return message(APP_DESTINATIONS_API_MESSAGES.alreadyPrimary, 422);
    const additional = await additionalOf(rows, app);
    if (additional.some(({ network }) => Number(rowValue(network, "id")) === destinationId)) return message(APP_DESTINATIONS_API_MESSAGES.alreadyAttached, 422);
    const primary = await primaryOf(rows, app);
    const serverId = Number(rowValue(destination, "server_id"));
    if (primary && Number(rowValue(primary, "server_id")) === serverId) return message(APP_DESTINATIONS_API_MESSAGES.samePrimaryServer, 422);
    // $application->additional_servers: the servers of the pivot rows.
    if (additional.some(({ pivot }) => Number(rowValue(pivot, "server_id")) === serverId)) return message(APP_DESTINATIONS_API_MESSAGES.serverAttached, 422);
    const reason = await unavailableReason(tx, rows, app, primary, server);
    if (reason) return message(reason, 422);
    await attachAdditionalDestination(tx, c.orgId, rowValue(app, "id") as number, serverId, destinationId);
    return coolifyJson(obj({ message: APP_DESTINATIONS_API_MESSAGES.attached, uuid: rowValue(destination, "uuid") as PhpValue }), 201);
  });
}

/** additionalServersUnavailableReason($server): Compose, persistent storage, then proxyMismatchReason(). */
async function unavailableReason(tx: SqlExecutor, rows: Rows, app: ApiRow, primary: ApiRow | null, server: ApiRow): Promise<string | null> {
  if (rowValue(app, "build_pack") === "dockercompose") return APP_DESTINATIONS_API_MESSAGES.compose;
  const volumes = await tx.execute("SELECT 1 FROM deploy.local_persistent_volumes WHERE resource_type = $1 AND resource_id = $2 LIMIT 1", [APPLICATION_MORPH_CLASS, rowValue(app, "id")]);
  if (volumes.rows.length) return APP_DESTINATIONS_API_MESSAGES.storage;
  const primaryServer = primary ? await serverOf(rows, rowValue(primary, "server_id")) : null;
  const primaryProxy = proxyType(primaryServer);
  const serverProxy = proxyType(server);
  if (!ROUTING_PROXIES.includes(String(primaryProxy)) || !ROUTING_PROXIES.includes(String(serverProxy)) || primaryProxy === serverProxy) return null;
  return `The primary server uses ${String(primaryProxy)} and ${String(rowValue(server, "name"))} uses ${String(serverProxy)}. All servers of an application must use the same proxy, because they share the same proxy labels.`;
}

async function removeDestination(c: ApiV1Context, appUuid: string, destinationUuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const app = await applicationRow(rows, appUuid);
    if (!app) return message(APP_DESTINATIONS_API_MESSAGES.applicationNotFound, 404);
    const no = await denied(c, true, POLICY_DENIALS.applicationUpdate);
    if (no) return no;
    const destination = await destinationRow(rows, destinationUuid);
    if (!destination) return message(APP_DESTINATIONS_API_MESSAGES.destinationNotFound, 404);
    const destinationId = Number(rowValue(destination, "id"));
    if (Number(rowValue(app, "destination_id")) === destinationId && rowValue(app, "destination_type") === DESTINATION_MORPH) return message(APP_DESTINATIONS_API_MESSAGES.primaryRemoved, 422);
    const attached = (await additionalOf(rows, app)).find(({ network }) => Number(rowValue(network, "id")) === destinationId);
    if (!attached) return message(APP_DESTINATIONS_API_MESSAGES.destinationNotFound, 404);
    await detachAdditionalDestination(tx, rowValue(app, "id") as number, rowValue(attached.pivot, "server_id") as number, destinationId);
    return message(APP_DESTINATIONS_API_MESSAGES.detached, 200);
  });
}
