# deploy-core-worker

The deploy bounded context of Freeploy: the Coolify resource model (projects,
environments, applications, services, databases, servers, keys, sources,
storages, backups, …) ported from coollabsio/coolify@91b7e3e, one org per row.

- **Never public.** `api-edge` forwards `/v1/organizations/{org}/deploy/*` here
  after resolving the actor; Coolify's `/api/v1` arrives the same way (DP9).
- **Tenancy in the database.** Every read and write runs inside `withOrg()`
  (`@saas/db/deploy`): one transaction, as role `deploy_app`, with
  `deploy.org_id` set; forced row-level security on every `deploy` table does
  the rest (`packages/db/src/migrations/500_deploy_core`).
- **Authorization** is membership-worker's facts plus policy-worker's decision
  (`deploy.resource.read`, `deploy.resource.write`), deny-by-default.

Design: `specs/epics/freeploy-coolify-parity/design.md`.
