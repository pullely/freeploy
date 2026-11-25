// Derived from coollabsio/coolify@91b7e3e:app/Models/{Service,ServiceApplication,ServiceDatabase,
// EnvironmentVariable,LocalPersistentVolume,LocalFileVolume}.php and the column defaults of
// database/migrations (Apache-2.0), modified.
//
// The rows Coolify's service parser reads and writes, and the store it works on. The parser is a
// synchronous function over `ServiceStore`; `MemoryServiceStore` is the implementation: the rows of one
// service in memory, with ids counted from 1 per table the way a fresh database numbers them. A caller
// with a database loads the service's rows into it, runs the parser, and writes the rows back.
//
// The rows carry the columns the parser reads or writes, under Coolify's column names. Columns it never
// touches (status, restart counters, descriptions, …) are not here; their defaults are the database's.

export interface ServiceRow {
  id: number;
  uuid: string;
  name: string;
  /** The Compose file as the user (or the template) wrote it. */
  docker_compose_raw: string | null;
  /** The Compose file Coolify deploys: what the parser writes. */
  docker_compose: string | null;
  connect_to_docker_network: boolean;
  service_type: string | null;
  is_container_label_escape_enabled: boolean;
  compose_parsing_version: string;
  include_coolify_default_variables: boolean;
}

interface ServicePartRow {
  id: number;
  uuid: string;
  name: string;
  human_name: string | null;
  /** "8080:80,53:53/udp": the published ports of the Compose service. */
  ports: string | null;
  exclude_from_status: boolean;
  image: string | null;
  is_log_drain_enabled: boolean;
  is_gzip_enabled: boolean;
  is_stripprefix_enabled: boolean;
  /** The user moved the part between applications and databases; it keeps its kind whatever the image. */
  is_migrated: boolean;
  is_removed_from_compose: boolean;
}

export interface ServiceApplicationRow extends ServicePartRow {
  fqdn: string | null;
  noindex_domains: string[] | null;
  redirect: string;
  is_force_https_enabled: boolean;
  is_permanent_redirect_enabled: boolean;
  domain_port_overrides: Record<string, number> | null;
  traefik_certificate_resolver: string | null;
}

export type ServiceDatabaseRow = ServicePartRow;

export type ServicePart = { kind: "application"; row: ServiceApplicationRow } | { kind: "database"; row: ServiceDatabaseRow };

export interface ServiceEnvironmentVariableRow {
  id: number;
  key: string;
  value: string | null;
  is_preview: boolean;
  is_required: boolean;
  is_shared: boolean;
  is_literal: boolean;
  is_multiline: boolean;
  comment: string | null;
  /** The Coolify version that created the variable. */
  version: string;
  preserve_compose_null: boolean;
}

export type ServicePartKind = ServicePart["kind"];

export interface ServicePersistentVolumeRow {
  id: number;
  name: string;
  mount_path: string | null;
  resource_type: ServicePartKind;
  resource_id: number;
  ignores_compose_driver_options: boolean;
}

export interface ServiceFileVolumeRow {
  id: number;
  fs_path: string | null;
  mount_path: string | null;
  content: string | null;
  resource_type: ServicePartKind;
  resource_id: number;
  is_directory: boolean;
  is_host_file: boolean;
  variable_fs_path: string | null;
  /** Coolify keeps a directory that has backup schedules; the caller says whether this one has. */
  has_scheduled_backups?: boolean;
}

export interface ServiceStore {
  readonly service: ServiceRow;
  applications(): ServiceApplicationRow[];
  databases(): ServiceDatabaseRow[];
  createApplication(name: string, uuid: string): ServiceApplicationRow;
  createDatabase(name: string, uuid: string): ServiceDatabaseRow;
  environmentVariables(): ServiceEnvironmentVariableRow[];
  createEnvironmentVariable(values: Omit<ServiceEnvironmentVariableRow, "id">): ServiceEnvironmentVariableRow;
  deleteEnvironmentVariable(row: ServiceEnvironmentVariableRow): void;
  persistentVolumes(): ServicePersistentVolumeRow[];
  createPersistentVolume(values: Omit<ServicePersistentVolumeRow, "id">): ServicePersistentVolumeRow;
  fileVolumes(): ServiceFileVolumeRow[];
  createFileVolume(values: Omit<ServiceFileVolumeRow, "id">): ServiceFileVolumeRow;
  deleteFileVolume(row: ServiceFileVolumeRow): void;
}

export interface ServiceSnapshot {
  service: ServiceRow;
  applications: ServiceApplicationRow[];
  databases: ServiceDatabaseRow[];
  environmentVariables: ServiceEnvironmentVariableRow[];
  persistentVolumes: ServicePersistentVolumeRow[];
  fileVolumes: ServiceFileVolumeRow[];
}

const nextId = (rows: readonly { id: number }[]): number => rows.reduce((highest, row) => Math.max(highest, row.id), 0) + 1;

/** The column defaults of a new service_applications / service_databases row. */
function newPart(id: number, name: string, uuid: string): ServicePartRow {
  return {
    id,
    uuid,
    name,
    human_name: null,
    ports: null,
    exclude_from_status: false,
    image: null,
    is_log_drain_enabled: false,
    is_gzip_enabled: true,
    is_stripprefix_enabled: true,
    is_migrated: false,
    is_removed_from_compose: false,
  };
}

/** The rows of one service, in memory. Rows are handed out by reference: changing one changes the store. */
export class MemoryServiceStore implements ServiceStore {
  readonly service: ServiceRow;
  private readonly snapshot: ServiceSnapshot;

  constructor(snapshot: ServiceSnapshot) {
    this.snapshot = snapshot;
    this.service = snapshot.service;
  }

  /** A store holding a service that has no parts yet. */
  static forService(service: ServiceRow): MemoryServiceStore {
    return new MemoryServiceStore({ service, applications: [], databases: [], environmentVariables: [], persistentVolumes: [], fileVolumes: [] });
  }

  rows(): ServiceSnapshot {
    return this.snapshot;
  }

  applications(): ServiceApplicationRow[] {
    return this.snapshot.applications;
  }

  databases(): ServiceDatabaseRow[] {
    return this.snapshot.databases;
  }

  createApplication(name: string, uuid: string): ServiceApplicationRow {
    const row: ServiceApplicationRow = {
      ...newPart(nextId(this.snapshot.applications), name, uuid),
      fqdn: null,
      noindex_domains: null,
      redirect: "both",
      is_force_https_enabled: true,
      is_permanent_redirect_enabled: false,
      domain_port_overrides: null,
      traefik_certificate_resolver: null,
    };
    this.snapshot.applications.push(row);
    return row;
  }

  createDatabase(name: string, uuid: string): ServiceDatabaseRow {
    const row = newPart(nextId(this.snapshot.databases), name, uuid);
    this.snapshot.databases.push(row);
    return row;
  }

  environmentVariables(): ServiceEnvironmentVariableRow[] {
    return this.snapshot.environmentVariables;
  }

  createEnvironmentVariable(values: Omit<ServiceEnvironmentVariableRow, "id">): ServiceEnvironmentVariableRow {
    const row = { id: nextId(this.snapshot.environmentVariables), ...values };
    this.snapshot.environmentVariables.push(row);
    return row;
  }

  deleteEnvironmentVariable(row: ServiceEnvironmentVariableRow): void {
    const index = this.snapshot.environmentVariables.indexOf(row);
    if (index !== -1) this.snapshot.environmentVariables.splice(index, 1);
  }

  persistentVolumes(): ServicePersistentVolumeRow[] {
    return this.snapshot.persistentVolumes;
  }

  createPersistentVolume(values: Omit<ServicePersistentVolumeRow, "id">): ServicePersistentVolumeRow {
    const row = { id: nextId(this.snapshot.persistentVolumes), ...values };
    this.snapshot.persistentVolumes.push(row);
    return row;
  }

  fileVolumes(): ServiceFileVolumeRow[] {
    return this.snapshot.fileVolumes;
  }

  createFileVolume(values: Omit<ServiceFileVolumeRow, "id">): ServiceFileVolumeRow {
    const row = { id: nextId(this.snapshot.fileVolumes), ...values };
    this.snapshot.fileVolumes.push(row);
    return row;
  }

  deleteFileVolume(row: ServiceFileVolumeRow): void {
    const index = this.snapshot.fileVolumes.indexOf(row);
    if (index !== -1) this.snapshot.fileVolumes.splice(index, 1);
  }
}
