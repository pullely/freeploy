// The deployment goldens (DP-56): fixtures/deployments/cases.json and what Coolify's own PHP
// (coollabsio/coolify@91b7e3e, fixtures/deployments/emit.php) made of each case, read once for the
// deployments*.test.ts files. See the README in that folder.
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Jest runs from tests/deploy-core-worker (its rootDir).
const dir = join(process.cwd(), "fixtures", "deployments");

export type Json = Record<string, unknown>;

export interface Response {
  match: string;
  output?: string;
  errorOutput?: string;
  exitCode?: number;
  sequence?: Array<Omit<Response, "match" | "sequence">>;
}

export interface RunCase {
  id: string;
  about: string;
  team: Json;
  server: Json;
  serverSettings: Json;
  destination: Json;
  project: Json;
  environment: Json;
  application: Json;
  settings: Json;
  variables: Json[];
  sharedVariables: Json[];
  persistentStorages: Json[];
  fileStorages: Json[];
  deployment: Json & { deployment_uuid: string };
  responses: Response[];
  earlierDeployments?: Json[];
  cancelOn?: string;
}

export interface FunctionCase {
  id: string;
  fn: string;
  args: unknown[];
}

export interface GoldenProcess {
  script: string;
  input?: string;
  output?: string;
  errorOutput?: string;
  exitCode?: number;
}

export interface GoldenLog {
  output: string;
  command?: string;
  type?: string;
  hidden?: boolean;
  batch?: number;
}

export interface GoldenRun {
  result: { status: string; message: string; deployment_uuid?: string } | null;
  thrown: string | null;
  processes: GoldenProcess[];
  deployment: {
    status: string;
    logs: GoldenLog[] | null;
    finished_at: string | null;
    deploy_started_at: string | null;
    build_server_id: number | null;
    commit: string;
    deployment_url: string;
    application_name: string;
    server_name: string;
    force_rebuild: boolean;
    restart_only: boolean;
    rollback: boolean;
  } | null;
  application: { status: string; custom_labels: string | null; restart_count: number; last_restart_at: string | null; last_restart_type: string | null; restart_limit_reached: boolean };
  otherDeployments: Array<{ deployment_uuid: string; status: string }>;
  sleeps: number[];
  notifications: string[];
  jobs: string[];
}

export type GoldenFunction = { ok: true; value: unknown } | { ok: false; error: string };

interface CasesFile {
  defaults: Omit<RunCase, "id" | "about">;
  runs: Array<Partial<RunCase> & { id: string; about: string }>;
  functions: FunctionCase[];
}

const casesFile = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")) as CasesFile;
const goldensFile = JSON.parse(readFileSync(join(dir, "goldens.json"), "utf8")) as { now: string; strings: string[]; runs: Record<string, unknown>; functions: Record<string, unknown> };

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

const isMap = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

/** emit.php's merged(): maps merge key by key, anything else (a list too) replaces. */
function merged(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = isMap(value) && isMap(base[key]) ? merged(base[key], value) : value;
  return out;
}

/** The instant every golden run stands still at. */
export const GOLDEN_NOW = goldensFile.now;

export const runCases: RunCase[] = casesFile.runs.map((run) => {
  const full = merged(casesFile.defaults as unknown as Json, run as unknown as Json) as unknown as RunCase;
  // A case's responses are asked first; the defaults answer what it leaves.
  full.responses = [...(run.responses ?? []), ...casesFile.defaults.responses];
  return full;
});

export const functionCases: FunctionCase[] = casesFile.functions;

export const goldenRun = (id: string): GoldenRun => resolved(goldensFile.runs[id]) as GoldenRun;
export const goldenFunction = (id: string): GoldenFunction => resolved(goldensFile.functions[id]) as GoldenFunction;

/** The value Coolify returned for a function case; throws when PHP threw. */
export function goldenValue(id: string): unknown {
  const golden = goldenFunction(id);
  if (!golden.ok) throw new Error(`${id}: PHP threw ${golden.error}`);
  return golden.value;
}
