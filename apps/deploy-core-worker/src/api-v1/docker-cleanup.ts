// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/ServerDockerCleanupController.php (findServerForTeam,
// transform, show, update, run, executions), app/Http/Controllers/Api/Concerns/RequiresDeployAbility.php,
// app/Models/ServerSetting.php (the docker_cleanup_frequency mutator, the casts) and bootstrap/helpers/shared.php
// (validate_cron_expression) (Apache-2.0), modified.
//
// Coolify's /api/v1 for a server's Docker cleanup (DP-85), on the server settings row the console's Docker Cleanup page
// writes (packages/db's deploy/server-settings.ts) and DP-68's cron validator. Running a cleanup now (DockerCleanupJob:
// docker prune on the server) answers 501 in Coolify's envelope after Coolify's own refusals.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { updateServerSettings, type ApiRow, type ServerSettingsPageChanges } from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, laravelDate, obj, sqlDate, type CoolifyAnswer, type PhpObject } from "@saas/contracts/coolify-api";
import { needsExecutor } from "../applications/resources.js";
import { translateCronExpression } from "../helpers/cron-presets.js";
import { validateCronExpression } from "../servers/settings-validation.js";
import { hasDeployAbility, message, rowsOf, unavailable, type ApiV1Context } from "./context.js";
import { rowValue } from "./models.js";
import { addError, readApiBody, requestBoolean, validationFailed, type Errors } from "./request.js";
import { validateRules } from "./rules.js";

export const DOCKER_CLEANUP_API_MESSAGES = {
  /** Freeploy's: DockerCleanupJob prunes Docker on the server. */
  runUnavailable: needsExecutor("Running the Docker cleanup on the server"),
  volumesNeedDeploy: "Missing required permissions: deploy. Deleting unused volumes removes data on the server, so it needs a token with the deploy permission.",
  badFrequency: "Invalid Cron / Human expression for Docker Cleanup Frequency.",
} as const;

const ALLOWED_FIELDS = ["docker_cleanup_frequency", "docker_cleanup_threshold", "force_docker_cleanup", "delete_unused_volumes", "delete_unused_networks", "disable_application_image_retention"] as const;
const BOOLEAN_FIELDS = ["force_docker_cleanup", "delete_unused_volumes", "delete_unused_networks", "disable_application_image_retention"] as const;

const denied = async (c: ApiV1Context, write: boolean, policyMessage?: string): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized(policyMessage));

/** routes/api.php's /servers/{uuid}/docker-cleanup routes. segments: what follows /docker-cleanup. */
export async function dockerCleanupApi(c: ApiV1Context, uuid: string, segments: string[]): Promise<CoolifyAnswer | null> {
  const [sub, extra] = segments;
  const m = c.method;
  if (extra !== undefined) return null;
  if (sub === undefined) return m === "GET" ? show(c, uuid) : m === "PATCH" ? update(c, uuid) : null;
  if (sub === "run") return m === "POST" ? run(c, uuid) : null;
  if (sub === "executions") return m === "GET" ? executions(c, uuid) : null;
  return null;
}

/** `$request->uuid`: Laravel reads the input (the body, then the query string) before the route parameter. */
function routeUuid(c: ApiV1Context, all: Record<string, unknown>, route: string): string {
  if ("uuid" in all) return typeof all.uuid === "string" ? all.uuid : String(all.uuid ?? "");
  return c.url.searchParams.get("uuid") ?? route;
}

/** findServerForTeam(): Server::whereTeamId()->whereUuid()->first() — the org's server, not deleted — and its settings. */
async function serverWithSettings(c: ApiV1Context, tx: SqlExecutor, uuid: string): Promise<{ server: ApiRow; settings: ApiRow | undefined } | null> {
  const rows = rowsOf(tx);
  const server = (await rows("servers", "t.deleted_at IS NULL AND t.uuid = $1", [uuid]))[0];
  if (!server) return null;
  const settings = (await rows("server_settings", "t.server_id = $1", [rowValue(server, "id")]))[0];
  return { server, settings };
}

/** transform() */
function transform(settings: ApiRow | undefined): PhpObject {
  const v = (k: string) => (settings ? rowValue(settings, k) : null);
  return obj({
    docker_cleanup_frequency: (v("docker_cleanup_frequency") as string | null) ?? null,
    docker_cleanup_threshold: Math.trunc(Number(v("docker_cleanup_threshold") ?? 0)),
    force_docker_cleanup: v("force_docker_cleanup") === true,
    delete_unused_volumes: v("delete_unused_volumes") === true,
    delete_unused_networks: v("delete_unused_networks") === true,
    disable_application_image_retention: v("disable_application_image_retention") === true,
  });
}

const notFound = () => message("Server not found.", 404);

async function show(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const found = await serverWithSettings(c, tx, routeUuid(c, {}, uuid));
    if (!found) return notFound();
    return (await denied(c, false)) ?? coolifyJson(transform(found.settings));
  });
}

/** customApiValidator()'s rules and every field that is not allowed. */
async function validate(all: Record<string, unknown>, rules: Parameters<typeof validateRules>[2], allowed: readonly string[]): Promise<CoolifyAnswer | null> {
  const errors: Errors = [];
  await validateRules(errors, all, rules);
  for (const k of Object.keys(all)) if (!allowed.includes(k)) addError(errors, k, "This field is not allowed.");
  return errors.length ? validationFailed(errors) : null;
}

async function update(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  return c.sql(c.env, c.orgId, async (tx) => {
    const found = await serverWithSettings(c, tx, routeUuid(c, all, uuid));
    if (!found) return notFound();
    const no = await denied(c, true);
    if (no) return no;
    const invalid = await validate(
      all,
      [
        ["docker_cleanup_frequency", ["string"]],
        ["docker_cleanup_threshold", ["integer", "min:1", "max:99"]],
        ...BOOLEAN_FIELDS.map((f): [string, ["boolean"]] => [f, ["boolean"]]),
      ],
      ALLOWED_FIELDS,
    );
    if (invalid) return invalid;
    if ("docker_cleanup_frequency" in all && !validateCronExpression(all.docker_cleanup_frequency)) return validationFailed([["docker_cleanup_frequency", [DOCKER_CLEANUP_API_MESSAGES.badFrequency]]]);
    const volumesOn = found.settings ? rowValue(found.settings, "delete_unused_volumes") === true : false;
    if (requestBoolean(all, "delete_unused_volumes") && !volumesOn && !hasDeployAbility(c)) return message(DOCKER_CLEANUP_API_MESSAGES.volumesNeedDeploy, 403);
    // $settings->{$field} = $request->input($field) for each field sent, then save(): the frequency mutator translates a preset.
    const changes: ServerSettingsPageChanges = {};
    const set = changes as Record<string, unknown>;
    for (const field of ALLOWED_FIELDS) {
      if (!(field in all)) continue;
      const value = all[field];
      if (field === "docker_cleanup_frequency") set[field] = value === null ? null : translateCronExpression(String(value));
      else if (field === "docker_cleanup_threshold") set[field] = value === null ? null : Math.trunc(Number(value));
      else set[field] = value === null ? null : requestBoolean(all, field);
    }
    await updateServerSettings(tx, rowValue(found.server, "id") as string | number, changes);
    const fresh = await serverWithSettings(c, tx, String(rowValue(found.server, "uuid")));
    return coolifyJson(transform(fresh!.settings));
  });
}

async function run(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  const all = body.isJson ? body.all : {};
  return c.sql(c.env, c.orgId, async (tx) => {
    const found = await serverWithSettings(c, tx, routeUuid(c, all, uuid));
    if (!found) return notFound();
    const no = await denied(c, true);
    if (no) return no;
    const invalid = await validate(all, [["delete_unused_volumes", ["boolean"]], ["delete_unused_networks", ["boolean"]]], ["delete_unused_volumes", "delete_unused_networks"]);
    if (invalid) return invalid;
    // DockerCleanupJob::dispatch(): it prunes on the server.
    return unavailable(DOCKER_CLEANUP_API_MESSAGES.runUnavailable);
  });
}

async function executions(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const found = await serverWithSettings(c, tx, routeUuid(c, {}, uuid));
    if (!found) return notFound();
    const no = await denied(c, false);
    if (no) return no;
    // ->orderBy('created_at', 'desc')->take(20); finished_at has no cast.
    const r = await tx.execute<{ uuid: string; status: string; message: string | null; finished_at: string | Date | null; created_at: string | Date | null; updated_at: string | Date | null }>(
      "SELECT uuid, status, message, finished_at, created_at, updated_at FROM deploy.docker_cleanup_executions WHERE server_id = $1 ORDER BY created_at DESC LIMIT 20",
      [rowValue(found.server, "id")],
    );
    return coolifyJson(r.rows.map((x) => obj({ uuid: x.uuid, status: x.status, message: x.message, finished_at: sqlDate(x.finished_at), created_at: laravelDate(x.created_at), updated_at: laravelDate(x.updated_at) })));
  });
}
