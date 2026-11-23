-- 510_deploy_org_keys
-- Per-org data keys for the deploy context's encrypted columns (DP2).
-- Bounded context: deploy
--
-- Coolify encrypts 87 columns with Laravel's `encrypted` cast under one
-- APP_KEY. Freeploy holds many orgs' secrets (SSH private keys, provider
-- tokens, database passwords), so each org gets its own data key (DEK). The
-- DEK is stored only wrapped (AES-256-GCM) by the platform key-encryption key
-- DEPLOY_ENCRYPTION_KEY, a Worker secret that never reaches the database.
-- Rows are org-scoped by the same forced row-level security as every deploy table.

CREATE TABLE IF NOT EXISTS deploy.org_keys (
  org_id      UUID        NOT NULL,
  version     INTEGER     NOT NULL DEFAULT 1,
  wrapped_dek TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at  TIMESTAMPTZ,
  PRIMARY KEY (org_id, version)
);
COMMENT ON TABLE deploy.org_keys IS 'Per-org data keys, wrapped by the platform KEK (DEPLOY_ENCRYPTION_KEY). Never store an unwrapped key.';

ALTER TABLE deploy.org_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE deploy.org_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON deploy.org_keys;
CREATE POLICY tenant_isolation ON deploy.org_keys USING (org_id = deploy.current_org() OR deploy.is_platform_admin()) WITH CHECK (org_id = deploy.current_org() OR deploy.is_platform_admin());
GRANT SELECT, INSERT, UPDATE ON deploy.org_keys TO deploy_app;
