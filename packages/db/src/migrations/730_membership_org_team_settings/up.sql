-- 730_membership_org_team_settings: a team's build server fallback and image scanning of new servers.
--
-- Context: membership
-- Epic: freeploy-coolify-parity (DP10, DP-107). Coolify's PATCH /api/v1/team
--       (app/Http/Controllers/Api/TeamController.php::update_current_team) writes a
--       team's is_build_server_fallback_enabled and scan_images_on_new_servers
--       (app/Models/Team.php: booleans, true and false for a new team); GET /api/v1/team
--       answers them. Freeploy's teams are its organizations, which had neither.
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS with Coolify's defaults, so every
-- existing organization reads as a new Coolify team does.

ALTER TABLE membership.organizations
  ADD COLUMN IF NOT EXISTS is_build_server_fallback_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE membership.organizations
  ADD COLUMN IF NOT EXISTS scan_images_on_new_servers BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN membership.organizations.is_build_server_fallback_enabled IS
  'Coolify teams.is_build_server_fallback_enabled: deployments may fall back to the deployment server when no usable build server is available.';
COMMENT ON COLUMN membership.organizations.scan_images_on_new_servers IS
  'Coolify teams.scan_images_on_new_servers: image scanning is turned on for servers added to the team from now on.';
