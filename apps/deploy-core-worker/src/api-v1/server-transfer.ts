// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/ServerTransferController.php (import, complete),
// app/Services/ServerTransfer/ServerTransferImporter.php (import's checks before it writes — assertValidServerPayload,
// the adopt mode check, the warnings, replaceableArchive, importChecks, assertCanImport — the dry run's counts and
// postTransferChecklist), app/Services/ServerTransfer/ServerTransferClaimer.php (markTransferred), app/Rules/ValidServerIp.php
// and Laravel's ValidationException::summarize() (Apache-2.0 / MIT), modified.
//
// Coolify's /api/v1 for a server transfer bundle (POST /servers/import) and for a transfer that another instance finished
// (POST /servers/{uuid}/transfer/complete), DP-111. The import runs Coolify's checks — the bundle's
// (ServerTransferBundle::validate(), servers/transfer-bundle.ts), the server's connection fields, the adopt mode and the
// import checks — and a dry run answers what it would import. A real import writes every row of the bundle and then claims
// the server over SSH (its owner marker): Freeploy answers 501 once the checks pass, and stores nothing — the importer is not
// ported. Marking a transfer complete changes rows only: the server's automations are disabled, its metadata says it is
// transferred, its GitHub runners are released and its managed DNS records parked.
//
// Not ported: the Coolify host itself (server 0, which Freeploy has none of), Team::serverLimitReached() (Freeploy has no
// server limit, as DP-78's POST /servers), Server::throttleValidation() (Coolify Cloud's limit; no validation runs), the audit
// log, and the local SSH key and mux files clearLocalSshArtifacts() removes (Freeploy keeps none). Whether another server has
// the bundle's uuid, address and port is asked within the org (row-level security), where Coolify looks across every team.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  disableTransferredServerSettings,
  findTransferServer,
  lockTransferServer,
  parkServerDnsRecords,
  releaseServerGithubRunners,
  saveServerMetadata,
  serverSshEndpointInUse,
} from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, fromJs, obj, type CoolifyAnswer, type PhpValue } from "@saas/contracts/coolify-api";
import { needsExecutor } from "../applications/resources.js";
import { DEFAULT_CONSOLE_URL } from "../handlers/notifications.js";
import { normalizeServerIp, serverIpError } from "../servers/ip.js";
import { isTransferredAway } from "../servers/service.js";
import { SERVER_USERNAME_PATTERN } from "../servers/validation.js";
import { dataGet, isPhpArray, phpArrayCast, phpCount, phpEntries, phpForeach, phpInt, phpString, phpTruthy, PhpRuntimeError, validateBundle } from "../servers/transfer-bundle.js";
import { message, rowsOf, unavailable, type ApiV1Context } from "./context.js";
import { rowValue } from "./models.js";
import { extraFields, readApiBody, requestBoolean, validationFailed, type Errors } from "./request.js";
import { validateRules } from "./rules.js";
import { instanceUrl, instanceUrlError } from "./server-registries-transfer.js";

export const SERVER_TRANSFER_API_MESSAGES = {
  /** Freeploy's: the import writes the bundle's rows and claims the server over SSH; the importer is not ported. */
  importUnavailable: needsExecutor("Importing a server"),
  adoptNeedsUuids: "Adopt mode keeps the running containers, so it needs the original UUIDs. Import with preserve_uuids=true.",
  runnersReleased: "The server was transferred to another Coolify instance. This instance stopped managing its runners.",
  transferred: "Server marked as transferred. Automations disabled on this instance.",
} as const;

/** ValidationException::summarize(): the first message, with "(and N more error[s])". */
function summarize(errors: Errors): string {
  const all = errors.flatMap(([, m]) => m);
  if (all.length === 0) return "The given data was invalid.";
  const more = all.length - 1;
  return more > 0 ? `${all[0]} (and ${more} more ${more === 1 ? "error" : "errors"})` : all[0]!;
}

/** A ValidationException caught by the controller: its message and errors, 422. */
const validationException = (errors: Errors): CoolifyAnswer =>
  coolifyJson(obj({ message: summarize(errors), errors: obj(errors.map(([k, v]): [string, PhpValue] => [k, v])) }), 422);

const denied = async (c: ApiV1Context): Promise<CoolifyAnswer | null> => ((await c.allows(true)) ? null : COOLIFY_API.unauthorized());

/** $request->boolean($key, $default): the default only when the key is missing (a null is false). */
const booleanOr = (all: Record<string, unknown>, key: string, fallback: boolean): boolean => (key in all ? requestBoolean(all, key) : fallback);

/** filled() */
const filled = (v: unknown): boolean => !(v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (isPhpArray(v) && phpEntries(v).length === 0));

const IMPORT_FIELDS = ["bundle", "dry_run", "preserve_uuids", "adopt_mode"];

/** import(): the create policy, validateIncomingRequest(), the request's rules, then the importer — a PHP error it meets is a 422 with its message. */
export async function importServer(c: ApiV1Context): Promise<CoolifyAnswer> {
  const no = await denied(c);
  if (no) return no;
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  const errors: Errors = [];
  await validateRules(errors, all, [
    ["bundle", ["required", "array"]],
    ["dry_run", ["boolean", "nullable"]],
    ["preserve_uuids", ["boolean", "nullable"]],
    ["adopt_mode", ["boolean", "nullable"]],
  ]);
  extraFields(errors, all, IMPORT_FIELDS);
  if (errors.length) return validationFailed(errors);
  const options = { dryRun: booleanOr(all, "dry_run", false), preserveUuids: booleanOr(all, "preserve_uuids", true), adoptMode: booleanOr(all, "adopt_mode", true) };
  try {
    return await c.sql(c.env, c.orgId, (tx) => importBundle(c, tx, all.bundle as Record<string, unknown> | unknown[], options));
  } catch (e) {
    if (e instanceof PhpRuntimeError) return message(e.message, 422);
    throw e;
  }
}

/** assertValidServerPayload(): the create server API's rules for the server's connection fields. */
async function serverPayloadErrors(server: Record<string, unknown>): Promise<Errors> {
  const errors: Errors = [];
  await validateRules(
    errors,
    server,
    [
      ["name", ["nullable", "string", "max:255"]],
      [
        "ip",
        [
          "required",
          "string",
          {
            // ValidServerIp: trim() of an array is PHP's TypeError.
            closure: (v) => {
              if (!phpTruthy(v)) return [];
              if (isPhpArray(v)) throw new PhpRuntimeError("trim(): Argument #1 ($string) must be of type string, array given");
              const e = serverIpError("server.ip", phpString(v));
              return e ? [e] : [];
            },
          },
        ],
      ],
      ["port", ["required", "integer", "between:1,65535"]],
      // ValidationPatterns::serverUsernameRules(required: false), without its messages.
      ["user", ["nullable", "string", { regex: SERVER_USERNAME_PATTERN }]],
    ],
    { laravelMessages: true, attributes: { ip: "server.ip", port: "server.port", user: "server.user" } },
  );
  return errors;
}

/** array_values(array_unique($values)): the first of the values that read the same as strings. */
function uniqueValues(values: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const v of values) {
    const key = phpString(v);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

interface ImportOptions {
  dryRun: boolean;
  preserveUuids: boolean;
  adoptMode: boolean;
}

/** ServerTransferImporter::import() up to what it writes: the checks, the warnings, and a dry run's answer. */
async function importBundle(c: ApiV1Context, tx: SqlExecutor, bundle: Record<string, unknown> | unknown[], o: ImportOptions): Promise<CoolifyAnswer> {
  const validation = await validateBundle(bundle);
  if (!validation.valid) return validationException([["bundle", validation.errors]]);
  const payloadErrors = await serverPayloadErrors(phpArrayCast(dataGet(bundle, "server", [])) as Record<string, unknown>);
  if (payloadErrors.length) return validationException(payloadErrors);
  if (o.adoptMode && !o.preserveUuids) return validationException([["preserve_uuids", [SERVER_TRANSFER_API_MESSAGES.adoptNeedsUuids]]]);

  let warnings: unknown[] = [...validation.warnings];
  const bundleWarnings = dataGet(bundle, "warnings");
  if (isPhpArray(bundleWarnings)) warnings = uniqueValues([...warnings, ...phpEntries(bundleWarnings).map(([, w]) => w)]);

  const serverUuid = phpString(dataGet(bundle, "server.uuid"));
  const serverIp = phpString(dataGet(bundle, "server.ip"));
  const serverPort = phpInt(dataGet(bundle, "server.port", 22));

  // A server that comes back replaces the archived copy that this instance kept from the first transfer.
  const kept = o.preserveUuids ? await findTransferServer(tx, serverUuid, false) : null;
  const archive = kept && isTransferredAway(kept) ? kept : null;
  const existing = archive === null && o.preserveUuids ? await findTransferServer(tx, serverUuid, true) : null;
  const ipConflict = await serverSshEndpointInUse(tx, normalizeServerIp(serverIp), serverPort, archive?.id ?? null);

  if (!o.dryRun) {
    // assertCanImport(): importChecks()' first failed check.
    if (existing) {
      const uuidMessage = existing.deleted_at !== null
        ? `The server with UUID ${serverUuid} is still being deleted on this instance. Wait a minute, then transfer again.`
        : isTransferredAway(existing)
          ? "Another team of this instance has the archived copy of this server. Transfer the server into that team, or delete the archive there first."
          : `A server with UUID ${serverUuid} already exists on this instance. Delete/transfer it first, or import with preserve_uuids=false.`;
      return validationException([["server.uuid", [uuidMessage]]]);
    }
    if (ipConflict) return validationException([["server.ip", [`A server with IP/domain ${serverIp} and SSH port ${serverPort} already exists on this instance. Remove it first.`]]]);
    // The import writes the bundle's rows, then claims the server over SSH.
    return unavailable(SERVER_TRANSFER_API_MESSAGES.importUnavailable);
  }

  if (existing) warnings.push(`A server with UUID ${serverUuid} already exists on this instance.`);
  if (ipConflict) warnings.push(`A server with IP/domain ${serverIp} and SSH port ${serverPort} already exists on this instance.`);

  const created: Array<[string, number]> = [
    ["projects", 0], ["environments", 0], ["applications", 0], ["databases", 0], ["services", 0], ["destinations", 0], ["private_keys", 0],
    ["github_apps", 0], ["gitlab_apps", 0], ["gitea_apps", 0], ["s3_storages", 0], ["cloud_provider_tokens", 0], ["integration_tokens", 0],
    ["managed_dns_records", 0], ["ssl_certificates", 0], ["image_scan_policies", 0], ["image_scan_ignores", 0], ["volume_backups", 0], ["previews", 0],
  ];
  const count = new Map(created);
  const add = (key: string, n: number) => count.set(key, count.get(key)! + n);
  for (const project of phpForeach(dataGet(bundle, "projects", []))) {
    add("projects", 1);
    for (const environment of phpForeach(dataGet(project, "environments", []))) {
      add("environments", 1);
      add("applications", phpCount(dataGet(environment, "applications", [])));
      add("databases", phpCount(dataGet(environment, "databases", [])));
      add("services", phpCount(dataGet(environment, "services", [])));
      for (const app of phpForeach(dataGet(environment, "applications", []))) add("previews", phpCount(dataGet(app, "previews", [])));
    }
  }
  count.set("destinations", phpCount(dataGet(bundle, "destinations", [])));
  count.set("private_keys", Math.max(phpCount(dataGet(bundle, "private_keys", [])), phpTruthy(dataGet(bundle, "private_key")) ? 1 : 0));
  for (const key of ["github_apps", "gitlab_apps", "gitea_apps", "s3_storages", "cloud_provider_tokens", "integration_tokens", "managed_dns_records", "ssl_certificates", "image_scan_policies", "image_scan_ignores", "volume_backups"]) {
    count.set(key, phpCount(dataGet(bundle, key, [])));
  }

  return coolifyJson(
    obj({
      dry_run: true,
      warnings: warnings.map((w) => fromJs(w)),
      server_uuid: o.preserveUuids ? serverUuid : null,
      private_key_uuid: fromJs(dataGet(bundle, "private_key.uuid")),
      created: obj(created.map(([k]): [string, PhpValue] => [k, count.get(k)!])),
      preserved_uuids: o.preserveUuids,
      export_id: fromJs(dataGet(bundle, "export_id")),
      claimed: false,
      claim: null,
      checklist: postTransferChecklist(c, bundle),
    }),
  );
}

/** postTransferChecklist(): the bundle's steps (strings only, once each), {target_url} this instance's URL. */
function postTransferChecklist(c: ApiV1Context, bundle: unknown): string[] {
  const targetUrl = (c.env.DEPLOY_CONSOLE_URL || DEFAULT_CONSOLE_URL).replace(/\/+$/, "");
  const steps = phpEntries(phpArrayCast(dataGet(bundle, "post_transfer_checklist", [])))
    .map(([, s]) => s)
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.split("{target_url}").join(targetUrl));
  return [...new Set(steps)];
}

/** now()->toIso8601String() */
const iso8601 = (d: Date): string => `${d.toISOString().slice(0, 19)}+00:00`;

/** complete(): the server, the update policy, the request's rules and the target URL, then ServerTransferClaimer::markTransferred(). */
export async function completeServerTransfer(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const server = (await rowsOf(tx)("servers", "t.deleted_at IS NULL AND t.uuid = $1", [uuid]))[0];
    if (!server) return message("Server not found.", 404);
    const no = await denied(c);
    if (no) return no;
    // The controller reads $request->all() without validateIncomingRequest(): a form or an empty body is input too.
    const all = (await readApiBody(c.request)).all;
    const errors: Errors = [];
    await validateRules(errors, all, [
      ["export_id", ["string", "nullable"]],
      ["target_instance_url", ["string", "nullable"]],
    ]);
    if (errors.length) return validationFailed(errors);
    let targetInstanceUrl: string | null = null;
    if (filled(all.target_instance_url)) {
      const refused = await instanceUrlError(c, all.target_instance_url, c.s3.resolve);
      if (refused) return validationFailed([["target_instance_url", [refused]]]);
      targetInstanceUrl = instanceUrl(all.target_instance_url);
    }
    const exportId = typeof all.export_id === "string" ? all.export_id : null;
    await markTransferred(tx, rowValue(server, "id") as string | number, exportId, targetInstanceUrl);
    return coolifyJson(obj({ server_uuid: String(rowValue(server, "uuid")), message: SERVER_TRANSFER_API_MESSAGES.transferred }));
  });
}

/**
 * markTransferred(): the settings disable the server's automations, the metadata's transfer says it is transferred (what
 * it said before kept, but a finished take back's steps and an owner marker's conflict), the GitHub runners are released,
 * and the managed DNS records of the server and what runs on it are parked — kept at the provider for a take back.
 */
async function markTransferred(tx: SqlExecutor, serverId: string | number, exportId: string | null, targetInstanceUrl: string | null): Promise<void> {
  const locked = await lockTransferServer(tx, serverId);
  await disableTransferredServerSettings(tx, serverId);
  const raw = locked?.server_metadata;
  const metadata: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  const previous = phpArrayCast(dataGet(metadata, "transfer", []));
  const transfer: Record<string, unknown> = Object.fromEntries(phpEntries(previous));
  Object.assign(transfer, {
    status: "transferred",
    export_id: exportId ?? dataGet(metadata, "transfer.export_id"),
    target_instance_url: targetInstanceUrl,
    // Anyone who can write files on the host can write the owner marker, so its URL is not trusted.
    claimed_by_marker: false,
    transferred_at: iso8601(new Date()),
  });
  delete transfer.finish;
  delete transfer.taken_back_at;
  delete transfer.owner_marker_conflict;
  metadata.transfer = transfer;
  await saveServerMetadata(tx, serverId, metadata);
  await releaseServerGithubRunners(tx, serverId, SERVER_TRANSFER_API_MESSAGES.runnersReleased);
  // Kept for a take back. Not owned, so this instance never changes or deletes them at the provider.
  transfer.parked_dns_record_ids = await parkServerDnsRecords(tx, serverId);
  await saveServerMetadata(tx, serverId, metadata);
}
