// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/TeamController.php (teams, team_by_id,
// members_by_id, current_team, current_team_members, update_current_team), app/Policies/TeamPolicy.php (update),
// app/Models/{Team,User}.php ($hidden, $casts), bootstrap/helpers/shared.php (customApiValidator) and laravel/framework's
// Validator (required_without, boolean, their messages) (Apache-2.0 / MIT), modified.
//
// Coolify's /api/v1 teams, answered for api-edge once it has resolved the token (x-api-v1-* headers):
//
//   GET /v1/internal/api-v1/teams                  the token's team, in a list
//   GET /v1/internal/api-v1/teams/{id}             the token's team, or "Team not found."
//   GET /v1/internal/api-v1/teams/{id}/members
//   GET /v1/internal/api-v1/team                   (and the deprecated /teams/current)
//   GET /v1/internal/api-v1/team/members           (and /teams/current/members)
//   PATCH /v1/internal/api-v1/team                 the team's two settings (DP-107)
//
// A Freeploy org is Coolify's team: its id is the org's public id ("org_…", Coolify's is an integer), and
// the columns Freeploy's orgs do not have answer Coolify's defaults for a new team. The members are the
// org's users, with the columns of Coolify's users table that identity keeps. The team's two settings PATCH
// /api/v1/team writes (is_build_server_fallback_enabled, scan_images_on_new_servers) are the org's (membership-worker's,
// migration 730): TeamPolicy::update is membership-worker's team update (organization.settings.update, owner and admin),
// asked before the body is validated, as Coolify authorizes first; the validation is the controller's, here.
import type { Env } from "../env.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createApiTokenStore, type ApiUserRow } from "@saas/db/identity";
import { API_V1_HEADERS, COOLIFY_API, coolifyJson, coolifyTeam, laravelDate, obj, serializeApiResponse, sqlDate, without, type CoolifyAnswer, type CoolifyTeamFacts, type PhpObject } from "@saas/contracts/coolify-api";
import { parseUserPublicId, userPublicId } from "../ids.js";

export const API_V1_TEAMS_RE = /^\/v1\/internal\/api-v1\/(teams|team)(?:\/([^/]+))?(?:\/(members))?$/;

export type OrgFacts = CoolifyTeamFacts;

export interface TeamsDeps {
  /** The org as membership-worker shows it to the user, or null. */
  org?: (orgId: string, userId: string, requestId: string) => Promise<OrgFacts | null>;
  /** The public ids of the org's members who are users, in membership-worker's order. */
  memberIds?: (orgId: string, userId: string, requestId: string) => Promise<string[] | null>;
  users?: (userUuids: string[]) => Promise<ApiUserRow[]>;
  /** DP-107: TeamPolicy::update for the user (membership-worker's team page: canUpdate). */
  canUpdate?: (orgId: string, userId: string, requestId: string) => Promise<boolean>;
  /** DP-107: the two settings saved; the org as membership-worker answers it after, or null. */
  updateSettings?: (orgId: string, userId: string, requestId: string, changes: TeamSettings) => Promise<OrgFacts | null>;
}

export interface TeamSettings {
  isBuildServerFallbackEnabled?: boolean;
  scanImagesOnNewServers?: boolean;
}

/** A service binding (structurally: the tests run without the Workers types). */
type Binding = { fetch(url: string, init?: RequestInit): Promise<Response> };

async function fetchJson(worker: Binding, url: string, userId: string, requestId: string, patch?: unknown): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> = { "x-request-id": requestId, "x-actor-subject-id": userId, "x-actor-subject-type": "user" };
  if (patch !== undefined) headers["content-type"] = "application/json";
  const res = await worker.fetch(url, { headers, ...(patch !== undefined && { method: "PATCH", body: JSON.stringify(patch) }) });
  if (!res.ok) return null;
  return (await res.json()) as Record<string, unknown>;
}

/** membership-worker's organization: the facts of a Coolify team (DP-107: its last change and two settings). */
function orgFacts(org: Partial<OrgFacts> | undefined): OrgFacts | null {
  if (!org || typeof org.id !== "string" || typeof org.name !== "string" || typeof org.createdAt !== "string") return null;
  return {
    id: org.id,
    name: org.name,
    createdAt: org.createdAt,
    ...(typeof org.updatedAt === "string" && { updatedAt: org.updatedAt }),
    ...(typeof org.isBuildServerFallbackEnabled === "boolean" && { isBuildServerFallbackEnabled: org.isBuildServerFallbackEnabled }),
    ...(typeof org.scanImagesOnNewServers === "boolean" && { scanImagesOnNewServers: org.scanImagesOnNewServers }),
  };
}

function defaultDeps(env: Env): Required<TeamsDeps> {
  return {
    async org(orgId, userId, requestId) {
      const body = await fetchJson(env.MEMBERSHIP_WORKER!, `http://membership-worker/v1/organizations/${encodeURIComponent(orgId)}`, userId, requestId);
      return orgFacts((body?.data as { organization?: Partial<OrgFacts> } | undefined)?.organization);
    },
    async canUpdate(orgId, userId, requestId) {
      const body = await fetchJson(env.MEMBERSHIP_WORKER!, `http://membership-worker/v1/organizations/${encodeURIComponent(orgId)}/team`, userId, requestId);
      return (body?.data as { canUpdate?: unknown } | undefined)?.canUpdate === true;
    },
    async updateSettings(orgId, userId, requestId, changes) {
      const body = await fetchJson(env.MEMBERSHIP_WORKER!, `http://membership-worker/v1/organizations/${encodeURIComponent(orgId)}/team/settings`, userId, requestId, changes);
      return orgFacts((body?.data as { organization?: Partial<OrgFacts> } | undefined)?.organization);
    },
    async memberIds(orgId, userId, requestId) {
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 50; page++) {
        const q: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
        const body = await fetchJson(env.MEMBERSHIP_WORKER!, `http://membership-worker/v1/organizations/${encodeURIComponent(orgId)}/members?limit=100${q}`, userId, requestId);
        if (!body) return null;
        const members = ((body.data as { members?: Array<{ subjectType: string; subjectId: string; status?: string }> } | undefined)?.members ?? []);
        for (const m of members) if (m.subjectType === "user" && (m.status ?? "active") === "active") ids.push(m.subjectId);
        cursor = ((body.meta as { cursor?: string | null } | undefined)?.cursor) ?? null;
        if (!cursor) break;
      }
      return ids;
    },
    async users(userUuids) {
      const db = createSqlExecutor(env.PLATFORM_DB!);
      try {
        return await createApiTokenStore(db).users(userUuids);
      } finally {
        await db.dispose();
      }
    },
  };
}

/** removeSensitiveData($team): the team's columns without custom_server_limit, serialized. */
export function teamPayload(org: OrgFacts): PhpObject {
  return serializeApiResponse(without(coolifyTeam(org), ["custom_server_limit"]));
}

/** A member: the user's columns without $hidden, pivot, email_change_code and its expiry. */
export function memberPayload(user: ApiUserRow, teamId: string): PhpObject {
  return serializeApiResponse(
    obj({
      id: userPublicId(user.id),
      name: user.name,
      email: user.email,
      // cast 'datetime'
      email_verified_at: laravelDate(user.emailVerifiedAt),
      created_at: laravelDate(user.createdAt),
      updated_at: laravelDate(user.updatedAt),
      // no cast: the column as the database gives it
      two_factor_confirmed_at: sqlDate(user.twoFactorConfirmedAt),
      force_password_reset: false,
      marketing_emails: true,
      pending_email: user.pendingEmail,
      avatar_path: null,
      avatar_storage_type: null,
      avatar_s3_storage_id: null,
      current_team_id: teamId,
    }),
  );
}

export async function handleApiV1Teams(request: Request, env: Env, requestId: string, deps?: TeamsDeps): Promise<Response> {
  const a = await answerApiV1Teams(request, env, requestId, deps);
  return new Response(a.body, { status: a.status, headers: a.headers });
}

/** The Validator's attribute name: snake case with spaces. */
const display = (field: string) => field.replace(/_/g, " ");
const SETTINGS = ["is_build_server_fallback_enabled", "scan_images_on_new_servers"] as const;

/** TrimStrings, then ConvertEmptyStringsToNull (the global middleware), at any depth. */
function cleanInput(v: unknown): unknown {
  if (typeof v === "string") {
    const t = v.replace(/^[\s\u0000\u000B]+|[\s\u0000\u000B]+$/g, "");
    return t === "" ? null : t;
  }
  if (Array.isArray(v)) return v.map(cleanInput);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, cleanInput(x)]));
  return v;
}

/** $request->all(): the JSON body's input, then the query string's keys it does not have (PHP's array union). */
async function requestAll(request: Request): Promise<Record<string, unknown>> {
  const all: Record<string, unknown> = {};
  if (/\/json|\+json/.test(request.headers.get("content-type") ?? "")) {
    try {
      const parsed = JSON.parse(await request.text()) as unknown;
      if (parsed && typeof parsed === "object") Object.assign(all, Array.isArray(parsed) ? Object.fromEntries(parsed.map((x, i) => [String(i), x])) : parsed);
    } catch {
      // $request->json() of content that is not JSON: no input.
    }
  }
  new URL(request.url).searchParams.forEach((v, k) => {
    if (!(k in all)) all[k] = v;
  });
  return cleanInput(all) as Record<string, unknown>;
}

/** validateRequired(): null, a blank string, an empty array. */
const missing = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

/**
 * update_current_team()'s customApiValidator(): each setting `required_without:<the other>` and `boolean` (a failed
 * required_without stops the attribute's rules), then every field not allowed. Null when valid.
 */
export function teamSettingsErrors(all: Record<string, unknown>): Array<[string, string[]]> | null {
  const errors: Array<[string, string[]]> = [];
  for (const field of SETTINGS) {
    const other = SETTINGS.find((f) => f !== field)!;
    if (missing(all[other]) && missing(all[field])) {
      errors.push([field, [`The ${display(field)} field is required when ${display(other)} is not present.`]]);
      continue;
    }
    if (field in all && ![true, false, 0, 1, "0", "1"].includes(all[field] as never)) errors.push([field, [`The ${display(field)} field must be true or false.`]]);
  }
  for (const k of Object.keys(all)) if (!(SETTINGS as readonly string[]).includes(k)) errors.push([k, ["This field is not allowed."]]);
  return errors.length ? errors : null;
}

/** PATCH /team: getTeamIdFromToken(), the user's team, TeamPolicy::update, the validator, then $team->update(validated()). */
async function updateCurrentTeam(request: Request, orgId: string, userId: string, requestId: string, d: Required<TeamsDeps>): Promise<CoolifyAnswer> {
  const org = await d.org(orgId, userId, requestId);
  if (!org) return COOLIFY_API.invalidToken();
  if (!(await d.canUpdate(orgId, userId, requestId))) return COOLIFY_API.unauthorized();
  const all = await requestAll(request);
  const errors = teamSettingsErrors(all);
  if (errors) return coolifyJson(obj({ message: "Validation failed.", errors: obj(errors) }), 422);
  const truthy = (v: unknown) => v === true || v === 1 || v === "1";
  const changes: TeamSettings = {};
  if ("is_build_server_fallback_enabled" in all) changes.isBuildServerFallbackEnabled = truthy(all.is_build_server_fallback_enabled);
  if ("scan_images_on_new_servers" in all) changes.scanImagesOnNewServers = truthy(all.scan_images_on_new_servers);
  const updated = await d.updateSettings(orgId, userId, requestId, changes);
  if (!updated) return coolifyJson(obj({ message: "Team not found." }), 404);
  return coolifyJson(teamPayload(updated));
}

async function answerApiV1Teams(request: Request, env: Env, requestId: string, deps?: TeamsDeps): Promise<CoolifyAnswer> {
  const m = new URL(request.url).pathname.match(API_V1_TEAMS_RE);
  if (m && request.method === "PATCH" && m[1] === "team" && m[2] === undefined) {
    const orgId = request.headers.get(API_V1_HEADERS.org);
    const userId = request.headers.get(API_V1_HEADERS.user);
    if (!orgId || !userId || !parseUserPublicId(userId)) return COOLIFY_API.invalidToken();
    return updateCurrentTeam(request, orgId, userId, requestId, { ...defaultDeps(env), ...deps });
  }
  if (!m || request.method !== "GET") return COOLIFY_API.notFound();
  const orgId = request.headers.get(API_V1_HEADERS.org);
  const userId = request.headers.get(API_V1_HEADERS.user);
  if (!orgId || !userId || !parseUserPublicId(userId)) return COOLIFY_API.invalidToken();
  const d = { ...defaultDeps(env), ...deps };
  const [, collection, id, members] = m;

  // /team, /team/members; /teams/current, /teams/current/members; /teams, /teams/{id}, /teams/{id}/members.
  let wantsMembers = members === "members";
  let byId: string | null = null;
  if (collection === "team") {
    if (id === "members" && !members) wantsMembers = true;
    else if (id !== undefined) return COOLIFY_API.notFound();
  } else if (id === "current") {
    // the deprecated aliases
  } else if (id !== undefined) {
    byId = id;
  } else if (members) {
    return COOLIFY_API.notFound();
  }
  const list = collection === "teams" && id === undefined;

  // getTeamIdFromToken(): the token's team must still be one of the user's teams.
  const org = await d.org(orgId, userId, requestId);
  if (!org) return COOLIFY_API.invalidToken();
  // team_by_id / members_by_id: (int) $request->id !== (int) $teamId
  if (byId !== null && byId !== org.id) return coolifyJson(obj({ message: "Team not found." }), 404);

  if (wantsMembers) {
    const ids = await d.memberIds(orgId, userId, requestId);
    if (!ids) return coolifyJson(obj({ message: "Team not found." }), 404);
    const uuids = ids.map((x) => parseUserPublicId(x)).filter((x): x is string => x !== null);
    const byUuid = new Map((await d.users(uuids)).map((u) => [u.id, u]));
    const rows = uuids.map((u) => byUuid.get(u)).filter((u): u is ApiUserRow => u !== undefined);
    return coolifyJson(rows.map((u) => memberPayload(u, org.id)));
  }
  const team = teamPayload(org);
  return coolifyJson(list ? [team] : team);
}
