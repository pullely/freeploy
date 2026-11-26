// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/ApplicationsController.php (rollback_images,
// rollback_by_uuid), app/Actions/Application/GetRollbackImages.php (handle, allows, registryImages) and
// bootstrap/helpers/shared.php (validateGitRef) (Apache-2.0), modified.
//
// Coolify's /api/v1 for an application's rollback images and a rollback (DP-88). GetRollbackImages lists the images on a
// functional server over SSH (docker images, and the running containers' tag) before it adds the images the registry
// holds — the commits of recent successful deployments, read from the deployment queue. On a server that is not
// functional only the registry's are listed, which is ported; on a functional one Freeploy answers 501 in Coolify's
// envelope. A rollback is checked as Coolify checks it and then queued as a deployment (queue_application_deployment()),
// which needs the SSH executor: 501, and nothing is stored.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import type { ApiRow } from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, obj, type CoolifyAnswer, type PhpObject } from "@saas/contracts/coolify-api";
import { needsExecutor } from "../applications/resources.js";
import { isFunctional } from "../servers/service.js";
import { message, rowsOf, unavailable, type ApiV1Context } from "./context.js";
import { rowValue } from "./models.js";
import { destinationServer } from "./resource-logs.js";
import { addError, extraFields, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules } from "./rules.js";

export const ROLLBACK_API_MESSAGES = {
  /** Freeploy's: GetRollbackImages runs docker images on a functional server. */
  imagesUnavailable: needsExecutor("Listing the images on the server"),
  /** Freeploy's: queue_application_deployment() with rollback. */
  rollbackUnavailable: needsExecutor("Deploying the rollback"),
  notRollbackImage: "The commit is not a rollback image or a successful deployment of this application.",
} as const;

/** GetRollbackImages::REGISTRY_DEPLOYMENTS_LIMIT */
const REGISTRY_DEPLOYMENTS_LIMIT = 10;

const denied = async (c: ApiV1Context, write: boolean): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized());
const blank = (v: unknown): boolean => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/** Application::ownedByCurrentTeamAPI()->where('uuid', $request->route('uuid')) */
async function applicationRow(tx: SqlExecutor, uuid: string): Promise<ApiRow | null> {
  return (await rowsOf(tx)("applications", "t.deleted_at IS NULL AND t.uuid = $1", [uuid]))[0] ?? null;
}

/** $application->destination?->server?->isFunctional() */
async function onFunctionalServer(tx: SqlExecutor, application: ApiRow): Promise<boolean> {
  const { server, settings } = await destinationServer(rowsOf(tx), application);
  if (!server || !settings) return false;
  return isFunctional({ is_reachable: rowValue(settings, "is_reachable") as boolean, is_usable: rowValue(settings, "is_usable") as boolean, force_disabled: rowValue(settings, "force_disabled") as boolean, ip: String(rowValue(server, "ip")) });
}

/** registryImages(): the commits of the newest successful production deployments, which each pushed `<image>:<commit>`. */
async function registryImages(tx: SqlExecutor, application: ApiRow): Promise<PhpObject[]> {
  const buildPack = rowValue(application, "build_pack");
  if (blank(rowValue(application, "docker_registry_image_name")) || buildPack === "dockerimage" || buildPack === "dockercompose" || !blank(rowValue(application, "dockerfile"))) return [];
  const r = await tx.execute<{ commit: string; deployed_at: string | null }>(
    `SELECT commit, to_char(max(updated_at), 'YYYY-MM-DD HH24:MI:SS') AS deployed_at FROM deploy.application_deployment_queues
      WHERE application_id = $1 AND status = 'finished' AND pull_request_id = 0 AND commit IS NOT NULL AND commit <> 'HEAD'
      GROUP BY commit ORDER BY max(updated_at) DESC LIMIT ${REGISTRY_DEPLOYMENTS_LIMIT}`,
    [String(rowValue(application, "id"))],
  );
  // The same tag as generate_image_names(): the commit's first 128 characters. No container runs (current is null).
  return r.rows.map((d) => obj({ tag: d.commit.slice(0, 128), created_at: d.deployed_at, is_current: false, source: "registry" }));
}

/** GET /applications/{uuid}/rollback-images */
export async function rollbackImages(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const application = await applicationRow(tx, uuid);
    if (!application) return message("Application not found.", 404);
    const no = await denied(c, false);
    if (no) return no;
    if (await onFunctionalServer(tx, application)) return unavailable(ROLLBACK_API_MESSAGES.imagesUnavailable);
    return coolifyJson(obj({ current: null, images: await registryImages(tx, application) }));
  });
}

/** validateGitRef($input, 'rollback commit'): the message of the exception it throws, or null. */
function gitRefError(input: string): string | null {
  const ref = input.trim();
  if (ref === "" || ref === "HEAD") return null;
  if (ref.startsWith("-")) return "Invalid rollback commit: must not start with a hyphen.";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-/]*$/.test(ref)) return "Invalid rollback commit: contains disallowed characters. Only alphanumeric characters, dots, hyphens, underscores, and slashes are allowed.";
  return null;
}

/** POST /applications/{uuid}/rollback */
export async function rollback(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const errors: Errors = [];
  await validateRules(errors, body.all, [["commit", ["required", "string"]]]);
  extraFields(errors, body.all, ["commit"]);
  if (errors.length) return validationFailed(errors);
  return c.sql(c.env, c.orgId, async (tx) => {
    const application = await applicationRow(tx, uuid);
    if (!application) return message("Application not found.", 404);
    // $this->authorize('deploy', $application)
    const no = await denied(c, true);
    if (no) return no;
    const commit = String(body.all.commit).trim();
    const refError = gitRefError(commit);
    if (refError) {
      const e: Errors = [];
      addError(e, "commit", refError);
      return validationFailed(e);
    }
    // GetRollbackImages::allows(): a successful production deployment of the commit, or one of the listed images.
    const deployed = await tx.execute(
      "SELECT 1 FROM deploy.application_deployment_queues WHERE application_id = $1 AND status = 'finished' AND pull_request_id = 0 AND rollback = false AND commit = $2 LIMIT 1",
      [String(rowValue(application, "id")), commit],
    );
    if (deployed.rows.length === 0) {
      if (await onFunctionalServer(tx, application)) return unavailable(ROLLBACK_API_MESSAGES.imagesUnavailable);
      const images = await registryImages(tx, application);
      if (!images.some((image) => image.entries.some(([k, v]) => k === "tag" && v === commit))) {
        const e: Errors = [];
        addError(e, "commit", ROLLBACK_API_MESSAGES.notRollbackImage);
        return validationFailed(e);
      }
    }
    return unavailable(ROLLBACK_API_MESSAGES.rollbackUnavailable);
  });
}
