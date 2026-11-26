// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Settings/{Index,Advanced}.php, app/Livewire/Admin/Index.php,
// app/Livewire/Team/AdminView.php and app/Models/InstanceSettings.php (Apache-2.0), modified.
//
// The platform operator's routes (freeploy-coolify-parity DP12): Coolify's instance-level pages, which in a
// hosted, multi-tenant Freeploy belong to the platform operator and to no customer org. api-edge forwards
// /v1/platform/* here with the signed-in actor.
//
//   GET   /v1/platform/operator     whether the actor is a platform operator (the sidebar's Settings submenu)
//   GET   /v1/platform/settings     Settings\Index and Settings\Advanced: the ported settings
//   PATCH /v1/platform/settings     their submit() / instantSave(): { section: general|advanced, action, values }
//   GET   /v1/platform/admin        Admin\Index: the subscriber counts and, with ?search=, the user lookup
//   GET   /v1/platform/admin/users  Team\AdminView: the instance's users (?search, teamFilter, orgId, sort, perPage, page)
//   GET|PATCH /v1/platform/settings/{updates,backup,email,oauth[/{provider}]}  DP-101's pages
//                                   (handlers/platform-settings-more.ts), behind the same gate
//
// Every route first asks policy-worker for its platform action (platform.settings.read|update,
// platform.admin.read), which only the deployment's PLATFORM_OPERATORS pass — never an org role, of any
// org, and never an API key. Anything else answers the platform's 404, as every denial does: Coolify
// redirects a non-admin to the dashboard (Settings) or aborts 403 (Admin); a customer must not learn the
// pages exist. The settings are row 0 of deploy.instance_settings, read and written in asPlatformAdmin();
// the users and teams are read from membership-worker over the existing binding.
//
// Not ported (IMPLEMENTATION-STATUS.md, Notes on DP12): every setting that is the edge's or the
// deployment's configuration, or that a hosted service does not have; "Switch user" (impersonation) and
// deleting a user; the audit log line Coolify writes on a save ('ui.instance.settings.updated').
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { asPlatformAdmin, readPlatformSettings, updatePlatformSettings, type PlatformSettingsChanges, type PlatformSettingsRow } from "@saas/db/deploy";
import { authorizeViaPolicy } from "../policy-client.js";
import { deniedResponse, errorResponse, methodNotAllowed, notFound, successResponse, validationError } from "../http.js";
import { readJson } from "./cloud-tokens.js";
import { handlePlatformMore, isPlatformMorePage, runPlatformMoreAsAdmin, type PlatformMoreRunner } from "./platform-settings-more.js";

/** The paths api-edge forwards: /v1/platform and below. */
export const PLATFORM_RE = /^\/v1\/platform(\/[^?]*)?$/;

/** What every platform action names to policy-worker (packages/policy-engine PLATFORM_RESOURCE). */
const RESOURCE = { kind: "platform", orgId: "platform" };

export interface PlatformSettingsStore {
  read(): Promise<PlatformSettingsRow>;
  update(changes: PlatformSettingsChanges): Promise<PlatformSettingsRow>;
}

/** Runs fn with the platform settings, in one transaction as the platform operator. */
export type PlatformRunner = <T>(env: Env, fn: (store: PlatformSettingsStore) => Promise<T>) => Promise<T>;

export const runAsPlatformAdmin: PlatformRunner = async (env, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await asPlatformAdmin(db, (tx) => fn({ read: () => readPlatformSettings(tx), update: (c) => updatePlatformSettings(tx, c) }));
  } finally {
    await db.dispose();
  }
};

/** The settings each page shows and saves (Settings\Index, Settings\Advanced), as the pages name them. */
export const SECTIONS = {
  general: ["instance_name"],
  advanced: ["is_registration_enabled", "disable_two_step_confirmation", "is_passkey_enabled", "is_dns_validation_enabled", "is_sponsorship_popup_enabled"],
} as const satisfies Record<string, readonly (keyof PlatformSettingsChanges)[]>;
export type PlatformSection = keyof typeof SECTIONS;

/** Laravel's validation attribute: the field name with underscores as spaces. */
const attribute = (field: string) => field.replace(/_/g, " ");

/** Laravel's `boolean` rule: true, false, 1, 0, "1" and "0". */
function asBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return undefined;
}

/**
 * The components' #[Validate] rules, with Laravel's messages:
 *   Index:    instance_name  nullable|string|max:255
 *   Advanced: the five flags boolean
 */
export function validatePlatformSettings(section: PlatformSection, values: Record<string, unknown>): { changes: PlatformSettingsChanges; errors: Record<string, string[]> } {
  const changes: PlatformSettingsChanges = {};
  const errors: Record<string, string[]> = {};
  for (const field of SECTIONS[section]) {
    if (!(field in values)) continue;
    const value = values[field];
    if (field === "instance_name") {
      if (value === null || value === undefined || value === "") {
        changes.instance_name = null;
      } else if (typeof value !== "string") {
        errors[field] = [`The ${attribute(field)} field must be a string.`];
      } else if ([...value].length > 255) {
        errors[field] = [`The ${attribute(field)} field must not be greater than 255 characters.`];
      } else {
        changes.instance_name = value;
      }
      continue;
    }
    const b = asBoolean(value);
    if (b === undefined) errors[field] = [`The ${attribute(field)} field must be true or false.`];
    else changes[field] = b;
  }
  return { changes, errors };
}

/** The settings as the pages read them. */
function view(row: PlatformSettingsRow) {
  return {
    instance_name: row.instance_name,
    is_registration_enabled: row.is_registration_enabled,
    disable_two_step_confirmation: row.disable_two_step_confirmation,
    is_passkey_enabled: row.is_passkey_enabled,
    is_dns_validation_enabled: row.is_dns_validation_enabled,
    is_sponsorship_popup_enabled: row.is_sponsorship_popup_enabled,
  };
}

async function allowed(env: Env, requestId: string, actor: ActorContext, action: string): Promise<Response | null> {
  if (!env.POLICY_WORKER) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  const decision = await authorizeViaPolicy(env.POLICY_WORKER, actor.subjectId, actor.subjectType, action, RESOURCE, [], requestId);
  return decision.allow ? null : deniedResponse(env.ENVIRONMENT, requestId, decision.reason ?? "denied");
}

interface MembershipUsers {
  users: Array<{ id: string; name: string | null; email: string; hasActiveSubscription: boolean }>;
  total: number;
  page: number;
  perPage: number;
}

async function membership<T>(env: Env, requestId: string, path: string, body?: unknown): Promise<T | null> {
  if (!env.MEMBERSHIP_WORKER) return null;
  try {
    const res = await env.MEMBERSHIP_WORKER.fetch(`http://membership-worker${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: T };
    return json.data ?? null;
  } catch {
    return null;
  }
}

export async function handlePlatform(
  env: Env,
  requestId: string,
  actor: ActorContext | null,
  path: string,
  request: Request,
  runner: PlatformRunner = runAsPlatformAdmin,
  moreRunner: PlatformMoreRunner = runPlatformMoreAsAdmin,
): Promise<Response> {
  // No actor (api-edge always sends one): the same 404 as a denial.
  if (!actor) return deniedResponse(env.ENVIRONMENT, requestId, "no_actor");
  const segments = path.split("/").filter(Boolean);
  const url = new URL(request.url);
  const method = request.method;
  const page = segments.join("/");

  // DP-101: Updates, Backup, Email and Authentication.
  if (isPlatformMorePage(page)) return handlePlatformMore(env, requestId, page, request, (a) => allowed(env, requestId, actor, a), moreRunner);

  // A path that is no platform page answers the 404 a denial answers, whoever asks.
  if (!["operator", "settings", "admin", "admin/users"].includes(page)) {
    const denied = await allowed(env, requestId, actor, "platform.settings.read");
    return denied ?? notFound(requestId, url.pathname);
  }

  if (page === "operator") {
    if (method !== "GET") return methodNotAllowed(requestId);
    const denied = await allowed(env, requestId, actor, "platform.settings.read");
    if (denied) return denied;
    return successResponse({ operator: true, settingsPages: ["/settings", "/settings/advanced", "/settings/updates", "/settings/oauth", "/settings/email", "/settings/backup"], adminPages: ["/admin", "/team/admin"] }, requestId);
  }

  if (page === "settings") {
    if (method === "GET") {
      const denied = await allowed(env, requestId, actor, "platform.settings.read");
      if (denied) return denied;
      try {
        const [row, canUpdate] = await Promise.all([runner(env, (s) => s.read()), allowed(env, requestId, actor, "platform.settings.update").then((d) => d === null)]);
        return successResponse({ settings: view(row), canUpdate }, requestId);
      } catch {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }
    }
    if (method !== "PATCH") return methodNotAllowed(requestId);
    // $this->authorize('update', $this->settings) comes first, before validate().
    const denied = await allowed(env, requestId, actor, "platform.settings.update");
    if (denied) return denied;
    const body = await readJson(request);
    const section = body.section === "general" || body.section === "advanced" ? body.section : null;
    if (!section) return validationError(requestId, { section: ["The section field must be general or advanced."] });
    const values = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? (body.values as Record<string, unknown>) : {};
    const { changes, errors } = validatePlatformSettings(section, values);
    if (Object.keys(errors).length) return validationError(requestId, errors);
    try {
      const row = await runner(env, (s) => s.update(changes));
      // Index::submit() says 'Instance settings updated successfully!'; every instantSave() 'Settings updated!'.
      const message = section === "general" && body.action === "submit" ? "Instance settings updated successfully!" : "Settings updated!";
      return successResponse({ settings: view(row), message }, requestId);
    } catch {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
  }

  if (method !== "GET") return methodNotAllowed(requestId);
  const denied = await allowed(env, requestId, actor, "platform.admin.read");
  if (denied) return denied;
  const search = (url.searchParams.get("search") ?? "").trim();

  if (page === "admin") {
    // Admin\Index: getSubscribers(), and submitSearch() when there is a search.
    const [subscribers, found] = await Promise.all([
      membership<{ active: number; inactive: number }>(env, requestId, "/v1/internal/membership/platform/subscribers"),
      search === "" ? Promise.resolve(null) : membership<MembershipUsers>(env, requestId, "/v1/internal/membership/platform/users", { search, sort: "name_asc", perPage: 100, page: 1 }),
    ]);
    if (!subscribers || (search !== "" && !found)) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    return successResponse({ activeSubscribers: subscribers.active, inactiveSubscribers: subscribers.inactive, search, users: found?.users ?? [], total: found?.total ?? 0 }, requestId);
  }

  // Team\AdminView::render(): every user but the operator, searched, filtered by the current team, sorted, paged.
  const users = await membership<MembershipUsers>(env, requestId, "/v1/internal/membership/platform/users", {
    search,
    teamFilter: url.searchParams.get("teamFilter") ?? "all",
    orgId: url.searchParams.get("orgId"),
    sort: url.searchParams.get("sort") ?? "name_asc",
    perPage: url.searchParams.get("perPage") ?? 10,
    page: url.searchParams.get("page") ?? 1,
    excludeUserId: actor.subjectId,
  });
  if (!users) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  return successResponse(users, requestId);
}
