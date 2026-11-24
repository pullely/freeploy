// Self-service account deletion (freeploy-coolify-parity DP3): the account is
// deactivated and anonymised rather than removed, because sessions and
// security events reference it. Credentials, passkeys, 2FA, OAuth links and
// pending requests are deleted, every session revoked, and the address freed.
import type { SqlExecutor } from "../hyperdrive/executor.js";

export function createAccountStore(db: SqlExecutor) {
  return {
    /** Projects, servers and Git sources an org still holds (Team::isEmpty()). */
    async orgResourceCount(orgId: string): Promise<number> {
      const r = await db.execute<{ n: number }>(
        `SELECT (SELECT count(*) FROM deploy.projects WHERE org_id = $1)
              + (SELECT count(*) FROM deploy.servers WHERE org_id = $1)
              + (SELECT count(*) FROM deploy.github_apps WHERE org_id = $1)
              + (SELECT count(*) FROM deploy.gitlab_apps WHERE org_id = $1) AS n`,
        [orgId],
      );
      return Number(r.rows[0]?.n ?? 0);
    },
    async deactivate(userId: string): Promise<void> {
      for (const table of ["avatars", "password_credentials", "password_resets", "two_factor", "passkeys", "email_changes", "auth_identities", "login_challenges"]) {
        await db.execute(`DELETE FROM identity.${table} WHERE user_id = $1`, [userId]);
      }
      await db.execute("UPDATE identity.sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
      const tomb = `deleted+${userId}@deleted.invalid`;
      await db.execute(
        "UPDATE identity.users SET status = 'deleted', email = $2, email_lower = $2, display_name = NULL, updated_at = now() WHERE id = $1",
        [userId, tomb],
      );
    },
  };
}

export function createAvatarStore(db: SqlExecutor) {
  return {
    async get(userId: string): Promise<{ contentType: string; data: string; updatedAt: Date } | null> {
      const r = await db.execute<{ content_type: string; data: string; updated_at: Date }>("SELECT content_type, data, updated_at FROM identity.avatars WHERE user_id = $1", [userId]);
      const x = r.rows[0];
      return x ? { contentType: x.content_type, data: x.data, updatedAt: x.updated_at } : null;
    },
    async version(userId: string): Promise<number | null> {
      const r = await db.execute<{ v: Date }>("SELECT updated_at AS v FROM identity.avatars WHERE user_id = $1", [userId]);
      return r.rows[0] ? new Date(r.rows[0].v).getTime() : null;
    },
    async put(userId: string, contentType: string, data: string): Promise<void> {
      await db.execute(
        "INSERT INTO identity.avatars (user_id, content_type, data, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (user_id) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, updated_at = now()",
        [userId, contentType, data],
      );
    },
    async remove(userId: string): Promise<void> {
      await db.execute("DELETE FROM identity.avatars WHERE user_id = $1", [userId]);
    },
  };
}
