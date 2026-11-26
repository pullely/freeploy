-- 720_identity_api_tokens
-- API tokens (freeploy-coolify-parity DP9): Coolify's Sanctum personal access
-- tokens, kept as identity API keys. A token belongs to the user who created
-- it (created_by, Sanctum's tokenable) and to one org (org_id, Coolify's
-- personal_access_tokens.team_id), and carries Coolify's abilities and
-- optional expiry. Two things the API keys did not have:
--   abilities     Coolify's abilities (read, read:sensitive, write, deploy,
--                 delete, root, ...). NULL for every key that is not a token.
--   token_number  Sanctum's id: clients send "<token_number>|<plain text>",
--                 and the number finds the row before the hash is compared.
-- The plain text is never stored; key_hash is SHA-256 of what follows "|",
-- as Sanctum hashes it.
-- Bounded context: identity

CREATE SEQUENCE IF NOT EXISTS identity.api_token_numbers;

ALTER TABLE identity.api_keys ADD COLUMN IF NOT EXISTS abilities TEXT[];
ALTER TABLE identity.api_keys ADD COLUMN IF NOT EXISTS token_number BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS api_keys_token_number_idx
  ON identity.api_keys (token_number)
  WHERE token_number IS NOT NULL;

-- A user's tokens in one org, newest first (the API Tokens page).
CREATE INDEX IF NOT EXISTS api_keys_org_creator_tokens_idx
  ON identity.api_keys (org_id, created_by, created_at DESC)
  WHERE token_number IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_token_shape_check') THEN
    ALTER TABLE identity.api_keys ADD CONSTRAINT api_keys_token_shape_check
      CHECK ((abilities IS NULL) = (token_number IS NULL));
  END IF;
END $$;

COMMENT ON COLUMN identity.api_keys.abilities IS 'Coolify API token abilities; NULL for keys that are not API tokens.';
COMMENT ON COLUMN identity.api_keys.token_number IS 'Sanctum token id ("<token_number>|<plain text>"); NULL for keys that are not API tokens.';
