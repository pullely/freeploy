// Derived from coollabsio/coolify@91b7e3e:routes/web.php (server.create.type, server.create.token),
// app/Livewire/Server/{CreatePage,Create}.php, app/Livewire/Server/New/{ByHetzner,ByVultr,ByDigitalOcean,ByHostinger}.php
// and app/Policies/{ServerPolicy,CloudProviderTokenPolicy}.php (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/servers/new/{type}[/…] — the console's create-a-cloud-server flow (DP-118), {type} one
// of hetzner, vultr, digital-ocean, hostinger (manual is ByIp's GET /servers/new, DP-37):
//
//   GET  /servers/new/{type}                       CreatePage + By{Provider}::mount(): step 1, the token picker
//   GET  /servers/new/{type}/{token_uuid}          the same with the route's token (step 2 when it is one of the
//                                                  provider's tokens, else step 1, as selectTokenFromUrl())
//   GET  /servers/new/{type}/{token_uuid}/catalog  load{Provider}Data() (wire:init): the provider's catalogue, or the
//                                                  page's provider_data_error, or the "Please select a valid …" toast
//   POST /servers/new/{type}/{token_uuid}          submit() { the component's properties }
//
// A Livewire toast is `toasts` of a 200; a ValidationException (and the components' addError() and return) a 422 with the
// fields. A server stored answers 501 "Validating the new server needs the SSH executor, which is not available yet." with
// its uuid in the details (ValidateNewCloudServerJob works over SSH), after the row is stored, as DP-110's instant_validate.
// Adding a token (CloudProviderTokenForm), a private key and reading a saved script are the existing routes of DP-45 and
// DP-36.
//
// Policy: the route's can:create Server and the components' viewAny CloudProviderToken (team admin) — every call needs
// deploy.resource.write; a denial answers 404 and runs nothing. A token is decrypted only to ask its provider, never
// returned.
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import { withOrg } from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse } from "../http.js";
import { authorizeDeploy, readJson } from "./cloud-tokens.js";
import { membershipTeamSettings } from "./image-scan-settings.js";
import type { ProviderNetwork } from "../api-v1/cloud-providers.js";
import { CLOUD_NEW_MESSAGES, cloudNewLoad, cloudNewMount, cloudNewSubmit, isCloudType, type CloudNewContext, type CloudType } from "../servers/cloud-new.js";

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

/** Runs fn in one transaction confined to the org (withOrg); replaceable for tests. */
export type CloudServerCreateRunner = <T>(env: Env, orgId: string, fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;

export const runCloudServerCreateInOrg: CloudServerCreateRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, fn);
  } finally {
    await db.dispose();
  }
};

const PROVIDER_NETWORK: ProviderNetwork = { fetch: (input, init) => fetch(input, init), sleep: (ms) => new Promise((done) => setTimeout(done, ms)) };

export interface CloudServerCreateDeps {
  runner?: CloudServerCreateRunner;
  /** What a provider is asked through (DP-90's fetch and the retries' sleep). */
  providers?: ProviderNetwork;
  /** The team's scan_images_on_new_servers (SetsImageScanning's default), membership-worker's. */
  scanImagesOnNewServers?: () => Promise<boolean>;
  randomName?: () => string;
}

/**
 * segments: what follows /servers/new ({type}, then the token's uuid and catalog). orgPublicId is the org's id in the
 * path, for membership-worker's org (the team default of image scanning).
 */
export async function handleCloudServerCreate(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  orgPublicId: string,
  segments: string[],
  request: Request,
  deps: CloudServerCreateDeps = {},
): Promise<Response> {
  const method = request.method;
  const [type, tokenUuid, extra, more] = segments;
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  if (!isCloudType(type) || more !== undefined || (tokenUuid !== undefined && !UUID_RE.test(tokenUuid)) || (extra !== undefined && extra !== "catalog")) return notFound();
  let op: ((ctx: CloudNewContext) => Promise<Response>) | null = null;
  if (extra === "catalog") {
    if (method === "GET") op = async (ctx) => load(ctx);
  } else if (method === "GET") {
    op = async (ctx) => mount(ctx);
  } else if (method === "POST") {
    op = async (ctx) => submit(ctx);
  }
  if (!op) return methodNotAllowed(requestId);
  const cloudType: CloudType = type;

  const auth = await authorizeDeploy(env, requestId, actor, orgId, true);
  if (!auth.ok) return auth.response;
  const runner = deps.runner ?? runCloudServerCreateInOrg;
  const providers = deps.providers ?? PROVIDER_NETWORK;
  const scanDefault = deps.scanImagesOnNewServers ?? (async () => (await membershipTeamSettings(env, orgPublicId, actor, requestId).read())?.scanImagesOnNewServers === true);
  const body = method === "POST" ? await readJson(request) : {};
  // mountSetsImageScanning(): read before the org's transaction.
  const scanImagesOnNewServers = method === "GET" && extra === undefined ? await scanDefault() : false;

  async function mount(ctx: CloudNewContext): Promise<Response> {
    const data = await cloudNewMount(ctx, cloudType, tokenUuid ?? null, scanImagesOnNewServers);
    return successResponse({ ...data, canCreatePrivateKey: auth.ok && auth.canWrite }, requestId);
  }

  async function load(ctx: CloudNewContext): Promise<Response> {
    const r = await cloudNewLoad(ctx, cloudType, tokenUuid!);
    if ("toast" in r) return successResponse({ toasts: [{ type: "error", message: r.toast }] }, requestId);
    if ("providerDataError" in r) return successResponse({ providerDataError: r.providerDataError, toasts: [{ type: "error", message: r.providerDataError }] }, requestId);
    return successResponse({ catalog: r.data }, requestId);
  }

  async function submit(ctx: CloudNewContext): Promise<Response> {
    const r = await cloudNewSubmit(ctx, cloudType, tokenUuid ?? null, body);
    if ("fields" in r) return errorResponse("validation_failed", Object.values(r.fields)[0]?.[0] ?? "Validation failed", 422, requestId, { fields: r.fields });
    if ("toasts" in r) return successResponse({ toasts: r.toasts.map((message) => ({ type: "error", message })) }, requestId);
    return errorResponse("unsupported", CLOUD_NEW_MESSAGES.validateUnavailable, 501, requestId, { uuid: r.stored.uuid });
  }

  try {
    return await runner(env, orgId, (tx) => op({ tx, orgId, env, providers, ...(deps.randomName ? { randomName: deps.randomName } : {}) }));
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}
