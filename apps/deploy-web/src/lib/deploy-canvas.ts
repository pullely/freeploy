// Derived from coollabsio/coolify@91b7e3e:resources/js/deploy-canvas.js (Apache-2.0), modified.
//
// Deploy canvas (DP-94): build a deploy workflow (project → server → source → settings → deploy) from
// steps, and run it. This file keeps the DOM-free parts — step types, flow rules, the plan, storage — so
// that `node --test` imports it; components/canvas/deploy/state.ts is the runtime around it.
//
// Departures: the option lists and the "New project" / "New environment" rows call deploy-core-worker's
// canvas endpoints (…/deploy/canvas/options/*, …/deploy/canvas/projects), which answer through Freeploy's
// /api/v1 handler as Coolify's /canvas/api does; a run sends the plan once (…/deploy/canvas/run), and the
// server runs the steps Coolify's browser runs one by one (the `run` of each type is
// apps/deploy-core-worker/src/applications/deploy-canvas.ts). The logos are Freeploy's own files
// (/svgs/resources), not versioned URLs. The Git repository step's "GitHub app" access (DP-95) lists the
// org's GitHub Apps, an App's repositories and a repository's branches through the same canvas endpoints
// (…/options/github-apps[/{id}/repositories[/{owner}/{repo}/branches]]), which reach GitHub through /api/v1's
// GitHub App routes (DP-93). Cut: following a deployment's logs (deploying answers 501: the SSH executor is
// not available yet).

// ── Settings ───────────────────────────────────────────────────────────
export const STORE = "coolify-canvas"; // localStorage prefix (flow, view).

// ── Small helpers ──────────────────────────────────────────────────────
// Icons: the app's reicon glyphs, or a few local paths in the same style.
export const LOCAL_ICONS: Record<string, string[]> = {
  minus: ["M5 12h14"],
  fit: ["M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"],
  back: ["M19 12H5", "M11 6l-6 6 6 6"], // the environment canvas back arrow
  fold: ["M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M9 4v16"], // the sidebar toggle in the navbar
};
export const uid = () => Math.random().toString(36).slice(2, 10);
export function load<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(`${STORE}:${key}`) ?? "null") as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}
export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(`${STORE}:${key}`, JSON.stringify(value));
  } catch {
    // Storage blocked: the canvas lasts this page only.
  }
}

export const ICONS = {
  start: "projects",
  server: "servers",
  git: "sources",
  image: "cloud",
  file: "file-content",
  layers: "layers",
  db: "database",
  sliders: "sliders",
  variables: "variables",
  globe: "globe",
  deploy: "play-circle",
  x: "x",
  plus: "plus",
  minus: "minus",
  fit: "fit",
  out: "external-link",
  fold: "fold",
  check: "check",
  chevron: "chevron-down",
  info: "info-circle",
} as const;

/** A select's option: [value, label, badge?]; the badge shows next to the label. */
export type Option = [string, string, string?];
export type StepData = Record<string, string | undefined>;

/** The canvas's calls for the lists and the "New …" rows (set by the runtime; tests set their own). */
export interface DeployCanvasCalls {
  /** GET …/deploy/canvas/options{path}: [value, label] pairs. */
  list(path: string): Promise<Option[]>;
  /** POST …/deploy/canvas{path} { name }: the created uuid. */
  create(path: string, body: { name: string }): Promise<{ uuid: string }>;
}
let calls: DeployCanvasCalls | null = null;
export function setDeployCanvasCalls(c: DeployCanvasCalls | null): void {
  calls = c;
}

// Cached option lists for the node fields (key → array; loading state).
// onChange runs when a list loads or fails (the canvas redraws its fields).
export const lists: { cache: Record<string, Option[]>; pending: Record<string, Promise<void>>; errors: Record<string, string>; onChange: () => void } = { cache: {}, pending: {}, errors: {}, onChange: () => {} };
function options(key: string, fetcher: () => Promise<Option[]>): Option[] | null {
  const { cache, pending, errors } = lists;
  if (cache[key]) return cache[key];
  if (!pending[key]) {
    pending[key] = fetcher()
      .then((list) => {
        cache[key] = list;
        delete errors[key];
      })
      .catch((error: unknown) => {
        errors[key] = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        delete pending[key];
        lists.onChange();
      });
  }
  return null;
}
const fetchList = (path: string) => () => (calls ? calls.list(path) : Promise.reject(new Error("Not available.")));

// The cache key a select loads from (to show its error).
export function loaderKey(f: Field, d: StepData): string | undefined {
  const map: Record<string, string> = {
    project: "projects",
    environment: `envs:${d.project}`,
    server: "servers",
    destination: `dest:${d.server}`,
    ghApp: "gh",
    ghRepo: `repos:${d.ghApp}`,
    ghBranch: `br:${d.ghApp}:${d.ghRepo}`,
    key: "keys",
  };
  return map[f.key];
}
const LOADERS = {
  projects: () => options("projects", fetchList("/projects")),
  envs: (project?: string) => (project ? options(`envs:${project}`, fetchList(`/projects/${encodeURIComponent(project)}/environments`)) : undefined),
  // Build-only servers cannot run resources (as on the New resource page): the endpoint leaves them out.
  servers: () => options("servers", fetchList("/servers")),
  destinations: (server?: string) => (server ? options(`dest:${server}`, fetchList(`/servers/${encodeURIComponent(server)}/destinations`)) : undefined),
  // The org's private GitHub Apps, as `${id}|${uuid}`: the id names the App in the repositories and branches
  // routes, the uuid in the create call. The endpoint leaves out public Apps and those without an App ID.
  ghApps: () => options("gh", fetchList("/github-apps")),
  repos: (app?: string) => (app ? options(`repos:${app}`, fetchList(`/github-apps/${encodeURIComponent(app.split("|")[0]!)}/repositories`)) : undefined),
  // The repository is GitHub's full name, "owner/name": two segments of the path.
  branches: (app?: string, repo?: string) =>
    app && repo ? options(`br:${app}:${repo}`, fetchList(`/github-apps/${encodeURIComponent(app.split("|")[0]!)}/repositories/${repo.split("/").map(encodeURIComponent).join("/")}/branches`)) : undefined,
  keys: () => options("keys", fetchList("/security/keys")),
};

// ── Node types ─────────────────────────────────────────────────────────
// stage: start → infra → source → config → ship. kind: what a source creates.
export type Stage = "start" | "infra" | "source" | "config" | "ship";
export type StepType = "start" | "server" | "git" | "image" | "dockerfile" | "service" | "database" | "build" | "env" | "domain" | "deploy";

export interface Field {
  key: string;
  label?: string;
  kind: "select" | "text" | "textarea" | "segmented" | "note";
  placeholder?: string;
  value?: string;
  options?: Option[];
  /** The list: an array once loaded, null while loading, undefined when the field above is empty. */
  load?: (d: StepData) => Option[] | null | undefined;
  show?: (d: StepData) => boolean;
  /** The loaded fields after it start empty again when it changes. */
  rerender?: boolean;
  required?: boolean;
  /** A select with `only: true` takes its option when it has exactly one. */
  only?: boolean;
  /** An optional select's default ("Default") is a real choice, not a placeholder. */
  optional?: string;
  /** Secret fields stay in memory only; they are never written to localStorage. */
  secret?: true | ((v: string) => boolean);
  mono?: boolean;
  rows?: number;
  text?: string;
  /** A "New …" row at the end of the list creates one and selects it. */
  add?: { label: string; placeholder: string; list: (d: StepData) => string; create: (name: string, d: StepData) => Promise<string> };
  after?: (d: StepData) => void;
}

export interface TypeDef {
  title: string;
  sub: string;
  stage: Stage;
  kind?: "application" | "service" | "database";
  icon: string;
  for?: string[];
  fields: Field[];
}

const BUILD_PACKS: Option[] = [
  ["railpack", "Railpack"],
  ["nixpacks", "Nixpacks", "Deprecated"],
  ["static", "Static"],
  ["dockerfile", "Dockerfile"],
  ["dockercompose", "Docker Compose"],
];
// The PostgreSQL images of the New resource page (project/new/select.blade.php).
const POSTGRES_IMAGES: Option[] = [
  ["postgres:18-alpine", "PostgreSQL 18"],
  ["postgres:17-alpine", "PostgreSQL 17"],
  ["postgres:16-alpine", "PostgreSQL 16"],
  ["supabase/postgres:17.4.1.032", "Supabase PostgreSQL"],
  ["postgis/postgis:17-3.5-alpine", "PostGIS"],
  ["pgvector/pgvector:pg18", "PGVector 18"],
  ["pgvector/pgvector:pg17", "PGVector 17"],
];
const DATABASES: Option[] = [
  ["postgresql", "PostgreSQL"],
  ["mysql", "MySQL"],
  ["mariadb", "MariaDB"],
  ["mongodb", "MongoDB"],
  ["redis", "Redis"],
  ["keydb", "KeyDB"],
  ["dragonfly", "Dragonfly"],
  ["clickhouse", "ClickHouse"],
  ["sqlite", "SQLite"],
];

// One-click service templates ([key, name]) and their logos ([logo, fallback]), from the page's data
// (GET …/deploy/canvas, DeployCanvas::serviceTemplates() and serviceLogos()).
let serviceTemplates: Option[] = [];
let serviceLogos: Record<string, [string, string]> = {};
export function setServiceCatalogue(templates: Option[], logos: Record<string, [string, string]>): void {
  serviceTemplates = templates;
  serviceLogos = logos;
}
const templateOptions = () => serviceTemplates;

export interface Logo {
  src: string;
  dark: string | null;
  fallback: string | null;
  padded: boolean;
}
// The logo of a source step: the one resource_logo() and the New resource page show for what it creates.
// Null keeps the step's glyph.
const resourceLogoUrl = (name: string) => `/svgs/resources/${name}.svg`;
const resourceLogo = (name: string, hasDark = false): Logo => ({ src: resourceLogoUrl(name), dark: hasDark ? resourceLogoUrl(`${name}-dark`) : null, fallback: null, padded: false });
const DATABASE_LOGOS: Record<string, string> = { postgresql: "postgres" };
const serviceLogo = (key: string): Logo | null => {
  const logo = serviceLogos[key];
  return logo ? { src: logo[0], dark: null, fallback: logo[1], padded: true } : null;
};
export function logoOf(n: FlowNode): Logo | null {
  const d = n.data || {};
  switch (n.type) {
    case "git":
      if (d.buildPack === "dockerfile") return resourceLogo("dockerfile");
      if (d.buildPack === "dockercompose") return resourceLogo("docker-compose");
      if (d.mode === "github") return resourceLogo("github-app", true);
      return resourceLogo(d.mode === "key" ? "deploy-key" : "public-repo");
    case "image":
      return resourceLogo("docker-image");
    case "dockerfile":
      return resourceLogo("dockerfile");
    case "service":
      return d.mode === "compose" ? resourceLogo("docker-compose") : d.type ? serviceLogo(d.type) : null;
    case "database":
      return d.engine ? resourceLogo(DATABASE_LOGOS[d.engine] ?? d.engine, ["keydb", "dragonfly"].includes(d.engine)) : null;
    default:
      return null;
  }
}

export const TYPES: Record<StepType, TypeDef> = {
  start: {
    title: "Start",
    sub: "Which project and environment",
    stage: "start",
    icon: ICONS.start,
    fields: [
      {
        key: "project",
        label: "Project",
        kind: "select",
        load: () => LOADERS.projects(),
        rerender: true,
        required: true,
        add: { label: "New project", placeholder: "Project name", list: () => "projects", create: async (name) => (await created("/projects", name)).uuid },
      },
      {
        key: "environment",
        label: "Environment",
        kind: "select",
        load: (d) => LOADERS.envs(d.project),
        required: true,
        only: true,
        add: { label: "New environment", placeholder: "Environment name", list: (d) => `envs:${d.project}`, create: async (name, d) => (await created(`/projects/${encodeURIComponent(d.project ?? "")}/environments`, name)).uuid },
      },
    ],
  },
  server: {
    title: "Server",
    sub: "Where it runs",
    stage: "infra",
    icon: ICONS.server,
    fields: [
      { key: "server", label: "Server", kind: "select", load: () => LOADERS.servers(), rerender: true, required: true, only: true },
      { key: "destination", label: "Network", kind: "select", load: (d) => LOADERS.destinations(d.server), optional: "Default" },
    ],
  },
  git: {
    title: "Git repository",
    sub: "Build from source",
    stage: "source",
    kind: "application",
    icon: ICONS.git,
    fields: [
      {
        key: "mode",
        label: "Access",
        kind: "segmented",
        options: [
          ["public", "Public"],
          ["github", "GitHub app"],
          ["key", "Deploy key"],
        ],
        rerender: true,
        value: "public",
      },
      { key: "repository", label: "Repository URL", kind: "text", placeholder: "https://github.com/coollabsio/coolify-examples", show: (d) => d.mode !== "github", required: true, secret: (v) => /^\w+:\/\/[^/]*@/.test(v) },
      { key: "ghApp", label: "GitHub app", kind: "select", load: () => LOADERS.ghApps(), show: (d) => d.mode === "github", rerender: true, required: true },
      { key: "ghRepo", label: "Repository", kind: "select", load: (d) => LOADERS.repos(d.ghApp), show: (d) => d.mode === "github", rerender: true, required: true },
      { key: "key", label: "Deploy key", kind: "select", load: () => LOADERS.keys(), show: (d) => d.mode === "key", required: true },
      { key: "branch", label: "Branch", kind: "text", placeholder: "main", value: "main", show: (d) => d.mode !== "github", required: true },
      { key: "ghBranch", label: "Branch", kind: "select", load: (d) => LOADERS.branches(d.ghApp, d.ghRepo), show: (d) => d.mode === "github", required: true },
      { key: "buildPack", label: "Build pack", kind: "select", options: BUILD_PACKS, value: "railpack", required: true },
      { key: "ports", label: "Port", kind: "text", placeholder: "3000", value: "3000" },
      { key: "name", label: "Name", kind: "text", placeholder: "Optional" },
    ],
  },
  image: {
    title: "Docker image",
    sub: "Run a prebuilt image",
    stage: "source",
    kind: "application",
    icon: ICONS.image,
    fields: [
      { key: "image", label: "Image", kind: "text", placeholder: "nginx", required: true },
      { key: "tag", label: "Tag", kind: "text", placeholder: "latest, or the tag in the image" },
      { key: "ports", label: "Port", kind: "text", placeholder: "80", value: "80" },
      { key: "name", label: "Name", kind: "text", placeholder: "Optional" },
    ],
  },
  dockerfile: {
    title: "Dockerfile",
    sub: "Build from a Dockerfile",
    stage: "source",
    kind: "application",
    icon: ICONS.file,
    fields: [
      { key: "dockerfile", label: "Dockerfile", kind: "textarea", placeholder: "FROM nginx:alpine\nCOPY . /usr/share/nginx/html", required: true },
      { key: "ports", label: "Port", kind: "text", placeholder: "80", value: "80" },
      { key: "name", label: "Name", kind: "text", placeholder: "Optional" },
    ],
  },
  service: {
    title: "Service",
    sub: "One-click template or compose",
    stage: "source",
    kind: "service",
    icon: ICONS.layers,
    fields: [
      {
        key: "mode",
        label: "From",
        kind: "segmented",
        options: [
          ["template", "Template"],
          ["compose", "Compose"],
        ],
        rerender: true,
        value: "template",
      },
      { key: "type", label: "Template", kind: "select", load: () => templateOptions(), show: (d) => d.mode !== "compose", required: true },
      { key: "compose", label: "docker-compose.yml", kind: "textarea", placeholder: "services:\n  app:\n    image: nginx", show: (d) => d.mode === "compose", required: true, secret: true },
      { key: "name", label: "Name", kind: "text", placeholder: "Optional" },
    ],
  },
  database: {
    title: "Database",
    sub: "A managed database",
    stage: "source",
    kind: "database",
    icon: ICONS.db,
    fields: [
      // A new engine starts with its default image (PostgreSQL: PostgreSQL 18).
      {
        key: "engine",
        label: "Engine",
        kind: "select",
        options: DATABASES,
        value: "postgresql",
        required: true,
        after: (d) => {
          d.image = d.engine === "postgresql" ? POSTGRES_IMAGES[0]![0] : "";
        },
      },
      { key: "image", label: "Image", kind: "select", options: POSTGRES_IMAGES, value: POSTGRES_IMAGES[0]![0], show: (d) => d.engine === "postgresql", required: true },
      { key: "image", label: "Image", kind: "text", placeholder: "Default for the engine", show: (d) => d.engine !== "postgresql" },
      { key: "name", label: "Name", kind: "text", placeholder: "Optional" },
    ],
  },
  build: {
    title: "Build settings",
    sub: "Directories and commands",
    stage: "config",
    icon: ICONS.sliders,
    for: ["git"],
    fields: [
      { key: "base_directory", label: "Base directory", kind: "text", placeholder: "/" },
      { key: "publish_directory", label: "Publish directory", kind: "text", placeholder: "/dist" },
      { key: "install_command", label: "Install command", kind: "text", placeholder: "Detected" },
      { key: "build_command", label: "Build command", kind: "text", placeholder: "Detected" },
      { key: "start_command", label: "Start command", kind: "text", placeholder: "Detected" },
    ],
  },
  env: {
    title: "Environment variables",
    sub: "KEY=value, one per line",
    stage: "config",
    icon: ICONS.variables,
    for: ["application", "service"],
    fields: [{ key: "vars", label: "Variables", kind: "textarea", placeholder: "NODE_ENV=production\nAPI_URL=https://api.example.com", required: true, mono: true, secret: true }],
  },
  domain: {
    title: "Domains",
    sub: "Your own public addresses",
    stage: "config",
    icon: ICONS.globe,
    for: ["git", "image", "dockerfile"],
    fields: [
      { key: "domains", label: "Domains", kind: "textarea", placeholder: "https://app.example.com", required: true, mono: true, rows: 2 },
      { key: "note", kind: "note", text: "Without this step, Freeploy makes an address from the server’s wildcard domain (or sslip.io)." },
    ],
  },
  deploy: {
    title: "Deploy",
    sub: "Save or deploy every resource",
    stage: "ship",
    icon: ICONS.deploy,
    fields: [],
  },
};

async function created(path: string, name: string): Promise<{ uuid: string }> {
  if (!calls) throw new Error("Not available.");
  return calls.create(path, { name });
}

export const PALETTE: Array<[string, StepType[]]> = [
  ["Infrastructure", ["server"]],
  ["Source", ["git", "image", "dockerfile", "service", "database"]],
  ["Configure", ["build", "env", "domain"]],
];

// ── Flow state ─────────────────────────────────────────────────────────
export interface FlowNode {
  id: string;
  type: StepType;
  x: number;
  y: number;
  data: StepData;
}
export interface FlowEdge {
  from: string;
  to: string;
}
export interface Flow {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

// Every deploy needs a server, so a new canvas has one, already connected
// (id 'server': it cannot be removed, nor its connection to Start).
export const fresh = (): Flow =>
  withDeploy({
    nodes: [
      { id: "start", type: "start", x: 80, y: 160, data: {} },
      { id: "server", type: "server", x: 456, y: 160, data: {} },
    ],
    edges: [{ from: "start", to: "server" }],
  });
// A select with `only: true` takes its option when it has exactly one.
export const onlyOption = (list: Option[] | null | undefined, value: string | undefined) => (!value && list?.length === 1 ? list[0]![0] : value);
// Every flow ends in one Deploy step. Resource lines reach it on their own, so
// edges into it (from older saved flows) are dropped.
export function withDeploy(f: Flow): Flow {
  if (!f.nodes.some((n) => n.type === "deploy")) f.nodes.push({ id: "deploy", type: "deploy", x: 1240, y: 160, data: {} });
  const deployIds = new Set(f.nodes.filter((n) => n.type === "deploy").map((n) => n.id));
  f.edges = f.edges.filter((e) => !deployIds.has(e.to) && !deployIds.has(e.from));
  return f;
}
/** A saved flow, if it is one: its steps of known types, with their edges. */
export function restoredFlow(value: unknown): Flow | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(v.nodes) || !Array.isArray(v.edges)) return null;
  const nodes = v.nodes.filter((n): n is FlowNode => !!n && typeof n === "object" && typeof (n as FlowNode).id === "string" && Object.hasOwn(TYPES, (n as FlowNode).type)).map((n) => ({ id: n.id, type: n.type, x: Number(n.x) || 0, y: Number(n.y) || 0, data: n.data && typeof n.data === "object" ? { ...n.data } : {} }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = v.edges.filter((e): e is FlowEdge => !!e && typeof e === "object" && ids.has((e as FlowEdge).from) && ids.has((e as FlowEdge).to)).map((e) => ({ from: e.from, to: e.to }));
  if (!nodes.some((n) => n.type === "start")) return null;
  return { nodes, edges };
}
// The environment that opened the canvas (?project=…&environment=…, from the
// New resource page), or null. Both values must look like UUIDs.
export function targetFrom(search: string): { project: string; environment: string } | null {
  const params = new URLSearchParams(search);
  const project = params.get("project");
  const environment = params.get("environment");
  const valid = (value: string | null) => /^[A-Za-z0-9_-]+$/.test(value ?? "");
  return valid(project) && valid(environment) ? { project: project!, environment: environment! } : null;
}
// The Start step targets that environment, also in a flow restored from an earlier visit.
export function withTarget(f: Flow, t: { project: string; environment: string } | null): Flow {
  const start = f.nodes.find((n) => n.type === "start");
  if (t && start) start.data = { project: t.project, environment: t.environment };
  return f;
}
// Secret fields (`secret: true`, or a test on the value) stay in memory only;
// they are never written to localStorage.
export function withoutSecrets(f: Flow): Flow {
  const nodes = f.nodes.map((n) => {
    const data = { ...n.data };
    for (const { key, secret } of TYPES[n.type]?.fields || []) {
      if (secret === true || (typeof secret === "function" && data[key] && secret(data[key]!))) delete data[key];
    }
    return { ...n, data };
  });
  return { ...f, nodes };
}
// The flow is a tree: Start → Servers → one line per resource (source →
// settings…), and every line ends in the one Deploy step.
export const nodeById = (id: string | undefined, f: Flow) => f.nodes.find((n) => n.id === id);
export const outsOf = (id: string, f: Flow) => f.edges.filter((e) => e.from === id).map((e) => e.to);
export const nextOf = (id: string, f: Flow) => outsOf(id, f)[0];
export const prevOf = (id: string, f: Flow) => f.edges.find((e) => e.to === id)?.from;
// Start and Server fan out; only Deploy takes more than one line in.
export const multiOut = (n: FlowNode) => ["start", "infra"].includes(TYPES[n.type].stage);
// The source node above a node in its line (what the settings apply to).
export function sourceAbove(id: string, f: Flow): FlowNode | null {
  const seen = new Set<string>();
  for (let cur: string | undefined = id; cur && !seen.has(cur); cur = prevOf(cur, f)) {
    seen.add(cur);
    const n = nodeById(cur, f);
    if (n && TYPES[n.type].stage === "source") return n;
  }
  return null;
}
// Can a `type` step come after `prev`? With `target`, also: the link makes no loop.
export function canFollow(prev: FlowNode, type: StepType, target: FlowNode | null, f: Flow): boolean {
  const t = TYPES[type];
  const p = TYPES[prev.type];
  if (type === "start" || type === "deploy" || prev.type === "deploy") return false;
  if (target) {
    const seen = new Set<string>();
    for (let cur: string | undefined = prev.id; cur && !seen.has(cur); cur = prevOf(cur, f)) {
      if (cur === target.id) return false;
      seen.add(cur);
    }
  }
  if (p.stage === "start") return type === "server";
  if (p.stage === "infra") return t.stage === "source";
  const src = sourceAbove(prev.id, f);
  if (!src) return false;
  if (t.stage === "ship") return true;
  if (t.stage !== "config") return false;
  const sub = src.type === "git" || src.type === "image" || src.type === "dockerfile" ? src.type : null;
  return t.for!.includes(TYPES[src.type].kind!) || (sub !== null && t.for!.includes(sub));
}

export interface PlanLine {
  server: FlowNode;
  source: FlowNode;
  settings: FlowNode[];
  end: FlowNode;
}
export interface Plan {
  start: FlowNode | undefined;
  servers: FlowNode[];
  lines: PlanLine[];
  deploy: FlowNode | null;
}
// What a run does: each resource line under each Server under Start.
export function planOf(f: Flow): Plan {
  const servers = outsOf("start", f)
    .map((id) => nodeById(id, f))
    .filter((n): n is FlowNode => n?.type === "server");
  const lines: PlanLine[] = [];
  for (const server of servers) {
    for (const id of outsOf(server.id, f)) {
      const source = nodeById(id, f);
      if (!source || TYPES[source.type].stage !== "source") continue;
      const settings: FlowNode[] = [];
      const seen = new Set([source.id]);
      for (let cur = nextOf(source.id, f); cur && !seen.has(cur); cur = nextOf(cur, f)) {
        seen.add(cur);
        const n = nodeById(cur, f);
        if (!n) break;
        settings.push(n);
      }
      lines.push({ server, source, settings, end: settings.at(-1) || source });
    }
  }
  return { start: nodeById("start", f), servers, lines, deploy: f.nodes.find((n) => n.type === "deploy") || null };
}
// Source id → label; same labels get a number ("Docker image · nginx #2").
export function uniqueLabels(sources: FlowNode[]): Map<string, string> {
  const labels = sources.map(resourceLabel);
  const seen: Record<string, number> = {};
  return new Map(
    sources.map((src, i) => {
      const label = labels[i]!;
      if (labels.filter((l) => l === label).length < 2) return [src.id, label];
      seen[label] = (seen[label] || 0) + 1;
      return [src.id, `${label} #${seen[label]}`];
    }),
  );
}
// "Docker image · nginx": what a source step makes, for lists and logs.
export function resourceLabel(src: FlowNode): string {
  const d = src.data;
  const detail =
    d.name ||
    (
      {
        git: d.mode === "github" ? d.ghRepo : d.repository,
        image: d.image,
        service: d.mode === "compose" ? "compose" : d.type,
        database: d.engine,
      } as Record<string, string | undefined>
    )[src.type];
  return detail ? `${TYPES[src.type].title} · ${detail}` : TYPES[src.type].title;
}
export function defaults(type: StepType): StepData {
  const data: StepData = {};
  for (const f of TYPES[type].fields) if (f.value !== undefined) data[f.key] = f.value;
  return data;
}
export type ResourceKind = "application" | "service" | "database";
// The Freeploy page of a created resource.
export function resourceHref(ctx: { project: string; environment: string; resource: { kind: ResourceKind; uuid: string } }): string {
  const base = `/project/${ctx.project}/environment/${ctx.environment}`;
  return `${base}/${ctx.resource.kind}/${ctx.resource.uuid}`;
}

// ── The run's checks and the plan sent ─────────────────────────────────

/** validate(): the problems in Coolify's order, and the steps to mark (a required field is empty). */
export function validate(plan: Plan): { problems: string[]; invalid: string[] } {
  const problems: string[] = [];
  const invalid: string[] = [];
  if (!plan.servers.length) problems.push("Connect a Server right after Start.");
  else if (!plan.lines.length) problems.push("Connect a source step (Git repository, Docker image, Dockerfile, Service or Database) to a Server.");
  const nodes = [plan.start, ...new Set(plan.lines.map((l) => l.server)), ...plan.lines.flatMap((l) => [l.source, ...l.settings])].filter((n): n is FlowNode => !!n);
  for (const n of nodes) {
    const missing = TYPES[n.type].fields.filter((f) => f.required && (!f.show || f.show(n.data)) && !String(n.data[f.key] ?? "").trim()).map((f) => f.label);
    if (missing.length) {
      problems.push(`${TYPES[n.type].title}: fill in ${missing.join(", ")}.`);
      invalid.push(n.id);
    }
  }
  return { problems, invalid };
}

const planNode = (n: FlowNode) => ({ id: n.id, type: n.type, data: { ...n.data } });
/** The body of POST …/deploy/canvas/run: the plan's steps with their fields (secrets included: they are needed). */
export function planBody(action: "save" | "deploy", plan: Plan) {
  return {
    action,
    plan: {
      start: plan.start && planNode(plan.start),
      servers: plan.servers.map(planNode),
      lines: plan.lines.map((l) => ({ server: l.server.id, source: planNode(l.source), settings: l.settings.map(planNode) })),
      deploy: plan.deploy && planNode(plan.deploy),
    },
  };
}

/** What the run answers (apps/deploy-core-worker/src/applications/deploy-canvas.ts RunResult). */
export interface RunAnswer {
  ok: boolean;
  action: "save" | "deploy";
  project: string;
  environment: string;
  steps: Array<{ id: string; label: string; state: "" | "running" | "done" | "failed"; message: string }>;
  resources: Array<{ source: string; label: string; kind: ResourceKind; uuid: string }>;
  deploys: Array<{ source: string; label: string; state: "done" | "failed"; message: string }>;
}

// "Docker image · nginx #2" → "nginx #2"; the full name is the tooltip.
export const shortLabel = (label: string) => (label.includes(" · ") ? label.slice(label.indexOf(" · ") + 3) : label);

// ── Geometry ───────────────────────────────────────────────────────────
export const PORT_Y = 26; // header centre (.cv-node-head is 52px; px, so the UI scale does not move the ports)
export const CARD_W = 296;
export const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
};
