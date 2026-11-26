// Derived from coollabsio/coolify@91b7e3e:routes/web.php (project.{application,service,database}.vulnerabilities[.sbom],
// vulnerabilities), app/Livewire/ImageScan/{Vulnerabilities,Packages,ScanSettings,FleetVulnerabilities}.php and
// app/Http/Controllers/ImageScanSbomController.php (Apache-2.0), modified.
//
// The console's Security pages (DP-114). Dispatched by handleApplications, handleServices and handleDatabases (what follows
// /applications, /services or /databases) and by the router (/vulnerabilities):
//
//   GET   /{applications,services,databases}/{uuid}/vulnerabilities          the frame, Vulnerabilities::render() for the
//                                                                            page state in the query (fixState, severities,
//                                                                            images, view, search, showIgnored, page,
//                                                                            perPage), Packages::render() (packagesSearch,
//                                                                            packagesTypes, packagesImages, packagesPage,
//                                                                            packagesPerPage) and ScanSettings::render()
//   GET   …/vulnerabilities/export?format=markdown|ids|csv|json             copyList() / downloadList() of the shown findings
//   GET   …/vulnerabilities/sbom/{scan_uuid}/{cyclonedx|spdx}?environment=  ImageScanSbomController: a current scan's stored
//                                                                            package list as CycloneDX 1.6 or SPDX 2.3 JSON
//   PATCH …/vulnerabilities  { action, … }                                  the page's actions:
//            scanNow, updateImage { candidateRef, ownerUuid }, updateImages { actionKey }, rebuild
//                                   Coolify's checks, then 501: they scan, pull, update or rebuild on the server, which
//                                   needs the SSH executor; nothing is stored
//            removeImageOverride { service }        the compose file's image again
//            ignore { target, kind, scope, expires, reason, ownerUuid }   an ignore stored, the summaries written again
//            saveRule { column, value }, appScanEnabled { value }, buildsByTeam { value }, removeIgnore { uuid }
//                                                   ScanSettings of the application / of the resource's ignores
//   GET   /vulnerabilities, /vulnerabilities/export?format=markdown|csv|json  FleetVulnerabilities (search, statuses,
//                                                                            servers, projects, showNotChecked, page, perPage)
//
// $this->authorize('view' | 'update' | 'deploy', $resource) and the team-wide write: deploy.resource.read and
// deploy.resource.write; a denial answers 404 and runs nothing. A Livewire toast is `toasts` of a 200; an abort() its
// status; a ValidationException a 422 with the fields (and its first message as the toast, validateOrToast()).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  findApplicationByUuid,
  countServersNotScanning,
  deleteImageScanIgnore,
  findApplicationScanSettings,
  insertImageScanIgnore,
  listImageSboms,
  listImageScanEnvironments,
  listImageScanIgnoresFor,
  listImageScanSbomIds,
  saveImageScanPolicy,
  updateApplicationImageOverrides,
  updateApplicationScanSetting,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse } from "../http.js";
import { authorizeDeploy, columnCipher, readJson } from "./cloud-tokens.js";
import { applicationShow } from "../applications/service.js";
import { loadServiceInfo } from "../services/configuration.js";
import { serviceResourcesContext } from "./service-configuration.js";
import { showDatabase } from "../databases/service.js";
import { sqlStore } from "./databases.js";
import type { KeyCipher } from "../private-keys/service.js";
import { fetchOrganizationFacts } from "../membership-client.js";
import { newPublicId } from "../helpers/names.js";
import { slug } from "../labels/labels.js";
import { findResource, listResources, loadScanData, refreshScanSummaries, type DecryptValue } from "../image-scan/data.js";
import { MORPH, isTransferredAway, type IgnoreRow, type ScanData, type ScanResource } from "../image-scan/model.js";
import { isRecord, parseTime, phpTrim, str } from "../image-scan/php.js";
import { mainServerOf } from "../image-scan/policy.js";
import { current, key } from "../image-scan/resource-scans.js";
import { forResource } from "../image-scan/security-status.js";
import { actionKey, knowsRunningCommit } from "../image-scan/security-card.js";
import {
  addDays,
  exportRows,
  findingsCount,
  FIX_STATES,
  hasExploitSignal,
  MESSAGES,
  ownerFindings,
  ownerOf,
  pageContext,
  pageState,
  PageRefusal,
  renderVulnerabilities,
  scanNowRefusal,
  SSH_UNAVAILABLE,
  updateRefusal,
  validateIgnore,
  type PageViewer,
} from "../image-scan/vulnerabilities-page.js";
import { optionToBool, renderScanSettings, resourceIgnoreOwners, SETTINGS_MESSAGES, validateRule } from "../image-scan/scan-settings.js";
import { cycloneDx, fleetCsv, fleetJson, fleetMarkdown, findingsCsv, findingsIds, findingsJson, findingsMarkdown, phpPrettyJson, SBOM_FORMATS, spdx } from "../image-scan/exports.js";
import { loadTeamVulnerabilities } from "../image-scan/team-vulnerabilities.js";
import { fleetExportEntries, fleetListing, fleetState, renderFleet, vulnerabilitiesUrl, type FleetEntry } from "../image-scan/fleet-page.js";

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;
export type ImageScanResourceKind = "application" | "service" | "database";

export const ORG_DEPLOY_VULNERABILITIES_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/vulnerabilities((?:\/[^/]+){0,1})\/?$/;

/** Whether handleImageScanPages serves the route. segments: what follows /applications, /services or /databases. */
export const isImageScanPageRoute = (segments: readonly string[]): boolean => segments.length >= 2 && segments[1] === "vulnerabilities";

/** Runs fn in one transaction confined to the org (withOrg); replaceable for tests. */
export type ImageScanPagesRunner = <T>(env: Env, orgId: string, fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;

export const runImageScanPagesInOrg: ImageScanPagesRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, fn);
  } finally {
    await db.dispose();
  }
};

export interface ImageScanPagesDeps {
  runner?: ImageScanPagesRunner;
  now?: () => Date;
  uuid?: () => string;
}

type Toast = { type: "success" | "error"; message: string };
const toast = (type: Toast["type"], message: string) => ({ toasts: [{ type, message }] });

const decryptor = (tx: SqlExecutor, orgId: string, env: Env): DecryptValue => {
  const cipher = columnCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, "environment_variables.value");
  return (stored) => cipher.decrypt(stored);
};

const viewer = (canWrite: boolean): PageViewer => ({
  canUpdate: canWrite,
  canDeploy: canWrite,
  canUpdateServer: canWrite,
  registriesUrl: (uuid) => `/server/${uuid}/registries`,
  serverUrl: (uuid) => `/server/${uuid}/security/vulnerabilities`,
});

/** The resource for the frame (the Configuration component), or null when it is not the org's. */
async function frameOf(tx: SqlExecutor, env: Env, orgId: string, kind: ImageScanResourceKind, uuid: string, canWrite: boolean): Promise<Record<string, unknown> | null> {
  if (kind === "application") {
    const row = await findApplicationByUuid(tx, uuid);
    return row ? { application: applicationShow(row, canWrite), canUpdate: canWrite, canDeploy: canWrite } : null;
  }
  if (kind === "service") {
    const l = await loadServiceInfo(serviceResourcesContext(tx, orgId, env.DEPLOY_ENCRYPTION_KEY).configuration, uuid);
    return l ? { service: l.info, canUpdate: canWrite, canManage: canWrite, canDelete: canWrite } : null;
  }
  const ciphers = new Map<string, KeyCipher>();
  const cipher = (column: string): KeyCipher => {
    let found = ciphers.get(column);
    if (!found) ciphers.set(column, (found = columnCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, column)));
    return found;
  };
  const database = await showDatabase({ store: sqlStore(tx, orgId), cipher }, uuid, canWrite);
  return database ? { database, canUpdate: canWrite, canManage: canWrite, canDelete: canWrite } : null;
}

const ignoreRowOf = (i: Awaited<ReturnType<typeof listImageScanIgnoresFor>>[number]): IgnoreRow => ({
  id: i.id,
  uuid: i.uuid,
  resourceType: i.resource_type,
  resourceId: i.resource_id,
  vulnerabilityId: i.vulnerability_id,
  package: i.package,
  reason: i.reason,
  expiresAt: parseTime(i.expires_at),
  createdAt: parseTime(i.created_at),
});

/** ScanSettings::ignores() of a resource scope: the team-wide ones and the resource's, resource ones first, newest first. */
async function resourceIgnores(tx: SqlExecutor, resource: ScanResource): Promise<IgnoreRow[]> {
  const owners: Record<string, number[]> = {};
  for (const o of resourceIgnoreOwners(resource)) (owners[o.morphClass] ??= []).push(o.id);
  return (await listImageScanIgnoresFor(tx, owners)).map(ignoreRowOf);
}

// ── Packages ────────────────────────────────────────────────────────────────

interface PackagesState {
  search: string;
  types: string[];
  images: string[];
  page: number;
  perPage: number;
}

function packagesState(q: URLSearchParams): PackagesState {
  const listOf = (name: string) => [...new Set(q.getAll(name).filter((v) => v !== ""))];
  const n = Number.parseInt(q.get("packagesPage") ?? "", 10);
  const p = Number.parseInt(q.get("packagesPerPage") ?? "", 10);
  return { search: q.get("packagesSearch") ?? "", types: listOf("packagesTypes"), images: listOf("packagesImages"), page: Number.isFinite(n) ? n : 1, perPage: Number.isFinite(p) ? p : 10 };
}

/** Packages::render(): the packages of the current scans' stored package lists, with the SBOM downloads. */
async function renderPackages(tx: SqlExecutor, resource: ScanResource, data: ScanData, state: PackagesState) {
  const all = current(resource, data);
  const sbomIds = await listImageScanSbomIds(
    tx,
    all.map((s) => s.id),
  );
  const scans = all.filter((s) => (sbomIds.get(s.id) ?? null) !== null);
  const sboms = new Map((await listImageSboms(tx, [...new Set(scans.map((s) => sbomIds.get(s.id)!))])).map((s) => [s.id, s]));
  const packages = scans.flatMap((scan) => {
    const sbom = sboms.get(sbomIds.get(scan.id)!);
    let rows: unknown = [];
    try {
      rows = sbom === undefined ? [] : JSON.parse(sbom.packages);
    } catch {
      rows = [];
    }
    const list = Array.isArray(rows) ? rows : isRecord(rows) ? Object.values(rows) : [];
    return list.flatMap((row, index) =>
      isRecord(row)
        ? [
            {
              key: `${scan.uuid}-${index}`,
              name: str(row.name ?? ""),
              version: str(row.version ?? ""),
              type: str(row.type ?? ""),
              licenses: (Array.isArray(row.licenses) ? row.licenses : row.licenses === null || row.licenses === undefined ? [] : [row.licenses]).map((l) => str(l)),
              purl: str(row.purl ?? ""),
              image: scan.imageRef,
            },
          ]
        : [],
    );
  });
  const typeOptions = [...new Set(packages.map((p) => p.type).filter((t) => t !== ""))].sort();
  const imageOptions = [...new Set(scans.map((s) => s.imageRef))];
  const images = state.images.filter((i) => imageOptions.includes(i));
  const search = phpTrim(state.search).toLowerCase();
  const filtered = packages
    .filter((p) => state.types.length === 0 || state.types.includes(p.type))
    .filter((p) => images.length === 0 || images.includes(p.image))
    .filter((p) => search === "" || `${p.name} ${p.version} ${p.purl}`.toLowerCase().includes(search))
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.name < b.p.name ? -1 : a.p.name > b.p.name ? 1 : a.p.version < b.p.version ? -1 : a.p.version > b.p.version ? 1 : a.i - b.i))
    .map(({ p }) => p);
  const perPage = Math.max(1, Math.min(100, state.perPage));
  const lastPage = Math.max(1, Math.ceil(filtered.length / perPage));
  const page = Math.max(1, Math.min(state.page, lastPage));
  const slice = filtered.slice((page - 1) * perPage, page * perPage);
  return {
    state: { search: state.search, types: state.types, images },
    hasScans: scans.length > 0,
    total: packages.length,
    items: { items: slice, total: filtered.length, perPage, currentPage: page, lastPage, firstItem: slice.length === 0 ? null : (page - 1) * perPage + 1, lastItem: slice.length === 0 ? null : (page - 1) * perPage + slice.length },
    typeOptions,
    imageOptions: imageOptions.length > 1 ? imageOptions : [],
    showsImage: imageOptions.length > 1,
    truncated: scans.some((s) => sboms.get(sbomIds.get(s.id)!)?.packages_truncated === true),
    downloads: scans.map((s) => ({ image: s.imageRef, scanUuid: s.uuid })),
  };
}

// ── the resource page's actions ─────────────────────────────────────────────

type Body = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : typeof v === "number" || typeof v === "boolean" ? String(v) : "");
const nullableText = (v: unknown): string | null => (v === null || v === undefined ? null : text(v));

interface ActionCtx {
  tx: SqlExecutor;
  env: Env;
  orgId: string;
  resource: ScanResource;
  data: ScanData;
  decrypt: DecryptValue;
  now: Date;
  uuid: () => string;
}

/** ResourceScans::refreshSummaries(ResourceScans::current($scope)), or of the team (RefreshImageScanSummariesJob, run now). */
async function refreshSummaries(c: ActionCtx, teamWide: boolean): Promise<void> {
  if (!teamWide) return refreshScanSummaries(c.tx, current(c.resource, c.data).map((s) => s.id), c.now, c.decrypt);
  const resources = await listResources(c.tx, c.decrypt);
  const data = await loadScanData(c.tx, resources, c.now, false);
  await refreshScanSummaries(
    c.tx,
    resources.flatMap((r) => current(r, data).map((s) => s.id)),
    c.now,
    c.decrypt,
  );
}

async function runAction(c: ActionCtx, body: Body): Promise<object> {
  const { resource, data } = c;
  switch (body.action) {
    case "scanNow": {
      const refusal = scanNowRefusal(resource, data);
      if (refusal !== null) return toast("error", refusal);
      // ScanResourceImagesJob runs Syft and Grype on the server.
      throw new PageRefusal(SSH_UNAVAILABLE.scan, 501);
    }
    case "removeImageOverride": {
      if (resource.kind !== "application" || resource.buildPack !== "dockercompose") throw new PageRefusal("Not found", 404);
      if (isTransferredAway(resource.destinationServer)) return toast("error", MESSAGES.transferred);
      const service = text(body.service);
      const overrides = isRecord(resource.dockerComposeImageOverrides) ? { ...resource.dockerComposeImageOverrides } : {};
      if (!(service in overrides) || overrides[service] === null) return { toasts: [] };
      delete overrides[service];
      await updateApplicationImageOverrides(c.tx, resource.id, Object.keys(overrides).length === 0 ? null : JSON.stringify(overrides));
      return toast("success", MESSAGES.overrideRemoved);
    }
    case "updateImage": {
      const candidateRef = text(body.candidateRef);
      const ownerUuid = nullableText(body.ownerUuid);
      const target = ownerOf(resource, ownerUuid === "" ? null : ownerUuid);
      if (target === null) throw new PageRefusal("Not found", 404);
      const sec = forResource(resource, data);
      const a = sec.actions.find((x) => x.ref === candidateRef || x.parts.some((p) => p.ref === candidateRef));
      const refusal = updateRefusal(a);
      if (refusal !== null) return toast("error", refusal);
      // UpdateResourceImage::authorizeFor(): a server another instance manages.
      const server = mainServerOf(resource);
      if (server !== null && isTransferredAway(server)) return toast("error", MESSAGES.transferred);
      throw new PageRefusal(SSH_UNAVAILABLE.update, 501);
    }
    case "updateImages": {
      if (resource.kind !== "service") throw new PageRefusal("Not found", 404);
      const sec = forResource(resource, data);
      const a = sec.actions.find((x) => x.parts.length > 0 && actionKey(x) === text(body.actionKey));
      const refusal = updateRefusal(a);
      if (refusal !== null) return toast("error", refusal);
      const server = mainServerOf(resource);
      if (server !== null && isTransferredAway(server)) return toast("error", MESSAGES.transferred);
      throw new PageRefusal(SSH_UNAVAILABLE.update, 501);
    }
    case "rebuild": {
      if (resource.kind !== "application") throw new PageRefusal("Not found", 404);
      if (resource.id === 0) throw new PageRefusal(MESSAGES.ownResources, 403);
      if (!data.latestFinishedCommit.has(resource.id)) return toast("error", MESSAGES.deployFirst);
      if (!knowsRunningCommit(resource, data.latestFinishedCommit.get(resource.id) ?? null)) return toast("error", MESSAGES.unknownCommit);
      const server = resource.destinationServer;
      if (server === null) return toast("error", MESSAGES.serverGone);
      if (isTransferredAway(server)) return toast("error", MESSAGES.transferred);
      // queue_application_deployment() builds and deploys on the server.
      throw new PageRefusal(SSH_UNAVAILABLE.rebuild, 501);
    }
    case "ignore":
      return ignore(c, body);
    case "saveRule":
      return saveRule(c, body);
    case "appScanEnabled":
    case "buildsByTeam": {
      if (resource.kind !== "application") throw new PageRefusal("Not found", 404);
      const value = body.value === null || body.value === undefined ? "" : text(body.value);
      const field = body.action;
      if (field === "appScanEnabled" && value === "") throw new PageRefusal("The app scan enabled field is required.", 422, { appScanEnabled: ["The app scan enabled field is required."] });
      if (value !== "" && value !== "1" && value !== "0") {
        const message = field === "appScanEnabled" ? "The selected app scan enabled is invalid." : "The selected builds by team is invalid.";
        throw new PageRefusal(message, 422, { [field]: [message] });
      }
      await updateApplicationScanSetting(c.tx, resource.id, field === "appScanEnabled" ? "is_image_scan_enabled" : "image_builds_by_team", optionToBool(value));
      return toast("success", SETTINGS_MESSAGES.saved);
    }
    case "removeIgnore": {
      const ignores = (await resourceIgnores(c.tx, resource)).filter((i) => i.resourceId !== null);
      const found = ignores.find((i) => i.uuid === text(body.uuid));
      if (found === undefined) throw new PageRefusal("Not found", 404);
      await deleteImageScanIgnore(c.tx, found.id);
      await refreshSummaries(c, false);
      return toast("success", SETTINGS_MESSAGES.removed);
    }
    default:
      throw new PageRefusal("The selected action is invalid.", 422, { action: ["The selected action is invalid."] });
  }
}

/** Vulnerabilities::ignore() */
async function ignore(c: ActionCtx, body: Body): Promise<object> {
  const { resource } = c;
  const kind = text(body.kind);
  const scope = text(body.scope);
  const expires = text(body.expires);
  const target = text(body.target);
  const pkg = kind === "package" ? target.replace(/\p{Cc}/gu, "") : null;
  const input = { kind, scope, expires, vulnerability_id: kind === "vulnerability" ? target : null, package: pkg, reason: phpTrim(text(body.reason)) };
  const fail = (fields: Record<string, string[]>) => {
    const first = Object.values(fields).flat()[0]!;
    return new PageRefusal(first, 422, fields);
  };
  const errors = validateIgnore(input);
  if (Object.keys(errors).length > 0) throw fail(errors);
  const ownerUuid = nullableText(body.ownerUuid);
  const owner = ownerOf(resource, ownerUuid === "" ? null : ownerUuid);
  if (owner === null) throw new PageRefusal("Not found", 404);
  const pc = pageContext(resource, c.data);
  const matching = ownerFindings(pc, owner, kind, kind === "package" ? str(pkg) : target);
  if (matching.length === 0) throw fail({ [kind === "package" ? "package" : "vulnerability_id"]: [MESSAGES.notInResults] });
  if (expires === "never" && matching.some(hasExploitSignal)) throw fail({ expires: [MESSAGES.mustExpire] });
  await insertImageScanIgnore(c.tx, c.orgId, {
    uuid: c.uuid(),
    resourceType: scope === "resource" ? owner.morphClass : null,
    resourceId: scope === "resource" ? owner.id : null,
    vulnerabilityId: input.vulnerability_id,
    package: input.package,
    reason: input.reason,
    expiresAt: expires === "never" ? null : addDays(c.now, Number(expires)),
  });
  await refreshSummaries(c, scope === "team");
  return toast("success", MESSAGES.ignored);
}

/** ScanSettings::saveRule() of an application. */
async function saveRule(c: ActionCtx, body: Body): Promise<object> {
  const { resource } = c;
  if (resource.kind !== "application") throw new PageRefusal("Not found", 404);
  const column = body.column;
  if (column !== "gate_mode" && column !== "on_scan_error" && column !== "count_medium") throw new PageRefusal("Not found", 404);
  const property = column === "gate_mode" ? "gateMode" : column === "on_scan_error" ? "onScanError" : "countMedium";
  const raw = body.value === undefined ? null : body.value;
  const invalid = validateRule(column, raw);
  if (invalid !== null) throw new PageRefusal(invalid, 422, { [property]: [invalid] });
  if (column === "gate_mode" && resource.settings?.isImageScanEnabled !== true) return toast("error", SETTINGS_MESSAGES.scanFirst);
  const value = raw === "" || raw === null ? null : text(raw);
  await saveImageScanPolicy(c.tx, c.orgId, c.uuid(), MORPH.application, resource.id, column, column === "count_medium" ? optionToBool(value) : value);
  // refreshStatuses(): the app's stored statuses after "Count medium problems" changed.
  if (column === "count_medium") {
    const resources = await listResources(c.tx, c.decrypt);
    const data = await loadScanData(c.tx, resources, c.now, false);
    const self = resources.find((r) => key(r) === key(resource));
    if (self !== undefined) await refreshScanSummaries(c.tx, current(self, data).map((s) => s.id), c.now, c.decrypt);
  }
  return toast("success", SETTINGS_MESSAGES.saved);
}

// ── the handlers ────────────────────────────────────────────────────────────

const errorOf = (e: PageRefusal, requestId: string) => {
  const code = e.status === 501 ? "unsupported" : e.status === 404 ? "not_found" : e.status === 403 ? "forbidden" : "validation_failed";
  return errorResponse(code, e.message, e.status, requestId, e.fields ? { fields: e.fields } : undefined);
};

/** segments: what follows /applications, /services or /databases — [uuid, "vulnerabilities", …]. */
export async function handleImageScanPages(env: Env, requestId: string, actor: ActorContext, orgId: string, kind: ImageScanResourceKind, segments: string[], request: Request, deps: ImageScanPagesDeps = {}): Promise<Response> {
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  const runner = deps.runner ?? runImageScanPagesInOrg;
  const now = (deps.now ?? (() => new Date()))();
  const [uuid, , sub, scanUuid, format] = segments;
  if (!uuid || !UUID_RE.test(uuid) || !isImageScanPageRoute(segments)) return notFound();
  const route = segments.length === 2 ? "page" : segments.length === 3 && sub === "export" ? "export" : segments.length === 5 && sub === "sbom" ? "sbom" : null;
  if (route === null) return notFound();
  const read = request.method === "GET";
  if (!read && !(route === "page" && request.method === "PATCH")) return methodNotAllowed(requestId);
  const query = new URL(request.url).searchParams;

  // $this->authorize('view' | 'update', $resource)
  const auth = await authorizeDeploy(env, requestId, actor, orgId, !read);
  if (!auth.ok) return auth.response;
  const canWrite = auth.canWrite;
  const body = read ? {} : await readJson(request);

  try {
    const data = await runner(env, orgId, async (tx): Promise<object | null> => {
      const decrypt = decryptor(tx, orgId, env);
      const resource = await findResource(tx, kind, uuid, decrypt);
      if (resource === null) return null;
      const scanData = await loadScanData(tx, [resource], now, true);

      if (route === "sbom") {
        // ImageScanSbomController
        if (!(SBOM_FORMATS as readonly string[]).includes(str(format))) return null;
        if (resource.environment?.uuid !== query.get("environment")) return null;
        const scan = current(resource, scanData).find((s) => s.uuid === scanUuid);
        if (scan === undefined) return null;
        const sbomId = (await listImageScanSbomIds(tx, [scan.id])).get(scan.id) ?? null;
        const sbom = sbomId === null ? undefined : (await listImageSboms(tx, [sbomId]))[0];
        if (sbom === undefined || sbom.server_id !== scan.serverId) return null;
        let packages: unknown = [];
        try {
          packages = JSON.parse(sbom.packages);
        } catch {
          packages = [];
        }
        const id = (deps.uuid ?? (() => crypto.randomUUID()))();
        const document = format === "cyclonedx" ? cycloneDx(scan.imageRef, packages, now, id) : spdx(scan.imageRef, packages, now, id);
        const name = slug(`${str(resource.name)}-${scan.imageRef}`) || "image";
        return { filename: `${name}-sbom.${format === "cyclonedx" ? "cdx.json" : "spdx.json"}`, contentType: "application/json", content: phpPrettyJson(document) };
      }

      const c = pageContext(resource, scanData);
      if (route === "export") {
        const f = query.get("format") ?? "";
        if (!["markdown", "ids", "csv", "json"].includes(f)) return null;
        const state = pageState(query);
        const shown = exportRows(c, state);
        if (shown === null) return null;
        const { rows, multipleImages } = shown;
        if (f === "ids") return { content: findingsIds(rows) };
        if (f === "markdown") {
          const scope = state.showIgnored ? "ignored" : FIX_STATES[state.fixState in FIX_STATES ? state.fixState : "fixed"];
          return { content: findingsMarkdown(`Vulnerabilities of ${str(resource.name)} (${findingsCount(rows.length)}, ${scope})`, rows, multipleImages, state.showIgnored) };
        }
        const filename = `${slug(str(resource.name)) || "resource"}-vulnerabilities-${now.toISOString().slice(0, 10)}.${f}`;
        return f === "csv"
          ? { filename, contentType: "text/csv; charset=UTF-8", content: findingsCsv(rows, FIX_STATES) }
          : { filename, contentType: "application/json", content: findingsJson({ type: kind, name: str(resource.name), uuid }, rows, FIX_STATES, now) };
      }

      if (read) {
        const frame = await frameOf(tx, env, orgId, kind, uuid, canWrite);
        if (frame === null) return null;
        const settings = resource.kind === "application" ? await findApplicationScanSettings(tx, resource.id) : null;
        return {
          ...frame,
          vulnerabilities: renderVulnerabilities(c, pageState(query), viewer(canWrite)),
          packages: await renderPackages(tx, resource, scanData, packagesState(query)),
          settings: renderScanSettings(resource, scanData, await resourceIgnores(tx, resource), resource.kind === "application" ? (settings?.image_builds_by_team ?? null) : null, canWrite),
          resourceType: kind,
        };
      }
      return runAction({ tx, env, orgId, resource, data: scanData, decrypt, now, uuid: deps.uuid ?? (() => newPublicId()) }, body);
    });
    if (!data) return notFound();
    return successResponse(data, requestId);
  } catch (e) {
    if (e instanceof PageRefusal) return errorOf(e, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}

/** /vulnerabilities and /vulnerabilities/export: FleetVulnerabilities. segments: what follows /vulnerabilities. */
export async function handleFleetVulnerabilities(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  orgPublicId: string,
  segments: string[],
  request: Request,
  deps: ImageScanPagesDeps & { teamName?: () => Promise<string> } = {},
): Promise<Response> {
  const route = segments.length === 0 ? "page" : segments.length === 1 && segments[0] === "export" ? "export" : null;
  if (route === null) return errorResponse("not_found", "Not found", 404, requestId);
  if (request.method !== "GET") return methodNotAllowed(requestId);
  const auth = await authorizeDeploy(env, requestId, actor, orgId, false);
  if (!auth.ok) return auth.response;
  const runner = deps.runner ?? runImageScanPagesInOrg;
  const now = (deps.now ?? (() => new Date()))();
  const query = new URL(request.url).searchParams;
  const state = fleetState(query);
  const searching = phpTrim(state.search) !== "";
  try {
    const data = await runner(env, orgId, async (tx): Promise<object | null> => {
      const decrypt = decryptor(tx, orgId, env);
      const resources = await listResources(tx, decrypt);
      const scanData = await loadScanData(tx, resources, now, searching);
      const places = new Map((await listImageScanEnvironments(tx)).map((e) => [e.uuid, e]));
      const entries: FleetEntry[] = loadTeamVulnerabilities(resources, scanData).map((e) => {
        const place = e.resource.environment === null ? undefined : places.get(e.resource.environment.uuid);
        return { ...e, place: { environmentName: place?.name ?? null, projectUuid: place?.project_uuid ?? null, projectName: place?.project_name ?? null }, link: vulnerabilitiesUrl(e.resource) };
      });
      if (route === "page") return renderFleet(entries, state, scanData, auth.canWrite ? await countServersNotScanning(tx) : 0);
      const f = query.get("format") ?? "";
      if (!["markdown", "csv", "json"].includes(f)) return null;
      const { rows } = fleetListing(entries, state, scanData);
      const base = (env.DEPLOY_CONSOLE_URL ?? "").replace(/\/+$/, "");
      const exported = fleetExportEntries(rows, searching, now).map((e) => ({ ...e, url: e.url === null ? null : `${base}${e.url}` }));
      // currentTeam()->name: the org as membership-worker shows it.
      const team = deps.teamName ? await deps.teamName() : ((await fetchOrganizationFacts(env.MEMBERSHIP_WORKER!, orgPublicId, actor.subjectId, actor.subjectType, requestId))?.name ?? "");
      if (f === "markdown") {
        const count = `${rows.length.toLocaleString("en-US")} ${rows.length === 1 ? "resource" : "resources"}`;
        return { content: fleetMarkdown(searching ? `Resources with ${phpTrim(state.search)} (${count})` : `Security of ${team} (${count})`, exported, searching) };
      }
      const filename = `${slug(team) || "team"}-security-${now.toISOString().slice(0, 10)}.${f}`;
      return f === "csv" ? { filename, contentType: "text/csv; charset=UTF-8", content: fleetCsv(exported, searching) } : { filename, contentType: "application/json", content: fleetJson({ team, search: searching ? phpTrim(state.search) : null }, exported, now) };
    });
    if (!data) return errorResponse("not_found", "Not found", 404, requestId);
    return successResponse(data, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}

