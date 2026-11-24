// Passkeys (560_identity_passkeys).
import type { SqlExecutor } from "../hyperdrive/executor.js";

export interface PasskeyRow {
  id: string;
  userId: string;
  name: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
}

type Raw = { id: string; user_id: string; name: string; credential_id: string; public_key: string; counter: string | number; transports: string | null; created_at: Date; last_used_at: Date | null };
const row = (r: Raw): PasskeyRow => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  credentialId: r.credential_id,
  publicKey: r.public_key,
  counter: Number(r.counter),
  transports: r.transports ? r.transports.split(",").filter(Boolean) : [],
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});
// The executor runs postgres.js with fetch_types off, so a JS array cannot bind
// to text[]: transports travel as a comma-joined string, both ways.
const COLS = "id, user_id, name, credential_id, public_key, counter, array_to_string(transports, ',') AS transports, created_at, last_used_at";

export function createPasskeyStore(db: SqlExecutor) {
  return {
    /** Newest first (Coolify: passkeys()->latest()). */
    async list(userId: string): Promise<PasskeyRow[]> {
      const r = await db.execute<Raw>(`SELECT ${COLS} FROM identity.passkeys WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
      return r.rows.map(row);
    },
    async byCredentialId(credentialId: string): Promise<PasskeyRow | null> {
      const r = await db.execute<Raw>(`SELECT ${COLS} FROM identity.passkeys WHERE credential_id = $1`, [credentialId]);
      return r.rows[0] ? row(r.rows[0]) : null;
    },
    async add(p: { id: string; userId: string; name: string; credentialId: string; publicKey: string; counter: number; transports: string[] }): Promise<void> {
      await db.execute(
        "INSERT INTO identity.passkeys (id, user_id, name, credential_id, public_key, counter, transports) VALUES ($1, $2, $3, $4, $5, $6, string_to_array($7, ','))",
        [p.id, p.userId, p.name, p.credentialId, p.publicKey, p.counter, p.transports.join(",")],
      );
    },
    async used(id: string, counter: number): Promise<void> {
      await db.execute("UPDATE identity.passkeys SET counter = $2, last_used_at = now() WHERE id = $1", [id, counter]);
    },
    async rename(userId: string, id: string, name: string): Promise<boolean> {
      const r = await db.execute<{ id: string }>("UPDATE identity.passkeys SET name = $3 WHERE id = $2 AND user_id = $1 RETURNING id", [userId, id, name]);
      return r.rows.length === 1;
    },
    async remove(userId: string, id: string): Promise<boolean> {
      const r = await db.execute<{ id: string }>("DELETE FROM identity.passkeys WHERE id = $2 AND user_id = $1 RETURNING id", [userId, id]);
      return r.rows.length === 1;
    },
  };
}
