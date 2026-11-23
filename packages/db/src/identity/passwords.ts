// Password credentials (530_identity_password_credentials), reset tokens
// (540_identity_password_resets) and the attempt counts that throttle
// sign-in and registration.
import type { SqlExecutor } from "../hyperdrive/executor.js";

export type ResetLookup = "valid" | "invalid" | "expired";

export function createPasswordStore(db: SqlExecutor) {
  return {
    async get(userId: string): Promise<string | null> {
      const r = await db.execute<{ password_hash: string }>("SELECT password_hash FROM identity.password_credentials WHERE user_id = $1", [userId]);
      return r.rows[0]?.password_hash ?? null;
    },
    async set(userId: string, hash: string): Promise<void> {
      await db.execute(
        "INSERT INTO identity.password_credentials (user_id, password_hash) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()",
        [userId, hash],
      );
    },
    /** Attempts recorded for any of `keys` within the last `seconds`, and when the oldest of them expires. */
    async recentAttempts(eventType: string, keys: string[], seconds: number): Promise<{ count: number; oldest: Date | null }[]> {
      const out: { count: number; oldest: Date | null }[] = [];
      for (const key of keys) {
        const r = await db.execute<{ n: number; oldest: Date | null }>(
          "SELECT count(*)::int AS n, min(occurred_at) AS oldest FROM identity.security_events WHERE event_type = $1 AND occurred_at > now() - make_interval(secs => $2) AND metadata->'throttle_keys' ? $3",
          [eventType, seconds, key],
        );
        out.push({ count: r.rows[0]?.n ?? 0, oldest: r.rows[0]?.oldest ?? null });
      }
      return out;
    },

    // ── password reset tokens (Laravel's DatabaseTokenRepository semantics) ──

    /** True when the user's last token was created within `seconds` (the broker's throttle). */
    async resetRecentlyCreated(userId: string, seconds: number): Promise<boolean> {
      const r = await db.execute<{ n: number }>(
        "SELECT count(*)::int AS n FROM identity.password_resets WHERE user_id = $1 AND created_at > now() - make_interval(secs => $2)",
        [userId, seconds],
      );
      return (r.rows[0]?.n ?? 0) > 0;
    },
    /** Replace the user's token (one live token per user). */
    async createReset(userId: string, tokenHash: string): Promise<void> {
      await db.execute(
        "INSERT INTO identity.password_resets (user_id, token_hash, created_at) VALUES ($1, $2, now()) ON CONFLICT (user_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = now()",
        [userId, tokenHash],
      );
    },
    async checkReset(userId: string, tokenHash: string, expireSeconds: number): Promise<ResetLookup> {
      const r = await db.execute<{ token_hash: string; expired: boolean }>(
        "SELECT token_hash, created_at < now() - make_interval(secs => $2) AS expired FROM identity.password_resets WHERE user_id = $1",
        [userId, expireSeconds],
      );
      const row = r.rows[0];
      if (!row || row.token_hash !== tokenHash) return "invalid";
      return row.expired ? "expired" : "valid";
    },
    async deleteReset(userId: string): Promise<void> {
      await db.execute("DELETE FROM identity.password_resets WHERE user_id = $1", [userId]);
    },
    /** ResetUserPassword: $user->deleteAllSessions(). */
    async revokeAllSessions(userId: string): Promise<void> {
      await db.execute("UPDATE identity.sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    },
  };
}
