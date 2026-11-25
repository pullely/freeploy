// The team's audit log (DP-75): events-worker's handlers/team-audit-log.ts and src/team-audit-log.ts.
// The Freeploy events that Coolify records too are held to Coolify's own rows: fixtures/audit-log/
// goldens.json is what coollabsio/coolify@91b7e3e records for them (its emit.php runs the team pages'
// auditLog() calls and the Auditable trait on Team, see its README.md), and Str::headline's answers.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TeamAuditRow } from "@saas/db/events";
import type { Env } from "@events-worker/env";
import { route } from "@events-worker/router";
import { handleTeamAuditLog, type TeamAuditLogDeps } from "@events-worker/handlers/team-audit-log";
import { headline, parseTeamAuditQuery, teamAuditPage, toTeamAuditEvent, SOURCE_OPTIONS, TEAM_EVENTS } from "@events-worker/team-audit-log";

interface GoldenRow {
  event: string;
  source: string;
  action: string;
  actor_type: string;
  actor_name: string;
  actor_email: string;
  resource_type: string;
  resource_name: string | null;
  description: string;
}
const goldens = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../fixtures/audit-log/goldens.json"), "utf8")) as {
  coolify: string;
  events: Record<string, GoldenRow>;
  headline: Record<string, string>;
};

const ORG = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const NOW = new Date("2026-01-01T00:00:00Z");
let seq = 0;

function row(eventType: string, over: Partial<TeamAuditRow> = {}): TeamAuditRow {
  seq += 1;
  return {
    id: `a${String(seq).padStart(4, "0")}`,
    eventType,
    actorType: "user",
    actorId: "usr_owner",
    actorName: "Owner",
    actorEmail: "owner@example.com",
    subjectKind: "organization",
    subjectId: ORG,
    subjectName: null,
    description: `Freeploy: ${eventType}`,
    occurredAt: new Date(NOW.getTime() - seq * 60_000),
    payload: {},
    memberName: null,
    memberEmail: null,
    ...over,
  };
}

/** The Freeploy row each golden corresponds to (what membership-worker records for the same action). */
const FREEPLOY_OF: Record<string, TeamAuditRow> = {
  "team.created": row("organization.created", { payload: { name: "Acme" } }),
  "team.updated": row("organization.updated", { payload: { name: "Acme Inc", description: null } }),
  "team.deleted": row("organization.deleted", { payload: { name: "Acme Inc", slug: "acme" } }),
  "team_member.role_updated": row("membership.updated", { subjectKind: "member", memberName: "Member", memberEmail: "member@example.com", payload: { memberId: "mem_1", role: "admin" } }),
  "team_member.removed": row("membership.removed", { subjectKind: "member", memberName: "Member", memberEmail: "member@example.com", payload: { memberId: "mem_1" } }),
  "team_invitation.created": row("invite.created", { subjectKind: "invitation" }),
  "team_invitation.revoked": row("invite.revoked", { subjectKind: "invitation" }),
  "team_invitation.accepted": row("invite.accepted", { subjectKind: "invitation" }),
};

describe("Freeploy's team events as Coolify records them (goldens.json)", () => {
  test("the goldens are Coolify 91b7e3e's, and every mapped Freeploy event has one", () => {
    expect(goldens.coolify).toBe("91b7e3e");
    expect(Object.keys(FREEPLOY_OF).sort()).toEqual(Object.keys(goldens.events).sort());
    expect(Object.keys(TEAM_EVENTS).sort()).toEqual(Object.values(FREEPLOY_OF).map((r) => r.eventType).sort());
  });

  test.each(Object.entries(goldens.events))("%s", (key, golden) => {
    const e = toTeamAuditEvent(FREEPLOY_OF[key]!);
    expect({ event: e.event, source: e.source, action: e.action, actor_type: e.actorType, actor_name: e.actorName, actor_email: e.actorEmail, description: e.description }).toEqual({
      event: golden.event,
      source: golden.source,
      action: golden.action,
      actor_type: golden.actor_type,
      actor_name: golden.actor_name,
      actor_email: golden.actor_email,
      description: golden.description,
    });
    expect(e.coolify).toBe(true);
  });

  test.each(Object.entries(goldens.headline))("Str::headline(%j)", (word, expected) => {
    expect(headline(word)).toBe(expected);
  });
});

describe("Freeploy's own events and actors", () => {
  test("an event Coolify does not record keeps Freeploy's name and description; its action is the name's last part", () => {
    const e = toTeamAuditEvent(row("webhook_endpoint.secret_rotated", { description: "Webhook endpoint wh_1 secret rotated" }));
    expect([e.event, e.action, e.description, e.coolify]).toEqual(["webhook_endpoint.secret_rotated", "secret_rotated", "Webhook endpoint wh_1 secret rotated", false]);
  });

  test("an API key's service principal is Coolify's API token (source api); a workflow is the system", () => {
    const key = toTeamAuditEvent(row("invite.created", { actorType: "service_principal", actorId: "sp_1", actorName: null, actorEmail: null }));
    expect([key.event, key.source, key.actorType, key.actorName]).toEqual(["api.team_invitation.created", "api", "api_token", null]);
    const system = toTeamAuditEvent(row("invoice.paid", { actorType: "workflow", actorName: null, actorEmail: null }));
    expect([system.source, system.actorType]).toEqual(["system", "system"]);
  });

  test("a member or user without a display name is named by their email; one with neither by Coolify's resource headline", () => {
    expect(toTeamAuditEvent(row("membership.removed", { memberName: null, memberEmail: "bob@example.com" })).description).toBe("bob@example.com Removed");
    expect(toTeamAuditEvent(row("membership.removed")).description).toBe("Team Member Removed");
    expect(toTeamAuditEvent(row("invite.accepted", { actorName: null, actorEmail: "new@example.com" })).actorName).toBe("new@example.com");
  });
});

describe("AuditLog::render(): filters, sorts and pages", () => {
  const events = [
    toTeamAuditEvent(row("organization.updated", { payload: { name: "Acme" } })),
    toTeamAuditEvent(row("invite.created", { actorName: "Zed", actorEmail: "zed@example.com" })),
    toTeamAuditEvent(row("membership.removed", { memberName: "Bob" })),
    toTeamAuditEvent(row("api_key.created", { actorType: "service_principal", actorName: null, actorEmail: null, description: "API key created" })),
  ];
  const q = (query: string) => parseTeamAuditQuery(new URL(`https://events.internal/x?${query}`));

  test("the defaults: newest first, 25 a page, every action and source; the action options are the visible ones, A–Z", () => {
    const p = teamAuditPage(events, q(""));
    expect(p.sort).toBe("time-desc");
    expect(p.events.map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect([p.from, p.to, p.total, p.currentPage, p.lastPage, p.perPage]).toEqual([1, 4, 4, 1, 1, 25]);
    expect(p.actionOptions).toEqual([
      { value: "all", label: "All actions" },
      { value: "created", label: "Created" },
      { value: "removed", label: "Removed" },
      { value: "updated", label: "Updated" },
    ]);
    expect(p.sourceOptions).toBe(SOURCE_OPTIONS);
  });

  test("scopeFiltered(): action, source, and a case-sensitive search in event, description and actor", () => {
    expect(teamAuditPage(events, q("action=created")).events.map((e) => e.event)).toEqual(["ui.team_invitation.created", "api_key.created"]);
    expect(teamAuditPage(events, q("source=api")).events.map((e) => e.event)).toEqual(["api_key.created"]);
    expect(teamAuditPage(events, q("search=zed%40")).total).toBe(1);
    expect(teamAuditPage(events, q("search=Bob")).events.map((e) => e.description)).toEqual(["Bob Removed"]);
    expect(teamAuditPage(events, q("search=bob")).total).toBe(0);
    expect(teamAuditPage(events, q("search=team_member")).total).toBe(1);
    // The action options do not follow the filters.
    expect(teamAuditPage(events, q("source=api")).actionOptions).toHaveLength(4);
  });

  test("setSort(): actor, activity, source and time either way, ties newest first; an unknown sort is ignored", () => {
    expect(teamAuditPage(events, q("sort=actor-asc")).events.map((e) => e.actorName)).toEqual(["Owner", "Owner", "Zed", null]);
    expect(teamAuditPage(events, q("sort=actor-desc")).events.map((e) => e.actorName)).toEqual([null, "Zed", "Owner", "Owner"]);
    expect(teamAuditPage(events, q("sort=activity-asc")).events.map((e) => e.description)).toEqual(["Acme Updated", "API key created", "Bob Removed", "Team Invitation Created"]);
    expect(teamAuditPage(events, q("sort=time-asc")).events.map((e) => e.id)).toEqual([...events].reverse().map((e) => e.id));
    expect(teamAuditPage(events, q("sort=source-asc")).events.map((e) => e.source)).toEqual(["api", "ui", "ui", "ui"]);
    for (const bad of ["name-asc", "time-up", "time", "time-desc-x"]) expect(teamAuditPage(events, q(`sort=${bad}`)).sort).toBe("time-desc");
  });

  test("updatedPerPage() clamps to 10–100; Laravel's paginator past the last page is empty", () => {
    const many = Array.from({ length: 23 }, () => toTeamAuditEvent(row("invite.created")));
    expect(q("perPage=5").perPage).toBe(10);
    expect(q("perPage=500").perPage).toBe(100);
    const second = teamAuditPage(many, q("perPage=10&page=2"));
    expect([second.from, second.to, second.total, second.lastPage, second.events.length]).toEqual([11, 20, 23, 3, 10]);
    const beyond = teamAuditPage(many, q("perPage=10&page=9"));
    expect([beyond.from, beyond.to, beyond.events.length]).toEqual([0, 0, 0]);
  });
});

describe("GET /v1/organizations/{org}/audit/team-log", () => {
  const env = { ENVIRONMENT: "test" } as Env;
  const actor = { subjectId: "usr_owner", subjectType: "user" };
  function deps(allowed: boolean, rows: TeamAuditRow[] = []): TeamAuditLogDeps & { since: Date[] } {
    const since: Date[] = [];
    return {
      since,
      allowed: async () => allowed,
      rows: async (_org, s) => (since.push(s), rows),
      now: () => NOW,
    };
  }

  test("audit.read (owner and admin): a denial is a 404 and nothing is read", async () => {
    const d = deps(false, [row("invite.created")]);
    const res = await handleTeamAuditLog(new Request("https://events.internal/v1/organizations/x/audit/team-log"), env, "req_t", actor, ORG, d);
    expect(res.status).toBe(404);
    expect(d.since).toEqual([]);
  });

  test("the last 90 days, as Coolify keeps them, mapped and paged", async () => {
    const d = deps(true, [row("invite.created"), row("organization.updated", { payload: { name: "Acme" } })]);
    const res = await handleTeamAuditLog(new Request("https://events.internal/v1/organizations/x/audit/team-log?perPage=10"), env, "req_t", actor, ORG, d);
    expect(res.status).toBe(200);
    expect(d.since).toEqual([new Date(NOW.getTime() - 90 * 86_400_000)]);
    const body = (await res.json()) as { data: { events: Array<{ description: string }>; total: number; perPage: number } };
    expect(body.data.events.map((e) => e.description)).toEqual(["Team Invitation Created", "Acme Updated"]);
    expect([body.data.total, body.data.perPage]).toEqual([2, 10]);
  });

  test("the router: GET only, an org's public id, an actor", async () => {
    const path = "https://events.internal/v1/organizations/org_a1b2c3d4e5f67890abcdef1234567890/audit/team-log";
    expect((await route(new Request(path, { method: "POST", headers: { "x-actor-subject-id": "usr_owner", "x-actor-subject-type": "user" } }), env)).status).toBe(405);
    expect((await route(new Request(path), env)).status).toBe(401);
    expect((await route(new Request("https://events.internal/v1/organizations/nope/audit/team-log", { headers: { "x-actor-subject-id": "u", "x-actor-subject-type": "user" } }), env)).status).toBe(404);
    // Without its bindings the worker answers 503, never data.
    expect((await route(new Request(path, { headers: { "x-actor-subject-id": "usr_owner", "x-actor-subject-type": "user" } }), env)).status).toBe(503);
  });
});
