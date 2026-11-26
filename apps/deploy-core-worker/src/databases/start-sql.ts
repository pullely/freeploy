// Derived from coollabsio/coolify@91b7e3e:app/Actions/Database/Start*.php (what a start loads: the database with
// its destination, server, volumes, file mounts and variables), app/Helpers/SslHelper.php (generateSslCertificate:
// the rows) and app/Models/EnvironmentVariable.php (the value accessor, get_real_environment_variables_internal)
// (Apache-2.0), modified.
//
// The database engine's world, from Postgres: what an operation reads (loadDatabaseOperationContext, in one
// transaction of its org) and what it writes (sqlDatabaseOperationStore). `run` decides the transactions: a
// start gives each write its own, as each of Coolify's queries is its own — the mark that a database has been
// handed to a server must stay when a later step fails. Encrypted columns are read with the org's key; nothing
// decrypted is stored anywhere.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  DATABASE_TABLES,
  databaseOwner,
  deleteDatabaseCertificates,
  deleteFileVolumesByMountPath,
  deleteSslCertificates,
  findDatabaseByUuid,
  findDatabaseCertificate,
  findDatabaseForOperation,
  findDatabaseVariable,
  findServerCaCertificate,
  findSharedVariableForReference,
  insertCertificateFileVolume,
  insertSslCertificate,
  listDatabaseStartVariables,
  listFileVolumes,
  listPersistentVolumes,
  markDatabaseStarted,
  resetDatabaseRestartCounters,
  setDatabaseStatus,
  touchDatabaseLastOnline,
  updateDatabase,
  updateDatabaseVariableValue,
  type DatabaseEngine,
  type SharedVariableRefScope,
} from "@saas/db/deploy";
import { serverIsFunctional } from "../deployments/engine.js";
import { withoutEdgeLineBreaks } from "../environment-variables/env-format.js";
import { isSharedReference, resolveRealValue, SHARED_VARIABLE_TYPES, sharedVariableReferences, type ResolvedSharedVariable, type SharedVariableType } from "../environment-variables/references.js";
import { columnCipher } from "../handlers/cloud-tokens.js";
import { newPublicId } from "../helpers/names.js";
import { SSL_CERTIFICATE_COLUMN, SSL_PRIVATE_KEY_COLUMN } from "../ssl/ca-certificate.js";
import type { ContentFile } from "./content-files.js";
import { initScripts } from "./service.js";
import type { DatabaseOperationContext, DatabaseOperationStore } from "./start-engine.js";
import type { StartVariable } from "./start-plan.js";

const VARIABLE_COLUMN = "environment_variables.value";
const SHARED_VARIABLE_COLUMN = "shared_environment_variables.value";
const FILE_CONTENT_COLUMN = "local_file_volumes.content";

/** Which database an operation is about, and where it runs. */
export interface DatabaseOperationTarget {
  engine: DatabaseEngine;
  id: string | number;
  uuid: string;
  /** null for a database whose destination or server is gone. */
  serverId: string | number | null;
  serverUuid: string | null;
}

/** Runs one unit of the store's work in a transaction of the org. */
export type OrgRun = <T>(fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;

/** The database's file mounts with their content decrypted, oldest first. */
async function loadFileStorages(tx: SqlExecutor, orgId: string, secret: string | undefined, target: Pick<DatabaseOperationTarget, "engine" | "id">): Promise<ContentFile[]> {
  const cipher = columnCipher(tx, orgId, secret, FILE_CONTENT_COLUMN);
  const files: ContentFile[] = [];
  for (const row of await listFileVolumes(tx, databaseOwner(target.engine, target.id))) {
    files.push({
      fs_path: row.fs_path,
      mount_path: row.mount_path,
      content: row.content === null ? null : await cipher.decrypt(row.content),
      is_directory: row.is_directory,
      is_host_file: row.is_host_file,
      is_based_on_git: row.is_based_on_git,
      chown: row.chown,
      chmod: row.chmod,
    });
  }
  return files;
}

/** Everything an operation on the database with this uuid reads. Null when the database is not the org's. */
export async function loadDatabaseOperationContext(tx: SqlExecutor, orgId: string, secret: string | undefined, uuid: string): Promise<{ target: DatabaseOperationTarget; ctx: DatabaseOperationContext } | null> {
  const found = await findDatabaseByUuid(tx, uuid);
  if (!found) return null;
  const engine = found.engine;
  const row = await findDatabaseForOperation(tx, engine, found.id);
  if (!row) return null;
  const table = DATABASE_TABLES[engine];
  const owner = databaseOwner(engine, row.id);

  // The engine's own columns, the `encrypted` ones decrypted.
  const values: Record<string, string | null> = {};
  for (const column of table.columns) {
    if (table.json.includes(column)) continue;
    const stored = row[column];
    const text = stored === null || stored === undefined ? null : String(stored);
    values[column] = text !== null && table.encrypted.includes(column) ? await columnCipher(tx, orgId, secret, `${table.table}.${column}`).decrypt(text) : text;
  }

  // The variables, with their shared variable references filled in — locked ones too, as only a start may.
  const cipher = columnCipher(tx, orgId, secret, VARIABLE_COLUMN);
  const sharedCipher = columnCipher(tx, orgId, secret, SHARED_VARIABLE_COLUMN);
  const scopes: Record<SharedVariableType, SharedVariableRefScope | null> = {
    team: { type: "team" },
    project: { type: "project", id: row.project_id },
    environment: { type: "environment", id: row.environment_id },
    server: row.server_id === null ? null : { type: "server", id: row.server_id },
  };
  const shared = new Map<string, ResolvedSharedVariable | null>();
  const variables: StartVariable[] = [];
  for (const variable of await listDatabaseStartVariables(tx, owner)) {
    // The value accessor: null for a stored null or '', else the decrypted value without its edge line breaks.
    const value = variable.value ? withoutEdgeLineBreaks(await cipher.decrypt(variable.value)) : null;
    for (const reference of sharedVariableReferences(value)) {
      const name = `${reference.type}.${reference.key}`;
      if (shared.has(name)) continue;
      const scope = (SHARED_VARIABLE_TYPES as readonly string[]).includes(reference.type) ? scopes[reference.type as SharedVariableType] : null;
      const sharedRow = scope ? await findSharedVariableForReference(tx, scope, reference.key) : null;
      shared.set(name, sharedRow ? { value: await sharedCipher.decrypt(sharedRow.value), isShownOnce: sharedRow.is_shown_once } : null);
    }
    variables.push({
      key: variable.key,
      value,
      realValue: resolveRealValue(value, { find: (type, key) => shared.get(`${type}.${key}`) ?? null }),
      is_literal: variable.is_literal,
      is_multiline: variable.is_multiline,
      uses_legacy_escaping: variable.uses_legacy_escaping,
    });
  }

  const ctx: DatabaseOperationContext = {
    engine,
    database: {
      uuid: row.uuid,
      name: row.name,
      image: row.image,
      // SQLite's table has no ports_mappings, public_port or public_port_timeout.
      ports_mappings: row.ports_mappings ?? null,
      limits_memory: row.limits_memory,
      limits_memory_swap: row.limits_memory_swap,
      limits_memory_swappiness: Number(row.limits_memory_swappiness),
      limits_memory_reservation: row.limits_memory_reservation,
      limits_cpus: row.limits_cpus,
      limits_cpuset: row.limits_cpuset,
      limits_cpu_shares: Number(row.limits_cpu_shares),
      custom_docker_run_options: row.custom_docker_run_options,
      enable_ssl: row.enable_ssl === true,
      ssl_mode: row.ssl_mode ?? null,
      legacy_password_quoting: row.legacy_password_quoting === true,
      is_log_drain_enabled: row.is_log_drain_enabled,
      include_coolify_default_variables: row.include_coolify_default_variables,
      health_check_enabled: row.health_check_enabled,
      health_check_interval: Number(row.health_check_interval),
      health_check_timeout: Number(row.health_check_timeout),
      health_check_retries: Number(row.health_check_retries),
      health_check_start_period: Number(row.health_check_start_period),
      values,
      init_scripts: engine === "postgresql" ? initScripts(row.init_scripts) : null,
      status: row.status,
      is_public: row.is_public,
      public_port: row.public_port === null || row.public_port === undefined ? null : Number(row.public_port),
      public_port_timeout: row.public_port_timeout === null || row.public_port_timeout === undefined ? null : Number(row.public_port_timeout),
    },
    projectName: row.project_name,
    environmentName: row.environment_name,
    network: row.destination_network ?? "",
    server: {
      ip: row.server_ip,
      user: row.server_user ?? "root",
      functional: row.server_id !== null && row.destination_network !== null && serverIsFunctional(row),
      swarm: Boolean(row.server_is_swarm_manager) || Boolean(row.server_is_swarm_worker),
      dockerVersion: row.server_docker_version,
      logDrain: {
        is_logdrain_newrelic_enabled: row.server_is_logdrain_newrelic_enabled,
        is_logdrain_axiom_enabled: row.server_is_logdrain_axiom_enabled,
        is_logdrain_custom_enabled: row.server_is_logdrain_custom_enabled,
        is_logdrain_cloudwatch_enabled: row.server_is_logdrain_cloudwatch_enabled,
        logdrain_cloudwatch_region: row.server_logdrain_cloudwatch_region,
        logdrain_cloudwatch_group: row.server_logdrain_cloudwatch_group,
        logdrain_cloudwatch_stream_prefix: row.server_logdrain_cloudwatch_stream_prefix,
      },
    },
    persistentStorages: (await listPersistentVolumes(tx, owner)).map((volume) => ({ name: volume.name, mount_path: volume.mount_path, host_path: volume.host_path })),
    fileStorages: await loadFileStorages(tx, orgId, secret, { engine, id: row.id }),
    variables,
  };
  return { target: { engine, id: row.id, uuid: row.uuid, serverId: row.server_id, serverUuid: row.server_uuid }, ctx };
}

/** The operation's writes. */
export function sqlDatabaseOperationStore(run: OrgRun, orgId: string, secret: string | undefined, target: DatabaseOperationTarget): DatabaseOperationStore {
  const { engine, id } = target;
  const owner = databaseOwner(engine, id);
  /** A database without a server never gets this far: the engine refuses it first. */
  const serverId = (): string | number => {
    if (target.serverId === null) throw new Error("The database has no server.");
    return target.serverId;
  };
  const sealed = async (tx: SqlExecutor, generated: { sslCertificate: string; sslPrivateKey: string }) => ({
    sslCertificate: await columnCipher(tx, orgId, secret, SSL_CERTIFICATE_COLUMN).encrypt(generated.sslCertificate),
    sslPrivateKey: await columnCipher(tx, orgId, secret, SSL_PRIVATE_KEY_COLUMN).encrypt(generated.sslPrivateKey),
  });
  return {
    markStarted: async () => {
      await run((tx) => markDatabaseStarted(tx, engine, id));
    },
    setStatus: async (status) => {
      await run((tx) => setDatabaseStatus(tx, engine, id, status));
    },
    resetRestartCounters: async () => {
      await run((tx) => resetDatabaseRestartCounters(tx, engine, id));
    },
    touchLastOnline: async () => {
      await run((tx) => touchDatabaseLastOnline(tx, engine, id));
    },
    setPublic: async (isPublic) => {
      await run((tx) => updateDatabase(tx, engine, id, { is_public: isPublic }));
    },
    setPostgresConf: async (conf) => {
      await run((tx) => updateDatabase(tx, engine, id, { postgres_conf: conf }));
    },
    setVariableValue: (key, value) =>
      run(async (tx) => {
        const variable = await findDatabaseVariable(tx, owner, key);
        if (variable) await updateDatabaseVariableValue(tx, owner, variable.id, await columnCipher(tx, orgId, secret, VARIABLE_COLUMN).encrypt(value), isSharedReference(value));
      }),
    findCaCertificate: () =>
      run(async (tx) => {
        const ca = await findServerCaCertificate(tx, serverId());
        if (!ca) return null;
        return {
          certificate: await columnCipher(tx, orgId, secret, SSL_CERTIFICATE_COLUMN).decrypt(ca.ssl_certificate),
          privateKey: await columnCipher(tx, orgId, secret, SSL_PRIVATE_KEY_COLUMN).decrypt(ca.ssl_private_key),
        };
      }),
    replaceCaCertificate: (generated) =>
      run(async (tx) => {
        const server = { serverId: serverId(), resourceType: null, resourceId: null };
        await deleteSslCertificates(tx, server);
        await insertSslCertificate(tx, {
          ...server,
          orgId,
          ...(await sealed(tx, generated)),
          configurationDir: null,
          mountPath: null,
          commonName: generated.commonName,
          subjectAlternativeNames: generated.subjectAlternativeNames,
          validUntil: generated.validUntil,
          isCaCertificate: true,
        });
      }),
    findCertificate: () =>
      run(async (tx) => {
        const row = await findDatabaseCertificate(tx, owner);
        if (!row) return null;
        let names: unknown = row.subject_alternative_names;
        if (typeof names === "string") {
          try {
            names = JSON.parse(names) as unknown;
          } catch {
            names = [];
          }
        }
        return { commonName: row.common_name, subjectAlternativeNames: Array.isArray(names) ? names.map(String) : [], configurationDir: row.configuration_dir, mountPath: row.mount_path };
      }),
    deleteCertificates: async () => {
      await run((tx) => deleteDatabaseCertificates(tx, owner));
    },
    deleteFileStorages: (mountPaths) =>
      run(async (tx) => {
        await deleteFileVolumesByMountPath(tx, owner, mountPaths);
        return loadFileStorages(tx, orgId, secret, target);
      }),
    replaceCertificate: (generated, where, mountPaths, files) =>
      run(async (tx) => {
        const resource = { serverId: serverId(), resourceType: owner.type, resourceId: id };
        await deleteSslCertificates(tx, resource);
        await insertSslCertificate(tx, {
          ...resource,
          orgId,
          ...(await sealed(tx, generated)),
          configurationDir: where.configurationDir,
          mountPath: where.mountPath,
          commonName: generated.commonName,
          subjectAlternativeNames: generated.subjectAlternativeNames,
          validUntil: generated.validUntil,
          isCaCertificate: false,
        });
        await deleteFileVolumesByMountPath(tx, owner, mountPaths);
        const cipher = columnCipher(tx, orgId, secret, FILE_CONTENT_COLUMN);
        for (const file of files) {
          await insertCertificateFileVolume(tx, { orgId, owner, uuid: newPublicId(), fsPath: file.fs_path, mountPath: file.mount_path, content: await cipher.encrypt(file.content), chmod: file.chmod });
        }
        return loadFileStorages(tx, orgId, secret, target);
      }),
  };
}
