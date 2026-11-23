-- 530_identity_password_credentials
-- Email + password sign-in (freeploy-coolify-parity DP3): Coolify signs users in
-- with a password (Laravel Fortify); Lumen's identity had passwordless and OAuth
-- only. One credential per user, a PBKDF2-SHA256 hash, never the password.
-- Bounded context: identity

CREATE TABLE IF NOT EXISTS identity.password_credentials (
  user_id       UUID        PRIMARY KEY REFERENCES identity.users(id),
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE identity.password_credentials IS 'Password hashes (pbkdf2-sha256$<iterations>$<salt>$<hash>). Never store or log a password.';

-- Throttling looks up recent attempts by key (Coolify: 5 per minute per email|ip and per email identity).
CREATE INDEX IF NOT EXISTS security_events_password_attempts_idx
  ON identity.security_events (event_type, occurred_at DESC)
  WHERE event_type IN ('password.login.attempt', 'password.register.attempt');
