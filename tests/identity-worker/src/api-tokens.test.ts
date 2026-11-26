/// <reference types="@cloudflare/workers-types" />
// API tokens (DP-70): Coolify's Keys & Tokens → API Tokens on identity API keys, the token behind
// /api/v1, and the /api/v1 teams. The rules and messages are held to Coolify's own answers:
// fixtures/api-tokens/goldens.json (the Livewire page, emitted by Coolify's PHP) and
// tests/deploy-core-worker/fixtures/api/goldens.json (the HTTP API, same method).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../../../apps/identity-worker/src/env";
import { handleApiTokens, handleResolveApiToken, resolveApiToken, type ApiTokenDeps } from "../../../apps/identity-worker/src/handlers/api-tokens";
import { handleApiV1Teams, type OrgFacts } from "../../../apps/identity-worker/src/handlers/api-v1-teams";
import { crc32b, generateSecret, permissionsFor, sha256Hex, validateTokenForm, type CoolifyRole } from "../../../apps/identity-worker/src/api-tokens/rules";
import { createAuthService } from "../../../apps/identity-worker/src/services/auth";
import { route } from "../../../apps/identity-worker/src/router";
import type { ApiTokenRow, ApiTokenStore, ApiUserRow, NewApiToken } from "@saas/db/identity";
import { fromJs, isObj, obj, phpJsonEncode, type PhpValue } from "@saas/contracts/coolify-api";
import { createFakeRepository } from "./helpers/fake-repository";

const HERE = dirname(fileURLToPath(import.meta.url));
interface TokenCase { name: string; user: "owner" | "admin" | "member"; set?: Record<string, unknown>; call?: string }
interface TokenGolden { name: string; mount: Record<string, unknown>; errors: unknown; toasts: Array<[string, string]>; issued: { id: boolean; secretLength: number; crc: boolean } | null; tokens: Array<{ name: string; abilities: string[]; team_id: string; expires_at: string | null }> }
const TOKEN_CASES = JSON.parse(readFileSync(resolve(HERE, "../fixtures/api-tokens/cases.json"), "utf8")) as { cases: TokenCase[] };
const TOKEN_GOLDENS = JSON.parse(readFileSync(resolve(HERE, "../fixtures/api-tokens/goldens.json"), "utf8")) as { cases: TokenGolden[] };
const API = resolve(HERE, "../../deploy-core-worker/fixtures/api");
const API_CASES = JSON.parse(readFileSync(resolve(API, "cases.json"), "utf8")) as {
  fixture: {
    teams: Array<{ id: number; name: string }>;
    users: Array<{ id: number; name: string; email: string; teams: Array<{ team: number; role: string }> }>;
    tokens: Array<{ key: string; id: number; user: number; team: number; abilities: string[]; secret: string; expires_at?: string }>;
  };
};
const API_GOLDENS = JSON.parse(readFileSync(resolve(API, "goldens.json"), "utf8")) as { cases: Array<{ name: string; status: number; body: { json?: string } }> };

const ORG_UUID = "00000000-0000-4000-8000-00000000000a";
const ORG = "org_0000000000004000800000000000000a";
const NOW = new Date("2026-01-01T00:00:00Z");
const env = { ENVIRONMENT: "test" } as Env;
const uuidOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const usrOf = (n: number) => `usr_${uuidOf(n).replace(/-/g, "")}`;

/** identity.api_keys' tokens, in memory. */
class MemoryTokens {
  rows: ApiTokenRow[] = [];
  next = 1;
  touched: string[] = [];
  inactiveUsers = new Set<string>();
  store(): ApiTokenStore {
    return {
      create: async (t: NewApiToken) => {
        const row: ApiTokenRow = { id: t.id, tokenNumber: this.next++, orgId: t.orgId, userId: t.userId, name: t.name, abilities: t.abilities, keyHash: t.keyHash, status: "active", expiresAt: t.expiresAt, lastUsedAt: null, revokedAt: null, createdAt: t.createdAt };
        this.rows.push(row);
        return row;
      },
      list: async (orgId, userId) => this.rows.filter((r) => r.orgId === orgId && r.userId === userId && r.status === "active").reverse(),
      findByNumber: async (n) => this.rows.find((r) => r.tokenNumber === n) ?? null,
      findByHash: async (h) => this.rows.find((r) => r.keyHash === h) ?? null,
      revoke: async (orgId, userId, n, at) => {
        const r = this.rows.find((x) => x.orgId === orgId && x.userId === userId && x.tokenNumber === n && x.status === "active");
        if (!r) return null;
        r.status = "revoked";
        r.revokedAt = at;
        return r;
      },
      touch: async (id) => void this.touched.push(id),
      users: async () => [],
      userIsActive: async (id) => !this.inactiveUsers.has(id),
    } as ApiTokenStore;
  }
  deps(roles: Record<string, CoolifyRole | null>): ApiTokenDeps {
    let i = 0;
    return {
      withStore: (fn) => fn(this.store()),
      roleOf: async (userId) => roles[userId] ?? null,
      now: () => NOW,
      random: (n) => Uint8Array.from({ length: n }, () => (i++ * 7) % 248),
    };
  }
}

function tokensRequest(method: string, userId: string, body?: unknown, id?: number): Request {
  return new Request(`https://identity.internal/v1/organizations/${ORG}/api-tokens${id === undefined ? "" : `/${id}`}`, {
    method,
    headers: { "x-actor-subject-id": userId, "x-actor-subject-type": "user", "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

const OWNER = usrOf(1);
const MEMBER = usrOf(2);
const ADMIN = usrOf(4);
const ROLES: Record<string, CoolifyRole | null> = { [OWNER]: "owner", [MEMBER]: "member", [ADMIN]: "admin" };
const USER_OF = { owner: OWNER, admin: ADMIN, member: MEMBER } as const;

describe("the API Tokens page, replayed against Coolify's", () => {
  const createCases = TOKEN_CASES.cases.filter((c) => c.call === "addNewToken");

  it.each(createCases.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const g = TOKEN_GOLDENS.cases.find((x) => x.name === name)!;
    const m = new MemoryTokens();
    const form = Object.fromEntries(Object.entries(c.set ?? {}).map(([k, v]) => [k.replace(/^form\./, ""), v]));
    const res = await handleApiTokens(tokensRequest("POST", USER_OF[c.user], form), env, "req", m.deps(ROLES));
    const body = (await res.json()) as { data?: { token: string }; error?: { message: string } };
    if (g.issued) {
      expect(res.status).toBe(201);
      const [id, secret] = body.data!.token.split("|") as [string, string];
      expect(id).toBe("1");
      expect(secret.length).toBe(g.issued.secretLength);
      expect(crc32b(secret.slice(0, 40))).toBe(secret.slice(40));
      // What Coolify stored: the name, the abilities (sorted by the form), the expiry.
      expect(m.rows.map((r) => ({ name: r.name, abilities: r.abilities, expires_at: r.expiresAt ? r.expiresAt.toISOString().replace(".000Z", "+00:00") : null }))).toEqual(
        g.tokens.map((t) => ({ name: t.name, abilities: t.abilities, expires_at: t.expires_at })),
      );
      // Sanctum's hash of what follows "<id>|".
      expect(m.rows[0]!.keyHash).toBe(await sha256Hex(secret));
    } else {
      expect(res.status).toBe(422);
      expect(body.error!.message).toBe(g.toasts[0]![1]);
      expect(m.rows).toEqual([]);
    }
  });

  it("offers what the user's role allows (mount)", () => {
    for (const [name, role] of [["mount: owner", "owner"], ["mount: member", "member"]] as const) {
      const g = TOKEN_GOLDENS.cases.find((x) => x.name === name)!;
      const flags = Object.fromEntries(Object.entries(g.mount).filter(([k]) => k !== "expirationOptions" && k !== "form"));
      expect(permissionsFor(role)).toEqual(flags);
    }
  });

  it("lists the user's tokens in the org, newest first, and revokes only the user's own", async () => {
    const m = new MemoryTokens();
    const deps = m.deps(ROLES);
    for (const d of ["First", "Second"]) await handleApiTokens(tokensRequest("POST", OWNER, { description: d }), env, "r", deps);
    await handleApiTokens(tokensRequest("POST", MEMBER, { description: "Not mine" }), env, "r", deps);
    const list = (await (await handleApiTokens(tokensRequest("GET", OWNER), env, "r", deps)).json()) as { data: { tokens: Array<{ id: number; name: string; abilities: string[]; expiresAt: string | null }>; canUseRootPermissions: boolean; expirationOptions: unknown[] } };
    expect(list.data.tokens.map((t) => t.name)).toEqual(["Second", "First"]);
    expect(list.data.tokens[0]).toMatchObject({ id: 2, abilities: ["read"], expiresAt: "2026-01-31T00:00:00.000Z" });
    expect(list.data.canUseRootPermissions).toBe(true);
    expect(list.data.expirationOptions).toEqual([
      { value: "7", label: "7 days" },
      { value: "30", label: "30 days" },
      { value: "60", label: "60 days" },
      { value: "90", label: "90 days" },
      { value: "365", label: "1 year" },
    ]);
    // findOwnToken(): another user's token is not found.
    expect((await handleApiTokens(tokensRequest("DELETE", OWNER, undefined, 3), env, "r", deps)).status).toBe(404);
    expect((await handleApiTokens(tokensRequest("DELETE", OWNER, undefined, 1), env, "r", deps)).status).toBe(200);
    expect((await handleApiTokens(tokensRequest("DELETE", OWNER, undefined, 1), env, "r", deps)).status).toBe(404);
    const after = (await (await handleApiTokens(tokensRequest("GET", OWNER), env, "r", deps)).json()) as { data: { tokens: Array<{ name: string }> } };
    expect(after.data.tokens.map((t) => t.name)).toEqual(["Second"]);
  });

  it("is not found for a user who is not a member of the org", async () => {
    const m = new MemoryTokens();
    const res = await handleApiTokens(tokensRequest("GET", usrOf(9)), env, "r", m.deps(ROLES));
    expect(res.status).toBe(404);
  });

  it("refuses scoped tokens, which Freeploy has not ported", () => {
    expect(validateTokenForm({ description: "Scoped", scopeMode: "selected" }, "owner")).toEqual({ ok: false, message: "Tokens limited to selected projects, environments, or resources are not available yet." });
  });

  it("summarizes several errors as Laravel's ValidationException does", () => {
    expect(validateTokenForm({ description: "", expiresInDays: 15, permissions: ["bogus"] }, "owner")).toEqual({
      ok: false,
      message: "The description field is required. (and 2 more errors)",
    });
  });

  it("makes Sanctum's secret: 40 letters and digits and their crc32b", () => {
    const s = generateSecret();
    expect(s).toMatch(/^[A-Za-z0-9]{40}[0-9a-f]{8}$/);
    expect(crc32b("hello")).toBe("3610a686");
  });
});

describe("the token behind /api/v1 (auth:sanctum, api.token.team, api.sensitive)", () => {
  /** The HTTP fixture's tokens, as identity rows: user N is uuidOf(N), team 1 is the org. */
  async function fixtureTokens(): Promise<{ m: MemoryTokens; roleOf: Record<string, CoolifyRole | null> }> {
    const m = new MemoryTokens();
    for (const t of API_CASES.fixture.tokens) {
      m.rows.push({ id: `key-${t.id}`, tokenNumber: t.id, orgId: t.team === 1 ? ORG_UUID : uuidOf(999), userId: uuidOf(t.user), name: t.key, abilities: t.abilities, keyHash: await sha256Hex(t.secret), status: "active", expiresAt: t.expires_at ? new Date(`${t.expires_at.replace(" ", "T")}Z`) : null, lastUsedAt: null, revokedAt: null, createdAt: NOW });
    }
    return { m, roleOf: {} };
  }
  const roleOf = async (userId: string, orgUuid: string): Promise<CoolifyRole | null> => {
    const user = API_CASES.fixture.users.find((u) => usrOf(u.id) === userId)!;
    const team = orgUuid === ORG_UUID ? 1 : 2;
    return (user.teams.find((x) => x.team === team)?.role as CoolifyRole | undefined) ?? null;
  };

  /** What Coolify answered each fixture token with (the HTTP goldens), as a resolve status. */
  const EXPECTED: Record<string, string> = {
    expired: "unauthenticated",
    notMember: "invalid_token",
    memberWrite: "exceeds_access",
    memberSensitive: "exceeds_access",
    memberRead: "ok",
    root: "ok",
    read: "ok",
    write: "ok",
  };

  it.each(Object.entries(EXPECTED))("%s → %s", async (key, status) => {
    const { m } = await fixtureTokens();
    const t = API_CASES.fixture.tokens.find((x) => x.key === key)!;
    const r = await resolveApiToken(`Bearer ${t.id}|${t.secret}`, env, "r", { withStore: (fn) => fn(m.store()), roleOf, now: () => NOW });
    expect(r.status).toBe(status);
  });

  it("matches Coolify's goldens for the token cases", () => {
    const g = (n: string) => API_GOLDENS.cases.find((c) => c.name === n)!;
    expect([g("auth: expired").status, g("auth: team the user left").status, g("ability: member token beyond the member's access").status, g("ability: member read token").status]).toEqual([401, 401, 403, 200]);
  });

  it("resolves a secret sent without its id (by its hash), refuses a wrong secret, a revoked token and a deleted user", async () => {
    const { m } = await fixtureTokens();
    const deps = { withStore: <T>(fn: (s: ApiTokenStore) => Promise<T>) => fn(m.store()), roleOf, now: () => NOW };
    const root = API_CASES.fixture.tokens.find((x) => x.key === "root")!;
    expect(await resolveApiToken(`Bearer ${root.secret}`, env, "r", deps)).toMatchObject({ status: "ok", tokenNumber: 1, orgId: ORG, abilities: ["root"], canReadSensitive: true });
    expect((await resolveApiToken(`Bearer 1|${"x".repeat(48)}`, env, "r", deps)).status).toBe("unauthenticated");
    expect((await resolveApiToken(`Bearer abc|${root.secret}`, env, "r", deps)).status).toBe("unauthenticated");
    expect((await resolveApiToken("Basic dXNlcjpwYXNz", env, "r", deps)).status).toBe("unauthenticated");
    expect(m.touched).toContain("key-1");
    m.rows.find((r) => r.tokenNumber === 1)!.status = "revoked";
    expect((await resolveApiToken(`Bearer 1|${root.secret}`, env, "r", deps)).status).toBe("unauthenticated");
    const read = API_CASES.fixture.tokens.find((x) => x.key === "read")!;
    m.inactiveUsers.add(uuidOf(1));
    expect((await resolveApiToken(`Bearer ${read.id}|${read.secret}`, env, "r", deps)).status).toBe("unauthenticated");
  });

  it("gives read:sensitive only to a team admin's token (ApiSensitiveData)", async () => {
    const { m } = await fixtureTokens();
    const s = API_CASES.fixture.tokens.find((x) => x.key === "sensitive")!;
    expect(await resolveApiToken(`Bearer ${s.id}|${s.secret}`, env, "r", { withStore: (fn) => fn(m.store()), roleOf, now: () => NOW })).toMatchObject({ canReadSensitive: true });
    const read = API_CASES.fixture.tokens.find((x) => x.key === "read")!;
    expect(await resolveApiToken(`Bearer ${read.id}|${read.secret}`, env, "r", { withStore: (fn) => fn(m.store()), roleOf, now: () => NOW })).toMatchObject({ canReadSensitive: false });
  });

  it("answers api-edge in the platform envelope, on POST only", async () => {
    const { m } = await fixtureTokens();
    const deps = { withStore: <T>(fn: (s: ApiTokenStore) => Promise<T>) => fn(m.store()), roleOf, now: () => NOW };
    const res = await handleResolveApiToken(new Request("https://i/v1/internal/api-tokens/resolve", { method: "POST", headers: { authorization: "Bearer nope" } }), env, "r", deps);
    expect(await res.json()).toMatchObject({ data: { status: "unauthenticated" } });
    expect((await handleResolveApiToken(new Request("https://i/v1/internal/api-tokens/resolve"), env, "r", deps)).status).toBe(405);
  });

  it("is never a Freeploy bearer: /v1/auth/resolve refuses an API token", async () => {
    const repo = createFakeRepository();
    const secret = "s".repeat(48);
    const hash = await sha256Hex(secret);
    repo.getApiKeyByKeyHash = async (h: string) =>
      h === hash
        ? { ok: true, value: { id: "k", servicePrincipalId: "sp", orgId: ORG_UUID, keyPrefix: "ssssssss", label: "t", status: "active", expiresAt: null, lastUsedAt: null, revokedAt: null, revokedBy: null, createdBy: uuidOf(1), createdAt: NOW, updatedAt: NOW, abilities: ["root"] } }
        : { ok: false, error: { kind: "not_found" } };
    const auth = createAuthService({ repo, now: () => NOW });
    expect(await auth.resolveBearer(secret)).toMatchObject({ error: "unauthenticated" });
  });

  it("is routed by identity-worker", async () => {
    const res = await route(new Request("https://i/v1/internal/api-tokens/resolve", { method: "POST" }), env);
    expect(res.status).toBe(503); // no database bound in this test
  });
});

describe("/api/v1 teams, replayed against Coolify's", () => {
  const ORG_FACTS: OrgFacts = { id: ORG, name: "Parity Team", createdAt: "2026-01-01T00:00:00.000Z" };
  const users: ApiUserRow[] = API_CASES.fixture.users
    .filter((u) => u.teams.some((t) => t.team === 1))
    .map((u) => ({ id: uuidOf(u.id), name: u.name, email: u.email, emailVerifiedAt: null, twoFactorConfirmedAt: null, pendingEmail: null, createdAt: NOW, updatedAt: NOW }));
  const deps = {
    org: async () => ORG_FACTS,
    memberIds: async () => users.map((u) => `usr_${u.id.replace(/-/g, "")}`),
    users: async (ids: string[]) => users.filter((u) => ids.includes(u.id)),
  };
  /** Both sides' ids: the team's (Coolify 1, Freeploy org_…) and each member's (by email); dates. */
  function mask(v: PhpValue, teamId: boolean, parent = ""): PhpValue {
    if (Array.isArray(v)) return v.map((x) => mask(x, teamId, parent));
    if (!isObj(v)) return typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? "<date>" : v;
    const email = v.entries.find(([k]) => k === "email")?.[1];
    return obj(v.entries.map(([k, x]): [string, PhpValue] => [k, k === "current_team_id" ? "<team>" : k === "id" ? (typeof email === "string" ? `<user:${email}>` : teamId ? "<team>" : x) : mask(x, teamId, k)]));
  }
  const PATHS: Record<string, string> = {
    "teams: current team": "/team",
    "teams: current team (deprecated alias)": "/teams/current",
    "teams: teams": "/teams",
    "teams: team by id": `/teams/${ORG}`,
    "teams: another team by id": "/teams/org_ffffffffffffffffffffffffffffffff",
    "teams: members": "/team/members",
    "teams: members (deprecated alias)": "/teams/current/members",
    "teams: members by id": `/teams/${ORG}/members`,
    "teams: members of another team": "/teams/org_ffffffffffffffffffffffffffffffff/members",
  };
  it.each(Object.entries(PATHS))("%s", async (name, path) => {
    const g = API_GOLDENS.cases.find((c) => c.name === name)!;
    const res = await handleApiV1Teams(new Request(`https://i/v1/internal/api-v1${path}`, { headers: { "x-api-v1-org": ORG, "x-api-v1-user": usrOf(1) } }), env, "r", deps);
    expect(res.status).toBe(g.status);
    const norm = (text: string) => phpJsonEncode(mask(fromJs(JSON.parse(text)), true));
    expect(norm(await res.text())).toBe(norm(g.body.json!));
  });

  it("answers Coolify's invalid-token answer when the token's org is not the user's", async () => {
    const res = await handleApiV1Teams(new Request("https://i/v1/internal/api-v1/team", { headers: { "x-api-v1-org": ORG, "x-api-v1-user": usrOf(1) } }), env, "r", { ...deps, org: async () => null });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('{"message":"Invalid token.","docs":"https:\\/\\/coolify.io\\/docs\\/api-reference\\/authorization"}');
  });
});
