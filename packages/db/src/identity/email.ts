// Email verification and pending email changes (570_identity_email_verification).
import type { SqlExecutor } from "../hyperdrive/executor.js";

export interface PendingEmailChange {
  newEmail: string;
  codeHash: string;
  expiresAt: Date;
  createdAt: Date;
}

export function createEmailStore(db: SqlExecutor) {
  return {
    async verifiedAt(userId: string): Promise<Date | null> {
      const r = await db.execute<{ at: Date | null }>("SELECT email_verified_at AS at FROM identity.users WHERE id = $1", [userId]);
      return r.rows[0]?.at ?? null;
    },
    async markVerified(userId: string): Promise<void> {
      await db.execute("UPDATE identity.users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1", [userId]);
    },
    async pending(userId: string): Promise<PendingEmailChange | null> {
      const r = await db.execute<{ new_email: string; code_hash: string; expires_at: Date; created_at: Date }>(
        "SELECT new_email, code_hash, expires_at, created_at FROM identity.email_changes WHERE user_id = $1",
        [userId],
      );
      const x = r.rows[0];
      return x ? { newEmail: x.new_email, codeHash: x.code_hash, expiresAt: x.expires_at, createdAt: x.created_at } : null;
    },
    async request(userId: string, newEmail: string, codeHash: string, expiresAt: Date): Promise<void> {
      await db.execute(
        "INSERT INTO identity.email_changes (user_id, new_email, code_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, now()) ON CONFLICT (user_id) DO UPDATE SET new_email = EXCLUDED.new_email, code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, created_at = now()",
        [userId, newEmail, codeHash, expiresAt],
      );
    },
    async clear(userId: string): Promise<void> {
      await db.execute("DELETE FROM identity.email_changes WHERE user_id = $1", [userId]);
    },
    /** The change itself: the new address, verified (it received the code), and the request removed. */
    async apply(userId: string, newEmail: string): Promise<void> {
      await db.execute(
        "UPDATE identity.users SET email = $2, email_lower = lower($2), email_verified_at = now(), updated_at = now() WHERE id = $1",
        [userId, newEmail],
      );
      await db.execute("DELETE FROM identity.email_changes WHERE user_id = $1", [userId]);
    },
  };
}
