// Derived from coollabsio/coolify@91b7e3e:app/Models/{Service,ServiceApplication,ServiceDatabase,
// EnvironmentVariable,LocalPersistentVolume,LocalFileVolume}.php (the creating hooks and the model
// defaults), app/Livewire/Project/Resource/Create.php (the row a one-click service starts as) and
// bootstrap/helpers/parsers.php (the rows serviceParser stores) (Apache-2.0), modified.
//
// deploy.services and what a service's Compose file is parsed into: deploy.service_applications,
// deploy.service_databases, the service's deploy.environment_variables and its parts'
// deploy.local_persistent_volumes and deploy.local_file_volumes. A service is stored once it is parsed:
// `insertParsedService` writes all of it in the transaction of withOrg(), so row-level security confines
// every row to that org. A soft-deleted service is never returned.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { DESTINATION_MORPH_CLASS, type DestinationType } from "./destinations.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** Service::class as a morph type (environment_variables.resourceable_type). */
export const SERVICE_MORPH_CLASS = "App\\Models\\Service";
/** ServiceApplication::class and ServiceDatabase::class as morph types (the volumes' resource_type). */
export const SERVICE_PART_MORPH_CLASS = { application: "App\\Models\\ServiceApplication", database: "App\\Models\\ServiceDatabase" } as const;
export type ServicePartKind = keyof typeof SERVICE_PART_MORPH_CLASS;

/** A part of the service as the parser left it. `localId` is the id the volumes refer to it by. */
interface NewServicePart {
  localId: number;
  /** BaseModel's creating hook: new_public_id(). */
  uuid: string;
  name: string;
  humanName: string | null;
  ports: string | null;
  image: string | null;
  excludeFromStatus: boolean;
  isLogDrainEnabled: boolean;
  isGzipEnabled: boolean;
  isStripprefixEnabled: boolean;
  isMigrated: boolean;
  isRemovedFromCompose: boolean;
}

export interface NewServiceApplication extends NewServicePart {
  fqdn: string | null;
  noindexDomains: string[] | null;
  redirect: string;
  isForceHttpsEnabled: boolean;
  isPermanentRedirectEnabled: boolean;
  domainPortOverrides: Record<string, number> | null;
  traefikCertificateResolver: string | null;
}

export type NewServiceDatabase = NewServicePart;

export interface NewServiceVariable {
  /** BaseModel's creating hook: new_public_id(). */
  uuid: string;
  key: string;
  /** The value already encrypted for environment_variables.value, or null. */
  value: string | null;
  isPreview: boolean;
  isRequired: boolean;
  isShared: boolean;
  isLiteral: boolean;
  isMultiline: boolean;
  comment: string | null;
  /** EnvironmentVariable's creating hook: config('constants.coolify.version'). */
  version: string;
  preserveComposeNull: boolean;
}

interface PartReference {
  kind: ServicePartKind;
  localId: number;
}

export interface NewServicePersistentVolume {
  uuid: string;
  name: string;
  mountPath: string;
  owner: PartReference;
}

export interface NewServiceFileVolume {
  uuid: string;
  fsPath: string;
  mountPath: string | null;
  /** The content already encrypted for local_file_volumes.content, or null. */
  content: string | null;
  isDirectory: boolean;
  isHostFile: boolean;
  variableFsPath: string | null;
  owner: PartReference;
}

/** `new Service([...])->save()` and everything `$service->parse(isNew: true)` stores after it. */
export interface NewParsedService {
  orgId: string;
  /** BaseModel's creating hook: new_public_id(). */
  uuid: string;
  name: string;
  environmentId: string | number;
  serverId: string | number;
  destinationId: string | number;
  destinationType: DestinationType;
  dockerComposeRaw: string;
  dockerCompose: string | null;
  connectToDockerNetwork: boolean;
  serviceType: string | null;
  /** Service's creating hook: the current parser version ('5'). */
  composeParsingVersion: string;
  isContainerLabelEscapeEnabled: boolean;
  includeCoolifyDefaultVariables: boolean;
  applications: NewServiceApplication[];
  databases: NewServiceDatabase[];
  variables: NewServiceVariable[];
  persistentVolumes: NewServicePersistentVolume[];
  fileVolumes: NewServiceFileVolume[];
}

const jsonOrNull = (value: unknown): string | null => (value === null ? null : JSON.stringify(value));

/**
 * The service and its parsed rows, in the order Coolify creates them (the service, its applications and
 * databases, its variables, its volumes), so that the ids ascend the same way. Every column not listed
 * keeps the schema's default (status 'exited', redact_all_env_values_in_logs true, …);
 * service_applications.max_restart_count is written as the model's 0 whatever the column's default.
 * The unique indexes of the volumes (one name, one mount path per part) hold by construction: the
 * parser names each once per part. Answers the service's id.
 */
export async function insertParsedService(tx: SqlExecutor, service: NewParsedService): Promise<string | number> {
  const inserted = await tx.execute<{ id: string | number }>(
    `INSERT INTO deploy.services
       (uuid, name, environment_id, server_id, destination_id, destination_type, docker_compose_raw, docker_compose,
        connect_to_docker_network, service_type, compose_parsing_version, is_container_label_escape_enabled,
        include_coolify_default_variables, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, ${NOW}, ${NOW})
     RETURNING id`,
    [
      service.uuid,
      service.name,
      service.environmentId,
      service.serverId,
      service.destinationId,
      DESTINATION_MORPH_CLASS[service.destinationType],
      service.dockerComposeRaw,
      service.dockerCompose,
      service.connectToDockerNetwork,
      service.serviceType,
      service.composeParsingVersion,
      service.isContainerLabelEscapeEnabled,
      service.includeCoolifyDefaultVariables,
      service.orgId,
    ],
  );
  const id = inserted.rows[0]!.id;
  const partIds: Record<ServicePartKind, Map<number, string | number>> = { application: new Map(), database: new Map() };

  for (const application of service.applications) {
    const r = await tx.execute<{ id: string | number }>(
      `INSERT INTO deploy.service_applications
         (uuid, name, human_name, fqdn, ports, image, exclude_from_status, is_log_drain_enabled, is_gzip_enabled, is_stripprefix_enabled,
          is_migrated, is_removed_from_compose, noindex_domains, redirect, is_force_https_enabled, is_permanent_redirect_enabled,
          domain_port_overrides, traefik_certificate_resolver, max_restart_count, service_id, org_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::json, $14, $15, $16, $17::json, $18, 0, $19, $20, ${NOW}, ${NOW})
       RETURNING id`,
      [
        application.uuid,
        application.name,
        application.humanName,
        application.fqdn,
        application.ports,
        application.image,
        application.excludeFromStatus,
        application.isLogDrainEnabled,
        application.isGzipEnabled,
        application.isStripprefixEnabled,
        application.isMigrated,
        application.isRemovedFromCompose,
        jsonOrNull(application.noindexDomains),
        application.redirect,
        application.isForceHttpsEnabled,
        application.isPermanentRedirectEnabled,
        jsonOrNull(application.domainPortOverrides),
        application.traefikCertificateResolver,
        id,
        service.orgId,
      ],
    );
    partIds.application.set(application.localId, r.rows[0]!.id);
  }
  for (const database of service.databases) {
    const r = await tx.execute<{ id: string | number }>(
      `INSERT INTO deploy.service_databases
         (uuid, name, human_name, ports, image, exclude_from_status, is_log_drain_enabled, is_gzip_enabled, is_stripprefix_enabled,
          is_migrated, is_removed_from_compose, service_id, org_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, ${NOW}, ${NOW})
       RETURNING id`,
      [
        database.uuid,
        database.name,
        database.humanName,
        database.ports,
        database.image,
        database.excludeFromStatus,
        database.isLogDrainEnabled,
        database.isGzipEnabled,
        database.isStripprefixEnabled,
        database.isMigrated,
        database.isRemovedFromCompose,
        id,
        service.orgId,
      ],
    );
    partIds.database.set(database.localId, r.rows[0]!.id);
  }
  for (const variable of service.variables) {
    await tx.execute(
      `INSERT INTO deploy.environment_variables
         (uuid, key, value, is_preview, is_required, is_shared, is_literal, is_multiline, comment, version, preserve_compose_null,
          resourceable_type, resourceable_id, org_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, ${NOW}, ${NOW})`,
      [
        variable.uuid,
        variable.key,
        variable.value,
        variable.isPreview,
        variable.isRequired,
        variable.isShared,
        variable.isLiteral,
        variable.isMultiline,
        variable.comment,
        variable.version,
        variable.preserveComposeNull,
        SERVICE_MORPH_CLASS,
        id,
        service.orgId,
      ],
    );
  }
  const owner = (reference: PartReference): [string, string | number] => {
    const partId = partIds[reference.kind].get(reference.localId);
    if (partId === undefined) throw new Error(`The volume's ${reference.kind} ${reference.localId} is not a part of the service.`);
    return [SERVICE_PART_MORPH_CLASS[reference.kind], partId];
  };
  for (const volume of service.persistentVolumes) {
    await tx.execute(
      `INSERT INTO deploy.local_persistent_volumes (uuid, name, mount_path, resource_type, resource_id, org_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, ${NOW}, ${NOW})`,
      [volume.uuid, volume.name, volume.mountPath, ...owner(volume.owner), service.orgId],
    );
  }
  for (const volume of service.fileVolumes) {
    await tx.execute(
      `INSERT INTO deploy.local_file_volumes (uuid, fs_path, mount_path, content, is_directory, is_host_file, variable_fs_path, resource_type, resource_id, org_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${NOW}, ${NOW})`,
      [volume.uuid, volume.fsPath, volume.mountPath, volume.content, volume.isDirectory, volume.isHostFile, volume.variableFsPath, ...owner(volume.owner), service.orgId],
    );
  }
  return id;
}

/** A service with the project and environment its pages are addressed by. */
export interface DeployServiceRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  description: string | null;
  service_type: string | null;
  docker_compose_raw: string;
  docker_compose: string | null;
  connect_to_docker_network: boolean;
  compose_parsing_version: string;
  environment_id: string | number;
  environment_uuid: string;
  environment_name: string;
  project_uuid: string;
  project_name: string;
  server_id: string | number | null;
  destination_id: string | number | null;
  destination_type: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

const SELECT_SERVICE = `SELECT s.id, s.uuid, s.name, s.description, s.service_type, s.docker_compose_raw, s.docker_compose, s.connect_to_docker_network,
        s.compose_parsing_version, s.environment_id, e.uuid AS environment_uuid, e.name AS environment_name, p.uuid AS project_uuid, p.name AS project_name,
        s.server_id, s.destination_id, s.destination_type, s.created_at, s.updated_at
   FROM deploy.services s
   JOIN deploy.environments e ON e.id = s.environment_id
   JOIN deploy.projects p ON p.id = e.project_id`;

export async function findServiceByUuid(tx: SqlExecutor, uuid: string): Promise<DeployServiceRow | null> {
  const r = await tx.execute<DeployServiceRow>(`${SELECT_SERVICE} WHERE s.uuid = $1 AND s.deleted_at IS NULL`, [uuid]);
  return r.rows[0] ?? null;
}

/** $environment->services: the environment's services, oldest first. */
export async function listEnvironmentServices(tx: SqlExecutor, environmentId: string | number): Promise<DeployServiceRow[]> {
  const r = await tx.execute<DeployServiceRow>(`${SELECT_SERVICE} WHERE s.environment_id = $1 AND s.deleted_at IS NULL ORDER BY s.id`, [environmentId]);
  return r.rows;
}

/** An application or database of a service, as its page lists it. */
export interface DeployServicePartRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  human_name: string | null;
  image: string | null;
  ports: string | null;
  status: string;
  /** Applications only. */
  fqdn: string | null;
  exclude_from_status: boolean;
  is_removed_from_compose: boolean;
}

const PART_COLUMNS = "id, uuid, name, human_name, image, ports, status, exclude_from_status, is_removed_from_compose";

/** $service->applications()->get(), oldest first. */
export async function listServiceApplications(tx: SqlExecutor, serviceId: string | number): Promise<DeployServicePartRow[]> {
  const r = await tx.execute<DeployServicePartRow>(`SELECT ${PART_COLUMNS}, fqdn FROM deploy.service_applications WHERE service_id = $1 AND deleted_at IS NULL ORDER BY id`, [serviceId]);
  return r.rows;
}

/** $service->databases()->get(), oldest first. */
export async function listServiceDatabases(tx: SqlExecutor, serviceId: string | number): Promise<DeployServicePartRow[]> {
  const r = await tx.execute<DeployServicePartRow>(`SELECT ${PART_COLUMNS}, NULL::text AS fqdn FROM deploy.service_databases WHERE service_id = $1 AND deleted_at IS NULL ORDER BY id`, [serviceId]);
  return r.rows;
}

/** What the parser reads of the server a service is created on: the server, its settings and its proxy. */
export interface DeployServiceServerRow extends SqlRow {
  id: string | number;
  uuid: string;
  ip: string;
  /** servers.proxy (JSON): type, status and what the proxy pages keep there. */
  proxy: unknown;
  wildcard_domain: string | null;
  generate_exact_labels: boolean | null;
  traefik_certificate_resolver: string | null;
  is_traffic_analytics_enabled: boolean | null;
}

export async function findServiceServer(tx: SqlExecutor, serverId: string | number): Promise<DeployServiceServerRow | null> {
  const r = await tx.execute<DeployServiceServerRow>(
    `SELECT s.id, s.uuid, s.ip, s.proxy, ss.wildcard_domain, ss.generate_exact_labels, ss.traefik_certificate_resolver, ss.is_traffic_analytics_enabled
       FROM deploy.servers s LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id
      WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [serverId],
  );
  return r.rows[0] ?? null;
}
