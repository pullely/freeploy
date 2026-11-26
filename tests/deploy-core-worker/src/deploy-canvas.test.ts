// The deploy canvas's endpoints (DP-94; the Git step's GitHub app access, DP-95): the page's data, the option lists and the "New project" rows, and the plan's run —
// its checks and messages (validate()), the order it creates in (runFlow()), the 501 its Deploy step meets, authorization
// (deploy.resource.write, a denial 404 that runs nothing) and org isolation. Each /api/v1 call is answered by
// deploy-core-worker's own /api/v1 handler over the API goldens' fixture in PGlite (api-v1-database.ts), each case rolled back.
import type { Env } from "@deploy-core-worker/env";
import { route } from "@deploy-core-worker/router";
import { handleDeployCanvas, deployCanvasServiceTemplates } from "@deploy-core-worker/handlers/deploy-canvas";
import { sqlStore as projectStore } from "@deploy-core-worker/handlers/projects";
import { sqlCipher as keyCipher, sqlStore as keyStore } from "@deploy-core-worker/handlers/private-keys";
import { parseEnvVars, splitImage, uniqueLabels, validatePlan, parsePlan, type PlanNode } from "@deploy-core-worker/applications/deploy-canvas";
import type { ApiV1Runners } from "@deploy-core-worker/api-v1/handler";
import { apiRows, withOrg } from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";

const ORG_A = ORG_UUID[1]!;
const ORG_B = ORG_UUID[2]!;
const ORG_PUBLIC = "org_" + "0".repeat(31) + "a";
const PROJECT = "p1alphaprojectuuid000001";
const ENVIRONMENT = "e1alphaproduction0000001";
const SERVER = "s1parityserveruuid000001";
const DESTINATION = "d1paritydestination00001";
const actor = { subjectId: "usr_" + "0".repeat(31) + "1", subjectType: "user" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

let fixture: FixtureDatabase;
beforeAll(async () => {
  fixture = await fixtureDatabase();
}, 120_000);
afterAll(async () => fixture?.pg.close());

/** An answer's JSON, read as the tests look into it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Answer = { status: number; body: { data?: Json; error?: { code: string; message: string; details?: Record<string, Json> } } };

/** GitHub, faked: the first answer whose pattern fits "METHOD URL", else GitHub's 404. */
type GithubAnswer = { match: RegExp; status?: number; body: unknown };

/** One case over the fixture: the canvas's handler for an actor who may (or may not) write, in org A (or B). */
function setup(db: TransactionalSqlExecutor, { write = true, github = [] as GithubAnswer[] } = {}) {
  const asked: string[] = [];
  /** What reached GitHub, through /api/v1's injectable fetch (ApiV1Context.providers). */
  const githubRequests: Array<{ method: string; url: string; authorization: string | null }> = [];
  const githubFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    githubRequests.push({ method, url, authorization: new Headers(init?.headers).get("authorization") });
    const answer = github.find((a) => a.match.test(`${method} ${url}`));
    if (answer) return json(answer.body, answer.status ?? 200);
    return json({ message: "Not Found" }, 404);
  };
  const env = {
    ENVIRONMENT: "test",
    DEPLOY_ENCRYPTION_KEY: TEST_KEK,
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      asked.push(body.action);
      const allow = body.action === "deploy.resource.write" ? write : true;
      return json({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
  } as unknown as Env;
  const runners: Partial<ApiV1Runners> = {
    sql: (_e, org, fn) => withOrg(db, org, fn),
    rows: (_e, org, fn) => withOrg(db, org, (tx) => fn((table, where, params) => apiRows(tx, table, where ?? null, params ?? []))),
    projects: (_e, org, fn) => withOrg(db, org, (tx) => fn(projectStore(tx, org))),
    keys: (_e, org, fn) => withOrg(db, org, (tx) => fn({ store: keyStore(tx, org), cipher: keyCipher(tx, org, TEST_KEK) })),
    org: async () => ({ id: ORG_PUBLIC, name: "Parity Team", createdAt: "2026-01-01T00:00:00.000Z" }),
    providers: { fetch: githubFetch, sleep: async () => undefined, now: () => new Date("2026-01-01T00:00:00Z") },
  };
  const send = async (method: string, segments: string[], body?: unknown, org = ORG_A): Promise<Answer> => {
    const init: RequestInit = { method, headers: { "content-type": "application/json" } };
    if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
    const url = `https://x/v1/organizations/${ORG_PUBLIC}/deploy/canvas/${segments.join("/")}`;
    const res = await handleDeployCanvas(env, "req_1", actor, org, ORG_PUBLIC, segments, new Request(url, init), { apiRunners: runners });
    return { status: res.status, body: (await res.json()) as Answer["body"] };
  };
  const query = (sql: string, params: unknown[] = [], org = ORG_A) =>
    withOrg(db, org, async (tx) => {
      await tx.execute("SET LOCAL search_path TO deploy");
      return (await tx.execute(sql, params)).rows as Array<Record<string, unknown>>;
    });
  return { send, asked, query, githubRequests };
}

const inCase = <T>(fn: (db: TransactionalSqlExecutor) => Promise<T>) => fixture.inCase(fn);

// ── The plan, as the console's planOf() sends it ─────────────────────────

const start = (data: Record<string, unknown> = { project: PROJECT, environment: ENVIRONMENT }): PlanNode => ({ id: "start", type: "start", data });
const server = (data: Record<string, unknown> = { server: SERVER }): PlanNode => ({ id: "server", type: "server", data });
const deploy: PlanNode = { id: "deploy", type: "deploy", data: {} };
const step = (id: string, type: string, data: Record<string, unknown> = {}): PlanNode => ({ id, type, data });
function plan(lines: Array<{ source: PlanNode; settings?: PlanNode[] }>, { servers = [server()], first = start() } = {}) {
  return { start: first, servers, lines: lines.map((l) => ({ server: servers[0]?.id ?? "server", source: l.source, settings: l.settings ?? [] })), deploy };
}
const image = (id = "img", data: Record<string, unknown> = {}) => step(id, "image", { image: "nginx:alpine", ports: "80", ...data });
const postgres = (id = "pg") => step(id, "database", { engine: "postgresql", image: "postgres:18-alpine", name: "main-db" });

const stepsOf = (r: Answer) => (r.body.data.steps as Array<{ id: string; label: string; state: string; message: string }>).map((s) => [s.id, s.state, s.message]);
// ApiError's message: the API's message, then its field error.
const GIT_URL_MESSAGE = "Validation failed. The git repository must start with https://, http://, git://, ssh://, or be an SSH URL (user@host:path).";
const EXECUTOR_APP = "Deploying the application needs the SSH executor, which is not available yet.";
const EXECUTOR_DB = "Starting the database needs the SSH executor, which is not available yet.";

describe("POST …/deploy/canvas/run: the order of runFlow()", () => {
  it("Save only: Start, the Server, then each line's source and settings, then the Deploy step; the resources are created in that order", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      const r = await t.send("POST", ["run"], {
        action: "save",
        plan: plan([
          { source: image("img", { name: "web" }), settings: [step("vars", "env", { vars: "NODE_ENV=production\n# a comment\nAPI='x'" }), step("dom", "domain", { domains: "https://canvas-web.example.net" })] },
          { source: postgres() },
        ]),
      });
      expect(r.status).toBe(200);
      expect(stepsOf(r)).toEqual([
        ["start", "done", "Project and environment set."],
        ["server", "done", "Server picked."],
        ["img", "done", "Application created."],
        ["vars", "done", "2 variables saved."],
        ["dom", "done", "Set at creation: https://canvas-web.example.net."],
        ["pg", "done", "Database created."],
        ["deploy", "done", "Saved 2 resources. Not deployed."],
      ]);
      expect(r.body.data.ok).toBe(true);
      expect(r.body.data.deploys).toEqual([]);
      const resources = r.body.data.resources as Array<{ source: string; kind: string; uuid: string; label: string }>;
      expect(resources.map((x) => [x.source, x.kind, x.label])).toEqual([
        ["img", "application", "Docker image · web"],
        ["pg", "database", "Database · main-db"],
      ]);
      const [app] = await t.query("SELECT uuid, name, fqdn, docker_registry_image_name, docker_registry_image_tag, ports_exposes, environment_id FROM applications WHERE uuid = $1", [resources[0]!.uuid]);
      expect(app).toMatchObject({ name: "web", fqdn: "https://canvas-web.example.net", docker_registry_image_name: "nginx", docker_registry_image_tag: "alpine", ports_exposes: "80", environment_id: 1 });
      const vars = await t.query("SELECT key FROM environment_variables WHERE resourceable_id = (SELECT id FROM applications WHERE uuid = $1) ORDER BY id", [resources[0]!.uuid]);
      expect(vars.map((v) => v.key)).toEqual(expect.arrayContaining(["NODE_ENV", "API"]));
      const [pg] = await t.query("SELECT name, image FROM standalone_postgresqls WHERE uuid = $1", [resources[1]!.uuid]);
      expect(pg).toEqual({ name: "main-db", image: "postgres:18-alpine" });
      // The application was created before the database (the lines' order).
      const [order] = await t.query("SELECT (SELECT created_at FROM applications WHERE uuid = $1) <= (SELECT created_at FROM standalone_postgresqls WHERE uuid = $2) AS first", [resources[0]!.uuid, resources[1]!.uuid]);
      expect(order!.first).toBe(true);
    });
  });

  it("Deploy: the resources are created, then each deploy meets the SSH executor's 501 and the Deploy step fails with their messages", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      const r = await t.send("POST", ["run"], { action: "deploy", plan: plan([{ source: image() }, { source: postgres() }]) });
      expect(r.status).toBe(200);
      expect(r.body.data.ok).toBe(false);
      expect(stepsOf(r).at(-1)).toEqual(["deploy", "failed", `${EXECUTOR_APP} · ${EXECUTOR_DB}`]);
      expect(r.body.data.deploys).toEqual([
        { source: "img", label: "Docker image · nginx:alpine", state: "failed", message: EXECUTOR_APP },
        { source: "pg", label: "Database · main-db", state: "failed", message: EXECUTOR_DB },
      ]);
      // Nothing was queued: no deployment row.
      expect(await t.query("SELECT 1 FROM application_deployment_queues WHERE application_id = (SELECT id::text FROM applications WHERE uuid = $1)", [r.body.data.resources[0].uuid])).toEqual([]);
    });
  });

  it("a failed step stops the run: its message is the API's, the steps after it stay Waiting, and nothing after it is created", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      const before = await t.query("SELECT count(*)::int AS n FROM standalone_postgresqls");
      const r = await t.send("POST", ["run"], { action: "deploy", plan: plan([{ source: step("git", "git", { mode: "public", repository: "not a url", branch: "main", buildPack: "railpack" }) }, { source: postgres() }]) });
      expect(r.status).toBe(200);
      const steps = stepsOf(r);
      expect(steps[2]![0]).toBe("git");
      expect(steps[2]![1]).toBe("failed");
      expect(steps[2]![2]).toBe(GIT_URL_MESSAGE);
      expect(steps.slice(3)).toEqual([
        ["pg", "", "Waiting"],
        ["deploy", "", "Waiting"],
      ]);
      expect(r.body.data.resources).toEqual([]);
      expect(await t.query("SELECT count(*)::int AS n FROM standalone_postgresqls")).toEqual(before);
    });
  });

  it("a deploy key's repository goes to private-deploy-key; Build settings change the application; an empty Build step changes nothing", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      const r = await t.send("POST", ["run"], {
        action: "save",
        plan: plan([
          {
            source: step("git", "git", { mode: "key", key: "k1parityprivatekey000001", repository: "git@github.com:coollabsio/coolify-examples.git", branch: "main", buildPack: "nixpacks", ports: "3000" }),
            settings: [step("b1", "build", { base_directory: "/app", start_command: "npm start" }), step("b2", "build", {})],
          },
        ]),
      });
      expect(stepsOf(r)).toEqual([
        ["start", "done", "Project and environment set."],
        ["server", "done", "Server picked."],
        ["git", "done", "Application created."],
        ["b1", "done", "Build settings saved."],
        ["b2", "done", "Nothing to change."],
        ["deploy", "done", "Saved 1 resource. Not deployed."],
      ]);
      const [app] = await t.query("SELECT build_pack, base_directory, start_command, private_key_id FROM applications WHERE uuid = $1", [r.body.data.resources[0].uuid]);
      expect(app).toMatchObject({ build_pack: "nixpacks", base_directory: "/app", start_command: "npm start" });
      expect(app!.private_key_id).not.toBeNull();
    });
  });

  it("a one-click Service, its variables through the services' bulk route, and a Dockerfile in base64", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      const r = await t.send("POST", ["run"], {
        action: "save",
        plan: plan([
          { source: step("svc", "service", { mode: "template", type: " uptime-kuma " }), settings: [step("vars", "env", { vars: "TZ=UTC" })] },
          { source: step("df", "dockerfile", { dockerfile: "FROM nginx:alpine\n# é\n", ports: "8080" }) },
        ]),
      });
      expect(stepsOf(r)).toEqual([
        ["start", "done", "Project and environment set."],
        ["server", "done", "Server picked."],
        ["svc", "done", "Service created."],
        ["vars", "done", "1 variable saved."],
        ["df", "done", "Application created."],
        ["deploy", "done", "Saved 2 resources. Not deployed."],
      ]);
      const [svc] = await t.query("SELECT name FROM services WHERE uuid = $1", [r.body.data.resources[0].uuid]);
      expect(String(svc!.name).length).toBeGreaterThan(0);
      const [app] = await t.query("SELECT build_pack, dockerfile, ports_exposes FROM applications WHERE uuid = $1", [r.body.data.resources[1].uuid]);
      // The Dockerfile arrives decoded, byte for byte; its port is the API's (get_port_from_dockerfile(), else 80), not the Port field.
      expect(app).toMatchObject({ build_pack: "dockerfile", dockerfile: "FROM nginx:alpine\n# é\n", ports_exposes: "80" });
    });
  });

  it("a destination picked on the Server goes in as destination_uuid", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      const r = await t.send("POST", ["run"], { action: "save", plan: plan([{ source: image() }], { servers: [server({ server: SERVER, destination: DESTINATION })] }) });
      expect(r.body.data.ok).toBe(true);
      const [app] = await t.query("SELECT destination_id FROM applications WHERE uuid = $1", [r.body.data.resources[0].uuid]);
      expect(Number(app!.destination_id)).toBe(1);
    });
  });
});

describe("POST …/deploy/canvas/run: validate()'s problems and the body's rules", () => {
  it("answers the first problem, every problem and the steps to mark; nothing runs", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      let r = await t.send("POST", ["run"], { action: "deploy", plan: plan([], { servers: [] }) });
      expect(r.status).toBe(422);
      expect(r.body.error!.message).toBe("Connect a Server right after Start.");
      r = await t.send("POST", ["run"], { action: "deploy", plan: plan([]) });
      expect(r.body.error!.message).toBe("Connect a source step (Git repository, Docker image, Dockerfile, Service or Database) to a Server.");
      r = await t.send("POST", ["run"], { action: "save", plan: plan([{ source: step("img", "image", { image: "  " }), settings: [step("vars", "env", {})] }], { first: start({ project: PROJECT }), servers: [server({})] }) });
      expect(r.status).toBe(422);
      expect(r.body.error!.message).toBe("Start: fill in Environment.");
      expect(r.body.error!.details).toEqual({
        problems: ["Start: fill in Environment.", "Server: fill in Server.", "Docker image: fill in Image.", "Environment variables: fill in Variables."],
        invalid: ["start", "server", "img", "vars"],
      });
      expect(await t.query("SELECT count(*)::int AS n FROM applications WHERE environment_id = 1 AND name LIKE 'nginx%'")).toEqual([{ n: 0 }]);
    });
  });

  it("a settings step that does not apply to its source is refused with startConnect()'s message", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      const r = await t.send("POST", ["run"], { action: "save", plan: plan([{ source: postgres(), settings: [step("vars", "env", { vars: "A=1" })] }]) });
      expect(r.status).toBe(422);
      expect(r.body.error!.message).toBe("That step cannot follow this one.");
      const r2 = await t.send("POST", ["run"], { action: "save", plan: plan([{ source: image(), settings: [step("b", "build")] }]) });
      expect(r2.body.error!.message).toBe("That step cannot follow this one.");
    });
  });

  it("the action and the plan: required, save or deploy, and a plan planOf() could build; a body that is not JSON is 400", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      expect((await t.send("POST", ["run"], { plan: plan([{ source: image() }]) })).body.error!.details).toEqual({ fields: { action: ["The action field is required."] } });
      expect((await t.send("POST", ["run"], { action: "go", plan: {} })).body.error!.details).toEqual({ fields: { action: ["The selected action is invalid."], plan: ["The plan is not valid."] } });
      // Two steps with the same id, an unknown type, a line whose Server is not the plan's.
      const twice = plan([{ source: step("server", "image", { image: "nginx" }) }]);
      expect((await t.send("POST", ["run"], { action: "save", plan: twice })).body.error!.details).toEqual({ fields: { plan: ["The plan is not valid."] } });
      expect((await t.send("POST", ["run"], { action: "save", plan: plan([{ source: step("x", "rocket") }]) })).status).toBe(422);
      // At most 100 steps in one run (Freeploy's).
      const many = plan(Array.from({ length: 98 }, (_, i) => ({ source: image(`i${i}`) })));
      expect((await t.send("POST", ["run"], { action: "save", plan: many })).body.error!.details).toEqual({ fields: { plan: ["The plan is not valid."] } });
      expect((await t.send("POST", ["run"], { action: "save", plan: { ...plan([{ source: image() }]), lines: [{ server: "other", source: image(), settings: [] }] } })).status).toBe(422);
      const bad = await t.send("POST", ["run"], "{nope");
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatchObject({ message: "Invalid request.", details: { error: "Invalid JSON." } });
    });
  });
});

describe("the page's data, the option lists and the New project rows", () => {
  it("GET …/canvas: can_add, the one-click templates by name and their logos", async () => {
    await inCase(async (db) => {
      const r = await setup(db).send("GET", []);
      expect(r.status).toBe(200);
      expect(r.body.data.can_add).toBe(true);
      const templates = r.body.data.service_templates as Array<[string, string]>;
      expect(templates).toEqual(deployCanvasServiceTemplates());
      expect(templates.length).toBeGreaterThan(100);
      const names = templates.map(([, name]) => name.toLowerCase());
      expect([...names].sort()).toEqual(names);
      expect(templates.find(([key]) => key === "n8n-with-postgresql")).toEqual(["n8n-with-postgresql", "N8N With Postgresql"]);
      const logos = r.body.data.service_logos as Record<string, [string, string]>;
      for (const [logo, fallback] of Object.values(logos)) {
        expect(logo.endsWith("default.webp")).toBe(false);
        expect(fallback).toBe("/svgs/default.webp");
      }
    });
  });

  it("the lists of deploy-canvas.js' LOADERS, as [value, label]", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      expect((await t.send("GET", ["options", "projects"])).body.data).toEqual([
        ["p1alphaprojectuuid000001", "Alpha"],
        ["p2betaprojectuuid0000002", "Beta"],
      ]);
      expect((await t.send("GET", ["options", "projects", PROJECT, "environments"])).body.data).toEqual([
        ["e1alphaproduction0000001", "production"],
        ["e2alphastaging0000000002", "staging"],
      ]);
      const servers = (await t.send("GET", ["options", "servers"])).body.data as Array<[string, string]>;
      expect(servers.map(([uuid]) => uuid)).toEqual([SERVER]);
      expect(servers[0]![1].startsWith("parity-server")).toBe(true);
      const destinations = (await t.send("GET", ["options", "servers", SERVER, "destinations"])).body.data as Array<[string, string]>;
      expect(destinations.map(([uuid]) => uuid)).toEqual([DESTINATION]);
      expect(destinations[0]![1]).toContain(" · ");
      expect((await t.send("GET", ["options", "security", "keys"])).body.data).toEqual([
        ["k1parityprivatekey000001", "Parity Key"],
        ["k2unusedprivatekey000002", "Unused Key"],
        // DP-93's fixture: team 1's GitHub App key (DP-72's RSA test key).
        ["k4paritygithubappkey0004", "GitHub App Key"],
      ]);
      // A project of another org is the API's 404.
      const other = await t.send("GET", ["options", "projects", "p3otherprojectuuid000003", "environments"]);
      expect(other.status).toBe(404);
      expect(other.body.error!.message).toBe("Project not found.");
    });
  });

  it("New project and New environment: /api/v1's create, its messages, the new uuid", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      const created = await t.send("POST", ["projects"], { name: "Gamma" });
      expect(created.status).toBe(201);
      const uuid = created.body.data.uuid as string;
      expect(await t.query("SELECT name FROM projects WHERE uuid = $1", [uuid])).toEqual([{ name: "Gamma" }]);
      const env = await t.send("POST", ["projects", uuid, "environments"], { name: "preview" });
      expect(env.status).toBe(201);
      expect(await t.query("SELECT name FROM environments WHERE uuid = $1", [env.body.data.uuid])).toEqual([{ name: "preview" }]);
      const missing = await t.send("POST", ["projects"], { name: "" });
      expect(missing.status).toBe(422);
      expect(missing.body.error!.details!.fields).toEqual({ name: ["The name field is required."] });
    });
  });
});

// ── The Git step's "GitHub app" access (DP-95) ───────────────────────────

/** DP-93's goldens' GitHub App: team 1's App 3 (App ID 1003, installation 2003), signing with private key 4. */
const GITHUB_APP = "j3parityrsaapp0000000003";
const insertApp = (id: number, uuid: string, name: string, { isPublic = false, appId = "1003" as string | null } = {}) =>
  `insert into github_apps (id, uuid, name, organization, api_url, html_url, custom_user, custom_port, app_id, installation_id, client_id, is_system_wide, is_public, private_key_id, org_id, created_at, updated_at) values (${id}, '${uuid}', '${name}', 'parity-org', 'https://api.github.com', 'https://github.com', 'git', 22, ${appId ?? "null"}, 2003, 'Iv1.parity${id}', false, ${isPublic}, 4, deploy.current_org(), '2025-12-03 00:00:00', '2025-12-03 00:00:00')`;
const TOKEN: GithubAnswer = { match: /^POST https:\/\/api\.github\.com\/app\/installations\/2003\/access_tokens$/, status: 201, body: { token: "ghs_paritytoken", expires_at: "2026-01-01T01:00:00Z" } };
const repo = (id: number, owner: string, name: string) => ({ id, name, full_name: `${owner}/${name}`, private: true, owner: { login: owner, id: 77 }, default_branch: "main" });
const PRIVATE_REPO: GithubAnswer = { match: /^GET https:\/\/api\.github\.com\/repos\/acme\/private$/, body: repo(4242, "acme", "private") };
const githubStep = (data: Record<string, unknown> = {}) =>
  step("gh", "git", { mode: "github", ghApp: `3|${GITHUB_APP}`, ghRepo: "acme/private", ghBranch: "main", buildPack: "nixpacks", ports: "3000", ...data });

describe("the Git step's GitHub app access (DP-95)", () => {
  it("lists the org's private GitHub Apps as id|uuid, leaving out public Apps and those without an App ID", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      await t.query(insertApp(3, GITHUB_APP, "RSA App"));
      await t.query(insertApp(5, "j5paritypublicapp0000005", "Public App", { isPublic: true }));
      await t.query(insertApp(6, "j6paritynoappid000000006", "Unfinished App", { appId: null }));
      const r = await t.send("GET", ["options", "github-apps"]);
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual([[`3|${GITHUB_APP}`, "RSA App"]]);
      // Another org sees none of them.
      expect((await t.send("GET", ["options", "github-apps"], undefined, ORG_B)).body.data).toEqual([]);
      expect(t.githubRequests).toEqual([]);
    });
  });

  it("an App's repositories through /api/v1's route: the installation token, every page, sorted by name, as [full_name, full_name]", async () => {
    await inCase(async (db) => {
      const t = setup(db, {
        github: [
          TOKEN,
          { match: /^GET https:\/\/api\.github\.com\/installation\/repositories\?per_page=100&page=1$/, body: { total_count: 3, repositories: [repo(11, "acme", "zeta"), repo(12, "acme", "Alpha"), repo(13, "acme", "alpha")] } },
          { match: /^GET https:\/\/api\.github\.com\/installation\/repositories\?per_page=100&page=2$/, body: { total_count: 3, repositories: [] } },
        ],
      });
      await t.query(insertApp(3, GITHUB_APP, "RSA App"));
      const r = await t.send("GET", ["options", "github-apps", "3", "repositories"]);
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual([
        ["acme/Alpha", "acme/Alpha"],
        ["acme/alpha", "acme/alpha"],
        ["acme/zeta", "acme/zeta"],
      ]);
      expect(t.githubRequests.map((q) => `${q.method} ${q.url}`)).toEqual([
        "POST https://api.github.com/app/installations/2003/access_tokens",
        "GET https://api.github.com/installation/repositories?per_page=100&page=1",
        "GET https://api.github.com/installation/repositories?per_page=100&page=2",
      ]);
      // The token request carries the App's JWT; the listing, the installation token.
      expect(t.githubRequests[0]!.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      expect(t.githubRequests[1]!.authorization).toBe("Bearer ghs_paritytoken");
    });
  });

  it("a repository's branches through /api/v1's route, as [name, name]; GitHub's failure is the API's message and status", async () => {
    await inCase(async (db) => {
      const branches = [
        { name: "main", commit: { sha: "a".repeat(40) }, protected: true },
        { name: "feature/x", commit: { sha: "b".repeat(40) }, protected: false },
      ];
      const t = setup(db, { github: [TOKEN, { match: /^GET https:\/\/api\.github\.com\/repos\/acme\/web\/branches$/, body: branches }] });
      await t.query(insertApp(3, GITHUB_APP, "RSA App"));
      const r = await t.send("GET", ["options", "github-apps", "3", "repositories", "acme", "web", "branches"]);
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual([
        ["main", "main"],
        ["feature/x", "feature/x"],
      ]);
      expect(t.githubRequests.map((q) => `${q.method} ${q.url}`)).toEqual(["POST https://api.github.com/app/installations/2003/access_tokens", "GET https://api.github.com/repos/acme/web/branches"]);
      // A repository GitHub does not know: load_branches()' message, with GitHub's status.
      const missing = await t.send("GET", ["options", "github-apps", "3", "repositories", "acme", "gone", "branches"]);
      expect(missing.status).toBe(404);
      expect(missing.body.error!.message).toBe("Error loading branches from GitHub.");
      // An App the org does not have.
      const unknown = await t.send("GET", ["options", "github-apps", "9", "repositories"]);
      expect(unknown.status).toBe(404);
      expect(unknown.body.error!.message).toBe("GitHub app not found");
    });
  });

  it("the run creates through POST /applications/private-github-app with Coolify's body: the App by uuid, the repository and branch picked", async () => {
    await inCase(async (db) => {
      const t = setup(db, { github: [TOKEN, PRIVATE_REPO] });
      await t.query(insertApp(3, GITHUB_APP, "RSA App"));
      const r = await t.send("POST", ["run"], { action: "save", plan: plan([{ source: githubStep(), settings: [step("vars", "env", { vars: "A=1" })] }]) });
      expect(r.status).toBe(200);
      expect(stepsOf(r)).toEqual([
        ["start", "done", "Project and environment set."],
        ["server", "done", "Server picked."],
        ["gh", "done", "Application created."],
        ["vars", "done", "1 variable saved."],
        ["deploy", "done", "Saved 1 resource. Not deployed."],
      ]);
      const resources = r.body.data.resources as Array<{ source: string; kind: string; uuid: string; label: string }>;
      expect(resources.map((x) => [x.source, x.kind, x.label])).toEqual([["gh", "application", "Git repository · acme/private"]]);
      // githubAppRepository(): the installation token, then the repository GitHub answers.
      expect(t.githubRequests.map((q) => `${q.method} ${q.url}`)).toEqual(["POST https://api.github.com/app/installations/2003/access_tokens", "GET https://api.github.com/repos/acme/private"]);
      const [app] = await t.query(
        "SELECT git_repository, git_branch, build_pack, ports_exposes, source_id, source_type, repository_project_id, private_key_id, environment_id FROM applications WHERE uuid = $1",
        [resources[0]!.uuid],
      );
      expect(app).toMatchObject({ git_repository: "acme/private", git_branch: "main", build_pack: "nixpacks", ports_exposes: "3000", private_key_id: null, environment_id: 1 });
      expect(Number(app!.source_id)).toBe(3);
      expect(Number(app!.repository_project_id)).toBe(4242);
      expect(String(app!.source_type)).toContain("GithubApp");
    });
  });

  it("a repository the App cannot read fails the step with the API's message and creates nothing; an App left empty is validate()'s", async () => {
    await inCase(async (db) => {
      const t = setup(db, { github: [TOKEN] });
      await t.query(insertApp(3, GITHUB_APP, "RSA App"));
      const before = await t.query("SELECT count(*)::int AS n FROM applications");
      const r = await t.send("POST", ["run"], { action: "deploy", plan: plan([{ source: githubStep() }]) });
      expect(r.status).toBe(200);
      expect(stepsOf(r).slice(2)).toEqual([
        ["gh", "failed", "Repository not found or not accessible by the GitHub App."],
        ["deploy", "", "Waiting"],
      ]);
      expect(await t.query("SELECT count(*)::int AS n FROM applications")).toEqual(before);
      const empty = await t.send("POST", ["run"], { action: "save", plan: plan([{ source: step("gh", "git", { mode: "github", buildPack: "nixpacks" }) }]) });
      expect(empty.status).toBe(422);
      expect(empty.body.error!.details!.problems).toEqual(["Git repository: fill in GitHub app, Repository, Branch."]);
      expect(empty.body.error!.details!.invalid).toEqual(["gh"]);
    });
  });
});

describe("authorization and org isolation", () => {
  it("every route asks deploy.resource.write first and answers a denial 404 that runs nothing", async () => {
    await inCase(async (db) => {
      const t = setup(db, { write: false });
      const before = await t.query("SELECT count(*)::int AS n FROM applications");
      for (const [method, segments, body] of [
        ["GET", []],
        ["GET", ["options", "projects"]],
        ["GET", ["options", "security", "keys"]],
        ["GET", ["options", "github-apps"]],
        ["GET", ["options", "github-apps", "3", "repositories"]],
        ["GET", ["options", "github-apps", "3", "repositories", "acme", "web", "branches"]],
        ["POST", ["projects"], { name: "Nope" }],
        ["POST", ["run"], { action: "save", plan: plan([{ source: image() }]) }],
      ] as Array<[string, string[], unknown?]>) {
        const r = await t.send(method, segments, body);
        expect(r.status).toBe(404);
        expect(r.body.error!.code).toBe("not_found");
      }
      expect(t.asked.every((a) => a === "deploy.resource.write")).toBe(true);
      expect(t.githubRequests).toEqual([]);
      expect(await t.query("SELECT count(*)::int AS n FROM applications")).toEqual(before);
      expect(await t.query("SELECT count(*)::int AS n FROM projects WHERE name = 'Nope'")).toEqual([{ n: 0 }]);
    });
  });

  it("in another org, the first org's project is not found and nothing is created there", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      const before = await t.query("SELECT count(*)::int AS n FROM applications", [], ORG_B);
      const r = await t.send("POST", ["run"], { action: "save", plan: plan([{ source: image() }]) }, ORG_B);
      expect(r.status).toBe(200);
      const steps = stepsOf(r);
      expect(steps[2]).toEqual(["img", "failed", "Project not found."]);
      expect(r.body.data.resources).toEqual([]);
      expect(await t.query("SELECT count(*)::int AS n FROM applications", [], ORG_B)).toEqual(before);
      expect((await t.send("GET", ["options", "projects"], undefined, ORG_B)).body.data).toEqual([["p3otherprojectuuid000003", "Other"]]);
    });
  });
});

describe("routing", () => {
  const env = {} as Env;
  const base = `https://x/v1/organizations/${ORG_PUBLIC}/deploy/canvas`;
  it("unknown paths are 404, a wrong method 405, and no actor 401, before anything is asked", async () => {
    await inCase(async (db) => {
      const t = setup(db);
      expect((await t.send("GET", ["nope"])).status).toBe(404);
      expect((await t.send("GET", ["options", "github-apps", "3"])).status).toBe(404);
      expect((await t.send("GET", ["options", "github-apps", "3", "repositories", "acme", "web"])).status).toBe(404);
      expect((await t.send("GET", ["options", "github-apps", "3", "repositories", "ac me", "web", "branches"])).status).toBe(404);
      expect((await t.send("GET", ["run"])).status).toBe(405);
      expect((await t.send("POST", ["options", "projects"])).status).toBe(405);
      expect(t.asked).toEqual([]);
    });
    expect((await route(new Request(`${base}/run`, { method: "POST" }), env)).status).toBe(401);
    // The branches list is seven segments deep (DP-95): routed to the canvas, which asks for an actor.
    expect((await route(new Request(`${base}/options/github-apps/3/repositories/acme/web/branches`), env)).status).toBe(401);
    expect((await route(new Request(`https://x/v1/organizations/nope/deploy/canvas`), env)).status).toBe(404);
  });
});

describe("the helpers of the steps", () => {
  it("splitImage, parseEnvVars, uniqueLabels and validate() as Coolify's", () => {
    expect(splitImage("nginx:alpine", "")).toEqual({ name: "nginx", tag: "alpine" });
    expect(splitImage("ghcr.io:443/a/b", "")).toEqual({ name: "ghcr.io:443/a/b", tag: "latest" });
    expect(splitImage("ghcr.io/a/b@sha256:abc", "x")).toEqual({ name: "ghcr.io/a/b", tag: "sha256-abc" });
    expect(splitImage("nginx", " 1.27 ")).toEqual({ name: "nginx", tag: "1.27" });
    expect(parseEnvVars("A=1\n\n# no\nB = \"two\"\nnovalue\nC='x=y'")).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "two" },
      { key: "C", value: "x=y" },
    ]);
    const a = image("a");
    const b = image("b");
    const c = step("c", "database", { engine: "redis" });
    expect([...uniqueLabels([a, b, c]).values()]).toEqual(["Docker image · nginx:alpine #1", "Docker image · nginx:alpine #2", "Database · redis"]);
    const p = parsePlan(plan([{ source: step("svc", "service", { mode: "compose" }) }]))!;
    expect(validatePlan(p).problems).toEqual(["Service: fill in docker-compose.yml."]);
  });
});
