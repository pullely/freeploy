// Coolify's /canvas/api GET routes (DP-119): the JSON its canvases fetch with the browser session, served by the console
// at /v1/organizations/{org}/deploy/canvas/api/…. Ten are answered by Coolify's /api/v1 controllers: their bodies are
// replayed here against Coolify's real answers of the same controllers (fixtures/api/goldens.json, the cases of a `read`
// token — UseSessionTeamApiToken's admin token without read:sensitive, the departure), each request going through the
// console endpoint over the API goldens' fixture in PGlite (api-v1-database.ts), its `data` compared byte for byte
// after the masking both sides share and its GitHub requests compared with Coolify's. The environment canvas's is
// DP-91's payload, found by name or uuid as EnvironmentCanvasController::findEnvironment() finds it; the other ten are
// DP-98's (canvas-views.test.ts). Then: authorization (deploy.resource.read; a denial is a 404 that runs nothing),
// org isolation and the routing of all 21 paths. Each case is rolled back.
import type { Env } from "@deploy-core-worker/env";
import { route } from "@deploy-core-worker/router";
import { handleCanvasApi, canvasApiV1Path, type CanvasApiDeps } from "@deploy-core-worker/handlers/canvas-api";
import { sqlStore as projectStore } from "@deploy-core-worker/handlers/projects";
import { sqlCipher as keyCipher, sqlStore as keyStore } from "@deploy-core-worker/handlers/private-keys";
import type { ApiV1Runners } from "@deploy-core-worker/api-v1/handler";
import type { ApplicationRunner } from "@deploy-core-worker/handlers/applications";
import type { CanvasViewsRunner } from "@deploy-core-worker/handlers/canvas-views";
import { environmentCanvas } from "@deploy-core-worker/applications/canvas";
import type { ApplicationContext, ApplicationStore } from "@deploy-core-worker/applications/service";
import { apiRows, withOrg } from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { CASES, golden, maskedJson, type Case, type HttpRequestRecord } from "./api-v1-goldens.js";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";

const ORG_A = ORG_UUID[1]!;
const ORG_B = ORG_UUID[2]!;
const ORG_PUBLIC = "org_" + "0".repeat(31) + "a";
const actor = { subjectId: "usr_" + "0".repeat(31) + "1", subjectType: "user" };
/** emit.php's clock: the instant a GitHub App's JWT is issued at. */
const CLOCK = new Date("2026-01-01T00:00:00Z");
const META = `,"meta":{"requestId":"req_1","cursor":null}}`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

/** deploy-core-worker's bindings with policy-worker deciding as told; every action asked is recorded. */
function envWith(decide: (action: string) => boolean = () => true) {
  const asked: string[] = [];
  const env = {
    ENVIRONMENT: "test",
    DEPLOY_ENCRYPTION_KEY: TEST_KEK,
    DEPLOY_CONSOLE_URL: "http://localhost",
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const { action } = (await req.json()) as { action: string };
      asked.push(action);
      const allow = decide(action);
      return json({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
  } as unknown as Env;
  return { env, asked };
}

/** GitHub as emit.php fakes it: the case's answers (the first whose `match` fits "METHOD URL"), else a 404; every request recorded. */
function fakeFetch(c: Pick<Case, "http">, requests: HttpRequestRecord[]): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const text = typeof init?.body === "string" ? init.body : "";
    requests.push({ method, url, ...(headers.get("authorization") !== null && { authorization: headers.get("authorization")! }), ...(text !== "" && { body: JSON.parse(text) as unknown }) });
    for (const a of c.http ?? []) {
      if (new RegExp(a.match).test(`${method} ${url}`)) return new Response(a.raw !== undefined ? a.raw : JSON.stringify(a.body ?? []), { status: a.status ?? 200, headers: { "content-type": "application/json", ...a.headers } });
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
  };
}

let fixture: FixtureDatabase;
beforeAll(async () => {
  fixture = await fixtureDatabase();
}, 120_000);
afterAll(async () => fixture?.pg.close());

/** /api/v1's runners over the case's database, each in the org the handler names. */
function apiRunners(db: TransactionalSqlExecutor, fetch: typeof globalThis.fetch): Partial<ApiV1Runners> {
  return {
    sql: (_e, org, fn) => withOrg(db, org, fn),
    rows: (_e, org, fn) => withOrg(db, org, (tx) => fn((table, where, params) => apiRows(tx, table, where ?? null, params ?? []))),
    projects: (_e, org, fn) => withOrg(db, org, (tx) => fn(projectStore(tx, org))),
    keys: (_e, org, fn) => withOrg(db, org, (tx) => fn({ store: keyStore(tx, org), cipher: keyCipher(tx, org, TEST_KEK) })),
    org: async () => ({ id: ORG_PUBLIC, name: "Parity Team", createdAt: "2026-01-01T00:00:00.000Z" }),
    providers: { fetch, sleep: async () => undefined, now: () => CLOCK },
  };
}

const query = (db: TransactionalSqlExecutor, sql: string, org = ORG_A) =>
  withOrg(db, org, async (tx) => {
    await tx.execute("SET LOCAL search_path TO deploy");
    return (await tx.execute(sql)).rows;
  });

/** The console's GET of one /canvas/api path (what follows /canvas/api, as the router splits it). */
async function get(segments: string[], deps: CanvasApiDeps, { org = ORG_A, env = envWith().env, method = "GET" } = {}) {
  const url = `https://x/v1/organizations/${ORG_PUBLIC}/deploy/canvas/api/${segments.join("/")}`;
  const res = await handleCanvasApi(env, "req_1", actor, org, ORG_PUBLIC, segments, new Request(url, { method }), deps);
  return { status: res.status, text: await res.text() };
}

/** The `data` of a success, as the worker wrote it into the envelope. */
function dataOf(text: string): string {
  expect(text.startsWith(`{"data":`) && text.endsWith(META)).toBe(true);
  return text.slice(`{"data":`.length, text.length - META.length);
}

/** A golden case's path as the router hands it to the handler: what follows /api/v1, still percent-encoded. */
const segmentsOf = (c: Case) => c.path.slice("/api/v1/".length).split("?")[0]!.split("/");

// ── The /api/v1 controllers' bodies, against Coolify's ─────────────────

/** Every read-token golden of the ten routes (a `read` token: Coolify's admin canvas token without read:sensitive). */
const REPLAYED = [
  "projects: list",
  "projects: environments",
  "projects: environments of an unknown project",
  "keys: list",
  "servers: list",
  "destinations: list of a server",
  "destinations: list of unknown server",
  "destinations: list of another team's server",
  "github apps: list",
  "github apps: list, none",
  "github repositories: list",
  "github repositories: list, two pages",
  "github repositories: list, none",
  "github repositories: GitHub refuses the token",
  "github repositories: GitHub fails three times",
  "github repositories: a failure without a message",
  "github repositories: no installation token",
  "github repositories: the App has no key",
  "github repositories: unknown App",
  "github branches: list",
  "github branches: list, none",
  "github branches: a dotted owner and repository",
  "github branches: an invalid owner and repository",
  "github branches: an invalid repository",
  "github branches: GitHub does not know the repository",
  "github branches: unknown App",
  "github branches: no installation token",
  "applications: show",
  "applications: show a git application",
  "applications: show another team's",
  "applications: show unknown",
  "deployments: show",
  "deployments: show another team's",
  "deployments: show unknown",
];
const caseNamed = (name: string) => CASES.cases.find((c) => c.name === name)!;

describe("the goldens the ten /api/v1 routes are replayed against", () => {
  it("are read-token GETs of the ten controllers, each path one of the console's", () => {
    const paths = new Set<string>();
    for (const name of REPLAYED) {
      const c = caseNamed(name);
      expect(c).toBeDefined();
      expect([c.method, c.token, c.sequence]).toEqual(["GET", "read", undefined]);
      const path = canvasApiV1Path(segmentsOf(c));
      expect(path).not.toBeNull();
      paths.add(path!.replace(/^\/(projects|servers|github-apps)\/[^/]+\//, "/$1/{id}/").replace(/\/(applications|deployments)\/[^/]+$/, "/$1/{uuid}").replace(/\/repositories\/[^/]+\/[^/]+\/branches$/, "/repositories/{owner}/{repo}/branches"));
    }
    expect([...paths].sort()).toEqual(
      [
        "/applications/{uuid}",
        "/deployments/{uuid}",
        "/github-apps",
        "/github-apps/{id}/repositories",
        "/github-apps/{id}/repositories/{owner}/{repo}/branches",
        "/projects",
        "/projects/{id}/environments",
        "/security/keys",
        "/servers",
        "/servers/{id}/destinations",
      ].sort(),
    );
  });
});

describe("the console's /canvas/api answers Coolify's body as its data (DP-119)", () => {
  it.each(REPLAYED.map((name) => [name, caseNamed(name)] as const))("%s", async (name, c) => {
    const g = golden(name);
    await fixture.inCase(async (db) => {
      for (const sql of [...(c.setup ?? []), ...(c.setupFreeploy ?? [])]) await query(db, sql);
      const requests: HttpRequestRecord[] = [];
      const got = await get(segmentsOf(c), { apiRunners: apiRunners(db, fakeFetch(c, requests)) });
      expect(requests).toEqual(g.requests ?? []);
      expect(got.status).toBe(g.status);
      if (g.status === 200) {
        expect(maskedJson(dataOf(got.text))).toBe(maskedJson(g.body.json!));
      } else {
        // A failure is Freeploy's error envelope with Coolify's message.
        const body = JSON.parse(got.text) as { error: { message: string } };
        expect(body.error.message).toBe((JSON.parse(g.body.json!) as { message: string }).message);
      }
    });
  });

  it("keeps no read:sensitive: the keys come without their private key, as Coolify answers a token without it", async () => {
    await fixture.inCase(async (db) => {
      const got = await get(["security", "keys"], { apiRunners: apiRunners(db, fakeFetch({}, [])) });
      const keys = JSON.parse(dataOf(got.text)) as Array<Record<string, unknown>>;
      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys) expect(k).not.toHaveProperty("private_key");
      expect(got.text).not.toContain("PRIVATE KEY");
    });
  });
});

// ── The environment canvas, by name or uuid ────────────────────────────

const PROJECT = { id: 1, uuid: "p1canvasapiproject00001", name: "Alpha" };
const ENVS = [
  { id: 10, uuid: "e1canvasapiproduction01", name: "production" },
  // An environment whose name is another's uuid: findEnvironment() asks the name first.
  { id: 11, uuid: "e2canvasapistaging00001", name: "e1canvasapiproduction01" },
];
function environmentStore(): ApplicationRunner {
  const store = {
    findProject: async (uuid: string) => (uuid === PROJECT.uuid ? PROJECT : null),
    environments: async () => ENVS,
    findEnvironment: async (_projectId: unknown, uuid: string) => ENVS.find((e) => e.uuid === uuid) ?? null,
    listForEnvironment: async () => [],
    listServiceCanvasRows: async () => [],
    listDatabasesForEnvironment: async () => [],
    // The layout's store (DP-92), empty: without one can_edit is false.
    canvas: { resources: async () => [], positions: async () => ({}), links: async () => [] },
  } as unknown as ApplicationStore;
  return (async (_env: Env, _org: string, fn: (c: ApplicationContext) => Promise<unknown>) => fn({ store } as ApplicationContext)) as ApplicationRunner;
}

describe("GET …/canvas/api/projects/{uuid}/environments/{environment_name_or_uuid}/canvas", () => {
  const canvas = ["projects", PROJECT.uuid, "environments"];

  it("answers DP-91's payload, the environment found by its name, then by its uuid", async () => {
    const applications = environmentStore();
    const { env } = envWith((action) => action === "deploy.resource.read");
    const expected = (uuid: string) => applications(env, ORG_A, (c) => environmentCanvas(c, PROJECT.uuid, uuid, false));
    const byName = await get([...canvas, "production", "canvas"], { applications }, { env });
    expect(byName.status).toBe(200);
    expect(JSON.parse(byName.text).data).toEqual(await expected("e1canvasapiproduction01"));
    expect(JSON.parse(byName.text).data).toMatchObject({ environment: { uuid: "e1canvasapiproduction01", name: "production" }, can_edit: false });
    // A name before a uuid: "e1canvasapiproduction01" names the second environment.
    const byNameFirst = await get([...canvas, "e1canvasapiproduction01", "canvas"], { applications });
    expect(JSON.parse(byNameFirst.text).data.environment).toEqual({ uuid: "e2canvasapistaging00001", name: "e1canvasapiproduction01", link: `/project/${PROJECT.uuid}/environment/e2canvasapistaging00001` });
    const byUuid = await get([...canvas, "e2canvasapistaging00001", "canvas"], { applications });
    expect(JSON.parse(byUuid.text).data.environment.uuid).toBe("e2canvasapistaging00001");
  });

  it("can_edit follows deploy.resource.write, as show() asks update on the environment", async () => {
    const { env } = envWith(() => true);
    const got = await get([...canvas, "production", "canvas"], { applications: environmentStore() }, { env });
    expect(JSON.parse(got.text).data.can_edit).toBe(true);
  });

  it("answers Coolify's 404 messages for an unknown project and environment", async () => {
    const applications = environmentStore();
    const noProject = await get(["projects", "nonexistentuuid", "environments", "production", "canvas"], { applications });
    expect([noProject.status, JSON.parse(noProject.text).error.message]).toEqual([404, "Project not found."]);
    const noEnvironment = await get([...canvas, "nonexistent", "canvas"], { applications });
    expect([noEnvironment.status, JSON.parse(noEnvironment.text).error.message]).toEqual([404, "Environment not found."]);
  });
});

// ── Authorization, org isolation, routing ──────────────────────────────

/** The 21 GET routes of Coolify's /canvas/api, as the console's paths. */
const ROUTES: string[][] = [
  ["projects"],
  ["projects", "canvas"],
  ["projects", "p1alphaprojectuuid000001", "canvas"],
  ["projects", "p1alphaprojectuuid000001", "environments"],
  ["projects", "p1alphaprojectuuid000001", "environments", "production", "canvas"],
  ["tags", "canvas"],
  ["shared-variables", "team", "canvas"],
  ["shared-variables", "project", "p1alphaprojectuuid000001", "canvas"],
  ["servers"],
  ["servers", "canvas"],
  ["dashboard", "canvas"],
  ["servers", "s1parityserveruuid000001", "canvas"],
  ["servers", "s1parityserveruuid000001", "canvas", "containers"],
  ["servers", "s1parityserveruuid000001", "canvas", "usage"],
  ["servers", "s1parityserveruuid000001", "destinations"],
  ["github-apps"],
  ["github-apps", "3", "repositories"],
  ["github-apps", "3", "repositories", "acme", "web", "branches"],
  ["security", "keys"],
  ["applications", "a1parityimageapp00000001"],
  ["deployments", "q3parityfinished00000003"],
];

/** Stores that record being opened and refuse to run. */
function recordingDeps() {
  const opened: string[] = [];
  const refuse = (what: string) => {
    opened.push(what);
    throw new Error(`${what} opened`);
  };
  const github: string[] = [];
  const apiRunners: Partial<ApiV1Runners> = {
    sql: async () => refuse("sql"),
    rows: async () => refuse("rows"),
    projects: async () => refuse("projects"),
    keys: async () => refuse("keys"),
    org: async () => refuse("org"),
    providers: { fetch: async (input) => (github.push(String(input)), json({})), sleep: async () => undefined },
  };
  const deps: CanvasApiDeps = {
    apiRunners,
    applications: (async () => refuse("applications")) as ApplicationRunner,
    canvasViews: (async () => refuse("canvasViews")) as CanvasViewsRunner,
  };
  return { deps, opened, github };
}

describe("authorization and org isolation", () => {
  it("each of the 21 routes asks deploy.resource.read; a denial is a 404 that opens no store and asks GitHub nothing", async () => {
    for (const segments of ROUTES) {
      const { env, asked } = envWith((action) => action !== "deploy.resource.read");
      const { deps, opened, github } = recordingDeps();
      const got = await get(segments, deps, { env });
      expect([segments.join("/"), got.status, JSON.parse(got.text).error.code]).toEqual([segments.join("/"), 404, "not_found"]);
      expect(asked).toContain("deploy.resource.read");
      expect(opened).toEqual([]);
      expect(github).toEqual([]);
    }
  });

  it("a reader who may not write still reads them (the ten /api/v1 routes are told the read decision, not asked again)", async () => {
    await fixture.inCase(async (db) => {
      const { env, asked } = envWith((action) => action === "deploy.resource.read");
      const got = await get(["projects"], { apiRunners: apiRunners(db, fakeFetch({}, [])) }, { env });
      expect(got.status).toBe(200);
      expect(asked.sort()).toEqual(["deploy.resource.read", "deploy.resource.write"]);
    });
  });

  it("another org sees only its own rows: org A's project, application and server are not found from org B", async () => {
    await fixture.inCase(async (db) => {
      const deps = { apiRunners: apiRunners(db, fakeFetch({}, [])) };
      const projectsA = JSON.parse(dataOf((await get(["projects"], deps)).text)) as Array<{ uuid: string }>;
      const projectsB = JSON.parse(dataOf((await get(["projects"], deps, { org: ORG_B })).text)) as Array<{ uuid: string }>;
      expect(projectsA.map((p) => p.uuid)).toContain("p1alphaprojectuuid000001");
      expect(projectsB.length).toBeGreaterThan(0);
      expect(projectsB.map((p) => p.uuid)).not.toContain("p1alphaprojectuuid000001");
      for (const p of projectsB) expect(projectsA.map((a) => a.uuid)).not.toContain(p.uuid);
      const app = await get(["applications", "a1parityimageapp00000001"], deps, { org: ORG_B });
      expect([app.status, JSON.parse(app.text).error.message]).toEqual([404, "Application not found."]);
      const destinations = await get(["servers", "s1parityserveruuid000001", "destinations"], deps, { org: ORG_B });
      expect(destinations.status).toBe(404);
      const keysB = JSON.parse(dataOf((await get(["security", "keys"], deps, { org: ORG_B })).text)) as Array<{ uuid: string }>;
      const keysA = JSON.parse(dataOf((await get(["security", "keys"], deps)).text)) as Array<{ uuid: string }>;
      for (const k of keysB) expect(keysA.map((a) => a.uuid)).not.toContain(k.uuid);
    });
  });

  it("serves only GET on the ten /api/v1 routes and the environment canvas", async () => {
    const { deps, opened } = recordingDeps();
    for (const segments of [["projects"], ["projects", "p", "environments"], ["applications", "a"], ["projects", "p", "environments", "e", "canvas"]]) {
      const got = await get(segments, deps, { method: "POST" });
      expect(got.status).toBe(405);
    }
    expect(opened).toEqual([]);
  });
});

describe("routing: every /canvas/api GET route reaches deploy-core-worker's handler", () => {
  // Without a database binding, a route that reached its handler answers authorizeDeploy()'s 503; an unknown path a 404.
  const env = { ENVIRONMENT: "test" } as unknown as Env;
  const send = (path: string) =>
    route(new Request(`https://x/v1/organizations/${ORG_PUBLIC}/deploy/canvas/api/${path}`, { headers: { "x-actor-subject-id": actor.subjectId, "x-actor-subject-type": "user" } }), env);

  it.each(ROUTES.map((s) => [s.join("/")]))("%s", async (path) => {
    const res = await send(path);
    expect(res.status).toBe(503);
  });

  it("an unknown path under /canvas/api is a 404", async () => {
    for (const path of ["nothing", "projects/p/environments/e/canvas/more/x", "security/tokens", "github-apps/3/branches"]) expect((await send(path)).status).toBe(404);
  });

  it("canvasApiV1Path maps the ten routes to /api/v1 and leaves DP-98's canvases alone", () => {
    expect(canvasApiV1Path(["github-apps", "3", "repositories", "acme", "web", "branches"])).toBe("/github-apps/3/repositories/acme/web/branches");
    expect(canvasApiV1Path(["servers", "canvas"])).toBeNull();
    expect(canvasApiV1Path(["projects", "canvas"])).toBeNull();
    expect(canvasApiV1Path(["servers", "s1", "canvas"])).toBeNull();
    expect(canvasApiV1Path(["projects", "p1", "canvas"])).toBeNull();
    expect(canvasApiV1Path(["deployments", "q1"])).toBe("/deployments/q1");
  });
});
