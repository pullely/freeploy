-- 740_deploy_image_scan_instance_policy
-- The instance-wide image scan policy (freeploy-coolify-parity DP11, DP-116).
-- Coolify keeps its instance level of the scan rules in image_scan_policies as
-- the row with no scope (scope_type and scope_id NULL), seeded by
-- coollabsio/coolify@91b7e3e:database/migrations/2026_10_29_100000_create_image_scanning_tables.php
-- (gate_mode 'off', on_scan_error 'deploy', count_medium false) and edited on
-- /settings/image-scanning (InstanceImageScanning, ScanSettings' instance scope);
-- ImageScanPolicyResolver::instanceRow() reads it first for every resource of
-- every team. deploy.image_scan_policies (500_deploy_core) has org_id NOT NULL
-- and the tenant policy, so a row no org owns could neither be stored nor read.
--
-- The row is stored as DP-79 and DP-101 store the platform's rows
-- (deploy.instance_settings row 0, deploy.oauth_settings): owned by the nil
-- UUID, which no organization has, so tenant_isolation shows it to no org and
-- lets only the platform operator (deploy.is_platform_admin()) write it. The
-- resolver reads it inside every org's transaction, so this adds one more
-- permissive policy, FOR SELECT only, that shows that one row — the nil UUID's
-- row with no scope — to every org. No org can insert, change or delete it
-- (no INSERT, UPDATE or DELETE policy matches it), and no other row of the
-- table becomes visible across orgs. FORCE ROW LEVEL SECURITY stays as 500 set it.
--
-- No row is inserted here: the platform operator's page creates it with
-- Coolify's seeded values on its first read (packages/db/src/deploy/
-- image-scan-settings.ts), and until then the resolver's defaults are those
-- same values. No column, index or constraint changes, so the schema report
-- (schema-diff.md) finds no new difference. Every statement can run again.
-- Bounded context: deploy

DROP POLICY IF EXISTS instance_policy_read ON deploy.image_scan_policies;
CREATE POLICY instance_policy_read ON deploy.image_scan_policies
  FOR SELECT
  USING (org_id = '00000000-0000-0000-0000-000000000000'::uuid AND scope_type IS NULL AND scope_id IS NULL);

COMMENT ON POLICY instance_policy_read ON deploy.image_scan_policies IS
  'The instance-wide scan policy (Coolify''s row with no scope), owned by the nil UUID: readable by every org, written only by the platform operator.';
