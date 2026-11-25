// Derived from coollabsio/coolify@91b7e3e:app/Actions/Team/DeleteTeam.php and app/Models/Team.php
// (deletionBlockers, isEmpty, deleteOwnedRecords) (Apache-2.0), modified.
//
// The team's Danger Zone (freeploy-coolify-parity DP10, DP-75): what still holds a team, and its deletion.
//
// What the team owns in the deploy console is deploy-core's. It is read here, read only, through withOrg()
// (one transaction as deploy_app with the org set, so row-level security confines it), the way the identity
// account deletion reads it: membership-worker has no binding to deploy-core-worker, and one would grow the
// service-binding loop (AGENTS.md). Nothing here writes outside membership.
//
// Coolify's blockers are the team's projects, servers (not soft-deleted ones: Server uses SoftDeletes) and
// Git sources (not the instance-wide ones). Coolify
// deletes the rest with the team (Team::deleteOwnedRecords: private keys, S3 storages, tags, shared
// variables, cloud tokens…); membership-worker cannot delete deploy rows, so in Freeploy they hold the team
// too, under Freeploy's own words.
import type { SqlExecutor, TransactionalSqlExecutor } from "../hyperdrive/executor.js";
import { withOrg } from "../deploy/index.js";

/** Team::deletionBlockers(), in Coolify's order; a type with none is left out. */
export interface TeamDeletionBlockers {
  projects?: number;
  servers?: number;
  sources?: number;
}

/** What Coolify deletes with the team and Freeploy cannot yet; a type with none is left out. */
export interface TeamOwnedRecords {
  privateKeys?: number;
  storages?: number;
  cloudTokens?: number;
  cloudInitScripts?: number;
  tags?: number;
  sharedVariables?: number;
}

export interface TeamDeployResources {
  blockers: TeamDeletionBlockers;
  owned: TeamOwnedRecords;
  /** danger-zone.blade.php's Resources table: the team's projects, then its servers. */
  projects: Array<{ uuid: string; name: string }>;
  servers: Array<{ uuid: string; name: string }>;
}

const COUNTS = `SELECT
  (SELECT count(*) FROM deploy.projects WHERE org_id = $1) AS projects,
  (SELECT count(*) FROM deploy.servers WHERE org_id = $1 AND deleted_at IS NULL) AS servers,
  (SELECT count(*) FROM deploy.github_apps WHERE org_id = $1 AND is_system_wide = false)
    + (SELECT count(*) FROM deploy.gitlab_apps WHERE org_id = $1 AND is_system_wide = false)
    + (SELECT count(*) FROM deploy.gitea_apps WHERE org_id = $1 AND is_system_wide = false) AS sources,
  (SELECT count(*) FROM deploy.private_keys WHERE org_id = $1) AS private_keys,
  (SELECT count(*) FROM deploy.s3_storages WHERE org_id = $1) AS storages,
  (SELECT count(*) FROM deploy.cloud_provider_tokens WHERE org_id = $1) AS cloud_tokens,
  (SELECT count(*) FROM deploy.cloud_init_scripts WHERE org_id = $1) AS cloud_init_scripts,
  (SELECT count(*) FROM deploy.tags WHERE org_id = $1) AS tags,
  (SELECT count(*) FROM deploy.shared_environment_variables WHERE org_id = $1) AS shared_variables`;

function nonZero<K extends string>(row: Record<string, unknown>, keys: Array<[K, string]>): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const [key, column] of keys) {
    const n = Number(row[column] ?? 0);
    if (n > 0) out[key] = n;
  }
  return out;
}

/** The deploy records of the team, counted and (projects, servers) named, read only. */
export async function teamDeployResources(db: TransactionalSqlExecutor, orgId: string): Promise<TeamDeployResources> {
  return withOrg(db, orgId, async (tx: SqlExecutor) => {
    const counts = (await tx.execute<Record<string, unknown>>(COUNTS, [orgId])).rows[0] ?? {};
    const projects = await tx.execute<Record<string, unknown>>("SELECT uuid, name FROM deploy.projects WHERE org_id = $1 ORDER BY id", [orgId]);
    const servers = await tx.execute<Record<string, unknown>>("SELECT uuid, name FROM deploy.servers WHERE org_id = $1 AND deleted_at IS NULL ORDER BY id", [orgId]);
    return {
      blockers: nonZero(counts, [
        ["projects", "projects"],
        ["servers", "servers"],
        ["sources", "sources"],
      ]),
      owned: nonZero(counts, [
        ["privateKeys", "private_keys"],
        ["storages", "storages"],
        ["cloudTokens", "cloud_tokens"],
        ["cloudInitScripts", "cloud_init_scripts"],
        ["tags", "tags"],
        ["sharedVariables", "shared_variables"],
      ]),
      projects: projects.rows.map((r) => ({ uuid: String(r.uuid), name: String(r.name) })),
      servers: servers.rows.map((r) => ({ uuid: String(r.uuid), name: String(r.name) })),
    };
  });
}

/** `auth()->user()->teams()->count()`: the active organizations the subject is an active member of. */
export async function countSubjectTeams(ex: SqlExecutor, subjectId: string): Promise<number> {
  const r = await ex.execute<Record<string, unknown>>(
    `SELECT COUNT(*) AS n FROM membership.organization_members m
     JOIN membership.organizations o ON o.id = m.org_id
     WHERE m.subject_id = $1 AND m.status = 'active' AND o.status = 'active'`,
    [subjectId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * DeleteTeam::handle() inside the caller's transaction: the organization row is locked and marked
 * `deleted` (Lumen keeps the row: events, billing and audit entries name it), every membership ends, every
 * role assignment in it (users and service principals: their API keys stop working, as Coolify's
 * RevokeUserTeamTokens does) is revoked, and its pending invitations are revoked. False when the
 * organization was not active.
 */
export async function deleteTeam(ex: SqlExecutor, orgId: string, now: Date): Promise<boolean> {
  const at = now.toISOString();
  const locked = await ex.execute(`SELECT id FROM membership.organizations WHERE id = $1 AND status = 'active' FOR UPDATE`, [orgId]);
  if (locked.rows.length === 0) return false;
  await ex.execute(`UPDATE membership.organizations SET status = 'deleted', updated_at = $2 WHERE id = $1`, [orgId, at]);
  await ex.execute(`UPDATE membership.organization_members SET status = 'removed', updated_at = $2 WHERE org_id = $1 AND status = 'active'`, [orgId, at]);
  await ex.execute(`UPDATE membership.role_assignments SET revoked_at = $2 WHERE org_id = $1 AND revoked_at IS NULL`, [orgId, at]);
  await ex.execute(`UPDATE membership.organization_invitations SET status = 'revoked', revoked_at = $2 WHERE org_id = $1 AND status = 'pending'`, [orgId, at]);
  return true;
}
