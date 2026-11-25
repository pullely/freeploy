-- 660_deploy_schema_catch_up
-- The deploy schema catches up with Coolify's migrations (freeploy-coolify-parity DP-60).
-- 500_deploy_core and 520 are a fold of the Blueprint calls in
-- coollabsio/coolify@91b7e3e:database/migrations/**. The fold cannot see what a
-- migration does in a raw statement, in a loop over a list held in a variable,
-- inside an `if (Schema::hasColumn(…))`, or through `->change()` on a column
-- another file created; 590, 610 and 630 each patched one such gap. This is all
-- the rest, found by running Coolify's 531 migrations on PostgreSQL and comparing
-- the catalogs with this schema's
-- (packages/db/scripts/coolify-schema/, tests/db/src/deploy-schema-parity.ts;
-- the report is specs/epics/freeploy-coolify-parity/parity/schema-diff.md):
--   * columns Coolify has and deploy did not, with Coolify's type and default;
--   * columns whose type, nullability or default Coolify changed later;
--   * environment_variables.is_build_time, which Coolify dropped;
--   * the unique indexes — team_id as org_id, and org_id in front of the four
--     that are made of a name alone (the report argues each one's scope, and
--     why no existing row can violate it);
--   * the non-unique indexes, the storage options and one widened CHECK.
-- Not here: foreign-key constraints (design §1.1) and the activity_log table
-- (the report says why). Every statement can run again.
-- Bounded context: deploy

-- additional_destinations
CREATE UNIQUE INDEX IF NOT EXISTS additional_destinations_application_server_docker_unique ON deploy.additional_destinations ("application_id", "server_id", "standalone_docker_id");

-- application_deployment_queues
ALTER TABLE deploy.application_deployment_queues ALTER COLUMN "configuration_snapshot" TYPE TEXT USING "configuration_snapshot"::text;
ALTER TABLE deploy.application_deployment_queues ALTER COLUMN "configuration_diff" TYPE TEXT USING "configuration_diff"::text;
CREATE INDEX IF NOT EXISTS idx_deployment_queues_app_created_id ON deploy.application_deployment_queues ("application_id", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS idx_deployment_queues_app_id ON deploy.application_deployment_queues ("application_id", "id");
CREATE INDEX IF NOT EXISTS idx_deployment_queues_app_status_pr_created ON deploy.application_deployment_queues ("application_id", "status", "pull_request_id", "created_at");
CREATE INDEX IF NOT EXISTS idx_deployment_queues_status_server ON deploy.application_deployment_queues ("status", "server_id");
ALTER TABLE deploy.application_deployment_queues SET (fillfactor=90);

-- application_previews
ALTER TABLE deploy.application_previews ALTER COLUMN "max_restart_count" SET DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS application_previews_org_id_fqdn_unique ON deploy.application_previews ("org_id", "fqdn");

-- application_settings
ALTER TABLE deploy.application_settings ADD COLUMN IF NOT EXISTS "is_auto_cancel_queued_deployments_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE deploy.application_settings ADD COLUMN IF NOT EXISTS "is_auto_cancel_building_deployments_enabled" BOOLEAN NOT NULL DEFAULT false;

-- applications
ALTER TABLE deploy.applications ALTER COLUMN "manual_webhook_secret_github" TYPE TEXT;
ALTER TABLE deploy.applications ALTER COLUMN "manual_webhook_secret_gitlab" TYPE TEXT;
ALTER TABLE deploy.applications ALTER COLUMN "manual_webhook_secret_bitbucket" TYPE TEXT;
ALTER TABLE deploy.applications ALTER COLUMN "manual_webhook_secret_gitea" TYPE TEXT;
ALTER TABLE deploy.applications ADD COLUMN IF NOT EXISTS "is_maintenance_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE deploy.applications ADD COLUMN IF NOT EXISTS "maintenance_page" TEXT;
CREATE INDEX IF NOT EXISTS applications_destination_type_destination_id_index ON deploy.applications ("destination_type", "destination_id");
CREATE INDEX IF NOT EXISTS applications_source_type_source_id_index ON deploy.applications ("source_type", "source_id");
ALTER TABLE deploy.applications SET (autovacuum_vacuum_scale_factor=0.05, fillfactor=70);

-- cloud_provider_tokens
ALTER TABLE deploy.cloud_provider_tokens ALTER COLUMN "uuid" SET NOT NULL;
CREATE INDEX IF NOT EXISTS cloud_provider_tokens_org_id_provider_index ON deploy.cloud_provider_tokens ("org_id", "provider");

-- discord_notification_settings
ALTER TABLE deploy.discord_notification_settings ADD COLUMN IF NOT EXISTS "failure_count" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS discord_notification_settings_org_id_unique ON deploy.discord_notification_settings ("org_id");

-- dns_provider_zones
CREATE UNIQUE INDEX IF NOT EXISTS dns_provider_zones_integration_token_id_provider_zone_id_unique ON deploy.dns_provider_zones ("integration_token_id", "provider_zone_id");
CREATE INDEX IF NOT EXISTS dns_provider_zones_name_index ON deploy.dns_provider_zones ("name");

-- docker_cleanup_executions
CREATE INDEX IF NOT EXISTS idx_docker_cleanup_executions_server_created_at ON deploy.docker_cleanup_executions ("server_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS idx_docker_cleanup_executions_unfinished_status_created ON deploy.docker_cleanup_executions ("status", "created_at") WHERE (finished_at IS NULL);

-- email_notification_settings
ALTER TABLE deploy.email_notification_settings ADD COLUMN IF NOT EXISTS "failure_count" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS email_notification_settings_org_id_unique ON deploy.email_notification_settings ("org_id");

-- environment_variables
ALTER TABLE deploy.environment_variables ALTER COLUMN "uuid" SET NOT NULL;
ALTER TABLE deploy.environment_variables DROP COLUMN IF EXISTS "is_build_time";
CREATE INDEX IF NOT EXISTS environment_variables_resourceable_type_resourceable_id_index ON deploy.environment_variables ("resourceable_type", "resourceable_id");

-- environments
ALTER TABLE deploy.environments ALTER COLUMN "uuid" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS environments_name_project_id_unique ON deploy.environments ("name", "project_id");

-- github_runner_executions
CREATE INDEX IF NOT EXISTS github_runner_executions_github_app_id_runner_name_index ON deploy.github_runner_executions ("github_app_id", "runner_name");
CREATE INDEX IF NOT EXISTS github_runner_executions_github_app_id_status_index ON deploy.github_runner_executions ("github_app_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS github_runner_executions_github_app_id_trigger_workflow_job_id_ ON deploy.github_runner_executions ("github_app_id", "trigger_workflow_job_id");
CREATE INDEX IF NOT EXISTS github_runner_executions_github_runner_config_id_status_index ON deploy.github_runner_executions ("github_runner_config_id", "status");
CREATE INDEX IF NOT EXISTS idx_github_runner_executions_status_server_id ON deploy.github_runner_executions ("status", "server_id");

-- image_sboms
CREATE UNIQUE INDEX IF NOT EXISTS image_sboms_server_id_image_id_unique ON deploy.image_sboms ("server_id", "image_id");

-- image_scan_ignores
CREATE INDEX IF NOT EXISTS image_scan_ignores_resource_type_resource_id_index ON deploy.image_scan_ignores ("resource_type", "resource_id");
CREATE INDEX IF NOT EXISTS image_scan_ignores_org_id_resource_type_resource_id_index ON deploy.image_scan_ignores ("org_id", "resource_type", "resource_id");

-- image_scan_notification_states
CREATE UNIQUE INDEX IF NOT EXISTS image_scan_notification_states_resource_type_resource_id_unique ON deploy.image_scan_notification_states ("resource_type", "resource_id");

-- image_scan_policies
CREATE UNIQUE INDEX IF NOT EXISTS image_scan_policies_org_id_scope_type_scope_id_unique ON deploy.image_scan_policies ("org_id", "scope_type", "scope_id");

-- image_scans
CREATE UNIQUE INDEX IF NOT EXISTS image_scans_resource_type_resource_id_image_id_unique ON deploy.image_scans ("resource_type", "resource_id", "image_id");
CREATE INDEX IF NOT EXISTS image_scans_resource_type_resource_id_index ON deploy.image_scans ("resource_type", "resource_id");
CREATE INDEX IF NOT EXISTS image_scans_server_id_image_id_index ON deploy.image_scans ("server_id", "image_id");

-- integration_tokens
CREATE INDEX IF NOT EXISTS integration_tokens_org_id_provider_index ON deploy.integration_tokens ("org_id", "provider");

-- local_file_volumes
CREATE UNIQUE INDEX IF NOT EXISTS local_file_volumes_mount_path_resource_id_resource_type_unique ON deploy.local_file_volumes ("mount_path", "resource_id", "resource_type");
CREATE INDEX IF NOT EXISTS local_file_volumes_resource_type_resource_id_index ON deploy.local_file_volumes ("resource_type", "resource_id");

-- local_persistent_volumes
ALTER TABLE deploy.local_persistent_volumes ALTER COLUMN "uuid" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS local_persistent_volumes_name_resource_id_resource_type_unique ON deploy.local_persistent_volumes ("name", "resource_id", "resource_type");
CREATE INDEX IF NOT EXISTS local_persistent_volumes_resource_type_resource_id_index ON deploy.local_persistent_volumes ("resource_type", "resource_id");

-- managed_dns_record_references
CREATE INDEX IF NOT EXISTS managed_dns_record_references_resource_type_resource_id_index ON deploy.managed_dns_record_references ("resource_type", "resource_id");
CREATE UNIQUE INDEX IF NOT EXISTS managed_dns_record_references_unique ON deploy.managed_dns_record_references ("managed_dns_record_id", "resource_type", "resource_id");

-- managed_dns_records
CREATE UNIQUE INDEX IF NOT EXISTS managed_dns_records_dns_provider_zone_id_provider_record_id_uni ON deploy.managed_dns_records ("dns_provider_zone_id", "provider_record_id");
CREATE INDEX IF NOT EXISTS managed_dns_records_org_id_name_index ON deploy.managed_dns_records ("org_id", "name");

-- notification_throttles
CREATE INDEX IF NOT EXISTS notification_throttles_notifiable_type_notifiable_id_index ON deploy.notification_throttles ("notifiable_type", "notifiable_id");
CREATE UNIQUE INDEX IF NOT EXISTS notification_throttles_org_id_notifiable_type_notifiable_id_not ON deploy.notification_throttles ("org_id", "notifiable_type", "notifiable_id", "notification");

-- pushover_notification_settings
ALTER TABLE deploy.pushover_notification_settings ADD COLUMN IF NOT EXISTS "failure_count" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS pushover_notification_settings_org_id_unique ON deploy.pushover_notification_settings ("org_id");

-- resource_links
CREATE INDEX IF NOT EXISTS resource_links_source_type_source_id_index ON deploy.resource_links ("source_type", "source_id");
CREATE INDEX IF NOT EXISTS resource_links_target_type_target_id_index ON deploy.resource_links ("target_type", "target_id");
CREATE UNIQUE INDEX IF NOT EXISTS resource_links_unique_direction ON deploy.resource_links ("environment_id", "source_type", "source_id", "target_type", "target_id");

-- scheduled_database_backup_executions
ALTER TABLE deploy.scheduled_database_backup_executions ADD COLUMN IF NOT EXISTS "worker_host" VARCHAR(255);
CREATE INDEX IF NOT EXISTS scheduled_db_backup_executions_backup_id_created_at_index ON deploy.scheduled_database_backup_executions ("scheduled_database_backup_id", "created_at");

-- scheduled_database_backup_s3_storage
CREATE UNIQUE INDEX IF NOT EXISTS db_backup_s3_storage_unique ON deploy.scheduled_database_backup_s3_storage ("scheduled_database_backup_id", "s3_storage_id");

-- scheduled_database_backups
ALTER TABLE deploy.scheduled_database_backups ALTER COLUMN "database_backup_retention_amount_locally" SET NOT NULL;
ALTER TABLE deploy.scheduled_database_backups ALTER COLUMN "database_backup_retention_days_locally" SET NOT NULL;
ALTER TABLE deploy.scheduled_database_backups ALTER COLUMN "database_backup_retention_max_storage_locally" SET NOT NULL;
ALTER TABLE deploy.scheduled_database_backups ALTER COLUMN "database_backup_retention_amount_s3" SET NOT NULL;
ALTER TABLE deploy.scheduled_database_backups ALTER COLUMN "database_backup_retention_days_s3" SET NOT NULL;
ALTER TABLE deploy.scheduled_database_backups ALTER COLUMN "database_backup_retention_max_storage_s3" SET NOT NULL;
CREATE INDEX IF NOT EXISTS scheduled_database_backups_database_type_database_id_index ON deploy.scheduled_database_backups ("database_type", "database_id");

-- scheduled_job_deliveries
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_job_deliveries_org_id_schedule_key_scheduled_for_uniq ON deploy.scheduled_job_deliveries ("org_id", "schedule_key", "scheduled_for");
CREATE INDEX IF NOT EXISTS scheduled_job_deliveries_status_created_at_index ON deploy.scheduled_job_deliveries ("status", "created_at");

-- scheduled_task_executions
ALTER TABLE deploy.scheduled_task_executions ADD COLUMN IF NOT EXISTS "worker_host" VARCHAR(255);
CREATE INDEX IF NOT EXISTS scheduled_task_executions_task_id_created_at_index ON deploy.scheduled_task_executions ("scheduled_task_id", "created_at");
ALTER TABLE deploy.scheduled_task_executions DROP CONSTRAINT IF EXISTS scheduled_task_executions_status_check;
ALTER TABLE deploy.scheduled_task_executions ADD CONSTRAINT scheduled_task_executions_status_check CHECK ("status" IN ('success', 'failed', 'running', 'skipped'));

-- scheduled_tasks
ALTER TABLE deploy.scheduled_tasks ADD COLUMN IF NOT EXISTS "consecutive_failures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deploy.scheduled_tasks ADD COLUMN IF NOT EXISTS "failing_since" TIMESTAMP(0) WITHOUT TIME ZONE;
ALTER TABLE deploy.scheduled_tasks ADD COLUMN IF NOT EXISTS "disabled_reason" TEXT;

-- scheduled_volume_backup_executions
ALTER TABLE deploy.scheduled_volume_backup_executions ADD COLUMN IF NOT EXISTS "worker_host" VARCHAR(255);
CREATE INDEX IF NOT EXISTS scheduled_volume_executions_backup_created_index ON deploy.scheduled_volume_backup_executions ("scheduled_volume_backup_id", "created_at");
CREATE INDEX IF NOT EXISTS scheduled_volume_executions_recovery_index ON deploy.scheduled_volume_backup_executions ("stop_recovery_pending", "s3_cleanup_pending", "recovery_needs_attention");

-- scheduled_volume_backup_s3_storage
CREATE UNIQUE INDEX IF NOT EXISTS volume_backup_s3_storage_unique ON deploy.scheduled_volume_backup_s3_storage ("scheduled_volume_backup_id", "s3_storage_id");

-- scheduled_volume_backups
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_volume_backups_backupable_type_backupable_id_unique ON deploy.scheduled_volume_backups ("backupable_type", "backupable_id");

-- secret_manager_links
CREATE UNIQUE INDEX IF NOT EXISTS secret_manager_links_resourceable_type_resourceable_id_unique ON deploy.secret_manager_links ("resourceable_type", "resourceable_id");

-- servers
ALTER TABLE deploy.servers ALTER COLUMN "proxy" DROP NOT NULL;
ALTER TABLE deploy.servers ADD COLUMN IF NOT EXISTS "digitalocean_droplet_id" BIGINT;
ALTER TABLE deploy.servers ADD COLUMN IF NOT EXISTS "digitalocean_droplet_status" VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_servers_private_key_id_active ON deploy.servers ("private_key_id") WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS servers_sentinel_updated_at_index ON deploy.servers ("sentinel_updated_at");
ALTER TABLE deploy.servers SET (autovacuum_vacuum_scale_factor=0.05, fillfactor=85);

-- service_applications
ALTER TABLE deploy.service_applications ALTER COLUMN "max_restart_count" SET DEFAULT 0;
ALTER TABLE deploy.service_applications SET (autovacuum_vacuum_scale_factor=0.05, fillfactor=85);

-- service_databases
ALTER TABLE deploy.service_databases SET (autovacuum_vacuum_scale_factor=0.05, fillfactor=85);

-- services
ALTER TABLE deploy.services ADD COLUMN IF NOT EXISTS "is_maintenance_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE deploy.services ADD COLUMN IF NOT EXISTS "maintenance_page" TEXT;
CREATE INDEX IF NOT EXISTS services_destination_type_destination_id_index ON deploy.services ("destination_type", "destination_id");
ALTER TABLE deploy.services SET (fillfactor=85);

-- shared_environment_variables
CREATE UNIQUE INDEX IF NOT EXISTS shared_environment_variables_key_environment_id_org_id_unique ON deploy.shared_environment_variables ("key", "environment_id", "org_id");
CREATE UNIQUE INDEX IF NOT EXISTS shared_environment_variables_key_project_id_org_id_unique ON deploy.shared_environment_variables ("key", "project_id", "org_id");
CREATE UNIQUE INDEX IF NOT EXISTS shared_environment_variables_key_server_id_org_id_unique ON deploy.shared_environment_variables ("key", "server_id", "org_id");

-- slack_notification_settings
ALTER TABLE deploy.slack_notification_settings ADD COLUMN IF NOT EXISTS "failure_count" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS slack_notification_settings_org_id_unique ON deploy.slack_notification_settings ("org_id");

-- ssl_certificates (Coolify's foreign key on server_id is the one reference column the fold left without an index)
CREATE INDEX IF NOT EXISTS ssl_certificates_server_id_idx ON deploy.ssl_certificates ("server_id");

-- standalone_clickhouses
ALTER TABLE deploy.standalone_clickhouses ALTER COLUMN "image" SET DEFAULT 'clickhouse/clickhouse-server:26.8';
ALTER TABLE deploy.standalone_clickhouses ADD COLUMN IF NOT EXISTS "restart_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deploy.standalone_clickhouses ADD COLUMN IF NOT EXISTS "last_restart_at" TIMESTAMP(0) WITHOUT TIME ZONE;
ALTER TABLE deploy.standalone_clickhouses ADD COLUMN IF NOT EXISTS "last_restart_type" VARCHAR(10);
ALTER TABLE deploy.standalone_clickhouses ADD COLUMN IF NOT EXISTS "health_check_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE deploy.standalone_clickhouses ADD COLUMN IF NOT EXISTS "health_check_interval" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE deploy.standalone_clickhouses ADD COLUMN IF NOT EXISTS "health_check_timeout" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_clickhouses ADD COLUMN IF NOT EXISTS "health_check_retries" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_clickhouses ADD COLUMN IF NOT EXISTS "health_check_start_period" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_clickhouses ADD COLUMN IF NOT EXISTS "redact_all_env_values_in_logs" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS standalone_clickhouses_destination_type_destination_id_index ON deploy.standalone_clickhouses ("destination_type", "destination_id");
ALTER TABLE deploy.standalone_clickhouses SET (fillfactor=85);

-- standalone_dockers
CREATE UNIQUE INDEX IF NOT EXISTS standalone_dockers_server_id_network_unique ON deploy.standalone_dockers ("server_id", "network");

-- standalone_dragonflies
ALTER TABLE deploy.standalone_dragonflies ADD COLUMN IF NOT EXISTS "restart_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deploy.standalone_dragonflies ADD COLUMN IF NOT EXISTS "last_restart_at" TIMESTAMP(0) WITHOUT TIME ZONE;
ALTER TABLE deploy.standalone_dragonflies ADD COLUMN IF NOT EXISTS "last_restart_type" VARCHAR(10);
ALTER TABLE deploy.standalone_dragonflies ADD COLUMN IF NOT EXISTS "health_check_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE deploy.standalone_dragonflies ADD COLUMN IF NOT EXISTS "health_check_interval" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE deploy.standalone_dragonflies ADD COLUMN IF NOT EXISTS "health_check_timeout" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_dragonflies ADD COLUMN IF NOT EXISTS "health_check_retries" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_dragonflies ADD COLUMN IF NOT EXISTS "health_check_start_period" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_dragonflies ADD COLUMN IF NOT EXISTS "redact_all_env_values_in_logs" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS standalone_dragonflies_destination_type_destination_id_index ON deploy.standalone_dragonflies ("destination_type", "destination_id");
ALTER TABLE deploy.standalone_dragonflies SET (fillfactor=85);

-- standalone_keydbs
ALTER TABLE deploy.standalone_keydbs ADD COLUMN IF NOT EXISTS "restart_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deploy.standalone_keydbs ADD COLUMN IF NOT EXISTS "last_restart_at" TIMESTAMP(0) WITHOUT TIME ZONE;
ALTER TABLE deploy.standalone_keydbs ADD COLUMN IF NOT EXISTS "last_restart_type" VARCHAR(10);
ALTER TABLE deploy.standalone_keydbs ADD COLUMN IF NOT EXISTS "health_check_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE deploy.standalone_keydbs ADD COLUMN IF NOT EXISTS "health_check_interval" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE deploy.standalone_keydbs ADD COLUMN IF NOT EXISTS "health_check_timeout" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_keydbs ADD COLUMN IF NOT EXISTS "health_check_retries" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_keydbs ADD COLUMN IF NOT EXISTS "health_check_start_period" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_keydbs ADD COLUMN IF NOT EXISTS "redact_all_env_values_in_logs" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS standalone_keydbs_destination_type_destination_id_index ON deploy.standalone_keydbs ("destination_type", "destination_id");
ALTER TABLE deploy.standalone_keydbs SET (fillfactor=85);

-- standalone_mariadbs
ALTER TABLE deploy.standalone_mariadbs ALTER COLUMN "image" SET DEFAULT 'mariadb:12.3';
ALTER TABLE deploy.standalone_mariadbs ADD COLUMN IF NOT EXISTS "restart_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deploy.standalone_mariadbs ADD COLUMN IF NOT EXISTS "last_restart_at" TIMESTAMP(0) WITHOUT TIME ZONE;
ALTER TABLE deploy.standalone_mariadbs ADD COLUMN IF NOT EXISTS "last_restart_type" VARCHAR(10);
ALTER TABLE deploy.standalone_mariadbs ADD COLUMN IF NOT EXISTS "health_check_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE deploy.standalone_mariadbs ADD COLUMN IF NOT EXISTS "health_check_interval" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE deploy.standalone_mariadbs ADD COLUMN IF NOT EXISTS "health_check_timeout" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_mariadbs ADD COLUMN IF NOT EXISTS "health_check_retries" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_mariadbs ADD COLUMN IF NOT EXISTS "health_check_start_period" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_mariadbs ADD COLUMN IF NOT EXISTS "redact_all_env_values_in_logs" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS standalone_mariadbs_destination_type_destination_id_index ON deploy.standalone_mariadbs ("destination_type", "destination_id");
ALTER TABLE deploy.standalone_mariadbs SET (fillfactor=85);

-- standalone_mongodbs
ALTER TABLE deploy.standalone_mongodbs ALTER COLUMN "image" SET DEFAULT 'mongo:9';
ALTER TABLE deploy.standalone_mongodbs ADD COLUMN IF NOT EXISTS "restart_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deploy.standalone_mongodbs ADD COLUMN IF NOT EXISTS "last_restart_at" TIMESTAMP(0) WITHOUT TIME ZONE;
ALTER TABLE deploy.standalone_mongodbs ADD COLUMN IF NOT EXISTS "last_restart_type" VARCHAR(10);
ALTER TABLE deploy.standalone_mongodbs ADD COLUMN IF NOT EXISTS "health_check_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE deploy.standalone_mongodbs ADD COLUMN IF NOT EXISTS "health_check_interval" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE deploy.standalone_mongodbs ADD COLUMN IF NOT EXISTS "health_check_timeout" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_mongodbs ADD COLUMN IF NOT EXISTS "health_check_retries" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_mongodbs ADD COLUMN IF NOT EXISTS "health_check_start_period" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_mongodbs ADD COLUMN IF NOT EXISTS "redact_all_env_values_in_logs" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS standalone_mongodbs_destination_type_destination_id_index ON deploy.standalone_mongodbs ("destination_type", "destination_id");
ALTER TABLE deploy.standalone_mongodbs SET (fillfactor=85);

-- standalone_mysqls
ALTER TABLE deploy.standalone_mysqls ALTER COLUMN "image" SET DEFAULT 'mysql:9.7';
ALTER TABLE deploy.standalone_mysqls ADD COLUMN IF NOT EXISTS "restart_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deploy.standalone_mysqls ADD COLUMN IF NOT EXISTS "last_restart_at" TIMESTAMP(0) WITHOUT TIME ZONE;
ALTER TABLE deploy.standalone_mysqls ADD COLUMN IF NOT EXISTS "last_restart_type" VARCHAR(10);
ALTER TABLE deploy.standalone_mysqls ADD COLUMN IF NOT EXISTS "health_check_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE deploy.standalone_mysqls ADD COLUMN IF NOT EXISTS "health_check_interval" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE deploy.standalone_mysqls ADD COLUMN IF NOT EXISTS "health_check_timeout" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_mysqls ADD COLUMN IF NOT EXISTS "health_check_retries" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_mysqls ADD COLUMN IF NOT EXISTS "health_check_start_period" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_mysqls ADD COLUMN IF NOT EXISTS "redact_all_env_values_in_logs" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS standalone_mysqls_destination_type_destination_id_index ON deploy.standalone_mysqls ("destination_type", "destination_id");
ALTER TABLE deploy.standalone_mysqls SET (fillfactor=85);

-- standalone_postgresqls
ALTER TABLE deploy.standalone_postgresqls ALTER COLUMN "image" SET DEFAULT 'postgres:18-alpine';
ALTER TABLE deploy.standalone_postgresqls ADD COLUMN IF NOT EXISTS "restart_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deploy.standalone_postgresqls ADD COLUMN IF NOT EXISTS "last_restart_at" TIMESTAMP(0) WITHOUT TIME ZONE;
ALTER TABLE deploy.standalone_postgresqls ADD COLUMN IF NOT EXISTS "last_restart_type" VARCHAR(10);
ALTER TABLE deploy.standalone_postgresqls ADD COLUMN IF NOT EXISTS "health_check_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE deploy.standalone_postgresqls ADD COLUMN IF NOT EXISTS "health_check_interval" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE deploy.standalone_postgresqls ADD COLUMN IF NOT EXISTS "health_check_timeout" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_postgresqls ADD COLUMN IF NOT EXISTS "health_check_retries" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_postgresqls ADD COLUMN IF NOT EXISTS "health_check_start_period" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_postgresqls ADD COLUMN IF NOT EXISTS "redact_all_env_values_in_logs" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS standalone_postgresqls_destination_type_destination_id_index ON deploy.standalone_postgresqls ("destination_type", "destination_id");
ALTER TABLE deploy.standalone_postgresqls SET (autovacuum_vacuum_scale_factor=0.05, fillfactor=85);

-- standalone_redis
ALTER TABLE deploy.standalone_redis ADD COLUMN IF NOT EXISTS "restart_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deploy.standalone_redis ADD COLUMN IF NOT EXISTS "last_restart_at" TIMESTAMP(0) WITHOUT TIME ZONE;
ALTER TABLE deploy.standalone_redis ADD COLUMN IF NOT EXISTS "last_restart_type" VARCHAR(10);
ALTER TABLE deploy.standalone_redis ADD COLUMN IF NOT EXISTS "health_check_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE deploy.standalone_redis ADD COLUMN IF NOT EXISTS "health_check_interval" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE deploy.standalone_redis ADD COLUMN IF NOT EXISTS "health_check_timeout" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_redis ADD COLUMN IF NOT EXISTS "health_check_retries" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_redis ADD COLUMN IF NOT EXISTS "health_check_start_period" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE deploy.standalone_redis ADD COLUMN IF NOT EXISTS "redact_all_env_values_in_logs" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS standalone_redis_destination_type_destination_id_index ON deploy.standalone_redis ("destination_type", "destination_id");
ALTER TABLE deploy.standalone_redis SET (fillfactor=85);

-- standalone_sqlites
ALTER TABLE deploy.standalone_sqlites ADD COLUMN IF NOT EXISTS "redact_all_env_values_in_logs" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS standalone_sqlites_destination_type_destination_id_index ON deploy.standalone_sqlites ("destination_type", "destination_id");

-- stars
CREATE INDEX IF NOT EXISTS stars_starrable_type_starrable_id_index ON deploy.stars ("starrable_type", "starrable_id");
CREATE UNIQUE INDEX IF NOT EXISTS stars_user_id_starrable_type_starrable_id_unique ON deploy.stars ("user_id", "starrable_type", "starrable_id");

-- swarm_dockers
CREATE UNIQUE INDEX IF NOT EXISTS swarm_dockers_server_id_network_unique ON deploy.swarm_dockers ("server_id", "network");

-- taggables
CREATE UNIQUE INDEX IF NOT EXISTS taggable_unique ON deploy.taggables ("tag_id", "taggable_id", "taggable_type");

-- telegram_notification_settings
ALTER TABLE deploy.telegram_notification_settings ADD COLUMN IF NOT EXISTS "failure_count" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS telegram_notification_settings_org_id_unique ON deploy.telegram_notification_settings ("org_id");

-- webhook_notification_settings
ALTER TABLE deploy.webhook_notification_settings ADD COLUMN IF NOT EXISTS "failure_count" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS webhook_notification_settings_org_id_unique ON deploy.webhook_notification_settings ("org_id");
