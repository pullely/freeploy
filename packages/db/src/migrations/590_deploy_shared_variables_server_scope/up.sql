-- 590_deploy_shared_variables_server_scope
-- Server-wide shared variables (freeploy-coolify-parity DP5). Coolify widens the
-- type check of shared_environment_variables in a raw statement
-- (coollabsio/coolify@91b7e3e:database/migrations/2025_12_24_095507_add_server_to_shared_environment_variables_table.php),
-- which the schema fold does not read: 500_deploy_core has the server_id column
-- but still refuses type 'server'. This is that statement.
-- Bounded context: deploy

ALTER TABLE deploy.shared_environment_variables DROP CONSTRAINT IF EXISTS shared_environment_variables_type_check;
ALTER TABLE deploy.shared_environment_variables ADD CONSTRAINT shared_environment_variables_type_check CHECK ("type" IN ('team', 'project', 'environment', 'server'));
