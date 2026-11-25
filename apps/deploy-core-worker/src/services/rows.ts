// Derived from coollabsio/coolify@91b7e3e:app/Models/{Service,ServiceApplication,ServiceDatabase,EnvironmentVariable,
// LocalPersistentVolume,LocalFileVolume}.php (Apache-2.0), modified.
//
// A stored service's rows in the parser's memory (store.ts) and back: Coolify's parser reads and saves
// Eloquent models one by one; here the rows are loaded once (values and file contents decrypted), the
// parser and the General page change them in memory, and what changed is written back in the same
// transaction — a row that was loaded is updated (by its id) or, for a variable or a file mount the
// parser removed, deleted; a row the parser created is inserted, a new part before the volumes that
// refer to it. Nothing is written for a row that did not change.
import type {
  DeployServiceConfigurationRow,
  DeployServicePartFileRow,
  DeployServicePartFullRow,
  DeployServicePartVolumeRow,
  DeployServiceVariableRow,
  ServicePartKind,
  ServiceRowChanges,
  ServiceWritable,
} from "@saas/db/deploy";
import { SERVICE_PART_MORPH_CLASS } from "@saas/db/deploy";
import { newPublicId } from "../helpers/names.js";
import type { KeyCipher } from "../private-keys/service.js";
import { MemoryServiceStore, type ServiceApplicationRow, type ServiceDatabaseRow, type ServiceEnvironmentVariableRow, type ServiceFileVolumeRow, type ServicePersistentVolumeRow, type ServiceSnapshot } from "./store.js";

type Id = string | number;

/** What reading and writing a service's rows needs (an SQL implementation in handlers/services.ts). */
export interface ServiceRowsStore {
  parts(kind: ServicePartKind, serviceId: Id): Promise<DeployServicePartFullRow[]>;
  variables(serviceId: Id): Promise<DeployServiceVariableRow[]>;
  volumes(serviceId: Id): Promise<DeployServicePartVolumeRow[]>;
  files(serviceId: Id): Promise<DeployServicePartFileRow[]>;
  update(kind: ServiceWritable, serviceId: Id, id: Id, changes: ServiceRowChanges): Promise<boolean>;
  insertPart(kind: ServicePartKind, serviceId: Id, uuid: string, row: ServiceRowChanges): Promise<Id>;
  insertVariable(serviceId: Id, uuid: string, row: ServiceRowChanges): Promise<Id>;
  insertStorage(kind: "volume" | "file", owner: { kind: ServicePartKind; id: Id }, uuid: string, row: ServiceRowChanges): Promise<Id>;
  deleteVariables(serviceId: Id, ids: Id[]): Promise<number>;
  deleteFiles(serviceId: Id, ids: Id[]): Promise<number>;
}

export interface ServiceRowCiphers {
  /** environment_variables.value */
  variables: KeyCipher;
  /** local_file_volumes.content */
  content: KeyCipher;
}

/** The service's rows in memory, with what they were when loaded (by table and id) so that only changes are written. */
export interface LoadedServiceRows {
  store: MemoryServiceStore;
  serviceId: Id;
  original: Map<string, string>;
}

const kindOf = (morph: string): ServicePartKind => (morph === SERVICE_PART_MORPH_CLASS.database ? "database" : "application");
const PART_COLUMNS = ["name", "human_name", "ports", "exclude_from_status", "image", "is_log_drain_enabled", "is_gzip_enabled", "is_stripprefix_enabled", "is_migrated", "is_removed_from_compose"] as const;
const APPLICATION_COLUMNS = [...PART_COLUMNS, "fqdn", "noindex_domains", "redirect", "is_force_https_enabled", "is_permanent_redirect_enabled", "domain_port_overrides", "traefik_certificate_resolver"] as const;
const SERVICE_COLUMNS = ["name", "docker_compose_raw", "docker_compose", "connect_to_docker_network", "is_container_label_escape_enabled"] as const;
const VARIABLE_COLUMNS = ["key", "value", "is_preview", "is_required", "is_shared", "is_literal", "is_multiline", "comment", "version", "preserve_compose_null"] as const;
const VOLUME_COLUMNS = ["name", "mount_path", "ignores_compose_driver_options"] as const;
const FILE_COLUMNS = ["fs_path", "mount_path", "content", "is_directory", "is_host_file", "variable_fs_path"] as const;

const pick = (row: object, columns: readonly string[]): Record<string, unknown> => Object.fromEntries(columns.map((column) => [column, (row as Record<string, unknown>)[column] ?? null]));
const json = (value: unknown): unknown => {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};
const numeric = (id: Id): number => Number(id);

/** The service and every row the parser works on, decrypted, in a store of its own. */
export async function loadServiceRows(rows: ServiceRowsStore, service: DeployServiceConfigurationRow, ciphers: ServiceRowCiphers): Promise<LoadedServiceRows> {
  const original = new Map<string, string>();
  const remember = (table: string, id: Id, row: object, columns: readonly string[]) => original.set(`${table}:${id}`, JSON.stringify(pick(row, columns)));
  const part = (row: DeployServicePartFullRow) => ({
    id: numeric(row.id),
    uuid: row.uuid,
    name: row.name,
    human_name: row.human_name,
    ports: row.ports,
    exclude_from_status: row.exclude_from_status,
    image: row.image,
    is_log_drain_enabled: row.is_log_drain_enabled,
    is_gzip_enabled: row.is_gzip_enabled,
    is_stripprefix_enabled: row.is_stripprefix_enabled,
    is_migrated: row.is_migrated,
    is_removed_from_compose: row.is_removed_from_compose,
  });
  const applications: ServiceApplicationRow[] = (await rows.parts("application", service.id)).map((row) => ({
    ...part(row),
    fqdn: row.fqdn,
    noindex_domains: json(row.noindex_domains) as string[] | null,
    redirect: row.redirect ?? "both",
    is_force_https_enabled: row.is_force_https_enabled !== false,
    is_permanent_redirect_enabled: row.is_permanent_redirect_enabled === true,
    domain_port_overrides: json(row.domain_port_overrides) as Record<string, number> | null,
    traefik_certificate_resolver: row.traefik_certificate_resolver,
  }));
  const databases: ServiceDatabaseRow[] = (await rows.parts("database", service.id)).map(part);
  const environmentVariables: ServiceEnvironmentVariableRow[] = [];
  for (const row of await rows.variables(service.id)) {
    environmentVariables.push({
      id: numeric(row.id),
      key: row.key,
      value: row.value === null ? null : await ciphers.variables.decrypt(row.value),
      is_preview: row.is_preview,
      is_required: row.is_required,
      is_shared: row.is_shared,
      is_literal: row.is_literal,
      is_multiline: row.is_multiline,
      comment: row.comment,
      version: row.version,
      preserve_compose_null: row.preserve_compose_null,
      is_shown_once: row.is_shown_once,
    });
  }
  const persistentVolumes: ServicePersistentVolumeRow[] = (await rows.volumes(service.id)).map((row) => ({
    id: numeric(row.id),
    name: row.name,
    mount_path: row.mount_path,
    resource_type: kindOf(row.resource_type),
    resource_id: numeric(row.resource_id),
    ignores_compose_driver_options: row.ignores_compose_driver_options,
  }));
  const fileVolumes: ServiceFileVolumeRow[] = [];
  for (const row of await rows.files(service.id)) {
    fileVolumes.push({
      id: numeric(row.id),
      fs_path: row.fs_path,
      mount_path: row.mount_path,
      content: row.content === null ? null : await ciphers.content.decrypt(row.content),
      resource_type: kindOf(row.resource_type),
      resource_id: numeric(row.resource_id),
      is_directory: row.is_directory,
      is_host_file: row.is_host_file,
      variable_fs_path: row.variable_fs_path,
      has_scheduled_backups: row.has_scheduled_backups,
    });
  }
  const snapshot: ServiceSnapshot = {
    service: {
      id: numeric(service.id),
      uuid: service.uuid,
      name: service.name,
      docker_compose_raw: service.docker_compose_raw,
      docker_compose: service.docker_compose,
      connect_to_docker_network: service.connect_to_docker_network,
      service_type: service.service_type,
      is_container_label_escape_enabled: service.is_container_label_escape_enabled,
      compose_parsing_version: service.compose_parsing_version,
      include_coolify_default_variables: service.include_coolify_default_variables,
    },
    applications,
    databases,
    environmentVariables,
    persistentVolumes,
    fileVolumes,
  };
  remember("service", snapshot.service.id, snapshot.service, SERVICE_COLUMNS);
  for (const row of applications) remember("application", row.id, row, APPLICATION_COLUMNS);
  for (const row of databases) remember("database", row.id, row, PART_COLUMNS);
  for (const row of environmentVariables) remember("variable", row.id, row, VARIABLE_COLUMNS);
  for (const row of persistentVolumes) remember("volume", row.id, row, VOLUME_COLUMNS);
  for (const row of fileVolumes) remember("file", row.id, row, FILE_COLUMNS);
  return { store: new MemoryServiceStore(snapshot), serviceId: service.id, original };
}

/** The columns of a row that differ from what was loaded. */
function changed(loaded: LoadedServiceRows, table: string, id: Id, row: object, columns: readonly string[]): Record<string, unknown> | null {
  const before = loaded.original.get(`${table}:${id}`);
  const now = pick(row, columns);
  if (before === undefined) return now;
  const was = JSON.parse(before) as Record<string, unknown>;
  const changes = Object.fromEntries(Object.entries(now).filter(([column, value]) => JSON.stringify(value) !== JSON.stringify(was[column])));
  return Object.keys(changes).length ? changes : null;
}

const loadedIds = (loaded: LoadedServiceRows, table: string): Set<string> => new Set([...loaded.original.keys()].filter((key) => key.startsWith(`${table}:`)).map((key) => key.slice(table.length + 1)));

/** Everything that changed since loadServiceRows(), written; values and contents encrypted again. */
export async function writeServiceRows(rows: ServiceRowsStore, loaded: LoadedServiceRows, ciphers: ServiceRowCiphers, newUuid: () => string = () => newPublicId()): Promise<void> {
  const snapshot = loaded.store.rows();
  const serviceId = loaded.serviceId;
  const serviceChanges = changed(loaded, "service", snapshot.service.id, snapshot.service, SERVICE_COLUMNS);
  if (serviceChanges) await rows.update("service", serviceId, serviceId, serviceChanges);

  // Parts: a new one is inserted and known by its new id from then on.
  const partIds: Record<ServicePartKind, Map<number, Id>> = { application: new Map(), database: new Map() };
  for (const [kind, list, columns] of [
    ["application", snapshot.applications, APPLICATION_COLUMNS],
    ["database", snapshot.databases, PART_COLUMNS],
  ] as const) {
    const known = loadedIds(loaded, kind);
    for (const row of list) {
      if (known.has(String(row.id))) {
        partIds[kind].set(row.id, row.id);
        const changes = changed(loaded, kind, row.id, row, columns);
        if (changes) await rows.update(kind, serviceId, row.id, changes);
      } else {
        partIds[kind].set(row.id, await rows.insertPart(kind, serviceId, row.uuid, pick(row, columns)));
      }
    }
  }
  const owner = (kind: ServicePartKind, id: number): { kind: ServicePartKind; id: Id } => {
    const found = partIds[kind].get(id);
    if (found === undefined) throw new Error(`a volume of ${kind} ${id}, which is not a part of the service`);
    return { kind, id: found };
  };

  const encrypt = async (cipher: KeyCipher, value: unknown): Promise<string | null> => (value === null || value === undefined ? null : cipher.encrypt(String(value)));
  // Variables
  const knownVariables = loadedIds(loaded, "variable");
  const keptVariables = new Set<string>();
  for (const row of snapshot.environmentVariables) {
    if (knownVariables.has(String(row.id))) {
      keptVariables.add(String(row.id));
      const changes = changed(loaded, "variable", row.id, row, VARIABLE_COLUMNS);
      if (changes) {
        if ("value" in changes) changes.value = await encrypt(ciphers.variables, changes.value);
        await rows.update("variable", serviceId, row.id, changes);
      }
    } else {
      const values = pick(row, VARIABLE_COLUMNS);
      values.value = await encrypt(ciphers.variables, values.value);
      await rows.insertVariable(serviceId, newUuid(), values);
    }
  }
  await rows.deleteVariables(serviceId, [...knownVariables].filter((id) => !keptVariables.has(id)));

  // Volumes (the parser never removes one) and file mounts.
  const knownVolumes = loadedIds(loaded, "volume");
  for (const row of snapshot.persistentVolumes) {
    if (knownVolumes.has(String(row.id))) {
      const changes = changed(loaded, "volume", row.id, row, VOLUME_COLUMNS);
      if (changes) await rows.update("volume", serviceId, row.id, changes);
    } else {
      const values = pick(row, VOLUME_COLUMNS);
      values.mount_path ??= "";
      await rows.insertStorage("volume", owner(row.resource_type, row.resource_id), newUuid(), values);
    }
  }
  const knownFiles = loadedIds(loaded, "file");
  const keptFiles = new Set<string>();
  for (const row of snapshot.fileVolumes) {
    if (knownFiles.has(String(row.id))) {
      keptFiles.add(String(row.id));
      const changes = changed(loaded, "file", row.id, row, FILE_COLUMNS);
      if (changes) {
        if ("content" in changes) changes.content = await encrypt(ciphers.content, changes.content);
        await rows.update("file", serviceId, row.id, changes);
      }
    } else {
      const values = pick(row, FILE_COLUMNS);
      values.content = await encrypt(ciphers.content, values.content);
      values.fs_path ??= "";
      await rows.insertStorage("file", owner(row.resource_type, row.resource_id), newUuid(), values);
    }
  }
  await rows.deleteFiles(serviceId, [...knownFiles].filter((id) => !keptFiles.has(id)));
}
