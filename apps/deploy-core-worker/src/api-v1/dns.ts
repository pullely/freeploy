// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/DnsController.php (zones, applicationStatus,
// serviceStatus, createApplicationRecord, createServiceRecord, replaceApplicationRecord, replaceServiceRecord,
// releaseApplicationRecord, releaseServiceRecord, findResource, status, create, replace, release, runDnsChange,
// validateBody, busyMessage), app/Policies/{IntegrationTokenPolicy,ApplicationPolicy,ServicePolicy}.php and
// app/Exceptions/Handler.php (an uncaught exception under api/*) (Apache-2.0), modified.
//
// Coolify's managed DNS API (DP-105): the org's Cloudflare zones, and the DNS records of an application's or a service's
// domains — their status, a record created (or an existing one adopted), a conflicting record replaced, a record released
// (deleted at Cloudflare only when Freeploy created it, it did not change and nothing else uses the hostname). On the
// zones and records DP-104's integration tokens wrote (packages/db's deploy/managed-dns.ts); the token decrypted with the
// org's key, Cloudflare asked through the context's fetch outside the org's transaction (managed-dns/). Listing the zones
// is IntegrationTokenPolicy::viewAny (a team admin's: policy-worker's deploy.resource.write); a resource's status is its
// view (deploy.resource.read), a change its update (deploy.resource.write, ApplicationPolicy's own message), asked after
// the resource is found and before the body is read. Nothing here runs on a server.
import { findDnsApplication, findDnsService, listCloudflareZones, type DeployDnsResource } from "@saas/db/deploy";
import { COOLIFY_API, POLICY_DENIALS, coolifyJson, obj, type CoolifyAnswer } from "@saas/contracts/coolify-api";
import { newPublicId } from "../helpers/names.js";
import { ProviderConnectionError, ProviderRejectedError } from "../integration-tokens/providers.js";
import { decryptColumn, message, queryBoolean, type ApiV1Context } from "./context.js";
import { errorsObject, extraFields, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rules } from "./rules.js";
import { DnsRecordConflictError, DnsRecordNotFoundError, DnsValidationError, createDnsRecord, dnsStatus, recordData, releaseDnsRecord, replaceDnsRecord, type DnsDeps } from "../managed-dns/service.js";

export type DnsResourceKind = "application" | "service";

export const DNS_API_MESSAGES = {
  notFound: (kind: DnsResourceKind) => (kind === "application" ? "Application not found." : "Service not found."),
  noRecord: (hostname: string) => `No managed DNS record of this resource for ${hostname}.`,
  busy: (hostname: string) => `Another DNS change for ${hostname} is in progress. Try again in a few seconds.`,
  failed: "Cloudflare did not respond. The record was left untouched; try again.",
  released: {
    deleted: "The DNS record was deleted.",
    already_gone: "The DNS record no longer existed.",
    not_owned: "Coolify did not create the DNS record, so it was kept.",
    changed_externally: "The DNS record changed outside Coolify, so it was kept.",
    kept: "The DNS record was kept: another resource uses the hostname, or delete_record was false.",
  },
} as const;

/** The exception handler's answer to an uncaught exception (Laravel's ConnectionException of a create or a replace). */
const SERVER_ERROR: CoolifyAnswer = { status: 500, body: '{\n    "message": "Server Error"\n}', headers: { "content-type": "application/json" } };

/** GET /dns/zones */
export async function dnsZones(c: ApiV1Context): Promise<CoolifyAnswer> {
  if (!(await c.allows(true))) return COOLIFY_API.unauthorized();
  return c.sql(c.env, c.orgId, async (tx) =>
    coolifyJson(
      (await listCloudflareZones(tx, true)).map((z) =>
        obj({ zone: z.name, account_name: z.account_name, integration_token_uuid: z.token_uuid, integration_token_name: z.token_name, managed_records_count: Number(z.managed_records_count) }),
      ),
    ),
  );
}

/** routes/api.php's /{applications,services}/{uuid}/dns routes; null for any other path. */
export async function resourceDnsApi(c: ApiV1Context, kind: DnsResourceKind, uuid: string, segments: string[]): Promise<CoolifyAnswer | null> {
  const [sub, extra] = segments;
  const m = c.method;
  if (extra !== undefined) return null;
  if (sub === undefined) return m === "GET" ? status(c, kind, uuid) : m === "POST" ? create(c, kind, uuid) : null;
  if (sub === "replace" && m === "POST") return replace(c, kind, uuid);
  return m === "DELETE" ? release(c, kind, uuid, sub) : null;
}

function deps(c: ApiV1Context): DnsDeps {
  return {
    run: (fn) => c.sql(c.env, c.orgId, fn),
    orgId: c.orgId,
    net: c.providers,
    resolve: c.s3.resolve,
    decrypt: async (tx, stored) => (await decryptColumn(tx, c, "integration_tokens", "token", stored)) ?? "",
    instance: c.env.ENVIRONMENT,
    newUuid: newPublicId,
  };
}

/** findResource(): the org's application or service by the route's uuid, then $this->authorize($ability). */
async function findResource(c: ApiV1Context, kind: DnsResourceKind, uuid: string, write: boolean): Promise<DeployDnsResource | CoolifyAnswer> {
  const resource = await c.sql(c.env, c.orgId, (tx) => (kind === "application" ? findDnsApplication(tx, uuid) : findDnsService(tx, uuid)));
  if (!resource) return message(DNS_API_MESSAGES.notFound(kind), 404);
  if (!(await c.allows(write))) return COOLIFY_API.unauthorized(write && kind === "application" ? POLICY_DENIALS.applicationUpdate : undefined);
  return resource;
}

const isAnswer = (v: DeployDnsResource | CoolifyAnswer): v is CoolifyAnswer => "status" in v && "body" in v;

async function status(c: ApiV1Context, kind: DnsResourceKind, uuid: string): Promise<CoolifyAnswer> {
  const resource = await findResource(c, kind, uuid, false);
  if (isAnswer(resource)) return resource;
  return c.sql(c.env, c.orgId, async (tx) => coolifyJson(await dnsStatus(tx, resource, c.s3.resolve)));
}

/** validateBody(): validateIncomingRequest(), the rules, then every field the rules do not name. */
async function validateBody(c: ApiV1Context, rules: Rules): Promise<{ body: Record<string, unknown> } | { answer: CoolifyAnswer }> {
  const read = await readApiBody(c.request);
  if (read.incomingError) return { answer: read.incomingError };
  const errors: Errors = [];
  await validateRules(errors, read.all, rules);
  extraFields(errors, read.all, rules.map(([k]) => k));
  if (errors.length) return { answer: validationFailed(errors) };
  return { body: read.all };
}

const stringOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** runDnsChange(): a validation error is 422, a conflict 409 with the record, Cloudflare's refusal 400. */
async function runDnsChange(change: () => Promise<CoolifyAnswer>): Promise<CoolifyAnswer> {
  try {
    return await change();
  } catch (e) {
    if (e instanceof DnsValidationError) return coolifyJson(obj({ message: "Validation failed.", errors: errorsObject(Object.entries(e.errors)) }), 422);
    if (e instanceof DnsRecordConflictError) return coolifyJson(obj({ message: e.message, conflict: obj({ record_id: e.providerRecordId, current: e.currentValue, proposed: e.proposedValue }) }), 409);
    if (e instanceof ProviderRejectedError) return message(e.message, 400);
    // A ConnectionException is not a RuntimeException: the exception handler answers it.
    if (e instanceof ProviderConnectionError) return SERVER_ERROR;
    throw e;
  }
}

async function create(c: ApiV1Context, kind: DnsResourceKind, uuid: string): Promise<CoolifyAnswer> {
  const resource = await findResource(c, kind, uuid, true);
  if (isAnswer(resource)) return resource;
  const body = await validateBody(c, [
    ["hostname", ["required", "string", "max:255"]],
    ["integration_token_uuid", ["nullable", "string"]],
    ["address", ["nullable", "string"]],
  ]);
  if ("answer" in body) return body.answer;
  const b = body.body;
  return runDnsChange(async () => {
    const record = await createDnsRecord(deps(c), resource, b.hostname as string, stringOrNull(b.integration_token_uuid), stringOrNull(b.address));
    return coolifyJson(obj({ record: recordData(record) }), 201);
  });
}

async function replace(c: ApiV1Context, kind: DnsResourceKind, uuid: string): Promise<CoolifyAnswer> {
  const resource = await findResource(c, kind, uuid, true);
  if (isAnswer(resource)) return resource;
  const body = await validateBody(c, [
    ["hostname", ["required", "string", "max:255"]],
    ["integration_token_uuid", ["nullable", "string"]],
    ["record_id", ["required", "string"]],
    ["current", ["required", "string"]],
    ["address", ["nullable", "string"]],
  ]);
  if ("answer" in body) return body.answer;
  const b = body.body;
  return runDnsChange(async () => {
    const record = await replaceDnsRecord(deps(c), resource, b.hostname as string, stringOrNull(b.integration_token_uuid), b.record_id as string, b.current as string, stringOrNull(b.address));
    return coolifyJson(obj({ record: recordData(record) }));
  });
}

async function release(c: ApiV1Context, kind: DnsResourceKind, uuid: string, hostname: string): Promise<CoolifyAnswer> {
  const resource = await findResource(c, kind, uuid, true);
  if (isAnswer(resource)) return resource;
  let result;
  try {
    result = await releaseDnsRecord(deps(c), resource, hostname, queryBoolean(c.url, "delete_record", true));
  } catch (e) {
    if (e instanceof DnsValidationError) return coolifyJson(obj({ message: "Validation failed.", errors: errorsObject(Object.entries(e.errors)) }), 422);
    if (e instanceof DnsRecordNotFoundError) return message(DNS_API_MESSAGES.noRecord(hostname), 404);
    throw e;
  }
  if (result === "busy") return message(DNS_API_MESSAGES.busy(hostname), 423);
  if (result === "failed") return message(DNS_API_MESSAGES.failed, 502);
  const value = result ?? "kept";
  return coolifyJson(obj({ result: value, message: DNS_API_MESSAGES.released[value] }));
}
