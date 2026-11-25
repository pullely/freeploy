// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/{Configuration,Domains,Advanced}.php,
// app/Livewire/Project/Shared/{HealthChecks,ResourceLimits}.php and app/Policies/ApplicationPolicy.php
// (view, update) (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/applications/{uuid}/… — the configuration
// pages of an application that only read and write deploy.applications and
// deploy.application_settings. Dispatched by handleApplications
// (applications.ts):
//
//   GET   /domains           Domains: the domains as rows, the redirect settings, the DNS target
//   PATCH /domains           one of Domains' actions, named by `action`:
//                              add                 addDomain { newDomainParts | newDomain, forceSaveDomains, forceUseUnknownPort }
//                              update              updateDomain { url, editingDomainParts | editingDomain, editingIndexing,
//                                                  editingRedirect, generatedHost, forceSaveDomains, forceUseUnknownPort }
//                              remove              removeDomain { url }
//                              generate            generateDomain
//                              regenerateHostname  regenerateEditingDomain: { host }, nothing stored
//                              redirect            setRedirect { redirect, forceSaveDomains }
//                              forceHttps          updateForceHttps { isForceHttpsEnabled }
//                              permanentRedirect   updatePermanentRedirect { isPermanentRedirectEnabled }
//                              checkDns            checkDomainDns { url } / checkAllDns
//   GET   /advanced          Advanced
//   PATCH /advanced          Advanced::submit (the GPU form), or instantSave with { instantSave: true }, or one of the
//                            fields that save themselves, named by `save`: customName, customNamePrefix,
//                            certificateResolver, stopGracePeriod, rollingUpdateDrainSeconds, maxRestartCount; and
//                            refreshGpus — needs SSH, not available yet (501)
//   GET   /healthcheck       HealthChecks (the command and the response text only for writers)
//   PATCH /healthcheck       HealthChecks::submit / instantSave, or toggleHealthcheck with { toggle: true }
//   GET   /resource-limits   ResourceLimits
//   PATCH /resource-limits   ResourceLimits::submit
//
// Coolify's policy: view to read, update to write. Here: deploy.resource.read
// and deploy.resource.write; a denial answers 404 (never leaks).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  findApplicationByUuid,
  findApplicationConfiguration,
  updateApplicationConfiguration,
  updateApplicationSettings,
  listServerApplicationContainerNames,
  listApplicationDomains,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse, validationError } from "../http.js";
import { authorizeDeploy, readJson } from "./cloud-tokens.js";
import {
  refreshGpus,
  saveAdvanced,
  saveCertificateResolver,
  saveCustomName,
  saveCustomNamePrefix,
  saveHealthCheck,
  saveMaxRestartCount,
  saveResourceLimits,
  saveRollingUpdateDrainSeconds,
  saveStopGracePeriod,
  SettingsError,
  SettingsFieldErrors,
  showAdvanced,
  showHealthCheck,
  showResourceLimits,
  toggleHealthCheck,
  type ApplicationSettingsContext,
  type ApplicationSettingsStore,
} from "../applications/settings.js";
import { addDomain, checkDomainsDns, generateDomain, regenerateHostname, removeDomain, setRedirect, setRedirectSwitch, showDomains, updateDomain } from "../applications/domains-page.js";

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

export const APPLICATION_SETTINGS_SECTIONS = ["domains", "advanced", "healthcheck", "resource-limits"] as const;
export type ApplicationSettingsSection = (typeof APPLICATION_SETTINGS_SECTIONS)[number];

export const isApplicationSettingsSection = (value: string | undefined): value is ApplicationSettingsSection => (APPLICATION_SETTINGS_SECTIONS as readonly string[]).includes(value ?? "");

/** Runs fn with one org's application settings store, in one transaction confined to that org. */
export type ApplicationSettingsRunner = <T>(env: Env, orgId: string, fn: (ctx: ApplicationSettingsContext) => Promise<T>) => Promise<T>;

function sqlStore(tx: SqlExecutor): ApplicationSettingsStore {
  return {
    findByUuid: (uuid) => findApplicationByUuid(tx, uuid),
    configuration: (uuid) => findApplicationConfiguration(tx, uuid),
    update: (id, changes) => updateApplicationConfiguration(tx, id, changes),
    updateSettings: (applicationId, changes) => updateApplicationSettings(tx, applicationId, changes),
    containerNames: (serverId) => listServerApplicationContainerNames(tx, serverId),
    domains: () => listApplicationDomains(tx),
  };
}

export const runApplicationSettingsInOrg: ApplicationSettingsRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => fn({ store: sqlStore(tx) }));
  } finally {
    await db.dispose();
  }
};

function failure(e: unknown, requestId: string): Response {
  if (e instanceof SettingsFieldErrors) return validationError(requestId, e.fields);
  if (e instanceof SettingsError) {
    const code = e.status === 501 ? "unsupported" : e.status === 409 ? "conflict" : e.status === 404 ? "not_found" : "validation_failed";
    return errorResponse(code, e.message, e.status, requestId, e.details ?? undefined);
  }
  return errorResponse("internal_error", "Service unavailable", 503, requestId);
}

type Body = Record<string, unknown>;
type Run = <T>(fn: (ctx: ApplicationSettingsContext) => Promise<T>) => Promise<T>;

/** PATCH /domains: the action's result, or undefined for an action Domains does not have. */
function domainsAction(run: Run, uuid: string, body: Body): Promise<object | null> | undefined {
  switch (body.action) {
    case "add":
      return run((c) => addDomain(c, uuid, body));
    case "update":
      return run((c) => updateDomain(c, uuid, body));
    case "remove":
      return run((c) => removeDomain(c, uuid, body));
    case "generate":
      return run((c) => generateDomain(c, uuid, body));
    case "regenerateHostname":
      return run((c) => regenerateHostname(c, uuid));
    case "redirect":
      return run((c) => setRedirect(c, uuid, body));
    case "forceHttps":
      return run((c) => setRedirectSwitch(c, uuid, body, "isForceHttpsEnabled"));
    case "permanentRedirect":
      return run((c) => setRedirectSwitch(c, uuid, body, "isPermanentRedirectEnabled"));
    case "checkDns":
      return run((c) => checkDomainsDns(c, uuid, body));
    default:
      return undefined;
  }
}

/** PATCH /advanced: the save's result, or undefined for a `save` Advanced does not have. */
function advancedSave(run: Run, uuid: string, body: Body): Promise<(object & { rejected?: string }) | null> | undefined {
  switch (body.save) {
    case undefined:
    case null:
      return run((c) => saveAdvanced(c, uuid, body, body.instantSave === true));
    case "customName":
      return run((c) => saveCustomName(c, uuid, body));
    case "customNamePrefix":
      return run((c) => saveCustomNamePrefix(c, uuid, body));
    case "certificateResolver":
      return run((c) => saveCertificateResolver(c, uuid, body));
    case "stopGracePeriod":
      return run((c) => saveStopGracePeriod(c, uuid, body));
    case "rollingUpdateDrainSeconds":
      return run((c) => saveRollingUpdateDrainSeconds(c, uuid, body));
    case "maxRestartCount":
      return run((c) => saveMaxRestartCount(c, uuid, body));
    case "refreshGpus":
      return run((c) => refreshGpus(c, uuid));
    default:
      return undefined;
  }
}

/**
 * One configuration page of an application: GET reads it, PATCH saves it.
 * `runner` is replaceable for tests.
 */
export async function handleApplicationSettings(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  uuid: string,
  section: ApplicationSettingsSection,
  request: Request,
  runner: ApplicationSettingsRunner = runApplicationSettingsInOrg,
): Promise<Response> {
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  if (!UUID_RE.test(uuid)) return notFound();
  const read = request.method === "GET";
  if (!read && request.method !== "PATCH") return methodNotAllowed(requestId);

  // $this->authorize('view' | 'update', $application)
  const auth = await authorizeDeploy(env, requestId, actor, orgId, !read);
  if (!auth.ok) return auth.response;
  const canWrite = auth.canWrite;
  const run: Run = (fn) => runner(env, orgId, fn);
  /** The views' @can('update' | 'deploy', $application). */
  const page = (data: object | null) => (data ? successResponse({ ...data, canUpdate: canWrite, canDeploy: canWrite }, requestId) : notFound());
  const saved = (data: object | null) => (data ? successResponse(data, requestId) : notFound());

  try {
    if (read) {
      switch (section) {
        case "domains":
          return page(await run((c) => showDomains(c, uuid, canWrite)));
        case "advanced":
          return page(await run((c) => showAdvanced(c, uuid, canWrite)));
        case "healthcheck":
          return page(await run((c) => showHealthCheck(c, uuid, canWrite)));
        case "resource-limits":
          return page(await run((c) => showResourceLimits(c, uuid, canWrite)));
      }
    }
    const body = await readJson(request);
    switch (section) {
      case "domains": {
        const result = domainsAction(run, uuid, body);
        if (!result) return validationError(requestId, { action: ["The selected action is invalid."] });
        return saved(await result);
      }
      case "advanced": {
        const result = advancedSave(run, uuid, body);
        if (!result) return validationError(requestId, { save: ["The selected save is invalid."] });
        const data = await result;
        // instantSave(): the log drain switch was saved off with the rest, and Coolify's error is the answer.
        if (data?.rejected) return validationError(requestId, { isLogDrainEnabled: [data.rejected] });
        return saved(data);
      }
      case "healthcheck":
        return saved(await run((c) => (body.toggle === true ? toggleHealthCheck(c, uuid) : saveHealthCheck(c, uuid, body))));
      case "resource-limits":
        return saved(await run((c) => saveResourceLimits(c, uuid, body)));
    }
  } catch (e) {
    return failure(e, requestId);
  }
}
