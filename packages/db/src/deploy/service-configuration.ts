// Derived from coollabsio/coolify@91b7e3e:app/Models/{Service,ServiceApplication,ServiceDatabase}.php (the
// relations, the deleting hooks), app/Actions/Service/DeleteService.php (deleteLocal),
// app/Jobs/DeleteResourceJob.php (deleteLocalResource's volume backup schedules) and
// app/Livewire/Project/Service/{Configuration,StackForm,Index}.php (the rows they read and save)
// (Apache-2.0), modified.
//
// What a service's configuration pages read and write once the service exists (insertParsedService in
// services.ts creates it): the service with its server and destination, every row the Compose parser
// works on — loaded so that the parser can run again on an edited file and written back row by row —, a
// part's own columns, and deleting a service with everything that belongs to it. Every function takes the
// transaction of withOrg(): row-level security confines each query to that org. Values and file contents
// are the stored ciphertexts; these functions never decrypt.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { DESTINATION_MORPH_CLASS } from "./destinations.js";
import { SERVICE_MORPH_CLASS, SERVICE_PART_MORPH_CLASS, type ServicePartKind } from "./services.js";
import { FILE_VOLUME_MORPH_CLASS, PERSISTENT_VOLUME_MORPH_CLASS } from "./storages.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";
const STANDALONE = DESTINATION_MORPH_CLASS.standalone.replace(/\\/g, "\\\\");
const SWARM = DESTINATION_MORPH_CLASS.swarm.replace(/\\/g, "\\\\");

type Id = string | number;

/** A service with its environment, project, server (and what the parser and the pages read of it) and destination. */
export interface DeployServiceConfigurationRow extends SqlRow {
  id: Id;
  uuid: string;
  name: string;
  description: string | null;
  docker_compose_raw: string;
  docker_compose: string | null;
  connect_to_docker_network: boolean;
  service_type: string | null;
  is_container_label_escape_enabled: boolean;
  compose_parsing_version: string;
  include_coolify_default_variables: boolean;
  redact_all_env_values_in_logs: boolean;
  config_hash: string | null;
  environment_id: Id;
  environment_uuid: string;
  environment_name: string;
  project_id: Id;
  project_uuid: string;
  project_name: string;
  server_id: Id | null;
  server_uuid: string | null;
  server_name: string | null;
  server_ip: string | null;
  server_proxy: unknown;
  server_is_reachable: boolean | null;
  server_is_usable: boolean | null;
  server_force_disabled: boolean | null;
  server_wildcard_domain: string | null;
  server_generate_exact_labels: boolean | null;
  server_traefik_certificate_resolver: string | null;
  server_is_traffic_analytics_enabled: boolean | null;
  server_is_logdrain_newrelic_enabled: boolean | null;
  server_is_logdrain_axiom_enabled: boolean | null;
  server_is_logdrain_custom_enabled: boolean | null;
  server_is_logdrain_cloudwatch_enabled: boolean | null;
  destination_id: Id | null;
  destination_type: string | null;
  destination_uuid: string | null;
  destination_name: string | null;
  destination_network: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

const SELECT_CONFIGURATION = `SELECT s.id, s.uuid, s.name, s.description, s.docker_compose_raw, s.docker_compose, s.connect_to_docker_network, s.service_type,
        s.is_container_label_escape_enabled, s.compose_parsing_version, s.include_coolify_default_variables, s.redact_all_env_values_in_logs, s.config_hash,
        s.environment_id, e.uuid AS environment_uuid, e.name AS environment_name, p.id AS project_id, p.uuid AS project_uuid, p.name AS project_name,
        sv.id AS server_id, sv.uuid AS server_uuid, sv.name AS server_name, sv.ip AS server_ip, sv.proxy AS server_proxy,
        ss.is_reachable AS server_is_reachable, ss.is_usable AS server_is_usable, ss.force_disabled AS server_force_disabled,
        ss.wildcard_domain AS server_wildcard_domain, ss.generate_exact_labels AS server_generate_exact_labels,
        ss.traefik_certificate_resolver AS server_traefik_certificate_resolver, ss.is_traffic_analytics_enabled AS server_is_traffic_analytics_enabled,
        ss.is_logdrain_newrelic_enabled AS server_is_logdrain_newrelic_enabled, ss.is_logdrain_axiom_enabled AS server_is_logdrain_axiom_enabled,
        ss.is_logdrain_custom_enabled AS server_is_logdrain_custom_enabled, ss.is_logdrain_cloudwatch_enabled AS server_is_logdrain_cloudwatch_enabled,
        s.destination_id, s.destination_type, COALESCE(sd.uuid, wd.uuid) AS destination_uuid, COALESCE(sd.name, wd.name) AS destination_name,
        COALESCE(sd.network, wd.network) AS destination_network, s.created_at, s.updated_at
   FROM deploy.services s
   JOIN deploy.environments e ON e.id = s.environment_id
   JOIN deploy.projects p ON p.id = e.project_id
   LEFT JOIN deploy.standalone_dockers sd ON sd.id = s.destination_id AND s.destination_type = E'${STANDALONE}'
   LEFT JOIN deploy.swarm_dockers wd ON wd.id = s.destination_id AND s.destination_type = E'${SWARM}'
   LEFT JOIN deploy.servers sv ON sv.id = s.server_id AND sv.deleted_at IS NULL
   LEFT JOIN deploy.server_settings ss ON ss.server_id = sv.id`;

/** The service by uuid within the org (a soft-deleted one is gone). */
export async function findServiceConfiguration(tx: SqlExecutor, uuid: string): Promise<DeployServiceConfigurationRow | null> {
  const r = await tx.execute<DeployServiceConfigurationRow>(`${SELECT_CONFIGURATION} WHERE s.uuid = $1 AND s.deleted_at IS NULL`, [uuid]);
  return r.rows[0] ?? null;
}

// ---------------------------------------------------------------- the parser's rows

/** A part as its page and the parser read it: every column but the timestamps. */
export interface DeployServicePartFullRow extends SqlRow {
  id: Id;
  uuid: string;
  name: string;
  human_name: string | null;
  description: string | null;
  ports: string | null;
  status: string;
  exclude_from_status: boolean;
  image: string | null;
  is_log_drain_enabled: boolean;
  is_gzip_enabled: boolean;
  is_stripprefix_enabled: boolean;
  is_migrated: boolean;
  is_removed_from_compose: boolean;
  last_online_at: string | Date | null;
  // Applications only (null for a database).
  fqdn: string | null;
  noindex_domains: unknown;
  redirect: string | null;
  is_force_https_enabled: boolean | null;
  is_permanent_redirect_enabled: boolean | null;
  domain_port_overrides: unknown;
  traefik_certificate_resolver: string | null;
  restart_count: number | null;
  max_restart_count: number | null;
  restart_limit_reached: boolean | null;
  // Databases only (null for an application).
  public_port: number | null;
  public_port_timeout: number | null;
  is_public: boolean | null;
}

const APPLICATION_COLUMNS = `id, uuid, name, human_name, description, ports, status, exclude_from_status, image, is_log_drain_enabled, is_gzip_enabled,
  is_stripprefix_enabled, is_migrated, is_removed_from_compose, last_online_at, fqdn, noindex_domains, "redirect", is_force_https_enabled,
  is_permanent_redirect_enabled, domain_port_overrides, traefik_certificate_resolver, restart_count, max_restart_count, restart_limit_reached,
  NULL::integer AS public_port, NULL::integer AS public_port_timeout, NULL::boolean AS is_public`;
const DATABASE_COLUMNS = `id, uuid, name, human_name, description, ports, status, exclude_from_status, image, is_log_drain_enabled, is_gzip_enabled,
  is_stripprefix_enabled, is_migrated, is_removed_from_compose, last_online_at, NULL::text AS fqdn, NULL::json AS noindex_domains, NULL::varchar AS "redirect",
  NULL::boolean AS is_force_https_enabled, NULL::boolean AS is_permanent_redirect_enabled, NULL::json AS domain_port_overrides,
  NULL::varchar AS traefik_certificate_resolver, NULL::integer AS restart_count, NULL::integer AS max_restart_count, NULL::boolean AS restart_limit_reached,
  public_port, public_port_timeout, is_public`;

const PART_TABLE: Record<ServicePartKind, string> = { application: "deploy.service_applications", database: "deploy.service_databases" };

/** $service->applications or ->databases, oldest first, every column. */
export async function listServiceParts(tx: SqlExecutor, kind: ServicePartKind, serviceId: Id): Promise<DeployServicePartFullRow[]> {
  const r = await tx.execute<DeployServicePartFullRow>(
    `SELECT ${kind === "application" ? APPLICATION_COLUMNS : DATABASE_COLUMNS} FROM ${PART_TABLE[kind]} WHERE service_id = $1 AND deleted_at IS NULL ORDER BY id`,
    [serviceId],
  );
  return r.rows;
}

/** A part of the org by uuid, with its kind and the service it belongs to. */
export async function findServicePartByUuid(tx: SqlExecutor, uuid: string): Promise<{ kind: ServicePartKind; row: DeployServicePartFullRow; service_id: Id } | null> {
  for (const kind of ["application", "database"] as const) {
    const r = await tx.execute<DeployServicePartFullRow & { service_id: Id }>(
      `SELECT ${kind === "application" ? APPLICATION_COLUMNS : DATABASE_COLUMNS}, service_id FROM ${PART_TABLE[kind]} WHERE uuid = $1 AND deleted_at IS NULL`,
      [uuid],
    );
    const row = r.rows[0];
    if (row) return { kind, row, service_id: row.service_id };
  }
  return null;
}

export interface DeployServiceVariableRow extends SqlRow {
  id: Id;
  key: string;
  /** The stored ciphertext, or null. */
  value: string | null;
  is_preview: boolean;
  is_required: boolean;
  is_shared: boolean;
  is_literal: boolean;
  is_multiline: boolean;
  is_shown_once: boolean;
  comment: string | null;
  version: string;
  preserve_compose_null: boolean;
}

/** $service->environment_variables, oldest first. */
export async function listServiceVariables(tx: SqlExecutor, serviceId: Id): Promise<DeployServiceVariableRow[]> {
  const r = await tx.execute<DeployServiceVariableRow>(
    `SELECT id, "key", "value", is_preview, is_required, is_shared, is_literal, is_multiline, is_shown_once, "comment", version, preserve_compose_null
       FROM deploy.environment_variables WHERE resourceable_type = $1 AND resourceable_id = $2 ORDER BY id`,
    [SERVICE_MORPH_CLASS, serviceId],
  );
  return r.rows;
}

export interface DeployServicePartVolumeRow extends SqlRow {
  id: Id;
  name: string;
  mount_path: string;
  resource_type: string;
  resource_id: Id;
  ignores_compose_driver_options: boolean;
}

export interface DeployServicePartFileRow extends SqlRow {
  id: Id;
  fs_path: string;
  mount_path: string | null;
  /** The stored ciphertext, or null. */
  content: string | null;
  resource_type: string;
  resource_id: Id;
  is_directory: boolean;
  is_host_file: boolean;
  variable_fs_path: string | null;
  /** A directory with volume backup schedules is kept by the parser. */
  has_scheduled_backups: boolean;
}

const PARTS_OF = `(resource_type = $1 AND resource_id IN (SELECT id FROM deploy.service_applications WHERE service_id = $3))
   OR (resource_type = $2 AND resource_id IN (SELECT id FROM deploy.service_databases WHERE service_id = $3))`;
const PART_MORPHS = [SERVICE_PART_MORPH_CLASS.application, SERVICE_PART_MORPH_CLASS.database];

/** The persistent volumes of the service's parts, oldest first. */
export async function listServicePartVolumes(tx: SqlExecutor, serviceId: Id): Promise<DeployServicePartVolumeRow[]> {
  const r = await tx.execute<DeployServicePartVolumeRow>(
    `SELECT id, name, mount_path, resource_type, resource_id, ignores_compose_driver_options FROM deploy.local_persistent_volumes WHERE ${PARTS_OF} ORDER BY id`,
    [...PART_MORPHS, serviceId],
  );
  return r.rows;
}

/** The file and directory mounts of the service's parts, oldest first. */
export async function listServicePartFiles(tx: SqlExecutor, serviceId: Id): Promise<DeployServicePartFileRow[]> {
  const r = await tx.execute<DeployServicePartFileRow>(
    `SELECT f.id, f.fs_path, f.mount_path, f.content, f.resource_type, f.resource_id, f.is_directory, f.is_host_file, f.variable_fs_path,
            EXISTS (SELECT 1 FROM deploy.scheduled_volume_backups b WHERE b.backupable_type = $4 AND b.backupable_id = f.id) AS has_scheduled_backups
       FROM deploy.local_file_volumes f WHERE ${PARTS_OF.replace(/resource_/g, "f.resource_")} ORDER BY f.id`,
    [...PART_MORPHS, serviceId, FILE_VOLUME_MORPH_CLASS],
  );
  return r.rows;
}

// ---------------------------------------------------------------- writes

/** Columns a service, a part, a variable or a volume may be written with, per table: nothing else reaches SQL. */
const WRITABLE: Record<string, { table: string; columns: readonly string[]; json?: readonly string[] }> = {
  service: {
    table: "deploy.services",
    // redact_all_env_values_in_logs and include_coolify_default_variables: written by /api/v1 (DP-74).
    columns: ["name", "description", "docker_compose_raw", "docker_compose", "connect_to_docker_network", "is_container_label_escape_enabled", "service_type", "redact_all_env_values_in_logs", "include_coolify_default_variables"],
  },
  application: {
    table: "deploy.service_applications",
    columns: [
      "name",
      "human_name",
      "description",
      "fqdn",
      "ports",
      "image",
      "exclude_from_status",
      "is_log_drain_enabled",
      "is_gzip_enabled",
      "is_stripprefix_enabled",
      "is_migrated",
      "is_removed_from_compose",
      "noindex_domains",
      "redirect",
      "is_force_https_enabled",
      "is_permanent_redirect_enabled",
      "domain_port_overrides",
      "traefik_certificate_resolver",
      "max_restart_count",
      "restart_limit_reached",
    ],
    json: ["noindex_domains", "domain_port_overrides"],
  },
  database: {
    table: "deploy.service_databases",
    columns: ["name", "human_name", "description", "ports", "image", "exclude_from_status", "is_log_drain_enabled", "is_gzip_enabled", "is_stripprefix_enabled", "is_migrated", "is_removed_from_compose", "public_port", "public_port_timeout", "is_public"],
  },
  variable: {
    table: "deploy.environment_variables",
    columns: ["key", "value", "is_preview", "is_required", "is_shared", "is_literal", "is_multiline", "comment", "version", "preserve_compose_null"],
  },
  volume: { table: "deploy.local_persistent_volumes", columns: ["name", "mount_path", "ignores_compose_driver_options"] },
  file: { table: "deploy.local_file_volumes", columns: ["fs_path", "mount_path", "content", "is_directory", "is_host_file", "variable_fs_path"] },
};
export type ServiceWritable = keyof typeof WRITABLE;
export type ServiceRowChanges = Record<string, unknown>;

function assignments(kind: ServiceWritable, changes: ServiceRowChanges, from: number): { sets: string[]; values: unknown[] } {
  const spec = WRITABLE[kind]!;
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [column, value] of Object.entries(changes)) {
    if (!spec.columns.includes(column)) throw new Error(`a ${kind} has no writable column "${column}"`);
    const json = spec.json?.includes(column) ?? false;
    values.push(json ? (value === null ? null : JSON.stringify(value)) : value);
    sets.push(`"${column}" = $${from + values.length - 1}${json ? "::json" : ""}`);
  }
  return { sets, values };
}

/**
 * One row of a service (the service, a part, a variable of the service, a volume of a part) updated with
 * the given columns and updated_at. The row must be the service's: `serviceId` confines the update.
 * False when no such row.
 */
export async function updateServiceRow(tx: SqlExecutor, kind: ServiceWritable, serviceId: Id, id: Id, changes: ServiceRowChanges): Promise<boolean> {
  // $1 the service, $2 the row, $3 and $4 the parts' morph classes; the columns from $5.
  const { sets, values } = assignments(kind, changes, 5);
  const scope =
    kind === "service"
      ? "id = $1 AND id = $2"
      : kind === "application" || kind === "database"
        ? "service_id = $1 AND id = $2"
        : kind === "variable"
          ? `resourceable_type = E'${SERVICE_MORPH_CLASS.replace(/\\/g, "\\\\")}' AND resourceable_id = $1 AND id = $2`
          : "id = $2 AND ((resource_type = $3 AND resource_id IN (SELECT id FROM deploy.service_applications WHERE service_id = $1)) OR (resource_type = $4 AND resource_id IN (SELECT id FROM deploy.service_databases WHERE service_id = $1)))";
  const r = await tx.execute(`UPDATE ${WRITABLE[kind]!.table} SET ${[...sets, `updated_at = ${NOW}`].join(", ")} WHERE ${scope} AND $3::text IS NOT NULL AND $4::text IS NOT NULL RETURNING id`, [serviceId, id, ...PART_MORPHS, ...values]);
  return r.rows.length > 0;
}

/** A new part of the service (the parser found a new Compose service). Answers its id. */
export async function insertServicePart(tx: SqlExecutor, orgId: string, kind: ServicePartKind, serviceId: Id, uuid: string, row: ServiceRowChanges): Promise<Id> {
  const { values } = assignments(kind, row, 1);
  const columns = Object.keys(row);
  const json = WRITABLE[kind]!.json ?? [];
  const placeholders = columns.map((column, index) => `$${index + 1}${json.includes(column) ? "::json" : ""}`);
  // Applications are written with the model's max_restart_count, whatever the column's default (insertParsedService).
  const extra = kind === "application" && !columns.includes("max_restart_count") ? { column: "max_restart_count", value: 0 } : null;
  const r = await tx.execute<{ id: Id }>(
    `INSERT INTO ${PART_TABLE[kind]} (${[...columns.map((c) => `"${c}"`), ...(extra ? [extra.column] : []), "uuid", "service_id", "org_id", "created_at", "updated_at"].join(", ")})
     VALUES (${[...placeholders, ...(extra ? [`$${columns.length + 1}`] : [])].join(", ")}, $${columns.length + (extra ? 2 : 1)}, $${columns.length + (extra ? 3 : 2)}, $${columns.length + (extra ? 4 : 3)}, ${NOW}, ${NOW})
     RETURNING id`,
    [...values, ...(extra ? [extra.value] : []), uuid, serviceId, orgId],
  );
  return r.rows[0]!.id;
}

/** A new environment variable of the service. */
export async function insertServiceVariable(tx: SqlExecutor, orgId: string, serviceId: Id, uuid: string, row: ServiceRowChanges): Promise<Id> {
  const { values } = assignments("variable", row, 1);
  const columns = Object.keys(row);
  const n = columns.length;
  const r = await tx.execute<{ id: Id }>(
    `INSERT INTO deploy.environment_variables (${[...columns.map((c) => `"${c}"`), "uuid", "resourceable_type", "resourceable_id", "org_id", "created_at", "updated_at"].join(", ")})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}, $${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, ${NOW}, ${NOW}) RETURNING id`,
    [...values, uuid, SERVICE_MORPH_CLASS, serviceId, orgId],
  );
  return r.rows[0]!.id;
}

/** A new volume or file mount of one of the service's parts. */
export async function insertServicePartStorage(tx: SqlExecutor, orgId: string, kind: "volume" | "file", owner: { kind: ServicePartKind; id: Id }, uuid: string, row: ServiceRowChanges): Promise<Id> {
  const { values } = assignments(kind, row, 1);
  const columns = Object.keys(row);
  const n = columns.length;
  const r = await tx.execute<{ id: Id }>(
    `INSERT INTO ${WRITABLE[kind]!.table} (${[...columns.map((c) => `"${c}"`), "uuid", "resource_type", "resource_id", "org_id", "created_at", "updated_at"].join(", ")})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}, $${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, ${NOW}, ${NOW}) RETURNING id`,
    [...values, uuid, SERVICE_PART_MORPH_CLASS[owner.kind], owner.id, orgId],
  );
  return r.rows[0]!.id;
}

/** Variables of the service, by id. */
export async function deleteServiceVariables(tx: SqlExecutor, serviceId: Id, ids: Id[]): Promise<number> {
  if (ids.length === 0) return 0;
  const r = await tx.execute(`DELETE FROM deploy.environment_variables WHERE resourceable_type = $1 AND resourceable_id = $2 AND id = ANY($3::bigint[]) RETURNING id`, [SERVICE_MORPH_CLASS, serviceId, ids.map(String)]);
  return r.rows.length;
}

/** File mounts of the service's parts, by id. */
export async function deleteServicePartFiles(tx: SqlExecutor, serviceId: Id, ids: Id[]): Promise<number> {
  if (ids.length === 0) return 0;
  const r = await tx.execute(`DELETE FROM deploy.local_file_volumes WHERE id = ANY($4::bigint[]) AND (${PARTS_OF}) RETURNING id`, [...PART_MORPHS, serviceId, ids.map(String)]);
  return r.rows.length;
}

/** Whether a part of the service has a stopped container left by a run, or has left 'exited' — anything a server may hold. */
export async function serviceHasRun(tx: SqlExecutor, serviceId: Id): Promise<boolean> {
  const r = await tx.execute<{ ran: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM deploy.service_applications WHERE service_id = $1 AND (status NOT LIKE 'exited%' OR restart_count > 0 OR last_restart_at IS NOT NULL))
         OR EXISTS (SELECT 1 FROM deploy.service_databases WHERE service_id = $1 AND (status NOT LIKE 'exited%' OR is_public)) AS ran`,
    [serviceId],
  );
  return r.rows[0]?.ran === true;
}

/**
 * DeleteResourceJob::deleteLocalResource() for a service, with DeleteService::deleteLocal(): the volume
 * backup schedules of its parts' storages (with their executions and S3 pivots), each application and
 * database with what its deleting hook removes (volumes, file mounts, a database's backup schedules with
 * their executions, S3 pivots and replicas), the service's scheduled tasks (with their executions), its
 * environment variables, its tags, and the service. Rows Freeploy keeps for any resource (stars, image
 * scans, secret manager links, the maintenance page) go with it. False when there is no such service.
 */
export async function deleteService(tx: SqlExecutor, serviceId: Id): Promise<boolean> {
  const parts = [...PART_MORPHS, serviceId];
  const storages = `SELECT b.id FROM deploy.scheduled_volume_backups b
    WHERE (b.backupable_type = $4 AND b.backupable_id IN (SELECT v.id FROM deploy.local_persistent_volumes v WHERE ${PARTS_OF.replace(/resource_/g, "v.resource_")}))
       OR (b.backupable_type = $5 AND b.backupable_id IN (SELECT f.id FROM deploy.local_file_volumes f WHERE ${PARTS_OF.replace(/resource_/g, "f.resource_")}))`;
  const withMorphs = [...parts, PERSISTENT_VOLUME_MORPH_CLASS, FILE_VOLUME_MORPH_CLASS];
  await tx.execute(`DELETE FROM deploy.scheduled_volume_backup_executions WHERE scheduled_volume_backup_id IN (${storages})`, withMorphs);
  await tx.execute(`DELETE FROM deploy.scheduled_volume_backup_s3_storage WHERE scheduled_volume_backup_id IN (${storages})`, withMorphs);
  await tx.execute(`DELETE FROM deploy.scheduled_volume_backups WHERE id IN (${storages})`, withMorphs);
  await tx.execute(`DELETE FROM deploy.local_persistent_volumes WHERE ${PARTS_OF}`, parts);
  await tx.execute(`DELETE FROM deploy.local_file_volumes WHERE ${PARTS_OF}`, parts);
  const backups = "SELECT b.id FROM deploy.scheduled_database_backups b WHERE b.database_type = $1 AND b.database_id IN (SELECT id FROM deploy.service_databases WHERE service_id = $2)";
  const database = [SERVICE_PART_MORPH_CLASS.database, serviceId];
  await tx.execute(`DELETE FROM deploy.database_backup_s3_replicas WHERE execution_id IN (SELECT x.id FROM deploy.scheduled_database_backup_executions x WHERE x.scheduled_database_backup_id IN (${backups}))`, database);
  await tx.execute(`DELETE FROM deploy.scheduled_database_backup_executions WHERE scheduled_database_backup_id IN (${backups})`, database);
  await tx.execute(`DELETE FROM deploy.scheduled_database_backup_s3_storage WHERE scheduled_database_backup_id IN (${backups})`, database);
  await tx.execute(`DELETE FROM deploy.scheduled_database_backups WHERE id IN (${backups})`, database);
  for (const [morph, table] of [
    [SERVICE_PART_MORPH_CLASS.application, "deploy.service_applications"],
    [SERVICE_PART_MORPH_CLASS.database, "deploy.service_databases"],
  ] as const) {
    const of = `(SELECT id FROM ${table} WHERE service_id = $2)`;
    await tx.execute(`DELETE FROM deploy.taggables WHERE taggable_type = $1 AND taggable_id IN ${of}`, [morph, serviceId]);
    await tx.execute(`DELETE FROM deploy.stars WHERE starrable_type = $1 AND starrable_id IN ${of}`, [morph, serviceId]);
  }
  await tx.execute("DELETE FROM deploy.service_applications WHERE service_id = $1", [serviceId]);
  await tx.execute("DELETE FROM deploy.service_databases WHERE service_id = $1", [serviceId]);
  await tx.execute("DELETE FROM deploy.scheduled_task_executions WHERE scheduled_task_id IN (SELECT t.id FROM deploy.scheduled_tasks t WHERE t.service_id = $1)", [serviceId]);
  await tx.execute("DELETE FROM deploy.scheduled_tasks WHERE service_id = $1", [serviceId]);
  const own = [SERVICE_MORPH_CLASS, serviceId];
  await tx.execute("DELETE FROM deploy.environment_variables WHERE resourceable_type = $1 AND resourceable_id = $2", own);
  await tx.execute("DELETE FROM deploy.taggables WHERE taggable_type = $1 AND taggable_id = $2", own);
  await tx.execute("DELETE FROM deploy.stars WHERE starrable_type = $1 AND starrable_id = $2", own);
  await tx.execute("DELETE FROM deploy.secret_manager_links WHERE resourceable_type = $1 AND resourceable_id = $2", own);
  await tx.execute("DELETE FROM deploy.image_scans WHERE resource_type = $1 AND resource_id = $2", own);
  await tx.execute("DELETE FROM deploy.image_scan_policies WHERE scope_type = $1 AND scope_id = $2", own);
  await tx.execute("DELETE FROM deploy.image_scan_ignores WHERE resource_type = $1 AND resource_id = $2", own);
  await tx.execute("DELETE FROM deploy.image_scan_notification_states WHERE resource_type = $1 AND resource_id = $2", own);
  const r = await tx.execute("DELETE FROM deploy.services WHERE id = $1 RETURNING id", [serviceId]);
  return r.rows.length > 0;
}

/**
 * A part deleted as its deleting hook deletes it: its volumes and file mounts (with their volume backup
 * schedules), a database's backup schedules, its tags and stars, and the row. False when not the service's.
 */
export async function deleteServicePart(tx: SqlExecutor, kind: ServicePartKind, serviceId: Id, id: Id): Promise<boolean> {
  const own = [SERVICE_PART_MORPH_CLASS[kind], id];
  const storages = `SELECT b.id FROM deploy.scheduled_volume_backups b
    WHERE (b.backupable_type = $3 AND b.backupable_id IN (SELECT v.id FROM deploy.local_persistent_volumes v WHERE v.resource_type = $1 AND v.resource_id = $2))
       OR (b.backupable_type = $4 AND b.backupable_id IN (SELECT f.id FROM deploy.local_file_volumes f WHERE f.resource_type = $1 AND f.resource_id = $2))`;
  const exists = await tx.execute(`SELECT id FROM ${PART_TABLE[kind]} WHERE service_id = $1 AND id = $2`, [serviceId, id]);
  if (exists.rows.length === 0) return false;
  const withMorphs = [...own, PERSISTENT_VOLUME_MORPH_CLASS, FILE_VOLUME_MORPH_CLASS];
  await tx.execute(`DELETE FROM deploy.scheduled_volume_backup_executions WHERE scheduled_volume_backup_id IN (${storages})`, withMorphs);
  await tx.execute(`DELETE FROM deploy.scheduled_volume_backup_s3_storage WHERE scheduled_volume_backup_id IN (${storages})`, withMorphs);
  await tx.execute(`DELETE FROM deploy.scheduled_volume_backups WHERE id IN (${storages})`, withMorphs);
  await tx.execute("DELETE FROM deploy.local_persistent_volumes WHERE resource_type = $1 AND resource_id = $2", own);
  await tx.execute("DELETE FROM deploy.local_file_volumes WHERE resource_type = $1 AND resource_id = $2", own);
  if (kind === "database") {
    const backups = "SELECT b.id FROM deploy.scheduled_database_backups b WHERE b.database_type = $1 AND b.database_id = $2";
    await tx.execute(`DELETE FROM deploy.database_backup_s3_replicas WHERE execution_id IN (SELECT x.id FROM deploy.scheduled_database_backup_executions x WHERE x.scheduled_database_backup_id IN (${backups}))`, own);
    await tx.execute(`DELETE FROM deploy.scheduled_database_backup_executions WHERE scheduled_database_backup_id IN (${backups})`, own);
    await tx.execute(`DELETE FROM deploy.scheduled_database_backup_s3_storage WHERE scheduled_database_backup_id IN (${backups})`, own);
    await tx.execute(`DELETE FROM deploy.scheduled_database_backups WHERE id IN (${backups})`, own);
  }
  await tx.execute("DELETE FROM deploy.taggables WHERE taggable_type = $1 AND taggable_id = $2", own);
  await tx.execute("DELETE FROM deploy.stars WHERE starrable_type = $1 AND starrable_id = $2", own);
  const r = await tx.execute(`DELETE FROM ${PART_TABLE[kind]} WHERE service_id = $1 AND id = $2 RETURNING id`, [serviceId, id]);
  return r.rows.length > 0;
}

/** checkDomainUsage(): every application and service application of the org with its domains. */
export async function listDomainOwners(tx: SqlExecutor): Promise<{ uuid: string; name: string; fqdn: string | null }[]> {
  const r = await tx.execute<{ uuid: string; name: string; fqdn: string | null }>(
    `SELECT uuid, name, fqdn FROM deploy.applications WHERE deleted_at IS NULL AND fqdn IS NOT NULL
     UNION ALL SELECT uuid, name, fqdn FROM deploy.service_applications WHERE deleted_at IS NULL AND fqdn IS NOT NULL`,
  );
  return r.rows;
}

/** A service of the environment's resources list: its server and its parts' statuses. */
export interface DeployEnvironmentServiceRow extends SqlRow {
  id: Id;
  uuid: string;
  name: string;
  description: string | null;
  server_name: string | null;
  server_ip: string | null;
  server_is_reachable: boolean | null;
  server_is_usable: boolean | null;
  server_force_disabled: boolean | null;
  /** [{status, exclude_from_status, is_removed_from_compose}] of every application, then every database. */
  parts: unknown;
}

/** $environment->services()->with(['tags', 'destination.server.settings']) */
export async function listEnvironmentServiceResources(tx: SqlExecutor, environmentId: Id): Promise<DeployEnvironmentServiceRow[]> {
  const r = await tx.execute<DeployEnvironmentServiceRow>(
    `SELECT s.id, s.uuid, s.name, s.description, sv.name AS server_name, sv.ip AS server_ip,
            ss.is_reachable AS server_is_reachable, ss.is_usable AS server_is_usable, ss.force_disabled AS server_force_disabled,
            COALESCE((SELECT json_agg(json_build_object('status', p.status, 'exclude_from_status', p.exclude_from_status, 'is_removed_from_compose', p.is_removed_from_compose) ORDER BY p.kind, p.id)
                        FROM (SELECT 0 AS kind, id, status, exclude_from_status, is_removed_from_compose FROM deploy.service_applications WHERE service_id = s.id AND deleted_at IS NULL
                              UNION ALL SELECT 1, id, status, exclude_from_status, is_removed_from_compose FROM deploy.service_databases WHERE service_id = s.id AND deleted_at IS NULL) p), '[]'::json) AS parts
       FROM deploy.services s
       LEFT JOIN deploy.standalone_dockers sd ON sd.id = s.destination_id AND s.destination_type = E'${STANDALONE}'
       LEFT JOIN deploy.swarm_dockers wd ON wd.id = s.destination_id AND s.destination_type = E'${SWARM}'
       LEFT JOIN deploy.servers sv ON sv.id = COALESCE(sd.server_id, wd.server_id) AND sv.deleted_at IS NULL
       LEFT JOIN deploy.server_settings ss ON ss.server_id = sv.id
      WHERE s.environment_id = $1 AND s.deleted_at IS NULL ORDER BY s.id`,
    [environmentId],
  );
  return r.rows;
}

/** One service of an environment as the environment canvas draws it (EnvironmentCanvas::serviceNode). */
export interface DeployEnvironmentServiceCanvasRow extends SqlRow {
  uuid: string;
  name: string;
  server_uuid: string | null;
  server_name: string | null;
  server_ip: string | null;
  server_is_reachable: boolean | null;
  server_is_usable: boolean | null;
  /** [{name, kind, status, fqdn, exclude_from_status, is_removed_from_compose}] of every application, then every database. */
  parts: unknown;
}

/** $environment->services()->with(['applications', 'databases', 'destination.server']): the canvas's service cards. */
export async function listEnvironmentServiceCanvasRows(tx: SqlExecutor, environmentId: Id): Promise<DeployEnvironmentServiceCanvasRow[]> {
  const r = await tx.execute<DeployEnvironmentServiceCanvasRow>(
    `SELECT s.uuid, s.name, sv.uuid AS server_uuid, sv.name AS server_name, sv.ip AS server_ip,
            ss.is_reachable AS server_is_reachable, ss.is_usable AS server_is_usable,
            COALESCE((SELECT json_agg(json_build_object('name', p.name, 'kind', p.kind, 'status', p.status, 'fqdn', p.fqdn, 'exclude_from_status', p.exclude_from_status, 'is_removed_from_compose', p.is_removed_from_compose) ORDER BY p.kind, p.id)
                        FROM (SELECT 'application' AS kind, id, name, status, fqdn, exclude_from_status, is_removed_from_compose FROM deploy.service_applications WHERE service_id = s.id AND deleted_at IS NULL
                              UNION ALL SELECT 'database', id, name, status, NULL, exclude_from_status, is_removed_from_compose FROM deploy.service_databases WHERE service_id = s.id AND deleted_at IS NULL) p), '[]'::json) AS parts
       FROM deploy.services s
       LEFT JOIN deploy.standalone_dockers sd ON sd.id = s.destination_id AND s.destination_type = E'${STANDALONE}'
       LEFT JOIN deploy.swarm_dockers wd ON wd.id = s.destination_id AND s.destination_type = E'${SWARM}'
       LEFT JOIN deploy.servers sv ON sv.id = COALESCE(sd.server_id, wd.server_id) AND sv.deleted_at IS NULL
       LEFT JOIN deploy.server_settings ss ON ss.server_id = sv.id
      WHERE s.environment_id = $1 AND s.deleted_at IS NULL ORDER BY s.id`,
    [environmentId],
  );
  return r.rows;
}
