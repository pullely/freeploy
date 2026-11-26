// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/ResourcesController.php (resources),
// app/Http/Controllers/Api/ProjectController.php (environment_details), bootstrap/helpers/api.php
// (serializeApiResource, exposeSensitiveFields, redactLockedApiResourceValues) and the models' type() (Apache-2.0),
// modified.
//
// Coolify's /api/v1 for every resource of the team and an environment's resources (DP-78): each resource through
// serializeApiResource() — Eloquent's toArray() unsorted, every hidden attribute made visible for a token that may
// read secrets, the locked values redacted — built by the groups' own serializations (applications.ts, services.ts,
// databases.ts) in their unsorted form.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { DATABASE_ENGINES, DATABASE_TABLES, type ApiRow, type ApiTable, type DatabaseEngine } from "@saas/db/deploy";
import { coolifyJson, put, removeServerProxySecrets, serializeApiResponse, type CoolifyAnswer, type PhpObject, type PhpValue } from "@saas/contracts/coolify-api";
import { DATABASE_ENGINE_SPECS } from "../databases/engines.js";
import { applicationRelation } from "./applications.js";
import { databaseResource } from "./databases.js";
import { serviceResource } from "./services.js";
import { message, rowsOf, type ApiV1Context, type Rows } from "./context.js";
import { ENVIRONMENT, rowValue, toModel } from "./models.js";
import { inCoolifyOrder } from "./columns.js";

/** In an environment, by its relation name (environment_details() loads these seven, in this order). */
const ENVIRONMENT_RELATIONS: Array<[string, "applications" | "services" | DatabaseEngine]> = [
  ["applications", "applications"],
  ["postgresqls", "postgresql"],
  ["redis", "redis"],
  ["mongodbs", "mongodb"],
  ["mysqls", "mysql"],
  ["mariadbs", "mariadb"],
  ["services", "services"],
];

const IN_ENVIRONMENTS_OF_PROJECT = "t.deleted_at IS NULL AND t.environment_id IN (SELECT e.id FROM deploy.environments e WHERE e.project_id = $1)";
const IN_ENVIRONMENT = "t.deleted_at IS NULL AND t.environment_id = $1";

/** One kind of resource, in serializeApiResource()'s form. */
async function resourcesOf(tx: SqlExecutor, c: ApiV1Context, rows: Rows, kind: "applications" | "services" | DatabaseEngine, where: string, id: unknown, throughKey?: unknown): Promise<PhpObject[]> {
  const out: PhpObject[] = [];
  if (kind === "applications") {
    for (const row of await rows("applications", where, [id])) out.push(await applicationRelation(tx, c, row, { resource: true, throughKey }));
  } else if (kind === "services") {
    for (const row of await rows("services", where, [id])) out.push(await serviceResource(tx, c, row, throughKey));
  } else {
    for (const row of await rows(DATABASE_TABLES[kind].table as ApiTable, where, [id])) {
      const model = await databaseResource(tx, c, kind, row, throughKey);
      if (model) out.push(model);
    }
  }
  return out;
}

/** A model's type(): "application", "service", "standalone-<engine>". */
const typeOf = (kind: "applications" | "services" | DatabaseEngine): string => (kind === "applications" ? "application" : kind === "services" ? "service" : DATABASE_ENGINE_SPECS[kind].databaseType);

/**
 * resources(): the team's projects, then their applications, their services and their databases engine by engine
 * (DATABASE_TYPES' order, SQLite last since DP-112), each read through the project (hasManyThrough: laravel_through_key)
 * with its status and type. serializeApiResponse() of the list leaves the items as they are but for the server secrets.
 */
export async function listResources(c: ApiV1Context): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const projects = await rows("projects");
    const out: PhpObject[] = [];
    for (const kind of ["applications", "services", ...DATABASE_ENGINES] as const) {
      for (const project of projects) {
        const projectId = rowValue(project, "id");
        for (const model of await resourcesOf(tx, c, rows, kind, IN_ENVIRONMENTS_OF_PROJECT, projectId, projectId)) out.push(put(model, "type", typeOf(kind)));
      }
    }
    return coolifyJson(c.canReadSensitive ? out : (removeServerProxySecrets(out) as PhpValue));
  });
}

/** environment_details(): the project, the environment by name then by uuid, then its resources. */
export async function environmentDetails(c: ApiV1Context, projectUuid: string, nameOrUuid: string, authorize: () => Promise<CoolifyAnswer | null>): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const project = (await rows("projects", "t.uuid = $1", [projectUuid]))[0];
    if (!project) return message("Project not found.", 404);
    const denied = await authorize();
    if (denied) return denied;
    const environments = await rows("environments", "t.project_id = $1", [rowValue(project, "id")]);
    const environment = environments.find((e) => rowValue(e, "name") === nameOrUuid) ?? environments.find((e) => rowValue(e, "uuid") === nameOrUuid);
    if (!environment) return message("Environment not found.", 404);
    const payload = toModel(inCoolifyOrder(environment as ApiRow, "environments"), ENVIRONMENT);
    for (const [relation, kind] of ENVIRONMENT_RELATIONS) put(payload, relation, await resourcesOf(tx, c, rows, kind, IN_ENVIRONMENT, rowValue(environment, "id")));
    return coolifyJson(serializeApiResponse(payload, c.canReadSensitive));
  });
}

