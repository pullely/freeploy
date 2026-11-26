// The deploy canvas's model (DP-94, the Git step's GitHub app access DP-95): the step types, the flow rules (canFollow, the plan of each resource
// line), what is stored and what is not, the environment that opened the canvas, the checks before a run
// (validate()) and the plan sent to …/deploy/canvas/run, the option lists and the logos. The expectations
// follow Coolify 91b7e3e's resources/js/deploy-canvas.test.js; splitImage, parseEnvVars and domainList
// run on the server (tests/deploy-core-worker's deploy-canvas.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TYPES,
  canFollow,
  fresh,
  lists,
  loaderKey,
  logoOf,
  onlyOption,
  planBody,
  planOf,
  resourceHref,
  restoredFlow,
  setDeployCanvasCalls,
  setServiceCatalogue,
  shortLabel,
  targetFrom,
  uniqueLabels,
  validate,
  withDeploy,
  withoutSecrets,
  withTarget,
  type Flow,
  type FlowNode,
  type StepType,
} from "../src/lib/deploy-canvas.ts";
import { freeSpot } from "../src/lib/environment-canvas.ts";

// Start → Server → (Service, Dockerfile → Env), and the one Deploy step.
const node = (id: string, type: StepType, data: Record<string, string> = {}): FlowNode => ({ id, type, x: 0, y: 0, data });
const fanOut = (): Flow => ({
  nodes: [node("start", "start"), node("srv", "server"), node("svc", "service", { mode: "template", type: "umami" }), node("df", "dockerfile"), node("env", "env"), node("dep", "deploy")],
  edges: [
    { from: "start", to: "srv" },
    { from: "srv", to: "svc" },
    { from: "srv", to: "df" },
    { from: "df", to: "env" },
  ],
});

test("plans one line per resource under a server, each ending at its last step", () => {
  const plan = planOf(fanOut());
  assert.equal(plan.deploy?.id, "dep");
  assert.deepEqual(
    plan.lines.map((l) => [l.server.id, l.source.id, l.settings.map((n) => n.id), l.end.id]),
    [
      ["srv", "svc", [], "svc"],
      ["srv", "df", ["env"], "env"],
    ],
  );
});

test("adds the deploy step to a flow without one and drops edges into it", () => {
  const flow = withDeploy({
    nodes: [node("start", "start"), node("srv", "server"), node("img", "image"), node("old", "deploy")],
    edges: [
      { from: "start", to: "srv" },
      { from: "srv", to: "img" },
      { from: "img", to: "old" },
    ],
  });
  assert.deepEqual(flow.edges, [
    { from: "start", to: "srv" },
    { from: "srv", to: "img" },
  ]);
  assert.equal(flow.nodes.filter((n) => n.type === "deploy").length, 1);
  const empty = withDeploy({ nodes: [node("start", "start")], edges: [] });
  assert.equal(empty.nodes.filter((n) => n.type === "deploy").length, 1);
});

test("allows only steps that fit after a step", () => {
  const flow = fanOut();
  const byId = (id: string) => flow.nodes.find((n) => n.id === id)!;
  assert.equal(canFollow(byId("srv"), "image", null, flow), true);
  assert.equal(canFollow(byId("start"), "image", null, flow), false);
  assert.equal(canFollow(byId("env"), "deploy", byId("dep"), flow), false); // Deploy is connected on its own
  assert.equal(canFollow(byId("svc"), "build", null, flow), false); // build settings are for git only
  assert.equal(canFollow(byId("svc"), "domain", null, flow), false); // domains are for applications
  assert.equal(canFollow(byId("svc"), "env", null, flow), true);
  assert.equal(canFollow(byId("dep"), "env", null, flow), false);
});

test("refuses a link that would make a loop", () => {
  const flow = fanOut();
  flow.nodes.push(node("env2", "env"));
  flow.edges.push({ from: "env", to: "env2" });
  const byId = (id: string) => flow.nodes.find((n) => n.id === id)!;
  assert.equal(canFollow(byId("env2"), "env", byId("env"), flow), false);
});

test("numbers resources that would have the same name; a tab shows the part after the step's title", () => {
  const names = uniqueLabels([node("a", "image", { image: "nginx" }), node("b", "image", { image: "nginx" }), node("c", "service", { mode: "template", type: "umami" })]);
  assert.deepEqual([...names.values()], ["Docker image · nginx #1", "Docker image · nginx #2", "Service · umami"]);
  assert.equal(shortLabel("Docker image · nginx #2"), "nginx #2");
  assert.equal(shortLabel("Steps"), "Steps");
});

test("keeps secrets out of the stored flow", () => {
  const flow: Flow = {
    nodes: [
      node("env", "env", { vars: "TOKEN=abc" }),
      node("svc", "service", { mode: "compose", compose: "services: {}", name: "web" }),
      node("git", "git", { repository: "https://user:tok@github.com/a/b", branch: "main" }),
      node("pub", "git", { repository: "https://github.com/a/b" }),
    ],
    edges: [],
  };
  const stored = withoutSecrets(flow);
  assert.deepEqual(
    stored.nodes.map((n) => n.data),
    [{}, { mode: "compose", name: "web" }, { branch: "main" }, { repository: "https://github.com/a/b" }],
  );
  assert.equal(flow.nodes[0]!.data.vars, "TOKEN=abc"); // the open canvas keeps them
});

test("restores a stored flow: steps of known types and their edges only", () => {
  assert.equal(restoredFlow(null), null);
  assert.equal(restoredFlow({ nodes: [], edges: [] }), null); // no Start
  const flow = restoredFlow({
    nodes: [{ id: "start", type: "start", x: 1, y: 2, data: { project: "p" } }, { id: "x", type: "rocket", x: 0, y: 0, data: {} }, { id: "srv", type: "server", x: "5", y: 6 }],
    edges: [
      { from: "start", to: "srv" },
      { from: "srv", to: "x" },
    ],
  })!;
  assert.deepEqual(flow, {
    nodes: [
      { id: "start", type: "start", x: 1, y: 2, data: { project: "p" } },
      { id: "srv", type: "server", x: 5, y: 6, data: {} },
    ],
    edges: [{ from: "start", to: "srv" }],
  });
});

test("reads the environment that opened the canvas from the query string", () => {
  assert.deepEqual(targetFrom("?project=p1a2&environment=e_3-x"), { project: "p1a2", environment: "e_3-x" });
  assert.equal(targetFrom(""), null);
  assert.equal(targetFrom("?project=p1a2"), null);
  assert.equal(targetFrom("?project=../servers&environment=e1"), null);
  assert.equal(targetFrom("?project=p1&environment="), null);
});

test("points the Start step of a restored flow at the opening environment", () => {
  const flow: Flow = {
    nodes: [node("start", "start", { project: "old", environment: "old-env" }), node("srv", "server", { server: "s1" })],
    edges: [{ from: "start", to: "srv" }],
  };
  withTarget(flow, { project: "p1", environment: "e1" });
  assert.deepEqual(
    flow.nodes.map((n) => n.data),
    [{ project: "p1", environment: "e1" }, { server: "s1" }],
  );
  assert.deepEqual(withTarget(flow, null).nodes[0]!.data, { project: "p1", environment: "e1" });
});

test("a new canvas starts with a Server step connected to Start", () => {
  const plan = planOf(fresh());
  assert.deepEqual(
    plan.servers.map((n) => n.id),
    ["server"],
  );
  assert.equal(plan.deploy?.type, "deploy");
  assert.deepEqual(plan.lines, []);
});

test("selects the only option, and only when nothing is selected", () => {
  assert.equal(onlyOption([["srv-1", "localhost"]], ""), "srv-1");
  assert.equal(onlyOption([["srv-1", "localhost"]], undefined), "srv-1");
  assert.equal(onlyOption([["srv-1", "localhost"]], "srv-old"), "srv-old");
  assert.equal(
    onlyOption(
      [
        ["srv-1", "a"],
        ["srv-2", "b"],
      ],
      "",
    ),
    "",
  );
  assert.equal(onlyOption([], ""), "");
  assert.equal(onlyOption(null, ""), ""); // still loading
});

test("keeps a dragged card off the other cards", () => {
  const other = { x: 0, y: 0, w: 100, h: 100 };
  const free = { x: 300, y: 0, w: 100, h: 100 };
  assert.deepEqual(freeSpot(free, [other]), free);
  assert.deepEqual(freeSpot({ x: 90, y: 10, w: 100, h: 100 }, [other], 16), { x: 116, y: 10, w: 100, h: 100 });
  assert.deepEqual(freeSpot({ x: 5, y: 80, w: 100, h: 100 }, [other], 16), { x: 5, y: 116, w: 100, h: 100 });
});

test("shows the logo of what a source step creates, like the rest of Freeploy", () => {
  const src = (type: StepType, data: Record<string, string>) => logoOf(node("n", type, data))?.src ?? null;
  assert.equal(src("image", {}), "/svgs/resources/docker-image.svg");
  assert.equal(src("dockerfile", {}), "/svgs/resources/dockerfile.svg");
  assert.equal(src("database", { engine: "postgresql" }), "/svgs/resources/postgres.svg");
  assert.equal(src("database", { engine: "mysql" }), "/svgs/resources/mysql.svg");
  assert.equal(logoOf(node("n", "database", { engine: "keydb" }))!.dark, "/svgs/resources/keydb-dark.svg");
  assert.equal(src("database", { engine: "sqlite" }), "/svgs/resources/sqlite.svg");
  assert.equal(src("git", { mode: "public", buildPack: "railpack" }), "/svgs/resources/public-repo.svg");
  assert.equal(src("git", { mode: "key", buildPack: "railpack" }), "/svgs/resources/deploy-key.svg");
  assert.equal(src("git", { mode: "public", buildPack: "dockerfile" }), "/svgs/resources/dockerfile.svg");
  assert.equal(src("service", { mode: "compose" }), "/svgs/resources/docker-compose.svg");
  // A template's logo comes from the page's data, with its fallback.
  setServiceCatalogue([["umami", "Umami"]], { umami: ["/svgs/umami.svg", "/svgs/default.webp"] });
  assert.deepEqual(logoOf(node("n", "service", { mode: "template", type: "umami" })), { src: "/svgs/umami.svg", dark: null, fallback: "/svgs/default.webp", padded: true });
  assert.equal(src("service", { mode: "template", type: "unknown" }), null);
  // No engine or template yet, or a step that creates nothing: the step keeps its glyph.
  assert.equal(src("database", {}), null);
  assert.equal(src("server", {}), null);
  setServiceCatalogue([], {});
});

test("offers every database engine of the New resource page; the Git step offers Public, GitHub app and Deploy key", () => {
  const engines = TYPES.database.fields.find((f) => f.key === "engine")!.options!.map(([value]) => value);
  assert.deepEqual(engines, ["postgresql", "mysql", "mariadb", "mongodb", "redis", "keydb", "dragonfly", "clickhouse", "sqlite"]);
  const modes = TYPES.git.fields.find((f) => f.key === "mode")!.options!;
  assert.deepEqual(modes, [
    ["public", "Public"],
    ["github", "GitHub app"],
    ["key", "Deploy key"],
  ]);
  // Coolify's fields, in its order; each mode shows its own.
  assert.deepEqual(
    TYPES.git.fields.map((f) => f.key),
    ["mode", "repository", "ghApp", "ghRepo", "key", "branch", "ghBranch", "buildPack", "ports", "name"],
  );
  const shown = (mode: string) => TYPES.git.fields.filter((f) => !f.show || f.show({ mode })).map((f) => f.key);
  assert.deepEqual(shown("github"), ["mode", "ghApp", "ghRepo", "ghBranch", "buildPack", "ports", "name"]);
  assert.deepEqual(shown("key"), ["mode", "repository", "key", "branch", "buildPack", "ports", "name"]);
  assert.deepEqual(shown("public"), ["mode", "repository", "branch", "buildPack", "ports", "name"]);
  // A GitHub App's card shows the GitHub App logo, its label the repository.
  assert.equal(logoOf(node("g", "git", { mode: "github" }))?.src.endsWith("github-app.svg"), true);
  assert.deepEqual([...uniqueLabels([node("g", "git", { mode: "github", ghRepo: "acme/web" })]).values()], ["Git repository · acme/web"]);
});

test("GitHub app access: validate() asks for the App, the repository and the branch; the plan carries them as picked", () => {
  const flow = (data: Record<string, string>): Flow => ({
    nodes: [node("start", "start", { project: "p", environment: "e" }), node("srv", "server", { server: "s" }), node("git", "git", { mode: "github", buildPack: "railpack", ...data }), node("dep", "deploy")],
    edges: [
      { from: "start", to: "srv" },
      { from: "srv", to: "git" },
    ],
  });
  assert.deepEqual(validate(planOf(flow({}))), { problems: ["Git repository: fill in GitHub app, Repository, Branch."], invalid: ["git"] });
  assert.deepEqual(validate(planOf(flow({ ghApp: "3|j3", ghRepo: "acme/web" }))).problems, ["Git repository: fill in Branch."]);
  const picked = { ghApp: "3|j3parityrsaapp0000000003", ghRepo: "acme/web", ghBranch: "main" };
  assert.deepEqual(validate(planOf(flow(picked))), { problems: [], invalid: [] });
  assert.deepEqual(planBody("deploy", planOf(flow(picked))).plan.lines[0]!.source, { id: "git", type: "git", data: { mode: "github", buildPack: "railpack", ...picked } });
});

test("GitHub app access: the Apps, an App's repositories and a repository's branches load through the canvas's calls", async () => {
  const asked: string[] = [];
  setDeployCanvasCalls({
    list: async (path) => {
      asked.push(path);
      if (path === "/github-apps") return [["3|j3parityrsaapp0000000003", "RSA App"]];
      if (path.endsWith("/branches")) return [["main", "main"]];
      return [["acme/web", "acme/web"]];
    },
    create: async () => ({ uuid: "new" }),
  });
  const field = (key: string) => TYPES.git.fields.find((f) => f.key === key)!;
  const [app, repo, branch] = [field("ghApp"), field("ghRepo"), field("ghBranch")];
  const picked = { mode: "github", ghApp: "3|j3parityrsaapp0000000003", ghRepo: "acme/web" };
  assert.equal(app.load!({ mode: "github" }), null);
  // Each list waits for the field above it.
  assert.equal(repo.load!({ mode: "github" }), undefined);
  assert.equal(branch.load!({ mode: "github", ghApp: picked.ghApp }), undefined);
  assert.equal(repo.load!(picked), null);
  assert.equal(branch.load!(picked), null);
  await new Promise((r) => setTimeout(r, 0));
  // The App's id names it in the repositories and branches routes; the repository is two segments.
  assert.deepEqual(asked, ["/github-apps", "/github-apps/3/repositories", "/github-apps/3/repositories/acme/web/branches"]);
  assert.deepEqual(app.load!({}), [["3|j3parityrsaapp0000000003", "RSA App"]]);
  assert.deepEqual(repo.load!(picked), [["acme/web", "acme/web"]]);
  assert.deepEqual(branch.load!(picked), [["main", "main"]]);
  assert.equal(loaderKey(app, picked), "gh");
  assert.equal(loaderKey(repo, picked), "repos:3|j3parityrsaapp0000000003");
  assert.equal(loaderKey(branch, picked), "br:3|j3parityrsaapp0000000003:acme/web");
  // The App and the repository reload what follows them.
  assert.equal(app.rerender, true);
  assert.equal(repo.rerender, true);
  setDeployCanvasCalls(null);
  lists.cache = {};
  lists.errors = {};
});

test("validate(): Coolify's problems in order, and the steps to mark", () => {
  assert.deepEqual(validate(planOf({ nodes: [node("start", "start", { project: "p", environment: "e" }), node("dep", "deploy")], edges: [] })).problems, ["Connect a Server right after Start."]);
  assert.deepEqual(validate(planOf(fresh())).problems, [
    "Connect a source step (Git repository, Docker image, Dockerfile, Service or Database) to a Server.",
    "Start: fill in Project, Environment.",
    // The Server is not checked before a line goes through it.
  ]);
  const flow: Flow = {
    nodes: [node("start", "start", { project: "p", environment: "e" }), node("srv", "server", { server: "s" }), node("git", "git", { mode: "key", repository: "git@x:y/z", branch: " ", buildPack: "railpack" }), node("svc", "service", { mode: "compose" }), node("dep", "deploy")],
    edges: [
      { from: "start", to: "srv" },
      { from: "srv", to: "git" },
      { from: "srv", to: "svc" },
    ],
  };
  assert.deepEqual(validate(planOf(flow)), { problems: ["Git repository: fill in Deploy key, Branch.", "Service: fill in docker-compose.yml."], invalid: ["git", "svc"] });
});

test("the plan sent to …/deploy/canvas/run: each step's id, type and fields, the lines by their Server's id", () => {
  const flow = fanOut();
  flow.nodes[0]!.data = { project: "p", environment: "e" };
  assert.deepEqual(planBody("save", planOf(flow)), {
    action: "save",
    plan: {
      start: { id: "start", type: "start", data: { project: "p", environment: "e" } },
      servers: [{ id: "srv", type: "server", data: {} }],
      lines: [
        { server: "srv", source: { id: "svc", type: "service", data: { mode: "template", type: "umami" } }, settings: [] },
        { server: "srv", source: { id: "df", type: "dockerfile", data: {} }, settings: [{ id: "env", type: "env", data: {} }] },
      ],
      deploy: { id: "dep", type: "deploy", data: {} },
    },
  });
});

test("a created resource opens on its page", () => {
  assert.equal(resourceHref({ project: "p", environment: "e", resource: { kind: "database", uuid: "d" } }), "/project/p/environment/e/database/d");
  assert.equal(resourceHref({ project: "p", environment: "e", resource: { kind: "application", uuid: "a" } }), "/project/p/environment/e/application/a");
});

test("the option lists load once through the canvas's calls; a failure is the select's error", async () => {
  const asked: string[] = [];
  let changes = 0;
  lists.onChange = () => changes++;
  setDeployCanvasCalls({
    list: async (path) => {
      asked.push(path);
      if (path === "/security/keys") throw new Error("Not found");
      return [["p1", "Alpha"]];
    },
    create: async () => ({ uuid: "new" }),
  });
  const project = TYPES.start.fields[0]!;
  const environment = TYPES.start.fields[1]!;
  const key = TYPES.git.fields.find((f) => f.key === "key")!;
  assert.equal(project.load!({}), null); // loading
  assert.equal(environment.load!({}), undefined); // the field above is empty
  assert.equal(environment.load!({ project: "p1" }), null);
  assert.equal(key.load!({}), null);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(project.load!({}), [["p1", "Alpha"]]);
  assert.deepEqual(asked, ["/projects", "/projects/p1/environments", "/security/keys"]);
  assert.equal(lists.errors[loaderKey(key, {})!], "Not found");
  assert.equal(loaderKey(environment, { project: "p1" }), "envs:p1");
  assert.equal(changes, 3);
  assert.equal(await project.add!.create("Gamma", {}), "new");
  setDeployCanvasCalls(null);
  lists.cache = {};
  lists.errors = {};
});
