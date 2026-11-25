# membership-worker — architecture

A `cloudflare-worker-turbo` component: TypeScript Worker built by the turbo pipeline
from `apps/membership-worker`, deployed per environment by its CI lane.

## Bindings and wiring

- **Service bindings** → `billing-worker`, `policy-worker` —
  in-process RPC to sibling Workers; no public hops between contexts.
- **Wired configuration** (resolved at deploy time from job-output
  secrets published by the infrastructure terraform; names only):
  `WIRING_CLOUDFLARE_HYPERDRIVE_PROD`, `WIRING_CLOUDFLARE_HYPERDRIVE_STAGE`.

## Boundaries

This Worker owns its bounded context: its data, its invariants, its
API surface (exposed to the fleet through the edge). Cross-context calls
go over service bindings; nothing else may reach into its storage.

## The deploy console's team pages

`src/handlers/team.ts` (Freeploy DP-69) serves Coolify's team pages over the
organization: `/v1/organizations/{org}/team` (General), `…/team/members[/{member}]`
(roles and removal by Coolify's rules), `…/team/invitations[/{invitation}]`
(invite links) and `/v1/team-invitations/{invitation}` (the invited user's
page). Coolify's member role is stored as `builder`; invitations expire after
Coolify's 3 days. The member list reads each member's display name, email and
two-factor state from `identity.users` / `identity.two_factor` (read only, in
`packages/db/src/membership/team.ts`), as the support repository reads users.

The team's Danger Zone (DP-75): `GET …/team/danger` and `DELETE …/team`, the
owner's (`organization.delete`). A team is deleted only when it is not its
owner's last or personal team (`personal-<user id>`, identity's solo mode) and
owns nothing in the deploy console. What it owns is read only, through
`withOrg()` as `deploy_app` (`packages/db/src/membership/team-danger.ts`): this
worker has no binding to deploy-core-worker, and adding one would grow the
binding loop. Deleting marks the organization `deleted` and ends its members,
role assignments and pending invitations; the row stays.
