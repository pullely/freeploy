// What the /api/v1 groups ported after DP-70 (applications and their variables, DP-71) share: the request as
// api-edge forwarded it, the token's reach, policy-worker's answer, one org's transaction, and Coolify's
// rows read whole (apiRows), with the models' casts and hidden columns applied by models.ts.
import type { Env } from "../env.js";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { apiRows, type ApiRow, type ApiTable } from "@saas/db/deploy";
import { coolifyJson, obj, type CoolifyAnswer, type CoolifyTeamFacts, type PhpValue } from "@saas/contracts/coolify-api";
import { columnCipher } from "../handlers/cloud-tokens.js";
import type { S3StorageNetwork } from "../s3-storages/service.js";

/** Runs fn in one transaction confined to the org (withOrg); replaceable for tests. */
export type SqlRunner = <T>(env: Env, orgId: string, fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;

export interface ApiV1Context {
  env: Env;
  /** The org's uuid (row-level security) and its public id (Coolify's team_id in the answers). */
  orgId: string;
  orgPublicId: string;
  request: Request;
  method: string;
  url: URL;
  /** canReadResourceSecretsFromApi() / canReadServerSecretsFromApi(): root or read:sensitive, for an owner or admin (api-edge). */
  canReadSensitive: boolean;
  /** The token's abilities (Sanctum's tokenCan(): root grants every one), DP-73. */
  abilities: readonly string[];
  /** $this->authorize(): policy-worker's deploy.resource.write (true) or deploy.resource.read. */
  allows(write: boolean): Promise<boolean>;
  sql: SqlRunner;
  /** The org as membership-worker shows it to the token's user: Coolify's team where an answer nests it (DP-78). */
  org(): Promise<CoolifyTeamFacts | null>;
  /** What an S3 storage's connection test reaches out with: the resolver and the HTTP exchange (DP-81); replaceable for tests. */
  s3: S3StorageNetwork;
}

export type Rows = (table: ApiTable, where?: string, params?: unknown[], order?: "id" | "name") => Promise<ApiRow[]>;

/** apiRows() over a transaction. */
export const rowsOf =
  (tx: SqlExecutor): Rows =>
  (table, where, params, order) =>
    apiRows(tx, table, where ?? null, params ?? [], order ?? "id");

/** Decrypts a column with an `encrypted` cast ("<table>.<column>" binds the value). */
export function decryptColumn(tx: SqlExecutor, c: ApiV1Context, table: string, column: string, stored: unknown): Promise<string | null> {
  if (stored === null || stored === undefined || stored === "") return Promise.resolve(null);
  return columnCipher(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, `${table}.${column}`).decrypt(String(stored));
}

export const message = (text: string, status: number, extra: Record<string, PhpValue> = {}): CoolifyAnswer => coolifyJson(obj({ message: text, ...extra }), status);

/** A Freeploy answer in Coolify's envelope for what needs the SSH executor (DP-70's convention). */
export const unavailable = (text: string): CoolifyAnswer => message(text, 501);

/** Laravel's $request->boolean() of a query parameter (filter_var FILTER_VALIDATE_BOOLEAN), the default when absent. */
export function queryBoolean(url: URL, name: string, fallback: boolean): boolean {
  const v = url.searchParams.get(name);
  if (v === null) return fallback;
  return ["1", "true", "on", "yes"].includes(v.trim().toLowerCase());
}

/** $request->user()->tokenCan('deploy') || tokenCan('root') (RequiresDeployAbility::hasDeployAbility). */
export const hasDeployAbility = (c: ApiV1Context): boolean => c.abilities.includes("deploy") || c.abilities.includes("root");
