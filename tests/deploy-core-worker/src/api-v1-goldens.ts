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
}
export interface Answer {
  status: number;
  headers: Record<string, string>;
  body: { json?: string; text?: string };
}
export interface Golden extends Answer {
  name: string;
  steps?: Answer[];
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
}

export const CASES = JSON.parse(readFileSync(resolve(API_FIXTURES, "cases.json"), "utf8")) as { fixture: Fixture; cases: Case[] };
export const GOLDENS = JSON.parse(readFileSync(resolve(API_FIXTURES, "goldens.json"), "utf8")) as { version: string; cases: Golden[] };
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
]);

const LARAVEL_DATE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const SQL_DATE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;
const PUBLIC_ID = /^[a-z0-9]{24}$/;
/** Keys whose values are the team's id (Coolify's integer, Freeploy's org_…), or a secret neither side can reproduce. */
const TEAM_KEYS = new Set(["team_id", "current_team_id"]);
const SECRET_KEYS = new Set(["sentinel_token"]);

/**
 * The masking: dates (both formats) as <date> or <sql-date>; a uuid the fixture did not give (made by the
 * request) as <new-uuid>; the team id as <team>; a member's id as <user:email>; the id of a server's settings
 * row (an auto-increment neither side fixes) as <settings-id>; the Sentinel token as <secret>.
 */
export function mask(value: PhpValue, context: { teamIdKey?: boolean } = {}, parentKey = ""): PhpValue {
  if (Array.isArray(value)) return value.map((v) => mask(v, context, parentKey));
  if (isObj(value)) {
    const email = value.entries.find(([k]) => k === "email")?.[1];
    return obj(
      value.entries.map(([k, v]): [string, PhpValue] => {
        if (TEAM_KEYS.has(k) && v !== null) return [k, "<team>"];
        // Coolify generates a Sentinel token when it creates the settings row; Freeploy's server creation stores none (freeploy-rows.json; a departure), so it is masked even when null.
        if (SECRET_KEYS.has(k)) return [k, "<secret>"];
        if (k === "id" && context.teamIdKey && parentKey === "") return [k, "<team>"];
        if (k === "id" && typeof email === "string") return [k, `<user:${email}>`];
        if (k === "id" && parentKey === "settings") return [k, "<settings-id>"];
        return [k, mask(v, context, k)];
      }),
    );
  }
  if (typeof value === "string") {
    if (LARAVEL_DATE.test(value)) return "<date>";
    if (SQL_DATE.test(value)) return "<sql-date>";
    if (PUBLIC_ID.test(value) && !FIXTURE_UUIDS.has(value)) return "<new-uuid>";
  }
  return value;
}

/** A JSON body, masked and written again as PHP writes it. */
export function maskedJson(text: string, context: { teamIdKey?: boolean } = {}): string {
  return phpJsonEncode(mask(fromJs(JSON.parse(text)), context));
}
