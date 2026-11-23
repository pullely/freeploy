-- 540_identity_password_resets
-- Password reset tokens (freeploy-coolify-parity DP3), as Laravel's password
-- broker keeps them: one live token per user, stored hashed, expiring after
-- 10 minutes (Coolify config/auth.php passwords.users.expire), with a 60-second
-- throttle between requests (passwords.users.throttle).
-- Bounded context: identity

CREATE TABLE IF NOT EXISTS identity.password_resets (
  user_id     UUID        PRIMARY KEY REFERENCES identity.users(id),
  token_hash  TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE identity.password_resets IS 'One live password-reset token per user (SHA-256 of the token). Replaced on each request, deleted when used.';
