-- 710_membership_org_description: a team's description.
--
-- Context: membership
-- Epic: freeploy-coolify-parity (DP10, DP-69). Coolify's team General page
--       (app/Livewire/Team/Index.php) edits a team's name and description;
--       Freeploy's teams are its organizations, which had a name and no
--       description. Nullable, as Coolify's teams.description is; its length
--       (ValidationPatterns::descriptionRules(), max:255) is checked by the API.
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS; existing organizations
-- have no description, which is what Coolify shows for a team without one.

ALTER TABLE membership.organizations
  ADD COLUMN IF NOT EXISTS description TEXT;

COMMENT ON COLUMN membership.organizations.description IS
  'The team description of the deploy console''s team General page (Coolify teams.description); NULL when none.';
