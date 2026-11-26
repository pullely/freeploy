// The database start goldens (DP-62): fixtures/database-start/cases.json and what Coolify's own PHP
// (coollabsio/coolify@91b7e3e, fixtures/database-start/emit.php) made of each case, with the world a case
// describes as the engine's store and executor see it. See the README in that folder.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseEngine } from "@saas/db/deploy";
import { resolveRealValue, type ResolvedSharedVariable } from "@deploy-core-worker/environment-variables/references";
import { withoutEdgeLineBreaks } from "@deploy-core-worker/environment-variables/env-format";
import type { DeploymentExecutor } from "@deploy-core-worker/deployments/engine";
import { defaultVolumes } from "@deploy-core-worker/databases/engines";
import type { ContentFile } from "@deploy-core-worker/databases/content-files";
import type { DatabaseEffect, DatabaseEngineDeps, DatabaseOperationContext, DatabaseOperationStore } from "@deploy-core-worker/databases/start-engine";
import type { StartVariable } from "@deploy-core-worker/databases/start-plan";
import { generateSslCertificate, type GeneratedSslCertificate } from "@deploy-core-worker/ssl/ssl-helper";

// Jest runs from tests/deploy-core-worker (its rootDir).
const dir = join(process.cwd(), "fixtures", "database-start");

export type Json = Record<string, unknown>;

export interface Response {
  match: string;
  output?: string;
  errorOutput?: string;
  exitCode?: number;
  sequence?: Array<Omit<Response, "match" | "sequence">>;
}

export type Action = "start" | "restart" | "stop" | "proxy-start" | "proxy-stop";

export interface RunCase {
  id: string;
  engine: DatabaseEngine;
  action: Action;
  server: Json;
  serverSettings: Json;
  destination: Json;
  project: Json;
  environment: Json;
  database: Json;
  variables: Json[];
  sharedVariables: Json[];
  persistentStorages: Json[];
  fileStorages: Json[];
  defaultVolumes?: boolean;
  dockerCleanup?: boolean;
  caCertificate?: Json;
  certificate?: Json;
  responses: Response[];
}

export interface GoldenProcess {
  script: string;
  output?: string;
  errorOutput?: string;
  exitCode?: number;
}

export interface GoldenCertificate {
  given: boolean;
  is_ca_certificate: boolean;
  resource: "database" | null;
  common_name: string;
  subject_alternative_names: string[] | null;
  configuration_dir: string | null;
  mount_path: string | null;
  valid_until: string;
}

/** What emit.php says of a certificate Coolify generated (openssl_x509_parse). */
export interface GoldenCertificateFacts {
  subject: Record<string, string>;
  issuer: Record<string, string>;
  subjectAltName: string | null;
  basicConstraints: string | null;
  validDays: number;
  curve: string | null;
  signature: string;
}

export interface GoldenFile {
  fs_path: string;
  mount_path: string | null;
  content: string | null;
  is_directory: boolean;
  chmod: string | null;
  chown: string | null;
}

export interface GoldenRun {
  result: { activity: true } | string | null;
  thrown: string | null;
  jobThrown: string | null;
  processes: GoldenProcess[];
  activity: { status: string; exitCode: number | null; error: string | null; operation: string; log: Array<{ type: string; output: string }> } | null;
  database: { status: string; started_at: string | null; last_online_at: string; is_public: boolean; restart_count: number | null; last_restart_at: string | null; last_restart_type: string | null; conf?: string | null };
  certificates: GoldenCertificate[];
  fileStorages: GoldenFile[];
  variables: Array<{ key: string; value: string | null }>;
  generated: { ca?: GoldenCertificateFacts; certificate?: GoldenCertificateFacts } | null;
  sleeps: number[];
  notifications: string[];
  jobs: string[];
  events: string[];
}

interface CasesFile {
  texts: Record<string, string>;
  defaults: Omit<RunCase, "id" | "engine" | "action">;
  runs: Array<Partial<RunCase> & { id: string; engine: DatabaseEngine; action: Action }>;
}

const casesFile = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")) as CasesFile;
const goldensFile = JSON.parse(readFileSync(join(dir, "goldens.json"), "utf8")) as { now: string; strings: string[]; runs: Record<string, unknown> };

/** A long string that occurs more than once is written once, in `strings` (emit.php). */
function resolved(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resolved);
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$string") return goldensFile.strings[(value as { $string: number }).$string];
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolved(v)]));
  }
  return value;
}

/** A value "@text:<name>" of a case stands for a long text of `texts` (a certificate, a key). */
function withTexts(value: unknown): unknown {
  if (typeof value === "string") return value.startsWith("@text:") ? casesFile.texts[value.slice(6)] : value;
  if (Array.isArray(value)) return value.map(withTexts);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withTexts(v)]));
  return value;
}

const isMap = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

/** emit.php's merged(): maps merge key by key, anything else (a list too) replaces. */
function merged(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = isMap(value) && isMap(base[key]) ? merged(base[key], value) : value;
  return out;
}

/** The instant every golden run stands still at. */
export const GOLDEN_NOW = goldensFile.now;
/** emit.php's LAST_ONLINE_AT: what last_online_at holds before a run. */
export const LAST_ONLINE_AT = "2026-11-01 00:00:00";

export const runCases: RunCase[] = (withTexts(casesFile.runs) as CasesFile["runs"]).map((run) => {
  const full = merged(casesFile.defaults as unknown as Json, run as unknown as Json) as unknown as RunCase;
  // A case's responses are asked first; the defaults answer what it leaves.
  full.responses = [...(run.responses ?? []), ...casesFile.defaults.responses];
  return full;
});

/**
 * "Coolify" reads "Freeploy" in what Freeploy says to its user: the warnings about a database's content files,
 * which a start echoes into its log. Everything else of a script — the commands, the paths, the names on the
 * server — stays Coolify's.
 */
const branded = (script: string): string => script.split("\n").map((line) => (line.startsWith("echo 'Warning: ") ? line.replace(/Coolify/g, "Freeploy") : line)).join("\n");

export function goldenRun(id: string): GoldenRun {
  const run = resolved(goldensFile.runs[id]) as GoldenRun;
  return { ...run, processes: run.processes.map((process) => ({ ...process, script: branded(process.script) })) };
}

export const ENGINES: readonly DatabaseEngine[] = ["postgresql", "redis", "mysql", "mariadb", "mongodb", "keydb", "dragonfly", "clickhouse", "sqlite"];

// ── The world of a case ────────────────────────────────────────────────────────────────────────────────

/** What each engine's table holds for a column the case does not give: the schema's defaults. */
const COLUMN_DEFAULTS: Readonly<Record<DatabaseEngine, Record<string, string | null>>> = {
  postgresql: { postgres_user: "postgres", postgres_db: "postgres", postgres_password: null, postgres_initdb_args: null, postgres_host_auth_method: null, postgres_conf: null },
  redis: { redis_conf: null },
  mongodb: { mongo_initdb_root_username: "root", mongo_initdb_database: "default", mongo_initdb_root_password: null, mongo_conf: null },
  mysql: { mysql_user: "mysql", mysql_database: "default", mysql_root_password: null, mysql_password: null, mysql_conf: null },
  mariadb: { mariadb_user: "mariadb", mariadb_database: "default", mariadb_root_password: null, mariadb_password: null, mariadb_conf: null },
  keydb: { keydb_password: null, keydb_conf: null },
  dragonfly: { dragonfly_password: null },
  clickhouse: { clickhouse_admin_user: "default", clickhouse_db: "default", clickhouse_admin_password: null },
  sqlite: { sqlite_databases: "database.sqlite" },
};
const SSL_MODE_DEFAULTS: Readonly<Partial<Record<DatabaseEngine, string>>> = { postgresql: "require", mysql: "REQUIRED", mongodb: "require" };
/** The engine's configuration column, which a start can rewrite (emit.php's CONF_COLUMNS). */
export const CONF_COLUMNS: Readonly<Partial<Record<DatabaseEngine, string>>> = { postgresql: "postgres_conf", redis: "redis_conf", mongodb: "mongo_conf", mysql: "mysql_conf", mariadb: "mariadb_conf", keydb: "keydb_conf" };

export interface WorldCertificate extends GoldenCertificate {
  certificate: string;
  privateKey: string;
}

export interface World {
  run: RunCase;
  database: { status: string; started_at: string | null; last_online_at: string; is_public: boolean; restart_count: number; last_restart_at: string | null; last_restart_type: string | null; conf: string | null };
  certificates: WorldCertificate[];
  fileStorages: ContentFile[];
  variables: Array<{ key: string; value: string | null }>;
  processes: Array<{ script: string }>;
  /** The first process that was not Coolify's. */
  mismatch: string | null;
  sleeps: number[];
  effects: DatabaseEffect[];
  /** The texts the engine generated, for the masks. */
  generated: { ca: GeneratedSslCertificate | null; leaf: GeneratedSslCertificate | null };
}

const str = (value: unknown, fallback: string | null = null): string | null => (value === undefined || value === null ? fallback : String(value));
const bool = (value: unknown, fallback = false): boolean => (value === undefined || value === null ? fallback : Boolean(value));

/** Y-m-d H:i:s of a Date, UTC: how a timestamp column reads. */
const timestamp = (date: Date): string => date.toISOString().slice(0, 19).replace("T", " ");
/** Carbon's toJSON(): microseconds. */
const carbonJson = (date: Date): string => date.toISOString().replace("Z", "000Z");

const contentFile = (file: Json): ContentFile => ({
  fs_path: String(file.fs_path),
  mount_path: str(file.mount_path),
  content: str(file.content),
  is_directory: bool(file.is_directory),
  is_host_file: bool(file.is_host_file),
  is_based_on_git: bool(file.is_based_on_git),
  chown: str(file.chown),
  chmod: str(file.chmod),
});

/** The model's status mutator: "running" is stored as "running:unhealthy". */
const storedStatus = (value: string): string => (value.includes(":") ? value : `${value}:unhealthy`);

export function newWorld(run: RunCase): World {
  const certificates: WorldCertificate[] = [];
  if (run.caCertificate) {
    certificates.push({ given: true, is_ca_certificate: true, resource: null, common_name: "Coolify CA Certificate", subject_alternative_names: null, configuration_dir: null, mount_path: null, valid_until: "2036-11-17T10:11:12.000000Z", certificate: String(run.caCertificate.ssl_certificate), privateKey: String(run.caCertificate.ssl_private_key) });
  }
  if (run.certificate) {
    certificates.push({
      given: true,
      is_ca_certificate: false,
      resource: "database",
      common_name: String(run.database.uuid),
      subject_alternative_names: (run.certificate.subject_alternative_names as string[] | undefined) ?? null,
      configuration_dir: str(run.certificate.configuration_dir),
      mount_path: str(run.certificate.mount_path),
      valid_until: "2027-11-20T10:11:12.000000Z",
      certificate: String(run.certificate.ssl_certificate),
      privateKey: String(run.certificate.ssl_private_key),
    });
  }
  const conf = CONF_COLUMNS[run.engine];
  return {
    run,
    database: {
      // The column's default is "exited", which no mutator has seen; a given status went through the model.
      status: run.database.status === undefined ? "exited" : storedStatus(String(run.database.status)),
      started_at: str(run.database.started_at),
      last_online_at: LAST_ONLINE_AT,
      is_public: bool(run.database.is_public),
      restart_count: Number(run.database.restart_count ?? 0),
      last_restart_at: str(run.database.last_restart_at),
      last_restart_type: str(run.database.last_restart_type),
      conf: conf ? str(run.database[conf]) : null,
    },
    certificates,
    fileStorages: run.fileStorages.map(contentFile),
    // The value accessor: null for a stored null or "".
    variables: run.variables.map((v) => ({ key: String(v.key), value: v.value === undefined || v.value === null || v.value === "" ? null : withoutEdgeLineBreaks(String(v.value)) })),
    processes: [],
    mismatch: null,
    sleeps: [],
    effects: [],
    generated: { ca: null, leaf: null },
  };
}

/** Server::isFunctional(): reachable, usable, not disabled (no case has a placeholder address). */
const functional = (run: RunCase): boolean => bool(run.serverSettings.is_reachable) && bool(run.serverSettings.is_usable) && !bool(run.serverSettings.force_disabled);

/** The case as the engine reads it at this moment of its world. */
export function contextOf(world: World): DatabaseOperationContext {
  const { run } = world;
  const d = run.database;
  const uuid = String(d.uuid);
  const shared = new Map<string, ResolvedSharedVariable>(run.sharedVariables.map((s) => [`${String(s.type)}.${String(s.key)}`, { value: String(s.value), isShownOnce: bool(s.is_shown_once) }]));
  const variables: StartVariable[] = world.variables.map((v, index) => {
    const row = run.variables[index]!;
    return {
      key: v.key,
      value: v.value,
      realValue: resolveRealValue(v.value, { find: (type, key) => shared.get(`${type}.${key}`) ?? null }),
      is_literal: bool(row.is_literal),
      is_multiline: bool(row.is_multiline),
      uses_legacy_escaping: bool(row.uses_legacy_escaping),
    };
  });
  const values: Record<string, string | null> = { ...COLUMN_DEFAULTS[run.engine] };
  for (const column of Object.keys(values)) if (d[column] !== undefined) values[column] = str(d[column]);
  const conf = CONF_COLUMNS[run.engine];
  if (conf) values[conf] = world.database.conf;
  const volumes = run.defaultVolumes === false ? [] : defaultVolumes(run.engine, uuid, String(d.image)).map((v) => ({ name: v.name, mount_path: v.mountPath, host_path: null as string | null }));
  return {
    engine: run.engine,
    database: {
      uuid,
      name: String(d.name),
      image: String(d.image),
      // The ports_mappings mutator: "" is null.
      ports_mappings: d.ports_mappings === "" ? null : str(d.ports_mappings),
      limits_memory: str(d.limits_memory, "0")!,
      limits_memory_swap: str(d.limits_memory_swap, "0")!,
      limits_memory_swappiness: Number(d.limits_memory_swappiness ?? 60),
      limits_memory_reservation: str(d.limits_memory_reservation, "0")!,
      limits_cpus: str(d.limits_cpus, "0")!,
      limits_cpuset: str(d.limits_cpuset),
      limits_cpu_shares: Number(d.limits_cpu_shares ?? 1024),
      custom_docker_run_options: str(d.custom_docker_run_options),
      enable_ssl: bool(d.enable_ssl),
      ssl_mode: str(d.ssl_mode, SSL_MODE_DEFAULTS[run.engine] ?? null),
      legacy_password_quoting: bool(d.legacy_password_quoting),
      is_log_drain_enabled: bool(d.is_log_drain_enabled),
      include_coolify_default_variables: d.include_coolify_default_variables === undefined ? true : bool(d.include_coolify_default_variables),
      health_check_enabled: d.health_check_enabled === undefined ? null : bool(d.health_check_enabled),
      health_check_interval: (d.health_check_interval as number | undefined) ?? null,
      health_check_timeout: (d.health_check_timeout as number | undefined) ?? null,
      health_check_retries: (d.health_check_retries as number | undefined) ?? null,
      health_check_start_period: (d.health_check_start_period as number | undefined) ?? null,
      values,
      init_scripts: (d.init_scripts as Array<{ filename?: unknown; content?: unknown }> | undefined) ?? null,
      status: world.database.status,
      is_public: world.database.is_public,
      public_port: (d.public_port as number | undefined) ?? null,
      // The column's default (migration 630).
      public_port_timeout: d.public_port_timeout === undefined ? 3600 : (d.public_port_timeout as number | null),
    },
    projectName: String(run.project.name),
    // Environment::customizeName(): what the model stores of a name.
    environmentName: String(run.environment.name).toLowerCase().trim().split("/").join("-"),
    network: String(run.destination.network),
    server: {
      ip: str(run.server.ip),
      user: String(run.server.user),
      functional: functional(run),
      swarm: false,
      dockerVersion: str(run.serverSettings.docker_version),
      logDrain: {
        is_logdrain_newrelic_enabled: bool(run.serverSettings.is_logdrain_newrelic_enabled),
        is_logdrain_axiom_enabled: bool(run.serverSettings.is_logdrain_axiom_enabled),
        is_logdrain_custom_enabled: bool(run.serverSettings.is_logdrain_custom_enabled),
        is_logdrain_cloudwatch_enabled: bool(run.serverSettings.is_logdrain_cloudwatch_enabled),
        logdrain_cloudwatch_region: str(run.serverSettings.logdrain_cloudwatch_region),
        logdrain_cloudwatch_group: str(run.serverSettings.logdrain_cloudwatch_group),
        logdrain_cloudwatch_stream_prefix: str(run.serverSettings.logdrain_cloudwatch_stream_prefix),
      },
    },
    persistentStorages: [...volumes, ...run.persistentStorages.map((s) => ({ name: String(s.name), mount_path: String(s.mount_path), host_path: str(s.host_path) }))],
    fileStorages: world.fileStorages,
    variables,
  };
}

/** The store of a world: what Coolify's queries do to the rows of a case. */
export function storeOf(world: World): DatabaseOperationStore {
  const certificateRow = (generated: GeneratedSslCertificate, where: { resource: "database" | null; configurationDir: string | null; mountPath: string | null }): WorldCertificate => ({
    given: false,
    is_ca_certificate: generated.isCaCertificate,
    resource: where.resource,
    common_name: generated.commonName,
    subject_alternative_names: generated.subjectAlternativeNames,
    configuration_dir: where.configurationDir,
    mount_path: where.mountPath,
    valid_until: carbonJson(generated.validUntil),
    certificate: generated.sslCertificate,
    privateKey: generated.sslPrivateKey,
  });
  return {
    markStarted: async (now) => {
      world.database.started_at ??= timestamp(now);
    },
    setStatus: async (status, now) => {
      world.database.status = status;
      world.database.last_online_at = timestamp(now);
    },
    resetRestartCounters: async () => {
      world.database.restart_count = 0;
      world.database.last_restart_at = null;
      world.database.last_restart_type = null;
    },
    touchLastOnline: async (now) => {
      world.database.last_online_at = timestamp(now);
    },
    setPublic: async (isPublic) => {
      world.database.is_public = isPublic;
    },
    setPostgresConf: async (conf) => {
      world.database.conf = conf;
    },
    setVariableValue: async (key, value) => {
      const variable = world.variables.find((v) => v.key === key);
      if (variable) variable.value = value;
    },
    findCaCertificate: async () => {
      const ca = world.certificates.find((c) => c.is_ca_certificate);
      return ca ? { certificate: ca.certificate, privateKey: ca.privateKey } : null;
    },
    replaceCaCertificate: async (generated) => {
      world.generated.ca = generated;
      world.certificates = [...world.certificates.filter((c) => c.resource !== null), certificateRow(generated, { resource: null, configurationDir: null, mountPath: null })];
    },
    findCertificate: async () => {
      const found = world.certificates.find((c) => c.resource === "database");
      return found ? { commonName: found.common_name, subjectAlternativeNames: found.subject_alternative_names ?? [], configurationDir: found.configuration_dir, mountPath: found.mount_path } : null;
    },
    deleteCertificates: async () => {
      world.certificates = world.certificates.filter((c) => c.resource !== "database");
    },
    deleteFileStorages: async (mountPaths) => {
      world.fileStorages = world.fileStorages.filter((f) => !mountPaths.includes(f.mount_path ?? ""));
      return world.fileStorages;
    },
    replaceCertificate: async (generated, where, mountPaths, files) => {
      world.generated.leaf = generated;
      world.certificates = [...world.certificates.filter((c) => c.resource !== "database"), certificateRow(generated, { resource: "database", configurationDir: where.configurationDir, mountPath: where.mountPath })];
      world.fileStorages = [
        ...world.fileStorages.filter((f) => !mountPaths.includes(f.mount_path ?? "")),
        ...files.map((f) => ({ ...f, is_directory: false, is_host_file: false, is_based_on_git: false, chown: null })),
      ];
      return world.fileStorages;
    },
  };
}

/**
 * The server of a golden run, as an executor: it refuses a process that Coolify did not start at that point,
 * and answers what the case scripted. Laravel's faked process ends its output with a line break, as a real
 * command's output does; so does this one.
 */
export function replayExecutor(world: World, golden: GoldenProcess[]): DeploymentExecutor {
  const line = (text: string | undefined): string => (text === undefined || text === "" ? "" : text.endsWith("\n") ? text : text + "\n");
  return {
    async run(process, onOutput) {
      const index = world.processes.length;
      const expected = golden[index];
      const script = masked(world, process.script);
      world.processes.push({ script });
      const refuse = (message: string): never => {
        world.mismatch ??= message;
        throw new Error(message);
      };
      if (!expected) return refuse(`Process ${index + 1} is one more than Coolify ran:\n${script}`);
      if (expected.script !== script) return refuse(`Process ${index + 1} is not Coolify's.\n  Coolify: ${expected.script}\n  engine:  ${script}`);
      const stdout = line(expected.output);
      const stderr = line(expected.errorOutput);
      if (stdout) await onOutput?.("out", stdout);
      if (stderr) await onOutput?.("err", stderr);
      return { exitCode: expected.exitCode ?? 0, stdout, stderr };
    },
  };
}

/** An executor that answers a case's `responses` to whatever is run: the server without Coolify's run beside it. */
export function scriptedExecutor(world: World, responses: Response[] = world.run.responses): DeploymentExecutor {
  const matched = new Map<number, number>();
  return {
    async run(process, onOutput) {
      world.processes.push({ script: process.script });
      let answer: Omit<Response, "match" | "sequence"> = {};
      for (const [index, rule] of responses.entries()) {
        if (!process.script.includes(rule.match)) continue;
        const count = (matched.get(index) ?? 0) + 1;
        matched.set(index, count);
        answer = rule.sequence ? (rule.sequence[count - 1] ?? rule.sequence[rule.sequence.length - 1]!) : rule;
        break;
      }
      if (answer.output) await onOutput?.("out", answer.output);
      if (answer.errorOutput) await onOutput?.("err", answer.errorOutput);
      return { exitCode: answer.exitCode ?? 0, stdout: answer.output ?? "", stderr: answer.errorOutput ?? "" };
    },
  };
}

const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

/**
 * emit.php's masks: a generated certificate or key is not reproducible, so each — wherever it stands, as it is
 * or in base64 — reads as its mask, in Coolify's run and in this one.
 */
export function masked(world: World, text: string): string {
  const masks: Array<[string, string]> = [];
  const { ca, leaf } = world.generated;
  if (ca) masks.push([ca.sslCertificate, "{{generated:ca-certificate}}"], [ca.sslPrivateKey, "{{generated:ca-private-key}}"]);
  if (leaf) masks.push([`${leaf.sslCertificate}\n${leaf.sslPrivateKey}`, "{{generated:certificate-and-key}}"], [leaf.sslCertificate, "{{generated:certificate}}"], [leaf.sslPrivateKey, "{{generated:private-key}}"]);
  let out = text;
  for (const [secret, name] of masks) out = out.split(base64(secret)).join(name).split(secret).join(name);
  return out;
}

export function depsOf(world: World, executor: DeploymentExecutor): DatabaseEngineDeps {
  return {
    executor,
    store: storeOf(world),
    now: () => new Date(GOLDEN_NOW),
    sleep: async (seconds) => {
      world.sleeps.push(seconds);
    },
    effect: (effect) => {
      world.effects.push(effect);
    },
    // Coolify's own generator (DP-48's port of it), at the instant the goldens stand still at.
    generateCertificate: (options) => generateSslCertificate({ ...options, now: new Date(GOLDEN_NOW) }),
  };
}
