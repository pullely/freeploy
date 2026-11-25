-- 630_deploy_database_public_port_timeout
-- The timeout of a database's public TCP proxy (freeploy-coolify-parity DP7).
-- Coolify added public_port_timeout to its database tables in
-- coollabsio/coolify@91b7e3e:database/migrations/2026_02_27_000000_add_public_port_timeout_to_databases.php
-- (integer, nullable, default 3600). The schema fold does not have the column:
-- 500_deploy_core stops at public_port, so the "Proxy timeout" field of a
-- database's General page had nowhere to be stored. This is that migration,
-- for the same nine tables.
-- Bounded context: deploy

ALTER TABLE deploy.standalone_postgresqls ADD COLUMN IF NOT EXISTS "public_port_timeout" INTEGER DEFAULT 3600;
ALTER TABLE deploy.standalone_mysqls ADD COLUMN IF NOT EXISTS "public_port_timeout" INTEGER DEFAULT 3600;
ALTER TABLE deploy.standalone_mariadbs ADD COLUMN IF NOT EXISTS "public_port_timeout" INTEGER DEFAULT 3600;
ALTER TABLE deploy.standalone_redis ADD COLUMN IF NOT EXISTS "public_port_timeout" INTEGER DEFAULT 3600;
ALTER TABLE deploy.standalone_mongodbs ADD COLUMN IF NOT EXISTS "public_port_timeout" INTEGER DEFAULT 3600;
ALTER TABLE deploy.standalone_clickhouses ADD COLUMN IF NOT EXISTS "public_port_timeout" INTEGER DEFAULT 3600;
ALTER TABLE deploy.standalone_keydbs ADD COLUMN IF NOT EXISTS "public_port_timeout" INTEGER DEFAULT 3600;
ALTER TABLE deploy.standalone_dragonflies ADD COLUMN IF NOT EXISTS "public_port_timeout" INTEGER DEFAULT 3600;
ALTER TABLE deploy.service_databases ADD COLUMN IF NOT EXISTS "public_port_timeout" INTEGER DEFAULT 3600;
