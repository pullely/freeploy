// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/{ApplicationsController,DatabasesController,
// ServicesController}.php (move_by_uuid, migrate_by_uuid, clone_by_uuid), app/Http/Controllers/Api/Concerns/
// RequiresDeployAbility.php and bootstrap/helpers/api.php (moveResourceToEnvironment, migrateResourceToDestination)
// (Apache-2.0), modified.
//
// Coolify's /api/v1 for moving, migrating and cloning a resource (DP-86). Moving changes an application's, a database's
// or a service's environment, as moveResourceToEnvironment() does. Migrating answers what Coolify answers outside
// development: migrateResourceToDestination() aborts with a 404 (isDev()). Cloning an application or a standalone
// database is the console's Resource Operations clone (DP-55's clone_application(), DP-64's database clone) with the
// request's name; where Coolify copies the volume data over SSH (clone_volumes with volumes to copy) or writes a managed
// file mount into the clone's directory, Freeploy answers 501 in Coolify's envelope before anything is stored. Cloning a
// service is not ported (clone_service() has no console port yet): it answers the fallback 404.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { APPLICATION_MORPH_CLASS, DATABASE_TABLES, findDatabaseByUuid, moveApplication, moveDatabase, moveService, type ApiRow, type ApiTable, type DatabaseEngine } from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, obj, type CoolifyAnswer, type PhpValue } from "@saas/contracts/coolify-api";
import { applicationResourcesContext } from "../handlers/application-resources.js";
import { databaseResourcesContext } from "../handlers/database-resources.js";
import { cloneApplicationTo, RESOURCE_OPERATION_MESSAGES } from "../applications/resource-operations.js";
import { cloneDatabaseTo } from "../databases/resources.js";
import { applicationWorkdir, databaseWorkdir, isOutsideResourceDirectory } from "../applications/storage-paths.js";
import { SettingsError, SettingsFieldErrors } from "../applications/settings.js";
import { effectiveServerRole } from "../servers/service.js";
import { newPublicId } from "../helpers/names.js";
import { hasDeployAbility, message, rowsOf, unavailable, type ApiV1Context, type Rows } from "./context.js";
import { rowValue } from "./models.js";
import { addError, cleanInput, nameRules, readApiBody, requestBoolean, validationFailed, type Errors } from "./request.js";
import { validateRules } from "./rules.js";

export type OperationKind = "application" | "database" | "service";

const RESOURCE_TYPE: Record<OperationKind, string> = { application: "Application", database: "Database", service: "Service" };
const NOT_FOUND: Record<OperationKind, string> = { application: "Application not found.", database: "Database not found.", service: "Service not found." };
const SERVER_ERROR: CoolifyAnswer = { status: 500, body: '{\n    "message": "Server Error"\n}', headers: { "content-type": "application/json" } };
/** abort(404) as Laravel's handler renders it for a JSON request. */
const ABORT_404: CoolifyAnswer = { status: 404, body: '{\n    "message": ""\n}', headers: { "content-type": "application/json" } };

export const OPERATIONS_API_MESSAGES = {
  environmentNotFound: "Target environment not found or not owned by your team.",
  destinationNotFound: "Destination not found.",
  deployForVolumes: "Missing required permissions: deploy. Cloning volume data stops and starts the source resource, so it needs a token with the deploy permission.",
  volumeDataUnavailable: RESOURCE_OPERATION_MESSAGES.volumeDataUnavailable,
  fileMountsUnavailable: RESOURCE_OPERATION_MESSAGES.fileMountsUnavailable,
} as const;

/** POST /{applications,databases,services}/{uuid}/{move,migrate,clone}; null for any other path. */
export async function operationsApi(c: ApiV1Context, kind: OperationKind, uuid: string, operation: string): Promise<CoolifyAnswer | null> {
  if (c.method !== "POST") return null;
  if (operation === "move") return move(c, kind, uuid);
  if (operation === "migrate") return migrate(c, kind, uuid);
  if (operation === "clone" && kind !== "service") return clone(c, kind, uuid);
  return null;
}

interface Resource {
  row: ApiRow;
  engine?: DatabaseEngine;
}

/** The controller's lookup: ownedByCurrentTeamAPI(), queryDatabaseByUuidWithinTeam(), the service of the team. */
async function resourceOf(tx: SqlExecutor, rows: Rows, kind: OperationKind, uuid: string): Promise<Resource | null> {
  if (kind === "application") {
    const row = (await rows("applications", "t.deleted_at IS NULL AND t.uuid = $1", [uuid]))[0];
    return row ? { row } : null;
  }
  if (kind === "service") {
    const row = (await rows("services", "t.deleted_at IS NULL AND t.uuid = $1", [uuid]))[0];
    return row ? { row } : null;
  }
  const db = await findDatabaseByUuid(tx, uuid);
  if (!db) return null;
  const row = (await rows(DATABASE_TABLES[db.engine].table as ApiTable, "t.deleted_at IS NULL AND t.uuid = $1", [uuid]))[0];
  return row ? { row, engine: db.engine } : null;
}

const denied = async (c: ApiV1Context): Promise<CoolifyAnswer | null> => ((await c.allows(true)) ? null : COOLIFY_API.unauthorized());

/** $request->all(): the JSON body, then the query string's keys the body does not have. */
async function requestAll(c: ApiV1Context): Promise<Record<string, unknown>> {
  const body = await readApiBody(c.request);
  const all: Record<string, unknown> = { ...body.all };
  const query: Record<string, string> = {};
  c.url.searchParams.forEach((v, k) => (query[k] = v));
  for (const [k, v] of Object.entries(cleanInput(query) as Record<string, unknown>)) if (!(k in all)) all[k] = v;
  return all;
}

/** move_by_uuid(), then moveResourceToEnvironment(). */
async function move(c: ApiV1Context, kind: OperationKind, uuid: string): Promise<CoolifyAnswer> {
  const all = await requestAll(c);
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const resource = await resourceOf(tx, rows, kind, uuid);
    if (!resource) return message(NOT_FOUND[kind], 404);
    const no = await denied(c);
    if (no) return no;
    const errors: Errors = [];
    await validateRules(errors, all, [["environment_uuid", ["required", "string"]]], { laravelMessages: true });
    if (errors.length) return validationFailed(errors);
    const extra = Object.keys(all).filter((k) => k !== "environment_uuid");
    if (extra.length) return coolifyJson(obj({ message: "Validation failed.", errors: obj(extra.map((k): [string, PhpValue] => [k, "This field is not allowed."])) }), 422);
    const environment = (await rows("environments", "t.uuid = $1", [String(all.environment_uuid)]))[0];
    if (!environment) return message(OPERATIONS_API_MESSAGES.environmentNotFound, 404);
    // Gate::authorize('update', $newEnvironment)
    const again = await denied(c);
    if (again) return again;
    const environmentId = rowValue(environment, "id") as number;
    if (Number(rowValue(resource.row, "environment_id")) === Number(environmentId)) return message(`${RESOURCE_TYPE[kind]} is already in this environment.`, 400);
    const id = rowValue(resource.row, "id") as number;
    if (kind === "application") await moveApplication(tx, id, environmentId);
    else if (kind === "service") await moveService(tx, id, environmentId);
    else await moveDatabase(tx, resource.engine!, id, environmentId);
    const project = (await rows("projects", "t.id = $1", [rowValue(environment, "project_id")]))[0];
    return coolifyJson(
      obj({
        message: `${RESOURCE_TYPE[kind]} moved successfully.`,
        uuid: rowValue(resource.row, "uuid") as PhpValue,
        project_uuid: (project ? rowValue(project, "uuid") : null) as PhpValue,
        environment_uuid: rowValue(environment, "uuid") as PhpValue,
      }),
    );
  });
}

/** migrate_by_uuid(): the lookup and the policy, then migrateResourceToDestination()'s abort(404) outside development. */
async function migrate(c: ApiV1Context, kind: OperationKind, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const resource = await resourceOf(tx, rowsOf(tx), kind, uuid);
    if (!resource) return message(NOT_FOUND[kind], 404);
    return (await denied(c)) ?? ABORT_404;
  });
}

/** clone_by_uuid() of an application or a standalone database. */
async function clone(c: ApiV1Context, kind: "application" | "database", uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  // customApiValidator(): destination_uuid required|string, nameRules(required: false), clone_volumes boolean; the fields not allowed.
  const errors: Errors = [];
  const destinationUuid = all.destination_uuid;
  if (destinationUuid === null || destinationUuid === undefined) addError(errors, "destination_uuid", "This field is required.");
  else if (typeof destinationUuid !== "string") addError(errors, "destination_uuid", "The destination uuid field must be a string.");
  nameRules(errors, all, "name", { required: false });
  await validateRules(errors, all, [["clone_volumes", ["boolean"]]], { laravelMessages: true });
  for (const k of Object.keys(all)) if (!["destination_uuid", "name", "clone_volumes"].includes(k)) addError(errors, k, "This field is not allowed.");
  if (errors.length) return validationFailed(errors);
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const resource = await resourceOf(tx, rows, kind, uuid);
    if (!resource) return message(NOT_FOUND[kind], 404);
    // authorize('update', $resource), then authorize('create', [..., $resource->environment]).
    const no = (await denied(c)) ?? (await denied(c));
    if (no) return no;
    const cloneVolumes = requestBoolean(all, "clone_volumes");
    if (cloneVolumes && !hasDeployAbility(c)) return message(OPERATIONS_API_MESSAGES.deployForVolumes, 403);
    const destination = (await rows("standalone_dockers", "t.uuid = $1", [destinationUuid])) [0] ?? (await rows("swarm_dockers", "t.uuid = $1", [destinationUuid]))[0];
    const server = destination ? (await rows("servers", "t.deleted_at IS NULL AND t.id = $1", [rowValue(destination, "server_id")]))[0] : undefined;
    const settings = server ? (await rows("server_settings", "t.server_id = $1", [rowValue(server, "id")]))[0] : undefined;
    if (!destination || !server || !settings || effectiveServerRole({ server_role: rowValue(settings, "server_role") as never, is_build_server: rowValue(settings, "is_build_server") as boolean }) === "build") {
      return message(OPERATIONS_API_MESSAGES.destinationNotFound, 404);
    }
    // authorize('placeResource', $destination->server)
    const again = await denied(c);
    if (again) return again;

    const cloneUuid = newPublicId();
    const owner = kind === "application" ? APPLICATION_MORPH_CLASS : DATABASE_TABLES[resource.engine!].morphClass;
    const id = rowValue(resource.row, "id");
    const volumes = await tx.execute("SELECT 1 FROM deploy.local_persistent_volumes WHERE resource_type = $1 AND resource_id = $2", [owner, id]);
    // Freeploy's: what Coolify then does on the server, refused before anything is stored.
    if (cloneVolumes && volumes.rows.length > 0) return unavailable(OPERATIONS_API_MESSAGES.volumeDataUnavailable);
    const files = await tx.execute<{ fs_path: string; is_host_file: boolean }>("SELECT fs_path, is_host_file FROM deploy.local_file_volumes WHERE resource_type = $1 AND resource_id = $2", [owner, id]);
    const workdir = kind === "application" ? applicationWorkdir(cloneUuid) : databaseWorkdir(cloneUuid);
    if (files.rows.some((f) => !f.is_host_file && !isOutsideResourceDirectory(f.fs_path, workdir))) return unavailable(OPERATIONS_API_MESSAGES.fileMountsUnavailable);

    const name = typeof all.name === "string" && all.name.trim() !== "" ? all.name : undefined;
    const opts = { uuid: cloneUuid, ...(name === undefined ? {} : { name }) };
    try {
      const result =
        kind === "application"
          ? await cloneApplicationTo(applicationResourcesContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY), uuid, { destination_uuid: destinationUuid }, opts)
          : await cloneDatabaseTo(await databaseResourcesContext(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, uuid), uuid, { destination_uuid: destinationUuid }, opts);
      if (!result) return message(NOT_FOUND[kind], 404);
    } catch (e) {
      // Two volumes of the source under one name in the clone: Coolify's unique index, its error page.
      if (e instanceof SettingsError || e instanceof SettingsFieldErrors) return SERVER_ERROR;
      throw e;
    }
    return coolifyJson(obj({ uuid: cloneUuid, message: `${RESOURCE_TYPE[kind]} cloned.` }), 201);
  });
}
