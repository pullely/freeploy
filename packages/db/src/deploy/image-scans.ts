// Derived from coollabsio/coolify@91b7e3e:app/Services/ImageScan/TeamVulnerabilities.php (resources),
// app/Services/ImageScan/ResourceScans.php (find, the scan queries), app/Services/ImageScan/IgnoreMatcher.php and
// app/Services/ImageScan/ImageScanPolicyResolver.php (the rows they read), and app/Models/ImageScan.php (Apache-2.0),
// modified.
//
// The rows the security status engine reads (DP-113): the org's applications, services and standalone databases with what
// their relations give it (settings, destination server and its settings, environment and project, a service's
// applications and databases), the image scans of their owners, the deployments those scans name and the latest finished
// one of each application, the org's ignores and scan policies, and the scans' servers. Every function takes the
// transaction of withOrg(): row-level security confines each query to that org, which is what Coolify's team checks do.
// Soft-deleted rows are never returned (SoftDeletes). The only write is a scan's summary (ResourceScans::refreshSummaries()).
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { DATABASE_ENGINES, DATABASE_TABLES } from "./databases.js";

const NOW = "date_trunc('second', timezone('UTC', now()))";

export interface ImageScanServerRow extends SqlRow {
  id: number;
  uuid: string;
  name: string;
  server_metadata: string | null;
  is_image_scan_enabled: boolean | null;
}

export interface ImageScanResourceBase extends SqlRow {
  id: number;
  uuid: string;
  name: string | null;
  environment_uuid: string | null;
  project_uuid: string | null;
  /** The destination's server (standalone or swarm), not deleted, with its settings. */
  destination_server: ImageScanServerRow | null;
}

export interface ImageScanApplicationRow extends ImageScanResourceBase {
  build_pack: string | null;
  docker_registry_image_name: string | null;
  docker_registry_image_tag: string | null;
  dockerfile: string | null;
  docker_compose: string | null;
  docker_compose_raw: string | null;
  docker_compose_image_overrides: string | null;
  compose_parsing_version: string | null;
  docker_compose_custom_build_command: string | null;
  docker_compose_custom_start_command: string | null;
  settings_is_image_scan_enabled: boolean | null;
  settings_is_raw_compose_deployment_enabled: boolean | null;
}

export interface ImageScanServicePartRow extends SqlRow {
  kind: "serviceApplication" | "serviceDatabase";
  id: number;
  uuid: string;
  name: string | null;
  human_name: string | null;
  image: string | null;
  exclude_from_status: boolean;
  service_id: number;
}

export interface ImageScanServiceRow extends ImageScanResourceBase {
  server: ImageScanServerRow | null;
  applications: ImageScanServicePartRow[];
  databases: ImageScanServicePartRow[];
}

export interface ImageScanDatabaseRow extends ImageScanResourceBase {
  engine: string;
  morph_class: string;
  image: string | null;
}

export interface ImageScanResources {
  applications: ImageScanApplicationRow[];
  services: ImageScanServiceRow[];
  databases: ImageScanDatabaseRow[];
}

const SERVER_COLUMNS = `jsonb_build_object('id', s.id, 'uuid', s.uuid, 'name', s.name, 'server_metadata', s.server_metadata::text, 'is_image_scan_enabled', ss.is_image_scan_enabled)`;

/** The destination's server as a JSON object (a morphTo of StandaloneDocker or SwarmDocker, then belongsTo Server). */
const destinationServer = (alias: string) => `(
  SELECT ${SERVER_COLUMNS}::text
    FROM deploy.servers s LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id
   WHERE s.deleted_at IS NULL AND s.id = (
     CASE ${alias}.destination_type
       WHEN 'App\\Models\\StandaloneDocker' THEN (SELECT sd.server_id FROM deploy.standalone_dockers sd WHERE sd.id = ${alias}.destination_id)
       WHEN 'App\\Models\\SwarmDocker' THEN (SELECT wd.server_id FROM deploy.swarm_dockers wd WHERE wd.id = ${alias}.destination_id)
     END)
   ORDER BY ss.id LIMIT 1) AS destination_server`;

const environmentColumns = (alias: string) =>
  `(SELECT en.uuid FROM deploy.environments en WHERE en.id = ${alias}.environment_id) AS environment_uuid,
   (SELECT pr.uuid FROM deploy.environments en JOIN deploy.projects pr ON pr.id = en.project_id WHERE en.id = ${alias}.environment_id) AS project_uuid`;

const parseJson = <T>(value: unknown): T | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

const server = (value: unknown): ImageScanServerRow | null => {
  const s = parseJson<ImageScanServerRow>(value);
  return s === null ? null : { ...s, id: Number(s.id) };
};

const APPLICATION_SELECT = (where: string) => `
  SELECT a.id::float8 AS id, a.uuid, a.name, a.build_pack, a.docker_registry_image_name, a.docker_registry_image_tag, a.dockerfile,
         a.docker_compose, a.docker_compose_raw, a.docker_compose_image_overrides::text AS docker_compose_image_overrides,
         a.compose_parsing_version, a.docker_compose_custom_build_command, a.docker_compose_custom_start_command,
         st.is_image_scan_enabled AS settings_is_image_scan_enabled, st.is_raw_compose_deployment_enabled AS settings_is_raw_compose_deployment_enabled,
         ${environmentColumns("a")}, ${destinationServer("a")}
    FROM deploy.applications a
    LEFT JOIN LATERAL (SELECT * FROM deploy.application_settings x WHERE x.application_id = a.id ORDER BY x.id LIMIT 1) st ON true
   WHERE a.deleted_at IS NULL ${where}
   ORDER BY a.id`;

const SERVICE_SELECT = (where: string) => `
  SELECT v.id::float8 AS id, v.uuid, v.name, ${environmentColumns("v")}, ${destinationServer("v")},
         (SELECT ${SERVER_COLUMNS}::text FROM deploy.servers s LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id
           WHERE s.deleted_at IS NULL AND s.id = v.server_id ORDER BY ss.id LIMIT 1) AS server
    FROM deploy.services v
   WHERE v.deleted_at IS NULL ${where}
   ORDER BY v.id`;

const databaseSelect = (engine: (typeof DATABASE_ENGINES)[number], where: string) => {
  const t = DATABASE_TABLES[engine];
  return `
  SELECT '${engine}' AS engine, '${t.morphClass.replace(/'/g, "''")}' AS morph_class, d.id::float8 AS id, d.uuid, d.name, d.image,
         ${environmentColumns("d")}, ${destinationServer("d")}
    FROM deploy.${t.table} d
   WHERE d.deleted_at IS NULL ${where}
   ORDER BY d.id`;
};

async function servicesWithParts(tx: SqlExecutor, rows: SqlRow[]): Promise<ImageScanServiceRow[]> {
  const ids = rows.map((r) => Number(r.id));
  const parts =
    ids.length === 0
      ? []
      : (
          await tx.execute<ImageScanServicePartRow>(
            `SELECT 'serviceApplication' AS kind, id::float8 AS id, uuid, name, human_name, image, exclude_from_status, service_id::float8 AS service_id FROM deploy.service_applications WHERE deleted_at IS NULL AND service_id = ANY($1::bigint[])
             UNION ALL
             SELECT 'serviceDatabase' AS kind, id::float8 AS id, uuid, name, human_name, image, exclude_from_status, service_id::float8 AS service_id FROM deploy.service_databases WHERE deleted_at IS NULL AND service_id = ANY($1::bigint[])
             ORDER BY kind, id`,
            [ids],
          )
        ).rows;
  return rows.map((r) => ({
    ...(r as ImageScanServiceRow),
    id: Number(r.id),
    destination_server: server(r.destination_server),
    server: server(r.server),
    applications: parts.filter((p) => p.kind === "serviceApplication" && Number(p.service_id) === Number(r.id)).map((p) => ({ ...p, id: Number(p.id), service_id: Number(p.service_id) })),
    databases: parts.filter((p) => p.kind === "serviceDatabase" && Number(p.service_id) === Number(r.id)).map((p) => ({ ...p, id: Number(p.id), service_id: Number(p.service_id) })),
  }));
}

const withServer = <T extends ImageScanResourceBase>(r: SqlRow): T => ({ ...(r as T), id: Number(r.id), destination_server: server(r.destination_server) });

/** TeamVulnerabilities::resources(): the org's applications, services and standalone databases, each by id. */
export async function listImageScanResources(tx: SqlExecutor): Promise<ImageScanResources> {
  const applications = (await tx.execute(APPLICATION_SELECT(""))).rows.map((r) => withServer<ImageScanApplicationRow>(r));
  const services = await servicesWithParts(tx, (await tx.execute(SERVICE_SELECT(""))).rows);
  const databases: ImageScanDatabaseRow[] = [];
  for (const engine of DATABASE_ENGINES) databases.push(...(await tx.execute(databaseSelect(engine, ""))).rows.map((r) => withServer<ImageScanDatabaseRow>(r)));
  return { applications, services, databases };
}

/** ResourceScans::find(): a resource page's resource by type and uuid (a database in the engines' order), in the org. */
export async function findImageScanResource(tx: SqlExecutor, type: "application" | "service" | "database", uuid: string): Promise<ImageScanResources> {
  const empty: ImageScanResources = { applications: [], services: [], databases: [] };
  if (type === "application") return { ...empty, applications: (await tx.execute(APPLICATION_SELECT("AND a.uuid = $1"), [uuid])).rows.slice(0, 1).map((r) => withServer<ImageScanApplicationRow>(r)) };
  if (type === "service") return { ...empty, services: await servicesWithParts(tx, (await tx.execute(SERVICE_SELECT("AND v.uuid = $1"), [uuid])).rows.slice(0, 1)) };
  for (const engine of DATABASE_ENGINES) {
    const rows = (await tx.execute(databaseSelect(engine, "AND d.uuid = $1"), [uuid])).rows;
    if (rows.length > 0) return { ...empty, databases: [withServer<ImageScanDatabaseRow>(rows[0]!)] };
  }
  return empty;
}

export interface ImageScanStoredRow extends SqlRow {
  id: number;
  uuid: string;
  server_id: number;
  image_id: string;
  repo_digest: string | null;
  resource_type: string;
  resource_id: number;
  image_ref: string;
  deployment_queue_id: number | null;
  status: string;
  error_code: string | null;
  error_context: string | null;
  summary: string | null;
  findings: string | null;
  candidates: string | null;
  base_image_ref: string | null;
  builds_image: boolean;
  is_baseline: boolean;
  grype_db_built_at: string | null;
  scanned_at: string | null;
}

/** The image scans of these owners ({morph class: ids}), any status, by id; `findings` only when asked (a list reads none). */
export async function listImageScans(tx: SqlExecutor, idsByType: Record<string, number[]>, withFindings: boolean): Promise<ImageScanStoredRow[]> {
  const types = Object.entries(idsByType).filter(([, ids]) => ids.length > 0);
  if (types.length === 0) return [];
  const params: unknown[] = [];
  const where = types.map(([type, ids]) => {
    params.push(type, ids);
    return `(resource_type = $${params.length - 1} AND resource_id = ANY($${params.length}::bigint[]))`;
  });
  const r = await tx.execute<ImageScanStoredRow>(
    `SELECT id::float8 AS id, uuid, server_id::float8 AS server_id, image_id, repo_digest, resource_type, resource_id::float8 AS resource_id, image_ref,
            deployment_queue_id::float8 AS deployment_queue_id, status, error_code, error_context::text AS error_context, summary::text AS summary,
            ${withFindings ? "findings::text" : "NULL::text"} AS findings, candidates::text AS candidates, base_image_ref, builds_image, is_baseline,
            to_char(grype_db_built_at, 'YYYY-MM-DD HH24:MI:SS') AS grype_db_built_at, to_char(scanned_at, 'YYYY-MM-DD HH24:MI:SS') AS scanned_at
       FROM deploy.image_scans WHERE ${where.join(" OR ")} ORDER BY id`,
    params,
  );
  return r.rows;
}

export interface ImageScanDeploymentRow extends SqlRow {
  id: number;
  application_id: string;
  pull_request_id: number;
  force_rebuild: boolean;
  commit: string | null;
  status: string;
}

/** The deployments these scans name (any application of the org). */
export async function listImageScanDeployments(tx: SqlExecutor, ids: number[]): Promise<ImageScanDeploymentRow[]> {
  if (ids.length === 0) return [];
  const r = await tx.execute<ImageScanDeploymentRow>(
    `SELECT id::float8 AS id, application_id, pull_request_id, force_rebuild, commit, status FROM deploy.application_deployment_queues WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [ids],
  );
  return r.rows;
}

/** ResourceScans::latestDeployedCommit(): the commit of each application's latest finished deployment that is not a preview. */
export async function listLatestFinishedCommits(tx: SqlExecutor, applicationIds: number[]): Promise<Array<{ application_id: string; commit: string | null }>> {
  if (applicationIds.length === 0) return [];
  const r = await tx.execute<{ application_id: string; commit: string | null }>(
    `SELECT DISTINCT ON (application_id) application_id, commit FROM deploy.application_deployment_queues
      WHERE application_id = ANY($1::text[]) AND pull_request_id = 0 AND status = 'finished' ORDER BY application_id, id DESC`,
    [applicationIds.map(String)],
  );
  return r.rows;
}

export interface ImageScanIgnoreRow extends SqlRow {
  id: number;
  uuid: string;
  resource_type: string | null;
  resource_id: number | null;
  vulnerability_id: string | null;
  package: string | null;
  reason: string;
  expires_at: string | null;
  created_at: string | null;
}

/** The org's ignores, by id (IgnoreMatcher returns the first one that applies). */
export async function listImageScanIgnores(tx: SqlExecutor): Promise<ImageScanIgnoreRow[]> {
  const r = await tx.execute<ImageScanIgnoreRow>(
    `SELECT id::float8 AS id, uuid, resource_type, resource_id::float8 AS resource_id, vulnerability_id, package, reason,
            to_char(expires_at, 'YYYY-MM-DD HH24:MI:SS') AS expires_at, to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
       FROM deploy.image_scan_ignores ORDER BY id`,
  );
  return r.rows;
}

export interface ImageScanPolicyRow extends SqlRow {
  id: number;
  scope_type: string | null;
  scope_id: number | null;
  gate_mode: string | null;
  on_scan_error: string | null;
  count_medium: boolean | null;
}

/** The org's scan policies of a team, a server or an application, by id. */
export async function listImageScanPolicies(tx: SqlExecutor): Promise<ImageScanPolicyRow[]> {
  const r = await tx.execute<ImageScanPolicyRow>(
    `SELECT id::float8 AS id, scope_type, scope_id::float8 AS scope_id, gate_mode, on_scan_error, count_medium FROM deploy.image_scan_policies WHERE scope_type IS NOT NULL ORDER BY id`,
  );
  return r.rows;
}

/** The servers of these scans (a scan's `server`), with their settings. */
export async function listImageScanServers(tx: SqlExecutor, ids: number[]): Promise<ImageScanServerRow[]> {
  if (ids.length === 0) return [];
  const r = await tx.execute<{ server: string }>(
    `SELECT ${SERVER_COLUMNS}::text AS server FROM deploy.servers s LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id WHERE s.deleted_at IS NULL AND s.id = ANY($1::bigint[]) ORDER BY s.id`,
    [ids],
  );
  return r.rows.map((x) => server(x.server)!).filter((x) => x !== null);
}

/** The environment variables of resources that are not previews, with these keys: the stored (encrypted) values, by id. */
export async function listImageScanVariables(tx: SqlExecutor, resourceType: string, ids: number[], keys: string[]): Promise<Array<{ resourceable_id: number; key: string; value: string | null }>> {
  if (ids.length === 0 || keys.length === 0) return [];
  const r = await tx.execute<{ resourceable_id: number; key: string; value: string | null }>(
    `SELECT resourceable_id::float8 AS resourceable_id, key, value FROM deploy.environment_variables
      WHERE resourceable_type = $1 AND resourceable_id = ANY($2::bigint[]) AND key = ANY($3::text[]) AND is_preview = false ORDER BY id`,
    [resourceType, ids, keys],
  );
  return r.rows.map((x) => ({ ...x, resourceable_id: Number(x.resourceable_id) }));
}

/** $scan->summary = …; $scan->save(): a scan's summary written again (refreshSummaries()). */
export async function saveImageScanSummary(tx: SqlExecutor, id: number, summaryJson: string): Promise<void> {
  await tx.execute(`UPDATE deploy.image_scans SET summary = $2::jsonb, updated_at = ${NOW} WHERE id = $1`, [id, summaryJson]);
}
