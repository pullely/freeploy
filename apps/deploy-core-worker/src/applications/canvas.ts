// Derived from coollabsio/coolify@91b7e3e:app/Services/EnvironmentCanvas.php and
// app/Http/Controllers/Api/EnvironmentCanvasController.php (Apache-2.0), modified.
//
// The environment canvas's graph (DP-91): server zones, resource cards and their
// statuses, as EnvironmentCanvas::payload() builds them for the Svelte canvas
// (resources/js/canvas/environment/*), which deploy-web ports to React.
// Cards hold summary fields only: never environment variables, passwords,
// keys or connection URLs.
//
// DP-92: the canvas is editable. payload() carries the saved card positions
// (deploy.environments.canvas_positions) and the visual-only links
// (deploy.resource_links), and can_edit is deploy.resource.write; the
// controller's four save actions are ported with their rules and messages:
// updatePositions, storeLink, updateLink and destroyLink. Not built:
// extra_zones (an application's additional servers), the image scan marker
// (`security`), a domain's favicon and a service template's logo, the
// environment looked up by its name (Coolify's environment_name_or_uuid; the
// console always sends the uuid), created_by on a link, and the server,
// project, dashboard, shared variable and tag canvases.
import type { CanvasResourceRow, DeployApplicationRow, DeployDatabaseRow, DeployEnvironmentServiceCanvasRow, DeployResourceLinkRow, NewResourceLink, ResourceLinkEnds } from "@saas/db/deploy";
import type { ApplicationContext } from "./service.js";
import { newPublicId } from "../helpers/names.js";
import { addError, extraFields, type ApiBody, type Errors } from "../api-v1/request.js";
import { phpIsNumeric, validateRules, type Rule, type Rules } from "../api-v1/rules.js";
import { databaseStatus } from "../databases/service.js";
import { serviceStatus } from "../services/configuration.js";

/** EnvironmentCanvas::DATABASE_ENGINE_NAMES */
const DATABASE_ENGINE_NAMES: Readonly<Record<string, string>> = {
  postgresql: "PostgreSQL",
  redis: "Redis / Valkey",
  mongodb: "MongoDB",
  mysql: "MySQL",
  mariadb: "MariaDB",
  keydb: "KeyDB",
  dragonfly: "Dragonfly",
  clickhouse: "ClickHouse",
  sqlite: "SQLite",
};

/** EnvironmentCanvas::BUILD_PACK_NAMES */
const BUILD_PACK_NAMES: Readonly<Record<string, string>> = {
  nixpacks: "Nixpacks",
  railpack: "Railpack",
  static: "Static",
  dockerfile: "Dockerfile",
  dockercompose: "Docker Compose",
  dockerimage: "Docker Image",
};

export interface CanvasZone {
  id: string;
  name: string;
  /** Null: Freeploy's canvas reader may not see the server's IP (Coolify: canReadSensitive). */
  ip: string | null;
  is_reachable: boolean;
  is_usable: boolean;
  link: string;
}

export interface CanvasLogo {
  src: string;
  dark: string | null;
  fallback: string | null;
  padded: boolean;
  favicon: string | null;
}

export interface CanvasChild {
  name: string;
  type: "application" | "database";
  status: string;
}

export interface CanvasNode {
  id: string;
  type: "application" | "service" | "database";
  name: string;
  status: string;
  zone: string | null;
  extra_zones: string[];
  urls: string[];
  kind: string | null;
  subtitle: string;
  children: CanvasChild[];
  link: string;
  logo: CanvasLogo | null;
  security: null;
  saved: null;
}

export interface CanvasLinkPayload {
  id: string;
  source: string;
  target: string;
  label: string | null;
}

export type CanvasPositions = Record<string, { x: number; y: number }>;

export interface EnvironmentCanvasPayload {
  project: { uuid: string; name: string; link: string };
  environment: { uuid: string; name: string; link: string };
  can_edit: boolean;
  zones: CanvasZone[];
  nodes: CanvasNode[];
  links: CanvasLinkPayload[];
  positions: CanvasPositions;
}

/** Str::headline() for the names Coolify does not list. */
const headline = (value: string) =>
  value
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

/** EnvironmentCanvas::subtitle(): the non-empty parts joined with " · ". */
const subtitle = (parts: Array<string | null | undefined>) =>
  parts
    .map((p) => String(p ?? "").trim())
    .filter(Boolean)
    .join(" · ");

/** EnvironmentCanvas::splitUrls(): the comma separated domains, trimmed, unique. */
export function splitUrls(fqdn: string | null | undefined): string[] {
  return [
    ...new Set(
      String(fqdn ?? "")
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean),
    ),
  ];
}

/** resource_logo_url() + resource_logo()'s $resourceLogo. */
const resourceLogo = (name: string, hasDark = false): CanvasLogo => ({
  src: `/svgs/resources/${name}.svg`,
  dark: hasDark ? `/svgs/resources/${name}-dark.svg` : null,
  fallback: null,
  padded: false,
  favicon: null,
});

/** resource_logo() for an application: how it is built (Freeploy keeps no source_type, so a Git app is "public-repo"). */
function applicationLogo(buildPack: string): CanvasLogo {
  if (buildPack === "dockerimage") return resourceLogo("docker-image");
  if (buildPack === "dockerfile") return resourceLogo("dockerfile");
  if (buildPack === "dockercompose") return resourceLogo("docker-compose");
  return resourceLogo("public-repo");
}

/** resource_logo() for a standalone database: its engine. */
function databaseLogo(engine: string): CanvasLogo | null {
  const logos: Record<string, CanvasLogo> = {
    postgresql: resourceLogo("postgres"),
    mysql: resourceLogo("mysql"),
    mariadb: resourceLogo("mariadb"),
    mongodb: resourceLogo("mongodb"),
    redis: resourceLogo("redis"),
    keydb: resourceLogo("keydb", true),
    dragonfly: resourceLogo("dragonfly", true),
    clickhouse: resourceLogo("clickhouse"),
    sqlite: resourceLogo("sqlite"),
  };
  return logos[engine] ?? null;
}

interface ServerFacts {
  server_uuid: string | null;
  server_name: string | null;
  server_is_reachable: boolean | null;
  server_is_usable: boolean | null;
}

/** EnvironmentCanvas::zone() */
const zoneOf = (row: ServerFacts & { server_uuid: string }): CanvasZone => ({
  id: row.server_uuid,
  name: row.server_name ?? "",
  ip: null,
  is_reachable: Boolean(row.server_is_reachable),
  is_usable: Boolean(row.server_is_usable),
  link: `/server/${row.server_uuid}`,
});

/** EnvironmentCanvas::DATABASE_RELATIONS: loadResources() reads the databases engine by engine. */
const DATABASE_RELATION_ORDER = ["postgresql", "redis", "mongodb", "mysql", "mariadb", "keydb", "dragonfly", "clickhouse", "sqlite"];
const byRelation = (rows: readonly DeployDatabaseRow[]) => [...rows].sort((a, b) => DATABASE_RELATION_ORDER.indexOf(a.engine) - DATABASE_RELATION_ORDER.indexOf(b.engine));

interface ServicePart {
  name: string;
  kind: "application" | "database";
  status: string;
  fqdn: string | null;
  exclude_from_status: boolean;
  is_removed_from_compose: boolean;
}

/**
 * EnvironmentCanvas::graph() over Freeploy's rows: one card per application, service and
 * standalone database (in loadResources()' order: applications, services, then the databases
 * engine by engine, each as the store lists them), and one zone per server they run on, in the order the cards first name it.
 */
export function canvasGraph(
  base: string,
  applications: readonly DeployApplicationRow[],
  services: readonly DeployEnvironmentServiceCanvasRow[],
  databases: readonly DeployDatabaseRow[],
): { zones: CanvasZone[]; nodes: CanvasNode[] } {
  const zones = new Map<string, CanvasZone>();
  const zoneFor = (row: ServerFacts) => {
    if (!row.server_uuid) return null;
    if (!zones.has(row.server_uuid)) zones.set(row.server_uuid, zoneOf({ ...row, server_uuid: row.server_uuid }));
    return row.server_uuid;
  };
  const nodes: CanvasNode[] = [];
  for (const app of applications) {
    const detail = app.build_pack === "dockerimage" ? [app.docker_registry_image_name, app.docker_registry_image_tag].filter(Boolean).join(":") : app.git_branch;
    nodes.push({
      id: app.uuid,
      type: "application",
      name: app.name,
      status: String(app.status ?? ""),
      zone: zoneFor(app),
      extra_zones: [],
      urls: splitUrls(app.fqdn),
      kind: app.build_pack,
      subtitle: subtitle([BUILD_PACK_NAMES[app.build_pack] ?? headline(app.build_pack), detail]),
      children: [],
      link: `${base}/application/${app.uuid}`,
      logo: applicationLogo(app.build_pack),
      security: null,
      saved: null,
    });
  }
  for (const service of services) {
    const parts = ((typeof service.parts === "string" ? JSON.parse(service.parts) : service.parts) ?? []) as ServicePart[];
    const children: CanvasChild[] = parts.map((p) => ({ name: p.name, type: p.kind, status: String(p.status ?? "") }));
    nodes.push({
      id: service.uuid,
      type: "service",
      name: service.name,
      status: serviceStatus(parts),
      zone: zoneFor(service),
      extra_zones: [],
      urls: [...new Set(parts.filter((p) => p.kind === "application").flatMap((p) => splitUrls(p.fqdn)))],
      kind: null,
      subtitle: subtitle(["Service", `${children.length} ${children.length === 1 ? "container" : "containers"}`]),
      children,
      link: `${base}/service/${service.uuid}`,
      // A service template's logo: Freeploy ships none yet, so the type icon.
      logo: null,
      security: null,
      saved: null,
    });
  }
  for (const database of byRelation(databases)) {
    nodes.push({
      id: database.uuid,
      type: "database",
      name: database.name,
      status: databaseStatus(database.status),
      zone: zoneFor(database),
      extra_zones: [],
      urls: [],
      kind: database.engine,
      subtitle: subtitle([DATABASE_ENGINE_NAMES[database.engine] ?? headline(database.engine), database.image]),
      children: [],
      link: `${base}/database/${database.uuid}`,
      logo: databaseLogo(database.engine),
      security: null,
      saved: null,
    });
  }
  return { zones: [...zones.values()], nodes };
}

// ── Saved layout (DP-92) ─────────────────────────────────────────────

/** EnvironmentCanvas::MAX_COORDINATE */
export const MAX_COORDINATE = 100000;
/** EnvironmentCanvasController::MAX_POSITIONS */
export const MAX_POSITIONS = 1000;

/** The environment canvas's stored layout, in the org's transaction (packages/db deploy/canvas.ts). */
export interface CanvasStore {
  /** EnvironmentCanvas::resourceIndex(): uuid, morph type and id of every top-level resource. */
  resources(environmentId: string | number): Promise<CanvasResourceRow[]>;
  positions(environmentId: string | number): Promise<unknown>;
  /** The environment's positions, its row locked until the transaction ends (lockForUpdate). */
  lockPositions(environmentId: string | number): Promise<{ found: boolean; positions: unknown }>;
  savePositions(environmentId: string | number, positions: CanvasPositions): Promise<void>;
  links(environmentId: string | number): Promise<DeployResourceLinkRow[]>;
  findLink(environmentId: string | number, uuid: string): Promise<DeployResourceLinkRow | null>;
  linkExists(ends: ResourceLinkEnds): Promise<boolean>;
  /** The new link, or null when resource_links_unique_direction refused it. */
  insertLink(link: Omit<NewResourceLink, "orgId">): Promise<DeployResourceLinkRow | null>;
  updateLabel(id: string | number, label: string | null): Promise<DeployResourceLinkRow | null>;
  deleteLink(id: string | number): Promise<boolean>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
/** A PHP array as collect() reads it: an object's entries, a list's indexes as keys. */
const entriesOf = (v: unknown): Array<[string, unknown]> => (Array.isArray(v) ? v.map((x, i): [string, unknown] => [String(i), x]) : isRecord(v) ? Object.entries(v) : []);

/**
 * EnvironmentCanvas::filterPositions(): only the given node uuids, only positions with numeric x and y,
 * as integer coordinates ((int) truncates).
 */
export function filterPositions(positions: unknown, nodeUuids: readonly string[]): CanvasPositions {
  const keep = new Set(nodeUuids);
  const out: CanvasPositions = {};
  for (const [id, p] of entriesOf(positions)) {
    if (!keep.has(id) || !(Array.isArray(p) || isRecord(p))) continue;
    const { x, y } = p as Record<string, unknown>;
    if (!phpIsNumeric(x) || !phpIsNumeric(y)) continue;
    out[id] = { x: Math.trunc(Number(x)) || 0, y: Math.trunc(Number(y)) || 0 };
  }
  return out;
}

const morphKey = (type: string, id: string | number) => `${type}|${String(id)}`;

/** EnvironmentCanvas::linkPayload() */
const linkPayload = (link: DeployResourceLinkRow, source: string, target: string): CanvasLinkPayload => ({ id: link.uuid, source, target, label: link.label ?? null });

/** EnvironmentCanvas::graph()'s links: the ones with both ends among the resources, by uuid. */
export function canvasLinks(links: readonly DeployResourceLinkRow[], resources: readonly CanvasResourceRow[]): CanvasLinkPayload[] {
  const uuidByMorph = new Map(resources.map((r) => [morphKey(r.type, r.id), r.uuid]));
  const out: CanvasLinkPayload[] = [];
  for (const link of links) {
    const source = uuidByMorph.get(morphKey(link.source_type, link.source_id));
    const target = uuidByMorph.get(morphKey(link.target_type, link.target_id));
    if (source !== undefined && target !== undefined) out.push(linkPayload(link, source, target));
  }
  return out;
}

/** EnvironmentCanvasController::findEnvironment(): the environment within a project of the org (row-level security), by uuid. */
async function findEnvironment(ctx: ApplicationContext, projectUuid: string, environmentUuid: string) {
  const project = await ctx.store.findProject(projectUuid);
  if (!project) return { error: "Project not found." as const };
  const environment = await ctx.store.findEnvironment(project.id, environmentUuid);
  if (!environment) return { error: "Environment not found." as const };
  return { project, environment };
}

/** EnvironmentCanvasController::show(): the environment's canvas payload, or null when it is not the org's. */
export async function environmentCanvas(ctx: ApplicationContext, projectUuid: string, environmentUuid: string, canEdit = false): Promise<EnvironmentCanvasPayload | null> {
  const found = await findEnvironment(ctx, projectUuid, environmentUuid);
  if ("error" in found) return null;
  const { project, environment } = found;
  const applications = await ctx.store.listForEnvironment(environment.id);
  const services = ctx.store.listServiceCanvasRows ? await ctx.store.listServiceCanvasRows(environment.id) : [];
  const databases = ctx.store.listDatabasesForEnvironment ? await ctx.store.listDatabasesForEnvironment(environment.id) : [];
  const base = `/project/${project.uuid}/environment/${environment.uuid}`;
  const graph = canvasGraph(base, applications, services, databases);
  const canvas = ctx.store.canvas;
  const cards = new Set(graph.nodes.map((n) => n.id));
  const resources = canvas ? (await canvas.resources(environment.id)).filter((r) => cards.has(r.uuid)) : [];
  return {
    project: { uuid: project.uuid, name: project.name, link: `/project/${project.uuid}` },
    environment: { uuid: environment.uuid, name: environment.name, link: base },
    // $user->can('update', $environment) && the token may write: deploy.resource.write. A store that keeps no layout cannot save one.
    can_edit: canEdit && !!canvas,
    ...graph,
    links: canvas ? canvasLinks(await canvas.links(environment.id), resources) : [],
    positions: canvas ? filterPositions(await canvas.positions(environment.id), [...cards]) : {},
  };
}

/** What a save action answers: its data, or Coolify's message (and the field errors of a 422, the `error` of a 400). */
export type CanvasAnswer =
  | { ok: true; status: 200 | 201; data: unknown }
  | { ok: false; status: 400 | 404 | 422; message: string; errors?: Errors; error?: string };

const failed = (status: 400 | 404 | 422, message: string, extra: { errors?: Errors; error?: string } = {}): CanvasAnswer => ({ ok: false, status, message, ...extra });
const validationFailed = (errors: Errors) => failed(422, "Validation failed.", { errors });
/** validateIncomingRequest(): "Invalid request." with what is wrong with the body. */
function incoming(body: ApiBody): CanvasAnswer | null {
  if (!body.incomingError) return null;
  const parsed = JSON.parse(body.incomingError.body) as { message: string; error: string };
  return failed(400, parsed.message, { error: parsed.error });
}

/** EnvironmentCanvasController::validationFailedResponse(): the rules' errors, then "This field is not allowed." per extra field. */
async function rulesFailed(all: Record<string, unknown>, rules: Rules, allowed: readonly string[]): Promise<CanvasAnswer | null> {
  const errors: Errors = [];
  await validateRules(errors, all, rules, { laravelMessages: true });
  extraFields(errors, all, allowed);
  return errors.length ? validationFailed(errors) : null;
}

/** EnvironmentCanvasController::normalizeLabel(): a trimmed label, or null for an empty one. */
export function normalizeLabel(label: unknown): string | null {
  const text = (typeof label === "string" || typeof label === "number" ? String(label) : label === true ? "1" : "").trim();
  return text === "" ? null : text;
}

function needsCanvas(ctx: ApplicationContext): CanvasStore {
  if (!ctx.store.canvas) throw new Error("the canvas store is not configured");
  return ctx.store.canvas;
}

/** PATCH …/canvas/positions — EnvironmentCanvasController::updatePositions() */
export async function updateCanvasPositions(ctx: ApplicationContext, projectUuid: string, environmentUuid: string, body: ApiBody): Promise<CanvasAnswer> {
  const found = await findEnvironment(ctx, projectUuid, environmentUuid);
  if ("error" in found) return failed(404, found.error);
  const canvas = needsCanvas(ctx);
  const refused = incoming(body);
  if (refused) return refused;
  const all = body.all;
  const first = await rulesFailed(all, [["positions", ["present", "array", `max:${MAX_POSITIONS}`]]], ["positions"]);
  if (first) return first;

  const nodeUuids = (await canvas.resources(found.environment.id)).map((r) => r.uuid);
  const keep = new Set(nodeUuids);
  // collect($request->input('positions'))->only($nodeUuids)
  const positions = Object.fromEntries(entriesOf(all.positions).filter(([id]) => keep.has(id)));
  const coordinate: Rules[number][1] = ["required", "integer", `between:-${MAX_COORDINATE},${MAX_COORDINATE}`];
  const errors: Errors = [];
  await validateRules(
    errors,
    { positions },
    [
      ["positions.*", ["required", "array"]],
      ["positions.*.x", coordinate],
      ["positions.*.y", coordinate],
    ],
    // Laravel's explodeWildcardRules(): a card whose value is not an array still gets its x and y checked (as null).
    { laravelMessages: true, laravelWildcards: true },
  );
  if (errors.length) return validationFailed(errors);

  // DB::transaction(): the row locked, the saved positions merged with these, filtered and saved.
  const locked = await canvas.lockPositions(found.environment.id);
  if (!locked.found) return failed(404, "Environment not found.");
  const merged = filterPositions({ ...Object.fromEntries(entriesOf(locked.positions)), ...positions }, nodeUuids);
  await canvas.savePositions(found.environment.id, merged);
  return { ok: true, status: 200, data: { positions: merged } };
}

/** POST …/canvas/links — EnvironmentCanvasController::storeLink() */
export async function storeCanvasLink(ctx: ApplicationContext, projectUuid: string, environmentUuid: string, body: ApiBody): Promise<CanvasAnswer> {
  const found = await findEnvironment(ctx, projectUuid, environmentUuid);
  if ("error" in found) return failed(404, found.error);
  const canvas = needsCanvas(ctx);
  const refused = incoming(body);
  if (refused) return refused;
  const all = body.all;
  // 'different:source': the target is not (strictly) the source, when the request has one.
  const different: Rule = { closure: (value) => (Object.hasOwn(all, "source") && value === all.source ? ["The target field and source must be different."] : []) };
  const invalid = await rulesFailed(
    all,
    [
      ["source", ["required", "string", "max:255"]],
      ["target", ["required", "string", "max:255", different]],
      ["label", ["nullable", "string", "max:64"]],
    ],
    ["source", "target", "label"],
  );
  if (invalid) return invalid;

  const resources = new Map((await canvas.resources(found.environment.id)).map((r) => [r.uuid, r]));
  const source = resources.get(all.source as string);
  const target = resources.get(all.target as string);
  const errors: Errors = [];
  if (!source) addError(errors, "source", "The source must be a resource of this environment.");
  if (!target) addError(errors, "target", "The target must be a resource of this environment.");
  if (!source || !target) return validationFailed(errors);

  const ends: ResourceLinkEnds = { environmentId: found.environment.id, sourceType: source.type, sourceId: source.id, targetType: target.type, targetId: target.id };
  const duplicate = () => validationFailed([["target", ["These resources are already linked."]]]);
  if (await canvas.linkExists(ends)) return duplicate();
  const link = await canvas.insertLink({ ...ends, uuid: newPublicId(), label: normalizeLabel(all.label) });
  if (!link) return duplicate();
  return { ok: true, status: 201, data: linkPayload(link, source.uuid, target.uuid) };
}

/** The environment's link and its ends' uuids (null ends: one is no longer a resource of the environment). */
async function linkWithEnds(canvas: CanvasStore, environmentId: string | number, linkUuid: string) {
  const link = await canvas.findLink(environmentId, linkUuid);
  if (!link) return null;
  const resources = await canvas.resources(environmentId);
  const uuidOf = (type: string, id: string | number) => resources.find((r) => r.type === type && String(r.id) === String(id))?.uuid;
  const source = uuidOf(link.source_type, link.source_id);
  const target = uuidOf(link.target_type, link.target_id);
  return { link, ends: source === undefined || target === undefined ? null : { source, target } };
}

/** PATCH …/canvas/links/{link_uuid} — EnvironmentCanvasController::updateLink() */
export async function updateCanvasLink(ctx: ApplicationContext, projectUuid: string, environmentUuid: string, linkUuid: string, body: ApiBody): Promise<CanvasAnswer> {
  const found = await findEnvironment(ctx, projectUuid, environmentUuid);
  if ("error" in found) return failed(404, found.error);
  const canvas = needsCanvas(ctx);
  const refused = incoming(body);
  if (refused) return refused;
  const invalid = await rulesFailed(body.all, [["label", ["present", "nullable", "string", "max:64"]]], ["label"]);
  if (invalid) return invalid;
  const entry = await linkWithEnds(canvas, found.environment.id, linkUuid);
  if (!entry?.ends) return failed(404, "Link not found.");
  const updated = (await canvas.updateLabel(entry.link.id, normalizeLabel(body.all.label))) ?? entry.link;
  return { ok: true, status: 200, data: linkPayload(updated, entry.ends.source, entry.ends.target) };
}

/** DELETE …/canvas/links/{link_uuid} — EnvironmentCanvasController::destroyLink() */
export async function destroyCanvasLink(ctx: ApplicationContext, projectUuid: string, environmentUuid: string, linkUuid: string): Promise<CanvasAnswer> {
  const found = await findEnvironment(ctx, projectUuid, environmentUuid);
  if ("error" in found) return failed(404, found.error);
  const canvas = needsCanvas(ctx);
  const link = await canvas.findLink(found.environment.id, linkUuid);
  if (!link) return failed(404, "Link not found.");
  await canvas.deleteLink(link.id);
  return { ok: true, status: 200, data: { message: "Link deleted." } };
}

