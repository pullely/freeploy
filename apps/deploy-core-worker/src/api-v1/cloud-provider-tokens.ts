// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/CloudProviderTokensController.php (removeSensitiveData,
// validateProviderToken, index, show, store, update, destroy, validateToken), app/Models/CloudProviderToken.php ($fillable,
// $hidden, $casts, servers()) and app/Policies/CloudProviderTokenPolicy.php (Apache-2.0), modified.
//
// Coolify's /api/v1 for the org's cloud provider tokens (DP-90), on the rows the console's Cloud Tokens pages write
// (security.cloud-tokens: packages/db's deploy/cloud-tokens.ts, the token encrypted with the org's key under the same
// column context, "cloud_provider_tokens.token"). Every ability of the policy is a team admin's, so each is policy-worker's
// deploy.resource.write. The token is answered only to a token that may read secrets, as removeSensitiveData() makes it
// visible. Asking the provider (store, validate) goes through the context's fetch, one GET of ten seconds at most.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { cloudProviderTokenServerCount, deleteCloudProviderToken, insertCloudProviderToken, type ApiRow } from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, fromJs, obj, phpTruthy, serializeApiResponse, type CoolifyAnswer, type PhpObject } from "@saas/contracts/coolify-api";
import { columnCipher } from "../handlers/cloud-tokens.js";
import { newPublicId } from "../helpers/names.js";
import { providerSend, type ProviderRequest } from "./cloud-providers.js";
import { message, rowsOf, type ApiV1Context } from "./context.js";
import { rowValue, toModel, type ModelShape } from "./models.js";
import { extraFields, queryAll, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules } from "./rules.js";

/** $hidden (token) and removeSensitiveData()'s makeHidden(['id']). */
const CLOUD_PROVIDER_TOKEN: ModelShape = { hidden: ["id", "token"], dates: ["created_at", "updated_at"] };
const COLUMN = "cloud_provider_tokens.token";
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** $this->authorize() denied: the exception handler's answer (COOLIFY_API.unauthorized(), DP-93). */
export const policyDenied = (): CoolifyAnswer => COOLIFY_API.unauthorized();
const denied = async (c: ApiV1Context): Promise<CoolifyAnswer | null> => ((await c.allows(true)) ? null : policyDenied());
const notFound = () => message("Cloud provider token not found.", 404);
export const tokenCipher = (tx: SqlExecutor, c: ApiV1Context) => columnCipher(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, COLUMN);

/** routes/api.php's /cloud-tokens routes; null for every other path (the caller answers the fallback 404). */
export async function cloudProviderTokensApi(c: ApiV1Context, segments: string[]): Promise<CoolifyAnswer | null> {
  const [uuid, sub, extra] = segments;
  const m = c.method;
  if (extra !== undefined) return null;
  if (uuid === undefined) return m === "GET" ? list(c) : m === "POST" ? store(c) : null;
  if (sub === undefined) return m === "GET" ? show(c, uuid) : m === "PATCH" ? update(c, uuid) : m === "DELETE" ? destroy(c, uuid) : null;
  return sub === "validate" && m === "POST" ? validate(c, uuid) : null;
}

/** `$request->uuid`: the input (a POST's body over the query string) before the route parameter; null when the input has it empty. */
async function requestUuid(c: ApiV1Context, route: string): Promise<unknown> {
  let input = queryAll(c.url);
  if (c.method === "POST") input = { ...input, ...(await readApiBody(c.request)).all };
  return "uuid" in input ? input.uuid : route;
}

/** CloudProviderToken::whereTeamId()->whereUuid()->first(): the org's token (row-level security confines it to the org). */
export async function tokenRow(tx: SqlExecutor, uuid: unknown, provider?: string): Promise<ApiRow | null> {
  if (typeof uuid !== "string") return null;
  const where = provider === undefined ? "t.uuid = $1" : "t.uuid = $1 AND t.provider = $2";
  return (await rowsOf(tx)("cloud_provider_tokens", where, provider === undefined ? [uuid] : [uuid, provider]))[0] ?? null;
}

/** The stored token, decrypted (the `encrypted` cast). */
export async function tokenSecret(tx: SqlExecutor, c: ApiV1Context, row: ApiRow): Promise<string> {
  return tokenCipher(tx, c).decrypt(String(rowValue(row, "token")));
}

/** withCount('servers'), then removeSensitiveData(): the token (decrypted) for a token that may read secrets; serializeApiResponse(). */
async function serialize(tx: SqlExecutor, c: ApiV1Context, row: ApiRow): Promise<PhpObject> {
  const servers = await cloudProviderTokenServerCount(tx, rowValue(row, "id") as string);
  const secret = c.canReadSensitive ? await tokenSecret(tx, c, row) : null;
  const shown: ApiRow = c.canReadSensitive ? row.map(([k, v]): [string, unknown] => [k, k === "token" ? secret : v]) : row;
  return serializeApiResponse(toModel(shown, CLOUD_PROVIDER_TOKEN, { teamId: c.orgPublicId, visible: c.canReadSensitive ? ["token"] : [], extra: [["servers_count", servers]] }));
}

async function list(c: ApiV1Context): Promise<CoolifyAnswer> {
  // $request->user()?->isAdminOfTeam($teamId), before anything is read: the controller's own 403.
  if (!(await c.allows(true))) return COOLIFY_API.controllerUnauthorized();
  return c.sql(c.env, c.orgId, async (tx) => {
    const out: PhpObject[] = [];
    for (const row of await rowsOf(tx)("cloud_provider_tokens")) out.push(await serialize(tx, c, row));
    return coolifyJson(out);
  });
}

async function show(c: ApiV1Context, route: string): Promise<CoolifyAnswer> {
  const uuid = await requestUuid(c, route);
  return c.sql(c.env, c.orgId, async (tx) => {
    const row = await tokenRow(tx, uuid);
    if (!row) return notFound();
    const no = await denied(c);
    return no ?? coolifyJson(await serialize(tx, c, row));
  });
}

/** validateProviderToken(): one GET with the token, ten seconds at most; valid when the answer is 2xx. */
export async function validateProviderToken(c: ApiV1Context, provider: string, token: string): Promise<{ valid: boolean; error: string | null }> {
  const requests: Record<string, Omit<ProviderRequest, "timeoutMs" | "method">> = {
    hetzner: { url: "https://api.hetzner.cloud/v1/servers", headers: { Authorization: `Bearer ${token}` } },
    digitalocean: { url: "https://api.digitalocean.com/v2/account", headers: { Authorization: `Bearer ${token}` } },
    vultr: { url: "https://api.vultr.com/v2/account", headers: { Authorization: `Bearer ${token}` } },
    hostinger: { url: "https://developers.hostinger.com/api/vps/v1/virtual-machines", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
  };
  const r = Object.hasOwn(requests, provider) ? requests[provider] : undefined;
  if (!r) return { valid: false, error: "Unsupported provider." };
  try {
    const response = await providerSend(c.providers, { ...r, method: "get", timeoutMs: 10_000 });
    if (response.successful) return { valid: true, error: null };
    return { valid: false, error: `Invalid ${provider} token. Please check your API token.` };
  } catch {
    return { valid: false, error: "Failed to validate token with provider API." };
  }
}

async function store(c: ApiV1Context): Promise<CoolifyAnswer> {
  // $this->authorize('create', [CloudProviderToken::class]) before the body is read.
  const no = await denied(c);
  if (no) return no;
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  const errors: Errors = [];
  await validateRules(errors, all, [
    ["provider", ["required", "string", { in: ["hetzner", "digitalocean", "vultr", "hostinger"] }]],
    ["token", ["required", "string"]],
    ["name", ["required", "string", "max:255"]],
  ]);
  extraFields(errors, all, ["provider", "token", "name"]);
  if (errors.length) return validationFailed(errors);
  const provider = all.provider as string;
  const validation = await validateProviderToken(c, provider, all.token as string);
  if (!validation.valid) return message(validation.error!, 400);
  return c.sql(c.env, c.orgId, async (tx) => {
    const row = await insertCloudProviderToken(tx, { orgId: c.orgId, uuid: newPublicId(), provider, token: await tokenCipher(tx, c).encrypt(all.token as string), name: all.name as string, description: null });
    return coolifyJson(obj({ uuid: row.uuid ?? "" }), 201);
  });
}

async function update(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  const errors: Errors = [];
  await validateRules(errors, all, [["name", ["required", "string", "max:255"]]]);
  extraFields(errors, all, ["name"]);
  if (errors.length) return validationFailed(errors);
  return c.sql(c.env, c.orgId, async (tx) => {
    const row = await tokenRow(tx, uuid);
    if (!row) return notFound();
    const no = await denied(c);
    if (no) return no;
    // $token->update(['name' => …]): saved (and updated_at touched) only when the name changes.
    if (rowValue(row, "name") !== all.name) await tx.execute(`UPDATE deploy.cloud_provider_tokens SET name = $2, updated_at = ${NOW} WHERE id = $1`, [rowValue(row, "id"), all.name]);
    return coolifyJson(obj({ uuid }));
  });
}

async function destroy(c: ApiV1Context, route: string): Promise<CoolifyAnswer> {
  const uuid = await requestUuid(c, route);
  if (!phpTruthy(fromJs(uuid))) return message("UUID is required.", 422);
  return c.sql(c.env, c.orgId, async (tx) => {
    const row = await tokenRow(tx, uuid);
    if (!row) return notFound();
    const no = await denied(c);
    if (no) return no;
    const id = rowValue(row, "id") as string;
    // hasServers(): servers()->exists() (Server soft-deletes, so a trashed server does not count).
    if ((await cloudProviderTokenServerCount(tx, id)) > 0) return message("Cannot delete token that is used by servers.", 400);
    await deleteCloudProviderToken(tx, id);
    return message("Cloud provider token deleted.", 200);
  });
}

async function validate(c: ApiV1Context, route: string): Promise<CoolifyAnswer> {
  const uuid = await requestUuid(c, route);
  const found = await c.sql(c.env, c.orgId, async (tx) => {
    const row = await tokenRow(tx, uuid);
    if (!row) return { answer: notFound() };
    const no = await denied(c);
    if (no) return { answer: no };
    return { provider: String(rowValue(row, "provider")), token: await tokenSecret(tx, c, row) };
  });
  if ("answer" in found) return found.answer;
  const validation = await validateProviderToken(c, found.provider, found.token);
  return coolifyJson(obj({ valid: validation.valid, message: validation.valid ? "Token is valid." : validation.error }));
}
