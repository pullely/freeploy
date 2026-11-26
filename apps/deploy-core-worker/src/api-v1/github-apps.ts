// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/GithubController.php (removeSensitiveData,
// list_github_apps, create_github_app, update_github_app, delete_github_app), app/Models/GithubApp.php ($fillable,
// $appends, $casts, $hidden), app/Models/BaseModel.php (the creating hook's uuid), app/Rules/SafeWebhookUrl.php
// (forGitSource) and bootstrap/helpers/github.php (githubApiUrlFromHtmlUrl, normalizeGithubOrganization)
// (Apache-2.0), modified.
//
// Coolify's /api/v1 for the org's GitHub Apps (DP-88), on the github_apps rows DP-72's Sources pages write (the
// secrets encrypted under the same column contexts). Freeploy is a hosted service, so the API runs as Coolify Cloud
// does: no App is system-wide (is_system_wide is neither stored nor accepted on update) and a git source's URL may
// not point to a private network (SafeExternalUrl::forGitSource()). A created App is answered as Eloquent writes a
// new model (the attributes in the order create() set them, then the uuid, the timestamps and the id), an updated one
// as the loaded model (Coolify's column order) with the values the request set, not cast.
// The repositories and branches routes ask GitHub: github-repositories.ts (DP-93).
import type { SqlExecutor } from "@saas/db/hyperdrive";
import type { ApiRow } from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, laravelDate, obj, serializeApiResponse, type CoolifyAnswer, type PhpObject, type PhpValue } from "@saas/contracts/coolify-api";
import { columnCipher } from "../handlers/cloud-tokens.js";
import { githubApiUrlFromHtmlUrl, normalizeGithubOrganization } from "../sources/github.js";
import { newPublicId } from "../helpers/names.js";
import { inCoolifyOrder } from "./columns.js";
import { message, rowsOf, type ApiV1Context } from "./context.js";
import { rowValue, toModel, type ModelShape } from "./models.js";
import { errorsObject, extraFields, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rule } from "./rules.js";
import { safeExternalUrlMessage } from "./server-settings.js";
import { githubRepositoriesApi } from "./github-repositories.js";

const GITHUB_APP: ModelShape = { hidden: ["client_secret", "webhook_secret"], dates: ["created_at", "updated_at"] };
const ENCRYPTED = ["client_secret", "webhook_secret"];
const NOW = "date_trunc('second', timezone('UTC', now()))";

const denied = async (c: ApiV1Context, write: boolean, policyMessage?: string): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized(policyMessage));
const filled = (v: unknown): boolean => !(v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0));
const cipher = (tx: SqlExecutor, c: ApiV1Context, column: string) => columnCipher(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, `github_apps.${column}`);
const gitSourceUrl = (c: ApiV1Context, attribute: string): Rule => ({
  closure: async (v) => {
    const e = await safeExternalUrlMessage(c, v, attribute, c.s3.resolve);
    return e ? [e] : [];
  },
});

/** routes/api.php's /github-apps routes. */
export async function githubAppsApi(c: ApiV1Context, segments: string[]): Promise<CoolifyAnswer | null> {
  const [id, extra] = segments;
  if (id !== undefined && extra === "repositories") return githubRepositoriesApi(c, id, segments.slice(2));
  if (extra !== undefined) return null;
  const m = c.method;
  if (id === undefined) return m === "GET" ? list(c) : m === "POST" ? create(c) : null;
  return m === "PATCH" ? update(c, id) : m === "DELETE" ? destroy(c, id) : null;
}

/** removeSensitiveData(): toArray() with the secrets (decrypted) for a token that may read them, then serializeApiResponse(). */
async function appModel(tx: SqlExecutor, c: ApiV1Context, row: ApiRow): Promise<PhpObject> {
  const visible: Array<[string, PhpValue]> = [];
  if (c.canReadSensitive) for (const k of ENCRYPTED) visible.push([k, await decrypted(tx, c, k, rowValue(row, k))]);
  const model = toModel(inCoolifyOrder([...row, ["team_id", c.orgPublicId]], "github_apps"), GITHUB_APP, { visible: c.canReadSensitive ? ENCRYPTED : [], extra: [...visible, ["type", "github"]] });
  return serializeApiResponse(model);
}

async function decrypted(tx: SqlExecutor, c: ApiV1Context, column: string, stored: unknown): Promise<string | null> {
  if (stored === null || stored === undefined || stored === "") return null;
  try {
    return await cipher(tx, c, column).decrypt(String(stored));
  } catch {
    return null;
  }
}

/** GithubApp::where(team_id)->orWhere(is_system_wide): the org's Apps (Freeploy has no system-wide one). */
async function list(c: ApiV1Context): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const out: PhpObject[] = [];
    for (const row of await rowsOf(tx)("github_apps")) out.push(await appModel(tx, c, row));
    return coolifyJson(out);
  });
}

async function privateKeyId(tx: SqlExecutor, uuid: unknown): Promise<string | null> {
  const r = await tx.execute<{ id: string }>("SELECT id::text AS id FROM deploy.private_keys WHERE uuid = $1", [String(uuid)]);
  return r.rows[0]?.id ?? null;
}

async function create(c: ApiV1Context): Promise<CoolifyAnswer> {
  // $this->authorize('create', GithubApp::class)
  const no = await denied(c, true);
  if (no) return no;
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  // $request->merge(['organization' => normalizeGithubOrganization(…)]): the key is there even when the request had none.
  const all: Record<string, unknown> = { ...body.all, organization: normalizeGithubOrganization(typeof body.all.organization === "string" ? body.all.organization : null) };
  if ("organization" in body.all && body.all.organization !== null && typeof body.all.organization !== "string") all.organization = body.all.organization;
  const errors: Errors = [];
  await validateRules(errors, all, [
    ["name", ["required", "string", "max:255"]],
    ["organization", ["nullable", "string", "max:255", { regex: /^[^\s/?#]+$/ }]],
    ["api_url", ["nullable", "string", "url", gitSourceUrl(c, "api_url")]],
    ["html_url", ["required", "string", "url", gitSourceUrl(c, "html_url")]],
    ["custom_user", ["nullable", "string", "max:255"]],
    ["custom_port", ["nullable", "integer", "min:1", "max:65535"]],
    ["app_id", ["required", "integer"]],
    ["installation_id", ["required", "integer"]],
    ["client_id", ["required", "string", "max:255"]],
    ["client_secret", ["required", "string"]],
    ["webhook_secret", ["required", "string"]],
    ["private_key_uuid", ["required", "string"]],
    ["is_system_wide", ["boolean"]],
  ]);
  extraFields(errors, all, ["name", "organization", "api_url", "html_url", "custom_user", "custom_port", "app_id", "installation_id", "client_id", "client_secret", "webhook_secret", "private_key_uuid", "is_system_wide"]);
  if (errors.length) return validationFailed(errors);
  return c.sql(c.env, c.orgId, async (tx) => {
    const keyId = await privateKeyId(tx, all.private_key_uuid);
    if (keyId === null) return message("Private key not found or does not belong to your team.", 404);
    const attributes: Array<[string, PhpValue]> = [
      ["name", all.name as string],
      ["organization", (all.organization as string | null) ?? null],
      ["api_url", filled(all.api_url) ? (all.api_url as string) : githubApiUrlFromHtmlUrl(all.html_url as string)],
      ["html_url", all.html_url as string],
      ["custom_user", "custom_user" in all ? (all.custom_user as string | null) : "git"],
      ["custom_port", "custom_port" in all ? (all.custom_port as PhpValue) : 22],
      ["app_id", all.app_id as PhpValue],
      ["installation_id", all.installation_id as PhpValue],
      ["client_id", all.client_id as string],
      ["private_key_id", Number(keyId)],
      ["is_public", false],
    ];
    const uuid = newPublicId();
    const columns = attributes.map(([k]) => k);
    const r = await tx.execute<{ id: string; created_at: string }>(
      `INSERT INTO deploy.github_apps (uuid, ${columns.map((k) => `"${k}"`).join(", ")}, client_secret, webhook_secret, org_id, created_at, updated_at)
       VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(", ")}, $${columns.length + 2}, $${columns.length + 3}, deploy.current_org(), ${NOW}, ${NOW}) RETURNING id::text AS id, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at`,
      [uuid, ...attributes.map(([, v]) => v), await cipher(tx, c, "client_secret").encrypt(String(all.client_secret)), await cipher(tx, c, "webhook_secret").encrypt(String(all.webhook_secret))],
    );
    const at = laravelDate(new Date(`${r.rows[0]!.created_at}Z`));
    return coolifyJson(obj([...attributes, ["team_id", c.orgPublicId], ["uuid", uuid], ["updated_at", at], ["created_at", at], ["id", Number(r.rows[0]!.id)], ["type", "github"]]), 201);
  });
}

/** GithubApp::where('id', …)->where('team_id', …)->firstOrFail() */
async function findApp(tx: SqlExecutor, id: string): Promise<ApiRow | null> {
  if (!/^\d+$/.test(id)) return null;
  return (await rowsOf(tx)("github_apps", "t.id = $1", [id]))[0] ?? null;
}

async function update(c: ApiV1Context, id: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  const all = body.all;
  return c.sql(c.env, c.orgId, async (tx) => {
    const row = await findApp(tx, id);
    if (!row) return message("GitHub app not found", 404);
    const no = await denied(c, true);
    if (no) return no;
    // $request->only($allowedFields): on Coolify Cloud is_system_wide is not one of them.
    const allowed = ["name", "organization", "api_url", "html_url", "custom_user", "custom_port", "app_id", "installation_id", "client_id", "client_secret", "webhook_secret", "private_key_uuid"];
    const payload: Record<string, unknown> = Object.fromEntries(Object.entries(all).filter(([k]) => allowed.includes(k)));
    if ("organization" in payload && (payload.organization === null || typeof payload.organization === "string")) payload.organization = normalizeGithubOrganization(payload.organization as string | null);
    const set = (k: string) => payload[k] !== undefined && payload[k] !== null;
    const rules: Array<[string, Rule[]]> = [];
    if (set("name")) rules.push(["name", ["string"]]);
    if (set("organization")) rules.push(["organization", ["nullable", "string", { regex: /^[^\s/?#]+$/ }]]);
    if (set("api_url")) rules.push(["api_url", ["url", gitSourceUrl(c, "api_url")]]);
    if (set("html_url")) rules.push(["html_url", ["url", gitSourceUrl(c, "html_url")]]);
    if (set("custom_user")) rules.push(["custom_user", ["string"]]);
    if (set("custom_port")) rules.push(["custom_port", ["integer", "min:1", "max:65535"]]);
    for (const k of ["app_id", "installation_id"]) if (set(k)) rules.push([k, ["integer"]]);
    for (const k of ["client_id", "client_secret", "webhook_secret", "private_key_uuid"]) if (set(k)) rules.push([k, ["string"]]);
    const errors: Errors = [];
    await validateRules(errors, payload, rules);
    if (errors.length) return coolifyJson(obj({ message: "Validation error", errors: errorsObject(errors) }), 422);
    if (set("html_url") && !filled(payload.api_url)) payload.api_url = githubApiUrlFromHtmlUrl(payload.html_url as string);
    if (set("private_key_uuid")) {
      const keyId = await privateKeyId(tx, payload.private_key_uuid);
      if (keyId === null) return message("Private key not found or does not belong to your team", 404);
      delete payload.private_key_uuid;
      payload.private_key_id = Number(keyId);
    }
    // $githubApp->update($payload): fill(), then save() of what Eloquent finds dirty (updated_at with it).
    const current = new Map(row);
    const dirty: Array<[string, unknown]> = [];
    for (const [k, v] of Object.entries(payload)) {
      if (ENCRYPTED.includes(k)) {
        if ((v ?? null) !== (await decrypted(tx, c, k, current.get(k)))) dirty.push([k, v === null || v === undefined ? null : await cipher(tx, c, k).encrypt(String(v))]);
      } else {
        const before = current.get(k);
        if (before === null || before === undefined || v === null || v === undefined ? (before ?? null) !== (v ?? null) : String(before) !== String(v)) dirty.push([k, v ?? null]);
      }
    }
    let updatedAt: unknown = current.get("updated_at");
    if (dirty.length) {
      const r = await tx.execute<{ updated_at: string }>(`UPDATE deploy.github_apps SET ${dirty.map(([k], i) => `"${k}" = $${i + 2}`).join(", ")}, updated_at = ${NOW} WHERE id = $1 RETURNING to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS updated_at`, [rowValue(row, "id"), ...dirty.map(([, v]) => v)]);
      updatedAt = r.rows[0]!.updated_at;
    }
    // The loaded model with the request's values (not cast) over its columns.
    const values = new Map<string, unknown>(row);
    for (const [k, v] of Object.entries(payload)) if (!ENCRYPTED.includes(k)) values.set(k, v ?? null);
    values.set("updated_at", updatedAt);
    const model = toModel(inCoolifyOrder([...values.entries(), ["team_id", c.orgPublicId]], "github_apps"), GITHUB_APP, { extra: [["type", "github"]] });
    return coolifyJson(obj({ message: "GitHub app updated successfully", data: model }));
  });
}

async function destroy(c: ApiV1Context, id: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const row = await findApp(tx, id);
    if (!row) return message("GitHub app not found", 404);
    const no = await denied(c, true);
    if (no) return no;
    // $githubApp->applications: the applications whose source it is (morphMany on source).
    const used = await tx.execute<{ n: number }>("SELECT count(*)::int AS n FROM deploy.applications WHERE deleted_at IS NULL AND source_type = 'App\\Models\\GithubApp' AND source_id = $1", [rowValue(row, "id")]);
    const n = used.rows[0]?.n ?? 0;
    if (n > 0) return message(`This GitHub app is being used by ${n} application(s). Please delete all applications first.`, 409);
    await tx.execute("DELETE FROM deploy.github_apps WHERE id = $1", [rowValue(row, "id")]);
    return message("GitHub app deleted successfully", 200);
  });
}
