// The Git source goldens (DP-72): fixtures/sources/cases.json and what Coolify's own PHP
// (coollabsio/coolify@91b7e3e, fixtures/sources/emit.php) made of each case, read once for the
// sources*.test.ts files. See the README in that folder.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "fixtures", "sources");

export type Json = Record<string, unknown>;

export interface SourceFunctionCase {
  id: string;
  fn: string;
  args: Json;
}

export interface WebhookSetup {
  serverKey: string;
  servers: Array<{ name: string; functional: boolean; ip?: string }>;
  applications: Json[];
  githubApp?: Json;
  previews?: Json[];
  deployments?: Json[];
}

export interface GithubAnswer {
  match: string;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface WebhookCase {
  id: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  setup: WebhookSetup;
  github?: GithubAnswer[];
}

export interface PrUpdateCase {
  id: string;
  status: string;
  deploymentUuid: string | null;
  preview: Json;
  setup: WebhookSetup;
  github: GithubAnswer[];
}

export interface DeploymentSyncCase {
  id: string;
  deployment: Json;
  deactivate: boolean;
  setup: WebhookSetup;
  previews?: Json[];
  github: GithubAnswer[];
}

export interface GoldenRequest {
  method: string;
  url: string;
  authorization?: string;
  accept?: string;
  body?: unknown;
}

export interface GoldenWebhook {
  status: number;
  contentType: string;
  body: string;
  previews: Json[];
  deployments: Json[];
  jobs: Array<[string, number]>;
  requests: GoldenRequest[];
}

interface Cases {
  functions: SourceFunctionCase[];
  webhooks: WebhookCase[];
  prUpdates: PrUpdateCase[];
  deploymentSyncs: DeploymentSyncCase[];
}

interface Goldens {
  now: string;
  functions: Record<string, { ok: true; value: unknown } | { ok: false; error: string }>;
  webhooks: Record<string, GoldenWebhook>;
  prUpdates: Record<string, { requests: GoldenRequest[]; thrown: string | null; commentId: string | null }>;
  deploymentSyncs: Record<string, { requests: GoldenRequest[]; thrown: string | null; github_deployment_id: number | null; github_deployment_state: string | null }>;
}

export const sourceCases = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")) as Cases;
export const sourceGoldens = JSON.parse(readFileSync(join(dir, "goldens.json"), "utf8")) as Goldens;

/** The golden instant (2026-11-20 10:11:12 UTC). */
export const SOURCE_NOW = new Date(sourceGoldens.now.replace(/\.\d+Z$/, "Z"));

export const fnCases = (prefix: string): Array<readonly [string, SourceFunctionCase]> => sourceCases.functions.filter((c) => c.id.startsWith(prefix)).map((c) => [c.id, c] as const);
