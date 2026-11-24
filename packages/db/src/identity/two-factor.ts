// Two-factor state (550_identity_two_factor) and the session's password
// confirmation time. Values arrive already encrypted by the identity worker.
import type { SqlExecutor } from "../hyperdrive/executor.js";

export interface TwoFactorRow {
  secret: string;
  recoveryCodes: string;
  confirmedAt: Date | null;
}

export function createTwoFactorStore(db: SqlExecutor) {
  return {
    async get(userId: string): Promise<TwoFactorRow | null> {
      const r = await db.execute<{ secret: string; recovery_codes: string; confirmed_at: Date | null }>(
        "SELECT secret, recovery_codes, confirmed_at FROM identity.two_factor WHERE user_id = $1",
        [userId],
      );
      const row = r.rows[0];
      return row ? { secret: row.secret, recoveryCodes: row.recovery_codes, confirmedAt: row.confirmed_at } : null;
    },
    /** EnableTwoFactorAuthentication: a new secret and codes, unconfirmed. */
    async enable(userId: string, secret: string, recoveryCodes: string): Promise<void> {
      await db.execute(
        "INSERT INTO identity.two_factor (user_id, secret, recovery_codes, confirmed_at) VALUES ($1, $2, $3, NULL) ON CONFLICT (user_id) DO UPDATE SET secret = EXCLUDED.secret, recovery_codes = EXCLUDED.recovery_codes, confirmed_at = NULL, updated_at = now()",
        [userId, secret, recoveryCodes],
      );
    },
    /** Accept a code's step only if it is newer than the last one used (atomic). */
    async useStep(userId: string, step: number): Promise<boolean> {
      const r = await db.execute<{ user_id: string }>(
        "UPDATE identity.two_factor SET last_used_step = $2, updated_at = now() WHERE user_id = $1 AND (last_used_step IS NULL OR last_used_step < $2) RETURNING user_id",
        [userId, step],
      );
      return r.rows.length === 1;
    },
    async confirm(userId: string): Promise<void> {
      await db.execute("UPDATE identity.two_factor SET confirmed_at = now(), updated_at = now() WHERE user_id = $1", [userId]);
    },
    async setRecoveryCodes(userId: string, recoveryCodes: string): Promise<void> {
      await db.execute("UPDATE identity.two_factor SET recovery_codes = $2, updated_at = now() WHERE user_id = $1", [userId, recoveryCodes]);
    },
    async disable(userId: string): Promise<void> {
      await db.execute("DELETE FROM identity.two_factor WHERE user_id = $1", [userId]);
    },
    /** Fortify's password.confirm: when this session last confirmed the password. */
    async passwordConfirmedAt(sessionId: string): Promise<Date | null> {
      const r = await db.execute<{ at: Date | null }>("SELECT password_confirmed_at AS at FROM identity.sessions WHERE id = $1", [sessionId]);
      return r.rows[0]?.at ?? null;
    },
    async confirmPassword(sessionId: string): Promise<void> {
      await db.execute("UPDATE identity.sessions SET password_confirmed_at = now() WHERE id = $1", [sessionId]);
    },
  };
}
