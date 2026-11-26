// API tokens (freeploy-coolify-parity DP9): Coolify's Sanctum personal access
// tokens, stored as identity API keys with abilities and a token number
// (migration 720). One user's tokens in one org, as Coolify's
// auth()->user()->tokens()->where('team_id', currentTeam()->id) reads them.
import type { SqlExecutor } from "../hyperdrive/executor.js";

export interface ApiTokenRow {
  /** identity.api_keys.id */
  id: string;
  /** Sanctum's id: the number before "|" in the bearer token. */
  tokenNumber: number;
  orgId: string;
  /** The user who created it (Sanctum's tokenable). */
  userId: string;
  name: string;
  abilities: string[];
  keyHash: string;
  status: string;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface NewApiToken {
  id: string;
  servicePrincipalId: string;
  orgId: string;
  userId: string;
  name: string;
  abilities: string[];
  keyPrefix: string;
  keyHash: string;
  expiresAt: Date | null;
  createdAt: Date;
}

const COLUMNS = "id, token_number, org_id, created_by, label, abilities, key_hash, status, expires_at, last_used_at, revoked_at, created_at";

const toDate = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));

/** text[] comes back as an array from postgres.js and pg, and as "{a,b}" text from a driver without the type. */
function toAbilities(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    const inner = v.replace(/^\{|\}$/g, "");
    return inner === "" ? [] : inner.split(",").map((s) => s.replace(/^"|"$/g, ""));
  }
  return [];
}

function mapRow(r: Record<string, unknown>): ApiTokenRow {
  return {
    id: String(r.id),
    tokenNumber: Number(r.token_number),
    orgId: String(r.org_id),
    userId: String(r.created_by),
    name: String(r.label ?? ""),
    abilities: toAbilities(r.abilities),
    keyHash: String(r.key_hash),
    status: String(r.status),
    expiresAt: toDate(r.expires_at),
    lastUsedAt: toDate(r.last_used_at),
    revokedAt: toDate(r.revoked_at),
    createdAt: toDate(r.created_at)!,
  };
}

export function createApiTokenStore(db: SqlExecutor) {
  return {
    /** createToken(): the service principal row the key hangs on, then the key with the next token number. */
    async create(token: NewApiToken): Promise<ApiTokenRow> {
      await db.execute(
        `INSERT INTO identity.service_principals (id, org_id, project_id, display_name, created_by, created_at, updated_at)
         VALUES ($1, $2, NULL, $3, $4, $5, $5)`,
        [token.servicePrincipalId, token.orgId, `API token: ${token.name}`, token.userId, token.createdAt.toISOString()],
      );
      const r = await db.execute<Record<string, unknown>>(
        `INSERT INTO identity.api_keys (id, service_principal_id, org_id, key_prefix, key_hash, label, expires_at, created_by, created_at, updated_at, abilities, token_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10::text[], nextval('identity.api_token_numbers'))
         RETURNING ${COLUMNS}`,
        [token.id, token.servicePrincipalId, token.orgId, token.keyPrefix, token.keyHash, token.name, token.expiresAt?.toISOString() ?? null, token.userId, token.createdAt.toISOString(), token.abilities],
      );
      return mapRow(r.rows[0]!);
    },

    /** The user's tokens in the org, newest first (->latest()); revoked ones are gone, as Coolify deletes them. */
    async list(orgId: string, userId: string): Promise<ApiTokenRow[]> {
      const r = await db.execute<Record<string, unknown>>(
        `SELECT ${COLUMNS} FROM identity.api_keys
         WHERE org_id = $1 AND created_by = $2 AND token_number IS NOT NULL AND status = 'active'
         ORDER BY created_at DESC, token_number DESC`,
        [orgId, userId],
      );
      return r.rows.map(mapRow);
    },

    /** PersonalAccessToken::find($id) */
    async findByNumber(tokenNumber: number): Promise<ApiTokenRow | null> {
      const r = await db.execute<Record<string, unknown>>(`SELECT ${COLUMNS} FROM identity.api_keys WHERE token_number = $1`, [tokenNumber]);
      return r.rows[0] ? mapRow(r.rows[0]) : null;
    },

    /** PersonalAccessToken::where('token', hash) — a token sent without its "<id>|". */
    async findByHash(keyHash: string): Promise<ApiTokenRow | null> {
      const r = await db.execute<Record<string, unknown>>(`SELECT ${COLUMNS} FROM identity.api_keys WHERE key_hash = $1 AND token_number IS NOT NULL`, [keyHash]);
      return r.rows[0] ? mapRow(r.rows[0]) : null;
    },

    /** revoke(): Coolify deletes the row; here it is marked revoked (security events refer to it). */
    async revoke(orgId: string, userId: string, tokenNumber: number, at: Date): Promise<ApiTokenRow | null> {
      const r = await db.execute<Record<string, unknown>>(
        `UPDATE identity.api_keys SET status = 'revoked', revoked_at = $4, revoked_by = $2, updated_at = $4
         WHERE org_id = $1 AND created_by = $2 AND token_number = $3 AND status = 'active'
         RETURNING ${COLUMNS}`,
        [orgId, userId, tokenNumber, at.toISOString()],
      );
      return r.rows[0] ? mapRow(r.rows[0]) : null;
    },

    /** Sanctum's last_used_at, written on every authenticated request. */
    async touch(id: string, at: Date): Promise<void> {
      await db.execute("UPDATE identity.api_keys SET last_used_at = $2 WHERE id = $1", [id, at.toISOString()]);
    },

    /** The users of a team's members, as /api/v1/team/members lists them: their columns that Coolify's users table has. */
    async users(userIds: string[]): Promise<ApiUserRow[]> {
      if (userIds.length === 0) return [];
      const r = await db.execute<Record<string, unknown>>(
        `SELECT u.id, u.display_name, u.email, u.email_verified_at, u.created_at, u.updated_at,
                tf.confirmed_at AS two_factor_confirmed_at, ec.new_email AS pending_email
         FROM identity.users u
         LEFT JOIN identity.two_factor tf ON tf.user_id = u.id
         LEFT JOIN identity.email_changes ec ON ec.user_id = u.id
         WHERE u.id = ANY($1::uuid[]) AND u.status = 'active'`,
        [userIds],
      );
      return r.rows.map((x) => ({
        id: String(x.id),
        name: x.display_name === null || x.display_name === undefined ? null : String(x.display_name),
        email: String(x.email),
        emailVerifiedAt: toDate(x.email_verified_at),
        twoFactorConfirmedAt: toDate(x.two_factor_confirmed_at),
        pendingEmail: x.pending_email === null || x.pending_email === undefined ? null : String(x.pending_email),
        createdAt: toDate(x.created_at)!,
        updatedAt: toDate(x.updated_at)!,
      }));
    },

    /** A user who can still sign in (Sanctum's tokenable exists). */
    async userIsActive(userId: string): Promise<boolean> {
      const r = await db.execute<{ n: number }>("SELECT count(*)::int AS n FROM identity.users WHERE id = $1 AND status = 'active'", [userId]);
      return Number(r.rows[0]?.n ?? 0) > 0;
    },
  };
}

export interface ApiUserRow {
  id: string;
  name: string | null;
  email: string;
  emailVerifiedAt: Date | null;
  twoFactorConfirmedAt: Date | null;
  pendingEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ApiTokenStore = ReturnType<typeof createApiTokenStore>;
