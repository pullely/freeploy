// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/TeamController.php (teams, team_by_id,
// members_by_id, current_team, current_team_members) and app/Models/{Team,User}.php ($hidden, $casts)
// (Apache-2.0), modified.
//
// Coolify's /api/v1 teams, answered for api-edge once it has resolved the token (x-api-v1-* headers):
//
//   GET /v1/internal/api-v1/teams                  the token's team, in a list
//   GET /v1/internal/api-v1/teams/{id}             the token's team, or "Team not found."
//   GET /v1/internal/api-v1/teams/{id}/members
//   GET /v1/internal/api-v1/team                   (and the deprecated /teams/current)
//   GET /v1/internal/api-v1/team/members           (and /teams/current/members)
//
// A Freeploy org is Coolify's team: its id is the org's public id ("org_…", Coolify's is an integer), and
// the columns Freeploy's orgs do not have answer Coolify's defaults for a new team. The members are the
// org's users, with the columns of Coolify's users table that identity keeps.
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
}

/** A service binding (structurally: the tests run without the Workers types). */
type Binding = { fetch(url: string, init?: RequestInit): Promise<Response> };

async function fetchJson(worker: Binding, url: string, userId: string, requestId: string): Promise<Record<string, unknown> | null> {
  const res = await worker.fetch(url, { headers: { "x-request-id": requestId, "x-actor-subject-id": userId, "x-actor-subject-type": "user" } });
  if (!res.ok) return null;
  return (await res.json()) as Record<string, unknown>;
}

function defaultDeps(env: Env): Required<TeamsDeps> {
  return {
    async org(orgId, userId, requestId) {
      const body = await fetchJson(env.MEMBERSHIP_WORKER!, `http://membership-worker/v1/organizations/${encodeURIComponent(orgId)}`, userId, requestId);
      const org = (body?.data as { organization?: OrgFacts } | undefined)?.organization;
      return org ? { id: org.id, name: org.name, createdAt: org.createdAt } : null;
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

async function answerApiV1Teams(request: Request, env: Env, requestId: string, deps?: TeamsDeps): Promise<CoolifyAnswer> {
  const m = new URL(request.url).pathname.match(API_V1_TEAMS_RE);
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
