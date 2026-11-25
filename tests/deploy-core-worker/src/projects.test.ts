// Projects and environments (DP-46): Coolify's rules and messages, the
// Index / AddEmpty / Show / Edit / Delete operations, and the handler's routing
// and authorization. The SQL behind the store (and its row-level security) is
// tested in tests/db.
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { handleProjects, type ProjectsRunner } from "@deploy-core-worker/handlers/projects";
import {
  compareEnvironmentNames,
  customizeEnvironmentName,
  formatCreatedAt,
  strnatcasecmp,
  type ProjectStore,
} from "@deploy-core-worker/projects/service";
import { validateNameAndDescription } from "@deploy-core-worker/projects/validation";
import type { DeployEnvironmentListRow, DeployEnvironmentRow, DeployProjectListRow, DeployProjectRow, EnvironmentChanges, ProjectChanges } from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy/projects`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const PUBLIC_ID = /^[a-z0-9]{24}$/;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

/** deploy.projects, deploy.environments and deploy.project_settings for one org, in memory. */
class MemoryStore implements ProjectStore {
  projects: DeployProjectRow[] = [];
  envs: DeployEnvironmentRow[] = [];
  settings: Array<{ project_id: string | number }> = [];
  /** Environment ids that hold a resource. */
  withResources = new Set<number>();
  private next = 1;
  private clock = 0;
  private count(environmentId: string | number) {
    return this.withResources.has(Number(environmentId)) ? 1 : 0;
  }
  private listRow(e: DeployEnvironmentRow): DeployEnvironmentListRow {
    return { ...e, resource_count: this.count(e.id) };
  }
  async list(): Promise<DeployProjectListRow[]> {
    return [...this.projects]
      .sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0))
      .map((p) => {
        const envs = this.envs.filter((e) => e.project_id === p.id);
        return { ...p, environment_count: envs.length, first_environment_uuid: envs[0]?.uuid ?? null, resource_count: envs.reduce((n, e) => n + this.count(e.id), 0) };
      });
  }
  async findByUuid(uuid: string) {
    return this.projects.find((p) => p.uuid === uuid) ?? null;
  }
  async insert(project: { uuid: string; name: string; description: string | null; productionEnvironmentUuid: string }) {
    const row: DeployProjectRow = { id: this.next++, uuid: project.uuid, name: project.name, description: project.description, created_at: "2026-11-04 10:00:00", updated_at: null };
    this.projects.push(row);
    this.settings.push({ project_id: row.id });
    const environment = await this.insertEnvironment({ projectId: row.id, uuid: project.productionEnvironmentUuid, name: "production" });
    return { project: row, environment };
  }
  async update(id: string | number, changes: ProjectChanges) {
    const row = this.projects.find((p) => p.id === id);
    if (!row) return null;
    Object.assign(row, changes);
    return row;
  }
  async delete(id: string | number) {
    const before = this.projects.length;
    this.projects = this.projects.filter((p) => p.id !== id);
    this.envs = this.envs.filter((e) => e.project_id !== id);
    this.settings = this.settings.filter((s) => s.project_id !== id);
    return this.projects.length < before;
  }
  async projectHasResources(id: string | number) {
    return this.envs.some((e) => e.project_id === id && this.count(e.id) > 0);
  }
  async environments(projectId: string | number) {
    return this.envs.filter((e) => e.project_id === projectId).map((e) => this.listRow(e));
  }
  async findEnvironment(projectId: string | number, uuid: string) {
    const e = this.envs.find((x) => x.project_id === projectId && x.uuid === uuid);
    return e ? this.listRow(e) : null;
  }
  async insertEnvironment(environment: { projectId: string | number; uuid: string; name: string; description?: string | null }) {
    const row: DeployEnvironmentRow = {
      id: this.next++,
      uuid: environment.uuid,
      name: environment.name,
      description: environment.description ?? null,
      project_id: environment.projectId,
      created_at: `2026-11-04 10:00:${String(this.clock++).padStart(2, "0")}`,
      updated_at: null,
    };
    this.envs.push(row);
    return row;
  }
  async updateEnvironment(id: string | number, changes: EnvironmentChanges) {
    const row = this.envs.find((e) => e.id === id);
    if (!row) return null;
    Object.assign(row, changes);
    return row;
  }
  async deleteEnvironment(id: string | number) {
    const before = this.envs.length;
    this.envs = this.envs.filter((e) => e.id !== id);
    return this.envs.length < before;
  }
  async environmentNameExists(projectId: string | number, name: string, excludeId?: string | number | null) {
    return this.envs.some((e) => e.project_id === projectId && e.name === name && e.id !== excludeId);
  }
  async environmentHasResources(id: string | number) {
    return this.count(id) > 0;
  }
}

type Body = { data?: Record<string, unknown>; error?: { code: string; message: string; details: { fields?: Record<string, string[]> } } };

function setup(opts: { write?: boolean; read?: boolean } = {}) {
  const store = new MemoryStore();
  const asked: string[] = [];
  const env: Env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      asked.push(body.action);
      const allow = body.action === "deploy.resource.write" ? (opts.write ?? true) : (opts.read ?? true);
      return json({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
  };
  const orgs: string[] = [];
  const runner: ProjectsRunner = async (_env, orgId, fn) => {
    orgs.push(orgId);
    return fn(store);
  };
  const call = async (method: string, path = "", body?: unknown) => {
    const segments = path.split("?")[0]!.split("/").filter(Boolean);
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleProjects(env, "req_1", actor, ORG_UUID, segments, new Request(`${BASE}${path ? `/${path}` : ""}`, init), runner);
    return { status: res.status, body: (await res.json()) as Body };
  };
  /** A project through the API; its uuid and its production environment's. */
  const project = async (name: string, description?: string) => {
    const r = await call("POST", "", description === undefined ? { name } : { name, description });
    return r.body.data as { uuid: string; environmentUuid: string };
  };
  return { store, asked, orgs, call, project, env };
}

describe("Coolify's validation rules and messages", () => {
  it("name: required, min 3, max 255, NAME_PATTERN; every failing rule in order", () => {
    const missing = validateNameAndDescription({});
    expect(!missing.ok && missing.errors).toEqual({ name: ["The name field is required."] });
    const blank = validateNameAndDescription({ name: "   ", description: "" });
    expect(!blank.ok && blank.errors).toEqual({ name: ["The name field is required."] });
    const short = validateNameAndDescription({ name: "a$" });
    expect(!short.ok && short.errors.name).toEqual([
      "The name must be at least 3 characters.",
      "The name may only contain letters (including Unicode), numbers, spaces, and these characters: - _ . / @ & ( ) # , : +",
    ]);
    const long = validateNameAndDescription({ name: "é".repeat(256) });
    expect(!long.ok && long.errors.name).toEqual(["The name may not be greater than 255 characters."]);
    const notString = validateNameAndDescription({ name: 123 });
    expect(!notString.ok && notString.errors.name).toEqual(["The name field must be a string."]);
    expect(validateNameAndDescription({ name: "Ünïcode project (prod) #1, a/b: c+d @team & co" }).ok).toBe(true);
  });

  it("description: nullable, max 255, DESCRIPTION_PATTERN; kept as the form sent it", () => {
    const none = validateNameAndDescription({ name: "abc" });
    expect(none.ok && none.input).toEqual({ name: "abc", description: null });
    const empty = validateNameAndDescription({ name: "abc", description: "" });
    expect(empty.ok && empty.input).toEqual({ name: "abc", description: "" });
    const bad = validateNameAndDescription({ name: "abc", description: "no <tags>" });
    expect(!bad.ok && bad.errors.description).toEqual([
      "The description may only contain letters (including Unicode), numbers, spaces, and common punctuation: - _ . , ! ? ( ) ' \" + = * / @ &",
    ]);
    const long = validateNameAndDescription({ name: "abc", description: "d".repeat(256) });
    expect(!long.ok && long.errors.description).toEqual(["The description may not be greater than 255 characters."]);
  });
});

describe("Environment names and order", () => {
  it("customizeName: lower case, trimmed, '/' becomes '-'", () => {
    expect(customizeEnvironmentName("  Feature/Login ")).toBe("feature-login");
    expect(customizeEnvironmentName("STAGING")).toBe("staging");
  });

  it("strnatcasecmp: digits as numbers, case folded", () => {
    expect(strnatcasecmp("img12", "img10")).toBe(1);
    expect(strnatcasecmp("img2", "img10")).toBe(-1);
    expect(strnatcasecmp("IMG2", "img2")).toBe(0);
    expect(strnatcasecmp("a", "")).toBe(1);
    expect(strnatcasecmp("", "")).toBe(0);
    expect(strnatcasecmp("abc", "abcd")).toBe(-1);
    expect(strnatcasecmp("x1.05", "x1.5")).toBe(-1);
    expect(strnatcasecmp("pr-9", "pr-10")).toBe(-1);
  });

  it("compareNames: production, staging, development, then the others in natural order", () => {
    const names = ["pr-10", "development", "qa", "Production", "pr-9", "staging"];
    expect([...names].sort(compareEnvironmentNames)).toEqual(["Production", "staging", "development", "pr-9", "pr-10", "qa"]);
  });

  it("created_at as 'M j, Y'", () => {
    expect(formatCreatedAt("2026-11-04 10:00:00")).toBe("Nov 4, 2026");
    expect(formatCreatedAt(new Date("2026-01-31T23:59:59Z"))).toBe("Jan 31, 2026");
    expect(formatCreatedAt(null)).toBe("-");
  });
});

describe("projects", () => {
  it("creates a project with a production environment and a settings row, and answers both uuids", async () => {
    const t = setup();
    const r = await t.call("POST", "", { name: "My project", description: "first" });
    expect(r.status).toBe(201);
    expect(r.body.data).toEqual({ uuid: expect.stringMatching(PUBLIC_ID), environmentUuid: expect.stringMatching(PUBLIC_ID) });
    expect(t.store.projects).toMatchObject([{ uuid: r.body.data!.uuid, name: "My project", description: "first" }]);
    expect(t.store.envs).toMatchObject([{ uuid: r.body.data!.environmentUuid, name: "production", description: null, project_id: t.store.projects[0]!.id }]);
    expect(t.store.settings).toEqual([{ project_id: t.store.projects[0]!.id }]);
    expect(t.orgs.every((o) => o === ORG_UUID)).toBe(true);
    expect(t.asked).toEqual(["deploy.resource.write"]);
  });

  it("stores '' for a description the Add form leaves out (AddEmpty's default)", async () => {
    const t = setup();
    await t.project("No description");
    expect(t.store.projects[0]!.description).toBe("");
  });

  it("answers field errors before touching the store", async () => {
    const t = setup();
    const r = await t.call("POST", "", { name: "x", description: "<b>" });
    expect(r.status).toBe(422);
    expect(r.body.error?.details.fields).toEqual({
      name: ["The name must be at least 3 characters."],
      description: ["The description may only contain letters (including Unicode), numbers, spaces, and common punctuation: - _ . , ! ? ( ) ' \" + = * / @ &"],
    });
    expect(t.orgs).toHaveLength(0);
    expect((await t.call("POST", "", undefined)).body.error?.details.fields).toEqual({ name: ["The name field is required."] });
  });

  it("lists the org's projects by name with their counts, where each card leads, and canWrite", async () => {
    const t = setup();
    const zeta = await t.project("zeta", "last");
    const alpha = await t.project("Alpha");
    await t.call("POST", `${alpha.uuid}/environments`, { name: "staging" });
    t.store.withResources.add(Number(t.store.envs.find((e) => e.uuid === zeta.environmentUuid)!.id));
    t.asked.length = 0;
    const r = await t.call("GET");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      projects: [
        { uuid: alpha.uuid, name: "Alpha", description: "", environmentCount: 2, resourceCount: 0, createdAt: "Nov 4, 2026", onlyEnvironmentUuid: null, firstEnvironmentUuid: alpha.environmentUuid },
        { uuid: zeta.uuid, name: "zeta", description: "last", environmentCount: 1, resourceCount: 1, createdAt: "Nov 4, 2026", onlyEnvironmentUuid: zeta.environmentUuid, firstEnvironmentUuid: zeta.environmentUuid },
      ],
      canWrite: true,
    });
    expect(t.asked.sort()).toEqual(["deploy.resource.read", "deploy.resource.write"]);
  });

  it("shows a project with its environments in Coolify's order, isEmpty and the @can flags", async () => {
    const t = setup();
    const p = await t.project("Shown", "d");
    for (const name of ["testing", "Development", "staging"]) await t.call("POST", `${p.uuid}/environments`, { name });
    const r = await t.call("GET", p.uuid);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ project: { uuid: p.uuid, name: "Shown", description: "d", isEmpty: true }, canUpdate: true, canDelete: true });
    expect((r.body.data!.environments as Array<{ name: string }>).map((e) => e.name)).toEqual(["production", "staging", "development", "testing"]);
    expect((r.body.data!.environments as unknown[])[0]).toEqual({ uuid: p.environmentUuid, name: "production", description: null, resourceCount: 0 });
    t.store.withResources.add(Number(t.store.envs[0]!.id));
    const busy = await t.call("GET", p.uuid);
    expect(busy.body.data).toMatchObject({ project: { isEmpty: false } });
    expect((busy.body.data!.environments as unknown[])[0]).toMatchObject({ resourceCount: 1 });
    expect((await t.call("GET", "nosuchproject")).status).toBe(404);
  });

  it("updates a project: 'Project updated.'", async () => {
    const t = setup();
    const p = await t.project("Before", "old");
    const r = await t.call("PATCH", p.uuid, { name: "After", description: "" });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ uuid: p.uuid, name: "After", description: "", message: "Project updated." });
    expect(t.store.projects[0]).toMatchObject({ name: "After", description: "" });
    const bad = await t.call("PATCH", p.uuid, { name: "" });
    expect(bad.status).toBe(422);
    expect(bad.body.error?.details.fields).toEqual({ name: ["The name field is required."] });
    expect((await t.call("PATCH", "nosuchproject", { name: "abc" })).status).toBe(404);
  });

  it("refuses to delete a project that has resources, with Coolify's message", async () => {
    const t = setup();
    const p = await t.project("Busy");
    t.store.withResources.add(Number(t.store.envs[0]!.id));
    const r = await t.call("DELETE", p.uuid);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: "conflict", message: "Project Busy has resources defined, please delete them first." });
    expect(t.store.projects).toHaveLength(1);
  });

  it("deletes an empty project with its environments and settings", async () => {
    const t = setup();
    const p = await t.project("Gone");
    const keep = await t.project("Kept");
    await t.call("POST", `${p.uuid}/environments`, { name: "staging" });
    expect((await t.call("DELETE", p.uuid)).body.data).toEqual({ deleted: true });
    expect(t.store.projects.map((x) => x.uuid)).toEqual([keep.uuid]);
    expect(t.store.envs.map((e) => e.uuid)).toEqual([keep.environmentUuid]);
    expect(t.store.settings).toHaveLength(1);
    expect((await t.call("DELETE", p.uuid)).status).toBe(404);
  });
});

describe("environments", () => {
  it("lists a project's environments", async () => {
    const t = setup();
    const p = await t.project("Listed");
    await t.call("POST", `${p.uuid}/environments`, { name: "staging" });
    const r = await t.call("GET", `${p.uuid}/environments`);
    expect(r.body.data).toEqual({
      environments: [
        { uuid: p.environmentUuid, name: "production", description: null, resourceCount: 0 },
        { uuid: expect.stringMatching(PUBLIC_ID), name: "staging", description: null, resourceCount: 0 },
      ],
      canWrite: true,
    });
    expect((await t.call("GET", "nosuchproject/environments")).status).toBe(404);
  });

  it("adds an environment with the name as Coolify stores it", async () => {
    const t = setup();
    const p = await t.project("Envs");
    const r = await t.call("POST", `${p.uuid}/environments`, { name: " Feature/Login " });
    expect(r.status).toBe(201);
    expect(r.body.data).toEqual({ uuid: expect.stringMatching(PUBLIC_ID), name: "feature-login" });
    expect(t.store.envs[1]).toMatchObject({ name: "feature-login", description: null, project_id: t.store.projects[0]!.id });
    const bad = await t.call("POST", `${p.uuid}/environments`, { name: "x" });
    expect(bad.status).toBe(422);
    expect(bad.body.error?.details.fields).toEqual({ name: ["The name must be at least 3 characters."] });
    expect((await t.call("POST", "nosuchproject/environments", { name: "staging" })).status).toBe(404);
  });

  it("refuses a second environment of the same name in the project: 'Duplicate entry found…'", async () => {
    const t = setup();
    const p = await t.project("Dup");
    const other = await t.project("Other");
    const r = await t.call("POST", `${p.uuid}/environments`, { name: "Production" });
    expect(r.status).toBe(409);
    expect(r.body.error?.message).toBe("Duplicate entry found. Please use a different name.");
    expect(t.store.envs).toHaveLength(2);
    // The same name in another project is fine.
    expect((await t.call("POST", `${other.uuid}/environments`, { name: "staging" })).status).toBe(201);
    expect((await t.call("POST", `${p.uuid}/environments`, { name: "staging" })).status).toBe(201);
  });

  it("shows an environment through its project only, with isEmpty and the @can flags", async () => {
    const t = setup();
    const p = await t.project("Shown");
    const other = await t.project("Other");
    const r = await t.call("GET", `${p.uuid}/environments/${p.environmentUuid}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      project: { uuid: p.uuid, name: "Shown" },
      environment: { uuid: p.environmentUuid, name: "production", description: null, resourceCount: 0, isEmpty: true },
      canUpdate: true,
      canDelete: true,
    });
    expect((await t.call("GET", `${other.uuid}/environments/${p.environmentUuid}`)).status).toBe(404);
    expect((await t.call("GET", `${p.uuid}/environments/nosuchenvironment`)).status).toBe(404);
    expect((await t.call("GET", `nosuchproject/environments/${p.environmentUuid}`)).status).toBe(404);
  });

  it("updates an environment's name and description; a taken name is a duplicate", async () => {
    const t = setup();
    const p = await t.project("Edit");
    const staging = (await t.call("POST", `${p.uuid}/environments`, { name: "staging" })).body.data as { uuid: string };
    const r = await t.call("PATCH", `${p.uuid}/environments/${staging.uuid}`, { name: "Pre/Prod", description: "before prod" });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ uuid: staging.uuid, name: "pre-prod", description: "before prod" });
    // Saving the same name again is not a duplicate of itself.
    expect((await t.call("PATCH", `${p.uuid}/environments/${staging.uuid}`, { name: "pre-prod", description: null })).body.data).toEqual({ uuid: staging.uuid, name: "pre-prod", description: null });
    const dup = await t.call("PATCH", `${p.uuid}/environments/${staging.uuid}`, { name: "production" });
    expect(dup.status).toBe(409);
    expect(dup.body.error?.message).toBe("Duplicate entry found. Please use a different name.");
    const bad = await t.call("PATCH", `${p.uuid}/environments/${staging.uuid}`, { name: "a!" });
    expect(bad.body.error?.details.fields?.name).toHaveLength(2);
    expect((await t.call("PATCH", `${p.uuid}/environments/nosuchenvironment`, { name: "abc" })).status).toBe(404);
  });

  it("refuses to delete an environment that has resources, with Coolify's message", async () => {
    const t = setup();
    const p = await t.project("Busy");
    t.store.withResources.add(Number(t.store.envs[0]!.id));
    const r = await t.call("DELETE", `${p.uuid}/environments/${p.environmentUuid}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: "conflict", message: "Environment production has defined resources, please delete them first." });
    expect(t.store.envs).toHaveLength(1);
  });

  it("deletes an empty environment, even the last one", async () => {
    const t = setup();
    const p = await t.project("Empty");
    expect((await t.call("DELETE", `${p.uuid}/environments/${p.environmentUuid}`)).body.data).toEqual({ deleted: true });
    expect(t.store.envs).toHaveLength(0);
    expect((await t.call("DELETE", `${p.uuid}/environments/${p.environmentUuid}`)).status).toBe(404);
    expect((await t.call("GET", p.uuid)).body.data).toMatchObject({ environments: [] });
  });
});

describe("routing and authorization", () => {
  it("405s the methods a path does not take, 404s deeper paths", async () => {
    const t = setup();
    expect((await t.call("PUT")).status).toBe(405);
    expect((await t.call("DELETE")).status).toBe(405);
    expect((await t.call("POST", "abc")).status).toBe(405);
    expect((await t.call("PATCH", "abc/environments")).status).toBe(405);
    expect((await t.call("POST", "abc/environments/def")).status).toBe(405);
    expect((await t.call("GET", "abc/settings")).status).toBe(404);
    expect((await t.call("GET", "abc/environments/def/ghi")).status).toBe(404);
    expect((await t.call("GET", "bad$uuid")).status).toBe(404);
    expect(t.asked).toHaveLength(0);
  });

  it("a reader lists and opens, with every @can flag false, and cannot write (404, never leaks)", async () => {
    const t = setup({ write: false });
    const p = await t.store.insert({ uuid: "prj1", name: "Read only", description: null, productionEnvironmentUuid: "env1" });
    expect((await t.call("GET")).body.data).toMatchObject({ canWrite: false });
    expect((await t.call("GET", "prj1")).body.data).toMatchObject({ canUpdate: false, canDelete: false });
    expect((await t.call("GET", "prj1/environments")).body.data).toMatchObject({ canWrite: false });
    expect((await t.call("GET", "prj1/environments/env1")).body.data).toMatchObject({ canUpdate: false, canDelete: false });
    for (const [method, path, body] of [
      ["POST", "", { name: "abc" }],
      ["PATCH", "prj1", { name: "abc" }],
      ["DELETE", "prj1", undefined],
      ["POST", "prj1/environments", { name: "abc" }],
      ["PATCH", "prj1/environments/env1", { name: "abc" }],
      ["DELETE", "prj1/environments/env1", undefined],
    ] as const) {
      const r = await t.call(method, path, body);
      expect([method, path, r.status]).toEqual([method, path, 404]);
    }
    expect(t.store.projects).toEqual([p.project]);
    expect(t.store.envs).toHaveLength(1);
  });

  it("404s everything when policy denies deploy.resource.read", async () => {
    const t = setup({ read: false });
    await t.store.insert({ uuid: "prj1", name: "Hidden", description: null, productionEnvironmentUuid: "env1" });
    for (const path of ["", "prj1", "prj1/environments", "prj1/environments/env1"]) expect((await t.call("GET", path)).status).toBe(404);
    expect(t.orgs).toHaveLength(0);
  });

  it("404s when the caller has no membership in the org", async () => {
    const t = setup();
    t.env.MEMBERSHIP_WORKER = fetcher(() => json({ error: { code: "not_found" } }, 404));
    expect((await t.call("GET")).status).toBe(404);
    expect((await t.call("POST", "", { name: "abc" })).status).toBe(404);
    expect(t.asked).toHaveLength(0);
  });

  it("route() sends every projects path to the handler behind the same checks", async () => {
    const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
    const bare: Env = { ENVIRONMENT: "test" };
    for (const path of ["", "/", "/prj1", "/prj1/environments", "/prj1/environments/env1", "/prj1/environments/env1/"]) {
      // No actor: 401. An org id that does not parse: 404. No bindings: 503 (the handler was reached).
      expect([path, (await route(new Request(`${BASE}${path}`), bare)).status]).toEqual([path, 401]);
      expect([path, (await route(new Request(`https://x/v1/organizations/not-an-org/deploy/projects${path}`, { headers }), bare)).status]).toEqual([path, 404]);
      expect([path, (await route(new Request(`${BASE}${path}`, { headers }), bare)).status]).toEqual([path, 503]);
    }
    expect((await route(new Request(`${BASE}/prj1/environments/env1/more`, { headers }), bare)).status).toBe(404);
    expect((await route(new Request(`${BASE}/prj1/environments/env1/more/deeper`, { headers }), bare)).status).toBe(404);
    expect((await route(new Request(`${BASE}`, { method: "PUT", headers }), bare)).status).toBe(405);
    expect((await route(new Request(`${BASE}/prj1/environments`, { method: "DELETE", headers }), bare)).status).toBe(405);
    // Through route() with bindings: the policy is asked and a denial is a 404.
    const asked: string[] = [];
    const denied = await route(new Request(`${BASE}/prj1`, { method: "DELETE", headers }), {
      ENVIRONMENT: "test",
      PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
      MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
      POLICY_WORKER: fetcher(async (req) => {
        asked.push(((await req.json()) as { action: string }).action);
        return json({ data: { decision: "deny", allow: false } });
      }),
    });
    expect(denied.status).toBe(404);
    expect(asked).toEqual(["deploy.resource.write"]);
  });
});
