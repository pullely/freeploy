// The image scans of DP-113's cases (fixtures/api/cases.json `imageScans` and `serviceVariables`) seeded into Freeploy's
// database as tests/deploy-core-worker/src/api-v1-vulnerabilities.test.ts seeds them: each scan inserted, then its summary
// written by the port of ResourceScans::refreshSummaries(); a scan of the other team's server goes into the other team's
// org. Shared with DP-114's Security pages (image-scan-pages.test.ts).
import { columnCipher } from "@deploy-core-worker/handlers/cloud-tokens";
import { phpArrayJson, refreshScanSummary } from "@deploy-core-worker/image-scan/data";
import { withOrg } from "@saas/db/deploy";
import type { SqlExecutor, TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import type { Case } from "./api-v1-goldens.js";
import { ORG_UUID, TEST_KEK } from "./api-v1-database.js";

export const T1 = 1;
export const NOW = new Date("2026-01-01T00:00:00Z");

export interface ScanCase {
  uuid: string;
  server_id: number;
  image_id: string;
  repo_digest: string | null;
  owner: string;
  resource_id: number;
  image_ref: string;
  deployment_queue_id: number | null;
  status: string;
  error_code: string | null;
  error_context: unknown;
  findings: unknown;
  candidates: unknown;
  base_image_ref: string | null;
  builds_image: boolean;
  is_baseline: boolean;
  grype_db_built_at: string | null;
  scanned_at: string | null;
  eol_distro: unknown;
  truncated: boolean;
  stored?: boolean;
  summary?: unknown;
}
export interface Dp113Case extends Case {
  imageScans?: ScanCase[];
  serviceVariables?: Array<{ service: number; key: string; value: string }>;
}

export const OWNER_MORPH: Record<string, string> = {
  application: "App\\Models\\Application",
  serviceApplication: "App\\Models\\ServiceApplication",
  serviceDatabase: "App\\Models\\ServiceDatabase",
  postgresql: "App\\Models\\StandalonePostgresql",
  redis: "App\\Models\\StandaloneRedis",
  mongodb: "App\\Models\\StandaloneMongodb",
  mysql: "App\\Models\\StandaloneMysql",
  mariadb: "App\\Models\\StandaloneMariadb",
  keydb: "App\\Models\\StandaloneKeydb",
  dragonfly: "App\\Models\\StandaloneDragonfly",
  clickhouse: "App\\Models\\StandaloneClickhouse",
  sqlite: "App\\Models\\StandaloneSqlite",
};

export const query = (db: TransactionalSqlExecutor, sql: string, org = ORG_UUID[T1]!) =>
  withOrg(db, org, async (tx) => {
    await tx.execute("SET LOCAL search_path TO deploy");
    return (await tx.execute(sql)).rows;
  });

export const decrypt = (tx: SqlExecutor, org: string) => {
  const cipher = columnCipher(tx, org, TEST_KEK, "environment_variables.value");
  return (stored: string) => cipher.decrypt(stored);
};

/** emit.php's image scans: inserted one after the other, each summary written as the scanner writes it. */
export async function seedScans(db: TransactionalSqlExecutor, scans: readonly ScanCase[]): Promise<void> {
  for (const s of scans) {
    const org = ORG_UUID[s.server_id === 2 ? 2 : T1]!;
    await withOrg(db, org, async (tx) => {
      const summary = s.summary ?? { ignored: 0, eol_distro: s.eol_distro, truncated: s.truncated };
      const r = await tx.execute<{ id: number }>(
        `INSERT INTO deploy.image_scans (uuid, server_id, image_id, repo_digest, resource_type, resource_id, image_ref, deployment_queue_id, status, error_code, error_context, summary, findings, candidates,
           base_image_ref, builds_image, is_baseline, grype_db_built_at, scanned_at, created_at, updated_at, org_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19, '2026-01-01 00:00:00', '2026-01-01 00:00:00', $20) RETURNING id::float8 AS id`,
        [s.uuid, s.server_id, s.image_id, s.repo_digest, OWNER_MORPH[s.owner], s.resource_id, s.image_ref, s.deployment_queue_id, s.status, s.error_code, phpArrayJson(s.error_context), phpArrayJson(summary), phpArrayJson(s.findings), phpArrayJson(s.candidates), s.base_image_ref, s.builds_image, s.is_baseline, s.grype_db_built_at, s.scanned_at, org],
      );
      if (s.stored !== false) await refreshScanSummary(tx, Number(r.rows[0]!.id), NOW, decrypt(tx, org));
    });
  }
}

export async function seedVariables(db: TransactionalSqlExecutor, variables: NonNullable<Dp113Case["serviceVariables"]>): Promise<void> {
  for (const [i, v] of variables.entries()) {
    await withOrg(db, ORG_UUID[T1]!, async (tx) => {
      const value = await columnCipher(tx, ORG_UUID[T1]!, TEST_KEK, "environment_variables.value").encrypt(v.value);
      await tx.execute(
        `INSERT INTO deploy.environment_variables (uuid, key, value, is_preview, resourceable_type, resourceable_id, org_id, created_at, updated_at) VALUES ($1, $2, $3, false, 'App\\Models\\Service', $4, $5, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
        [`w9parityscanvariable00${i}0`.slice(0, 24), v.key, value, v.service, ORG_UUID[T1]!],
      );
    });
  }
}

