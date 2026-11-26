// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/DestinationsController.php (transform,
// teamScopedDockers, findDestinationForTeam, index, index_by_server, show, create, existingServerNetworkResponse,
// update, delete), app/Models/{StandaloneDocker,SwarmDocker,Server}.php (attachedTo, isSwarm, isFunctional,
// HasSafeStringAttribute) and app/Actions/Destination/RemoveStandaloneDockerNetwork.php (Apache-2.0), modified.
//
// Coolify's /api/v1 for destinations (DP-85), on the destination store the console's Destinations pages use (packages/db's
// deploy/destinations.ts). What runs on the server answers 501 in Coolify's envelope after Coolify's own refusals and
// before anything is stored: creating a standalone destination on a functional server (Coolify first lists the server's
// Docker networks over SSH, then its created hook makes the network) and deleting one with no resources (docker network
// rm). A Swarm destination is a row on both sides. A model Coolify does not find is Laravel's 404 for it, pretty-printed
// as Coolify's exception handler renders it.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  DESTINATION_TYPES,
  deleteDestination,
  destinationIsAttached,
  destinationNetworkExists,
  findDestinationByUuid,
  insertDestination,
  listServerDestinations,
  updateDestinationName,
  type DeployDestinationRow,
  type DestinationType,
} from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, laravelDate, obj, type CoolifyAnswer, type PhpObject } from "@saas/contracts/coolify-api";
import { needsExecutor } from "../applications/resources.js";
import { stripTags } from "../applications/tags.js";
import { newPublicId } from "../helpers/names.js";
import { functional } from "./applications.js";
import { message, rowsOf, unavailable, type ApiV1Context } from "./context.js";
import { rowValue } from "./models.js";
import { addError, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rule } from "./rules.js";

export const DESTINATIONS_API_MESSAGES = {
  /** Freeploy's: what Coolify runs on the server. */
  createUnavailable: needsExecutor("Creating the Docker network on the server"),
  deleteUnavailable: needsExecutor("Removing the Docker network from the server"),
} as const;

/** Docker's built-in networks. */
const RESERVED_NETWORK_NAMES = ["bridge", "host", "none"];

/** firstOrFail()'s ModelNotFoundException as Coolify's handler renders it for the API. */
const modelNotFound = (model: "Server" | "SwarmDocker"): CoolifyAnswer => ({
  status: 404,
  body: `{\n    "message": "No query results for model [App\\\\Models\\\\${model}]."\n}`,
  headers: { "content-type": "application/json" },
});

const denied = async (c: ApiV1Context, write: boolean, policyMessage?: string): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized(policyMessage));

/** transform() */
function transform(d: DeployDestinationRow): PhpObject {
  return obj({ uuid: d.uuid, name: d.name, network: d.network, type: d.type, server_uuid: d.server_uuid, created_at: laravelDate(d.created_at), updated_at: laravelDate(d.updated_at) });
}

/** routes/api.php's /destinations routes. segments: what follows /destinations. */
export async function destinationsApi(c: ApiV1Context, segments: string[]): Promise<CoolifyAnswer | null> {
  const [uuid, extra] = segments;
  const m = c.method;
  if (extra !== undefined) return null;
  if (uuid === undefined) return m === "GET" ? listDestinations(c) : null;
  if (m === "GET") return showDestination(c, uuid);
  if (m === "PATCH") return updateDestination(c, uuid);
  if (m === "DELETE") return deleteDestinationRoute(c, uuid);
  return null;
}

/** routes/api.php's /servers/{server_uuid}/destinations routes. */
export async function serverDestinationsApi(c: ApiV1Context, serverUuid: string, segments: string[]): Promise<CoolifyAnswer | null> {
  if (segments.length) return null;
  if (c.method === "GET") return listServerDestinationsRoute(c, serverUuid);
  if (c.method === "POST") return createDestination(c, serverUuid);
  return null;
}

/** teamScopedDockers(): the org's standalone destinations, then its Swarm ones (their servers not deleted). */
async function listDestinations(c: ApiV1Context): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const out: DeployDestinationRow[] = [];
    for (const type of DESTINATION_TYPES) {
      const r = await tx.execute<DeployDestinationRow>(
        `SELECT d.id, d.uuid, d.name, d.network, '${type}'::text AS type, d.server_id, s.uuid AS server_uuid, d.created_at, d.updated_at
           FROM deploy.${TABLES[type]} d JOIN deploy.servers s ON s.id = d.server_id AND s.deleted_at IS NULL ORDER BY d.id`,
      );
      out.push(...r.rows);
    }
    return coolifyJson(out.map(transform));
  });
}

const TABLES: Record<DestinationType, string> = { standalone: "standalone_dockers", swarm: "swarm_dockers" };

/** Server::whereTeamId()->whereUuid()->firstOrFail(): the org's server, not deleted. */
async function serverRow(tx: SqlExecutor, uuid: string) {
  const rows = rowsOf(tx);
  const server = (await rows("servers", "t.deleted_at IS NULL AND t.uuid = $1", [uuid]))[0] ?? null;
  const settings = server ? (await rows("server_settings", "t.server_id = $1", [rowValue(server, "id")]))[0] : undefined;
  return { server, settings };
}

async function listServerDestinationsRoute(c: ApiV1Context, serverUuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const { server } = await serverRow(tx, serverUuid);
    if (!server) return modelNotFound("Server");
    return coolifyJson((await listServerDestinations(tx, rowValue(server, "id") as string | number)).map(transform));
  });
}

async function showDestination(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const found = await findDestinationByUuid(tx, uuid);
    return found ? coolifyJson(transform(found)) : modelNotFound("SwarmDocker");
  });
}

/** customApiValidator() and every field that is not allowed. */
async function validate(all: Record<string, unknown>, rules: Array<[string, Rule[]]>, allowed: readonly string[]): Promise<CoolifyAnswer | null> {
  const errors: Errors = [];
  await validateRules(errors, all, rules);
  for (const k of Object.keys(all)) if (!allowed.includes(k)) addError(errors, k, "This field is not allowed.");
  return errors.length ? validationFailed(errors) : null;
}

/** `in:standalone,swarm` */
const typeRule: Rule = { closure: (v) => (typeof v === "string" && (v === "standalone" || v === "swarm") ? [] : ["The selected type is invalid."]) };

async function createDestination(c: ApiV1Context, serverUuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  return c.sql(c.env, c.orgId, async (tx) => {
    const { server, settings } = await serverRow(tx, serverUuid);
    if (!server) return modelNotFound("Server");
    const invalid = await validate(
      all,
      [
        ["name", ["nullable", "string", "max:255"]],
        ["network", ["required", "string", "max:255", { regex: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ }]],
        ["type", ["nullable", typeRule]],
      ],
      ["name", "network", "type"],
    );
    if (invalid) return invalid;
    const network = String(all.network);
    if (RESERVED_NETWORK_NAMES.includes(network.toLowerCase())) return validationFailed([["network", ["The network name is reserved by Docker. Use a different name."]]]);
    const isSwarm = settings !== undefined && (rowValue(settings, "is_swarm_manager") === true || rowValue(settings, "is_swarm_worker") === true);
    const expected: DestinationType = isSwarm ? "swarm" : "standalone";
    // $request->input('type', $expectedType): a type sent as null is not the default.
    const type = "type" in all ? all.type : expected;
    if (type !== expected) return message(`Destination type must be ${expected} for this server.`, 422);
    const name = typeof all.name === "string" && all.name !== "" && all.name !== "0" ? all.name : `${String(rowValue(server, "name"))}-${network}`;
    const no = await denied(c, true);
    if (no) return no;
    const serverId = rowValue(server, "id") as string | number;
    if (await destinationNetworkExists(tx, expected, serverId, network)) return message("A destination with this network already exists on the server.", 409);
    if (expected === "standalone") {
      // existingServerNetworkResponse(): a server that is not functional, else `docker network ls` over SSH.
      if (!functional(server, settings)) return message("Server is not functional.", 400);
      return unavailable(DESTINATIONS_API_MESSAGES.createUnavailable);
    }
    // SwarmDocker has no HasSafeStringAttribute: its name is stored as given.
    const created = await insertDestination(tx, { orgId: c.orgId, type: expected, uuid: newPublicId(), name, network, serverId });
    return coolifyJson(transform(created), 201);
  });
}

async function updateDestination(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  const invalid = await validate(all, [["name", ["required", "string", "max:255"]]], ["name"]);
  if (invalid) return invalid;
  return c.sql(c.env, c.orgId, async (tx) => {
    const found = await findDestinationByUuid(tx, uuid);
    if (!found) return modelNotFound("SwarmDocker");
    const no = await denied(c, true);
    if (no) return no;
    // StandaloneDocker's HasSafeStringAttribute: strip_tags() on the name; update() writes only a changed name.
    const name = found.type === "standalone" ? stripTags(String(all.name)) : String(all.name);
    if (name !== found.name) await updateDestinationName(tx, found.type, found.id, name);
    return coolifyJson(transform((await findDestinationByUuid(tx, uuid))!));
  });
}

async function deleteDestinationRoute(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const found = await findDestinationByUuid(tx, uuid);
    if (!found) return modelNotFound("SwarmDocker");
    const no = await denied(c, true);
    if (no) return no;
    if (await destinationIsAttached(tx, found.type, found.id)) return message("Destination has attached resources, detach first.", 409);
    // RemoveStandaloneDockerNetwork runs docker network rm on the server.
    if (found.type === "standalone") return unavailable(DESTINATIONS_API_MESSAGES.deleteUnavailable);
    await deleteDestination(tx, found.type, found.id);
    return message("Deleted.", 200);
  });
}
