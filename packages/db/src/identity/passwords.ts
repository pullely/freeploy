// Password credentials (200_identity_password_credentials) and the attempt
// counts that throttle sign-in and registration.
import type { SqlExecutor } from "../hyperdrive/executor.js";

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
  };
}
