// Derived from coollabsio/coolify@91b7e3e:app/Services/{EnvironmentCanvas,ProjectCanvas,ServerCanvas,SharedVariableCanvas,TagCanvas}.php,
// app/Http/Controllers/Api/{ProjectCanvas,ServerCanvas,SharedVariableCanvas,TagCanvas}Controller.php and
// app/Traits/EnvironmentVariableProtection.php (isEnvironmentVariableUsedInDockerCompose) (Apache-2.0), modified.
//
// The canvases that reuse the environment canvas's view (DP-98): the projects canvas and a project's
// (ProjectCanvas::teamPayload() and payload()), the servers canvas and a server's (ServerCanvas::payload()), the
// dashboard canvas (dashboardPayload(), with its deployments), the shared variable canvas of each scope
// (SharedVariableCanvas::payload(), its links read from the {{scope.KEY}} references in the resources' saved
// variables) and the tags canvas (TagCanvas::payload()). Cards are EnvironmentCanvas::graph()'s, built from the
// same rows as the environment canvas (applications/canvas.ts), with what each canvas adds: the project /
// environment context they are grouped and filtered by, the position saved on their environment canvas
// (`saved`), and the placeholder cards of environments, projects and servers without resources.
//
// The controllers' writes are ported where they map onto existing rows: the place of a project's or a server's
// zone (projects.canvas_position, servers.canvas_position), a shared variable added to a resource (a resource
// variable holding {{scope.KEY}}) or removed from it, and a tag attached or detached. Cards and links are moved
// and drawn through the environment canvas's own endpoints (DP-92). What runs a command on the server answers
// the SSH executor's 501: a functional server's unmanaged containers and its Sentinel usage.
//
// Departures: zones carry no IP (canReadSensitive is never granted to the console, as on the environment
// canvas); cards have no extra_zones (additional servers), image scan marker, favicon or service template logo
// (DP-91); a service with a queued or running start (startingServiceUuids(), Spatie's activity log) is not
// marked "starting": Freeploy keeps no activity log of starts.
import type {
  CanvasResourceRow,
  DeployApplicationRow,
  DeployCanvasDeploymentRow,
  DeployCanvasEnvironmentRow,
  DeployCanvasProjectRow,
  DeployCanvasServerRow,
  DeployCanvasVariableRow,
  DeployDatabaseRow,
  DeployOrgServiceCanvasRow,
  DeployResourceLinkRow,
  DeploySharedVariableRow,
  DeployTaggableRow,
  DeployTagRow,
  EnvironmentVariableResourceType,
  Taggable,
} from "@saas/db/deploy";
import { APPLICATION_MORPH_CLASS, DATABASE_TABLES, SERVICE_MORPH_CLASS } from "@saas/db/deploy";
import type { ApiBody, Errors } from "../api-v1/request.js";
import { validateRules, type Rules } from "../api-v1/rules.js";
import { parseDockerComposeYaml } from "../compose/yaml.js";
import { isPhpArray, type PhpValue } from "../compose/php.js";
import { canvasGraph, canvasLinks, failed, filterPositions, incoming, MAX_COORDINATE, MAX_POSITIONS, validationFailed, zoneOf, type CanvasAnswer, type CanvasLinkPayload, type CanvasNode, type CanvasZone } from "./canvas.js";

/** EnvironmentCanvas::EMPTY_ZONE */
export const EMPTY_ZONE = "empty";
/** SharedVariableCanvas::SOURCES_ZONE, CONNECTED_ZONE, RESOURCES_ZONE */
export const SOURCES_ZONE = "sources";
export const CONNECTED_ZONE = "connected";
export const RESOURCES_ZONE = "resources";
/** SharedVariableCanvas::BUILT_IN_SERVER_KEYS: the variables every server has, left out to stay readable. */
export const BUILT_IN_SERVER_KEYS: readonly string[] = ["COOLIFY_SERVER_UUID", "COOLIFY_SERVER_NAME"];
export const SHARED_VARIABLE_CANVAS_SCOPES = ["team", "project", "environment", "server"] as const;
export type CanvasScope = (typeof SHARED_VARIABLE_CANVAS_SCOPES)[number];

/** What the canvases read and write, in the org's transaction (packages/db deploy/canvas-views.ts and its neighbours). */
export interface CanvasViewsStore {
  environments(): Promise<DeployCanvasEnvironmentRow[]>;
  projects(): Promise<DeployCanvasProjectRow[]>;
  servers(): Promise<DeployCanvasServerRow[]>;
  applications(): Promise<DeployApplicationRow[]>;
  services(): Promise<DeployOrgServiceCanvasRow[]>;
  databases(): Promise<DeployDatabaseRow[]>;
  links(): Promise<DeployResourceLinkRow[]>;
  saveProjectPosition(id: string | number, position: { x: number; y: number }): Promise<boolean>;
  saveServerPosition(id: string | number, position: { x: number; y: number }): Promise<boolean>;
  deployments(serverIds: ReadonlyArray<string | number>, active: boolean): Promise<DeployCanvasDeploymentRow[]>;
  tags(): Promise<DeployTagRow[]>;
  taggables(): Promise<DeployTaggableRow[]>;
  attachTag(resource: Taggable, tagId: string | number): Promise<void>;
  detachTag(resource: Taggable, tagId: string | number): Promise<boolean>;
  /** The owner's shared variables (no values). */
  sharedVariables(scope: CanvasScope, ownerId: string | number | null): Promise<DeploySharedVariableRow[]>;
  /** The resources' saved variables (and their preview copies with `withPreview`), by key; values encrypted. */
  variables(resources: readonly Taggable[], withPreview: boolean): Promise<DeployCanvasVariableRow[]>;
  /** A resource variable's stored value, decrypted (null for none). */
  decrypt(value: string | null): Promise<string | null>;
  /** EnvironmentVariable::save() of a new variable on the resource (with an application's preview copy). */
  addVariable(resource: { type: EnvironmentVariableResourceType; uuid: string; id: string | number }, variable: { key: string; value: string; isMultiline: boolean; isLiteral: boolean }): Promise<void>;
  deleteVariables(ids: ReadonlyArray<string | number>): Promise<void>;
  /** The resource's Compose file (an application's or a service's), or null. */
  dockerCompose(resource: { type: EnvironmentVariableResourceType; uuid: string }): Promise<string | null>;
}

// ── Resources (ServerCanvas::loadResources()) ─────────────────────────

/** A top-level resource of the org with what the canvases need beside its card. */
export interface CanvasResource {
  uuid: string;
  name: string;
  id: string | number;
  /** Its morph class (taggable_type, resourceable_type, resource_links' ends). */
  type: string;
  /** Its Environment Variables page's type. */
  variableType: EnvironmentVariableResourceType;
  environmentId: string;
  /** SharedVariableCanvas::mainServer(): a service's own server, the destination's server otherwise. */
  mainServerId: string | null;
  /** Application with the dockercompose build pack, or a service (usesDockerCompose()). */
  usesCompose: boolean;
}

export interface CanvasData {
  environments: DeployCanvasEnvironmentRow[];
  servers: DeployCanvasServerRow[];
  resources: CanvasResource[];
  nodes: CanvasNode[];
  zones: CanvasZone[];
  rows: { applications: DeployApplicationRow[]; services: DeployOrgServiceCanvasRow[]; databases: DeployDatabaseRow[] };
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const environmentPage = (projectUuid: string, environmentUuid: string) => `/project/${projectUuid}/environment/${environmentUuid}`;

/**
 * ServerCanvas::loadResources() of the given environments and EnvironmentCanvas::graph() over them: applications,
 * services, then the databases engine by engine (keyBy('uuid') keeps that order), each card with the position
 * saved on its environment canvas (node.saved).
 */
export async function loadCanvas(store: CanvasViewsStore, keep: (environment: DeployCanvasEnvironmentRow) => boolean): Promise<CanvasData> {
  const [allEnvironments, servers, allApplications, allServices, allDatabases] = await Promise.all([store.environments(), store.servers(), store.applications(), store.services(), store.databases()]);
  const environments = allEnvironments.filter(keep);
  const byId = new Map(environments.map((e) => [str(e.id), e]));
  const shown = (row: { environment_id?: unknown }) => byId.has(str(row.environment_id));
  const applications = allApplications.filter(shown);
  const services = allServices.filter(shown);
  const databases = allDatabases.filter(shown);
  const base = (row: object) => {
    const e = byId.get(str((row as { environment_id?: unknown }).environment_id));
    return e ? environmentPage(e.project_uuid, e.uuid) : "";
  };
  const graph = canvasGraph(base, applications, services, databases);
  const serverIdByUuid = new Map(servers.map((s) => [s.uuid, str(s.id)]));
  const resources = new Map<string, CanvasResource>();
  for (const a of applications)
    resources.set(a.uuid, {
      uuid: a.uuid,
      name: a.name,
      id: a.id,
      type: APPLICATION_MORPH_CLASS,
      variableType: "application",
      environmentId: str(a.environment_id),
      mainServerId: a.server_uuid ? (serverIdByUuid.get(a.server_uuid) ?? null) : null,
      usesCompose: a.build_pack === "dockercompose",
    });
  for (const s of services)
    resources.set(s.uuid, { uuid: s.uuid, name: s.name, id: s.id, type: SERVICE_MORPH_CLASS, variableType: "service", environmentId: str(s.environment_id), mainServerId: s.server_id === null ? null : str(s.server_id), usesCompose: true });
  for (const d of databases)
    resources.set(d.uuid, {
      uuid: d.uuid,
      name: d.name,
      id: d.id,
      type: DATABASE_TABLES[d.engine as keyof typeof DATABASE_TABLES]?.morphClass ?? "",
      variableType: `standalone-${d.engine}` as EnvironmentVariableResourceType,
      environmentId: str(d.environment_id),
      mainServerId: d.server_id === null || d.server_id === undefined ? null : str(d.server_id),
      usesCompose: false,
    });
  const nodes = graph.nodes.map((node) => {
    const env = byId.get(resources.get(node.id)?.environmentId ?? "");
    // Other canvases keep the arrangement saved on the environment canvas inside each environment group.
    return { ...node, saved: env ? (filterPositions(env.canvas_positions, [node.id])[node.id] ?? null) : null };
  });
  // The graph's node order is the resources' order.
  const ordered = nodes.map((n) => resources.get(n.id)!).filter(Boolean);
  return { environments, servers, resources: ordered, nodes, zones: graph.zones, rows: { applications, services, databases } };
}

/** The canvas's resources as the environment canvas's links read them (uuid, morph type, id). */
const resourceIndex = (resources: readonly CanvasResource[]): CanvasResourceRow[] => resources.map((r) => ({ uuid: r.uuid, type: r.type, id: r.id }));

/** EnvironmentCanvas::graph()'s links over the resources: every environment's links with both ends among them. */
async function graphLinks(store: CanvasViewsStore, data: CanvasData): Promise<CanvasLinkPayload[]> {
  const ids = new Set(data.environments.map((e) => str(e.id)));
  return canvasLinks(
    (await store.links()).filter((l) => ids.has(str(l.environment_id))),
    resourceIndex(data.resources),
  );
}

/** EnvironmentCanvas::zonePosition(): a saved zone position, or null when the zone is placed automatically. */
export function zonePosition(saved: unknown): { x: number; y: number } | null {
  if (!saved || typeof saved !== "object") return null;
  const { x, y } = saved as Record<string, unknown>;
  const numeric = (v: unknown) => (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));
  return numeric(x) && numeric(y) ? { x: Math.trunc(Number(x)), y: Math.trunc(Number(y)) } : null;
}

/** EnvironmentCanvas::emptyZone() */
export const emptyZone = () => ({ id: EMPTY_ZONE, name: "Empty environments", icon: "service" });

type Owner = { project: { uuid: string; name: string }; environment: { uuid: string; name: string } };

/** ProjectCanvas::owner(): the project and environment of a card (the canvas saves links on that environment canvas). */
function owner(data: CanvasData, uuid: string): Owner {
  const env = data.environments.find((e) => str(e.id) === data.resources.find((r) => r.uuid === uuid)?.environmentId)!;
  return { project: { uuid: env.project_uuid, name: env.project_name }, environment: { uuid: env.uuid, name: env.name } };
}

/**
 * EnvironmentCanvas::projectZones(): the zone for a project's placeholder cards — the zone with most of the project's
 * cards, or `fallback` when it has none.
 */
export function projectZones(nodes: ReadonlyArray<{ zone?: string | null; project?: { uuid: string } | null }>, fallback: string): (projectUuid: string) => string {
  const counts = new Map<string, Map<string, number>>();
  for (const n of nodes) {
    if (!n.zone) continue;
    const project = n.project?.uuid ?? "";
    const of = counts.get(project) ?? new Map<string, number>();
    of.set(n.zone, (of.get(n.zone) ?? 0) + 1);
    counts.set(project, of);
  }
  // countBy()->sortDesc()->keys()->first(): the most cards, the first counted among equals.
  const zones = new Map([...counts].map(([project, of]) => [project, [...of].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0]]));
  return (projectUuid) => zones.get(projectUuid) ?? fallback;
}

/** EnvironmentCanvas::emptyNode(): the placeholder card of an environment without resources (or of a project without environments). */
export function emptyNode(project: { uuid: string; name: string }, environment: { uuid: string; name: string } | null, zone: string, context: string, canAdd = false) {
  const page = environment ? environmentPage(project.uuid, environment.uuid) : `/project/${project.uuid}`;
  const add = canAdd && !!environment;
  return {
    id: `empty:${environment?.uuid ?? project.uuid}`,
    type: "empty" as const,
    name: environment ? "No resources yet" : "No environments yet",
    subtitle: add ? "Click to add a resource" : `Open to see this ${environment ? "environment" : "project"}`,
    status: null,
    zone,
    extra_zones: [],
    urls: [],
    children: [],
    link: add ? `/canvas?${new URLSearchParams({ project: project.uuid, environment: environment!.uuid }).toString()}` : page,
    context,
    context_link: page,
    project: { uuid: project.uuid, name: project.name },
    environment: environment ? { uuid: environment.uuid, name: environment.name } : null,
  };
}

// ── Projects (ProjectCanvas) ──────────────────────────────────────────

/** ProjectCanvas::emptyNodes(): the placeholders of the project's environments without resources, or one for a project without environments. */
function emptyNodes(data: CanvasData, project: { id: string | number; uuid: string; name: string }, zone: string, canAdd: boolean) {
  const environments = data.environments.filter((e) => str(e.project_id) === str(project.id));
  if (!environments.length) return [emptyNode(project, null, zone, "No environments")];
  const used = new Set(data.resources.map((r) => r.environmentId));
  return environments.filter((e) => !used.has(str(e.id))).map((e) => emptyNode(project, e, zone, e.name, canAdd));
}

/** GET /projects/canvas — ProjectCanvas::teamPayload(): one zone per project, cards grouped by environment. */
export async function projectsCanvas(store: CanvasViewsStore, canEdit: boolean) {
  const projects = await store.projects();
  const data = await loadCanvas(store, () => true);
  const links = await graphLinks(store, data);
  const nodes = data.nodes.map((node) => {
    const o = owner(data, node.id);
    return { ...node, zone: o.project.uuid, extra_zones: [], context: o.environment.name, context_link: environmentPage(o.project.uuid, o.environment.uuid), ...o };
  });
  return {
    title: "Projects",
    title_link: "/projects",
    can_edit: canEdit,
    // Environment groups and cards keep their environment canvas arrangement.
    can_move: false,
    // Admins move groups and cards here; the canvas saves them on their environment canvas.
    can_move_groups: canEdit,
    // Admins move the project zones; each project saves its place (zone.position).
    can_move_zones: canEdit,
    layout: "server",
    zones: projects.map((p) => ({ id: p.uuid, name: p.name, icon: "projects", link: `/project/${p.uuid}`, position: zonePosition(p.canvas_position) })),
    nodes: [...nodes, ...projects.flatMap((p) => emptyNodes(data, p, p.uuid, canEdit))],
    links,
    positions: [],
  };
}

/** GET /projects/{uuid}/canvas — ProjectCanvas::payload(): every environment of one project, a zone per server. Null: "Project not found." */
export async function projectCanvas(store: CanvasViewsStore, uuid: string, canEdit: boolean) {
  const project = (await store.projects()).find((p) => p.uuid === uuid);
  if (!project) return null;
  const data = await loadCanvas(store, (e) => str(e.project_id) === str(project.id));
  const links = await graphLinks(store, data);
  const nodes = data.nodes.map((node) => {
    const o = owner(data, node.id);
    return { ...node, context: o.environment.name, context_link: environmentPage(project.uuid, o.environment.uuid), ...o };
  });
  // Placeholder cards sit on the server of the project's other environments.
  const zone = projectZones(nodes, data.zones[0]?.id ?? EMPTY_ZONE)(project.uuid);
  const empty = emptyNodes(data, project, zone, canEdit);
  return {
    title: project.name,
    title_link: `/project/${project.uuid}`,
    can_edit: canEdit,
    can_move: false,
    can_move_groups: canEdit,
    layout: "server",
    zones: empty.length && zone === EMPTY_ZONE ? [...data.zones, emptyZone()] : data.zones,
    nodes: [...nodes, ...empty],
    links,
    positions: [],
  };
}

// ── Servers and the dashboard (ServerCanvas) ──────────────────────────

/** ServerCanvas::details(): host facts and proxy of a server for its zone header. */
export function serverDetails(server: DeployCanvasServerRow) {
  const meta = (server.server_metadata && typeof server.server_metadata === "object" ? server.server_metadata : {}) as Record<string, unknown>;
  const proxy = (server.proxy && typeof server.proxy === "object" ? server.proxy : {}) as Record<string, unknown>;
  const proxyType = typeof proxy.type === "string" && proxy.type !== "" ? proxy.type : null;
  const number = (v: unknown) => (v === undefined || v === null ? null : Math.trunc(Number(v)) || 0);
  const live = !!server.is_reachable && !!server.is_metrics_enabled;
  return {
    os: (meta.os as string | undefined) ?? null,
    arch: (meta.arch as string | undefined) ?? null,
    cpus: number(meta.cpus),
    memory_bytes: number(meta.memory_bytes),
    uptime_since: (meta.uptime_since as string | undefined) ?? null,
    proxy: proxyType && proxyType !== "NONE" ? { type: proxyType, status: (proxy.status as string | undefined) ?? null } : null,
    usage_endpoint: live ? `/servers/${server.uuid}/canvas/usage` : null,
  };
}

/** EnvironmentCanvas::zone() of a server row (no IP: the console never reads sensitive data). */
const serverZone = (server: DeployCanvasServerRow): CanvasZone =>
  zoneOf({ server_uuid: server.uuid, server_name: server.name, server_is_reachable: server.is_reachable, server_is_usable: server.is_usable });

/** ServerCanvas::payload(): every server of the org (or one) with every resource on it. */
async function serversPayload(store: CanvasViewsStore, single: DeployCanvasServerRow | null, canEdit: boolean) {
  const data = await loadCanvas(store, () => true);
  const servers = single ? [single] : data.servers;
  const links = await graphLinks(store, data);
  const serverUuids = servers.map((s) => s.uuid);
  const nodes = data.nodes
    .filter((n) => [n.zone, ...n.extra_zones].some((z) => !!z && serverUuids.includes(z)))
    .map((node) => {
      const o = owner(data, node.id);
      // A resource that also runs on a shown server (additional server) sits in that server's zone.
      const zone = node.zone && serverUuids.includes(node.zone) ? node.zone : (node.extra_zones.find((u) => serverUuids.includes(u)) ?? null);
      return { ...node, zone, context: `${o.project.name} / ${o.environment.name}`, context_link: environmentPage(o.project.uuid, o.environment.uuid), ...o };
    });
  const shown = new Set(nodes.map((n) => n.id));
  // Every-server canvases: environments without resources show as placeholder cards next to the other environments of their project.
  const used = new Set(data.resources.map((r) => r.environmentId));
  const zoneOfProject = projectZones(nodes, serverUuids[0] ?? EMPTY_ZONE);
  const empty = single
    ? []
    : data.environments
        .filter((e) => !used.has(str(e.id)))
        .map((e) => emptyNode({ uuid: e.project_uuid, name: e.project_name }, e, zoneOfProject(e.project_uuid), `${e.project_name} / ${e.name}`, canEdit));
  // The canvas draws a zone around its cards, so a server without cards gets a placeholder card.
  const filled = new Set<string | null>([...nodes, ...empty].map((n) => n.zone));
  const bare = servers
    .filter((s) => !filled.has(s.uuid))
    .map((s) => ({
      id: `empty-server:${s.uuid}`,
      type: "empty" as const,
      name: "No resources yet",
      subtitle: "Open to see this server",
      status: null,
      zone: s.uuid,
      extra_zones: [],
      urls: [],
      children: [],
      link: `/server/${s.uuid}`,
      context: null,
      project: null,
      environment: null,
    }));
  const zones: Array<Record<string, unknown>> = servers.map((s) => ({ ...serverZone(s), details: serverDetails(s), position: single ? null : zonePosition(s.canvas_position) }));
  if (empty.some((n) => n.zone === EMPTY_ZONE)) zones.push(emptyZone());
  const payload = {
    title: single ? single.name : "Servers",
    title_link: single ? `/server/${single.uuid}` : null,
    // Unmanaged containers need a command on the server, so the canvas loads them after it renders.
    containers_endpoint: single ? `/servers/${single.uuid}/canvas/containers` : null,
    can_edit: canEdit,
    can_move: false,
    // Admins drag the project / environment group boxes; the canvas saves the moved cards on their environment canvas.
    can_move_groups: canEdit,
    // Admins move the server zones of the every-server canvases; each server saves its place (zone.position).
    can_move_zones: canEdit && !single,
    layout: "server",
    zones,
    nodes: [...nodes, ...empty, ...bare] as Array<Record<string, unknown> & { id: string; type: string }>,
    links: links.filter((l) => shown.has(l.source) && shown.has(l.target)),
    positions: [],
  };
  return { payload, servers };
}

/** GET /servers/canvas — ServerCanvasController::index() */
export async function serversCanvas(store: CanvasViewsStore, canEdit: boolean) {
  return (await serversPayload(store, null, canEdit)).payload;
}

/** GET /servers/{uuid}/canvas — ServerCanvasController::show(). Null: "Server not found." */
export async function serverCanvas(store: CanvasViewsStore, uuid: string, canEdit: boolean) {
  const server = (await store.servers()).find((s) => s.uuid === uuid);
  if (!server) return null;
  return (await serversPayload(store, server, canEdit)).payload;
}

/** GET /dashboard/canvas — ServerCanvas::dashboardPayload(): the server canvas, each application's running or queued deployment, and the list of deployments. */
export async function dashboardCanvas(store: CanvasViewsStore, canEdit: boolean) {
  const { payload, servers } = await serversPayload(store, null, canEdit);
  const ids = servers.map((s) => s.id);
  const [active, recent] = await Promise.all([store.deployments(ids, true), store.deployments(ids, false)]);
  const summary = (d: DeployCanvasDeploymentRow) => ({ status: d.status, link: d.deployment_url, pull_request_id: Number(d.pull_request_id) || null });
  const byUuid = new Map<string, ReturnType<typeof summary>>();
  // unique('application_id'): the first (oldest) deployment of each application.
  const seen = new Set<string>();
  for (const d of active) {
    if (!d.application_uuid || seen.has(str(d.application_id))) continue;
    seen.add(str(d.application_id));
    byUuid.set(d.application_uuid, summary(d));
  }
  return {
    ...payload,
    title: "Dashboard",
    title_link: "/dashboard",
    nodes: payload.nodes.map((node) => (node.type === "application" && byUuid.has(node.id) ? { ...node, deployment: byUuid.get(node.id) } : node)),
    // The deployment panel: running and queued deployments first, then the latest finished ones.
    deployments: [...active, ...recent].map((d) => ({
      id: d.deployment_uuid,
      application: d.application_uuid,
      name: d.application_name,
      server: d.server_name,
      created_at: d.created_at,
      finished_at: d.finished_at,
      ...summary(d),
    })),
  };
}

/** Server::isFunctional(): reachable, usable and not disabled. */
export const isFunctional = (server: Pick<DeployCanvasServerRow, "is_reachable" | "is_usable" | "force_disabled">) => !!server.is_reachable && !!server.is_usable && !server.force_disabled;

export const CANVAS_VIEW_MESSAGES = {
  containersUnavailable: "Listing the containers on the server needs the SSH executor, which is not available yet.",
  usageUnavailable: "Reading the server's usage from Sentinel needs the SSH executor, which is not available yet.",
} as const;

/**
 * GET /servers/{uuid}/canvas/containers — ServerCanvas::unmanagedContainerNodes(): none for a server that is not
 * functional (Server::loadUnmanagedContainers()); listing a functional one's runs docker on it: the SSH executor's 501.
 */
export async function serverCanvasContainers(store: CanvasViewsStore, uuid: string): Promise<CanvasAnswer> {
  const server = (await store.servers()).find((s) => s.uuid === uuid);
  if (!server) return failed(404, "Server not found.");
  if (!isFunctional(server)) return { ok: true, status: 200, data: { nodes: [] } };
  return failed(501, CANVAS_VIEW_MESSAGES.containersUnavailable);
}

/** GET /servers/{uuid}/canvas/usage — ServerCanvasController::usage(): no data without metrics; Sentinel's numbers need the SSH executor (501). */
export async function serverCanvasUsage(store: CanvasViewsStore, uuid: string): Promise<CanvasAnswer> {
  const server = (await store.servers()).find((s) => s.uuid === uuid);
  if (!server) return failed(404, "Server not found.");
  if (!server.is_metrics_enabled) return { ok: true, status: 200, data: { cpu: null, memory: null, disk: null } };
  return failed(501, CANVAS_VIEW_MESSAGES.usageUnavailable);
}

/**
 * PATCH /projects/canvas/positions and /servers/canvas/positions (also /dashboard/canvas/positions) —
 * ProjectCanvasController::updatePositions() and ServerCanvasController::updatePositions(): the top-left of each moved
 * zone, keyed by project or server uuid; those of other orgs (and unknown uuids) are left out.
 */
export async function updateZonePositions(store: CanvasViewsStore, kind: "projects" | "servers", body: ApiBody): Promise<CanvasAnswer> {
  const refused = incoming(body);
  if (refused) return refused;
  const coordinate: Rules[number][1] = ["required", "integer", `between:-${MAX_COORDINATE},${MAX_COORDINATE}`];
  const errors: Errors = [];
  await validateRules(
    errors,
    body.all,
    [
      ["positions", ["required", "array", `max:${MAX_POSITIONS}`]],
      ["positions.*", ["required", "array"]],
      ["positions.*.x", coordinate],
      ["positions.*.y", coordinate],
    ],
    { laravelMessages: true, laravelWildcards: true },
  );
  if (errors.length) return validationFailed(errors);
  const positions = body.all.positions as Record<string, { x: unknown; y: unknown }>;
  const rows: Array<{ id: string | number; uuid: string }> = kind === "projects" ? await store.projects() : await store.servers();
  const saved: Record<string, { x: number; y: number }> = {};
  for (const row of rows.filter((r) => Object.hasOwn(positions, r.uuid))) {
    const at = positions[row.uuid]!;
    const position = { x: Math.trunc(Number(at.x)), y: Math.trunc(Number(at.y)) };
    if (kind === "projects" ? await store.saveProjectPosition(row.id, position) : await store.saveServerPosition(row.id, position)) saved[row.uuid] = position;
  }
  return { ok: true, status: 200, data: { positions: saved } };
}

// ── The connect view: shared variables and tags ───────────────────────

/** SharedVariableCanvas::resourceNodes(): resource cards with the project / environment the canvas groups and filters them by. */
function resourceNodes(data: CanvasData, resources: readonly CanvasResource[]) {
  const nodes = new Map(data.nodes.map((n) => [n.id, n]));
  return resources.map((r) => {
    const o = owner(data, r.uuid);
    // graph($resources, collect(), false): no links, no IP.
    return { ...nodes.get(r.uuid)!, zone: RESOURCES_ZONE, extra_zones: [], context: `${o.project.name} / ${o.environment.name}`, context_link: environmentPage(o.project.uuid, o.environment.uuid), ...o };
  });
}

/** mb_strtolower($resource->name), as sortBy() compares it. */
const byLowerName = (a: { name: string }, b: { name: string }) => {
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

/** A scope's owner (SharedVariableCanvasController::findOwner()): the org, or its project, environment or server by uuid. */
export interface CanvasScopeOwner {
  scope: CanvasScope;
  id: string | number | null;
  uuid: string | null;
  name: string;
  /** The environment's project (environment scope). */
  project: { uuid: string; name: string } | null;
}

/** findOwner(): the owner, or null for "<Scope> not found.". */
export async function findScopeOwner(store: CanvasViewsStore, scope: CanvasScope, uuid: string | null): Promise<CanvasScopeOwner | null> {
  if (scope === "team") return { scope, id: null, uuid: null, name: "Team", project: null };
  if (scope === "project") {
    const p = (await store.projects()).find((x) => x.uuid === uuid);
    return p ? { scope, id: p.id, uuid: p.uuid, name: p.name, project: null } : null;
  }
  if (scope === "environment") {
    const e = (await store.environments()).find((x) => x.uuid === uuid);
    return e ? { scope, id: e.id, uuid: e.uuid, name: e.name, project: { uuid: e.project_uuid, name: e.project_name } } : null;
  }
  const s = (await store.servers()).find((x) => x.uuid === uuid);
  return s ? { scope, id: s.id, uuid: s.uuid, name: s.name, project: null } : null;
}

export const scopeHeadline = (scope: CanvasScope) => scope.charAt(0).toUpperCase() + scope.slice(1);
export const ownerNotFound = (scope: CanvasScope) => `${scopeHeadline(scope)} not found.`;

/** SharedVariableCanvas::resources(): the resources that can use the scope's variables, by name. */
export async function scopeResources(store: CanvasViewsStore, owner: CanvasScopeOwner): Promise<{ data: CanvasData; resources: CanvasResource[] }> {
  const keep = (e: DeployCanvasEnvironmentRow) =>
    owner.scope === "project" ? str(e.project_id) === str(owner.id) : owner.scope === "environment" ? str(e.id) === str(owner.id) : true;
  const data = await loadCanvas(store, keep);
  // {{server.KEY}} resolves against the main server of the resource.
  const resources = (owner.scope === "server" ? data.resources.filter((r) => r.mainServerId === str(owner.id)) : [...data.resources]).sort(byLowerName);
  return { data, resources };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/#-]/g, "\\$&");

/** SharedVariableCanvas::referencedKeys(): the keys of the scope's shared variables the value references. */
export function referencedKeys(scope: CanvasScope, value: string | null): string[] {
  if (value === null || value.trim() === "") return [];
  const re = new RegExp(`{{\\s*${escapeRegExp(scope)}\\.(.+?)\\s*}}`, "g");
  return [...new Set([...value.matchAll(re)].map((m) => m[1]!))];
}

/** SharedVariableCanvas::isExactReference() */
export function isExactReference(scope: CanvasScope, key: string, value: string | null): boolean {
  return new RegExp(`^{{\\s*${escapeRegExp(scope)}\\.${escapeRegExp(key)}\\s*}}$`).test(String(value ?? "").trim());
}

/** SharedVariableCanvas::reference() */
export const reference = (scope: CanvasScope, key: string) => `{{${scope}.${key}}}`;
/** SharedVariableCanvas::variableNodeId() */
export const variableNodeId = (variable: { id: string | number }) => `variable:${variable.id}`;

/** array_pad(explode('|', $link_id, 2), 2, ''): "<source card>|<resource uuid>". */
export function splitLinkId(linkId: string): { source: string; target: string } {
  const at = linkId.indexOf("|");
  return at === -1 ? { source: linkId, target: "" } : { source: linkId.slice(0, at), target: linkId.slice(at + 1) };
}

export interface ConnectLink {
  id: string;
  source: string;
  target: string;
  key: string;
  keys: string[];
  label: string | null;
  removable: boolean;
  missing: boolean;
}

/** SharedVariableCanvas::links(): one link per (shared variable, resource) pair where a variable of the resource references it. */
export async function variableLinks(store: CanvasViewsStore, scope: CanvasScope, variables: readonly DeploySharedVariableRow[], resources: readonly CanvasResource[]): Promise<ConnectLink[]> {
  const nodeIdByKey = new Map(variables.map((v) => [v.key, variableNodeId(v)]));
  const byMorph = new Map(resources.map((r) => [`${r.type}#${str(r.id)}`, r]));
  const links = new Map<string, ConnectLink>();
  for (const row of await store.variables(resources, false)) {
    const resource = byMorph.get(`${row.resourceable_type}#${str(row.resourceable_id)}`);
    if (!resource) continue;
    const value = await store.decrypt(row.value);
    for (const key of referencedKeys(scope, value)) {
      const source = nodeIdByKey.get(key) ?? `missing:${key}`;
      const id = `${source}|${resource.uuid}`;
      const link = links.get(id) ?? { id, source, target: resource.uuid, key, keys: [], label: null, removable: true, missing: !nodeIdByKey.has(key) };
      link.keys.push(row.key);
      // Only a variable that holds nothing but the reference can be removed from the canvas.
      link.removable = link.removable && isExactReference(scope, key, value);
      links.set(id, link);
    }
  }
  return [...links.values()].map((link) => {
    const keys = [...new Set(link.keys)];
    // Label the link when the resource uses another name for the variable.
    return { ...link, keys, label: keys.length === 1 && keys[0] === link.key ? null : keys.join(", ") };
  });
}

/** The scope owner's shared variables by key (SharedVariableCanvas::variables()), the server's built-in ones left out. */
async function scopeVariables(store: CanvasViewsStore, owner: CanvasScopeOwner) {
  const hidden = owner.scope === "server" ? BUILT_IN_SERVER_KEYS : [];
  return (await store.sharedVariables(owner.scope, owner.id)).filter((v) => !hidden.includes(v.key)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** SharedVariableCanvas::title() */
const scopeTitle = (owner: CanvasScopeOwner) =>
  owner.scope === "team" ? "Team variables" : owner.scope === "environment" ? `${owner.project!.name} / ${owner.name} variables` : `${owner.name} variables`;

/** SharedVariableCanvas::pageLink() */
const scopePage = (owner: CanvasScopeOwner) =>
  owner.scope === "team"
    ? "/shared-variables/team"
    : owner.scope === "project"
      ? `/shared-variables/project/${owner.uuid}`
      : owner.scope === "environment"
        ? `/shared-variables/environments/project/${owner.project!.uuid}/environment/${owner.uuid}`
        : `/shared-variables/server/${owner.uuid}`;

/** GET /shared-variables/{team | {scope}/{uuid}}/canvas — SharedVariableCanvas::payload() */
export async function sharedVariableCanvas(store: CanvasViewsStore, owner: CanvasScopeOwner, canEdit: boolean) {
  const { scope } = owner;
  const hidden = scope === "server" ? BUILT_IN_SERVER_KEYS : [];
  const variables = await scopeVariables(store, owner);
  const { data, resources } = await scopeResources(store, owner);
  // A reference to a hidden variable is not a reference to a deleted one: leave its link out too.
  const links = (await variableLinks(store, scope, variables, resources)).filter((l) => !hidden.includes(l.key));
  const seen = new Set<string>();
  const missing = links
    .filter((l) => l.missing && !seen.has(l.source) && !!seen.add(l.source))
    .map((l) => ({ id: l.source, type: "variable", name: l.key, subtitle: "Deleted shared variable", reference: reference(scope, l.key), missing: true, zone: SOURCES_ZONE, extra_zones: [], status: null }));
  return {
    title: scopeTitle(owner),
    title_link: scopePage(owner),
    can_edit: canEdit,
    can_move: false,
    layout: "connect",
    scope,
    zones: [
      { id: SOURCES_ZONE, name: `${scopeHeadline(scope)} variables`, icon: "variable" },
      // The canvas moves the resources that use a variable into this zone.
      { id: CONNECTED_ZONE, name: "Using these variables", icon: "link" },
      { id: RESOURCES_ZONE, name: "Other resources", icon: "service" },
    ],
    nodes: [
      ...variables.map((v) => ({
        id: variableNodeId(v),
        type: "variable",
        name: v.key,
        subtitle: v.comment !== null && v.comment.trim() !== "" ? v.comment : `${scopeHeadline(scope)} variable`,
        reference: reference(scope, v.key),
        missing: false,
        zone: SOURCES_ZONE,
        extra_zones: [],
        status: null,
      })),
      ...missing,
      ...resourceNodes(data, resources),
    ],
    links,
    positions: [],
  };
}

/** The shared variable a card id names ("variable:<id>"), if it is the owner's. */
async function findVariable(store: CanvasViewsStore, owner: CanvasScopeOwner, nodeId: unknown) {
  const id = typeof nodeId === "string" && nodeId.startsWith("variable:") ? nodeId.slice("variable:".length) : null;
  if (id === null) return null;
  // whereKey((int) …)
  const key = String(parseInt(id, 10) || 0);
  return (await store.sharedVariables(owner.scope, owner.id)).find((v) => str(v.id) === key) ?? null;
}

/** POST …/canvas/links — SharedVariableCanvasController::storeLink(): adds {{scope.KEY}} to a resource as a variable named KEY. */
export async function storeVariableLink(store: CanvasViewsStore, owner: CanvasScopeOwner, body: ApiBody): Promise<CanvasAnswer> {
  const refused = incoming(body);
  if (refused) return refused;
  const all = body.all;
  const errors: Errors = [];
  await validateRules(
    errors,
    all,
    [
      ["source", ["required", "string", "max:255"]],
      ["target", ["required", "string", "max:255"]],
    ],
    { laravelMessages: true },
  );
  if (errors.length) return validationFailed(errors);
  const variable = await findVariable(store, owner, all.source);
  const { resources } = await scopeResources(store, owner);
  const resource = resources.find((r) => r.uuid === all.target);
  const problems: Errors = [];
  if (!variable) problems.push(["source", ["The source must be a shared variable of this scope."]]);
  if (!resource) problems.push(["target", ["The target must be a resource that can use this shared variable."]]);
  if (!variable || !resource) return validationFailed(problems);

  const existing = (await store.variables([resource], false)).find((v) => v.key === variable.key);
  if (existing) {
    const message = referencedKeys(owner.scope, await store.decrypt(existing.value)).includes(variable.key)
      ? `${resource.name} already uses ${variable.key}.`
      : `${resource.name} already has a variable named ${variable.key}. Rename or remove it first.`;
    return failed(422, message, { errors: [["target", [message]]] });
  }
  await store.addVariable({ type: resource.variableType, uuid: resource.uuid, id: resource.id }, { key: variable.key, value: reference(owner.scope, variable.key), isMultiline: !!variable.is_multiline, isLiteral: !!variable.is_literal });
  const link = (await variableLinks(store, owner.scope, [variable], [resource])).find((l) => l.source === variableNodeId(variable));
  return { ok: true, status: 201, data: link ?? null };
}

/** EnvironmentVariableProtection::isEnvironmentVariableUsedInDockerCompose(): [used, reason]. */
export function usedInDockerCompose(key: string, dockerCompose: string | null): [boolean, string] {
  if (!dockerCompose) return [false, ""];
  let parsed: PhpValue;
  try {
    parsed = parseDockerComposeYaml(dockerCompose);
  } catch {
    // If there's an error parsing the Docker Compose file, we'll assume it's not used.
    return [false, ""];
  }
  const services = isPhpArray(parsed) ? parsed.get("services") : undefined;
  // data_get($data, 'services.*.environment')
  const environments = isPhpArray(services) ? services.values().map((s) => (isPhpArray(s) ? s.get("environment") : undefined)) : [];
  for (const envs of environments) {
    if (!isPhpArray(envs)) continue;
    for (const env of envs.keys()) if (env === key) return [true, `Environment variable '${key}' is used directly in the Docker Compose file.`];
    for (const value of envs.values()) if (typeof value === "string" && value.includes(`$${key}`)) return [true, `Environment variable '${key}' is referenced in the Docker Compose file.`];
  }
  return [false, ""];
}

/** DELETE …/canvas/links/{link_id} — SharedVariableCanvasController::destroyLink(): removes the resource's variables that reference the shared variable. */
export async function destroyVariableLink(store: CanvasViewsStore, owner: CanvasScopeOwner, linkId: string): Promise<CanvasAnswer> {
  const { source, target } = splitLinkId(linkId);
  const { resources } = await scopeResources(store, owner);
  const resource = resources.find((r) => r.uuid === target);
  const variable = await findVariable(store, owner, source);
  const key = variable?.key ?? (source.startsWith("missing:") ? source.slice("missing:".length) : null);
  if (!resource || key === null || key.trim() === "") return failed(404, "Link not found.");

  // Preview copies of application variables are removed together with the variable.
  const references: Array<DeployCanvasVariableRow & { plain: string | null }> = [];
  for (const row of await store.variables([resource], true)) {
    const plain = await store.decrypt(row.value);
    if (referencedKeys(owner.scope, plain).includes(key)) references.push({ ...row, plain });
  }
  if (!references.some((r) => !r.is_preview)) return failed(404, "Link not found.");
  const embedded = references.filter((r) => !isExactReference(owner.scope, key, r.plain));
  if (embedded.length) {
    return failed(422, `${[...new Set(embedded.map((r) => r.key))].join(", ")} on ${resource.name} uses ${reference(owner.scope, key)} inside a longer value. Edit it on the resource.`);
  }
  if (resource.usesCompose) {
    const compose = await store.dockerCompose({ type: resource.variableType, uuid: resource.uuid });
    for (const environmentKey of [...new Set(references.map((r) => r.key))]) {
      const [used, reason] = usedInDockerCompose(environmentKey, compose);
      if (used) return failed(422, `Cannot remove ${environmentKey} from ${resource.name}. ${reason}`);
    }
  }
  await store.deleteVariables(references.map((r) => r.id));
  return { ok: true, status: 200, data: { message: "Link removed." } };
}

/** TagCanvas::nodeId() */
export const tagNodeId = (tag: { uuid: string }) => `tag:${tag.uuid}`;
/** TagCanvas::link() */
const tagLink = (tag: DeployTagRow, resource: CanvasResource): ConnectLink => {
  const source = tagNodeId(tag);
  return { id: `${source}|${resource.uuid}`, source, target: resource.uuid, key: tag.name, keys: [], label: null, removable: true, missing: false };
};

/** TagCanvas::resources(): every resource of the org with its tags (in the pivot's order), by name. */
async function taggedResources(store: CanvasViewsStore) {
  const data = await loadCanvas(store, () => true);
  const pivot = await store.taggables();
  const resources = [...data.resources].sort(byLowerName);
  const tagIds = (r: CanvasResource) => pivot.filter((p) => p.taggable_type === r.type && str(p.taggable_id) === str(r.id)).map((p) => str(p.tag_id));
  return { data, resources, tagIds };
}

/** GET /tags/canvas — TagCanvas::payload(): the tags on the left, the resources on the right, a link for every tag on a resource. */
export async function tagsCanvas(store: CanvasViewsStore, canEdit: boolean) {
  const tags = await store.tags();
  const { data, resources, tagIds } = await taggedResources(store);
  const byId = new Map(tags.map((t) => [str(t.id), t]));
  return {
    title: "Tags",
    title_link: "/tags",
    can_edit: canEdit,
    can_move: false,
    layout: "connect",
    zones: [
      { id: SOURCES_ZONE, name: "Tags", icon: "tag" },
      // The canvas moves the tagged resources into this zone.
      { id: CONNECTED_ZONE, name: "Tagged resources", icon: "link" },
      { id: RESOURCES_ZONE, name: "Other resources", icon: "service" },
    ],
    nodes: [
      ...tags.map((t) => ({ id: tagNodeId(t), type: "tag", name: t.name, link: `/tags/${encodeURIComponent(t.name)}`, missing: false, zone: SOURCES_ZONE, extra_zones: [], status: null })),
      ...resourceNodes(data, resources),
    ],
    links: resources.flatMap((r) => tagIds(r).flatMap((id) => (byId.has(id) ? [tagLink(byId.get(id)!, r)] : []))),
    positions: [],
  };
}

/** The tag a card id names ("tag:<uuid>"), if it is the org's. */
async function findTag(store: CanvasViewsStore, nodeId: unknown) {
  if (typeof nodeId !== "string" || !nodeId.startsWith("tag:")) return null;
  const uuid = nodeId.slice("tag:".length);
  return (await store.tags()).find((t) => t.uuid === uuid) ?? null;
}

/** POST /tags/canvas/links — TagCanvasController::storeLink(): tags the resource. */
export async function storeTagLink(store: CanvasViewsStore, body: ApiBody): Promise<CanvasAnswer> {
  const refused = incoming(body);
  if (refused) return refused;
  const all = body.all;
  const errors: Errors = [];
  await validateRules(
    errors,
    all,
    [
      ["source", ["required", "string", "max:255"]],
      ["target", ["required", "string", "max:255"]],
    ],
    { laravelMessages: true },
  );
  if (errors.length) return validationFailed(errors);
  const tag = await findTag(store, all.source);
  const { resources, tagIds } = await taggedResources(store);
  const resource = resources.find((r) => r.uuid === all.target);
  const problems: Errors = [];
  if (!tag) problems.push(["source", ["The source must be a tag of this team."]]);
  if (!resource) problems.push(["target", ["The target must be a resource of this team."]]);
  if (!tag || !resource) return validationFailed(problems);
  if (tagIds(resource).includes(str(tag.id))) {
    const message = `${resource.name} already has the ${tag.name} tag.`;
    return failed(422, message, { errors: [["target", [message]]] });
  }
  await store.attachTag({ type: resource.type, id: resource.id }, tag.id);
  return { ok: true, status: 201, data: tagLink(tag, resource) };
}

/** DELETE /tags/canvas/links/{link_id} — TagCanvasController::destroyLink(): untags the resource; the tag stays, also without resources. */
export async function destroyTagLink(store: CanvasViewsStore, linkId: string): Promise<CanvasAnswer> {
  const { source, target } = splitLinkId(linkId);
  const tag = await findTag(store, source);
  const { resources, tagIds } = await taggedResources(store);
  const resource = resources.find((r) => r.uuid === target);
  if (!tag || !resource || !tagIds(resource).includes(str(tag.id))) return failed(404, "Link not found.");
  await store.detachTag({ type: resource.type, id: resource.id }, tag.id);
  return { ok: true, status: 200, data: { message: "Link removed." } };
}
