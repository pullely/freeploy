// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/DatabasesController.php (logs_by_uuid),
// app/Http/Controllers/Api/ServicesController.php (logs_by_uuid) and bootstrap/helpers/docker.php
// (getCurrentDatabaseContainerStatus, getCurrentServiceSubContainerStatus) (Apache-2.0), modified.
//
// Coolify's /api/v1 for a standalone database's and a service's container logs (DP-88). Neither controller asks the
// policy. On a Swarm server the container status helpers answer an empty list without running anything, so Coolify's
// "Database is not running." and "Container not found." are replayed; on any other server they list the containers over
// SSH (docker ps), which Freeploy answers with 501 in Coolify's envelope.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import type { ApiRow } from "@saas/db/deploy";
import type { CoolifyAnswer } from "@saas/contracts/coolify-api";
import { needsExecutor } from "../applications/resources.js";
import { findApiDatabase } from "./databases.js";
import { message, rowsOf, unavailable, type ApiV1Context, type Rows } from "./context.js";
import { rowValue } from "./models.js";

export const RESOURCE_LOGS_API_MESSAGES = {
  /** Freeploy's: getCurrentDatabaseContainerStatus() and getContainerLogs() run docker on the server. */
  databaseLogsUnavailable: needsExecutor("Reading the database's container logs"),
  serviceLogsUnavailable: needsExecutor("Reading the service's container logs"),
} as const;

const SWARM_DOCKER = "App\\Models\\SwarmDocker";

/** $resource->destination->server with its settings (a StandaloneDocker's or a SwarmDocker's). */
export async function destinationServer(rows: Rows, resource: ApiRow): Promise<{ server: ApiRow | null; settings: ApiRow | undefined }> {
  const table = rowValue(resource, "destination_type") === SWARM_DOCKER ? "swarm_dockers" : "standalone_dockers";
  const destination = (await rows(table, "t.id = $1", [rowValue(resource, "destination_id")]))[0];
  const serverId = destination ? rowValue(destination, "server_id") : null;
  const server = serverId === null || serverId === undefined ? null : ((await rows("servers", "t.id = $1", [serverId]))[0] ?? null);
  const settings = server ? (await rows("server_settings", "t.server_id = $1", [rowValue(server, "id")]))[0] : undefined;
  return { server, settings };
}

/** Server::isSwarm() */
export const isSwarmSettings = (settings: ApiRow | undefined): boolean => Boolean(settings && (rowValue(settings, "is_swarm_manager") === true || rowValue(settings, "is_swarm_worker") === true));

/** GET /databases/{uuid}/logs */
export async function databaseLogs(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx: SqlExecutor) => {
    const found = await findApiDatabase(tx, uuid);
    if (!found) return message("Database not found.", 404);
    const { settings } = await destinationServer(rowsOf(tx), found.row);
    // getCurrentDatabaseContainerStatus() of a Swarm server: no containers.
    if (isSwarmSettings(settings)) return message("Database is not running.", 400);
    return unavailable(RESOURCE_LOGS_API_MESSAGES.databaseLogsUnavailable);
  });
}

/** GET /services/{uuid}/logs?sub_service_name=… */
export async function serviceLogs(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  // $request->query->get('sub_service_name'), after TrimStrings and ConvertEmptyStringsToNull; `! $name` in PHP.
  const raw = c.url.searchParams.get("sub_service_name");
  const name = raw === null ? null : raw.replace(/^[\s\u0000\u000B]+|[\s\u0000\u000B]+$/g, "");
  if (name === null || name === "" || name === "0") return message("Sub service name is required.", 400);
  return c.sql(c.env, c.orgId, async (tx: SqlExecutor) => {
    const rows = rowsOf(tx);
    // whereUuid($request->uuid): the query string's uuid before the route's.
    const service = (await rows("services", "t.deleted_at IS NULL AND t.uuid = $1", [c.url.searchParams.get("uuid") ?? uuid]))[0];
    if (!service) return message("Service not found.", 404);
    const { settings } = await destinationServer(rows, service);
    // getCurrentServiceSubContainerStatus() of a Swarm server: no containers.
    if (isSwarmSettings(settings)) return message("Container not found.", 404);
    return unavailable(RESOURCE_LOGS_API_MESSAGES.serviceLogsUnavailable);
  });
}
