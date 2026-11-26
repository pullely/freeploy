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
  /** DP-90: the outside API's answers (Http::fake()). */
  http?: HttpAnswer[];
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
  /** DP-90: the requests Coolify sent to the faked outside API. */
  requests?: HttpRequestRecord[];
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
  /** A key's text is a committed test key: `file` itself, or the string at `json` (a path of keys) inside that JSON file (DP-93). */
  privateKeys: Array<{ id: number; uuid: string; name: string; description: string | null; file: string; json?: Array<string | number>; team: number }>;
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
  /** DP-90: the teams' cloud provider tokens (the token in plain text; each side stores it encrypted). */
  cloudTokens: Array<{ id: number; uuid: string; team: number; provider: string; token: string; name: string; description: string | null }>;
  /** DP-104: the teams' integration tokens (the token in plain text; each side stores it encrypted) and the Cloudflare tokens' zones. */
  integrationTokens: Array<{ id: number; uuid: string; team: number; provider: string; name: string; token: string; capabilities: string[]; metadata: Record<string, unknown> | null; created_at: string }>;
  dnsZones: Array<{ id: number; uuid: string; token: number; provider_zone_id: string; name: string; account_id: string | null; account_name: string | null; created_at: string }>;
  /** DP-103: the teams' GitLab and Gitea Apps (the secrets in plain text; each side stores them encrypted). */
  gitlabApps: OauthSourceFixture[];
  giteaApps: OauthSourceFixture[];
}

/** DP-103: a GitLab App (group_name, webhook_token) or a Gitea App (organization, webhook_secret) of the fixture. */
export interface OauthSourceFixture {
  id: number;
  uuid: string;
  team: number;
  name: string;
  html_url: string;
  api_url: string;
  custom_user: string;
  custom_port: number;
  group_name?: string | null;
  organization?: string | null;
  client_id: string | null;
  client_secret: string | null;
  webhook_token?: string | null;
  webhook_secret?: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
  redirect_uri: string | null;
  created_at: string;
}

/** DP-90: one answer of an outside HTTP API (emit.php's Http::fake()): the first whose `match` fits "METHOD URL". */
export interface HttpAnswer {
  match: string;
  status?: number;
  /** A JSON body (what Http::response() encodes), or `raw` text. */
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
  /** DP-104: a transfer that fails (Http::failedConnection(): Laravel's ConnectionException). */
  failedConnection?: boolean;
}
/** DP-90: a request the API sent to the outside API, as emit.php records it. */
export interface HttpRequestRecord {
  method: string;
  url: string;
  authorization?: string;
  /** DP-104: a Vault token and namespace, in their own headers. */
  "x-vault-token"?: string;
  "x-vault-namespace"?: string;
  body?: unknown;
}

export type StorageResource = "application" | "postgresql" | "serviceApplication";

export const CASES = JSON.parse(readFileSync(resolve(API_FIXTURES, "cases.json"), "utf8")) as { fixture: Fixture; cases: Case[] };
export const GOLDENS = JSON.parse(readFileSync(resolve(API_FIXTURES, "goldens.json"), "utf8")) as { version: string; columns: Record<string, string[]>; cases: Golden[] };
/** The text of a fixture's private key, read from the committed test key it names (as emit.php reads it). */
export function fixtureKeyText(k: { file: string; json?: Array<string | number> }): string {
  const text = readFileSync(resolve(API_FIXTURES, k.file), "utf8");
  if (!k.json) return text;
  let value: unknown = JSON.parse(text);
  for (const step of k.json) value = (value as Record<string | number, unknown>)[step];
  if (typeof value !== "string") throw new Error(`no key at ${k.file}#${k.json.join("/")}`);
  return value;
}

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
  ...CASES.fixture.cloudTokens.map((t) => t.uuid),
  ...CASES.fixture.integrationTokens.map((t) => t.uuid),
  ...CASES.fixture.dnsZones.map((z) => z.uuid),
  ...CASES.fixture.gitlabApps.map((g) => g.uuid),
  ...CASES.fixture.giteaApps.map((g) => g.uuid),
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
        .replace(/-([a-z0-9]{24})\./g, (all, uuid: string) => (FIXTURE_UUIDS.has(uuid) ? all : "-<new-uuid>."))
        // …and where generateUrl() names a created application after its uuid (`http://<uuid>.<host>`, DP-87).
        .replace(/:\/\/([a-z0-9]{24})\./g, (all, uuid: string) => (FIXTURE_UUIDS.has(uuid) ? all : "://<new-uuid>."));
  }
  return value;
}

/** DP-105: a managed DNS record's ownership comment, Coolify's ("managed-by: coolify <app.id>/<uuid>") or Freeploy's. */
const OWNERSHIP_COMMENT = /^managed-by: (?:coolify|freeploy) [^/\s]+\/([a-z0-9]{24})$/;
/** DP-105: uuids a case's setup gives (its managed DNS records): they compare as they are. */
const SETUP_UUID = /^m\dparitydns[a-z0-9]+$/;

/**
 * The requests sent to an outside API, masked (DP-105): the ownership comment of a managed DNS record that the request
 * made (its uuid random) as `managed-by: <instance>/<new-uuid>`, of a record of the case's setup with its uuid. The
 * brand and the instance differ by design (Coolify's app.id, Freeploy's environment).
 */
export function maskRequests(requests: readonly HttpRequestRecord[]): HttpRequestRecord[] {
  return requests.map((r) => {
    const body = r.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) return r;
    const comment = (body as Record<string, unknown>).comment;
    const m = typeof comment === "string" ? OWNERSHIP_COMMENT.exec(comment) : null;
    if (!m) return r;
    const uuid = FIXTURE_UUIDS.has(m[1]!) || SETUP_UUID.test(m[1]!) ? m[1]! : "<new-uuid>";
    return { ...r, body: { ...(body as Record<string, unknown>), comment: `managed-by: <instance>/${uuid}` } };
  });
}

/** A JSON body, masked and written again as PHP writes it. */
export function maskedJson(text: string, context: { teamIdKey?: boolean } = {}): string {
  return phpJsonEncode(mask(fromJs(JSON.parse(text)), context));
}
