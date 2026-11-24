-- 570_identity_email_verification
-- Email verification and email change (freeploy-coolify-parity DP3), as
-- Coolify Cloud does them: a user verifies their address from a signed link
-- (unverified users only reach /verify), and changes it with a 6-digit code
-- sent to the new address, valid 10 minutes.
-- Every account that exists before this migration was created through a
-- verified channel (magic link, OAuth) or by the parity harness, so it is
-- marked verified at its creation time; new password registrations start
-- unverified.
-- Bounded context: identity

ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
UPDATE identity.users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

CREATE TABLE IF NOT EXISTS identity.email_changes (
  user_id     UUID        PRIMARY KEY REFERENCES identity.users(id),
  new_email   TEXT        NOT NULL,
  code_hash   TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE identity.email_changes IS 'One pending email change per user: the new address and a SHA-256 of its 6-digit code.';
