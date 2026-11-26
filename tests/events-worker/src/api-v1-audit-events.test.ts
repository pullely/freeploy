// Coolify's GET /api/v1/audit-events (DP-107): events-worker's handlers/api-v1-audit-events.ts and src/api-v1-audit-events.ts,
// replayed against Coolify's real answers (tests/deploy-core-worker/fixtures/api/goldens.json, emitted by Coolify's PHP
// through its HTTP kernel; see that directory's README.md). Coolify's rows are its cases' `setupCoolify` (three of team 1,
// one of team 2, one of the instance); events-worker is given the three audit entries Freeploy records for the same
// actions (the team renamed, an invitation, a role changed). The status and the body are compared byte for byte, the ids
// (Coolify's integers, Freeploy's entry, org and user ids) masked on both sides.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TeamAuditRow } from "@saas/db/events";
import type { Env } from "@events-worker/env";
import { route } from "@events-worker/router";
import { handleApiV1AuditEvents } from "@events-worker/handlers/api-v1-audit-events";
import type { TeamAuditLogDeps } from "@events-worker/handlers/team-audit-log";
import { auditEventsErrors } from "@events-worker/api-v1-audit-events";
import { fromJs, isObj, obj, phpJsonEncode, type PhpValue } from "@saas/contracts/coolify-api";

const API = resolve(dirname(fileURLToPath(import.meta.url)), "../../deploy-core-worker/fixtures/api");
interface Case {
  name: string;
  token?: string;
  method: string;
  path: string;
}
const CASES = JSON.parse(readFileSync(resolve(API, "cases.json"), "utf8")) as {
  fixture: { tokens: Array<{ key: string; user: number; abilities: string[] }>; users: Array<{ id: number; teams: Array<{ team: number; role: string }> }> };
  cases: Case[];
};
const GOLDENS = JSON.parse(readFileSync(resolve(API, "goldens.json"), "utf8")) as { cases: Array<{ name: string; status: number; body: { json?: string } }> };
const golden = (name: string) => GOLDENS.cases.find((c) => c.name === name)!;

const ORG_UUID = "00000000-0000-4000-8000-00000000000a";
const ORG = "org_0000000000004000800000000000000a";
const NOW = new Date("2026-01-01T00:00:00Z");
const usr = (n: number) => `usr_${"0".repeat(31)}${n}`;
const env = { ENVIRONMENT: "test" } as Env;

/** What Freeploy records for the three actions of Coolify's rows of team 1. */
const ENTRIES: TeamAuditRow[] = [
  { id: "7f3c0a1e9b2d4c5e8f60718293a4b5c6", eventType: "organization.updated", actorType: "user", actorId: usr(1), actorName: "Parity Owner", actorEmail: "owner@example.com", subjectKind: "organization", subjectId: ORG_UUID, subjectName: null, description: `Team ${ORG} updated`, occurredAt: new Date("2025-12-20T10:00:00Z"), payload: { name: "Parity Team", description: null }, memberName: null, memberEmail: null },
  { id: "0b9e8d7c6a5f4e3d2c1b0a9f8e7d6c5b", eventType: "invite.created", actorType: "user", actorId: usr(1), actorName: "Parity Owner", actorEmail: "owner@example.com", subjectKind: "invitation", subjectId: "inv_1", subjectName: null, description: "Invitation created", occurredAt: new Date("2025-12-21T10:00:00Z"), payload: { email: "new@example.com", role: "builder" }, memberName: null, memberEmail: null },
  { id: "5d4c3b2a19f8e7d6c5b4a3928170f6e5", eventType: "membership.updated", actorType: "user", actorId: usr(4), actorName: "Parity Admin", actorEmail: "admin@example.com", subjectKind: "membership", subjectId: "mem_2", subjectName: null, description: "Member role updated", occurredAt: new Date("2025-12-22T10:00:00Z"), payload: { memberId: "mem_2", role: "admin" }, memberName: "Parity Member", memberEmail: "member@example.com" },
];

/** Forty renames of the team a minute apart (the "many pages" cases' rows). */
const MANY: TeamAuditRow[] = Array.from({ length: 40 }, (_, i) => ({ ...ENTRIES[0]!, id: `e${String(i).padStart(31, "0")}`, occurredAt: new Date(Date.UTC(2025, 11, 1, 0, i)) }));

const roleOf = (userId: number) => CASES.fixture.users.find((u) => u.id === userId)!.teams.find((t) => t.team === 1)?.role ?? null;

function deps(userId: number, rows: TeamAuditRow[]): TeamAuditLogDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    rows: async (orgId, since) => {
      asked.push(`${orgId} ${since.toISOString()}`);
      return rows;
    },
    allowed: async () => ["owner", "admin"].includes(roleOf(userId) ?? ""),
    now: () => NOW,
  };
}

/** The request api-edge forwards for a case. */
function forwarded(c: Case): { request: Request; user: number } {
  const t = CASES.fixture.tokens.find((x) => x.key === c.token)!;
  const admin = ["owner", "admin"].includes(roleOf(t.user) ?? "");
  const [, query] = c.path.split("?");
  const headers = new Headers({
    "x-actor-subject-id": usr(t.user),
    "x-actor-subject-type": "user",
    "x-api-v1-org": ORG,
    "x-api-v1-user": usr(t.user),
    "x-api-v1-can-read-sensitive": admin && (t.abilities.includes("root") || t.abilities.includes("read:sensitive")) ? "1" : "0",
    "x-api-v1-url": "http://localhost/api/v1/audit-events",
  });
  return { request: new Request(`https://events.internal/v1/internal/api-v1/${ORG}/audit-events${query ? `?${query}` : ""}`, { method: c.method, headers }), user: t.user };
}

/** Both sides' ids: an event's, its team's and its actor's. */
function mask(v: PhpValue, parent = ""): PhpValue {
  if (Array.isArray(v)) return v.map((x) => mask(x, parent));
  if (!isObj(v)) return v;
  return obj(v.entries.map(([k, x]): [string, PhpValue] => [k, parent === "data" && k === "id" ? "<audit-id>" : parent === "data" && k === "team_id" ? "<team>" : parent === "data" && k === "actor_id" ? "<user>" : mask(x, k)]));
}
const norm = (text: string) => phpJsonEncode(mask(fromJs(JSON.parse(text))));

/** The cases events-worker answers (a missing read ability and the fallback are api-edge's). */
const AUDIT_CASES = CASES.cases.filter((c) => c.name.startsWith("audit events: ") && c.method === "GET");

describe("GET /api/v1/audit-events, replayed against Coolify's (DP-107)", () => {
  it("covers the page, its links, the filters, the validator and the admin check", () => {
    expect(AUDIT_CASES.length).toBe(23);
    expect(AUDIT_CASES.filter((c) => golden(c.name).status === 200).length).toBe(19);
  });

  it.each(AUDIT_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const g = golden(name);
    const { request, user } = forwarded(c);
    // A case without Coolify's rows is the team without audit events.
    const rows = c.name.startsWith("audit events: many pages") ? MANY : (c as Case & { setupCoolify?: string[] }).setupCoolify ? ENTRIES : [];
    const res = await handleApiV1AuditEvents(request, env, "r", { subjectId: usr(user), subjectType: "user" }, ORG, ORG_UUID, deps(user, rows));
    expect(res.status).toBe(g.status);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(norm(await res.text())).toBe(norm(g.body.json!));
  });
});

describe("what events-worker reads (DP-107)", () => {
  it("reads nothing for a user who is not a team admin", async () => {
    const c = AUDIT_CASES.find((x) => x.name === "audit events: a member")!;
    const { request, user } = forwarded(c);
    const d = deps(user, ENTRIES);
    expect((await handleApiV1AuditEvents(request, env, "r", { subjectId: usr(user), subjectType: "user" }, ORG, ORG_UUID, d)).status).toBe(403);
    expect(d.asked).toEqual([]);
  });

  it("reads the org's entries of the last 90 days", async () => {
    const c = AUDIT_CASES.find((x) => x.name === "audit events: list")!;
    const { request, user } = forwarded(c);
    const d = deps(user, ENTRIES);
    await handleApiV1AuditEvents(request, env, "r", { subjectId: usr(user), subjectType: "user" }, ORG, ORG_UUID, d);
    expect(d.asked).toEqual([`${ORG_UUID} 2025-10-03T00:00:00.000Z`]);
  });

  it("pages as Laravel's UrlWindow does, with '...' between the pages", async () => {
    const many = MANY;
    const page = async (n: number) => {
      const c: Case = { name: "x", token: "read", method: "GET", path: `/api/v1/audit-events?per_page=2&page=${n}` };
      const { request, user } = forwarded(c);
      const body = JSON.parse(await (await handleApiV1AuditEvents(request, env, "r", { subjectId: usr(user), subjectType: "user" }, ORG, ORG_UUID, deps(user, many))).text()) as { links: Array<{ label: string }> };
      return body.links.map((l) => l.label).slice(1, -1).join(" ");
    };
    expect(await page(1)).toBe("1 2 3 4 5 6 7 8 9 10 ... 19 20");
    expect(await page(10)).toBe("1 2 ... 7 8 9 10 11 12 13 ... 19 20");
    expect(await page(18)).toBe("1 2 ... 11 12 13 14 15 16 17 18 19 20");
  });

  it("is routed by events-worker for a GET with the actor", async () => {
    const res = await route(new Request(`https://events.internal/v1/internal/api-v1/${ORG}/audit-events`, { method: "POST", headers: { "x-actor-subject-id": usr(1), "x-actor-subject-type": "user" } }), env);
    expect(res.status).toBe(404);
    expect(auditEventsErrors({ per_page: "5", page: "1", search: null, source: "mcp" })).toEqual([]);
  });
});
