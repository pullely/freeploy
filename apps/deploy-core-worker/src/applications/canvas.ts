// Derived from coollabsio/coolify@91b7e3e:app/Services/EnvironmentCanvas.php and
// app/Http/Controllers/Api/EnvironmentCanvasController.php (Apache-2.0), modified.
//
// The environment canvas's graph (DP-91): server zones, resource cards and their
// statuses, as EnvironmentCanvas::payload() builds them for the Svelte canvas
// (resources/js/canvas/environment/*), which deploy-web ports to React.
// Cards hold summary fields only: never environment variables, passwords,
// keys or connection URLs.
//
// Read only. Freeploy saves no card positions and no links yet, so `positions`
// and `links` are always empty and `can_edit` is false: the canvas says it is
// view only. Not built: extra_zones (an application's additional servers), the
// image scan marker (`security`), a domain's favicon and a service template's
// logo, and the server, project, dashboard, shared variable and tag canvases.
import type { DeployApplicationRow, DeployDatabaseRow, DeployEnvironmentServiceCanvasRow } from "@saas/db/deploy";
import type { ApplicationContext } from "./service.js";
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

export interface EnvironmentCanvasPayload {
  project: { uuid: string; name: string; link: string };
  environment: { uuid: string; name: string; link: string };
  can_edit: false;
  zones: CanvasZone[];
  nodes: CanvasNode[];
  links: never[];
  positions: Record<string, never>;
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

/** EnvironmentCanvasController::show(): the environment's canvas payload, or null when it is not the org's. */
export async function environmentCanvas(ctx: ApplicationContext, projectUuid: string, environmentUuid: string): Promise<EnvironmentCanvasPayload | null> {
  const project = await ctx.store.findProject(projectUuid);
  if (!project) return null;
  const environment = await ctx.store.findEnvironment(project.id, environmentUuid);
  if (!environment) return null;
  const applications = await ctx.store.listForEnvironment(environment.id);
  const services = ctx.store.listServiceCanvasRows ? await ctx.store.listServiceCanvasRows(environment.id) : [];
  const databases = ctx.store.listDatabasesForEnvironment ? await ctx.store.listDatabasesForEnvironment(environment.id) : [];
  const base = `/project/${project.uuid}/environment/${environment.uuid}`;
  return {
    project: { uuid: project.uuid, name: project.name, link: `/project/${project.uuid}` },
    environment: { uuid: environment.uuid, name: environment.name, link: base },
    can_edit: false,
    ...canvasGraph(base, applications, services, databases),
    links: [],
    positions: {},
  };
}
