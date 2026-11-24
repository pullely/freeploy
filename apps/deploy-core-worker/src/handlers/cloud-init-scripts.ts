// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Security/{CloudInitScripts,CloudInitScriptForm}.php,
// app/Livewire/Security/CloudInitScript/Show.php and app/Policies/CloudInitScriptPolicy.php
// (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/cloud-init-scripts — Keys & Tokens → Cloud-Init Scripts.
//
//   GET    /cloud-init-scripts               CloudInitScripts: the org's scripts, newest first (never the script)
//   POST   /cloud-init-scripts               CloudInitScriptForm::save { name, script }
//   GET    /cloud-init-scripts/{uuid}        CloudInitScript\Show (the script only for who may write)
//   PATCH  /cloud-init-scripts/{uuid}        Show::save { name, script }
//   DELETE /cloud-init-scripts/{uuid}        Show::delete / deleteScript (no body: the edge does not forward one)
//
// Coolify's policy: every ability is team admin. Here: deploy.resource.read
// for the list and a script's name, deploy.resource.write for the script's
// content and every change (authorizeDeploy, as handlePrivateKeys); a denial
// answers 404 (never leaks).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { withOrg, listCloudInitScripts as listRows, findCloudInitScriptByUuid, insertCloudInitScript, updateCloudInitScript as updateRow, deleteCloudInitScript as deleteRow } from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse, validationError } from "../http.js";
import { authorizeDeploy, columnCipher, readJson } from "./cloud-tokens.js";
import { validateScript } from "../cloud-init-scripts/validation.js";
import {
  CLOUD_INIT_MESSAGES,
  createCloudInitScript,
  deleteCloudInitScript,
  listCloudInitScripts,
  showCloudInitScript,
  updateCloudInitScript,
  type CloudInitScriptContext,
  type CloudInitScriptStore,
} from "../cloud-init-scripts/service.js";

const COLUMN = "cloud_init_scripts.script";
const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

/** Runs fn with one org's script store and cipher, in one transaction confined to that org. */
export type CloudInitScriptRunner = <T>(env: Env, orgId: string, fn: (ctx: CloudInitScriptContext) => Promise<T>) => Promise<T>;

function sqlStore(tx: SqlExecutor, orgId: string): CloudInitScriptStore {
  return {
    list: () => listRows(tx),
    findByUuid: (uuid) => findCloudInitScriptByUuid(tx, uuid),
    insert: (script) => insertCloudInitScript(tx, { ...script, orgId }),
    update: (id, changes) => updateRow(tx, id, changes),
    delete: (id) => deleteRow(tx, id),
  };
}

export const runCloudInitScriptsInOrg: CloudInitScriptRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => fn({ store: sqlStore(tx, orgId), cipher: columnCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, COLUMN) }));
  } finally {
    await db.dispose();
  }
};

/**
 * segments: what follows /cloud-init-scripts, split on "/" ([] for the collection).
 * `runner` is replaceable for tests.
 */
export async function handleCloudInitScripts(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segments: string[],
  request: Request,
  runner: CloudInitScriptRunner = runCloudInitScriptsInOrg,
): Promise<Response> {
  const method = request.method;
  const [first] = segments;
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  type Op = { write: boolean; run: (canWrite: boolean) => Promise<Response> };
  let op: Op | null = null;

  if (segments.length === 0) {
    if (method === "GET") op = { write: false, run: list };
    else if (method === "POST") op = { write: true, run: create };
  } else if (segments.length === 1 && UUID_RE.test(first!)) {
    if (method === "GET") op = { write: false, run: (canWrite) => show(first!, canWrite) };
    else if (method === "PATCH") op = { write: true, run: () => update(first!) };
    else if (method === "DELETE") op = { write: true, run: () => remove(first!) };
  } else {
    return notFound();
  }
  if (!op) return methodNotAllowed(requestId);

  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;

  async function list(canWrite: boolean): Promise<Response> {
    const scripts = await runner(env, orgId, (c) => listCloudInitScripts(c));
    return successResponse({ scripts, canWrite }, requestId);
  }

  async function create(): Promise<Response> {
    const v = validateScript(await readJson(request));
    if (!v.ok) return validationError(requestId, v.errors);
    const row = await runner(env, orgId, (c) => createCloudInitScript(c, v.input));
    return successResponse({ uuid: row.uuid, message: CLOUD_INIT_MESSAGES.created }, requestId, 201);
  }

  async function show(uuid: string, canWrite: boolean): Promise<Response> {
    const script = await runner(env, orgId, (c) => showCloudInitScript(c, uuid, canWrite));
    if (!script) return notFound();
    return successResponse({ ...script, canUpdate: canWrite }, requestId);
  }

  async function update(uuid: string): Promise<Response> {
    const v = validateScript(await readJson(request));
    if (!v.ok) return validationError(requestId, v.errors);
    const row = await runner(env, orgId, (c) => updateCloudInitScript(c, uuid, v.input));
    if (!row) return notFound();
    return successResponse({ uuid: row.uuid, message: CLOUD_INIT_MESSAGES.updated }, requestId);
  }

  async function remove(uuid: string): Promise<Response> {
    const deleted = await runner(env, orgId, (c) => deleteCloudInitScript(c, uuid));
    if (!deleted) return notFound();
    return successResponse({ deleted: true, message: CLOUD_INIT_MESSAGES.deleted }, requestId);
  }

  try {
    return await op.run(auth.canWrite);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}
