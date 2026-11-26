// The API goldens (fixtures/api, emitted by Coolify's own PHP) and the masking both sides go through
// before they are compared byte for byte. See fixtures/api/README.md, "Masking".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { fromJs, isObj, obj, phpJsonEncode, type PhpValue } from "@saas/contracts/coolify-api";

const HERE = dirname(fileURLToPath(import.meta.url));
export const API_FIXTURES = resolve(HERE, "../fixtures/api");

export interface Step {
  token?: string;
  authorization?: string;
  method: string;
  path: string;
  body?: unknown;
  raw?: string;
  contentType?: string;
  ip?: string;
  advance?: number;
}
export interface Case extends Step {
  name: string;
  instance?: { is_api_enabled?: boolean; allowed_ips?: string };
  config?: { rate_limit?: number; failed_request_rate_limit?: number };
  sequence?: Step[];
  /** SQL emit.php runs before the request (DP-74: a part made to run). */
  setup?: string[];
  /** DP-86: SQL of one side's tables only (a row with Coolify's team_id or Freeploy's org_id), after `setup`. */
  setupCoolify?: string[];
  setupFreeploy?: string[];
  /** SQL whose rows emit.php reports after a write (`after` of the golden). */
  after?: Record<string, string>;
}
export interface Answer {
  status: number;
  headers: Record<string, string>;
  body: { json?: string; text?: string };
}
export interface Golden extends Answer {
  name: string;
  steps?: Answer[];
  /** For a write: the rows its `after` queries found (emit.php). */
  after?: Record<string, unknown[]>;
}
export interface FixtureToken {
  key: string;
  id: number;
  user: number;
  team: number;
  name: string;
  abilities: string[];
  secret: string;
  expires_at?: string;
}
export interface Fixture {
  teams: Array<{ id: number; name: string; description: string | null; personal_team: boolean }>;
  users: Array<{ id: number; name: string; email: string; teams: Array<{ team: number; role: string }> }>;
  projects: Array<{ id: number; uuid: string; name: string; description: string | null; team: number; environments: Array<{ id: number; uuid: string; name: string; description: string | null }> }>;
  privateKeys: Array<{ id: number; uuid: string; name: string; description: string | null; file: string; team: number }>;
  servers: Array<{ id: number; uuid: string; name: string; description: string | null; ip: string; user: string; port: number; team: number; private_key_id: number }>;
  tokens: FixtureToken[];
  /** DP-71: each server's default destination, the applications and their variables. */
  destinations: Array<{ id: number; uuid: string; server_id: number }>;
  applications: Array<{ id: number; uuid: string; team: number; environment_id: number; destination_id: number; name: string; fqdn: string | null; columns: Record<string, string | number | boolean> }>;
  variables: Array<{ uuid: string; application: number; key: string; value: string; is_literal: boolean; is_multiline: boolean; is_shown_once: boolean; is_runtime: boolean; is_buildtime: boolean; comment: string | null }>;
  /** DP-73: an S3 storage per team, the standalone databases, their backup schedules and two executions. */
  s3Storages: Array<{ id: number; uuid: string; team: number; name: string; description: string | null; region: string; key: string; secret: string; bucket: string; endpoint: string; is_usable: boolean }>;
  databases: Array<{ engine: string; id: number; uuid: string; team: number; environment_id: number; destination_id: number; name: string; columns: Record<string, string | number | boolean> }>;
  backups: Array<{ id: number; uuid: string; team: number; engine: string; database_id: number; frequency: string; save_s3: boolean; s3: number[]; databases_to_backup: string | null; created_at: string }>;
  executions: Array<{ id: number; uuid: string; backup: number; status: string; message: string; size: number | null; filename: string | null; database_name: string; created_at: string; finished_at: string }>;
  /** DP-74: a service per team, their applications and database, the services' variables. */
  services: Array<{ id: number; uuid: string; team: number; environment_id: number; server_id: number; destination_id: number; name: string; description: string | null; docker_compose_raw: string; docker_compose: string | null; service_type: string | null }>;
  serviceApplications: Array<{ id: number; uuid: string; service: number; name: string; image: string; fqdn: string | null }>;
  serviceDatabases: Array<{ id: number; uuid: string; service: number; name: string; image: string }>;
  serviceVariables: Array<{ uuid: string; service: number; key: string; value: string; is_shown_once: boolean; comment: string | null }>;
  /** DP-74: deployments in the queue. */
  deployments: Array<{ id: number; uuid: string; application: number; status: string; commit: string; server_id: number; destination_id: number; application_name: string; server_name: string; logs: string | null; created_at: string; finished_at: string | null }>;
  /** DP-81: the teams' tags and what they are attached to ("application", "redis" or "service" and its id), in order. */
  tags: Array<{ id: number; uuid: string; team: number; name: string; created_at: string }>;
  taggables: Array<{ tag: number; type: "application" | "redis" | "service"; id: number }>;
  /** DP-81: shared variables of projects and environments (ids after the servers' four predefined ones). */
  sharedVariables: Array<{ id: number; team: number; type: "project" | "environment"; project_id: number | null; environment_id: number | null; key: string; value: string; is_literal: boolean; is_multiline: boolean; is_shown_once: boolean; comment: string | null }>;
  /** DP-84: the teams' own shared variables (type team). */
  teamVariables: Array<{ id: number; team: number; key: string; value: string; is_literal: boolean; is_multiline: boolean; is_shown_once: boolean; comment: string | null }>;
  /** DP-84: the storages of an application, a PostgreSQL and a service's application ("application", "postgresql", "serviceApplication"). */
  persistentStorages: Array<{ id: number; uuid: string; name: string; mount_path: string; resource: StorageResource; resource_id: number }>;
  fileStorages: Array<{ id: number; uuid: string; fs_path: string; mount_path: string; content: string | null; is_directory: boolean; is_host_file: boolean; resource: StorageResource; resource_id: number }>;
  /** DP-84: scheduled tasks and their executions. */
  scheduledTasks: Array<{ id: number; uuid: string; team: number; application_id: number | null; service_id: number | null; name: string; command: string; frequency: string; container: string | null; timeout: number; use_shell: boolean; enabled: boolean; created_at: string }>;
  scheduledTaskExecutions: Array<{ id: number; uuid: string; task: number; status: string; message: string | null; started_at: string | null; finished_at: string | null; duration: number | null; retry_count: number; created_at: string }>;
  /** DP-85: a server's Docker cleanup runs. */
  dockerCleanupExecutions: Array<{ id: number; uuid: string; server_id: number; status: string; message: string | null; created_at: string; finished_at: string | null }>;
  /** DP-86: the applications' previews. */
  previews: Array<{ id: number; uuid: string; application: number; pull_request_id: number; pull_request_html_url: string; git_type: string | null; fqdn: string | null; docker_registry_image_tag: string | null; status: string; created_at: string }>;
}

export type StorageResource = "application" | "postgresql" | "serviceApplication";

export const CASES = JSON.parse(readFileSync(resolve(API_FIXTURES, "cases.json"), "utf8")) as { fixture: Fixture; cases: Case[] };
export const GOLDENS = JSON.parse(readFileSync(resolve(API_FIXTURES, "goldens.json"), "utf8")) as { version: string; columns: Record<string, string[]>; cases: Golden[] };
export const FREEPLOY_ROWS = JSON.parse(readFileSync(resolve(API_FIXTURES, "freeploy-rows.json"), "utf8")) as Record<string, Array<Array<[string, unknown]>>>;

export function golden(name: string): Golden {
  const g = GOLDENS.cases.find((c) => c.name === name);
  if (!g) throw new Error(`no golden ${name}`);
  return g;
}

/** Every uuid and id the fixture gives: they compare as they are. */
const FIXTURE_UUIDS = new Set<string>([
  ...CASES.fixture.projects.flatMap((p) => [p.uuid, ...p.environments.map((e) => e.uuid)]),
  ...CASES.fixture.privateKeys.map((k) => k.uuid),
  ...CASES.fixture.servers.map((s) => s.uuid),
  ...CASES.fixture.destinations.map((d) => d.uuid),
  ...CASES.fixture.applications.map((a) => a.uuid),
  ...CASES.fixture.variables.map((v) => v.uuid),
  ...CASES.fixture.s3Storages.map((s) => s.uuid),
  ...CASES.fixture.databases.map((d) => d.uuid),
  ...CASES.fixture.backups.map((b) => b.uuid),
  ...CASES.fixture.executions.map((x) => x.uuid),
  ...CASES.fixture.services.map((s) => s.uuid),
  ...CASES.fixture.serviceApplications.map((a) => a.uuid),
  ...CASES.fixture.serviceDatabases.map((d) => d.uuid),
  ...CASES.fixture.serviceVariables.map((v) => v.uuid),
  ...CASES.fixture.deployments.map((d) => d.uuid),
  ...CASES.fixture.tags.map((t) => t.uuid),
  ...CASES.fixture.persistentStorages.map((v) => v.uuid),
  ...CASES.fixture.fileStorages.map((f) => f.uuid),
  ...CASES.fixture.scheduledTasks.map((t) => t.uuid),
  ...CASES.fixture.scheduledTaskExecutions.map((x) => x.uuid),
  ...CASES.fixture.dockerCleanupExecutions.map((x) => x.uuid),
  ...CASES.fixture.previews.map((p) => p.uuid),
]);

const LARAVEL_DATE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const SQL_DATE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;
const PUBLIC_ID = /^[a-z0-9]{24}$/;
/** Keys whose values are the team's id (Coolify's integer, Freeploy's org_…), or a secret neither side can reproduce. */
const TEAM_KEYS = new Set(["team_id", "current_team_id"]);
const SECRET_KEYS = new Set(["sentinel_token"]);

/**
 * The masking: dates (both formats) as <date> or <sql-date>; a uuid the fixture did not give (made by the
 * request) as <new-uuid>, also where a connection URL names it as its host; the team id as <team>; a member's id as <user:email>; the id of a server's settings
 * row (an auto-increment neither side fixes) as <settings-id>; the Sentinel token as <secret>.
 */
export function mask(value: PhpValue, context: { teamIdKey?: boolean } = {}, parentKey = ""): PhpValue {
  if (Array.isArray(value)) return value.map((v) => mask(v, context, parentKey));
  // A created shared variable's answer, {"id":N}: the sequence's next id, which earlier cases moved (DP-81).
  if (isObj(value) && parentKey === "" && value.entries.length === 1 && value.entries[0]![0] === "id" && typeof value.entries[0]![1] === "number") return obj({ id: "<new-id>" });
  if (isObj(value)) {
    const email = value.entries.find(([k]) => k === "email")?.[1];
    // A row the request made (its uuid is new, DP-84: a created storage): its id is the sequence's, which earlier cases moved.
    const uuid = value.entries.find(([k]) => k === "uuid")?.[1];
    const madeByRequest = typeof uuid === "string" && PUBLIC_ID.test(uuid) && !FIXTURE_UUIDS.has(uuid);
    return obj(
      value.entries.map(([k, v]): [string, PhpValue] => {
        if (TEAM_KEYS.has(k) && v !== null) return [k, "<team>"];
        // Coolify generates a Sentinel token when it creates the settings row; Freeploy's server creation stores none (freeploy-rows.json; a departure), so it is masked even when null.
        if (SECRET_KEYS.has(k)) return [k, "<secret>"];
        if (k === "id" && context.teamIdKey && parentKey === "") return [k, "<team>"];
        // A team nested in a project (a deployment's application.environment.project.team, DP-78).
        if (k === "id" && parentKey === "team") return [k, "<team>"];
        if (k === "id" && typeof email === "string") return [k, `<user:${email}>`];
        if (k === "id" && parentKey === "settings") return [k, "<settings-id>"];
        if (k === "id" && typeof v === "number" && madeByRequest) return [k, "<new-id>"];
        // A server's default destination: Coolify names it "coolify", Freeploy "freeploy" (a label; the network is "coolify" on both, DP-71).
        if (k === "name" && parentKey === "destination" && (v === "coolify" || v === "freeploy")) return [k, "<default-destination-name>"];
        return [k, mask(v, context, k)];
      }),
    );
  }
  if (typeof value === "string") {
    if (LARAVEL_DATE.test(value)) return "<date>";
    if (SQL_DATE.test(value)) return "<sql-date>";
    if (PUBLIC_ID.test(value) && !FIXTURE_UUIDS.has(value)) return "<new-uuid>";
    // A connection URL names its database by uuid (the host of internal_db_url): a database the request made (DP-73).
    // …and where a generated domain names it after its container (`http://<name>-<uuid>.<host>` of a created service, DP-74).
    if (value.includes("://"))
      return value
        .replace(/@([a-z0-9]{24}):/g, (all, uuid: string) => (FIXTURE_UUIDS.has(uuid) ? all : "@<new-uuid>:"))
        .replace(/-([a-z0-9]{24})\./g, (all, uuid: string) => (FIXTURE_UUIDS.has(uuid) ? all : "-<new-uuid>."));
  }
  return value;
}

/** A JSON body, masked and written again as PHP writes it. */
export function maskedJson(text: string, context: { teamIdKey?: boolean } = {}): string {
  return phpJsonEncode(mask(fromJs(JSON.parse(text)), context));
}
