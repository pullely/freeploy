// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Server/CaCertificate/Show.php,
// resources/views/livewire/server/ca-certificate/show.blade.php and
// app/Policies/ServerPolicy.php (view, manageCaCertificate) (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/servers/{uuid}/ca-certificate — a server's CA
// certificate, routed here by handleServers (servers.ts):
//
//   GET   /ca-certificate              Show::mount + loadCaCertificate → { server, certificateContent,
//                                      certificateValidUntil, canUpdate }
//   PATCH /ca-certificate              Show::saveCaCertificate { certificateContent }
//   POST  /ca-certificate/regenerate   Show::regenerateCaCertificate (no body)
//
// Coolify's policy: the page and its certificate are for every team member
// (mount() authorizes nothing, the view's toggle is @can('view')); saving and
// regenerating are manageCaCertificate (team admin). Here: deploy.resource.read
// and deploy.resource.write, asked of policy-worker after membership-worker's
// facts; a denial answers 404 (never leaks). The private key is in no answer.
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { withOrg, loadKek, orgDek, encryptField, decryptField, findServerByUuid, findServerCaCertificate, deleteSslCertificates, insertSslCertificate, updateSslCertificateContent, type OrgDek } from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse } from "../http.js";
import type { FieldCipher } from "../servers/settings.js";
import { authorizeDeploy, readJson } from "./cloud-tokens.js";
import { CaCertificateError, regenerateCaCertificate, saveCaCertificate, showCaCertificate, type CaCertificateContext, type CaCertificateStore } from "../ssl/ca-certificate.js";
import { SslError } from "../ssl/ssl-helper.js";

/** Runs fn with one org's certificate store and cipher, in one transaction confined to that org. */
export type CaCertificateRunner = <T>(env: Env, orgId: string, fn: (ctx: CaCertificateContext) => Promise<T>) => Promise<T>;

function sqlStore(tx: SqlExecutor, orgId: string): CaCertificateStore {
  return {
    findServer: (uuid) => findServerByUuid(tx, uuid),
    findCa: (serverId) => findServerCaCertificate(tx, serverId),
    replaceCa: async (serverId, c) => {
      const owner = { serverId, resourceType: null, resourceId: null };
      await deleteSslCertificates(tx, owner);
      return insertSslCertificate(tx, {
        ...owner,
        orgId,
        sslCertificate: c.sslCertificate,
        sslPrivateKey: c.sslPrivateKey,
        configurationDir: null,
        mountPath: null,
        commonName: c.commonName,
        subjectAlternativeNames: c.subjectAlternativeNames,
        validUntil: c.validUntil,
        isCaCertificate: c.isCaCertificate,
      });
    },
    updateCertificate: (id, sslCertificate) => updateSslCertificateContent(tx, id, sslCertificate),
  };
}

/** The org's data key, looked up (or created) on first use; each value bound to its column. */
function sqlCipher(tx: SqlExecutor, orgId: string, secret: string | undefined): FieldCipher {
  let dek: Promise<OrgDek> | null = null;
  const key = () => (dek ??= loadKek(secret).then((kek) => orgDek(tx, orgId, kek)));
  return {
    encrypt: async (column, plaintext) => encryptField(await key(), column, plaintext),
    decrypt: async (column, stored) => decryptField(await key(), column, stored),
  };
}

export const runCaCertificateInOrg: CaCertificateRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => fn({ store: sqlStore(tx, orgId), cipher: sqlCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY) }));
  } finally {
    await db.dispose();
  }
};

/**
 * segments: what follows /servers/{uuid}/ca-certificate ([] or ["regenerate"]).
 * `runner` is replaceable for tests.
 */
export async function handleServerCaCertificate(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  uuid: string,
  segments: string[],
  request: Request,
  runner: CaCertificateRunner = runCaCertificateInOrg,
): Promise<Response> {
  const method = request.method;
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  type Op = { write: boolean; run: (canWrite: boolean) => Promise<Response> };
  let op: Op | null = null;

  if (segments.length === 0) {
    if (method === "GET") op = { write: false, run: show };
    else if (method === "PATCH") op = { write: true, run: save };
  } else if (segments.length === 1 && segments[0] === "regenerate") {
    if (method === "POST") op = { write: true, run: regenerate };
  } else {
    return notFound();
  }
  if (!op) return methodNotAllowed(requestId);

  async function show(canWrite: boolean): Promise<Response> {
    const page = await runner(env, orgId, (c) => showCaCertificate(c, uuid));
    if (!page) return notFound();
    // @can('update', $server) around the two confirmations, canGate="update" on the textarea.
    return successResponse({ ...page, canUpdate: canWrite }, requestId);
  }

  async function save(): Promise<Response> {
    const body = await readJson(request);
    const saved = await runner(env, orgId, (c) => saveCaCertificate(c, uuid, body.certificateContent));
    return saved ? successResponse(saved, requestId) : notFound();
  }

  async function regenerate(): Promise<Response> {
    const saved = await runner(env, orgId, (c) => regenerateCaCertificate(c, uuid));
    return saved ? successResponse(saved, requestId) : notFound();
  }

  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;
  try {
    return await op.run(auth.canWrite);
  } catch (e) {
    // handleError(): the exception's message as the error toast.
    if (e instanceof CaCertificateError) return errorResponse("validation_failed", e.message, 422, requestId);
    if (e instanceof SslError) return errorResponse("internal_error", e.message, 500, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}
