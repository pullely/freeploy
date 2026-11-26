// Coolify's /api/v1 for projects, environments, private keys and servers (DP-70), replayed against
// Coolify's real answers: fixtures/api/goldens.json, emitted by Coolify's PHP through its HTTP kernel (see
// fixtures/api/README.md). The same fixture is loaded here into memory stores whose rows have the columns,
// types and defaults of Freeploy's database (fixtures/api/freeploy-rows.json, held to the real schema by
// tests/db/src/deploy-api-v1.test.ts); each request goes to deploy-core-worker's handler with the headers
// api-edge sends, and status and body are compared byte for byte after the masking both sides share.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { handleApiV1, type ApiV1Runners } from "@deploy-core-worker/api-v1/handler";
import type { Env } from "@deploy-core-worker/env";
import type { ProjectStore } from "@deploy-core-worker/projects/service";
import type { OrgContext, PrivateKeyStore } from "@deploy-core-worker/private-keys/service";
import { fingerprintSha256, formatPrivateKey } from "@deploy-core-worker/keys/ssh-keys";
import { route } from "@deploy-core-worker/router";
import type { ApiRow } from "@saas/db/deploy";
import { API_V1_HEADERS, fromJs, phpJsonEncode } from "@saas/contracts/coolify-api";
import { API_FIXTURES, CASES, FREEPLOY_ROWS, GOLDENS, golden, maskedJson, type Case, type FixtureToken } from "./api-v1-goldens.js";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const env = { ENVIRONMENT: "test" } as Env;
const T1 = 1;
const CLOCK = "2026-01-01T00:00:00";

const roleOf = (userId: number) => CASES.fixture.users.find((u) => u.id === userId)!.teams.find((t) => t.team === T1)?.role ?? null;
const isAdmin = (userId: number) => ["owner", "admin"].includes(roleOf(userId) ?? "");

function template(table: string): ApiRow {
  const row = FREEPLOY_ROWS[table]?.[0];
  if (!row) throw new Error(`no row template for ${table}`);
  return row.map(([k, v]) => [k, v]);
}
function make(table: string, values: Record<string, unknown>): ApiRow {
  return template(table).map(([k, v]): [string, unknown] => [k, k in values ? values[k] : v]);
}
const val = (row: ApiRow, k: string) => row.find(([c]) => c === k)?.[1];
const set = (row: ApiRow, k: string, v: unknown) => {
  const at = row.findIndex(([c]) => c === k);
  if (at === -1) row.push([k, v]);
  else row[at] = [k, v];
};

/** One org's rows (team 1 of the fixture), and the stores of the services over them. */
class MemoryOrg {
  projects: ApiRow[] = [];
  environments: ApiRow[] = [];
  keys: ApiRow[] = [];
  servers: ApiRow[] = [];
  settings: ApiRow[] = [];
  private nextId: Record<string, number> = {};

  static async fromFixture(): Promise<MemoryOrg> {
    const m = new MemoryOrg();
    const f = CASES.fixture;
    for (const p of f.projects.filter((x) => x.team === T1)) {
      m.projects.push(make("projects", { id: p.id, uuid: p.uuid, name: p.name, description: p.description }));
      for (const e of p.environments) m.environments.push(make("environments", { id: e.id, uuid: e.uuid, name: e.name, description: e.description, project_id: p.id }));
    }
    for (const k of f.privateKeys.filter((x) => x.team === T1)) {
      const text = formatPrivateKey(readFileSync(resolve(API_FIXTURES, k.file), "utf8"));
      m.keys.push(make("private_keys", { id: k.id, uuid: k.uuid, name: k.name, description: k.description, private_key: `enc:${text}`, fingerprint: await fingerprintSha256(text) }));
    }
    for (const s of f.servers.filter((x) => x.team === T1)) {
      m.servers.push(make("servers", { id: s.id, uuid: s.uuid, name: s.name, description: s.description, ip: s.ip, user: s.user, port: s.port, private_key_id: s.private_key_id }));
      m.settings.push(make("server_settings", { id: s.id, server_id: s.id }));
    }
    for (const [t, rows] of Object.entries({ projects: m.projects, environments: m.environments, private_keys: m.keys })) m.nextId[t] = Math.max(0, ...rows.map((r) => Number(val(r, "id")))) + 1;
    // Coolify's sequences continue after every team's rows.
    m.nextId.projects = 4;
    m.nextId.environments = 5;
    m.nextId.private_keys = 4;
    return m;
  }

  id(table: string): number {
    return this.nextId[table]!++;
  }

  rows(table: string, where?: string, params: unknown[] = []): ApiRow[] {
    const all = ({ projects: this.projects, environments: this.environments, private_keys: this.keys, servers: this.servers, server_settings: this.settings } as Record<string, ApiRow[]>)[table]!;
    const conditions = (where ?? "").split(" AND ").filter(Boolean);
    return all
      .filter((r) =>
        conditions.every((c) => {
          if (c === "t.deleted_at IS NULL") return val(r, "deleted_at") === null;
          if (c === "t.uuid = $1") return val(r, "uuid") === params[0];
          if (c === "t.project_id = $1") return val(r, "project_id") === params[0];
          if (c === "t.server_id = ANY($1)") return (params[0] as unknown[]).includes(val(r, "server_id"));
          throw new Error(`memory rows: ${c}`);
        }),
      )
      .map((r) => r.map(([k, v]): [string, unknown] => [k, v]));
  }

  projectStore(): ProjectStore {
    const asProject = (r: ApiRow) => ({ id: val(r, "id") as number, uuid: val(r, "uuid") as string, name: val(r, "name") as string, description: val(r, "description") as string | null, created_at: CLOCK, updated_at: CLOCK });
    const asEnv = (r: ApiRow) => ({ ...asProject(r), project_id: val(r, "project_id") as number, resource_count: 0 });
    return {
      list: async () => [],
      findByUuid: async (uuid) => {
        const r = this.projects.find((p) => val(p, "uuid") === uuid);
        return r ? asProject(r) : null;
      },
      insert: async (p) => {
        const row = make("projects", { id: this.id("projects"), uuid: p.uuid, name: p.name, description: p.description });
        this.projects.push(row);
        const env = make("environments", { id: this.id("environments"), uuid: p.productionEnvironmentUuid, name: "production", description: null, project_id: val(row, "id") });
        this.environments.push(env);
        return { project: asProject(row), environment: asEnv(env) };
      },
      update: async (id, changes) => {
        const row = this.projects.find((p) => val(p, "id") === id);
        if (!row) return null;
        set(row, "name", changes.name);
        set(row, "description", changes.description);
        return asProject(row);
      },
      delete: async (id) => {
        this.projects = this.projects.filter((p) => val(p, "id") !== id);
        this.environments = this.environments.filter((e) => val(e, "project_id") !== id);
        return true;
      },
      projectHasResources: async () => false,
      environments: async (projectId) => this.environments.filter((e) => val(e, "project_id") === projectId).map(asEnv),
      findEnvironment: async (projectId, uuid) => {
        const r = this.environments.find((e) => val(e, "project_id") === projectId && val(e, "uuid") === uuid);
        return r ? asEnv(r) : null;
      },
      insertEnvironment: async (e) => {
        const row = make("environments", { id: this.id("environments"), uuid: e.uuid, name: e.name, description: e.description ?? null, project_id: e.projectId });
        this.environments.push(row);
        return asEnv(row);
      },
      updateEnvironment: async (id, changes) => {
        const row = this.environments.find((e) => val(e, "id") === id);
        if (!row) return null;
        set(row, "name", changes.name);
        set(row, "description", changes.description);
        return asEnv(row);
      },
      deleteEnvironment: async (id) => {
        this.environments = this.environments.filter((e) => val(e, "id") !== id);
        return true;
      },
      environmentNameExists: async (projectId, name, excludeId) => this.environments.some((e) => val(e, "project_id") === projectId && val(e, "name") === name && val(e, "id") !== excludeId),
      environmentHasResources: async () => false,
    };
  }

  keyContext(): OrgContext {
    const asKey = (r: ApiRow) => ({
      id: val(r, "id") as number,
      uuid: val(r, "uuid") as string,
      name: val(r, "name") as string,
      description: val(r, "description") as string | null,
      is_git_related: false,
      fingerprint: val(r, "fingerprint") as string | null,
      private_key: val(r, "private_key") as string,
      created_at: CLOCK,
      updated_at: CLOCK,
    });
    const inUse = (id: unknown) => this.servers.some((s) => val(s, "private_key_id") === id);
    const store: PrivateKeyStore = {
      list: async () => this.keys.map((r) => ({ ...asKey(r), in_use: inUse(val(r, "id")) })),
      findByUuid: async (uuid) => {
        const r = this.keys.find((k) => val(k, "uuid") === uuid);
        return r ? asKey(r) : null;
      },
      insert: async (k) => {
        const row = make("private_keys", { id: this.id("private_keys"), uuid: k.uuid, name: k.name, description: k.description, private_key: k.privateKey, fingerprint: k.fingerprint });
        this.keys.push(row);
        return asKey(row);
      },
      update: async (id, changes) => {
        const row = this.keys.find((k) => val(k, "id") === id);
        if (!row) return null;
        set(row, "name", changes.name);
        set(row, "description", changes.description);
        if (changes.privateKey) {
          set(row, "private_key", changes.privateKey.ciphertext);
          set(row, "fingerprint", changes.privateKey.fingerprint);
        }
        return asKey(row);
      },
      delete: async (id) => {
        this.keys = this.keys.filter((k) => val(k, "id") !== id);
        return true;
      },
      fingerprintExists: async (fp, excludeId) => fp !== null && this.keys.some((k) => val(k, "fingerprint") === fp && val(k, "id") !== excludeId),
      isInUse: async (id) => inUse(id),
      usages: async () => ({ counts: {}, matches: 0, rows: [] }),
    };
    return { store, cipher: { encrypt: async (p) => `enc:${p}`, decrypt: async (s) => (s.startsWith("enc:") ? s.slice(4) : Promise.reject(new Error("not ours"))) } };
  }

  runners(allow = true): ApiV1Runners {
    return {
      projects: async (_e, _o, fn) => fn(this.projectStore()),
      keys: async (_e, _o, fn) => fn(this.keyContext()),
      rows: async (_e, _o, fn) => fn(async (table, where, params) => this.rows(table, where, params)),
      allows: async () => allow,
    };
  }
}

const tokenOf = (key: string): FixtureToken => CASES.fixture.tokens.find((t) => t.key === key)!;
const userPublic = (id: number) => `usr_${String(id).padStart(32, "0")}`;

/** The request api-edge forwards for a fixture case. */
function forwarded(c: Case): Request {
  const t = tokenOf(c.token!);
  const headers = new Headers({
    [API_V1_HEADERS.org]: ORG,
    [API_V1_HEADERS.user]: userPublic(t.user),
    [API_V1_HEADERS.abilities]: t.abilities.join(","),
    [API_V1_HEADERS.canReadSensitive]: (t.abilities.includes("root") || t.abilities.includes("read:sensitive")) && isAdmin(t.user) ? "1" : "0",
    "x-actor-subject-id": userPublic(t.user),
    "x-actor-subject-type": "user",
  });
  let body: string | undefined;
  if (c.raw !== undefined) {
    body = c.raw;
    headers.set("content-type", c.contentType ?? "application/json");
  } else if (c.body !== undefined) {
    body = JSON.stringify(c.body);
    headers.set("content-type", "application/json");
  }
  const [path, query] = c.path.slice("/api/v1".length).split("?");
  return new Request(`https://deploy-core.internal/v1/internal/api-v1/${ORG}${path}${query ? `?${query}` : ""}`, { method: c.method, headers, ...(body !== undefined && { body }) });
}

async function replay(c: Case, org?: MemoryOrg): Promise<{ status: number; body: string; org: MemoryOrg }> {
  const m = org ?? (await MemoryOrg.fromFixture());
  const req = forwarded(c);
  const path = new URL(req.url).pathname.replace(`/v1/internal/api-v1/${ORG}`, "");
  const res = await handleApiV1(req, env, "req_test", { subjectId: userPublic(tokenOf(c.token!).user), subjectType: "user" }, ORG_UUID, ORG, path, m.runners());
  return { status: res.status, body: await res.text(), org: m };
}

/** The cases whose answer the controllers give (the others are the middleware's: tests/api-edge). */
const MIDDLEWARE_ANSWERS = new Set(["servers: validate with a read token", "keys: list, member with read:sensitive"]);
/** Operations not ported: Freeploy answers Coolify's fallback 404 (DP-70's note lists them). */
const NOT_PORTED = new Set(["servers: show with resources", "servers: resources", "servers: domains"]);
/** Departures: Freeploy's answer differs from Coolify's on purpose (DP-70's note). */
const DEPARTURES: Record<string, { status: number; body: string }> = {
  // ValidateServer runs over SSH; Freeploy's convention until the executor exists.
  "servers: validate": { status: 501, body: '{"message":"Validating the server needs the SSH executor, which is not available yet."}' },
};

const OPERATION_CASES = CASES.cases.filter((c) => /^(projects|environments|keys|servers): /.test(c.name) && c.token && !MIDDLEWARE_ANSWERS.has(c.name));

describe("the goldens", () => {
  it("cover every ported operation group", () => {
    expect(OPERATION_CASES.length).toBeGreaterThanOrEqual(60);
    expect(GOLDENS.version).toBe("4.7.6");
  });

  it("are written back byte for byte by phpJsonEncode (the encoder is PHP's json_encode)", () => {
    for (const g of GOLDENS.cases.flatMap((c) => (c.steps ? c.steps : [c]))) {
      const text = g.body.json;
      if (!text || text.startsWith("{\n")) continue; // Laravel's pretty-printed exception renders
      expect(phpJsonEncode(fromJs(JSON.parse(text)))).toBe(text);
    }
  });
});

describe("Freeploy answers as Coolify does", () => {
  it.each(OPERATION_CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const g = golden(name);
    const got = await replay(c);
    if (NOT_PORTED.has(name)) {
      expect({ status: got.status, body: got.body }).toEqual({ status: 404, body: '{"message":"Not found.","docs":"https:\\/\\/coolify.io\\/docs"}' });
      return;
    }
    if (DEPARTURES[name]) {
      expect({ status: got.status, body: got.body }).toEqual(DEPARTURES[name]);
      return;
    }
    expect(got.status).toBe(g.status);
    if (g.body.json !== undefined) expect(maskedJson(got.body)).toBe(maskedJson(g.body.json));
    else expect(got.body).toBe(g.body.text);
  });
});

describe("what a write leaves behind", () => {
  it("creates a project with its production environment, trimmed, with a null description", async () => {
    const got = await replay(CASES.cases.find((c) => c.name === "projects: create, trimmed")!);
    expect(got.status).toBe(201);
    const p = got.org.projects.find((r) => val(r, "name") === "Spaced")!;
    expect(val(p, "description")).toBeNull();
    expect(got.org.environments.filter((e) => val(e, "project_id") === val(p, "id")).map((e) => val(e, "name"))).toEqual(["production"]);
  });

  it("lower-cases a new environment's name as Coolify's mutator does", async () => {
    const got = await replay(CASES.cases.find((c) => c.name === "environments: create, mixed case")!);
    expect(got.org.environments.filter((e) => val(e, "project_id") === 1).map((e) => val(e, "name"))).toEqual(["production", "staging", "preview env"]);
  });

  it("deletes an unused key and keeps one a server uses", async () => {
    const del = await replay(CASES.cases.find((c) => c.name === "keys: delete")!);
    expect(del.org.keys.map((k) => val(k, "uuid"))).toEqual(["k1parityprivatekey000001"]);
  });
});

describe("authorization", () => {
  it("answers Laravel's 403 when policy-worker denies the token's user", async () => {
    const m = await MemoryOrg.fromFixture();
    const c = CASES.cases.find((x) => x.name === "projects: show")!;
    const req = forwarded(c);
    const res = await handleApiV1(req, env, "r", { subjectId: "usr_1", subjectType: "user" }, ORG_UUID, ORG, "/projects/p1alphaprojectuuid000001", m.runners(false));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('{"message":"This action is unauthorized."}');
  });

  it("is mounted on deploy-core-worker's router only for an org id and an actor", async () => {
    const res = await route(new Request(`https://x/v1/internal/api-v1/${ORG}/projects`), env);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('{"message":"Unauthenticated."}');
  });

  it("answers Coolify's fallback for a path it does not serve", async () => {
    const m = await MemoryOrg.fromFixture();
    const res = await handleApiV1(new Request("https://x/"), env, "r", { subjectId: "usr_1", subjectType: "user" }, ORG_UUID, ORG, "/hetzner/locations", m.runners());
    expect(res.status).toBe(404);
  });
});
