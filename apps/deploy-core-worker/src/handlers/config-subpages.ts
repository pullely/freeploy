// Derived from coollabsio/coolify@91b7e3e:routes/web.php (project.application.maintenance, project.application.swarm,
// project.service.domains, project.service.maintenance), app/Livewire/Project/Application/{Configuration,Swarm}.php,
// app/Livewire/Project/Service/{Configuration,Domains}.php, app/Livewire/Project/Shared/Maintenance.php and
// app/Policies/{ApplicationPolicy,ServicePolicy}.php (view, update) (Apache-2.0), modified.
//
// The configuration sub-pages of DP-102. Dispatched by handleApplications (applications.ts) and handleServices
// (services.ts):
//
//   GET   /applications/{uuid}/maintenance   Maintenance with the application as its resource
//   PATCH /applications/{uuid}/maintenance   by `action`: toggle (toggleMaintenance), save { maintenancePage } (submit),
//                                            reset (resetMaintenancePage); what writes the proxy's maintenance files on
//                                            a functional server answers 501 and stores nothing
//   GET   /applications/{uuid}/swarm         Swarm (the settings only when the application's server is a Swarm one)
//   PATCH /applications/{uuid}/swarm         Swarm::submit / instantSave { swarmReplicas, swarmPlacementConstraints,
//                                            isSwarmOnlyWorkerNodes }; 404 when the server is not a Swarm one (the
//                                            component is not rendered then)
//   GET   /services/{uuid}/maintenance       Maintenance with the service as its resource
//   PATCH /services/{uuid}/maintenance       as an application's
//   GET   /services/{uuid}/domains           Domains
//   PATCH /services/{uuid}/domains           one of Domains' actions, named by `action`:
//                                              add                 addDomain { serviceApplicationUuid, newDomainParts | newDomain,
//                                                                  forceSaveDomains, forceRemovePort }
//                                              update              updateDomain { serviceApplicationUuid, url, editingDomainParts |
//                                                                  editingDomain, editingIndexing, editingRedirect, generatedHost,
//                                                                  forceSaveDomains, forceRemovePort }
//                                              remove              removeDomainByKey { serviceApplicationUuid, url }
//                                              generate            generateDomain { serviceApplicationUuid }: { domain, parts }, nothing stored
//                                              regenerateHostname  regenerateEditingDomain: { host }, nothing stored
//                                              redirect            setServiceRedirect { serviceApplicationUuid, redirect, forceSaveDomains }
//                                              forceHttps          updateForceHttps { serviceApplicationUuid, enabled }
//                                              permanentRedirect   updatePermanentRedirect { serviceApplicationUuid, enabled }
//                                              checkDns            checkDomainDns { serviceApplicationUuid, url } / checkAllDns
//
// Coolify's policies: view to read, update to write. Here: deploy.resource.read and deploy.resource.write; a denial
// answers 404 and runs nothing.
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  findApplicationByUuid,
  findApplicationSubpage,
  findServiceSubpage,
  listApplicationMaintenanceServers,
  listServiceMaintenanceServers,
  listServiceApplicationDnsStatuses,
  updateApplicationSwarm,
  updateResourceMaintenance,
  updateServiceApplicationDnsStatuses,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse, validationError } from "../http.js";
import { authorizeDeploy, readJson } from "./cloud-tokens.js";
import { applicationShow } from "../applications/service.js";
import { MAINTENANCE_MESSAGES, maintenanceState, maintenanceSyncRuns, SWARM_MESSAGES, swarmSettings, validateMaintenancePage, validateSwarm } from "../applications/config-subpages.js";
import { loadServiceInfo } from "../services/configuration.js";
import {
  addServiceDomain,
  checkServiceDomainsDns,
  generateServiceDomain,
  regenerateServiceHostname,
  removeServiceDomain,
  ServiceDomainsError,
  setServiceDomainRedirect,
  setServiceDomainSwitch,
  showServiceDomains,
  updateServiceDomain,
  type ServiceDomainsContext,
} from "../services/domains-page.js";
import { serviceResourcesContext } from "./service-configuration.js";

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

export type ConfigSubpageKind = "application" | "service";
const PAGES: Record<ConfigSubpageKind, readonly string[]> = { application: ["maintenance", "swarm"], service: ["maintenance", "domains"] };

/** Whether handleConfigSubpages serves the route. segments: what follows /applications or /services. */
export const isConfigSubpageRoute = (kind: ConfigSubpageKind, segments: readonly string[]): boolean => segments.length === 2 && PAGES[kind].includes(segments[1]!);

/** Runs fn in one transaction confined to the org (withOrg); replaceable for tests. */
export type ConfigSubpagesRunner = <T>(env: Env, orgId: string, fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;

export const runConfigSubpagesInOrg: ConfigSubpagesRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, fn);
  } finally {
    await db.dispose();
  }
};

/** A refusal of one action: Coolify's toast (or field messages) with its status. */
class PageError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fields: Record<string, string[]> | null = null,
  ) {
    super(message);
  }
}

type Body = Record<string, unknown>;

/** The resource for the frame (Configuration::mount()), or null when it is not the org's. */
async function frameOf(tx: SqlExecutor, env: Env, orgId: string, kind: ConfigSubpageKind, uuid: string, canWrite: boolean): Promise<Record<string, unknown> | null> {
  if (kind === "application") {
    const row = await findApplicationByUuid(tx, uuid);
    return row ? { application: applicationShow(row, canWrite), canUpdate: canWrite, canDeploy: canWrite } : null;
  }
  const l = await loadServiceInfo(serviceResourcesContext(tx, orgId, env.DEPLOY_ENCRYPTION_KEY).configuration, uuid);
  return l ? { service: l.info, canUpdate: canWrite, canManage: canWrite, canDelete: canWrite } : null;
}

// ---------------------------------------------------------------- Maintenance

async function maintenanceOf(tx: SqlExecutor, kind: ConfigSubpageKind, uuid: string) {
  const row = kind === "application" ? await findApplicationSubpage(tx, uuid) : await findServiceSubpage(tx, uuid);
  if (!row) return null;
  const servers = kind === "application" ? await listApplicationMaintenanceServers(tx, row.id) : await listServiceMaintenanceServers(tx, row.id);
  return { row, servers };
}

/** toggleMaintenance(), submit() and resetMaintenancePage(). */
async function saveMaintenance(tx: SqlExecutor, kind: ConfigSubpageKind, uuid: string, body: Body): Promise<{ message: string } | null> {
  const m = await maintenanceOf(tx, kind, uuid);
  if (!m) return null;
  const { row, servers } = m;
  // syncMaintenancePage() on a functional server writes the proxy's files over SSH.
  const unavailable = () => new PageError(MAINTENANCE_MESSAGES.unavailable, 501);
  switch (body.action) {
    case "toggle": {
      if (maintenanceSyncRuns(servers)) throw unavailable();
      const enabled = !row.is_maintenance_enabled;
      await updateResourceMaintenance(tx, kind, row.id, { is_maintenance_enabled: enabled });
      return { message: enabled ? MAINTENANCE_MESSAGES.enabled : MAINTENANCE_MESSAGES.disabled };
    }
    case "save": {
      const page = validateMaintenancePage(body.maintenancePage);
      if (!page.ok) throw new PageError(Object.values(page.errors).flat()[0]!, 422, page.errors);
      if (row.is_maintenance_enabled && maintenanceSyncRuns(servers)) throw unavailable();
      await updateResourceMaintenance(tx, kind, row.id, { maintenance_page: page.page });
      return { message: MAINTENANCE_MESSAGES.saved };
    }
    case "reset": {
      if (row.is_maintenance_enabled && maintenanceSyncRuns(servers)) throw unavailable();
      await updateResourceMaintenance(tx, kind, row.id, { maintenance_page: null });
      return { message: MAINTENANCE_MESSAGES.reset };
    }
    default:
      throw new PageError("The selected action is invalid.", 422, { action: ["The selected action is invalid."] });
  }
}

// ---------------------------------------------------------------- Swarm

/** configuration.blade.php: $application->destination?->server?->isSwarm(). */
async function swarmOf(tx: SqlExecutor, uuid: string) {
  const frame = await findApplicationByUuid(tx, uuid);
  const row = frame ? await findApplicationSubpage(tx, uuid) : null;
  if (!frame || !row) return null;
  return { row, isSwarm: applicationShow(frame, false).server?.isSwarm === true };
}

// ---------------------------------------------------------------- Domains

function domainsContext(tx: SqlExecutor, env: Env, orgId: string): ServiceDomainsContext {
  return {
    configuration: serviceResourcesContext(tx, orgId, env.DEPLOY_ENCRYPTION_KEY).configuration,
    dnsStatuses: (serviceId) => listServiceApplicationDnsStatuses(tx, serviceId),
    updateDnsStatuses: (serviceId, id, statuses) => updateServiceApplicationDnsStatuses(tx, serviceId, id, statuses),
    server: async (serviceId) => (await listServiceMaintenanceServers(tx, serviceId))[0] ?? null,
  };
}

function domainsAction(ctx: ServiceDomainsContext, uuid: string, body: Body): Promise<object | null> | undefined {
  switch (body.action) {
    case "add":
      return addServiceDomain(ctx, uuid, body);
    case "update":
      return updateServiceDomain(ctx, uuid, body);
    case "remove":
      return removeServiceDomain(ctx, uuid, body);
    case "generate":
      return generateServiceDomain(ctx, uuid, body);
    case "regenerateHostname":
      return regenerateServiceHostname(ctx, uuid);
    case "redirect":
      return setServiceDomainRedirect(ctx, uuid, body);
    case "forceHttps":
      return setServiceDomainSwitch(ctx, uuid, body, "forceHttps");
    case "permanentRedirect":
      return setServiceDomainSwitch(ctx, uuid, body, "permanentRedirect");
    case "checkDns":
      return checkServiceDomainsDns(ctx, uuid, body);
    default:
      return undefined;
  }
}

/** segments: what follows /applications or /services — [uuid, page]. `runner` is replaceable for tests. */
export async function handleConfigSubpages(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  kind: ConfigSubpageKind,
  segments: string[],
  request: Request,
  runner: ConfigSubpagesRunner = runConfigSubpagesInOrg,
): Promise<Response> {
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  const [uuid, page] = segments;
  if (!uuid || !UUID_RE.test(uuid) || !isConfigSubpageRoute(kind, segments)) return notFound();
  const read = request.method === "GET";
  if (!read && request.method !== "PATCH") return methodNotAllowed(requestId);

  // $this->authorize('view' | 'update', $resource)
  const auth = await authorizeDeploy(env, requestId, actor, orgId, !read);
  if (!auth.ok) return auth.response;
  const canWrite = auth.canWrite;
  const body = read ? {} : await readJson(request);
  if (!read && page === "domains" && !["add", "update", "remove", "generate", "regenerateHostname", "redirect", "forceHttps", "permanentRedirect", "checkDns"].includes(String(body.action))) {
    return validationError(requestId, { action: ["The selected action is invalid."] });
  }

  try {
    const data = await runner(env, orgId, async (tx): Promise<object | null> => {
      const frame = await frameOf(tx, env, orgId, kind, uuid, canWrite);
      if (!frame) return null;
      if (page === "maintenance") {
        if (read) {
          const m = await maintenanceOf(tx, kind, uuid);
          return m ? { ...frame, maintenance: maintenanceState(m.row, m.servers) } : null;
        }
        const saved = await saveMaintenance(tx, kind, uuid, body);
        if (!saved) return null;
        const m = (await maintenanceOf(tx, kind, uuid))!;
        return { ...saved, maintenance: maintenanceState(m.row, m.servers) };
      }
      if (page === "swarm") {
        const s = await swarmOf(tx, uuid);
        if (!s) return null;
        if (read) return { ...frame, isSwarm: s.isSwarm, swarm: s.isSwarm ? swarmSettings(s.row) : null };
        if (!s.isSwarm) return null;
        const valid = validateSwarm(body);
        if (!valid.ok) throw new PageError(Object.values(valid.errors).flat()[0]!, 422, valid.errors);
        await updateApplicationSwarm(tx, s.row.id, valid);
        return { message: SWARM_MESSAGES.updated, swarm: swarmSettings((await findApplicationSubpage(tx, uuid))!) };
      }
      // Domains
      const ctx = domainsContext(tx, env, orgId);
      if (read) {
        const shown = await showServiceDomains(ctx, uuid);
        return shown ? { ...frame, domains: shown.domains } : null;
      }
      return (await domainsAction(ctx, uuid, body)) ?? null;
    });
    if (!data) return notFound();
    return successResponse(data, requestId);
  } catch (e) {
    if (e instanceof PageError || e instanceof ServiceDomainsError) {
      const code = e.status === 501 ? "unsupported" : e.status === 409 ? "conflict" : e.status === 404 ? "not_found" : "validation_failed";
      const details = { ...(e.fields ? { fields: e.fields } : {}), ...(e instanceof ServiceDomainsError ? (e.details ?? {}) : {}) };
      return errorResponse(code, e.message, e.status, requestId, Object.keys(details).length ? details : undefined);
    }
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}
