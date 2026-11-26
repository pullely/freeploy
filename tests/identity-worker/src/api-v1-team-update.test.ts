/// <reference types="@cloudflare/workers-types" />
// PATCH /api/v1/team (DP-107): the token's team's two settings, replayed against Coolify's real answers
// (tests/deploy-core-worker/fixtures/api/goldens.json, emitted by Coolify's PHP through its HTTP kernel; see that
// directory's README.md). identity-worker answers it; membership-worker — which stores the settings on the org (migration
// 730) and decides TeamPolicy::update (organization.settings.update) — is faked here by a team of the fixture's, and the
// settings it was sent and kept are compared with the rows Coolify's PATCH left (`after`).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../../../apps/identity-worker/src/env";
import { handleApiV1Teams, teamSettingsErrors, type OrgFacts, type TeamSettings, type TeamsDeps } from "../../../apps/identity-worker/src/handlers/api-v1-teams";
import { fromJs, isObj, obj, phpJsonEncode, type PhpValue } from "@saas/contracts/coolify-api";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = resolve(HERE, "../../deploy-core-worker/fixtures/api");
interface Step {
  token?: string;
  method: string;
  path: string;
  body?: unknown;
  raw?: string;
  contentType?: string;
}
interface Case extends Step {
  name: string;
  sequence?: Step[];
  after?: Record<string, string>;
}
interface Answer {
  status: number;
  body: { json?: string; text?: string };
}
interface Golden extends Answer {
  name: string;
  steps?: Answer[];
  after?: { team?: Array<{ name: string; description: string | null; is_build_server_fallback_enabled: boolean; scan_images_on_new_servers: boolean }> };
}
const API_CASES = JSON.parse(readFileSync(resolve(API, "cases.json"), "utf8")) as {
  fixture: { tokens: Array<{ key: string; user: number; abilities: string[] }>; users: Array<{ id: number; teams: Array<{ team: number; role: string }> }> };
  cases: Case[];
};
const API_GOLDENS = JSON.parse(readFileSync(resolve(API, "goldens.json"), "utf8")) as { cases: Golden[] };
const golden = (name: string) => API_GOLDENS.cases.find((c) => c.name === name)!;

const ORG = "org_0000000000004000800000000000000a";
const env = { ENVIRONMENT: "test" } as Env;
const usrOf = (n: number) => `usr_${`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`.replace(/-/g, "")}`;

/** membership-worker's org and its team settings for one case (Coolify's defaults for a new team), with what it was sent. */
class Team {
  facts: OrgFacts = { id: ORG, name: "Parity Team", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", isBuildServerFallbackEnabled: true, scanImagesOnNewServers: false };
  sent: TeamSettings[] = [];
  constructor(private readonly admins: ReadonlySet<string>) {}
  deps(): TeamsDeps {
    return {
      org: async () => ({ ...this.facts }),
      canUpdate: async (_o, userId) => this.admins.has(userId),
      updateSettings: async (_o, _u, _r, changes) => {
        this.sent.push(changes);
        this.facts = { ...this.facts, ...changes };
        return { ...this.facts };
      },
    };
  }
}
const ADMINS = new Set(API_CASES.fixture.users.filter((u) => u.teams.some((t) => t.team === 1 && (t.role === "owner" || t.role === "admin"))).map((u) => usrOf(u.id)));

function request(step: Step): Request {
  const t = API_CASES.fixture.tokens.find((x) => x.key === step.token)!;
  const headers = new Headers({ "x-api-v1-org": ORG, "x-api-v1-user": usrOf(t.user) });
  let body: string | undefined;
  if (step.raw !== undefined) {
    body = step.raw;
    headers.set("content-type", step.contentType ?? "application/json");
  } else if (step.body !== undefined) {
    body = JSON.stringify(step.body);
    headers.set("content-type", "application/json");
  }
  const [path, query] = step.path.slice("/api/v1".length).split("?");
  return new Request(`https://i/v1/internal/api-v1${path}${query ? `?${query}` : ""}`, { method: step.method, headers, ...(body !== undefined && { body }) });
}

/** Both sides' ids: the team's (Coolify 1, Freeploy org_…); dates. */
function mask(v: PhpValue): PhpValue {
  if (Array.isArray(v)) return v.map(mask);
  if (!isObj(v)) return typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? "<date>" : v;
  return obj(v.entries.map(([k, x]): [string, PhpValue] => [k, k === "id" ? "<team>" : mask(x)]));
}
const norm = (text: string) => phpJsonEncode(mask(fromJs(JSON.parse(text))));

/** The cases of PATCH /team whose answer is identity-worker's (a missing write ability is api-edge's). */
const CASES = API_CASES.cases.filter((c) => c.name.startsWith("team: update") && !/^\{"message":"Missing required permissions/.test(golden(c.name).body?.json ?? ""));

describe("PATCH /api/v1/team, replayed against Coolify's (DP-107)", () => {
  it("covers the settings, the validator and a read back", () => {
    expect(CASES.length).toBe(13);
    expect(CASES.filter((c) => (golden(c.name).steps?.[0] ?? golden(c.name)).status === 200).length).toBe(6);
  });

  it.each(CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const g = golden(name);
    const team = new Team(ADMINS);
    const want = g.steps ?? [g];
    const steps = c.sequence ?? [c];
    for (const [i, step] of steps.entries()) {
      const res = await handleApiV1Teams(request(step), env, "r", team.deps());
      expect(res.status).toBe(want[i]!.status);
      expect(norm(await res.text())).toBe(norm(want[i]!.body.json!));
    }
    // The rows Coolify's PATCH left: what membership-worker keeps.
    const row = g.after?.team?.[0];
    if (row) {
      expect({ is_build_server_fallback_enabled: team.facts.isBuildServerFallbackEnabled, scan_images_on_new_servers: team.facts.scanImagesOnNewServers }).toEqual({
        is_build_server_fallback_enabled: row.is_build_server_fallback_enabled,
        scan_images_on_new_servers: row.scan_images_on_new_servers,
      });
      if (g.status !== 200) expect(team.sent).toEqual([]);
    }
  });
});

describe("who may update the team (DP-107)", () => {
  it("refuses a user TeamPolicy::update refuses before the body is validated, and sends nothing", async () => {
    const team = new Team(new Set());
    for (const name of ["team: update both settings", "team: update, values that are not booleans"]) {
      const res = await handleApiV1Teams(request(API_CASES.cases.find((c) => c.name === name)!), env, "r", team.deps());
      expect(res.status).toBe(403);
      expect(await res.text()).toBe('{"message":"You are not authorized to perform this action.","error":"Unauthorized"}');
    }
    expect(team.sent).toEqual([]);
  });

  it("answers Coolify's invalid-token answer when the token's org is not the user's", async () => {
    const res = await handleApiV1Teams(request(API_CASES.cases.find((c) => c.name === "team: update both settings")!), env, "r", { ...new Team(ADMINS).deps(), org: async () => null });
    expect(res.status).toBe(400);
  });

  it("sends membership-worker only the settings the request has", async () => {
    const team = new Team(ADMINS);
    await handleApiV1Teams(request({ token: "write", method: "PATCH", path: "/api/v1/team", body: { scan_images_on_new_servers: "1" } }), env, "r", team.deps());
    expect(team.sent).toEqual([{ scanImagesOnNewServers: true }]);
    expect(teamSettingsErrors({ is_build_server_fallback_enabled: false })).toBeNull();
  });
});
