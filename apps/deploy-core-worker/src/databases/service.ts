// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Resource/{Create,Index}.php (createResource: the
// database branch; toSearchableArray), bootstrap/helpers/databases.php (create_standalone_*), bootstrap/helpers/shared.php
// (find_resource_destination_for_current_team), app/Models/Standalone*.php (the status accessor, server_status, the
// name, description and ports_mappings mutators, isCredentialLocked), app/Livewire/Project/Database/{Configuration,
// Heading}.php, app/Livewire/Project/Database/*/General.php (mount, syncData, submit, instantSave, instantSaveAdvanced,
// the init script actions, keepCurrentDataVolume), app/Traits/HasDatabaseStatusInfo.php (refresh, instantSaveSSL,
// regenerateSslCertificate), app/Livewire/Project/Shared/Danger.php and app/Jobs/DeleteResourceJob.php
// (Apache-2.0), modified; Str::password() follows laravel/framework's Illuminate\Support\Str (MIT).
//
// What creating a standalone database and its General page do, as plain
// operations on one org's databases, for the nine engines at once (what
// differs between them is engines.ts). Nothing here talks to a server:
// creating a database stores its rows and starts nothing, as
// Create::createResource() does. Start, Restart and Stop (operations.ts), the
// public TCP proxy, and the files of an init script need the SSH executor,
// which is not deployed yet: where Coolify stores first and then runs, the row
// is stored; where it runs first — or puts the row back when the run fails —
// nothing is stored and the answer is 501. The proxy and a certificate's files
// are done through ctx.server once it gives an executor.
import type { DatabaseColumnValue, DatabaseEngine, DeployDatabaseRow, DeployDatabaseVariableRow, DeployDestinationRow, DeployEnvironmentListRow, DeployProjectRow, DeployServerRow, NewDatabase, NewDatabaseVariable } from "@saas/db/deploy";
import { DATABASE_TABLES } from "@saas/db/deploy";
import type { KeyCipher } from "../private-keys/service.js";
import type { FieldErrors } from "../private-keys/validation.js";
import { newPublicId } from "../helpers/names.js";
import { effectiveServerRole } from "../servers/service.js";
import { stripTags } from "../applications/tags.js";
import { needsExecutor } from "../applications/resources.js";
import type { DeleteOptions } from "../applications/danger.js";
import { ENVIRONMENT_VARIABLE_VERSION } from "../environment-variables/service.js";
import { isSharedReference } from "../environment-variables/references.js";
import { DATABASE_ENGINE_SPECS, SUPABASE_ADMIN, defaultVolumes, isSupabaseImage, type DatabaseEngineSpec, type DatabaseField, type SslMode } from "./engines.js";
import { externalDbUrl, internalDbUrl, redisHasUsername, redisUsername, redisVersion, sanitizeString, type DatabaseUrlInput } from "./urls.js";
import { OPERATION_MESSAGES, regenerateCertificate, startDatabaseProxy, stopDatabaseProxy, type DatabaseServerAccess } from "./operations.js";
import { RemoteCommandError } from "./content-files.js";
import { FilenameError, coerceBoolean, normalizeSqliteDatabases, validateDatabaseGeneral, validateFilenameSafe, validateNewInitScript, type CreateDatabaseInput } from "./validation.js";

type Id = string | number;
type Body = Record<string, unknown>;

export interface DatabaseStore {
  findProject(uuid: string): Promise<DeployProjectRow | null>;
  findEnvironment(projectId: Id, uuid: string): Promise<DeployEnvironmentListRow | null>;
  /** find_destination_for_current_team() */
  findDestination(uuid: string): Promise<DeployDestinationRow | null>;
  findServer(uuid: string): Promise<DeployServerRow | null>;
  /** $database->save() in create_standalone_*(), with the created hook's volumes. */
  insert(engine: DatabaseEngine, database: Omit<NewDatabase, "orgId">): Promise<DeployDatabaseRow>;
  findByUuid(uuid: string): Promise<DeployDatabaseRow | null>;
  update(engine: DatabaseEngine, id: Id, changes: Record<string, DatabaseColumnValue>): Promise<DeployDatabaseRow | null>;
  /** runtime_environment_variables()->where('key', $key)->first() */
  findVariable(engine: DatabaseEngine, id: Id, key: string): Promise<DeployDatabaseVariableRow | null>;
  insertVariable(engine: DatabaseEngine, id: Id, variable: Omit<NewDatabaseVariable, "orgId">): Promise<DeployDatabaseVariableRow>;
  updateVariableValue(engine: DatabaseEngine, id: Id, variableId: Id, value: string | null, isShared: boolean): Promise<boolean>;
  /** sslCertificates()->first()?->valid_until */
  certificateValidUntil(engine: DatabaseEngine, id: Id): Promise<string | Date | null>;
  /** deleteLocalResource() and forceDelete() */
  delete(engine: DatabaseEngine, id: Id): Promise<boolean>;
  /**
   * StandaloneSqlite::connectedApplicationNames() when hasConnectedApplications(), else null: who mounts a SQLite
   * database's data volume. Absent, nothing does.
   */
  sqliteMounts?(id: Id, serverId: Id | null): Promise<string[] | null>;
}

/** The two random sources of create_standalone_*(), replaceable in tests. */
export interface DatabaseRandom {
  /** new_public_id() */
  publicId(): string;
  /** Str::password(length: 64, symbols: false) */
  password(): string;
}

export interface DatabaseContext {
  store: DatabaseStore;
  /** The cipher of an `encrypted` column, by "<table>.<column>" (the value is bound to its org and that name). */
  cipher(column: string): KeyCipher;
  random?: DatabaseRandom;
  /**
   * One database's rows and server for what runs there: the TCP proxy, a certificate's rows and files. Its
   * `executor` is null while the SSH executor is not available; absent, nothing of it can be done.
   */
  server?: (uuid: string) => Promise<DatabaseServerAccess | null>;
}

export const DATABASE_SERVICE_MESSAGES = {
  /** Freeploy's, as DockerImage::submit()'s: Create::mount() redirects to the dashboard when the destination is not the team's. */
  destinationNotFound: "Destination not found.",
  /** General::submit() */
  updated: "Database updated.",
  /** General::instantSaveAdvanced() */
  restartNeeded: "You need to restart the service for the changes to take effect.",
  logDrainNotEnabled: "Log drain is not enabled on the server. Please enable it first.",
  /** General::instantSave() */
  publicPortRequired: "Public port is required.",
  mustBeStarted: "Database must be started to be publicly accessible.",
  nowPublic: "Database is now publicly accessible.",
  noLongerPublic: "Database is no longer publicly accessible.",
  /** HasDatabaseStatusInfo */
  sslUpdated: "SSL configuration updated.",
  noCertificate: "No existing SSL certificate found for this database.",
  noCaCertificate: "No CA certificate found for this database. Please generate a CA certificate for this server in the server/advanced page.",
  /** The init script actions of Postgresql\General */
  scriptAdded: "Init script added.",
  scriptSaved: "Init script saved and updated.",
  scriptExists: "A script with this filename already exists.",
  filenameExists: "Filename already exists.",
  /** Freeploy's: the SSH executor is not deployed yet. */
  startUnavailable: needsExecutor("Starting the database"),
  restartUnavailable: needsExecutor("Restarting the database"),
  stopUnavailable: needsExecutor("Stopping the database"),
  proxyStartUnavailable: needsExecutor("Starting the database's TCP proxy on the server"),
  proxyStopUnavailable: needsExecutor("Stopping the database's TCP proxy on the server"),
  scriptRenameUnavailable: needsExecutor("Removing the renamed init script's file from the server"),
  scriptDeleteUnavailable: needsExecutor("Removing the init script's file from the server"),
  dataVolumeUnavailable: needsExecutor("Reading the database container's data volume on the server"),
  deleteUnavailable: needsExecutor("Stopping the database and removing its container, volumes and configuration files from the server"),
  /** Freeploy's: a certificate's rows cannot be reached (no store for them was given). */
  certificateUnavailable: "Regenerating the database's SSL certificate is not available yet.",
  certificateFilesUnavailable: needsExecutor("Writing the new certificate files to the server"),
  sslUnsupported: "This database has no SSL configuration.",
  /** Freeploy's: Sqlite\General has no instantSave() (a SQLite database is never reached over TCP). */
  accessUnsupported: "This database has no Access settings.",
  /** Danger::delete() and delete_by_uuid() for a SQLite database whose data volume an application mounts. */
  sqliteMounted: (names: readonly string[]) => `This database volume is mounted by ${names.join(", ")}. Remove those mounts before deleting the database.`,
  notPostgresql: "Only a PostgreSQL database has initialization scripts.",
} as const;

/** A failure Coolify reports through an exception or dispatch('error'). */
export class DatabaseError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
  }
}

/** A ValidationException: Laravel's errors by field. */
export class DatabaseFieldErrors extends Error {
  constructor(readonly fields: FieldErrors) {
    super("Validation failed");
  }
}

const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";

/** random_int(0, $max - 1) */
function randomInt(max: number): number {
  const limit = Math.floor(0x100000000 / max) * max;
  const draw = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(draw);
    if (draw[0]! < limit) return draw[0]! % max;
  }
}

/**
 * Str::password($length, symbols: false): one letter and one digit to begin
 * with, the rest drawn from both sets together, then shuffled.
 */
export function strPassword(length = 64, random: (max: number) => number = randomInt): string {
  const pool = LETTERS + DIGITS;
  const chars = [LETTERS[random(LETTERS.length)]!, DIGITS[random(DIGITS.length)]!];
  while (chars.length < length) chars.push(pool[random(pool.length)]!);
  // Collection::shuffle(): a Fisher–Yates pass.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.slice(0, length).join("");
}

const DEFAULT_RANDOM: DatabaseRandom = { publicId: () => newPublicId(), password: () => strPassword(64) };

const cipherFor = (ctx: DatabaseContext, engine: DatabaseEngine, column: string): KeyCipher => ctx.cipher(`${DATABASE_TABLES[engine].table}.${column}`);
const VARIABLE_COLUMN = "environment_variables.value";

/**
 * What Coolify's /api/v1 gives create_standalone_*() beside the destination (DP-73): $otherData, which the helper
 * fill()s after its own values — an encrypted column in plain text (encrypted here, as the cast does) — and
 * create_standalone_redis()'s redis_password, which replaces the generated REDIS_PASSWORD.
 */
export interface DatabaseFill {
  values: Readonly<Record<string, DatabaseColumnValue>>;
  redisPassword?: string | null;
}

/**
 * Create::createResource() for a database: the destination is
 * find_resource_destination_for_current_team() — one of the org's, on a
 * server whose role can host resources — then create_standalone_<type>(): a
 * new public id, the name "<type>-database-<uuid>", a 64-character password
 * for each of the engine's password columns, and what the query string chose
 * (the image of a PostgreSQL or Redis database; a Supabase image's
 * `supabase_admin` user). The created hook adds the data volumes; Redis gets
 * its REDIS_PASSWORD and REDIS_USERNAME variables. Nothing is started. Null
 * when the project or the environment is not the org's.
 */
export async function createDatabase(ctx: DatabaseContext, input: CreateDatabaseInput, fill: DatabaseFill | null = null): Promise<{ uuid: string; projectUuid: string; environmentUuid: string } | null> {
  const spec = DATABASE_ENGINE_SPECS[input.engine];
  const random = ctx.random ?? DEFAULT_RANDOM;
  const destination = input.destinationUuid ? await ctx.store.findDestination(input.destinationUuid) : null;
  const server = destination ? await ctx.store.findServer(destination.server_uuid) : null;
  if (!destination || !server || effectiveServerRole(server) === "build" || (input.serverUuid !== null && input.serverUuid !== server.uuid)) {
    throw new DatabaseError(DATABASE_SERVICE_MESSAGES.destinationNotFound, 404);
  }
  const project = await ctx.store.findProject(input.projectUuid);
  if (!project) return null;
  const environment = await ctx.store.findEnvironment(project.id, input.environmentUuid);
  if (!environment) return null;

  const uuid = random.publicId();
  const values: Record<string, DatabaseColumnValue> = {};
  // create_standalone_sqlite(): "$database->image = 'peakimages/sqlite:…'" (the column has no default).
  if (spec.image !== null) values.image = spec.image;
  if (spec.imageStep && input.databaseImage !== null) values.image = input.databaseImage;
  // Redis's password is a variable, drawn before the row is saved.
  const generatedRedisPassword = input.engine === "redis" ? random.password() : null;
  for (const column of spec.generatedPasswords) values[column] = await cipherFor(ctx, input.engine, column).encrypt(random.password());
  // $database->fill($otherData)
  const encrypted: readonly string[] = DATABASE_TABLES[input.engine].encrypted;
  for (const [column, value] of Object.entries(fill?.values ?? {})) {
    values[column] = encrypted.includes(column) && typeof value === "string" ? await cipherFor(ctx, input.engine, column).encrypt(value) : value;
  }
  const redisPassword = fill?.redisPassword ?? generatedRedisPassword;
  const image = typeof values.image === "string" ? values.image : input.databaseImage;
  // "if (blank($otherData['postgres_user'] ?? null) && PostgresUser::isSupabaseImage(...))"
  const userGiven = typeof fill?.values.postgres_user === "string" && fill.values.postgres_user.trim() !== "";
  if (input.engine === "postgresql" && !userGiven && isSupabaseImage(image)) values.postgres_user = SUPABASE_ADMIN;

  const volumes = defaultVolumes(input.engine, uuid, image).map((v) => ({ uuid: random.publicId(), name: v.name, mountPath: v.mountPath }));
  // The helper names the database before fill() may name it again.
  const { name: filledName, ...columns } = values;
  const row = await ctx.store.insert(input.engine, {
    uuid,
    name: typeof filledName === "string" ? filledName : `${spec.namePrefix}${uuid}`,
    environmentId: environment.id,
    destinationId: destination.id,
    destinationType: destination.type,
    values: columns,
    volumes,
  });
  if (redisPassword !== null) {
    const cipher = ctx.cipher(VARIABLE_COLUMN);
    for (const [key, value] of [["REDIS_PASSWORD", redisPassword], ["REDIS_USERNAME", "default"]] as const) {
      await ctx.store.insertVariable(input.engine, row.id, { uuid: random.publicId(), key, value: await cipher.encrypt(value), isShared: isSharedReference(value), version: ENVIRONMENT_VARIABLE_VERSION });
    }
  }
  return { uuid: row.uuid, projectUuid: project.uuid, environmentUuid: environment.uuid };
}

/**
 * The models' status accessor: the stored status with its health —
 * "running (healthy)" and "running:healthy" both read "running:healthy", and
 * a status without one reads "<status>:unhealthy".
 */
export function databaseStatus(stored: string | null): string {
  const value = stored ?? "";
  if (value.includes("(")) {
    const after = value.slice(value.indexOf("(") + 1);
    return `${value.slice(0, value.indexOf("(")).trim()}:${(after.includes(")") ? after.slice(0, after.indexOf(")")) : after).trim()}`;
  }
  if (value.includes(":")) return `${value.slice(0, value.indexOf(":")).trim()}:${value.slice(value.indexOf(":") + 1).trim()}`;
  return `${value}:unhealthy`;
}

/** Server::PLACEHOLDER_IPS */
const PLACEHOLDER_IPS = ["1.2.3.4", "0.0.0.0", "::"];

/** The server_status accessor: $this->destination?->server?->isFunctional() ?? false. */
export function serverIsFunctional(row: DeployDatabaseRow): boolean {
  return row.server_uuid !== null && Boolean(row.server_is_reachable) && Boolean(row.server_is_usable) && row.server_force_disabled === false && !PLACEHOLDER_IPS.includes(row.server_ip ?? "");
}

/** Server::isLogDrainEnabled() for the database's server. */
const serverLogDrainEnabled = (row: DeployDatabaseRow): boolean =>
  Boolean(row.server_is_logdrain_newrelic_enabled) || Boolean(row.server_is_logdrain_axiom_enabled) || Boolean(row.server_is_logdrain_custom_enabled) || Boolean(row.server_is_logdrain_cloudwatch_enabled);

/** Nothing of the database can exist on a server: it never left 'exited' and was never started. */
const neverStarted = (row: DeployDatabaseRow): boolean => row.status.startsWith("exited") && row.started_at === null;

export interface InitScript {
  index: number;
  filename: string;
  content: string;
}

/** The init_scripts cast ('array'): the stored JSON list, as a list of scripts. */
export function initScripts(stored: unknown): InitScript[] {
  let list: unknown = stored;
  if (typeof stored === "string") {
    try {
      list = JSON.parse(stored) as unknown;
    } catch {
      list = null;
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .map((item, i) => ({ index: typeof item.index === "number" ? item.index : i, filename: String(item.filename ?? ""), content: String(item.content ?? "") }));
}

const kindOfDestination = (morph: string | null): "standalone" | "swarm" => (morph !== null && morph.endsWith("SwarmDocker") ? "swarm" : "standalone");

export interface DatabaseSsl {
  enabled: boolean;
  /** null where the engine has no mode. */
  mode: string | null;
  modes: readonly SslMode[] | null;
  modeHelper: string | null;
  /** The database certificate's end, when there is one (made at the first start with SSL). */
  certificateValidUntil: string | null;
}

export interface DatabaseShow {
  uuid: string;
  name: string;
  description: string | null;
  engine: DatabaseEngine;
  /** type(): "standalone-postgresql". */
  databaseType: string;
  /** The status accessor: "exited:unhealthy" until the database is started. */
  status: string;
  /** started_at: the credentials become read-only or "initial" once the database has run. */
  startedAt: string | null;
  image: string;
  portsMappings: string | null;
  isPublic: boolean;
  publicPort: number | null;
  publicPortTimeout: number | null;
  isLogDrainEnabled: boolean;
  /** Configuration can embed credentials: null unless the caller may update (syncData's $canSeeCredentials). */
  customDockerRunOptions: string | null;
  /**
   * The engine's own properties. For who may not update: a password is ''
   * and free configuration text null, as syncData() leaves them.
   */
  fields: Record<string, string | null>;
  /** Postgresql\General's $initScripts; null for who may not update, and for every other engine. */
  initScripts: InitScript[] | null;
  /** Redis\General: the image's version, whether the server has users, and the state of the two credential variables. */
  redis: { version: string; hasUsername: boolean; isPasswordLocked: boolean; isUsernameShared: boolean; isPasswordShared: boolean } | null;
  /** $isPasswordHiddenForMember */
  isPasswordHiddenForMember: boolean;
  /** StatusInfo: the connection URLs — null for who may not update and while the password is locked. */
  urlLabel: string;
  dbUrl: string | null;
  dbUrlPublic: string | null;
  isCredentialLocked: boolean;
  showPublicUrlPlaceholder: boolean;
  /** null where the engine has no SSL configuration (ClickHouse). */
  ssl: DatabaseSsl | null;
  /** isBackupSolutionAvailable() */
  backups: boolean;
  /** server_status */
  serverStatus: boolean;
  project: { uuid: string; name: string };
  environment: { uuid: string; name: string };
  destination: { uuid: string; name: string; network: string; type: "standalone" | "swarm" } | null;
  server: { uuid: string; name: string; ip: string; isSwarm: boolean } | null;
}

interface Loaded {
  row: DeployDatabaseRow;
  spec: DatabaseEngineSpec;
  /** The engine's own columns, the encrypted ones decrypted. */
  values: Record<string, string | null>;
  /** Redis's two credential variables (null where there is none, and for every other engine but for KeyDB's and Dragonfly's REDIS_PASSWORD). */
  username: DeployDatabaseVariableRow | null;
  password: DeployDatabaseVariableRow | null;
  usernameValue: string | null;
  passwordValue: string | null;
}

const usesPasswordVariable = (engine: DatabaseEngine): boolean => engine === "redis" || engine === "keydb" || engine === "dragonfly";

async function load(ctx: DatabaseContext, uuid: string): Promise<Loaded | null> {
  const row = await ctx.store.findByUuid(uuid);
  if (!row) return null;
  const spec = DATABASE_ENGINE_SPECS[row.engine];
  const table = DATABASE_TABLES[row.engine];
  const values: Record<string, string | null> = {};
  for (const column of table.columns) {
    if (table.json.includes(column)) continue;
    const stored = row[column];
    const text = stored === null || stored === undefined ? null : String(stored);
    values[column] = text !== null && table.encrypted.includes(column) ? await cipherFor(ctx, row.engine, column).decrypt(text) : text;
  }
  const variable = async (key: string) => {
    const found = await ctx.store.findVariable(row.engine, row.id, key);
    return { found, value: found && found.value !== null ? await ctx.cipher(VARIABLE_COLUMN).decrypt(found.value) : null };
  };
  const username = row.engine === "redis" ? await variable("REDIS_USERNAME") : { found: null, value: null };
  const password = usesPasswordVariable(row.engine) ? await variable("REDIS_PASSWORD") : { found: null, value: null };
  return { row, spec, values, username: username.found, password: password.found, usernameValue: username.value, passwordValue: password.value };
}

/** What a field holds now: its column's value, or its variable's (the username reads 'default' without one). */
function storedField(l: Loaded, field: DatabaseField): string | null {
  if (field.variable === "REDIS_USERNAME") return redisUsername(l.usernameValue);
  if (field.variable === "REDIS_PASSWORD") return l.passwordValue;
  return l.values[field.column!] ?? null;
}

const dateText = (value: string | Date | null): string | null => (value === null ? null : value instanceof Date ? value.toISOString() : String(value));

/** isCredentialLocked(): the password variable is shown once. */
const credentialLocked = (l: Loaded): boolean => usesPasswordVariable(l.row.engine) && l.password?.is_shown_once === true;

function urlInput(l: Loaded): DatabaseUrlInput {
  const { row } = l;
  return {
    engine: row.engine,
    uuid: row.uuid,
    image: row.image,
    isPublic: row.is_public === true,
    publicPort: row.public_port === null ? null : Number(row.public_port),
    enableSsl: row.enable_ssl === true,
    sslMode: row.ssl_mode ?? null,
    serverIp: row.server_ip ?? null,
    values: l.values,
    usernameVariable: l.usernameValue,
    passwordVariable: l.passwordValue,
    legacyPasswordQuoting: row.legacy_password_quoting === true,
  };
}

/** Configuration::mount(), General::syncData() and StatusInfo::refresh(): the database as its General page reads it. */
async function show(ctx: DatabaseContext, l: Loaded, canUpdate: boolean): Promise<DatabaseShow> {
  const { row, spec } = l;
  const locked = credentialLocked(l);
  const fields: Record<string, string | null> = {};
  for (const field of spec.fields) {
    const value = storedField(l, field);
    if (field.variable === "REDIS_PASSWORD") fields[field.property] = canUpdate && !locked ? value : null;
    else if (field.sensitive) fields[field.property] = canUpdate ? value : field.kind === "password" ? "" : null;
    else fields[field.property] = value;
  }
  const hidden = !canUpdate || locked;
  // SQLite's model has no internal_db_url or external_db_url accessor.
  const urls = hidden || !spec.access ? null : urlInput(l);
  const validUntil = spec.supportsSsl ? await ctx.store.certificateValidUntil(row.engine, row.id) : null;
  return {
    uuid: row.uuid,
    name: row.name,
    description: row.description ?? null,
    engine: row.engine,
    databaseType: spec.databaseType,
    status: databaseStatus(row.status),
    startedAt: dateText(row.started_at),
    image: sanitizeString(row.image) ?? "",
    portsMappings: row.ports_mappings ?? null,
    isPublic: row.is_public === true,
    publicPort: row.public_port === null ? null : Number(row.public_port),
    publicPortTimeout: row.public_port_timeout === null ? null : Number(row.public_port_timeout),
    isLogDrainEnabled: row.is_log_drain_enabled === true,
    customDockerRunOptions: canUpdate ? (row.custom_docker_run_options ?? null) : null,
    fields,
    initScripts: row.engine === "postgresql" && canUpdate ? initScripts(row.init_scripts) : null,
    redis:
      row.engine === "redis"
        ? { version: redisVersion(row.image), hasUsername: redisHasUsername(row.image), isPasswordLocked: locked, isUsernameShared: l.username?.is_shared === true, isPasswordShared: l.password?.is_shared === true }
        : null,
    isPasswordHiddenForMember: !canUpdate,
    urlLabel: spec.urlLabel,
    dbUrl: urls ? internalDbUrl(urls) : null,
    dbUrlPublic: urls ? externalDbUrl(urls) : null,
    isCredentialLocked: canUpdate && locked,
    showPublicUrlPlaceholder: spec.showPublicUrlPlaceholder,
    ssl: spec.supportsSsl ? { enabled: row.enable_ssl === true, mode: spec.sslModes ? (row.ssl_mode ?? null) : null, modes: spec.sslModes, modeHelper: spec.sslModeHelper, certificateValidUntil: dateText(validUntil) } : null,
    backups: spec.backups,
    serverStatus: serverIsFunctional(row),
    project: { uuid: row.project_uuid, name: row.project_name },
    environment: { uuid: row.environment_uuid, name: row.environment_name },
    destination: row.destination_uuid === null ? null : { uuid: row.destination_uuid, name: row.destination_name ?? "", network: row.destination_network ?? "", type: kindOfDestination(row.destination_type) },
    server: row.server_uuid === null ? null : { uuid: row.server_uuid, name: row.server_name ?? "", ip: row.server_ip ?? "", isSwarm: Boolean(row.server_is_swarm_manager) || Boolean(row.server_is_swarm_worker) },
  };
}

export async function showDatabase(ctx: DatabaseContext, uuid: string, canUpdate: boolean): Promise<DatabaseShow | null> {
  const l = await load(ctx, uuid);
  return l ? show(ctx, l, canUpdate) : null;
}

async function reload(ctx: DatabaseContext, uuid: string): Promise<DatabaseShow> {
  return (await showDatabase(ctx, uuid, true))!;
}

export interface DatabaseSaved {
  database: DatabaseShow;
  /** The success toast. */
  message: string;
  /** Every toast of the action, in order, when it raises more than one. */
  messages?: string[];
  /** The Access listbox: why the TCP proxy could not take the public port — the database was made private again. */
  proxyDisabled?: string;
}

/** $database->save(): the columns whose value changes. */
async function saveRow(ctx: DatabaseContext, row: DeployDatabaseRow, changes: Record<string, DatabaseColumnValue>): Promise<void> {
  if (Object.keys(changes).length) await ctx.store.update(row.engine, row.id, changes);
}

/**
 * runtime_environment_variables()->updateOrCreate(['key' => $key], ['value' => …]):
 * the variable's value (and is_shared, as the saving hook sets it), or a new
 * variable.
 */
async function saveVariable(ctx: DatabaseContext, l: Loaded, key: "REDIS_USERNAME" | "REDIS_PASSWORD", value: string | null): Promise<void> {
  const existing = key === "REDIS_USERNAME" ? l.username : l.password;
  const current = key === "REDIS_USERNAME" ? l.usernameValue : l.passwordValue;
  const stored = value === null ? null : await ctx.cipher(VARIABLE_COLUMN).encrypt(value);
  const shared = isSharedReference(value);
  if (existing) {
    if (value !== current) await ctx.store.updateVariableValue(l.row.engine, l.row.id, existing.id, stored, shared);
    return;
  }
  await ctx.store.insertVariable(l.row.engine, l.row.id, { uuid: (ctx.random ?? DEFAULT_RANDOM).publicId(), key, value: stored, isShared: shared, version: ENVIRONMENT_VARIABLE_VERSION });
}

/**
 * runtime_environment_variables()->updateOrCreate(['key' => 'REDIS_PASSWORD'], ['value' => …]) as Coolify's /api/v1
 * update calls it (DP-73): the variable is written whatever its lock. False when the database is not the org's.
 */
export async function saveRedisPasswordVariable(ctx: DatabaseContext, uuid: string, value: string): Promise<boolean> {
  const l = await load(ctx, uuid);
  if (!l) return false;
  await saveVariable(ctx, l, "REDIS_PASSWORD", value);
  return true;
}

/** The stored value of every credential, by property: what rules() compares the input with (enforcePattern). */
function storedCredentials(l: Loaded): Record<string, string | null> {
  return Object.fromEntries(l.spec.fields.filter((f) => f.kind !== "text").map((f) => [f.property, storedField(l, f)]));
}

/**
 * General::submit(), for the properties the body gives: the port mappings
 * without their spaces, then validate() — and syncData(true): the name and
 * the description through the model's strip_tags() mutators, '' port
 * mappings as null, the ports as "… ?: null", each credential into its column
 * (encrypted where the model casts it; not at all once the database has
 * started, for the engines whose credentials are then read-only), Redis's
 * username and password into their variables. Only what changes is written.
 * is_public and is_log_drain_enabled have their own actions (the listboxes
 * save at once) and are not written here.
 */
export async function updateGeneral(ctx: DatabaseContext, uuid: string, body: Body): Promise<DatabaseSaved | null> {
  const l = await load(ctx, uuid);
  if (!l) return null;
  const { row, spec } = l;
  const prepared: Body = { ...body };
  // "if ($this->portsMappings) { str(...)->replace(' ', '')->trim() }"
  if (typeof prepared.portsMappings === "string" && prepared.portsMappings !== "" && prepared.portsMappings !== "0") prepared.portsMappings = prepared.portsMappings.replace(/ /g, "").trim();
  // Mongodb\General::submit(): "if (str($this->mongoConf)->isEmpty()) { $this->mongoConf = null; }"
  if (row.engine === "mongodb" && prepared.mongoConf === "") prepared.mongoConf = null;
  // Sqlite\General::submit(): the file names trimmed, the empty ones dropped.
  if (row.engine === "sqlite" && typeof prepared.sqliteDatabases === "string") prepared.sqliteDatabases = normalizeSqliteDatabases(prepared.sqliteDatabases);
  const v = validateDatabaseGeneral(spec, prepared, { stored: storedCredentials(l), credentialLocked: credentialLocked(l) });
  if (!v.ok) throw new DatabaseFieldErrors(v.errors);
  const input = v.input;

  const changes: Record<string, DatabaseColumnValue> = {};
  const set = (column: string, value: DatabaseColumnValue | undefined, current: DatabaseColumnValue): void => {
    if (value !== undefined && value !== current) changes[column] = value;
  };
  // HasSafeStringAttribute: strip_tags() on the name and the description.
  set("name", input.name === undefined ? undefined : stripTags(input.name), row.name);
  set("description", input.description === undefined ? undefined : input.description === null ? null : stripTags(input.description), row.description);
  set("image", input.image, row.image);
  // The portsMappings mutator: '' is null.
  set("ports_mappings", input.portsMappings === "" ? null : input.portsMappings, row.ports_mappings);
  set("public_port", input.publicPort, row.public_port === null ? null : Number(row.public_port));
  set("public_port_timeout", input.publicPortTimeout, row.public_port_timeout === null ? null : Number(row.public_port_timeout));
  set("custom_docker_run_options", input.customDockerRunOptions, row.custom_docker_run_options);
  const started = row.started_at !== null;
  for (const field of spec.fields) {
    const value = input.fields[field.property];
    if (value === undefined || field.column === null) continue;
    // "After the first start the credentials are read-only, so autofilled values must not be saved."
    if (field.frozenOnceStarted && started) continue;
    if (value === (l.values[field.column] ?? null)) continue;
    changes[field.column] = value !== null && DATABASE_TABLES[row.engine].encrypted.includes(field.column) ? await cipherFor(ctx, row.engine, field.column).encrypt(value) : value;
  }
  await saveRow(ctx, row, changes);

  if (row.engine === "redis") {
    // version_compare($this->redisVersion, '6.0', '>='): the version the form was loaded with.
    if (input.fields.redisUsername !== undefined && redisHasUsername(row.image)) await saveVariable(ctx, l, "REDIS_USERNAME", input.fields.redisUsername);
    // "The form never loads a locked password, so saving its empty value would overwrite it."
    if (input.fields.redisPassword !== undefined && !credentialLocked(l)) await saveVariable(ctx, l, "REDIS_PASSWORD", input.fields.redisPassword);
  }
  return { database: await reload(ctx, uuid), message: DATABASE_SERVICE_MESSAGES.updated };
}

/**
 * General::instantSave(): the "Access" listbox. Making a database public
 * needs a public port and a running database (Coolify's two refusals, in its
 * order) and then starts the TCP proxy container on the server; making it
 * private removes that container.
 *
 * With the server in reach (ctx.server gives an executor) this is Coolify's
 * order: the switch and the ports are stored, then the proxy is started or
 * removed. When that fails Coolify puts is_public back and keeps the ports;
 * here the request fails as a whole and stores nothing. A proxy whose port is
 * taken is not a failure: StartDatabaseProxy makes the database private again
 * itself, and the answer says so beside Coolify's success toast.
 *
 * Without an executor nothing can be started or removed, so nothing is stored
 * and the answer is 501 — except for a database that was never started:
 * nothing of it is on a server, and "Private" is stored with the ports the
 * form holds. (Coolify removes the proxy container of such a database too;
 * here there is none to remove, with or without an executor.)
 */
export async function instantSavePublic(ctx: DatabaseContext, uuid: string, body: Body): Promise<DatabaseSaved | null> {
  const l = await load(ctx, uuid);
  if (!l) return null;
  const { row, spec } = l;
  if (!spec.access) throw new DatabaseError(DATABASE_SERVICE_MESSAGES.accessUnsupported);
  const v = validateDatabaseGeneral(spec, { isPublic: body.isPublic ?? null, ...(body.publicPort !== undefined ? { publicPort: body.publicPort } : {}), ...(body.publicPortTimeout !== undefined ? { publicPortTimeout: body.publicPortTimeout } : {}) }, { stored: {} });
  if (!v.ok) throw new DatabaseFieldErrors(v.errors);
  const isPublic = v.input.isPublic === true;
  const publicPort = v.input.publicPort !== undefined ? v.input.publicPort : row.public_port === null ? null : Number(row.public_port);
  if (isPublic && !publicPort) throw new DatabaseError(DATABASE_SERVICE_MESSAGES.publicPortRequired);
  if (isPublic && !row.status.startsWith("running")) throw new DatabaseError(DATABASE_SERVICE_MESSAGES.mustBeStarted);
  const access = ctx.server ? await ctx.server(uuid) : null;
  const executor = access?.executor ?? null;
  // StartDatabaseProxy::run()
  if (isPublic && executor === null) throw new DatabaseError(DATABASE_SERVICE_MESSAGES.proxyStartUnavailable, 501);
  // StopDatabaseProxy::run(): "docker rm -f <uuid>-proxy" on the server.
  const proxyMayExist = !neverStarted(row) || row.is_public === true;
  if (!isPublic && proxyMayExist && executor === null) throw new DatabaseError(DATABASE_SERVICE_MESSAGES.proxyStopUnavailable, 501);
  const changes: Record<string, DatabaseColumnValue> = {};
  // syncData(true): with the server in reach the switch is stored before the proxy is started or removed.
  if (executor !== null && isPublic !== (row.is_public === true)) changes.is_public = isPublic;
  if (publicPort !== (row.public_port === null ? null : Number(row.public_port))) changes.public_port = publicPort;
  if (v.input.publicPortTimeout !== undefined && v.input.publicPortTimeout !== (row.public_port_timeout === null ? null : Number(row.public_port_timeout))) changes.public_port_timeout = v.input.publicPortTimeout;
  await saveRow(ctx, row, changes);
  let proxyDisabled: string | null = null;
  if (access && executor !== null && (isPublic || proxyMayExist)) {
    try {
      if (isPublic) proxyDisabled = (await startDatabaseProxy(access)).disabled;
      else await stopDatabaseProxy(access);
    } catch (e) {
      // Coolify puts is_public back and shows the error; here the failed request stores nothing at all.
      if (e instanceof RemoteCommandError) throw new DatabaseError(e.message);
      throw e;
    }
  }
  return {
    database: await reload(ctx, uuid),
    message: isPublic ? DATABASE_SERVICE_MESSAGES.nowPublic : DATABASE_SERVICE_MESSAGES.noLongerPublic,
    // The port was taken: Coolify makes the database private again and notifies the team.
    ...(proxyDisabled !== null ? { proxyDisabled } : {}),
  };
}

/**
 * General::instantSaveAdvanced(): the "Log drain" listbox. Without a log
 * drain on the server nothing is saved and the answer is Coolify's error;
 * with one, the switch is stored and both of Coolify's toasts are answered.
 */
export async function instantSaveAdvanced(ctx: DatabaseContext, uuid: string, body: Body): Promise<DatabaseSaved | null> {
  const l = await load(ctx, uuid);
  if (!l) return null;
  if (!serverLogDrainEnabled(l.row)) throw new DatabaseError(DATABASE_SERVICE_MESSAGES.logDrainNotEnabled);
  const v = validateDatabaseGeneral(l.spec, { isLogDrainEnabled: body.isLogDrainEnabled ?? null }, { stored: {} });
  if (!v.ok) throw new DatabaseFieldErrors(v.errors);
  const enabled = v.input.isLogDrainEnabled === true;
  await saveRow(ctx, l.row, enabled !== (l.row.is_log_drain_enabled === true) ? { is_log_drain_enabled: enabled } : {});
  const messages = [DATABASE_SERVICE_MESSAGES.updated, DATABASE_SERVICE_MESSAGES.restartNeeded];
  return { database: await reload(ctx, uuid), message: messages[0]!, messages };
}

/**
 * HasDatabaseStatusInfo::instantSaveSSL(): enable_ssl and — where the engine
 * has modes — ssl_mode, stored as given; the certificate itself is made when
 * the database starts. Coolify does not validate the mode (the column's
 * check constraint refuses an unknown one); here it must be one of the
 * engine's.
 */
export async function instantSaveSsl(ctx: DatabaseContext, uuid: string, body: Body): Promise<DatabaseSaved | null> {
  const l = await load(ctx, uuid);
  if (!l) return null;
  const { row, spec } = l;
  if (!spec.supportsSsl) throw new DatabaseError(DATABASE_SERVICE_MESSAGES.sslUnsupported);
  const errors: FieldErrors = {};
  const changes: Record<string, DatabaseColumnValue> = {};
  if (body.enableSsl !== undefined) {
    const enabled = coerceBoolean(body.enableSsl, false);
    if (enabled === undefined || enabled === null) errors.enableSsl = ["The enable ssl field must be true or false."];
    else if (enabled !== (row.enable_ssl === true)) changes.enable_ssl = enabled;
  }
  if (spec.sslModes && body.sslMode !== undefined) {
    if (typeof body.sslMode !== "string" || !spec.sslModes.some((m) => m.value === body.sslMode)) errors.sslMode = ["The selected ssl mode is invalid."];
    else if (body.sslMode !== row.ssl_mode) changes.ssl_mode = body.sslMode;
  }
  if (Object.keys(errors).length) throw new DatabaseFieldErrors(errors);
  await saveRow(ctx, row, changes);
  return { database: await reload(ctx, uuid), message: DATABASE_SERVICE_MESSAGES.sslUpdated };
}

export interface CertificateRegenerated extends DatabaseSaved {
  /** Freeploy's: what could not be done on the server, when there is no executor to do it with. */
  unavailable?: string;
  /** What Coolify queues beside this and nothing does yet. */
  deferred?: string[];
}

/**
 * HasDatabaseStatusInfo::regenerateSslCertificate(): a new key and certificate for a database that has one —
 * which is one that has started with SSL — signed by the server's CA, with the names and paths of the old; the
 * certificate's rows and its file mounts are replaced. Coolify then queues the write of the new files to the
 * server; here they are written at once when the server can be reached, and otherwise with the next start.
 */
export async function regenerateSslCertificate(ctx: DatabaseContext, uuid: string): Promise<CertificateRegenerated | null> {
  const l = await load(ctx, uuid);
  if (!l) return null;
  if (!l.spec.supportsSsl) throw new DatabaseError(DATABASE_SERVICE_MESSAGES.sslUnsupported);
  if ((await ctx.store.certificateValidUntil(l.row.engine, l.row.id)) === null) throw new DatabaseError(DATABASE_SERVICE_MESSAGES.noCertificate);
  const access = ctx.server ? await ctx.server(uuid) : null;
  if (!access) throw new DatabaseError(DATABASE_SERVICE_MESSAGES.certificateUnavailable, 501);
  const done = await regenerateCertificate(access);
  if (done.outcome === "no-certificate") throw new DatabaseError(DATABASE_SERVICE_MESSAGES.noCertificate);
  if (done.outcome === "no-ca") throw new DatabaseError(DATABASE_SERVICE_MESSAGES.noCaCertificate);
  return {
    database: await reload(ctx, uuid),
    message: OPERATION_MESSAGES.certificateRegenerated,
    ...(done.filesWritten ? {} : { unavailable: DATABASE_SERVICE_MESSAGES.certificateFilesUnavailable }),
    ...(done.deferred.length ? { deferred: done.deferred } : {}),
  };
}

async function loadPostgresql(ctx: DatabaseContext, uuid: string): Promise<Loaded | null> {
  const l = await load(ctx, uuid);
  if (l && l.row.engine !== "postgresql") throw new DatabaseError(DATABASE_SERVICE_MESSAGES.notPostgresql, 404);
  return l;
}

const reindex = (scripts: InitScript[]): InitScript[] => scripts.map((s, index) => ({ ...s, index }));

function assertFilename(filename: string): void {
  try {
    validateFilenameSafe(filename, "init script filename");
  } catch (e) {
    if (e instanceof FilenameError) throw new DatabaseError(e.message);
    throw e;
  }
}

/** Postgresql\General::save_new_init_script(): a new script at the end of the list. The file is written when the database starts. */
export async function addInitScript(ctx: DatabaseContext, uuid: string, body: Body): Promise<DatabaseSaved | null> {
  const l = await loadPostgresql(ctx, uuid);
  if (!l) return null;
  const v = validateNewInitScript(body);
  if (!v.ok) throw new DatabaseFieldErrors(v.errors);
  assertFilename(v.input.filename);
  const scripts = initScripts(l.row.init_scripts);
  if (scripts.some((s) => s.filename === v.input.filename)) throw new DatabaseError(DATABASE_SERVICE_MESSAGES.filenameExists);
  scripts.push({ index: scripts.length, filename: v.input.filename, content: v.input.content });
  await ctx.store.update("postgresql", l.row.id, { init_scripts: JSON.stringify(scripts) });
  return { database: await reload(ctx, uuid), message: DATABASE_SERVICE_MESSAGES.scriptAdded };
}

/**
 * InitScript::submit() → Postgresql\General::save_init_script(): a script's
 * filename and content. A new filename must be free and safe; renaming an
 * existing script first removes its old file on the server, so it answers 501
 * and stores nothing. A script that is not in the list is added.
 */
export async function saveInitScript(ctx: DatabaseContext, uuid: string, body: Body): Promise<DatabaseSaved | null> {
  const l = await loadPostgresql(ctx, uuid);
  if (!l) return null;
  const errors: FieldErrors = {};
  // #[Validate(['nullable', 'string'])] on both properties.
  for (const field of ["filename", "content"] as const) if (body[field] !== null && body[field] !== undefined && typeof body[field] !== "string") errors[field] = [`The ${field} field must be a string.`];
  if (typeof body.originalFilename !== "string") errors.originalFilename = ["The original filename field is required."];
  if (Object.keys(errors).length) throw new DatabaseFieldErrors(errors);
  const filename = typeof body.filename === "string" ? body.filename : "";
  const content = typeof body.content === "string" ? body.content : "";
  const originalFilename = body.originalFilename as string;
  const scripts = initScripts(l.row.init_scripts);
  const existing = scripts.find((s) => s.filename === filename);
  const old = scripts.find((s) => s.filename === originalFilename);
  if (existing && filename !== originalFilename) throw new DatabaseError(DATABASE_SERVICE_MESSAGES.scriptExists);
  // "Only an unchanged filename of an existing script skips validation, so legacy rows stay editable."
  if (!old || old.filename !== filename) assertFilename(filename);
  if (old && old.filename !== filename) throw new DatabaseError(DATABASE_SERVICE_MESSAGES.scriptRenameUnavailable, 501);
  const at = scripts.findIndex((s) => s.filename === originalFilename);
  if (at !== -1) scripts[at] = { index: scripts[at]!.index, filename, content };
  else scripts.push({ index: scripts.length, filename, content });
  await ctx.store.update("postgresql", l.row.id, { init_scripts: JSON.stringify(reindex(scripts)) });
  return { database: await reload(ctx, uuid), message: DATABASE_SERVICE_MESSAGES.scriptSaved };
}

/**
 * Postgresql\General::delete_init_script(): the script's file is removed on
 * the server before the row changes, so this answers 501 and keeps the
 * script. Null when the database or the script is not there.
 */
export async function deleteInitScript(ctx: DatabaseContext, uuid: string, filename: string): Promise<null> {
  const l = await loadPostgresql(ctx, uuid);
  if (!l || !initScripts(l.row.init_scripts).some((s) => s.filename === filename)) return null;
  throw new DatabaseError(DATABASE_SERVICE_MESSAGES.scriptDeleteUnavailable, 501);
}

/**
 * Clickhouse\General::keepCurrentDataVolume(): which unnamed volume holds the
 * data is read from the container on the server (anonymousDataVolume()).
 */
export async function keepCurrentDataVolume(ctx: DatabaseContext, uuid: string): Promise<null> {
  const l = await load(ctx, uuid);
  if (!l || l.row.engine !== "clickhouse") return null;
  throw new DatabaseError(DATABASE_SERVICE_MESSAGES.dataVolumeUnavailable, 501);
}

export type DatabaseAction = "start" | "restart" | "stop";

/**
 * Heading::start(), restart() and stop(): StartDatabase, RestartDatabase and
 * StopDatabase run on the server, so each answers 501 until the SSH executor
 * exists. Null when the database is not the org's.
 */
export async function unavailableAction(ctx: DatabaseContext, uuid: string, action: DatabaseAction): Promise<null> {
  if (!(await ctx.store.findByUuid(uuid))) return null;
  throw new DatabaseError({ start: DATABASE_SERVICE_MESSAGES.startUnavailable, restart: DATABASE_SERVICE_MESSAGES.restartUnavailable, stop: DATABASE_SERVICE_MESSAGES.stopUnavailable }[action], 501);
}

export interface DatabaseDeleted {
  deleted: true;
  /** Where the page goes next: the environment's resources. */
  projectUuid: string;
  environmentUuid: string;
  /** The options as they were read. */
  options: DeleteOptions;
}

/**
 * Danger::delete() for a database. Coolify soft-deletes the row and queues
 * DeleteResourceJob, which stops the database, removes its configuration
 * directory and its volumes on the server, and then deletes the rows. A
 * database that was never started has nothing on any server: its rows are
 * removed at once, with everything deleteLocalResource() and the model's
 * hooks remove. Any other database answers 501 — removing only its rows
 * would leave its container running with nothing managing it. Null when the
 * database is not the org's.
 */
export async function deleteDatabaseNow(ctx: DatabaseContext, uuid: string, options: DeleteOptions): Promise<DatabaseDeleted | null> {
  const row = await ctx.store.findByUuid(uuid);
  if (!row) return null;
  // "if ($this->resource instanceof StandaloneSqlite && $this->resource->hasConnectedApplications())": nothing is deleted.
  const mounts = row.engine === "sqlite" && ctx.store.sqliteMounts ? await ctx.store.sqliteMounts(row.id, row.server_id) : null;
  if (mounts !== null) throw new DatabaseError(DATABASE_SERVICE_MESSAGES.sqliteMounted(mounts));
  if (!neverStarted(row)) throw new DatabaseError(DATABASE_SERVICE_MESSAGES.deleteUnavailable, 501);
  await ctx.store.delete(row.engine, row.id);
  return { deleted: true, projectUuid: row.project_uuid, environmentUuid: row.environment_uuid, options };
}

/** Index::toSearchableArray() for a database, with its type() for <x-resource-logo>. */
export interface DatabaseResource {
  uuid: string;
  name: string;
  type: "database";
  typeLabel: "Database";
  fqdn: null;
  description: string | null;
  status: string;
  /** Databases have no restart limit (stoppedAfterRestartLimit() is the application's). */
  restartLimitReached: false;
  restartCount: number;
  maxRestartCount: number;
  server_status: boolean;
  /** Applications only. */
  buildPack: "";
  /** type(): which logo <x-resource-logo> shows. */
  databaseType: string;
  destination: { server: { name: string } };
  /** Tags are not ported for databases yet. */
  tags: never[];
}

export function databaseResource(row: DeployDatabaseRow): DatabaseResource {
  return {
    uuid: row.uuid,
    name: row.name,
    type: "database",
    typeLabel: "Database",
    fqdn: null,
    description: row.description ?? null,
    status: databaseStatus(row.status),
    restartLimitReached: false,
    restartCount: 0,
    maxRestartCount: 0,
    server_status: serverIsFunctional(row),
    buildPack: "",
    databaseType: DATABASE_ENGINE_SPECS[row.engine].databaseType,
    destination: { server: { name: row.server_name ?? "Unknown" } },
    tags: [],
  };
}

/** $environment->{postgresqls, redis, …}()->get()->sortBy('name'), one engine after the other, as Index::mount() loads them. */
export function databaseResources(rows: readonly DeployDatabaseRow[]): DatabaseResource[] {
  const order = (row: DeployDatabaseRow) => Object.keys(DATABASE_ENGINE_SPECS).indexOf(row.engine);
  return [...rows]
    .sort((a, b) => order(a) - order(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(databaseResource);
}
