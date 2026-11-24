-- 550_identity_two_factor
-- Two-factor authentication (freeploy-coolify-parity DP3), as Laravel Fortify
-- keeps it on Coolify's users table: a TOTP secret and eight recovery codes,
-- both encrypted (here AES-256-GCM under the identity worker's
-- IDENTITY_ENCRYPTION_KEY, bound to the user), and the time the user
-- confirmed setup with a code. Until confirmed, 2FA is not enforced.
-- Sessions record when the password was last confirmed (Fortify's
-- password.confirm middleware, 3 hours).
-- Bounded context: identity

CREATE TABLE IF NOT EXISTS identity.two_factor (
  user_id         UUID        PRIMARY KEY REFERENCES identity.users(id),
  secret          TEXT        NOT NULL,
  recovery_codes  TEXT        NOT NULL,
  confirmed_at    TIMESTAMPTZ,
  -- The last accepted code's 30-second step: a code is never accepted twice (Fortify verifyKeyNewer).
  last_used_step  BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE identity.two_factor IS 'TOTP secret and recovery codes per user (encrypted); confirmed_at set once the user validated a code.';

ALTER TABLE identity.sessions ADD COLUMN IF NOT EXISTS password_confirmed_at TIMESTAMPTZ;
