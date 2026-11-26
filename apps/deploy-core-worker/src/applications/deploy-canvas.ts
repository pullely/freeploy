// Derived from coollabsio/coolify@91b7e3e:resources/js/deploy-canvas.js (TYPES and their run(), splitImage,
// common, parseEnvVars, domainList, canFollow, uniqueLabels, resourceLabel) and
// resources/js/canvas/deploy/state.svelte.js (validate, runFlow, deployAll) (Apache-2.0), modified.
//
// The deploy canvas's plan (DP-94): what Coolify's browser does once Deploy or "Save only" is pressed —
// check the plan (validate()), then run its steps in runFlow()'s order: Start, each Server, then each
// resource line (its source step creates the resource, its settings steps change it), and last the Deploy
// step, which saves (nothing more) or deploys every resource created. Each step calls the same /api/v1
// endpoint Coolify's step calls, with the same body (`call`, which deploy-core-worker answers in-process
// through its own /api/v1 handler), and a step's failure stops the run with the API's message, as
// ApiError builds it. Freeploy runs this on the server, so the console sends the plan once: the steps'
// statuses come back together. Deploying answers Freeploy's 501 (the SSH executor is not available yet),
// so the Deploy step fails with that message, as Coolify shows a failed deployment.
//
// The Git repository step's "GitHub app" access (DP-95) creates through POST /applications/private-github-app
// (DP-93) with Coolify's body. Cut: following a deployment's logs (no deployment starts).

/** An /api/v1 call: the answer's status and its JSON body (null when there is none). */
export type CanvasCall = (method: "GET" | "POST" | "PATCH", path: string, body?: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;

type Data = Record<string, unknown>;
type Stage = "start" | "infra" | "source" | "config" | "ship";

interface RequiredField {
  key: string;
  label: string;
  show?: (d: Data) => boolean;
}

interface StepType {
  title: string;
  stage: Stage;
  /** What a source creates. */
  kind?: "application" | "service" | "database";
  /** A settings step: the kinds (or source types) it applies to. */
  for?: readonly string[];
  required: readonly RequiredField[];
}

/** TYPES: the titles, stages and required fields (`required: true`, with their `show`). */
export const DEPLOY_CANVAS_TYPES: Record<string, StepType> = {
  start: { title: "Start", stage: "start", required: [{ key: "project", label: "Project" }, { key: "environment", label: "Environment" }] },
  server: { title: "Server", stage: "infra", required: [{ key: "server", label: "Server" }] },
  git: {
    title: "Git repository",
    stage: "source",
    kind: "application",
    required: [
      { key: "repository", label: "Repository URL", show: (d) => d.mode !== "github" },
      { key: "ghApp", label: "GitHub app", show: (d) => d.mode === "github" },
      { key: "ghRepo", label: "Repository", show: (d) => d.mode === "github" },
      { key: "key", label: "Deploy key", show: (d) => d.mode === "key" },
      { key: "branch", label: "Branch", show: (d) => d.mode !== "github" },
      { key: "ghBranch", label: "Branch", show: (d) => d.mode === "github" },
      { key: "buildPack", label: "Build pack" },
    ],
  },
  image: { title: "Docker image", stage: "source", kind: "application", required: [{ key: "image", label: "Image" }] },
  dockerfile: { title: "Dockerfile", stage: "source", kind: "application", required: [{ key: "dockerfile", label: "Dockerfile" }] },
  service: {
    title: "Service",
    stage: "source",
    kind: "service",
    required: [
      { key: "type", label: "Template", show: (d) => d.mode !== "compose" },
      { key: "compose", label: "docker-compose.yml", show: (d) => d.mode === "compose" },
    ],
  },
  database: {
    title: "Database",
    stage: "source",
    kind: "database",
    required: [
      { key: "engine", label: "Engine" },
      { key: "image", label: "Image", show: (d) => d.engine === "postgresql" },
    ],
  },
  build: { title: "Build settings", stage: "config", for: ["git"], required: [] },
  env: { title: "Environment variables", stage: "config", for: ["application", "service"], required: [{ key: "vars", label: "Variables" }] },
  domain: { title: "Domains", stage: "config", for: ["git", "image", "dockerfile"], required: [{ key: "domains", label: "Domains" }] },
  deploy: { title: "Deploy", stage: "ship", required: [] },
};

export const DEPLOY_CANVAS_MESSAGES = {
  noServer: "Connect a Server right after Start.",
  noSource: "Connect a source step (Git repository, Docker image, Dockerfile, Service or Database) to a Server.",
  /** startConnect()'s toast, for a plan whose steps do not follow each other. */
  cannotFollow: "That step cannot follow this one.",
  /** Freeploy's: the plan the console sends is not one planOf() builds. */
  invalidPlan: "The plan is not valid.",
  /** Freeploy's: Laravel's `in` rule for the run's action. */
  invalidAction: "The selected action is invalid.",
  actionRequired: "The action field is required.",
} as const;

// ── The plan ─────────────────────────────────────────────────────────────

export interface PlanNode {
  id: string;
  type: string;
  data: Data;
}

export interface PlanLine {
  server: PlanNode;
  source: PlanNode;
  settings: PlanNode[];
}

/** planOf(): Start, the Servers connected to it, each resource line under a Server, and the Deploy step. */
export interface DeployPlan {
  start: PlanNode;
  servers: PlanNode[];
  lines: PlanLine[];
  deploy: PlanNode;
}

export type RunAction = "save" | "deploy";

const isObject = (v: unknown): v is Data => typeof v === "object" && v !== null && !Array.isArray(v);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Freeploy's: one run is one request, so a plan has at most this many steps (Coolify's browser has no limit). */
export const MAX_PLAN_STEPS = 100;

function node(value: unknown, ids: Set<string>): PlanNode | null {
  if (!isObject(value) || typeof value.id !== "string" || !ID_RE.test(value.id) || typeof value.type !== "string" || !Object.hasOwn(DEPLOY_CANVAS_TYPES, value.type)) return null;
  if (value.data !== undefined && !isObject(value.data)) return null;
  if (ids.has(value.id)) return null;
  ids.add(value.id);
  return { id: value.id, type: value.type, data: { ...((value.data as Data | undefined) ?? {}) } };
}

/**
 * The plan the console sends: { start, servers, lines: [{ server: id, source, settings }], deploy }, each node
 * { id, type, data }. null when it is not one planOf() could build.
 */
export function parsePlan(value: unknown): DeployPlan | null {
  if (!isObject(value) || !Array.isArray(value.servers) || !Array.isArray(value.lines)) return null;
  const ids = new Set<string>();
  const start = node(value.start, ids);
  const deploy = node(value.deploy, ids);
  if (!start || !deploy) return null;
  const servers: PlanNode[] = [];
  for (const s of value.servers) {
    const n = node(s, ids);
    if (!n) return null;
    servers.push(n);
  }
  const lines: PlanLine[] = [];
  for (const l of value.lines) {
    if (!isObject(l) || !Array.isArray(l.settings)) return null;
    const server = servers.find((s) => s.id === l.server);
    const source = node(l.source, ids);
    if (!server || !source) return null;
    const settings: PlanNode[] = [];
    for (const s of l.settings) {
      const n = node(s, ids);
      if (!n) return null;
      settings.push(n);
    }
    lines.push({ server, source, settings });
  }
  if (ids.size > MAX_PLAN_STEPS) return null;
  return { start, servers, lines, deploy };
}

/** canFollow() along the plan: Start, then Servers, then a source on each, then the settings that apply to it. */
export function planFollows(plan: DeployPlan): boolean {
  const stage = (n: PlanNode) => DEPLOY_CANVAS_TYPES[n.type]!.stage;
  if (plan.start.type !== "start" || plan.deploy.type !== "deploy") return false;
  if (plan.servers.some((s) => s.type !== "server")) return false;
  for (const line of plan.lines) {
    if (stage(line.source) !== "source") return false;
    const src = DEPLOY_CANVAS_TYPES[line.source.type]!;
    for (const n of line.settings) {
      const t = DEPLOY_CANVAS_TYPES[n.type]!;
      if (t.stage !== "config") return false;
      if (!t.for!.includes(src.kind!) && !t.for!.includes(line.source.type)) return false;
    }
  }
  return true;
}

/** validate(): the problems in Coolify's order, and the steps with an empty required field. */
export function validatePlan(plan: DeployPlan): { problems: string[]; invalid: string[] } {
  const problems: string[] = [];
  const invalid: string[] = [];
  if (!plan.servers.length) problems.push(DEPLOY_CANVAS_MESSAGES.noServer);
  else if (!plan.lines.length) problems.push(DEPLOY_CANVAS_MESSAGES.noSource);
  const servers = [...new Set(plan.lines.map((l) => l.server))];
  for (const n of [plan.start, ...servers, ...plan.lines.flatMap((l) => [l.source, ...l.settings])]) {
    const t = DEPLOY_CANVAS_TYPES[n.type]!;
    const missing = t.required.filter((f) => (!f.show || f.show(n.data)) && !String(n.data[f.key] ?? "").trim()).map((f) => f.label);
    if (missing.length) {
      problems.push(`${t.title}: fill in ${missing.join(", ")}.`);
      invalid.push(n.id);
    }
  }
  return { problems, invalid };
}

// ── Helpers of the steps ─────────────────────────────────────────────────

const text = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

/** "nginx:alpine" → nginx + alpine; "ghcr.io:443/a/b@sha256:…" → digest tag (Coolify's "sha256-…" form). A tag in the image wins over the Tag field. */
export function splitImage(image: unknown, tagField: unknown): { name: string; tag: string } {
  let name = text(image).trim();
  let tag = "";
  const at = name.indexOf("@sha256:");
  if (at >= 0) {
    tag = `sha256-${name.slice(at + 8)}`;
    name = name.slice(0, at);
  } else {
    const colon = name.lastIndexOf(":");
    if (colon > name.lastIndexOf("/")) {
      tag = name.slice(colon + 1);
      name = name.slice(0, colon);
    }
  }
  return { name, tag: tag || text(tagField).trim() || "latest" };
}

/** "KEY=value" lines → [{ key, value }]; skips blanks and # comments, strips quotes. */
export function parseEnvVars(value: unknown): Array<{ key: string; value: string }> {
  return text(value)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const i = line.indexOf("=");
      return { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, "$2") };
    });
}

export const domainList = (value: unknown): string =>
  text(value)
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean)
    .join(",");

/** btoa(unescape(encodeURIComponent(text))): the UTF-8 bytes in base64. */
export function base64Text(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** "Docker image · nginx": what a source step makes, for lists and logs. */
export function resourceLabel(src: PlanNode): string {
  const d = src.data;
  const detail =
    d.name ||
    ({
      git: d.mode === "github" ? d.ghRepo : d.repository,
      image: d.image,
      service: d.mode === "compose" ? "compose" : d.type,
      database: d.engine,
    } as Data)[src.type];
  return detail ? `${DEPLOY_CANVAS_TYPES[src.type]!.title} · ${text(detail)}` : DEPLOY_CANVAS_TYPES[src.type]!.title;
}

/** Source id → label; same labels get a number ("Docker image · nginx #2"). */
export function uniqueLabels(sources: readonly PlanNode[]): Map<string, string> {
  const labels = sources.map(resourceLabel);
  const seen: Record<string, number> = {};
  return new Map(
    sources.map((src, i) => {
      const label = labels[i]!;
      if (labels.filter((l) => l === label).length < 2) return [src.id, label];
      seen[label] = (seen[label] ?? 0) + 1;
      return [src.id, `${label} #${seen[label]}`];
    }),
  );
}

/** ApiError's message: the body's message (or "Request failed (HTTP n)."), then every field error that is not that message. */
export function apiErrorMessage(status: number, body: unknown): string {
  const b = isObject(body) ? body : null;
  const message = typeof b?.message === "string" ? b.message : "";
  const errors = isObject(b?.errors) ? Object.values(b.errors).flat().map(String) : [];
  return [message || `Request failed (HTTP ${status}).`, ...errors.filter((e) => e !== message)].join(" ");
}

class StepError extends Error {}

/** api(): the answer's body, or a StepError with ApiError's message. */
async function api(call: CanvasCall, method: "GET" | "POST" | "PATCH", path: string, body?: Data): Promise<Data> {
  const res = await call(method, path, body);
  if (res.status < 200 || res.status >= 300) throw new StepError(apiErrorMessage(res.status, res.body));
  return isObject(res.body) ? res.body : {};
}

// ── The steps ────────────────────────────────────────────────────────────

export interface CreatedResource {
  kind: "application" | "service" | "database";
  uuid: string;
}

interface RunContext {
  project?: string;
  environment?: string;
  server?: string;
  destination?: string | undefined;
  domains?: string;
  createdDomains?: string | undefined;
  applicationSource?: boolean;
  resource?: CreatedResource;
}

/** common(): the fields of every create call. Domains from a Domains step later in the line go in at creation. */
function common(ctx: RunContext, d: Data): Data {
  const body: Data = { project_uuid: ctx.project, environment_uuid: ctx.environment, server_uuid: ctx.server, instant_deploy: false };
  if (ctx.destination) body.destination_uuid = ctx.destination;
  if (d.name) body.name = d.name;
  if (ctx.domains && ctx.applicationSource) {
    body.domains = ctx.domains;
    body.autogenerate_domain = false;
  }
  return body;
}

const createdUuid = (res: Data): string => text(res.uuid);
const createdDomains = (res: Data): string | undefined => (res.domains ? domainList(res.domains) : undefined);
const ports = (d: Data) => (d.ports ? d.ports : undefined);
const path = (segment: unknown) => encodeURIComponent(text(segment));

/** Each step's run(): what it calls, and its message. */
async function runStep(call: CanvasCall, ctx: RunContext, n: PlanNode): Promise<string> {
  const d = n.data;
  switch (n.type) {
    case "start":
      ctx.project = text(d.project);
      ctx.environment = text(d.environment);
      return "Project and environment set.";
    case "server":
      ctx.server = text(d.server);
      ctx.destination = d.destination ? text(d.destination) : undefined;
      return "Server picked.";
    case "git": {
      ctx.applicationSource = true;
      const base = { ...common(ctx, d), build_pack: d.buildPack, ports_exposes: ports(d) };
      // The GitHub App's option value is `${id}|${uuid}` (the canvas's github-apps list): the create names it by uuid.
      const res =
        d.mode === "github"
          ? await api(call, "POST", "/applications/private-github-app", { ...base, github_app_uuid: text(d.ghApp).split("|")[1], git_repository: d.ghRepo, git_branch: d.ghBranch })
          : d.mode === "key"
            ? await api(call, "POST", "/applications/private-deploy-key", { ...base, private_key_uuid: d.key, git_repository: d.repository, git_branch: d.branch })
            : await api(call, "POST", "/applications/public", { ...base, git_repository: d.repository, git_branch: d.branch });
      ctx.resource = { kind: "application", uuid: createdUuid(res) };
      ctx.createdDomains = createdDomains(res);
      return "Application created.";
    }
    case "image": {
      ctx.applicationSource = true;
      const { name, tag } = splitImage(d.image, d.tag);
      const res = await api(call, "POST", "/applications/dockerimage", { ...common(ctx, d), docker_registry_image_name: name, docker_registry_image_tag: tag, ports_exposes: ports(d) });
      ctx.resource = { kind: "application", uuid: createdUuid(res) };
      ctx.createdDomains = createdDomains(res);
      return "Application created.";
    }
    case "dockerfile": {
      ctx.applicationSource = true;
      const res = await api(call, "POST", "/applications/dockerfile", { ...common(ctx, d), dockerfile: base64Text(text(d.dockerfile)), ports_exposes: ports(d) });
      ctx.resource = { kind: "application", uuid: createdUuid(res) };
      ctx.createdDomains = createdDomains(res);
      return "Application created.";
    }
    case "service": {
      const body = common(ctx, d);
      if (d.mode === "compose") body.docker_compose_raw = base64Text(text(d.compose));
      else body.type = text(d.type).trim();
      const res = await api(call, "POST", "/services", body);
      ctx.resource = { kind: "service", uuid: createdUuid(res) };
      return "Service created.";
    }
    case "database": {
      const body = common(ctx, d);
      if (d.image) body.image = d.image;
      const res = await api(call, "POST", `/databases/${path(d.engine)}`, body);
      ctx.resource = { kind: "database", uuid: createdUuid(res) };
      return "Database created.";
    }
    case "build": {
      const body = Object.fromEntries(["base_directory", "publish_directory", "install_command", "build_command", "start_command"].filter((k) => d[k]).map((k) => [k, d[k]]));
      if (!Object.keys(body).length) return "Nothing to change.";
      await api(call, "PATCH", `/applications/${path(ctx.resource!.uuid)}`, body);
      return "Build settings saved.";
    }
    case "env": {
      const data = parseEnvVars(d.vars);
      if (!data.length) return "No variables.";
      const kind = ctx.resource!.kind === "service" ? "services" : "applications";
      await api(call, "PATCH", `/${kind}/${path(ctx.resource!.uuid)}/envs/bulk`, { data });
      return `${data.length} variable${data.length === 1 ? "" : "s"} saved.`;
    }
    case "domain": {
      const domains = domainList(d.domains);
      if (ctx.createdDomains === domains) return `Set at creation: ${domains.replace(/,/g, ", ")}.`;
      await api(call, "PATCH", `/applications/${path(ctx.resource!.uuid)}`, { domains });
      return `Domains saved: ${domains.replace(/,/g, ", ")}.`;
    }
    default:
      throw new StepError(DEPLOY_CANVAS_MESSAGES.cannotFollow);
  }
}

// ── The run ──────────────────────────────────────────────────────────────

export type StepState = "" | "running" | "done" | "failed";

export interface RunStep {
  id: string;
  label: string;
  state: StepState;
  message: string;
}

/** A resource the run created: its source step, label, kind and uuid. */
export interface RunResource extends CreatedResource {
  source: string;
  label: string;
}

/** A resource's deploy (its tab in the run panel): done or failed, with the message. */
export interface RunDeploy {
  source: string;
  label: string;
  state: "done" | "failed";
  message: string;
}

export interface RunResult {
  ok: boolean;
  action: RunAction;
  project: string;
  environment: string;
  steps: RunStep[];
  resources: RunResource[];
  deploys: RunDeploy[];
}

const failureMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** runFlow(): the steps in Coolify's order; the first failure stops the run (the steps after it stay "Waiting"). */
export async function runPlan(call: CanvasCall, action: RunAction, plan: DeployPlan): Promise<RunResult> {
  const servers = [...new Set(plan.lines.map((l) => l.server))];
  const list = [plan.start, ...servers, ...plan.lines.flatMap((l) => [l.source, ...l.settings]), plan.deploy];
  const names = uniqueLabels(plan.lines.map((l) => l.source));
  const labelOf = (n: PlanNode) => names.get(n.id) ?? DEPLOY_CANVAS_TYPES[n.type]!.title;
  const steps: RunStep[] = list.map((n) => ({ id: n.id, label: labelOf(n), state: "", message: "Waiting" }));
  const rowOf = (n: PlanNode) => steps.find((s) => s.id === n.id)!;
  const step = async (n: PlanNode, work: () => Promise<string>): Promise<boolean> => {
    const row = rowOf(n);
    try {
      row.message = await work();
      row.state = "done";
      return true;
    } catch (e) {
      row.state = "failed";
      row.message = failureMessage(e);
      return false;
    }
  };
  const base: RunContext = {};
  let ok = await step(plan.start, () => runStep(call, base, plan.start));
  for (const server of servers) {
    if (!ok) break;
    ok = await step(server, async () => "Server picked.");
  }
  const shipped: RunResource[] = [];
  for (const line of plan.lines) {
    if (!ok) break;
    const ctx: RunContext = { ...base };
    await runStep(call, ctx, line.server);
    const domainNode = line.settings.find((n) => n.type === "domain");
    if (domainNode) ctx.domains = domainList(domainNode.data.domains);
    for (const n of [line.source, ...line.settings]) {
      ok = await step(n, () => runStep(call, ctx, n));
      if (!ok) break;
    }
    if (ctx.resource) shipped.push({ ...ctx.resource, source: line.source.id, label: names.get(line.source.id)! });
  }
  const deploys: RunDeploy[] = [];
  if (ok) {
    ok = await step(plan.deploy, async () => (action === "save" ? `Saved ${shipped.length} resource${shipped.length === 1 ? "" : "s"}. Not deployed.` : deployAll(call, shipped, deploys)));
  }
  return { ok, action, project: text(base.project), environment: text(base.environment), steps, resources: shipped, deploys };
}

/** deployAll(): POST /deploy for each resource; its deployment's message, or the failures joined. */
async function deployAll(call: CanvasCall, shipped: readonly RunResource[], deploys: RunDeploy[]): Promise<string> {
  const results: Array<{ ok: true; value: string } | { ok: false; reason: string }> = [];
  for (const { source, label, uuid } of shipped) {
    try {
      const res = await api(call, "POST", "/deploy", { uuid });
      const items = Array.isArray(res.deployments) ? (res.deployments as unknown[]) : [];
      const item = isObject(items[0]) ? items[0] : null;
      const message = item && typeof item.message === "string" && item.message ? item.message : "Started.";
      deploys.push({ source, label, state: "done", message });
      results.push({ ok: true, value: `${label}: ${message}` });
    } catch (e) {
      const reason = failureMessage(e);
      deploys.push({ source, label, state: "failed", message: reason.replace(`${label}: `, "") });
      results.push({ ok: false, reason });
    }
  }
  const failed = results.flatMap((r) => (r.ok ? [] : [r.reason]));
  if (failed.length) throw new StepError(failed.join(" · "));
  return results.length > 1 ? `${results.length} resources deployed.` : (results[0] as { value: string }).value;
}
