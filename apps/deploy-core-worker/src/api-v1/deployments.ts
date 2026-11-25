// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/DeployController.php (cancel_deployment, deploy,
// by_uuids, by_tags, deploy_resource, get_application_deployments, deployments, deployment_by_uuid, removeSensitiveData), app/Http/Controllers/Api/OtherController.php
// (post_required), app/Models/Application.php (deployments()), app/Models/ApplicationDeploymentQueue.php ($hidden,
// $casts), app/Support/ValidationPatterns.php (isValidDockerImageTag) and bootstrap/helpers/shared.php
// (getResourceByUuid, queryResourcesByUuid) (Apache-2.0), modified.
//
// Coolify's /api/v1 for deployments (DP-74): an application's deployments read from the queue as Coolify pages them,
// and the checks of cancelling a deployment and of deploying by uuid or tag answered as Coolify answers them. What would
// run — cancelling a queued or running deployment (the container on the server, the next deployment's job), queueing a
// deployment, starting a service or a database — answers 501 in Coolify's envelope before anything is stored, as the
// console's Deploy and Cancel do without the SSH executor (DP-70's convention). The deployments in progress and one
// deployment (DP-78) carry the deployment's application as Eloquent loads it — and, for one deployment, its environment,
// project and team (Application::team(): the team is the org as membership-worker shows it).
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { APPLICATION_MORPH_CLASS, DATABASE_ENGINES, DATABASE_TABLES, SERVICE_MORPH_CLASS, findTagByName, type ApiRow, type ApiTable } from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, coolifyTeam, obj, put, serializeApiResponse, type CoolifyAnswer, type PhpObject, type PhpValue } from "@saas/contracts/coolify-api";
import { APPLICATION_SERVICE_MESSAGES } from "../applications/service.js";
import { DATABASE_SERVICE_MESSAGES } from "../databases/service.js";
import { SERVICE_CONFIGURATION_MESSAGES } from "../services/configuration.js";
import { DEPLOYMENT_HANDLER_MESSAGES } from "../handlers/deployments.js";
import { inCoolifyOrder } from "./columns.js";
import { message, rowsOf, unavailable, type ApiV1Context } from "./context.js";
import { ENVIRONMENT, PROJECT, rowValue, toModel, type ModelShape } from "./models.js";
import { applicationRelation } from "./applications.js";
import { readApiBody } from "./request.js";
import { validateRules } from "./rules.js";

/** ApplicationDeploymentQueue: logs and the configuration hidden; the datetime casts. */
const DEPLOYMENT: ModelShape = { hidden: ["logs", "configuration_snapshot", "configuration_diff"], dates: ["created_at", "updated_at", "finished_at", "deploy_started_at"] };
/** ValidationPatterns::DOCKER_IMAGE_LITERAL_TAG_PATTERN */
const DOCKER_LITERAL_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const CANCELLABLE = ["queued", "in_progress"];
const MAX_PULL_REQUEST = 2147483647;

/** The query string as PHP reads it (the last value of a repeated name). */
function queryInput(url: URL): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  url.searchParams.forEach((value, key) => (out[key] = value));
  return out;
}

const denied = async (c: ApiV1Context, write: boolean): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized());
const phpTruthy = (v: unknown): boolean => !(v === undefined || v === null || v === false || v === 0 || v === "" || v === "0" || (Array.isArray(v) && v.length === 0));
/** PHP's (int) of a request value: the leading digits of a string. */
const phpInt = (v: unknown): number => (typeof v === "number" ? Math.trunc(v) : typeof v === "boolean" ? Number(v) : Number(/^\s*[+-]?\d+/.exec(String(v ?? ""))?.[0] ?? 0));
const phpString = (v: unknown): string => (v === null || v === undefined || v === false ? "" : v === true ? "1" : String(v));

/** routes/api.php's /deployments routes. segments: what follows /deployments. */
export async function deploymentsApi(c: ApiV1Context, segments: string[]): Promise<CoolifyAnswer | null> {
  const [first, second, third] = segments;
  if (first === undefined) return c.method === "GET" ? deploymentsInProgress(c) : null;
  if (second === undefined) return c.method === "GET" ? deploymentByUuid(c, first) : null;
  if (first === "applications" && third === undefined) return c.method === "GET" ? applicationDeployments(c, second) : null;
  if (first !== undefined && second === "cancel" && third === undefined && c.method === "POST") return cancelDeployment(c, first);
  return null;
}

/** routes/api.php's /deploy: GET answers post_required, POST deploys. */
export async function deployApi(c: ApiV1Context, segments: string[]): Promise<CoolifyAnswer | null> {
  if (segments.length) return null;
  if (c.method === "GET") return message("This endpoint has changed to a POST request.", 405);
  return c.method === "POST" ? deploy(c) : null;
}

// ── an application's deployments ────────────────────────────────────────────

/** A deployment as Eloquent's toArray() gives it (no serializeApiResponse()): logs only for a token that may read secrets. */
const deploymentModel = (c: ApiV1Context, row: ApiRow): PhpObject => toModel(inCoolifyOrder(row, "application_deployment_queues"), DEPLOYMENT, { visible: c.canReadSensitive ? ["logs"] : [] });

/** get_application_deployments: $request->validate() first, then the application, then deployments($skip, $take). */
async function applicationDeployments(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const input: Record<string, unknown> = queryInput(c.url);
  const errors: Array<[string, string[]]> = [];
  await validateRules(errors, input, [
    ["skip", ["nullable", "integer", "min:0"]],
    ["take", ["nullable", "integer", "min:1"]],
  ]);
  if (errors.length) {
    // A ValidationException: the first message and "(and N more error[s])".
    const count = errors.reduce((n, [, list]) => n + list.length, 0) - 1;
    const first = errors[0]![1][0]!;
    return coolifyJson(obj({ message: count > 0 ? `${first} (and ${count} more ${count === 1 ? "error" : "errors"})` : first, errors: obj(errors) }), 422);
  }
  const skip = "skip" in input ? phpInt(input.skip) : 0;
  const take = "take" in input ? phpInt(input.take) : 10;
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const application = (await rows("applications", "t.deleted_at IS NULL AND t.uuid = $1", [uuid]))[0];
    if (!application) return message("Application not found", 404);
    const no = await denied(c, false);
    if (no) return no;
    // ->orderBy('created_at', 'desc')->orderBy('id', 'desc')->skip($skip)->take($take)
    const all = (await rows("application_deployment_queues", "t.application_id = $1", [String(rowValue(application, "id"))])).sort((a, b) => {
      const [ca, cb] = [String(rowValue(a, "created_at") ?? ""), String(rowValue(b, "created_at") ?? "")];
      return ca !== cb ? (ca < cb ? 1 : -1) : Number(rowValue(b, "id")) - Number(rowValue(a, "id"));
    });
    return coolifyJson(obj({ count: all.length, deployments: all.slice(skip, skip + take).map((row) => deploymentModel(c, row)) }));
  });
}

// ── the deployments in progress, one deployment (DP-78) ────────────────────

/** An environment as a loaded relation, with its project and the project's team (Application::team(): environment.project.team). */
export async function environmentWithTeam(c: ApiV1Context, rows: ReturnType<typeof rowsOf>, environmentId: unknown): Promise<{ environment: PhpObject; team: PhpObject } | null> {
  const environment = (await rows("environments", "t.id = $1", [environmentId]))[0];
  const project = environment ? (await rows("projects", "t.id = $1", [rowValue(environment, "project_id")]))[0] : undefined;
  const org = project ? await c.org() : null;
  if (!environment || !project || !org) return null;
  const team = coolifyTeam(org);
  const projectModel = toModel(inCoolifyOrder([...project, ["team_id", c.orgPublicId]], "projects"), PROJECT, { extra: [["team", team]] });
  return { environment: toModel(inCoolifyOrder(environment, "environments"), ENVIRONMENT, { extra: [["project", projectModel]] }), team };
}

/** removeSensitiveData($deployment): logs only for a token that may read the application's secrets, the loaded application, then serializeApiResponse(). */
function deploymentWithApplication(c: ApiV1Context, row: ApiRow, application: PhpObject | null): PhpObject {
  const model = deploymentModel(c, row);
  put(model, "application", application);
  return serializeApiResponse(model, c.canReadSensitive);
}

/** The application a deployment belongs to (belongsTo: not a deleted one). */
async function applicationOf(rows: ReturnType<typeof rowsOf>, deployment: ApiRow): Promise<ApiRow | null> {
  const id = String(rowValue(deployment, "application_id") ?? "");
  if (!/^\d+$/.test(id)) return null;
  return (await rows("applications", "t.deleted_at IS NULL AND t.id = $1", [Number(id)]))[0] ?? null;
}

/**
 * deployments(): the queued and running deployments of the org's applications (deleted ones included:
 * applicationIdsOwnedByTeam()), by id, each with its application. A token is never limited to some resources in
 * Freeploy (DP-70), so it covers the whole team.
 */
async function deploymentsInProgress(c: ApiV1Context): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const applications = (await rows("applications")).map((a) => String(rowValue(a, "id")));
    const list = applications.length ? await rows("application_deployment_queues", "t.status IN ('in_progress', 'queued') AND t.application_id = ANY($1)", [applications]) : [];
    const out: PhpObject[] = [];
    for (const row of list) {
      const application = await applicationOf(rows, row);
      out.push(deploymentWithApplication(c, row, application ? await applicationRelation(tx, c, application) : null));
    }
    return coolifyJson(out);
  });
}

/** deployment_by_uuid(): the deployment, then its application's team (loading the environment, the project and the team). */
async function deploymentByUuid(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const deployment = (await rows("application_deployment_queues", "t.deployment_uuid = $1", [uuid]))[0];
    if (!deployment) return message("Deployment not found.", 404);
    const application = await applicationOf(rows, deployment);
    const loaded = application ? await environmentWithTeam(c, rows, rowValue(application, "environment_id")) : null;
    if (!application || !loaded) return message("Deployment not found.", 404);
    return coolifyJson(deploymentWithApplication(c, deployment, await applicationRelation(tx, c, application, { environment: loaded.environment })));
  });
}

// ── cancelling ──────────────────────────────────────────────────────────────

/**
 * cancel_deployment: the deployment, its application's team, the cancellable statuses — then Coolify marks it cancelled,
 * removes its container on the server and starts the next queued deployment; that needs the SSH executor (501).
 * A deployment of another team is not found here (row-level security), where Coolify answers 403.
 */
async function cancelDeployment(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const deployment = (await rows("application_deployment_queues", "t.deployment_uuid = $1", [uuid]))[0];
    if (!deployment) return message("Deployment not found.", 404);
    // ->application()->withTrashed(): a deleted application's deployment stays cancellable.
    const application = (await rows("applications", "t.id = $1", [phpInt(rowValue(deployment, "application_id"))]))[0];
    if (!application) return message("You do not have permission to cancel this deployment.", 403);
    const status = String(rowValue(deployment, "status") ?? "");
    if (!CANCELLABLE.includes(status)) return message(`Deployment cannot be cancelled. Current status: ${status}`, 400);
    return (await denied(c, true)) ?? unavailable(DEPLOYMENT_HANDLER_MESSAGES.cancelUnavailable);
  });
}

// ── deploying ───────────────────────────────────────────────────────────────

/** $request->input(): the body over the query string. */
async function inputOf(c: ApiV1Context): Promise<Record<string, unknown>> {
  const body = await readApiBody(c.request);
  return { ...queryInput(c.url), ...body.all };
}


/** deploy(): the checks in Coolify's order, then by_tags() or by_uuids(). */
async function deploy(c: ApiV1Context): Promise<CoolifyAnswer> {
  const input = await inputOf(c);
  const uuids = input.uuid;
  const tags = input.tag;
  const pullRequestId = "pull_request_id" in input ? input.pull_request_id : input.pr;
  const pr = phpTruthy(pullRequestId) ? Math.max(phpInt(pullRequestId), 0) : 0;
  const dockerTag = phpString(input.docker_tag).trim() || null;
  const cancelPrevious = ("cancel_previous" in input ? phpString(input.cancel_previous) : "none").trim().toLowerCase();
  if (!["none", "queued", "building"].includes(cancelPrevious)) return message("cancel_previous must be one of: none, queued, building.", 400);
  if (pr > MAX_PULL_REQUEST) return message("pull_request_id must be between 1 and 2147483647.", 400);
  if (phpTruthy(uuids) && phpTruthy(tags)) return message("You can only use uuid or tag, not both.", 400);
  if (phpTruthy(tags) && pr) return message("You can only use tag or pr, not both.", 400);
  if (dockerTag !== null && !DOCKER_LITERAL_TAG.test(dockerTag)) return message("docker_tag must be a valid Docker tag: letters, digits, underscores, periods, and dashes, at most 128 characters.", 400);
  if (dockerTag && pr === 0) return message("docker_tag requires pull_request_id.", 400);
  if (dockerTag && phpTruthy(tags)) return message("You can only use tag or docker_tag, not both.", 400);
  if (phpTruthy(tags)) return byTags(c, phpString(tags));
  if (phpTruthy(uuids)) return byUuids(c, phpString(uuids), pr, dockerTag);
  return message("You must provide uuid or tag.", 400);
}

type Resource = { kind: "application"; row: ApiRow } | { kind: "service"; row: ApiRow } | { kind: "database"; row: ApiRow };

/** getResourceByUuid(): an application, a service or a standalone database of the org (a service's database is not deployable here). */
async function resourceByUuid(tx: SqlExecutor, uuid: string): Promise<Resource | null> {
  const rows = rowsOf(tx);
  const application = (await rows("applications", "t.deleted_at IS NULL AND t.uuid = $1", [uuid]))[0];
  if (application) return { kind: "application", row: application };
  const service = (await rows("services", "t.deleted_at IS NULL AND t.uuid = $1", [uuid]))[0];
  if (service) return { kind: "service", row: service };
  for (const engine of DATABASE_ENGINES) {
    const database = (await rows(DATABASE_TABLES[engine].table as ApiTable, "t.deleted_at IS NULL AND t.uuid = $1", [uuid]))[0];
    if (database) return { kind: "database", row: database };
  }
  return null;
}

/** What deploy_resource() would run: it needs the SSH executor. */
function wouldRun(resource: Resource): CoolifyAnswer {
  if (resource.kind === "application") return unavailable(APPLICATION_SERVICE_MESSAGES.deployUnavailable);
  if (resource.kind === "service") return unavailable(SERVICE_CONFIGURATION_MESSAGES.start);
  return unavailable(DATABASE_SERVICE_MESSAGES.startUnavailable);
}

/** by_uuids(): each resource found; what Coolify answers without deploying is answered as it is, anything else 501. */
async function byUuids(c: ApiV1Context, list: string, pr: number, dockerTag: string | null): Promise<CoolifyAnswer> {
  const uuids = list.split(",").filter((u) => phpTruthy(u));
  if (uuids.length === 0) return message("No UUIDs provided.", 400);
  return c.sql(c.env, c.orgId, async (tx) => {
    const deployments: PhpObject[] = [];
    for (const uuid of uuids) {
      const resource = await resourceByUuid(tx, uuid);
      if (!resource) continue;
      if (pr !== 0) {
        if (resource.kind === "application" && rowValue(resource.row, "build_pack") === "dockerimage") {
          if (!(await c.allows(true))) {
            deployments.push(obj({ message: "Unauthorized to deploy this application.", resource_uuid: uuid }));
            continue;
          }
          // Coolify opens or updates the preview, then queues its deployment.
          return wouldRun(resource);
        }
        const preview = resource.kind === "application" ? (await tx.execute("SELECT 1 FROM deploy.application_previews WHERE application_id = $1 AND pull_request_id = $2 LIMIT 1", [rowValue(resource.row, "id"), pr])).rows.length > 0 : false;
        if (!preview) {
          deployments.push(obj({ message: `Pull request ${pr} not found for this resource.`, resource_uuid: uuid }));
          continue;
        }
      }
      // deploy_resource()
      if (!(await c.allows(true))) {
        const text = resource.kind === "application" ? "Unauthorized to deploy this application." : resource.kind === "service" ? "Unauthorized to deploy this service." : "Unauthorized to start this database.";
        deployments.push(obj({ message: text, resource_uuid: uuid }));
        continue;
      }
      if (resource.kind === "application" && dockerTag !== null && rowValue(resource.row, "build_pack") !== "dockerimage") {
        deployments.push(obj({ message: "docker_tag can only be used with Docker Image applications.", resource_uuid: uuid }));
        continue;
      }
      return wouldRun(resource);
    }
    if (deployments.length) return coolifyJson(serializeApiResponse(obj({ deployments: deployments as PhpValue })));
    return message("No resources found.", 404);
  });
}

/** by_tags(): each tag of the org, its applications and services; a tag with none of them is reported, anything else 501. */
async function byTags(c: ApiV1Context, list: string): Promise<CoolifyAnswer> {
  const tags = list.split(",").filter((t) => phpTruthy(t));
  if (tags.length === 0) return message("No TAGs provided.", 400);
  return c.sql(c.env, c.orgId, async (tx) => {
    const messages: string[] = [];
    for (const name of tags) {
      const tag = await findTagByName(tx, name);
      if (!tag) continue;
      const tagged = async (morph: string, table: string) =>
        (await tx.execute(`SELECT r.id FROM deploy.taggables tg JOIN deploy.${table} r ON r.id = tg.taggable_id WHERE tg.tag_id = $1 AND tg.taggable_type = $2 AND r.deleted_at IS NULL`, [tag.id, morph])).rows.length;
      const applications = await tagged(APPLICATION_MORPH_CLASS, "applications");
      const services = await tagged(SERVICE_MORPH_CLASS, "services");
      if (applications === 0 && services === 0) {
        messages.push(`No resources found for tag ${name}.`);
        continue;
      }
      return unavailable(applications > 0 ? APPLICATION_SERVICE_MESSAGES.deployUnavailable : SERVICE_CONFIGURATION_MESSAGES.start);
    }
    if (messages.length) return coolifyJson(serializeApiResponse(obj({ message: messages })));
    return message("No resources found with this tag.", 404);
  });
}

