// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/CloudInitScriptsController.php (removeSensitiveData,
// index, store, show, update, destroy), app/Models/CloudInitScript.php ($fillable, $hidden, the encrypted cast),
// app/Policies/CloudInitScriptPolicy.php and app/Rules/ValidCloudInitYaml.php (Apache-2.0), modified.
//
// Coolify's /api/v1 for the org's cloud-init scripts (DP-110), on the rows the console's Cloud-Init Scripts pages write
// (security.cloud-init-scripts: packages/db's deploy/cloud-init-scripts.ts, the script encrypted with the org's key under the
// same column context, "cloud_init_scripts.script"). Every ability of the policy is a team admin's (isAdmin(),
// isAdminOfTeam()), so each is policy-worker's deploy.resource.write. The script is answered only to a token that may read
// secrets, as removeSensitiveData() makes it visible. ValidCloudInitYaml is the console's (../cloud-init-scripts/validation.ts:
// Symfony's parse errors, DP-110's port), so both refuse the same scripts with the same words.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { deleteCloudInitScript, insertCloudInitScript, type ApiRow } from "@saas/db/deploy";
import { coolifyJson, serializeApiResponse, type CoolifyAnswer, type PhpObject } from "@saas/contracts/coolify-api";
import { columnCipher } from "../handlers/cloud-tokens.js";
import { newPublicId } from "../helpers/names.js";
import { validCloudInitYaml } from "../cloud-init-scripts/validation.js";
import { policyDenied } from "./cloud-provider-tokens.js";
import { message, rowsOf, type ApiV1Context } from "./context.js";
import { rowValue, toModel, type ModelShape } from "./models.js";
import { extraFields, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rule } from "./rules.js";

/** $hidden (script) and removeSensitiveData()'s makeHidden(['id', 'team_id']). */
const CLOUD_INIT_SCRIPT: ModelShape = { hidden: ["id", "script"], dates: ["created_at", "updated_at"] };
const COLUMN = "cloud_init_scripts.script";
const NOW = "date_trunc('second', timezone('UTC', now()))";
const ALLOWED = ["name", "script"];

export const CLOUD_INIT_SCRIPT_MESSAGES = {
  notFound: "Cloud-init script not found.",
  nothing: "At least one field must be provided.",
  deleted: "Cloud-init script deleted.",
} as const;

export const scriptCipher = (tx: SqlExecutor, c: ApiV1Context) => columnCipher(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, COLUMN);
const denied = async (c: ApiV1Context): Promise<CoolifyAnswer | null> => ((await c.allows(true)) ? null : policyDenied());
const notFound = () => message(CLOUD_INIT_SCRIPT_MESSAGES.notFound, 404);

/**
 * new ValidCloudInitYaml, as a rule of Laravel's validator: it runs on whatever value the field has (the rules before it do
 * not stop it), with ":attribute" as Laravel fills it in. trim() of an array is PHP's TypeError, which the exception
 * handler answers 500 (the caller's).
 */
export function cloudInitYamlRule(attribute: string): Rule {
  return {
    closure: (value) => {
      // empty($value): an empty array too.
      if (value === null || value === undefined || value === false || value === 0 || value === "" || value === "0") return [];
      if (typeof value === "object" && Object.keys(value).length === 0) return [];
      if (typeof value === "object") throw new CloudInitTypeError();
      const text = value === true ? "1" : String(value);
      const failure = validCloudInitYaml(text);
      return failure === null ? [] : [failure.replaceAll(":attribute", attribute)];
    },
  };
}

/** trim(): Argument #1 ($string) must be of type string, array given. */
export class CloudInitTypeError extends Error {}

/** routes/api.php's /cloud-init-scripts routes; null for every other path (the caller answers the fallback 404). */
export async function cloudInitScriptsApi(c: ApiV1Context, segments: string[]): Promise<CoolifyAnswer | null> {
  const [uuid, extra] = segments;
  const m = c.method;
  if (extra !== undefined) return null;
  if (uuid === undefined) return m === "GET" ? list(c) : m === "POST" ? store(c) : null;
  return m === "GET" ? show(c, uuid) : m === "PATCH" ? update(c, uuid) : m === "DELETE" ? destroy(c, uuid) : null;
}

/** CloudInitScript::where('team_id', …)->where('uuid', …)->first(): row-level security confines it to the org. */
async function scriptRow(tx: SqlExecutor, uuid: string): Promise<ApiRow | null> {
  return (await rowsOf(tx)("cloud_init_scripts", "t.uuid = $1", [uuid]))[0] ?? null;
}

/** removeSensitiveData(): the script (decrypted) for a token that may read secrets; serializeApiResponse(). */
async function serialize(tx: SqlExecutor, c: ApiV1Context, row: ApiRow): Promise<PhpObject> {
  const shown: ApiRow = c.canReadSensitive ? await Promise.all(row.map(async ([k, v]): Promise<[string, unknown]> => [k, k === "script" ? await scriptCipher(tx, c).decrypt(String(v)) : v])) : row;
  return serializeApiResponse(toModel(shown, CLOUD_INIT_SCRIPT, { visible: c.canReadSensitive ? ["script"] : [] }));
}

async function list(c: ApiV1Context): Promise<CoolifyAnswer> {
  // $this->authorize('viewAny', CloudInitScript::class)
  const no = await denied(c);
  if (no) return no;
  return c.sql(c.env, c.orgId, async (tx) => {
    // ->orderByDesc('created_at'): PostgreSQL's order within one second is the rows' (the newer id first, as the console's list).
    const ids = (await tx.execute<{ id: string }>("SELECT id::text AS id FROM deploy.cloud_init_scripts ORDER BY created_at DESC NULLS FIRST, id DESC")).rows.map((r) => r.id);
    const rows = await rowsOf(tx)("cloud_init_scripts");
    const out: PhpObject[] = [];
    for (const id of ids) {
      const row = rows.find((r) => String(rowValue(r, "id")) === id);
      if (row) out.push(await serialize(tx, c, row));
    }
    return coolifyJson(out);
  });
}

/** customApiValidator(): the rules, then the fields not allowed. */
async function validate(all: Record<string, unknown>, rules: Array<[string, readonly Rule[]]>): Promise<Errors> {
  const errors: Errors = [];
  await validateRules(errors, all, rules);
  extraFields(errors, all, ALLOWED);
  return errors;
}

async function store(c: ApiV1Context): Promise<CoolifyAnswer> {
  // $this->authorize('create', CloudInitScript::class) before the body is read.
  const no = await denied(c);
  if (no) return no;
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  const errors = await validate(all, [
    ["name", ["required", "string", "max:255"]],
    ["script", ["required", "string", cloudInitYamlRule("script")]],
  ]);
  if (errors.length) return validationFailed(errors);
  return c.sql(c.env, c.orgId, async (tx) => {
    const created = await insertCloudInitScript(tx, { orgId: c.orgId, uuid: newPublicId(), name: all.name as string, script: await scriptCipher(tx, c).encrypt(all.script as string) });
    const row = await scriptRow(tx, created.uuid!);
    return coolifyJson(await serialize(tx, c, row!), 201);
  });
}

async function show(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const row = await scriptRow(tx, uuid);
    if (!row) return notFound();
    const no = await denied(c);
    return no ?? coolifyJson(await serialize(tx, c, row));
  });
}

async function update(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  if (Object.keys(all).length === 0) return message(CLOUD_INIT_SCRIPT_MESSAGES.nothing, 422);
  return c.sql(c.env, c.orgId, async (tx) => {
    const row = await scriptRow(tx, uuid);
    if (!row) return notFound();
    const no = await denied(c);
    if (no) return no;
    const errors = await validate(all, [
      ["name", ["string", "max:255"]],
      ["script", ["string", cloudInitYamlRule("script")]],
    ]);
    if (errors.length) return validationFailed(errors);
    // $script->update($request->only(['name', 'script'])): saved, and updated_at touched, only when a value changes (the
    // encrypted cast compares the decrypted script).
    const id = rowValue(row, "id");
    const sets: string[] = [];
    const params: unknown[] = [id];
    if ("name" in all && all.name !== rowValue(row, "name")) {
      params.push(all.name);
      sets.push(`name = $${params.length}`);
    }
    if ("script" in all && all.script !== (await scriptCipher(tx, c).decrypt(String(rowValue(row, "script"))))) {
      params.push(all.script === null ? null : await scriptCipher(tx, c).encrypt(all.script as string));
      sets.push(`script = $${params.length}`);
    }
    if (sets.length) await tx.execute(`UPDATE deploy.cloud_init_scripts SET ${sets.join(", ")}, updated_at = ${NOW} WHERE id = $1`, params);
    return coolifyJson(await serialize(tx, c, (await scriptRow(tx, uuid))!));
  });
}

async function destroy(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const row = await scriptRow(tx, uuid);
    if (!row) return notFound();
    const no = await denied(c);
    if (no) return no;
    await deleteCloudInitScript(tx, rowValue(row, "id") as string);
    return message(CLOUD_INIT_SCRIPT_MESSAGES.deleted, 200);
  });
}
