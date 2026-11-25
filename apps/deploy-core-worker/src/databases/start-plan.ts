// Derived from coollabsio/coolify@91b7e3e:app/Actions/Database/Start{Postgresql,Redis,Mongodb,Mysql,Mariadb,Keydb,
// Dragonfly,Clickhouse}.php (handle and their private methods), app/Traits/{ExecutesDatabaseStartCommands,
// HasDatabaseHealthCheck,HasSecretManager}.php (pullImageCommands, hasEnvironmentVariable,
// addCoolifyEnvironmentVariables; healthCheckConfiguration, healthCheckPortArguments; the value formatting of a
// variable), app/Support/PostgresUser.php, app/Models/Standalone*.php (ports_mappings_array, redis_username,
// redis_password, serverPasswordEnvironmentVariable) and bootstrap/helpers/{docker,shared}.php
// (defaultDatabaseLabels, generateCustomDockerRunOptionsForDatabases, coolifyDefaultEnvironmentVariables,
// database_configuration_dir, generate_readme_file) (Apache-2.0), modified.
//
// What starting a standalone database sends to its server, for the eight engines: the docker-compose file and
// the ordered command list of one start. A pure function of plain row data — nothing here reads a row or talks
// to a server; start-engine.ts does both. Byte-equal to Coolify's PHP for every run of
// tests/deploy-core-worker/fixtures/database-start.
//
// What Coolify does here and Freeploy does not: the pull of a scanned image build ("Pull latest" security
// updates, ImageStartPin — Freeploy has no image scans), a non-root server user (the DOCKER_CONFIG prefix and
// sudo), and remote secrets ({{vault.KEY}}): there is no secret manager, so such a reference stops the start
// with Coolify's message unless the variable is literal (then the text stays as it is).
import type { DatabaseEngine } from "@saas/db/deploy";
import { arrayMergeRecursive, logDrainConfiguration, serverDrainsLogs, RESTART_MODE, type ComposeLogDrain } from "../deployments/compose.js";
import { convertDockerRunToCompose } from "../deployments/docker-run-options.js";
import { generateReadmeFile } from "../deployments/engine.js";
import { base64Encode, escapeshellarg, floatval, jsonValidate, phpLtrim, phpTrim } from "../deployments/php.js";
import { containsVaultReference, escapeEnvVariables } from "../deployments/runtime-env.js";
import { PhpFloat, yamlDump, type YamlValue } from "../deployments/yaml.js";
import { isSharedReference } from "../environment-variables/references.js";
import { dockerStopCommand } from "../helpers/docker.js";
import { escapeDollarSign, slug } from "../labels/labels.js";
import { caCertificateFileCommands } from "../ssl/ssl-helper.js";
import { isSupabaseImage } from "./engines.js";

/** database_configuration_dir(): where a database's files live on its server. */
export const DATABASE_CONFIGURATION_DIR = "/data/coolify/databases";
/** $database->workdir() */
export const databaseWorkdir = (uuid: string): string => `${DATABASE_CONFIGURATION_DIR}/${uuid}`;

/** type(): the `coolify.database.subType` label, and what StartDatabaseProxy tells the engines apart by. */
export const DATABASE_TYPE: Readonly<Record<DatabaseEngine, string>> = {
  postgresql: "standalone-postgresql",
  redis: "standalone-redis",
  mongodb: "standalone-mongodb",
  mysql: "standalone-mysql",
  mariadb: "standalone-mariadb",
  keydb: "standalone-keydb",
  dragonfly: "standalone-dragonfly",
  clickhouse: "standalone-clickhouse",
};

/** Where an engine's certificate files are mounted in its container; null for an engine without SSL. */
export const SSL_MOUNT_PATH: Readonly<Record<DatabaseEngine, string | null>> = {
  postgresql: "/var/lib/postgresql/certs",
  redis: "/etc/redis/certs",
  mongodb: "/etc/mongo/certs",
  mysql: "/etc/mysql/certs",
  mariadb: "/etc/mysql/certs",
  keydb: "/etc/keydb/certs",
  dragonfly: "/etc/dragonfly/certs",
  clickhouse: null,
};

/** MongoDB reads its certificate and key from one file (isPemKeyFileRequired). */
export const sslPemKeyFileRequired = (engine: DatabaseEngine): boolean => engine === "mongodb";

/** The mount paths of an engine's certificate files: what a start without SSL removes from the file mounts. */
export function sslFileMountPaths(engine: DatabaseEngine): string[] {
  const mount = SSL_MOUNT_PATH[engine];
  if (mount === null) return [];
  return sslPemKeyFileRequired(engine) ? [`${mount}/server.pem`] : [`${mount}/server.crt`, `${mount}/server.key`];
}

/** A variable of the database as a start reads it. */
export interface StartVariable {
  key: string;
  /** The stored value, decrypted, without its edge line breaks; null when nothing is stored. */
  value: string | null;
  /** The value with its shared variable references filled in — locked ones too. */
  realValue: string | null;
  is_literal: boolean;
  is_multiline: boolean;
  /** environment_variables.uses_legacy_escaping: the escaping of a variable saved before exact escaping. False for every row Freeploy writes. */
  uses_legacy_escaping?: boolean;
}

export interface StartPersistentStorage {
  name: string;
  mount_path: string;
  host_path: string | null;
}

export interface StartFileStorage {
  fs_path: string;
  mount_path: string | null;
}

/** The database's row, with its `encrypted` columns decrypted. */
export interface StartDatabase {
  uuid: string;
  name: string;
  image: string;
  ports_mappings: string | null;
  limits_memory: string;
  limits_memory_swap: string;
  limits_memory_swappiness: number;
  limits_memory_reservation: string;
  limits_cpus: string;
  limits_cpuset: string | null;
  limits_cpu_shares: number;
  custom_docker_run_options: string | null;
  enable_ssl: boolean;
  ssl_mode: string | null;
  legacy_password_quoting: boolean;
  is_log_drain_enabled: boolean;
  /** null means on (a model without the column default loaded). */
  include_coolify_default_variables: boolean | null;
  /** The health check columns of Coolify's models; null is each one's default (on, 15 s, 5 s, 5, 5 s). */
  health_check_enabled?: boolean | null;
  health_check_interval?: number | null;
  health_check_timeout?: number | null;
  health_check_retries?: number | null;
  health_check_start_period?: number | null;
  /** The engine's own columns by name: postgres_user, redis_conf, mysql_root_password, … */
  values: Readonly<Record<string, string | null>>;
  /** PostgreSQL's init scripts. */
  init_scripts?: Array<{ filename?: unknown; content?: unknown }> | null;
}

export interface StartPlanInput {
  engine: DatabaseEngine;
  database: StartDatabase;
  projectName: string;
  environmentName: string;
  /** $database->destination->network */
  network: string;
  server: { ip: string | null; dockerVersion: string | null; logDrain: ComposeLogDrain };
  persistentStorages: StartPersistentStorage[];
  /** Every file mount of the database, the certificate files included. */
  fileStorages: StartFileStorage[];
  /** runtime_environment_variables, oldest first. */
  variables: StartVariable[];
  /** With SSL: the server's CA certificate (PEM), and whether the database's certificate was made for this start. */
  ssl: { caCertificate: string; generated: boolean } | null;
  /** EnsureContentFilesOnServer::echoCommands(): what the check of the content files has to say. */
  contentFileCommands: string[];
  /** now() */
  now: Date;
}

export interface StartPlan {
  /** The commands of the start, in order: one batch on the server's shell. */
  commands: string[];
  /** The docker-compose file, as written to `composeFile`. */
  compose: string;
  composeFile: string;
  configurationDir: string;
  /** What building the plan changes in the rows, as Coolify's actions do while they build theirs. */
  changes: {
    /** PostgreSQL: the configuration with `listen_addresses = '*'` appended. */
    postgresConf?: string;
    /** Redis: the REDIS_USERNAME variable's value (a blank one becomes "default"). */
    redisUsername?: string;
  };
}

/** RemoteSecretException: a variable needs a secret manager, and there is none. */
export class RemoteSecretError extends Error {}
export const NO_SECRET_MANAGER = "Environment variables reference remote secrets, but no secret manager source is configured.";

// ── PHP ────────────────────────────────────────────────────────────────────────────────────────────────

/** empty() of a string: null, "" and "0". */
const empty = (value: string | null | undefined): boolean => value === null || value === undefined || value === "" || value === "0";
/** blank() of a string: null or only whitespace. */
const blank = (value: string | null | undefined): boolean => value === null || value === undefined || phpTrim(value) === "";

/** basename(): the last component, without trailing slashes. */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** json_encode($value, JSON_UNESCAPED_SLASHES) of a string: every non-ASCII character escaped. */
function jsonUnescapedSlashes(value: string): string {
  let out = "";
  for (const unit of JSON.stringify(value)) {
    for (let i = 0; i < unit.length; i++) {
      const code = unit.charCodeAt(i);
      out += code < 0x7f ? unit.charAt(i) : "\\u" + code.toString(16).padStart(4, "0");
    }
  }
  return out;
}

const dateTimeString = (date: Date): string => date.toISOString().slice(0, 19).replace("T", " ");

// ── A variable's value ─────────────────────────────────────────────────────────────────────────────────

type Engine = DatabaseEngine;

/** HasSecretManager::useExactEscaping() for a database: every variable but one saved before exact escaping. */
function useExactEscaping(variable: StartVariable): boolean {
  if (!variable.uses_legacy_escaping) return true;
  // hasSingleLineEdgeWhitespace(): such a value is a new save.
  const value = variable.value;
  return value !== null && !value.includes("\n") && value !== phpTrim(value);
}

/** environmentVariableUsesSecretManager(): a {{vault.KEY}} reference that would be fetched — any but a literal's. */
const usesSecretManager = (variable: StartVariable): boolean => containsVaultReference(variable.realValue) && !variable.is_literal;

/** resolveSecretManagerEnvironmentVariableValue(): the value with its shared variables filled in. */
function rawValueOf(variable: StartVariable): string | null {
  if (variable.realValue !== null && usesSecretManager(variable)) throw new RemoteSecretError(NO_SECRET_MANAGER);
  return variable.realValue;
}

/** ensureRemoteSecretsResolvable(): throws RemoteSecretError when a variable needs a secret manager. */
export function assertVariablesResolvable(variables: StartVariable[]): void {
  for (const variable of variables) rawValueOf(variable);
}

/** environmentVariableAllowsInterpolation(): only plain values allow Compose $VAR interpolation. */
function allowsInterpolation(variable: StartVariable, value: string): boolean {
  const first = phpLtrim(value).charAt(0);
  const isJson = jsonValidate(value) && (first === "{" || first === "[");
  return !isJson && !variable.is_literal && !variable.is_multiline;
}

const isJsonDocument = (value: string): boolean => jsonValidate(value) && (value.startsWith("{") || value.startsWith("["));

/** formatEnvironmentVariableValue(): the value of an `environment:` entry. */
function formatEnvironmentValue(variable: StartVariable, value: string | null): string {
  if (value === null) return "";
  if (!useExactEscaping(variable)) {
    // legacyFormatEnvironmentVariableValue()
    if (isJsonDocument(value)) return value;
    return variable.is_literal || variable.is_multiline ? `'${value}'` : escapeEnvVariables(value);
  }
  return allowsInterpolation(variable, value) ? value : escapeDollarSign(value);
}

/** formatComposeFileValue(): a value placed directly in the compose file (a command, a health check). */
function formatComposeFileValue(engine: Engine, variable: StartVariable, value: string): string {
  if (variable.key === "REDIS_PASSWORD" && useExactEscaping(variable) && (engine === "redis" || engine === "keydb" || engine === "dragonfly")) return escapeDollarSign(value);
  // composeCommandValue()
  if (!useExactEscaping(variable) || allowsInterpolation(variable, value)) return value;
  return escapeDollarSign(value);
}

/** hasEnvironmentVariable(): the list already defines exactly this key. */
const hasVariable = (environment: string[], key: string): boolean => environment.some((entry) => entry.split("=")[0] === key);

/** addCoolifyEnvironmentVariables(): the variables that tell a container where it runs; a key the user defines wins. */
function addCoolifyVariables(input: StartPlanInput, environment: string[]): void {
  const defined = new Set(environment.map((entry) => entry.split("=")[0]!));
  const variables: Array<[string, string | null]> = [
    ["COOLIFY_RESOURCE_UUID", input.database.uuid],
    ["COOLIFY_CONTAINER_NAME", input.database.uuid],
  ];
  // coolifyDefaultEnvironmentVariables()
  if (input.database.include_coolify_default_variables !== false) {
    variables.push(["COOLIFY_APP_NAME", input.database.name], ["COOLIFY_PROJECT_NAME", input.projectName], ["COOLIFY_ENVIRONMENT_NAME", input.environmentName], ["COOLIFY_SERVER_IP", input.server.ip]);
  }
  for (const [key, value] of variables) {
    if (value !== null && !defined.has(key)) environment.push(`${key}=${escapeDollarSign(value)}`);
  }
}

// ── Pieces every engine shares ─────────────────────────────────────────────────────────────────────────

/** healthCheckPortArguments(): the last `port` setting of a configuration file, as a client option. */
export function healthCheckPortArguments(configuration: string | null, option = "-p"): string[] {
  const ports = [...(configuration ?? "").matchAll(/^[ \t\n\v\f\r]*port[ \t\n\v\f\r]*[=: \t\n\v\f\r][ \t\n\v\f\r]*["']?(\d+)/gim)];
  return ports.length === 0 ? [] : [option, ports[ports.length - 1]![1]!];
}

/** healthCheckConfiguration() */
function healthCheck(database: StartDatabase, test: string[]): Map<string, YamlValue> {
  return new Map<string, YamlValue>([
    ["test", test],
    ["interval", `${database.health_check_interval ?? 15}s`],
    ["timeout", `${database.health_check_timeout ?? 5}s`],
    ["retries", database.health_check_retries ?? 5],
    ["start_period", `${database.health_check_start_period ?? 5}s`],
  ]);
}

/** defaultDatabaseLabels() */
export function defaultDatabaseLabels(input: Pick<StartPlanInput, "engine" | "projectName" | "environmentName"> & { database: Pick<StartDatabase, "uuid" | "name"> }): string[] {
  return [
    "coolify.managed=true",
    "coolify.type=database",
    "coolify.databaseUuid=" + input.database.uuid,
    "coolify.resourceName=" + slug(input.database.name),
    "coolify.serviceName=" + slug(input.database.name),
    "coolify.projectName=" + slug(input.projectName),
    "coolify.environmentName=" + slug(input.environmentName),
    "coolify.database.subType=" + DATABASE_TYPE[input.engine],
  ];
}

const bind = (source: string, target: string): Map<string, YamlValue> => new Map<string, YamlValue>([["type", "bind"], ["source", source], ["target", target], ["read_only", true]]);

/**
 * requirePassArgument(): the password argument of a Redis-like start command. Docker Compose splits the
 * command like a shell, so the password is quoted — but a database from before that keeps its unquoted
 * argument when quoting would change it.
 */
function requirePassArgument(database: StartDatabase, password: string): string {
  const keepsUnquoted = database.legacy_password_quoting && /[\\'";&|<> \t\r\n]/.test(password);
  return keepsUnquoted ? password : escapeshellarg(password);
}

/** What an engine's own part of the plan gives the shared part. */
interface EnginePart {
  environment: string[];
  /** The service's `command`, where the engine sets one from the start (Redis, KeyDB, Dragonfly, MongoDB). */
  command?: YamlValue;
  healthTest: string[];
  /** Service keys between `networks` and `labels` (ClickHouse's ulimits). */
  beforeLabels?: Array<[string, YamlValue]>;
  /** Called after the volumes are in place: the engine's own mounts and its final command. */
  finish(service: Map<string, YamlValue>, addVolumes: (volumes: YamlValue[]) => void): void;
  /** Called after the custom Docker options are merged (the commands MySQL, MariaDB, MongoDB and PostgreSQL set last). */
  afterOptions?(service: Map<string, YamlValue>): void;
  /** Commands between the image pull and the stop of the old container. */
  afterPull: string[];
}

interface Building {
  input: StartPlanInput;
  commands: string[];
  dir: string;
  changes: StartPlan["changes"];
}

/** The runtime variables as `KEY=value` entries, with what each engine reads out of them on the way. */
function environmentOf(b: Building, onVariable?: (variable: StartVariable, raw: string, resolved: string) => void): string[] {
  const environment: string[] = [];
  for (const variable of b.input.variables) {
    const raw = rawValueOf(variable) ?? "";
    const resolved = formatEnvironmentValue(variable, raw);
    environment.push(`${variable.key}=${resolved}`);
    onVariable?.(variable, raw, resolved);
  }
  return environment;
}

const value = (b: Building, column: string): string => b.input.database.values[column] ?? "";
const tee = (content: string, path: string): string => `echo '${base64Encode(content)}' | base64 -d | tee ${path} > /dev/null`;

// ── The engines ────────────────────────────────────────────────────────────────────────────────────────

function postgresql(b: Building): EnginePart {
  const { database } = b.input;
  let user = value(b, "postgres_user");
  let db = value(b, "postgres_db");
  let password = value(b, "postgres_password");
  const environment = environmentOf(b, (variable, raw, resolved) => {
    // Credentials below are placed directly in the compose file (healthcheck, command).
    if (variable.key === "POSTGRES_USER") user = formatComposeFileValue("postgresql", variable, raw);
    else if (variable.key === "POSTGRES_DB") db = formatComposeFileValue("postgresql", variable, raw);
    else if (variable.key === "POSTGRES_PASSWORD") password = resolved;
  });
  if (!hasVariable(environment, "POSTGRES_USER")) environment.push(`POSTGRES_USER=${value(b, "postgres_user")}`);
  if (!hasVariable(environment, "PGUSER")) environment.push(`PGUSER=${value(b, "postgres_user")}`);
  if (!hasVariable(environment, "POSTGRES_PASSWORD")) environment.push(`POSTGRES_PASSWORD=${value(b, "postgres_password")}`);
  // psql in the healthcheck, backups, and restores reads PGPASSWORD when pg_hba.conf requires a password for local connections.
  if (!hasVariable(environment, "PGPASSWORD")) environment.push(`PGPASSWORD=${password}`);
  if (!hasVariable(environment, "POSTGRES_DB")) environment.push(`POSTGRES_DB=${value(b, "postgres_db")}`);
  // The image reads these only when it creates the data directory on the first start.
  if (!blank(database.values.postgres_initdb_args) && !hasVariable(environment, "POSTGRES_INITDB_ARGS")) environment.push(`POSTGRES_INITDB_ARGS=${value(b, "postgres_initdb_args")}`);
  if (!blank(database.values.postgres_host_auth_method) && !hasVariable(environment, "POSTGRES_HOST_AUTH_METHOD")) environment.push(`POSTGRES_HOST_AUTH_METHOD=${value(b, "postgres_host_auth_method")}`);
  addCoolifyVariables(b.input, environment);

  // generate_init_scripts(). find instead of a shell glob: a non-root SSH user cannot read the directory to expand it.
  b.commands.push(`find ${b.dir}/docker-entrypoint-initdb.d -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true`);
  const initScripts: string[] = [];
  for (const script of database.init_scripts ?? []) {
    // basename() strips any directory components and escapeshellarg() contains every shell metacharacter.
    const filename = basename(typeof script.filename === "string" ? script.filename : script.filename === null || script.filename === undefined ? "" : String(script.filename));
    const target = `${b.dir}/docker-entrypoint-initdb.d/${filename}`;
    const escaped = escapeshellarg(target);
    b.commands.push(tee(typeof script.content === "string" ? script.content : script.content === null || script.content === undefined ? "" : String(script.content), escaped));
    // The entrypoint runs init scripts as the postgres user; a strict server umask leaves the file unreadable.
    b.commands.push(`chmod 644 ${escaped}`);
    initScripts.push(target);
  }

  // add_custom_conf()
  const configFile = `${b.dir}/custom-postgres.conf`;
  let conf = database.values.postgres_conf ?? null;
  if (blank(conf)) {
    b.commands.push(`rm -f ${configFile}`);
  } else {
    if (!conf!.includes("listen_addresses")) {
      conf += "\nlisten_addresses = '*'";
      b.changes.postgresConf = conf!;
    }
    b.commands.push(tee(conf!, configFile));
    // The container user must read the read-only mount; a strict server umask leaves the file unreadable.
    b.commands.push(`chmod 644 ${configFile}`);
  }

  // PostgresUser::clientHost(): Supabase images accept socket logins only from postgres and supabase_admin.
  const host = isSupabaseImage(database.image) ? ["-h", "127.0.0.1"] : [];
  let command: string[] = ["postgres"];
  return {
    environment,
    healthTest: ["CMD", "psql", ...host, ...healthCheckPortArguments(conf), "-U", user, "-d", db, "-c", "SELECT 1"],
    finish: (_service, addVolumes) => {
      for (const script of initScripts) addVolumes([bind(script, "/docker-entrypoint-initdb.d/" + basename(script))]);
      if (!blank(conf)) {
        addVolumes([bind(configFile, "/etc/postgresql/postgresql.conf")]);
        command = [...command, "-c", "config_file=/etc/postgresql/postgresql.conf"];
      }
      if (database.enable_ssl) command = [...command, "-c", "ssl=on", "-c", "ssl_cert_file=/var/lib/postgresql/certs/server.crt", "-c", "ssl_key_file=/var/lib/postgresql/certs/server.key"];
    },
    afterOptions: (service) => {
      if (command.length <= 1) return;
      // The Supabase image keeps its config in /etc/postgresql and starts with "postgres -D /etc/postgresql".
      // Keep that directory when this command replaces the image CMD.
      if (blank(conf) && isSupabaseImage(database.image)) command = [command[0]!, "-D", "/etc/postgresql", ...command.slice(1)];
      service.set("command", command);
    },
    afterPull: database.enable_ssl
      ? [`docker compose -f ${b.dir}/docker-compose.yml run --rm --no-deps --user root --entrypoint chown ${database.uuid} postgres:postgres /var/lib/postgresql/certs/server.key /var/lib/postgresql/certs/server.crt < /dev/null`]
      : [],
  };
}

/** The server password of Redis, KeyDB and Dragonfly: the stored one, unless a REDIS_PASSWORD variable sets it. */
function redisLikeEnvironment(b: Building, engine: "keydb" | "dragonfly", column: string): { environment: string[]; password: string } {
  const { database } = b.input;
  let password = value(b, column);
  // serverPasswordEnvironmentVariable(): a database from before the quoting keeps its stored password.
  const passwordVariable = database.legacy_password_quoting ? null : (b.input.variables.find((v) => v.key === "REDIS_PASSWORD") ?? null);
  const environment = environmentOf(b, (variable, raw) => {
    // A REDIS_PASSWORD variable overrides the stored password, which stays unchanged.
    if (variable === passwordVariable && raw !== "") password = formatComposeFileValue(engine, variable, raw);
  });
  if (!hasVariable(environment, "REDIS_PASSWORD")) environment.push(`REDIS_PASSWORD=${value(b, column)}`);
  addCoolifyVariables(b.input, environment);
  return { environment, password };
}

function redis(b: Building): EnginePart {
  const { database } = b.input;
  const find = (key: string): StartVariable | undefined => b.input.variables.find((v) => v.key === key);
  // The stored REDIS_PASSWORD value, unresolved: the v4.3.23 server password of legacy databases.
  let password = find("REDIS_PASSWORD")?.value ?? "";
  const passwordVariable = database.legacy_password_quoting ? undefined : find("REDIS_PASSWORD");
  const environment: string[] = [];
  for (const original of b.input.variables) {
    let variable = original;
    if (variable === passwordVariable) {
      const raw = rawValueOf(variable) ?? "";
      // Credentials below are placed directly in the compose file (command).
      if (raw !== "") password = formatComposeFileValue("redis", variable, raw);
    }
    if (!isSharedReference(variable.value) && variable.key === "REDIS_USERNAME" && !usesSecretManager(variable)) {
      // $env->update(['value' => $this->database->redis_username]): the first REDIS_USERNAME variable's value, or "default".
      const stored = find("REDIS_USERNAME")?.value ?? null;
      const username = blank(stored) ? "default" : stored!;
      if (username !== variable.value) {
        b.changes.redisUsername = username;
        variable = { ...variable, value: username, realValue: username };
      }
    }
    environment.push(`${variable.key}=${formatEnvironmentValue(variable, rawValueOf(variable))}`);
  }
  addCoolifyVariables(b.input, environment);

  const conf = database.values.redis_conf ?? null;
  const hasConf = !empty(conf);
  // add_custom_redis()
  if (hasConf) b.commands.push(tee(conf!, `${b.dir}/redis.conf`));

  // buildStartCommand()
  const argument = requirePassArgument(database, password);
  const confPath = "/usr/local/etc/redis/redis.conf";
  let command = hasConf ? (conf!.includes("requirepass") ? `redis-server ${confPath}` : `redis-server ${confPath} --requirepass ${argument}`) : `redis-server --requirepass ${argument} --appendonly yes`;
  if (database.enable_ssl) command += " --tls-port 6380 --tls-cert-file /etc/redis/certs/server.crt --tls-key-file /etc/redis/certs/server.key --tls-ca-cert-file /etc/redis/certs/coolify-ca.crt --tls-auth-clients optional";

  // healthCheckCommand(): redis-cli exits 0 on error replies, so the check asks for -e where the client has it.
  const port = healthCheckPortArguments(conf);
  const exitOnError = /(^|\/)redis:([0-5]|6\.[01])\b/.test(database.image) ? [] : ["-e"];
  const healthTest = (conf ?? "").includes("requirepass") ? ["CMD", "redis-cli", ...port, "ping"] : ["CMD", "redis-cli", ...port, "-a", password, "--no-auth-warning", ...exitOnError, "ping"];

  return {
    environment,
    command,
    healthTest,
    finish: (_service, addVolumes) => {
      if (database.enable_ssl) addVolumes([bind("/data/coolify/ssl/coolify-ca.crt", "/etc/redis/certs/coolify-ca.crt")]);
      if (hasConf) addVolumes([bind(`${b.dir}/redis.conf`, confPath)]);
    },
    afterPull: [...(database.enable_ssl ? [`chown -R 999:999 ${b.dir}/ssl/server.key ${b.dir}/ssl/server.crt`] : []), ...(hasConf ? [`chown 999:999 ${b.dir}/redis.conf`] : [])],
  };
}

function keydb(b: Building): EnginePart {
  const { database } = b.input;
  const { environment, password } = redisLikeEnvironment(b, "keydb", "keydb_password");
  const conf = database.values.keydb_conf ?? null;
  const hasConf = !empty(conf);
  // add_custom_keydb()
  if (hasConf) b.commands.push(tee(conf!, `${b.dir}/keydb.conf`));

  const argument = requirePassArgument(database, password);
  const confPath = "/etc/keydb/keydb.conf";
  let command = hasConf ? (conf!.includes("requirepass") ? `keydb-server ${confPath}` : `keydb-server ${confPath} --requirepass ${argument}`) : `keydb-server --requirepass ${argument} --appendonly yes`;
  if (database.enable_ssl) command += " --tls-port 6380 --tls-cert-file /etc/keydb/certs/server.crt --tls-key-file /etc/keydb/certs/server.key --tls-ca-cert-file /etc/keydb/certs/coolify-ca.crt --tls-auth-clients optional";

  return {
    environment,
    command,
    healthTest: ["CMD", "keydb-cli", ...((conf ?? "").includes("requirepass") ? [] : ["--pass", password]), ...healthCheckPortArguments(conf), "ping"],
    finish: (_service, addVolumes) => {
      if (hasConf) addVolumes([bind(`${b.dir}/keydb.conf`, confPath)]);
      if (database.enable_ssl) addVolumes([bind("/data/coolify/ssl/coolify-ca.crt", "/etc/keydb/certs/coolify-ca.crt")]);
    },
    afterPull: [...(database.enable_ssl ? [`chown -R 999:999 ${b.dir}/ssl/server.key ${b.dir}/ssl/server.crt`] : []), ...(hasConf ? [`chown 999:999 ${b.dir}/keydb.conf`] : [])],
  };
}

function dragonfly(b: Building): EnginePart {
  const { database } = b.input;
  const { environment, password } = redisLikeEnvironment(b, "dragonfly", "dragonfly_password");
  let command = `dragonfly --requirepass ${requirePassArgument(database, password)}`;
  if (database.enable_ssl) command += " --tls --tls_cert_file /etc/dragonfly/certs/server.crt --tls_key_file /etc/dragonfly/certs/server.key --tls_ca_cert_file /etc/dragonfly/certs/coolify-ca.crt";
  const tls = database.enable_ssl ? ["--tls", "--cacert", "/etc/dragonfly/certs/coolify-ca.crt", "--cert", "/etc/dragonfly/certs/server.crt", "--key", "/etc/dragonfly/certs/server.key"] : [];
  return {
    environment,
    command,
    healthTest: ["CMD", "redis-cli", "-a", password, ...tls, "ping"],
    finish: (_service, addVolumes) => {
      if (database.enable_ssl) addVolumes([bind("/data/coolify/ssl/coolify-ca.crt", "/etc/dragonfly/certs/coolify-ca.crt")]);
    },
    afterPull: database.enable_ssl ? [`chown -R 999:999 ${b.dir}/ssl/server.key ${b.dir}/ssl/server.crt`] : [],
  };
}

/** MySQL and MariaDB: the same start but for names, the health check and how a credential variable is read. */
function mysqlLike(b: Building, engine: "mysql" | "mariadb"): EnginePart {
  const { database } = b.input;
  const upper = engine.toUpperCase();
  let rootPassword = value(b, `${engine}_root_password`);
  const environment = environmentOf(b, (variable, raw) => {
    // Credentials below are placed directly in the compose file (healthcheck, command).
    if (engine === "mysql" && variable.key === "MYSQL_ROOT_PASSWORD") rootPassword = formatComposeFileValue(engine, variable, raw);
  });
  if (!hasVariable(environment, `${upper}_ROOT_PASSWORD`)) environment.push(`${upper}_ROOT_PASSWORD=${value(b, `${engine}_root_password`)}`);
  if (!hasVariable(environment, `${upper}_DATABASE`)) environment.push(`${upper}_DATABASE=${value(b, `${engine}_database`)}`);
  if (!hasVariable(environment, `${upper}_USER`)) environment.push(`${upper}_USER=${value(b, `${engine}_user`)}`);
  if (!hasVariable(environment, `${upper}_PASSWORD`)) environment.push(`${upper}_PASSWORD=${value(b, `${engine}_password`)}`);
  addCoolifyVariables(b.input, environment);

  // add_custom_mysql()
  const conf = database.values[`${engine}_conf`] ?? null;
  const hasConf = !empty(conf);
  if (hasConf) {
    b.commands.push(tee(conf!, `${b.dir}/custom-config.cnf`));
    // The container user must read the read-only mount; a strict server umask leaves the file unreadable.
    b.commands.push(`chmod 644 ${b.dir}/custom-config.cnf`);
  }
  return {
    environment,
    healthTest: engine === "mysql" ? ["CMD", "mysqladmin", "ping", "-h", "localhost", "-u", "root", `-p${rootPassword}`] : ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"],
    finish: (_service, addVolumes) => {
      if (database.enable_ssl) addVolumes([bind("/data/coolify/ssl/coolify-ca.crt", "/etc/mysql/certs/coolify-ca.crt")]);
      if (hasConf) addVolumes([bind(`${b.dir}/custom-config.cnf`, "/etc/mysql/conf.d/custom-config.cnf")]);
    },
    afterOptions: (service) => {
      if (database.enable_ssl) service.set("command", [engine === "mysql" ? "mysqld" : "mariadbd", "--ssl-cert=/etc/mysql/certs/server.crt", "--ssl-key=/etc/mysql/certs/server.key", "--ssl-ca=/etc/mysql/certs/coolify-ca.crt", "--require-secure-transport=1"]);
    },
    afterPull: database.enable_ssl
      ? [`docker compose -f ${b.dir}/docker-compose.yml run --rm --no-deps --user root --entrypoint chown ${database.uuid} mysql:mysql /etc/mysql/certs/server.key /etc/mysql/certs/server.crt < /dev/null`]
      : [],
  };
}

function mongodb(b: Building): EnginePart {
  const { database } = b.input;
  let username = value(b, "mongo_initdb_root_username");
  let password = value(b, "mongo_initdb_root_password");
  let db = value(b, "mongo_initdb_database");
  const environment = environmentOf(b, (variable, raw) => {
    if (variable.key === "MONGO_INITDB_ROOT_USERNAME") username = raw;
    else if (variable.key === "MONGO_INITDB_ROOT_PASSWORD") password = raw;
    else if (variable.key === "MONGO_INITDB_DATABASE") db = raw;
  });
  if (!hasVariable(environment, "MONGO_INITDB_ROOT_USERNAME")) environment.push(`MONGO_INITDB_ROOT_USERNAME=${value(b, "mongo_initdb_root_username")}`);
  if (!hasVariable(environment, "MONGO_INITDB_ROOT_PASSWORD")) environment.push(`MONGO_INITDB_ROOT_PASSWORD=${value(b, "mongo_initdb_root_password")}`);
  if (!hasVariable(environment, "MONGO_INITDB_DATABASE")) environment.push(`MONGO_INITDB_DATABASE=${value(b, "mongo_initdb_database")}`);
  addCoolifyVariables(b.input, environment);

  // add_custom_mongo_conf()
  const conf = database.values.mongo_conf ?? null;
  const hasConf = !empty(conf);
  if (hasConf) {
    b.commands.push(tee(conf!, `${b.dir}/mongod.conf`));
    // The container user must read the read-only mount; a strict server umask leaves the file unreadable.
    b.commands.push(`chmod 644 ${b.dir}/mongod.conf`);
  }

  // generate_health_check_command(): the shell is chosen when the check runs — images before MongoDB 5 have only
  // the legacy mongo shell. The check uses ping, which needs no authentication.
  const shell = (legacy: boolean): string => {
    let command = [legacy ? "mongo" : "mongosh", "--quiet", "--host", database.uuid, ...healthCheckPortArguments(conf, "--port")];
    if (database.enable_ssl) {
      command = [...command, legacy ? "--ssl" : "--tls", legacy ? "--sslCAFile" : "--tlsCAFile", "/etc/mongo/certs/ca.pem"];
      if (database.ssl_mode === "verify-full") command = [...command, legacy ? "--sslPEMKeyFile" : "--tlsCertificateKeyFile", "/etc/mongo/certs/server.pem"];
    }
    return [...command, "--eval", "quit(db.adminCommand({ ping: 1 }).ok === 1 ? 0 : 1)"].map(escapeshellarg).join(" ");
  };

  const withConf = ["mongod", "--config", "/etc/mongo/mongod.conf"];
  return {
    environment,
    command: "mongod",
    healthTest: ["CMD-SHELL", `if command -v mongosh >/dev/null 2>&1; then ${shell(false)}; else ${shell(true)}; fi`],
    finish: (service, addVolumes) => {
      if (hasConf) {
        addVolumes([bind(`${b.dir}/mongod.conf`, "/etc/mongo/mongod.conf")]);
        service.set("command", withConf);
      }
      // add_default_database()
      const dbJson = jsonUnescapedSlashes(db);
      const content = `db = db.getSiblingDB(${dbJson});db.createCollection('init_collection');db.createUser({user: ${jsonUnescapedSlashes(username)}, pwd: ${jsonUnescapedSlashes(password)}, roles: [{role:"readWrite",db:${dbJson}}]});`;
      b.commands.push(`mkdir -p ${b.dir}/docker-entrypoint-initdb.d`);
      b.commands.push(tee(content, `${b.dir}/docker-entrypoint-initdb.d/01-default-database.js`));
      // The entrypoint lists and reads the init directory as the mongodb user; a strict server umask hides it.
      b.commands.push(`chmod 755 ${b.dir}/docker-entrypoint-initdb.d`);
      b.commands.push(`chmod 644 ${b.dir}/docker-entrypoint-initdb.d/01-default-database.js`);
      addVolumes([bind(`${b.dir}/docker-entrypoint-initdb.d`, "/docker-entrypoint-initdb.d")]);
      if (database.enable_ssl) addVolumes([bind("/data/coolify/ssl/coolify-ca.crt", "/etc/mongo/certs/ca.pem")]);
    },
    afterOptions: (service) => {
      if (!database.enable_ssl) return;
      const modes: Record<string, string[]> = {
        allow: ["--tlsMode=allowTLS", "--tlsAllowConnectionsWithoutCertificates", "--tlsAllowInvalidHostnames"],
        prefer: ["--tlsMode=preferTLS", "--tlsAllowConnectionsWithoutCertificates", "--tlsAllowInvalidHostnames"],
        require: ["--tlsMode=requireTLS", "--tlsAllowConnectionsWithoutCertificates", "--tlsAllowInvalidHostnames"],
        "verify-full": ["--tlsMode=requireTLS", "--tlsAllowInvalidHostnames"],
      };
      service.set("command", [...(hasConf ? withConf : ["mongod"]), ...(modes[database.ssl_mode ?? ""] ?? []), "--tlsCAFile", "/etc/mongo/certs/ca.pem", "--tlsCertificateKeyFile", "/etc/mongo/certs/server.pem"]);
    },
    afterPull: database.enable_ssl ? [`docker compose -f ${b.dir}/docker-compose.yml run --rm --no-deps --user root --entrypoint chown ${database.uuid} mongodb:mongodb /etc/mongo/certs/server.pem < /dev/null`] : [],
  };
}

function clickhouse(b: Building): EnginePart {
  let user = value(b, "clickhouse_admin_user");
  let password = value(b, "clickhouse_admin_password");
  const environment = environmentOf(b, (variable, raw) => {
    // Credentials below are placed directly in the compose file (healthcheck, command).
    if (variable.key === "CLICKHOUSE_USER") user = formatComposeFileValue("clickhouse", variable, raw);
    else if (variable.key === "CLICKHOUSE_PASSWORD") password = formatComposeFileValue("clickhouse", variable, raw);
  });
  if (!hasVariable(environment, "CLICKHOUSE_USER")) environment.push(`CLICKHOUSE_USER=${value(b, "clickhouse_admin_user")}`);
  if (!hasVariable(environment, "CLICKHOUSE_PASSWORD")) environment.push(`CLICKHOUSE_PASSWORD=${value(b, "clickhouse_admin_password")}`);
  if (!hasVariable(environment, "CLICKHOUSE_DB")) environment.push(`CLICKHOUSE_DB=${value(b, "clickhouse_db")}`);
  addCoolifyVariables(b.input, environment);
  return {
    environment,
    beforeLabels: [["ulimits", new Map<string, YamlValue>([["nofile", new Map<string, YamlValue>([["soft", 262144], ["hard", 262144]])]])]],
    healthTest: ["CMD", "clickhouse-client", "--user", user, "--password", password, "--query", "SELECT 1"],
    finish: () => undefined,
    afterPull: [],
  };
}

const ENGINE_PARTS: Readonly<Record<Engine, (b: Building) => EnginePart>> = {
  postgresql,
  redis,
  mongodb,
  mysql: (b) => mysqlLike(b, "mysql"),
  mariadb: (b) => mysqlLike(b, "mariadb"),
  keydb,
  dragonfly,
  clickhouse,
};

// ── The plan ───────────────────────────────────────────────────────────────────────────────────────────

/** generateCustomDockerRunOptionsForDatabases() */
function withCustomDockerOptions(service: Map<string, YamlValue>, options: Map<string, YamlValue>, network: string): Map<string, YamlValue> {
  const first = (key: string): string | null => {
    const list = options.get(key);
    const entry = Array.isArray(list) ? list[0] : undefined;
    return typeof entry === "string" && !empty(entry) ? entry : null;
  };
  const ipv4 = first("ip");
  const ipv6 = first("ip6");
  const rest = new Map(options);
  rest.delete("ip");
  rest.delete("ip6");
  if (ipv4 !== null || ipv6 !== null) {
    service.delete("networks");
    const address = new Map<string, YamlValue>();
    if (ipv4 !== null) address.set("ipv4_address", ipv4);
    if (ipv6 !== null) address.set("ipv6_address", ipv6);
    service.set("networks", new Map<string, YamlValue>([[network, address]]));
  }
  // A custom ulimit replaces the default of the same type; a recursive merge would combine both into an invalid value
  const custom = rest.get("ulimits");
  const defaults = service.get("ulimits");
  if (custom instanceof Map && defaults instanceof Map) for (const type of custom.keys()) defaults.delete(type);
  return arrayMergeRecursive(service, rest) as Map<string, YamlValue>;
}

/**
 * The Start action of the database's engine: its compose file and its commands. Throws RemoteSecretError when a
 * variable needs a secret manager.
 */
export function buildStartPlan(input: StartPlanInput): StartPlan {
  const { database, engine, network } = input;
  const container = database.uuid;
  const dir = databaseWorkdir(container);
  const composeFile = `${dir}/docker-compose.yml`;
  const b: Building = { input, commands: [], dir, changes: {} };

  if (engine === "clickhouse") {
    b.commands.push("echo 'Starting database.'", `mkdir -p ${dir}`);
  } else {
    b.commands.push("echo 'Starting database.'", "echo 'Creating directories.'", `mkdir -p ${dir}`);
    if (engine === "postgresql") b.commands.push(`mkdir -p ${dir}/docker-entrypoint-initdb.d/`);
    b.commands.push("echo 'Directories created successfully.'");
    if (!database.enable_ssl || input.ssl === null) {
      b.commands.push(`rm -rf ${dir}/ssl`);
    } else {
      b.commands.push("echo 'Setting up SSL for this database.'", `mkdir -p ${dir}/ssl`, ...caCertificateFileCommands(input.ssl.caCertificate));
      if (input.ssl.generated) b.commands.push("echo 'No SSL certificate found, generating new SSL certificate for this database.'");
    }
  }
  b.commands.push(...input.contentFileCommands);

  const part = ENGINE_PARTS[engine](b);

  const service = new Map<string, YamlValue>();
  service.set("image", database.image);
  if (part.command !== undefined) service.set("command", part.command);
  service.set("container_name", container);
  service.set("environment", part.environment);
  service.set("restart", RESTART_MODE);
  service.set("networks", [network]);
  for (const [key, entry] of part.beforeLabels ?? []) service.set(key, entry);
  service.set("labels", defaultDatabaseLabels(input));
  service.set("healthcheck", healthCheck(database, part.healthTest));
  service.set("mem_limit", database.limits_memory);
  service.set("memswap_limit", database.limits_memory_swap);
  service.set("mem_swappiness", database.limits_memory_swappiness);
  service.set("mem_reservation", database.limits_memory_reservation);
  service.set("cpus", new PhpFloat(floatval(database.limits_cpus)));
  service.set("cpu_shares", database.limits_cpu_shares);
  // PostgreSQL: filled(); the others: not null.
  if (engine === "postgresql" ? !blank(database.limits_cpuset) : database.limits_cpuset !== null) service.set("cpuset", database.limits_cpuset);
  if (serverDrainsLogs(input.server.logDrain) && database.is_log_drain_enabled) service.set("logging", logDrainConfiguration(input.server.logDrain));
  // ports_mappings_array
  if (database.ports_mappings !== null) service.set("ports", database.ports_mappings.split(","));

  const volumes: YamlValue[] = [];
  service.set("volumes", volumes);
  const addVolumes = (more: YamlValue[]): void => {
    volumes.push(...more);
  };
  // generate_local_persistent_volumes(): "<host path or volume name>:<mount path>".
  addVolumes(input.persistentStorages.map((storage) => `${storage.host_path !== "" && storage.host_path !== null ? storage.host_path : storage.name}:${storage.mount_path}`));
  addVolumes(input.fileStorages.map((storage) => `${storage.fs_path}:${storage.mount_path ?? ""}`));
  part.finish(service, addVolumes);

  const compose = new Map<string, YamlValue>();
  const services = new Map<string, YamlValue>();
  compose.set("services", services);
  compose.set("networks", new Map<string, YamlValue>([[network, new Map<string, YamlValue>([["external", true], ["name", network], ["attachable", true]])]]));
  // generate_local_persistent_volumes_only_volume_names(): the named volumes, not the host paths.
  const named = input.persistentStorages.filter((storage) => empty(storage.host_path));
  if (named.length > 0) compose.set("volumes", new Map<string, YamlValue>(named.map((storage) => [storage.name, new Map<string, YamlValue>([["name", storage.name], ["external", false]])])));

  // Add custom docker run options
  const merged = withCustomDockerOptions(service, convertDockerRunToCompose(database.custom_docker_run_options), network);
  part.afterOptions?.(merged);
  // isHealthcheckEnabled()
  if (!(database.health_check_enabled ?? true)) merged.delete("healthcheck");
  services.set(container, merged);

  const yaml = yamlDump(compose, 10);
  b.commands.push(tee(yaml, composeFile));
  b.commands.push(`echo '${generateReadmeFile(database.name, dateTimeString(input.now))}' | tee ${dir}/README.md > /dev/null`);
  b.commands.push("echo " + escapeshellarg(`Pulling ${database.image} image.`));
  // pullImageCommands()
  b.commands.push(`docker compose -f ${composeFile} pull`);
  b.commands.push(...part.afterPull);
  b.commands.push(dockerStopCommand(30, container, input.server.dockerVersion) + " 2>/dev/null || true");
  b.commands.push(`docker rm -f ${container} 2>/dev/null || true`);
  b.commands.push(`docker compose -f ${composeFile} up -d`);
  b.commands.push("echo 'Database started.'");

  return { commands: b.commands, compose: yaml, composeFile, configurationDir: dir, changes: b.changes };
}
