// Derived from coollabsio/coolify@91b7e3e:routes/web.php (settings.image-scanning, team.image-scanning,
// server.security.vulnerabilities, server.security.image-scanning), app/Livewire/ImageScan/{InstanceImageScanning,
// TeamImageScanning,ScanSettings,ServerImageScanning}.php, app/Livewire/Server/Security/HostVulnerabilities.php,
// app/Livewire/Concerns/ManagesServerPackageUpdates.php, app/Actions/ImageScan/SetServerImageScanning.php and
// app/Jobs/{RefreshImageScanSummariesJob,ImageRescanJob}.php (Apache-2.0), modified.
//
// The image scanning settings (DP-116):
//
//   GET|PATCH /v1/platform/settings/image-scanning            InstanceImageScanning: ScanSettings of the instance (the
//                                                             platform's row, migration 740), behind DP-79's gate:
//                                                             platform.settings.read / .update, a denial is its 404
//   GET|PATCH /v1/organizations/{org}/deploy/team/image-scanning  TeamImageScanning: ScanSettings of the team — the team
//                                                             row, Scan images on new servers (the org's
//                                                             scan_images_on_new_servers, written through
//                                                             membership-worker's PATCH …/team/settings over the
//                                                             existing binding) and the team-wide ignores
//   GET   /servers/{uuid}/security/vulnerabilities             ServerImageScanning with HostVulnerabilities (search,
//                                                             sortBy, showOtherKernels, page, perPage in the query)
//   GET   /servers/{uuid}/security/vulnerabilities/export      HostVulnerabilities::copyList() / downloadList()
//   PATCH /servers/{uuid}/security/vulnerabilities { action }  enable, disable, prepareScanner, deleteScannerData,
//                                                             limit { property, value }, saveRule { column, value },
//                                                             scanHostPackages, updateVulnerablePackage { package },
//                                                             rebootServer, removeUnusedPackages
//
// Every PATCH is { action, … }; saveRule { column, value } and removeIgnore { uuid } as DP-114's. A Livewire toast is
// `toasts` of a 200, a ValidationException a 422 with the fields, an abort() its status. What runs on a server (getting
// the scanner, deleting its data, a host scan, a package update, a reboot) answers 501 "… needs the SSH executor, which
// is not available yet." after Coolify's checks, and stores nothing; turning scanning on gets the scanner, so it answers
// that 501 and stores nothing too, as DP-88's PATCH /api/v1/servers/{uuid}/image-scanning does.
//
// Policy: the team page is a member's (deploy.resource.read), its changes team-wide write (deploy.resource.write; the
// new-servers switch also membership-worker's team update, organization.settings.update); a server's page is
// viewSecurity (deploy.resource.write, as DP-96's security pages); a denial answers 404 and runs nothing.
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import {
  asPlatformAdmin,
  withOrg,
  deleteImageScanIgnore,
  findInstanceImageScanPolicy,
  findScopedImageScanPolicy,
  findServerByUuid,
  findServerHostScan,
  findTeamImageScanPolicy,
  listImageScanPolicies,
  listOrgsWithImageScans,
  listTeamImageScanIgnores,
  readInstanceImageScanPolicy,
  saveImageScanPolicy,
  saveInstanceImageScanPolicy,
  saveTeamImageScanPolicy,
  type ImageScanIgnoreListRow,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse } from "../http.js";
import { authorizeDeploy, columnCipher, readJson } from "./cloud-tokens.js";
import { newPublicId } from "../helpers/names.js";
import { slug } from "../labels/labels.js";
import { serverShow } from "../servers/service.js";
import { findServer, functional, saveSettings, transferredAway, type Found } from "../api-v1/server-settings.js";
import { rowValue } from "../api-v1/models.js";
import { listResources, loadScanData, policyRowOf, refreshScanSummaries, type DecryptValue } from "../image-scan/data.js";
import { MORPH, type IgnoreRow, type PolicyRow } from "../image-scan/model.js";
import { diffForHumans, parseTime } from "../image-scan/php.js";
import { current } from "../image-scan/resource-scans.js";
import { FIX_STATES, findingsCount, PageRefusal } from "../image-scan/vulnerabilities-page.js";
import { optionToBool, renderLevelSettings, SETTINGS_MESSAGES, validateLevelRule, validateScanNewServers, type LevelScope } from "../image-scan/scan-settings.js";
import { findingsCsv, findingsIds, findingsJson, findingsMarkdown } from "../image-scan/exports.js";
import {
  findingSets,
  fixingUpdates,
  hostExportRows,
  hostScanOf,
  hostState,
  isScannerLimit,
  limitValue,
  patchResultOf,
  renderHostVulnerabilities,
  renderServerImageScanning,
  scannerLimits,
  SERVER_SCANNING_MESSAGES,
  validateScannerLimit,
  type ScanningServer,
} from "../image-scan/server-scanning.js";

type Body = Record<string, unknown>;
type Toast = { type: "success" | "error"; message: string };
const toast = (type: Toast["type"], message: string) => ({ toasts: [{ type, message }] });
const text = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : typeof v === "number" || typeof v === "boolean" ? String(v) : "");

/** Runs fn in one transaction confined to the org (withOrg); replaceable for tests. */
export type ImageScanSettingsRunner = <T>(env: Env, orgId: string, fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;
/** Runs fn in one transaction as the platform operator (asPlatformAdmin); replaceable for tests. */
export type ImageScanPlatformRunner = <T>(env: Env, fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;

export const runImageScanSettingsInOrg: ImageScanSettingsRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, fn);
  } finally {
    await db.dispose();
  }
};

export const runImageScanSettingsAsPlatform: ImageScanPlatformRunner = async (env, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await asPlatformAdmin(db, fn);
  } finally {
    await db.dispose();
  }
};

export interface ImageScanSettingsDeps {
  runner?: ImageScanSettingsRunner;
  platformRunner?: ImageScanPlatformRunner;
  now?: () => Date;
  uuid?: () => string;
}

const COLUMNS = ["gate_mode", "on_scan_error", "count_medium"] as const;
type Column = (typeof COLUMNS)[number];
const PROPERTY: Record<Column, string> = { gate_mode: "gateMode", on_scan_error: "onScanError", count_medium: "countMedium" };

const errorOf = (e: PageRefusal, requestId: string) => {
  const code = e.status === 501 ? "unsupported" : e.status === 404 ? "not_found" : e.status === 403 ? "forbidden" : "validation_failed";
  return errorResponse(code, e.message, e.status, requestId, e.fields ? { fields: e.fields } : undefined);
};

const decryptor = (tx: SqlExecutor, orgId: string, env: Env): DecryptValue => {
  const cipher = columnCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, "environment_variables.value");
  return (stored) => cipher.decrypt(stored);
};

/** RefreshImageScanSummariesJob for one org, run in the request: every current scan's summary written again. */
export async function refreshOrgSummaries(tx: SqlExecutor, orgId: string, env: Env, now: Date): Promise<void> {
  const decrypt = decryptor(tx, orgId, env);
  const resources = await listResources(tx, decrypt);
  const data = await loadScanData(tx, resources, now, false);
  await refreshScanSummaries(
    tx,
    resources.flatMap((r) => current(r, data).map((s) => s.id)),
    now,
    decrypt,
  );
}

const ignoreRowOf = (i: ImageScanIgnoreListRow): IgnoreRow => ({
  id: Number(i.id),
  uuid: i.uuid,
  resourceType: i.resource_type,
  resourceId: i.resource_id === null ? null : Number(i.resource_id),
  vulnerabilityId: i.vulnerability_id,
  package: i.package,
  reason: i.reason,
  expiresAt: parseTime(i.expires_at),
  createdAt: parseTime(i.created_at),
});

/** The rule rows the inherit labels read: the org's scoped rows and the instance row. */
async function levelData(tx: SqlExecutor): Promise<{ policies: PolicyRow[]; instancePolicy: PolicyRow | null }> {
  const instance = await findInstanceImageScanPolicy(tx);
  return { policies: (await listImageScanPolicies(tx)).map(policyRowOf), instancePolicy: instance === null ? null : policyRowOf(instance) };
}

/** saveRule()'s column, value and validate() for a level; a refusal is the 422 with the property's field. */
function ruleOf(scope: LevelScope, body: Body): { column: Column; value: string | boolean | null } {
  const column = body.column as Column;
  if (!COLUMNS.includes(column)) throw new PageRefusal("Not found", 404);
  const raw = body.value === undefined ? null : body.value;
  const invalid = validateLevelRule(scope, column, raw);
  if (invalid !== null) throw new PageRefusal(invalid, 422, { [PROPERTY[column]]: [invalid] });
  const value = raw === "" || raw === null ? null : text(raw);
  return { column, value: column === "count_medium" ? optionToBool(value) : value };
}

const unknownAction = () => new PageRefusal("The selected action is invalid.", 422, { action: ["The selected action is invalid."] });

// ── /settings/image-scanning ────────────────────────────────────────────────

/**
 * `allowed` is DP-79's gate (null when the actor may, else the denial's 404), asked before anything else; a read for
 * platform.settings.read, a change for platform.settings.update.
 */
export async function handleInstanceImageScanning(env: Env, requestId: string, request: Request, allowed: (action: string) => Promise<Response | null>, deps: ImageScanSettingsDeps = {}): Promise<Response> {
  const method = request.method;
  const denied = await allowed(method === "PATCH" ? "platform.settings.update" : "platform.settings.read");
  if (denied) return denied;
  if (method !== "GET" && method !== "PATCH") return methodNotAllowed(requestId);
  const platform = deps.platformRunner ?? runImageScanSettingsAsPlatform;
  const runner = deps.runner ?? runImageScanSettingsInOrg;
  const uuid = deps.uuid ?? (() => newPublicId());
  const now = (deps.now ?? (() => new Date()))();
  try {
    if (method === "GET") {
      const [row, canEdit] = await Promise.all([platform(env, (tx) => readInstanceImageScanPolicy(tx, uuid())), allowed("platform.settings.update").then((d) => d === null)]);
      const instancePolicy = policyRowOf(row);
      return successResponse({ settings: renderLevelSettings({ scope: "instance", row: instancePolicy, data: { policies: [], instancePolicy }, canEdit }) }, requestId);
    }
    const body = await readJson(request);
    if (body.action !== "saveRule") throw unknownAction();
    const { column, value } = ruleOf("instance", body);
    const orgs = await platform(env, async (tx) => {
      await saveInstanceImageScanPolicy(tx, uuid(), column, value as string | boolean);
      // refreshStatuses(): every team with scans, after "Count medium problems" changed.
      return column === "count_medium" ? listOrgsWithImageScans(tx) : [];
    });
    for (const orgId of orgs) await runner(env, orgId, (tx) => refreshOrgSummaries(tx, orgId, env, now));
    return successResponse(toast("success", SETTINGS_MESSAGES.saved), requestId);
  } catch (e) {
    if (e instanceof PageRefusal) return errorOf(e, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}

// ── /team/image-scanning ────────────────────────────────────────────────────

export const ORG_DEPLOY_TEAM_IMAGE_SCANNING_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/team\/image-scanning\/?$/;

/** What the team page reads from membership-worker and writes there: the org's switch and who may change it. */
export interface TeamSettingsClient {
  /** scan_images_on_new_servers and membership-worker's team update (canUpdate), or null when the org is not shown. */
  read(): Promise<{ scanImagesOnNewServers: boolean; canUpdate: boolean } | null>;
  /** PATCH …/team/settings { scanImagesOnNewServers }: true when saved, false when membership-worker refused (a 404). */
  save(value: boolean): Promise<boolean>;
}

/** membership-worker over the existing binding: GET /v1/organizations/{org}, GET …/team and PATCH …/team/settings. */
export function membershipTeamSettings(env: Env, orgPublicId: string, actor: ActorContext, requestId: string): TeamSettingsClient {
  const base = `http://membership-worker/v1/organizations/${encodeURIComponent(orgPublicId)}`;
  const headers = { "x-request-id": requestId, "x-actor-subject-id": actor.subjectId, "x-actor-subject-type": actor.subjectType };
  const get = async (url: string): Promise<Record<string, unknown> | null> => {
    try {
      const res = await env.MEMBERSHIP_WORKER!.fetch(url, { headers });
      if (!res.ok) return null;
      return ((await res.json()) as { data?: Record<string, unknown> }).data ?? null;
    } catch {
      return null;
    }
  };
  return {
    async read() {
      const [org, team] = await Promise.all([get(base), get(`${base}/team`)]);
      const organization = org?.organization as Record<string, unknown> | undefined;
      if (!organization) return null;
      return { scanImagesOnNewServers: organization.scanImagesOnNewServers === true, canUpdate: team?.canUpdate === true };
    },
    async save(value) {
      try {
        const res = await env.MEMBERSHIP_WORKER!.fetch(`${base}/team/settings`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ scanImagesOnNewServers: value }) });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}

export async function handleTeamImageScanning(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  orgPublicId: string,
  request: Request,
  deps: ImageScanSettingsDeps & { team?: TeamSettingsClient } = {},
): Promise<Response> {
  const method = request.method;
  if (method !== "GET" && method !== "PATCH") return methodNotAllowed(requestId);
  const read = method === "GET";
  // mount(): a member of the team; a change: team-wide write (authorizeEdit()), asked before anything runs.
  const auth = await authorizeDeploy(env, requestId, actor, orgId, !read);
  if (!auth.ok) return auth.response;
  const runner = deps.runner ?? runImageScanSettingsInOrg;
  const team = deps.team ?? membershipTeamSettings(env, orgPublicId, actor, requestId);
  const uuid = deps.uuid ?? (() => newPublicId());
  const now = (deps.now ?? (() => new Date()))();
  try {
    if (read) {
      const facts = await team.read();
      if (facts === null) return errorResponse("not_found", "Not found", 404, requestId);
      const data = await runner(env, orgId, async (tx) => {
        const [levels, row, ignores] = await Promise.all([levelData(tx), findTeamImageScanPolicy(tx), listTeamImageScanIgnores(tx)]);
        return renderLevelSettings({
          scope: "team",
          row: row === null ? null : policyRowOf(row),
          data: levels,
          canEdit: auth.canWrite,
          scanNewServers: facts.scanImagesOnNewServers,
          canEditScanNewServers: auth.canWrite && facts.canUpdate,
          ignores: ignores.map(ignoreRowOf),
        });
      });
      return successResponse({ settings: data }, requestId);
    }
    const body = await readJson(request);
    switch (body.action) {
      case "saveRule": {
        const { column, value } = ruleOf("team", body);
        await runner(env, orgId, async (tx) => {
          await saveTeamImageScanPolicy(tx, orgId, uuid(), column, value);
          // refreshStatuses(): the team's stored statuses (RefreshImageScanSummariesJob, run in the request).
          if (column === "count_medium") await refreshOrgSummaries(tx, orgId, env, now);
        });
        return successResponse(toast("success", SETTINGS_MESSAGES.saved), requestId);
      }
      case "scanNewServers": {
        const v = validateScanNewServers(body.value);
        if (!v.ok) throw new PageRefusal(v.message, 422, { scanNewServers: [v.message] });
        // $team->scan_images_on_new_servers = …; $team->save(): the org's column, membership-worker's.
        if (!(await team.save(v.value))) return errorResponse("not_found", "Not found", 404, requestId);
        return successResponse(toast("success", SETTINGS_MESSAGES.saved), requestId);
      }
      case "removeIgnore": {
        const removed = await runner(env, orgId, async (tx) => {
          const found = (await listTeamImageScanIgnores(tx)).find((i) => i.uuid === text(body.uuid));
          if (found === undefined) return false;
          await deleteImageScanIgnore(tx, Number(found.id));
          await refreshOrgSummaries(tx, orgId, env, now);
          return true;
        });
        if (!removed) return errorResponse("not_found", "Not found", 404, requestId);
        return successResponse(toast("success", SETTINGS_MESSAGES.removed), requestId);
      }
      default:
        throw unknownAction();
    }
  } catch (e) {
    if (e instanceof PageRefusal) return errorOf(e, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}

// ── /server/{uuid}/security/vulnerabilities ─────────────────────────────────

/** Whether handleServers routes what follows /servers/{uuid} here. */
export const isServerImageScanRoute = (rest: readonly string[]): boolean => rest[0] === "security" && rest[1] === "vulnerabilities" && (rest.length === 2 || (rest.length === 3 && rest[2] === "export"));

const settingsOf = (f: Found): Record<string, unknown> => Object.fromEntries(f.settings);
function metadataOf(f: Found): unknown {
  const m = rowValue(f.server, "server_metadata");
  if (typeof m !== "string") return m ?? null;
  try {
    return JSON.parse(m) as unknown;
  } catch {
    return null;
  }
}
const scanningServer = (f: Found): ScanningServer => ({ name: String(rowValue(f.server, "name") ?? ""), serverMetadata: metadataOf(f), settings: settingsOf(f) });

/** ImageRescanJob::canRunOn(): scanning on, managed here, functional. */
const hostScanAvailable = (f: Found): boolean => rowValue(f.settings, "is_image_scan_enabled") === true && !transferredAway(f) && functional(f);

/** ensureManagedHere() as handleError() shows it: the message as the error toast. */
const managedElsewhere = (f: Found, prefix = ""): object | null => (transferredAway(f) ? toast("error", `${prefix}${SERVER_SCANNING_MESSAGES.managedElsewhere}`) : null);

/** segments: what follows /servers/{uuid} — ["security", "vulnerabilities"] or […, "export"]. */
export async function handleServerImageScanning(env: Env, requestId: string, actor: ActorContext, orgId: string, uuid: string, segments: string[], request: Request, deps: ImageScanSettingsDeps = {}): Promise<Response> {
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  if (!isServerImageScanRoute(segments)) return notFound();
  const route = segments.length === 2 ? "page" : "export";
  const method = request.method;
  if (!(method === "GET" || (route === "page" && method === "PATCH"))) return methodNotAllowed(requestId);
  // mount(): authorize('viewSecurity', $server) — an admin of the team, as every action's authorize('update').
  const auth = await authorizeDeploy(env, requestId, actor, orgId, true);
  if (!auth.ok) return auth.response;
  const runner = deps.runner ?? runImageScanSettingsInOrg;
  const now = (deps.now ?? (() => new Date()))();
  const uuidOf = deps.uuid ?? (() => newPublicId());
  const query = new URL(request.url).searchParams;
  const body = method === "PATCH" ? await readJson(request) : {};
  try {
    const data = await runner(env, orgId, async (tx): Promise<object | null> => {
      const row = await findServerByUuid(tx, uuid);
      const f = row ? await findServer(tx, uuid) : null;
      if (!row || !f) return null;
      const serverId = Number(rowValue(f.server, "id"));
      const name = String(rowValue(f.server, "name") ?? "");
      const scan = hostScanOf(await findServerHostScan(tx, serverId));
      const patchResult = patchResultOf(rowValue(f.settings, "patch_check_result"));

      if (route === "export") {
        const format = query.get("format") ?? "";
        if (!["markdown", "ids", "csv", "json"].includes(format)) return null;
        const rows = hostExportRows(findingSets(scan, patchResult, hostState(query)).shown);
        if (format === "ids") return { content: findingsIds(rows) };
        if (format === "markdown") return { content: findingsMarkdown(`Vulnerabilities of the server ${name} (${findingsCount(rows.length)})`, rows, false, false) };
        const filename = `${slug(name) || "server"}-host-vulnerabilities-${now.toISOString().slice(0, 10)}.${format}`;
        return format === "csv"
          ? { filename, contentType: "text/csv; charset=UTF-8", content: findingsCsv(rows, FIX_STATES) }
          : { filename, contentType: "application/json", content: findingsJson({ type: "server", name, uuid: String(rowValue(f.server, "uuid") ?? uuid) }, rows, FIX_STATES, now) };
      }

      if (method === "GET") {
        const levels = await levelData(tx);
        const own = await findScopedImageScanPolicy(tx, MORPH.server, serverId);
        return {
          server: serverShow(row),
          canUpdate: auth.canWrite,
          scanning: renderServerImageScanning(scanningServer(f)),
          settings: renderLevelSettings({ scope: "server", row: own === null ? null : policyRowOf(own), data: levels, canEdit: auth.canWrite }),
          host: renderHostVulnerabilities(scan, patchResult, hostState(query), { serverName: name, hostScanAvailable: hostScanAvailable(f), canUpdate: auth.canWrite, now, ago: (d) => diffForHumans(d, now) }),
        };
      }

      switch (body.action) {
        // ServerImageScanning::enable(): SetServerImageScanning::run($server, true) — ensureManagedHere(), then the
        // switch and PrepareImageScannerJob, which pulls the scanner on the server.
        case "enable":
          return managedElsewhere(f) ?? refuse(SERVER_SCANNING_MESSAGES.scannerUnavailable);
        case "disable":
          await saveSettings(tx, f, { is_image_scan_enabled: false });
          return toast("success", SERVER_SCANNING_MESSAGES.disabled);
        case "prepareScanner": {
          const elsewhere = managedElsewhere(f);
          if (elsewhere) return elsewhere;
          if (rowValue(f.settings, "is_image_scan_enabled") !== true) return toast("error", SERVER_SCANNING_MESSAGES.turnOnFirst);
          return refuse(SERVER_SCANNING_MESSAGES.scannerUnavailable);
        }
        case "deleteScannerData":
          // handleError($e, $this, 'Could not delete the scanner data.'): the custom message, a space, the error's.
          return managedElsewhere(f, `${SERVER_SCANNING_MESSAGES.deleteFailed} `) ?? refuse(SERVER_SCANNING_MESSAGES.deleteUnavailable);
        case "limit": {
          const property = body.property;
          if (!isScannerLimit(property)) throw new PageRefusal("Not found", 404);
          const server = scanningServer(f);
          const invalid = validateScannerLimit(server, property, body.value);
          if (invalid !== null) throw new PageRefusal(invalid, 422, { [property]: [invalid] });
          const elsewhere = managedElsewhere(f);
          if (elsewhere) return elsewhere;
          const limit = scannerLimits(server)[property];
          await saveSettings(tx, f, { [limit.column]: limitValue(property, text(body.value)) });
          return toast("success", limit.message);
        }
        case "saveRule": {
          const { column, value } = ruleOf("server", body);
          await saveImageScanPolicy(tx, orgId, uuidOf(), MORPH.server, serverId, column, value);
          // refreshStatuses(): the team of the server (RefreshImageScanSummariesJob, run in the request).
          if (column === "count_medium") await refreshOrgSummaries(tx, orgId, env, now);
          return toast("success", SETTINGS_MESSAGES.saved);
        }
        case "scanHostPackages":
          if (transferredAway(f)) return toast("error", SERVER_SCANNING_MESSAGES.managedElsewhere);
          if (!hostScanAvailable(f)) return toast("error", SERVER_SCANNING_MESSAGES.hostTurnOnFirst);
          // ScanHostPackagesJob runs the scanner on the server.
          return refuse(SERVER_SCANNING_MESSAGES.hostScanUnavailable);
        case "updateVulnerablePackage": {
          const pkg = text(body.package);
          const isFinding = (scan?.findings ?? []).some((finding) => typeof finding === "object" && finding !== null && (finding as Record<string, unknown>).package === pkg);
          const packages = fixingUpdates(pkg, patchResult).map((u) => u.package);
          if (!isFinding || packages.length === 0) return toast("error", SERVER_SCANNING_MESSAGES.noPackageUpdate);
          // runUpdate(): ensureManagedHere(), the saved check's package manager and OS, then UpdatePackage over SSH.
          const elsewhere = managedElsewhere(f);
          if (elsewhere) return elsewhere;
          if (!patchResult?.package_manager || !patchResult?.osId) return toast("error", SERVER_SCANNING_MESSAGES.checkFirst);
          return refuse(SERVER_SCANNING_MESSAGES.packageUpdateUnavailable);
        }
        case "rebootServer":
          return managedElsewhere(f) ?? refuse(SERVER_SCANNING_MESSAGES.rebootUnavailable);
        case "removeUnusedPackages":
          return managedElsewhere(f) ?? refuse(SERVER_SCANNING_MESSAGES.removeUnusedUnavailable);
        default:
          throw unknownAction();
      }
    });
    if (data === null) return notFound();
    return successResponse(data, requestId);
  } catch (e) {
    if (e instanceof PageRefusal) return errorOf(e, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}

/** What needs the SSH executor: a 501 that has stored nothing (thrown, so the transaction stores nothing either). */
function refuse(message: string): never {
  throw new PageRefusal(message, 501);
}
