// Derived from coollabsio/coolify@91b7e3e:app/Services/DockerRegistryLogins.php (usersOf,
// applicationsBuiltOnBuildServers), app/Models/Server.php (applications, primaryApplications, databases, services,
// ownedByCurrentTeam) and app/Models/Application.php (mustBuildOnBuildServer, isBuildServerEnabled,
// supportsBuildServer) (Apache-2.0), modified.
//
// Docker registries have no table: Coolify keeps a registry login only on the
// server, in the Docker config that `docker login` writes, and "does not save
// the token". What the database knows is which resources of a server pull or
// push a named image; these queries list them, with the image whose registry
// the caller works out. Every function takes the transaction of withOrg():
// row-level security confines each query to that org.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { DESTINATION_MORPH_CLASS } from "./destinations.js";

/** What the registries overview needs of a server: its name and what isFunctional() and isBuildServer() read. */
export interface DeployRegistryServerRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  ip: string;
  is_reachable: boolean | null;
  is_usable: boolean | null;
  force_disabled: boolean | null;
  server_role: string | null;
  is_build_server: boolean | null;
}

/** Server::ownedByCurrentTeam(): the org's servers by name. */
export async function listRegistryServers(tx: SqlExecutor): Promise<DeployRegistryServerRow[]> {
  const r = await tx.execute<DeployRegistryServerRow>(
    `SELECT s.id, s.uuid, s.name, s.ip, ss.is_reachable, ss.is_usable, ss.force_disabled, ss.server_role, ss.is_build_server
       FROM deploy.servers s LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id
      WHERE s.deleted_at IS NULL
      ORDER BY s.name, s.id`,
  );
  return r.rows;
}

/**
 * A resource with the image it pulls or pushes. `image` is as stored: it may
 * be null or blank (Coolify's filled() check is the caller's).
 */
export interface DeployRegistryUserRow extends SqlRow {
  /** Coolify's `type`: Application, Database, Service or Build. */
  type: "Application" | "Database" | "Service" | "Build";
  /** The resource's kind in its page's path (project.{kind}.configuration). */
  kind: "application" | "database" | "service";
  image: string | null;
  uuid: string;
  name: string;
  environment_uuid: string | null;
  project_uuid: string | null;
}

/** $2 and $3: what a resource's destination_type holds for a standalone and a Swarm destination. */
const MORPH = [DESTINATION_MORPH_CLASS.standalone, DESTINATION_MORPH_CLASS.swarm];

/** The resource t is deployed to a destination of server $1 (Server::primaryApplications() and databases()). */
const ON_SERVER = `((t.destination_type = $2 AND t.destination_id IN (SELECT id FROM deploy.standalone_dockers WHERE server_id = $1))
  OR (t.destination_type = $3 AND t.destination_id IN (SELECT id FROM deploy.swarm_dockers WHERE server_id = $1)))`;

/** Server::databases(): the nine kinds, in the order Coolify concatenates them. */
const DATABASE_TABLES = [
  "standalone_postgresqls",
  "standalone_redis",
  "standalone_mongodbs",
  "standalone_mysqls",
  "standalone_mariadbs",
  "standalone_keydbs",
  "standalone_dragonflies",
  "standalone_clickhouses",
  "standalone_sqlites",
] as const;

const USER_COLUMNS = "u.type, u.kind, u.image, u.uuid, u.name, e.uuid AS environment_uuid, p.uuid AS project_uuid";
const USER_JOINS = "LEFT JOIN deploy.environments e ON e.id = u.environment_id LEFT JOIN deploy.projects p ON p.id = e.project_id";

/**
 * DockerRegistryLogins::usersOf() without its build part, in its order:
 * the applications deployed to the server (primaryApplications), those that
 * use it as an additional server, the databases kind by kind, then each
 * service's applications and databases. Soft-deleted rows are left out
 * (SoftDeletes' scope); the instance's own database (id 0) is not a resource.
 */
export async function listServerImageUsers(tx: SqlExecutor, serverId: string | number): Promise<DeployRegistryUserRow[]> {
  const databases = DATABASE_TABLES.map(
    (table, i) =>
      `SELECT ${2 + i} AS ord, t.id AS a, 0 AS b, 0::bigint AS c, 'Database'::text AS type, 'database'::text AS kind, t.image::text AS image, t.uuid, t.name, t.environment_id
         FROM deploy.${table} t WHERE t.deleted_at IS NULL AND t.id <> 0 AND ${ON_SERVER}`,
  ).join(" UNION ALL ");
  const container = (table: string, order: number) =>
    `SELECT 20 AS ord, s.id AS a, ${order} AS b, c.id AS c, 'Service'::text AS type, 'service'::text AS kind, c.image::text AS image, s.uuid, s.name, s.environment_id
       FROM deploy.${table} c JOIN deploy.services s ON s.id = c.service_id
      WHERE s.server_id = $1 AND s.deleted_at IS NULL AND c.deleted_at IS NULL`;
  const r = await tx.execute<DeployRegistryUserRow>(
    `SELECT ${USER_COLUMNS} FROM (
       SELECT 0 AS ord, t.id AS a, 0 AS b, 0::bigint AS c, 'Application'::text AS type, 'application'::text AS kind, t.docker_registry_image_name::text AS image, t.uuid, t.name, t.environment_id
         FROM deploy.applications t WHERE t.deleted_at IS NULL AND ${ON_SERVER}
       UNION ALL
       SELECT 1, t.id, 0, 0::bigint, 'Application'::text, 'application'::text, t.docker_registry_image_name::text, t.uuid, t.name, t.environment_id
         FROM deploy.applications t WHERE t.deleted_at IS NULL AND t.id IN (SELECT application_id FROM deploy.additional_destinations WHERE server_id = $1)
       UNION ALL ${databases}
       UNION ALL ${container("service_applications", 0)}
       UNION ALL ${container("service_databases", 1)}
     ) u ${USER_JOINS}
     ORDER BY u.ord, u.a, u.b, u.c`,
    [serverId, ...MORPH],
  );
  return r.rows;
}

/**
 * DockerRegistryLogins::applicationsBuiltOnBuildServers(): the org's
 * applications, by name, that have a registry image and are built on a build
 * server and pushed — deployed to another (existing) server, of a build pack
 * that supports build servers (not dockerimage or dockercompose), and either
 * that server cannot build (its effective role is deployment) or the
 * application's build server setting is on.
 */
export async function listBuildServerApplications(tx: SqlExecutor, buildServerId: string | number): Promise<DeployRegistryUserRow[]> {
  const r = await tx.execute<DeployRegistryUserRow>(
    `SELECT ${USER_COLUMNS} FROM (
       SELECT 'Build'::text AS type, 'application'::text AS kind, t.docker_registry_image_name::text AS image, t.id, t.uuid, t.name, t.environment_id
         FROM deploy.applications t
         JOIN deploy.servers ds ON ds.deleted_at IS NULL AND ds.id <> $1 AND ds.id = CASE t.destination_type
              WHEN $2 THEN (SELECT d.server_id FROM deploy.standalone_dockers d WHERE d.id = t.destination_id)
              WHEN $3 THEN (SELECT d.server_id FROM deploy.swarm_dockers d WHERE d.id = t.destination_id) END
         LEFT JOIN deploy.server_settings dss ON dss.server_id = ds.id
        WHERE t.deleted_at IS NULL AND t.docker_registry_image_name IS NOT NULL AND t.docker_registry_image_name <> ''
          AND t.build_pack NOT IN ('dockerimage', 'dockercompose')
          AND (dss.server_role = 'deployment'
            OR COALESCE((SELECT st.is_build_server_enabled FROM deploy.application_settings st WHERE st.application_id = t.id ORDER BY st.id LIMIT 1), false))
     ) u ${USER_JOINS}
     ORDER BY u.name, u.id`,
    [buildServerId, ...MORPH],
  );
  return r.rows;
}
