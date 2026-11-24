-- 560_identity_passkeys
-- Passkeys (freeploy-coolify-parity DP3), as Coolify's Fortify passkeys keep
-- them: a named WebAuthn credential per device, its public key and signature
-- counter, and when it was last used. A passkey sign-in skips 2FA.
-- Bounded context: identity

CREATE TABLE IF NOT EXISTS identity.passkeys (
  id             UUID        PRIMARY KEY,
  user_id        UUID        NOT NULL REFERENCES identity.users(id),
  name           TEXT        NOT NULL,
  credential_id  TEXT        NOT NULL UNIQUE,
  public_key     TEXT        NOT NULL,
  counter        BIGINT      NOT NULL DEFAULT 0,
  transports     TEXT[]      NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS passkeys_user_idx ON identity.passkeys (user_id, created_at DESC);

COMMENT ON TABLE identity.passkeys IS 'WebAuthn credentials (base64url id and COSE public key) per user, with the signature counter.';
