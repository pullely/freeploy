# events-worker — architecture

A `cloudflare-worker-turbo` component: TypeScript Worker built by the turbo pipeline
from `apps/events-worker`, deployed per environment by its CI lane.

## Bindings and wiring

- **Service bindings** → `membership-worker`, `policy-worker` —
  in-process RPC to sibling Workers; no public hops between contexts.
- **Wired configuration** (resolved at deploy time from job-output
  secrets published by the infrastructure terraform; names only):
  `WIRING_CLOUDFLARE_HYPERDRIVE_PROD`, `WIRING_CLOUDFLARE_HYPERDRIVE_STAGE`.

## Boundaries

This Worker owns its bounded context: its data, its invariants, its
API surface (exposed to the fleet through the edge). Cross-context calls
go over service bindings; nothing else may reach into its storage.

## The deploy console's team audit log

`GET /v1/organizations/{org}/audit/team-log` (Freeploy DP-75,
`src/handlers/team-audit-log.ts`) is Coolify's Team → Audit log over the
organization's audit entries of the last 90 days: Coolify's columns, filters
(search, action, source), sorts and pages. Freeploy's team events that Coolify
records too are shown as Coolify shows them (`src/team-audit-log.ts`); the
others keep their own name and description. `audit.read` (owner and admin).
The actor's and a member's name and email are read from `identity.users`,
read only (`packages/db/src/events/team-audit-log.ts`).
