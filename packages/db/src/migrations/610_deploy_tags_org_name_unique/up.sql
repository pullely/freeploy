-- 610_deploy_tags_org_name_unique
-- Tag names are unique per org, not across orgs (freeploy-coolify-parity DP5).
-- Coolify dropped the global unique index on tags.name
-- (coollabsio/coolify@91b7e3e:database/migrations/2024_07_05_120217_remove_unique_from_tag_names.php)
-- and later made the name unique per team
-- (…/2026_07_07_113248_add_team_name_unique_index_to_tags_table.php, tags_team_id_name_unique).
-- The schema fold kept the first index: 500_deploy_core still has tags_name_unique
-- on ("name") alone, so one org's tag name would be refused to every other org.
-- This is those two migrations, with the org in the team's place.
-- Bounded context: deploy

DROP INDEX IF EXISTS deploy.tags_name_unique;
CREATE UNIQUE INDEX IF NOT EXISTS tags_org_id_name_unique ON deploy.tags (org_id, "name");
