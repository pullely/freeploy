// The deploy bounded context's data access (DP2). Every query runs inside
// withOrg(): one transaction, as role deploy_app (which cannot bypass RLS),
// with deploy.org_id set for that transaction only. Row-level security on
// every deploy table (500_deploy_core) then confines the transaction to that
// org: a query that forgets an org filter still sees only its org's rows.
import type { SqlExecutor, SqlRow, TransactionalSqlExecutor } from "../hyperdrive/executor.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenancyError extends Error {}

/** Run fn in a transaction confined to one org by row-level security. */
export async function withOrg<T>(db: TransactionalSqlExecutor, orgId: string, fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(orgId)) throw new TenancyError("withOrg needs an org uuid");
  return db.transaction(async (tx) => {
    await tx.execute("SET LOCAL ROLE deploy_app");
    await tx.execute("SELECT set_config('deploy.org_id', $1, true)", [orgId]);
    return fn(tx);
  });
}

/**
 * Run fn as the platform operator (DP12): sees every org. Only reachable from
 * routes that policy-worker has authorised as platform-admin.
 */
export async function asPlatformAdmin<T>(db: TransactionalSqlExecutor, fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute("SET LOCAL ROLE deploy_app");
    await tx.execute("SELECT set_config('deploy.platform_admin', 'on', true)");
    return fn(tx);
  });
}

export interface DeployProjectRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  description: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

/** Coolify's ProjectController@projects: the team's projects (here, the org's). */
export async function listProjects(tx: SqlExecutor): Promise<DeployProjectRow[]> {
  const r = await tx.execute<DeployProjectRow>(
    'SELECT id, uuid, name, description, created_at, updated_at FROM deploy.projects ORDER BY id',
  );
  return r.rows;
}
